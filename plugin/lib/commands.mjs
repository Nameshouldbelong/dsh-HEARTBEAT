import { readState, updateSessionState } from './state.mjs';
import {
  sidecarControlOn,
  sidecarControlOff,
  sidecarVerify,
  sidecarSessions,
  sidecarToolGateGet,
  sidecarToolGateSet,
} from './sidecar-client.mjs';
import { sessionKeyFor } from './keys.mjs';

export function parseHtoParam(input) {
  // 2026-10-25 区间突发版：参数是保温窗口。
  //   空            → 默认 20-30
  //   "20-30"       → 窗口 [20,30]（含端点，30min 整之后不再尝试）
  //   "30"          → 旧单值兼容 → [max(1,30-10), 30] = 20-30
  const usage = '用法：/HTON [起-止]（分钟，1-720，如 20-30；不带参数默认 20-30）';
  const DEFAULT_START = 20;
  const DEFAULT_END = 30;
  if (typeof input !== 'string' || !input.trim()) {
    return { valid: true, startMin: DEFAULT_START, endMin: DEFAULT_END };
  }
  const trimmed = input.trim();
  const range = trimmed.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (range) {
    const s = Number(range[1]);
    const e = Number(range[2]);
    if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e <= 720 && s < e
        && Number.isSafeInteger(s) && Number.isSafeInteger(e)) {
      return { valid: true, startMin: s, endMin: e };
    }
    return { valid: false, error: usage };
  }
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isSafeInteger(n) && n >= 11 && n <= 720) {
      return { valid: true, startMin: Math.max(1, n - 10), endMin: n };
    }
    return { valid: false, error: usage };
  }
  return { valid: false, error: usage };
}

// 兼容别名（旧引用）
const parseHbWindowParam = parseHtoParam;

// 2026-10-21 v2：key 不再「解析」而是「推导」。
// 旧实现 resolveSessionKey 有两处致命缺陷，已全部删除：
//   ① recency 策略——把 sidecar 里 10min 内最新活跃的 key 认作"当前会话"，
//      多会话并发时必然张冠李戴（10-21 事故：LSD1 被绑到别的会话的 E2E 测试 key）；
//   ② 兜底伪造——`dshsc-${sessionId.slice(0,16)}` 这种根本不存在的键，
//      会让 sidecar 进入 waiting 并永远等不到流量，UI 却显示"已开启"。
// 现在 key 只由 sessionId 确定性派生，两端算法一致，无法漂移也无法猜错。
export function resolveSessionKey(sessionId) {
  return sessionKeyFor(sessionId);
}

/**
 * 开启前交叉校验（用户裁定 #3）：绝不「假装 ACTIVE」。
 * 三条判据（任一条不过即拒绝开启，并把原因如实回报给用户）：
 *   ① sidecar 有该 key 的真实请求记录；
 *   ② 请求体里的会话标识与本次要保温的 sessionId 一致；
 *   ③ 观测到的 prompt 规模落在期望区间内（默认 ±25%）。
 * 第 ③ 条是识破"key 打错对象"最直接的一刀：拿 90 token 的测试前缀当 480k
 * 会话去保温，量级差 5000 倍，一眼可分。
 *
 * @returns {{ok:boolean, result?:object, reason?:string, text:string}}
 */
export async function verifyBinding(sessionId, key, { expectedPromptTokens = null, tolerance = 0.25 } = {}) {
  const res = await sidecarVerify({
    key,
    sessionId,
    expectedPromptTokens,
    tolerance,
  }).catch(() => null);

  if (!res || res.status !== 200 || !res.data) {
    return {
      ok: false,
      reason: 'sidecar-unreachable',
      text: '⚠️ sidecar 未响应，无法校验保温对象；已拒绝开启（不假装 ACTIVE）',
    };
  }
  const r = res.data;
  if (r.ok) return { ok: true, result: r, text: '' };

  const why = (r.reasons || []).join(', ');
  const detail = [];
  if (r.reasons?.includes('no-request-recorded')) {
    detail.push('sidecar 里还没有本会话的请求记录（先在该会话对话一轮再开）');
  }
  if (r.reasons?.includes('session-id-mismatch')) {
    detail.push(`key 对应的真实会话是 ${r.bodySessionId || '未知'}，与目标 ${sessionId} 不符`);
  }
  if (r.reasons?.includes('prompt-size-mismatch')) {
    detail.push(`观测前缀 ${r.actualPromptTokens} token，期望 ${r.expectedPromptTokens}±${Math.round(tolerance * 100)}%（量级不符，疑似打到别的会话）`);
  }
  if (r.reasons?.includes('no-observed-traffic')) {
    detail.push('该 key 尚无成功流量，无法确认前缀规模');
  }
  return {
    ok: false,
    reason: why,
    result: r,
    text: `⛔ 保温对象校验未通过（${why}）：${detail.join('；')}`,
  };
}

/**
 * 取该会话的期望前缀规模：优先用调用方给的实测值（会话日志里最近一步的
 * prompt 规模），否则退回 sidecar 侧对**同一 sessionId** 的观测值。
 */
async function resolveExpectedPromptTokens(sessionId, key, provided) {
  if (Number.isFinite(provided) && provided > 0) return provided;
  try {
    const list = await sidecarSessions();
    const hit = list.find((s) => s.sessionId === sessionId && s.key === key);
    if (hit && Number(hit.lastPromptTokens) > 0) return Number(hit.lastPromptTokens);
  } catch {}
  return null;
}

/** 取会话的保温窗口：优先 windowStartMin/windowEndMin，旧 intervalMin 映射 [N-10,N]，缺省 20-30 */
export function windowOfSession(session) {
  if (session && Number.isFinite(Number(session.windowStartMin)) && Number.isFinite(Number(session.windowEndMin))) {
    return { startMin: Number(session.windowStartMin), endMin: Number(session.windowEndMin) };
  }
  if (session && Number.isFinite(Number(session.intervalMin)) && session.intervalMin >= 11) {
    return { startMin: Math.max(1, Number(session.intervalMin) - 10), endMin: Number(session.intervalMin) };
  }
  return { startMin: 20, endMin: 30 };
}

export async function executeHton(sessionId, statePath, opts = {}) {
  const state = readState(statePath);
  const current = state.sessions[sessionId];
  const fallback = windowOfSession(current);
  const parsed = parseHtoParam(opts.windowArg);
  const win = parsed.valid ? parsed : fallback;
  const { startMin, endMin } = win;
  const key = resolveSessionKey(sessionId);

  const expected = await resolveExpectedPromptTokens(sessionId, key, opts.expectedPromptTokens);
  const check = await verifyBinding(sessionId, key, { expectedPromptTokens: expected });
  if (!check.ok && check.reason === 'no-request-recorded') {
    // 2026-10-23 审计 T20：还没有请求体时，**必须把等待意图注册到 sidecar**，
    // 而不是只在本地 state 里写个 waiting 字样。否则 sidecar 不知道有人想保温，
    // 下一条真实请求到达也不会自动开循环 —— 用户以为开着，实际永远等不到。
    const res = await sidecarControlOn(key, startMin, endMin, 'resume').catch(() => null);
    const waiting = res != null && res.status === 409;
    updateSessionState(statePath, sessionId, {
      key, on: true, windowStartMin: startMin, windowEndMin: endMin, intervalMin: endMin, waiting,
    });
    if (res == null) {
      return `⚠️ sidecar 未响应（已记录开启意图，reconciler 会补挂）`;
    }
    return `⏳ 已登记等待：该会话下一次真实请求到达后自动开始保温（窗口 ${startMin}-${endMin}min）`;
  }
  if (!check.ok) {
    // 真打错对象：校验失败不写 on:true —— 状态必须与事实一致
    updateSessionState(statePath, sessionId, { key, on: false, waiting: false });
    return check.text;
  }

  const res = await sidecarControlOn(key, startMin, endMin).catch(() => null);
  updateSessionState(statePath, sessionId, {
    key, on: true, windowStartMin: startMin, windowEndMin: endMin, intervalMin: endMin,
    waiting: res != null && res.status === 409,
  });

  if (!res || res.status !== 200) {
    return `⚠️ sidecar 未响应（已记录开启意图，reconciler 定期自动补挂，窗口 ${startMin}-${endMin}min）`;
  }
  return `💓 心跳已开启（窗口 ${startMin}-${endMin}min，窗口内每 5s 突发至成功，前缀 ${check.result?.actualPromptTokens ?? '?'} token），已立即执行首次探测`;
}

export async function executeHtoff(sessionId, statePath) {
  const state = readState(statePath);
  const key = state.sessions[sessionId]?.key || resolveSessionKey(sessionId);

  // 先把"用户意图"落盘（desiredOn:false）。即便 OFF 请求失败，
  // reconciler 也会按此意图继续补偿，直到 sidecar 确认停止。
  updateSessionState(statePath, sessionId, {
    key, on: false, waiting: false, desiredOn: false, offPending: true,
  });

  let ok = false;
  let err = null;
  try {
    const res = await sidecarControlOff(key);
    ok = res != null && res.status === 200;
    if (!ok) err = `HTTP ${res == null ? 'no-response' : res.status}`;
  } catch (e) {
    err = String(e && e.message ? e.message : e);
  }

  if (ok) {
    updateSessionState(statePath, sessionId, { offPending: false, offError: null });
    return '💓 心跳已关闭';
  }

  // 2026-10-23 审计 T19：**不能谎报已关闭**。记录待补偿状态并如实回报，
  // reconciler 会在控制端点恢复后重试 OFF。
  updateSessionState(statePath, sessionId, { offPending: true, offError: err });
  return `⏸ 已标记关闭，但 sidecar 未确认（${err}）——将自动重试`;
}

export async function executeHto(arg, sessionId, statePath, opts = {}) {
  const parsed = parseHtoParam(arg);
  if (!parsed.valid) {
    return parsed.error;
  }

  const { startMin, endMin } = parsed;
  const key = resolveSessionKey(sessionId);

  const expected = await resolveExpectedPromptTokens(sessionId, key, opts.expectedPromptTokens);
  const check = await verifyBinding(sessionId, key, { expectedPromptTokens: expected });
  if (!check.ok) {
    updateSessionState(statePath, sessionId, { key, on: false, waiting: false });
    return check.text;
  }

  const res = await sidecarControlOn(key, startMin, endMin).catch(() => null);
  updateSessionState(statePath, sessionId, {
    key,
    on: true,
    windowStartMin: startMin,
    windowEndMin: endMin,
    intervalMin: endMin,
    waiting: res != null && res.status === 409,
  });

  let receipt;
  if (!res || res.status !== 200) {
    receipt = `⚠️ sidecar 未响应（已记录开启意图，reconciler 定期自动补挂，窗口 ${startMin}-${endMin}min）`;
  } else {
    receipt = `💓 心跳窗口已设为 ${startMin}-${endMin}min 并开启（窗口内每 5s 突发至成功，前缀 ${check.result?.actualPromptTokens ?? '?'} token），已立即执行首次探测`;
  }

  if (endMin >= 40) {
    receipt += `\n⚠️ 窗口右端≥40min：实测缓存存活约 28–45min，可能来不及续期`;
  }
  return receipt;
}

// ── 工具门控指令（2026-10-24，rea MCP 652KB schema 触发 Kimi 400 的产物）──
// 语义：门控只作用于 kimi 出站（经 sidecar 的请求）；其他 provider 直连
// 不受影响。开启后按前缀剥除工具，即点即生效，无需重启 dsh。
function toolGateReceipt(g) {
  const kb = (n) => (Number(n) / 1024).toFixed(1) + 'KB';
  return `剥除前缀：${g.dropPrefixes.join(', ')}｜累计剥除 ${g.stats.strippedTools} 个工具 / ${kb(g.stats.savedBytes)}（${g.stats.gatedRequests} 次请求）`;
}

export async function executeTgon() {
  const res = await sidecarToolGateSet({ enabled: true }).catch(() => null);
  if (!res || res.status !== 200) {
    return `⚠️ sidecar 未响应（${res ? 'HTTP ' + res.status : 'no-response'}），工具门控状态未确认`;
  }
  return `🚪 工具门控已开启（kimi 出站按前缀剥除）\n${toolGateReceipt(res.data)}`;
}

export async function executeTgoff() {
  const res = await sidecarToolGateSet({ enabled: false }).catch(() => null);
  if (!res || res.status !== 200) {
    return `⚠️ sidecar 未响应（${res ? 'HTTP ' + res.status : 'no-response'}），工具门控状态未确认`;
  }
  const g = res.data;
  return `🚪 工具门控已关闭（kimi 出站原样透传，带超限 schema 的请求将被 Kimi 400）\n前缀保留：${g.dropPrefixes.join(', ')}`;
}

export async function executeTgstatus() {
  const g = await sidecarToolGateGet().catch(() => null);
  if (!g) return '⚠️ sidecar 未响应或为旧版（无 /control/toolgate）';
  return `🚪 工具门控：${g.enabled ? '开启' : '关闭'}\n${toolGateReceipt(g)}`;
}
