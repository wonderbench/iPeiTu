import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64 * 1000 * 1000;
const formats = new Set(['jpeg', 'png', 'webp']);
const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.svg', '.heic', '.avif']);
const idPattern = /^[a-f0-9]{64}$/;

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
    this.pending = Promise.resolve();
  }

  static async open(directory = defaultDataDirectory()) {
    const library = new Library(directory);
    await mkdir(path.join(library.directory, 'images'), { recursive: true });
    await mkdir(path.join(library.directory, 'thumbnails'), { recursive: true });
    await mkdir(path.join(library.directory, 'insertion'), { recursive: true });
    let text;
    try {
      text = await readFile(path.join(library.directory, 'index.json'), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return library;
    }
    let index;
    try { index = JSON.parse(text); } catch {
      throw new LibraryError('图库索引不是有效 JSON，请保留原文件并恢复备份', 500);
    }
    if (!index || index.version !== 1 || !Array.isArray(index.assets) || !index.assets.every(validRecord)
      || new Set(index.assets.map(asset => asset.id)).size !== index.assets.length) {
      throw new LibraryError('图库索引结构损坏，无法安全读取', 500);
    }
    library.assets = index.assets;
    return library;
  }

  serialize(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {}); // Keep later imports usable after an explicitly reported failure.
    return result;
  }

  async persist(assets) {
    const temporary = path.join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify({ version: 1, assets }, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path.join(this.directory, 'index.json'));
    this.assets = assets;
  }

  list(query = '') {
    const search = query.trim().normalize('NFKC').toLocaleLowerCase();
    const assets = this.assets.filter(asset => [asset.name, ...asset.aliases]
      .some(name => name.normalize('NFKC').toLocaleLowerCase().includes(search)))
      .map(asset => ({ ...asset, aliases: [...asset.aliases],
        thumbnailUrl: `/api/assets/${asset.id}/thumbnail`, imageUrl: `/api/assets/${asset.id}/image` }));
    return { assets, total: this.assets.length };
  }

  getAsset(id) {
    if (!idPattern.test(id)) throw new LibraryError('找不到该图片', 404);
    const asset = this.assets.find(item => item.id === id);
    if (!asset) throw new LibraryError('找不到该图片', 404);
    return asset;
  }

  async file(id, kind) {
    const asset = this.getAsset(id);
    const filePath = kind === 'thumbnail'
      ? path.join(this.directory, 'thumbnails', `${id}.jpeg`)
      : path.join(this.directory, 'images', `${id}.${asset.format}`);
    try { await stat(filePath); } catch (error) {
      if (error.code === 'ENOENT') throw new LibraryError('图片文件已丢失，请重新导入素材', 404);
      throw error;
    }
    return { path: filePath, type: kind === 'thumbnail' ? 'image/jpeg' : `image/${asset.format}` };
  }

  async insertion(id) {
    const asset = this.getAsset(id);
    const filePath = asset.format === 'webp' || asset.normalized
      ? path.join(this.directory, 'insertion', `${id}.png`)
      : (await this.file(id, 'image')).path;
    try { await stat(filePath); } catch (error) {
      if (error.code === 'ENOENT') throw new LibraryError('图片文件已丢失，请重新导入素材', 404);
      throw error;
    }
    return { path: filePath, name: asset.name, width: asset.width, height: asset.height };
  }

  async importImage(name, buffer) {
    name = safeName(name);
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
      // Restore missing managed files on reimport, as the missing-file message directs.
      await this.writeImages(id, metadata.format, buffer, thumbnail, image, normalized);
      const newAlias = existing.name !== name && !existing.aliases.includes(name);
      if (newAlias || existing.normalized !== normalized) {
        const updated = { ...existing, normalized, aliases: newAlias ? [...existing.aliases, name] : existing.aliases };
        await this.persist(this.assets.map(asset => asset.id === id ? updated : asset));
      }
      return 'duplicates';
    }
    await this.writeImages(id, metadata.format, buffer, thumbnail, image, normalized);
    const rotated = metadata.orientation >= 5 && metadata.orientation <= 8;
    const asset = { id, name, aliases: [], format: metadata.format, bytes: buffer.length, normalized,
      width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height };
    await this.persist([...this.assets, asset]);
    return 'imported';
  }

  async writeImages(id, format, buffer, thumbnail, image, normalized) {
    await replaceFile(path.join(this.directory, 'images', `${id}.${format}`), buffer);
    await replaceFile(path.join(this.directory, 'thumbnails', `${id}.jpeg`), thumbnail);
    if (normalized) await replaceFile(path.join(this.directory, 'insertion', `${id}.png`), await image.clone().rotate().png().toBuffer());
  }

  importFile(name, buffer) {
    return this.serialize(async () => {
      const result = { imported: 0, duplicates: 0, failed: [], total: this.assets.length };
      try { result[await this.importImage(name, buffer)]++; } catch (error) {
        if (!(error instanceof LibraryError)) throw error;
        result.failed.push({ name: typeof name === 'string' ? name : '', error: error.message });
      }
      result.total = this.assets.length;
      return result;
    });
  }

  importDirectory(directory) {
    return this.serialize(async () => {
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) {
        throw new LibraryError('请输入素材文件夹的完整本地路径');
      }
      let root;
      try { root = await lstat(directory); } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new LibraryError('素材文件夹不存在');
        throw error;
      }
      if (!root.isDirectory() || root.isSymbolicLink()) throw new LibraryError('请选择实际文件夹，不能使用文件或符号链接');
      const rootPath = await realpath(directory);
      const libraryPath = await realpath(this.directory);
      const compareRoot = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath;
      const compareLibrary = process.platform === 'win32' ? libraryPath.toLowerCase() : libraryPath;
      const isWithin = (parent, child) => {
        const relative = path.relative(parent, child);
        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      };
      if (isWithin(compareRoot, compareLibrary) || isWithin(compareLibrary, compareRoot)) {
        throw new LibraryError('素材目录不能包含图库的存储目录，也不能位于图库内');
      }
      const result = { imported: 0, duplicates: 0, failed: [], total: this.assets.length };
      const visit = async current => {
        let entries;
        try { entries = await readdir(current, { withFileTypes: true }); } catch (error) {
          result.failed.push({ name: path.basename(current), error: `无法读取文件夹：${error.message}` });
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        for (const entry of entries) {
          const filePath = path.join(current, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { await visit(filePath); continue; }
          if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
          let buffer;
          try {
            const details = await lstat(filePath);
            if (details.isSymbolicLink() || !details.isFile()) continue;
            if (details.size > MAX_IMAGE_BYTES) throw new LibraryError('单张图片不超过 32 MB', 413);
            buffer = await readFile(filePath);
          } catch (error) {
            result.failed.push({ name: entry.name, error: error.message });
            continue;
          }
          try { result[await this.importImage(entry.name, buffer)]++; } catch (error) {
            if (!(error instanceof LibraryError)) throw error;
            result.failed.push({ name: entry.name, error: error.message });
          }
        }
      };
      await visit(rootPath);
      result.total = this.assets.length;
      return result;
    });
  }
}
