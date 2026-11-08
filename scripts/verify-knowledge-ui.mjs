import assert from 'node:assert/strict';

// 在页面中安装模拟 WPS：段落以 \r 结束，插入的分段符复制所在段落的格式。
function installHost({ paragraphs, outline = [], cursor, end = cursor, readOnly = false }) {
  const state = window.knowledgeState = {
    paragraphs: paragraphs.map((text, index) => ({ text, style: '标书正文', indent: 0, outline: outline[index] ?? 10 })),
    cursor, end, undo: [],
  };
  const startOf = paragraph => state.paragraphs.slice(0, state.paragraphs.indexOf(paragraph)).reduce((sum, item) => sum + item.text.length + 1, 0);
  const containing = position => state.paragraphs.find(paragraph => position <= startOf(paragraph) + paragraph.text.length) ?? state.paragraphs.at(-1);
  const within = (start, stop) => (start === stop ? [containing(start)]
    : state.paragraphs.filter(paragraph => startOf(paragraph) < stop && startOf(paragraph) + paragraph.text.length + 1 > start));
  const collection = items => ({ Count: items.length, Item: index => items[index - 1] });
  const paragraphObject = paragraph => ({
    get Style() { return paragraph.style; },
    set Style(value) { paragraph.style = value; },
    OutlineLevel: paragraph.outline,
    Range: {
      get Start() { return startOf(paragraph); },
      get Text() { return `${paragraph.text}\r`; },
      ParagraphFormat: { Reset() { paragraph.indent = 0; }, set CharacterUnitFirstLineIndent(value) { paragraph.indent = value; } },
      Font: { Reset() {} },
      ListFormat: { RemoveNumbers() {} },
    },
  });
  const doc = {
    Name: '投标文件.docx', ReadOnly: readOnly, ProtectionType: -1,
    Range: (start, stop) => ({ get Paragraphs() { return collection(within(start, stop).map(paragraphObject)); }, Select() { state.cursor = start; state.end = stop; } }),
  };
  window.Application = {
    Documents: { Count: 1 }, ActiveDocument: doc,
    Selection: {
      get Range() {
        return {
          Start: state.cursor, End: state.end, StoryType: 1, Information: () => false,
          get Paragraphs() { return collection(within(state.cursor, state.end).map(paragraphObject)); },
          Duplicate: {
            InsertAfter(text) {
              const paragraph = containing(state.cursor);
              const offset = state.cursor - startOf(paragraph);
              const parts = `${paragraph.text.slice(0, offset)}${text}${paragraph.text.slice(offset)}`.split('\r');
              state.paragraphs.splice(state.paragraphs.indexOf(paragraph), 1, ...parts.map(part => ({ ...paragraph, text: part })));
            },
          },
        };
      },
    },
    UndoRecord: { StartCustomRecord(name) { state.undo.push(name); }, EndCustomRecord() {} },
  };
  window.dispatchEvent(new Event('focus'));
}

export async function verifyKnowledge({ page, base }) {
  async function visibleText(selector, text) {
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
  }
  const cards = page.locator('.snippet-card');
  const card = title => page.locator('.snippet-item', { hasText: title });
  async function fillEditor({ title, type, section, tags = '', body }) {
    await page.locator('#snippetTitle').fill(title);
    if (type) await page.locator('#snippetType').selectOption(type);
    await page.locator('#snippetSection').fill(section);
    await page.locator('#snippetTags').fill(tags);
    await page.locator('#snippetBody').fill(body);
    await page.locator('#saveSnippet').click();
  }

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${base}/knowledge.html`);
  await visibleText('#stateTitle', '知识库还没有片段');
  assert.equal(await page.locator('#typeChips button').count(), 5, '全部加四类工程');
  // 主验收脚本的初始化脚本会在每个页面装上模拟宿主；先移除以检查浏览器模式。
  await page.evaluate(() => { delete window.Application; window.dispatchEvent(new Event('focus')); });
  await visibleText('#hostStatus', '浏览器模式');
  assert.equal(await page.locator('#captureSelection').isDisabled(), true, '浏览器模式不能收录');

  // 新建：必填校验在对话框内提示，不发请求。
  await page.locator('#stateAction').click();
  assert.equal(await page.locator('#snippetDialog').isVisible(), true);
  assert.equal(await page.locator('#snippetType option').count(), 4);
  await fillEditor({ title: '', section: '混凝土工程', body: '正文' });
  await visibleText('#snippetError', '请填写标题');
  await fillEditor({ title: '混凝土浇筑', type: '房建施工', section: '混凝土工程', tags: '浇筑，振捣', body: '# 施工准备\n检查模板。\n# 浇筑\n分层浇筑。' });
  await visibleText('#actionStatus', '已保存「混凝土浇筑」');
  assert.equal(await page.locator('#snippetDialog').isVisible(), false);
  await visibleText('#previewTitle', '混凝土浇筑');
  await visibleText('#previewMeta', '房建施工 · 混凝土工程 · 浇筑 · 振捣');
  assert.equal(await page.locator('#previewBody .snippet-heading').count(), 2);
  assert.equal(await page.locator('.card-add').isDisabled(), true, '浏览器模式禁止插入');
  assert.match(await page.locator('.card-add').getAttribute('title'), /浏览器模式/);

  await page.locator('#newSnippet').click();
  await fillEditor({ title: '交通导改方案', type: '市政道路管网', section: '交通导改', body: '设置围挡与警示标志。' });
  await visibleText('#resultCount', '2 段');

  // 检索与分类筛选。
  await page.locator('#searchInput').fill('围挡');
  await visibleText('#resultCount', '1 / 2 段');
  assert.equal(await cards.count(), 1);
  await page.locator('#clearSearch').click();
  await visibleText('#resultCount', '2 段');
  await page.locator('#typeChips button', { hasText: '房建施工' }).click();
  await visibleText('#resultCount', '1 / 2 段');
  assert.equal(await page.locator('#sectionChips').isVisible(), true);
  await visibleText('#sectionChips', '混凝土工程1');
  await page.locator('#sectionChips button', { hasText: '模板工程' }).click();
  await visibleText('#stateTitle', '此分类暂无片段');
  await page.locator('#sectionChips button', { hasText: '全部章节' }).click();
  await visibleText('#resultCount', '1 / 2 段');
  await page.locator('#typeChips button', { hasText: '全部' }).first().click();
  await visibleText('#resultCount', '2 段');

  // 模拟 WPS：光标在空段落，小标题从标题 2 开始并插入片段标题。
  await page.evaluate(installHost, { paragraphs: ['前文', '', '后文'], cursor: 3 });
  await visibleText('#hostStatus', '插入到：投标文件.docx');
  await page.locator('#baseLevel').selectOption('2');
  await page.locator('#includeTitle').check();
  await card('混凝土浇筑').locator('.card-add').click();
  await visibleText('#actionStatus', '已插入「混凝土浇筑」：5 段，其中小标题 3 段');
  let state = await page.evaluate(() => window.knowledgeState);
  assert.deepEqual(state.paragraphs.map(item => item.text), ['前文', '混凝土浇筑', '施工准备', '检查模板。', '浇筑', '分层浇筑。', '后文']);
  assert.deepEqual(state.paragraphs.map(item => item.style), ['标书正文', -3, -4, -1, -4, -1, '标书正文']);
  assert.deepEqual(state.paragraphs.map(item => item.indent), [0, 0, 0, 2, 0, 2, 0]);
  assert.deepEqual(state.undo, ['iPeiTu 插入知识库片段']);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ipeitu.knowledge.v1'))), { baseLevel: 2, includeTitle: true });

  // 键盘：Enter 只选中卡片，不写入文档；只有当前卡片在 Tab 顺序中。
  await card('交通导改方案').locator('.snippet-card').focus();
  await page.keyboard.press('Enter');
  await visibleText('#previewTitle', '交通导改方案');
  assert.equal((await page.evaluate(() => window.knowledgeState.undo)).length, 1, 'Enter 不插入');
  assert.equal(await page.locator('.snippet-card[tabindex="0"]').count(), 1);
  assert.equal(await page.locator('.card-add[tabindex="0"]').count(), 1);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.snippet-item')?.textContent.includes('混凝土浇筑')), true, '方向键移动焦点');

  // 收录选中内容：按大纲级别生成小标题。
  await page.evaluate(installHost, {
    paragraphs: ['三、质量保证措施', '（一）组织保证', '成立质量管理小组。'], outline: [2, 3, 10], cursor: 0, end: 30, readOnly: true,
  });
  await page.locator('#captureSelection').click();
  await visibleText('#actionStatus', '已读取 3 段，其中小标题 2 段');
  assert.equal(await page.locator('#snippetTitle').inputValue(), '三、质量保证措施');
  assert.equal(await page.locator('#snippetBody').inputValue(), '# 三、质量保证措施\n## （一）组织保证\n成立质量管理小组。');
  await page.locator('#snippetType').selectOption('通用措施');
  await page.locator('#snippetSection').fill('质量保证措施');
  await page.locator('#saveSnippet').click();
  await visibleText('#actionStatus', '已保存「三、质量保证措施」');
  await visibleText('#hostStatus', '只读');
  assert.equal(await page.locator('.card-add:not(:disabled)').count(), 0, '只读文档禁用插入');
  assert.match(await page.locator('.card-add').first().getAttribute('title'), /只读/);

  // 编辑、移到回收站与恢复。
  await card('交通导改方案').locator('.snippet-card').click();
  await page.locator('#editSnippet').click();
  assert.equal(await page.locator('#snippetDialogTitle').textContent(), '编辑片段');
  await page.locator('#snippetSection').fill('临时交通');
  await page.locator('#saveSnippet').click();
  await visibleText('#previewMeta', '市政道路管网 · 临时交通');
  await page.locator('#trashSnippet').click();
  await visibleText('#actionStatus', '已将「交通导改方案」移到回收站');
  await visibleText('#resultCount', '2 段');
  await page.locator('#viewTrash').click();
  await visibleText('#resultCount', '1 段');
  assert.equal(await page.locator('.card-add').count(), 0, '回收站不显示插入按钮');
  await cards.first().click();
  assert.equal(await page.locator('#restoreSnippet').isVisible(), true);
  assert.equal(await page.locator('#editSnippet').isVisible(), false);
  await page.locator('#restoreSnippet').click();
  await visibleText('#actionStatus', '已恢复「交通导改方案」');
  await visibleText('#stateTitle', '回收站为空');
  await page.locator('#viewAll').click();
  await visibleText('#resultCount', '3 段');

  const listing = await (await fetch(`${base}/api/knowledge`)).json();
  assert.deepEqual(listing.snippets.map(item => item.title).sort(), ['三、质量保证措施', '交通导改方案', '混凝土浇筑'].sort());

  for (const width of [320, 420, 1080]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
      && [...document.querySelectorAll('.card-add, #captureSelection, #newSnippet')].every(item => item.getBoundingClientRect().right <= innerWidth)), true, `${width}px 知识库无横向溢出`);
  }
  console.log('知识库 UI 验收通过：新建与必填校验、检索、类别与章节筛选、模拟 WPS 插入的标题层级与首行缩进、撤销记录、插入设置记忆、键盘不误插入、收录选中内容、只读禁用、编辑、回收站与恢复、320/420/1080 布局。');
}
