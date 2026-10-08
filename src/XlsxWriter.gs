/**
 * 最小的 .xlsx 產生器：不靠任何套件，把「工作表 → 列 → 格子」的資料寫成 Excel 檔(二進位)。
 *
 * 地端版是單一 HTML 檔、完全離線，不能載入 SheetJS 之類的外部程式庫；xlsx 本質上是一個 zip，
 * 裡面放幾個 XML，這裡只實作驗算檔需要的部分：數字/文字/公式格子(公式附上快取值)、
 * 固定的幾種格式、欄寬、凍結窗格、合併儲存格、條件式格式。zip 用「不壓縮」(stored)，Excel 一樣能開。
 *
 * model = {
 *   sheets: [{
 *     name, cols: [欄寬...], freeze: { row: 4, col: 3 },   // 凍結前 4 列、前 3 欄
 *     rows: [[cell, ...], ...],                             // cell: null | 數字 | 字串 | { v, f, s }
 *     merges: ['A1:F1'], cf: [{ ref: 'F5:F40', formula: 'LEFT($F5,1)="✗"', style: 'bad' }]
 *   }]
 * }
 * cell.f 是公式(不含開頭的 =)，cell.v 是快取值(Excel 打開時會全部重算，快取值只給不重算的檢視器看)；
 * cell.s 是下面 XLSX_STYLES_ 的名稱。
 */

var XLSX_FONT_ = 'Microsoft JhengHei';

// 格式名稱 → [字型, 底色, 框線, 數字格式, 對齊]；順序就是 styles.xml 裡 cellXfs 的索引
var XLSX_STYLES_ = [
  ['default', 0, 0, 0, 0, ''],
  ['title', 5, 0, 0, 0, ''],
  ['header', 1, 2, 1, 0, 'center'],
  ['label', 0, 0, 1, 0, ''],
  ['section', 1, 4, 1, 0, ''],
  ['input', 2, 3, 1, 164, ''],
  ['inputPct', 2, 3, 1, 165, ''],
  ['inputText', 2, 3, 1, 0, ''],
  ['calc', 0, 0, 1, 164, ''],
  ['calcPct', 0, 0, 1, 165, ''],
  ['link', 3, 0, 1, 164, ''],
  ['linkPct', 3, 0, 1, 165, ''],
  ['sys', 0, 5, 1, 164, ''],
  ['diff', 0, 0, 1, 167, ''],
  ['wrap', 0, 0, 1, 0, 'wrap'],
  ['note', 6, 0, 0, 0, ''],
  ['code', 7, 0, 1, 0, 'wrap'],
  ['calcBold', 1, 0, 1, 164, ''],
  ['linkText', 3, 0, 1, 0, 'wrap'],
  ['int', 0, 0, 1, 166, ''],
  ['inputInt', 2, 3, 1, 166, ''],
  ['labelBold', 1, 0, 1, 0, ''],
  ['big', 8, 0, 0, 0, ''],
  ['calcInt', 0, 0, 1, 166, ''],
  ['linkInt', 3, 0, 1, 166, '']
];
var XLSX_STYLE_INDEX_ = (function () {
  var m = {};
  XLSX_STYLES_.forEach(function (s, i) { m[s[0]] = i; });
  return m;
})();

function xlsxEsc_(s) {
  // XML 1.0 不允許的控制字元直接拿掉(從系統貼上的說明偶爾會夾帶)
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 0 → A、25 → Z、26 → AA */
function xlsxCol_(i) {
  var s = '';
  i = i + 1;
  while (i > 0) {
    var m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}
function xlsxRef_(row, col) { return xlsxCol_(col) + (row + 1); }

function xlsxStylesXml_() {
  var fonts = [
    '<font><sz val="10"/><name val="' + XLSX_FONT_ + '"/></font>',
    '<font><b/><sz val="10"/><name val="' + XLSX_FONT_ + '"/></font>',
    '<font><sz val="10"/><color rgb="FF0000FF"/><name val="' + XLSX_FONT_ + '"/></font>',
    '<font><sz val="10"/><color rgb="FF008000"/><name val="' + XLSX_FONT_ + '"/></font>',
    '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="' + XLSX_FONT_ + '"/></font>',
    '<font><b/><sz val="14"/><name val="' + XLSX_FONT_ + '"/></font>',
    '<font><i/><sz val="9"/><color rgb="FF666666"/><name val="' + XLSX_FONT_ + '"/></font>',
    '<font><sz val="10"/><name val="Consolas"/></font>',
    '<font><b/><sz val="12"/><name val="' + XLSX_FONT_ + '"/></font>'
  ];
  var solid = function (rgb) { return '<fill><patternFill patternType="solid"><fgColor rgb="' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>'; };
  var fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>',
    solid('FFD9D9D9'), solid('FFFFF2CC'), solid('FFDDEBF7'), solid('FFF2F2F2')];
  var thin = '<left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right>' +
    '<top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/>';
  var borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>', '<border>' + thin + '</border>'];
  var numFmts = [[164, '#,##0.00;[Red]-#,##0.00'], [165, '0.00%'], [166, '#,##0;[Red]-#,##0'], [167, '0.000000;[Red]-0.000000']];
  var xfs = XLSX_STYLES_.map(function (s) {
    var align = s[5] === 'center' ? '<alignment horizontal="center" vertical="center" wrapText="1"/>'
      : s[5] === 'wrap' ? '<alignment vertical="top" wrapText="1"/>' : '';
    return '<xf numFmtId="' + s[4] + '" fontId="' + s[1] + '" fillId="' + s[2] + '" borderId="' + s[3] + '" xfId="0"' +
      (s[4] ? ' applyNumberFormat="1"' : '') + ' applyFont="1"' + (s[2] ? ' applyFill="1"' : '') + (s[3] ? ' applyBorder="1"' : '') +
      (align ? ' applyAlignment="1">' + align + '</xf>' : '/>');
  });
  var dxfs = [
    '<dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf>',
    '<dxf><font><color rgb="FF006100"/></font><fill><patternFill><bgColor rgb="FFC6EFCE"/></patternFill></fill></dxf>',
    '<dxf><font><color rgb="FF7A5300"/></font><fill><patternFill><bgColor rgb="FFFFEB9C"/></patternFill></fill></dxf>'
  ];
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="' + numFmts.length + '">' + numFmts.map(function (n) { return '<numFmt numFmtId="' + n[0] + '" formatCode="' + xlsxEsc_(n[1]) + '"/>'; }).join('') + '</numFmts>' +
    '<fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts>' +
    '<fills count="' + fills.length + '">' + fills.join('') + '</fills>' +
    '<borders count="' + borders.length + '">' + borders.join('') + '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="' + dxfs.length + '">' + dxfs.join('') + '</dxfs>' +
    '</styleSheet>';
}
var XLSX_DXF_ = { bad: 0, good: 1, warn: 2 };

function xlsxCellXml_(cell, ref) {
  if (cell === null || cell === undefined || cell === '') return '';
  if (typeof cell !== 'object') cell = { v: cell };
  var s = cell.s && XLSX_STYLE_INDEX_[cell.s] !== undefined ? ' s="' + XLSX_STYLE_INDEX_[cell.s] + '"' : '';
  var v = cell.v;
  if (cell.f) {
    var f = '<f>' + xlsxEsc_(cell.f) + '</f>';
    if (typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '"' + s + '>' + f + '<v>' + v + '</v></c>';
    if (typeof v === 'string') return '<c r="' + ref + '"' + s + ' t="str">' + f + '<v>' + xlsxEsc_(v) + '</v></c>';
    return '<c r="' + ref + '"' + s + '>' + f + '</c>';
  }
  if (typeof v === 'number') return isFinite(v) ? '<c r="' + ref + '"' + s + '><v>' + v + '</v></c>' : '';
  if (v === undefined || v === null || v === '') return s ? '<c r="' + ref + '"' + s + '/>' : '';
  return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xlsxEsc_(v) + '</t></is></c>';
}

function xlsxSheetXml_(sheet) {
  var parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    // 列印時寬度縮成一頁(長度不限)，表格不會被切成好幾頁
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'];
  var fr = sheet.freeze || {};
  if (fr.row || fr.col) {
    var tl = xlsxRef_(fr.row || 0, fr.col || 0);
    var pane = fr.row && fr.col ? 'bottomRight' : fr.row ? 'bottomLeft' : 'topRight';
    parts.push('<sheetViews><sheetView workbookViewId="0"' + (sheet.first ? ' tabSelected="1"' : '') + '><pane' +
      (fr.col ? ' xSplit="' + fr.col + '"' : '') + (fr.row ? ' ySplit="' + fr.row + '"' : '') +
      ' topLeftCell="' + tl + '" activePane="' + pane + '" state="frozen"/><selection pane="' + pane + '" activeCell="' + tl + '" sqref="' + tl + '"/></sheetView></sheetViews>');
  } else {
    parts.push('<sheetViews><sheetView workbookViewId="0"' + (sheet.first ? ' tabSelected="1"' : '') + '/></sheetViews>');
  }
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (sheet.cols && sheet.cols.length) {
    parts.push('<cols>' + sheet.cols.map(function (w, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (w || 10) + '" customWidth="1"/>';
    }).join('') + '</cols>');
  }
  parts.push('<sheetData>');
  (sheet.rows || []).forEach(function (row, r) {
    if (!row || !row.length) return;
    var cells = row.map(function (c, ci) { return xlsxCellXml_(c, xlsxRef_(r, ci)); }).join('');
    if (cells) parts.push('<row r="' + (r + 1) + '">' + cells + '</row>');
  });
  parts.push('</sheetData>');
  if (sheet.merges && sheet.merges.length) {
    parts.push('<mergeCells count="' + sheet.merges.length + '">' + sheet.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>');
  }
  (sheet.cf || []).forEach(function (c, i) {
    parts.push('<conditionalFormatting sqref="' + c.ref + '"><cfRule type="expression" dxfId="' + XLSX_DXF_[c.style] +
      '" priority="' + (i + 1) + '"><formula>' + xlsxEsc_(c.formula) + '</formula></cfRule></conditionalFormatting>');
  });
  parts.push('<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>');
  parts.push('<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>');
  parts.push('</worksheet>');
  return parts.join('');
}

/** 整本活頁簿 → { 檔名: XML 字串 } */
function xlsxParts_(model) {
  var sheets = model.sheets;
  var files = {};
  files['[Content_Types].xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';
  files['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>';
  files['docProps/core.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>' + xlsxEsc_(model.title || '') + '</dc:title><dc:creator>車型損益試算系統</dc:creator></cp:coreProperties>';
  files['xl/workbook.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
    sheets.map(function (s, i) { return '<sheet name="' + xlsxEsc_(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
    // fullCalcOnLoad：打開時一律重算全部公式，驗算看到的是 Excel 自己算的數字，不是檔案裡的快取值
    '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
  files['xl/_rels/workbook.xml.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
    '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
  files['xl/styles.xml'] = xlsxStylesXml_();
  sheets.forEach(function (s, i) {
    files['xl/worksheets/sheet' + (i + 1) + '.xml'] = xlsxSheetXml_(Object.assign({ first: i === 0 }, s));
  });
  return files;
}

/* ---------------- zip(不壓縮) ---------------- */

function utf8Bytes_(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
      var d = str.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

var CRC32_TABLE_ = null;
function crc32_(bytes) {
  if (!CRC32_TABLE_) {
    CRC32_TABLE_ = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC32_TABLE_.push(c >>> 0);
    }
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = CRC32_TABLE_[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** files: { 路徑: 字串 } → zip 的位元組陣列(stored，不壓縮) */
function zipStore_(files) {
  var out = [], central = [];
  var u16 = function (arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF); };
  var u32 = function (arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); };
  var DOS_TIME = 0, DOS_DATE = (2020 - 1980) << 9 | 1 << 5 | 1;
  Object.keys(files).forEach(function (name) {
    var nameBytes = utf8Bytes_(name);
    var data = utf8Bytes_(files[name]);
    var crc = crc32_(data);
    var offset = out.length;
    var head = [];
    u32(head, 0x04034b50); u16(head, 20); u16(head, 0x0800); u16(head, 0); u16(head, DOS_TIME); u16(head, DOS_DATE);
    u32(head, crc); u32(head, data.length); u32(head, data.length); u16(head, nameBytes.length); u16(head, 0);
    Array.prototype.push.apply(out, head);
    Array.prototype.push.apply(out, nameBytes);
    for (var i = 0; i < data.length; i += 8192) Array.prototype.push.apply(out, data.slice(i, i + 8192));
    var cd = [];
    u32(cd, 0x02014b50); u16(cd, 20); u16(cd, 20); u16(cd, 0x0800); u16(cd, 0); u16(cd, DOS_TIME); u16(cd, DOS_DATE);
    u32(cd, crc); u32(cd, data.length); u32(cd, data.length); u16(cd, nameBytes.length); u16(cd, 0); u16(cd, 0);
    u16(cd, 0); u16(cd, 0); u32(cd, 0); u32(cd, offset);
    central.push(cd.concat(nameBytes));
  });
  var cdStart = out.length, cdSize = 0;
  central.forEach(function (cd) { cdSize += cd.length; Array.prototype.push.apply(out, cd); });
  var end = [];
  u32(end, 0x06054b50); u16(end, 0); u16(end, 0); u16(end, central.length); u16(end, central.length);
  u32(end, cdSize); u32(end, cdStart); u16(end, 0);
  Array.prototype.push.apply(out, end);
  return out;
}

function base64Bytes_(bytes) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = [];
  for (var i = 0; i < bytes.length; i += 3) {
    var a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    var n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out.push(chars.charAt((n >> 18) & 63), chars.charAt((n >> 12) & 63),
      b === undefined ? '=' : chars.charAt((n >> 6) & 63), c === undefined ? '=' : chars.charAt(n & 63));
  }
  return out.join('');
}

/** 活頁簿 model → .xlsx 的 base64(前端轉成 Blob 下載；後端回傳值要走 JSON，所以用 base64) */
function buildXlsxBase64_(model) {
  return base64Bytes_(zipStore_(xlsxParts_(model)));
}
