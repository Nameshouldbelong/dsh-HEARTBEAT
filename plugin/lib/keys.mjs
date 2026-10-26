import crypto from 'node:crypto';

// 会话级唯一亲和键（2026-10-21 v2，与 sidecar 的 makeSessionKey 必须逐字一致）。
//
// 为什么改：旧键 = sha256(system[:8000])，带来两个致命缺陷——
//   KI-1 多会话同 system prompt → 同一 key，recordedRequests 互相覆盖；
//   KI-3 会话 system 一次更新 → key 漂移，插件存旧 key 再也等不到流量。
// 2026-10-21 事故就是这两条叠加：LSD1 会话的 state 里存的是 E2E 测试 key
// （90 token 假前缀），34 次 ping 全部打在错对象上，看起来 health=hit 实际零保温。
//
// 新键 = sha256("session:" + sessionId)[:16]，只由会话 id 决定：
//   · 同一会话恒定（system 怎么变都不影响）→ 根治 KI-3；
//   · 不同会话必然不同 → 根治 KI-1。
export function sessionKeyFor(sessionId) {
  const s = String(sessionId || '').trim();
  if (!s) throw new Error('sessionKeyFor: empty sessionId');
  return 'dshsc-' + crypto.createHash('sha256').update('session:' + s).digest('hex').slice(0, 16);
}

// 该 key 是否由会话 id 确定性派生（而非旧版 system 哈希）。
// 用于识别 state.json 里的历史脏数据：无法反推 sessionId，只能标记为 legacy 并重算。
export function isSessionScopedKey(key) {
  return typeof key === 'string' && /^dshsc-[0-9a-f]{16}$/.test(key);
}
