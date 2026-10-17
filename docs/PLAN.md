# dsh-HEARTBEAT 执行计划表

状态：☐ 未开始 / ◐ 进行中 / ☑ 完成。负责人：**AGY**=agy-vm 编写，**ACC**=本机（WSL）验收，**USR**=用户。

## 0. 目标与范围

为 dsh 0.1.7-rc.2 提供会话级 LLM 前缀缓存保温：

1. Web 顶部栏新增 HEARTBEAT tab：会话级 ON/OFF 点选 + 心跳间隔手动输入（分钟）
2. Telegram duty 斜杠指令：`/HTON`（开）、`/HTOFF`（关）、`/HTO <分钟>`（设间隔并开）
3. 会话删除/归档 → 自动 OFF；会话挂载期间随时可切换 ON/OFF
4. ping = 重放该会话最后一次真实请求（前缀字节级一致；`max_tokens`→1；响应丢弃只取 usage）

非目标：不做多供应商适配（仅 Kimi coding 端点）；不改 dsh 核心；不做自动批量开启。

## 1. 总体架构

```
[控制面] dsh 插件 dsh-heartbeat（本仓库 plugin/）
   ├─ HEARTBEAT tab（client 注入，参照 dsh-memory-evolve 的注册方式）
   ├─ 状态机 + 生命周期 reconciler（60s 对账 deleted/archived → OFF）
   └─ Telegram duty 斜杠指令 /HTON /HTOFF /HTO
        │ HTTP 127.0.0.1:8791（Contract-B）
        ▼
[ping 引擎] kimi-cache-sidecar 扩展（本仓库 sidecar/，WSL 生产底座已在跑）
   ├─ 按亲和键记录每会话最后一次真实请求体
   └─ 定时重放（不进会话历史；响应丢弃只取 usage 记遥测）
        │ HTTPS
        ▼
api.kimi.com/coding（Kimi Coding Plan；sidecar 已注入 cache_control{ttl:1h}，2026-10-15 实测生效）
```

**为什么 ping 放 sidecar**：缓存键 = 请求前缀字节序列。sidecar 持有原始请求体，重放保证前缀一致；任何组件自建请求都有序列化漂移导致缓存不命中的风险。插件只做控制面（状态 + 指令 + UI）。

## 2. 接口契约清单

| 编号 | 接口 | 说明 | 负责人 | 状态 |
|---|---|---|---|---|
| A | 亲和键推导 | `key = "dshsc-" + sha256(system前8000字符).hex[0:16]`；客户端自带 `metadata.user_id` 时原样沿用 | ACC（已实现） | ☑ |
| B | sidecar `GET /healthz` | 存活 + 注入开关状态 | ACC（已实现） | ☑ |
| B1 | sidecar `GET /sessions` | 活跃会话键列表 `{key, lastSeenAt, model, lastStatus}`（由请求日志聚合） | AGY | ☑ |
| B2 | sidecar `POST /control/on` | body `{key, intervalMin}`，开启该键的 ping 循环 | AGY | ☑ |
| B3 | sidecar `POST /control/off` | body `{key}`，停止 ping | AGY | ☑ |
| B4 | sidecar `GET /control/state` | 所有 ping 状态 `{key, on, intervalMin, lastPingAt, pingCount, stale, lastUsage}`（tab 展示用） | AGY | ☑ |
| B5 | ping 引擎行为 | 重放最后**真实**请求：`max_tokens→1`、`stream→false`，其余字段字节不动；连续 3 次 `usage.cache_read_input_tokens=0` → 自动挂起置 `stale`（等真实流量重建前缀）；距该键上次真实请求 <10s 时延后重放（避并发） | AGY | ☑ |
| C | 插件清单 | `dsh.plugin.json` + `package.json` 的 `dsh.client.inject` + `cordis.patch.yml`（参照 dsh-memory-evolve / dsh-plugin-mobile-gateway） | AGY | ☑ |
| D | 会话生命周期 | 经 `dsh-api-session-controller` 取会话列表/状态；deleted/archived → 状态置 OFF 并清理；reconciler 60s 对账 | AGY | ☑ |
| E1 | `/HTON` | 当前 duty 会话心跳开启（沿用现间隔，默认 50min），回执确认 | AGY | ☑ |
| E2 | `/HTOFF` | 当前 duty 会话心跳关闭，回执确认 | AGY | ☑ |
| E3 | `/HTO <min>` | 指令与数字**一个空格**，单位分钟，合法 1–720；设间隔并开启；≥60 回执警告「间隔≥60min，1h TTL 缓存会在 ping 间过期」 | AGY | ☑ |
| F | 状态持久化 | `~/.dsh/storages/dsh-heartbeat/state.json`：`{sessionId: {key, on, intervalMin, updatedAt}}`；dsh 重启后恢复 | AGY | ☑ |
| G | tab UI | HEARTBEAT tab：会话列表 + ON/OFF 点选 + 间隔输入框（分钟，失焦/回车提交）+ ping 状态徽标（on/off/stale） | AGY | ☑ |

## 3. 里程碑执行计划表

| 里程碑 | 内容 | 负责人 | 验收标准 | 状态 |
|---|---|---|---|---|
| M0 | 契约冻结 + 仓库底座（本文档、sidecar 现网底座、脚手架） | ACC | 推送 GitHub | ☑ |
| M1 | sidecar 扩展（B1–B5，基于 `sidecar/sidecar.js`） | AGY | `node --test` 通过 + 本地 curl 冒烟（healthz/sessions/control） | ☑ |
| M2 | 插件 server（C/D/F + 状态机 + sidecar 控制调用） | AGY | `node --test` 通过 | ☑ |
| M3 | 插件 client tab（G） | AGY | agy-vm 拉起 dsh 0.1.7-rc.2 可见 tab | ☑ |
| M4 | TG duty 斜杠指令（E1–E3） | AGY | duty 会话三指令回执正确 | ☑ |
| M5 | E2E 验收（agy-vm 拉起同版本 dsh 点对点实测） | ACC | 第 4 节清单 8 项全过 | ☐ |
| M6 | PR 合并 → WSL 拉取部署生产 | ACC | 生产 usage.jsonl 出现 ping 记录且真实会话命中 | ☐ |
| M7 | 增量修复（2026-10-17）：开启即 ping / 失败快速 retry(+2/+4min) / ping max_tokens 固定 16 / cache 三分类 health（hit/recreated/no-cache，transport 错误分离统计）/ canonical session title（sessionQuery.readTitleSnapshots，弃用首条 prompt 取名）/ UI 遥测列 / sidecar 重启 waiting 自动恢复 / telemetry 增强（latency_ms、result、四 usage 字段） | ACC | `node --test` 全绿 + agy-vm 预发实测 + 生产 HTON 立即 ping 且 cache_read>0 | ◐ |

## 4. E2E 验收清单（合并门槛，agy-vm 实测）

1. dsh web 顶部栏出现 HEARTBEAT tab（与「Memory Evolve 设置」同级）
2. tab 内会话列表可见；点选 ON 后 sidecar 日志按间隔出现 ping，`usage.jsonl` 中 ping 记录 `cache_read_input_tokens>0`
3. 间隔输入 60 → 警告提示；输入 30 → ping 间隔变为 30min
4. 点选 OFF → ping 停止
5. TG duty：`/HTON` 开、`/HTOFF` 关、`/HTO 60` 设间隔并开，三者回执正确
6. 删除/归档会话 → state 自动清 OFF；重新挂载可再开
7. dsh 重启 → ON 状态恢复、ping 继续
8. OFF 会话零 ping（副作用检查）

## 5. 部署与回滚（WSL 生产）

- 部署：`git pull` → 覆盖 `~/.dsh/kimi-cache-sidecar/sidecar.js` → `systemctl --user restart kimi-cache-sidecar` → 插件装入 `~/.dsh/dsh-heartbeat/` → `systemctl --user restart dsh-web`
- 回滚：还原 sidecar.js（有 `.bak-*`）+ 移除插件目录 + 重启两者

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| dsh 插件 API 未公开文档化 | 以 0.1.7-rc.2 实测为准；`engines.dsh` 锁版本；参照 memory-evolve / mobile-gateway / better-sidebar 三个真实插件 |
| ping 与真实请求并发互扰 | sidecar 串行队列；真实请求 10s 窗口内延后重放（B5） |
| agy-vm 仅 964MB 内存 | 验收时只拉 dsh web 单实例，不开并发会话 |
| ping 对 5h 窗口的实际折扣未知 | usage.jsonl 持续记录 cache_read，M6 后一周复盘 | 
