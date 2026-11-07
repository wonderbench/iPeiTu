import { getLayoutScope, runLayoutOperation } from './layout-tools.js';

const scopeStatus = document.getElementById('scopeStatus');
const result = document.getElementById('formatResult');
const buttons = Array.from(document.querySelectorAll('[data-operation]'));

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
}

for (const button of buttons) {
  button.addEventListener('click', () => {
    refresh();
    if (button.disabled) return;
    try {
      showResult(runLayoutOperation(button.dataset.operation).message);
    } catch (error) {
      showResult(error.message, true);
    }
    refresh();
  });
}

window.addEventListener('focus', refresh);
document.documentElement.addEventListener('pointerenter', refresh);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
refresh();
