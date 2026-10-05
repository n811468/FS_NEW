/**
 * 資料存取層：每張表提供 get / save / delete。
 * 個人使用版本，仍用 LockService 避免同一個瀏覽器分頁快速連點造成資料錯亂。
 */

// 可重入：有些整批作業(如刪科目連帶刪金額)會呼叫其他同樣上鎖的函式，
// 巢狀時只由最外層真正取得/釋放鎖，避免自己卡住自己。
var LOCK_DEPTH_ = 0;

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  // 30 秒：车型/车系重新命名要连带改好几张表，资料多的时候比一般存档慢，
  // 10 秒常常等不到就先丢「鎖定逾時」，改成比照 Apps Script 常见值调宽松一点。
  if (LOCK_DEPTH_ === 0) lock.waitLock(30000);
  LOCK_DEPTH_++;
  try {
    return fn();
  } finally {
    LOCK_DEPTH_--;
    if (LOCK_DEPTH_ === 0) lock.releaseLock();
  }
}

/**
 * 開場資料：車型清單 + 預設選到的車型與它底下的情境，一次取回。
 * 前端載入時原本要分別呼叫 getVehicleTypes / getScenarios 並各觸發一次重繪，
 * 每趟 google.script.run 往返都是數百毫秒，合併成一次可以明顯縮短開場等待。
 */
function getBootstrap(preferredVehicleTypeId) {
  // 開頁時順手把「由程式定義的科目名稱」對回來。做成自動修復而不是維護選單，
  // 是因為名稱對不上數字的畫面看起來就是「系統算錯了」，不該要使用者先知道有這支維護功能。
  // 只有真的對不上時才寫入，之後每次開頁都只是一次讀取。
  // 開頁時順手做資料模型升級(舊版全域科目表 → 每個車型各一份、補公式欄位)。已升級過的資料只會讀、不會寫。
  withLock_(function () { return migrateDataModel_(true); });

  var types = getVehicleTypes();
  var ids = types.map(function (t) { return t.VehicleTypeID; });
  var pick = (preferredVehicleTypeId && ids.indexOf(preferredVehicleTypeId) !== -1)
    ? preferredVehicleTypeId : (ids[0] || '');
  return {
    vehicleTypes: types,
    vehicleTypeId: pick,
    scenarios: pick ? getScenarios(pick) : []
  };
}

// ---- VehicleTypes（車型主檔，如 K5/S3/M7，需先建立才能在底下新增車系） ----
function getVehicleTypes() {
  return sheetToObjects_(SHEETS.VEHICLE_TYPES) || [];
}
function saveVehicleType(rowObj) {
  return withLock_(function () { return upsertRowMerge_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', rowObj); });
}
/**
 * 刪除車型：底下的車系、情境(連同每個情境的輸入資料、作法、說明、計算結果)、快照、自己的科目表一起刪掉。
 * 只刪主檔那一列的話，車系與情境資料還在卻看不到；之後用同一個代號重建車型或新增同代號車系時，舊資料又會冒出來。
 */
function deleteVehicleType(vehicleTypeId) {
  return withLock_(function () {
    var ofType = function (sheetName) {
      return (sheetToObjects_(sheetName) || []).filter(function (r) { return r.VehicleTypeID === vehicleTypeId; });
    };
    var scenarioIds = ofType(SHEETS.SCENARIOS).map(function (r) { return r.ScenarioID; });
    deleteScenarioData_(scenarioIds);
    if (scenarioIds.length) batchWriteRows_(SHEETS.SCENARIOS, 'ScenarioID', [], scenarioIds);
    var vehicleIds = ofType(SHEETS.VEHICLES).map(function (r) { return r.VehicleID; });
    if (vehicleIds.length) batchWriteRows_(SHEETS.VEHICLES, 'VehicleID', [], vehicleIds);
    var actionIds = ofType(SHEETS.ACTIONS).map(function (r) { return r.ActionID; });
    if (actionIds.length) batchWriteRows_(SHEETS.ACTIONS, 'ActionID', [], actionIds);
    if (sheetExists_(SHEETS.SNAPSHOTS)) {
      var snapIds = ofType(SHEETS.SNAPSHOTS).map(function (r) { return r.SnapshotID; });
      if (snapIds.length) batchWriteRows_(SHEETS.SNAPSHOTS, 'SnapshotID', [], snapIds);
    }
    // 車型自己的那份科目表一起刪掉(科目表是跟著車型走的)
    var chart = ofType(SHEETS.PL_LINE_ITEMS).map(function (r) { return r.LineID; });
    if (chart.length) batchWriteRows_(SHEETS.PL_LINE_ITEMS, 'LineID', [], chart);
    return deleteRow_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', vehicleTypeId);
  });
}

/** 掛在情境底下的表(ScenarioID)與各自的主鍵：刪情境時一起清掉 */
var SCENARIO_DATA_SHEETS_ = [
  [SHEETS.SALES_MIX, 'RowID'], [SHEETS.COST_OF_SALES, 'RowID'], [SHEETS.DEV_INVESTMENT, 'RowID'],
  [SHEETS.OPERATING_EXPENSE, 'RowID'], [SHEETS.PARAMETERS, 'ParamID'], [SHEETS.LINE_NOTES, 'RowID'],
  [SHEETS.ACTIONS, 'ActionID'], [SHEETS.PL_RESULT, 'ResultID']
];
function deleteScenarioData_(scenarioIds) {
  var ids = {};
  (scenarioIds || []).forEach(function (id) { if (id) ids[id] = true; });
  if (!Object.keys(ids).length) return;
  SCENARIO_DATA_SHEETS_.forEach(function (pair) {
    if (!sheetExists_(pair[0])) return;
    var dead = (sheetToObjects_(pair[0]) || []).filter(function (r) { return ids[r.ScenarioID]; })
      .map(function (r) { return r[pair[1]]; });
    if (dead.length) batchWriteRows_(pair[0], pair[1], [], dead);
  });
}
/** 車型主檔整批儲存：整張表直接編輯、按一次儲存（沒填代號的空白新增列會被略過） */
function saveVehicleTypeGrid(rows) {
  return withLock_(function () {
    var existingByPk = indexByPk_(getVehicleTypes(), 'VehicleTypeID');
    var upserts = (rows || []).filter(function (r) { return r.VehicleTypeID; })
      .map(function (r) { return mergeRowForBatch_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', r, existingByPk); });
    batchWriteRows_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', upserts, []);
    return getVehicleTypes();
  });
}

/**
 * 車型代號重新命名：新增一列新代號、把所有引用舊代號的資料(車系、情境)一併改成新代號，
 * 最後刪掉舊代號那一列。車型代號是車系/情境的外鍵，只改主檔那一列會讓底下的車系跟情境
 * 全部找不到自己屬於哪個車型(等於資料還在、畫面上卻消失)，所以一定要連動更新。
 */
function renameVehicleType(oldId, newId) {
  return withLock_(function () {
    newId = String(newId || '').trim();
    if (!oldId || !newId) throw new Error('車型代號不能為空');
    if (oldId === newId) return getVehicleTypes();
    validateCode_('車型代號', newId);
    var existing = getVehicleTypes();
    var row = existing.filter(function (t) { return t.VehicleTypeID === oldId; })[0];
    if (!row) throw new Error('找不到車型：' + oldId);
    if (existing.some(function (t) { return t.VehicleTypeID === newId; })) {
      throw new Error('車型代號「' + newId + '」已經存在');
    }

    row.VehicleTypeID = newId;
    upsertRow_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', row);
    deleteRow_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', oldId);

    [[SHEETS.VEHICLES, 'VehicleID'], [SHEETS.SCENARIOS, 'ScenarioID'], [SHEETS.ACTIONS, 'ActionID']].forEach(function (pair) {
      var sheetName = pair[0], pk = pair[1];
      var rows = (sheetToObjects_(sheetName) || []).filter(function (r) { return r.VehicleTypeID === oldId; });
      rows.forEach(function (r) { r.VehicleTypeID = newId; });
      if (rows.length) batchWriteRows_(sheetName, pk, rows, []);
    });
    // 科目表的主鍵含車型代號，要整份換成新代號
    var chart = (sheetToObjects_(SHEETS.PL_LINE_ITEMS) || []).filter(function (r) { return r.VehicleTypeID === oldId; });
    if (chart.length) {
      var oldPks = chart.map(function (r) { return r.LineID; });
      var moved = chart.map(function (r) {
        var copy = {};
        SCHEMA.PLLineItems.forEach(function (h) { copy[h] = r[h] === undefined ? '' : r[h]; });
        copy.VehicleTypeID = newId;
        copy.LineID = lineIdOf_(newId, r.LineCode);
        return copy;
      });
      batchWriteRows_(SHEETS.PL_LINE_ITEMS, 'LineID', moved, oldPks);
    }
    return getVehicleTypes();
  });
}

// ---- Vehicles（車系，如 標準型/豪華型，隸屬某個 VehicleType） ----
/**
 * 車系清單依 SortOrder 排序：這個順序會帶到所有用車系排欄位的地方
 * （銷貨成本/營業費用矩陣的欄位、儀表板的車系選單...），車系設定頁可以直接改「排序」欄位調整。
 * 沒填排序值的車系排在最後面(用 Infinity)，相對順序仍照 Sheet 上的原始順序(穩定排序)。
 */
function getVehicles(vehicleTypeId) {
  var rows = sheetToObjects_(SHEETS.VEHICLES) || [];
  rows = vehicleTypeId ? rows.filter(function (r) { return r.VehicleTypeID === vehicleTypeId; }) : rows;
  return sortByOrder_(rows, 'SortOrder');
}
function saveVehicle(rowObj) {
  return withLock_(function () { return upsertRowMerge_(SHEETS.VEHICLES, 'VehicleID', rowObj); });
}
/** 刪除車系：它在各情境的銷售構成、成本、費用、車系參數、說明一起刪掉，免得之後新增同代號車系時舊數字又冒出來 */
function deleteVehicle(vehicleId) {
  return withLock_(function () {
    [[SHEETS.SALES_MIX, 'RowID'], [SHEETS.COST_OF_SALES, 'RowID'], [SHEETS.OPERATING_EXPENSE, 'RowID'],
      [SHEETS.PARAMETERS, 'ParamID'], [SHEETS.LINE_NOTES, 'RowID'], [SHEETS.PL_RESULT, 'ResultID']].forEach(function (pair) {
      if (!sheetExists_(pair[0])) return;
      var dead = (sheetToObjects_(pair[0]) || []).filter(function (r) { return vehicleId && r.VehicleID === vehicleId; })
        .map(function (r) { return r[pair[1]]; });
      if (dead.length) batchWriteRows_(pair[0], pair[1], [], dead);
    });
    return deleteRow_(SHEETS.VEHICLES, 'VehicleID', vehicleId);
  });
}
/** 車系設定整批儲存 */
function saveVehicleGrid(vehicleTypeId, rows) {
  return withLock_(function () {
    var all = sheetToObjects_(SHEETS.VEHICLES) || [];
    var existingByPk = indexByPk_(all, 'VehicleID');
    var types = indexByPk_(getVehicleTypes(), 'VehicleTypeID');
    // 車系代號是全資料庫唯一的主鍵：同一張表重複、或已經屬於別的車型，直接存會把那一列整個蓋掉(連車型都換掉)
    var seen = {};
    (rows || []).forEach(function (r) {
      var id = String(r.VehicleID || '').trim();
      if (!id) return;
      r.VehicleID = id;
      if (seen[id]) throw new Error('車系代號「' + id + '」重複了，每個車系的代號要不一樣');
      seen[id] = true;
      var owner = existingByPk[id] ? existingByPk[id].VehicleTypeID : '';
      if (!owner) { validateCode_('車系代號', id); return; }
      if (owner !== vehicleTypeId && types[owner]) {
        throw new Error('車系代號「' + id + '」已經用在車型 ' + owner + '，請換一個代號（例如加上車型代號）');
      }
    });
    var upserts = (rows || []).filter(function (r) { return r.VehicleID; })
      .map(function (r) {
        r.VehicleTypeID = vehicleTypeId;
        return mergeRowForBatch_(SHEETS.VEHICLES, 'VehicleID', r, existingByPk);
      });
    batchWriteRows_(SHEETS.VEHICLES, 'VehicleID', upserts, []);
    return getVehicles(vehicleTypeId);
  });
}

/**
 * 車系順序：跟目標某一列交換排序值(SortOrder)，立即生效並回傳最新順序。
 * 讓「銷貨成本」「營業費用」矩陣頁面也能直接調車系順序，不必特地切去「車系設定」頁。
 * 交換前先把目前顯示順序整批依序編號，確保每一列都有明確的 SortOrder 可以交換
 * （原本留白的舊資料靠 sortByOrder_ 排在最後、彼此順序不定，直接互換空白值沒有意義）。
 */
function reorderVehicle(vehicleTypeId, vehicleId, direction) {
  return withLock_(function () {
    var vehicles = getVehicles(vehicleTypeId);
    var idx = -1;
    vehicles.forEach(function (v, i) { if (v.VehicleID === vehicleId) idx = i; });
    if (idx === -1) throw new Error('找不到車系：' + vehicleId);
    var targetIdx = idx + (direction < 0 ? -1 : 1);
    if (targetIdx < 0 || targetIdx >= vehicles.length) return vehicles;
    vehicles.forEach(function (v, i) { v.SortOrder = i; });
    var tmp = vehicles[idx].SortOrder;
    vehicles[idx].SortOrder = vehicles[targetIdx].SortOrder;
    vehicles[targetIdx].SortOrder = tmp;
    vehicles.forEach(function (v) { upsertRow_(SHEETS.VEHICLES, 'VehicleID', v); });
    return getVehicles(vehicleTypeId);
  });
}

/**
 * 車系代號重新命名：新增一列新代號、把所有引用舊代號的資料(銷售構成、銷貨成本、營業費用、
 * 費率覆寫、損益快照)一併改成新代號，最後刪掉舊代號那一列。開發總投是情境層級，不記車系，
 * 不受影響。
 */
function renameVehicle(vehicleTypeId, oldId, newId) {
  return withLock_(function () {
    newId = String(newId || '').trim();
    if (!oldId || !newId) throw new Error('車系代號不能為空');
    if (oldId === newId) return getVehicles(vehicleTypeId);
    validateCode_('車系代號', newId);
    var existing = getVehicles();
    var row = existing.filter(function (v) { return v.VehicleID === oldId; })[0];
    if (!row) throw new Error('找不到車系：' + oldId);
    if (existing.some(function (v) { return v.VehicleID === newId; })) {
      throw new Error('車系代號「' + newId + '」已經存在');
    }

    row.VehicleID = newId;
    upsertRow_(SHEETS.VEHICLES, 'VehicleID', row);
    deleteRow_(SHEETS.VEHICLES, 'VehicleID', oldId);

    [[SHEETS.SALES_MIX, 'RowID'], [SHEETS.COST_OF_SALES, 'RowID'],
      [SHEETS.OPERATING_EXPENSE, 'RowID'], [SHEETS.PARAMETERS, 'ParamID'],
      [SHEETS.PL_RESULT, 'ResultID'], [SHEETS.LINE_NOTES, 'RowID']].forEach(function (pair) {
      var sheetName = pair[0], pk = pair[1];
      var rows = (sheetToObjects_(sheetName) || []).filter(function (r) { return r.VehicleID === oldId; });
      rows.forEach(function (r) { r.VehicleID = newId; });
      if (rows.length) batchWriteRows_(sheetName, pk, rows, []);
    });
    // 開發總投的「分攤車系」與科目的車系個別公式也記著車系代號
    var devRows = (sheetToObjects_(SHEETS.DEV_INVESTMENT) || []).filter(function (r) {
      return parseVehicleScope_(r.VehicleScope).indexOf(oldId) !== -1;
    });
    devRows.forEach(function (r) {
      r.VehicleScope = parseVehicleScope_(r.VehicleScope).map(function (id) { return id === oldId ? newId : id; }).join(',');
    });
    if (devRows.length) batchWriteRows_(SHEETS.DEV_INVESTMENT, 'RowID', devRows, []);
    var lines = (sheetToObjects_(SHEETS.PL_LINE_ITEMS) || []).filter(function (r) {
      return parseVehicleFormulas_(r.VehicleFormulas)[oldId] !== undefined;
    });
    lines.forEach(function (r) {
      var vf = parseVehicleFormulas_(r.VehicleFormulas);
      vf[newId] = vf[oldId];
      delete vf[oldId];
      r.VehicleFormulas = JSON.stringify(vf);
    });
    if (lines.length) batchWriteRows_(SHEETS.PL_LINE_ITEMS, 'LineID', lines, []);
    return getVehicles(vehicleTypeId);
  });
}

// ---- Scenarios（隸屬某個 VehicleType，同一車型可有多個情境版本並排比較） ----
function getScenarios(vehicleTypeId) {
  var rows = sheetToObjects_(SHEETS.SCENARIOS) || [];
  rows = vehicleTypeId ? rows.filter(function (r) { return r.VehicleTypeID === vehicleTypeId; }) : rows;
  // 情境順序可以在情境設定頁拖曳調整；沒排過的照建立順序
  return sortByOrder_(rows, 'SortOrder');
}
// 情境代號改用 GATE 別，情境名稱自訂；同一個 GATE 下可以有多個情境(GATE F 現況 / GATE F 目標)，
// 所以 ScenarioID 只是系統內部鍵值，由 upsertRow_ 自動產生，不需使用者自行編碼。
function validateScenarioRow_(rowObj) {
  if (!rowObj.Gate) throw new Error('請選擇 GATE 別');
  if (GATE_OPTIONS.indexOf(rowObj.Gate) === -1) throw new Error('GATE 別不正確：' + rowObj.Gate);
}
function saveScenario(rowObj) {
  return withLock_(function () {
    validateScenarioRow_(rowObj);
    // 用合併式 upsert：情境表單沒有攤提基準台數欄位，直接覆寫會把開發總投頁設定的值清掉
    return upsertRowMerge_(SHEETS.SCENARIOS, 'ScenarioID', rowObj);
  });
}
/** 刪除情境：這個情境的輸入資料、作法、說明、計算結果一起刪掉(快照保留，之後仍可拿來比較) */
function deleteScenario(scenarioId) {
  return withLock_(function () {
    deleteScenarioData_([scenarioId]);
    return deleteRow_(SHEETS.SCENARIOS, 'ScenarioID', scenarioId);
  });
}

/** 情境設定整批儲存（既有情境直接在表格上改名/改性質，按一次儲存） */
function saveScenarioGrid(vehicleTypeId, rows) {
  return withLock_(function () {
    var existingByPk = indexByPk_(sheetToObjects_(SHEETS.SCENARIOS), 'ScenarioID');
    var upserts = [];
    (rows || []).forEach(function (r) {
      if (!r.ScenarioID && !r.Gate && !r.ScenarioName) return;
      r.VehicleTypeID = vehicleTypeId;
      validateScenarioRow_(r);
      upserts.push(mergeRowForBatch_(SHEETS.SCENARIOS, 'ScenarioID', r, existingByPk));
    });
    batchWriteRows_(SHEETS.SCENARIOS, 'ScenarioID', upserts, []);
    return getScenarios(vehicleTypeId);
  });
}

/**
 * 以既有情境為基礎建立新情境。
 * 實務上新情境幾乎都是既有情境的變形（「GATE F 目標」通常就是「GATE F 現況」改幾個數字，
 * 而下一版的目標又是以上一版目標為底），從頭把銷售構成、成本、開發總投重打一次很不合理。
 * sourceScenarioId 留空就是建立一個空白情境。
 */
function createScenarioFrom(rowObj, sourceScenarioId, parts) {
  return withLock_(function () {
    var saved = saveScenario(rowObj);
    if (sourceScenarioId) {
      copyScenarioData(sourceScenarioId, saved.ScenarioID, parts);
    }
    return saved;
  });
}

// ---- SalesMix ----
function getSalesMix(scenarioId) {
  var rows = sheetToObjects_(SHEETS.SALES_MIX) || [];
  return scenarioId ? rows.filter(function (r) { return r.ScenarioID === scenarioId; }) : rows;
}
function saveSalesMixRow(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.SALES_MIX, 'RowID', rowObj); });
}
function deleteSalesMixRow(rowId) {
  return withLock_(function () { return deleteRow_(SHEETS.SALES_MIX, 'RowID', rowId); });
}

/**
 * 銷售構成表格：一定會依「車系設定」把該車型底下每個車系各列一列，
 * 已存在的 SalesMix 資料合併進去，沒有的就是空白列，使用者不需要自己一列一列新增。
 */
function getSalesMixGrid(scenarioId, vehicleTypeId) {
  var existing = getSalesMix(scenarioId);
  var rows = getVehicles(vehicleTypeId).map(function (v) {
    var row = existing.filter(function (r) { return r.VehicleID === v.VehicleID; })[0] || {};
    return {
      VehicleID: v.VehicleID,
      VehicleCode: v.VehicleCode || '',
      RowID: row.RowID || '',
      SalesMixPct: row.SalesMixPct === undefined || row.SalesMixPct === '' ? '' : toNumber_(row.SalesMixPct),
      MonthlyVolume: row.MonthlyVolume === undefined || row.MonthlyVolume === '' ? '' : toNumber_(row.MonthlyVolume),
      LifeCycleYears: row.LifeCycleYears === undefined || row.LifeCycleYears === '' ? '' : toNumber_(row.LifeCycleYears),
      ListPriceTaxIncl: row.ListPriceTaxIncl === undefined || row.ListPriceTaxIncl === '' ? '' : toNumber_(row.ListPriceTaxIncl),
      MandatoryAccessoryPrice: row.MandatoryAccessoryPrice === undefined || row.MandatoryAccessoryPrice === '' ? '' : toNumber_(row.MandatoryAccessoryPrice),
      ScrapFee: row.ScrapFee === undefined || row.ScrapFee === '' ? '' : toNumber_(row.ScrapFee),
      ScrapFeeTaxStatus: row.ScrapFeeTaxStatus || '含稅',
      HorizontalPartsPriceAdj: row.HorizontalPartsPriceAdj === undefined || row.HorizontalPartsPriceAdj === '' ? '' : toNumber_(row.HorizontalPartsPriceAdj),
      Notes: row.Notes || ''
    };
  });
  return { rows: rows, scrapFeeTaxStatusOptions: SCRAP_FEE_TAX_STATUS };
}

/** 銷售構成整批儲存（表格一次送出，不必逐列存檔） */
function saveSalesMixGrid(scenarioId, vehicleTypeId, rows) {
  return withLock_(function () {
    var upserts = (rows || []).map(function (r) { r.ScenarioID = scenarioId; return r; });
    batchWriteRows_(SHEETS.SALES_MIX, 'RowID', upserts, []);
    return getSalesMixGrid(scenarioId, vehicleTypeId);
  });
}

/**
 * 銷售構成雙向輸入(台數/百分比)：
 *   - recalcSalesMixPctByVolume：以目前各車系已填的「預估銷售台數(月)」，
 *     依佔比反推並回寫 SalesMixPct。
 *   - recalcSalesMixVolumeByPct：以使用者輸入的「情境總銷售台數(月)」為基準，
 *     依各車系已填的 SalesMixPct 反推並回寫 MonthlyVolume。
 * 同一情境下的所有 SalesMix 列即為同一車型底下的各車系構成。
 */
function recalcSalesMixPctByVolume(scenarioId) {
  return withLock_(function () {
    var rows = getSalesMix(scenarioId);
    var total = rows.reduce(function (s, r) { return s + toNumber_(r.MonthlyVolume); }, 0);
    rows.forEach(function (r) {
      // SalesMixPct 以百分比數值儲存(0~100)
      r.SalesMixPct = total > 0 ? toNumber_(r.MonthlyVolume) / total * 100 : 0;
    });
    batchWriteRows_(SHEETS.SALES_MIX, 'RowID', rows, []);
    return getSalesMix(scenarioId);
  });
}
function recalcSalesMixVolumeByPct(scenarioId, totalMonthlyVolume) {
  return withLock_(function () {
    var rows = getSalesMix(scenarioId);
    var total = toNumber_(totalMonthlyVolume);
    rows.forEach(function (r) {
      r.MonthlyVolume = Math.round(toNumber_(r.SalesMixPct) / 100 * total);
    });
    batchWriteRows_(SHEETS.SALES_MIX, 'RowID', rows, []);
    return getSalesMix(scenarioId);
  });
}

// ---- CostOfSales 銷貨成本（原材料成本頁；LP/KD 皆為成本項目，成本科目可自由增刪） ----
function getCostOfSales(scenarioId, vehicleId) {
  var rows = sheetToObjects_(SHEETS.COST_OF_SALES) || [];
  return rows.filter(function (r) {
    return (!scenarioId || r.ScenarioID === scenarioId) && (!vehicleId || r.VehicleID === vehicleId);
  });
}
function saveCostOfSalesRow(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.COST_OF_SALES, 'RowID', rowObj); });
}
function deleteCostOfSalesRow(rowId) {
  return withLock_(function () { return deleteRow_(SHEETS.COST_OF_SALES, 'RowID', rowId); });
}

/* ------------------------------------------------------------------
 * 金額矩陣（列 = 科目、欄 = 車系）：銷貨成本與營業費用共用同一套邏輯，
 * 使用者在一張表格內把所有車系的金額一次填完、一次送出。
 * ---------------------------------------------------------------- */
function buildAmountMatrix_(sheetName, scenarioId, vehicleTypeId, lineOptions) {
  // 帶出各車系的銷售構成比：金額矩陣不顯示跨車系的「合計」(把不同車系的單台成本相加沒有意義)，
  // 改成用構成比加權的平均值，跟損益儀表板的加權平均欄位是同一個口徑。
  var mix = {};
  getSalesMix(scenarioId).forEach(function (r) { mix[r.VehicleID] = toNumber_(r.SalesMixPct); });
  var vehicles = getVehicles(vehicleTypeId).map(function (v) {
    return { VehicleID: v.VehicleID, VehicleCode: v.VehicleCode || '', SalesMixPct: mix[v.VehicleID] || 0 };
  });
  var rows = (sheetToObjects_(sheetName) || []).filter(function (r) { return r.ScenarioID === scenarioId; });

  var values = {};   // values[LineCode][VehicleID] = { RowID, Amount, Currency, Notes }
  rows.forEach(function (r) {
    if (!r.LineCode) return;
    if (!values[r.LineCode]) values[r.LineCode] = {};
    values[r.LineCode][r.VehicleID] = {
      RowID: r.RowID,
      Amount: r.Amount === '' || r.Amount === undefined ? '' : toNumber_(r.Amount),
      Currency: r.Currency || BASE_CURRENCY,
      Notes: r.Notes || ''
    };
  });

  // 科目代碼 → 名稱(整份科目表)：公式說明要把 P8 這類代碼換成名稱，售價結構等不在這張表上的科目也要查得到
  var lineNames = {};
  getPLLineItems(vehicleTypeId).forEach(function (d) { lineNames[d.LineCode] = d.LineName; });
  return { lines: lineOptions, vehicles: vehicles, values: values, lineNotes: getLineNotes(scenarioId), lineNames: lineNames };
}

/**
 * 矩陣頁面一次存檔動輒十幾個科目 × 好幾個車系，逐格呼叫 upsertRow_/deleteRow_ 會讓
 * 一次存檔打出幾百次 Sheets API 呼叫(每格各自掃 PK 欄、讀寫格式、寫入、寫稽核)，
 * 是存檔感覺卡的主因。改成先分類成「這一批要新增/更新的列」跟「要刪除的 RowID」，
 * 一次交給 batchWriteRows_ 整段讀一次、整段寫一次（見該函式的說明）。
 */
function saveAmountMatrix_(sheetName, scenarioId, cells, lineNotes) {
  return withLock_(function () {
    // 科目說明(備註)統一存在 LineNotes：報告/簡報的「說明」欄跟這裡是同一份
    if (lineNotes) saveLineNotes(scenarioId, lineNotes);
    var upserts = [], deletePks = [];
    (cells || []).forEach(function (c) {
      var isEmpty = c.Amount === '' || c.Amount === null || c.Amount === undefined;
      if (isEmpty && !c.Notes) {
        // 清空的格子代表這個科目在這個車系沒有金額：有舊資料就刪掉，避免殘留
        if (c.RowID) deletePks.push(c.RowID);
        return;
      }
      c.ScenarioID = scenarioId;
      upserts.push(c);
    });
    batchWriteRows_(sheetName, 'RowID', upserts, deletePks);
    return true;
  });
}

/**
 * 銷貨成本矩陣：列 = 成本項目、欄 = 車系。
 * autoLines 是唯讀的自動計算科目(b5/b8/b13...)，讓這頁能看到 B 銷貨成本的全貌，
 * 不必再跑去儀表板才看得到模具/設備攤提與貨物稅算出多少。
 */
function getCostOfSalesMatrix(scenarioId, vehicleTypeId) {
  var matrix = buildAmountMatrix_(SHEETS.COST_OF_SALES, scenarioId, vehicleTypeId, getCostOfSalesLineOptions(vehicleTypeId));
  matrix.currencies = getConfiguredCurrencies(scenarioId);
  var auto = getCostOfSalesAutoLines(scenarioId, matrix.vehicles);
  matrix.autoLines = auto.lines;
  matrix.autoValues = auto.values;
  matrix.autoTraces = auto.traces;
  matrix.autoErrors = auto.errors;
  return matrix;
}
function saveCostOfSalesMatrix(scenarioId, cells, lineNotes) {
  return saveAmountMatrix_(SHEETS.COST_OF_SALES, scenarioId, cells, lineNotes);
}

/** 營業費用矩陣：列 = 科目、欄 = 車系。autoLines 同上，含季Margin、開發總投攤提的費用類科目 */
function getOperatingExpenseMatrix(scenarioId, vehicleTypeId) {
  var matrix = buildAmountMatrix_(SHEETS.OPERATING_EXPENSE, scenarioId, vehicleTypeId, getOperatingExpenseLineOptions(vehicleTypeId));
  var auto = getOperatingExpenseAutoLines(scenarioId, matrix.vehicles);
  matrix.autoLines = auto.lines;
  matrix.autoValues = auto.values;
  matrix.autoTraces = auto.traces;
  matrix.autoErrors = auto.errors;
  return matrix;
}
function saveOperatingExpenseMatrix(scenarioId, cells, lineNotes) {
  return saveAmountMatrix_(SHEETS.OPERATING_EXPENSE, scenarioId, cells, lineNotes);
}

// ---- DevInvestment ----

/**
 * 一列開發總投要攤提到哪個損益科目：直接看 TargetLineCode（使用者在「開發總投」頁面自選）。
 * 舊資料(改版前建立、還沒有 TargetLineCode)才會走下面的相容判斷：
 * 舊資產類型直接查對照表；更舊的「費用」單一類型則靠 Department 是否等於 'BASE廠開發費' 判斷。
 */
function devAmortTargetOf_(row) {
  if (row.TargetLineCode) return row.TargetLineCode;
  var type = row.AssetType;
  if (type === DEV_ASSET_TYPE_LEGACY_EXPENSE) {
    return row.Department === DEV_INVESTMENT_BASE_FACTORY_DEPT ? 'f4' : 'f3';
  }
  return DEV_ASSET_TYPE_TARGET[type] || '';
}

function getDevInvestment(scenarioId) {
  var rows = sheetToObjects_(SHEETS.DEV_INVESTMENT) || [];
  return scenarioId ? rows.filter(function (r) { return r.ScenarioID === scenarioId; }) : rows;
}
function saveDevInvestmentRow(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.DEV_INVESTMENT, 'RowID', rowObj); });
}
function deleteDevInvestmentRow(rowId) {
  return withLock_(function () { return deleteRow_(SHEETS.DEV_INVESTMENT, 'RowID', rowId); });
}
/**
 * 開發總投整批儲存（表格一次送出）；空白列(沒部門也沒金額)會被刪除。
 * 部門列的順序使用者可以在畫面上用上下移動鈕調整，這裡依送出時的陣列順序重新編號 SortOrder，
 * 讓 getDevInvestmentSummary 下次讀出來的順序跟畫面上調整過的一致（不是 Sheet 裡原本的列順序）。
 */
function saveDevInvestmentGrid(scenarioId, rows) {
  return withLock_(function () {
    var order = 0;
    var upserts = [], deletePks = [];
    (rows || []).forEach(function (r) {
      var isEmpty = !r.Department && (r.Amount === '' || r.Amount === null || r.Amount === undefined);
      if (isEmpty) {
        if (r.RowID) deletePks.push(r.RowID);
        return;
      }
      // 沒選攤提落點的列不會被攤提到任何科目，金額等於憑空消失，所以直接擋下來
      if (toNumber_(r.Amount) && !devAmortTargetOf_(r)) {
        throw new Error('「' + (r.Department || '未命名部門') + '」有金額但沒有選攤提落點，請選擇這筆投資要攤到哪個損益科目。');
      }
      r.ScenarioID = scenarioId;
      r.SortOrder = order++;
      upserts.push(r);
    });
    batchWriteRows_(SHEETS.DEV_INVESTMENT, 'RowID', upserts, deletePks);
    return getDevInvestmentSummary(scenarioId);
  });
}

/**
 * 目標情境用：從另一個情境把資料整批帶入後再調整低減目標。
 * 只覆蓋所選的資料類別，帶入前會先清掉目標情境同類別的既有資料。
 * 帶入的開發總投列，其挑戰低減目標一律歸零，由使用者自己填新的目標值。
 */
function copyScenarioData(sourceScenarioId, targetScenarioId, parts, opts) {
  return withLock_(function () {
    if (!sourceScenarioId || !targetScenarioId) throw new Error('請選擇來源情境與目標情境');
    if (sourceScenarioId === targetScenarioId) throw new Error('來源情境與目標情境不能相同');
    // 銷售構成/成本/費用都是以 VehicleID(車系) 為鍵，跨車型帶入會把來源車型的車系搬進來，
    // 在目標車型的頁面上完全看不到那些列，卻仍被計入損益 —— 直接擋掉。
    var allScenarios = getScenarios();
    var findScenario = function (id) {
      return allScenarios.filter(function (s) { return s.ScenarioID === id; })[0];
    };
    var source = findScenario(sourceScenarioId);
    var target = findScenario(targetScenarioId);
    if (!source) throw new Error('找不到來源情境：' + sourceScenarioId);
    if (!target) throw new Error('找不到目標情境：' + targetScenarioId);
    if (source.VehicleTypeID !== target.VehicleTypeID) {
      throw new Error('只能從同一個車型底下的情境帶入（來源為 ' + (source.VehicleTypeID || '(未設定)') +
        '，目標為 ' + (target.VehicleTypeID || '(未設定)') + '）。');
    }
    parts = parts && parts.length ? parts : ['salesmix', 'costofsales', 'devinvestment', 'operatingexpense', 'parameters', 'linenotes'];

    var map = {
      salesmix: SHEETS.SALES_MIX,
      costofsales: SHEETS.COST_OF_SALES,
      devinvestment: SHEETS.DEV_INVESTMENT,
      operatingexpense: SHEETS.OPERATING_EXPENSE,
      parameters: SHEETS.PARAMETERS,
      linenotes: SHEETS.LINE_NOTES,
      actions: SHEETS.ACTIONS
    };
    var pkOf = function (sheetName) {
      return sheetName === SHEETS.PARAMETERS ? 'ParamID' : sheetName === SHEETS.ACTIONS ? 'ActionID' : 'RowID';
    };
    var copied = {};

    parts.forEach(function (part) {
      var sheetName = map[part];
      if (!sheetName) return;
      var pk = pkOf(sheetName);
      var all = sheetToObjects_(sheetName) || [];

      var deletePks = all.filter(function (r) { return r.ScenarioID === targetScenarioId; })
        .map(function (r) { return r[pk]; });

      var sourceRows = all.filter(function (r) { return r.ScenarioID === sourceScenarioId; });
      var upserts = sourceRows.map(function (r) {
        var copy = {};
        SCHEMA[sheetName].forEach(function (h) { copy[h] = r[h]; });
        copy[pk] = '';                       // 產生新的鍵值，不要蓋到來源列
        copy.ScenarioID = targetScenarioId;
        if (sheetName === SHEETS.DEV_INVESTMENT) {
          // 低減目標屬於目標情境自己的假設，帶入後歸零讓使用者重新填
          // (目標反推另存成情境時要原封不動：opts.keepChallenge)
          if (!(opts && opts.keepChallenge)) copy.ChallengeReductionPct = '';
          // 舊資料只有 AssetType、沒有 TargetLineCode 的列，平常是靠畫面顯示時(devAmortTargetOf_)
          // 即時解析成攤提落點，使用者存檔那一刻才會真的寫回 Sheet —— 但帶入是直接複製原始列，
          // 不會經過那次存檔，複製過去的仍是「TargetLineCode 空白」的舊格式列。
          // 這裡直接把解析結果寫實，帶過去的列一律是已正規化的 TargetLineCode，
          // 不必等使用者手動按一次儲存才補上，也不會因為漏了這一步而在畫面上顯示「(請選擇)」。
          copy.TargetLineCode = devAmortTargetOf_(r);
        }
        return copy;
      });
      // 同一張表裡先刪目標情境的舊資料、再整批貼上來源情境的複本，一次(讀+寫)搞定，
      // 不是「先逐列刪、再逐列新增」— 情境資料多的話(開發總投/銷貨成本常常十幾二十列)
      // 逐列處理會是最容易卡住的一步。
      batchWriteRows_(sheetName, pk, upserts, deletePks);
      copied[part] = sourceRows.length;
    });

    return copied;
  });
}

/**
 * 開發總投的攤提基準台數（存在情境上）。
 * 實務上開發投資的攤提基準台數常與銷售構成的預估台數不同
 * （例如銷售估 365 台/月，但開發投資以 300 台/月 × 12 年攤提），所以獨立設定；
 * 留空就自動改用銷售構成推算的 LIFE CYCLE 總台數。
 */
function saveAmortBasis(scenarioId, monthlyVolume, lifeCycleYears) {
  return withLock_(function () {
    var scenario = getScenarios().filter(function (s) { return s.ScenarioID === scenarioId; })[0];
    if (!scenario) throw new Error('找不到情境：' + scenarioId);
    scenario.AmortMonthlyVolume = monthlyVolume === '' || monthlyVolume === null ? '' : toNumber_(monthlyVolume);
    scenario.AmortLifeCycleYears = lifeCycleYears === '' || lifeCycleYears === null ? '' : toNumber_(lifeCycleYears);
    upsertRow_(SHEETS.SCENARIOS, 'ScenarioID', scenario);
    return getDevInvestmentSummary(scenarioId);
  });
}

/** 部門清單允許自由新增：回傳目前已出現過的部門，前端用來做輸入建議(datalist)，非強制下拉 */
function getKnownDepartments() {
  var rows = sheetToObjects_(SHEETS.DEV_INVESTMENT) || [];
  var set = {};
  rows.forEach(function (r) { if (r.Department) set[r.Department] = true; });
  return Object.keys(set);
}

// ---- OperatingExpense ----
function getOperatingExpense(scenarioId, vehicleId) {
  var rows = sheetToObjects_(SHEETS.OPERATING_EXPENSE) || [];
  return rows.filter(function (r) {
    return (!scenarioId || r.ScenarioID === scenarioId) && (!vehicleId || r.VehicleID === vehicleId);
  });
}
function saveOperatingExpenseRow(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.OPERATING_EXPENSE, 'RowID', rowObj); });
}
function deleteOperatingExpenseRow(rowId) {
  return withLock_(function () { return deleteRow_(SHEETS.OPERATING_EXPENSE, 'RowID', rowId); });
}

// ---- Parameters ----
function getParameters(scenarioId) {
  var rows = sheetToObjects_(SHEETS.PARAMETERS) || [];
  return scenarioId ? rows.filter(function (r) { return !r.ScenarioID || r.ScenarioID === scenarioId; }) : rows;
}
function saveParameterRow(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.PARAMETERS, 'ParamID', rowObj); });
}
function deleteParameterRow(paramId) {
  return withLock_(function () { return deleteRow_(SHEETS.PARAMETERS, 'ParamID', paramId); });
}

// 「參數設定」頁面拆成兩組管理：稅務/費用比率 vs 匯率設定，各自獨立的分頁籤與表格，
// 底層仍寫入同一張 Parameters 分頁，只是依 ParamName 篩選讀取範圍。
function getTaxRateParameters(scenarioId) {
  var names = getParamDefs().map(function (d) { return d.ParamName; });
  return getParameters(scenarioId).filter(function (p) { return names.indexOf(p.ParamName) !== -1; });
}
function getFxParameters(scenarioId) {
  return getParameters(scenarioId).filter(function (p) { return FX_PARAM_NAMES.indexOf(p.ParamName) !== -1; });
}

/**
 * 稅務/費用比率表格：同一車型各車系的費率大多相同，所以預設只填「全車系適用」那一列，
 * 各車系留白就自動沿用全車系值；只有真的不同的車系才需要填覆寫值。
 * 沒設定過的比率會帶入系統預設值(DEFAULT_PARAMS)，直接按儲存即可。
 */
function getRateGrid(scenarioId, vehicleTypeId) {
  var params = getTaxRateParameters(scenarioId).filter(function (p) { return p.ScenarioID === scenarioId; });
  var vehicles = getVehicles(vehicleTypeId).map(function (v) {
    return { VehicleID: v.VehicleID, VehicleCode: v.VehicleCode || '' };
  });

  var find = function (name, vehicleId) {
    return params.filter(function (p) {
      return p.ParamName === name && (p.VehicleID || '') === (vehicleId || '');
    })[0];
  };

  // 同車型的其他情境有沒有填：參數值是每個情境各一份，只在一個情境填了，其他情境就會用預設值(沒有預設值 = 0)
  var siblings = vehicleTypeId ? getScenarios(vehicleTypeId).filter(function (sc) { return sc.ScenarioID !== scenarioId; }) : [];
  var allParams = siblings.length ? (sheetToObjects_(SHEETS.PARAMETERS) || []) : [];
  var filledIn = function (name) {
    var set = {};
    allParams.forEach(function (p) { if (p.ParamName === name && p.Value !== '' && p.Value !== null) set[p.ScenarioID] = true; });
    return set;
  };
  var rates = getParamDefs().map(function (def) {
    var name = def.ParamName;
    var global = find(name, '');
    var hasDefault = (def.DefaultValue !== '' && def.DefaultValue !== undefined) || DEFAULT_PARAMS[name] !== undefined;
    var filled = filledIn(name);
    var label = function (sc) { return (sc.Gate ? sc.Gate + ' ' : '') + (sc.ScenarioName || sc.ScenarioID); };
    var overrides = {};
    vehicles.forEach(function (v) {
      var row = find(name, v.VehicleID);
      overrides[v.VehicleID] = row ? { ParamID: row.ParamID, Value: toNumber_(row.Value) } : { ParamID: '', Value: '' };
    });
    return {
      ParamName: name,
      globalParamID: global ? global.ParamID : '',
      // 沒設定過就帶系統預設值，使用者確認後按儲存即可，不必每次自己查稅率
      globalValue: global ? toNumber_(global.Value) : (def.DefaultValue !== '' && def.DefaultValue !== undefined ? def.DefaultValue :
        (DEFAULT_PARAMS[name] !== undefined ? DEFAULT_PARAMS[name] : '')),
      isDefault: !global,
      hasDefault: hasDefault,
      // 沒有預設值的參數：哪些其他情境沒填(公式會當 0)、哪些有填
      missingIn: hasDefault ? [] : siblings.filter(function (sc) { return !filled[sc.ScenarioID]; }).map(label),
      filledIn: siblings.filter(function (sc) { return filled[sc.ScenarioID]; }).map(label),
      unit: def.Unit, description: def.Description, isPreset: def.isPreset, defaultValue: def.DefaultValue,
      overrides: overrides
    };
  });

  return { vehicles: vehicles, rates: rates, units: PARAM_UNITS };
}

/** 稅務/費用比率整批儲存：留白的車系覆寫值代表沿用全車系值，會刪掉舊的覆寫列 */
function saveRateGrid(scenarioId, rows) {
  return withLock_(function () {
    var upserts = [], deletePks = [];
    (rows || []).forEach(function (r) {
      var isEmpty = r.Value === '' || r.Value === null || r.Value === undefined;
      if (isEmpty) {
        if (r.ParamID) deletePks.push(r.ParamID);
        return;
      }
      upserts.push({
        ParamID: r.ParamID || '',
        ScenarioID: scenarioId,
        VehicleID: r.VehicleID || '',
        ParamName: r.ParamName,
        Currency: '',
        Value: r.Value,
        EffectiveDate: r.EffectiveDate || ''
      });
    });
    batchWriteRows_(SHEETS.PARAMETERS, 'ParamID', upserts, deletePks);
    return true;
  });
}

/**
 * 匯率設定表格：以幣別管理，1 外幣 = Value 台幣。
 * 只有一種匯率(現況匯率)，銷貨成本與開發總投的外幣金額都用它換算；
 * 銷貨成本頁的幣別選單就是這裡設定過匯率的幣別。
 */
function getFxGrid(scenarioId) {
  var params = getFxParameters(scenarioId).filter(function (p) { return p.ScenarioID === scenarioId; });
  var currencies = {};
  params.forEach(function (p) { if (p.Currency) currencies[p.Currency] = true; });
  DEFAULT_FX_CURRENCIES.forEach(function (c) { currencies[c] = true; });

  var rows = Object.keys(currencies).sort().map(function (currency) {
    var cells = {};
    FX_PARAM_NAMES.forEach(function (name) {
      var row = params.filter(function (p) { return p.ParamName === name && p.Currency === currency; })[0];
      cells[name] = row ? { ParamID: row.ParamID, Value: toNumber_(row.Value) } : { ParamID: '', Value: '' };
    });
    return { Currency: currency, cells: cells };
  });

  return { baseCurrency: BASE_CURRENCY, paramNames: FX_PARAM_NAMES, rows: rows };
}

/** 匯率整批儲存；留白代表未設定該幣別的匯率，會刪掉舊資料 */
function saveFxGrid(scenarioId, cells) {
  return withLock_(function () {
    var upserts = [], deletePks = [];
    (cells || []).forEach(function (c) {
      var isEmpty = c.Value === '' || c.Value === null || c.Value === undefined;
      if (isEmpty) {
        if (c.ParamID) deletePks.push(c.ParamID);
        return;
      }
      if (!c.Currency) throw new Error('請選擇幣別');
      upserts.push({
        ParamID: c.ParamID || '',
        ScenarioID: scenarioId,
        VehicleID: '',
        ParamName: c.ParamName,
        Currency: c.Currency,
        Value: c.Value,
        EffectiveDate: ''
      });
    });
    batchWriteRows_(SHEETS.PARAMETERS, 'ParamID', upserts, deletePks);
    return getFxGrid(scenarioId);
  });
}

/** 銷貨成本幣別選單：本位幣 + 匯率設定頁已經設定過匯率的幣別 */
function getConfiguredCurrencies(scenarioId) {
  var list = [BASE_CURRENCY];
  getFxParameters(scenarioId).forEach(function (p) {
    if (p.Currency && p.ParamName === COST_FX_PARAM_NAME && toNumber_(p.Value) && list.indexOf(p.Currency) === -1) {
      list.push(p.Currency);
    }
  });
  return list;
}

/** 依 ParamName(+可選VehicleID) 查值，找不到就用 DEFAULT_PARAMS，最後 fallback 0 */
function lookupParam_(paramsForScenario, paramName, vehicleId) {
  var match = paramsForScenario.filter(function (p) {
    return p.ParamName === paramName && (!p.VehicleID || p.VehicleID === vehicleId);
  });
  // 有指定車型的參數優先於全域參數
  var specific = match.filter(function (p) { return p.VehicleID === vehicleId; });
  var picked = specific.length ? specific[0] : match[0];
  if (picked) return toNumber_(picked.Value);
  return DEFAULT_PARAMS[paramName] !== undefined ? DEFAULT_PARAMS[paramName] : 0;
}


// ---- 從 Excel 貼上整張表(銷貨成本/營業費用) ----

/** 科目名稱比對用：去空白、全形半形括號一致、英文不分大小寫(「材料成本 - KD」=「材料成本-KD」) */
function normalizeLineNameKey_(s) {
  return String(s || '').replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[－—–]/g, '-')
    .replace(/\s+/g, '').toLowerCase();
}

/**
 * 把從 Excel 複製的整張表匯入銷貨成本(kind='cost')或營業費用(kind='opex')。
 * rows = [{ name: 科目名稱, values: { 車系ID: 金額 } }]，前端已經把欄位對到車系。
 * 依科目名稱比對這個車型的科目表：
 *   - 對到手動輸入科目 → 寫入/覆蓋金額(沒貼到的車系不動)
 *   - 對到公式或開發總投攤提科目 → 略過(那些金額是算出來的，不能輸入)
 *   - 對不到 → createMissing 時新增成手動輸入科目(掛在 parentForNew 底下)，否則列在 unmatched
 * 整批一次寫入，回傳摘要給前端顯示。
 */
function importMatrixRows(scenarioId, vehicleTypeId, kind, rows, createMissing, parentForNew) {
  return withLock_(function () {
    if (!scenarioId || !vehicleTypeId) throw new Error('請先選擇車型與情境');
    var isCost = kind === 'cost';
    ensureTypeChart_(vehicleTypeId);
    var parent = parentForNew || (isCost ? 'B' : 'E');
    var report = { updated: 0, created: [], skipped: [], unmatched: [], matched: [] };
    var vehicleIds = {};
    getVehicles(vehicleTypeId).forEach(function (v) { vehicleIds[v.VehicleID] = true; });

    var findLine = function () {
      var byKey = {};
      getPLLineItems(vehicleTypeId).forEach(function (d) {
        var k = normalizeLineNameKey_(d.LineName);
        if (!byKey[k]) byKey[k] = d;
      });
      return byKey;
    };
    var byKey = findLine();
    var defs = getPLLineItems(vehicleTypeId);
    var targets = [];
    (rows || []).forEach(function (r) {
      var name = String(r.name || '').trim();
      if (!name) return;
      var d = byKey[normalizeLineNameKey_(name)];
      if (d && (d.CalcType !== CALC_TYPES.INPUT || isCostSectionLine_(d, defs) !== isCost)) {
        report.skipped.push({ name: name, reason: d.CalcType !== CALC_TYPES.INPUT ? '是' + CALC_TYPE_LABELS[d.CalcType] + '科目' : '屬於' + (isCost ? '營業費用' : '銷貨成本') + '頁' });
        return;
      }
      if (!d) {
        if (!createMissing) { report.unmatched.push(name); return; }
        var row = newLineItemRow_(parent, name, vehicleTypeId);
        upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineID', row);
        byKey = findLine();
        defs = getPLLineItems(vehicleTypeId);
        d = byKey[normalizeLineNameKey_(name)];
        report.created.push(name);
      } else {
        report.matched.push(name);
      }
      targets.push({ code: d.LineCode, values: r.values || {} });
    });

    var sheetName = isCost ? SHEETS.COST_OF_SALES : SHEETS.OPERATING_EXPENSE;
    var existing = {};
    (sheetToObjects_(sheetName) || []).forEach(function (r) {
      if (r.ScenarioID === scenarioId) existing[r.LineCode + '|' + r.VehicleID] = r;
    });
    var upserts = [];
    targets.forEach(function (t) {
      Object.keys(t.values).forEach(function (vid) {
        if (!vehicleIds[vid]) return;
        var v = t.values[vid];
        if (v === '' || v === null || v === undefined || isNaN(Number(v))) return;
        var cur = existing[t.code + '|' + vid];
        var row = {};
        SCHEMA[sheetName].forEach(function (h) { row[h] = cur && cur[h] !== undefined ? cur[h] : ''; });
        row.RowID = cur ? cur.RowID : '';
        row.ScenarioID = scenarioId; row.VehicleID = vid; row.LineCode = t.code; row.Amount = Number(v);
        if (isCost && !row.Currency) row.Currency = BASE_CURRENCY;
        upserts.push(row);
        report.updated++;
      });
    });
    if (upserts.length) batchWriteRows_(sheetName, 'RowID', upserts, []);
    return report;
  });
}
