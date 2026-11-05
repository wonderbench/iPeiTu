import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { LibraryError, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from './library.js';
import { densityPolicy, logicalSize, preserveNativeDensity } from './image-density.js';

const RULE_VERSION = 'v2';
const profiles = { clear: { edge: 2400, quality: 90 }, balanced: { edge: 1600, quality: 80 } };
const digest = buffer => createHash('sha256').update(buffer).digest('hex');

export function validateProfile(profile) {
  if (!['original', 'clear', 'balanced'].includes(profile)) throw new LibraryError('profile 仅接受 original、clear 或 balanced');
  return profile;
}

async function safePath(root, filename) {
  const absoluteRoot = path.resolve(root), relative = path.relative(absoluteRoot, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new LibraryError('插入文件不在图库目录内', 500);
  const actualRoot = await realpath(absoluteRoot);
  let candidate = absoluteRoot;
  for (const part of relative.split(path.sep)) {
    candidate = path.join(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink()) throw new LibraryError('图库插入文件路径不能包含符号链接，请检查图库目录', 500);
  }
  const actual = await realpath(filename), contained = path.relative(actualRoot, actual);
  if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) throw new LibraryError('插入文件已移出图库目录', 500);
  return actual;
}

async function boundedRead(root, filename, limit) {
  const resolved = await safePath(root, filename), before = await lstat(resolved);
  if (!before.isFile() || before.size <= 0 || before.size > limit) throw new LibraryError('插入文件大小或类型无效，请重新导入原素材', 500);
  const handle = await open(resolved, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > limit) throw new LibraryError('插入文件在读取前已改变', 500);
    await safePath(root, filename);
    const chunks = [];
    let length = 0;
    while (true) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > limit) throw new LibraryError('插入文件超过允许大小', 500);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || length !== opened.size) throw new LibraryError('插入文件在读取期间已改变', 500);
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

async function ensureCacheDirectory(root, parts) {
  let directory = root;
  for (const part of parts) {
    directory = path.join(directory, part);
    try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await safePath(root, directory);
    if (!(await lstat(directory)).isDirectory()) throw new LibraryError('压缩缓存目录类型无效，请检查图库目录', 500);
  }
  return directory;
}

export class InsertionQuality {
  constructor(directory, { concurrency = 2, maxQueue = 8 } = {}) {
    this.directory = directory;
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.running = 0;
    this.queue = [];
    this.pending = new Map();
  }

  async originalDetails(filename) {
    return lstat(await safePath(this.directory, filename));
  }

  async limited(operation) {
    if (this.running >= this.concurrency) {
      if (this.queue.length >= this.maxQueue) throw new LibraryError('图片处理任务较多，请稍后重试', 429);
      await new Promise(resolve => this.queue.push(resolve));
    } else this.running++;
    try { return await operation(); } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    }
  }

  get(id, profile, inputPath, assertActive) {
    validateProfile(profile);
    const key = `${id}-${profile}`;
    if (!this.pending.has(key)) {
      const pending = this.limited(() => this.prepare(profile, inputPath, assertActive));
      this.pending.set(key, pending);
      pending.finally(() => this.pending.delete(key)).catch(() => {});
    }
    return this.pending.get(key);
  }

  async render(buffer, profile, format, policy) {
    const options = profiles[profile];
    let image = sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).autoOrient()
      .resize({ width: options.edge, height: options.edge, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb').withExif({});
    if (policy.kind === 'physical') image = image.withDensity(96);
    image = format === 'png' ? image.png({ compressionLevel: 9 })
      : image.jpeg({ quality: options.quality, chromaSubsampling: profile === 'clear' ? '4:4:4' : '4:2:0' });
    return preserveNativeDensity(await image.toBuffer(), policy);
  }

  async validCache(buffer, expected) {
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return false;
    try {
      const image = sharp(buffer, { limitInputPixels: profiles.clear.edge ** 2, failOn: 'warning' });
      const metadata = await image.metadata();
      if (metadata.width !== expected.width || metadata.height !== expected.height || metadata.format !== expected.format
        || Boolean(metadata.hasAlpha) !== expected.alpha || metadata.space !== 'srgb' || metadata.icc || metadata.xmp) return false;
      const policy = densityPolicy(buffer, metadata.format);
      if (expected.policy.kind !== policy.kind) return false;
      if (policy.kind === 'native' ? policy.key !== expected.policy.key
        : Math.abs(policy.resolution.x - 96) > 0.0127001) return false;
      await image.stats(); // Decode every pixel so truncated image data is not passed to WPS.
      return true;
    } catch { return false; }
  }

  async prepare(profile, inputPath, assertActive) {
    assertActive();
    const source = await boundedRead(this.directory, inputPath, MAX_IMAGE_PIXELS * 4 + 1024 * 1024);
    let metadata;
    try { metadata = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).metadata(); } catch {
      throw new LibraryError('插入原档已损坏，请重新导入原素材', 500);
    }
    let policy;
    try { policy = densityPolicy(source, metadata.format); } catch (error) {
      throw new LibraryError(`无法保持图片原有排版尺寸：${error.message}`);
    }
    const format = policy.kind === 'native' ? metadata.format : metadata.hasAlpha ? 'png' : 'jpeg', edge = profiles[profile].edge;
    const scale = Math.min(1, edge / Math.max(metadata.width, metadata.height));
    const expected = { width: Math.max(1, Math.round(metadata.width * scale)), height: Math.max(1, Math.round(metadata.height * scale)), format, alpha: Boolean(metadata.hasAlpha), policy };
    let logical;
    try {
      logical = policy.kind === 'physical' ? logicalSize(source, metadata)
        : { naturalWidthScale: metadata.width / expected.width };
    } catch (error) {
      throw new LibraryError(`无法保持图片原有排版尺寸：${error.message}`);
    }
    const cacheDirectory = await ensureCacheDirectory(this.directory, ['insertion-quality', `${RULE_VERSION}-sharp-${sharp.versions.sharp}`]);
    const filename = path.join(cacheDirectory, `${digest(source)}-${profile}.${format === 'jpeg' ? 'jpg' : 'png'}`);
    let cached;
    try {
      cached = await boundedRead(this.directory, filename, MAX_IMAGE_BYTES);
      if (!(await this.validCache(cached, expected))) throw new LibraryError('图片压缩缓存校验失败', 500);
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof LibraryError && /大小|缓存校验/.test(error.message))) throw error;
      if (error.code !== 'ENOENT') console.warn('iPeiTu 压缩缓存已损坏，正在从原图重建:', filename);
      cached = await this.render(source, profile, format, policy);
      if (!(await this.validCache(cached, expected))) throw new LibraryError('无法生成有效插入副本，请使用原图或重新导入素材', 500);
      assertActive();
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await safePath(this.directory, cacheDirectory);
        await writeFile(temporary, cached, { flag: 'wx' });
        await rename(temporary, filename);
      } finally {
        try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    assertActive();
    return { path: filename, width: expected.width, height: expected.height, format, bytes: cached.length, ...logical };
  }
}
