import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { parseHtoParam, executeHton, executeHtoff, executeHto } from '../lib/commands.mjs';
import { sessionKeyFor } from '../lib/keys.mjs';
import { readState } from '../lib/state.mjs';

// 确定性 fake sidecar（不依赖本机真实 sidecar 8791）
// 2026-10-21 v2：新增 /control/verify —— 开启前的交叉校验端点。
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

// 默认行为：verify 通过（模拟「该会话刚才确实有真实流量」）
const defaultBehavior = (url, body) => {
  if (url === '/sessions') {
    return { status: 200, json: { sessions: [] } };
  }
  if (url === '/control/verify') {
    const req = JSON.parse(body || '{}');
    return { status: 200, json: { ok: true, key: req.key, sessionId: req.sessionId, reasons: [], actualPromptTokens: 1234 } };
  }
  if (url === '/control/on') return { status: 200, json: { ok: true, immediatePing: true, state: {} } };
  if (url === '/control/off') return { status: 200, json: { ok: true } };
  return { status: 404, json: {} };
};

test('Contract-E: parseHtoParam 参数解析', () => {
  const usage = '用法：/HTO <分钟>（1-720），如 /HTO 60';

  assert.deepEqual(parseHtoParam('1'), { valid: true, minutes: 1 });
  assert.deepEqual(parseHtoParam('50'), { valid: true, minutes: 50 });
  assert.deepEqual(parseHtoParam('60'), { valid: true, minutes: 60 });
  assert.deepEqual(parseHtoParam('720'), { valid: true, minutes: 720 });
  assert.deepEqual(parseHtoParam('  60'), { valid: true, minutes: 60 });
  assert.deepEqual(parseHtoParam('   50   '), { valid: true, minutes: 50 });

  assert.deepEqual(parseHtoParam('0'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('721'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('-1'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('1000'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('abc'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('60min'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('50.5'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('50 30'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam(''), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam(null), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam(undefined), { valid: false, error: usage });
});

test('v2 keys: key 只由 sessionId 决定（同一会话恒定、不同会话必不同）', () => {
  const a = sessionKeyFor('session-9b9b963c-ac86-48b3-896e-49f114619ff4');
  const b = sessionKeyFor('session-9b9b963c-ac86-48b3-896e-49f114619ff4');
  const c = sessionKeyFor('session-9a602d4f-3127-4045-814a-efa247c1d6bf');
  assert.equal(a, b, '同一会话的 key 必须恒定（system prompt 变化不影响）');
  assert.notEqual(a, c, '不同会话必须得到不同 key（KI-1 根治）');
  assert.match(a, /^dshsc-[0-9a-f]{16}$/);
  // 与 sidecar 端 makeSessionKey 的一致性（手工核对值，两边算法必须逐字一致）
  assert.equal(a, 'dshsc-972242655c65ef3b');
  assert.throws(() => sessionKeyFor(''), /empty sessionId/);
});

test('Contract-E: /HTON, /HTOFF, /HTO 回执与状态变更', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, defaultBehavior);

  try {
    const sessionId = 'test-duty-session-1';
    const expectedKey = sessionKeyFor(sessionId);

    // 1. /HTON 开启（默认 30min）
    const r1 = await executeHton(sessionId, tmpFile);
    assert.ok(r1.startsWith('💓 心跳已开启（间隔 30min'), r1);
    let state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].intervalMin, 30);
    assert.equal(state.sessions[sessionId].waiting, false);
    assert.equal(state.sessions[sessionId].key, expectedKey, 'key 必须是会话派生值');

    // 2. /HTOFF 关闭
    const r2 = await executeHtoff(sessionId, tmpFile);
    assert.equal(r2, '💓 心跳已关闭');
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, false);

    // 3. /HTO 30 设间隔并开启
    const r3 = await executeHto('30', sessionId, tmpFile);
    assert.ok(r3.startsWith('💓 心跳间隔已设为 30min 并开启'), r3);
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].intervalMin, 30);

    // 4. /HTO 60 触发缓存寿命告警（实测存活 28–45min）
    const r4 = await executeHto('60', sessionId, tmpFile);
    assert.ok(r4.includes('💓 心跳间隔已设为 60min 并开启'), r4);
    assert.ok(r4.includes('⚠️ 间隔≥40min'), r4);
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].intervalMin, 60);

    // 5. /HTO 含空格参数
    const r5 = await executeHto('  45  ', sessionId, tmpFile);
    assert.ok(r5.startsWith('💓 心跳间隔已设为 45min 并开启'), r5);
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].intervalMin, 45);

    // 6. /HTO 错误参数 -> 不变更状态
    const r6 = await executeHto('invalid', sessionId, tmpFile);
    assert.equal(r6, '用法：/HTO <分钟>（1-720），如 /HTO 60');
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].intervalMin, 45);

    // 7. /HTON 沿用现有间隔
    const r7 = await executeHton(sessionId, tmpFile);
    assert.ok(r7.startsWith('💓 心跳已开启（间隔 45min'), r7);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('v2 安全: 校验不通过时拒绝开启，且不写 on:true（不假装 ACTIVE）', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-verify-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, (url, body) => {
    if (url === '/control/verify') {
      const req = JSON.parse(body || '{}');
      return {
        status: 200,
        json: { ok: false, reasons: ['no-request-recorded'], key: req.key, sessionId: req.sessionId },
      };
    }
    if (url === '/control/on') return { status: 200, json: { ok: true } };
    if (url === '/control/off') return { status: 200, json: { ok: true } };
    return { status: 200, json: { sessions: [] } };
  });

  try {
    const sessionId = 'test-verify-fail';
    const r = await executeHton(sessionId, tmpFile);
    assert.ok(r.startsWith('⛔ 保温对象校验未通过'), r);
    assert.ok(r.includes('no-request-recorded'), r);
    const state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, false, '校验失败绝不能置 on:true');
    assert.equal(state.sessions[sessionId].waiting, false);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('v2 安全: 会话 id 不匹配时拒绝开启（10-21 事故的回归防护）', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-mismatch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const target = 'session-9b9b963c-ac86-48b3-896e-49f114619ff4';
  await startFakeSidecar(t, (url, body) => {
    if (url === '/control/verify') {
      const req = JSON.parse(body || '{}');
      return {
        status: 200,
        json: {
          ok: false,
          reasons: ['session-id-mismatch', 'prompt-size-mismatch'],
          bodySessionId: 'session-other-xxxx',
          actualPromptTokens: 90,
          expectedPromptTokens: 531574,
          key: req.key,
          sessionId: req.sessionId,
        },
      };
    }
    if (url === '/control/on') return { status: 200, json: { ok: true } };
    return { status: 200, json: { sessions: [] } };
  });

  try {
    const r = await executeHton(target, tmpFile, { expectedPromptTokens: 531574 });
    assert.ok(r.includes('⛔'), r);
    assert.ok(r.includes('session-other-xxxx'), '回执必须点名真实绑定的会话，便于排查: ' + r);
    assert.ok(r.includes('531574'), '回执必须给出期望/实际前缀规模对比: ' + r);
    const state = readState(tmpFile);
    assert.equal(state.sessions[target].on, false);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('第八章: sidecar 不可达 -> 诚实回执，不假装开启', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-down-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.SIDECAR_PORT = '19999'; // 未监听端口
  t.after(() => delete process.env.SIDECAR_PORT);

  try {
    const sessionId = 'test-duty-down';
    const r1 = await executeHton(sessionId, tmpFile);
    // verify 拿不到响应 -> 拒绝开启（v2 的有意收紧：无法校验就不保温）
    assert.ok(r1.includes('sidecar 未响应'), r1);
    const state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, false, '无法校验时不得声称已开启');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
