import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { runReconciliation } from '../lib/reconciler.mjs';
import { readState, updateSessionState } from '../lib/state.mjs';

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

// 默认行为：/control/on 一律 200（补挂成功），/sessions 为空
const defaultBehavior = (url) => {
  if (url === '/sessions') return { status: 200, json: { sessions: [] } };
  if (url === '/control/on') return { status: 200, json: { ok: true, immediatePing: true, state: {} } };
  if (url === '/control/off') return { status: 200, json: { ok: true } };
  return { status: 404, json: {} };
};

test('Contract-D: reconciler 对账（deleted/archived 会话置 OFF 并清理，活跃会话保留）', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-reconcile-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, defaultBehavior);

  try {
    // 初始化 3 个会话：
    // sess-active: 活跃会话, on=true
    // sess-archived: 已归档会话, on=true
    // sess-deleted: 已删除会话, on=false
    updateSessionState(tmpFile, 'sess-active', {
      key: 'dshsc-active',
      on: true,
      intervalMin: 30,
    });
    updateSessionState(tmpFile, 'sess-archived', {
      key: 'dshsc-archived',
      on: true,
      intervalMin: 50,
    });
    updateSessionState(tmpFile, 'sess-deleted', {
      key: 'dshsc-deleted',
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

test('KI-3: reconciler 对存储 key 漂移（409）自动轮换到新鲜 key', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-reconcile-ki3-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, (url, body) => {
    if (url === '/sessions') {
      // 会话的新流量在 fresh key 下（system prompt 漂移后的新 hash）
      return { status: 200, json: { sessions: [{ key: 'dshsc-fresh', lastSeenAt: new Date().toISOString(), model: 'k3' }] } };
    }
    if (url === '/control/on') {
      const key = JSON.parse(body || '{}').key;
      if (key === 'dshsc-stale') return { status: 409, json: { error: 'no-request-recorded', waiting: true } };
      if (key === 'dshsc-fresh') return { status: 200, json: { ok: true, immediatePing: true, state: {} } };
      return { status: 409, json: { error: 'no-request-recorded', waiting: true } };
    }
    if (url === '/control/off') return { status: 200, json: { ok: true } };
    return { status: 404, json: {} };
  });

  try {
    updateSessionState(tmpFile, 'sess-drift', { key: 'dshsc-stale', on: true, intervalMin: 50, waiting: true });

    const report = await runReconciliation({ statePath: tmpFile, activeSessionIds: new Set(['sess-drift']) });

    const state = readState(tmpFile);
    assert.equal(state.sessions['sess-drift'].key, 'dshsc-fresh', 'key 应轮换到新鲜值');
    assert.equal(state.sessions['sess-drift'].waiting, false, 'waiting 应解除');
    assert.equal(state.sessions['sess-drift'].on, true);
    assert.ok(report.reconnected.includes('sess-drift'));
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('KI-3: fresh key 已被其他开启会话认领时不抢（保持 waiting）', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-reconcile-ki3b-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, (url, body) => {
    if (url === '/sessions') {
      return { status: 200, json: { sessions: [{ key: 'dshsc-other', lastSeenAt: new Date().toISOString(), model: 'k3' }] } };
    }
    if (url === '/control/on') {
      const key = JSON.parse(body || '{}').key;
      if (key === 'dshsc-other') return { status: 200, json: { ok: true, state: {} } };
      return { status: 409, json: { error: 'no-request-recorded', waiting: true } };
    }
    if (url === '/control/off') return { status: 200, json: { ok: true } };
    return { status: 404, json: {} };
  });

  try {
    updateSessionState(tmpFile, 'sess-drift', { key: 'dshsc-stale', on: true, intervalMin: 50 });
    updateSessionState(tmpFile, 'sess-other', { key: 'dshsc-other', on: true, intervalMin: 50 });

    await runReconciliation({ statePath: tmpFile, activeSessionIds: new Set(['sess-drift', 'sess-other']) });

    const state = readState(tmpFile);
    assert.equal(state.sessions['sess-drift'].key, 'dshsc-stale', '不得抢占其他会话的 key');
    assert.equal(state.sessions['sess-drift'].waiting, true, '应保持 waiting');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
