import { readState, updateSessionState } from './state.mjs';
import {
  sidecarControlOn,
  sidecarControlOff,
  sidecarVerify,
  sidecarSessions,
} from './sidecar-client.mjs';
import { sessionKeyFor } from './keys.mjs';

export function parseHtoParam(input) {
  const usage = '用法：/HTO <分钟>（1-720），如 /HTO 60';
  if (typeof input !== 'string') {
    return { valid: false, error: usage };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, error: usage };
  }
  // 必须是纯整数字符串，不可包含小数点、非数字字符或多余分词
  if (!/^\d+$/.test(trimmed)) {
    return { valid: false, error: usage };
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < 1 || num > 720) {
    return { valid: false, error: usage };
  }
  return { valid: true, minutes: num };
}

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

export async function executeHton(sessionId, statePath, opts = {}) {
  const state = readState(statePath);
  const current = state.sessions[sessionId];
  const intervalMin = current?.intervalMin || 30;
  const key = resolveSessionKey(sessionId);

  const expected = await resolveExpectedPromptTokens(sessionId, key, opts.expectedPromptTokens);
  const check = await verifyBinding(sessionId, key, { expectedPromptTokens: expected });
  if (!check.ok) {
    // 校验失败不写 on:true —— 状态必须与事实一致
    updateSessionState(statePath, sessionId, { key, on: false, waiting: false });
    return check.text;
  }

  const res = await sidecarControlOn(key, intervalMin).catch(() => null);
  updateSessionState(statePath, sessionId, { key, on: true, intervalMin, waiting: res != null && res.status === 409 });

  if (!res || res.status !== 200) {
    return `⚠️ sidecar 未响应（已记录开启意图，reconciler 定期自动补挂，间隔 ${intervalMin}min）`;
  }
  return `💓 心跳已开启（间隔 ${intervalMin}min，前缀 ${check.result?.actualPromptTokens ?? '?'} token），已立即执行首次保温`;
}

export async function executeHtoff(sessionId, statePath) {
  const state = readState(statePath);
  const key = state.sessions[sessionId]?.key || resolveSessionKey(sessionId);

  updateSessionState(statePath, sessionId, { key, on: false, waiting: false });

  try {
    await sidecarControlOff(key);
  } catch {}

  return '💓 心跳已关闭';
}

export async function executeHto(arg, sessionId, statePath, opts = {}) {
  const parsed = parseHtoParam(arg);
  if (!parsed.valid) {
    return parsed.error;
  }

  const intervalMin = parsed.minutes;
  const key = resolveSessionKey(sessionId);

  const expected = await resolveExpectedPromptTokens(sessionId, key, opts.expectedPromptTokens);
  const check = await verifyBinding(sessionId, key, { expectedPromptTokens: expected });
  if (!check.ok) {
    updateSessionState(statePath, sessionId, { key, on: false, waiting: false });
    return check.text;
  }

  const res = await sidecarControlOn(key, intervalMin).catch(() => null);
  updateSessionState(statePath, sessionId, {
    key,
    on: true,
    intervalMin,
    waiting: res != null && res.status === 409,
  });

  let receipt;
  if (!res || res.status !== 200) {
    receipt = `⚠️ sidecar 未响应（已记录开启意图，reconciler 定期自动补挂，间隔 ${intervalMin}min）`;
  } else {
    receipt = `💓 心跳间隔已设为 ${intervalMin}min 并开启（前缀 ${check.result?.actualPromptTokens ?? '?'} token），已立即执行首次保温`;
  }

  if (intervalMin >= 40) {
    receipt += '\n⚠️ 间隔≥40min：实测缓存存活约 28–45min，可能来不及续期';
  }
  return receipt;
}
