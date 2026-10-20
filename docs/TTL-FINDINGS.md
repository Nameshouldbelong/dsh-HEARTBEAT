# Kimi prompt cache TTL 实测结论（2026-10-20）

## 结论：实际 TTL ≈ 40 分钟，且命中会自动续期

五组独立实验（同一 sidecar、同一 model=k3-256k）：

| 实验 | 前缀 | 节奏 | 结果 |
|---|---|---|---|
| ttl-clean | 5,611 | 空闲 6.1min → 42.6min | HIT → **MISS** |
| final-ttl | 3,709 | 空闲 5.7min → 39.7min | HIT → **MISS** |
| boundary | 6,103 | 每 5min 一次，共 60min | **12/12 全 HIT** |
| long-ttl | 6,103 | 70/80/90min | 65.9min MISS → 80/90min **HIT**（那次 MISS 自重建） |
| rebuild | 2,508 | 每 6min 一次，共 36min | **6/6 全 HIT** |

## 关键事实

1. **`ttl:"1h"` 被端点接受但未真正实现 1 小时寿命**。空闲 40-43 分钟后必 MISS。
2. **命中会自动续期**——只要间隔小于寿命，缓存可无限期维持（36min 连续 6 次
   100% 命中证明）。
3. **TTL 到期后的下一次请求会重建缓存**（long-ttl 的 80/90min 又 HIT）。所以
   保温失败的代价 ≠ 永久丢失，而是那一次全价重建。
4. **客户端自带字段与 sidecar 注入效果相同**（AB 测试：mock 上游抓包确认字节
   一致送达）。
5. 长尾抖动存在：long-ttl 在 65.9min MISS 时，前次活动仅 ~10 分钟前——缓存
   可能被服务端主动淘汰，非单纯 TTL。**间隔不宜贴着理论上限**。

## 对心跳设计的直接影响

- **45min 间隔是错的**：必然大于 TTL，每轮都全价重建 → 净亏损
  （这正是 2026-10-20 烧光 5h 配额的事故机制）。
- **默认间隔改为 30min**：在实测有效区（28.7min 仍 HIT）内，留 ~10min 安全
  余量应对长尾抖动。
- 心跳的价值 = 用 cache-read 价（全价 1/10）的请求维持缓存，避免用户下次真实
  对话时先付一次全价重建。

## 复现方式

```bash
# 单点验证（6.5min / 45min）
node scripts/verify-ttl.mjs --wait-min 45

# 长跑建议走 systemd，避免会话重启打断
systemd-run --user --unit=ttl-verify --property=KillMode=process --no-block \
  /home/jzhou/opt/node/bin/node scripts/verify-ttl.mjs --wait-min 45 --out /tmp/ttl.json
```

原始数据：`docs/verify-ttl-2026-10-20.json`、`docs/verify-ttl-45min-2026-10-20.json`。

---

## ⚠️ 重要澄清：长 TTL 并未被证实"正确发放"（2026-10-20 补记）

"字段送达"不等于"长 TTL 生效"。已证实的只有：

1. `prompt_cache_options:{mode:'implicit',ttl:'1h'}` **被端点正常接受**（无报错）——
   A/B 实验（mock 上游抓包）证明字段字节正确送达上游；
2. **实际缓存寿命 ≈ 40 分钟**，不是 1 小时——两组对照实验（sidecar 注入 /
   客户端自带）在 39.7min 与 42.6min 均 MISS。

因此准确表述是：**TTL 参数链路（DSH → sidecar → 上游）已打通且被接受，
但 1h 档位的实际寿命未被端点实现**。30min 默认间隔是基于实测寿命而非名义 TTL
选定的，这一点已被 5 组实验共同支撑（间隔 <40min 时 18/18 全命中）。

若未来 Kimi 真正实现 1h，或用户体感缓存明显更长，只需把默认间隔调大即可，
无需改架构。这是保留 `intervalMin` 可配置的原因。
