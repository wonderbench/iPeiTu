import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ImportJobs } from './import-jobs.js';
import { LibraryError, MAX_IMAGE_BYTES, clientIdPattern } from './library.js';
import { readBody } from './request-body.js';

// 客户端连接局域网图库：本机服务保存服务器地址与密钥，把图库与知识库请求转发过去；
// 插图文件下载到本机缓存后再交给 WPS，目录导入在本机读取后逐张上传。
export const API_VERSION = 1;
export const DEFAULT_PORT = 39831;
export const accessKeyPattern = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const downloadFile = /^\/api\/assets\/[a-f0-9]{64}\/(insertion|fit)\/file\?[^#\s]*$/;
const urlExample = '例如 192.168.1.10 或 http://192.168.1.10:39831';

// 转发到服务器的接口；/insertion 与 /fit 另行下载到本机缓存。
export function isForwardedPath(pathname) {
  return pathname === '/api/library' || pathname === '/api/import-file' || pathname.startsWith('/api/assets/')
    || pathname === '/api/knowledge' || pathname.startsWith('/api/knowledge/');
}

export function isDownloadPath(pathname) {
  return /^\/api\/assets\/[a-f0-9]{64}\/(insertion|fit)$/.test(pathname);
}

function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '0.0.0.0'
    || host === '[::1]' || host === '[::]' || host === '[::ffff:7f00:1]';
}

export function normalizeServerUrl(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > 200 || /[\x00-\x20\x7f]/.test(text)) throw new LibraryError(`请填写服务器地址，${urlExample}`);
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`); } catch {
    throw new LibraryError(`服务器地址格式不正确，${urlExample}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || !url.hostname) throw new LibraryError(`服务器地址只填主机和端口，${urlExample}`);
  if (isLoopbackHostname(url.hostname)) {
    throw new LibraryError('这是本机地址。服务器那台电脑请直接使用本机图库，其他电脑填写服务器的局域网地址');
  }
  // 未写端口时使用 iPeiTu 默认端口；明确写了 :80 或 :443 时保留。
  if (!url.port && !/:\d+\/?$/.test(text)) url.port = String(DEFAULT_PORT);
  return url.origin;
}

function validConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const keys = Object.keys(config);
  if (keys.length !== 4 || !['version', 'url', 'key', 'clientId'].every(key => keys.includes(key))) return false;
  if (config.version !== 1 || !accessKeyPattern.test(config.key) || !clientIdPattern.test(config.clientId)) return false;
  try { return normalizeServerUrl(config.url) === config.url; } catch { return false; }
}

function fatal(error) {
  error.fatal = true;
  return error;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function writeAtomic(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// 目录导入的上传适配器：沿用本机的目录扫描与来源校验，只把“写入图库”换成上传到服务器。
class RemoteImporter {
  constructor(client) {
    this.client = client;
    this.activeTotal = 0;
  }

  async prepareImportDirectory(directory) {
    const context = await this.client.library.prepareImportDirectory(directory);
    const health = await this.client.json('/api/health');
    if (Number.isSafeInteger(health.total)) this.activeTotal = health.total;
    return context;
  }

  walkImportDirectory(context, options) {
    return this.client.library.walkImportDirectory(context, options);
  }

  async importSourceFile(context, descriptor) {
    const { name, buffer, categories } = await this.client.library.readImportSource(context, descriptor);
    const parameters = new URLSearchParams({ name });
    if (categories.length) parameters.set('category', categories[0]);
    const result = await this.client.json(`/api/import-file?${parameters}`, {
      method: 'POST', contentType: 'application/octet-stream', body: buffer, timeout: 120_000,
    });
    if (Number.isSafeInteger(result.total)) this.activeTotal = result.total;
    if (Array.isArray(result.failed) && result.failed.length) throw new LibraryError(String(result.failed[0].error));
    const outcome = ['imported', 'duplicates', 'restored'].find(key => result[key] > 0);
    if (!outcome) throw new LibraryError('局域网图库没有返回导入结果，请确认两边版本一致', 502);
    return outcome;
  }
}

export class LanClient {
  constructor(library, { disabled = false } = {}) {
    this.library = library;
    this.file = path.join(library.directory, 'connection.json');
    this.cacheDirectory = path.join(library.directory, 'lan-cache');
    this.disabled = disabled;
    this.config = null;
    this.failure = null;
    this.importer = new RemoteImporter(this);
    this.jobs = new ImportJobs(this.importer);
  }

  static async open(library, options) {
    const client = new LanClient(library, options);
    let original;
    try { original = await readFile(client.file, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return client;
    }
    let config = null;
    try { config = JSON.parse(original); } catch { /* 按损坏处理 */ }
    if (validConfig(config)) client.config = config;
    else client.failure = new LibraryError('局域网连接配置 connection.json 已损坏，请在“图库来源”中重新连接或切回本机图库', 500);
    if (client.disabled) console.warn('本机正作为局域网图库服务器运行，已忽略连接其他服务器的配置');
    return client;
  }

  // 损坏的配置也算局域网模式：明确报错，而不是悄悄改用本机图库。
  get active() {
    return !this.disabled && Boolean(this.config || this.failure);
  }

  status() {
    if (this.disabled) return { mode: 'local', url: null, lanServer: true };
    if (this.config) return { mode: 'lan', url: this.config.url, lanServer: false };
    if (this.failure) return { mode: 'lan', url: null, lanServer: false, error: this.failure.message };
    return { mode: 'local', url: null, lanServer: false };
  }

  headers(config = this.config) {
    return { authorization: `Bearer ${config.key}`, 'x-ipeitu-client': config.clientId };
  }

  async connect(input) {
    if (this.disabled) throw new LibraryError('本机正作为局域网图库服务器运行，不能再连接其他服务器', 409);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
      || !Object.hasOwn(input, 'url') || !Object.hasOwn(input, 'key')) throw new LibraryError('连接设置仅接受 url 与 key');
    const url = normalizeServerUrl(input.url);
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (!accessKeyPattern.test(key)) throw new LibraryError('访问密钥应为服务器安装窗口显示的 43 位字符，请完整复制');
    // 重新连接时沿用客户端标识，个人收藏与最近使用不会丢失。
    const config = { version: 1, url, key, clientId: this.config?.clientId ?? randomUUID() };
    const health = await this.check(config);
    await writeAtomic(this.file, `${JSON.stringify(config, null, 2)}\n`);
    this.config = config;
    this.failure = null;
    if (Number.isSafeInteger(health.total)) this.importer.activeTotal = health.total;
    return this.status();
  }

  async disconnect() {
    try { await unlink(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.config = null;
    this.failure = null;
    return this.status();
  }

  async check(config) {
    let response;
    try {
      response = await fetch(`${config.url}/api/health`, { headers: this.headers(config), redirect: 'error', signal: AbortSignal.timeout(5000) });
    } catch {
      throw new LibraryError(`无法连接 ${config.url}：请确认服务器已运行“局域网服务器.cmd”、防火墙已放行端口，且两台电脑在同一网络`, 502);
    }
    if (response.status === 401) throw new LibraryError('访问密钥不正确，请从服务器安装窗口重新复制');
    if (response.status === 403) throw new LibraryError('该服务器未开启局域网访问，请在服务器上运行“局域网服务器.cmd”');
    let data = null;
    try { data = JSON.parse((await this.read(response, MAX_JSON_BYTES)).toString('utf8')); } catch { /* 下面统一说明 */ }
    if (!response.ok || data?.service !== 'iPeiTu') throw new LibraryError('该地址不是 iPeiTu 局域网图库');
    if (data.api !== API_VERSION || data.lan !== true) {
      throw new LibraryError(`服务器的 iPeiTu 版本（${String(data.version ?? '未知')}）与本机不兼容，请两边更新到同一版本`);
    }
    return data;
  }

  assertReady() {
    if (this.failure) throw this.failure;
    if (!this.config) throw new LibraryError('尚未连接局域网图库', 409);
  }

  async upstream(target, { method = 'GET', contentType, body, timeout = 15_000 } = {}) {
    this.assertReady();
    const { url } = this.config;
    let response;
    try {
      response = await fetch(`${url}${target}`, {
        method, body, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { ...this.headers(), ...(contentType ? { 'content-type': contentType } : {}) },
      });
    } catch {
      throw fatal(new LibraryError(`无法连接局域网图库 ${url}，请确认服务器已开启并在同一网络，或切回本机图库`, 502));
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw fatal(new LibraryError('局域网图库拒绝访问：访问密钥不正确或已更换，请在“图库来源”中重新填写', 502));
    }
    return response;
  }

  async read(response, limit) {
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new LibraryError('局域网图库返回的数据超过允许大小', 502);
    }
    const chunks = [];
    let length = 0;
    try {
      for await (const chunk of response.body ?? []) {
        length += chunk.length;
        if (length > limit) throw new LibraryError('局域网图库返回的数据超过允许大小', 502);
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof LibraryError) throw error;
      throw fatal(new LibraryError('与局域网图库的连接中断，请重试', 502));
    }
    return Buffer.concat(chunks);
  }

  async json(target, options) {
    const response = await this.upstream(target, options);
    let data;
    try { data = JSON.parse((await this.read(response, MAX_JSON_BYTES)).toString('utf8')); } catch (error) {
      if (error instanceof LibraryError) throw error;
      throw new LibraryError('局域网图库返回的内容无效，请确认两边版本一致', 502);
    }
    if (!response.ok) {
      throw new LibraryError(typeof data?.error === 'string' ? data.error : `局域网图库操作失败（${response.status}）`, response.status);
    }
    return data;
  }

  async forward(request, response, url) {
    this.assertReady();
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const upload = url.pathname === '/api/import-file';
    const payload = hasBody ? await readBody(request, upload ? MAX_IMAGE_BYTES : 256 * 1024) : undefined;
    const upstream = await this.upstream(url.pathname + url.search, {
      method: request.method, body: payload, contentType: hasBody ? request.headers['content-type'] : undefined,
      timeout: upload || url.pathname.endsWith('/image') ? 120_000 : 15_000,
    });
    const content = await this.read(upstream, MAX_RESPONSE_BYTES);
    response.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream', 'Content-Length': content.length,
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  }

  // 插图与适配图：先取服务器上的文件信息，再下载并核对字节数与 SHA-256，存入本机缓存后返回本机路径。
  async download(url) {
    const { file, sha256: expected, ...result } = await this.json(url.pathname + url.search);
    if (typeof file !== 'string' || !downloadFile.test(file) || !/^[a-f0-9]{64}$/.test(expected ?? '')
      || !Number.isSafeInteger(result.bytes) || result.bytes <= 0 || result.bytes > MAX_RESPONSE_BYTES
      || !['png', 'jpeg'].includes(result.format) || Object.hasOwn(result, 'path')) {
      throw new LibraryError('局域网图库返回的插图信息无效，请确认两边版本一致', 502);
    }
    await mkdir(this.cacheDirectory, { recursive: true });
    const details = await lstat(this.cacheDirectory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new LibraryError('局域网缓存目录类型无效，请检查图库目录', 500);
    const target = path.join(this.cacheDirectory, `${expected}.${result.format === 'png' ? 'png' : 'jpg'}`);
    if (!(await this.cached(target, expected))) {
      const response = await this.upstream(file, { timeout: 120_000 });
      if (!response.ok) {
        let message = `局域网图库下载失败（${response.status}）`;
        try { message = JSON.parse((await this.read(response, MAX_JSON_BYTES)).toString('utf8')).error || message; } catch { /* 保留状态码说明 */ }
        throw new LibraryError(message, response.status === 404 || response.status === 410 ? response.status : 502);
      }
      const content = await this.read(response, result.bytes);
      if (content.length !== result.bytes || sha256(content) !== expected) {
        throw new LibraryError('下载的图片与服务器记录不一致，请重试', 502);
      }
      await writeAtomic(target, content);
    }
    return { ...result, path: target };
  }

  async cached(filename, expected) {
    try {
      const details = await lstat(filename);
      return details.isFile() && sha256(await readFile(filename)) === expected;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
}
