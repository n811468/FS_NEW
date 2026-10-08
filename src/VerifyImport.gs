/**
 * 從 Excel 驗算檔匯入：使用者在驗算檔裡改了公式(損益試算)或輸入數字(輸入、開發總投的藍字)，
 * 匯入回系統。流程是「先預覽、確認才存」：
 *   previewVerifyImport(files)        → 列出會更新的公式、輸入數字，以及無法匯入的格子與原因
 *   applyVerifyImport(files, ids)     → 只套用勾選的項目(先自動存一份快照)，一律走原本的存檔函式，驗證規則跟畫面上改一樣
 *
 * files = { 'xl/workbook.xml': 文字, 'xl/worksheets/sheet1.xml': 文字, ... }：前端把 xlsx 解壓縮後只送文字檔過來。
 *
 * 怎麼知道哪一格是什麼：驗算檔裡有一張隱藏的「_對照」表(VerifyWorkbook.gs)，記錄每個科目在哪一列、每個車系在哪一欄、
 * 每個輸入在哪一列，以及匯出當時的公式與數字。只有跟匯出當時不一樣的格子才算「使用者改過」；
 * 系統在匯出之後也改過同一個地方時，預覽會標「匯出後系統也改過」，預設不勾。
 *
 * Excel 公式 → 系統公式(VerifyWorkbook.gs 翻譯規則的反方向)：
 *   損益試算同一欄的格子 → 科目代碼；「輸入」的格子 → [系統變數]/[參數]/[XXX匯率]；「開發總投」彙總列 → 那個開發攤提科目；
 *   SUM(子科目) → CHILDREN()、SUM(可扣除貨物稅科目) → TAXDEDUCT()；IF(b=0,0,a/b) → a/b；(比較式)*1 → 比較式；x% → x/100。
 *   系統沒有的函式(VLOOKUP…)、引用別的車系欄、引用對照表以外的格子 → 列在「無法匯入」，不會存。
 */

var VERIFY_IMPORT_FUNCTIONS_ = ['SUM', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'MIN', 'MAX', 'ABS', 'IF'];

/* ======================= 讀 xlsx 的 XML ======================= */

function xmlUnescape_(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); })
    .replace(/&amp;/g, '&');
}
function xmlAttr_(attrs, name) {
  var m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(attrs);
  return m ? xmlUnescape_(m[1]) : null;
}
function cellPos_(ref) {
  var m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref);
  if (!m) return null;
  var col = 0;
  for (var i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

/** 公式裡的相對參照整段平移(Excel 的共用公式：只存第一格的公式，其他格依位移推算) */
function shiftFormulaRefs_(text, dr, dc) {
  var out = '', i = 0;
  while (i < text.length) {
    var ch = text.charAt(i);
    if (ch === '"') {
      var j = i + 1;
      while (j < text.length && !(text.charAt(j) === '"' && text.charAt(j + 1) !== '"')) j += text.charAt(j) === '"' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === "'") {
      var k = text.indexOf("'!", i + 1);
      if (k !== -1) { out += text.slice(i, k + 2); i = k + 2; continue; }
    }
    var m = /^(\$?)([A-Z]{1,3})(\$?)(\d+)/.exec(text.slice(i));
    var prev = i ? text.charAt(i - 1) : '';
    if (m && !/[A-Za-z0-9_.]/.test(prev) && !/^[A-Za-z0-9_(]/.test(text.charAt(i + m[0].length))) {
      var pos = cellPos_(m[2] + m[4]);
      var col = m[1] ? pos.col : pos.col + dc, row = m[3] ? pos.row : pos.row + dr;
      out += m[1] + xlsxCol_(col) + m[3] + (row + 1);
      i += m[0].length; continue;
    }
    out += ch; i++;
  }
  return out;
}

/** files → { 工作表名稱: { A1: { f: 公式(不含 =) 或 null, v: 值 } } } */
function readXlsxSheets_(files) {
  var wb = files['xl/workbook.xml'];
  if (!wb) throw new Error('這不是 Excel 檔(xlsx)，或檔案已損壞');
  var rels = files['xl/_rels/workbook.xml.rels'] || '';
  var relTarget = {};
  rels.replace(/<Relationship\b([^>]*)\/?>/g, function (m, attrs) { relTarget[xmlAttr_(attrs, 'Id')] = xmlAttr_(attrs, 'Target'); return m; });
  var shared = [];
  var sst = files['xl/sharedStrings.xml'];
  if (sst) {
    sst.replace(/<si>([\s\S]*?)<\/si>/g, function (m, inner) {
      var t = '';
      inner.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, function (m2, x) { t += xmlUnescape_(x); return m2; });
      shared.push(t);
      return m;
    });
  }
  var out = {};
  wb.replace(/<sheet\b([^>]*)\/?>/g, function (m, attrs) {
    var name = xmlAttr_(attrs, 'name');
    var target = relTarget[xmlAttr_(attrs, 'r:id')] || '';
    var path = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    var xml = files[path];
    if (name && xml) out[name] = readSheetCells_(xml, shared);
    return m;
  });
  return out;
}

function readSheetCells_(xml, shared) {
  var cells = {}, masters = {};
  var re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, m;
  while ((m = re.exec(xml))) {
    var attrs = m[1], inner = m[2] || '';
    var ref = xmlAttr_(attrs, 'r');
    if (!ref) continue;
    var t = xmlAttr_(attrs, 't') || 'n';
    var fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
    var f = null;
    if (fm) {
      var fAttrs = fm[1], fText = fm[2] !== undefined ? xmlUnescape_(fm[2]) : '';
      if (xmlAttr_(fAttrs, 't') === 'shared') {
        var si = xmlAttr_(fAttrs, 'si');
        if (fText) { masters[si] = { text: fText, pos: cellPos_(ref) }; f = fText; }
        else if (masters[si]) {
          var p = cellPos_(ref), mp = masters[si].pos;
          f = shiftFormulaRefs_(masters[si].text, p.row - mp.row, p.col - mp.col);
        }
      } else if (fText) f = fText;
    }
    var vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
    var v = vm ? xmlUnescape_(vm[1]) : '';
    if (t === 's') v = shared[Number(v)] !== undefined ? shared[Number(v)] : '';
    else if (t === 'inlineStr') {
      v = '';
      inner.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, function (m2, x) { v += xmlUnescape_(x); return m2; });
    } else if (t === 'b') v = v === '1' ? 1 : 0;
    else if (t === 'n' && v !== '') v = Number(v);
    else if (t === 'e') v = { error: v };
    cells[ref.replace(/\$/g, '')] = { f: f, v: v };
  }
  return cells;
}

/* ======================= Excel 公式解析 ======================= */

function excelFormulaError_(msg) { var e = new Error(msg); e.isImportError = true; return e; }

function tokenizeExcel_(src) {
  var s = String(src || '').replace(/^\s*=/, '');
  var tokens = [], i = 0;
  var readRef = function (sheet) {
    var m = /^(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?/.exec(s.slice(i));
    if (!m) throw excelFormulaError_('看不懂「' + s.slice(i, i + 12) + '」');
    i += m[0].length;
    var a = cellPos_(m[1].toUpperCase()), b = m[2] ? cellPos_(m[2].toUpperCase()) : a;
    tokens.push({ t: 'ref', sheet: sheet, c1: a.col, r1: a.row, c2: b.col, r2: b.row, range: !!m[2] });
  };
  while (i < s.length) {
    var ch = s.charAt(i);
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      var j = i + 1, str = '';
      while (j < s.length) {
        if (s.charAt(j) === '"') { if (s.charAt(j + 1) === '"') { str += '"'; j += 2; continue; } break; }
        str += s.charAt(j++);
      }
      tokens.push({ t: 'str', v: str }); i = j + 1; continue;
    }
    if (ch === "'") {
      var end = s.indexOf("'!", i + 1);
      if (end === -1) throw excelFormulaError_('工作表名稱的引號沒有結尾');
      var sheetName = s.slice(i + 1, end).replace(/''/g, "'");
      i = end + 2; readRef(sheetName); continue;
    }
    if (/[0-9.]/.test(ch)) {
      var nm = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
      tokens.push({ t: 'num', v: Number(nm[0]) }); i += nm[0].length; continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(ch)) {
      var idm = /^[A-Za-z_$\u0080-￿][A-Za-z0-9_.$\u0080-￿]*/.exec(s.slice(i));
      var word = idm[0];
      if (s.charAt(i + word.length) === '!') { i += word.length + 1; readRef(word); continue; }
      if (/^\$?[A-Za-z]{1,3}\$?\d+$/.test(word) && s.charAt(i + word.length) !== '(') { readRef(''); continue; }
      i += word.length;
      if (s.charAt(i) === '(') { tokens.push({ t: 'fn', v: word.replace(/^_xl(fn|ws)\./i, '').toUpperCase() }); continue; }
      if (/^(TRUE|FALSE)$/i.test(word)) { tokens.push({ t: 'num', v: /^TRUE$/i.test(word) ? 1 : 0 }); continue; }
      throw excelFormulaError_('看不懂「' + word + '」(Excel 的名稱或別的檔案的參照不能匯入)');
    }
    var two = s.substr(i, 2);
    if (two === '<=' || two === '>=' || two === '<>') { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>%(),'.indexOf(ch) !== -1) { tokens.push({ t: 'op', v: ch }); i++; continue; }
    throw excelFormulaError_('看不懂的字元「' + ch + '」');
  }
  tokens.push({ t: 'end' });
  return tokens;
}

/** Excel 的運算優先順序：比較 < & < 加減 < 乘除 < ^ < % < 負號 */
function parseExcelFormula_(src) {
  var tokens = tokenizeExcel_(src), p = 0;
  var peek = function () { return tokens[p]; };
  var isOp = function (v) { return tokens[p].t === 'op' && tokens[p].v === v; };
  function compare() {
    var left = concat();
    while (peek().t === 'op' && ['=', '<>', '<', '>', '<=', '>='].indexOf(peek().v) !== -1) {
      var op = tokens[p++].v;
      left = { t: 'bin', op: op, a: left, b: concat() };
    }
    return left;
  }
  function concat() {
    var left = add();
    if (isOp('&')) throw excelFormulaError_('系統的公式不能用 & 接文字');
    return left;
  }
  function add() {
    var left = mul();
    while (isOp('+') || isOp('-')) { var op = tokens[p++].v; left = { t: 'bin', op: op, a: left, b: mul() }; }
    return left;
  }
  function mul() {
    var left = pow();
    while (isOp('*') || isOp('/')) { var op = tokens[p++].v; left = { t: 'bin', op: op, a: left, b: pow() }; }
    return left;
  }
  function pow() {
    var left = pct();
    while (isOp('^')) { p++; left = { t: 'bin', op: '^', a: left, b: pct() }; }
    return left;
  }
  function pct() {
    var node = neg();
    while (isOp('%')) { p++; node = { t: 'bin', op: '/', a: node, b: { t: 'num', v: 100 } }; }
    return node;
  }
  function neg() {
    if (isOp('-')) { p++; return { t: 'neg', a: neg() }; }
    if (isOp('+')) { p++; return neg(); }
    return primary();
  }
  function primary() {
    var tok = tokens[p];
    if (tok.t === 'num') { p++; return { t: 'num', v: tok.v }; }
    if (tok.t === 'str') { p++; return { t: 'str', v: tok.v }; }
    if (tok.t === 'ref') { p++; return tok; }
    if (tok.t === 'fn') {
      p++; p++;   // 函式名稱、(
      var args = [];
      if (!isOp(')')) {
        args.push(compare());
        while (isOp(',')) { p++; args.push(compare()); }
      }
      if (!isOp(')')) throw excelFormulaError_(tok.v + '( 少了 )');
      p++;
      return { t: 'call', name: tok.v, args: args };
    }
    if (isOp('(')) { p++; var inner = compare(); if (!isOp(')')) throw excelFormulaError_('括號沒有對上'); p++; return inner; }
    if (tok.t === 'end') throw excelFormulaError_('公式不完整');
    throw excelFormulaError_('這裡不應該出現「' + tok.v + '」');
  }
  var ast = compare();
  if (peek().t !== 'end') throw excelFormulaError_('多出了「' + (peek().v || '') + '」');
  return ast;
}

/** 比對用：去掉 = 空白 $ 與工作表名稱的引號、_xlfn.，英文大寫(字串內容不動) */
function normalizeExcelText_(f) {
  var s = String(f || '').replace(/^\s*=/, ''), out = '', i = 0;
  while (i < s.length) {
    var ch = s.charAt(i);
    if (ch === '"') {
      var j = i + 1;
      while (j < s.length && !(s.charAt(j) === '"' && s.charAt(j + 1) !== '"')) j += s.charAt(j) === '"' ? 2 : 1;
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === "'") {
      var k = s.indexOf("'!", i + 1);
      if (k !== -1) { out += s.slice(i + 1, k) + '!'; i = k + 2; continue; }
    }
    if (!/[\s$]/.test(ch)) out += ch.toUpperCase();
    i++;
  }
  return out.replace(/_XL(FN|WS)\./g, '');
}

/* ======================= 匯入的對照與目前資料 ======================= */

function verifyImportContext_(files) {
  var sheets = readXlsxSheets_(files);
  var S = VERIFY_SHEETS_;
  var map = sheets[S.map];
  if (!map) throw new Error('找不到驗算檔的對照表：請用系統「匯出 Excel 驗算檔」產生的檔案（舊版匯出的檔案請重新匯出一次）');
  // 對照表：A 種類、B 鍵、C 值1、D 值2
  var rows = [];
  Object.keys(map).forEach(function (ref) {
    var pos = cellPos_(ref);
    (rows[pos.row] = rows[pos.row] || [])[pos.col] = map[ref].v;
  });
  var ctx = { meta: {}, vehicles: [], pl: {}, plRow: {}, input: {}, inputRow: {}, dev: {}, devRow: {}, devsum: {}, devsumRow: {},
    plf: {}, inval: [], infml: [], amtcur: {}, amtmixed: {}, sheets: sheets };
  rows.forEach(function (r) {
    if (!r) return;
    var kind = r[0], key = r[1] === undefined ? '' : String(r[1]), a = r[2], b = r[3];
    if (kind === 'meta') ctx.meta[key] = a;
    else if (kind === 'vehicle') ctx.vehicles.push({ id: key, col: String(a), devCol: String(b) });
    else if (kind === 'pl') { ctx.pl[key] = Number(a); ctx.plRow[Number(a)] = key; }
    else if (kind === 'in') { ctx.input[key] = Number(a); ctx.inputRow[Number(a)] = key; }
    else if (kind === 'dev') { ctx.dev[key] = Number(a); ctx.devRow[Number(a)] = key; }
    else if (kind === 'devsum') { ctx.devsum[key] = Number(a); ctx.devsumRow[Number(a)] = key; }
    else if (kind === 'plf') ctx.plf[key] = { excel: a === undefined ? '' : String(a), sys: b === undefined ? '' : String(b) };
    else if (kind === 'inval') ctx.inval.push({ key: key, vid: a === undefined ? '' : String(a), value: b });
    else if (kind === 'infml') ctx.infml.push({ key: key, vid: a === undefined ? '' : String(a) });
    else if (kind === 'amtcur') ctx.amtcur[key] = String(a);
    else if (kind === 'amtmixed') ctx.amtmixed[key] = true;
  });
  var sid = String(ctx.meta.scenarioId || '');
  var scenario = getScenarios().filter(function (s) { return s.ScenarioID === sid; })[0];
  if (!scenario) throw new Error('驗算檔的情境（' + sid + '）在這個系統裡找不到：請在匯出這個檔案的那份資料裡匯入');
  ctx.scenario = scenario;
  ctx.scenarioId = sid;
  ctx.typeId = scenario.VehicleTypeID || '';
  ctx.defs = lineDefsForScenario_(sid);
  ctx.defsByCode = {}; ctx.byName = {}; ctx.children = {};
  ctx.defs.forEach(function (d) {
    ctx.defsByCode[d.LineCode] = d;
    if (!ctx.byName[d.LineName]) ctx.byName[d.LineName] = d;
    if (d.ParentLine) (ctx.children[d.ParentLine] = ctx.children[d.ParentLine] || []).push(d.LineCode);
  });
  ctx.taxDeduct = ctx.defs.filter(function (d) { return String(d.CommodityTaxDeduct || '').toUpperCase() === 'Y'; }).map(function (d) { return d.LineCode; });
  ctx.vehicleLabel = {};
  getVehicles(ctx.typeId).forEach(function (v) { ctx.vehicleLabel[v.VehicleID] = v.VehicleCode || v.VehicleID; });
  ctx.vehicles.forEach(function (v) { if (!ctx.vehicleLabel[v.id]) ctx.vehicleLabel[v.id] = v.id; });
  ctx.params = getParameters(sid);
  ctx.paramDefs = {};
  getParamDefs().forEach(function (d) { ctx.paramDefs[d.ParamName] = d; });
  return ctx;
}

/** 這一格的值(對照表以外的工作表) */
function importCell_(ctx, sheet, col, row) {
  var s = ctx.sheets[sheet];
  return s ? s[col + row] || null : null;
}

/* ======================= Excel 公式 → 系統公式 ======================= */

var VERIFY_SM_VARS_ = { 'sm:建議零售價': '建議零售價', 'sm:強配件售價': '強配件售價', 'sm:廢車處理費': '廢車處理費', 'sm:水平配件調降': '水平配件調降',
  'sm:月銷量': '月銷量', 'sm:LC年限': 'LC年限' };

function excelToSystemAst_(ast, ctx, code, vehicle) {
  var S = VERIFY_SHEETS_;
  var colOf = function (c) { return xlsxCol_(c); };
  var refToNode = function (ref) {
    var sheet = ref.sheet || S.pl;
    var col = colOf(ref.c1), row = ref.r1 + 1;
    var where = (ref.sheet ? ref.sheet + '!' : '') + col + row;
    if (sheet === S.pl) {
      var c = ctx.plRow[row];
      if (!c) throw excelFormulaError_(where + ' 不是科目的格子');
      if (col !== vehicle.col) throw excelFormulaError_(where + ' 是別的車系欄（系統的公式只能引用同一個車系的科目）');
      return { t: 'code', v: c };
    }
    if (sheet === S.input) {
      var key = ctx.inputRow[row];
      if (!key) throw excelFormulaError_(where + ' 不是輸入的項目');
      if (col !== vehicle.col && col !== 'C') throw excelFormulaError_(where + ' 是別的車系欄');
      if (VERIFY_SM_VARS_[key]) return { t: 'name', v: VERIFY_SM_VARS_[key] };
      if (/^var:/.test(key)) return { t: 'name', v: key.slice(4) };
      if (/^param:/.test(key)) return { t: 'name', v: key.slice(6) };
      if (/^fx:/.test(key)) return { t: 'name', v: key.slice(3) + '匯率' };
      if (/^amt:/.test(key)) {
        var lc = key.slice(4);
        if (ctx.amtcur[lc + '|' + vehicle.id]) throw excelFormulaError_(where + ' 是外幣原幣金額，請改引用損益試算表的科目');
        return { t: 'code', v: lc };
      }
      if (/^ref:/.test(key)) {
        var args = key.slice(4).split('|').filter(function (x, i) { return i < 2 || x; });
        return { t: 'call', name: 'REF', args: args.map(function (x) { return { t: 'str', v: x }; }) };
      }
      throw excelFormulaError_(where + '（' + key.replace(/^\w+:/, '') + '）不能用在公式裡');
    }
    if (sheet === S.dev) {
      var dc = ctx.devsumRow[row];
      if (!dc || col !== vehicle.devCol) throw excelFormulaError_(where + ' 請引用「開發總投」下方依攤提落點彙總、同一個車系的格子');
      return { t: 'code', v: dc };
    }
    throw excelFormulaError_(where + '：只能引用損益試算、輸入、開發總投三張表');
  };
  var expand = function (ref) {
    if (!ref.range) return [refToNode(ref)];
    if (ref.c1 !== ref.c2) throw excelFormulaError_('範圍只能是同一欄');
    var out = [];
    for (var r = Math.min(ref.r1, ref.r2); r <= Math.max(ref.r1, ref.r2); r++) {
      out.push(refToNode({ sheet: ref.sheet, c1: ref.c1, r1: r, c2: ref.c1, r2: r }));
    }
    return out;
  };
  var sameText = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  var sameSet = function (list, set) {
    var a = list.slice().sort(), b = set.filter(function (c) { return ctx.pl[c] !== undefined; }).sort();
    return a.length === b.length && a.every(function (x, i) { return x === b[i]; });
  };
  return (function conv(n) {
    switch (n.t) {
      case 'num': return { t: 'num', v: n.v };
      case 'str': return { t: 'str', v: n.v };
      case 'ref':
        if (n.range) throw excelFormulaError_('範圍(例：D5:D9)只能放在 SUM、MIN、MAX 裡');
        return refToNode(n);
      case 'neg': return { t: 'neg', a: conv(n.a) };
      case 'bin': {
        var a = conv(n.a), b = conv(n.b);
        // (比較式)*1 → 比較式(驗算檔為了讓整格顯示 1/0 才乘 1)
        if (n.op === '*' && b.t === 'num' && b.v === 1 && a.t === 'bin' && ['=', '<>', '<', '>', '<=', '>='].indexOf(a.op) !== -1) return a;
        return { t: 'bin', op: n.op, a: a, b: b };
      }
      case 'call': {
        var name = n.name;
        if (VERIFY_IMPORT_FUNCTIONS_.indexOf(name) === -1) {
          throw excelFormulaError_('系統沒有 ' + name + '()，可以用的函式：' + VERIFY_IMPORT_FUNCTIONS_.join('、'));
        }
        var args = [];
        n.args.forEach(function (x) {
          if (x.t === 'ref' && x.range && (name === 'SUM' || name === 'MIN' || name === 'MAX')) args = args.concat(expand(x));
          else args.push(conv(x));
        });
        if (name === 'SUM' && args.length && args.every(function (x) { return x.t === 'code'; })) {
          var codes = args.map(function (x) { return x.v; });
          if (sameSet(codes, ctx.children[code] || [])) return { t: 'call', name: 'CHILDREN', args: [] };
          if (ctx.taxDeduct.length && sameSet(codes, ctx.taxDeduct)) return { t: 'call', name: 'TAXDEDUCT', args: [] };
        }
        // IF(b=0,0,a/b) → a/b：系統的除以 0 本來就是 0
        if (name === 'IF' && args.length === 3 && args[0].t === 'bin' && args[0].op === '=' && args[0].b.t === 'num' && args[0].b.v === 0 &&
          args[1].t === 'num' && args[1].v === 0 && args[2].t === 'bin' && args[2].op === '/' && sameText(args[2].b, args[0].a)) {
          return args[2];
        }
        return { t: 'call', name: name, args: args };
      }
    }
    throw excelFormulaError_('無法轉換的公式片段');
  })(ast);
}

/** 系統公式的標準寫法(比對用)：[科目名稱] 一律換成代碼，ROUND 補位數、IF 補第三個參數 */
function canonicalSystemFormula_(formula, ctx) {
  if (formula === null || formula === undefined) return null;
  var ast;
  try { ast = typeof formula === 'string' ? parseFormula_(formula) : formula; } catch (e) { return 'ERR:' + String(formula); }
  var reserved = {};
  SYSTEM_VARIABLES.forEach(function (v) { reserved[v.name] = true; });
  Object.keys(ctx.paramDefs).forEach(function (n) { reserved[n] = true; });
  var norm = function (n) {
    if (n.t === 'name' && !reserved[n.v] && !/^[A-Za-z]{3}匯率$/.test(n.v) && ctx.byName[n.v]) return { t: 'code', v: ctx.byName[n.v].LineCode };
    if (n.t === 'bin') return { t: 'bin', op: n.op, a: norm(n.a), b: norm(n.b) };
    if (n.t === 'neg') return { t: 'neg', a: norm(n.a) };
    if (n.t === 'call') {
      var args = n.args.map(norm);
      if (/^ROUND/.test(n.name) && args.length === 1) args.push({ t: 'num', v: 0 });
      if (n.name === 'IF' && args.length === 2) args.push({ t: 'num', v: 0 });
      return { t: 'call', name: n.name, args: args };
    }
    return n;
  };
  return systemFormulaText_(norm(ast), ctx, false);
}

/** 系統公式 AST → 文字。readable：科目代碼顯示成 [科目名稱]、REF 的情境顯示名稱 */
function systemFormulaText_(ast, ctx, readable) {
  return verifyPrintAst_(ast, {
    codeName: function (c) { return readable && ctx.defsByCode[c] ? '[' + ctx.defsByCode[c].LineName + ']' : c; },
    refLabel: function (args) {
      var parts = args.map(function (a) { return a.t === 'str' ? a.v : '?'; });
      if (readable) {
        var sc = null;
        try { sc = resolveRefScenario_(parts[0]); } catch (e) { sc = null; }
        if (sc) parts[0] = [sc.VehicleTypeID, sc.Gate, sc.ScenarioName].filter(function (x) { return x; }).join(' ');
      }
      return 'REF(' + parts.map(function (x) { return '"' + x + '"'; }).join(', ') + ')';
    }
  }, 'names');
}

/* ======================= 預覽 ======================= */

function verifyCurrentFormula_(d, vid) {
  if (!d) return null;
  var f = lineFormulaFor_(d, vid);
  var useFormula = d.CalcType === CALC_TYPES.FORMULA || f !== '' && parseVehicleFormulas_(d.VehicleFormulas)[vid];
  return useFormula ? f : null;
}

/** 輸入項目目前在系統裡的值(跟匯出時同一種口徑：% 參數是小數、外幣是原幣) */
function verifyCurrentInput_(ctx, key, vid) {
  var sid = ctx.scenarioId;
  var mix = getSalesMix(sid).filter(function (r) { return r.VehicleID === vid; })[0] || {};
  var smField = { 'sm:建議零售價': 'ListPriceTaxIncl', 'sm:強配件售價': 'MandatoryAccessoryPrice', 'sm:廢車處理費': 'ScrapFee',
    'sm:水平配件調降': 'HorizontalPartsPriceAdj', 'sm:月銷量': 'MonthlyVolume', 'sm:LC年限': 'LifeCycleYears', 'sm:構成比原值': 'SalesMixPct' };
  if (smField[key]) return toNumber_(mix[smField[key]]);
  if (key === 'sm:廢車稅別') return mix.ScrapFeeTaxStatus === '未稅' ? '未稅' : '含稅';
  if (key === 'sm:攤提基準月銷量') return toNumber_(ctx.scenario.AmortMonthlyVolume);
  if (key === 'sm:攤提基準LC年限') return toNumber_(ctx.scenario.AmortLifeCycleYears);
  if (/^param:/.test(key)) {
    var def = ctx.paramDefs[key.slice(6)];
    return def ? paramValueForFormula_(ctx.params, def, vid) : 0;
  }
  if (/^fx:/.test(key)) return fxRateFor_(ctx.params, key.slice(3), vid);
  if (/^amt:/.test(key)) {
    var list = verifyAmountRows_(ctx, key.slice(4), vid);
    return list.length ? toNumber_(list[0].row.Amount) : 0;
  }
  if (/^dev:/.test(key)) {
    var parts = key.split(':');
    var row = getDevInvestment(sid).filter(function (r) { return r.RowID === parts[1]; })[0];
    if (!row) return null;
    return parts[2] === 'pct' ? toNumber_(row.ChallengeReductionPct) / 100 : toNumber_(row.Amount);
  }
  if (/^ref:/.test(key)) {
    var a = key.slice(4).split('|');
    try { return referenceValue_(a[0], a[1], a[2] || '', vid); } catch (e) { return 0; }
  }
  return null;
}
function verifyAmountRows_(ctx, code, vid) {
  var out = [];
  getCostOfSales(ctx.scenarioId, vid).forEach(function (r) { if (r.LineCode === code) out.push({ sheet: SHEETS.COST_OF_SALES, row: r }); });
  getOperatingExpense(ctx.scenarioId, vid).forEach(function (r) { if (r.LineCode === code) out.push({ sheet: SHEETS.OPERATING_EXPENSE, row: r }); });
  return out;
}

function sameValue_(a, b) {
  if (typeof a === 'number' || typeof b === 'number') {
    var x = toNumber_(a), y = toNumber_(b);
    return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  }
  return String(a === undefined || a === null ? '' : a) === String(b === undefined || b === null ? '' : b);
}

function verifyInputLabel_(ctx, key) {
  if (/^sm:/.test(key)) return { 'sm:廢車稅別': '廢車處理費登打方式', 'sm:構成比原值': '構成比（登打值）', 'sm:攤提基準月銷量': '攤提基準 月銷量', 'sm:攤提基準LC年限': '攤提基準 LC年限' }[key] || key.slice(3);
  if (/^param:/.test(key)) return '參數：' + key.slice(6);
  if (/^fx:/.test(key)) return '匯率：' + key.slice(3);
  if (/^amt:/.test(key)) { var d = ctx.defsByCode[key.slice(4)]; return '金額：' + (d ? d.LineName : key.slice(4)); }
  if (/^dev:/.test(key)) {
    var parts = key.split(':');
    var row = getDevInvestment(ctx.scenarioId).filter(function (r) { return r.RowID === parts[1]; })[0] || {};
    return '開發總投：' + (row.Department || '') + (row.Notes ? '（' + row.Notes + '）' : '') + (parts[2] === 'pct' ? ' 低減目標' : ' 金額');
  }
  return key;
}

/**
 * 預覽：回傳 { scenario, formulas: [...], inputs: [...], problems: [...] }。
 * formulas/inputs 的每一項有 id(套用時用)、conflict(匯出後系統也改過，預設不勾)。
 */
function previewVerifyImport(files) {
  return buildVerifyImportPlan_(verifyImportContext_(files));
}

function buildVerifyImportPlan_(ctx) {
  var S = VERIFY_SHEETS_;
  var problems = [], formulas = [], inputs = [];
  var plSheet = ctx.sheets[S.pl] || {};

  /* ---- 公式：每個科目 × 車系 ---- */
  var perLine = {}, amountFromPl = [];
  Object.keys(ctx.pl).forEach(function (code) {
    var row = ctx.pl[code];
    ctx.vehicles.forEach(function (v) {
      var key = code + '|' + v.id;
      var exp = ctx.plf[key] || { excel: '', sys: '' };
      var cell = plSheet[v.col + row] || { f: null, v: '' };
      var fileText = cell.f ? cell.f : (cell.v === '' || cell.v === null ? '' : String(cell.v));
      if (exp.excel && cell.f && normalizeExcelText_(cell.f) === normalizeExcelText_(exp.excel)) return;   // 沒改
      if (!exp.excel && !cell.f) return;                                                             // 匯出時就是固定值(翻不過去的科目)，沒改成公式
      var d = ctx.defsByCode[code];
      var label = (d ? d.LineName : code) + '（' + ctx.vehicleLabel[v.id] + '）';
      if (!d) { problems.push({ where: S.pl + '!' + v.col + row, label: label, reason: '這個科目在系統裡已經刪除了' }); return; }
      // 手動輸入的科目，在損益試算直接打數字 = 改這個車系的金額(不是把科目改成固定數字的公式)
      if (d.CalcType === CALC_TYPES.INPUT && verifyCurrentFormula_(d, v.id) === null && !cell.f && typeof cell.v === 'number') {
        if (ctx.amtcur[key]) problems.push({ where: S.pl + '!' + v.col + row, label: label, reason: '這個科目用外幣登打，請到「輸入」表改原幣金額' });
        else amountFromPl.push({ code: code, vid: v.id, v: cell.v, where: S.pl + '!' + v.col + row });
        return;
      }
      var sysAst;
      try {
        if (cell.f) sysAst = excelToSystemAst_(parseExcelFormula_(cell.f), ctx, code, v);
        else if (typeof cell.v === 'number') sysAst = { t: 'num', v: cell.v };
        else throw excelFormulaError_('這一格是空白或文字');
      } catch (e) {
        if (!e.isImportError && !e.isFormulaError) throw e;
        problems.push({ where: S.pl + '!' + v.col + row, label: label, reason: e.message, excel: fileText });
        return;
      }
      var newFormula = systemFormulaText_(sysAst, ctx, false);
      // 引用自己 = 照原本的來源(手動輸入/開發攤提的格子被改成指回同一筆金額)，不算改公式
      if (sysAst.t === 'code' && sysAst.v === code) return;
      var now = verifyCurrentFormula_(d, v.id);
      var canonNew = canonicalSystemFormula_(newFormula, ctx);
      if (now !== null && canonicalSystemFormula_(now, ctx) === canonNew) return;   // 寫法不同、意思一樣
      var exportSys = exp.sys || null;
      var conflict = canonicalSystemFormula_(now, ctx) !== canonicalSystemFormula_(exportSys, ctx);
      (perLine[code] = perLine[code] || []).push({ vid: v.id, formula: newFormula, ast: sysAst, conflict: conflict, constant: !cell.f, excel: fileText });
    });
  });
  Object.keys(perLine).forEach(function (code) {
    var d = ctx.defsByCode[code];
    var changes = perLine[code];
    var groups = {};
    changes.forEach(function (c) { (groups[c.formula] = groups[c.formula] || []).push(c); });
    var allVehicles = ctx.vehicles.length === changes.length && Object.keys(groups).length === 1;
    var notes = [];
    if (changes.some(function (c) { return c.constant; })) notes.push('改成固定數字（不是公式），之後輸入的數字改了它也不會跟著變');
    if (d.CalcType !== CALC_TYPES.FORMULA && allVehicles) notes.push('計算來源從「' + (d.CalcType === CALC_TYPES.DEV_AMORT ? '開發總投攤提' : '手動輸入') + '」改成公式，原本的金額不再使用');
    if (!allVehicles) notes.push('只有部分車系改了：存成這幾個車系的個別公式');
    notes.push('科目表是整個車型共用：會影響車型 ' + ctx.typeId + ' 的所有情境');
    var before = ctx.vehicles.map(function (v) {
      var f = verifyCurrentFormula_(d, v.id);
      return f === null ? (d.CalcType === CALC_TYPES.DEV_AMORT ? '（開發總投攤提）' : '（手動輸入）') : verifyReadableFormula_(f, ctx.defsByCode);
    }).filter(function (x, i, a) { return a.indexOf(x) === i; });
    formulas.push({
      id: 'f:' + code, code: code, name: d.LineName,
      vehicles: changes.map(function (c) { return ctx.vehicleLabel[c.vid]; }),
      before: before.join(' ／ '),
      after: Object.keys(groups).map(function (f) { return '=' + systemFormulaText_(groups[f][0].ast, ctx, true); }).join(' ／ '),
      notes: notes, conflict: changes.some(function (c) { return c.conflict; }),
      _changes: changes, _all: allVehicles
    });
  });
  // 加權平均欄是算出來的
  var wCol = String(ctx.meta.weightedCol || '');
  Object.keys(ctx.pl).forEach(function (code) {
    var cell = plSheet[wCol + ctx.pl[code]];
    if (cell && cell.f && !/^SUMPRODUCT\(/i.test(normalizeExcelText_(cell.f))) {
      problems.push({ where: S.pl + '!' + wCol + ctx.pl[code], label: code + ' 加權平均', reason: '加權平均欄是各車系 × 構成比算出來的，不會匯入' });
    }
  });

  /* ---- 輸入數字 ---- */
  var cellOfInput = function (key, vid) {
    if (/^dev:/.test(key)) {
      var parts = key.split(':');
      var r = ctx.dev[parts[1]];
      return r ? { sheet: S.dev, ref: (parts[2] === 'pct' ? 'K' : 'G') + r } : null;
    }
    var row = ctx.input[key];
    if (!row) return null;
    var v = vid ? ctx.vehicles.filter(function (x) { return x.id === vid; })[0] : null;
    return { sheet: S.input, ref: (v ? v.col : 'C') + row };
  };
  var addInput = function (key, vid, exportValue, cell, fromFormula) {
    var fileValue = cell.v;
    if (fileValue && typeof fileValue === 'object') { problems.push({ where: cell.where, label: verifyInputLabel_(ctx, key), reason: 'Excel 算出錯誤值 ' + fileValue.error }); return; }
    if (exportValue !== undefined && sameValue_(fileValue, exportValue)) return;
    var label = verifyInputLabel_(ctx, key);
    var vlabel = vid ? ctx.vehicleLabel[vid] : (/^(dev|sm:攤提)/.test(key) ? '' : '全車系（共用）');
    if (/^ref:/.test(key)) { problems.push({ where: cell.where, label: label, reason: '跨情境引用是另一個情境的數字，要改請到那個情境改' }); return; }
    if (key === 'sm:廢車稅別' && ['含稅', '未稅'].indexOf(String(fileValue)) === -1) { problems.push({ where: cell.where, label: label, reason: '只能填「含稅」或「未稅」' }); return; }
    if (key !== 'sm:廢車稅別' && (fileValue === '' || typeof fileValue !== 'number')) { problems.push({ where: cell.where, label: label, reason: '不是數字' }); return; }
    if (/^amt:/.test(key) && ctx.amtmixed[key.slice(4) + '|' + vid]) { problems.push({ where: cell.where, label: label, reason: '這一格在系統裡是好幾筆合計，請到成本與費用頁改' }); return; }
    var now = verifyCurrentInput_(ctx, key, vid);
    if (sameValue_(now, fileValue)) return;
    var notes = [];
    if (fromFormula) notes.push('這一格原本引用「共用」欄，改成數字後存成這個車系的個別值');
    if (/^dev:.*:pct$/.test(key) && isBaselineScenario_(ctx.scenarioId)) notes.push('現況情境不套用低減目標');
    if (cell.formula) notes.push('這一格是公式，匯入的是它算出來的值');
    var isPct = /^dev:.*:pct$/.test(key) || /^param:/.test(key) && (ctx.paramDefs[key.slice(6)] || {}).Unit === '%';
    inputs.push({ id: 'i:' + key + '|' + vid, key: key, vid: vid, label: label, vehicle: vlabel,
      before: now, after: fileValue, isPct: isPct, notes: notes,
      conflict: exportValue !== undefined && !sameValue_(now, exportValue) });
  };
  var getCell = function (key, vid) {
    var loc = cellOfInput(key, vid);
    if (!loc) return null;
    var c = importCell_(ctx, loc.sheet, loc.ref.replace(/\d+$/, ''), loc.ref.replace(/^[A-Z]+/, ''));
    var where = loc.sheet + '!' + loc.ref;
    if (!c) return { v: '', formula: false, where: where };
    return { v: c.v, formula: !!c.f, where: where, f: c.f };
  };
  ctx.inval.forEach(function (x) {
    var c = getCell(x.key, x.vid);
    if (c) addInput(x.key, x.vid, x.value, c, false);
  });
  amountFromPl.forEach(function (x) {
    var key = 'amt:' + x.code;
    if (inputs.some(function (it) { return it.id === 'i:' + key + '|' + x.vid; })) return;   // 「輸入」表也改了，以輸入表為準
    addInput(key, x.vid, undefined, { v: x.v, where: x.where, formula: false }, false);
    var last = inputs[inputs.length - 1];
    if (last && last.id === 'i:' + key + '|' + x.vid) last.notes.push('在「損益試算」直接改了這個手動輸入科目的金額');
  });
  ctx.infml.forEach(function (x) {
    if (!/^(param|fx):/.test(x.key) || !x.vid) return;
    var c = getCell(x.key, x.vid);
    if (c && !c.formula && c.v !== '') addInput(x.key, x.vid, undefined, c, true);
  });

  return {
    scenario: { id: ctx.scenarioId, label: [ctx.typeId, ctx.scenario.Gate, ctx.scenario.ScenarioName].filter(function (x) { return x; }).join(' '), typeId: ctx.typeId },
    exportedAt: String(ctx.meta.exportedAt || ''),
    formulas: formulas.map(function (f) { var c = {}; Object.keys(f).forEach(function (k) { if (k.charAt(0) !== '_') c[k] = f[k]; }); return c; }),
    inputs: inputs, problems: problems,
    _formulas: formulas
  };
}

/* ======================= 套用 ======================= */

/**
 * 套用勾選的項目。先自動存一份快照(匯入前的數字，之後可以在驗算檔「跟快照比」)。
 * 回傳 { applied, failed: [{ label, error }], snapshot }。
 */
function applyVerifyImport(files, ids) {
  var ctx = verifyImportContext_(files);
  var plan = buildVerifyImportPlan_(ctx);
  var want = {};
  (ids || []).forEach(function (id) { want[id] = true; });
  var formulaItems = plan._formulas.filter(function (f) { return want[f.id]; });
  var inputItems = plan.inputs.filter(function (x) { return want[x.id]; });
  if (!formulaItems.length && !inputItems.length) return { applied: 0, failed: [], snapshot: null };

  var snapshot = createSnapshot(ctx.scenarioId, '匯入 Excel 前 ' + formatDateTime_(new Date()), '從 Excel 驗算檔匯入前自動存的');
  var failed = [], applied = 0;
  var sid = ctx.scenarioId;

  /* ---- 輸入數字 ---- */
  var mixRows = {}, devChanged = false, devRows = sortByOrder_(getDevInvestment(sid), 'SortOrder').map(function (r) { var c = {}; Object.keys(r).forEach(function (k) { c[k] = r[k]; }); return c; });
  var scenarioRow = null, paramWrites = [], amountWrites = {};
  var copy = function (r) { var c = {}; Object.keys(r).forEach(function (k) { c[k] = r[k]; }); return c; };
  var round = function (x) { return Math.round(x * 1e10) / 1e10; };
  inputItems.forEach(function (it) {
    try {
      var key = it.key, vid = it.vid, val = it.after;
      var smField = { 'sm:建議零售價': 'ListPriceTaxIncl', 'sm:強配件售價': 'MandatoryAccessoryPrice', 'sm:廢車處理費': 'ScrapFee', 'sm:廢車稅別': 'ScrapFeeTaxStatus',
        'sm:水平配件調降': 'HorizontalPartsPriceAdj', 'sm:月銷量': 'MonthlyVolume', 'sm:LC年限': 'LifeCycleYears', 'sm:構成比原值': 'SalesMixPct' };
      if (smField[key]) {
        var mr = mixRows[vid] || copy(getSalesMix(sid).filter(function (r) { return r.VehicleID === vid; })[0] || null);
        if (!mr.RowID) throw new Error('找不到這個車系的銷售構成');
        mr[smField[key]] = val;
        mixRows[vid] = mr;
      } else if (key === 'sm:攤提基準月銷量' || key === 'sm:攤提基準LC年限') {
        scenarioRow = scenarioRow || copy(ctx.scenario);
        scenarioRow[key === 'sm:攤提基準月銷量' ? 'AmortMonthlyVolume' : 'AmortLifeCycleYears'] = val;
      } else if (/^param:/.test(key)) {
        var name = key.slice(6), def = ctx.paramDefs[name];
        if (!def) throw new Error('參數「' + name + '」已經不存在');
        var raw = def.Unit === '%' ? round(val * 100) : val;
        var existing = ctx.params.filter(function (p) { return p.ParamName === name && (p.VehicleID || '') === (vid || '') && !p.Currency; })[0];
        paramWrites.push({ kind: 'param', ParamID: existing ? existing.ParamID : '', ParamName: name, VehicleID: vid || '', Value: raw });
      } else if (/^fx:/.test(key)) {
        var cur = key.slice(3);
        var ex = ctx.params.filter(function (p) { return p.ParamName === COST_FX_PARAM_NAME && String(p.Currency).toUpperCase() === cur && (p.VehicleID || '') === (vid || ''); })[0];
        paramWrites.push({ kind: 'fx', ParamID: ex ? ex.ParamID : '', ParamName: COST_FX_PARAM_NAME, Currency: cur, VehicleID: vid || '', Value: val });
      } else if (/^amt:/.test(key)) {
        var code = key.slice(4);
        var list = verifyAmountRows_(ctx, code, vid);
        if (list.length > 1) throw new Error('這一格在系統裡是好幾筆合計');
        var target = list[0] ? { sheet: list[0].sheet, row: copy(list[0].row) }
          : { sheet: isCostSectionLine_(ctx.defsByCode[code], ctx.defs) ? SHEETS.COST_OF_SALES : SHEETS.OPERATING_EXPENSE,
            row: { RowID: '', ScenarioID: sid, VehicleID: vid, LineCode: code, Currency: BASE_CURRENCY } };
        target.row.Amount = val;
        (amountWrites[target.sheet] = amountWrites[target.sheet] || []).push(target.row);
      } else if (/^dev:/.test(key)) {
        var parts = key.split(':');
        var dr = devRows.filter(function (r) { return r.RowID === parts[1]; })[0];
        if (!dr) throw new Error('這一筆開發投資已經刪除了');
        if (parts[2] === 'pct') dr.ChallengeReductionPct = round(val * 100); else dr.Amount = val;
        devChanged = true;
      } else throw new Error('不支援的項目');
      applied++;
    } catch (e) { failed.push({ label: it.label + (it.vehicle ? '（' + it.vehicle + '）' : ''), error: e.message }); }
  });
  var tryWrite = function (label, fn) { try { fn(); } catch (e) { failed.push({ label: label, error: e.message }); } };
  var mixList = Object.keys(mixRows).map(function (k) { return mixRows[k]; });
  if (mixList.length) tryWrite('銷售構成與售價', function () { saveSalesMixGrid(sid, ctx.typeId, mixList); });
  if (scenarioRow) tryWrite('攤提基準台數', function () { saveScenarioGrid(ctx.typeId, [scenarioRow]); });
  if (paramWrites.length) {
    tryWrite('參數與匯率', function () {
      withLock_(function () {
        batchWriteRows_(SHEETS.PARAMETERS, 'ParamID', paramWrites.map(function (w) {
          return { ParamID: w.ParamID, ScenarioID: sid, VehicleID: w.VehicleID, ParamName: w.ParamName, Currency: w.kind === 'fx' ? w.Currency : '', Value: w.Value, EffectiveDate: '' };
        }), []);
      });
    });
  }
  Object.keys(amountWrites).forEach(function (sheet) {
    tryWrite(sheet === SHEETS.COST_OF_SALES ? '銷貨成本' : '營業費用', function () {
      if (sheet === SHEETS.COST_OF_SALES) saveCostOfSalesMatrix(sid, amountWrites[sheet]);
      else saveOperatingExpenseMatrix(sid, amountWrites[sheet]);
    });
  });
  if (devChanged) tryWrite('開發總投', function () { saveDevInvestmentGrid(sid, devRows); });

  /* ---- 公式 ---- */
  formulaItems.forEach(function (f) {
    try {
      var d = getPLLineItems(ctx.typeId).filter(function (x) { return x.LineCode === f.code; })[0];
      if (!d) throw new Error('科目已經刪除了');
      var vf = parseVehicleFormulas_(d.VehicleFormulas);
      var line = { LineCode: d.LineCode, LineName: d.LineName };
      if (f._all) {
        line.CalcType = CALC_TYPES.FORMULA;
        line.Formula = f._changes[0].formula;
        f._changes.forEach(function (c) { delete vf[c.vid]; });
      } else {
        f._changes.forEach(function (c) {
          if (d.CalcType === CALC_TYPES.FORMULA && canonicalSystemFormula_(c.formula, ctx) === canonicalSystemFormula_(d.Formula, ctx)) delete vf[c.vid];
          else vf[c.vid] = c.formula;
        });
      }
      line.VehicleFormulas = vf;
      saveChartLine(ctx.typeId, line);
      applied++;
    } catch (e) { failed.push({ label: f.name, error: e.message }); }
  });
  return { applied: applied, failed: failed, snapshot: snapshot };
}
