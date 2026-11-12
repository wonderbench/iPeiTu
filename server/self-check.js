import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { clientIdPattern, LibraryError } from './library.js';
import { Placeholders } from './placeholder.js';

export async function prepareSelfCheck() {
  const id = randomUUID();
  const directory = path.join(await realpath(os.tmpdir()), `ipeitu-self-check-${id}`);
  await mkdir(directory);
  try {
    const boxOptions = { name: 'iPeiTu 自检占位框', size: 'fixed', widthCm: 9, heightCm: 12 };
    const box = await new Placeholders(directory).create({
      name: boxOptions.name, widthPt: boxOptions.widthCm * 72 / 2.54, heightPt: boxOptions.heightCm * 72 / 2.54,
    });
    const image = { name: '自检横图.png', path: path.join(directory, 'test-image.png'), logicalWidthPt: 72, logicalHeightPt: 48 };
    const replacement = { name: '自检竖图.png', path: path.join(directory, 'test-replacement.png') };
    await sharp({ create: { width: 96, height: 64, channels: 3, background: '#17645e' } })
      .withDensity(96).png().toFile(image.path);
    const replacementBytes = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#9c6235' } })
      .withDensity(96).png().toBuffer();
    await writeFile(replacement.path, replacementBytes, { flag: 'wx' });
    const assetId = createHash('sha256').update(replacementBytes).digest('hex');
    return { id, documentPath: path.join(directory, 'iPeiTu-自检.docx'), image, replacement, assetId, box, boxOptions };
  } catch (error) {
    await removeSelfCheck(id);
    throw error;
  }
}

export async function removeSelfCheck(id) {
  if (!clientIdPattern.test(id)) throw new LibraryError('无效的自检标识');
  const directory = path.join(await realpath(os.tmpdir()), `ipeitu-self-check-${id}`);
  const details = await lstat(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!details) return;
  if (!details.isDirectory() || details.isSymbolicLink()) throw new LibraryError('自检临时目录类型无效', 409);
  await rm(directory, { recursive: true, force: true, maxRetries: 2 });
}
