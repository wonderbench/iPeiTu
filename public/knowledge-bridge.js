import { fontFields, isSnippetFormat, paragraphFields } from './knowledge-format.js';

// 纯文字片段使用目标文档样式；富文本片段额外写入保存的直接格式。
const NO_PROTECTION = -1;
const MAIN_STORY = 1;
const WITHIN_TABLE = 12;
const STYLE_NORMAL = -1;
const BODY_OUTLINE_LEVEL = 10;
const MAX_HEADING = 9;
export const MAX_RELATIVE_LEVEL = 6;
export const BODY_LIMIT = 20000;
const HEADING_LINE = /^(#{1,6})\s+(\S.*)$/;
const UNSAFE_TEXT = new RegExp(`[\\x00-\\x08\\x0c-\\x1f\\x7f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const WPS_UNDEFINED = 9999999;
const WPS_COLOR_AUTOMATIC = -16777216;
const MAX_FONT_READS = 1200;

export const KNOWLEDGE_DEFAULTS = Object.freeze({ baseLevel: 3 });

export function normalizeKnowledgeOptions(options = {}) {
  const baseLevel = Number(options.baseLevel);
  return {
    baseLevel: Number.isInteger(baseLevel) && baseLevel >= 1 && baseLevel <= MAX_RELATIVE_LEVEL ? baseLevel : KNOWLEDGE_DEFAULTS.baseLevel,
  };
}

// 行首 1—6 个 # 加空格为小标题（相对层级），其余非空行为正文段落。
export function parseSnippetBody(body, { preserveBlankLines = false } = {}) {
  const items = [];
  const source = String(body ?? '').trim();
  if (!source) return items;
  for (const raw of source.split('\n')) {
    const text = raw.trim();
    if (!text && !preserveBlankLines) continue;
    const heading = HEADING_LINE.exec(text);
    items.push(heading ? { level: heading[1].length, text: heading[2].trim() } : { level: 0, text });
  }
  return items;
}

// 计算写入文档的段落：heading 为“标题 N”的 N，正文为 null。
export function formattedSnippetLine(text, format) {
  const heading = format.heading && HEADING_LINE.exec(text);
  if (!heading) return { text, level: 0, format };
  const start = text.length - heading[2].length;
  return {
    text: heading[2], level: heading[1].length,
    format: {
      paragraph: format.paragraph,
      runs: format.runs.filter(run => run.end > start).map(run => ({
        ...run, start: Math.max(0, run.start - start), end: run.end - start,
      })),
    },
  };
}

export function snippetParagraphs(snippet, options) {
  const { baseLevel } = normalizeKnowledgeOptions(options);
  const body = snippet?.body ?? '';
  const format = snippet?.format;
  const lines = isSnippetFormat(format, body)
    ? body.split('\n').map((text, index) => formattedSnippetLine(text, format[index]))
    : parseSnippetBody(body, { preserveBlankLines: true });
  return lines.map(({ text, level, format: sourceFormat }) => ({
    text, heading: level ? Math.min(MAX_HEADING, baseLevel + level - 1) : null,
    ...(sourceFormat ? { format: sourceFormat } : {}),
  }));
}

function openDocument(app, { editable }) {
  if (!app) throw new Error('请在 WPS 文字中打开知识库');
  if (app.Documents.Count === 0) throw new Error('请先打开需要插入内容的 WPS 文字文档');
  const doc = app.ActiveDocument;
  if (!doc) throw new Error('请先切换到需要插入内容的 WPS 文字文档');
  if (editable && doc.ReadOnly) throw new Error('当前文档为只读，请打开可编辑的副本后插入');
  if (editable && doc.ProtectionType !== NO_PROTECTION) throw new Error('当前文档受保护，请在允许编辑的文档中插入');
  const selection = app.Selection.Range;
  if (selection.StoryType !== MAIN_STORY) throw new Error('目前仅支持正文；页眉、页脚及文本框暂不支持');
  return { doc, selection };
}

export function getKnowledgeHostStatus() {
  if (typeof globalThis.Application === 'undefined') return { available: false, message: '浏览器模式 · 插入需从 WPS 打开' };
  try {
    const { doc } = openDocument(globalThis.Application, { editable: true });
    return { available: true, message: `插入到：${doc.Name}` };
  } catch (error) {
    return { available: false, message: `无法插入：${error.message || '无法读取 WPS 文档状态，请重新打开知识库'}` };
  }
}

function paragraphContent(text) {
  const ending = text.endsWith('\r\u0007') ? 2 : text.endsWith('\r') || text.endsWith('\u0007') ? 1 : 0;
  return text.slice(0, text.length - ending);
}

function cleanText(text) {
  return paragraphContent(text).replace(/[\t\n\v]/g, ' ').replace(UNSAFE_TEXT, '').trim();
}

function readWpsProperty(read) {
  try { return read(); } catch { return undefined; }
}

function readSourceParagraph(range) {
  const source = readWpsProperty(() => range.ParagraphFormat);
  const result = {};
  for (const [name, valid] of Object.entries(paragraphFields)) {
    const value = readWpsProperty(() => source?.[name]);
    if (valid(value)) result[name] = value;
  }
  if (result.FirstLineIndent !== undefined && result.CharacterUnitFirstLineIndent !== undefined) {
    if (result.FirstLineIndent || result.CharacterUnitFirstLineIndent === 0) delete result.CharacterUnitFirstLineIndent;
    else delete result.FirstLineIndent;
  }
  if (result.LineSpacingRule >= 3) {
    if (result.LineSpacing === undefined) delete result.LineSpacingRule;
  } else delete result.LineSpacing;
  return result;
}

function readSourceFont(doc, start, end) {
  const source = readWpsProperty(() => doc.Range(start, end).Font);
  const font = {};
  let mixed = false;
  for (const [name, valid] of Object.entries(fontFields)) {
    let value = readWpsProperty(() => source?.[name]);
    if (name === 'Color' && (value === undefined || value === WPS_COLOR_AUTOMATIC)) {
      value = readWpsProperty(() => source?.TextColor?.RGB);
    }
    if (value === WPS_UNDEFINED || value === '' || ((name === 'Bold' || name === 'Italic') && value === -2)) {
      mixed = true;
      continue;
    }
    if (name === 'Bold' || name === 'Italic') {
      if (value === -1 || value === 1) value = true;
      if (value === 0) value = false;
    }
    if (valid(value)) font[name] = value;
  }
  return { font, mixed };
}

function readSourceRuns(doc, { start, end, raw, text }, budget) {
  if (!text) return [];
  const content = paragraphContent(raw).replace(/[\t\n\v]/g, ' ');
  // 范围的坐标与读取的字符串一致时，才能把混合格式定位到具体字符。
  const positions = raw.length === end - start ? [] : null;
  if (positions) {
    const removed = new Set();
    const clean = content.replace(UNSAFE_TEXT, (_, index) => { removed.add(index); return ''; });
    for (let index = 0; index < content.length; index++) if (!removed.has(index)) positions.push(start + index);
    positions.splice(0, clean.length - clean.trimStart().length);
  }
  const runs = [];
  function read(from, to) {
    if (budget.remaining-- <= 0) { budget.incomplete = true; return; }
    const { font, mixed } = readSourceFont(doc, positions?.[from] ?? start, positions ? positions[to - 1] + 1 : end);
    if (mixed && to - from > 1 && positions) {
      let middle = Math.floor((from + to) / 2);
      // 避免拆开代理对。
      if (/[\uDC00-\uDFFF]/.test(text[middle])) middle++;
      if (middle < to) {
        read(from, middle);
        read(middle, to);
        return;
      }
    }
    if (mixed && !positions) budget.incomplete = true;
    if (!Object.keys(font).length) return;
    const last = runs.at(-1);
    if (last?.end === from && JSON.stringify(last.font) === JSON.stringify(font)) last.end = to;
    else runs.push({ start: from, end: to, font });
  }
  read(0, text.length);
  return runs;
}

function applySourceFormat(doc, range, { paragraph, runs }) {
  const target = range.ParagraphFormat;
  // WPS 先设置行距规则，再接受对应磅值。
  const { LineSpacing, ...paragraphProperties } = paragraph;
  for (const [name, value] of Object.entries(paragraphProperties)) target[name] = value;
  if (LineSpacing !== undefined) target.LineSpacing = LineSpacing;
  const start = range.Start;
  for (const run of runs) {
    const targetFont = doc.Range(start + run.start, start + run.end).Font;
    // 设置通用字体可能同时改动东亚字体，后者最后应用。
    const { NameFarEast, Color, ...properties } = run.font;
    for (const [name, value] of Object.entries(properties)) {
      targetFont[name] = typeof value === 'boolean' ? (value ? -1 : 0) : value;
    }
    if (NameFarEast !== undefined) targetFont.NameFarEast = NameFarEast;
    if (Color !== undefined) {
      const textColor = readWpsProperty(() => targetFont.TextColor);
      if (textColor) textColor.RGB = Color;
      else targetFont.Color = Color;
    }
  }
}

export function insertSnippet(snippet, options) {
  const lines = snippetParagraphs(snippet, options);
  if (!lines.length) throw new Error('片段没有可插入的文字');
  const app = globalThis.Application;
  let undoRecord;
  let written = false;
  let failure;
  let result;
  try {
    const { doc, selection } = openDocument(app, { editable: true });
    if (selection.Start !== selection.End) throw new Error('请把光标放在插入位置，不要选中文字');
    const inTable = Boolean(selection.Information(WITHIN_TABLE));
    const paragraph = selection.Paragraphs.Item(1).Range;
    const content = paragraphContent(paragraph.Text);
    const cursor = selection.Start;
    const contentEnd = paragraph.Start + content.length;
    if (cursor < paragraph.Start || cursor > contentEnd) throw new Error('请将光标放在正文或单元格内容内，不要选中结束标记');
    const styles = new Map();
    if (!inTable) {
      for (const { heading } of lines) {
        if (styles.has(heading)) continue;
        const id = heading ? -(heading + 1) : STYLE_NORMAL; // wdStyleHeading1 = -2
        // WPS 可能静默忽略赋给 Paragraph.Style 的数字编号，按编号读取本地样式名后再应用。
        const name = doc.Styles.Item(id)?.NameLocal;
        if (typeof name !== 'string' || !name) throw new Error(`无法读取文档的${heading ? `标题 ${heading}` : '正文'}样式`);
        styles.set(heading, name);
      }
    }
    // 空段直接写入；段首在前面插入；段尾在后面插入；段中先分段，原段落两侧文字保持不变。
    const prefix = content && cursor > paragraph.Start ? '\r' : '';
    const suffix = content && cursor < contentEnd ? '\r' : '';
    const joined = lines.map(item => item.text).join('\r');

    app.UndoRecord.StartCustomRecord('iPeiTu 插入知识库片段');
    undoRecord = app.UndoRecord;
    const target = selection.Duplicate;
    target.InsertAfter(`${prefix}${joined}${suffix}`);
    written = true;
    const start = cursor + prefix.length;
    const end = start + joined.length;
    const inserted = doc.Range(start, end).Paragraphs;
    if (inserted.Count !== lines.length) throw new Error(`应写入 ${lines.length} 段，文档中核对到 ${inserted.Count} 段`);
    let headings = 0;
    for (let index = 1; index <= lines.length; index++) {
      const item = lines[index - 1];
      const added = inserted.Item(index);
      if (paragraphContent(added.Range.Text) !== item.text) throw new Error(`第 ${index} 段文字与片段不一致`);
      // 表格内沿用单元格的格式，不套用标题样式。
      if (inTable) continue;
      const style = styles.get(item.heading);
      // WPS 的段落重置可能恢复正文样式，先清理继承的格式，再应用目标样式。
      added.Range.ParagraphFormat.Reset();
      added.Range.Font.Reset();
      added.Style = style;
      if (!item.heading) {
        added.Range.ListFormat.RemoveNumbers();
        if (!item.format) added.Range.ParagraphFormat.CharacterUnitFirstLineIndent = 2;
      }
      if (added.Style?.NameLocal !== style || added.OutlineLevel !== (item.heading ?? BODY_OUTLINE_LEVEL)) {
        throw new Error(`第 ${index} 段未能应用「${style}」样式`);
      }
      if (item.format) applySourceFormat(doc, added.Range, item.format);
      if (item.heading) headings++;
    }
    doc.Range(end, end).Select();
    result = { paragraphs: lines.length, headings, inTable };
  } catch (cause) {
    failure = cause;
  }
  if (undoRecord) {
    try {
      undoRecord.EndCustomRecord();
    } catch (cause) {
      failure = new Error(`${failure ? `${failure.message}；` : ''}无法完成本次撤销记录：${cause.message}`);
    }
  }
  if (failure) {
    const detail = failure.message ? `（${failure.message}）` : '';
    const error = new Error(written
      ? `片段已写入，但样式设置或核对未完成${detail}。请检查正文，需要时撤销一次恢复`
      : `插入已中止${detail}`);
    error.inserted = written;
    error.cause = failure;
    throw error;
  }
  return result;
}

// 逐段读取实际选区。完整选中的标题按大纲级别保留相对层级。
export function readSelectionAsSnippet() {
  const { doc, selection } = openDocument(globalThis.Application, { editable: false });
  const { Start: selectionStart, End: selectionEnd } = selection;
  if (selectionStart === selectionEnd) throw new Error('请先在文档中选中要收录的文字');
  const items = [];
  const paragraphs = selection.Paragraphs;
  const count = paragraphs.Count;
  for (let index = 1; index <= count; index++) {
    const paragraph = paragraphs.Item(index);
    const range = paragraph.Range;
    const start = Math.max(range.Start, selectionStart);
    const end = Math.min(range.End, selectionEnd);
    if (start >= end) continue;
    const whole = start === range.Start && end === range.End;
    const raw = whole ? range.Text : doc.Range(start, end).Text;
    const text = cleanText(raw);
    const level = paragraph.OutlineLevel;
    const heading = text && Number.isInteger(level) && level >= 1 && level < BODY_OUTLINE_LEVEL
      && start === range.Start && (whole || text === cleanText(range.Text));
    items.push({ level: heading ? level : 0, text, raw, start, end, range });
  }
  const first = items.findIndex(item => item.text);
  if (first < 0) throw new Error('所选内容没有可收录的文字');
  const selected = items.slice(first, items.findLastIndex(item => item.text) + 1);
  const levels = selected.filter(item => item.level).map(item => item.level);
  const top = levels.length ? Math.min(...levels) : 0;
  const lines = selected.map(item => (item.level ? `${'#'.repeat(Math.min(MAX_RELATIVE_LEVEL, item.level - top + 1))} ${item.text}` : item.text));
  const body = lines.join('\n');
  if (body.length > BODY_LIMIT) throw new Error(`所选内容超过 ${BODY_LIMIT} 字，请分段收录`);
  const heading = selected.find(item => item.level);
  const draft = { title: (heading ?? selected[0]).text.slice(0, 100), body, paragraphs: selected.length, headings: levels.length };
  const budget = { remaining: MAX_FONT_READS, incomplete: false };
  const format = selected.map((item, index) => {
    const prefix = lines[index].length - item.text.length;
    return {
      paragraph: readSourceParagraph(item.range),
      runs: readSourceRuns(doc, item, budget).map(run => ({ ...run, start: run.start + prefix, end: run.end + prefix })),
      ...(item.level ? { heading: true } : {}),
    };
  });
  if (isSnippetFormat(format, body)) draft.format = format;
  else if (format.some(item => item.runs.length || Object.keys(item.paragraph).length)) budget.incomplete = true;
  if (budget.incomplete) draft.formatNotice = '部分格式超出可收录范围。可以缩小选区后重新收录。';
  else if (draft.format && !format.some(item => item.runs.length)) {
    draft.formatNotice = '已记录段落格式。WPS 未返回可保存的字体属性。';
  }
  return draft;
}
