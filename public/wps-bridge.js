import { normalizeLayoutOptions } from './layout-options.js';
import { normalizePlaceholderOptions } from './placeholder-options.js';

const COLLAPSE_END = 0;
const COLLAPSE_START = 1;
const WITHIN_TABLE = 12;
const NO_PROTECTION = -1;
const LOCK_ASPECT_RATIO = -1;
const UNLOCK_ASPECT_RATIO = 0;
const ROW_HEIGHT_AUTO = 0;
const MIN_BOX_PT = 14;
const MAX_BOX_PT = 1440;
const PLACEHOLDER_PREFIX = 'iPeiTu-box:1:';
const LOCAL_PATH = /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i;
const ASSET_ID = /^[a-f0-9]{64}$/;
export const FIT_MODES = ['cover', 'fill', 'contain'];
const replacementTargets = new WeakMap();
const fillTargets = new WeakMap();

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
  const explicitSize = asset.logicalWidthPt !== undefined || asset.logicalHeightPt !== undefined;
  const nativeScale = asset.naturalWidthScale !== undefined;
  if (explicitSize && (![asset.logicalWidthPt, asset.logicalHeightPt].every(value => Number.isFinite(value) && value > 0 && value <= 100000000))) {
    throw new Error('图片排版尺寸无效，请重新选择素材');
  }
  if (nativeScale && (explicitSize || !Number.isFinite(asset.naturalWidthScale) || asset.naturalWidthScale < 1 || asset.naturalWidthScale > 64000000)) {
    throw new Error('图片自然尺寸倍率无效，请重新选择素材');
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
    const logicalWidth = explicitSize ? asset.logicalWidthPt : nativeScale ? width * asset.naturalWidthScale : width;
    // Resampling rounds pixel dimensions; use the actual inserted aspect ratio
    // for the hard height limit so that a one-pixel roundoff cannot exceed it.
    const targetWidth = Math.min(layout.widthMode === 'auto' ? logicalWidth : widthLimit, widthLimit, heightLimit * width / height);
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

// 占位框：一张内嵌占位图，AlternativeText 中写入带版本的标记，便于扫描和后续填入。
// 已填的框额外记录素材 ID 与适配方式，框名不变，可以再次换图。
export function placeholderMarker(name, filled) {
  return `${PLACEHOLDER_PREFIX}${JSON.stringify(filled ? { name, asset: filled.asset, fit: filled.fit } : { name })}`;
}

export function parsePlaceholderMarker(text) {
  if (typeof text !== 'string' || !text.startsWith(PLACEHOLDER_PREFIX)) return null;
  let value;
  try { value = JSON.parse(text.slice(PLACEHOLDER_PREFIX.length)); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string' || !value.name) return null;
  if (typeof value.asset === 'string' && ASSET_ID.test(value.asset) && FIT_MODES.includes(value.fit)) {
    return { name: value.name, asset: value.asset, fit: value.fit };
  }
  return { name: value.name };
}

function placeholderSize(app, range, options) {
  const page = range.PageSetup;
  const maxWidth = availableWidth(range);
  const maxHeight = page.PageHeight - page.TopMargin - page.BottomMargin;
  if (!Number.isFinite(maxHeight) || maxHeight <= 0) throw new Error('当前位置没有可用的版面高度，请移动光标后重试');
  let width;
  let height;
  if (options.size === 'cell') {
    if (!range.Information(WITHIN_TABLE)) throw new Error('光标不在表格单元格内，请改选其他尺寸');
    const cell = range.Cells.Item(1);
    width = maxWidth;
    const inner = cell.Height - cell.TopPadding - cell.BottomPadding;
    // 自动行高的单元格没有确定高度，按 4:3 取高。
    height = cell.HeightRule === ROW_HEIGHT_AUTO || !(Number.isFinite(inner) && inner > 0) ? width * 3 / 4 : inner;
  } else if (options.size === 'line') {
    width = maxWidth;
    height = width * 3 / 4;
  } else {
    width = app.CentimetersToPoints(options.widthCm);
    height = app.CentimetersToPoints(options.heightCm);
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height, MAX_BOX_PT / width, MAX_BOX_PT / height);
  const widthPt = Math.floor(width * scale * 10 + 1e-6) / 10;
  const heightPt = Math.floor(height * scale * 10 + 1e-6) / 10;
  if (!(widthPt >= MIN_BOX_PT && heightPt >= MIN_BOX_PT)) throw new Error('可用空间太小，放不下占位框');
  return { widthPt, heightPt };
}

export function capturePlaceholderTarget(input) {
  const options = normalizePlaceholderOptions(input);
  try {
    const app = globalThis.Application;
    const doc = editableDocument(app);
    const range = insertionRange(app).Duplicate;
    const target = { document: doc.FullName, start: range.Start, end: range.End, story: range.StoryType };
    range.Collapse(COLLAPSE_END);
    return { ...target, name: options.name, ...placeholderSize(app, range, options) };
  } catch (cause) {
    throw new Error(`无法放置占位框：${cause.message || '请在文档中放置光标后重试'}`);
  }
}

function zeroParagraphSpacing(paragraph) {
  const format = paragraph.Format;
  format.SpaceBefore = 0;
  format.SpaceAfter = 0;
}

export function insertPlaceholder(image, target) {
  const app = globalThis.Application;
  if (!image || typeof image.path !== 'string' || !LOCAL_PATH.test(image.path)) throw new Error('占位图路径无效，请重试');
  if (!target || typeof target.name !== 'string' || !target.name
    || ![target.widthPt, target.heightPt].every(value => Number.isFinite(value) && value >= MIN_BOX_PT && value <= MAX_BOX_PT)) {
    throw new Error('占位框目标无效，请重新点击插入');
  }
  let picture;
  let inserting = false;
  let marked = false;
  let removed = false;
  let undoRecord;
  let failure;
  let result;
  try {
    const doc = editableDocument(app);
    const range = insertionRange(app).Duplicate;
    if (doc.FullName !== target.document || range.Start !== target.start || range.End !== target.end || range.StoryType !== target.story) {
      throw new Error('当前文档或光标位置已改变，请确认目标后重新点击');
    }
    range.Collapse(COLLAPSE_END);
    const paragraph = range.Paragraphs.Item(1);
    const paragraphRange = paragraph.Range;
    const text = paragraphRange.Text;
    const endingLength = text.endsWith('\r\u0007') ? 2 : text.endsWith('\r') ? 1 : 0;
    if (range.Start > paragraphRange.End - endingLength) throw new Error('请将光标放在正文或单元格内容内，不要选中结束标记');
    // 空段落（含空单元格）直接作为框所在段落，不再多拆一段，避免撑高表格行。
    const empty = text.length === endingLength;
    const original = {
      start: paragraphRange.Start,
      hasPrefix: range.Start > paragraphRange.Start,
      style: paragraph.Style,
      format: paragraph.Format.Duplicate,
    };

    app.UndoRecord.StartCustomRecord('iPeiTu 插入占位框');
    undoRecord = app.UndoRecord;
    inserting = true;
    picture = range.InlineShapes.AddPicture(image.path, false, true, range);
    picture.LockAspectRatio = UNLOCK_ASPECT_RATIO;
    picture.Width = target.widthPt;
    picture.Height = target.heightPt;
    picture.LockAspectRatio = LOCK_ASPECT_RATIO;
    if (!(Math.abs(picture.Width - target.widthPt) <= 0.1 && Math.abs(picture.Height - target.heightPt) <= 0.1)) {
      throw new Error('WPS 未能按框的尺寸设置占位图');
    }
    const marker = placeholderMarker(target.name);
    picture.AlternativeText = marker;
    if (picture.AlternativeText !== marker) throw new Error('WPS 未能保存占位框标记');
    marked = true;

    let after;
    if (empty) {
      formatNewParagraph(picture.Range.Paragraphs.Item(1), { layout: 'centered' }, original.format.Alignment);
      after = picture.Range.Duplicate;
      after.Collapse(COLLAPSE_END);
    } else {
      after = separatePictureParagraphs(picture, original, { layout: 'centered', caption: '' });
    }
    zeroParagraphSpacing(picture.Range.Paragraphs.Item(1));
    after.Select();
    result = { name: target.name, widthPt: picture.Width, heightPt: picture.Height };
  } catch (cause) {
    failure = cause;
    // 没有标记的框无法被扫描和填入，删掉而不是留给用户。
    if (picture && !marked) {
      try {
        picture.Delete();
        removed = true;
      } catch (cleanupError) {
        failure = new Error(`${cause.message}；无法移除未完成的占位图：${cleanupError.message}`);
      }
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
    if (marked) message = `占位框已插入，但排版或光标定位未完成${detail}。请检查文档，不要重复插入`;
    else if (removed) message = `占位框未插入，未完成的占位图已移除${detail}`;
    else if (picture) message = `占位图已插入但未能写入标记${detail}。请删除这张图片后重试`;
    else if (inserting) message = `WPS 未能确认插入结果${detail}。请检查文档，确认没有新增图片后再重试`;
    else message = `插入已中止${detail}`;
    const error = new Error(message);
    error.inserted = marked || (Boolean(picture) && !removed);
    error.cause = failure;
    throw error;
  }
  return result;
}

function readableDocument() {
  const app = globalThis.Application;
  if (!app) throw new Error('请在 WPS 文字中打开 iPeiTu 素材库');
  if (app.Documents.Count === 0) throw new Error('请先打开需要配图的 WPS 文字文档');
  const doc = app.ActiveDocument;
  if (!doc) throw new Error('请先切换到需要配图的 WPS 文字文档');
  return doc;
}

export function scanPlaceholders() {
  const doc = readableDocument();
  const shapes = doc.InlineShapes;
  const count = shapes.Count;
  const boxes = [];
  let unreadable = 0;
  for (let index = 1; index <= count; index++) {
    const shape = shapes.Item(index);
    let marker;
    try { marker = parsePlaceholderMarker(shape.AlternativeText); } catch {
      // 个别对象（如部分 OLE）可能读不出替代文字；计数报告，不当作没有占位框。
      unreadable++;
      continue;
    }
    if (!marker) continue;
    boxes.push({ index, name: marker.name, start: shape.Range.Start, widthPt: shape.Width, heightPt: shape.Height, filled: Boolean(marker.asset) });
  }
  return { document: doc.FullName, boxes, unreadable };
}

export function selectPlaceholder(scan, box) {
  const doc = readableDocument();
  const stale = message => Object.assign(new Error(message), { stale: true });
  if (!scan || doc.FullName !== scan.document) throw stale('当前文档已切换，已重新扫描');
  const shapes = doc.InlineShapes;
  if (!box || !Number.isInteger(box.index) || box.index < 1 || box.index > shapes.Count) throw stale('文档已变化，已重新扫描');
  const shape = shapes.Item(box.index);
  const range = shape.Range;
  const marker = parsePlaceholderMarker(shape.AlternativeText);
  if (!marker || marker.name !== box.name || range.Start !== box.start) throw stale('文档已变化，已重新扫描');
  range.Select();
}

// 填入占位框：沿用替换的安全顺序（先插入新图并核对，再删除原框），但按框的宽高精确设定并保留标记。
// 替换流程已有实机验收，这里不改动它。
function fillSelection() {
  const selected = replacementSelection();
  let marker;
  try { marker = parsePlaceholderMarker(selected.picture.AlternativeText); } catch { marker = null; }
  if (!marker) throw new Error('选中的图片不是占位框');
  return { ...selected, snapshot: { ...selected.snapshot, name: marker.name } };
}

export function getFillStatus() {
  try {
    const { snapshot } = fillSelection();
    return { available: true, name: snapshot.name, widthPt: snapshot.width, heightPt: snapshot.height };
  } catch {
    return { available: false };
  }
}

export function captureFillTarget() {
  try {
    const { picture, snapshot } = fillSelection();
    const target = Object.freeze({ ...snapshot });
    fillTargets.set(target, { picture, snapshot });
    return target;
  } catch (cause) {
    throw new Error(`无法记录占位框：${cause.message || '请重新选中占位框'}`);
  }
}

export function fillPlaceholder(image, expectedTarget, filled) {
  let picture;
  let adding = false;
  let removedNewPicture = false;
  let deleteAttempted = false;
  let done = false;
  let resultUncertain = false;
  let undoRecord;
  let failure;
  let result;
  try {
    if (!image || typeof image.path !== 'string' || !LOCAL_PATH.test(image.path)) {
      throw new Error('图片路径无效，请从本地素材库重新选择图片');
    }
    if (!filled || typeof filled.asset !== 'string' || !ASSET_ID.test(filled.asset) || !FIT_MODES.includes(filled.fit)) {
      throw new Error('填入的素材或适配方式无效');
    }
    const captured = expectedTarget && fillTargets.get(expectedTarget);
    if (!captured) throw new Error('占位框目标已失效，请重新选中占位框');
    fillTargets.delete(expectedTarget);
    const { app, snapshot } = fillSelection();
    if (Object.keys(snapshot).some(key => snapshot[key] !== captured.snapshot[key])) {
      throw new Error('当前文档、选区或占位框已改变，请重新选中占位框');
    }
    const original = captured.picture;
    const originalRange = original.Range;
    if (originalRange.Start !== snapshot.start || originalRange.End !== snapshot.end || originalRange.StoryType !== snapshot.story
      || original.Type !== snapshot.type || original.Width !== snapshot.width || original.Height !== snapshot.height) {
      throw new Error('占位框已改变，请重新选中');
    }
    const font = originalRange.Font.Duplicate;
    const range = originalRange.Duplicate;
    range.Collapse(COLLAPSE_START);
    app.UndoRecord.StartCustomRecord('iPeiTu 填入占位框');
    undoRecord = app.UndoRecord;
    adding = true;
    picture = range.InlineShapes.AddPicture(image.path, false, true, range);
    if (!(Number.isFinite(picture.Width) && picture.Width > 0 && Number.isFinite(picture.Height) && picture.Height > 0)) {
      throw new Error('WPS 返回的图片尺寸无效');
    }
    picture.LockAspectRatio = UNLOCK_ASPECT_RATIO;
    picture.Width = snapshot.width;
    picture.Height = snapshot.height;
    picture.LockAspectRatio = LOCK_ASPECT_RATIO;
    if (!(Math.abs(picture.Width - snapshot.width) <= 0.1 && Math.abs(picture.Height - snapshot.height) <= 0.1)) {
      throw new Error('WPS 未能按占位框尺寸设置图片');
    }
    const marker = placeholderMarker(snapshot.name, filled);
    picture.AlternativeText = marker;
    if (picture.AlternativeText !== marker) throw new Error('WPS 未能保存占位框标记');
    picture.Range.Font = font;
    // 此时原框已经向后移动。只删除原 COM 对象，绝不删除捕获时的数值范围。
    const shiftedOriginal = original.Range;
    const insertedRange = picture.Range;
    if (insertedRange.Start !== snapshot.start || shiftedOriginal.Start !== insertedRange.End
      || shiftedOriginal.End - shiftedOriginal.Start !== snapshot.end - snapshot.start
      || shiftedOriginal.StoryType !== snapshot.story) {
      throw new Error('无法确认占位框在插入后的准确位置，已停止填入');
    }
    deleteAttempted = true;
    original.Delete();
    done = true;
    const after = picture.Range.Duplicate;
    after.Collapse(COLLAPSE_END);
    after.Select();
    result = { name: snapshot.name, asset: image.name, widthPt: picture.Width, heightPt: picture.Height };
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
    } else if ((adding && !picture) || (deleteAttempted && !done)) {
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
    if (done) message = `图片已填入，但光标定位或撤销记录未完成${detail}。请检查文档，不要重复填入`;
    else if (deleteAttempted) message = `新图已插入，但无法确认原占位框是否已删除${detail}。请检查文档，不要重复填入；需要时撤销本次操作`;
    else if (removedNewPicture) message = `填入未完成，占位框已保留，新增图片已移除${detail}`;
    else if (adding) message = `占位框尚未删除，但无法确认新增图片的最终状态${detail}。请检查文档，不要重复填入；需要时撤销本次操作`;
    else message = `填入已中止${detail}`;
    const error = new Error(message);
    error.inserted = Boolean(picture) && !removedNewPicture;
    error.filled = done;
    error.resultUncertain = resultUncertain;
    error.cause = failure;
    throw error;
  }
  return result;
}
