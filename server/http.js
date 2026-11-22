import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Library, LibraryError, MAX_IMAGE_BYTES, clientIdPattern } from './library.js';
import { ImportJobs } from './import-jobs.js';
import { Placeholders } from './placeholder.js';
import { Fitter } from './fit.js';
import { Knowledge } from './knowledge.js';
import { prepareSelfCheck, removeSelfCheck } from './self-check.js';
import { API_VERSION, LanClient, accessKeyPattern, isDownloadPath, isForwardedPath } from './lan-client.js';
import { readBody as body, readJsonBody as jsonBody } from './request-body.js';

const defaultPublicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
// 健康检查用于识别端口上是不是 iPeiTu，以及是不是本目录启动的服务。
const appRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg' };

const knowledgePath = /^\/api\/knowledge\/[0-9a-f-]{36}$/;
const knowledgeTrashPath = /^\/api\/knowledge\/[0-9a-f-]{36}\/trash$/;
const knowledgeEditLockPath = /^\/api\/knowledge\/[0-9a-f-]{36}\/edit-lock$/;
const assetEditLockPath = /^\/api\/assets\/[a-f0-9]{64}\/edit-lock$/;

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function validateParameters(parameters, allowed, repeatable = []) {
  for (const key of new Set(parameters.keys())) {
    if (!allowed.includes(key)) throw new LibraryError(`不支持的请求参数：${key}`);
    if (!repeatable.includes(key) && parameters.getAll(key).length > 1) throw new LibraryError(`请求参数不能重复：${key}`);
  }
}

const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

// 远程请求（局域网客户端的本机服务转发）可用的接口：按“方法 + 完整路径”显式登记，未登记的一律拒绝。
// 新增接口默认不对远程开放；确需开放时在此显式登记，并在 test/lan.test.js 的清单一致性测试中补上示例请求。
// 静态页面、目录导入、占位图、连接设置、实机自检与任何永久删除操作只供本机使用。
// 路径与下面路由分支使用同一个 url.pathname，正则必须首尾锚定，素材与知识库编号格式与路由一致。
// 编辑锁（申请 POST、续期与释放 PATCH）对远程开放：共享图库上两台电脑互斥编辑同一素材或片段正是它的用途。
// 批量移入回收站与单张移入回收站同级、可从回收站恢复，对远程开放。
// 永久删除素材（/api/assets/batch/purge）与清空知识库回收站（/api/knowledge/trash/purge）不可恢复，只允许服务器本机操作，
// 远程请求在密钥校验通过后得到 403 与 localOnlyMessages 中的专门提示；/api/self-check 在本机临时目录建文件，只供本机。
export const remoteRoutes = Object.freeze([
  ['GET', /^\/api\/health$/],
  ['GET', /^\/api\/library$/],
  ['POST', /^\/api\/import-file$/],
  ['POST', /^\/api\/assets\/batch$/],
  ['POST', /^\/api\/assets\/batch\/trash$/],
  ['POST', assetEditLockPath],
  ['PATCH', assetEditLockPath],
  ['PATCH', /^\/api\/assets\/[a-f0-9]{64}$/],
  ['PATCH', /^\/api\/assets\/[a-f0-9]{64}\/favorite$/],
  ['POST', /^\/api\/assets\/[a-f0-9]{64}\/recent$/],
  ['PATCH', /^\/api\/assets\/[a-f0-9]{64}\/trash$/],
  ['GET', /^\/api\/assets\/[a-f0-9]{64}\/fit$/],
  ['GET', /^\/api\/assets\/[a-f0-9]{64}\/insertion$/],
  ['GET', /^\/api\/assets\/[a-f0-9]{64}\/fit\/file$/],
  ['GET', /^\/api\/assets\/[a-f0-9]{64}\/insertion\/file$/],
  ['GET', /^\/api\/assets\/[a-f0-9]{64}\/(image|thumbnail)$/],
  ['GET', /^\/api\/knowledge$/],
  ['POST', /^\/api\/knowledge$/],
  ['PATCH', knowledgePath],
  ['PATCH', knowledgeTrashPath],
  ['POST', knowledgeEditLockPath],
  ['PATCH', knowledgeEditLockPath],
].map(([method, pattern]) => Object.freeze({ method, pattern })));

// 只供本机的不可恢复操作：远程请求被拒绝时给出说明，客户端转发后原样显示这段文字。
export const localOnlyMessages = Object.freeze({
  '/api/assets/batch/purge': '永久删除素材只能在服务器那台电脑上操作；局域网客户端可以移入回收站',
  '/api/knowledge/trash/purge': '永久删除知识库片段只能在服务器那台电脑上操作；局域网客户端可以移入回收站',
});

function remoteRoute(method, pathname) {
  return remoteRoutes.some(route => route.method === method && route.pattern.test(pathname));
}

// 认证失败日志按来源地址限频：同一地址在一个窗口内最多记录一行，下一次记录时带上期间未记录的次数。
// 记录的地址数有上限，超出时淘汰最早记录的地址，服务器被扫描时内存不会无限增长。
// 默认使用单调时钟，系统时间回拨不会让某个地址长期不被记录；测试可注入 now 与 warn。
export class AuthFailureLog {
  constructor({ windowMs = 60_000, maxAddresses = 256, now = () => performance.now(), warn = message => console.warn(message) } = {}) {
    if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isSafeInteger(maxAddresses) || maxAddresses < 1) {
      throw new Error('认证失败日志的窗口须为有限正数，地址上限须为正整数');
    }
    this.windowMs = windowMs;
    this.maxAddresses = maxAddresses;
    this.now = now;
    this.warn = warn;
    this.entries = new Map();
  }

  record(address) {
    const key = String(address ?? '未知地址');
    const time = this.now();
    const entry = this.entries.get(key);
    if (entry && time - entry.loggedAt < this.windowMs) {
      entry.suppressed += 1;
      return;
    }
    const suppressed = entry?.suppressed ?? 0;
    // 先删除再写入，使 Map 的插入顺序即记录时间顺序，淘汰时取第一个即最早记录的地址。
    this.entries.delete(key);
    this.entries.set(key, { loggedAt: time, suppressed: 0 });
    while (this.entries.size > this.maxAddresses) this.entries.delete(this.entries.keys().next().value);
    const extra = suppressed ? `；上次记录后另有 ${suppressed} 次同类拒绝未逐条记录` : '';
    this.warn(`iPeiTu 局域网访问被拒绝：${key} 未提供正确的访问密钥${extra}`);
  }
}

function sameKey(actual, expected) {
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

// 连接来自回环地址且 Host 是本机地址时为本机请求，沿用原有检查；其余为远程请求，只在局域网模式下凭密钥接受。
function validateRequest(request, port, accessKey, authLog) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!loopbackAddresses.has(request.socket.remoteAddress) || !allowedHosts.has(request.headers.host)) {
    return validateRemote(request, accessKey, authLog);
  }
  const origin = `http://${request.headers.host}`;
  if (request.headers.origin && request.headers.origin !== origin) throw new LibraryError('不接受其他网站的请求', 403);
  if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) {
    throw new LibraryError('不接受其他网站的请求', 403);
  }
  if (request.headers.referer) {
    let referer;
    try { referer = new URL(request.headers.referer); } catch { throw new LibraryError('来源地址无效', 403); }
    if (referer.origin !== origin) throw new LibraryError('不接受其他网站的请求', 403);
  }
  return { origin, remote: false, client: null };
}

function validateRemote(request, accessKey, authLog) {
  if (!accessKey) throw new LibraryError('只接受本机地址请求', 403);
  // 转发请求由客户端本机服务发出，不带浏览器的来源标头；带这些标头的是浏览器直接访问。
  if (request.headers.origin || request.headers['sec-fetch-site'] || request.headers.referer) {
    throw new LibraryError('局域网图库不接受浏览器直接访问，请在 WPS 加载项中连接', 403);
  }
  const [scheme, token] = (request.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token || !sameKey(token, accessKey)) {
    authLog.record(request.socket.remoteAddress);
    throw new LibraryError('访问密钥不正确', 401);
  }
  const client = request.headers['x-ipeitu-client'];
  if (typeof client !== 'string' || !clientIdPattern.test(client)) throw new LibraryError('缺少有效的客户端标识', 400);
  return { origin: 'http://lan.invalid', remote: true, client };
}

async function sendFile(response, filePath, type) {
  const content = await readFile(filePath);
  response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
  response.end(content);
}

// 远程客户端读不到服务器上的路径：去掉 path，附上文件哈希与下载地址。
async function downloadable(result, file) {
  const { path: filePath, ...rest } = result;
  const content = await readFile(filePath);
  return { ...rest, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), file };
}

export async function createServer({ dataDirectory, publicDirectory = defaultPublicDirectory, accessKey = null, authLog = new AuthFailureLog() } = {}) {
  if (accessKey !== null && !accessKeyPattern.test(accessKey)) throw new Error('局域网访问密钥格式无效，应为 43 位 base64url 字符');
  if (!(authLog instanceof AuthFailureLog)) throw new Error('authLog 必须是 AuthFailureLog 实例');
  const library = await Library.open(dataDirectory);
  const jobs = new ImportJobs(library);
  const placeholders = new Placeholders(library.directory);
  const fitter = new Fitter(library);
  const knowledge = await Knowledge.open(library.directory);
  // 作为局域网服务器运行时不再连接其他服务器，避免一台电脑既提供又转发。
  const lan = await LanClient.open(library, { disabled: accessKey !== null });
  const importJobs = () => (lan.active ? lan.jobs : jobs);
  const importing = () => Boolean(jobs.activeId || lan.jobs.activeId);
  const publicRoot = path.resolve(publicDirectory);
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'same-origin');
    try {
      const { origin, remote, client } = validateRequest(request, server.address().port, accessKey, authLog);
      const url = new URL(request.url, origin);
      if (remote && !remoteRoute(request.method, url.pathname)) {
        throw new LibraryError(Object.hasOwn(localOnlyMessages, url.pathname) ? localOnlyMessages[url.pathname] : '局域网客户端不能使用该接口', 403);
      }
      const assetId = url.pathname.split('/')[3];
      const expectedLibrary = request.headers['x-ipeitu-library'];
      if (!remote && expectedLibrary !== undefined) {
        const source = lan.status();
        if (expectedLibrary !== (source.mode === 'local' ? 'local' : source.url)) {
          throw new LibraryError('图库来源已切换，请重新选择素材', 409);
        }
      }
      if (!remote && lan.active && isForwardedPath(url.pathname)) {
        // 已连接局域网图库：图库与知识库请求转发到服务器，插图文件下载到本机缓存。
        if (request.method === 'GET' && isDownloadPath(url.pathname)) json(response, 200, await lan.download(url));
        else await lan.forward(request, response, url);
      } else if (request.method === 'GET' && url.pathname === '/api/connection') {
        validateParameters(url.searchParams, []);
        json(response, 200, lan.status());
      } else if ((request.method === 'PUT' || request.method === 'DELETE') && url.pathname === '/api/connection') {
        validateParameters(url.searchParams, []);
        const input = request.method === 'PUT' ? await jsonBody(request) : null;
        if (importing()) throw new LibraryError('有目录导入正在进行，请等待完成后再切换图库来源', 409);
        json(response, 200, request.method === 'PUT' ? await lan.connect(input) : await lan.disconnect());
      } else if (request.method === 'GET' && url.pathname === '/api/library') {
        validateParameters(url.searchParams, ['q', 'category', 'tag', 'uncategorized', 'view', 'orientation'], ['tag']);
        const uncategorized = url.searchParams.get('uncategorized');
        if (uncategorized !== null && !['0', '1'].includes(uncategorized)) throw new LibraryError('uncategorized 仅接受 0 或 1');
        const filters = {
          category: url.searchParams.get('category') || '', tags: url.searchParams.getAll('tag'), uncategorized: uncategorized === '1',
          view: url.searchParams.get('view') ?? 'all', orientation: url.searchParams.get('orientation') ?? '',
        };
        json(response, 200, library.list(url.searchParams.get('q') || '', filters, await library.usageFor(client)));
      } else if (request.method === 'POST' && url.pathname === '/api/assets/batch') {
        validateParameters(url.searchParams, []);
        json(response, 200, await library.updateAssets(await jsonBody(request, 256 * 1024)));
      } else if (request.method === 'POST' && url.pathname === '/api/assets/batch/trash') {
        validateParameters(url.searchParams, []);
        json(response, 200, await library.trashAssets(await jsonBody(request, 128 * 1024)));
      } else if (request.method === 'POST' && url.pathname === '/api/assets/batch/purge') {
        validateParameters(url.searchParams, []);
        json(response, 200, await library.purgeAssets(await jsonBody(request, 128 * 1024)));
      } else if (['POST', 'PATCH'].includes(request.method) && assetEditLockPath.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        const input = await jsonBody(request);
        json(response, 200, request.method === 'POST'
          ? await library.acquireEditLock(assetId, input, client)
          : await library.changeEditLock(assetId, input));
      } else if (request.method === 'PATCH' && /^\/api\/assets\/[a-f0-9]{64}$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { asset: await library.updateAsset(assetId, await jsonBody(request, 128 * 1024), client) });
      } else if (request.method === 'PATCH' && /^\/api\/assets\/[a-f0-9]{64}\/favorite$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { asset: await library.setFavorite(assetId, await jsonBody(request), client) });
      } else if (request.method === 'POST' && /^\/api\/assets\/[a-f0-9]{64}\/recent$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { asset: await library.recordRecent(assetId, await jsonBody(request), client) });
      } else if (request.method === 'PATCH' && /^\/api\/assets\/[a-f0-9]{64}\/trash$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { asset: await library.setTrash(assetId, await jsonBody(request), client) });
      } else if (request.method === 'POST' && url.pathname === '/api/import-jobs') {
        validateParameters(url.searchParams, []);
        const input = await jsonBody(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
          || !Object.hasOwn(input, 'directory')) throw new LibraryError('目录导入仅接受 directory 字段');
        json(response, 202, { job: await importJobs().create(input.directory) });
      } else if (request.method === 'GET' && /^\/api\/import-jobs\/[^/]+$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { job: importJobs().get(url.pathname.split('/')[3]) });
      } else if (request.method === 'POST' && /^\/api\/import-jobs\/[^/]+\/retry$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 202, { job: await importJobs().retry(url.pathname.split('/')[3], await jsonBody(request, 64 * 1024)) });
      } else if (request.method === 'POST' && url.pathname === '/api/import') {
        validateParameters(url.searchParams, []);
        const input = await jsonBody(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'directory')) {
          throw new LibraryError('目录导入仅接受 directory 字段');
        }
        json(response, 200, await importJobs().importDirectory(input.directory));
      } else if (request.method === 'POST' && url.pathname === '/api/self-check') {
        validateParameters(url.searchParams, []);
        json(response, 201, await prepareSelfCheck());
      } else if (request.method === 'DELETE' && /^\/api\/self-check\/[0-9a-f-]{36}$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        await removeSelfCheck(url.pathname.split('/')[3]);
        json(response, 200, { removed: true });
      } else if (request.method === 'POST' && url.pathname === '/api/placeholders') {
        validateParameters(url.searchParams, []);
        json(response, 200, await placeholders.create(await jsonBody(request)));
      } else if (request.method === 'POST' && url.pathname === '/api/import-file') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw new LibraryError('图片上传需要 application/octet-stream', 415);
        validateParameters(url.searchParams, ['name', 'category']);
        json(response, 200, await library.importFile(url.searchParams.get('name'), await body(request, MAX_IMAGE_BYTES), url.searchParams.get('category') ?? undefined));
      } else if (request.method === 'GET' && /^\/api\/assets\/[a-f0-9]{64}\/fit$/.test(url.pathname)) {
        validateParameters(url.searchParams, ['mode', 'widthPt', 'heightPt', 'profile']);
        const fitted = await fitter.create(assetId, Object.fromEntries(url.searchParams));
        json(response, 200, remote ? await downloadable(fitted, `/api/assets/${assetId}/fit/file${url.search}`) : fitted);
      } else if (request.method === 'GET' && /^\/api\/assets\/[a-f0-9]{64}\/insertion$/.test(url.pathname)) {
        validateParameters(url.searchParams, ['profile']);
        const insertion = await library.insertion(assetId, url.searchParams.get('profile') ?? 'original');
        json(response, 200, remote ? await downloadable(insertion, `/api/assets/${assetId}/insertion/file?profile=${encodeURIComponent(insertion.profile)}`) : insertion);
      } else if (request.method === 'GET' && /^\/api\/assets\/[a-f0-9]{64}\/fit\/file$/.test(url.pathname)) {
        validateParameters(url.searchParams, ['mode', 'widthPt', 'heightPt', 'profile']);
        const fitted = await fitter.create(assetId, Object.fromEntries(url.searchParams));
        await sendFile(response, fitted.path, `image/${fitted.format}`);
      } else if (request.method === 'GET' && /^\/api\/assets\/[a-f0-9]{64}\/insertion\/file$/.test(url.pathname)) {
        validateParameters(url.searchParams, ['profile']);
        const insertion = await library.insertion(assetId, url.searchParams.get('profile') ?? 'original');
        await sendFile(response, insertion.path, `image/${insertion.format}`);
      } else if (request.method === 'GET' && /^\/api\/assets\/[a-f0-9]{64}\/(image|thumbnail)$/.test(url.pathname)) {
        const file = await library.file(assetId, url.pathname.split('/')[4]);
        await sendFile(response, file.path, file.type);
      } else if (request.method === 'GET' && url.pathname === '/api/knowledge') {
        validateParameters(url.searchParams, ['q', 'type', 'section', 'view']);
        json(response, 200, knowledge.list(Object.fromEntries(url.searchParams)));
      } else if (request.method === 'POST' && url.pathname === '/api/knowledge') {
        validateParameters(url.searchParams, []);
        json(response, 201, { snippet: await knowledge.create(await jsonBody(request, 128 * 1024)) });
      } else if (request.method === 'POST' && url.pathname === '/api/knowledge/trash/purge') {
        validateParameters(url.searchParams, []);
        json(response, 200, await knowledge.purgeTrash(await jsonBody(request, 256 * 1024)));
      } else if (['POST', 'PATCH'].includes(request.method) && knowledgeEditLockPath.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        const id = url.pathname.split('/')[3];
        const input = await jsonBody(request);
        const result = request.method === 'POST'
          ? await knowledge.acquireEditLock(id, input)
          : await knowledge.changeEditLock(id, input);
        json(response, 200, result);
      } else if (request.method === 'PATCH' && knowledgePath.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { snippet: await knowledge.update(url.pathname.split('/')[3], await jsonBody(request, 128 * 1024)) });
      } else if (request.method === 'PATCH' && knowledgeTrashPath.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { snippet: await knowledge.setTrash(url.pathname.split('/')[3], await jsonBody(request)) });
      } else if (request.method === 'GET' && url.pathname === '/api/health') {
        validateParameters(url.searchParams, []);
        // 远程健康检查不返回进程号与安装路径，只返回连接所需信息。
        json(response, 200, remote
          ? { service: 'iPeiTu', version, api: API_VERSION, lan: true, total: library.activeTotal }
          : { service: 'iPeiTu', version, api: API_VERSION, lan: accessKey !== null, pid: process.pid, root: appRoot });
      } else if (url.pathname.startsWith('/api/')) {
        throw new LibraryError('接口不存在', 404);
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        let pathname;
        try { pathname = decodeURIComponent(url.pathname); } catch { throw new LibraryError('地址编码无效'); }
        if (pathname.includes('\0') || pathname.includes('\\')) throw new LibraryError('文件不存在', 404);
        const candidate = path.resolve(publicRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!candidate.startsWith(`${publicRoot}${path.sep}`)) throw new LibraryError('文件不存在', 404);
        let resolved;
        try { resolved = await realpath(candidate); } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new LibraryError('文件不存在', 404);
          throw error;
        }
        const actualRoot = await realpath(publicRoot);
        if (!resolved.startsWith(`${actualRoot}${path.sep}`) || !(await stat(resolved)).isFile()) throw new LibraryError('文件不存在', 404);
        const file = await readFile(resolved);
        response.writeHead(200, { 'Content-Type': contentTypes[path.extname(resolved)] || 'application/octet-stream', 'Content-Length': file.length });
        response.end(request.method === 'HEAD' ? undefined : file);
      } else {
        throw new LibraryError('不支持该请求方法', 405);
      }
    } catch (error) {
      if (!(error instanceof LibraryError)) console.error('iPeiTu 请求失败:', error);
      if (!response.headersSent) json(response, error.status || 500, { error: error instanceof LibraryError ? error.message : '本地图库读写失败，请查看服务窗口中的错误并重试' });
      else response.destroy(error);
    }
  });
  server.requestTimeout = 120_000;
  return { server, library, jobs, knowledge, lan };
}

// host 默认只监听本机；局域网模式监听 0.0.0.0，必须同时提供访问密钥。
export async function startServer({ port = 39831, host = '127.0.0.1', ...options } = {}) {
  if (!loopbackHosts.has(host) && !accessKeyPattern.test(options.accessKey ?? '')) {
    throw new Error('局域网模式需要访问密钥，请运行“局域网服务器.cmd”生成');
  }
  const result = await createServer(options);
  await new Promise((resolve, reject) => {
    result.server.once('error', reject);
    result.server.listen(port, host, resolve);
  });
  return result;
}

// 端口被占用时判断占用者是否为 iPeiTu；无法连接或不是 iPeiTu 时返回 null。
export async function probeService(port, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.service === 'iPeiTu' ? data : null;
  } catch {
    return null;
  }
}
