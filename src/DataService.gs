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
  withLock_(function () { return syncCodeOwnedLineItems_(); });

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

// ---- VehicleTypes（車型主檔，如 DA/DE/DH/DX，需先建立才能在底下新增車系） ----
function getVehicleTypes() {
  return sheetToObjects_(SHEETS.VEHICLE_TYPES) || [];
}
function saveVehicleType(rowObj) {
  return withLock_(function () { return upsertRowMerge_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', rowObj); });
}
function deleteVehicleType(vehicleTypeId) {
  return withLock_(function () { return deleteRow_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', vehicleTypeId); });
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
    var existing = getVehicleTypes();
    var row = existing.filter(function (t) { return t.VehicleTypeID === oldId; })[0];
    if (!row) throw new Error('找不到車型：' + oldId);
    if (existing.some(function (t) { return t.VehicleTypeID === newId; })) {
      throw new Error('車型代號「' + newId + '」已經存在');
    }

    row.VehicleTypeID = newId;
    upsertRow_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', row);
    deleteRow_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', oldId);

    [[SHEETS.VEHICLES, 'VehicleID'], [SHEETS.SCENARIOS, 'ScenarioID']].forEach(function (pair) {
      var sheetName = pair[0], pk = pair[1];
      (sheetToObjects_(sheetName) || []).forEach(function (r) {
        if (r.VehicleTypeID !== oldId) return;
        r.VehicleTypeID = newId;
        upsertRow_(sheetName, pk, r);
      });
    });
    return getVehicleTypes();
  });
}

// ---- Vehicles（車系，如 3人貨車/9人客貨車，隸屬某個 VehicleType） ----
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
function deleteVehicle(vehicleId) {
  return withLock_(function () { return deleteRow_(SHEETS.VEHICLES, 'VehicleID', vehicleId); });
}
/** 車系設定整批儲存 */
function saveVehicleGrid(vehicleTypeId, rows) {
  return withLock_(function () {
    var existingByPk = indexByPk_(sheetToObjects_(SHEETS.VEHICLES), 'VehicleID');
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
      [SHEETS.PL_RESULT, 'ResultID']].forEach(function (pair) {
      var sheetName = pair[0], pk = pair[1];
      (sheetToObjects_(sheetName) || []).forEach(function (r) {
        if (r.VehicleID !== oldId) return;
        r.VehicleID = newId;
        upsertRow_(sheetName, pk, r);
      });
    });
    return getVehicles(vehicleTypeId);
  });
}

// ---- Scenarios（隸屬某個 VehicleType，同一車型可有多個情境版本並排比較） ----
function getScenarios(vehicleTypeId) {
  var rows = sheetToObjects_(SHEETS.SCENARIOS) || [];
  return vehicleTypeId ? rows.filter(function (r) { return r.VehicleTypeID === vehicleTypeId; }) : rows;
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
function deleteScenario(scenarioId) {
  return withLock_(function () { return deleteRow_(SHEETS.SCENARIOS, 'ScenarioID', scenarioId); });
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

  return { lines: lineOptions, vehicles: vehicles, values: values };
}

/**
 * 矩陣頁面一次存檔動輒十幾個科目 × 好幾個車系，逐格呼叫 upsertRow_/deleteRow_ 會讓
 * 一次存檔打出幾百次 Sheets API 呼叫(每格各自掃 PK 欄、讀寫格式、寫入、寫稽核)，
 * 是存檔感覺卡的主因。改成先分類成「這一批要新增/更新的列」跟「要刪除的 RowID」，
 * 一次交給 batchWriteRows_ 整段讀一次、整段寫一次（見該函式的說明）。
 */
function saveAmountMatrix_(sheetName, scenarioId, cells) {
  return withLock_(function () {
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
  var matrix = buildAmountMatrix_(SHEETS.COST_OF_SALES, scenarioId, vehicleTypeId, getCostOfSalesLineOptions());
  matrix.currencies = getConfiguredCurrencies(scenarioId);
  var auto = getCostOfSalesAutoLines(scenarioId, matrix.vehicles);
  matrix.autoLines = auto.lines;
  matrix.autoValues = auto.values;
  matrix.commodityTaxDetail = auto.commodityTaxDetail || {};
  return matrix;
}
function saveCostOfSalesMatrix(scenarioId, cells) {
  return saveAmountMatrix_(SHEETS.COST_OF_SALES, scenarioId, cells);
}

/** 營業費用矩陣：列 = 科目、欄 = 車系。autoLines 同上，含季Margin、開發總投攤提的費用類科目 */
function getOperatingExpenseMatrix(scenarioId, vehicleTypeId) {
  var matrix = buildAmountMatrix_(SHEETS.OPERATING_EXPENSE, scenarioId, vehicleTypeId, getOperatingExpenseLineOptions());
  var auto = getOperatingExpenseAutoLines(scenarioId, matrix.vehicles);
  matrix.autoLines = auto.lines;
  matrix.autoValues = auto.values;
  return matrix;
}
function saveOperatingExpenseMatrix(scenarioId, cells) {
  return saveAmountMatrix_(SHEETS.OPERATING_EXPENSE, scenarioId, cells);
}

/**
 * 在銷貨成本／營業費用頁面直接新增科目（不必跑去「科目設定」頁）。
 * parentLine 決定這個科目屬於哪一段損益：B = 銷貨成本、E/G/I = 各段費用。
 * LineCode 自動產生（父科目字首 + 流水號），使用者只需要填科目名稱。
 */
function addLineItemInline(parentLine, lineName) {
  return withLock_(function () {
    if (!lineName) throw new Error('請輸入科目名稱');
    return upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', newLineItemRow_(parentLine, lineName));
  });
}

/**
 * 產生一筆新科目（代碼與排序值都由系統決定，使用者只選父科目、填名稱）。
 * 呼叫端必須已經在 withLock_ 內，否則兩個同時新增的科目有機會拿到同一個代碼。
 */
function newLineItemRow_(parentLine, lineName) {
  return {
    LineCode: nextLineCode_(parentLine),
    LineName: lineName,
    ParentLine: parentLine,
    Category: parentLine === 'B' ? '成本明細' : '費用明細',
    SortOrder: nextSortOrder_(parentLine),
    AutoSource: ''
  };
}

/** 下一個可用的科目代碼：父科目字首 + 最小未使用號碼(b1、b2、d1...) */
function nextLineCode_(parentLine) {
  var prefix = LINE_CODE_PREFIX[parentLine];
  if (!prefix) throw new Error('父科目不正確：' + (parentLine || '(未選擇)'));
  var used = {};
  getPLLineItems().forEach(function (d) { used[d.LineCode] = true; });
  var n = 1;
  while (used[prefix + n]) n++;
  return prefix + n;
}

/** 新科目排在同一段的最後面(+0.5)，之後可在科目設定頁直接改排序值微調 */
function nextSortOrder_(parentLine) {
  var maxSort = 0;
  getPLLineItems().forEach(function (d) {
    if (d.ParentLine === parentLine) maxSort = Math.max(maxSort, toNumber_(d.SortOrder));
  });
  return (maxSort || 20) + 0.5;
}

/**
 * 刪除科目，並清掉該科目在「所有情境」已輸入的金額。
 * 科目表是全域的，只清當前情境會讓其他情境留下孤兒金額，
 * 那些金額不會顯示在任何頁面上，卻仍被計入銷貨成本，最難察覺。
 */
function deleteLineItemInline(lineCode) {
  return withLock_(function () {
    [SHEETS.COST_OF_SALES, SHEETS.OPERATING_EXPENSE].forEach(function (sheetName) {
      (sheetToObjects_(sheetName) || []).forEach(function (r) {
        if (r.LineCode === lineCode) deleteRow_(sheetName, 'RowID', r.RowID);
      });
    });
    return deletePLLineItem(lineCode);
  });
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

/**
 * 開發總投「攤提落點」下拉選項：所有 AutoSource 屬於 DEV_AMORT_AUTO_SOURCES 的科目，
 * 含內建 4 個(b5/b8/f3/f4)與使用者自己新增的攤提落點科目。只給名稱、不帶科目代碼
 * （代碼對使用者選擇攤提落點沒有幫助，畫面只需要看得懂科目名稱）。
 * 每個選項都帶 category(設備/模具/費用)，前端先選大類、再從選中的大類裡選實際落點，
 * 避免自己新增的攤提落點越加越多之後，整個下拉選單混在一起不好找。
 */
function getDevAmortTargetOptions() {
  return getPLLineItems()
    .filter(function (d) { return DEV_AMORT_AUTO_SOURCES.indexOf(d.AutoSource) !== -1; })
    .map(function (d) {
      return { value: d.LineCode, label: d.LineName, parentLine: d.ParentLine, category: d.DevAmortCategory || '' };
    });
}

/**
 * 在「開發總投」頁面直接新增一個攤提落點科目（不必跑去「科目設定」頁），流程是先選部門、
 * 再選這筆投資屬於「設備/模具/費用」哪一大類、再選（或新增）實際攤提落點。
 * 大類直接決定父科目(設備/模具 -> B 銷貨成本，費用 -> G 產品貢獻前費用，跟內建的 b5/b8/f3/f4 一致)，
 * 新科目一律標記 AutoSource=DEV_AMORT，之後不會出現在「銷貨成本」「營業費用」的手動輸入選單裡，
 * 避免跟開發總投攤提的金額重複計列。
 */
function addDevAmortLineItem(category, lineName) {
  return withLock_(function () {
    if (!lineName) throw new Error('請輸入科目名稱');
    var parentLine = DEV_AMORT_CATEGORY_PARENT[category];
    if (!parentLine) throw new Error('大類不正確：' + (category || '(未選擇)'));
    var row = newLineItemRow_(parentLine, lineName);
    row.AutoSource = AUTO_SOURCE.DEV_AMORT;
    row.DevAmortCategory = category;
    return upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', row);
  });
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
function copyScenarioData(sourceScenarioId, targetScenarioId, parts) {
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
    parts = parts && parts.length ? parts : ['salesmix', 'costofsales', 'devinvestment', 'operatingexpense', 'parameters'];

    var map = {
      salesmix: SHEETS.SALES_MIX,
      costofsales: SHEETS.COST_OF_SALES,
      devinvestment: SHEETS.DEV_INVESTMENT,
      operatingexpense: SHEETS.OPERATING_EXPENSE,
      parameters: SHEETS.PARAMETERS
    };
    var pkOf = function (sheetName) { return sheetName === SHEETS.PARAMETERS ? 'ParamID' : 'RowID'; };
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
          copy.ChallengeReductionPct = '';
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
  return getParameters(scenarioId).filter(function (p) { return TAX_RATE_PARAM_NAMES.indexOf(p.ParamName) !== -1; });
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

  var rates = TAX_RATE_PARAM_NAMES.map(function (name) {
    var global = find(name, '');
    var overrides = {};
    vehicles.forEach(function (v) {
      var row = find(name, v.VehicleID);
      overrides[v.VehicleID] = row ? { ParamID: row.ParamID, Value: toNumber_(row.Value) } : { ParamID: '', Value: '' };
    });
    return {
      ParamName: name,
      globalParamID: global ? global.ParamID : '',
      // 沒設定過就帶系統預設值，使用者確認後按儲存即可，不必每次自己查稅率
      globalValue: global ? toNumber_(global.Value) : (DEFAULT_PARAMS[name] !== undefined ? DEFAULT_PARAMS[name] : ''),
      isDefault: !global,
      overrides: overrides
    };
  });

  return { vehicles: vehicles, rates: rates };
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

// ---- PLLineItems 科目設定（明細科目可自由新增/刪除） ----

/**
 * 把「由程式定義」的科目名稱與位置對回程式碼。
 *
 * 有兩類科目的名稱不屬於使用者：
 *   - 自動計算科目(AutoSource 有值)：金額是公式算出來的，名稱寫的就是那條公式
 *   - 結構科目(A/B/C/E/G/I/K)：名稱寫的是它跟哪些明細的加總關係
 * 這兩類一旦跟程式對不起來，畫面上就會出現「欄位寫廢車處理費、數字卻是強配件售價」——
 * 舊版的售價結構只有 8 列(P2 是廢車處理費)，改版重新編號成 9 列之後，
 * seedPLLineItems_() 又刻意不覆蓋既有科目(使用者可能自己改過名稱)，
 * 於是新代碼配著舊名稱一直留在 Sheet 上。名稱是描述公式的，就該由公式那一邊決定。
 *
 * 明細科目(b1/d1/f1/h1...)的名稱與排序仍然屬於使用者，這裡完全不動 ——
 * 要整個回復成內建預設值請用 restoreBuiltInLineItems()。
 */
function syncCodeOwnedLineItems_() {
  var existing = {};
  getPLLineItems().forEach(function (d) { existing[d.LineCode] = d; });

  var fixed = [];
  PL_LINE_ITEMS.forEach(function (line) {
    var isCodeOwned = line.AutoSource || PROTECTED_LINE_CODES.indexOf(line.LineCode) !== -1;
    if (!isCodeOwned) return;
    var current = existing[line.LineCode];
    if (!current) return;                       // 還沒建立的科目交給 seedPLLineItems_() 補
    var same = function (field) {
      var a = current[field] === undefined || current[field] === null ? '' : current[field];
      var b = line[field] === undefined || line[field] === null ? '' : line[field];
      return String(a) === String(b);
    };
    if (['LineName', 'ParentLine', 'Category', 'SortOrder', 'DevAmortCategory'].every(same)) return;

    var row = {};
    SCHEMA.PLLineItems.forEach(function (h) {
      row[h] = line[h] !== undefined ? line[h] : (current[h] !== undefined ? current[h] : '');
    });
    upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', row);
    fixed.push(line.LineCode);
  });
  return fixed;
}

/**
 * 把所有內建科目(含明細科目)的名稱、父科目、分類、排序值整個回復成程式碼中的預設值。
 * 使用者自己新增的科目不受影響。排序值會一併回到實際損益試算表的列序。
 */
function restoreBuiltInLineItems() {
  return withLock_(function () {
    var upserts = PL_LINE_ITEMS.map(function (line) {
      var row = {};
      SCHEMA.PLLineItems.forEach(function (h) { row[h] = line[h] !== undefined ? line[h] : ''; });
      return row;
    });
    batchWriteRows_(SHEETS.PL_LINE_ITEMS, 'LineCode', upserts, []);
    return getPLLineItems();
  });
}

function getPLLineItems() {
  return (sheetToObjects_(SHEETS.PL_LINE_ITEMS) || []).sort(function (a, b) { return a.SortOrder - b.SortOrder; });
}
function savePLLineItem(rowObj) {
  return withLock_(function () { return savePLLineItem_(rowObj); });
}

/**
 * 儲存一筆科目。沒有帶 LineCode 就視為新增，代碼與排序值由系統產生
 * （使用者只選父科目、填名稱，不必自己編碼，也不會跟既有科目撞號）。
 * 呼叫端必須已經在 withLock_ 內。
 */
function savePLLineItem_(rowObj) {
  if (!rowObj.LineName) throw new Error('科目名稱為必填');

  if (!rowObj.LineCode) {
    var created = newLineItemRow_(rowObj.ParentLine, rowObj.LineName);
    // 使用者若在新增列自己填了分類/排序值就尊重他的值，其餘沿用系統產生的預設
    if (rowObj.Category) created.Category = rowObj.Category;
    if (rowObj.SortOrder !== '' && rowObj.SortOrder !== undefined && rowObj.SortOrder !== null) {
      created.SortOrder = toNumber_(rowObj.SortOrder);
    }
    return upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', created);
  }

  var existing = getPLLineItems().filter(function (d) { return d.LineCode === rowObj.LineCode; })[0];
  // 自動計算科目由 CalcEngine 產生，使用者新增的科目一律是手動輸入科目；
  // CommodityTaxDeduct(貨物稅完稅價格可扣除)等表單沒有的欄位由合併式 upsert 保留原值
  rowObj.AutoSource = existing ? (existing.AutoSource || '') : '';
  // 結構科目(A/B/C/E/G/I/K)與自動計算科目改掉父科目會讓損益鏈接錯段，一律沿用原值
  if (existing && (PROTECTED_LINE_CODES.indexOf(rowObj.LineCode) !== -1 || existing.AutoSource)) {
    rowObj.ParentLine = existing.ParentLine || '';
  }
  return upsertRowMerge_(SHEETS.PL_LINE_ITEMS, 'LineCode', rowObj);
}

/**
 * 科目設定整批儲存：整張表直接編輯、按一次儲存。
 * 沒有 LineCode 的列就是新增列，代碼由系統自動產生。
 *
 * 新增列跟既有列分兩段處理，不是圖方便，是新增列的代碼分配(nextLineCode_)必須看到
 * 「這一批已經配過的代碼」才不會撞號：同一批新增兩個科目，兩個都呼叫一次
 * nextLineCode_() 的話，沒看到前一個剛配好的代碼就會拿到同一組代碼。
 * 逐列呼叫 savePLLineItem_()／upsertRow_() 會在寫入後清快取，下一列重新讀最新代碼
 * 清單，天然沒有這個問題；新增列一次通常只有幾筆，逐列處理的成本可以忽略。
 * 既有列的代碼已經固定、不會撞號，這段才整批一次寫回。
 */
function savePLLineItemGrid(rows) {
  return withLock_(function () {
    var newRows = [], existingRows = [];
    (rows || []).forEach(function (r) {
      // 完全空白的新增列直接跳過，使用者按了「新增一列」又沒填東西不該報錯
      if (!r.LineCode && !r.LineName) return;
      (r.LineCode ? existingRows : newRows).push(r);
    });

    newRows.forEach(function (r) { savePLLineItem_(r); });

    if (existingRows.length) {
      var byCode = indexByPk_(getPLLineItems(), 'LineCode');
      var upserts = existingRows.map(function (r) {
        if (!r.LineName) throw new Error('科目名稱為必填');
        var existing = byCode[r.LineCode];
        // 自動計算科目由 CalcEngine 產生，使用者新增的科目一律是手動輸入科目；
        // CommodityTaxDeduct(貨物稅完稅價格可扣除)等表單沒有的欄位由合併補齊、保留原值
        r.AutoSource = existing ? (existing.AutoSource || '') : '';
        // 結構科目(A/B/C/E/G/I/K)與自動計算科目改掉父科目會讓損益鏈接錯段，一律沿用原值
        if (existing && (PROTECTED_LINE_CODES.indexOf(r.LineCode) !== -1 || existing.AutoSource)) {
          r.ParentLine = existing.ParentLine || '';
        }
        return mergeRowForBatch_(SHEETS.PL_LINE_ITEMS, 'LineCode', r, byCode);
      });
      batchWriteRows_(SHEETS.PL_LINE_ITEMS, 'LineCode', upserts, []);
    }
    return getPLLineItems();
  });
}
function deletePLLineItem(lineCode) {
  return withLock_(function () {
    if (PROTECTED_LINE_CODES.indexOf(lineCode) !== -1) {
      throw new Error('「' + lineCode + '」是損益結構科目(小計/毛利/淨利)，刪除會讓損益鏈斷掉，不可刪除。');
    }
    var def = getPLLineItems().filter(function (d) { return d.LineCode === lineCode; })[0];
    if (def && def.AutoSource && def.AutoSource !== AUTO_SOURCE.DEV_AMORT) {
      throw new Error('「' + lineCode + ' ' + def.LineName + '」是自動計算科目，由比率設定或開發總投攤提產生，不可刪除。');
    }
    // DEV_AMORT 是使用者自己在「開發總投」頁面新增的攤提落點(非內建的模具/設備/CMC/BASE廠開發費四個)，
    // 使用者建的東西應該讓使用者刪得掉 —— 只要目前沒有任何情境的開發總投列還指到這裡就放行，
    // 否則那些列的金額會攤不到任何科目、憑空消失，所以先擋下來請使用者自己改選或刪除那些列。
    if (def && def.AutoSource === AUTO_SOURCE.DEV_AMORT) {
      var used = (sheetToObjects_(SHEETS.DEV_INVESTMENT) || []).filter(function (r) {
        return devAmortTargetOf_(r) === lineCode;
      });
      if (used.length) {
        throw new Error('「' + lineCode + ' ' + def.LineName + '」在「開發總投」還有 ' + used.length +
          ' 筆資料指到這個攤提落點，請先把那些列改選別的攤提落點或刪除，才能刪除這個科目。');
      }
    }
    return deleteRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', lineCode);
  });
}

/**
 * 科目下拉選單選項：只回傳「可手動輸入」的明細科目(排除自動計算科目)，
 * 回傳 [{value, label}]，前端 renderForm 直接吃這個格式。
 */
function lineOptionsFor_(parentCodes, extraCodes) {
  var opts = getPLLineItems()
    .filter(function (d) {
      return !d.AutoSource &&
        (parentCodes.indexOf(d.ParentLine) !== -1 || (extraCodes || []).indexOf(d.LineCode) !== -1);
    })
    .map(function (d) { return { value: d.LineCode, label: d.LineCode + ' ' + d.LineName }; });
  return opts;
}
/** 銷貨成本頁的成本項目選單（B 底下、可手動輸入的科目） */
function getCostOfSalesLineOptions() {
  return lineOptionsFor_(['B']);
}
/** 營業費用頁的科目選單（E/G/I 底下可手動輸入的科目，外加 J 前瞻費用） */
function getOperatingExpenseLineOptions() {
  return lineOptionsFor_(['E', 'G', 'I'], ['J']);
}

