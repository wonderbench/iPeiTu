import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { prepareSelfCheck, removeSelfCheck } from '../server/self-check.js';

async function exists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// 自检目录固定在系统临时目录下；测试只比较规范化后的父目录与目录名，不比较未规范化的完整路径。
test('self-check prepares its files only in a randomly named folder under the system temporary directory', async t => {
  const prepared = await prepareSelfCheck();
  const directory = path.dirname(prepared.image.path);
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.match(prepared.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(path.basename(directory), `ipeitu-self-check-${prepared.id}`);
  assert.equal(await realpath(path.dirname(directory)), await realpath(os.tmpdir()));
  const details = await lstat(directory);
  assert.equal(details.isDirectory() && !details.isSymbolicLink(), true);
  for (const file of [prepared.documentPath, prepared.replacement.path, prepared.box.path]) {
    assert.equal(path.dirname(path.dirname(file)) === directory || path.dirname(file) === directory, true, file);
  }
  assert.equal(await exists(prepared.documentPath), false, '文档由 WPS 创建，服务只给出路径');
  const imageMetadata = await sharp(prepared.image.path).metadata();
  assert.deepEqual([imageMetadata.format, imageMetadata.width, imageMetadata.height], ['png', 96, 64]);
  const replacement = await readFile(prepared.replacement.path);
  assert.equal(prepared.assetId, createHash('sha256').update(replacement).digest('hex'), '替换图编号就是图库会使用的内容哈希');
  assert.ok((await stat(prepared.box.path)).size > 0);

  const other = await prepareSelfCheck();
  t.after(() => rm(path.dirname(other.image.path), { recursive: true, force: true }));
  assert.notEqual(other.id, prepared.id, '每次自检使用新目录');

  await removeSelfCheck(prepared.id);
  assert.equal(await exists(directory), false);
  await removeSelfCheck(prepared.id);
  assert.equal(await exists(path.dirname(other.image.path)), true, '只删除指定的自检目录');
  await removeSelfCheck(other.id);
});

test('self-check removal accepts only valid identifiers and never follows links or deletes other files', async t => {
  const temporaryRoot = await realpath(os.tmpdir());
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-self-check-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, '保留.txt'), '不能删除');
  const id = randomUUID();
  for (const bad of ['', '..', '../outside', `${id}/..`, id.toUpperCase(), `${id}x`, path.basename(outside), 123, null]) {
    await assert.rejects(removeSelfCheck(bad), { status: 400, message: /无效的自检标识/ }, String(bad));
  }

  const link = path.join(temporaryRoot, `ipeitu-self-check-${id}`);
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(link, { force: true, recursive: true }));
  await assert.rejects(removeSelfCheck(id), { status: 409, message: /类型无效/ });
  assert.equal(await readFile(path.join(outside, '保留.txt'), 'utf8'), '不能删除', '符号链接指向的目录不受影响');
  assert.equal((await lstat(link)).isSymbolicLink(), true, '链接本身也保留，交给用户处理');

  const fileId = randomUUID();
  const file = path.join(temporaryRoot, `ipeitu-self-check-${fileId}`);
  await writeFile(file, '同名文件');
  t.after(() => rm(file, { force: true }));
  await assert.rejects(removeSelfCheck(fileId), { status: 409 });
  assert.equal(await readFile(file, 'utf8'), '同名文件');
  await removeSelfCheck(randomUUID());
});
