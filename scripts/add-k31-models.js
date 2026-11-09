#!/usr/bin/env node
// add-k31-models.js —— 向 dsh 的 kimi-coding 模型目录添加 Kimi K3.1 Pro / K3.1 Pro HighSpeed
// （2026-10-24 Kimi 官方发布 K3.1 系列后的 dsh 内置目录滞后补丁）
//
// 用法：
//   node scripts/add-k31-models.js                    # 自动探测常见 dsh 安装路径
//   DSH_ROOT=/path/to/dsh node scripts/add-k31-models.js
//
// 关键约束（2026-10-24 生产事故教训）：
//   kimi-coding.json 的外层结构是 {"openai-completions": {"chat:<id>": {...}}}。
//   上一版脚本误把内层模型表写到顶层，剥掉了外层包装 → dsh web 的模型列表瞬间清空。
//   本版：写前探测损坏态并自动恢复包装；写后回读校验。
//   幂等：可重复执行；dsh npm 更新会覆盖目录，重跑本脚本即可恢复。

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const REL = path.join(
  'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules',
  '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'kimi-coding.json');

function findCatalog() {
  const candidates = [];
  if (process.env.DSH_ROOT) candidates.push(path.join(process.env.DSH_ROOT, REL));
  // 常见安装形态：~/.opt/node（debootstrap 拆包装）、~/.npm-global、系统全局
  candidates.push(path.join(os.homedir(), 'opt/node', REL));
  candidates.push(path.join(os.homedir(), '.npm-global', REL));
  candidates.push(path.join('/usr', REL));
  for (const f of candidates) {
    if (fs.existsSync(f)) return f;
  }
  console.error('未找到 kimi-coding.json，请用 DSH_ROOT=<dsh 安装根目录> 指定后重试。\n尝试过的路径：\n' + candidates.join('\n'));
  process.exit(1);
}

const F = findCatalog();
console.log('catalog:', F);
const raw = JSON.parse(fs.readFileSync(F, 'utf8'));

// 兼容外层包装已被剥离的损坏态：恢复包装
let cat = raw['openai-completions'];
if (!cat) {
  cat = raw;
  console.log('检测到外层包装缺失（历史损坏态），将自动恢复 {"openai-completions": …}');
}

const k3 = cat['chat:k3'];
if (!k3) {
  console.error('目录中不存在 chat:k3 模板条目，中止（请先恢复原始目录文件）');
  process.exit(1);
}

const mk = (id, name, costMult) => {
  const e = JSON.parse(JSON.stringify(k3));
  e.id = id;
  e.name = name;
  // K3.1 官方行为（2026-10-24 文档口径）：
  //  · 思考常开且不可关（off/minimal → API 400）
  //  · 默认 effort=max；映射 ultra/max/xhigh→max，high/medium→high，low/minimum/light→low
  e.thinkingLevelMap = {
    off: null, minimal: null,
    low: 'low', medium: 'high', high: 'high',
    xhigh: 'max', max: 'max',
  };
  // highspeed 消耗倍率 ≈2×（速度 2–3×）；cost 仅用于面板展示估算，不影响订阅计费
  e.cost = {
    input: k3.cost.input * costMult,
    output: k3.cost.output * costMult,
    cacheRead: k3.cost.cacheRead * costMult,
    cacheWrite: 0,
  };
  return e;
};

cat['chat:k3.1-pro'] = mk('k3.1-pro', 'Kimi K3.1 Pro', 1);
cat['chat:k3.1-pro-highspeed'] = mk('k3.1-pro-highspeed', 'Kimi K3.1 Pro HighSpeed', 2);

// 原子写 + 强制外层包装
const tmp = F + '.tmp';
fs.writeFileSync(tmp, JSON.stringify({ 'openai-completions': cat }), { mode: 0o644 });
fs.renameSync(tmp, F);

// 写后回读校验：外层必须在、两条目必须在
const check = JSON.parse(fs.readFileSync(F, 'utf8'));
if (!check['openai-completions'] || !check['openai-completions']['chat:k3.1-pro']) {
  console.error('回读校验失败！请从 .bak 备份恢复');
  process.exit(1);
}
console.log('OK：chat:k3.1-pro 与 chat:k3.1-pro-highspeed 已写入（外层包装完好）');
console.log('提示：dsh npm 更新会覆盖本目录；届时重跑本脚本即可。重启 dsh 后生效。');
