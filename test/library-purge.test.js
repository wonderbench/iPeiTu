import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Library } from '../server/library.js';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-purge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'library');
  const library = await Library.open(directory);
  return { root, directory, library };
}

function image(color, format = 'png') {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).toFormat(format).toBuffer();
}

async function add(library, name, color, format = 'png') {
  const bytes = await image(color, format);
  assert.equal((await library.importFile(name, bytes)).imported, 1);
  return { id: library.assets.at(-1).id, bytes };
}

// 受管文件：原图、缩略图，以及 WebP 或 EXIF 旋转素材的 PNG 插入副本。
function managedFiles(directory, asset) {
  const files = [path.join(directory, 'images', `${asset.id}.${asset.format}`), path.join(directory, 'thumbnails', `${asset.id}.jpeg`)];
  if (asset.normalized || asset.format === 'webp') files.push(path.join(directory, 'insertion', `${asset.id}.png`));
  return files;
}

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const readIndex = async directory => JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8'));

// 让原图位置变成非空目录：unlink 在 Linux 上得到 EISDIR、在 Windows 上得到 EPERM，都不是 ENOENT，清理因此失败。
async function blockImage(directory, id, format = 'png') {
  const target = path.join(directory, 'images', `${id}.${format}`);
  await unlink(target);
  await mkdir(target);
  await writeFile(path.join(target, '占位.txt'), 'x');
  return target;
}

test('batch trash validates every image before one write, skips trashed images and stops at an edit lock', async t => {
  const { directory, library } = await setup(t);
  const { id: first } = await add(library, '甲.png', '#111111');
  const { id: second } = await add(library, '乙.png', '#222222');
  const { id: third } = await add(library, '丙.png', '#333333');
  await library.setTrash(second, { trashed: true });
  const secondDeletedAt = library.getAsset(second, { includeDeleted: true }).deletedAt;
  const indexPath = path.join(directory, 'index.json');
  const before = await readFile(indexPath);
  const tooMany = Array.from({ length: 1001 }, (_, index) => String(index));
  for (const input of [null, [], {}, { ids: [] }, { ids: [first, first] }, { ids: [first], extra: 1 }, { ids: [1] }, { ids: first }, { ids: tooMany }]) {
    await assert.rejects(library.trashAssets(input), { status: 400 }, JSON.stringify(input)?.slice(0, 60));
  }
  await assert.rejects(library.trashAssets({ ids: [first, 'f'.repeat(64)] }), { status: 404 });
  assert.deepEqual(await readFile(indexPath), before, '有一张不存在时整批不写入');
  assert.equal(library.getAsset(first).deletedAt, null);

  const { token } = await library.acquireEditLock(third, {});
  await assert.rejects(library.trashAssets({ ids: [first, third] }), { status: 423, message: /正在编辑/ });
  assert.deepEqual(await readFile(indexPath), before, '遇到编辑锁整批停止');
  assert.equal(library.getAsset(first).deletedAt, null, '未锁定的图片也不移出');
  await library.changeEditLock(third, { token, release: true });

  assert.deepEqual(await library.trashAssets({ ids: [first, second, third] }), { trashed: 3 });
  assert.equal(library.activeTotal, 0);
  assert.equal(library.getAsset(second, { includeDeleted: true }).deletedAt, secondDeletedAt, '已在回收站的不重复处理');
  const firstDeletedAt = library.getAsset(first, { includeDeleted: true }).deletedAt;
  assert.equal(new Date(firstDeletedAt).toISOString(), firstDeletedAt);
  assert.equal(library.getAsset(third, { includeDeleted: true }).deletedAt, firstDeletedAt, '同一批使用同一个移出时间');
  const trashed = await readFile(indexPath);
  assert.deepEqual(await library.trashAssets({ ids: [first, second] }), { trashed: 2 });
  assert.deepEqual(await readFile(indexPath), trashed, '全部已在回收站时不写索引');
  const reopened = await Library.open(directory);
  assert.equal(reopened.activeTotal, 0);
  assert.equal(reopened.list('', { view: 'trash' }).viewTotal, 3);
});

test('permanent delete accepts only trashed images and removes records, managed files, favorites and every client record', async t => {
  const { directory, library } = await setup(t);
  const { id: keep } = await add(library, '保留.png', '#445566');
  const { id: target } = await add(library, '删除.webp', '#00aa66', 'webp');
  const targetAsset = library.getAsset(target);
  const files = managedFiles(directory, targetAsset);
  assert.equal(files.length, 3, 'WebP 有插入副本');
  const client = randomUUID();
  await library.setFavorite(target, { favorite: true });
  await library.recordRecent(target, {});
  await library.setFavorite(keep, { favorite: true });
  await library.setFavorite(target, { favorite: true }, client);
  await library.recordRecent(target, {}, client);
  await library.recordRecent(keep, {}, client);

  await assert.rejects(library.purgeAssets({ ids: [target] }), { status: 409, message: /回收站中的素材/ });
  await library.setTrash(target, { trashed: true });
  await assert.rejects(library.purgeAssets({ ids: [target, keep] }), { status: 409 }, '混有未移出的图片时整批拒绝');
  for (const input of [null, [], {}, { ids: [] }, { ids: [target], all: true }, { all: true }, { all: true, revision: 'x' },
    { all: 'yes', revision: 'a'.repeat(64) }, { ids: [target, target] }]) {
    await assert.rejects(library.purgeAssets(input), { status: 400 }, JSON.stringify(input));
  }
  await assert.rejects(library.purgeAssets({ ids: ['f'.repeat(64)] }), { status: 404 });
  assert.equal(library.getAsset(target, { includeDeleted: true }).id, target);
  for (const file of files) assert.equal(await exists(file), true, '拒绝时不删除文件');

  assert.deepEqual(await library.purgeAssets({ ids: [target] }), { purged: 1, cleanupPending: false });
  await assert.rejects(async () => library.getAsset(target, { includeDeleted: true }), { status: 404 });
  for (const file of files) assert.equal(await exists(file), false, `${path.basename(path.dirname(file))} 已清理`);
  for (const file of managedFiles(directory, library.getAsset(keep))) assert.equal(await exists(file), true, '其他素材不受影响');
  const index = await readIndex(directory);
  assert.deepEqual(index.assets.map(asset => asset.id), [keep]);
  assert.equal(Object.hasOwn(index, 'pendingPurge'), false, '清理完成后不保留待清理记录');
  const usage = JSON.parse(await readFile(path.join(directory, 'usage.json'), 'utf8'));
  assert.deepEqual(usage.favorites, [keep]);
  assert.deepEqual(usage.recent, []);
  const clientUsage = JSON.parse(await readFile(path.join(directory, 'clients', `${client}.json`), 'utf8'));
  assert.deepEqual(clientUsage.favorites, []);
  assert.deepEqual(clientUsage.recent.map(entry => entry.id), [keep]);

  const reopened = await Library.open(directory);
  assert.deepEqual(reopened.assets.map(asset => asset.id), [keep]);
  assert.deepEqual((await reopened.usageFor(client)).recent.map(entry => entry.id), [keep]);
});

test('clearing the trash requires the current revision and reports 409 when the trash changed meanwhile', async t => {
  const { directory, library } = await setup(t);
  const { id: first } = await add(library, '甲.png', '#aa1111');
  const { id: second } = await add(library, '乙.png', '#11aa11');
  await library.setTrash(first, { trashed: true });
  const { trashRevision } = library.list('', { view: 'trash' });
  assert.match(trashRevision, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(library.list(), 'trashRevision'), false, '只有回收站视图返回版本');
  assert.equal(library.list('不匹配', { view: 'trash' }).trashRevision, trashRevision, '版本按整个回收站计算，不受检索影响');
  assert.notEqual((await Library.open(directory)).list('', { view: 'trash' }).trashRevision, trashRevision, '服务重启后旧版本失效');

  await library.setTrash(second, { trashed: true });
  await assert.rejects(library.purgeAssets({ all: true, revision: trashRevision }), { status: 409, message: /已变化/ });
  assert.equal(library.assets.length, 2);
  const current = library.list('', { view: 'trash' }).trashRevision;
  assert.notEqual(current, trashRevision);
  await library.setTrash(second, { trashed: false });
  await assert.rejects(library.purgeAssets({ all: true, revision: current }), { status: 409 }, '恢复一张后版本也变化');
  await library.setTrash(second, { trashed: true });
  const latest = library.list('', { view: 'trash' }).trashRevision;
  assert.deepEqual(await library.purgeAssets({ all: true, revision: latest }), { purged: 2, cleanupPending: false });
  assert.deepEqual(library.assets, []);
  const empty = library.list('', { view: 'trash' }).trashRevision;
  assert.deepEqual(await library.purgeAssets({ all: true, revision: empty }), { purged: 0, cleanupPending: false });
  assert.deepEqual((await readIndex(directory)).assets, []);
});

test('a failed cleanup keeps the pending record from the same index write and finishes after reopening', async t => {
  const { directory, library } = await setup(t);
  const { id: keep } = await add(library, '保留.png', '#123123');
  const { id: target } = await add(library, '删除.png', '#321321');
  const client = randomUUID();
  await library.setFavorite(target, { favorite: true });
  await library.setFavorite(target, { favorite: true }, client);
  await library.setTrash(target, { trashed: true });
  const blocked = await blockImage(directory, target);
  const errors = t.mock.method(console, 'error', () => {});

  assert.deepEqual(await library.purgeAssets({ ids: [target] }), { purged: 1, cleanupPending: true });
  assert.ok(errors.mock.calls.length >= 1, '清理失败被明确记录');
  const index = await readIndex(directory);
  assert.deepEqual(index.assets.map(asset => asset.id), [keep], '记录已在同一次写入中移除');
  assert.deepEqual(index.pendingPurge, [{ id: target, format: 'png' }]);
  assert.deepEqual(library.pendingPurge, [{ id: target, format: 'png' }]);
  assert.equal(await exists(path.join(directory, 'thumbnails', `${target}.jpeg`)), true, '原图清理失败时停在第一步');
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'usage.json'), 'utf8')).favorites, [target], '收藏留到清理完成时再移除');

  const stillBlocked = await Library.open(directory);
  assert.deepEqual(stillBlocked.pendingPurge, [{ id: target, format: 'png' }], '重启后仍保留登记');
  assert.deepEqual((await readIndex(directory)).pendingPurge, [{ id: target, format: 'png' }]);
  assert.deepEqual(stillBlocked.list().assets.map(asset => asset.id), [keep]);
  assert.equal(stillBlocked.list().assets[0].favorite, false);

  await rm(blocked, { recursive: true });
  const finished = await Library.open(directory);
  assert.deepEqual(finished.pendingPurge, []);
  assert.equal(Object.hasOwn(await readIndex(directory), 'pendingPurge'), false);
  assert.equal(await exists(path.join(directory, 'thumbnails', `${target}.jpeg`)), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'usage.json'), 'utf8')).favorites, []);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'clients', `${client}.json`), 'utf8')).favorites, []);
});

test('reimporting an image that waits for cleanup finishes the cleanup first, or reports it while cleanup still fails', async t => {
  const { directory, library } = await setup(t);
  const { id: target, bytes } = await add(library, '原名.png', '#654321');
  await library.updateAsset(target, { aliases: ['旧别名'], tags: ['旧标签'] });
  await library.setFavorite(target, { favorite: true });
  await library.setTrash(target, { trashed: true });
  const blocked = await blockImage(directory, target);
  t.mock.method(console, 'error', () => {});
  assert.equal((await library.purgeAssets({ ids: [target] })).cleanupPending, true);

  const refused = await library.importFile('新名称.png', bytes);
  assert.equal(refused.imported, 0);
  assert.equal(refused.failed.length, 1);
  assert.match(refused.failed[0].error, /等待永久删除后的清理/);
  assert.equal(library.assets.length, 0, '清理失败时不导入');

  await rm(blocked, { recursive: true });
  assert.deepEqual(await library.importFile('新名称.png', bytes), { imported: 1, duplicates: 0, restored: 0, failed: [], total: 1 });
  assert.deepEqual(library.pendingPurge, []);
  const asset = library.getAsset(target);
  assert.equal(asset.name, '新名称.png', '按新图片导入，不沿用已删除的信息');
  assert.deepEqual([asset.aliases, asset.tags], [[], []]);
  assert.equal(library.list().assets[0].favorite, false, '已删除图片的收藏不会复活');
  assert.deepEqual(await readFile(path.join(directory, 'images', `${target}.png`)), bytes);
  assert.equal(await exists(path.join(directory, 'thumbnails', `${target}.jpeg`)), true);
  assert.equal(Object.hasOwn(await readIndex(directory), 'pendingPurge'), false);
});

test('a failed index write during permanent delete changes nothing and leaves no temporary file', async t => {
  const { directory, library } = await setup(t);
  const { id } = await add(library, '图片.png', '#777777');
  await library.setTrash(id, { trashed: true });
  const asset = library.getAsset(id, { includeDeleted: true });
  const indexPath = path.join(directory, 'index.json');
  const original = await readFile(indexPath);
  await unlink(indexPath);
  // 目标是非空目录时，Linux 与 Windows 上的重命名都会失败。
  await mkdir(indexPath);
  await writeFile(path.join(indexPath, '占位.txt'), 'x');
  await assert.rejects(library.purgeAssets({ ids: [id] }));
  assert.deepEqual(library.pendingPurge, []);
  assert.equal(library.getAsset(id, { includeDeleted: true }).id, id);
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
  for (const file of managedFiles(directory, asset)) assert.equal(await exists(file), true);
  await rm(indexPath, { recursive: true });
  await writeFile(indexPath, original);
  assert.equal((await library.purgeAssets({ ids: [id] })).purged, 1);
});

test('damaged pending cleanup records refuse to open without changing the index', async t => {
  const { directory, library } = await setup(t);
  const { id } = await add(library, '图片.png', '#999999');
  const asset = library.getAsset(id);
  const other = 'e'.repeat(64);
  for (const value of [
    { version: 3, assets: [asset], pendingPurge: 'x' },
    { version: 3, assets: [asset], pendingPurge: [{ id: 'bad', format: 'png' }] },
    { version: 3, assets: [asset], pendingPurge: [{ id: other, format: 'gif' }] },
    { version: 3, assets: [asset], pendingPurge: [{ id: other, format: 'png', extra: true }] },
    { version: 3, assets: [asset], pendingPurge: [{ id, format: 'png' }] },
    { version: 3, assets: [asset], pendingPurge: [{ id: other, format: 'png' }, { id: other, format: 'png' }] },
    { version: 2, assets: [{ ...asset, deletedAt: undefined }], pendingPurge: [{ id: other, format: 'png' }] },
  ]) {
    const original = JSON.stringify(value);
    await writeFile(path.join(directory, 'index.json'), original);
    await assert.rejects(Library.open(directory), { status: 500, message: /待清理记录损坏/ }, original.slice(0, 80));
    assert.equal(await readFile(path.join(directory, 'index.json'), 'utf8'), original);
  }
});
