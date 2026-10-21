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
  try {
    const list = ctx?.workspaceRegistry?.archivedSessionIds;
    if (Array.isArray(list) || list instanceof Set) {
      for (const id of list) archived.add(id);
    } else if (list && typeof list[Symbol.iterator] === 'function') {
      for (const id of list) archived.add(id);
    }
  } catch {}

  // ctx 读不到时兜底读 workspace.json（磁盘快照，可能略滞后，仅作降级）
  if (archived.size === 0) {
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
  } catch {}

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
  } catch {}

  return allIds;
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

export async function runReconciliation({ ctx, statePath, activeSessionIds }) {
  const state = readState(statePath);
  const activeSet = activeSessionIds instanceof Set
    ? activeSessionIds
    : Array.isArray(activeSessionIds)
      ? new Set(activeSessionIds)
      : await getActiveSessionIds(ctx);

  const sessionEntries = Object.entries(state.sessions || {});
  const reconciled = { removed: [], reconnected: [], rekeyed: [] };

  for (const [sessionId, session] of sessionEntries) {
    // 若已不存在或处于 deleted/archived 状态
    if (!activeSet.has(sessionId)) {
      if (session.on && session.key) {
        try {
          await sidecarControlOff(session.key);
        } catch {}
      }
      removeSessionState(statePath, sessionId);
      reconciled.removed.push(sessionId);
      continue;
    }

    // 2026-10-21 v2：key 由 sessionId 确定性派生，发现存储里的 key 与推导值不符
    // （历史脏数据 / 旧 system 哈希 / 别的会话的 key）→ 立即纠正。
    // 这是 10-21 事故（LSD1 绑到 90-token E2E 测试 key）在机制层的堵漏：
    // 不再有"存什么就信什么"的路径。
    const derivedKey = resolveSessionKey(sessionId);
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
        const transient = !check.ok && check.reason === 'no-request-recorded';
        if (!check.ok && !transient) {
          updateSessionState(statePath, sessionId, { on: false, waiting: false, verifyError: check.reason });
          try { await sidecarControlOff(derivedKey); } catch {}
          continue;
        }
        if (transient) {
          updateSessionState(statePath, sessionId, { waiting: true, verifyError: null });
          reconciled.waiting.push(sessionId);
          continue;
        }
        const res = await sidecarControlOn(derivedKey, session.intervalMin || 30);
        const waiting = res != null && res.status === 409;
        // 交叉校验通过后要把遗留的 verifyError 清掉（否则 UI 会一直显示旧失败原因）
        const patch = {};
        if ((session.waiting === true) !== waiting) patch.waiting = waiting;
        if (session.verifyError) patch.verifyError = null;
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

  const runOnce = async () => {
    if (refreshing) { pending = true; return; }
    refreshing = true;
    try {
      // 全量列表（贵）给快照缓存；活跃集合（含实时归档过滤）供本轮对账
      const allIds = await getAllSessionIds(ctx);
      hooks.onAllSessions?.(allIds);
      const activeIds = await getActiveSessionIds(ctx);
      const r = await runReconciliation({ ctx, statePath, activeSessionIds: activeIds });
      hooks.onReconciled?.(r);
    } catch {
    } finally {
      refreshing = false;
      if (pending) { pending = false; void runOnce(); }
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
