import { isSnippetFormat } from './knowledge-format.js';
import { MAX_RELATIVE_LEVEL } from './knowledge-bridge.js';

const blocks = 'p,h1,h2,h3,h4,h5,h6,div';
const ignored = 'style,script,link,meta,title,xml,[hidden]';
const fontName = value => value.split(',')[0].trim().replace(/^["']|["']$/g, '');
const comparable = value => value.replace(/\s+/g, ' ').trim();

function points(value) {
  const match = /^(-?\d+(?:\.\d+)?)(pt|px|in|cm|mm)$/.exec(value);
  const factor = { pt: 1, px: 0.75, in: 72, cm: 72 / 2.54, mm: 72 / 25.4 };
  return match ? Math.round(Number(match[1]) * factor[match[2]] * 100) / 100 : value === '0' ? 0 : undefined;
}

// Word often stores paragraph styles in rules such as p.MsoNormal.
function makeStyleReader(fragment) {
  const rules = [];
  for (const node of fragment.querySelectorAll('style')) {
    const css = node.textContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->/g, '');
    for (const match of css.matchAll(/(?:^|[{}])\s*([^{}]+)\{([^{}]*)/g)) {
      for (const raw of match[1].split(',')) {
        const selector = raw.trim();
        const parts = /^(?:([a-z][\w-]*))?(?:\.([\w-]+))?$/i.exec(selector);
        if (parts && selector) {
          // WPS 导出的类名可以是数字，例如 p.15，不能直接交给 matches()。
          rules.push({ tag: parts[1]?.toLowerCase(), className: parts[2], css: match[2] });
          if (rules.length > 256) return null;
        }
      }
    }
  }
  rules.sort((a, b) => Number(Boolean(a.className)) - Number(Boolean(b.className)));
  const scratch = document.createElement('span').style;
  return element => {
    const matching = rules.filter(({ tag, className }) => (!tag || element.localName === tag)
      && (!className || element.classList.contains(className))).map(rule => rule.css);
    matching.push(element.getAttribute('style') ?? '');
    const css = matching.join(';');
    scratch.cssText = css;
    return {
      style: scratch,
      office(property) {
        const pattern = new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;]+)', 'gi');
        return [...css.matchAll(pattern)].at(-1)?.[1].trim() ?? '';
      },
    };
  };
}

function readFont(element, { style, office }, inherited) {
  const font = { ...inherited };
  const tag = element.localName;
  if (/^h[1-6]$/.test(tag) || tag === 'b' || tag === 'strong') font.Bold = true;
  if (tag === 'i' || tag === 'em') font.Italic = true;
  if (tag === 'u') font.Underline = 1;
  if (style.fontWeight) font.Bold = /^(bold|bolder|[6-9]00)$/.test(style.fontWeight);
  if (style.fontStyle) font.Italic = /^(italic|oblique)/.test(style.fontStyle);
  if (style.textDecorationLine) font.Underline = style.textDecorationLine.includes('underline') ? 1 : 0;
  const name = fontName(style.fontFamily || element.getAttribute('face') || '');
  const eastAsian = fontName(office('mso-fareast-font-family'));
  if (name) font.Name = name;
  if (eastAsian || name) font.NameFarEast = eastAsian || name;
  const size = points(style.fontSize);
  if (size > 0) font.Size = size;
  const rgb = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(style.color);
  if (rgb) font.Color = Number(rgb[1]) + 256 * Number(rgb[2]) + 65536 * Number(rgb[3]);
  return font;
}

function readParagraph(element, { style, office }) {
  const result = {};
  const alignment = { left: 0, center: 1, right: 2, justify: 3 };
  const align = style.textAlign || element.getAttribute('align');
  if (Object.hasOwn(alignment, align)) result.Alignment = alignment[align];
  const charIndent = /^(-?\d+(?:\.\d+)?)em$/.exec(style.textIndent);
  if (charIndent) result.CharacterUnitFirstLineIndent = Number(charIndent[1]);
  const lengths = {
    textIndent: 'FirstLineIndent', marginLeft: 'LeftIndent', marginRight: 'RightIndent',
    marginTop: 'SpaceBefore', marginBottom: 'SpaceAfter',
  };
  for (const [property, field] of Object.entries(lengths)) {
    const value = points(style[property]);
    if (value !== undefined) result[field] = field.startsWith('Space') ? Math.max(value, 0) : value;
  }
  const line = style.lineHeight;
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(line);
  const multiplier = percent ? Number(percent[1]) / 100 : /^(?:\d+\.?\d*|\.\d+)$/.test(line) ? Number(line) : null;
  const fixed = points(line);
  if (line === 'normal' || multiplier === 1) {
    result.LineSpacingRule = 0;
  } else if (multiplier > 0) {
    result.LineSpacingRule = 5; // WPS 以 12 磅表示一行。
    result.LineSpacing = multiplier * 12;
  } else if (fixed > 0) {
    result.LineSpacingRule = office('mso-line-height-rule') === 'exactly' ? 4 : 3;
    result.LineSpacing = fixed;
  }
  return result;
}

function readLine(element, styleFor, children = element.childNodes) {
  const parents = [];
  for (let parent = element.parentElement; parent; parent = parent.parentElement) parents.unshift(parent);
  const inherited = parents.reduce((font, parent) => readFont(parent, styleFor(parent), font), {});
  const formatting = styleFor(element);
  const paragraph = readParagraph(element, formatting);
  const level = Number(/^h([1-6])$/.exec(element.localName)?.[1]
    ?? /^[1-9]$/.exec(formatting.office('mso-outline-level'))?.[0] ?? 0);
  const font = readFont(element, formatting, inherited);
  let text = '';
  let hasBreak = false;
  const runs = [];
  function visit(node, parentFont) {
    if (node.nodeType === Node.ELEMENT_NODE && !node.matches(ignored)) {
      if (node.localName === 'br') hasBreak = true;
      const current = readFont(node, styleFor(node), parentFont);
      for (const child of node.childNodes) visit(child, current);
    } else if (node.nodeType === Node.TEXT_NODE) {
      let value = node.data.replace(/[\t\r\n\f ]+/g, ' ').replace(/\u00a0/g, ' ');
      if (!text || text.endsWith(' ')) value = value.replace(/^ +/, '');
      if (!value) return;
      const start = text.length;
      text += value;
      if (!Object.keys(parentFont).length) return;
      const last = runs.at(-1);
      if (last?.end === start && JSON.stringify(last.font) === JSON.stringify(parentFont)) last.end = text.length;
      else runs.push({ start, end: text.length, font: parentFont });
    }
  }
  for (const child of children) visit(child, font);
  text = text.trimEnd();
  return { text, paragraph, level, hasBreak,
    runs: runs.filter(run => run.start < text.length).map(run => ({ ...run, end: Math.min(run.end, text.length) })) };
}

function readLines(root, styleFor) {
  const lines = [];
  function collect(element) {
    if (!element.querySelector(blocks)) {
      lines.push(readLine(element, styleFor));
      return;
    }
    let inline = [];
    function flush() {
      if (!inline.length) return;
      const line = readLine(element, styleFor, inline);
      if (line.text) lines.push(line);
      inline = [];
    }
    // WPS 的选区终止于段落标记之前时，末段可能只剩一组行内节点。
    for (const child of element.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && !child.matches(ignored)
        && (child.matches(blocks) || child.querySelector(blocks))) {
        flush();
        collect(child);
      } else inline.push(child);
    }
    flush();
  }
  collect(root);
  return lines;
}

export function readFormattedPaste(html, plain, limit) {
  if (!html || html.length > 512_000) return null;
  const documentStart = /^Version:/i.test(html) ? html.search(/<html[\s>]/i) : -1;
  if (documentStart > 0) html = html.slice(documentStart);
  // 模板内容保持惰性，剪贴板节点不进入页面，也不保存原始 HTML。
  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;
  if (fragment.querySelector('table,ol,ul,img,svg,math,object,iframe')) return null;
  if (fragment.querySelectorAll('*').length > 4096) return null;
  const container = document.createElement('div');
  // 保持节点在模板文档内，避免触发剪贴板内的资源加载或自定义元素。
  const root = fragment.ownerDocument.adoptNode(container);
  root.append(fragment);
  const styleFor = makeStyleReader(root);
  if (!styleFor) return null;
  const lines = readLines(root, styleFor);
  while (lines.length && !lines[0].text) lines.shift();
  while (lines.length && !lines.at(-1).text) lines.pop();
  const text = lines.map(line => line.text).join('\n');
  if (!text || text.length > limit || comparable(text) !== comparable(plain)
    || /[\x00-\x09\x0b-\x1f\x7f\u2028\u2029]/.test(text)) return null;
  // 连在同一段内的显式换行保留原生纯文字粘贴。
  if (lines.some(line => line.text && line.hasBreak)) return null;
  const levels = lines.filter(line => line.text && line.level).map(line => line.level);
  const top = levels.length ? Math.min(...levels) : 0;
  const prefixes = lines.map(line => line.text && line.level
    ? `${'#'.repeat(Math.min(MAX_RELATIVE_LEVEL, line.level - top + 1))} ` : '');
  const body = lines.map((line, index) => prefixes[index] + line.text).join('\n');
  if (body.length > limit) return null;
  const format = lines.map(({ paragraph, runs }, index) => {
    const offset = prefixes[index].length;
    if (!offset) return { paragraph, runs };
    return {
      paragraph, heading: true,
      runs: runs.map(run => ({ ...run, start: run.start + offset, end: run.end + offset })),
    };
  });
  return isSnippetFormat(format, body) ? { body, format } : null;
}
