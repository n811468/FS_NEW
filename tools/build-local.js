/**
 * 產生地端版：dist/FS-local.html —— 單一檔案，Chrome / Edge 雙擊就能用，不需要網路、伺服器或安裝任何東西。
 *
 *   node tools/build-local.js
 *
 * 內容全部來自原始檔，地端版沒有另外一份商業邏輯：
 *   - 後端：src/ 的 .gs 原檔，整段包進 FSBackendFactory(G) 函式裡(G = 模擬的 Apps Script 全域物件)，
 *     這樣 .gs 的全域函式/變數不會跟前端程式的同名函式互相蓋掉
 *   - 前端：src/index.html + style.html + src/ui/*.js(依檔名順序串成一段 script，見 tools/frontend.js)
 *   - 地端層：local/ 底下的模擬層、資料包、主機、工具列
 *   - 示範資料：跑 tools/dev-server.js 同一組示範資料，存成資料包內嵌在檔案裡(工具列「載入示範資料」)
 *
 * 改了 src/ 或 local/ 之後要重新執行一次再提交；tools/verify-local.js 會檢查 dist 是不是最新的。
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const GAS_DIR = path.join(REPO, 'src');
const LOCAL_DIR = path.join(REPO, 'local');
const OUT_FILE = path.join(REPO, 'dist', 'FS-local.html');
const EXCEL_OUT_FILE = path.join(REPO, 'dist', 'FS-excel-to-pack.html');

// 後端檔案(依載入順序)
const BACKEND_FILES = ['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs'];
// .gs 用到的 Apps Script 全域物件，由 local/gas-shim.js 的 createGlobals() 提供
const GAS_GLOBALS = ['SpreadsheetApp', 'LockService', 'CacheService', 'Utilities', 'Session', 'Logger'];
const EXPORTED_CONSTS = ['SCHEMA', 'TEXT_COLUMNS', 'PL_LINE_ITEMS', 'LINE_CODE_PREFIX'];

function read(file) { return fs.readFileSync(file, 'utf8'); }

/** 把 .gs 包成 function FSBackendFactory(G) { ... return { fns, consts, beginExecution } } */
function buildBackendSource() {
  const names = [];
  const parts = BACKEND_FILES.map(file => {
    const code = read(path.join(GAS_DIR, file));
    const re = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
    let m;
    while ((m = re.exec(code))) names.push(m[1]);
    return `// ===== src/${file} =====\n${code}`;
  });
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) throw new Error('後端有重複定義的函式：' + dupes.join(', '));
  return [
    '/* 由 tools/build-local.js 從 src/*.gs 產生，請勿直接修改 */',
    'function FSBackendFactory(G) {',
    GAS_GLOBALS.map(g => `  var ${g} = G.${g};`).join('\n'),
    parts.join('\n\n'),
    '  return {',
    `    fns: { ${names.map(n => `${n}: ${n}`).join(', ')} },`,
    `    consts: { ${EXPORTED_CONSTS.map(n => `${n}: ${n}`).join(', ')} },`,
    '    // 模擬 Apps Script「每次 google.script.run 都是全新執行」：單次執行內的快取要清掉',
    '    beginExecution: function () { SHEET_CACHE_ = {}; resetCalcMemo_(); LOCK_DEPTH_ = 0; }',
    '  };',
    '}'
  ].join('\n');
}

/** Node 端載入同一份後端原始碼(驗證用)，回傳 FSBackendFactory */
function loadBackendFactory() {
  // eslint-disable-next-line no-new-func
  return new Function(buildBackendSource() + '\nreturn FSBackendFactory;')();
}

/** 示範資料：跟 tools/dev-server.js 同一組，轉成資料包 */
function buildDemoPack() {
  const Pack = require('../local/pack.js');
  const { seedDemoData } = require('./dev-server');
  const gs = seedDemoData();
  const ss = gs.SpreadsheetApp.getActiveSpreadsheet();
  const tables = {};
  Pack.PACK_TABLES.forEach(name => {
    const sheet = ss.getSheetByName(name);
    const grid = sheet ? sheet.grid : [];
    const headers = grid[0] || [];
    tables[name] = grid.slice(1)
      .filter(row => row.some(v => v !== '' && v !== null && v !== undefined))
      .map(row => {
        const obj = {};
        headers.forEach((h, i) => { if (h) obj[h] = row[i] === undefined ? '' : row[i]; });
        return obj;
      });
  });
  // 固定的時間戳記：同樣的原始碼每次 build 出來的檔案要一模一樣，才能檢查 dist 有沒有過期
  return Pack.buildPack(tables, { exportedAt: '2026-01-01T00:00:00.000Z', exportedBy: '示範資料' });
}

function inlineScript(code) {
  // 內嵌的程式碼裡不能出現 </script>，否則瀏覽器會提早結束這個 <script> 區塊
  if (/<\/script/i.test(code)) throw new Error('內嵌的程式碼含有 </script>，無法放進單一檔案');
  return `<script>\n${code}\n</script>`;
}

function buildHtml() {
  let html = read(path.join(GAS_DIR, 'index.html'));
  html = html.replace(/<\?!=\s*include\('([^']+)'\);?\s*\?>/g, (m, name) => {
    if (name === 'script') return '<!--FS-LOCAL-FRONTEND-->';
    return read(path.join(GAS_DIR, name + '.html'));
  });
  if (/<\?/.test(html)) throw new Error('index.html 還有沒處理到的樣板語法');

  const demoJson = JSON.stringify(buildDemoPack()).replace(/</g, '\\u003c');
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>車型損益試算系統（地端版）</title>',
    `<style>\n${read(path.join(LOCAL_DIR, 'local-ui.css'))}\n</style>`
  ].join('\n');
  const boot = [
    inlineScript(read(path.join(LOCAL_DIR, 'gas-shim.js'))),
    inlineScript(read(path.join(LOCAL_DIR, 'pack.js'))),
    inlineScript(buildBackendSource()),
    inlineScript(read(path.join(LOCAL_DIR, 'host.js'))),
    `<script type="application/json" id="fs-demo-pack">${demoJson}</script>`,
    inlineScript(read(path.join(LOCAL_DIR, 'boot.js')))
  ].join('\n');

  html = html
    .replace('<base target="_top">', '')
    .replace('<html>', '<html lang="zh-Hant">')
    .replace('<head>', '<head>\n' + head)
    .replace('<body>', '<body>\n' + boot)
    .replace('<!--FS-LOCAL-FRONTEND-->',
      require('./frontend').frontendScript() + '\n' + inlineScript(read(path.join(LOCAL_DIR, 'local-ui.js'))));
  return '<!DOCTYPE html>\n<!-- 由 tools/build-local.js 產生，請勿直接修改；原始檔在 src/ 與 local/ -->\n' +
    html.replace(/^<!DOCTYPE html>\s*/i, '');
}

/**
 * 「Excel 轉資料包」工具：另一個單一檔案，同樣雙擊就能用。
 * 用的是同一份後端(.gs)與地端主機，資料只在記憶體裡建一次、驗算完就匯出成資料包，不碰系統的瀏覽器暫存。
 */
function buildExcelPackHtml() {
  const scripts = [
    read(path.join(LOCAL_DIR, 'gas-shim.js')),
    read(path.join(LOCAL_DIR, 'pack.js')),
    buildBackendSource(),
    read(path.join(LOCAL_DIR, 'host.js')),
    read(path.join(LOCAL_DIR, 'xlsx-reader.js')),
    read(path.join(LOCAL_DIR, 'excel-pack.js')),
    read(path.join(LOCAL_DIR, 'excel-pack-ui.js'))
  ].map(inlineScript).join('\n');
  const html = read(path.join(LOCAL_DIR, 'excel-pack.html'))
    .replace('<!--XP-STYLE-->', () => `<style>\n${read(path.join(LOCAL_DIR, 'excel-pack.css'))}\n</style>`)
    .replace('<!--XP-SCRIPTS-->', () => scripts);
  return '<!DOCTYPE html>\n<!-- 由 tools/build-local.js 產生，請勿直接修改；原始檔在 local/excel-pack* 與 src/ -->\n' +
    html.replace(/^<!DOCTYPE html>\s*/i, '');
}

function main() {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  [[OUT_FILE, buildHtml()], [EXCEL_OUT_FILE, buildExcelPackHtml()]].forEach(([file, html]) => {
    fs.writeFileSync(file, html);
    console.log(`已產生 ${path.relative(REPO, file)}（${(html.length / 1024).toFixed(0)} KB）`);
  });
}

if (require.main === module) main();
module.exports = { buildBackendSource, loadBackendFactory, buildDemoPack, buildHtml, buildExcelPackHtml, OUT_FILE, EXCEL_OUT_FILE };
