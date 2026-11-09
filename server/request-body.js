import { LibraryError } from './library.js';

// 读取请求体并限制大小；超过上限时丢弃剩余数据并返回 413。
export async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw new LibraryError('请求超过允许大小', 413);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) {
      request.resume();
      throw new LibraryError('请求超过允许大小', 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(request, limit = 16 * 1024) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new LibraryError('需要 JSON 请求', 415);
  try { return JSON.parse((await readBody(request, limit)).toString('utf8')); } catch (error) {
    if (error instanceof LibraryError) throw error;
    throw new LibraryError('请求不是有效 JSON');
  }
}
