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

/** 情境快照當成報告的一個區塊(跟 reportScenarioBlock_ 同樣的欄位；快照沒有說明與開發總投明細) */
function snapshotReportBlock_(snapId) {
  var d = snapshotData_(String(snapId).slice(SNAPSHOT_PREFIX.length));
  if (!d) throw new Error('找不到快照（可能已被刪除）');
  var w = d.columns.filter(function (c) { return !c.vehicleId; })[0] || { amounts: {}, volume: { monthlyVolume: 0, units: 0 } };
  var vol = w.volume || { monthlyVolume: 0, units: 0 };
  return {
    meta: { ScenarioID: snapId, VehicleTypeID: d.scenario.VehicleTypeID || '', Gate: d.scenario.Gate || '', ScenarioName: d.scenario.ScenarioName || '',
      ScenarioType: d.scenario.ScenarioType || '', Notes: d.meta.Notes || '', label: snapshotLabel_(d) },
    vehicles: d.columns.filter(function (c) { return c.vehicleId; }).map(function (c) {
      var v = c.volume || {};
      return { VehicleID: c.vehicleId, VehicleCode: c.vehicleLabel || c.vehicleId, salesMixPct: toNumber_(v.salesMixPct),
        monthlyVolume: toNumber_(v.monthlyVolume), lifeCycleYears: toNumber_(v.lifeCycleYears), amounts: c.amounts };
    }),
    weighted: w.amounts || {},
    volume: vol,
    lifeCycleUnits: toNumber_(vol.units),
    notes: {}, errors: {},
    dev: { rows: [], total: { mold: 0, equip: 0, expense: 0, other: 0, total: 0, reduced: 0 }, lifeCycleUnits: toNumber_(vol.units) },
    isSnapshot: true,
    snapshotLines: d.lines.map(function (l) { var c = {}; Object.keys(l).forEach(function (k) { c[k] = l[k]; }); c.SortOrder = toNumber_(l.SortOrder); return c; })
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
  // 前回可以是情境快照(上次審議時存的那一版)：快照存的是計算結果，直接拿來比
  var prev = !prevScenarioId ? null : isSnapshotId_(prevScenarioId) ? snapshotReportBlock_(prevScenarioId) : reportScenarioBlock_(prevScenarioId);
  // 損益兩平月銷量：月銷量要多少台營業淨利才會是 0(攤提台數跟著變)
  target.breakEvenVolume = breakEvenVolume_(targetScenarioId);
  if (base) base.breakEvenVolume = breakEvenVolume_(baseScenarioId);

  var types = [target.meta.VehicleTypeID];
  if (base) types.push(base.meta.VehicleTypeID);
  if (prev) types.push(prev.meta.VehicleTypeID);
  var defLists = types.map(function (t) { return getPLLineItems(t); });
  if (prev && prev.snapshotLines) defLists.push(prev.snapshotLines);   // 快照當時有、現在已刪掉的科目也要列得出來
  var defs = unionLineDefs_(defLists);
  // 每個情境看自己車型的營業淨利科目(現況/前回可能是別的車型，K 還在或已經換成別的科目)
  [target, base, prev].forEach(function (b) { if (b) b.profitCode = profitLineCode_(b.snapshotLines || getPLLineItems(b.meta.VehicleTypeID)); });
  var profitCode = target.profitCode;
  var profitCodes = {};
  [target, base, prev].forEach(function (b) { if (b) profitCodes[b.profitCode] = true; });
  var depth = lineDepths_(defs);
  var used = function (code) {
    return [target, base, prev].some(function (b) { return b && b.weighted[code] !== undefined; });
  };

  return {
    vehicleTypeId: target.meta.VehicleTypeID,
    profitCode: profitCode,
    target: target, base: base, prev: prev,
    lines: defs.filter(function (d) { return used(d.LineCode); }).map(function (d) {
      return {
        LineCode: d.LineCode, LineName: d.LineName, ParentLine: d.ParentLine || '', Category: d.Category || '',
        CalcType: d.CalcType, Formula: d.CalcType === CALC_TYPES.FORMULA ? d.Formula : '',
        Depth: depth[d.LineCode] || 0,
        isSubtotal: PROTECTED_LINE_CODES.indexOf(d.LineCode) !== -1 || !!profitCodes[d.LineCode] || isGroupLine_(d, defs),
        isProfit: !!profitCodes[d.LineCode],
        isPriceStructure: d.Category === '售價結構'
      };
    }),
    actions: getActions(targetScenarioId),
    actionStatuses: ACTION_STATUSES,
    generatedAt: new Date().toISOString()
  };
}

/* ---------------------------------------------------------------
 * 情境快照(版本紀錄)
 * 審議前後數字常常改：存一份快照，之後就能比較「現在跟審議那一版差在哪」。
 * 快照存的是計算結果(不是輸入資料)，所以科目表、公式、輸入資料之後怎麼改都不會影響它。
 * 在比較功能裡，快照用代號 snap:<SnapshotID> 當成唯讀情境，儀表板/瀑布圖工具直接可用。
 * --------------------------------------------------------------- */
var SNAPSHOT_PREFIX = 'snap:';
var SNAPSHOT_MEMO_ = {};
function isSnapshotId_(id) { return String(id || '').indexOf(SNAPSHOT_PREFIX) === 0; }

/** 舊的試算表沒有 Snapshots 分頁：第一次用到時補建 */
function ensureSnapshotSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.SNAPSHOTS)) return;
  var sheet = ss.insertSheet(SHEETS.SNAPSHOTS);
  sheet.getRange(1, 1, 1, SCHEMA.Snapshots.length).setValues([SCHEMA.Snapshots]);
  sheet.setFrozenRows(1);
  invalidateSheetCache_();
}
function snapshotRows_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(SHEETS.SNAPSHOTS)) return [];
  return sheetToObjects_(SHEETS.SNAPSHOTS) || [];
}
function snapshotMeta_(r) {
  return {
    SnapshotID: r.SnapshotID, VehicleTypeID: r.VehicleTypeID || '', ScenarioID: r.ScenarioID || '',
    SnapshotName: r.SnapshotName || '', CreatedAt: r.CreatedAt ? String(r.CreatedAt) : '', CreatedBy: r.CreatedBy || '', Notes: r.Notes || ''
  };
}

/** 某車型的快照清單(新到舊)，含快照當時的情境名稱與加權營業淨利 */
function getSnapshots(vehicleTypeId) {
  return snapshotRows_().filter(function (r) { return !vehicleTypeId || r.VehicleTypeID === vehicleTypeId; })
    .map(function (r) {
      var m = snapshotMeta_(r);
      var d = snapshotData_(r.SnapshotID);
      m.scenarioLabel = d ? [d.scenario.Gate, d.scenario.ScenarioName].filter(function (x) { return x; }).join(' ') : '';
      m.scenarioType = d ? d.scenario.ScenarioType || '' : '';
      var w = d ? d.columns.filter(function (c) { return !c.vehicleId; })[0] : null;
      var pc = d && d.lines ? profitLineCode_(d.lines) : 'K';
      m.K = w && w.amounts[pc] !== undefined ? w.amounts[pc] : null;
      m.scenarioExists = getScenarios().some(function (s) { return s.ScenarioID === r.ScenarioID; });
      return m;
    })
    .sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
}

function snapshotData_(snapshotId) {
  if (SNAPSHOT_MEMO_[snapshotId]) return SNAPSHOT_MEMO_[snapshotId];
  var r = snapshotRows_().filter(function (x) { return x.SnapshotID === snapshotId; })[0];
  if (!r) return null;
  var d = null;
  try { d = JSON.parse(r.Data); } catch (e) { d = null; }
  if (!d || !d.columns) return null;
  d.meta = snapshotMeta_(r);
  SNAPSHOT_MEMO_[snapshotId] = d;
  return d;
}

/** 建立快照：加權平均 + 銷售構成裡每個車系，各存一份完整的損益金額 */
function createSnapshot(scenarioId, name, notes) {
  if (!scenarioId || isSnapshotId_(scenarioId)) throw new Error('請選擇要存快照的情境');
  name = String(name || '').trim();
  if (!name) throw new Error('請輸入快照名稱');
  var scenario = getScenarios().filter(function (s) { return s.ScenarioID === scenarioId; })[0];
  if (!scenario) throw new Error('找不到情境：' + scenarioId);
  var sels = [{ ScenarioID: scenarioId, VehicleID: '' }].concat(calcSalesMix_(scenarioId).map(function (r) { return { ScenarioID: scenarioId, VehicleID: r.VehicleID }; }));
  var cmp = calculateComparison(sels);
  var round = function (v) { return typeof v === 'number' ? Math.round(v * 100) / 100 : v; };
  var data = {
    v: 1,
    scenario: { Gate: scenario.Gate || '', ScenarioName: scenario.ScenarioName || '', ScenarioType: scenario.ScenarioType || '', VehicleTypeID: scenario.VehicleTypeID || '' },
    lines: cmp.lines.map(function (l) {
      return { LineCode: l.LineCode, LineName: l.LineName, Category: l.Category, ParentLine: l.ParentLine, SortOrder: l.SortOrder,
        CalcType: l.CalcType, Formula: l.Formula, AutoSource: l.AutoSource };
    }),
    columns: cmp.columns.map(function (c) {
      var amounts = {};
      Object.keys(c.amounts).forEach(function (k) { amounts[k] = round(c.amounts[k]); });
      return { vehicleId: c.vehicleId, vehicleLabel: c.vehicleLabel, isWeighted: c.isWeighted, amounts: amounts,
        revenue: round(c.revenue), exFactoryPrice: round(c.exFactoryPrice),
        volume: { monthlyVolume: c.volume.monthlyVolume, lifeCycleYears: c.volume.lifeCycleYears, units: c.volume.units, salesMixPct: c.volume.salesMixPct, mix: c.volume.mix || [] } };
    })
  };
  var json = JSON.stringify(data);
  if (json.length > 48000) throw new Error('這個情境的資料太多，超過單一快照可以存的大小（' + json.length + ' 字）');
  return withLock_(function () {
    ensureSnapshotSheet_();
    var user = '';
    try { user = Session.getActiveUser().getEmail(); } catch (e) { user = ''; }
    var row = { SnapshotID: generateId_('SNAP'), VehicleTypeID: scenario.VehicleTypeID || '', ScenarioID: scenarioId, SnapshotName: name,
      CreatedAt: new Date().toISOString(), CreatedBy: user, Notes: notes || '', Data: json };
    batchWriteRows_(SHEETS.SNAPSHOTS, 'SnapshotID', [row], []);
    SNAPSHOT_MEMO_ = {};
    return snapshotMeta_(row);
  });
}
function renameSnapshot(snapshotId, name, notes) {
  name = String(name || '').trim();
  if (!name) throw new Error('請輸入快照名稱');
  return withLock_(function () {
    var r = snapshotRows_().filter(function (x) { return x.SnapshotID === snapshotId; })[0];
    if (!r) throw new Error('找不到快照');
    var c = {};
    SCHEMA.Snapshots.forEach(function (h) { c[h] = r[h]; });
    c.SnapshotName = name;
    if (notes !== undefined) c.Notes = notes;
    batchWriteRows_(SHEETS.SNAPSHOTS, 'SnapshotID', [c], []);
    SNAPSHOT_MEMO_ = {};
    return snapshotMeta_(c);
  });
}
function deleteSnapshot(snapshotId) {
  return withLock_(function () {
    if (!snapshotRows_().some(function (x) { return x.SnapshotID === snapshotId; })) return true;
    batchWriteRows_(SHEETS.SNAPSHOTS, 'SnapshotID', [], [snapshotId]);
    SNAPSHOT_MEMO_ = {};
    return true;
  });
}

function snapshotLabel_(d) {
  var day = String(d.meta.CreatedAt || '').slice(5, 10).replace('-', '/');
  return [d.scenario.Gate, d.scenario.ScenarioName].filter(function (x) { return x; }).join(' ') + '［快照 ' + d.meta.SnapshotName + (day ? ' ' + day : '') + '］';
}
/** 比較選單用：快照當成唯讀情境 */
function snapshotScenarioOptions_(vehicleTypeId) {
  return snapshotRows_().filter(function (r) { return r.VehicleTypeID === vehicleTypeId; })
    .map(function (r) { return snapshotData_(r.SnapshotID); })
    .filter(function (d) { return d; })
    .sort(function (a, b) { return String(b.meta.CreatedAt).localeCompare(String(a.meta.CreatedAt)); })
    .map(function (d) {
      var label = snapshotLabel_(d);
      return { ScenarioID: SNAPSHOT_PREFIX + d.meta.SnapshotID, Gate: '', ScenarioName: label, ScenarioType: d.scenario.ScenarioType || '', isSnapshot: true };
    });
}
/** calculateComparison 用：快照的一欄(跟一般欄位同樣的欄位，另帶 snapshotLines 給科目聯集) */
function snapshotColumn_(sel) {
  var id = String(sel.ScenarioID).slice(SNAPSHOT_PREFIX.length);
  var d = snapshotData_(id);
  if (!d) throw new Error('找不到快照（可能已被刪除）');
  var col = d.columns.filter(function (c) { return (c.vehicleId || '') === (sel.VehicleID || ''); })[0];
  var vehicle = getVehicles().filter(function (v) { return v.VehicleID === sel.VehicleID; })[0];
  var label = snapshotLabel_(d);
  var vehicleLabel = sel.VehicleID ? ((col && col.vehicleLabel) || (vehicle && vehicle.VehicleCode) || sel.VehicleID) : '加權平均';
  var amounts = col ? col.amounts : {};
  return {
    scenarioId: sel.ScenarioID, vehicleId: sel.VehicleID || '', vehicleTypeId: d.scenario.VehicleTypeID,
    vehicleTypeLabel: d.scenario.VehicleTypeID, scenarioLabel: label, scenarioType: d.scenario.ScenarioType || '',
    scenarioNotes: d.meta.Notes || '', vehicleLabel: vehicleLabel, isWeighted: !sel.VehicleID, isSnapshot: true,
    volume: col ? col.volume : { monthlyVolume: 0, units: 0, mix: [] }, traces: null, errors: {},
    label: [d.scenario.VehicleTypeID, label, vehicleLabel].filter(function (p) { return p; }).join(' / '),
    amounts: amounts, revenue: amounts.A || 0, exFactoryPrice: amounts.P8 || 0, checks: [],
    snapshotLines: d.lines.map(function (l) { var c = {}; Object.keys(l).forEach(function (k) { c[k] = l[k]; }); c.SortOrder = toNumber_(l.SortOrder); return c; })
  };
}
