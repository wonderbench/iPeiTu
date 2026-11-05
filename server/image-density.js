// Read only physical resolution fields; sharp.metadata().density rounds to an integer
// and also reports a decoder default for some files without any resolution fields.
function exifResolution(buffer) {
  const start = buffer.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ? 6 : 0;
  const tiff = buffer.subarray(start);
  const little = tiff.toString('ascii', 0, 2) === 'II';
  if (!little && tiff.toString('ascii', 0, 2) !== 'MM') throw new Error('EXIF 字节顺序无效');
  const check = (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > tiff.length) throw new Error('EXIF 分辨率数据越界');
  };
  const u16 = offset => { check(offset, 2); return little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset); };
  const u32 = offset => { check(offset, 4); return little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset); };
  if (u16(2) !== 42) throw new Error('EXIF 头无效');
  const offset = u32(4);
  const count = u16(offset);
  check(offset + 2, count * 12);
  const values = {};
  for (let index = 0; index < count; index++) {
    const at = offset + 2 + index * 12;
    const tag = u16(at);
    if (![0x11a, 0x11b, 0x128].includes(tag)) continue;
    if (Object.hasOwn(values, tag)) throw new Error('EXIF 分辨率字段重复');
    const type = u16(at + 2), items = u32(at + 4);
    if (items !== 1 || (tag === 0x128 ? type !== 3 : type !== 5)) throw new Error('EXIF 分辨率字段类型无效');
    if (tag === 0x128) values[tag] = u16(at + 8);
    else {
      const position = u32(at + 8), denominator = u32(position + 4);
      if (!denominator) throw new Error('EXIF 分辨率分母为零');
      values[tag] = u32(position) / denominator;
    }
  }
  if (!Object.keys(values).length || values[0x128] === 1) return null;
  // EXIF specifies inches when ResolutionUnit is omitted.
  const unit = values[0x128] ?? 2;
  if (![2, 3].includes(unit) || !values[0x11a] || !values[0x11b]) throw new Error('EXIF 物理分辨率不完整');
  return { x: values[0x11a] * (unit === 3 ? 2.54 : 1), y: values[0x11b] * (unit === 3 ? 2.54 : 1) };
}

function equivalent(a, b, precision = 0) {
  return Math.abs(a - b) <= precision + 1e-7;
}

export function physicalResolution(buffer, format) {
  const resolutions = [];
  if (format === 'png') {
    for (let offset = 8; offset < buffer.length;) {
      if (offset + 12 > buffer.length) throw new Error('PNG 数据不完整');
      const length = buffer.readUInt32BE(offset), end = offset + length + 12;
      if (end > buffer.length) throw new Error('PNG 分辨率数据越界');
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      if (type === 'pHYs') {
        if (length !== 9) throw new Error('PNG pHYs 结构无效');
        const x = buffer.readUInt32BE(offset + 8), y = buffer.readUInt32BE(offset + 12), unit = buffer[offset + 16];
        // pHYs stores integer pixels/metre, whose half-unit error is 0.0127 DPI.
        if (unit === 1) resolutions.push({ x: x * 0.0254, y: y * 0.0254, precision: 0.0127 });
        else if (unit !== 0 || x !== y) throw new Error('PNG 像素比例或分辨率单位暂不支持');
      } else if (type === 'eXIf') {
        const resolution = exifResolution(buffer.subarray(offset + 8, offset + 8 + length));
        if (resolution) resolutions.push(resolution);
      }
      offset = end;
      if (type === 'IEND') break;
    }
  } else if (format === 'jpeg') {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset++] !== 0xff) throw new Error('JPEG 标记无效');
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) throw new Error('JPEG 数据不完整');
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) throw new Error('JPEG 分辨率数据越界');
      const segment = buffer.subarray(offset + 2, offset + length);
      if (marker === 0xe0 && segment.toString('ascii', 0, 5) === 'JFIF\0') {
        if (segment.length < 14) throw new Error('JFIF 数据不完整');
        const unit = segment[7], x = segment.readUInt16BE(8), y = segment.readUInt16BE(10);
        if (unit === 1 || unit === 2) resolutions.push({ x: x * (unit === 2 ? 2.54 : 1), y: y * (unit === 2 ? 2.54 : 1) });
        else if (unit !== 0 || x !== y) throw new Error('JPEG 像素比例或分辨率单位暂不支持');
      } else if (marker === 0xe1 && segment.toString('ascii', 0, 6) === 'Exif\0\0') {
        const resolution = exifResolution(segment);
        if (resolution) resolutions.push(resolution);
      }
      offset += length;
    }
  } else throw new Error('插入原档的格式暂不支持压缩');
  for (const resolution of resolutions) {
    if (![resolution.x, resolution.y].every(value => Number.isFinite(value) && value > 0 && value <= 100000)
      || !equivalent(resolution.x, resolution.y)) throw new Error('图片含无效或非方形 DPI，请使用原图档');
    if (!equivalent(resolution.x, resolutions[0].x, (resolution.precision || 0) + (resolutions[0].precision || 0))) {
      throw new Error('图片分辨率字段相互冲突，请使用原图档');
    }
  }
  return resolutions.length ? { x: resolutions[0].x, y: resolutions[0].y } : null;
}

export function logicalSize(buffer, metadata, fallbackDensity = null) {
  const resolution = physicalResolution(buffer, metadata.format);
  const density = resolution?.x ?? fallbackDensity;
  if (!density) throw new Error('图片没有物理分辨率，当前宿主的默认尺寸尚未验证，请使用原图档');
  const width = metadata.width * 72 / density, height = metadata.height * 72 / density;
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 100000000)) throw new Error('图片逻辑尺寸无效，请使用原图档');
  return { logicalWidthPt: width, logicalHeightPt: height };
}

function jpegHeaders(buffer) {
  const segments = [];
  let offset = 2;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer[offset++] !== 0xff) throw new Error('JPEG 标记无效');
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xda || marker === 0xd9) return { segments, tail: buffer.subarray(start) };
    if (offset + 2 > buffer.length) throw new Error('JPEG 数据不完整');
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw new Error('JPEG 数据越界');
    segments.push({ marker, data: buffer.subarray(offset + 2, offset + length), bytes: buffer.subarray(start, offset + length) });
    offset += length;
  }
  throw new Error('JPEG 缺少图像数据');
}

export function densityPolicy(buffer, format) {
  const resolution = physicalResolution(buffer, format);
  if (resolution && format === 'png') {
    let physicalHeader = false;
    for (let offset = 8; offset < buffer.length;) {
      const length = buffer.readUInt32BE(offset);
      if (buffer.toString('ascii', offset + 4, offset + 8) === 'pHYs' && buffer[offset + 16] === 1) physicalHeader = true;
      offset += length + 12;
    }
    if (!physicalHeader) throw new Error('PNG 仅含 EXIF 分辨率，尚不能确认宿主自然尺寸，请使用原图档');
  }
  if (resolution) return { kind: 'physical', resolution };
  // Preserve absence/unitless square declarations exactly. Their interpretation
  // belongs to WPS and can differ between formats and host display settings.
  if (format === 'jpeg') {
    const headers = jpegHeaders(buffer).segments;
    const app0 = headers.filter(item => item.marker === 0xe0);
    if (headers.some(item => item.marker === 0xe1 && item.data.toString('ascii', 0, 6) === 'Exif\0\0')) {
      throw new Error('EXIF 含无物理单位的分辨率声明，暂不能保持原自然尺寸，请使用原图档');
    }
    if (app0.length > 1 || (app0.length && (app0[0].data.toString('ascii', 0, 5) !== 'JFIF\0' || app0[0].data[7] !== 0))) {
      throw new Error('JPEG 含无法确认的分辨率标记，请使用原图档');
    }
    let marker = null;
    if (app0.length) {
      marker = Buffer.alloc(18);
      marker[0] = 0xff; marker[1] = 0xe0; marker.writeUInt16BE(16, 2);
      app0[0].data.copy(marker, 4, 0, 12); // Keep JFIF version/unit/density, discard source thumbnails.
    }
    return { kind: 'native', format, marker, key: `jpeg:${marker?.toString('hex') || 'none'}` };
  }
  let marker = null;
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'eXIf') throw new Error('PNG 含无法确认的 EXIF 分辨率声明，请使用原图档');
    if (type === 'pHYs') {
      if (marker) throw new Error('PNG 分辨率声明重复，请使用原图档');
      marker = buffer.subarray(offset, offset + length + 12);
    }
    offset += length + 12;
  }
  return { kind: 'native', format, marker, key: `png:${marker?.toString('hex') || 'none'}` };
}

export function preserveNativeDensity(buffer, policy) {
  if (policy.kind !== 'native') return buffer;
  if (policy.format === 'jpeg') {
    const { segments, tail } = jpegHeaders(buffer);
    return Buffer.concat([buffer.subarray(0, 2), ...(policy.marker ? [policy.marker] : []),
      ...segments.filter(item => ![0xe0, 0xe1].includes(item.marker)).map(item => item.bytes), tail]);
  }
  const chunks = [buffer.subarray(0, 8)];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!['pHYs', 'eXIf'].includes(type)) chunks.push(buffer.subarray(offset, offset + length + 12));
    if (type === 'IHDR' && policy.marker) chunks.push(policy.marker);
    offset += length + 12;
  }
  return Buffer.concat(chunks);
}
