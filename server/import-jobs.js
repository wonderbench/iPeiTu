import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { LibraryError, MAX_IMPORT_ENTRIES, MAX_IMPORT_FAILURES, importErrorMessage } from './library.js';

const terminal = new Set(['completed', 'failed']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class ImportJobs {
  constructor(library, { maxReports = 20, retentionMs = 60 * 60 * 1000,
    entryLimit = MAX_IMPORT_ENTRIES, failureLimit = MAX_IMPORT_FAILURES, now = Date.now } = {}) {
    this.library = library;
    this.records = new Map();
    this.activeId = null;
    this.maxReports = maxReports;
    this.retentionMs = retentionMs;
    this.entryLimit = entryLimit;
    this.failureLimit = failureLimit;
    this.now = now;
  }

  prune() {
    for (const [id, record] of this.records) {
      if (terminal.has(record.job.status) && this.now() - record.finishedTime >= this.retentionMs) this.records.delete(id);
    }
  }

  available() {
    if (this.activeId) throw new LibraryError('已有目录导入正在进行，请等待完成后再开始或重试', 409);
  }

  record(id) {
    this.prune();
    const record = typeof id === 'string' && uuid.test(id) && this.records.get(id);
    if (!record) throw new LibraryError('导入任务记录不存在或已过期（服务重启后报告会失效）；已导入的素材仍保留，请重新选择来源', 404);
    return record;
  }

  snapshot(record) {
    return { ...structuredClone(record.job), libraryTotal: this.library.activeTotal };
  }

  get(id) {
    return this.snapshot(this.record(id));
  }

  async create(directory) {
    this.available();
    const context = await this.library.prepareImportDirectory(directory);
    this.available();
    return this.start(context);
  }

  async retry(id, input) {
    this.available();
    const previous = this.record(id);
    if (!terminal.has(previous.job.status)) throw new LibraryError('请等待该导入任务结束后重试', 409);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
      || !Array.isArray(input.failureIds) || !input.failureIds.length || input.failureIds.length > this.failureLimit
      || new Set(input.failureIds).size !== input.failureIds.length) throw new LibraryError('重试仅接受非空且不重复的 failureIds 数组');
    const targets = input.failureIds.map(failureId => {
      const target = typeof failureId === 'string' && uuid.test(failureId) && previous.failures.get(failureId);
      if (!target) throw new LibraryError('失败项目不存在，请重新读取导入报告');
      return target;
    });
    const context = await this.library.prepareImportDirectory(previous.context.source);
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(context.root) !== normalize(previous.context.root)) throw new LibraryError('原来源目录指向已改变，请重新选择素材目录');
    this.available();
    return this.start(context, targets);
  }

  start(context, targets = [{ kind: 'directory', name: path.basename(context.root) || '根目录', relativePath: '' }]) {
    this.prune();
    while (this.records.size >= this.maxReports) {
      const oldest = [...this.records].find(([, record]) => terminal.has(record.job.status));
      if (!oldest) throw new LibraryError('导入报告数量已达上限，请等待正在运行的任务完成', 409);
      this.records.delete(oldest[0]);
    }
    const id = randomUUID();
    const record = { context, failures: new Map(), job: {
      id, status: 'queued', discovered: 0, total: null, processed: 0, currentName: null,
      imported: 0, duplicates: 0, restored: 0, failed: [], libraryTotal: this.library.activeTotal,
      error: null, createdAt: new Date(this.now()).toISOString(), finishedAt: null,
    } };
    this.records.set(id, record);
    this.activeId = id;
    record.completion = Promise.resolve().then(() => this.run(record, targets));
    return this.snapshot(record);
  }

  addFailure(record, target, error) {
    const id = randomUUID();
    const descriptor = { kind: target.kind, name: target.name, relativePath: target.relativePath };
    record.failures.set(id, descriptor);
    record.job.failed.push({ id, ...descriptor, error: importErrorMessage(error), retryable: true });
    if (record.job.failed.length >= this.failureLimit) {
      throw new LibraryError(`失败报告达到 ${this.failureLimit} 项上限，已停止于「${target.relativePath || target.name}」；后续项目尚未处理，请修复失败原因或选择更小的目录`);
    }
  }

  async run(record, targets) {
    const job = record.job;
    try {
      job.status = 'scanning';
      const files = [];
      const seen = new Set();
      const budget = { entries: 0 };
      const accept = entry => {
        if (entry.error) this.addFailure(record, entry, entry.error);
        else if (!seen.has(entry.relativePath)) {
          seen.add(entry.relativePath);
          files.push(entry);
          job.discovered = files.length;
        }
      };
      for (const target of targets) {
        if (target.kind === 'directory') {
          for await (const entry of this.library.walkImportDirectory(record.context, {
            relativePath: target.relativePath, budget, limit: this.entryLimit,
          })) accept(entry);
        } else {
          budget.entries++;
          if (budget.entries > this.entryLimit) throw new LibraryError(`重试项目超过 ${this.entryLimit} 项上限，尚未开始导入`);
          accept(target);
        }
      }
      job.total = files.length;
      job.status = 'importing';
      for (const file of files) {
        job.currentName = file.relativePath;
        try { job[await this.library.importSourceFile(record.context, file)]++; } catch (error) {
          // 局域网图库连不上或密钥失效时，后续每张都会同样失败，直接结束整批。
          if (error.fatal) throw error;
          this.addFailure(record, file, error);
        } finally { job.processed++; }
      }
      job.status = 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = `${importErrorMessage(error)}；已处理 ${job.processed} 张，已导入 ${job.imported} 张、恢复 ${job.restored} 张，成功结果仍保留`;
    } finally {
      job.currentName = null;
      record.finishedTime = this.now();
      job.finishedAt = new Date(record.finishedTime).toISOString();
      job.libraryTotal = this.library.activeTotal;
      this.activeId = null;
    }
    return this.snapshot(record);
  }

  wait(id) {
    return this.record(id).completion;
  }

  async importDirectory(directory) {
    const job = await this.create(directory);
    const result = await this.wait(job.id);
    if (result.status === 'failed') throw new LibraryError(`目录导入已停止：${result.error}`);
    return { imported: result.imported, duplicates: result.duplicates, restored: result.restored,
      failed: result.failed.map(({ name, error }) => ({ name, error })), total: this.library.activeTotal };
  }
}
