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
  await page.reload();
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
  for (const selector of ['#insertButton', '#replaceButton', '#editMetadata', '#favoriteButton']) {
    assert.ok(!(await page.locator(selector).isVisible()) || await page.locator(selector).isDisabled(), `回收站禁止 ${selector}`);
  }
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
