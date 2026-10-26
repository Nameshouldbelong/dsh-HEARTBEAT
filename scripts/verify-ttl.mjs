#!/usr/bin/env node
/**
 * TTL 1h 生效性验证（2026-10-20）
 *
 * 目的：确认 Kimi Chat Completions 端点在 prompt_cache_options.ttl="1h" 下，
 * 缓存能否存活超过默认 5 分钟档。
 *
 * 方法（干净对照）：
 *   1. 发请求 A（ttl=1h），写入缓存，记录 usage
 *   2. 等待 > 5 分钟（默认 5m 档必然过期）
 *   3. 发请求 B（完全相同前缀，ttl=1h）
 *      - B 命中缓存（cached_tokens 比例高）=> 1h TTL 生效
 *      - B 全 miss => 1h TTL 未生效（仍按 5m 处理）
 *
 * 判据：命中率 >= 50% 视为 1h 生效（保守，避免块对齐噪声）。
 *
 * 用法：node scripts/verify-ttl.mjs [--wait-min 6.5] [--model k3-256k]
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const WAIT_MIN = parseFloat(arg('wait-min', '6.5'));
const MODEL = arg('model', 'k3-256k');
const SIDECAR = process.env.SIDECAR_URL || 'http://127.0.0.1:8791';
const OUT = arg('out', path.join(os.tmpdir(), 'ttl-verify-result.json'));

// 固定前缀（约 12k 字符，确保跨过缓存块粒度），不含任何动态字段
const STABLE_SYSTEM = [
  'You are a deterministic cache-verification assistant.',
  'The following reference block is intentionally long and byte-stable so that',
  'prefix caching has a substantial reusable region to match against.',
  ...Array.from({ length: 600 }, (_, i) =>
    `Reference line ${String(i + 1).padStart(3, '0')}: the quick brown fox jumps over the lazy dog while ` +
    `deterministic filler text keeps this prefix stable across requests.`),
].join('\n');

function readToken() {
  const credPath = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  const text = fs.readFileSync(credPath, 'utf8');
  const m = text.match(/KIMI_CODING_API_KEY:\s*([A-Za-z0-9_\-.]+)/);
  if (!m) throw new Error('KIMI_CODING_API_KEY not found in credentials');
  return m[1];
}

function post(token, body) {
  const url = new URL('/v1/chat/completions', SIDECAR);
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', timeout: 180000,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        authorization: 'Bearer ' + token,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, raw: text.slice(0, 400) });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

const buildBody = (tag) => ({
  model: MODEL,
  max_tokens: 16,
  messages: [
    { role: 'system', content: STABLE_SYSTEM },
    { role: 'user', content: tag },
  ],
  prompt_cache_options: { mode: 'implicit', ttl: '1h' },
});

function usageOf(res) {
  const u = (res.json && res.json.usage) || {};
  const prompt = Number(u.prompt_tokens || 0);
  const cached = Number(
    (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ?? u.cached_tokens ?? 0);
  const write = Number(
    (u.prompt_tokens_details && u.prompt_tokens_details.cache_write_tokens) ?? 0);
  return { prompt, cached, write, ratio: prompt ? cached / prompt : 0 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const token = readToken();
  const result = {
    startedAt: new Date().toISOString(),
    model: MODEL,
    waitMin: WAIT_MIN,
    steps: [],
    verdict: null,
  };

  log('== 步骤 1：请求 A（写入 1h 缓存）==');
  const a = await post(token, buildBody('warmup-a'));
  const ua = usageOf(a);
  log(`A status=${a.status} prompt=${ua.prompt} cached=${ua.cached} write=${ua.write} ratio=${(ua.ratio * 100).toFixed(1)}%`);
  result.steps.push({ step: 'A', status: a.status, ...ua, at: new Date().toISOString() });
  if (a.status !== 200) {
    log('A 失败，原始响应：', a.raw);
    result.verdict = { ok: false, reason: `request A failed: HTTP ${a.status}`, raw: a.raw };
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    return;
  }

  // 步骤 2：立刻重放一次，确认基线（此时 5m 池必然有效）
  log('== 步骤 2：请求 A2（基线，间隔数秒）==');
  await sleep(3000);
  const a2 = await post(token, buildBody('warmup-a'));
  const ua2 = usageOf(a2);
  log(`A2 status=${a2.status} prompt=${ua2.prompt} cached=${ua2.cached} ratio=${(ua2.ratio * 100).toFixed(1)}%`);
  result.steps.push({ step: 'A2', status: a2.status, ...ua2, at: new Date().toISOString() });

  // 步骤 3：等待超过 5 分钟
  const waitMs = Math.round(WAIT_MIN * 60 * 1000);
  log(`== 步骤 3：等待 ${WAIT_MIN} 分钟（超过默认 5m 档）==`);
  let remaining = waitMs;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 240000);
    await sleep(chunk);
    remaining -= chunk;
    if (remaining > 0) log(`  剩余 ${(remaining / 60000).toFixed(1)} 分钟`);
  }

  // 步骤 4：请求 B（与 A 同前缀，看是否仍命中）
  log('== 步骤 4：请求 B（等待后重放）==');
  const b = await post(token, buildBody('warmup-a'));
  const ub = usageOf(b);
  log(`B status=${b.status} prompt=${ub.prompt} cached=${ub.cached} write=${ub.write} ratio=${(ub.ratio * 100).toFixed(1)}%`);
  result.steps.push({ step: 'B', status: b.status, ...ub, at: new Date().toISOString() });

  // 判定
  const baselineOk = ua2.ratio >= 0.5;
  const afterWaitOk = ub.ratio >= 0.5;
  if (b.status !== 200) {
    result.verdict = { ok: false, reason: `request B failed: HTTP ${b.status}`, raw: b.raw };
  } else if (!baselineOk) {
    result.verdict = {
      ok: false,
      reason: '基线未命中：即使间隔数秒也未命中缓存，实验前提不成立（前缀可能每次变化或缓存未启用）',
      baselineRatio: ua2.ratio,
    };
  } else if (afterWaitOk) {
    result.verdict = {
      ok: true,
      reason: `等待 ${WAIT_MIN} 分钟后仍命中 ${(ub.ratio * 100).toFixed(1)}% —— 1h TTL 生效`,
      baselineRatio: ua2.ratio,
      afterWaitRatio: ub.ratio,
    };
  } else {
    result.verdict = {
      ok: false,
      reason: `等待 ${WAIT_MIN} 分钟后命中率仅 ${(ub.ratio * 100).toFixed(1)}%（基线 ${(ua2.ratio * 100).toFixed(1)}%）—— 1h TTL 未生效，仍按 5m 档过期`,
      baselineRatio: ua2.ratio,
      afterWaitRatio: ub.ratio,
    };
  }
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  log('== 结论 ==');
  log(result.verdict.ok ? '✅ ' + result.verdict.reason : '❌ ' + result.verdict.reason);
  log('结果已写入', OUT);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
