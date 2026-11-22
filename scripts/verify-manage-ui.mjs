import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createSnippet } from './verify-knowledge-ui.mjs';

const png = (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

// 等待某个框架内元素的文字包含指定内容。
async function frameText(frame, selector, text) {
  await frame.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
}

async function frameByUrl(page, pattern) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame = page.frames().find(item => pattern.test(item.url()));
    if (frame) {
      await frame.waitForLoadState('load');
      return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`没有找到框架 ${pattern}`);
}

// 浏览器资源管理页：两个模块以 iframe 加载素材库与知识库的管理视图，不提供写入文档的操作。
export async function verifyManagePage({ page, base, temporary, choose }) {
  const library = async (view = 'all') => (await fetch(`${base}/api/library?view=${view}`)).json();
  const uploads = [];
  await page.route('**/api/import-file?*', async route => { uploads.push(new URL(route.request().url()).searchParams.get('name')); await route.continue(); });
  await page.setViewportSize({ width: 1080, height: 800 });
  await page.goto(`${base}/manage.html`);
  const assets = await frameByUrl(page, /\/taskpane\.html\?manage=1$/);
  assert.equal(await page.locator('.manage-nav a[href="#assets"]').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('#knowledge').getAttribute('src'), null, '未打开的模块不加载');
  await frameText(assets, '#stateTitle', '先添加一组标书配图');
  for (const selector of ['#toggleBoxes', '#layoutSettingsButton', '#hostStatus', '.wordmark']) {
    assert.equal(await assets.locator(selector).first().isVisible(), false, `管理页隐藏 ${selector}`);
  }

  // 导入图片：选择文件。
  await assets.locator('#toggleImport').click();
  await assets.locator('#fileInput').setInputFiles([
    { name: '管理甲.png', mimeType: 'image/png', buffer: await png(400, 300, '#4e6a73') },
    { name: '管理乙.png', mimeType: 'image/png', buffer: await png(300, 400, '#735a4e') },
  ]);
  await frameText(assets, '#importProgress', '导入 2 张，重复 0 张，失败 0 项');
  await frameText(assets, '#resultCount', '2 张');
  assert.equal(await assets.locator('.card-add').count(), 0, '管理页不显示插入按钮');

  // 输入路径导入：先弹出确认框，显示图库来源；取消不读取，确认后导入。
  const folder = path.join(temporary, '管理导入');
  await mkdir(folder);
  await writeFile(path.join(folder, '路径导入.png'), await png(500, 300, '#5a734e'));
  await assets.locator('#directoryDetails > summary').click();
  await assets.locator('#directoryInput').fill(folder);
  await assets.locator('#importDirectory').click();
  await assets.locator('#folderImportDialog').waitFor({ state: 'visible' });
  assert.equal(await assets.locator('#folderPath').inputValue(), folder);
  assert.equal(await assets.locator('#folderImportScope').textContent(), '仅保存在本机');
  assert.equal(await page.locator('.manage-shell').getAttribute('data-dialog-open'), '', '弹窗打开时遮住管理页顶栏');
  assert.equal(await page.locator('.manage-header').evaluate(header => header.inert), true, '弹窗打开时顶栏不可操作');
  await assets.locator('#cancelFolderImport').click();
  await page.waitForFunction(() => !document.querySelector('.manage-shell').hasAttribute('data-dialog-open'));
  assert.equal((await library()).total, 2, '取消不导入');
  await assets.locator('#importDirectory').click();
  await assets.locator('#confirmFolderImport').click();
  await frameText(assets, '#importProgress', '导入 1 张，重复 0 张，失败 0 项');
  await frameText(assets, '#resultCount', '3 张');

  // 浏览文件夹：用模拟的目录选择器。取消时不读取图片，确认后导入并按相对目录分类。
  await assets.evaluate(async ([first, second]) => {
    const file = (name, bytes) => ({ kind: 'file', name, getFile: async () => new File([new Uint8Array(bytes)], name, { type: 'image/png' }) });
    const folder = {
      kind: 'directory', name: '选择器目录',
      async *values() {
        yield file('选择甲.png', first);
        yield { kind: 'directory', name: '子目录', async *values() { yield file('选择乙.png', second); yield file('说明.txt', [1, 2, 3]); } };
      },
    };
    window.showDirectoryPicker = async () => folder;
  }, [[...await png(320, 240, '#3e5c6b')], [...await png(240, 320, '#6b3e5c')]]);
  uploads.length = 0;
  await assets.locator('#chooseFolder').click();
  await assets.locator('#folderImportDialog').waitFor({ state: 'visible' });
  await assets.locator('#browseFolder').click();
  await frameText(assets, '#folderSelection', '「选择器目录」 · 2 张可导入图片，包含子文件夹');
  assert.equal(await assets.locator('#folderPathField').isVisible(), false, '选定文件夹后隐藏路径输入');
  assert.equal(await assets.locator('#useFolderPath').isVisible(), true);
  await assets.locator('#cancelFolderImport').click();
  assert.deepEqual(uploads, [], '取消时不读取图片');
  await assets.locator('#chooseFolder').click();
  await assets.locator('#browseFolder').click();
  await frameText(assets, '#folderSelection', '2 张可导入图片');
  await assets.locator('#confirmFolderImport').click();
  await frameText(assets, '#importProgress', '导入 2 张，重复 0 张，失败 0 项');
  await frameText(assets, '#resultCount', '5 张');
  const picked = (await library()).assets.filter(asset => asset.name.startsWith('选择'));
  assert.deepEqual(picked.map(asset => [asset.name, asset.categories]).sort(), [['选择乙.png', ['子目录']], ['选择甲.png', ['选择器目录']]].sort());
  await assets.locator('#toggleImport').click();

  // 分类与标签。
  const card = name => assets.locator(`.asset-card[aria-label^="选择 ${name}"]`);
  await card('管理甲.png').click();
  await assets.locator('#editMetadata').click();
  await assets.locator('#metadataDialog').waitFor({ state: 'visible' });
  await assets.locator('#assetCategories').fill('管理分类');
  await assets.locator('#assetTags').fill('管理标签');
  await assets.locator('#saveMetadata').click();
  await frameText(assets, '#actionStatus', '素材信息已保存');
  const edited = (await library()).assets.find(asset => asset.name === '管理甲.png');
  assert.deepEqual([edited.categories, edited.tags], [['管理分类'], ['管理标签']]);
  await frameText(assets, '#selectedCategories', '管理分类');

  // 单张移出与批量移出：都先确认。
  await assets.locator('#moveToTrash').click();
  await assets.locator('#confirmTrash').click();
  await frameText(assets, '#actionStatus', '已将 1 张素材移到回收站');
  await frameText(assets, '#resultCount', '4 张');
  await assets.locator('#toggleMulti').click();
  await card('管理乙.png').click();
  await card('路径导入.png').click();
  assert.equal(await assets.locator('#multiSelectionSummary').textContent(), '已选 2 张图片');
  assert.equal(await assets.locator('#assetDetails').isVisible(), false, '多选时详情区改为选中数量');
  await assets.locator('#batchTrash').click();
  assert.match(await assets.locator('#trashDescription').textContent(), /选中的 2 张素材移到回收站/);
  await assets.locator('#confirmTrash').click();
  await frameText(assets, '#actionStatus', '已将 2 张素材移到回收站');
  await frameText(assets, '#resultCount', '2 张');
  await assets.locator('#toggleMulti').click();

  // 回收站：恢复、永久删除（取消与确认）、清空回收站。
  await assets.locator('#viewTrash').click();
  await frameText(assets, '#resultCount', '3 张');
  await card('管理甲.png').click();
  await assets.locator('#restoreButton').click();
  await frameText(assets, '#actionStatus', '已恢复到图库');
  await frameText(assets, '#resultCount', '2 张');
  const restored = (await library()).assets.find(asset => asset.name === '管理甲.png');
  assert.deepEqual(restored.categories, ['管理分类'], '恢复保留分类');
  await card('管理乙.png').click();
  await assets.locator('#purgeButton').click();
  assert.equal(await assets.locator('#trashTitle').textContent(), '永久删除素材');
  await assets.locator('#cancelTrash').click();
  assert.equal((await library('trash')).assets.length, 2, '取消不删除');
  await assets.locator('#purgeButton').click();
  await assets.locator('#confirmTrash').click();
  await frameText(assets, '#actionStatus', '已永久删除 1 张素材');
  await assets.locator('#clearAssetTrash').click();
  assert.match(await assets.locator('#trashDescription').textContent(), /全部 1 张素材/);
  await assets.locator('#confirmTrash').click();
  await frameText(assets, '#actionStatus', '已清空回收站，永久删除 1 张素材');
  await frameText(assets, '#stateTitle', '回收站为空');
  await assets.locator('#viewAll').click();
  await frameText(assets, '#resultCount', '3 张');

  // 知识库模块：首次切换时加载，新建与编辑片段，不提供插入与收录。
  await page.locator('.manage-nav a[href="#knowledge"]').click();
  const knowledge = await frameByUrl(page, /\/knowledge\.html\?manage=1$/);
  assert.equal(await page.locator('#assets').isHidden(), true);
  assert.equal(await page.locator('.manage-nav a[href="#knowledge"]').getAttribute('aria-current'), 'page');
  await frameText(knowledge, '#stateTitle', '知识库还没有片段');
  for (const selector of ['#captureSelection', '.insert-options', '#hostStatus']) {
    assert.equal(await knowledge.locator(selector).isVisible(), false, `知识库管理隐藏 ${selector}`);
  }
  await knowledge.locator('#newSnippet').click();
  await knowledge.locator('#snippetTitle').fill('管理页片段');
  await choose(page, 'snippetType', '通用措施', { scope: knowledge });
  await knowledge.locator('#snippetSection').fill('安全措施');
  await knowledge.locator('#snippetBody').fill('# 安全管理\n设置专职安全员。');
  await knowledge.locator('#saveSnippet').click();
  await frameText(knowledge, '#actionStatus', '已保存「管理页片段」');
  assert.equal(await knowledge.locator('.card-add').count(), 0, '管理页不显示插入按钮');
  await knowledge.locator('#editSnippet').click();
  await knowledge.locator('#snippetDialog').waitFor({ state: 'visible' });
  await knowledge.locator('#snippetSection').fill('文明施工');
  await knowledge.locator('#saveSnippet').click();
  await frameText(knowledge, '#previewMeta', '通用措施 · 文明施工');

  // 编辑草稿在切换模块后保留：顶栏在弹窗期间不可操作，这里直接改地址栏的模块锚点。
  await knowledge.locator('#newSnippet').click();
  await knowledge.locator('#snippetTitle').fill('未保存的草稿');
  await page.evaluate(() => { location.hash = '#assets'; });
  await page.locator('#assets').waitFor({ state: 'visible' });
  await page.evaluate(() => { location.hash = '#knowledge'; });
  await page.locator('#knowledge').waitFor({ state: 'visible' });
  assert.equal(await knowledge.locator('#snippetDialog').isVisible(), true, '切换模块不关闭编辑框');
  assert.equal(await knowledge.locator('#snippetTitle').inputValue(), '未保存的草稿', '切换模块保留草稿');
  await knowledge.locator('#cancelSnippet').click();

  // 任务窗格读取管理页保存的数据。
  const pane = await page.context().newPage();
  await pane.goto(`${base}/taskpane.html`);
  await pane.waitForFunction(() => document.querySelector('#resultCount')?.textContent === '3 张');
  assert.equal(await pane.locator('.card-add').count(), 3, '任务窗格保留插入按钮');
  await pane.goto(`${base}/knowledge.html`);
  await pane.locator('.snippet-item', { hasText: '管理页片段' }).waitFor();
  await pane.close();
  console.log('资源管理页 UI 验收通过：模块切换与按需加载、写入文档控件隐藏、选择文件导入、路径导入确认与取消、模拟目录选择器（取消不读取、相对目录分类）、分类标签、单张与批量移出确认、回收站恢复、永久删除取消与确认、清空回收站、弹窗遮挡顶栏、知识库新建与编辑、切换模块保留草稿、任务窗格读取同一数据。');
}

// 编辑锁：同一素材或片段只能在一个页面编辑；对方保存或退出后才能打开，打开时读到最新内容。
export async function verifyEditLocks({ page, context, base, seed, choose }) {
  const [asset] = await seed(base, [{ name: '锁定样图.png', buffer: await png(400, 300, '#516b5e') }]);
  const snippet = await createSnippet(base, { title: '锁定片段', body: '原正文。' });
  const busyAsset = '「锁定样图.png」的素材信息正在编辑';
  const busySnippet = '这条片段正在被编辑';
  const released = target => target.waitForResponse(response => /\/edit-lock$/.test(new URL(response.url()).pathname)
    && response.request().method() === 'PATCH' && response.request().postData()?.includes('"release":true'));

  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`${base}/taskpane.html`);
  const other = await context.newPage();
  await other.setViewportSize({ width: 1080, height: 800 });
  await other.goto(`${base}/manage.html`);
  const manage = await frameByUrl(other, /\/taskpane\.html\?manage=1$/);

  // 素材窗格先打开素材信息；管理页再打开同一素材被拒绝，批量设置整批停止。
  await page.locator('.asset-card').first().click();
  await page.locator('#editMetadata').click();
  await page.locator('#metadataDialog').waitFor({ state: 'visible' });
  await manage.locator('.asset-card').first().click();
  await manage.locator('#editMetadata').click();
  await frameText(manage, '#actionStatus', busyAsset);
  assert.equal(await manage.locator('#metadataDialog').isVisible(), false, '被锁定时不打开编辑框');
  await manage.locator('#toggleMulti').click();
  await manage.locator('.asset-card').first().click();
  await manage.locator('#batchEdit').click();
  await manage.locator('#batchAddTags').fill('批量标签');
  await manage.locator('#applyBatch').click();
  await frameText(manage, '#batchError', busyAsset);
  await manage.locator('#cancelBatch').click();
  await manage.locator('#toggleMulti').click();
  assert.deepEqual((await (await fetch(`${base}/api/library`)).json()).assets[0].tags, [], '锁定时批量设置不改动');

  // 素材窗格保存后锁释放；管理页重新打开读到最新名称。
  await page.locator('#assetName').fill('锁定样图-新.png');
  await page.locator('#saveMetadata').click();
  await page.waitForFunction(() => document.querySelector('#actionStatus')?.textContent.includes('素材信息已保存'));
  await manage.locator('.asset-card').first().click();
  await manage.locator('#editMetadata').click();
  await manage.locator('#metadataDialog').waitFor({ state: 'visible' });
  assert.equal(await manage.locator('#assetName').inputValue(), '锁定样图-新.png', '打开时读取最新信息');
  // 管理页编辑期间，素材窗格反过来被拒绝。
  await page.locator('#editMetadata').click();
  await page.waitForFunction(text => document.querySelector('#actionStatus')?.textContent.includes(text), '「锁定样图-新.png」的素材信息正在编辑');
  const assetReleased = released(other);
  await manage.locator('#cancelMetadata').click();
  await assetReleased;
  await page.locator('#editMetadata').click();
  await page.locator('#metadataDialog').waitFor({ state: 'visible' });
  const paneReleased = released(page);
  await page.locator('#cancelMetadata').click();
  await paneReleased;
  assert.equal(asset.name, '锁定样图.png');

  // 片段：知识库窗格编辑期间，管理页的编辑与移到回收站被拒绝，但仍可查看。
  await page.goto(`${base}/knowledge.html`);
  await other.locator('.manage-nav a[href="#knowledge"]').click();
  const knowledge = await frameByUrl(other, /\/knowledge\.html\?manage=1$/);
  await page.locator('.snippet-item', { hasText: '锁定片段' }).locator('.snippet-card').click();
  await page.locator('#editSnippet').click();
  await page.locator('#snippetDialog').waitFor({ state: 'visible' });
  await knowledge.locator('.snippet-item', { hasText: '锁定片段' }).locator('.snippet-card').click();
  await frameText(knowledge, '#previewTitle', '锁定片段');
  await knowledge.locator('#editSnippet').click();
  await frameText(knowledge, '#actionStatus', busySnippet);
  assert.equal(await knowledge.locator('#snippetDialog').isVisible(), false);
  await knowledge.locator('#trashSnippet').click();
  await frameText(knowledge, '#actionStatus', busySnippet);
  assert.equal((await (await fetch(`${base}/api/knowledge`)).json()).snippets.length, 1, '锁定时不能移到回收站');

  await page.locator('#snippetBody').fill('窗格修改后的正文。');
  await choose(page, 'snippetType', '通用措施');
  await page.locator('#saveSnippet').click();
  await page.waitForFunction(() => document.querySelector('#actionStatus')?.textContent.includes('已保存「锁定片段」'));
  await knowledge.locator('#editSnippet').click();
  await knowledge.locator('#snippetDialog').waitFor({ state: 'visible' });
  assert.equal(await knowledge.locator('#snippetBody').inputValue(), '窗格修改后的正文。', '打开时读取最新正文');
  const snippetReleased = released(other);
  await knowledge.locator('#cancelSnippet').click();
  await snippetReleased;
  assert.equal(snippet.title, '锁定片段');
  await other.close();
  console.log('编辑锁 UI 验收通过：素材窗格与管理页互斥编辑同一素材、锁定时批量设置整批停止、保存或取消后释放并读取最新信息、知识库片段的编辑与移到回收站在锁定时被拒绝且仍可查看。');
}
