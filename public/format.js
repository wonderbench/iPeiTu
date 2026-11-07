import { getLayoutScope, runLayoutOperation, readTableWidth } from './layout-tools.js';

const scopeStatus = document.getElementById('scopeStatus');
const result = document.getElementById('formatResult');
const singleWidth = document.getElementById('singleWidth');
const multiWidth = document.getElementById('multiWidth');
const readButton = document.getElementById('readTableWidth');
const applyButton = document.getElementById('applyTableWidths');
const buttons = Array.from(document.querySelectorAll('[data-operation]'));
const WIDTH_STORAGE_KEY = 'ipeitu.tableWidths.v1';

function showResult(message, error = false) {
  result.textContent = message;
  result.classList.toggle('error', error);
  result.hidden = !message;
}

function refresh() {
  const inWps = typeof globalThis.Application !== 'undefined';
  const scope = getLayoutScope();
  scopeStatus.textContent = inWps ? scope.message : '浏览器模式 · 排版需从 WPS 打开';
  scopeStatus.classList.toggle('ready', scope.available);
  for (const button of buttons) {
    // 清除格式会重置样式，必须先选中内容。
    const needsSelection = button.dataset.operation === 'clearFormatting' && scope.whole;
    button.disabled = !scope.available || needsSelection;
  }
  applyButton.disabled = !scope.available;
  readButton.disabled = !inWps;
}

function run(action) {
  refresh();
  try {
    showResult(action());
  } catch (error) {
    showResult(error.message, true);
  }
  refresh();
}

function widths() {
  return { singleCm: singleWidth.valueAsNumber, multiCm: multiWidth.valueAsNumber };
}

function saveWidths() {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, JSON.stringify(widths()));
  } catch {
    showResult('目标宽度已用于本次操作，但未能保存在本机', true);
  }
}

for (const button of buttons) {
  button.addEventListener('click', () => {
    if (!button.disabled) run(() => runLayoutOperation(button.dataset.operation).message);
  });
}

applyButton.addEventListener('click', () => run(() => {
  const message = runLayoutOperation('standardizeWidths', widths()).message;
  saveWidths();
  return message;
}));

readButton.addEventListener('click', () => run(() => {
  const table = readTableWidth();
  (table.multiColumn ? multiWidth : singleWidth).value = String(table.widthCm);
  return `当前表格宽 ${table.widthCm} 厘米，已填入${table.multiColumn ? '多栏' : '一栏'}页面宽度`;
}));

try {
  const saved = JSON.parse(localStorage.getItem(WIDTH_STORAGE_KEY) ?? 'null');
  if (saved && Number.isFinite(saved.singleCm) && Number.isFinite(saved.multiCm)) {
    singleWidth.value = String(saved.singleCm);
    multiWidth.value = String(saved.multiCm);
  }
} catch {
  // 读不到本机设置时沿用默认的 15 与 7 厘米。
}

window.addEventListener('focus', refresh);
document.documentElement.addEventListener('pointerenter', refresh);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
refresh();
