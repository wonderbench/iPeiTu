import { isSnippetFormat } from './knowledge-format.js';

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
        if (/^(?:[a-z][\w-]*)?(?:\.[\w-]+)?$/i.test(selector) && selector) {
          rules.push({ selector, css: match[2] });
          if (rules.length > 256) return null;
        }
      }
    }
  }
  rules.sort((a, b) => Number(a.selector.includes('.')) - Number(b.selector.includes('.')));
  const scratch = document.createElement('span').style;
  return element => {
    const matching = rules.filter(rule => element.matches(rule.selector)).map(rule => rule.css);
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

function readLine(element, styleFor) {
  const parents = [];
  for (let parent = element.parentElement; parent; parent = parent.parentElement) parents.unshift(parent);
  const inherited = parents.reduce((font, parent) => readFont(parent, styleFor(parent), font), {});
  const paragraph = readParagraph(element, styleFor(element));
  let text = '';
  const runs = [];
  function visit(node, font) {
    if (node.nodeType === Node.ELEMENT_NODE && !node.matches(ignored)) {
      const current = readFont(node, styleFor(node), font);
      for (const child of node.childNodes) visit(child, current);
    } else if (node.nodeType === Node.TEXT_NODE) {
      let value = node.data.replace(/[\t\r\n\f ]+/g, ' ').replace(/\u00a0/g, ' ');
      if (!text || text.endsWith(' ')) value = value.replace(/^ +/, '');
      if (!value) return;
      const start = text.length;
      text += value;
      if (!Object.keys(font).length) return;
      const last = runs.at(-1);
      if (last?.end === start && JSON.stringify(last.font) === JSON.stringify(font)) last.end = text.length;
      else runs.push({ start, end: text.length, font });
    }
  }
  visit(element, inherited);
  text = text.trimEnd();
  return { text, paragraph, runs: runs.filter(run => run.start < text.length).map(run => ({ ...run, end: Math.min(run.end, text.length) })) };
}

export function readFormattedPaste(html, plain, limit) {
  if (!html || html.length > 512_000) return null;
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
  const elements = [...root.querySelectorAll(blocks)].filter(element => !element.querySelector(blocks));
  const lines = (elements.length ? elements : [root]).map(element => readLine(element, styleFor));
  while (lines.length && !lines[0].text) lines.shift();
  while (lines.length && !lines.at(-1).text) lines.pop();
  const body = lines.map(line => line.text).join('\n');
  if (!body || body.length > limit || comparable(body) !== comparable(plain)
    || /[\x00-\x09\x0b-\x1f\x7f\u2028\u2029]/.test(body)) return null;
  // 连在同一段内的显式换行保留原生纯文字粘贴。
  if (root.querySelector('br') && elements.some(element => element.querySelector('br') && comparable(element.textContent))) return null;
  const format = lines.map(({ paragraph, runs }) => ({ paragraph, runs }));
  return isSnippetFormat(format, body) ? { body, format } : null;
}
