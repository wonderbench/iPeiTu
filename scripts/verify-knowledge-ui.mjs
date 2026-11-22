import assert from 'node:assert/strict';

// 在页面中安装模拟 WPS：段落以 \r 结束，插入的分段符复制所在段落的格式。
// 段落格式写入记在每段不可枚举的 pf 上（分段时不随复制带走），字体写入记在 fontWrites。
function installHost({ paragraphs, outline = [], cursor, end = cursor, readOnly = false }) {
  const state = window.knowledgeState = {
    paragraphs: paragraphs.map((text, index) => ({ text, style: '标书正文', indent: 0, outline: outline[index] ?? 10 })),
    cursor, end, undo: [], fontWrites: [],
  };
  const startOf = paragraph => state.paragraphs.slice(0, state.paragraphs.indexOf(paragraph)).reduce((sum, item) => sum + item.text.length + 1, 0);
  const containing = position => state.paragraphs.find(paragraph => position <= startOf(paragraph) + paragraph.text.length) ?? state.paragraphs.at(-1);
  const within = (start, stop) => (start === stop ? [containing(start)]
    : state.paragraphs.filter(paragraph => startOf(paragraph) < stop && startOf(paragraph) + paragraph.text.length + 1 > start));
  const collection = items => ({ Count: items.length, Item: index => items[index - 1] });
  const fullText = () => state.paragraphs.map(paragraph => `${paragraph.text}\r`).join('');
  // 段落格式：Reset 清除直接格式；CharacterUnitFirstLineIndent 只写不读（与原有模拟一致，收录时读不到缩进）。
  const formatOf = paragraph => {
    if (!paragraph.pf) {
      const pf = {};
      Object.defineProperties(pf, {
        Reset: { value() { paragraph.indent = 0; for (const key of Object.keys(pf)) delete pf[key]; } },
        CharacterUnitFirstLineIndent: { set(value) { paragraph.indent = value; } },
      });
      Object.defineProperty(paragraph, 'pf', { value: pf, enumerable: false });
    }
    return paragraph.pf;
  };
  // 内置样式编号 -1 为正文，-2—-10 为标题 1—9；按名称设置样式后，标题 N 的大纲级别为 N。
  const styleName = id => (id === -1 ? '正文' : id <= -2 && id >= -10 ? `标题 ${-id - 1}` : undefined);
  const paragraphObject = paragraph => ({
    get Style() { return { NameLocal: paragraph.style }; },
    set Style(value) {
      paragraph.style = value;
      paragraph.outline = Number(/^标题 ([1-9])$/.exec(value)?.[1] ?? 10);
    },
    get OutlineLevel() { return paragraph.outline; },
    Range: {
      get Start() { return startOf(paragraph); },
      get End() { return startOf(paragraph) + paragraph.text.length + 1; },
      get Text() { return `${paragraph.text}\r`; },
      get ParagraphFormat() { return formatOf(paragraph); },
      Font: { Reset() {} },
      ListFormat: { RemoveNumbers() {} },
    },
  });
  const fontAt = (start, stop) => new Proxy({}, {
    set(target, key, value) {
      state.fontWrites.push({ start, stop, key: String(key), value });
      target[key] = value;
      return true;
    },
  });
  const doc = {
    Name: '投标文件.docx', ReadOnly: readOnly, ProtectionType: -1,
    Styles: { Item: id => (styleName(id) ? { NameLocal: styleName(id) } : undefined) },
    Range: (start, stop) => ({
      get Paragraphs() { return collection(within(start, stop).map(paragraphObject)); },
      get Text() { return fullText().slice(start, stop); },
      get Font() { return fontAt(start, stop); },
      Select() { state.cursor = start; state.end = stop; },
    }),
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

const readHost = page => page.evaluate(() => {
  const { paragraphs, undo, fontWrites } = window.knowledgeState;
  return {
    undo, fontWrites,
    paragraphs: paragraphs.map(({ text, style, indent, pf }) => ({ text, style, indent, format: pf ? { ...pf } : {} })),
  };
});

const helpers = page => ({
  visibleText: (selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text }),
  card: title => page.locator('.snippet-item', { hasText: title }),
});

async function createSnippet(base, snippet) {
  const response = await fetch(`${base}/api/knowledge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [], type: '通用措施', section: '验收章节', ...snippet }),
  });
  assert.equal(response.status, 201, `预置片段「${snippet.title}」`);
  return (await response.json()).snippet;
}

export async function verifyKnowledge({ page, base, choose }) {
  const { visibleText, card } = helpers(page);
  const cards = page.locator('.snippet-card');
  async function fillEditor({ title, type, section, tags = '', body }) {
    await page.locator('#snippetTitle').fill(title);
    if (type) await choose(page, 'snippetType', type);
    await page.locator('#snippetSection').fill(section);
    await page.locator('#snippetTags').fill(tags);
    await page.locator('#snippetBody').fill(body);
    await page.locator('#saveSnippet').click();
  }

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${base}/knowledge.html`);
  await visibleText('#stateTitle', '知识库还没有片段');
  assert.equal(await page.locator('#typeChips button').count(), 5, '全部加四类工程');
  // 每段使用新的浏览器上下文，没有模拟宿主，即浏览器模式。
  await visibleText('#hostStatus', '浏览器模式');
  assert.equal(await page.locator('#captureSelection').isDisabled(), true, '浏览器模式不能收录');
  assert.equal(await page.locator('#includeTitle').count(), 0, '“插入片段标题”选项已取消，插入只写正文');

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

  // 章节输入框的联想菜单：输入时列出该类别的章节，点选写入输入框。
  await page.locator('#newSnippet').click();
  await choose(page, 'snippetType', '市政道路管网');
  await page.locator('#snippetSection').fill('');
  // 章节联想是原生 datalist，浏览器的候选弹层无法在自动化中点选；这里断言候选内容随类别切换，再输入完整章节。
  const sectionOptions = () => page.locator('#sectionOptions option').evaluateAll(options => options.map(option => option.value));
  assert.equal(await page.locator('#snippetSection').getAttribute('list'), 'sectionOptions', '章节输入框绑定联想列表');
  const roadSections = await sectionOptions();
  assert.ok(roadSections.length > 0, '该类别有章节候选');
  assert.ok(roadSections.includes('交通导改'), '候选包含该类别的章节');
  assert.equal(roadSections.includes('混凝土工程'), false, '候选不含其他类别的章节');
  await choose(page, 'snippetType', '房建施工');
  assert.ok((await sectionOptions()).includes('混凝土工程'), '切换类别后候选随之更换');
  await choose(page, 'snippetType', '市政道路管网');
  assert.ok((await sectionOptions()).includes('交通导改'), '切换回来后候选恢复');
  await page.locator('#snippetSection').fill('交通导改');
  await fillEditor({ title: '交通导改方案', section: '交通导改', body: '设置围挡与警示标志。' });
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

  // 模拟 WPS：光标在空段落，小标题从标题 2 开始；片段标题不写入文档。
  await page.evaluate(installHost, { paragraphs: ['前文', '', '后文'], cursor: 3 });
  await visibleText('#hostStatus', '插入到：投标文件.docx');
  await choose(page, 'baseLevel', '标题 2');
  await card('混凝土浇筑').locator('.card-add').click();
  await visibleText('#actionStatus', '已插入「混凝土浇筑」：4 段，其中小标题 2 段');
  let state = await readHost(page);
  assert.deepEqual(state.paragraphs.map(item => item.text), ['前文', '施工准备', '检查模板。', '浇筑', '分层浇筑。', '后文']);
  assert.deepEqual(state.paragraphs.map(item => item.style), ['标书正文', '标题 2', '正文', '标题 2', '正文', '标书正文']);
  assert.deepEqual(state.paragraphs.map(item => item.indent), [0, 0, 2, 0, 2, 0]);
  assert.deepEqual(state.undo, ['iPeiTu 插入知识库片段']);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ipeitu.knowledge.v1'))), { baseLevel: 2 });

  // 键盘：Enter 只选中卡片，不写入文档；只有当前卡片在 Tab 顺序中。
  await card('交通导改方案').locator('.snippet-card').focus();
  await page.keyboard.press('Enter');
  await visibleText('#previewTitle', '交通导改方案');
  assert.equal((await readHost(page)).undo.length, 1, 'Enter 不插入');
  await page.keyboard.press(' ');
  assert.equal((await readHost(page)).undo.length, 1, '空格不插入');
  assert.equal(await page.locator('.snippet-card[tabindex="0"]').count(), 1);
  assert.equal(await page.locator('.card-add[tabindex="0"]').count(), 1);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.snippet-item')?.textContent.includes('混凝土浇筑')), true, '方向键移动焦点');

  // 收录选中内容：按大纲级别生成小标题。
  await page.evaluate(installHost, {
    paragraphs: ['三、质量保证措施', '（一）组织保证', '成立质量管理小组。'], outline: [2, 3, 10], cursor: 0, end: 27, readOnly: true,
  });
  await page.locator('#captureSelection').click();
  await visibleText('#actionStatus', '已读取 3 段，其中小标题 2 段');
  assert.equal(await page.locator('#snippetTitle').inputValue(), '三、质量保证措施');
  assert.equal(await page.locator('#snippetBody').inputValue(), '# 三、质量保证措施\n## （一）组织保证\n成立质量管理小组。');
  await choose(page, 'snippetType', '通用措施');
  await page.locator('#snippetSection').fill('质量保证措施');
  await page.locator('#saveSnippet').click();
  await visibleText('#actionStatus', '已保存「三、质量保证措施」');
  await visibleText('#hostStatus', '只读');
  assert.equal(await page.locator('.card-add:not(:disabled)').count(), 0, '只读文档禁用插入');
  assert.match(await page.locator('.card-add').first().getAttribute('title'), /只读/);

  // 收录只取实际选区：选区从标题段中间开始、在正文段中间结束时，首尾段落截取所选文字，截取的标题不当作标题。
  await page.evaluate(installHost, {
    paragraphs: ['（二）技术保证', '编制专项方案并交底。'], outline: [3, 10], cursor: 3, end: 14,
  });
  await page.locator('#captureSelection').click();
  await visibleText('#actionStatus', '已读取 2 段');
  assert.equal(await page.locator('#snippetBody').inputValue(), '技术保证\n编制专项方案', '首尾段落按选区截取');
  await page.locator('#cancelSnippet').click();

  // 编辑（先取得编辑锁）、移到回收站与恢复。
  await card('交通导改方案').locator('.snippet-card').click();
  await page.locator('#editSnippet').click();
  await page.locator('#snippetDialog').waitFor({ state: 'visible' });
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
  console.log('知识库 UI 验收通过：新建与必填校验、类别菜单与章节联想、检索、类别与章节筛选、模拟 WPS 插入的标题层级与首行缩进（不写片段标题）、撤销记录、插入设置记忆、键盘不误插入、收录选中内容与按选区截取、只读禁用、编辑锁下的编辑、回收站与恢复、320/420/1080 布局。');
}

// 从 Word / WPS 粘贴带格式的段落：记录段落与局部字体格式，编辑后保留，保存后预览并按原格式插入。
export async function verifyKnowledgePaste({ page, base, choose }) {
  const { visibleText, card } = helpers(page);
  const paste = (selector, html, plain) => page.evaluate(({ selector, html, plain }) => {
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', plain);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector(selector).dispatchEvent(event);
    return event.defaultPrevented;
  }, { selector, html, plain });
  const html = '<html><head><style>p.MsoNormal { font-family: 宋体; font-size: 12pt; }</style></head><body><!--StartFragment-->'
    + '<p class="MsoNormal" style="text-align:center;line-height:150%">第一段<b>加粗</b>文字</p>'
    + '<p class="MsoNormal" style="text-indent:2em">第二段</p><!--EndFragment--></body></html>';
  const plain = '第一段加粗文字\r\n第二段';

  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`${base}/knowledge.html`);
  await visibleText('#stateTitle', '知识库还没有片段');
  await page.locator('#newSnippet').click();
  await page.locator('#snippetDialog').waitFor({ state: 'visible' });

  // 正文已有文字且未全选时，不改为带格式粘贴。
  await page.locator('#snippetBody').fill('已有文字');
  await page.locator('#snippetBody').evaluate(body => body.setSelectionRange(body.value.length, body.value.length));
  assert.equal(await paste('#snippetBody', html, plain), false, '未全选正文时交给原生纯文字粘贴');
  await visibleText('#snippetFormatStatus', '请选中全部正文后重新粘贴');
  await page.locator('#snippetBody').fill('');

  assert.equal(await paste('#snippetBody', html, plain), true, '全选或空正文时按带格式内容粘贴');
  await visibleText('#snippetFormatStatus', '已记录原格式');
  assert.equal(await page.locator('#snippetBody').inputValue(), '第一段加粗文字\n第二段', '按段落拆成两行');
  // 在末尾追加两个字：新文字沿用左侧字符的格式。
  await page.locator('#snippetBody').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('补充');
  await visibleText('#snippetFormatStatus', '编辑时保留原格式');
  await page.locator('#snippetTitle').fill('粘贴片段');
  await choose(page, 'snippetType', '通用措施');
  await page.locator('#snippetSection').fill('格式验收');
  await page.locator('#saveSnippet').click();
  await visibleText('#actionStatus', '已保存「粘贴片段」');

  const [saved] = (await (await fetch(`${base}/api/knowledge`)).json()).snippets;
  assert.equal(saved.body, '第一段加粗文字\n第二段补充');
  assert.equal(saved.format.length, 2, '每段一条格式记录');
  assert.deepEqual(saved.format[0].paragraph, { Alignment: 1, LineSpacingRule: 5, LineSpacing: 18 }, '居中与 1.5 倍行距');
  assert.deepEqual(saved.format[1].paragraph, { CharacterUnitFirstLineIndent: 2 }, '首行缩进 2 字符');
  const bold = saved.format[0].runs.find(run => run.font.Bold);
  assert.deepEqual([bold?.start, bold?.end], [3, 5], '局部加粗只覆盖「加粗」两字');
  assert.equal(bold.font.Size, 12, '字号来自段落样式');
  assert.equal(bold.font.NameFarEast, '宋体');
  const second = saved.format[1].runs;
  assert.deepEqual([second[0]?.start, second.at(-1)?.end], [0, 5], '追加的文字沿用原有字体格式');

  // 预览按格式显示。
  await card('粘贴片段').locator('.snippet-card').click();
  assert.equal(await page.locator('#previewBody .snippet-formatted-paragraph').count(), 2);
  assert.equal(await page.locator('#previewBody .snippet-formatted-paragraph').first().evaluate(item => item.style.textAlign), 'center');
  assert.equal(await page.locator('#previewBody span', { hasText: '加粗' }).first().evaluate(span => span.style.fontWeight), 'bold');

  // 插入：写入保存的段落格式与字体，带格式的正文不再追加默认首行缩进。
  await page.evaluate(installHost, { paragraphs: ['前文', '', '后文'], cursor: 3 });
  await visibleText('#hostStatus', '插入到：投标文件.docx');
  await card('粘贴片段').locator('.card-add').click();
  await visibleText('#actionStatus', '已插入「粘贴片段」：2 段');
  const state = await readHost(page);
  assert.deepEqual(state.paragraphs.map(item => item.text), ['前文', '第一段加粗文字', '第二段补充', '后文']);
  assert.deepEqual(state.paragraphs.map(item => item.style), ['标书正文', '正文', '正文', '标书正文']);
  assert.deepEqual(state.paragraphs[1].format, { Alignment: 1, LineSpacingRule: 5, LineSpacing: 18 });
  assert.deepEqual(state.paragraphs.map(item => item.indent), [0, 0, 2, 0], '第二段写入保存的 2 字符缩进');
  const start = 3; // 「前文」与段落标记之后
  const boldWrite = state.fontWrites.find(write => write.key === 'Bold' && write.value === -1);
  assert.deepEqual([boldWrite?.start, boldWrite?.stop], [start + 3, start + 5], '加粗写在原来的两个字上');
  assert.ok(state.fontWrites.some(write => write.key === 'Size' && write.value === 12), '写入字号');
  assert.ok(state.fontWrites.some(write => write.key === 'NameFarEast' && write.value === '宋体'), '写入中文字体');
  assert.ok(!state.fontWrites.some(write => write.key === 'Bold' && write.value === -1 && write.start !== start + 3), '其余文字不加粗');
  console.log('知识库粘贴 UI 验收通过：未全选时不拦截、带格式粘贴分段、居中/行距/缩进/局部加粗/字号的记录、编辑追加沿用格式、保存与预览、按原格式插入模拟 WPS。');
}

// 知识库回收站：单个永久删除、多选永久删除、清空；确认期间回收站内容变化时不执行。
export async function verifyKnowledgePurge({ page, base }) {
  const { visibleText, card } = helpers(page);
  const snippets = [];
  for (const title of ['回收片段一', '回收片段二', '回收片段三', '回收片段四']) {
    snippets.push(await createSnippet(base, { title, body: `${title}的正文。` }));
  }
  const trash = id => fetch(`${base}/api/knowledge/${id}/trash`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"trashed":true}' });
  for (const snippet of snippets.slice(0, 3)) assert.equal((await trash(snippet.id)).status, 200);
  const trashed = async () => (await (await fetch(`${base}/api/knowledge?view=trash`)).json()).snippets.map(item => item.title).sort();
  const dialog = page.locator('#knowledgePurgeDialog');

  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`${base}/knowledge.html`);
  await visibleText('#resultCount', '1 段');
  await page.locator('#viewTrash').click();
  await visibleText('#resultCount', '3 段');
  assert.equal(await page.locator('#knowledgeTrashTools').isVisible(), true);

  await card('回收片段一').locator('.snippet-card').click();
  await page.locator('#purgeSnippet').click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#knowledgePurgeTitle').textContent(), '永久删除片段');
  assert.match(await page.locator('#knowledgePurgeDescription').textContent(), /永久删除「回收片段一」？删除后无法恢复/);
  await page.locator('#cancelKnowledgePurge').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await trashed()).length, 3, '取消不删除');
  await page.locator('#purgeSnippet').click();
  await page.locator('#confirmKnowledgePurge').click();
  await visibleText('#actionStatus', '已永久删除 1 个片段');
  await visibleText('#resultCount', '2 段');

  // Ctrl 点击进入多选；确认期间又有片段移入回收站时，服务拒绝，弹窗关闭并提示重新确认。
  await card('回收片段二').locator('.snippet-card').click({ modifiers: ['Control'] });
  await visibleText('#knowledgeTrashCount', '已选 1 段');
  await card('回收片段三').locator('.snippet-card').click();
  await visibleText('#knowledgeTrashCount', '已选 2 段');
  await page.locator('#purgeTrashSelection').click();
  await dialog.waitFor({ state: 'visible' });
  assert.match(await page.locator('#knowledgePurgeDescription').textContent(), /2 个所选片段/);
  assert.equal((await trash(snippets[3].id)).status, 200);
  await page.locator('#confirmKnowledgePurge').click();
  await visibleText('#actionStatus', '回收站内容已变化');
  await dialog.waitFor({ state: 'hidden' });
  await visibleText('#resultCount', '3 段');
  assert.deepEqual(await trashed(), ['回收片段三', '回收片段二', '回收片段四'].sort(), '内容变化后不删除');

  await page.locator('#clearKnowledgeTrash').click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#knowledgePurgeTitle').textContent(), '清空回收站');
  assert.match(await page.locator('#knowledgePurgeDescription').textContent(), /全部 3 个片段/);
  await page.locator('#confirmKnowledgePurge').click();
  await visibleText('#actionStatus', '已永久删除 3 个片段');
  await visibleText('#stateTitle', '回收站为空');
  assert.deepEqual(await trashed(), []);
  console.log('知识库回收站 UI 验收通过：单个永久删除的确认与取消、Ctrl 多选、确认期间内容变化需重新确认、清空回收站。');
}

export { createSnippet };
