/**
 * GATE 審議報告(簡報)用的資料。
 *
 * 對應 GATE F 審議會簡報「伍、F/S試算與目標成本作法說明」那幾頁：
 *   - 細車型 FS 損益(現況 / 目標)，每個科目附「說明」
 *   - 現況與目標的差距：哪些科目差多少、合計差多少
 *   - 作法：差距靠哪些改善作法補起來、各負責單位、目前還差多少
 *   - 前回 vs 本回(可選)
 *   - 開發總投 by 部門(模具/設備/費用 + 挑戰低減目標)
 * 這裡只負責把數字一次算好交給前端，排版、差距瀑布圖、列印成簡報都在前端做。
 */

function scenarioMeta_(scenarioId) {
  var s = getScenarios().filter(function (r) { return r.ScenarioID === scenarioId; })[0];
  if (!s) throw new Error('找不到情境：' + scenarioId);
  return {
    ScenarioID: s.ScenarioID, VehicleTypeID: s.VehicleTypeID || '', Gate: s.Gate || '',
    ScenarioName: s.ScenarioName || '', ScenarioType: s.ScenarioType || '現況', Notes: s.Notes || '',
    label: [s.Gate, s.ScenarioName].filter(function (x) { return x; }).join(' ')
  };
}

/** 一個情境的完整損益：各車系 + 加權平均 + 銷量 + 說明 + 開發總投彙總 */
function reportScenarioBlock_(scenarioId) {
  var meta = scenarioMeta_(scenarioId);
  var all = calculatePLAllVehicles(scenarioId);
  var vehiclesById = {};
  getVehicles(meta.VehicleTypeID).forEach(function (v) { vehiclesById[v.VehicleID] = v; });
  var mix = getSalesMix(scenarioId);
  var order = getVehicles(meta.VehicleTypeID).map(function (v) { return v.VehicleID; });
  var vehicleResults = all.vehicles.slice().sort(function (a, b) {
    return order.indexOf(a.vehicleId) - order.indexOf(b.vehicleId);
  });

  var errors = {};
  vehicleResults.forEach(function (res) {
    Object.keys(res.errors).forEach(function (c) { if (!errors[c]) errors[c] = res.errors[c]; });
  });
  var weighted = {};
  all.weightedAverage.forEach(function (l) { weighted[l.LineCode] = l.Amount; });

  return {
    meta: meta,
    vehicles: vehicleResults.map(function (res) {
      var row = mix.filter(function (r) { return r.VehicleID === res.vehicleId; })[0] || {};
      var v = vehiclesById[res.vehicleId] || {};
      return {
        VehicleID: res.vehicleId, VehicleCode: v.VehicleCode || res.vehicleId,
        salesMixPct: toNumber_(row.SalesMixPct), monthlyVolume: toNumber_(row.MonthlyVolume),
        lifeCycleYears: toNumber_(row.LifeCycleYears),
        amounts: res.lineValues
      };
    }),
    weighted: weighted,
    volume: columnVolumeInfo_(scenarioId, '', getVehicles()),
    lifeCycleUnits: getLifeCycleUnits(scenarioId),
    notes: getLineNotes(scenarioId),
    errors: errors,
    dev: devByDepartment_(scenarioId)
  };
}

/**
 * 開發總投 by 部門：模具/設備/費用三大類 + 挑戰低減目標 + 低減後小計(對應簡報附件那一頁)。
 * 大類看攤提落點科目的 DevAmortCategory；BASE廠開發費等費用類一起算在「費用」。
 */
function devByDepartment_(scenarioId) {
  var typeId = vehicleTypeOfScenario_(scenarioId);
  var categoryOf = {};
  getPLLineItems(typeId).forEach(function (d) { categoryOf[d.LineCode] = d.DevAmortCategory || ''; });
  var params = getParameters(scenarioId);
  var isBaseline = isBaselineScenario_(scenarioId);
  var depts = {}, order = [];
  sortByOrder_(getDevInvestment(scenarioId), 'SortOrder').forEach(function (r) {
    var target = devAmortTargetOf_(r);
    var amount = toNumber_(r.Amount) * fxRateFor_(params, r.Currency, '');
    var pct = isBaseline ? 0 : toNumber_(r.ChallengeReductionPct);
    var name = r.Department || '(未填部門)';
    if (!depts[name]) {
      depts[name] = { Department: name, mold: 0, equip: 0, expense: 0, other: 0, total: 0, reduced: 0, notes: [] };
      order.push(name);
    }
    var d = depts[name];
    var cat = categoryOf[target] || '';
    if (cat === '模具') d.mold += amount;
    else if (cat === '設備') d.equip += amount;
    else if (cat === '費用') d.expense += amount;
    else d.other += amount;
    d.total += amount;
    d.reduced += amount * (1 - pct / 100);
    if (r.Notes) d.notes.push(String(r.Notes));
  });
  var rows = order.map(function (n) {
    var d = depts[n];
    d.pct = d.total ? (1 - d.reduced / d.total) * 100 : 0;
    d.notes = d.notes.join('；');
    return d;
  });
  var sum = function (f) { return rows.reduce(function (s, r) { return s + r[f]; }, 0); };
  return {
    rows: rows,
    total: { mold: sum('mold'), equip: sum('equip'), expense: sum('expense'), other: sum('other'), total: sum('total'), reduced: sum('reduced') },
    lifeCycleUnits: getLifeCycleUnits(scenarioId)
  };
}

/**
 * 報告資料：target(目標/本回)必填；base(現況)、prev(前回)可選。
 * 差距一律用「目標 − 現況」，對營業淨利來說正數 = 改善。
 */
function getGateReport(baseScenarioId, targetScenarioId, prevScenarioId) {
  if (!targetScenarioId) throw new Error('請選擇目標情境');
  var target = reportScenarioBlock_(targetScenarioId);
  var base = baseScenarioId ? reportScenarioBlock_(baseScenarioId) : null;
  var prev = prevScenarioId ? reportScenarioBlock_(prevScenarioId) : null;
  // 損益兩平月銷量：月銷量要多少台營業淨利才會是 0(攤提台數跟著變)
  target.breakEvenVolume = breakEvenVolume_(targetScenarioId);
  if (base) base.breakEvenVolume = breakEvenVolume_(baseScenarioId);

  var types = [target.meta.VehicleTypeID];
  if (base) types.push(base.meta.VehicleTypeID);
  if (prev) types.push(prev.meta.VehicleTypeID);
  var defs = unionLineDefs_(types.map(function (t) { return getPLLineItems(t); }));
  var depth = lineDepths_(defs);
  var used = function (code) {
    return [target, base, prev].some(function (b) { return b && b.weighted[code] !== undefined; });
  };

  return {
    vehicleTypeId: target.meta.VehicleTypeID,
    target: target, base: base, prev: prev,
    lines: defs.filter(function (d) { return used(d.LineCode); }).map(function (d) {
      return {
        LineCode: d.LineCode, LineName: d.LineName, ParentLine: d.ParentLine || '', Category: d.Category || '',
        CalcType: d.CalcType, Formula: d.CalcType === CALC_TYPES.FORMULA ? d.Formula : '',
        Depth: depth[d.LineCode] || 0,
        isSubtotal: PROTECTED_LINE_CODES.indexOf(d.LineCode) !== -1 || isGroupLine_(d, defs),
        isPriceStructure: d.Category === '售價結構'
      };
    }),
    actions: getActions(targetScenarioId),
    actionStatuses: ACTION_STATUSES,
    generatedAt: new Date().toISOString()
  };
}
