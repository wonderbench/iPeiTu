import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CACHE_DIRECTORIES, CachePruner, DEFAULT_CACHE_LIMIT_BYTES, PRUNE_INTERVAL_MS, TEMPORARY_DIRECTORIES } from '../server/cache-prune.js';

// 时间全部相对一个固定的“现在”，用 utimes 设定修改时间，不依赖等待。
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const hex = index => index.toString(16).padStart(64, '0');

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-prune-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'library');
  await mkdir(directory);
  return { root, directory };
}

async function put(filename, bytes, ageMs) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, Buffer.alloc(bytes, 7));
  const time = new Date(NOW - ageMs);
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
  assert.deepEqual([stats.checked, stats.deleted, stats.bytes, stats.failed, stats.remainingBytes], [6, 3, 300, 0, 200]);
  assert.deepEqual(await Promise.all(files.map(exists)), [false, false, false, true, true], '从最旧的开始删除');
  assert.equal(await exists(foreign), true, '不符合缓存命名的文件不计入也不删除');
  assert.equal(result.deleted, 3);
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

test('stale .tmp files are removed everywhere, recent ones stay, and formal data is never touched', async t => {
  const { directory } = await setup(t);
  const id = hex(9);
  const ancient = 365 * DAY;
  const formal = [
    'index.json', 'usage.json', 'knowledge.json', 'connection.json', 'index-v1-backup-1-abc.json', 'index.json.tmp.bak', 'tmp',
    `images/${id}.png`, `images/${id}.jpeg`, `thumbnails/${id}.jpeg`, `insertion/${id}.png`,
    'clients/0f8fad5b-d9cb-469f-a165-70867728950e.json', 'images/子目录/旧的.tmp',
  ];
  const formalFiles = [];
  for (const name of formal) formalFiles.push(await put(path.join(directory, ...name.split('/')), 64, ancient));
  const formalBytes = await Promise.all(formalFiles.map(file => readFile(file)));
  const locations = ['.', 'images', 'thumbnails', 'insertion', 'clients', 'fitted', 'placeholders', 'lan-cache', 'insertion-quality', 'insertion-quality/v2-sharp-0.35.5'];
  const stale = [];
  const recent = [];
  for (const [index, location] of locations.entries()) {
    const folder = path.join(directory, ...location.split('/'));
    stale.push(await put(path.join(folder, `index-${hex(index)}.tmp`), 10, 61 * MINUTE));
    recent.push(await put(path.join(folder, `usage.json.${hex(index)}.tmp`), 10, 59 * MINUTE));
  }
  // 缓存上限为 0：即使最严格的上限，正式数据也一个都不删。
  const { instance, logs } = pruner(directory, { maxBytes: 0 });
  const result = await instance.run();
  assert.equal(result.failed, 0);
  assert.deepEqual(await Promise.all(stale.map(exists)), stale.map(() => false), '超过 1 小时的 .tmp 全部删除');
  assert.deepEqual(await Promise.all(recent.map(exists)), recent.map(() => true), '1 小时内的 .tmp 保留');
  assert.deepEqual(await Promise.all(formalFiles.map(exists)), formalFiles.map(() => true), '正式数据文件全部保留');
  assert.deepEqual(await Promise.all(formalFiles.map(file => readFile(file))), formalBytes);
  assert.equal(result.deleted, stale.length);
  assert.equal(result.bytes, stale.length * 10);
  assert.equal(entry(result, '.').deleted, 1);
  assert.equal(entry(result, 'insertion-quality').deleted, 2, '版本子目录中的 .tmp 也清理');
  assert.equal(logs.length, 1);
  for (const folder of ['images', 'thumbnails', 'insertion', 'clients']) {
    assert.ok((await readdir(path.join(directory, folder))).length > 0);
  }
});

test('a cache directory that is a symbolic link is skipped with a warning', async t => {
  const { root, directory } = await setup(t);
  const outside = path.join(root, 'outside');
  const outsideFile = await put(path.join(outside, `${hex(1)}.png`), 100, 30 * DAY);
  const outsideTemporary = await put(path.join(outside, 'old.tmp'), 10, 30 * DAY);
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
  const temporaryLink = path.join(directory, 'clients', 'old.tmp');
  if (!(await trySymlink(t, target, cacheLink, 'file'))) return;
  if (!(await trySymlink(t, target, temporaryLink, 'file'))) return;
  const result = await pruner(directory, { maxBytes: 0, temporaryAgeMs: 0, protectMs: 0 }).instance.run();
  assert.equal(result.deleted, 0);
  assert.equal(entry(result, 'lan-cache').checked, 0);
  assert.equal(await exists(target), true);
  assert.ok((await readdir(path.join(directory, 'lan-cache'))).includes(`${hex(1)}.png`));
  assert.ok((await readdir(path.join(directory, 'clients'))).includes('old.tmp'));
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
  const lockedTemporary = await put(path.join(directory, 'images', 'locked.tmp'), 10, 2 * DAY);
  const staleTemporary = await put(path.join(directory, 'images', 'stale.tmp'), 10, 2 * DAY);
  const locked = new Set([files[0], lockedTemporary]);
  const remove = async filename => {
    if (locked.has(filename)) throw Object.assign(new Error('文件被占用'), { code: process.platform === 'win32' ? 'EBUSY' : 'EPERM' });
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
  assert.deepEqual([stats.checked, stats.deleted, stats.remainingBytes], [4, 2, 100]);
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
