import {
  getKnowledgeHostStatus, insertSnippet, normalizeKnowledgeOptions, parseSnippetBody, readSelectionAsSnippet,
} from './knowledge-bridge.js';

const OPTIONS_KEY = 'ipeitu.knowledge.v1';
const $ = id => document.getElementById(id);
const elements = {
  search: $('searchInput'), clearSearch: $('clearSearch'), typeChips: $('typeChips'), sectionChips: $('sectionChips'),
  viewButtons: [$('viewAll'), $('viewTrash')], count: $('resultCount'), list: $('snippetList'),
  state: $('knowledgeState'), stateTitle: $('stateTitle'), stateDescription: $('stateDescription'), stateAction: $('stateAction'),
  preview: $('snippetPreview'), previewTitle: $('previewTitle'), previewMeta: $('previewMeta'), previewBody: $('previewBody'),
  edit: $('editSnippet'), trash: $('trashSnippet'), restore: $('restoreSnippet'),
  baseLevel: $('baseLevel'), includeTitle: $('includeTitle'), capture: $('captureSelection'),
  hostStatus: $('hostStatus'), actionStatus: $('actionStatus'), newSnippet: $('newSnippet'),
  dialog: $('snippetDialog'), form: $('snippetForm'), dialogTitle: $('snippetDialogTitle'), title: $('snippetTitle'),
  type: $('snippetType'), section: $('snippetSection'), sectionOptions: $('sectionOptions'), tags: $('snippetTags'),
  body: $('snippetBody'), error: $('snippetError'), cancel: $('cancelSnippet'), save: $('saveSnippet'),
};
const state = {
  q: '', type: '', section: '', view: 'all', snippets: [], categories: [], facets: { types: {}, sections: [] },
  total: 0, viewTotal: 0, selectedId: null, focusId: null, editingId: null, inserting: false, loading: null, failed: false,
};

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
  if (!response.ok) throw new Error(data.error || `本机服务返回错误 ${response.status}`);
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
  return normalizeKnowledgeOptions({ baseLevel: Number(elements.baseLevel.value), includeTitle: elements.includeTitle.checked });
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
    card.setAttribute('aria-pressed', String(snippet.id === state.selectedId));
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
    card.addEventListener('click', () => select(snippet.id));
    item.append(card);
    if (state.view !== 'trash') {
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
    if (state.view === 'trash') title = '回收站为空';
    else if (state.q) { title = '没有找到片段'; description = '换个关键词，或清空检索'; }
    else if (filtered) { title = '此分类暂无片段'; action = '新建片段'; }
    else { title = '知识库还没有片段'; description = '新建片段，或在文档中选中段落后收录'; action = '新建片段'; }
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

function renderPreview() {
  const snippet = selected();
  elements.preview.hidden = !snippet;
  if (!snippet) return;
  elements.previewTitle.textContent = snippet.title;
  elements.previewMeta.textContent = [snippet.type, snippet.section, ...snippet.tags].join(' · ');
  elements.previewBody.replaceChildren(...parseSnippetBody(snippet.body).map(item => {
    const paragraph = document.createElement('p');
    if (item.level) paragraph.className = `snippet-heading level-${item.level}`;
    paragraph.textContent = item.text;
    return paragraph;
  }));
  const trashed = state.view === 'trash';
  elements.edit.hidden = trashed;
  elements.trash.hidden = trashed;
  elements.restore.hidden = !trashed;
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
  refreshHost();
  elements.newSnippet.disabled = !state.categories.length;
}

async function load() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.type) params.set('type', state.type);
  if (state.section) params.set('section', state.section);
  if (state.view !== 'all') params.set('view', state.view);
  const query = params.toString();
  const pending = request(`/api/knowledge${query ? `?${query}` : ''}`);
  state.loading = pending;
  try {
    const data = await pending;
    if (state.loading !== pending) return;
    Object.assign(state, {
      snippets: data.snippets, categories: data.categories, facets: data.facets, total: data.total, viewTotal: data.viewTotal, failed: false,
    });
    if (!state.snippets.some(snippet => snippet.id === state.selectedId)) state.selectedId = null;
  } catch (error) {
    if (state.loading !== pending) return;
    Object.assign(state, { snippets: [], failed: error.message, selectedId: null });
  }
  render();
}

function setFilter(type, section) {
  state.type = type;
  state.section = section;
  load();
}

function select(id) {
  state.selectedId = id;
  state.focusId = id;
  for (const card of elements.list.querySelectorAll('.snippet-card')) {
    const current = card.dataset.id === id;
    card.setAttribute('aria-pressed', String(current));
    card.tabIndex = current ? 0 : -1;
  }
  for (const add of elements.list.querySelectorAll('.card-add')) add.tabIndex = add.dataset.id === id ? 0 : -1;
  renderPreview();
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
  fillSectionOptions(type);
  elements.title.value = snippet?.title ?? draft.title ?? '';
  elements.section.value = snippet?.section ?? state.section ?? '';
  elements.tags.value = (snippet?.tags ?? []).join('，');
  elements.body.value = snippet?.body ?? draft.body ?? '';
  elements.error.hidden = true;
  elements.save.disabled = false;
  elements.dialog.showModal();
  (elements.title.value ? elements.body : elements.title).focus();
}

function formInput() {
  return {
    title: elements.title.value,
    type: elements.type.value,
    section: elements.section.value,
    tags: elements.tags.value.split(/[,，、;；\n]/).map(tag => tag.trim()).filter(Boolean),
    body: elements.body.value.replace(/\r\n?/g, '\n').replace(/\t/g, ' '),
  };
}

async function saveEditor(event) {
  event.preventDefault();
  const input = formInput();
  const missing = [['标题', input.title], ['章节', input.section], ['正文', input.body]].find(([, value]) => !value.trim());
  if (missing) {
    elements.error.textContent = `请填写${missing[0]}`;
    elements.error.hidden = false;
    return;
  }
  elements.save.disabled = true;
  try {
    const { snippet } = state.editingId
      ? await request(`/api/knowledge/${state.editingId}`, { method: 'PATCH', body: JSON.stringify(input) })
      : await request('/api/knowledge', { method: 'POST', body: JSON.stringify(input) });
    elements.dialog.close();
    showStatus(`已保存「${snippet.title}」`);
    state.selectedId = snippet.id;
    state.focusId = snippet.id;
    await load();
  } catch (error) {
    elements.error.textContent = `未保存：${error.message}`;
    elements.error.hidden = false;
  } finally {
    elements.save.disabled = false;
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
elements.edit.addEventListener('click', () => openEditor(selected()));
elements.trash.addEventListener('click', () => setTrashed(true));
elements.restore.addEventListener('click', () => setTrashed(false));
elements.type.addEventListener('change', () => fillSectionOptions(elements.type.value));
elements.form.addEventListener('submit', saveEditor);
elements.cancel.addEventListener('click', () => elements.dialog.close());
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
elements.includeTitle.addEventListener('change', saveOptions);

const options = readOptions();
elements.baseLevel.value = String(options.baseLevel);
elements.includeTitle.checked = options.includeTitle;
window.addEventListener('focus', refreshHost);
document.documentElement.addEventListener('pointerenter', refreshHost);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshHost();
});
refreshHost();
load();
