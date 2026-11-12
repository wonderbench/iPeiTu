import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { EditLocks, LibraryError } from './library.js';
import { isSnippetFormat, trimSnippetBody } from '../public/knowledge-format.js';

// 标书知识库：通用文字片段，保存在图库目录的 knowledge.json。分类在此维护，正文由用户自行录入。
export const KNOWLEDGE_CATEGORIES = Object.freeze([
  { type: '房建施工', sections: ['土方工程', '基础工程', '钢筋工程', '模板工程', '混凝土工程', '砌体工程', '脚手架工程', '防水工程', '屋面工程', '装饰装修工程', '机电安装工程'] },
  { type: '市政道路管网', sections: ['路基工程', '路面工程', '开槽埋管', '顶管施工', '检查井', '交通导改', '绿化工程'] },
  { type: '信息化/弱电', sections: ['综合布线', '视频监控', '机房工程', '系统集成', '调试与试运行', '运维服务', '培训'] },
  { type: '通用措施', sections: ['质量保证措施', '安全保证措施', '文明施工', '环境保护', '进度保证措施', '冬雨季施工', '应急预案', '成品保护'] },
].map(category => Object.freeze({ type: category.type, sections: Object.freeze(category.sections) })));

export const MAX_SNIPPETS = 5000;
const EDIT_BUSY = '这条片段正在被编辑，请等对方保存或退出后再试';
const EDIT_EXPIRED = '编辑锁已过期，请重新打开片段';
export const SNIPPET_LIMITS = Object.freeze({ title: 100, section: 30, tag: 32, tags: 32, body: 20000 });
const types = new Set(KNOWLEDGE_CATEGORIES.map(category => category.type));
const fields = ['title', 'type', 'section', 'tags', 'body'];
const recordFields = ['id', ...fields, 'createdAt', 'updatedAt', 'trashedAt'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const separators = String.fromCharCode(0x2028, 0x2029);
// 单行字段不允许任何控制字符；正文只允许换行分段。
const lineControl = new RegExp(`[\\x00-\\x1f\\x7f${separators}]`);
const bodyControl = new RegExp(`[\\x00-\\x09\\x0b-\\x1f\\x7f${separators}]`);

function matchKey(value) {
  return value.normalize('NFKC').toLowerCase();
}

function hasExactFields(value, allowed, { partial = false, optional = [] } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key) && !optional.includes(key))) return false;
  return partial ? keys.length > 0 : allowed.every(key => Object.hasOwn(value, key));
}

function line(value, label, maximum) {
  if (typeof value !== 'string') throw new LibraryError(`${label}必须是文字`);
  const text = value.trim();
  if (!text || text.length > maximum || lineControl.test(text)) throw new LibraryError(`${label}须为 1–${maximum} 个可见字符`);
  return text;
}

function tagList(value) {
  if (!Array.isArray(value) || value.length > SNIPPET_LIMITS.tags) throw new LibraryError(`标签最多 ${SNIPPET_LIMITS.tags} 个`);
  const seen = new Set();
  const tags = [];
  for (const item of value) {
    const tag = line(item, '标签', SNIPPET_LIMITS.tag);
    if (seen.has(matchKey(tag))) continue;
    seen.add(matchKey(tag));
    tags.push(tag);
  }
  return tags;
}

function bodyText(value) {
  if (typeof value !== 'string') throw new LibraryError('正文必须是文字');
  if (value.length > SNIPPET_LIMITS.body) throw new LibraryError(`正文最多 ${SNIPPET_LIMITS.body} 个字符`);
  if (bodyControl.test(value)) throw new LibraryError('正文只能包含文字和换行');
  const body = trimSnippetBody(value);
  if (!body.trim()) throw new LibraryError('正文不能为空');
  return body;
}

function validate(input, currentBody) {
  const result = {};
  if (Object.hasOwn(input, 'title')) result.title = line(input.title, '标题', SNIPPET_LIMITS.title);
  if (Object.hasOwn(input, 'type')) {
    if (!types.has(input.type)) throw new LibraryError('工程类别不在知识库分类中');
    result.type = input.type;
  }
  if (Object.hasOwn(input, 'section')) result.section = line(input.section, '章节', SNIPPET_LIMITS.section);
  if (Object.hasOwn(input, 'tags')) result.tags = tagList(input.tags);
  if (Object.hasOwn(input, 'body')) result.body = bodyText(input.body);
  if (Object.hasOwn(input, 'format')) {
    if (!isSnippetFormat(input.format, result.body ?? currentBody)) throw new LibraryError('片段格式与正文不匹配或超出支持范围');
    result.format = input.format;
  }
  return result;
}

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validRecord(snippet) {
  if (!hasExactFields(snippet, recordFields, { optional: ['format'] }) || !uuidPattern.test(snippet.id)) return false;
  if (!validTimestamp(snippet.createdAt) || !validTimestamp(snippet.updatedAt)) return false;
  if (snippet.trashedAt !== null && !validTimestamp(snippet.trashedAt)) return false;
  try {
    const checked = validate(snippet);
    return fields.every(key => JSON.stringify(checked[key]) === JSON.stringify(snippet[key]));
  } catch {
    return false;
  }
}

export class Knowledge {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, 'knowledge.json');
    this.snippets = [];
    this.trashScope = randomUUID();
    this.editLocks = new EditLocks();
    this.failure = null;
    this.pending = Promise.resolve();
  }

  // 知识库文件损坏时只停用知识库，不影响图库启动；原文件保持不变。
  static async open(directory) {
    const knowledge = new Knowledge(directory);
    await mkdir(knowledge.directory, { recursive: true });
    let original;
    try { original = await readFile(knowledge.file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return knowledge;
      throw error;
    }
    let data;
    try { data = JSON.parse(original); } catch {
      knowledge.failure = new LibraryError('知识库文件 knowledge.json 不是有效 JSON，原文件未修改；请恢复备份后重启 iPeiTu', 500);
      return knowledge;
    }
    if (data?.version !== 1) {
      knowledge.failure = new LibraryError('知识库文件版本不受支持，原文件未修改；请使用对应版本的 iPeiTu', 500);
    } else if (!Array.isArray(data.snippets) || data.snippets.length > MAX_SNIPPETS || !data.snippets.every(validRecord)
      || new Set(data.snippets.map(snippet => snippet.id)).size !== data.snippets.length) {
      knowledge.failure = new LibraryError('知识库文件结构损坏，原文件未修改；请恢复备份后重启 iPeiTu', 500);
    } else {
      knowledge.snippets = data.snippets;
    }
    return knowledge;
  }

  ready() {
    if (this.failure) throw this.failure;
  }

  serialize(operation) {
    const result = this.pending.then(() => {
      this.ready();
      return operation();
    });
    this.pending = result.catch(() => {});
    return result;
  }

  async persist(snippets) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, snippets }, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.file);
    this.snippets = snippets;
  }

  find(id) {
    const snippet = uuidPattern.test(id) ? this.snippets.find(item => item.id === id) : undefined;
    if (!snippet) throw new LibraryError('找不到该片段', 404);
    return snippet;
  }

  trashRevision(snippets) {
    return createHash('sha256').update(this.trashScope)
      .update(JSON.stringify(snippets.map(({ id, trashedAt }) => [id, trashedAt]))).digest('hex');
  }

  checkEditLock(id, token) {
    this.editLocks.check(id, token, EDIT_BUSY, EDIT_EXPIRED);
  }

  acquireEditLock(id, input) {
    return this.serialize(() => {
      if (!hasExactFields(input, [])) throw new LibraryError('开始编辑仅接受空对象');
      const snippet = this.find(id);
      if (snippet.trashedAt !== null) throw new LibraryError('片段已在回收站，请先恢复后修改', 410);
      return { snippet, token: this.editLocks.acquire(id, EDIT_BUSY) };
    });
  }

  changeEditLock(id, input) {
    return this.serialize(() => this.editLocks.change(id, input, EDIT_BUSY, EDIT_EXPIRED));
  }

  list({ q = '', type = '', section = '', view = 'all' } = {}) {
    this.ready();
    if (typeof q !== 'string' || q.length > 512 || lineControl.test(q)) throw new LibraryError('检索词须为不超过 512 个字符的文字');
    if (type && !types.has(type)) throw new LibraryError('工程类别不在知识库分类中');
    if (typeof section !== 'string' || section.length > SNIPPET_LIMITS.section) throw new LibraryError('章节筛选无效');
    if (!['all', 'trash'].includes(view)) throw new LibraryError('view 仅接受 all 或 trash');
    const pool = this.snippets.filter(snippet => (snippet.trashedAt !== null) === (view === 'trash'));
    const terms = matchKey(q).split(/\s+/).filter(Boolean);
    const matched = pool.filter(snippet => {
      const haystack = matchKey([snippet.title, snippet.section, ...snippet.tags, snippet.body].join('\n'));
      return terms.every(term => haystack.includes(term));
    });
    // 类别数量不受类别筛选影响；章节数量按所选类别统计。
    const typeCounts = Object.fromEntries(KNOWLEDGE_CATEGORIES.map(category => [category.type, 0]));
    const sectionCounts = new Map();
    for (const snippet of matched) {
      typeCounts[snippet.type]++;
      if (type && snippet.type !== type) continue;
      const key = `${snippet.type}\n${snippet.section}`;
      sectionCounts.set(key, (sectionCounts.get(key) ?? 0) + 1);
    }
    const snippets = matched
      .filter(snippet => (!type || snippet.type === type) && (!section || snippet.section === section))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      snippets,
      total: this.snippets.filter(snippet => snippet.trashedAt === null).length,
      viewTotal: pool.length,
      ...(view === 'trash' ? { trashRevision: this.trashRevision(pool) } : {}),
      facets: {
        types: typeCounts,
        sections: [...sectionCounts].map(([key, count]) => {
          const [itemType, itemSection] = key.split('\n');
          return { type: itemType, section: itemSection, count };
        }),
      },
      categories: KNOWLEDGE_CATEGORIES,
    };
  }

  create(input) {
    return this.serialize(async () => {
      if (!hasExactFields(input, fields, { optional: ['format'] })) throw new LibraryError('新建片段需要 title、type、section、tags、body，格式可选');
      if (this.snippets.length >= MAX_SNIPPETS) throw new LibraryError(`知识库最多 ${MAX_SNIPPETS} 个片段`);
      const now = new Date().toISOString();
      const snippet = { id: randomUUID(), ...validate(input), createdAt: now, updatedAt: now, trashedAt: null };
      await this.persist([...this.snippets, snippet]);
      return snippet;
    });
  }

  update(id, input) {
    return this.serialize(async () => {
      const snippet = this.find(id);
      if (!hasExactFields(input, fields, { partial: true, optional: ['format', 'editToken'] })
        || !Object.keys(input).some(key => key !== 'editToken')) throw new LibraryError('修改片段包含未知字段或没有提供字段');
      const { editToken } = input;
      if (Object.hasOwn(input, 'editToken') && (typeof editToken !== 'string' || !uuidPattern.test(editToken))) {
        throw new LibraryError('请提供有效的编辑锁令牌');
      }
      if (snippet.trashedAt !== null) throw new LibraryError('片段已在回收站，请先恢复后修改', 410);
      this.checkEditLock(id, editToken);
      const changes = validate(input, snippet.body);
      const updated = { ...snippet, ...changes, updatedAt: new Date().toISOString() };
      if (updated.body !== snippet.body && !changes.format) delete updated.format;
      await this.persist(this.snippets.map(item => item.id === id ? updated : item));
      if (editToken) this.editLocks.delete(id);
      return updated;
    });
  }

  setTrash(id, input) {
    return this.serialize(async () => {
      const snippet = this.find(id);
      if (!hasExactFields(input, ['trashed']) || typeof input.trashed !== 'boolean') throw new LibraryError('回收站设置仅接受 trashed 布尔值');
      if ((snippet.trashedAt !== null) === input.trashed) return snippet;
      this.checkEditLock(id);
      const updated = { ...snippet, trashedAt: input.trashed ? new Date().toISOString() : null };
      await this.persist(this.snippets.map(item => item.id === id ? updated : item));
      return updated;
    });
  }

  purgeTrash(input) {
    return this.serialize(async () => {
      if (!hasExactFields(input, ['revision'], { optional: ['ids', 'all'] }) || typeof input.revision !== 'string'
        || !/^[0-9a-f]{64}$/.test(input.revision)) throw new LibraryError('请提供有效的回收站版本');
      const { ids, revision } = input;
      const hasIds = Object.hasOwn(input, 'ids');
      const hasAll = Object.hasOwn(input, 'all');
      if (hasIds === hasAll || (hasAll && input.all !== true)) throw new LibraryError('请指定要永久删除的片段，或明确选择清空回收站');
      if (hasIds && (!Array.isArray(ids) || !ids.length || ids.length > MAX_SNIPPETS
        || ids.some(id => typeof id !== 'string' || !uuidPattern.test(id)) || new Set(ids).size !== ids.length)) {
        throw new LibraryError('请提供有效且不重复的片段编号');
      }
      const trash = this.snippets.filter(snippet => snippet.trashedAt !== null);
      if (revision !== this.trashRevision(trash)) throw new LibraryError('回收站内容已变化，请刷新后重新确认', 409);
      const trashedIds = new Set(trash.map(snippet => snippet.id));
      if (ids?.some(id => !trashedIds.has(id))) throw new LibraryError('所选片段已不在回收站，请刷新后重新确认', 409);
      const removed = ids ? new Set(ids) : trashedIds;
      if (removed.size) await this.persist(this.snippets.filter(snippet => !removed.has(snippet.id)));
      return { purged: removed.size };
    });
  }
}
