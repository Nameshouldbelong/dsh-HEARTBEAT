// dsh-heartbeat server 入口
// 实现范围：docs/PLAN.md M2 + M4
// 契约：docs/INTERFACES.md Contract-B/D/E/F
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDefaultStatePath, readState } from './state.mjs';
import { sidecarControlState, sidecarSessions, sidecarSelfCheck, sidecarToolGateGet, sidecarToolGateSet } from './sidecar-client.mjs';
import { parseHtoParam, executeHton, executeHtoff, executeHto, executeTgon, executeTgoff, executeTgstatus, windowOfSession } from './commands.mjs';
import { getAllSessionIds, getArchivedIds, startReconciler } from './reconciler.mjs';
import { sessionKeyFor } from './keys.mjs';

export const name = 'dsh-heartbeat';
export const inject = ['webServer', 'commands', 'sessionQuery', 'workspaceRegistry'];

// 读取 DSH canonical session title（sessionQuery.readTitleSnapshots, latest-wins 折叠
// session/title 事件，含用户 Rename）。
// KI-4 修复（2026-10-21）：超大会话日志折叠一次要 8-9s，而前端每 5s 轮询一次 —— 必须缓存。
// 缓存失效靠**事件**而不是纯 TTL：DSH 每次 Rename/自动取名都会 append session/title 事件
// （session/event），我们在 apply() 里订阅它并精确清掉该会话的缓存项 ——
// 于是 Rename 立刻生效，同时轮询不再重复解压日志。TTL 只作兜底（防漏事件）。
const TITLE_CACHE_TTL_MS = 60_000;
const titleCache = new Map(); // sessionId -> { title, at }

export function forgetSessionTitle(sessionId) {
  titleCache.delete(sessionId);
}

export function clearTitleCache() {
  titleCache.clear();
}

async function readSessionTitles(ctx, sessionIds, { force = false } = {}) {
  const titles = new Map();
  if (!sessionIds.length) return titles;

  const now = Date.now();
  const stale = [];
  for (const id of sessionIds) {
    const hit = titleCache.get(id);
    if (!force && hit && now - hit.at < TITLE_CACHE_TTL_MS) {
      if (hit.title) titles.set(id, hit.title);
    } else {
      stale.push(id);
    }
  }
  if (stale.length === 0) return titles;

  try {
    const sq = ctx?.sessionQuery;
    if (sq && typeof sq.readTitleSnapshots === 'function') {
      const results = await sq.readTitleSnapshots(stale);
      for (const r of results || []) {
        if (!r) continue;
        if (r.status === 'fulfilled') {
          const title = r.value?.title?.title || null;
          titleCache.set(r.sessionId, { title, at: now });
          if (title) titles.set(r.sessionId, title);
        }
      }
    }
  } catch {}
  return titles;
}


export function getDutyTargetSessionId(ctx) {
  // 1. 尝试从 telegram-duty 启动配置 / storages 读取
  try {
    const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh');
    const startupFile = path.join(base, 'storages', 'telegram-duty', 'startup.json');
    if (fs.existsSync(startupFile)) {
      const data = JSON.parse(fs.readFileSync(startupFile, 'utf8'));
      if (data?.sessionId) return data.sessionId;
    }
  } catch {}

  // 2. 尝试从 settings 读取 telebot-bridge-control 或 telegram-duty
  try {
    const settings = ctx?.get?.('settings');
    if (settings && typeof settings.get === 'function') {
      const bridge = settings.get('telebot-bridge-control');
      if (bridge?.sessionId) return bridge.sessionId;
      const duty = settings.get('telegram-duty');
      if (duty?.sessionId) return duty.sessionId;
    }
  } catch {}

  return 'telegram-duty';
}

function hookTelegramDutyCommands(statePath, ctx) {
  const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh');
  const candidates = [];
  try {
    const profilesDir = path.join(base, 'profiles');
    for (const prof of fs.readdirSync(profilesDir)) {
      candidates.push(path.join(profilesDir, prof, 'node_modules', '@nameshouldbelong', 'dsh-telegram-duty', 'lib', 'local-commands.js'));
    }
  } catch {}
  candidates.push(path.join(os.homedir(), 'DSH', '插件制作', 'dsh-plugin-telegram-duty', 'lib', 'local-commands.js'));
  candidates.push(path.join(os.homedir(), 'dsh-plugin-telegram-duty', 'lib', 'local-commands.js'));

  let hooked = 0;
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    import(c).then(({ CommandRegistry }) => {
      if (!CommandRegistry || !CommandRegistry.prototype) return;
      // 2026-10-22 审计 §6-c：旧实现只打补丁、从不还原，且 `_hbPatched` 会
      // 让热重载后的新闭包不生效（仍指向旧 statePath）。改为：
      //   · 首次安装时保存原型上的**原始** resolve 到 shell 对象；
      //   · 每次加载都把包装层替换成最新闭包（热重载即生效）；
      //   · 返回 dispose，由 ctx.effect 在插件卸载时还原原型。
      const shell = CommandRegistry.prototype._hbShell || (CommandRegistry.prototype._hbShell = {
        originalResolve: CommandRegistry.prototype.resolve,
      });
      const origResolve = shell.originalResolve;
      const wrappedResolve = function (cmdName) {
        const lower = String(cmdName || '').toLowerCase();
        if (lower === 'hton') {
          return {
            name: 'hton', aliases: ['HTON'],
            handler: async (args, env) => {
              const targetSessionId = env?.targetSessionId || 'telegram-duty';
              // 2026-10-25：/HTON 可携带区间参数（如 15-20），空则默认 20-30
              return await executeHton(targetSessionId, statePath, { windowArg: args });
            },
          };
        }
        if (lower === 'htoff') {
          return {
            name: 'htoff', aliases: ['HTOFF'],
            handler: async (args, env) => {
              const targetSessionId = env?.targetSessionId || 'telegram-duty';
              return await executeHtoff(targetSessionId, statePath);
            },
          };
        }
        if (lower === 'hto') {
          return {
            name: 'hto', aliases: ['HTO'],
            handler: async (args, env) => {
              const targetSessionId = env?.targetSessionId || 'telegram-duty';
              return await executeHto(args, targetSessionId, statePath);
            },
          };
        }
        if (lower === 'tgon' || lower === 'tgoff' || lower === 'tg') {
          const fn = lower === 'tgon' ? executeTgon : (lower === 'tgoff' ? executeTgoff : executeTgstatus);
          return {
            name: lower, aliases: [lower.toUpperCase()],
            handler: async () => await fn(),
          };
        }
        return origResolve.call(this, cmdName);
      };
      CommandRegistry.prototype.resolve = wrappedResolve;
      hooked++;
      // 卸载时还原原型（若已是别人的补丁则不强改，避免踩踏）
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          if (CommandRegistry.prototype.resolve === wrappedResolve) {
            CommandRegistry.prototype.resolve = origResolve;
          }
        });
      }
      console.log('[dsh-heartbeat] duty command hook installed:', c);
    }).catch((e) => console.warn('[dsh-heartbeat] duty hook import failed:', c, String(e)));
  }
  setTimeout(() => {
    if (hooked === 0) console.warn('[dsh-heartbeat] duty command hook: no CommandRegistry instance found');
  }, 15000);
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function apply(ctx) {
  const statePath = getDefaultStatePath();

  // 1. 启动 reconciler（用户裁定 #4：周期 10min + 会话增删归档事件即时刷新）
  // 快照只缓存**昂贵的部分**（全量会话列表扫描，可能需要解压日志）；
  // 归档集合每次实时读（内存数组，成本≈0），所以归档/取消归档立刻生效。
  const snapshot = { allIds: new Set(), at: 0 };
  // 快照最大陈旧时间；事件触发会立即刷新，这里只是兜底（正常远小于此）
  const SNAPSHOT_TTL_MS = 60_000;
  const stopReconciler = startReconciler({
    ctx,
    statePath,
    onAllSessions: (ids) => {
      snapshot.allIds = ids instanceof Set ? ids : new Set(ids || []);
      snapshot.at = Date.now();
    },
  });
  ctx.effect(() => () => stopReconciler(), 'dsh-heartbeat: reconciler lifecycle');

  // 取「当前活跃会话集合」：快照（贵）− 实时归档集合（便宜）。
  const activeSessionIds = async () => {
    let all = snapshot.allIds;
    // 2026-10-23 审计 T22/T23：旧实现只在"快照为空"时才重取，于是第一次成功
    // 暖起来之后**再也不刷新** —— 新建/删除会话后面板一直显示旧列表。
    // 改为：为空 或 超过 SNAPSHOT_TTL_MS 即重取（事件触发的 runOnce 会刷新它）。
    const stale = !snapshot.at || (Date.now() - snapshot.at) > SNAPSHOT_TTL_MS;
    if (!all || all.size === 0 || stale) {
      all = await getAllSessionIds(ctx);
      snapshot.allIds = all;
      snapshot.at = Date.now();
    }
    const archived = getArchivedIds(ctx);
    const active = new Set();
    for (const id of all) if (!archived.has(id)) active.add(id);
    return active;
  };

  // 1b. 标题缓存的事件级失效（KI-4 + Rename 即时同步）
  // DSH 每次 Rename / 自动取名都会 append session/title 事件；订阅它精确清缓存，
  // 于是「轮询不重复解压日志」与「Rename 立刻生效」可以同时成立。
  // 2026-10-23 审计 T22/T23：会话增删/归档事件到达时，**同步**把快照标记为陈旧，
  // 使紧接着的一次 /heartbeat/api/state 立即重扫（不必等 TTL，也不依赖
  // reconciler 异步跑完）。这是"面板与事实一致"的最短路径。
  for (const evt of ['session/created', 'session/disposed', 'workspace/session-stop']) {
    try {
      ctx?.on?.(evt, () => { snapshot.at = 0; });
    } catch {}
  }

  try {
    const offTitle = ctx?.on?.('session/event', (session, event) => {
      if (event && event.type === 'session/title') {
        const id = typeof session === 'string' ? session : session?.id;
        if (id) forgetSessionTitle(id);
      }
    });
    if (typeof offTitle === 'function') ctx.effect(() => offTitle, 'dsh-heartbeat: title cache invalidation');
  } catch {}

  // 2. 挂接 Telegram duty 斜杠指令
  hookTelegramDutyCommands(statePath, ctx);

  // 3. 注册 DSH 平台命令 (/hton, /htoff, /hto)
  const registerCommands = (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'hton',
      description: '开启当前会话心跳保温（可带窗口如 20-30，默认 20-30）',
      input: { hint: '[起-止] 如 20-30' },
      handler: async (invocation) => {
        const targetSessionId = invocation?.agent?.session?.id || getDutyTargetSessionId(ctx);
        const text = await executeHton(targetSessionId, statePath, { windowArg: invocation.rawInput });
        return { kind: 'success', text };
      },
    });

    cmdCtx.commands.register({
      name: 'htoff',
      description: '关闭当前会话心跳保温',
      handler: async (invocation) => {
        const targetSessionId = invocation?.agent?.session?.id || getDutyTargetSessionId(ctx);
        const text = await executeHtoff(targetSessionId, statePath);
        return { kind: 'success', text };
      },
    });

    cmdCtx.commands.register({
      name: 'hto',
      description: '设置心跳间隔并开启心跳保温（单位分钟，1-720）',
      input: { hint: '<分钟>' },
      handler: async (invocation) => {
        const targetSessionId = invocation?.agent?.session?.id || getDutyTargetSessionId(ctx);
        const text = await executeHto(invocation.rawInput, targetSessionId, statePath);
        const parsed = parseHtoParam(invocation.rawInput);
        if (!parsed.valid) {
          return { kind: 'error', text };
        }
        return { kind: 'success', text };
      },
    });

    // 工具门控（2026-10-24）：kimi 出站按前缀剥除 MCP 工具（rea 652KB schema 事故）
    const registerToolGateCommands = (c) => {
      c.commands.register({
        name: 'tgon',
        description: '开启工具门控（kimi 出站按前缀剥除工具，即时生效）',
        handler: async () => ({ kind: 'success', text: await executeTgon() }),
      });
      c.commands.register({
        name: 'tgoff',
        description: '关闭工具门控（kimi 出站原样透传）',
        handler: async () => ({ kind: 'success', text: await executeTgoff() }),
      });
      c.commands.register({
        name: 'tg',
        description: '查看工具门控状态与累计统计',
        handler: async () => ({ kind: 'success', text: await executeTgstatus() }),
      });
    };
    registerToolGateCommands(cmdCtx);

    // 兼容大写命令
    try {
      cmdCtx.commands.register({
        name: 'HTON',
        description: '开启当前会话心跳保温（可带窗口如 20-30，默认 20-30）',
        input: { hint: '[起-止] 如 20-30' },
        handler: async (invocation) => {
          const targetSessionId = invocation?.agent?.session?.id || getDutyTargetSessionId(ctx);
          const text = await executeHton(targetSessionId, statePath, { windowArg: invocation.rawInput });
          return { kind: 'success', text };
        },
      });
      cmdCtx.commands.register({
        name: 'HTOFF',
        description: '关闭当前会话心跳保温',
        handler: async (invocation) => {
          const targetSessionId = invocation?.agent?.session?.id || getDutyTargetSessionId(ctx);
          const text = await executeHtoff(targetSessionId, statePath);
          return { kind: 'success', text };
        },
      });
      cmdCtx.commands.register({
        name: 'HTO',
        description: '设置心跳间隔并开启心跳保温（单位分钟，1-720）',
        input: { hint: '<分钟>' },
        handler: async (invocation) => {
          const targetSessionId = invocation?.agent?.session?.id || getDutyTargetSessionId(ctx);
          const text = await executeHto(invocation.rawInput, targetSessionId, statePath);
          const parsed = parseHtoParam(invocation.rawInput);
          if (!parsed.valid) {
            return { kind: 'error', text };
          }
          return { kind: 'success', text };
        },
      });
    } catch {}
  };

  if (ctx.commands && typeof ctx.commands.register === 'function') {
    registerCommands(ctx);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (cmdCtx) => registerCommands(cmdCtx));
  }

  // 4. 注册 Web API 路由 (/heartbeat/*)
  const registerWeb = (webCtx) => {
    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      try {
        if (req.method === 'GET' && pathname === '/heartbeat/api/state') {
          const state = readState(statePath);
          // KI-4：全量会话扫描走 reconciler 快照（10min 周期 + 会话事件即时刷新），
          // 归档集合每次实时读 —— 归档/取消归档立刻反映，不需要等快照刷新。
          const activeIds = await activeSessionIds();
          const [pings, sidecarSess, selfCheck] = await Promise.all([
            sidecarControlState(),
            sidecarSessions(),
            sidecarSelfCheck().catch(() => null),
          ]);

          const sessionsList = [];
          const seen = new Set();

          // 优先合并 state.json 中属于活跃集合的已知会话
          for (const [id, s] of Object.entries(state.sessions || {})) {
            if (!activeIds.has(id)) continue;
            seen.add(id);
            // key 一律以推导值为准展示；与存储不符时标出 drift 供排查
            let derived = null;
            try { derived = sessionKeyFor(id); } catch {}
            sessionsList.push({
              sessionId: id,
              key: derived || s.key,
              keyDrift: s.key && derived && s.key !== derived ? s.key : null,
              on: s.on === true,
              waiting: s.waiting === true,
              intervalMin: s.intervalMin || 30,
              windowStartMin: s.windowStartMin != null ? s.windowStartMin : (windowOfSession(s).startMin),
              windowEndMin: s.windowEndMin != null ? s.windowEndMin : (windowOfSession(s).endMin),
              updatedAt: s.updatedAt,
              verifyError: s.verifyError || null,
            });
          }

          // 追加 activeIds 中尚未列入 state 的会话
          for (const id of activeIds) {
            if (!seen.has(id)) {
              seen.add(id);
              let key = null;
              try { key = sessionKeyFor(id); } catch (e) { key = null; }
              sessionsList.push({
                sessionId: id,
                key,
                on: false,
                waiting: false,
                intervalMin: 30,
                windowStartMin: 20,
                windowEndMin: 30,
              });
            }
          }

          // DSH canonical session title（Rename 后下一次刷新即同步；无 title 为 null，
          // client 显示短 sessionId）
          const titles = await readSessionTitles(ctx, [...seen]);
          for (const s of sessionsList) {
            s.title = titles.get(s.sessionId) || null;
            // 前缀规模（供 UI 展示与人工核对保温对象是否正确）
            const sc = sidecarSess.find((x) => x.key === s.key);
            s.promptTokens = sc ? Number(sc.lastPromptTokens || 0) || null : null;
          }

          // 把 sidecar 自检结果按 sessionId 归位，便于面板在对应会话行上直接告警
          const alarmsByKey = new Map();
          for (const a of (selfCheck?.alarms || [])) {
            if (!alarmsByKey.has(a.key)) alarmsByKey.set(a.key, []);
            alarmsByKey.get(a.key).push(a);
          }

          // 2026-10-21 新增：插件与 sidecar 的状态分叉检测。
          // 两者各存一份"开/关"，任一侧被绕过（手动调 /control/on、手工改 state.json、
          // 旧版本残留）都会让 UI 与实际行为不一致 —— 正是 10-21 事故的复现路径。
          const pingByKey = new Map((Array.isArray(pings) ? pings : []).map((p) => [p.key, p]));
          for (const s of sessionsList) {
            const list = (alarmsByKey.get(s.key) || []).slice();
            const sp = pingByKey.get(s.key);
            const pluginOn = s.on === true;
            const sidecarOn = !!(sp && sp.on === true);
            if (pluginOn !== sidecarOn) {
              list.push({
                key: s.key,
                code: 'state-diverged',
                severity: sidecarOn ? 'warn' : 'error',
                detail: sidecarOn
                  ? `插件记录为关闭，但 sidecar 仍在保温该会话（窗口 ${sp.windowStartMin ?? 20}-${sp.windowEndMin ?? 30}min）。`
                    + '说明 sidecar 侧被单独开启过（例如手工调用 /control/on）——插件不会管理它，'
                    + '重启插件或删除 state.json 条目后仍会残留。建议在面板点「关闭」再重新开启。'
                  : '插件记录为开启，但 sidecar 侧已无对应的保温记录：实际没有在 ping。'
                    + '下一轮对账（≤10min）会自动补挂；若持续出现，检查 sidecar 是否可达。',
              });
            }
            s.alarms = list;
          }

          sendJson(res, 200, {
            sessions: sessionsList,
            pings,
            sidecarSessions: sidecarSess,
            selfCheck: selfCheck || null,
            activeSnapshotAt: snapshot.at || null,
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/heartbeat/api/toggle') {
          const body = await readJsonBody(req);
          const { sessionId, on } = body || {};
          if (!sessionId) {
            sendJson(res, 400, { error: 'missing sessionId' });
            return;
          }
          // 保温窗口：优先 windowStartMin/windowEndMin；兼容旧 intervalMin（N→[N-10,N]）
          let windowArg;
          if (body.windowStartMin !== undefined && body.windowEndMin !== undefined) {
            windowArg = `${body.windowStartMin}-${body.windowEndMin}`;
          } else if (body.intervalMin !== undefined) {
            windowArg = String(body.intervalMin);
          }
          if (windowArg !== undefined) {
            const parsed = parseHtoParam(windowArg);
            if (!parsed.valid) {
              sendJson(res, 400, { error: '非法保温窗口：' + (parsed.error || windowArg) });
              return;
            }
          }
          let text;
          if (on) {
            text = await executeHton(sessionId, statePath, { windowArg });
            // 开启被拒（verify 不通过 / sidecar 不可达）时如实回报，不返回 200
            const after = readState(statePath).sessions[sessionId];
            if (!after || after.on !== true) {
              sendJson(res, 409, {
                error: (after && after.verifyError) || '保温未能开启',
                text,
                session: after,
              });
              return;
            }
          } else {
            text = await executeHtoff(sessionId, statePath);
          }
          const updated = readState(statePath).sessions[sessionId];
          sendJson(res, 200, { ok: true, text, session: updated });
          return;
        }

        if (req.method === 'POST' && pathname === '/heartbeat/api/interval') {
          const body = await readJsonBody(req);
          const { sessionId } = body || {};
          if (!sessionId) {
            sendJson(res, 400, { error: 'missing sessionId' });
            return;
          }
          // 窗口参数：windowStartMin/windowEndMin（或旧 intervalMin）→ 组装为 "s-e"
          let windowArg;
          if (body.windowStartMin !== undefined && body.windowEndMin !== undefined) {
            windowArg = `${body.windowStartMin}-${body.windowEndMin}`;
          } else if (body.intervalMin !== undefined) {
            windowArg = String(body.intervalMin);
          }
          if (windowArg === undefined) {
            sendJson(res, 400, { error: 'missing window (windowStartMin/windowEndMin)' });
            return;
          }
          // 2026-10-23 审计 T25：先校验参数，再执行副作用
          const parsed = parseHtoParam(windowArg);
          if (!parsed.valid) {
            sendJson(res, 400, { error: parsed.error || 'invalid window' });
            return;
          }
          const text = await executeHto(windowArg, sessionId, statePath);
          const updated = readState(statePath).sessions[sessionId];
          // 身份校验失败（verify 拒绝）必须报 HTTP 失败，不能 200 + ok:true
          if (!updated || updated.on !== true) {
            sendJson(res, 409, {
              error: (updated && updated.verifyError) || 'window 已拒绝',
              text,
              session: updated,
            });
            return;
          }
          sendJson(res, 200, { ok: true, text, session: updated });
          return;
        }

        // 工具门控（2026-10-24）：插件代理 sidecar 的 /control/toolgate，
        // 供 TOOL GATE tab 使用。sidecar 不可达/旧版时如实 503，不猜状态。
        if (pathname === '/heartbeat/api/toolgate' && req.method === 'GET') {
          const g = await sidecarToolGateGet();
          if (!g) {
            sendJson(res, 503, { error: 'sidecar-unreachable-or-legacy' });
            return;
          }
          sendJson(res, 200, g);
          return;
        }
        if (pathname === '/heartbeat/api/toolgate' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const res2 = await sidecarToolGateSet(body || {});
          if (!res2 || res2.status !== 200) {
            sendJson(res, (res2 && res2.status) || 503, (res2 && res2.data) || { error: 'sidecar-unreachable' });
            return;
          }
          sendJson(res, 200, res2.data);
          return;
        }

        sendJson(res, 404, { error: 'not-found' });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
    };

    if (webCtx.webServer && typeof webCtx.webServer.register === 'function') {
      webCtx.webServer.register({ kind: 'prefix', path: '/heartbeat', handler });
    }
  };

  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    registerWeb(ctx);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => registerWeb(webCtx));
  }
}
