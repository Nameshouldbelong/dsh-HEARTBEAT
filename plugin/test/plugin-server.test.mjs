import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { apply, name, inject } from '../lib/index.mjs';
import { readState } from '../lib/state.mjs';
import * as reconciler from '../lib/reconciler.mjs';

// 确定性 fake sidecar（不依赖本机真实 sidecar 8791）
async function startFakeSidecar(t) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let r;
      if (req.url === '/sessions') {
        r = { status: 200, json: { sessions: [{ key: 'dshsc-fake', lastSeenAt: new Date().toISOString(), model: 'k3' }] } };
      } else if (req.url === '/control/on') {
        r = { status: 200, json: { ok: true, immediatePing: true, state: {} } };
      } else if (req.url === '/control/verify') {
        // v2：开启前交叉校验；桩返回 ok 以模拟「该会话确有真实流量」
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        r = { status: 200, json: { ok: true, key: b.key, sessionId: b.sessionId, reasons: [], actualPromptTokens: 1234 } };
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

test('Plugin Server: apply 注册生命周期、Web API 及平台命令', async (t) => {
  const tmpStateFile = path.join(os.tmpdir(), `dsh-plugin-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.DSH_HEARTBEAT_STATE_FILE = tmpStateFile;
  await startFakeSidecar(t);

  // 可变的 canonical title mock（模拟 Rename 后 latest-wins 变化）
  const titleMap = new Map([['test-session-1', 'PRDM2 Analysis']]);

  try {
    let webHandler = null;
    const registeredCommands = new Map();
    const effectDisposers = [];

    const mockCtx = {
      effect(fn) {
        const disposer = fn();
        if (typeof disposer === 'function') effectDisposers.push(disposer);
      },
      // v2：插件订阅 session/event 做标题缓存失效（KI-4 性能 + Rename 即时同步）。
      // 忠实模拟 DSH：Rename 会 append 一条 session/title 事件。
      listeners: {},
      on(evt, fn) {
        (this.listeners[evt] ||= []).push(fn);
        return () => {
          this.listeners[evt] = (this.listeners[evt] || []).filter((f) => f !== fn);
        };
      },
      emit(evt, ...args) {
        for (const fn of this.listeners[evt] || []) fn(...args);
      },
      webServer: {
        register({ kind, path: routePath, handler }) {
          if (routePath === '/heartbeat') {
            webHandler = handler;
          }
        },
      },
      commands: {
        register(cmdDef) {
          registeredCommands.set(cmdDef.name.toLowerCase(), cmdDef);
        },
      },
      sessionQuery: {
        async listSessions() {
          return [{ header: { id: 'test-session-1' } }, { header: { id: 'test-session-2' } }];
        },
        async readTitleSnapshots(sessionIds) {
          return sessionIds.map((id) => {
            const title = titleMap.get(id);
            return title
              ? { sessionId: id, status: 'fulfilled', value: { title: { title } } }
              : { sessionId: id, status: 'fulfilled', value: {} };
          });
        },
      },
      workspaceRegistry: {
        archivedSessionIds: [],
      },
    };

    apply(mockCtx);

    assert.equal(name, 'dsh-heartbeat');
    assert.ok(inject.includes('webServer'));
    assert.ok(inject.includes('commands'));
    assert.ok(typeof webHandler === 'function');
    assert.ok(registeredCommands.has('hton'));
    assert.ok(registeredCommands.has('htoff'));
    assert.ok(registeredCommands.has('hto'));

    // 1. 测试 Web API: GET /heartbeat/api/state
    const mockRes = () => {
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
    };

    const res1 = mockRes();
    await webHandler({ method: 'GET', url: '/heartbeat/api/state' }, res1);
    assert.equal(res1.result.statusCode, 200);
    assert.ok(Array.isArray(res1.result.json.sessions));
    assert.ok(res1.result.json.sessions.some((s) => s.sessionId === 'test-session-1'));

    // Test 7: title 来自 canonical sessionQuery.readTitleSnapshots
    const s1 = res1.result.json.sessions.find((s) => s.sessionId === 'test-session-1');
    assert.equal(s1.title, 'PRDM2 Analysis');

    // Rename 后下一次查询即同步（靠 session/title 事件精确失效缓存，而非纯 TTL）
    titleMap.set('test-session-1', 'PRDM2 TAN Migration');
    mockCtx.emit('session/event', { id: 'test-session-1' }, { type: 'session/title', data: { title: 'PRDM2 TAN Migration' } });
    const res1b = mockRes();
    await webHandler({ method: 'GET', url: '/heartbeat/api/state' }, res1b);
    const s1b = res1b.result.json.sessions.find((s) => s.sessionId === 'test-session-1');
    assert.equal(s1b.title, 'PRDM2 TAN Migration', 'Rename 后应立即同步新名称');

    // Test 8: 无 title projection 的会话 -> title=null（client 显示短 sessionId），
    // 绝不回退扫描首条 user prompt
    const s2 = res1b.result.json.sessions.find((s) => s.sessionId === 'test-session-2');
    assert.equal(s2.title, null);
    assert.equal(typeof reconciler.getSessionLabel, 'undefined', 'getSessionLabel（首条 prompt 取名）必须已删除');

    // 2. 测试 Web API: POST /heartbeat/api/toggle
    const res2 = mockRes();
    const toggleReq = {
      method: 'POST',
      url: '/heartbeat/api/toggle',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ sessionId: 'test-session-1', on: true, intervalMin: 40 }), 'utf8');
      },
    };
    await webHandler(toggleReq, res2);
    assert.equal(res2.result.statusCode, 200);
    assert.equal(res2.result.json.ok, true);
    assert.equal(res2.result.json.session.on, true);
    assert.equal(res2.result.json.session.intervalMin, 40);

    // 3. 测试 Web API: POST /heartbeat/api/interval
    const res3 = mockRes();
    const intervalReq = {
      method: 'POST',
      url: '/heartbeat/api/interval',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ sessionId: 'test-session-1', intervalMin: 60 }), 'utf8');
      },
    };
    await webHandler(intervalReq, res3);
    assert.equal(res3.result.statusCode, 200);
    assert.equal(res3.result.json.session.intervalMin, 60);

    // 4. 测试平台命令: /hton
    const htonCmd = registeredCommands.get('hton');
    const htonRes = await htonCmd.handler({
      agent: { session: { id: 'test-session-1' } },
    });
    assert.equal(htonRes.kind, 'success');
    assert.ok(htonRes.text.startsWith('💓 心跳已开启（间隔 60min'), htonRes.text);

    // 5. 测试平台命令: /hto 30
    const htoCmd = registeredCommands.get('hto');
    const htoRes = await htoCmd.handler({
      rawInput: '30',
      agent: { session: { id: 'test-session-1' } },
    });
    assert.equal(htoRes.kind, 'success');
    assert.ok(htoRes.text.startsWith('💓 心跳间隔已设为 30min 并开启'), htoRes.text);

    // 6. 测试平台命令: /hto 60 (>=60min 触发 1h TTL 告警)
    const hto60Res = await htoCmd.handler({
      rawInput: '60',
      agent: { session: { id: 'test-session-1' } },
    });
    assert.equal(hto60Res.kind, 'success');
    assert.ok(hto60Res.text.includes('💓 心跳间隔已设为 60min 并开启'));
    assert.ok(hto60Res.text.includes('⚠️ 间隔≥40min'), hto60Res.text);

    // 7. 测试平台命令: /hto invalid (非法参数)
    const htoErrRes = await htoCmd.handler({
      rawInput: 'invalid',
      agent: { session: { id: 'test-session-1' } },
    });
    assert.equal(htoErrRes.kind, 'error');
    assert.equal(htoErrRes.text, '用法：/HTO <分钟>（1-720），如 /HTO 60');

    // 8. 测试平台命令: /htoff
    const htoffCmd = registeredCommands.get('htoff');
    const htoffRes = await htoffCmd.handler({
      agent: { session: { id: 'test-session-1' } },
    });
    assert.equal(htoffRes.kind, 'success');
    assert.equal(htoffRes.text, '💓 心跳已关闭');

    // 清理 effect
    for (const d of effectDisposers) d();
  } finally {
    delete process.env.DSH_HEARTBEAT_STATE_FILE;
    fs.rmSync(tmpStateFile, { force: true });
  }
});

test('Test 8b: sessionQuery 缺少 readTitleSnapshots（旧版 DSH）-> title=null 降级', async (t) => {
  const tmpStateFile = path.join(os.tmpdir(), `dsh-plugin-t8-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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
        // 0.1.5-rc.2 形态：只有 listSessions，没有 readTitleSnapshots
        async listSessions() {
          return [{ header: { id: 'legacy-session' } }];
        },
      },
      workspaceRegistry: { archivedSessionIds: [] },
    };

    apply(mockCtx);

    let body = '';
    const res = {
      writeHead() {},
      end(d) { body = d; },
    };
    await webHandler({ method: 'GET', url: '/heartbeat/api/state' }, res);
    const json = JSON.parse(body);
    const s = json.sessions.find((x) => x.sessionId === 'legacy-session');
    assert.ok(s);
    assert.equal(s.title, null, '无 readTitleSnapshots 时 title 降级为 null（显示短 sessionId）');
  } finally {
    delete process.env.DSH_HEARTBEAT_STATE_FILE;
    fs.rmSync(tmpStateFile, { force: true });
  }
});

test('审计§6-b: toggle 的非法间隔必须先被拒绝，且不得顺手把保温开启', async (t) => {
  // 复用文件内已有的 fake sidecar / mock ctx 装配方式（见上方主测试）
  await startFakeSidecar(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-toggle-'));
  const statePath = path.join(dir, 'state.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let webHandler = null;
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') t.after(d); },
    on() {},
    webServer: { register({ path: p, handler }) { if (p === '/heartbeat') webHandler = handler; } },
    commands: { register() {} },
    sessionQuery: {
      async listSessions() { return [{ header: { id: 'test-session-1' } }]; },
      async readTitleSnapshots() { return new Map(); },
    },
  };
  apply(ctx);

  // mockRes 是主测试内的局部函数，这里内联等价实现
  const res = {
    statusCode: 200,
    body: '',
    result: null,
    setHeader() {},
    writeHead(code) { this.statusCode = code; },
    end(b) {
      this.body = b;
      let json = null;
      try { json = JSON.parse(b); } catch {}
      this.result = { statusCode: this.statusCode, json };
      return this;
    },
  };
  await webHandler({
    method: 'POST',
    url: '/heartbeat/api/toggle',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ sessionId: 'test-session-1', on: true, intervalMin: 9999 }), 'utf8');
    },
  }, res);

  assert.ok(res.result, 'handler 应已返回响应');
  assert.equal(res.result.statusCode, 400, '非法间隔必须返回 400');
  const st = readState(statePath);
  assert.notEqual(st.sessions['test-session-1']?.on, true,
    '❗非法间隔被拒时，绝不能因为后续 HTON 而变成开启状态');
});
