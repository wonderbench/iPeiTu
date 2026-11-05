import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { startServer } from '../server/http.js';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-ui-'));
const { server } = await startServer({ port: 0, dataDirectory: path.join(temporary, 'library') });
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.IPEITU_BROWSER_CHANNEL || undefined });
  const failures = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
  page.on('pageerror', error => failures.push(error.message));
  const picture = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#527467' } }).png().toBuffer();
  const filename = '沟槽开挖_测试.png';
  const upload = { name: filename, mimeType: 'image/png', buffer: picture };

  async function visibleText(selector, text) {
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
  }

  await page.goto(`${base}/taskpane.html`);
  await visibleText('#stateTitle', '先添加');
  await page.locator('#toggleImport').click();
  await page.locator('#fileInput').setInputFiles([upload, { name: '坏图.png', mimeType: 'image/png', buffer: Buffer.from('broken') }]);
  await visibleText('#importProgress', '导入 1 张，重复 0 张，失败 1 张');
  await page.locator('.asset-card').waitFor();
  await page.locator('#fileInput').setInputFiles({ ...upload, name: '基础施工 Alias.png' });
  await visibleText('#importProgress', '导入 0 张，重复 1 张，失败 0 张');
  await page.locator('#searchInput').fill('  alias  ');
  await visibleText('#resultCount', '1 / 1 张');
  await page.locator('.asset-card').click();
  assert.equal(await page.locator('#insertButton').isDisabled(), true, '浏览器模式禁止插入');
  await page.locator('#previewButton').click();
  assert.equal(await page.locator('#previewDialog').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('#previewImage').naturalWidth === 1200);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#previewDialog').isVisible(), false);
  await page.locator('#searchInput').fill('不存在的图片');
  await visibleText('#stateTitle', '没有找到');
  await page.locator('#clearSearch').click();
  await visibleText('#resultCount', '1 张');
  await page.reload();
  await visibleText('#resultCount', '1 张');

  const folder = path.join(temporary, '导入目录');
  await mkdir(folder);
  await writeFile(path.join(folder, '机电安装.png'), await sharp({ create: { width: 400, height: 300, channels: 3, background: '#a67d5c' } }).png().toBuffer());
  await page.locator('#toggleImport').click();
  await page.locator('#directoryInput').fill(folder);
  await page.locator('#importDirectory').click();
  await visibleText('#importProgress', '导入 1 张，重复 0 张，失败 0 张');
  await visibleText('#resultCount', '2 张');
  await page.locator('#toggleImport').click();

  for (const width of [320, 420, 1080]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px 无横向溢出`);
    const bounds = await page.locator('#insertButton').boundingBox();
    assert.ok(bounds.y + bounds.height <= 800, `${width}px 插入操作可见`);
  }

  // Linux CI exercises a simulated Windows host; keep its local-path contract.
  await page.route('**/api/assets/*/insertion', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, path: `C:\\test\\${data.name}` } });
  });
  await page.addInitScript(() => {
    window.insertions = [];
    window.mockReadOnly = false;
    window.Application = {
      Documents: { Count: 1 },
      get ActiveDocument() { return { Name: '验收文档.docx', FullName: 'C:\\test\\验收文档.docx', ReadOnly: window.mockReadOnly, ProtectionType: -1 }; },
      Selection: { get Range() {
        const range = {
          Start: 5, End: 12, PageSetup: { PageWidth: 600, LeftMargin: 60, RightMargin: 60 },
          Information: () => false,
          Collapse: direction => { assertCollapse(direction); range.Start = range.End; },
          InlineShapes: { AddPicture: (filename, link, save, target) => {
            window.insertions.push({ filename, link, save, start: target.Start, end: target.End });
            return { Width: 1000, Height: 600, Range: { Duplicate: { Collapse: assertCollapse, Select: () => {} } } };
          } },
        };
        return { Start: range.Start, End: range.End, Duplicate: range };
      } },
    };
    function assertCollapse(direction) { if (direction !== 0) throw new Error('必须折叠到末尾'); }
  });
  await page.reload();
  await page.locator('.asset-card').first().click();
  await page.locator('#insertButton').click();
  await visibleText('#actionStatus', '已插入');
  const inserted = await page.evaluate(() => window.insertions);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].link, false);
  assert.equal(inserted[0].save, true);
  assert.equal(inserted[0].start, 12);
  assert.equal(inserted[0].end, 12);
  await page.locator('#insertButton').click();
  await page.waitForFunction(() => window.insertions.length === 2);
  await page.evaluate(() => { window.mockReadOnly = true; window.dispatchEvent(new Event('focus')); });
  assert.equal(await page.locator('#insertButton').isDisabled(), true);
  await visibleText('#hostStatus', '只读');
  await page.evaluate(() => { window.mockReadOnly = false; });
  await page.mouse.move(-1, -1);
  await page.mouse.move(50, 100);
  await page.waitForFunction(() => !document.querySelector('#insertButton').disabled);
  await page.route('**/api/library?*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '验收用读取失败' }) }));
  await page.locator('#searchInput').fill('失败');
  await visibleText('#stateTitle', '图库暂时无法读取');
  await page.unroute('**/api/library?*');
  await page.locator('#stateAction').click();
  await visibleText('#stateTitle', '没有找到');
  assert.deepEqual(failures, []);
  console.log('UI 验收通过：文件/目录导入、坏图反馈、重复别名、中文搜索、空结果、预览、重载持久化、320/420/1080 布局、模拟 WPS 插入及保留选区、连续插图、只读提示、读取失败重试');
  console.log('WPS 行为使用模拟宿主；真实 WPS 验收另行记录。');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.match(path.basename(temporary), /^ipeitu-ui-/);
  await rm(temporary, { recursive: true, force: true });
}
