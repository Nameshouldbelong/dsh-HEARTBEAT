#!/usr/bin/env node
/**
 * HB 保温监控：每 30 秒采样一次 /control/state，记录指定 key 的
 * health / pingCount / spentUsd / lastUsage，直到该 key 的 pingCount 达到目标后
 * 再持续观测一小段时间，最后写 JSON 报告 + 人读摘要。
 *
 * 用法：node scripts/hb-monitor.mjs --key dshsc-xxx --target 4 --tail-min 6
 *   --target   : 期望看到的累计 ping 次数（1 次 immediate + N 次周期）
 *   --tail-min : 达到目标后再观察多少分钟
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const KEY = arg('key', '');
const TARGET = parseInt(arg('target', '4'), 10);
const TAIL_MIN = parseFloat(arg('tail-min', '6'));
const INTERVAL_S = parseInt(arg('interval-s', '30'), 10);
const OUT = arg('out', path.join(os.tmpdir(), 'hb-monitor.json'));
const SIDECAR = process.env.SIDECAR_URL || 'http://127.0.0.1:8791';

if (!KEY) { console.error('missing --key'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function state() {
  const u = new URL('/control/state', SIDECAR);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: 10000 }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

const samples = [];
let maxPing = 0;
const t0 = Date.now();
let reachedAt = null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

log(`monitor start key=${KEY} target=${TARGET} tail=${TAIL_MIN}min`);

for (;;) {
  let s = null;
  try { s = await state(); } catch (e) { log('state error', String(e)); await sleep(INTERVAL_S * 1000); continue; }
  const p = (s.pings || []).find((x) => x.key === KEY);
  if (p) {
    maxPing = Math.max(maxPing, p.pingCount || 0);
    samples.push({
      t: new Date().toISOString(),
      el: Math.round((Date.now() - t0) / 1000),
      on: p.on, health: p.health, pingCount: p.pingCount,
      spentUsd: p.spentUsd || 0, retryCount: p.retryCount || 0,
      cached: (p.lastUsage && (p.lastUsage.prompt_tokens_details?.cached_tokens ?? p.lastUsage.cache_read_input_tokens)) || 0,
      prompt: (p.lastUsage && p.lastUsage.prompt_tokens) || 0,
      lastPingAt: p.lastPingAt,
    });
    log(`ping=${p.pingCount}/${TARGET} on=${p.on} health=${p.health} spent=$${(p.spentUsd || 0).toFixed(5)} cached=${samples.at(-1).cached}/${samples.at(-1).prompt}`);
    if (maxPing >= TARGET && reachedAt === null) reachedAt = Date.now();
  } else {
    log('key not found (已 off 或被清理)');
  }
  if (reachedAt !== null && Date.now() - reachedAt >= TAIL_MIN * 60 * 1000) break;
  if (Date.now() - t0 > 3 * 60 * 60 * 1000) { log('hard timeout 3h'); break; }
  await sleep(INTERVAL_S * 1000);
}

const hitCount = samples.filter((x) => x.health === 'hit').length;
const missCount = samples.filter((x) => x.health === 'no-cache').length;
const errCount = samples.filter((x) => x.health === 'retrying' || x.health === 'stale').length;
const result = {
  key: KEY, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(),
  totalSamples: samples.length,
  summary: { hitCount, missCount, errCount, maxPingCount: maxPing, finalSpentUsd: samples.at(-1)?.spentUsd ?? 0 },
  samples: samples.filter((_, i) => i % 2 === 0), // 减半存储，保留趋势
};
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
log(`done → ${OUT}`);
log(`summary: hit=${hitCount} miss=${missCount} err=${errCount} maxPing=${maxPing} spent=$${(result.summary.finalSpentUsd).toFixed(5)}`);
