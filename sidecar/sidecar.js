// kimi-cache-sidecar: 本地反代 (127.0.0.1:8791) -> https://api.kimi.com/coding/*
// 注入: 顶层 cache_control {type:ephemeral, ttl:1h} (Kimi Anthropic 兼容端点的 TTL 旋钮)
//       metadata.user_id 会话亲和键 (客户端已带则保留; 否则按 system 前缀哈希合成)
// 记录: usage.jsonl 每请求一行 {ts, path, status, injected, usage}
// 开关: 环境变量 INJECT_TTL=0 / INJECT_AFFINITY=0 可单独关闭
//
// 本文件 = WSL 生产运行版 (2026-10-15 实测: 注入字段被 Kimi coding 端点接受;
// 同前缀二次请求 cache_read 全量命中; ttl=1h 在 >5min 后仍命中)。
// M1 任务: 在此基础上追加 /sessions 与 /control 路由 + ping 定时器 (docs/INTERFACES.md Contract-B),
// 不得改动亲和键推导、/healthz、注入逻辑与转发路径。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getUpstreamHost() { return process.env.UPSTREAM_HOST || 'api.kimi.com'; }
function getUpstreamPrefix() { return process.env.UPSTREAM_PREFIX || '/coding'; }
function getUpstreamPort() { return parseInt(process.env.UPSTREAM_PORT || (process.env.UPSTREAM_PROTOCOL === 'http' ? '80' : '443'), 10); }
function isUpstreamHttps() { return process.env.UPSTREAM_PROTOCOL !== 'http' && getUpstreamPort() === 443; }
function getUpstreamTransport() { return isUpstreamHttps() ? https : http; }
const INJECT_TTL = process.env.INJECT_TTL !== '0';
const INJECT_AFFINITY = process.env.INJECT_AFFINITY !== '0';
const LOG = path.join(__dirname, 'usage.jsonl');

function log(obj) {
  try { fs.appendFileSync(LOG, JSON.stringify(obj) + '\n'); } catch (e) {}
}

function affinityKey(j) {
  if (j.metadata && j.metadata.user_id) return { id: j.metadata.user_id, synthesized: false };
  const sys = typeof j.system === 'string' ? j.system : JSON.stringify(j.system || '');
  return { id: 'dshsc-' + crypto.createHash('sha256').update(sys.slice(0, 8000)).digest('hex').slice(0, 16), synthesized: true };
}

function extractUsage(txt) {
  // 扫描所有 "usage" 出现处,括号配平取对象后合并(SSE 的 message_start + message_delta)
  const merged = {};
  let from = 0;
  for (;;) {
    const idx = txt.indexOf('"usage"', from);
    if (idx === -1) break;
    from = idx + 7;
    const braceStart = txt.indexOf('{', idx);
    if (braceStart === -1) break;
    let depth = 0, end = -1;
    for (let i = braceStart; i < txt.length; i++) {
      if (txt[i] === '{') depth++;
      else if (txt[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) break;
    try { Object.assign(merged, JSON.parse(txt.slice(braceStart, end + 1))); } catch (e) {}
    from = end + 1;
  }
  return merged;
}

// B1-B5 内存数据结构
const sessions = new Map(); // key -> { key, lastSeenAt, model, lastStatus, lastInputTokens, lastCacheRead, lastSeenMs }
const recordedRequests = new Map(); // key -> { body: Buffer, path: string, headers: object, model: string, lastSeenMs: number }
const pings = new Map(); // key -> { key, on, intervalMin, lastPingAt, pingCount, stale, lastUsage, consecutiveZeroCacheRead }
const pingTimers = new Map(); // key -> Timeout/Interval

function buildPingBody(recordedBuffer) {
  // 2026-10-15 实测(Kimi coding 端点): max_tokens=1 / 改写任何字段的请求不参与前缀缓存
  // (连发双 miss), 必须字节级原样重放录得的(已注入)请求体才会命中。
  // 代价: ping 会生成完整回复(output 计入配额), 由 interval 下限与 stale 判定控制成本。
  return Buffer.from(recordedBuffer);
}

function runPing(key) {
  const pingState = pings.get(key);
  if (!pingState || !pingState.on || pingState.stale) return;
  const rec = recordedRequests.get(key);
  if (!rec) return;

  // 并发保护：该 key 的真实请求 lastSeen <10s 时本次重放顺延 30s
  const now = Date.now();
  if (now - rec.lastSeenMs < 10000) {
    const delayTimer = setTimeout(() => runPing(key), 30000);
    if (delayTimer.unref) delayTimer.unref();
    return;
  }

  let pingBody;
  try {
    const pj = JSON.parse(buildPingBody(rec.body).toString('utf8'));
    // P0: ping 必须携带与真实请求相同的注入(cache_control ttl=1h + 亲和键),
    // 否则无顶层 cache_control 只读 5m 池且无亲和路由, 间隔>5min 必 miss
    if (INJECT_TTL && !pj.cache_control) pj.cache_control = { type: 'ephemeral', ttl: '1h' };
    if (INJECT_AFFINITY && !(pj.metadata && pj.metadata.user_id)) {
      pj.metadata = Object.assign({}, pj.metadata, { user_id: key });
    }
    pingBody = Buffer.from(JSON.stringify(pj), 'utf8');
  } catch (e) {
    return;
  }

  const headers = Object.assign({}, rec.headers, {
    host: getUpstreamHost(),
    'content-length': pingBody.length,
    'accept-encoding': 'identity',
    'content-type': 'application/json',
  });
  delete headers.connection;
  delete headers['transfer-encoding'];

  const upReq = getUpstreamTransport().request(
    {
      hostname: getUpstreamHost(),
      port: getUpstreamPort(),
      path: getUpstreamPrefix() + rec.path,
      method: 'POST',
      headers,
    },
    (upRes) => {
      const respChunks = [];
      upRes.on('data', (c) => respChunks.push(c));
      upRes.on('end', () => {
        const txt = Buffer.concat(respChunks).toString('utf8');
        const usage = extractUsage(txt);
        log({
          ts: new Date().toISOString(),
          path: rec.path,
          status: upRes.statusCode,
          kind: 'ping',
          key,
          usage,
        });
        console.log(`[ping] key=${key} status=${upRes.statusCode} cache_read=${usage.cache_read_input_tokens || 0}`);
        pingState.lastPingAt = new Date().toISOString();
        pingState.pingCount = (pingState.pingCount || 0) + 1;
        pingState.lastUsage = usage;

        // stale 判定：连续 3 次 ping 的 usage.cache_read_input_tokens == 0 -> 挂起置 stale=true
        const cacheRead = Number(usage.cache_read_input_tokens || 0);
        if (cacheRead === 0) {
          pingState.consecutiveZeroCacheRead = (pingState.consecutiveZeroCacheRead || 0) + 1;
          if (pingState.consecutiveZeroCacheRead >= 3) {
            pingState.stale = true;
            console.log(`[ping] key=${key} marked stale (3 consecutive zero cache read)`);
          }
        } else {
          pingState.consecutiveZeroCacheRead = 0;
        }
      });
    }
  );

  upReq.on('error', (e) => {
    log({
      ts: new Date().toISOString(),
      path: rec.path,
      status: 502,
      kind: 'ping',
      key,
      error: String(e),
    });
  });

  upReq.end(pingBody);
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, inject_ttl: INJECT_TTL, inject_affinity: INJECT_AFFINITY, upstream: getUpstreamHost() + getUpstreamPrefix() }));
    return;
  }

  // B1: GET /sessions
  if (req.method === 'GET' && req.url === '/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      sessions: Array.from(sessions.values()).map((s) => ({
        key: s.key,
        lastSeenAt: s.lastSeenAt,
        model: s.model,
        lastStatus: s.lastStatus,
        lastInputTokens: s.lastInputTokens,
        lastCacheRead: s.lastCacheRead,
      })),
    }));
    return;
  }

  // B4: GET /control/state
  if (req.method === 'GET' && req.url === '/control/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      pings: Array.from(pings.values()).map((p) => ({
        key: p.key,
        on: p.on,
        intervalMin: p.intervalMin,
        lastPingAt: p.lastPingAt,
        pingCount: p.pingCount,
        stale: p.stale,
        lastUsage: p.lastUsage,
      })),
    }));
    return;
  }

  // B2: POST /control/on
  if (req.method === 'POST' && req.url === '/control/on') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid-json' }));
        return;
      }
      const key = body?.key;
      if (!key || typeof key !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid-key' }));
        return;
      }
      let intervalMin = body.intervalMin !== undefined ? Number(body.intervalMin) : 50;
      if (!Number.isInteger(intervalMin) || intervalMin < 1 || intervalMin > 720) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid-interval' }));
        return;
      }
      if (!recordedRequests.has(key)) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no-request-recorded' }));
        return;
      }

      if (pingTimers.has(key)) {
        clearInterval(pingTimers.get(key));
        pingTimers.delete(key);
      }
      const existing = pings.get(key) || {};
      const state = {
        key,
        on: true,
        intervalMin,
        lastPingAt: existing.lastPingAt || null,
        pingCount: existing.pingCount || 0,
        stale: false,
        lastUsage: existing.lastUsage || null,
        consecutiveZeroCacheRead: 0,
      };
      pings.set(key, state);
      const timer = setInterval(() => runPing(key), intervalMin * 60 * 1000);
      if (timer.unref) timer.unref();
      pingTimers.set(key, timer);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        state: {
          key: state.key,
          on: state.on,
          intervalMin: state.intervalMin,
          lastPingAt: state.lastPingAt,
          pingCount: state.pingCount,
          stale: state.stale,
          lastUsage: state.lastUsage,
        },
      }));
    });
    return;
  }

  // B3: POST /control/off
  if (req.method === 'POST' && req.url === '/control/off') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {}
      const key = body?.key;
      if (key && pingTimers.has(key)) {
        clearInterval(pingTimers.get(key));
        pingTimers.delete(key);
      }
      if (key && pings.has(key)) {
        pings.get(key).on = false;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // 转发上游 (原逻辑)
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    const injected = [];
    const ct = (req.headers['content-type'] || '').toLowerCase();
    let currentKey = null;
    let currentModel = 'unknown';

    if (ct.includes('json') && body.length) {
      try {
        const j = JSON.parse(body.toString('utf8'));
        if (INJECT_TTL && !j.cache_control) {
          j.cache_control = { type: 'ephemeral', ttl: '1h' };
          injected.push('cache_control=1h');
        }
        if (INJECT_AFFINITY) {
          const aff = affinityKey(j);
          if (aff.synthesized) {
            j.metadata = Object.assign({}, j.metadata, { user_id: aff.id });
            injected.push('user_id=' + aff.id);
          } else {
            injected.push('user_id=client');
          }
          currentKey = aff.id;
        } else {
          currentKey = affinityKey(j).id;
        }
        currentModel = j.model || 'unknown';
        body = Buffer.from(JSON.stringify(j), 'utf8');

        // B5: 记录最后真实请求体 (非 ping)
        if (currentKey) {
          recordedRequests.set(currentKey, {
          bodySha: require('crypto').createHash('sha256').update(body).digest('hex').slice(0,12),
            body: Buffer.from(JSON.stringify(j), 'utf8'),
            path: req.url,
            headers: req.headers,
            model: currentModel,
            lastSeenMs: Date.now(),
          });
          // 若有活跃 ping 循环但处于 stale 状态，真实流量到达时自动清 stale 并恢复循环
          if (pings.has(currentKey)) {
            const p = pings.get(currentKey);
            if (p.stale) {
              p.stale = false;
              p.consecutiveZeroCacheRead = 0;
              console.log(`[ping] key=${currentKey} cleared stale by real traffic`);
            }
            if (p.on && !pingTimers.has(currentKey)) {
              const timer = setInterval(() => runPing(currentKey), p.intervalMin * 60 * 1000);
              if (timer.unref) timer.unref();
              pingTimers.set(currentKey, timer);
            }
          }
        }
      } catch (e) {
        injected.push('body-parse-fail');
      }
    }
    const headers = Object.assign({}, req.headers, {
      host: getUpstreamHost(),
      'content-length': body.length,
      'accept-encoding': 'identity',
    });
    delete headers.connection;
    delete headers['transfer-encoding'];
    const upReq = getUpstreamTransport().request(
      { hostname: getUpstreamHost(), port: getUpstreamPort(), path: getUpstreamPrefix() + req.url, method: req.method, headers },
      (upRes) => {
        const respChunks = [];
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.on('data', (c) => { respChunks.push(c); res.write(c); });
        upRes.on('end', () => {
          res.end();
          const txt = Buffer.concat(respChunks).toString('utf8');
          const usage = extractUsage(txt);
          log({ ts: new Date().toISOString(), path: req.url, status: upRes.statusCode, injected, usage });

          if (currentKey) {
            sessions.set(currentKey, {
              key: currentKey,
              lastSeenAt: new Date().toISOString(),
              model: currentModel,
              lastStatus: upRes.statusCode,
              lastInputTokens: usage.input_tokens || 0,
              lastCacheRead: usage.cache_read_input_tokens || 0,
              lastSeenMs: Date.now(),
            });
          }
        });
        upRes.on('error', () => { try { res.end(); } catch (e) {} });
      }
    );
    upReq.on('error', (e) => {
      log({ ts: new Date().toISOString(), path: req.url, status: 502, injected, error: String(e) });
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'sidecar_upstream_error', message: String(e) } }));
      } else { try { res.end(); } catch (e2) {} }
    });
    upReq.end(body);
  });
});

const getPort = () => parseInt(process.env.SIDECAR_PORT || '8791', 10);
const PORT = getPort();

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => console.log('kimi-cache-sidecar listening on 127.0.0.1:' + PORT + ' -> https://' + getUpstreamHost() + getUpstreamPrefix()));
}

module.exports = {
  server,
  affinityKey,
  extractUsage,
  buildPingBody,
  runPing,
  sessions,
  recordedRequests,
  pings,
  pingTimers,
  PORT,
};
