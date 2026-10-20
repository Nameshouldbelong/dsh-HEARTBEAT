// dsh-heartbeat server 入口
// 实现范围：docs/PLAN.md M2 + M4
// 契约：docs/INTERFACES.md Contract-B/D/E/F
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDefaultStatePath, readState } from './state.mjs';
import { sidecarControlState, sidecarSessions } from './sidecar-client.mjs';
import { parseHtoParam, executeHton, executeHtoff, executeHto, resolveSessionKey } from './commands.mjs';
import { getActiveSessionIds, startReconciler } from './reconciler.mjs';

export const name = 'dsh-heartbeat';
export const inject = ['webServer', 'commands', 'sessionQuery', 'workspaceRegistry'];

// 读取 DSH canonical session title（sessionQuery.readTitleSnapshots, latest-wins 折叠
// session/title 事件，含用户 Rename）。逐次实读不缓存，Rename 后下一次刷新即同步。
// 任何失败一律降级为 null（client 显示短 sessionId），绝不回退到扫描首条 user prompt。
async function readSessionTitles(ctx, sessionIds) {
  const titles = new Map();
  if (!sessionIds.length) return titles;
  try {
    const sq = ctx?.sessionQuery;
    if (sq && typeof sq.readTitleSnapshots === 'function') {
      const results = await sq.readTitleSnapshots(sessionIds);
      for (const r of results || []) {
        if (r && r.status === 'fulfilled' && r.value?.title?.title) {
          titles.set(r.sessionId, r.value.title.title);
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

  // 1. 启动 reconciler
  const stopReconciler = startReconciler({ ctx, statePath });
  ctx.effect(() => () => stopReconciler(), 'dsh-heartbeat: reconciler lifecycle');

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
          const activeIds = await getActiveSessionIds(ctx);
          const [pings, sidecarSess] = await Promise.all([
            sidecarControlState(),
            sidecarSessions(),
          ]);

          const sessionsList = [];
          const seen = new Set();

          // 优先合并 state.json 中属于活跃集合的已知会话
          for (const [id, s] of Object.entries(state.sessions || {})) {
            if (!activeIds.has(id)) continue;
            seen.add(id);
            sessionsList.push({
              sessionId: id,
              key: s.key,
              on: s.on === true,
              waiting: s.waiting === true,
              intervalMin: s.intervalMin || 30,
              updatedAt: s.updatedAt,
            });
          }

          // 追加 activeIds 中尚未列入 state 的会话
          for (const id of activeIds) {
            if (!seen.has(id)) {
              seen.add(id);
              let key = null;
              try { key = await resolveSessionKey(id, statePath); } catch (e) { key = null; }
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
          }

          sendJson(res, 200, {
            sessions: sessionsList,
            pings,
            sidecarSessions: sidecarSess,
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
