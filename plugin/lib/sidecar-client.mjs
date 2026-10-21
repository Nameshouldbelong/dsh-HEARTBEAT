import http from 'node:http';

export function getSidecarBaseUrl() {
  const port = process.env.SIDECAR_PORT || '8791';
  const host = process.env.SIDECAR_HOST || '127.0.0.1';
  return `http://${host}:${port}`;
}

function sidecarRequest(endpoint, options = {}) {
  const base = new URL(getSidecarBaseUrl());
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: endpoint,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 3000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, text: body });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ status: 503, error: String(err) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 504, error: 'sidecar-timeout' });
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

export async function sidecarHealthz() {
  return sidecarRequest('/healthz');
}

export async function sidecarSessions() {
  const res = await sidecarRequest('/sessions');
  return res.status === 200 && Array.isArray(res.data?.sessions) ? res.data.sessions : [];
}

export async function sidecarControlState() {
  const res = await sidecarRequest('/control/state');
  return res.status === 200 && Array.isArray(res.data?.pings) ? res.data.pings : [];
}

/**
 * 读取 sidecar 的启动自检结果（2026-10-21 新增）。
 * 返回 {ok, checkedAt, alarms[]}；拿不到时返回 null（面板据此不渲染报警区）。
 */
export async function sidecarSelfCheck() {
  const res = await sidecarRequest('/selfcheck');
  if ((res.status === 200 || res.status === 409) && res.data && typeof res.data === 'object') {
    return res.data;
  }
  // 旧版 sidecar 无该端点：退回用 /control/state 里夹带的那份
  const st = await sidecarRequest('/control/state');
  return st.data?.selfCheck || null;
}

export async function sidecarControlOn(key, intervalMin = 30) {
  return sidecarRequest('/control/on', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, intervalMin }),
  });
}

export async function sidecarControlOff(key) {
  return sidecarRequest('/control/off', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
}

// 开启前交叉校验（2026-10-21 用户裁定 #3）：确认这个 key 真的对应本会话，
// 避免把保温打到别的会话 / 历史测试 key 上（10-21 事故根因）。
export async function sidecarVerify({ key, sessionId, expectedPromptTokens, tolerance }) {
  return sidecarRequest('/control/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, sessionId, expectedPromptTokens, tolerance }),
    timeout: 5000,
  });
}
