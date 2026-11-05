const COLLAPSE_END = 0;
const WITHIN_TABLE = 12;
const NO_PROTECTION = -1;
const LOCK_ASPECT_RATIO = -1;

function editableDocument(app) {
  if (!app) throw new Error('请在 WPS 文字中打开 iPeiTu 素材库');
  if (app.Documents.Count === 0) throw new Error('请先打开需要配图的 WPS 文字文档');
  const doc = app.ActiveDocument;
  if (!doc) throw new Error('请先切换到需要配图的 WPS 文字文档');
  if (doc.ReadOnly) throw new Error('当前文档为只读，请打开可编辑的副本后插入');
  if (doc.ProtectionType !== NO_PROTECTION) {
    throw new Error('当前文档受保护，请在允许编辑的文档中插入');
  }
  return doc;
}

export function getHostStatus() {
  try {
    const doc = editableDocument(globalThis.Application);
    return { available: true, message: `插入到：${doc.Name}` };
  } catch (error) {
    return { available: false, message: `无法插图：${error.message || '无法读取 WPS 文档状态，请重新打开素材库'}` };
  }
}

export function captureInsertionTarget() {
  try {
    const app = globalThis.Application;
    const doc = editableDocument(app);
    const range = app.Selection.Range;
    return { document: doc.FullName, start: range.Start, end: range.End };
  } catch (cause) {
    throw new Error(`无法记录插图位置：${cause.message || '请在文档中放置光标后重试'}`);
  }
}

function availableWidth(range) {
  const page = range.PageSetup;
  let width = page.PageWidth - page.LeftMargin - page.RightMargin;
  if (range.Information(WITHIN_TABLE)) {
    const cell = range.Cells.Item(1);
    width = Math.min(width, cell.Width - cell.LeftPadding - cell.RightPadding);
  }
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error('当前光标位置没有可用的排版宽度，请移动光标后重试');
  }
  return width;
}

export function insertPicture(asset, expectedTarget) {
  const app = globalThis.Application;
  if (!asset || typeof asset.path !== 'string' || !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(asset.path)) {
    throw new Error('图片路径无效，请从本地素材库重新选择图片');
  }

  let picture;
  let inserting = false;
  try {
    const doc = editableDocument(app);
    const range = app.Selection.Range.Duplicate;
    if (expectedTarget && (doc.FullName !== expectedTarget.document || range.Start !== expectedTarget.start || range.End !== expectedTarget.end)) {
      throw new Error('当前文档或光标位置已改变，请确认目标后重新点击');
    }
    range.Collapse(COLLAPSE_END);
    const maxWidth = availableWidth(range);
    inserting = true;
    picture = range.InlineShapes.AddPicture(asset.path, false, true, range);
    picture.LockAspectRatio = LOCK_ASPECT_RATIO;
    if (picture.Width > maxWidth) picture.Width = maxWidth;
    const after = picture.Range.Duplicate;
    after.Collapse(COLLAPSE_END);
    after.Select();
    return { name: asset.name, width: picture.Width, height: picture.Height };
  } catch (cause) {
    const detail = cause.message ? `（${cause.message}）` : '';
    let message;
    if (picture) {
      message = `图片已插入，但尺寸调整或光标定位未完成${detail}。请在文档中检查这张图片，不要重复插入`;
    } else if (inserting) {
      message = `WPS 未能确认插图结果${detail}。请检查图片文件和文档；确认没有新增图片后再重试`;
    } else {
      message = `插入已中止${detail}`;
    }
    const error = new Error(message);
    error.inserted = Boolean(picture);
    error.cause = cause;
    throw error;
  }
}
