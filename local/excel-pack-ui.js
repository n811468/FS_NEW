/**
 * 「Excel 轉資料包」畫面：選檔 → 確認欄位 → 逐列對應 → 車型與情境 → 建立、驗算、下載資料包。
 * 判斷與建立的邏輯都在 local/excel-pack.js；這裡只負責畫面與使用者的調整。
 * 建立資料時用的是跟地端版一模一樣的後端(local/host.js + src/*.gs)，只是放在記憶體裡、不暫存。
 */
(function () {
  'use strict';
  var X = window.FSXlsx, E = window.FSExcelPack, F = window.FSExcelFormula, Pack = window.FSPack;
  var MAP_KEY = 'fsExcelPack.map.';
  var GATES = ['GATE F', 'GATE E', 'GATE D', 'GATE C', 'GATE B', 'GATE A', 'GATE Z'];
  var STRUCT_NAMES = { B: 'B 銷貨成本', C: 'C = A - B', E: 'E', G: 'G', I: 'I', K: 'K 營業淨利' };

  var S = null;   // 目前的工作狀態(載入檔案後才有)

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v !== 'number') return esc(v);
    var abs = Math.abs(v);
    var d = abs !== 0 && abs < 10 && Math.round(v) !== v ? 4 : (Math.round(v) === v ? 0 : 2);
    return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
  }
  function storeGet(k) { try { return JSON.parse(window.localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 暫存不能用就算了，只是下次要重新對應 */ } }
  function showError(where, e) {
    var box = $(where);
    box.innerHTML = '<div class="xp-note err">' + esc(e && e.message ? e.message : e) + '</div>';
  }

  /* ---------------- 1. 選檔 ---------------- */
  function readFile(file) {
    $('#xp-file-msg').innerHTML = '<div class="xp-note">讀取中…</div>';
    file.arrayBuffer().then(function (buf) { return X.readWorkbook(buf); }).then(function (wb) {
      var visible = wb.sheets.map(function (s, i) { return i; }).filter(function (i) { return !wb.sheets[i].hidden && wb.sheets[i].maxRow > 0; });
      S = { fileName: file.name, wb: wb, refIndex: visible.length ? visible[0] : 0, included: {}, result: null };
      S.included[S.refIndex] = true;
      $('#xp-file-msg').innerHTML = '';
      selectReference(S.refIndex);
    }).catch(function (e) { S = null; renderAll(); showError('#xp-file-msg', e); });
  }

  function selectReference(index) {
    S.refIndex = index;
    S.included = {}; S.included[index] = true;
    S.result = null;
    try {
      var sheet = S.wb.sheets[index];
      var layout = E.analyzeSheet(sheet);
      S.labelCol = layout.labelCol;
      S.firstRow = layout.firstRow; S.lastRow = layout.lastRow;
      S.columns = layout.columns;
      S.vehicleCols = {};
      S.names = {};
      layout.columns.forEach(function (c) { S.names[c.col] = c.name || ('車系' + c.letter); });
      layout.vehicles.forEach(function (v) { S.vehicleCols[v.col] = true; S.names[v.col] = v.name; });
      S.weightedCol = layout.weightedCol;
      S.noteCol = layout.noteCol;
      var m = /^[A-Za-z0-9]+/.exec(sheet.name.trim());
      S.typeId = m ? m[0] : '';
      S.typeNotes = '來源：' + S.fileName;
      S.layoutError = '';
      refreshRows(true);
    } catch (e) {
      S.layoutError = e.message;
      S.rows = []; S.roles = {}; S.notes = [];
    }
    renderAll();
  }

  /** 欄位改了之後重新取各列；suggest = true 時重新猜角色(優先套用上次存下來的對應) */
  function refreshRows(suggest) {
    var sheet = S.wb.sheets[S.refIndex];
    S.rows = E.extractRows(sheet, layoutOf());
    if (!suggest) return;
    var sug = E.suggestRoles(S.rows, layoutOf());
    S.roles = sug.roles;
    S.notes = sug.notes;
    S.restored = false;
    S.signature = E.signature(S.rows);
    S.useFormulas = true; S.formulaOff = {}; S.paramNames = {};
    var saved = storeGet(MAP_KEY + S.signature);
    if (saved && saved.roles) {
      S.rows.forEach(function (r) { if (saved.roles[r.row]) S.roles[r.row] = saved.roles[r.row]; });
      if (saved.typeId) S.typeId = saved.typeId;
      if (saved.useFormulas === false) S.useFormulas = false;
      S.formulaOff = saved.formulaOff || {};
      S.paramNames = saved.paramNames || {};
      S.restored = true;
    }
    S.scenarios = {};
  }

  function layoutOf() {
    return {
      labelCol: S.labelCol, firstRow: S.firstRow, lastRow: S.lastRow, weightedCol: S.weightedCol, noteCol: S.noteCol,
      vehicles: S.columns.filter(function (c) { return S.vehicleCols[c.col]; }).map(function (c) { return { col: c.col, name: S.names[c.col] }; })
    };
  }

  function planOf() {
    var layout = layoutOf();
    var plan = {
      typeId: S.typeId.trim(), typeNotes: S.typeNotes, vehicles: layout.vehicles, weightedCol: S.weightedCol,
      noteCol: S.noteCol, labelCol: S.labelCol, firstRow: S.firstRow, rows: S.rows, roles: S.roles,
      useFormulas: S.useFormulas !== false, formulaOff: S.formulaOff || {}, paramNames: S.paramNames || {}
    };
    plan.scenarios = includedSheets().map(function (i) { return scenarioOf(i, plan); });
    return plan;
  }

  function includedSheets() {
    return S.wb.sheets.map(function (s, i) { return i; }).filter(function (i) { return S.included[i]; });
  }

  /** 每個分頁的情境設定(第一次用到時依那個分頁的數字推算比率與構成比) */
  function scenarioOf(i, plan) {
    var sheet = S.wb.sheets[i];
    var key = i + '|' + plan.vehicles.map(function (v) { return v.col; }).join(',');
    var sc = S.scenarios[key];
    if (!sc) {
      var rows = E.extractRows(sheet, layoutOf());
      var name = sheet.name.trim();
      if (S.typeId && name.indexOf(S.typeId) === 0 && name.length > S.typeId.length) name = name.slice(S.typeId.length).trim();
      sc = S.scenarios[key] = {
        name: name, gate: 'GATE F', type: '現況',
        rates: E.inferRates(rows, S.roles),
        mix: E.mixFor(sheet, plan)
      };
    }
    sc.sheet = sheet;
    return sc;
  }

  /* ---------------- 畫面 ---------------- */
  function renderAll() {
    renderSheets();
    renderColumns();
    renderRows();
    renderScenarios();
    renderResult();
  }

  function renderSheets() {
    var box = $('#xp-sheets');
    if (!S) { box.innerHTML = ''; return; }
    var planNow = S.rows && S.rows.length ? planOf() : null;
    var html = '<p class="xp-sub">「參考分頁」決定科目表的結構；版面相同的其他分頁可以一起勾選，每個分頁會變成同一個車型底下的一個情境。</p>' +
      '<div class="xp-scroll"><table class="xp-table"><thead><tr><th>參考</th><th>轉成情境</th><th>分頁</th><th>版面</th></tr></thead><tbody>';
    S.wb.sheets.forEach(function (s, i) {
      if (!s.maxRow) return;
      var same = '';
      if (planNow && i !== S.refIndex) {
        var diffs = E.sameLayout(s, planNow);
        same = diffs.length ? '<span class="xp-tag">版面不同(' + diffs.length + ' 列名稱不一樣)</span>' : '<span class="xp-tag ok">版面相同，可一起轉</span>';
      }
      html += '<tr' + (s.hidden ? ' class="skip"' : '') + '><td><input type="radio" name="xp-ref" data-ref="' + i + '"' + (i === S.refIndex ? ' checked' : '') + '></td>' +
        '<td><input type="checkbox" data-inc="' + i + '"' + (S.included[i] ? ' checked' : '') + (i === S.refIndex ? ' disabled' : '') + '></td>' +
        '<td>' + esc(s.name) + (s.hidden ? ' <span class="xp-tag">隱藏</span>' : '') + '</td><td>' + (i === S.refIndex ? '<span class="xp-tag ok">參考分頁</span>' : same) + '</td></tr>';
    });
    box.innerHTML = html + '</tbody></table></div>';
  }

  function renderColumns() {
    var card = $('#xp-card-cols');
    card.hidden = !S;
    if (!S) return;
    var box = $('#xp-cols');
    if (S.layoutError) { box.innerHTML = '<div class="xp-note err">' + esc(S.layoutError) + '</div>'; return; }
    var colOpts = function (cur, allowNone) {
      var out = allowNone ? '<option value="0">(沒有)</option>' : '';
      for (var c = 1; c <= S.wb.sheets[S.refIndex].maxCol; c++) {
        out += '<option value="' + c + '"' + (c === cur ? ' selected' : '') + '>' + X.numToCol(c) + ' 欄</option>';
      }
      return out;
    };
    var html = '<p class="xp-sub">科目名稱在 <b>' + X.numToCol(S.labelCol) + '</b> 欄，資料從第 ' + S.firstRow + ' 列到第 ' + S.lastRow + ' 列。勾選哪幾欄是各車系的金額(台幣)，並取好車系名稱。</p>' +
      '<div class="xp-scroll"><table class="xp-table"><thead><tr><th>欄</th><th>標題</th><th>車系</th><th>車系名稱</th><th>範例值</th><th>判斷</th></tr></thead><tbody>';
    var sheet = S.wb.sheets[S.refIndex];
    S.columns.forEach(function (c) {
      var sample = '';
      for (var r = S.firstRow; r <= S.lastRow && !sample; r++) {
        var cell = X.cell(sheet, r, c.col);
        if (cell && typeof cell.v === 'number' && Math.abs(cell.v) > 1.5) sample = fmt(cell.v);
      }
      var hint = c.col === S.weightedCol ? '<span class="xp-tag warn">加權欄</span>' : c.pct ? '<span class="xp-tag">百分比</span>' : c.foreign ? '<span class="xp-tag">外幣</span>' : '';
      html += '<tr' + (S.vehicleCols[c.col] ? '' : ' class="skip"') + '><td>' + c.letter + '</td><td>' + esc(c.headers.join(' / ')) + '</td>' +
        '<td><input type="checkbox" data-veh="' + c.col + '"' + (S.vehicleCols[c.col] ? ' checked' : '') + '></td>' +
        '<td><input type="text" data-vname="' + c.col + '" value="' + esc(S.names[c.col]) + '"' + (S.vehicleCols[c.col] ? '' : ' disabled') + '></td>' +
        '<td class="num">' + sample + '</td><td>' + hint + '</td></tr>';
    });
    html += '</tbody></table></div><div class="xp-row" style="margin-top:10px">' +
      '<label class="xp-field">加權欄(用來驗算加權平均)<select id="xp-wcol">' + colOpts(S.weightedCol, true) + '</select></label>' +
      '<label class="xp-field">說明欄(帶進科目說明)<select id="xp-ncol">' + colOpts(S.noteCol, true) + '</select></label></div>';
    box.innerHTML = html;
  }

  function roleOptions(cur) {
    var groups = [
      ['', ['skip']],
      ['售價結構', ['price:list', 'price:accessory', 'price:scrap', 'mix', 'check:P5', 'check:P6', 'check:P7', 'check:P8']],
      ['損益小計', ['sub:B', 'sub:C', 'sub:E', 'sub:G', 'sub:I', 'sub:K']],
      ['明細', ['group', 'detail']]
    ];
    return groups.map(function (g) {
      var opts = g[1].map(function (r) { return '<option value="' + r + '"' + (r === cur ? ' selected' : '') + '>' + esc(E.ROLE_LABELS[r]) + '</option>'; }).join('');
      return g[0] ? '<optgroup label="' + g[0] + '">' + opts + '</optgroup>' : opts;
    }).join('');
  }

  function parentOptions(row, cur) {
    var out = '<option value="">(請選擇)</option>';
    Object.keys(E.PARENTS).forEach(function (k) {
      var mapped = S.rows.filter(function (r) { return S.roles[r.row] && S.roles[r.row].role === 'sub:' + k; })[0];
      out += '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + esc(E.PARENTS[k] + (mapped ? '：' + mapped.label : '')) + '</option>';
    });
    S.rows.forEach(function (r) {
      if (r.row === row || !S.roles[r.row] || S.roles[r.row].role !== 'group') return;
      var v = 'r' + r.row;
      out += '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>第 ' + r.row + ' 列 ' + esc(r.label) + '</option>';
    });
    return out;
  }

  function depthOf(row) {
    var d = 0, p = S.roles[row] && S.roles[row].parent;
    while (/^r\d+$/.test(p) && d < 20) { d++; p = S.roles[p.slice(1)] && S.roles[p.slice(1)].parent; }
    return d;
  }

  function renderRows() {
    var card = $('#xp-card-rows');
    card.hidden = !S || !!S.layoutError;
    if (card.hidden) return;
    var vehicles = layoutOf().vehicles;
    var notes = (S.restored ? ['已套用上次這份 Excel 的對應設定。<button class="xp-btn" type="button" id="xp-reset-map">改回自動判斷</button>'] : [])
      .concat(S.notes.map(esc));
    var html = notes.length ? '<div class="xp-note"><ul>' + notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul></div>' : '';
    var plan = planOf();
    var tr = safeTranslate(plan);
    var lastFallback = S.result && S.result.plan ? (S.result.plan.fallback || {}) : {};
    var counts = { formula: 0, input: 0 };
    Object.keys(tr.rows).forEach(function (k) { counts[tr.rows[k].mode === 'input' || lastFallback[k] ? 'input' : 'formula']++; });
    html += '<div class="xp-row" style="margin:6px 0 10px"><label><input type="checkbox" id="xp-use-formulas"' + (S.useFormulas !== false ? ' checked' : '') +
      '> 把 Excel 公式轉成系統公式</label><span class="xp-sub" style="margin:0">' +
      (S.useFormulas !== false ? '明細 ' + (counts.formula + counts.input) + ' 列：' + counts.formula + ' 列轉成公式、' + counts.input + ' 列帶入數字(滑鼠移到原因上看完整說明)' : '關閉時所有明細都帶入 Excel 算好的數字') + '</span></div>';
    html += '<div class="xp-scroll" style="max-height:70vh"><table class="xp-table"><thead><tr><th>列</th><th>Excel 科目</th>' +
      vehicles.map(function (v) { return '<th>' + esc(v.name) + '</th>'; }).join('') +
      '<th>Excel 公式</th><th>在系統裡是</th><th>掛在哪個小計底下</th><th>系統怎麼算</th></tr></thead><tbody>';
    S.rows.forEach(function (r) {
      var ro = S.roles[r.row] || { role: 'skip', parent: '' };
      var cls = ro.role === 'skip' ? 'skip' : (/^sub:|^check:P8|^group/.test(ro.role) ? 'sub' : '');
      var needsParent = ro.role === 'group' || ro.role === 'detail';
      html += '<tr class="' + cls + '"><td>' + r.row + '</td>' +
        '<td><span class="xp-indent" style="width:' + (needsParent ? 14 + depthOf(r.row) * 14 : 0) + 'px"></span>' + esc(r.label) + '</td>' +
        r.values.map(function (v) { return '<td class="num">' + fmt(v) + '</td>'; }).join('') +
        excelFormulaCell(r, vehicles) +
        '<td><select data-role="' + r.row + '">' + roleOptions(ro.role) + '</select></td>' +
        '<td>' + (needsParent ? '<select data-parent="' + r.row + '">' + parentOptions(r.row, ro.parent) + '</select>' : '') + '</td>' +
        '<td class="xp-calc">' + calcCell(r, ro, tr, plan, lastFallback) + '</td></tr>';
    });
    $('#xp-rows').innerHTML = html + '</tbody></table></div>';
  }

  function safeTranslate(plan) {
    try { return F.translatePlan(plan); } catch (e) { return { rows: {}, params: {} }; }
  }

  /** Excel 公式欄：有公式就顯示公式；沒有公式但由數字推斷出是小計，就顯示推斷的算式 */
  function excelFormulaCell(r, vehicles) {
    if (r.formula) return '<td class="formula" title="' + esc(r.formula) + '">=' + esc(r.formula) + '</td>';
    var inferred = F.describeShape(r.shape, vehicles[0] ? vehicles[0].col : 1);
    if (inferred) return '<td class="formula xp-inferred" title="這一列在 Excel 沒有公式(貼上值)，數字剛好等於這個算式">由數字推斷：=' + esc(inferred) + '</td>';
    return '<td class="formula"></td>';
  }

  /** 系統怎麼算：小計/公式/帶入數字(與原因) */
  function calcCell(r, ro, tr, plan, lastFallback) {
    if (ro.role === 'skip') return '';
    if (ro.role === 'group') return '<span class="xp-tag">小計</span> 底下明細合計';
    if (/^sub:/.test(ro.role)) return '<span class="xp-tag">小計</span> 系統損益鏈';
    if (/^price|^mix/.test(ro.role)) return '<span class="xp-tag">銷售構成</span>';
    if (/^check:/.test(ro.role)) return '<span class="xp-tag">售價結構</span> 系統公式';
    var t = tr.rows[r.row];
    if (!t) return '';
    var why = lastFallback[r.row] || t.reason;
    var toggle = '';
    var canToggle = S.useFormulas !== false && (t.mode !== 'input' || S.formulaOff[r.row]) && !lastFallback[r.row];
    if (canToggle) toggle = '<label class="xp-mini"><input type="checkbox" data-fon="' + r.row + '"' + (S.formulaOff[r.row] ? '' : ' checked') + '>用公式</label> ';
    if (t.mode !== 'input' && !lastFallback[r.row]) {
      var main = t.mode === 'formula' ? F.displayFormula(t.formula, plan, tr.params) : '';
      var per = Object.keys(t.vehicleFormulas).map(function (vi) {
        return esc(plan.vehicles[vi].name) + '：' + esc(F.displayFormula(t.vehicleFormulas[vi], plan, tr.params));
      });
      var body = (main ? '<code>' + esc(main) + '</code>' : '') +
        (per.length ? '<div class="xp-per">' + (t.mode === 'mixed' ? '其他車系帶入數字；' : '車系個別公式 ') + per.join('；') + '</div>' : '');
      return toggle + '<span class="xp-tag ok">公式</span> ' + body;
    }
    var note = t.note ? '<span class="xp-why">' + esc(t.note) + '</span>' : '';
    return toggle + '<span class="xp-tag' + (why ? ' warn' : '') + '">數字</span> ' +
      (why ? '<span class="xp-why" title="' + esc(why) + '">' + esc(why) + '</span>' : note);
  }

  function renderParams(plan, tr) {
    var used = {};
    Object.keys(tr.rows).forEach(function (k) {
      var t = tr.rows[k];
      if (t.mode === 'input') return;
      [t.formula].concat(Object.keys(t.vehicleFormulas).map(function (x) { return t.vehicleFormulas[x]; }))
        .forEach(function (f) { String(f || '').replace(/⟦p:([^⟧]+)⟧/g, function (m, key) { used[key] = true; return m; }); });
    });
    var keys = Object.keys(used);
    if (!keys.length) return '';
    var ref = plan.scenarios[0].sheet;
    var html = '<h3 class="xp-h3">公式用到的參數</h3><p class="xp-sub">從 Excel 的參數儲存格建立，每個情境帶自己分頁上的值；名稱可以改(匯率會寫進「匯率設定」)。</p>' +
      '<div class="xp-scroll"><table class="xp-table"><thead><tr><th>參數名稱</th><th>來源</th><th>單位</th><th>「' + esc(ref.name) + '」的值</th></tr></thead><tbody>';
    keys.sort().forEach(function (key) {
      var p = tr.params[key];
      var v = F.paramValues(p, ref);
      var shown = p.kind === 'row'
        ? Object.keys(v.byVehicle).map(function (vi) { return esc(plan.vehicles[vi].name) + ' ' + fmt(v.byVehicle[vi]); }).join('、')
        : fmt(v.global) + (p.unit === '%' ? '%' : '');
      var src = p.kind === 'row' ? '第 ' + p.row + ' 列的 ' + esc(p.token) + ' 欄(每個車系一個值)' : esc(p.ref) + (p.label ? '「' + esc(p.label) + '」' : '');
      html += '<tr><td>' + (p.kind === 'fx' || p.builtin ? esc(p.name) + ' <span class="xp-tag">' + (p.kind === 'fx' ? '匯率設定' : '內建參數') + '</span>'
        : '<input type="text" data-pname="' + esc(key) + '" value="' + esc(p.name) + '">') +
        '</td><td>' + src + '</td><td>' + esc(p.unit) + '</td><td class="num">' + shown + '</td></tr>';
    });
    return html + '</tbody></table></div>';
  }

  function renderScenarios() {
    var card = $('#xp-card-sc');
    card.hidden = !S || !!S.layoutError;
    if (card.hidden) return;
    var plan = planOf();
    var html = '<div class="xp-row">' +
      '<label class="xp-field">車型代號<input id="xp-type" value="' + esc(S.typeId) + '" placeholder="例如 D5X"></label>' +
      '<label class="xp-field" style="flex:1">車型備註<input id="xp-type-notes" value="' + esc(S.typeNotes) + '"></label></div>' +
      '<p class="xp-sub" style="margin-top:12px">營業稅率、銷售佣金率是從 Excel 的營業稅、銷售佣金列反推的(%)；構成比用來算加權平均。</p>' +
      '<div class="xp-scroll"><table class="xp-table"><thead><tr><th>分頁</th><th>情境名稱</th><th>GATE</th><th>性質</th><th>營業稅率%</th><th>銷售佣金率%</th>' +
      plan.vehicles.map(function (v) { return '<th>構成比% ' + esc(v.name) + '</th>'; }).join('') + '</tr></thead><tbody>';
    includedSheets().forEach(function (i, n) {
      var sc = plan.scenarios[n];
      html += '<tr><td>' + esc(S.wb.sheets[i].name) + '</td>' +
        '<td><input type="text" data-sc="' + n + '" data-f="name" value="' + esc(sc.name) + '"></td>' +
        '<td><select data-sc="' + n + '" data-f="gate">' + GATES.map(function (g) { return '<option' + (g === sc.gate ? ' selected' : '') + '>' + g + '</option>'; }).join('') + '</select></td>' +
        '<td><select data-sc="' + n + '" data-f="type">' + ['現況', '目標'].map(function (g) { return '<option' + (g === sc.type ? ' selected' : '') + '>' + g + '</option>'; }).join('') + '</select></td>' +
        '<td><input type="number" step="any" data-sc="' + n + '" data-f="rate:營業稅率" value="' + sc.rates.營業稅率 + '"></td>' +
        '<td><input type="number" step="any" data-sc="' + n + '" data-f="rate:銷售佣金率" value="' + sc.rates.銷售佣金率 + '"></td>' +
        plan.vehicles.map(function (v, vi) { return '<td><input type="number" step="any" data-sc="' + n + '" data-f="mix:' + vi + '" value="' + sc.mix[vi] + '"></td>'; }).join('') +
        '</tr>';
    });
    $('#xp-sc').innerHTML = html + '</tbody></table></div>' + renderParams(plan, safeTranslate(plan));
  }

  function renderResult() {
    var card = $('#xp-card-run');
    card.hidden = !S || !!S.layoutError;
    if (card.hidden) return;
    var R = S.result;
    if (!R) { $('#xp-result').innerHTML = ''; $('#xp-download').disabled = true; return; }
    if (R.error) { showError('#xp-result', R.error); $('#xp-download').disabled = true; return; }
    $('#xp-download').disabled = false;
    var total = R.verify.reduce(function (s, v) { return s + v.checked; }, 0);
    var bad = R.verify.reduce(function (s, v) { return s + v.mismatches; }, 0);
    var html = bad
      ? '<div class="xp-note warn">有 ' + bad + ' 格跟 Excel 不一樣(共比對 ' + total + ' 格)。通常是某一列沒有掛到正確的小計、或漏掉了。仍然可以下載，但建議先調整「逐列對應」。</div>'
      : '<div class="xp-note">驗算通過：' + total + ' 格全部跟 Excel 相同(容差 ' + E.TOLERANCE + ' 元)。下載後在車型損益試算系統按「匯入資料包…」→「合併匯入」。</div>';
    var plan = R.plan;
    var fb = plan.fallback || {};
    var fbRows = Object.keys(fb).filter(function (k) { return !(plan.formulaOff || {})[k]; });
    var nFormula = Object.keys(R.built.formulaRows).length;
    if (plan.useFormulas !== false) {
      html += '<div class="xp-note">' + nFormula + ' 列明細轉成系統公式' +
        (fbRows.length ? '；以下 ' + fbRows.length + ' 列在建立或驗算時改為帶入數字：<ul>' + fbRows.map(function (k) {
          var row = plan.rows.filter(function (r) { return String(r.row) === String(k); })[0];
          return '<li>第 ' + k + ' 列「' + esc(row ? row.label : '') + '」：' + esc(fb[k]) + '</li>';
        }).join('') + '</ul>' : '。') + '</div>';
    }
    R.verify.forEach(function (v) {
      var heads = plan.vehicles.map(function (x) { return x.name; }).concat(plan.weightedCol ? ['加權'] : []);
      html += '<details class="xp-detail"' + (v.mismatches ? ' open' : '') + '><summary>' + esc(v.sheetName) + ' → 情境「' + esc(v.scenarioName) + '」 ' +
        (v.mismatches ? '<span class="xp-bad">✗ ' + v.mismatches + ' 格不同</span>' : '<span class="xp-ok">✓ ' + v.checked + ' 格相同</span>') + '</summary>' +
        '<div class="xp-scroll"><table class="xp-table"><thead><tr><th>列</th><th>科目</th><th>代碼</th>' +
        heads.map(function (h) { return '<th>' + esc(h) + ' Excel</th><th>系統</th>'; }).join('') + '</tr></thead><tbody>';
      v.rows.forEach(function (row) {
        var rowBad = row.cells.some(function (c) { return c.ok === false; });
        html += '<tr' + (rowBad ? ' class="bad"' : '') + '><td>' + row.row + '</td><td>' + esc(row.label) + '</td><td>' + esc(row.code) + '</td>' +
          row.cells.map(function (c) {
            return '<td class="num">' + fmt(c.excel) + '</td><td class="num">' + (c.ok === false ? '<span class="xp-bad">' + fmt(c.system) + '</span>' : fmt(c.system)) + '</td>';
          }).join('') + '</tr>';
      });
      html += '</tbody></table></div></details>';
    });
    $('#xp-result').innerHTML = html;
  }

  /* ---------------- 5. 建立 ---------------- */
  function run() {
    S.result = null;
    try {
      var plan = planOf();
      var newEnv = function () {
        var host = FSHost.createHost({ factory: FSBackendFactory, shim: FSGasShim, pack: Pack, storage: null, getUser: function () { return 'Excel 轉資料包'; } });
        host.start();
        return { host: host, api: new Proxy({}, { get: function (_, name) { return function () { return host.call(name, Array.prototype.slice.call(arguments)); }; } }) };
      };
      var res = E.buildAndVerify(newEnv, plan);
      var pack = res.env.host.exportPack([plan.typeId]);
      pack.source = { kind: 'excel', file: S.fileName, sheets: plan.scenarios.map(function (s) { return s.sheet.name; }) };
      S.result = { plan: res.plan, verify: res.verify, built: res.built, pack: pack };
      storeSet(MAP_KEY + S.signature, {
        roles: S.roles, typeId: S.typeId, useFormulas: S.useFormulas, formulaOff: S.formulaOff, paramNames: S.paramNames,
        savedAt: new Date().toISOString()
      });
    } catch (e) {
      S.result = { error: e };
    }
    renderRows();
    renderResult();
    $('#xp-card-run').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function download() {
    if (!S || !S.result || !S.result.pack) return;
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    var blob = new Blob([JSON.stringify(S.result.pack, null, 1)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'FS資料包_' + S.result.plan.typeId.replace(/[\\/:*?"<>|\s]+/g, '_') + '_' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  /* ---------------- 事件 ---------------- */
  function changed(what) {
    if (S) S.result = null;
    if (what === 'cols') { refreshRows(true); renderAll(); return; }
    if (what === 'rows') { renderRows(); renderScenarios(); renderSheets(); renderResult(); return; }
    renderResult();
  }

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!S) return;
    if (t.dataset.ref !== undefined) { selectReference(Number(t.dataset.ref)); return; }
    if (t.dataset.inc !== undefined) { S.included[Number(t.dataset.inc)] = t.checked; changed('rows'); return; }
    if (t.dataset.veh !== undefined) { S.vehicleCols[Number(t.dataset.veh)] = t.checked; changed('cols'); return; }
    if (t.dataset.vname !== undefined) { S.names[Number(t.dataset.vname)] = t.value.trim(); S.scenarios = {}; changed('rows'); return; }
    if (t.id === 'xp-wcol') { S.weightedCol = Number(t.value); if (S.weightedCol) delete S.vehicleCols[S.weightedCol]; changed('cols'); return; }
    if (t.id === 'xp-ncol') { S.noteCol = Number(t.value); refreshRows(false); changed('rows'); return; }
    if (t.dataset.role !== undefined) {
      var row = t.dataset.role;
      var prev = S.roles[row] || {};
      S.roles[row] = { role: t.value, parent: (t.value === 'group' || t.value === 'detail') ? (prev.parent || '') : '' };
      if (/^price|^mix|^check/.test(t.value)) S.scenarios = {};   // 比率、構成比要重新推算
      changed('rows'); return;
    }
    if (t.dataset.parent !== undefined) { S.roles[t.dataset.parent].parent = t.value; changed('rows'); return; }
    if (t.id === 'xp-use-formulas') { S.useFormulas = t.checked; changed('rows'); return; }
    if (t.dataset.fon !== undefined) { if (t.checked) delete S.formulaOff[t.dataset.fon]; else S.formulaOff[t.dataset.fon] = true; changed('rows'); return; }
    if (t.dataset.pname !== undefined) { if (t.value.trim()) S.paramNames[t.dataset.pname] = t.value.trim(); else delete S.paramNames[t.dataset.pname]; changed('rows'); return; }
    if (t.id === 'xp-type') { S.typeId = t.value.trim(); changed(); return; }
    if (t.id === 'xp-type-notes') { S.typeNotes = t.value; changed(); return; }
    if (t.dataset.sc !== undefined) {
      var sc = planOf().scenarios[Number(t.dataset.sc)];
      var f = t.dataset.f;
      if (f.indexOf('rate:') === 0) sc.rates[f.slice(5)] = Number(t.value);
      else if (f.indexOf('mix:') === 0) sc.mix[Number(f.slice(4))] = Number(t.value);
      else sc[f] = t.value;
      changed();
    }
  });
  document.addEventListener('click', function (e) {
    if (e.target.id === 'xp-reset-map' && S) {
      try { window.localStorage.removeItem(MAP_KEY + S.signature); } catch (err) { /* ignore */ }
      refreshRows(true); S.restored = false; changed('rows');
    }
  });

  function init() {
    var input = $('#xp-file');
    input.addEventListener('change', function () { if (input.files && input.files[0]) readFile(input.files[0]); input.value = ''; });
    $('#xp-pick').addEventListener('click', function () { input.click(); });
    var drop = $('#xp-drop');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f); });
    $('#xp-run').addEventListener('click', function () { if (S) run(); });
    $('#xp-download').addEventListener('click', download);
    renderAll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
