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

  await page.locator('#layoutSettingsButton').click();
  await page.locator('#widthMode').selectOption('fixed');
  await page.locator('#widthCm').fill('8');
  await page.locator('#maxHeightCm').fill('5');
  await page.locator('#includeCaption').check();
  await page.locator('#saveLayout').click();
  await page.reload();
  await page.locator('#layoutSettingsButton').click();
  assert.equal(await page.locator('#widthMode').inputValue(), 'fixed');
  assert.equal(await page.locator('#widthCm').inputValue(), '8');
  assert.equal(await page.locator('#maxHeightCm').inputValue(), '5');
  assert.equal(await page.locator('#includeCaption').isChecked(), true);
  await page.locator('#cancelLayout').click();
  await page.locator('.asset-card').first().click();
  await page.locator('#layoutSettingsButton').click();
  assert.equal(await page.locator('#captionText').inputValue(), filename.replace(/\.[^.]+$/, ''));
  await page.locator('#captionText').fill('本次编辑的图题');
  await page.locator('#saveLayout').click();
  await page.locator('.asset-card').nth(1).click();
  await page.locator('#layoutSettingsButton').click();
  assert.equal(await page.locator('#captionText').inputValue(), '机电安装');
  await page.locator('#includeCaption').uncheck();
  await page.locator('#layoutMode').selectOption('inline');
  await page.locator('#saveLayout').click();

  await page.locator('#editMetadata').click();
  await page.locator('#assetName').fill('桥架施工.png');
  await page.locator('#assetAliases').fill('电气安装\nBridge');
  await page.locator('#assetCategories').fill('机电/桥架');
  await page.locator('#assetTags').fill('桥架\n室内');
  await page.locator('#saveMetadata').click();
  await visibleText('#selectedName', '桥架施工.png');
  await page.locator('#searchInput').fill('bridge 室内');
  await visibleText('#resultCount', '1 / 2 张');
  await visibleText('.asset-name', '桥架施工.png');
  await page.locator('#openFilters').click();
  await page.locator('#categorySelect').selectOption('category:机电/桥架');
  await page.locator('#filterTags input[value="室内"]').check();
  await page.locator('#applyFilters').click();
  await visibleText('#resultCount', '1 / 2 张');
  await page.locator('#searchInput').fill('不存在的工序');
  await visibleText('#stateTitle', '没有找到');
  await page.locator('#clearSearch').click();
  await visibleText('#resultCount', '1 / 2 张');
  await page.locator('#openFilters').click();
  await page.locator('#categorySelect').selectOption('uncategorized');
  await page.locator('#filterTags input[value="室内"]').uncheck();
  await page.locator('#applyFilters').click();
  await visibleText('#resultCount', '1 / 2 张');
  await visibleText('.asset-name', filename);
  await page.locator('#clearFilters').click();
  await visibleText('#resultCount', '2 张');
  await page.reload();
  await page.locator('#searchInput').fill('桥架 室内');
  await visibleText('#resultCount', '1 / 2 张');
  await visibleText('.asset-name', '桥架施工.png');
  await page.locator('#clearSearch').click();
  await visibleText('#resultCount', '2 张');

  await page.locator('.asset-card').first().click();
  await page.locator('#editMetadata').click();
  await page.locator('#assetName').fill('不应保存的名称');
  await page.route('**/api/assets/*', route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '验收用信息保存失败' }) })
    : route.continue());
  await page.locator('#saveMetadata').click();
  await visibleText('#metadataError', '验收用信息保存失败');
  assert.equal(await page.locator('#assetName').inputValue(), '不应保存的名称');
  await page.locator('#cancelMetadata').click();
  await page.unroute('**/api/assets/*');
  await visibleText('#selectedName', filename);

  for (const width of [320, 420, 1080]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px 无横向溢出`);
    const bounds = await page.locator('#insertButton').boundingBox();
    assert.ok(bounds.y + bounds.height <= 800, `${width}px 插入操作可见`);
    await page.locator('#layoutSettingsButton').click();
    assert.equal(await page.evaluate(() => document.querySelector('#layoutDialog').scrollWidth <= document.querySelector('#layoutDialog').clientWidth), true, `${width}px 排版对话框无横向溢出`);
    await page.locator('#cancelLayout').click();
    await page.locator('#editMetadata').click();
    assert.equal(await page.evaluate(() => document.querySelector('#metadataDialog').scrollWidth <= document.querySelector('#metadataDialog').clientWidth), true, `${width}px 素材信息无横向溢出`);
    await page.locator('#cancelMetadata').click();
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
      CentimetersToPoints: value => value * 72 / 2.54,
      UndoRecord: { StartCustomRecord: () => {}, EndCustomRecord: () => {} },
      get ActiveDocument() { return { Name: '验收文档.docx', FullName: 'C:\\test\\验收文档.docx', ReadOnly: window.mockReadOnly, ProtectionType: -1 }; },
      Selection: { get Range() {
        const range = {
          Start: 5, End: 12, PageSetup: { PageWidth: 600, LeftMargin: 60, RightMargin: 60 },
          Information: () => false,
          Collapse: direction => { assertCollapse(direction); range.Start = range.End; },
          InlineShapes: { AddPicture: (filename, link, save, target) => {
            const record = { filename, link, save, start: target.Start, end: target.End, width: 1000, height: 600 };
            window.insertions.push(record);
            return {
              get Width() { return record.width; },
              set Width(value) { if (this.LockAspectRatio === -1) record.height *= value / record.width; record.width = value; },
              get Height() { return record.height; },
              Range: { Duplicate: { Collapse: assertCollapse, Select: () => {} } },
            };
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
  assert.ok(Math.abs(inserted[0].width - 8 * 72 / 2.54) < 0.01, '持久化的固定宽度实际传递到 WPS');
  assert.ok(inserted[0].height <= 5 * 72 / 2.54, '最大高度限制保持有效');
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
  await page.evaluate(() => localStorage.setItem('ipeitu.layout.v1', '{broken'));
  await page.reload();
  await visibleText('#actionStatus', '无法读取上次的排版设置');
  await visibleText('#layoutSettingsButton', '自适应');
  await visibleText('#resultCount', '2 张');
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('验收用存储失败', 'QuotaExceededError'); }; });
  await page.locator('#layoutSettingsButton').click();
  await page.locator('#widthMode').selectOption('fixed');
  await page.locator('#widthCm').fill('9');
  await page.locator('#saveLayout').click();
  await visibleText('#actionStatus', '未能保存在本机');
  await visibleText('#layoutSettingsButton', '宽 9 厘米');
  assert.deepEqual(failures, []);
  console.log('UI 验收通过：导入/检索/预览、素材信息编辑与失败保留、分类/未分类/多词标签筛选及重载、排版偏好恢复、图题切图隔离、320/420/1080 布局、模拟 WPS 固定宽度插入及保留选区、连续插图、只读提示、读取失败重试');
  console.log('WPS 行为使用模拟宿主；真实 WPS 验收另行记录。');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.match(path.basename(temporary), /^ipeitu-ui-/);
  await rm(temporary, { recursive: true, force: true });
}
