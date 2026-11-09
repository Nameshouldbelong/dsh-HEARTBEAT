import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { apply } from '../lib/index.mjs';
import { updateSessionState } from '../lib/state.mjs';
import { getActiveSessionIds } from '../lib/reconciler.mjs';

async function startFakeSidecar(t) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let r;
      if (req.url === '/sessions') {
        r = { status: 200, json: { sessions: [] } };
      } else if (req.url === '/control/on') {
        r = { status: 200, json: { ok: true, state: {} } };
      } else if (req.url === '/control/off') {
        r = { status: 200, json: { ok: true } };
      } else if (req.url === '/control/state') {
        r = { status: 200, json: { pings: [] } };
      } else {
        r = { status: 404, json: {} };
      }
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
}

function createMockRes() {
  let statusCode = 200;
  let headers = {};
  let body = '';
  return {
    writeHead(code, h) { statusCode = code; headers = h; },
    end(data) { body = data; },
    get result() {
      return { statusCode, headers, json: JSON.parse(body) };
    },
  };
}

test('Visibility ①: 归档会话不出现在 /heartbeat/api/state 输出中', async (t) => {
  const tmpStateFile = path.join(os.tmpdir(), `dsh-vis-test1-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.DSH_HEARTBEAT_STATE_FILE = tmpStateFile;
  await startFakeSidecar(t);

  try {
    updateSessionState(tmpStateFile, 'sess-active', { key: 'dshsc-active', on: true, intervalMin: 50 });
    updateSessionState(tmpStateFile, 'sess-archived', { key: 'dshsc-archived', on: true, intervalMin: 50 });

    let webHandler = null;
    const mockCtx = {
      effect() {},
      webServer: {
        register({ path: routePath, handler }) {
          if (routePath === '/heartbeat') webHandler = handler;
        },
      },
      commands: { register() {} },
      sessionQuery: {
        async listSessions() {
          return [
            { header: { id: 'sess-active' } },
            { header: { id: 'sess-archived' } },
          ];
        },
      },
      workspaceRegistry: {
        archivedSessionIds: ['sess-archived'],
      },
    };

    apply(mockCtx);

    const res = createMockRes();
    await webHandler({ method: 'GET', url: '/heartbeat/api/state' }, res);
    assert.equal(res.result.statusCode, 200);

    const sessionIds = res.result.json.sessions.map((s) => s.sessionId);
    assert.ok(sessionIds.includes('sess-active'), '活跃会话应正常出现');
    assert.ok(!sessionIds.includes('sess-archived'), '已归档会话即便存在于 state.json 也绝不得出现在输出中');
  } finally {
    fs.rmSync(tmpStateFile, { force: true });
    delete process.env.DSH_HEARTBEAT_STATE_FILE;
  }
});

test('Visibility ②: 索引中不存在（已删除）的会话不出现在 /heartbeat/api/state 输出中', async (t) => {
  const tmpStateFile = path.join(os.tmpdir(), `dsh-vis-test2-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.DSH_HEARTBEAT_STATE_FILE = tmpStateFile;
  await startFakeSidecar(t);

  try {
    // 模拟旧 state.json 中残留了已被删除/不存在于 sessionQuery 的历史会话
    updateSessionState(tmpStateFile, 'sess-active', { key: 'dshsc-active', on: true, intervalMin: 50 });
    updateSessionState(tmpStateFile, 'sess-deleted-ghost', { key: 'dshsc-ghost', on: true, intervalMin: 50 });

    let webHandler = null;
    const mockCtx = {
      effect() {},
      webServer: {
        register({ path: routePath, handler }) {
          if (routePath === '/heartbeat') webHandler = handler;
        },
      },
      commands: { register() {} },
      sessionQuery: {
        async listSessions() {
          // sessionQuery 中只有 sess-active，sess-deleted-ghost 已删除
          return [{ header: { id: 'sess-active' } }];
        },
      },
      workspaceRegistry: {
        archivedSessionIds: [],
      },
    };

    apply(mockCtx);

    const res = createMockRes();
    await webHandler({ method: 'GET', url: '/heartbeat/api/state' }, res);
    assert.equal(res.result.statusCode, 200);

    const sessionIds = res.result.json.sessions.map((s) => s.sessionId);
    assert.ok(sessionIds.includes('sess-active'), '活跃会话应正常出现');
    assert.ok(!sessionIds.includes('sess-deleted-ghost'), '索引中不存在（已删除）的会话不得出现在 API 输出中');
  } finally {
    fs.rmSync(tmpStateFile, { force: true });
    delete process.env.DSH_HEARTBEAT_STATE_FILE;
  }
});

test('Visibility ③: 取消归档后再次查询重现（模拟 archivedSessionIds 动态变化与动态挂载）', async (t) => {
  const tmpStateFile = path.join(os.tmpdir(), `dsh-vis-test3-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.DSH_HEARTBEAT_STATE_FILE = tmpStateFile;
  await startFakeSidecar(t);

  try {
    updateSessionState(tmpStateFile, 'sess-dynamic', { key: 'dshsc-dyn', on: true, intervalMin: 45 });

    let webHandler = null;
    const archivedList = ['sess-dynamic'];
    const mockCtx = {
      effect() {},
      webServer: {
        register({ path: routePath, handler }) {
          if (routePath === '/heartbeat') webHandler = handler;
        },
      },
      commands: { register() {} },
      sessionQuery: {
        async listSessions() {
          return [
            { header: { id: 'sess-static' } },
            { header: { id: 'sess-dynamic' } },
          ];
        },
      },
      workspaceRegistry: {
        // 动态引用
        get archivedSessionIds() {
          return archivedList;
        },
      },
    };

    apply(mockCtx);

    // 第一次轮询：sess-dynamic 处于归档状态，不应出现
    const res1 = createMockRes();
    await webHandler({ method: 'GET', url: '/heartbeat/api/state' }, res1);
    const ids1 = res1.result.json.sessions.map((s) => s.sessionId);
    assert.ok(ids1.includes('sess-static'));
    assert.ok(!ids1.includes('sess-dynamic'), '初始处于归档状态，不应出现');

    // 模拟用户在 DSH GUI 中取消归档（动态解除归档）
    archivedList.length = 0;

    // 第二次轮询（无需重启服务，客户端下次请求重算）
    const res2 = createMockRes();
    await webHandler({ method: 'GET', url: '/heartbeat/api/state' }, res2);
    const ids2 = res2.result.json.sessions.map((s) => s.sessionId);
    assert.ok(ids2.includes('sess-static'));
    assert.ok(ids2.includes('sess-dynamic'), '取消归档后应在下一次查询中自动重现（动态挂载）');

    const dynamicSession = res2.result.json.sessions.find((s) => s.sessionId === 'sess-dynamic');
    assert.ok(dynamicSession, '取消归档后会话必须重现于列表中');
    assert.equal(dynamicSession.sessionId, 'sess-dynamic');
    assert.equal(dynamicSession.on, false, '取消归档重新挂载后默认为待开启状态（on: false）');
  } finally {
    fs.rmSync(tmpStateFile, { force: true });
    delete process.env.DSH_HEARTBEAT_STATE_FILE;
  }
});

test('Visibility ④: 孤儿 subagent 会话的处理符合探索结论（排除 origin=subagent 且父会话不存在或已归档）', async (t) => {
  const tmpStateFile = path.join(os.tmpdir(), `dsh-vis-test4-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.DSH_HEARTBEAT_STATE_FILE = tmpStateFile;
  await startFakeSidecar(t);

  try {
    let webHandler = null;
    const mockCtx = {
      effect() {},
      webServer: {
        register({ path: routePath, handler }) {
          if (routePath === '/heartbeat') webHandler = handler;
        },
      },
      commands: { register() {} },
      sessionQuery: {
        async listSessions() {
          return [
            // 正常活跃根会话
            { header: { id: 'root-active-1' } },
            // 孤儿 subagent 1：父会话完全不存在
            { header: { id: 'subagent-orphan-dead-parent', origin: 'subagent', parentSession: 'nonexistent-parent' } },
            // 孤儿 subagent 2：无 parentSession 字段
            { header: { id: 'subagent-orphan-no-parent', origin: 'subagent' } },
            // 孤儿 subagent 3：父会话已被归档
            { header: { id: 'root-archived', origin: undefined } },
            { header: { id: 'subagent-orphan-archived-parent', origin: 'subagent', parentSession: 'root-archived' } },
            // 子代理（父会话处于活跃状态）
            { header: { id: 'subagent-with-active-parent', origin: 'subagent', parentSession: 'root-active-1' } },
          ];
        },
      },
      workspaceRegistry: {
        archivedSessionIds: ['root-archived'],
      },
    };

    apply(mockCtx);

    // 1. 验证 getActiveSessionIds 直接输出
    const activeIds = await getActiveSessionIds(mockCtx);
    assert.ok(activeIds.has('root-active-1'), '正常活跃会话应包含');
    assert.ok(!activeIds.has('root-archived'), '已归档父会话应排除');
    assert.ok(!activeIds.has('subagent-orphan-dead-parent'), '孤儿 subagent 1（父会话不存在）应排除');
    assert.ok(!activeIds.has('subagent-orphan-no-parent'), '孤儿 subagent 2（无 parent）应排除');
    assert.ok(!activeIds.has('subagent-orphan-archived-parent'), '孤儿 subagent 3（父会话已归档）应排除');
    assert.ok(activeIds.has('subagent-with-active-parent'), '父会话活跃的 subagent 会话予以保留');

    // 2. 验证 GET /heartbeat/api/state 接口输出
    const res = createMockRes();
    await webHandler({ method: 'GET', url: '/heartbeat/api/state' }, res);
    assert.equal(res.result.statusCode, 200);

    const sessionIds = res.result.json.sessions.map((s) => s.sessionId);
    assert.ok(sessionIds.includes('root-active-1'));
    assert.ok(!sessionIds.includes('root-archived'));
    assert.ok(!sessionIds.includes('subagent-orphan-dead-parent'));
    assert.ok(!sessionIds.includes('subagent-orphan-no-parent'));
    assert.ok(!sessionIds.includes('subagent-orphan-archived-parent'));
    assert.ok(sessionIds.includes('subagent-with-active-parent'));
  } finally {
    fs.rmSync(tmpStateFile, { force: true });
    delete process.env.DSH_HEARTBEAT_STATE_FILE;
  }
});
