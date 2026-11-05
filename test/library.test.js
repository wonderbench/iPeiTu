import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Library, MAX_IMAGE_BYTES } from '../server/library.js';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'library');
  const library = await Library.open(directory);
  return { root, directory, library };
}

function image(color = '#147d70', format = 'png') {
  return sharp({ create: { width: 640, height: 360, channels: 3, background: color } }).toFormat(format).toBuffer();
}

test('imports originals and thumbnails, persists metadata, and searches Chinese names and duplicate aliases', async t => {
  const { directory, library } = await setup(t);
  const bytes = await image();
  assert.deepEqual(await library.importFile('沟槽开挖.PNG', bytes), { imported: 1, duplicates: 0, failed: [], total: 1 });
  assert.deepEqual(await library.importFile('现场 Excavation.png', bytes), { imported: 0, duplicates: 1, failed: [], total: 1 });
  const reopened = await Library.open(directory);
  const { assets, total } = reopened.list('  沟槽 ');
  assert.equal(total, 1);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].width, 640);
  assert.equal(assets[0].height, 360);
  assert.equal(assets[0].bytes, bytes.length);
  assert.deepEqual(assets[0].aliases, ['现场 Excavation.png']);
  assert.equal(reopened.list('EXCAVATION').assets.length, 1);
  assert.equal(reopened.list('missing').assets.length, 0);
  assert.deepEqual(await readFile((await reopened.file(assets[0].id, 'image')).path), bytes);
  const thumb = await sharp((await reopened.file(assets[0].id, 'thumbnail')).path).metadata();
  assert.equal(thumb.width, 384);
  assert.equal(thumb.height, 216);
  assert.equal(thumb.format, 'jpeg');
  assert.ok(path.isAbsolute((await reopened.insertion(assets[0].id)).path));
});

test('recursive directory import reports broken images, skips unrelated files, and leaves source intact', async t => {
  const { root, library } = await setup(t);
  const source = path.join(root, '素材目录');
  await mkdir(path.join(source, '子目录'), { recursive: true });
  const bytes = await image();
  await writeFile(path.join(source, '沟槽.png'), bytes);
  await writeFile(path.join(source, '子目录', '别名.png'), bytes);
  await writeFile(path.join(source, '损坏.jpeg'), 'not an image');
  await writeFile(path.join(source, '说明.txt'), 'ignored');
  const result = await library.importDirectory(source);
  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, '损坏.jpeg');
  assert.equal(result.total, 1);
  assert.deepEqual(await readFile(path.join(source, '沟槽.png')), bytes);
  assert.equal((await library.importDirectory(source)).duplicates, 2);
});

test('queued concurrent imports keep every distinct asset and duplicate alias after reopening', async t => {
  const { directory, library } = await setup(t);
  const red = await image('#ff0000');
  const blue = await image('#0000ff');
  await Promise.all([library.importFile('红.png', red), library.importFile('蓝.png', blue), library.importFile('红色别名.png', red)]);
  const reopened = await Library.open(directory);
  assert.equal(reopened.list().total, 2);
  assert.equal(reopened.list('别名').assets.length, 1);
});

test('rejects corrupt and unsupported images, oversized files, and invalid names without adding records', async t => {
  const { library } = await setup(t);
  assert.equal((await library.importFile('损坏.png', Buffer.from('broken'))).failed.length, 1);
  assert.match((await library.importFile('绘图.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'))).failed[0].error, /仅支持/);
  assert.match((await library.importFile('large.png', Buffer.alloc(MAX_IMAGE_BYTES + 1))).failed[0].error, /32 MB/);
  for (const name of ['../', 'folder/', '   /   ']) {
    assert.equal((await library.importFile(name, await image())).failed.length, 1);
  }
  assert.equal(library.list().total, 0);
  await assert.rejects(library.importDirectory('relative'), /完整本地路径/);
});

test('WebP retains its original and provides a PNG insertion file', async t => {
  const { library } = await setup(t);
  const bytes = await image('#00aa66', 'webp');
  await library.importFile('现场.webp', bytes);
  const asset = library.list().assets[0];
  assert.equal(asset.format, 'webp');
  assert.deepEqual(await readFile((await library.file(asset.id, 'image')).path), bytes);
  const insertion = await library.insertion(asset.id);
  assert.equal((await sharp(insertion.path).metadata()).format, 'png');
});

test('EXIF-oriented JPEG retains its original but inserts an upright PNG with matching dimensions', async t => {
  const { library, directory } = await setup(t);
  const bytes = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#336655' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  await library.importFile('竖向照片.jpeg', bytes);
  const reopened = await Library.open(directory);
  const asset = reopened.list().assets[0];
  assert.equal(asset.width, 360);
  assert.equal(asset.height, 640);
  assert.deepEqual(await readFile((await reopened.file(asset.id, 'image')).path), bytes);
  const insertion = await reopened.insertion(asset.id);
  const normalized = await sharp(insertion.path).metadata();
  assert.equal(normalized.format, 'png');
  assert.equal(normalized.width, insertion.width);
  assert.equal(normalized.height, insertion.height);
  assert.ok(normalized.orientation === undefined || normalized.orientation === 1);
});

test('transparent black line art has a white thumbnail background while original and insertion keep transparency', async t => {
  const { library } = await setup(t);
  const pixels = Buffer.alloc(20 * 20 * 4);
  for (let y = 0; y < 20; y++) {
    for (let x = 8; x < 12; x++) pixels[(y * 20 + x) * 4 + 3] = 255;
  }
  const bytes = await sharp(pixels, { raw: { width: 20, height: 20, channels: 4 } }).png().toBuffer();
  await library.importFile('透明线稿.png', bytes);
  const asset = library.list().assets[0];
  const thumbnail = await sharp((await library.file(asset.id, 'thumbnail')).path).raw().toBuffer();
  assert.ok(Math.min(...thumbnail) < 20, 'black drawing remains visible');
  assert.ok(Math.max(...thumbnail) > 235, 'transparent background becomes white');
  const original = (await library.file(asset.id, 'image')).path;
  const insertion = (await library.insertion(asset.id)).path;
  assert.deepEqual(await readFile(original), bytes);
  assert.deepEqual(await readFile(insertion), bytes);
  assert.equal((await sharp(insertion).metadata()).hasAlpha, true);
});

test('missing managed image reports an actionable error and reimport repairs it', async t => {
  const { library } = await setup(t);
  const bytes = await image();
  await library.importFile('图片.png', bytes);
  const asset = library.list().assets[0];
  await unlink((await library.file(asset.id, 'image')).path);
  await assert.rejects(library.insertion(asset.id), /已丢失/);
  assert.equal((await library.importFile('图片.png', bytes)).duplicates, 1);
  assert.deepEqual(await readFile((await library.insertion(asset.id)).path), bytes);
  await assert.rejects(library.insertion('../index'), /找不到/);
});

test('damaged index fails explicitly and is never reset to an empty library', async t => {
  const { directory } = await setup(t);
  for (const content of ['{bad json', 'null', '{"version":1,"assets":[{"id":"../../secret"}]}']) {
    await writeFile(path.join(directory, 'index.json'), content);
    await assert.rejects(Library.open(directory), /索引/);
    assert.equal(await readFile(path.join(directory, 'index.json'), 'utf8'), content);
  }
});

test('does not follow directory junctions or import a parent containing its own library', async t => {
  const { root, directory, library } = await setup(t);
  await assert.rejects(library.importDirectory(root), /不能包含/);
  const source = path.join(root, 'source');
  const outside = path.join(root, 'outside');
  await mkdir(source);
  await mkdir(outside);
  await writeFile(path.join(outside, '外部.png'), await image());
  await symlink(outside, path.join(source, '链接'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await library.importDirectory(source)).total, 0);
  await assert.rejects(library.importDirectory(path.join(source, '链接')), /符号链接/);
  assert.ok(directory);
});

test('rejects managed descendants and filesystem aliases of an overlapping source directory', async t => {
  const { root, directory, library } = await setup(t);
  await library.importFile('工程图.png', await image());
  await assert.rejects(library.importDirectory(path.join(directory, 'thumbnails')), /图库内/);
  if (process.platform === 'win32') {
    await assert.rejects(library.importDirectory(root.toUpperCase()), /不能包含/);
    await assert.rejects(library.importDirectory(path.join(directory, 'images').toUpperCase()), /图库内/);
  }
  const aliasParent = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-alias-'));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  await symlink(root, path.join(aliasParent, 'linked-root'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(library.importDirectory(path.join(aliasParent, 'linked-root', path.basename(directory))), /不能包含/);
  await assert.rejects(library.importDirectory(path.join(aliasParent, 'linked-root', path.basename(directory), 'images')), /图库内/);
  assert.equal(library.list().total, 1);
});
