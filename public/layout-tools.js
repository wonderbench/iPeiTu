// 一键排版：每项操作一次撤销记录，返回处理数量。批量操作使用所选范围或全文。
const NO_PROTECTION = -1;
const MAIN_STORY = 1;
const WITHIN_TABLE = 12;
const STYLE_NORMAL = -1;
const ALIGN_CENTER = 1;
const PREFERRED_WIDTH_PERCENT = 2;
const COLOR_AUTOMATIC = -16777216;
const TEXTURE_NONE = 0;
const PICTURE_GRAYSCALE = 2;
const INLINE_PICTURE_TYPES = [3, 4];
const SHAPE_PICTURE_TYPES = [11, 13];
const SHAPE_GROUP = 6;
const PREFERRED_WIDTH_POINTS = 3;
const ROW_ALIGN_LEFT = 0;
const ROW_ALIGN_CENTER = 1;
const ROW_ALIGN_RIGHT = 2;
const UNDEFINED_WIDTH = 9999998; // WPS/Word 对不确定的宽度返回 9999999
const FULL_WIDTH_SPACE = String.fromCharCode(0x3000);
const NO_BREAK_SPACE = String.fromCharCode(0xa0);
const SPACES = new Set([' ', FULL_WIDTH_SPACE, NO_BREAK_SPACE]);
const BLANK_PARAGRAPH = new RegExp(`^[ \\t${FULL_WIDTH_SPACE}${NO_BREAK_SPACE}]*\\r$`);
const LATIN = /[A-Za-z0-9]/;

function host() {
  const app = globalThis.Application;
  if (!app) throw new Error('请在 WPS 文字中打开排版工具');
  if (app.Documents.Count === 0) throw new Error('请先打开需要排版的 WPS 文字文档');
  const doc = app.ActiveDocument;
  if (!doc) throw new Error('请先切换到需要排版的 WPS 文字文档');
  if (doc.ReadOnly) throw new Error('当前文档为只读，请打开可编辑的副本');
  if (doc.ProtectionType !== NO_PROTECTION) throw new Error('当前文档受保护，请在允许编辑的文档中操作');
  const selection = app.Selection.Range;
  if (selection.StoryType !== MAIN_STORY) throw new Error('目前仅支持正文；页眉、页脚及文本框暂不支持');
  const whole = selection.Start === selection.End;
  return { app, doc, selection, whole, range: whole ? doc.Content : selection };
}

export function getLayoutScope() {
  try {
    const { doc, whole } = host();
    const scope = whole ? '首行缩进、居中对齐作用于当前段落，批量排版作用于全文' : '作用于所选内容';
    return { available: true, whole, message: `${doc.Name} · ${scope}` };
  } catch (error) {
    return { available: false, whole: true, message: error.message };
  }
}

function each(collection, visit) {
  const count = collection.Count;
  for (let index = 1; index <= count; index++) visit(collection.Item(index), index);
  return count;
}

function paragraphTarget({ selection, whole }) {
  return whole ? selection.Paragraphs.Item(1).Range : selection;
}

function grayscale(rgb) {
  const red = rgb & 0xff;
  const green = (rgb >> 8) & 0xff;
  const blue = (rgb >> 16) & 0xff;
  const gray = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
  return gray + gray * 256 + gray * 65536;
}

// 删除一个单元格中多余的空格：全角空格和行首尾空格全部删除；两个英文或数字之间保留一个半角空格。
export function spaceDeletions(text) {
  const segments = [];
  let index = 0;
  while (index < text.length) {
    if (!SPACES.has(text[index])) { index++; continue; }
    const start = index;
    while (index < text.length && SPACES.has(text[index])) index++;
    const run = text.slice(start, index);
    const keep = LATIN.test(text[start - 1] ?? '') && LATIN.test(text[index] ?? '') ? run.indexOf(' ') : -1;
    if (keep === -1) segments.push([start, index]);
    else {
      if (keep > 0) segments.push([start, start + keep]);
      if (start + keep + 1 < index) segments.push([start + keep + 1, index]);
    }
  }
  return segments;
}

const operations = {
  clearFormatting: {
    label: '清除格式',
    run(context) {
      if (context.whole) throw new Error('请先选中要清除格式的内容');
      const range = context.selection;
      const paragraphs = each(range.Paragraphs, paragraph => { paragraph.Style = STYLE_NORMAL; });
      range.ParagraphFormat.Reset();
      range.Font.Reset();
      return { count: paragraphs, unit: '段' };
    },
  },
  firstLineIndent: {
    label: '首行缩进',
    run(context) {
      const range = paragraphTarget(context);
      range.ParagraphFormat.CharacterUnitFirstLineIndent = 2;
      return { count: range.Paragraphs.Count, unit: '段' };
    },
  },
  center: {
    label: '居中对齐',
    run(context) {
      const range = paragraphTarget(context);
      range.ParagraphFormat.Alignment = ALIGN_CENTER;
      return { count: range.Paragraphs.Count, unit: '段' };
    },
  },
  deleteEmptyLines: {
    label: '删除空行',
    run({ doc, range }) {
      const paragraphs = range.Paragraphs;
      const { Start: documentStart, End: documentEnd } = doc.Content;
      const inTable = position => doc.Range(position, position).Information(WITHIN_TABLE);
      let count = 0;
      let skipped = 0;
      // 从后往前删，前面段落的序号不受影响。
      for (let index = paragraphs.Count; index >= 1; index--) {
        const paragraphRange = paragraphs.Item(index).Range;
        if (!BLANK_PARAGRAPH.test(paragraphRange.Text)) continue; // 含分节符、分页符或图片的段落不是空行。
        if (paragraphRange.Information(WITHIN_TABLE) || paragraphRange.End >= documentEnd) continue;
        // 从文档定位相邻位置，即使选区只包含这一空行也能看到两侧表格。
        const { Start: start, End: end } = paragraphRange;
        if (start > documentStart && inTable(start - 1) && inTable(end)) { skipped++; continue; }
        paragraphRange.Delete();
        count++;
      }
      return { count, skipped, unit: '处', skippedReason: '表格之间的空行保留' };
    },
  },
  tableFullWidth: {
    label: '表格满页',
    run({ range }) {
      const count = each(range.Tables, table => {
        table.PreferredWidthType = PREFERRED_WIDTH_PERCENT;
        table.PreferredWidth = 100;
      });
      return { count, unit: '个表格' };
    },
  },
  zeroPadding: {
    label: '边距清零',
    run({ range }) {
      const count = each(range.Tables, table => {
        table.TopPadding = 0;
        table.BottomPadding = 0;
        table.LeftPadding = 0;
        table.RightPadding = 0;
        each(table.Range.Cells, cell => {
          cell.TopPadding = 0;
          cell.BottomPadding = 0;
          cell.LeftPadding = 0;
          cell.RightPadding = 0;
        });
        // 锁定：关闭自动调整，列宽不再随内容变化。
        table.AllowAutoFit = false;
      });
      return { count, unit: '个表格' };
    },
  },
  clearTableSpaces: {
    label: '清除空格',
    run({ doc, range }) {
      let count = 0;
      let skipped = 0;
      each(range.Tables, table => {
        each(table.Range.Cells, cell => {
          const cellRange = cell.Range;
          // 去掉单元格结束标记；文字与位置一一对应时才删除，含域或隐藏文字的单元格跳过。
          const content = doc.Range(cellRange.Start, cellRange.End - 1);
          const text = content.Text;
          if (text.length !== content.End - content.Start) { skipped++; return; }
          const segments = spaceDeletions(text);
          for (const [start, end] of segments.reverse()) {
            doc.Range(content.Start + start, content.Start + end).Delete();
            count += end - start;
          }
        });
      });
      return { count, skipped, unit: '个空格', skippedReason: '含域或隐藏文字的单元格未处理' };
    },
  },
  removeShading: {
    label: '去除底纹',
    run({ range }) {
      const clear = shading => {
        shading.Texture = TEXTURE_NONE;
        shading.ForegroundPatternColor = COLOR_AUTOMATIC;
        shading.BackgroundPatternColor = COLOR_AUTOMATIC;
      };
      const count = each(range.Tables, table => {
        clear(table.Shading);
        each(table.Range.Cells, cell => clear(cell.Shading));
      });
      return { count, unit: '个表格' };
    },
  },
  removeBorders: {
    label: '去除表格线',
    run({ range }) {
      const count = each(range.Tables, table => {
        table.Borders.Enable = 0;
        each(table.Range.Cells, cell => { cell.Borders.Enable = 0; });
      });
      return { count, unit: '个表格' };
    },
  },
  decolor: {
    label: '一键去色',
    run({ doc, range, whole }) {
      let count = 0;
      let skipped = 0;
      each(range.InlineShapes, shape => {
        if (!INLINE_PICTURE_TYPES.includes(shape.Type)) return;
        shape.PictureFormat.ColorType = PICTURE_GRAYSCALE;
        count++;
      });
      // 浮动图形不按选区区分，只在全文时处理。
      if (whole) {
        each(doc.Shapes, shape => {
          try {
            if (shape.Type === SHAPE_GROUP) { skipped++; return; }
            if (SHAPE_PICTURE_TYPES.includes(shape.Type)) {
              shape.PictureFormat.ColorType = PICTURE_GRAYSCALE;
            } else {
              const fill = shape.Fill;
              if (fill.Visible) fill.ForeColor.RGB = grayscale(fill.ForeColor.RGB);
              const line = shape.Line;
              if (line.Visible) line.ForeColor.RGB = grayscale(line.ForeColor.RGB);
            }
            count++;
          } catch {
            skipped++; // 个别图形不支持填充或线条颜色，计数报告。
          }
        });
      }
      return { count, skipped, unit: '个图片或图形', skippedReason: '组合图形或不支持的图形未处理' };
    },
  },
  standardizeWidths: {
    label: '表格宽度',
    validate(options) {
      for (const key of ['singleCm', 'multiCm']) {
        const value = options?.[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 60) {
          throw new Error('表格宽度须为 1–60 厘米之间的数字');
        }
      }
    },
    run({ app, range }, options) {
      const targets = { single: app.CentimetersToPoints(options.singleCm), multi: app.CentimetersToPoints(options.multiCm) };
      let single = 0;
      let multi = 0;
      let unchanged = 0;
      let unreadable = 0;
      each(range.Tables, table => {
        const rows = rowWidths(table);
        if (!rows) { unreadable++; return; }
        const multiColumn = isMultiColumn(table);
        const target = multiColumn ? targets.multi : targets.single;
        const width = widestRow(rows);
        if (Math.abs(width - target) < 0.5) { unchanged++; return; }
        // 跨行单元格只在起始行枚举一次。整表使用同一比例，避免后续行缺计合并单元格而被放大。
        const factor = target / width;
        for (const row of rows) {
          for (const item of row) item.cell.Width = Math.round(item.width * factor * 100) / 100;
        }
        table.PreferredWidthType = PREFERRED_WIDTH_POINTS;
        table.PreferredWidth = Math.round(target * 100) / 100;
        if (multiColumn) multi++;
        else single++;
      });
      const parts = [`表格宽度：${single + multi ? `已调整 ${single + multi} 个表格（一栏 ${single}、多栏 ${multi}）` : '没有需要调整的表格'}`];
      if (unchanged) parts.push(`已符合 ${unchanged} 个`);
      if (unreadable) parts.push(`无法读取宽度 ${unreadable} 个`);
      return { count: single + multi, message: parts.join('；') };
    },
  },
  alignTablesLeft: alignTables('表格左对齐', ROW_ALIGN_LEFT),
  alignTablesCenter: alignTables('表格居中', ROW_ALIGN_CENTER),
  alignTablesRight: alignTables('表格右对齐', ROW_ALIGN_RIGHT),
};

function alignTables(label, alignment) {
  return {
    label,
    run({ range }) {
      const count = each(range.Tables, table => {
        // 通过行集合整体设置，表格含纵向合并单元格时也可用。
        const rows = table.Rows;
        if (alignment === ROW_ALIGN_LEFT) rows.LeftIndent = 0;
        rows.Alignment = alignment;
      });
      return { count, unit: '个表格' };
    },
  };
}

// 按行汇总本表格的单元格宽度（不含嵌套表格）；有单元格宽度不确定时返回 null。
function rowWidths(table) {
  const rows = new Map();
  let readable = true;
  each(table.Range.Cells, cell => {
    if (cell.NestingLevel !== table.NestingLevel) return;
    const width = cell.Width;
    if (!(Number.isFinite(width) && width > 0 && width < UNDEFINED_WIDTH)) {
      readable = false;
      return;
    }
    if (!rows.has(cell.RowIndex)) rows.set(cell.RowIndex, []);
    rows.get(cell.RowIndex).push({ cell, width });
  });
  return readable && rows.size ? [...rows.values()] : null;
}

const widestRow = rows => Math.max(...rows.map(row => row.reduce((total, item) => total + item.width, 0)));
const isMultiColumn = table => table.Range.PageSetup.TextColumns.Count > 1;

export function readTableWidth() {
  const app = globalThis.Application;
  if (!app) throw new Error('请在 WPS 文字中打开排版工具');
  if (app.Documents.Count === 0 || !app.ActiveDocument) throw new Error('请先打开需要排版的 WPS 文字文档');
  const tables = app.Selection.Range.Tables;
  if (!tables || tables.Count === 0) throw new Error('请把光标放在要读取的表格中');
  const table = tables.Item(1);
  const rows = rowWidths(table);
  if (!rows) throw new Error('无法读取该表格的宽度，表格中有宽度不确定的单元格');
  const widthPt = widestRow(rows);
  return { widthCm: Math.round(widthPt * 2.54 / 72 * 10) / 10, multiColumn: isMultiColumn(table) };
}

export const LAYOUT_OPERATIONS = Object.keys(operations);

export function runLayoutOperation(name, options) {
  const operation = operations[name];
  if (!operation) throw new Error('未知的排版操作');
  operation.validate?.(options);
  const context = host();
  context.app.UndoRecord.StartCustomRecord(`iPeiTu 排版：${operation.label}`);
  let result;
  let failure;
  try {
    result = operation.run(context, options);
  } catch (cause) {
    failure = cause;
  }
  try {
    context.app.UndoRecord.EndCustomRecord();
  } catch (cause) {
    failure = new Error(`${failure ? `${failure.message}；` : ''}无法完成本次撤销记录：${cause.message}`);
  }
  if (failure) {
    const error = new Error(`${operation.label}未完成：${failure.message || '请检查文档'}。若文档已有改动，可撤销一次恢复`);
    error.cause = failure;
    throw error;
  }
  const parts = [`${operation.label}：${result.count ? `已处理 ${result.count} ${result.unit}` : '没有需要处理的内容'}`];
  if (result.skipped) parts.push(`${result.skippedReason} ${result.skipped} 处`);
  return { ...result, label: operation.label, message: result.message ?? parts.join('；') };
}
