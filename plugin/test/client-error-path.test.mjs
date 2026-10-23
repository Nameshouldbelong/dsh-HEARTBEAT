// 2026-10-24 独立审计回归：client fetchState 的错误分支必须真正生效。
//
// 缺陷（已修复）：2026-10-23 把轮询从"序号"重构为"代际"时，catch 分支遗留了
// 不存在的 mySeq 引用 —— fetch 失败（sidecar 挂 / 网络断 / 非 200）时该分支抛
// ReferenceError，setError 永不执行 → 错误横幅死代码 → 面板静默显示过期数据。
// 本测试用桩 React + 桩 fetch 驱动真实 client.mjs 的 fetchState，钉死该路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function loadClient() {
  // client.mjs 顶层会探测 window（无 __ModuleLoader__ 则跳过自注册）；
  // apply() 内取 window.React。全部用桩替代宿主环境。
  const boxes = [];
  const captured = [];
  const fakeReact = {
    createElement: (tag, props, ...kids) => ({ tag, props, kids }),
    useState: (v) => {
      const box = { value: typeof v === 'function' ? v() : v };
      boxes.push(box);
      return [box.value, (nv) => { box.value = typeof nv === 'function' ? nv(box.value) : nv; }];
    },
    useEffect: () => {},
    useCallback: (fn) => { captured.push(fn); return fn; },
  };
  globalThis.window = { React: fakeReact };
  globalThis.document = undefined;

  const mod = await import('../lib/client.mjs');
  let compFn = null;
  const react2 = { ...fakeReact, createElement: (tag, props, ...kids) => { if (typeof tag === 'function' && !compFn) compFn = tag; return { tag, props, kids }; } };
  const ctx = {
    effect: () => () => {},
    slots: { inject: (_slot, cb) => { try { cb(); } catch {} }, register: (_m, comp) => { try { comp({}); } catch {} } },
  };
  globalThis.window = { React: react2 };
  mod.apply(ctx);
  assert.ok(compFn, '应能通过 apply() 捕获 HeartbeatTabView 组件函数');
  return { boxes, captured, compFn };
}

test('2026-10-24 回归: fetch 失败时 fetchState 不得抛 ReferenceError，且必须 setError', async () => {
  const { boxes, captured, compFn } = await loadClient();
  boxes.length = 0; captured.length = 0;
  compFn({});
  assert.ok(captured.length >= 1, '应捕获 fetchState');

  const errBox = boxes[2]; // useState 顺序：stateData, loading, error, ...
  globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));

  await assert.doesNotReject(captured[0](), '错误分支不得抛 ReferenceError（旧缺陷：mySeq is not defined）');
  assert.ok(typeof errBox.value === 'string' && errBox.value.length > 0,
    'fetch 失败后 error 状态必须被设置（错误横幅依赖它）');
});

test('2026-10-24 回归: fetch 成功路径不受影响', async () => {
  const { boxes, captured, compFn } = await loadClient();
  boxes.length = 0; captured.length = 0;
  compFn({});
  const errBox = boxes[2];
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({ sessions: [], pings: [] }) });

  await assert.doesNotReject(captured[0]());
  assert.equal(errBox.value, null, '成功路径不得设置 error');
});

test('2026-10-24 回归: 旧代迟到的失败响应不得覆盖新一代的错误状态', async () => {
  const { boxes, captured, compFn } = await loadClient();
  boxes.length = 0; captured.length = 0;
  compFn({});
  const errBox = boxes[2];

  // 第 1 代：慢失败；第 2 代：快成功 —— 旧代失败到达时不再是当前代，不得设 error
  let releaseSlow;
  const slow = new Promise((_, rej) => { releaseSlow = rej; });
  let call = 0;
  globalThis.fetch = () => {
    call++;
    if (call === 1) return slow.catch(() => { throw new TypeError('old-gen fail'); });
    return Promise.resolve({ ok: true, json: async () => ({ sessions: [], pings: [] }) });
  };
  const p1 = captured[0]();
  const p2 = captured[0]();
  await p2;                       // 新代先完成
  releaseSlow(new TypeError('old-gen fail'));
  await p1;                       // 旧代失败后到达
  assert.equal(errBox.value, null, '旧代失败不得覆盖新一代的干净状态');
});
