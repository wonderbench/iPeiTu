import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library, LibraryError, MAX_IMAGE_BYTES } from './library.js';
import { ImportJobs } from './import-jobs.js';
import { Placeholders } from './placeholder.js';
import { Fitter } from './fit.js';

const defaultPublicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg' };

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function body(request, limit) {
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw new LibraryError('请求超过允许大小', 413);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) {
      request.resume();
      throw new LibraryError('请求超过允许大小', 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request, limit = 16 * 1024) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new LibraryError('需要 JSON 请求', 415);
  try { return JSON.parse((await body(request, limit)).toString('utf8')); } catch (error) {
    if (error instanceof LibraryError) throw error;
    throw new LibraryError('请求不是有效 JSON');
  }
}

function validateParameters(parameters, allowed, repeatable = []) {
  for (const key of new Set(parameters.keys())) {
    if (!allowed.includes(key)) throw new LibraryError(`不支持的请求参数：${key}`);
    if (!repeatable.includes(key) && parameters.getAll(key).length > 1) throw new LibraryError(`请求参数不能重复：${key}`);
  }
}

function validateRequest(request, port) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(request.headers.host)) throw new LibraryError('只接受本机地址请求', 403);
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
  return origin;
}

export async function createServer({ dataDirectory, publicDirectory = defaultPublicDirectory } = {}) {
  const library = await Library.open(dataDirectory);
  const jobs = new ImportJobs(library);
  const placeholders = new Placeholders(library.directory);
  const fitter = new Fitter(library);
  const publicRoot = path.resolve(publicDirectory);
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'same-origin');
    try {
      const origin = validateRequest(request, server.address().port);
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && url.pathname === '/api/library') {
        validateParameters(url.searchParams, ['q', 'category', 'tag', 'uncategorized', 'view'], ['tag']);
        const uncategorized = url.searchParams.get('uncategorized');
        if (uncategorized !== null && !['0', '1'].includes(uncategorized)) throw new LibraryError('uncategorized 仅接受 0 或 1');
        json(response, 200, library.list(url.searchParams.get('q') || '', {
          category: url.searchParams.get('category') || '', tags: url.searchParams.getAll('tag'), uncategorized: uncategorized === '1',
          view: url.searchParams.get('view') ?? 'all',
        }));
      } else if (request.method === 'PATCH' && /^\/api\/assets\/[a-f0-9]{64}$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { asset: await library.updateAsset(url.pathname.split('/')[3], await jsonBody(request, 128 * 1024)) });
      } else if (request.method === 'PATCH' && /^\/api\/assets\/[a-f0-9]{64}\/favorite$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { asset: await library.setFavorite(url.pathname.split('/')[3], await jsonBody(request)) });
      } else if (request.method === 'POST' && /^\/api\/assets\/[a-f0-9]{64}\/recent$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { asset: await library.recordRecent(url.pathname.split('/')[3], await jsonBody(request)) });
      } else if (request.method === 'PATCH' && /^\/api\/assets\/[a-f0-9]{64}\/trash$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { asset: await library.setTrash(url.pathname.split('/')[3], await jsonBody(request)) });
      } else if (request.method === 'POST' && url.pathname === '/api/import-jobs') {
        validateParameters(url.searchParams, []);
        const input = await jsonBody(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
          || !Object.hasOwn(input, 'directory')) throw new LibraryError('目录导入仅接受 directory 字段');
        json(response, 202, { job: await jobs.create(input.directory) });
      } else if (request.method === 'GET' && /^\/api\/import-jobs\/[^/]+$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 200, { job: jobs.get(url.pathname.split('/')[3]) });
      } else if (request.method === 'POST' && /^\/api\/import-jobs\/[^/]+\/retry$/.test(url.pathname)) {
        validateParameters(url.searchParams, []);
        json(response, 202, { job: await jobs.retry(url.pathname.split('/')[3], await jsonBody(request, 64 * 1024)) });
      } else if (request.method === 'POST' && url.pathname === '/api/import') {
        validateParameters(url.searchParams, []);
        const input = await jsonBody(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'directory')) {
          throw new LibraryError('目录导入仅接受 directory 字段');
        }
        json(response, 200, await jobs.importDirectory(input.directory));
      } else if (request.method === 'POST' && url.pathname === '/api/placeholders') {
        validateParameters(url.searchParams, []);
        json(response, 200, await placeholders.create(await jsonBody(request)));
      } else if (request.method === 'POST' && url.pathname === '/api/import-file') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw new LibraryError('图片上传需要 application/octet-stream', 415);
        validateParameters(url.searchParams, ['name', 'category']);
        json(response, 200, await library.importFile(url.searchParams.get('name'), await body(request, MAX_IMAGE_BYTES), url.searchParams.get('category') ?? undefined));
      } else if (request.method === 'GET' && /^\/api\/assets\/[a-f0-9]{64}\/fit$/.test(url.pathname)) {
        validateParameters(url.searchParams, ['mode', 'widthPt', 'heightPt', 'profile']);
        json(response, 200, await fitter.create(url.pathname.split('/')[3], Object.fromEntries(url.searchParams)));
      } else if (request.method === 'GET' && /^\/api\/assets\/[a-f0-9]{64}\/insertion$/.test(url.pathname)) {
        validateParameters(url.searchParams, ['profile']);
        json(response, 200, await library.insertion(url.pathname.split('/')[3], url.searchParams.get('profile') ?? 'original'));
      } else if (request.method === 'GET' && /^\/api\/assets\/[a-f0-9]{64}\/(image|thumbnail)$/.test(url.pathname)) {
        const [, , , id, kind] = url.pathname.split('/');
        const file = await library.file(id, kind);
        const image = await readFile(file.path);
        response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': image.length });
        response.end(image);
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
  return { server, library, jobs };
}

export async function startServer({ port = 39831, ...options } = {}) {
  const result = await createServer(options);
  await new Promise((resolve, reject) => {
    result.server.once('error', reject);
    result.server.listen(port, '127.0.0.1', resolve);
  });
  return result;
}
