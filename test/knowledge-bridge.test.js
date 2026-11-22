import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  insertSnippet, normalizeKnowledgeOptions, parseSnippetBody, readSelectionAsSnippet, snippetParagraphs, getKnowledgeHostStatus,
} from '../public/knowledge-bridge.js';

afterEach(() => { delete globalThis.Application; });

const FULL_WIDTH_SPACE = String.fromCharCode(0x3000);
const collection = items => ({ get Count() { return items.length; }, Item: index => items[index - 1] });

// 内置样式编号对应的本地名称：正文 -1，标题 1—9 为 -2—-10。标题 N 的大纲级别为 N，其余为正文级别 10。
const STYLE_NAMES = new Map([[-1, '正文'], ...Array.from({ length: 9 }, (_, index) => [-(index + 2), `标题 ${index + 1}`])]);
const outlineOfStyle = name => { const match = /^标题 ([1-9])$/.exec(name); return match ? Number(match[1]) : 10; };

// 模拟 WPS 正文：段落以 \r 结束；Range.Paragraphs 返回与范围相交的段落，插入的分段符复制所在段落的格式。
// Paragraph.Style 按名称赋值，读回 Style 对象（NameLocal）；赋样式后大纲级别随样式变化。
function createHost(options = {}) {
  const state = {
    paragraphs: (options.paragraphs ?? ['']).map((text, index) => ({
      text, style: '标书正文', reset: 0, fontReset: 0, indent: 0, numbered: true, outline: options.outline?.[index] ?? 10,
    })),
    cursor: options.cursor ?? 0, end: options.end ?? options.cursor ?? 0, undo: [], ended: 0, selected: null, log: [], lookups: [],
  };
  const styleNames = options.styleNames ?? STYLE_NAMES;
  const outlineOf = options.outlineOf ?? outlineOfStyle;
  const startOf = paragraph => state.paragraphs.slice(0, state.paragraphs.indexOf(paragraph)).reduce((sum, item) => sum + item.text.length + 1, 0);
  const containing = position => state.paragraphs.find(paragraph => position <= startOf(paragraph) + paragraph.text.length) ?? state.paragraphs.at(-1);
  const within = (start, end) => (start === end ? [containing(start)]
    : state.paragraphs.filter(paragraph => startOf(paragraph) < end && startOf(paragraph) + paragraph.text.length + 1 > start));
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
      get Text() { return `${paragraph.text}${paragraph.cellEnd ? '\r\u0007' : '\r'}`; },
      ParagraphFormat: {
        Reset() { paragraph.reset++; paragraph.indent = 0; state.log.push(`${paragraph.text}|reset`); },
        get CharacterUnitFirstLineIndent() { return paragraph.indent; },
        set CharacterUnitFirstLineIndent(value) { paragraph.indent = value; state.log.push(`${paragraph.text}|indent:${value}`); },
      },
      Font: { Reset() { paragraph.fontReset++; state.log.push(`${paragraph.text}|fontReset`); } },
      ListFormat: { RemoveNumbers() { paragraph.numbered = false; state.log.push(`${paragraph.text}|removeNumbers`); } },
    },
  });
  const insertAt = (position, text) => {
    const paragraph = containing(position);
    const offset = position - startOf(paragraph);
    const parts = `${paragraph.text.slice(0, offset)}${options.mangle ? text.slice(0, -1) : text}${paragraph.text.slice(offset)}`.split('\r');
    state.paragraphs.splice(state.paragraphs.indexOf(paragraph), 1, ...parts.map(part => ({ ...paragraph, text: part })));
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
      return { get Paragraphs() { return collection(within(start, end).map(paragraphObject)); }, Select() { state.selected = [start, end]; } };
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

test('parses relative heading levels and maps them onto document heading styles', () => {
  assert.deepEqual(parseSnippetBody(`# 标题\n  正文  \n\n## 子标题\n#${FULL_WIDTH_SPACE}全角空格\n#没有空格\n####### 七级\n###### 六级`), [
    { level: 1, text: '标题' }, { level: 0, text: '正文' }, { level: 2, text: '子标题' }, { level: 1, text: '全角空格' },
    { level: 0, text: '#没有空格' }, { level: 0, text: '####### 七级' }, { level: 6, text: '六级' },
  ]);
  const body = '# 一\n正文\n## 二';
  assert.deepEqual(snippetParagraphs({ title: '片段', body }, { baseLevel: 3, includeTitle: false }), [
    { text: '一', heading: 3 }, { text: '正文', heading: null }, { text: '二', heading: 4 },
  ]);
  assert.deepEqual(snippetParagraphs({ title: '片段', body }, { baseLevel: 2, includeTitle: true }), [
    { text: '片段', heading: 2 }, { text: '一', heading: 3 }, { text: '正文', heading: null }, { text: '二', heading: 4 },
  ]);
  assert.equal(snippetParagraphs({ body: '###### 深' }, { baseLevel: 6, includeTitle: true })[0].heading, 9, '不超过标题 9');
  assert.deepEqual(normalizeKnowledgeOptions({ baseLevel: 7, includeTitle: 'yes' }), { baseLevel: 3, includeTitle: false });
  assert.deepEqual(normalizeKnowledgeOptions({ baseLevel: '2', includeTitle: true }), { baseLevel: 2, includeTitle: true });
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
  const end = 3 + '施工准备\r检查模板。'.length;
  assert.deepEqual(state.selected, [end, end], '光标停在插入内容末尾');
});

test('inserts after, before and inside a paragraph without changing its text or style', () => {
  let state = createHost({ paragraphs: ['前文', '后文'], cursor: 2 });
  insertSnippet(snippet, { includeTitle: true });
  assert.deepEqual(texts(state), ['前文', '混凝土浇筑', '施工准备', '检查模板。', '后文']);
  assert.deepEqual(styles(state), ['标书正文', '标题 3', '标题 4', '正文', '标书正文']);

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
  assert.deepEqual(insertSnippet(snippet, { includeTitle: true }), { paragraphs: 3, headings: 0, inTable: true });
  assert.deepEqual(texts(state), ['混凝土浇筑', '施工准备', '检查模板。', '后文']);
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

test('captures selected paragraphs with outline levels as a snippet draft', () => {
  const paragraphs = ['二、施工方法', '（一）准备', '检查模板\t和支撑', '', '（二）浇筑', '分层浇筑'];
  const full = paragraphs.reduce((sum, text) => sum + text.length + 1, 0);
  createHost({ paragraphs, outline: [2, 3, 10, 10, 3, 10], cursor: 0, end: full, document: { ReadOnly: true } });
  assert.deepEqual(readSelectionAsSnippet(), {
    title: '二、施工方法', body: '# 二、施工方法\n## （一）准备\n检查模板 和支撑\n## （二）浇筑\n分层浇筑', paragraphs: 5, headings: 3,
  });

  // 部分选中第 2、3 段时按整段收录，最高的标题记为 #。
  const second = paragraphs[0].length + 1;
  createHost({ paragraphs, outline: [2, 3, 10, 10, 3, 10], cursor: second + 1, end: second + paragraphs[1].length + 3 });
  assert.equal(readSelectionAsSnippet().body, '# （一）准备\n检查模板 和支撑');

  createHost({ paragraphs: ['只有正文', '第二段'], cursor: 0, end: 6 });
  assert.deepEqual(readSelectionAsSnippet(), { title: '只有正文', body: '只有正文\n第二段', paragraphs: 2, headings: 0 });

  createHost({ paragraphs: ['正文'], cursor: 1 });
  assert.throws(() => readSelectionAsSnippet(), /先在文档中选中/);
  createHost({ paragraphs: ['', ''], cursor: 0, end: 2 });
  assert.throws(() => readSelectionAsSnippet(), /没有可收录的文字/);
  createHost({ paragraphs: ['长'.repeat(20001)], cursor: 0, end: 20001 });
  assert.throws(() => readSelectionAsSnippet(), /超过 20000 字/);
});

test('strips cell end marks and control characters from captured text', () => {
  const state = createHost({ paragraphs: ['单元格文字', '下一段'], cursor: 0, end: 9 });
  state.paragraphs[0].cellEnd = true;
  state.paragraphs[1].text = `下${String.fromCharCode(1)}一段${String.fromCharCode(0x0b)}换行`;
  assert.equal(readSelectionAsSnippet().body, '单元格文字\n下一段 换行');
});
