/**
 * 讀寫 .xlsx 的共用小工具(驗證腳本用，不需要任何套件)：解壓縮、讀數值格、找 LibreOffice、拿掉快取值。
 * verify-excel.js 與 verify-formula-reliability.js 共用。
 */
const zlib = require('zlib');
const { execFileSync } = require('child_process');

/* ---------- 讀 zip(LibreOffice 存的檔案是 deflate 壓縮) ---------- */
function readZip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(offset + 26), lExtraLen = buf.readUInt16LE(offset + 28);
    const data = buf.slice(offset + 30 + lNameLen + lExtraLen, offset + 30 + lNameLen + lExtraLen + size);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
/** 讀出每張工作表的數值格 { 工作表名稱: { A1: 數字 } }(文字格不需要) */
function readNumbers(buf) {
  const files = readZip(buf);
  const wb = files['xl/workbook.xml'].toString('utf8');
  const rels = files['xl/_rels/workbook.xml.rels'].toString('utf8');
  const out = {};
  const sheetRe = /<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g;
  let m;
  while ((m = sheetRe.exec(wb))) {
    const target = new RegExp('Id="' + m[2] + '"[^>]*Target="([^"]+)"').exec(rels) || new RegExp('Target="([^"]+)"[^>]*Id="' + m[2] + '"').exec(rels);
    const xml = files['xl/' + target[1].replace(/^\/?xl\//, '')].toString('utf8');
    const cells = {};
    const cellRe = /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = cellRe.exec(xml))) {
      if (/t="(s|str|inlineStr|e|b)"/.test(c[2])) continue;
      const v = /<v>([^<]*)<\/v>/.exec(c[3] || '');
      if (v) cells[c[1]] = Number(v[1]);
    }
    out[m[1].replace(/&amp;/g, '&')] = cells;
  }
  return out;
}

function findSoffice() {
  for (const cmd of ['soffice', 'libreoffice']) {
    try { execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 60000 }); return cmd; } catch (e) { /* 試下一個 */ }
  }
  return null;
}

/** xlsx → { 檔名: 文字 }(跟前端送給後端的一樣) */
function textFiles(buf) {
  const files = readZip(buf), out = {};
  Object.keys(files).forEach(k => { if (/\.(xml|rels)$/.test(k)) out[k] = files[k].toString('utf8'); });
  return out;
}
/** 直接改 xlsx 裡的格子(模擬使用者在 Excel 改)：f 改公式、v 改成數字 */
function editor(files, built) {
  const names = built.model.sheets.map(s => s.name);
  const fileOf = sheet => 'xl/worksheets/sheet' + (names.indexOf(sheet) + 1) + '.xml';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const put = (sheet, ref, inner) => {
    const f = fileOf(sheet);
    const re = new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>[\\s\\S]*?</c>)');
    if (!re.test(files[f])) throw new Error('找不到格子 ' + sheet + '!' + ref);
    files[f] = files[f].replace(re, (m, attrs) => '<c r="' + ref + '"' + attrs.replace(/\st="[^"]*"/, '') + '>' + inner + '</c>');
  };
  const input = built.model.sheets[names.indexOf('輸入')].rows;
  return {
    f: (sheet, ref, formula) => put(sheet, ref, '<f>' + esc(formula) + '</f>'),
    v: (sheet, ref, value) => put(sheet, ref, '<v>' + value + '</v>'),
    inRow: label => input.findIndex(r => r && r[0] && r[0].v === label) + 1
  };
}

/** 拿掉公式格的快取值，強迫 LibreOffice 自己算 */
function stripCache(model) {
  model.sheets.forEach(s => (s.rows || []).forEach(row => (row || []).forEach(c => { if (c && typeof c === 'object' && c.f) delete c.v; })));
  return model;
}

module.exports = { readZip, readNumbers, findSoffice, textFiles, editor, stripCache };
