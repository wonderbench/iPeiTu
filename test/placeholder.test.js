import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Placeholders, validatePlaceholder, MIN_BOX_PT, MAX_BOX_PT } from '../server/placeholder.js';
import { startServer } from '../server/http.js';

async function temporaryLibrary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-placeholder-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('占位图按磅值换算像素，保存在图库目录内并复用缓存', async t => {
  const root = await temporaryLibrary(t);
  const placeholders = new Placeholders(root);
  const first = await placeholders.create({ name: ' 脚手架搭设 ', widthPt: 340.157, heightPt: 255.118 });
  assert.equal(first.name, '脚手架搭设');
  assert.deepEqual([first.widthPt, first.heightPt, first.width, first.height], [340.2, 255.1, 454, 340]);
  assert.equal(path.dirname(first.path), path.join(root, 'placeholders'));
  const metadata = await sharp(first.path).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height], ['png', 454, 340]);
  const before = await stat(first.path);
  const again = await placeholders.create({ name: '脚手架搭设', widthPt: 340.2, heightPt: 255.1 });
  assert.equal(again.path, first.path);
  assert.equal((await stat(again.path)).mtimeMs, before.mtimeMs, '相同框复用缓存，不重写文件');
  const other = await placeholders.create({ name: '模板安装', widthPt: 340.2, heightPt: 255.1 });
  assert.notEqual(other.path, first.path);
  assert.deepEqual((await readdir(path.join(root, 'placeholders'))).filter(name => !name.endsWith('.png')), [], '不留临时文件');
});

test('损坏的缓存会重新生成；XML 特殊字符和超长框名仍生成有效图片', async t => {
  const root = await temporaryLibrary(t);
  const placeholders = new Placeholders(root);
  const box = { name: '<script>&"\'', widthPt: 100, heightPt: 60 };
  const first = await placeholders.create(box);
  await writeFile(first.path, 'broken');
  const rebuilt = await placeholders.create(box);
  assert.equal((await sharp(rebuilt.path).metadata()).width, 133);
  const long = await placeholders.create({ name: '很长的框名'.repeat(20), widthPt: MIN_BOX_PT, heightPt: MIN_BOX_PT });
  assert.equal((await sharp(long.path).metadata()).height, 19);
});

test('占位框输入只接受框名与限定范围内的宽高', () => {
  const valid = { name: '框', widthPt: 100, heightPt: 80 };
  for (const input of [null, [], {}, { ...valid, extra: 1 }, { name: '框', widthPt: 100 },
    { ...valid, name: 3 }, { ...valid, name: '   ' }, { ...valid, name: '换\n行' }, { ...valid, name: '框'.repeat(101) },
    { ...valid, widthPt: '100' }, { ...valid, widthPt: NaN }, { ...valid, widthPt: MIN_BOX_PT - 0.1 }, { ...valid, heightPt: MAX_BOX_PT + 0.1 }]) {
    assert.throws(() => validatePlaceholder(input), JSON.stringify(input));
  }
  assert.deepEqual(validatePlaceholder(valid), valid);
});

test('HTTP 生成占位图只接受同源 JSON 请求', async t => {
  const root = await temporaryLibrary(t);
  const { server } = await startServer({ port: 0, dataDirectory: path.join(root, 'library') });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/placeholders`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const response = await post({ name: '基础施工', widthPt: 200, heightPt: 150 });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual([result.name, result.width, result.height], ['基础施工', 267, 200]);
  assert.equal((await sharp(result.path).metadata()).format, 'png');
  assert.equal((await post({ name: '基础施工', widthPt: 5, heightPt: 150 })).status, 400);
  assert.equal((await post({ name: '基础施工', widthPt: 200, heightPt: 150 }, { origin: 'https://example.com' })).status, 403);
  const text = await fetch(`${base}/api/placeholders`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(text.status, 415);
  assert.equal((await fetch(`${base}/api/placeholders?name=x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
});
