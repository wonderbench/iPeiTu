import assert from 'node:assert/strict';
import sharp from 'sharp';

export async function verifyLibraryManagement({ page, base }) {
  async function visibleText(selector, text) {
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
  }
  const library = async (query = '') => (await fetch(`${base}/api/library${query}`)).json();
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`${base}/taskpane.html`);
  await page.locator('.asset-card').first().waitFor();
  const before = await library();

  // 比例筛选在对话框中，摘要显示“竖图”。
  const portrait = await library('?orientation=portrait');
  await page.locator('#openFilters').click();
  await visibleText('#filterOrientations', `竖图 ${portrait.assets.length}`);
  await page.locator('#filterOrientations input[value="portrait"]').check();
  await page.locator('#applyFilters').click();
  await visibleText('#resultCount', `${portrait.assets.length} / ${before.total} 张`);
  await visibleText('#filterSummary', '竖图');
  await page.locator('#clearFilters').click();
  await visibleText('#resultCount', `${before.total} 张`);

  // 多选：点卡片只勾选，不改变当前所选图片；批量添加分类与标签后可按新分类筛选。
  await page.locator('#toggleMulti').click();
  assert.equal(await page.locator('#batchBar').isVisible(), true);
  assert.equal(await page.locator('#batchEdit').isDisabled(), true);
  await page.locator('.asset-card').nth(0).click();
  await page.locator('.asset-card').nth(1).click();
  await visibleText('#batchCount', '已选 2 张');
  await visibleText('#selectedName', '尚未选择图片');
  assert.equal(await page.locator('.asset-card[aria-pressed="true"]').count(), 2);
  await page.locator('.asset-card').nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await visibleText('#batchCount', '已选 2 张');
  const selectedIds = await page.locator('.asset-card[aria-pressed="true"]').evaluateAll(cards => cards.map(card => card.dataset.id));

  await page.locator('#batchEdit').click();
  await page.locator('#applyBatch').click();
  await visibleText('#batchError', '请至少填写一项');
  await page.locator('#batchAddCategories').fill('批量分类');
  await page.locator('#batchAddTags').fill('批量标签');
  const failBatch = route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"验收用批量失败"}' });
  await page.route('**/api/assets/batch', failBatch);
  await page.locator('#applyBatch').click();
  await visibleText('#batchError', '未修改任何图片：验收用批量失败');
  await page.unroute('**/api/assets/batch', failBatch);
  await page.locator('#applyBatch').click();
  await visibleText('#actionStatus', '已更新 2 张素材');
  assert.equal(await page.locator('#batchDialog').isVisible(), false);
  await visibleText('#batchCount', '已选 0 张');
  const updated = (await library()).assets.filter(asset => selectedIds.includes(asset.id));
  assert.ok(updated.length === 2 && updated.every(asset => asset.categories.includes('批量分类') && asset.tags.includes('批量标签')));
  await page.locator('#categoryChips button', { hasText: '批量分类' }).click();
  await visibleText('#resultCount', `2 / ${before.total} 张`);
  await page.locator('#categoryChips button', { hasText: '全部分类' }).click();
  await visibleText('#resultCount', `${before.total} 张`);
  await page.locator('#batchSelectAll').click();
  await visibleText('#batchCount', `已选 ${before.total} 张`);
  await page.locator('#toggleMulti').click();
  assert.equal(await page.locator('#batchBar').isVisible(), false);
  assert.equal(await page.locator('.asset-card[aria-pressed="true"]').count(), 0, '退出多选清空勾选');

  // 粘贴截图：按时间命名导入；在输入框中粘贴不拦截。
  const pasted = await sharp({ create: { width: 320, height: 640, channels: 3, background: '#4f6d7a' } }).png().toBuffer();
  await page.evaluate(bytes => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...pasted]);
  await visibleText('#importProgress', '导入 1 张，重复 0 张，失败 0 项');
  await visibleText('#resultCount', `${before.total + 1} 张`);
  assert.ok((await library()).assets.some(asset => /^粘贴图片-\d{8}-\d{6}\.png$/.test(asset.name)), '粘贴的图片按时间命名');
  const intercepted = await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'image.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.getElementById('searchInput').dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(intercepted, false, '检索框中的粘贴交给输入框');

  // 拖入文件：工作区显示投放提示，松开后导入。
  const dropped = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#7a5f4f' } }).png().toBuffer();
  const highlighted = await page.evaluate(bytes => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], '拖入测试.png', { type: 'image/png' }));
    const target = document.getElementById('workspace');
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    const active = target.classList.contains('drop-active');
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    return active && !target.classList.contains('drop-active');
  }, [...dropped]);
  assert.equal(highlighted, true, '拖动时高亮，松开后取消');
  await visibleText('#resultCount', `${before.total + 2} 张`);
  assert.ok((await library()).assets.some(asset => asset.name === '拖入测试.png'));

  for (const width of [320, 420]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
      && ['#toggleMulti', '#openFilters'].every(selector => document.querySelector(selector).getBoundingClientRect().right <= innerWidth)), true, `${width}px 素材管理控件完整可见`);
  }
  console.log('素材管理 UI 验收通过：比例筛选、分类按钮、多选与批量设置及失败不改、粘贴与拖入导入、输入框粘贴不拦截、窄窗格布局。');
}
