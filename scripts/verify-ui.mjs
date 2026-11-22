import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { startServer } from '../server/http.js';
import { verifyImportAndTrash, verifyAssetPurge } from './verify-import-ui.mjs';
import { verifyQuality } from './verify-quality-ui.mjs';
import { verifyFormat } from './verify-format-ui.mjs';
import { verifyLibraryManagement } from './verify-library-ui.mjs';
import { verifyPlaceholders } from './verify-placeholder-ui.mjs';
import { verifyKnowledge, verifyKnowledgePaste, verifyKnowledgePurge } from './verify-knowledge-ui.mjs';
import { verifyLan } from './verify-lan-ui.mjs';
import { verifyManagePage, verifyEditLocks } from './verify-manage-ui.mjs';
import { verifySelfCheck } from './verify-self-check-ui.mjs';

// 每一段使用独立的临时图库、本机服务和浏览器上下文：前一段失败不会留下影响后一段的页面或图库状态。
const SECTION_TIMEOUT = 100_000;
const ACTION_TIMEOUT = 15_000;

const temporary = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-ui-'));
const picture = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#527467' } }).png().toBuffer();
const filename = '沟槽开挖_测试.png';
const stem = name => name.replace(/\.[^.]+$/, '');

// 自绘下拉菜单：通过触发按钮和菜单项选择，原生 select 只保存值。keyboard 为 true 时用方向键与 Enter 选择。
async function choose(page, id, label, { scope = page, keyboard = false } = {}) {
  const trigger = scope.locator(`#${id}Trigger`);
  const menu = scope.locator(`#${id}Menu`);
  if (keyboard) {
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await menu.waitFor({ state: 'visible' });
    for (let step = 0; step < 20; step++) {
      const active = await trigger.getAttribute('aria-activedescendant');
      if (active && (await scope.locator(`#${active}`).textContent()).trim() === label) break;
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
  } else {
    await trigger.click();
    await menu.getByRole('option', { name: label, exact: true }).click();
  }
  await menu.waitFor({ state: 'hidden' });
  assert.equal((await scope.locator(`#${id}Value`).textContent()).trim(), label, `${id} 菜单选中「${label}」`);
}

async function seed(base, items) {
  for (const { name, buffer, category } of items) {
    const parameters = new URLSearchParams({ name });
    if (category) parameters.set('category', category);
    const response = await fetch(`${base}/api/import-file?${parameters}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer,
    });
    assert.equal(response.status, 200, `预置素材「${name}」`);
  }
  return (await (await fetch(`${base}/api/library`)).json()).assets;
}

async function verifyLibraryCore({ page, base, temporary }) {
  const upload = { name: filename, mimeType: 'image/png', buffer: picture };
  async function visibleText(selector, text) {
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
  }
  const addIdle = () => page.waitForFunction(() => {
    const button = document.querySelector('.card-add');
    return button && !button.disabled && button.getAttribute('aria-disabled') === 'false';
  });
  // 素材信息需先取得编辑锁；关闭对话框后等待释放请求完成，下一次打开才不会撞上自己的旧锁。
  async function openMetadata() {
    await page.locator('#editMetadata').click();
    await page.locator('#metadataDialog').waitFor({ state: 'visible' });
  }
  async function closeMetadata(selector = '#cancelMetadata') {
    const released = page.waitForResponse(response => /\/edit-lock$/.test(new URL(response.url()).pathname)
      && response.request().method() === 'PATCH');
    await page.locator(selector).click();
    await released;
  }

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
  assert.match(await page.locator('.card-add').getAttribute('title'), /浏览器模式/, '禁用的插入按钮说明原因');
  assert.equal(await page.locator('#replaceButton').isVisible(), false, '浏览器隐藏文档替换操作');
  // 画廊卡片只显示去掉扩展名的文件名，完整文件名在悬停提示与详情区。
  assert.equal(await page.locator('.asset-name').textContent(), stem(filename));
  assert.equal(await page.locator('.asset-name').getAttribute('title'), filename);
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

  // 排版设置中的三个下拉框改为自绘菜单，值仍由隐藏的 select 保存。
  await page.locator('#layoutSettingsButton').click();
  await choose(page, 'widthMode', '指定宽度，可放大小图');
  assert.equal(await page.locator('#widthCm').isEnabled(), true, '选择指定宽度后可填写宽度');
  await page.locator('#widthCm').fill('8');
  await page.locator('#maxHeightCm').fill('5');
  await page.locator('#includeCaption').check();
  await page.locator('#saveLayout').click();
  await page.reload();
  await page.locator('#layoutSettingsButton').click();
  assert.equal(await page.locator('#widthMode').inputValue(), 'fixed');
  assert.equal((await page.locator('#widthModeValue').textContent()).trim(), '指定宽度，可放大小图', '重新打开时菜单显示已保存的选项');
  assert.equal(await page.locator('#widthCm').inputValue(), '8');
  assert.equal(await page.locator('#maxHeightCm').inputValue(), '5');
  assert.equal(await page.locator('#includeCaption').isChecked(), true);
  // 菜单打开时 Esc 只收起菜单，不关闭对话框。
  await page.locator('#layoutModeTrigger').click();
  await page.locator('#layoutModeMenu').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.locator('#layoutModeMenu').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#layoutDialog').isVisible(), true, 'Esc 先收起菜单');
  await page.locator('#cancelLayout').click();
  await page.locator('.asset-card').first().click();
  await page.locator('#layoutSettingsButton').click();
  assert.equal(await page.locator('#captionText').inputValue(), stem(filename));
  await page.locator('#captionText').fill('本次编辑的图题');
  await page.locator('#saveLayout').click();
  await page.locator('.asset-card').nth(1).click();
  await page.locator('#layoutSettingsButton').click();
  assert.equal(await page.locator('#captionText').inputValue(), '机电安装');
  await page.locator('#includeCaption').uncheck();
  await choose(page, 'layoutMode', '原段落，保留原有对齐');
  await page.locator('#saveLayout').click();

  await openMetadata();
  await page.locator('#assetName').fill('桥架施工.png');
  await page.locator('#assetAliases').fill('电气安装\nBridge');
  await page.locator('#assetCategories').fill('机电/桥架');
  await page.locator('#assetTags').fill('桥架\n室内');
  await page.locator('#saveMetadata').click();
  await visibleText('#selectedName', '桥架施工.png');
  await page.locator('#searchInput').fill('bridge 室内');
  await visibleText('#resultCount', '1 / 2 张');
  await visibleText('.asset-name', '桥架施工');
  // 分类在窗格上点选，工序标签与比例在筛选对话框中。
  await page.locator('#categoryChips button', { hasText: '机电/桥架' }).click();
  await page.locator('#openFilters').click();
  await page.locator('#filterTags input[value="室内"]').check();
  await page.locator('#applyFilters').click();
  await visibleText('#resultCount', '1 / 2 张');
  await page.locator('#searchInput').fill('不存在的工序');
  await visibleText('#stateTitle', '没有找到');
  await page.locator('#clearSearch').click();
  await visibleText('#resultCount', '1 / 2 张');
  await page.locator('#categoryChips button', { hasText: '未分类' }).click();
  await page.locator('#openFilters').click();
  await page.locator('#filterTags input[value="室内"]').uncheck();
  await page.locator('#applyFilters').click();
  await visibleText('#resultCount', '1 / 2 张');
  await visibleText('.asset-name', stem(filename));
  assert.equal(await page.locator('#activeFilters').isVisible(), true, '有筛选条件时显示摘要');
  await page.locator('#clearFilters').click();
  await visibleText('#resultCount', '2 张');
  assert.equal(await page.locator('#activeFilters').isVisible(), false, '无筛选条件时不占图库空间');
  await page.reload();
  await page.locator('#searchInput').fill('桥架 室内');
  await visibleText('#resultCount', '1 / 2 张');
  await visibleText('.asset-name', '桥架施工');
  await page.locator('#clearSearch').click();
  await visibleText('#resultCount', '2 张');

  await page.locator('.asset-card').first().click();
  await openMetadata();
  await page.locator('#assetName').fill('不应保存的名称');
  await page.route('**/api/assets/*', route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '验收用信息保存失败' }) })
    : route.continue());
  await page.locator('#saveMetadata').click();
  await visibleText('#metadataError', '验收用信息保存失败');
  assert.equal(await page.locator('#assetName').inputValue(), '不应保存的名称');
  await closeMetadata();
  await page.unroute('**/api/assets/*');
  await visibleText('#selectedName', filename);

  await page.locator('#favoriteButton').click();
  await page.waitForFunction(() => document.querySelector('#favoriteButton').getAttribute('aria-pressed') === 'true');
  await page.reload();
  await page.locator('#viewFavorites').click();
  await visibleText('#resultCount', '1 张');
  await visibleText('.asset-name', stem(filename));
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
  assert.equal(await page.locator('.card-add[tabindex="0"]').count(), 1, '只有当前卡片的插入按钮进入 Tab 顺序');
  assert.equal(await page.locator('.card-favorite-action[tabindex="0"]').count(), 1, '只有当前卡片的收藏按钮进入 Tab 顺序');
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
    assert.ok(add.y + add.height <= 800, `${width}px 插入按钮可见`);
    assert.ok(add.x >= frame.x && add.x + add.width <= frame.x + frame.width
      && add.y >= frame.y && add.y + add.height <= frame.y + frame.height, `${width}px 插入按钮位于缩略图内`);
    // 680px 起详情区移到右侧，显示分类与工序。
    assert.equal(await page.locator('#selectedSpec').isVisible(), width >= 680, `${width}px 分类与工序只在宽窗口展开`);
    assert.ok((await page.locator('.workspace').boundingBox()).height >= 480, `${width}px 素材区保持为窗格主体`);
    assert.equal(await page.locator('.thumbnail-wrap img').first().evaluate(image => Math.abs(image.getBoundingClientRect().height - image.parentElement.clientHeight) <= 1), true, `${width}px 缩略图按容器完整显示，竖图不被裁切`);
    await page.locator('#layoutSettingsButton').click();
    assert.equal(await page.evaluate(() => document.querySelector('#layoutDialog').scrollWidth <= document.querySelector('#layoutDialog').clientWidth), true, `${width}px 排版对话框无横向溢出`);
    await page.locator('#cancelLayout').click();
    await openMetadata();
    assert.equal(await page.evaluate(() => document.querySelector('#metadataDialog').scrollWidth <= document.querySelector('#metadataDialog').clientWidth), true, `${width}px 素材信息无横向溢出`);
    await closeMetadata();
  }

  // v0.2 layout settings without a quality field remain compatible.
  await page.evaluate(() => { const saved = JSON.parse(localStorage.getItem('ipeitu.layout.v1')); delete saved.qualityProfile; localStorage.setItem('ipeitu.layout.v1', JSON.stringify(saved)); });
  await page.reload();
  await page.locator('#layoutSettingsButton').click();
  assert.equal(await page.locator('#qualityProfile').inputValue(), 'original');
  assert.equal(await page.locator('#widthCm').inputValue(), '8');
  await choose(page, 'qualityProfile', '均衡 · 长边 ≤ 1600 像素', { keyboard: true });
  assert.equal(await page.locator('#qualityProfile').inputValue(), 'balanced', '键盘选择写回表单');
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
          // 读不到 TextColumns 时桥接按一栏处理；这里显式给出一栏。
          Start: 5, End: 12, StoryType: 1, PageSetup: { PageWidth: 600, LeftMargin: 60, RightMargin: 60, TextColumns: { Count: 1 } },
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
  await page.keyboard.press(' ');
  assert.equal(await page.evaluate(() => window.insertions.length), 0, '图库空格只选择，不插入');
  await page.locator('#searchInput').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.insertions.length), 0, '检索框 Enter 不插入');
  // 重载后没有所选图片：点击插入按钮即插入，并选中这张图。
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
  await visibleText('.asset-name', '桥架施工');
  await page.locator('#viewAll').click();
  await visibleText('#resultCount', '2 张');

  const insertionCount = () => page.evaluate(() => window.insertions.length);
  const focusOnAdd = () => page.evaluate(() => document.activeElement.classList.contains('card-add'));
  let insertionsBefore = await insertionCount();
  await page.locator('.card-add').first().evaluate(button => { button.click(); button.click(); });
  await addIdle();
  assert.equal(await insertionCount(), insertionsBefore + 1, '连击插入按钮只插入一次');

  insertionsBefore = await insertionCount();
  await page.locator('.asset-card').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await insertionCount(), insertionsBefore, '卡片 Enter 只选图');
  await page.keyboard.press('Tab');
  assert.equal(await focusOnAdd(), true, 'Tab 从当前卡片进入它的插入按钮');
  await page.keyboard.press('Enter');
  await page.waitForFunction(count => window.insertions.length === count, insertionsBefore + 1);
  await addIdle();
  assert.equal(await focusOnAdd(), true, '插入后焦点留在插入按钮上，可继续插入');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('card-favorite-action')), true, '再按 Tab 进入收藏按钮');
  // 收藏按钮平时透明，键盘聚焦时显示（淡入有 140ms 过渡）。
  await page.waitForFunction(() => getComputedStyle(document.activeElement).opacity === '1');

  // 等待插入文件期间文档切换，必须在写入前中止。
  insertionsBefore = await insertionCount();
  const insertionUrl = /\/api\/assets\/[^/]+\/insertion(?:\?.*)?$/;
  let releaseInsertion;
  const insertionGate = new Promise(resolve => { releaseInsertion = resolve; });
  const heldInsertion = async route => { await insertionGate; await route.fallback(); };
  await page.route(insertionUrl, heldInsertion);
  await page.locator('.card-add').first().click();
  assert.equal(await page.locator('.card-add').first().getAttribute('aria-disabled'), 'true', '插入等待时其他插入按钮不可用');
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
  await page.locator('#documentActions').waitFor({ state: 'visible' });
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
  await choose(page, 'widthMode', '指定宽度，可放大小图');
  await page.locator('#widthCm').fill('9');
  await page.locator('#saveLayout').click();
  await visibleText('#actionStatus', '未能保存在本机');
  await visibleText('#layoutSettingsButton', '宽 9 厘米');
  console.log('素材库 UI 验收通过：导入/检索/预览、素材信息与组合筛选、收藏重载与写失败恢复、最近成功记录及失败分离、键盘选图不误插入、插入按钮的连击与键盘操作、自绘菜单的点选与键盘选择、排版偏好恢复、320/420/1080 布局、模拟 WPS 插图与替换、目标变更拒绝写入、只读与读取失败恢复');
}

// 占位框、导入与回收站、素材管理三段需要的预置素材：横图 1200 × 800 与 4:3 的 400 × 300。
const twoAssets = async () => [
  { name: filename, buffer: picture },
  { name: '桥架施工.png', buffer: await sharp({ create: { width: 400, height: 300, channels: 3, background: '#a67d5c' } }).png().toBuffer() },
];

const sections = [
  { name: '素材库：导入、检索、整理、插图与替换', run: verifyLibraryCore },
  { name: '占位框：插入、扫描、定位与填入', async run(context) {
    await seed(context.base, await twoAssets());
    await context.page.goto(`${context.base}/taskpane.html`);
    await verifyPlaceholders(context);
  } },
  { name: '导入整理：文件夹、重试、移出与恢复', async run(context) {
    await seed(context.base, await twoAssets());
    await verifyImportAndTrash(context);
  } },
  { name: '素材回收站：移出确认、永久删除与清空', run: verifyAssetPurge },
  { name: '质量档：插入文件的尺寸与体积', run: verifyQuality },
  { name: '排版工具：全文确认与表格宽度', run: verifyFormat },
  { name: '素材管理：筛选、多选、批量与切回刷新', async run(context) {
    await seed(context.base, [...await twoAssets(),
      { name: '竖向样图.png', buffer: await sharp({ create: { width: 300, height: 500, channels: 3, background: '#6d7f5a' } }).png().toBuffer() }]);
    await verifyLibraryManagement(context);
  } },
  { name: '知识库：维护、检索、插入与收录', run: verifyKnowledge },
  { name: '知识库：粘贴带格式内容', run: verifyKnowledgePaste },
  { name: '知识库回收站：永久删除与清空', run: verifyKnowledgePurge },
  { name: '资源管理页：素材与知识库模块', run: verifyManagePage },
  { name: '编辑锁：两个页面同时编辑', run: verifyEditLocks },
  { name: '实机自检页：模拟宿主下的报告', run: verifySelfCheck },
  { name: '局域网：来源切换与远程限制', run: verifyLan },
];

function describeFailure(error) {
  const message = String(error?.message ?? error).split('\n').filter(Boolean).slice(0, 3).join(' | ');
  const frames = String(error?.stack ?? '').split('\n').slice(1).map(line => line.trim()).filter(line => line.startsWith('at '));
  const frame = frames.find(line => /verify-[\w-]+\.mjs/.test(line)) ?? frames[0] ?? '';
  return { message, frame };
}

function withTimeout(promise, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`「${name}」超过 ${SECTION_TIMEOUT / 1000} 秒未完成`)), SECTION_TIMEOUT);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let browser;
const results = [];
try {
  for (const [index, section] of sections.entries()) {
    console.log(`\n=== [${index + 1}/${sections.length}] ${section.name} ===`);
    const started = Date.now();
    const sectionDirectory = path.join(temporary, `section-${index + 1}`);
    let server;
    let context;
    const pageErrors = [];
    try {
      await mkdir(sectionDirectory);
      if (!browser?.isConnected()) browser = await chromium.launch({ channel: process.env.IPEITU_BROWSER_CHANNEL || undefined });
      ({ server } = await startServer({ port: 0, dataDirectory: path.join(sectionDirectory, 'library') }));
      const base = `http://127.0.0.1:${server.address().port}`;
      context = await browser.newContext({ viewport: { width: 420, height: 800 } });
      context.setDefaultTimeout(ACTION_TIMEOUT);
      context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
      const page = await context.newPage();
      const outcome = await withTimeout(section.run({
        page, context, browser, base, temporary: sectionDirectory, picture, filename, choose, seed,
      }), section.name);
      assert.deepEqual(pageErrors, [], '页面没有未捕获的脚本错误');
      results.push({ name: section.name, status: outcome === false ? '跳过' : '通过', ms: Date.now() - started });
    } catch (error) {
      console.error(`「${section.name}」失败：`, error);
      if (pageErrors.length) console.error('页面脚本错误：', pageErrors);
      results.push({ name: section.name, status: '失败', ms: Date.now() - started, ...describeFailure(error) });
    } finally {
      await context?.close().catch(error => console.error('关闭浏览器上下文失败：', error.message));
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
  }
} finally {
  await browser?.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.match(path.basename(temporary), /^ipeitu-ui-/);
  await rm(temporary, { recursive: true, force: true });
}

console.log('\n=== UI 验收汇总 ===');
for (const result of results) {
  console.log(`${result.status}  ${result.name}（${(result.ms / 1000).toFixed(1)} 秒）`);
  if (result.status === '失败') {
    console.log(`      ${result.message}`);
    if (result.frame) console.log(`      ${result.frame}`);
  }
}
const failed = results.filter(result => result.status === '失败').length;
console.log(`共 ${results.length} 段：通过 ${results.filter(result => result.status === '通过').length}，失败 ${failed}，跳过 ${results.filter(result => result.status === '跳过').length}`);
console.log('WPS 行为使用模拟宿主；真实 WPS 验收另行记录。');
if (failed) process.exitCode = 1;
