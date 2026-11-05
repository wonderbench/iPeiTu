// Ribbon 回调必须位于加载项入口的全局作用域。
function OnAddinLoad() {
  return true;
}

function OpenImageLibrary() {
  var app = window.Application;
  var paneId = app.PluginStorage.getItem('ipeitu_taskpane_id');
  var pane = paneId ? app.GetTaskPane(paneId) : null;
  if (!pane) {
    pane = app.CreateTaskPane(new URL('/taskpane.html', window.location.href).href);
    app.PluginStorage.setItem('ipeitu_taskpane_id', pane.ID);
    pane.DockPosition = 2; // msoCTPDockPositionRight
    pane.Width = 420;
  }
  pane.Visible = true;
  return true;
}
