# 接口契约细节

## Contract-A：亲和键（已实现，勿改）

```
若请求体已有 metadata.user_id → key = 该值（原样沿用）
否则 → key = "dshsc-" + sha256(systemText.slice(0, 8000)).hex.slice(0, 16)
  systemText = 请求体 system 字段：string 直接用；数组/对象则 JSON.stringify
```

语义：同一会话的 system 稳定 → key 稳定；system 变了则前缀本来就要重建，key 变更是正确行为。

## Contract-B：sidecar 控制 API（127.0.0.1:8791）

### B1 `GET /sessions`
```json
{ "sessions": [ { "key": "dshsc-ab12…", "lastSeenAt": "2026-10-15T08:00:00Z",
  "model": "k3", "lastStatus": 200, "lastInputTokens": 822,
  "lastCacheRead": 822 } ] }
```
来源：sidecar 请求日志（内存聚合 + usage.jsonl 重放均可，实现自定）。

### B2 `POST /control/on`
请求 `{ "key": "dshsc-…", "intervalMin": 50 }`；intervalMin 缺省 50，范围 1–720。
响应 200 `{ "ok": true, "immediatePing": true, "state": {…} }`——**开启即立即执行一次 ping**
（不等首个 interval；仍受 B5 的 <10s 真实请求顺延 30s 保护）。
若该 key 无已记录请求体 → 409 `{ "error": "no-request-recorded", "waiting": true }`，
同时 sidecar 记录保温意图（`waitingForRequest`），下一次真实请求到达即自动开始 ping 循环。

### B3 `POST /control/off`
请求 `{ "key": "dshsc-…" }`；对未知 key 也返回 200（幂等）。同时清理 pending retry 定时器。

### B4 `GET /control/state`
```json
{ "pings": [ { "key": "…", "on": true, "intervalMin": 50,
  "lastPingAt": "…", "pingCount": 3, "stale": false,
  "health": "hit", "waitingForRequest": false,
  "retryCount": 0, "lastError": null,
  "lastUsage": { "cache_read_input_tokens": 822, "cache_creation_input_tokens": 0 } } ] }
```
`health` 取值：`hit`（cache_read>0）/ `recreated`（read=0 但 cache_creation>0，已重建）/
`no-cache`（2xx 但读写皆 0）/ `retrying`（临时错误抢救中）/ `waiting`（等真实请求）/
`stale`（挂起）。

### B5 ping 引擎行为
- 每个 key 一个定时器；触发时取该 key **最后一次非 ping 请求体**：
  - `max_tokens` → **固定 16**（2026-10-15 实测：max_tokens=1 不参与 Kimi 前缀缓存，
    16 为已验证可命中的最低档；ping 输出整体丢弃）；其余字段一律不动
  - 追加标记：body 内 `metadata` 不改（前缀不变）；仅 sidecar 本地日志记 `[ping]`
- 响应：丢弃正文，解析 usage 追加进 usage.jsonl（`"kind":"ping"`，含
  `model/latency_ms/result/retry` 与完整 usage 四字段：input/cache_read/cache_creation/output）
- **结果三分类**（transport 错误与 cache miss 严格分开统计）：
  - 2xx + `cache_read_input_tokens>0` → `hit`，失败计数清零
  - 2xx + `cache_read=0` 且 `cache_creation_input_tokens>0` → `recreated`（旧 cache 失效但已重建，healthy），失败计数清零
  - 2xx 且读写皆 0 → `no-cache`，计入 cache 失败计数；连续 3 次 → 挂起置 `stale`
  - timeout/ECONNRESET/429/5xx → `retrying`，**不计入** cache 失败计数；
    快速 retry：+2min 第一次、+4min 第二次（独立 setTimeout，**主 interval 不漂移**）；
    成功即恢复 `hit/recreated`；retry 耗尽 → `stale`
- 该 key 下次真实请求到达时自动清 stale/waiting 并恢复循环
- 并发保护：该 key 的真实请求 lastSeen <10s 时本次重放顺延 30s（immediate ping 同样遵守）
- ping 请求自身不得更新「最后真实请求体」
- ping 上游超时默认 120s（env `PING_TIMEOUT_MS` 可配）

## Contract-C：dsh 插件清单

`plugin/dsh.plugin.json`（骨架已给）：`id`、`version`、`main`（server 入口）、`engines.dsh: ">=0.1.7-rc.1"`、`client.main`。
`package.json` 的 `dsh` 字段：`{ "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-layout"] }, "bundle": { "patch": "./cordis.patch.yml" } }`。

**参考实现**（agy-vm 已具备）：`~/DSH-better-sidebar`（源码克隆）、npm：`dsh-plugin-mobile-gateway`、本机 `~/.dsh/dsh-memory-evolve`。顶部栏 tab 注册方式以 memory-evolve（「Memory Evolve 设置」tab）为直接范例。

## Contract-D：会话生命周期

- 数据源：cordis 注入 `dsh-api-session-controller` 提供的会话服务（实现时以 dist 实际导出为准；备用方案：轮询 `~/.dsh/sessions/` 目录 + storages）
- reconciler 每 60s：会话不存在或状态 ∈ {deleted, archived} → 该 sessionId 置 OFF 并从 state.json 移除
- 挂载（存在且非 deleted/archived）期间：随时可 ON/OFF，不受其他状态影响
- sessionId ↔ key 映射：插件读取该会话当前 system（会话存储），按 Contract-A 计算 key；同时兼容 sidecar `GET /sessions` 反查

## Contract-E：Telegram duty 斜杠指令

| 指令 | 参数 | 行为 | 回执 |
|---|---|---|---|
| `/HTON` | 无 | 当前会话按现间隔（默认 50）开启 | `💓 心跳已开启（间隔 50min）` |
| `/HTOFF` | 无 | 关闭 | `💓 心跳已关闭` |
| `/HTO <min>` | 一个空格 + 整数 1–720 | 设间隔并开启 | `💓 心跳间隔已设为 Nmin 并开启`；N≥60 追加 `⚠️ 间隔≥60min：1h TTL 缓存会在 ping 间过期` |
| 错误 | 非整数/越界/缺参数 | 不变更状态 | `用法：/HTO <分钟>（1-720），如 /HTO 60` |

命令注册走 dsh 现有 duty 命令机制（实现时定位 storages/telegram-duty 对应的命令处理层；参照 dsh-commands / dsh-command-* 包模式）。

## Contract-F：状态持久化

`~/.dsh/storages/dsh-heartbeat/state.json`

```json
{ "version": 1,
  "sessions": {
    "<sessionId>": { "key": "dshsc-…", "on": true, "intervalMin": 50, "updatedAt": 1760000000000 }
  } }
```

原子写（tmp+rename）。启动时加载：`on:true` 的会话 → 重连 sidecar `/control/on`。sidecar 重启丢内存定时器 → 插件启动/reconciler 时对 on 状态做一次 `/control/on` 补挂（幂等）。
