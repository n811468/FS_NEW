/**
 * 讀 .xlsx(Excel 活頁簿)：不需要任何外部程式庫，地端版雙擊就能用、也不必連網路。
 *
 * .xlsx 其實是一個 zip 壓縮檔，裡面是一堆 XML：
 *   xl/workbook.xml              分頁清單(名稱、是否隱藏)
 *   xl/_rels/workbook.xml.rels   分頁 → 實際的 XML 檔
 *   xl/sharedStrings.xml         所有文字儲存格共用的字串表
 *   xl/worksheets/sheetN.xml     每一格的值<v>與公式<f>
 * 解壓縮用瀏覽器內建的 DecompressionStream('deflate-raw')(Chrome / Edge 103 以後都有)；
 * Node 驗算時改傳 zlib.inflateRawSync 進來。XML 都是 Excel 自己產生的固定格式，用規則運算式解析即可，
 * 不依賴瀏覽器的 DOMParser，Node 端可以直接測。
 *
 * 讀出來的每一格：{ v: 值(數字/文字/布林/null), f: 公式(不含開頭的 =，共用公式已展開成該格自己的公式), t: 型別 }
 * 值是 Excel 存檔當下算好的結果(快取值)，不會在這裡重算公式。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSXlsx = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 欄位代號 ---------------- */
  function colToNum(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
  }
  function numToCol(n) {
    var s = '';
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function parseRef(ref) {
    var m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(String(ref).toUpperCase());
    return m ? { c: colToNum(m[1]), r: Number(m[2]) } : null;
  }
  function refOf(r, c) { return numToCol(c) + r; }

  /* ---------------- zip ---------------- */
  var utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  function decodeUtf8(bytes) {
    if (utf8) return utf8.decode(bytes);
    return Buffer.from(bytes).toString('utf8');   // 只有很舊的 Node 才會走到
  }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }

  /** 列出 zip 裡的檔案：{ 名稱: { method, offset, size } }(還沒解壓縮) */
  function listZip(bytes) {
    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('這個檔案不是 .xlsx(讀不到壓縮檔目錄)。若是舊版 .xls，請先用 Excel 另存成 .xlsx。');
    var count = u16(bytes, eocd + 10);
    var p = u32(bytes, eocd + 16);
    var entries = {};
    for (var k = 0; k < count; k++) {
      if (u32(bytes, p) !== 0x02014b50) throw new Error('.xlsx 壓縮檔目錄損毀');
      var method = u16(bytes, p + 10);
      var compSize = u32(bytes, p + 20);
      var nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32);
      var localOffset = u32(bytes, p + 42);
      var name = decodeUtf8(bytes.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method: method, localOffset: localOffset, size: compSize };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function browserInflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('這個瀏覽器不支援解壓縮 .xlsx，請改用新版的 Chrome 或 Edge。'));
    }
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  function readEntry(bytes, entry, inflateRaw) {
    var o = entry.localOffset;
    if (u32(bytes, o) !== 0x04034b50) throw new Error('.xlsx 壓縮檔內容損毀');
    var start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
    var data = bytes.subarray(start, start + entry.size);
    if (entry.method === 0) return Promise.resolve(data);
    if (entry.method !== 8) return Promise.reject(new Error('不支援的壓縮方式：' + entry.method));
    return Promise.resolve(inflateRaw(data));
  }

  /* ---------------- XML ---------------- */
  function decodeXml(s) {
    return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (m, e) {
      if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>';
      if (e === 'quot') return '"'; if (e === 'apos') return "'";
      var code = e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }).replace(/_x([0-9A-Fa-f]{4})_/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
  }
  function attrs(s) {
    var out = {}, re = /([\w:]+)\s*=\s*"([^"]*)"/g, m;
    while ((m = re.exec(s))) out[m[1].replace(/^.*:/, m[1].indexOf('r:') === 0 ? 'r:' : '')] = decodeXml(m[2]);
    return out;
  }
  /** <si> / <is> 裡的文字：所有 <t> 串起來(多種字型的文字會拆成好幾段)，略過注音標示 <rPh> */
  function richText(xml) {
    var s = String(xml || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    var out = '', re = /<t\b[^>]*>([\s\S]*?)<\/t>/g, m;
    while ((m = re.exec(s))) out += decodeXml(m[1]);
    return out;
  }

  /* ---------------- 共用公式 ---------------- */
  /**
   * 共用公式(Excel 往下拖曳複製的公式)只在第一格存全文，其他格只寫「跟第幾號共用」。
   * 把第一格的公式依位移量平移成這一格的公式：相對參照(沒有 $ 的列/欄)跟著移動，跟 Excel 一樣。
   */
  function shiftFormula(formula, dr, dc) {
    if (!dr && !dc) return formula;
    var out = '', i = 0, s = String(formula);
    while (i < s.length) {
      var ch = s.charAt(i);
      if (ch === '"') {                       // 字串常數原樣保留
        var j = s.indexOf('"', i + 1);
        while (j !== -1 && s.charAt(j + 1) === '"') j = s.indexOf('"', j + 2);
        j = j === -1 ? s.length : j + 1;
        out += s.slice(i, j); i = j; continue;
      }
      if (ch === "'") {                       // '分頁名稱'!A1 的分頁名稱原樣保留
        var k = s.indexOf("'", i + 1);
        while (k !== -1 && s.charAt(k + 1) === "'") k = s.indexOf("'", k + 2);
        k = k === -1 ? s.length : k + 1;
        out += s.slice(i, k); i = k; continue;
      }
      var m = /^(\$?)([A-Z]{1,3})(\$?)(\d+)/.exec(s.slice(i));
      var prev = i > 0 ? s.charAt(i - 1) : '';
      if (m && !/[A-Za-z0-9_.]/.test(prev) && !/^[A-Za-z0-9_(]/.test(s.slice(i + m[0].length))) {
        var col = m[1] ? m[2] : numToCol(colToNum(m[2]) + dc);
        var row = m[3] ? m[4] : String(Number(m[4]) + dr);
        out += m[1] + col + m[3] + row;
        i += m[0].length; continue;
      }
      // 函式名稱、分頁名稱等一般文字：整個詞一次跳過，避免 LOG10 這種名稱被當成儲存格
      var w = /^[A-Za-z_\u0080-￿][\w.\u0080-￿]*/.exec(s.slice(i));
      if (w) { out += w[0]; i += w[0].length; continue; }
      out += ch; i++;
    }
    return out;
  }

  function parseSheet(xml, sharedStrings) {
    var cells = {}, maxRow = 0, maxCol = 0;
    var shared = {};      // si -> { f, r, c }
    var rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, rm, lastRow = 0;
    while ((rm = rowRe.exec(xml))) {
      var ra = attrs(rm[1]);
      var r = ra.r ? Number(ra.r) : lastRow + 1;
      lastRow = r;
      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm, lastCol = 0;
      var body = rm[2] || '';
      while ((cm = cellRe.exec(body))) {
        var ca = attrs(cm[1]);
        var pos = ca.r ? parseRef(ca.r) : { r: r, c: lastCol + 1 };
        lastCol = pos.c;
        var inner = cm[2] || '';
        var t = ca.t || 'n';
        var vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        var raw = vm ? decodeXml(vm[1]) : null;
        var v = null;
        if (t === 's') v = raw === null ? null : (sharedStrings[Number(raw)] || '');
        else if (t === 'inlineStr') { v = richText((/<is>([\s\S]*?)<\/is>/.exec(inner) || [])[1]); t = 's'; }
        else if (t === 'str') { v = raw === null ? '' : raw; t = 's'; }
        else if (t === 'b') v = raw === '1';
        else if (t === 'e') v = raw;
        else v = raw === null || raw === '' ? null : Number(raw);

        var f = null;
        var fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
        if (fm) {
          var fa = attrs(fm[1]);
          var text = fm[2] !== undefined ? decodeXml(fm[2]) : '';
          if (fa.t === 'shared' && fa.si !== undefined) {
            if (text) shared[fa.si] = { f: text, r: pos.r, c: pos.c };
            else if (shared[fa.si]) text = shiftFormula(shared[fa.si].f, pos.r - shared[fa.si].r, pos.c - shared[fa.si].c);
          }
          f = text || null;
        }
        if (v === null && f === null) continue;
        cells[pos.r + ':' + pos.c] = { v: v, f: f, t: t };
        if (pos.r > maxRow) maxRow = pos.r;
        if (pos.c > maxCol) maxCol = pos.c;
      }
    }
    var merges = [], mm, mre = /<mergeCell\b[^>]*ref="([A-Z]+\d+):([A-Z]+\d+)"/g;
    while ((mm = mre.exec(xml))) {
      var a = parseRef(mm[1]), b = parseRef(mm[2]);
      merges.push({ r1: a.r, c1: a.c, r2: b.r, c2: b.c });
    }
    return { cells: cells, merges: merges, maxRow: maxRow, maxCol: maxCol };
  }

  function resolvePath(target) {
    var t = String(target).replace(/\\/g, '/');
    if (t.charAt(0) === '/') return t.slice(1);
    var parts = ('xl/' + t).split('/'), out = [];
    parts.forEach(function (p) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); });
    return out.join('/');
  }

  /**
   * 讀整本活頁簿。bytes：Uint8Array 或 ArrayBuffer；inflateRaw 可省略(瀏覽器用內建解壓縮)。
   * 回傳 Promise<{ sheets: [{ name, hidden, cells, merges, maxRow, maxCol }] }>
   */
  function readWorkbook(bytes, inflateRaw) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    inflateRaw = inflateRaw || browserInflateRaw;
    var entries;
    try { entries = listZip(bytes); } catch (e) { return Promise.reject(e); }
    function text(name) {
      var e = entries[name];
      if (!e) return Promise.resolve(null);
      return readEntry(bytes, e, inflateRaw).then(decodeUtf8);
    }
    if (!entries['xl/workbook.xml']) return Promise.reject(new Error('這個檔案不是 Excel 活頁簿(.xlsx)。'));
    return Promise.all([text('xl/workbook.xml'), text('xl/_rels/workbook.xml.rels'), text('xl/sharedStrings.xml')])
      .then(function (res) {
        var rels = {}, m, relRe = /<Relationship\b([^>]*?)\/?>/g;
        while ((m = relRe.exec(res[1] || ''))) { var ra = attrs(m[1]); rels[ra.Id] = resolvePath(ra.Target); }
        var strings = [], sre = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g;
        while ((m = sre.exec(res[2] || ''))) strings.push(richText(m[1] || ''));
        var sheetDefs = [], shRe = /<sheet\b([^>]*?)\/?>/g;
        while ((m = shRe.exec(res[0]))) {
          var a = attrs(m[1]);
          sheetDefs.push({ name: a.name, hidden: !!a.state && a.state !== 'visible', path: rels[a['r:id']] });
        }
        return Promise.all(sheetDefs.map(function (d) {
          return text(d.path).then(function (xml) {
            var parsed = xml ? parseSheet(xml, strings) : { cells: {}, merges: [], maxRow: 0, maxCol: 0 };
            parsed.name = d.name; parsed.hidden = d.hidden;
            return parsed;
          });
        }));
      })
      .then(function (sheets) { return { sheets: sheets }; });
  }

  function cell(sheet, r, c) { return sheet.cells[r + ':' + c] || null; }

  return {
    readWorkbook: readWorkbook, cell: cell, shiftFormula: shiftFormula,
    colToNum: colToNum, numToCol: numToCol, parseRef: parseRef, refOf: refOf
  };
}));
