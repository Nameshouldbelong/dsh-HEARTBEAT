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

export async function resolveSessionKey(sessionId, statePath) {
  const state = readState(statePath);
  if (state.sessions[sessionId]?.key) {
    return state.sessions[sessionId].key;
  }
  // 尝试从 sidecar 活跃会话反查
  try {
    const list = await sidecarSessions();
    if (list.length > 0) {
      const match = list.find((s) => s.key === sessionId || s.key.includes(sessionId));
      if (match) return match.key;
      if (list.length === 1) return list[0].key;
    }
  } catch {}
  return `dshsc-${sessionId.slice(0, 16)}`;
}

export async function executeHton(sessionId, statePath) {
  const state = readState(statePath);
  const current = state.sessions[sessionId];
  const intervalMin = current?.intervalMin || 50;
  const key = await resolveSessionKey(sessionId, statePath);

  updateSessionState(statePath, sessionId, {
    key,
    on: true,
    intervalMin,
  });

  try {
    await sidecarControlOn(key, intervalMin);
  } catch {}

  return `💓 心跳已开启（间隔 ${intervalMin}min）`;
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

  updateSessionState(statePath, sessionId, {
    key,
    on: true,
    intervalMin,
  });

  try {
    await sidecarControlOn(key, intervalMin);
  } catch {}

  let receipt = `💓 心跳间隔已设为 ${intervalMin}min 并开启`;
  if (intervalMin >= 60) {
    receipt += '\n⚠️ 间隔≥60min：1h TTL 缓存会在 ping 间过期';
  }
  return receipt;
}
