/**
 * 損益計算引擎：重現 Gate F 損益試算的公式鏈。
 *
 * 設計原則：
 *   - 凡是「可以由比率或其他頁面的數字算出來的科目，就不讓使用者手動輸入」，
 *     避免同一筆金額在兩個地方各填一次而對不起來。目前自動計算的科目為：
 *       P1~P9 售價結構(營業稅、銷售佣金、廠價...)：由 SalesMix 售價欄位 + 比率設定推算
 *       b5 模具費用 / b8 新增專屬設備：開發總投(模具/設備)低減後金額 ÷ LIFE CYCLE 總台數
 *       b13 貨物稅：(廠價 - 水平配件外移調降 - 廣促margin) × 完稅價格計算率 ÷ (1+貨物稅率) × 貨物稅率
 *       d4 季Margin：廠價(未稅) × 季Margin率
 *       f3/f4 車型專案開發費用：開發總投(費用類) 低減後金額 ÷ LIFE CYCLE 總台數
 *   - 所有比率參數以百分比數值儲存(5 = 5%)，取用時一律經過 pct_() 轉成小數。
 *   - 外幣的銷貨成本用「匯率設定」頁的現況匯率換算，不在成本列上逐筆填匯率。
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

/**
 * 貨物稅：完稅價格要先扣掉「水平配件外移調降廠價」與「廣促margin」，再乘上法定計算率、
 * 除以 (1+貨物稅率) 換算成完稅價格，最後乘貨物稅率。
 *   貨物稅 = (廠價 - 水平配件外移調降 - Σ(可扣除的d科目)) × 完稅價格計算率 ÷ (1+貨物稅率) × 貨物稅率
 * 哪些 d 科目可以扣除，由 PLLineItems 的 CommodityTaxDeduct 欄位決定(預設為廣宣/促銷/批標售/季Margin)。
 * 回傳完整的計算過程(不只是稅額)，讓「銷貨成本」頁可以把每一步都攤開顯示，
 * 使用者才看得到「廠價調整」實際上就是這些 d 科目扣除的加總，不是憑空跑出來的數字。
 */
function commodityTaxBreakdown_(exFactoryPrice, horizontalPartsAdj, dLines, taxRate, calcRate) {
  var deductCodes = commodityTaxDeductCodes_();
  var deduct = Object.keys(dLines).reduce(function (sum, code) {
    return sum + (deductCodes.indexOf(code) !== -1 ? dLines[code] : 0);
  }, 0);
  var adj = toNumber_(horizontalPartsAdj);
  var dutiableBase = (exFactoryPrice - adj - deduct) * (calcRate || 1);
  var tax = dutiableBase / (1 + taxRate) * taxRate;
  return {
    exFactoryPrice: exFactoryPrice, horizontalPartsAdj: adj, deductTotal: deduct,
    calcRate: calcRate || 1, taxRate: taxRate, dutiableBase: dutiableBase, tax: tax
  };
}

function commodityTaxDeductCodes_() {
  return getPLLineItems()
    .filter(function (d) { return String(d.CommodityTaxDeduct || '').toUpperCase() === 'Y'; })
    .map(function (d) { return d.LineCode; });
}

/**
 * 算損益並把結果寫回 PLResult 快照（快照給「損益儀表板」讀取用）。
 * 純計算(不寫入)請用 calculatePLCore_ —— 「銷貨成本」「營業費用」頁面只是想順便看一下
 * 自動計算科目算出多少，每次開頁就對每個車系都寫一次快照太浪費，之前也因此拖慢過整個
 * Script 的鎖定(LockService)，讓其他正在存檔的操作跟著逾時。
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
    commodityTaxDetail: result.commodityTaxDetail,
    lines: result.lines
  };
}

/**
 * 純計算損益：不寫入 PLResult，只回傳算出來的結果。calculatePL() 在這之上加寫入快照。
 *
 * 同一次執行內以「情境|車系」為鍵記住結果：儀表板一次比較常常同時放「某情境的各車系」跟
 * 「同一情境的加權平均」，加權平均要把該情境每個車系都算一遍，等於每個車系被算了兩次；
 * 開發總投攤提、貨物稅等每一步也都要重新讀表過濾。記住之後每個(情境,車系)只算一次。
 * 任何寫入都會透過 invalidateSheetCache_ → resetExecutionCaches_ 清掉，不會讀到舊結果。
 */
var PL_CORE_MEMO_ = {};
function calculatePLCore_(scenarioId, vehicleId) {
  var key = String(scenarioId) + '|' + String(vehicleId);
  if (!PL_CORE_MEMO_[key]) PL_CORE_MEMO_[key] = calculatePLCoreUncached_(scenarioId, vehicleId);
  return PL_CORE_MEMO_[key];
}

function calculatePLCoreUncached_(scenarioId, vehicleId) {
  var salesMixRow = getSalesMix(scenarioId).filter(function (r) { return r.VehicleID === vehicleId; })[0];
  if (!salesMixRow) throw new Error('找不到 SalesMix 資料：' + scenarioId + ' / ' + vehicleId);

  var params = getParameters(scenarioId);
  var taxRate = pct_(lookupParam_(params, '營業稅率', vehicleId));
  var commissionRate = pct_(lookupParam_(params, '銷售佣金率', vehicleId));
  var marginRate = pct_(lookupParam_(params, '季Margin率', vehicleId));
  var commodityTaxRate = pct_(lookupParam_(params, '貨物稅率', vehicleId));

  // ---- 售價結構(P1~P9)：這一段以前只在程式裡算、儀表板看不到，現在逐列輸出 ----
  var listPrice = toNumber_(salesMixRow.ListPriceTaxIncl);                 // P1 建議零售價(含稅)
  var accessoryPrice = toNumber_(salesMixRow.MandatoryAccessoryPrice);     // P2 強配件售價
  var listPriceExAccessory = listPrice - accessoryPrice;                   // P3 建議零售價(不含強配,含稅)
  var scrapFeeRaw = toNumber_(salesMixRow.ScrapFee);
  // 廢車處理費可能用含稅或未稅金額登打，一律換算成含稅金額後再扣，
  // 確保跟 ListPriceTaxIncl(含稅零售價)口徑一致，全份損益試算稅別才不會混用。
  // 廢車處理費、營業稅、銷售佣金取到元(與 Gate F Excel 的 ROUND 一致)，避免對帳時出現角分差異
  var scrapFee = salesMixRow.ScrapFeeTaxStatus === '未稅'
    ? Math.round(scrapFeeRaw * (1 + taxRate)) : scrapFeeRaw;               // P4

  var actualRetailPrice = listPriceExAccessory - scrapFee;                 // P5 實際零售價(含稅)
  var salesTax = Math.round(actualRetailPrice * taxRate / (1 + taxRate));  // P6 營業稅(內含反推)
  var actualRetailPriceExTax = actualRetailPrice - salesTax;               // 實際零售價(未稅)
  var commission = Math.round(actualRetailPriceExTax * commissionRate);    // P7 銷售佣金(以未稅零售價為基礎)
  var exFactoryPrice = actualRetailPrice - salesTax - commission;          // P8 廠價(未稅)
  var accessoryRevenue = accessoryPrice / (1 + taxRate);                   // P9 強配收入(未稅)

  var revenueA = exFactoryPrice + accessoryRevenue;                        // A 收入(未稅,含強配)

  // ---- 開發總投攤提：每一列自選攤提落點科目，套到損益各段時依科目所屬的父科目分組 ----
  var devPerUnit = amortizeDevInvestmentPerUnit_(scenarioId);
  var lineDefsAll = getPLLineItems();

  // ---- Σd 銷售費用：貨物稅的完稅價格要扣廣促margin，所以 d 類要先算 ----
  var opexRows = getOperatingExpense(scenarioId, vehicleId);
  var dLines = pickLines_(opexRows, manualLineCodesFor_(['E']));
  dLines.d4 = exFactoryPrice * marginRate;                                 // 季Margin = 廠價(未稅) × 季Margin率
  applyDevAmortLines_(dLines, 'E', devPerUnit, lineDefsAll);
  var totalD = sumValues_(dLines);

  // ---- B 銷貨成本：手動輸入的成本列 + 自動計算的成本列 ----
  var costRows = getCostOfSales(scenarioId, vehicleId);
  var knownCodes = lineDefsAll.map(function (d) { return d.LineCode; });
  // 先把所有可手動輸入的成本科目都放進來(值 0)，沒填金額的科目才不會整列從儀表板消失 ——
  // 少了幾列的話，畫面上看到的 b 科目加起來會對不上 B 銷貨成本合計，看起來就像加總算錯。
  var bLines = {};
  manualLineCodesFor_(['B']).forEach(function (code) { bLines[code] = 0; });
  costRows.forEach(function (r) {
    var code = r.LineCode;
    // 科目已被刪除的殘留金額不計入，否則 B 會跟畫面上列出的 b 科目合計對不起來
    if (!code || knownCodes.indexOf(code) === -1) return;
    // 外幣成本用「匯率設定」頁該幣別的現況匯率換算，不在成本列逐筆填匯率
    bLines[code] = (bLines[code] || 0) + toNumber_(r.Amount) * fxRateFor_(params, r.Currency, vehicleId);
  });
  applyDevAmortLines_(bLines, 'B', devPerUnit, lineDefsAll);
  // 貨物稅完稅價格 = (廠價 - 水平配件外移調降 - 可扣除的d科目(廣宣/促銷/批標售/季Margin)) × 完稅價格計算率
  var commodityTaxBreakdown = commodityTaxBreakdown_(exFactoryPrice, toNumber_(salesMixRow.HorizontalPartsPriceAdj),
    dLines, commodityTaxRate, pct_(lookupParam_(params, '貨物稅完稅價格計算率', vehicleId)));
  bLines.b13 = commodityTaxBreakdown.tax;

  var totalB = sumValues_(bLines);
  var grossProfitC = revenueA - totalB;     // C 生產毛利
  var grossProfitE = grossProfitC - totalD; // E 銷貨毛利

  // ---- Σf 費用(f1 直接輸入 + 開發總投費用類攤提) ----
  var fLines = pickLines_(opexRows, manualLineCodesFor_(['G']));
  applyDevAmortLines_(fLines, 'G', devPerUnit, lineDefsAll);
  var totalF = sumValues_(fLines);
  var contributionG = grossProfitE - totalF; // G 產品貢獻

  // ---- Σh 固定營業費用 ----
  var hLines = pickLines_(opexRows, manualLineCodesFor_(['I']));
  applyDevAmortLines_(hLines, 'I', devPerUnit, lineDefsAll);
  var totalH = sumValues_(hLines);
  var operatingProfitI = contributionG - totalH; // I 營業淨利(未扣前瞻)

  var j = pickLines_(opexRows, ['J']).J || 0;
  var operatingProfitK = operatingProfitI - j; // K 營業淨利

  var lineValues = Object.assign(
    {
      P1: listPrice, P2: accessoryPrice, P3: listPriceExAccessory, P4: scrapFee,
      P5: actualRetailPrice, P6: salesTax, P7: commission, P8: exFactoryPrice, P9: accessoryRevenue,
      A: revenueA, B: totalB
    },
    bLines,
    { C: grossProfitC },
    dLines,
    { E: grossProfitE },
    fLines,
    { G: contributionG },
    hLines,
    { I: operatingProfitI, J: j, K: operatingProfitK }
  );

  return {
    scenarioId: scenarioId,
    vehicleId: vehicleId,
    revenue: revenueA,
    exFactoryPrice: exFactoryPrice,
    commodityTaxDetail: commodityTaxBreakdown,
    lineValues: lineValues,
    lines: buildResultLines_(lineValues, revenueA, exFactoryPrice)
  };
}

/**
 * 某情境(= 某車型)底下所有車系的損益，外加以銷售構成比加權的平均列。
 * 儀表板/比較欄位每次開頁、每切一次 % 基準、每加一欄比較都會呼叫到這裡 ——
 * 純粹是「看」，不是「存」，所以一律用不寫入快照的 calculatePLCore_()，
 * 不要每次都把整張 PLResult 表讀出來、清掉、再寫回去(見 writePLResult_ 的成本說明)。
 * 全系統目前也沒有任何地方會讀回 PLResult 快照(getPLResult() 沒有被呼叫)，
 * 寫這個快照對「看儀表板」這件事只有成本、沒有效益。
 */
function calculatePLAllVehicles(scenarioId) {
  var salesMix = getSalesMix(scenarioId);
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
    weightedAverage: buildResultLines_(weighted, weighted.A || 0, weighted.P8 || 0)
  };
}

/** 單獨取某情境的加權平均損益（儀表板比較欄位用） */
function calculateScenarioWeighted(scenarioId) {
  return calculatePLAllVehicles(scenarioId).weightedAverage;
}

/**
 * 多車型/多情境比較：儀表板的核心 API。
 * selections = [{ ScenarioID, VehicleID }]，VehicleID 留空代表該情境的「加權平均」。
 *
 * 回傳的 lines 是所有欄位實際出現過科目的聯集(依 SortOrder 排序)，並且帶上 ParentLine，
 * 讓前端可以把明細科目縮排在它的小計底下 —— 這樣「哪幾列加起來等於哪一列」在畫面上是看得見的。
 * 某欄位沒有該科目時值為 null，前端顯示空白而不是 0。
 *
 * 每個欄位另外附一份 checks：把小計逐條重算一次(B=Σb、C=A-B、E=C-Σd...)，
 * 只有對不起來的才會出現在陣列裡，前端據此在畫面上示警，不用靠肉眼加總去發現錯誤。
 */
function calculateComparison(selections) {
  selections = selections || [];
  var vehicleTypes = getVehicleTypes();
  var scenarios = getScenarios();
  var vehicles = getVehicles();
  var lineDefs = getPLLineItems();

  var columns = selections.map(function (sel) {
    var scenario = scenarios.filter(function (s) { return s.ScenarioID === sel.ScenarioID; })[0] || {};
    var vehicle = vehicles.filter(function (v) { return v.VehicleID === sel.VehicleID; })[0];
    var vehicleType = vehicleTypes.filter(function (t) { return t.VehicleTypeID === scenario.VehicleTypeID; })[0] || {};

    // 加權平均是好幾個車系混出來的，貨物稅的計算過程沒有單一版本可以攤開顯示，只有選特定
    // 車系時才附上 commodityTaxDetail(見 CalcEngine.gs commodityTaxBreakdown_())。
    // 用 calculatePLCore_ 而非 calculatePL：儀表板只是「看」，不需要每次都寫一次 PLResult 快照。
    var vehicleCalc = sel.VehicleID ? calculatePLCore_(sel.ScenarioID, sel.VehicleID) : null;
    var lines = vehicleCalc ? vehicleCalc.lines : calculateScenarioWeighted(sel.ScenarioID);

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
      commodityTaxDetail: vehicleCalc ? vehicleCalc.commodityTaxDetail : null,
      label: [
        scenario.VehicleTypeID || vehicleType.VehicleTypeID || '',
        scenario.Gate || '',
        scenario.ScenarioName || '',
        sel.VehicleID ? ((vehicle && vehicle.VehicleCode) || sel.VehicleID) : '加權平均'
      ].filter(function (p) { return p; }).join(' / '),
      amounts: amounts,
      revenue: amounts.A || 0,
      exFactoryPrice: amounts.P8 || 0,
      checks: subtotalChecks_(amounts, lineDefs)
    };
  });

  // 只列出至少有一個比較欄位真的算出數字的科目(不同車型科目不同時，表格才不會塞滿空列)
  var usedLines = lineDefs.filter(function (def) {
    return columns.some(function (col) { return col.amounts[def.LineCode] !== undefined; });
  }).map(function (def) {
    return {
      LineCode: def.LineCode,
      LineName: def.LineName,
      Category: def.Category,
      ParentLine: def.ParentLine || '',
      SortOrder: toNumber_(def.SortOrder),
      AutoSource: def.AutoSource || '',
      isSubtotal: PROTECTED_LINE_CODES.indexOf(def.LineCode) !== -1,
      isPriceStructure: String(def.Category || '') === '售價結構'
    };
  });

  return { columns: columns, lines: usedLines, subtotalCodes: PROTECTED_LINE_CODES };
}

/**
 * 比較欄位的銷量基礎。
 * 單一車系：該車系在銷售構成表上的月銷量、LC 年限、構成比，總台數 = 月銷量 × 12 × LC年限。
 * 加權平均：月銷量/總台數是該情境所有車系加總，並附上各車系的構成比(mix)，
 * 讓儀表板 hover 標題時看得出「加權平均」是由哪幾個車系、各佔多少混出來的。
 * 儀表板的「年度總額 / LC 總額」就是用這裡的 monthlyVolume / units 去乘單台金額。
 */
function columnVolumeInfo_(scenarioId, vehicleId, vehicles) {
  var rows = getSalesMix(scenarioId);
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
    // 各車系 LC 年限通常一樣；不一樣時標題只顯示範圍，總台數仍是逐車系加總
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
 * 小計驗算：把損益鏈上每一條「等式」重算一次，回傳對不起來的項目。
 * 一分損益表最容易出錯的地方就是加總 —— 明細改了、小計沒跟著動，或是某個明細科目
 * 被歸到錯的父科目而沒有被任何小計吃到。這裡直接用畫面上要顯示的同一組數字去驗，
 * 有問題就一定看得到，不必自己拿計算機加。
 */
function subtotalChecks_(amounts, lineDefs) {
  var v = function (code) { return Number(amounts[code]) || 0; };
  var sumChildren = function (parent) {
    return lineDefs.filter(function (d) { return d.ParentLine === parent; })
      .reduce(function (sum, d) { return sum + v(d.LineCode); }, 0);
  };

  var equations = [
    { code: 'A', label: 'A 收入 = P8 廠價 + P9 強配收入', expected: v('P8') + v('P9') },
    { code: 'B', label: 'B 銷貨成本 = Σ 成本明細', expected: sumChildren('B') },
    { code: 'C', label: 'C 生產毛利 = A - B', expected: v('A') - v('B') },
    { code: 'E', label: 'E 銷貨毛利 = C - Σ 銷售費用', expected: v('C') - sumChildren('E') },
    { code: 'G', label: 'G 產品貢獻 = E - Σ 產品貢獻前費用', expected: v('E') - sumChildren('G') },
    { code: 'I', label: 'I 營業淨利(未扣前瞻) = G - Σ 固定營業費用', expected: v('G') - sumChildren('I') },
    { code: 'K', label: 'K 營業淨利 = I - J 前瞻費用', expected: v('I') - v('J') }
  ];

  return equations.filter(function (eq) {
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
          return { ScenarioID: s.ScenarioID, Gate: s.Gate || '', ScenarioName: s.ScenarioName || '' };
        }),
      vehicles: vehicles.filter(function (v) { return v.VehicleTypeID === t.VehicleTypeID; })
        .map(function (v) { return { VehicleID: v.VehicleID, VehicleCode: v.VehicleCode || '' }; })
    };
  });
}

/**
 * 依 DevInvestment 攤提出單台開發成本，依每一列自選的攤提落點科目(TargetLineCode)分組加總。
 * 分母為該情境的 LIFE CYCLE 總台數 = Σ(月銷量 × 12 × LC年限)。
 * 回傳的 perUnit / totalsByLine 都是「科目代碼 -> 金額」的動態物件，
 * 落點不再限制成固定的 b5/b8/f3/f4 四個科目(見 applyDevAmortLines_ 如何套用到損益各段)。
 *
 * overrideRows 可選：開發總投頁面用來「先試算、還沒儲存」——使用者在畫面上調整金額/低減%時，
 * 直接把還沒送出的列傳進來算，不必先存檔才看得到下面投資總額/單台攤提會變成多少。
 * 不傳就照原本行為讀 Sheet 上已儲存的資料（損益計算/儀表板一律用這個，確保跟儲存的資料一致）。
 */
function amortizeDevInvestmentPerUnit_(scenarioId, overrideRows) {
  var devRows = overrideRows || getDevInvestment(scenarioId);
  var totalUnits = getLifeCycleUnits(scenarioId);
  var empty = { perUnit: {}, totalsByLine: {}, totalUnits: totalUnits };
  if (totalUnits <= 0) return empty;

  // 現況情境沒有挑戰低減目標，一律用原始金額；目標情境才套用低減率。
  var isBaseline = isBaselineScenario_(scenarioId);
  var params = getParameters(scenarioId);

  var totals = {};
  devRows.forEach(function (r) {
    var target = devAmortTargetOf_(r);
    if (!target) return;   // 沒選攤提落點的列不攤提(儲存時已擋下有金額卻沒選的情形)
    // 投入金額可用外幣登打(如 BASE廠開發費以 CNY 計)，換算方式與銷貨成本一致
    var amount = toNumber_(r.Amount) * fxRateFor_(params, r.Currency, '');
    // ChallengeReductionPct 以 0~100 的百分比數值儲存(如 15 代表 15%)
    var reduced = amount * (isBaseline ? 1 : 1 - pct_(r.ChallengeReductionPct));
    totals[target] = (totals[target] || 0) + reduced;
  });

  var perUnit = {};
  Object.keys(totals).forEach(function (code) { perUnit[code] = totals[code] / totalUnits; });

  return { perUnit: perUnit, totalsByLine: totals, totalUnits: totalUnits };
}

/**
 * 把開發總投攤提結果套進損益某一段的科目集合：只套用「這一段底下、攤提用的科目」，
 * 沒有任何一列選到的攤提落點科目也會補 0，確保畫面上一定看得到該科目那一列。
 */
function applyDevAmortLines_(targetDict, parentLine, devPerUnit, lineDefs) {
  lineDefs.filter(function (d) {
    return d.ParentLine === parentLine && DEV_AMORT_AUTO_SOURCES.indexOf(d.AutoSource) !== -1;
  }).forEach(function (d) {
    var amount = devPerUnit.perUnit[d.LineCode];
    // 內建的四個攤提落點(模具/設備/CMC/BASE廠開發費)一律顯示、即使 0，維持 Gate F 損益表固定列序。
    // 使用者自訂的攤提落點(AutoSource=DEV_AMORT)則只在「這個情境目前真的有開發總投列指到這裡」才顯示，
    // 不然使用者在開發總投頁面新增過的攤提落點只要試用過一次，就會永遠留在每一份損益表/矩陣頁面上洗不掉
    // (顯示成金額 0、不屬於任何目前看得到的資料)，而且還刪不掉(deletePLLineItem 會擋住還有資料指向它的科目)。
    if (amount === undefined && d.AutoSource === AUTO_SOURCE.DEV_AMORT) return;
    targetDict[d.LineCode] = amount || 0;
  });
}

/** 是否為現況情境（現況沒有挑戰低減目標） */
function isBaselineScenario_(scenarioId) {
  var s = getScenarios().filter(function (r) { return r.ScenarioID === scenarioId; })[0];
  return !s || !s.ScenarioType || s.ScenarioType === SCENARIO_TYPE_BASELINE;
}

/**
 * 開發總投攤提用的 LIFE CYCLE 總台數。
 * 情境若有填「攤提基準台數」(AmortMonthlyVolume × 12 × AmortLifeCycleYears)就以它為準，
 * 因為實務上開發投資的攤提基準台數常與銷售構成的預估台數不同(例如銷售估 365 台/月，
 * 但開發投資以 300 台/月 × 12 年攤提)。沒填就用銷售構成推算。
 */
function getLifeCycleUnits(scenarioId) {
  var scenario = getScenarios().filter(function (s) { return s.ScenarioID === scenarioId; })[0];
  if (scenario) {
    var vol = toNumber_(scenario.AmortMonthlyVolume);
    var years = toNumber_(scenario.AmortLifeCycleYears);
    if (vol > 0 && years > 0) return vol * 12 * years;
  }
  return getSalesMixLifeCycleUnits(scenarioId);
}

/** 銷售構成推算的 LIFE CYCLE 總台數 = Σ(預估銷售台數(月) × 12 × LC年限) */
function getSalesMixLifeCycleUnits(scenarioId) {
  return getSalesMix(scenarioId).reduce(function (sum, r) {
    return sum + toNumber_(r.MonthlyVolume) * 12 * toNumber_(r.LifeCycleYears);
  }, 0);
}

/**
 * 開發總投頁面用：回傳低減後金額與單台攤提，讓使用者直接看到攤提結果。
 * 攤提落點(TargetLineCode)由使用者自己選，不再限制成固定的模具/設備/費用四種，
 * 也可以在頁面上新增新的攤提落點科目(見 getDevAmortTargetOptions / addDevAmortLineItem)。
 *
 * overrideRows 可選：見 amortizeDevInvestmentPerUnit_ 的說明，用來在還沒儲存前先試算
 * 下面「投資總額(低減後)/單台攤提」表會變成多少（見 previewDevInvestmentSummary）。
 * 這種情況下 rows 仍照 Sheet 上已儲存的資料回傳，不受 overrideRows 影響
 * ——只影響 targets 那組彙總數字，画面上逐列的輸入框由前端自己管理，不需要後端回填。
 */
function getDevInvestmentSummary(scenarioId, overrideRows) {
  var perUnit = amortizeDevInvestmentPerUnit_(scenarioId, overrideRows);
  var isBaseline = isBaselineScenario_(scenarioId);
  var lineNames = {};
  getPLLineItems().forEach(function (d) { lineNames[d.LineCode] = d.LineName; });
  var targetOptions = getDevAmortTargetOptions();

  // 部門列的呈現順序使用者可以自己在畫面上調整(拖不動用上下移動鈕)，留白排最後、相對順序穩定
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
      // 這一列的錢會攤到哪個科目，直接寫在畫面上（只給名稱，代碼對選擇沒有幫助）
      TargetLineCode: target,
      TargetLineName: target ? (lineNames[target] || target) : '',
      SortOrder: r.SortOrder === undefined || r.SortOrder === '' ? '' : r.SortOrder
    };
  });
  var scenario = getScenarios().filter(function (s) { return s.ScenarioID === scenarioId; })[0] || {};
  return {
    lifeCycleUnits: perUnit.totalUnits,
    salesMixLifeCycleUnits: getSalesMixLifeCycleUnits(scenarioId),
    targetOptions: targetOptions,
    // 每個落點科目的投資總額(低減後)與單台攤提，讓「開發總投 → 損益科目」對得起來
    targets: targetOptions.map(function (opt) {
      var code = opt.value;
      return {
        LineCode: code, LineName: opt.label,
        Total: perUnit.totalsByLine[code] || 0,
        PerUnit: perUnit.totalUnits ? (perUnit.totalsByLine[code] || 0) / perUnit.totalUnits : 0
      };
    }),
    amortMonthlyVolume: scenario.AmortMonthlyVolume === undefined ? '' : scenario.AmortMonthlyVolume,
    amortLifeCycleYears: scenario.AmortLifeCycleYears === undefined ? '' : scenario.AmortLifeCycleYears,
    currencies: getConfiguredCurrencies(scenarioId),
    perUnit: perUnit, isBaseline: isBaseline, rows: rows
  };
}

/**
 * 開發總投頁面用：畫面上還沒按「儲存」的編輯內容，先試算一次下面的「投資總額(低減後)/單台攤提」表，
 * 讓使用者調整金額或挑戰低減目標(或直接改低減後金額反推)時馬上看得到攤提結果會變成怎樣，
 * 不必先存檔才知道。只回傳 targets 彙總表需要的部分，不寫入任何資料、不用鎖定。
 */
function previewDevInvestmentSummary(scenarioId, rows) {
  var summary = getDevInvestmentSummary(scenarioId, rows || []);
  return { targets: summary.targets, lifeCycleUnits: summary.lifeCycleUnits };
}

/** 某個父科目底下、可以手動輸入的明細科目代碼(排除自動計算科目) */
function manualLineCodesFor_(parentCodes) {
  return getPLLineItems()
    .filter(function (d) { return parentCodes.indexOf(d.ParentLine) !== -1 && !d.AutoSource; })
    .map(function (d) { return d.LineCode; });
}

function pickLines_(rows, codes) {
  var result = {};
  codes.forEach(function (c) { result[c] = 0; });
  rows.forEach(function (r) {
    if (codes.indexOf(r.LineCode) !== -1) {
      result[r.LineCode] += toNumber_(r.Amount);
    }
  });
  return result;
}

function sumValues_(obj) {
  return Object.keys(obj).reduce(function (s, k) { return s + obj[k]; }, 0);
}

/**
 * 寫入損益快照：先清掉該 scenario+vehicle 的舊快照再寫新的。
 * 舊資料用「整張重寫」而非逐列 deleteRow —— 儀表板一次比較多個欄位時，
 * 逐列刪除會累積成上百次 Sheet 異動，容易撞到執行時間上限。
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
 * 把計算結果攤成畫面用的列。
 * 每一列同時給兩個百分比基準：
 *   PctOfRevenue     — 對 A 收入(未稅,含強配)，就是 Gate F Excel 上那一欄 %
 *   PctOfExFactory   — 對 P8 廠價(未稅)
 * 沒有強配件時兩者相同；有強配收入時廠價比較能反映本業單價，所以兩個都留著讓使用者切換。
 */
function buildResultLines_(lineValues, revenue, exFactoryPrice) {
  var lineDefs = getPLLineItems();
  return lineDefs
    .filter(function (def) { return lineValues[def.LineCode] !== undefined; })
    .map(function (def) {
      var amount = lineValues[def.LineCode];
      return {
        LineCode: def.LineCode,
        LineName: def.LineName,
        Category: def.Category,
        ParentLine: def.ParentLine || '',
        AutoSource: def.AutoSource || '',
        Amount: amount,
        PctOfRevenue: revenue ? amount / revenue : 0,
        PctOfExFactory: exFactoryPrice ? amount / exFactoryPrice : 0
      };
    });
}

/**
 * 「銷貨成本」「營業費用」矩陣頁面用：把自動計算科目(開發總投攤提、貨物稅、季Margin等)
 * 依車系算出實際金額，讓這兩頁能把完整的損益明細攤開顯示，不必再跑去儀表板才看得到。
 * 只算「這個情境底下、已經有銷售構成資料」的車系，還沒建立銷售構成的車系無法計算，直接略過。
 */
function buildAutoLines_(scenarioId, vehicles, parentLines) {
  var devPerUnit = amortizeDevInvestmentPerUnit_(scenarioId);
  // 跟 applyDevAmortLines_ 同一個規則：使用者自訂的攤提落點只有這個情境目前真的用到才列出來，
  // 不然「銷貨成本」「營業費用」頁面的自動計算科目區塊會永遠多出一列用不到、也刪不掉的科目。
  var autoLineDefs = getPLLineItems().filter(function (d) {
    if (parentLines.indexOf(d.ParentLine) === -1 || !d.AutoSource) return false;
    if (d.AutoSource === AUTO_SOURCE.DEV_AMORT && devPerUnit.perUnit[d.LineCode] === undefined) return false;
    return true;
  });
  var result = { lines: autoLineDefs.map(function (d) { return { value: d.LineCode, label: d.LineName }; }), values: {} };
  if (!autoLineDefs.length) return result;
  autoLineDefs.forEach(function (d) { result.values[d.LineCode] = {}; });

  var salesMixIds = {};
  getSalesMix(scenarioId).forEach(function (r) { salesMixIds[r.VehicleID] = true; });

  vehicles.forEach(function (v) {
    if (!salesMixIds[v.VehicleID]) return;
    var pl;
    // 用不寫入 PLResult 的純計算版本 —— 這裡只是想顯示自動計算科目算出多少，
    // 每次開頁就對每個車系都重算一次還寫一次快照(calculatePL())太浪費，
    // 之前也因此讓存檔用的鎖定(LockService)排隊排很久甚至逾時。
    try { pl = calculatePLCore_(scenarioId, v.VehicleID); } catch (e) { return; }
    pl.lines.forEach(function (l) {
      if (result.values[l.LineCode]) result.values[l.LineCode][v.VehicleID] = l.Amount;
    });
    if (parentLines.indexOf('B') !== -1) {
      result.commodityTaxDetail = result.commodityTaxDetail || {};
      result.commodityTaxDetail[v.VehicleID] = pl.commodityTaxDetail;
    }
  });
  return result;
}

/** 銷貨成本頁用：B 底下的自動計算科目(b5/b8/b13...)，含貨物稅的完整計算過程 */
function getCostOfSalesAutoLines(scenarioId, vehicles) {
  return buildAutoLines_(scenarioId, vehicles, ['B']);
}
/** 營業費用頁用：E/G/I 底下的自動計算科目(季Margin、開發總投攤提費用類...) */
function getOperatingExpenseAutoLines(scenarioId, vehicles) {
  return buildAutoLines_(scenarioId, vehicles, ['E', 'G', 'I']);
}

function getPLResult(scenarioId, vehicleId) {
  var rows = sheetToObjects_(SHEETS.PL_RESULT);
  return rows.filter(function (r) { return r.ScenarioID === scenarioId && r.VehicleID === (vehicleId || ''); });
}
