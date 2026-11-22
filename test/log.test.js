import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_LOG_BYTES, RotatingLog, formatLine } from '../server/log.js';

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ipeitu-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filename: path.join(directory, 'service-39831.log') };
}

const line = index => `第 ${String(index).padStart(3, '0')} 行 ${'x'.repeat(20)}\n`;

test('the default log limit is 5 MB and lines keep the timestamp and level format', () => {
  assert.equal(MAX_LOG_BYTES, 5 * 1024 * 1024);
  const error = new Error('示例错误');
  const text = formatLine('ERROR', ['启动失败：', error, 42], new Date('2026-11-22T01:02:03.004Z'));
  assert.ok(text.startsWith('2026-11-22T01:02:03.004Z ERROR 启动失败： Error: 示例错误'));
  assert.ok(text.endsWith(' 42\n'));
  assert.throws(() => new RotatingLog(''), /路径/);
  assert.throws(() => new RotatingLog('x.log', { maxBytes: 0 }), /正整数/);
});

test('writing past the limit rotates to a single .1 file and keeps every recent line', async t => {
  const { directory, filename } = await setup(t);
  const errors = [];
  const log = new RotatingLog(filename, { maxBytes: 200, onError: (message, error) => errors.push([message, error]) });
  const lines = Array.from({ length: 40 }, (_, index) => line(index));
  for (const text of lines) log.write(text);
  log.end();
  assert.deepEqual(errors, []);
  assert.deepEqual((await readdir(directory)).sort(), ['service-39831.log', 'service-39831.log.1']);
  const current = await readFile(filename, 'utf8');
  const backup = await readFile(`${filename}.1`, 'utf8');
  assert.ok(Buffer.byteLength(current) <= 200, '当前文件不超过上限');
  assert.ok(Buffer.byteLength(backup) <= 200, '轮转出的文件不超过上限');
  // 旧的 .1 被覆盖：两个文件合起来正好是最后若干行，顺序不乱。
  const tail = backup + current;
  assert.ok(lines.join('').endsWith(tail));
  assert.ok(current.length > 0 && backup.length > 0);
  assert.ok(tail.includes(line(39)));
  assert.ok(!tail.includes(line(0)), '最早的行已随旧的 .1 一起丢弃');
});

test('an oversized log is rotated once at startup before new lines are written', async t => {
  const { directory, filename } = await setup(t);
  const old = 'o'.repeat(300);
  await writeFile(filename, old);
  await writeFile(`${filename}.1`, '更早的轮转');
  const log = new RotatingLog(filename, { maxBytes: 200 });
  assert.equal(await readFile(`${filename}.1`, 'utf8'), old, '启动时先轮转，覆盖旧的 .1');
  assert.equal(await readFile(filename, 'utf8'), '');
  log.write('启动\n');
  log.end();
  assert.equal(await readFile(filename, 'utf8'), '启动\n');
  assert.deepEqual((await readdir(directory)).sort(), ['service-39831.log', 'service-39831.log.1']);
});

test('a log under the limit is appended to at startup', async t => {
  const { filename } = await setup(t);
  await writeFile(filename, '已有内容\n');
  const log = new RotatingLog(filename, { maxBytes: 200 });
  log.write('新的一行\n');
  log.end();
  assert.equal(await readFile(filename, 'utf8'), '已有内容\n新的一行\n');
});

test('a failed rotation keeps writing to the current file, reports once and retries only after the interval', async t => {
  const { directory, filename } = await setup(t);
  const errors = [];
  let blocked = true;
  let attempts = 0;
  let time = 1_000_000;
  const rename = (from, to) => {
    attempts++;
    if (blocked) throw Object.assign(new Error('文件被占用'), { code: 'EBUSY' });
    renameSync(from, to);
  };
  const log = new RotatingLog(filename, { maxBytes: 50, rename, retryMs: 60_000, now: () => time, onError: message => errors.push(message) });
  for (let index = 0; index < 5; index++) assert.doesNotThrow(() => log.write(line(index)));
  assert.equal(attempts, 1, '间隔内不重复关闭、改名、重开');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /轮转失败/);
  time += 59_999;
  log.write(line(5));
  assert.equal(attempts, 1, '间隔未到不重试');
  time += 1;
  log.write(line(6));
  assert.equal(attempts, 2, '间隔到后再试');
  assert.equal(errors.length, 1, '连续失败只报告一次');
  const all = [0, 1, 2, 3, 4, 5, 6].map(line).join('');
  assert.equal(await readFile(filename, 'utf8'), all, '失败期间内容不丢失');
  assert.deepEqual(await readdir(directory), ['service-39831.log']);
  blocked = false;
  log.write(line(7));
  assert.equal(attempts, 2, '刚失败过，仍在间隔内');
  time += 60_000;
  log.write(line(8));
  log.end();
  assert.equal(attempts, 3);
  assert.equal(await readFile(`${filename}.1`, 'utf8'), all + line(7));
  assert.equal(await readFile(filename, 'utf8'), line(8));
  assert.throws(() => new RotatingLog(filename, { retryMs: -1 }), /重试间隔/);
});

test('a write failure is reported instead of thrown and end() closes the file before its callback', async t => {
  const { filename } = await setup(t);
  const errors = [];
  const log = new RotatingLog(filename, { onError: message => errors.push(message) });
  log.write('第一行\n');
  let ended = false;
  log.end(() => { ended = true; });
  assert.equal(ended, true);
  assert.equal(log.fd, null);
  assert.equal(await readFile(filename, 'utf8'), '第一行\n', '回调时内容已落盘');
  // 模拟文件句柄失效：写入失败只报告，不抛出。
  log.fd = -1;
  assert.doesNotThrow(() => log.write('写不进去\n'));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /写入失败/);
  log.fd = null;
  log.write('重新打开后继续\n');
  log.end();
  assert.equal(await readFile(filename, 'utf8'), '第一行\n重新打开后继续\n');
});
