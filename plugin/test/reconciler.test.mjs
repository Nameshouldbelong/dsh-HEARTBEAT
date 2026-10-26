import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { runReconciliation, getAllSessionIds, getArchivedIds, getActiveSessionIds } from '../lib/reconciler.mjs';
import { sessionKeyFor } from '../lib/keys.mjs';
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

// 默认行为：verify 通过 + /control/on 200
const defaultBehavior = (url, body) => {
  if (url === '/sessions') return { status: 200, json: { sessions: [] } };
  if (url === '/control/verify') {
    const req = JSON.parse(body || '{}');
    return { status: 200, json: { ok: true, key: req.key, sessionId: req.sessionId, reasons: [] } };
  }
  if (url === '/control/on') return { status: 200, json: { ok: true, immediatePing: true, state: {} } };
  if (url === '/control/off') return { status: 200, json: { ok: true } };
  return { status: 404, json: {} };
};

test('Contract-D: reconciler 对账（archived/deleted 置 OFF 并清理，活跃会话保留）', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-reconcile-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, defaultBehavior);

  try {
    const activeKey = sessionKeyFor('sess-active');
    updateSessionState(tmpFile, 'sess-active', { key: activeKey, on: true, intervalMin: 30 });
    updateSessionState(tmpFile, 'sess-archived', { key: sessionKeyFor('sess-archived'), on: true, intervalMin: 50 });
    updateSessionState(tmpFile, 'sess-deleted', { key: sessionKeyFor('sess-deleted'), on: false, intervalMin: 50 });

    const activeSessionIds = new Set(['sess-active']);
    const report = await runReconciliation({ statePath: tmpFile, activeSessionIds });

    assert.ok(report.removed.includes('sess-archived'));
    assert.ok(report.removed.includes('sess-deleted'));
    assert.equal(report.removed.length, 2);

    const state = readState(tmpFile);
    assert.ok(state.sessions['sess-active']);
    assert.equal(state.sessions['sess-active'].on, true);
    assert.equal(state.sessions['sess-active'].key, activeKey);
    assert.equal(state.sessions['sess-archived'], undefined);
    assert.equal(state.sessions['sess-deleted'], undefined);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('v2: reconciler 发现 key 与会话派生值不符时自动纠正并停止保温（10-21 事故堵漏）', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-reconcile-rekey-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const offCalls = [];
  await startFakeSidecar(t, (url, body) => {
    if (url === '/control/off') {
      offCalls.push(JSON.parse(body || '{}').key);
      return { status: 200, json: { ok: true } };
    }
    return defaultBehavior(url, body);
  });

  try {
    // 模拟 10-21 现场：LSD1 会话被绑到 90-token E2E 测试 key
    updateSessionState(tmpFile, 'sess-lsd1', {
      key: 'dshsc-ea64f39ed24bda17',
      on: true,
      intervalMin: 25,
    });

    const report = await runReconciliation({
      statePath: tmpFile,
      activeSessionIds: new Set(['sess-lsd1']),
    });

    const state = readState(tmpFile);
    const derived = sessionKeyFor('sess-lsd1');
    assert.equal(state.sessions['sess-lsd1'].key, derived, 'key 必须纠正为会话派生值');
    assert.equal(state.sessions['sess-lsd1'].on, false, '错误的保温必须立即停止');
    assert.equal(state.sessions['sess-lsd1'].rekeyedFrom, 'dshsc-ea64f39ed24bda17', '应留下纠正痕迹供排查');
    assert.equal(report.rekeyed.length, 1);
    assert.equal(report.rekeyed[0].from, 'dshsc-ea64f39ed24bda17');
    assert.ok(offCalls.includes('dshsc-ea64f39ed24bda17'), '应把错误 key 的 ping 循环关掉');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('v2: reconciler 交叉校验失败时关闭保温（绝不给错对象保温）', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-reconcile-verify-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, (url, body) => {
    if (url === '/control/verify') {
      const req = JSON.parse(body || '{}');
      return { status: 200, json: { ok: false, reasons: ['prompt-size-mismatch'], key: req.key } };
    }
    return defaultBehavior(url, body);
  });

  try {
    updateSessionState(tmpFile, 'sess-x', { key: sessionKeyFor('sess-x'), on: true, intervalMin: 30 });

    await runReconciliation({ statePath: tmpFile, activeSessionIds: new Set(['sess-x']) });

    const state = readState(tmpFile);
    assert.equal(state.sessions['sess-x'].on, false, '校验失败必须关闭');
    assert.equal(state.sessions['sess-x'].verifyError, 'prompt-size-mismatch', '应记录失败原因');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('v2: reconciler 对 key 正确的开启会话做补挂（不误杀）', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-reconcile-ok-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, defaultBehavior);

  try {
    updateSessionState(tmpFile, 'sess-ok', { key: sessionKeyFor('sess-ok'), on: true, intervalMin: 25 });

    const report = await runReconciliation({ statePath: tmpFile, activeSessionIds: new Set(['sess-ok']) });

    const state = readState(tmpFile);
    assert.equal(state.sessions['sess-ok'].on, true, 'key 正确时应保持开启');
    assert.notEqual(state.sessions['sess-ok'].waiting, true, '不应被标记 waiting');
    assert.ok(report.reconnected.includes('sess-ok'));
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('v2 会话动态加载: archived 实时过滤 + 全量列表与归档集合分离', async () => {
  const archivedList = ['sess-b'];
  const ctx = {
    sessionQuery: {
      async listSessions() {
        return [
          { header: { id: 'sess-a' } },
          { header: { id: 'sess-b' } },
          { header: { id: 'sess-c' } },
        ];
      },
    },
    workspaceRegistry: {
      get archivedSessionIds() {
        return archivedList;
      },
    },
  };

  const all = await getAllSessionIds(ctx);
  assert.deepEqual([...all].sort(), ['sess-a', 'sess-b', 'sess-c'], '全量列表不受归档影响');
  assert.deepEqual([...getArchivedIds(ctx)], ['sess-b']);

  const active = await getActiveSessionIds(ctx);
  assert.deepEqual([...active].sort(), ['sess-a', 'sess-c'], '活跃集合排除归档会话');

  // 取消归档 -> 立刻反映（实时读，无缓存滞后）
  archivedList.length = 0;
  const active2 = await getActiveSessionIds(ctx);
  assert.deepEqual([...active2].sort(), ['sess-a', 'sess-b', 'sess-c'], '取消归档应立刻生效');

  // 新增归档 -> 同样立刻生效
  archivedList.push('sess-a');
  const active3 = await getActiveSessionIds(ctx);
  assert.deepEqual([...active3].sort(), ['sess-b', 'sess-c'], '新归档应立刻生效');
});

// ── 2026-10-22 codex 审计（DEBUG-PLAN §4）回归 ─────────────────────────────

test('审计§4: 宿主会话查询失败且磁盘不可用 -> 绝不清理已开启会话', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathm = await import('node:path');
  const dir = fs.mkdtempSync(pathm.join(os.tmpdir(), 'hb-reconciler-'));
  const statePath = pathm.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    sessions: { 'session-A': { key: 'dshsc-aaaaaaaaaaaaaaaa', on: true, intervalMin: 30 } },
  }));

  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = pathm.join(dir, 'nonexistent-host-home');  // 模拟磁盘兜底也不可用
  try {
    const result = await runReconciliation({
      ctx: {
        sessionQuery: { listSessions: async () => { throw new Error('host temporarily unavailable'); } },
        workspaceRegistry: { archivedSessionIds: [] },
      },
      statePath,
    });

    assert.deepEqual(result.removed, [], '宿主抖动时不得删除任何会话');
    assert.equal(result.skippedCleanup, true, '应标记本轮跳过清理');
    const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(after.sessions['session-A'], '已开启会话的配置必须保留');
    assert.equal(after.sessions['session-A'].on, true, 'on 状态必须保留');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('审计§4: 权威列表成功且会话确实不存在 -> 仍然正常清理', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathm = await import('node:path');
  const dir = fs.mkdtempSync(pathm.join(os.tmpdir(), 'hb-reconciler2-'));
  const statePath = pathm.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    sessions: { 'session-gone': { key: 'dshsc-bbbbbbbbbbbbbbbb', on: false, intervalMin: 30 } },
  }));
  try {
    const result = await runReconciliation({
      ctx: {
        sessionQuery: { listSessions: async () => [/* 确实没有 session-gone */{ header: { id: 'session-other' } }] },
        workspaceRegistry: { archivedSessionIds: [] },
      },
      statePath,
    });
    assert.deepEqual(result.removed, ['session-gone'], '权威列表确认不存在时应清理');
    assert.equal(result.skippedCleanup, false);
    const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(after.sessions['session-gone'], undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
