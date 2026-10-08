/**
 * Excel 驗算檔：把一個情境的輸入數字與「科目與公式」頁建好的公式，原樣搬進 Excel。
 *
 * 損益表的每一格都是真的 Excel 公式(由系統公式逐一翻譯，不是貼數字)，引用「輸入」「開發總投」兩張表的格子，
 * 所以在 Excel 裡可以：
 *   1. 打開就看到 Excel 自己重算的結果，「驗算」頁逐格跟系統算出來的數字比對；
 *   2. 「公式區」並排列出每個科目的系統公式與翻譯後的 Excel 公式(FORMULATEXT)，一條一條核對算法；
 *   3. 改「輸入」頁的藍字試算，損益跟著重算(驗算頁會顯示跟匯出當時的差異)。
 *
 * 翻譯規則(跟 FormulaEngine.gs / CalcEngine.gs 的行為一致)：
 *   科目代碼、[科目名稱]     → 損益試算表同一個車系欄、那個科目的格子
 *   [系統變數]、[參數]、[XXX匯率] → 「輸入」表對應的格子(% 參數存成小數)
 *   CHILDREN() / TAXDEDUCT() → SUM(子科目 / 可扣除貨物稅科目的格子)
 *   a / b                   → 分母是固定數字時照寫；否則 IF(b=0,0,a/b)(系統的除以 0 = 0)
 *   比較式                  → 整格只有比較式時 ×1(系統成立 = 1、不成立 = 0)
 *   ROUND/ROUNDUP/ROUNDDOWN → 同名函式(少了位數補 0)；IF 少了第三個參數補 0
 *   REF(情境, 科目[, 車系])  → 「輸入」表「跨情境引用」那一列(另一個情境算出來的數字)
 *   手動輸入                → 「輸入」表的金額(外幣 × 匯率)
 *   開發總投攤提            → 「開發總投」表每一筆的單台攤提，依攤提落點 SUMIF
 */

var VERIFY_SHEETS_ = { info: '說明', input: '輸入', dev: '開發總投', pl: '損益試算', check: '驗算', formulas: '公式區',
  structure: '結構檢查', impact: '科目影響', changes: '變動檢查' };
// 輸入表與損益試算表的車系欄位從同一欄開始(D)，同一列的公式往右拉就是下一個車系
var VERIFY_FIRST_VEHICLE_COL_ = 3;

function verifySheetRef_(sheet, ref) { return "'" + sheet + "'!" + ref; }

/** 數字常數寫進公式：整數照寫，小數最多 15 位有效數字 */
function verifyNumText_(v) {
  if (!isFinite(v)) return '0';
  var s = String(v);
  if (/e/i.test(s)) s = Number(v).toPrecision(15).replace(/\.?0+(e)/i, '$1');
  return s;
}

/**
 * 公式 AST → 文字。mode = 'excel'：翻成 Excel 公式(ctx 提供各種引用的格子)；
 * mode = 'names'：系統公式的「可讀版」(科目代碼換成 [科目名稱]、REF 的情境換成名稱)，給公式區對照用。
 * 回傳 { t: 文字, p: 運算優先順序 }，只在需要時加括號。
 */
function verifyPrintAst_(node, ctx, mode) {
  var ATOM = 9;
  var wrap = function (x, min) { return x.p < min ? '(' + x.t + ')' : x.t; };
  var wrapR = function (x, min) { return x.p <= min || x.neg ? '(' + x.t + ')' : x.t; };
  var excel = mode === 'excel';
  var out = (function print(n) {
    switch (n.t) {
      case 'num': return { t: verifyNumText_(n.v), p: ATOM, isNum: true, v: n.v };
      case 'str': return { t: '"' + String(n.v).replace(/"/g, '""') + '"', p: ATOM };
      case 'code': return { t: excel ? ctx.code(n.v) : ctx.codeName(n.v), p: ATOM };
      case 'name': return { t: excel ? ctx.name(n.v) : '[' + n.v + ']', p: ATOM };
      case 'neg': {
        var a = print(n.a);
        return { t: '-' + (a.p < ATOM ? '(' + a.t + ')' : a.t), p: 4, neg: true };
      }
      case 'bin': {
        var l = print(n.a), r = print(n.b);
        var op = n.op;
        if (op === '+' || op === '-') return { t: wrap(l, 2) + op + wrapR(r, 2), p: 2 };
        if (op === '*') return { t: wrap(l, 3) + '*' + wrapR(r, 3), p: 3 };
        if (op === '/') {
          if (!excel || (r.isNum && r.v !== 0)) return { t: wrap(l, 3) + '/' + wrapR(r, 3), p: 3 };
          ctx.note('div');
          return { t: 'IF(' + wrap(r, 2) + '=0,0,' + wrap(l, 3) + '/' + wrapR(r, 3) + ')', p: ATOM };
        }
        if (op === '^') return { t: wrap(l, ATOM) + '^' + wrap(r, ATOM), p: 5 };
        return { t: wrap(l, 2) + op + wrap(r, 2), p: 1, cmp: true };
      }
      case 'call': {
        var name = n.name;
        if (name === 'CHILDREN' || name === 'TAXDEDUCT') {
          if (!excel) return { t: name + '()', p: ATOM };
          return { t: ctx.sumOf(name), p: ATOM };
        }
        if (name === 'REF') {
          if (!excel) return { t: ctx.refLabel(n.args), p: ATOM };
          return { t: ctx.ref(n.args), p: ATOM };
        }
        var args = n.args.map(function (a) { return print(a).t; });
        if (excel) {
          if (name === 'SUM' && !args.length) return { t: '0', p: ATOM, isNum: true, v: 0 };
          if ((name === 'ROUND' || name === 'ROUNDUP' || name === 'ROUNDDOWN') && args.length === 1) args.push('0');
          if (name === 'IF' && args.length === 2) args.push('0');
        }
        return { t: name + '(' + args.join(',') + ')', p: ATOM };
      }
    }
    throw formulaError_('無法轉換的公式片段');
  })(node);
  // 整格只有比較式時，Excel 會顯示 TRUE/FALSE；系統是 1/0
  if (excel && out.cmp) out = { t: '(' + out.t + ')*1', p: 3 };
  return out.t;
}

/** 公式區的「系統公式(用名稱)」：解析失敗就照原文 */
function verifyReadableFormula_(formula, defsByCode) {
  try {
    var ast = parseFormula_(formula);
    return '=' + verifyPrintAst_(ast, {
      codeName: function (c) { return defsByCode[c] ? '[' + defsByCode[c].LineName + ']' : c; },
      refLabel: function (args) {
        var parts = args.map(function (a) { return a.t === 'str' ? a.v : '?'; });
        var sc = null;
        try { sc = resolveRefScenario_(parts[0]); } catch (e) { sc = null; }
        var label = sc ? [sc.VehicleTypeID, sc.Gate, sc.ScenarioName].filter(function (x) { return x; }).join(' ') : parts[0];
        return 'REF("' + label + '","' + parts.slice(1).join('","') + '")';
      }
    }, 'names');
  } catch (e) {
    return String(formula);
  }
}

/**
 * 建立驗算檔的活頁簿 model(見 XlsxWriter.gs)。另外回傳 meta 給畫面與驗算腳本用：
 *   plCells: { 科目代碼: { 車系ID: 'D12', '': 加權平均格 } }、vehicles、profitCode…
 */
function buildVerifyWorkbookModel_(scenarioId, opts) {
  opts = opts || {};
  var scenario = getScenarios().filter(function (s) { return s.ScenarioID === scenarioId; })[0];
  if (!scenario) throw new Error('找不到情境：' + scenarioId);
  var typeId = scenario.VehicleTypeID || '';
  var isBaseline = isBaselineScenario_(scenarioId);
  var salesMix = calcSalesMix_(scenarioId);
  if (!salesMix.length) throw new Error('這個情境還沒有銷售構成，沒有數字可以匯出');
  var mixById = {};
  salesMix.forEach(function (r) { mixById[r.VehicleID] = r; });
  var master = getVehicles(typeId);
  var vehicles = master.filter(function (v) { return mixById[v.VehicleID]; }).map(function (v) {
    return { id: v.VehicleID, label: v.VehicleCode || v.VehicleID };
  });
  salesMix.forEach(function (r) {
    if (!vehicles.some(function (v) { return v.id === r.VehicleID; })) vehicles.push({ id: r.VehicleID, label: r.VehicleID });
  });
  var nV = vehicles.length;
  var VC = VERIFY_FIRST_VEHICLE_COL_;
  var vCol = function (i) { return xlsxCol_(VC + i); };
  var lastVCol = vCol(nV - 1);
  var wCol = xlsxCol_(VC + nV);   // 損益試算表：加權平均欄

  var defs = lineDefsForScenario_(scenarioId);
  var defsByCode = {}, byName = {}, children = {};
  defs.forEach(function (d) {
    defsByCode[d.LineCode] = d;
    if (!byName[d.LineName]) byName[d.LineName] = d;
    if (d.ParentLine) (children[d.ParentLine] = children[d.ParentLine] || []).push(d.LineCode);
  });
  var taxDeductCodes = defs.filter(function (d) { return String(d.CommodityTaxDeduct || '').toUpperCase() === 'Y'; }).map(function (d) { return d.LineCode; });
  var results = {};
  vehicles.forEach(function (v) { results[v.id] = calculatePLCore_(scenarioId, v.id); });
  var weighted = {};
  calculateScenarioWeighted(scenarioId).forEach(function (l) { weighted[l.LineCode] = l.Amount; });
  var lines = defs.filter(function (d) {
    return vehicles.some(function (v) { return results[v.id].lineValues[d.LineCode] !== undefined; });
  });
  var profitCode = profitLineCode_(defs);
  var params = calcParameters_(scenarioId);
  var paramDefs = getParamDefs();
  var paramDefByName = {};
  paramDefs.forEach(function (d) { paramDefByName[d.ParamName] = d; });
  var sysVars = {};
  vehicles.forEach(function (v) { sysVars[v.id] = systemVariables_(scenarioId, mixById[v.id], salesMix, params, v.id); });

  // 每個科目在每個車系實際用的公式(車系個別公式優先)；用不到公式的是手動輸入或開發攤提
  var formulaOf = function (d, vid) {
    var f = lineFormulaFor_(d, vid);
    var useFormula = d.CalcType === CALC_TYPES.FORMULA || f !== '' && parseVehicleFormulas_(d.VehicleFormulas)[vid];
    return useFormula ? f : null;
  };

  // 公式裡用到的匯率與 REF(要在輸入表先排好列)
  var currencies = [];
  var addCur = function (c) { c = String(c || '').toUpperCase(); if (c && c !== BASE_CURRENCY && currencies.indexOf(c) === -1) currencies.push(c); };
  params.forEach(function (p) { if (p.ParamName === COST_FX_PARAM_NAME && p.Currency) addCur(p.Currency); });
  var refKeys = [], refArgs = {};
  lines.forEach(function (d) {
    vehicles.forEach(function (v) {
      var f = formulaOf(d, v.id);
      if (!f) return;
      var info = inspectFormula_(f);
      if (!info.ok) return;
      info.refs.names.forEach(function (n) {
        if (/^[A-Za-z]{3}匯率$/.test(n) && !sysVars[v.id].hasOwnProperty(n) && !paramDefByName[n]) addCur(n.slice(0, 3));
      });
      info.refs.refCalls.forEach(function (call) {
        if (!call.args.every(function (a) { return a.t === 'str'; })) return;
        var key = call.args.map(function (a) { return a.v; }).join('|');
        if (refKeys.indexOf(key) === -1) { refKeys.push(key); refArgs[key] = call.args.map(function (a) { return a.v; }); }
      });
    });
  });
  var costRows = {};   // 科目代碼 → 車系 → [{ amount, currency }]
  getCostOfSales(scenarioId).concat(getOperatingExpense(scenarioId)).forEach(function (r) {
    if (!r.LineCode || !defsByCode[r.LineCode] || !mixById[r.VehicleID]) return;
    var byV = costRows[r.LineCode] = costRows[r.LineCode] || {};
    (byV[r.VehicleID] = byV[r.VehicleID] || []).push({ amount: toNumber_(r.Amount), currency: String(r.Currency || '').toUpperCase() });
    addCur(r.Currency);
  });
  var devRows = sortByOrder_(getDevInvestment(scenarioId), 'SortOrder');
  devRows.forEach(function (r) { addCur(r.Currency); });

  /* ================= 輸入 ================= */
  var input = { rows: [], at: {} };   // at[key] = 列號(0 起算)
  var IN = VERIFY_SHEETS_.input;
  var inRef = function (key, col) { return verifySheetRef_(IN, col + (input.at[key] + 1)); };
  var inVRef = function (key, i) { return inRef(key, vCol(i)); };
  var inShared = function (key) { return verifySheetRef_(IN, '$C$' + (input.at[key] + 1)); };
  var inRowRange = function (key) { var r = input.at[key] + 1; return '$' + vCol(0) + '$' + r + ':$' + lastVCol + '$' + r; };
  var inSpecs = [];
  var section = function (title) { inSpecs.push({ section: title }); };
  var spec = function (key, label, unit, build, note) { inSpecs.push({ key: key, label: label, unit: unit, build: build, note: note || '' }); };
  var perVehicleConst = function (getter, style) {
    return function () { return vehicles.map(function (v) { var x = getter(v); return { v: x, s: style || 'input' }; }); };
  };
  var mixNum = function (field) { return perVehicleConst(function (v) { return toNumber_(mixById[v.id][field]); }); };

  section('銷售構成與售價（銷售構成與售價頁）');
  spec('sm:建議零售價', '建議零售價', '元', mixNum('ListPriceTaxIncl'));
  spec('sm:強配件售價', '強配件售價', '元', mixNum('MandatoryAccessoryPrice'));
  spec('sm:廢車處理費', '廢車處理費', '元', mixNum('ScrapFee'));
  spec('sm:廢車稅別', '廢車處理費登打方式', '含稅/未稅', perVehicleConst(function (v) { return mixById[v.id].ScrapFeeTaxStatus === '未稅' ? '未稅' : '含稅'; }, 'inputText'));
  spec('sm:水平配件調降', '水平配件調降', '元', mixNum('HorizontalPartsPriceAdj'));
  spec('sm:月銷量', '月銷量', '台/月', mixNum('MonthlyVolume'));
  spec('sm:LC年限', 'LC年限', '年', mixNum('LifeCycleYears'));
  spec('sm:構成比原值', '構成比（登打值）', '%', mixNum('SalesMixPct'), '各車系加總不一定是 100，公式用的構成比 = 這一列 ÷ 合計');
  spec('sm:攤提基準月銷量', '攤提基準 月銷量', '台/月', function () {
    return [{ v: toNumber_(scenario.AmortMonthlyVolume), s: 'input', shared: true }];
  }, '開發總投頁「攤提基準台數」；月銷量與年限都 > 0 才使用，否則用各車系 LC 總台數合計');
  spec('sm:攤提基準LC年限', '攤提基準 LC年限', '年', function () {
    return [{ v: toNumber_(scenario.AmortLifeCycleYears), s: 'input', shared: true }];
  });

  section('參數與比率（參數與匯率頁；% 參數存成小數）');
  paramDefs.forEach(function (d) {
    var key = 'param:' + d.ParamName;
    var has = params.some(function (p) { return p.ParamName === d.ParamName && !p.VehicleID; });
    var source = has ? '這個情境填的值' : d.DefaultValue !== '' && d.DefaultValue !== undefined ? '沿用預設值' : DEFAULT_PARAMS[d.ParamName] !== undefined ? '沿用預設值' : '未填 = 0';
    spec(key, d.ParamName, d.Unit === '%' ? '%' : '數值', function () {
      var style = d.Unit === '%' ? 'inputPct' : 'input';
      var cells = [{ v: paramValueForFormula_(params, d, ''), s: style, shared: true }];
      vehicles.forEach(function (v) {
        var own = params.some(function (p) { return p.ParamName === d.ParamName && p.VehicleID === v.id; });
        var val = paramValueForFormula_(params, d, v.id);
        cells.push(own ? { v: val, s: style } : { f: inShared(key), v: val, s: d.Unit === '%' ? 'calcPct' : 'calc' });
      });
      return cells;
    }, source + (params.some(function (p) { return p.ParamName === d.ParamName && p.VehicleID; }) ? '；有車系個別值' : ''));
  });
  var taxDef = paramDefByName['營業稅率'];

  section('匯率（1 外幣 = ? 台幣，參數與匯率頁）');
  currencies.forEach(function (cur) {
    var key = 'fx:' + cur;
    var configured = params.some(function (p) { return p.ParamName === COST_FX_PARAM_NAME && String(p.Currency).toUpperCase() === cur && toNumber_(p.Value); });
    spec(key, cur + '匯率', '台幣', function () {
      var cells = [{ v: fxRateFor_(params, cur, ''), s: 'input', shared: true }];
      vehicles.forEach(function (v) {
        var own = params.some(function (p) { return p.ParamName === COST_FX_PARAM_NAME && p.Currency === cur && p.VehicleID === v.id; });
        var val = fxRateFor_(params, cur, v.id);
        cells.push(own ? { v: val, s: 'input' } : { f: inShared(key), v: val, s: 'calc' });
      });
      return cells;
    }, configured ? '' : '這個情境沒填匯率，系統以 1 計算');
  });

  section('系統變數（公式裡的 [名稱]）');
  spec('var:廢車處理費(含稅)', '廢車處理費(含稅)', '元', function () {
    return vehicles.map(function (v, i) {
      var rate = pct_(lookupParam_(params, '營業稅率', v.id));
      // 系統這裡用的營業稅率跟參數格一致時引用參數格，否則直接寫數字(例如參數已刪除時)
      var rateText = taxDef && Math.abs(paramValueForFormula_(params, taxDef, v.id) - rate) < 1e-12 ? inVRef('param:營業稅率', i) : verifyNumText_(rate);
      var fee = inVRef('sm:廢車處理費', i);
      return { f: 'IF(' + inVRef('sm:廢車稅別', i) + '="未稅",ROUND(' + fee + '*(1+' + rateText + '),0),' + fee + ')', v: sysVars[v.id]['廢車處理費(含稅)'], s: 'calc' };
    });
  }, '登打未稅時 × (1 + 營業稅率) 四捨五入到元');
  spec('var:LC總台數', 'LC總台數', '台', function () {
    return vehicles.map(function (v, i) { return { f: inVRef('sm:月銷量', i) + '*12*' + inVRef('sm:LC年限', i), v: sysVars[v.id]['LC總台數'], s: 'calcInt' }; });
  }, '月銷量 × 12 × LC年限');
  spec('var:構成比', '構成比', '小數', function () {
    return vehicles.map(function (v, i) {
      var sum = 'SUM(' + verifySheetRef_(IN, inRowRange('sm:構成比原值')) + ')';
      return { f: 'IF(' + sum + '=0,0,' + inVRef('sm:構成比原值', i) + '/' + sum + ')', v: sysVars[v.id]['構成比'], s: 'calcPct' };
    });
  }, '加權平均欄用這一列加權');
  spec('var:車型月總台數', '車型月總台數', '台/月', function () {
    var total = sysVars[vehicles[0].id]['車型月總台數'];
    return [{ f: 'SUM(' + verifySheetRef_(IN, inRowRange('sm:月銷量')) + ')', v: total, s: 'calcInt', shared: true }]
      .concat(vehicles.map(function () { return { f: inShared('var:車型月總台數'), v: total, s: 'calcInt' }; }));
  });
  spec('var:攤提總台數', '攤提總台數', '台', function () {
    var total = sysVars[vehicles[0].id]['攤提總台數'];
    var m = inShared('sm:攤提基準月銷量'), y = inShared('sm:攤提基準LC年限');
    return [{ f: 'IF(AND(' + m + '>0,' + y + '>0),' + m + '*12*' + y + ',SUM(' + verifySheetRef_(IN, inRowRange('var:LC總台數')) + '))', v: total, s: 'calcInt', shared: true }]
      .concat(vehicles.map(function () { return { f: inShared('var:攤提總台數'), v: total, s: 'calcInt' }; }));
  }, '有填攤提基準就用 基準月銷量 × 12 × 年限，否則 = 各車系 LC總台數 合計');
  var amortUnits = vehicleAmortUnits_(scenarioId);
  spec('var:攤提台數', '攤提台數（各車系）', '台', function () {
    var m = inShared('sm:攤提基準月銷量'), y = inShared('sm:攤提基準LC年限');
    var sum = 'SUM(' + verifySheetRef_(IN, inRowRange('sm:構成比原值')) + ')';
    return vehicles.map(function (v, i) {
      return { f: 'IF(AND(' + m + '>0,' + y + '>0),IF(' + sum + '=0,0,' + inShared('var:攤提總台數') + '*' + inVRef('sm:構成比原值', i) + '/' + sum + '),' + inVRef('var:LC總台數', i) + ')',
        v: amortUnits[v.id] || 0, s: 'calc' };
    });
  }, '只攤給部分車系的開發投資，用這一列當分母');

  // 手動輸入金額
  var inputLines = lines.filter(function (d) {
    return vehicles.some(function (v) { return !formulaOf(d, v.id) && d.CalcType !== CALC_TYPES.DEV_AMORT; });
  });
  var inputCellInfo = {};   // code → vid → { currency, mixed }
  section('手動輸入金額（成本與費用頁，元/台；外幣是原幣金額）');
  inputLines.forEach(function (d) {
    var key = 'amt:' + d.LineCode;
    var info = inputCellInfo[d.LineCode] = {};
    var curs = [];
    vehicles.forEach(function (v) {
      var list = ((costRows[d.LineCode] || {})[v.id]) || [];
      var cur = list.length === 1 ? (list[0].currency && list[0].currency !== BASE_CURRENCY ? list[0].currency : '') : '';
      info[v.id] = { currency: cur, mixed: list.length > 1 };
      if (cur && curs.indexOf(cur) === -1) curs.push(cur);
    });
    var mixedAny = vehicles.some(function (v) { return info[v.id].mixed; });
    spec(key, d.LineCode + ' ' + d.LineName, curs.length ? '原幣：' + curs.join('/') : '元/台', function () {
      return vehicles.map(function (v) {
        var list = ((costRows[d.LineCode] || {})[v.id]) || [];
        if (info[v.id].mixed) {
          return { v: list.reduce(function (s, x) { return s + x.amount * fxRateFor_(params, x.currency, v.id); }, 0), s: 'input' };
        }
        return { v: list.length ? list[0].amount : 0, s: 'input' };
      });
    }, mixedAny ? '有車系是好幾筆合計：已換算成台幣' : curs.length ? '損益試算 = 原幣 × 匯率' : '');
  });

  if (refKeys.length) {
    section('跨情境引用（REF：另一個情境算出來的數字）');
    refKeys.forEach(function (key) {
      var args = refArgs[key];
      var sc = null;
      try { sc = resolveRefScenario_(args[0]); } catch (e) { sc = null; }
      var refDefs = sc ? getPLLineItems(sc.VehicleTypeID) : [];
      var lineDef = refDefs.filter(function (d) { return d.LineCode === args[1]; })[0];
      var label = 'REF：' + (sc ? [sc.VehicleTypeID, sc.Gate, sc.ScenarioName].filter(function (x) { return x; }).join(' ') : args[0]) +
        ' / ' + (lineDef ? lineDef.LineName : args[1]) + (args[2] ? ' / ' + args[2] : '');
      spec('ref:' + key, label, '元', function () {
        return vehicles.map(function (v) {
          var x = 0;
          try { x = referenceValue_(args[0], args[1], args[2] || '', v.id); } catch (e) { x = 0; }
          return { v: x, s: 'input' };
        });
      }, '另一個情境的數字直接帶入；要驗那個情境，另外匯出它的驗算檔');
    });
  }

  // 排列號
  var INPUT_HEADER_ROWS = 4;
  inSpecs.forEach(function (s, i) { s.row = INPUT_HEADER_ROWS + i; if (s.key) input.at[s.key] = s.row; });

  /* ================= 開發總投 ================= */
  var DEV = VERIFY_SHEETS_.dev;
  var devSheet = { rows: [] };
  var DEV_HEADER_ROW = 4, DEV_FIRST = 5;
  var DEV_VC = 12;   // 開發總投表：各車系單台攤提從 M 欄開始
  var devVCol = function (i) { return xlsxCol_(DEV_VC + i); };
  var devTargetCodes = lines.filter(function (d) { return d.CalcType === CALC_TYPES.DEV_AMORT; }).map(function (d) { return d.LineCode; });
  var devSummaryAt = {};
  (function buildDev() {
    var rows = devSheet.rows;
    rows[0] = [{ v: '開發總投攤提', s: 'title' }];
    rows[1] = [{ v: (isBaseline ? '現況情境：不套用低減目標，低減後 = 台幣金額。' : '目標情境：低減後 = 台幣金額 × (1 − 低減目標)。') +
      '單台攤提 = 低減後 ÷ 攤提總台數；只攤給部分車系的列 ÷ 那幾個車系的攤提台數合計。', s: 'note' }];
    rows[2] = [{ v: '藍字黃底是從系統帶出來的輸入值，可以直接改來試算。', s: 'note' }];
    var header = ['部門', '大類', '說明', '攤提落點', '攤提落點科目', '分攤車系', '金額(原幣)', '幣別', '匯率', '金額(台幣)', '低減目標', '低減後']
      .concat(vehicles.map(function (v) { return '單台攤提\n' + v.label; }));
    rows[DEV_HEADER_ROW - 1] = header.map(function (h) { return { v: h, s: 'header' }; });
    var r = DEV_FIRST - 1;
    var totalRef = inShared('var:攤提總台數');
    devRows.forEach(function (row) {
      var target = devAmortTargetOf_(row);
      var cur = String(row.Currency || '').toUpperCase();
      var rn = r + 1;
      var fxCell = cur && cur !== BASE_CURRENCY ? { f: inShared('fx:' + cur), v: fxRateFor_(params, cur, ''), s: 'link' } : { v: 1, s: 'calc' };
      var amount = toNumber_(row.Amount);
      var twd = amount * fxRateFor_(params, row.Currency, '');
      var pctV = toNumber_(row.ChallengeReductionPct) / 100;
      var reduced = twd * (isBaseline ? 1 : 1 - pctV);
      var scope = parseVehicleScope_(row.VehicleScope);
      var scopeIdx = [];
      scope.forEach(function (id) { vehicles.forEach(function (v, i) { if (v.id === id) scopeIdx.push(i); }); });
      var cells = [
        { v: row.Department || '', s: 'label' }, { v: row.AssetType || '', s: 'label' }, { v: row.Notes || '', s: 'wrap' },
        { v: target, s: 'label' }, { v: target && defsByCode[target] ? defsByCode[target].LineName : (target ? target : '（沒有攤提落點，不攤提）'), s: 'label' },
        { v: scope.length ? scope.map(function (id) { var v = vehicles.filter(function (x) { return x.id === id; })[0]; return v ? v.label : id; }).join('、') : '全車系', s: 'label' },
        { v: amount, s: 'input' }, { v: cur || BASE_CURRENCY, s: 'label' }, fxCell,
        { f: 'G' + rn + '*I' + rn, v: twd, s: 'calc' },
        { v: isBaseline ? 0 : pctV, s: 'inputPct' },
        { f: isBaseline ? 'J' + rn : 'J' + rn + '*(1-K' + rn + ')', v: reduced, s: 'calc' }
      ];
      vehicles.forEach(function (v, i) {
        var share = 0, f;
        if (!target) { cells.push({ v: 0, s: 'calc' }); return; }
        if (!scope.length) {
          f = 'IF(' + totalRef + '<=0,0,L' + rn + '/' + totalRef + ')';
          share = (getLifeCycleUnits(scenarioId) > 0) ? reduced / getLifeCycleUnits(scenarioId) : 0;
        } else if (scopeIdx.indexOf(i) === -1) {
          cells.push({ v: 0, s: 'calc' });
          return;
        } else {
          var unitsRef = function (k) { return verifySheetRef_(IN, '$' + vCol(k) + '$' + (input.at['var:攤提台數'] + 1)); };
          var scopeSum = scopeIdx.map(unitsRef).join('+');
          f = 'IF(OR(' + totalRef + '<=0,' + unitsRef(i) + '=0,(' + scopeSum + ')<=0),0,L' + rn + '/(' + scopeSum + '))';
          var su = scopeIdx.reduce(function (s, k) { return s + (amortUnits[vehicles[k].id] || 0); }, 0);
          share = getLifeCycleUnits(scenarioId) > 0 && su > 0 && amortUnits[v.id] ? reduced / su : 0;
        }
        cells.push({ f: f, v: share, s: 'calc' });
      });
      rows[r++] = cells;
    });
    var lastDataRow = r;   // 1 起算的最後一筆列號
    var sumCol = function (c) { return devRows.length ? 'SUM(' + c + DEV_FIRST + ':' + c + lastDataRow + ')' : '0'; };
    var totalRow = [{ v: '合計', s: 'labelBold' }, null, null, null, null, null, null, null, null,
      { f: sumCol('J'), v: 0, s: 'calcBold' }, null, { f: sumCol('L'), v: 0, s: 'calcBold' }];
    vehicles.forEach(function (v, i) { totalRow.push({ f: sumCol(devVCol(i)), v: 0, s: 'calcBold' }); });
    rows[r++] = totalRow;
    r++;
    rows[r++] = [{ v: '依攤提落點彙總（損益試算表的開發攤提科目引用這裡）', s: 'labelBold' }];
    var sumHeader = [{ v: '攤提落點', s: 'header' }, { v: '科目', s: 'header' }];
    for (var k = 2; k < 11; k++) sumHeader.push(null);
    sumHeader.push({ v: '低減後合計', s: 'header' });
    vehicles.forEach(function (v) { sumHeader.push({ v: '單台攤提\n' + v.label, s: 'header' }); });
    rows[r++] = sumHeader;
    var rng = function (c) { return '$' + c + '$' + DEV_FIRST + ':$' + c + '$' + Math.max(DEV_FIRST, lastDataRow); };
    var dev = amortizeDevInvestmentPerUnit_(scenarioId, null);
    devTargetCodes.forEach(function (code) {
      var rn = r + 1;
      devSummaryAt[code] = rn;
      var cells = [{ v: code, s: 'label' }, { v: defsByCode[code].LineName, s: 'label' }];
      for (var k = 2; k < 11; k++) cells.push(null);
      cells.push({ f: devRows.length ? 'SUMIF(' + rng('D') + ',$A' + rn + ',' + rng('L') + ')' : '0', v: dev.totalsByLine[code] || 0, s: 'calc' });
      vehicles.forEach(function (v, i) {
        var val = results[v.id].lineValues[code] || 0;
        cells.push({ f: devRows.length ? 'SUMIF(' + rng('D') + ',$A' + rn + ',' + rng(devVCol(i)) + ')' : '0', v: val, s: 'calc' });
      });
      rows[r++] = cells;
    });
    // 合計列的快取值
    totalRow[9].v = devRows.reduce(function (s, x) { return s + toNumber_(x.Amount) * fxRateFor_(params, x.Currency, ''); }, 0);
    totalRow[11].v = devRows.reduce(function (s, x) { return s + toNumber_(x.Amount) * fxRateFor_(params, x.Currency, '') * (isBaseline ? 1 : 1 - toNumber_(x.ChallengeReductionPct) / 100); }, 0);
    vehicles.forEach(function (v, i) {
      totalRow[DEV_VC + i].v = devRows.reduce(function (s, x, idx) { var c = rows[DEV_FIRST - 1 + idx][DEV_VC + i]; return s + (c && typeof c.v === 'number' ? c.v : 0); }, 0);
    });
    devSheet.cols = [16, 8, 24, 9, 18, 14, 14, 6, 9, 14, 9, 14].concat(vehicles.map(function () { return 13; }));
    devSheet.freeze = { row: DEV_HEADER_ROW, col: 1 };
  })();

  /* ================= 損益試算 ================= */
  var PL = VERIFY_SHEETS_.pl;
  var PL_HEADER_ROW = 4, PL_FIRST = 5;
  var plAt = {};
  lines.forEach(function (d, i) { plAt[d.LineCode] = PL_FIRST + i; });
  var depth = lineDepths_(defs);
  var plRows = [];
  plRows[0] = [{ v: '損益試算（每一格都是 Excel 公式）', s: 'title' }];
  plRows[1] = [{ v: '公式由「科目與公式」頁的設定翻譯而來，引用「輸入」「開發總投」的格子；改輸入的藍字，這裡跟著重算。對照原始公式看「公式區」。', s: 'note' }];
  plRows[2] = [{ v: '單位：元/台；加權平均 = 各車系 × 構成比（輸入表「構成比」那一列）。', s: 'note' }];
  plRows[PL_HEADER_ROW - 1] = [{ v: '代碼', s: 'header' }, { v: '科目', s: 'header' }, { v: '計算來源', s: 'header' }]
    .concat(vehicles.map(function (v) { return { v: v.label, s: 'header' }; })).concat([{ v: '加權平均', s: 'header' }]);
  var formulaNotes = {};   // code → { 'div': true, ... } 給公式區的對照說明
  var cellErrors = {};     // code → vid → 系統的錯誤訊息
  var plFormulaText = {};  // code → vid → Excel 公式文字
  var sourceText = function (d) {
    return d.CalcType === CALC_TYPES.DEV_AMORT ? '開發總投攤提' : d.CalcType === CALC_TYPES.FORMULA ? '公式' : '手動輸入';
  };
  var isBoldLine = function (d) {
    return PROTECTED_LINE_CODES.indexOf(d.LineCode) !== -1 || d.LineCode === profitCode || (children[d.LineCode] || []).length > 0;
  };
  lines.forEach(function (d) {
    var rn = plAt[d.LineCode];
    var bold = isBoldLine(d);
    var notes = formulaNotes[d.LineCode] = {};
    var row = [{ v: d.LineCode, s: 'label' }, { v: new Array((depth[d.LineCode] || 0) + 1).join('　') + d.LineName, s: bold ? 'labelBold' : 'label' }, { v: sourceText(d), s: 'label' }];
    vehicles.forEach(function (v, i) {
      var res = results[v.id];
      var sysVal = res.lineValues[d.LineCode];
      var col = vCol(i);
      var style = bold ? 'calcBold' : 'calc';
      if (sysVal === undefined) { row.push({ v: 0, s: style }); return; }
      if (res.errors[d.LineCode]) {
        (cellErrors[d.LineCode] = cellErrors[d.LineCode] || {})[v.id] = res.errors[d.LineCode];
        row.push({ v: 0, s: style });
        return;
      }
      var f = formulaOf(d, v.id), text;
      try {
        if (f) {
          text = verifyPrintAst_(parseFormula_(f), {
            code: function (c) {
              if (plAt[c] === undefined) { notes.zero = true; return '0'; }
              return col + plAt[c];
            },
            name: function (n) {
              if (sysVars[v.id].hasOwnProperty(n)) {
                var map = { '建議零售價': 'sm:建議零售價', '強配件售價': 'sm:強配件售價', '廢車處理費': 'sm:廢車處理費', '水平配件調降': 'sm:水平配件調降',
                  '月銷量': 'sm:月銷量', 'LC年限': 'sm:LC年限' };
                var key = map[n] || 'var:' + n;
                if (input.at[key] === undefined) throw formulaError_('找不到 [' + n + ']');
                return inVRef(key, i);
              }
              if (paramDefByName[n]) return inVRef('param:' + n, i);
              if (/^[A-Za-z]{3}匯率$/.test(n)) {
                var cur = n.slice(0, 3).toUpperCase();
                return cur === BASE_CURRENCY ? '1' : inVRef('fx:' + cur, i);
              }
              if (byName[n]) {
                if (plAt[byName[n].LineCode] === undefined) { notes.zero = true; return '0'; }
                return col + plAt[byName[n].LineCode];
              }
              throw formulaError_('找不到 [' + n + ']');
            },
            sumOf: function (fn) {
              var codes = (fn === 'CHILDREN' ? children[d.LineCode] || [] : taxDeductCodes).filter(function (c) { return plAt[c] !== undefined; });
              notes[fn] = true;
              return codes.length ? 'SUM(' + codes.map(function (c) { return col + plAt[c]; }).join(',') + ')' : '0';
            },
            ref: function (args) {
              if (!args.every(function (a) { return a.t === 'str'; })) throw formulaError_('REF 的參數不是固定文字');
              notes.REF = true;
              return inVRef('ref:' + args.map(function (a) { return a.v; }).join('|'), i);
            },
            note: function (k) { notes[k] = true; }
          }, 'excel');
        } else if (d.CalcType === CALC_TYPES.DEV_AMORT) {
          text = verifySheetRef_(DEV, devVCol(i) + devSummaryAt[d.LineCode]);
        } else {
          var info = (inputCellInfo[d.LineCode] || {})[v.id] || {};
          text = inVRef('amt:' + d.LineCode, i) + (info.currency ? '*' + inVRef('fx:' + info.currency, i) : '');
        }
      } catch (e) {
        notes.fallback = e.message;
        row.push({ v: sysVal, s: 'sys' });
        return;
      }
      (plFormulaText[d.LineCode] = plFormulaText[d.LineCode] || {})[v.id] = '=' + text;
      row.push({ f: text, v: sysVal, s: f ? style : 'link' });
    });
    row.push({ f: 'SUMPRODUCT(' + vCol(0) + rn + ':' + lastVCol + rn + ',' + verifySheetRef_(IN, inRowRange('var:構成比')) + ')',
      v: weighted[d.LineCode] || 0, s: bold ? 'calcBold' : 'calc' });
    plRows[rn - 1] = row;
  });
  var plLast = PL_FIRST + lines.length - 1;

  /* ================= 驗算 ================= */
  var CK = VERIFY_SHEETS_.check;
  var INFO = VERIFY_SHEETS_.info;
  var tolRef = verifySheetRef_(INFO, '$C$12');
  var ckRows = [];
  var nCols = nV + 1;
  var sysCol = function (k) { return xlsxCol_(2 + k); };
  var diffCol = function (k) { return xlsxCol_(2 + nCols + k); };
  var resultCol = xlsxCol_(2 + nCols * 2);
  ckRows[0] = [{ v: '驗算：Excel 重算結果 vs 系統數字', s: 'title' }];
  ckRows[1] = [{ v: '左半部是匯出當下系統算出來的數字(固定值)；右半部 = 損益試算(Excel 重算) − 系統數字，超過「說明」頁的容差就標紅。', s: 'note' }];
  var ckHeader = [{ v: '代碼', s: 'header' }, { v: '科目', s: 'header' }];
  vehicles.forEach(function (v) { ckHeader.push({ v: '系統\n' + v.label, s: 'header' }); });
  ckHeader.push({ v: '系統\n加權平均', s: 'header' });
  vehicles.forEach(function (v) { ckHeader.push({ v: '差異\n' + v.label, s: 'header' }); });
  ckHeader.push({ v: '差異\n加權平均', s: 'header' });
  ckHeader.push({ v: '結果', s: 'header' });
  ckRows[PL_HEADER_ROW - 1] = ckHeader;
  var checkResultAt = {};
  lines.forEach(function (d) {
    var rn = plAt[d.LineCode];
    var row = [{ v: d.LineCode, s: 'label' }, { v: d.LineName, s: 'label' }];
    vehicles.forEach(function (v) { var x = results[v.id].lineValues[d.LineCode]; row.push({ v: x === undefined ? 0 : x, s: 'sys' }); });
    row.push({ v: weighted[d.LineCode] || 0, s: 'sys' });
    for (var k = 0; k < nCols; k++) {
      var plCol = k < nV ? vCol(k) : wCol;
      row.push({ f: verifySheetRef_(PL, plCol + rn) + '-' + sysCol(k) + rn, v: 0, s: 'diff' });
    }
    var range = diffCol(0) + rn + ':' + diffCol(nCols - 1) + rn;
    row.push({ f: 'IF(SUMPRODUCT(--(ABS(' + range + ')>' + tolRef + '))=0,"✓ 一致","✗ 不一致")', v: '✓ 一致', s: 'label' });
    checkResultAt[d.LineCode] = resultCol + rn;
    ckRows[rn - 1] = row;
  });

  /* ================= 公式區 ================= */
  var FM = VERIFY_SHEETS_.formulas;
  var fmRows = [];
  fmRows[0] = [{ v: '公式區：系統公式 ⇄ Excel 公式', s: 'title' }];
  fmRows[1] = [{ v: '每個科目一列(車系有個別公式時，每一種公式各一列)。「Excel 公式」是損益試算表那一格的公式(FORMULATEXT，Excel 2013 以後才有)，改了損益試算表這裡會跟著變。', s: 'note' }];
  var fmHeader = ['代碼', '科目', '計算來源', '適用車系', '系統公式（科目名稱）', '系統公式（存檔的樣子）', 'Excel 公式（損益試算）', '對照說明', '驗算結果',
    '系統預設的算法', '跟系統預設比較'];
  fmRows[3] = fmHeader.map(function (h) { return { v: h, s: 'header' }; });
  var noteText = function (d, notes, kind) {
    var out = [];
    if (kind === 'input') {
      var cur = vehicles.map(function (v) { return ((inputCellInfo[d.LineCode] || {})[v.id] || {}).currency; }).filter(function (x) { return x; });
      out.push('金額在「輸入」表第 ' + (input.at['amt:' + d.LineCode] + 1) + ' 列' + (cur.length ? '，外幣 × 匯率換成台幣' : ''));
    } else if (kind === 'dev') {
      out.push('「開發總投」表依攤提落點 ' + d.LineCode + ' 彙總(第 ' + devSummaryAt[d.LineCode] + ' 列)：每一筆 低減後 ÷ 攤提台數，再 SUMIF');
    }
    if (notes.CHILDREN) out.push('CHILDREN() = 子科目合計 → SUM(子科目的格子)');
    if (notes.TAXDEDUCT) out.push('TAXDEDUCT() = 勾「貨物稅完稅價格可扣除」的科目合計 → SUM(那些科目的格子)');
    if (notes.div) out.push('除法寫成 IF(分母=0,0,…)：系統的除以 0 = 0');
    if (notes.REF) out.push('REF() → 「輸入」表「跨情境引用」那一列(另一個情境的數字)');
    if (notes.zero) out.push('引用的科目這個情境沒有數字，以 0 計');
    if (notes.fallback) out.push('無法翻成 Excel 公式（' + notes.fallback + '），直接帶入系統數字');
    var errs = cellErrors[d.LineCode];
    if (errs) out.push('系統顯示公式錯誤：' + Object.keys(errs).map(function (vid) { return errs[vid]; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join('；') + '（以 0 計）');
    return out.join('\n');
  };
  // 跟系統預設(標準範本原本的 Gate F 算法)比：改過的科目一眼看得到，審核時只要看這幾條
  var stdByCode = {};
  PL_LINE_ITEMS.forEach(function (x) { stdByCode[x.LineCode] = x; });
  var kindOfStd = function (x) { return x.CalcType === CALC_TYPES.FORMULA ? 'formula' : x.CalcType === CALC_TYPES.DEV_AMORT ? 'dev' : 'input'; };
  var KIND_NAME = { formula: '公式', dev: '開發總投攤提', input: '手動輸入' };
  var stdFormulaText = function (d) {
    var std = stdByCode[d.LineCode];
    if (!std) return '（預設沒有這個科目）';
    return kindOfStd(std) === 'formula' ? verifyReadableFormula_(std.Formula, defsByCode) : KIND_NAME[kindOfStd(std)];
  };
  var stdCompare = function (d, g) {
    var std = stdByCode[d.LineCode];
    if (!std) return '新增的科目（系統預設沒有）';
    var out = [];
    if (g.kind !== kindOfStd(std)) out.push('計算來源改過：預設是' + KIND_NAME[kindOfStd(std)]);
    else if (g.kind === 'formula' && cleanFormulaText_(g.formula) !== cleanFormulaText_(std.Formula)) out.push('公式跟預設不同');
    if (parseVehicleFormulas_(d.VehicleFormulas)[vehicles[g.idx[0]].id]) out.push('這幾個車系用個別公式');
    if ((d.ParentLine || '') !== (std.ParentLine || '')) {
      out.push('所屬小計改過：預設在「' + (std.ParentLine ? (defsByCode[std.ParentLine] || stdByCode[std.ParentLine] || {}).LineName || std.ParentLine : '最上層') + '」底下');
    }
    return out.length ? out.join('；') : '相同';
  };
  var stdDiffCount = 0;
  var fr = 4;
  lines.forEach(function (d) {
    var notes = formulaNotes[d.LineCode] || {};
    var groups = [];   // [{ formula, kind, vehicles: [index] }]
    vehicles.forEach(function (v, i) {
      var f = formulaOf(d, v.id);
      var kind = f ? 'formula' : d.CalcType === CALC_TYPES.DEV_AMORT ? 'dev' : 'input';
      var key = kind + '|' + (f || '');
      var g = groups.filter(function (x) { return x.key === key; })[0];
      if (!g) { g = { key: key, formula: f, kind: kind, idx: [] }; groups.push(g); }
      g.idx.push(i);
    });
    groups.forEach(function (g) {
      var first = g.idx[0];
      var cellRef = vCol(first) + plAt[d.LineCode];
      var ftext = ((plFormulaText[d.LineCode] || {})[vehicles[first].id]) || '';
      fmRows[fr++] = [
        { v: d.LineCode, s: 'label' }, { v: d.LineName, s: 'label' },
        { v: g.kind === 'formula' ? '公式' : g.kind === 'dev' ? '開發總投攤提' : '手動輸入', s: 'label' },
        { v: groups.length === 1 ? '全部車系' : g.idx.map(function (i) { return vehicles[i].label; }).join('、'), s: 'wrap' },
        { v: g.formula ? verifyReadableFormula_(g.formula, defsByCode) : '', s: 'code' },
        { v: g.formula ? '=' + cleanFormulaText_(g.formula) : '', s: 'code' },
        ftext ? { f: '_xlfn.FORMULATEXT(' + verifySheetRef_(PL, cellRef) + ')', v: ftext, s: 'code' } : { v: '（帶入系統數字）', s: 'code' },
        { v: noteText(d, notes, g.kind), s: 'wrap' },
        { f: verifySheetRef_(CK, checkResultAt[d.LineCode]), v: '✓ 一致', s: 'label' },
        { v: stdFormulaText(d), s: 'code' },
        { v: stdCompare(d, g), s: 'wrap' }
      ];
      if (stdCompare(d, g) !== '相同') stdDiffCount++;
    });
  });
  fr++;
  // 名稱對照表從 B 欄開始(A 欄是窄的代碼欄)
  fmRows[fr++] = [null, { v: '名稱對照：公式裡的 [名稱] 在 Excel 裡引用哪一格', s: 'labelBold' }];
  fmRows[fr++] = [null].concat(['名稱', '種類', '「輸入」表的列', '第一個車系的格子', '說明'].map(function (h) { return { v: h, s: 'header' }; }));
  var nameRow = function (name, kind, key, desc) {
    if (input.at[key] === undefined) return;
    var rn = input.at[key] + 1;
    fmRows[fr++] = [null, { v: '[' + name + ']', s: 'code' }, { v: kind, s: 'label' }, { v: rn, s: 'label' },
      { v: verifySheetRef_(IN, vCol(0) + rn), s: 'code' }, { v: desc || '', s: 'wrap' }];
  };
  var smKey = { '建議零售價': 'sm:建議零售價', '強配件售價': 'sm:強配件售價', '廢車處理費': 'sm:廢車處理費', '水平配件調降': 'sm:水平配件調降', '月銷量': 'sm:月銷量', 'LC年限': 'sm:LC年限' };
  SYSTEM_VARIABLES.forEach(function (sv) { nameRow(sv.name, '系統變數', smKey[sv.name] || 'var:' + sv.name, sv.desc); });
  paramDefs.forEach(function (d) { nameRow(d.ParamName, '參數', 'param:' + d.ParamName, (d.Unit === '%' ? '% 參數，存成小數。' : '') + (d.Description || '')); });
  currencies.forEach(function (c) { nameRow(c + '匯率', '匯率', 'fx:' + c, '1 ' + c + ' = ? 台幣'); });

  var anyBad = function (range) { return 'SUMPRODUCT(--(ABS(' + range + ')>' + tolRef + '))'; };
  var plCell = function (code, k) { return verifySheetRef_(PL, (k < nV ? vCol(k) : wCol) + plAt[code]); };

  /* ================= 結構檢查 =================
   * 不看使用者現在寫的公式：小計一律用系統預設的算法(A = P8 + P9、C = A − B、E = C − Σ子科目…)，
   * 子科目照現在的科目表，在 Excel 裡另外算一次跟損益試算比。改壞小計公式、明細掛錯小計、少算一段都會在這裡對不起來。 */
  var ST = VERIFY_SHEETS_.structure;
  var stRows = [];
  stRows[0] = [{ v: '結構檢查：用系統預設的算法重算各段小計', s: 'title' }];
  stRows[1] = [{ v: '每一列 = 損益試算的實際數字 − 用預設算法算出來的數字(Excel 公式)。標紅代表那一段小計跟預設算法不同：可能是公式改壞、明細掛錯小計，也可能是刻意改的算法(對照公式區最右邊「跟系統預設比較」)。', s: 'note' }];
  stRows[3] = [{ v: '代碼', s: 'header' }, { v: '檢查', s: 'header' }, { v: '預設算法', s: 'header' }]
    .concat(vehicles.map(function (v) { return { v: '差異\n' + v.label, s: 'header' }; })).concat([{ v: '差異\n加權平均', s: 'header' }, { v: '結果', s: 'header' }]);
  var stChecks = [];
  ['A', 'B', 'C', 'E', 'G', 'I', 'K'].forEach(function (code) {
    if (plAt[code] === undefined || !DEFAULT_FORMULAS[code]) return;
    var info = inspectFormula_(DEFAULT_FORMULAS[code]);
    if (!info.ok || info.refs.codes.some(function (c) { return plAt[c] === undefined; })) return;
    stChecks.push({ label: code + ' ' + defsByCode[code].LineName, formula: DEFAULT_FORMULAS[code], code: code });
  });
  // 整條損益鏈：營業淨利 = 收入 − 各段明細全部扣掉(不經過中間小計)
  if (['A', 'B', 'E', 'G', 'I', 'J', 'K'].every(function (c) { return plAt[c] !== undefined; })) {
    var leafs = ['B', 'E', 'G', 'I'].map(function (g) { return (children[g] || []).filter(function (c) { return plAt[c] !== undefined; }); });
    stChecks.push({ label: 'K ' + defsByCode.K.LineName + '（整條損益鏈）', code: 'K', custom: function (col) {
      var parts = leafs.map(function (list) { return list.length ? '-SUM(' + list.map(function (c) { return col + plAt[c]; }).join(',') + ')' : ''; }).join('');
      return col + plAt.A + parts + '-' + col + plAt.J;
    }, customValue: function (vals) {
      return (vals.A || 0) - leafs.reduce(function (s, list) { return s + list.reduce(function (t, c) { return t + (vals[c] || 0); }, 0); }, 0) - (vals.J || 0);
    }, text: '= [收入] − 銷貨成本明細 − 銷售費用明細 − 產品貢獻前費用明細 − 固定營業費用明細 − [前瞻費用]' });
  }
  // 使用者自己加的群組(有子科目、不是「前一段 − 明細」那種)：= 子科目合計
  lines.forEach(function (d) {
    if (stdByCode[d.LineCode] || !(children[d.LineCode] || []).length || isFooterGroupLine_(d)) return;
    stChecks.push({ label: d.LineCode + ' ' + d.LineName, formula: 'CHILDREN()', code: d.LineCode });
  });
  var stFirst = 5;
  var valsFor = function (k) { return k < nV ? results[vehicles[k].id].lineValues : weighted; };
  // 快取值(Excel 打開時會重算；不重算的檢視器看到的也要是對的)：用同一個預設算法在這裡先算一次
  var expectedValue = function (chk, vals) {
    if (chk.customValue) return chk.customValue(vals);
    return num_(evalFormulaAst_(parseFormula_(chk.formula), {
      code: function (c) { return vals[c] || 0; }, name: function () { return 0; },
      children: function () { return (children[chk.code] || []).reduce(function (s, c) { return s + (vals[c] || 0); }, 0); },
      taxDeduct: function () { return 0; }, ref: function () { return 0; }
    }));
  };
  var stBad = 0;
  stChecks.forEach(function (chk, i) {
    var rn = stFirst + i;
    var rowBad = false;
    var row = [{ v: chk.code, s: 'label' }, { v: chk.label, s: 'labelBold' }, { v: chk.text || verifyReadableFormula_(chk.formula, defsByCode), s: 'code' }];
    for (var k = 0; k <= nV; k++) {
      var col = k < nV ? vCol(k) : wCol;
      var expected = chk.custom ? chk.custom(col) : verifyPrintAst_(parseFormula_(chk.formula), {
        code: function (c) { return col + plAt[c]; },
        name: function (n) { throw formulaError_('預設算法不應該有 [' + n + ']'); },
        sumOf: function () {
          var list = (children[chk.code] || []).filter(function (c) { return plAt[c] !== undefined; });
          return list.length ? 'SUM(' + list.map(function (c) { return col + plAt[c]; }).join(',') + ')' : '0';
        },
        ref: function () { return '0'; }, note: function () { }
      }, 'excel');
      // 公式只引用損益試算表：把 D12 這種格子加上工作表名稱
      expected = expected.replace(/(^|[^A-Za-z0-9!$'])([A-Z]{1,3}\d+)/g, function (m, pre, ref) { return pre + verifySheetRef_(PL, ref); });
      var vals = valsFor(k);
      var diff = Math.round(((vals[chk.code] || 0) - expectedValue(chk, vals)) * 1e6) / 1e6 + 0;   // + 0：-0 顯示成 0
      if (Math.abs(diff) > 0.01) rowBad = true;
      row.push({ f: plCell(chk.code, k) + '-(' + expected + ')', v: diff, s: 'diff' });
    }
    if (rowBad) stBad++;
    var range = vCol(0) + rn + ':' + wCol + rn;
    row.push({ f: 'IF(' + anyBad(range) + '=0,"✓ 符合","✗ 跟預設算法不同")', v: rowBad ? '✗ 跟預設算法不同' : '✓ 符合', s: 'label' });
    stRows[rn - 1] = row;
  });
  var stLast = stFirst + Math.max(stChecks.length, 1) - 1;
  var stResultCol = xlsxCol_(VC + nV + 1);

  /* ================= 科目影響 =================
   * 系統把每個明細科目逐一 +1,000 元重算，看營業淨利變多少：成本/費用應該 −1、收入 +1。
   * 0 = 沒有算進營業淨利、−2 = 重複計算、正負號反了 = 掛錯段落。完全不看公式怎麼寫，只看結果。 */
  var IM = VERIFY_SHEETS_.impact;
  var imRows = [];
  imRows[0] = [{ v: '科目影響：每個明細科目多 1 元，營業淨利變多少', s: 'title' }];
  imRows[1] = [{ v: '系統把每個科目逐一加 1,000 元重新計算整張損益表，(營業淨利的變化) ÷ 1,000。成本、費用應該是 −1，收入 +1；0 = 沒有算進營業淨利，−2 = 重複計算。這一頁是系統算的固定值，用來抓「科目掛錯小計、漏算、重複算」。', s: 'note' }];
  imRows[3] = [{ v: '代碼', s: 'header' }, { v: '科目', s: 'header' }, { v: '所屬小計', s: 'header' }]
    .concat(vehicles.map(function (v) { return { v: v.label, s: 'header' }; })).concat([{ v: '預期', s: 'header' }, { v: '結果', s: 'header' }]);
  var isRevenueLine = function (d) {
    var cur = d, guard = 0;
    while (cur && guard++ < 20) {
      if (cur.LineCode === 'A' || String(cur.Category || '') === '收入') return true;
      cur = defsByCode[cur.ParentLine];
    }
    return false;
  };
  // 明細科目：有所屬小計的末端科目，加上最上層的手動輸入/開發攤提(例：前瞻費用)；最上層的公式科目是小計(收入、生產毛利…)不列
  var impactLines = lines.filter(function (d) {
    if (String(d.Category || '') === '售價結構' || (children[d.LineCode] || []).length || d.LineCode === profitCode) return false;
    return !!d.ParentLine || d.CalcType !== CALC_TYPES.FORMULA;
  });
  var STEP = 1000;
  var coef = {};   // code → vid → 係數
  vehicles.forEach(function (v) {
    var base = results[v.id].lineValues[profitCode] || 0;
    impactLines.forEach(function (d) {
      var after = withOverrides_({ scenarioId: scenarioId, lineAdd: (function () { var o = {}; o[d.LineCode] = STEP; return o; })() }, function () {
        return calculatePLCore_(scenarioId, v.id).lineValues[profitCode] || 0;
      });
      (coef[d.LineCode] = coef[d.LineCode] || {})[v.id] = Math.round((after - base) / STEP * 10000) / 10000;
    });
  });
  var impactBad = 0;
  impactLines.forEach(function (d, i) {
    var expected = isRevenueLine(d) ? 1 : -1;
    var worst = '✓ 正常';
    var cs = vehicles.map(function (v) { return coef[d.LineCode][v.id]; });
    var deductible = String(d.CommodityTaxDeduct || '').toUpperCase() === 'Y';
    cs.forEach(function (c) {
      var msg;
      if (Math.abs(c) < 0.01) msg = '✗ 沒有算進營業淨利（確認所屬小計）';
      else if (Math.abs(c) > 1.5) msg = '✗ 算了 ' + Math.round(Math.abs(c)) + ' 次（重複計算）';
      else if (c * expected < 0) msg = '✗ 正負號跟預期相反（確認是收入還是成本）';
      else if (Math.abs(c - expected) > 0.01) msg = deductible ? 'ℹ 會連動貨物稅（可扣除貨物稅的科目）' : 'ℹ 會連動其他科目，每多 1 元淨利變 ' + c;
      if (msg && (worst.charAt(0) !== '✗')) worst = msg;
    });
    if (worst.charAt(0) === '✗') impactBad++;
    var parent = d.ParentLine && defsByCode[d.ParentLine] ? defsByCode[d.ParentLine].LineName : '（最上層）';
    imRows[4 + i] = [{ v: d.LineCode, s: 'label' }, { v: d.LineName, s: 'label' }, { v: parent, s: 'label' }]
      .concat(cs.map(function (c) { return { v: c, s: 'sys' }; }))
      .concat([{ v: expected, s: 'label' }, { v: worst, s: 'label' }]);
  });
  var imResultCol = xlsxCol_(VC + nV + 1);
  var imLast = 4 + Math.max(impactLines.length, 1);

  /* ================= 變動檢查(選了快照才有) =================
   * 改公式/科目前先存情境快照，匯出時選它：逐科目列出 快照 → 現在 的差異與公式有沒有改，
   * 「公式沒改、數字卻變了」的科目特別標出來(通常是上游被改到)。 */
  var CH = VERIFY_SHEETS_.changes;
  var chRows = null, chLast = 0, chJudgeCol = '', snapLabel = '', chWarn = 0;
  var snap = opts.snapshotId ? snapshotData_(opts.snapshotId) : null;
  if (opts.snapshotId && !snap) throw new Error('找不到快照：' + opts.snapshotId);
  if (snap) {
    chRows = [];
    snapLabel = snap.meta.SnapshotName + '（' + [snap.scenario.Gate, snap.scenario.ScenarioName].filter(function (x) { return x; }).join(' ') + '，' + formatDateTime_(new Date(snap.meta.CreatedAt)) + '）';
    var snapCols = {};
    snap.columns.forEach(function (c) { snapCols[c.vehicleId || ''] = c.amounts; });
    var snapLine = {};
    snap.lines.forEach(function (l) { snapLine[l.LineCode] = l; });
    var hasVf = snap.lines.some(function (l) { return l.VehicleFormulas !== undefined; });
    var sig = function (calcType, formula, vf) {
      var o = parseVehicleFormulas_(vf);
      var vfText = hasVf ? Object.keys(o).sort().map(function (k) { return k + '=' + cleanFormulaText_(o[k]); }).join(';') : '';
      return calcType + '|' + (calcType === CALC_TYPES.FORMULA ? cleanFormulaText_(formula) : '') + '|' + vfText;
    };
    var shownFormula = function (calcType, formula) {
      return calcType === CALC_TYPES.FORMULA ? verifyReadableFormula_(formula, defsByCode) : calcType === CALC_TYPES.DEV_AMORT ? '（開發總投攤提）' : '（手動輸入）';
    };
    chRows[0] = [{ v: '變動檢查：跟快照比', s: 'title' }];
    chRows[1] = [{ v: '快照：' + snapLabel + '。差異 = 現在(損益試算，Excel 重算) − 快照當時的數字。快照之後輸入的數字有改，也會出現在差異裡。' + (hasVf ? '' : '這個快照比較舊，沒有存車系個別公式，只比主要公式。'), s: 'note' }];
    var dCols = ['加權平均'].concat(vehicles.map(function (v) { return v.label; }));
    chRows[3] = ['代碼', '科目', '公式', '快照\n加權平均', '現在\n加權平均'].map(function (h) { return { v: h, s: 'header' }; })
      .concat(dCols.map(function (l) { return { v: '差異\n' + l, s: 'header' }; }))
      .concat(['判讀', '快照時的公式', '現在的公式'].map(function (h) { return { v: h, s: 'header' }; }));
    var dFirst = 5;   // F 欄開始是差異
    var dLastCol = xlsxCol_(dFirst + dCols.length - 1);
    chJudgeCol = xlsxCol_(dFirst + dCols.length);
    var order = lines.map(function (d) { return d.LineCode; });
    snap.lines.forEach(function (l) { if (order.indexOf(l.LineCode) === -1) order.push(l.LineCode); });
    order.forEach(function (code, i) {
      var rn = 5 + i;
      var d = defsByCode[code], sl = snapLine[code];
      var inNow = plAt[code] !== undefined;
      var fState = !sl ? '新增的科目' : !inNow ? '已刪除' :
        sig(sl.CalcType, sl.Formula, sl.VehicleFormulas) !== sig(d.CalcType, d.Formula, hasVf ? d.VehicleFormulas : '') ? '改過' :
        (sl.ParentLine || '') !== (d.ParentLine || '') ? '改了所屬小計' : '相同';
      var row = [{ v: code, s: 'label' }, { v: (d || sl).LineName, s: 'label' }, { v: fState, s: 'label' }];
      var sw = sl && snapCols[''] ? snapCols[''][code] : undefined;
      row.push(sw === undefined ? { v: '', s: 'label' } : { v: sw, s: 'sys' });
      row.push(inNow ? { f: plCell(code, nV), v: weighted[code] || 0, s: 'link' } : { v: '', s: 'label' });
      dCols.forEach(function (x, k) {
        var vid = k === 0 ? '' : vehicles[k - 1].id;
        var sv = sl && snapCols[vid] ? snapCols[vid][code] : undefined;
        if (!inNow || sv === undefined) { row.push({ v: '', s: 'label' }); return; }
        var now = k === 0 ? weighted[code] || 0 : results[vid].lineValues[code] || 0;
        row.push({ f: plCell(code, k === 0 ? nV : k - 1) + '-(' + verifyNumText_(sv) + ')', v: now - sv, s: 'calc' });
      });
      var range = xlsxCol_(dFirst) + rn + ':' + dLastCol + rn;
      var numChanged = row.slice(dFirst).some(function (c) { return c && c.f && typeof c.v === 'number' && Math.abs(c.v) > 0.01; });
      var judge;
      if (fState === '新增的科目') judge = { v: '新增的科目：確認掛在正確的小計底下（看「科目影響」）', s: 'wrap' };
      else if (fState === '已刪除') judge = { v: '快照有、現在刪掉了：確認它的金額有沒有移到別的科目', s: 'wrap' };
      else {
        judge = { f: 'IF(' + anyBad(range) + '=0,IF($C' + rn + '="相同","✓ 沒變","公式改過，但數字沒變"),IF($C' + rn + '="相同","⚠ 公式沒改，數字卻變了：上游科目或輸入有變","公式改過，數字跟著變：確認變動是預期的"))',
          v: !numChanged ? (fState === '相同' ? '✓ 沒變' : '公式改過，但數字沒變') : (fState === '相同' ? '⚠ 公式沒改，數字卻變了：上游科目或輸入有變' : '公式改過，數字跟著變：確認變動是預期的'), s: 'wrap' };
        if (numChanged && fState === '相同') chWarn++;
      }
      row.push(judge);
      row.push({ v: sl ? shownFormula(sl.CalcType, sl.Formula) : '', s: 'code' });
      row.push({ v: d ? shownFormula(d.CalcType, lineFormulaFor_(d, '')) : '', s: 'code' });
      chRows[rn - 1] = row;
    });
    chLast = 4 + order.length;
  }

  /* ================= 輸入表實際內容 ================= */
  var inRows = [];
  inRows[0] = [{ v: '輸入資料', s: 'title' }];
  inRows[1] = [{ v: '藍字黃底 = 從系統帶出來的輸入值，可以直接改來試算；黑字 = 公式；綠字 = 引用其他工作表。「共用」欄是全車系共用的值，車系欄沒有個別值時引用它。', s: 'note' }];
  inRows[3] = ['項目', '單位', '共用'].concat(vehicles.map(function (v) { return v.label; })).concat(['說明']).map(function (h) { return { v: h, s: 'header' }; });
  var noteCol = VC + nV;
  inSpecs.forEach(function (s) {
    if (s.section) { inRows[s.row] = [{ v: s.section, s: 'section' }]; for (var k = 1; k <= noteCol; k++) inRows[s.row].push({ v: '', s: 'section' }); return; }
    var cells = s.build();
    var row = [{ v: s.label, s: 'label' }, { v: s.unit, s: 'label' }];
    if (cells.length && cells[0].shared) { row.push(cells[0]); cells = cells.slice(1); }
    else row.push({ v: '', s: 'label' });
    vehicles.forEach(function (v, i) { row.push(cells[i] || { v: '', s: 'label' }); });
    row.push({ v: s.note, s: 'note' });
    inRows[s.row] = row;
  });

  /* ================= 說明 ================= */
  var scenarioLabel = [scenario.Gate, scenario.ScenarioName].filter(function (x) { return x; }).join(' ');
  var mismatchFormula = 'COUNTIF(' + verifySheetRef_(CK, '$' + resultCol + '$' + PL_FIRST + ':$' + resultCol + '$' + plLast) + ',"✗*")';
  var profitRow = plAt[profitCode];
  var infoRows = [];
  infoRows[0] = [{ v: '損益驗算檔', s: 'title' }];
  infoRows[2] = [{ v: '車型', s: 'labelBold' }, null, { v: typeId, s: 'label' }];
  infoRows[3] = [{ v: '情境', s: 'labelBold' }, null, { v: scenarioLabel + '（' + (scenario.ScenarioType || SCENARIO_TYPE_BASELINE) + '）', s: 'label' }];
  infoRows[4] = [{ v: '車系', s: 'labelBold' }, null, { v: vehicles.map(function (v) { return v.label; }).join('、'), s: 'label' }];
  infoRows[5] = [{ v: '匯出時間', s: 'labelBold' }, null, { v: formatDateTime_(new Date()), s: 'label' }];
  infoRows[7] = [{ v: '驗算結果', s: 'labelBold' }, null,
    { f: 'IF(' + mismatchFormula + '=0,"✓ Excel 重算的 ' + lines.length + ' 個科目全部跟系統一致","✗ 有 "&' + mismatchFormula + '&" 個科目跟系統不一致，見「驗算」頁")', v: '✓ Excel 重算的 ' + lines.length + ' 個科目全部跟系統一致', s: 'big' }];
  infoRows[8] = [{ v: '不一致的科目數', s: 'labelBold' }, null, { f: mismatchFormula, v: 0, s: 'int' }];
  if (profitRow) {
    infoRows[9] = [{ v: (defsByCode[profitCode] || {}).LineName + '（加權平均，元/台）', s: 'labelBold' }, null,
      { f: verifySheetRef_(PL, wCol + profitRow), v: weighted[profitCode] || 0, s: 'link' }, { v: 'Excel 重算', s: 'note' }];
    infoRows[10] = [{ v: '　系統數字', s: 'label' }, null, { v: weighted[profitCode] || 0, s: 'sys' }, { v: '匯出當下', s: 'note' }];
  }
  infoRows[11] = [{ v: '容差（元）', s: 'labelBold' }, null, { v: 0.01, s: 'input' }, { v: '差異超過這個數字才算不一致，可以改', s: 'note' }];
  var guide = [
    ['工作表', ''],
    ['說明', '這一頁：驗算結果總覽與使用方式'],
    ['輸入', '這個情境從系統帶出來的輸入值：銷售構成與售價、參數、匯率、系統變數、手動輸入金額' + (refKeys.length ? '、跨情境引用' : '')],
    ['開發總投', '每一筆開發投資的台幣金額、低減後、各車系單台攤提，最下面依攤提落點彙總'],
    ['損益試算', '每個科目 × 每個車系都是 Excel 公式(由「科目與公式」頁的公式翻譯)，加權平均 = SUMPRODUCT(各車系, 構成比)'],
    ['驗算', '系統數字(匯出當下的固定值)與 Excel 重算的差異，逐格比對'],
    ['公式區', '每個科目的系統公式與 Excel 公式並排，最右邊是跟系統預設算法的比較；最下面是名稱對照表：公式裡的 [名稱] 引用哪一格'],
    ['結構檢查', '用系統預設的算法(C = A − B、E = C − Σ子科目…)在 Excel 另外算一次各段小計，跟損益試算比'],
    ['科目影響', '每個明細科目多 1 元時營業淨利變多少：成本費用 −1、收入 +1，0 = 沒算進去、−2 = 重複算'],
    ['變動檢查', '匯出時選了快照才有：每個科目 快照 → 現在 的差異，以及公式有沒有改過'],
    ['', ''],
    ['怎麼用', ''],
    ['1', '打開檔案時 Excel 會重算全部公式。先看上面的「驗算結果」：全部一致 = 系統的計算跟 Excel 用同一套公式算出來一樣。'],
    ['2', '想知道某個科目怎麼算：到「公式區」找那一列，左邊是系統公式(科目名稱)，右邊是 Excel 公式；點「損益試算」那一格也看得到公式。'],
    ['3', '想試算：改「輸入」或「開發總投」的藍字，損益試算跟著變；「驗算」頁會顯示跟匯出當時的差異(那是你改的影響，不是錯誤)。'],
    ['4', '改了公式或科目之後：看上面「改公式、改科目之後的檢查」四項。驗算一致只代表系統照公式算對了；公式本身改得對不對，要看這四項。'],
    ['5', '顏色：藍字黃底 = 輸入值；黑字 = 公式；綠字 = 引用其他工作表；灰底 = 系統數字(固定值)。'],
    ['', ''],
    ['翻譯規則', ''],
    ['科目', '科目代碼、[科目名稱] → 損益試算表同一個車系欄那個科目的格子'],
    ['[名稱]', '系統變數、參數(% 參數是小數)、匯率 → 「輸入」表的格子；公式區最下面有完整對照'],
    ['CHILDREN()', '子科目合計 → SUM(子科目的格子)'],
    ['TAXDEDUCT()', '勾「貨物稅完稅價格可扣除」的科目合計 → SUM(那些科目的格子)'],
    ['除法', '系統的除以 0 = 0，所以分母不是固定數字時寫成 IF(分母=0,0,分子/分母)'],
    ['ROUND', 'ROUND / ROUNDUP / ROUNDDOWN 跟 Excel 同樣是「遠離 0」的四捨五入'],
    ['REF()', '另一個情境的科目 → 「輸入」表「跨情境引用」那一列帶入數字(要驗那個情境，另外匯出它的驗算檔)'],
    ['開發總投攤提', '「開發總投」表：低減後 ÷ 攤提總台數(只攤給部分車系的 ÷ 那幾個車系的攤提台數)，依攤提落點 SUMIF']
  ];
  var stCount = 'COUNTIF(' + verifySheetRef_(ST, '$' + stResultCol + '$' + stFirst + ':$' + stResultCol + '$' + stLast) + ',"✗*")';
  infoRows[13] = [{ v: '改公式、改科目之後的檢查（不依賴目前的公式）', s: 'section' }, { v: '', s: 'section' }, { v: '', s: 'section' }, { v: '', s: 'section' }];
  infoRows[14] = [{ v: '結構檢查', s: 'labelBold' }, null,
    { f: 'IF(' + stCount + '=0,"✓ 各段小計跟系統預設的算法一致","✗ 有 "&' + stCount + '&" 段小計跟預設算法不同，見「結構檢查」")',
      v: stBad ? '✗ 有 ' + stBad + ' 段小計跟預設算法不同，見「結構檢查」' : '✓ 各段小計跟系統預設的算法一致', s: 'label' }, { f: stCount, v: stBad, s: 'int' }];
  infoRows[15] = [{ v: '科目對淨利的影響', s: 'labelBold' }, null,
    { v: impactBad ? '✗ 有 ' + impactBad + ' 個科目沒算進營業淨利、重複計算或正負號相反，見「科目影響」' : '✓ 每個明細科目都剛好算進營業淨利一次', s: 'label' }, { v: impactBad, s: 'int' }];
  infoRows[16] = [{ v: '跟系統預設比較', s: 'labelBold' }, null,
    { v: stdDiffCount ? '⚠ 有 ' + stdDiffCount + ' 個科目的算法跟系統預設不同（含新增的科目），見「公式區」最右邊兩欄' : '✓ 所有科目都是系統預設的算法', s: 'label' }, { v: stdDiffCount, s: 'int' }];
  if (snap) {
    var chCount = 'COUNTIF(' + verifySheetRef_(CH, '$' + chJudgeCol + '$5:$' + chJudgeCol + '$' + chLast) + ',"⚠*")';
    infoRows[17] = [{ v: '跟快照比較', s: 'labelBold' }, null,
      { f: 'IF(' + chCount + '=0,"✓ 沒有「公式沒改、數字卻變了」的科目","⚠ 有 "&' + chCount + '&" 個科目公式沒改、數字卻變了，見「變動檢查」")',
        v: chWarn ? '⚠ 有 ' + chWarn + ' 個科目公式沒改、數字卻變了，見「變動檢查」' : '✓ 沒有「公式沒改、數字卻變了」的科目', s: 'label' }, { f: chCount, v: chWarn, s: 'int' }];
    infoRows[18] = [{ v: '　快照', s: 'label' }, null, { v: snapLabel, s: 'label' }];
  } else {
    infoRows[17] = [{ v: '跟快照比較', s: 'labelBold' }, null, { v: '沒有選快照：改公式、科目之前先存情境快照，匯出時選它，就會多一頁「變動檢查」', s: 'note' }, { v: '', s: 'label' }];
  }
  var gr = 20;
  guide.forEach(function (g) {
    if (!g[0] && !g[1]) { gr++; return; }
    infoRows[gr++] = g[1] ? [{ v: g[0], s: 'labelBold' }, null, { v: g[1], s: 'wrap' }] : [{ v: g[0], s: 'section' }, { v: '', s: 'section' }, { v: '', s: 'section' }];
  });

  var sheets = [
    { name: INFO, rows: infoRows, cols: [26, 2, 110, 10], merges: [], cf: [
      { ref: 'C8', formula: 'LEFT($C$8,1)="✗"', style: 'bad' }, { ref: 'C8', formula: 'LEFT($C$8,1)="✓"', style: 'good' },
      { ref: 'C15:C18', formula: 'OR(LEFT($C15,1)="✗",LEFT($C15,1)="⚠")', style: 'bad' }, { ref: 'C15:C18', formula: 'LEFT($C15,1)="✓"', style: 'good' }] },
    { name: IN, rows: inRows, cols: [30, 12, 14].concat(vehicles.map(function () { return 14; })).concat([48]), freeze: { row: 4, col: 3 } },
    { name: DEV, rows: devSheet.rows, cols: devSheet.cols, freeze: devSheet.freeze },
    { name: PL, rows: plRows, cols: [7, 30, 12].concat(vehicles.map(function () { return 15; })).concat([15]), freeze: { row: PL_HEADER_ROW, col: 3 } },
    { name: CK, rows: ckRows, cols: [7, 26].concat(new Array(nCols * 2).join(',').split(',').map(function () { return 13; })).concat([12]), freeze: { row: PL_HEADER_ROW, col: 2 },
      cf: [{ ref: resultCol + PL_FIRST + ':' + resultCol + plLast, formula: 'LEFT($' + resultCol + PL_FIRST + ',1)="✗"', style: 'bad' },
        { ref: resultCol + PL_FIRST + ':' + resultCol + plLast, formula: 'LEFT($' + resultCol + PL_FIRST + ',1)="✓"', style: 'good' }] },
    { name: FM, rows: fmRows, cols: [7, 22, 12, 14, 48, 30, 60, 46, 11, 40, 30], freeze: { row: 4, col: 2 },
      cf: [{ ref: 'I5:I' + (4 + lines.length * 4), formula: 'LEFT($I5,1)="✗"', style: 'bad' },
        { ref: 'K5:K' + (4 + lines.length * 4), formula: 'AND($K5<>"",$K5<>"相同")', style: 'warn' }] },
    { name: ST, rows: stRows, cols: [7, 30, 56].concat(vehicles.map(function () { return 13; })).concat([13, 18]), freeze: { row: 4, col: 1 },
      cf: [{ ref: stResultCol + stFirst + ':' + stResultCol + stLast, formula: 'LEFT($' + stResultCol + stFirst + ',1)="✗"', style: 'bad' },
        { ref: stResultCol + stFirst + ':' + stResultCol + stLast, formula: 'LEFT($' + stResultCol + stFirst + ',1)="✓"', style: 'good' }] },
    { name: IM, rows: imRows, cols: [7, 26, 18].concat(vehicles.map(function () { return 12; })).concat([7, 40]), freeze: { row: 4, col: 2 },
      cf: [{ ref: imResultCol + '5:' + imResultCol + imLast, formula: 'LEFT($' + imResultCol + '5,1)="✗"', style: 'bad' },
        { ref: imResultCol + '5:' + imResultCol + imLast, formula: 'LEFT($' + imResultCol + '5,1)="✓"', style: 'good' }] }
  ];
  if (chRows) {
    sheets.push({ name: CH, rows: chRows, cols: [7, 24, 12, 14, 14].concat(vehicles.map(function () { return 12; })).concat([12, 36, 40, 40]), freeze: { row: 4, col: 2 },
      cf: [{ ref: chJudgeCol + '5:' + chJudgeCol + chLast, formula: 'LEFT($' + chJudgeCol + '5,1)="⚠"', style: 'bad' },
        { ref: chJudgeCol + '5:' + chJudgeCol + chLast, formula: 'LEFT($' + chJudgeCol + '5,1)="✓"', style: 'good' },
        { ref: 'C5:C' + chLast, formula: 'AND($C5<>"",$C5<>"相同")', style: 'warn' }] });
  }
  var fileName = '驗算_' + [typeId, scenarioLabel].filter(function (x) { return x; }).join('_').replace(/[\\\/:*?"<>|\s]+/g, '_') + '.xlsx';
  return {
    model: { title: '損益驗算檔 ' + typeId + ' ' + scenarioLabel, sheets: sheets },
    fileName: fileName,
    meta: {
      vehicles: vehicles, lines: lines.map(function (d) { return d.LineCode; }), plFirstRow: PL_FIRST, plAt: plAt,
      firstVehicleCol: VC, weightedCol: wCol, profitCode: profitCode, sheets: VERIFY_SHEETS_,
      fallbacks: Object.keys(formulaNotes).filter(function (c) { return formulaNotes[c].fallback; }),
      errors: Object.keys(cellErrors),
      structureChecks: stChecks.map(function (c) { return c.label; }), structureBad: stBad, changeWarn: chWarn, impactBad: impactBad, stdDiffCount: stdDiffCount, coef: coef,
      hasChanges: !!chRows
    }
  };
}

function formatDateTime_(d) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 前端呼叫：匯出某情境的 Excel 驗算檔。回傳 { fileName, base64, lines, vehicles, fallbacks }。
 */
function exportVerifyWorkbook(scenarioId, snapshotId) {
  var built = buildVerifyWorkbookModel_(scenarioId, { snapshotId: snapshotId || '' });
  return {
    fileName: built.fileName,
    base64: buildXlsxBase64_(built.model),
    lines: built.meta.lines.length,
    vehicles: built.meta.vehicles.length,
    fallbacks: built.meta.fallbacks,
    errors: built.meta.errors,
    impactBad: built.meta.impactBad,
    stdDiffCount: built.meta.stdDiffCount
  };
}
