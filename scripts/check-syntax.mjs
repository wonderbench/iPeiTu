// 语法检查：递归检查 server/ 与 public/ 下的全部 .js 文件，新增文件无需再改 package.json。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

const files = ['server', 'public'].flatMap(name => collect(path.join(root, name))).sort();
if (!files.length) {
  console.error('语法检查没有找到任何 .js 文件，请确认 server/ 与 public/ 目录存在且未被移动');
  process.exit(1);
}
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    failed += 1;
    console.error(`语法检查失败：${path.relative(root, file)}`);
    console.error((result.error?.message ?? result.stderr ?? '').trim());
  }
}
console.log(`已检查 ${files.length} 个文件，失败 ${failed} 个`);
process.exit(failed ? 1 : 0);