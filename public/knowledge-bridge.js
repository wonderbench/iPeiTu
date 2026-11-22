// 知识库片段与 WPS 文档之间的读写：插入时小标题用文档的“标题 N”样式，正文用“正文”样式并首行缩进 2 字符。
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

export const KNOWLEDGE_DEFAULTS = Object.freeze({ baseLevel: 3, includeTitle: false });

export function normalizeKnowledgeOptions(options = {}) {
  const baseLevel = Number(options.baseLevel);
  return {
    baseLevel: Number.isInteger(baseLevel) && baseLevel >= 1 && baseLevel <= MAX_RELATIVE_LEVEL ? baseLevel : KNOWLEDGE_DEFAULTS.baseLevel,
    includeTitle: typeof options.includeTitle === 'boolean' ? options.includeTitle : KNOWLEDGE_DEFAULTS.includeTitle,
  };
}

// 行首 1—6 个 # 加空格为小标题（相对层级），其余非空行为正文段落。
export function parseSnippetBody(body) {
  const items = [];
  for (const raw of String(body ?? '').split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    const heading = HEADING_LINE.exec(text);
    items.push(heading ? { level: heading[1].length, text: heading[2].trim() } : { level: 0, text });
  }
  return items;
}

// 计算写入文档的段落：heading 为“标题 N”的 N，正文为 null。
export function snippetParagraphs(snippet, options) {
  const { baseLevel, includeTitle } = normalizeKnowledgeOptions(options);
  const offset = includeTitle ? 1 : 0;
  const paragraphs = parseSnippetBody(snippet?.body).map(item => ({
    text: item.text,
    heading: item.level ? Math.min(MAX_HEADING, baseLevel + offset + item.level - 1) : null,
  }));
  const title = typeof snippet?.title === 'string' ? snippet.title.trim() : '';
  if (includeTitle && title) paragraphs.unshift({ text: title, heading: baseLevel });
  return paragraphs;
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
        added.Range.ParagraphFormat.CharacterUnitFirstLineIndent = 2;
      }
      if (added.Style?.NameLocal !== style || added.OutlineLevel !== (item.heading ?? BODY_OUTLINE_LEVEL)) {
        throw new Error(`第 ${index} 段未能应用「${style}」样式`);
      }
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

// 把所选段落整段收录为片段草稿：大纲级别最小的标题记为 #，其余按差值递推。
export function readSelectionAsSnippet() {
  const { selection } = openDocument(globalThis.Application, { editable: false });
  if (selection.Start === selection.End) throw new Error('请先在文档中选中要收录的段落');
  const items = [];
  const paragraphs = selection.Paragraphs;
  const count = paragraphs.Count;
  for (let index = 1; index <= count; index++) {
    const paragraph = paragraphs.Item(index);
    const text = cleanText(paragraph.Range.Text);
    if (!text) continue;
    const level = paragraph.OutlineLevel;
    items.push({ level: Number.isInteger(level) && level >= 1 && level < BODY_OUTLINE_LEVEL ? level : 0, text });
  }
  if (!items.length) throw new Error('所选内容没有可收录的文字');
  const levels = items.filter(item => item.level).map(item => item.level);
  const top = levels.length ? Math.min(...levels) : 0;
  const lines = items.map(item => (item.level ? `${'#'.repeat(Math.min(MAX_RELATIVE_LEVEL, item.level - top + 1))} ${item.text}` : item.text));
  const body = lines.join('\n');
  if (body.length > BODY_LIMIT) throw new Error(`所选内容超过 ${BODY_LIMIT} 字，请分段收录`);
  const heading = items.find(item => item.level);
  return { title: (heading ?? items[0]).text.slice(0, 100), body, paragraphs: items.length, headings: levels.length };
}
