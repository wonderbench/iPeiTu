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
  assert.deepEqual(await library.importFile('沟槽开挖.PNG', bytes), { imported: 1, duplicates: 0, restored: 0, failed: [], total: 1 });
  assert.deepEqual(await library.importFile('现场 Excavation.png', bytes), { imported: 0, duplicates: 1, restored: 0, failed: [], total: 1 });
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
  await assert.rejects(library.importDirectory(path.join(aliasParent, 'linked-root', path.basename(directory), 'images')), /图库内|符号链接/);
  assert.equal(library.list().total, 1);
});

test('v1 migration keeps exact backup bytes, asset identities and historical metadata, and runs once', async t => {
  const { directory, library } = await setup(t);
  const bytes = await image();
  await library.importFile('旧图片.png', bytes);
  const { categories, tags, deletedAt, ...legacy } = library.assets[0];
  // v0.1 did not cap historical alias counts; migration must never truncate them.
  legacy.aliases = Array.from({ length: 101 }, (_, index) => `历史别名_${index}.png`);
  const original = Buffer.from(` \r\n${JSON.stringify({ version: 1, assets: [legacy] }, null, 3)}\r\n`, 'utf8');
  await writeFile(path.join(directory, 'index.json'), original);
  const migrated = await Library.open(directory);
  const backups = (await readdir(directory)).filter(name => name.startsWith('index-v1-backup-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await readFile(path.join(directory, backups[0])), original);
  assert.deepEqual(migrated.assets, [{ ...legacy, categories: [], tags: [], deletedAt: null }]);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')).version, 3);
  assert.deepEqual(await readFile((await migrated.file(legacy.id, 'image')).path), bytes);
  await Library.open(directory);
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('index-v1-backup-')), backups);
});

test('unknown versions and invalid v2 metadata do not modify or back up the index', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('工程图.png', await image());
  const asset = library.assets[0];
  for (const value of [
    { version: 4, assets: [asset] },
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
  const { categories, tags, deletedAt, ...legacy } = library.assets[0];
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
  assert.deepEqual(migrated.assets, [{ ...legacy, categories: [], tags: [], deletedAt: null }]);
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
  assert.deepEqual(await library.importDirectory(source), { imported: 1, duplicates: 2, restored: 0, failed: [], total: 1 });
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
  assert.deepEqual(await library.importDirectory(source), { imported: 2, duplicates: 0, restored: 0, failed: [], total: 2 });
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

test('favorites and successful insert records persist separately without changing image metadata', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('原图.png', await image());
  const id = library.assets[0].id;
  const originalIndex = await readFile(path.join(directory, 'index.json'));
  const untouched = library.list().assets[0];
  assert.equal(untouched.favorite, false);
  assert.equal(untouched.lastInsertedAt, null);
  await library.setFavorite(id, { favorite: false });
  assert.equal((await readdir(directory)).includes('usage.json'), false, '幂等取消不创建状态文件');
  const favorite = await library.setFavorite(id, { favorite: true });
  assert.equal(favorite.favorite, true);
  assert.equal(favorite.lastInsertedAt, null);
  const usageBytes = await readFile(path.join(directory, 'usage.json'));
  await library.setFavorite(id, { favorite: true });
  assert.deepEqual(await readFile(path.join(directory, 'usage.json')), usageBytes);
  await library.insertion(id);
  assert.equal(library.list('', { view: 'recent' }).viewTotal, 0, '读取插入路径不能冒充成功插入');
  const inserted = await library.recordRecent(id, {});
  assert.equal(inserted.favorite, true);
  assert.equal(new Date(inserted.lastInsertedAt).toISOString(), inserted.lastInsertedAt);
  assert.deepEqual(await readFile(path.join(directory, 'index.json')), originalIndex);
  const reopened = await Library.open(directory);
  assert.deepEqual(reopened.list().assets[0], inserted);
  const edited = await reopened.updateAsset(id, { name: '新的显示名' });
  assert.equal(edited.favorite, true);
  assert.equal(edited.lastInsertedAt, inserted.lastInsertedAt);
  const record = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')).assets[0];
  assert.equal(Object.hasOwn(record, 'favorite'), false);
  assert.equal(Object.hasOwn(record, 'lastInsertedAt'), false);
  await reopened.setFavorite(id, { favorite: false });
  const final = (await Library.open(directory)).list().assets[0];
  assert.equal(final.favorite, false);
  assert.equal(final.lastInsertedAt, inserted.lastInsertedAt);
});

test('views intersect text and metadata filters while totals and facets retain their defined scope', async t => {
  const { library } = await setup(t);
  for (const [name, color] of [['沟槽开挖.png', 'red'], ['沟槽支护.png', 'green'], ['其他图.png', 'blue']]) {
    await library.importFile(name, await image(color));
  }
  const [first, second, third] = library.assets;
  await library.updateAsset(first.id, { categories: ['土建'], tags: ['夜间', '现场'] });
  await library.updateAsset(second.id, { categories: ['土建'], tags: ['现场'] });
  await library.setFavorite(second.id, { favorite: true });
  await library.setFavorite(first.id, { favorite: true });
  await library.recordRecent(first.id, {});
  await library.recordRecent(third.id, {});
  const facets = library.list().facets;
  const filtered = library.list('沟槽', { view: 'favorites', category: '土建', tags: ['夜间', '现场'] });
  assert.deepEqual(filtered.assets.map(asset => asset.id), [first.id]);
  assert.equal(filtered.total, 3);
  assert.equal(filtered.viewTotal, 2);
  assert.deepEqual(filtered.facets, facets);
  assert.deepEqual(library.list('', { view: 'favorites' }).assets.map(asset => asset.id), [first.id, second.id], '收藏沿用图库顺序');
  assert.deepEqual(library.list('', { view: 'recent' }).assets.map(asset => asset.id), [third.id, first.id]);
  const uncategorized = library.list('', { view: 'recent', uncategorized: true });
  assert.deepEqual(uncategorized.assets.map(asset => asset.id), [third.id]);
  assert.equal(uncategorized.viewTotal, 2);
  assert.deepEqual(uncategorized.facets, facets);
  assert.equal(library.list('不匹配', { view: 'favorites' }).viewTotal, 2);
  assert.equal(library.list().viewTotal, 3);
  for (const view of ['', 'favorite', null, true, []]) assert.throws(() => library.list('', { view }), error => error.status === 400);
});

test('recent records stay unique and stable in one millisecond and survive a backwards clock', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('甲图.png', await image('red'));
  await library.importFile('乙图.png', await image('blue'));
  const [first, second] = library.assets;
  const timestamp = Date.parse('2026-11-05T02:00:00.123Z');
  const clock = t.mock.method(Date, 'now', () => timestamp);
  await library.recordRecent(first.id, {});
  await library.recordRecent(second.id, {});
  await library.recordRecent(first.id, {});
  const reopened = await Library.open(directory);
  assert.deepEqual(reopened.list('', { view: 'recent' }).assets.map(asset => asset.id), [first.id, second.id]);
  assert.ok(reopened.list('', { view: 'recent' }).assets.every(asset => asset.lastInsertedAt === new Date(timestamp).toISOString()));
  clock.mock.mockImplementation(() => timestamp - 1000);
  await reopened.recordRecent(second.id, {});
  const again = await Library.open(directory);
  assert.deepEqual(again.list('', { view: 'recent' }).assets.map(asset => asset.id), [second.id, first.id]);
  assert.equal(again.list('', { view: 'recent' }).assets[0].lastInsertedAt, new Date(timestamp).toISOString());
});

test('recent records retain only the latest 100 distinct images without removing their favorites', async t => {
  const { directory, library } = await setup(t);
  for (let index = 0; index < 102; index++) {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: index, g: 100, b: 200 } } }).png().toBuffer();
    await library.importFile(`图片${index}.png`, bytes);
  }
  const ids = library.assets.map(asset => asset.id);
  await library.setFavorite(ids[0], { favorite: true });
  for (const id of ids) await library.recordRecent(id, {});
  const reopened = await Library.open(directory);
  assert.equal(reopened.list('', { view: 'recent' }).viewTotal, 100);
  assert.deepEqual(reopened.list('', { view: 'recent' }).assets.map(asset => asset.id), ids.slice(2).reverse());
  assert.equal(reopened.list().assets[0].favorite, true);
  assert.equal(reopened.list().assets[0].lastInsertedAt, null, '淘汰最近记录不清除收藏');
  await reopened.recordRecent(ids[50], {});
  assert.equal(reopened.list('', { view: 'recent' }).viewTotal, 100);
  assert.equal(reopened.list('', { view: 'recent' }).assets[0].id, ids[50]);
});

test('invalid usage mutations and unknown images never create personal records', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('合法图.png', await image());
  const id = library.assets[0].id;
  for (const input of [undefined, null, [], {}, { favorite: 1 }, { favorite: 'true' }, { favorite: true, extra: 1 }]) {
    await assert.rejects(library.setFavorite(id, input), error => error.status === 400);
  }
  for (const input of [undefined, null, [], '', { insertedAt: '2026-11-05T00:00:00.000Z' }, { favorite: true }]) {
    await assert.rejects(library.recordRecent(id, input), error => error.status === 400);
  }
  for (const unknown of ['../../outside', 'f'.repeat(64)]) {
    await assert.rejects(library.setFavorite(unknown, { favorite: true }), error => error.status === 404);
    await assert.rejects(library.recordRecent(unknown, {}), error => error.status === 404);
  }
  assert.equal((await readdir(directory)).includes('usage.json'), false);
  assert.equal(library.list('', { view: 'favorites' }).viewTotal, 0);
  assert.equal(library.list('', { view: 'recent' }).viewTotal, 0);
});

test('damaged or unknown usage state fails explicitly without resetting records or migrating v1', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('合法图.png', await image());
  await library.importFile('另一张图.png', await image('blue'));
  const [first, second] = library.assets;
  const normal = { version: 1, favorites: [], recent: [] };
  const entry = { id: first.id, insertedAt: '2026-11-05T02:00:00.000Z' };
  const { categories, tags, deletedAt, ...legacy } = first;
  const originalIndex = Buffer.from(JSON.stringify({ version: 1, assets: [legacy, { ...second, categories: undefined, tags: undefined, deletedAt: undefined }] }));
  await writeFile(path.join(directory, 'index.json'), originalIndex);
  const invalid = ['{broken', null, [], { ...normal, version: 2 }, { ...normal, extra: true },
    { ...normal, favorites: [first.id, first.id] }, { ...normal, favorites: ['f'.repeat(64)] },
    { ...normal, favorites: {} }, { ...normal, recent: [entry, entry] },
    { ...normal, recent: [{ ...entry, id: 'f'.repeat(64) }] }, { ...normal, recent: [{ ...entry, insertedAt: 'bad-time' }] },
    { ...normal, recent: [{ ...entry, insertedAt: '2026-11-05' }] }, { ...normal, recent: [{ ...entry, other: true }] },
    { ...normal, recent: [entry, { id: second.id, insertedAt: '2026-11-05T02:00:01.000Z' }] },
    { ...normal, recent: Array(101).fill(entry) }];
  for (const value of invalid) {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    await writeFile(path.join(directory, 'usage.json'), bytes);
    await assert.rejects(Library.open(directory), error => error.status === 500 && /usage.json/.test(error.message));
    assert.deepEqual(await readFile(path.join(directory, 'usage.json')), bytes);
    assert.deepEqual(await readFile(path.join(directory, 'index.json')), originalIndex);
    assert.equal((await readdir(directory)).some(name => name.startsWith('index-v1-backup-')), false);
  }
  await writeFile(path.join(directory, 'usage.json'), JSON.stringify({ ...normal, favorites: [first.id], recent: [entry] }));
  const migrated = await Library.open(directory);
  assert.equal(migrated.list().assets[0].favorite, true);
  assert.equal(migrated.list().assets[0].lastInsertedAt, entry.insertedAt);
  const emptyDirectory = path.join(directory, 'empty-library');
  await Library.open(emptyDirectory);
  await writeFile(path.join(emptyDirectory, 'usage.json'), '{broken');
  await assert.rejects(Library.open(emptyDirectory), /usage.json/);
  assert.equal((await readdir(emptyDirectory)).includes('index.json'), false);
});

test('failed usage replacement leaves favorites and recency unchanged and later writes recover', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('合法图.png', await image());
  const id = library.assets[0].id;
  await library.setFavorite(id, { favorite: true });
  await library.recordRecent(id, {});
  const before = library.list().assets[0];
  const statePath = path.join(directory, 'usage.json');
  const savedPath = path.join(directory, 'saved-usage.json');
  const original = await readFile(statePath);
  await rename(statePath, savedPath);
  await mkdir(statePath);
  try {
    await assert.rejects(library.setFavorite(id, { favorite: false }));
    await assert.rejects(library.recordRecent(id, {}));
    assert.deepEqual(library.list().assets[0], before);
    assert.deepEqual(await readFile(savedPath), original);
  } finally {
    assert.equal(path.dirname(statePath), directory);
    await rm(statePath, { recursive: true });
    await rename(savedPath, statePath);
  }
  await library.setFavorite(id, { favorite: false });
  assert.equal((await Library.open(directory)).list().assets[0].favorite, false);
});

test('queued imports, metadata edits, favorites and recency updates retain each committed change', async t => {
  const { directory, library } = await setup(t);
  const bytes = await image();
  await library.importFile('甲图.png', bytes);
  await library.importFile('乙图.png', await image('blue'));
  const [first, second] = library.assets;
  await Promise.all([
    library.setFavorite(first.id, { favorite: true }),
    library.recordRecent(first.id, {}),
    library.updateAsset(first.id, { name: '人工新名称', tags: ['新标签'] }),
    library.importFile('导入别名.png', bytes, '新分类'),
    library.setFavorite(second.id, { favorite: true }),
    library.recordRecent(second.id, {}),
    library.setFavorite(first.id, { favorite: false }),
  ]);
  const reopened = await Library.open(directory);
  assert.deepEqual(reopened.list('', { view: 'favorites' }).assets.map(asset => asset.id), [second.id]);
  assert.deepEqual(reopened.list('', { view: 'recent' }).assets.map(asset => asset.id), [second.id, first.id]);
  const asset = reopened.getAsset(first.id);
  assert.equal(asset.name, '人工新名称');
  assert.deepEqual(asset.tags, ['新标签']);
  assert.deepEqual(asset.categories, ['新分类']);
  assert.deepEqual(asset.aliases, ['导入别名.png']);
});

test('v2 migration backs up exact bytes, refuses damaged usage, and retries failed writes atomically', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('历史.png', await image());
  const { deletedAt, ...legacy } = library.assets[0];
  const original = Buffer.from(` \r\n${JSON.stringify({ version: 2, assets: [legacy] }, null, 3)}\r\n`);
  const filename = path.join(directory, 'index.json');
  await writeFile(filename, original);
  await writeFile(path.join(directory, 'usage.json'), '{broken');
  await assert.rejects(Library.open(directory), /usage.json/);
  assert.deepEqual(await readFile(filename), original);
  assert.equal((await readdir(directory)).some(name => name.startsWith('index-v2-backup-')), false);
  await unlink(path.join(directory, 'usage.json'));
  const failure = t.mock.method(Library.prototype, 'persist', async () => { throw new Error('模拟索引写入失败'); });
  await assert.rejects(Library.open(directory), /模拟索引写入失败/);
  failure.mock.restore();
  assert.deepEqual(await readFile(filename), original);
  const backups = (await readdir(directory)).filter(name => name.startsWith('index-v2-backup-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await readFile(path.join(directory, backups[0])), original);
  assert.deepEqual((await Library.open(directory)).assets, [{ ...legacy, deletedAt: null }]);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).version, 3);
});

test('v3 rejects missing, noncanonical and invalid trash timestamps without changing original bytes', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('历史.png', await image());
  for (const deletedAt of [undefined, false, 0, '', '2026-11-05', '2026-11-05T00:00:00+00:00', 'invalid']) {
    const original = Buffer.from(JSON.stringify({ version: 3, assets: [{ ...library.assets[0], deletedAt }] }));
    await writeFile(path.join(directory, 'index.json'), original);
    await assert.rejects(Library.open(directory), error => error.status === 500 && /索引/.test(error.message));
    assert.deepEqual(await readFile(path.join(directory, 'index.json')), original);
  }
});

test('trash preserves originals, manual metadata and usage across restart; restore and reimport retain identity', async t => {
  const { directory, library } = await setup(t);
  const bytes = await image();
  await library.importFile('来源.png', bytes, '来源分类');
  const id = library.assets[0].id;
  await library.updateAsset(id, { name: '人工名称', aliases: ['人工别名'], categories: ['人工分类'], tags: ['人工标签'] });
  await library.setFavorite(id, { favorite: true });
  await library.recordRecent(id, {});
  const original = library.list().assets[0];
  const usageBytes = await readFile(path.join(directory, 'usage.json'));
  const removed = await library.setTrash(id, { trashed: true });
  assert.equal(new Date(removed.deletedAt).toISOString(), removed.deletedAt);
  const indexBytes = await readFile(path.join(directory, 'index.json'));
  assert.deepEqual(await library.setTrash(id, { trashed: true }), removed);
  assert.deepEqual(await readFile(path.join(directory, 'index.json')), indexBytes);
  const reopened = await Library.open(directory);
  for (const view of ['all', 'favorites', 'recent']) {
    assert.equal(reopened.list('', { view }).viewTotal, 0);
    assert.equal(reopened.list('', { view }).total, 0);
    assert.deepEqual(reopened.list('', { view }).facets.categories, []);
  }
  const trash = reopened.list('人工名称', { view: 'trash' });
  assert.equal(trash.total, 0);
  assert.equal(trash.viewTotal, 1);
  assert.deepEqual(trash.facets.categories, [{ name: '人工分类', count: 1 }]);
  assert.deepEqual(await readFile((await reopened.file(id, 'image')).path), bytes);
  assert.ok((await reopened.file(id, 'thumbnail')).path);
  for (const operation of [() => reopened.updateAsset(id, { name: '不保存' }),
    () => reopened.setFavorite(id, { favorite: false }), () => reopened.recordRecent(id, {}), () => reopened.insertion(id)]) {
    await assert.rejects(operation(), error => error.status === 410);
  }
  assert.deepEqual(await reopened.setTrash(id, { trashed: false }), original);
  assert.deepEqual(await reopened.setTrash(id, { trashed: false }), original);
  await reopened.setTrash(id, { trashed: true });
  assert.deepEqual(await reopened.importFile('另一来源.png', bytes, '另一目录'),
    { imported: 0, duplicates: 0, restored: 1, failed: [], total: 1 });
  assert.deepEqual((await Library.open(directory)).list().assets[0], original);
  assert.deepEqual(await readFile(path.join(directory, 'usage.json')), usageBytes);
  await reopened.importFile('普通重复.png', bytes, '重复目录');
  assert.deepEqual(reopened.getAsset(id).aliases, ['人工别名', '普通重复.png']);
  assert.deepEqual(reopened.getAsset(id).categories, ['人工分类', '重复目录']);
});

test('trash validates exact boolean input and failed persistence retains active state', async t => {
  const { directory, library } = await setup(t);
  await library.importFile('图片.png', await image());
  const id = library.assets[0].id;
  const original = await readFile(path.join(directory, 'index.json'));
  for (const input of [null, [], {}, { trashed: 1 }, { trashed: 'true' }, { trashed: true, other: true }]) {
    await assert.rejects(library.setTrash(id, input), error => error.status === 400);
  }
  await assert.rejects(library.setTrash('f'.repeat(64), { trashed: true }), error => error.status === 404);
  const failure = t.mock.method(library, 'persist', async () => { throw new Error('模拟写入失败'); });
  await assert.rejects(library.setTrash(id, { trashed: true }), /模拟写入失败/);
  failure.mock.restore();
  assert.equal(library.activeTotal, 1);
  assert.equal(library.getAsset(id).deletedAt, null);
  assert.deepEqual(await readFile(path.join(directory, 'index.json')), original);
});

test('insertion rechecks trash and current name after asynchronous file lookup', async t => {
  const { library } = await setup(t);
  await library.importFile('图片.png', await image());
  const id = library.assets[0].id;
  const file = library.file.bind(library);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const continueLookup = new Promise(resolve => { release = resolve; });
  const lookup = t.mock.method(library, 'file', async (...args) => {
    entered();
    await continueLookup;
    return file(...args);
  });
  const insertion = library.insertion(id);
  const rejected = assert.rejects(insertion, error => error.status === 410);
  await waiting;
  await library.setTrash(id, { trashed: true });
  release();
  await rejected;
  lookup.mock.restore();
  await library.setTrash(id, { trashed: false });
  t.mock.method(library, 'file', async (...args) => {
    await library.updateAsset(id, { name: '最新名称' });
    return file(...args);
  });
  assert.equal((await library.insertion(id)).name, '最新名称');
});
