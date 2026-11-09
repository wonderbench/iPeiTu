import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startServer } from '../server/http.js';
import { Library } from '../server/library.js';
import { normalizeServerUrl } from '../server/lan-client.js';

// 局域网测试经本机的局域网地址访问服务，使连接来源不是回环地址，与另一台电脑访问的检查路径相同。
function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) return entry.address;
    }
  }
  return null;
}
const lanIp = lanAddress();
const skip = lanIp ? false : '本机没有可用的局域网 IPv4 地址，无法模拟另一台电脑的访问';
const KEY = randomBytes(32).toString('base64url');
const CLIENT_A = randomUUID();
const CLIENT_B = randomUUID();
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const png = (color, width = 120, height = 90) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-lan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// 启动一个服务；系统分配的端口偶尔落在 Fetch 禁用的端口上，换一个重试。
async function serve(t, options) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const started = await startServer({ port: 0, ...options });
    const { port } = started.server.address();
    const close = async () => {
      if (!started.server.listening) return;
      started.server.closeAllConnections();
      await new Promise(resolve => started.server.close(resolve));
    };
    try {
      await (await fetch(`http://127.0.0.1:${port}/api/health`)).arrayBuffer();
      t.after(close);
      return { ...started, port, close, base: `http://127.0.0.1:${port}`, remoteBase: `http://${lanIp}:${port}` };
    } catch (error) {
      await close();
      if (error.cause?.message !== 'bad port' || attempt === 9) throw error;
    }
  }
  throw new Error('无法分配测试端口');
}

function call(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = http.request({ hostname: url.hostname, port: url.port, path: pathname, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buffer.toString('utf8')); } catch { /* 图片等二进制响应 */ }
        resolve({ status: response.statusCode, type: response.headers['content-type'], buffer, json });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

const remote = (key = KEY, client = CLIENT_A) => ({ authorization: `Bearer ${key}`, 'x-ipeitu-client': client });
const jsonRequest = (method, value) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

test('normalizes server addresses and refuses loopback or unsupported forms', () => {
  assert.equal(normalizeServerUrl('192.168.1.10'), 'http://192.168.1.10:39831', '未写端口时使用默认端口');
  assert.equal(normalizeServerUrl(' http://192.168.1.10:8080/ '), 'http://192.168.1.10:8080');
  assert.equal(normalizeServerUrl('tuku.lan:39831'), 'http://tuku.lan:39831');
  for (const bad of ['', '   ', 'localhost', '127.0.0.1', 'http://127.0.0.5:39831', '[::1]', '0.0.0.0',
    'http://user:pass@192.168.1.10', 'http://192.168.1.10/api', 'http://192.168.1.10?x=1', 'ftp://192.168.1.10', '192.168.1.10 x', 1]) {
    assert.throws(() => normalizeServerUrl(bad), { status: 400 }, String(bad));
  }
});

test('per-client favorites and recent records persist separately from this computer', async t => {
  const directory = await temporary(t);
  const library = await Library.open(directory);
  await library.importFile('沟槽.png', await png('#227766'));
  const [{ id }] = library.list().assets;
  assert.equal((await library.setFavorite(id, { favorite: true }, CLIENT_A)).favorite, true);
  assert.equal((await library.recordRecent(id, {}, CLIENT_A)).lastInsertedAt !== null, true);
  await assert.rejects(access(path.join(directory, 'usage.json')), '本机记录不受客户端影响');
  assert.equal(library.list('', {}).assets[0].favorite, false);
  assert.equal(library.list('', { view: 'favorites' }, await library.usageFor(CLIENT_A)).assets.length, 1);
  assert.equal(library.list('', { view: 'favorites' }, await library.usageFor(CLIENT_B)).assets.length, 0);
  assert.equal((await library.updateAsset(id, { name: '沟槽开挖' }, CLIENT_A)).favorite, true);

  const reopened = await Library.open(directory);
  const usage = await reopened.usageFor(CLIENT_A);
  assert.deepEqual(usage.favorites, [id]);
  assert.equal(usage.recent[0].id, id);

  const damaged = path.join(directory, 'clients', `${CLIENT_B}.json`);
  await writeFile(damaged, '{broken');
  await assert.rejects(reopened.usageFor(CLIENT_B), { status: 500, message: /已损坏/ });
  await assert.rejects(reopened.setFavorite(id, { favorite: true }, CLIENT_B), { status: 500 });
  assert.equal(await readFile(damaged, 'utf8'), '{broken', '损坏的客户端记录不被覆盖');
  assert.equal((await reopened.usageFor(CLIENT_A)).favorites.length, 1, '其他客户端不受影响');
  for (const bad of ['', 'not-a-uuid', CLIENT_A.toUpperCase()]) await assert.rejects(reopened.usageFor(bad), { status: 400 });
});

test('LAN mode requires a valid access key before listening beyond this computer', async t => {
  const directory = await temporary(t);
  await assert.rejects(startServer({ port: 0, host: '0.0.0.0', dataDirectory: directory }), /访问密钥/);
  await assert.rejects(startServer({ port: 0, host: '0.0.0.0', dataDirectory: directory, accessKey: 'short' }), /访问密钥/);
});

test('LAN server accepts only keyed relay requests from other addresses', { skip }, async t => {
  const directory = await temporary(t);
  const upstream = await serve(t, { host: '0.0.0.0', accessKey: KEY, dataDirectory: directory });
  const local = await call(upstream.base, '/api/health');
  assert.equal(local.status, 200, '本机访问不需要密钥');
  assert.equal(local.json.lan, true);
  assert.equal(typeof local.json.pid, 'number');

  const base = upstream.remoteBase;
  assert.equal((await call(base, '/api/health')).status, 401, '没有密钥');
  assert.equal((await call(base, '/api/health', { headers: remote(randomBytes(32).toString('base64url')) })).status, 401, '密钥错误');
  assert.equal((await call(base, '/api/health', { headers: { authorization: `Bearer ${KEY}` } })).status, 400, '缺少客户端标识');
  assert.equal((await call(base, '/api/health', { headers: { ...remote(), origin: base } })).status, 403, '浏览器直接访问');
  assert.equal((await call(base, '/api/health', { headers: { ...remote(), 'sec-fetch-site': 'cross-site' } })).status, 403);
  const health = await call(base, '/api/health', { headers: remote() });
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.json).sort(), ['api', 'lan', 'service', 'total', 'version'], '远程不返回进程号与安装路径');
  for (const [method, pathname] of [['GET', '/'], ['GET', '/taskpane.html'], ['POST', '/api/import-jobs'], ['POST', '/api/import'],
    ['POST', '/api/placeholders'], ['GET', '/api/connection'], ['PUT', '/api/connection']]) {
    assert.equal((await call(base, pathname, { method, headers: remote() })).status, 403, `${method} ${pathname}`);
  }

  const bytes = await png('#336699');
  const upload = await call(base, `/api/import-file?name=${encodeURIComponent('管沟.png')}`, {
    method: 'POST', headers: { ...remote(), 'content-type': 'application/octet-stream' }, body: bytes,
  });
  assert.equal(upload.status, 200);
  assert.equal(upload.json.imported, 1);
  const id = sha256(bytes);

  const insertion = await call(base, `/api/assets/${id}/insertion?profile=original`, { headers: remote() });
  assert.equal(insertion.status, 200);
  assert.equal(Object.hasOwn(insertion.json, 'path'), false, '远程不返回服务器路径');
  assert.match(insertion.json.sha256, /^[a-f0-9]{64}$/);
  const file = await call(base, insertion.json.file, { headers: remote() });
  assert.equal(file.status, 200);
  assert.equal(file.type, 'image/png');
  assert.equal(sha256(file.buffer), insertion.json.sha256);
  assert.equal(file.buffer.length, insertion.json.bytes);
  const fitted = await call(base, `/api/assets/${id}/fit?mode=contain&widthPt=144&heightPt=72`, { headers: remote() });
  assert.equal(fitted.status, 200);
  assert.equal(Object.hasOwn(fitted.json, 'path'), false);
  assert.equal(sha256((await call(base, fitted.json.file, { headers: remote() })).buffer), fitted.json.sha256);

  const favorite = await call(base, `/api/assets/${id}/favorite`, { ...jsonRequest('PATCH', { favorite: true }), headers: { ...remote(), 'content-type': 'application/json' } });
  assert.equal(favorite.json.asset.favorite, true);
  const listB = await call(base, '/api/library?view=favorites', { headers: remote(KEY, CLIENT_B) });
  assert.equal(listB.json.viewTotal, 0, '另一台电脑的收藏不受影响');
  assert.equal((await call(upstream.base, '/api/library?view=favorites')).json.viewTotal, 0, '服务器本机的收藏不受影响');
  await access(path.join(directory, 'clients', `${CLIENT_A}.json`));
});

test('a client relays the library, caches insertion files and uploads folder imports to the LAN server', { skip }, async t => {
  const upstreamDirectory = await temporary(t);
  const upstream = await serve(t, { host: '0.0.0.0', accessKey: KEY, dataDirectory: upstreamDirectory });
  const first = await png('#aa3344');
  await upstream.library.importFile('基坑.png', first);
  const firstId = sha256(first);
  const clientDirectory = await temporary(t);
  const relay = await serve(t, { dataDirectory: path.join(clientDirectory, 'a') });
  const other = await serve(t, { dataDirectory: path.join(clientDirectory, 'b') });
  const serverUrl = upstream.remoteBase;

  assert.deepEqual((await call(relay.base, '/api/connection')).json, { mode: 'local', url: null, lanServer: false });
  let response = await call(relay.base, '/api/connection', jsonRequest('PUT', { url: serverUrl, key: randomBytes(32).toString('base64url') }));
  assert.equal(response.status, 400);
  assert.match(response.json.error, /访问密钥不正确/);
  response = await call(relay.base, '/api/connection', jsonRequest('PUT', { url: `127.0.0.1:${upstream.port}`, key: KEY }));
  assert.equal(response.status, 400);
  assert.match(response.json.error, /本机地址/);
  response = await call(relay.base, '/api/connection', jsonRequest('PUT', { url: serverUrl, key: 'x' }));
  assert.equal(response.status, 400);
  await assert.rejects(access(path.join(clientDirectory, 'a', 'connection.json')), '连接失败不保存配置');
  assert.equal((await call(upstream.base, '/api/connection', jsonRequest('PUT', { url: serverUrl, key: KEY }))).status, 409, '服务器本身不能再连接其他服务器');

  response = await call(relay.base, '/api/connection', jsonRequest('PUT', { url: serverUrl, key: ` ${KEY} ` }));
  assert.equal(response.status, 200, response.json?.error);
  assert.deepEqual(response.json, { mode: 'lan', url: serverUrl, lanServer: false });
  const saved = JSON.parse(await readFile(path.join(clientDirectory, 'a', 'connection.json'), 'utf8'));
  assert.equal(saved.key, KEY);
  assert.equal(JSON.stringify((await call(relay.base, '/api/connection')).json).includes(KEY), false, '读取连接状态不返回密钥');
  assert.equal((await call(other.base, '/api/connection', jsonRequest('PUT', { url: serverUrl, key: KEY }))).status, 200);

  const list = await call(relay.base, '/api/library');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.assets.map(asset => asset.id), [firstId], '列出服务器上的素材');
  const thumbnail = await call(relay.base, list.json.assets[0].thumbnailUrl);
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.type, 'image/jpeg');

  const second = await png('#22aa44', 80, 160);
  response = await call(relay.base, `/api/import-file?name=${encodeURIComponent('竖图.png')}&category=${encodeURIComponent('土建')}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: second,
  });
  assert.equal(response.json.imported, 1);
  assert.equal(upstream.library.activeTotal, 2, '经客户端上传到服务器');
  assert.deepEqual(upstream.library.getAsset(sha256(second)).categories, ['土建']);

  response = await call(relay.base, `/api/assets/${firstId}/favorite`, jsonRequest('PATCH', { favorite: true }));
  assert.equal(response.json.asset.favorite, true);
  assert.equal((await call(other.base, '/api/library?view=favorites')).json.viewTotal, 0, '两台客户端的收藏分开');
  assert.equal((await call(relay.base, '/api/library?view=favorites')).json.viewTotal, 1);

  response = await call(relay.base, `/api/assets/${firstId}/insertion?profile=original`);
  assert.equal(response.status, 200, response.json?.error);
  const cache = path.join(clientDirectory, 'a', 'lan-cache');
  assert.equal(path.dirname(response.json.path), cache, '插图文件位于本机缓存');
  const upstreamInsertion = await upstream.library.insertion(firstId, 'original');
  assert.deepEqual(await readFile(response.json.path), await readFile(upstreamInsertion.path));
  assert.equal(response.json.name, '基坑.png');
  assert.equal((await call(relay.base, `/api/assets/${firstId}/insertion?profile=original`)).json.path, response.json.path, '再次插入复用缓存');
  response = await call(relay.base, `/api/assets/${firstId}/fit?mode=cover&widthPt=144&heightPt=72`);
  assert.equal(response.status, 200, response.json?.error);
  assert.equal(path.dirname(response.json.path), cache);
  assert.deepEqual([response.json.mode, response.json.widthPt], ['cover', 144]);
  assert.equal((await call(relay.base, `/api/assets/${'0'.repeat(64)}/insertion`)).status, 404, '服务器的错误原样返回');

  response = await call(relay.base, '/api/placeholders', jsonRequest('POST', { name: '图1', widthPt: 144, heightPt: 72 }));
  assert.equal(response.status, 200);
  assert.ok(response.json.path.startsWith(path.join(clientDirectory, 'a')), '占位图在本机生成');

  response = await call(relay.base, '/api/knowledge', jsonRequest('POST', { title: '交通导改', type: '市政道路管网', section: '交通导改', tags: [], body: '设置围挡。' }));
  assert.equal(response.status, 201);
  assert.equal(upstream.knowledge.list().total, 1, '知识库片段保存在服务器');
  assert.equal((await call(other.base, '/api/knowledge')).json.total, 1, '另一台客户端看到同一份知识库');

  const folder = path.join(clientDirectory, 'source');
  await mkdir(path.join(folder, '机电'), { recursive: true });
  const third = await png('#7744aa', 60, 60);
  await writeFile(path.join(folder, '机电', '桥架.png'), third);
  response = await call(relay.base, '/api/import-jobs', jsonRequest('POST', { directory: folder }));
  assert.equal(response.status, 202, response.json?.error);
  let job = response.json.job;
  for (let attempt = 0; attempt < 100 && !['completed', 'failed'].includes(job.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    job = (await call(relay.base, `/api/import-jobs/${job.id}`)).json.job;
  }
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.imported, 1);
  assert.equal(job.libraryTotal, 3, '导入计数取自服务器');
  assert.deepEqual(upstream.library.getAsset(sha256(third)).categories, ['机电'], '文件夹仍映射为分类');
  assert.equal(relay.library.activeTotal, 0, '没有写入客户端本机图库');

  relay.lan.jobs.activeId = 'busy';
  assert.equal((await call(relay.base, '/api/connection', { method: 'DELETE' })).status, 409, '导入进行中不能切换');
  relay.lan.jobs.activeId = null;

  await upstream.close();
  response = await call(relay.base, '/api/library');
  assert.equal(response.status, 502);
  assert.match(response.json.error, /无法连接局域网图库/);

  response = await call(relay.base, '/api/connection', { method: 'DELETE' });
  assert.deepEqual(response.json, { mode: 'local', url: null, lanServer: false });
  assert.equal((await call(relay.base, '/api/library')).json.total, 0, '切回本机图库');
  await assert.rejects(access(path.join(clientDirectory, 'a', 'connection.json')));
});

test('a damaged connection file is reported instead of silently using the local library', async t => {
  const directory = await temporary(t);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'connection.json'), '{broken');
  const relay = await serve(t, { dataDirectory: directory });
  const status = (await call(relay.base, '/api/connection')).json;
  assert.equal(status.mode, 'lan');
  assert.match(status.error, /connection\.json 已损坏/);
  const list = await call(relay.base, '/api/library');
  assert.equal(list.status, 500);
  assert.match(list.json.error, /connection\.json 已损坏/);
  assert.equal(await readFile(path.join(directory, 'connection.json'), 'utf8'), '{broken');
  assert.deepEqual((await call(relay.base, '/api/connection', { method: 'DELETE' })).json, { mode: 'local', url: null, lanServer: false });
  assert.equal((await call(relay.base, '/api/library')).status, 200);
});
