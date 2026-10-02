/**
 * 目標反推(Goal Seek)與敏感度分析。
 *
 * 審議會最常被問的：「月銷要多少台才損益兩平？」「材料成本要再降多少才達標？」「匯率變動影響多少？」
 * 這些都是「改一個假設、看營業淨利怎麼變」。這裡用 CalcEngine 的假設覆寫(CALC_OVERRIDES_，只在記憶體)
 * 重算損益，存檔的資料完全不動。
 *
 * 驅動因子(driver)，值一律用畫面上看得懂的單位：
 *   { type: 'volume' }               月總銷量(台/月)，各車系依構成比等比例放大縮小(攤提台數一起變)
 *   { type: 'price' }                建議零售價(加權平均，元)，各車系等比例調整
 *   { type: 'line', code: 'b1' }     某科目的單台金額(加權平均，元)，各車系等比例調整
 *   { type: 'dev' }                  開發總投攤提(加權單台合計，元)，所有攤提科目等比例調整
 *   { type: 'param', name: '營業稅率' } 參數值(依參數單位，% 參數填 5 = 5%)，全車系套用
 *   { type: 'fx', currency: 'CNY' }   匯率(1 外幣 = ? 元)
 * 衡量指標(metric)：{ code: 'K', basis: 'unit' | 'month' }
 *   unit  = 加權平均單台金額；month = 月總額(各車系單台 × 月銷量 加總)
 */

/** 在覆寫底下執行 fn，結束後一定拿掉覆寫並清掉計算記憶 */
function withOverrides_(overrides, fn) {
  var prev = CALC_OVERRIDES_;
  CALC_OVERRIDES_ = overrides;
  resetCalcMemo_();
  try { return fn(); } finally {
    CALC_OVERRIDES_ = prev;
    resetCalcMemo_();
  }
}

/** 算一個情境的指標值(加權單台或月總額)與重點科目 */
function whatIfMetric_(scenarioId, metric) {
  var all = calculatePLAllVehicles(scenarioId);
  var code = (metric && metric.code) || 'K';
  var line = all.weightedAverage.filter(function (l) { return l.LineCode === code; })[0];
  if (metric && metric.basis === 'month') {
    var mix = calcSalesMix_(scenarioId);
    var sum = 0;
    all.vehicles.forEach(function (res) {
      var row = mix.filter(function (r) { return r.VehicleID === res.vehicleId; })[0];
      sum += (res.lineValues[code] || 0) * toNumber_(row && row.MonthlyVolume);
    });
    return sum;
  }
  return line ? line.Amount : 0;
}

function weightedLineOf_(scenarioId, code) {
  var line = calculatePLAllVehicles(scenarioId).weightedAverage.filter(function (l) { return l.LineCode === code; })[0];
  return line ? line.Amount : 0;
}

/** 驅動因子目前的值(基準)與顯示名稱 */
function driverBase_(scenarioId, driver) {
  var t = driver && driver.type;
  if (t === 'volume') {
    return { value: getSalesMix(scenarioId).reduce(function (s, r) { return s + toNumber_(r.MonthlyVolume); }, 0), label: '月總銷量', unit: '台/月' };
  }
  if (t === 'price') return { value: weightedLineOf_(scenarioId, 'P1'), label: '建議零售價(加權)', unit: '元' };
  if (t === 'line') {
    var def = lineDefsForScenario_(scenarioId).filter(function (d) { return d.LineCode === driver.code; })[0];
    if (!def) throw new Error('找不到科目：' + driver.code);
    return { value: weightedLineOf_(scenarioId, driver.code), label: def.LineName, unit: '元/台' };
  }
  if (t === 'dev') {
    var defs = lineDefsForScenario_(scenarioId).filter(function (d) { return d.CalcType === CALC_TYPES.DEV_AMORT; });
    var w = calculatePLAllVehicles(scenarioId).weightedAverage;
    var sum = 0;
    defs.forEach(function (d) { var l = w.filter(function (x) { return x.LineCode === d.LineCode; })[0]; if (l) sum += l.Amount; });
    return { value: sum, label: '開發總投攤提(單台合計)', unit: '元/台' };
  }
  if (t === 'param') {
    var pdef = getParamDefs().filter(function (p) { return p.ParamName === driver.name; })[0];
    if (!pdef) throw new Error('找不到參數：' + driver.name);
    var params = getParameters(scenarioId);
    var has = params.some(function (p) { return p.ParamName === driver.name; });
    var v = has ? lookupParam_(params, driver.name, '') : (pdef.DefaultValue !== '' && pdef.DefaultValue !== undefined ? toNumber_(pdef.DefaultValue) : (DEFAULT_PARAMS[driver.name] || 0));
    return { value: v, label: driver.name, unit: pdef.Unit === '%' ? '%' : '' };
  }
  if (t === 'fx') return { value: fxRateFor_(getParameters(scenarioId), driver.currency, ''), label: driver.currency + ' 匯率', unit: '元' };
  throw new Error('不支援的假設項目');
}

/** 驅動因子設成 value 時的覆寫 */
function driverOverrides_(scenarioId, driver, value, base) {
  var o = { scenarioId: scenarioId };
  var factor = function () {
    if (!base) throw new Error('「' + driverLabel_(driver) + '」目前是 0，無法用等比例調整');
    return value / base;
  };
  switch (driver.type) {
    case 'volume': o.volume = factor(); break;
    case 'price': o.price = factor(); break;
    case 'line': o.lineScale = {}; o.lineScale[driver.code] = factor(); break;
    case 'dev': o.dev = factor(); break;
    case 'param': o.params = {}; o.params[driver.name] = value; break;
    case 'fx': o.fx = {}; o.fx[driver.currency] = value; break;
  }
  return o;
}
function driverLabel_(d) {
  return d.type === 'volume' ? '月總銷量' : d.type === 'price' ? '建議零售價' : d.type === 'line' ? d.code :
    d.type === 'dev' ? '開發總投攤提' : d.type === 'param' ? d.name : d.type === 'fx' ? d.currency + '匯率' : d.type;
}

/** 假設分析頁的選項：可以調的項目(含目前值)與可以看的指標 */
function getWhatIfOptions(scenarioId) {
  if (!scenarioId) throw new Error('請先選擇情境');
  var defs = lineDefsForScenario_(scenarioId);
  var weighted = {};
  calculatePLAllVehicles(scenarioId).weightedAverage.forEach(function (l) { weighted[l.LineCode] = l.Amount; });
  var drivers = [
    { type: 'volume' }, { type: 'price' }, { type: 'dev' }
  ].map(function (d) { var b = driverBase_(scenarioId, d); return { driver: d, label: b.label, unit: b.unit, base: b.value }; });
  defs.filter(function (d) { return (d.CalcType === CALC_TYPES.INPUT || d.CalcType === CALC_TYPES.DEV_AMORT) && Math.abs(weighted[d.LineCode] || 0) > 0.5; })
    .forEach(function (d) { drivers.push({ driver: { type: 'line', code: d.LineCode }, label: d.LineName, unit: '元/台', base: weighted[d.LineCode], group: '科目' }); });
  getParamDefs().forEach(function (p) {
    var b = driverBase_(scenarioId, { type: 'param', name: p.ParamName });
    drivers.push({ driver: { type: 'param', name: p.ParamName }, label: p.ParamName, unit: b.unit, base: b.value, group: '參數' });
  });
  getConfiguredCurrencies(scenarioId).filter(function (c) { return c !== BASE_CURRENCY; }).forEach(function (c) {
    drivers.push({ driver: { type: 'fx', currency: c }, label: c + ' 匯率', unit: '元', base: fxRateFor_(getParameters(scenarioId), c, ''), group: '匯率' });
  });
  return {
    drivers: drivers,
    metrics: defs.filter(function (d) { return weighted[d.LineCode] !== undefined && d.Category !== '售價結構'; })
      .map(function (d) { return { code: d.LineCode, label: d.LineName, value: weighted[d.LineCode] }; }),
    monthlyVolume: driverBase_(scenarioId, { type: 'volume' }).value
  };
}

/**
 * 目標反推：driver 要調到多少，metric 才會等於 target。
 * 先在基準值附近往兩邊找一個「結果跨過目標」的區間，再二分法逼近(公式裡有取整、IF，不能假設是平滑的)。
 * 找不到(例如怎麼調都不會損益兩平)就回傳 feasible:false 與試過的範圍。
 */
function solveGoal(scenarioId, metric, target, driver) {
  if (!scenarioId) throw new Error('請先選擇情境');
  metric = metric || { code: 'K', basis: 'unit' };
  target = toNumber_(target);
  var base = driverBase_(scenarioId, driver);
  var evalAt = function (x) {
    return withOverrides_(driverOverrides_(scenarioId, driver, x, base.value), function () { return whatIfMetric_(scenarioId, metric); });
  };
  var f0 = whatIfMetric_(scenarioId, metric);
  var positiveOnly = ['volume', 'price', 'fx', 'line', 'dev'].indexOf(driver.type) !== -1;
  var g = function (x) { return evalAt(x) - target; };
  var x0 = base.value;
  if (Math.abs(f0 - target) < 0.5) {
    return { feasible: true, value: x0, base: x0, label: base.label, unit: base.unit, metricBase: f0, achieved: f0, iterations: 0 };
  }
  // 找區間：從基準值往上、往下各擴大，直到結果跨過目標
  var g0 = f0 - target;
  var step = Math.abs(x0) > 1e-9 ? Math.abs(x0) * 0.05 : 1;
  var lo = null, hi = null, gLo, gHi, tries = 0;
  [1, -1].some(function (dir) {
    var prevX = x0, prevG = g0, s = step;
    for (var k = 0; k < 22; k++) {
      var x = x0 + dir * s;
      if (positiveOnly && x < 0) x = 0;
      var gx = g(x); tries++;
      if ((gx > 0) !== (prevG > 0) || gx === 0) { lo = prevX; gLo = prevG; hi = x; gHi = gx; return true; }
      if (positiveOnly && x === 0) break;
      prevX = x; prevG = gx; s *= 2;
    }
    return false;
  });
  if (lo === null) {
    return { feasible: false, base: x0, label: base.label, unit: base.unit, metricBase: f0, iterations: tries,
      message: '只調整「' + base.label + '」達不到這個目標（往上、往下都試過了，結果都沒有跨過目標值）。' +
        (driver.type === 'volume' ? '通常是單台的變動成本已經高於售價，賣越多虧越多，要先改善售價或成本。' : '') };
  }
  for (var i = 0; i < 60; i++) {
    var mid = (lo + hi) / 2;
    var gm = g(mid); tries++;
    if (Math.abs(gm) < 0.5 || Math.abs(hi - lo) < Math.max(1e-6, Math.abs(mid) * 1e-9)) { lo = hi = mid; gLo = gm; break; }
    if ((gm > 0) === (gLo > 0)) { lo = mid; gLo = gm; } else { hi = mid; gHi = gm; }
  }
  var value = (lo + hi) / 2;
  var achieved = evalAt(value);
  return { feasible: true, value: value, base: x0, label: base.label, unit: base.unit, metricBase: f0, achieved: achieved, iterations: tries };
}

/**
 * 敏感度表：rowDriver 取 rowValues、colDriver 取 colValues，每一格算一次 metric。
 * 值是驅動因子的實際值(前端用 基準 × (1 + %) 算好再送來)。
 */
function sensitivityTable(scenarioId, metric, rowDriver, rowValues, colDriver, colValues) {
  if (!scenarioId) throw new Error('請先選擇情境');
  metric = metric || { code: 'K', basis: 'unit' };
  if ((rowValues || []).length * (colValues || []).length > 121) throw new Error('敏感度表最多 11 × 11 格');
  var rb = driverBase_(scenarioId, rowDriver), cb = colDriver ? driverBase_(scenarioId, colDriver) : null;
  var cells = (rowValues || []).map(function (rv) {
    return (colDriver ? colValues : [null]).map(function (cv) {
      var o = driverOverrides_(scenarioId, rowDriver, rv, rb.value);
      if (colDriver) {
        var oc = driverOverrides_(scenarioId, colDriver, cv, cb.value);
        Object.keys(oc).forEach(function (k) {
          if (k === 'scenarioId') return;
          if (o[k] && typeof o[k] === 'object') Object.keys(oc[k]).forEach(function (kk) { o[k][kk] = oc[k][kk]; });
          else if (o[k] && typeof o[k] === 'number') o[k] = o[k] * oc[k];   // 同一個因子調兩次：倍數相乘
          else o[k] = oc[k];
        });
      }
      return withOverrides_(o, function () { return whatIfMetric_(scenarioId, metric); });
    });
  });
  return {
    rowLabel: rb.label, rowUnit: rb.unit, rowBase: rb.value, rowValues: rowValues,
    colLabel: cb ? cb.label : '', colUnit: cb ? cb.unit : '', colBase: cb ? cb.value : null, colValues: colDriver ? colValues : [],
    metricBase: whatIfMetric_(scenarioId, metric), cells: cells
  };
}

/** 損益兩平月銷量(GATE 報告摘要用)：營業淨利(月總額) = 0 時的月總銷量；算不出來回傳 null */
function breakEvenVolume_(scenarioId) {
  try {
    var r = solveGoal(scenarioId, { code: 'K', basis: 'unit' }, 0, { type: 'volume' });
    return r.feasible ? r.value : null;
  } catch (e) { return null; }
}
