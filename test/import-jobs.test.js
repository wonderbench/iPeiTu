import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Library, MAX_IMAGE_BYTES } from '../server/library.js';
import { ImportJobs } from '../server/import-jobs.js';

async function setup(t, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-jobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = await Library.open(path.join(root, 'library'));
  const source = path.join(root, 'source');
  await mkdir(source);
  return { root, source, library, jobs: new ImportJobs(library, options) };
}
const image = (color = 'red') => sharp({ create: { width: 8, height: 6, channels: 3, background: color } }).png().toBuffer();
function barrier() {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
}

test('jobs expose queued, scanning and per-file progress; favorites can commit between files', async t => {
  const { source, library, jobs } = await setup(t);
  const bytes = await image();
  await library.importFile('已有.png', bytes);
  const id = library.assets[0].id;
  await writeFile(path.join(source, '重复.png'), bytes);
  await writeFile(path.join(source, '新增.png'), await image('blue'));
  const scanning = barrier(), continueScan = barrier(), importing = barrier(), continueImport = barrier();
  const walk = library.walkImportDirectory.bind(library);
  t.mock.method(library, 'walkImportDirectory', async function* (...args) {
    scanning.release();
    await continueScan.promise;
    yield* walk(...args);
  });
  const importFile = library.importSourceFile.bind(library);
  let calls = 0;
  t.mock.method(library, 'importSourceFile', async (...args) => {
    if (++calls === 2) { importing.release(); await continueImport.promise; }
    return importFile(...args);
  });
  const job = await jobs.create(source);
  assert.equal(job.status, 'queued');
  assert.equal(job.total, null);
  await scanning.promise;
  assert.equal(jobs.get(job.id).status, 'scanning');
  await assert.rejects(jobs.create(source), error => error.status === 409);
  continueScan.release();
  await importing.promise;
  const progress = jobs.get(job.id);
  assert.equal(progress.status, 'importing');
  assert.equal(progress.discovered, 2);
  assert.equal(progress.total, 2);
  assert.equal(progress.processed, 1);
  assert.ok(progress.currentName);
  await library.setFavorite(id, { favorite: true });
  assert.equal(library.list('', { view: 'favorites' }).viewTotal, 1);
  continueImport.release();
  const result = await jobs.wait(job.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.libraryTotal, 2);
  assert.equal(result.processed, 2);
  assert.equal(result.currentName, null);
  assert.ok(result.finishedAt);
});

test('failed file reports can be retried once repaired without repeating successful files', async t => {
  const { source, library, jobs } = await setup(t);
  await writeFile(path.join(source, '有效.png'), await image());
  const damaged = path.join(source, '损坏.png');
  await writeFile(damaged, 'broken');
  const first = await jobs.wait((await jobs.create(source)).id);
  assert.equal(first.status, 'completed');
  assert.equal(first.imported, 1);
  assert.equal(first.failed.length, 1);
  const failure = first.failed[0];
  assert.equal(failure.kind, 'file');
  assert.equal(failure.relativePath, '损坏.png');
  assert.equal(failure.retryable, true);
  assert.match(failure.error, /无法读取图片/);
  // Snapshot mutation cannot change stored retry descriptors.
  first.failed[0].relativePath = '../outside.png';
  const invalid = [null, [], {}, { failureIds: [] }, { failureIds: ['unknown'] },
    { failureIds: [failure.id, failure.id] }, { failureIds: [failure.id], extra: true }];
  for (const input of invalid) await assert.rejects(jobs.retry(first.id, input), error => error.status === 400);
  await writeFile(damaged, await image('blue'));
  const next = await jobs.retry(first.id, { failureIds: [failure.id] });
  assert.notEqual(next.id, first.id);
  const retried = await jobs.wait(next.id);
  assert.equal(retried.imported, 1);
  assert.equal(retried.duplicates, 0);
  assert.equal(retried.total, 1);
  assert.deepEqual(retried.failed, []);
  assert.equal(library.activeTotal, 2);
});

test('directory read failures have retryable scoped descriptors and repair imports the subtree', async t => {
  const { source, library, jobs } = await setup(t);
  await mkdir(path.join(source, '子目录'));
  await writeFile(path.join(source, '子目录', '图片.png'), await image());
  const resolve = library.resolveImportSource.bind(library);
  const errors = t.mock.method(console, 'error', () => {});
  const failure = t.mock.method(library, 'resolveImportSource', async (context, relativePath, kind) => {
    if (relativePath === '子目录') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return resolve(context, relativePath, kind);
  });
  const first = await jobs.wait((await jobs.create(source)).id);
  assert.equal(first.failed[0].kind, 'directory');
  assert.equal(first.failed[0].relativePath, '子目录');
  assert.equal(first.total, 0);
  assert.equal(errors.mock.calls.length, 1);
  failure.mock.restore();
  const result = await jobs.wait((await jobs.retry(first.id, { failureIds: [first.failed[0].id] })).id);
  assert.equal(result.imported, 1);
  assert.deepEqual(result.failed, []);
});

test('report retention expires unknown IDs, evicts oldest reports and resets independently of persisted assets', async t => {
  let now = Date.now();
  const { source, library, jobs } = await setup(t, { maxReports: 2, retentionMs: 100, now: () => now });
  await writeFile(path.join(source, '图片.png'), await image());
  const first = await jobs.wait((await jobs.create(source)).id);
  const second = await jobs.wait((await jobs.create(source)).id);
  await jobs.wait((await jobs.create(source)).id);
  assert.throws(() => jobs.get(first.id), error => error.status === 404);
  assert.equal(jobs.get(second.id).status, 'completed');
  now += 100;
  assert.throws(() => jobs.get(second.id), error => error.status === 404);
  assert.throws(() => jobs.get('invalid'), error => error.status === 404);
  const reopened = await Library.open(library.directory);
  assert.equal(reopened.activeTotal, 1);
  assert.throws(() => new ImportJobs(reopened).get(first.id), error => error.status === 404);
});

test('scan budget counts unrelated files and directories and stops with explicit scope', async t => {
  const { source, jobs } = await setup(t, { entryLimit: 2 });
  await mkdir(path.join(source, '目录'));
  await writeFile(path.join(source, '目录', '说明.txt'), 'text');
  await writeFile(path.join(source, '说明.txt'), 'text');
  const result = await jobs.wait((await jobs.create(source)).id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /2 个文件或目录的上限/);
  assert.match(result.error, /尚未扫描/);
  assert.equal(result.total, null);
  assert.equal(result.processed, 0);
});

test('failure report budget stops importing and preserves exactly the bounded report', async t => {
  const { source, jobs } = await setup(t, { failureLimit: 2 });
  for (let index = 0; index < 3; index++) await writeFile(path.join(source, `${index}.png`), 'broken');
  const result = await jobs.wait((await jobs.create(source)).id);
  assert.equal(result.status, 'failed');
  assert.equal(result.failed.length, 2);
  assert.equal(result.processed, 2);
  assert.equal(result.total, 3);
  assert.match(result.error, /2 项上限/);
  assert.match(result.error, /后续项目尚未处理/);
});

test('retry revalidates a replaced ancestor junction and a changed source root', async t => {
  const { root, source, jobs } = await setup(t);
  const child = path.join(source, '子目录');
  await mkdir(child);
  await writeFile(path.join(child, '图片.png'), 'broken');
  const first = await jobs.wait((await jobs.create(source)).id);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, '图片.png'), await image());
  await rename(child, path.join(source, '原子目录'));
  await symlink(outside, child, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await jobs.wait((await jobs.retry(first.id, { failureIds: [first.failed[0].id] })).id);
  assert.equal(result.imported, 0);
  assert.match(result.failed[0].error, /符号链接/);
  await rename(source, path.join(root, '原来源'));
  await symlink(outside, source, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(jobs.retry(first.id, { failureIds: [first.failed[0].id] }), /符号链接/);
});

test('source reads reject ancestor aliases, managed overlap, traversal and oversized files', async t => {
  const { root, source, library, jobs } = await setup(t);
  await assert.rejects(jobs.create(root), /不能包含/);
  await assert.rejects(jobs.create(path.join(library.directory, 'images')), /图库内/);
  const link = path.join(root, 'link');
  await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(path.join(source, 'nested'));
  await assert.rejects(jobs.create(path.join(link, 'nested')), /符号链接/);
  const context = await library.prepareImportDirectory(source);
  for (const relativePath of ['../outside.png', 'nested/../a.png', '/a.png', 'C:/a.png', 'nested\\a.png']) {
    await assert.rejects(library.resolveImportSource(context, relativePath, 'file'), /相对路径/);
  }
  const handle = await open(path.join(source, '大图.png'), 'w');
  try { await handle.truncate(MAX_IMAGE_BYTES + 1); } finally { await handle.close(); }
  const result = await jobs.wait((await jobs.create(source)).id);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /32 MB/);
  assert.equal(result.imported, 0);
});

test('unexpected file errors are reported and the next import job remains usable', async t => {
  const { source, library, jobs } = await setup(t);
  await writeFile(path.join(source, '图片.png'), await image());
  const errors = t.mock.method(console, 'error', () => {});
  const failure = t.mock.method(library, 'importSourceFile', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  const result = await jobs.wait((await jobs.create(source)).id);
  assert.match(result.failed[0].error, /磁盘空间不足/);
  assert.equal(errors.mock.calls.length, 1);
  failure.mock.restore();
  const next = await jobs.wait((await jobs.create(source)).id);
  assert.equal(next.imported, 1);
});

test('simultaneous create calls reserve exactly one active job after asynchronous path validation', async t => {
  const { source, library, jobs } = await setup(t);
  const gate = barrier();
  const walk = library.walkImportDirectory.bind(library);
  t.mock.method(library, 'walkImportDirectory', async function* (...args) {
    await gate.promise;
    yield* walk(...args);
  });
  const attempts = await Promise.allSettled([jobs.create(source), jobs.create(source)]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(item => item.status === 'rejected').reason.status, 409);
  gate.release();
  await jobs.wait(attempts.find(item => item.status === 'fulfilled').value.id);
});

test('directory image candidates use content validation including jfif and report unsupported image suffixes', async t => {
  const { source, jobs } = await setup(t);
  await writeFile(path.join(source, '照片.jfif'), await sharp({ create: { width: 8, height: 6, channels: 3, background: 'red' } }).jpeg().toBuffer());
  for (const extension of ['heif', 'ico', 'avif']) await writeFile(path.join(source, `不支持.${extension}`), 'broken image');
  await writeFile(path.join(source, '说明.txt'), 'ignored');
  const result = await jobs.wait((await jobs.create(source)).id);
  assert.equal(result.total, 4);
  assert.equal(result.imported, 1);
  assert.equal(result.failed.length, 3);
  assert.equal(result.processed, 4);
});

test('a source file replaced between path inspection and open is rejected by file identity checks', async t => {
  const { source, library, jobs } = await setup(t);
  const filename = path.join(source, '图片.png');
  await writeFile(filename, await image());
  const resolve = library.resolveImportSource.bind(library);
  let replaced = false;
  t.mock.method(library, 'resolveImportSource', async (...args) => {
    const details = await resolve(...args);
    if (args[2] === 'file' && !replaced) {
      replaced = true;
      await rename(filename, path.join(source, '原图.png'));
      await writeFile(filename, await image('blue'));
    }
    return details;
  });
  const result = await jobs.wait((await jobs.create(source)).id);
  assert.equal(result.imported, 0);
  assert.match(result.failed[0].error, /读取前已改变/);
  assert.equal(library.activeTotal, 0);
});
