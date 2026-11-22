import test from 'node:test';
import assert from 'node:assert/strict';
import { readFormattedPaste } from '../public/knowledge-paste.js';

// 剪贴板 HTML 的解析依赖浏览器 DOM（template、CSSStyleDeclaration、Node），Node 测试环境没有 DOM，
// 这里只验证不需要 DOM 的入口限制；段落、字体、局部加粗、缩进和行距的解析需在浏览器中验收。
test('falls back to plain paste for missing or oversized HTML before touching the DOM', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(readFormattedPaste('', '甲', 100), null);
  assert.equal(readFormattedPaste(undefined, '甲', 100), null);
  assert.equal(readFormattedPaste(`<p>${'甲'.repeat(512_001)}</p>`, '甲', 100), null, '超过 512000 字符的 HTML 不解析');
  // 有内容的 HTML 必须进入 DOM 解析；没有 DOM 时报错而不是假装解析成功。
  assert.throws(() => readFormattedPaste('<p>甲</p>', '甲', 100), ReferenceError);
});
