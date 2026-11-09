import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename, lstat, opendir, open, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { InsertionQuality, validateProfile } from './insertion-quality.js';

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64 * 1000 * 1000;
export const MAX_IMPORT_ENTRIES = 10000;
export const MAX_IMPORT_FAILURES = 1000;
const formats = new Set(['jpeg', 'png', 'webp']);
const extensions = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.svg', '.heic', '.heif', '.avif', '.ico']);
const idPattern = /^[a-f0-9]{64}$/;
const metadataLimits = { aliases: [100, 255], categories: [32, 255], tags: [64, 64] };
const fieldLabels = { name: '图片名称', aliases: '别名', categories: '分类', tags: '标签' };
const controlCharacters = /[\x00-\x1f\x7f\u2028\u2029]/;
export const MAX_BATCH_ASSETS = 1000;
export const MAX_CLIENTS = 1000;
export const clientIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// \u5bbd\u9ad8\u6bd4\u5927\u4e8e 1.05 \u4e3a\u6a2a\u56fe\uff0c\u5c0f\u4e8e 1/1.05 \u4e3a\u7ad6\u56fe\uff0c\u5176\u4f59\u4e3a\u65b9\u56fe\u3002
const orientations = {
  '': () => true,
  landscape: asset => asset.width / asset.height > 1.05,
  portrait: asset => asset.width / asset.height < 1 / 1.05,
  square: asset => asset.width / asset.height >= 1 / 1.05 && asset.width / asset.height <= 1.05,
};

function matchKey(value) {
  return value.normalize('NFKC').toLowerCase();
}

export class LibraryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function defaultDataDirectory() {
  return process.env.IPEITU_DATA_DIR || (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'iPeiTu', 'library')
    : path.join(os.homedir(), '.ipeitu', 'library'));
}

function validRecord(asset) {
  return asset && idPattern.test(asset.id) && typeof asset.name === 'string' && asset.name.length > 0
    && Array.isArray(asset.aliases) && asset.aliases.every(name => typeof name === 'string')
    && (asset.normalized === undefined || typeof asset.normalized === 'boolean')
    && formats.has(asset.format) && ['width', 'height', 'bytes'].every(key => Number.isSafeInteger(asset[key]) && asset[key] > 0);
}

function metadataText(value, field, maximum) {
  if (typeof value !== 'string' || controlCharacters.test(value) || !value.trim() || value.length > maximum) {
    throw new LibraryError(`${fieldLabels[field] || field}须为 1–${maximum} 个字符的单行文字`);
  }
  return value.trim();
}

function metadataList(value, field) {
  const [maximumItems, maximumLength] = metadataLimits[field];
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new LibraryError(`${fieldLabels[field]}须为数组，最多 ${maximumItems} 项`);
  }
  const seen = new Set();
  return value.map(item => metadataText(item, field, maximumLength)).filter(item => {
    const key = matchKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validV2Record(asset) {
  if (!validRecord(asset)) return false;
  try {
    // Legacy names and aliases remain byte-for-byte values during migration.
    // New categories and tags are always written in their validated form.
    return ['categories', 'tags'].every(field => {
      const values = metadataList(asset[field], field);
      return values.length === asset[field].length && values.every((value, index) => value === asset[field][index]);
    });
  } catch (error) {
    if (error instanceof LibraryError) return false;
    throw error;
  }
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validV3Record(asset) {
  return validV2Record(asset) && (asset.deletedAt === null || validTimestamp(asset.deletedAt));
}

function comparablePath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function pathContains(parent, child) {
  const relative = path.relative(comparablePath(parent), comparablePath(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function importErrorMessage(error) {
  if (error instanceof LibraryError) return error.message;
  console.error('iPeiTu 导入失败:', error);
  return ({ ENOENT: '来源已不存在，请重新选择或恢复文件后重试', ENOTDIR: '来源目录结构已改变',
    EACCES: '没有读取或写入权限，请检查文件权限', EPERM: '文件被占用或没有操作权限',
    ENOSPC: '图库所在磁盘空间不足，请释放空间后重试' })[error.code] || '本地文件读写失败，请查看服务窗口后重试';
}

function hasExactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function validUsage(usage, assets) {
  if (!hasExactFields(usage, ['version', 'favorites', 'recent']) || usage.version !== 1
    || !Array.isArray(usage.favorites) || !Array.isArray(usage.recent) || usage.recent.length > 100) return false;
  const ids = new Set(assets.map(asset => asset.id));
  if (usage.favorites.some(id => typeof id !== 'string' || !ids.has(id))
    || new Set(usage.favorites).size !== usage.favorites.length) return false;
  const seen = new Set();
  let previousTime = Infinity;
  for (const entry of usage.recent) {
    if (!hasExactFields(entry, ['id', 'insertedAt']) || !ids.has(entry.id) || seen.has(entry.id)
      || typeof entry.insertedAt !== 'string') return false;
    const time = Date.parse(entry.insertedAt);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== entry.insertedAt || time > previousTime) return false;
    previousTime = time;
    seen.add(entry.id);
  }
  return true;
}

function displayAsset(asset, usage) {
  return { ...asset, aliases: [...asset.aliases], categories: [...asset.categories], tags: [...asset.tags],
    favorite: usage.favorites.includes(asset.id),
    lastInsertedAt: usage.recent.find(entry => entry.id === asset.id)?.insertedAt ?? null,
    thumbnailUrl: `/api/assets/${asset.id}/thumbnail`, imageUrl: `/api/assets/${asset.id}/image` };
}

function mergeMetadata(existing, additions, field) {
  const values = [...existing];
  const seen = new Set(existing.map(matchKey));
  for (const item of additions) {
    const key = matchKey(item);
    if (!seen.has(key)) {
      if (values.length >= metadataLimits[field][0]) throw new LibraryError(`${fieldLabels[field]}最多 ${metadataLimits[field][0]} 项，请先整理该图片`);
      values.push(item);
      seen.add(key);
    }
  }
  return values;
}

function safeName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\x00-\x1f]/.test(name)) {
    throw new LibraryError('图片名称必须是 1–255 个可见字符');
  }
  // The name is metadata only; neither uploaded names nor aliases become paths.
  const basename = name.replace(/\\/g, '/').split('/').at(-1).trim();
  if (!basename || basename === '.' || basename === '..') throw new LibraryError('图片名称不能为空');
  return basename;
}

async function replaceFile(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx' });
  await rename(temporary, filename);
}

export class Library {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.assets = [];
    this.usage = { version: 1, favorites: [], recent: [] };
    this.clientUsage = new Map();
    this.pending = Promise.resolve();
    this.quality = new InsertionQuality(this.directory);
  }

  static async open(directory = defaultDataDirectory()) {
    const library = new Library(directory);
    await mkdir(path.join(library.directory, 'images'), { recursive: true });
    await mkdir(path.join(library.directory, 'thumbnails'), { recursive: true });
    await mkdir(path.join(library.directory, 'insertion'), { recursive: true });
    let original;
    try {
      original = await readFile(path.join(library.directory, 'index.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await library.loadUsage();
      return library;
    }
    let index;
    try { index = JSON.parse(original.toString('utf8')); } catch {
      throw new LibraryError('图库索引不是有效 JSON，请保留原文件并恢复备份', 500);
    }
    if (index && ![1, 2, 3].includes(index.version)) {
      throw new LibraryError('图库索引版本不受支持，请使用对应版本的 iPeiTu；原文件未修改', 500);
    }
    const validator = index?.version === 1 ? validRecord : index?.version === 2 ? validV2Record : validV3Record;
    if (!index || !Array.isArray(index.assets) || !index.assets.every(validator)
      || new Set(index.assets.map(asset => asset.id)).size !== index.assets.length) {
      throw new LibraryError('图库索引结构损坏，无法安全读取', 500);
    }
    // Refuse damaged personal state before attempting any historical index migration.
    await library.loadUsage(index.assets);
    if (index.version < 3) {
      const backup = path.join(library.directory, `index-v${index.version}-backup-${Date.now()}-${randomUUID()}.json`);
      await writeFile(backup, original, { flag: 'wx' });
      await library.persist(index.assets.map(asset => ({ ...asset,
        ...(index.version === 1 ? { categories: [], tags: [] } : {}), deletedAt: null })));
    } else {
      library.assets = index.assets;
    }
    return library;
  }

  async loadUsage(assets = this.assets) {
    let original;
    try { original = await readFile(path.join(this.directory, 'usage.json'), 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    let usage;
    try { usage = JSON.parse(original); } catch {
      throw new LibraryError('收藏与最近记录 usage.json 不是有效 JSON，请保留原文件并恢复备份', 500);
    }
    if (!validUsage(usage, assets)) {
      throw new LibraryError('收藏与最近记录 usage.json 版本或结构无效，请保留原文件并恢复备份', 500);
    }
    this.usage = usage;
  }

  serialize(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {}); // Keep later imports usable after an explicitly reported failure.
    return result;
  }

  async persist(assets) {
    const temporary = path.join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify({ version: 3, assets }, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path.join(this.directory, 'index.json'));
    this.assets = assets;
  }

  async persistUsage(usage) {
    await replaceFile(path.join(this.directory, 'usage.json'), `${JSON.stringify(usage, null, 2)}\n`);
    this.usage = usage;
  }

  // 局域网客户端的收藏与最近使用按客户端分别保存在 clients/<clientId>.json；本机请求（client 为空）使用 usage.json。
  async usageFor(client = null) {
    if (client === null) return this.usage;
    if (typeof client !== 'string' || !clientIdPattern.test(client)) throw new LibraryError('客户端标识无效');
    if (this.clientUsage.has(client)) return this.clientUsage.get(client);
    let original;
    try { original = await readFile(path.join(this.directory, 'clients', `${client}.json`), 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, favorites: [], recent: [] };
    }
    let usage;
    try { usage = JSON.parse(original); } catch { usage = null; }
    if (!validUsage(usage, this.assets)) {
      throw new LibraryError(`客户端 ${client} 的收藏与最近记录已损坏，请保留 clients 目录中的原文件并恢复备份`, 500);
    }
    this.clientUsage.set(client, usage);
    return usage;
  }

  async persistUsageFor(client, usage) {
    if (client === null) return this.persistUsage(usage);
    const directory = path.join(this.directory, 'clients');
    const filename = path.join(directory, `${client}.json`);
    if (!this.clientUsage.has(client)) {
      await mkdir(directory, { recursive: true });
      let exists = true;
      try { await stat(filename); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        exists = false;
      }
      if (!exists && (await readdir(directory)).filter(name => name.endsWith('.json')).length >= MAX_CLIENTS) {
        throw new LibraryError(`局域网客户端记录已达 ${MAX_CLIENTS} 个上限，请清理服务器图库 clients 目录中不再使用的记录`, 409);
      }
    }
    await replaceFile(filename, `${JSON.stringify(usage, null, 2)}\n`);
    this.clientUsage.set(client, usage);
  }

  get activeTotal() {
    return this.assets.filter(asset => asset.deletedAt === null).length;
  }

  list(query = '', { category = '', tags = [], uncategorized = false, view = 'all', orientation = '' } = {}, usage = this.usage) {
    if (typeof query !== 'string' || query.length > 512 || /[\x00-\x08\x0e-\x1f\x7f]/.test(query)) {
      throw new LibraryError('检索词须为不超过 512 个字符的文字');
    }
    if (!Object.hasOwn(orientations, orientation)) throw new LibraryError('orientation 仅接受 landscape、portrait 或 square');
    if (typeof category !== 'string') throw new LibraryError('分类筛选须为文字');
    if (typeof uncategorized !== 'boolean') throw new LibraryError('未分类筛选值无效');
    if (!['all', 'favorites', 'recent', 'trash'].includes(view)) throw new LibraryError('view 仅接受 all、favorites、recent 或 trash');
    const categoryKey = category ? matchKey(metadataText(category, 'categories', 255)) : '';
    if (categoryKey && uncategorized) throw new LibraryError('分类与未分类条件不能同时使用');
    const tagKeys = metadataList(tags, 'tags').map(matchKey);
    const terms = matchKey(query).trim().split(/\s+/).filter(Boolean);
    const activeAssets = this.assets.filter(asset => asset.deletedAt === null);
    const facetAssets = view === 'trash' ? this.assets.filter(asset => asset.deletedAt !== null) : activeAssets;
    let viewAssets = facetAssets;
    if (view === 'trash') viewAssets = [...facetAssets].sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
    else if (view === 'favorites') viewAssets = activeAssets.filter(asset => usage.favorites.includes(asset.id));
    else if (view === 'recent') {
      const byId = new Map(activeAssets.map(asset => [asset.id, asset]));
      viewAssets = usage.recent.map(entry => byId.get(entry.id)).filter(Boolean);
    }
    const assets = viewAssets.filter(asset => {
      const names = [asset.name, ...asset.aliases, ...asset.tags].map(matchKey);
      return terms.every(term => names.some(name => name.includes(term)))
        && (!categoryKey || asset.categories.some(item => matchKey(item) === categoryKey))
        && (!uncategorized || asset.categories.length === 0)
        && tagKeys.every(tag => asset.tags.some(item => matchKey(item) === tag))
        && orientations[orientation](asset);
    }).map(asset => displayAsset(asset, usage));
    const facets = {
      categories: [], tags: [], uncategorized: facetAssets.filter(asset => asset.categories.length === 0).length,
      orientations: Object.fromEntries(['landscape', 'portrait', 'square'].map(key => [key, facetAssets.filter(orientations[key]).length])),
    };
    for (const field of ['categories', 'tags']) {
      const counts = new Map();
      for (const asset of facetAssets) {
        for (const name of asset[field]) {
          const key = matchKey(name);
          if (counts.has(key)) counts.get(key).count++;
          else counts.set(key, { name, count: 1 });
        }
      }
      facets[field] = [...counts.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }
    return { assets, total: activeAssets.length, viewTotal: viewAssets.length, facets };
  }

  updateAsset(id, input, client = null) {
    return this.serialize(async () => {
      const asset = this.getAsset(id);
      const usage = await this.usageFor(client);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LibraryError('素材整理内容须为 JSON 对象');
      const fields = Object.keys(input);
      if (!fields.length || fields.some(field => !Object.hasOwn(fieldLabels, field))) {
        throw new LibraryError('仅可修改名称、别名、分类和标签，且至少提供一项');
      }
      const changes = {};
      for (const field of fields) changes[field] = field === 'name'
        ? metadataText(input[field], field, 255) : metadataList(input[field], field);
      const updated = { ...asset, ...changes };
      await this.persist(this.assets.map(item => item.id === id ? updated : item));
      return displayAsset(updated, usage);
    });
  }

  // 批量添加或移除分类与标签：全部校验通过才一次写入，任何一张有问题都不改。
  updateAssets(input) {
    return this.serialize(async () => {
      const operations = ['addCategories', 'removeCategories', 'addTags', 'removeTags'];
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'ids')
        || Object.keys(input).some(key => key !== 'ids' && !operations.includes(key))) {
        throw new LibraryError('批量整理仅接受 ids、addCategories、removeCategories、addTags、removeTags');
      }
      const { ids } = input;
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH_ASSETS || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== 'string')) {
        throw new LibraryError(`请选择 1–${MAX_BATCH_ASSETS} 张不重复的图片`);
      }
      const changes = {};
      for (const key of operations) {
        if (Object.hasOwn(input, key)) changes[key] = metadataList(input[key], key.endsWith('Tags') ? 'tags' : 'categories');
      }
      if (!Object.values(changes).some(list => list.length)) throw new LibraryError('请至少填写一项要添加或移除的分类或标签');
      const remove = (values, removals) => {
        const keys = new Set((removals ?? []).map(matchKey));
        return values.filter(value => !keys.has(matchKey(value)));
      };
      const updates = new Map();
      for (const id of ids) {
        const asset = this.getAsset(id);
        const categories = remove(mergeMetadata(asset.categories, changes.addCategories ?? [], 'categories'), changes.removeCategories);
        const tags = remove(mergeMetadata(asset.tags, changes.addTags ?? [], 'tags'), changes.removeTags);
        updates.set(id, { ...asset, categories, tags });
      }
      await this.persist(this.assets.map(item => updates.get(item.id) ?? item));
      return { updated: updates.size };
    });
  }

  setFavorite(id, input, client = null) {
    return this.serialize(async () => {
      const asset = this.getAsset(id);
      if (!hasExactFields(input, ['favorite']) || typeof input.favorite !== 'boolean') {
        throw new LibraryError('收藏设置仅接受 favorite 布尔值');
      }
      let usage = await this.usageFor(client);
      if (usage.favorites.includes(id) !== input.favorite) {
        const favorites = input.favorite ? [...usage.favorites, id] : usage.favorites.filter(item => item !== id);
        usage = { ...usage, favorites };
        await this.persistUsageFor(client, usage);
      }
      return displayAsset(asset, usage);
    });
  }

  recordRecent(id, input, client = null) {
    return this.serialize(async () => {
      const asset = this.getAsset(id);
      if (!hasExactFields(input, [])) throw new LibraryError('最近插入记录仅接受空 JSON 对象，时间由服务端生成');
      // Prepending gives equal-millisecond events stable order, including after a restart.
      // Clamp a backwards system clock so persisted timestamps remain in descending order.
      let usage = await this.usageFor(client);
      const timestamp = Math.max(Date.now(), Date.parse(usage.recent[0]?.insertedAt) || 0);
      const recent = [{ id, insertedAt: new Date(timestamp).toISOString() }, ...usage.recent.filter(entry => entry.id !== id)].slice(0, 100);
      usage = { ...usage, recent };
      await this.persistUsageFor(client, usage);
      return displayAsset(asset, usage);
    });
  }

  setTrash(id, input, client = null) {
    return this.serialize(async () => {
      const asset = this.getAsset(id, { includeDeleted: true });
      if (!hasExactFields(input, ['trashed']) || typeof input.trashed !== 'boolean') throw new LibraryError('移出设置仅接受 trashed 布尔值');
      const usage = await this.usageFor(client);
      if ((asset.deletedAt !== null) === input.trashed) return displayAsset(asset, usage);
      if (!input.trashed) {
        await this.file(id, 'image');
        if (asset.normalized || asset.format === 'webp') {
          try { await stat(path.join(this.directory, 'insertion', `${id}.png`)); } catch (error) {
            if (error.code === 'ENOENT') throw new LibraryError('插入副本已丢失，请重新导入原素材以恢复', 404);
            throw error;
          }
        }
      }
      const updated = { ...asset, deletedAt: input.trashed ? new Date().toISOString() : null };
      await this.persist(this.assets.map(item => item.id === id ? updated : item));
      return displayAsset(updated, usage);
    });
  }

  getAsset(id, { includeDeleted = false } = {}) {
    if (!idPattern.test(id)) throw new LibraryError('找不到该图片', 404);
    const asset = this.assets.find(item => item.id === id);
    if (!asset) throw new LibraryError('找不到该图片', 404);
    if (!includeDeleted && asset.deletedAt !== null) throw new LibraryError('图片已移出图库，请先恢复后使用', 410);
    return asset;
  }

  async file(id, kind) {
    const asset = this.getAsset(id, { includeDeleted: true });
    const filePath = kind === 'thumbnail'
      ? path.join(this.directory, 'thumbnails', `${id}.jpeg`)
      : path.join(this.directory, 'images', `${id}.${asset.format}`);
    try { await stat(filePath); } catch (error) {
      if (error.code === 'ENOENT') throw new LibraryError('图片文件已丢失，请重新导入素材', 404);
      throw error;
    }
    return { path: filePath, type: kind === 'thumbnail' ? 'image/jpeg' : `image/${asset.format}` };
  }

  async insertion(id, profile = 'original') {
    validateProfile(profile);
    const asset = this.getAsset(id);
    const filePath = asset.format === 'webp' || asset.normalized
      ? path.join(this.directory, 'insertion', `${id}.png`)
      : (await this.file(id, 'image')).path;
    let details;
    try { details = await this.quality.originalDetails(filePath); } catch (error) {
      if (error.code === 'ENOENT') throw new LibraryError('图片文件已丢失，请重新导入素材', 404);
      throw error;
    }
    if (!details.isFile() || details.size <= 0) throw new LibraryError('插入文件类型或大小无效，请重新导入原素材', 500);
    const output = profile === 'original'
      ? { path: filePath, width: asset.width, height: asset.height, format: asset.normalized || asset.format === 'webp' ? 'png' : asset.format, bytes: details.size }
      : await this.quality.get(id, profile, filePath, () => this.getAsset(id));
    const current = this.getAsset(id);
    return { ...output, name: current.name, profile, sourceBytes: current.bytes };
  }

  async importImage(name, buffer, categories = []) {
    name = safeName(name);
    categories = metadataList(categories, 'categories');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new LibraryError('单张图片须大于 0 字节且不超过 32 MB', 413);
    const image = sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' });
    let metadata;
    let thumbnail;
    try {
      metadata = await image.metadata();
      if (!formats.has(metadata.format)) throw new LibraryError('仅支持 JPEG、PNG、WebP 图片；BMP 请先转换为 PNG');
      if (metadata.pages > 1) throw new LibraryError('暂不支持动态或多页图片，请先转换为静态 PNG');
      thumbnail = await image.clone().rotate().resize(384, 288, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
    } catch (error) {
      if (error instanceof LibraryError) throw error;
      throw new LibraryError(`无法读取图片：仅支持 JPEG、PNG、WebP，单图不超过 6400 万像素；BMP 请先转换为 PNG。${error.message}`);
    }
    const id = createHash('sha256').update(buffer).digest('hex');
    const normalized = metadata.format === 'webp' || (metadata.orientation >= 2 && metadata.orientation <= 8);
    const existing = this.assets.find(asset => asset.id === id);
    if (existing) {
      const restoring = existing.deletedAt !== null;
      const aliases = restoring ? existing.aliases
        : mergeMetadata(existing.aliases, matchKey(existing.name) === matchKey(name) ? [] : [name], 'aliases');
      const mergedCategories = restoring ? existing.categories : mergeMetadata(existing.categories, categories, 'categories');
      // Restore missing managed files on reimport, as the missing-file message directs.
      await this.writeImages(id, metadata.format, buffer, thumbnail, image, normalized);
      if (existing.deletedAt !== null || aliases.length !== existing.aliases.length || mergedCategories.length !== existing.categories.length || existing.normalized !== normalized) {
        const updated = { ...existing, normalized, aliases, categories: mergedCategories, deletedAt: null };
        await this.persist(this.assets.map(asset => asset.id === id ? updated : asset));
      }
      return existing.deletedAt !== null ? 'restored' : 'duplicates';
    }
    await this.writeImages(id, metadata.format, buffer, thumbnail, image, normalized);
    const rotated = metadata.orientation >= 5 && metadata.orientation <= 8;
    const asset = { id, name, aliases: [], categories, tags: [], deletedAt: null, format: metadata.format, bytes: buffer.length, normalized,
      width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height };
    await this.persist([...this.assets, asset]);
    return 'imported';
  }

  async writeImages(id, format, buffer, thumbnail, image, normalized) {
    await replaceFile(path.join(this.directory, 'images', `${id}.${format}`), buffer);
    await replaceFile(path.join(this.directory, 'thumbnails', `${id}.jpeg`), thumbnail);
    if (normalized) await replaceFile(path.join(this.directory, 'insertion', `${id}.png`), await image.clone().rotate().png().toBuffer());
  }

  importFile(name, buffer, category) {
    return this.serialize(async () => {
      const categories = category === undefined ? [] : [metadataText(category, 'categories', 255)];
      const result = { imported: 0, duplicates: 0, restored: 0, failed: [], total: this.activeTotal };
      try { result[await this.importImage(name, buffer, categories)]++; } catch (error) {
        if (!(error instanceof LibraryError)) throw error;
        result.failed.push({ name: typeof name === 'string' ? name : '', error: error.message });
      }
      result.total = this.activeTotal;
      return result;
    });
  }

  async prepareImportDirectory(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) {
      throw new LibraryError('请输入素材文件夹的完整本地路径');
    }
    const source = path.resolve(directory);
    let details;
    try {
      // Reject junctions in ancestors too: validating only the final directory
      // would allow a stored retry source to be redirected through its parent.
      const root = path.parse(source).root;
      let component = root;
      for (const part of source.slice(root.length).split(path.sep).filter(Boolean)) {
        component = path.join(component, part);
        details = await lstat(component);
        if (details.isSymbolicLink()) throw new LibraryError('请选择实际文件夹，路径不能包含符号链接');
      }
      details = await lstat(source);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new LibraryError('素材文件夹不存在');
      throw error;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) throw new LibraryError('请选择实际文件夹，不能使用文件或符号链接');
    const root = await realpath(source);
    const storage = await realpath(this.directory);
    if (pathContains(root, storage) || pathContains(storage, root)) throw new LibraryError('素材目录不能包含图库的存储目录，也不能位于图库内');
    return { source, root };
  }

  async resolveImportSource(context, relativePath, kind) {
    const current = await this.prepareImportDirectory(context.source);
    if (comparablePath(current.root) !== comparablePath(context.root)) throw new LibraryError('来源目录指向已改变，请重新选择素材目录');
    if (typeof relativePath !== 'string' || relativePath.includes('\\') || relativePath.includes('\0')
      || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
      || relativePath.split('/').some(part => part === '.' || part === '..' || part.includes(':'))
      || (relativePath && relativePath.split('/').some(part => !part))) throw new LibraryError('来源相对路径无效');
    const parts = relativePath ? relativePath.split('/') : [];
    let candidate = context.root;
    let details = await lstat(candidate);
    for (const [index, part] of parts.entries()) {
      candidate = path.join(candidate, part);
      details = await lstat(candidate);
      if (details.isSymbolicLink()) throw new LibraryError('来源已变为符号链接，请重新选择实际文件');
      if (index < parts.length - 1 && !details.isDirectory()) throw new LibraryError('来源目录结构已改变');
    }
    if ((kind === 'file' && !details.isFile()) || (kind === 'directory' && !details.isDirectory())) throw new LibraryError('来源文件类型已改变');
    if (!pathContains(context.root, await realpath(candidate))) throw new LibraryError('来源文件已移出所选目录');
    return { path: candidate, details };
  }

  async *walkImportDirectory(context, { relativePath = '', budget = { entries: 0 }, limit = MAX_IMPORT_ENTRIES } = {}) {
    let folder;
    try {
      const resolved = await this.resolveImportSource(context, relativePath, 'directory');
      folder = await opendir(resolved.path);
    } catch (error) {
      yield { kind: 'directory', relativePath, name: path.posix.basename(relativePath) || path.basename(context.root) || '根目录', error };
      return;
    }
    try {
      for await (const entry of folder) {
        const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        budget.entries++;
        if (budget.entries > limit) throw new LibraryError(`目录扫描达到 ${limit} 个文件或目录的上限，已停止于「${child}」，其后项目尚未扫描，请选择更小的目录`);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          yield* this.walkImportDirectory(context, { relativePath: child, budget, limit });
        } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
          yield { kind: 'file', name: entry.name, relativePath: child };
        }
      }
    } catch (error) {
      if (error instanceof LibraryError) throw error;
      yield { kind: 'directory', relativePath, name: path.posix.basename(relativePath) || path.basename(context.root) || '根目录', error };
    }
  }

  async importSourceFile(context, descriptor) {
    const { name, buffer, categories } = await this.readImportSource(context, descriptor);
    return this.serialize(() => this.importImage(name, buffer, categories));
  }

  // 读取导入来源的一张图片：校验路径未被替换，文件夹名映射为分类。局域网客户端用它读取后上传到服务器。
  async readImportSource(context, descriptor) {
    const source = await this.resolveImportSource(context, descriptor.relativePath, 'file');
    if (source.details.size > MAX_IMAGE_BYTES) throw new LibraryError('单张图片不超过 32 MB', 413);
    const handle = await open(source.path, 'r');
    let buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== source.details.dev || opened.ino !== source.details.ino) throw new LibraryError('来源文件在读取前已改变，请重新选择');
      const verified = await this.resolveImportSource(context, descriptor.relativePath, 'file');
      if (opened.dev !== verified.details.dev || opened.ino !== verified.details.ino) throw new LibraryError('来源文件在读取前已改变，请重新选择');
      const chunks = [];
      let length = 0;
      const stream = handle.createReadStream({ autoClose: false });
      try {
        for await (const chunk of stream) {
          length += chunk.length;
          if (length > MAX_IMAGE_BYTES) throw new LibraryError('单张图片不超过 32 MB', 413);
          chunks.push(chunk);
        }
      } finally { stream.destroy(); }
      buffer = Buffer.concat(chunks);
    } finally { await handle.close(); }
    const parent = path.posix.dirname(descriptor.relativePath);
    const category = parent === '.' ? path.basename(context.root) : parent;
    return { name: descriptor.name, buffer, categories: category ? [category] : [] };
  }

  async importDirectory(directory) {
    const context = await this.prepareImportDirectory(directory);
    const result = { imported: 0, duplicates: 0, restored: 0, failed: [], total: this.activeTotal };
    for await (const entry of this.walkImportDirectory(context)) {
      try {
        if (entry.error) throw entry.error;
        result[await this.importSourceFile(context, entry)]++;
      } catch (error) {
        result.failed.push({ name: entry.name, error: importErrorMessage(error) });
        if (result.failed.length >= MAX_IMPORT_FAILURES) throw new LibraryError(`导入达到 ${MAX_IMPORT_FAILURES} 项失败报告上限，已停止；已成功导入 ${result.imported} 张、恢复 ${result.restored} 张，结果仍保留`);
      }
    }
    result.total = this.activeTotal;
    return result;
  }
}
