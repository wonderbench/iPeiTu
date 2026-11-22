import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWLEDGE_DEFAULTS, formattedSnippetLine, insertSnippet, normalizeKnowledgeOptions, parseSnippetBody, readSelectionAsSnippet,
  snippetParagraphs, getKnowledgeHostStatus,
} from '../public/knowledge-bridge.js';

afterEach(() => { delete globalThis.Application; });

const FULL_WIDTH_SPACE = String.fromCharCode(0x3000);
const CR = String.fromCharCode(13);
const CELL_END = String.fromCharCode(13, 7);
const WPS_UNDEFINED = 9999999;
const WPS_COLOR_AUTOMATIC = -16777216;
const PARAGRAPH_FIELDS = ['Alignment', 'FirstLineIndent', 'LeftIndent', 'RightIndent', 'SpaceBefore', 'SpaceAfter', 'LineSpacingRule', 'LineSpacing'];
const FONT_FIELDS = ['Name', 'NameFarEast', 'Size', 'Bold', 'Italic', 'Underline'];
const collection = items => ({ get Count() { return items.length; }, Item: index => items[index - 1] });

// 内置样式编号对应的本地名称：正文 -1，标题 1—9 为 -2—-10。标题 N 的大纲级别为 N，其余为正文级别 10。
const STYLE_NAMES = new Map([[-1, '正文'], ...Array.from({ length: 9 }, (_, index) => [-(index + 2), `标题 ${index + 1}`])]);
const outlineOfStyle = name => { const match = /^标题 ([1-9])$/.exec(name); return match ? Number(match[1]) : 10; };

// 模拟 WPS 正文：段落以 CR 结束；Range.Paragraphs 返回与范围相交的段落，插入的分段符复制所在段落的格式。
// Paragraph.Style 按名称赋值，读回 Style 对象（NameLocal）；赋样式后大纲级别随样式变化。
// options.fonts 按文档位置给出每个字符的字体；范围内取值不一致时按 WPS 返回“不确定”（名称为空串，其余为 9999999）。
function createHost(options = {}) {
  const state = {
    paragraphs: (options.paragraphs ?? ['']).map((text, index) => ({
      text, style: '标书正文', reset: 0, fontReset: 0, indent: options.indent?.[index] ?? 0, numbered: true,
      outline: options.outline?.[index] ?? 10, fields: { ...options.fields?.[index] },
    })),
    cursor: options.cursor ?? 0, end: options.end ?? options.cursor ?? 0, undo: [], ended: 0, selected: null, log: [], lookups: [],
    fonts: options.fonts ?? [], fontWrites: [],
  };
  const styleNames = options.styleNames ?? STYLE_NAMES;
  const outlineOf = options.outlineOf ?? outlineOfStyle;
  const startOf = paragraph => state.paragraphs.slice(0, state.paragraphs.indexOf(paragraph)).reduce((sum, item) => sum + item.text.length + 1, 0);
  const containing = position => state.paragraphs.find(paragraph => position <= startOf(paragraph) + paragraph.text.length) ?? state.paragraphs.at(-1);
  const within = (start, end) => (start === end ? [containing(start)]
    : state.paragraphs.filter(paragraph => startOf(paragraph) < end && startOf(paragraph) + paragraph.text.length + 1 > start));
  const fullText = () => state.paragraphs.map(paragraph => `${paragraph.text}${CR}`).join('');
  const paragraphFormat = paragraph => {
    const format = {
      Reset() { paragraph.reset++; paragraph.indent = 0; paragraph.fields = {}; state.log.push(`${paragraph.text}|reset`); },
      get CharacterUnitFirstLineIndent() { return paragraph.indent; },
      set CharacterUnitFirstLineIndent(value) { paragraph.indent = value; state.log.push(`${paragraph.text}|indent:${value}`); },
    };
    for (const name of PARAGRAPH_FIELDS) {
      Object.defineProperty(format, name, {
        get: () => paragraph.fields[name],
        set: value => { paragraph.fields[name] = value; state.log.push(`${paragraph.text}|${name}:${value}`); },
      });
    }
    return format;
  };
  const rangeFont = (start, end) => {
    const read = name => {
      const values = new Set(Array.from({ length: end - start }, (_, index) => state.fonts[start + index]?.[name]));
      if (values.size !== 1) return name.startsWith('Name') ? '' : WPS_UNDEFINED;
      return [...values][0];
    };
    const write = (name, value) => state.fontWrites.push([start, end, name, value]);
    const font = {
      get Color() { return WPS_COLOR_AUTOMATIC; },
      set Color(value) { write('Color', value); },
      get TextColor() { return { get RGB() { return read('Color'); }, set RGB(value) { write('TextColor.RGB', value); } }; },
    };
    for (const name of FONT_FIELDS) Object.defineProperty(font, name, { get: () => read(name), set: value => write(name, value) });
    return font;
  };
  const paragraphObject = paragraph => ({
    get Style() { return { NameLocal: paragraph.style }; },
    set Style(value) {
      assert.equal(typeof value, 'string', '按样式名称设置');
      state.log.push(`${paragraph.text}|style:${value}`);
      // ignoreStyle 模拟 WPS 静默忽略样式赋值。
      if (options.ignoreStyle) return;
      paragraph.style = value;
      paragraph.outline = outlineOf(value);
    },
    get OutlineLevel() { return paragraph.outline; },
    Range: {
      get Start() { return startOf(paragraph); },
      get End() { return startOf(paragraph) + paragraph.text.length + 1; },
      // 单元格末段的文字带两个结束字符，但坐标只占一个位置，与 WPS 一致。
      get Text() { return `${paragraph.text}${paragraph.cellEnd ? CELL_END : CR}`; },
      ParagraphFormat: paragraphFormat(paragraph),
      Font: { Reset() { paragraph.fontReset++; state.log.push(`${paragraph.text}|fontReset`); } },
      ListFormat: { RemoveNumbers() { paragraph.numbered = false; state.log.push(`${paragraph.text}|removeNumbers`); } },
    },
  });
  const insertAt = (position, text) => {
    const paragraph = containing(position);
    const offset = position - startOf(paragraph);
    const parts = `${paragraph.text.slice(0, offset)}${options.mangle ? text.slice(0, -1) : text}${paragraph.text.slice(offset)}`.split(CR);
    state.paragraphs.splice(state.paragraphs.indexOf(paragraph), 1, ...parts.map(part => ({ ...paragraph, text: part, fields: { ...paragraph.fields } })));
  };
  const doc = {
    Name: '标书.docx', FullName: 'C:\\测试\\标书.docx', ReadOnly: false, ProtectionType: -1,
    Styles: {
      Item(id) {
        if (options.noStyles) assert.fail('表格内不应读取样式');
        state.lookups.push(id);
        return styleNames.has(id) ? { NameLocal: styleNames.get(id) } : undefined;
      },
    },
    ...options.document,
    Range(start, end) {
      return {
        Start: start, End: end,
        get Paragraphs() { return collection(within(start, end).map(paragraphObject)); },
        get Text() { return fullText().slice(start, end); },
        get Font() { return rangeFont(start, end); },
        Select() { state.selected = [start, end]; },
      };
    },
  };
  globalThis.Application = {
    Documents: { Count: options.documents ?? 1 },
    ActiveDocument: doc,
    Selection: {
      get Range() {
        return {
          Start: state.cursor, End: state.end, StoryType: options.story ?? 1,
          Information(type) { assert.equal(type, 12); return Boolean(options.inTable); },
          get Paragraphs() { return collection(within(state.cursor, state.end).map(paragraphObject)); },
          Duplicate: { InsertAfter(text) { insertAt(state.cursor, text); } },
        };
      },
    },
    UndoRecord: { StartCustomRecord(name) { state.undo.push(name); }, EndCustomRecord() { state.ended++; } },
  };
  return state;
}

const snippet = { title: '混凝土浇筑', body: '# 施工准备\n检查模板。' };
const texts = state => state.paragraphs.map(paragraph => paragraph.text);
const styles = state => state.paragraphs.map(paragraph => paragraph.style);
const fullLength = paragraphs => paragraphs.reduce((sum, text) => sum + text.length + 1, 0);
// 按段落逐字给出字体，段落标记位置不设字体。
const fontsOf = lines => lines.flatMap(fonts => [...fonts, undefined]);
const draftText = ({ title, body, paragraphs, headings }) => ({ title, body, paragraphs, headings });

const HEI = { Name: '黑体', NameFarEast: '黑体', Size: 16, Bold: -1 };
const SONG = { Name: '宋体', NameFarEast: '宋体', Size: 12 };

test('parses relative heading levels and maps them onto document heading styles', () => {
  assert.deepEqual(parseSnippetBody(`# 标题\n  正文  \n\n## 子标题\n#${FULL_WIDTH_SPACE}全角空格\n#没有空格\n####### 七级\n###### 六级`), [
    { level: 1, text: '标题' }, { level: 0, text: '正文' }, { level: 2, text: '子标题' }, { level: 1, text: '全角空格' },
    { level: 0, text: '#没有空格' }, { level: 0, text: '####### 七级' }, { level: 6, text: '六级' },
  ]);
  const body = '# 一\n正文\n## 二';
  assert.deepEqual(snippetParagraphs({ title: '片段', body }, { baseLevel: 3 }), [
    { text: '一', heading: 3 }, { text: '正文', heading: null }, { text: '二', heading: 4 },
  ]);
  assert.deepEqual(snippetParagraphs({ title: '片段', body }, { baseLevel: 2 }), [
    { text: '一', heading: 2 }, { text: '正文', heading: null }, { text: '二', heading: 3 },
  ]);
  assert.equal(snippetParagraphs({ body: '###### 深' }, { baseLevel: 6 })[0].heading, 9, '不超过标题 9');
});

test('no longer inserts the snippet title; the option is ignored', () => {
  assert.deepEqual(KNOWLEDGE_DEFAULTS, { baseLevel: 3 });
  assert.deepEqual(normalizeKnowledgeOptions({ baseLevel: 7, includeTitle: true }), { baseLevel: 3 });
  assert.deepEqual(normalizeKnowledgeOptions({ baseLevel: '2', includeTitle: true }), { baseLevel: 2 });
  assert.deepEqual(snippetParagraphs({ title: '片段标题', body: '正文' }, { includeTitle: true }), [{ text: '正文', heading: null }]);
});

test('keeps blank lines between paragraphs but drops leading and trailing ones', () => {
  assert.deepEqual(parseSnippetBody('\n甲\n\n  \n乙\n', { preserveBlankLines: true }), [
    { level: 0, text: '甲' }, { level: 0, text: '' }, { level: 0, text: '' }, { level: 0, text: '乙' },
  ]);
  assert.deepEqual(parseSnippetBody('甲\n\n乙'), [{ level: 0, text: '甲' }, { level: 0, text: '乙' }], '默认仍跳过空行');
  assert.deepEqual(snippetParagraphs({ body: '\n甲\n\n乙\n' }), [
    { text: '甲', heading: null }, { text: '', heading: null }, { text: '乙', heading: null },
  ]);
  const state = createHost();
  assert.deepEqual(insertSnippet({ body: '甲\n\n乙' }), { paragraphs: 3, headings: 0, inTable: false });
  assert.deepEqual(texts(state), ['甲', '', '乙']);
  assert.deepEqual(styles(state), ['正文', '正文', '正文']);
});

test('maps formatted lines onto insertion paragraphs and falls back to plain text for invalid format', () => {
  const format = [
    { paragraph: { Alignment: 1 }, runs: [{ start: 0, end: 6, font: { Bold: true } }], heading: true },
    { paragraph: { Alignment: 3 }, runs: [{ start: 0, end: 2, font: { Size: 12 } }] },
  ];
  assert.deepEqual(snippetParagraphs({ body: '# 一、概述\n甲乙丙丁', format }, { baseLevel: 3 }), [
    { text: '一、概述', heading: 3, format: { paragraph: { Alignment: 1 }, runs: [{ start: 0, end: 4, font: { Bold: true } }] } },
    { text: '甲乙丙丁', heading: null, format: format[1] },
  ], '标题行去掉 # 前缀后，字符区间随之平移');
  assert.deepEqual(formattedSnippetLine('## 二级', {
    paragraph: {}, runs: [{ start: 0, end: 1, font: { Bold: true } }, { start: 1, end: 5, font: { Size: 14 } }], heading: true,
  }), { text: '二级', level: 2, format: { paragraph: {}, runs: [{ start: 0, end: 2, font: { Size: 14 } }] } }, '只落在前缀上的区间丢弃');
  assert.deepEqual(snippetParagraphs({ body: '# 注意', format: [{ paragraph: { Alignment: 0 }, runs: [] }] }), [
    { text: '# 注意', heading: null, format: { paragraph: { Alignment: 0 }, runs: [] } },
  ], '未标记为标题的格式行按原文作正文');
  assert.deepEqual(snippetParagraphs({ body: '# 标题\n正文', format: [{ paragraph: { Alignment: 0 }, runs: [] }] }), [
    { text: '标题', heading: 3 }, { text: '正文', heading: null },
  ], '格式与正文行数不符时按纯文字插入');
});

test('inserts into an empty paragraph with heading and body styles in one undo record', () => {
  const state = createHost({ paragraphs: ['前文', '', '后文'], cursor: 3 });
  const result = insertSnippet(snippet, { baseLevel: 3 });
  assert.deepEqual(result, { paragraphs: 2, headings: 1, inTable: false });
  assert.deepEqual(texts(state), ['前文', '施工准备', '检查模板。', '后文']);
  assert.deepEqual(styles(state), ['标书正文', '标题 3', '正文', '标书正文'], '按内置编号 -4、-1 查到的本地名称设置');
  assert.deepEqual(state.paragraphs.map(paragraph => paragraph.outline), [10, 3, 10, 10]);
  assert.deepEqual(state.lookups, [-4, -1]);
  const [, heading, body] = state.paragraphs;
  assert.deepEqual([heading.reset, heading.fontReset, heading.indent, heading.numbered], [1, 1, 0, true], '标题保留样式自带的编号');
  assert.deepEqual([body.reset, body.fontReset, body.indent, body.numbered], [1, 1, 2, false], '正文首行缩进 2 字符并去掉编号');
  assert.deepEqual(state.undo, ['iPeiTu 插入知识库片段']);
  assert.equal(state.ended, 1);
  const end = 3 + `施工准备${CR}检查模板。`.length;
  assert.deepEqual(state.selected, [end, end], '光标停在插入内容末尾');
  assert.deepEqual(state.fontWrites, [], '纯文字片段不写直接格式');
});

test('inserts after, before and inside a paragraph without changing its text or style', () => {
  let state = createHost({ paragraphs: ['前文', '后文'], cursor: 2 });
  insertSnippet(snippet);
  assert.deepEqual(texts(state), ['前文', '施工准备', '检查模板。', '后文']);
  assert.deepEqual(styles(state), ['标书正文', '标题 3', '正文', '标书正文']);

  state = createHost({ paragraphs: ['正文'], cursor: 0 });
  insertSnippet(snippet);
  assert.deepEqual(texts(state), ['施工准备', '检查模板。', '正文']);
  assert.equal(state.paragraphs[2].style, '标书正文');

  state = createHost({ paragraphs: ['甲乙'], cursor: 1 });
  insertSnippet({ title: '纯正文', body: '第一段\n第二段' });
  assert.deepEqual(texts(state), ['甲', '第一段', '第二段', '乙']);
  assert.deepEqual(styles(state), ['标书正文', '正文', '正文', '标书正文']);
  assert.deepEqual(state.paragraphs.map(paragraph => paragraph.reset), [0, 1, 1, 0]);
});

test('keeps table cell formatting and reports it', () => {
  // noStyles：读取样式即失败，证明表格内不查样式、不设样式也不核对。
  const state = createHost({ paragraphs: ['', '后文'], cursor: 0, inTable: true, noStyles: true });
  assert.deepEqual(insertSnippet(snippet), { paragraphs: 2, headings: 0, inTable: true });
  assert.deepEqual(texts(state), ['施工准备', '检查模板。', '后文']);
  assert.ok(state.paragraphs.every(paragraph => paragraph.style === '标书正文' && paragraph.reset === 0));
  assert.deepEqual(state.log, []);
});

test('resets inherited formatting before applying styles by local name', () => {
  const styleNames = new Map([[-1, 'Normal'], [-4, 'Heading 3']]);
  const state = createHost({ styleNames, outlineOf: name => (name === 'Heading 3' ? 3 : 10) });
  const result = insertSnippet({ title: '片段', body: '# 施工准备\n检查模板。\n清理杂物。' }, { baseLevel: 3 });
  assert.deepEqual(result, { paragraphs: 3, headings: 1, inTable: false });
  assert.deepEqual(styles(state), ['Heading 3', 'Normal', 'Normal'], '使用文档返回的本地名称');
  assert.deepEqual(state.lookups, [-4, -1], '每种样式只查一次');
  const steps = text => state.log.filter(entry => entry.startsWith(`${text}|`)).map(entry => entry.slice(text.length + 1));
  assert.deepEqual(steps('施工准备'), ['reset', 'fontReset', 'style:Heading 3'], '标题先重置再设样式，不去编号');
  assert.deepEqual(steps('检查模板。'), ['reset', 'fontReset', 'style:Normal', 'removeNumbers', 'indent:2']);
  assert.deepEqual(steps('清理杂物。'), ['reset', 'fontReset', 'style:Normal', 'removeNumbers', 'indent:2']);
});

test('applies saved paragraph and font formatting after the style is verified', () => {
  const state = createHost();
  const formatted = {
    body: '# 一、概述\n甲乙丙丁',
    format: [
      { paragraph: { Alignment: 1 }, runs: [{ start: 2, end: 6, font: { Name: '黑体', NameFarEast: '黑体', Size: 16, Bold: true } }], heading: true },
      {
        paragraph: { Alignment: 3, LineSpacingRule: 5, CharacterUnitFirstLineIndent: 0, LineSpacing: 18 },
        runs: [{ start: 0, end: 2, font: { Bold: true, Color: 255 } }],
      },
    ],
  };
  assert.deepEqual(insertSnippet(formatted, { baseLevel: 3 }), { paragraphs: 2, headings: 1, inTable: false });
  assert.deepEqual(texts(state), ['一、概述', '甲乙丙丁']);
  assert.deepEqual(styles(state), ['标题 3', '正文']);
  const steps = text => state.log.filter(entry => entry.startsWith(`${text}|`)).map(entry => entry.slice(text.length + 1));
  assert.deepEqual(steps('一、概述'), ['reset', 'fontReset', 'style:标题 3', 'Alignment:1']);
  assert.deepEqual(steps('甲乙丙丁'), [
    'reset', 'fontReset', 'style:正文', 'removeNumbers', 'Alignment:3', 'LineSpacingRule:5', 'indent:0', 'LineSpacing:18',
  ], '带段落格式的正文不再默认缩进 2 字符，行距磅值在规则之后写入');
  assert.deepEqual(state.fontWrites, [
    [0, 4, 'Name', '黑体'], [0, 4, 'Size', 16], [0, 4, 'Bold', -1], [0, 4, 'NameFarEast', '黑体'],
    [5, 7, 'Bold', -1], [5, 7, 'TextColor.RGB', 255],
  ], '区间按段首坐标换算，东亚字体最后写入，颜色写入 TextColor');

  // 表格内沿用单元格格式，不写入保存的格式。
  const cell = createHost({ inTable: true, noStyles: true });
  insertSnippet(formatted);
  assert.deepEqual([cell.log, cell.fontWrites], [[], []]);
});

test('maps levels beyond heading 9 onto heading 9 and verifies it', () => {
  const state = createHost();
  assert.deepEqual(insertSnippet({ title: '深层', body: '# 五\n###### 深' }, { baseLevel: 6 }), { paragraphs: 2, headings: 2, inTable: false });
  assert.deepEqual(styles(state), ['标题 6', '标题 9']);
  assert.deepEqual(state.paragraphs.map(paragraph => paragraph.outline), [6, 9]);
  assert.deepEqual(state.lookups, [-7, -10]);
});

test('reports a style that does not read back after writing', () => {
  const undoOnce = /^片段已写入，但样式设置或核对未完成.*撤销一次恢复$/;
  let state = createHost({ ignoreStyle: true });
  assert.throws(() => insertSnippet(snippet), error => undoOnce.test(error.message) && error.message.includes('第 1 段未能应用「标题 3」样式')
    && error.inserted === true && error.cause instanceof Error);
  assert.deepEqual(texts(state), ['施工准备', '检查模板。']);
  assert.equal(state.ended, 1, '撤销记录仍然关闭');

  // 样式名相符但大纲级别不符：标题与正文分别核对。
  state = createHost({ outlineOf: name => (name === '标题 3' ? 10 : outlineOfStyle(name)) });
  assert.throws(() => insertSnippet(snippet), error => undoOnce.test(error.message) && error.message.includes('第 1 段未能应用「标题 3」样式') && error.inserted === true);
  state = createHost({ outlineOf: name => (name === '正文' ? 1 : outlineOfStyle(name)) });
  assert.throws(() => insertSnippet(snippet), error => undoOnce.test(error.message) && error.message.includes('第 2 段未能应用「正文」样式') && error.inserted === true);
  assert.equal(state.ended, 1);
});

test('aborts before writing when a built-in style cannot be read', () => {
  const cases = [
    [new Map([[-1, '正文']]), '插入已中止（无法读取文档的标题 3样式）'],
    [new Map([[-1, ''], [-4, '标题 3']]), '插入已中止（无法读取文档的正文样式）'],
  ];
  for (const [styleNames, message] of cases) {
    const state = createHost({ paragraphs: ['前文'], cursor: 2, styleNames });
    assert.throws(() => insertSnippet(snippet), error => error.message === message && error.inserted === false);
    assert.deepEqual(texts(state), ['前文']);
    assert.deepEqual(state.undo, []);
  }
});

test('rejects selections and unwritable documents before writing', () => {
  const cases = [
    [{ paragraphs: ['正文'], cursor: 0, end: 2 }, /不要选中文字/],
    [{ document: { ReadOnly: true } }, /只读/],
    [{ document: { ProtectionType: 1 } }, /受保护/],
    [{ story: 7 }, /仅支持正文/],
    [{ documents: 0 }, /先打开/],
  ];
  for (const [options, message] of cases) {
    const state = createHost(options);
    const before = texts(state);
    assert.throws(() => insertSnippet(snippet), error => message.test(error.message) && error.inserted === false);
    assert.deepEqual(texts(state), before);
    assert.deepEqual(state.undo, []);
  }
  createHost();
  assert.throws(() => insertSnippet({ title: '空', body: '  \n' }), /没有可插入的文字/);
  delete globalThis.Application;
  assert.throws(() => insertSnippet(snippet), /在 WPS 文字中打开知识库/);
  assert.deepEqual(getKnowledgeHostStatus(), { available: false, message: '浏览器模式 · 插入需从 WPS 打开' });
  createHost({ document: { ReadOnly: true } });
  assert.match(getKnowledgeHostStatus().message, /^无法插入：.*只读/);
  createHost();
  assert.deepEqual(getKnowledgeHostStatus(), { available: true, message: '插入到：标书.docx' });
});

test('reports a written but unverified insertion so the user can undo once', () => {
  const state = createHost({ paragraphs: [''], mangle: true });
  assert.throws(() => insertSnippet(snippet), error => /片段已写入.*撤销一次恢复/.test(error.message) && error.inserted === true);
  assert.equal(state.ended, 1, '撤销记录仍然关闭');
});

test('captures selected paragraphs with outline levels and keeps blank lines between them', () => {
  const paragraphs = ['二、施工方法', '（一）准备', '检查模板\t和支撑', '', '（二）浇筑', '分层浇筑'];
  const outline = [2, 3, 10, 10, 3, 10];
  createHost({ paragraphs, outline, cursor: 0, end: fullLength(paragraphs), document: { ReadOnly: true } });
  assert.deepEqual(draftText(readSelectionAsSnippet()), {
    title: '二、施工方法', body: '# 二、施工方法\n## （一）准备\n检查模板 和支撑\n\n## （二）浇筑\n分层浇筑', paragraphs: 6, headings: 3,
  });

  createHost({ paragraphs: ['', '甲', '', '乙', ''], cursor: 0, end: fullLength(['', '甲', '', '乙', '']) });
  assert.deepEqual(draftText(readSelectionAsSnippet()), { title: '甲', body: '甲\n\n乙', paragraphs: 3, headings: 0 }, '首尾空段不收录');

  createHost({ paragraphs: ['只有正文', '第二段'], cursor: 0, end: fullLength(['只有正文', '第二段']) });
  assert.deepEqual(draftText(readSelectionAsSnippet()), { title: '只有正文', body: '只有正文\n第二段', paragraphs: 2, headings: 0 });

  createHost({ paragraphs: ['正文'], cursor: 1 });
  assert.throws(() => readSelectionAsSnippet(), /先在文档中选中/);
  createHost({ paragraphs: ['', ''], cursor: 0, end: 2 });
  assert.throws(() => readSelectionAsSnippet(), /没有可收录的文字/);
  createHost({ paragraphs: ['长'.repeat(20001)], cursor: 0, end: 20001 });
  assert.throws(() => readSelectionAsSnippet(), /超过 20000 字/);
});

test('captures only the selected text; a partly selected heading becomes body text', () => {
  const paragraphs = ['二、施工方法', '（一）准备', '检查模板\t和支撑'];
  const outline = [2, 3, 10];
  const second = paragraphs[0].length + 1;
  // 从第 2 段第 2 个字选到第 3 段前两个字。
  createHost({ paragraphs, outline, cursor: second + 1, end: second + paragraphs[1].length + 3 });
  assert.deepEqual(draftText(readSelectionAsSnippet()), { title: '一）准备', body: '一）准备\n检查', paragraphs: 2, headings: 0 });

  // 选中标题全部文字但不含段落标记，仍按标题收录。
  createHost({ paragraphs, outline, cursor: 0, end: paragraphs[0].length });
  assert.deepEqual(draftText(readSelectionAsSnippet()), { title: '二、施工方法', body: '# 二、施工方法', paragraphs: 1, headings: 1 });

  // 从标题中间选到下一段：标题按正文收录，下一级标题成为最高层级。
  createHost({ paragraphs, outline, cursor: 2, end: fullLength(paragraphs) });
  assert.deepEqual(draftText(readSelectionAsSnippet()), {
    title: '（一）准备', body: '施工方法\n# （一）准备\n检查模板 和支撑', paragraphs: 3, headings: 1,
  });
});

test('reads paragraph and font formatting of the selection into the draft', () => {
  const paragraphs = ['一、概述', '甲乙丙丁', '', '戊己'];
  const BOLD = { ...SONG, Bold: -1, Color: 255 };
  const PLAIN = { ...SONG, Bold: 0, Color: 255 };
  createHost({
    paragraphs, outline: [1, 10, 10, 10], cursor: 0, end: fullLength(paragraphs),
    indent: [0, 2, 0, 2],
    fields: [{ Alignment: 1, LineSpacingRule: 0, LineSpacing: 12 }, { Alignment: 3, LineSpacingRule: 5, LineSpacing: 18 }, { LineSpacingRule: 4 }, { FirstLineIndent: 21 }],
    fonts: fontsOf([[HEI, HEI, HEI, HEI], [BOLD, BOLD, PLAIN, PLAIN], [], [SONG, SONG]]),
  });
  const draft = readSelectionAsSnippet();
  assert.deepEqual(draftText(draft), { title: '一、概述', body: '# 一、概述\n甲乙丙丁\n\n戊己', paragraphs: 4, headings: 1 });
  const song = { Name: '宋体', NameFarEast: '宋体', Size: 12 };
  assert.deepEqual(draft.format, [
    {
      paragraph: { Alignment: 1, CharacterUnitFirstLineIndent: 0, LineSpacingRule: 0 },
      runs: [{ start: 2, end: 6, font: { Name: '黑体', NameFarEast: '黑体', Size: 16, Bold: true } }], heading: true,
    },
    {
      paragraph: { Alignment: 3, CharacterUnitFirstLineIndent: 2, LineSpacingRule: 5, LineSpacing: 18 },
      runs: [{ start: 0, end: 2, font: { ...song, Bold: true, Color: 255 } }, { start: 2, end: 4, font: { ...song, Bold: false, Color: 255 } }],
    },
    { paragraph: { CharacterUnitFirstLineIndent: 0 }, runs: [] },
    { paragraph: { FirstLineIndent: 21 }, runs: [{ start: 0, end: 2, font: song }] },
  ], '标题区间跳过 # 前缀；混合格式拆到具体字符；固定行距缺磅值时不记录规则');
  assert.equal(draft.formatNotice, undefined);

  // 收录的格式可以原样插入另一文档。
  const target = createHost();
  insertSnippet(draft, { baseLevel: 3 });
  assert.deepEqual(texts(target), paragraphs);
  assert.ok(target.fontWrites.some(([start, end, name, value]) => start === 0 && end === 4 && name === 'Size' && value === 16));
});

test('marks formatting that cannot be located or exceeds the read budget as incomplete', () => {
  // 单元格末段的文字长度与坐标不符，混合字体无法拆到字符。
  // 无法定位时整段一次读取，范围包含结束标记，所以结束标记也给出字体。
  const cellFonts = [{ ...SONG, Bold: -1 }, { ...SONG, Bold: 0 }, { ...SONG, Bold: 0 }, { ...SONG, Bold: 0 }];
  const state = createHost({ paragraphs: ['单元格'], cursor: 0, end: 4, fonts: cellFonts });
  state.paragraphs[0].cellEnd = true;
  let draft = readSelectionAsSnippet();
  assert.equal(draft.body, '单元格');
  assert.deepEqual(draft.format, [{ paragraph: { CharacterUnitFirstLineIndent: 0 }, runs: [{ start: 0, end: 3, font: { Name: '宋体', NameFarEast: '宋体', Size: 12 } }] }]);
  assert.equal(draft.formatNotice, '部分格式超出可收录范围。可以缩小选区后重新收录。');

  const alternating = Array.from({ length: 1000 }, (_, index) => ({ Name: '宋体', Bold: index % 2 ? 0 : -1 }));
  createHost({ paragraphs: ['字'.repeat(1000)], cursor: 0, end: 1001, fonts: fontsOf([alternating]) });
  draft = readSelectionAsSnippet();
  assert.equal(draft.body, '字'.repeat(1000));
  assert.equal(draft.formatNotice, '部分格式超出可收录范围。可以缩小选区后重新收录。');

  // 只有段落格式、没有字体属性时说明原因。
  createHost({ paragraphs: ['正文'], cursor: 0, end: 3 });
  draft = readSelectionAsSnippet();
  assert.deepEqual(draft.format, [{ paragraph: { CharacterUnitFirstLineIndent: 0 }, runs: [] }]);
  assert.equal(draft.formatNotice, '已记录段落格式。WPS 未返回可保存的字体属性。');
});

test('strips cell end marks and control characters from captured text', () => {
  const state = createHost({ paragraphs: ['单元格文字', '下一段'], cursor: 0 });
  state.paragraphs[0].cellEnd = true;
  state.paragraphs[1].text = `下${String.fromCharCode(1)}一段${String.fromCharCode(0x0b)}换行`;
  state.end = fullLength(texts(state));
  assert.equal(readSelectionAsSnippet().body, '单元格文字\n下一段 换行');
});
