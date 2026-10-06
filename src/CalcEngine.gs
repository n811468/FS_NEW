/**
 * 損益計算引擎：依每個車型自己的科目表(公式)算損益。
 *
 * 以前 Gate F 的公式鏈(售價結構 → 收入 → 銷貨成本 → … → 營業淨利)寫死在這裡；現在每個科目的
 * 計算來源都是資料(見 ChartService.gs)：手動輸入 / 公式 / 開發總投攤提。標準範本的預設公式
 * 跟原本寫死的算法逐格相同(tools/verify-gatef.js 用實際 Gate F 表驗算 317 格)：
 *   P6 營業稅 = ROUND(P5 × 稅率 ÷ (1+稅率))、P7 佣金 = ROUND((P5-P6) × 佣金率)、P8 廠價 = P5-P6-P7
 *   b13 貨物稅 = (P8 - 水平配件調降 - TAXDEDUCT()) × 完稅價格計算率 ÷ (1+貨物稅率) × 貨物稅率
 *   d4 季Margin = P8 × 季Margin率；B/E/G/I 小計 = CHILDREN()；K = I - J
 *   開發總投攤提 = 低減後投資額 ÷ LIFE CYCLE 總台數(可以只攤給部分車系)
 * 所有比率參數以百分比數值儲存(5 = 5%)，公式裡用 [參數名] 取用時自動換成小數。
 * 外幣的成本/開發投資用「匯率設定」頁的現況匯率換算。
 */

/** 百分比數值(0~100) -> 小數 */
function pct_(v) {
  return toNumber_(v) / 100;
}

/**
 * 取某幣別換算台幣的匯率(1 外幣 = ? 台幣)。
 * 本位幣或沒設定匯率時回傳 1，讓金額原封不動帶入，不會因為忘了設匯率就被歸零。
 */
function fxRateFor_(params, currency, vehicleId) {
  if (!currency || currency === BASE_CURRENCY) return 1;
  var match = params.filter(function (p) {
    return p.ParamName === COST_FX_PARAM_NAME && p.Currency === currency &&
      (!p.VehicleID || p.VehicleID === vehicleId);
  });
  var specific = match.filter(function (p) { return p.VehicleID === vehicleId; });
  var picked = specific.length ? specific[0] : match[0];
  return picked ? (toNumber_(picked.Value) || 1) : 1;
}

/* ---------------------------------------------------------------
 * 假設分析(What-if)：目標反推與敏感度表要「假設月銷量變成 N、售價調 x%、某科目降 y%…」重算損益，
 * 但完全不能動到存檔的資料。做法是在計算期間掛一組只存在記憶體裡的覆寫(CALC_OVERRIDES_)，
 * 計算引擎讀銷售構成/參數/科目金額時套上去，算完立刻拿掉(見 WhatIfService.gs withOverrides_)。
 *   { scenarioId, volume: 倍數, price: 倍數, lineScale: {科目: 倍數}, dev: 倍數,
 *     params: {參數名稱: 值(原單位)}, fx: {幣別: 匯率} }
 * 只套在指定的情境上；REF 引用到的其他情境照原本的資料算。
 * --------------------------------------------------------------- */
var CALC_OVERRIDES_ = null;
function overridesFor_(scenarioId) {
  return CALC_OVERRIDES_ && CALC_OVERRIDES_.scenarioId === scenarioId ? CALC_OVERRIDES_ : null;
}
function calcSalesMix_(scenarioId) {
  var rows = getSalesMix(scenarioId);
  var o = overridesFor_(scenarioId);
  // 倍數 0 也是有效的假設(銷量 0 台、售價 0)：用 !== undefined 判斷，不能用真假值
  if (!o || (o.volume === undefined && o.price === undefined)) return rows;
  return rows.map(function (r) {
    var c = {};
    Object.keys(r).forEach(function (k) { c[k] = r[k]; });
    if (o.volume !== undefined) c.MonthlyVolume = toNumber_(r.MonthlyVolume) * o.volume;
    if (o.price !== undefined) c.ListPriceTaxIncl = toNumber_(r.ListPriceTaxIncl) * o.price;
    return c;
  });
}
function calcParameters_(scenarioId) {
  var params = getParameters(scenarioId);
  var o = overridesFor_(scenarioId);
  if (!o || (!o.params && !o.fx)) return params;
  var p = o.params || {}, fx = o.fx || {};
  var out = params.filter(function (r) {
    if (p[r.ParamName] !== undefined) return false;
    if (r.ParamName === COST_FX_PARAM_NAME && fx[r.Currency] !== undefined) return false;
    return true;
  });
  Object.keys(p).forEach(function (name) { out.push({ ParamName: name, VehicleID: '', ScenarioID: scenarioId, Value: p[name], Currency: '' }); });
  Object.keys(fx).forEach(function (cur) { out.push({ ParamName: COST_FX_PARAM_NAME, VehicleID: '', ScenarioID: scenarioId, Value: fx[cur], Currency: cur }); });
  return out;
}
function overrideLineScale_(scenarioId, code) {
  var o = overridesFor_(scenarioId);
  return o && o.lineScale && o.lineScale[code] !== undefined ? o.lineScale[code] : 1;
}
function overrideDevScale_(scenarioId) {
  var o = overridesFor_(scenarioId);
  return o && o.dev !== undefined ? o.dev : 1;
}

/**
 * 算損益並把結果寫回 PLResult 快照（快照給外部讀取用，畫面一律用不寫入的 calculatePLCore_）。
 */
function calculatePL(scenarioId, vehicleId) {
  var result = calculatePLCore_(scenarioId, vehicleId);
  var timestamp = new Date();
  writePLResult_(scenarioId, vehicleId, result.lineValues, result.revenue, result.exFactoryPrice, timestamp);
  return {
    scenarioId: result.scenarioId,
    vehicleId: result.vehicleId,
    calculatedAt: timestamp.toISOString(), // 巢狀 Date 物件會讓 google.script.run 整包回傳變 null，一律轉字串
    revenue: result.revenue,
    exFactoryPrice: result.exFactoryPrice,
    errors: result.errors,
    traces: result.traces,
    lines: result.lines
  };
}

/**
 * 純計算損益：不寫入 PLResult，只回傳算出來的結果。
 * 同一次執行內以「情境|車系」為鍵記住結果(儀表板/報告常常同一個車系被好幾欄用到)。
 * 任何寫入都會透過 invalidateSheetCache_ → resetExecutionCaches_ 清掉，不會讀到舊結果。
 */
var PL_CORE_MEMO_ = {};
var REF_STACK_ = [];   // 跨情境引用(REF)正在計算中的情境|車系，用來擋循環引用
function calculatePLCore_(scenarioId, vehicleId) {
  // 假設分析(目標反推/敏感度)改的數字只在記憶體裡，不能讀/寫一般的計算記憶
  if (CALC_OVERRIDES_ && CALC_OVERRIDES_.scenarioId === scenarioId) return calculatePLWithDefs_(scenarioId, vehicleId, null);
  var key = String(scenarioId) + '|' + String(vehicleId);
  if (!PL_CORE_MEMO_[key]) PL_CORE_MEMO_[key] = calculatePLWithDefs_(scenarioId, vehicleId, null);
  return PL_CORE_MEMO_[key];
}

/**
 * 系統變數：公式裡的 [建議零售價]、[LC總台數] 這類名稱的值(每個車系各一份)。
 */
function systemVariables_(scenarioId, salesMixRow, salesMix, params, vehicleId) {
  var taxRate = pct_(lookupParam_(params, '營業稅率', vehicleId));
  var scrapRaw = toNumber_(salesMixRow.ScrapFee);
  var totalPct = salesMix.reduce(function (s, r) { return s + toNumber_(r.SalesMixPct); }, 0);
  var monthly = toNumber_(salesMixRow.MonthlyVolume);
  var years = toNumber_(salesMixRow.LifeCycleYears);
  return {
    '建議零售價': toNumber_(salesMixRow.ListPriceTaxIncl),
    '強配件售價': toNumber_(salesMixRow.MandatoryAccessoryPrice),
    '廢車處理費': scrapRaw,
    // 廢車處理費可能用含稅或未稅登打，一律換算成含稅(取整，與 Gate F Excel 的 ROUND 一致)，全份損益稅別口徑才一致
    '廢車處理費(含稅)': salesMixRow.ScrapFeeTaxStatus === '未稅' ? Math.round(scrapRaw * (1 + taxRate)) : scrapRaw,
    '水平配件調降': toNumber_(salesMixRow.HorizontalPartsPriceAdj),
    '月銷量': monthly,
    'LC年限': years,
    'LC總台數': monthly * 12 * years,
    '構成比': totalPct ? toNumber_(salesMixRow.SalesMixPct) / totalPct : 0,
    '車型月總台數': salesMix.reduce(function (s, r) { return s + toNumber_(r.MonthlyVolume); }, 0),
    '攤提總台數': getLifeCycleUnits(scenarioId)
  };
}

/**
 * 依科目表(公式)算某情境某車系的損益。overrideDefs 有值時用它取代存檔的科目表(科目設定頁試算用)。
 *
 * 每個科目依計算來源取值：
 *   INPUT     銷貨成本/營業費用頁該車系輸入的金額(外幣依匯率設定換算)
 *   DEV_AMORT 開發總投攤提到這個科目的單台金額(含只攤給部分車系的金額)
 *   FORMULA   公式(車系有個別公式時用個別公式)
 * 公式之間的相依順序由求值時遞迴決定(用到誰就先算誰)，循環引用會被擋下並記錄在 errors。
 * 單一科目的公式出錯不會讓整張損益表掛掉：那一格以 0 計，錯誤訊息放在 errors 給畫面顯示。
 */
/**
 * probe(選用，科目設定頁的公式編輯器用)：{ code, formulas: [...] } —— 整張損益算完之後，
 * 用 code 這個科目的計算環境(CHILDREN() 指它的子科目)另外算每一段公式，回傳在 probes(算不出來是 null)。
 * 公式編輯器靠它顯示「每一行」「每一顆膠囊」目前是多少。
 */
function calculatePLWithDefs_(scenarioId, vehicleId, overrideDefs, probe) {
  var salesMix = calcSalesMix_(scenarioId);
  var salesMixRow = salesMix.filter(function (r) { return r.VehicleID === vehicleId; })[0];
  if (!salesMixRow) throw new Error('找不到 SalesMix 資料：' + scenarioId + ' / ' + vehicleId);

  var defs = overrideDefs || lineDefsForScenario_(scenarioId);
  var params = calcParameters_(scenarioId);
  var vars = systemVariables_(scenarioId, salesMixRow, salesMix, params, vehicleId);
  var paramDefs = {};
  getParamDefs().forEach(function (d) { paramDefs[d.ParamName] = d; });

  var byCode = {}, byName = {}, children = {};
  defs.forEach(function (d) {
    byCode[d.LineCode] = d;
    if (!byName[d.LineName]) byName[d.LineName] = d;
    if (d.ParentLine) (children[d.ParentLine] = children[d.ParentLine] || []).push(d.LineCode);
  });
  var taxDeductCodes = defs.filter(function (d) { return String(d.CommodityTaxDeduct || '').toUpperCase() === 'Y'; })
    .map(function (d) { return d.LineCode; });

  // 手動輸入金額：銷貨成本 + 營業費用兩頁合併，依科目代碼加總(科目已刪除的殘留金額不計入)
  var inputs = {};
  getCostOfSales(scenarioId, vehicleId).concat(getOperatingExpense(scenarioId, vehicleId)).forEach(function (r) {
    if (!r.LineCode || !byCode[r.LineCode]) return;
    inputs[r.LineCode] = (inputs[r.LineCode] || 0) + toNumber_(r.Amount) * fxRateFor_(params, r.Currency, vehicleId);
  });
  var dev = amortizeDevInvestmentPerUnit_(scenarioId, null);

  var values = {}, errors = {}, traces = {}, visiting = {}, excluded = {};

  function devAmount(code) {
    var all = dev.perUnit[code];
    var own = (dev.perVehicle[vehicleId] || {})[code];
    if (all === undefined && own === undefined) return undefined;
    return (all || 0) + (own || 0);
  }

  function valueOf(code) {
    if (values[code] !== undefined) return values[code];
    var d = byCode[code];
    if (!d) throw formulaError_('找不到科目代碼 ' + code);
    if (visiting[code]) throw formulaError_('循環引用（' + d.LineName + '）');
    visiting[code] = true;
    var v = 0;
    try {
      var formula = lineFormulaFor_(d, vehicleId);
      var useFormula = d.CalcType === CALC_TYPES.FORMULA || formula !== '' && parseVehicleFormulas_(d.VehicleFormulas)[vehicleId];
      if (useFormula) {
        v = evalLineFormula_(code, formula);
      } else if (d.CalcType === CALC_TYPES.DEV_AMORT) {
        var amt = devAmount(code);
        // 使用者自訂的攤提落點只有這個情境真的有開發總投列指到這裡才列出來，
        // 否則試用過一次的攤提落點會永遠以 0 留在每一份損益表上
        if (amt === undefined && d.AutoSource === AUTO_SOURCE.DEV_AMORT) excluded[code] = true;
        v = (amt || 0) * overrideDevScale_(scenarioId);
        traces[code] = { kind: 'dev', total: dev.totalsByLine[code] || 0, units: dev.totalUnits, perUnit: v };
      } else {
        v = inputs[code] || 0;
      }
    } catch (e) {
      if (!e.isFormulaError) throw e;
      errors[code] = e.message;
      v = 0;
    }
    visiting[code] = false;
    v = v * overrideLineScale_(scenarioId, code);
    values[code] = typeof v === 'number' && isFinite(v) ? v : 0;
    return values[code];
  }

  function evalLineFormula_(code, formula) {
    var ast = parseFormula_(formula);
    var refs = {};
    var v = evalFormulaAst_(ast, formulaEnv_(code, refs));
    traces[code] = { kind: 'formula', formula: formula, refs: refs };
    return num_(v);
  }

  function formulaEnv_(code, refs) {
    return {
      code: function (c) { var x = valueOf(c); refs[c] = x; return x; },
      name: function (n) {
        var x;
        if (vars.hasOwnProperty(n)) x = vars[n];
        else if (paramDefs[n]) x = paramValueForFormula_(params, paramDefs[n], vehicleId);
        else if (/^[A-Za-z]{3}匯率$/.test(n)) x = fxRateFor_(params, n.slice(0, 3).toUpperCase(), vehicleId);
        else if (byName[n]) x = valueOf(byName[n].LineCode);
        else throw formulaError_('找不到 [' + n + ']');
        refs['[' + n + ']'] = x;
        return x;
      },
      children: function () {
        var sum = (children[code] || []).reduce(function (s, c) { return s + valueOf(c); }, 0);
        refs['CHILDREN()'] = sum;
        return sum;
      },
      taxDeduct: function () {
        var sum = taxDeductCodes.reduce(function (s, c) { return s + valueOf(c); }, 0);
        refs['TAXDEDUCT()'] = sum;
        return sum;
      },
      ref: function (sid, c, vid) {
        var x = referenceValue_(sid, c, vid, vehicleId);
        refs['REF(' + sid + ',' + c + (vid ? ',' + vid : '') + ')'] = x;
        return x;
      }
    };
  }

  var probes = null;
  REF_STACK_.push(String(scenarioId) + '|' + String(vehicleId));
  try {
    defs.forEach(function (d) { valueOf(d.LineCode); });
    if (probe && probe.formulas) {
      probes = probe.formulas.map(function (f) {
        try { return num_(evalFormulaAst_(parseFormula_(f), formulaEnv_(probe.code, {}))); } catch (e) { return null; }
      });
    }
  } finally {
    REF_STACK_.pop();
  }

  var lineValues = {};
  defs.forEach(function (d) { if (!excluded[d.LineCode]) lineValues[d.LineCode] = values[d.LineCode]; });
  var revenue = lineValues.A || 0, exFactory = lineValues.P8 || 0;

  return {
    scenarioId: scenarioId,
    vehicleId: vehicleId,
    revenue: revenue,
    exFactoryPrice: exFactory,
    lineValues: lineValues,
    errors: errors,
    traces: traces,
    probes: probes,
    lines: buildResultLines_(lineValues, revenue, exFactory, defs)
  };
}

/**
 * REF("情境","科目"[,"車系"])：引用另一個情境(可以是別的車型)的科目金額。
 * 情境可以填 ScenarioID，也可以填「車型 GATE 情境名稱」(如 "S3 GATE F 現況")。
 * 沒指定車系時：那個情境有同一個車系就取同一個車系，否則取加權平均。
 */
/**
 * REF 的情境：ScenarioID、「車型 GATE 情境名稱」，或只寫「GATE 情境名稱」(全部車型裡只有一個這樣的情境時)。
 * 存檔時會把名稱換成 ScenarioID(見 codifyRefScenarios_)，之後情境改名公式也不會斷。
 * 找不到回傳 null；名稱對到好幾個情境時丟出錯誤。
 */
function resolveRefScenario_(scenarioRef, scenarios) {
  scenarios = scenarios || getScenarios();
  var ref = String(scenarioRef || '').trim();
  var byId = scenarios.filter(function (s) { return s.ScenarioID === ref; })[0];
  if (byId) return byId;
  var label = function (s, withType) { return [withType ? s.VehicleTypeID : '', s.Gate, s.ScenarioName].filter(function (x) { return x; }).join(' '); };
  var full = scenarios.filter(function (s) { return label(s, true) === ref; });
  if (full.length) return full[0];
  var short = scenarios.filter(function (s) { return label(s, false) === ref; });
  if (short.length > 1) throw formulaError_('REF 的情境「' + ref + '」有好幾個車型都有，請在前面加上車型代號（例：' + label(short[0], true) + '）');
  return short[0] || null;
}
function referenceValue_(scenarioRef, lineCode, vehicleRef, currentVehicleId) {
  var target = resolveRefScenario_(scenarioRef);
  if (!target) throw formulaError_('REF 找不到情境「' + scenarioRef + '」');
  var mix = calcSalesMix_(target.ScenarioID);
  var vid = vehicleRef || (mix.some(function (r) { return r.VehicleID === currentVehicleId; }) ? currentVehicleId : '');
  if (vehicleRef && !mix.some(function (r) { return r.VehicleID === vehicleRef; })) {
    throw formulaError_('REF 的情境沒有車系「' + vehicleRef + '」');
  }
  var keys = vid ? [target.ScenarioID + '|' + vid] : mix.map(function (r) { return target.ScenarioID + '|' + r.VehicleID; });
  keys.forEach(function (k) {
    if (REF_STACK_.indexOf(k) !== -1) throw formulaError_('REF 循環引用：引用的情境又引用回來');
  });
  if (vid) {
    var res = calculatePLCore_(target.ScenarioID, vid);
    if (res.lineValues[lineCode] === undefined) throw formulaError_('REF 的情境沒有科目 ' + lineCode);
    return res.lineValues[lineCode];
  }
  var weighted = calculateScenarioWeighted(target.ScenarioID);
  var line = weighted.filter(function (l) { return l.LineCode === lineCode; })[0];
  if (!line) throw formulaError_('REF 的情境沒有科目 ' + lineCode);
  return line.Amount;
}

/**
 * 某情境(= 某車型)底下所有車系的損益，外加以銷售構成比加權的平均列。
 * 儀表板/報告只是「看」，一律用不寫入快照的 calculatePLCore_()。
 */
function calculatePLAllVehicles(scenarioId) {
  var salesMix = calcSalesMix_(scenarioId);
  var results = salesMix.map(function (row) { return calculatePLCore_(scenarioId, row.VehicleID); });

  // 加權平均列（以 SalesMixPct 加權）
  var totalPct = salesMix.reduce(function (s, r) { return s + toNumber_(r.SalesMixPct); }, 0) || 1;
  var weighted = {};
  results.forEach(function (res, idx) {
    var pct = toNumber_(salesMix[idx].SalesMixPct) / totalPct;
    res.lines.forEach(function (line) {
      weighted[line.LineCode] = (weighted[line.LineCode] || 0) + line.Amount * pct;
    });
  });

  return {
    scenarioId: scenarioId,
    vehicles: results,
    weightedAverage: buildResultLines_(weighted, weighted.A || 0, weighted.P8 || 0, lineDefsForScenario_(scenarioId))
  };
}

/** 單獨取某情境的加權平均損益（儀表板比較欄位用） */
function calculateScenarioWeighted(scenarioId) {
  return calculatePLAllVehicles(scenarioId).weightedAverage;
}

/**
 * 多個科目表合併成一份(比較欄位可能來自不同車型，科目表不同)：
 * 依代碼取聯集，名稱/位置以先出現的車型為準，依呈現順序(displayOrderDefs_，跟 Excel 一樣)排列。
 */
function unionLineDefs_(defLists) {
  var seen = {}, out = [];
  defLists.forEach(function (defs) {
    defs.forEach(function (d) {
      if (seen[d.LineCode]) return;
      seen[d.LineCode] = true;
      out.push(d);
    });
  });
  return displayOrderDefs_(out);
}

/**
 * 多車型/多情境比較：儀表板的核心 API。
 * selections = [{ ScenarioID, VehicleID }]，VehicleID 留空代表該情境的「加權平均」。
 *
 * 回傳的 lines 是所有欄位實際出現過科目的聯集(依呈現順序：扣減型小計排在明細後面，同 Excel)，並且帶上 ParentLine，
 * 讓前端可以把明細科目縮排在它的小計底下。某欄位沒有該科目時值為 null，前端顯示空白而不是 0。
 *
 * 每個欄位另外附 checks(小計驗算)、errors(公式錯誤)、traces(每個公式科目的計算過程，hover 用)。
 */
function calculateComparison(selections) {
  selections = selections || [];
  var vehicleTypes = getVehicleTypes();
  var scenarios = getScenarios();
  var vehicles = getVehicles();
  var defsByType = {};
  var defsOf = function (typeId) {
    if (!defsByType[typeId]) defsByType[typeId] = getPLLineItems(typeId);
    return defsByType[typeId];
  };

  // 算不出來的欄位(例：這個車系在這個情境沒有銷售構成)不拖垮整張比較表：另外列在 unavailable，其他欄位照常算
  var unavailable = [];
  var columns = selections.map(function (sel) {
    if (isSnapshotId_(sel.ScenarioID)) return snapshotColumn_(sel);
    var scenario = scenarios.filter(function (s) { return s.ScenarioID === sel.ScenarioID; })[0] || {};
    var vehicle = vehicles.filter(function (v) { return v.VehicleID === sel.VehicleID; })[0];
    var vehicleType = vehicleTypes.filter(function (t) { return t.VehicleTypeID === scenario.VehicleTypeID; })[0] || {};
    var lineDefs = defsOf(scenario.VehicleTypeID || '');
    var scenarioText = [scenario.Gate || '', scenario.ScenarioName || ''].filter(function (p) { return p; }).join(' ') || sel.ScenarioID;
    var vehicleText = sel.VehicleID ? ((vehicle && vehicle.VehicleCode) || sel.VehicleID) : '加權平均';
    var skip = function (reason) {
      unavailable.push({ scenarioId: sel.ScenarioID, vehicleId: sel.VehicleID || '',
        label: [scenario.VehicleTypeID || '', scenarioText, vehicleText].filter(function (p) { return p; }).join(' / '), reason: reason });
      return null;
    };
    if (sel.VehicleID && !calcSalesMix_(sel.ScenarioID).some(function (r) { return r.VehicleID === sel.VehicleID; })) {
      return skip('「' + scenarioText + '」還沒有「' + vehicleText + '」的銷售構成，到「銷售構成與售價」填，或從比較欄位移除這一欄');
    }

    var vehicleCalc = sel.VehicleID ? calculatePLCore_(sel.ScenarioID, sel.VehicleID) : null;
    var lines = vehicleCalc ? vehicleCalc.lines : calculateScenarioWeighted(sel.ScenarioID);
    var errors = {};
    if (vehicleCalc) errors = vehicleCalc.errors;
    else {
      calcSalesMix_(sel.ScenarioID).forEach(function (r) {
        var res = calculatePLCore_(sel.ScenarioID, r.VehicleID);
        Object.keys(res.errors).forEach(function (c) { if (!errors[c]) errors[c] = res.errors[c]; });
      });
    }

    var amounts = {};
    lines.forEach(function (l) { amounts[l.LineCode] = l.Amount; });

    return {
      scenarioId: sel.ScenarioID,
      vehicleId: sel.VehicleID || '',
      vehicleTypeId: scenario.VehicleTypeID || '',
      vehicleTypeLabel: scenario.VehicleTypeID || vehicleType.VehicleTypeID || '',
      scenarioLabel: [scenario.Gate || '', scenario.ScenarioName || ''].filter(function (p) { return p; }).join(' '),
      scenarioType: scenario.ScenarioType || '',
      scenarioNotes: scenario.Notes || '',
      vehicleLabel: sel.VehicleID ? ((vehicle && vehicle.VehicleCode) || sel.VehicleID) : '加權平均',
      isWeighted: !sel.VehicleID,
      // 銷量資訊：儀表板用來 (1) hover 欄位標題時顯示這一欄的台數基礎 (2) 把單台金額換算成年度/LC 總額
      volume: columnVolumeInfo_(sel.ScenarioID, sel.VehicleID, vehicles),
      traces: vehicleCalc ? vehicleCalc.traces : null,
      errors: errors,
      label: [
        scenario.VehicleTypeID || vehicleType.VehicleTypeID || '',
        scenario.Gate || '',
        scenario.ScenarioName || '',
        sel.VehicleID ? ((vehicle && vehicle.VehicleCode) || sel.VehicleID) : '加權平均'
      ].filter(function (p) { return p; }).join(' / '),
      amounts: amounts,
      revenue: amounts.A || 0,
      exFactoryPrice: amounts.P8 || 0,
      checks: subtotalChecks_(amounts, lineDefs),
      profitCode: profitLineCode_(lineDefs)
    };
  }).filter(function (c) { return c; });

  var allDefs = unionLineDefs_(columns.map(function (c) { return c.snapshotLines || defsOf(c.vehicleTypeId); }));
  columns.forEach(function (c) {
    if (c.snapshotLines) c.profitCode = profitLineCode_(c.snapshotLines);
    delete c.snapshotLines;
  });
  var profitCodes = {};
  columns.forEach(function (c) { if (c.profitCode) profitCodes[c.profitCode] = true; });
  var depth = lineDepths_(allDefs);
  // 只列出至少有一個比較欄位真的算出數字的科目(不同車型科目不同時，表格才不會塞滿空列)
  var usedLines = allDefs.filter(function (def) {
    return columns.some(function (col) { return col.amounts[def.LineCode] !== undefined; });
  }).map(function (def) {
    return {
      LineCode: def.LineCode,
      LineName: def.LineName,
      Category: def.Category,
      ParentLine: def.ParentLine || '',
      SortOrder: toNumber_(def.SortOrder),
      CalcType: def.CalcType,
      Formula: def.CalcType === CALC_TYPES.FORMULA ? def.Formula : '',
      AutoSource: resultAutoSource_(def),
      Depth: depth[def.LineCode] || 0,
      isSubtotal: PROTECTED_LINE_CODES.indexOf(def.LineCode) !== -1 || !!profitCodes[def.LineCode] || isGroupLine_(def, allDefs),
      isProfit: !!profitCodes[def.LineCode],
      isPriceStructure: String(def.Category || '') === '售價結構'
    };
  });

  return { columns: columns, lines: usedLines, subtotalCodes: PROTECTED_LINE_CODES, unavailable: unavailable };
}

/**
 * 哪一個科目是「營業淨利」：預設是 K。K 被刪掉時(例如另外新增一個淨利科目、再把原本的刪掉)，
 * 改用損益表最底下的總計：頂層、不是售價結構、用公式算、而且沒有被其他科目的公式引用的科目，
 * 有好幾個就取損益表上最後一個。不看位置挑「最後一行」，否則最後一行是手動輸入的費用(例如前瞻費用)
 * 時會把費用當成淨利。儀表板重點指標、GATE 報告、損益兩平、目標反推的預設指標都看這裡，不寫死 K。
 */
function profitLineCode_(defs) {
  defs = defs || [];
  if (defs.some(function (d) { return d.LineCode === 'K'; })) return 'K';
  var top = displayOrderDefs_(defs.slice()).filter(function (d) {
    return !d.ParentLine && String(d.Category || '') !== '售價結構';
  });
  if (!top.length) return '';
  var referenced = {};
  defs.forEach(function (d) {
    var formulas = [];
    if (d.CalcType === CALC_TYPES.FORMULA && d.Formula) formulas.push(d.Formula);
    var vf = parseVehicleFormulas_(d.VehicleFormulas);
    Object.keys(vf).forEach(function (k) { if (vf[k]) formulas.push(vf[k]); });
    formulas.forEach(function (f) {
      var info = inspectFormula_(f);
      if (!info.ok) return;
      info.refs.codes.forEach(function (c) { if (c !== d.LineCode) referenced[c] = true; });
      info.refs.names.forEach(function (n) {
        defs.forEach(function (x) { if (x.LineName === n && x.LineCode !== d.LineCode) referenced[x.LineCode] = true; });
      });
    });
  });
  var isFormula = function (d) { return d.CalcType === CALC_TYPES.FORMULA; };
  var pick = top.filter(function (d) { return isFormula(d) && !referenced[d.LineCode]; });
  if (!pick.length) pick = top.filter(isFormula);
  if (!pick.length) pick = top;
  return pick[pick.length - 1].LineCode;
}

/** 科目的縮排層級(父科目鏈長度) */
function lineDepths_(defs) {
  var byCode = {};
  defs.forEach(function (d) { byCode[d.LineCode] = d; });
  var depth = {};
  defs.forEach(function (d) {
    var n = 0, cur = d, guard = 0;
    while (cur && cur.ParentLine && byCode[cur.ParentLine] && guard++ < 20) { n++; cur = byCode[cur.ParentLine]; }
    depth[d.LineCode] = n;
  });
  return depth;
}

/** 有子科目的科目(小計群組) */
function isGroupLine_(def, defs) {
  return defs.some(function (d) { return d.ParentLine === def.LineCode; });
}

/**
 * 給畫面用的「自動計算標記」：沿用舊欄位名稱 AutoSource，讓儀表板的圓點/hover 提示照舊運作。
 * 手動輸入 = 空白；結構小計 = 空白(看名稱就知道)；其餘公式 = FORMULA；開發總投攤提 = DEV_AMORT 類。
 */
function resultAutoSource_(def) {
  if (def.CalcType === CALC_TYPES.DEV_AMORT) return def.AutoSource || AUTO_SOURCE.DEV_AMORT;
  if (def.CalcType === CALC_TYPES.FORMULA) {
    if (PROTECTED_LINE_CODES.indexOf(def.LineCode) !== -1) return '';
    return 'FORMULA';
  }
  return '';
}

/**
 * 比較欄位的銷量基礎。
 * 單一車系：該車系在銷售構成表上的月銷量、LC 年限、構成比，總台數 = 月銷量 × 12 × LC年限。
 * 加權平均：月銷量/總台數是該情境所有車系加總，並附上各車系的構成比(mix)。
 */
function columnVolumeInfo_(scenarioId, vehicleId, vehicles) {
  var rows = calcSalesMix_(scenarioId);
  var nameOf = function (id) {
    var v = vehicles.filter(function (x) { return x.VehicleID === id; })[0];
    return (v && v.VehicleCode) || id;
  };
  var unitsOf = function (r) { return toNumber_(r.MonthlyVolume) * 12 * toNumber_(r.LifeCycleYears); };
  if (vehicleId) {
    var row = rows.filter(function (r) { return r.VehicleID === vehicleId; })[0] || {};
    return {
      monthlyVolume: toNumber_(row.MonthlyVolume),
      lifeCycleYears: toNumber_(row.LifeCycleYears),
      units: unitsOf(row),
      salesMixPct: toNumber_(row.SalesMixPct),
      mix: []
    };
  }
  var totalPct = rows.reduce(function (s, r) { return s + toNumber_(r.SalesMixPct); }, 0);
  var years = rows.map(function (r) { return toNumber_(r.LifeCycleYears); }).filter(function (y) { return y > 0; });
  return {
    monthlyVolume: rows.reduce(function (s, r) { return s + toNumber_(r.MonthlyVolume); }, 0),
    lifeCycleYears: years.length ? Math.min.apply(null, years) : 0,
    lifeCycleYearsMax: years.length ? Math.max.apply(null, years) : 0,
    units: rows.reduce(function (s, r) { return s + unitsOf(r); }, 0),
    salesMixPct: totalPct,
    mix: rows.map(function (r) {
      return { vehicleLabel: nameOf(r.VehicleID), pct: toNumber_(r.SalesMixPct), monthlyVolume: toNumber_(r.MonthlyVolume) };
    })
  };
}

/**
 * 小計驗算：把損益鏈上的線性等式用畫面上要顯示的同一組數字重算一次，回傳對不起來的項目。
 * 只驗「還是預設公式」的結構科目 —— 使用者改過公式的科目，等式本來就不同，驗了只會誤報。
 * (加權平均欄位是逐科目加權，非線性的公式(取整、乘費率)本來就不會剛好相等，所以只驗加減式。)
 */
function subtotalChecks_(amounts, lineDefs) {
  var v = function (code) { return Number(amounts[code]) || 0; };
  var byCode = {};
  lineDefs.forEach(function (d) { byCode[d.LineCode] = d; });
  var sumChildren = function (parent) {
    return lineDefs.filter(function (d) { return d.ParentLine === parent; })
      .reduce(function (sum, d) { return sum + v(d.LineCode); }, 0);
  };
  var nameOf = function (code) { return byCode[code] ? byCode[code].LineName : code; };

  var equations = [
    { code: 'A', label: 'A ' + nameOf('A') + ' = P8 + P9', expected: v('P8') + v('P9') },
    { code: 'B', label: 'B ' + nameOf('B') + ' = Σ 成本明細', expected: sumChildren('B') },
    { code: 'C', label: 'C ' + nameOf('C') + ' = A - B', expected: v('A') - v('B') },
    { code: 'E', label: 'E ' + nameOf('E') + ' = C - Σ 銷售費用', expected: v('C') - sumChildren('E') },
    { code: 'G', label: 'G ' + nameOf('G') + ' = E - Σ 產品貢獻前費用', expected: v('E') - sumChildren('G') },
    { code: 'I', label: 'I ' + nameOf('I') + ' = G - Σ 固定營業費用', expected: v('G') - sumChildren('I') },
    { code: 'K', label: 'K ' + nameOf('K') + ' = I - J', expected: v('I') - v('J') }
  ];

  return equations.filter(function (eq) {
    var d = byCode[eq.code];
    if (!d || amounts[eq.code] === undefined) return false;
    if (d.CalcType !== CALC_TYPES.FORMULA || cleanFormulaText_(d.Formula) !== cleanFormulaText_(DEFAULT_FORMULAS[eq.code])) return false;
    // 容差 0.5 元：營業稅/佣金有四捨五入，差幾角不是錯誤
    return Math.abs(eq.expected - v(eq.code)) > 0.5;
  }).map(function (eq) {
    return { code: eq.code, label: eq.label, expected: eq.expected, actual: v(eq.code), diff: v(eq.code) - eq.expected };
  });
}

/** 儀表板比較欄位選擇器用：一次回傳車型 -> 情境/車系的完整選項樹 */
function getComparisonOptions() {
  var scenarios = getScenarios();
  var vehicles = getVehicles();
  return getVehicleTypes().map(function (t) {
    return {
      VehicleTypeID: t.VehicleTypeID,
      scenarios: scenarios.filter(function (s) { return s.VehicleTypeID === t.VehicleTypeID; })
        .map(function (s) {
          return { ScenarioID: s.ScenarioID, Gate: s.Gate || '', ScenarioName: s.ScenarioName || '', ScenarioType: s.ScenarioType || '' };
        }),
      vehicles: vehicles.filter(function (v) { return v.VehicleTypeID === t.VehicleTypeID; })
        .map(function (v) { return { VehicleID: v.VehicleID, VehicleCode: v.VehicleCode || '' }; })
    };
  }).map(function (t) {
    // 情境快照當成「唯讀情境」一起列出(代號 snap:xxx)，儀表板、瀑布圖工具就能直接拿來比較
    t.scenarios = t.scenarios.concat(snapshotScenarioOptions_(t.VehicleTypeID));
    return t;
  });
}

/** 開發總投「分攤車系」：逗號分隔的車系代號，留白 = 全車系 */
function parseVehicleScope_(v) {
  if (!v) return [];
  return String(v).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
}

/**
 * 各車系的攤提台數：情境有填攤提基準時，依構成比分配基準總台數；沒填就用該車系的 月銷量×12×LC年限。
 * 「只攤給部分車系」的投資(如中低規式樣、TNCAP 只有部分車系要)用這組台數當分母。
 */
function vehicleAmortUnits_(scenarioId) {
  var mix = calcSalesMix_(scenarioId);
  var total = getLifeCycleUnits(scenarioId);
  var basisSet = (function () {
    var s = getScenarios().filter(function (r) { return r.ScenarioID === scenarioId; })[0];
    return s && toNumber_(s.AmortMonthlyVolume) > 0 && toNumber_(s.AmortLifeCycleYears) > 0;
  })();
  var totalPct = mix.reduce(function (s, r) { return s + toNumber_(r.SalesMixPct); }, 0);
  var units = {};
  mix.forEach(function (r) {
    units[r.VehicleID] = basisSet
      ? (totalPct ? total * toNumber_(r.SalesMixPct) / totalPct : 0)
      : toNumber_(r.MonthlyVolume) * 12 * toNumber_(r.LifeCycleYears);
  });
  return units;
}

/**
 * 依 DevInvestment 攤提出單台開發成本，依每一列自選的攤提落點科目(TargetLineCode)分組加總。
 *   - 全車系分攤的列：÷ LIFE CYCLE 總台數，結果放在 perUnit(每個車系都一樣)
 *   - 只分攤給部分車系的列(VehicleScope)：÷ 那幾個車系的攤提台數合計，結果只加在那幾個車系(perVehicle)
 * totalsByLine 是每個落點科目的投資總額(低減後)，含兩種分攤方式。
 *
 * overrideRows 可選：開發總投頁面「先試算、還沒儲存」用。
 */
function amortizeDevInvestmentPerUnit_(scenarioId, overrideRows) {
  var devRows = overrideRows || getDevInvestment(scenarioId);
  var totalUnits = getLifeCycleUnits(scenarioId);
  var empty = { perUnit: {}, perVehicle: {}, totalsByLine: {}, totalUnits: totalUnits };
  if (totalUnits <= 0) return empty;

  // 現況情境沒有挑戰低減目標，一律用原始金額；目標情境才套用低減率。
  var isBaseline = isBaselineScenario_(scenarioId);
  var params = calcParameters_(scenarioId);
  var vUnits = null;

  var totals = {}, shared = {}, perVehicle = {};
  devRows.forEach(function (r) {
    var target = devAmortTargetOf_(r);
    if (!target) return;   // 沒選攤提落點的列不攤提(儲存時已擋下有金額卻沒選的情形)
    // 投入金額可用外幣登打(如 BASE廠開發費以 CNY 計)，換算方式與銷貨成本一致
    var amount = toNumber_(r.Amount) * fxRateFor_(params, r.Currency, '');
    // ChallengeReductionPct 以 0~100 的百分比數值儲存(如 15 代表 15%)
    var reduced = amount * (isBaseline ? 1 : 1 - pct_(r.ChallengeReductionPct));
    totals[target] = (totals[target] || 0) + reduced;
    var scope = parseVehicleScope_(r.VehicleScope);
    if (!scope.length) {
      shared[target] = (shared[target] || 0) + reduced;
      return;
    }
    vUnits = vUnits || vehicleAmortUnits_(scenarioId);
    var scopeUnits = scope.reduce(function (s, id) { return s + (vUnits[id] || 0); }, 0);
    if (scopeUnits <= 0) return;
    scope.forEach(function (id) {
      if (!vUnits[id]) return;
      perVehicle[id] = perVehicle[id] || {};
      perVehicle[id][target] = (perVehicle[id][target] || 0) + reduced / scopeUnits;
    });
  });

  var perUnit = {};
  Object.keys(shared).forEach(function (code) { perUnit[code] = shared[code] / totalUnits; });
  // 只攤給部分車系的落點：其他車系也要看得到這個科目(值 0)，所以 perUnit 補 0
  Object.keys(perVehicle).forEach(function (id) {
    Object.keys(perVehicle[id]).forEach(function (code) { if (perUnit[code] === undefined) perUnit[code] = 0; });
  });

  return { perUnit: perUnit, perVehicle: perVehicle, totalsByLine: totals, totalUnits: totalUnits };
}

/** 是否為現況情境（現況沒有挑戰低減目標） */
function isBaselineScenario_(scenarioId) {
  var s = getScenarios().filter(function (r) { return r.ScenarioID === scenarioId; })[0];
  return !s || !s.ScenarioType || s.ScenarioType === SCENARIO_TYPE_BASELINE;
}

/**
 * 開發總投攤提用的 LIFE CYCLE 總台數。
 * 情境若有填「攤提基準台數」(AmortMonthlyVolume × 12 × AmortLifeCycleYears)就以它為準，
 * 因為實務上開發投資的攤提基準台數常與銷售構成的預估台數不同。沒填就用銷售構成推算。
 */
function getLifeCycleUnits(scenarioId) {
  var scenario = getScenarios().filter(function (s) { return s.ScenarioID === scenarioId; })[0];
  if (scenario) {
    var o = overridesFor_(scenarioId);
    var vol = toNumber_(scenario.AmortMonthlyVolume) * (o && o.volume !== undefined ? o.volume : 1);
    var years = toNumber_(scenario.AmortLifeCycleYears);
    if (vol > 0 && years > 0) return vol * 12 * years;
  }
  return getSalesMixLifeCycleUnits(scenarioId);
}

/** 銷售構成推算的 LIFE CYCLE 總台數 = Σ(預估銷售台數(月) × 12 × LC年限) */
function getSalesMixLifeCycleUnits(scenarioId) {
  return calcSalesMix_(scenarioId).reduce(function (sum, r) {
    return sum + toNumber_(r.MonthlyVolume) * 12 * toNumber_(r.LifeCycleYears);
  }, 0);
}

/**
 * 開發總投頁面用：回傳低減後金額與單台攤提，讓使用者直接看到攤提結果。
 * overrideRows 可選：見 amortizeDevInvestmentPerUnit_ 的說明，用來在還沒儲存前先試算彙總數字。
 */
function getDevInvestmentSummary(scenarioId, overrideRows) {
  var typeId = vehicleTypeOfScenario_(scenarioId);
  var perUnit = amortizeDevInvestmentPerUnit_(scenarioId, overrideRows);
  var isBaseline = isBaselineScenario_(scenarioId);
  var lineNames = {};
  getPLLineItems(typeId).forEach(function (d) { lineNames[d.LineCode] = d.LineName; });
  var targetOptions = getDevAmortTargetOptions(typeId);
  var vehicles = getVehicles(typeId).map(function (v) { return { VehicleID: v.VehicleID, VehicleCode: v.VehicleCode || '' }; });

  // 部門列的呈現順序使用者可以自己在畫面上拖曳調整，留白排最後、相對順序穩定
  var rows = sortByOrder_(getDevInvestment(scenarioId), 'SortOrder').map(function (r) {
    var pctValue = isBaseline ? 0 : toNumber_(r.ChallengeReductionPct);
    var target = devAmortTargetOf_(r);
    return {
      RowID: r.RowID,
      Department: r.Department,
      Currency: r.Currency || BASE_CURRENCY,
      Notes: r.Notes || '',
      Amount: toNumber_(r.Amount),
      ChallengeReductionPct: pctValue,
      ReducedAmount: toNumber_(r.Amount) * (1 - pctValue / 100),
      TargetLineCode: target,
      TargetLineName: target ? (lineNames[target] || target) : '',
      VehicleScope: parseVehicleScope_(r.VehicleScope).join(','),
      SortOrder: r.SortOrder === undefined || r.SortOrder === '' ? '' : r.SortOrder
    };
  });
  var scenario = getScenarios().filter(function (s) { return s.ScenarioID === scenarioId; })[0] || {};
  var currencies = getConfiguredCurrencies(scenarioId);
  var params = getParameters(scenarioId);
  var fxRates = {};
  currencies.forEach(function (c) { fxRates[c] = c === BASE_CURRENCY ? 1 : fxRateFor_(params, c, ''); });
  return {
    lifeCycleUnits: perUnit.totalUnits,
    salesMixLifeCycleUnits: getSalesMixLifeCycleUnits(scenarioId),
    targetOptions: targetOptions,
    vehicles: vehicles,
    // 每個落點科目的投資總額(低減後)與單台攤提(加權平均)，讓「開發總投 → 損益科目」對得起來
    targets: targetOptions.map(function (opt) {
      var code = opt.value;
      var perVehicle = {};
      vehicles.forEach(function (v) {
        perVehicle[v.VehicleID] = (perUnit.perUnit[code] || 0) + ((perUnit.perVehicle[v.VehicleID] || {})[code] || 0);
      });
      return {
        LineCode: code, LineName: opt.label,
        Total: perUnit.totalsByLine[code] || 0,
        PerUnit: perUnit.totalUnits ? (perUnit.totalsByLine[code] || 0) / perUnit.totalUnits : 0,
        PerVehicle: perVehicle
      };
    }),
    amortMonthlyVolume: scenario.AmortMonthlyVolume === undefined ? '' : scenario.AmortMonthlyVolume,
    amortLifeCycleYears: scenario.AmortLifeCycleYears === undefined ? '' : scenario.AmortLifeCycleYears,
    currencies: currencies,
    // 外幣換算成台幣(畫面上部門彙總用，跟攤提計算同一個匯率)
    fxRates: fxRates,
    deptNotes: getDevDeptNotes(scenarioId),
    perUnit: perUnit, isBaseline: isBaseline, rows: rows
  };
}

/** 開發總投頁面：還沒存檔的編輯內容先試算彙總表(唯讀) */
function previewDevInvestmentSummary(scenarioId, rows) {
  var summary = getDevInvestmentSummary(scenarioId, rows || []);
  return { targets: summary.targets, lifeCycleUnits: summary.lifeCycleUnits };
}

function sumValues_(obj) {
  return Object.keys(obj).reduce(function (s, k) { return s + obj[k]; }, 0);
}

/**
 * 寫入損益快照：先清掉該 scenario+vehicle 的舊快照再寫新的(整張重寫，避免逐列刪除)。
 */
function writePLResult_(scenarioId, vehicleId, lineValues, revenue, exFactoryPrice, timestamp) {
  var sheet = getSheet_(SHEETS.PL_RESULT);
  var width = SCHEMA.PLResult.length;
  var lastRow = sheet.getLastRow();

  var kept = [];
  if (lastRow >= 2) {
    kept = sheet.getRange(2, 1, lastRow - 1, width).getValues().filter(function (row) {
      var isBlank = row.every(function (v) { return v === '' || v === null; });
      return !isBlank && !(samePk_(row[1], scenarioId) && String(row[2] || '') === String(vehicleId || ''));
    });
    sheet.getRange(2, 1, lastRow - 1, width).clearContent();
  }

  var rows = Object.keys(lineValues).map(function (code) {
    var amount = lineValues[code];
    return [generateId_('PR'), scenarioId, vehicleId, code, amount,
      revenue ? amount / revenue : 0, exFactoryPrice ? amount / exFactoryPrice : 0, timestamp];
  });

  var all = kept.concat(rows);
  if (all.length) sheet.getRange(2, 1, all.length, width).setValues(all);
  invalidateSheetCache_(SHEETS.PL_RESULT);
}

/**
 * 把計算結果攤成畫面用的列。每一列同時給兩個百分比基準：
 *   PctOfRevenue     — 對 A 收入(未稅,含強配)，就是 Gate F Excel 上那一欄 %
 *   PctOfExFactory   — 對 P8 廠價(未稅)
 */
function buildResultLines_(lineValues, revenue, exFactoryPrice, lineDefs) {
  return (lineDefs || getPLLineItems())
    .filter(function (def) { return lineValues[def.LineCode] !== undefined; })
    .map(function (def) {
      var amount = lineValues[def.LineCode];
      return {
        LineCode: def.LineCode,
        LineName: def.LineName,
        Category: def.Category,
        ParentLine: def.ParentLine || '',
        AutoSource: resultAutoSource_(def),
        CalcType: def.CalcType,
        Amount: amount,
        PctOfRevenue: revenue ? amount / revenue : 0,
        PctOfExFactory: exFactoryPrice ? amount / exFactoryPrice : 0
      };
    });
}

/**
 * 「銷貨成本」「營業費用」矩陣頁面用：非手動輸入的科目(公式、開發總投攤提)依車系算出實際金額，
 * 讓這兩頁能把完整的損益明細攤開顯示(唯讀)，不必再跑去儀表板才看得到。
 * costSection = true：銷貨成本段(B 底下)；false：B 段以外的費用科目(不含結構小計與售價結構)。
 */
function buildAutoLines_(scenarioId, vehicles, costSection) {
  var defs = lineDefsForScenario_(scenarioId);
  var candidates = defs.filter(function (d) {
    if (d.CalcType === CALC_TYPES.INPUT || !d.ParentLine) return false;
    if (isGroupLine_(d, defs)) return false;
    return isCostSectionLine_(d, defs) === costSection;
  });
  var result = { lines: [], values: {}, traces: {}, errors: {} };
  if (!candidates.length) return result;

  var salesMixIds = {};
  calcSalesMix_(scenarioId).forEach(function (r) { salesMixIds[r.VehicleID] = true; });
  var shown = {};
  vehicles.forEach(function (v) {
    if (!salesMixIds[v.VehicleID]) return;
    var pl;
    try { pl = calculatePLCore_(scenarioId, v.VehicleID); } catch (e) { return; }
    candidates.forEach(function (d) {
      if (pl.lineValues[d.LineCode] === undefined) return;
      shown[d.LineCode] = true;
      (result.values[d.LineCode] = result.values[d.LineCode] || {})[v.VehicleID] = pl.lineValues[d.LineCode];
      (result.traces[d.LineCode] = result.traces[d.LineCode] || {})[v.VehicleID] = pl.traces[d.LineCode] || null;
      if (pl.errors[d.LineCode]) (result.errors[d.LineCode] = result.errors[d.LineCode] || {})[v.VehicleID] = pl.errors[d.LineCode];
    });
  });
  result.lines = candidates.filter(function (d) { return shown[d.LineCode]; }).map(function (d) {
    return { value: d.LineCode, label: d.LineName, calcType: d.CalcType, formula: d.CalcType === CALC_TYPES.FORMULA ? d.Formula : '' };
  });
  return result;
}

/** 銷貨成本頁用：B 段底下非手動輸入的科目(開發攤提、貨物稅…)及計算過程 */
function getCostOfSalesAutoLines(scenarioId, vehicles) {
  return buildAutoLines_(scenarioId, vehicles, true);
}
/** 營業費用頁用：B 段以外非手動輸入的費用科目(季Margin、開發總投費用類…) */
function getOperatingExpenseAutoLines(scenarioId, vehicles) {
  return buildAutoLines_(scenarioId, vehicles, false);
}

function getPLResult(scenarioId, vehicleId) {
  var rows = sheetToObjects_(SHEETS.PL_RESULT);
  return rows.filter(function (r) { return r.ScenarioID === scenarioId && r.VehicleID === (vehicleId || ''); });
}
