# HB 保温真实 K3 端点 E2E 验证（2026-10-20）

## 测试设计

- **测试 key**：`dshsc-ea64f39ed24bda17`（真实 K3 流量建立的前缀，91 token 极小量）
- **间隔**：30min（默认值）
- **会话**：`session-cbce3a78`（dsh-test-instance 工作区 `/tmp/dsh-test-instance/hb-e2e`）
- **监控**：`scripts/hb-monitor.mjs`，30s 采样，目标 5 次 ping

## 结果：3 次保温全部命中

| # | 时间 (UTC) | 类型 | result | cached/prompt | 单次成本 |
|---|---|---|---|---|---|
| 1 | 15:48:24 | immediate（真实请求唤醒） | **hit** | 89/89 (100%) | ~$0.00003 |
| 2 | 16:17:55 | 周期 30min | **hit** | 89/89 (100%) | ~$0.00003 |
| 3 | 16:47:54 | 周期 60min | **hit** | 89/89 (100%) | ~$0.00003 |
| — | 17:17:54 | （未触发） | — | — | 已 off |

**累计 3 次 ping 总成本 ≈ $0.0001**（监控实测 spentUsd=0.0001）。

## 顺带验证的三个机制

1. **幂等短路（KI-5）**：开启后 9 分钟内 reconciler 补挂 9 次，ping 仍只 1 次——
   不再有每分钟白 ping。
2. **sidecar 重启自愈**：15:46 重启后内存 recordedRequests 丢失 → key 进入
   `waiting` → 真实请求到达（15:47）→ 自动退 waiting + 立即 ping 命中。
3. **空闲截断护栏（KI-9）**：17:17 距最后真实请求恰好 90min → 正确 AUTO-OFF。
   证明护栏生效（原 30min 值与间隔相等会杀死保温，已修为 90min）。

## 结论

30min 间隔下保温功能**端到端可用**：periodic ping 100% 命中、成本可忽略
（3 次共 $0.0001）、护栏与自愈机制均按设计工作。

## 复现

```bash
# 1. 建立 key（真实请求）
curl -X POST http://127.0.0.1:8791/v1/chat/completions \
  -H "content-type: application/json" -H "Authorization: Bearer $KIMI_KEY" \
  -d '{"model":"k3-256k","max_tokens":16,"system":"<稳定前缀>","messages":[{"role":"user","content":"x"}]}'

# 2. 开保温
curl -X POST http://127.0.0.1:8791/control/on -H 'content-type: application/json' \
  -d '{"key":"<key>","intervalMin":30}'

# 3. 监控
node scripts/hb-monitor.mjs --key <key> --target 4 --tail-min 8
```
