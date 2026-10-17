# 已知问题（KNOWN ISSUES）

## KI-1：session identity 碰撞（P1，待 DSH core 修复）

**现象**：sidecar 亲和键 Contract-A 的 fallback 是 `sha256(system[:8000])`。
DSH 当前（0.1.7-rc.2）发往 Kimi coding 端点的请求**不携带 `metadata.user_id`**
（2026-10-17 生产实证：`/control/state` 中所有 key 均为 `dshsc-` 合成键；
会话日志 `request/header` 事件无 `metadata` 字段）。

**后果**：两个 system prompt 相同的会话（如两个同 preset 的会话）得到相同
`dshsc-` key，`recordedRequests` 相互覆盖——后说话的会话覆盖先前会话的
「最后真实请求体」，heartbeat 可能为会话 A replay 会话 B 的请求体。
功能上 cache 仍然被保温（前缀相同），但按会话的遥测与控制面语义失真。
`resolveSessionKey` 的 recency 反查策略在同 key 多会话下也无法区分归属。

**测试**：`sidecar/test/sidecar.test.mjs` 的
`T9 [KNOWN-ISSUE]` 显式断言当前碰撞行为（不隐藏）；DSH core 修复后该测试应反转。

**修复建议（下一轮，需改 DSH core，本轮不做）**：
DSH kimi-coding provider 构造请求时注入
`metadata.user_id = "dsh:<session-id>"`（稳定、session 级唯一）。
sidecar Contract-A 已原样沿用客户端提供的 `metadata.user_id`，无需改动。

## KI-2：sidecar 重启丢失已记录请求体（本轮已缓解）

`recordedRequests` 为内存态，sidecar 重启后丢失。
本轮（2026-10-17）已实现缓解：`/control/on` 409 时记录保温意图
（`waitingForRequest`），UI 显示 `WAITING FOR REAL REQUEST`，
下一次真实请求到达自动恢复 ping 循环。

**未做（有意）**：请求体持久化。其包含完整 LLM prompt，若实现必须
0600 权限、session 删除时清除、明确 retention、禁入普通 debug log。
如确需要求，另开任务评估。
