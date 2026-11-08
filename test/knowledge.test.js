import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Knowledge, KNOWLEDGE_CATEGORIES, MAX_SNIPPETS } from '../server/knowledge.js';

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-knowledge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const input = (extra = {}) => ({
  title: '混凝土浇筑', type: '房建施工', section: '混凝土工程', tags: ['浇筑'], body: '# 施工准备\n检查模板。', ...extra,
});
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

test('knowledge categories cover the four engineering types without preset text', () => {
  assert.deepEqual(KNOWLEDGE_CATEGORIES.map(category => category.type), ['房建施工', '市政道路管网', '信息化/弱电', '通用措施']);
  assert.ok(KNOWLEDGE_CATEGORIES.every(category => category.sections.length > 0 && new Set(category.sections).size === category.sections.length));
  assert.ok(Object.isFrozen(KNOWLEDGE_CATEGORIES) && Object.isFrozen(KNOWLEDGE_CATEGORIES[0].sections));
});

test('creates, edits, searches, filters and persists snippets across restart', async t => {
  const directory = await temporary(t);
  const knowledge = await Knowledge.open(directory);
  const empty = knowledge.list();
  assert.deepEqual([empty.snippets.length, empty.total, empty.viewTotal], [0, 0, 0]);
  await assert.rejects(readFile(path.join(directory, 'knowledge.json')), { code: 'ENOENT' }, '打开空知识库不写文件');

  const created = await knowledge.create(input({
    title: '  混凝土浇筑  ', tags: ['浇筑', 'ＡＢ', 'ab', '浇筑'], body: '\n  第一段  \n\n\n第二段\n',
  }));
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.title, '混凝土浇筑');
  assert.deepEqual(created.tags, ['浇筑', 'ＡＢ'], '标签按全半角与大小写去重');
  assert.equal(created.body, '  第一段\n\n\n第二段', '去掉行尾空白与首尾空行，保留段落');
  assert.equal(created.trashedAt, null);
  await pause();
  const road = await knowledge.create(input({ title: '交通导改方案', type: '市政道路管网', section: '交通导改', tags: [], body: '设置围挡与警示标志。' }));

  assert.equal(knowledge.list({ q: 'ab' }).snippets[0].id, created.id, '半角检索匹配全角标签');
  assert.equal(knowledge.list({ q: '围挡' }).snippets[0].id, road.id, '检索正文');
  assert.equal(knowledge.list({ q: '交通导改' }).snippets.length, 1, '检索章节与标题');
  assert.equal(knowledge.list({ q: '浇筑 第二段' }).snippets.length, 1, '多个关键词同时满足');
  assert.equal(knowledge.list({ q: '浇筑 围挡' }).snippets.length, 0);
  assert.deepEqual(knowledge.list().snippets.map(snippet => snippet.id), [road.id, created.id], '最近修改的在前');

  const building = knowledge.list({ type: '房建施工' });
  assert.deepEqual(building.snippets.map(snippet => snippet.id), [created.id]);
  assert.deepEqual(building.facets.types, { 房建施工: 1, 市政道路管网: 1, '信息化/弱电': 0, 通用措施: 0 }, '类别数量不受类别筛选影响');
  assert.deepEqual(building.facets.sections, [{ type: '房建施工', section: '混凝土工程', count: 1 }]);
  assert.equal(knowledge.list({ type: '房建施工', section: '模板工程' }).snippets.length, 0);
  assert.equal(knowledge.list({ q: '围挡' }).facets.types.房建施工, 0, '数量随检索变化');

  await pause();
  const updated = await knowledge.update(created.id, { section: '大体积混凝土', tags: [] });
  assert.equal(updated.section, '大体积混凝土', '章节可以不在建议列表中');
  assert.equal(updated.title, '混凝土浇筑');
  assert.deepEqual(updated.tags, []);
  assert.equal(updated.createdAt, created.createdAt);
  assert.ok(updated.updatedAt > created.updatedAt);
  assert.equal(knowledge.list().snippets[0].id, created.id);

  const reopened = await Knowledge.open(directory);
  assert.deepEqual(reopened.snippets, knowledge.snippets);
  const saved = JSON.parse(await readFile(path.join(directory, 'knowledge.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.snippets.length, 2);
});

test('trash hides snippets, blocks edits and restores them', async t => {
  const knowledge = await Knowledge.open(await temporary(t));
  const snippet = await knowledge.create(input());
  for (const bad of [null, [], {}, { trashed: 1 }, { trashed: true, extra: true }]) {
    await assert.rejects(knowledge.setTrash(snippet.id, bad), { status: 400 });
  }
  const trashed = await knowledge.setTrash(snippet.id, { trashed: true });
  assert.ok(trashed.trashedAt);
  assert.equal((await knowledge.setTrash(snippet.id, { trashed: true })).trashedAt, trashed.trashedAt, '重复移入不改时间');
  const active = knowledge.list();
  assert.deepEqual([active.snippets.length, active.total, active.viewTotal], [0, 0, 0]);
  const trash = knowledge.list({ view: 'trash' });
  assert.deepEqual([trash.snippets.length, trash.total, trash.viewTotal], [1, 0, 1]);
  await assert.rejects(knowledge.update(snippet.id, { title: '不保存' }), { status: 410 });
  assert.equal((await knowledge.setTrash(snippet.id, { trashed: false })).trashedAt, null);
  assert.equal(knowledge.list().total, 1);
});

test('rejects invalid snippets, updates and queries without writing', async t => {
  const directory = await temporary(t);
  const knowledge = await Knowledge.open(directory);
  const separator = String.fromCharCode(0x2028);
  const invalid = [
    null, [], {}, '文字', input({ extra: 1 }), { title: 'a', type: '房建施工', section: 'b', tags: [] },
    input({ title: '' }), input({ title: '   ' }), input({ title: 'a'.repeat(101) }), input({ title: '换\n行' }), input({ title: `分${separator}隔` }),
    input({ title: 1 }), input({ type: '未知类别' }), input({ section: '' }), input({ section: 'a'.repeat(31) }),
    input({ tags: '浇筑' }), input({ tags: Array.from({ length: 33 }, (_, index) => `t${index}`) }), input({ tags: ['a'.repeat(33)] }),
    input({ tags: [''] }), input({ tags: [1] }), input({ body: ' \n  \n' }), input({ body: 'a'.repeat(20001) }),
    input({ body: '含\r回车' }), input({ body: '含\t制表' }), input({ body: `含${separator}分隔` }), input({ body: 1 }),
  ];
  for (const bad of invalid) await assert.rejects(knowledge.create(bad), { status: 400 }, JSON.stringify(bad));
  await assert.rejects(readFile(path.join(directory, 'knowledge.json')), { code: 'ENOENT' }, '校验失败不写文件');

  const snippet = await knowledge.create(input({ body: 'a'.repeat(20000) }));
  for (const bad of [{}, { id: snippet.id }, { title: '' }, { trashedAt: null }, null]) {
    await assert.rejects(knowledge.update(snippet.id, bad), { status: 400 });
  }
  await assert.rejects(knowledge.update('not-an-id', { title: 'x' }), { status: 404 });
  await assert.rejects(knowledge.update('00000000-0000-4000-8000-000000000000', { title: 'x' }), { status: 404 });
  assert.equal(knowledge.snippets[0].title, '混凝土浇筑');

  for (const query of [{ view: 'favorites' }, { type: '未知类别' }, { q: 'a'.repeat(513) }, { q: '换\n行' }, { section: 'a'.repeat(31) }]) {
    assert.throws(() => knowledge.list(query), { status: 400 });
  }

  knowledge.snippets = Array.from({ length: MAX_SNIPPETS }, () => snippet);
  await assert.rejects(knowledge.create(input()), { status: 400, message: /最多 5000/ });
});

test('damaged or unknown knowledge files disable only the knowledge base and stay untouched', async t => {
  const directory = await temporary(t);
  const file = path.join(directory, 'knowledge.json');
  const valid = await (await Knowledge.open(directory)).create(input());
  const cases = [
    ['{broken', /不是有效 JSON/],
    [JSON.stringify({ version: 2, snippets: [] }), /版本不受支持/],
    [JSON.stringify({ version: 1, snippets: [valid, valid] }), /结构损坏/],
    [JSON.stringify({ version: 1, snippets: [{ ...valid, extra: true }] }), /结构损坏/],
    [JSON.stringify({ version: 1, snippets: [{ ...valid, type: '未知类别' }] }), /结构损坏/],
    [JSON.stringify({ version: 1, snippets: [{ ...valid, title: ' 未裁剪 ' }] }), /结构损坏/],
    [JSON.stringify({ version: 1 }), /结构损坏/],
  ];
  for (const [content, message] of cases) {
    await writeFile(file, content);
    const knowledge = await Knowledge.open(directory);
    assert.throws(() => knowledge.list(), { status: 500, message });
    await assert.rejects(knowledge.create(input()), { status: 500, message });
    await assert.rejects(knowledge.setTrash(valid.id, { trashed: true }), { status: 500 });
    assert.equal(await readFile(file, 'utf8'), content, '原文件未修改');
  }
});
