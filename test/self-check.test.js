import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runWpsSelfCheck } from '../public/self-check.js';

// 自检本身就是实机流程：插图、换图、占位框、表格与标题的真实结果只能在 WPS 中得到。
// 这里用模拟宿主核对编排契约：只操作本次新建的文档，失败时报告什么、何时跳过，以及关闭失败时保留文件。
afterEach(() => { delete globalThis.Application; });

const CR = String.fromCharCode(13);
const ID = '0123abcd-0000-4000-8000-0123456789ab';
const DOCUMENT_PATH = `C:\\Users\\测试\\AppData\\Local\\Temp\\ipeitu-self-check-${ID}\\ipeitu-自检.docx`;
const ORIGINAL_PATH = 'C:\\标书\\投标文件.docx';
const STOPPED = '活动文档不是本次自检文档，操作已停止';
const fixture = (overrides = {}) => ({
  id: ID, documentPath: DOCUMENT_PATH, assetId: 'asset', image: {}, replacement: {}, box: {}, boxOptions: { widthCm: 8, heightCm: 6 },
  ...overrides,
});
const summary = report => report.results.map(({ name, status, detail }) => [name, status, detail]);

// 原文档只有 FullName 与 Activate：自检若误写原文档，会因缺少方法而报出不同的错误。
function createHost(options = {}) {
  const calls = [];
  const original = { FullName: options.originalPath ?? ORIGINAL_PATH, Activate() { calls.push('activate-original'); active = original; } };
  const open = [original];
  let active = original;
  let count = 0;
  const testDocument = (name, extra = {}) => {
    const doc = {
      FullName: name, Content: { Text: CR }, InlineShapes: { Count: 0 }, Tables: { Count: 0 }, ReadOnly: false,
      SaveAs2(...args) { calls.push(['save', ...args]); if (!options.saveIgnored) doc.FullName = args[0]; },
      Close(mode) {
        calls.push(['close', mode]);
        if (options.closeKeepsOpen) return;
        open.splice(open.indexOf(doc), 1);
        if (active === doc) active = options.noActiveAfterClose ? null : open[0] ?? null;
      },
      ...extra,
    };
    return doc;
  };
  const app = {
    get Version() { if (options.versionFails) throw new Error('无法读取'); return '12.1.0.0'; },
    Documents: {
      get Count() { return open.length; },
      Item: index => open[index - 1],
      Add() {
        calls.push('add');
        const doc = options.addDocument ? options.addDocument({ testDocument, original }) : testDocument(`文档${++count}`);
        if (doc !== original) open.push(doc);
        active = doc;
        if (options.switchAfterCreate) {
          // 创建步骤最后读取 ReadOnly，之后用户切回原文档。
          Object.defineProperty(doc, 'ReadOnly', { get() { active = original; return false; } });
        }
        return doc;
      },
      Open(path, ...args) {
        calls.push(['open', path, ...args]);
        const doc = testDocument(path);
        open.push(doc);
        active = doc;
        return doc;
      },
    },
    get ActiveDocument() { return active; },
  };
  globalThis.Application = app;
  return { calls, open };
}

test('rejects an invalid fixture path before creating any document', () => {
  for (const overrides of [{ documentPath: 'D:\\其他\\ipeitu-自检.docx' }, { id: 'not-a-uuid' }, { documentPath: '\\\\server\\share\\ipeitu-自检.docx' }]) {
    const { calls } = createHost({ versionFails: true });
    const report = runWpsSelfCheck(fixture(overrides));
    assert.equal(report.version, '无法读取');
    assert.deepEqual(summary(report), [
      ['创建临时文档', '失败', '自检文档路径无效'],
      ['关闭测试文档', '通过', '已结束自检文档操作'],
    ]);
    assert.equal(report.safeToClean, true);
    assert.deepEqual(calls, []);
  }
});

test('refuses to run when the self-check path is already open, and keeps the file', () => {
  const { calls } = createHost({ originalPath: DOCUMENT_PATH.replaceAll('\\', '/').toUpperCase() });
  const report = runWpsSelfCheck(fixture());
  assert.equal(report.version, '12.1.0.0');
  assert.deepEqual(summary(report), [
    ['创建临时文档', '失败', '自检文档路径已在 WPS 中打开'],
    ['关闭测试文档', '失败', '自检 DOCX 仍处于打开状态，请手动关闭'],
  ]);
  assert.equal(report.safeToClean, false);
  assert.deepEqual(calls, []);
});

test('never closes a document it cannot confirm as newly created', () => {
  const { calls, open } = createHost({ addDocument: ({ original }) => original });
  const report = runWpsSelfCheck(fixture());
  assert.deepEqual(summary(report), [
    ['创建临时文档', '失败', 'WPS 未返回可确认的新文档'],
    ['关闭测试文档', '通过', '已结束自检文档操作'],
  ]);
  assert.deepEqual(calls, ['add'], '不关闭原文档');
  assert.equal(open.length, 1);
});

test('discards a new document that is not blank and returns to the original document', () => {
  const { calls } = createHost({
    noActiveAfterClose: true,
    addDocument: ({ testDocument }) => testDocument('文档1', { Content: { Text: `模板文字${CR}` } }),
  });
  const report = runWpsSelfCheck(fixture());
  assert.deepEqual(summary(report), [
    ['创建临时文档', '失败', '新建文档不是可编辑的空白文档'],
    ['关闭测试文档', '通过', '已结束自检文档操作'],
  ]);
  assert.deepEqual(calls, ['add', ['close', 0], 'activate-original'], '不保存更改地关闭，再切回原文档');
  assert.equal(report.safeToClean, true);
});

test('stops every document operation once the active document is no longer the test document', () => {
  const { calls } = createHost({ switchAfterCreate: true });
  const report = runWpsSelfCheck(fixture());
  assert.deepEqual(summary(report), [
    ['创建临时文档', '通过', '新建空白文档'],
    ['插入图片', '失败', STOPPED],
    ['替换图片', '跳过', '需要先成功插入测试图片'],
    ['插入并扫描占位框', '失败', STOPPED],
    ['填入占位框', '跳过', '需要先成功插入并扫描占位框'],
    ['知识库标题与正文', '失败', STOPPED],
    ['表格宽度', '失败', STOPPED],
    ['保存 DOCX 并重新打开', '失败', STOPPED],
    ['关闭测试文档', '通过', '已结束自检文档操作'],
  ]);
  assert.deepEqual(calls, ['add', ['close', 0]], '只丢弃自检文档，不保存');
  assert.equal(report.safeToClean, true);
});

test('saves as DOCX at the fixture path, closes, reopens and verifies the same file', () => {
  // 宿主缺少插图、表格等接口，这些步骤失败；保存与重新打开的契约单独核对。
  const { calls } = createHost();
  const report = runWpsSelfCheck(fixture());
  const rows = summary(report);
  assert.deepEqual(rows.map(([name, status]) => [name, status]), [
    ['创建临时文档', '通过'], ['插入图片', '失败'], ['替换图片', '跳过'], ['插入并扫描占位框', '失败'], ['填入占位框', '跳过'],
    ['知识库标题与正文', '失败'], ['表格宽度', '失败'], ['保存 DOCX 并重新打开', '通过'], ['关闭测试文档', '通过'],
  ]);
  assert.equal(rows[7][2], '重新打开并核对 0 张图片');
  assert.deepEqual(calls, [
    'add', ['save', DOCUMENT_PATH, 12, false, '', false], ['close', 0], ['open', DOCUMENT_PATH, false, false, false], ['close', 0],
  ]);
  assert.equal(report.safeToClean, true);
  assert.ok(report.results.filter(item => item.status !== '跳过').every(item => Number.isInteger(item.duration)));
});

test('reports an unconfirmed save and still discards the unsaved test document', () => {
  const { calls } = createHost({ saveIgnored: true });
  const report = runWpsSelfCheck(fixture());
  const rows = summary(report);
  assert.deepEqual(rows.at(-2), ['保存 DOCX 并重新打开', '失败', 'WPS 未确认保存到本次自检路径']);
  assert.deepEqual(rows.at(-1), ['关闭测试文档', '通过', '已结束自检文档操作']);
  assert.deepEqual(calls, ['add', ['save', DOCUMENT_PATH, 12, false, '', false], ['close', 0]]);
});

test('keeps the self-check file when WPS does not close the test document', () => {
  const { calls } = createHost({ switchAfterCreate: true, closeKeepsOpen: true });
  const report = runWpsSelfCheck(fixture());
  assert.deepEqual(summary(report).at(-1), ['关闭测试文档', '失败', 'WPS 未关闭自检文档']);
  assert.equal(report.safeToClean, false, '未确认关闭时不清理临时目录');
  assert.deepEqual(calls, ['add', ['close', 0]]);
});
