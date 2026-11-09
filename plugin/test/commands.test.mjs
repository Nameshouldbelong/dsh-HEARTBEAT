import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { parseHtoParam, executeHton, executeHtoff, executeHto } from '../lib/commands.mjs';
import { readState } from '../lib/state.mjs';
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

const defaultBehavior = (url) => {
  if (url === '/sessions') {
    return { status: 200, json: { sessions: [{ key: 'dshsc-cmdtest', lastSeenAt: new Date().toISOString(), model: 'k3' }] } };
  }
  if (url === '/control/verify') {
    return { status: 200, json: { ok: true, actualPromptTokens: 100 } };
  }
  if (url === '/control/on') return { status: 200, json: { ok: true, immediatePing: true, state: {} } };
  if (url === '/control/off') return { status: 200, json: { ok: true } };
  return { status: 404, json: {} };
};

test('Contract-E: parseHtoParam 参数解析', () => {
  const usage = '用法：/HTON [起-止]（分钟，1-720，如 20-30；不带参数默认 20-30）';

  // 1. 默认值与空输入（缺省 20-30）
  assert.deepEqual(parseHtoParam(''), { valid: true, startMin: 20, endMin: 30 });
  assert.deepEqual(parseHtoParam('   '), { valid: true, startMin: 20, endMin: 30 });
  assert.deepEqual(parseHtoParam(null), { valid: true, startMin: 20, endMin: 30 });
  assert.deepEqual(parseHtoParam(undefined), { valid: true, startMin: 20, endMin: 30 });

  // 2. 窗口区间输入（起-止，1-720，s < e）
  assert.deepEqual(parseHtoParam('20-30'), { valid: true, startMin: 20, endMin: 30 });
  assert.deepEqual(parseHtoParam('1-50'), { valid: true, startMin: 1, endMin: 50 });
  assert.deepEqual(parseHtoParam('10-60'), { valid: true, startMin: 10, endMin: 60 });
  assert.deepEqual(parseHtoParam('1-720'), { valid: true, startMin: 1, endMin: 720 });

  // 3. 旧单值兼容输入（11-720，自动映射 [max(1, n-10), n]）
  assert.deepEqual(parseHtoParam('50'), { valid: true, startMin: 40, endMin: 50 });
  assert.deepEqual(parseHtoParam('60'), { valid: true, startMin: 50, endMin: 60 });
  assert.deepEqual(parseHtoParam('720'), { valid: true, startMin: 710, endMin: 720 });
  assert.deepEqual(parseHtoParam('11'), { valid: true, startMin: 1, endMin: 11 });

  // 4. 含空格（前导、后置、多重空格）
  assert.deepEqual(parseHtoParam('  20-30  '), { valid: true, startMin: 20, endMin: 30 });
  assert.deepEqual(parseHtoParam('  60'), { valid: true, startMin: 50, endMin: 60 });
  assert.deepEqual(parseHtoParam('60  '), { valid: true, startMin: 50, endMin: 60 });
  assert.deepEqual(parseHtoParam('   50   '), { valid: true, startMin: 40, endMin: 50 });
  assert.deepEqual(parseHtoParam('  720  '), { valid: true, startMin: 710, endMin: 720 });

  // 5. 越界与非法区间 (0, 721, 负数, 超大数字, 单值 < 11, 起 >= 止)
  assert.deepEqual(parseHtoParam('0'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('1'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('10'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('721'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('-1'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('-50'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('1000'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('30-20'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('20-20'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('0-30'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('10-721'), { valid: false, error: usage });

  // 6. 非数字 / 异常输入
  assert.deepEqual(parseHtoParam('abc'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('60min'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('50.5'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('50 30'), { valid: false, error: usage });
});

test('Contract-E: /HTON, /HTOFF, /HTO 回执与状态变更', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await startFakeSidecar(t, defaultBehavior);

  try {
    const sessionId = 'test-duty-session-1';

    // 1. /HTON 开启（默认 20-30min 窗口），开启即立即执行首次探测
    const r1 = await executeHton(sessionId, tmpFile);
    assert.equal(r1, '💓 心跳已开启（窗口 20-30min，窗口内每 5s 突发至成功，前缀 100 token），已立即执行首次探测');
    let state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].windowStartMin, 20);
    assert.equal(state.sessions[sessionId].windowEndMin, 30);
    assert.equal(state.sessions[sessionId].intervalMin, 30);
    assert.equal(state.sessions[sessionId].waiting, false);

    // 2. /HTOFF 关闭
    const r2 = await executeHtoff(sessionId, tmpFile);
    assert.equal(r2, '💓 心跳已关闭');
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, false);

    // 3. /HTO 30 设窗口并开启 (<40min 无 TTL 告警)
    const r3 = await executeHto('30', sessionId, tmpFile);
    assert.equal(r3, '💓 心跳窗口已设为 20-30min 并开启（窗口内每 5s 突发至成功，前缀 100 token），已立即执行首次探测');
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].windowStartMin, 20);
    assert.equal(state.sessions[sessionId].windowEndMin, 30);

    // 4. /HTO 60 设窗口并开启 (>=40min 触发缓存存活告警)
    const r4 = await executeHto('60', sessionId, tmpFile);
    assert.ok(r4.includes('💓 心跳窗口已设为 50-60min 并开启'));
    assert.ok(r4.includes('⚠️ 窗口右端≥40min：实测缓存存活约 28–45min，可能来不及续期'));
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].windowStartMin, 50);
    assert.equal(state.sessions[sessionId].windowEndMin, 60);

    // 5. /HTO 含空格参数 '  45  '
    const r5 = await executeHto('  45  ', sessionId, tmpFile);
    assert.ok(r5.includes('💓 心跳窗口已设为 35-45min 并开启'));
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].windowStartMin, 35);
    assert.equal(state.sessions[sessionId].windowEndMin, 45);

    // 6. /HTO 错误参数 -> 不变更状态，返回用法提示
    const r6 = await executeHto('invalid', sessionId, tmpFile);
    assert.equal(r6, '用法：/HTON [起-止]（分钟，1-720，如 20-30；不带参数默认 20-30）');
    state = readState(tmpFile);
    // 状态保持上一次的 45
    assert.equal(state.sessions[sessionId].windowEndMin, 45);

    // 7. /HTON 沿用现有窗口（上一步设的 35-45min）
    const r7 = await executeHton(sessionId, tmpFile);
    assert.equal(r7, '💓 心跳已开启（窗口 35-45min，窗口内每 5s 突发至成功，前缀 100 token），已立即执行首次探测');
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
    if (url === '/control/verify') {
      return { status: 200, json: { ok: false, reasons: ['no-request-recorded'] } };
    }
    if (url === '/control/on') return { status: 409, json: { error: 'no-request-recorded', waiting: true } };
    if (url === '/control/off') return { status: 200, json: { ok: true } };
    return { status: 404, json: {} };
  });

  try {
    const sessionId = 'test-duty-waiting';
    const r1 = await executeHton(sessionId, tmpFile);
    assert.ok(r1.includes('已登记等待') && r1.includes('下一次真实请求'), '409 时回执应说明等待真实请求: ' + r1);
    let state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].waiting, true, 'state 应标记 waiting，UI 显示 WAITING FOR REAL REQUEST');

    // /HTO 同样识别 409
    const r2 = await executeHto('50', sessionId, tmpFile);
    assert.ok(r2.includes('已登记等待') && r2.includes('下一次真实请求'), r2);
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].waiting, true);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('第八章: sidecar 不可达 -> 诚实回执，拒绝开启（不假装 ACTIVE）', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-down-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.SIDECAR_PORT = '19999'; // 未监听端口
  t.after(() => delete process.env.SIDECAR_PORT);

  try {
    const sessionId = 'test-duty-down';
    const { updateSessionState } = await import('../lib/state.mjs');
    updateSessionState(tmpFile, sessionId, { key: 'dshsc-down', on: false, intervalMin: 30 });

    const r1 = await executeHton(sessionId, tmpFile);
    assert.ok(r1.includes('sidecar 未响应') && r1.includes('无法校验保温对象；已拒绝开启（不假装 ACTIVE）'), r1);
    const state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, false, 'sidecar 不可达时绝不假装 ACTIVE');
    assert.equal(state.sessions[sessionId].waiting, false);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('KI-3: /HTON 存储 key 漂移（历史脏 key）-> 自动采用确定性派生 key 校验开启', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-ki3-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const sessionId = 'test-duty-drift';
  const derivedKey = sessionKeyFor(sessionId);

  await startFakeSidecar(t, (url, body) => {
    if (url === '/sessions') {
      return { status: 200, json: { sessions: [{ key: derivedKey, lastSeenAt: new Date().toISOString(), model: 'k3' }] } };
    }
    if (url === '/control/verify') {
      const parsed = JSON.parse(body || '{}');
      if (parsed.key === derivedKey) return { status: 200, json: { ok: true, actualPromptTokens: 100 } };
      return { status: 200, json: { ok: false, reasons: ['no-request-recorded'] } };
    }
    if (url === '/control/on') {
      const key = JSON.parse(body || '{}').key;
      if (key === derivedKey) return { status: 200, json: { ok: true, immediatePing: true, state: {} } };
      return { status: 409, json: { error: 'no-request-recorded', waiting: true } };
    }
    if (url === '/control/off') return { status: 200, json: { ok: true } };
    return { status: 404, json: {} };
  });

  try {
    const { updateSessionState } = await import('../lib/state.mjs');
    // 模拟历史脏数据中存下的漂移 key
    updateSessionState(tmpFile, sessionId, { key: 'dshsc-stale', on: false, intervalMin: 30 });

    const r = await executeHton(sessionId, tmpFile);
    assert.equal(r, '💓 心跳已开启（窗口 20-30min，窗口内每 5s 突发至成功，前缀 100 token），已立即执行首次探测');
    const state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].key, derivedKey, 'key 必须由 sessionId 确定性派生，纠正历史脏 key');
    assert.equal(state.sessions[sessionId].waiting, false);
    assert.equal(state.sessions[sessionId].on, true);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('KI-3: /HTON 全新会话无流量 -> 采用派生 key 并保持 waiting 语义', async (t) => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-ki3c-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const sessionId = 'test-duty-brand-new';
  const derivedKey = sessionKeyFor(sessionId);

  await startFakeSidecar(t, (url) => {
    if (url === '/sessions') {
      return { status: 200, json: { sessions: [{ key: derivedKey, lastSeenAt: new Date().toISOString(), model: 'k3' }] } };
    }
    if (url === '/control/verify') {
      return { status: 200, json: { ok: false, reasons: ['no-request-recorded'] } };
    }
    if (url === '/control/on') return { status: 409, json: { error: 'no-request-recorded', waiting: true } };
    if (url === '/control/off') return { status: 200, json: { ok: true } };
    return { status: 404, json: {} };
  });

  try {
    const r = await executeHton(sessionId, tmpFile);
    assert.ok(r.includes('已登记等待') && r.includes('下一次真实请求'), '首次解析的 key 409 应保持 waiting 语义: ' + r);
    const state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].waiting, true);
    assert.equal(state.sessions[sessionId].key, derivedKey);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
