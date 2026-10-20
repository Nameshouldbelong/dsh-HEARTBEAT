import { readState, updateSessionState } from './state.mjs';
import { sidecarControlOn, sidecarControlOff, sidecarSessions } from './sidecar-client.mjs';

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

export async function resolveSessionKey(sessionId, statePath, { fresh = false } = {}) {
  if (!fresh) {
    const state = readState(statePath);
    if (state.sessions[sessionId]?.key) {
      return state.sessions[sessionId].key;
    }
  }
  // 尝试从 sidecar 活跃会话反查
  try {
    const list = await sidecarSessions();
    if (list.length > 0) {
      const match = list.find((s) => s.key === sessionId || s.key.includes(sessionId));
      if (match) return match.key;
      // 最近活跃策略: /HTON 时当前会话刚有过流量, 10min 内最新 lastSeen 的 key 即当前会话
      const freshList = list
        .filter((s) => s.lastSeenAt && Date.now() - Date.parse(s.lastSeenAt) < 10 * 60 * 1000)
        .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
      if (freshList.length > 0) return freshList[0].key;
      if (list.length === 1) return list[0].key;
    }
  } catch {}
  throw new Error('unresolved-session: 当前会话没有最近的缓存活动, 先对话一轮再 /HTON');
}

// KI-3：dshsc- key = sha256(system[:8000])，system prompt 漂移后同一会话 key 改变，
// 插件存的旧 key 再也等不到流量（/control/on 409，waiting 卡死）。
// 检测到「存储 key 409」时按 sidecar 新鲜流量重解析并重试一次。
// 防抢守卫：fresh key 若已被其他开启中的会话认领，不抢占（避免给错误会话保温）。
export async function rotateStaleKey(sessionId, statePath, oldKey, intervalMin) {
  const state = readState(statePath);
  // 仅当 oldKey 来自插件存储（漂移场景）才尝试轮换
  if (state.sessions[sessionId]?.key !== oldKey) return null;
  let fresh;
  try {
    fresh = await resolveSessionKey(sessionId, statePath, { fresh: true });
  } catch {
    return null;
  }
  if (!fresh || fresh === oldKey) return null;
  const claimed = Object.entries(state.sessions || {})
    .some(([id, s]) => id !== sessionId && s.on && s.key === fresh);
  if (claimed) return null;
  const res = await sidecarControlOn(fresh, intervalMin).catch(() => null);
  if (res && res.status === 200) {
    updateSessionState(statePath, sessionId, { key: fresh, on: true, intervalMin, waiting: false });
    return { key: fresh };
  }
  return null;
}

export async function executeHton(sessionId, statePath) {
  const state = readState(statePath);
  const current = state.sessions[sessionId];
  const intervalMin = current?.intervalMin || 45;
  const key = await resolveSessionKey(sessionId, statePath);

  const res = await sidecarControlOn(key, intervalMin).catch(() => null);

  // sidecar 无该 key 的请求记录（典型：sidecar 重启丢内存）：
  // 先试 KI-3 key 轮换（存储 key 随 system prompt 漂移失效）；
  // 轮换不成则说明真无流量，sidecar 已记录保温意图，如实告知不假装 ACTIVE
  if (res && res.status === 409) {
    const rotated = await rotateStaleKey(sessionId, statePath, key, intervalMin);
    if (rotated) {
      return `💓 心跳已开启（间隔 ${intervalMin}min），已立即执行首次保温`;
    }
    updateSessionState(statePath, sessionId, { key, on: true, intervalMin, waiting: true });
    return `💓 心跳意图已记录（间隔 ${intervalMin}min）：sidecar 暂无本会话请求记录，下一次真实请求到达后自动开始保温`;
  }

  updateSessionState(statePath, sessionId, { key, on: true, intervalMin, waiting: false });

  if (!res || res.status !== 200) {
    return `⚠️ sidecar 未响应（已记录开启意图，reconciler 每分钟自动补挂，间隔 ${intervalMin}min）`;
  }

  return `💓 心跳已开启（间隔 ${intervalMin}min），已立即执行首次保温`;
}

export async function executeHtoff(sessionId, statePath) {
  const state = readState(statePath);
  const key = state.sessions[sessionId]?.key || (await resolveSessionKey(sessionId, statePath));

  updateSessionState(statePath, sessionId, {
    key,
    on: false,
  });

  try {
    await sidecarControlOff(key);
  } catch {}

  return '💓 心跳已关闭';
}

export async function executeHto(arg, sessionId, statePath) {
  const parsed = parseHtoParam(arg);
  if (!parsed.valid) {
    return parsed.error;
  }

  const intervalMin = parsed.minutes;
  const key = await resolveSessionKey(sessionId, statePath);

  const res = await sidecarControlOn(key, intervalMin).catch(() => null);

  let receipt;
  if (res && res.status === 409) {
    const rotated = await rotateStaleKey(sessionId, statePath, key, intervalMin);
    if (rotated) {
      receipt = `💓 心跳间隔已设为 ${intervalMin}min 并开启，已立即执行首次保温`;
    } else {
      updateSessionState(statePath, sessionId, { key, on: true, intervalMin, waiting: true });
      receipt = `💓 心跳间隔已设为 ${intervalMin}min：sidecar 暂无本会话请求记录，下一次真实请求到达后自动开始保温`;
    }
  } else {
    updateSessionState(statePath, sessionId, { key, on: true, intervalMin, waiting: false });
    if (!res || res.status !== 200) {
      receipt = `⚠️ sidecar 未响应（已记录开启意图，reconciler 每分钟自动补挂，间隔 ${intervalMin}min）`;
    } else {
      receipt = `💓 心跳间隔已设为 ${intervalMin}min 并开启，已立即执行首次保温`;
    }
  }

  if (intervalMin >= 60) {
    receipt += '\n⚠️ 间隔≥60min：1h TTL 缓存会在 ping 间过期';
  }
  return receipt;
}
