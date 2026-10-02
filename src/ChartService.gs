/**
 * 科目表服務：每個車型各自一份科目表 + 公式式的計算來源。
 *
 * 為什麼科目表要依車型分開：同一個 GATE、甚至同一類車型之間，損益科目都差很多
 * (有的車型有 KD 件、有的沒有；有的要拆 TNCAP 模具、有的不用)。以前整個系統只有一份全域科目表，
 * 以 DA 的 Gate F 表為基底，替別的車型加科目會出現在所有車型上、刪科目會清掉所有車型的金額，
 * 誤差跟干擾都很大。現在：
 *   - VehicleTypeID 留白的那一組是「標準範本」，建立新車型時可以選擇從範本或從某個既有車型複製
 *   - 之後每個車型各改各的，互不影響
 *   - 舊資料(只有一份全域科目表)開頁時自動轉成「範本 + 每個車型各複製一份」，數字完全不變
 *
 * 計算來源(CalcType)：INPUT 手動輸入 / FORMULA 公式 / DEV_AMORT 開發總投攤提。
 * 內建的售價結構、貨物稅、季Margin、各段小計也都只是「預設公式」，畫面上看得到、改得動，
 * 也可以替個別車系另外指定公式(VehicleFormulas)，處理同一車型內不同車系算法不同的情況。
 */

var TEMPLATE_KEY_ = '*';

function lineIdOf_(vehicleTypeId, lineCode) {
  return (vehicleTypeId || TEMPLATE_KEY_) + '|' + lineCode;
}

/** 某個情境屬於哪個車型 */
function vehicleTypeOfScenario_(scenarioId) {
  var s = getScenarios().filter(function (r) { return r.ScenarioID === scenarioId; })[0];
  return s ? (s.VehicleTypeID || '') : '';
}

/** 科目表所有列(含範本與各車型)，未經整理 */
function allLineItemRows_() {
  return sheetToObjects_(SHEETS.PL_LINE_ITEMS) || [];
}

/**
 * 科目的計算來源：新資料直接看 CalcType；舊資料(改版前)依 AutoSource 推算，結果跟改版前的計算完全一樣。
 */
function lineCalcType_(def) {
  if (def.CalcType && CALC_TYPES[def.CalcType]) return def.CalcType;
  var auto = def.AutoSource || '';
  if (DEV_AMORT_AUTO_SOURCES.indexOf(auto) !== -1) return CALC_TYPES.DEV_AMORT;
  if (auto) return CALC_TYPES.FORMULA;
  // 舊版有預設公式的科目(售價結構、各段小計、貨物稅、季Margin)全都是自動計算科目
  if (DEFAULT_FORMULAS[def.LineCode] || PROTECTED_LINE_CODES.indexOf(def.LineCode) !== -1) return CALC_TYPES.FORMULA;
  return CALC_TYPES.INPUT;
}

/** 某個科目在某個車系實際使用的公式：有車系個別公式就用它，否則用科目的公式(舊資料沒公式時用預設公式) */
function lineFormulaFor_(def, vehicleId) {
  var overrides = parseVehicleFormulas_(def.VehicleFormulas);
  if (vehicleId && overrides[vehicleId] !== undefined && String(overrides[vehicleId]).trim() !== '') {
    return String(overrides[vehicleId]);
  }
  if (def.Formula !== undefined && def.Formula !== null && String(def.Formula).trim() !== '') return String(def.Formula);
  return DEFAULT_FORMULAS[def.LineCode] || '';
}

function parseVehicleFormulas_(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { var o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
}

/**
 * 公式裡的 [科目名稱] 換成科目代碼(存檔用)。名稱同時也是系統變數/參數/匯率時保留原樣
 * (計算時這些名稱優先，換掉會改變意思)。字串常數(REF 的參數)與函式名稱不動。
 */
function codifyFormulaNames_(formula, defs) {
  if (!formula) return formula;
  var reserved = formulaReservedNames_();
  var byName = {};
  defs.forEach(function (d) { if (!byName[d.LineName]) byName[d.LineName] = d.LineCode; });
  return mapFormulaTokens_(formula, function (tok) {
    if (tok.charAt(0) !== '[') return tok;
    var name = tok.slice(1, -1).trim();
    if (reserved[name] || /^[A-Za-z]{3}匯率$/.test(name)) return tok;
    return byName[name] ? byName[name] : tok;
  });
}

/** 把公式裡的 [舊名稱] 換成科目代碼(科目改名時用) */
function replaceNameRef_(formula, oldName, code) {
  if (!formula) return formula;
  return mapFormulaTokens_(formula, function (tok) {
    return tok.charAt(0) === '[' && tok.slice(1, -1).trim() === oldName ? code : tok;
  });
}

/** 系統變數與參數名稱(公式裡 [名稱] 會優先解讀成這些) */
function formulaReservedNames_() {
  var out = {};
  SYSTEM_VARIABLES.forEach(function (v) { out[v.name] = true; });
  getParamDefs().forEach(function (p) { out[p.ParamName] = true; });
  return out;
}

/** 依序走過公式的 "字串"、[名稱]、其他片段，讓呼叫端替換 [名稱]；其他內容原封不動 */
function mapFormulaTokens_(formula, fn) {
  return String(formula).replace(/"[^"]*"|'[^']*'|\[[^\]]*\]/g, function (tok) {
    return tok.charAt(0) === '[' ? fn(tok) : tok;
  });
}

/** 把讀出來的科目列整理成計算/畫面用的樣子(補 CalcType、Formula) */
function normalizeLineDef_(row) {
  var d = {};
  SCHEMA.PLLineItems.forEach(function (h) { d[h] = row[h] === undefined || row[h] === null ? '' : row[h]; });
  d.SortOrder = toNumber_(row.SortOrder);
  d.CalcType = lineCalcType_(row);
  if (d.CalcType === CALC_TYPES.FORMULA && !String(d.Formula).trim()) d.Formula = DEFAULT_FORMULAS[d.LineCode] || '';
  return d;
}

function sortLineDefs_(rows) {
  return rows.slice().sort(function (a, b) { return toNumber_(a.SortOrder) - toNumber_(b.SortOrder); });
}

/** 標準範本的科目 */
function getTemplateLineItems_() {
  return sortLineDefs_(allLineItemRows_().filter(function (r) { return !r.VehicleTypeID; }).map(normalizeLineDef_));
}

function hasOwnChart_(vehicleTypeId) {
  if (!vehicleTypeId) return false;
  return allLineItemRows_().some(function (r) { return r.VehicleTypeID === vehicleTypeId; });
}

/**
 * 某個車型的科目表；這個車型還沒有自己的科目表時讀標準範本(唯讀沿用，第一次修改時才複製一份)。
 * 不帶車型 = 標準範本。
 */
function getPLLineItems(vehicleTypeId) {
  if (vehicleTypeId && hasOwnChart_(vehicleTypeId)) {
    return sortLineDefs_(allLineItemRows_().filter(function (r) { return r.VehicleTypeID === vehicleTypeId; })
      .map(normalizeLineDef_));
  }
  return getTemplateLineItems_();
}

/** 依情境取科目表(計算引擎用) */
function lineDefsForScenario_(scenarioId) {
  return getPLLineItems(vehicleTypeOfScenario_(scenarioId));
}

/**
 * 確保車型有自己的一份科目表(還沒有就從 sourceTypeId 或標準範本複製)。呼叫端必須在 withLock_ 內。
 * 回傳是否有新建立。
 */
function ensureTypeChart_(vehicleTypeId, sourceTypeId) {
  if (!vehicleTypeId || hasOwnChart_(vehicleTypeId)) return false;
  var source = sourceTypeId && hasOwnChart_(sourceTypeId) ? getPLLineItems(sourceTypeId) : getTemplateLineItems_();
  var rows = source.map(function (d) { return copyLineRow_(d, vehicleTypeId); });
  batchWriteRows_(SHEETS.PL_LINE_ITEMS, 'LineID', rows, []);
  return true;
}

function copyLineRow_(d, vehicleTypeId) {
  var row = {};
  SCHEMA.PLLineItems.forEach(function (h) { row[h] = d[h] === undefined ? '' : d[h]; });
  row.VehicleTypeID = vehicleTypeId || '';
  row.LineID = lineIdOf_(vehicleTypeId, d.LineCode);
  if (typeof row.VehicleFormulas === 'object') row.VehicleFormulas = JSON.stringify(row.VehicleFormulas);
  // 車系個別公式掛的是來源車型的車系代號，複製到別的車型就對不到了
  if (vehicleTypeId && d.VehicleTypeID && d.VehicleTypeID !== vehicleTypeId) row.VehicleFormulas = '';
  return row;
}

/**
 * 資料模型升級(每次開頁/載入資料包時都會跑，已經升級過的資料不會被動到)：
 *   1. 舊版全域科目表：補 LineID、標成標準範本
 *   2. 補 CalcType / Formula；名稱還是舊版「名稱裡寫公式」的換成新名稱(使用者改過的名稱不動)
 *   3. 每個車型都複製一份自己的科目表(materializeCharts = true 時)
 *   4. 內建參數補上參數定義
 */
function migrateDataModel_(materializeCharts) {
  var rows = allLineItemRows_();
  var upserts = [], deletes = [];
  rows.forEach(function (r) {
    var changed = false;
    var row = {};
    SCHEMA.PLLineItems.forEach(function (h) { row[h] = r[h] === undefined || r[h] === null ? '' : r[h]; });
    if (!row.LineID) {
      row.LineID = lineIdOf_(row.VehicleTypeID, row.LineCode);
      changed = true;
    }
    if (!row.CalcType) {
      row.CalcType = lineCalcType_(r);
      if (row.CalcType === CALC_TYPES.FORMULA && !row.Formula) row.Formula = DEFAULT_FORMULAS[row.LineCode] || '';
      if (LEGACY_LINE_NAMES[row.LineCode] && row.LineName === LEGACY_LINE_NAMES[row.LineCode]) {
        var builtIn = PL_LINE_ITEMS.filter(function (d) { return d.LineCode === row.LineCode; })[0];
        if (builtIn) row.LineName = builtIn.LineName;
      }
      changed = true;
    }
    if (changed) upserts.push(row);
  });
  if (upserts.length || deletes.length) {
    // 主鍵欄從 LineCode 改成 LineID：舊列的 LineID 是空的，整批寫入時用 LineCode 當比對依據會對不到，
    // 所以先把整張表依 LineCode 對應好再一次寫回
    var byCode = {};
    upserts.forEach(function (u) { byCode[(u.VehicleTypeID || '') + '|' + u.LineCode] = u; });
    var all = rows.map(function (r) {
      var key = (r.VehicleTypeID || '') + '|' + r.LineCode;
      if (byCode[key]) return byCode[key];
      var row = {};
      SCHEMA.PLLineItems.forEach(function (h) { row[h] = r[h] === undefined || r[h] === null ? '' : r[h]; });
      return row;
    });
    rewriteTable_(SHEETS.PL_LINE_ITEMS, all);
  }

  if (materializeCharts) {
    getVehicleTypes().forEach(function (t) { ensureTypeChart_(t.VehicleTypeID); });
  }
  seedParamDefs_();
}

/** 整張表換成 rows(依 SCHEMA 欄序)。給一次性的資料升級用 */
function rewriteTable_(sheetName, rows) {
  var sheet = getSheet_(sheetName);
  var headers = SCHEMA[sheetName];
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  if (rows.length) {
    var range = sheet.getRange(2, 1, rows.length, headers.length);
    applyTextColumnFormats_(range, headers, sheetName);
    range.setValues(rows.map(function (r) { return headers.map(function (h) { return r[h] === undefined ? '' : r[h]; }); }));
  }
  invalidateSheetCache_(sheetName);
}

/* ---------------------------------------------------------------
 * 科目代碼/排序
 * ------------------------------------------------------------- */

/** 父科目字首：內建四段沿用 b/d/f/h，其他自訂群組用父科目代碼小寫，頂層科目用 S */
function lineCodePrefixFor_(parentLine) {
  if (LINE_CODE_PREFIX[parentLine]) return LINE_CODE_PREFIX[parentLine];
  if (!parentLine) return 'S';
  return String(parentLine).toLowerCase().replace(/[^a-z0-9]/g, '') + '_';
}

/** 下一個可用的科目代碼(同一個車型內唯一) */
function nextLineCode_(parentLine, vehicleTypeId) {
  var prefix = lineCodePrefixFor_(parentLine);
  var used = {};
  getPLLineItems(vehicleTypeId).forEach(function (d) { used[d.LineCode] = true; });
  var n = 1;
  while (used[prefix + n]) n++;
  return prefix + n;
}

/** 新科目排在同一段的最後面 */
function nextSortOrder_(parentLine, vehicleTypeId) {
  var defs = getPLLineItems(vehicleTypeId);
  var maxSort = 0;
  defs.forEach(function (d) { if (d.ParentLine === parentLine) maxSort = Math.max(maxSort, toNumber_(d.SortOrder)); });
  if (!maxSort) {
    var parent = defs.filter(function (d) { return d.LineCode === parentLine; })[0];
    maxSort = parent ? toNumber_(parent.SortOrder) : 90;
  }
  return maxSort + 0.5;
}

function newLineItemRow_(parentLine, lineName, vehicleTypeId) {
  var code = nextLineCode_(parentLine, vehicleTypeId);
  return {
    LineID: lineIdOf_(vehicleTypeId, code),
    VehicleTypeID: vehicleTypeId || '',
    LineCode: code,
    LineName: lineName,
    ParentLine: parentLine || '',
    Category: COST_SECTION_PARENTS.indexOf(parentLine) !== -1 ? '成本明細' : (parentLine ? '費用明細' : '自訂'),
    SortOrder: nextSortOrder_(parentLine, vehicleTypeId),
    CalcType: CALC_TYPES.INPUT,
    Formula: '', VehicleFormulas: '', AutoSource: '', CommodityTaxDeduct: '', DevAmortCategory: '', Description: ''
  };
}

/** 一個科目的手動輸入金額存在哪一頁：銷貨成本(B 段，含 B 底下的子群組)或營業費用 */
function isCostSectionLine_(def, defs) {
  var byCode = {};
  defs.forEach(function (d) { byCode[d.LineCode] = d; });
  var cur = def, guard = 0;
  while (cur && cur.ParentLine && guard++ < 20) {
    if (COST_SECTION_PARENTS.indexOf(cur.ParentLine) !== -1) return true;
    cur = byCode[cur.ParentLine];
  }
  return false;
}

/* ---------------------------------------------------------------
 * 給手動輸入頁面/開發總投頁面的科目選項
 * ------------------------------------------------------------- */

function inputLineOptions_(vehicleTypeId, costSection) {
  var defs = getPLLineItems(vehicleTypeId);
  return defs.filter(function (d) {
    return d.CalcType === CALC_TYPES.INPUT && isCostSectionLine_(d, defs) === costSection;
  }).map(function (d) { return { value: d.LineCode, label: d.LineCode + ' ' + d.LineName, parentLine: d.ParentLine }; });
}
/** 銷貨成本頁的成本項目(B 段底下、手動輸入) */
function getCostOfSalesLineOptions(vehicleTypeId) { return inputLineOptions_(vehicleTypeId, true); }
/** 營業費用頁的科目(B 段以外、手動輸入，含 J 前瞻費用) */
function getOperatingExpenseLineOptions(vehicleTypeId) { return inputLineOptions_(vehicleTypeId, false); }

/** 開發總投「攤提落點」選項：計算來源是開發總投攤提的科目 */
function getDevAmortTargetOptions(vehicleTypeId) {
  return getPLLineItems(vehicleTypeId)
    .filter(function (d) { return d.CalcType === CALC_TYPES.DEV_AMORT; })
    .map(function (d) {
      return { value: d.LineCode, label: d.LineName, parentLine: d.ParentLine, category: d.DevAmortCategory || '' };
    });
}

/* ---------------------------------------------------------------
 * 新增/修改/刪除科目
 * ------------------------------------------------------------- */

/** 在銷貨成本/營業費用頁面直接新增手動輸入科目 */
function addLineItemInline(parentLine, lineName, vehicleTypeId) {
  return withLock_(function () {
    if (!lineName) throw new Error('請輸入科目名稱');
    ensureTypeChart_(vehicleTypeId);
    return upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineID', newLineItemRow_(parentLine, lineName, vehicleTypeId));
  });
}

/** 在開發總投頁面直接新增攤提落點科目(設備/模具 → B 段，費用 → G 段) */
function addDevAmortLineItem(category, lineName, vehicleTypeId) {
  return withLock_(function () {
    if (!lineName) throw new Error('請輸入科目名稱');
    var parentLine = DEV_AMORT_CATEGORY_PARENT[category];
    if (!parentLine) throw new Error('大類不正確：' + (category || '(未選擇)'));
    ensureTypeChart_(vehicleTypeId);
    var row = newLineItemRow_(parentLine, lineName, vehicleTypeId);
    row.CalcType = CALC_TYPES.DEV_AMORT;
    row.AutoSource = AUTO_SOURCE.DEV_AMORT;
    row.DevAmortCategory = category;
    return upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineID', row);
  });
}

/**
 * 儲存一個科目(科目設定頁的明細編輯器)。沒有 LineCode 就是新增。
 * 存檔前檢查：公式語法、引用到不存在的科目/名稱、循環引用 —— 擋在存檔這一步，
 * 不要讓一個打錯的公式把整張損益表弄壞。
 */
function saveChartLine(vehicleTypeId, line) {
  return withLock_(function () {
    ensureTypeChart_(vehicleTypeId);
    var defs = getPLLineItems(vehicleTypeId);
    var existing = line.LineCode ? defs.filter(function (d) { return d.LineCode === line.LineCode; })[0] : null;
    if (line.LineCode && !existing) throw new Error('找不到科目：' + line.LineCode);
    if (!String(line.LineName || '').trim()) throw new Error('科目名稱為必填');

    var row = existing ? copyLineRow_(existing, vehicleTypeId) : newLineItemRow_(line.ParentLine || '', line.LineName, vehicleTypeId);
    ['LineName', 'ParentLine', 'Category', 'CalcType', 'Formula', 'CommodityTaxDeduct', 'DevAmortCategory', 'Description']
      .forEach(function (f) { if (line[f] !== undefined) row[f] = line[f] === null ? '' : line[f]; });
    row.LineName = String(row.LineName).trim();
    if (!CALC_TYPES[row.CalcType]) throw new Error('計算來源不正確：' + row.CalcType);
    // 公式可以用 [科目名稱] 寫(畫面上就是這樣顯示的)，存檔時一律換成科目代碼：
    // 代碼不會變，之後科目改名也不會讓公式斷掉
    var normalize = function (f) { return codifyFormulaNames_(cleanFormulaText_(f), defs); };
    if (line.VehicleFormulas !== undefined) {
      var vf = parseVehicleFormulas_(line.VehicleFormulas);
      var cleaned = {};
      Object.keys(vf).forEach(function (k) { if (String(vf[k] || '').trim()) cleaned[k] = normalize(vf[k]); });
      row.VehicleFormulas = Object.keys(cleaned).length ? JSON.stringify(cleaned) : '';
    }
    row.Formula = row.CalcType === CALC_TYPES.FORMULA ? normalize(row.Formula) : '';
    if (row.CalcType === CALC_TYPES.FORMULA && !row.Formula) throw new Error('請輸入公式');
    if (row.CalcType === CALC_TYPES.DEV_AMORT && !row.DevAmortCategory) {
      row.DevAmortCategory = row.ParentLine === 'G' ? '費用' : '模具';
    }
    if (row.CalcType === CALC_TYPES.DEV_AMORT && !row.AutoSource) row.AutoSource = AUTO_SOURCE.DEV_AMORT;
    if (row.CalcType !== CALC_TYPES.DEV_AMORT && DEV_AMORT_AUTO_SOURCES.indexOf(row.AutoSource) !== -1) row.AutoSource = '';
    if (existing && PROTECTED_LINE_CODES.indexOf(existing.LineCode) !== -1 && row.ParentLine !== existing.ParentLine) {
      throw new Error('「' + existing.LineName + '」是損益結構科目，不能移到別的父科目底下');
    }
    if (row.ParentLine && row.ParentLine === row.LineCode) throw new Error('科目不能當自己的父科目');
    if (row.ParentLine && !defs.some(function (d) { return d.LineCode === row.ParentLine; })) {
      throw new Error('父科目不存在：' + row.ParentLine);
    }
    if (!existing) {
      // 新增時父科目可能換過，代碼與排序要照最後的父科目重新配
      var fresh = newLineItemRow_(row.ParentLine, row.LineName, vehicleTypeId);
      row.LineCode = fresh.LineCode; row.LineID = fresh.LineID; row.SortOrder = fresh.SortOrder;
      if (!line.Category) row.Category = fresh.Category;
    } else if (row.ParentLine !== existing.ParentLine) {
      row.SortOrder = nextSortOrder_(row.ParentLine, vehicleTypeId);
    }

    // 改名：其他公式裡還用舊名稱 [舊名稱] 引用這個科目的(舊資料、或直接寫在車系個別公式裡的)，一併換成代碼
    var renamed = [];
    if (existing && existing.LineName !== row.LineName) {
      defs.forEach(function (d) {
        if (d.LineCode === row.LineCode) return;
        var changed = false;
        var r2 = copyLineRow_(d, vehicleTypeId);
        var fix = function (f) {
          var out = replaceNameRef_(f, existing.LineName, row.LineCode);
          if (out !== f) changed = true;
          return out;
        };
        if (r2.Formula) r2.Formula = fix(r2.Formula);
        var vf2 = parseVehicleFormulas_(r2.VehicleFormulas);
        Object.keys(vf2).forEach(function (k) { vf2[k] = fix(vf2[k]); });
        if (Object.keys(vf2).length) r2.VehicleFormulas = JSON.stringify(vf2);
        if (changed) renamed.push(r2);
      });
    }

    var touched = {};
    renamed.forEach(function (r) { touched[r.LineCode] = r; });
    var nextDefs = defs.filter(function (d) { return d.LineCode !== row.LineCode; })
      .map(function (d) { return touched[d.LineCode] ? normalizeLineDef_(touched[d.LineCode]) : d; })
      .concat([normalizeLineDef_(row)]);
    var problems = chartProblems_(nextDefs, vehicleTypeId).filter(function (p) { return p.level === 'error'; });
    if (problems.length) throw new Error(problems.map(function (p) { return p.message; }).join('\n'));

    if (renamed.length) batchWriteRows_(SHEETS.PL_LINE_ITEMS, 'LineID', renamed, []);
    upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineID', row);
    return { line: normalizeLineDef_(row), editor: getChartEditor(vehicleTypeId, line.__scenarioId || '') };
  });
}

/** 整批儲存(舊介面相容：科目設定表格一次送出) */
function savePLLineItemGrid(rows, vehicleTypeId) {
  return withLock_(function () {
    ensureTypeChart_(vehicleTypeId);
    (rows || []).forEach(function (r) {
      if (!r.LineCode && !r.LineName) return;
      var defs = getPLLineItems(vehicleTypeId);
      var existing = r.LineCode ? defs.filter(function (d) { return d.LineCode === r.LineCode; })[0] : null;
      if (!r.LineName) throw new Error('科目名稱為必填');
      var row;
      if (existing) {
        row = copyLineRow_(existing, vehicleTypeId);
        row.LineName = r.LineName;
        if (r.Category !== undefined) row.Category = r.Category;
        if (r.SortOrder !== undefined && r.SortOrder !== '') row.SortOrder = toNumber_(r.SortOrder);
        if (r.ParentLine !== undefined && PROTECTED_LINE_CODES.indexOf(existing.LineCode) === -1 &&
            existing.CalcType === CALC_TYPES.INPUT) row.ParentLine = r.ParentLine;
      } else {
        row = newLineItemRow_(r.ParentLine, r.LineName, vehicleTypeId);
        if (r.Category) row.Category = r.Category;
        if (r.SortOrder !== '' && r.SortOrder !== undefined && r.SortOrder !== null) row.SortOrder = toNumber_(r.SortOrder);
      }
      upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineID', row);
    });
    return getPLLineItems(vehicleTypeId);
  });
}
function savePLLineItem(rowObj) {
  return savePLLineItemGrid([rowObj], rowObj.VehicleTypeID || '')[0];
}

/** 公式裡明確引用某個科目代碼的科目 */
function lineReferencedBy_(defs, lineCode) {
  return defs.filter(function (d) {
    if (d.LineCode === lineCode) return false;
    var formulas = [d.CalcType === CALC_TYPES.FORMULA ? d.Formula : ''];
    var vf = parseVehicleFormulas_(d.VehicleFormulas);
    Object.keys(vf).forEach(function (k) { formulas.push(vf[k]); });
    return formulas.some(function (f) {
      if (!f) return false;
      var info = inspectFormula_(f);
      if (!info.ok) return false;
      if (info.refs.codes.indexOf(lineCode) !== -1) return true;
      var target = defs.filter(function (x) { return x.LineCode === lineCode; })[0];
      return target && info.refs.names.indexOf(target.LineName) !== -1;
    });
  });
}

/**
 * 刪除科目，連同這個車型所有情境裡該科目已輸入的金額/說明。
 * 擋下來的情況：損益結構科目、還有其他科目公式引用它、還有子科目、還有開發總投列攤提到這裡。
 */
function deletePLLineItem(lineCode, vehicleTypeId) {
  return withLock_(function () {
    ensureTypeChart_(vehicleTypeId);
    if (PROTECTED_LINE_CODES.indexOf(lineCode) !== -1) {
      throw new Error('「' + lineCode + '」是損益結構科目(小計/毛利/淨利)，儀表板與報告都要用到，不可刪除。');
    }
    var defs = getPLLineItems(vehicleTypeId);
    var def = defs.filter(function (d) { return d.LineCode === lineCode; })[0];
    if (!def) return false;
    var users = lineReferencedBy_(defs, lineCode);
    if (users.length) {
      throw new Error('「' + def.LineName + '」被這些科目的公式引用：' +
        users.map(function (u) { return u.LineName; }).join('、') + '。請先修改那些公式再刪除。');
    }
    var kids = defs.filter(function (d) { return d.ParentLine === lineCode; });
    if (kids.length) {
      throw new Error('「' + def.LineName + '」底下還有 ' + kids.length + ' 個子科目，請先把子科目移走或刪除。');
    }
    var scenarioIds = {};
    getScenarios(vehicleTypeId || undefined).forEach(function (s) { scenarioIds[s.ScenarioID] = true; });
    var inScope = function (r) { return vehicleTypeId ? scenarioIds[r.ScenarioID] : true; };
    if (def.CalcType === CALC_TYPES.DEV_AMORT) {
      var used = (sheetToObjects_(SHEETS.DEV_INVESTMENT) || []).filter(function (r) {
        return inScope(r) && devAmortTargetOf_(r) === lineCode;
      });
      if (used.length) {
        throw new Error('「' + def.LineName + '」在「開發總投」還有 ' + used.length +
          ' 筆資料指到這個攤提落點，請先把那些列改選別的攤提落點或刪除，才能刪除這個科目。');
      }
    }
    [SHEETS.COST_OF_SALES, SHEETS.OPERATING_EXPENSE, SHEETS.LINE_NOTES].forEach(function (sheetName) {
      var pks = (sheetToObjects_(sheetName) || []).filter(function (r) { return r.LineCode === lineCode && inScope(r); })
        .map(function (r) { return r.RowID; });
      if (pks.length) batchWriteRows_(sheetName, 'RowID', [], pks);
    });
    return deleteRow_(SHEETS.PL_LINE_ITEMS, 'LineID', def.LineID || lineIdOf_(vehicleTypeId, lineCode));
  });
}
/** 舊介面：銷貨成本/營業費用頁的「刪除」 */
function deleteLineItemInline(lineCode, vehicleTypeId) { return deletePLLineItem(lineCode, vehicleTypeId); }

/**
 * 調整科目順序/層級(科目設定頁拖曳後一次送出)。
 * items = [{LineCode, ParentLine}]，依陣列順序重新編排序值；結構科目不能換父科目。
 */
function setLineOrder(vehicleTypeId, items) {
  return withLock_(function () {
    ensureTypeChart_(vehicleTypeId);
    var defs = getPLLineItems(vehicleTypeId);
    var byCode = {};
    defs.forEach(function (d) { byCode[d.LineCode] = d; });
    var seen = {};
    var upserts = [];
    (items || []).forEach(function (it, i) {
      var d = byCode[it.LineCode];
      if (!d || seen[it.LineCode]) return;
      seen[it.LineCode] = true;
      var row = copyLineRow_(d, vehicleTypeId);
      row.SortOrder = (i + 1) * 10;
      if (it.ParentLine !== undefined && it.ParentLine !== d.ParentLine) {
        if (PROTECTED_LINE_CODES.indexOf(d.LineCode) !== -1) throw new Error('「' + d.LineName + '」是損益結構科目，不能換父科目');
        if (it.ParentLine && !byCode[it.ParentLine]) throw new Error('父科目不存在：' + it.ParentLine);
        if (it.ParentLine === d.LineCode) throw new Error('科目不能當自己的父科目');
        row.ParentLine = it.ParentLine;
      }
      upserts.push(row);
    });
    // 沒出現在 items 裡的科目排到最後，維持原本相對順序
    var n = upserts.length;
    defs.forEach(function (d) {
      if (seen[d.LineCode]) return;
      var row = copyLineRow_(d, vehicleTypeId);
      row.SortOrder = (++n) * 10;
      upserts.push(row);
    });
    var problems = chartProblems_(upserts.map(normalizeLineDef_), vehicleTypeId).filter(function (p) { return p.level === 'error'; });
    if (problems.length) throw new Error(problems.map(function (p) { return p.message; }).join('\n'));
    batchWriteRows_(SHEETS.PL_LINE_ITEMS, 'LineID', upserts, []);
    return getPLLineItems(vehicleTypeId);
  });
}

/**
 * 把車型的科目表換成另一份(標準範本或另一個車型)。
 * 代碼相同的科目沿用(已輸入的金額照樣對得到)；新科目表沒有的科目，金額留著但不會被計入，畫面會列出提醒。
 */
function copyChartFromType(targetTypeId, sourceTypeId) {
  return withLock_(function () {
    if (!targetTypeId) throw new Error('請先選擇車型');
    if (sourceTypeId === targetTypeId) throw new Error('來源跟目標是同一個車型');
    var source = sourceTypeId ? getPLLineItems(sourceTypeId) : getTemplateLineItems_();
    var oldPks = allLineItemRows_().filter(function (r) { return r.VehicleTypeID === targetTypeId; })
      .map(function (r) { return r.LineID; });
    var rows = source.map(function (d) { return copyLineRow_(d, targetTypeId); });
    batchWriteRows_(SHEETS.PL_LINE_ITEMS, 'LineID', rows, oldPks);
    return getChartEditor(targetTypeId, '');
  });
}

/** 把這個車型的科目表存成標準範本(之後新建的車型預設複製這一份) */
function saveChartAsTemplate(vehicleTypeId) {
  return withLock_(function () {
    if (!vehicleTypeId) throw new Error('請先選擇車型');
    var source = getPLLineItems(vehicleTypeId);
    var oldPks = allLineItemRows_().filter(function (r) { return !r.VehicleTypeID; }).map(function (r) { return r.LineID; });
    var rows = source.map(function (d) { var r = copyLineRow_(d, ''); r.VehicleFormulas = ''; return r; });
    batchWriteRows_(SHEETS.PL_LINE_ITEMS, 'LineID', rows, oldPks);
    return getTemplateLineItems_().length;
  });
}

/** 把內建科目的名稱/公式/位置回復成系統預設值(自訂科目不受影響) */
function restoreBuiltInLineItems(vehicleTypeId) {
  return withLock_(function () {
    ensureTypeChart_(vehicleTypeId);
    var current = {};
    getPLLineItems(vehicleTypeId).forEach(function (d) { current[d.LineCode] = d; });
    var upserts = PL_LINE_ITEMS.map(function (line) {
      var row = copyLineRow_(line, vehicleTypeId);
      if (current[line.LineCode]) row.VehicleFormulas = current[line.LineCode].VehicleFormulas || '';
      return row;
    });
    batchWriteRows_(SHEETS.PL_LINE_ITEMS, 'LineID', upserts, []);
    return getPLLineItems(vehicleTypeId);
  });
}

/* ---------------------------------------------------------------
 * 公式檢查
 * ------------------------------------------------------------- */

/** 公式可以用的 [名稱]：系統變數、參數、匯率、科目名稱 */
function formulaNameCatalog_(defs) {
  var params = getParamDefs();
  return {
    variables: SYSTEM_VARIABLES.map(function (v) { return v.name; }),
    params: params.map(function (p) { return p.ParamName; }),
    lineNames: defs.map(function (d) { return d.LineName; })
  };
}

function isKnownFormulaName_(name, catalog) {
  if (catalog.variables.indexOf(name) !== -1 || catalog.params.indexOf(name) !== -1) return true;
  if (catalog.lineNames.indexOf(name) !== -1) return true;
  return /^[A-Za-z]{3}匯率$/.test(name);
}

/**
 * 檢查整張科目表：公式語法、引用不存在的科目/名稱、循環引用(error)，
 * 以及「這個科目的金額沒有被任何小計算進去」(warning) —— 公式可以自由改之後最容易犯的錯，
 * 就是加了科目卻沒有任何小計把它加進去，損益表上看得到這個數字、營業淨利卻沒扣。
 */
function chartProblems_(defs, vehicleTypeId) {
  var problems = [];
  var byCode = {};
  defs.forEach(function (d) { byCode[d.LineCode] = d; });
  var catalog = formulaNameCatalog_(defs);
  var deps = {};

  defs.forEach(function (d) {
    var formulas = [];
    if (d.CalcType === CALC_TYPES.FORMULA) formulas.push({ f: d.Formula, who: '' });
    var vf = parseVehicleFormulas_(d.VehicleFormulas);
    Object.keys(vf).forEach(function (k) { formulas.push({ f: vf[k], who: k }); });
    deps[d.LineCode] = [];
    formulas.forEach(function (item) {
      var label = '「' + d.LineName + '」' + (item.who ? '(車系 ' + item.who + ' 個別公式)' : '');
      var info = inspectFormula_(item.f);
      if (!info.ok) { problems.push({ level: 'error', code: d.LineCode, message: label + '公式錯誤：' + info.error }); return; }
      info.refs.codes.forEach(function (c) {
        if (!byCode[c]) problems.push({ level: 'error', code: d.LineCode, message: label + '引用了不存在的科目代碼 ' + c });
        else deps[d.LineCode].push(c);
      });
      info.refs.names.forEach(function (n) {
        if (!isKnownFormulaName_(n, catalog)) {
          problems.push({ level: 'error', code: d.LineCode, message: label + '的 [' + n + '] 不是系統變數、參數，也不是科目名稱' });
          return;
        }
        var target = defs.filter(function (x) { return x.LineName === n; })[0];
        if (target && catalog.variables.indexOf(n) === -1 && catalog.params.indexOf(n) === -1) deps[d.LineCode].push(target.LineCode);
      });
      if (info.refs.calls.indexOf('CHILDREN') !== -1) {
        defs.forEach(function (x) { if (x.ParentLine === d.LineCode) deps[d.LineCode].push(x.LineCode); });
      }
      if (info.refs.calls.indexOf('TAXDEDUCT') !== -1) {
        defs.forEach(function (x) { if (String(x.CommodityTaxDeduct).toUpperCase() === 'Y') deps[d.LineCode].push(x.LineCode); });
      }
    });
  });

  // 循環引用：DFS
  var state = {};
  var cycles = [];
  function visit(code, path) {
    if (state[code] === 2) return;
    if (state[code] === 1) {
      var start = path.indexOf(code);
      cycles.push(path.slice(start).concat([code]));
      return;
    }
    state[code] = 1;
    (deps[code] || []).forEach(function (c) { visit(c, path.concat([code])); });
    state[code] = 2;
  }
  defs.forEach(function (d) { visit(d.LineCode, []); });
  cycles.forEach(function (cyc) {
    problems.push({
      level: 'error', code: cyc[0],
      message: '循環引用：' + cyc.map(function (c) { return byCode[c] ? byCode[c].LineName : c; }).join(' → ') + '（公式互相引用，算不出結果）'
    });
  });

  // 沒有被算進營業淨利的科目
  if (byCode.K) {
    var reach = {};
    (function mark(code) {
      if (reach[code]) return;
      reach[code] = true;
      (deps[code] || []).forEach(mark);
    })('K');
    defs.forEach(function (d) {
      if (reach[d.LineCode] || d.Category === '售價結構') return;
      if (d.ParentLine && !reach[d.ParentLine]) return;   // 父科目已經會被提醒，不重複
      problems.push({
        level: 'warning', code: d.LineCode,
        message: '「' + d.LineName + '」沒有被任何小計算進營業淨利(父科目的公式沒有用 CHILDREN()，也沒有其他公式引用它)'
      });
    });
  }
  return problems;
}

/**
 * 科目設定頁的資料：科目表、參數與變數清單、檢查結果，以及目前情境各車系的試算值(邊改邊看)。
 */
function getChartEditor(vehicleTypeId, scenarioId) {
  var defs = getPLLineItems(vehicleTypeId);
  var vehicles = vehicleTypeId ? getVehicles(vehicleTypeId).map(function (v) {
    return { VehicleID: v.VehicleID, VehicleCode: v.VehicleCode || '' };
  }) : [];
  var preview = null;
  if (scenarioId && vehicleTypeOfScenario_(scenarioId) === vehicleTypeId) {
    preview = chartPreviewValues_(scenarioId, vehicles, null);
  }
  var usage = lineUsageCounts_(vehicleTypeId);
  return {
    vehicleTypeId: vehicleTypeId || '',
    ownChart: hasOwnChart_(vehicleTypeId),
    lines: defs.map(function (d) {
      var out = {};
      Object.keys(d).forEach(function (k) { out[k] = d[k]; });
      out.VehicleFormulas = parseVehicleFormulas_(d.VehicleFormulas);
      out.isProtected = PROTECTED_LINE_CODES.indexOf(d.LineCode) !== -1;
      out.isDefaultFormula = d.CalcType === CALC_TYPES.FORMULA && DEFAULT_FORMULAS[d.LineCode] === d.Formula;
      out.usage = usage[d.LineCode] || 0;
      return out;
    }),
    vehicles: vehicles,
    variables: SYSTEM_VARIABLES,
    params: getParamDefs(),
    calcTypeLabels: CALC_TYPE_LABELS,
    devCategories: DEV_AMORT_CATEGORIES,
    problems: chartProblems_(defs, vehicleTypeId),
    preview: preview,
    otherTypes: getVehicleTypes().map(function (t) { return t.VehicleTypeID; }).filter(function (id) { return id !== vehicleTypeId; }),
    referenceScenarios: getScenarios().map(function (s) {
      return { ScenarioID: s.ScenarioID, label: [s.VehicleTypeID, s.Gate, s.ScenarioName].filter(function (x) { return x; }).join(' ') };
    })
  };
}

/** 每個科目在這個車型的情境裡有幾筆手動輸入金額(刪科目前提醒用) */
function lineUsageCounts_(vehicleTypeId) {
  var ids = {};
  getScenarios(vehicleTypeId || undefined).forEach(function (s) { ids[s.ScenarioID] = true; });
  var counts = {};
  [SHEETS.COST_OF_SALES, SHEETS.OPERATING_EXPENSE].forEach(function (name) {
    (sheetToObjects_(name) || []).forEach(function (r) {
      if (!ids[r.ScenarioID] || r.Amount === '' || r.Amount === undefined) return;
      counts[r.LineCode] = (counts[r.LineCode] || 0) + 1;
    });
  });
  return counts;
}

/** 目前情境各車系的科目值；overrideDefs 有值時用改到一半(還沒存)的科目表試算 */
function chartPreviewValues_(scenarioId, vehicles, overrideDefs) {
  var mix = {};
  getSalesMix(scenarioId).forEach(function (r) { mix[r.VehicleID] = true; });
  var out = { scenarioId: scenarioId, values: {}, errors: {}, traces: {}, weights: {} };
  getSalesMix(scenarioId).forEach(function (r) { out.weights[r.VehicleID] = toNumber_(r.SalesMixPct); });
  vehicles.forEach(function (v) {
    if (!mix[v.VehicleID]) return;
    try {
      var res = overrideDefs ? calculatePLWithDefs_(scenarioId, v.VehicleID, overrideDefs) : calculatePLCore_(scenarioId, v.VehicleID);
      out.values[v.VehicleID] = res.lineValues;
      out.errors[v.VehicleID] = res.errors;
      out.traces[v.VehicleID] = res.traces;
    } catch (e) {
      out.errors[v.VehicleID] = { '*': e.message };
    }
  });
  return out;
}

/**
 * 科目設定頁「邊打公式邊看結果」：用畫面上還沒存的那一個科目試算，不寫入任何資料。
 * 回傳每個車系的結果與錯誤；公式本身有問題時回傳 problems。
 */
function previewLineFormula(vehicleTypeId, scenarioId, line) {
  var defs = getPLLineItems(vehicleTypeId);
  var patched = defs.map(function (d) {
    if (d.LineCode !== line.LineCode) return d;
    var p = {};
    Object.keys(d).forEach(function (k) { p[k] = d[k]; });
    ['CalcType', 'Formula', 'CommodityTaxDeduct', 'ParentLine'].forEach(function (f) { if (line[f] !== undefined) p[f] = line[f]; });
    if (line.VehicleFormulas !== undefined) p.VehicleFormulas = JSON.stringify(parseVehicleFormulas_(line.VehicleFormulas));
    return p;
  });
  var problems = chartProblems_(patched, vehicleTypeId).filter(function (p) { return p.code === line.LineCode && p.level === 'error'; });
  if (problems.length || !scenarioId) return { problems: problems, preview: null };
  var vehicles = getVehicles(vehicleTypeId).map(function (v) { return { VehicleID: v.VehicleID, VehicleCode: v.VehicleCode || '' }; });
  return { problems: [], preview: chartPreviewValues_(scenarioId, vehicles, patched) };
}

/* ---------------------------------------------------------------
 * 參數定義(稅率/費率之外，使用者可以自己加參數給公式用)
 * ------------------------------------------------------------- */

function seedParamDefs_() {
  var existing = indexByPk_(sheetToObjects_(SHEETS.PARAM_DEFS) || [], 'ParamName');
  var add = [];
  TAX_RATE_PARAM_NAMES.forEach(function (name, i) {
    if (existing[name]) return;
    add.push({ ParamName: name, Unit: BUILTIN_PARAM_UNITS[name] || '%', DefaultValue: DEFAULT_PARAMS[name], Description: '內建參數', SortOrder: i + 1 });
  });
  if (add.length) batchWriteRows_(SHEETS.PARAM_DEFS, 'ParamName', add, []);
}

function getParamDefs() {
  var rows = sortByOrder_(sheetToObjects_(SHEETS.PARAM_DEFS) || [], 'SortOrder');
  var names = rows.map(function (r) { return r.ParamName; });
  // 還沒跑過資料升級(例如 Node 驗算直接呼叫)時，內建參數仍然要在
  TAX_RATE_PARAM_NAMES.forEach(function (name) {
    if (names.indexOf(name) === -1) rows.push({ ParamName: name, Unit: '%', DefaultValue: DEFAULT_PARAMS[name], Description: '內建參數', SortOrder: '' });
  });
  return rows.map(function (r) {
    return {
      ParamName: r.ParamName, Unit: r.Unit || '%',
      DefaultValue: r.DefaultValue === undefined ? '' : r.DefaultValue,
      Description: r.Description || '', SortOrder: r.SortOrder,
      isBuiltIn: TAX_RATE_PARAM_NAMES.indexOf(r.ParamName) !== -1
    };
  });
}

/** 新增/修改參數定義；內建參數只能改說明 */
function saveParamDef(def) {
  return withLock_(function () {
    var name = String(def.ParamName || '').trim();
    if (!name) throw new Error('請輸入參數名稱');
    if (/[\[\]"]/.test(name)) throw new Error('參數名稱不能包含 [ ] 或引號');
    if (FX_PARAM_NAMES.indexOf(name) !== -1) throw new Error('「' + name + '」是匯率，請到匯率設定頁維護');
    if (SYSTEM_VARIABLES.some(function (v) { return v.name === name; })) throw new Error('「' + name + '」是系統變數名稱，請換一個名稱');
    var existing = indexByPk_(sheetToObjects_(SHEETS.PARAM_DEFS) || [], 'ParamName')[name];
    var isBuiltIn = TAX_RATE_PARAM_NAMES.indexOf(name) !== -1;
    var unit = isBuiltIn ? (BUILTIN_PARAM_UNITS[name] || '%') : (PARAM_UNITS.indexOf(def.Unit) !== -1 ? def.Unit : '%');
    var row = {
      ParamName: name, Unit: unit,
      DefaultValue: def.DefaultValue === '' || def.DefaultValue === undefined || def.DefaultValue === null ? '' : toNumber_(def.DefaultValue),
      Description: def.Description || '',
      SortOrder: existing ? existing.SortOrder : (getParamDefs().length + 1)
    };
    if (isBuiltIn) row.DefaultValue = DEFAULT_PARAMS[name];
    upsertRow_(SHEETS.PARAM_DEFS, 'ParamName', row);
    return getParamDefs();
  });
}

function deleteParamDef(name) {
  return withLock_(function () {
    if (TAX_RATE_PARAM_NAMES.indexOf(name) !== -1) throw new Error('內建參數不能刪除');
    var usedBy = [];
    var seen = {};
    allLineItemRows_().map(normalizeLineDef_).forEach(function (d) {
      var fs = [d.Formula];
      var vf = parseVehicleFormulas_(d.VehicleFormulas);
      Object.keys(vf).forEach(function (k) { fs.push(vf[k]); });
      if (fs.some(function (f) { var i = f ? inspectFormula_(f) : null; return i && i.ok && i.refs.names.indexOf(name) !== -1; })) {
        var label = (d.VehicleTypeID || '範本') + ' ' + d.LineName;
        if (!seen[label]) { seen[label] = true; usedBy.push(label); }
      }
    });
    if (usedBy.length) throw new Error('參數「' + name + '」被這些科目的公式使用：' + usedBy.join('、'));
    var pks = (sheetToObjects_(SHEETS.PARAMETERS) || []).filter(function (p) { return p.ParamName === name; })
      .map(function (p) { return p.ParamID; });
    if (pks.length) batchWriteRows_(SHEETS.PARAMETERS, 'ParamID', [], pks);
    deleteRow_(SHEETS.PARAM_DEFS, 'ParamName', name);
    return getParamDefs();
  });
}

/** 參數的值(給公式用)：% 單位自動換算成小數 */
function paramValueForFormula_(params, def, vehicleId) {
  var raw;
  var has = params.some(function (p) { return p.ParamName === def.ParamName && (!p.VehicleID || p.VehicleID === vehicleId); });
  if (has) raw = lookupParam_(params, def.ParamName, vehicleId);
  else if (def.DefaultValue !== '' && def.DefaultValue !== undefined) raw = toNumber_(def.DefaultValue);
  else raw = DEFAULT_PARAMS[def.ParamName] !== undefined ? DEFAULT_PARAMS[def.ParamName] : 0;
  return def.Unit === '%' ? raw / 100 : raw;
}

/* ---------------------------------------------------------------
 * 科目說明(報告/簡報的「說明」欄)
 * ------------------------------------------------------------- */

/**
 * 某情境的科目說明 { LineCode: 說明 }。沒有另外寫說明的科目，沿用銷貨成本/營業費用頁的備註，
 * 這樣以前填過的備註不必重打一次就會出現在報告上。
 */
function getLineNotes(scenarioId) {
  var notes = {};
  [SHEETS.COST_OF_SALES, SHEETS.OPERATING_EXPENSE].forEach(function (name) {
    (sheetToObjects_(name) || []).forEach(function (r) {
      if (r.ScenarioID === scenarioId && r.Notes && !notes[r.LineCode]) notes[r.LineCode] = String(r.Notes);
    });
  });
  (sheetToObjects_(SHEETS.LINE_NOTES) || []).forEach(function (r) {
    if (r.ScenarioID === scenarioId && !r.VehicleID) notes[r.LineCode] = r.Notes === undefined ? '' : String(r.Notes);
  });
  return notes;
}

/** 儲存科目說明 notes = { LineCode: 說明 }(只送有改的也可以) */
function saveLineNotes(scenarioId, notes) {
  return withLock_(function () {
    if (!scenarioId) throw new Error('請先選擇情境');
    var existing = {};
    (sheetToObjects_(SHEETS.LINE_NOTES) || []).forEach(function (r) {
      if (r.ScenarioID === scenarioId && !r.VehicleID) existing[r.LineCode] = r;
    });
    var upserts = [];
    Object.keys(notes || {}).forEach(function (code) {
      var text = notes[code] === undefined || notes[code] === null ? '' : String(notes[code]);
      var row = existing[code];
      upserts.push({ RowID: row ? row.RowID : '', ScenarioID: scenarioId, LineCode: code, VehicleID: '', Notes: text });
    });
    if (upserts.length) batchWriteRows_(SHEETS.LINE_NOTES, 'RowID', upserts, []);
    return getLineNotes(scenarioId);
  });
}

/* ---------------------------------------------------------------
 * 改善作法(現況 → 目標的差距要靠哪些作法補起來)
 * ------------------------------------------------------------- */

function getActions(scenarioId) {
  return sortByOrder_((sheetToObjects_(SHEETS.ACTIONS) || []).filter(function (r) { return r.ScenarioID === scenarioId; }), 'SortOrder')
    .map(function (r) {
      return {
        ActionID: r.ActionID, ScenarioID: r.ScenarioID, VehicleTypeID: r.VehicleTypeID || '',
        LineCode: r.LineCode || '', Title: r.Title || '', Detail: r.Detail || '', Owner: r.Owner || '',
        Effect: r.Effect === '' || r.Effect === undefined ? '' : toNumber_(r.Effect),
        Status: r.Status || ACTION_STATUSES[0], DueDate: r.DueDate || '', SortOrder: r.SortOrder
      };
    });
}

/** 整批儲存作法：依陣列順序編排序；作法名稱跟效果都空白的列視為刪除 */
function saveActions(scenarioId, rows) {
  return withLock_(function () {
    if (!scenarioId) throw new Error('請先選擇目標情境');
    var typeId = vehicleTypeOfScenario_(scenarioId);
    var keep = {};
    var upserts = [];
    (rows || []).forEach(function (r) {
      var empty = !String(r.Title || '').trim() && (r.Effect === '' || r.Effect === null || r.Effect === undefined);
      if (empty) return;
      var row = {
        ActionID: r.ActionID || '', VehicleTypeID: typeId, ScenarioID: scenarioId,
        LineCode: r.LineCode || '', Title: String(r.Title || '').trim(), Detail: r.Detail || '', Owner: r.Owner || '',
        Effect: r.Effect === '' || r.Effect === null || r.Effect === undefined ? '' : toNumber_(r.Effect),
        Status: ACTION_STATUSES.indexOf(r.Status) !== -1 ? r.Status : ACTION_STATUSES[0],
        DueDate: r.DueDate || '', SortOrder: upserts.length + 1
      };
      upserts.push(row);
      if (row.ActionID) keep[row.ActionID] = true;
    });
    var deletes = (sheetToObjects_(SHEETS.ACTIONS) || []).filter(function (r) {
      return r.ScenarioID === scenarioId && !keep[r.ActionID];
    }).map(function (r) { return r.ActionID; });
    batchWriteRows_(SHEETS.ACTIONS, 'ActionID', upserts, deletes);
    return getActions(scenarioId);
  });
}

/* ---------------------------------------------------------------
 * 排序(拖曳後一次送出完整順序，取代一格一格的上下移動鈕)
 * ------------------------------------------------------------- */

function setVehicleOrder(vehicleTypeId, vehicleIds) {
  return withLock_(function () {
    var vehicles = getVehicles(vehicleTypeId);
    var pos = {};
    (vehicleIds || []).forEach(function (id, i) { pos[id] = i; });
    var ordered = vehicles.slice().sort(function (a, b) {
      var pa = pos[a.VehicleID] === undefined ? 1e6 : pos[a.VehicleID];
      var pb = pos[b.VehicleID] === undefined ? 1e6 : pos[b.VehicleID];
      return pa - pb;
    });
    var upserts = ordered.map(function (v, i) {
      var row = {};
      SCHEMA.Vehicles.forEach(function (h) { row[h] = v[h] === undefined ? '' : v[h]; });
      row.SortOrder = i + 1;
      return row;
    });
    batchWriteRows_(SHEETS.VEHICLES, 'VehicleID', upserts, []);
    return getVehicles(vehicleTypeId);
  });
}

function setScenarioOrder(vehicleTypeId, scenarioIds) {
  return withLock_(function () {
    var scenarios = getScenarios(vehicleTypeId);
    var pos = {};
    (scenarioIds || []).forEach(function (id, i) { pos[id] = i; });
    var upserts = scenarios.map(function (s) {
      var row = {};
      SCHEMA.Scenarios.forEach(function (h) { row[h] = s[h] === undefined ? '' : s[h]; });
      row.SortOrder = pos[s.ScenarioID] === undefined ? 1e6 : pos[s.ScenarioID] + 1;
      return row;
    });
    batchWriteRows_(SHEETS.SCENARIOS, 'ScenarioID', upserts, []);
    return getScenarios(vehicleTypeId);
  });
}

/* ---------------------------------------------------------------
 * 建立車型(同時決定科目表從哪裡複製)
 * ------------------------------------------------------------- */

function createVehicleType(vehicleTypeId, notes, chartSourceTypeId) {
  return withLock_(function () {
    var id = String(vehicleTypeId || '').trim();
    if (!id) throw new Error('請輸入車型代號');
    if (getVehicleTypes().some(function (t) { return String(t.VehicleTypeID) === id; })) throw new Error('車型「' + id + '」已經存在');
    upsertRow_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', { VehicleTypeID: id, Notes: notes || '' });
    ensureTypeChart_(id, chartSourceTypeId || '');
    return getVehicleTypes();
  });
}
