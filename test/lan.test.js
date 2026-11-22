import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AuthFailureLog, remoteRoutes, startServer } from '../server/http.js';
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
const ASSET = 'a'.repeat(64);
const SNIPPET = randomUUID();
const REMOTE_DENIED = '局域网客户端不能使用该接口';

// 白名单每一项的示例请求；白名单新增一项而这里没有对应示例时，清单一致性测试会失败。
const remoteSamples = [
  ['GET', '/api/health'], ['GET', '/api/library'], ['POST', '/api/import-file'], ['POST', '/api/assets/batch'],
  ['PATCH', `/api/assets/${ASSET}`], ['PATCH', `/api/assets/${ASSET}/favorite`], ['POST', `/api/assets/${ASSET}/recent`],
  ['PATCH', `/api/assets/${ASSET}/trash`], ['GET', `/api/assets/${ASSET}/fit`], ['GET', `/api/assets/${ASSET}/insertion`],
  ['GET', `/api/assets/${ASSET}/fit/file`], ['GET', `/api/assets/${ASSET}/insertion/file`], ['GET', `/api/assets/${ASSET}/image`],
  ['GET', `/api/assets/${ASSET}/thumbnail`], ['GET', '/api/knowledge'], ['POST', '/api/knowledge'],
  ['PATCH', `/api/knowledge/${SNIPPET}`], ['PATCH', `/api/knowledge/${SNIPPET}/trash`],
];

// 持有正确密钥也不能使用的接口：本机专用接口、永久删除、方法不符与路径变形。
const remoteForbidden = [
  ['GET', '/'], ['GET', '/taskpane.html'], ['POST', '/api/import-jobs'], ['GET', `/api/import-jobs/${SNIPPET}`], ['POST', '/api/import'],
  ['POST', '/api/placeholders'], ['GET', '/api/connection'], ['PUT', '/api/connection'], ['DELETE', '/api/connection'],
  ['POST', '/api/assets/batch/purge'], ['POST', '/api/assets/batch/trash'], ['POST', '/api/knowledge/trash/purge'],
  ['DELETE', `/api/assets/${ASSET}`], ['DELETE', '/api/library'], ['DELETE', `/api/knowledge/${SNIPPET}`],
  ['GET', '/api/assets/batch'], ['PUT', `/api/assets/${ASSET}/favorite`], ['POST', '/api/health'], ['HEAD', '/api/health'],
  ['GET', '/api/library/'], ['GET', '/API/library'], ['GET', '/api/assets/../connection'], ['PATCH', `/api/assets/${ASSET}%2Ftrash`],
  ['PATCH', `/api/assets/${ASSET.toUpperCase()}`], ['GET', `/api/assets/${ASSET}/image/`], ['GET', '/api/unknown'],
];

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
  for (const [method, pathname] of remoteForbidden) {
    const response = await call(base, pathname, { method, headers: remote() });
    assert.equal(response.status, 403, `${method} ${pathname}`);
    if (method !== 'HEAD') assert.equal(response.json?.error, REMOTE_DENIED, `${method} ${pathname}`);
  }
  // 未带密钥或密钥错误时先得到 401，不因白名单泄露接口是否存在。
  for (const [method, pathname] of [['POST', '/api/assets/batch/purge'], ['DELETE', `/api/assets/${ASSET}`], ['GET', '/api/connection'],
    ['GET', '/taskpane.html'], ['GET', '/api/unknown'], ['GET', '/api/library']]) {
    assert.equal((await call(base, pathname, { method })).status, 401, `无密钥 ${method} ${pathname}`);
    const wrong = await call(base, pathname, { method, headers: remote(randomBytes(32).toString('base64url')) });
    assert.equal(wrong.status, 401, `密钥错误 ${method} ${pathname}`);
    assert.equal(wrong.json?.error, '访问密钥不正确');
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

test('the remote allowlist matches its sample requests one to one', () => {
  for (const route of remoteRoutes) {
    assert.ok(remoteSamples.some(([method, pathname]) => method === route.method && route.pattern.test(pathname)),
      `白名单 ${route.method} ${route.pattern} 缺少示例请求`);
  }
  for (const [method, pathname] of remoteSamples) {
    assert.equal(remoteRoutes.filter(route => route.method === method && route.pattern.test(pathname)).length, 1, `${method} ${pathname}`);
  }
  for (const [method, pathname] of remoteForbidden) {
    const { pathname: normalized } = new URL(pathname, 'http://lan.invalid');
    assert.equal(remoteRoutes.some(route => route.method === method && route.pattern.test(normalized)), false, `${method} ${pathname}`);
  }
  assert.equal(Object.isFrozen(remoteRoutes), true);
});

test('every allowlisted endpoint reaches its route for a keyed remote client', { skip }, async t => {
  const directory = await temporary(t);
  const upstream = await serve(t, { host: '0.0.0.0', accessKey: KEY, dataDirectory: directory });
  for (const [method, pathname] of remoteSamples) {
    const options = method === 'GET' ? { method, headers: remote() }
      : { method, headers: { ...remote(), 'content-type': 'application/json' }, body: '{}' };
    const response = await call(upstream.remoteBase, pathname, options);
    assert.notEqual(response.status, 401, `${method} ${pathname}`);
    assert.notEqual(response.status, 403, `${method} ${pathname}：${response.json?.error}`);
    assert.notEqual(response.json?.error, REMOTE_DENIED, `${method} ${pathname}`);
    assert.notEqual(response.json?.error, '接口不存在', `${method} ${pathname} 在白名单中却没有对应路由`);
  }
});

test('authentication failures are logged at most once per address per window', () => {
  let time = 0;
  const lines = [];
  const log = new AuthFailureLog({ windowMs: 60_000, maxAddresses: 3, now: () => time, warn: line => lines.push(line) });
  for (let attempt = 0; attempt < 5; attempt++) log.record('10.0.0.5');
  assert.equal(lines.length, 1, '连续错误只记录一行');
  assert.match(lines[0], /10\.0\.0\.5 未提供正确的访问密钥$/);
  time = 59_999;
  log.record('10.0.0.5');
  assert.equal(lines.length, 1, '窗口内继续抑制');
  time = 60_000;
  log.record('10.0.0.5');
  assert.equal(lines.length, 2, '窗口过后再次记录');
  assert.match(lines[1], /10\.0\.0\.5/);
  assert.match(lines[1], /另有 5 次同类拒绝未逐条记录/);
  time = 60_001;
  log.record('10.0.0.5');
  assert.equal(lines.length, 2);
  time = 120_000;
  log.record('10.0.0.5');
  assert.match(lines[2], /另有 1 次/, '每次记录后抑制计数重新开始');

  log.record('10.0.0.6');
  assert.equal(lines.length, 4, '不同地址各自记录');
  assert.doesNotMatch(lines[3], /另有/);
  log.record('10.0.0.7');
  log.record('10.0.0.8');
  assert.equal(log.entries.size, 3, '地址数不超过上限');
  assert.equal(log.entries.has('10.0.0.5'), false, '淘汰最早记录的地址');
  assert.deepEqual([...log.entries.keys()], ['10.0.0.6', '10.0.0.7', '10.0.0.8']);
  for (let index = 0; index < 1000; index++) log.record(`10.1.${index >> 8}.${index & 255}`);
  assert.equal(log.entries.size, 3, '被大量地址扫描时仍有上限');
  assert.equal(lines.length, 1006);

  assert.throws(() => new AuthFailureLog({ windowMs: 0 }), /正数/);
  assert.throws(() => new AuthFailureLog({ maxAddresses: 0 }), /正数/);
});

test('the LAN server rate-limits warnings for repeated wrong keys', { skip }, async t => {
  const directory = await temporary(t);
  let time = 0;
  const lines = [];
  const authLog = new AuthFailureLog({ windowMs: 60_000, now: () => time, warn: line => lines.push(line) });
  const upstream = await serve(t, { host: '0.0.0.0', accessKey: KEY, dataDirectory: directory, authLog });
  const wrongKey = randomBytes(32).toString('base64url');
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal((await call(upstream.remoteBase, '/api/health', { headers: remote(wrongKey) })).status, 401);
  }
  assert.equal((await call(upstream.remoteBase, '/api/assets/batch/purge', { method: 'POST' })).status, 401);
  assert.equal(lines.length, 1, '同一来源的连续认证失败只记录一行');
  assert.match(lines[0], /^iPeiTu 局域网访问被拒绝：\S+ 未提供正确的访问密钥$/);
  assert.equal((await call(upstream.remoteBase, '/api/health', { headers: remote() })).status, 200, '正确密钥不受限频影响');
  assert.equal(lines.length, 1);
  time = 60_000;
  assert.equal((await call(upstream.remoteBase, '/api/health', { headers: remote(wrongKey) })).status, 401);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /另有 4 次同类拒绝未逐条记录/);
  await assert.rejects(startServer({ port: 0, dataDirectory: directory, authLog: { record() {} } }), /AuthFailureLog/);
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
