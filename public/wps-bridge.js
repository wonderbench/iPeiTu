import { normalizeLayoutOptions } from './layout-options.js';

const COLLAPSE_END = 0;
const COLLAPSE_START = 1;
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
    return { document: doc.FullName, start: range.Start, end: range.End, story: range.StoryType };
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

function separatePictureParagraphs(picture, original, options) {
  if (original.hasPrefix) {
    const before = picture.Range.Duplicate;
    before.Collapse(COLLAPSE_START);
    before.InsertAfter('\r');
  }
  const after = picture.Range.Duplicate;
  after.Collapse(COLLAPSE_END);
  after.InsertAfter(`\r${options.caption ? `${options.caption}\r` : ''}`);

  // 仅插入分段符，不回写正文；恢复两侧段落的样式及直接段落格式。
  const continuation = after.Duplicate;
  continuation.Collapse(COLLAPSE_END);
  const lastParagraph = continuation.Paragraphs.Item(1);
  lastParagraph.Style = original.style;
  lastParagraph.Format = original.format;
  if (original.hasPrefix) {
    const prefix = after.Duplicate;
    prefix.SetRange(original.start, original.start);
    const firstParagraph = prefix.Paragraphs.Item(1);
    firstParagraph.Style = original.style;
    firstParagraph.Format = original.format;
  }

  const imageParagraph = picture.Range.Paragraphs.Item(1);
  formatNewParagraph(imageParagraph, options, original.format.Alignment);
  imageParagraph.Format.KeepWithNext = options.caption ? -1 : 0;
  if (options.caption) {
    const captionRange = after.Duplicate;
    captionRange.SetRange(after.Start + 1, after.End - 1);
    formatNewParagraph(captionRange.Paragraphs.Item(1), options, original.format.Alignment);
  }
  return continuation;
}

function formatNewParagraph(paragraph, options, originalAlignment) {
  paragraph.Style = -1; // wdStyleNormal；不把原文的标题样式传给配图和图题。
  paragraph.Range.ListFormat.RemoveNumbers();
  const format = paragraph.Format;
  format.Alignment = options.layout === 'centered' ? 1 : originalAlignment;
  format.FirstLineIndent = 0;
  format.LeftIndent = 0;
  format.RightIndent = 0;
  format.LineSpacingRule = 0; // 单倍行距，避免固定行高裁切图片。
  format.KeepWithNext = 0;
}

export function insertPicture(asset, expectedTarget, options) {
  const layout = normalizeLayoutOptions(options);
  const app = globalThis.Application;
  if (!asset || typeof asset.path !== 'string' || !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(asset.path)) {
    throw new Error('图片路径无效，请从本地素材库重新选择图片');
  }

  let picture;
  let inserting = false;
  let undoRecord;
  let failure;
  let result;
  try {
    const doc = editableDocument(app);
    const range = app.Selection.Range.Duplicate;
    if (expectedTarget && (doc.FullName !== expectedTarget.document || range.Start !== expectedTarget.start || range.End !== expectedTarget.end || range.StoryType !== expectedTarget.story)) {
      throw new Error('当前文档或光标位置已改变，请确认目标后重新点击');
    }
    range.Collapse(COLLAPSE_END);
    const maxWidth = availableWidth(range);
    const widthLimit = layout.widthMode === 'fixed' ? Math.min(maxWidth, app.CentimetersToPoints(layout.widthCm)) : maxWidth;
    const heightLimit = layout.maxHeightCm === null ? Infinity : app.CentimetersToPoints(layout.maxHeightCm);
    let original;
    if (layout.layout === 'centered' || layout.caption) {
      const paragraph = range.Paragraphs.Item(1);
      const paragraphRange = paragraph.Range;
      const text = paragraphRange.Text;
      const endingLength = text.endsWith('\r\u0007') ? 2 : text.endsWith('\r') ? 1 : 0;
      if (range.Start > paragraphRange.End - endingLength) {
        throw new Error('请将光标放在正文或单元格内容内，不要选中结束标记');
      }
      original = {
        start: paragraphRange.Start,
        hasPrefix: range.Start > paragraphRange.Start,
        style: paragraph.Style,
        format: paragraph.Format.Duplicate,
      };
    }

    app.UndoRecord.StartCustomRecord('iPeiTu 插入配图');
    undoRecord = app.UndoRecord;
    inserting = true;
    picture = range.InlineShapes.AddPicture(asset.path, false, true, range);
    picture.LockAspectRatio = LOCK_ASPECT_RATIO;
    const width = picture.Width;
    const height = picture.Height;
    if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) {
      throw new Error('WPS 返回的图片尺寸无效');
    }
    const targetWidth = Math.min(layout.widthMode === 'auto' ? width : widthLimit, widthLimit, heightLimit * width / height);
    if (width !== targetWidth) picture.Width = targetWidth;
    const after = original ? separatePictureParagraphs(picture, original, layout) : picture.Range.Duplicate;
    if (!original) after.Collapse(COLLAPSE_END);
    after.Select();
    result = { name: asset.name, width: picture.Width, height: picture.Height };
  } catch (cause) {
    failure = cause;
  }
  if (undoRecord) {
    try {
      undoRecord.EndCustomRecord();
    } catch (cause) {
      failure = new Error(`${failure ? `${failure.message}；` : ''}无法完成本次撤销记录：${cause.message}`);
    }
  }
  if (failure) {
    const cause = failure;
    const detail = cause.message ? `（${cause.message}）` : '';
    let message;
    if (picture) {
      message = `图片已插入，但排版或光标定位未完成${detail}。请检查图片和图题，不要重复插入；需要时可撤销本次操作`;
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
  return result;
}
