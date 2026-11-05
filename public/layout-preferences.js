import { normalizeLayoutOptions, normalizeQualityProfile } from './layout-options.js';

const storageKey = 'ipeitu.layout.v1';

function normalizePreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('保存的排版设置格式无效');
  }
  if (value.includeCaption !== undefined && typeof value.includeCaption !== 'boolean') {
    throw new Error('保存的图题设置格式无效');
  }
  const { caption, ...options } = normalizeLayoutOptions({ ...value, caption: '' });
  return {
    ...options, includeCaption: value.includeCaption ?? false,
    qualityProfile: normalizeQualityProfile(value.qualityProfile),
  };
}

export function loadLayoutPreferences(storage = globalThis.localStorage) {
  const saved = storage.getItem(storageKey);
  return normalizePreferences(saved ? JSON.parse(saved) : {});
}

export function saveLayoutPreferences(value, storage = globalThis.localStorage) {
  const preferences = normalizePreferences(value);
  storage.setItem(storageKey, JSON.stringify(preferences));
  return preferences;
}
