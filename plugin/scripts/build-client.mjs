// 构建 lib/client.js: ESM 源 → dsh ModuleLoader 经典脚本
// 契约(实测): 源码顶层须定义 const factory = (require) => ({...}); 不要自行调用
// window.__ModuleLoader__.load —— composer 会追加以完整插件 id 的注册调用。
import { readFileSync, writeFileSync } from 'node:fs';
let s = readFileSync(new URL('../lib/client.mjs', import.meta.url), 'utf8');
s = s.replace(/export const inject = (\[[^
]*\]);/, 'const inject = $1;');
s = s.replace(/export function apply\(/, 'function apply(');
s = s.replace(/\/\/ 兼容 DSH ModuleLoader 与 ESM[\s\S]*?const factory = /, 'const factory = ');
s = s.replace(/
\s*window\.__ModuleLoader__\.load\(\{ id: .dsh-heartbeat., factory \};
\}/, '');
writeFileSync(new URL('../lib/client.js', import.meta.url), s);
console.log('client.js built');
