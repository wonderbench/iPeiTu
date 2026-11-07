import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { LibraryError, MAX_IMAGE_PIXELS } from './library.js';
import { validateProfile } from './insertion-quality.js';
import { MIN_BOX_PT, MAX_BOX_PT } from './placeholder.js';

// cover 裁切填满，fill 拉伸填满，contain 完整显示并补白。
export const FIT_MODES = ['cover', 'fill', 'contain'];
// 框尺寸已知，按打印分辨率出图；原图档也设上限，避免小框嵌入整张大图。
const PROFILE_DPI = { original: 300, clear: 220, balanced: 150 };
const RULE_VERSION = 'v1';
const numberPattern = /^\d{1,4}(?:\.\d{1,3})?$/;

export function validateFit(input) {
  const mode = input.mode;
  if (!FIT_MODES.includes(mode)) throw new LibraryError('mode 仅接受 cover、fill 或 contain');
  const box = {};
  for (const key of ['widthPt', 'heightPt']) {
    const text = input[key];
    const value = typeof text === 'string' && numberPattern.test(text) ? Number(text) : NaN;
    if (!(value >= MIN_BOX_PT && value <= MAX_BOX_PT)) throw new LibraryError(`占位框宽高须在 ${MIN_BOX_PT}–${MAX_BOX_PT} 磅之间`);
    box[key] = Math.round(value * 10) / 10;
  }
  const profile = validateProfile(input.profile ?? 'original');
  return { mode, profile, ...box };
}

// 输出像素保持框的比例，且不超过原图能提供的分辨率。
export function fitPixels(source, box, mode, dpi) {
  const width = box.widthPt / 72 * dpi;
  const height = box.heightPt / 72 * dpi;
  const scale = mode === 'cover'
    ? Math.min(1, source.width / width, source.height / height)
    : Math.min(1, Math.max(source.width / width, source.height / height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export class Fitter {
  constructor(library) {
    this.library = library;
    this.directory = path.join(library.directory, 'fitted');
  }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true });
    const details = await lstat(this.directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new LibraryError('适配图目录类型无效，请检查图库目录', 500);
  }

  async create(id, input) {
    const fit = validateFit(input);
    const source = await this.library.insertion(id, 'original');
    const pixels = fitPixels(source, fit, fit.mode, PROFILE_DPI[fit.profile]);
    let metadata;
    try { metadata = await sharp(source.path, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata(); } catch {
      throw new LibraryError('插入原档已损坏，请重新导入原素材', 500);
    }
    const format = metadata.hasAlpha ? 'png' : 'jpeg';
    await this.ensureDirectory();
    const key = createHash('sha256').update(JSON.stringify([RULE_VERSION, id, fit.mode, pixels.width, pixels.height, format])).digest('hex');
    const filename = path.join(this.directory, `${key}.${format === 'png' ? 'png' : 'jpg'}`);
    if (!(await this.validCache(filename, pixels, format))) {
      let image = sharp(source.path, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).rotate()
        .resize({ width: pixels.width, height: pixels.height, fit: fit.mode, position: 'centre', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .toColourspace('srgb');
      image = format === 'png' ? image.png({ compressionLevel: 9 }) : image.jpeg({ quality: 90 });
      const buffer = await image.toBuffer();
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, buffer, { flag: 'wx' });
        await rename(temporary, filename);
      } finally {
        try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    const current = this.library.getAsset(id);
    const bytes = (await lstat(filename)).size;
    return { path: filename, name: current.name, mode: fit.mode, profile: fit.profile, widthPt: fit.widthPt, heightPt: fit.heightPt, ...pixels, format, bytes };
  }

  async validCache(filename, pixels, format) {
    try {
      const details = await lstat(filename);
      if (!details.isFile()) return false;
      const metadata = await sharp(filename).metadata();
      return metadata.format === format && metadata.width === pixels.width && metadata.height === pixels.height;
    } catch (error) {
      if (error.code && error.code !== 'ENOENT') throw error;
      return false; // 不存在或无法解码时重新生成。
    }
  }
}
