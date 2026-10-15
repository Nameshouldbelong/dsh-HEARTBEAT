// 构建 lib/client.js: ESM 源 → dsh ModuleLoader 经典脚本
// 契约(2026-10-15 实测): 只需去掉 export 关键字; 文件内的 __ModuleLoader__.load
// 自注册(agy 原设计, 短id+完整id各一次)保持原样, 完整id 'dsh-external/dsh-heartbeat' 为生效注册。
import { readFileSync, writeFileSync } from 'node:fs';
let s = readFileSync(new URL('../lib/client.mjs', import.meta.url), 'utf8');
s = s.replace('export const inject', 'const inject');
s = s.replace('export function apply', 'function apply');
if (/^export /m.test(s)) throw new Error('residual export statement');
writeFileSync(new URL('../lib/client.js', import.meta.url), s);
console.log('client.js built (plain script)');
