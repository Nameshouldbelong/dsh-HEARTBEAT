import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { apply, name, inject } from '../lib/index.mjs';
import { readState } from '../lib/state.mjs';

test('Plugin Server: apply 注册生命周期、Web API 及平台命令', async () => {
  const tmpStateFile = path.join(os.tmpdir(), `dsh-plugin-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.DSH_HEARTBEAT_STATE_FILE = tmpStateFile;

  try {
    let webHandler = null;
    const registeredCommands = new Map();
    const effectDisposers = [];

    const mockCtx = {
      effect(fn) {
        const disposer = fn();
        if (typeof disposer === 'function') effectDisposers.push(disposer);
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
    assert.equal(htonRes.text, '💓 心跳已开启（间隔 60min）');

    // 5. 测试平台命令: /hto 30
    const htoCmd = registeredCommands.get('hto');
    const htoRes = await htoCmd.handler({
      rawInput: '30',
      agent: { session: { id: 'test-session-1' } },
    });
    assert.equal(htoRes.kind, 'success');
    assert.equal(htoRes.text, '💓 心跳间隔已设为 30min 并开启');

    // 6. 测试平台命令: /hto 60 (>=60min 触发 1h TTL 告警)
    const hto60Res = await htoCmd.handler({
      rawInput: '60',
      agent: { session: { id: 'test-session-1' } },
    });
    assert.equal(hto60Res.kind, 'success');
    assert.ok(hto60Res.text.includes('💓 心跳间隔已设为 60min 并开启'));
    assert.ok(hto60Res.text.includes('⚠️ 间隔≥60min：1h TTL 缓存会在 ping 间过期'));

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
