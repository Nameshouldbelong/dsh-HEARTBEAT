import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 独立验证：插件 state.json 说 off，但 sidecar 说 on -> state-diverged 报警
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-div-'));

async function fakeSidecar(t, pingsPayload) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      let r;
      if (req.url === '/sessions') r = { status: 200, json: { sessions: [] } };
      else if (req.url === '/control/state') r = { status: 200, json: { pings: pingsPayload, selfCheck: { ok: true, alarms: [] } } };
      else if (req.url === '/selfcheck') r = { status: 200, json: { ok: true, alarms: [] } };
      else r = { status: 200, json: { ok: true } };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.SIDECAR_PORT = String(server.address().port);
  t.after(() => server.close());
}

test('state-diverged: 插件 off / sidecar on -> 报警', async (t) => {
  const { apply } = await import('../lib/index.mjs');
  const { updateSessionState, readState } = await import('../lib/state.mjs');
  const { sessionKeyFor } = await import('../lib/keys.mjs');

  const SID = 'session-diverge-0001';
  const KEY = sessionKeyFor(SID);
  await fakeSidecar(t, [{ key: KEY, on: true, intervalMin: 25, pingCount: 0, waitingForRequest: true, health: 'waiting' }]);

  let webHandler = null;
  const ctx = {
    effect() {}, commands: { register() {} }, on() {}, webServer: {
      register({ path: p, handler }) { if (p === '/heartbeat') webHandler = handler; },
    },
    sessionQuery: {
      async listSessions() { return [{ header: { id: SID } }]; },
      async readTitleSnapshots() { return new Map(); },
    },
  };
  apply(ctx);
  // 确保插件侧记录为 off：直接写状态文件（updateSessionState 需要文件路径）
  const { getDefaultStatePath } = await import('../lib/state.mjs');
  updateSessionState(getDefaultStatePath(), SID, { key: KEY, on: false, intervalMin: 30 });

  const res = await new Promise((resolve) => {
    const r = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = b; resolve(this); }, writeHead(c) { this.statusCode = c; } };
    webHandler({ method: 'GET', url: '/heartbeat/api/state' }, r);
  });
  const json = JSON.parse(res.body);
  const row = (json.sessions || []).find((s) => s.key === KEY);
  assert.ok(row, '应有该会话行');
  const codes = (row.alarms || []).map((a) => a.code);
  assert.ok(codes.includes('state-diverged'), '插件 off 而 sidecar on 必须报警: ' + JSON.stringify(row.alarms));
});
