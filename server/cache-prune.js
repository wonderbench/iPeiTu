import { lstat, readdir, realpath, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';

// 图库缓存清理：可重新生成的缓存按目录限制总大小，并清理“先写临时文件再替换”遗留的 .tmp 文件。
// 缓存命中时生成方会刷新修改时间（touchCache），所以按修改时间从旧到新删除即按最近使用淘汰。
// index.json、usage.json、knowledge.json、connection.json、clients/、images/、thumbnails/、insertion/ 中的正式数据
// 永远不在清理范围：这些位置只删除名称以 .tmp 结尾、且修改时间早于 1 小时的普通文件。
export const DEFAULT_CACHE_LIMIT_BYTES = 512 * 1024 * 1024;
export const RECENT_PROTECTION_MS = 10 * 60 * 1000;
export const TEMPORARY_AGE_MS = 60 * 60 * 1000;
export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_REPORTED_ERRORS = 10;

// 缓存目录与其中由程序生成的文件名格式。名称不符合格式的文件不计入大小，也不会被删除。
// insertion-quality 下按规则版本分子目录（如 v2-sharp-0.35.5），只向下进入这一层。
export const CACHE_DIRECTORIES = Object.freeze({
  fitted: Object.freeze({ pattern: /^[a-f0-9]{64}\.(?:png|jpg)$/, nested: false }),
  'insertion-quality': Object.freeze({ pattern: /^[a-f0-9]{64}-(?:clear|balanced)\.(?:png|jpg)$/, nested: true }),
  placeholders: Object.freeze({ pattern: /^[a-f0-9]{64}\.png$/, nested: false }),
  'lan-cache': Object.freeze({ pattern: /^[a-f0-9]{64}\.(?:png|jpg)$/, nested: false }),
});

// 只清理遗留临时文件的目录；'.' 表示图库目录本身（index.json 等所在处）。
export const TEMPORARY_DIRECTORIES = Object.freeze(['.', 'images', 'thumbnails', 'insertion', 'clients']);

// 缓存命中、准备复用时调用：把修改时间刷新为当前时间，刚返回给 WPS 的文件因此落在保护期内。
// 返回 false 表示文件已被清理删除，调用方按未命中重新生成；其他错误（如文件被占用）告警后仍按命中处理。
export async function touchCache(filename) {
  const now = new Date();
  try {
    await utimes(filename, now, now);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    console.warn('iPeiTu 缓存命中后未能刷新修改时间，该文件可能较早被清理:', filename, error);
    return true;
  }
}

function comparablePath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function strictlyInside(parent, child) {
  const relative = path.relative(comparablePath(parent), comparablePath(child));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isTemporary(name) {
  return name.endsWith('.tmp');
}

function megabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function limitsFrom(maxBytes) {
  const names = Object.keys(CACHE_DIRECTORIES);
  const limits = Object.fromEntries(names.map(name => [name, DEFAULT_CACHE_LIMIT_BYTES]));
  if (typeof maxBytes === 'number') {
    for (const name of names) limits[name] = maxBytes;
  } else if (maxBytes && typeof maxBytes === 'object' && !Array.isArray(maxBytes)) {
    for (const [name, value] of Object.entries(maxBytes)) {
      if (!Object.hasOwn(CACHE_DIRECTORIES, name)) throw new Error(`未知的缓存目录：${name}`);
      limits[name] = value;
    }
  } else {
    throw new Error('缓存上限须为字节数，或按缓存目录名给出的字节数');
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`缓存目录 ${name} 的上限须为非负整数字节数`);
  }
  return limits;
}

export class CachePruner {
  constructor(directory, {
    maxBytes = DEFAULT_CACHE_LIMIT_BYTES, protectMs = RECENT_PROTECTION_MS, temporaryAgeMs = TEMPORARY_AGE_MS,
    now = () => Date.now(), remove = unlink, log = message => console.log(message), warn = message => console.warn(message),
  } = {}) {
    if (typeof directory !== 'string' || !directory) throw new Error('缓存清理需要图库目录');
    for (const [label, value] of [['保护期', protectMs], ['临时文件保留时间', temporaryAgeMs]]) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`缓存清理的${label}须为非负有限毫秒数`);
    }
    this.directory = path.resolve(directory);
    this.limits = limitsFrom(maxBytes);
    this.protectMs = protectMs;
    this.temporaryAgeMs = temporaryAgeMs;
    this.now = now;
    this.remove = remove;
    this.log = log;
    this.warn = warn;
    this.current = null;
    this.timer = null;
  }

  // 启动后立即执行一次（不等待），之后按间隔执行。定时器 unref，不阻止进程退出。
  start(intervalMs = PRUNE_INTERVAL_MS) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('缓存清理间隔须为正数毫秒');
    this.stop();
    this.timer = setInterval(() => { this.run(); }, intervalMs);
    this.timer.unref();
    return this.run();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // 同一时间只执行一次；返回的 Promise 不会被拒绝，所有错误记入结果。
  run() {
    if (!this.current) this.current = this.prune().finally(() => { this.current = null; });
    return this.current;
  }

  async prune() {
    const result = { directories: [], checked: 0, deleted: 0, bytes: 0, failed: 0, warnings: [] };
    try {
      const root = await this.resolveRoot(result.warnings);
      if (root) {
        for (const name of TEMPORARY_DIRECTORIES) result.directories.push(await this.pruneDirectory(root, name, null, result.warnings));
        for (const [name, rule] of Object.entries(CACHE_DIRECTORIES)) {
          result.directories.push(await this.pruneDirectory(root, name, rule, result.warnings));
        }
      }
    } catch (error) {
      result.failed++;
      result.warnings.push(`iPeiTu 缓存清理中止：${error.message}`);
    }
    for (const item of result.directories) {
      result.checked += item.checked;
      result.deleted += item.deleted;
      result.bytes += item.bytes;
      result.failed += item.failed;
    }
    this.report(result);
    return result;
  }

  async resolveRoot(warnings) {
    let root;
    try { root = await realpath(this.directory); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!(await lstat(root)).isDirectory()) {
      warnings.push(`iPeiTu 缓存清理已跳过：图库路径不是目录 ${this.directory}`);
      return null;
    }
    return root;
  }

  // 列出目录中的普通文件。不跟随符号链接：目录是链接时整个跳过并告警，文件是链接时跳过。
  async listFiles(root, directory, stats, warnings, nested) {
    if (directory !== root) {
      let details;
      try { details = await lstat(directory); } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      if (details.isSymbolicLink()) {
        warnings.push(`iPeiTu 缓存清理已跳过符号链接目录：${path.relative(root, directory)}`);
        return [];
      }
      if (!details.isDirectory()) {
        warnings.push(`iPeiTu 缓存清理已跳过：${path.relative(root, directory)} 不是目录`);
        return [];
      }
      if (!strictlyInside(root, directory)) throw new Error(`目录不在图库内：${directory}`);
    }
    let names;
    try { names = await readdir(directory); } catch (error) {
      if (error.code === 'ENOENT') return [];
      stats.failed++;
      this.recordError(stats, path.relative(root, directory) || '.', error);
      return [];
    }
    const files = [];
    for (const name of names) {
      const filename = path.join(directory, name);
      let details;
      try { details = await lstat(filename); } catch (error) {
        if (error.code === 'ENOENT') continue;
        stats.failed++;
        this.recordError(stats, path.relative(root, filename), error);
        continue;
      }
      if (details.isSymbolicLink()) {
        // insertion-quality 的版本子目录若被换成链接，告警后跳过；其余目录中的链接直接跳过。
        if (nested) warnings.push(`iPeiTu 缓存清理已跳过符号链接：${path.relative(root, filename)}`);
        continue;
      }
      if (details.isDirectory()) {
        if (nested) files.push(...await this.listFiles(root, filename, stats, warnings, false));
        continue;
      }
      if (!details.isFile()) continue;
      stats.checked++;
      files.push({ path: filename, name, size: details.size, mtimeMs: details.mtimeMs, dev: details.dev, ino: details.ino });
    }
    return files;
  }

  async pruneDirectory(root, name, rule, warnings) {
    const stats = { name, checked: 0, deleted: 0, bytes: 0, failed: 0, errors: [] };
    const directory = name === '.' ? root : path.join(root, name);
    let files;
    try { files = await this.listFiles(root, directory, stats, warnings, Boolean(rule?.nested)); } catch (error) {
      stats.failed++;
      this.recordError(stats, name, error);
      return stats;
    }
    const now = this.now();
    for (const file of files) {
      if (isTemporary(file.name) && now - file.mtimeMs > this.temporaryAgeMs) await this.delete(root, file, stats);
    }
    if (rule) {
      const limit = this.limits[name];
      const cached = files.filter(file => !isTemporary(file.name) && rule.pattern.test(file.name))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      let total = cached.reduce((sum, file) => sum + file.size, 0);
      for (const file of cached) {
        if (total <= limit) break;
        if (now - file.mtimeMs < this.protectMs) continue; // 刚生成的文件可能正被 WPS 读取。
        if (await this.delete(root, file, stats)) total -= file.size;
      }
      stats.remainingBytes = total;
      stats.limitBytes = limit;
    }
    return stats;
  }

  // 删除前再次确认：路径在图库目录内、所在目录未被换成链接、文件仍是扫描时那一个普通文件。
  // 文件在扫描后被重新生成（编号或修改时间变化）时不删除，也不算失败。
  async delete(root, file, stats) {
    try {
      if (!strictlyInside(root, file.path)) throw new Error('路径不在图库目录内');
      const parent = path.dirname(file.path);
      if (comparablePath(await realpath(parent)) !== comparablePath(parent)) throw new Error('所在目录已改变');
      const current = await lstat(file.path);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== file.dev || current.ino !== file.ino
        || current.mtimeMs !== file.mtimeMs) return false;
      await this.remove(file.path);
      stats.deleted++;
      stats.bytes += file.size;
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      stats.failed++;
      this.recordError(stats, path.relative(root, file.path), error);
      return false;
    }
  }

  recordError(stats, relative, error) {
    if (stats.errors.length < MAX_REPORTED_ERRORS) stats.errors.push({ path: relative, code: error.code ?? null, message: error.message });
  }

  // 只在确有删除或失败时写一行概括，避免每次启动都刷日志；异常目录另行告警。
  report(result) {
    try {
      for (const warning of result.warnings) this.warn(warning);
      if (!result.deleted && !result.failed) return;
      const details = result.directories.filter(item => item.deleted || item.failed)
        .map(item => `${item.name === '.' ? '图库目录' : item.name} 删除 ${item.deleted}${item.failed ? `、失败 ${item.failed}` : ''}`);
      const firstError = result.directories.flatMap(item => item.errors)[0];
      const errorText = firstError ? `；首个失败：${firstError.path}（${firstError.code ?? firstError.message}）` : '';
      this.log(`iPeiTu 缓存清理：删除 ${result.deleted} 个文件（${megabytes(result.bytes)} MB），失败 ${result.failed} 个；${details.join('，')}${errorText}`);
    } catch {
      // 日志输出失败不影响清理结果，结果仍返回给调用方。
    }
  }
}
