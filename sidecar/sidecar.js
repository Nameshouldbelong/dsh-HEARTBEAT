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
// 2026-10-22 第二轮审计加固：在途锁必须独立于 pings 状态对象。
// /control/on 会整体替换 pings.get(key) 的对象，若锁存在对象里，
// 旧请求仍在途时新对象看不到锁 → 仍会并发。改为按 key 的独立集合。
const inFlightKeys = new Set();
const pendingPingKeys = new Set();
// 2026-10-23 审计 T21：每 key 的"代数"。OFF/ON/改间隔/真实请求替换都会 +1，
// 旧代在途响应的迟到回调据此识别自己已过期，**不得**清新代 timer/健康值。
const keyGenerations = new Map();
function bumpGeneration(key) {
  const g = (keyGenerations.get(key) || 0) + 1;
  keyGenerations.set(key, g);
  return g;
}
function currentGeneration(key) { return keyGenerations.get(key) || 0; }

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
        credentialRef: rec.credentialRef || null,
        authScheme: rec.authScheme || null,
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

    // 保留磁盘上仍在 TTL 内、且内存里没有对应条目的旧记录（防止一次空扫描清空）。
    // 2026-10-24 独立审计修复：熔断记录（on=false 但带 autoOffedAt）同样保留 —— 
    // runPing 的 auto-off 注释声称"熔断标记必须可持久，供 ensure 识别"，旧实现
    // 在这里把它和用户显式 OFF 一起丢弃，重启后 ensure 的 breaker 判定失效。
    for (const [key, v] of Object.entries(old)) {
      if (v && (v.on || v.autoOffedAt) && now - (v.updatedAt || 0) <= MAX_PERSIST_AGE_MS && !pings.has(key)) {
        merged[key] = v;
      }
    }

    let live = 0;
    let breakers = 0;
    for (const [key, p] of pings.entries()) {
      if (!p) continue;
      // 内存里**明确关掉**的 key：不写入（等同删除，这是唯一合法的删除途径）。
      // 例外：被自动关停（熔断）的条目 on=false 但带 autoOffedAt —— 必须持久化，
      // 否则 sidecar 重启后 reconciler 的 ensure 补挂会绕过熔断重新开 ping。
      if (!p.on && !p.autoOffedAt) continue;
      merged[key] = {
        key,
        on: p.on === true,
        windowStartMin: p.windowStartMin,
        windowEndMin: p.windowEndMin,
        intervalMin: p.windowEndMin, // 兼容旧读取方
        anchorMs: p.anchorMs || null,
        pingCount: p.pingCount || 0,
        lastPingAt: p.lastPingAt || null,
        spentUsd: p.spentUsd || 0,
        consecutiveZeroCacheRead: p.consecutiveZeroCacheRead || 0,
        waitingForRequest: p.waitingForRequest === true,
        autoOffedAt: p.autoOffedAt || null,
        blockedReason: p.blockedReason || null,
        updatedAt: now,
      };
      if (p.on) live++; else breakers++;
    }

    writeJsonAtomic(PINGS_FILE, merged);
    return { kept: Object.keys(merged).length, live, breakers };
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


// ── 工具门控（tool gate，2026-10-24 生产事故产物）─────────────────────────
// 事故：全局挂载的 rea MCP 给每个请求带来 207 个工具 / 652KB schema（单个
// compare_web_captures 达 161.8KB），Kimi /coding 按单工具 schema 体积上限
// 直接 400（"moonshot flavored json schema … exceeds maximum allowed size"）。
// dsh 的 MCP 注册在 Host 启动期合成、无热切换（dsh-mcp-client 自己的错误
// 提示就是 "reload the plugin or restart the Host"），而 rea 对其他 provider
// （直连、不经本 sidecar）仍有用 —— 因此在 kimi 出站路径上按前缀剥除：
// rea 保持全局挂载，kimi 会话按本开关瘦身，即点即生效、零重启。
//
// 关键不变量：剥除发生在入站解析段（TTL/身份注入之后、序列化与录制之前），
// 因此**录制体 == 实际出站体**，保温 ping 的逐字节重放语义不受影响。
const TOOLGATE_FILE = path.join(PERSIST_DIR, 'toolgate.json');
const TOOLGATE_PREFIX_RE = /^[A-Za-z0-9_]{2,64}$/;
const toolGate = {
  // 默认关：通用 sidecar 不替用户做主；部署方按需开启（生产已于 2026-10-24 开启）。
  enabled: false,
  dropPrefixes: ['mcp__rea__'],
  stats: { gatedRequests: 0, strippedTools: 0, savedBytes: 0, lastAt: null },
};

function loadToolGate() {
  const saved = readJsonFile(TOOLGATE_FILE, null);
  if (!saved || typeof saved !== 'object') return;
  if (typeof saved.enabled === 'boolean') toolGate.enabled = saved.enabled;
  if (Array.isArray(saved.dropPrefixes)) {
    toolGate.dropPrefixes = saved.dropPrefixes.filter(
      (p) => typeof p === 'string' && TOOLGATE_PREFIX_RE.test(p));
  }
  if (saved.stats && typeof saved.stats === 'object') {
    toolGate.stats.gatedRequests = Number(saved.stats.gatedRequests) || 0;
    toolGate.stats.strippedTools = Number(saved.stats.strippedTools) || 0;
    toolGate.stats.savedBytes = Number(saved.stats.savedBytes) || 0;
    toolGate.stats.lastAt = saved.stats.lastAt || null;
  }
  console.log(`[toolgate] loaded: enabled=${toolGate.enabled} prefixes=${JSON.stringify(toolGate.dropPrefixes)}`);
}

function persistToolGate() {
  try {
    writeJsonAtomic(TOOLGATE_FILE, {
      enabled: toolGate.enabled,
      dropPrefixes: toolGate.dropPrefixes,
      stats: toolGate.stats,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.log('[persist] toolgate write failed:', String(e && e.message ? e.message : e));
  }
}

/**
 * 就地剥除 j.tools 中名字命中 dropPrefixes 前缀的工具。
 * 兼容两种工具形态：OpenAI（function.name）与 Anthropic（name/input_schema）。
 * @returns {null|{dropped:number, savedBytes:number}} null=未启用/无 tools/未命中。
 */
function applyToolGate(j) {
  if (!toolGate.enabled || !Array.isArray(j.tools) || j.tools.length === 0) return null;
  if (toolGate.dropPrefixes.length === 0) return null;
  const nameOf = (t) => (t && (t.function?.name || t.name)) || '';
  const keep = j.tools.filter((t) => {
    const n = nameOf(t);
    return !toolGate.dropPrefixes.some((p) => n.startsWith(p));
  });
  if (keep.length === j.tools.length) return null;
  const beforeBytes = Buffer.byteLength(JSON.stringify(j.tools), 'utf8');
  const dropped = j.tools.length - keep.length;
  j.tools = keep;
  const savedBytes = beforeBytes - Buffer.byteLength(JSON.stringify(j.tools), 'utf8');
  toolGate.stats.gatedRequests += 1;
  toolGate.stats.strippedTools += dropped;
  toolGate.stats.savedBytes += savedBytes;
  toolGate.stats.lastAt = new Date().toISOString();
  persistToolGate();
  return { dropped, savedBytes };
}

/**
 * ——— 2026-10-23 审计 T16：重启后重建认证 ———
 * 只保存**凭据来源引用**（env 变量名），绝不落盘原始 Authorization 头。
 */
const CREDENTIAL_ENV_CANDIDATES = [
  'KIMI_CODING_API_KEY', 'KIMI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
];

function detectCredentialRef(headers) {
  try {
    const raw = headers && (headers.authorization || headers.Authorization);
    if (!raw || typeof raw !== 'string') return null;
    const token = raw.replace(/^(Bearer|Basic)\s+/i, '').trim();
    if (!token) return null;
    for (const name of CREDENTIAL_ENV_CANDIDATES) {
      if (process.env[name] && process.env[name] === token) return name;
    }
    return 'client';
  } catch { return null; }
}

function detectAuthScheme(headers) {
  const raw = headers && (headers.authorization || headers.Authorization);
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^(Bearer|Basic)\s+/i);
  return m ? m[1] : null;
}

function buildRestoredHeaders(v) {
  const h = {};
  const ref = v && v.credentialRef;
  if (ref && ref !== 'client' && /^[A-Z_][A-Z0-9_]*$/.test(ref)) {
    const val = process.env[ref];
    if (val) h.authorization = (v.authScheme || 'Bearer') + ' ' + val;
  }
  return h;
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
        // 头（含 auth）**不落盘**；按 credentialRef 从环境重建（2026-10-23 审计 T16）。
        // 旧实现留空 {}，恢复后的 ping 没有 Authorization → 上游 401 → 误触发熔断。
        headers: buildRestoredHeaders(v),
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
    // 窗口定时器（pingTimers）在窗口开启时移交给突发链（burstTimers）——
    // 突发进行中任一存在都算"循环在"
    const hasTimer = pingTimers.has(key) || burstTimers.has(key) || !!(p && p.burst);
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
    if (!fs.existsSync(PINGS_FILE)) return { restored: 0, waiting: 0, breakers: 0 };
    const obj = JSON.parse(fs.readFileSync(PINGS_FILE, 'utf8'));
    const now = Date.now();
    let restored = 0;
    let waiting = 0;
    let breakers = 0;
    for (const [key, v] of Object.entries(obj || {})) {
      if (!v) continue;
      if (now - (v.updatedAt || 0) > MAX_PERSIST_AGE_MS) continue;
      // 熔断记录（on=false 但带 autoOffedAt）：恢复为熔断态（on=false、stale），
      // **不**启动 ping 循环 —— 让 /control/on 的 ensure 语义能识别到熔断并拒绝
      // 补挂（2026-10-24 独立审计修复：旧实现直接跳过，重启后熔断丢失、
      // ensure 以 full-reset 重新开 ping，违背"熔断必须可持久"的设计承诺）。
      if (!v.on) {
        if (!v.autoOffedAt) continue;   // 用户显式 OFF：不是熔断，无需恢复
        const bw = normalizeWindow(
          v.windowStartMin ?? Math.max(1, (v.intervalMin || 30) - 10),
          v.windowEndMin ?? (v.intervalMin || 30));
        pings.set(key, {
          key,
          on: false,
          windowStartMin: bw ? bw.startMin : config.windowDefaultStartMin,
          windowEndMin: bw ? bw.endMin : config.windowDefaultEndMin,
          intervalMin: v.intervalMin || 30,
          anchorMs: null,
          burst: null,
          lastPingAt: v.lastPingAt || null,
          pingCount: v.pingCount || 0,
          stale: true,
          health: 'stale',
          waitingForRequest: false,
          lastUsage: null,
          lastError: null,
          consecutiveZeroCacheRead: v.consecutiveZeroCacheRead || 0,
          consecutiveTransportFailures: 0,
          spentUsd: v.spentUsd || 0,
          autoOffedAt: v.autoOffedAt,
          blockedReason: v.blockedReason || 'auto-off',
        });
        breakers++;
        continue;
      }
      const hasBody = recordedRequests.has(key);
      const bw = normalizeWindow(
        v.windowStartMin ?? Math.max(1, (v.intervalMin || 30) - 10),
        v.windowEndMin ?? (v.intervalMin || 30));
      const wStart = bw ? bw.startMin : config.windowDefaultStartMin;
      const wEnd = bw ? bw.endMin : config.windowDefaultEndMin;
      // 锚点：录制体新鲜（窗口右端内）则沿用，否则从现在起算
      const recBody = recordedRequests.get(key);
      const anchorMs = hasBody && recBody && (Date.now() - recBody.lastSeenMs) < wEnd * 60000
        ? recBody.lastSeenMs
        : Date.now();
      pings.set(key, {
        key,
        on: true,
        windowStartMin: wStart,
        windowEndMin: wEnd,
        intervalMin: v.intervalMin || 30,
        anchorMs,
        burst: null,
        lastPingAt: v.lastPingAt || null,
        pingCount: v.pingCount || 0,
        stale: false,
        health: hasBody ? null : 'waiting',
        waitingForRequest: !hasBody,
        lastUsage: null,
        lastError: null,
        consecutiveZeroCacheRead: v.consecutiveZeroCacheRead || 0,
        consecutiveTransportFailures: 0,
        spentUsd: v.spentUsd || 0,
        autoOffedAt: v.autoOffedAt || null,
        blockedReason: v.blockedReason || null,
      });
      if (hasBody) {
        scheduleWindow(key);
        restored++;
      } else {
        waiting++;
      }
    }
    return { restored, waiting, breakers };
  } catch (e) {
    console.log('[persist] pings load failed:', String(e && e.message ? e.message : e));
    return { restored: 0, waiting: 0, breakers: 0 };
  }
}

// 可测试配置（测试可直接改写字段注入短计时）
const config = {
  pingTimeoutMs: parseInt(process.env.PING_TIMEOUT_MS || '120000', 10), // ping 上游超时（原实现无超时，卡死会静默）
  // ── 区间突发引擎（2026-10-25 用户裁定：删除"单时点+3 次重试"）────────────
  // 每个保温周期的锚点（anchor）= 最近一次缓存确认触碰（真实请求或命中 ping）。
  // 锚点后第 windowStartMin 分钟进入突发窗口：每 burstIntervalMs 发一次 HB，
  // 直到保温成功（hit）或窗口右端（windowEndMin）耗尽；窗口耗尽本周期不再尝试。
  // 429（engine 超负荷）/5xx/网络错误在窗口内自动被 5s 节奏重试——
  // 不再有独立的 retry 计数/延时（scheduleRetry 已删除）。
  burstIntervalMs: parseInt(process.env.BURST_INTERVAL_MS || '5000', 10),
  windowDefaultStartMin: parseInt(process.env.HB_WINDOW_START_MIN || '20', 10),
  windowDefaultEndMin: parseInt(process.env.HB_WINDOW_END_MIN || '30', 10),
  recencyWindowMs: 10000, // 真实请求 <10s 内（保留给 waiting 恢复的立即探测防贴脸）
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
  // 2026-10-23 审计 T29：流式 Chat Completions 默认不回 usage，
  // 于是 ping 永远拿不到缓存计数 → 被判 unknown（既不算命中也不算失败），
  // 保温事实上失去观测能力。标准兼容做法是显式要求 usage 尾帧。

  // 2026-10-15 实测(Kimi coding 端点): max_tokens=1 的请求不参与前缀缓存(连发双 miss),
  // max_tokens=16/100/1024 均正常命中。ping 输出整体丢弃, 故固定 16(已验证可参与缓存的最低档),
  // 不再沿用原始请求的 max_tokens 也不钳 1024。其余字段一律保持原样
  // (含注入的 cache_control/user_id, 由记录时机保证已注入)。
  const j = JSON.parse(recordedBuffer.toString('utf8'));
  j.max_tokens = 16;
  // 2026-10-23 审计 T29：流式请求必须显式索取 usage 尾帧，否则 ping 拿不到
  // 缓存计数，只能判 unknown —— 保温失去观测能力（等于"悄悄地不生效"）。
  // 非流式无需该字段；已显式设置过的保持原值。
  if (j.stream === true) {
    j.stream_options = Object.assign({}, j.stream_options, { include_usage: true });
  }
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
    // 2026-10-22 第二轮审计修复（问题 3b）：完全没有 usage 时**不能断言"没命中"**。
    // 旧实现返回 'no-cache' → 被计入失败并可能自动停机，
    // 把"无法判断"误当成"确认未命中"。改为 'unknown'，由上层按未知处理。
    return 'unknown';
  }
  return 'error';
}

// 临时错误快速 retry：retry #1 +2min、retry #2 +4min(默认值见 config.retryDelaysMs)。
// 用独立 setTimeout, 主 setInterval 周期不漂移; 成功即清零; 耗尽则置 stale 等真实流量复活。
// ── 区间突发引擎（2026-10-25，替换上面的单时点+重试模型）──────────────────
// 事件流：anchor（缓存确认触碰）→ [windowStartMin] 进入突发 → 每 5s 一次 HB
//   → hit：结束本周期，anchor=now，预约下一窗口
//   → 429/5xx/网络/超时/unknown：继续 5s 节奏（窗口内）
//   → recreated/no-cache：命中墙熔断（唯一自动关闭判据，不变）
//   → 401/403：凭据级硬错，立即 off（不变）
//   → 400：本周期停止突发（请求体级问题，5s 重锤无意义），等下一窗口
//   → 窗口右端耗尽：health=window-expired，本周期不再尝试，anchor=now 预约下一窗口
const burstTimers = new Map(); // key -> Timeout（突发链的 5s 步进定时器）

function clearPingTimers(key) {
  if (pingTimers.has(key)) { clearTimeout(pingTimers.get(key)); pingTimers.delete(key); }
  if (burstTimers.has(key)) { clearTimeout(burstTimers.get(key)); burstTimers.delete(key); }
}

/** 校验/归一化保温窗口。合法：0.05 ≤ start < end ≤ 720（业务上取整数分钟）。 */
function normalizeWindow(startMin, endMin) {
  const s = Number(startMin);
  const e = Number(endMin);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (s < 0.05 || e > 720 || s >= e) return null;
  return { startMin: s, endMin: e };
}

/** 预约下一个突发窗口：anchor + windowStartMin（已过时则立即触发）。 */
function scheduleWindow(key) {
  const st = pings.get(key);
  if (!st || st.on !== true || st.stale) return;
  if (!recordedRequests.has(key)) {
    st.waitingForRequest = true;
    st.health = st.health || 'waiting';
    return;
  }
  if (pingTimers.has(key)) { clearTimeout(pingTimers.get(key)); pingTimers.delete(key); }
  const anchor = st.anchorMs || Date.now();
  const delay = Math.max(0, anchor + st.windowStartMin * 60000 - Date.now());
  const t = setTimeout(() => { pingTimers.delete(key); startBurst(key); }, delay);
  if (t.unref) t.unref();
  pingTimers.set(key, t);
}

/** 进入突发窗口。deadline = anchor + windowEndMin。 */
function startBurst(key) {
  const st = pings.get(key);
  if (!st || st.on !== true || st.stale) return;
  if (!recordedRequests.has(key)) {
    st.waitingForRequest = true;
    st.health = 'waiting';
    return;
  }
  st.burst = {
    startedAt: Date.now(),
    attempts: 0,
    deadlineMs: (st.anchorMs || Date.now()) + st.windowEndMin * 60000,
  };
  if (st.health !== 'hit') st.health = 'bursting';
  console.log(`[ping] key=${key} burst window open (deadline in ${Math.max(0, Math.round((st.burst.deadlineMs - Date.now()) / 1000))}s)`);
  burstStep(key);
}

/** 突发步进：窗口耗尽则收尾，否则发一次尝试；完成后的续链由 afterAttempt 负责。 */
function burstStep(key) {
  const st = pings.get(key);
  if (!st || st.on !== true || !st.burst) return;
  if (Date.now() >= st.burst.deadlineMs) {
    st.health = 'window-expired';
    if (!st.lastError) st.lastError = 'window-expired';
    st.burst = null;
    st.anchorMs = Date.now();   // 下一周期从窗口耗尽时刻重新起算
    clearPingTimers(key);
    console.log(`[ping] key=${key} window expired without success; next window in ${st.windowStartMin}min`);
    persistPings();
    scheduleWindow(key);
    return;
  }
  attemptPing(key);
}

/**
 * 每次尝试结束后的统一处置（attemptPing 的结果回调）。
 * outcome: 'hit'|'recreated'|'no-cache'|'unknown'|'continue'|'stop'
 *   · hit      → anchor=now，结束突发，预约下一窗口
 *   · continue → 429/5xx/网络/超时/unknown：仍在窗口内则 5s 后再试
 *   · stop     → 400/致命错误：本周期停止（熔断/关闭路径已自行处理）
 */
function afterAttempt(key, outcome) {
  const st = pings.get(key);
  if (!st || !st.burst) return;
  if (outcome === 'hit') {
    st.burst = null;
    st.anchorMs = Date.now();
    clearPingTimers(key);
    scheduleWindow(key);
    return;
  }
  if (outcome === 'continue') {
    if (burstTimers.has(key)) { clearTimeout(burstTimers.get(key)); }
    const t = setTimeout(() => burstStep(key), config.burstIntervalMs);
    if (t.unref) t.unref();
    burstTimers.set(key, t);
    return;
  }
  // stop / recreated / no-cache：突发不再继续（熔断路径已清 timer）
  st.burst = null;
  if (outcome === 'stop') {
    st.anchorMs = Date.now();
    clearPingTimers(key);
    scheduleWindow(key);
  }
}

function scheduleRetry(key) {
  // 已删除（2026-10-25）：单时点+3 次重试模型被区间突发引擎取代。
  // 保留空壳仅为了旧日志/旧测试的可读性；不应再被调用。
  console.log('[ping] scheduleRetry is deprecated (window burst engine in effect)');
}

/**
 * 释放 in-flight 锁并处理"在途期间又有人想 ping"的情况（2026-10-22 §5）。
 * 必须有单一路径，否则漏一个 return 就会把该 key 永久锁死。
 */
function releaseInFlight(key) {
  inFlightKeys.delete(key);
  const st = pings.get(key);
  const wantMore = pendingPingKeys.has(key);
  pendingPingKeys.delete(key);
  if (!st) return;
  if (wantMore && st.on && !st.stale) {
    // 在途期间被请求过：等一拍再补一次，避免与刚结束的请求贴太近
    const t = setTimeout(() => runPing(key), 2000);
    if (t.unref) t.unref();
    st.deferTimer = t;
  }
}

function attemptPing(key) {
  const pingState = pings.get(key);
  if (!pingState || !pingState.on || pingState.stale) return;
  const rec = recordedRequests.get(key);
  if (!rec) return;

  // 单在途锁（2026-10-22 审计修复）：同一 key 任意时刻至多一个在途 ping。
  // 区间突发引擎下突发步进与在途补发共用此锁；在途期间的新调用只记意图。
  if (inFlightKeys.has(key)) {
    pendingPingKeys.add(key);
    return;
  }

  inFlightKeys.add(key);
  if (pingState.burst) pingState.burst.attempts = (pingState.burst.attempts || 0) + 1;
  const myGeneration = currentGeneration(key);

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

  // 传输/API 失败的统一处置（区间突发版，2026-10-25）：
  //   401/403  → 凭据级硬错，立即 off（唯一保留的立即关闭例外）
  //   429/5xx/网络/超时 → 窗口内由 5s 节奏自动重试（不计 cache 失败）
  //   400     → 本周期停止突发（请求体级问题，重锤无意义），等下一窗口
  const onTransportFailure = (statusCode, errStr) => {
    pingState.lastPingAt = new Date().toISOString();
    pingState.pingCount = (pingState.pingCount || 0) + 1;
    pingState.consecutiveTransportFailures = (pingState.consecutiveTransportFailures || 0) + 1;
    pingState.lastError = errStr;

    const fatal = statusCode === 401 || statusCode === 403;
    if (fatal) {
      pingState.stale = true;
      pingState.health = 'stale';
      pingState.on = false;
      pingState.burst = null;
      pingState.autoOffedAt = Date.now();
      pingState.blockedReason = 'auth-error';
      clearPingTimers(key);
      console.log(`[ping] key=${key} AUTO-OFF: fatal auth/quota error ${errStr}`);
      persistPings();
      return 'off';
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
      error: errStr,
    });
    if (statusCode === 400) {
      pingState.health = 'error';
      afterAttempt(key, 'stop');
      return 'stop';
    }
    // 429（engine 超负荷）/5xx/超时/断流：窗口内继续
    pingState.health = 'retrying';
    afterAttempt(key, 'continue');
    return 'continue';
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
      // ── once-only finalize（2026-10-23 审计 F01）────────────────────────
      // error / aborted / close 都进入同一终结器，且只执行一次；断流不再锁死 key。
      let finalized = false;
      const finalizeFailure = (why) => {
        if (finalized) return;
        finalized = true;
        // 旧代迟到：不改新代状态，只释放属于本代的锁
        if (myGeneration !== currentGeneration(key)) { releaseInFlight(key); return; }
        try { onTransportFailure(502, 'stream-' + why); } catch {}
        releaseInFlight(key);
      };
      upRes.on('data', (c) => respChunks.push(c));
      upRes.on('aborted', () => finalizeFailure('aborted'));
      upRes.on('error', (e) => finalizeFailure('error:' + String(e && e.message ? e.message : e)));
      upRes.on('close', () => {
        // close 在正常结束后也会触发，仅当尚未 end 时视为异常
        if (!finalized && !upRes.complete) finalizeFailure('close-incomplete');
      });
      upRes.on('end', () => {
        if (finalized) return;
        finalized = true;
        // 旧代迟到响应：丢弃，绝不覆盖新代健康值/计数/timer
        if (myGeneration !== currentGeneration(key)) { releaseInFlight(key); return; }
        const txt = Buffer.concat(respChunks).toString('utf8');
        const usage = extractUsage(txt);
        const result = classifyPingResult(upRes.statusCode, usage);

        if (result === 'error') {
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
          usage,
        });
        console.log(`[ping] key=${key} status=${upRes.statusCode} result=${result} cache_read=${usage.cache_read_input_tokens || 0} cache_creation=${usage.cache_creation_input_tokens || 0}`);
        pingState.lastPingAt = new Date().toISOString();
        pingState.pingCount = (pingState.pingCount || 0) + 1;
        pingState.lastUsage = usage;
        pingState.lastError = null;
        pingState.health = result; // 'hit' | 'recreated' | 'no-cache' | 'unknown'
        pingState.consecutiveTransportFailures = 0;

        // 估算花费仅用于展示（2026-10-21 用户裁定 #1：**不再作为关闭条件**）。
        pingState.spentUsd = (pingState.spentUsd || 0) + estimatePingCostUsd(usage);

        persistBodies();
        persistPings();

        if (result === 'hit') {
          pingState.consecutiveZeroCacheRead = 0;
          afterAttempt(key, 'hit');
        } else if (result === 'no-cache' || result === 'recreated') {
          // 唯一自动关闭判据不变：单次命中墙（failThreshold=1）。
          // 未达阈值的 miss 也**不继续 5s 重锤**（每次 miss 都可能是全价重算），
          // 本周期停止突发，下一窗口再试。
          pingState.consecutiveZeroCacheRead = (pingState.consecutiveZeroCacheRead || 0) + 1;
          if (pingState.consecutiveZeroCacheRead >= config.failThreshold) {
            pingState.stale = true;
            pingState.health = 'stale';
            pingState.on = false;
            pingState.burst = null;
            pingState.autoOffedAt = Date.now();
            pingState.blockedReason = 'low-hit';
            clearPingTimers(key);
            console.log(`[ping] key=${key} AUTO-OFF: ${pingState.consecutiveZeroCacheRead} consecutive cache-miss pings (ratio < ${config.hitRatioMin}) — stopped to avoid burning quota`);
            persistPings();
          } else {
            afterAttempt(key, 'stop');
          }
        } else {
          // unknown（无 usage 可判）：不计数、不重锤，本周期按停止处理（配额安全）
          afterAttempt(key, 'stop');
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

// 兼容别名：旧代码/旧测试引用 runPing
const runPing = attemptPing;

// ── 版本与构建自证（2026-10-22 审计 §6-d）─────────────────────────────────
// 审计指出：部署后无法确认"源码—安装包—运行进程"是否是同一份。
// healthz 现在返回 buildSha（本文件内容的 sha256 前 12 位）、协议版本与能力清单，
// 与仓库 HEAD 的 sidecar.js 摘要比对即可判断线上跑的是不是刚推的那份。
const PROTOCOL_VERSION = 'hb2';
const STARTED_AT = new Date().toISOString();
const BUILD_SHA = (() => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 12);
  } catch { return 'unknown'; }
})();

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      inject_ttl: INJECT_TTL,
      inject_affinity: INJECT_AFFINITY,
      upstream: getUpstreamHost() + getUpstreamPrefix(),
      // 版本自证
      protocolVersion: PROTOCOL_VERSION,
      buildSha: BUILD_SHA,
      pid: process.pid,
      startedAt: STARTED_AT,
      capabilities: [
        'session-scoped-key', 'control-verify', 'selfcheck',
        'persist-bodies', 'persist-pings', 'single-inflight',
        'usage-normalized', 'tool-gate',
      ],
    }));
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
        // 2026-10-23 审计 T30：**缺身份不能当作"通过"**。
        // 旧实现只在 bodySession 存在且不等时才拒绝，于是"请求体里没有任何
        // 会话标识"被默认放行 —— 而这正是最需要拒绝的情形（无法证明归属）。
        if (!bodySession) {
          result.reasons.push('identity-unavailable');
        } else if (sessionId && bodySession !== sessionId) {
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

  // B7: GET/POST /control/toolgate —— 工具门控开关（2026-10-24）
  if (req.url === '/control/toolgate' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        enabled: toolGate.enabled,
        dropPrefixes: toolGate.dropPrefixes,
        stats: toolGate.stats,
      }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid-json' }));
        return;
      }
      if (body && typeof body.enabled !== 'undefined' && typeof body.enabled !== 'boolean') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'enabled-must-be-boolean' }));
        return;
      }
      if (body && typeof body.dropPrefixes !== 'undefined') {
        if (!Array.isArray(body.dropPrefixes) || body.dropPrefixes.length > 16 ||
            !body.dropPrefixes.every((p) => typeof p === 'string' && TOOLGATE_PREFIX_RE.test(p))) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid-drop-prefixes' }));
          return;
        }
      }
      if (typeof body?.enabled === 'boolean') toolGate.enabled = body.enabled;
      if (Array.isArray(body?.dropPrefixes)) toolGate.dropPrefixes = body.dropPrefixes.slice();
      persistToolGate();
      console.log(`[toolgate] set: enabled=${toolGate.enabled} prefixes=${JSON.stringify(toolGate.dropPrefixes)}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        enabled: toolGate.enabled,
        dropPrefixes: toolGate.dropPrefixes,
        stats: toolGate.stats,
      }));
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
        windowStartMin: p.windowStartMin,
        windowEndMin: p.windowEndMin,
        intervalMin: p.windowEndMin,
        anchorAt: p.anchorMs ? new Date(p.anchorMs).toISOString() : null,
        burst: p.burst ? {
          active: true,
          attempts: p.burst.attempts,
          deadlineAt: new Date(p.burst.deadlineMs).toISOString(),
        } : { active: false, attempts: 0, deadlineAt: null },
        lastPingAt: p.lastPingAt,
        pingCount: p.pingCount,
        stale: p.stale,
        health: p.health || null,
        spentUsd: Number((p.spentUsd || 0).toFixed(4)),
        waitingForRequest: p.waitingForRequest === true,
        autoOffedAt: p.autoOffedAt || null,
        blockedReason: p.blockedReason || null,
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
      // 保温窗口（2026-10-25）：优先 windowStartMin/windowEndMin；
      // 兼容旧 intervalMin（N → [N-10, N]）；缺省 20-30。
      let windowStartMin = config.windowDefaultStartMin;
      let windowEndMin = config.windowDefaultEndMin;
      if (body.windowStartMin !== undefined || body.windowEndMin !== undefined) {
        const w = normalizeWindow(
          body.windowStartMin !== undefined ? body.windowStartMin : windowStartMin,
          body.windowEndMin !== undefined ? body.windowEndMin : windowEndMin);
        if (!w) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid-window', hint: 'expect 1<=start<end<=720 (minutes), e.g. 20-30' }));
          return;
        }
        windowStartMin = w.startMin;
        windowEndMin = w.endMin;
      } else if (body.intervalMin !== undefined) {
        const n = Number(body.intervalMin);
        if (!Number.isInteger(n) || n < 1 || n > 720) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid-interval' }));
          return;
        }
        windowEndMin = n;
        windowStartMin = Math.max(1, n - 10);
      }

      // ── ensure / resume 分离（2026-10-23 审计第一批第 1 条）──────────────
      // 旧实现只有一个语义：无论谁来调用、无论是否已熔断，一律清 stale、重建
      // 定时器并立即 ping。于是 reconciler 的自动补挂与用户的显式重开同义，
      // **熔断被周期性对账绕过**（审计 T14/T15 用真实 sidecar 复现：上游请求 2→3）。
      //
      // 现在：
      //   · action='ensure'（默认给插件对账用）——幂等补挂；**遇到熔断只回报现状，
      //     不清 breaker、不重建 timer、不 ping**；
      //   · action='resume'（用户显式开启）——允许解除可恢复熔断（低命中/403）。
      // 为向后兼容，缺省按 'resume' 处理（旧调用方是"用户开启"语义），
      // 但 reconciler 一律显式传 ensure。
      const action = body.action === 'ensure' ? 'ensure' : 'resume';
      const breakerOpen = (() => {
        const p = pings.get(key);
        if (!p) return false;
        // 熔断判定：被自动关停过（autoOffedAt）或仍标记 stale/health=stale
        return p.autoOffedAt != null || p.stale === true || p.health === 'stale';
      })();

      if (action === 'ensure' && breakerOpen) {
        const p = pings.get(key);
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'breaker-open',
          blockedReason: p?.blockedReason || 'auto-off',
          action,
          state: {
            key, on: p?.on === true,
            windowStartMin: p?.windowStartMin, windowEndMin: p?.windowEndMin,
            stale: true,
            health: 'stale', pingCount: p?.pingCount || 0,
            autoOffedAt: p?.autoOffedAt || null,
          },
        }));
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
          windowStartMin,
          windowEndMin,
          intervalMin: windowEndMin, // 兼容旧读取方
          anchorMs: null,
          burst: null,
          lastPingAt: prev.lastPingAt || null,
          pingCount: prev.pingCount || 0,
          stale: false,
          health: 'waiting',
          waitingForRequest: true,
          lastUsage: prev.lastUsage || null,
          lastError: null,
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
          state: {
            key, on: true, windowStartMin, windowEndMin,
            health: 'waiting', waitingForRequest: true,
          },
        }));
        return;
      }

      // 幂等短路（2026-10-20 生产事故修复）：reconciler 周期对所有 on 会话补挂
      // /control/on。已健康运行的 key（on + 同窗口 + 窗口定时器在 + 非 stale/
      // waiting）一律视为 no-op，直接返回现状——绝不重置锚点/突发。
      const cur = pings.get(key);
      if (cur && cur.on
          && cur.windowStartMin === windowStartMin && cur.windowEndMin === windowEndMin
          && (pingTimers.has(key) || burstTimers.has(key) || (cur.burst && cur.burst.startedAt))
          && !cur.stale && !cur.waitingForRequest) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          alreadyOn: true,
          immediatePing: false,
          state: {
            key: cur.key,
            on: cur.on,
            windowStartMin: cur.windowStartMin,
            windowEndMin: cur.windowEndMin,
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

      clearPingTimers(key);
      const existing = pings.get(key) || {};
      // 2026-10-20：完整重置路径必须继承失败计数——旧实现每次归零，
      // 而 reconciler 每分钟补挂一次，导致"连续 N 次 miss 自动关闭"永不触发。
      // stale 状态由显式 /control/on 清除（用户主动重开），但计数保留以便继续观察。
      // resume：显式解除可恢复熔断（低命中 / 403）。清掉熔断标记。
      // ensure 在此处不会被调用（已被上面的 breaker-open 分支拦下）。
      const rec = recordedRequests.get(key);
      // 锚点：录制体新鲜（窗口内）则沿用其 lastSeenMs，否则从现在起算
      const anchorMs = rec && (Date.now() - rec.lastSeenMs) < windowEndMin * 60000
        ? rec.lastSeenMs
        : Date.now();
      const state = {
        key,
        on: true,
        windowStartMin,
        windowEndMin,
        intervalMin: windowEndMin, // 兼容旧读取方
        anchorMs,
        burst: null,
        lastPingAt: existing.lastPingAt || null,
        pingCount: existing.pingCount || 0,
        stale: false,
        autoOffedAt: null,
        blockedReason: null,
        health: existing.health === 'waiting' ? null : (existing.health || null),
        waitingForRequest: false,
        lastUsage: existing.lastUsage || null,
        lastError: null,
        consecutiveZeroCacheRead: existing.consecutiveZeroCacheRead || 0,
        consecutiveTransportFailures: 0,
        spentUsd: existing.spentUsd || 0,
      };
      bumpGeneration(key);   // T21：重开即新代，旧代迟到响应不得影响新代
      pings.set(key, state);
      scheduleWindow(key);

      // 开关状态也落盘：重启后自动恢复 ping 循环（见 loadPersistedPings）
      persistPings();

      // KI-2：开启保温时**立即**落盘该 key 的请求体。
      persistBodies();

      // 开启即立即探测一次（不等首个窗口），结果经 /control/state 轮询可见。
      // 命中则顺延锚点；429/网络错误等仅记录（突发重试只发生在窗口内）。
      setImmediate(() => attemptPing(key));

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        immediatePing: true,
        state: {
          key: state.key,
          on: state.on,
          windowStartMin: state.windowStartMin,
          windowEndMin: state.windowEndMin,
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
      if (key) clearPingTimers(key);
      if (key && pings.has(key)) {
        bumpGeneration(key);   // T21：旧代在途响应作废
        const p = pings.get(key);
        p.on = false;
        p.waitingForRequest = false;
        p.burst = null;
        // 2026-10-24 独立审计修复：显式 OFF 必须同时清熔断标记 ——
        // persistPings 现在会把 on=false 且带 autoOffedAt 的条目当"熔断记录"
        // 持久化；用户显式关闭后若不清除，persistDeleteKey + persistPings 的
        // 组合会把已删条目作为熔断重新写回，且重启后被恢复成熔断态。
        // 语义：用户显式 OFF 优先于熔断记忆（关闭即放弃对该 key 的一切管理）。
        p.autoOffedAt = null;
        p.blockedReason = null;
        pendingPingKeys.delete(key);
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
        // 工具门控：必须在录制（recordedRequests.set）与转发之前剥除，
        // 保证"录制体 == 出站体"，ping 逐字节重放无需感知门控的存在。
        const gateMark = applyToolGate(j);
        if (gateMark) injected.push('tool-gate=' + gateMark.dropped);
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
            credentialRef: detectCredentialRef(req.headers),
            authScheme: detectAuthScheme(req.headers),
          });
          // ── waiting 意图迁移（2026-10-23 审计 T20）──────────────────────
          // 开启保温时若还没有请求体，意图只能登记在"当时的 key"（可能是
          // system-hash 兜底键）。真实请求带 session 标识到达后派生出的 key
          // 与它不同，若不迁移，意图永远匹配不上 —— 表现为"登记了等待却永不恢复"。
          if (!pings.has(currentKey) && currentSessionId) {
            for (const [oldKey, p] of pings.entries()) {
              if (p.waitingForRequest !== true || p.migratedTo) continue;
              if (oldKey === currentKey) continue;
              // 只迁移"等待中且无对应会话身份"的条目
              pings.delete(oldKey);
              if (pingTimers.has(oldKey)) { clearInterval(pingTimers.get(oldKey)); pingTimers.delete(oldKey); }
              const migrated = { ...p, key: currentKey, waitingForRequest: true, migratedFrom: oldKey };
              pings.set(currentKey, migrated);
              console.log(`[ping] migrated waiting intent ${oldKey} -> ${currentKey} (session ${currentSessionId})`);
              break;
            }
          }

          // 真实流量到达：重锚窗口（2026-10-25 区间突发引擎）
          // 真实请求本身就是一次缓存确认触碰 → anchorMs=now，取消在途突发，
          // 预约 anchor+windowStartMin 的下一个窗口。waiting/stale 同步自愈。
          if (pings.has(currentKey)) {
            const p = pings.get(currentKey);
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
            if (p.on) {
              p.burst = null;
              p.anchorMs = Date.now();
              scheduleWindow(currentKey);
              // waiting 恢复时立即探测一次确认 cache 状态（命中则自然重锚）
              if (wasWaiting) setImmediate(() => attemptPing(currentKey));
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
    loadToolGate();
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
  inFlightKeys,
  pendingPingKeys,
  config,
  PORT,
  persistBodies,
  loadPersistedBodies,
  persistPings,
  loadPersistedPings,
  persistDeleteKey,
  applyToolGate,
  toolGate,
  persistToolGate,
  loadToolGate,
  TOOLGATE_FILE,
  runSelfCheck,
  totalInputTokens,
  PERSIST_FILE,
  PINGS_FILE,
};
