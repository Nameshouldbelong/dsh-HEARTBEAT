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

export async function sidecarControlOn(key, intervalMin = 50) {
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
