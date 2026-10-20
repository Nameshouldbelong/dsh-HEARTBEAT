import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readState, removeSessionState, updateSessionState } from './state.mjs';
import { sidecarControlOn, sidecarControlOff } from './sidecar-client.mjs';
import { rotateStaleKey } from './commands.mjs';

function extractSessionInfo(record) {
  if (!record || typeof record !== 'object') return null;
  const header = record.header && typeof record.header === 'object' ? record.header : null;
  const id = header?.id || record.id || record.sessionId;
  if (!id || typeof id !== 'string') return null;
  const origin = header?.origin ?? record.origin;
  const parentId = header?.parentSession ?? header?.parentSessionId ?? record.parentSession ?? record.parentSessionId;
  return { id, origin, parentId };
}

export async function getActiveSessionIds(ctx) {
  // 1. 尝试从 cordis 注入的 sessionQuery / workspaceRegistry 读取
  const archived = new Set();
  try {
    const list = ctx?.workspaceRegistry?.archivedSessionIds;
    if (Array.isArray(list) || list instanceof Set) {
      for (const id of list) archived.add(id);
    } else if (list && typeof list[Symbol.iterator] === 'function') {
      for (const id of list) archived.add(id);
    }
  } catch {}

  const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');

  // 若从 ctx 读取的 archived 为空，尝试从 storages/workspace.json 兜底读取
  if (archived.size === 0) {
    try {
      const wsJsonPath = path.join(base, 'storages', 'workspace.json');
      if (fs.existsSync(wsJsonPath)) {
        const wsData = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
        const list = wsData?.global?.archivedSessionIds;
        if (Array.isArray(list)) {
          for (const id of list) archived.add(id);
        }
      }
    } catch {}
  }

  const activeIds = new Set();
  let gotFromCtx = false;

  try {
    if (ctx?.sessionQuery && typeof ctx.sessionQuery.listSessions === 'function') {
      const records = await ctx.sessionQuery.listSessions();
      if (Array.isArray(records)) {
        const parsed = [];
        const candidateIds = new Set();
        for (const r of records) {
          const info = extractSessionInfo(r);
          if (info && !archived.has(info.id)) {
            parsed.push(info);
            candidateIds.add(info.id);
          }
        }

        // 根活跃会话（非 subagent 且未归档）
        const rootActiveIds = new Set();
        for (const info of parsed) {
          if (info.origin !== 'subagent') {
            rootActiveIds.add(info.id);
          }
        }

        // 孤儿 subagent 会话过滤：origin === 'subagent' 且 parent 不在活跃集合中予以排除
        for (const info of parsed) {
          if (info.origin === 'subagent') {
            if (!info.parentId || !rootActiveIds.has(info.parentId)) {
              continue;
            }
          }
          activeIds.add(info.id);
        }
        gotFromCtx = true;
      }
    }
  } catch {}

  if (gotFromCtx) return activeIds;

  // 2. 备用方案：扫描 ~/.dsh/sessions/ 目录与 storages
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
        const res = await sidecarControlOn(session.key, session.intervalMin || 50);
        // 409 no-request-recorded：sidecar 重启丢了内存请求体，或存储 key 已随
        // system prompt 漂移失效（KI-3）。先试 key 轮换；不成则标记 waiting，
        // UI 显示 WAITING FOR REAL REQUEST，真实流量到达后 sidecar 自动恢复
        let waiting = res != null && res.status === 409;
        if (waiting) {
          const rotated = await rotateStaleKey(sessionId, statePath, session.key, session.intervalMin || 50)
            .catch(() => null);
          if (rotated) waiting = false;
        }
        if ((session.waiting === true) !== waiting) {
          updateSessionState(statePath, sessionId, { waiting });
        }
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

// 注意：会话标题一律来自 DSH canonical title（ctx.sessionQuery.readTitleSnapshots，
// 见 index.mjs readSessionTitles）。严禁恢复「解压 session log 取首条 user prompt」
// 的旧实现——它不是真实 session 名称、rename 不同步、且每次取名都要解压日志。
