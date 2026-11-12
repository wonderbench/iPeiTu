export const VIEW_ACTIVATED = 'ipeitu:view-activated';

// 切回窗格时合并同一轮焦点事件，暂缓编辑期间的刷新。
export function createViewRefresh({ canRefresh, refresh, pointer = false }) {
  let requested = false;
  let running = false;
  let timer = null;
  let lastRefresh = 0;
  const ready = () => !document.hidden && !window.frameElement?.hidden && canRefresh();

  function flush() {
    if (!requested || running || timer !== null || !ready()) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!requested || !ready()) return;
      requested = false;
      running = true;
      lastRefresh = Date.now();
      try {
        await refresh();
      } finally {
        running = false;
        flush();
      }
    }, 120);
  }

  function request() {
    requested = true;
    flush();
  }

  function consume() {
    requested = false;
    clearTimeout(timer);
    timer = null;
  }

  window.addEventListener('focus', request);
  window.addEventListener(VIEW_ACTIVATED, request);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) request();
  });
  document.addEventListener('close', flush, true);
  if (pointer) {
    document.documentElement.addEventListener('pointerenter', () => {
      if (typeof globalThis.Application !== 'undefined' && Date.now() - lastRefresh >= 1000) request();
    });
  }
  return { request, flush, consume };
}
