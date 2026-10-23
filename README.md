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
- [已知问题](docs/KNOWN-ISSUES.md) —— session identity 碰撞等已确认缺陷与修复建议
- [AGY_TASK.md](AGY_TASK.md) —— agy-vm 开发任务书

## 快速摘要

> 数字口径以 [docs/CONFIG-CANON.md](docs/CONFIG-CANON.md) 为唯一权威。

- Web：顶部栏 HEARTBEAT tab，会话级点选 ON/OFF，间隔手动输入（分钟）；
  每会话显示 canonical 会话名（DSH Rename 同步）、Last HB、Cache read/creation tokens
  与健康状态（HIT / RECREATED / RETRYING / STALE / WAITING FOR REAL REQUEST）
- Telegram duty：`/HTON` 开、`/HTOFF` 关、`/HTO 60` 设间隔并开（空格分隔，单位分钟，1–720）
- 会话删除/归档 → 自动 OFF；重新挂载可随时切换
- ping = sidecar 重放该会话最后一次真实请求（字节级前缀一致，max_tokens 固定 16——
  2026-10-15 实测 max_tokens=1 不参与 Kimi 前缀缓存；响应丢弃只取 usage）
- 开启心跳（/HTON 或 UI ON）立即执行首次保温，不等首个 interval；
  临时错误（429/5xx/超时）+2min/+4min 快速重试；默认间隔 30min
  （实测缓存存活 28–45min，≥40min 界面/回执告警）
- sidecar 重启后无请求记录的会话显示 WAITING FOR REAL REQUEST，
  下一次真实请求到达自动恢复保温；保温中的请求体与开关状态均持久化
- 依赖链：Kimi Coding Plan 端点 + `prompt_cache_options{ttl:'1h'}`（按协议分派注入；
  官方 1h，实测存活 28–45min，间隔按 30min 配置）
