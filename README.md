# dsh-HEARTBEAT

**Kimi Coding Plan 会话级前缀缓存保温系统**——由 [dsh](https://github.com/deepseek-ai)（DeepSeek Harness）插件 + 本地反向代理（sidecar）组成，让 dsh 的 Kimi 会话在空闲期间保持 prompt cache 活跃，避免缓存过期后的全价冷读。

> 数字口径以 [docs/CONFIG-CANON.md](docs/CONFIG-CANON.md) 为唯一权威。

---

## 项目目的

Kimi Coding Plan 的计费与缓存行为有两个痛点：

1. **前缀缓存会过期**。官方 TTL 标称 1h，实测存活 28–45min。会话空闲超过这个窗口后，下一条消息的全部上下文（动辄数十万 token）按未命中价重算——这是大上下文编码会话最大的隐性开销。
2. **缓存命中几乎不占订阅额度**。Coding Plan 订阅制下 cache-read 的额度消耗远低于未命中输入（API 口径约为 1/10）。保住缓存 = 保住额度。

本项目的方案：**由一个本地 sidecar 录制每个会话的最后一次真实请求，在缓存即将过期时按 5s 突发节奏重放它**（输出丢弃、只取 usage 遥测），以极小的代价（每次 ping 约 1 万 token，且几乎全为 cache-read）对冲数十万 token 的冷读。

## 额度消耗参考（实测口径：Kimi ¥199 老套餐）

> 以下为维护者在 Kimi ¥199 档**老套餐**（7 天刷新 + 每 5 小时滚动窗口）上的经验观测，用于给出数量级；新套餐与其他档位的比例不同，请以自己面板的实际扣减为准。

| 场景 | 5h 窗口额度消耗 |
|---|---|
| k3 high effort 约 **0.6M token** 前缀**冷读**（缓存过期后的第一条消息） | **约 15%–20%** |
| **单次保温 ping 成功**（约 0.6M 前缀全量 cache-read） | **约 0.1%** |

即：**一次冷读 ≈ 150–200 次保温 ping**。哪怕保温偶尔"白打"，相对冷读依然是数量级级别的节省——这就是本插件默认 20–30min 保温窗口的经济学依据（窗口右端 30min 贴着实测缓存寿命 28–45min 的下沿，冷读被压到最少）。

## 原理

### 1. 会话级亲和键（session-scoped affinity key）

上游缓存按前缀字节一致性 + 路由亲和命中。sidecar 从每个请求中推导会话身份，并写回请求体使缓存按会话稳定分桶：

```
key = "dshsc-" + sha256("session:" + sessionId).slice(0, 16)
```

身份解析优先级：`prompt_cache_key` > `metadata.user_id`（dsh 注入形态）> messages 文本扫描（`「会话 ID：」`标记）> system 哈希兜底。同一会话恒定、不同会话绝不碰撞；插件端（`plugin/lib/keys.mjs`）与 sidecar 端（`makeSessionKey`）两端算法逐字节一致，无法漂移。

### 2. TTL 1h 注入（按协议分派）

| 协议 | 注入方式 |
|---|---|
| Chat Completions（kimi-coding 实际协议） | `prompt_cache_options: {mode:'implicit', ttl:'1h'}` |
| Anthropic Messages | 顶层 `cache_control: {type:'ephemeral', ttl:'1h'}` |

注入在转发前完成，对客户端（dsh）完全透明。

### 3. Ping = 逐字节重放最后一次真实请求

- 重放体与真实请求**字节级一致**（含 tools 全文），仅改写 `max_tokens=16`（实测 `max_tokens=1` 不参与 Kimi 前缀缓存，16 为已验证最低档），输出丢弃只取 usage；
- 附带与真实请求相同的 TTL 注入与亲和键——否则只会读 5min 默认池，间隔 >5min 必 miss；
- 剥除工具门控（见 §5）发生在录制与转发之前，因此**录制体 == 出站体**，ping 重放语义天然成立。

### 4. 区间突发保温引擎（2026-10-25 起，替代"单时点 + 3 次重试"）

```
锚点 anchor = 最近一次缓存确认触碰（真实请求或命中 ping）
    │
    ├── anchor + windowStartMin（默认 20min）→ 突发窗口开启
    │       每 5s 发一次 HB（BURST_INTERVAL_MS，可调）
    │       · hit        → 收工，anchor=now，预约下一窗口
    │       · 429/5xx/网络/超时 → 窗口内自动重试（Kimi engine 超负荷是暂态）
    │       · 400        → 本周期停止（请求体级问题，重锤无意义）
    │       · no-cache/recreated → 单次命中墙熔断（唯一自动关闭判据）
    │       · 401/403    → 立即关闭（凭据级硬错误）
    │
    └── anchor + windowEndMin（默认 30min）→ 窗口右端，本周期不再尝试
            health = window-expired，anchor 重置，等下一窗口
```

设计动机：单时点 ping 一旦撞上 Kimi 429（engine 超负荷），3 次重试耗尽时缓存早已过期。窗口内 5s 突发把"engine 恢复"与"缓存仍活着"两个窗口重叠起来。真实流量随时到达即重锚（正在聊天绝不打扰）。

### 5. 工具门控（kimi 出站按前缀剥除工具）

事故背景：全局挂载的 MCP 服务器（如 rea）给每个请求附带数百个工具、652KB 的 JSON schema，Kimi /coding 按单工具 schema 体积上限直接 400。而 dsh 的 MCP 注册无热切换（改配置须重启 Host）。

解法：sidecar 在 **kimi 出站路径**按前缀剥除工具（默认 `mcp__rea__`），其他 provider 直连不受影响——MCP 保持全局挂载，kimi 会话按开关瘦身，即点即生效、零重启。Web 端 **TOOL GATE** tab 一键开关并展示累计统计。

### 6. 身份自证与反"假健康"

- sidecar `healthz` 返回 `buildSha = sha256(sidecar.js)[:12]`，部署后可与仓库 HEAD 比对，确认"源码—磁盘—运行进程"三位一体；
- 面板徽标只有确认 `hit` 才给绿色；`recreated`/`unknown`/`window-expired` 等一律如实显示；
- 启动自检（selfcheck）把"声称开着但无法工作"的组合显式成 alarms（缺请求体/定时器丢失/前缀过小等）。

## 实现

```
┌────────────────────────────────────────────────────────┐
│ dsh (DeepSeek Harness)                                 │
│  └─ plugin/（控制面）                                   │
│      HEARTBEAT tab   保温窗口输入 · ON/OFF · 健康徽标    │
│      TOOL GATE tab   工具门控开关 · 累计统计             │
│      reconciler      周期对账（ensure 补挂/归档停保温）   │
│      /HTON /HTOFF /HTO /TGON /TGOFF /TG（web + TG duty）│
└──────────────┬─────────────────────────────────────────┘
               │ /heartbeat/api/*（插件 HTTP 代理）
               │ /control/*（直连亦可）
┌──────────────▼─────────────────────────────────────────┐
│ sidecar/（数据面，127.0.0.1:8791）                       │
│  反代 → https://api.kimi.com/coding                     │
│  · TTL 1h 注入 + 亲和键写回                              │
│  · 每会话最后真实请求体录制（持久化 0600）                 │
│  · 区间突发 ping 引擎（窗口/5s 突发/命中墙熔断）           │
│  · 工具门控（按前缀剥除，录制前生效）                      │
│  · usage.jsonl 全量遥测 · selfcheck · buildSha 自证      │
└────────────────────────────────────────────────────────┘
```

**控制端点**（sidecar）：`GET /healthz` · `GET /sessions` · `GET /control/state` · `POST /control/on`（`windowStartMin/windowEndMin`，`action: ensure|resume`）· `POST /control/off` · `POST /control/verify`（开启前交叉校验：请求记录/会话一致/前缀规模三判据，绝不"假装 ACTIVE"）· `GET/POST /control/toolgate` · `GET /selfcheck`。Schema 细节见 [docs/INTERFACES.md](docs/INTERFACES.md)。

**持久化与安全**：

- `persist/request-bodies.json`、`persist/pings.json`、`persist/toolgate.json` 全部 **0600 + 原子写**（tmp+rename）；
- **凭据绝不落盘**：录制体只存凭据来源引用（env 变量名），重启后从环境重建 Authorization；
- 保温关闭即删除对应请求体（不留存对话数据）。

## 安装

需求：Node ≥ 18；dsh ≥ 0.1.7-rc.1（0.2.x 实测通过）。

### 1) sidecar

```bash
git clone https://github.com/Nameshouldbelong/dsh-HEARTBEAT.git
cd dsh-HEARTBEAT/sidecar
node sidecar.js          # 默认监听 127.0.0.1:8791，上游 api.kimi.com/coding
```

生产建议用 systemd user unit / pm2 守护（参考单元：`ExecStart=node <path>/sidecar.js`，`Restart=always`）。

### 2) dsh 插件

```bash
cd dsh-HEARTBEAT/plugin
npm pack
dsh plugin --profile web add ./dsh-heartbeat-<version>.tgz
```

### 3) 验证

```bash
curl -s http://127.0.0.1:8791/healthz
# {"ok":true,...,"buildSha":"...","capabilities":["tool-gate",...]}
```

## 使用

| 入口 | 操作 |
|---|---|
| Web HEARTBEAT tab | 保温窗口输入（如 `20-30`）+ 每会话 ON/OFF；徽标：🟢 HIT / 🟠 BURSTING / 🟠 RETRYING / 🟡 WINDOW-EXPIRED / 🟡 STALE / 🔵 WAITING |
| Web TOOL GATE tab | kimi 出站工具门控开关 + 前缀 + 累计统计（剥除工具数/节省字节） |
| Web 命令 | `/HTON [20-30]` 开（无参默认 20-30）· `/HTOFF` 关 · `/HTO 15-20` 设窗口并开 · `/TGON /TGOFF /TG` 门控 |
| Telegram duty | 同名斜杠指令（`/HTON 15-20`、`/HTON` 等） |

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SIDECAR_PORT` | `8791` | sidecar 监听端口（插件侧同名变量 + `SIDECAR_HOST`） |
| `UPSTREAM_HOST` / `UPSTREAM_PREFIX` / `UPSTREAM_PORT` / `UPSTREAM_PROTOCOL` | `api.kimi.com` / `/coding` / `443` / https | 上游（测试时可指 mock） |
| `INJECT_TTL` / `INJECT_AFFINITY` | `1` | TTL 注入 / 亲和键写回开关（`0` 关闭） |
| `HB_WINDOW_START_MIN` / `HB_WINDOW_END_MIN` | `20` / `30` | 默认保温窗口（分钟） |
| `BURST_INTERVAL_MS` | `5000` | 突发步进间隔 |
| `HIT_RATIO_MIN` | `0.05` | 命中率门槛（低于即计入命中墙） |
| `FAIL_THRESHOLD` | `1` | 命中墙阈值：单次低命中即熔断（唯一自动关闭判据） |
| `PING_TIMEOUT_MS` | `120000` | 单次 ping 上游超时 |
| `PRICE_INPUT_PER_M` / `PRICE_CACHE_READ_PER_M` | kimi 价目 | 花费估算仅展示，不参与任何关闭决策 |
| `DSH_HEARTBEAT_STATE_FILE` | `$DSH_HOME` 推导 | 插件状态文件路径 |

## 配套：dsh 模型目录补丁（K3.1 / K3.1 HighSpeed）

Kimi 官方 Coding Plan 已上线 `k3.1-pro` / `k3.1-pro-highspeed`，但 dsh 内置模型目录可能滞后。仓库提供幂等补丁脚本：

```bash
node scripts/add-k31-models.js            # 自动探测 dsh 安装路径
DSH_ROOT=/your/dsh node scripts/add-k31-models.js
```

要点（详见 [docs/DSH-MODEL-CATALOG.md](docs/DSH-MODEL-CATALOG.md)）：

- k3.1 默认 effort=max 且不可关思考（off→400），effort 映射 medium→high、xhigh→max；
- `k3.1-pro-highspeed` 消耗倍率 ≈2×，且**未列入官方缓存支持清单**（命中墙会自动保护）；
- 切换模型/effort 会使缓存失效——会话中途别切；
- **dsh npm 更新会覆盖模型目录**，脚本可重复执行恢复。

## 测试

```bash
node --test sidecar/test/sidecar.test.mjs plugin/test/*.test.mjs
```

69 个用例：亲和键推导、TTL 分派、ping 语义、区间突发（窗口耗尽/429 突发恢复/幂等对账）、工具门控（录制体==出站体逐字节一致）、熔断持久化、参数解析等。
注意：0600 权限断言在 NTFS/DrvFs 上必失败，请在 Linux ext4 上跑。

## 文档索引

- [docs/INTERFACES.md](docs/INTERFACES.md) — 接口契约（Contract-A/B/C/D/E/F）
- [docs/CONFIG-CANON.md](docs/CONFIG-CANON.md) — 数字口径唯一权威
- [docs/TTL-FINDINGS.md](docs/TTL-FINDINGS.md) — TTL 实测数据（28–45min）
- [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) — 已知问题与勘误
- [docs/DSH-MODEL-CATALOG.md](docs/DSH-MODEL-CATALOG.md) — dsh 模型目录补丁

## 安全与合规

- 本项目**不篡改客户端身份**：转发保留原始 User-Agent 与全部头，符合 Kimi "使用第三方工具时请保持真实身份标识" 的要求；
- 所有持久化文件 0600，凭据不落盘；
- 请遵守 Kimi 服务条款与所在地区法规，将本项目用于自己的订阅额度。

## 社区

- 欢迎 Issue（bug 报告/功能建议）与 Fork + PR；PR 请附测试（`node --test`）与必要的事故/数据依据；
- 主分支 `main` 由维护者合并（squash 为主）；功能开发请从 `feat/*` 分支发起 PR；
- 数字口径变更（窗口/间隔/命中率等）需同步 [docs/CONFIG-CANON.md](docs/CONFIG-CANON.md)。

## License

[MIT](LICENSE) © 2026 Nameshouldbelong —— 附加条款：禁止未经作者授权的付费倒卖或借本项目牟利的再分发（详见 LICENSE 尾注）。
