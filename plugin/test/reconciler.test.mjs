import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runReconciliation } from '../lib/reconciler.mjs';
import { readState, updateSessionState } from '../lib/state.mjs';

test('Contract-D: reconciler 对账（deleted/archived 会话置 OFF 并清理，活跃会话保留）', async () => {
  const tmpFile = path.join(os.tmpdir(), `dsh-reconcile-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    // 初始化 3 个会话：
    // sess-active: 活跃会话, on=true
    // sess-archived: 已归档会话, on=true
    // sess-deleted: 已删除会话, on=false
    updateSessionState(tmpFile, 'sess-active', {
      key: 'dshsc-active',
      on: true,
      intervalMin: 30,
    });
    updateSessionState(tmpFile, 'sess-archived', {
      key: 'dshsc-archived',
      on: true,
      intervalMin: 50,
    });
    updateSessionState(tmpFile, 'sess-deleted', {
      key: 'dshsc-deleted',
      on: false,
      intervalMin: 50,
    });

    // 此时活跃会话集合仅包含 sess-active
    const activeSessionIds = new Set(['sess-active']);

    const report = await runReconciliation({
      statePath: tmpFile,
      activeSessionIds,
    });

    assert.ok(report.removed.includes('sess-archived'));
    assert.ok(report.removed.includes('sess-deleted'));
    assert.equal(report.removed.length, 2);

    // 检查持久化 state.json
    const state = readState(tmpFile);
    assert.ok(state.sessions['sess-active']);
    assert.equal(state.sessions['sess-active'].on, true);
    assert.equal(state.sessions['sess-archived'], undefined);
    assert.equal(state.sessions['sess-deleted'], undefined);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
