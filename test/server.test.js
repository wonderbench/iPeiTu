import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startServer } from '../server/http.js';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-http-'));
  const publicDirectory = path.join(root, 'public');
  await mkdir(publicDirectory);
  await writeFile(path.join(publicDirectory, 'index.html'), '<h1>iPeiTu</h1>');
  await writeFile(path.join(root, 'secret.txt'), 'PRIVATE');
  const { server, library } = await startServer({ port: 0, dataDirectory: path.join(root, 'data'), publicDirectory });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, publicDirectory, server, library, base: `http://127.0.0.1:${server.address().port}` };
}

function request(base, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.get({ hostname: url.hostname, port: url.port, path: pathname, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
}

test('HTTP upload, name search, image preview and insertion metadata work together', async t => {
  const { base } = await setup(t);
  const bytes = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#227766' } }).png().toBuffer();
  const upload = await fetch(`${base}/api/import-file?name=${encodeURIComponent('沟槽 图片.png')}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', origin: base }, body: bytes,
  });
  assert.equal(upload.status, 200);
  assert.deepEqual(await upload.json(), { imported: 1, duplicates: 0, failed: [], total: 1 });
  const listing = await (await fetch(`${base}/api/library?q=${encodeURIComponent('沟槽')}`)).json();
  assert.equal(listing.assets.length, 1);
  const asset = listing.assets[0];
  const image = await fetch(`${base}${asset.imageUrl}`);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  assert.equal((await fetch(`${base}${asset.thumbnailUrl}`)).headers.get('content-type'), 'image/jpeg');
  const insertion = await (await fetch(`${base}/api/assets/${asset.id}/insertion`)).json();
  assert.equal(insertion.name, '沟槽 图片.png');
  assert.ok(path.isAbsolute(insertion.path));
  assert.equal(insertion.width, 100);
  assert.equal((await (await fetch(`${base}/api/library?q=none`)).json()).assets.length, 0);
});

test('directory endpoint imports recursively and validates malformed input', async t => {
  const { root, base } = await setup(t);
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, '工程.jpeg'), await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).jpeg().toBuffer());
  const response = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: source }) });
  assert.equal((await response.json()).imported, 1);
  const malformed = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /JSON/);
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
});

test('rejects foreign Host, Origin, Fetch-Site and Referer on reads and writes', async t => {
  const { base, library } = await setup(t);
  for (const headers of [
    { host: 'attacker.example' }, { origin: 'https://attacker.example' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { referer: 'http://localhost:1234/' },
  ]) {
    assert.equal((await request(base, '/api/library', headers)).status, 403);
  }
  const response = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' }, body: '{}' });
  assert.equal(response.status, 403);
  assert.equal(library.list().total, 0);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('static server confines files to public, including encoded traversal and symlink escape', async t => {
  const { root, publicDirectory, base } = await setup(t);
  assert.match(await (await fetch(base)).text(), /iPeiTu/);
  for (const pathname of ['/../secret.txt', '/%2e%2e%2fsecret.txt', '/%2e%2e%5csecret.txt', '/.git/config', '/server/library.js', '/%00', '/missing', '/api/missing']) {
    assert.equal((await request(base, pathname)).status, 404, pathname);
  }
  await symlink(root, path.join(publicDirectory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await request(base, '/escape/secret.txt')).status, 404);
  assert.equal((await request(base, '/api/assets/../../secret.txt/insertion')).status, 404);
});

test('oversized JSON is reported without crashing or changing the library', async t => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: 'a'.repeat(17000) }) });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /大小/);
  assert.equal((await fetch(`${base}/api/library`)).status, 200);
});

test('HTTP classified upload, metadata editing and combined filters share the v2 contract', async t => {
  const { base } = await setup(t);
  const bytes = await sharp({ create: { width: 10, height: 8, channels: 3, background: '#227766' } }).png().toBuffer();
  const upload = await fetch(`${base}/api/import-file?name=${encodeURIComponent('原图.png')}&category=${encodeURIComponent('机电安装')}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
  });
  assert.equal(upload.status, 200);
  const first = await (await fetch(`${base}/api/library`)).json();
  const id = first.assets[0].id;
  assert.deepEqual(first.assets[0].categories, ['机电安装']);
  assert.deepEqual(first.assets[0].tags, []);
  const patch = await fetch(`${base}/api/assets/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '桥架安装', aliases: ['Tray'], tags: ['室内', '夜间'], categories: ['机电安装', '工程/桥架'] }),
  });
  assert.equal(patch.status, 200);
  const { asset } = await patch.json();
  assert.equal(asset.name, '桥架安装');
  assert.equal(asset.thumbnailUrl, `/api/assets/${id}/thumbnail`);
  const parameters = new URLSearchParams({ q: 'tray 夜间', category: '机电安装' });
  parameters.append('tag', '夜间');
  parameters.append('tag', '室内');
  const listing = await (await fetch(`${base}/api/library?${parameters}`)).json();
  assert.deepEqual(listing.assets.map(item => item.id), [id]);
  assert.equal(listing.facets.categories.length, 2);
  assert.equal(listing.facets.tags.length, 2);
  const empty = await (await fetch(`${base}/api/library?uncategorized=1`)).json();
  assert.equal(empty.assets.length, 0);
  assert.equal(empty.total, 1);
  assert.deepEqual(empty.facets, listing.facets);
});

test('HTTP metadata and query validation rejects unknown, duplicate and invalid fields without writes', async t => {
  const { base, library } = await setup(t);
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: 'blue' } }).png().toBuffer();
  await library.importFile('原图.png', bytes);
  const id = library.assets[0].id;
  for (const input of [null, [], {}, { name: '不保存', tags: [null] }, { path: 'C:\\secret' }, { categories: '分类' }]) {
    const response = await fetch(`${base}/api/assets/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  for (const query of ['q=a&q=b', 'category=a&category=b', 'category=a&uncategorized=1', 'tag=', 'uncategorized=true', 'unexpected=1']) {
    assert.equal((await fetch(`${base}/api/library?${query}`)).status, 400, query);
  }
  assert.equal((await fetch(`${base}/api/assets/${id}?unknown=1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"name":"不保存"}' })).status, 400);
  assert.equal((await fetch(`${base}/api/assets/${id}`, { method: 'PATCH', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/assets/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{broken' })).status, 400);
  assert.equal((await fetch(`${base}/api/assets/${'f'.repeat(64)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"name":"不存在"}' })).status, 404);
  assert.equal((await fetch(`${base}/api/assets/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' }, body: '{"name":"不保存"}' })).status, 403);
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"directory":"C:/素材","unknown":true}' })).status, 400);
  assert.equal((await fetch(`${base}/api/import-file?name=a.png&category=`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes })).status, 400);
  assert.equal(library.getAsset(id).name, '原图.png');
  assert.deepEqual(library.getAsset(id).categories, []);
  assert.equal(library.list().total, 1);
});
