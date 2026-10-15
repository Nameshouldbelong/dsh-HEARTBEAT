# dsh-HEARTBEAT

为 dsh 0.1.7-rc.2 提供会话级 LLM 前缀缓存保温（heartbeat / ping）。

## 组件

```
plugin/    dsh 插件：顶部栏 HEARTBEAT tab（ON/OFF 点选 + 间隔输入）+ 会话生命周期对账 + TG duty 斜杠指令
sidecar/   kimi-cache-sidecar 扩展：/control API + 按会话重放 ping 引擎（WSL 生产已在跑的底座）
```

## 文档

- [执行计划表](docs/PLAN.md) —— 里程碑 / 接口契约清单 / 验收门槛
- [接口契约](docs/INTERFACES.md) —— 各接口的 schema 与行为细节
- [AGY_TASK.md](AGY_TASK.md) —— agy-vm 开发任务书

## 快速摘要

- Web：顶部栏 HEARTBEAT tab，会话级点选 ON/OFF，间隔手动输入（分钟）
- Telegram duty：`/HTON` 开、`/HTOFF` 关、`/HTO 60` 设间隔并开（空格分隔，单位分钟，1–720）
- 会话删除/归档 → 自动 OFF；重新挂载可随时切换
- ping = sidecar 重放该会话最后一次真实请求（字节级前缀一致，max_tokens 压到 1，响应丢弃只取 usage）
- 依赖链：Kimi Coding Plan 端点 + `cache_control {ttl:1h}`（2026-10-15 已实测生效）
