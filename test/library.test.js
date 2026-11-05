import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink, readdir, rename, realpath } from 'node:fs/promises';
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

test('v1 migration keeps exact backup bytes, asset identities and historical metadata, and runs once', async t => {
  const { directory, library } = await setup(t);
  const bytes = await image();
  await library.importFile('旧图片.png', bytes);
  const { categories, tags, ...legacy } = library.assets[0];
  // v0.1 did not cap historical alias counts; migration must never truncate them.
  legacy.aliases = Array.from({ length: 101 }, (_, index) => `历史别名_${index}.png`);
  const original = Buffer.from(` \r\n${JSON.stringify({ version: 1, assets: [legacy] }, null, 3)}\r\n`, 'utf8');
  await writeFile(path.join(directory, 'index.json'), original);
  const migrated = await Library.open(directory);
  const backups = (await readdir(directory)).filter(name => name.startsWith('index-v1-backup-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await readFile(path.join(directory, backups[0])), original);
  assert.deepEqual(migrated.assets, [{ ...legacy, categories: [], tags: [] }]);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')).version, 2);
  assert.deepEqual(await readFile((await migrated.file(legacy.id, 'image')).path), bytes);
  await Library.open(directory);
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('index-v1-backup-')), backups);
});

test('unknown versions and invalid v2 metadata do not modify or back up the index', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('工程图.png', await image());
  const asset = library.assets[0];
  for (const value of [
    { version: 3, assets: [asset] },
    { version: 2, assets: [{ ...asset, categories: '土建' }] },
    { version: 2, assets: [{ ...asset, tags: [null] }] },
    { version: 2, assets: [{ ...asset, categories: Array(33).fill('分类') }] },
  ]) {
    const original = JSON.stringify(value);
    await writeFile(path.join(directory, 'index.json'), original);
    await assert.rejects(Library.open(directory), /索引/);
    assert.equal(await readFile(path.join(directory, 'index.json'), 'utf8'), original);
    assert.equal((await readdir(directory)).some(name => name.startsWith('index-v1-backup-')), false);
  }
});

test('a failed migration preserves the original v1 bytes and their backup for retry', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('旧图片.png', await image());
  const { categories, tags, ...legacy } = library.assets[0];
  const original = Buffer.from(JSON.stringify({ version: 1, assets: [legacy] }));
  await writeFile(path.join(directory, 'index.json'), original);
  const failure = t.mock.method(Library.prototype, 'persist', async () => {
    throw Object.assign(new Error('migration write refused'), { code: 'EACCES' });
  });
  await assert.rejects(Library.open(directory), { code: 'EACCES' });
  assert.deepEqual(await readFile(path.join(directory, 'index.json')), original);
  const backups = (await readdir(directory)).filter(name => name.startsWith('index-v1-backup-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await readFile(path.join(directory, backups[0])), original);
  failure.mock.restore();
  const migrated = await Library.open(directory);
  assert.deepEqual(migrated.assets, [{ ...legacy, categories: [], tags: [] }]);
});

test('metadata edits normalize lists, preserve commas, and do not rename managed image files', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('原图.png', await image());
  const id = library.assets[0].id;
  const insertionPath = (await library.insertion(id)).path;
  const edited = await library.updateAsset(id, {
    name: ' 新图片名称 ', aliases: [' 原名 ', '原名', 'Alias', 'ａｌｉａｓ'],
    categories: [' 土建/基础 ', '土建/基础', 'ＡBC', 'abc'], tags: ['沟槽，开挖', '沟槽，开挖', ' NIGHT ', 'night'],
  });
  assert.equal(edited.name, '新图片名称');
  assert.deepEqual(edited.aliases, ['原名', 'Alias']);
  assert.deepEqual(edited.categories, ['土建/基础', 'ＡBC']);
  assert.deepEqual(edited.tags, ['沟槽，开挖', 'NIGHT']);
  assert.match(edited.imageUrl, new RegExp(id));
  assert.match(edited.thumbnailUrl, new RegExp(id));
  const reopened = await Library.open(directory);
  assert.equal((await reopened.insertion(id)).path, insertionPath);
  assert.equal(reopened.list('原名 NIGHT').assets[0].id, id);
  await reopened.updateAsset(id, { categories: [], tags: [], aliases: [] });
  const empty = (await Library.open(directory)).getAsset(id);
  assert.equal(empty.name, '新图片名称');
  assert.deepEqual([empty.aliases, empty.categories, empty.tags], [[], [], []]);
});

test('invalid metadata patches reject as a whole and preserve the index and in-memory record', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('原名.png', await image());
  const id = library.assets[0].id;
  const snapshot = await readFile(path.join(directory, 'index.json'));
  const invalid = [null, [], 'name', {}, { path: 'C:\\secret' }, { id }, { name: '' }, { name: false },
    { name: 'x'.repeat(256) }, { name: '换\n行' }, { name: '修改名', tags: [null] },
    { aliases: '不是数组' }, { aliases: [''] }, { aliases: Array(101).fill('同名') },
    { aliases: ['x'.repeat(256)] }, { categories: Array(33).fill('分类') },
    { categories: ['x'.repeat(256)] }, { tags: Array(65).fill('标签') }, { tags: ['x'.repeat(65)] },
    { tags: ['标签\u2028另一项'] }, JSON.parse('{"__proto__":{}}')];
  for (const patch of invalid) await assert.rejects(library.updateAsset(id, patch), error => error.status === 400);
  assert.equal(library.getAsset(id).name, '原名.png');
  assert.deepEqual(await readFile(path.join(directory, 'index.json')), snapshot);
  await assert.rejects(library.updateAsset('f'.repeat(64), { name: '不存在' }), error => error.status === 404);
});

test('metadata field boundaries are accepted without dropping entries', async t => {
  const { library } = await setup(t);
  await library.importFile('边界.png', await image());
  const metadata = {
    name: '图'.repeat(255),
    aliases: Array.from({ length: 100 }, (_, index) => String(index).padStart(3, '0') + '别'.repeat(252)),
    categories: Array.from({ length: 32 }, (_, index) => String(index).padStart(2, '0') + '类'.repeat(253)),
    tags: Array.from({ length: 64 }, (_, index) => String(index).padStart(2, '0') + '签'.repeat(62)),
  };
  const updated = await library.updateAsset(library.assets[0].id, metadata);
  for (const field of Object.keys(metadata)) assert.deepEqual(updated[field], metadata[field]);
});

test('query terms, exact categories and AND tags intersect while facets describe the entire library', async t => {
  const { library } = await setup(t);
  for (const [name, color] of [['沟槽开挖.png', 'red'], ['基础回填.png', 'green'], ['未分类.png', 'blue']]) {
    await library.importFile(name, await image(color));
  }
  const [first, second, third] = library.assets;
  await library.updateAsset(first.id, { aliases: ['Excavation'], categories: ['土建/基础'], tags: ['夜间', '支护', 'NIGHT'] });
  await library.updateAsset(second.id, { aliases: ['EXCAVATION'], categories: ['土建'], tags: ['夜间', '回填', 'night'] });
  assert.deepEqual(library.list('  ｅｘｃａｖａｔｉｏｎ\t支护 ').assets.map(asset => asset.id), [first.id]);
  assert.deepEqual(library.list('', { category: '土建' }).assets.map(asset => asset.id), [second.id]);
  assert.deepEqual(library.list('excavation', { category: '土建/基础', tags: ['night', '支护'] }).assets.map(asset => asset.id), [first.id]);
  assert.equal(library.list('', { tags: ['支护', '回填'] }).assets.length, 0);
  assert.deepEqual(library.list('', { uncategorized: true }).assets.map(asset => asset.id), [third.id]);
  assert.equal(library.list('土建').assets.length, 0, '分类使用独立精确筛选，不暗中加入关键词范围');
  const full = library.list();
  assert.equal(full.total, 3);
  assert.equal(full.facets.uncategorized, 1);
  assert.equal(full.facets.tags.find(tag => tag.name === 'NIGHT').count, 2);
  assert.deepEqual(library.list('不匹配', { category: '土建' }).facets, full.facets);
  assert.throws(() => library.list('', { category: '土建', uncategorized: true }), /不能同时/);
  assert.throws(() => library.list('x'.repeat(513)), /512/);
});

test('directory categories retain nested folders and merge duplicate provenance without overriding edits', async t => {
  const { root, directory, library } = await setup(t);
  const source = path.join(root, '工程素材');
  await mkdir(path.join(source, '土建', '基础'), { recursive: true });
  await mkdir(path.join(source, '机电'), { recursive: true });
  const bytes = await image();
  await writeFile(path.join(source, '根图.png'), bytes);
  await writeFile(path.join(source, '土建', '基础', '基础图.png'), bytes);
  await writeFile(path.join(source, '机电', '机电图.png'), bytes);
  assert.deepEqual(await library.importDirectory(source), { imported: 1, duplicates: 2, failed: [], total: 1 });
  const id = library.assets[0].id;
  assert.deepEqual(new Set(library.getAsset(id).categories), new Set(['工程素材', '土建/基础', '机电']));
  await library.updateAsset(id, { name: '人工名称', tags: ['人工标签'], categories: ['手工分类'] });
  assert.equal((await library.importDirectory(source)).duplicates, 3);
  const reopened = await Library.open(directory);
  const asset = reopened.getAsset(id);
  assert.equal(asset.name, '人工名称');
  assert.deepEqual(asset.tags, ['人工标签']);
  assert.deepEqual(new Set(asset.categories), new Set(['手工分类', '工程素材', '土建/基础', '机电']));
  assert.equal(reopened.list('基础图').assets[0].id, id);
  assert.equal(JSON.stringify(asset).includes(root), false, '不得把绝对源目录写入元数据');
});

test('concurrent partial edits and classified imports preserve all unrelated changes', async t => {
  const { directory, library } = await setup(t);
  const bytes = await image();
  await library.importFile('原图.png', bytes);
  const id = library.assets[0].id;
  await Promise.all([
    library.updateAsset(id, { name: '人工新名称' }),
    library.importFile('来源别名.png', bytes, '机电安装'),
    library.updateAsset(id, { tags: ['桥架'] }),
  ]);
  const asset = (await Library.open(directory)).getAsset(id);
  assert.equal(asset.name, '人工新名称');
  assert.deepEqual(asset.aliases, ['来源别名.png']);
  assert.deepEqual(asset.categories, ['机电安装']);
  assert.deepEqual(asset.tags, ['桥架']);
});

test('a filesystem root without a basename leaves root images uncategorized and retains child categories', async t => {
  const { root, library } = await setup(t);
  const source = path.join(root, 'root-source');
  await mkdir(path.join(source, '子目录'), { recursive: true });
  await writeFile(path.join(source, '根图.png'), await image('red'));
  await writeFile(path.join(source, '子目录', '子图.png'), await image('blue'));
  const canonicalSource = await realpath(source);
  const basename = path.basename;
  // Simulate a drive root using an isolated folder; never scan a user's drive.
  t.mock.method(path, 'basename', (value, suffix) => value === canonicalSource ? '' : basename(value, suffix));
  assert.deepEqual(await library.importDirectory(source), { imported: 2, duplicates: 0, failed: [], total: 2 });
  assert.deepEqual(library.list('根图').assets[0].categories, []);
  assert.deepEqual(library.list('子图').assets[0].categories, ['子目录']);
  assert.equal(library.list().facets.uncategorized, 1);
});

test('a real index replacement failure does not apply edited metadata in memory', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('原名.png', await image());
  const id = library.assets[0].id;
  const indexPath = path.join(directory, 'index.json');
  const savedPath = path.join(directory, 'original-index.json');
  const original = await readFile(indexPath);
  await rename(indexPath, savedPath);
  await mkdir(indexPath);
  try {
    await assert.rejects(library.updateAsset(id, { name: '不应保存', tags: ['不应保存'] }));
    assert.equal(library.getAsset(id).name, '原名.png');
    assert.deepEqual(library.getAsset(id).tags, []);
    assert.deepEqual(await readFile(savedPath), original);
  } finally {
    assert.equal(path.dirname(indexPath), directory);
    await rm(indexPath, { recursive: true });
    await rename(savedPath, indexPath);
  }
  await library.updateAsset(id, { name: '恢复后名称' });
  assert.equal((await Library.open(directory)).getAsset(id).name, '恢复后名称');
});
