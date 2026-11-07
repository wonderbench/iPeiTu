import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { startServer } from '../server/http.js';
import { verifyImportAndTrash } from './verify-import-ui.mjs';
import { verifyQuality } from './verify-quality-ui.mjs';
import { verifyPlaceholders } from './verify-placeholder-ui.mjs';

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
  const addIdle = () => page.waitForFunction(() => {
    const button = document.querySelector('.card-add');
    return button && !button.disabled && button.getAttribute('aria-disabled') === 'false';
  });

  await page.goto(`${base}/taskpane.html`);
  await visibleText('#stateTitle', '先添加');
  await page.locator('#toggleImport').click();
  await page.locator('#fileInput').setInputFiles([upload, { name: '无扩展名坏图', mimeType: 'application/octet-stream', buffer: Buffer.from('broken') }]);
  await visibleText('#importProgress', '导入 1 张，重复 0 张，失败 1 项');
  await page.locator('.asset-card').waitFor();
  await page.locator('#fileInput').setInputFiles({ ...upload, name: '基础施工 Alias.png' });
  await visibleText('#importProgress', '导入 0 张，重复 1 张，失败 0 项');
  await page.locator('#searchInput').fill('  alias  ');
  await visibleText('#resultCount', '1 / 1 张');
  await page.locator('.asset-card').click();
  assert.equal(await page.locator('#insertButton').count(), 0, '底部不再有单独的插入按钮');
  assert.equal(await page.locator('.card-add').isDisabled(), true, '浏览器模式禁止插入');
  assert.match(await page.locator('.card-add').getAttribute('title'), /浏览器模式/, '禁用的添加按钮说明原因');
  assert.equal(await page.locator('#replaceButton').isVisible(), false, '浏览器隐藏文档替换操作');
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
  await page.locator('#directoryDetails > summary').click();
  await page.locator('#directoryInput').fill(folder);
  await page.locator('#importDirectory').click();
  await visibleText('#importProgress', '导入 1 张，重复 0 张，失败 0 项');
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
  assert.equal(await page.locator('#activeFilters').isVisible(), true, '有筛选条件时显示摘要');
  await page.locator('#clearFilters').click();
  await visibleText('#resultCount', '2 张');
  assert.equal(await page.locator('#activeFilters').isVisible(), false, '无筛选条件时不占图库空间');
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

  await page.locator('#favoriteButton').click();
  await page.waitForFunction(() => document.querySelector('#favoriteButton').getAttribute('aria-pressed') === 'true');
  await page.reload();
  await page.locator('#viewFavorites').click();
  await visibleText('#resultCount', '1 张');
  await visibleText('.asset-name', filename);
  await page.locator('.asset-card').click();
  assert.equal(await page.locator('#favoriteButton').getAttribute('aria-pressed'), 'true');
  await page.locator('#searchInput').fill('不存在的收藏');
  await visibleText('#resultCount', '0 / 1 张');
  await page.locator('#clearSearch').click();
  await visibleText('#resultCount', '1 张');
  await page.locator('.asset-card').click();
  await page.route('**/api/assets/*/favorite', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '验收用收藏失败' }) }));
  await page.locator('#favoriteButton').click();
  await visibleText('#actionStatus', '验收用收藏失败');
  assert.equal(await page.locator('#favoriteButton').getAttribute('aria-pressed'), 'true', '收藏写入失败保留原状态');
  assert.equal(await page.locator('.asset-card').count(), 1);
  await page.unroute('**/api/assets/*/favorite');
  await page.locator('#favoriteButton').click();
  await visibleText('#resultCount', '0 张');
  await visibleText('#selectedName', '尚未选择图片');
  await page.locator('#viewRecent').click();
  await visibleText('#resultCount', '0 张');
  assert.equal(await page.locator('.asset-card').count(), 0, '预览和选择不记录最近');
  await page.locator('#viewAll').click();
  await visibleText('#resultCount', '2 张');
  await page.locator('.asset-card').first().focus();
  await page.keyboard.press('ArrowRight');
  await visibleText('#selectedName', '桥架施工.png');
  assert.equal(await page.locator('.asset-card[tabindex="0"]').count(), 1);
  assert.equal(await page.locator('.card-add[tabindex="0"]').count(), 1, '只有当前卡片的添加按钮进入 Tab 顺序');
  await page.keyboard.press('Home');
  await visibleText('#selectedName', filename);
  await page.keyboard.press('End');
  await visibleText('#selectedName', '桥架施工.png');
  await page.keyboard.press('ArrowLeft');
  await visibleText('#selectedName', filename);
  await page.keyboard.press('Enter');
  await visibleText('#selectedName', filename);

  for (const width of [320, 420, 1080]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px 无横向溢出`);
    const add = await page.locator('.card-add').first().boundingBox();
    const frame = await page.locator('.thumbnail-wrap').first().boundingBox();
    assert.ok(add.y + add.height <= 800, `${width}px 添加按钮可见`);
    assert.ok(add.x >= frame.x && add.x + add.width <= frame.x + frame.width
      && add.y >= frame.y && add.y + add.height <= frame.y + frame.height, `${width}px 添加按钮位于缩略图内`);
    assert.equal(await page.locator('#selectedSpec').isVisible(), width >= 800, `${width}px 分类与工序只在宽窗口展开`);
    assert.ok((await page.locator('.workspace').boundingBox()).height >= 480, `${width}px 素材区保持为窗格主体`);
    assert.equal(await page.locator('.thumbnail-wrap img').first().evaluate(image => Math.abs(image.getBoundingClientRect().height - image.parentElement.clientHeight) <= 1), true, `${width}px 缩略图按容器完整显示，竖图不被裁切`);
    await page.locator('#layoutSettingsButton').click();
    assert.equal(await page.evaluate(() => document.querySelector('#layoutDialog').scrollWidth <= document.querySelector('#layoutDialog').clientWidth), true, `${width}px 排版对话框无横向溢出`);
    await page.locator('#cancelLayout').click();
    await page.locator('#editMetadata').click();
    assert.equal(await page.evaluate(() => document.querySelector('#metadataDialog').scrollWidth <= document.querySelector('#metadataDialog').clientWidth), true, `${width}px 素材信息无横向溢出`);
    await page.locator('#cancelMetadata').click();
  }

  // v0.2 layout settings without a quality field remain compatible.
  await page.evaluate(() => { const saved = JSON.parse(localStorage.getItem('ipeitu.layout.v1')); delete saved.qualityProfile; localStorage.setItem('ipeitu.layout.v1', JSON.stringify(saved)); });
  await page.reload();
  await page.locator('#layoutSettingsButton').click();
  assert.equal(await page.locator('#qualityProfile').inputValue(), 'original');
  assert.equal(await page.locator('#widthCm').inputValue(), '8');
  await page.locator('#qualityProfile').selectOption('balanced');
  await page.locator('#saveLayout').click();
  await page.reload();
  await page.locator('#layoutSettingsButton').click();
  assert.equal(await page.locator('#qualityProfile').inputValue(), 'balanced');
  await page.locator('#cancelLayout').click();
  await visibleText('#layoutSettingsButton', '均衡');
  const qualityRequests = [];
  page.on('request', request => { if (/\/api\/assets\/[^/]+\/insertion(?:\?|$)/.test(request.url())) qualityRequests.push(new URL(request.url()).searchParams.get('profile')); });

  // Linux CI exercises a simulated Windows host; keep its local-path contract.
  await page.route(/\/api\/assets\/[^/]+\/insertion(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, path: `C:\\test\\${data.name}` } });
  });
  await page.addInitScript(() => {
    window.insertions = [];
    window.mockReadOnly = false;
    window.mockInsertFailure = false;
    window.Application = {
      Documents: { Count: 1 },
      CentimetersToPoints: value => value * 72 / 2.54,
      UndoRecord: { StartCustomRecord: () => {}, EndCustomRecord: () => {} },
      get ActiveDocument() { return { Name: '验收文档.docx', FullName: window.mockFullName || 'C:\\test\\验收文档.docx', ReadOnly: window.mockReadOnly, ProtectionType: -1 }; },
      Selection: { get Range() {
        const range = {
          Start: 5, End: 12, StoryType: 1, PageSetup: { PageWidth: 600, LeftMargin: 60, RightMargin: 60 },
          Information: () => false,
          Collapse: direction => { assertCollapse(direction); range.Start = range.End; },
          InlineShapes: { AddPicture: (filename, link, save, target) => {
            if (window.mockInsertFailure) throw new Error('验收用 WPS 插图失败');
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
        return { Start: range.Start, End: range.End, StoryType: range.StoryType, Duplicate: range };
      } },
    };
    function assertCollapse(direction) { if (direction !== 0) throw new Error('必须折叠到末尾'); }
  });
  await page.reload();
  await page.locator('.asset-card').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.insertions.length), 0, '图库 Enter 只选择，不插入');
  await page.locator('#searchInput').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.insertions.length), 0, '检索框 Enter 不插入');
  // 重载后没有所选图片：点击添加按钮即插入，并选中这张图。
  await page.reload();
  await page.locator('.card-add').first().click();
  await visibleText('#actionStatus', '已插入');
  await visibleText('#selectedName', filename);
  const inserted = await page.evaluate(() => window.insertions);
  assert.equal(inserted.length, 1);
  assert.equal(qualityRequests.at(-1), 'balanced', '插入使用已保存质量档');
  assert.equal(inserted[0].link, false);
  assert.equal(inserted[0].save, true);
  assert.equal(inserted[0].start, 12);
  assert.equal(inserted[0].end, 12);
  assert.ok(Math.abs(inserted[0].width - 8 * 72 / 2.54) < 0.01, '持久化的固定宽度实际传递到 WPS');
  assert.ok(inserted[0].height <= 5 * 72 / 2.54, '最大高度限制保持有效');
  await page.locator('.card-add').first().click();
  await page.waitForFunction(() => window.insertions.length === 2);
  await addIdle();
  let recent = await (await fetch(`${base}/api/library?view=recent`)).json();
  assert.equal(recent.assets.length, 1, '同图连续插入只留一条最近记录');
  assert.equal(recent.assets[0].name, filename);
  assert.ok(recent.assets[0].lastInsertedAt);
  await page.locator('#viewRecent').click();
  await visibleText('#resultCount', '1 张');
  await page.locator('#viewAll').click();
  await visibleText('#resultCount', '2 张');
  await page.route('**/api/assets/*/recent', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '验收用记录失败' }) }));
  await page.locator('.card-add').nth(1).click();
  await visibleText('#actionStatus', '图片已插入，但最近记录未保存');
  assert.equal(await page.evaluate(() => window.insertions.length), 3, '记录失败不会重复插图');
  recent = await (await fetch(`${base}/api/library?view=recent`)).json();
  assert.equal(recent.assets.length, 1);
  await page.unroute('**/api/assets/*/recent');
  await page.evaluate(() => { window.mockInsertFailure = true; });
  await page.locator('.card-add').nth(1).click();
  await visibleText('#actionStatus', '插入失败');
  recent = await (await fetch(`${base}/api/library?view=recent`)).json();
  assert.equal(recent.assets.length, 1, 'WPS插图失败不记最近');
  await page.evaluate(() => { window.mockInsertFailure = false; });
  await page.locator('.card-add').nth(1).click();
  await visibleText('#actionStatus', '已插入');
  await addIdle();
  recent = await (await fetch(`${base}/api/library?view=recent`)).json();
  assert.deepEqual(recent.assets.map(asset => asset.name), ['桥架施工.png', filename]);
  await page.locator('#viewRecent').click();
  await visibleText('#resultCount', '2 张');
  await visibleText('.asset-name', '桥架施工.png');
  await page.locator('#viewAll').click();
  await visibleText('#resultCount', '2 张');

  const insertionCount = () => page.evaluate(() => window.insertions.length);
  const focusOnAdd = () => page.evaluate(() => document.activeElement.classList.contains('card-add'));
  let insertionsBefore = await insertionCount();
  await page.locator('.card-add').first().evaluate(button => { button.click(); button.click(); });
  await addIdle();
  assert.equal(await insertionCount(), insertionsBefore + 1, '连击添加按钮只插入一次');

  insertionsBefore = await insertionCount();
  await page.locator('.asset-card').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await insertionCount(), insertionsBefore, '卡片 Enter 只选图');
  await page.keyboard.press('Tab');
  assert.equal(await focusOnAdd(), true, 'Tab 从当前卡片进入它的添加按钮');
  await page.keyboard.press('Enter');
  await page.waitForFunction(count => window.insertions.length === count, insertionsBefore + 1);
  await addIdle();
  assert.equal(await focusOnAdd(), true, '插入后焦点留在添加按钮上，可继续添加');

  // 等待插入文件期间文档切换，必须在写入前中止。
  insertionsBefore = await insertionCount();
  const insertionUrl = /\/api\/assets\/[^/]+\/insertion(?:\?.*)?$/;
  let releaseInsertion;
  const insertionGate = new Promise(resolve => { releaseInsertion = resolve; });
  const heldInsertion = async route => { await insertionGate; await route.fallback(); };
  await page.route(insertionUrl, heldInsertion);
  await page.locator('.card-add').first().click();
  assert.equal(await page.locator('.card-add').first().getAttribute('aria-disabled'), 'true', '插入等待时其他添加按钮不可用');
  await page.evaluate(() => { window.mockFullName = 'C:\\test\\另一份文档.docx'; });
  releaseInsertion();
  await visibleText('#actionStatus', '已改变');
  assert.equal(await insertionCount(), insertionsBefore, '等待期间文档变化不写入');
  await page.unroute(insertionUrl, heldInsertion);
  await page.evaluate(() => { window.mockFullName = undefined; });
  await addIdle();

  await page.locator('.asset-card').first().click();
  await page.evaluate(() => { window.mockReadOnly = true; window.dispatchEvent(new Event('focus')); });
  assert.equal(await page.locator('.card-add').first().isDisabled(), true);
  await visibleText('#hostStatus', '只读');
  await page.evaluate(() => { window.mockReadOnly = false; });
  await page.mouse.move(-1, -1);
  await page.mouse.move(50, 100);
  await addIdle();

  await page.evaluate(() => {
    window.prepareReplacement = () => {
      const fixture = window.replacementFixture = { added: 0, oldDeleted: false, moved: false, selected: true, width: null, font: null };
      const font = { Name: '宋体', Position: 2 };
      const original = {
        Type: 3, Width: 180, Height: 90,
        get Range() {
          if (fixture.oldDeleted) throw new Error('原图片已删除');
          return range(20 + fixture.added, 21 + fixture.added, true);
        },
        Delete() { fixture.oldDeleted = true; },
      };
      function range(start, end, old = false) {
        const value = {
          Start: start, End: end, StoryType: 1,
          get Font() { return { Duplicate: { ...font } }; },
          set Font(value) { fixture.font = value; },
          get Duplicate() { return range(this.Start, this.End, old); },
          Collapse(direction) {
            if (direction === 1) this.End = this.Start;
            else if (direction === 0) this.Start = this.End;
            else throw new Error('未知折叠方向');
          },
          Select() { fixture.selected = false; },
          InlineShapes: {
            Count: 1, Item: () => original,
            AddPicture(filename, link, save, target) {
              if (target.Start !== target.End) throw new Error('替换必须先折叠范围');
              fixture.added++;
              fixture.filename = filename; fixture.link = link; fixture.save = save;
              let width = 600, height = 400;
              return {
                get Width() { return width; },
                set Width(value) { if (this.LockAspectRatio === -1) height *= value / width; width = value; fixture.width = width; fixture.height = height; },
                get Height() { return height; },
                get Range() { return range(20, 21); },
                Delete() { fixture.added--; },
              };
            },
          },
        };
        return value;
      }
      window.Application.Selection = {
        Type: 7,
        get Range() { return range(fixture.moved ? 21 : 20, fixture.selected ? fixture.moved ? 22 : 21 : 20); },
      };
      window.dispatchEvent(new Event('focus'));
    };
    window.prepareReplacement();
  });
  assert.equal(await page.locator('#replaceButton').isEnabled(), true);
  await page.locator('#replaceButton').click();
  await visibleText('#actionStatus', '已替换');
  await addIdle();
  let replacement = await page.evaluate(() => window.replacementFixture);
  assert.equal(replacement.added, 1);
  assert.equal(qualityRequests.at(-1), 'balanced', '替换使用已保存质量档');
  assert.equal(replacement.oldDeleted, true);
  assert.equal(replacement.width, 180, '替换保留原宽度，不用当前8厘米插图偏好');
  assert.equal(replacement.height, 120);
  assert.deepEqual(replacement.font, { Name: '宋体', Position: 2 });
  assert.equal(replacement.link, false);
  assert.equal(replacement.save, true);

  await page.evaluate(() => window.prepareReplacement());
  await page.route('**/api/assets/*/recent', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"验收用记录失败"}' }));
  await page.locator('#replaceButton').click();
  await visibleText('#actionStatus', '图片已替换，但最近记录未保存');
  replacement = await page.evaluate(() => window.replacementFixture);
  assert.equal(replacement.added, 1);
  assert.equal(replacement.oldDeleted, true);
  await page.unroute('**/api/assets/*/recent');

  await page.evaluate(() => window.prepareReplacement());
  let releaseReplacement;
  const pendingReplacement = new Promise(resolve => { releaseReplacement = resolve; });
  const delayedInsertion = async route => {
    await pendingReplacement;
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, path: `C:\\test\\${data.name}` } });
  };
  await page.route(/\/api\/assets\/[^/]+\/insertion(?:\?.*)?$/, delayedInsertion);
  await page.locator('#replaceButton').click();
  assert.equal(await page.locator('.card-add').first().getAttribute('aria-disabled'), 'true', '替换等待时不能同时插入');
  await page.locator('.card-add').first().evaluate(button => button.click());
  assert.equal(await page.locator('#replaceButton').isDisabled(), true);
  await page.evaluate(() => { window.replacementFixture.moved = true; });
  releaseReplacement();
  await visibleText('#actionStatus', '替换失败');
  replacement = await page.evaluate(() => window.replacementFixture);
  assert.equal(replacement.added, 0, '等待期间目标变化必须在写入前中止');
  assert.equal(replacement.oldDeleted, false);
  await page.unroute(/\/api\/assets\/[^/]+\/insertion(?:\?.*)?$/, delayedInsertion);
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
  await verifyPlaceholders({ page });
  await verifyImportAndTrash({ page, base, temporary, picture, filename });
  await verifyQuality({ base });
  assert.deepEqual(failures, []);
  console.log('UI 验收通过：导入/检索/预览、素材信息与组合筛选、收藏重载与写失败恢复、最近成功记录及失败分离、键盘选图不误插入、卡片添加按钮的连击与键盘操作、排版偏好恢复、320/420/1080 布局、模拟 WPS 插图与替换、目标变更拒绝写入、只读与读取失败恢复');
  console.log('WPS 行为使用模拟宿主；真实 WPS 验收另行记录。');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.match(path.basename(temporary), /^ipeitu-ui-/);
  await rm(temporary, { recursive: true, force: true });
}
