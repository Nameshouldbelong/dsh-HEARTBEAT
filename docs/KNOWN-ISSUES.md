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

## KI-3：插件存储的 key 随 system prompt 漂移而卡死（✅ 已修复，2026-10-17）

`dshsc-` key = sha256(system[:8000])。会话的 system prompt 内容变化
（如注入的记忆/上下文更新）后，同一 DSH 会话的 key 改变，而插件 state 里
存的是旧 key：`/control/on` 409 → `waitingForRequest`，但旧 key 的请求
永远不会再来 → waiting 卡死。

**修复（本轮已实现）**：`/control/on` 对存储 key 返回 409 时，自动按
sidecar 新鲜流量（<10min recency）重解析 key 并重试一次（`rotateStaleKey`，
命令路径与 reconciler 每分钟对账均生效）；轮换成功即解除 waiting 并更新
存储 key。**防抢守卫**：新 key 若已被其他开启中的会话认领，不抢占、保持
waiting（避免给错误会话保温）。首次解析出的 key 409（真无流量）仍走
waiting 语义不变。根治 key 漂移本身仍依赖 KI-1（DSH core 注入稳定
session 级 metadata.user_id）。

## KI-4：/heartbeat/api/state 每次请求 8-9s（大日志会话 title 读取慢）

`readSessionTitles` 每次都调 `readTitleSnapshots`（无缓存，保证 Rename
即时同步），对超大 会话 日志（100k+ token 会话，几十 MB zstd）单次
折叠读取需 8-9s。会话越多 UI 轮询越慢。

**候选优化（未做）**：30s 微缓存（rename 同步延迟容忍 30s）或仅对
heartbeat 开启中的会话读标题。因与「不缓存、rename 即时同步」的
设计约定冲突，留待用户裁定。

## KI-5：reconciler 每分钟补挂与 immediate-ping 叠加 → 白 ping + retry 失效（✅ 已修复，2026-10-20）

**根因**：`/control/on` 非幂等——每次调用都 clearInterval 重装定时器、
清空 retryTimer/retryCount、并 `setImmediate(runPing)`。插件 reconciler
每分钟对所有 on 会话补挂一次 → 每个 on 的 key **每分钟白 ping 一次**
（实测 45min pingCount=48，按会话前缀规模烧 cache-read quota），且
P0-2 的 +2/+4min 快速 retry 定时器每分钟被清空，retry 机制生产失效
（UI 呈现 health=retrying 但 retryCount=0 的矛盾态）。

**修复**：`/control/on` 幂等短路——已 on + 同间隔 + 定时器存活 + 非
stale/waiting → 返回 `alreadyOn:true, immediatePing:false`，不动任何
状态。间隔变更/显式重开/stale/waiting 仍走完整重置路径。
回归测试：`P0 回归: /control/on 幂等`（sidecar 11/11）。

**生产验证**：修复部署后本会话 key 经 KI-3 轮换自愈（e638b59e，
cache_read=270k，hit），无每分钟白 ping。

## KI-6：TTL 注入协议错配导致心跳烧光 5h 配额（✅ 已修复，2026-10-20）

**症状**：用户未使用期间 Kimi 5h 配额被打满；HB tab 显示 `ON · NO-CACHE`。

**实测损失**：137 次 ping 中 12 次 no-cache（264 万 token 全价）+ 52 次"伪 hit"
（cached 仅 4.4%，约 1445 万 token 全价）≈ **1700 万 token 白烧**。

**根因（三处叠加）**：
1. **TTL 注入协议错配（主因）**：sidecar 注入顶层 `cache_control`（Anthropic
   Messages 写法）。10-19 pi-ai 将 kimi-coding 切到 openai-completions 后该字段被
   端点忽略 → 实际按默认 5m TTL。证据：同前缀真实对话命中 99.2%，32-50 分钟后
   的 ping 全部 0%。官方文档：Chat Completions 用
   `prompt_cache_options:{mode:'implicit',ttl:'1h'}`。
2. **hit 判据过松**：只判 `cache_read>0`，4.4% 命中率也报 hit，UI 显示健康而实际
   94.6% 全价重算。
3. **失败保护失效**：`/control/on` 每次归零失败计数（reconciler 每分钟补挂），且
   50min 周期需 150 分钟才凑够 3 次。

**修复**：① `injectCacheTtl()` 按协议分派（真实请求与 ping 共用）；② 命中率门槛
`hitRatioMin`（默认 5%，`HIT_RATIO_MIN` 可调）；③ `failThreshold` 默认 1——单次
低命中即置 stale 并**自动 off**（停 timer/retry）；④ 补挂继承失败计数。

**验证**：单测 28/28；生产注入字段实测为 `prompt_cache_options=1h`。
**待验证**：TTL 1h 实际生效性需配额恢复后用真实 ping 确认（当前配额已耗尽）。
