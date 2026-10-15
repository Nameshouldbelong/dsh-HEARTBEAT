import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { readState, removeSessionState } from './state.mjs';
import { sidecarControlOn, sidecarControlOff } from './sidecar-client.mjs';

export async function getActiveSessionIds(ctx) {
  // 1. 尝试从 cordis 注入的 sessionQuery / workspaceRegistry 读取
  const archived = new Set();
  try {
    const list = ctx?.workspaceRegistry?.archivedSessionIds;
    if (Array.isArray(list)) {
      for (const id of list) archived.add(id);
    }
  } catch {}

  const activeIds = new Set();
  let gotFromCtx = false;

  try {
    if (ctx?.sessionQuery && typeof ctx.sessionQuery.listSessions === 'function') {
      const records = await ctx.sessionQuery.listSessions();
      if (Array.isArray(records)) {
        for (const r of records) {
          const id = r.header?.id || r.id;
          if (id && !archived.has(id)) {
            activeIds.add(id);
          }
        }
        gotFromCtx = true;
      }
    }
  } catch {}

  if (gotFromCtx) return activeIds;

  // 2. 备用方案：扫描 ~/.dsh/sessions/ 目录与 storages
  const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  const sessionsDir = path.join(base, 'sessions');

  try {
    if (fs.existsSync(sessionsDir)) {
      const wsDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const ws of wsDirs) {
        if (!ws.isDirectory()) continue;
        const wsPath = path.join(sessionsDir, ws.name);
        const sDirs = fs.readdirSync(wsPath, { withFileTypes: true });
        for (const s of sDirs) {
          if (!s.isDirectory()) continue;
          if (!archived.has(s.name)) {
            activeIds.add(s.name);
          }
        }
      }
    }
  } catch {}

  return activeIds;
}

export async function runReconciliation({ ctx, statePath, activeSessionIds }) {
  const state = readState(statePath);
  const activeSet = activeSessionIds instanceof Set
    ? activeSessionIds
    : Array.isArray(activeSessionIds)
      ? new Set(activeSessionIds)
      : await getActiveSessionIds(ctx);

  const sessionEntries = Object.entries(state.sessions || {});
  const reconciled = { removed: [], reconnected: [] };

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

    // 活跃会话且 on: true -> 对 sidecar /control/on 做一次补挂（幂等）
    if (session.on && session.key) {
      try {
        await sidecarControlOn(session.key, session.intervalMin || 50);
        reconciled.reconnected.push(sessionId);
      } catch {}
    }
  }

  return reconciled;
}

export function startReconciler({ ctx, statePath, intervalMs = 60000 }) {
  // 启动时立即执行一次对账与补挂
  void runReconciliation({ ctx, statePath }).catch(() => {});

  const timer = setInterval(() => {
    void runReconciliation({ ctx, statePath }).catch(() => {});
  }, intervalMs);

  if (timer.unref) timer.unref();

  return () => clearInterval(timer);
}

const labelCache = new Map();
export function getSessionLabel(id) {
  if (labelCache.has(id)) return labelCache.get(id);
  let label = null;
  try {
    const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh');
    const root = path.join(base, 'sessions');
    for (const ws of fs.readdirSync(root)) {
      const f = path.join(root, ws, id, 'session.v4.jsonl.zstd');
      try {
        if (!fs.existsSync(f)) continue;
        const r = spawnSync('zstd', ['-dc', f], { maxBuffer: 8 * 1024 * 1024, timeout: 8000 });
        const text = (r.stdout || Buffer.alloc(0)).toString('utf8');
        for (const line of text.split('\n')) {
          if (!line.includes('"user/message"')) continue;
          try {
            const d = JSON.parse(line);
            const src = d.data && d.data.source && d.data.source.kind;
            if (src && src !== 'user') continue;
            const c = d.data && d.data.content;
            const t = Array.isArray(c) ? c.map((x) => x.text || '').join(' ') : String(c || '');
            if (t.trim()) { label = t.trim().slice(0, 60); break; }
          } catch {}
        }
      } catch {}
      if (label) break;
    }
  } catch {}
  if (!label) label = id;
  labelCache.set(id, label);
  return label;
}
