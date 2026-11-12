import {
  captureInsertionTarget, getHostStatus, insertPicture,
  getReplacementStatus, captureReplacementTarget, replacePicture,
  getFillStatus, captureFillTarget, fillPlaceholder, FIT_MODES, selectNextEmptyPlaceholder,
} from './wps-bridge.js';
import { normalizeLayoutOptions, normalizeQualityProfile } from './layout-options.js';
import { loadLayoutPreferences, saveLayoutPreferences } from './layout-preferences.js';
import { createImportController } from './import-controller.js';
import { createBoxController } from './box-controller.js';
import { enhancePickers } from './select-picker.js';
import { createViewRefresh } from './view-refresh.js';

const pickers = enhancePickers();
const management = new URLSearchParams(location.search).get('manage') === '1';
document.documentElement.classList.toggle('management-view', management);

const element = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'toggleImport', 'importPanel', 'chooseFiles', 'fileInput', 'directoryForm',
  'directoryInput', 'importDirectory', 'importProgress', 'importFailures',
  'folderImportDialog', 'folderImportForm', 'folderImportScope', 'browseFolder', 'useFolderPath',
  'folderPathField', 'folderPath', 'folderSelection', 'folderImportError', 'cancelFolderImport', 'confirmFolderImport',
  'failureSummary', 'failureList', 'searchInput', 'clearSearch', 'resultCount',
  'libraryState', 'stateTitle', 'stateDescription', 'stateAction', 'assetGrid',
  'previewButton', 'selectedThumbnail', 'previewPlaceholder', 'selectedName',
  'assetDetails', 'multiSelectionSummary',
  'selectedMeta', 'hostStatus', 'actionStatus', 'previewDialog',
  'previewTitle', 'previewImage', 'previewError', 'previewMeta',
  'layoutSettingsButton', 'layoutDialog', 'layoutForm', 'widthMode', 'widthCm',
  'maxHeightCm', 'layoutMode', 'includeCaption', 'captionFields', 'captionText', 'qualityProfile',
  'layoutError', 'saveLayout', 'cancelLayout', 'resetLayout',
  'openFilters', 'filterSummary', 'clearFilters', 'filterDialog', 'filterForm',
  'categoryChips', 'filterOrientations', 'filterTags', 'applyFilters', 'cancelFilters',
  'toggleMulti', 'batchBar', 'batchCount', 'batchSelectAll', 'batchEdit', 'batchDialog', 'batchForm',
  'batchDialogCount', 'batchAddCategories', 'batchRemoveCategories', 'batchAddTags', 'batchRemoveTags',
  'batchError', 'applyBatch', 'cancelBatch', 'workspace',
  'moveToTrash', 'purgeButton', 'batchTrash', 'clearAssetTrash', 'trashDialog', 'trashForm', 'trashTitle',
  'trashDescription', 'trashError', 'cancelTrash', 'confirmTrash',
  'editMetadata', 'metadataDialog', 'metadataForm', 'assetName', 'assetAliases',
  'assetCategories', 'assetTags', 'metadataError', 'saveMetadata', 'cancelMetadata',
  'libraryViews', 'viewAll', 'viewFavorites', 'viewRecent', 'favoriteButton',
  'documentActions', 'replaceButton', 'viewTrash', 'libraryTitle',
  'chooseFolder', 'folderInput', 'retryImport', 'resumeImport', 'importMeter',
  'trashButton', 'restoreButton', 'activeFilters', 'favoriteLabel', 'layoutSummary',
  'selectedSpec', 'selectedCategories', 'selectedTags',
  'toggleBoxes', 'boxPanel', 'boxForm', 'boxName', 'boxSize', 'boxCustomSize', 'boxWidthCm',
  'boxHeightCm', 'boxError', 'insertBox', 'boxCount', 'scanBoxes', 'boxList',
  'fillBar', 'fillTarget', 'fitMode', 'searchBoxName', 'ratioSort',
  'unfilledOnly', 'findMarkers', 'clearMarkers', 'markerResult', 'markerSummary', 'markerList',
  'convertMarkers', 'clearMarkersDialog', 'clearMarkersText',
  'sourceButton', 'importScope', 'connectionDialog', 'connectionForm', 'connectionCurrent', 'connectionServing',
  'connectionShared', 'serverUrl', 'accessKey', 'connectionError', 'useLocal', 'cancelConnection', 'connectServer',
].map((id) => [id, element(id)]));

function icon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(namespace, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

let selected = null;
let hostAvailable = false;
let inserting = false;
let replacing = false;
let replacementAvailable = false;
let fillTarget = { available: false };
// 比例接近优先：手动开启，只在选中占位框时生效；关闭时恢复图库原顺序。
let ratioSort = false;
let sortKey = '';
let libraryOrder = new Map();

function orderAssets(assets) {
  const ordered = [...assets].sort((a, b) => (libraryOrder.get(a.id) ?? 0) - (libraryOrder.get(b.id) ?? 0));
  if (!ratioSort || !fillTarget.available) return ordered;
  const target = Math.log(fillTarget.widthPt / fillTarget.heightPt);
  const distance = asset => Math.abs(Math.log(asset.width / asset.height) - target);
  return ordered.sort((a, b) => distance(a) - distance(b)); // 稳定排序，比例相同时保持原顺序
}
const FIT_STORAGE_KEY = 'ipeitu.fit.v1';
const centimeters = points => (points * 2.54 / 72).toFixed(1);
let requestVersion = 0;
let searchTimer;
let libraryRequest;
let stateAction = null;
let layoutPreferences = { ...normalizeLayoutOptions(), includeCaption: false, qualityProfile: 'original' };
let captionDraft = '';
const emptyFilters = () => ({ category: '', uncategorized: false, tags: [], orientation: '' });
const ORIENTATION_LABELS = { landscape: '横图', portrait: '竖图', square: '方图' };
let filters = emptyFilters();
let libraryFacets = { categories: [], tags: [], uncategorized: 0, orientations: {} };
// 勾选跨检索保留，切换图库来源、进出回收站或退出多选时清空。
let multiMode = null;
const multiSelected = new Set();
let editingAsset = null;
let metadataLock = null;
let metadataHeartbeat;
let openingMetadata = false;
let savingMetadata = false;
let changingTrash = false;
let pendingTrash = null;
let trashSnapshot = null;
let libraryView = 'all';
let visibleAssets = [];
const favoriteRequests = new Set();
let boxes = null;
let lastLibraryData;
const listRefreshPaused = () => inserting || replacing || changingTrash || openingMetadata || savingMetadata || favoriteRequests.size > 0
  || Boolean(document.querySelector('dialog[open]'));
const listRefresh = createViewRefresh({
  canRefresh: () => ui.assetGrid.getAttribute('aria-busy') !== 'true' && !listRefreshPaused(),
  refresh: refreshOnReturn,
  pointer: !management,
});

function refreshFavoriteButton() {
  const pending = selected && favoriteRequests.has(selected.id);
  ui.favoriteButton.hidden = libraryView === 'trash';
  ui.favoriteButton.disabled = !selected || pending || changingTrash || libraryView === 'trash';
  ui.favoriteButton.setAttribute('aria-pressed', String(Boolean(selected?.favorite)));
  ui.favoriteLabel.textContent = pending ? '保存中' : selected?.favorite ? '已收藏' : '收藏';
  for (const button of ui.assetGrid.querySelectorAll('.card-favorite-action')) {
    button.setAttribute('aria-disabled', String(changingTrash || favoriteRequests.has(button.dataset.id)));
  }
}

function setMultiMode(mode) {
  multiMode = mode;
  const enabled = Boolean(mode);
  if (!enabled) multiSelected.clear();
  ui.toggleMulti.setAttribute('aria-pressed', String(enabled));
  ui.assetGrid.classList.toggle('multi', enabled);
  ui.batchBar.hidden = !enabled;
  syncCardStates();
}

// 卡片按下状态：多选时表示是否勾选，否则表示当前所选图片。
function syncCardStates() {
  for (const card of ui.assetGrid.querySelectorAll('.asset-card')) {
    card.setAttribute('aria-pressed', String(multiMode ? multiSelected.has(card.dataset.id) : card.dataset.id === selected?.id));
  }
  ui.batchCount.textContent = `已选 ${multiSelected.size} 张`;
  if (management) {
    ui.assetDetails.hidden = Boolean(multiMode);
    ui.multiSelectionSummary.hidden = !multiMode;
    ui.multiSelectionSummary.textContent = `已选 ${multiSelected.size} 张图片`;
  }
  ui.batchEdit.disabled = multiSelected.size === 0;
  refreshTrashActions();
}

function refreshTrashActions() {
  const busy = changingTrash || savingMetadata || inserting || replacing;
  const inTrash = libraryView === 'trash';
  ui.moveToTrash.hidden = Boolean(multiMode) || inTrash || !selected;
  ui.moveToTrash.disabled = busy;
  ui.purgeButton.hidden = Boolean(multiMode) || !inTrash || !selected;
  ui.purgeButton.disabled = busy;
  ui.clearAssetTrash.hidden = !inTrash;
  ui.clearAssetTrash.disabled = busy || !trashSnapshot?.count;
  ui.restoreButton.hidden = Boolean(multiMode) || !inTrash;
  ui.restoreButton.disabled = busy || !selected;
  ui.batchEdit.hidden = inTrash;
  ui.batchTrash.textContent = inTrash ? '永久删除' : '移到回收站';
  ui.batchTrash.disabled = busy || multiSelected.size === 0;
}

function toggleMultiSelected(id) {
  if (multiSelected.has(id)) multiSelected.delete(id);
  else multiSelected.add(id);
  syncCardStates();
}

function setLibraryView(view) {
  if (view === libraryView) return;
  const changesTrashScope = (view === 'trash') !== (libraryView === 'trash');
  libraryView = view;
  if (changesTrashScope) clearLibrarySelection();
  ui.libraryTitle.textContent = view === 'trash' ? '回收站' : '本地素材';
  for (const button of ui.libraryViews.children) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
  applyFilterChange();
}

function clearLibrarySelection() {
  trashSnapshot = null;
  setMultiMode(null);
  renderAssets([]);
  selectAsset(null);
}

function hasFilters() {
  return Boolean(filters.category || filters.uncategorized || filters.tags.length || filters.orientation);
}

function updateFilterSummary() {
  const category = filters.uncategorized ? '未分类' : filters.category;
  ui.filterSummary.textContent = [category, ORIENTATION_LABELS[filters.orientation], ...filters.tags].filter(Boolean).join(' · ');
  ui.filterSummary.title = ui.filterSummary.textContent;
  ui.activeFilters.hidden = !hasFilters();
  ui.openFilters.classList.toggle('active', Boolean(filters.tags.length || filters.orientation));
  renderCategoryChips();
}

// 分类直接在窗格上点选：全部、未分类和各分类，单选。
function renderCategoryChips() {
  const categories = [...libraryFacets.categories];
  if (filters.category && !categories.some(item => item.name === filters.category)) categories.push({ name: filters.category, count: 0 });
  const chips = [
    { label: '全部分类', pressed: !filters.category && !filters.uncategorized, apply: { category: '', uncategorized: false } },
    { label: '未分类', count: libraryFacets.uncategorized, pressed: filters.uncategorized, apply: { category: '', uncategorized: true } },
    ...categories.map(item => ({ label: item.name, count: item.count, pressed: filters.category === item.name, apply: { category: item.name, uncategorized: false } })),
  ];
  ui.categoryChips.replaceChildren(...chips.map(chip => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(chip.pressed));
    button.append(chip.label);
    if (chip.count !== undefined) {
      const count = document.createElement('span');
      count.className = 'figures';
      count.textContent = String(chip.count);
      button.append(count);
    }
    button.addEventListener('click', () => {
      if (chip.pressed) return;
      filters = { ...filters, ...chip.apply };
      applyFilterChange();
    });
    return button;
  }));
  ui.categoryChips.hidden = categories.length === 0 && !filters.uncategorized;
}

function fillFilters() {
  const orientations = [['', '不限'], ['landscape', '横图'], ['portrait', '竖图'], ['square', '方图']];
  ui.filterOrientations.replaceChildren(...orientations.map(([value, text]) => {
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'orientation';
    input.value = value;
    input.checked = filters.orientation === value;
    const name = document.createElement('span');
    name.textContent = value ? `${text} ${libraryFacets.orientations?.[value] ?? 0}` : text;
    label.append(input, name);
    return label;
  }));
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
  filters = emptyFilters();
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
  if (layoutPreferences.qualityProfile !== 'original') summary.push(layoutPreferences.qualityProfile === 'clear' ? '清晰' : '均衡');
  ui.layoutSummary.textContent = summary.join(' · ');
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
  ui.qualityProfile.value = preferences.qualityProfile ?? 'original';
  ui.widthMode.value = preferences.widthMode;
  ui.widthCm.value = String(preferences.widthCm);
  ui.maxHeightCm.value = preferences.maxHeightCm === null ? '' : String(preferences.maxHeightCm);
  ui.layoutMode.value = preferences.layout;
  for (const select of [ui.qualityProfile, ui.widthMode, ui.layoutMode]) pickers.get(select).refresh();
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
  if (!response.ok) {
    const error = new Error(data.error || `操作失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
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

function refreshAddButtons() {
  const busy = inserting || replacing || changingTrash;
  for (const button of ui.assetGrid.querySelectorAll('.card-add')) {
    button.disabled = !hostAvailable;
    // 等待期间只标记不禁用：真正禁用会丢失键盘焦点，连续添加时焦点要留在按钮上。
    button.setAttribute('aria-disabled', String(busy));
    button.title = !hostAvailable ? ui.hostStatus.textContent : fillTarget.available ? '填入占位框' : '插入光标处';
    button.setAttribute('aria-label', fillTarget.available
      ? `填入「${button.dataset.name}」到占位框「${fillTarget.name}」` : `插入「${button.dataset.name}」到光标处`);
  }
}

function refreshHost() {
  const trashed = libraryView === 'trash';
  const inWps = !management && typeof globalThis.Application !== 'undefined';
  ui.layoutSettingsButton.parentElement.hidden = trashed;
  ui.hostStatus.hidden = trashed;
  ui.editMetadata.disabled = !selected || openingMetadata || changingTrash || inserting || replacing || trashed;
  ui.trashButton.disabled = changingTrash || savingMetadata || inserting || replacing || (ui.metadataDialog.open && !metadataLock);
  refreshTrashActions();
  try {
    const status = getHostStatus();
    hostAvailable = inWps && status.available;
    ui.hostStatus.textContent = inWps ? status.message : '浏览器模式 · 插入需从 WPS 打开';
  } catch (error) {
    hostAvailable = false;
    ui.hostStatus.textContent = error.message;
  }
  ui.hostStatus.classList.toggle('ready', hostAvailable);
  replacementAvailable = false;
  if (inWps) {
    try {
      const status = getReplacementStatus();
      replacementAvailable = status.available;
      ui.replaceButton.title = status.available ? selected ? '保留文档图片的位置与宽度' : '请先选择素材' : status.message;
    } catch (error) {
      ui.replaceButton.title = error.message || '无法读取当前图片，请重新选择';
    }
  }
  // 选中占位框时卡片按钮改为填入，替换会丢失框的标记，因此不显示替换。
  fillTarget = inWps && !trashed ? getFillStatus() : { available: false };
  if (!fillTarget.available) pickers.get(ui.fitMode).close();
  ui.fillBar.hidden = !fillTarget.available;
  if (fillTarget.available) {
    ui.fillTarget.textContent = `填入占位框「${fillTarget.name}」${centimeters(fillTarget.widthPt)} × ${centimeters(fillTarget.heightPt)} 厘米`;
    ui.fillTarget.title = fillTarget.name;
  }
  // 只在文档中选中普通图片时显示，平时把高度留给素材。
  ui.documentActions.hidden = trashed || !replacementAvailable || fillTarget.available;
  ui.replaceButton.disabled = !selected || !replacementAvailable || inserting || replacing || changingTrash || trashed;
  refreshAddButtons();
  boxes?.refresh({ available: hostAvailable, busy: inserting || replacing || changingTrash, inWps });
  ui.ratioSort.setAttribute('aria-pressed', String(ratioSort));
  // 只在开关或目标框比例变化时重排，避免窗格刷新时卡片跳动。
  const key = ratioSort && fillTarget.available ? (fillTarget.widthPt / fillTarget.heightPt).toFixed(3) : '';
  if (key !== sortKey) {
    sortKey = key;
    renderAssets(orderAssets(visibleAssets));
  }
  listRefresh.flush();
}

async function recordSuccessfulUse(asset, action) {
  try {
    const { asset: updated } = await request(`/api/assets/${encodeURIComponent(asset.id)}/recent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    visibleAssets = visibleAssets.map(item => item.id === asset.id ? { ...item, lastInsertedAt: updated.lastInsertedAt } : item);
    if (selected?.id === asset.id) selected = { ...selected, lastInsertedAt: updated.lastInsertedAt };
  } catch {
    showAction(`图片已${action}，但最近记录未保存`, true);
    return false;
  }
  if (libraryView === 'recent') await loadLibrary();
  showAction(`已${action}「${asset.name}」`);
  return true;
}

function selectAsset(asset) {
  if (asset?.id !== selected?.id || (asset && asset.name !== selected?.name && captionDraft === defaultCaption(selected))) {
    captionDraft = defaultCaption(asset);
  }
  selected = asset;
  const tabId = visibleAssets.some(item => item.id === asset?.id) ? asset.id : visibleAssets[0]?.id;
  syncCardStates();
  for (const control of ui.assetGrid.querySelectorAll('.asset-card, .card-add, .card-favorite-action')) {
    control.tabIndex = control.dataset.id === tabId ? 0 : -1;
  }
  ui.previewButton.disabled = !asset;
  ui.editMetadata.disabled = !asset;
  ui.selectedThumbnail.hidden = !asset;
  ui.previewPlaceholder.hidden = Boolean(asset);
  ui.selectedName.textContent = asset ? asset.name : '尚未选择图片';
  ui.selectedName.title = asset ? asset.name : '';
  ui.selectedMeta.hidden = !asset;
  ui.selectedMeta.textContent = asset ? metadata(asset) : '';
  ui.selectedSpec.hidden = !asset;
  ui.selectedCategories.textContent = asset ? asset.categories.join('、') || '未分类' : '';
  ui.selectedTags.textContent = asset ? asset.tags.join('、') || '未设置' : '';
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
  boxes?.close();
  ui.importPanel.hidden = false;
  ui.toggleImport.setAttribute('aria-expanded', 'true');
  ui.chooseFiles.focus();
}

function renderAssets(assets) {
  const active = document.activeElement;
  const focusedClass = ['card-add', 'card-favorite-action', 'asset-card'].find(name => active?.classList.contains(name));
  const focusedId = focusedClass ? active.dataset.id : null;
  visibleAssets = assets;
  const tabId = assets.some(asset => asset.id === selected?.id) ? selected.id : assets[0]?.id;
  const fragment = document.createDocumentFragment();
  for (const asset of assets) {
    const item = document.createElement('div');
    item.className = 'asset-item';
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'asset-card';
    card.dataset.id = asset.id;
    card.tabIndex = asset.id === tabId ? 0 : -1;
    card.setAttribute('aria-pressed', String(multiMode ? multiSelected.has(asset.id) : asset.id === selected?.id));
    const favorited = asset.favorite && libraryView !== 'trash';
    card.setAttribute('aria-label', `选择 ${asset.name}${favorited ? '（已收藏）' : ''}`);
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
    name.textContent = asset.name.replace(/\.[^.]+$/, '') || asset.name;
    name.title = asset.name;
    const size = document.createElement('span');
    size.className = 'asset-size figures';
    size.textContent = `${asset.width} × ${asset.height}`;
    caption.append(name, size);
    const check = document.createElement('span');
    check.className = 'card-check';
    check.append(icon('check'));
    card.append(thumbnail, check, caption);
    if (favorited && management) {
      const favorite = document.createElement('span');
      favorite.className = 'card-favorite';
      favorite.append(icon('star'));
      card.append(favorite);
    }
    card.addEventListener('click', event => {
      if (event.ctrlKey && !multiMode) {
        if (selected && visibleAssets.some(item => item.id === selected.id)) multiSelected.add(selected.id);
        setMultiMode('ctrl');
      }
      if (event.ctrlKey || multiMode === 'toggle' || (multiMode === 'ctrl' && event.detail === 0)) {
        toggleMultiSelected(asset.id);
      } else {
        if (multiMode === 'ctrl') setMultiMode(null);
        selectAsset(visibleAssets.find(item => item.id === asset.id) || null);
      }
    });
    item.append(card);
    if (libraryView !== 'trash') {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      if (!management) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'card-add';
        add.dataset.id = asset.id;
        add.tabIndex = asset.id === tabId ? 0 : -1;
        add.dataset.name = asset.name;
        add.append(icon('plus'));
        add.addEventListener('click', () => insertAsset(asset));
        actions.append(add);
      }

      const favoriteAction = document.createElement('button');
      favoriteAction.type = 'button';
      favoriteAction.className = 'card-favorite-action';
      favoriteAction.dataset.id = asset.id;
      favoriteAction.tabIndex = asset.id === tabId ? 0 : -1;
      favoriteAction.title = favorited ? '取消收藏' : '收藏';
      favoriteAction.setAttribute('aria-label', `收藏「${asset.name}」`);
      favoriteAction.setAttribute('aria-pressed', String(favorited));
      favoriteAction.append(icon('star'));
      favoriteAction.addEventListener('click', () => toggleFavorite(asset));
      actions.append(favoriteAction);
      item.append(actions);
    }
    fragment.append(item);
  }
  ui.assetGrid.replaceChildren(fragment);
  refreshAddButtons();
  refreshFavoriteButton();
  if (focusedId) {
    (ui.assetGrid.querySelector(`.${focusedClass}[data-id="${focusedId}"]`)
      || ui.assetGrid.querySelector('.asset-card'))?.focus({ preventScroll: true });
  }
}

let addedMarkTimer;

function clearAddedMark() {
  clearTimeout(addedMarkTimer);
  for (const button of ui.assetGrid.querySelectorAll('.card-add.added')) {
    button.classList.remove('added');
    button.querySelector('use').setAttribute('href', '#i-plus');
  }
}

function markAdded(id) {
  clearAddedMark();
  const button = ui.assetGrid.querySelector(`.card-add[data-id="${id}"]`);
  if (!button) return;
  button.classList.add('added');
  button.querySelector('use').setAttribute('href', '#i-check');
  addedMarkTimer = setTimeout(clearAddedMark, 1200);
}

async function insertAsset(candidate) {
  if (inserting || replacing || changingTrash || libraryView === 'trash') return;
  refreshHost();
  if (!hostAvailable) return;
  const asset = visibleAssets.find(item => item.id === candidate.id) || candidate;
  // 同时选中这张图，图题和底部信息才与插入的图片对应。
  if (selected?.id !== asset.id) selectAsset(asset);
  const filling = fillTarget.available;
  inserting = true;
  refreshHost();
  showAction('');
  try {
    const profile = normalizeQualityProfile(layoutPreferences.qualityProfile);
    if (filling) {
      const target = captureFillTarget();
      const fit = ui.fitMode.value;
      const round = value => String(Math.round(value * 10) / 10);
      const parameters = new URLSearchParams({ mode: fit, widthPt: round(target.width), heightPt: round(target.height), profile });
      const image = await request(`/api/assets/${encodeURIComponent(asset.id)}/fit?${parameters}`);
      fillPlaceholder(image, target, { asset: asset.id, fit });
      showAction(`已填入占位框「${target.name}」`);
      const recorded = await recordSuccessfulUse(asset, '填入');
      // 连续配图：选中下一个空框，可继续填入。定位失败不影响已完成的填入。
      let next;
      let nextError = '';
      try { next = selectNextEmptyPlaceholder(target.start); } catch (error) { nextError = error.message; }
      if (recorded) {
        showAction(next ? `已填入「${target.name}」，下一个空框「${next.name}」`
          : next === null ? `已填入「${target.name}」，文档中的占位框已全部填入`
            : `已填入「${target.name}」；未能定位下一个空框：${nextError}`, !next && next !== null);
      }
      boxes?.refreshList();
    } else {
      const options = insertionOptions();
      const target = captureInsertionTarget();
      const insertion = await request(`/api/assets/${encodeURIComponent(asset.id)}/insertion?profile=${profile}`);
      insertPicture(insertion, target, options);
      showAction(`已插入「${asset.name}」`);
      await recordSuccessfulUse(asset, '插入');
    }
    markAdded(asset.id);
  } catch (error) {
    showAction(error.inserted || error.filled || error.resultUncertain ? error.message
      : `${filling ? '填入' : '插入'}失败：${readableError(error)}`, true);
  } finally {
    inserting = false;
    refreshHost();
  }
}

async function loadLibrary({ background = false } = {}) {
  listRefresh.consume();
  const version = ++requestVersion;
  if (!background) {
    trashSnapshot = null;
    refreshTrashActions();
  }
  libraryRequest?.abort();
  libraryRequest = new AbortController();
  const query = ui.searchInput.value.trim();
  const parameters = new URLSearchParams({ q: query, view: libraryView });
  if (filters.category) parameters.set('category', filters.category);
  if (filters.uncategorized) parameters.set('uncategorized', '1');
  if (filters.orientation) parameters.set('orientation', filters.orientation);
  for (const tag of filters.tags) parameters.append('tag', tag);
  const requestQuery = parameters.toString();
  ui.assetGrid.setAttribute('aria-busy', 'true');
  if (!background) ui.resultCount.textContent = '正在检索';
  try {
    const data = await request(`/api/library?${requestQuery}`, { signal: libraryRequest.signal });
    if (version !== requestVersion) return;
    if (background && listRefreshPaused()) {
      listRefresh.request();
      return;
    }
    if (ui.actionStatus.textContent.startsWith('素材列表暂未更新：')) showAction('');
    if (background && lastLibraryData?.query === requestQuery
      && JSON.stringify(lastLibraryData.data) === JSON.stringify(data)) return data;
    lastLibraryData = { query: requestQuery, data };
    trashSnapshot = libraryView === 'trash' && data.trashRevision ? { count: data.viewTotal, revision: data.trashRevision } : null;
    libraryFacets = data.facets;
    renderCategoryChips();
    ui.openFilters.disabled = false;
    libraryOrder = new Map(data.assets.map((asset, index) => [asset.id, index]));
    renderAssets(orderAssets(data.assets));
    ui.resultCount.textContent = query || hasFilters() ? `${data.assets.length} / ${data.viewTotal} 张` : `${data.viewTotal} 张`;
    ui.libraryState.hidden = data.assets.length > 0;
    if (!data.assets.length) {
      if (libraryView === 'trash' && data.viewTotal === 0) showLibraryState('回收站为空', '');
      else if (libraryView === 'trash') showLibraryState('没有找到匹配图片', '', '清除全部条件', clearAllConditions);
      else if (data.total === 0) showLibraryState('先添加一组标书配图', '', '导入素材', openImport);
      else if (libraryView === 'favorites' && data.viewTotal === 0) showLibraryState('还没有收藏', '', '浏览全部', () => setLibraryView('all'));
      else if (libraryView === 'recent' && data.viewTotal === 0) showLibraryState('还没有插入记录', '', '浏览全部', () => setLibraryView('all'));
      else if (query || hasFilters()) showLibraryState('没有找到匹配图片', '', '清除全部条件', clearAllConditions);
      else showLibraryState('先添加一组标书配图', management ? '' : '导入本地图片后，就可以按名称查找并插入标书', '导入素材', openImport);
    }
    if (selected) selectAsset(data.assets.find((asset) => asset.id === selected.id) || null);
    return data;
  } catch (error) {
    if (version !== requestVersion || error.name === 'AbortError') return;
    if (background && lastLibraryData) {
      showAction(`素材列表暂未更新：${readableError(error)}`, true);
      return;
    }
    lastLibraryData = null;
    renderAssets([]);
    selectAsset(null);
    ui.resultCount.textContent = '读取失败';
    showLibraryState('图库暂时无法读取', readableError(error), '重新读取', loadLibrary);
  } finally {
    if (version === requestVersion) {
      ui.assetGrid.setAttribute('aria-busy', 'false');
      refreshTrashActions();
      listRefresh.flush();
    }
  }
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  requestVersion += 1;
  libraryRequest?.abort();
  trashSnapshot = null;
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

ui.toggleImport.addEventListener('click', () => {
  if (ui.importPanel.hidden) openImport();
  else {
    ui.importPanel.hidden = true;
    ui.toggleImport.setAttribute('aria-expanded', 'false');
  }
});
const importer = createImportController({
  ui, request, readableError, management, refreshLibrary: loadLibrary, clearAction: () => showAction(''),
  reveal: () => {
    boxes?.close();
    ui.importPanel.hidden = false;
    ui.toggleImport.setAttribute('aria-expanded', 'true');
  },
});

// 拖入图片文件或粘贴截图即导入，复用导入面板的进度与失败重试。
const hasFiles = event => Array.from(event.dataTransfer?.types ?? []).includes('Files');
ui.workspace.addEventListener('dragover', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  ui.workspace.classList.add('drop-active');
});
ui.workspace.addEventListener('dragleave', event => {
  if (!ui.workspace.contains(event.relatedTarget)) ui.workspace.classList.remove('drop-active');
});
ui.workspace.addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  ui.workspace.classList.remove('drop-active');
  importer.importFiles(Array.from(event.dataTransfer.files));
});
document.addEventListener('paste', event => {
  // 在输入框里粘贴文字时不拦截。
  if (event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
  const images = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
  if (!images.length) return;
  event.preventDefault();
  importer.importFiles(images, { pasted: true });
});

ui.toggleMulti.addEventListener('click', () => setMultiMode(multiMode ? null : 'toggle'));
ui.batchSelectAll.addEventListener('click', () => {
  for (const asset of visibleAssets) multiSelected.add(asset.id);
  syncCardStates();
});
ui.batchEdit.addEventListener('click', () => {
  if (!multiSelected.size) return;
  for (const field of [ui.batchAddCategories, ui.batchRemoveCategories, ui.batchAddTags, ui.batchRemoveTags]) field.value = '';
  ui.batchDialogCount.textContent = `${multiSelected.size} 张`;
  ui.batchError.hidden = true;
  ui.batchDialog.showModal();
  ui.batchAddCategories.focus();
});
ui.cancelBatch.addEventListener('click', () => ui.batchDialog.close());
ui.batchForm.addEventListener('submit', async event => {
  event.preventDefault();
  const lines = field => field.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const changes = {
    addCategories: lines(ui.batchAddCategories), removeCategories: lines(ui.batchRemoveCategories),
    addTags: lines(ui.batchAddTags), removeTags: lines(ui.batchRemoveTags),
  };
  const body = { ids: [...multiSelected], ...Object.fromEntries(Object.entries(changes).filter(([, values]) => values.length)) };
  if (Object.keys(body).length === 1) {
    ui.batchError.textContent = '请至少填写一项要添加或移除的分类或标签';
    ui.batchError.hidden = false;
    return;
  }
  ui.applyBatch.disabled = true;
  try {
    const { updated } = await request('/api/assets/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    ui.batchDialog.close();
    multiSelected.clear();
    syncCardStates();
    const data = await loadLibrary();
    showAction(data ? `已更新 ${updated} 张素材` : `已更新 ${updated} 张素材，但图库刷新失败，请重新读取`, !data);
  } catch (error) {
    ui.batchError.textContent = `未修改任何图片：${readableError(error)}`;
    ui.batchError.hidden = false;
  } finally {
    ui.applyBatch.disabled = false;
  }
});
boxes = createBoxController({
  ui, request, readableError, showAction,
  beginWrite() {
    if (inserting || replacing || changingTrash) return '';
    refreshHost();
    if (!hostAvailable) return ui.hostStatus.textContent;
    inserting = true;
    refreshHost();
    return true;
  },
  endWrite() {
    inserting = false;
    refreshHost();
  },
});
ui.toggleBoxes.addEventListener('click', () => {
  if (!ui.boxPanel.hidden) {
    pickers.get(ui.boxSize).close();
    boxes.close();
    return;
  }
  ui.importPanel.hidden = true;
  ui.toggleImport.setAttribute('aria-expanded', 'false');
  boxes.open();
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
  if (!card || !ui.assetGrid.contains(card)) return;
  const cards = Array.from(ui.assetGrid.querySelectorAll('.asset-card'));
  const index = cards.indexOf(card);
  // 卡片相对各自容器定位，行要按容器的 offsetTop 判断。
  const items = Array.from(ui.assetGrid.children);
  const rowEnd = items.findIndex(item => item.offsetTop !== items[0].offsetTop);
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
  // 多选时方向键只移动焦点，空格或 Enter 勾选。
  if (!multiMode) selectAsset(visibleAssets[next]);
});
async function toggleFavorite(candidate) {
  const asset = visibleAssets.find(item => item.id === candidate?.id);
  if (!asset || changingTrash || libraryView === 'trash' || favoriteRequests.has(asset.id)) return;
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
    } else renderAssets(visibleAssets);
    const refreshVersion = requestVersion + 1;
    const data = await loadLibrary();
    if (!data && requestVersion === refreshVersion) showAction('收藏已保存，但图库刷新失败', true);
    else if (data && (!selected || selected.id === asset.id)) showAction(updated.favorite ? '已收藏' : '已取消收藏');
  } catch (error) {
    showAction(`「${asset.name}」收藏未保存：${readableError(error)}`, true);
  } finally {
    favoriteRequests.delete(asset.id);
    refreshFavoriteButton();
    listRefresh.flush();
  }
}
ui.favoriteButton.addEventListener('click', () => toggleFavorite(selected));
ui.openFilters.addEventListener('click', () => {
  fillFilters();
  ui.filterDialog.showModal();
  ui.filterOrientations.querySelector('input:checked')?.focus();
});
ui.cancelFilters.addEventListener('click', () => ui.filterDialog.close());
ui.filterForm.addEventListener('submit', (event) => {
  event.preventDefault();
  filters = {
    ...filters,
    orientation: ui.filterOrientations.querySelector('input[name="orientation"]:checked')?.value ?? '',
    tags: Array.from(ui.filterTags.querySelectorAll('input[name="filterTag"]:checked'), input => input.value),
  };
  ui.filterDialog.close();
  applyFilterChange();
});
ui.clearFilters.addEventListener('click', () => {
  filters = emptyFilters();
  applyFilterChange();
});
const METADATA_LOCK_HEARTBEAT = 30_000;
const LOST_METADATA_LOCK_STATUS = new Set([404, 409, 410, 423]);

function releaseMetadataLock(lock, keepalive = false) {
  if (!lock) return;
  request(lock.url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: lock.token, release: true }), keepalive,
  }).catch(() => {}); // 连接中断时由服务端超时释放。
}

function stopMetadataHeartbeat() {
  const lock = metadataLock;
  metadataLock = null;
  clearInterval(metadataHeartbeat);
  return lock;
}

function loseMetadataLock() {
  stopMetadataHeartbeat();
  ui.saveMetadata.disabled = true;
  ui.trashButton.disabled = true;
  ui.metadataError.textContent = '编辑锁已失效，请重新打开素材信息。当前草稿仍可复制。';
  ui.metadataError.hidden = false;
}

async function renewMetadataLock() {
  const lock = metadataLock;
  if (!lock || lock.renewing || savingMetadata || changingTrash) return;
  lock.renewing = true;
  try {
    await request(lock.url, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: lock.token }),
    });
  } catch (error) {
    if (metadataLock === lock && !savingMetadata && !changingTrash && LOST_METADATA_LOCK_STATUS.has(error.status)) loseMetadataLock();
  } finally {
    lock.renewing = false;
  }
}

ui.editMetadata.addEventListener('click', async () => {
  if (!selected || openingMetadata || savingMetadata || changingTrash || inserting || replacing || ui.metadataDialog.open || libraryView === 'trash') return;
  const id = selected.id;
  const source = `${connection.mode} ${connection.url}`;
  const url = `/api/assets/${encodeURIComponent(id)}/edit-lock`;
  openingMetadata = true;
  refreshHost();
  try {
    const { asset, token } = await request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const lock = { url, token, renewing: false };
    if (selected?.id !== id || libraryView === 'trash' || document.querySelector('dialog[open]')
      || source !== `${connection.mode} ${connection.url}`) {
      releaseMetadataLock(lock);
      return;
    }
    metadataLock = lock;
    editingAsset = asset;
    ui.assetName.value = asset.name;
    ui.assetAliases.value = asset.aliases.join('\n');
    ui.assetCategories.value = asset.categories.join('\n');
    ui.assetTags.value = asset.tags.join('\n');
    ui.metadataError.hidden = true;
    ui.saveMetadata.disabled = false;
    ui.trashButton.disabled = false;
    ui.metadataDialog.showModal();
    ui.assetName.focus();
    metadataHeartbeat = setInterval(renewMetadataLock, METADATA_LOCK_HEARTBEAT);
    showAction('');
  } catch (error) {
    releaseMetadataLock(stopMetadataHeartbeat());
    showAction(readableError(error), true);
  } finally {
    openingMetadata = false;
    refreshHost();
  }
});
ui.cancelMetadata.addEventListener('click', () => ui.metadataDialog.close());
ui.metadataDialog.addEventListener('close', () => {
  if (ui.metadataDialog.open) return;
  releaseMetadataLock(stopMetadataHeartbeat());
  editingAsset = null;
  listRefresh.flush();
});
window.addEventListener('focus', renewMetadataLock);
window.addEventListener('pagehide', event => {
  const lock = stopMetadataHeartbeat();
  releaseMetadataLock(lock, true);
  if (lock && event.persisted) loseMetadataLock();
});
async function changeTrash(asset, trashed, editToken) {
  if (!asset || changingTrash || savingMetadata || inserting || replacing) return;
  changingTrash = true;
  ui.metadataError.hidden = true;
  if (trashed) for (const control of ui.metadataForm.elements) control.disabled = true;
  refreshFavoriteButton();
  refreshHost();
  const originalView = libraryView;
  try {
    await request(`/api/assets/${encodeURIComponent(asset.id)}/trash`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed, editToken }),
    });
    if (trashed) ui.metadataDialog.close();
    if (libraryView === originalView) {
      renderAssets(visibleAssets.filter(item => item.id !== asset.id));
      if (selected?.id === asset.id) selectAsset(null);
    }
    const data = await loadLibrary();
    showAction(data ? trashed ? '已移入回收站' : '已恢复到图库'
      : `${trashed ? '图片已移入回收站' : '图片已恢复'}，但图库刷新失败，请重新读取`, !data);
  } catch (error) {
    const message = `${trashed ? '移出' : '恢复'}失败：${readableError(error)}`;
    if (trashed) {
      if (editToken && LOST_METADATA_LOCK_STATUS.has(error.status)) loseMetadataLock();
      else {
        ui.metadataError.textContent = message;
        ui.metadataError.hidden = false;
      }
    } else showAction(message, true);
  } finally {
    changingTrash = false;
    if (trashed) for (const control of ui.metadataForm.elements) control.disabled = false;
    if (trashed && ui.metadataDialog.open && !metadataLock) {
      ui.saveMetadata.disabled = true;
      ui.trashButton.disabled = true;
    }
    refreshFavoriteButton();
    refreshHost();
  }
}
ui.trashButton.addEventListener('click', () => {
  if (libraryView !== 'trash' && ui.metadataDialog.open && metadataLock) changeTrash(editingAsset, true, metadataLock.token);
});
ui.restoreButton.addEventListener('click', () => {
  if (libraryView === 'trash') changeTrash(selected, false);
});
function openTrashDialog({ ids, name, clearing = false }) {
  if (changingTrash || savingMetadata || inserting || replacing) return;
  const permanent = libraryView === 'trash';
  if (clearing ? !permanent || !trashSnapshot?.count : !ids?.length) return;
  const body = clearing ? { all: true, revision: trashSnapshot.revision } : { ids };
  pendingTrash = { body, clearing, permanent, mode: connection.mode, url: connection.url };
  const scope = connection.mode === 'lan' || connection.lanServer ? '共享图库' : '本机图库';
  if (clearing) {
    ui.trashTitle.textContent = '清空回收站';
    ui.trashDescription.textContent = `将永久删除${scope}回收站里的全部 ${trashSnapshot.count} 张素材，包括当前筛选之外的图片。删除后无法恢复。`;
    ui.confirmTrash.textContent = '确认清空';
  } else {
    const target = name ? `「${name}」` : `选中的 ${ids.length} 张素材`;
    ui.trashTitle.textContent = permanent ? '永久删除素材' : '移到回收站';
    ui.trashDescription.textContent = permanent
      ? `从${scope}永久删除${target}？删除后无法恢复。`
      : `将${target}移到回收站？移出后可以恢复。`;
    ui.confirmTrash.textContent = permanent ? '永久删除' : '确认移出';
  }
  ui.confirmTrash.toggleAttribute('data-permanent', permanent);
  ui.trashError.hidden = true;
  ui.trashDialog.showModal();
}
for (const button of [ui.moveToTrash, ui.purgeButton]) {
  button.addEventListener('click', () => {
    if (selected) openTrashDialog({ ids: [selected.id], name: selected.name });
  });
}
ui.batchTrash.addEventListener('click', () => openTrashDialog({ ids: [...multiSelected] }));
ui.clearAssetTrash.addEventListener('click', () => openTrashDialog({ clearing: true }));
ui.cancelTrash.addEventListener('click', () => ui.trashDialog.close());
ui.trashDialog.addEventListener('cancel', event => {
  if (changingTrash) event.preventDefault();
});
ui.trashDialog.addEventListener('close', () => { pendingTrash = null; });
ui.trashForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingTrash || changingTrash || savingMetadata || inserting || replacing) return;
  const { body, clearing, permanent, mode, url } = pendingTrash;
  changingTrash = true;
  ui.trashError.hidden = true;
  for (const control of ui.trashForm.elements) control.disabled = true;
  refreshHost();
  try {
    const source = await request('/api/connection');
    if (source.mode !== mode || source.url !== url) throw new Error('图库来源已切换，请关闭弹窗后重新选择素材');
    const result = await request(`/api/assets/batch/${permanent ? 'purge' : 'trash'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-iPeiTu-Library': mode === 'local' ? 'local' : url ?? '' },
      body: JSON.stringify(body),
    });
    ui.trashDialog.close();
    if (clearing) {
      clearLibrarySelection();
    } else {
      const moved = new Set(body.ids);
      for (const id of moved) multiSelected.delete(id);
      renderAssets(visibleAssets.filter(asset => !moved.has(asset.id)));
      if (moved.has(selected?.id)) selectAsset(null);
      if (multiMode === 'ctrl' && !multiSelected.size) setMultiMode(null);
      syncCardStates();
    }
    const data = await loadLibrary();
    const message = clearing ? `已清空回收站，永久删除 ${result.purged} 张素材`
      : permanent ? `已永久删除 ${result.purged} 张素材` : `已将 ${result.trashed} 张素材移到回收站`;
    const cleanup = result.cleanupPending ? '，部分文件待清理，服务重启后会重试' : '';
    showAction(`${message}${cleanup}${data ? '' : '，图库刷新失败，请重新读取'}`, !data || result.cleanupPending);
  } catch (error) {
    if (clearing && error.status === 409) {
      ui.trashDialog.close();
      await loadLibrary();
      showAction(readableError(error), true);
      return;
    }
    ui.trashError.textContent = `${permanent ? '永久删除' : '移出'}失败：${readableError(error)}`;
    ui.trashError.hidden = false;
  } finally {
    changingTrash = false;
    for (const control of ui.trashForm.elements) control.disabled = false;
    refreshHost();
  }
});
ui.metadataDialog.addEventListener('cancel', event => {
  if (savingMetadata || changingTrash) event.preventDefault();
});
ui.metadataForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingAsset || !metadataLock || savingMetadata || changingTrash) return;
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
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...patch, editToken: metadataLock.token }),
    });
    persisted = true;
    const data = await loadLibrary();
    const visible = data?.assets.find(item => item.id === asset.id);
    if (data) selectAsset(visible || null);
    ui.metadataDialog.close();
    showAction(!data ? '素材信息已保存，但图库刷新失败，请重新读取'
      : visible ? '素材信息已保存' : '素材信息已保存，图片不在当前筛选结果中', !data);
  } catch (error) {
    if (!persisted && LOST_METADATA_LOCK_STATUS.has(error.status)) loseMetadataLock();
    else {
      ui.metadataError.textContent = persisted ? '素材信息已保存，但显示未能刷新，请关闭后重新读取图库' : `保存失败：${readableError(error)}`;
      ui.metadataError.hidden = false;
    }
  } finally {
    savingMetadata = false;
    for (const control of ui.metadataForm.elements) control.disabled = false;
    if (ui.metadataDialog.open && !metadataLock) {
      ui.saveMetadata.disabled = true;
      ui.trashButton.disabled = true;
    }
    ui.saveMetadata.textContent = '保存信息';
    refreshHost();
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
for (const button of document.querySelectorAll('.dialog-close')) {
  button.addEventListener('click', () => button.closest('dialog').close('cancel'));
}
ui.layoutSettingsButton.addEventListener('click', () => {
  fillLayoutForm(layoutPreferences, captionDraft);
  ui.layoutDialog.showModal();
  pickers.get(ui.widthMode).focus();
});
ui.widthMode.addEventListener('change', syncLayoutFields);
ui.includeCaption.addEventListener('change', syncLayoutFields);
ui.cancelLayout.addEventListener('click', () => ui.layoutDialog.close());
ui.resetLayout.addEventListener('click', () => {
  fillLayoutForm({ ...normalizeLayoutOptions(), includeCaption: false, qualityProfile: 'original' }, defaultCaption(selected));
});
ui.layoutForm.addEventListener('submit', (event) => {
  event.preventDefault();
  ui.layoutError.hidden = true;
  let options;
  let qualityProfile;
  const includeCaption = ui.includeCaption.checked;
  const caption = includeCaption && selected ? ui.captionText.value.trim() : '';
  try {
    qualityProfile = normalizeQualityProfile(ui.qualityProfile.value);
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
  layoutPreferences = { ...preferences, includeCaption, qualityProfile };
  if (selected) captionDraft = appliedCaption || ui.captionText.value.trim() || defaultCaption(selected);
  let saved = true;
  try {
    saveLayoutPreferences(layoutPreferences);
  } catch {
    saved = false;
  }
  updateLayoutSummary();
  ui.layoutDialog.close();
  showAction(saved ? '设置已保存' : '设置已应用于本次使用，但未能保存在本机', !saved);
});
ui.replaceButton.addEventListener('click', async () => {
  if (!selected || inserting || replacing || changingTrash || libraryView === 'trash') return;
  refreshHost();
  if (!replacementAvailable) return;
  const asset = selected;
  replacing = true;
  ui.replaceButton.textContent = '正在替换';
  refreshHost();
  showAction('');
  try {
    const profile = normalizeQualityProfile(layoutPreferences.qualityProfile);
    const target = captureReplacementTarget();
    const insertion = await request(`/api/assets/${encodeURIComponent(asset.id)}/insertion?profile=${profile}`);
    replacePicture(insertion, target);
    showAction(`已替换「${asset.name}」`);
    await recordSuccessfulUse(asset, '替换');
  } catch (error) {
    showAction(error.inserted || error.replaced || error.resultUncertain ? error.message : `替换失败：${readableError(error)}`, true);
  } finally {
    replacing = false;
    ui.replaceButton.textContent = '替换选中图';
    refreshHost();
  }
});
window.addEventListener('focus', refreshHost);
document.documentElement.addEventListener('pointerenter', refreshHost);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshHost();
});
ui.fitMode.addEventListener('change', () => {
  try {
    localStorage.setItem(FIT_STORAGE_KEY, ui.fitMode.value);
  } catch {
    showAction('适配方式已应用于本次使用，但未能保存在本机', true);
  }
});
ui.searchBoxName.addEventListener('click', () => {
  if (!fillTarget.available) return;
  ui.searchInput.value = fillTarget.name;
  scheduleSearch();
});
ui.ratioSort.addEventListener('click', () => {
  ratioSort = !ratioSort;
  refreshHost();
});
try {
  const savedFit = localStorage.getItem(FIT_STORAGE_KEY);
  if (FIT_MODES.includes(savedFit)) ui.fitMode.value = savedFit;
  pickers.get(ui.fitMode).refresh();
} catch {
  // 读不到本机设置时沿用默认的裁切填满，不影响使用。
}

try {
  layoutPreferences = loadLayoutPreferences();
} catch {
  showAction('无法读取上次的排版设置，本次使用默认设置', true);
}
// 图库来源：本机图库或局域网图库，二选一。切换由本机服务保存，素材库与知识库窗格共用。
let connection = { mode: 'local', url: null, lanServer: false };

function renderConnection() {
  const lan = connection.mode === 'lan';
  ui.sourceButton.textContent = lan ? '局域网' : '本机';
  ui.sourceButton.classList.toggle('is-lan', lan);
  ui.sourceButton.title = lan ? `局域网图库 ${connection.url ?? '（连接配置有误）'}` : connection.lanServer ? '本机图库，已开放给局域网' : '本机图库';
  ui.importScope.textContent = lan ? '保存到局域网图库' : connection.lanServer ? '保存在本机，局域网共享' : '仅保存在本机';
  ui.folderImportScope.textContent = ui.importScope.textContent;
}

async function loadConnection({ background = false } = {}) {
  const previous = `${connection.mode} ${connection.url}`;
  let next;
  try { next = await request('/api/connection'); } catch {
    // 服务未运行时由图库读取失败给出说明，这里保持上次的显示。
  }
  if (!next) return null;
  if (background && (listRefreshPaused() || ui.assetGrid.getAttribute('aria-busy') === 'true')) {
    listRefresh.request();
    return null;
  }
  connection = next;
  renderConnection();
  const changed = previous !== `${connection.mode} ${connection.url}`;
  if (changed) clearLibrarySelection();
  return changed;
}

async function refreshOnReturn() {
  const changed = await loadConnection({ background: true });
  if (changed) clearAllConditions();
  else if (changed === false) await loadLibrary({ background: true });
}

function showConnectionError(message) {
  ui.connectionError.textContent = message;
  ui.connectionError.hidden = !message;
}

async function changeSource(method, body) {
  ui.connectServer.disabled = true;
  ui.useLocal.disabled = true;
  showConnectionError('');
  if (method === 'PUT') ui.connectServer.textContent = '连接中…';
  try {
    connection = await request('/api/connection', body
      ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method });
    ui.connectionDialog.close();
    renderConnection();
    clearLibrarySelection();
    clearAllConditions();
    showAction(connection.mode === 'lan' ? `已连接局域网图库 ${connection.url}` : '已切回本机图库');
  } catch (error) {
    showConnectionError(readableError(error));
  } finally {
    ui.connectServer.disabled = connection.lanServer;
    ui.useLocal.disabled = false;
    ui.connectServer.textContent = '连接图库';
  }
}

ui.sourceButton.addEventListener('click', async () => {
  if (await loadConnection()) clearAllConditions();
  const lan = connection.mode === 'lan';
  ui.connectionCurrent.textContent = lan ? '局域网图库' : '本机图库';
  ui.serverUrl.value = connection.url ?? '';
  ui.accessKey.value = '';
  ui.accessKey.placeholder = lan && connection.url ? '重新连接时需再次填写' : '输入共享电脑提供的密钥';
  ui.useLocal.hidden = !lan;
  ui.connectionServing.hidden = !connection.lanServer;
  ui.connectionShared.hidden = !connection.lanServer;
  for (const control of [ui.serverUrl, ui.accessKey, ui.connectServer]) control.disabled = connection.lanServer;
  showConnectionError(connection.error ?? '');
  ui.connectionDialog.showModal();
});
ui.connectionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!ui.serverUrl.value.trim()) { showConnectionError('请填写服务器地址'); ui.serverUrl.focus(); return; }
  if (!ui.accessKey.value.trim()) { showConnectionError('请填写访问密钥'); ui.accessKey.focus(); return; }
  changeSource('PUT', { url: ui.serverUrl.value, key: ui.accessKey.value });
});
ui.useLocal.addEventListener('click', () => changeSource('DELETE'));
ui.cancelConnection.addEventListener('click', () => ui.connectionDialog.close());
updateLayoutSummary();
refreshHost();
loadConnection().then(() => loadLibrary());
