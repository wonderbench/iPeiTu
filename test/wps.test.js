import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { captureInsertionTarget, getHostStatus, insertPicture } from '../public/wps-bridge.js';
import { normalizeLayoutOptions } from '../public/layout-options.js';

const asset = { path: 'C:\\素材库\\沟槽 开挖.png', name: '沟槽 开挖.png', width: 1600, height: 900 };
afterEach(() => { delete globalThis.Application; });

function createHost(options = {}) {
  const state = { text: options.text ?? '开头需要保留的文字结尾', start: options.start ?? 2, end: options.end ?? 9, story: 1, pictures: [], calls: [], undoStarted: 0, undoEnded: 0 };
  const originalFormat = { Alignment: 3, LeftIndent: 12, RightIndent: 8, FirstLineIndent: 24, LineSpacingRule: 4, KeepWithNext: 0, ...options.format };
  state.paragraphs = state.text.split('\r').map(() => ({ style: options.style ?? '标书正文', format: { ...originalFormat }, numbered: Boolean(options.numbered) }));
  const page = { PageWidth: 600, LeftMargin: 60, RightMargin: 60, ...options.page };
  const cell = { Width: 220, LeftPadding: 10, RightPadding: 10, ...options.cell };
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
      InlineShapes: {
        AddPicture(path, link, save, insertion) {
          state.calls.push({ path, link, save, start: insertion.start, end: insertion.end });
          if (options.insertError) throw new Error('file missing');
          assert.equal(insertion.start, insertion.end, '图片不得覆盖未折叠选区');
          insertText(insertion.start, '\uFFFC');
          let width = options.pictureWidth ?? 800;
          let height = options.pictureHeight ?? 450;
          const picture = {
            position: insertion.start,
            LockAspectRatio: 0,
            get Width() { return width; },
            set Width(value) {
              if (options.resizeError) throw new Error('resize unavailable');
              if (this.LockAspectRatio === -1) height *= value / width;
              width = value;
            },
            get Height() { return height; },
            get Range() { return rangeAt(this.position, this.position + 1); },
          };
          state.pictures.push(picture);
          return picture;
        },
      },
    };
  }
  const app = {
    Documents: { Count: options.noDocument ? 0 : 1 },
    ActiveDocument: { Name: '标书.docx', FullName: 'C:\\文档\\标书.docx', ReadOnly: false, ProtectionType: -1, ...options.document },
    Selection: { get Range() { return rangeAt(state.start, state.end); } },
    CentimetersToPoints(value) { return value * 72 / 2.54; },
    UndoRecord: {
      StartCustomRecord() { state.undoStarted++; },
      EndCustomRecord() {
        state.undoEnded++;
        if (options.undoEndError) throw new Error('undo unavailable');
      },
    },
  };
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
  assert.throws(() => insertPicture(asset, target), /当前文档或光标位置已改变/);
  assert.equal(state.calls.length, 0);
  assert.equal(state.undoStarted, 0);
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
