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
  'openFilters', 'filterSummary', 'clearFilters', 'filterDialog', 'filterForm',
  'categorySelect', 'filterTags', 'applyFilters', 'cancelFilters',
  'editMetadata', 'metadataDialog', 'metadataForm', 'assetName', 'assetAliases',
  'assetCategories', 'assetTags', 'metadataError', 'saveMetadata', 'cancelMetadata',
  'libraryViews', 'viewAll', 'viewFavorites', 'viewRecent', 'favoriteButton',
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
let filters = { category: '', uncategorized: false, tags: [] };
let libraryFacets = { categories: [], tags: [], uncategorized: 0 };
let editingAsset = null;
let savingMetadata = false;
let libraryView = 'all';
let visibleAssets = [];
const favoriteRequests = new Set();

function refreshFavoriteButton() {
  const pending = selected && favoriteRequests.has(selected.id);
  ui.favoriteButton.disabled = !selected || pending;
  ui.favoriteButton.setAttribute('aria-pressed', String(Boolean(selected?.favorite)));
  ui.favoriteButton.textContent = pending ? '保存中' : selected?.favorite ? '已收藏' : '收藏';
}

function setLibraryView(view) {
  if (view === libraryView) return;
  libraryView = view;
  for (const button of ui.libraryViews.children) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
  applyFilterChange();
}

function hasFilters() {
  return Boolean(filters.category || filters.uncategorized || filters.tags.length);
}

function updateFilterSummary() {
  const category = filters.uncategorized ? '未分类' : filters.category || '全部分类';
  const tags = filters.tags.length ? filters.tags.join('、') : '不限工序';
  ui.filterSummary.textContent = `${category} · ${tags}`;
  ui.filterSummary.title = ui.filterSummary.textContent;
  ui.clearFilters.hidden = !hasFilters();
}

function fillFilters() {
  const categories = [...libraryFacets.categories];
  if (filters.category && !categories.some(item => item.name === filters.category)) {
    categories.push({ name: filters.category, count: 0 });
  }
  ui.categorySelect.replaceChildren(
    new Option('全部分类', 'all'),
    new Option(`未分类（${libraryFacets.uncategorized}）`, 'uncategorized'),
    ...categories.map(item => new Option(`${item.name}（${item.count}）`, `category:${item.name}`)),
  );
  ui.categorySelect.value = filters.uncategorized ? 'uncategorized' : filters.category ? `category:${filters.category}` : 'all';
  const tags = [...libraryFacets.tags];
  for (const name of filters.tags) {
    if (!tags.some(item => item.name === name)) tags.push({ name, count: 0 });
  }
  ui.filterTags.replaceChildren();
  for (const [index, tag] of tags.entries()) {
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'filterTag';
    input.id = `filterTag-${index}`;
    input.value = tag.name;
    input.checked = filters.tags.includes(tag.name);
    const name = document.createElement('span');
    name.textContent = tag.name;
    const count = document.createElement('span');
    count.className = 'meta';
    count.textContent = String(tag.count);
    label.append(input, name, count);
    ui.filterTags.append(label);
  }
  if (!tags.length) {
    const empty = document.createElement('p');
    empty.className = 'supporting';
    empty.textContent = '尚无工序标签，可在所选图片的“素材信息”中添加';
    ui.filterTags.append(empty);
  }
}

function applyFilterChange() {
  clearTimeout(searchTimer);
  requestVersion += 1;
  libraryRequest?.abort();
  selectAsset(null);
  renderAssets([]);
  ui.libraryState.hidden = true;
  updateFilterSummary();
  loadLibrary();
}

function clearAllConditions() {
  ui.searchInput.value = '';
  ui.clearSearch.hidden = true;
  filters = { category: '', uncategorized: false, tags: [] };
  applyFilterChange();
}

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
  if (asset?.id !== selected?.id || (asset && asset.name !== selected?.name && captionDraft === defaultCaption(selected))) {
    captionDraft = defaultCaption(asset);
  }
  selected = asset;
  const tabId = visibleAssets.some(item => item.id === asset?.id) ? asset.id : visibleAssets[0]?.id;
  for (const card of ui.assetGrid.children) {
    card.setAttribute('aria-pressed', String(card.dataset.id === asset?.id));
    card.tabIndex = card.dataset.id === tabId ? 0 : -1;
  }
  ui.previewButton.disabled = !asset;
  ui.editMetadata.disabled = !asset;
  ui.selectedThumbnail.hidden = !asset;
  ui.previewPlaceholder.hidden = Boolean(asset);
  ui.selectedName.textContent = asset ? asset.name : '尚未选择图片';
  ui.selectedName.title = asset ? asset.name : '';
  ui.selectedMeta.textContent = asset ? `${asset.width} × ${asset.height} · 点击左图预览` : '点击素材查看并选择';
  if (asset) ui.selectedThumbnail.src = asset.thumbnailUrl;
  else ui.selectedThumbnail.removeAttribute('src');
  showAction('');
  refreshFavoriteButton();
  refreshHost();
}

function showLibraryState(title, description, actionLabel = '', action = null) {
  ui.libraryState.hidden = false;
  ui.stateTitle.textContent = title;
  ui.stateDescription.textContent = description;
  ui.stateDescription.hidden = !description;
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
  const focusedId = document.activeElement?.classList.contains('asset-card') ? document.activeElement.dataset.id : null;
  visibleAssets = assets;
  const tabId = assets.some(asset => asset.id === selected?.id) ? selected.id : assets[0]?.id;
  const fragment = document.createDocumentFragment();
  for (const asset of assets) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'asset-card';
    card.dataset.id = asset.id;
    card.tabIndex = asset.id === tabId ? 0 : -1;
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
    card.addEventListener('click', () => selectAsset(visibleAssets.find(item => item.id === asset.id) || null));
    fragment.append(card);
  }
  ui.assetGrid.replaceChildren(fragment);
  if (focusedId) {
    const cards = Array.from(ui.assetGrid.children);
    (cards.find(card => card.dataset.id === focusedId) || cards[0])?.focus({ preventScroll: true });
  }
}

async function loadLibrary() {
  const version = ++requestVersion;
  libraryRequest?.abort();
  libraryRequest = new AbortController();
  const query = ui.searchInput.value.trim();
  const parameters = new URLSearchParams({ q: query, view: libraryView });
  if (filters.category) parameters.set('category', filters.category);
  if (filters.uncategorized) parameters.set('uncategorized', '1');
  for (const tag of filters.tags) parameters.append('tag', tag);
  ui.assetGrid.setAttribute('aria-busy', 'true');
  ui.resultCount.textContent = '正在检索';
  try {
    const data = await request(`/api/library?${parameters}`, { signal: libraryRequest.signal });
    if (version !== requestVersion) return;
    libraryFacets = data.facets;
    ui.openFilters.disabled = false;
    renderAssets(data.assets);
    ui.resultCount.textContent = query || hasFilters() ? `${data.assets.length} / ${data.viewTotal} 张` : `${data.viewTotal} 张`;
    ui.libraryState.hidden = data.assets.length > 0;
    if (!data.assets.length) {
      if (data.total === 0) showLibraryState('先添加一组标书配图', '', '导入素材', openImport);
      else if (libraryView === 'favorites' && data.viewTotal === 0) showLibraryState('还没有收藏', '', '浏览全部', () => setLibraryView('all'));
      else if (libraryView === 'recent' && data.viewTotal === 0) showLibraryState('还没有插入记录', '', '浏览全部', () => setLibraryView('all'));
      else if (query || hasFilters()) showLibraryState('没有找到匹配图片', '', '清除全部条件', clearAllConditions);
      else showLibraryState('先添加一组标书配图', '导入本地图片后，就可以按名称查找并插入标书', '导入素材', openImport);
    }
    if (selected) selectAsset(data.assets.find((asset) => asset.id === selected.id) || null);
    return data;
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
  renderAssets([]);
  ui.libraryState.hidden = true;
  ui.assetGrid.setAttribute('aria-busy', 'true');
  ui.resultCount.textContent = '正在检索';
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
for (const button of ui.libraryViews.children) {
  button.addEventListener('click', () => setLibraryView(button.dataset.view));
}
ui.assetGrid.addEventListener('keydown', (event) => {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || document.querySelector('dialog[open]')) return;
  const card = event.target.closest('.asset-card');
  if (!card || card.parentElement !== ui.assetGrid) return;
  const cards = Array.from(ui.assetGrid.children);
  const index = cards.indexOf(card);
  const rowEnd = cards.findIndex(item => item.offsetTop !== cards[0].offsetTop);
  const columns = rowEnd < 0 ? cards.length : rowEnd;
  let next;
  if (event.key === 'ArrowLeft') next = index - 1;
  else if (event.key === 'ArrowRight') next = index + 1;
  else if (event.key === 'ArrowUp') next = index - columns;
  else if (event.key === 'ArrowDown') next = index + columns;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = cards.length - 1;
  else return;
  event.preventDefault();
  next = Math.max(0, Math.min(cards.length - 1, next));
  cards[next].focus();
  selectAsset(visibleAssets[next]);
});
ui.favoriteButton.addEventListener('click', async () => {
  if (!selected || favoriteRequests.has(selected.id)) return;
  const asset = selected;
  const favorite = !asset.favorite;
  favoriteRequests.add(asset.id);
  refreshFavoriteButton();
  try {
    const { asset: updated } = await request(`/api/assets/${encodeURIComponent(asset.id)}/favorite`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite }),
    });
    visibleAssets = visibleAssets.map(item => item.id === asset.id ? { ...item, favorite: updated.favorite } : item);
    if (selected?.id === asset.id) selected = { ...selected, favorite: updated.favorite };
    if (libraryView === 'favorites' && !updated.favorite) {
      if (selected?.id === asset.id) selectAsset(null);
      renderAssets(visibleAssets.filter(item => item.id !== asset.id));
    }
    const refreshVersion = requestVersion + 1;
    const data = await loadLibrary();
    if (!data && requestVersion === refreshVersion) showAction('收藏已保存，但图库刷新失败', true);
    else if (data && (!selected || selected.id === asset.id)) showAction(updated.favorite ? '已收藏' : '已取消收藏');
  } catch (error) {
    showAction(`「${asset.name}」收藏未保存：${readableError(error)}`, true);
  } finally {
    favoriteRequests.delete(asset.id);
    refreshFavoriteButton();
  }
});
ui.openFilters.addEventListener('click', () => {
  fillFilters();
  ui.filterDialog.showModal();
  ui.categorySelect.focus();
});
ui.cancelFilters.addEventListener('click', () => ui.filterDialog.close());
ui.filterForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const category = ui.categorySelect.value;
  filters = {
    category: category.startsWith('category:') ? category.slice('category:'.length) : '',
    uncategorized: category === 'uncategorized',
    tags: Array.from(ui.filterTags.querySelectorAll('input[name="filterTag"]:checked'), input => input.value),
  };
  ui.filterDialog.close();
  applyFilterChange();
});
ui.clearFilters.addEventListener('click', () => {
  filters = { category: '', uncategorized: false, tags: [] };
  applyFilterChange();
});
ui.editMetadata.addEventListener('click', () => {
  if (!selected || savingMetadata) return;
  editingAsset = selected;
  ui.assetName.value = selected.name;
  ui.assetAliases.value = selected.aliases.join('\n');
  ui.assetCategories.value = selected.categories.join('\n');
  ui.assetTags.value = selected.tags.join('\n');
  ui.metadataError.hidden = true;
  ui.metadataDialog.showModal();
  ui.assetName.focus();
});
ui.cancelMetadata.addEventListener('click', () => ui.metadataDialog.close());
ui.metadataDialog.addEventListener('cancel', event => {
  if (savingMetadata) event.preventDefault();
});
ui.metadataForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingAsset || savingMetadata) return;
  ui.metadataError.hidden = true;
  const name = ui.assetName.value.trim();
  if (!name) {
    ui.metadataError.textContent = '请填写图片名称';
    ui.metadataError.hidden = false;
    ui.assetName.focus();
    return;
  }
  const lines = value => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const fields = {
    name,
    aliases: lines(ui.assetAliases.value),
    categories: lines(ui.assetCategories.value),
    tags: lines(ui.assetTags.value),
  };
  const patch = Object.fromEntries(Object.entries(fields)
    .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(editingAsset[key])));
  if (!Object.keys(patch).length) {
    ui.metadataDialog.close();
    showAction('素材信息未改变');
    return;
  }
  savingMetadata = true;
  for (const control of ui.metadataForm.elements) control.disabled = true;
  ui.saveMetadata.textContent = '正在保存';
  let persisted = false;
  try {
    const { asset } = await request(`/api/assets/${encodeURIComponent(editingAsset.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    persisted = true;
    const data = await loadLibrary();
    const visible = data?.assets.find(item => item.id === asset.id);
    if (data) selectAsset(visible || null);
    ui.metadataDialog.close();
    showAction(!data ? '素材信息已保存，但图库刷新失败，请重新读取'
      : visible ? '素材信息已保存' : '素材信息已保存，图片不在当前筛选结果中', !data);
  } catch (error) {
    ui.metadataError.textContent = persisted ? '素材信息已保存，但显示未能刷新，请关闭后重新读取图库' : `保存失败：${readableError(error)}`;
    ui.metadataError.hidden = false;
  } finally {
    savingMetadata = false;
    for (const control of ui.metadataForm.elements) control.disabled = false;
    ui.saveMetadata.textContent = '保存信息';
  }
});
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
    try {
      const { asset: updated } = await request(`/api/assets/${encodeURIComponent(asset.id)}/recent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      visibleAssets = visibleAssets.map(item => item.id === asset.id ? { ...item, lastInsertedAt: updated.lastInsertedAt } : item);
      if (selected?.id === asset.id) selected = { ...selected, lastInsertedAt: updated.lastInsertedAt };
    } catch {
      showAction('图片已插入，但最近记录未保存', true);
      return;
    }
    if (libraryView === 'recent') await loadLibrary();
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
