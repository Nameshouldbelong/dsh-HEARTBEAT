# 事故记录：kimi-coding 协议切换导致 sidecar 双缺陷（2026-10-20 发现并修复）

## 触发事件（与本仓库无关的上游变更）

2026-10-19，pi-ai 上游将 kimi-coding provider 从 anthropic-messages 协议切换为
openai-completions（baseUrl `https://api.kimi.com/coding` → `/coding/v1`，
usage 响应结构随之改变）。sidecar 按「供应商 = 端点协议」假设编写，未感知
协议切换，产生两个缺陷，2026-10-20 经用户要求 ping 指定会话时实测暴露。

## 缺陷 1：usage 形态未归一 → 缓存命中误判 no-cache

**根因**：anthropic 形态缓存读取字段是 `usage.cache_read_input_tokens`；
openai 形态是 `usage.prompt_tokens_details.cached_tokens`（另有顶层
`cached_tokens`）。`classifyPingResult` 只认旧字段，两个计数皆读 0。

**影响**：全量命中（实测 174,630/174,630 cached）被判 `no-cache`，
`consecutiveZeroCacheRead` 误增，连续 3 次将误挂 `stale` 停止保温；
UI 缓存读数恒为 0。

**修复**：`extractUsage` 返回前归一化 `cached_tokens → cache_read_input_tokens`
（anthropic 形态无此字段不受影响）。

## 缺陷 2：affinityKey 只认顶层 system → 全 k3 流量单 key 碰撞（KI-1 成真）

**根因**：`affinityKey` 取 `j.system`（anthropic 顶层字段）。openai 格式
system 在 `messages` 内（`role==='system'` 项），`j.system` 恒 undefined →
所有请求 hash 输入同为字符串 `""` → **全部 k3 会话共享单一 key
`dshsc-12ae32cb1ec02d01`**。

**影响**：`recordedRequests` 互相覆盖（后说话会话顶掉先前的）；心跳可能为
会话 A 重放会话 B 的请求体（前缀相同则缓存仍命中，但控制面/遥测语义失真）；
KI-1 担心的碰撞从理论风险变成生产现实。实测：109 token 探针请求立即覆盖了
Plabable 会话 174k 请求记录。

**修复**：无顶层 system 时从 `messages` 的 `role==='system'` 项提取拼接。
验证：两个不同 system 的请求 → 两个不同 key，各自 ping 独立 `hit`。

## 附带影响与迁移

- key 体系修复后全部旧 `dshsc-` key 失效：插件 state 旧 key 走 KI-3
  `rotateStaleKey` 自动迁移（409 → 按新鲜流量重解析）；sidecar 内存
  recordedRequests 清空后由各会话下次真实流量重建。
- 已知残留：KI-3 的 recency 反查在多个新鲜 key 并存时可能错认属主
  （探针污染场景实测），根治依赖 KI-1（DSH core 注入 session 级
  `metadata.user_id`）。

## 验证

- 单测 24/24（sidecar 10 + plugin 14），新增 2 项回归锚
  （openai usage 归一化 / openai system 提取与 key 分离）。
- 生产（WSL 127.0.0.1:8791）重启后：分离 key 各自 ping `health=hit`；
  Plabable 会话保温等其下次活跃流量自动恢复。

## 教训

sidecar 适配的是「端点协议」而非「供应商」，供应商可在任意时刻切换协议且
无告警。后续加固建议（未做）：对 usage 字段形态做未知形态告警日志；ping
结果里缓存读为 0 但 prompt 巨大时输出显式提示，避免静默误分类。
