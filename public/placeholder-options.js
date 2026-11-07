// 占位框尺寸：整行宽（4:3）、单元格大小，或固定厘米宽高。
export const BOX_PRESETS = { landscape: [12, 9], portrait: [9, 12] };
const controlCharacters = /[\u0000-\u001f\u007f\u2028\u2029]/;

export function normalizePlaceholderOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('占位框设置无效');
  if (typeof input.name !== 'string' || controlCharacters.test(input.name)) throw new Error('框名须为单行文字');
  const name = input.name.trim();
  if (!name) throw new Error('请填写框名');
  if (name.length > 100) throw new Error('框名不能超过 100 个字符');
  if (!['line', 'cell', 'fixed'].includes(input.size)) throw new Error('请选择占位框尺寸');
  const options = { name, size: input.size };
  if (input.size === 'fixed') {
    for (const key of ['widthCm', 'heightCm']) {
      const value = input[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 50) {
        throw new Error('宽和高须为 0.5–50 厘米之间的数字');
      }
      options[key] = value;
    }
  }
  return options;
}
