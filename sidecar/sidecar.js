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

const PORT = parseInt(process.env.SIDECAR_PORT || '8791', 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'api.kimi.com';
const UPSTREAM_PREFIX = process.env.UPSTREAM_PREFIX || '/coding';
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

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, inject_ttl: INJECT_TTL, inject_affinity: INJECT_AFFINITY, upstream: UPSTREAM_HOST + UPSTREAM_PREFIX }));
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    const injected = [];
    const ct = (req.headers['content-type'] || '').toLowerCase();
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
        }
        body = Buffer.from(JSON.stringify(j), 'utf8');
      } catch (e) {
        injected.push('body-parse-fail');
      }
    }
    const headers = Object.assign({}, req.headers, {
      host: UPSTREAM_HOST,
      'content-length': body.length,
      'accept-encoding': 'identity',
    });
    delete headers.connection;
    const upReq = https.request(
      { hostname: UPSTREAM_HOST, port: 443, path: UPSTREAM_PREFIX + req.url, method: req.method, headers },
      (upRes) => {
        const respChunks = [];
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.on('data', (c) => { respChunks.push(c); res.write(c); });
        upRes.on('end', () => {
          res.end();
          const txt = Buffer.concat(respChunks).toString('utf8');
          const usage = extractUsage(txt);
          log({ ts: new Date().toISOString(), path: req.url, status: upRes.statusCode, injected, usage });
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

server.listen(PORT, '127.0.0.1', () => console.log('kimi-cache-sidecar listening on 127.0.0.1:' + PORT + ' -> https://' + UPSTREAM_HOST + UPSTREAM_PREFIX));
