import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

export async function verifyQuality({ base }) {
  let seed = 517;
  const width = 2600, height = 1800;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24; }
  const source = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).withMetadata({ density: 300 }).toBuffer();
  async function upload(name, buffer) {
    const response = await fetch(`${base}/api/import-file?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.imported, 1);
    const library = await (await fetch(`${base}/api/library`)).json();
    return library.assets.find(asset => asset.name === name).id;
  }
  async function variant(id, profile) {
    const response = await fetch(`${base}/api/assets/${id}/insertion?profile=${profile}`);
    assert.equal(response.status, 200);
    return response.json();
  }
  const id = await upload('质量验收高分辨率.jpg', source);
  const original = await variant(id, 'original');
  assert.deepEqual(await readFile(original.path), source, '原图插入文件字节不变');
  assert.equal(original.sourceBytes, source.length);
  for (const [profile, edge] of [['clear', 2400], ['balanced', 1600]]) {
    const result = await variant(id, profile);
    const bytes = await readFile(result.path);
    const metadata = await sharp(bytes).metadata();
    assert.equal(result.profile, profile);
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.sourceBytes, source.length);
    assert.equal(Math.max(metadata.width, metadata.height), edge);
    assert.equal(metadata.width, result.width);
    assert.equal(metadata.height, result.height);
    assert.ok(bytes.length < source.length, `${profile} 高细节测试图体积减小`);
    assert.ok(Math.abs(result.logicalWidthPt - 624) < 1, '已知 DPI 的排版宽度不随压缩改变');
  }
  const alpha = await sharp({ create: { width: 2200, height: 1800, channels: 4, background: { r: 22, g: 120, b: 125, alpha: .35 } } }).png().toBuffer();
  const alphaId = await upload('质量验收透明.png', alpha);
  const alphaResult = await variant(alphaId, 'balanced');
  const alphaMetadata = await sharp(await readFile(alphaResult.path)).metadata();
  assert.equal(alphaMetadata.format, 'png');
  assert.equal(alphaMetadata.hasAlpha, true);
  assert.equal(alphaMetadata.width, 1600);
  const small = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#716267' } }).png().toBuffer();
  const smallId = await upload('质量验收小图.png', small);
  const smallResult = await variant(smallId, 'balanced');
  assert.equal(smallResult.width, 120);
  assert.equal(smallResult.height, 80);
  const rotated = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).withMetadata({ orientation: 6, density: 150 }).toBuffer();
  const rotatedId = await upload('质量验收旋转.jpg', rotated);
  const rotatedResult = await variant(rotatedId, 'balanced');
  const rotatedMetadata = await sharp(await readFile(rotatedResult.path)).metadata();
  assert.equal(rotatedMetadata.width, 1108);
  assert.equal(rotatedMetadata.height, 1600);
  assert.ok(!rotatedMetadata.orientation || rotatedMetadata.orientation === 1, '压缩副本旋转烘焙且不再带旋转标记');
  const rawJpeg = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  let cursor = 2; const pieces = [rawJpeg.subarray(0, 2)];
  while (cursor < rawJpeg.length) {
    const marker = rawJpeg[cursor + 1];
    if (marker === 0xda) { pieces.push(rawJpeg.subarray(cursor)); break; }
    const length = rawJpeg.readUInt16BE(cursor + 2);
    if (marker !== 0xe0 && marker !== 0xe1) pieces.push(rawJpeg.subarray(cursor, cursor + length + 2));
    cursor += length + 2;
  }
  const noDensity = Buffer.concat(pieces);
  const noDensityId = await upload('质量验收无密度.jpg', noDensity);
  const fallback = await variant(noDensityId, 'balanced');
  assert.equal(fallback.format, 'jpeg');
  assert.ok(Math.abs(fallback.naturalWidthScale - width / 1600) < 0.00001);
  assert.equal(fallback.logicalWidthPt, undefined);
  const encoded = await readFile(fallback.path);
  assert.ok(!(encoded[2] === 0xff && [0xe0, 0xe1].includes(encoded[3])), '无分辨率 JPEG 不注入 JFIF 或 EXIF 标记');
  const invalid = await fetch(`${base}/api/assets/${id}/insertion?profile=invalid`);
  assert.equal(invalid.status, 400);
  console.log('质量档验收通过：原图字节、两档尺寸与体积、DPI 逻辑宽度、透明 PNG、小图不放大、无效档位拒绝。');
}
