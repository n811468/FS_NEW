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
const RMB = ['K', 'L', 'M'];   // 每個車系的 RMB 報價欄(不是車系欄，同一列 × 匯率)
const round = (x, d) => { const p = Math.pow(10, d || 0); return Math.sign(x) * Math.round(Math.abs(x) * p) / p; };

/**
 * 三個車系 + 加權欄的 FS，明細刻意涵蓋各種 Excel 公式寫法(見 local/excel-formula.js 的轉換規則)：
 *   16 材料成本-KD   =K16*$P$9*(1+$P$8)      RMB 欄 × 匯率 × (1+關稅率)       → 公式 + 車系別參數 + [CNY匯率] + [關稅率]
 *   17 內陸運雜      =-2^2+D16*0+3387          Excel 先算 (-2)^2(=4)            → 系統算 -(2^2)，對不起來 → 自動改回數字
 *   18 直接人工      各車系係數不同              ROUND(D15*0.042,0)…              → 車系個別公式
 *   19 製造費用      E19 =D19、F19 數字          照抄另一個車系                   → 數字(註明照抄)
 *   20 貨物稅        =ROUND(D12*$P$10,0)        $P$10 標籤「貨物稅率」             → 內建參數 [貨物稅率]
 *   22 廣宣費用      =參數!B2                   引用其他分頁                     → 數字(原因)
 *   23 促銷          =IFERROR(D22*0+23158,0)     系統沒有的函式                   → 數字(原因)
 *   25 直接歸屬費用  =ROUND(D22*57.52%,0)       百分比常數                       → 公式
 *   27 固定營業費用  E27 =D27、F27 =E27+0        引用其他車系欄做運算             → 數字(原因)
 *   29 前瞻費用      兩個分頁的公式不同          =D25*0 / =D22*0                  → 數字(各分頁不一樣)
 *   30 品牌分攤      D 數字、E/F 公式            =ROUND(E22*0.4,0)                → 數字 + 公式車系用車系個別公式
 * opts：{ lp, promo, variant } 調整數字，做「同版面的第二個分頁」。
 * 回傳 { sheet, expected: { 列號: [各車系值, 加權] } }
 */
function fullFs(name, opts) {
  opts = Object.assign({ lp: 1, promo: 0, variant: false }, opts);
  const mix = [0.2, 0.3, 0.5];
  const P = { 8: 0.1, 9: 4.5, 10: 0.1 };         // 關稅率、匯率、貨物稅率
  const rmb = [75000, 75000, 75000];
  const per = fn => [0, 1, 2].map(fn);
  const val = {
    7: [1000000, 1050000, 1299000],
    8: [3990, 3990, 3990],
    15: [433466, 506850, 581823].map(v => round(v * opts.lp, 2)),
    19: [29526, 29526, 30011],
    22: [5556, 5556, 5556],
    23: [23158, 23158, 23158].map(v => v - opts.promo),
    27: [41131, 41131, 41131],
    29: [0, 0, 0]
  };
  val[9] = per(i => val[7][i] - val[8][i]);
  val[10] = per(i => round(val[9][i] / 1.05 * 0.05));
  val[11] = per(i => round((val[9][i] - val[10][i]) * 0.07));
  val[12] = per(i => val[9][i] - val[10][i] - val[11][i]);
  val[16] = per(i => rmb[i] * P[9] * (1 + P[8]));
  val[17] = per(i => Math.pow(-2, 2) + val[16][i] * 0 + 3387);   // Excel：負號先算 → 4 + 3387 = 3391
  const laborK = [0.042, 0.0365, 0.032];
  val[18] = per(i => round(val[15][i] * laborK[i]));
  val[14] = per(i => val[15][i] + val[16][i] + val[17][i]);
  val[20] = per(i => round(val[12][i] * P[10]));
  val[13] = per(i => val[14][i] + val[18][i] + val[19][i] + val[20][i]);
  val[21] = per(i => val[12][i] - val[13][i]);
  val[24] = per(i => val[21][i] - (val[22][i] + val[23][i]));
  val[25] = per(i => round(val[22][i] * 0.5752));
  val[26] = per(i => val[24][i] - val[25][i]);
  val[28] = per(i => val[26][i] - val[27][i]);
  val[30] = [2164, round(val[22][1] * 0.4), round(val[22][2] * 0.4)];
  val[31] = per(i => val[28][i] - val[29][i] - val[30][i]);

  // 公式：f(欄, 車系索引) → 公式文字；回傳 null = 這一格是數字
  const formulas = {
    9: c => `${c}7-${c}8`, 10: c => `ROUND(${c}9/1.05*0.05,0)`, 11: c => `ROUND((${c}9-${c}10)*0.07,0)`,
    12: c => `${c}9-${c}10-${c}11`, 13: c => `${c}14+${c}18+SUM(${c}19:${c}20)`, 14: c => `SUM(${c}15:${c}17)`,
    16: (c, i) => `${RMB[i]}16*$P$9*(1+$P$8)`,
    17: c => `-2^2+${c}16*0+3387`,
    18: (c, i) => `ROUND(${c}15*${laborK[i]},0)`,
    19: (c, i) => (i === 1 ? 'D19' : null),
    20: c => `ROUND(${c}12*$P$10,0)`,
    21: c => `${c}12-${c}13`,
    22: () => '參數!B2',
    23: c => `IFERROR(${c}22*0+${23158 - opts.promo},0)`,
    24: c => `${c}21-SUM(${c}22:${c}23)`,
    25: c => `ROUND(${c}22*57.52%,0)`,
    26: c => `${c}24-${c}25`,
    27: (c, i) => (i === 1 ? 'D27' : i === 2 ? 'E27+0' : null),
    28: c => `${c}26-${c}27`,
    29: c => (opts.variant ? `${c}22*0` : `${c}25*0`),
    30: (c, i) => (i === 0 ? null : `ROUND(${c}22*0.4,0)`),
    31: c => `${c}28-${c}29-${c}30`
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
    K4: '3人貨車', L4: '9人商用', M4: '9人接駁', K5: 'RMB', L5: 'RMB', M5: 'RMB',
    O8: '關稅率', P8: P[8], O9: '匯率', P9: P[9], O10: '貨物稅率', P10: P[10],
    B33: { v: '單位：元', inline: true }
  };
  RMB.forEach((c, i) => { cells[c + 16] = rmb[i]; });
  Object.keys(labels).forEach(r => { cells['B' + r] = labels[r]; });
  VEH.forEach((c, i) => { cells[c + 6] = mix[i]; });
  cells.G6 = { f: 'SUM(D6:F6)', v: 1 };
  const expected = {};
  Object.keys(val).forEach(r => {
    const w = val[r].reduce((sum, v, i) => sum + v * mix[i], 0);
    expected[r] = val[r].concat([w]);
    VEH.forEach((c, i) => {
      const f = formulas[r] ? formulas[r](c, i) : null;
      // 第 9 列用水平共用公式(D9 存全文，E9/F9 只寫共用編號)，其他列每格各自一段公式
      if (f && +r === 9) cells[c + r] = i === 0 ? { f, v: val[r][i], shared: { si: 1, ref: 'D9:F9' } } : { si: 1, v: val[r][i] };
      else cells[c + r] = f ? { f, v: val[r][i] } : val[r][i];
    });
    // 加權欄：往下拖曳的共用公式(G7 存全文)
    cells['G' + r] = +r === 7 ? { f: 'D7*$D$6+E7*$E$6+F7*$F$6', v: w, shared: { si: 0, ref: 'G7:G31' } } : { si: 0, v: w };
    cells['H' + r] = { f: `D${r}/D$12`, v: val[r][0] / val[12][0] };
  });
  cells.J20 = '廠價 × 10%';
  cells.J15 = '依 BOM 估算 & 含運費 <暫估>';
  return { sheet: { name, cells, merges: ['D3:G3'] }, expected };
}

/** 同一個版面但整張貼上值(沒有任何公式)：小計要由數字推斷 */
function valuesOnly(sheet, name) {
  const cells = {};
  Object.keys(sheet.cells).forEach(ref => {
    const c = sheet.cells[ref];
    cells[ref] = c !== null && typeof c === 'object' ? (c.inline ? c : c.v) : c;
  });
  return { name, cells, merges: sheet.merges };
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

/**
 * 開發總投攤提的測試檔：損益表 2 個車系，單台攤提引用「開發」分頁，各種寫法：
 *   7  模具費       =開發!C11(= C9/$B$16，C9 = SUM(C4:C8))             → 開發攤提(模具)
 *   8  設備費       =開發!D11(D9 只加到第 7 列，不含治具)               → 開發攤提(設備)，不含治具
 *   9  CMC開發費    =開發!E13(= E11 - E12，費用總計 - 上汽；E13 那列有標籤「CMC費用」) → 上汽相消
 *   10 上汽開發費   =開發!E12(= E4/$B$16，E4 = 3000000*$E$1/0.8 含匯率)  → 1 筆投資
 *   11 治具攤提     =ROUND(開發!D8/開發!$B$16,0)                         → 四捨五入，帶入數字
 *   12 檢具攤提     直接打 1500                                          → 可選「用攤提台數回推」
 * 頂規一律 =D 欄(照抄)。攤提台數 B16 = 40000、L/C 月 C16 = 48。
 * 目標分頁引用「開發低減」：投資寫成「原始 × (1 - $G$1)」(低減 10%)。
 */
function devSheet(name, reduced) {
  const amounts = { 4: [0, 0, 3000000 * 4.65 / 0.8], 5: [300000000 / 0.9, 0, 20000000], 6: [0, 250000000, 8000000], 7: [0, 5000000, 0], 8: [0, 12000000, 0] };
  const depts = { 4: '上汽開發費', 5: '開發部', 6: '生技部', 7: '品管部', 8: '治具' };
  const cells = { B3: '部門', C3: '模具', D3: '設備', E3: '費用', F3: '說明', E1: 4.65, D1: '匯率', G1: 0.1, F1: '低減率',
    B15: 'L/C台數', C15: 'L/C月', B16: 40000, C16: 48, D12: '上汽單台', D13: 'CMC費用', B11: '' };
  const cut = reduced ? 0.9 : 1;
  const val = {};
  const cols = ['C', 'D', 'E'];
  Object.keys(depts).forEach(r => {
    cells['B' + r] = depts[r];
    cols.forEach((c, i) => {
      const v = amounts[r][i];
      if (!v) return;
      const orig = +r === 4 ? { f: '3000000*$E$1/0.8', v } : (+r === 5 && i === 0 ? { f: '300000000/0.9', v } : v);
      if (reduced && +r !== 4) {
        // 原始金額放在 I/J/K 欄，低減後的金額 = 原始 × (1 - $G$1)
        const oc = ['I', 'J', 'K'][i];
        cells[oc + r] = typeof orig === 'object' ? orig : v;
        cells[c + r] = { f: `${oc}${r}*(1-$G$1)`, v: v * cut };
        val[c + r] = v * cut;
      } else {
        cells[c + r] = orig;
        val[c + r] = v;
      }
    });
  });
  cells.F5 = '開發四門，尾門改K';
  const sum = (c, a, b) => { let t = 0; for (let r = a; r <= b; r++) t += val[c + r] || 0; return t; };
  const tot = { C: sum('C', 4, 8), D: sum('D', 4, 7), E: sum('E', 4, 8) };
  cells.B9 = '總計';
  cells.C9 = { f: 'SUM(C4:C8)', v: tot.C };
  cells.D9 = { f: 'SUM(D4:D7)', v: tot.D };
  cells.E9 = { f: 'SUM(E4:E8)', v: tot.E };
  const U = 40000;
  cells.C11 = { f: 'C9/$B$16', v: tot.C / U };
  cells.D11 = { f: 'D9/$B$16', v: tot.D / U };
  cells.E11 = { f: 'E9/$B$16', v: tot.E / U };
  cells.E12 = { f: 'E4/$B$16', v: val.E4 / U };
  cells.E13 = { f: 'E11-E12', v: tot.E / U - val.E4 / U };
  delete cells.B11;
  return { sheet: { name, cells }, perUnit: { mold: tot.C / U, equip: tot.D / U, cmc: tot.E / U - val.E4 / U, saic: val.E4 / U, jig: Math.round(val.D8 / U) } };
}

function amortFs(name, devName, per) {
  const cells = { D3: '入門', E3: '頂規', D4: 'TWD', E4: 'TWD' };
  const labels = { 5: '收入', 6: '材料', 7: '模具費', 8: '設備費', 9: 'CMC開發費', 10: '上汽開發費', 11: '治具攤提', 12: '檢具攤提', 13: '成本合計', 14: '毛利' };
  Object.keys(labels).forEach(r => { cells['B' + r] = labels[r]; });
  const v = { 5: [900000, 950000], 6: [500000, 540000], 7: [per.mold, per.mold], 8: [per.equip, per.equip], 9: [per.cmc, per.cmc],
    10: [per.saic, per.saic], 11: [per.jig, per.jig], 12: [1500, 1500] };
  v[13] = [0, 1].map(i => [6, 7, 8, 9, 10, 11, 12].reduce((s, r) => s + v[r][i], 0));
  v[14] = [0, 1].map(i => v[5][i] - v[13][i]);
  const ref = { 7: 'C11', 8: 'D11', 9: 'E13', 10: 'E12' };
  [5, 6, 12].forEach(r => { cells['D' + r] = v[r][0]; cells['E' + r] = v[r][1]; });
  Object.keys(ref).forEach(r => {
    cells['D' + r] = { f: `${devName}!${ref[r]}`, v: v[r][0] };
    cells['E' + r] = { f: `D${r}`, v: v[r][1] };
  });
  cells.D11 = { f: `ROUND(${devName}!D8/${devName}!$B$16,0)`, v: v[11][0] };
  cells.E11 = { f: 'D11', v: v[11][1] };
  ['D', 'E'].forEach((c, i) => {
    cells[c + 13] = { f: `SUM(${c}6:${c}12)`, v: v[13][i] };
    cells[c + 14] = { f: `${c}5-${c}13`, v: v[14][i] };
  });
  return { sheet: { name, cells }, expected: v };
}

function amortWorkbook() {
  const dev = devSheet('開發', false), devCut = devSheet('開發低減', true);
  const base = amortFs('XA FS', '開發', dev.perUnit), target = amortFs('XA FS 目標', '開發低減', devCut.perUnit);
  return { bytes: makeXlsx([base.sheet, target.sheet, dev.sheet, devCut.sheet]), expected: [base.expected, target.expected], perUnit: [dev.perUnit, devCut.perUnit] };
}

function fixtureWorkbook() {
  const a = fullFs('DQ FS_現況');
  const b = fullFs('DQ FS_目標', { lp: 0.95, promo: 3000, variant: true });
  const other = { name: '參數', hidden: true, cells: { A1: '匯率', B1: 4.65, A2: '廣宣', B2: 5556 } };
  const flat = valuesOnly(a.sheet, 'DQ 貼上值');
  return { bytes: makeXlsx([a.sheet, b.sheet, other, flat]), expected: [a.expected, b.expected] };
}

module.exports = { makeXlsx, fullFs, minimalFs, valuesOnly, fixtureWorkbook, amortWorkbook, crc32 };
