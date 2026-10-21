// dsh-heartbeat server 入口
// 实现范围：docs/PLAN.md M2 + M4
// 契约：docs/INTERFACES.md Contract-B/D/E/F
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDefaultStatePath, readState } from './state.mjs';
import { sidecarControlState, sidecarSessions, sidecarSelfCheck } from './sidecar-client.mjs';
import { parseHtoParam, executeHton, executeHtoff, executeHto } from './commands.mjs';
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

function hookTelegramDutyCommands(statePath) {
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
      if (CommandRegistry.prototype._hbPatched) { hooked++; return; }
      CommandRegistry.prototype._hbPatched = true;
      const origResolve = CommandRegistry.prototype.resolve;
      CommandRegistry.prototype.resolve = function (cmdName) {
        const lower = String(cmdName || '').toLowerCase();
        if (lower === 'hton') {
          return {
            name: 'hton', aliases: ['HTON'],
            handler: async (args, env) => {
              const targetSessionId = env?.targetSessionId || 'telegram-duty';
              return await executeHton(targetSessionId, statePath);
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
        return origResolve.call(this, cmdName);
      };
      hooked++;
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
    if (!all || all.size === 0) {
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
  hookTelegramDutyCommands(statePath);

  // 3. 注册 DSH 平台命令 (/hton, /htoff, /hto)
  const registerCommands = (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'hton',
      description: '开启当前会话心跳保温',
      handler: async (invocation) => {
        const targetSessionId = invocation?.agent?.session?.id || getDutyTargetSessionId(ctx);
        const text = await executeHton(targetSessionId, statePath);
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

    // 兼容大写命令
    try {
      cmdCtx.commands.register({
        name: 'HTON',
        description: '开启当前会话心跳保温',
        handler: async (invocation) => {
          const targetSessionId = invocation?.agent?.session?.id || getDutyTargetSessionId(ctx);
          const text = await executeHton(targetSessionId, statePath);
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
                  ? `插件记录为关闭，但 sidecar 仍在保温该会话（间隔 ${sp.intervalMin}min）。`
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
          const { sessionId, on, intervalMin } = body || {};
          if (!sessionId) {
            sendJson(res, 400, { error: 'missing sessionId' });
            return;
          }
          let text;
          if (on) {
            if (intervalMin !== undefined) {
              await executeHto(String(intervalMin), sessionId, statePath);
            }
            text = await executeHton(sessionId, statePath);
          } else {
            text = await executeHtoff(sessionId, statePath);
          }
          const updated = readState(statePath).sessions[sessionId];
          sendJson(res, 200, { ok: true, text, session: updated });
          return;
        }

        if (req.method === 'POST' && pathname === '/heartbeat/api/interval') {
          const body = await readJsonBody(req);
          const { sessionId, intervalMin } = body || {};
          if (!sessionId || intervalMin === undefined) {
            sendJson(res, 400, { error: 'missing sessionId or intervalMin' });
            return;
          }
          const text = await executeHto(String(intervalMin), sessionId, statePath);
          const parsed = parseHtoParam(String(intervalMin));
          if (!parsed.valid) {
            sendJson(res, 400, { error: text });
            return;
          }
          const updated = readState(statePath).sessions[sessionId];
          sendJson(res, 200, { ok: true, text, session: updated });
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
