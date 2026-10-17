import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { parseHtoParam, executeHton, executeHtoff, executeHto } from '../lib/commands.mjs';
import { readState } from '../lib/state.mjs';

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

const defaultBehavior = (url) => {
  if (url === '/sessions') {
    return { status: 200, json: { sessions: [{ key: 'dshsc-cmdtest', lastSeenAt: new Date().toISOString(), model: 'k3' }] } };
  }
  if (url === '/control/on') return { status: 200, json: { ok: true, immediatePing: true, state: {} } };
  if (url === '/control/off') return { status: 200, json: { ok: true } };
  return { status: 404, json: {} };
};

test('Contract-E: parseHtoParam 参数解析', () => {
  const usage = '用法：/HTO <分钟>（1-720），如 /HTO 60';

  // 1. 合法整数 (1–720)
  assert.deepEqual(parseHtoParam('1'), { valid: true, minutes: 1 });
  assert.deepEqual(parseHtoParam('50'), { valid: true, minutes: 50 });
  assert.deepEqual(parseHtoParam('60'), { valid: true, minutes: 60 });
  assert.deepEqual(parseHtoParam('720'), { valid: true, minutes: 720 });

  // 2. 含空格（前导、后置、多重空格）
  assert.deepEqual(parseHtoParam('  60'), { valid: true, minutes: 60 });
  assert.deepEqual(parseHtoParam('60  '), { valid: true, minutes: 60 });
  assert.deepEqual(parseHtoParam('   50   '), { valid: true, minutes: 50 });
  assert.deepEqual(parseHtoParam('  720  '), { valid: true, minutes: 720 });

  // 3. 越界 (0, 721, 负数, 超大数字)
  assert.deepEqual(parseHtoParam('0'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('721'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('-1'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('-50'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('1000'), { valid: false, error: usage });

  // 4. 非数字 / 异常输入
  assert.deepEqual(parseHtoParam('abc'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('60min'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('50.5'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('50 30'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam(''), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('   '), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam(null), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam(undefined), { valid: false, error: usage });
});

test('Contract-E: /HTON, /HTOFF, /HTO 回执与状态变更', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, defaultBehavior);

  try {
    const sessionId = 'test-duty-session-1';

    // 1. /HTON 开启（默认 50min），开启即立即执行首次保温
    const r1 = await executeHton(sessionId, tmpFile);
    assert.equal(r1, '💓 心跳已开启（间隔 50min），已立即执行首次保温');
    let state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].intervalMin, 50);
    assert.equal(state.sessions[sessionId].waiting, false);

    // 2. /HTOFF 关闭
    const r2 = await executeHtoff(sessionId, tmpFile);
    assert.equal(r2, '💓 心跳已关闭');
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, false);

    // 3. /HTO 30 设间隔并开启 (<60min 无告警)
    const r3 = await executeHto('30', sessionId, tmpFile);
    assert.equal(r3, '💓 心跳间隔已设为 30min 并开启，已立即执行首次保温');
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].intervalMin, 30);

    // 4. /HTO 60 设间隔并开启 (>=60min 触发 1h TTL 告警)
    const r4 = await executeHto('60', sessionId, tmpFile);
    assert.ok(r4.includes('💓 心跳间隔已设为 60min 并开启'));
    assert.ok(r4.includes('⚠️ 间隔≥60min：1h TTL 缓存会在 ping 间过期'));
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].intervalMin, 60);

    // 5. /HTO 含空格参数 '  45  '
    const r5 = await executeHto('  45  ', sessionId, tmpFile);
    assert.equal(r5, '💓 心跳间隔已设为 45min 并开启，已立即执行首次保温');
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].intervalMin, 45);

    // 6. /HTO 错误参数 -> 不变更状态，返回用法提示
    const r6 = await executeHto('invalid', sessionId, tmpFile);
    assert.equal(r6, '用法：/HTO <分钟>（1-720），如 /HTO 60');
    state = readState(tmpFile);
    // 状态保持上一次的 45
    assert.equal(state.sessions[sessionId].intervalMin, 45);

    // 7. /HTON 沿用现有间隔（45min）
    const r7 = await executeHton(sessionId, tmpFile);
    assert.equal(r7, '💓 心跳已开启（间隔 45min），已立即执行首次保温');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('第八章: sidecar 409 no-request-recorded -> waiting 意图而非假 ACTIVE', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-waiting-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, (url) => {
    if (url === '/sessions') {
      return { status: 200, json: { sessions: [{ key: 'dshsc-waiting', lastSeenAt: new Date().toISOString(), model: 'k3' }] } };
    }
    if (url === '/control/on') return { status: 409, json: { error: 'no-request-recorded', waiting: true } };
    if (url === '/control/off') return { status: 200, json: { ok: true } };
    return { status: 404, json: {} };
  });

  try {
    const sessionId = 'test-duty-waiting';
    const r1 = await executeHton(sessionId, tmpFile);
    assert.ok(r1.includes('心跳意图已记录'), '409 时回执应说明等待真实请求: ' + r1);
    assert.ok(r1.includes('下一次真实请求'));
    let state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].waiting, true, 'state 应标记 waiting，UI 显示 WAITING FOR REAL REQUEST');

    // /HTO 同样识别 409
    const r2 = await executeHto('50', sessionId, tmpFile);
    assert.ok(r2.includes('下一次真实请求'), r2);
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].waiting, true);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('第八章: sidecar 不可达 -> 诚实回执 + 保留开启意图', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-down-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.SIDECAR_PORT = '19999'; // 未监听端口
  t.after(() => delete process.env.SIDECAR_PORT);

  try {
    const sessionId = 'test-duty-down';
    // sidecar 不可达时 /sessions 返回 [] -> resolveSessionKey 依赖 state 里已有 key
    // 先种入 key（模拟此前成功开启过）
    const { updateSessionState } = await import('../lib/state.mjs');
    updateSessionState(tmpFile, sessionId, { key: 'dshsc-down', on: false, intervalMin: 50 });

    const r1 = await executeHton(sessionId, tmpFile);
    assert.ok(r1.includes('sidecar 未响应'), r1);
    const state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true, '开启意图应保留，待 reconciler 补挂');
    assert.equal(state.sessions[sessionId].waiting, false);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('KI-3: /HTON 存储 key 漂移（409）自动轮换到新鲜 key', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-ki3-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, (url, body) => {
    if (url === '/sessions') {
      return { status: 200, json: { sessions: [{ key: 'dshsc-fresh', lastSeenAt: new Date().toISOString(), model: 'k3' }] } };
    }
    if (url === '/control/on') {
      const key = JSON.parse(body || '{}').key;
      if (key === 'dshsc-fresh') return { status: 200, json: { ok: true, immediatePing: true, state: {} } };
      return { status: 409, json: { error: 'no-request-recorded', waiting: true } };
    }
    if (url === '/control/off') return { status: 200, json: { ok: true } };
    return { status: 404, json: {} };
  });

  try {
    const { updateSessionState } = await import('../lib/state.mjs');
    const sessionId = 'test-duty-drift';
    // 模拟漂移前存下的旧 key
    updateSessionState(tmpFile, sessionId, { key: 'dshsc-stale', on: false, intervalMin: 50 });

    const r = await executeHton(sessionId, tmpFile);
    assert.equal(r, '💓 心跳已开启（间隔 50min），已立即执行首次保温', '轮换成功应直接开启而非 waiting');
    const state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].key, 'dshsc-fresh');
    assert.equal(state.sessions[sessionId].waiting, false);
    assert.equal(state.sessions[sessionId].on, true);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('KI-3: /HTON 全新会话无流量（非存储 key）-> 不轮换，保持 waiting 语义', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-ki3c-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, (url) => {
    if (url === '/sessions') {
      return { status: 200, json: { sessions: [{ key: 'dshsc-only', lastSeenAt: new Date().toISOString(), model: 'k3' }] } };
    }
    if (url === '/control/on') return { status: 409, json: { error: 'no-request-recorded', waiting: true } };
    if (url === '/control/off') return { status: 200, json: { ok: true } };
    return { status: 404, json: {} };
  });

  try {
    const sessionId = 'test-duty-brand-new';
    const r = await executeHton(sessionId, tmpFile);
    assert.ok(r.includes('心跳意图已记录'), '首次解析的 key 409 应保持 waiting 语义: ' + r);
    const state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].waiting, true);
    assert.equal(state.sessions[sessionId].key, 'dshsc-only');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
