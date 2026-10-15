# AGY 任务书：dsh-HEARTBEAT M1–M4

你在 agy-vm 上，任务是按契约实现 dsh 心跳插件并提交 PR。开始前**必读**：

1. `docs/PLAN.md` —— 里程碑与接口契约清单（实现范围 = M1、M2、M3、M4）
2. `docs/INTERFACES.md` —— 每个接口的 schema 与行为细节（含边界条件，逐条照做）

## 工作方式

```bash
cd ~/dsh-HEARTBEAT
git checkout -b feat/heartbeat
# 实现 M1(sidecar/) M2+M3+M4(plugin/)
git push -u origin feat/heartbeat
gh pr create --base main --title "feat: heartbeat plugin M1-M4" --body "按 docs/PLAN.md M1-M4 实现…"
```

## 硬性约束

- **不要**改动 `sidecar/sidecar.js` 里已实现的：亲和键推导（Contract-A）、`/healthz`、cache_control 注入、请求转发与 usage 日志。只在此外**追加** /sessions 与 /control 路由 + ping 定时器
- 插件 server 零第三方依赖（node 内置 http/fs/crypto 够用）；client 遵循 dsh 插件 client 注入模式
- 所有写盘原子写（tmp+rename）；路径 `~/.dsh/storages/dsh-heartbeat/state.json`
- 环境无 dsh 类型包时可 `npm view` 不可行则直接参照三个真实插件源码（README 参考实现节）反推 API
- `node --test` 放 `**/test/*.test.mjs`，至少覆盖：state 读写、/control 请求构造、ping body 改写（max_tokens/stream）、/HTO 参数解析（含 `  ` 空格、越界、非数字）
- 参考底座：WSL 生产正在跑 `sidecar/sidecar.js`（本仓库 main 已含），行为以它为准

## 环境事实

- node v24.15.0（`parseEnv` 可用）；gh 已登录 Nameshouldbelong
- 本机 dsh 为 0.1.5-rc.2（**不要**用它跑验收；M5 验收由用户侧在装好 0.1.7-rc.2 的环境做）
- 内存仅 964MB：跑测试没问题，别起多个 dsh 实例

## 完成定义

PR 描述里附：实现清单（对照 PLAN.md 第 2 节接口表逐行标 ☑/☐+一句话说明）、测试输出、已知限制。验收方（用户侧）会在同版本 dsh 做 E2E（PLAN.md 第 4 节 8 项），不过再改。
