import assert from 'node:assert/strict';
import sharp from 'sharp';

export async function verifyPlaceholders({ page }) {
  async function visibleText(selector, text) {
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
  }
  await page.setViewportSize({ width: 420, height: 800 });
  await page.reload();
  await page.locator('.asset-card').first().waitFor();

  // 浏览器模式：面板可看，但不能插入或扫描。
  await page.evaluate(() => { delete window.Application; window.dispatchEvent(new Event('focus')); });
  await page.locator('#toggleBoxes').click();
  assert.equal(await page.locator('#boxPanel').isVisible(), true);
  assert.equal(await page.locator('#insertBox').isDisabled(), true, '浏览器模式不能插入占位框');
  assert.equal(await page.locator('#scanBoxes').isDisabled(), true);
  await visibleText('#boxCount', '尚未扫描');

  // 模拟 WPS：空段落，插入的占位图记录尺寸和替代文字。
  await page.evaluate(() => {
    const shapes = window.boxShapes = [];
    window.selectedBox = null;
    const paragraph = () => {
      const format = { Alignment: 0 };
      Object.defineProperty(format, 'Duplicate', { get() { return { ...format }; } });
      return { Style: '正文', Format: format, Range: { Start: 0, End: 1, Text: '\r', ListFormat: { RemoveNumbers() {} } } };
    };
    const makeRange = () => ({
      Start: 0, End: 0, StoryType: 1,
      PageSetup: { PageWidth: 600, LeftMargin: 60, RightMargin: 60, PageHeight: 842, TopMargin: 72, BottomMargin: 72 },
      Information: () => false,
      Collapse() {},
      Paragraphs: { Item: () => paragraph() },
      InlineShapes: { AddPicture(path) {
        const shape = {
          path, start: shapes.length, Width: 400, Height: 300, LockAspectRatio: 0, AlternativeText: '',
          get Range() {
            const name = shape.AlternativeText;
            return { Start: shape.start, Duplicate: { Collapse() {}, Select() {} }, Paragraphs: { Item: () => paragraph() },
              Select() { window.selectedBox = name; } };
          },
          Delete() { shapes.splice(shapes.indexOf(shape), 1); },
        };
        shapes.push(shape);
        return shape;
      } },
    });
    const doc = { Name: '占位框.docx', FullName: 'C:\\test\\占位框.docx', ReadOnly: false, ProtectionType: -1,
      get InlineShapes() { return { Count: shapes.length, Item: index => shapes[index - 1] }; } };
    window.Application = {
      Documents: { Count: 1 }, ActiveDocument: doc,
      CentimetersToPoints: value => value * 72 / 2.54,
      UndoRecord: { StartCustomRecord() {}, EndCustomRecord() {} },
      Selection: { get Range() { const range = makeRange(); range.Duplicate = makeRange(); return range; } },
    };
    window.dispatchEvent(new Event('focus'));
  });
  await page.locator('#scanBoxes').click();
  await visibleText('#boxCount', '还没有占位框');

  await page.locator('#insertBox').click();
  await visibleText('#boxError', '请填写框名');
  await page.locator('#boxName').fill('临时');
  await page.locator('#boxSize').selectOption('cell');
  await page.locator('#insertBox').click();
  await visibleText('#boxError', '不在表格');
  assert.equal(await page.evaluate(() => window.boxShapes.length), 0, '校验失败不写入文档');

  // Linux CI 上的服务路径不是 Windows 路径；记录真实文件后改成模拟宿主接受的路径。
  const generated = [];
  await page.route('**/api/placeholders', async route => {
    const response = await route.fetch();
    const data = await response.json();
    generated.push(data);
    await route.fulfill({ response, json: { ...data, path: `C:\\test\\box-${generated.length}.png` } });
  });
  await page.locator('#boxName').fill('脚手架搭设');
  await page.locator('#boxSize').selectOption('landscape');
  await page.locator('#insertBox').click();
  await visibleText('#actionStatus', '已插入占位框「脚手架搭设」12.0 × 9.0 厘米');
  const shapeAt = index => page.evaluate(i => {
    const { path, Width, Height, LockAspectRatio, AlternativeText } = window.boxShapes[i];
    return { path, Width, Height, LockAspectRatio, AlternativeText };
  }, index);
  let shape = await shapeAt(0);
  assert.deepEqual([shape.path, shape.Width, shape.Height, shape.LockAspectRatio], ['C:\\test\\box-1.png', 340.1, 255.1, -1]);
  assert.match(shape.AlternativeText, /^iPeiTu-box:1:/);
  const metadata = await sharp(generated[0].path).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height], ['png', 453, 340], '服务端生成的占位图按框的比例');
  await visibleText('#boxCount', '文档中 1 个占位框');

  await page.locator('#boxSize').selectOption('custom');
  assert.equal(await page.locator('#boxCustomSize').isVisible(), true);
  await page.locator('#boxName').fill('基础');
  await page.locator('#boxWidthCm').fill('6');
  await page.locator('#boxHeightCm').fill('4');
  await page.locator('#insertBox').click();
  await visibleText('#actionStatus', '已插入占位框「基础」6.0 × 4.0 厘米');
  shape = await shapeAt(1);
  assert.deepEqual([shape.Width, shape.Height], [170, 113.3]);
  await visibleText('#boxCount', '文档中 2 个占位框');
  assert.deepEqual(await page.locator('.box-name').allTextContents(), ['脚手架搭设', '基础']);

  await page.locator('.box-item').first().click();
  await visibleText('#actionStatus', '已定位到「脚手架搭设」');
  assert.match(await page.evaluate(() => window.selectedBox), /脚手架搭设/);
  await page.evaluate(() => { window.boxShapes[0].start = 99; window.selectedBox = null; });
  await page.locator('.box-item').first().click();
  await visibleText('#actionStatus', '文档已变化');
  assert.equal(await page.evaluate(() => window.selectedBox), null, '框移动后不选中旧位置');
  await page.locator('.box-item').first().click();
  await visibleText('#actionStatus', '已定位到「脚手架搭设」');

  for (const width of [320, 420]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px 占位框面板无横向溢出`);
    // 网格轨道可能被顶栏撑宽而不产生滚动条，直接检查最右侧控件。
    assert.equal(await page.evaluate(() => ['#toggleImport', '#openFilters', '#insertBox']
      .every(selector => document.querySelector(selector).getBoundingClientRect().right <= innerWidth)), true, `${width}px 顶栏与面板控件完整可见`);
  }
  await page.locator('#toggleImport').click();
  assert.equal(await page.locator('#boxPanel').isVisible(), false, '打开导入时收起占位框面板');
  await page.locator('#toggleImport').click();
  await page.unroute('**/api/placeholders');
  await page.reload();
  console.log('占位框 UI 验收通过：浏览器模式禁用、框名与尺寸校验、预设与自定义尺寸、服务端占位图、扫描列表、定位与文档变化后重新扫描、窄窗格布局。');
}
