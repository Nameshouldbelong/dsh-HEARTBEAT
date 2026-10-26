# 贡献指南

欢迎参与 dsh-HEARTBEAT！这是一个很小的社区项目，约定保持轻量。

## 提 Issue

- **Bug 报告**：请附 sidecar `healthz` 输出（含 buildSha）、`usage.jsonl` 相关行、复现步骤与期望/实际行为。**请脱敏**：不要贴 API key、完整对话内容；
- **功能建议**：说明使用场景与期望行为；涉及窗口/间隔/命中率等数字口径的，请给出实测数据。

## 提 PR

1. 从 `main` 拉出 `feat/*` 或 `fix/*` 分支；
2. 跑全量测试并保持绿：
   ```bash
   node --test sidecar/test/sidecar.test.mjs plugin/test/*.test.mjs
   ```
   （0600 权限断言需 Linux ext4；macOS/Windows 部分用例会因文件系统差异失败，属已知环境限制）
3. 涉及对外行为的改动（端点/参数/默认值/数字口径）请同步 `docs/INTERFACES.md` 与 `docs/CONFIG-CANON.md`；
4. PR 描述写清动机与验证方式；维护者以 squash 合并为主。

## 代码风格

- 插件 server / sidecar 零第三方依赖（Node 内置模块够用）；
- 注释面向"下一个读代码的人"：只解释代码本身说不出的约束与事故背景；
- 持久化一律原子写（tmp+rename）+ 0600；凭据绝不落盘。

## 安全

发现安全问题（如凭据泄漏路径、注入绕过）请优先开 issue 标注 `[security]`，不要在公开场合贴可利用细节。
