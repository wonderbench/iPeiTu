import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export async function verifyImportAndTrash({ page, base, temporary, picture, filename }) {
  async function visibleText(selector, text) {
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
  }
  async function library(view = 'all') {
    return (await fetch(`${base}/api/library?view=${view}`)).json();
  }
  await page.goto(`${base}/taskpane.html`);
  await visibleText('#resultCount', '2 张');
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator('.asset-card').first().click();
  await page.locator('#toggleImport').click();
  const pickerFolder = path.join(temporary, '文件夹选择');
  await mkdir(path.join(pickerFolder, '甲'), { recursive: true });
  await mkdir(path.join(pickerFolder, '乙'), { recursive: true });
  const imageA = await sharp({ create: { width: 240, height: 180, channels: 3, background: '#7b867e' } }).png().toBuffer();
  const imageB = await sharp({ create: { width: 360, height: 220, channels: 3, background: '#8f8270' } }).png().toBuffer();
  await writeFile(path.join(pickerFolder, '甲', '同名.png'), imageA);
  await writeFile(path.join(pickerFolder, '乙', '同名.png'), imageB);
  let uploadRequests = [];
  let releaseUpload;
  let markUploadStarted;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const uploadStarted = new Promise(resolve => { markUploadStarted = resolve; });
  const failingUpload = async route => {
    const url = new URL(route.request().url());
    uploadRequests.push(url.searchParams.get('category'));
    markUploadStarted();
    await uploadGate;
    if (url.searchParams.get('category') === '乙') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"验收用暂时上传失败"}' });
    } else await route.continue();
  };
  await page.route('**/api/import-file?*', failingUpload);
  await page.locator('#folderInput').setInputFiles(pickerFolder);
  await uploadStarted;
  assert.equal(await page.locator('#importMeter').isVisible(), true, '导入期间显示进度');
  await page.locator('#favoriteButton').click();
  await page.waitForFunction(() => document.querySelector('#favoriteButton').getAttribute('aria-pressed') === 'true');
  releaseUpload();
  await visibleText('#importProgress', '导入 1 张，重复 0 张，失败 1 项');
  assert.deepEqual(uploadRequests.sort(), ['乙', '甲'].sort());
  assert.equal((await library()).total, 3);
  await page.unroute('**/api/import-file?*', failingUpload);
  const retryRequests = [];
  const trackRetry = async route => { retryRequests.push(new URL(route.request().url()).searchParams.get('category')); await route.continue(); };
  await page.route('**/api/import-file?*', trackRetry);
  await page.locator('#retryImport').click();
  await visibleText('#importProgress', '导入 1 张，重复 0 张，失败 0 项');
  assert.deepEqual(retryRequests, ['乙'], '同名文件重试必须保留原 File 与目录身份');
  await page.unroute('**/api/import-file?*', trackRetry);
  const uploaded = (await library()).assets.filter(asset => asset.name === '同名.png');
  assert.equal(uploaded.length, 2);
  assert.deepEqual(uploaded.map(asset => asset.categories[0]).sort(), ['乙', '甲'].sort());
  for (const width of [320, 420]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px 导入区无横向溢出`);
  }

  // 查询失败时任务可能已完成；继续查询必须沿用任务 ID，不能重新提交目录。
  const jobFolder = path.join(temporary, '任务重试');
  await mkdir(jobFolder);
  const failedPath = path.join(jobFolder, '修复后重试.png');
  await writeFile(failedPath, 'not an image');
  let creates = 0;
  let reads = 0;
  const jobRequests = async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname === '/api/import-jobs') creates++;
    if (route.request().method() === 'GET' && ++reads <= 2) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"验收用查询中断"}' });
    } else await route.continue();
  };
  await page.route('**/api/import-jobs**', jobRequests);
  await page.locator('#directoryDetails > summary').click();
  await page.locator('#directoryInput').fill(jobFolder);
  await page.locator('#importDirectory').click();
  await page.locator('#resumeImport').waitFor({ state: 'visible' });
  assert.equal(creates, 1);
  await page.reload();
  await page.locator('#resumeImport').waitFor({ state: 'visible' });
  await page.locator('#resumeImport').click();
  await visibleText('#importProgress', '导入 0 张，重复 0 张，失败 1 项');
  assert.equal(creates, 1, '恢复查询不会重复创建任务');
  await page.unroute('**/api/import-jobs**', jobRequests);
  const fixedImage = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#566b79' } }).png().toBuffer();
  await writeFile(failedPath, fixedImage);
  await page.locator('#retryImport').click();
  await visibleText('#importProgress', '导入 1 张，重复 0 张，失败 0 项');
  await visibleText('#resultCount', '5 张');
  assert.equal((await library()).assets.filter(asset => asset.name === '修复后重试.png').length, 1);
  await writeFile(failedPath, 'broken again');
  await page.locator('#directoryDetails > summary').click();
  await page.locator('#directoryInput').fill(jobFolder);
  await page.locator('#importDirectory').click();
  await visibleText('#importProgress', '导入 0 张，重复 0 张，失败 1 项');
  const expiredRetry = route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"任务已过期"}' });
  await page.route('**/api/import-jobs/*/retry', expiredRetry);
  await page.locator('#retryImport').click();
  await visibleText('#importProgress', '导入记录已过期');
  assert.equal(await page.locator('#retryImport').isVisible(), false);
  assert.equal(await page.locator('#importDirectory').isEnabled(), true);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ipeitu.activeImportJob')), null);
  await page.unroute('**/api/import-jobs/*/retry', expiredRetry);
  await page.locator('#toggleImport').click();

  await page.locator('#searchInput').fill(filename);
  await visibleText('#resultCount', '1 / 5 张');
  await page.locator('.asset-card').click();
  if (await page.locator('#favoriteButton').getAttribute('aria-pressed') !== 'true') {
    await page.locator('#favoriteButton').click();
    await page.waitForFunction(() => document.querySelector('#favoriteButton').getAttribute('aria-pressed') === 'true');
  }
  const original = (await library()).assets.find(asset => asset.name === filename);
  const failTrash = route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"验收用移出失败"}' });
  await page.route('**/api/assets/*/trash', failTrash);
  await page.locator('#editMetadata').click();
  await page.locator('#trashButton').click();
  await visibleText('#metadataError', '验收用移出失败');
  assert.equal(await page.locator('#metadataDialog').isVisible(), true);
  assert.equal(await page.locator('.asset-card').count(), 1);
  assert.equal((await library()).total, 5);
  await page.unroute('**/api/assets/*/trash', failTrash);
  await page.locator('#trashButton').click();
  await visibleText('#resultCount', '0 / 4 张');
  assert.equal((await library('favorites')).assets.length, 0);
  assert.equal((await library('recent')).assets.some(asset => asset.id === original.id), false);
  await page.reload();
  await page.locator('#viewTrash').click();
  await visibleText('#resultCount', '1 张');
  await page.locator('.asset-card').click();
  assert.equal(await page.locator('.card-add').count(), 0, '回收站不显示添加按钮');
  for (const selector of ['#replaceButton', '#editMetadata', '#favoriteButton']) {
    assert.ok(!(await page.locator(selector).isVisible()) || await page.locator(selector).isDisabled(), `回收站禁止 ${selector}`);
  }
  assert.equal(await page.locator('#moveToTrash').isVisible(), false, '回收站中不显示移到回收站');
  assert.equal(await page.locator('#purgeButton').isVisible(), true, '回收站中可永久删除所选素材');
  assert.equal(await page.locator('#clearAssetTrash').isVisible(), true, '回收站显示清空入口');
  await page.locator('#previewButton').click();
  await page.waitForFunction(() => document.querySelector('#previewImage').naturalWidth === 1200);
  await page.keyboard.press('Escape');
  const preview = await fetch(`${base}${original.imageUrl}`);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), picture, '移出保留原图字节');
  await page.route('**/api/assets/*/trash', failTrash);
  await page.locator('#restoreButton').click();
  await visibleText('#actionStatus', '验收用移出失败');
  assert.equal(await page.locator('.asset-card').count(), 1);
  await page.unroute('**/api/assets/*/trash', failTrash);
  await page.locator('#restoreButton').click();
  await visibleText('#resultCount', '0 张');
  await page.locator('#viewFavorites').click();
  await visibleText('#resultCount', '1 张');
  const restored = (await library('favorites')).assets[0];
  assert.equal(restored.id, original.id);
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.lastInsertedAt, original.lastInsertedAt, '恢复保留原使用记录');
  assert.deepEqual(restored.aliases, original.aliases);
  await page.locator('#viewAll').click();
  await visibleText('#resultCount', '5 张');
  console.log('导入整理 UI 验收通过：文件夹同名素材、失败单独重试、目录任务查询恢复、修复后重试、移出/恢复失败保留状态、回收站预览与操作限制、收藏及最近记录恢复。');
}

// 素材回收站：单张与 Ctrl 多选移出前确认，永久删除与清空回收站前确认；确认期间回收站内容变化时不执行。
export async function verifyAssetPurge({ page, base, seed }) {
  async function visibleText(selector, text) {
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
  }
  const library = async (view = 'all') => (await fetch(`${base}/api/library?view=${view}`)).json();
  const colors = ['#5a6f7c', '#7c6a5a', '#5a7c62', '#7c5a74'];
  const names = ['回收甲.png', '回收乙.png', '回收丙.png', '回收丁.png'];
  const assets = await seed(base, await Promise.all(names.map(async (name, index) => ({
    name, buffer: await sharp({ create: { width: 320 + index * 40, height: 240, channels: 3, background: colors[index] } }).png().toBuffer(),
  }))));
  const id = name => assets.find(asset => asset.name === name).id;
  const card = name => page.locator(`.asset-card[aria-label^="选择 ${name}"]`);
  const dialog = page.locator('#trashDialog');
  const post = (url, body, method = 'POST') => fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`${base}/taskpane.html`);
  await visibleText('#resultCount', '4 张');

  // 单张移出：详情区的“移到回收站”先确认，取消不改动。
  await card('回收甲.png').click();
  await page.locator('#moveToTrash').click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#trashTitle').textContent(), '移到回收站');
  assert.match(await page.locator('#trashDescription').textContent(), /「回收甲\.png」移到回收站？移出后可以恢复/);
  await page.locator('#cancelTrash').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await library()).total, 4, '取消不移出');
  await page.locator('#moveToTrash').click();
  await page.locator('#confirmTrash').click();
  await visibleText('#actionStatus', '已将 1 张素材移到回收站');
  await visibleText('#resultCount', '3 张');

  // Ctrl 点击多选：已选图片与新点的图片一起进入多选，批量移出后退出多选。
  await card('回收乙.png').click();
  await card('回收丙.png').click({ modifiers: ['Control'] });
  assert.equal(await page.locator('#batchBar').isVisible(), true, 'Ctrl 点击进入多选');
  await visibleText('#batchCount', '已选 2 张');
  assert.equal(await page.locator('#batchTrash').textContent(), '移到回收站');
  await page.locator('#batchTrash').click();
  await dialog.waitFor({ state: 'visible' });
  assert.match(await page.locator('#trashDescription').textContent(), /选中的 2 张素材移到回收站/);
  await page.locator('#confirmTrash').click();
  await visibleText('#actionStatus', '已将 2 张素材移到回收站');
  await visibleText('#resultCount', '1 张');
  await page.waitForFunction(() => document.querySelector('#batchBar').hidden, null, { timeout: 5000 });

  // 回收站：永久删除所选素材，取消不删除；确认期间素材被恢复时服务拒绝，界面提示后不删除。
  await page.locator('#viewTrash').click();
  await visibleText('#resultCount', '3 张');
  assert.equal(await page.locator('#clearAssetTrash').isEnabled(), true);
  await card('回收甲.png').click();
  await page.locator('#purgeButton').click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#trashTitle').textContent(), '永久删除素材');
  assert.match(await page.locator('#trashDescription').textContent(), /永久删除「回收甲\.png」？删除后无法恢复/);
  assert.equal(await page.locator('#confirmTrash').getAttribute('data-permanent'), '', '永久删除按钮使用警示样式');
  await page.locator('#cancelTrash').click();
  assert.equal((await library('trash')).assets.length, 3, '取消不删除');
  await page.locator('#purgeButton').click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal((await post(`/api/assets/${id('回收甲.png')}/trash`, { trashed: false }, 'PATCH')).status, 200);
  await page.locator('#confirmTrash').click();
  await visibleText('#trashError', '只能永久删除回收站中的素材');
  assert.equal(await dialog.isVisible(), true, '失败时弹窗保留并说明原因');
  assert.equal((await library()).assets.some(asset => asset.id === id('回收甲.png')), true, '已恢复的素材不被删除');
  await page.locator('#cancelTrash').click();
  await page.locator('#viewAll').click();
  await visibleText('#resultCount', '2 张');
  await page.locator('#viewTrash').click();
  await visibleText('#resultCount', '2 张');
  await card('回收乙.png').click();
  await page.locator('#purgeButton').click();
  await page.locator('#confirmTrash').click();
  await visibleText('#actionStatus', '已永久删除 1 张素材');
  await visibleText('#resultCount', '1 张');
  assert.equal((await fetch(`${base}/api/assets/${id('回收乙.png')}/image`)).status, 404, '永久删除移除原图');

  // 清空回收站：确认期间有素材移入，服务按确认时的回收站版本拒绝，界面刷新后需重新确认。
  await page.locator('#clearAssetTrash').click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#trashTitle').textContent(), '清空回收站');
  assert.match(await page.locator('#trashDescription').textContent(), /全部 1 张素材/);
  assert.equal((await post('/api/assets/batch/trash', { ids: [id('回收丁.png')] })).status, 200);
  await page.locator('#confirmTrash').click();
  await visibleText('#actionStatus', '回收站内容已变化');
  await dialog.waitFor({ state: 'hidden' });
  await visibleText('#resultCount', '2 张');
  assert.equal((await library('trash')).assets.length, 2, '内容变化后不清空');
  await page.locator('#clearAssetTrash').click();
  assert.match(await page.locator('#trashDescription').textContent(), /全部 2 张素材/);
  await page.locator('#confirmTrash').click();
  await visibleText('#actionStatus', '已清空回收站，永久删除 2 张素材');
  await visibleText('#stateTitle', '回收站为空');
  assert.equal((await library('trash')).assets.length, 0);
  assert.deepEqual((await library()).assets.map(asset => asset.name), ['回收甲.png']);
  console.log('素材回收站 UI 验收通过：单张与 Ctrl 多选移出确认、取消不改动、永久删除确认与警示、确认期间恢复时拒绝删除、清空回收站及确认期间内容变化需重新确认。');
}
