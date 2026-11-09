import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { runReconciliation } from '../lib/reconciler.mjs';
import { readState, updateSessionState } from '../lib/state.mjs';
import { sessionKeyFor } from '../lib/keys.mjs';

// 确定性 fake sidecar（不依赖本机真实 sidecar 8791）
async function startFakeSidecar(t, behavior) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const r = behavior(req.url, Buffer.concat(chunks).toString('utf8'));
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.SIDECAR_PORT = String(server.address().port);
  t.after(() => {
    server.close();
    delete process.env.SIDECAR_PORT;
  });
  return server;
}

// 默认行为：/control/on 一律 200（补挂成功），/sessions 为空，verify 通过
const defaultBehavior = (url) => {
  if (url === '/sessions') return { status: 200, json: { sessions: [] } };
  if (url === '/control/verify') return { status: 200, json: { ok: true, actualPromptTokens: 100 } };
  if (url === '/control/on') return { status: 200, json: { ok: true, immediatePing: true, state: {} } };
  if (url === '/control/off') return { status: 200, json: { ok: true } };
  return { status: 404, json: {} };
};

test('Contract-D: reconciler 对账（deleted/archived 会话置 OFF 并清理，活跃会话保留）', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-reconcile-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, defaultBehavior);

  try {
    // 初始化 3 个会话：
    // sess-active: 活跃会话, on=true, 派生 key
    // sess-archived: 已归档会话, on=true
    // sess-deleted: 已删除会话, on=false
    const activeKey = sessionKeyFor('sess-active');
    updateSessionState(tmpFile, 'sess-active', {
      key: activeKey,
      on: true,
      intervalMin: 30,
    });
    updateSessionState(tmpFile, 'sess-archived', {
      key: sessionKeyFor('sess-archived'),
      on: true,
      intervalMin: 50,
    });
    updateSessionState(tmpFile, 'sess-deleted', {
      key: sessionKeyFor('sess-deleted'),
      on: false,
      intervalMin: 50,
    });

    // 此时活跃会话集合仅包含 sess-active
    const activeSessionIds = new Set(['sess-active']);

    const report = await runReconciliation({
      statePath: tmpFile,
      activeSessionIds,
    });

    assert.ok(report.removed.includes('sess-archived'));
    assert.ok(report.removed.includes('sess-deleted'));
    assert.equal(report.removed.length, 2);

    // 检查持久化 state.json
    const state = readState(tmpFile);
    assert.ok(state.sessions['sess-active']);
    assert.equal(state.sessions['sess-active'].on, true);
    assert.equal(state.sessions['sess-archived'], undefined);
    assert.equal(state.sessions['sess-deleted'], undefined);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('KI-3: reconciler 对存储 key 漂移（历史脏 key）自动纠正为确定性派生 key 并关停旧 key', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-reconcile-ki3-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const sessionId = 'sess-drift';
  const derivedKey = sessionKeyFor(sessionId);
  let turnedOffKey = null;

  await startFakeSidecar(t, (url, body) => {
    if (url === '/sessions') {
      return { status: 200, json: { sessions: [{ key: derivedKey, lastSeenAt: new Date().toISOString(), model: 'k3' }] } };
    }
    if (url === '/control/verify') {
      return { status: 200, json: { ok: true, actualPromptTokens: 100 } };
    }
    if (url === '/control/on') {
      return { status: 200, json: { ok: true, immediatePing: true, state: {} } };
    }
    if (url === '/control/off') {
      try {
        turnedOffKey = JSON.parse(body || '{}').key;
      } catch {}
      return { status: 200, json: { ok: true } };
    }
    return { status: 404, json: {} };
  });

  try {
    updateSessionState(tmpFile, sessionId, { key: 'dshsc-stale', on: true, intervalMin: 50, waiting: true });

    const report = await runReconciliation({ statePath: tmpFile, activeSessionIds: new Set([sessionId]) });

    const state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].key, derivedKey, 'key 应纠正为确定性派生 key');
    assert.equal(state.sessions[sessionId].rekeyedFrom, 'dshsc-stale', '应记录旧 key 痕迹');
    assert.equal(state.sessions[sessionId].on, false, '纠正 key 后应重置开启状态待重新校验');
    assert.ok(report.rekeyed.some((r) => r.sessionId === sessionId && r.from === 'dshsc-stale' && r.to === derivedKey));
    assert.equal(turnedOffKey, 'dshsc-stale', '应通知 sidecar 关停旧 key');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('KI-3: 多会话基于 sessionId 独立派生 key，互不抢占且互不影响', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-reconcile-ki3b-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const key1 = sessionKeyFor('sess-drift');
  const key2 = sessionKeyFor('sess-other');

  await startFakeSidecar(t, (url) => {
    if (url === '/sessions') {
      return { status: 200, json: { sessions: [{ key: key1 }, { key: key2 }] } };
    }
    if (url === '/control/verify') {
      return { status: 200, json: { ok: true, actualPromptTokens: 100 } };
    }
    if (url === '/control/on') {
      return { status: 200, json: { ok: true, state: {} } };
    }
    if (url === '/control/off') return { status: 200, json: { ok: true } };
    return { status: 404, json: {} };
  });

  try {
    updateSessionState(tmpFile, 'sess-drift', { key: key1, on: true, intervalMin: 50 });
    updateSessionState(tmpFile, 'sess-other', { key: key2, on: true, intervalMin: 50 });

    await runReconciliation({ statePath: tmpFile, activeSessionIds: new Set(['sess-drift', 'sess-other']) });

    const state = readState(tmpFile);
    assert.equal(state.sessions['sess-drift'].key, key1, '各会话保持各自确定性派生 key');
    assert.equal(state.sessions['sess-other'].key, key2, '各会话保持各自确定性派生 key');
    assert.notEqual(state.sessions['sess-drift'].key, state.sessions['sess-other'].key, '不同会话派生 key 必然互斥');
    assert.equal(state.sessions['sess-drift'].on, true);
    assert.equal(state.sessions['sess-other'].on, true);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
