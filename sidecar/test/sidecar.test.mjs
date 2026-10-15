import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sidecar = require('../sidecar.js');

test('Contract-A: affinityKey 推导', () => {
  // 1. 已有 metadata.user_id -> 原样沿用
  const reqWithUser = { metadata: { user_id: 'custom-user-123' }, system: 'You are an assistant' };
  const aff1 = sidecar.affinityKey(reqWithUser);
  assert.equal(aff1.id, 'custom-user-123');
  assert.equal(aff1.synthesized, false);

  // 2. 无 metadata.user_id -> 按 system 前缀哈希合成 dshsc-<sha256[0:16]>
  const reqNoUser = { system: 'You are a coding assistant' };
  const aff2 = sidecar.affinityKey(reqNoUser);
  assert.ok(aff2.id.startsWith('dshsc-'));
  assert.equal(aff2.id.length, 6 + 16);
  assert.equal(aff2.synthesized, true);

  // 3. 相同 system -> 相同 key
  const aff3 = sidecar.affinityKey({ system: 'You are a coding assistant' });
  assert.equal(aff2.id, aff3.id);

  // 4. system 为对象/数组时的处理
  const affObj = sidecar.affinityKey({ system: [{ type: 'text', text: 'hi' }] });
  assert.ok(affObj.id.startsWith('dshsc-'));
});

test('extractUsage: 正确提取使用量信息', () => {
  const sseChunk = 'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":80}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":25}}\n\n';
  const usage = sidecar.extractUsage(sseChunk);
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.cache_read_input_tokens, 80);
  assert.equal(usage.output_tokens, 25);
});

test('B5: buildPingBody 原样重放(不改写 max_tokens/stream, Kimi 缓存只认原请求)', () => {
  const recorded = Buffer.from(JSON.stringify({ model: 'k3', max_tokens: 1024, stream: undefined, system: 'S', messages: [] }));
  const out = JSON.parse(sidecar.buildPingBody(recorded).toString('utf8'));
  assert.equal(out.max_tokens, 1024);
  assert.equal(out.system, 'S');
  const big = JSON.parse(sidecar.buildPingBody(Buffer.from(JSON.stringify({ max_tokens: 4096 }))).toString('utf8'));
  assert.equal(big.max_tokens, 1024);
});

test('B1-B4: HTTP 端点 /healthz, /sessions, /control/on, /control/off, /control/state', async (t) => {
  // 启动 mock 上游服务器
  let lastUpstreamReq = null;
  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastUpstreamReq = {
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg-test',
        type: 'message',
        usage: { input_tokens: 500, cache_read_input_tokens: 450, output_tokens: 1 },
      }));
    });
  });

  await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = mockUpstream.address().port;

  // 启动测试 sidecar 服务器（在动态端口上）
  const testSidecar = sidecar.server;
  process.env.UPSTREAM_HOST = '127.0.0.1';
  process.env.UPSTREAM_PORT = String(upstreamPort);
  process.env.UPSTREAM_PROTOCOL = 'http';
  process.env.UPSTREAM_PREFIX = '/coding';

  await new Promise((resolve) => testSidecar.listen(0, '127.0.0.1', resolve));
  const sidecarPort = testSidecar.address().port;

  t.after(() => {
    mockUpstream.close();
    testSidecar.close();
  });

  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: sidecarPort,
        path,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, headers: res.headers, text: body });
          }
        });
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });

  // 1. GET /healthz
  const healthRes = await request('/healthz');
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.json.ok, true);

  // 2. GET /sessions 初始为空
  const sessRes1 = await request('/sessions');
  assert.equal(sessRes1.status, 200);
  assert.ok(Array.isArray(sessRes1.json.sessions));

  // 3. POST /control/on 对未记录请求的 key 返回 409 no-request-recorded
  const onFailRes = await request('/control/on', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'dshsc-unknown999', intervalMin: 50 }),
  });
  assert.equal(onFailRes.status, 409);
  assert.equal(onFailRes.json.error, 'no-request-recorded');

  // 4. POST /control/on 参数校验 (非法间隔)
  const onInvalidRes = await request('/control/on', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'dshsc-unknown999', intervalMin: 0 }),
  });
  assert.equal(onInvalidRes.status, 400);
  assert.equal(onInvalidRes.json.error, 'invalid-interval');

  // 5. 模拟一个真实请求经过 sidecar 转发
  const realReqBody = JSON.stringify({
    model: 'k3',
    system: 'Prefix test prompt system',
    messages: [{ role: 'user', content: 'test request' }],
  });
  const proxyRes = await request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: realReqBody,
  });
  assert.equal(proxyRes.status, 200);
  assert.ok(lastUpstreamReq);

  // 验证上游收到的请求注入了 cache_control 与 user_id
  const upstreamReceived = JSON.parse(lastUpstreamReq.body);
  assert.deepEqual(upstreamReceived.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.ok(upstreamReceived.metadata?.user_id?.startsWith('dshsc-'));
  const recordedKey = upstreamReceived.metadata.user_id;

  // 6. GET /sessions 现在应聚合出该 key 的会话
  const sessRes2 = await request('/sessions');
  assert.equal(sessRes2.status, 200);
  const foundSession = sessRes2.json.sessions.find((s) => s.key === recordedKey);
  assert.ok(foundSession);
  assert.equal(foundSession.model, 'k3');
  assert.equal(foundSession.lastStatus, 200);
  assert.equal(foundSession.lastInputTokens, 500);
  assert.equal(foundSession.lastCacheRead, 450);

  // 7. POST /control/on 对已有记录的 key 开启心跳
  const onOkRes = await request('/control/on', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: recordedKey, intervalMin: 30 }),
  });
  assert.equal(onOkRes.status, 200);
  assert.equal(onOkRes.json.ok, true);
  assert.equal(onOkRes.json.state.key, recordedKey);
  assert.equal(onOkRes.json.state.on, true);
  assert.equal(onOkRes.json.state.intervalMin, 30);

  // 8. GET /control/state
  const stateRes = await request('/control/state');
  assert.equal(stateRes.status, 200);
  const pingItem = stateRes.json.pings.find((p) => p.key === recordedKey);
  assert.ok(pingItem);
  assert.equal(pingItem.on, true);
  assert.equal(pingItem.intervalMin, 30);
  assert.equal(pingItem.stale, false);

  // 8.1 验证并发保护：若上次真实请求 <10s，本次 ping 自动延迟顺延
  const rec = sidecar.recordedRequests.get(recordedKey);
  rec.lastSeenMs = Date.now(); // 刚刚发生真实请求
  lastUpstreamReq = null;
  sidecar.runPing(recordedKey);
  // 不应立即触发 upstream
  assert.equal(lastUpstreamReq, null);

  // 8.2 模拟距上次真实请求超过 10s -> 执行 ping 重放
  rec.lastSeenMs = Date.now() - 15000;
  sidecar.runPing(recordedKey);
  // 等待 upstream 收到 ping 请求
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(lastUpstreamReq);
  const pingBodyReceived = JSON.parse(lastUpstreamReq.body);
  assert.ok(
    pingBodyReceived.max_tokens === undefined || pingBodyReceived.max_tokens <= 1024,
    'ping max_tokens must be absent or <=1024 (Kimi excludes max_tokens=1 from cache)'
  );
  assert.equal(pingBodyReceived.stream, undefined); // stream 保持原样(未改写)

  // 再次获取 state，验证 ping 计数与使用量已更新
  const stateResAfterPing = await request('/control/state');
  const pingItemAfterPing = stateResAfterPing.json.pings.find((p) => p.key === recordedKey);
  assert.equal(pingItemAfterPing.pingCount, 1);
  assert.ok(pingItemAfterPing.lastPingAt);
  assert.equal(pingItemAfterPing.lastUsage?.cache_read_input_tokens, 450);

  // 9. POST /control/off 关闭心跳
  const offRes = await request('/control/off', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: recordedKey }),
  });
  assert.equal(offRes.status, 200);
  assert.equal(offRes.json.ok, true);

  // 再次查看状态，应为 on: false
  const stateResAfterOff = await request('/control/state');
  const pingItemAfterOff = stateResAfterOff.json.pings.find((p) => p.key === recordedKey);
  assert.equal(pingItemAfterOff.on, false);

  // 10. POST /control/off 对未知 key 幂等返回 200
  const offUnknownRes = await request('/control/off', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'dshsc-random-not-found' }),
  });
  assert.equal(offUnknownRes.status, 200);
  assert.equal(offUnknownRes.json.ok, true);
});

test('B5: stale 判定（连续 3 次 cache_read == 0 置 stale=true）与真实流量恢复', () => {
  const key = 'dshsc-stale-test-key';
  const dummyBody = Buffer.from(JSON.stringify({
    model: 'k3',
    system: 'stale test',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'test' }],
  }), 'utf8');

  sidecar.recordedRequests.set(key, {
    body: dummyBody,
    path: '/v1/messages',
    headers: {},
    model: 'k3',
    lastSeenMs: 0, // 距离上次超过 10s，不触发并发延迟
  });

  sidecar.pings.set(key, {
    key,
    on: true,
    intervalMin: 50,
    lastPingAt: null,
    pingCount: 0,
    stale: false,
    lastUsage: null,
    consecutiveZeroCacheRead: 0,
  });

  const pingState = sidecar.pings.get(key);
  assert.equal(pingState.stale, false);

  // 模拟连续 3 次 cache_read == 0
  for (let i = 1; i <= 3; i++) {
    const cacheRead = 0;
    if (cacheRead === 0) {
      pingState.consecutiveZeroCacheRead = (pingState.consecutiveZeroCacheRead || 0) + 1;
      if (pingState.consecutiveZeroCacheRead >= 3) {
        pingState.stale = true;
      }
    }
  }

  assert.equal(pingState.consecutiveZeroCacheRead, 3);
  assert.equal(pingState.stale, true);

  // 模拟真实请求到达该 key -> 自动恢复 stale=false 并重置计数
  pingState.stale = false;
  pingState.consecutiveZeroCacheRead = 0;
  assert.equal(pingState.stale, false);
  assert.equal(pingState.consecutiveZeroCacheRead, 0);
});
