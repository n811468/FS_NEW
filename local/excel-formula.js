/**
 * Excel 公式 → 系統公式，以及「沒有公式時由數字推斷小計」。給 local/excel-pack.js 用(純函式)。
 *
 * 轉換規則(每一種 Excel 寫法會變成什麼)：
 *   同一車系欄、別的列      D16、D$13、SUM(D21:D31)  → 那一列的科目(建立時換成科目代碼，畫面上顯示 [科目名稱])
 *                           售價列 → P1/P2/P4；構成比列 → [構成比]
 *   固定的參數儲存格        $O$7(左邊標籤「關稅率」)   → 參數 [關稅率]，每個分頁(情境)各自帶自己的值；
 *                           標籤跟內建參數同名(貨物稅率…)就直接用內建參數；比率(|值| ≤ 1)以 % 儲存
 *   同一列、非車系欄的數字  E16(RMB 欄)               → 車系別參數 [材料成本K(CIF)(RMB)]，每個車系各一個值
 *   匯率                    E16*$B$4(外幣欄 × 參數)    → $B$4 視為該幣別的匯率 [CNY匯率]，寫進匯率設定
 *   函式                    SUM ROUND ROUNDUP ROUNDDOWN MIN MAX ABS IF
 * 轉不過去 → 這一列改為帶入 Excel 算好的數字，並說明原因：
 *   引用其他車系/加權欄、引用其他分頁、引用略過的列、系統沒有的函式(VLOOKUP…)、文字、參數儲存格本身又是公式…
 * 各車系公式不同 → 車系個別公式；有的車系是數字 → 帶入數字 + 公式車系用車系個別公式；
 * 同一列在不同分頁的公式不一樣 → 帶入數字(科目表是同一個車型共用的，不能一個情境一套公式)。
 * 轉換結果最後還是以「重算後跟 Excel 逐格相同」為準，對不起來的列由 excel-pack.js 自動改回帶入數字。
 *
 * 公式文字裡先用佔位符：⟦r16⟧ = 第 16 列的科目、⟦p:cell:O7⟧ = 參數。建立時換成代碼與參數名稱，顯示時換成名稱。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./xlsx-reader.js'));
  else root.FSExcelFormula = factory(root.FSXlsx);
}(typeof self !== 'undefined' ? self : this, function (X) {
  'use strict';

  var FUNCS = { SUM: 1, ROUND: 1, ROUNDUP: 1, ROUNDDOWN: 1, MIN: 1, MAX: 1, ABS: 1, IF: 1 };
  var RANGE_FUNCS = { SUM: 1, MIN: 1, MAX: 1 };
  var BUILTIN_RATES = ['營業稅率', '銷售佣金率', '季Margin率', '貨物稅率', '貨物稅完稅價格計算率'];
  var RATE_ALIASES = { 營業稅: '營業稅率', 銷售佣金: '銷售佣金率', 銷售傭金: '銷售佣金率', 佣金率: '銷售佣金率', 貨物稅: '貨物稅率' };
  var SYSTEM_VARS = ['建議零售價', '強配件售價', '廢車處理費', '廢車處理費(含稅)', '水平配件調降', '月銷量', 'LC年限', 'LC總台數', '構成比', '車型月總台數', '攤提總台數'];
  var FOREIGN = { RMB: 'CNY', CNY: 'CNY', '人民幣': 'CNY', USD: 'USD', JPY: 'JPY', EUR: 'EUR' };
 // 「結果」列(上一段 - 扣項)與售價列的名稱；只在沒有公式、要由數字推斷結構時用來分辨方向
  var RESULT_LABEL = /毛利|淨利|利益|損益|貢獻|利潤|價值鏈|邊際|^實際(零)?售價|^經銷價|^廠價|收入|營收/;
  var PRICE_LABEL = /建議(零)?售價|廢車|強配|構(成)?比/;
  var UNIT_TOKEN = /^(TWD|NTD|NT\$|NT|台幣|新台幣|元|RMB|CNY|人民幣|USD|JPY|EUR|%|％)$/i;

  function str(v) { return v === undefined || v === null ? '' : String(v); }
  function clean(s) { return str(s).replace(/[\r\n\t]+/g, '').replace(/\s{2,}/g, ' ').trim(); }
  function num(cell) { return cell && typeof cell.v === 'number' && isFinite(cell.v) ? cell.v : null; }
  function text(cell) { return cell && typeof cell.v === 'string' ? clean(cell.v) : ''; }
  function fail(reason) { var e = new Error(reason); e.translate = true; return e; }
  /** 公式裡有沒有儲存格參照(=90000+8800 這種只有常數的公式，當成數字看) */
  function hasRefs(f) { return /(^|[^A-Za-z0-9_.])\$?[A-Z]{1,3}\$?\d/.test(str(f).replace(/"[^"]*"/g, '')); }

  /* ---------------- Excel 公式斷詞 ---------------- */
  var XREF = /^(?:'((?:[^']|'')+)'|([^\s!'"()+\-*/^,:=<>&%;]+))!(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)/;
  var REF = /^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?(?![A-Za-z0-9_(])/;

  function tokenize(f) {
    var s = str(f).replace(/^=/, ''), i = 0, out = [], m;
    while (i < s.length) {
      var rest = s.slice(i), ch = s.charAt(i);
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '"') { var j = s.indexOf('"', i + 1); out.push({ t: 'str' }); i = j === -1 ? s.length : j + 1; continue; }
      if ((m = XREF.exec(rest))) { out.push({ t: 'xref', sheet: (m[1] || m[2]).replace(/''/g, "'"), ref: m[3] }); i += m[0].length; continue; }
      if ((m = REF.exec(rest))) { out.push({ t: 'ref', ref: m[0] }); i += m[0].length; continue; }
      if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) { out.push({ t: 'num', v: m[0] }); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_][A-Za-z0-9_.]*(?=\s*\()/.exec(rest))) { out.push({ t: 'func', v: m[0].toUpperCase() }); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_\u0080-￿][\w.\u0080-￿]*/.exec(rest))) { out.push({ t: 'name', v: m[0] }); i += m[0].length; continue; }
      if ((m = /^(<=|>=|<>)/.exec(rest))) { out.push({ t: 'op', v: m[0] }); i += 2; continue; }
      out.push({ t: 'op', v: ch }); i++;
    }
    return out;
  }

  function parseCellRef(ref) {
    var m = /^(\$?)([A-Z]{1,3})(\$?)(\d+)$/.exec(ref);
    return { c: X.colToNum(m[2]), r: Number(m[4]), absC: !!m[1], absR: !!m[3] };
  }

  /* ---------------- 欄位標題(單位) ---------------- */
  function unitTokenOf(sheet, col, firstRow) {
    for (var r = firstRow - 1; r >= 1; r--) {
      var t = text(X.cell(sheet, r, col));
      if (!t) {
        var g = sheet.merges.filter(function (x) { return r >= x.r1 && r <= x.r2 && col >= x.c1 && col <= x.c2; })[0];
        if (g) t = text(X.cell(sheet, g.r1, g.c1));
      }
      if (t && UNIT_TOKEN.test(t)) return t.toUpperCase();
    }
    return '';
  }

  /** 參數儲存格的名稱：同一列左邊最近的文字(最多往左找 3 欄) */
  function labelLeftOf(sheet, r, c) {
    for (var cc = c - 1; cc >= Math.max(1, c - 3); cc--) {
      var t = text(X.cell(sheet, r, cc));
      if (t) return t.replace(/[（(][^)）]*[)）]$/, '').trim() || t;
    }
    return '';
  }

  /* ---------------- 單一儲存格的轉換 ---------------- */
  /**
   * ctx = { plan, sheet, row, vi } → { text: 含佔位符的公式, constant: 沒有引用任何東西, params: [參數鍵] }
   * 轉不過去時丟出 e.translate = true 的錯誤，訊息就是原因。
   */
  function translateCell(f, ctx) {
    var plan = ctx.plan, sheet = ctx.sheet;
    var ownCol = plan.vehicles[ctx.vi].col;
    var otherCols = {};
    plan.vehicles.forEach(function (v, i) { if (i !== ctx.vi) otherCols[v.col] = v.name; });
    if (plan.weightedCol) otherCols[plan.weightedCol] = '加權';
    var tokens = tokenize(f);
    var out = [], stack = [], params = [], refs = 0;
    var pendingFunc = '';

    function resolve(r, c, refText) {
      if (c === ownCol) {
        if (r === ctx.row) throw fail('公式引用了自己');
        var ro = plan.roles[r];
        var role = ro ? ro.role : 'skip';
        refs++;
        if (role === 'price:list') return 'P1';
        if (role === 'price:accessory') return 'P2';
        if (role === 'price:scrap') return 'P4';
        if (role === 'mix') return '[構成比]';
        if (role !== 'skip') return '⟦r' + r + '⟧';
        if (num(X.cell(sheet, r, c)) === null || num(X.cell(sheet, r, c)) === 0) return '0';
        var lab = text(X.cell(sheet, r, plan.labelCol));
        throw fail('引用了沒有帶入的第 ' + r + ' 列' + (lab ? '「' + lab + '」' : '') + '(' + refText + ')');
      }
      if (otherCols[c] !== undefined) throw fail('引用了「' + otherCols[c] + '」欄(' + refText + ')，系統的公式只能用同一個車系的數字');
      var cell = X.cell(sheet, r, c);
      if (r === ctx.row) {
        if (num(cell) === null) throw fail('引用同一列 ' + refText + '，但那一格不是數字');
        if (cell.f && hasRefs(cell.f)) throw fail('引用同一列 ' + refText + '，那一格本身也是公式(=' + cell.f + ')');
        var token = unitTokenOf(sheet, c, plan.firstRow) || ('第' + X.numToCol(c) + '欄');
        var rkey = 'row:' + r + ':' + token;
        params.push({ key: rkey, kind: 'row', row: r, token: token, cols: {} });
        params[params.length - 1].cols[ctx.vi] = c;
        refs++;
        return '⟦p:' + rkey + '⟧';
      }
      if (num(cell) === null) throw fail('引用的 ' + refText + ' 不是數字');
      if (cell.f && hasRefs(cell.f)) throw fail('引用的參數儲存格 ' + refText + ' 本身也是公式(=' + cell.f + ')');
      var ckey = 'cell:' + X.numToCol(c) + r;
      params.push({ key: ckey, kind: 'cell', r: r, c: c });
      refs++;
      return '⟦p:' + ckey + '⟧';
    }

    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      if (tk.t === 'num') {
        if (tokens[i + 1] && tokens[i + 1].t === 'op' && tokens[i + 1].v === '%') { out.push('(' + tk.v + '/100)'); i++; }
        else out.push(tk.v);
        continue;
      }
      if (tk.t === 'str') throw fail('公式裡有文字(" ")，系統公式只能算數字');
      if (tk.t === 'xref') throw fail('引用其他分頁「' + tk.sheet + '」' + tk.ref.replace(/\$/g, ''));
      if (tk.t === 'name') {
        if (/^TRUE$/i.test(tk.v)) { out.push('1'); continue; }
        if (/^FALSE$/i.test(tk.v)) { out.push('0'); continue; }
        throw fail('公式用了名稱「' + tk.v + '」(Excel 的定義名稱)，請改成儲存格參照');
      }
      if (tk.t === 'func') {
        if (!FUNCS[tk.v]) throw fail('系統沒有 ' + tk.v + ' 函式');
        pendingFunc = tk.v;
        out.push(tk.v);
        continue;
      }
      if (tk.t === 'ref') {
        var parts = tk.ref.split(':');
        if (parts.length === 2) {
          var a = parseCellRef(parts[0]), b = parseCellRef(parts[1]);
          if (!RANGE_FUNCS[stack[stack.length - 1]]) throw fail('範圍 ' + tk.ref + ' 只能放在 SUM / MIN / MAX 裡');
          if (a.c !== b.c) throw fail('範圍 ' + tk.ref + ' 跨了好幾欄');
          var items = [];
          for (var r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
            if (r === ctx.row) throw fail('範圍 ' + tk.ref + ' 包含自己');
            var ro2 = plan.roles[r];
            var cellR = X.cell(sheet, r, a.c);
            // 範圍裡的空白列、只有標題的列：Excel 當 0，這裡直接略過
            if (a.c === ownCol && (!ro2 || ro2.role === 'skip') && (num(cellR) === null || num(cellR) === 0)) continue;
            items.push(resolve(r, a.c, X.numToCol(a.c) + r));
          }
          out.push(items.length ? items.join(', ') : '0');
          continue;
        }
        var p = parseCellRef(tk.ref);
        out.push(resolve(p.r, p.c, tk.ref.replace(/\$/g, '')));
        continue;
      }
      // 運算子
      var v = tk.v;
      if (v === '(') { stack.push(pendingFunc); pendingFunc = ''; out.push('('); continue; }
      if (v === ')') { stack.pop(); out.push(')'); continue; }
      if (v === '&') throw fail('公式用了 & 串接文字');
      if (v === ';' || v === ':' || v === '{' || v === '}' || v === '#') throw fail('系統不支援這種寫法：' + v);
      if (v === '%') throw fail('% 只能接在數字後面');
      if (v === ',') { out.push(', '); continue; }
      if (/^[+\-*/^=<>]|^<=|^>=|^<>/.test(v)) { out.push(' ' + v + ' '); continue; }
      throw fail('看不懂的符號：' + v);
    }
    var textOut = out.join('').replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/^\s+|\s+$/g, '')
      .replace(/^- /, '-').replace(/([(,]) - /g, '$1-');
    return { text: textOut, constant: refs === 0, params: params };
  }

  /* ---------------- 整份對應的轉換 ---------------- */
  /**
   * plan：excel-pack.js 的對應設定(rows/roles/vehicles/scenarios…)。
   * 回傳 {
   *   rows: { 列號: { mode: 'formula'|'mixed'|'input', formula, vehicleFormulas: {車系索引: 公式}, formulaVehicles: [索引], reason, excel: [各車系 Excel 公式] } },
   *   params: { 鍵: { key, kind: 'cell'|'row'|'fx', label, name, unit, currency, r, c, row, token, cols } }
   * }
   */
  function translatePlan(plan) {
    var result = { rows: {}, params: {} };
    var refSheet = plan.scenarios[0] ? plan.scenarios[0].sheet : null;
    if (!refSheet) return result;
    var sheets = plan.scenarios.map(function (s) { return s.sheet; });
    var usage = {};   // 參數鍵 → 跟它一起出現在乘式裡的外幣欄位(判斷匯率)

    plan.rows.forEach(function (r) {
      var ro = plan.roles[r.row];
      if (!ro || ro.role !== 'detail') return;
      var res = { mode: 'input', formula: '', vehicleFormulas: {}, formulaVehicles: [], reason: '', note: '', excel: [] };
      result.rows[r.row] = res;
      res.excel = plan.vehicles.map(function (v) { var c = X.cell(refSheet, r.row, v.col); return c && c.f ? c.f : ''; });
      if (plan.useFormulas === false) { res.reason = ''; return; }
      if (plan.formulaOff && plan.formulaOff[r.row]) { res.reason = '手動改為帶入數字'; return; }
      if (plan.fallback && plan.fallback[r.row]) { res.reason = plan.fallback[r.row]; return; }

      // 每個分頁、每個車系各轉一次；同一列在每個分頁都要一樣
      var perSheet = [];
      try {
        sheets.forEach(function (sheet, si) {
          perSheet.push(plan.vehicles.map(function (v, vi) {
            var cell = X.cell(sheet, r.row, v.col);
            if (!cell || !cell.f) return { constant: true, text: '' };
            // 「頂規 = 入門」(=D22)：Excel 照抄另一個車系的數字，系統裡兩個車系各自帶入同一個數字
            var copy = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(cell.f.trim());
            if (copy && Number(copy[2]) === r.row) {
              var src = plan.vehicles.filter(function (x) { return x.col === X.colToNum(copy[1]); })[0];
              if (src && si === 0) res.note = v.name + ' = ' + src.name + '(Excel 照抄，各自帶入相同數字)';
              if (src) return { constant: true, text: '', copy: true };
            }
            if (!hasRefs(cell.f)) return { constant: true, text: '' };
            try {
              var t = translateCell(cell.f, { plan: plan, sheet: sheet, row: r.row, vi: vi });
              if (si === 0) t.params.forEach(function (p) { registerParam(result.params, p, vi); });
              if (si === 0) noteFx(usage, t, refSheet, plan);
              return t;
            } catch (e) {
              if (!e.translate) throw e;
              throw fail((si > 0 ? '「' + sheet.name + '」' : '') + (plan.vehicles.length > 1 ? v.name + '：' : '') + e.message);
            }
          }));
        });
      } catch (e) {
        if (!e.translate) throw e;
        res.reason = e.message;
        return;
      }
      var ref = perSheet[0];
      var sig = function (list) { return list.map(function (t) { return t.constant ? '#' : t.text; }).join('|'); };
      var diff = perSheet.map(sig).map(function (s, si) { return s !== sig(ref) ? si : -1; }).filter(function (x) { return x > 0; })[0];
      if (diff !== undefined) { res.reason = '各分頁這一列的公式不一樣(例如「' + sheets[diff].name + '」)，同一個車型共用一份科目表，改為帶入數字'; return; }
      var formulaVehicles = ref.map(function (t, vi) { return t.constant ? -1 : vi; }).filter(function (vi) { return vi >= 0; });
      if (!formulaVehicles.length) return;   // 全部是數字(或只有常數運算，如 =3800*1.05)
      res.formulaVehicles = formulaVehicles;
      if (formulaVehicles.length === plan.vehicles.length) {
        // 最多車系共用的那一段當主公式，其他車系用車系個別公式
        var count = {};
        ref.forEach(function (t) { count[t.text] = (count[t.text] || 0) + 1; });
        var main = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })[0];
        res.mode = 'formula';
        res.formula = main;
        ref.forEach(function (t, vi) { if (t.text !== main) res.vehicleFormulas[vi] = t.text; });
      } else {
        res.mode = 'mixed';
        formulaVehicles.forEach(function (vi) { res.vehicleFormulas[vi] = ref[vi].text; });
      }
    });

    nameParams(result.params, refSheet, plan, usage);
    return result;
  }

  function registerParam(params, p, vi) {
    var cur = params[p.key];
    if (!cur) cur = params[p.key] = { key: p.key, kind: p.kind, r: p.r, c: p.c, row: p.row, token: p.token, cols: {} };
    if (p.kind === 'row') cur.cols[vi] = p.cols[vi];
  }

  /** 「外幣欄 × 參數儲存格」(E16*$B$4)：那個參數儲存格就是該外幣的匯率 */
  function noteFx(usage, t, sheet, plan) {
    var rowP = t.params.filter(function (p) { return p.kind === 'row' && FOREIGN[p.token]; })[0];
    var cellP = t.params.filter(function (p) { return p.kind === 'cell'; });
    if (!rowP || cellP.length !== 1) return;
    if (!/^⟦p:[^⟧]+⟧ \* ⟦p:[^⟧]+⟧$/.test(t.text)) return;
    usage[cellP[0].key] = FOREIGN[rowP.token];
  }

  function nameParams(params, sheet, plan, usage) {
    var lineNames = {};
    plan.rows.forEach(function (r) { lineNames[r.label] = true; });
    var used = {};
    Object.keys(params).sort().forEach(function (key) {
      var p = params[key];
      var override = plan.paramNames && plan.paramNames[key];
      if (p.kind === 'row') {
        var label = (plan.rows.filter(function (r) { return r.row === p.row; })[0] || {}).label || ('第' + p.row + '列');
        p.label = label + ' 的 ' + p.token;
        p.name = label + '(' + p.token + ')';
        p.unit = '數值';
      } else {
        var cell = X.cell(sheet, p.r, p.c);
        var v = num(cell);
        p.ref = X.numToCol(p.c) + p.r;
        p.label = labelLeftOf(sheet, p.r, p.c);
        var fxCurrency = usage[key] || (/匯率/.test(p.label) ? (/USD|美金|美元/.test(p.label) ? 'USD' : /JPY|日幣|日圓/.test(p.label) ? 'JPY' : /EUR|歐元/.test(p.label) ? 'EUR' : 'CNY') : '');
        if (fxCurrency) {
          p.kind = 'fx'; p.currency = fxCurrency; p.name = fxCurrency + '匯率'; p.unit = '匯率';
          return;
        }
        var base = (p.label || '').replace(/\s+/g, '');
        var builtin = BUILTIN_RATES.indexOf(base) !== -1 ? base : (RATE_ALIASES[base] && v !== null && Math.abs(v) <= 1 ? RATE_ALIASES[base] : '');
        if (builtin) { p.name = builtin; p.unit = '%'; p.builtin = true; }
        else {
          var name = base || ('儲存格' + p.ref);
          if (v !== null && Math.abs(v) <= 1 && v !== 0 && base && !/率|比|%/.test(name)) name += '率';
          p.name = name;
          p.unit = v !== null && Math.abs(v) <= 1 && v !== 0 ? '%' : '數值';
        }
      }
      if (override) p.name = override;
      if (!p.builtin && (lineNames[p.name] || SYSTEM_VARS.indexOf(p.name) !== -1 || BUILTIN_RATES.indexOf(p.name) !== -1 || /^[A-Za-z]{3}匯率$/.test(p.name) || /[\[\]"⟦⟧]/.test(p.name))) {
        p.name = p.name.replace(/[\[\]"⟦⟧]/g, '') + '(參數)';
      }
      if (used[p.name] && used[p.name] !== key) p.name += '_' + (p.ref || p.token);
      used[p.name] = key;
    });
  }

  /** 參數在某個分頁的值：{ global: 值 } 或 { byVehicle: { 車系索引: 值 } }，% 參數已乘 100 */
  function paramValues(p, sheet) {
    if (p.kind === 'row') {
      var by = {};
      Object.keys(p.cols).forEach(function (vi) { by[vi] = num(X.cell(sheet, p.row, p.cols[vi])); });
      return { byVehicle: by };
    }
    var v = num(X.cell(sheet, p.r, p.c));
    return { global: v === null ? null : (p.unit === '%' ? Math.round(v * 100 * 1e9) / 1e9 : v) };
  }

  /** 佔位符 → 畫面上顯示的公式([科目名稱]、[參數名稱]) */
  function displayFormula(textWithPlaceholders, plan, params) {
    var labels = {}, dup = {};
    plan.rows.forEach(function (r) { if (labels[r.label]) dup[r.label] = true; labels[r.label] = r.row; });
    return str(textWithPlaceholders).replace(/⟦r(\d+)⟧/g, function (m, row) {
      var r = plan.rows.filter(function (x) { return x.row === Number(row); })[0];
      if (!r) return '第' + row + '列';
      return '[' + r.label + ']' + (dup[r.label] ? '(第' + row + '列)' : '');
    }).replace(/⟦p:([^⟧]+)⟧/g, function (m, key) {
      return '[' + (params[key] ? params[key].name : key) + ']';
    }).replace(/ \* /g, ' × ').replace(/ \/ /g, ' ÷ ');
  }

  /** 佔位符 → 建立用的公式(科目代碼、參數名稱)；有對不到的列回傳 null */
  function resolveFormula(textWithPlaceholders, codes, params) {
    var missing = false;
    var out = str(textWithPlaceholders).replace(/⟦r(\d+)⟧/g, function (m, row) {
      if (!codes[row]) { missing = true; return '0'; }
      return codes[row];
    }).replace(/⟦p:([^⟧]+)⟧/g, function (m, key) { return '[' + params[key].name + ']'; });
    return missing ? null : out;
  }

  /* ---------------- 沒有公式時由數字推斷小計 ---------------- */
  /**
   * 整張表是「貼上值」、沒有公式時，用數字找出小計：
   *   加總：這一列 = 緊接在下面(或上面)的一段列的合計(遇到已知的小計整段當一項，不重複加它的明細)
   *   扣減：這一列 = 往上數第 k 項 - 中間各項(E = A - B - Σd)
   * 每個車系都要成立才算數；全部是 0 的列不推斷(任何組合都會成立)。
   *
   * 會計恆等式兩個方向都成立(銷貨毛利 = 經銷價 - 入手價 - Σ銷售段，等於「經銷價 = 入手價 + Σ銷售段 + 銷貨毛利」)，
   * 光看數字分不出誰是小計，所以用科目名稱分工：毛利/淨利/貢獻/損益/經銷價/實際零售價…這類「結果」列只會是
   * 「上一段 - 扣項」，不會是加總的標題，也不會被加進別人的合計；其他列(成本、費用)只會是加總。
   * 推斷出來的形狀跟公式分析的一樣({ kind, rows | base/minus })，另外標 inferred: true。
   */
  function inferShapes(rows) {
    var byRow = {}, order = rows.map(function (r) { return r.row; });
    rows.forEach(function (r) { byRow[r.row] = r; });
    var nVeh = rows.length ? rows[0].values.length : 0;
    var isResult = function (row) { return RESULT_LABEL.test(byRow[row].label); };
    var isPrice = function (row) { return PRICE_LABEL.test(byRow[row].label); };
    var tol = function (v) { return Math.max(1, Math.abs(v) * 1e-9); };
    var nonzero = function (r) { return byRow[r].values.some(function (v) { return v !== null && Math.abs(v) > 1e-9; }); };
    var val = function (r, i) { var v = byRow[r].values[i]; return v === null ? 0 : v; };
    var span = {};   // 小計列 → 它的明細範圍 [min, max]
    var descendantsOf = function (row) {
      var out = [], seen = {};
      (function walk(x) {
        var s = byRow[x] && byRow[x].shape;
        if (!s || s.kind !== 'sum' || seen[x]) return;
        seen[x] = true;
        s.rows.forEach(function (c) { out.push(c); walk(c); });
      })(row);
      return out;
    };
    rows.forEach(function (r) {
      if (r.shape && r.shape.kind === 'sum') {
        var d = descendantsOf(r.row);
        if (d.length) span[r.row] = [Math.min.apply(null, d), Math.max.apply(null, d)];
      }
    });

    /** 從第 idx 列往 dir 方向一項一項加(已知小計整段當一項) */
    function scan(idx, dir, onStep) {
      var items = [], sums = [];
      for (var i = 0; i < nVeh; i++) sums.push(0);
      var k = idx + dir;
      while (k >= 0 && k < order.length) {
        var row = order[k];
        // 往下：碰到小計(標題在上)就整段跳過；往上：碰到某個小計的明細範圍就跳到那個小計
        var target = order[idx];
        if (dir < 0) {
          // 這一列是某個「標題在上」小計的明細(而且那個小計不包含目標列) → 整段當一項，跳到那個小計
          var owner = Object.keys(span).map(Number).filter(function (s) {
            return s < row && span[s][0] <= row && span[s][1] >= row && !(span[s][0] <= target && span[s][1] >= target) && s !== target;
          }).sort(function (a, b) { return a - b; })[0];
          if (owner !== undefined) { row = owner; k = order.indexOf(owner); }
        }
        items.push(row);
        for (var j = 0; j < nVeh; j++) sums[j] += val(row, j);
        if (onStep(items, sums, k) === false) return;
        // 已知小計的明細不再重複加：往下碰到「標題在上」的小計、往上碰到「合計在下」的小計，都跳過它的明細
        if (span[row] && dir > 0 && span[row][0] > row) {
          while (k + 1 < order.length && order[k + 1] <= span[row][1]) k++;
        } else if (span[row] && dir < 0 && span[row][1] < row) {
          while (k - 1 >= 0 && order[k - 1] >= span[row][0]) k--;
        }
        k += dir;
      }
    }
    var allMatch = function (target, sums) {
      for (var i = 0; i < nVeh; i++) if (Math.abs(val(target, i) - sums[i]) > tol(val(target, i))) return false;
      return true;
    };

    // 1. 加總：由下往上處理，巢狀的小計先找出來
    for (var idx = order.length - 1; idx >= 0; idx--) {
      var row = order[idx], r = byRow[row];
      if (r.shape && r.shape.kind !== 'none') continue;
      if (!nonzero(row) || isResult(row) || isPrice(row)) continue;
      var found = null;
      [1, -1].some(function (dir) {
        scan(idx, dir, function (items, sums, k) {
          if (isResult(items[items.length - 1]) || isPrice(items[items.length - 1])) return false;   // 結果列不會是別人的明細
          if (items.length >= 2 && allMatch(row, sums) && items.some(nonzero)) {
            // 後面緊接的 0 列也算進來(例如「防鏽 0」)
            var more = items.slice();
            var kk = k + dir;
            while (kk >= 0 && kk < order.length && !nonzero(order[kk]) && byRow[order[kk]].shape.kind === 'none') { more.push(order[kk]); kk += dir; }
            found = { kind: 'sum', rows: more, inferred: true };
            return false;
          }
          return items.length < 40;
        });
        return !!found;
      });
      if (found) {
        r.shape = found;
        var d = descendantsOf(row).concat(found.rows);
        span[row] = [Math.min.apply(null, d), Math.max.apply(null, d)];
      }
    }

    // 2. 扣減：這一列 = 上面某一項 - 中間各項
    order.forEach(function (row, idx2) {
      var r = byRow[row];
      if (r.shape && r.shape.kind !== 'none') return;
      if (!nonzero(row) || !isResult(row)) return;
      scan(idx2, -1, function (items, sums) {
        if (items.length < 2) return true;
        var base = items[items.length - 1];
        var minus = items.slice(0, -1);
        var baseSums = sums.map(function (s, i) { return s - val(base, i); });
        for (var i = 0; i < nVeh; i++) {
          if (Math.abs(val(base, i) - baseSums[i] - val(row, i)) > tol(val(row, i))) return items.length < 40;
        }
        if (!minus.some(nonzero)) return items.length < 40;
        r.shape = { kind: 'deduct', base: base, minus: minus.slice().reverse(), inferred: true };
        return false;
      });
    });
  }

  /** 推斷出來的形狀，寫成給人看的算式(第 15 列 + 第 21~32 列) */
  function describeShape(shape, col) {
    if (!shape || !shape.inferred) return '';
    var L = X.numToCol(col);
    var group = function (rowsList) {
      var sorted = rowsList.slice().sort(function (a, b) { return a - b; }), out = [], i = 0;
      while (i < sorted.length) {
        var j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
        out.push(j > i ? 'SUM(' + L + sorted[i] + ':' + L + sorted[j] + ')' : L + sorted[i]);
        i = j + 1;
      }
      return out;
    };
    if (shape.kind === 'sum') return group(shape.rows).join('+');
    if (shape.kind === 'deduct') return L + shape.base + '-' + group(shape.minus).join('-');
    return '';
  }

  return {
    tokenize: tokenize, translateCell: translateCell, translatePlan: translatePlan, paramValues: paramValues,
    displayFormula: displayFormula, resolveFormula: resolveFormula, inferShapes: inferShapes, describeShape: describeShape
  };
}));
