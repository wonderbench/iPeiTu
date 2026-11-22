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

// 同步追加写入：每行在 write 返回时已交给系统，退出前无需等待缓冲。
// 轮转失败（如文件被其他程序占用）时继续写当前文件，下次写入时再试；写入失败不抛出，避免服务因日志崩溃。
export class RotatingLog {
  constructor(filename, { maxBytes = MAX_LOG_BYTES, rename = renameSync, onError = reportToStderr } = {}) {
    if (typeof filename !== 'string' || !filename) throw new Error('日志文件路径无效');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('日志上限须为正整数字节数');
    this.filename = filename;
    this.backup = `${filename}.1`;
    this.maxBytes = maxBytes;
    this.rename = rename;
    this.onError = onError;
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
      if (!this.rotationFailing) this.onError('日志轮转失败，继续写入当前文件，下次写入时重试', error);
      this.rotationFailing = true;
    }
    this.open();
  }

  write(text) {
    const buffer = Buffer.from(String(text), 'utf8');
    try {
      if (this.fd === null) this.open();
      if (this.written > 0 && this.written + buffer.length > this.maxBytes) this.rotate();
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
