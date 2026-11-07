import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Library } from '../server/library.js';
import { Fitter, fitPixels, validateFit } from '../server/fit.js';
import { startServer } from '../server/http.js';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-fit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = await Library.open(path.join(root, 'library'));
  return { root, library, fitter: new Fitter(library) };
}

async function add(library, name, buffer) {
  await library.importFile(name, buffer);
  return library.assets.find(asset => asset.name === name).id;
}

// 左半红、右半蓝的 3:1 横图，用于判断裁切、补白和拉伸的结果。
const halves = () => sharp({ create: { width: 1200, height: 400, channels: 3, background: '#ff0000' } })
  .composite([{ input: { create: { width: 600, height: 400, channels: 3, background: '#0000ff' } }, left: 600, top: 0 }])
  .removeAlpha().png().toBuffer(); // composite 会附加透明通道，去掉后才是普通不透明图

async function pixel(file, x, y) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}
const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
const isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60;
const isWhite = ([r, g, b]) => r > 240 && g > 240 && b > 240;

test('输出像素保持框的比例，并且不超过原图能提供的分辨率', () => {
  const box = { widthPt: 360, heightPt: 270 };
  assert.deepEqual(fitPixels({ width: 3000, height: 2000 }, box, 'cover', 200), { width: 1000, height: 750 });
  assert.deepEqual(fitPixels({ width: 500, height: 250 }, box, 'cover', 200), { width: 333, height: 250 }, '裁切区域不放大');
  assert.deepEqual(fitPixels({ width: 500, height: 250 }, box, 'contain', 200), { width: 500, height: 375 }, '完整显示时内容不放大');
  assert.deepEqual(fitPixels({ width: 500, height: 250 }, box, 'fill', 200), { width: 500, height: 375 });
});

test('裁切填满取中间、完整显示上下补白、拉伸保留全部内容', async t => {
  const { library, fitter } = await setup(t);
  const id = await add(library, '左右两色.png', await halves());
  const box = { widthPt: '144', heightPt: '144', profile: 'balanced' };
  const cover = await fitter.create(id, { ...box, mode: 'cover' });
  assert.deepEqual([cover.width, cover.height, cover.format], [300, 300, 'jpeg']);
  assert.ok(isRed(await pixel(cover.path, 5, 150)) && isBlue(await pixel(cover.path, 294, 150)), '裁掉两端，保留中间的红蓝交界');
  assert.ok(!isWhite(await pixel(cover.path, 150, 2)), '裁切不补白');
  const contain = await fitter.create(id, { ...box, mode: 'contain' });
  assert.deepEqual([contain.width, contain.height], [300, 300]);
  assert.ok(isWhite(await pixel(contain.path, 150, 5)) && isWhite(await pixel(contain.path, 150, 294)), '上下补白');
  assert.ok(isRed(await pixel(contain.path, 5, 150)) && isBlue(await pixel(contain.path, 294, 150)));
  const fill = await fitter.create(id, { ...box, mode: 'fill' });
  assert.ok(isRed(await pixel(fill.path, 5, 5)) && isBlue(await pixel(fill.path, 294, 294)), '拉伸后四角都是原图内容');
  assert.equal(new Set([cover.path, contain.path, fill.path]).size, 3);
  assert.equal(cover.name, '左右两色.png');
});

test('透明图输出 PNG 并保留透明；相同请求复用缓存', async t => {
  const { library, fitter } = await setup(t);
  const alpha = await sharp({ create: { width: 800, height: 600, channels: 4, background: { r: 20, g: 120, b: 120, alpha: 0.4 } } }).png().toBuffer();
  const id = await add(library, '透明.png', alpha);
  const input = { mode: 'cover', widthPt: '100', heightPt: '100' };
  const first = await fitter.create(id, input);
  const metadata = await sharp(first.path).metadata();
  assert.deepEqual([first.format, metadata.format, metadata.hasAlpha], ['png', 'png', true]);
  const before = await stat(first.path);
  const again = await fitter.create(id, input);
  assert.equal(again.path, first.path);
  assert.equal((await stat(again.path)).mtimeMs, before.mtimeMs);
  assert.equal(again.bytes, before.size);
});

test('适配参数严格校验，回收站中的素材不能填入', async t => {
  const { library, fitter } = await setup(t);
  const id = await add(library, '图.png', await halves());
  for (const input of [{}, { mode: 'stretch', widthPt: '100', heightPt: '100' }, { mode: 'cover', widthPt: '13', heightPt: '100' },
    { mode: 'cover', widthPt: '100', heightPt: '1441' }, { mode: 'cover', widthPt: '1e2', heightPt: '100' }, { mode: 'cover', widthPt: '-100', heightPt: '100' },
    { mode: 'cover', widthPt: '100', heightPt: '100', profile: 'max' }]) {
    assert.throws(() => validateFit(input), JSON.stringify(input));
  }
  assert.deepEqual(validateFit({ mode: 'fill', widthPt: '340.157', heightPt: '255.1' }), { mode: 'fill', profile: 'original', widthPt: 340.2, heightPt: 255.1 });
  await library.setTrash(id, { trashed: true });
  await assert.rejects(fitter.create(id, { mode: 'cover', widthPt: '100', heightPt: '100' }), error => error.status === 410);
});

test('HTTP 适配接口只接受约定参数和同源请求', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-fit-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { server, library } = await startServer({ port: 0, dataDirectory: path.join(root, 'library') });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const id = await add(library, '图.png', await halves());
  const endpoint = `${base}/api/assets/${id}/fit`;
  const response = await fetch(`${endpoint}?mode=contain&widthPt=144&heightPt=72&profile=balanced`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual([result.mode, result.width, result.height], ['contain', 300, 150]);
  assert.equal((await sharp(result.path).metadata()).width, 300);
  for (const query of ['mode=cover&widthPt=144', 'mode=cover&widthPt=144&heightPt=72&other=1', 'mode=cover&mode=fill&widthPt=144&heightPt=72']) {
    assert.equal((await fetch(`${endpoint}?${query}`)).status, 400, query);
  }
  assert.equal((await fetch(`${endpoint}?mode=cover&widthPt=144&heightPt=72`, { headers: { origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${base}/api/assets/${'0'.repeat(64)}/fit?mode=cover&widthPt=144&heightPt=72`)).status, 404);
});
