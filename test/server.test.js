import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink } from 'node:fs/promises';
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
  let server, library, base;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    ({ server, library } = await startServer({ port: 0, dataDirectory: path.join(root, 'data'), publicDirectory }));
    base = `http://127.0.0.1:${server.address().port}`;
    try {
      await (await fetch(base)).arrayBuffer();
      break;
    } catch (error) {
      // A system-assigned port can fall on Fetch's prohibited-port list on Windows.
      if (error.cause?.message !== 'bad port' || attempt === 9) throw error;
      console.warn(`临时 HTTP 测试端口 ${server.address().port} 被 Fetch 拒绝：${error.cause.message}；重新分配端口`);
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      server = undefined;
    }
  }
  return { root, publicDirectory, server, library, base };
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
  assert.deepEqual(await upload.json(), { imported: 1, duplicates: 0, restored: 0, failed: [], total: 1 });
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

test('HTTP favorites and recent views expose personal flags, scoped totals and unchanged full-library facets', async t => {
  const { base, library } = await setup(t);
  for (const [name, color] of [['甲图.png', 'red'], ['乙图.png', 'blue']]) {
    await library.importFile(name, await sharp({ create: { width: 3, height: 3, channels: 3, background: color } }).png().toBuffer());
  }
  const id = library.assets[0].id;
  await library.updateAsset(id, { categories: ['土建'], tags: ['现场'] });
  const send = (suffix, method, input) => fetch(`${base}/api/assets/${id}${suffix}`, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const initial = await (await fetch(`${base}/api/library`)).json();
  assert.equal(initial.total, 2);
  assert.equal(initial.viewTotal, 2);
  assert.equal(initial.assets[0].favorite, false);
  assert.equal(initial.assets[0].lastInsertedAt, null);
  const favorites = await (await fetch(`${base}/api/library?view=favorites`)).json();
  assert.equal(favorites.viewTotal, 0);
  assert.equal(favorites.total, 2);
  const saved = await send('/favorite', 'PATCH', { favorite: true });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).asset.favorite, true);
  assert.equal((await send('/favorite', 'PATCH', { favorite: true })).status, 200);
  await fetch(`${base}/api/assets/${id}/insertion`);
  assert.equal((await (await fetch(`${base}/api/library?view=recent`)).json()).viewTotal, 0);
  const recorded = await send('/recent', 'POST', {});
  assert.equal(recorded.status, 200);
  const { asset } = await recorded.json();
  assert.equal(asset.favorite, true);
  assert.equal(new Date(asset.lastInsertedAt).toISOString(), asset.lastInsertedAt);
  assert.equal(asset.thumbnailUrl, `/api/assets/${id}/thumbnail`);
  const query = new URLSearchParams({ view: 'favorites', q: '甲图', category: '土建', tag: '现场' });
  const filtered = await (await fetch(`${base}/api/library?${query}`)).json();
  assert.deepEqual(filtered.assets.map(item => item.id), [id]);
  assert.equal(filtered.total, 2);
  assert.equal(filtered.viewTotal, 1);
  assert.deepEqual(filtered.facets, initial.facets);
  const updated = await (await send('', 'PATCH', { name: '人工修改名' })).json();
  assert.equal(updated.asset.favorite, true);
  assert.equal(updated.asset.lastInsertedAt, asset.lastInsertedAt);
  await send('/favorite', 'PATCH', { favorite: false });
  const recent = await (await fetch(`${base}/api/library?view=recent`)).json();
  assert.equal(recent.viewTotal, 1);
  assert.equal(recent.assets[0].favorite, false);
  assert.equal((await (await fetch(`${base}/api/library?view=favorites`)).json()).viewTotal, 0);
});

test('HTTP personal-state writes reject invalid bodies, caller timestamps, foreign origins and unknown images', async t => {
  const { base, library } = await setup(t);
  await library.importFile('原图.png', await sharp({ create: { width: 3, height: 3, channels: 3, background: 'red' } }).png().toBuffer());
  const id = library.assets[0].id;
  const send = (suffix, method, input, headers = {}, assetId = id) => fetch(`${base}/api/assets/${assetId}/${suffix}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  for (const input of [null, [], {}, { favorite: 1 }, { favorite: 'true' }, { favorite: true, other: true }]) {
    const response = await send('favorite', 'PATCH', input);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  for (const input of [null, [], '', { insertedAt: '2026-11-05T02:00:00.000Z' }, { id }]) {
    assert.equal((await send('recent', 'POST', input)).status, 400);
  }
  for (const [suffix, method, input] of [['favorite', 'PATCH', { favorite: true }], ['recent', 'POST', {}]]) {
    assert.equal((await send(suffix, method, input, {}, 'f'.repeat(64))).status, 404);
    assert.equal((await send(suffix, method, input, { origin: 'https://attacker.example' })).status, 403);
    assert.equal((await send(suffix, method, input, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await send(suffix, method, input, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await send(`${suffix}?extra=1`, method, input)).status, 400);
    assert.equal((await fetch(`${base}/api/assets/${id}/${suffix}`, {
      method, headers: { 'content-type': 'application/json' }, body: '{broken',
    })).status, 400);
  }
  assert.equal((await send('favorite', 'PATCH', { favorite: true, extra: 'x'.repeat(17000) })).status, 413);
  assert.equal((await send('favorite', 'POST', { favorite: true })).status, 404);
  assert.equal((await send('recent', 'PATCH', {})).status, 404);
  assert.equal((await fetch(`${base}/api/assets/${id}/recent`)).status, 404);
  for (const query of ['view=', 'view=favorite', 'view=ALL', 'view=all&view=recent']) {
    assert.equal((await fetch(`${base}/api/library?${query}`)).status, 400, query);
  }
  assert.equal((await fetch(`${base}/api/library?view=favorites`, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal(library.list('', { view: 'favorites' }).viewTotal, 0);
  assert.equal(library.list('', { view: 'recent' }).viewTotal, 0);
});

test('HTTP state write failures report 500 and keep the last committed GET state', async t => {
  const { base, library } = await setup(t);
  await library.importFile('原图.png', await sharp({ create: { width: 3, height: 3, channels: 3, background: 'red' } }).png().toBuffer());
  const id = library.assets[0].id;
  await library.setFavorite(id, { favorite: true });
  const original = await (await fetch(`${base}/api/library`)).json();
  const statePath = path.join(library.directory, 'usage.json');
  const savedPath = path.join(library.directory, 'saved-usage.json');
  const originalBytes = await readFile(statePath);
  await rename(statePath, savedPath);
  await mkdir(statePath);
  const errors = t.mock.method(console, 'error', () => {});
  try {
    for (const [suffix, method, input] of [['favorite', 'PATCH', { favorite: false }], ['recent', 'POST', {}]]) {
      const response = await fetch(`${base}/api/assets/${id}/${suffix}`, {
        method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      assert.equal(response.status, 500);
      assert.match((await response.json()).error, /读写失败/);
      assert.deepEqual(await (await fetch(`${base}/api/library`)).json(), original);
    }
    assert.equal(errors.mock.calls.length, 2, '文件错误被服务端明确记录');
    assert.deepEqual(await readFile(savedPath), originalBytes);
  } finally {
    assert.equal(path.dirname(statePath), library.directory);
    await rm(statePath, { recursive: true });
    await rename(savedPath, statePath);
  }
});

test('HTTP trash enforces exact inputs, active write boundaries and previewable recovery', async t => {
  const { base, library } = await setup(t);
  await library.importFile('图片.png', await sharp({ create: { width: 3, height: 3, channels: 3, background: 'red' } }).png().toBuffer());
  const id = library.assets[0].id;
  const send = (suffix, method, input, headers = {}) => fetch(`${base}/api/assets/${id}${suffix}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  for (const input of [null, [], {}, { trashed: 1 }, { trashed: true, extra: true }]) {
    assert.equal((await send('/trash', 'PATCH', input)).status, 400);
  }
  assert.equal((await send('/trash?extra=1', 'PATCH', { trashed: true })).status, 400);
  assert.equal((await send('/trash', 'PATCH', { trashed: true }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await send('/trash', 'PATCH', { trashed: true }, { 'content-type': 'text/plain' })).status, 415);
  const removed = await send('/trash', 'PATCH', { trashed: true });
  assert.equal(removed.status, 200);
  assert.ok((await removed.json()).asset.deletedAt);
  assert.equal((await send('/trash', 'PATCH', { trashed: true })).status, 200);
  assert.equal((await (await fetch(`${base}/api/library`)).json()).total, 0);
  const trash = await (await fetch(`${base}/api/library?view=trash`)).json();
  assert.equal(trash.viewTotal, 1);
  assert.equal(trash.total, 0);
  for (const [suffix, method, input] of [['', 'PATCH', { name: '不保存' }], ['/favorite', 'PATCH', { favorite: true }], ['/recent', 'POST', {}]]) {
    assert.equal((await send(suffix, method, input)).status, 410);
  }
  assert.equal((await fetch(`${base}/api/assets/${id}/insertion`)).status, 410);
  assert.equal((await fetch(`${base}/api/assets/${id}/image`)).status, 200);
  assert.equal((await fetch(`${base}/api/assets/${id}/thumbnail`)).status, 200);
  assert.equal((await send('/trash', 'PATCH', { trashed: false })).status, 200);
  assert.equal((await (await fetch(`${base}/api/library`)).json()).total, 1);
});

test('HTTP directory jobs return progress, reject concurrent work and retry repaired failures', async t => {
  const { root, base, library } = await setup(t);
  const source = path.join(root, 'source');
  await mkdir(source);
  const filename = path.join(source, '损坏.png');
  await writeFile(filename, 'broken');
  const send = (pathname, input, headers = {}) => fetch(`${base}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  for (const input of [null, [], {}, { directory: source, other: true }, { directory: 'relative' }]) {
    assert.equal((await send('/api/import-jobs', input)).status, 400);
  }
  assert.equal((await send('/api/import-jobs?extra=1', { directory: source })).status, 400);
  assert.equal((await send('/api/import-jobs', { directory: source }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/import-jobs/unknown`)).status, 404);
  assert.equal((await send('/api/import-jobs/unknown/retry', { failureIds: ['unknown'] })).status, 404);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = library.importSourceFile.bind(library);
  const paused = t.mock.method(library, 'importSourceFile', async (...args) => { await gate; return original(...args); });
  const response = await send('/api/import-jobs', { directory: source });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  assert.equal(job.status, 'queued');
  assert.equal((await send('/api/import-jobs', { directory: source })).status, 409);
  assert.equal((await send('/api/import', { directory: source })).status, 409);
  assert.equal((await send(`/api/import-jobs/${job.id}/retry`, { failureIds: ['unknown'] })).status, 409);
  const progress = await (await fetch(`${base}/api/import-jobs/${job.id}`)).json();
  assert.ok(['scanning', 'importing'].includes(progress.job.status));
  release();
  async function finished(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { job: current } = await (await fetch(`${base}/api/import-jobs/${id}`)).json();
      if (['completed', 'failed'].includes(current.status)) return current;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('导入任务未及时完成');
  }
  const first = await finished(job.id);
  assert.equal(first.failed.length, 1);
  paused.mock.restore();
  await writeFile(filename, await sharp({ create: { width: 3, height: 3, channels: 3, background: 'blue' } }).png().toBuffer());
  assert.equal((await send(`/api/import-jobs/${job.id}/retry`, {})).status, 400);
  const retry = await send(`/api/import-jobs/${job.id}/retry`, { failureIds: [first.failed[0].id] });
  assert.equal(retry.status, 202);
  const result = await finished((await retry.json()).job.id);
  assert.equal(result.imported, 1);
  assert.equal(result.libraryTotal, 1);
  assert.deepEqual(result.failed, []);
});

test('HTTP insertion profiles validate all query parameters and expose only real generated files', async t => {
  const { base, library } = await setup(t);
  const bytes = await sharp({ create: { width: 2600, height: 1700, channels: 3, background: 'blue' } }).withDensity(300).jpeg().toBuffer();
  await library.importFile('照片.jpg', bytes);
  const id = library.assets[0].id, endpoint = `${base}/api/assets/${id}/insertion`;
  for (const query of ['profile=', 'profile=unknown', 'profile=CLEAR', 'profile=clear&profile=balanced', 'other=1']) {
    const response = await fetch(`${endpoint}?${query}`);
    assert.equal(response.status, 400, query);
  }
  for (const profile of ['original', 'clear', 'balanced']) {
    const response = await fetch(`${endpoint}?profile=${profile}`);
    assert.equal(response.status, 200);
    const output = await response.json(), buffer = await readFile(output.path), metadata = await sharp(buffer).metadata();
    assert.equal(output.profile, profile);
    assert.equal(output.bytes, buffer.length);
    assert.equal(output.sourceBytes, bytes.length);
    assert.equal(output.width, metadata.width);
    assert.equal(output.height, metadata.height);
    if (profile !== 'original') assert.equal(output.logicalWidthPt, 2600 * 72 / 300);
  }
  assert.equal((await (await fetch(endpoint)).json()).profile, 'original');
  assert.equal((await fetch(`${endpoint}?profile=clear`, { headers: { origin: 'https://attacker.example' } })).status, 403);
  await library.setTrash(id, { trashed: true });
  assert.equal((await fetch(`${endpoint}?profile=balanced`)).status, 410);
});
