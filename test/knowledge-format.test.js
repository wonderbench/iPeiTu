import test from 'node:test';
import assert from 'node:assert/strict';
import { formatForSave, isSnippetFormat, trimSnippetBody, updateSnippetFormat } from '../public/knowledge-format.js';
import { snippetParagraphs } from '../public/knowledge-bridge.js';

const HEI = { Name: '黑体', NameFarEast: '黑体', Size: 16, Bold: true };
const SONG = { Name: '宋体', Size: 12 };
const JUSTIFY = { Alignment: 3, CharacterUnitFirstLineIndent: 2, LineSpacingRule: 5, LineSpacing: 18 };
const CENTER = { Alignment: 1 };

test('accepts formatting that matches the body line by line', () => {
  const format = [
    { paragraph: CENTER, runs: [{ start: 2, end: 6, font: HEI }], heading: true },
    { paragraph: JUSTIFY, runs: [{ start: 0, end: 2, font: SONG }, { start: 2, end: 4, font: { Color: 0xff0000, Underline: 1, Italic: false } }] },
    { paragraph: {}, runs: [] },
  ];
  assert.equal(isSnippetFormat(format, '# 一、概述\n甲乙丙丁\n'), true);
});

test('rejects formatting that does not match the body or exceeds the supported fields', () => {
  const line = (paragraph, runs = [], extra = {}) => ({ paragraph, runs, ...extra });
  const cases = [
    ['正文不是字符串', [line(CENTER)], undefined],
    ['行数不符', [line(CENTER)], '甲\n乙'],
    ['全部为空格式', [line({}), line({})], '甲\n乙'],
    ['多余字段', [line(CENTER, [], { style: '标题 1' })], '甲'],
    ['heading 不是 true', [line(CENTER, [], { heading: 1 })], '甲'],
    ['未知段落属性', [line({ OutlineLevel: 1 })], '甲'],
    ['对齐超出范围', [line({ Alignment: 4 })], '甲'],
    ['两种首行缩进并存', [line({ FirstLineIndent: 21, CharacterUnitFirstLineIndent: 2 })], '甲'],
    ['固定行距缺少磅值', [line({ LineSpacingRule: 4 })], '甲'],
    ['单倍行距带磅值', [line({ LineSpacingRule: 0, LineSpacing: 12 })], '甲'],
    ['区间越过行尾', [line(CENTER, [{ start: 0, end: 2, font: SONG }])], '甲'],
    ['区间重叠', [line(CENTER, [{ start: 0, end: 2, font: SONG }, { start: 1, end: 3, font: SONG }])], '甲乙丙'],
    ['空区间', [line(CENTER, [{ start: 1, end: 1, font: SONG }])], '甲乙'],
    ['区间多余字段', [line(CENTER, [{ start: 0, end: 1, font: SONG, text: '甲' }])], '甲'],
    ['未知字体属性', [line(CENTER, [{ start: 0, end: 1, font: { Hidden: true } }])], '甲'],
    ['字号超出范围', [line(CENTER, [{ start: 0, end: 1, font: { Size: 200 } }])], '甲'],
    ['字体名含标记字符', [line(CENTER, [{ start: 0, end: 1, font: { Name: '<b>' } }])], '甲'],
    ['加粗不是布尔值', [line(CENTER, [{ start: 0, end: 1, font: { Bold: -1 } }])], '甲'],
    ['颜色超出范围', [line(CENTER, [{ start: 0, end: 1, font: { Color: -16777216 } }])], '甲'],
  ];
  for (const [reason, format, body] of cases) assert.equal(isSnippetFormat(format, body), false, reason);
  const many = Array.from({ length: 257 }, () => line(CENTER));
  assert.equal(isSnippetFormat(many, Array(257).fill('甲').join('\n')), false, '段落数超过上限');
  const runs = Array.from({ length: 513 }, (_, index) => ({ start: index, end: index + 1, font: SONG }));
  assert.equal(isSnippetFormat([line(CENTER, runs)], '甲'.repeat(513)), false, '区间数超过上限');
});

test('trims the body the same way it is saved', () => {
  assert.equal(trimSnippetBody('\n\n甲乙  \n\n丙\t\n\n'), '甲乙\n\n丙');
  assert.equal(trimSnippetBody('  \n甲'), '甲');
});

test('appending two characters keeps the font and paragraph settings through save and insertion', () => {
  const draft = { body: '甲乙', format: [{ paragraph: JUSTIFY, runs: [{ start: 0, end: 2, font: HEI }] }] };
  const edited = updateSnippetFormat(draft, '甲乙丙丁', { start: 2, end: 2 });
  assert.deepEqual(edited, { body: '甲乙丙丁', format: [{ paragraph: JUSTIFY, runs: [{ start: 0, end: 4, font: HEI }] }] }, '末尾输入沿用左侧字符的字体');
  const body = trimSnippetBody(edited.body);
  const saved = formatForSave(edited, body);
  assert.deepEqual(saved, [{ paragraph: JUSTIFY, runs: [{ start: 0, end: 4, font: HEI }] }]);
  assert.deepEqual(snippetParagraphs({ body, format: saved }), [
    { text: '甲乙丙丁', heading: null, format: { paragraph: JUSTIFY, runs: [{ start: 0, end: 4, font: HEI }] } },
  ], '重新插入时带上原字号和段落设置');
  assert.equal(updateSnippetFormat(edited, '甲乙丙丁'), edited, '正文未变时原样返回');
});

test('maps edits inside and between lines onto the original formatting', () => {
  const draft = {
    body: '甲乙\n丙',
    format: [{ paragraph: CENTER, runs: [{ start: 0, end: 2, font: HEI }] }, { paragraph: JUSTIFY, runs: [{ start: 0, end: 1, font: SONG }] }],
  };
  // 在第二段段首输入“新”并回车：新段沿用光标所在段的段落格式和字体。
  assert.deepEqual(updateSnippetFormat(draft, '甲乙\n新\n丙', { start: 3, end: 3 }).format, [
    { paragraph: CENTER, runs: [{ start: 0, end: 2, font: HEI }] },
    { paragraph: JUSTIFY, runs: [{ start: 0, end: 1, font: SONG }] },
    { paragraph: JUSTIFY, runs: [{ start: 0, end: 1, font: SONG }] },
  ]);
  // 选中“乙”替换为“二三”：替换文字沿用选区开头的字体。
  assert.deepEqual(updateSnippetFormat(draft, '甲二三\n丙', { start: 1, end: 2 }).format, [
    { paragraph: CENTER, runs: [{ start: 0, end: 3, font: HEI }] },
    { paragraph: JUSTIFY, runs: [{ start: 0, end: 1, font: SONG }] },
  ]);
  // 没有选区信息时按前后相同的文字推断改动位置。
  assert.deepEqual(updateSnippetFormat(draft, '甲\n丙').format, [
    { paragraph: CENTER, runs: [{ start: 0, end: 1, font: HEI }] },
    { paragraph: JUSTIFY, runs: [{ start: 0, end: 1, font: SONG }] },
  ]);
  // 删除换行合并两段：合并后的段落沿用前一段的段落格式，字体各自保留。
  assert.deepEqual(updateSnippetFormat(draft, '甲乙丙', { start: 2, end: 3 }).format, [
    { paragraph: CENTER, runs: [{ start: 0, end: 2, font: HEI }, { start: 2, end: 3, font: SONG }] },
  ]);
});

test('an empty line remembers the font for text typed into it later', () => {
  const draft = {
    body: '甲\n乙',
    format: [{ paragraph: CENTER, runs: [{ start: 0, end: 1, font: HEI }] }, { paragraph: JUSTIFY, runs: [{ start: 0, end: 1, font: SONG }] }],
  };
  const blank = updateSnippetFormat(draft, '甲\n\n乙', { start: 2, end: 2 });
  assert.equal(blank.body, '甲\n\n乙');
  assert.deepEqual(blank.format, [
    { paragraph: CENTER, runs: [{ start: 0, end: 1, font: HEI }] },
    { paragraph: JUSTIFY, runs: [] },
    { paragraph: JUSTIFY, runs: [{ start: 0, end: 1, font: SONG }] },
  ]);
  assert.equal(blank.emptyLineFonts.length, 2);
  assert.equal(blank.emptyLineFonts[1], SONG);
  const typed = updateSnippetFormat(blank, '甲\n丁\n乙', { start: 2, end: 2 });
  assert.deepEqual(typed, {
    body: '甲\n丁\n乙',
    format: [
      { paragraph: CENTER, runs: [{ start: 0, end: 1, font: HEI }] },
      { paragraph: JUSTIFY, runs: [{ start: 0, end: 1, font: SONG }] },
      { paragraph: JUSTIFY, runs: [{ start: 0, end: 1, font: SONG }] },
    ],
  });
});

test('cuts the saved format to the trimmed body and rejects what cannot be stored', () => {
  const draft = {
    body: '\n甲乙  \n丙',
    format: [
      { paragraph: {}, runs: [] },
      { paragraph: CENTER, runs: [{ start: 0, end: 4, font: HEI }], heading: true },
      { paragraph: {}, runs: [{ start: 0, end: 1, font: SONG }] },
    ],
  };
  const body = trimSnippetBody(draft.body);
  assert.equal(body, '甲乙\n丙');
  assert.deepEqual(formatForSave(draft, body), [
    { paragraph: CENTER, runs: [{ start: 0, end: 2, font: HEI }], heading: true },
    { paragraph: {}, runs: [{ start: 0, end: 1, font: SONG }] },
  ], '去掉首行空段，区间截到段末空白之前');
  assert.equal(formatForSave(draft, ''), undefined);
  const plain = { body: '甲', format: [{ paragraph: {}, runs: [] }] };
  assert.equal(formatForSave(plain, '甲'), undefined, '没有任何格式时不保存格式');
  const invalid = { body: '甲', format: [{ paragraph: {}, runs: [{ start: 0, end: 1, font: { Size: 500 } }] }] };
  assert.throws(() => formatForSave(invalid, '甲'), /片段格式超出支持范围，请拆成较短的片段保存/);
});
