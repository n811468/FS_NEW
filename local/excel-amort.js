/**
 * 開發總投攤提的追蹤：把「單台攤提」的 Excel 公式一路追進開發總投分頁，展開成
 *     Σ(係數 × 部門投資儲存格) ÷ 攤提台數儲存格
 * 追得到就在系統裡建成「開發總投攤提」科目 + 開發總投明細(部門 × 攤提落點 × 金額) + 情境的攤提基準台數，
 * 改台數、做損益兩平、目標情境填挑戰低減% 都會跟著連動；追不到就照舊帶入數字並說明原因。
 *
 * 會遇到的寫法與對策：
 *   =開發總投!C22，C22 = C20/$B$27，C20 = SUM(C5:C19)     → 展開到各部門(C5…C19)，÷ B27
 *   =開發總投!E24，E24 = E22 - E23(費用總計 - 上汽開發費)    → 係數相消：E5 一加一減 = 0，只留其他部門
 *   頂規 = 入門(G23 = D23)                                   → 兩個車系展開結果相同，共用同一組投資
 *   各情境引用不同的開發總投分頁(低減 10% 版)                  → 每個情境各自展開、各自一組投資與攤提台數
 *   ROUND(總額/台數)、各車系來源不同、除以兩種不同的台數、展開出非線性的算式 → 帶入數字(說明原因)
 *   直接打單台金額(沒有公式可追)                              → 可選「用攤提台數回推總額」(excel-pack.js)
 *
 * 「葉節點」(停止展開、當成一筆投資)：有部門名稱的列(左邊有文字、不是合計/總計列)上的數字，
 * 而且它的公式不是彙總(沒有 SUM、沒有除以儲存格)。例如 E5 = 9000000*$E$2/0.8+…(含匯率換算)整格就是一筆投資。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./xlsx-reader.js'), require('./excel-formula.js'));
  else root.FSExcelAmort = factory(root.FSXlsx, root.FSExcelFormula);
}(typeof self !== 'undefined' ? self : this, function (X, F) {
  'use strict';

  var TOTAL_LABEL = /合計|總計|小計|總額|total|sum/i;
  var DEV_LABEL = /模具|設備|治具|檢具|開發費|開發|攤提|專用|試驗|認證|工裝/;

  function str(v) { return v === undefined || v === null ? '' : String(v); }
  function clean(s) { return str(s).replace(/[\r\n\t]+/g, '').replace(/\s{2,}/g, ' ').trim(); }
  function num(cell) { return cell && typeof cell.v === 'number' && isFinite(cell.v) ? cell.v : null; }
  function text(cell) { return cell && typeof cell.v === 'string' ? clean(cell.v) : ''; }
  function fail(reason) { var e = new Error(reason); e.amort = true; return e; }

  /* ---------------- Excel 算式 → 語法樹 ---------------- */
  function parse(f) {
    var tokens = F.tokenize(f), i = 0;
    var peek = function () { return tokens[i]; };
    var isOp = function (v) { var t = peek(); return t && t.t === 'op' && t.v === v; };
    function expr() { return add(); }
    function add() {
      var n = mul();
      while (isOp('+') || isOp('-')) { var op = tokens[i++].v; n = { t: 'bin', op: op, l: n, r: mul() }; }
      return n;
    }
    function mul() {
      var n = pow();
      while (isOp('*') || isOp('/')) { var op = tokens[i++].v; n = { t: 'bin', op: op, l: n, r: pow() }; }
      return n;
    }
    function pow() {
      var n = unary();
      while (isOp('^')) { i++; n = { t: 'bin', op: '^', l: n, r: unary() }; }
      return n;
    }
    function unary() {
      if (isOp('-')) { i++; return { t: 'neg', x: unary() }; }
      if (isOp('+')) { i++; return unary(); }
      var n = primary();
      while (isOp('%')) { i++; n = { t: 'bin', op: '*', l: n, r: { t: 'num', v: 0.01 } }; }
      return n;
    }
    function primary() {
      var t = tokens[i++];
      if (!t) throw fail('算式不完整');
      if (t.t === 'num') return { t: 'num', v: Number(t.v) };
      if (t.t === 'ref') return { t: 'ref', sheet: null, ref: t.ref };
      if (t.t === 'xref') return { t: 'ref', sheet: t.sheet, ref: t.ref };
      if (t.t === 'func') {
        if (!isOp('(')) throw fail('算式不完整');
        i++;
        var args = [];
        if (!isOp(')')) { args.push(expr()); while (isOp(',')) { i++; args.push(expr()); } }
        if (!isOp(')')) throw fail('括號不成對');
        i++;
        return { t: 'func', name: t.v, args: args };
      }
      if (t.t === 'op' && t.v === '(') {
        var e = expr();
        if (!isOp(')')) throw fail('括號不成對');
        i++;
        return e;
      }
      throw fail('看不懂的寫法：' + (t.v || t.t));
    }
    var root = expr();
    if (i < tokens.length) throw fail('看不懂的寫法：' + (tokens[i].v || tokens[i].t));
    return root;
  }

  /* ---------------- 線性展開 ---------------- */
  // Lin = { terms: { 'sheet!ref': 係數 }, c: 常數, div: 'sheet!ref' | null }
  var ZERO = function () { return { terms: {}, c: 0, div: null }; };
  function isConst(a) { return !a.div && !Object.keys(a.terms).length; }
  function isZero(a) { return isConst(a) && Math.abs(a.c) < 1e-12; }
  function scale(a, k) {
    var out = { terms: {}, c: a.c * k, div: a.div };
    Object.keys(a.terms).forEach(function (key) { out.terms[key] = a.terms[key] * k; });
    return out;
  }
  function plus(a, b, sign) {
    if (isZero(b)) return a;
    if (isZero(a)) return sign > 0 ? b : scale(b, -1);
    if (a.div !== b.div) throw fail(a.div && b.div ? '除以兩種不同的攤提台數' : '有的部分除以攤提台數、有的沒有');
    var out = { terms: Object.assign({}, a.terms), c: a.c + sign * b.c, div: a.div };
    Object.keys(b.terms).forEach(function (key) {
      out.terms[key] = (out.terms[key] || 0) + sign * b.terms[key];
      if (Math.abs(out.terms[key]) < 1e-12) delete out.terms[key];
    });
    return out;
  }

  /**
   * 彙總格(要繼續展開)還是一筆投資(葉節點)：有 SUM、除以儲存格、或用相對參照引用同一欄的其他格(I23 = I21 - I22)
   * 都是彙總；E5 = 9000000*$E$2/0.8(絕對參照的匯率)、I6 = E6*(1-$G$3)(同列別欄 × 低減率)是一筆投資。
   */
  function isAggregate(f, col) {
    var s = str(f).replace(/"[^"]*"/g, '');
    if (/SUM\s*\(/i.test(s)) return true;
    if (/\/\s*('[^']+'!|[^\s!()+\-*/^,'"]+!)?\$?[A-Z]{1,3}\$?\d/.test(s)) return true;
    var re = /(^|[^A-Za-z0-9_.!$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(])/g, m;
    while ((m = re.exec(s))) {
      if (X.colToNum(m[3]) === col && !m[4]) return true;
    }
    return false;
  }

  function sheetByName(wb, name) { return wb.sheets.filter(function (s) { return s.name === name; })[0]; }

  /** 這一列的「名稱」：同一列左邊最近的文字 */
  function rowLabel(sheet, r, c) {
    for (var cc = c - 1; cc >= 1; cc--) {
      var t = text(X.cell(sheet, r, cc));
      if (t) return t;
    }
    return '';
  }
  /** 欄標題：往上找第一個文字 */
  function colHeader(sheet, r, c) {
    for (var rr = r - 1; rr >= 1 && rr >= r - 30; rr--) {
      var t = text(X.cell(sheet, rr, c));
      if (t) return t;
    }
    return '';
  }

  /**
   * ctx = { wb, mainSheet, isMainData(r,c): 損益表本身的車系欄資料格(一律展開，不當成葉節點) }
   */
  function linOfCell(ctx, sheet, r, c, depth, visiting) {
    var key = sheet.name + '!' + X.numToCol(c) + r;
    var cell = X.cell(sheet, r, c);
    if (!cell || (cell.v === null && !cell.f)) return ZERO();
    if (depth > 30 || visiting[key]) throw fail('攤提公式繞太多層或互相引用');
    var main = sheet === ctx.mainSheet && ctx.isMainData(r, c);
    if (!main) {
      var label = rowLabel(sheet, r, c);
      var aggregate = cell.f && isAggregate(cell.f, c);
      if (num(cell) !== null && label && !TOTAL_LABEL.test(label) && !aggregate) {
        var leaf = { terms: {}, c: 0, div: null };
        leaf.terms[key] = 1;
        return leaf;
      }
      if (!cell.f) {
        if (num(cell) === null) throw fail(key + ' 不是數字');
        var lone = { terms: {}, c: 0, div: null };   // 沒有名稱的數字格(例如攤提台數 50000)
        lone.terms[key] = 1;
        return lone;
      }
    } else if (!cell.f) {
      throw fail('損益表上的 ' + key + ' 是直接打的數字');
    }
    visiting[key] = true;
    try { return lin(ctx, parse(cell.f), sheet, depth + 1, visiting); } finally { delete visiting[key]; }
  }

  function lin(ctx, n, sheet, depth, visiting) {
    if (n.t === 'num') return { terms: {}, c: n.v, div: null };
    if (n.t === 'neg') return scale(lin(ctx, n.x, sheet, depth, visiting), -1);
    if (n.t === 'ref') {
      var target = n.sheet ? sheetByName(ctx.wb, n.sheet) : sheet;
      if (!target) throw fail('找不到分頁「' + n.sheet + '」');
      var parts = n.ref.replace(/\$/g, '').split(':');
      if (parts.length > 1) throw fail('範圍只能放在 SUM 裡');
      var p = X.parseRef(parts[0]);
      return linOfCell(ctx, target, p.r, p.c, depth, visiting);
    }
    if (n.t === 'func') {
      if (n.name !== 'SUM') throw fail('攤提公式用了 ' + n.name + '(例如四捨五入)，系統的攤提不會這樣算');
      var acc = ZERO();
      n.args.forEach(function (a) {
        if (a.t === 'ref' && /:/.test(a.ref)) {
          var t2 = a.sheet ? sheetByName(ctx.wb, a.sheet) : sheet;
          if (!t2) throw fail('找不到分頁「' + a.sheet + '」');
          var ab = a.ref.replace(/\$/g, '').split(':').map(X.parseRef);
          for (var rr = Math.min(ab[0].r, ab[1].r); rr <= Math.max(ab[0].r, ab[1].r); rr++) {
            for (var cc = Math.min(ab[0].c, ab[1].c); cc <= Math.max(ab[0].c, ab[1].c); cc++) {
              acc = plus(acc, linOfCell(ctx, t2, rr, cc, depth, visiting), 1);
            }
          }
        } else acc = plus(acc, lin(ctx, a, sheet, depth, visiting), 1);
      });
      return acc;
    }
    if (n.t === 'bin') {
      var a1 = lin(ctx, n.l, sheet, depth, visiting), b1 = lin(ctx, n.r, sheet, depth, visiting);
      if (n.op === '+') return plus(a1, b1, 1);
      if (n.op === '-') return plus(a1, b1, -1);
      if (n.op === '*') {
        if (isConst(a1)) return scale(b1, a1.c);
        if (isConst(b1)) return scale(a1, b1.c);
        throw fail('攤提公式裡有兩個儲存格相乘');
      }
      if (n.op === '/') {
        if (isConst(b1)) { if (!b1.c) throw fail('除以 0'); return scale(a1, 1 / b1.c); }
        var keys = Object.keys(b1.terms);
        if (!b1.div && keys.length === 1 && Math.abs(b1.terms[keys[0]] - 1) < 1e-12 && Math.abs(b1.c) < 1e-12 && !a1.div) {
          return { terms: a1.terms, c: a1.c, div: keys[0] };
        }
        throw fail('除數不是單一個攤提台數儲存格');
      }
      throw fail('攤提公式裡有 ' + n.op);
    }
    throw fail('看不懂的寫法');
  }

  function cellOfKey(wb, key) {
    var i = key.lastIndexOf('!');
    var sheet = sheetByName(wb, key.slice(0, i));
    var p = X.parseRef(key.slice(i + 1));
    return { sheet: sheet, r: p.r, c: p.c, ref: key.slice(i + 1), cell: X.cell(sheet, p.r, p.c) };
  }

  /**
   * 低減版的投資常寫成「原始金額 × (1 - 低減率)」(I6 = E6*(1-$G$3)、G9 = C9*(1-10%))：
   * 對應系統開發總投的「原始金額 + 挑戰低減%」(只有目標情境會套用低減)。回傳 { original, pct } 或 null。
   */
  function reductionOf(loc, coef) {
    var f = loc.cell && loc.cell.f ? loc.cell.f.replace(/\s+/g, '') : '';
    var m = /^(\$?[A-Z]{1,3}\$?\d+)\*\(1-(\$?[A-Z]{1,3}\$?\d+|\d*\.?\d+%?)\)$/.exec(f);
    if (!m) return null;
    var p = X.parseRef(m[1].replace(/\$/g, ''));
    var original = num(X.cell(loc.sheet, p.r, p.c));
    var rate;
    if (/^\$?[A-Z]/.test(m[2])) { var q = X.parseRef(m[2].replace(/\$/g, '')); rate = num(X.cell(loc.sheet, q.r, q.c)); }
    else rate = /%$/.test(m[2]) ? Number(m[2].slice(0, -1)) / 100 : Number(m[2]);
    if (original === null || rate === null || !isFinite(rate) || rate < 0 || rate >= 1) return null;
    return { original: original * coef, pct: Math.round(rate * 100 * 1e9) / 1e9 };
  }

  function categoryOf(textValue) {
    if (/模具/.test(textValue)) return '模具';
    if (/設備|治具|檢具|工裝/.test(textValue)) return '設備';
    return '費用';
  }

  /** 攤提台數儲存格附近(上下 4 列、左右 4 欄)找 L/C 月數：本身的標籤(左邊或正上方)含「月」的數字 */
  function monthsNear(loc) {
    var best = null;
    for (var dr = -4; dr <= 4; dr++) {
      for (var dc = -4; dc <= 4; dc++) {
        if (!dr && !dc) continue;
        var r = loc.r + dr, c = loc.c + dc;
        if (r < 1 || c < 1) continue;
        var v = num(X.cell(loc.sheet, r, c));
        if (v === null || v <= 0 || v > 600) continue;
        var label = text(X.cell(loc.sheet, r, c - 1)) + '|' + text(X.cell(loc.sheet, r - 1, c));
        if (!/月/.test(label) || /台/.test(label)) continue;
        var dist = Math.abs(dr) + Math.abs(dc);
        if (!best || dist < best.dist) best = { v: v, dist: dist };
      }
    }
    return best ? best.v : null;
  }

  /**
   * 展開損益表上某一格(某車系某列)的攤提公式。
   * 回傳 { units: { key, value, label, months }, investments: [{ key, dept, asset, category, amount, notes }], signature }
   * 轉不過去丟出 e.amort = true 的錯誤。
   */
  function traceCell(wb, plan, sheet, row, vi) {
    var v = plan.vehicles[vi];
    var cell = X.cell(sheet, row, v.col);
    if (!cell || !cell.f) throw fail('是直接打的數字，沒有公式可追');
    var vehicleCols = {};
    plan.vehicles.forEach(function (x) { vehicleCols[x.col] = true; });
    if (plan.weightedCol) vehicleCols[plan.weightedCol] = true;
    var ctx = {
      wb: wb, mainSheet: sheet,
      isMainData: function (r, c) { return vehicleCols[c] && r >= plan.firstRow; }
    };
    var res = lin(ctx, parse(cell.f), sheet, 0, {});
    if (!res.div) throw fail('公式沒有除以攤提台數');
    if (!Object.keys(res.terms).length && Math.abs(res.c) < 1e-9) throw fail('展開後沒有任何投資金額');
    var unitsLoc = cellOfKey(wb, res.div);
    var units = num(unitsLoc.cell);
    if (!units || units <= 0) throw fail('攤提台數 ' + res.div + ' 不是正數');
    var investments = Object.keys(res.terms).sort().map(function (key) {
      var loc = cellOfKey(wb, key);
      var value = num(loc.cell) || 0;
      var dept = rowLabel(loc.sheet, loc.r, loc.c) || key;
      var asset = colHeader(loc.sheet, loc.r, loc.c);
      var note = '';
      for (var cc = loc.c + 1; cc <= loc.c + 8; cc++) {
        var t = text(X.cell(loc.sheet, loc.r, cc));
        if (t.length >= 4) { note = str(X.cell(loc.sheet, loc.r, cc).v).replace(/\r\n/g, '\n').trim(); break; }
      }
      return {
        key: key, dept: dept, asset: asset, category: categoryOf(asset + dept),
        amount: value * res.terms[key], coef: res.terms[key], notes: note,
        reduction: reductionOf(loc, res.terms[key])
      };
    }).filter(function (x) { return Math.abs(x.amount) > 1e-9; });
    if (Math.abs(res.c) > 1e-9) investments.push({ key: '', dept: '(Excel 公式裡的常數)', asset: '', category: '費用', amount: res.c, coef: 1, notes: '' });
    if (!investments.length) throw fail('展開後沒有任何投資金額');
    var sig = JSON.stringify([res.div, Object.keys(res.terms).sort().map(function (k) { return k + '*' + res.terms[k]; }), res.c]);
    return {
      units: { key: res.div, value: units, label: rowLabel(unitsLoc.sheet, unitsLoc.r, unitsLoc.c) || colHeader(unitsLoc.sheet, unitsLoc.r, unitsLoc.c), months: monthsNear(unitsLoc) },
      investments: investments, signature: sig
    };
  }

  /**
   * 損益表上某一列在某個分頁的攤提展開(所有車系要展開成同一組投資)。
   * 回傳 { units, investments, category, source } 或丟出原因。
   */
  function traceRow(wb, plan, sheet, row) {
    var first = null;
    plan.vehicles.forEach(function (v, vi) {
      var t;
      try { t = traceCell(wb, plan, sheet, row, vi); } catch (e) {
        if (!e.amort) throw e;
        throw fail((plan.vehicles.length > 1 ? v.name + '：' : '') + e.message);
      }
      if (!first) first = t;
      else if (t.signature !== first.signature) throw fail('各車系的攤提來源不同(' + plan.vehicles[0].name + ' 與 ' + v.name + ')，系統的開發總投是全車系共用');
    });
    var cats = {};
    first.investments.forEach(function (x) { cats[x.category] = (cats[x.category] || 0) + Math.abs(x.amount); });
    var category = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; })[0] || '費用';
    var f = X.cell(sheet, row, plan.vehicles[0].col).f || '';
    var m = /^(?:'((?:[^']|'')+)'|([^\s!'"()+\-*/^,:=<>&%;]+))!/.exec(f);
    return { units: first.units, investments: first.investments, category: category, source: m ? (m[1] || m[2]) : sheet.name };
  }

  /** 科目名稱像不像開發攤提(直接打數字時，提示可以用攤提台數回推) */
  function looksLikeDev(label) { return DEV_LABEL.test(label); }

  return { parse: parse, traceCell: traceCell, traceRow: traceRow, looksLikeDev: looksLikeDev, categoryOf: categoryOf };
}));
