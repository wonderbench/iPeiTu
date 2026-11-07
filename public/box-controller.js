import {
  capturePlaceholderTarget, insertPlaceholder, scanPlaceholders, selectPlaceholder,
  clearPlaceholderMarkers, findTextMarkers, captureTextMarkerTargets, convertTextMarkers,
} from './wps-bridge.js';
import { BOX_PRESETS } from './placeholder-options.js';

const centimeters = points => (points * 2.54 / 72).toFixed(1);

// beginWrite 返回 true 表示已占用文档写入；返回字符串表示不能写入的原因，空字符串表示正忙。
export function createBoxController({ ui, request, readableError, showAction, beginWrite, endWrite }) {
  let scan = null;
  let unfilledOnly = false;
  let markers = null;
  let state = { available: false, busy: false, inWps: false };

  function showError(message) {
    ui.boxError.textContent = message;
    ui.boxError.hidden = !message;
  }

  function readForm() {
    const name = ui.boxName.value;
    const choice = ui.boxSize.value;
    if (choice === 'custom') {
      return { name, size: 'fixed', widthCm: ui.boxWidthCm.valueAsNumber, heightCm: ui.boxHeightCm.valueAsNumber };
    }
    if (BOX_PRESETS[choice]) {
      const [widthCm, heightCm] = BOX_PRESETS[choice];
      return { name, size: 'fixed', widthCm, heightCm };
    }
    return { name, size: choice };
  }

  function render() {
    ui.boxList.replaceChildren();
    ui.unfilledOnly.setAttribute('aria-pressed', String(unfilledOnly));
    if (!scan) return;
    const empty = scan.boxes.filter(box => !box.filled).length;
    const summary = [scan.boxes.length ? `文档中 ${scan.boxes.length} 个占位框 · 未填 ${empty}` : '文档中还没有占位框'];
    if (scan.unreadable) summary.push(`${scan.unreadable} 个对象无法读取`);
    ui.boxCount.textContent = summary.join(' · ');
    for (const [position, box] of scan.boxes.entries()) {
      if (unfilledOnly && box.filled) continue;
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'box-item';
      button.title = box.name;
      const index = document.createElement('span');
      index.className = 'box-index figures';
      index.textContent = String(position + 1);
      const name = document.createElement('span');
      name.className = 'box-name';
      name.textContent = box.name;
      const size = document.createElement('span');
      size.className = 'box-size figures';
      size.textContent = `${centimeters(box.widthPt)} × ${centimeters(box.heightPt)}`;
      button.append(index, name);
      if (box.filled) {
        const filled = document.createElement('span');
        filled.className = 'box-filled';
        filled.textContent = '已填';
        button.append(filled);
      }
      button.append(size);
      button.addEventListener('click', () => locate(box));
      item.append(button);
      ui.boxList.append(item);
    }
  }

  function rescan() {
    try {
      scan = scanPlaceholders();
    } catch (error) {
      scan = null;
      render();
      ui.boxCount.textContent = `无法扫描：${error.message}`;
      return;
    }
    render();
  }

  function locate(box) {
    try {
      selectPlaceholder(scan, box);
      showAction(`已定位到「${box.name}」`);
    } catch (error) {
      if (!error.stale) {
        showAction(`无法定位：${readableError(error)}`, true);
        return;
      }
      rescan();
      showAction(error.message, true);
    }
  }

  function showMarkers(found, message = '') {
    markers = found;
    ui.markerList.replaceChildren();
    ui.markerResult.hidden = !found && !message;
    if (!found) {
      ui.markerSummary.textContent = message;
      refreshControls();
      return;
    }
    const parts = [found.markers.length ? `找到 ${found.markers.length} 个文字标记` : '没有找到“【图：名称】”格式的文字标记'];
    if (found.skipped) parts.push(`${found.skipped} 个所在段落无法定位，未列出`);
    ui.markerSummary.textContent = parts.join('；');
    for (const marker of found.markers) {
      const item = document.createElement('li');
      item.textContent = marker.name;
      ui.markerList.append(item);
    }
    refreshControls();
  }

  function refreshControls() {
    const { available, busy, inWps } = state;
    ui.insertBox.disabled = !available || busy;
    ui.insertBox.title = available ? '' : ui.hostStatus.textContent;
    ui.scanBoxes.disabled = !inWps;
    ui.findMarkers.disabled = !inWps || busy;
    ui.clearMarkers.disabled = !available || busy;
    ui.convertMarkers.hidden = !markers?.markers.length;
    ui.convertMarkers.disabled = !available || busy;
  }

  async function writeWith(action) {
    showError('');
    const blocked = beginWrite();
    if (blocked !== true) {
      if (blocked) showError(blocked);
      return;
    }
    showAction('');
    try {
      await action();
    } finally {
      endWrite();
      rescan();
    }
  }

  ui.boxSize.addEventListener('change', () => {
    ui.boxCustomSize.hidden = ui.boxSize.value !== 'custom';
  });
  ui.scanBoxes.addEventListener('click', rescan);
  ui.unfilledOnly.addEventListener('click', () => {
    unfilledOnly = !unfilledOnly;
    render();
  });

  ui.boxForm.addEventListener('submit', (event) => {
    event.preventDefault();
    writeWith(async () => {
      let target;
      try {
        target = capturePlaceholderTarget(readForm());
      } catch (error) {
        showError(error.message);
        return;
      }
      ui.insertBox.textContent = '正在插入';
      try {
        const image = await request('/api/placeholders', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: target.name, widthPt: target.widthPt, heightPt: target.heightPt }),
        });
        const result = insertPlaceholder(image, target);
        showAction(`已插入占位框「${result.name}」${centimeters(result.widthPt)} × ${centimeters(result.heightPt)} 厘米`);
        ui.boxName.select();
      } catch (error) {
        showAction(error.inserted ? error.message : `插入占位框失败：${readableError(error)}`, true);
      } finally {
        ui.insertBox.textContent = '插入光标处';
      }
    });
  });

  ui.findMarkers.addEventListener('click', () => {
    try {
      showMarkers(findTextMarkers());
    } catch (error) {
      showMarkers(null, `无法查找：${error.message}`);
    }
  });

  ui.convertMarkers.addEventListener('click', () => {
    if (!markers?.markers.length) return;
    const found = markers;
    writeWith(async () => {
      let captured;
      try {
        // 框名取自各个标记，尺寸沿用上方表单的选择。
        captured = captureTextMarkerTargets(found, { ...readForm(), name: '标记' });
      } catch (error) {
        ui.markerSummary.textContent = error.message;
        return;
      }
      ui.convertMarkers.textContent = '正在转换';
      try {
        const images = [];
        for (const target of captured.targets) {
          images.push(await request('/api/placeholders', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: target.name, widthPt: target.widthPt, heightPt: target.heightPt }),
          }));
        }
        const { converted } = convertTextMarkers(captured, images);
        showMarkers(null);
        showAction(`已把 ${converted} 个文字标记转为占位框`);
      } catch (error) {
        const message = error.converted ? error.message : `转换失败：${readableError(error)}`;
        showMarkers(null, message);
        showAction(message, true);
      } finally {
        ui.convertMarkers.textContent = '按上方尺寸转为占位框';
      }
    });
  });

  ui.clearMarkers.addEventListener('click', () => {
    rescan();
    if (!scan) return;
    const filled = scan.boxes.filter(box => box.filled).length;
    const empty = scan.boxes.length - filled;
    if (!filled) {
      showAction(empty ? `没有已填的占位框，${empty} 个框尚未填入` : '文档中没有占位框标记');
      return;
    }
    ui.clearMarkersText.textContent = `清除 ${filled} 个已填框的标记后，这些图片不再作为占位框，无法再按框换图。`
      + (empty ? `未填的 ${empty} 个框保留，请填入或删除后再交付。` : '');
    ui.clearMarkersDialog.returnValue = '';
    ui.clearMarkersDialog.showModal();
  });

  ui.clearMarkersDialog.addEventListener('close', () => {
    if (ui.clearMarkersDialog.returnValue !== 'confirm') return;
    writeWith(async () => {
      try {
        const { cleared, unfilled } = clearPlaceholderMarkers();
        showAction(`已清除 ${cleared} 个标记${unfilled ? `；还有 ${unfilled} 个未填的框` : ''}`, Boolean(unfilled));
      } catch (error) {
        showAction(error.message, true);
      }
    });
  });

  return {
    open() {
      ui.boxPanel.hidden = false;
      ui.toggleBoxes.setAttribute('aria-expanded', 'true');
      if (typeof globalThis.Application !== 'undefined') rescan();
      ui.boxName.focus();
    },
    // 填入后若面板开着，刷新列表中的已填状态。
    refreshList() {
      if (!ui.boxPanel.hidden && typeof globalThis.Application !== 'undefined') rescan();
    },
    close() {
      ui.boxPanel.hidden = true;
      ui.toggleBoxes.setAttribute('aria-expanded', 'false');
    },
    refresh(next) {
      state = next;
      refreshControls();
    },
  };
}
