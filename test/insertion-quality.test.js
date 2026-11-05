import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, rename, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { Library } from '../server/library.js';
import { InsertionQuality } from '../server/insertion-quality.js';
import { densityPolicy, physicalResolution, logicalSize } from '../server/image-density.js';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-quality-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = await Library.open(path.join(root, 'library'));
  return { root, library };
}
function fixture({ width = 3001, height = 1801, alpha = false, color = 'red', density = 300, format = 'jpeg', orientation } = {}) {
  let image = sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 20, g: 80, b: 40, alpha: 0.25 } : color } });
  if (orientation) image = image.withMetadata({ orientation, density });
  else if (density) image = image.withDensity(density);
  return image[format]().toBuffer();
}
async function add(library, options) {
  const bytes = await fixture(options);
  await library.importFile(`素材.${options?.format || 'jpeg'}`, bytes);
  return { id: library.assets.at(-1).id, bytes };
}
function stripPng(buffer) {
  const chunks = [buffer.subarray(0, 8)];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!['pHYs', 'eXIf'].includes(type)) chunks.push(buffer.subarray(offset, offset + length + 12));
    offset += length + 12;
  }
  return Buffer.concat(chunks);
}
function jfif(x, y, unit = 1) {
  const segment = Buffer.alloc(18);
  segment[0] = 0xff; segment[1] = 0xe0; segment.writeUInt16BE(16, 2);
  segment.write('JFIF\0', 4, 'ascii'); segment[9] = 1; segment[10] = 1; segment[11] = unit;
  segment.writeUInt16BE(x, 12); segment.writeUInt16BE(y, 14);
  return segment;
}
function unitlessPng(buffer) {
  const output = Buffer.from(buffer);
  for (let offset = 8; offset < output.length;) {
    const length = output.readUInt32BE(offset);
    if (output.toString('ascii', offset + 4, offset + 8) === 'pHYs') {
      output[offset + 16] = 0;
      let crc = 0xffffffff;
      for (const byte of output.subarray(offset + 4, offset + 8 + length)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, offset + 8 + length);
    }
    offset += length + 12;
  }
  return output;
}
function exifTags(buffer) {
  const tiff = buffer.subarray(6), little = tiff.toString('ascii', 0, 2) === 'II';
  const u16 = at => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const u32 = at => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
  const offset = u32(4), tags = [];
  for (let index = 0; index < u16(offset); index++) tags.push(u16(offset + 2 + index * 12));
  return tags;
}
function barrier() {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
}
async function until(condition) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('未达到预期并发阶段');
}

test('profiles preserve the original, report actual insertion bytes, and preserve exact source physical width', async t => {
  const { library } = await setup(t);
  const { id, bytes } = await add(library, { density: 300 });
  const original = await library.insertion(id);
  assert.equal(original.profile, 'original');
  assert.equal(original.format, 'jpeg');
  assert.equal(original.bytes, bytes.length);
  assert.equal(original.sourceBytes, bytes.length);
  assert.equal(original.logicalWidthPt, undefined);
  assert.deepEqual(await readFile(original.path), bytes);
  for (const [profile, width, height, chroma] of [['clear', 2400, 1440, '4:4:4'], ['balanced', 1600, 960, '4:2:0']]) {
    const output = await library.insertion(id, profile);
    const metadata = await sharp(output.path).metadata();
    assert.equal(output.width, width);
    assert.equal(output.height, height);
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, height);
    assert.equal(metadata.chromaSubsampling, chroma);
    assert.equal(metadata.density, 96);
    assert.equal(output.bytes, (await readFile(output.path)).length);
    assert.equal(output.sourceBytes, bytes.length);
    assert.equal(output.logicalWidthPt, 3001 * 72 / 300);
    assert.equal(output.logicalHeightPt, 1801 * 72 / 300);
    assert.match(output.path, /v2-sharp-0\.35\.5/);
  }
  assert.deepEqual(await readFile(original.path), bytes);
  await assert.rejects(library.insertion(id, 'unknown'), error => error.status === 400);
});

test('small alpha images keep transparency without enlargement and rotated inputs keep upright dimensions', async t => {
  const { library } = await setup(t);
  const { id } = await add(library, { width: 301, height: 201, alpha: true, format: 'png' });
  const transparent = await library.insertion(id, 'balanced');
  assert.equal(transparent.format, 'png');
  assert.equal(transparent.width, 301);
  assert.equal(transparent.height, 201);
  const { data, info } = await sharp(transparent.path).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  assert.ok(data[3] >= 63 && data[3] <= 64);
  const rotated = await add(library, { width: 2800, height: 1800, orientation: 6 });
  const original = await library.insertion(rotated.id);
  assert.equal(original.format, 'png');
  assert.equal(original.sourceBytes, rotated.bytes.length);
  assert.equal(original.bytes, (await readFile(original.path)).length);
  const output = await library.insertion(rotated.id, 'balanced');
  assert.equal(output.width, 1029);
  assert.equal(output.height, 1600);
  assert.equal(output.logicalWidthPt, 1800 * 72 / (11811 * 0.0254));
  assert.equal(output.logicalHeightPt, 2800 * 72 / (11811 * 0.0254));
});

test('compression strips source author, GPS, orientation, XMP and ICC metadata while writing only new density', async t => {
  const { library } = await setup(t);
  const bytes = await sharp({ create: { width: 900, height: 600, channels: 3, background: 'green' } })
    .withExif({ IFD0: { Artist: 'PRIVATE-AUTHOR' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '22/1 30/1 0/1' } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">PRIVATE-XMP</x:xmpmeta>')
    .withIccProfile('srgb').withDensity(300).jpeg().toBuffer();
  await library.importFile('私有元数据.jpg', bytes);
  const output = await library.insertion(library.assets[0].id, 'clear');
  const buffer = await readFile(output.path), metadata = await sharp(buffer).metadata();
  assert.equal(buffer.includes(Buffer.from('PRIVATE-AUTHOR')), false);
  assert.equal(buffer.includes(Buffer.from('PRIVATE-XMP')), false);
  assert.equal(exifTags(metadata.exif).includes(0x8825), false, '没有 GPS IFD 指针');
  assert.equal(exifTags(metadata.exif).includes(0x13b), false, '没有 Artist 字段');
  assert.equal(metadata.xmp, undefined);
  assert.equal(metadata.icc, undefined);
  assert.deepEqual(physicalResolution(buffer, 'jpeg'), { x: 96, y: 96 });
});

test('cache hits across reopen avoid encoding; damaged and empty caches are explicitly rebuilt without trusting layout metadata', async t => {
  const { library } = await setup(t);
  const { id } = await add(library, { width: 801, height: 601, density: 299.75 });
  const first = await library.insertion(id, 'balanced');
  const reopened = await Library.open(library.directory);
  const render = t.mock.method(reopened.quality, 'render', () => { throw new Error('缓存命中不应编码'); });
  assert.deepEqual(await reopened.insertion(id, 'balanced'), first);
  render.mock.restore();
  const warnings = t.mock.method(console, 'warn', () => {});
  for (const damaged of [Buffer.from('broken'), Buffer.alloc(0)]) {
    await writeFile(first.path, damaged);
    const rebuilt = await reopened.insertion(id, 'balanced');
    assert.equal(rebuilt.logicalWidthPt, 801 * 72 / 299.75);
    assert.ok((await readFile(first.path)).length > damaged.length);
  }
  assert.equal(warnings.mock.calls.length, 2);
  assert.equal((await readdir(path.dirname(first.path))).some(name => name.endsWith('.tmp')), false);
});

test('shared work is bounded, stays outside library mutation serialization, and rechecks trash after generation', async t => {
  const { library } = await setup(t);
  const first = await add(library, { color: 'red', width: 100, height: 90 });
  const second = await add(library, { color: 'green', width: 100, height: 90 });
  const third = await add(library, { color: 'blue', width: 100, height: 90 });
  library.quality = new InsertionQuality(library.directory, { concurrency: 1, maxQueue: 1 });
  const render = library.quality.render.bind(library.quality), gate = barrier();
  let calls = 0;
  t.mock.method(library.quality, 'render', async (...args) => { calls++; await gate.promise; return render(...args); });
  const one = library.insertion(first.id, 'balanced');
  const same = library.insertion(first.id, 'balanced');
  const rejectedOne = assert.rejects(one, error => error.status === 410);
  const rejectedSame = assert.rejects(same, error => error.status === 410);
  await until(() => calls === 1);
  const two = library.insertion(second.id, 'balanced');
  await until(() => library.quality.queue.length === 1);
  await assert.rejects(library.insertion(third.id, 'balanced'), error => error.status === 429);
  await library.setFavorite(second.id, { favorite: true });
  await library.setTrash(first.id, { trashed: true });
  assert.equal(library.list('', { view: 'favorites' }).viewTotal, 1);
  gate.release();
  await Promise.all([rejectedOne, rejectedSame, two]);
  assert.equal(calls, 2, '同 key 并发请求只编码一次');
  assert.equal(library.quality.running, 0);
  assert.equal(library.quality.pending.size, 0);
  assert.equal((await library.insertion(third.id, 'balanced')).profile, 'balanced');
});

test('source and cache directory junctions are rejected without writing outside the library', async t => {
  const { root, library } = await setup(t);
  const { id } = await add(library, { width: 100, height: 80 });
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  const cache = path.join(library.directory, 'insertion-quality');
  await symlink(outside, cache, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(library.insertion(id, 'balanced'), /符号链接/);
  assert.deepEqual(await readdir(outside), []);
  await rm(cache);
  await rename(path.join(library.directory, 'images'), path.join(library.directory, 'saved-images'));
  await symlink(path.join(library.directory, 'saved-images'), path.join(library.directory, 'images'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const profile of ['original', 'balanced']) await assert.rejects(library.insertion(id, profile), /符号链接/);
});

test('exact PNG and EXIF resolutions avoid sharp density rounding and reject conflicts, non-square values and malformed ranges', async () => {
  const png = await fixture({ width: 301, height: 201, density: 299.75, format: 'png' });
  const pngDensity = physicalResolution(png, 'png');
  assert.ok(Math.abs(pngDensity.x - 299.75) < 0.02);
  assert.equal(physicalResolution(stripPng(png), 'png'), null);
  const jpeg = await fixture({ width: 301, height: 201, density: 299.75 });
  assert.deepEqual(physicalResolution(jpeg, 'jpeg'), { x: 299.75, y: 299.75 });
  assert.equal(logicalSize(jpeg, { width: 301, height: 201, format: 'jpeg' }).logicalWidthPt, 301 * 72 / 299.75);
  const conflict = Buffer.concat([jpeg.subarray(0, 2), jfif(96, 96), jpeg.subarray(2)]);
  assert.throws(() => physicalResolution(conflict, 'jpeg'), /冲突/);
  const nonsquare = Buffer.concat([jpeg.subarray(0, 2), jfif(300, 150), jpeg.subarray(2)]);
  assert.throws(() => physicalResolution(nonsquare, 'jpeg'), /非方形/);
  assert.throws(() => physicalResolution(Buffer.from([255, 216, 255, 225, 255, 255]), 'jpeg'), /越界/);
  assert.throws(() => logicalSize(stripPng(png), { width: 301, height: 201, format: 'png' }), /没有物理分辨率/);
});

test('valid PNG EXIF/pHYs quantization and one-pixel thin images remain compressible', async t => {
  const { library } = await setup(t);
  for (const density of [72, 96]) {
    const bytes = await sharp({ create: { width: 90, height: 60, channels: 3, background: 'red' } })
      .withMetadata({ density }).png().toBuffer();
    await library.importFile(`${density}.png`, bytes);
    assert.equal((await library.insertion(library.assets.at(-1).id, 'balanced')).width, 90);
  }
  const thin = await add(library, { width: 10000, height: 1, density: 300, format: 'png' });
  const output = await library.insertion(thin.id, 'balanced');
  assert.equal(output.width, 1600);
  assert.equal(output.height, 1);
});

test('no-DPI images keep their format and resolution declarations, with a host-derived natural width scale', async t => {
  const { library } = await setup(t);
  const plainJpeg = await fixture({ width: 3001, height: 1801, density: null });
  const plainPng = stripPng(await fixture({ width: 3001, height: 1801, density: null, format: 'png' }));
  const unitless = unitlessPng(await fixture({ width: 3001, height: 1801, density: null, format: 'png' }));
  const jfifJpeg = Buffer.concat([plainJpeg.subarray(0, 2), jfif(1, 1, 0), plainJpeg.subarray(2)]);
  for (const [name, bytes, format] of [['无标记.jpg', plainJpeg, 'jpeg'], ['无标记.png', plainPng, 'png'], ['比例.jpg', jfifJpeg, 'jpeg'], ['比例.png', unitless, 'png']]) {
    await library.importFile(name, bytes);
    const id = library.assets.at(-1).id;
    const policy = densityPolicy(bytes, format);
    assert.equal(policy.kind, 'native');
    const output = await library.insertion(id, 'balanced');
    const buffer = await readFile(output.path);
    assert.equal(output.format, format, '无 DPI 图片不切换格式');
    assert.equal(output.logicalWidthPt, undefined);
    assert.equal(output.logicalHeightPt, undefined);
    assert.equal(output.naturalWidthScale, 3001 / 1600);
    assert.equal(densityPolicy(buffer, format).key, policy.key, '保留缺省或 unit0 标记语义');
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.exif, undefined, '无 DPI 输出不引入 EXIF 分辨率或个人数据');
    assert.equal((await library.insertion(id, 'balanced')).path, output.path, '同状态缓存可复用');
  }
});

test('a cache with changed DPI semantics is rebuilt even if its dimensions and format still match', async t => {
  const { library } = await setup(t);
  const bytes = stripPng(await fixture({ width: 900, height: 600, density: null, format: 'png' }));
  await library.importFile('无标记.png', bytes);
  const id = library.assets[0].id, original = await library.insertion(id, 'balanced');
  const wrong = await sharp(bytes).withDensity(96).png().toBuffer();
  await writeFile(original.path, wrong);
  const warnings = t.mock.method(console, 'warn', () => {});
  const result = await library.insertion(id, 'balanced');
  assert.equal(result.naturalWidthScale, 1);
  assert.equal(densityPolicy(await readFile(result.path), 'png').key, 'png:none');
  assert.equal(warnings.mock.calls.length, 1);
});

test('failed encoders and atomic cache replacement failures report errors, release work and leave no temporary files', async t => {
  const { library } = await setup(t);
  const { id } = await add(library, { width: 180, height: 120 });
  const failure = t.mock.method(library.quality, 'render', () => { throw new Error('模拟编码失败'); });
  await assert.rejects(library.insertion(id, 'balanced'), /模拟编码失败/);
  assert.equal(library.quality.pending.size, 0);
  failure.mock.restore();
  const result = await library.insertion(id, 'balanced');
  await rm(result.path);
  await mkdir(result.path);
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(library.insertion(id, 'balanced'));
  assert.equal((await readdir(path.dirname(result.path))).some(name => name.endsWith('.tmp')), false);
  await rm(result.path, { recursive: true });
  assert.equal((await library.insertion(id, 'balanced')).path, result.path);
});

test('ambiguous unitless EXIF and conflicting physical metadata refuse compression while keeping original insertion available', async t => {
  const { library } = await setup(t);
  const ordinary = await fixture({ width: 600, height: 400, density: 300 });
  const conflict = Buffer.concat([ordinary.subarray(0, 2), jfif(96, 96), ordinary.subarray(2)]);
  await library.importFile('冲突.jpg', conflict);
  const id = library.assets.at(-1).id;
  assert.equal((await library.insertion(id)).profile, 'original');
  await assert.rejects(library.insertion(id, 'balanced'), error => error.status === 400 && /冲突/.test(error.message));
  const exif = Buffer.from(ordinary);
  const tiffAt = exif.indexOf(Buffer.from('Exif\0\0')) + 6, little = exif.toString('ascii', tiffAt, tiffAt + 2) === 'II';
  const u16 = offset => little ? exif.readUInt16LE(tiffAt + offset) : exif.readUInt16BE(tiffAt + offset);
  const offset = little ? exif.readUInt32LE(tiffAt + 4) : exif.readUInt32BE(tiffAt + 4);
  for (let index = 0; index < u16(offset); index++) {
    const at = offset + 2 + index * 12;
    if (u16(at) === 0x128) {
      if (little) exif.writeUInt16LE(1, tiffAt + at + 8);
      else exif.writeUInt16BE(1, tiffAt + at + 8);
    }
  }
  assert.equal(physicalResolution(exif, 'jpeg'), null);
  assert.throws(() => densityPolicy(exif, 'jpeg'), /无物理单位/);
  const png = await fixture({ width: 90, height: 60, density: 300, format: 'png' });
  const chunks = [png.subarray(0, 8)];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) !== 'pHYs') chunks.push(png.subarray(at, at + length + 12));
    at += length + 12;
  }
  assert.throws(() => densityPolicy(Buffer.concat(chunks), 'png'), /仅含 EXIF/);
});
