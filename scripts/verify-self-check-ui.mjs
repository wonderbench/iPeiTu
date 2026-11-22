import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';

// 模拟宿主只支持新建、保存、关闭与重新打开文档；插图、占位框、知识库与表格在模拟中按预期失败。
// 这里验证自检页的流程与报告（逐项状态、跳过关系、汇总、临时文件清理与复制），真实 WPS 行为另行实机采集。
function installSelfCheckHost() {
  const documents = [];
  let active = null;
  let created = 0;
  const unsupported = () => { throw new Error('模拟宿主不提供选区'); };
  const makeDocument = fullName => {
    let length = 1;
    const doc = {
      FullName: fullName, ReadOnly: false, ProtectionType: -1,
      get Name() { return doc.FullName.split('\\').at(-1); },
      get Content() { return { Start: 0, End: length, Text: '\r'.repeat(length) }; },
      InlineShapes: { Count: 0, Item() { throw new Error('没有图片'); } },
      Tables: { Count: 0, Add() { throw new Error('模拟宿主不支持表格'); } },
      Range: () => ({ InsertAfter(text) { length += text.length; }, Select() {} }),
      SaveAs2(file) { doc.FullName = file; window.selfCheckHost.saved.push(file); },
      Close(option) {
        window.selfCheckHost.closed.push(option);
        documents.splice(documents.indexOf(doc), 1);
        active = documents.at(-1) ?? null;
      },
      Activate() { active = doc; },
    };
    return doc;
  };
  const original = makeDocument('C:\\test\\验收文档.docx');
  documents.push(original);
  active = original;
  window.selfCheckHost = { saved: [], closed: [], opened: [] };
  window.Application = {
    Version: '12.1.0.模拟',
    Documents: {
      get Count() { return documents.length; },
      Item: index => documents[index - 1],
      Add() {
        const doc = makeDocument(`C:\\test\\文字文稿${++created}`);
        documents.push(doc);
        active = doc;
        return doc;
      },
      Open(file) {
        window.selfCheckHost.opened.push(file);
        const doc = makeDocument(file);
        documents.push(doc);
        active = doc;
        return doc;
      },
    },
    get ActiveDocument() { return active; },
    get Selection() { return unsupported(); },
    CentimetersToPoints: value => value * 72 / 2.54,
    UndoRecord: { StartCustomRecord() {}, EndCustomRecord() {} },
  };
}

export async function verifySelfCheck({ page, context, base }) {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`${base}/self-check.html`);
  assert.equal(await page.locator('#startSelfCheck').isDisabled(), true, '浏览器模式不能开始自检');
  assert.match(await page.locator('#selfCheckStatus').textContent(), /请从 WPS 文字/);

  // Linux CI 的临时目录不是 Windows 路径：记录服务端真实目录，把文档路径改成模拟宿主接受的形式。
  const fixtures = [];
  await page.route('**/api/self-check', async route => {
    const response = await route.fetch();
    const data = await response.json();
    fixtures.push(data);
    await route.fulfill({ response, json: { ...data, documentPath: `C:\\Temp\\ipeitu-self-check-${data.id}\\iPeiTu-自检.docx` } });
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await page.addInitScript(installSelfCheckHost);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#selfCheckStatus').textContent === '准备就绪');
  await page.locator('#startSelfCheck').click();
  await page.locator('#selfCheckOutput').waitFor({ state: 'visible' });
  assert.equal(fixtures.length, 1);
  const report = await page.locator('#selfCheckReport').inputValue();
  const lines = report.split('\n');
  assert.equal(lines[0], 'iPeiTu WPS 实机自检');
  assert.equal(lines[2], 'WPS 版本 12.1.0.模拟');
  assert.equal(lines[3], '3 项通过，4 项失败，2 项跳过');
  assert.equal(await page.locator('#selfCheckStatus').textContent(), '3 项通过，4 项失败，2 项跳过');
  for (const [status, name] of [['通过', '创建临时文档'], ['失败', '插入图片'], ['跳过', '替换图片'], ['失败', '插入并扫描占位框'],
    ['跳过', '填入占位框'], ['失败', '知识库标题与正文'], ['失败', '表格宽度'], ['通过', '保存 DOCX 并重新打开'], ['通过', '关闭测试文档']]) {
    assert.ok(lines.some(line => line.startsWith(`[${status}] ${name}`)), `报告列出「${name}」${status}`);
  }
  assert.match(report, /重新打开并核对 0 张图片/);
  assert.ok(!/清理临时文件/.test(report), '临时文件已清理');
  const host = await page.evaluate(() => window.selfCheckHost);
  const documentPath = `C:\\Temp\\ipeitu-self-check-${fixtures[0].id}\\iPeiTu-自检.docx`;
  assert.deepEqual(host.saved, [documentPath], '只保存到本次自检路径');
  assert.deepEqual(host.opened, [documentPath], '重新打开保存的文档');
  assert.deepEqual(host.closed, [0, 0], '两次关闭都放弃修改');
  await assert.rejects(stat(path.dirname(fixtures[0].documentPath)), { code: 'ENOENT' }, '服务端临时目录已删除');
  assert.equal(await page.locator('#startSelfCheck').isEnabled(), true, '完成后可再次自检');

  await page.locator('#copySelfCheck').click();
  await page.waitForFunction(() => ['已复制报告', '报告已选中，请按 Ctrl+C 复制'].includes(document.querySelector('#selfCheckStatus').textContent));
  if (await page.locator('#selfCheckStatus').textContent() === '已复制报告') {
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), report, '复制的内容与报告一致');
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '420px 无横向溢出');
  console.log('自检页 UI 验收通过（模拟宿主）：浏览器模式禁用、准备临时素材、逐项结果与跳过关系、汇总、只保存到自检路径并放弃修改关闭、临时目录清理、复制报告。真实 WPS 的自检报告待实机采集。');
}
