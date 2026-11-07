import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { getLayoutScope, runLayoutOperation, spaceDeletions, LAYOUT_OPERATIONS } from '../public/layout-tools.js';

const FULL_WIDTH_SPACE = String.fromCharCode(0x3000);
afterEach(() => { delete globalThis.Application; });

const collection = items => ({ get Count() { return items.length; }, Item: index => items[index - 1] });
const shading = () => ({ Texture: 5, ForegroundPatternColor: 255, BackgroundPatternColor: 65535 });

function makeTable(state, texts) {
  const cells = texts.map(text => {
    const cell = { text, field: false, TopPadding: 3, BottomPadding: 3, LeftPadding: 5, RightPadding: 5, Shading: shading(), Borders: { Enable: -1 } };
    state.cells.push(cell);
    Object.defineProperty(cell, 'Range', { get() {
      const start = state.cells.slice(0, state.cells.indexOf(cell)).reduce((sum, item) => sum + item.text.length + 1, 0);
      return { Start: start, End: start + cell.text.length + 1 };
    } });
    return cell;
  });
  return {
    PreferredWidthType: 1, PreferredWidth: 50, TopPadding: 3, BottomPadding: 3, LeftPadding: 5, RightPadding: 5, AllowAutoFit: true,
    Shading: shading(), Borders: { Enable: -1 }, Range: { Cells: collection(cells) },
  };
}

function createHost(options = {}) {
  const state = { undo: [], cells: [], paragraphReset: 0, fontReset: 0, current: {}, selected: {} };
  state.paragraphs = (options.paragraphs ?? ['正文\r']).map(item => (typeof item === 'string' ? { text: item, inTable: false } : item));
  for (const paragraph of state.paragraphs) paragraph.style = '标书正文';
  state.tables = (options.tables ?? []).map(texts => makeTable(state, texts));
  const offsetAfter = paragraph => state.paragraphs.slice(0, state.paragraphs.indexOf(paragraph) + 1).reduce((sum, item) => sum + item.text.length, 0);
  const paragraphObject = paragraph => ({
    get Style() { return paragraph.style; },
    set Style(value) { paragraph.style = value; },
    Range: {
      get Text() { return paragraph.text; },
      get End() { return offsetAfter(paragraph); },
      Information(type) { assert.equal(type, 12); return paragraph.inTable; },
      Delete() { state.paragraphs.splice(state.paragraphs.indexOf(paragraph), 1); },
    },
  });
  const paragraphs = { get Count() { return state.paragraphs.length; }, Item: index => paragraphObject(state.paragraphs[index - 1]) };
  const inline = collection(options.inline ?? []);
  const doc = {
    Name: '标书.docx', ReadOnly: false, ProtectionType: -1, ...options.document,
    get Content() {
      return { Start: 0, End: offsetAfter(state.paragraphs.at(-1)), Paragraphs: paragraphs, Tables: collection(state.tables), InlineShapes: inline };
    },
    Shapes: collection(options.shapes ?? []),
    Range(start, end) {
      let offset = 0;
      const cell = state.cells.find(item => {
        if (start >= offset && end <= offset + item.text.length) return true;
        offset += item.text.length + 1;
        return false;
      });
      assert.ok(cell, '文字范围只在单个单元格内');
      const from = start - offset;
      const to = end - offset;
      return {
        Start: start, End: end,
        get Text() { return cell.text.slice(from, to) + (cell.field ? '域代码' : ''); },
        Delete() { cell.text = cell.text.slice(0, from) + cell.text.slice(to); },
      };
    },
  };
  const selected = options.selected;
  const selectionRange = selected
    ? {
      Start: 0, End: 9, StoryType: options.story ?? 1, Paragraphs: paragraphs,
      Tables: collection(selected.tables ? selected.tables.map(index => state.tables[index]) : state.tables),
      InlineShapes: collection(selected.inline ?? []),
      ParagraphFormat: Object.assign(state.selected, { Reset() { state.paragraphReset++; } }),
      Font: { Reset() { state.fontReset++; } },
    }
    : {
      Start: 3, End: 3, StoryType: options.story ?? 1,
      Paragraphs: { Count: 1, Item: () => ({ Range: { ParagraphFormat: state.current, Paragraphs: { Count: 1 } } }) },
    };
  globalThis.Application = {
    Documents: { Count: options.noDocument ? 0 : 1 },
    ActiveDocument: doc,
    Selection: { Range: selectionRange },
    UndoRecord: {
      StartCustomRecord(name) { state.undo.push(['start', name]); },
      EndCustomRecord() { state.undo.push(['end']); },
    },
  };
  return state;
}

test('作用范围：未选中内容为全文，选中时只作用于所选内容；不可编辑时不可用', () => {
  assert.equal(getLayoutScope().available, false);
  createHost();
  assert.deepEqual(getLayoutScope(), { available: true, whole: true, message: '标书.docx · 未选中内容，作用于全文' });
  createHost({ selected: {} });
  assert.equal(getLayoutScope().message, '标书.docx · 作用于所选内容');
  for (const [options, message] of [[{ noDocument: true }, /先打开/], [{ document: { ReadOnly: true } }, /只读/],
    [{ document: { ProtectionType: 2 } }, /受保护/], [{ story: 7 }, /仅支持正文/]]) {
    const state = createHost(options);
    assert.match(getLayoutScope().message, message);
    assert.throws(() => runLayoutOperation('deleteEmptyLines'), message);
    assert.equal(state.undo.length, 0, '不可编辑时不开始撤销记录');
  }
  assert.throws(() => runLayoutOperation('unknown'), /未知/);
  assert.equal(LAYOUT_OPERATIONS.length, 10);
});

test('清除空格：删除全角与首尾空格，英文或数字之间保留一个半角空格', () => {
  const apply = text => spaceDeletions(text).reverse().reduce((value, [start, end]) => value.slice(0, start) + value.slice(end), text);
  assert.equal(apply('  A  B  '), 'A B');
  assert.equal(apply('Q235 B'), 'Q235 B');
  assert.equal(apply('混凝土 C30'), '混凝土C30');
  assert.equal(apply(`${FULL_WIDTH_SPACE}钢筋${FULL_WIDTH_SPACE}绑扎 `), '钢筋绑扎');
  assert.equal(apply(`a${FULL_WIDTH_SPACE} b`), 'a b');
  assert.equal(apply('第一段 \r 第二段'), '第一段\r第二段');
});

test('清除格式只作用于所选内容：段落样式恢复正文，段落与字符格式重置', () => {
  let state = createHost({ paragraphs: ['甲\r', '乙\r'] });
  assert.throws(() => runLayoutOperation('clearFormatting'), /请先选中/);
  assert.deepEqual(state.paragraphs.map(item => item.style), ['标书正文', '标书正文']);
  state = createHost({ paragraphs: ['甲\r', '乙\r'], selected: {} });
  const result = runLayoutOperation('clearFormatting');
  assert.deepEqual(state.paragraphs.map(item => item.style), [-1, -1]);
  assert.deepEqual([state.paragraphReset, state.fontReset], [1, 1]);
  assert.equal(result.message, '清除格式：已处理 2 段');
  assert.deepEqual(state.undo, [['start', 'iPeiTu 排版：清除格式'], ['end']]);
});

test('首行缩进与居中对齐：未选中时只改光标所在段落，选中时改所选段落', () => {
  let state = createHost({ paragraphs: ['甲\r', '乙\r', '丙\r'] });
  assert.equal(runLayoutOperation('firstLineIndent').message, '首行缩进：已处理 1 段');
  assert.equal(runLayoutOperation('center').message, '居中对齐：已处理 1 段');
  assert.deepEqual(state.current, { CharacterUnitFirstLineIndent: 2, Alignment: 1 });
  assert.deepEqual(state.selected, {});
  state = createHost({ paragraphs: ['甲\r', '乙\r', '丙\r'], selected: {} });
  assert.equal(runLayoutOperation('firstLineIndent').message, '首行缩进：已处理 3 段');
  assert.equal(state.selected.CharacterUnitFirstLineIndent, 2);
  assert.deepEqual(state.current, {});
});

test('删除空行：删除空白段落，保留表格内、分节符、文档末尾和两个表格之间的空行', () => {
  const state = createHost({ paragraphs: [
    '正文一\r', '\r', ` ${FULL_WIDTH_SPACE}\t\r`,
    { text: '表格一\r', inTable: true }, { text: '\r', inTable: true }, '\r', { text: '表格二\r', inTable: true },
    '\f\r', '\r', '结尾\r', '\r',
  ] });
  const result = runLayoutOperation('deleteEmptyLines');
  assert.deepEqual(state.paragraphs.map(item => item.text), ['正文一\r', '表格一\r', '\r', '\r', '表格二\r', '\f\r', '结尾\r', '\r']);
  assert.deepEqual([result.count, result.skipped], [3, 1]);
  assert.equal(result.message, '删除空行：已处理 3 处；表格之间的空行保留 1 处');
});

test('表格满页、边距清零、去除底纹、去除表格线作用于全部表格或所选表格', () => {
  let state = createHost({ tables: [['甲', '乙'], ['丙']] });
  assert.equal(runLayoutOperation('tableFullWidth').message, '表格满页：已处理 2 个表格');
  assert.deepEqual(state.tables.map(table => [table.PreferredWidthType, table.PreferredWidth]), [[2, 100], [2, 100]]);
  runLayoutOperation('zeroPadding');
  for (const item of [...state.tables, ...state.cells]) {
    assert.deepEqual([item.TopPadding, item.BottomPadding, item.LeftPadding, item.RightPadding], [0, 0, 0, 0]);
  }
  assert.deepEqual(state.tables.map(table => table.AllowAutoFit), [false, false]);
  runLayoutOperation('removeShading');
  for (const item of [...state.tables, ...state.cells]) {
    assert.deepEqual(item.Shading, { Texture: 0, ForegroundPatternColor: -16777216, BackgroundPatternColor: -16777216 });
  }
  runLayoutOperation('removeBorders');
  assert.ok([...state.tables, ...state.cells].every(item => item.Borders.Enable === 0));
  assert.equal(state.undo.filter(([kind]) => kind === 'start').length, 4, '每项操作一次撤销记录');

  state = createHost({ tables: [['甲'], ['乙']], selected: { tables: [1] } });
  runLayoutOperation('tableFullWidth');
  assert.deepEqual(state.tables.map(table => table.PreferredWidth), [50, 100], '选中时只改所选表格');
  state = createHost();
  assert.equal(runLayoutOperation('removeBorders').message, '去除表格线：没有需要处理的内容');
});

test('清除空格逐个单元格删除，含域代码的单元格跳过并计数', () => {
  const state = createHost({ tables: [[' 钢筋 ', 'Q235  B'], ['混凝土 C30', ' 有域 ']] });
  state.cells[3].field = true;
  const result = runLayoutOperation('clearTableSpaces');
  assert.deepEqual(state.cells.map(cell => cell.text), ['钢筋', 'Q235 B', '混凝土C30', ' 有域 ']);
  assert.deepEqual([result.count, result.skipped], [4, 1]);
  assert.equal(result.message, '清除空格：已处理 4 个空格；含域或隐藏文字的单元格未处理 1 处');
});

test('一键去色：图片改灰度，图形填充和线条改灰色；浮动图形只在全文时处理', () => {
  const picture = type => ({ Type: type, PictureFormat: { ColorType: 1 } });
  const inline = [picture(3), picture(4), picture(5)];
  const floating = picture(13);
  const drawing = { Type: 1, Fill: { Visible: -1, ForeColor: { RGB: 0x0000ff } }, Line: { Visible: -1, ForeColor: { RGB: 0x00ff00 } } };
  const hidden = { Type: 1, Fill: { Visible: 0, ForeColor: { RGB: 0x0000ff } }, Line: { Visible: 0, ForeColor: { RGB: 0x0000ff } } };
  const group = { Type: 6 };
  const unsupported = { Type: 1, get Fill() { throw new Error('不支持'); } };
  createHost({ inline, shapes: [floating, drawing, hidden, group, unsupported] });
  const result = runLayoutOperation('decolor');
  assert.deepEqual(inline.map(item => item.PictureFormat.ColorType), [2, 2, 1]);
  assert.equal(floating.PictureFormat.ColorType, 2);
  const gray = value => value + value * 256 + value * 65536;
  assert.deepEqual([drawing.Fill.ForeColor.RGB, drawing.Line.ForeColor.RGB], [gray(76), gray(150)]);
  assert.equal(hidden.Fill.ForeColor.RGB, 0x0000ff, '不可见的填充不改');
  assert.deepEqual([result.count, result.skipped], [5, 2]);

  const selectedPicture = picture(3);
  const untouched = picture(13);
  createHost({ shapes: [untouched], selected: { inline: [selectedPicture] } });
  runLayoutOperation('decolor');
  assert.deepEqual([selectedPicture.PictureFormat.ColorType, untouched.PictureFormat.ColorType], [2, 1]);
});

test('操作中途出错时关闭撤销记录，并提示可以撤销恢复', () => {
  const state = createHost({ tables: [['甲'], ['乙']] });
  Object.defineProperty(state.tables[1], 'PreferredWidthType', { set() { throw new Error('宿主拒绝'); } });
  assert.throws(() => runLayoutOperation('tableFullWidth'), /表格满页未完成：宿主拒绝。若文档已有改动，可撤销一次恢复/);
  assert.deepEqual(state.undo, [['start', 'iPeiTu 排版：表格满页'], ['end']]);
});

test('功能区排版工具打开独立任务窗格并复用，不影响素材库窗格', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const storage = new Map();
  const panes = [];
  const app = {
    PluginStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    CreateTaskPane(url) { const pane = { ID: panes.length + 1, url, Visible: false }; panes.push(pane); return pane; },
    GetTaskPane(id) { return panes.find(pane => pane.ID === id); },
  };
  const context = vm.createContext({ URL, window: { Application: app, location: { href: 'http://127.0.0.1:39831/index.html' } } });
  vm.runInContext(source, context);
  context.OpenLayoutTools();
  context.OpenImageLibrary();
  context.OpenLayoutTools();
  assert.deepEqual(panes.map(pane => pane.url), ['http://127.0.0.1:39831/format.html', 'http://127.0.0.1:39831/taskpane.html']);
  assert.ok(panes.every(pane => pane.Visible && pane.DockPosition === 2));
});
