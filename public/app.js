import { captureInsertionTarget, getHostStatus, insertPicture } from './wps-bridge.js';
import { normalizeLayoutOptions } from './layout-options.js';
import { loadLayoutPreferences, saveLayoutPreferences } from './layout-preferences.js';

const element = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'toggleImport', 'importPanel', 'chooseFiles', 'fileInput', 'directoryForm',
  'directoryInput', 'importDirectory', 'importProgress', 'importFailures',
  'failureSummary', 'failureList', 'searchInput', 'clearSearch', 'resultCount',
  'libraryState', 'stateTitle', 'stateDescription', 'stateAction', 'assetGrid',
  'previewButton', 'selectedThumbnail', 'previewPlaceholder', 'selectedName',
  'selectedMeta', 'insertButton', 'hostStatus', 'actionStatus', 'previewDialog',
  'previewTitle', 'closePreview', 'previewImage', 'previewError', 'previewMeta',
  'layoutSettingsButton', 'layoutDialog', 'layoutForm', 'widthMode', 'widthCm',
  'maxHeightCm', 'layoutMode', 'includeCaption', 'captionFields', 'captionText',
  'layoutError', 'saveLayout', 'cancelLayout', 'resetLayout',
].map((id) => [id, element(id)]));

let selected = null;
let hostAvailable = false;
let importing = false;
let inserting = false;
let requestVersion = 0;
let searchTimer;
let libraryRequest;
let stateAction = null;
let layoutPreferences = { ...normalizeLayoutOptions(), includeCaption: false };
let captionDraft = '';

function defaultCaption(asset) {
  return asset ? asset.name.replace(/\.(?:png|jpe?g|webp)$/i, '').slice(0, 200) : '';
}

function updateLayoutSummary() {
  const summary = [layoutPreferences.widthMode === 'auto' ? '自适应' : `宽 ${layoutPreferences.widthCm} 厘米`];
  if (layoutPreferences.maxHeightCm !== null) summary.push(`高不超 ${layoutPreferences.maxHeightCm} 厘米`);
  summary.push(layoutPreferences.layout === 'centered' ? '独立居中'
    : layoutPreferences.includeCaption ? '独立段落，沿用对齐' : '原段落');
  if (layoutPreferences.includeCaption) summary.push('带图题');
  ui.layoutSettingsButton.textContent = `排版设置 · ${summary.join(' · ')}`;
}

function syncLayoutFields() {
  ui.widthCm.disabled = ui.widthMode.value !== 'fixed';
  if (ui.widthCm.disabled && (!Number.isFinite(ui.widthCm.valueAsNumber)
    || ui.widthCm.valueAsNumber < 0.5 || ui.widthCm.valueAsNumber > 50)) {
    ui.widthCm.value = String(layoutPreferences.widthCm);
  }
  ui.captionFields.hidden = !ui.includeCaption.checked;
  ui.captionText.disabled = !ui.includeCaption.checked || !selected;
}

function fillLayoutForm(preferences, caption) {
  ui.widthMode.value = preferences.widthMode;
  ui.widthCm.value = String(preferences.widthCm);
  ui.maxHeightCm.value = preferences.maxHeightCm === null ? '' : String(preferences.maxHeightCm);
  ui.layoutMode.value = preferences.layout;
  ui.includeCaption.checked = preferences.includeCaption;
  ui.captionText.value = caption;
  ui.layoutError.hidden = true;
  syncLayoutFields();
}

function insertionOptions() {
  const caption = layoutPreferences.includeCaption ? captionDraft : '';
  if (layoutPreferences.includeCaption && !caption.trim()) throw new Error('请填写图题，或在排版设置中关闭“添加图题”');
  return normalizeLayoutOptions({ ...layoutPreferences, caption });
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `操作失败（${response.status}）`);
  return data;
}

function readableError(error) {
  return error instanceof TypeError ? '无法连接本机图库服务，请确认服务正在运行' : error.message;
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function metadata(asset) {
  return `${asset.width} × ${asset.height} · ${asset.format.toUpperCase()} · ${formatSize(asset.bytes)}`;
}

function showAction(message, error = false) {
  ui.actionStatus.textContent = message;
  ui.actionStatus.classList.toggle('error', error);
  ui.actionStatus.hidden = !message;
}

function refreshHost() {
  try {
    const status = getHostStatus();
    hostAvailable = status.available;
    ui.hostStatus.textContent = typeof globalThis.Application === 'undefined'
      ? `浏览器模式 · ${status.message}` : status.message;
  } catch (error) {
    hostAvailable = false;
    ui.hostStatus.textContent = error.message;
  }
  ui.insertButton.disabled = !selected || !hostAvailable || inserting;
}

function selectAsset(asset) {
  if (asset?.id !== selected?.id) captionDraft = defaultCaption(asset);
  selected = asset;
  for (const card of ui.assetGrid.children) {
    card.setAttribute('aria-pressed', String(card.dataset.id === asset?.id));
  }
  ui.previewButton.disabled = !asset;
  ui.selectedThumbnail.hidden = !asset;
  ui.previewPlaceholder.hidden = Boolean(asset);
  ui.selectedName.textContent = asset ? asset.name : '尚未选择图片';
  ui.selectedName.title = asset ? asset.name : '';
  ui.selectedMeta.textContent = asset ? `${asset.width} × ${asset.height} · 点击左图预览` : '点击素材查看并选择';
  if (asset) ui.selectedThumbnail.src = asset.thumbnailUrl;
  else ui.selectedThumbnail.removeAttribute('src');
  showAction('');
  refreshHost();
}

function showLibraryState(title, description, actionLabel = '', action = null) {
  ui.libraryState.hidden = false;
  ui.stateTitle.textContent = title;
  ui.stateDescription.textContent = description;
  ui.stateAction.textContent = actionLabel;
  ui.stateAction.hidden = !action;
  stateAction = action;
}

function openImport() {
  ui.importPanel.hidden = false;
  ui.toggleImport.setAttribute('aria-expanded', 'true');
  ui.chooseFiles.focus();
}

function renderAssets(assets) {
  const fragment = document.createDocumentFragment();
  for (const asset of assets) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'asset-card';
    card.dataset.id = asset.id;
    card.setAttribute('aria-pressed', String(asset.id === selected?.id));
    card.setAttribute('aria-label', `选择 ${asset.name}`);
    const thumbnail = document.createElement('span');
    thumbnail.className = 'thumbnail-wrap';
    const image = document.createElement('img');
    image.src = asset.thumbnailUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      const text = document.createElement('span');
      text.className = 'thumbnail-error';
      text.textContent = '缩略图不可用';
      thumbnail.replaceChildren(text);
    }, { once: true });
    thumbnail.append(image);
    const caption = document.createElement('span');
    caption.className = 'asset-caption';
    const name = document.createElement('span');
    name.className = 'asset-name';
    name.textContent = asset.name;
    name.title = asset.name;
    const details = document.createElement('span');
    details.className = 'asset-details';
    const size = document.createElement('span');
    size.textContent = `${asset.width} × ${asset.height}`;
    const label = document.createElement('span');
    label.className = 'selection-label';
    label.textContent = '已选';
    label.setAttribute('aria-hidden', 'true');
    details.append(size, label);
    caption.append(name, details);
    card.append(thumbnail, caption);
    card.addEventListener('click', () => selectAsset(asset));
    fragment.append(card);
  }
  ui.assetGrid.replaceChildren(fragment);
}

async function loadLibrary() {
  const version = ++requestVersion;
  libraryRequest?.abort();
  libraryRequest = new AbortController();
  const query = ui.searchInput.value.trim();
  ui.assetGrid.setAttribute('aria-busy', 'true');
  ui.resultCount.textContent = '正在检索';
  try {
    const data = await request(`/api/library?q=${encodeURIComponent(query)}`, { signal: libraryRequest.signal });
    if (version !== requestVersion) return;
    renderAssets(data.assets);
    ui.resultCount.textContent = query ? `${data.assets.length} / ${data.total} 张` : `${data.total} 张`;
    ui.libraryState.hidden = data.assets.length > 0;
    if (!data.assets.length) {
      if (query) showLibraryState('没有找到匹配图片', '换一个图片名称，或清空搜索查看全部素材', '清空搜索', clearSearch);
      else showLibraryState('先添加一组标书配图', '导入本地图片后，就可以按名称查找并插入标书', '导入素材', openImport);
    }
    if (selected) selectAsset(data.assets.find((asset) => asset.id === selected.id) || null);
  } catch (error) {
    if (version !== requestVersion || error.name === 'AbortError') return;
    renderAssets([]);
    selectAsset(null);
    ui.resultCount.textContent = '读取失败';
    showLibraryState('图库暂时无法读取', readableError(error), '重新读取', loadLibrary);
  } finally {
    if (version === requestVersion) ui.assetGrid.setAttribute('aria-busy', 'false');
  }
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  requestVersion += 1;
  libraryRequest?.abort();
  ui.clearSearch.hidden = !ui.searchInput.value;
  selectAsset(null);
  searchTimer = setTimeout(loadLibrary, 180);
}

function clearSearch() {
  ui.searchInput.value = '';
  scheduleSearch();
  ui.searchInput.focus();
}

function setImporting(value) {
  importing = value;
  for (const control of [ui.chooseFiles, ui.fileInput, ui.directoryInput, ui.importDirectory]) control.disabled = value;
  ui.importPanel.setAttribute('aria-busy', String(value));
}

function reportImport(result) {
  ui.importProgress.textContent = `导入 ${result.imported} 张，重复 ${result.duplicates} 张，失败 ${result.failed.length} 张`;
  ui.failureSummary.textContent = `查看 ${result.failed.length} 项失败原因`;
  ui.failureList.replaceChildren();
  for (const failure of result.failed) {
    const item = document.createElement('li');
    item.textContent = `${failure.name}：${failure.error}`;
    ui.failureList.append(item);
  }
  ui.importFailures.hidden = result.failed.length === 0;
}

async function runImport(action) {
  if (importing) return;
  setImporting(true);
  ui.importProgress.hidden = false;
  ui.importProgress.textContent = '正在导入，请稍候';
  ui.importFailures.hidden = true;
  showAction('');
  try {
    reportImport(await action());
    clearTimeout(searchTimer);
    await loadLibrary();
  } catch (error) {
    ui.importProgress.textContent = `导入失败：${readableError(error)}`;
  } finally {
    setImporting(false);
    ui.fileInput.value = '';
  }
}

ui.toggleImport.addEventListener('click', () => {
  if (ui.importPanel.hidden) openImport();
  else {
    ui.importPanel.hidden = true;
    ui.toggleImport.setAttribute('aria-expanded', 'false');
  }
});
ui.chooseFiles.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', () => {
  const files = Array.from(ui.fileInput.files);
  if (!files.length) return;
  runImport(async () => {
    const result = { imported: 0, duplicates: 0, failed: [] };
    for (const [index, file] of files.entries()) {
      ui.importProgress.textContent = `正在导入 ${index + 1} / ${files.length}：${file.name}`;
      try {
        const current = await request(`/api/import-file?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        });
        result.imported += current.imported;
        result.duplicates += current.duplicates;
        result.failed.push(...current.failed);
      } catch (error) {
        result.failed.push({ name: file.name, error: readableError(error) });
      }
    }
    return result;
  });
});
ui.directoryForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const directory = ui.directoryInput.value.trim().replace(/^"(.*)"$/, '$1');
  if (!directory) {
    ui.directoryInput.focus();
    return;
  }
  runImport(() => request('/api/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory }),
  }));
});
ui.searchInput.addEventListener('input', scheduleSearch);
ui.clearSearch.addEventListener('click', clearSearch);
ui.stateAction.addEventListener('click', () => stateAction?.());
ui.previewButton.addEventListener('click', () => {
  if (!selected) return;
  ui.previewTitle.textContent = selected.name;
  ui.previewImage.alt = selected.name;
  ui.previewImage.hidden = false;
  ui.previewError.hidden = true;
  ui.previewImage.src = selected.imageUrl;
  ui.previewMeta.textContent = metadata(selected);
  ui.previewDialog.showModal();
});
ui.previewImage.addEventListener('error', () => {
  ui.previewImage.hidden = true;
  ui.previewError.hidden = false;
});
ui.closePreview.addEventListener('click', () => ui.previewDialog.close());
ui.layoutSettingsButton.addEventListener('click', () => {
  fillLayoutForm(layoutPreferences, captionDraft);
  ui.layoutDialog.showModal();
  ui.widthMode.focus();
});
ui.widthMode.addEventListener('change', syncLayoutFields);
ui.includeCaption.addEventListener('change', syncLayoutFields);
ui.cancelLayout.addEventListener('click', () => ui.layoutDialog.close());
ui.resetLayout.addEventListener('click', () => {
  fillLayoutForm({ ...normalizeLayoutOptions(), includeCaption: false }, defaultCaption(selected));
});
ui.layoutForm.addEventListener('submit', (event) => {
  event.preventDefault();
  ui.layoutError.hidden = true;
  let options;
  const includeCaption = ui.includeCaption.checked;
  const caption = includeCaption && selected ? ui.captionText.value.trim() : '';
  try {
    if (includeCaption && selected && !caption) throw new Error('请填写图题，或关闭“添加图题”');
    if (ui.maxHeightCm.validity.badInput) throw new Error('最大高度须填写 0.5–50 之间的数字，或留空');
    options = normalizeLayoutOptions({
      widthMode: ui.widthMode.value,
      widthCm: ui.widthCm.valueAsNumber,
      maxHeightCm: ui.maxHeightCm.value.trim() === '' ? null : ui.maxHeightCm.valueAsNumber,
      layout: ui.layoutMode.value,
      caption,
    });
  } catch (error) {
    ui.layoutError.textContent = error.message;
    ui.layoutError.hidden = false;
    return;
  }
  const { caption: appliedCaption, ...preferences } = options;
  layoutPreferences = { ...preferences, includeCaption };
  if (selected) captionDraft = appliedCaption || ui.captionText.value.trim() || defaultCaption(selected);
  let saved = true;
  try {
    saveLayoutPreferences(layoutPreferences);
  } catch {
    saved = false;
  }
  updateLayoutSummary();
  ui.layoutDialog.close();
  showAction(saved ? '排版设置已保存，用于接下来插入的图片' : '排版设置已应用于本次使用，但未能保存在本机', !saved);
});
ui.insertButton.addEventListener('click', async () => {
  if (!selected || inserting) return;
  refreshHost();
  if (!hostAvailable) return;
  const asset = selected;
  inserting = true;
  ui.insertButton.disabled = true;
  ui.insertButton.textContent = '正在插入';
  showAction('');
  try {
    const options = insertionOptions();
    const target = captureInsertionTarget();
    const insertion = await request(`/api/assets/${encodeURIComponent(asset.id)}/insertion`);
    insertPicture(insertion, target, options);
    showAction(`已插入「${asset.name}」`);
  } catch (error) {
    showAction(error.inserted ? error.message : `插入失败：${readableError(error)}`, true);
  } finally {
    inserting = false;
    ui.insertButton.textContent = '插入光标处';
    refreshHost();
  }
});
window.addEventListener('focus', refreshHost);
document.documentElement.addEventListener('pointerenter', refreshHost);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshHost();
});

try {
  layoutPreferences = loadLayoutPreferences();
} catch {
  showAction('无法读取上次的排版设置，本次使用默认设置', true);
}
updateLayoutSummary();
refreshHost();
loadLibrary();
