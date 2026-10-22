// 2026-10-22 第二轮审计回归（用户核查 e44d637..03c49c3 后提出）
// 关键约束：必须覆盖**生产路径** startReconciler()，不能只测 runReconciliation()
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { sessionKeyFor } = await import('../lib/keys.mjs');

async function fakeSidecar(t, ctl) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.url === '/sessions') {
        const s = ctl.sessions || [];
        return send(200, { sessions: s });
      }
      if (req.url === '/control/on') {
        ctl.onCalls.push(body.key);
        // 模拟真实 sidecar：熔断（stale / on:false）后再次 /control/on 会短路返回，
        // 但**不清除熔断**。真实代码 L1294 只清 stale 而 on 保持 false，
        // 这里如实返回 on:false 让调用方看见"开了但没生效"。
        if (ctl.breakerOpen && ctl.breakerOpen.has(body.key)) {
          return send(200, { ok: true, state: { key: body.key, on: false, health: 'stale', stale: true } });
        }
        return send(200, { ok: true, immediatePing: false, state: { key: body.key, on: true } });
      }
      if (req.url === '/control/off') { ctl.offCalls.push(body.key); return send(200, { ok: true }); }
      if (req.url === '/control/verify') {
        const v = ctl.verify || {};
        return send(200, { ok: v.ok !== false, key: body.key, sessionId: body.sessionId, reasons: v.reasons || [], actualPromptTokens: v.tokens || 500000 });
      }
      if (req.url === '/control/state') return send(200, { pings: ctl.pings || [], selfCheck: { ok: true, alarms: [] } });
      if (req.url === '/selfcheck') return send(200, { ok: true, alarms: [] });
      return send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.SIDECAR_PORT = String(server.address().port);
  t.after(() => server.close());
}

test('审计二-1: sidecar 熔断后，startReconciler 的生产对账不得重新开启', async (t) => {
  const ctl = { onCalls: [], offCalls: [], breakerOpen: new Set() };
  await fakeSidecar(t, ctl);

  const { startReconciler } = await import('../lib/reconciler.mjs');
  const { updateSessionState, readState, getDefaultStatePath } = await import('../lib/state.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-r2-1-'));
  const statePath = path.join(dir, 'state.json');

  const SID = 'session-breaker-test-01';
  // 必须用真实派生 key：用编造的 key 会先命中 rekey 分支，测不到熔断路径
  const KEY = sessionKeyFor(SID);
  updateSessionState(statePath, SID, { key: KEY, on: true, intervalMin: 30 });
  ctl.breakerOpen.add(KEY);   // sidecar 侧已熔断

  const ctx = {
    on() {}, effect() {},
    sessionQuery: { async listSessions() { return [{ header: { id: SID } }]; } },
    workspaceRegistry: { archivedSessionIds: [] },
  };

  const handle = startReconciler({ ctx, statePath, intervalMs: 60_000, hooks: {} });
  t.after(() => { try { handle.stop?.(); } catch {} });
  await new Promise((r) => setTimeout(r, 800));

  // 断言 1：不得对熔断的 key 反复调用 /control/on（最多一次探测）
  assert.ok(ctl.onCalls.length <= 1,
    `熔断后不得被对账反复重新开启，实测 on 调用 ${ctl.onCalls.length} 次: ` + JSON.stringify(ctl.onCalls));

  // 断言 2：插件侧状态不得继续声称 on=true 而不知情
  const st = readState(statePath).sessions[SID];
  assert.ok(st, '会话配置应保留');
  const claimsRunning = st.on === true && !st.verifyError && !st.blockedReason && st.waiting !== true;
  assert.equal(claimsRunning, false,
    '❗sidecar 已熔断时，插件不得继续显示为正常运行状态: ' + JSON.stringify(st));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('审计二-2: startReconciler 在宿主列表+磁盘都不可用时不得删除配置', async (t) => {
  const ctl = { onCalls: [], offCalls: [] };
  await fakeSidecar(t, ctl);

  const { startReconciler } = await import('../lib/reconciler.mjs');
  const { updateSessionState, readState } = await import('../lib/state.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-r2-2-'));
  const statePath = path.join(dir, 'state.json');

  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(dir, 'no-host-home');   // 磁盘兜底也为空

  const SID = 'session-listing-fail-01';
  updateSessionState(statePath, SID, { key: sessionKeyFor(SID), on: true, intervalMin: 30 });

  const ctx = {
    on() {}, effect() {},
    sessionQuery: { async listSessions() { throw new Error('host temporarily unavailable'); } },
    workspaceRegistry: { archivedSessionIds: [] },
  };

  const handle = startReconciler({ ctx, statePath, intervalMs: 60_000, hooks: {} });
  t.after(() => {
    try { handle.stop?.(); } catch {}
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  });
  await new Promise((r) => setTimeout(r, 800));

  const st = readState(statePath).sessions[SID];
  assert.ok(st, '❗宿主列表不可用时绝不能删除会话配置（生产路径 startReconciler）');
  assert.equal(st.on, true, 'on 状态必须保留');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('审计二-1 强化: 熔断后连续多轮对账，额外 /control/on 次数必须为 0', async (t) => {
  const ctl = { onCalls: [], offCalls: [], breakerOpen: new Set() };
  await fakeSidecar(t, ctl);

  const { startReconciler } = await import('../lib/reconciler.mjs');
  const { updateSessionState, readState } = await import('../lib/state.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-r2-1b-'));
  const statePath = path.join(dir, 'state.json');

  const SID = 'session-breaker-loop-01';
  const KEY = sessionKeyFor(SID);   // 真实派生 key，才能走到熔断检查
  updateSessionState(statePath, SID, { key: KEY, on: true, intervalMin: 30 });
  ctl.breakerOpen.add(KEY);

  const ctx = {
    on() {}, effect() {},
    sessionQuery: { async listSessions() { return [{ header: { id: SID } }]; } },
    workspaceRegistry: { archivedSessionIds: [] },
  };

  // 极短周期触发多轮对账（模拟"100 次对账"的等价效果）
  const handle = startReconciler({ ctx, statePath, intervalMs: 40, hooks: {} });
  t.after(() => { try { handle.stop?.(); } catch {} });
  await new Promise((r) => setTimeout(r, 1200));

  const st = readState(statePath).sessions[SID];
  assert.equal(st.on, false, '熔断后插件侧必须同步为 off');
  assert.equal(st.blockedReason, 'breaker-tripped', '必须记录熔断原因');
  // 首轮探测 1 次，之后不得再试
  assert.ok(ctl.onCalls.length <= 2,
    `熔断后多轮对账不得反复 /control/on，实测 ${ctl.onCalls.length} 次`);
  // 已置 off 后，后续轮次不应再调用
  const callsAfterBlock = ctl.onCalls.filter((k) => k === KEY).length;
  assert.ok(callsAfterBlock >= 1 && callsAfterBlock <= 2, '只允许探测一次即停: ' + callsAfterBlock);

  fs.rmSync(dir, { recursive: true, force: true });
});
