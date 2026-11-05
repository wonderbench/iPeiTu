import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLayoutOptions, normalizeQualityProfile } from '../public/layout-options.js';
import { loadLayoutPreferences, saveLayoutPreferences } from '../public/layout-preferences.js';

const storageKey = 'ipeitu.layout.v1';

function memoryStorage(initial) {
  const values = new Map(initial === undefined ? [] : [[storageKey, initial]]);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('新用户默认原图，质量偏好不混入 WPS 排版参数', () => {
  const preferences = loadLayoutPreferences(memoryStorage());
  assert.equal(preferences.qualityProfile, 'original');
  assert.equal(preferences.includeCaption, false);
  assert.deepEqual(normalizeLayoutOptions({ qualityProfile: 'balanced' }), normalizeLayoutOptions());
});

test('旧版布局偏好缺少质量字段时保留尺寸、段落与图题开关', () => {
  const existing = {
    widthMode: 'fixed', widthCm: 8.5, maxHeightCm: 15,
    layout: 'centered', includeCaption: true,
  };
  const storage = memoryStorage(JSON.stringify(existing));
  assert.deepEqual(loadLayoutPreferences(storage), { ...existing, qualityProfile: 'original' });
  assert.deepEqual(JSON.parse(storage.getItem(storageKey)), existing, '读取旧数据不擅自覆盖原记录');
});

test('三档画质可跨加载保存，图题文字不进入本机偏好', () => {
  const storage = memoryStorage();
  for (const qualityProfile of ['original', 'clear', 'balanced']) {
    const saved = saveLayoutPreferences({
      widthMode: 'fixed', widthCm: 9, maxHeightCm: 12,
      layout: 'centered', includeCaption: true, caption: '不应记住的图片名', qualityProfile,
    }, storage);
    assert.deepEqual(loadLayoutPreferences(storage), saved);
    assert.equal(saved.qualityProfile, qualityProfile);
    assert.equal(Object.hasOwn(saved, 'caption'), false);
    assert.equal(Object.hasOwn(JSON.parse(storage.getItem(storageKey)), 'caption'), false);
  }
});

test('非法画质值在保存前被拒绝，原偏好仍可读取', () => {
  const storage = memoryStorage();
  const original = saveLayoutPreferences({ widthCm: 10, qualityProfile: 'clear' }, storage);
  for (const qualityProfile of [null, '', 'large', 'CLEAR', 1, {}, ['balanced']]) {
    assert.throws(() => saveLayoutPreferences({ qualityProfile }, storage), /原图、清晰或均衡/);
    assert.deepEqual(loadLayoutPreferences(storage), original);
  }
  assert.equal(normalizeQualityProfile(), 'original');
});

test('损坏的质量记录与存储故障明确抛出，不伪装保存成功', () => {
  assert.throws(() => loadLayoutPreferences(memoryStorage('{broken')), SyntaxError);
  assert.throws(() => loadLayoutPreferences(memoryStorage('{"qualityProfile":"invalid"}')), /原图、清晰或均衡/);
  assert.throws(() => saveLayoutPreferences({ qualityProfile: 'balanced' }, {
    setItem() { throw new Error('storage unavailable'); },
  }), /storage unavailable/);
});
