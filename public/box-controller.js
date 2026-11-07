import { capturePlaceholderTarget, insertPlaceholder, scanPlaceholders, selectPlaceholder } from './wps-bridge.js';
import { BOX_PRESETS } from './placeholder-options.js';

const centimeters = points => (points * 2.54 / 72).toFixed(1);

// beginWrite 返回 true 表示已占用文档写入；返回字符串表示不能写入的原因，空字符串表示正忙。
export function createBoxController({ ui, request, readableError, showAction, beginWrite, endWrite }) {
  let scan = null;

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
    if (!scan) return;
    const summary = [scan.boxes.length ? `文档中 ${scan.boxes.length} 个占位框` : '文档中还没有占位框'];
    if (scan.unreadable) summary.push(`${scan.unreadable} 个对象无法读取`);
    ui.boxCount.textContent = summary.join(' · ');
    for (const [position, box] of scan.boxes.entries()) {
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
      button.append(index, name, size);
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

  ui.boxSize.addEventListener('change', () => {
    ui.boxCustomSize.hidden = ui.boxSize.value !== 'custom';
  });
  ui.scanBoxes.addEventListener('click', rescan);
  ui.boxForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const blocked = beginWrite();
    if (blocked !== true) {
      if (blocked) showError(blocked);
      return;
    }
    let target;
    try {
      target = capturePlaceholderTarget(readForm());
    } catch (error) {
      showError(error.message);
      endWrite();
      return;
    }
    ui.insertBox.textContent = '正在插入';
    showAction('');
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
      endWrite();
      rescan();
    }
  });

  return {
    open() {
      ui.boxPanel.hidden = false;
      ui.toggleBoxes.setAttribute('aria-expanded', 'true');
      if (typeof globalThis.Application !== 'undefined') rescan();
      ui.boxName.focus();
    },
    close() {
      ui.boxPanel.hidden = true;
      ui.toggleBoxes.setAttribute('aria-expanded', 'false');
    },
    refresh({ available, busy, inWps }) {
      ui.insertBox.disabled = !available || busy;
      ui.insertBox.title = available ? '' : ui.hostStatus.textContent;
      ui.scanBoxes.disabled = !inWps;
    },
  };
}
