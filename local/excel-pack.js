/**
 * Excel 損益試算表 → 資料包：「Excel 轉資料包」工具的核心邏輯(純函式 + 呼叫後端 API，不碰畫面)。
 *
 * 流程：
 *   1. analyzeSheet   猜版面：哪一欄是科目名稱、哪幾欄是各車系金額、哪一欄是加權、哪一欄是說明
 *   2. extractRows    依版面取出每一列：名稱、各車系的值、公式、說明
 *   3. suggestRoles   猜每一列在系統損益鏈上的角色 —— 主要靠 Excel 自己的小計公式：
 *        - 「=D15+SUM(D21:D32)」這種純加總的列是小計，被加的列就是它的明細
 *        - 「=D13-D14-SUM(D33:D38)」這種「前一段結果 - 扣項」的列，串起來就是損益鏈
 *        - 扣項裡本身是加總列的那一個(D14)就是 B 銷貨成本，被減的起點(D13)就是收入
 *      售價那幾列(建議零售價、廢車處理費、構成比…)用名稱判斷。猜完使用者可以在畫面上逐列調整。
 *   4. buildFromPlan  用系統自己的後端 API 建車型、科目表、情境與所有輸入(跟使用者在畫面上操作同一條路)
 *   5. verifyPlan     重算後跟 Excel 上的數字逐格比對(含加權欄)
 *
 * 明細的 Excel 公式盡量轉成系統公式(規則與轉不過去的情況見 local/excel-formula.js)，轉不過去的帶入 Excel 算好的數字；
 * 小計由系統依科目樹計算。最後逐格比對，轉成公式卻對不起來的列自動改回帶入數字(buildAndVerify)。
 * 整張表是貼上值、沒有公式時，小計改由數字推斷(F.inferShapes)。
 * 開發總投的單台攤提追進開發總投分頁(A.traceRow)，建成開發總投攤提科目 + 部門投資明細 + 攤提基準台數(translateAll)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./xlsx-reader.js'), require('./excel-formula.js'), require('./excel-amort.js'));
  else root.FSExcelPack = factory(root.FSXlsx, root.FSExcelFormula, root.FSExcelAmort);
}(typeof self !== 'undefined' ? self : this, function (X, F, A) {
  'use strict';

  var TOLERANCE = 0.01;

  // 系統損益鏈上的結構科目(可以對應到 Excel 的小計列)
  var STRUCTURE = {
    B: '銷貨成本(加總)', C: 'A - B', E: 'C - Σ銷售段', G: 'E - Σ下一段', I: 'G - Σ下一段', K: 'I - J(最後的淨利)'
  };
  // 明細可以掛的父科目：結構小計(J 是 I 與 K 之間的扣項)，或另一個群組列
  var PARENTS = { B: 'B 銷貨成本', E: 'E 銷售段', G: 'G 段', I: 'I 段', J: 'J(I→K 的扣項)' };
  var CHAIN_SLOT_PARENT = { E: 'E', G: 'G', I: 'I', K: 'J' };

  var ROLE_LABELS = {
    skip: '略過',
    'price:list': '售價：建議零售價(含稅)',
    'price:accessory': '售價：強配件售價',
    'price:scrap': '售價：廢車處理費(含稅)',
    mix: '銷售構成比',
    'check:P5': '核對：實際零售價(含稅)',
    'check:P6': '核對：營業稅',
    'check:P7': '核對：銷售佣金',
    'check:P8': '收入：經銷價/廠價(未稅)',
    'sub:B': '小計 B 銷貨成本', 'sub:C': '小計 C = A - B', 'sub:E': '小計 E', 'sub:G': '小計 G', 'sub:I': '小計 I',
    'sub:K': '小計 K 營業淨利(最後一列)',
    group: '群組小計(加總底下明細)',
    detail: '明細(帶入金額)'
  };

  function str(v) { return v === undefined || v === null ? '' : String(v); }
  function clean(s) { return str(s).replace(/[\r\n\t]+/g, '').replace(/\s{2,}/g, ' ').trim(); }
  function num(cell) { return cell && typeof cell.v === 'number' && isFinite(cell.v) ? cell.v : null; }
  function text(cell) { return cell && typeof cell.v === 'string' ? clean(cell.v) : ''; }

  /* =====================================================================
   * 1. 版面
   * ===================================================================== */

  var CURRENCY_TOKEN = /^(TWD|NTD|NT\$|NT|台幣|新台幣|元|金額|RMB|CNY|人民幣|USD|JPY|EUR|%|％|比例|佔比)$/i;
  var FOREIGN_TOKEN = /^(RMB|CNY|人民幣|USD|JPY|EUR)$/i;
  var PCT_TOKEN = /^(%|％|比例|佔比|對廠價%|對收入%)$/;
  var WEIGHT_TOKEN = /加權|平均|合計|total|avg/i;

  /** 某一欄在 firstRow 之上的標題文字(由上而下)，包含跨欄合併的標題 */
  function headersOf(sheet, col, firstRow) {
    var out = [];
    for (var r = 1; r < firstRow; r++) {
      var t = text(X.cell(sheet, r, col));
      if (!t) {
        var m = sheet.merges.filter(function (g) { return r >= g.r1 && r <= g.r2 && col >= g.c1 && col <= g.c2; })[0];
        if (m) t = text(X.cell(sheet, m.r1, m.c1));
      }
      if (t && out[out.length - 1] !== t) out.push(t);
    }
    return out;
  }

  function analyzeSheet(sheet) {
    var maxR = sheet.maxRow, maxC = sheet.maxCol;
    var numCount = {}, textCount = {};
    for (var r = 1; r <= maxR; r++) {
      for (var c = 1; c <= maxC; c++) {
        var cell = X.cell(sheet, r, c);
        if (num(cell) !== null) numCount[c] = (numCount[c] || 0) + 1;
        else if (text(cell)) textCount[c] = (textCount[c] || 0) + 1;
      }
    }
    var numericCols = Object.keys(numCount).map(Number).filter(function (c) { return numCount[c] >= 3; });
    if (!numericCols.length) throw new Error('這個分頁找不到數字欄位');

    // 科目名稱欄：在「有數字的列」裡最常出現文字、且位在數字欄左邊的那一欄
    var firstNum = Math.min.apply(null, numericCols);
    var best = { col: 0, score: -1 };
    for (var lc = 1; lc <= Math.max(firstNum, 1); lc++) {
      var score = 0;
      for (var r2 = 1; r2 <= maxR; r2++) {
        if (!text(X.cell(sheet, r2, lc))) continue;
        if (numericCols.some(function (nc) { return nc > lc && num(X.cell(sheet, r2, nc)) !== null; })) score++;
      }
      if (score > best.score) best = { col: lc, score: score };
    }
    var labelCol = best.col;

    // 資料列：有科目名稱、且右邊至少兩欄有數字(只有一個數字的多半是旁邊參數表的列，例如車型說明 + 利潤率)
    var rows = [];
    for (var r3 = 1; r3 <= maxR; r3++) {
      if (!text(X.cell(sheet, r3, labelCol))) continue;
      var n = numericCols.filter(function (nc) { return nc > labelCol && num(X.cell(sheet, r3, nc)) !== null; }).length;
      if (n >= Math.min(2, numericCols.filter(function (nc) { return nc > labelCol; }).length)) rows.push(r3);
    }
    if (!rows.length) throw new Error('這個分頁找不到「科目名稱 + 金額」的列');
    var firstRow = rows[0], lastRow = rows[rows.length - 1];

    // 候選金額欄：在資料列裡至少一半有數字
    var columns = numericCols.filter(function (c) { return c > labelCol; }).map(function (c) {
      var filled = rows.filter(function (rr) { return num(X.cell(sheet, rr, c)) !== null; });
      var small = filled.filter(function (rr) { return Math.abs(num(X.cell(sheet, rr, c))) <= 1.5; }).length;
      var headers = headersOf(sheet, c, firstRow);
      // 車系名稱取「最靠近資料」的那一層標題(上面幾層通常是整張表的大標題)
      var name = headers.filter(function (h) { return !CURRENCY_TOKEN.test(h); }).pop() || '';
      return {
        col: c, letter: X.numToCol(c), headers: headers, name: name,
        fill: filled.length / rows.length,
        foreign: headers.some(function (h) { return FOREIGN_TOKEN.test(h); }),
        pct: headers.some(function (h) { return PCT_TOKEN.test(h); }) || (filled.length > 0 && small / filled.length > 0.8),
        weighted: WEIGHT_TOKEN.test(name)
      };
    }).filter(function (c) { return c.fill >= 0.5; });

    var amountCols = columns.filter(function (c) { return !c.pct; });
    var hasLocal = amountCols.some(function (c) { return !c.foreign; });
    var usable = amountCols.filter(function (c) { return !(hasLocal && c.foreign); });
    var weighted = usable.filter(function (c) { return c.weighted; })[0] || null;
    // 同一個車系名稱(跨欄合併的標題)只取第一欄(通常是台幣)，其他欄是同一組數字換算成別的單位
    var seenName = {};
    var vehicles = usable.filter(function (c) {
      if (c === weighted) return false;
      var key = c.name || c.letter;
      if (seenName[key]) return false;
      seenName[key] = true;
      return true;
    }).map(function (c) { return { col: c.col, name: c.name || ('車系' + c.letter) }; });

    // 說明欄：數字欄右邊、資料列裡最多長文字的那一欄
    var noteCol = 0, noteScore = 0;
    var lastValueCol = Math.max.apply(null, vehicles.map(function (v) { return v.col; }).concat(weighted ? [weighted.col] : []).concat([labelCol]));
    for (var nc = lastValueCol + 1; nc <= maxC; nc++) {
      var s = rows.filter(function (rr) { return text(X.cell(sheet, rr, nc)).length >= 4; }).length;
      if (s > noteScore) { noteScore = s; noteCol = nc; }
    }

    return {
      labelCol: labelCol, firstRow: firstRow, lastRow: lastRow,
      columns: columns, vehicles: vehicles,
      weightedCol: weighted ? weighted.col : 0,
      noteCol: noteScore >= 2 ? noteCol : 0
    };
  }

  /* =====================================================================
   * 2. 取出各列
   * ===================================================================== */

  function extractRows(sheet, layout) {
    var out = [];
    for (var r = layout.firstRow; r <= layout.lastRow; r++) {
      var label = text(X.cell(sheet, r, layout.labelCol));
      var values = layout.vehicles.map(function (v) { return num(X.cell(sheet, r, v.col)); });
      var weighted = layout.weightedCol ? num(X.cell(sheet, r, layout.weightedCol)) : null;
      if (!label && values.every(function (v) { return v === null; })) continue;
      if (!label) continue;
      var first = layout.vehicles[0] ? X.cell(sheet, r, layout.vehicles[0].col) : null;
      out.push({
        row: r, label: label, values: values, weighted: weighted,
        formula: first && first.f ? first.f : '',
        formulas: layout.vehicles.map(function (v) { var c = X.cell(sheet, r, v.col); return c && c.f ? c.f : ''; }),
        note: layout.noteCol ? text(X.cell(sheet, r, layout.noteCol)) : ''
      });
    }
    return out;
  }

  /* =====================================================================
   * 3. 猜角色
   * ===================================================================== */

  /** 頂層依 + / - 拆項(括號裡的不拆) */
  function splitTerms(f) {
    var s = str(f).replace(/^=/, '').replace(/\s+/g, '');
    var terms = [], depth = 0, cur = '', sign = 1, inStr = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '"') inStr = !inStr;
      if (!inStr) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (depth === 0 && (ch === '+' || ch === '-')) {
          if (cur) terms.push({ sign: sign, text: cur });
          else if (ch === '-') { sign = -sign; continue; }   // 開頭的負號
          cur = ''; sign = ch === '-' ? -1 : 1;
          continue;
        }
      }
      cur += ch;
    }
    if (cur) terms.push({ sign: sign, text: cur });
    return terms;
  }

  /** 「同一欄的儲存格或範圍」→ 列號；不是的話回傳 null */
  function rowsOfRef(t, col) {
    var m = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(t);
    if (!m) return null;
    if (X.colToNum(m[1]) !== col) return null;
    if (m[3] && X.colToNum(m[3]) !== col) return null;
    var a = Number(m[2]), b = m[4] ? Number(m[4]) : a, out = [];
    for (var r = Math.min(a, b); r <= Math.max(a, b); r++) out.push(r);
    return out;
  }

  /** 分析一列的公式：純加總 / 前一段 - 扣項 / 其他 */
  function formulaShape(f, col) {
    if (!f) return { kind: 'none' };
    var terms = splitTerms(f).map(function (t) {
      var rows = rowsOfRef(t.text, col);
      var sm = /^SUM\((.*)\)$/i.exec(t.text);
      if (!rows && sm) {
        rows = [];
        var ok = sm[1].split(',').every(function (a) { var rr = rowsOfRef(a, col); if (rr) rows = rows.concat(rr); return !!rr; });
        if (!ok) rows = null;
      }
      return { sign: t.sign, rows: rows, single: !!rows && !sm && rows.length === 1 };
    });
    if (!terms.length || terms.some(function (t) { return !t.rows; })) return { kind: 'other' };
    var plus = terms.filter(function (t) { return t.sign > 0; });
    var minus = terms.filter(function (t) { return t.sign < 0; });
    var flat = function (ts) { return [].concat.apply([], ts.map(function (t) { return t.rows; })); };
    if (!minus.length) return flat(plus).length >= 2 ? { kind: 'sum', rows: flat(plus) } : { kind: 'other' };
    if (plus.length === 1 && plus[0].single) return { kind: 'deduct', base: plus[0].rows[0], minus: flat(minus) };
    return { kind: 'other' };
  }

  var NAME_RULES = [
    { re: /建議(零)?售價/, role: 'price:list' },
    { re: /強配/, role: 'price:accessory' },
    { re: /廢車/, role: 'price:scrap' },
    { re: /構(成)?比|銷售構成|比重/, role: 'mix' },
    { re: /實際(零)?售價/, role: 'check:P5' },
    { re: /營業稅/, role: 'check:P6' },
    { re: /佣金|傭金/, role: 'check:P7' }
  ];

  /**
   * 猜每一列的角色。回傳 { roles: { 列號: { role, parent } }, notes: [給使用者看的說明] }
   */
  function suggestRoles(rows, layout) {
    var col = layout.vehicles[0] ? layout.vehicles[0].col : 0;
    var byRow = {};
    rows.forEach(function (r) { byRow[r.row] = r; r.shape = formulaShape(r.formula, col); });
    F.inferShapes(rows);   // 沒有公式的列(貼上值)：由數字推斷是不是小計
    var roles = {};
    var notes = [];
    rows.forEach(function (r) { roles[r.row] = { role: 'skip', parent: '' }; });
    var set = function (row, role, parent) { if (byRow[row]) roles[row] = { role: role, parent: parent || '' }; };
    var descendants = function (row, seen) {
      seen = seen || {};
      var r = byRow[row];
      if (!r || r.shape.kind !== 'sum' || seen[row]) return 0;
      seen[row] = true;
      return r.shape.rows.reduce(function (n, c) { return n + 1 + descendants(c, seen); }, 0);
    };

    // 損益鏈的起點：扣項裡有一列是「加總列」的扣減公式(= 收入 - 銷貨成本 - …)
    var start = null, costRow = null;
    rows.some(function (r) {
      if (r.shape.kind !== 'deduct') return false;
      var sums = r.shape.minus.filter(function (m) { return byRow[m] && byRow[m].shape.kind === 'sum'; });
      if (!sums.length) return false;
      sums.sort(function (a, b) { return descendants(b) - descendants(a); });
      start = r; costRow = sums[0];
      return true;
    });
    if (!start) {
      notes.push('找不到「收入 - 銷貨成本 - …」的小計公式，請自己指定 B 銷貨成本、收入與各段小計。');
      rows.forEach(function (r) {
        NAME_RULES.some(function (rule) { if (rule.re.test(r.label)) { set(r.row, rule.role); return true; } return false; });
      });
      return { roles: roles, notes: notes };
    }
    var revenueRow = start.shape.base;

    // 售價段：收入列以上，依名稱判斷
    rows.forEach(function (r) {
      if (r.row >= revenueRow) return;
      NAME_RULES.some(function (rule) { if (rule.re.test(r.label)) { set(r.row, rule.role); return true; } return false; });
    });
    set(revenueRow, 'check:P8');
    set(costRow, 'sub:B');

    // 群組與明細(遞迴掛到父科目底下；同一列只掛一次)
    var assigned = {};
    assigned[revenueRow] = assigned[costRow] = true;
    function attach(childRows, parent) {
      childRows.forEach(function (c) {
        if (assigned[c] || !byRow[c]) return;
        assigned[c] = true;
        if (byRow[c].shape.kind === 'sum') {
          set(c, 'group', parent);
          attach(byRow[c].shape.rows, 'r' + c);
        } else {
          set(c, 'detail', parent);
        }
      });
    }
    attach(byRow[costRow].shape.rows, 'B');

    // 損益鏈：從起點往下，每一段都是「上一段 - 扣項」
    var chain = [start];
    for (;;) {
      var last = chain[chain.length - 1];
      var next = rows.filter(function (r) { return r.row !== last.row && r.shape.kind === 'deduct' && r.shape.base === last.row && chain.indexOf(r) === -1; })
        .sort(function (a, b) { return a.row - b.row; })[0];
      if (!next) break;
      chain.push(next);
    }
    // 第一段只減掉銷貨成本 = 系統的 C
    if (chain[0].shape.minus.length === 1 && chain[0].shape.minus[0] === costRow) {
      set(chain[0].row, 'sub:C');
      assigned[chain[0].row] = true;
      chain = chain.slice(1);
    }
    var slots = { 1: ['K'], 2: ['E', 'K'], 3: ['E', 'I', 'K'], 4: ['E', 'G', 'I', 'K'] }[Math.min(chain.length, 4)] || [];
    if (chain.length > 4) {
      notes.push('Excel 的損益鏈有 ' + chain.length + ' 段小計，系統最多 4 段(E/G/I/K)；前面多出來的 ' + (chain.length - 4) + ' 段請自己調整。');
      chain = chain.slice(chain.length - 4);
    }
    chain.forEach(function (r, i) {
      var slot = slots[i];
      set(r.row, 'sub:' + slot);
      assigned[r.row] = true;
    });
    chain.forEach(function (r, i) {
      var parent = CHAIN_SLOT_PARENT[slots[i]];
      attach(r.shape.minus.filter(function (m) { return m !== costRow && m !== revenueRow; }), parent);
    });
    var unused = ['E', 'G', 'I'].filter(function (s) { return slots.indexOf(s) === -1; });
    if (unused.length && chain.length) notes.push('系統的 ' + unused.join('、') + ' 小計在這份 Excel 沒有對應的列，會照上一段的金額顯示(沒有扣項)。');
    var lastChainRow = chain.length ? chain[chain.length - 1].row : start.row;
    var tail = rows.filter(function (r) { return r.row > lastChainRow && roles[r.row].role === 'skip'; });
    if (tail.length) notes.push('最後一段小計以下的 ' + tail.length + ' 列(' + tail.slice(0, 3).map(function (r) { return r.label; }).join('、') + (tail.length > 3 ? '…' : '') + ')預設略過。');
    return { roles: roles, notes: notes };
  }

  /** 從核對列推算營業稅率、銷售佣金率(百分比數值)；推不出來就用系統預設 */
  function inferRates(rows, roles, vehicleIndex) {
    var i = vehicleIndex || 0;
    var get = function (role) {
      var r = rows.filter(function (x) { return roles[x.row] && roles[x.row].role === role; })[0];
      return r ? r.values[i] : null;
    };
    var p5 = get('check:P5'), p6 = get('check:P6'), p7 = get('check:P7');
    var round4 = function (v) { return Math.round(v * 10000) / 10000; };
    var out = { 營業稅率: 5, 銷售佣金率: 6 };
    if (p5 && p6 !== null && p5 - p6) out.營業稅率 = round4(p6 / (p5 - p6) * 100);
    if (p5 && p6 !== null && p7 !== null && p5 - p6) out.銷售佣金率 = round4(p7 / (p5 - p6) * 100);
    return out;
  }

  /* =====================================================================
   * 4. 建立資料
   * ===================================================================== */

  /**
   * 檢查對應設定有沒有矛盾。回傳錯誤訊息陣列(空 = 可以建立)。
   */
  function planProblems(plan) {
    var errs = [];
    var roles = plan.roles;
    var rowSet = {};
    plan.rows.forEach(function (r) { rowSet[r.row] = r; });
    var count = {};
    Object.keys(roles).forEach(function (k) { var ro = roles[k].role; count[ro] = (count[ro] || 0) + 1; });
    ['price:list', 'price:accessory', 'price:scrap', 'mix', 'check:P5', 'check:P6', 'check:P7', 'check:P8',
      'sub:B', 'sub:C', 'sub:E', 'sub:G', 'sub:I', 'sub:K'].forEach(function (ro) {
      if (count[ro] > 1) errs.push('「' + ROLE_LABELS[ro] + '」只能對應一列(目前 ' + count[ro] + ' 列)');
    });
    if (!count['check:P8'] && !count['price:list']) errs.push('請指定收入列(經銷價/廠價)或建議零售價列');
    if (!plan.vehicles.length) errs.push('請至少選一個車系欄');
    var names = {};
    plan.vehicles.forEach(function (v) {
      if (!clean(v.name)) errs.push('車系名稱不能空白');
      if (names[v.name]) errs.push('車系名稱重複：' + v.name);
      names[v.name] = true;
    });
    if (!/^[A-Za-z0-9][\w\-]*$/.test(str(plan.typeId))) errs.push('車型代號請用英數字(例如 D5X)');

    Object.keys(roles).forEach(function (k) {
      var ro = roles[k];
      if (ro.role !== 'group' && ro.role !== 'detail') return;
      if (!ro.parent) { errs.push('第 ' + k + ' 列「' + rowSet[k].label + '」沒有選要掛在哪個小計底下'); return; }
      // 往上找父科目，不能繞回自己、也不能掛到不是群組的列
      var seen = {}, p = ro.parent, guard = 0;
      while (/^r\d+$/.test(p) && guard++ < 50) {
        var pr = p.slice(1);
        if (pr === String(k) || seen[pr]) { errs.push('第 ' + k + ' 列的父科目繞了一圈回到自己'); return; }
        seen[pr] = true;
        if (!roles[pr] || roles[pr].role !== 'group') { errs.push('第 ' + k + ' 列掛在第 ' + pr + ' 列底下，但那一列不是群組小計'); return; }
        p = roles[pr].parent;
      }
    });
    return errs;
  }

  /**
   * 明細列在系統裡怎麼算：公式轉換(F.translatePlan) + 開發攤提追蹤(優先)。
   * 每一列多了 mode：'amort'(追到開發總投) / 'backcalc'(使用者選擇用攤提台數回推)，以及 amort: [各分頁的追蹤結果]。
   * 回傳同 F.translatePlan，另附 units: [各分頁的攤提台數 { value, months, label, source }]
   */
  function translateAll(plan) {
    var tr = F.translatePlan(plan);
    tr.units = plan.scenarios.map(function () { return null; });
    var wb = plan.workbook;
    var sheets = plan.scenarios.map(function (s) { return s.sheet; });
    var fb = plan.fallback || {}, off = plan.amortOff || {}, back = plan.backcalc || {};
    var amortRows = [];
    Object.keys(tr.rows).forEach(function (row) {
      var t = tr.rows[row];
      var label = (plan.rows.filter(function (r) { return String(r.row) === String(row); })[0] || {}).label || '';
      t.looksDev = A.looksLikeDev(label);
      if (!wb || plan.useAmort === false || fb[row]) return;
      if (off[row]) { t.amortReason = '手動改為不用開發攤提'; return; }
      var traces = [];
      try {
        sheets.forEach(function (sheet) { traces.push(A.traceRow(wb, plan, sheet, Number(row))); });
      } catch (e) {
        if (!e.amort) throw e;
        if (t.looksDev) t.amortReason = '開發攤提追不到：' + e.message;
        return;
      }
      t.prev = { mode: t.mode, reason: t.reason };
      t.mode = 'amort'; t.amort = traces; t.reason = '';
      t.category = traces[0].category;
      amortRows.push(row);
    });
    // 同一個情境只有一個攤提基準台數：跟多數不同的列改回原本的算法
    sheets.forEach(function (sheet, si) {
      var count = {};
      amortRows.forEach(function (row) { var u = tr.rows[row].amort[si].units.value; count[u] = (count[u] || 0) + 1; });
      var major = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })[0];
      amortRows.forEach(function (row) {
        var t = tr.rows[row];
        if (t.mode !== 'amort') return;
        if (String(t.amort[si].units.value) !== String(major)) {
          t.mode = t.prev.mode; t.reason = t.prev.reason;
          t.amortReason = '「' + sheet.name + '」的攤提台數(' + t.amort[si].units.value + ')跟其他攤提列(' + major + ')不同，系統一個情境只有一個攤提台數';
          delete t.amort;
        }
      });
      var first = amortRows.filter(function (row) { return tr.rows[row].mode === 'amort'; })[0];
      if (first) tr.units[si] = Object.assign({ source: tr.rows[first].amort[si].source }, tr.rows[first].amort[si].units);
    });
    // 直接打數字、名稱像開發攤提：使用者選擇「用攤提台數回推」
    Object.keys(back).forEach(function (row) {
      var t = tr.rows[row];
      if (!t || t.mode !== 'input' || !back[row]) return;
      var r = plan.rows.filter(function (x) { return String(x.row) === String(row); })[0];
      var bad = sheets.filter(function (sheet) {
        var vals = plan.vehicles.map(function (v) { return num(X.cell(sheet, Number(row), v.col)); });
        return vals.some(function (v) { return v === null || Math.abs(v - vals[0]) > 1e-6; });
      })[0];
      if (bad) { t.amortReason = '「' + bad.name + '」各車系的單台金額不同，不能用同一筆投資回推'; return; }
      t.mode = 'backcalc'; t.category = A.categoryOf(r.label); t.reason = '';
    });
    return tr;
  }

  /** 父科目鏈最後落在哪個結構小計(B → 銷貨成本頁，其他 → 營業費用頁) */
  function rootParent(roles, row) {
    var p = roles[row] && roles[row].parent, guard = 0;
    while (/^r\d+$/.test(p) && guard++ < 50) p = roles[p.slice(1)] && roles[p.slice(1)].parent;
    return p || '';
  }

  /**
   * 依對應設定建車型與科目表(只做一次)，再替每個分頁各建一個情境。
   * api：後端 API(gs.xxx 或 host.call 的包裝)。
   * plan = {
   *   typeId, typeNotes, vehicles: [{ col, name }], weightedCol, noteCol,
   *   rows: [extractRows 的結果(參考分頁)], roles: { 列號: { role, parent } },
   *   scenarios: [{ sheet, gate, name, type, rates: { 營業稅率, 銷售佣金率 }, mix: [各車系構成比%] }]
   * }
   * 回傳 { codes: { 列號: 科目代碼 }, scenarioIds: [...] }
   */
  function buildFromPlan(api, plan) {
    var problems = planProblems(plan);
    if (problems.length) throw new Error(problems.join('\n'));
    var T = plan.typeId;
    var roles = plan.roles;
    var rowOf = {};
    plan.rows.forEach(function (r) { rowOf[r.row] = r; });
    var rolesOf = function (role) { return plan.rows.filter(function (r) { return roles[r.row] && roles[r.row].role === role; }); };
    var codes = {};

    api.createVehicleType(T, plan.typeNotes || '', '');
    var KEEP = { P1: 1, P2: 1, P3: 1, P4: 1, P5: 1, P6: 1, P7: 1, P8: 1, P9: 1, A: 1, B: 1, C: 1, E: 1, G: 1, I: 1, J: 1, K: 1 };
    // 先刪公式科目再刪手動科目，避免「被其他科目引用」擋下來
    var defs = api.getPLLineItems(T);
    defs.filter(function (d) { return !KEEP[d.LineCode]; })
      .sort(function (a, b) { return (a.CalcType === 'FORMULA' ? 0 : 1) - (b.CalcType === 'FORMULA' ? 0 : 1); })
      .forEach(function (d) { api.deletePLLineItem(d.LineCode, T); });
    defs = api.getPLLineItems(T);
    var defOf = function (c) { return defs.filter(function (d) { return d.LineCode === c; })[0]; };
    var rename = function (c, name, extra) {
      var d = defOf(c);
      var line = Object.assign({ LineCode: c, LineName: name, CalcType: d.CalcType, Formula: d.Formula || '' }, extra || {});
      return api.saveChartLine(T, line).line.LineCode;
    };

    // 售價結構
    var hasList = rolesOf('price:list').length > 0;
    if (hasList) {
      rolesOf('price:list').forEach(function (r) { codes[r.row] = rename('P1', r.label); });
      rolesOf('price:accessory').forEach(function (r) { codes[r.row] = rename('P2', r.label); });
      rolesOf('price:scrap').forEach(function (r) { codes[r.row] = rename('P4', r.label); });
      rolesOf('check:P5').forEach(function (r) { codes[r.row] = rename('P5', r.label); });
      rolesOf('check:P6').forEach(function (r) { codes[r.row] = rename('P6', r.label); });
      rolesOf('check:P7').forEach(function (r) { codes[r.row] = rename('P7', r.label); });
      rolesOf('check:P8').forEach(function (r) { codes[r.row] = rename('P8', r.label); });
    } else {
      // Excel 沒有售價結構：收入金額直接放在「建議零售價」欄位，廠價 = 它本身
      var revLabel = (rolesOf('check:P8')[0] || {}).label || '收入';
      rename('P1', revLabel + '(由 Excel 帶入)');
      ['P2', 'P4', 'P6', 'P7'].forEach(function (c) { rename(c, defOf(c).LineName, { CalcType: 'FORMULA', Formula: '0' }); });
      rolesOf('check:P8').forEach(function (r) { codes[r.row] = rename('P8', r.label, { CalcType: 'FORMULA', Formula: 'P5 - P6 - P7' }); });
    }
    ['B', 'C', 'E', 'G', 'I', 'K'].forEach(function (s) {
      rolesOf('sub:' + s).forEach(function (r) { codes[r.row] = rename(s, r.label); });
    });

    // J：I 與 K 之間的扣項。剛好一列明細 → J 就是那一列；多列 → J 變成群組
    var jKids = plan.rows.filter(function (r) { var ro = roles[r.row]; return ro && (ro.role === 'group' || ro.role === 'detail') && ro.parent === 'J'; });
    if (jKids.length === 1 && roles[jKids[0].row].role === 'detail') {
      codes[jKids[0].row] = rename('J', jKids[0].label, { CalcType: 'INPUT', Formula: '' });
    } else if (jKids.length) {
      rename('J', '營業外扣項合計', { CalcType: 'FORMULA', Formula: 'CHILDREN()' });
    }

    var parentCode = function (p) { return /^r\d+$/.test(p) ? codes[p.slice(1)] : p; };
    // 群組：父科目先建(依深度)
    var groups = rolesOf('group');
    var depth = function (r) { var d = 0, p = roles[r.row].parent; while (/^r\d+$/.test(p) && d < 50) { d++; p = roles[p.slice(1)].parent; } return d; };
    groups.sort(function (a, b) { return depth(a) - depth(b) || a.row - b.row; }).forEach(function (r) {
      codes[r.row] = api.saveChartLine(T, { LineCode: '', LineName: r.label, ParentLine: parentCode(roles[r.row].parent), CalcType: 'FORMULA', Formula: 'CHILDREN()' }).line.LineCode;
    });
    rolesOf('detail').forEach(function (r) {
      if (codes[r.row]) return;   // 已經是 J
      codes[r.row] = api.saveChartLine(T, { LineCode: '', LineName: r.label, ParentLine: parentCode(roles[r.row].parent), CalcType: 'INPUT' }).line.LineCode;
    });

    // 科目順序照 Excel 的列序(科目樹拖曳送出的「父科目在前」走訪順序)
    defs = api.getPLLineItems(T);
    var rowOfCode = {};
    Object.keys(codes).forEach(function (row) { rowOfCode[codes[row]] = Number(row); });
    var builtinOrder = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'A', 'B', 'C', 'E', 'G', 'I', 'J', 'K'];
    var order = [];
    var walk = function (parent) {
      defs.filter(function (d) { return (d.ParentLine || '') === parent; })
        .sort(function (a, b) {
          var ia = builtinOrder.indexOf(a.LineCode), ib = builtinOrder.indexOf(b.LineCode);
          if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
          return (rowOfCode[a.LineCode] || 1e9) - (rowOfCode[b.LineCode] || 1e9);
        })
        .forEach(function (d) { order.push({ LineCode: d.LineCode, ParentLine: d.ParentLine || '' }); walk(d.LineCode); });
    };
    walk('');
    api.setLineOrder(T, order);

    // 車系
    var vehicleIds = plan.vehicles.map(function (v) { return T + '-' + clean(v.name); });
    plan.vehicles.forEach(function (v, i) { api.saveVehicle({ VehicleID: vehicleIds[i], VehicleTypeID: T, VehicleCode: clean(v.name) }); });

    // Excel 公式 → 系統公式。參數要先定義好(公式存檔時會檢查 [名稱] 存不存在)
    var tr = translateAll(plan);
    var formulaRows = {}, fallbacks = {}, usedParams = {};
    var textsOf = function (t) { return [t.formula].concat(Object.keys(t.vehicleFormulas).map(function (k) { return t.vehicleFormulas[k]; })); };
    Object.keys(tr.rows).forEach(function (row) {
      var t = tr.rows[row];
      if (t.mode === 'input' || t.mode === 'amort' || t.mode === 'backcalc') return;
      textsOf(t).forEach(function (f) { str(f).replace(/⟦p:([^⟧]+)⟧/g, function (m, k) { usedParams[k] = true; return m; }); });
    });
    Object.keys(usedParams).forEach(function (key) {
      var p = tr.params[key];
      if (p.kind === 'fx' || p.builtin) return;
      var first = F.paramValues(p, plan.scenarios[0].sheet);
      var def = p.kind === 'row' ? first.byVehicle[Object.keys(first.byVehicle)[0]] : first.global;
      api.saveParamDef({
        ParamName: p.name, Unit: p.unit, DefaultValue: def === null || def === undefined ? '' : def,
        Description: '由 Excel ' + (p.kind === 'row' ? '第 ' + p.row + ' 列的 ' + p.token + ' 欄' : p.ref + (p.label ? '「' + p.label + '」' : '')) + '轉入'
      });
    });
    Object.keys(tr.rows).forEach(function (row) {
      var t = tr.rows[row];
      if (t.mode === 'input' || !codes[row]) return;
      if (t.mode === 'amort' || t.mode === 'backcalc') {
        try {
          api.saveChartLine(T, { LineCode: codes[row], LineName: rowOf[row].label, CalcType: 'DEV_AMORT', DevAmortCategory: t.category || '費用', VehicleFormulas: {} });
          formulaRows[row] = t.mode;
        } catch (e) {
          fallbacks[row] = '系統不接受改成開發攤提(' + e.message + ')，改為帶入數字';
        }
        return;
      }
      var main = t.mode === 'formula' ? F.resolveFormula(t.formula, codes, tr.params) : '';
      var vf = {}, ok = main !== null;
      Object.keys(t.vehicleFormulas).forEach(function (vi) {
        var f = F.resolveFormula(t.vehicleFormulas[vi], codes, tr.params);
        if (f === null) ok = false; else vf[vehicleIds[vi]] = f;
      });
      if (!ok) { fallbacks[row] = '公式引用的列沒有對應到系統科目，改為帶入數字'; return; }
      try {
        api.saveChartLine(T, { LineCode: codes[row], LineName: rowOf[row].label, CalcType: t.mode === 'formula' ? 'FORMULA' : 'INPUT', Formula: main, VehicleFormulas: vf });
        formulaRows[row] = t.mode;
      } catch (e) {
        fallbacks[row] = '系統不接受轉換後的公式(' + e.message + ')，改為帶入數字';
      }
    });

    var scenarioIds = plan.scenarios.map(function (sc) {
      var sid = api.createScenarioFrom({
        ScenarioID: '', Gate: sc.gate || 'GATE F', ScenarioName: sc.name, ScenarioType: sc.type || '現況',
        VehicleTypeID: T, CreatedDate: '', Notes: '來源：Excel「' + sc.sheet.name + '」分頁'
      }, '', []).ScenarioID;
      var val = function (row, i) { return num(X.cell(sc.sheet, row, plan.vehicles[i].col)); };
      var firstOf = function (role) { return rolesOf(role)[0]; };
      var list = firstOf('price:list') || (hasList ? null : firstOf('check:P8'));
      var acc = hasList ? firstOf('price:accessory') : null;
      var scrap = hasList ? firstOf('price:scrap') : null;
      api.saveSalesMixGrid(sid, T, plan.vehicles.map(function (v, i) {
        return {
          RowID: '', VehicleID: vehicleIds[i], SalesMixPct: sc.mix[i], MonthlyVolume: '', LifeCycleYears: '',
          ListPriceTaxIncl: list ? (val(list.row, i) || 0) : 0,
          MandatoryAccessoryPrice: acc ? (val(acc.row, i) || '') : '',
          ScrapFee: scrap ? (val(scrap.row, i) || '') : '', ScrapFeeTaxStatus: '含稅',
          HorizontalPartsPriceAdj: '', Notes: ''
        };
      }));
      // 比率與參數：同名(同車系)只留一筆，Excel 參數儲存格的值優先於反推的比率
      var rateMap = {}, fx = [];
      Object.keys(sc.rates || {}).forEach(function (n) { rateMap[n + '|'] = { ParamName: n, VehicleID: '', Value: sc.rates[n] }; });
      Object.keys(usedParams).forEach(function (key) {
        var p = tr.params[key], v = F.paramValues(p, sc.sheet);
        if (p.kind === 'fx') { if (v.global !== null) fx.push({ ParamID: '', Currency: p.currency, ParamName: '現況匯率', Value: v.global }); return; }
        if (p.kind === 'row') {
          Object.keys(v.byVehicle).forEach(function (vi) {
            if (v.byVehicle[vi] !== null) rateMap[p.name + '|' + vehicleIds[vi]] = { ParamName: p.name, VehicleID: vehicleIds[vi], Value: v.byVehicle[vi] };
          });
        } else if (v.global !== null) rateMap[p.name + '|'] = { ParamName: p.name, VehicleID: '', Value: v.global };
      });
      api.saveRateGrid(sid, Object.keys(rateMap).map(function (k) { return Object.assign({ ParamID: '' }, rateMap[k]); }));
      if (fx.length) api.saveFxGrid(sid, fx);

      // 開發總投：攤提基準台數 + 部門投資明細(目標情境且 Excel 寫成「原始 × (1 - 低減率)」時，帶原始金額與低減%)
      var si = plan.scenarios.indexOf(sc);
      var devRows = [];
      var units = tr.units[si] ? tr.units[si].value : Number(sc.amortUnits) || 0;
      var months = tr.units[si] ? tr.units[si].months : null;
      Object.keys(formulaRows).forEach(function (row) {
        var t = tr.rows[row];
        if (formulaRows[row] === 'amort') {
          t.amort[si].investments.forEach(function (inv) {
            var useCut = (sc.type || '現況') === '目標' && inv.reduction;
            devRows.push({
              RowID: '', Department: inv.dept, TargetLineCode: codes[row], Currency: 'TWD',
              Amount: useCut ? inv.reduction.original : inv.amount, ChallengeReductionPct: useCut ? inv.reduction.pct : 0,
              Notes: [inv.notes, inv.key ? 'Excel ' + inv.key + (inv.coef !== 1 ? ' × ' + inv.coef : '') : ''].filter(Boolean).join('｜'),
              VehicleScope: ''
            });
          });
        } else if (formulaRows[row] === 'backcalc') {
          var perUnit = val(Number(row), 0) || 0;
          devRows.push({
            RowID: '', Department: rowOf[row].label + '(由單台回推)', TargetLineCode: codes[row], Currency: 'TWD',
            Amount: perUnit * units, ChallengeReductionPct: 0,
            Notes: 'Excel 單台 ' + perUnit + ' × 攤提台數 ' + units, VehicleScope: ''
          });
        }
      });
      if (Object.keys(formulaRows).some(function (row) { return formulaRows[row] === 'backcalc'; }) && !(units > 0)) {
        throw new Error('「' + sc.name + '」有列要用攤提台數回推開發總投，請在第 4 步填攤提台數');
      }
      if (devRows.length && units > 0) {
        var years = months ? months / 12 : 1;
        api.saveAmortBasis(sid, units / 12 / years, years);
        api.saveDevInvestmentGrid(sid, devRows);
      }

      var cost = [], opex = [];
      rolesOf('detail').forEach(function (r) {
        var target = rootParent(roles, r.row) === 'B' ? cost : opex;
        var fm = formulaRows[r.row];
        plan.vehicles.forEach(function (v, i) {
          // 轉成公式的車系不帶數字(帶了也不會用到，反而讓人以為那是輸入值)
          if (fm === 'formula' || fm === 'amort' || fm === 'backcalc' || (fm === 'mixed' && tr.rows[r.row].vehicleFormulas[i] !== undefined)) return;
          var amount = val(r.row, i);
          if (amount === null) return;
          target.push({ RowID: '', VehicleID: vehicleIds[i], LineCode: codes[r.row], Amount: amount, Currency: 'TWD', Notes: '' });
        });
      });
      if (cost.length) api.saveCostOfSalesMatrix(sid, cost);
      if (opex.length) api.saveOperatingExpenseMatrix(sid, opex);

      if (plan.noteCol) {
        var notes = {};
        Object.keys(codes).forEach(function (row) {
          var t = text(X.cell(sc.sheet, Number(row), plan.noteCol));
          if (t) notes[codes[row]] = str(X.cell(sc.sheet, Number(row), plan.noteCol).v).replace(/\r\n/g, '\n').trim();
        });
        if (Object.keys(notes).length) api.saveLineNotes(sid, notes);
      }
      return sid;
    });
    return { codes: codes, scenarioIds: scenarioIds, vehicleIds: vehicleIds, translation: tr, formulaRows: formulaRows, fallbacks: fallbacks };
  }

  /**
   * 建立 + 驗算，轉成公式卻跟 Excel 對不起來的列自動改回帶入數字，再建一次(最多 5 輪)。
   * newEnv()：每一輪給一台全新的後端 → { api, host }。
   * 回傳 { env, plan(含 fallback：哪幾列改回數字、為什麼), built, verify }
   */
  function buildAndVerify(newEnv, plan) {
    var fallback = Object.assign({}, plan.fallback || {});
    var last = null;
    for (var round = 0; round < 5; round++) {
      var p2 = Object.assign({}, plan, { fallback: Object.assign({}, fallback) });
      var env = newEnv();
      var built = buildFromPlan(env.api, p2);
      Object.keys(built.fallbacks).forEach(function (r) { fallback[r] = built.fallbacks[r]; });
      var verify = verifyPlan(env.api, p2, built);
      last = { env: env, plan: Object.assign({}, p2, { fallback: Object.assign({}, fallback) }), built: built, verify: verify };
      var bad = {};
      verify.forEach(function (v) {
        v.rows.forEach(function (row) {
          if (!built.formulaRows[row.row] || bad[row.row]) return;
          var c = row.cells.filter(function (x) { return x.ok === false; })[0];
          if (c) bad[row.row] = (/amort|backcalc/.test(built.formulaRows[row.row]) ? '改成開發攤提後' : '轉成公式後') +
            '跟 Excel 對不起來(「' + v.sheetName + '」Excel ' + c.excel + '、系統 ' + c.system + ')，改為帶入數字';
        });
      });
      if (!Object.keys(bad).length) return last;
      Object.keys(bad).forEach(function (r) { fallback[r] = bad[r]; });
    }
    return last;
  }

  /* =====================================================================
   * 5. 驗算
   * ===================================================================== */

  /**
   * 每個情境重算後跟 Excel 逐格比對。
   * 回傳 [{ scenarioId, sheetName, ok, checked, mismatches, rows: [{ row, label, code, cells: [{ excel, system, ok }] }] }]
   */
  function verifyPlan(api, plan, built) {
    return plan.scenarios.map(function (sc, si) {
      var sid = built.scenarioIds[si];
      var all = api.calculatePLAllVehicles(sid);
      var columns = all.vehicles.map(function (v) { return v.lines; }).concat([all.weightedAverage]);
      var amountOf = function (ci, code) {
        var l = (columns[ci] || []).filter(function (x) { return x.LineCode === code; })[0];
        return l ? l.Amount : null;
      };
      var checked = 0, mismatches = 0;
      var rows = plan.rows.filter(function (r) { return built.codes[r.row]; }).map(function (r) {
        var code = built.codes[r.row];
        var cols = plan.vehicles.map(function (v) { return v.col; });
        if (plan.weightedCol) cols.push(plan.weightedCol);
        var cells = cols.map(function (c, ci) {
          var excel = num(X.cell(sc.sheet, r.row, c));
          var system = amountOf(ci, code);
          if (excel === null) return { excel: null, system: system, ok: null };
          var ok = system !== null && Math.abs(system - excel) <= TOLERANCE;
          checked++;
          if (!ok) mismatches++;
          return { excel: excel, system: system, ok: ok };
        });
        return { row: r.row, label: r.label, code: code, cells: cells };
      });
      return { scenarioId: sid, sheetName: sc.sheet.name, scenarioName: sc.name, checked: checked, mismatches: mismatches, ok: mismatches === 0, rows: rows };
    });
  }

  /** 另一個分頁是不是同一個版面：同一列的科目名稱要一樣 */
  function sameLayout(sheet, plan) {
    var diffs = [];
    plan.rows.forEach(function (r) {
      if (!plan.roles[r.row] || plan.roles[r.row].role === 'skip') return;
      var t = text(X.cell(sheet, r.row, plan.labelCol));
      if (t !== r.label) diffs.push({ row: r.row, expected: r.label, actual: t });
    });
    return diffs;
  }

  /** 構成比列的值(0.3 或 30 都接受) → 百分比數值；沒有構成比列就平均分配 */
  function mixFor(sheet, plan) {
    var mixRow = plan.rows.filter(function (r) { return plan.roles[r.row] && plan.roles[r.row].role === 'mix'; })[0];
    var vals = plan.vehicles.map(function (v) { return mixRow ? num(X.cell(sheet, mixRow.row, v.col)) : null; });
    if (vals.some(function (v) { return v === null; })) return plan.vehicles.map(function () { return Math.round(10000 / plan.vehicles.length) / 100; });
    var total = vals.reduce(function (s, v) { return s + v; }, 0);
    var scale = total <= 1.0001 ? 100 : 1;
    return vals.map(function (v) { return Math.round(v * scale * 1e6) / 1e6; });
  }

  /** 對應設定的「指紋」：同一份 Excel 換新版時，科目名稱一樣就能沿用上次的對應 */
  function signature(rows) {
    var s = rows.map(function (r) { return r.row + ':' + r.label; }).join('|');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return 'v1-' + (h >>> 0).toString(36);
  }

  return {
    TOLERANCE: TOLERANCE, ROLE_LABELS: ROLE_LABELS, PARENTS: PARENTS, STRUCTURE: STRUCTURE,
    analyzeSheet: analyzeSheet, extractRows: extractRows, suggestRoles: suggestRoles, inferRates: inferRates,
    formulaShape: formulaShape, planProblems: planProblems, buildFromPlan: buildFromPlan, verifyPlan: verifyPlan, buildAndVerify: buildAndVerify,
    translateAll: translateAll,
    sameLayout: sameLayout, mixFor: mixFor, signature: signature, clean: clean
  };
}));
