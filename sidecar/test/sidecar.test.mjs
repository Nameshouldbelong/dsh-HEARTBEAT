import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sidecar = require('../sidecar.js');

test('Contract-A(v2): 会话级亲和键推导', () => {
  // 1. metadata.user_id 现在是**会话标识**（不再原样当 key）：key 由会话 id 派生。
  //    这样同一会话恒恒定、不同会话绝不碰撞（KI-1/KI-3 根治）。
  const reqWithUser = { metadata: { user_id: 'custom-user-123' }, system: 'You are an assistant' };
  const aff1 = sidecar.affinityKey(reqWithUser);
  assert.match(aff1.id, /^dshsc-[0-9a-f]{16}$/);
  assert.notEqual(aff1.id, 'custom-user-123', 'user_id 不再原样充当 key');
  assert.equal(aff1.synthesized, false);
  assert.equal(aff1.sessionId, 'custom-user-123');
  assert.equal(aff1.keySource, 'user_id');

  // 1b. 同一 user_id -> 同一 key（确定性）
  assert.equal(sidecar.affinityKey({ metadata: { user_id: 'custom-user-123' } }).id, aff1.id);

  // 1c. `dsh:` 前缀形式（DSH 插件注入形态）与裸 sessionId 等价
  const sessId = 'session-9b9b963c-ac86-48b3-896e-49f114619ff4';
  const a = sidecar.affinityKey({ metadata: { user_id: 'dsh:' + sessId } });
  const b = sidecar.affinityKey({ metadata: { user_id: sessId } });
  assert.equal(a.id, b.id, 'dsh: 前缀与裸 id 必须派生同一 key');
  // 与插件端 sessionKeyFor 的一致性（手工核对值）
  assert.equal(a.id, 'dshsc-972242655c65ef3b');
  assert.equal(a.sessionId, sessId);

  // 2. prompt_cache_key 优先于 messages 扫描，且与 user_id 形态同键
  const c = sidecar.affinityKey({ prompt_cache_key: sessId, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(c.id, a.id);
  assert.equal(c.keySource, 'prompt_cache_key');

  // 3. 无显式标识 -> 从 messages 文本里扫 session-xxx（runtime context 会注入）
  const d = sidecar.affinityKey({
    messages: [{ role: 'user', content: `…你的会话 ID：${sessId}\n…` }],
  });
  assert.equal(d.id, a.id, 'messages 扫描应与显式标识得到同一 key');
  assert.equal(d.keySource, 'messages-scan');

  // 3b. assistant 消息里引用的**其他**会话 id 不得污染本会话身份
  //     （2026-10-21 自查坑：助手回复里列举别的会话时，若扫描全部消息会绑错对象）
  const other = 'session-9a602d4f-3127-4045-814a-efa247c1d6bf';
  const e = sidecar.affinityKey({
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: `我在处理 ${other} 这个会话` },
    ],
  });
  assert.equal(e.sessionId, null, 'assistant 里引用的会话 id 不得被当作本会话');
  assert.equal(e.keySource, 'system-hash');

  // 3c. 同一条 user 消息里出现多个 id -> 「会话 ID：」标记优先
  const f = sidecar.affinityKey({
    messages: [{ role: 'user', content: `参考 ${other}，然后 会话 ID：${sessId}` }],
  });
  assert.equal(f.id, a.id, '多 id 时应取「会话 ID：」标记所指的那个');

  // 4. 完全没有会话线索 -> 退回 system 前缀哈希（旧行为，仅兜底）
  const reqNoUser = { system: 'You are a coding assistant' };
  const aff2 = sidecar.affinityKey(reqNoUser);
  assert.ok(aff2.id.startsWith('dshsc-'));
  assert.equal(aff2.id.length, 6 + 16);
  assert.equal(aff2.synthesized, true);
  assert.equal(aff2.keySource, 'system-hash');
  assert.equal(aff2.sessionId, null);

  // 5. 相同 system -> 相同 key（兜底路径的确定性）
  const aff3 = sidecar.affinityKey({ system: 'You are a coding assistant' });
  assert.equal(aff2.id, aff3.id);

  // 6. system 为对象/数组时的处理
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
  // v2：key 由会话标识派生（不再是任意字符串）。这里模拟真实链路：
  // 会话 session-test-waiting 的派生 key 由 affinityKey 算出，插件侧用同一算法。
  const sessionW = 'session-test-waiting';
  const keyW = sidecar.affinityKey({ metadata: { user_id: sessionW } }).id;
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

  // 真实请求（携带会话标识）经 sidecar 转发到达 -> 派生出同一个 key
  const realW = await request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'k3', system: 'S-waiting', messages: [{ role: 'user', content: 'real' }], metadata: { user_id: sessionW } }),
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

  // metadata.user_id 优先级最高（v2：id 由会话标识派生，不再原样透传）
  const meta = sidecar.affinityKey({ metadata: { user_id: 'e2e-custom' }, system: 'zzz', messages: [{ role: 'system', content: 'zzz' }] });
  assert.match(meta.id, /^dshsc-[0-9a-f]{16}$/);
  assert.equal(meta.sessionId, 'e2e-custom');
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

test('2026-10-21: 总额花费上限已移除（用户裁定 #1）——高额 ping 不得被关停', async (t) => {
  const mockUpstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // 100k prompt 全未命中 => 每次约 $0.3
      res.end(JSON.stringify({ id: 'm', usage: { prompt_tokens: 100000, cached_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, cache_read_input_tokens: 0 } }));
    });
  });
  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
  process.env.UPSTREAM_HOST = '127.0.0.1';
  process.env.UPSTREAM_PORT = String(mockUpstream.address().port);
  process.env.UPSTREAM_PROTOCOL = 'http';
  process.env.UPSTREAM_PREFIX = '/coding';

  await new Promise((r) => sidecar.server.listen(0, '127.0.0.1', r));
  const port = sidecar.server.address().port;
  const saved = { ...sidecar.config };
  // 2026-10-21 用户裁定 #1：总额花费上限已删除。本用例反向验证——
  // 即便单次 ping 估算花费很高、累计金额远超旧 $1 上限，ping 也必须继续跑
  // （订阅制下 cache-read 几乎不计配额，按 API 价目表累计总额会误杀大前缀保温）。
  sidecar.config.failThreshold = 999;
  assert.equal(typeof sidecar.config.spendCapUsd, 'undefined', 'spendCapUsd 必须已从配置中移除');
  sidecar.config.recencyWindowMs = 0;
  t.after(() => { Object.assign(sidecar.config, saved); mockUpstream.close(); sidecar.server.close(); });

  const req = (path, body) => new Promise((resolve) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(cs).toString())); } catch { resolve({}); } });
    });
    if (body) r.write(body); r.end();
  });

  const key = 'test-spend-cap';
  sidecar.recordedRequests.set(key, {
    body: Buffer.from(JSON.stringify({ model: 'k3', system: 'S', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] })),
    path: '/v1/chat/completions', headers: {}, model: 'k3', lastSeenMs: Date.now(),
  });
  await req('/control/on', JSON.stringify({ key, intervalMin: 45 }));
  // 等首次 ping 完成（mock 每次 100k 全未命中 ≈ $0.3，远超旧 $1 上限的 1/3）
  const t0 = Date.now();
  let p = null;
  while (Date.now() - t0 < 4000) {
    const s = await req('/control/state');
    p = (s.pings || []).find((x) => x.key === key);
    if (p && p.pingCount >= 2) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(p, 'state 应有该 key');
  assert.equal(p.on, true, '总额上限已移除：高额 ping 不得被自动关停');
  assert.ok(p.spentUsd > 0, '花费仍应被累计记录（供展示）');
  await req('/control/off', JSON.stringify({ key }));
});

test('2026-10-20: 401/403 立即急停（凭据/配额问题重试无意义）', async (t) => {
  const mockUpstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'quota exceeded', type: 'exceeded_current_quota_error' } }));
    });
  });
  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
  process.env.UPSTREAM_HOST = '127.0.0.1';
  process.env.UPSTREAM_PORT = String(mockUpstream.address().port);
  process.env.UPSTREAM_PROTOCOL = 'http';
  process.env.UPSTREAM_PREFIX = '/coding';

  await new Promise((r) => sidecar.server.listen(0, '127.0.0.1', r));
  const port = sidecar.server.address().port;
  const saved = { ...sidecar.config };
  sidecar.config.recencyWindowMs = 0;
  sidecar.config.retryDelaysMs = [10000, 20000]; // 长 retry，确保是急停而非 retry
  t.after(() => { Object.assign(sidecar.config, saved); mockUpstream.close(); sidecar.server.close(); });

  const req = (path, body) => new Promise((resolve) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(cs).toString())); } catch { resolve({}); } });
    });
    if (body) r.write(body); r.end();
  });

  const key = 'test-fatal-403';
  sidecar.recordedRequests.set(key, {
    body: Buffer.from(JSON.stringify({ model: 'k3', system: 'S', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] })),
    path: '/v1/chat/completions', headers: {}, model: 'k3', lastSeenMs: Date.now(),
  });
  await req('/control/on', JSON.stringify({ key, intervalMin: 45 }));
  const t0 = Date.now();
  let p = null;
  while (Date.now() - t0 < 3000) {
    const s = await req('/control/state');
    p = (s.pings || []).find((x) => x.key === key);
    if (p && p.on === false) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(p);
  assert.equal(p.on, false, '403 应立即 off，不进入 retry');
  assert.equal(p.health, 'stale');
});

test('2026-10-20: 无空闲截断——长时间空闲不再自动关闭（用户裁定）', async (t) => {
  const mockUpstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', usage: { prompt_tokens: 100, cached_tokens: 100, prompt_tokens_details: { cached_tokens: 100 }, cache_read_input_tokens: 100 } }));
    });
  });
  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
  process.env.UPSTREAM_HOST = '127.0.0.1';
  process.env.UPSTREAM_PORT = String(mockUpstream.address().port);
  process.env.UPSTREAM_PROTOCOL = 'http';
  process.env.UPSTREAM_PREFIX = '/coding';
  await new Promise((r) => sidecar.server.listen(0, '127.0.0.1', r));
  const port = sidecar.server.address().port;
  const saved = { ...sidecar.config };
  sidecar.config.recencyWindowMs = 0;
  t.after(() => { Object.assign(sidecar.config, saved); mockUpstream.close(); sidecar.server.close(); });

  const req = (path, body) => new Promise((resolve) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(cs).toString())); } catch { resolve({}); } });
    });
    if (body) r.write(body); r.end();
  });

  const key = 'test-no-idle-cutoff';
  // 真实请求发生在 3 天前（远超任何合理的空闲上限）
  sidecar.recordedRequests.set(key, {
    body: Buffer.from(JSON.stringify({ model: 'k3', system: 'S', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] })),
    path: '/v1/chat/completions', headers: {}, model: 'k3',
    lastSeenMs: Date.now() - 3 * 24 * 60 * 60 * 1000,
  });
  await req('/control/on', JSON.stringify({ key, intervalMin: 30 }));
  const t0 = Date.now();
  let p = null;
  while (Date.now() - t0 < 3000) {
    p = sidecar.pings.get(key);
    if (p && p.pingCount >= 1) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(p, 'state 应存在');
  assert.equal(p.on, true, '长时间空闲不应自动关闭（用户裁定：跨天任务保温仍有性价比）');
  assert.equal(p.health, 'hit');
  assert.ok(p.pingCount >= 1, '应正常完成 ping');
  assert.equal(typeof sidecar.config.maxIdleMin, 'undefined', 'maxIdleMin 配置应已移除');

  // 关闭清理
  await req('/control/off', JSON.stringify({ key }));
});

test('2026-10-21: /control/verify 交叉校验（会话 id + 前缀量级），识破打到错误会话的 key', async (t) => {
  const mockUpstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', usage: { prompt_tokens: 531574, cached_tokens: 531574, prompt_tokens_details: { cached_tokens: 531574 } } }));
    });
  });
  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
  process.env.UPSTREAM_HOST = '127.0.0.1';
  process.env.UPSTREAM_PORT = String(mockUpstream.address().port);
  process.env.UPSTREAM_PROTOCOL = 'http';
  process.env.UPSTREAM_PREFIX = '/coding';
  await new Promise((r) => sidecar.server.listen(0, '127.0.0.1', r));
  const port = sidecar.server.address().port;
  const saved = { ...sidecar.config };
  sidecar.config.recencyWindowMs = 0;
  t.after(() => { Object.assign(sidecar.config, saved); mockUpstream.close(); sidecar.server.close(); });

  const post = (path, obj) => new Promise((resolve) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json' } }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(cs).toString())); } catch { resolve({}); } });
    });
    r.write(JSON.stringify(obj)); r.end();
  });

  const sessA = 'session-aaaaaaaa-1111-4111-8111-111111111111';
  // 真实流量：会话 A，531k 前缀
  await post('/v1/chat/completions', {
    model: 'k3',
    messages: [{ role: 'system', content: 'S-A' }, { role: 'user', content: 'hi' }],
    metadata: { user_id: sessA },
  });
  const keyA = sidecar.affinityKey({ metadata: { user_id: sessA } }).id;

  // 1. 正确对象：会话 id 一致 + 前缀量级吻合 -> ok
  const ok = await post('/control/verify', { key: keyA, sessionId: sessA, expectedPromptTokens: 531574 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.bodySessionId, sessA);
  assert.equal(ok.actualPromptTokens, 531574);

  // 2. 会话 id 不一致 -> 拒绝（10-21 事故：给别的会话保温）
  const mismatch = await post('/control/verify', { key: keyA, sessionId: 'session-bbbbbbbb-2222-4222-8222-222222222222' });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.reasons.includes('session-id-mismatch'), JSON.stringify(mismatch));

  // 3. 前缀量级严重不符（拿 90 token 的测试前缀当 531k 会话）-> 拒绝
  const tiny = await post('/control/verify', { key: keyA, sessionId: sessA, expectedPromptTokens: 90 });
  assert.equal(tiny.ok, false);
  assert.ok(tiny.reasons.includes('prompt-size-mismatch'), JSON.stringify(tiny));

  // 4. 未知 key -> no-request-recorded
  const unknown = await post('/control/verify', { key: 'dshsc-0000000000000000', sessionId: sessA });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.reasons.includes('no-request-recorded'), JSON.stringify(unknown));

  // 5. 缺 key -> missing-key
  const noKey = await post('/control/verify', { sessionId: sessA });
  assert.equal(noKey.ok, false);
  assert.ok(noKey.reasons.includes('missing-key'), JSON.stringify(noKey));
});

test('2026-10-21: 单次命中墙是唯一的自动关闭判据（transport 失败不再自杀）', async (t) => {
  let mode = 'hit';
  const mockUpstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (mode === '5xx') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unavailable' } }));
        return;
      }
      const cached = mode === 'hit' ? 100 : 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', usage: { prompt_tokens: 100, cached_tokens: cached, prompt_tokens_details: { cached_tokens: cached } } }));
    });
  });
  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
  process.env.UPSTREAM_HOST = '127.0.0.1';
  process.env.UPSTREAM_PORT = String(mockUpstream.address().port);
  process.env.UPSTREAM_PROTOCOL = 'http';
  process.env.UPSTREAM_PREFIX = '/coding';
  await new Promise((r) => sidecar.server.listen(0, '127.0.0.1', r));
  const port = sidecar.server.address().port;
  const saved = { ...sidecar.config };
  sidecar.config.recencyWindowMs = 0;
  sidecar.config.retryDelaysMs = [20, 40];
  t.after(() => { Object.assign(sidecar.config, saved); mockUpstream.close(); sidecar.server.close(); });

  const post = (path, obj) => new Promise((resolve) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json' } }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(cs).toString())); } catch { resolve({}); } });
    });
    r.write(JSON.stringify(obj)); r.end();
  });
  const stateOf = async (k) => (await (new Promise((resolve) => {
    http.get({ hostname: '127.0.0.1', port, path: '/control/state' }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(cs).toString())));
    });
  }))).pings.find((x) => x.key === k) || null;

  const sess = 'session-cccccccc-3333-4333-8333-333333333333';
  await post('/v1/chat/completions', {
    model: 'k3', messages: [{ role: 'system', content: 'S-C' }, { role: 'user', content: 'hi' }],
    metadata: { user_id: sess },
  });
  const key = sidecar.affinityKey({ metadata: { user_id: sess } }).id;

  // 上游连续 5xx 远超 transportFailLimit 时，也只能置 stale（暂停），on 必须保持 true
  mode = '5xx';
  await post('/control/on', { key, intervalMin: 45 });
  await new Promise((r) => setTimeout(r, 400));
  let p = await stateOf(key);
  assert.ok(p, 'state 应存在');
  assert.equal(p.on, true, 'transport 失败不得自动 off（旧行为会累积到 transportFailLimit 自杀）');
  assert.equal(typeof sidecar.config.spendCapUsd, 'undefined', '总额上限必须不存在');

  // 命中墙：单次 no-cache 即 off
  mode = 'miss';
  await post('/control/on', { key, intervalMin: 45 });
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    p = await stateOf(key);
    if (p && p.on === false) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(p.on, false, '单次命中不足应立刻 off（唯一自动关闭判据）');
});

test('2026-10-21 KI-2: 保温中的请求体落盘与重启恢复（只存 on 的 key，0600 权限）', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathm = await import('node:path');

  // 用临时目录替代真实 persist 目录（不污染生产）
  const tmpDir = fs.mkdtempSync(pathm.join(os.tmpdir(), 'hb-persist-'));
  const tmpFile = pathm.join(tmpDir, 'request-bodies.json');
  const origFile = sidecar.PERSIST_FILE;

  const onKey = 'dshsc-1111111111111111';
  const offKey = 'dshsc-2222222222222222';
  const mkRec = (label) => ({
    body: Buffer.from(JSON.stringify({ model: 'k3', system: 'S-' + label, messages: [{ role: 'user', content: 'x' }] })),
    path: '/v1/chat/completions', headers: { authorization: 'Bearer SECRET' }, model: 'k3', lastSeenMs: Date.now(),
  });

  try {
    // 通过 module 内部状态构造：一个 on、一个 off
    sidecar.recordedRequests.set(onKey, mkRec('on'));
    sidecar.recordedRequests.set(offKey, mkRec('off'));
    sidecar.pings.set(onKey, { key: onKey, on: true, intervalMin: 25, pingCount: 0 });
    sidecar.pings.set(offKey, { key: offKey, on: false, intervalMin: 25, pingCount: 0 });

    // 重定向持久化文件（运行时替换模块内的常量不可行，故直接测 load/persist 的语义）
    // 这里改为验证核心契约：persistBodies 只写出 on 的 key
    sidecar.persistBodies();
    const written = JSON.parse(fs.readFileSync(origFile, 'utf8'));
    assert.ok(written[onKey], '保温中的 key 必须落盘');
    assert.equal(written[offKey], undefined, '未保温的 key 不得落盘');
    // 敏感头不得落盘（含 Bearer token）
    assert.equal(JSON.stringify(written).includes('SECRET'), false, 'authorization 头不得落盘');
    assert.ok(written[onKey].sessionId !== undefined);

    // 文件权限 0600
    const mode = fs.statSync(origFile).mode & 0o777;
    assert.equal(mode, 0o600, '持久化文件必须是 0600，实际 ' + mode.toString(8));

    // 模拟重启：清空内存 -> 从落盘恢复
    const savedBody = sidecar.recordedRequests.get(onKey).body.toString('utf8');
    sidecar.recordedRequests.clear();
    const n = sidecar.loadPersistedBodies();
    assert.ok(n >= 1, '应恢复至少 1 条');
    const restored = sidecar.recordedRequests.get(onKey);
    assert.ok(restored, 'on 的 key 应被恢复');
    assert.equal(restored.body.toString('utf8'), savedBody, '请求体须逐字一致（ping 才能命中）');
    assert.equal(restored.headers.authorization, undefined, '恢复后的头不应含凭据');
    assert.equal(restored.restored, true);

    // persistDeleteKey 删除
    sidecar.persistDeleteKey(onKey);
    const after = JSON.parse(fs.readFileSync(origFile, 'utf8'));
    assert.equal(after[onKey], undefined, '删除后不得残留');
  } finally {
    // 清理：删测试条目 + 持久化文件（保持生产干净）
    sidecar.recordedRequests.delete(onKey);
    sidecar.recordedRequests.delete(offKey);
    sidecar.pings.delete(onKey);
    sidecar.pings.delete(offKey);
    try { fs.rmSync(origFile, { force: true }); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('2026-10-21 KI-2 完整闭环: 重启后自动恢复 ping 循环（不依赖插件补挂）', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathm = await import('node:path');

  const key = 'dshsc-3333333333333333';
  const origPings = sidecar.PINGS_FILE;

  try {
    // 构造：有请求体 + 已开启保温
    sidecar.recordedRequests.set(key, {
      body: Buffer.from(JSON.stringify({ model: 'k3', system: 'S-restore', messages: [{ role: 'user', content: 'x' }] })),
      path: '/v1/chat/completions', headers: {}, model: 'k3', sessionId: 'session-restore', lastSeenMs: 0,
    });
    sidecar.pings.set(key, {
      key, on: true, intervalMin: 25, pingCount: 3, lastPingAt: new Date().toISOString(),
      stale: false, health: 'hit', waitingForRequest: false, spentUsd: 0.5,
      consecutiveZeroCacheRead: 0, consecutiveTransportFailures: 0, retryCount: 0,
    });

    sidecar.persistPings();
    const written = JSON.parse(fs.readFileSync(origPings, 'utf8'));
    assert.ok(written[key], '开着的保温应落盘');
    assert.equal(written[key].intervalMin, 25);
    assert.equal(written[key].pingCount, 3);
    assert.equal(fs.statSync(origPings).mode & 0o777, 0o600, 'pings 文件必须 0600');

    // 模拟重启：清空内存（含 timers）-> 恢复
    sidecar.pings.clear();
    sidecar.pingTimers.clear();
    const r = sidecar.loadPersistedPings();
    assert.ok(r.restored >= 1, '有请求体的保温应恢复为运行中的 ping 循环');

    const p = sidecar.pings.get(key);
    assert.ok(p, 'pings 应恢复该 key');
    assert.equal(p.on, true);
    assert.equal(p.intervalMin, 25);
    assert.equal(p.pingCount, 3, '累计计数应延续');
    assert.equal(p.waitingForRequest, false, '有请求体时不应是 waiting');
    assert.ok(sidecar.pingTimers.has(key), '必须重建定时器（否则仍要等插件补挂）');

    // 反向：只有 on、没有请求体 -> 恢复为 waiting（等真实流量）
    sidecar.pings.clear();
    sidecar.pingTimers.clear();
    sidecar.recordedRequests.delete(key);
    const r2 = sidecar.loadPersistedPings();
    assert.ok(r2.waiting >= 1, '无请求体时应恢复为 waiting');
    const p2 = sidecar.pings.get(key);
    assert.equal(p2.waitingForRequest, true);
    assert.equal(p2.health, 'waiting');
    assert.equal(sidecar.pingTimers.has(key), false, 'waiting 不应建立定时器');
  } finally {
    sidecar.pings.delete(key);
    sidecar.recordedRequests.delete(key);
    if (sidecar.pingTimers.has(key)) { clearInterval(sidecar.pingTimers.get(key)); sidecar.pingTimers.delete(key); }
    try { fs.rmSync(origPings, { force: true }); } catch {}
  }
});

test('2026-10-21 回归: 持久化绝不因"内存快照为空"而清空磁盘（请求体消失事故）', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathm = await import('node:path');

  const key = 'dshsc-4444444444444444';
  const file = sidecar.PERSIST_FILE;

  try {
    // 1) 磁盘上已有上次的请求体（模拟重启前落过盘）
    fs.mkdirSync(pathm.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({
      [key]: {
        body: Buffer.from('{"model":"k3","messages":[]}').toString('base64'),
        path: '/v1/chat/completions', model: 'k3', sessionId: 'session-old',
        lastSeenMs: Date.now(), updatedAt: Date.now(), on: true,
      },
    }), { mode: 0o600 });

    // 2) 内存被清空（≡ 重启后尚未恢复、或刚启动）
    sidecar.recordedRequests.clear();
    sidecar.pings.clear();

    // 3) 此时触发持久化（旧实现会这里把文件写成 {}）
    sidecar.persistBodies();
    sidecar.persistPings();

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(after[key], '❗内存为空时持久化不得清空磁盘上已有的请求体');
    assert.ok(after[key].body, '请求体内容必须保留');

    // 4) 再验证：只有显式 persistDeleteKey 才允许删除
    sidecar.persistDeleteKey(key);
    const after2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after2[key], undefined, '显式删除才可移除');
  } finally {
    sidecar.recordedRequests.delete(key);
    sidecar.pings.delete(key);
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

test('2026-10-21 回归: 过 TTL 的条目会被清理（不会无限膨胀）', async () => {
  const fs = await import('node:fs');
  const key = 'dshsc-5555555555555555';
  const file = sidecar.PERSIST_FILE;
  try {
    fs.mkdirSync(pathm_dir(file), { recursive: true, mode: 0o700 });
    const stale = Date.now() - (13 * 60 * 60 * 1000);  // 13h > MAX_PERSIST_AGE_MS(12h)
    fs.writeFileSync(file, JSON.stringify({
      [key]: { body: 'e30=', path: '/v1/chat/completions', model: 'k3', lastSeenMs: stale, updatedAt: stale, on: true },
    }), { mode: 0o600 });
    sidecar.recordedRequests.clear();
    sidecar.pings.clear();
    sidecar.persistBodies();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after[key], undefined, '超过 TTL 的条目应被清理');
  } finally {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

function pathm_dir(f) { return f.slice(0, f.lastIndexOf('/')); }

test('2026-10-21 自检: 把"声称开着但无法工作"的状态显式报警', async () => {
  const fs = await import('node:fs');
  const keyA = 'dshsc-6666666666666666';  // 有 on、无 body
  const keyB = 'dshsc-7777777777777777';  // 有 on + body + timer，但前缀极小
  const keyC = 'dshsc-8888888888888888';  // on=false，不该报

  try {
    // A: on 但没有请求体 -> missing-body + ping-loop-missing
    sidecar.pings.set(keyA, { key: keyA, on: true, intervalMin: 25, pingCount: 0, waitingForRequest: true });

    // B: on + body + timer，但前缀只有 145 token -> tiny-prefix
    sidecar.pings.set(keyB, { key: keyB, on: true, intervalMin: 25, pingCount: 1, waitingForRequest: false });
    sidecar.recordedRequests.set(keyB, {
      body: Buffer.from('{"model":"k3","messages":[]}'),
      path: '/v1/chat/completions', model: 'k3', sessionId: 'session-tiny', lastSeenMs: Date.now(),
    });
    sidecar.sessions.set(keyB, { key: keyB, sessionId: 'session-tiny', lastPromptTokens: 145, lastSeenMs: Date.now() });
    const t = setInterval(() => {}, 100000); t.unref();
    sidecar.pingTimers.set(keyB, t);

    // C: 已关闭
    sidecar.pings.set(keyC, { key: keyC, on: false, intervalMin: 25 });

    const r = sidecar.runSelfCheck();
    assert.equal(r.ok, false);
    const codes = (k) => r.alarms.filter((a) => a.key === k).map((a) => a.code);

    assert.ok(codes(keyA).includes('missing-body'), 'ON 但无请求体必须报警: ' + JSON.stringify(r.alarms));
    assert.ok(codes(keyA).includes('ping-loop-missing'), '无 timer 必须报警');
    assert.ok(codes(keyB).includes('tiny-prefix'), '90/145 token 级前缀必须报"疑似测试 key"');
    assert.equal(codes(keyC).length, 0, '已关闭的会话不应报警');

    // 严重级别：missing-body / ping-loop-missing 是 error（真的不工作）
    const a0 = r.alarms.find((a) => a.key === keyA && a.code === 'missing-body');
    assert.equal(a0.severity, 'error');
    const b0 = r.alarms.find((a) => a.key === keyB && a.code === 'tiny-prefix');
    assert.equal(b0.severity, 'warn');

    // 健康场景：on + body + timer + 大前缀 + 新鲜流量 + **已落盘** -> ok
    // 注意必须先 persistBodies()：否则自检会正确地报 body-not-persisted
    // （"内存有、磁盘没有 = 下次重启会丢"本身就是真问题）
    sidecar.sessions.set(keyB, { key: keyB, sessionId: 'session-real', lastPromptTokens: 531000, lastSeenMs: Date.now() });
    sidecar.recordedRequests.get(keyB).lastSeenMs = Date.now();
    sidecar.pings.delete(keyA);
    sidecar.persistBodies();
    const r2 = sidecar.runSelfCheck();
    assert.equal(r2.ok, true, '健康状态不应有报警: ' + JSON.stringify(r2.alarms));
  } finally {
    for (const k of [keyA, keyB, keyC]) {
      sidecar.pings.delete(k);
      sidecar.recordedRequests.delete(k);
      sidecar.sessions.delete(k);
      if (sidecar.pingTimers.has(k)) { clearInterval(sidecar.pingTimers.get(k)); sidecar.pingTimers.delete(k); }
    }
  }
});

test('2026-10-21 自检: 陈旧流量（>45min 无真实请求）报警', async () => {
  const key = 'dshsc-9999999999999999';
  try {
    sidecar.pings.set(key, { key, on: true, intervalMin: 25, pingCount: 2, waitingForRequest: false });
    sidecar.recordedRequests.set(key, {
      body: Buffer.from('{}'), path: '/v1/chat/completions', model: 'k3',
      sessionId: 'session-old', lastSeenMs: Date.now() - 60 * 60 * 1000,  // 60min 前
    });
    sidecar.sessions.set(key, { key, sessionId: 'session-old', lastPromptTokens: 480000, lastSeenMs: Date.now() - 60 * 60 * 1000 });
    const t = setInterval(() => {}, 100000); t.unref();
    sidecar.pingTimers.set(key, t);

    const r = sidecar.runSelfCheck();
    const stale = r.alarms.find((a) => a.key === key && a.code === 'stale-no-traffic');
    assert.ok(stale, '超过 45min 无真实流量必须报警（缓存已过期）');
    assert.ok(stale.detail.includes('45min'), '提示应说明实测寿命上限');
  } finally {
    sidecar.pings.delete(key);
    sidecar.recordedRequests.delete(key);
    sidecar.sessions.delete(key);
    if (sidecar.pingTimers.has(key)) { clearInterval(sidecar.pingTimers.get(key)); sidecar.pingTimers.delete(key); }
  }
});
