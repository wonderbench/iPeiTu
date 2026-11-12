const MAX_FORMAT_LENGTH = 48000;
const MAX_PARAGRAPHS = 256;
const MAX_RUNS = 512;

const numberIn = (minimum, maximum) => value => typeof value === 'number' && value >= minimum && value <= maximum;
const oneOf = (...values) => value => values.includes(value);
const fontName = value => typeof value === 'string' && /^[\p{L}\p{N} ._-]{1,64}$/u.test(value);
const boolean = value => typeof value === 'boolean';
export const paragraphFields = {
  Alignment: oneOf(0, 1, 2, 3),
  FirstLineIndent: numberIn(-360, 360),
  CharacterUnitFirstLineIndent: numberIn(-20, 20),
  LeftIndent: numberIn(-360, 360),
  RightIndent: numberIn(-360, 360),
  SpaceBefore: numberIn(0, 360),
  SpaceAfter: numberIn(0, 360),
  LineSpacingRule: oneOf(0, 1, 2, 3, 4, 5),
  LineSpacing: numberIn(1, 360),
};
export const fontFields = {
  Name: fontName,
  NameFarEast: fontName,
  Size: numberIn(1, 163),
  Bold: boolean,
  Italic: boolean,
  Underline: oneOf(0, 1),
  Color: value => Number.isInteger(value) && value >= 0 && value <= 0xffffff,
};

function matches(record, fields) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && Object.entries(record).every(([key, value]) => Object.hasOwn(fields, key) && fields[key](value));
}

export function isSnippetFormat(format, body) {
  if (typeof body !== 'string') return false;
  const lines = body.split('\n');
  if (!Array.isArray(format) || format.length !== lines.length || format.length > MAX_PARAGRAPHS) return false;
  let runCount = 0;
  const valid = format.every((item, index) => {
    if (!item || !Object.hasOwn(item, 'paragraph') || !Object.hasOwn(item, 'runs')
      || Object.keys(item).length !== (item.heading === true ? 3 : 2)) return false;
    const { paragraph, runs } = item;
    if (!matches(paragraph, paragraphFields) || !Array.isArray(runs)) return false;
    if (Object.hasOwn(paragraph, 'FirstLineIndent') && Object.hasOwn(paragraph, 'CharacterUnitFirstLineIndent')) return false;
    if ((paragraph.LineSpacingRule >= 3) !== Object.hasOwn(paragraph, 'LineSpacing')) return false;
    runCount += runs.length;
    if (runCount > MAX_RUNS) return false;
    let previousEnd = 0;
    return runs.every(run => {
      if (!run || Object.keys(run).length !== 3 || !Number.isInteger(run.start) || !Number.isInteger(run.end)
        || run.start < previousEnd || run.end <= run.start || run.end > lines[index].length || !matches(run.font, fontFields)) return false;
      previousEnd = run.end;
      return true;
    });
  });
  return valid && format.some(item => item.runs.length || Object.keys(item.paragraph).length)
    && JSON.stringify(format).length <= MAX_FORMAT_LENGTH;
}

export function trimSnippetBody(body) {
  return body.split('\n').map(line => line.trimEnd()).join('\n').replace(/^\n+|\n+$/g, '');
}

function changedRange(before, after, selection) {
  const shift = after.length - before.length;
  // 优先按实际选区映射，避免相邻字符相同时把编辑误判到另一处。
  if (selection) {
    const { start, end } = selection;
    const insertedEnd = end + shift;
    if (insertedEnd >= start && before.slice(0, start) === after.slice(0, start)
      && before.slice(end) === after.slice(insertedEnd)) return { start, end, insertedEnd };
  }
  let start = 0;
  let end = before.length;
  let insertedEnd = after.length;
  while (start < end && start < insertedEnd && before[start] === after[start]) start++;
  while (end > start && insertedEnd > start && before[end - 1] === after[insertedEnd - 1]) {
    end--;
    insertedEnd--;
  }
  return { start, end, insertedEnd };
}

export function updateSnippetFormat(draft, body, selection) {
  if (draft.body === body) return draft;
  const { start, end, insertedEnd } = changedRange(draft.body, body, selection);
  const sourceFonts = new Array(draft.body.length + 1);
  const sourceParagraphs = new Array(draft.body.length + 1);
  let offset = 0;
  draft.body.split('\n').forEach((line, index) => {
    const { runs } = draft.format[index];
    sourceParagraphs.fill(draft.format[index], offset, offset + line.length + 1);
    for (const run of runs) sourceFonts.fill(run.font, offset + run.start, offset + run.end);
    if (!line.length) sourceFonts[offset] = draft.emptyLineFonts?.[index];
    offset += line.length + 1;
  });

  // 替换选中文字沿用选区开头的样式，普通插入沿用同段的左侧字符。
  const inheritsLeft = start === end && start > 0 && draft.body[start - 1] !== '\n';
  const fontAtInsertion = sourceFonts[inheritsLeft ? start - 1 : start];
  const shift = insertedEnd - end;
  const emptyLineFonts = [];
  offset = 0;
  const format = body.split('\n').map((line, lineIndex) => {
    const source = offset < start ? offset : offset >= insertedEnd ? offset - shift : start;
    const { paragraph, heading } = sourceParagraphs[source];
    if (!line.length) {
      // 空段没有字符区间，先在草稿里记住下次输入所用的字体。
      const font = offset >= start && offset <= insertedEnd ? fontAtInsertion : sourceFonts[source];
      if (font) emptyLineFonts[lineIndex] = font;
    }
    const runs = [];
    for (let index = 0; index < line.length; index++) {
      const position = offset + index;
      const font = position < start ? sourceFonts[position]
        : position >= insertedEnd ? sourceFonts[position - shift] : fontAtInsertion;
      if (!font) continue;
      const last = runs.at(-1);
      if (last?.end === index && last.font === font) last.end++;
      else runs.push({ start: index, end: index + 1, font });
    }
    offset += line.length + 1;
    return { paragraph, runs, ...(heading ? { heading } : {}) };
  });
  return emptyLineFonts.length ? { body, format, emptyLineFonts } : { body, format };
}

export function formatForSave(draft, body) {
  if (!body) return undefined;
  const first = draft.body.split('\n').findIndex(line => line.trimEnd());
  // 存盘会去掉首尾空行和段末空白，格式区间也按实际保存的文字截断。
  const format = body.split('\n').map((line, index) => {
    const { paragraph, runs, heading } = draft.format[first + index];
    return {
      paragraph,
      runs: runs.filter(run => run.start < line.length).map(run => ({ ...run, end: Math.min(run.end, line.length) })),
      ...(heading ? { heading } : {}),
    };
  });
  if (!format.some(item => item.runs.length || Object.keys(item.paragraph).length)) return undefined;
  if (!isSnippetFormat(format, body)) throw new Error('片段格式超出支持范围，请拆成较短的片段保存');
  return format;
}
