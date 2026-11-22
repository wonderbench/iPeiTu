// 文件引用只保留在本次选择、导入过程和前 100 项失败记录中。
const SESSION_KEY = 'ipeitu.activeImportJob';
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|bmp|gif|tiff?|svg|heic|heif|avif|ico|jfif)$/i;
const MAX_FILES = 10000;
const MAX_RETRY_FILES = 100;

function folderCategory(relativePath) {
  const parts = relativePath.split('/');
  return parts.length === 2 ? parts[0] : parts.slice(1, -1).join('/');
}

async function scanPickedFolder(folder, signal) {
  const pending = [{ directory: folder, path: folder.name }];
  const entries = [];
  let scanned = 0;
  while (pending.length && !signal.aborted) {
    const { directory, path } = pending.pop();
    for await (const handle of directory.values()) {
      if (signal.aborted) return [];
      if (++scanned > 100000) throw new Error('文件夹内容过多，请分批选择子文件夹');
      const relativePath = `${path}/${handle.name}`;
      if (handle.kind === 'directory') pending.push({ directory: handle, path: relativePath });
      else if (handle.kind === 'file' && IMAGE_EXTENSION.test(handle.name)) {
        if (entries.length === MAX_FILES) throw new Error(`一次最多导入 ${MAX_FILES} 张图片，请分批选择`);
        entries.push({ handle, relativePath, category: folderCategory(relativePath) });
      }
    }
  }
  return entries;
}

export function createImportController({ ui, request, readableError, management, refreshLibrary, clearAction, reveal }) {
  let busy = false;
  let jobId = null;
  let paused = false;
  let stopped = false;
  let failures = [];
  let retryFiles = new Map();
  let folderEntries = null;
  let folderScan = null;

  function remember(id) {
    try {
      if (id) sessionStorage.setItem(SESSION_KEY, id);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Storage can be disabled in embedded browsers; this session still works.
    }
  }

  function setBusy(value) {
    busy = value;
    for (const control of [ui.chooseFiles, ui.chooseFolder, ui.fileInput, ui.folderInput, ui.directoryInput, ui.importDirectory]) {
      control.disabled = value || paused;
    }
    ui.importPanel.setAttribute('aria-busy', String(value));
    ui.retryImport.disabled = value;
    ui.resumeImport.disabled = value;
  }

  function meter(processed, total) {
    ui.importMeter.hidden = false;
    if (total === null || total === undefined) ui.importMeter.removeAttribute('value');
    else {
      ui.importMeter.max = Math.max(1, total);
      ui.importMeter.value = processed;
    }
  }

  function showFailures(items, fromJob = false) {
    failures = items;
    ui.failureList.replaceChildren();
    ui.failureSummary.textContent = `查看 ${items.length} 项失败原因`;
    for (const failure of items) {
      const item = document.createElement('li');
      const reselect = !fromJob && !retryFiles.has(failure.id);
      item.textContent = `${failure.relativePath || failure.name}：${failure.error}${reselect ? '；请重新选择文件' : ''}`;
      ui.failureList.append(item);
    }
    ui.importFailures.hidden = !items.length;
    ui.retryImport.hidden = !items.some(item => fromJob ? item.retryable : retryFiles.has(item.id));
  }

  function report(result, fromJob = false) {
    ui.importProgress.textContent = `导入 ${result.imported} 张，重复 ${result.duplicates} 张，失败 ${result.failed.length} 项`
      + (result.restored > 0 ? `，恢复 ${result.restored} 张` : '');
    showFailures(result.failed, fromJob);
    meter(result.processed ?? result.total ?? 0, result.total ?? 0);
  }

  function begin() {
    retryFiles.clear();
    failures = [];
    jobId = null;
    remember(null);
    paused = false;
    ui.resumeImport.hidden = true;
    ui.retryImport.hidden = true;
    ui.importFailures.hidden = true;
    ui.importProgress.hidden = false;
    clearAction();
    setBusy(true);
  }

  async function refreshed() {
    // Import outcome and library reads have separate status surfaces.
    await refreshLibrary();
  }

  async function upload(entries, unselected = []) {
    const result = { imported: 0, duplicates: 0, restored: 0, failed: [...unselected], total: entries.length, processed: 0 };
    retryFiles.clear();
    for (const [index, entry] of entries.entries()) {
      if (stopped) break;
      ui.importProgress.textContent = `正在导入 ${index + 1} / ${entries.length}：${entry.relativePath}`;
      meter(index, entries.length);
      const name = (entry.file ?? entry.handle).name;
      const failed = error => {
        const id = `file-${index}`;
        const failure = { id, name, relativePath: entry.relativePath, error };
        result.failed.push(failure);
        if (!stopped && retryFiles.size < MAX_RETRY_FILES) retryFiles.set(id, entry);
      };
      try {
        const file = entry.file ?? await entry.handle.getFile();
        if (stopped) break;
        const parameters = new URLSearchParams({ name });
        if (entry.category) parameters.set('category', entry.category);
        const current = await request(`/api/import-file?${parameters}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        });
        result.imported += current.imported;
        result.duplicates += current.duplicates;
        result.restored += current.restored || 0;
        for (const failure of current.failed) failed(failure.error);
      } catch (error) {
        failed(readableError(error));
      }
      result.processed++;
    }
    if (!stopped) {
      report(result);
      await refreshed();
    }
  }

  async function selectedFiles(input, folder) {
    if (busy || paused) return;
    const entries = Array.from(input.files).filter(file => !folder || IMAGE_EXTENSION.test(file.name)).map(file => {
      const relativePath = file.webkitRelativePath || file.name;
      return { file, relativePath, category: folder ? folderCategory(relativePath) : '' };
    });
    input.value = '';
    await importEntries(entries);
  }

  async function importEntries(entries) {
    if (!entries.length) {
      begin();
      ui.importProgress.textContent = '没有找到可导入的图片';
      ui.importMeter.hidden = true;
      setBusy(false);
      return;
    }
    begin();
    if (entries.length > MAX_FILES) {
      ui.importProgress.textContent = `一次最多导入 ${MAX_FILES} 张图片，请分批选择`;
      ui.importMeter.hidden = true;
      setBusy(false);
      return;
    }
    try { await upload(entries); }
    finally { setBusy(false); }
  }

  function showJob(job) {
    if (job.status === 'scanning' || job.status === 'queued') {
      ui.importProgress.textContent = job.status === 'queued' ? '等待导入' : `正在扫描：已发现 ${job.discovered} 项`;
      meter(0, null);
    } else {
      ui.importProgress.textContent = `正在导入 ${job.processed} / ${job.total ?? '?'}${job.currentName ? `：${job.currentName}` : ''}`;
      meter(job.processed, job.total);
    }
  }

  async function poll() {
    paused = false;
    ui.resumeImport.hidden = true;
    setBusy(true);
    try {
      while (!stopped) {
        const { job } = await request(`/api/import-jobs/${encodeURIComponent(jobId)}`);
        if (job.status === 'completed' || job.status === 'failed') {
          report(job, true);
          if (job.status === 'failed' && job.error) ui.importProgress.textContent += `；任务失败：${job.error}`;
          remember(null);
          await refreshed();
          return;
        }
        showJob(job);
        await new Promise(resolve => setTimeout(resolve, 350));
      }
    } catch (error) {
      if (error.status === 404) {
        ui.importProgress.textContent = '导入记录已过期或服务已重启，请检查图库后重新选择目录';
        remember(null);
        jobId = null;
      } else {
        paused = true;
        ui.importProgress.textContent = `导入状态暂时无法读取：${readableError(error)}`;
        ui.resumeImport.hidden = false;
      }
    } finally { setBusy(false); }
  }

  async function importDirectory(directory) {
    if (busy || paused) return;
    begin();
    ui.importProgress.textContent = '正在创建导入任务';
    meter(0, null);
    try {
      const { job } = await request('/api/import-jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory }),
      });
      jobId = job.id;
      remember(jobId);
      await poll();
    } catch (error) {
      ui.importProgress.textContent = error instanceof TypeError || error.status >= 500
        ? `未能确认导入任务是否创建：${readableError(error)}；请检查图库后再开始`
        : `无法创建导入任务：${readableError(error)}`;
      ui.importMeter.hidden = true;
      setBusy(false);
    }
  }

  const normalizePath = value => value.trim().replace(/^"(.*)"$/, '$1').trim();

  function showFolderError(message) {
    ui.folderImportError.textContent = message;
    ui.folderImportError.hidden = !message;
  }

  function updateFolderDialog() {
    ui.folderPathField.hidden = folderEntries !== null;
    ui.useFolderPath.hidden = folderEntries === null;
    ui.browseFolder.disabled = folderScan !== null;
    ui.confirmFolderImport.disabled = folderScan !== null
      || (folderEntries !== null ? !folderEntries.length : !normalizePath(ui.folderPath.value));
  }

  function showFolderDialog(directory = '') {
    folderEntries = null;
    ui.browseFolder.hidden = typeof window.showDirectoryPicker !== 'function';
    ui.folderPath.value = directory;
    ui.folderSelection.hidden = true;
    showFolderError('');
    updateFolderDialog();
    ui.folderImportDialog.showModal();
    (ui.browseFolder.hidden || directory ? ui.folderPath : ui.browseFolder).focus();
  }

  async function browseFolder() {
    const scan = new AbortController();
    folderScan = scan;
    updateFolderDialog();
    showFolderError('');
    try {
      const folder = await window.showDirectoryPicker({ mode: 'read' });
      if (scan.signal.aborted) return;
      folderEntries = [];
      ui.folderSelection.textContent = `「${folder.name}」 · 正在扫描图片…`;
      ui.folderSelection.hidden = false;
      updateFolderDialog();
      const entries = await scanPickedFolder(folder, scan.signal);
      if (scan.signal.aborted) return;
      folderEntries = entries;
      ui.folderSelection.textContent = `「${folder.name}」 · ${entries.length} 张可导入图片，包含子文件夹`;
      if (!entries.length) showFolderError('没有找到可导入的图片，请选择其他文件夹');
    } catch (error) {
      if (scan.signal.aborted || error.name === 'AbortError') return;
      folderEntries = null;
      ui.folderSelection.hidden = true;
      showFolderError(`无法读取所选文件夹：${readableError(error)}。也可粘贴本机文件夹路径。`);
    } finally {
      if (folderScan === scan) {
        folderScan = null;
        updateFolderDialog();
      }
    }
  }

  ui.chooseFiles.addEventListener('click', () => ui.fileInput.click());
  ui.chooseFolder.addEventListener('click', () => {
    if (!management) {
      ui.folderInput.click();
      return;
    }
    showFolderDialog();
  });
  ui.fileInput.addEventListener('change', () => selectedFiles(ui.fileInput, false));
  ui.folderInput.addEventListener('change', () => selectedFiles(ui.folderInput, true));
  ui.resumeImport.addEventListener('click', () => { if (!busy && jobId) poll(); });
  ui.directoryForm.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || paused) return;
    const directory = normalizePath(ui.directoryInput.value);
    if (!directory) { ui.directoryInput.focus(); return; }
    if (management) showFolderDialog(directory);
    else importDirectory(directory);
  });
  ui.browseFolder.addEventListener('click', browseFolder);
  ui.folderPath.addEventListener('input', updateFolderDialog);
  ui.useFolderPath.addEventListener('click', () => {
    folderScan?.abort();
    folderScan = null;
    folderEntries = null;
    ui.folderSelection.hidden = true;
    showFolderError('');
    updateFolderDialog();
    ui.folderPath.focus();
  });
  ui.cancelFolderImport.addEventListener('click', () => ui.folderImportDialog.close());
  ui.folderImportDialog.addEventListener('close', () => {
    if (ui.folderImportDialog.open) return;
    folderScan?.abort();
    folderScan = null;
    folderEntries = null;
  });
  ui.folderImportForm.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || paused || ui.confirmFolderImport.disabled) return;
    const entries = folderEntries;
    const directory = normalizePath(ui.folderPath.value);
    ui.folderImportDialog.close();
    if (entries) importEntries(entries);
    else importDirectory(directory);
  });
  ui.retryImport.addEventListener('click', async () => {
    if (busy || paused) return;
    ui.retryImport.hidden = true;
    ui.importFailures.hidden = true;
    setBusy(true);
    try {
      if (jobId) {
        const { job } = await request(`/api/import-jobs/${encodeURIComponent(jobId)}/retry`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ failureIds: failures.filter(item => item.retryable).map(item => item.id) }),
        });
        jobId = job.id;
        remember(jobId);
        await poll();
      } else {
        const unselected = failures.filter(item => !retryFiles.has(item.id));
        // IDs from retained failures must not collide with the unselected rows.
        await upload([...retryFiles.values()], unselected.map((item, index) => ({ ...item, id: `unselected-${index}` })));
      }
    } catch (error) {
      if (error.status === 404 && jobId) {
        ui.importProgress.textContent = '导入记录已过期或服务已重启，请检查图库后重新选择目录';
        remember(null);
        jobId = null;
        showFailures(failures, true);
        ui.retryImport.hidden = true;
      } else {
        ui.importProgress.textContent = `重试失败：${readableError(error)}`;
        showFailures(failures, Boolean(jobId));
      }
    } finally { setBusy(false); }
  });
  window.addEventListener('pagehide', () => { stopped = true; retryFiles.clear(); });

  try { jobId = sessionStorage.getItem(SESSION_KEY); } catch { /* Storage is optional. */ }
  if (jobId) {
    reveal();
    ui.importProgress.hidden = false;
    poll();
  }

  // 拖入或粘贴的文件：与“选择图片”相同的上传、进度和失败重试；粘贴的截图按时间命名。
  async function importFiles(files, { pasted = false } = {}) {
    if (busy || paused) return;
    reveal();
    const pad = value => String(value).padStart(2, '0');
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const images = files.filter(file => IMAGE_EXTENSION.test(file.name) || file.type.startsWith('image/'));
    const entries = images.map((file, index) => {
      const extension = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '');
      const named = pasted
        ? new File([file], `粘贴图片-${stamp}${images.length > 1 ? `-${index + 1}` : ''}.${extension}`, { type: file.type })
        : file;
      return { file: named, relativePath: named.name, category: '' };
    });
    begin();
    if (!entries.length) {
      ui.importProgress.textContent = '拖入的文件中没有图片';
      ui.importMeter.hidden = true;
      setBusy(false);
      return;
    }
    if (entries.length > MAX_FILES) {
      ui.importProgress.textContent = `一次最多导入 ${MAX_FILES} 张图片，请分批导入`;
      ui.importMeter.hidden = true;
      setBusy(false);
      return;
    }
    try { await upload(entries); }
    finally { setBusy(false); }
  }

  return { importFiles };
}
