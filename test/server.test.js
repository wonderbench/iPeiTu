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
