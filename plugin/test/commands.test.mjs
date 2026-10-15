import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseHtoParam, executeHton, executeHtoff, executeHto } from '../lib/commands.mjs';
import { readState } from '../lib/state.mjs';

test('Contract-E: parseHtoParam 参数解析', () => {
  const usage = '用法：/HTO <分钟>（1-720），如 /HTO 60';

  // 1. 合法整数 (1–720)
  assert.deepEqual(parseHtoParam('1'), { valid: true, minutes: 1 });
  assert.deepEqual(parseHtoParam('50'), { valid: true, minutes: 50 });
  assert.deepEqual(parseHtoParam('60'), { valid: true, minutes: 60 });
  assert.deepEqual(parseHtoParam('720'), { valid: true, minutes: 720 });

  // 2. 含空格（前导、后置、多重空格）
  assert.deepEqual(parseHtoParam('  60'), { valid: true, minutes: 60 });
  assert.deepEqual(parseHtoParam('60  '), { valid: true, minutes: 60 });
  assert.deepEqual(parseHtoParam('   50   '), { valid: true, minutes: 50 });
  assert.deepEqual(parseHtoParam('  720  '), { valid: true, minutes: 720 });

  // 3. 越界 (0, 721, 负数, 超大数字)
  assert.deepEqual(parseHtoParam('0'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('721'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('-1'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('-50'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('1000'), { valid: false, error: usage });

  // 4. 非数字 / 异常输入
  assert.deepEqual(parseHtoParam('abc'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('60min'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('50.5'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('50 30'), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam(''), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam('   '), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam(null), { valid: false, error: usage });
  assert.deepEqual(parseHtoParam(undefined), { valid: false, error: usage });
});

test('Contract-E: /HTON, /HTOFF, /HTO 回执与状态变更', async () => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    const sessionId = 'test-duty-session-1';

    // 1. /HTON 开启（默认 50min）
    const r1 = await executeHton(sessionId, tmpFile);
    assert.equal(r1, '💓 心跳已开启（间隔 50min）');
    let state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].intervalMin, 50);

    // 2. /HTOFF 关闭
    const r2 = await executeHtoff(sessionId, tmpFile);
    assert.equal(r2, '💓 心跳已关闭');
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, false);

    // 3. /HTO 30 设间隔并开启 (<60min 无告警)
    const r3 = await executeHto('30', sessionId, tmpFile);
    assert.equal(r3, '💓 心跳间隔已设为 30min 并开启');
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].intervalMin, 30);

    // 4. /HTO 60 设间隔并开启 (>=60min 触发 1h TTL 告警)
    const r4 = await executeHto('60', sessionId, tmpFile);
    assert.ok(r4.includes('💓 心跳间隔已设为 60min 并开启'));
    assert.ok(r4.includes('⚠️ 间隔≥60min：1h TTL 缓存会在 ping 间过期'));
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].on, true);
    assert.equal(state.sessions[sessionId].intervalMin, 60);

    // 5. /HTO 含空格参数 '  45  '
    const r5 = await executeHto('  45  ', sessionId, tmpFile);
    assert.equal(r5, '💓 心跳间隔已设为 45min 并开启');
    state = readState(tmpFile);
    assert.equal(state.sessions[sessionId].intervalMin, 45);

    // 6. /HTO 错误参数 -> 不变更状态，返回用法提示
    const r6 = await executeHto('invalid', sessionId, tmpFile);
    assert.equal(r6, '用法：/HTO <分钟>（1-720），如 /HTO 60');
    state = readState(tmpFile);
    // 状态保持上一次的 45
    assert.equal(state.sessions[sessionId].intervalMin, 45);

    // 7. /HTON 沿用现有间隔（45min）
    const r7 = await executeHton(sessionId, tmpFile);
    assert.equal(r7, '💓 心跳已开启（间隔 45min）');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
