import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  captureInsertionTarget, getHostStatus, insertPicture, captureReplacementTarget, getReplacementStatus, replacePicture,
  capturePlaceholderTarget, insertPlaceholder, scanPlaceholders, selectPlaceholder, placeholderMarker, parsePlaceholderMarker,
} from '../public/wps-bridge.js';
import { normalizeLayoutOptions } from '../public/layout-options.js';

const asset = { path: 'C:\\素材库\\沟槽 开挖.png', name: '沟槽 开挖.png', width: 1600, height: 900 };
afterEach(() => { delete globalThis.Application; });

function createHost(options = {}) {
  const state = { text: options.text ?? '开头需要保留的文字结尾', start: options.start ?? 2, end: options.end ?? 9, story: 1, pictures: [], calls: [], undoStarted: 0, undoEnded: 0 };
  const originalFormat = { Alignment: 3, LeftIndent: 12, RightIndent: 8, FirstLineIndent: 24, LineSpacingRule: 4, KeepWithNext: 0, ...options.format };
  state.paragraphs = state.text.split('\r').map(() => ({ style: options.style ?? '标书正文', format: { ...originalFormat }, numbered: Boolean(options.numbered) }));
  const page = { PageWidth: 600, LeftMargin: 60, RightMargin: 60, PageHeight: 800, TopMargin: 72, BottomMargin: 72, ...options.page };
  const cell = { Width: 220, LeftPadding: 10, RightPadding: 10, Height: 180, HeightRule: 2, TopPadding: 5, BottomPadding: 5, ...options.cell };
  function makePicture(position, initialWidth, initialHeight, original = false, type = 3) {
    let width = initialWidth;
    let height = initialHeight;
    return {
      position, original, deleted: false, Type: type,
      font: { Name: '仿宋', Size: 14, Bold: -1, Position: 3, ...options.font },
      LockAspectRatio: 0,
      get Width() { return width; },
      set Width(value) {
        if (options.resizeError) throw new Error('resize unavailable');
        if (this.LockAspectRatio === -1 && !options.ignoreAspectRatio) height *= value / width;
        width = value;
      },
      get Height() { return height; },
      set Height(value) {
        if (this.LockAspectRatio === -1 && !options.ignoreAspectRatio) width *= value / height;
        height = value;
      },
      altText: '',
      get AlternativeText() { return options.altTextDropped ? '' : this.altText; },
      set AlternativeText(value) { this.altText = value; },
      get Range() {
        if (this.deleted) throw new Error('original object deleted');
        const at = this.original && options.staleOriginalRange ? options.originalPictures[0].position : this.position;
        return rangeAt(at, at + 1);
      },
      Delete() {
        state.calls.push({ delete: this.original ? 'original' : 'new', position: this.position });
        const failure = this.original ? options.oldDeleteError : options.newDeleteError;
        if (failure === 'before') throw new Error('delete unavailable');
        const at = this.position;
        state.text = state.text.slice(0, at) + state.text.slice(at + 1);
        state.pictures.splice(state.pictures.indexOf(this), 1);
        for (const item of state.pictures) if (item.position > at) item.position--;
        this.deleted = true;
        if (failure === 'after') throw new Error('delete result unavailable');
      },
    };
  }
  function insertText(at, text) {
    const paragraphIndex = state.text.slice(0, at).split('\r').length - 1;
    const inherited = state.paragraphs[paragraphIndex];
    const breaks = text.split('\r').length - 1;
    state.paragraphs.splice(paragraphIndex, 0, ...Array.from({ length: breaks }, () => ({ style: inherited.style, format: { ...inherited.format }, numbered: inherited.numbered })));
    for (const picture of state.pictures) if (picture.position >= at) picture.position += text.length;
    state.text = state.text.slice(0, at) + text + state.text.slice(at);
  }
  function paragraphAt(at) {
    const index = state.text.slice(0, at).split('\r').length - 1;
    const start = at === 0 ? 0 : state.text.lastIndexOf('\r', at - 1) + 1;
    const endMark = state.text.indexOf('\r', at);
    const end = endMark === -1 ? state.text.length : endMark + (state.text[endMark + 1] === '\u0007' ? 2 : 1);
    return {
      get Range() { return rangeAt(start, end); },
      get Style() { return state.paragraphs[index].style; },
      set Style(value) { state.paragraphs[index].style = value; },
      get Format() {
        const format = state.paragraphs[index].format;
        Object.defineProperty(format, 'Duplicate', { get() { return { ...format }; }, configurable: true });
        return format;
      },
      set Format(value) { state.paragraphs[index].format = { ...value }; },
    };
  }
  function rangeAt(start, end) {
    return {
      start,
      end,
      get Start() { return this.start; },
      get End() { return this.end; },
      get Text() { return state.text.slice(this.start, this.end); },
      get StoryType() { return state.story; },
      get Duplicate() { return rangeAt(this.start, this.end); },
      get Paragraphs() { return { Item: () => paragraphAt(this.start) }; },
      get Font() {
        const picture = state.pictures.find(item => item.position === this.start);
        assert.ok(picture, '字符格式仅从图片字符读取');
        return { Duplicate: { ...picture.font } };
      },
      set Font(value) {
        if (options.fontError) throw new Error('font unavailable');
        const picture = state.pictures.find(item => item.position === this.start);
        assert.ok(picture, '字体只应用到新图片字符');
        picture.font = { ...value };
      },
      get ListFormat() {
        return { RemoveNumbers: () => { state.paragraphs[state.text.slice(0, this.start).split('\r').length - 1].numbered = false; } };
      },
      SetRange(newStart, newEnd) { this.start = newStart; this.end = newEnd; },
      InsertAfter(text) {
        if (options.paragraphError) throw new Error('paragraph insertion unavailable');
        insertText(this.end, text);
        this.end += text.length;
      },
      PageSetup: page,
      Information(value) {
        assert.equal(value, 12);
        return Boolean(options.inTable);
      },
      Cells: { Item(index) { assert.equal(index, 1); return cell; } },
      Collapse(direction) {
        assert.ok([0, 1].includes(direction));
        if (direction === 0) this.start = this.end;
        else this.end = this.start;
      },
      Select() {
        if (options.selectError) throw new Error('selection unavailable');
        state.start = this.start;
        state.end = this.end;
      },
      get InlineShapes() {
        const range = this;
        return {
          get Count() { return state.pictures.filter(item => item.position >= range.start && item.position < range.end).length; },
          Item(index) { return state.pictures.filter(item => item.position >= range.start && item.position < range.end)[index - 1]; },
          AddPicture(path, link, save, insertion) {
            state.calls.push({ path, link, save, start: insertion.start, end: insertion.end });
            if (options.insertError) throw new Error('file missing');
            assert.equal(insertion.start, insertion.end, '图片不得覆盖未折叠选区');
            insertText(insertion.start, '\uFFFC');
            const picture = makePicture(insertion.start, options.pictureWidth ?? 800, options.pictureHeight ?? 450);
            state.pictures.push(picture);
            if (options.insertErrorAfterAdd) throw new Error('add result unavailable');
            return picture;
          },
        };
      },
    };
  }
  const app = {
    Documents: { Count: options.noDocument ? 0 : 1 },
    ActiveDocument: { Name: '标书.docx', FullName: 'C:\\文档\\标书.docx', ReadOnly: false, ProtectionType: -1, ...options.document },
    Selection: { Type: options.selectionType ?? 7, get Range() { return rangeAt(state.start, state.end); } },
    CentimetersToPoints(value) { return value * 72 / 2.54; },
    UndoRecord: {
      StartCustomRecord() { state.undoStarted++; },
      EndCustomRecord() {
        state.undoEnded++;
        if (options.undoEndError) throw new Error('undo unavailable');
      },
    },
  };
  for (const original of options.originalPictures || []) {
    state.pictures.push(makePicture(original.position, original.width ?? 240, original.height ?? 120, true, original.type ?? 3));
  }
  Object.defineProperty(app.ActiveDocument, 'InlineShapes', {
    get() {
      const ordered = [...state.pictures].sort((a, b) => a.position - b.position);
      return { Count: ordered.length, Item: index => ordered[index - 1] };
    },
  });
  globalThis.Application = app;
  return { app, state };
}

test('普通浏览器和无文档状态不给出插入可用状态', () => {
  assert.equal(getHostStatus().available, false);
  assert.match(getHostStatus().message, /WPS 文字/);
  createHost({ noDocument: true });
  assert.equal(getHostStatus().available, false);
  assert.throws(() => insertPicture(asset), /先打开/);
});

test('当前文档状态明确显示文件名', () => {
  createHost();
  assert.deepEqual(getHostStatus(), { available: true, message: '插入到：标书.docx' });
});

test('排版设置归一化保留兼容默认值及单行图题', () => {
  assert.deepEqual(normalizeLayoutOptions(), { widthMode: 'auto', widthCm: 12, maxHeightCm: null, layout: 'inline', caption: '' });
  const input = { widthMode: 'fixed', widthCm: 10, maxHeightCm: 20, layout: 'centered', caption: '  沟槽开挖  ' };
  assert.deepEqual(normalizeLayoutOptions(input), { ...input, caption: '沟槽开挖' });
  assert.equal(input.caption, '  沟槽开挖  ', '归一化不得修改调用方对象');
  assert.equal(normalizeLayoutOptions({ caption: '图'.repeat(200) }).caption.length, 200);
});

test('无效排版输入在访问或写入文档前拒绝', () => {
  const { state } = createHost();
  const invalid = [
    null, [], 'fixed', { widthMode: 'stretch' }, { layout: 'floating' },
    ...[NaN, Infinity, '12', 0, 0.49, 50.01].map((widthCm) => ({ widthCm })),
    ...[NaN, Infinity, '12', 0, 0.49, 50.01].map((maxHeightCm) => ({ maxHeightCm })),
    ...[42, '图\r题', '图\n题', '图\t题', '图\u0007题', '图\u2028题', '图'.repeat(201)].map((caption) => ({ caption })),
  ];
  for (const options of invalid) assert.throws(() => insertPicture(asset, undefined, options));
  assert.equal(state.calls.length, 0);
  assert.equal(state.undoStarted, 0);
  assert.equal(state.text, '开头需要保留的文字结尾');
});

test('只读与受保护文档在任何写入前拒绝', () => {
  for (const [document, message] of [[{ ReadOnly: true }, /只读/], [{ ProtectionType: 3 }, /受保护/]]) {
    const { state } = createHost({ document });
    assert.equal(getHostStatus().available, false);
    assert.throws(() => insertPicture(asset), message);
    assert.equal(state.calls.length, 0);
  }
});

test('非本地绝对路径不交给 WPS', () => {
  const { state } = createHost();
  for (const path of ['image.png', 'https://example.com/a.png', 'blob:123', 'C:image.png', '']) {
    assert.throws(() => insertPicture({ ...asset, path }), /路径无效/);
  }
  assert.equal(state.calls.length, 0);
});

test('选区末端插入保留全部文字，使用嵌入参数并等比缩小', () => {
  const { state } = createHost();
  const original = state.text;
  const end = state.end;
  const result = insertPicture(asset);
  assert.equal(state.text, original.slice(0, end) + '\uFFFC' + original.slice(end));
  assert.deepEqual(state.calls, [{ path: asset.path, link: false, save: true, start: end, end }]);
  assert.deepEqual(result, { name: asset.name, width: 480, height: 270 });
  assert.equal(state.pictures[0].LockAspectRatio, -1);
  assert.equal(state.start, end + 1);
  assert.equal(state.end, end + 1);
});

test('连续两次插图读取最新光标，第二张在第一张后面', () => {
  const { state } = createHost();
  state.start = state.end = 4;
  insertPicture(asset);
  insertPicture(asset);
  assert.deepEqual(state.calls.map(({ start, end }) => [start, end]), [[4, 4], [5, 5]]);
  assert.equal(state.text.slice(4, 6), '\uFFFC\uFFFC');
  assert.equal(state.end, 6);
});

test('路径请求期间切换到同名不同目录的文档时中止插入', () => {
  const first = createHost();
  const target = captureInsertionTarget();
  const second = createHost({ document: { FullName: 'D:\\另一个项目\\标书.docx' } });
  assert.throws(() => insertPicture(asset, target), /插入已中止.*当前文档或光标位置已改变/);
  assert.equal(first.state.calls.length, 0);
  assert.equal(second.state.calls.length, 0);
});

test('路径请求期间移动光标或更改选区时中止插入', () => {
  for (const change of [({ state }) => { state.start = state.end = 1; }, ({ state }) => { state.start += 1; }]) {
    const host = createHost();
    const target = captureInsertionTarget();
    change(host);
    assert.throws(() => insertPicture(asset, target), /插入已中止.*当前文档或光标位置已改变/);
    assert.equal(host.state.calls.length, 0);
  }
});

test('同文档同坐标从正文切换到页眉时中止插入', () => {
  const { state } = createHost();
  const target = captureInsertionTarget();
  state.story = 7;
  assert.throws(() => insertPicture(asset, target), /仅支持在正文和正文表格中插入图片/);
  assert.equal(state.calls.length, 0);
  assert.equal(state.undoStarted, 0);
});

test('同类不同页眉、其他非正文及未知 story 均在插入状态、捕获和写入前拒绝', () => {
  const hosts = [createHost(), createHost()];
  for (const host of hosts) {
    globalThis.Application = host.app;
    host.state.story = 7;
    assert.equal(getHostStatus().available, false);
    assert.match(getHostStatus().message, /仅支持在正文和正文表格中插入图片/);
    assert.throws(() => captureInsertionTarget(), /仅支持在正文/);
    assert.throws(() => insertPicture(asset), /仅支持在正文/);
    assert.equal(host.state.calls.length, 0);
    assert.equal(host.state.undoStarted, 0);
  }
  for (const story of [undefined, null, 0, 5, 6, 8, 9, 10, 11]) {
    const { state } = createHost();
    state.story = story;
    assert.equal(getHostStatus().available, false);
    assert.throws(() => captureInsertionTarget(), /仅支持在正文/);
    assert.throws(() => insertPicture(asset), /仅支持在正文/);
    assert.equal(state.calls.length, 0);
    assert.equal(state.undoStarted, 0);
  }
});

test('目标未变时允许插入，下一次点击重新捕获图片后的光标', () => {
  const { state } = createHost();
  const target = captureInsertionTarget();
  assert.deepEqual(target, { document: 'C:\\文档\\标书.docx', start: 2, end: 9, story: 1 });
  insertPicture(asset, target);
  insertPicture(asset, captureInsertionTarget());
  assert.deepEqual(state.calls.map(({ start, end }) => [start, end]), [[9, 9], [10, 10]]);
});

test('表格内按单元格扣除左右内边距限制宽度', () => {
  createHost({ inTable: true });
  assert.deepEqual(insertPicture(asset), { name: asset.name, width: 200, height: 112.5 });
});

test('小图保持原尺寸，超宽表格仍受页面宽度限制', () => {
  createHost({ pictureWidth: 120, pictureHeight: 60 });
  assert.deepEqual(insertPicture(asset), { name: asset.name, width: 120, height: 60 });
  createHost({ inTable: true, cell: { Width: 1000 } });
  assert.equal(insertPicture(asset).width, 480);
});

test('压缩副本按源逻辑宽度自适应，仍受页面、单元格及实际像素比例限高', () => {
  const compressed = { ...asset, width: 1600, height: 960, logicalWidthPt: 720.24, logicalHeightPt: 432.24 };
  createHost({ pictureWidth: 1200, pictureHeight: 720, page: { PageWidth: 1200, LeftMargin: 60, RightMargin: 60 } });
  assert.equal(insertPicture(compressed).width, 720.24);
  createHost({ pictureWidth: 1200, pictureHeight: 720, inTable: true });
  assert.equal(insertPicture(compressed).width, 200);
  createHost({ pictureWidth: 1200, pictureHeight: 720 });
  assert.equal(insertPicture(compressed).width, 480);
  createHost({ pictureWidth: 1200, pictureHeight: 720 });
  const fixed = insertPicture(compressed, undefined, { widthMode: 'fixed', widthCm: 8 });
  assert.equal(fixed.width, 8 * 72 / 2.54);
  createHost({ pictureWidth: 1200, pictureHeight: 38.25 });
  const thin = insertPicture({ ...asset, width: 1600, height: 51, logicalWidthPt: 768, logicalHeightPt: 24.24 },
    undefined, { widthMode: 'fixed', widthCm: 20, maxHeightCm: 0.5 });
  assert.ok(thin.height <= 0.5 * 72 / 2.54 + 1e-10, '取整后的实际高度不能越限');
});

test('非法或缺失一维的逻辑尺寸在任何文档写入之前拒绝', () => {
  const { state } = createHost();
  for (const size of [{ logicalWidthPt: 100 }, { logicalHeightPt: 100 }, { logicalWidthPt: Infinity, logicalHeightPt: 100 },
    { logicalWidthPt: '100', logicalHeightPt: 100 }, { logicalWidthPt: 0, logicalHeightPt: 100 }, { logicalWidthPt: 1e9, logicalHeightPt: 100 }]) {
    assert.throws(() => insertPicture({ ...asset, ...size }), /排版尺寸无效/);
  }
  assert.equal(state.calls.length, 0);
  assert.equal(state.undoStarted, 0);
});

test('无 DPI 副本以宿主实际自然宽度乘源像素倍率，保留不同 JPEG/PNG 缺省且不越限高', () => {
  const scaled = { ...asset, naturalWidthScale: 2 };
  createHost({ pictureWidth: 112.5, pictureHeight: 75 });
  assert.equal(insertPicture(scaled).width, 225, 'JPEG 宿主缺省为192dpi的样本');
  createHost({ pictureWidth: 225, pictureHeight: 150 });
  assert.equal(insertPicture(scaled).width, 450, 'PNG 宿主缺省为96dpi的样本');
  createHost({ pictureWidth: 225, pictureHeight: 150, inTable: true });
  assert.equal(insertPicture(scaled).width, 200);
  createHost({ pictureWidth: 225, pictureHeight: 150 });
  assert.ok(insertPicture(scaled, undefined, { maxHeightCm: 2 }).height <= 2 * 72 / 2.54 + 1e-10);
  const { state } = createHost();
  for (const value of [0, -1, 0.5, Infinity, NaN, '2', 1e9]) {
    assert.throws(() => insertPicture({ ...asset, naturalWidthScale: value }), /倍率无效/);
  }
  assert.throws(() => insertPicture({ ...scaled, logicalWidthPt: 300, logicalHeightPt: 200 }), /倍率无效/);
  assert.equal(state.calls.length, 0);
});

test('固定厘米宽度允许等比放大小图，最大高度优先约束竖图', () => {
  createHost({ pictureWidth: 120, pictureHeight: 60 });
  let result = insertPicture(asset, undefined, { widthMode: 'fixed', widthCm: 12 });
  assert.ok(Math.abs(result.width - 12 * 72 / 2.54) < 1e-8);
  assert.equal(result.width / result.height, 2);
  createHost({ pictureWidth: 120, pictureHeight: 240 });
  result = insertPicture(asset, undefined, { widthMode: 'fixed', widthCm: 12, maxHeightCm: 8 });
  assert.ok(Math.abs(result.height - 8 * 72 / 2.54) < 1e-8);
  assert.equal(result.width / result.height, 0.5);
});

test('固定宽度仍限制在单元格内，自动宽度支持独立限高', () => {
  createHost({ inTable: true, pictureWidth: 120, pictureHeight: 60 });
  assert.equal(insertPicture(asset, undefined, { widthMode: 'fixed', widthCm: 20 }).width, 200);
  createHost({ pictureWidth: 120, pictureHeight: 240 });
  const result = insertPicture(asset, undefined, { maxHeightCm: 2 });
  assert.ok(Math.abs(result.height - 2 * 72 / 2.54) < 1e-8);
  assert.equal(result.width / result.height, 0.5);
});

test('正文中间拆出居中图片和图题，前后文字及段落样式均保留', () => {
  const originalText = '前文需要保留后文\r';
  const { state } = createHost({ text: originalText, start: 2, end: 6, style: '自定义正文', numbered: true });
  const originalFormat = { ...state.paragraphs[0].format };
  insertPicture(asset, captureInsertionTarget(), { layout: 'centered', caption: '基础施工示意' });
  assert.equal(state.text, `${originalText.slice(0, 6)}\r\uFFFC\r基础施工示意\r${originalText.slice(6)}`);
  for (const index of [0, 3]) {
    assert.equal(state.paragraphs[index].style, '自定义正文');
    assert.deepEqual(state.paragraphs[index].format, originalFormat);
    assert.equal(state.paragraphs[index].numbered, true);
  }
  for (const index of [1, 2]) {
    assert.equal(state.paragraphs[index].style, -1);
    assert.equal(state.paragraphs[index].format.Alignment, 1);
    assert.equal(state.paragraphs[index].format.FirstLineIndent, 0);
    assert.equal(state.paragraphs[index].format.LineSpacingRule, 0);
    assert.equal(state.paragraphs[index].numbered, false);
  }
  assert.equal(state.paragraphs[1].format.KeepWithNext, -1);
  assert.equal(state.paragraphs[2].format.KeepWithNext, 0);
  assert.equal(state.end, state.text.indexOf(originalText.slice(6)));
  assert.equal(state.undoStarted, 1);
  assert.equal(state.undoEnded, 1);
});

test('原段落模式配图题仍隔离成两段，并沿用原对齐方式', () => {
  const { state } = createHost({ text: '左文右文\r', start: 2, end: 2, format: { Alignment: 2 } });
  insertPicture(asset, captureInsertionTarget(), { caption: '图题正文' });
  assert.equal(state.text, '左文\r\uFFFC\r图题正文\r右文\r');
  assert.equal(state.paragraphs[1].format.Alignment, 2);
  assert.equal(state.paragraphs[2].format.Alignment, 2);
  assert.equal(state.paragraphs[3].format.Alignment, 2);
});

test('段首无需前置空段，段尾保留可继续输入的原样式段落', () => {
  let { state } = createHost({ text: '原文\r', start: 0, end: 0 });
  insertPicture(asset, undefined, { layout: 'centered' });
  assert.equal(state.text, '\uFFFC\r原文\r');
  assert.equal(state.end, 2);
  ({ state } = createHost({ text: '原文\r', start: 2, end: 2 }));
  insertPicture(asset, undefined, { layout: 'centered' });
  assert.equal(state.text, '原文\r\uFFFC\r\r');
  assert.equal(state.end, 5);
  assert.equal(state.paragraphs[2].style, '标书正文');
});

test('表格内独立图段落保留单元格结束标记，并按单元格宽度缩小', () => {
  const { state } = createHost({ text: '前文后文\r\u0007', start: 2, end: 2, inTable: true });
  assert.equal(insertPicture(asset, undefined, { layout: 'centered', caption: '表内图题' }).width, 200);
  assert.equal(state.text, '前文\r\uFFFC\r表内图题\r后文\r\u0007');
  assert.equal(state.text.match(/\u0007/g).length, 1);
});

test('独立配图连续插入时保持顺序，后文仍完整且保留原样式', () => {
  const { state } = createHost({ text: '前文后文\r', start: 2, end: 2 });
  insertPicture(asset, captureInsertionTarget(), { layout: 'centered', caption: '第一张' });
  insertPicture(asset, captureInsertionTarget(), { layout: 'centered', caption: '第二张' });
  assert.equal(state.text, '前文\r\uFFFC\r第一张\r\uFFFC\r第二张\r后文\r');
  assert.equal(state.paragraphs[5].style, '标书正文');
  assert.equal(state.undoStarted, 2);
  assert.equal(state.undoEnded, 2);
});

test('无法确定可用排版宽度时不插入', () => {
  const { state } = createHost({ page: { PageWidth: 100 } });
  assert.throws(() => insertPicture(asset), /没有可用的排版宽度/);
  assert.equal(state.calls.length, 0);
});

test('宿主插图调用失败不谎报成功，提醒核对后再重试', () => {
  const { state } = createHost({ insertError: true });
  assert.throws(() => insertPicture(asset), (error) => {
    assert.equal(error.inserted, false);
    assert.match(error.message, /未能确认插图结果/);
    assert.match(error.message, /file missing/);
    assert.match(error.message, /确认没有新增图片后再重试/);
    return true;
  });
  assert.equal(state.pictures.length, 0);
});

test('插入后的缩放或光标错误明确说明图片已插入', () => {
  for (const options of [{ resizeError: true }, { selectError: true }]) {
    const { state } = createHost(options);
    assert.throws(() => insertPicture(asset), (error) => {
      assert.equal(error.inserted, true);
      assert.match(error.message, /图片已插入/);
      assert.match(error.message, /不要重复插入/);
      return true;
    });
    assert.equal(state.pictures.length, 1);
  }
});

test('拆段失败保留已插图片并关闭撤销记录，不伪称图题完成', () => {
  const { state } = createHost({ text: '前文后文\r', start: 2, end: 2, paragraphError: true });
  assert.throws(() => insertPicture(asset, undefined, { layout: 'centered', caption: '尚未添加的图题' }), (error) => {
    assert.equal(error.inserted, true);
    assert.match(error.message, /图片已插入，但排版/);
    return true;
  });
  assert.equal(state.text, '前文\uFFFC后文\r');
  assert.equal(state.undoStarted, 1);
  assert.equal(state.undoEnded, 1);
});

test('撤销记录收尾失败仍准确报告已插入状态', () => {
  const { state } = createHost({ undoEndError: true });
  assert.throws(() => insertPicture(asset), (error) => {
    assert.equal(error.inserted, true);
    assert.match(error.message, /无法完成本次撤销记录/);
    return true;
  });
  assert.equal(state.pictures.length, 1);
});

function replacementHost(options = {}) {
  return createHost({ text: '前文\uFFFC后文\r', start: 2, end: 3, originalPictures: [{ position: 2 }], ...options });
}

test('替换仅接受完整的一张内嵌图片，拒绝浏览器、浮动、多选、文字及 OLE', () => {
  assert.equal(getReplacementStatus().available, false);
  for (const options of [
    { noDocument: true }, { document: { ReadOnly: true } }, { document: { ProtectionType: 3 } },
    { selectionType: 8 }, { selectionType: 5 }, { start: 2, end: 2 }, { start: 1, end: 3 }, { start: 2, end: 4 },
    { originalPictures: [{ position: 2, type: 1 }] },
    { text: '前文\uFFFC\uFFFC后文\r', end: 4, originalPictures: [{ position: 2 }, { position: 3 }] },
  ]) {
    const { state } = replacementHost(options);
    assert.equal(getReplacementStatus().available, false);
    assert.throws(() => captureReplacementTarget(), /无法记录替换目标/);
    assert.equal(state.calls.length, 0);
    assert.equal(state.undoStarted, 0);
  }
  for (const type of [3, 4]) {
    replacementHost({ originalPictures: [{ position: 2, type }] });
    assert.equal(getReplacementStatus().available, true);
  }
});

test('相同类型和坐标的不同页眉 story 均拒绝捕获，页脚和文本框也不得替换', () => {
  // 两个宿主具有同一文档名和图片坐标，分别代表两节独立页眉；StoryType 本身不能区分它们。
  const firstHeader = replacementHost();
  firstHeader.state.story = 7;
  assert.equal(getReplacementStatus().available, false);
  assert.throws(() => captureReplacementTarget(), /仅支持替换正文.*页眉、页脚及文本框暂不支持/);
  const secondHeader = replacementHost();
  secondHeader.state.story = 7;
  assert.equal(getReplacementStatus().available, false);
  assert.throws(() => captureReplacementTarget(), /仅支持替换正文/);
  assert.equal(firstHeader.state.calls.length, 0);
  assert.equal(secondHeader.state.calls.length, 0);
  for (const story of [undefined, null, 0, 5, 6, 8, 9, 10, 11]) {
    const { state } = replacementHost();
    const bodyTarget = captureReplacementTarget();
    state.story = story;
    assert.equal(getReplacementStatus().available, false);
    assert.throws(() => replacePicture(asset, bodyTarget), error => !error.inserted && !error.replaced && /仅支持替换正文/.test(error.message));
    assert.equal(state.calls.length, 0);
    assert.equal(state.undoStarted, 0);
  }
});

test('替换保留原实际宽度、字符和段落格式，新图按自身比例缩放并只删除移动后的原图', () => {
  const { state } = replacementHost({ pictureWidth: 120, pictureHeight: 240 });
  const original = state.pictures[0];
  original.font = { Name: '楷体', Size: 18, Bold: -1, Position: 7 };
  const paragraphs = structuredClone(state.paragraphs);
  const target = captureReplacementTarget();
  assert.deepEqual(target, { document: 'C:\\文档\\标书.docx', start: 2, end: 3, story: 1, type: 3, width: 240, height: 120 });
  assert.deepEqual(replacePicture(asset, target), { name: asset.name, width: 240, height: 480, inserted: true, replaced: true });
  assert.equal(state.text, '前文\uFFFC后文\r');
  assert.deepEqual(state.paragraphs, paragraphs);
  assert.deepEqual(state.pictures[0].font, original.font);
  assert.equal(original.deleted, true);
  assert.equal(state.pictures.length, 1);
  assert.equal(state.pictures[0].original, false);
  assert.equal(state.pictures[0].LockAspectRatio, -1);
  assert.deepEqual(state.calls, [
    { path: asset.path, link: false, save: true, start: 2, end: 2 },
    { delete: 'original', position: 3 },
  ]);
  assert.equal(state.start, 3);
  assert.equal(state.end, 3);
  assert.equal(state.undoStarted, 1);
  assert.equal(state.undoEnded, 1);
});

test('替换链接图为内嵌副本，表内保持原宽度而不套用插图的页面或单元格限制', () => {
  const { state } = replacementHost({ text: '前文\uFFFC后文\r\u0007', inTable: true,
    originalPictures: [{ position: 2, type: 4, width: 530, height: 300 }], pictureWidth: 1000, pictureHeight: 500 });
  const result = replacePicture(asset, captureReplacementTarget());
  assert.equal(result.width, 530);
  assert.equal(result.height, 265);
  assert.equal(state.pictures[0].Type, 3);
  assert.equal(state.text, '前文\uFFFC后文\r\u0007');
});

test('替换目标必须来自本次捕获，失效目标或非法路径在任何写入前中止', () => {
  const { state } = replacementHost();
  const target = captureReplacementTarget();
  for (const invalid of [undefined, null, {}, { ...target }]) {
    assert.throws(() => replacePicture(asset, invalid), error => !error.inserted && !error.replaced && /目标已失效/.test(error.message));
  }
  assert.throws(() => replacePicture({ ...asset, path: 'https://example.com/a.png' }, target), /路径无效/);
  assert.equal(state.calls.length, 0);
  assert.equal(state.undoStarted, 0);
});

test('替换路径请求期间文档、story、选区、原图类型或尺寸改变均拒绝写入', () => {
  for (const change of [
    ({ app }) => { app.ActiveDocument.FullName = 'D:\\另一个项目\\标书.docx'; },
    ({ state }) => { state.story = 7; },
    ({ state }) => { state.start = state.end = 1; },
    ({ state }) => { state.pictures[0].Width = 200; },
    ({ state }) => { state.pictures[0].Type = 4; },
    ({ app }) => { app.ActiveDocument.ReadOnly = true; },
  ]) {
    const host = replacementHost();
    const target = captureReplacementTarget();
    change(host);
    assert.throws(() => replacePicture(asset, target), error => !error.inserted && !error.replaced && !error.resultUncertain);
    assert.equal(host.state.calls.length, 0);
    assert.equal(host.state.undoStarted, 0);
  }
});

test('同位置同尺寸换成另一对象后不误用已删除的原图身份', () => {
  const { state } = replacementHost();
  const original = state.pictures[0];
  const target = captureReplacementTarget();
  const another = Object.create(original);
  another.deleted = false;
  state.pictures[0] = another;
  original.deleted = true;
  assert.throws(() => replacePicture(asset, target), /替换已中止/);
  assert.equal(state.calls.length, 0);
  assert.equal(state.undoStarted, 0);
});

test('连续替换重新捕获当前图片，旧目标不能重复消费', () => {
  const { state } = replacementHost();
  const target = captureReplacementTarget();
  replacePicture(asset, target);
  assert.throws(() => replacePicture(asset, target), /目标已失效/);
  state.start = 2;
  state.end = 3;
  replacePicture({ ...asset, name: '第二张.png' }, captureReplacementTarget());
  assert.equal(state.pictures.length, 1);
  assert.equal(state.text, '前文\uFFFC后文\r');
  assert.equal(state.undoStarted, 2);
  assert.equal(state.undoEnded, 2);
});

test('新图缩放、字体或原对象偏移核对失败时只清理新图并保留原图', () => {
  for (const options of [{ resizeError: true }, { fontError: true }, { ignoreAspectRatio: true },
    { pictureWidth: NaN }, { staleOriginalRange: true }]) {
    const { state } = replacementHost(options);
    const original = state.pictures[0];
    assert.throws(() => replacePicture(asset, captureReplacementTarget()), error => {
      assert.equal(error.inserted, false);
      assert.equal(error.replaced, false);
      assert.equal(error.resultUncertain, false);
      assert.match(error.message, /原图已保留，新增图片已移除/);
      return true;
    });
    assert.equal(state.pictures.length, 1);
    assert.equal(state.pictures[0], original);
    assert.equal(original.deleted, false);
    assert.equal(state.text, '前文\uFFFC后文\r');
    assert.deepEqual(state.calls.filter(call => call.delete).map(call => call.delete), ['new']);
    assert.equal(state.undoStarted, 1);
    assert.equal(state.undoEnded, 1);
  }
});

test('新增图片清理失败明确报告不确定状态，绝不删除原图', () => {
  for (const newDeleteError of ['before', 'after']) {
    const { state } = replacementHost({ resizeError: true, newDeleteError });
    const original = state.pictures[0];
    assert.throws(() => replacePicture(asset, captureReplacementTarget()), error => {
      assert.equal(error.replaced, false);
      assert.equal(error.resultUncertain, true);
      assert.match(error.message, /原图尚未删除.*不要重复替换/);
      return true;
    });
    assert.equal(original.deleted, false);
    assert.ok(state.pictures.includes(original));
    assert.equal(state.pictures.length, newDeleteError === 'before' ? 2 : 1);
    assert.equal(state.undoEnded, 1);
  }
});

test('原图删除开始后的异常保留新图，兼容删除前失败与删除后报错', () => {
  for (const oldDeleteError of ['before', 'after']) {
    const { state } = replacementHost({ oldDeleteError });
    assert.throws(() => replacePicture(asset, captureReplacementTarget()), error => {
      assert.equal(error.inserted, true);
      assert.equal(error.replaced, false);
      assert.equal(error.resultUncertain, true);
      assert.match(error.message, /新图已插入，但无法确认原图是否已删除.*不要重复替换/);
      return true;
    });
    assert.ok(state.pictures.some(picture => !picture.original));
    assert.equal(state.pictures.length, oldDeleteError === 'before' ? 2 : 1);
    assert.deepEqual(state.calls.filter(call => call.delete).map(call => call.delete), ['original']);
    assert.equal(state.undoEnded, 1);
  }
});

test('AddPicture 调用结果未返回时不谎报原图已替换，也不盲目清理其他图片', () => {
  for (const options of [{ insertError: true }, { insertErrorAfterAdd: true }]) {
    const { state } = replacementHost(options);
    const original = state.pictures[0];
    assert.throws(() => replacePicture(asset, captureReplacementTarget()), error => {
      assert.equal(error.replaced, false);
      assert.equal(error.resultUncertain, true);
      assert.match(error.message, /原图尚未删除.*不要重复替换/);
      return true;
    });
    assert.equal(original.deleted, false);
    assert.equal(state.calls.some(call => call.delete), false);
    assert.equal(state.pictures.length, options.insertError ? 1 : 2);
    assert.equal(state.undoEnded, 1);
  }
});

test('替换完成后光标或撤销收尾失败仍报告 replaced，不让用户重复替换', () => {
  for (const options of [{ selectError: true }, { undoEndError: true }]) {
    const { state } = replacementHost(options);
    assert.throws(() => replacePicture(asset, captureReplacementTarget()), error => {
      assert.equal(error.inserted, true);
      assert.equal(error.replaced, true);
      assert.equal(error.resultUncertain, false);
      assert.match(error.message, /图片已替换.*不要重复替换/);
      return true;
    });
    assert.equal(state.pictures.length, 1);
    assert.equal(state.pictures[0].original, false);
    assert.equal(state.text, '前文\uFFFC后文\r');
    assert.equal(state.undoEnded, 1);
  }
});

test('Ribbon 重复打开复用任务窗格，关闭后可以再次显示', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const storage = new Map();
  const pane = { ID: 7, Visible: false };
  let created = 0;
  const app = {
    PluginStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    CreateTaskPane(url) {
      assert.equal(url, 'http://127.0.0.1:39831/taskpane.html');
      created++;
      return pane;
    },
    GetTaskPane(id) { assert.equal(id, 7); return pane; },
  };
  const context = vm.createContext({ URL, window: { Application: app, location: { href: 'http://127.0.0.1:39831/index.html' } } });
  vm.runInContext(source, context);
  assert.equal(context.OnAddinLoad(), true);
  context.OpenImageLibrary();
  pane.Visible = false;
  context.OpenImageLibrary();
  assert.equal(created, 1);
  assert.equal(pane.Visible, true);
  assert.equal(pane.DockPosition, 2);
});

test('注册与重复卸载只还原本次插件，保留旧注册和其他插件后续变化', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ipeitu-wps-registration-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true });
  });
  const publishPath = path.join(directory, 'publish.xml');
  await writeFile(publishPath, '<jsplugins><!--keep--><jspluginonline name="other" url="https://example.test/old" /><jspluginonline name="iPeiTu" url="http://127.0.0.1:9999/" enable="disable" /></jsplugins>');
  function run(script, config = directory) {
    const scriptPath = fileURLToPath(new URL(`../scripts/${script}-wps.ps1`, import.meta.url));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ConfigDirectory', config], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
  const unregistered = await readFile(publishPath, 'utf8');
  run('uninstall');
  assert.equal(await readFile(publishPath, 'utf8'), unregistered, '没有本次安装记录时不得删除已有条目');
  run('install');
  run('install');
  let content = await readFile(publishPath, 'utf8');
  assert.equal((content.match(/name="iPeiTu"/g) || []).length, 1);
  assert.match(content, /enable="enable_dev"/);
  assert.match(content, /url="http:\/\/127\.0\.0\.1:39831\/"/);
  content = content.replace('https://example.test/old', 'https://example.test/new');
  await writeFile(publishPath, content);
  run('uninstall');
  content = await readFile(publishPath, 'utf8');
  assert.match(content, /https:\/\/example\.test\/new/);
  assert.match(content, /http:\/\/127\.0\.0\.1:9999\//);
  assert.match(content, /enable="disable"/);
  assert.match(content, /<!--keep-->/);
  run('uninstall');
  assert.equal(await readFile(publishPath, 'utf8'), content, '连续两次卸载必须保留已恢复的旧注册');

  const fresh = path.join(directory, 'fresh');
  run('install', fresh);
  run('install', fresh);
  run('uninstall', fresh);
  assert.doesNotMatch(await readFile(path.join(fresh, 'publish.xml'), 'utf8'), /name="iPeiTu"/);
});

const boxImage = { path: 'C:\图库\placeholders\box.png' };
const box = (overrides = {}) => ({ name: '脚手架搭设', size: 'fixed', widthCm: 12, heightCm: 9, ...overrides });

test('占位框标记带版本，可往返解析，非标记和损坏内容不被当作框', () => {
  assert.deepEqual(parsePlaceholderMarker(placeholderMarker('含"引号\与斜杠')), { name: '含"引号\与斜杠' });
  for (const text of [undefined, '', '普通图片说明', 'iPeiTu-box:1:{broken', 'iPeiTu-box:1:[]', 'iPeiTu-box:1:{"name":""}', 'iPeiTu-box:2:{"name":"a"}']) {
    assert.equal(parsePlaceholderMarker(text), null, String(text));
  }
});

test('占位框尺寸：固定厘米、整行 4:3、超出版面时等比缩小', () => {
  createHost();
  const size = target => [target.widthPt, target.heightPt];
  assert.deepEqual(size(capturePlaceholderTarget(box())), [340.1, 255.1]);
  assert.deepEqual(size(capturePlaceholderTarget(box({ size: 'line' }))), [480, 360]);
  assert.deepEqual(size(capturePlaceholderTarget(box({ widthCm: 30, heightCm: 20 }))), [480, 320], '超宽按页面内宽等比缩小');
  assert.deepEqual(size(capturePlaceholderTarget(box({ widthCm: 10, heightCm: 40 }))), [164, 656], '超高按版面高度等比缩小');
});

test('填满单元格取单元格内部宽高，自动行高按 4:3，表格外明确拒绝', () => {
  createHost({ inTable: true });
  const cell = capturePlaceholderTarget(box({ size: 'cell' }));
  assert.deepEqual([cell.widthPt, cell.heightPt], [200, 170]);
  createHost({ inTable: true, cell: { HeightRule: 0 } });
  const auto = capturePlaceholderTarget(box({ size: 'cell' }));
  assert.deepEqual([auto.widthPt, auto.heightPt], [200, 150]);
  createHost();
  assert.throws(() => capturePlaceholderTarget(box({ size: 'cell' })), /不在表格单元格内/);
});

test('无效框名或尺寸在读取和写入文档前拒绝', () => {
  const { state } = createHost();
  for (const input of [null, {}, box({ name: '  ' }), box({ name: '换\n行' }), box({ name: '框'.repeat(101) }), box({ size: 'huge' }),
    box({ widthCm: 0.4 }), box({ heightCm: 50.1 }), box({ widthCm: '12' }), box({ heightCm: NaN })]) {
    assert.throws(() => capturePlaceholderTarget(input));
  }
  assert.equal(state.calls.length, 0);
  assert.equal(state.undoStarted, 0);
});

test('正文中间插入占位框：独立成段、单倍行距、尺寸准确并写入标记，前后文字和样式保留', () => {
  const { state } = createHost({ text: '前文后文\r', start: 2, end: 2 });
  const result = insertPlaceholder(boxImage, capturePlaceholderTarget(box()));
  assert.equal(state.text, '前文\r\uFFFC\r后文\r');
  assert.deepEqual(state.calls, [{ path: boxImage.path, link: false, save: true, start: 2, end: 2 }]);
  const [picture] = state.pictures;
  assert.equal(picture.Width, 340.1);
  assert.equal(picture.Height, 255.1);
  assert.equal(picture.LockAspectRatio, -1);
  assert.deepEqual(parsePlaceholderMarker(picture.altText), { name: '脚手架搭设' });
  assert.deepEqual(result, { name: '脚手架搭设', widthPt: 340.1, heightPt: 255.1 });
  const boxFormat = state.paragraphs[1].format;
  assert.deepEqual([boxFormat.Alignment, boxFormat.LineSpacingRule, boxFormat.SpaceBefore, boxFormat.SpaceAfter], [1, 0, 0, 0]);
  for (const index of [0, 2]) {
    assert.equal(state.paragraphs[index].style, '标书正文');
    assert.equal(state.paragraphs[index].format.LineSpacingRule, 4, '相邻正文保留固定行距');
  }
  assert.ok(state.text.slice(state.start).startsWith('后文'), '光标移到框后的正文');
  assert.deepEqual([state.undoStarted, state.undoEnded], [1, 1]);
  assert.deepEqual(scanPlaceholders().boxes.map(item => item.name), ['脚手架搭设']);
});

test('空单元格直接作为框所在段落，不多拆一段撑高表格行', () => {
  const { state } = createHost({ text: '\r\u0007', start: 0, end: 0, inTable: true });
  insertPlaceholder(boxImage, capturePlaceholderTarget(box({ size: 'cell' })));
  assert.equal(state.text, '\uFFFC\r\u0007');
  assert.equal(state.paragraphs.length, 1);
  assert.deepEqual([state.pictures[0].Width, state.pictures[0].Height], [200, 170]);
  const format = state.paragraphs[0].format;
  assert.deepEqual([format.Alignment, format.LineSpacingRule, format.SpaceBefore, format.SpaceAfter, format.FirstLineIndent], [1, 0, 0, 0, 0]);
  assert.equal(state.start, 1);
});

test('WPS 未保存标记时移除新图并如实报告，不留下无法识别的框', () => {
  const { state } = createHost({ text: '前文后文\r', start: 2, end: 2, altTextDropped: true });
  assert.throws(() => insertPlaceholder(boxImage, capturePlaceholderTarget(box())), error => {
    assert.match(error.message, /未插入.*已移除.*未能保存占位框标记/);
    assert.equal(error.inserted, false);
    return true;
  });
  assert.equal(state.text, '前文后文\r');
  assert.equal(state.pictures.length, 0);
  assert.deepEqual([state.undoStarted, state.undoEnded], [1, 1]);
});

test('等待占位图期间光标或文档变化时在写入前中止；无效路径与目标不交给 WPS', () => {
  let { state } = createHost({ text: '前文后文\r', start: 2, end: 2 });
  const target = capturePlaceholderTarget(box());
  state.start = state.end = 3;
  assert.throws(() => insertPlaceholder(boxImage, target), /已改变/);
  ({ state } = createHost({ text: '前文后文\r', start: 2, end: 2 }));
  const captured = capturePlaceholderTarget(box());
  globalThis.Application.ActiveDocument.FullName = 'C:\其他\标书.docx';
  assert.throws(() => insertPlaceholder(boxImage, captured), /已改变/);
  for (const image of [null, { path: 'box.png' }, { path: 'https://example.com/box.png' }]) {
    assert.throws(() => insertPlaceholder(image, captured), /路径无效/);
  }
  assert.throws(() => insertPlaceholder(boxImage, { ...captured, name: '' }), /目标无效/);
  assert.throws(() => insertPlaceholder(boxImage, { ...captured, widthPt: 5 }), /目标无效/);
  assert.equal(state.calls.length, 0);
});

test('扫描只列出带有效标记的框，读不出替代文字的对象单独计数，只读文档也能扫描', () => {
  const { state } = createHost({
    text: '甲\uFFFC乙\uFFFC丙\uFFFC丁\uFFFC\r', document: { ReadOnly: true },
    originalPictures: [{ position: 1 }, { position: 3 }, { position: 5 }, { position: 7 }],
  });
  state.pictures[0].altText = placeholderMarker('甲框');
  state.pictures[1].altText = '普通图片说明';
  state.pictures[2].altText = 'iPeiTu-box:1:{broken';
  Object.defineProperty(state.pictures[3], 'AlternativeText', { get() { throw new Error('OLE 对象不支持'); } });
  assert.deepEqual(scanPlaceholders(), {
    document: 'C:\文档\标书.docx', unreadable: 1,
    boxes: [{ index: 1, name: '甲框', start: 1, widthPt: 240, heightPt: 120 }],
  });
});

test('定位选中对应的框；框移动、标记变化或切换文档时要求重新扫描', () => {
  const { app, state } = createHost({ text: '甲\uFFFC乙\r', originalPictures: [{ position: 1 }] });
  state.pictures[0].altText = placeholderMarker('甲框');
  let scan = scanPlaceholders();
  selectPlaceholder(scan, scan.boxes[0]);
  assert.deepEqual([state.start, state.end], [1, 2]);
  const stale = error => error.stale === true && /重新扫描/.test(error.message);
  state.pictures[0].position = 2;
  assert.throws(() => selectPlaceholder(scan, scan.boxes[0]), stale);
  scan = scanPlaceholders();
  state.pictures[0].altText = placeholderMarker('改名');
  assert.throws(() => selectPlaceholder(scan, scan.boxes[0]), stale);
  scan = scanPlaceholders();
  app.ActiveDocument.FullName = 'C:\其他.docx';
  assert.throws(() => selectPlaceholder(scan, scan.boxes[0]), stale);
  assert.throws(() => selectPlaceholder(scan, { ...scan.boxes[0], index: 9 }), stale);
});
