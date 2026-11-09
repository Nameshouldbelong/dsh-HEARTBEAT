# dsh 模型目录补丁：K3.1 / K3.1 HighSpeed

2026-10-24 Kimi 官方发布 K3.1 Pro / K3.1 Pro HighSpeed（Coding Plan 可用），dsh 内置模型目录未同步收录。本目录说明 dsh 侧需要的最小改动与脚本用法。

## dsh 模型目录在哪

```
<dsh 安装根>/lib/node_modules/@deepseek-ai/dsh/node_modules/
  └── @earendil-works/pi-ai/dist/providers/data/kimi-coding.json
```

结构（**外层包装绝不能丢**）：

```json
{
  "openai-completions": {
    "chat:k3": { "id": "k3", "...": "..." },
    "chat:k3.1-pro": { "...": "..." }
  }
}
```

运行时通过 `import` 直接加载该 JSON，**没有 manifest 哈希校验**——改完即生效（重启 dsh 后）。

## 官方口径要点（2026-10-24 文档）

| 项 | K3.1 Pro | K3.1 Pro HighSpeed |
|---|---|---|
| Coding Plan 模型 ID | `k3.1-pro` | `k3.1-pro-highspeed` |
| 开放平台模型 ID | `kimi-k3.1-pro` 前缀（**两端不同，勿混用**） | 同左 |
| 思考 | 常开且不可关（`thinking` off → 400） | 同左 |
| 默认 effort | `max` | 同左 |
| effort 映射 | ultra/max/xhigh→`max`；high/medium→`high`；low/minimum/light→`low` | 同左 |
| 消耗倍率 | 1× | ≈2×（速度 2–3×） |
| TTL 1h 缓存 | 官方支持清单**含 k3.1-pro** | **未列入**官方缓存支持清单（本插件命中墙会自动保护） |
| 1M 上下文 | 需 Pro+ 档订阅 | 同左 |

⚠️ **切换模型或 effort 档位会使前缀缓存失效**——会话中途切换后首次请求是全价冷读。

## 脚本

```bash
node scripts/add-k31-models.js                  # 自动探测
DSH_ROOT=/your/dsh node scripts/add-k31-models.js
```

行为：

1. 克隆 `chat:k3` 条目生成 `chat:k3.1-pro`（1× cost）与 `chat:k3.1-pro-highspeed`（2× cost），写入 `thinkingLevelMap`；
2. **防剥包装**：写前探测外层缺失的损坏态并自动恢复 `{"openai-completions": …}`（2026-10-24 曾因脚本误剥包装导致 dsh web 模型列表清空，已修复并加回读校验）；
3. 幂等，可重复执行；**dsh npm 更新会覆盖该 JSON**，届时重跑即可。

## 验证

重启 dsh web 后：模型选择器 → kimi-coding 分组应出现 `Kimi K3.1 Pro` 与 `Kimi K3.1 Pro HighSpeed`，原有 k3/kimi-for-coding 条目不受影响。
