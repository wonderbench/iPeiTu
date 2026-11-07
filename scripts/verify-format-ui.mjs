import assert from 'node:assert/strict';

export async function verifyFormat({ page, base }) {
  async function visibleText(selector, text) {
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${base}/format.html`);
  await page.locator('[data-operation]').first().waitFor();
  assert.equal(await page.locator('[data-operation]').count(), 13, '一键排版 10 项与 3 种表格对齐');

  // 浏览器模式：全部按钮禁用。
  await page.evaluate(() => { delete window.Application; window.dispatchEvent(new Event('focus')); });
  await visibleText('#scopeStatus', '浏览器模式');
  assert.equal(await page.locator('[data-operation]:not(:disabled)').count(), 0);
  assert.equal(await page.locator('#applyTableWidths').isDisabled(), true);
  assert.equal(await page.locator('#readTableWidth').isDisabled(), true);

  // 模拟 WPS：四个段落（第二段为空行、最后一段在文档末尾）和一个半宽表格，光标未选中内容。
  await page.evaluate(() => {
    const state = window.formatState = {
      paragraphs: ['正文\r', '\r', '结尾\r', '\r'].map(text => ({ text })),
      table: { PreferredWidthType: 1, PreferredWidth: 50, NestingLevel: 1, Rows: { Alignment: 0, LeftIndent: 0 } },
      cells: [{ Width: 200, RowIndex: 1, NestingLevel: 1 }, { Width: 100, RowIndex: 1, NestingLevel: 1 }],
      current: {}, undo: [],
    };
    state.table.Range = { Cells: { Count: 2, Item: index => state.cells[index - 1] }, PageSetup: { TextColumns: { Count: 1 } } };
    const end = paragraph => state.paragraphs.slice(0, state.paragraphs.indexOf(paragraph) + 1).reduce((sum, item) => sum + item.text.length, 0);
    const paragraphs = {
      get Count() { return state.paragraphs.length; },
      Item: index => {
        const paragraph = state.paragraphs[index - 1];
        return { Range: { Text: paragraph.text, End: end(paragraph), Information: () => false,
          Delete() { state.paragraphs.splice(state.paragraphs.indexOf(paragraph), 1); } } };
      },
    };
    const doc = { Name: '排版.docx', ReadOnly: false, ProtectionType: -1,
      get Content() { return { Start: 0, End: end(state.paragraphs.at(-1)), Paragraphs: paragraphs, Tables: { Count: 1, Item: () => state.table } }; } };
    window.Application = {
      Documents: { Count: 1 }, ActiveDocument: doc, CentimetersToPoints: value => value * 72 / 2.54,
      UndoRecord: { StartCustomRecord(name) { state.undo.push(name); }, EndCustomRecord() {} },
      Selection: { Range: { Start: 2, End: 2, StoryType: 1, Tables: { Count: 1, Item: () => state.table },
        Paragraphs: { Count: 1, Item: () => ({ Range: { ParagraphFormat: state.current, Paragraphs: { Count: 1 } } }) } } },
    };
    window.dispatchEvent(new Event('focus'));
  });
  await visibleText('#scopeStatus', '排版.docx · 未选中内容，作用于全文');
  assert.equal(await page.locator('[data-operation="clearFormatting"]').isDisabled(), true, '未选中内容时不能清除格式');

  await page.locator('[data-operation="deleteEmptyLines"]').click();
  await visibleText('#formatResult', '删除空行：已处理 1 处');
  await page.locator('[data-operation="tableFullWidth"]').click();
  await visibleText('#formatResult', '表格满页：已处理 1 个表格');
  await page.locator('[data-operation="firstLineIndent"]').click();
  await visibleText('#formatResult', '首行缩进：已处理 1 段');
  const snapshot = () => page.evaluate(() => {
    const { paragraphs, table, cells, current, undo } = window.formatState;
    return {
      paragraphs: paragraphs.map(item => item.text), cells: cells.map(cell => cell.Width), current, undo,
      table: { PreferredWidthType: table.PreferredWidthType, PreferredWidth: table.PreferredWidth, Alignment: table.Rows.Alignment },
    };
  });
  let state = await snapshot();
  assert.deepEqual(state.paragraphs, ['正文\r', '结尾\r', '\r'], '删除中间空行，保留文档末尾段落');
  assert.deepEqual([state.table.PreferredWidthType, state.table.PreferredWidth], [2, 100]);
  assert.equal(state.current.CharacterUnitFirstLineIndent, 2);
  assert.deepEqual(state.undo, ['iPeiTu 排版：删除空行', 'iPeiTu 排版：表格满页', 'iPeiTu 排版：首行缩进']);

  // 表格宽度：读取光标所在表格，改为 16 厘米后执行调整，再整体居中。
  await page.locator('#readTableWidth').click();
  await visibleText('#formatResult', '当前表格宽 10.6 厘米，已填入一栏页面宽度');
  assert.equal(await page.locator('#singleWidth').inputValue(), '10.6');
  await page.locator('#singleWidth').fill('16');
  await page.locator('#applyTableWidths').click();
  await visibleText('#formatResult', '表格宽度：已调整 1 个表格（一栏 1、多栏 0）');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ipeitu.tableWidths.v1'))), { singleCm: 16, multiCm: 7 });
  await page.locator('#multiWidth').fill('0');
  await page.locator('#applyTableWidths').click();
  await visibleText('#formatResult', '1–60 厘米');
  await page.locator('#multiWidth').fill('7');
  await page.locator('[data-operation="alignTablesCenter"]').click();
  await visibleText('#formatResult', '表格居中：已处理 1 个表格');
  state = await snapshot();
  const target = 16 * 72 / 2.54;
  assert.ok(Math.abs(state.cells[0] + state.cells[1] - target) < 0.05 && Math.abs(state.cells[0] / state.cells[1] - 2) < 0.001, '各列等比缩放到目标宽度');
  assert.deepEqual([state.table.PreferredWidthType, state.table.Alignment], [3, 1]);
  assert.deepEqual(state.undo.slice(3), ['iPeiTu 排版：表格宽度', 'iPeiTu 排版：表格居中'], '无效宽度不产生撤销记录');

  await page.evaluate(() => { window.Application.ActiveDocument.ReadOnly = true; window.dispatchEvent(new Event('focus')); });
  await visibleText('#scopeStatus', '只读');
  assert.equal(await page.locator('[data-operation]:not(:disabled)').count(), 0, '只读文档全部禁用');

  for (const width of [320, 420]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
      && [...document.querySelectorAll('[data-operation]')].every(button => button.getBoundingClientRect().right <= innerWidth)), true, `${width}px 排版工具无横向溢出`);
  }
  console.log('排版工具 UI 验收通过：十三项入口、浏览器与只读禁用、作用范围提示、删除空行、表格满页、首行缩进、读取与调整表格宽度、表格居中、撤销记录、窄窗格布局。');
}
