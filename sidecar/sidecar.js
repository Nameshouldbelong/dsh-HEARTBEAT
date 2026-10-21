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

// 2026-10-21 v2：亲和键改为「会话级唯一」。
// DSH 插件在真实请求的 metadata.user_id 写入 `dsh:<sessionId>`（纯净形式），sidecar 原样
// 沿用并派生稳定 key —— 同一会话 key 恒定、不同会话绝不复用，从根上消灭 KI-1（多会话同
// system prompt 撞同一 key、recordedRequests 互相覆盖）与 KI-3（system 漂移导致 key 漂移）。
// 兼容形态：① `dsh:session-xxx`（插件注入）② `dshsc-<hash>`（已是 key）③ 裸 `session-xxx`。
// 三者都没有时退回 system 前缀哈希（旧行为，仅兜底；此时 synthesized=true）。
const SESSION_USER_PREFIX = 'dsh:';
// DSH 会话 id 形状：session-<uuid v4>。runtime context 会把「你的会话 ID：session-xxx」
// 注入到最新一条 user message 里，所以从 messages 文本也能稳定提取（兜底通道）。
const SESSION_ID_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

function sessionIdFromUserId(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return null;
  if (s.startsWith('dshsc-')) return s;            // 已是 key 形态，直接用作 session 标识
  if (s.startsWith(SESSION_USER_PREFIX)) return s.slice(SESSION_USER_PREFIX.length) || null;
  return s;
}

// 从 messages 文本里提取会话 id（2026-10-21 新增的兜底通道）。
//
// 关键约束：只能看 **user 消息**，且只取最后一条带命中的。
// 原因（2026-10-21 自查发现的坑）：DSH 的 runtime context 把
// 「你的会话 ID：session-xxx」注入到最新的一条 user message，因此 user 消息
// 是权威来源。但 assistant 消息/工具结果里经常会**引用别的会话 id**
// （例如助手在回复中列出正在讨论的另一个会话），若一并扫描，本会话
// 的 key 会被绑定到那个被引用的会话上 —— 正是我们要消灭的那类错误。
// messages 里 role 缺失时按 user 处理（部分客户端省略 role）。
function sessionIdFromMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' ? m.role.toLowerCase() : 'user';
    if (role !== 'user') continue;
    const c = m.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p && typeof p.text === 'string') text += p.text + '\n';
      }
    }
    if (!text) continue;
    const hits = text.match(new RegExp(SESSION_ID_RE.source, 'g'));
    if (!hits || hits.length === 0) continue;
    // 同一条 user 消息里出现多个 id 时，优先取紧跟「会话 ID」/「session ID」标记的那个
    // （runtime context 的固定措辞），否则退回最后一个（最新上下文通常在最前，
    // 但 system-reminder 类追加在后，故取末位更稳）。
    const marker = text.match(/(?:会话\s*ID|session\s*ID)\s*[：:]\s*(session-[0-9a-f-]{36})/i);
    if (marker) return marker[1];
    return hits[hits.length - 1];
  }
  return null;
}

function makeSessionKey(sessionId) {
  return 'dshsc-' + crypto.createHash('sha256').update('session:' + sessionId).digest('hex').slice(0, 16);
}

/**
 * 解析一次请求的会话身份。优先级（越靠前越可信，keySource 记进遥测便于审计）：
 *   prompt_cache_key  >  metadata.user_id  >  messages 文本里的 session-xxx  >  system 前缀哈希
 * 前三者都是「会话级唯一」，只有第四者是旧行为（多会话同 system 会碰撞，仅兜底）。
 */
function resolveIdentity(j) {
  if (typeof j.prompt_cache_key === 'string' && j.prompt_cache_key.trim()) {
    const sess = j.prompt_cache_key.trim();
    return { id: makeSessionKey(sess), sessionId: sess, keySource: 'prompt_cache_key', synthesized: false };
  }
  if (j.metadata && j.metadata.user_id) {
    const sess = sessionIdFromUserId(j.metadata.user_id);
    if (sess) {
      const isKey = sess.startsWith('dshsc-');
      return {
        id: isKey ? sess : makeSessionKey(sess),
        sessionId: isKey ? null : sess,
        keySource: isKey ? 'user_id-key' : 'user_id',
        synthesized: false,
      };
    }
  }
  const fromMsg = sessionIdFromMessages(j.messages);
  if (fromMsg) {
    return { id: makeSessionKey(fromMsg), sessionId: fromMsg, keySource: 'messages-scan', synthesized: false };
  }
  return null;
}

function affinityKey(j) {
  // 会话级唯一优先（prompt_cache_key / metadata.user_id / messages 扫描），
  // 全都没有才退回 system 前缀哈希（旧行为，此时 synthesized=true 且 sessionId=null）。
  const ident = resolveIdentity(j);
  if (ident) return ident;
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
  return {
    id: 'dshsc-' + crypto.createHash('sha256').update(sys.slice(0, 8000)).digest('hex').slice(0, 16),
    synthesized: true,
    sessionId: null,
    keySource: 'system-hash',
  };
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
  const details = merged.prompt_tokens_details || {};
  const cached = Number(details.cached_tokens ?? merged.cached_tokens ?? 0);
  if (cached > 0 && merged.cache_read_input_tokens == null) {
    merged.cache_read_input_tokens = cached;
  }
  // 2026-10-22 审计修复（codex DEBUG-PLAN §3）：Chat Completions 的**缓存写入**字段
  // 未归一化 → 纯写缓存的一次 ping 会被判成 no-cache 并计入失败，
  // 进而触发命中墙误关。OpenAI 系端点写缓存时 cached_tokens=0 而写字段>0。
  const writeTokens = Number(
    details.cache_write_tokens ??
    details.cache_creation_tokens ??
    merged.cache_write_input_tokens ??
    0);
  if (writeTokens > 0 && merged.cache_creation_input_tokens == null) {
    merged.cache_creation_input_tokens = writeTokens;
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

// ── KI-2 修复（2026-10-21）：保温中的请求体落盘 ────────────────────────────
// 原实现 recordedRequests 纯内存，sidecar 每次重启（部署/崩溃/系统重启）即丢失，
// 之后必须等会话**再说话一次**才能恢复 ping。而实测缓存只活 28–45min，
// 重启到下次真实请求之间等于保温完全失效 —— 这正是"悄悄不保温"的另一条路径。
//
// 安全约束（请求体含完整 system prompt 与对话历史，必须严格对待）：
//   ① 文件权限 0600，目录 0700；
//   ② **只持久化当前 on 的 key**（不保温的一律不落盘）；
//   ③ `/control/off` 与 reconciler 清理会话时立即删除对应条目；
//   ④ 单条 > MAX_PERSIST_BYTES 的不落盘（超大会话宁可不恢复，也不写巨量隐私数据）；
//   ⑤ 条目带 updatedAt，加载时丢弃超过 MAX_PERSIST_AGE_MS 的陈旧数据。
const PERSIST_DIR = path.join(__dirname, 'persist');
const PERSIST_FILE = path.join(PERSIST_DIR, 'request-bodies.json');
// 保温开关状态（pings）也持久化：否则 sidecar 重启后 ping 循环全丢，
// 而插件要等下一个 10min 对账周期才补挂 —— 这段时间缓存可能已经过期。
const PINGS_FILE = path.join(PERSIST_DIR, 'pings.json');
const MAX_PERSIST_BYTES = 8 * 1024 * 1024;   // 单条请求体上限
const MAX_PERSIST_AGE_MS = 12 * 60 * 60 * 1000; // 12h 后视为陈旧

// ── 持久化核心（2026-10-21 二次修复，针对"请求体莫名消失"）─────────────
// 旧实现的三个结构性缺陷，全部在此修掉：
//   ① persistBodies() 只写「pings.get(key).on === true」的条目 →
//      没有 ping 记录（刚建 body 还没 on）的 key 被静默跳过；
//   ② 整个文件用「当前内存快照」覆写 → 任一次扫描时内存是空的，
//      就把磁盘上的历史数据全抹成 {}（19:53/19:54 的两次重启就是这么丢的）；
//   ③ 恢复顺序 bodies → pings，恢复后若立刻触发一次 persistBodies，
//      此时 pings 尚未装载 → 判定"没有 on 的 key" → 再次清空。
// 新策略：**读旧文件 → 合并 → 写回**，并且删除只发生在
//   (a) 显式 /control/off；(b) 超过 TTL。永不由"扫描为空"触发删除。
function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return fallback;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch (e) {
    console.log('[persist] read failed', file, String(e && e.message ? e.message : e));
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(PERSIST_DIR, { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function persistBodies() {
  try {
    const now = Date.now();
    const old = readJsonFile(PERSIST_FILE, {});
    const merged = {};

    // 先保留磁盘上的旧条目（未过期且未被手删），再叠加内存里的最新状态
    for (const [key, v] of Object.entries(old)) {
      if (v && v.body && now - (v.updatedAt || 0) <= MAX_PERSIST_AGE_MS) merged[key] = v;
    }

    let added = 0;
    for (const [key, rec] of recordedRequests.entries()) {
      if (!rec || !rec.body) continue;
      if (rec.body.length > MAX_PERSIST_BYTES) continue;
      const p = pings.get(key);
      const onNow = !!(p && p.on);
      const known = merged[key];
      // 只增不减：正在保温的，或磁盘上已有该 key（说明曾经被要求保温）→ 更新
      if (!onNow && !known) continue;
      merged[key] = {
        body: rec.body.toString('base64'),
        path: rec.path,
        model: rec.model,
        sessionId: rec.sessionId || null,
        lastSeenMs: rec.lastSeenMs,
        updatedAt: now,
        on: onNow,
      };
      added++;
    }

    writeJsonAtomic(PERSIST_FILE, merged);
    return { kept: Object.keys(merged).length, updated: added };
  } catch (e) {
    console.log('[persist] write failed:', String(e && e.message ? e.message : e));
    return null;
  }
}


// ── 保温开关状态持久化（pings）────────────────────────────────────────────
// 只存「用户意图」相关字段：key/on/intervalMin/累计计数。不存 timer 句柄。
function persistPings() {
  try {
    const now = Date.now();
    const old = readJsonFile(PINGS_FILE, {});
    const merged = {};

    // 保留磁盘上仍在 TTL 内、且内存里没有对应条目的旧记录（防止一次空扫描清空）
    for (const [key, v] of Object.entries(old)) {
      if (v && v.on && now - (v.updatedAt || 0) <= MAX_PERSIST_AGE_MS && !pings.has(key)) {
        merged[key] = v;
      }
    }

    let live = 0;
    for (const [key, p] of pings.entries()) {
      // 内存里**明确关掉**的 key：不写入（等同删除，这是唯一合法的删除途径）
      if (!p || !p.on) continue;
      merged[key] = {
        key,
        on: true,
        intervalMin: p.intervalMin,
        pingCount: p.pingCount || 0,
        lastPingAt: p.lastPingAt || null,
        spentUsd: p.spentUsd || 0,
        consecutiveZeroCacheRead: p.consecutiveZeroCacheRead || 0,
        waitingForRequest: p.waitingForRequest === true,
        updatedAt: now,
      };
      live++;
    }

    writeJsonAtomic(PINGS_FILE, merged);
    return { kept: Object.keys(merged).length, live };
  } catch (e) {
    console.log('[persist] pings write failed:', String(e && e.message ? e.message : e));
    return null;
  }
}


function persistDeleteKey(key) {
  try {
    for (const file of [PERSIST_FILE, PINGS_FILE]) {
      if (!fs.existsSync(file)) continue;
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (obj[key] === undefined) continue;
      delete obj[key];
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  } catch (e) {}
}

function loadPersistedBodies() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return 0;
    const obj = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
    const now = Date.now();
    let n = 0;
    for (const [key, v] of Object.entries(obj || {})) {
      if (!v || !v.body) continue;
      if (now - (v.updatedAt || 0) > MAX_PERSIST_AGE_MS) continue;  // ⑤
      recordedRequests.set(key, {
        body: Buffer.from(v.body, 'base64'),
        path: v.path,
        headers: {},              // 头（含 auth）**不落盘**，ping 时用环境里的 key 重建
        model: v.model,
        sessionId: v.sessionId || null,
        lastSeenMs: v.lastSeenMs || 0,
        restored: true,
      });
      n++;
    }
    return n;
  } catch (e) {
    console.log('[persist] load failed:', String(e && e.message ? e.message : e));
    return 0;
  }
}

/**
 * 启动自检 + 持续一致性巡检（2026-10-21 新增）。
 *
 * 为什么需要：10-21 事故里 UI 显示 `ON · hit`（34 次 ping 全命中），但实际上
 * 保温打在一个 90 token 的测试前缀上 —— **"看起来正常"是最危险的失败态**。
 * 之后又出现「pings.json 说开着、request-bodies.json 却没有 body」的组合，
 * 那时 UI 显示 waiting，同样看不出异常。
 *
 * 本函数把这类"状态自相矛盾"显式成 alarms，供 /control/state 与 HB 面板展示：
 *   · missing-body       — on=true 但没有请求体 → 无法 ping（重启丢数据 / 刚开未说话）
 *   · body-not-persisted — 内存有 body，磁盘却没有 → 下次重启会丢（写盘失败）
 *   · ping-loop-missing  — on=true 且有 body，但定时器不存在 → 循环已死
 *   · stale-no-traffic   — 超过 45min 没有真实请求（缓存实测寿命上限）→ 保温大概率已失效
 *   · tiny-prefix        — 前缀过小（<2k token）→ 极可能是测试/错误 key，不是真实会话
 *
 * @returns {{ok: boolean, checkedAt: string, alarms: Array<{key:string,code:string,severity:string,detail:string}>}}
 */
function runSelfCheck() {
  const now = Date.now();
  const alarms = [];
  let diskBodies = null;
  try {
    const p = PERSIST_FILE;
    diskBodies = new Set(fs.existsSync(p) ? Object.keys(readJsonFile(p, {})) : []);
  } catch {
    diskBodies = null;
  }

  for (const [key, p] of pings.entries()) {
    if (!p || !p.on) continue;  // 只检查"声称开着"的
    const rec = recordedRequests.get(key);
    const hasTimer = pingTimers.has(key);
    const s = sessions.get(key);

    if (!rec) {
      alarms.push({
        key,
        code: 'missing-body',
        severity: 'error',
        detail: '保温已开启但 sidecar 没有该会话的请求体：无法 ping。等该会话下一次真实请求即可自动恢复；若长期不恢复，说明请求体在重启时丢失。',
      });
      // 不要 continue：没有 body 时定时器同样属于"该有却没有"，一并报出来
      if (!hasTimer) {
        alarms.push({
          key,
          code: 'ping-loop-missing',
          severity: 'error',
          detail: '保温标记为开启，但 ping 定时器不存在：循环已停止。',
        });
      }
      continue;
    }

    if (diskBodies && !diskBodies.has(key)) {
      alarms.push({
        key,
        code: 'body-not-persisted',
        severity: 'warn',
        detail: '内存里有请求体但磁盘上没有：下次重启会丢失，请检查 persist 目录写权限。',
      });
    }

    if (!hasTimer) {
      alarms.push({
        key,
        code: 'ping-loop-missing',
        severity: 'error',
        detail: '保温标记为开启且有请求体，但 ping 定时器不存在：循环已停止。',
      });
    }

    const lastReal = Number((rec && rec.lastSeenMs) || 0);
    if (lastReal > 0 && now - lastReal > 45 * 60 * 1000) {
      alarms.push({
        key,
        code: 'stale-no-traffic',
        severity: 'warn',
        detail: `已 ${Math.round((now - lastReal) / 60000)} 分钟没有真实请求。实测缓存寿命上限 45min，保温大概率已经失效，下一次请求会是全价冷读。`,
      });
    }

    const prefix = Number((s && (s.lastPromptTokens || s.lastInputTokens)) || (rec && rec.lastPromptTokens) || 0);
    if (prefix > 0 && prefix < 2000) {
      alarms.push({
        key,
        code: 'tiny-prefix',
        severity: 'warn',
        detail: `前缀只有 ${prefix} token：极可能是测试请求或打错的 key，而非真实会话。请核对 HB 面板的「前缀」列。`,
      });
    }
  }

  return {
    ok: alarms.length === 0,
    checkedAt: new Date().toISOString(),
    alarms,
  };
}

/**
 * 启动时恢复保温循环（pings.json）。
 * 这是 KI-2 的另一半：只恢复请求体而不恢复 ping 循环，重启后仍要等插件
 * 下一个 10min 对账周期才补挂 —— 实测缓存只活 28–45min，这段空窗足够让缓存过期。
 * 有请求体才真正恢复定时器；没有则保持 waiting 语义等真实流量。
 */
function loadPersistedPings() {
  try {
    if (!fs.existsSync(PINGS_FILE)) return { restored: 0, waiting: 0 };
    const obj = JSON.parse(fs.readFileSync(PINGS_FILE, 'utf8'));
    const now = Date.now();
    let restored = 0;
    let waiting = 0;
    for (const [key, v] of Object.entries(obj || {})) {
      if (!v || !v.on) continue;
      if (now - (v.updatedAt || 0) > MAX_PERSIST_AGE_MS) continue;
      const hasBody = recordedRequests.has(key);
      pings.set(key, {
        key,
        on: true,
        intervalMin: v.intervalMin || 45,
        lastPingAt: v.lastPingAt || null,
        pingCount: v.pingCount || 0,
        stale: false,
        health: hasBody ? null : 'waiting',
        waitingForRequest: !hasBody,
        lastUsage: null,
        lastError: null,
        retryCount: 0,
        retryTimer: null,
        consecutiveZeroCacheRead: v.consecutiveZeroCacheRead || 0,
        consecutiveTransportFailures: 0,
        spentUsd: v.spentUsd || 0,
      });
      if (hasBody) {
        const timer = setInterval(() => runPing(key), (v.intervalMin || 45) * 60 * 1000);
        if (timer.unref) timer.unref();
        pingTimers.set(key, timer);
        restored++;
      } else {
        waiting++;
      }
    }
    return { restored, waiting };
  } catch (e) {
    console.log('[persist] pings load failed:', String(e && e.message ? e.message : e));
    return { restored: 0, waiting: 0 };
  }
}

// 可测试配置（测试可直接改写字段注入短计时）
const config = {
  pingTimeoutMs: parseInt(process.env.PING_TIMEOUT_MS || '120000', 10), // ping 上游超时（原实现无超时，卡死会静默）
  retryDelaysMs: [2 * 60 * 1000, 4 * 60 * 1000], // 临时错误快速抢救：+2min / +4min，不动主 interval
  recencyWindowMs: 10000, // 真实请求 <10s 内
  recencyDeferMs: 30000,  // 重放顺延 30s
  // 2026-10-20：命中率门槛（低门槛，用户要求"不应太高"）。
  // cached/prompt >= hitRatioMin 才算 hit；低于门槛视为失败计数。
  hitRatioMin: parseFloat(process.env.HIT_RATIO_MIN || '0.05'),
  // 单次命中墙（2026-10-21 用户裁定：这是**唯一**的自动关闭指征）。
  // 一次 ping 的 cached/prompt 低于门槛 = 缓存没有真正保温住（要么 TTL 过期，
  // 要么 key 打错对象），此时继续 ping 只会全价重算烧配额 —— 立即 off。
  // 注意：只按"单次命中率"判定，绝不累计成"总额上限"（见下）。
  failThreshold: parseInt(process.env.FAIL_THRESHOLD || '1', 10),
  // 价格（仅用于 /control/state 展示"估算花费"，**不再作为关闭条件**）。
  // kimi-k3 参考：input=$3/1M、cacheRead=$0.3/1M。
  priceInputPerM: parseFloat(process.env.PRICE_INPUT_PER_M || '3'),
  priceCacheReadPerM: parseFloat(process.env.PRICE_CACHE_READ_PER_M || '0.3'),
  // 2026-10-21 用户裁定 #1：**删除总额花费上限**（原 spendCapUsd）。
  // 订阅制套餐下 cache-read 在 5h 窗口内几乎不计费，按 API 价目表估的"总额"会
  // 误杀大前缀保温（531k 前缀单次 ping 估 $0.16，旧 $1 上限 6 次就关停）。
  // 关闭指征只剩：单次命中墙（上）、401/403 凭据急停。
  // ② 连续 transport 失败急停（429/5xx/超时）——保留，因为这类失败重试无益且会掩盖真实状态。
  transportFailLimit: parseInt(process.env.TRANSPORT_FAIL_LIMIT || '3', 10),
  // 注：曾有针对"距最后真实请求超过 N 分钟即停止探测"的空闲截断护栏，
  // 已按用户要求移除（2026-10-20）。原因：跨天长任务场景下保温仍有性价比，
  // 而该护栏与心跳间隔耦合（30min 间隔 + 90min 上限会在长任务中途关停）。
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
/**
 * 归一化"总输入 token"（2026-10-22 审计修复，codex DEBUG-PLAN §3）。
 *
 * 两种协议的语义不同，这是命中率算错分母的根源：
 *   · Anthropic：`input_tokens` **只含未命中部分**，缓存读写各在独立字段，
 *     故 totalInput = input_tokens + cache_read + cache_creation。
 *   · OpenAI/Chat Completions：`prompt_tokens` **已含**命中部分
 *     （cached_tokens 是它的子集），故 totalInput = prompt_tokens。
 * 用错语义会把真实命中率 0.1% 算成 99%（审计已复现该误判）。
 *
 * 判定依据：只要出现 Anthropic 专属字段（input_tokens 且无 prompt_tokens），
 * 或显式给了 cache_creation_input_tokens 而 prompt_tokens 缺失，就走 Anthropic 语义。
 */
function totalInputTokens(usage) {
  if (!usage) return 0;
  const read = Number(usage.cache_read_input_tokens || usage.cached_tokens || 0);
  const creation = Number(usage.cache_creation_input_tokens || usage.cache_creation_tokens || 0);
  const prompt = Number(usage.prompt_tokens || 0);
  const input = Number(usage.input_tokens || 0);

  // 有 prompt_tokens 且没有独立 input_tokens -> OpenAI 语义（prompt 已含缓存）
  if (prompt > 0 && input === 0) return prompt;

  // Anthropic 语义：三者相加
  if (input > 0 || read > 0 || creation > 0) return input + read + creation;

  return 0;
}

function classifyPingResult(statusCode, usage, hitRatioMin) {
  if (statusCode >= 200 && statusCode < 300) {
    const totalInput = totalInputTokens(usage);
    const read = Number((usage && usage.cache_read_input_tokens) || 0);
    const creation = Number((usage && (usage.cache_creation_input_tokens || usage.cache_creation_tokens)) || 0);
    const min = typeof hitRatioMin === 'number' ? hitRatioMin : config.hitRatioMin;
    // 命中率门槛（2026-10-20）：cached 很少（如 12800/291557 = 4.4%）时，
    // 绝大部分前缀仍按全价重算，不能算 hit。
    //
    // 2026-10-22 审计修复（codex DEBUG-PLAN §3）：**分母必须是 totalInput，
    // 即 read + creation + uncached**，不能只取 prompt_tokens。
    // Anthropic 语义下 input_tokens 只含未命中部分（不含缓存读写），
    // 用它当分母会让真实命中率 0.1% 的情形算成 99% 而误判 HIT —— 这正是
    // "低命中却显示健康"的另一条路径。prompt 规模完全未知时才退化为 read>0。
    if (totalInput > 0) {
      const ratio = read / totalInput;
      if (ratio < min) {
        // 有写入且读很少 = 本轮回建（recreated），比 no-cache 更精确；
        // 但两者都属于"没保住"，调用方都按失败计数处理。
        return creation > 0 ? 'recreated' : 'no-cache';
      }
      return 'hit';
    }
    if (read > 0) return 'hit';
    if (creation > 0) return 'recreated';
    // 完全没有 usage（某些代理会吞掉）→ 不能断言"没命中"，交上层按未知处理
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

/**
 * 释放 in-flight 锁并处理"在途期间又有人想 ping"的情况（2026-10-22 §5）。
 * 必须有单一路径，否则漏一个 return 就会把该 key 永久锁死。
 */
function releaseInFlight(key) {
  const st = pings.get(key);
  if (!st) return;
  st.inFlight = false;
  const wantMore = st.pendingPing === true;
  st.pendingPing = false;
  if (wantMore && st.on && !st.stale) {
    // 在途期间被请求过：等一拍再补一次，避免与刚结束的请求贴太近
    const t = setTimeout(() => runPing(key), 2000);
    if (t.unref) t.unref();
    st.deferTimer = t;
  }
}

function runPing(key) {
  const pingState = pings.get(key);
  if (!pingState || !pingState.on || pingState.stale) return;
  const rec = recordedRequests.get(key);
  if (!rec) return;

  // 单在途锁（2026-10-22 审计修复，codex DEBUG-PLAN §5）。
  // 旧实现下"主周期 + 快速 retry + 顺延 + 立即 ping"四条触发路径可各自
  // 发起上游请求：审计复现了同 key 峰值 2 个并发 ping。那不只是浪费——
  // 并发重放会让后到的响应覆盖先到的状态、互相清 retry 计数，
  // 并放大冷读风险（一个大前缀会话同时两个全价请求）。
  if (pingState.inFlight) {
    // 已有在途：只记录"又有人想 ping"，等本轮结束后按需补一次，绝不并发
    pingState.pendingPing = true;
    return;
  }

  // 并发保护：该 key 的真实请求 lastSeen <10s 时本次重放顺延 30s
  // (immediate ping / retry / 周期 ping 一律遵守)
  const now = Date.now();
  if (now - rec.lastSeenMs < config.recencyWindowMs) {
    const delayTimer = setTimeout(() => runPing(key), config.recencyDeferMs);
    if (delayTimer.unref) delayTimer.unref();
    // 保存句柄，使 OFF 能真正取消它（旧实现泄漏 timer）
    pingState.deferTimer = delayTimer;
    return;
  }
  pingState.inFlight = true;

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
    releaseInFlight(key);
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

    // 2026-10-21 用户裁定 #2：自动关闭（on=false）的判据**只**剩"单次命中墙"。
    // 传输类失败（429/5xx/超时）一律走快速 retry，耗尽后置 stale（暂停，on 保持 true），
    // 下一次真实请求到达即自动复活 —— 不把偶发网络抖动误判成"该关掉保温"。
    // 唯一例外：401/403 是凭据/配额级别的硬错误，重试与保温都不可能成功，仍立即 off。
    const fatal = statusCode === 401 || statusCode === 403;
    if (fatal) {
      pingState.stale = true;
      pingState.health = 'stale';
      pingState.on = false;
      if (pingTimers.has(key)) { clearInterval(pingTimers.get(key)); pingTimers.delete(key); }
      if (pingState.retryTimer) { clearTimeout(pingState.retryTimer); pingState.retryTimer = null; }
      console.log(`[ping] key=${key} AUTO-OFF: fatal auth/quota error ${errStr}`);
      persistPings();
      releaseInFlight(key);
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
          releaseInFlight(key);
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

        // 估算花费仅用于展示（2026-10-21 用户裁定 #1：**不再作为关闭条件**）。
        // 订阅制下 cache-read 在 5h 窗口内几乎不计费，按公开价目表累计总额会误杀大前缀保温。
        pingState.spentUsd = (pingState.spentUsd || 0) + estimatePingCostUsd(usage);

        // 每次成功 ping 后刷新落盘（请求体可能因上下文更新；也让 updatedAt 保鲜）
        persistBodies();
        persistPings();

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
            persistPings();
          }
        } else {
          pingState.consecutiveZeroCacheRead = 0;
        }
        releaseInFlight(key);
      });
    }
  );

  upReq.setTimeout(config.pingTimeoutMs, () => {
    upReq.destroy(new Error('ping-timeout'));
  });

  upReq.on('error', (e) => {
    onTransportFailure(502, String(e && e.message ? e.message : e));
    releaseInFlight(key);
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
        sessionId: s.sessionId || null,
        lastSeenAt: s.lastSeenAt,
        model: s.model,
        lastStatus: s.lastStatus,
        lastInputTokens: s.lastInputTokens,
        lastCacheRead: s.lastCacheRead,
        lastPromptTokens: s.lastPromptTokens || 0,
        lastSeenMs: s.lastSeenMs || null,
        bodySha: s.bodySha || null,
      })),
    }));
    return;
  }

  // B6: POST /control/verify —— 保温开启**前**的交叉校验（2026-10-21 用户裁定 #3）
  // 目的：绝不给错误对象保温。判据三条全部满足才算「确认命中本会话」：
  //   ① 该 key 有已记录的真实请求体（recordedRequests）；
  //   ② 该请求体里的会话标识（metadata.user_id / prompt_cache_key）与请求声明的
  //      sessionId 一致（有声明时）；
  //   ③ prompt 量级落在调用方给出的期望区间内（expectedPromptTokens ±tolerance），
  //      这是识破「key 打到别的会话」最直接的一刀——90 token 的测试前缀 vs 480k
  //      的会话实测，一眼可分。
  // 返回 ok=false 时插件必须拒绝开启并如实报错，不许假装 ACTIVE。
  if (req.method === 'POST' && req.url === '/control/verify') {
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
      const key = body && body.key;
      const sessionId = body && body.sessionId ? String(body.sessionId) : null;
      const expected = Number(body && body.expectedPromptTokens);
      const tolerance = Number(body && body.tolerance) || 0.25;
      const rec = key ? recordedRequests.get(key) : null;

      const result = { key: key || null, sessionId, ok: false, reasons: [] };
      if (!key) {
        result.reasons.push('missing-key');
      } else if (!rec) {
        result.reasons.push('no-request-recorded');
      } else {
        // ② 会话标识交叉校验
        let bodySession = null;
        try {
          const j = JSON.parse(rec.body.toString('utf8'));
          if (j && j.metadata && j.metadata.user_id) bodySession = sessionIdFromUserId(j.metadata.user_id);
          else if (j && typeof j.prompt_cache_key === 'string') bodySession = j.prompt_cache_key;
        } catch (e) {
          result.reasons.push('unparsable-recorded-body');
        }
        result.bodySessionId = bodySession;
        if (sessionId && bodySession && bodySession !== sessionId) {
          result.reasons.push('session-id-mismatch');
        }
        // ③ prompt 量级校验
        const s = sessions.get(key);
        const actual = Number(s && (s.lastPromptTokens || s.lastInputTokens)) || 0;
        result.actualPromptTokens = actual;
        result.expectedPromptTokens = Number.isFinite(expected) ? expected : null;
        result.tolerance = tolerance;
        result.lastSeenAt = (s && s.lastSeenAt) || rec.lastSeenAt || null;
        result.bodyModel = rec.model || null;
        if (Number.isFinite(expected) && expected > 0) {
          const lo = expected * (1 - tolerance);
          const hi = expected * (1 + tolerance);
          if (actual <= 0) result.reasons.push('no-observed-traffic');
          else if (actual < lo || actual > hi) result.reasons.push('prompt-size-mismatch');
        }
      }
      result.ok = result.reasons.length === 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
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
      // 2026-10-21：把"状态自相矛盾"显式暴露给 UI，别让 waiting/hit 掩盖失效
      selfCheck: runSelfCheck(),
    }));
    return;
  }

  // B6b: GET /selfcheck —— 单独查询一致性报警（给运维脚本/面板直接用）
  if (req.method === 'GET' && req.url === '/selfcheck') {
    const result = runSelfCheck();
    res.writeHead(result.ok ? 200 : 409, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
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
      let intervalMin = body.intervalMin !== undefined ? Number(body.intervalMin) : 30;
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
        // 缺陷修复（2026-10-21）：409 早退路径原先**没有落盘**，
        // 于是"开启保温意图"在重启后丢失 —— 用户以为开着，实际什么都没有。
        persistPings();
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

      // 开关状态也落盘：重启后自动恢复 ping 循环（见 loadPersistedPings）
      persistPings();

      // KI-2：开启保温时**立即**落盘该 key 的请求体。
      // 只在「真实请求到达」时落盘不够 —— 常见顺序是「先说话、后开保温」
      // （先发消息，再点 ON / reconciler 补挂），那一刻 pings 里还没有该 key，
      // 落盘钩子不触发，sidecar 一重启就丢。此处补上。
      persistBodies();

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
        // 审计 §5：顺延 timer 旧实现没有句柄、OFF 无法取消，会留下野回调
        if (p.deferTimer) {
          clearTimeout(p.deferTimer);
          p.deferTimer = null;
        }
        p.pendingPing = false;
        // KI-2：关闭保温即删除其持久化请求体（不留存不必要的隐私数据）
        persistDeleteKey(key);
        persistPings();
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
    let currentSessionId = null;

    if (ct.includes('json') && body.length) {
      try {
        const j = JSON.parse(body.toString('utf8'));
        const ttlMark = injectCacheTtl(j, req.url);
        if (ttlMark) injected.push(ttlMark);
        {
          const aff = affinityKey(j);
          currentKey = aff.id;
          currentSessionId = aff.sessionId || null;
          if (INJECT_AFFINITY) {
            // 2026-10-21 v2：把解析出的会话身份**写进请求体**，让上游缓存
            // 与会话一一对应，也让 /control/verify 能事后反查出「这个 key
            // 究竟属于哪个会话」（10-21 事故的取证依据）。
            // 优先写 metadata.user_id（OpenAI 兼容的会话标签，实测被 Kimi
            // 端点接受且不影响缓存命中）。
            if (currentSessionId) {
              j.metadata = Object.assign({}, j.metadata, { user_id: currentSessionId });
              injected.push('user_id=session');
            } else if (aff.synthesized) {
              // 兜底路径（system 哈希）：沿用旧行为，用 key 当标签
              j.metadata = Object.assign({}, j.metadata, { user_id: aff.id });
              injected.push('user_id=' + aff.id);
            } else {
              injected.push('user_id=client');
            }
          }
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
            sessionId: currentSessionId,
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
            // KI-2：保温中的请求体落盘，供 sidecar 重启后恢复（只存 on 的 key）
            if (p.on) persistBodies();
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
            // lastPromptTokens 取 prompt_tokens 优先（openai-completions 形态）；
            // input_tokens 在流式响应里常常只是最后一个 delta，不能代表前缀规模。
            const promptTokens = Number(
              usage.prompt_tokens ||
              ((Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0)) ||
              0);
            sessions.set(currentKey, {
              key: currentKey,
              sessionId: currentSessionId,
              lastSeenAt: new Date().toISOString(),
              model: currentModel,
              lastStatus: upRes.statusCode,
              lastInputTokens: usage.input_tokens || 0,
              lastCacheRead: usage.cache_read_input_tokens || 0,
              lastPromptTokens: promptTokens,
              bodySha: (recordedRequests.get(currentKey) || {}).bodySha || null,
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
  server.listen(PORT, '127.0.0.1', () => {
    // KI-2 完整闭环。**恢复顺序有讲究**（2026-10-21 二次修复）：
    // 先恢复 bodies，再恢复 pings —— 反过来也行，但关键是恢复完成后**立刻**
    // 一致性回写一次，把两份文件的状态对齐。旧顺序下若在任何一步触发
    // persistBodies()，而此时 pings 尚未装载，就会把磁盘清空（已修）。
    const n = loadPersistedBodies();
    if (n > 0) console.log(`[persist] restored ${n} recorded request body(ies) from ${PERSIST_FILE}`);
    const p = loadPersistedPings();
    if (p.restored > 0 || p.waiting > 0) {
      console.log(`[persist] restored ${p.restored} ping loop(s), ${p.waiting} waiting for real request`);
    }
    // 一致性回写：此时两份数据都在内存里，写回是安全的（合并语义不会丢条目）
    persistPings();
    persistBodies();

    // 启动自检：把"声称开着但无法工作"的组合显式打印出来（面板另有呈现）
    const check = runSelfCheck();
    if (!check.ok) {
      for (const a of check.alarms) {
        console.log(`[selfcheck] ${a.severity.toUpperCase()} key=${a.key} ${a.code}: ${a.detail}`);
      }
    } else {
      console.log('[selfcheck] ok');
    }
    console.log('kimi-cache-sidecar listening on 127.0.0.1:' + PORT + ' -> https://' + getUpstreamHost() + getUpstreamPrefix());
  });
}

module.exports = {
  server,
  affinityKey,
  sessionIdFromUserId,
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
  persistBodies,
  loadPersistedBodies,
  persistPings,
  loadPersistedPings,
  persistDeleteKey,
  runSelfCheck,
  totalInputTokens,
  PERSIST_FILE,
  PINGS_FILE,
};
