import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readState, removeSessionState, updateSessionState } from './state.mjs';
import { sidecarControlOn, sidecarControlOff } from './sidecar-client.mjs';
import { resolveSessionKey, verifyBinding } from './commands.mjs';

function extractSessionInfo(record) {
  if (!record || typeof record !== 'object') return null;
  const header = record.header && typeof record.header === 'object' ? record.header : null;
  const id = header?.id || record.id || record.sessionId;
  if (!id || typeof id !== 'string') return null;
  const origin = header?.origin ?? record.origin;
  const parentId = header?.parentSession ?? header?.parentSessionId ?? record.parentSession ?? record.parentSessionId;
  return { id, origin, parentId };
}

function dshHomeBase() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
}

/**
 * 实时读取归档集合（用户裁定 #4 的配套优化）。
 * 归档集合是内存里的一段数组（workspaceRegistry.archivedSessionIds），读取成本近乎为零，
 * 因此**每次都能实时读**——归档/取消归档立刻生效，不需要等 10min 快照刷新。
 * 昂贵的部分（扫会话表 / 解压日志）才放进快照缓存。
 */
export function getArchivedIds(ctx) {
  const archived = new Set();
  // 2026-10-23 审计 T24：**空集合是合法结果**，不能与"读取失败"混为一谈。
  // 旧实现用 archived.size === 0 判断需要降级，于是用户"全部取消归档"后
  // 仍会读到磁盘旧快照，把已取消归档的会话继续当作归档（停不掉/开不了）。
  let authoritative = false;
  try {
    const list = ctx?.workspaceRegistry?.archivedSessionIds;
    if (Array.isArray(list) || list instanceof Set) {
      for (const id of list) archived.add(id);
      authoritative = true;                 // 接口存在且返回了集合（含空集）
    } else if (list && typeof list[Symbol.iterator] === 'function') {
      for (const id of list) archived.add(id);
      authoritative = true;
    }
  } catch {}

  // 仅在**接口不存在/读取抛错**时才用磁盘降级
  if (!authoritative) {
    try {
      const wsJsonPath = path.join(dshHomeBase(), 'storages', 'workspace.json');
      if (fs.existsSync(wsJsonPath)) {
        const wsData = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
        const list = wsData?.global?.archivedSessionIds;
        if (Array.isArray(list)) for (const id of list) archived.add(id);
      }
    } catch {}
  }
  return archived;
}

/**
 * 全部可见会话 id（**不含**归档过滤）—— 这是昂贵的扫描，由 reconciler 缓存。
 * 调用方再叠加 {@link getArchivedIds} 得到实时活跃集合。
 */
export async function getAllSessionIds(ctx) {
  const allIds = new Set();
  let gotFromCtx = false;
  let lastError = null;

  try {
    if (ctx?.sessionQuery && typeof ctx.sessionQuery.listSessions === 'function') {
      const records = await ctx.sessionQuery.listSessions();
      if (Array.isArray(records)) {
        const parsed = [];
        for (const r of records) {
          const info = extractSessionInfo(r);
          if (info) parsed.push(info);
        }

        // 根活跃会话（非 subagent）
        const rootActiveIds = new Set();
        for (const info of parsed) {
          if (info.origin !== 'subagent') rootActiveIds.add(info.id);
        }
        // 判定「父是否活跃」必须叠加归档：父会话已归档 -> 其子代理也是孤儿。
        // 注意 archived 只用于这里的父活跃判定，不用于过滤返回值本身
        // （返回的是全量列表，归档过滤由 getActiveSessionIds 负责）。
        const archivedNow = getArchivedIds(ctx);
        for (const id of [...rootActiveIds]) {
          if (archivedNow.has(id)) rootActiveIds.delete(id);
        }

        // 孤儿 subagent 会话过滤：origin === 'subagent' 且 parent 不在活跃集合中予以排除
        for (const info of parsed) {
          if (info.origin === 'subagent') {
            if (!info.parentId || !rootActiveIds.has(info.parentId)) continue;
          }
          allIds.add(info.id);
        }
        gotFromCtx = true;
      }
    }
  } catch (e) {
    lastError = e;
  }

  if (gotFromCtx) return allIds;

  // 备用方案：扫描 ~/.dsh/sessions/ 目录
  const sessionsDir = path.join(dshHomeBase(), 'sessions');
  try {
    if (fs.existsSync(sessionsDir)) {
      const wsDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const ws of wsDirs) {
        if (!ws.isDirectory()) continue;
        const sDirs = fs.readdirSync(path.join(sessionsDir, ws.name), { withFileTypes: true });
        for (const s of sDirs) {
          if (s.isDirectory()) allIds.add(s.name);
        }
      }
    }
  } catch (e) {
    lastError = lastError || e;
  }

  return allIds;
}

/**
 * 权威会话列表快照（2026-10-22 审计修复，codex DEBUG-PLAN §4）。
 *
 * 旧行为：listSessions 抛错 -> 磁盘兜底 -> 磁盘也不可用时返回**空 Set** ->
 * reconciler 认定"全部会话已不存在" -> 把所有 enabled 会话 OFF 并从 state 删除。
 * 宿主一次短暂抖动就能清空用户配置，这是审计复现过的真实缺陷。
 *
 * 新契约：返回 { status, ids, error }：
 *   · status='ok'          —— 来自权威来源（宿主 API），**只有此时**才允许清理
 *   · status='disk'        —— 宿主不可用，退回磁盘快照（可作补挂参考，但**不得删除**）
 *   · status='unavailable' —— 两个来源都失败，本轮必须完全跳过清理
 */
export async function getAuthoritativeSessionIds(ctx) {
  try {
    if (ctx?.sessionQuery && typeof ctx.sessionQuery.listSessions === 'function') {
      const records = await ctx.sessionQuery.listSessions();
      if (Array.isArray(records)) {
        const ids = new Set();
        const parsed = [];
        for (const r of records) {
          const info = extractSessionInfo(r);
          if (info) parsed.push(info);
        }
        const rootActiveIds = new Set();
        for (const info of parsed) {
          if (info.origin !== 'subagent') rootActiveIds.add(info.id);
        }
        const archivedNow = getArchivedIds(ctx);
        for (const id of [...rootActiveIds]) if (archivedNow.has(id)) rootActiveIds.delete(id);
        for (const info of parsed) {
          if (info.origin === 'subagent') {
            if (!info.parentId || !rootActiveIds.has(info.parentId)) continue;
          } else {
            // 2026-10-23 审计 T17：**归档的根会话必须从 eligibleIds 中排除**。
            // 旧实现只把它从 rootActiveIds 删掉（那是用来判断"父是否活跃"的集合），
            // 却仍然 ids.add(info.id) —— 于是归档的会话依旧被当作活跃，
            // 继续补挂/继续烧钱，归档等于没生效。
            if (archivedNow.has(info.id)) continue;
          }
          ids.add(info.id);
        }
        return { status: 'ok', ids, error: null };
      }
    }
  } catch (e) {
    // 宿主不可用：继续尝试磁盘，但把状态降级
  }

  const diskIds = await getAllSessionIds({});
  if (diskIds.size > 0) return { status: 'disk', ids: diskIds, error: null };
  return { status: 'unavailable', ids: new Set(), error: 'session-list-unavailable' };
}

export async function getActiveSessionIds(ctx) {
  const [all, archived] = await Promise.all([
    getAllSessionIds(ctx),
    Promise.resolve(getArchivedIds(ctx)),
  ]);
  const active = new Set();
  for (const id of all) if (!archived.has(id)) active.add(id);
  return active;
}

export async function runReconciliation({ ctx, statePath, activeSessionIds, activeStatus }) {
  const state = readState(statePath);
  let activeSet;
  let cleanupAllowed;

  if (activeSessionIds instanceof Set || Array.isArray(activeSessionIds)) {
    // 调用方显式给了集合：沿用旧契约（测试与内部调用），默认视为权威
    activeSet = activeSessionIds instanceof Set ? activeSessionIds : new Set(activeSessionIds);
    cleanupAllowed = activeStatus ? activeStatus === 'ok' : true;
  } else {
    // 生产路径：用带状态的权威快照（2026-10-22 审计修复 §4）
    const snap = await getAuthoritativeSessionIds(ctx);
    activeSet = snap.ids;
    // **只有权威成功快照才允许清理**。宿主抖动 / 磁盘也不可用时，
    // 绝不因为"看不到"就判定"已删除"。
    cleanupAllowed = snap.status === 'ok';
    if (!cleanupAllowed) {
      console.log(`[reconciler] session list status=${snap.status}; skipping removals this round`);
    }
  }

  const sessionEntries = Object.entries(state.sessions || {});
  const reconciled = {
    removed: [], reconnected: [], rekeyed: [], blocked: [],
    offCompensated: [], waiting: [], skippedCleanup: !cleanupAllowed,
  };

  for (const [sessionId, session] of sessionEntries) {
    // 若已不存在或处于 deleted/archived 状态
    if (!activeSet.has(sessionId)) {
      if (!cleanupAllowed) continue;   // 快照不可信：保留配置，下轮再判
      // 2026-10-23 审计 T17：关停必须用**派生 key**（存储的 key 可能是旧的），
      // 且要覆盖 offPending（关闭意图未完成的会话）与 on 的全部情形。
      const stopKey = resolveSessionKey(sessionId);
      const needStop = session.on === true || session.offPending === true;
      if (needStop) {
        try { await sidecarControlOff(stopKey); } catch {}
        if (session.key && session.key !== stopKey) {
          try { await sidecarControlOff(session.key); } catch {}
        }
      }
      removeSessionState(statePath, sessionId);
      reconciled.removed.push(sessionId);
      continue;
    }

    // key 由 sessionId 确定性派生（2026-10-21 v2 契约），下面多个分支都要用
    const derivedKey = resolveSessionKey(sessionId);

    // ── OFF 补偿（2026-10-23 审计 T19）──────────────────────────────────
    // 用户要求关闭但 sidecar 未确认（offPending）时，每轮对账都要重试 OFF。
    // 旧实现只在开启方向做补偿，关闭失败就被永久遗忘 —— 表现为
    // "回执说已关闭、实际仍在烧钱"，且 UI 只当作状态分叉展示。
    if (session.offPending === true) {
      let stopped = false;
      try {
        const r = await sidecarControlOff(derivedKey);
        stopped = r != null && r.status === 200;
      } catch (e) {
        stopped = false;
      }
      if (stopped) {
        updateSessionState(statePath, sessionId, { offPending: false, offError: null });
        reconciled.offCompensated = reconciled.offCompensated || [];
        reconciled.offCompensated.push(sessionId);
      }
      // 无论成功与否都不进入开启分支
      continue;
    }

    // 2026-10-21 v2：key 由 sessionId 确定性派生，发现存储里的 key 与推导值不符
    // （历史脏数据 / 旧 system 哈希 / 别的会话的 key）→ 立即纠正。
    // 这是 10-21 事故（LSD1 绑到 90-token E2E 测试 key）在机制层的堵漏：
    // 不再有"存什么就信什么"的路径。
    if (session.key && session.key !== derivedKey) {
      if (session.on) {
        try { await sidecarControlOff(session.key); } catch {}
      }
      updateSessionState(statePath, sessionId, {
        key: derivedKey,
        on: false,
        waiting: false,
        rekeyedFrom: session.key,
      });
      reconciled.rekeyed.push({ sessionId, from: session.key, to: derivedKey });
      // on 状态需要重新走校验才能恢复，不能凭旧状态直接续上
      continue;
    }
    if (!session.key) {
      updateSessionState(statePath, sessionId, { key: derivedKey });
    }

    // 活跃会话且 on: true -> 交叉校验 + 补挂（幂等）
    if (session.on) {
      try {
        // 交叉校验（用户裁定 #3）：不通过就关掉，绝不给错对象保温。
        // 但要区分两种"校验不过"：
        //   ① no-request-recorded —— sidecar 重启丢内存（KI-2）或会话刚开还没说话。
        //      这不是"打错对象"，只是暂时无法确认；保持 on、置 waiting 等真实请求到达。
        //      否则每次 sidecar 重启都会把用户开的保温全部关掉。
        //   ② 其余原因（session-id-mismatch / prompt-size-mismatch）—— 真打错对象，
        //      立即关闭并把原因记入 verifyError 供 UI 显示。
        const check = await verifyBinding(sessionId, derivedKey, {});
        // 2026-10-23 审计 T18：三类"校验不过"必须分开处理 ——
        //   ① no-request-recorded —— 暂时无法确认（重启丢内存/还没说话）；
        //   ② sidecar-unreachable / 超时 —— **基础设施暂时不可用，不是身份错误**，
        //      绝不能因此抹掉用户的 on 意图（旧实现把它归入"真打错对象"并置 on:false）；
        //   ③ session-id-mismatch / prompt-size-mismatch —— 真打错对象，才拒绝/阻断。
        const INFRA_REASONS = new Set([
          'sidecar-unreachable', 'timeout', 'econnrefused', 'network', 'socket-hang-up',
        ]);
        const transient = !check.ok
          && (check.reason === 'no-request-recorded' || INFRA_REASONS.has(check.reason));
        if (!check.ok && !transient) {
          updateSessionState(statePath, sessionId, { on: false, waiting: false, verifyError: check.reason });
          try { await sidecarControlOff(derivedKey); } catch {}
          continue;
        }
        if (transient) {
          // 保留 on 意图（不动 session.on），只标记等待/不可达原因。
          // 2026-10-23 审计 T20：no-request-recorded 时必须**把等待意图注册到
          // sidecar**，否则 sidecar 不知道有人想保温，真实请求到达也不会开循环。
          if (check.reason === 'no-request-recorded') {
            try { await sidecarControlOn(derivedKey, session.intervalMin || 30, 'resume'); } catch {}
          }
          updateSessionState(statePath, sessionId, {
            waiting: check.reason === 'no-request-recorded',
            verifyError: check.reason === 'no-request-recorded' ? null : check.reason,
          });
          reconciled.waiting.push(sessionId);
          continue;
        }
        const res = await sidecarControlOn(derivedKey, session.intervalMin || 30, 'ensure');
        const waiting = res != null && res.status === 409;

        // 2026-10-22 第二轮审计修复（问题 1）：**必须核对 sidecar 的真实状态**。
        // 旧逻辑只看 HTTP 200 就当"已挂上"，但 sidecar 若已因低命中/401 熔断
        // （pings.on=false, stale=true），/control/on 仍会返回 200 而**不清除熔断**。
        // 于是插件继续显示 on=true、每轮对账继续调用，熔断被周期性对账绕过。
        const sidecarState = res && res.data && res.data.state ? res.data.state : null;
        // 409 breaker-open 是 sidecar 的显式熔断回报（2026-10-23 ensure 语义）
        const breakerOpen409 = res != null && res.status === 409 && res.data?.error === 'breaker-open';
        const refusedByBreaker = breakerOpen409 || (sidecarState != null
          && (sidecarState.on === false || sidecarState.stale === true));

        if (refusedByBreaker) {
          // 把熔断原因同步到插件侧，并**停止后续补挂**（置 on:false），
          // 避免下一次对账再次尝试。用户显式 /HTON 才会重新开启。
          const reason = (res.data && res.data.blockedReason) || 'breaker-tripped';
          updateSessionState(statePath, sessionId, {
            on: false,
            waiting: false,
            verifyError: null,
            blockedReason: reason,
            blockedAt: Date.now(),
          });
          reconciled.blocked = reconciled.blocked || [];
          reconciled.blocked.push({ sessionId, reason });
          continue;
        }

        // 交叉校验通过后要把遗留的 verifyError / 熔断标记清掉
        const patch = {};
        if ((session.waiting === true) !== waiting) patch.waiting = waiting;
        if (session.verifyError) patch.verifyError = null;
        if (session.blockedReason) { patch.blockedReason = null; patch.blockedAt = null; }
        if (Object.keys(patch).length) updateSessionState(statePath, sessionId, patch);
        reconciled.reconnected.push(sessionId);
      } catch {}
    }
  }

  return reconciled;
}

/**
 * 会话集合快照（用户裁定 #4）：周期 10min 重扫；此外任何「会话创建/删除/归档」
 * 动作都会触发一次立即重扫 —— 事件驱动优先于轮询，重扫请求会被合并（不排队堆积）。
 */
export function startReconciler({ ctx, statePath, intervalMs = 10 * 60 * 1000, hooks = {} }) {
  let refreshing = false;
  let pending = false;

  // 2026-10-23 审计 T19/T22/T23：持锁期间到来的新一轮不能"静默丢弃"。
  // 旧实现直接 return，调用方（含 hooks 消费者）永远等不到本次结果，
  // 表现为面板显示过期快照。改为：标记 pending，并返回一个在下一轮完成时兑现的 promise。
  let pendingResolvers = [];
  const runOnce = async () => {
    if (refreshing) {
      pending = true;
      return new Promise((resolve) => pendingResolvers.push(resolve));
    }
    refreshing = true;
    let notify = () => {};
    try {
      // 全量列表（贵）给快照缓存；活跃集合（含实时归档过滤）供本轮对账
      const allIds = await getAllSessionIds(ctx);
      hooks.onAllSessions?.(allIds);
      // 2026-10-22 第二轮审计修复（问题 2）：生产路径**不得**先自己取集合再以
      // activeSessionIds 传入 —— 那会命中"显式集合默认可信"分支，
      // 宿主列表失败+磁盘为空时用空集合删掉全部配置。
      // 改为把 ctx 交给 runReconciliation，由它调用带状态的 getAuthoritativeSessionIds()。
      const r = await runReconciliation({ ctx, statePath });
      notify = r;
      hooks.onReconciled?.(r);
    } catch {
    } finally {
      refreshing = false;
      // 兑现等待中的调用方
      const waiters = pendingResolvers; pendingResolvers = [];
      for (const res of waiters) { try { res(notify); } catch {} }
      if (pending) {
        pending = false;
        // 新一轮立刻执行；其结果会走同一 hooks 通道，调用方不会丢轮次
        void runOnce();
      }
    }
  };

  // 启动时立即执行一次
  void runOnce();

  const timer = setInterval(() => { void runOnce(); }, intervalMs);
  if (timer.unref) timer.unref();

  // 事件驱动的即时刷新（会话增删归档）
  const kick = () => { void runOnce(); };
  const disposers = [];
  for (const evt of ['session/created', 'session/disposed', 'workspace/session-stop']) {
    try {
      const off = ctx?.on?.(evt, kick);
      if (typeof off === 'function') disposers.push(off);
    } catch {}
  }

  return () => {
    clearInterval(timer);
    for (const d of disposers) { try { d(); } catch {} }
  };
}

// 注意：会话标题一律来自 DSH canonical title（ctx.sessionQuery.readTitleSnapshots，
// 见 index.mjs readSessionTitles）。严禁恢复「解压 session log 取首条 user prompt」
// 的旧实现——它不是真实 session 名称、rename 不同步、且每次取名都要解压日志。
