import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { LibraryError } from './library.js';

// 0.5–50 厘米，与排版设置的范围一致。
export const MIN_BOX_PT = 14;
export const MAX_BOX_PT = 1440;
const RULE_VERSION = 'v1';
const PIXELS_PER_POINT = 4 / 3; // 96 dpi；插入后按磅值设定尺寸，像素只决定清晰度。
const controlCharacters = /[\x00-\x1f\x7f\u2028\u2029]/;

export function validatePlaceholder(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join() !== 'heightPt,name,widthPt') {
    throw new LibraryError('占位框仅接受 name、widthPt 和 heightPt');
  }
  if (typeof input.name !== 'string' || controlCharacters.test(input.name)) throw new LibraryError('框名须为单行文字');
  const name = input.name.trim();
  if (!name || name.length > 100) throw new LibraryError('框名须为 1–100 个字符');
  const size = {};
  for (const key of ['widthPt', 'heightPt']) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_BOX_PT || value > MAX_BOX_PT) {
      throw new LibraryError(`占位框宽高须在 ${MIN_BOX_PT}–${MAX_BOX_PT} 磅之间`);
    }
    size[key] = Math.round(value * 10) / 10;
  }
  return { name, ...size };
}

const escapeXml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const centimeters = points => (points * 2.54 / 72).toFixed(1);

function placeholderSvg({ name, widthPt, heightPt }, width, height) {
  const nameSize = Math.round(Math.max(12, Math.min(48, Math.min(width, height) * 0.12)));
  const sizeSize = Math.round(nameSize * 0.7);
  const capacity = Math.max(1, Math.floor(width * 0.9 / nameSize));
  const label = [...name].length > capacity ? `${[...name].slice(0, Math.max(1, capacity - 1)).join('')}…` : name;
  const border = Math.max(1, Math.round(Math.min(width, height) / 160));
  const dash = border * 6;
  const font = 'Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif';
  // 中性灰：占位框若未填就打印，也不会带出强调色。
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="#f4f4f5"/>`
    + `<rect x="${border / 2}" y="${border / 2}" width="${width - border}" height="${height - border}" fill="none" stroke="#8a8a8f" stroke-width="${border}" stroke-dasharray="${dash} ${dash}"/>`
    + `<text x="50%" y="50%" text-anchor="middle" font-family="${font}" font-size="${nameSize}" fill="#3f3f46">${escapeXml(label)}</text>`
    + `<text x="50%" y="50%" dy="${Math.round(nameSize * 1.4)}" text-anchor="middle" font-family="${font}" font-size="${sizeSize}" fill="#6b6b6f">${centimeters(widthPt)} × ${centimeters(heightPt)} 厘米</text>`
    + '</svg>';
}

export class Placeholders {
  constructor(libraryDirectory) {
    this.directory = path.join(libraryDirectory, 'placeholders');
  }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true });
    const details = await lstat(this.directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new LibraryError('占位图目录类型无效，请检查图库目录', 500);
  }

  async create(input) {
    const box = validatePlaceholder(input);
    const width = Math.max(1, Math.round(box.widthPt * PIXELS_PER_POINT));
    const height = Math.max(1, Math.round(box.heightPt * PIXELS_PER_POINT));
    await this.ensureDirectory();
    const key = createHash('sha256').update(JSON.stringify([RULE_VERSION, box.name, box.widthPt, box.heightPt])).digest('hex');
    const filename = path.join(this.directory, `${key}.png`);
    if (!(await this.validCache(filename, width, height))) {
      const image = await sharp(Buffer.from(placeholderSvg(box, width, height))).png().toBuffer();
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, image, { flag: 'wx' });
        await rename(temporary, filename);
      } finally {
        try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    return { path: filename, name: box.name, widthPt: box.widthPt, heightPt: box.heightPt, width, height };
  }

  async validCache(filename, width, height) {
    try {
      const details = await lstat(filename);
      if (!details.isFile()) return false;
      const metadata = await sharp(filename).metadata();
      return metadata.format === 'png' && metadata.width === width && metadata.height === height;
    } catch (error) {
      if (error.code && error.code !== 'ENOENT') throw error;
      return false; // 不存在或无法解码时重新生成。
    }
  }
}
