import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { renameSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  CACHE_DIRECTORIES, CachePruner, DEFAULT_CACHE_LIMIT_BYTES, PRUNE_INTERVAL_MS, TEMPORARY_DIRECTORIES, TEMPORARY_PATTERN,
  TOUCH_WARNING_INTERVAL_MS, touchCache,
} from '../server/cache-prune.js';
import { Library } from '../server/library.js';
import { Fitter } from '../server/fit.js';
import { Placeholders } from '../server/placeholder.js';

// 时间全部相对一个固定的“现在”，用 utimes 设定修改时间，不依赖等待。
// 路径比较只用文件名或相对路径：清理使用图库目录的真实路径，Windows 上临时目录的短路径名（如 RUNNER~1）会被展开。
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const hex = index => index.toString(16).padStart(64, '0');
// 与 randomUUID 同格式的固定 uuid，便于构造本程序的临时文件名。
const uuid = index => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-prune-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'library');
  await mkdir(directory);
  return { root, directory };
}

async function put(filename, bytes, ageMs, now = NOW) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, Buffer.alloc(bytes, 7));
  const time = new Date(now - ageMs);
  await utimes(filename, time, time);
  return filename;
}

function pruner(directory, options = {}) {
  const logs = [];
  const warnings = [];
  const instance = new CachePruner(directory, { now: () => NOW, log: message => logs.push(message), warn: message => warnings.push(message), ...options });
  return { instance, logs, warnings };
}

async function exists(filename) {
  try { await stat(filename); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const entry = (result, name) => result.directories.find(item => item.name === name);

// Windows 上创建符号链接可能需要权限；失败时跳过该用例并说明原因。
async function trySymlink(t, target, link, type) {
  try {
    await symlink(target, link, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`当前系统不允许创建${type === 'file' ? '文件' : '目录'}符号链接（${error.code}）`);
      return false;
    }
    throw error;
  }
}

test('defaults cover the four regenerable caches and the temporary-file locations', () => {
  assert.equal(DEFAULT_CACHE_LIMIT_BYTES, 512 * 1024 * 1024);
  assert.equal(PRUNE_INTERVAL_MS, 6 * 60 * MINUTE);
  assert.deepEqual(Object.keys(CACHE_DIRECTORIES).sort(), ['fitted', 'insertion-quality', 'lan-cache', 'placeholders']);
  assert.deepEqual([...TEMPORARY_DIRECTORIES].sort(), ['.', 'clients', 'images', 'insertion', 'thumbnails']);
  const instance = new CachePruner('library');
  assert.ok(Object.values(instance.limits).every(limit => limit === DEFAULT_CACHE_LIMIT_BYTES));
  assert.throws(() => new CachePruner('library', { maxBytes: -1 }), /非负整数/);
  assert.throws(() => new CachePruner('library', { maxBytes: { images: 10 } }), /未知的缓存目录/);
  assert.throws(() => new CachePruner('library', { protectMs: Infinity }), /有限/);
});

test('only the two temporary-file names this program writes are recognised', () => {
  const id = randomUUID();
  for (const name of [`index-${id}.tmp`, `usage.json.${id}.tmp`, `${hex(1)}.png.${id}.tmp`, `${hex(2)}-clear.jpg.${id}.tmp`, `0f8fad5b-d9cb-469f-a165-70867728950e.json.${id}.tmp`]) {
    assert.ok(TEMPORARY_PATTERN.test(name), name);
  }
  for (const name of ['notes.tmp', '备份.tmp', 'x.tmp', '.tmp', `${id}.tmp`, `index-${id}.tmp.bak`, `index-${id.toUpperCase()}.tmp`,
    `usage.json.${id.slice(0, -1)}.tmp`, `index${id}.tmp`, 'index.json', 'tmp']) {
    assert.equal(TEMPORARY_PATTERN.test(name), false, name);
  }
});

test('an over-limit cache deletes the oldest files first until it fits, ignoring files it did not generate', async t => {
  const { directory } = await setup(t);
  const fitted = path.join(directory, 'fitted');
  const ages = [60, 50, 40, 30, 20];
  const files = [];
  for (const [index, age] of ages.entries()) files.push(await put(path.join(fitted, `${hex(index)}.${index % 2 ? 'png' : 'jpg'}`), 100, age * MINUTE));
  const foreign = await put(path.join(fitted, '用户自己的文件.png'), 1000, 30 * DAY);
  const { instance, logs, warnings } = pruner(directory, { maxBytes: { fitted: 250 } });
  const result = await instance.run();
  const stats = entry(result, 'fitted');
  // checked 只计名称符合缓存或临时文件格式的普通文件，不含“用户自己的文件.png”。
  assert.deepEqual([stats.checked, stats.deleted, stats.bytes, stats.failed, stats.remainingBytes], [5, 3, 300, 0, 200]);
  assert.deepEqual(await Promise.all(files.map(exists)), [false, false, false, true, true], '从最旧的开始删除');
  assert.equal(await exists(foreign), true, '不符合缓存命名的文件不计入也不删除');
  assert.equal(result.deleted, 3);
  assert.equal(typeof result.bytes, 'number');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /删除 3 个文件.*fitted 删除 3/);
  assert.deepEqual(warnings, []);
  const again = await instance.run();
  assert.equal(again.deleted, 0);
  assert.equal(logs.length, 1, '没有删除或失败时不输出日志');
});

test('files modified in the last ten minutes are kept even when the cache stays over its limit', async t => {
  const { directory } = await setup(t);
  const old = await put(path.join(directory, 'placeholders', `${hex(1)}.png`), 100, 11 * MINUTE);
  const recent = await put(path.join(directory, 'placeholders', `${hex(2)}.png`), 100, 9 * MINUTE);
  const fresh = await put(path.join(directory, 'placeholders', `${hex(3)}.png`), 100, 0);
  const future = await put(path.join(directory, 'placeholders', `${hex(4)}.png`), 100, -5 * MINUTE);
  const result = await pruner(directory, { maxBytes: 50 }).instance.run();
  assert.equal(await exists(old), false);
  assert.deepEqual(await Promise.all([recent, fresh, future].map(exists)), [true, true, true]);
  assert.equal(entry(result, 'placeholders').remainingBytes, 300);
});

test('stale temporary files are removed everywhere, recent ones stay, and formal data and foreign .tmp files are never touched', async t => {
  const { directory } = await setup(t);
  const id = hex(9);
  const ancient = 365 * DAY;
  const formal = [
    'index.json', 'usage.json', 'knowledge.json', 'connection.json', 'index-v1-backup-1-abc.json', 'index.json.tmp.bak', 'tmp',
    'notes.tmp', '备份.tmp', 'x.tmp', `images/${id}.png`, `images/${id}.jpeg`, `images/notes.tmp`, `thumbnails/${id}.jpeg`, `insertion/${id}.png`,
    'clients/0f8fad5b-d9cb-469f-a165-70867728950e.json', 'clients/备份.tmp', `images/子目录/${id}.png.${uuid(99)}.tmp`, 'fitted/x.tmp',
  ];
  const formalFiles = [];
  for (const name of formal) formalFiles.push(await put(path.join(directory, ...name.split('/')), 64, ancient));
  const formalBytes = await Promise.all(formalFiles.map(file => readFile(file)));
  const locations = ['.', 'images', 'thumbnails', 'insertion', 'clients', 'fitted', 'placeholders', 'lan-cache', 'insertion-quality', 'insertion-quality/v2-sharp-0.35.5'];
  const stale = [];
  const recent = [];
  for (const [index, location] of locations.entries()) {
    const folder = path.join(directory, ...location.split('/'));
    // 两种真实命名：index-<uuid>.tmp 与 <目标文件名>.<uuid>.tmp。
    stale.push(await put(path.join(folder, `index-${uuid(index)}.tmp`), 10, 61 * MINUTE));
    stale.push(await put(path.join(folder, `${hex(index)}.png.${uuid(index)}.tmp`), 10, 2 * DAY));
    recent.push(await put(path.join(folder, `usage.json.${uuid(index)}.tmp`), 10, 59 * MINUTE));
  }
  // 缓存上限为 0：即使最严格的上限，正式数据也一个都不删。
  const { instance, logs } = pruner(directory, { maxBytes: 0 });
  const result = await instance.run();
  assert.equal(result.failed, 0);
  assert.deepEqual(await Promise.all(stale.map(exists)), stale.map(() => false), '超过 1 小时的临时文件全部删除');
  assert.deepEqual(await Promise.all(recent.map(exists)), recent.map(() => true), '1 小时内的临时文件保留');
  assert.deepEqual(await Promise.all(formalFiles.map(exists)), formalFiles.map(() => true), '正式数据与其他 .tmp 文件全部保留');
  assert.deepEqual(await Promise.all(formalFiles.map(file => readFile(file))), formalBytes);
  assert.equal(result.deleted, stale.length);
  assert.equal(result.bytes, stale.length * 10);
  assert.equal(entry(result, '.').deleted, 2);
  assert.equal(entry(result, '.').checked, 3, '图库根目录只检查临时文件命名的文件');
  assert.equal(entry(result, 'images').checked, 3, 'images/ 中的图片不逐个 lstat');
  assert.equal(entry(result, 'insertion-quality').deleted, 4, '版本子目录中的临时文件也清理');
  assert.equal(logs.length, 1);
  for (const folder of ['images', 'thumbnails', 'insertion', 'clients']) {
    assert.ok((await readdir(path.join(directory, folder))).length > 0);
  }
});

test('a file whose identity changes after the scan is neither deleted nor counted as a failure', async t => {
  const { directory } = await setup(t);
  // 图库根目录最先处理，第一次调用 now() 时它已扫描完、尚未删除。
  assert.equal(TEMPORARY_DIRECTORIES[0], '.');
  const scanned = new Date(NOW - 2 * DAY);
  const touched = await put(path.join(directory, `index-${uuid(1)}.tmp`), 10, 2 * DAY);
  const replaced = await put(path.join(directory, `usage.json.${uuid(2)}.tmp`), 10, 2 * DAY);
  const untouched = await put(path.join(directory, `knowledge.json.${uuid(3)}.tmp`), 10, 2 * DAY);
  let mutated = false;
  const now = () => {
    if (!mutated) {
      mutated = true;
      // 修改时间变化（如缓存命中刷新了时间）。
      const later = new Date(NOW - DAY);
      utimesSync(touched, later, later);
      // 换成另一个文件但修改时间相同：只有 ino 不同。新文件先写好再改名覆盖，避免系统复用同一个 ino。
      writeFileSync(`${replaced}.new`, Buffer.alloc(10, 9));
      utimesSync(`${replaced}.new`, scanned, scanned);
      renameSync(`${replaced}.new`, replaced);
    }
    return NOW;
  };
  const result = await pruner(directory, { now }).instance.run();
  const stats = entry(result, '.');
  assert.deepEqual([stats.checked, stats.deleted, stats.failed], [3, 1, 0]);
  assert.deepEqual(await Promise.all([touched, replaced, untouched].map(exists)), [true, true, false]);
  assert.deepEqual(await readFile(replaced), Buffer.alloc(10, 9), '替换后的文件没有被删除');
  assert.equal(result.failed, 0);
});

test('real generators produce cache names the pruner recognises, and leave no temporary files', async t => {
  const { directory } = await setup(t);
  const library = await Library.open(directory);
  const jpeg = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#336677' } }).withDensity(300).jpeg().toBuffer();
  const webp = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#774433' } }).webp().toBuffer();
  await library.importFile('照片.jpeg', jpeg);
  await library.importFile('网页图.webp', webp);
  const id = library.assets.find(asset => asset.format === 'jpeg').id;
  const generated = [
    (await new Fitter(library).create(id, { mode: 'cover', widthPt: '100', heightPt: '100' })).path,
    (await new Placeholders(library.directory).create({ name: '框', widthPt: 100, heightPt: 80 })).path,
    (await library.insertion(id, 'clear')).path,
  ];
  // lan-cache 的真实下载需要局域网地址（test/lan.test.js 中另有对真实下载文件名的断言）；
  // 这里按 lan-client.js download() 的命名表达式 `${sha256}.${png|jpg}` 构造。
  const content = Buffer.from('局域网缓存内容');
  await mkdir(path.join(directory, 'lan-cache'));
  generated.push(path.join(directory, 'lan-cache', `${createHash('sha256').update(content).digest('hex')}.png`));
  await writeFile(generated[3], content);
  const relative = generated.map(file => path.relative(directory, file).split(path.sep));
  assert.deepEqual(relative.map(parts => parts[0]), ['fitted', 'placeholders', 'insertion-quality', 'lan-cache']);
  for (const parts of relative) assert.ok(CACHE_DIRECTORIES[parts[0]].pattern.test(parts.at(-1)), `${parts.join('/')} 符合缓存命名`);
  const folders = ['.', 'images', 'thumbnails', 'insertion', ...generated.map(file => path.dirname(file))];
  for (const folder of folders) {
    assert.deepEqual((await readdir(path.resolve(directory, folder))).filter(name => name.endsWith('.tmp')), [], `${folder} 没有遗留临时文件`);
  }
  // 按各生成方的临时文件命名规则构造过期临时文件。
  const now = Date.now() + MINUTE;
  const temporary = [
    ...generated.map(file => `${file}.${randomUUID()}.tmp`),
    path.join(directory, `index-${randomUUID()}.tmp`),
    `${path.join(directory, 'usage.json')}.${randomUUID()}.tmp`,
    `${path.join(directory, 'knowledge.json')}.${randomUUID()}.tmp`,
    `${path.join(directory, 'images', `${id}.jpeg`)}.${randomUUID()}.tmp`,
  ];
  for (const file of temporary) await put(file, 10, 2 * 60 * MINUTE, now);
  // 正式文件快照，不含刚构造的临时文件。
  const snapshot = async () => {
    const files = {};
    for (const folder of ['images', 'thumbnails', 'insertion']) {
      for (const name of (await readdir(path.join(directory, folder))).sort()) {
        if (!TEMPORARY_PATTERN.test(name)) files[`${folder}/${name}`] = await readFile(path.join(directory, folder, name));
      }
    }
    files['index.json'] = await readFile(path.join(directory, 'index.json'));
    return files;
  };
  const before = await snapshot();
  assert.ok(Object.keys(before).some(name => name.startsWith('insertion/')), 'WebP 生成了插入副本');
  const result = await pruner(directory, { maxBytes: 0, protectMs: 0, now: () => now }).instance.run();
  assert.equal(result.failed, 0);
  assert.deepEqual(await Promise.all(generated.map(exists)), generated.map(() => false), '四个缓存都被删除');
  assert.deepEqual(await Promise.all(temporary.map(exists)), temporary.map(() => false), '按真实命名构造的过期临时文件都被删除');
  assert.deepEqual(await snapshot(), before, 'images/、thumbnails/、insertion/ 与 index.json 不变');
});

test('a cache directory that is a symbolic link is skipped with a warning', async t => {
  const { root, directory } = await setup(t);
  const outside = path.join(root, 'outside');
  const outsideFile = await put(path.join(outside, `${hex(1)}.png`), 100, 30 * DAY);
  const outsideTemporary = await put(path.join(outside, `index-${uuid(1)}.tmp`), 10, 30 * DAY);
  if (!(await trySymlink(t, outside, path.join(directory, 'fitted'), process.platform === 'win32' ? 'junction' : 'dir'))) return;
  await mkdir(path.join(directory, 'insertion-quality'));
  if (!(await trySymlink(t, outside, path.join(directory, 'insertion-quality', 'v2-sharp-0.35.5'), process.platform === 'win32' ? 'junction' : 'dir'))) return;
  const { instance, warnings } = pruner(directory, { maxBytes: 0 });
  const result = await instance.run();
  assert.equal(await exists(outsideFile), true);
  assert.equal(await exists(outsideTemporary), true);
  assert.equal(entry(result, 'fitted').checked, 0);
  assert.equal(entry(result, 'insertion-quality').checked, 0);
  assert.equal(result.deleted, 0);
  assert.ok(warnings.some(message => /符号链接目录：fitted$/.test(message)));
  assert.ok(warnings.some(message => /符号链接：insertion-quality[\\/]v2-sharp-0\.35\.5$/.test(message)));
});

test('a cached or temporary file that is a symbolic link is skipped and its target is kept', async t => {
  const { root, directory } = await setup(t);
  const target = await put(path.join(root, 'outside', '目标.png'), 100, 30 * DAY);
  await mkdir(path.join(directory, 'lan-cache'), { recursive: true });
  await mkdir(path.join(directory, 'clients'), { recursive: true });
  const cacheLink = path.join(directory, 'lan-cache', `${hex(1)}.png`);
  const temporaryName = `0f8fad5b-d9cb-469f-a165-70867728950e.json.${uuid(1)}.tmp`;
  const temporaryLink = path.join(directory, 'clients', temporaryName);
  if (!(await trySymlink(t, target, cacheLink, 'file'))) return;
  if (!(await trySymlink(t, target, temporaryLink, 'file'))) return;
  const result = await pruner(directory, { maxBytes: 0, temporaryAgeMs: 0, protectMs: 0 }).instance.run();
  assert.equal(result.deleted, 0);
  assert.equal(entry(result, 'lan-cache').checked, 0);
  assert.equal(entry(result, 'clients').checked, 0);
  assert.equal(await exists(target), true);
  assert.ok((await readdir(path.join(directory, 'lan-cache'))).includes(`${hex(1)}.png`));
  assert.ok((await readdir(path.join(directory, 'clients'))).includes(temporaryName));
});

test('missing cache directories and a missing library directory are skipped without output', async t => {
  const { root, directory } = await setup(t);
  const { instance, logs, warnings } = pruner(directory);
  const result = await instance.run();
  assert.equal(result.directories.length, TEMPORARY_DIRECTORIES.length + Object.keys(CACHE_DIRECTORIES).length);
  assert.ok(result.directories.every(item => item.checked === 0 && item.deleted === 0 && item.failed === 0));
  const missing = await pruner(path.join(root, '不存在')).instance.run();
  assert.deepEqual([missing.directories.length, missing.deleted, missing.failed], [0, 0, 0]);
  assert.deepEqual([logs, warnings], [[], []]);
});

test('a file that cannot be deleted is counted and the rest of the cleanup continues', async t => {
  const { directory } = await setup(t);
  const files = [];
  for (let index = 0; index < 3; index++) files.push(await put(path.join(directory, 'fitted', `${hex(index)}.jpg`), 100, (30 - index) * MINUTE));
  const lockedTemporary = await put(path.join(directory, 'images', `${hex(1)}.png.${uuid(1)}.tmp`), 10, 2 * DAY);
  const staleTemporary = await put(path.join(directory, 'images', `${hex(2)}.png.${uuid(2)}.tmp`), 10, 2 * DAY);
  // 按文件名比较：清理使用图库目录的真实路径，Windows 上临时目录的短路径名（如 RUNNER~1）会被展开，完整路径字符串不相等。
  const locked = new Set([files[0], lockedTemporary].map(filename => path.basename(filename)));
  const remove = async filename => {
    if (locked.has(path.basename(filename))) throw Object.assign(new Error('文件被占用'), { code: process.platform === 'win32' ? 'EBUSY' : 'EPERM' });
    await unlink(filename);
  };
  const { instance, logs } = pruner(directory, { maxBytes: 0, remove });
  const result = await instance.run();
  assert.deepEqual([entry(result, 'fitted').deleted, entry(result, 'fitted').failed], [2, 1]);
  assert.deepEqual([entry(result, 'images').deleted, entry(result, 'images').failed], [1, 1]);
  assert.deepEqual([result.deleted, result.failed], [3, 2]);
  assert.deepEqual(await Promise.all([...files, lockedTemporary, staleTemporary].map(exists)), [true, false, false, true, false]);
  assert.equal(entry(result, 'fitted').errors[0].path, path.join('fitted', `${hex(0)}.jpg`));
  assert.match(logs[0], /失败 2 个/);
  // 删除函数抛出非文件系统错误也不会让 run 被拒绝。
  const broken = pruner(directory, { maxBytes: 0, remove: async () => { throw new TypeError('意外错误'); } });
  const second = await broken.instance.run();
  assert.equal(second.failed, 2);
});

test('insertion-quality is pruned across its version subdirectories but not deeper', async t => {
  const { directory } = await setup(t);
  const base = path.join(directory, 'insertion-quality');
  const oldVersion = await put(path.join(base, 'v1-sharp-0.34.0', `${hex(1)}-clear.jpg`), 100, 3 * DAY);
  const older = await put(path.join(base, 'v2-sharp-0.35.5', `${hex(2)}-balanced.png`), 100, 4 * DAY);
  const newer = await put(path.join(base, 'v2-sharp-0.35.5', `${hex(3)}-clear.png`), 100, 1 * DAY);
  const deeper = await put(path.join(base, 'v2-sharp-0.35.5', '更深', `${hex(4)}-clear.png`), 100, 9 * DAY);
  const wrongName = await put(path.join(base, 'v2-sharp-0.35.5', `${hex(5)}-original.png`), 100, 9 * DAY);
  const result = await pruner(directory, { maxBytes: { 'insertion-quality': 150 } }).instance.run();
  assert.deepEqual(await Promise.all([older, oldVersion, newer, deeper, wrongName].map(exists)), [false, false, true, true, true]);
  const stats = entry(result, 'insertion-quality');
  // checked 不含名称不符合格式的 -original.png，也不含更深一层的文件。
  assert.deepEqual([stats.checked, stats.deleted, stats.remainingBytes], [3, 2, 100]);
  assert.equal(await exists(path.join(base, 'v1-sharp-0.34.0')), true, '只删除文件，不删除目录');
});

test('concurrent runs share one pass and the interval timer is unreferenced and cleared on stop', async t => {
  const { directory } = await setup(t);
  await put(path.join(directory, 'fitted', `${hex(1)}.jpg`), 100, DAY);
  const { instance } = pruner(directory, { maxBytes: 0 });
  const first = instance.run();
  assert.equal(instance.run(), first);
  assert.equal((await first).deleted, 1);
  const started = instance.start(1000);
  assert.equal(instance.timer.hasRef(), false);
  instance.stop();
  assert.equal(instance.timer, null);
  assert.equal((await started).deleted, 0);
  assert.throws(() => instance.start(0), /间隔/);
});

test('failed cache time refreshes warn at most once per error code per interval and stay usable', async () => {
  // 告警状态在进程内共享：使用远期时钟与测试专用错误码，避免与其他用例互相影响。
  let time = Date.parse('2100-01-01T00:00:00.000Z');
  const warnings = [];
  const failing = code => async () => { throw Object.assign(new Error('刷新失败'), { code }); };
  const options = code => ({ now: () => time, warn: (...values) => warnings.push(values), utimes: failing(code) });
  assert.equal(await touchCache('a.png', options('ETESTA')), true, '刷新失败时缓存仍可用');
  time += 1000;
  assert.equal(await touchCache('b.png', options('ETESTA')), true);
  assert.equal(warnings.length, 1, '同一错误码间隔内只告警一次');
  assert.match(warnings[0][0], /ETESTA/);
  assert.equal(await touchCache('c.png', options('ETESTB')), true);
  assert.equal(warnings.length, 2, '不同错误码各自告警');
  time += TOUCH_WARNING_INTERVAL_MS;
  await touchCache('d.png', options('ETESTA'));
  assert.equal(warnings.length, 3, '间隔过后再次告警');
  assert.equal(await touchCache('e.png', options('ENOENT')), false, '文件已不存在时按未命中处理');
  assert.equal(warnings.length, 3);
  // 错误码数量有上限：大量不同错误码不会让记录无界增长，也不会抛错。
  for (let index = 0; index < 100; index++) assert.equal(await touchCache('f.png', options(`ETESTX${index}`)), true);
  assert.equal(warnings.length, 103);
});
