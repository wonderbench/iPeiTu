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
  getFillStatus, captureFillTarget, fillPlaceholder,
  selectNextEmptyPlaceholder, clearPlaceholderMarkers, findTextMarkers, captureTextMarkerTargets, convertTextMarkers,
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
  // options.textColumns：{ Count, Spacing, widths: [...] }，或 Error 表示读取 TextColumns 时抛错；缺省时不提供该属性。
  if (options.textColumns) {
    Object.defineProperty(page, 'TextColumns', {
      get() {
        if (options.textColumns instanceof Error) throw options.textColumns;
        const { Count, Spacing, widths = [] } = options.textColumns;
        return { Count, Spacing, Item: index => ({ get Width() { return widths[index - 1]; } }) };
      },
    });
  }
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
        // quantize(值, 'Width' | 'Height') 模拟 WPS 对写入宽高的取整或按分辨率量化；仅作用于新图。
        const quantize = this.original || !options.quantize ? (number => number) : options.quantize;
        if (this.LockAspectRatio === -1 && !options.ignoreAspectRatio) height = quantize(height * (value / width), 'Height');
        width = quantize(value, 'Width');
      },
      get Height() { return height; },
      set Height(value) {
        const quantize = this.original || !options.quantize ? (number => number) : options.quantize;
        if (this.LockAspectRatio === -1 && !options.ignoreAspectRatio) width = quantize(width * (value / height), 'Width');
        height = quantize(value, 'Height');
      },
      altText: '',
      get AlternativeText() { return options.altTextDropped || (options.newAltTextDropped && !this.original) ? '' : this.altText; },
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
      Delete() {
        const length = this.end - this.start;
        assert.ok(!state.text.slice(this.start, this.end).includes('\r'), '只删除段落内的文字');
        state.text = state.text.slice(0, this.start) + state.text.slice(this.end);
        for (const picture of state.pictures) if (picture.position >= this.end) picture.position -= length;
        this.end = this.start;
      },
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
  Object.defineProperty(app.ActiveDocument, 'Content', {
    get() {
      state.contentReads = (state.contentReads ?? 0) + 1;
      return {
        get Text() { return state.text; },
        Paragraphs: {
          get Count() { return state.text.split('\r').length - 1; },
          Item(index) {
            let at = 0;
            for (let current = 1; current < index; current++) at = state.text.indexOf('\r', at) + 1;
            return paragraphAt(at);
          },
        },
      };
    },
  });
  app.ActiveDocument.Range = (start, end) => rangeAt(start, end);
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
  // 新窗格由 WPS 给出默认宽度；素材库显示后补足到 560。
  const pane = { ID: 7, Visible: false, Width: 300 };
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
  assert.equal(pane.Width, 560);
  pane.Visible = false;
  pane.Width = 700;
  context.OpenImageLibrary();
  assert.equal(created, 1);
  assert.equal(pane.Visible, true);
  assert.equal(pane.DockPosition, 2);
  assert.equal(pane.Width, 700, '保留手动拉宽的尺寸');
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

const boxImage = { path: 'C:\\图库\\placeholders\\box.png' };
const box = (overrides = {}) => ({ name: '脚手架搭设', size: 'fixed', widthCm: 12, heightCm: 9, ...overrides });

test('占位框标记带版本，可往返解析，非标记和损坏内容不被当作框', () => {
  assert.deepEqual(parsePlaceholderMarker(placeholderMarker('含"引号\\与斜杠')), { name: '含"引号\\与斜杠' });
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
  const paragraphsBefore = state.paragraphs.length;
  insertPlaceholder(boxImage, capturePlaceholderTarget(box({ size: 'cell' })));
  assert.equal(state.text, '\uFFFC\r\u0007');
  assert.equal(state.paragraphs.length, paragraphsBefore, '没有新增段落');
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
  globalThis.Application.ActiveDocument.FullName = 'C:\\其他\\标书.docx';
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
    document: 'C:\\文档\\标书.docx', unreadable: 1,
    boxes: [{ index: 1, name: '甲框', start: 1, widthPt: 240, heightPt: 120, filled: false }],
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
  app.ActiveDocument.FullName = 'C:\\其他.docx';
  assert.throws(() => selectPlaceholder(scan, scan.boxes[0]), stale);
  assert.throws(() => selectPlaceholder(scan, { ...scan.boxes[0], index: 9 }), stale);
});

const fittedImage = { path: 'C:\\图库\\fitted\\沟槽.jpg', name: '沟槽.jpg' };
const assetId = 'a'.repeat(64);
function boxHost(options = {}) {
  const host = createHost({ text: '前文\uFFFC后文\r', start: 2, end: 3, originalPictures: [{ position: 2, width: 300, height: 200 }], ...options });
  host.state.pictures[0].altText = placeholderMarker('脚手架搭设');
  return host;
}

test('已填标记记录素材与适配方式，无效的已填信息仍按未填框识别', () => {
  assert.deepEqual(parsePlaceholderMarker(placeholderMarker('框', { asset: assetId, fit: 'contain' })), { name: '框', asset: assetId, fit: 'contain' });
  assert.deepEqual(parsePlaceholderMarker('iPeiTu-box:1:{"name":"框","asset":"短","fit":"cover"}'), { name: '框' });
  assert.deepEqual(parsePlaceholderMarker(`iPeiTu-box:1:{"name":"框","asset":"${assetId}","fit":"stretch"}`), { name: '框' });
});

test('只有完整选中一个占位框时才可填入，普通图片和浏览器不可填入', () => {
  assert.equal(getFillStatus().available, false);
  createHost({ text: '前文\uFFFC后文\r', start: 2, end: 3, originalPictures: [{ position: 2 }] });
  assert.equal(getFillStatus().available, false);
  assert.throws(() => captureFillTarget(), /不是占位框/);
  boxHost();
  assert.deepEqual(getFillStatus(), { available: true, name: '脚手架搭设', widthPt: 300, heightPt: 200 });
  boxHost({ document: { ReadOnly: true } });
  assert.equal(getFillStatus().available, false, '只读文档不可填入');
});

test('填入按框的宽高精确设定新图，保留字体并写入已填标记，只删除原框', () => {
  const { state } = boxHost();
  const originalFont = { ...state.pictures[0].font };
  const result = fillPlaceholder(fittedImage, captureFillTarget(), { asset: assetId, fit: 'cover' });
  assert.equal(state.text, '前文\uFFFC后文\r');
  assert.equal(state.pictures.length, 1);
  const [picture] = state.pictures;
  assert.equal(picture.original, false);
  assert.deepEqual([picture.Width, picture.Height, picture.LockAspectRatio], [300, 200, -1]);
  assert.deepEqual(parsePlaceholderMarker(picture.altText), { name: '脚手架搭设', asset: assetId, fit: 'cover' });
  assert.deepEqual(picture.font, originalFont);
  assert.deepEqual(result, { name: '脚手架搭设', asset: '沟槽.jpg', widthPt: 300, heightPt: 200 });
  assert.deepEqual(state.calls.filter(call => call.delete).map(call => call.delete), ['original']);
  assert.deepEqual([state.start, state.end], [3, 3], '光标移到新图之后');
  assert.deepEqual([state.undoStarted, state.undoEnded], [1, 1]);
  assert.equal(scanPlaceholders().boxes[0].filled, true);
});

test('已填的框可以再次换图，框名和尺寸不变', () => {
  const { state } = boxHost();
  fillPlaceholder(fittedImage, captureFillTarget(), { asset: assetId, fit: 'cover' });
  state.start = 2;
  state.end = 3;
  assert.equal(getFillStatus().available, true);
  fillPlaceholder({ ...fittedImage, path: 'C:\\图库\\fitted\\另一张.png' }, captureFillTarget(), { asset: 'b'.repeat(64), fit: 'contain' });
  assert.equal(state.pictures.length, 1);
  assert.deepEqual([state.pictures[0].Width, state.pictures[0].Height], [300, 200]);
  assert.deepEqual(parsePlaceholderMarker(state.pictures[0].altText), { name: '脚手架搭设', asset: 'b'.repeat(64), fit: 'contain' });
});

test('新图标记未保存时移除新图并保留原框', () => {
  const { state } = boxHost({ newAltTextDropped: true });
  assert.throws(() => fillPlaceholder(fittedImage, captureFillTarget(), { asset: assetId, fit: 'fill' }), error => {
    assert.match(error.message, /填入未完成，占位框已保留，新增图片已移除.*未能保存占位框标记/);
    assert.deepEqual([error.inserted, error.filled, error.resultUncertain], [false, false, false]);
    return true;
  });
  assert.equal(state.text, '前文\uFFFC后文\r');
  assert.equal(state.pictures.length, 1);
  assert.equal(state.pictures[0].original, true);
  assert.deepEqual(parsePlaceholderMarker(state.pictures[0].altText), { name: '脚手架搭设' });
});

test('等待适配图期间选区、框名变化或目标重复使用时在写入前中止', () => {
  let { state } = boxHost();
  let target = captureFillTarget();
  state.start = state.end = 2;
  assert.throws(() => fillPlaceholder(fittedImage, target, { asset: assetId, fit: 'cover' }), /填入已中止/);
  ({ state } = boxHost());
  target = captureFillTarget();
  state.pictures[0].altText = placeholderMarker('另一个框');
  assert.throws(() => fillPlaceholder(fittedImage, target, { asset: assetId, fit: 'cover' }), /已改变/);
  ({ state } = boxHost());
  target = captureFillTarget();
  for (const [image, filled] of [[{ path: 'box.jpg' }, { asset: assetId, fit: 'cover' }], [fittedImage, { asset: 'x', fit: 'cover' }], [fittedImage, { asset: assetId, fit: 'stretch' }]]) {
    assert.throws(() => fillPlaceholder(image, target, filled), /填入已中止/);
  }
  fillPlaceholder(fittedImage, target, { asset: assetId, fit: 'cover' });
  state.start = 2;
  state.end = 3;
  assert.throws(() => fillPlaceholder(fittedImage, target, { asset: assetId, fit: 'cover' }), /目标已失效/);
  assert.equal(state.calls.filter(call => call.path).length, 1, '中止的填入都没有调用 AddPicture');
});

// 三个框：甲已填，乙、丙未填；另有一张普通图片。
function boxesHost(options = {}) {
  const host = createHost({
    text: '甲\uFFFC乙\uFFFC丙\uFFFC丁\uFFFC\r', start: 0, end: 0,
    originalPictures: [{ position: 1 }, { position: 3 }, { position: 5 }, { position: 7 }], ...options,
  });
  const [first, second, third] = host.state.pictures;
  first.altText = placeholderMarker('甲框', { asset: assetId, fit: 'cover' });
  second.altText = placeholderMarker('乙框');
  third.altText = placeholderMarker('丙框');
  return host;
}

test('填入后定位下一个空框：先找后面的，没有时从文档开头找，全部填完返回 null', () => {
  const { state } = boxesHost();
  assert.equal(selectNextEmptyPlaceholder(1).name, '乙框');
  assert.deepEqual([state.start, state.end], [3, 4]);
  assert.equal(selectNextEmptyPlaceholder(3).name, '丙框');
  assert.equal(selectNextEmptyPlaceholder(5).name, '乙框', '后面没有空框时回到文档开头');
  state.pictures[1].altText = placeholderMarker('乙框', { asset: assetId, fit: 'fill' });
  state.pictures[2].altText = placeholderMarker('丙框', { asset: assetId, fit: 'fill' });
  assert.equal(selectNextEmptyPlaceholder(5), null);
});

test('清除标记只清已填框，未填框和普通图片不动，一次撤销', () => {
  let { state } = boxesHost();
  state.pictures[3].altText = '普通图片说明';
  assert.deepEqual(clearPlaceholderMarkers(), { cleared: 1, unfilled: 2 });
  assert.deepEqual(state.pictures.map(picture => picture.altText), ['', placeholderMarker('乙框'), placeholderMarker('丙框'), '普通图片说明']);
  assert.deepEqual([state.undoStarted, state.undoEnded], [1, 1]);
  assert.deepEqual(clearPlaceholderMarkers(), { cleared: 0, unfilled: 2 }, '没有已填框时不写入');
  assert.equal(state.undoStarted, 1);
  ({ state } = boxesHost({ document: { ReadOnly: true } }));
  assert.throws(() => clearPlaceholderMarkers(), /只读/);
  ({ state } = boxesHost({ altTextDropped: false }));
  Object.defineProperty(state.pictures[0], 'AlternativeText', { get() { return this.altText; }, set() { /* 宿主忽略写入 */ } });
  assert.throws(() => clearPlaceholderMarkers(), /已清除 0 个标记后中止（WPS 未能清除标记）/);
  assert.deepEqual([state.undoStarted, state.undoEnded], [1, 1]);
});

const markerText = '前文\r【图：基础施工】\r说明【图: 模板 】结尾\r图片【普通】\r';

test('查找文字标记：支持全角或半角冒号，记录位置与原文，普通括号不算', () => {
  createHost({ text: markerText, start: 0, end: 0 });
  assert.deepEqual(findTextMarkers(), {
    document: 'C:\\文档\\标书.docx', skipped: 0,
    markers: [
      { name: '基础施工', start: 3, end: 11, text: '【图：基础施工】' },
      { name: '模板', start: 14, end: 22, text: '【图: 模板 】' },
    ],
  });
  createHost({ text: '没有标记\r', start: 0, end: 0 });
  assert.deepEqual(findTextMarkers().markers, []);
});

test('文字标记按所选尺寸转为占位框：独占一段的直接放入，段中的拆成独立段落，一次撤销', () => {
  const { state } = createHost({ text: markerText, start: 0, end: 0 });
  const captured = captureTextMarkerTargets(findTextMarkers(), { size: 'fixed', widthCm: 6, heightCm: 4 });
  assert.deepEqual(captured.targets.map(target => [target.name, target.widthPt, target.heightPt]), [['基础施工', 170, 113.3], ['模板', 170, 113.3]]);
  const images = [{ path: 'C:\\图库\\placeholders\\a.png' }, { path: 'C:\\图库\\placeholders\\b.png' }];
  assert.deepEqual(convertTextMarkers(captured, images), { converted: 2 });
  assert.equal(state.text, '前文\r\uFFFC\r说明\r\uFFFC\r结尾\r图片【普通】\r');
  const ordered = [...state.pictures].sort((a, b) => a.position - b.position);
  assert.deepEqual(ordered.map(picture => parsePlaceholderMarker(picture.altText).name), ['基础施工', '模板']);
  assert.deepEqual(ordered.map(picture => [picture.Width, picture.Height]), [[170, 113.3], [170, 113.3]]);
  assert.deepEqual(state.calls.filter(call => call.path).map(call => call.path), [images[1].path, images[0].path], '从后往前处理');
  assert.deepEqual([state.undoStarted, state.undoEnded], [1, 1]);
});

test('文字标记转换：文档变化、尺寸无法放置或路径无效时在写入前整体中止', () => {
  let { state } = createHost({ text: markerText, start: 0, end: 0 });
  let captured = captureTextMarkerTargets(findTextMarkers(), { size: 'fixed', widthCm: 6, heightCm: 4 });
  state.text = `新增${state.text}`;
  assert.throws(() => convertTextMarkers(captured, [{ path: 'C:\\a.png' }, { path: 'C:\\b.png' }]), /文档已变化/);
  assert.throws(() => captureTextMarkerTargets(findTextMarkers(), { size: 'cell' }), /「【图：基础施工】」处无法放置占位框：光标不在表格单元格内/);
  ({ state } = createHost({ text: markerText, start: 0, end: 0 }));
  captured = captureTextMarkerTargets(findTextMarkers(), { size: 'line' });
  assert.throws(() => convertTextMarkers(captured, [{ path: 'C:\\a.png' }]), /路径无效/);
  assert.throws(() => convertTextMarkers(captured, [{ path: 'a.png' }, { path: 'C:\\b.png' }]), /路径无效/);
  assert.equal(state.calls.length, 0);
  assert.equal(state.undoStarted, 0);
});

test('文字标记转换中途失败时移除未完成的框，说明已转换数量并提示撤销', () => {
  const { state } = createHost({ text: markerText, start: 0, end: 0, altTextDropped: true });
  const captured = captureTextMarkerTargets(findTextMarkers(), { size: 'fixed', widthCm: 6, heightCm: 4 });
  assert.throws(() => convertTextMarkers(captured, [{ path: 'C:\\a.png' }, { path: 'C:\\b.png' }]), error => {
    assert.equal(error.converted, 0);
    assert.match(error.message, /已转换 0 个标记后中止（WPS 未能保存占位框标记）。请检查文档，需要时撤销一次恢复/);
    return true;
  });
  assert.equal(state.pictures.length, 0, '未写入标记的占位图已移除');
  assert.deepEqual([state.undoStarted, state.undoEnded], [1, 1]);
});

// 以下用例按真实 WPS 12.1.0.29690 的实测行为模拟尺寸量化（模拟测试，不是实机验收）。
test('占位框：WPS 把宽高截去小数后回读为整数磅时仍视为成功', () => {
  const { state } = createHost({ text: '前文后文\r', start: 2, end: 2, quantize: value => Math.trunc(value) });
  const target = { ...capturePlaceholderTarget(box()), widthPt: 255.7, heightPt: 340.7 };
  const result = insertPlaceholder(boxImage, target);
  assert.deepEqual(result, { name: '脚手架搭设', widthPt: 255, heightPt: 340 });
  assert.equal(state.pictures.length, 1);
  assert.deepEqual(parsePlaceholderMarker(state.pictures[0].altText), { name: '脚手架搭设' });
  assert.equal(state.text, '前文\r\uFFFC\r后文\r');
});

test('占位框：回读偏差超出容差时报错带读数，且不留下无标记的图', () => {
  const { state } = createHost({ text: '前文后文\r', start: 2, end: 2, quantize: value => value - 1 });
  const target = { ...capturePlaceholderTarget(box()), widthPt: 255.7, heightPt: 340.7 };
  assert.throws(() => insertPlaceholder(boxImage, target), error => {
    assert.match(error.message, /WPS 未能按框的尺寸设置占位图（预期 255\.70 × 340\.70 磅，实测 254\.70 × 339\.70 磅）/);
    assert.match(error.message, /未插入.*已移除/);
    assert.equal(error.inserted, false);
    return true;
  });
  assert.equal(state.pictures.length, 0);
  assert.equal(state.text, '前文后文\r');
  assert.deepEqual([state.undoStarted, state.undoEnded], [1, 1]);
});

test('填入：量化造成不足 1 磅的偏差仍成功', () => {
  const { state } = boxHost({ quantize: value => value - 0.4 });
  const result = fillPlaceholder(fittedImage, captureFillTarget(), { asset: assetId, fit: 'cover' });
  assert.ok(Math.abs(result.widthPt - 299.6) < 1e-9 && Math.abs(result.heightPt - 199.6) < 1e-9);
  assert.equal(state.pictures.length, 1);
  assert.equal(state.pictures[0].original, false);
  assert.deepEqual(parsePlaceholderMarker(state.pictures[0].altText), { name: '脚手架搭设', asset: assetId, fit: 'cover' });
  assert.deepEqual(state.calls.filter(call => call.delete).map(call => call.delete), ['original']);
});

test('填入：偏差达到或超过 1 磅时失败，移除新图并保留原框', () => {
  for (const [offset, readback] of [[1, '299.00 × 199.00'], [1.5, '298.50 × 198.50']]) {
    const { state } = boxHost({ quantize: value => value - offset });
    const original = state.pictures[0];
    assert.throws(() => fillPlaceholder(fittedImage, captureFillTarget(), { asset: assetId, fit: 'cover' }), error => {
      assert.match(error.message, /填入未完成，占位框已保留，新增图片已移除/);
      assert.ok(error.message.includes(`WPS 未能按占位框尺寸设置图片（预期 300.00 × 200.00 磅，实测 ${readback} 磅）`), error.message);
      assert.deepEqual([error.inserted, error.filled, error.resultUncertain], [false, false, false]);
      return true;
    });
    assert.equal(state.pictures.length, 1);
    assert.equal(state.pictures[0], original);
    assert.equal(original.deleted, false);
    assert.equal(state.text, '前文\uFFFC后文\r');
    assert.deepEqual(parsePlaceholderMarker(original.altText), { name: '脚手架搭设' });
    assert.deepEqual(state.calls.filter(call => call.delete).map(call => call.delete), ['new']);
  }
});

test('换图：宽度偏差 1 磅以内且高度在容差内时成功', () => {
  // 新图原始尺寸 800 × 450；宽度回读 239.5，高度回读 135.5（期望 134.72，偏差小于 1.34 磅）。
  const quantize = (value, kind) => (kind === 'Width' ? value - 0.5 : value + 0.5);
  const { state } = replacementHost({ quantize });
  const original = state.pictures[0];
  const result = replacePicture(asset, captureReplacementTarget());
  assert.equal(result.replaced, true);
  assert.ok(Math.abs(result.width - 239.5) < 1e-9 && Math.abs(result.height - 135.5) < 1e-9);
  assert.equal(original.deleted, true);
  assert.equal(state.pictures.length, 1);
  assert.equal(state.pictures[0].original, false);
});

test('换图：宽度偏差超过 1 磅时中止并保留原图，报错带读数', () => {
  const { state } = replacementHost({ quantize: (value, kind) => (kind === 'Width' ? value - 1.5 : value) });
  const original = state.pictures[0];
  assert.throws(() => replacePicture(asset, captureReplacementTarget()), error => {
    assert.match(error.message, /WPS 未能按原宽度等比例调整新图片（预期 240\.00 × [\d.]+ 磅，实测 238\.50 × [\d.]+ 磅）/);
    assert.match(error.message, /原图已保留，新增图片已移除/);
    assert.equal(error.replaced, false);
    return true;
  });
  assert.equal(state.pictures.length, 1);
  assert.equal(state.pictures[0], original);
  assert.equal(original.deleted, false);
  assert.equal(state.text, '前文\uFFFC后文\r');
});

test('换图：高度偏差超出容差时中止并保留原图', () => {
  const { state } = replacementHost({ quantize: (value, kind) => (kind === 'Height' ? value + 3 : value) });
  const original = state.pictures[0];
  assert.throws(() => replacePicture(asset, captureReplacementTarget()), error => {
    assert.match(error.message, /WPS 未能按原宽度等比例调整新图片（预期 240\.00 × 135\.00 磅，实测 240\.00 × 138\.00 磅）/);
    assert.equal(error.replaced, false);
    assert.equal(error.resultUncertain, false);
    return true;
  });
  assert.equal(state.pictures.length, 1);
  assert.equal(state.pictures[0], original);
  assert.equal(original.deleted, false);
});

test('分栏：自适应插图不超过栏宽，各栏宽度不等时取最小栏宽', () => {
  createHost({ textColumns: { Count: 2, Spacing: 20, widths: [220, 220] } });
  assert.equal(insertPicture(asset).width, 220);
  createHost({ textColumns: { Count: 3, Spacing: 20, widths: [230, 150, 180] } });
  assert.equal(insertPicture(asset).width, 150, '光标所在栏未知，取最小栏宽');
  createHost({ textColumns: { Count: 1, Spacing: 20, widths: [100] } });
  assert.equal(insertPicture(asset).width, 480, '一栏按版心宽度');
});

test('分栏：逐栏宽度读不到有效数值时按等宽估算，栏间距读不到按 0 计', () => {
  createHost({ textColumns: { Count: 2, Spacing: 20, widths: [] } });
  assert.equal(insertPicture(asset).width, 230, '(480 - 20) / 2');
  createHost({ textColumns: { Count: 3, Spacing: 30, widths: [200, 9999999, 200] } });
  assert.equal(insertPicture(asset).width, 140, '(480 - 60) / 3，不确定宽度不参与取小');
  createHost({ textColumns: { Count: 2, widths: [0, 200] } });
  assert.equal(insertPicture(asset).width, 240, '栏间距缺失按 0 计');
});

test('读取 TextColumns 抛错或栏数无效时按一栏处理', () => {
  createHost({ textColumns: new Error('TextColumns unavailable') });
  assert.equal(insertPicture(asset).width, 480);
  for (const Count of [0, -2, 2.5, undefined, '2']) {
    createHost({ textColumns: { Count, Spacing: 20, widths: [100, 100] } });
    assert.equal(insertPicture(asset).width, 480, String(Count));
  }
});

test('分栏：整行宽占位框取栏宽', () => {
  createHost({ textColumns: { Count: 2, Spacing: 20, widths: [200, 220] } });
  const line = capturePlaceholderTarget(box({ size: 'line' }));
  assert.deepEqual([line.widthPt, line.heightPt], [200, 150]);
  const fixed = capturePlaceholderTarget(box({ widthCm: 30, heightCm: 20 }));
  assert.deepEqual([fixed.widthPt, fixed.heightPt], [200, 133.3], '固定尺寸超出栏宽时等比缩小');
});

test('合并单元格（宽度 9999999）下自适应插图中止，文档不变并给出明确提示', () => {
  const { state } = createHost({ inTable: true, cell: { Width: 9999999 } });
  const before = state.text;
  assert.throws(() => insertPicture(asset), /无法读取当前单元格的宽度（常见于合并单元格），请在排版设置中改用固定宽度后重试/);
  assert.equal(state.text, before);
  assert.equal(state.calls.length, 0);
  assert.equal(state.pictures.length, 0);
  assert.deepEqual([state.undoStarted, state.undoEnded], [0, 0]);
});

test('合并单元格下固定宽度插图按指定宽度插入，上限为版心宽度', () => {
  createHost({ inTable: true, cell: { Width: 9999999 }, pictureWidth: 120, pictureHeight: 60 });
  const fixed = insertPicture(asset, undefined, { widthMode: 'fixed', widthCm: 8 });
  assert.ok(Math.abs(fixed.width - 8 * 72 / 2.54) < 1e-8);
  createHost({ inTable: true, cell: { Width: 9999999 }, pictureWidth: 120, pictureHeight: 60 });
  assert.equal(insertPicture(asset, undefined, { widthMode: 'fixed', widthCm: 20 }).width, 480);
});

test('合并单元格下占位框选整行宽或填满单元格时中止，固定尺寸照常放置', () => {
  const { state } = createHost({ inTable: true, cell: { Width: 9999999 } });
  for (const size of ['line', 'cell']) {
    assert.throws(() => capturePlaceholderTarget(box({ size })), /无法放置占位框：无法读取当前单元格的宽度（常见于合并单元格），请改选固定尺寸/);
  }
  assert.equal(state.calls.length, 0);
  const fixed = capturePlaceholderTarget(box());
  assert.deepEqual([fixed.widthPt, fixed.heightPt], [340.1, 255.1]);
  const wide = capturePlaceholderTarget(box({ widthCm: 30, heightCm: 20 }));
  assert.deepEqual([wide.widthPt, wide.heightPt], [480, 320], '上限为版心宽度');
});

test('单元格高度不确定（9999999）时填满单元格按 4:3 取高，不缩放', () => {
  createHost({ inTable: true, cell: { Height: 9999999, HeightRule: 1 } });
  const target = capturePlaceholderTarget(box({ size: 'cell' }));
  assert.deepEqual([target.widthPt, target.heightPt], [200, 150]);
});
