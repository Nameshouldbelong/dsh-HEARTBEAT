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
        headers: options.body
          // 2026-10-23 审计 T19：显式给 content-length。
          // 否则 Node 用 transfer-encoding: chunked，经中间代理（gateway）转发时
          // 代理补的 content-length 与原 chunked 头冲突，下游解析失败 → HTTP 400，
          // 表现为"OFF 调用总是 400、关闭永远补偿不成功"。
          ? { ...(options.headers || {}), 'content-length': Buffer.byteLength(options.body) }
          : (options.headers || {}),
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

/**
 * 开启保温（2026-10-25 区间突发版：窗口 [startMin, endMin]，窗口内每 5s 突发至成功）。
 *
 * @param {'ensure'|'resume'} action
 *   'resume' = 用户显式开启，可解除可恢复熔断（低命中 / 403）。
 *   'ensure' = 自动对账补挂，**不得**解除熔断；熔断中返回 409 breaker-open。
 * 旧调用方不传窗口时默认 20-30；旧调用方传 intervalMin 数字时映射为 [N-10, N]。
 */
export async function sidecarControlOn(key, windowStartMin = 20, windowEndMin = 30, action = 'resume') {
  const payload = { key, action };
  if (typeof windowStartMin === 'number' && typeof windowEndMin === 'number') {
    payload.windowStartMin = windowStartMin;
    payload.windowEndMin = windowEndMin;
  } else if (typeof windowStartMin === 'number') {
    payload.intervalMin = windowStartMin; // 兼容旧签名 (key, intervalMin, action)
    if (typeof windowEndMin === 'string') payload.action = windowEndMin;
  }
  return sidecarRequest('/control/on', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
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

// 工具门控（2026-10-24）：读取/设置 kimi 出站的工具剥除开关。
// 返回 null 表示 sidecar 不可达或旧版无该端点（面板显示"不可用"而不是猜状态）。
export async function sidecarToolGateGet() {
  const res = await sidecarRequest('/control/toolgate');
  if (res.status === 200 && res.data && typeof res.data === 'object') return res.data;
  return null;
}

export async function sidecarToolGateSet(payload) {
  return sidecarRequest('/control/toolgate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
