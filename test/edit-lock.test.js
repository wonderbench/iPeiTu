import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { EDIT_LOCK_MS, EditLocks, Library } from '../server/library.js';
import { Knowledge } from '../server/knowledge.js';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// 编辑锁使用注入的时钟，过期判断不依赖真实等待。
function clock(locks) {
  const time = { now: 1_000_000 };
  locks.now = () => time.now;
  return time;
}

const image = color => sharp({ create: { width: 40, height: 30, channels: 3, background: color } }).png().toBuffer();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('edit locks expire after the lock period, renew on request and release only with the holder token', () => {
  const locks = new EditLocks();
  const time = clock(locks);
  const token = locks.acquire('a', '忙');
  assert.match(token, uuid);
  assert.throws(() => locks.acquire('a', '忙'), { status: 423, message: '忙' });
  assert.equal(locks.check('a', token, '忙', '过期').token, token);
  assert.throws(() => locks.check('a', undefined, '忙', '过期'), { status: 423 });
  assert.throws(() => locks.check('a', randomUUID(), '忙', '过期'), { status: 423 });
  time.now += EDIT_LOCK_MS - 1;
  assert.deepEqual(locks.change('a', { token }, '忙', '过期'), { ok: true });
  time.now += EDIT_LOCK_MS - 1;
  assert.throws(() => locks.acquire('a', '忙'), { status: 423 }, '续期后仍在有效期内');
  time.now += 1;
  const other = locks.acquire('a', '忙');
  assert.notEqual(other, token, '过期后可被他人申请');
  assert.throws(() => locks.change('a', { token }, '忙', '过期'), { status: 423 }, '旧令牌不能续期他人的锁');
  assert.deepEqual(locks.change('a', { token, release: true }, '忙', '过期'), { ok: true });
  assert.equal(locks.get('a').token, other, '旧令牌不能释放他人的锁');
  assert.deepEqual(locks.change('a', { token: other, release: true }, '忙', '过期'), { ok: true });
  assert.equal(locks.has('a'), false);
  assert.throws(() => locks.change('a', { token: other }, '忙', '过期'), { status: 409, message: '过期' });
  for (const input of [null, [], {}, { token: 'x' }, { token: other.toUpperCase() }, { token: other, release: false },
    { token: other, extra: 1 }, { token: other, release: true, extra: 1 }]) {
    assert.throws(() => locks.change('a', input, '忙', '过期'), { status: 400 }, JSON.stringify(input));
  }
});

test('asset edit locks block other writers until saved, released or expired while reads continue', async t => {
  const root = await temporary(t);
  const directory = path.join(root, 'library');
  const library = await Library.open(directory);
  const time = clock(library.editLocks);
  const bytes = await image('#226644');
  await library.importFile('原名.png', bytes);
  await library.importFile('另一张.png', await image('#664422'));
  const [{ id }, { id: other }] = library.assets;
  const indexPath = path.join(directory, 'index.json');

  for (const input of [null, [], { extra: 1 }]) await assert.rejects(library.acquireEditLock(id, input), { status: 400 });
  await assert.rejects(library.acquireEditLock('f'.repeat(64), {}), { status: 404 });
  const { asset, token } = await library.acquireEditLock(id, {});
  assert.equal(asset.id, id);
  assert.equal(asset.favorite, false);
  assert.match(token, uuid);
  await assert.rejects(library.acquireEditLock(id, {}), { status: 423, message: /「原名.png」的素材信息正在编辑/ });

  // 锁定时仍可读取、插入与记录个人状态。
  assert.equal(library.list().assets.length, 2);
  assert.ok((await library.insertion(id)).path);
  assert.ok((await library.file(id, 'thumbnail')).path);
  assert.equal((await library.setFavorite(id, { favorite: true })).favorite, true);
  assert.ok((await library.recordRecent(id, {})).lastInsertedAt);

  const before = await readFile(indexPath);
  await assert.rejects(library.updateAsset(id, { name: '他人修改' }), { status: 423 });
  await assert.rejects(library.updateAsset(id, { name: '他人修改', editToken: randomUUID() }), { status: 423 });
  await assert.rejects(library.updateAsset(id, { name: '他人修改', editToken: 'x' }), { status: 400 });
  await assert.rejects(library.updateAssets({ ids: [other, id], addTags: ['批量'] }), { status: 423 });
  await assert.rejects(library.setTrash(id, { trashed: true }), { status: 423 });
  const reimport = await library.importFile('新别名.png', bytes, '新分类');
  assert.match(reimport.failed[0]?.error ?? '', /正在编辑/, '重复导入会改别名或分类时受锁约束');
  assert.equal((await library.importFile('原名.png', bytes)).duplicates, 1, '不改信息的重复导入不受锁影响');
  assert.deepEqual(await readFile(indexPath), before, '被锁拒绝的写入都没有落盘');
  assert.deepEqual(library.getAsset(other).tags, [], '批量修改遇锁整批停止');

  time.now += EDIT_LOCK_MS - 1;
  assert.deepEqual(await library.changeEditLock(id, { token }), { ok: true });
  time.now += EDIT_LOCK_MS - 1;
  const saved = await library.updateAsset(id, { name: '持锁保存', editToken: token });
  assert.equal(saved.name, '持锁保存');
  assert.equal(saved.favorite, true);
  assert.equal(library.editLocks.has(id), false, '保存后释放锁');
  await assert.rejects(library.updateAsset(id, { name: '再次保存', editToken: token }), { status: 409, message: /已过期/ });

  const second = (await library.acquireEditLock(id, {})).token;
  time.now += EDIT_LOCK_MS;
  await assert.rejects(library.updateAsset(id, { name: '过期保存', editToken: second }), { status: 409, message: /已过期/ });
  await assert.rejects(library.changeEditLock(id, { token: second }), { status: 409 });
  assert.equal((await library.updateAsset(id, { tags: ['无锁修改'] })).tags[0], '无锁修改', '过期后他人可直接修改');

  const third = (await library.acquireEditLock(id, {})).token;
  assert.deepEqual(await library.changeEditLock(id, { token: third, release: true }), { ok: true });
  assert.deepEqual(await library.updateAssets({ ids: [other, id], addTags: ['批量'] }), { updated: 2 });
  const fourth = (await library.acquireEditLock(id, {})).token;
  assert.ok((await library.setTrash(id, { trashed: true, editToken: fourth })).deletedAt, '持锁可以移入回收站');
  assert.equal(library.editLocks.has(id), false);
  await assert.rejects(library.acquireEditLock(id, {}), { status: 410 }, '回收站中的素材不能开始编辑');
  const reopened = await Library.open(directory);
  assert.equal(reopened.getAsset(id, { includeDeleted: true }).name, '持锁保存');
  assert.equal(reopened.editLocks.size, 0, '编辑锁不持久化');
});

test('knowledge edit locks guard edits and trash, expire on the injected clock and keep reads available', async t => {
  const knowledge = await Knowledge.open(await temporary(t));
  const time = clock(knowledge.editLocks);
  const snippet = await knowledge.create({ title: '模板支设', type: '房建施工', section: '模板工程', tags: [], body: '按方案支设。' });
  for (const input of [null, [], { extra: 1 }]) await assert.rejects(knowledge.acquireEditLock(snippet.id, input), { status: 400 });
  await assert.rejects(knowledge.acquireEditLock(randomUUID(), {}), { status: 404 });
  const { snippet: locked, token } = await knowledge.acquireEditLock(snippet.id, {});
  assert.deepEqual(locked, snippet);
  assert.match(token, uuid);
  await assert.rejects(knowledge.acquireEditLock(snippet.id, {}), { status: 423, message: /正在被编辑/ });
  assert.equal(knowledge.list().snippets.length, 1, '锁定时仍可检索');
  await assert.rejects(knowledge.update(snippet.id, { title: '他人修改' }), { status: 423 });
  await assert.rejects(knowledge.update(snippet.id, { title: '他人修改', editToken: randomUUID() }), { status: 423 });
  await assert.rejects(knowledge.update(snippet.id, { title: '他人修改', editToken: 'x' }), { status: 400 });
  await assert.rejects(knowledge.update(snippet.id, { editToken: token }), { status: 400 }, '只有令牌没有字段');
  await assert.rejects(knowledge.setTrash(snippet.id, { trashed: true }), { status: 423 });
  assert.equal(knowledge.snippets[0].title, '模板支设');

  time.now += EDIT_LOCK_MS - 1;
  assert.deepEqual(await knowledge.changeEditLock(snippet.id, { token }), { ok: true });
  time.now += EDIT_LOCK_MS - 1;
  const updated = await knowledge.update(snippet.id, { title: '持锁保存', editToken: token });
  assert.equal(updated.title, '持锁保存');
  assert.equal(Object.hasOwn(updated, 'editToken'), false, '令牌不写入片段');
  assert.equal(knowledge.editLocks.has(snippet.id), false);

  const second = (await knowledge.acquireEditLock(snippet.id, {})).token;
  time.now += EDIT_LOCK_MS;
  await assert.rejects(knowledge.update(snippet.id, { title: '过期保存', editToken: second }), { status: 409, message: /已过期/ });
  const third = (await knowledge.acquireEditLock(snippet.id, {})).token;
  assert.notEqual(third, second, '过期后可被他人申请');
  await assert.rejects(knowledge.changeEditLock(snippet.id, { token: second }), { status: 423 });
  assert.deepEqual(await knowledge.changeEditLock(snippet.id, { token: third, release: true }), { ok: true });
  assert.ok((await knowledge.setTrash(snippet.id, { trashed: true })).trashedAt);
  await assert.rejects(knowledge.acquireEditLock(snippet.id, {}), { status: 410 });
  const saved = JSON.parse(await readFile(knowledge.file, 'utf8'));
  assert.equal(saved.snippets[0].title, '持锁保存');
  assert.equal(Object.hasOwn(saved.snippets[0], 'editToken'), false);
});
