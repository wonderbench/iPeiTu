import { normalizeLayoutOptions } from './layout-options.js';

const COLLAPSE_END = 0;
const COLLAPSE_START = 1;
const WITHIN_TABLE = 12;
const NO_PROTECTION = -1;
const LOCK_ASPECT_RATIO = -1;
const replacementTargets = new WeakMap();

function editableDocument(app, action = '插入') {
  if (!app) throw new Error('请在 WPS 文字中打开 iPeiTu 素材库');
  if (app.Documents.Count === 0) throw new Error('请先打开需要配图的 WPS 文字文档');
  const doc = app.ActiveDocument;
  if (!doc) throw new Error('请先切换到需要配图的 WPS 文字文档');
  if (doc.ReadOnly) throw new Error(`当前文档为只读，请打开可编辑的副本后${action}`);
  if (doc.ProtectionType !== NO_PROTECTION) {
    throw new Error(`当前文档受保护，请在允许编辑的文档中${action}`);
  }
  return doc;
}

function insertionRange(app) {
  const range = app.Selection.Range;
  if (range.StoryType !== 1) {
    throw new Error('目前仅支持在正文和正文表格中插入图片；页眉、页脚及文本框暂不支持');
  }
  return range;
}

export function getHostStatus() {
  try {
    const doc = editableDocument(globalThis.Application);
    insertionRange(globalThis.Application);
    return { available: true, message: `插入到：${doc.Name}` };
  } catch (error) {
    return { available: false, message: `无法插图：${error.message || '无法读取 WPS 文档状态，请重新打开素材库'}` };
  }
}

export function captureInsertionTarget() {
  try {
    const app = globalThis.Application;
    const doc = editableDocument(app);
    const range = insertionRange(app);
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
    const range = insertionRange(app).Duplicate;
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

function replacementSelection() {
  const app = globalThis.Application;
  const doc = editableDocument(app, '替换');
  const selection = app.Selection;
  const range = selection.Range;
  if (range.StoryType !== 1) {
    throw new Error('目前仅支持替换正文和正文表格中的内嵌图片；页眉、页脚及文本框暂不支持');
  }
  if (![2, 7].includes(selection.Type) || range.InlineShapes.Count !== 1) {
    throw new Error('请在文档中完整选中一张内嵌图片；暂不支持浮动图片或多选');
  }
  const picture = range.InlineShapes.Item(1);
  const pictureRange = picture.Range;
  if (![3, 4].includes(picture.Type) || range.Start !== pictureRange.Start || range.End !== pictureRange.End
    || range.StoryType !== pictureRange.StoryType || range.Start >= range.End) {
    throw new Error('请只选中一张内嵌图片，不要包含相邻文字或段落标记');
  }
  const width = picture.Width;
  const height = picture.Height;
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) {
    throw new Error('无法读取原图片的有效尺寸，请重新选中图片');
  }
  return { app, doc, picture, snapshot: {
    document: doc.FullName, start: range.Start, end: range.End, story: range.StoryType,
    type: picture.Type, width, height,
  } };
}

export function getReplacementStatus() {
  try {
    const { doc } = replacementSelection();
    return { available: true, message: `替换到：${doc.Name}中选中的内嵌图片` };
  } catch (error) {
    return { available: false, message: `无法替换：${error.message || '无法读取选中的图片，请重新选择'}` };
  }
}

export function captureReplacementTarget() {
  try {
    const { picture, snapshot } = replacementSelection();
    const target = Object.freeze({ ...snapshot });
    // 保留原对象身份，不依赖每次访问 COM 集合返回的 JS 包装是否严格相等。
    replacementTargets.set(target, { picture, snapshot });
    return target;
  } catch (cause) {
    throw new Error(`无法记录替换目标：${cause.message || '请重新选中需要替换的图片'}`);
  }
}

export function replacePicture(asset, expectedTarget) {
  let picture;
  let adding = false;
  let removedNewPicture = false;
  let deleteAttempted = false;
  let replaced = false;
  let resultUncertain = false;
  let undoRecord;
  let failure;
  let result;
  try {
    if (!asset || typeof asset.path !== 'string' || !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(asset.path)) {
      throw new Error('图片路径无效，请从本地素材库重新选择图片');
    }
    const captured = expectedTarget && replacementTargets.get(expectedTarget);
    if (!captured) throw new Error('替换目标已失效，请重新选中图片后点击替换');
    replacementTargets.delete(expectedTarget);
    const { app, snapshot } = replacementSelection();
    if (Object.keys(snapshot).some(key => snapshot[key] !== captured.snapshot[key])) {
      throw new Error('当前文档、选区或原图片尺寸已改变，请重新确认替换目标');
    }
    const original = captured.picture;
    const originalRange = original.Range;
    if (originalRange.Start !== snapshot.start || originalRange.End !== snapshot.end || originalRange.StoryType !== snapshot.story
      || original.Type !== snapshot.type || original.Width !== snapshot.width || original.Height !== snapshot.height) {
      throw new Error('原图片已改变，请重新选中需要替换的图片');
    }
    const font = originalRange.Font.Duplicate;
    const range = originalRange.Duplicate;
    range.Collapse(COLLAPSE_START);
    app.UndoRecord.StartCustomRecord('iPeiTu 替换配图');
    undoRecord = app.UndoRecord;
    adding = true;
    picture = range.InlineShapes.AddPicture(asset.path, false, true, range);
    const nativeWidth = picture.Width;
    const nativeHeight = picture.Height;
    if (!(Number.isFinite(nativeWidth) && nativeWidth > 0 && Number.isFinite(nativeHeight) && nativeHeight > 0)) {
      throw new Error('WPS 返回的图片尺寸无效');
    }
    picture.LockAspectRatio = LOCK_ASPECT_RATIO;
    picture.Width = snapshot.width;
    if (!Number.isFinite(picture.Width) || !Number.isFinite(picture.Height) || picture.Height <= 0
      || Math.abs(picture.Width - snapshot.width) > 0.1
      || Math.abs(picture.Height - snapshot.width * nativeHeight / nativeWidth) > 0.1) {
      throw new Error('WPS 未能按原宽度等比例调整新图片');
    }
    picture.Range.Font = font;
    // 此时原图已经向后移动。只删除原 COM 对象，绝不删除捕获时的数值范围。
    const shiftedOriginal = original.Range;
    const insertedRange = picture.Range;
    if (insertedRange.Start !== snapshot.start || shiftedOriginal.Start !== insertedRange.End
      || shiftedOriginal.End - shiftedOriginal.Start !== snapshot.end - snapshot.start
      || shiftedOriginal.StoryType !== snapshot.story) {
      throw new Error('无法确认原图片在插入后的准确位置，已停止替换');
    }
    deleteAttempted = true;
    original.Delete();
    replaced = true;
    const after = picture.Range.Duplicate;
    after.Collapse(COLLAPSE_END);
    after.Select();
    result = { name: asset.name, width: picture.Width, height: picture.Height, inserted: true, replaced: true };
  } catch (cause) {
    failure = cause;
    if (picture && !deleteAttempted) {
      try {
        picture.Delete();
        removedNewPicture = true;
      } catch (cleanupError) {
        resultUncertain = true;
        failure = new Error(`${cause.message}；无法确认新增图片已移除：${cleanupError.message}`);
      }
    } else if ((adding && !picture) || (deleteAttempted && !replaced)) {
      resultUncertain = true;
    }
  }
  if (undoRecord) {
    try { undoRecord.EndCustomRecord(); } catch (cause) {
      failure = new Error(`${failure ? `${failure.message}；` : ''}无法完成本次撤销记录：${cause.message}`);
    }
  }
  if (failure) {
    const detail = failure.message ? `（${failure.message}）` : '';
    let message;
    if (replaced) message = `图片已替换，但光标定位或撤销记录未完成${detail}。请检查文档，不要重复替换`;
    else if (deleteAttempted) message = `新图已插入，但无法确认原图是否已删除${detail}。请检查文档，不要重复替换；需要时撤销本次操作`;
    else if (removedNewPicture) message = `替换未完成，原图已保留，新增图片已移除${detail}`;
    else if (adding) message = `原图尚未删除，但无法确认新增图片的最终状态${detail}。请检查文档，不要重复替换；需要时撤销本次操作`;
    else message = `替换已中止${detail}`;
    const error = new Error(message);
    error.inserted = Boolean(picture) && !removedNewPicture;
    error.replaced = replaced;
    error.resultUncertain = resultUncertain;
    error.cause = failure;
    throw error;
  }
  return result;
}
