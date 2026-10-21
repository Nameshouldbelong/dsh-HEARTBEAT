# 配置口径统一表（2026-10-22）

> 审计 §6-d 指出 README / INTERFACES / KNOWN-ISSUES 里同时存在 50/45/30 分钟与
> "1h TTL 已确认/未确认"等矛盾表述，部署时无法判断线上跑的是哪个修复。
> 本表是**唯一权威口径**，与代码常量一一对应；其它文档若与之冲突以本表为准。

## 间隔（interval）

| 项 | 值 | 代码位置 |
|---|---|---|
| 默认间隔 | **30 分钟** | `plugin/lib/commands.mjs` 默认参数、`sidecar` 恢复兜底 |
| 允许范围 | 1–720 整数分钟 | `/control/on` 校验、`/HTO` 参数解析 |
| 界面告警阈值 | **≥40 分钟** | `plugin/lib/client.mjs`、`/HTO` 回执 |
| 告警理由 | 实测缓存存活 **28–45 分钟**（非官方 1h） | `docs/TTL-FINDINGS.md` 三组实测 |

历史文档出现的 50 / 60 / 90 分钟均为**已废弃**的旧值（分别来自早期默认值、
`maxIdleMin` 空闲截断、TTL 误判期），不要再引用。

## 关闭判据（哪时自动 off）

| 判据 | 参数 | 行为 |
|---|---|---|
| 单次命中率不足 | `HIT_RATIO_MIN` 默认 **5%** | 该次 ping 判失败，达 `failThreshold`（默认 1）立即 off |
| 凭据/配额硬错误 | — | 401/403 立即 off |
| 总额花费上限 | **已移除**（2026-10-21 用户裁定 #1） | 不再关停；`spentUsd` 仅展示 |
| transport 失败 | — | 只 retry（+2min/+4min）或置 stale，**不 off** |
| 空闲时长 | **已移除** | 不因长时间不活跃自动关闭 |

## 命中率口径（分母）

| 协议 | 总输入 totalInput | 说明 |
|---|---|---|
| Anthropic Messages | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | `input_tokens` **只含未命中部分** |
| OpenAI / Chat Completions | `prompt_tokens` | 已含命中部分（`cached_tokens` 是子集），不能重复相加 |

用错语义会把真实命中率 0.1% 算成 99% 并判 `hit`（审计已复现，2026-10-22 修复）。

## 缓存写入字段归一化

| 来源字段 | 归一化为 |
|---|---|
| `prompt_tokens_details.cache_write_tokens` | `cache_creation_input_tokens` |
| `prompt_tokens_details.cache_creation_tokens` | `cache_creation_input_tokens` |
| `prompt_tokens_details.cached_tokens` / `cached_tokens` | `cache_read_input_tokens` |

## 版本自证

`GET /healthz` 现在返回：

```json
{
  "protocolVersion": "hb2",
  "buildSha": "<sidecar.js 内容 sha256 前 12 位>",
  "pid": 12345,
  "startedAt": "2026-10-22T...",
  "capabilities": ["session-scoped-key","control-verify","selfcheck",
                   "persist-bodies","persist-pings","single-inflight","usage-normalized"]
}
```

核对方法：

```bash
# 线上跑的
curl -s http://127.0.0.1:8791/healthz | jq -r .buildSha
# 仓库这份的
sha256sum ~/DSH/插件制作/dsh-HEARTBEAT/sidecar/sidecar.js | cut -c1-12
```

两者一致 = 线上就是刚推的那份代码。插件版本见 `plugin/package.json`（0.2.0）。

## 缓存 TTL 的准确表述

- 官方声明 1h，**实测存活 28–45 分钟**（2026-10-20 三组独立实测）。
- 因此间隔 30 分钟是安全上限，40 分钟起告警，**不能按 1h 配置**。
- 缓存过期后第一次请求必然全价冷读，这是物理限制，任何保温策略都无法消除。
