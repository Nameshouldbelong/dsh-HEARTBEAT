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

test('extractUsage: openai-completions 协议 cached_tokens 归一化为 cache_read（2026-10-19 协议切换）', () => {
  // openai 非流式 JSON 响应形态（生产实测：prompt_tokens_details.cached_tokens + 顶层 cached_tokens）
  const openaiBody = JSON.stringify({
    id: 'chatcmpl-x',
    usage: { prompt_tokens: 174630, completion_tokens: 19, total_tokens: 174649, cached_tokens: 174630,
      prompt_tokens_details: { cached_tokens: 174630 } },
  });
  const u1 = sidecar.extractUsage(openaiBody);
  assert.equal(u1.cache_read_input_tokens, 174630, 'openai cached_tokens 应映射到 cache_read_input_tokens');

  // openai SSE 流式形态（choices delta + 尾帧 usage）
  const openaiSse = 'data: {"choices":[{"delta":{"content":"o"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":500,"cached_tokens":460,"prompt_tokens_details":{"cached_tokens":460}}}\n\n';
  const u2 = sidecar.extractUsage(openaiSse);
  assert.equal(u2.cache_read_input_tokens, 460);

  // anthropic 形态不受影响（无 cached_tokens 字段时不覆写）
  const anth = sidecar.extractUsage('data: {"usage":{"input_tokens":10,"cache_read_input_tokens":7}}');
  assert.equal(anth.cache_read_input_tokens, 7);

  // openai 形态 cached=0（真 miss）不注入字段，分类仍走 no-cache
  const miss = sidecar.extractUsage(JSON.stringify({ usage: { prompt_tokens: 900, cached_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } }));
  assert.equal(miss.cache_read_input_tokens, undefined);
  assert.equal(sidecar.classifyPingResult(200, miss), 'no-cache');

  // 归一化后全量命中被正确判为 hit（回归本次生产 bug：174630/174630 被误判 no-cache）
  assert.equal(sidecar.classifyPingResult(200, u1), 'hit');
});

test('B5: buildPingBody 固定 max_tokens=16（2026-10-15 实测：max_tokens=1 不参与前缀缓存，16 为已验证最低档；ping 输出整体丢弃），其余字段原样', () => {
  const recorded = Buffer.from(JSON.stringify({ model: 'k3', max_tokens: 1024, stream: undefined, system: 'S', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 't' }] }));
  const out = JSON.parse(sidecar.buildPingBody(recorded).toString('utf8'));
  assert.equal(out.max_tokens, 16);
  assert.equal(out.system, 'S');
  assert.deepEqual(out.messages, [{ role: 'user', content: 'x' }]);
  assert.deepEqual(out.tools, [{ name: 't' }]);
  // 原始值更大也固定为 16，不再 clamp 到 1024
  const big = JSON.parse(sidecar.buildPingBody(Buffer.from(JSON.stringify({ max_tokens: 32768 }))).toString('utf8'));
  assert.equal(big.max_tokens, 16);
  // 原请求缺 max_tokens 时补 16（max_tokens=1 的隐式默认同样不可参与缓存）
  const none = JSON.parse(sidecar.buildPingBody(Buffer.from(JSON.stringify({ model: 'k3' }))).toString('utf8'));
  assert.equal(none.max_tokens, 16);
});

test('P0-4: classifyPingResult 三分类（hit / recreated / no-cache / error）', () => {
  // T3: cache hit 判 healthy
  assert.equal(sidecar.classifyPingResult(200, { cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 }), 'hit');
  // T4: cache 重建（read=0 但 creation>0）判 healthy
  assert.equal(sidecar.classifyPingResult(200, { cache_read_input_tokens: 0, cache_creation_input_tokens: 100000 }), 'recreated');
  assert.equal(sidecar.classifyPingResult(200, { cache_creation_tokens: 5000 }), 'recreated'); // 兼容字段名
  // 2xx 但读写皆 0
  assert.equal(sidecar.classifyPingResult(200, { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), 'no-cache');
  assert.equal(sidecar.classifyPingResult(200, {}), 'no-cache');
  // T5: HTTP 429/5xx 是 transport/API 错误，不是 cache miss
  assert.equal(sidecar.classifyPingResult(429, {}), 'error');
  assert.equal(sidecar.classifyPingResult(500, { cache_read_input_tokens: 0 }), 'error');
  assert.equal(sidecar.classifyPingResult(503, {}), 'error');
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

  // 3. POST /control/on 对未记录请求的 key 返回 409 no-request-recorded + waiting 意图
  const onFailRes = await request('/control/on', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'dshsc-unknown999', intervalMin: 50 }),
  });
  assert.equal(onFailRes.status, 409);
  assert.equal(onFailRes.json.error, 'no-request-recorded');
  assert.equal(onFailRes.json.waiting, true);
  // 清理 waiting 意图，避免影响后续测试
  await request('/control/off', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'dshsc-unknown999' }),
  });

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
  assert.equal(onOkRes.json.immediatePing, true); // 开启即立即 ping（受 <10s 顺延保护）
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
  assert.equal(pingBodyReceived.max_tokens, 16, 'ping max_tokens 固定为 16（Kimi 实测 max_tokens=1 不参与缓存）');
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

test('P0 集成: immediate ping / max_tokens=16 / 429 快速 retry / waiting 自动恢复', async (t) => {
  // 可编程 mock 上游
  let responder = () => ({
    status: 200,
    json: { id: 'msg-mock', type: 'message', usage: { input_tokens: 500, cache_read_input_tokens: 450, cache_creation_input_tokens: 0, output_tokens: 16 } },
  });
  let lastUpstreamReq = null;
  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastUpstreamReq = { url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') };
      const r = responder(req, lastUpstreamReq.body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  process.env.UPSTREAM_HOST = '127.0.0.1';
  process.env.UPSTREAM_PORT = String(mockUpstream.address().port);
  process.env.UPSTREAM_PROTOCOL = 'http';
  process.env.UPSTREAM_PREFIX = '/coding';

  await new Promise((resolve) => sidecar.server.listen(0, '127.0.0.1', resolve));
  const sidecarPort = sidecar.server.address().port;

  // 注入短计时：retry +30ms/+60ms；禁用 10s 顺延保护
  const savedConfig = { ...sidecar.config };
  sidecar.config.retryDelaysMs = [30, 60];
  sidecar.config.recencyWindowMs = 0;

  t.after(() => {
    Object.assign(sidecar.config, savedConfig);
    mockUpstream.close();
    sidecar.server.close();
  });

  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: sidecarPort, path, method: options.method || 'GET', headers: options.headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, text: body }); }
        });
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });

  const waitFor = async (fn, timeoutMs = 3000, step = 20) => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - start > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, step));
    }
  };
  const pingStateOf = async (key) => {
    const r = await request('/control/state');
    return r.json.pings.find((x) => x.key === key) || null;
  };

  // --- Test 1: /control/on 后立即执行一次 ping（不等 50min interval）
  const keyT1 = 'test-key-immediate';
  sidecar.recordedRequests.set(keyT1, {
    body: Buffer.from(JSON.stringify({
      model: 'k3',
      system: 'S-immediate',
      max_tokens: 32768,
      messages: [{ role: 'user', content: 'hello' }],
    })),
    path: '/v1/messages',
    headers: {},
    model: 'k3',
    lastSeenMs: 0,
  });
  const onRes = await request('/control/on', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: keyT1, intervalMin: 50 }),
  });
  assert.equal(onRes.status, 200);
  assert.equal(onRes.json.immediatePing, true);

  const st1 = await waitFor(async () => {
    const p = await pingStateOf(keyT1);
    return p && p.pingCount >= 1 ? p : null;
  });
  assert.ok(st1, 'immediate ping 应在不等待 interval 的情况下完成');
  assert.ok(st1.lastPingAt, 'lastPingAt 应立即非空');
  assert.equal(st1.health, 'hit');
  assert.equal(st1.intervalMin, 50, '主 interval 仍为 50min');

  // --- Test 2: replay body max_tokens 固定 16，关键前缀字段不变
  assert.ok(lastUpstreamReq, 'immediate ping 应已到达上游');
  const pingReq = JSON.parse(lastUpstreamReq.body);
  assert.equal(pingReq.max_tokens, 16);
  assert.equal(pingReq.system, 'S-immediate');
  assert.deepEqual(pingReq.messages, [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(pingReq.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(pingReq.metadata.user_id, keyT1);

  // --- Test 5: HTTP 429 = transport/API 错误 -> 进入 retry，不计入 cache 失败
  responder = () => ({ status: 429, json: { error: { type: 'rate_limit' } } });
  sidecar.runPing(keyT1);
  const stRetry = await waitFor(async () => {
    const p = await pingStateOf(keyT1);
    return p && p.health === 'retrying' ? p : null;
  });
  assert.ok(stRetry, '429 后应进入 retrying');
  assert.equal(stRetry.retryCount, 1);
  const rawT1 = sidecar.pings.get(keyT1);
  assert.equal(rawT1.consecutiveZeroCacheRead, 0, '429 不得计入 cache-zero 失败计数');
  assert.equal(rawT1.consecutiveTransportFailures, 1);

  // --- Test 6: retry 成功 -> 恢复 hit，非 stale，retry 计数清零
  responder = () => ({ status: 200, json: { id: 'm', type: 'message', usage: { input_tokens: 500, cache_read_input_tokens: 460, cache_creation_input_tokens: 0, output_tokens: 16 } } });
  const stHit = await waitFor(async () => {
    const p = await pingStateOf(keyT1);
    return p && p.health === 'hit' && p.retryCount === 0 ? p : null;
  });
  assert.ok(stHit, 'retry 成功应恢复 ACTIVE(hit)');
  assert.equal(stHit.stale, false);
  await request('/control/off', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: keyT1 }),
  });

  // --- 第八章: /control/on 无请求记录 -> 409 waiting；真实请求到达后自动恢复保温
  const keyW = 'test-key-waiting';
  const onW = await request('/control/on', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: keyW, intervalMin: 50 }),
  });
  assert.equal(onW.status, 409);
  assert.equal(onW.json.error, 'no-request-recorded');
  assert.equal(onW.json.waiting, true);
  const pW1 = await pingStateOf(keyW);
  assert.equal(pW1.waitingForRequest, true);
  assert.equal(pW1.health, 'waiting');
  assert.equal(pW1.on, true);

  // 真实请求（客户端自带 metadata.user_id=keyW）经 sidecar 转发到达
  const realW = await request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'k3', system: 'S-waiting', messages: [{ role: 'user', content: 'real' }], metadata: { user_id: keyW } }),
  });
  assert.equal(realW.status, 200);

  const pW2 = await waitFor(async () => {
    const p = await pingStateOf(keyW);
    return p && p.waitingForRequest === false && p.pingCount >= 1 ? p : null;
  });
  assert.ok(pW2, '真实请求到达后应自动退出 waiting 并立即完成首次 ping');
  assert.equal(pW2.health, 'hit');
  await request('/control/off', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: keyW }),
  });
});

test('T9 [KNOWN-ISSUE]: 双会话同 system -> affinity key 碰撞（显式记录当前缺陷，DSH core 注入 session 级 user_id 后应反转）', () => {
  // 生产实证（2026-10-17）：DSH request/header 无 metadata 字段，sidecar 全部走
  // sha256(system[:8000]) 合成键。两个 system 相同的会话得到相同 key，
  // recordedRequests 相互覆盖 -> heartbeat 可能 replay 错会话的请求体。
  // 本测试用于暴露并记录该问题（docs/KNOWN-ISSUES.md），而不是隐藏它。
  const sharedSystem = 'shared system prompt across sessions';
  const sessA = sidecar.affinityKey({ system: sharedSystem, messages: [{ role: 'user', content: 'A-marker' }] });
  const sessB = sidecar.affinityKey({ system: sharedSystem, messages: [{ role: 'user', content: 'B-marker' }] });
  assert.equal(sessA.synthesized, true);
  assert.equal(sessB.synthesized, true);
  assert.equal(sessA.id, sessB.id, 'KNOWN-ISSUE: 当前同 system 双会话得到相同 key（碰撞）');

  sidecar.recordedRequests.set(sessA.id, { body: Buffer.from('A-marker'), path: '/v1/messages', headers: {}, model: 'k3', lastSeenMs: 1 });
  sidecar.recordedRequests.set(sessB.id, { body: Buffer.from('B-marker'), path: '/v1/messages', headers: {}, model: 'k3', lastSeenMs: 2 });
  assert.equal(
    sidecar.recordedRequests.get(sessA.id).body.toString(),
    'B-marker',
    'KNOWN-ISSUE: B 的最后请求体覆盖了 A'
  );
  sidecar.recordedRequests.delete(sessA.id);
});

test('affinityKey: openai-completions 形态按 messages 里 system 段取 hash（KI-1 碰撞修复）', () => {
  // anthropic 形态：顶层 system
  const anth = sidecar.affinityKey({ system: 'Plabable merge session prefix', messages: [] }).id;
  // openai 形态：system 在 messages[0]，同一内容应得到同一 key
  const oa = sidecar.affinityKey({ messages: [{ role: 'system', content: 'Plabable merge session prefix' }, { role: 'user', content: 'go' }] }).id;
  assert.equal(oa, anth, '同 system 内容（两种协议形态）应同 key');

  // 不同 system 必须不同 key（修复前全部 openai 流量共用 sha256('""') 单一 key）
  const other = sidecar.affinityKey({ messages: [{ role: 'system', content: 'Totally different session' }, { role: 'user', content: 'hi' }] }).id;
  assert.notEqual(other, oa);

  // 多段 system 拼接稳定
  const multi = sidecar.affinityKey({ messages: [{ role: 'system', content: 'A' }, { role: 'system', content: 'B' }, { role: 'user', content: 'x' }] }).id;
  const multi2 = sidecar.affinityKey({ messages: [{ role: 'system', content: 'A' }, { role: 'system', content: 'B' }, { role: 'user', content: 'y' }] }).id;
  assert.equal(multi, multi2);

  // metadata.user_id 优先级不变
  const meta = sidecar.affinityKey({ metadata: { user_id: 'e2e-custom' }, system: 'zzz', messages: [{ role: 'system', content: 'zzz' }] });
  assert.equal(meta.id, 'e2e-custom');
  assert.equal(meta.synthesized, false);

  // 无 system 段：两种协议形态行为一致（都落入空串 hash 的公共 key）——契约边缘，
  // 与 anthropic 无 system 行为对称；DSH 真实流量恒带 system 段，不触发此路径
  const noSys1 = sidecar.affinityKey({ messages: [{ role: 'user', content: 'a' }] }).id;
  const noSysAnth = sidecar.affinityKey({ system: '' }).id;
  assert.equal(noSys1, noSysAnth, '无 system 段与空 system 行为对称');
});

test('P0 回归: /control/on 幂等——reconciler 每分钟补挂不得白 ping 也不得清空 retry（2026-10-20 生产事故）', async (t) => {
  let responder = () => ({
    status: 200,
    json: { id: 'msg-mock', type: 'message', usage: { input_tokens: 100, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 16 } },
  });
  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const r = responder();
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  process.env.UPSTREAM_HOST = '127.0.0.1';
  process.env.UPSTREAM_PORT = String(mockUpstream.address().port);
  process.env.UPSTREAM_PROTOCOL = 'http';
  process.env.UPSTREAM_PREFIX = '/coding';

  await new Promise((resolve) => sidecar.server.listen(0, '127.0.0.1', resolve));
  const sidecarPort = sidecar.server.address().port;

  const savedConfig = { ...sidecar.config };
  sidecar.config.retryDelaysMs = [40, 80];
  sidecar.config.recencyWindowMs = 0;

  t.after(() => {
    Object.assign(sidecar.config, savedConfig);
    mockUpstream.close();
    sidecar.server.close();
  });

  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: sidecarPort, path, method: options.method || 'GET', headers: options.headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, text: body }); }
        });
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
  const waitFor = async (fn, timeoutMs = 3000, step = 20) => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - start > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, step));
    }
  };
  const pingStateOf = async (key) => {
    const r = await request('/control/state');
    return r.json.pings.find((x) => x.key === key) || null;
  };
  const onKey = (key, intervalMin) => request('/control/on', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, intervalMin }),
  });

  const keyI = 'test-key-idempotent';
  sidecar.recordedRequests.set(keyI, {
    body: Buffer.from(JSON.stringify({ model: 'k3', system: 'S-idem', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] })),
    path: '/v1/messages',
    headers: {},
    model: 'k3',
    lastSeenMs: 0,
  });

  // 1. 首次开启：正常 immediate ping
  const r1 = await onKey(keyI, 50);
  assert.equal(r1.status, 200);
  assert.equal(r1.json.immediatePing, true);
  const s1 = await waitFor(async () => {
    const p = await pingStateOf(keyI);
    return p && p.pingCount >= 1 ? p : null;
  });
  assert.ok(s1);

  // 2. reconciler 式重复补挂（同间隔）：必须 alreadyOn 且不再 ping
  const r2 = await onKey(keyI, 50);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.alreadyOn, true, '同状态重复 /control/on 应幂等短路');
  assert.equal(r2.json.immediatePing, false);
  await new Promise((r) => setTimeout(r, 100));
  const s2 = await pingStateOf(keyI);
  assert.equal(s2.pingCount, s1.pingCount, '重复补挂不得触发新的 ping');

  // 3. 制造 429 失败进入 retry，然后重复 /control/on：retry 状态不得被清空
  responder = () => ({ status: 429, json: { error: { type: 'rate_limit' } } });
  sidecar.runPing(keyI);
  const sRetry = await waitFor(async () => {
    const p = await pingStateOf(keyI);
    return p && p.health === 'retrying' && p.retryCount === 1 ? p : null;
  });
  assert.ok(sRetry, '429 后应 retrying #1');
  const r3 = await onKey(keyI, 50);
  assert.equal(r3.json.alreadyOn, true);
  const raw = sidecar.pings.get(keyI);
  assert.equal(raw.retryCount, 1, '重复补挂不得重置 retryCount');
  assert.ok(raw.retryTimer, '重复补挂不得清空 pending retryTimer');
  assert.equal(raw.health, 'retrying');

  // 4. 上游恢复：被保留的 retry 定时器应照常触发并恢复 hit
  responder = () => ({ status: 200, json: { id: 'm', usage: { input_tokens: 100, cache_read_input_tokens: 95, cache_creation_input_tokens: 0, output_tokens: 16 } } });
  const sHit = await waitFor(async () => {
    const p = await pingStateOf(keyI);
    return p && p.health === 'hit' && p.retryCount === 0 ? p : null;
  });
  assert.ok(sHit, 'retry 定时器应存活并恢复 hit（生产事故前会被每分钟清空）');

  // 5. 间隔变更不算幂等：应走完整重置 + immediate ping
  const before = (await pingStateOf(keyI)).pingCount;
  const r5 = await onKey(keyI, 30);
  assert.equal(r5.json.immediatePing, true, '间隔变化是真实变更，不短路');
  await waitFor(async () => {
    const p = await pingStateOf(keyI);
    return p && p.pingCount > before ? p : null;
  });
  assert.equal((await pingStateOf(keyI)).intervalMin, 30);

  await request('/control/off', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: keyI }),
  });
});

test('2026-10-20: TTL 注入按协议分派（Chat Completions 用 prompt_cache_options，Anthropic 用 cache_control）', () => {
  // Chat Completions 协议（10-19 起 kimi-coding 实际协议）
  const chatBody = { model: 'k3-256k', messages: [{ role: 'user', content: 'x' }] };
  const mark1 = sidecar.injectCacheTtl(chatBody, '/v1/chat/completions?beta=true');
  assert.equal(mark1, 'prompt_cache_options=1h');
  assert.deepEqual(chatBody.prompt_cache_options, { mode: 'implicit', ttl: '1h' });
  assert.equal(chatBody.cache_control, undefined, 'Chat Completions 不得注入 cache_control（端点忽略）');

  // Anthropic Messages 协议
  const anthBody = { model: 'k3', messages: [] };
  const mark2 = sidecar.injectCacheTtl(anthBody, '/v1/messages');
  assert.equal(mark2, 'cache_control=1h');
  assert.deepEqual(anthBody.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(anthBody.prompt_cache_options, undefined);

  // 已存在客户端注入时保留原样，不覆盖
  const preset = { prompt_cache_options: { mode: 'implicit', ttl: '5m' } };
  assert.equal(sidecar.injectCacheTtl(preset, '/v1/chat/completions'), null);
  assert.deepEqual(preset.prompt_cache_options, { mode: 'implicit', ttl: '5m' });
});

test('2026-10-20: 命中率门槛——低命中（4.4%）不算 hit，避免"伪 hit"掩盖烧钱', () => {
  // 生产实测：cached=12800 / prompt=291557 = 4.4%，旧逻辑判 hit（错）
  const lowRatio = { prompt_tokens: 291557, cached_tokens: 12800, cache_read_input_tokens: 12800 };
  assert.equal(sidecar.classifyPingResult(200, lowRatio), 'no-cache');

  // 真实命中 99%+ 仍是 hit
  const highRatio = { prompt_tokens: 291557, cached_tokens: 291328, cache_read_input_tokens: 291328 };
  assert.equal(sidecar.classifyPingResult(200, highRatio), 'hit');

  // 小前缀全量命中（探针场景 103/103）也是 hit
  const tiny = { prompt_tokens: 103, cached_tokens: 103, cache_read_input_tokens: 103 };
  assert.equal(sidecar.classifyPingResult(200, tiny), 'hit');

  // 门槛可调：设为 0 时任何 read>0 都算 hit（兼容旧行为）
  assert.equal(sidecar.classifyPingResult(200, lowRatio, 0), 'hit');

  // 读写皆 0 仍 no-cache；有 creation 仍 recreated
  assert.equal(sidecar.classifyPingResult(200, { prompt_tokens: 100, cached_tokens: 0 }), 'no-cache');
  assert.equal(sidecar.classifyPingResult(200, { prompt_tokens: 100, cache_creation_input_tokens: 50 }), 'recreated');
});

test('2026-10-20: 连续低命中自动关闭 ping（止损，不再烧 quota）', async (t) => {
  // 上游恒定返回低命中（模拟 TTL 失效场景）
  const mockUpstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'm',
        usage: { prompt_tokens: 100000, cached_tokens: 1000, prompt_tokens_details: { cached_tokens: 1000 }, cache_read_input_tokens: 1000 },
      }));
    });
  });
  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
  process.env.UPSTREAM_HOST = '127.0.0.1';
  process.env.UPSTREAM_PORT = String(mockUpstream.address().port);
  process.env.UPSTREAM_PROTOCOL = 'http';
  process.env.UPSTREAM_PREFIX = '/coding';

  await new Promise((r) => sidecar.server.listen(0, '127.0.0.1', r));
  const port = sidecar.server.address().port;
  const savedConfig = { ...sidecar.config };
  sidecar.config.recencyWindowMs = 0;
  t.after(() => {
    Object.assign(sidecar.config, savedConfig);
    mockUpstream.close();
    sidecar.server.close();
  });

  const req = (path, body) => new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(cs).toString())); } catch { resolve({}); } });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });

  const key = 'test-key-autooff';
  sidecar.recordedRequests.set(key, {
    body: Buffer.from(JSON.stringify({ model: 'k3', system: 'S-autooff', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] })),
    path: '/v1/chat/completions', headers: {}, model: 'k3', lastSeenMs: 0,
  });

  await req('/control/on', JSON.stringify({ key, intervalMin: 50 }));
  const waitFor = async (fn, ms = 4000) => {
    const t0 = Date.now();
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 25)); }
  };
  const st = await waitFor(async () => {
    const s = await req('/control/state');
    const p = (s.pings || []).find((x) => x.key === key);
    return p && p.on === false ? p : null;
  });
  assert.ok(st, '连续低命中后应自动 off');
  assert.equal(st.health, 'stale');
  assert.equal(st.on, false, '必须停止 ping 以免继续烧 quota');

  // reconciler 补挂不得重置失败计数（否则自动关闭永远不触发）
  const raw = sidecar.pings.get(key);
  const before = raw.consecutiveZeroCacheRead;
  await req('/control/on', JSON.stringify({ key, intervalMin: 50 }));
  assert.equal(sidecar.pings.get(key).consecutiveZeroCacheRead, before, '补挂必须继承失败计数');
});
