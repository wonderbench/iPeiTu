import {
  formattedSnippetLine, getKnowledgeHostStatus, insertSnippet, normalizeKnowledgeOptions, parseSnippetBody, readSelectionAsSnippet,
} from './knowledge-bridge.js';
import { enhancePickers } from './select-picker.js';
import { readFormattedPaste } from './knowledge-paste.js';
import { formatForSave, isSnippetFormat, trimSnippetBody, updateSnippetFormat } from './knowledge-format.js';
import { createViewRefresh } from './view-refresh.js';

const pickers = enhancePickers();
const management = new URLSearchParams(location.search).get('manage') === '1';
document.documentElement.classList.toggle('management-view', management);

const OPTIONS_KEY = 'ipeitu.knowledge.v1';
const EDIT_LOCK_HEARTBEAT = 30_000;
const LOST_EDIT_LOCK_STATUS = new Set([404, 409, 410, 423]);
const $ = id => document.getElementById(id);
const elements = {
  search: $('searchInput'), clearSearch: $('clearSearch'), typeChips: $('typeChips'), sectionChips: $('sectionChips'),
  viewButtons: [$('viewAll'), $('viewTrash')], count: $('resultCount'), list: $('snippetList'),
  state: $('knowledgeState'), stateTitle: $('stateTitle'), stateDescription: $('stateDescription'), stateAction: $('stateAction'),
  preview: $('snippetPreview'), previewTitle: $('previewTitle'), previewMeta: $('previewMeta'), previewBody: $('previewBody'),
  edit: $('editSnippet'), trash: $('trashSnippet'), restore: $('restoreSnippet'), purge: $('purgeSnippet'),
  trashTools: $('knowledgeTrashTools'), trashBatch: $('knowledgeTrashBatch'), trashCount: $('knowledgeTrashCount'),
  toggleTrashMulti: $('toggleTrashMulti'), clearTrash: $('clearKnowledgeTrash'), selectTrashCurrent: $('selectTrashCurrent'),
  purgeSelection: $('purgeTrashSelection'), purgeDialog: $('knowledgePurgeDialog'), purgeForm: $('knowledgePurgeForm'),
  purgeTitle: $('knowledgePurgeTitle'), purgeDescription: $('knowledgePurgeDescription'), purgeError: $('knowledgePurgeError'),
  purgeConfirm: $('confirmKnowledgePurge'),
  baseLevel: $('baseLevel'), capture: $('captureSelection'),
  hostStatus: $('hostStatus'), actionStatus: $('actionStatus'), newSnippet: $('newSnippet'), sourceBadge: $('sourceBadge'),
  dialog: $('snippetDialog'), form: $('snippetForm'), dialogTitle: $('snippetDialogTitle'), title: $('snippetTitle'),
  type: $('snippetType'), section: $('snippetSection'), sectionOptions: $('sectionOptions'), tags: $('snippetTags'),
  body: $('snippetBody'), formatStatus: $('snippetFormatStatus'), error: $('snippetError'), cancel: $('cancelSnippet'), save: $('saveSnippet'),
};
const state = {
  q: '', type: '', section: '', view: 'all', snippets: [], categories: [], facets: { types: {}, sections: [] },
  total: 0, viewTotal: 0, selectedId: null, focusId: null, editingId: null, formattedDraft: null,
  inserting: false, loading: null, failed: false,
  trashRevision: null, trashMulti: false, trashSelection: new Set(), purging: false,
};
const formatHistory = new Map();
let selectionBeforeEdit;
let pendingPurge;
let sharedLibrary = false;
let editLock = null;
let editHeartbeat;
let openingEditor = false;
let savingEditor = false;
let lastKnowledgeData;
const listRefreshPaused = () => openingEditor || savingEditor || state.inserting || state.purging
  || Boolean(document.querySelector('dialog[open]'));
const listRefresh = createViewRefresh({
  canRefresh: () => !state.loading && !listRefreshPaused(),
  refresh: refreshOnReturn,
  pointer: !management,
});

function showStatus(message, error = false) {
  elements.actionStatus.textContent = message;
  elements.actionStatus.classList.toggle('error', error);
  elements.actionStatus.hidden = !message;
}

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: options.body ? { 'content-type': 'application/json' } : undefined });
  } catch {
    throw new Error('无法连接本机 iPeiTu 服务，请确认服务已启动');
  }
  let data = {};
  try { data = await response.json(); } catch {
    // 非 JSON 响应按状态码报告。
  }
  if (!response.ok) throw Object.assign(new Error(data.error || `本机服务返回错误 ${response.status}`), { status: response.status });
  return data;
}

function readOptions() {
  try {
    return normalizeKnowledgeOptions(JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') ?? {});
  } catch {
    return normalizeKnowledgeOptions();
  }
}

function currentOptions() {
  return normalizeKnowledgeOptions({ baseLevel: elements.baseLevel.value });
}

function saveOptions() {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(currentOptions()));
  } catch {
    showStatus('插入设置已用于本次操作，但未能保存在本机', true);
  }
}

function chip(label, count, pressed, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-pressed', String(pressed));
  button.append(label);
  if (count !== undefined) {
    const figure = document.createElement('span');
    figure.className = 'figures';
    figure.textContent = String(count);
    button.append(figure);
  }
  button.addEventListener('click', onClick);
  return button;
}

function renderChips() {
  const types = state.facets.types;
  const all = Object.values(types).reduce((sum, count) => sum + count, 0);
  elements.typeChips.replaceChildren(
    chip('全部', all, !state.type, () => setFilter('', '')),
    ...state.categories.map(category => chip(category.type, types[category.type] ?? 0, state.type === category.type, () => setFilter(category.type, ''))),
  );
  const category = state.categories.find(item => item.type === state.type);
  elements.sectionChips.hidden = !category;
  if (!category) return elements.sectionChips.replaceChildren();
  const counts = new Map(state.facets.sections.filter(item => item.type === state.type).map(item => [item.section, item.count]));
  const sections = [...category.sections, ...[...counts.keys()].filter(section => !category.sections.includes(section))];
  if (state.section && !sections.includes(state.section)) sections.push(state.section);
  elements.sectionChips.replaceChildren(
    chip('全部章节', undefined, !state.section, () => setFilter(state.type, '')),
    ...sections.map(section => chip(section, counts.get(section) ?? 0, state.section === section, () => setFilter(state.type, section))),
  );
}

function excerpt(snippet) {
  if (snippet.format) return snippet.body.split('\n', 1)[0];
  return parseSnippetBody(snippet.body).find(item => !item.level)?.text ?? parseSnippetBody(snippet.body)[0]?.text ?? '';
}

function selected() {
  return state.snippets.find(snippet => snippet.id === state.selectedId) ?? null;
}

function hostReason() {
  if (state.view === 'trash') return { available: false, message: '回收站中的片段需先恢复' };
  return getKnowledgeHostStatus();
}

function renderList() {
  const host = hostReason();
  if (!state.snippets.some(snippet => snippet.id === state.focusId)) state.focusId = state.selectedId ?? state.snippets[0]?.id ?? null;
  elements.list.replaceChildren(...state.snippets.map(snippet => {
    const item = document.createElement('li');
    item.className = 'snippet-item';
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'snippet-card';
    card.dataset.id = snippet.id;
    card.tabIndex = snippet.id === state.focusId ? 0 : -1;
    card.setAttribute('aria-pressed', String(state.trashMulti ? state.trashSelection.has(snippet.id) : snippet.id === state.selectedId));
    const title = document.createElement('span');
    title.className = 'snippet-title';
    title.textContent = snippet.title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = state.type ? snippet.section : `${snippet.type} · ${snippet.section}`;
    const summary = document.createElement('span');
    summary.className = 'snippet-excerpt';
    summary.textContent = excerpt(snippet);
    card.append(title, meta, summary);
    if (state.trashMulti) {
      const check = document.createElement('span');
      check.className = 'trash-check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<svg class="icon"><use href="#i-check"/></svg>';
      card.append(check);
    }
    card.addEventListener('click', event => activateCard(snippet.id, event));
    item.append(card);
    if (!management && state.view !== 'trash') {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'card-add';
      add.dataset.id = snippet.id;
      add.tabIndex = snippet.id === state.focusId ? 0 : -1;
      add.disabled = !host.available;
      add.title = host.available ? `插入「${snippet.title}」到光标处` : host.message;
      add.setAttribute('aria-label', `插入片段：${snippet.title}`);
      add.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>';
      add.addEventListener('click', () => insert(snippet.id, add));
      item.append(add);
    }
    return item;
  }));
  elements.list.setAttribute('aria-busy', 'false');
}

function renderState() {
  const filtered = state.q || state.type || state.section;
  let title = '';
  let description = '';
  let action = '';
  if (state.failed) {
    title = '知识库读取失败';
    description = state.failed;
    action = '重试';
  } else if (!state.snippets.length) {
    if (state.view === 'trash') title = state.viewTotal ? '没有匹配的回收站片段' : '回收站为空';
    else if (state.q) { title = '没有找到片段'; description = '换个关键词，或清空检索'; }
    else if (filtered) { title = '此分类暂无片段'; action = '新建片段'; }
    else {
      title = '知识库还没有片段';
      description = management ? '' : '新建片段，或在文档中选中段落后收录';
      action = '新建片段';
    }
  }
  elements.state.hidden = !title;
  elements.stateTitle.textContent = title;
  elements.stateDescription.textContent = description;
  elements.stateDescription.hidden = !description;
  elements.stateAction.textContent = action;
  elements.stateAction.hidden = !action;
  elements.count.textContent = state.failed ? '' : state.snippets.length === state.viewTotal
    ? `${state.viewTotal} 段` : `${state.snippets.length} / ${state.viewTotal} 段`;
}

function renderFormattedParagraph(text, { paragraph, runs }) {
  const element = document.createElement('p');
  element.className = 'snippet-formatted-paragraph';
  if (paragraph.Alignment !== undefined) {
    element.style.textAlign = ['left', 'center', 'right', 'justify'][paragraph.Alignment];
  }
  if (paragraph.CharacterUnitFirstLineIndent !== undefined) {
    element.style.textIndent = `${paragraph.CharacterUnitFirstLineIndent}em`;
  } else if (paragraph.FirstLineIndent !== undefined) {
    element.style.textIndent = `${paragraph.FirstLineIndent}pt`;
  }

  let offset = 0;
  for (const { start, end, font } of runs) {
    const span = document.createElement('span');
    span.textContent = text.slice(start, end);
    const families = [...new Set([font.Name, font.NameFarEast].filter(Boolean))];
    if (families.length) span.style.fontFamily = families.map(name => JSON.stringify(name)).join(', ');
    if (font.Size !== undefined) span.style.fontSize = `${font.Size}pt`;
    if (font.Bold) span.style.fontWeight = 'bold';
    if (font.Italic) span.style.fontStyle = 'italic';
    if (font.Underline) span.style.textDecorationLine = 'underline';
    if (font.Color !== undefined) {
      // WPS 把红色通道放在最低字节。
      span.style.color = `rgb(${font.Color & 255}, ${(font.Color >> 8) & 255}, ${(font.Color >> 16) & 255})`;
    }
    element.append(text.slice(offset, start), span);
    offset = end;
  }
  element.append(text.slice(offset));
  return element;
}

function renderPreview() {
  const snippet = selected();
  elements.preview.hidden = !snippet;
  if (!snippet) return;
  elements.previewTitle.textContent = snippet.title;
  elements.previewMeta.textContent = [snippet.type, snippet.section, ...snippet.tags].join(' · ');
  const paragraphs = isSnippetFormat(snippet.format, snippet.body)
    ? snippet.body.split('\n').map((line, index) => {
      const { text, format } = formattedSnippetLine(line, snippet.format[index]);
      return renderFormattedParagraph(text, format);
    })
    : parseSnippetBody(snippet.body, { preserveBlankLines: true }).map(item => {
      const paragraph = document.createElement('p');
      if (item.level) paragraph.className = `snippet-heading level-${item.level}`;
      paragraph.textContent = item.text;
      return paragraph;
    });
  elements.previewBody.replaceChildren(...paragraphs);
  const trashed = state.view === 'trash';
  elements.edit.hidden = trashed;
  elements.trash.hidden = trashed;
  elements.restore.hidden = !trashed;
  elements.purge.hidden = !trashed;
}

function canPurge() {
  return state.view === 'trash' && !state.loading && !state.purging && Boolean(state.trashRevision);
}

function renderTrashActions() {
  const inTrash = state.view === 'trash';
  elements.trashTools.hidden = !inTrash;
  elements.trashBatch.hidden = !inTrash || !state.trashMulti;
  elements.trashCount.textContent = `已选 ${state.trashSelection.size} 段`;
  elements.toggleTrashMulti.setAttribute('aria-pressed', String(state.trashMulti));
  const loaded = !state.loading && !state.failed;
  elements.toggleTrashMulti.disabled = !loaded || (!state.trashMulti && !state.snippets.length);
  elements.selectTrashCurrent.disabled = !loaded || !state.snippets.length;
  elements.clearTrash.disabled = !canPurge() || !state.viewTotal;
  elements.purge.disabled = !canPurge();
  elements.purgeSelection.disabled = !canPurge() || !state.trashSelection.size;
}

function refreshHost() {
  const host = getKnowledgeHostStatus();
  elements.hostStatus.textContent = host.message;
  elements.hostStatus.classList.toggle('ready', host.available);
  elements.capture.disabled = typeof globalThis.Application === 'undefined';
  const reason = hostReason();
  for (const add of elements.list.querySelectorAll('.card-add')) {
    if (state.inserting) continue;
    add.disabled = !reason.available;
    const snippet = state.snippets.find(item => item.id === add.dataset.id);
    add.title = reason.available ? `插入「${snippet?.title ?? ''}」到光标处` : reason.message;
  }
}

function render() {
  renderChips();
  renderList();
  renderState();
  renderPreview();
  renderTrashActions();
  refreshHost();
  elements.newSnippet.disabled = !state.categories.length;
}

async function load({ background = false } = {}) {
  listRefresh.consume();
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.type) params.set('type', state.type);
  if (state.section) params.set('section', state.section);
  if (state.view !== 'all') params.set('view', state.view);
  const query = params.toString();
  const pending = request(`/api/knowledge${query ? `?${query}` : ''}`);
  state.loading = pending;
  if (!background) renderTrashActions();
  let changed = false;
  try {
    const data = await pending;
    if (state.loading !== pending) return;
    if (background && listRefreshPaused()) {
      listRefresh.request();
      return;
    }
    if (elements.actionStatus.textContent.startsWith('知识库列表暂未更新：')) showStatus('');
    if (background && lastKnowledgeData?.query === query
      && JSON.stringify(lastKnowledgeData.data) === JSON.stringify(data)) return;
    lastKnowledgeData = { query, data };
    changed = true;
    Object.assign(state, {
      snippets: data.snippets, categories: data.categories, facets: data.facets, total: data.total, viewTotal: data.viewTotal, failed: false,
      trashRevision: data.trashRevision ?? null,
    });
    if (!state.snippets.some(snippet => snippet.id === state.selectedId)) state.selectedId = null;
    if (state.trashMulti) {
      const visible = new Set(state.snippets.map(snippet => snippet.id));
      state.trashSelection = new Set([...state.trashSelection].filter(id => visible.has(id)));
    }
  } catch (error) {
    if (state.loading !== pending) return;
    if (background && lastKnowledgeData) {
      showStatus(`知识库列表暂未更新：${error.message}`, true);
      return;
    }
    lastKnowledgeData = null;
    changed = true;
    Object.assign(state, { snippets: [], failed: error.message, selectedId: null, trashRevision: null });
  } finally {
    if (state.loading === pending) {
      state.loading = null;
      if (changed) {
        const active = document.activeElement;
        const focused = background && elements.list.contains(active) ? active : null;
        render();
        if (focused) {
          const button = [...elements.list.querySelectorAll('.snippet-card, .card-add')]
            .find(item => item.className === focused.className && item.dataset.id === focused.dataset.id);
          (button ?? elements.list.querySelector('.snippet-card[tabindex="0"]'))?.focus({ preventScroll: true });
        }
      } else {
        renderTrashActions();
      }
      listRefresh.flush();
    }
  }
}

function setFilter(type, section) {
  state.type = type;
  state.section = section;
  load();
}

function select(id) {
  state.selectedId = id;
  state.focusId = id;
  syncSelection();
}

function syncSelection() {
  for (const card of elements.list.querySelectorAll('.snippet-card')) {
    const id = card.dataset.id;
    const active = state.trashMulti ? state.trashSelection.has(id) : state.selectedId === id;
    card.setAttribute('aria-pressed', String(active));
    card.tabIndex = state.focusId === id ? 0 : -1;
  }
  for (const add of elements.list.querySelectorAll('.card-add')) add.tabIndex = add.dataset.id === state.focusId ? 0 : -1;
  renderPreview();
  renderTrashActions();
}

function toggleTrashMulti(enabled) {
  state.trashMulti = enabled;
  state.trashSelection = new Set(enabled && state.selectedId ? [state.selectedId] : []);
  state.selectedId = null;
  renderList();
  syncSelection();
}

function activateCard(id, event) {
  if (state.view !== 'trash' || (!state.trashMulti && !event.ctrlKey && !event.metaKey)) {
    select(id);
    return;
  }
  const enabledNow = !state.trashMulti;
  if (enabledNow) toggleTrashMulti(true);
  if (state.trashSelection.has(id)) state.trashSelection.delete(id);
  else state.trashSelection.add(id);
  state.focusId = id;
  syncSelection();
  if (enabledNow) elements.list.querySelector('.snippet-card[tabindex="0"]')?.focus();
}

function insert(id, button) {
  if (state.inserting) return;
  select(id);
  const snippet = selected();
  if (!snippet) return;
  state.inserting = true;
  try {
    const result = insertSnippet(snippet, currentOptions());
    saveOptions();
    const detail = result.inTable ? '（表格内沿用单元格格式）' : result.headings ? `，其中小标题 ${result.headings} 段` : '';
    showStatus(`已插入「${snippet.title}」：${result.paragraphs} 段${detail}`);
    button.classList.add('added');
    button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>';
    setTimeout(() => {
      button.classList.remove('added');
      button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>';
    }, 1200);
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    state.inserting = false;
    refreshHost();
    listRefresh.flush();
  }
}

function fillSectionOptions(type) {
  const category = state.categories.find(item => item.type === type);
  elements.sectionOptions.replaceChildren(...(category?.sections ?? []).map(section => {
    const option = document.createElement('option');
    option.value = section;
    return option;
  }));
}

function openEditor(snippet, draft = {}) {
  state.editingId = snippet?.id ?? null;
  elements.dialogTitle.textContent = snippet ? '编辑片段' : '新建片段';
  elements.type.replaceChildren(...state.categories.map(category => new Option(category.type, category.type)));
  const type = snippet?.type ?? (state.type || state.categories[0]?.type || '');
  elements.type.value = type;
  pickers.get(elements.type).refresh();
  fillSectionOptions(type);
  elements.title.value = snippet?.title ?? draft.title ?? '';
  elements.section.value = snippet?.section ?? state.section ?? '';
  elements.tags.value = (snippet?.tags ?? []).join('，');
  elements.body.value = snippet?.body ?? draft.body ?? '';
  formatHistory.clear();
  selectionBeforeEdit = undefined;
  const source = snippet ?? draft;
  rememberFormat(source.format ? { body: source.body, format: source.format } : null);
  showFormatStatus(draft.formatNotice ?? (source.format
    ? snippet ? '编辑时保留原格式，新文字沿用当前位置的格式。' : '已记录所选文字的原格式。'
    : draft.paragraphs ? 'WPS 未返回可保存的格式，已收录所选文字。' : ''));
  elements.error.hidden = true;
  elements.save.disabled = false;
  elements.dialog.showModal();
  (elements.title.value ? elements.body : elements.title).focus();
}

function stopEditHeartbeat() {
  const lock = editLock;
  editLock = null;
  clearInterval(editHeartbeat);
  return lock;
}

function releaseEditLock(lock, keepalive = false) {
  if (lock) {
    request(lock.url, { method: 'PATCH', body: JSON.stringify({ token: lock.token, release: true }), keepalive })
      .catch(() => {}); // 窗格关闭或连接中断时由服务器超时释放。
  }
}

function loseEditLock(message) {
  stopEditHeartbeat();
  elements.save.disabled = true;
  elements.error.textContent = `${message}。当前草稿仍可复制。`;
  elements.error.hidden = false;
}

async function renewEditLock() {
  const lock = editLock;
  if (!lock || lock.renewing || savingEditor) return;
  lock.renewing = true;
  try {
    await request(lock.url, { method: 'PATCH', body: JSON.stringify({ token: lock.token }) });
  } catch (error) {
    if (editLock === lock && !savingEditor && LOST_EDIT_LOCK_STATUS.has(error.status)) {
      loseEditLock('当前编辑锁已失效，请重新打开片段后编辑');
    }
  } finally {
    lock.renewing = false;
  }
}

async function openLockedEditor() {
  const current = selected();
  if (!current || openingEditor || savingEditor || elements.dialog.open) return;
  const initialSource = source;
  const url = `/api/knowledge/${current.id}/edit-lock`;
  openingEditor = true;
  elements.edit.disabled = true;
  try {
    const { snippet, token } = await request(url, { method: 'POST', body: '{}' });
    const lock = { url, token, renewing: false };
    if (elements.dialog.open || selected()?.id !== snippet.id
      || state.view !== 'all' || (initialSource !== null && source !== initialSource)) {
      releaseEditLock(lock);
      return;
    }
    editLock = lock;
    openEditor(snippet);
    editHeartbeat = setInterval(renewEditLock, EDIT_LOCK_HEARTBEAT);
    showStatus('');
  } catch (error) {
    releaseEditLock(stopEditHeartbeat());
    showStatus(error.message, true);
  } finally {
    openingEditor = false;
    elements.edit.disabled = false;
    listRefresh.flush();
  }
}

function showFormatStatus(message) {
  elements.formatStatus.textContent = message;
  elements.formatStatus.hidden = !message;
}

function rememberFormat(draft) {
  state.formattedDraft = draft;
  if (!draft) return;
  formatHistory.set(draft.body, draft);
  if (formatHistory.size > 20) formatHistory.delete(formatHistory.keys().next().value);
}

function editorBody() {
  return elements.body.value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
}

elements.body.addEventListener('paste', event => {
  const html = event.clipboardData?.getData('text/html');
  if (!html) return;
  const body = elements.body;
  const replacesBody = body.selectionStart === 0 && body.selectionEnd === body.value.length;
  const draft = replacesBody ? readFormattedPaste(html, event.clipboardData.getData('text/plain'), body.maxLength) : null;
  if (!draft) {
    if (!state.formattedDraft) {
      showFormatStatus(replacesBody ? '此内容将按纯文字粘贴。' : '保留来源格式时，请选中全部正文后重新粘贴。');
    }
    return;
  }
  event.preventDefault();
  body.setRangeText(draft.body, 0, body.value.length, 'end');
  rememberFormat(draft);
  showFormatStatus('已记录原格式。编辑时会保留格式。');
});

elements.body.addEventListener('beforeinput', () => {
  selectionBeforeEdit = { start: elements.body.selectionStart, end: elements.body.selectionEnd };
});

elements.body.addEventListener('input', event => {
  let selection = selectionBeforeEdit;
  selectionBeforeEdit = undefined;
  const draft = state.formattedDraft;
  if (!draft) {
    if (event.inputType !== 'insertFromPaste') showFormatStatus('');
    return;
  }
  const body = editorBody();
  if (selection && selection.start === selection.end && event.inputType?.startsWith('delete')) {
    const start = Math.min(selection.start, elements.body.selectionStart);
    selection = { start, end: start + draft.body.length - body.length };
  }
  const undoOrRedo = event.inputType === 'historyUndo' || event.inputType === 'historyRedo';
  const restored = undoOrRedo ? formatHistory.get(body) : undefined;
  rememberFormat(restored ?? updateSnippetFormat(draft, body, undoOrRedo ? undefined : selection));
  showFormatStatus('编辑时保留原格式，新文字沿用当前位置的格式。');
});

function formInput() {
  const body = editorBody();
  const draft = state.formattedDraft;
  const format = draft ? formatForSave(updateSnippetFormat(draft, body), trimSnippetBody(body)) : undefined;
  return {
    title: elements.title.value,
    type: elements.type.value,
    section: elements.section.value,
    tags: elements.tags.value.split(/[,，、;；\n]/).map(tag => tag.trim()).filter(Boolean),
    body,
    ...(format ? { format } : {}),
  };
}

async function saveEditor(event) {
  event.preventDefault();
  if (savingEditor || (state.editingId && !editLock)) return;
  savingEditor = true;
  elements.save.disabled = true;
  try {
    const input = formInput();
    const missing = [['标题', input.title], ['章节', input.section], ['正文', input.body]].find(([, value]) => !value.trim());
    if (missing) {
      elements.error.textContent = `请填写${missing[0]}`;
      elements.error.hidden = false;
      return;
    }
    const { snippet } = state.editingId
      ? await request(`/api/knowledge/${state.editingId}`, {
        method: 'PATCH', body: JSON.stringify({ ...input, editToken: editLock.token }),
      })
      : await request('/api/knowledge', { method: 'POST', body: JSON.stringify(input) });
    stopEditHeartbeat();
    elements.dialog.close();
    showStatus(`已保存「${snippet.title}」`);
    state.selectedId = snippet.id;
    state.focusId = snippet.id;
    await load();
  } catch (error) {
    if (state.editingId && LOST_EDIT_LOCK_STATUS.has(error.status)) loseEditLock('当前编辑锁已失效，请重新打开片段后编辑');
    else {
      elements.error.textContent = `未保存：${error.message}`;
      elements.error.hidden = false;
    }
  } finally {
    savingEditor = false;
    elements.save.disabled = Boolean(elements.dialog.open && state.editingId && !editLock);
    listRefresh.flush();
  }
}

async function setTrashed(trashed) {
  const snippet = selected();
  if (!snippet) return;
  try {
    await request(`/api/knowledge/${snippet.id}/trash`, { method: 'PATCH', body: JSON.stringify({ trashed }) });
    showStatus(trashed ? `已将「${snippet.title}」移到回收站` : `已恢复「${snippet.title}」`);
    state.selectedId = null;
    await load();
  } catch (error) {
    showStatus(error.message, true);
  }
}

function openPurge(ids, title) {
  const clearing = !ids;
  const count = clearing ? state.viewTotal : ids.length;
  if (!canPurge() || !count) return;
  pendingPurge = { revision: state.trashRevision, ...(clearing ? { all: true } : { ids }) };
  const library = sharedLibrary ? '共享知识库' : '本机知识库';
  const target = title ? `「${title}」` : `${count} 个所选片段`;
  elements.purgeTitle.textContent = clearing ? '清空回收站' : '永久删除片段';
  elements.purgeDescription.textContent = clearing
    ? `将永久删除${library}回收站里的全部 ${count} 个片段，包括当前筛选之外的片段。删除后无法恢复。`
    : `从${library}永久删除${target}？删除后无法恢复。`;
  elements.purgeConfirm.textContent = clearing ? '确认清空' : '永久删除';
  elements.purgeError.hidden = true;
  elements.purgeDialog.showModal();
}

async function confirmPurge(event) {
  event.preventDefault();
  if (!pendingPurge || state.purging) return;
  const input = pendingPurge;
  state.purging = true;
  elements.purgeError.hidden = true;
  for (const control of elements.purgeForm.elements) control.disabled = true;
  try {
    const { purged } = await request('/api/knowledge/trash/purge', { method: 'POST', body: JSON.stringify(input) });
    elements.purgeDialog.close();
    state.selectedId = null;
    state.trashSelection.clear();
    if (input.all) state.trashMulti = false;
    await load();
    showStatus(`已永久删除 ${purged} 个片段`);
  } catch (error) {
    if (error.status === 409) {
      elements.purgeDialog.close();
      await load();
      showStatus(error.message, true);
    } else {
      elements.purgeError.textContent = `未能永久删除：${error.message}`;
      elements.purgeError.hidden = false;
    }
  } finally {
    state.purging = false;
    for (const control of elements.purgeForm.elements) control.disabled = false;
    renderTrashActions();
    listRefresh.flush();
  }
}

let searchTimer;
elements.search.addEventListener('input', () => {
  elements.clearSearch.hidden = !elements.search.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = elements.search.value.trim();
    load();
  }, 150);
});
elements.clearSearch.addEventListener('click', () => {
  elements.search.value = '';
  elements.clearSearch.hidden = true;
  state.q = '';
  load();
  elements.search.focus();
});
for (const button of elements.viewButtons) {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    for (const item of elements.viewButtons) item.setAttribute('aria-pressed', String(item === button));
    state.selectedId = null;
    state.trashMulti = false;
    state.trashSelection.clear();
    load();
  });
}
// 方向键在卡片之间移动焦点；Enter 与空格只选中卡片，不写入文档。
elements.list.addEventListener('keydown', event => {
  const card = event.target.closest('.snippet-card');
  if (!card || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const cards = [...elements.list.querySelectorAll('.snippet-card')];
  const index = cards.indexOf(card);
  const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: cards.length - 1 }[event.key];
  const target = cards[Math.max(0, Math.min(cards.length - 1, next))];
  event.preventDefault();
  state.focusId = target.dataset.id;
  for (const item of cards) item.tabIndex = item === target ? 0 : -1;
  for (const add of elements.list.querySelectorAll('.card-add')) add.tabIndex = add.dataset.id === state.focusId ? 0 : -1;
  target.focus();
});
elements.stateAction.addEventListener('click', () => (state.failed ? load() : openEditor(null)));
elements.newSnippet.addEventListener('click', () => openEditor(null));
elements.edit.addEventListener('click', openLockedEditor);
elements.trash.addEventListener('click', () => setTrashed(true));
elements.restore.addEventListener('click', () => setTrashed(false));
elements.toggleTrashMulti.addEventListener('click', () => toggleTrashMulti(!state.trashMulti));
elements.selectTrashCurrent.addEventListener('click', () => {
  state.trashSelection = new Set(state.snippets.map(snippet => snippet.id));
  syncSelection();
});
elements.purge.addEventListener('click', () => {
  const snippet = selected();
  if (snippet) openPurge([snippet.id], snippet.title);
});
elements.purgeSelection.addEventListener('click', () => openPurge([...state.trashSelection]));
elements.clearTrash.addEventListener('click', () => openPurge());
for (const button of [$('closeKnowledgePurge'), $('cancelKnowledgePurge')]) {
  button.addEventListener('click', () => elements.purgeDialog.close());
}
elements.purgeDialog.addEventListener('cancel', event => {
  if (state.purging) event.preventDefault();
});
elements.purgeDialog.addEventListener('close', () => { pendingPurge = null; });
elements.purgeForm.addEventListener('submit', confirmPurge);
elements.type.addEventListener('change', () => fillSectionOptions(elements.type.value));
elements.form.addEventListener('submit', saveEditor);
for (const button of [$('closeSnippet'), elements.cancel]) {
  button.addEventListener('click', () => {
    if (!savingEditor) elements.dialog.close();
  });
}
elements.dialog.addEventListener('cancel', event => {
  if (savingEditor) event.preventDefault();
});
elements.dialog.addEventListener('close', () => releaseEditLock(stopEditHeartbeat()));
elements.capture.addEventListener('click', () => {
  try {
    const draft = readSelectionAsSnippet();
    showStatus(`已读取 ${draft.paragraphs} 段${draft.headings ? `，其中小标题 ${draft.headings} 段` : ''}，确认后保存`);
    openEditor(null, draft);
  } catch (error) {
    showStatus(error.message, true);
  }
});
elements.baseLevel.addEventListener('change', saveOptions);

const options = readOptions();
elements.baseLevel.value = String(options.baseLevel);
pickers.get(elements.baseLevel).refresh();
// 连接局域网图库时知识库与他人共享，顶栏标出；在素材库切换来源后，回到本窗格时重新读取。
let source = null;
async function refreshSource({ background = false } = {}) {
  let connection;
  try { connection = await request('/api/connection'); } catch {
    return false; // 服务未运行时由列表读取给出说明。
  }
  if (background && (listRefreshPaused() || state.loading)) {
    listRefresh.request();
    return null;
  }
  const key = `${connection.mode} ${connection.url}`;
  const lan = connection.mode === 'lan';
  sharedLibrary = lan || connection.lanServer;
  elements.sourceBadge.hidden = !lan;
  elements.sourceBadge.title = lan ? `局域网图库 ${connection.url ?? '（连接配置有误）'}` : '';
  const changed = source !== null && source !== key;
  if (changed) {
    if (editLock) loseEditLock('图库来源已切换，请从当前图库重新打开片段');
    state.selectedId = null;
    state.trashMulti = false;
    state.trashSelection.clear();
  }
  source = key;
  return changed;
}

async function refreshOnReturn() {
  const changed = await refreshSource({ background: true });
  if (changed !== null) await load({ background: !changed });
}

window.addEventListener('focus', () => {
  refreshHost();
  renewEditLock();
});
window.addEventListener('pagehide', event => {
  if (!editLock || savingEditor) return;
  const lock = stopEditHeartbeat();
  releaseEditLock(lock, true);
  if (event.persisted) loseEditLock('当前编辑锁已释放，请重新打开片段后编辑');
});
document.documentElement.addEventListener('pointerenter', refreshHost);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshHost();
});
refreshHost();
refreshSource().then(() => load());
