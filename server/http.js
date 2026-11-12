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

// 远程请求（局域网客户端的本机服务转发）可用的接口；静态页面、目录导入、占位图与连接设置只供本机使用。
function remoteRoute(pathname) {
  return pathname === '/api/health' || isForwardedPath(pathname);
}

function sameKey(actual, expected) {
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

// 连接来自回环地址且 Host 是本机地址时为本机请求，沿用原有检查；其余为远程请求，只在局域网模式下凭密钥接受。
function validateRequest(request, port, accessKey) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!loopbackAddresses.has(request.socket.remoteAddress) || !allowedHosts.has(request.headers.host)) {
    return validateRemote(request, accessKey);
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

function validateRemote(request, accessKey) {
  if (!accessKey) throw new LibraryError('只接受本机地址请求', 403);
  // 转发请求由客户端本机服务发出，不带浏览器的来源标头；带这些标头的是浏览器直接访问。
  if (request.headers.origin || request.headers['sec-fetch-site'] || request.headers.referer) {
    throw new LibraryError('局域网图库不接受浏览器直接访问，请在 WPS 加载项中连接', 403);
  }
  const [scheme, token] = (request.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token || !sameKey(token, accessKey)) {
    console.warn(`iPeiTu 局域网访问被拒绝：${request.socket.remoteAddress} 未提供正确的访问密钥`);
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

export async function createServer({ dataDirectory, publicDirectory = defaultPublicDirectory, accessKey = null } = {}) {
  if (accessKey !== null && !accessKeyPattern.test(accessKey)) throw new Error('局域网访问密钥格式无效，应为 43 位 base64url 字符');
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
      const { origin, remote, client } = validateRequest(request, server.address().port, accessKey);
      const url = new URL(request.url, origin);
      if (remote && !remoteRoute(url.pathname)) throw new LibraryError('局域网客户端不能使用该接口', 403);
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
