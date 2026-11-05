import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { captureInsertionTarget, getHostStatus, insertPicture } from '../public/wps-bridge.js';

const asset = { path: 'C:\\素材库\\沟槽 开挖.png', name: '沟槽 开挖.png', width: 1600, height: 900 };
afterEach(() => { delete globalThis.Application; });

function createHost(options = {}) {
  const state = { text: '开头需要保留的文字结尾', start: 2, end: 9, pictures: [], calls: [] };
  const page = { PageWidth: 600, LeftMargin: 60, RightMargin: 60, ...options.page };
  const cell = { Width: 220, LeftPadding: 10, RightPadding: 10, ...options.cell };
  function rangeAt(start, end) {
    return {
      start,
      end,
      get Start() { return this.start; },
      get End() { return this.end; },
      get Duplicate() { return rangeAt(this.start, this.end); },
      PageSetup: page,
      Information(value) {
        assert.equal(value, 12);
        return Boolean(options.inTable);
      },
      Cells: { Item(index) { assert.equal(index, 1); return cell; } },
      Collapse(direction) {
        assert.equal(direction, 0);
        this.start = this.end;
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
          state.text = state.text.slice(0, insertion.start) + '\uFFFC' + state.text.slice(insertion.end);
          let width = options.pictureWidth ?? 800;
          let height = options.pictureHeight ?? 450;
          const picture = {
            LockAspectRatio: 0,
            get Width() { return width; },
            set Width(value) {
              if (options.resizeError) throw new Error('resize unavailable');
              if (this.LockAspectRatio === -1) height *= value / width;
              width = value;
            },
            get Height() { return height; },
            Range: rangeAt(insertion.start, insertion.start + 1),
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

test('目标未变时允许插入，下一次点击重新捕获图片后的光标', () => {
  const { state } = createHost();
  const target = captureInsertionTarget();
  assert.deepEqual(target, { document: 'C:\\文档\\标书.docx', start: 2, end: 9 });
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
