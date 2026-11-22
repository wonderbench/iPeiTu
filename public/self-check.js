import {
  captureFillTarget, captureInsertionTarget, capturePlaceholderTarget, captureReplacementTarget,
  fillPlaceholder, insertPicture, insertPlaceholder, replacePicture, scanPlaceholders, selectPlaceholder,
} from './wps-bridge.js';
import { insertSnippet } from './knowledge-bridge.js';
import { readTableWidth, runLayoutOperation } from './layout-tools.js';

const DOCX_FORMAT = 12;
const DISCARD_CHANGES = 0;
const HEADING = 'iPeiTu 自检标题';
const identity = name => typeof name === 'string' ? name.replaceAll('/', '\\').toLowerCase() : '';
const errorText = error => error?.message || String(error);

function documentNames(app) {
  return new Set(Array.from({ length: app.Documents.Count }, (_, index) => identity(app.Documents.Item(index + 1).FullName)));
}

function appendParagraph(doc) {
  const end = doc.Content.End - 1;
  doc.Range(end, end).InsertAfter('\r');
  const next = doc.Content.End - 1;
  doc.Range(next, next).Select();
}

function verifySize(actualWidth, actualHeight, width, height, tolerance = 1) {
  const describe = (w, h) => `${Number(w).toFixed(1)} × ${Number(h).toFixed(1)} 磅`;
  const detail = `预期 ${describe(width, height)}，实测 ${describe(actualWidth, actualHeight)}`;
  if (!(Math.abs(actualWidth - width) <= tolerance && Math.abs(actualHeight - height) <= tolerance)) {
    throw new Error(detail);
  }
  return detail;
}

// 操作文档的阶段保持同步，所有依赖当前选区的操作都先确认活动文档。
export function runWpsSelfCheck(fixture) {
  const app = globalThis.Application;
  const results = [];
  let doc = null;
  let savedName = '';
  let originalNames = new Set();
  let originalDoc;
  let version = '无法读取';
  let safeToClean = false;
  try { version = String(app.Version || version); } catch { /* 版本读取不影响功能测试。 */ }

  function check(name, action) {
    const started = performance.now();
    try {
      results.push({ name, status: '通过', detail: action(), duration: Math.round(performance.now() - started) });
      return true;
    } catch (error) {
      results.push({ name, status: '失败', detail: errorText(error), duration: Math.round(performance.now() - started) });
      return false;
    }
  }

  function activeTestDocument() {
    const name = identity(doc?.FullName);
    if (!name || originalNames.has(name) || identity(app.ActiveDocument?.FullName) !== name) {
      throw new Error('活动文档不是本次自检文档，操作已停止');
    }
    return doc;
  }

  function closeTestDocument() {
    const name = identity(doc.FullName);
    if (!name || originalNames.has(name)) throw new Error('无法确认文档身份，已保留该文档');
    doc.Close(DISCARD_CHANGES);
    if (documentNames(app).has(name)) throw new Error('WPS 未关闭自检文档');
    doc = null;
  }

  const created = check('创建临时文档', () => {
    savedName = identity(fixture.documentPath);
    const validId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(fixture.id);
    if (!validId || !/^[a-z]:\\/.test(savedName)
      || !savedName.endsWith(`\\ipeitu-self-check-${fixture.id}\\ipeitu-自检.docx`)) {
      throw new Error('自检文档路径无效');
    }
    originalNames = documentNames(app);
    if (originalNames.has(savedName)) throw new Error('自检文档路径已在 WPS 中打开');
    originalDoc = app.Documents.Count ? app.ActiveDocument : null;
    const candidate = app.Documents.Add();
    const name = identity(candidate?.FullName);
    if (!name || originalNames.has(name) || app.Documents.Count <= originalNames.size) {
      throw new Error('WPS 未返回可确认的新文档');
    }
    doc = candidate;
    activeTestDocument();
    if (doc.Content.Text.trim() || doc.InlineShapes.Count || doc.Tables.Count || doc.ReadOnly) {
      throw new Error('新建文档不是可编辑的空白文档');
    }
    return '新建空白文档';
  });

  if (created) {
    const inserted = check('插入图片', () => {
      const testDoc = activeTestDocument();
      testDoc.Range(testDoc.Content.Start, testDoc.Content.Start).Select();
      activeTestDocument();
      const image = insertPicture(fixture.image, captureInsertionTarget());
      if (testDoc.InlineShapes.Count !== 1) throw new Error(`预期 1 张图片，实测 ${testDoc.InlineShapes.Count} 张`);
      return verifySize(image.width, image.height, 72, 48);
    });

    if (inserted) check('替换图片', () => {
      const testDoc = activeTestDocument();
      const oldImage = testDoc.InlineShapes.Item(1);
      const width = oldImage.Width;
      const position = oldImage.Range.Start;
      oldImage.Range.Select();
      activeTestDocument();
      replacePicture(fixture.replacement, captureReplacementTarget());
      const image = testDoc.InlineShapes.Item(1);
      if (testDoc.InlineShapes.Count !== 1 || image.Range.Start !== position) {
        throw new Error('替换后图片数量或原位置不一致');
      }
      return verifySize(image.Width, image.Height, width, width * 4 / 3);
    });
    else results.push({ name: '替换图片', status: '跳过', detail: '需要先成功插入测试图片' });

    let placeholder;
    const placed = check('插入并扫描占位框', () => {
      appendParagraph(activeTestDocument());
      activeTestDocument();
      const target = capturePlaceholderTarget(fixture.boxOptions);
      insertPlaceholder(fixture.box, target);
      placeholder = scanPlaceholders().boxes.find(box => box.name === target.name && !box.filled);
      if (!placeholder) throw new Error('扫描没有找到刚插入的占位框');
      return verifySize(placeholder.widthPt, placeholder.heightPt,
        fixture.boxOptions.widthCm * 72 / 2.54, fixture.boxOptions.heightCm * 72 / 2.54);
    });

    const filled = placed && check('填入占位框', () => {
      const testDoc = activeTestDocument();
      const count = testDoc.InlineShapes.Count;
      const scan = scanPlaceholders();
      selectPlaceholder(scan, placeholder);
      activeTestDocument();
      fillPlaceholder(fixture.replacement, captureFillTarget(), { asset: fixture.assetId, fit: 'fill' });
      const box = scanPlaceholders().boxes.find(item => item.name === placeholder.name && item.filled);
      if (!box || box.start !== placeholder.start || testDoc.InlineShapes.Count !== count) {
        throw new Error('填入后的标记、位置或图片数量未通过核对');
      }
      return verifySize(box.widthPt, box.heightPt, placeholder.widthPt, placeholder.heightPt);
    });
    if (!placed) results.push({ name: '填入占位框', status: '跳过', detail: '需要先成功插入并扫描占位框' });

    const heading = check('知识库标题与正文', () => {
      appendParagraph(activeTestDocument());
      activeTestDocument();
      const result = insertSnippet({ body: `# ${HEADING}\n## ${HEADING}二级\n自检正文` }, { baseLevel: 3 });
      if (result.paragraphs !== 3 || result.headings !== 2 || result.inTable) {
        throw new Error(`预期 3 段及 2 个标题，实测 ${result.paragraphs} 段及 ${result.headings} 个标题`);
      }
      return '核对标题 3、标题 4 及正文样式';
    });

    const table = check('表格宽度', () => {
      const testDoc = activeTestDocument();
      appendParagraph(testDoc);
      const end = testDoc.Content.End - 1;
      const added = testDoc.Tables.Add(testDoc.Range(end, end), 2, 2);
      const firstCell = added.Cell(1, 1).Range.Duplicate;
      firstCell.Collapse(1);
      firstCell.Select();
      activeTestDocument();
      const initial = readTableWidth();
      const desired = initial.widthCm === 12 ? 10 : 12;
      activeTestDocument();
      const operation = runLayoutOperation('standardizeWidths', { singleCm: desired, multiCm: desired });
      const { widthCm } = readTableWidth();
      const detail = `原宽 ${initial.widthCm} 厘米，预期 ${desired} 厘米，实测 ${widthCm} 厘米`;
      if (operation.count !== 1 || Math.abs(widthCm - desired) > 0.1) throw new Error(detail);
      return detail;
    });

    check('保存 DOCX 并重新打开', () => {
      const testDoc = activeTestDocument();
      const count = testDoc.InlineShapes.Count;
      testDoc.SaveAs2(fixture.documentPath, DOCX_FORMAT, false, '', false);
      if (identity(testDoc.FullName) !== savedName) throw new Error('WPS 未确认保存到本次自检路径');
      closeTestDocument();
      const reopened = app.Documents.Open(fixture.documentPath, false, false, false);
      if (identity(reopened?.FullName) !== savedName) throw new Error('WPS 未返回本次保存的 DOCX');
      doc = reopened;
      activeTestDocument();
      if (doc.InlineShapes.Count !== count) throw new Error(`预期 ${count} 张图片，重新打开后有 ${doc.InlineShapes.Count} 张`);
      if (table && doc.Tables.Count !== 1) throw new Error('重新打开后未找到测试表格');
      if (heading && !doc.Content.Text.includes(HEADING)) throw new Error('重新打开后未找到测试标题');
      if (placed) {
        const box = scanPlaceholders().boxes.find(item => item.name === placeholder.name);
        if (!box || (filled && !box.filled)) throw new Error('重新打开后未找到原占位框标记');
        verifySize(box.widthPt, box.heightPt, placeholder.widthPt, placeholder.heightPt);
      }
      return `重新打开并核对 ${count} 张图片${placed ? '及占位框标记' : ''}`;
    });
  }

  check('关闭测试文档', () => {
    if (doc) closeTestDocument();
    if (savedName && documentNames(app).has(savedName)) throw new Error('自检 DOCX 仍处于打开状态，请手动关闭');
    safeToClean = true;
    if (originalDoc && identity(originalDoc.FullName) !== identity(app.ActiveDocument?.FullName)) originalDoc.Activate();
    return '已结束自检文档操作';
  });
  return { version, results, safeToClean };
}
