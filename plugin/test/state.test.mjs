import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readState, writeStateAtomic, updateSessionState, removeSessionState } from '../lib/state.mjs';

test('state: 读不存在的文件返回默认状态', () => {
  const tmpFile = path.join(os.tmpdir(), `dsh-test-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const state = readState(tmpFile);
  assert.equal(state.version, 1);
  assert.deepEqual(state.sessions, {});
});

test('state: 原子写入 (tmp + rename) 保证数据完整性', () => {
  const tmpDir = path.join(os.tmpdir(), `dsh-test-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const targetFile = path.join(tmpDir, 'state.json');

  try {
    const data = {
      version: 1,
      sessions: {
        'session-1': {
          key: 'dshsc-1234567890abcdef',
          on: true,
          intervalMin: 50,
          updatedAt: Date.now(),
        },
      },
    };

    writeStateAtomic(targetFile, data);
    assert.ok(fs.existsSync(targetFile));

    const loaded = readState(targetFile);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.sessions['session-1'].key, 'dshsc-1234567890abcdef');
    assert.equal(loaded.sessions['session-1'].on, true);
    assert.equal(loaded.sessions['session-1'].intervalMin, 50);

    // 验证同目录下不遗留 tmp 临时文件
    const files = fs.readdirSync(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(files[0], 'state.json');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('state: updateSessionState 与 removeSessionState', () => {
  const tmpFile = path.join(os.tmpdir(), `dsh-test-crud-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    // 1. 创建会话状态
    const s1 = updateSessionState(tmpFile, 'sess-a', {
      key: 'dshsc-key-a',
      on: true,
      intervalMin: 30,
    });
    assert.equal(s1.key, 'dshsc-key-a');
    assert.equal(s1.on, true);
    assert.equal(s1.intervalMin, 30);
    assert.ok(s1.updatedAt > 0);

    // 2. 修改会话状态
    const s2 = updateSessionState(tmpFile, 'sess-a', {
      on: false,
    });
    assert.equal(s2.key, 'dshsc-key-a');
    assert.equal(s2.on, false);
    assert.equal(s2.intervalMin, 30);

    // 3. 删除会话状态
    const removed = removeSessionState(tmpFile, 'sess-a');
    assert.equal(removed, true);

    const reloaded = readState(tmpFile);
    assert.equal(reloaded.sessions['sess-a'], undefined);

    const removedAgain = removeSessionState(tmpFile, 'sess-a');
    assert.equal(removedAgain, false);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
