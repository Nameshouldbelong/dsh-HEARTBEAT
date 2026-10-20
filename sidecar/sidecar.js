// kimi-cache-sidecar: 本地反代 (127.0.0.1:8791) -> https://api.kimi.com/coding/*
// 注入: 按协议自动选择 TTL 旋钮（2026-10-20 修正，官方文档依据见下）
//       - Anthropic Messages (/v1/messages): 顶层 cache_control {type:ephemeral, ttl:'1h'}
//       - Chat Completions (/v1/chat/completions): prompt_cache_options {mode:'implicit', ttl:'1h'}
//       依据 platform.kimi.com/docs/guide/context-caching「如何设置缓存 TTL」。
//       旧实现只注入 cache_control（Anthropic 写法）；10-19 协议切到 openai-completions 后
//       该字段被端点忽略 → 实际只按默认 5m TTL 缓存 → 50min 间隔 ping 必然 0% 命中并全价重算。
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

// 2026-10-20：TTL 注入按协议分派。Chat Completions 用 prompt_cache_options，
// Anthropic Messages 用顶层 cache_control。就地修改 obj，返回注入描述或 null。
function isChatCompletionsPath(p) {
  return typeof p === 'string' && p.indexOf('/chat/completions') !== -1;
}

function injectCacheTtl(obj, reqPath) {
  if (!INJECT_TTL) return null;
  if (isChatCompletionsPath(reqPath)) {
    if (obj.prompt_cache_options) return null;
    obj.prompt_cache_options = { mode: 'implicit', ttl: '1h' };
    return 'prompt_cache_options=1h';
  }
  if (obj.cache_control) return null;
  obj.cache_control = { type: 'ephemeral', ttl: '1h' };
  return 'cache_control=1h';
}

function affinityKey(j) {
  if (j.metadata && j.metadata.user_id) return { id: j.metadata.user_id, synthesized: false };
  let sys = j.system;
  if (sys === undefined && Array.isArray(j.messages)) {
    // openai-completions 形态（2026-10-19 起 kimi-coding 协议）：system 是
    // messages 里 role==='system' 的项，没有顶层 system 字段。
    // 旧实现只看顶层 system -> 所有 openai 流量 hash 同一空串 -> 全部会话共用
    // 单一 key、recordedRequests 互相覆盖（KI-1 碰撞成真）。必须兼容两种形态。
    sys = j.messages
      .filter((m) => m && m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
  }
  sys = typeof sys === 'string' ? sys : JSON.stringify(sys || '');
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
  // 2026-10-19 起 kimi-coding 协议切到 openai-completions：缓存读取语义在
  // prompt_tokens_details.cached_tokens（anthropic 形态是 cache_read_input_tokens）。
  // 统一归一化到 anthropic 字段名，分类/UI/统计层无需感知协议差异。
  const cached = Number(
    (merged.prompt_tokens_details && merged.prompt_tokens_details.cached_tokens) ??
    merged.cached_tokens ?? 0);
  if (cached > 0 && merged.cache_read_input_tokens == null) {
    merged.cache_read_input_tokens = cached;
  }
  return merged;
}

// B1-B5 内存数据结构
const sessions = new Map(); // key -> { key, lastSeenAt, model, lastStatus, lastInputTokens, lastCacheRead, lastSeenMs }
const recordedRequests = new Map(); // key -> { body: Buffer, path: string, headers: object, model: string, lastSeenMs: number }
// key -> { key, on, intervalMin, lastPingAt, pingCount, stale, health, waitingForRequest,
//          lastUsage, lastError, retryCount, retryTimer, consecutiveZeroCacheRead, consecutiveTransportFailures }
const pings = new Map();
const pingTimers = new Map(); // key -> Interval

// 可测试配置（测试可直接改写字段注入短计时）
const config = {
  pingTimeoutMs: parseInt(process.env.PING_TIMEOUT_MS || '120000', 10), // ping 上游超时（原实现无超时，卡死会静默）
  retryDelaysMs: [2 * 60 * 1000, 4 * 60 * 1000], // 临时错误快速抢救：+2min / +4min，不动主 interval
  recencyWindowMs: 10000, // 真实请求 <10s 内
  recencyDeferMs: 30000,  // 重放顺延 30s
  // 2026-10-20：命中率门槛（低门槛，用户要求"不应太高"）。
  // cached/prompt >= hitRatioMin 才算 hit；低于门槛视为失败计数。
  hitRatioMin: parseFloat(process.env.HIT_RATIO_MIN || '0.05'),
  // 连续失败达到此数 -> 置 stale 并自动 off（不再烧钱）。用户要求"否则认为失败并关闭 ping"。
  // 单次低命中即判失败并自动关闭（周期内等不到"连续 N 次"，见 runPing 注释）。
  // 设为 >1 可放宽，但每多等一次就是一次全价重算。
  failThreshold: parseInt(process.env.FAIL_THRESHOLD || '1', 10),
  // 2026-10-20 新增（对齐社区 pi-kimi-keepalive 的护栏）：
  // ① 会话探测花费上限（估算 USD）。累计估算成本达到上限 -> 自动 off 并记录。
  //    估算口径保守：未命中部分按 input 价，命中部分按 cacheRead 价（kimi-k3 参考
  //    input=$3/1M、cacheRead=$0.3/1M）。0 表示不设上限。
  spendCapUsd: parseFloat(process.env.SPEND_CAP_USD || '1.00'),
  priceInputPerM: parseFloat(process.env.PRICE_INPUT_PER_M || '3'),
  priceCacheReadPerM: parseFloat(process.env.PRICE_CACHE_READ_PER_M || '0.3'),
  // ② 连续 transport 失败急停（401/403 立即停，其余累计到阈值）
  transportFailLimit: parseInt(process.env.TRANSPORT_FAIL_LIMIT || '3', 10),
  // ③ 空闲截断：距最后一次真实请求超过该分钟数 -> 停止探测（0=不设限）
  maxIdleMin: parseInt(process.env.MAX_IDLE_MIN || '30', 10),
};

// 估算单次 ping 的花费（USD）。usage 里 cached 部分是命中价，其余未命中按 input 价。
function estimatePingCostUsd(usage) {
  const u = usage || {};
  const prompt = Number(u.prompt_tokens || u.input_tokens || 0);
  const cached = Number(
    (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ??
    u.cached_tokens ?? u.cache_read_input_tokens ?? 0);
  const miss = Math.max(0, prompt - cached);
  return (miss / 1e6) * config.priceInputPerM + (cached / 1e6) * config.priceCacheReadPerM;
}

function buildPingBody(recordedBuffer) {
  // 2026-10-15 实测(Kimi coding 端点): max_tokens=1 的请求不参与前缀缓存(连发双 miss),
  // max_tokens=16/100/1024 均正常命中。ping 输出整体丢弃, 故固定 16(已验证可参与缓存的最低档),
  // 不再沿用原始请求的 max_tokens 也不钳 1024。其余字段一律保持原样
  // (含注入的 cache_control/user_id, 由记录时机保证已注入)。
  const j = JSON.parse(recordedBuffer.toString('utf8'));
  j.max_tokens = 16;
  return Buffer.from(JSON.stringify(j), 'utf8');
}

// ping 结果三分类：cache 命中 / cache 重建 / 无缓存(2xx 但读写皆 0) / 传输或 API 错误
// HTTP/API 错误(429/5xx/timeout/ECONNRESET)绝不计入 cache 失败——两者分开统计
function classifyPingResult(statusCode, usage, hitRatioMin) {
  if (statusCode >= 200 && statusCode < 300) {
    const read = Number((usage && usage.cache_read_input_tokens) || 0);
    const creation = Number((usage && (usage.cache_creation_input_tokens || usage.cache_creation_tokens)) || 0);
    // 命中率门槛（2026-10-20）：cached 很少（如 12800/291557 = 4.4%）时，
    // 绝大部分前缀仍按全价重算，不能算 hit。prompt 规模未知时退化为旧的 read>0。
    const promptTokens = Number(
      (usage && (usage.prompt_tokens || usage.input_tokens)) || 0);
    const min = typeof hitRatioMin === 'number' ? hitRatioMin : config.hitRatioMin;
    if (read > 0) {
      if (promptTokens > 0 && read / promptTokens < min) return 'no-cache';
      return 'hit';
    }
    if (creation > 0) return 'recreated';
    return 'no-cache';
  }
  return 'error';
}

// 临时错误快速 retry：retry #1 +2min、retry #2 +4min(默认值见 config.retryDelaysMs)。
// 用独立 setTimeout, 主 setInterval 周期不漂移; 成功即清零; 耗尽则置 stale 等真实流量复活。
function scheduleRetry(key) {
  const pingState = pings.get(key);
  if (!pingState || !pingState.on) return;
  const retry = (pingState.retryCount || 0) + 1;
  if (retry > config.retryDelaysMs.length) {
    pingState.retryCount = 0;
    pingState.health = 'stale';
    pingState.stale = true;
    console.log(`[ping] key=${key} retries exhausted, marked stale`);
    return;
  }
  pingState.retryCount = retry;
  pingState.health = 'retrying';
  const delayMs = config.retryDelaysMs[retry - 1];
  if (pingState.retryTimer) clearTimeout(pingState.retryTimer);
  const t = setTimeout(() => {
    pingState.retryTimer = null;
    runPing(key);
  }, delayMs);
  if (t.unref) t.unref();
  pingState.retryTimer = t;
  console.log(`[ping] key=${key} transport/API failure, retry #${retry} in ${Math.round(delayMs / 1000)}s`);
}

function runPing(key) {
  const pingState = pings.get(key);
  if (!pingState || !pingState.on || pingState.stale) return;
  const rec = recordedRequests.get(key);
  if (!rec) return;

  // 并发保护：该 key 的真实请求 lastSeen <10s 时本次重放顺延 30s
  // 空闲截断（2026-10-20，对齐社区 maxidle）：距最后一次真实请求超过上限即停止探测，
  // 避免用户离开后无限期烧钱。0 = 不设限。
  if (config.maxIdleMin > 0 && rec.lastSeenMs
      && Date.now() - rec.lastSeenMs > config.maxIdleMin * 60 * 1000) {
    pingState.on = false;
    pingState.health = 'stale';
    pingState.stale = true;
    if (pingTimers.has(key)) { clearInterval(pingTimers.get(key)); pingTimers.delete(key); }
    if (pingState.retryTimer) { clearTimeout(pingState.retryTimer); pingState.retryTimer = null; }
    console.log(`[ping] key=${key} AUTO-OFF: idle beyond ${config.maxIdleMin}min since last real request`);
    return;
  }

  // (immediate ping / retry / 周期 ping 一律遵守)
  const now = Date.now();
  if (now - rec.lastSeenMs < config.recencyWindowMs) {
    const delayTimer = setTimeout(() => runPing(key), config.recencyDeferMs);
    if (delayTimer.unref) delayTimer.unref();
    return;
  }

  let pingBody;
  try {
    const pj = JSON.parse(buildPingBody(rec.body).toString('utf8'));
    // P0: ping 必须携带与真实请求相同的 TTL 注入 + 亲和键，
    // 否则只读默认 5m 池，间隔>5min 必 miss。按协议分派（Chat Completions
    // 用 prompt_cache_options，Anthropic Messages 用顶层 cache_control）。
    injectCacheTtl(pj, rec.path);
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

  const startMs = Date.now();

  // 传输/API 失败的统一处理：不计入 cache 失败计数，走快速 retry
  const onTransportFailure = (statusCode, errStr) => {
    pingState.lastPingAt = new Date().toISOString();
    pingState.pingCount = (pingState.pingCount || 0) + 1;
    pingState.consecutiveTransportFailures = (pingState.consecutiveTransportFailures || 0) + 1;
    pingState.lastError = errStr;

    // 急停（2026-10-20，对齐社区 pi-kimi-keepalive）：
    // 401/403 = 凭据/配额问题，重试无意义 -> 立即 off；
    // 其余（429/5xx/超时）累计到 transportFailLimit 才 off，避免偶发抖动误杀。
    const fatal = statusCode === 401 || statusCode === 403;
    const exhausted = pingState.consecutiveTransportFailures >= config.transportFailLimit;
    if (fatal || exhausted) {
      pingState.stale = true;
      pingState.health = 'stale';
      pingState.on = false;
      if (pingTimers.has(key)) { clearInterval(pingTimers.get(key)); pingTimers.delete(key); }
      if (pingState.retryTimer) { clearTimeout(pingState.retryTimer); pingState.retryTimer = null; }
      console.log(`[ping] key=${key} AUTO-OFF: ${fatal ? 'fatal auth/quota error ' + errStr : config.transportFailLimit + ' consecutive transport failures'}`);
      return;
    }
    log({
      ts: new Date().toISOString(),
      path: rec.path,
      status: statusCode,
      kind: 'ping',
      key,
      model: rec.model || 'unknown',
      latency_ms: Date.now() - startMs,
      result: 'error',
      retry: pingState.retryCount || 0,
      error: errStr,
    });
    scheduleRetry(key);
  };

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
        const result = classifyPingResult(upRes.statusCode, usage);

        if (result === 'error') {
          // HTTP 429/5xx 等：transport/API 临时错误 -> retry，不算 cache miss
          onTransportFailure(upRes.statusCode, 'http-' + upRes.statusCode);
          return;
        }
        log({
          ts: new Date().toISOString(),
          path: rec.path,
          status: upRes.statusCode,
          kind: 'ping',
          key,
          model: rec.model || 'unknown',
          latency_ms: Date.now() - startMs,
          result,
          retry: pingState.retryCount || 0,
          usage,
        });
        console.log(`[ping] key=${key} status=${upRes.statusCode} result=${result} cache_read=${usage.cache_read_input_tokens || 0} cache_creation=${usage.cache_creation_input_tokens || 0}`);
        pingState.lastPingAt = new Date().toISOString();
        pingState.pingCount = (pingState.pingCount || 0) + 1;
        pingState.lastUsage = usage;
        pingState.lastError = null;
        pingState.health = result; // 'hit' | 'recreated' | 'no-cache'
        pingState.consecutiveTransportFailures = 0;
        pingState.retryCount = 0;

        // 花费上限（2026-10-20）：累计估算成本，达到上限立即急停
        const cost = estimatePingCostUsd(usage);
        pingState.spentUsd = (pingState.spentUsd || 0) + cost;
        if (config.spendCapUsd > 0 && pingState.spentUsd >= config.spendCapUsd) {
          pingState.stale = true;
          pingState.health = 'stale';
          pingState.on = false;
          if (pingTimers.has(key)) { clearInterval(pingTimers.get(key)); pingTimers.delete(key); }
          if (pingState.retryTimer) { clearTimeout(pingState.retryTimer); pingState.retryTimer = null; }
          console.log(`[ping] key=${key} AUTO-OFF: spend cap reached ($${pingState.spentUsd.toFixed(4)} >= $${config.spendCapUsd})`);
          return;
        }

        if (result === 'no-cache') {
          // 2xx 但命中率低于门槛（或读写皆 0）：算一次 cache 失败。
          // 连续 failThreshold 次（默认 2）-> 置 stale 并自动关闭 ping，止损不烧钱。
          pingState.consecutiveZeroCacheRead = (pingState.consecutiveZeroCacheRead || 0) + 1;
          // 2026-10-20：单个 50min 间隔周期内只会 ping 一次，靠"连续 N 次"要等 100 分钟，
          // 期间每次都是全价重算 —— 太慢。首次 immediate ping 就低命中即视为失败并关闭
          // （用户要求："命中门槛不应太高，否则认为失败并关闭 ping"）。
          if (pingState.consecutiveZeroCacheRead >= config.failThreshold) {
            pingState.stale = true;
            pingState.health = 'stale';
            pingState.on = false;
            if (pingTimers.has(key)) {
              clearInterval(pingTimers.get(key));
              pingTimers.delete(key);
            }
            if (pingState.retryTimer) {
              clearTimeout(pingState.retryTimer);
              pingState.retryTimer = null;
            }
            console.log(`[ping] key=${key} AUTO-OFF: ${pingState.consecutiveZeroCacheRead} consecutive cache-miss pings (ratio < ${config.hitRatioMin}) — stopped to avoid burning quota`);
          }
        } else {
          pingState.consecutiveZeroCacheRead = 0;
        }
      });
    }
  );

  upReq.setTimeout(config.pingTimeoutMs, () => {
    upReq.destroy(new Error('ping-timeout'));
  });

  upReq.on('error', (e) => {
    onTransportFailure(502, String(e && e.message ? e.message : e));
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
        health: p.health || null,
        spentUsd: Number((p.spentUsd || 0).toFixed(4)),
        waitingForRequest: p.waitingForRequest === true,
        retryCount: p.retryCount || 0,
        lastError: p.lastError || null,
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
      let intervalMin = body.intervalMin !== undefined ? Number(body.intervalMin) : 45;
      if (!Number.isInteger(intervalMin) || intervalMin < 1 || intervalMin > 720) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid-interval' }));
        return;
      }
      if (!recordedRequests.has(key)) {
        // 无已记录请求体（典型场景：sidecar 重启丢内存）：仍返回 409,
        // 但记录保温意图——下一次真实请求到达时自动开始 ping 循环,
        // 控制面据此显示 WAITING FOR REAL REQUEST 而非假 ACTIVE。
        const prev = pings.get(key) || {};
        pings.set(key, {
          key,
          on: true,
          intervalMin,
          lastPingAt: prev.lastPingAt || null,
          pingCount: prev.pingCount || 0,
          stale: false,
          health: 'waiting',
          waitingForRequest: true,
          lastUsage: prev.lastUsage || null,
          lastError: null,
          retryCount: 0,
          retryTimer: null,
          consecutiveZeroCacheRead: prev.consecutiveZeroCacheRead || 0,
          consecutiveTransportFailures: 0,
          spentUsd: prev.spentUsd || 0,
        });
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'no-request-recorded',
          waiting: true,
          state: { key, on: true, intervalMin, health: 'waiting', waitingForRequest: true },
        }));
        return;
      }

      // 幂等短路（2026-10-20 生产事故修复）：reconciler 每分钟对所有 on 会话
      // 补挂 /control/on。旧实现每次调用都 clearInterval + 清空 retryTimer +
      // setImmediate(runPing) —— 导致每个 on 的 key 每分钟白 ping 一次
      // （实测 45min 内 pingCount=48，烧 cache-read quota），且 P0-2 的
      // +2/+4min 快速 retry 定时器每分钟被清空、retryCount 归零，retry 机制
      // 在生产实际失效。已健康运行的 key（on + 同间隔 + 定时器在 + 非 stale/
      // waiting）一律视为 no-op，直接返回现状。
      const cur = pings.get(key);
      if (cur && cur.on && cur.intervalMin === intervalMin && pingTimers.has(key)
          && !cur.stale && !cur.waitingForRequest) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          alreadyOn: true,
          immediatePing: false,
          state: {
            key: cur.key,
            on: cur.on,
            intervalMin: cur.intervalMin,
            lastPingAt: cur.lastPingAt,
            pingCount: cur.pingCount,
            stale: cur.stale,
            health: cur.health,
            waitingForRequest: cur.waitingForRequest,
            lastUsage: cur.lastUsage,
          },
        }));
        return;
      }

      if (pingTimers.has(key)) {
        clearInterval(pingTimers.get(key));
        pingTimers.delete(key);
      }
      const existing = pings.get(key) || {};
      if (existing.retryTimer) {
        clearTimeout(existing.retryTimer);
        existing.retryTimer = null;
      }
      // 2026-10-20：完整重置路径必须继承失败计数——旧实现每次归零，
      // 而 reconciler 每分钟补挂一次，导致"连续 N 次 miss 自动关闭"永不触发。
      // stale 状态由显式 /control/on 清除（用户主动重开），但计数保留以便继续观察。
      const state = {
        key,
        on: true,
        intervalMin,
        lastPingAt: existing.lastPingAt || null,
        pingCount: existing.pingCount || 0,
        stale: false,
        health: existing.health === 'waiting' ? null : (existing.health || null),
        waitingForRequest: false,
        lastUsage: existing.lastUsage || null,
        lastError: null,
        retryCount: 0,
        retryTimer: null,
        consecutiveZeroCacheRead: existing.consecutiveZeroCacheRead || 0,
        consecutiveTransportFailures: 0,
        spentUsd: existing.spentUsd || 0,
      };
      pings.set(key, state);
      const timer = setInterval(() => runPing(key), intervalMin * 60 * 1000);
      if (timer.unref) timer.unref();
      pingTimers.set(key, timer);

      // 开启即立即执行一次 ping（不等首个 interval），结果经 /control/state 轮询可见。
      // runPing 内的 <10s 真实请求顺延 30s 保护对此同样生效。
      setImmediate(() => runPing(key));

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        immediatePing: true,
        state: {
          key: state.key,
          on: state.on,
          intervalMin: state.intervalMin,
          lastPingAt: state.lastPingAt,
          pingCount: state.pingCount,
          stale: state.stale,
          health: state.health,
          waitingForRequest: state.waitingForRequest,
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
        const p = pings.get(key);
        p.on = false;
        p.waitingForRequest = false;
        if (p.retryTimer) {
          clearTimeout(p.retryTimer);
          p.retryTimer = null;
        }
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
        const ttlMark = injectCacheTtl(j, req.url);
        if (ttlMark) injected.push(ttlMark);
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
            // waiting 状态（sidecar 重启后 /control/on 409 记录的保温意图）：
            // 真实请求到达 -> 请求体已记录，立即恢复 ping 循环
            const wasWaiting = p.waitingForRequest === true;
            if (wasWaiting) {
              p.waitingForRequest = false;
              p.health = null;
              console.log(`[ping] key=${currentKey} real request arrived, leaving waiting state`);
            }
            if (p.stale) {
              p.stale = false;
              p.consecutiveZeroCacheRead = 0;
              console.log(`[ping] key=${currentKey} cleared stale by real traffic`);
            }
            if (p.on && !pingTimers.has(currentKey)) {
              const timer = setInterval(() => runPing(currentKey), p.intervalMin * 60 * 1000);
              if (timer.unref) timer.unref();
              pingTimers.set(currentKey, timer);
              // waiting 恢复时立即 ping 一次确认 cache 状态（受 <10s 顺延 30s 保护约束）
              if (wasWaiting) setImmediate(() => runPing(currentKey));
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
  classifyPingResult,
  injectCacheTtl,
  isChatCompletionsPath,
  runPing,
  sessions,
  recordedRequests,
  pings,
  pingTimers,
  config,
  PORT,
};
