import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startServer } from '../server/http.js';

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) return entry.address;
    }
  }
  return null;
}

// 素材库连接局域网图库：密钥错误提示、连接后列出服务器素材、知识库窗格标记、切回本机。
// 服务器经本机的局域网地址访问，与另一台电脑的访问路径相同。
export async function verifyLan({ page, base, temporary }) {
  const lanIp = lanAddress();
  if (!lanIp) {
    console.log('局域网 UI 验收跳过：本机没有可用的局域网 IPv4 地址');
    return false;
  }
  const key = randomBytes(32).toString('base64url');
  // 系统分配的端口偶尔落在 Fetch 禁用的端口上，换一个重试。
  let upstream;
  for (let attempt = 0; !upstream; attempt++) {
    const started = await startServer({ port: 0, host: '0.0.0.0', accessKey: key, dataDirectory: path.join(temporary, 'lan-server') });
    try {
      await (await fetch(`http://127.0.0.1:${started.server.address().port}/api/health`)).arrayBuffer();
      upstream = started;
    } catch (error) {
      await new Promise(resolve => started.server.close(resolve));
      if (error.cause?.message !== 'bad port' || attempt === 9) throw error;
    }
  }
  try {
    const picture = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#3a6f8f' } }).png().toBuffer();
    await upstream.library.importFile('局域网样图.png', picture);
    const serverAddress = `${lanIp}:${upstream.server.address().port}`;
    const visibleText = (selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${base}/taskpane.html`);
    await visibleText('#sourceButton', '本机');
    assert.equal(await page.locator('#importScope').textContent(), '仅保存在本机');
    await page.locator('#sourceButton').click();
    await page.locator('#connectionDialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#useLocal').isVisible(), false, '本机模式不显示切回按钮');
    await page.locator('#connectServer').click();
    await visibleText('#connectionError', '请填写服务器地址');
    await page.locator('#serverUrl').fill(serverAddress);
    await page.locator('#accessKey').fill(randomBytes(32).toString('base64url'));
    await page.locator('#connectServer').click();
    await visibleText('#connectionError', '访问密钥不正确');
    assert.equal(await page.locator('#serverUrl').inputValue(), serverAddress, '连接失败保留已填地址');
    assert.equal(await noOverflow(), true, '320 宽对话框无横向溢出');

    await page.locator('#accessKey').fill(key);
    await page.locator('#connectServer').click();
    await visibleText('#sourceButton', '局域网');
    assert.equal(await page.locator('#connectionDialog').isVisible(), false);
    assert.equal(await page.locator('#sourceButton').evaluate(button => button.classList.contains('is-lan')), true);
    assert.match(await page.locator('#sourceButton').getAttribute('title'), new RegExp(serverAddress.replace(/\./g, '\\.')));
    await visibleText('#actionStatus', '已连接局域网图库');
    await visibleText('#resultCount', '1 张');
    await page.locator('.asset-card', { hasText: '局域网样图' }).waitFor();
    assert.equal(await page.locator('#importScope').textContent(), '保存到局域网图库');
    assert.equal(await noOverflow(), true, '320 宽顶栏无横向溢出');
    await page.setViewportSize({ width: 420, height: 800 });
    assert.equal(await noOverflow(), true, '420 宽无横向溢出');

    // 局域网客户端可移入回收站与恢复；永久删除和清空回收站只能在服务器本机操作，服务器返回 403 与说明。
    const localOnly = '只能在服务器那台电脑上操作';
    await page.locator('.asset-card', { hasText: '局域网样图' }).click();
    await page.locator('#moveToTrash').click();
    await page.locator('#trashDialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#trashDescription').textContent(), /移到回收站/);
    await page.locator('#confirmTrash').click();
    await visibleText('#actionStatus', '已将 1 张素材移到回收站');
    await page.locator('#viewTrash').click();
    await visibleText('#resultCount', '1 张');
    await page.locator('.asset-card', { hasText: '局域网样图' }).click();
    await page.locator('#purgeButton').click();
    assert.match(await page.locator('#trashDescription').textContent(), /从共享图库永久删除/);
    await page.locator('#confirmTrash').click();
    await visibleText('#trashError', localOnly);
    await page.locator('#cancelTrash').click();
    await page.locator('#clearAssetTrash').click();
    await page.locator('#confirmTrash').click();
    await visibleText('#trashError', localOnly);
    await page.locator('#cancelTrash').click();
    assert.equal(upstream.library.list('', { view: 'trash' }).assets.length, 1, '远程永久删除被拒绝，服务器回收站不变');
    await page.locator('.asset-card', { hasText: '局域网样图' }).click();
    await page.locator('#restoreButton').click();
    await visibleText('#actionStatus', '已恢复到图库');
    await page.locator('#viewAll').click();
    await visibleText('#resultCount', '1 张');
    const knowledgeTrash = await (await fetch(`${base}/api/knowledge?view=trash`)).json();
    const knowledgePurge = await fetch(`${base}/api/knowledge/trash/purge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true, revision: knowledgeTrash.trashRevision }),
    });
    assert.equal(knowledgePurge.status, 403, '远程清空知识库回收站被拒绝');
    assert.match((await knowledgePurge.json()).error, new RegExp(localOnly));

    await page.goto(`${base}/knowledge.html`);
    await page.locator('#sourceBadge').waitFor({ state: 'visible' });
    await visibleText('#stateTitle', '知识库还没有片段');

    await page.goto(`${base}/taskpane.html`);
    await visibleText('#sourceButton', '局域网');
    await page.locator('#sourceButton').click();
    await page.locator('#connectionDialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#serverUrl').inputValue(), `http://${serverAddress}`);
    assert.equal(await page.locator('#accessKey').inputValue(), '', '不回显已保存的密钥');
    await page.locator('#useLocal').click();
    await visibleText('#sourceButton', '本机');
    await visibleText('#actionStatus', '已切回本机图库');
    assert.equal(await page.locator('#importScope').textContent(), '仅保存在本机');
    await page.waitForFunction(() => !document.querySelector('.asset-card') || ![...document.querySelectorAll('.asset-card')].some(card => card.textContent.includes('局域网样图')));
    return true;
  } finally {
    upstream.server.closeAllConnections();
    await new Promise(resolve => upstream.server.close(resolve));
  }
}
