/**
 * 使用手冊有沒有跟上系統：
 *
 *   node tools/verify-manual.js
 *
 *   - docs/manual/README.md 是 index.html 產生的最新版(不是就執行 node tools/build-manual.js)
 *   - 手冊引用的圖都在、docs/manual/img 裡沒有沒用到的圖
 *   - 截圖是用目前的 dist/FS-local.html 截的：系統改了(重新 build 過)卻沒有重新截圖就算失敗，
 *     執行 node tools/manual-screens.js(需要 Playwright；Excel 畫面需要 LibreOffice)
 *   - 系統的每一頁(左側導覽)在手冊裡都有寫到
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildManualMarkdown, SRC, OUT, MANUAL_DIR } = require('./build-manual');

const REPO = path.join(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'FS-local.html');
const IMG = path.join(MANUAL_DIR, 'img');
const failures = [];
let checks = 0;
function check(cond, msg) { checks++; if (!cond) failures.push(msg); }

const html = fs.readFileSync(SRC, 'utf8');

// 1. README.md 是最新的
check(fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === buildManualMarkdown(html),
  'docs/manual/README.md 不是 index.html 的最新版：執行 node tools/build-manual.js');

// 2. 圖都在、沒有多的
const used = {};
html.replace(/src="img\/([^"]+)"/g, (m, f) => { used[f] = true; return m; });
Object.keys(used).forEach(f => check(fs.existsSync(path.join(IMG, f)), '手冊引用的圖不存在：img/' + f));
fs.readdirSync(IMG).filter(f => /\.png$/.test(f)).forEach(f => check(used[f], '沒有用到的圖：img/' + f + '（手冊沒引用就刪掉，或在 index.html 補上說明）'));

// 3. 截圖是目前這一版系統截的
const sourceFile = path.join(IMG, '.source');
const distHash = crypto.createHash('sha256').update(fs.readFileSync(DIST)).digest('hex');
const shotHash = fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, 'utf8').trim() : '';
check(shotHash === distHash, '系統(dist/FS-local.html)在截圖之後改過：執行 node tools/manual-screens.js 重新截圖，' +
  '再看一次 docs/manual/index.html 的說明有沒有要跟著改，最後 node tools/build-manual.js');

// 4. 每一頁都有寫到：左側導覽的頁名要出現在手冊裡
const index = fs.readFileSync(path.join(REPO, 'src', 'index.html'), 'utf8');
const pages = [];
index.replace(/data-tab="[^"]+"[^>]*>\s*<svg[\s\S]*?<\/svg>([^<]+)/g, (m, name) => { pages.push(name.trim()); return m; });
check(pages.length >= 8, '讀不到左側導覽的頁名');
const text = html.replace(/<[^>]+>/g, '');
pages.forEach(p => check(text.indexOf(p) !== -1, '手冊沒有寫到「' + p + '」這一頁'));

if (failures.length) {
  failures.forEach(f => console.log('  ✗ ' + f));
  console.log(`\n使用手冊：${failures.length} 項沒跟上`);
  process.exit(1);
}
console.log(`使用手冊：${checks} 項全部符合（README.md 最新、圖都在、截圖是目前這一版系統、每一頁都有寫到）`);
