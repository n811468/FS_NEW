/**
 * 使用手冊的 Markdown 版：docs/manual/index.html → docs/manual/README.md
 *
 *   node tools/build-manual.js
 *
 * GitHub 上點開 .html 只看得到原始碼，README.md 會直接顯示成有圖的文件；兩份內容相同，
 * 只改 index.html(唯一的原稿)，再執行這支產生 README.md。tools/verify-manual.js 會檢查 README.md 是不是最新的。
 *
 * 只處理手冊用到的標籤：h1~h3、p、ul、ol、table、figure/img/figcaption、提示框(div.tip / div.warn)、
 * 行內的 b/strong/code/kbd/a 與介面按鈕(span.ui)、圖上的編號(span.callout-no)。
 * 粗體一律輸出 <b>：Markdown 的 **粗體** 以全形標點結尾、後面緊接中文時(「**注意：**請…」)GitHub 不會當成粗體。
 */
const fs = require('fs');
const path = require('path');

const MANUAL_DIR = path.join(__dirname, '..', 'docs', 'manual');
const SRC = path.join(MANUAL_DIR, 'index.html');
const OUT = path.join(MANUAL_DIR, 'README.md');

const VOID = { img: 1, meta: 1, link: 1, br: 1, input: 1, hr: 1 };

/** 很小的 HTML 解析器：只要能把手冊的標籤排成一棵樹 */
function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?([a-zA-Z0-9]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[3] !== undefined) { top.children.push({ text: m[3] }); continue; }
    if (!m[1]) continue;
    const tag = m[1].toLowerCase();
    if (m[0].charAt(1) === '/') {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const attrs = {};
    (m[2] || '').replace(/([^\s=]+)(?:="([^"]*)")?/g, (x, k, v) => { attrs[k] = v === undefined ? '' : v; return x; });
    const node = { tag, attrs, children: [] };
    top.children.push(node);
    if (!VOID[tag] && !/\/>$/.test(m[0])) stack.push(node);
  }
  return root;
}

const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const hasClass = (n, c) => (' ' + (n.attrs && n.attrs.class || '') + ' ').indexOf(' ' + c + ' ') !== -1;
const CIRCLED = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

/** 行內內容 → Markdown 文字(空白收成一格) */
function inline(n, opts) {
  opts = opts || {};
  if (n.text !== undefined) return decode(n.text).replace(/\s+/g, ' ');
  const inner = () => n.children.map(c => inline(c, opts)).join('');
  switch (n.tag) {
    case 'b': case 'strong': { const t = inner().trim(); return t ? '<b>' + t + '</b>' : ''; }
    case 'code': { const t = decode(textOf(n)); return '`' + t + '`'; }
    case 'kbd': return '<kbd>' + inner().trim() + '</kbd>';
    case 'a': {
      const t = inner().trim();
      const href = n.attrs.href || '';
      return href && href.charAt(0) !== '#' ? '[' + t + '](' + href + ')' : t;
    }
    case 'span':
      if (hasClass(n, 'callout-no')) { const k = Number(textOf(n).trim()); return (CIRCLED[k] || '(' + k + ')') + ' '; }
      if (hasClass(n, 'ui')) return '<b>' + inner().trim() + '</b>';
      return inner();
    case 'br': return opts.table ? '<br>' : '  \n';
    default: return inner();
  }
}
/** 章標題：章號(span.no)後面加「. 」 */
function h2Text(n) {
  return n.children.map(c => c.tag === 'span' && hasClass(c, 'no') ? clean(textOf(c)) + '. ' : inline(c)).join('').replace(/\s+/g, ' ').trim();
}
function textOf(n) { return n.text !== undefined ? n.text : n.children.map(textOf).join(''); }
const clean = s => s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();

function table(n) {
  const rows = [];
  (function walk(x) {
    if (x.tag === 'tr') rows.push(x.children.filter(c => c.tag === 'td' || c.tag === 'th'));
    else (x.children || []).forEach(walk);
  })(n);
  if (!rows.length) return '';
  const cell = c => clean(inline(c, { table: true })).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = rows[0].map(cell);
  const out = ['| ' + head.join(' | ') + ' |', '|' + head.map(() => ' --- ').join('|') + '|'];
  rows.slice(1).forEach(r => out.push('| ' + r.map(cell).join(' | ') + ' |'));
  return out.join('\n');
}

function figure(n) {
  const img = find(n, 'img');
  const cap = find(n, 'figcaption');
  const out = [];
  if (img) out.push('![' + (img.attrs.alt || '') + '](' + img.attrs.src + ')');
  if (cap) out.push('', '<sub>' + clean(inline(cap)).replace(/<b>(圖 [\d-]+)<\/b>\s*/, '<b>$1</b>　') + '</sub>');
  return out.join('\n');
}
function find(n, tag) {
  if (n.tag === tag) return n;
  for (const c of n.children || []) { const f = find(c, tag); if (f) return f; }
  return null;
}

/** 區塊 → Markdown 段落陣列 */
function blocks(n, out) {
  (n.children || []).forEach(c => {
    if (c.text !== undefined) { const t = clean(decode(c.text)); if (t) out.push(t); return; }
    const t = c.tag;
    if (t === 'head' || t === 'style' || t === 'script' || t === 'nav' || t === 'title') return;
    if (t === 'h1') out.push('# ' + clean(inline(c)));
    else if (t === 'h2') out.push('## ' + h2Text(c));
    else if (t === 'h3') out.push('### ' + clean(inline(c)));
    else if (t === 'p') { const s = clean(inline(c)); if (s) out.push(s); }
    else if (t === 'ul' || t === 'ol') {
      let k = 0;
      out.push(c.children.filter(x => x.tag === 'li').map(li => (t === 'ol' ? (++k) + '. ' : '- ') + clean(inline(li))).join('\n'));
    } else if (t === 'figure') out.push(figure(c));
    else if (t === 'table') out.push(table(c));
    else if (t === 'div' && (hasClass(c, 'tip') || hasClass(c, 'warn'))) out.push('> ' + clean(inline(c)));
    else if (t === 'div' && hasClass(c, 'eyebrow')) { /* 版面上的小標題，Markdown 不需要 */ }
    else if (t === 'div' && hasClass(c, 'brand')) { /* 目錄上的標誌 */ }
    else if (t === 'div' && hasClass(c, 'flow')) {
      out.push('<b>工作流程：</b>' + c.children.filter(x => x.tag === 'span').map(x => clean(inline(x))).join(' → '));
    } else if (t === 'footer') out.push('---', clean(inline(c)));
    else blocks(c, out);
  });
  return out;
}

/** 目錄：照 h2/h3 產生，連結用 GitHub 自動產生的標題錨點 */
function toc(root) {
  const items = [];
  (function walk(n) {
    if (n.tag === 'h2' || n.tag === 'h3') items.push({ level: n.tag === 'h2' ? 2 : 3, text: n.tag === 'h2' ? h2Text(n) : clean(inline(n)) });
    (n.children || []).forEach(walk);
  })(find(root, 'main') || root);
  const used = {};
  const anchor = t => {
    let a = t.replace(/<[^>]+>/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    if (used[a] !== undefined) { used[a]++; a += '-' + used[a]; } else used[a] = 0;
    return a;
  };
  return items.map(i => (i.level === 3 ? '  ' : '') + '- [' + i.text + '](#' + anchor(i.text) + ')').join('\n');
}

function buildManualMarkdown(html) {
  const root = parseHtml(html);
  const main = find(root, 'main');
  const parts = blocks(main, []);
  // 封面(h1 + 說明 + 流程)之後插入目錄
  const firstH2 = parts.findIndex(p => /^## /.test(p));
  parts.splice(firstH2, 0, '## 目錄', toc(root));
  return '<!-- 由 tools/build-manual.js 從 docs/manual/index.html 產生，請勿直接修改：改 index.html 後執行 node tools/build-manual.js -->\n\n' +
    parts.join('\n\n') + '\n';
}

function main() {
  const md = buildManualMarkdown(fs.readFileSync(SRC, 'utf8'));
  fs.writeFileSync(OUT, md);
  console.log(`已產生 ${path.relative(path.join(__dirname, '..'), OUT)}（${md.split('\n').length} 行）`);
}

if (require.main === module) main();
module.exports = { buildManualMarkdown, SRC, OUT, MANUAL_DIR };
