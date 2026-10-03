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
 * 衡量指標(metric)：{ code: 'K', basis: 'unit' | 'month' }，code 空白 = 營業淨利(K 被刪掉時是損益表最後一行總計)
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
  var code = (metric && metric.code) || '';
  // 空白或 K = 營業淨利；K 被刪掉、另外建了淨利科目時，自動改看那個科目(存下來的設定還是 K 也照樣能用)
  if (!code || code === 'K') code = profitLineCode_(lineDefsForScenario_(scenarioId));
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
    monthlyVolume: driverBase_(scenarioId, { type: 'volume' }).value,
    profitCode: profitLineCode_(defs)
  };
}

/**
 * 目標反推：driver 要調到多少，metric 才會等於 target。
 * 先在基準值附近往兩邊找一個「結果跨過目標」的區間，再二分法逼近(公式裡有取整、IF，不能假設是平滑的)。
 * 找不到(例如怎麼調都不會損益兩平)就回傳 feasible:false 與試過的範圍。
 */
function solveGoal(scenarioId, metric, target, driver) {
  if (!scenarioId) throw new Error('請先選擇情境');
  metric = metric || { code: '', basis: 'unit' };   // 空白 = 營業淨利(profitLineCode_)
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
  metric = metric || { code: '', basis: 'unit' };   // 空白 = 營業淨利(profitLineCode_)
  if ((rowValues || []).length * (colValues || []).length > 121) throw new Error('敏感度表最多 11 × 11 格');
  var rb = driverBase_(scenarioId, rowDriver), cb = colDriver ? driverBase_(scenarioId, colDriver) : null;
  var cells = (rowValues || []).map(function (rv) {
    return (colDriver ? colValues : [null]).map(function (cv) {
      var o = driverOverrides_(scenarioId, rowDriver, rv, rb.value);
      if (colDriver) o = mergeOverrides_(o, driverOverrides_(scenarioId, colDriver, cv, cb.value));
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
    var r = solveGoal(scenarioId, { code: '', basis: 'unit' }, 0, { type: 'volume' });
    return r.feasible ? r.value : null;
  } catch (e) { return null; }
}

/** 兩組覆寫合併(多個假設同時成立)；同一個倍數因子調兩次 = 倍數相乘 */
function mergeOverrides_(a, b) {
  var o = { scenarioId: a.scenarioId || b.scenarioId };
  [a, b].forEach(function (src) {
    Object.keys(src).forEach(function (k) {
      if (k === 'scenarioId') return;
      var v = src[k];
      if (v && typeof v === 'object') {
        o[k] = o[k] || {};
        Object.keys(v).forEach(function (kk) {
          o[k][kk] = typeof o[k][kk] === 'number' && k === 'lineScale' ? o[k][kk] * v[kk] : v[kk];
        });
      } else if (typeof v === 'number' && typeof o[k] === 'number') o[k] = o[k] * v;
      else o[k] = v;
    });
  });
  return o;
}

/**
 * 找 x 使 g(x) = 0：從 x0 往兩邊擴大找到變號區間，再二分法。找不到回傳 null。
 * (公式裡有取整、IF，不假設平滑)
 */
function solveScalar_(g, x0, step, lowerBound) {
  var g0 = g(x0);
  if (Math.abs(g0) < 0.5) return x0;
  var lo = null, hi = null, gLo;
  [1, -1].some(function (dir) {
    var prevX = x0, prevG = g0, st = step;
    for (var k = 0; k < 22; k++) {
      var x = x0 + dir * st;
      if (lowerBound !== null && lowerBound !== undefined && x < lowerBound) x = lowerBound;
      var gx = g(x);
      if ((gx > 0) !== (prevG > 0) || gx === 0) { lo = prevX; gLo = prevG; hi = x; return true; }
      if (lowerBound !== null && lowerBound !== undefined && x === lowerBound) break;
      prevX = x; prevG = gx; st *= 2;
    }
    return false;
  });
  if (lo === null) return null;
  for (var i = 0; i < 60; i++) {
    var mid = (lo + hi) / 2;
    var gm = g(mid);
    if (Math.abs(gm) < 0.5 || Math.abs(hi - lo) < Math.max(1e-6, Math.abs(mid) * 1e-9)) return mid;
    if ((gm > 0) === (gLo > 0)) { lo = mid; gLo = gm; } else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 多項目標反推(組合拳)：營業淨利的缺口通常不會只靠一個項目補，而是售價、材料、銷量…一起分擔。
 *
 * levers = [{ driver, share, capPct, fixed }]
 *   fixed   有填 = 這一項已經確定(例：銷量確定是 120 台/月)，直接套用，不參與反推
 *   share   分攤比例(只在 mode = 'share' 用；全部沒填就平均分攤)
 *   capPct  最多只能調 ±幾 %(例：售價最多漲 3%)；碰到上限後剩下的缺口由其他項目吸收
 * mode
 *   'share' 依比例分攤缺口：每一項先各自算出「負責的那一份缺口」要調多少，再整組一起套用、等比例微調到剛好達標
 *           (各項目之間有交互作用，例如售價變動也會影響佣金與貨物稅，所以不能單純相加)
 *   'equal' 同幅度：所有項目往有利的方向調同樣的 %，算出要調幾 %
 *
 * 回傳每一項的 目前值 → 調整後、變動 %、是否碰到上限，以及「依列表順序逐項加入」的貢獻(加總剛好等於總改善，可以直接畫瀑布圖)。
 */
function solveGoalMulti(scenarioId, metric, target, levers, mode) {
  if (!scenarioId) throw new Error('請先選擇情境');
  metric = metric || { code: '', basis: 'unit' };   // 空白 = 營業淨利(profitLineCode_)
  target = toNumber_(target);
  mode = mode === 'equal' ? 'equal' : 'share';
  levers = (levers || []).filter(function (l) { return l && l.driver && l.driver.type; });
  if (!levers.length) throw new Error('請至少選一個調整項目');
  var seen = {};
  levers.forEach(function (l) {
    var k = JSON.stringify(l.driver);
    if (seen[k]) throw new Error('「' + driverLabel_(l.driver) + '」重複選了兩次');
    seen[k] = true;
  });
  var positiveTypes = ['volume', 'price', 'fx', 'line', 'dev'];
  var items = levers.map(function (l) {
    var b = driverBase_(scenarioId, l.driver);
    var fixed = l.fixed !== '' && l.fixed !== null && l.fixed !== undefined && !isNaN(Number(l.fixed));
    var cap = l.capPct === '' || l.capPct === null || l.capPct === undefined || isNaN(Number(l.capPct)) ? null : Math.abs(Number(l.capPct));
    return {
      driver: l.driver, label: b.label, unit: b.unit, base: b.value,
      fixed: fixed, value: fixed ? Number(l.fixed) : b.value,
      share: Math.max(0, toNumber_(l.share)), cap: cap,
      lower: positiveTypes.indexOf(l.driver.type) !== -1 ? 0 : null
    };
  });
  var overridesFor = function (values) {
    var o = { scenarioId: scenarioId };
    items.forEach(function (it, i) {
      if (values[i] === it.base) return;
      o = mergeOverrides_(o, driverOverrides_(scenarioId, it.driver, values[i], it.base));
    });
    return o;
  };
  var metricAt = function (values) {
    return withOverrides_(overridesFor(values), function () { return whatIfMetric_(scenarioId, metric); });
  };
  var baseValues = items.map(function (it) { return it.base; });
  var metricBase = whatIfMetric_(scenarioId, metric);
  var startValues = items.map(function (it) { return it.value; });   // 固定項目先套用
  var metricStart = metricAt(startValues);
  var gap = target - metricStart;
  var free = items.map(function (it, i) { return it.fixed ? -1 : i; }).filter(function (i) { return i >= 0; });
  var warnings = [];

  var clampOf = function (it, x) {
    if (it.cap !== null) {
      var room = Math.abs(it.base) * it.cap / 100;
      x = Math.max(it.base - room, Math.min(it.base + room, x));
    }
    if (it.lower !== null && x < it.lower) x = it.lower;
    return x;
  };

  var finalValues = startValues.slice();
  var feasible = true, scale = 0, message = '';
  if (free.length && Math.abs(gap) >= 0.5) {
    // 每一項的「方向 × 幅度」(s = 1 時的變動量)
    var delta = items.map(function () { return 0; });
    if (mode === 'equal') {
      free.forEach(function (i) {
        var it = items[i];
        if (!it.base) throw new Error('「' + it.label + '」目前是 0，不能用同幅度(%)調整，請改用「依比例分攤」');
        var probe = startValues.slice(); probe[i] = it.base * 1.01;
        var effect = metricAt(probe) - metricStart;
        if (Math.abs(effect) < 1e-9) { warnings.push('「' + it.label + '」調整後結果不會變，不參與分攤'); return; }
        delta[i] = (effect > 0) === (gap > 0) ? it.base * 0.01 : -it.base * 0.01;   // s 的單位 = 1%
      });
    } else {
      var totalShare = free.reduce(function (sum, i) { return sum + items[i].share; }, 0);
      free.forEach(function (i) {
        var it = items[i];
        var share = totalShare > 0 ? it.share / totalShare : 1 / free.length;
        if (!share) return;
        var part = metricStart + gap * share;
        var x = solveScalar_(function (xx) { var v = startValues.slice(); v[i] = xx; return metricAt(v) - part; },
          it.base, Math.abs(it.base) > 1e-9 ? Math.abs(it.base) * 0.05 : 1, it.lower);
        if (x === null) { warnings.push('「' + it.label + '」單獨調整達不到它負責的那一份缺口，已由其他項目吸收'); return; }
        delta[i] = x - it.base;
      });
    }
    var active = free.filter(function (i) { return delta[i] !== 0; });
    if (!active.length) {
      feasible = false;
      message = '選的項目都無法改善這個結果。';
    } else {
      var valuesAt = function (sv) {
        var v = startValues.slice();
        active.forEach(function (i) { v[i] = clampOf(items[i], items[i].base + sv * delta[i]); });
        return v;
      };
      var h = function (sv) { return metricAt(valuesAt(sv)) - target; };
      var h0 = metricStart - target;
      var lo = 0, hi = mode === 'equal' ? 1 : 1, hHi = h(hi), k = 0, prevV = null;
      while ((hHi > 0) === (h0 > 0) && Math.abs(hHi) >= 0.5 && k++ < 24) {
        var vNow = JSON.stringify(valuesAt(hi));
        if (vNow === prevV) break;                  // 全部碰到上限(或 0)了，再放大也沒用
        prevV = vNow;
        lo = hi; hi *= 2; hHi = h(hi);
      }
      if ((hHi > 0) === (h0 > 0) && Math.abs(hHi) >= 0.5) {
        feasible = false;
        finalValues = valuesAt(hi);
        message = '在設定的上限內達不到目標，最多只能做到 ' + Math.round(metricAt(finalValues)) + '。可以放寬上限或再加一個調整項目。';
      } else {
        var hLo = h(lo);
        for (var it2 = 0; it2 < 60; it2++) {
          var mid = (lo + hi) / 2, hm = h(mid);
          if (Math.abs(hm) < 0.5) { lo = hi = mid; break; }
          if ((hm > 0) === (hLo > 0)) { lo = mid; hLo = hm; } else hi = mid;
        }
        scale = (lo + hi) / 2;
        finalValues = valuesAt(scale);
      }
    }
  }

  // 依列表順序逐項加入，算每一項的貢獻(加總 = 總改善)
  var running = baseValues.slice(), prevMetric = metricBase;
  var out = items.map(function (it, i) {
    running[i] = finalValues[i];
    var m = metricAt(running);
    var contribution = m - prevMetric;
    prevMetric = m;
    var room = it.cap !== null ? Math.abs(it.base) * it.cap / 100 : null;
    return {
      driver: it.driver, label: it.label, unit: it.unit, base: it.base, value: finalValues[i],
      pct: it.base ? (finalValues[i] / it.base - 1) * 100 : null,
      fixed: it.fixed, capped: room !== null && !it.fixed && Math.abs(Math.abs(finalValues[i] - it.base) - room) < Math.max(1e-6, room * 1e-6) && room > 0,
      contribution: contribution
    };
  });
  return {
    feasible: feasible, mode: mode, metricBase: metricBase, achieved: prevMetric, target: target,
    equalPct: mode === 'equal' ? scale : null, levers: out, warnings: warnings, message: message
  };
}

/** 瀑布圖工具的選單：所有車型的情境與車系(跨車型比較用) */
function getWaterfallSources() {
  return {
    scenarios: getScenarios().map(function (s) {
      return { ScenarioID: s.ScenarioID, VehicleTypeID: s.VehicleTypeID, Gate: s.Gate || '', ScenarioName: s.ScenarioName || '', ScenarioType: s.ScenarioType || '' };
    }).concat([].concat.apply([], getVehicleTypes().map(function (t) {
      return snapshotScenarioOptions_(t.VehicleTypeID).map(function (o) { o.VehicleTypeID = t.VehicleTypeID; return o; });
    }))),
    vehicles: getVehicles().map(function (v) { return { VehicleID: v.VehicleID, VehicleTypeID: v.VehicleTypeID, VehicleCode: v.VehicleCode || '' }; })
  };
}

/**
 * 目標反推的結果另存成新情境：複製來源情境的全部資料，再把反推出來的假設「寫實」到新情境的資料上 ——
 *   月總銷量  各車系月銷量(與攤提基準月台數)等比例調整
 *   建議零售價 各車系建議零售價等比例調整
 *   某科目    該科目的輸入金額(各車系、各幣別)等比例調整；開發攤提科目則調整攤提到它的開發總投金額
 *   開發總投  全部開發總投金額等比例調整
 *   參數/匯率 新情境直接設成反推出來的值(全車系)
 * 寫完重算一次，回傳新情境的營業淨利與試算值，兩者應該相同(科目有車系個別公式時才可能有差，會一併回報)。
 * levers = [{ driver, value }]，meta = { Gate, ScenarioName, ScenarioType, Notes }
 */
function saveWhatIfAsScenario(scenarioId, levers, meta) {
  if (!scenarioId) throw new Error('請先選擇情境');
  meta = meta || {};
  if (!String(meta.ScenarioName || '').trim()) throw new Error('請輸入新情境名稱');
  var src = getScenarios().filter(function (s) { return s.ScenarioID === scenarioId; })[0];
  if (!src) throw new Error('找不到情境：' + scenarioId);
  var o = { scenarioId: scenarioId };
  var notes = [];
  var dg = function (v) { return Math.abs(v) < 100 ? Math.round(v * 100) / 100 : Math.round(v); };
  (levers || []).forEach(function (l) {
    if (!l || !l.driver || l.value === '' || l.value === null || l.value === undefined) return;
    var b = driverBase_(scenarioId, l.driver);
    var v = toNumber_(l.value);
    if (Math.abs(v - b.value) < 1e-9) return;
    o = mergeOverrides_(o, driverOverrides_(scenarioId, l.driver, v, b.value));
    notes.push(b.label + ' ' + dg(b.value) + ' → ' + dg(v) + (b.unit ? ' ' + b.unit : '') +
      (b.value ? '（' + (v / b.value - 1 >= 0 ? '+' : '') + (Math.round((v / b.value - 1) * 1000) / 10) + '%）' : ''));
  });
  if (!notes.length) throw new Error('沒有任何調整，不需要另存');
  var expected = withOverrides_(o, function () { return whatIfMetric_(scenarioId, { code: '', basis: 'unit' }); });

  return withLock_(function () {
    var row = {
      ScenarioID: '', Gate: meta.Gate || src.Gate, ScenarioName: String(meta.ScenarioName).trim(),
      ScenarioType: meta.ScenarioType || src.ScenarioType || '目標', VehicleTypeID: src.VehicleTypeID,
      Notes: (meta.Notes ? meta.Notes + '\n' : '') + '由「' + [src.Gate, src.ScenarioName].join(' ') + '」目標反推：' + notes.join('；')
    };
    if (toNumber_(src.AmortMonthlyVolume) > 0) row.AmortMonthlyVolume = toNumber_(src.AmortMonthlyVolume) * (o.volume || 1);
    if (src.AmortLifeCycleYears !== undefined && src.AmortLifeCycleYears !== '') row.AmortLifeCycleYears = src.AmortLifeCycleYears;
    var saved = saveScenario(row);
    var newId = saved.ScenarioID;
    copyScenarioData(scenarioId, newId, ['salesmix', 'costofsales', 'devinvestment', 'operatingexpense', 'parameters', 'linenotes', 'actions'], { keepChallenge: true });

    var scaleRows = function (sheetName, pk, fieldFactor) {
      var ups = [];
      (sheetToObjects_(sheetName) || []).filter(function (r) { return r.ScenarioID === newId; }).forEach(function (r) {
        var changed = fieldFactor(r);
        if (!changed) return;
        var c = {};
        SCHEMA[sheetName].forEach(function (h) { c[h] = r[h]; });
        Object.keys(changed).forEach(function (k) { c[k] = changed[k]; });
        ups.push(c);
      });
      if (ups.length) batchWriteRows_(sheetName, pk, ups, []);
    };
    var lineScale = o.lineScale || {};
    if (o.volume || o.price) {
      scaleRows(SHEETS.SALES_MIX, 'RowID', function (r) {
        var c = {};
        if (o.volume && r.MonthlyVolume !== '' && r.MonthlyVolume !== undefined) c.MonthlyVolume = toNumber_(r.MonthlyVolume) * o.volume;
        if (o.price && r.ListPriceTaxIncl !== '' && r.ListPriceTaxIncl !== undefined) c.ListPriceTaxIncl = toNumber_(r.ListPriceTaxIncl) * o.price;
        return Object.keys(c).length ? c : null;
      });
    }
    if (Object.keys(lineScale).length) {
      [[SHEETS.COST_OF_SALES, 'RowID'], [SHEETS.OPERATING_EXPENSE, 'RowID']].forEach(function (t) {
        scaleRows(t[0], t[1], function (r) {
          return lineScale[r.LineCode] !== undefined ? { Amount: toNumber_(r.Amount) * lineScale[r.LineCode] } : null;
        });
      });
    }
    if (o.dev || Object.keys(lineScale).length) {
      scaleRows(SHEETS.DEV_INVESTMENT, 'RowID', function (r) {
        var f = (o.dev || 1) * (lineScale[r.TargetLineCode] !== undefined ? lineScale[r.TargetLineCode] : 1);
        return f !== 1 ? { Amount: toNumber_(r.Amount) * f } : null;
      });
    }
    if (o.params || o.fx) {
      var p = o.params || {}, fx = o.fx || {};
      var dels = (sheetToObjects_(SHEETS.PARAMETERS) || []).filter(function (r) {
        return r.ScenarioID === newId && (p[r.ParamName] !== undefined || (r.ParamName === COST_FX_PARAM_NAME && fx[r.Currency] !== undefined));
      }).map(function (r) { return r.ParamID; });
      var adds = Object.keys(p).map(function (name) { return { ParamID: '', ScenarioID: newId, VehicleID: '', ParamName: name, Currency: '', Value: p[name], EffectiveDate: '' }; })
        .concat(Object.keys(fx).map(function (cur) { return { ParamID: '', ScenarioID: newId, VehicleID: '', ParamName: COST_FX_PARAM_NAME, Currency: cur, Value: fx[cur], EffectiveDate: '' }; }));
      batchWriteRows_(SHEETS.PARAMETERS, 'ParamID', adds, dels);
    }
    resetCalcMemo_();
    var actual = whatIfMetric_(newId, { code: '', basis: 'unit' });
    return { scenario: getScenarios().filter(function (s) { return s.ScenarioID === newId; })[0], expected: expected, actual: actual, notes: notes };
  });
}
