/**
 * 測試用的 .xlsx：在 Node 上自己組出 Excel 活頁簿(zip + XML)，給「Excel 轉資料包」的驗證與瀏覽器測試用。
 * 不用真實的公司檔案；版面刻意跟 D5X 不一樣(有 C 生產毛利、四段損益鏈、K 前面有兩個扣項、三個車系)，
 * 確認判斷邏輯是通用的，不是只認得某一份 Excel。
 *
 * 儲存格的快取值(<v>)由這裡用 JS 照公式算好寫進去 —— Excel 存檔時也是這樣把算好的值一起存下來。
 */
const zlib = require('zlib');

/* ---------------- zip ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  Object.keys(files).forEach(name => {
    const data = Buffer.from(files[name], 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}

/* ---------------- xlsx ---------------- */
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const parseRef = ref => { const m = /^([A-Z]+)(\d+)$/.exec(ref); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return { r: +m[2], c }; };

/**
 * sheets: [{ name, hidden, cells: { A1: 值 | { v, f, shared: { si, ref } } | { v, si } }, merges: ['D3:F3'] }]
 * 文字一律寫進共用字串表，只有 inline: true 的寫成 inlineStr(兩種 Excel 都會產生)。
 */
function makeXlsx(sheets) {
  const strings = [], stringIdx = {};
  const sst = s => { if (!(s in stringIdx)) { stringIdx[s] = strings.length; strings.push(s); } return stringIdx[s]; };
  const files = {};
  sheets.forEach((sh, i) => {
    const byRow = {};
    Object.keys(sh.cells).forEach(ref => {
      const p = parseRef(ref);
      (byRow[p.r] = byRow[p.r] || []).push({ ref, c: p.c, spec: sh.cells[ref] });
    });
    const rows = Object.keys(byRow).map(Number).sort((a, b) => a - b).map(r => {
      const cells = byRow[r].sort((a, b) => a.c - b.c).map(({ ref, spec }) => {
        const o = spec !== null && typeof spec === 'object' ? spec : { v: spec };
        let f = '';
        if (o.shared) f = `<f t="shared" ref="${o.shared.ref}" si="${o.shared.si}">${xmlEsc(o.f)}</f>`;
        else if (o.si !== undefined) f = `<f t="shared" si="${o.si}"/>`;
        else if (o.f) f = `<f>${xmlEsc(o.f)}</f>`;
        if (typeof o.v === 'string') {
          if (o.inline) return `<c r="${ref}" t="inlineStr">${f}<is><t>${xmlEsc(o.v)}</t></is></c>`;
          return `<c r="${ref}" t="s">${f}<v>${sst(o.v)}</v></c>`;
        }
        if (o.v === null || o.v === undefined) return `<c r="${ref}">${f}</c>`;
        return `<c r="${ref}">${f}<v>${o.v}</v></c>`;
      }).join('');
      return `<row r="${r}">${cells}</row>`;
    }).join('');
    const merges = (sh.merges || []).length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="20"/></cols><sheetData>${rows}</sheetData>${merges}</worksheet>`;
  });
  files['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
    sheets.map((sh, i) => `<sheet name="${xmlEsc(sh.name)}" sheetId="${i + 1}"${sh.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    sheets.map((sh, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  files['xl/sharedStrings.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}">${
    strings.map(s => `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`).join('')}</sst>`;
  files['[Content_Types].xml'] = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
  return zip(files);
}

/* ---------------- 測試用的 FS 版面 ---------------- */
const VEH = ['D', 'E', 'F'];
const round = (x, d) => { const p = Math.pow(10, d || 0); return Math.sign(x) * Math.round(Math.abs(x) * p) / p; };

/**
 * 三個車系 + 加權欄的 FS。opts 調整輸入數字，用來做「同版面的第二個分頁」。
 * 回傳 { sheet, expected: { 列號: [各車系值, 加權] } }
 */
function fullFs(name, opts) {
  opts = Object.assign({ lp: 1, promo: 0 }, opts);
  const mix = [0.2, 0.3, 0.5];
  const input = {
    7: [1000000, 1050000, 1299000],
    8: [3990, 3990, 3990],
    15: [433466, 506850, 581823].map(v => round(v * opts.lp, 2)),
    16: [372148, 372148, 372148],
    17: [3391, 3391, 3391],
    18: [18232, 18480, 18626.5],
    19: [29526, 29934, 30011],
    22: [5556, 5556, 5556],
    23: [23158, 23158, 23158].map(v => v - opts.promo),
    25: [3196, 3196, 3196],
    27: [41131, 41131, 41131],
    29: [0, 0, 0],
    30: [2164, 2164, 2164]
  };
  const val = {};
  Object.keys(input).forEach(r => { val[r] = input[r].slice(); });
  const per = fn => [0, 1, 2].map(fn);
  val[9] = per(i => val[7][i] - val[8][i]);
  val[10] = per(i => round(val[9][i] / 1.05 * 0.05));
  val[11] = per(i => round((val[9][i] - val[10][i]) * 0.07));
  val[12] = per(i => val[9][i] - val[10][i] - val[11][i]);
  val[14] = per(i => val[15][i] + val[16][i] + val[17][i]);
  val[20] = per(i => round(val[12][i] * 0.1));
  val[13] = per(i => val[14][i] + val[18][i] + val[19][i] + val[20][i]);
  val[21] = per(i => val[12][i] - val[13][i]);
  val[24] = per(i => val[21][i] - (val[22][i] + val[23][i]));
  val[26] = per(i => val[24][i] - val[25][i]);
  val[28] = per(i => val[26][i] - val[27][i]);
  val[31] = per(i => val[28][i] - val[29][i] - val[30][i]);

  const formulas = {
    9: c => `${c}7-${c}8`, 10: c => `ROUND(${c}9/1.05*0.05,0)`, 11: c => `ROUND((${c}9-${c}10)*0.07,0)`,
    12: c => `${c}9-${c}10-${c}11`, 13: c => `${c}14+${c}18+SUM(${c}19:${c}20)`, 14: c => `SUM(${c}15:${c}17)`,
    20: c => `ROUND(${c}12*0.1,0)`, 21: c => `${c}12-${c}13`, 24: c => `${c}21-SUM(${c}22:${c}23)`,
    26: c => `${c}24-${c}25`, 28: c => `${c}26-${c}27`, 31: c => `${c}28-${c}29-${c}30`
  };
  const labels = {
    6: '構成比', 7: '建議零售價(含稅)', 8: '廢車處理費(含稅)', 9: '實際零售價(含稅)', 10: '營業稅', 11: '銷售佣金',
    12: '廠價(未稅)', 13: '銷貨成本合計', 14: '材料成本', 15: '材料成本-LP', 16: '材料成本-KD', 17: '內陸運雜',
    18: '直接人工', 19: '製造費用', 20: '貨物稅', 21: '生產毛利', 22: '廣宣費用', 23: '促銷', 24: '銷貨毛利',
    25: '直接歸屬費用', 26: '產品貢獻', 27: '固定營業費用', 28: '營業淨利(未扣前瞻)', 29: '前瞻費用', 30: '品牌分攤', 31: '營業淨利'
  };
  const cells = {
    B2: 'DQ 損益試算', D3: 'DQ 開發案', D4: '3人貨車', E4: '9人商用', F4: '9人接駁', G4: '加權平均',
    D5: 'TWD', E5: 'TWD', F5: 'TWD', G5: 'TWD', H4: '3人貨車', H5: '%', J5: '說明',
    B33: { v: '單位：元', inline: true }
  };
  Object.keys(labels).forEach(r => { cells['B' + r] = labels[r]; });
  VEH.forEach((c, i) => { cells[c + 6] = mix[i]; });
  cells.G6 = { f: 'SUM(D6:F6)', v: 1 };
  const expected = {};
  Object.keys(val).forEach(r => {
    const w = val[r].reduce((s, v, i) => s + v * mix[i], 0);
    expected[r] = val[r].concat([w]);
    VEH.forEach((c, i) => {
      const f = formulas[r];
      // 第 9 列用水平共用公式(D9 存全文，E9/F9 只寫共用編號)，其他列每格各自一段公式
      if (f && +r === 9) cells[c + r] = i === 0 ? { f: f(c), v: val[r][i], shared: { si: 1, ref: 'D9:F9' } } : { si: 1, v: val[r][i] };
      else cells[c + r] = f ? { f: f(c), v: val[r][i] } : val[r][i];
    });
    // 加權欄：往下拖曳的共用公式(G7 存全文)
    cells['G' + r] = +r === 7 ? { f: 'D7*$D$6+E7*$E$6+F7*$F$6', v: w, shared: { si: 0, ref: 'G7:G31' } } : { si: 0, v: w };
    cells['H' + r] = { f: `D${r}/D$12`, v: val[r][0] / val[12][0] };
  });
  cells.J20 = '廠價 × 10%';
  cells.J15 = '依 BOM 估算 & 含運費 <暫估>';
  return { sheet: { name, cells, merges: ['D3:G3'] }, expected };
}

/** 沒有售價結構、只有收入與成本的極簡版面(科目名稱在 A 欄、兩個車系、沒有加權欄) */
function minimalFs() {
  const v = { 2: [900000, 950000], 3: [600000, 640000], 4: [50000, 52000] };
  v[5] = [0, 1].map(i => v[3][i] + v[4][i]);
  v[6] = [0, 1].map(i => v[2][i] - v[5][i]);
  const cells = { B1: '車型A', C1: '車型B', A2: '收入', A3: '材料', A4: '人工', A5: '成本合計', A6: '毛利' };
  ['B', 'C'].forEach((c, i) => {
    cells[c + 2] = v[2][i]; cells[c + 3] = v[3][i]; cells[c + 4] = v[4][i];
    cells[c + 5] = { f: `SUM(${c}3:${c}4)`, v: v[5][i] };
    cells[c + 6] = { f: `${c}2-${c}5`, v: v[6][i] };
  });
  return { sheet: { name: 'XS 簡表', cells }, expected: v };
}

function fixtureWorkbook() {
  const a = fullFs('DQ FS_現況');
  const b = fullFs('DQ FS_目標', { lp: 0.95, promo: 3000 });
  const other = { name: '參數', hidden: true, cells: { A1: '匯率', B1: 4.65 } };
  return { bytes: makeXlsx([a.sheet, b.sheet, other]), expected: [a.expected, b.expected] };
}

module.exports = { makeXlsx, fullFs, minimalFs, fixtureWorkbook, crc32 };
