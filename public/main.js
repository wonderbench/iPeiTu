// Ribbon 回调必须位于加载项入口的全局作用域。
function OnAddinLoad() {
  return true;
}

// 每个页面一个任务窗格，记住窗格 ID，重复点击时复用。
function openPane(storageKey, page, minimumWidth) {
  var app = window.Application;
  var paneId = app.PluginStorage.getItem(storageKey);
  var pane = paneId ? app.GetTaskPane(paneId) : null;
  if (!pane) {
    pane = app.CreateTaskPane(new URL(page, window.location.href).href);
    app.PluginStorage.setItem(storageKey, pane.ID);
    pane.DockPosition = 2; // msoCTPDockPositionRight
    if (!minimumWidth) pane.Width = 420;
  }
  pane.Visible = true;
  // WPS 显示窗格时会重新布局，显示后再补足宽度，并保留手动拉宽的尺寸。
  if (minimumWidth && pane.Width < minimumWidth) pane.Width = minimumWidth;
  return true;
}

function OpenImageLibrary() {
  return openPane('ipeitu_taskpane_id', '/taskpane.html', 560);
}

function OpenLayoutTools() {
  return openPane('ipeitu_layout_pane_id', '/format.html');
}

function OpenKnowledgeBase() {
  return openPane('ipeitu_knowledge_pane_id', '/knowledge.html');
}

function OpenSelfCheck() {
  return openPane('ipeitu_self_check_pane_id', '/self-check.html');
}
