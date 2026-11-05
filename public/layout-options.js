export function normalizeQualityProfile(profile = 'original') {
  if (!['original', 'clear', 'balanced'].includes(profile)) throw new Error('请选择原图、清晰或均衡画质');
  return profile;
}

export function normalizeLayoutOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('配图排版设置无效');
  }
  const value = {
    widthMode: 'auto',
    widthCm: 12,
    maxHeightCm: null,
    layout: 'inline',
    caption: '',
    ...options,
  };
  if (!['auto', 'fixed'].includes(value.widthMode)) throw new Error('请选择自动宽度或固定宽度');
  if (!['inline', 'centered'].includes(value.layout)) throw new Error('请选择原段落或独立居中排版');
  if (!Number.isFinite(value.widthCm) || value.widthCm < 0.5 || value.widthCm > 50) {
    throw new Error('图片宽度须为 0.5–50 厘米之间的数字');
  }
  if (value.maxHeightCm !== null && (!Number.isFinite(value.maxHeightCm) || value.maxHeightCm < 0.5 || value.maxHeightCm > 50)) {
    throw new Error('最大高度须为 0.5–50 厘米之间的数字，或不设置');
  }
  if (typeof value.caption !== 'string' || /[\u0000-\u001f\u007f\u2028\u2029]/.test(value.caption)) {
    throw new Error('图题须为单行文字，不能包含换行或控制字符');
  }
  value.caption = value.caption.trim();
  if (value.caption.length > 200) throw new Error('图题不能超过 200 个字符');
  return {
    widthMode: value.widthMode,
    widthCm: value.widthCm,
    maxHeightCm: value.maxHeightCm,
    layout: value.layout,
    caption: value.caption,
  };
}
