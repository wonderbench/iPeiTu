import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { getLayoutScope, runLayoutOperation, spaceDeletions, readTableWidth, LAYOUT_OPERATIONS } from '../public/layout-tools.js';

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
      get Tables() { return collection(state.cursorTables ?? []); },
    };
  globalThis.Application = {
    Documents: { Count: options.noDocument ? 0 : 1 },
    CentimetersToPoints: value => value * 72 / 2.54,
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
  assert.equal(LAYOUT_OPERATIONS.length, 14, '一键排版 10 项、表格宽度与 3 种表格对齐');
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

function widthTable({ rows, columns = 1, nested = [] }) {
  const cells = [];
  rows.forEach((widths, index) => widths.forEach(width => cells.push({ Width: width, RowIndex: index + 1, NestingLevel: 1 })));
  for (const width of nested) cells.push({ Width: width, RowIndex: 1, NestingLevel: 2 });
  return {
    NestingLevel: 1, PreferredWidthType: 1, PreferredWidth: 0, Rows: { Alignment: 0, LeftIndent: 12 },
    Range: { Cells: collection(cells), PageSetup: { TextColumns: { Count: columns } } }, cells,
  };
}
const rowSum = (table, row) => table.cells.filter(cell => cell.RowIndex === row && cell.NestingLevel === 1).reduce((sum, cell) => sum + cell.Width, 0);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.05, `${message}：${actual} ≈ ${expected}`);

test('表格宽度：按一栏或多栏的目标宽度逐行等比缩放，已符合与读不出宽度的表格不动', () => {
  const state = createHost();
  const single = widthTable({ rows: [[100, 200], [150, 150]], nested: [50] });
  const multi = widthTable({ rows: [[120, 120]], columns: 2 });
  const fitted = widthTable({ rows: [[425.2]] });
  const unknown = widthTable({ rows: [[9999999, 100]] });
  state.tables.push(single, multi, fitted, unknown);
  const result = runLayoutOperation('standardizeWidths', { singleCm: 15, multiCm: 7 });
  const singleTarget = 15 * 72 / 2.54;
  const multiTarget = 7 * 72 / 2.54;
  near(rowSum(single, 1), singleTarget, '一栏表格第 1 行');
  near(rowSum(single, 2), singleTarget, '一栏表格第 2 行');
  near(single.cells[1].Width / single.cells[0].Width, 2, '列宽比例保持');
  assert.equal(single.cells[4].Width, 50, '嵌套表格的单元格不动');
  assert.equal(single.PreferredWidthType, 3);
  near(single.PreferredWidth, singleTarget, '首选宽度');
  near(rowSum(multi, 1), multiTarget, '多栏表格');
  assert.deepEqual([fitted.cells[0].Width, fitted.PreferredWidthType], [425.2, 1], '已符合目标宽度的表格不改');
  assert.deepEqual(unknown.cells.map(cell => cell.Width), [9999999, 100], '读不出宽度的表格不改');
  assert.equal(result.message, '表格宽度：已调整 2 个表格（一栏 1、多栏 1）；已符合 1 个；无法读取宽度 1 个');
  assert.deepEqual(state.undo, [['start', 'iPeiTu 排版：表格宽度'], ['end']]);
});

test('目标宽度无效时在开始撤销记录前拒绝', () => {
  const state = createHost();
  for (const options of [undefined, {}, { singleCm: 0.5, multiCm: 7 }, { singleCm: 15, multiCm: 61 }, { singleCm: '15', multiCm: 7 }, { singleCm: NaN, multiCm: 7 }]) {
    assert.throws(() => runLayoutOperation('standardizeWidths', options), /1–60 厘米/);
  }
  assert.equal(state.undo.length, 0);
});

test('表格对齐通过行集合整体设置，左对齐时清零左缩进', () => {
  let state = createHost();
  const tables = [widthTable({ rows: [[100]] }), widthTable({ rows: [[100]] })];
  state.tables.push(...tables);
  assert.equal(runLayoutOperation('alignTablesCenter').message, '表格居中：已处理 2 个表格');
  assert.deepEqual(tables.map(table => [table.Rows.Alignment, table.Rows.LeftIndent]), [[1, 12], [1, 12]]);
  runLayoutOperation('alignTablesLeft');
  assert.deepEqual(tables.map(table => [table.Rows.Alignment, table.Rows.LeftIndent]), [[0, 0], [0, 0]]);
  runLayoutOperation('alignTablesRight');
  assert.deepEqual(tables.map(table => table.Rows.Alignment), [2, 2]);
  state = createHost();
  assert.equal(runLayoutOperation('alignTablesRight').message, '表格右对齐：没有需要处理的内容');
});

test('读取当前表格：返回最宽一行的厘米数和是否多栏，不在表格或宽度不确定时说明原因', () => {
  assert.throws(() => readTableWidth(), /WPS 文字/);
  const state = createHost();
  assert.throws(() => readTableWidth(), /光标放在/);
  state.cursorTables = [widthTable({ rows: [[100, 200], [150, 160]] })];
  assert.deepEqual(readTableWidth(), { widthCm: 10.9, multiColumn: false });
  state.cursorTables = [widthTable({ rows: [[198.4]], columns: 2 })];
  assert.deepEqual(readTableWidth(), { widthCm: 7, multiColumn: true });
  state.cursorTables = [widthTable({ rows: [[9999999]] })];
  assert.throws(() => readTableWidth(), /无法读取/);
});
