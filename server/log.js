import { closeSync, fstatSync, openSync, renameSync, statSync, writeSync } from 'node:fs';

// 后台服务日志：单个文件超过上限时轮转为 <名称>.1（覆盖旧的 .1），只保留这一份旧日志。
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function formatLine(level, values, date = new Date()) {
  return `${date.toISOString()} ${level} ${values.map(value => (value instanceof Error ? value.stack : String(value))).join(' ')}\n`;
}

// 日志自身出错时只能写到标准错误；不能用 console.error，它可能已被改为写入本日志。
function reportToStderr(message, error) {
  try { process.stderr.write(`${new Date().toISOString()} ERROR ${message}：${error?.stack ?? error}\n`); } catch {
    // 标准错误也不可用时没有其他输出途径，保持服务继续运行。
  }
}

export const ROTATION_RETRY_MS = 60 * 1000;

// 同步追加写入：每行在 write 返回时已交给系统，退出前无需等待缓冲。
// 轮转失败（如文件被其他程序占用）时继续写当前文件，间隔 retryMs 后的写入再试；写入失败不抛出，避免服务因日志崩溃。
// 已知情形：重复启动时（端口已被本服务占用的第二个进程）若日志已超过上限，第二个进程会把第一个进程正在写的日志改名为 .1，
// 第一个进程此后继续写入 .1，直到它自己下次轮转。日志不丢，只是落点错位。
export class RotatingLog {
  constructor(filename, { maxBytes = MAX_LOG_BYTES, rename = renameSync, onError = reportToStderr, retryMs = ROTATION_RETRY_MS, now = () => Date.now() } = {}) {
    if (typeof filename !== 'string' || !filename) throw new Error('日志文件路径无效');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('日志上限须为正整数字节数');
    if (!Number.isFinite(retryMs) || retryMs < 0) throw new Error('日志轮转重试间隔须为非负毫秒数');
    this.filename = filename;
    this.backup = `${filename}.1`;
    this.maxBytes = maxBytes;
    this.rename = rename;
    this.onError = onError;
    this.retryMs = retryMs;
    this.now = now;
    this.retryAt = -Infinity;
    this.fd = null;
    this.written = 0;
    this.rotationFailing = false;
    let size = 0;
    try { size = statSync(filename).size; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (size > maxBytes) this.rotate();
    // 启动时打不开日志文件属于配置错误，直接抛出让启动失败并显示原因。
    if (this.fd === null) this.open();
  }

  open() {
    this.fd = openSync(this.filename, 'a');
    this.written = fstatSync(this.fd).size;
  }

  close() {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    closeSync(fd);
  }

  rotate() {
    try { this.close(); } catch (error) { this.onError('关闭日志文件失败', error); }
    try {
      this.rename(this.filename, this.backup);
      this.rotationFailing = false;
    } catch (error) {
      // 同一轮连续失败只报告一次，成功后再失败时重新报告。
      if (!this.rotationFailing) this.onError('日志轮转失败，继续写入当前文件，稍后重试', error);
      this.rotationFailing = true;
      this.retryAt = this.now() + this.retryMs;
    }
    this.open();
  }

  write(text) {
    const buffer = Buffer.from(String(text), 'utf8');
    try {
      if (this.fd === null) this.open();
      // 轮转失败后的重试间隔内直接写当前文件，不反复关闭、改名、重开。
      if (this.written > 0 && this.written + buffer.length > this.maxBytes && this.now() >= this.retryAt) this.rotate();
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(this.fd, buffer, offset, buffer.length - offset);
      this.written += buffer.length;
    } catch (error) {
      this.onError('日志写入失败', error);
    }
  }

  // 与原先的流接口一致：关闭文件后回调，供“写完日志再退出”使用。
  end(callback) {
    try { this.close(); } catch (error) { this.onError('关闭日志文件失败', error); }
    if (callback) callback();
  }
}
