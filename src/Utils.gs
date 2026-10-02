/** 共用工具函式 */

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('找不到分頁：' + name + '，請先執行 setupSpreadsheet()');
  return sheet;
}

// 同一次執行內的流水號：整批寫入(如一次存下整張表格)會連續產生很多 ID，
// 只取 UUID 前 8 碼有機會撞號，撞號的後果是後一列直接覆蓋前一列、而且不會報錯。
var ID_SEQ_ = 0;

function generateId_(prefix) {
  return prefix + '-' + Utilities.getUuid().slice(0, 8) + '-' + (++ID_SEQ_);
}

/**
 * google.script.run 序列化巢狀 Date 物件時不穩定（陣列包物件、物件裡又包 Date，
 * 有機會整包回傳值直接變成 null，且不會丟出任何錯誤）。
 * Sheet 的日期欄位讀出來就是 JS Date，所以一律在這裡轉成 yyyy-MM-dd 字串再往外傳。
 */
function normalizeCellValue_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Taipei', 'yyyy-MM-dd');
  }
  return v;
}

/**
 * 分頁讀取快取，分兩層：
 *   1. 單次執行內的記憶體快取(SHEET_CACHE_) —— 一次損益計算會重複讀同一張表很多次
 *      （光是科目表 PLLineItems，每算一個車系就會被讀 5 次以上），這層省掉同一次執行內的重複讀取。
 *   2. 跨執行的 CacheService 快取 —— 每一次 google.script.run 呼叫都是全新的執行，
 *      第 1 層每次都會是空的，切分頁、開儀表板等於每次都重新把用到的表整個讀一遍，
 *      這是介面感覺卡頓的主因之一。這層把讀到的結果多存一份到 CacheService，
 *      有效期內(SHEET_CACHE_TTL_)其他次執行可以直接用，不必再打一次 Sheets API。
 * 任何寫入都會兩層一起清掉，所以不會讀到過期資料；資料太大存不進 CacheService(單筆上限 100KB)
 * 就直接跳過快取，退回每次都讀 Sheet，不影響正確性，只是那張表沒有快取效果。
 * 注意：繞過 upsertRow_/deleteRow_ 直接寫 Sheet 的地方(SetupSheets、writePLResult_)
 * 必須自己呼叫 invalidateSheetCache_()。
 */
var SHEET_CACHE_ = {};
var SHEET_CACHE_TTL_SECONDS_ = 300; // 5 分鐘；資料一有異動就會主動清掉，這個 TTL 只是保險

function sheetCacheKey_(sheetName) { return 'sheet_' + sheetName; }

function invalidateSheetCache_(sheetName) {
  var names = sheetName ? [sheetName] : Object.keys(SCHEMA);
  var cache = CacheService.getScriptCache();
  names.forEach(function (name) {
    delete SHEET_CACHE_[name];
    cache.remove(sheetCacheKey_(name));
  });
  if (!sheetName) SHEET_CACHE_ = {};
  resetCalcMemo_();
}

/**
 * 清掉「單次執行內」的計算結果記憶(見 CalcEngine.gs 的 PL_CORE_MEMO_)。
 * 任何一張表有寫入就整個清掉：損益計算跨好幾張表，逐表判斷影響範圍不值得，重算就對了。
 * 本機預覽伺服器(tools/dev-server.js)在每次模擬的 google.script.run 呼叫前也會呼叫，
 * 模擬 Apps Script 每次呼叫都是全新執行的行為。
 */
function resetCalcMemo_() {
  if (typeof PL_CORE_MEMO_ !== 'undefined') PL_CORE_MEMO_ = {};
}

/** 把整張表讀成 [{欄位:值,...}, ...]，第一列為標題 */
function sheetToObjects_(sheetName) {
  if (SHEET_CACHE_[sheetName]) return SHEET_CACHE_[sheetName];

  var cache = CacheService.getScriptCache();
  var cached = cache.get(sheetCacheKey_(sheetName));
  if (cached) {
    var fromCache = JSON.parse(cached);
    SHEET_CACHE_[sheetName] = fromCache;
    return fromCache;
  }

  var rows = readSheetObjects_(sheetName);
  SHEET_CACHE_[sheetName] = rows;
  try {
    var json = JSON.stringify(rows);
    // CacheService 單筆快取上限 100KB，留點餘裕；超過就不快取這張表，讀 Sheet 的正確性不受影響
    if (json.length < 90000) cache.put(sheetCacheKey_(sheetName), json, SHEET_CACHE_TTL_SECONDS_);
  } catch (e) {
    // 序列化失敗(理論上不會，資料都是純值)也不影響功能，只是這次沒快取到
  }
  return rows;
}

function readSheetObjects_(sheetName) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return [];
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values
    .filter(function (row) { return row.some(function (v) { return v !== '' && v !== null; }); })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = normalizeCellValue_(row[i]); });
      return obj;
    });
}

/**
 * 主鍵比對：Sheet 讀回來的值可能是 Number(例如純數字的代號)，
 * 而前端傳來的一律是 String，直接用 === 會永遠不相等 → 變成重複新增、刪不掉。
 */
function samePk_(a, b) {
  if (a === null || a === undefined || a === '') return false;
  return String(a) === String(b);
}

/** 把一組列依 PK 轉成「PK字串 -> 列物件」的對照表，整批寫入前先查表用 */
function indexByPk_(rows, pkField) {
  var map = {};
  (rows || []).forEach(function (r) {
    if (r[pkField] !== undefined && r[pkField] !== null && r[pkField] !== '') map[String(r[pkField])] = r;
  });
  return map;
}

/**
 * upsertRowMerge_ 的整批版：用預先讀好的 existingByPk(見 indexByPk_) 補齊 rowObj 沒送出的欄位，
 * 不必為了合併就每一列各自重新讀一次整張表。呼叫端把回傳值收集起來一次交給 batchWriteRows_。
 */
function mergeRowForBatch_(sheetName, pkField, rowObj, existingByPk) {
  var existing = rowObj[pkField] ? existingByPk[String(rowObj[pkField])] : undefined;
  if (existing) {
    SCHEMA[sheetName].forEach(function (h) {
      if (rowObj[h] === undefined) rowObj[h] = existing[h];
    });
  }
  return rowObj;
}

/**
 * 只更新有帶到的欄位，其餘沿用既有值。
 * 表單只送出畫面上有的欄位，若直接 upsert，沒出現在表單上的欄位(如情境的攤提基準台數、
 * 科目的自動計算標記)會被寫成空字串，等於靜靜地把設定清掉。
 */
function upsertRowMerge_(sheetName, pkField, rowObj) {
  var existing = sheetToObjects_(sheetName).filter(function (r) {
    return samePk_(r[pkField], rowObj[pkField]);
  })[0];
  if (existing) {
    SCHEMA[sheetName].forEach(function (h) {
      if (rowObj[h] === undefined) rowObj[h] = existing[h];
    });
  }
  return upsertRow_(sheetName, pkField, rowObj);
}

/** 依 PK 欄位(通常是第一欄) upsert 一列；找不到就新增 */
function upsertRow_(sheetName, pkField, rowObj) {
  var sheet = getSheet_(sheetName);
  var headers = SCHEMA[sheetName];
  var pkCol = headers.indexOf(pkField) + 1;

  if (!rowObj[pkField]) {
    rowObj[pkField] = generateId_(rowIdPrefix_(sheetName));
  }

  var lastRow = sheet.getLastRow();
  var targetRow = -1;
  if (lastRow >= 2) {
    var pkValues = sheet.getRange(2, pkCol, lastRow - 1, 1).getValues();
    for (var i = 0; i < pkValues.length; i++) {
      if (samePk_(pkValues[i][0], rowObj[pkField])) {
        targetRow = i + 2;
        break;
      }
    }
  }

  var rowArray = headers.map(function (h) { return rowObj[h] !== undefined ? rowObj[h] : ''; });
  var writeRow = targetRow === -1 ? lastRow + 1 : targetRow;
  var range = sheet.getRange(writeRow, 1, 1, rowArray.length);
  applyTextColumnFormats_(range, headers, sheetName);
  range.setValues([rowArray]);
  invalidateSheetCache_(sheetName);
  logAudit_(sheetName, rowObj[pkField], targetRow === -1 ? 'INSERT' : 'UPDATE', rowObj);
  return rowObj;
}

/**
 * 在寫入前把純文字欄位(TEXT_COLUMNS)的儲存格格式設成純文字('@')，
 * 避免 Sheet 把「0901」這種看起來像數字的字串自動轉成 901。
 * 用 getNumberFormats() 先讀出目前格式，只覆蓋純文字欄位那幾格，其餘欄位(金額/比率)維持原狀，
 * 且只在格式真的需要改變時才寫入，避免每次存檔都多一次 API 呼叫。
 * range 可以是一列(單筆 upsertRow_)也可以是很多列(batchWriteRows_ 整批寫入)：
 * getNumberFormats()/setNumberFormats() 本來就是回傳/接受二維陣列，不特別假設列數。
 */
function applyTextColumnFormats_(range, headers, sheetName) {
  var textCols = TEXT_COLUMNS[sheetName];
  if (!textCols || !textCols.length) return;
  var current = range.getNumberFormats();
  var changed = false;
  var next = current.map(function (rowFormats) {
    return headers.map(function (h, i) {
      if (textCols.indexOf(h) !== -1 && rowFormats[i] !== '@') { changed = true; return '@'; }
      return rowFormats[i];
    });
  });
  if (changed) range.setNumberFormats(next);
}

function deleteRow_(sheetName, pkField, pkValue) {
  var sheet = getSheet_(sheetName);
  var headers = SCHEMA[sheetName];
  var pkCol = headers.indexOf(pkField) + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var pkValues = sheet.getRange(2, pkCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < pkValues.length; i++) {
    if (samePk_(pkValues[i][0], pkValue)) {
      sheet.deleteRow(i + 2);
      invalidateSheetCache_(sheetName);
      logAudit_(sheetName, pkValue, 'DELETE', {});
      return true;
    }
  }
  return false;
}

/**
 * 整批新增/更新/刪除同一張分頁的很多列，取代「每一列各自呼叫 upsertRow_/deleteRow_」。
 *
 * 逐列處理的問題：每一列各自要「掃 PK 欄找列號 → 讀寫格式 → 寫入 → 寫稽核」，
 * 一次矩陣式的整批存檔(銷貨成本/營業費用/開發總投/科目設定…隨便一頁動輒十幾到上百格)
 * 就會在同一次執行裡打出對應數量的 Sheets API 呼叫，是存檔感覺卡的主因
 * （實測 55 格：逐列寫入約 330 次 API 呼叫，整批寫入後降到個位數，見
 * tools/verify-write-batching.js）。
 *
 * 做法跟 CalcEngine.gs 的 writePLResult_ 一樣：整段資料只讀一次、只寫一次 ——
 *   1. 把現有資料整塊讀出來(1 次 getValues)
 *   2. 在記憶體裡套用這一批的新增/更新(找不到 PK 就當新增)與刪除
 *   3. 整段一次寫回(先 clearContent 再 setValues，避免列數變少時留下舊資料的殘影)
 * 呼叫端仍然一次只描述「這一批要 upsert 哪些列、要刪除哪些 PK」，不需要知道列號，
 * 跟原本呼叫 upsertRow_/deleteRow_ 的介面一樣簡單。
 *
 * upserts：要新增或更新的列物件陣列，沒有 pkField 值的視為新增(自動產生 ID)，
 *          其餘欄位比照 upsertRow_ 的語意整列覆蓋(不是 merge，畫面沒送出的欄位會變空白，
 *          呼叫端要跟原本一樣自己決定是否先用 upsertRowMerge_ 那種模式取現有資料補齊)。
 * deletePks：要刪除的 PK 值陣列；跟同一批 upserts 撞到同一個 PK 時，以 upserts 為準
 *            (先刪除清單、後面又被 upsert 加回來，理當視為「留下」而不是「刪除」)。
 */
function batchWriteRows_(sheetName, pkField, upserts, deletePks) {
  var sheet = getSheet_(sheetName);
  var headers = SCHEMA[sheetName];
  var pkCol = headers.indexOf(pkField);
  var width = headers.length;
  var lastRow = sheet.getLastRow();

  var existing = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : [];

  var deleteSet = {};
  (deletePks || []).forEach(function (pk) { if (pk !== '' && pk !== null && pk !== undefined) deleteSet[String(pk)] = true; });

  // pk(字串) -> existing 陣列的索引，只收有值的 PK；空白列(理論上不會有，防禦一下)不參與比對
  var pkIndex = {};
  existing.forEach(function (row, i) {
    if (row[pkCol] !== '' && row[pkCol] !== null && row[pkCol] !== undefined) pkIndex[String(row[pkCol])] = i;
  });

  var auditEntries = [];
  var now = new Date();
  var user = Session.getActiveUser().getEmail();

  (upserts || []).forEach(function (rowObj) {
    if (!rowObj[pkField]) rowObj[pkField] = generateId_(rowIdPrefix_(sheetName));
    var pk = String(rowObj[pkField]);
    var rowArray = headers.map(function (h) { return rowObj[h] !== undefined ? rowObj[h] : ''; });
    var isNew = pkIndex[pk] === undefined;
    if (isNew) { pkIndex[pk] = existing.length; existing.push(rowArray); }
    else existing[pkIndex[pk]] = rowArray;
    auditEntries.push([now, user, sheetName, rowObj[pkField], isNew ? 'INSERT' : 'UPDATE', JSON.stringify(rowObj)]);
    delete deleteSet[pk];   // 同一批裡先列進刪除清單、又被 upsert 加回來的，以加回來為準
  });

  var survivors = Object.keys(deleteSet).length ? existing.filter(function (row) {
    var pk = String(row[pkCol]);
    if (!deleteSet[pk]) return true;
    auditEntries.push([now, user, sheetName, row[pkCol], 'DELETE', '{}']);
    return false;
  }) : existing;

  // 整段資料一次寫回；先清掉舊範圍再寫，列數變少(刪除多於新增)時才不會留下舊列的殘影
  if (lastRow >= 2) sheet.getRange(2, 1, lastRow - 1, width).clearContent();
  if (survivors.length) {
    var range = sheet.getRange(2, 1, survivors.length, width);
    applyTextColumnFormats_(range, headers, sheetName);
    range.setValues(survivors);
  }
  invalidateSheetCache_(sheetName);
  logAuditBatch_(auditEntries);
  return true;
}

function rowIdPrefix_(sheetName) {
  var map = {
    SalesMix: 'SM', CostOfSales: 'CS', DevInvestment: 'DI',
    OperatingExpense: 'OE', Parameters: 'PM', PLResult: 'PR',
    VehicleTypes: 'VT', Vehicles: 'VH', Scenarios: 'SC'
  };
  return map[sheetName] || 'RW';
}

function logAudit_(sheetName, rowId, action, payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('AuditLog');
  if (!sheet) return; // AuditLog 為選配表，不存在就略過
  sheet.appendRow([new Date(), Session.getActiveUser().getEmail(), sheetName, rowId, action, JSON.stringify(payload)]);
}

/** logAudit_ 的整批版本：entries 是 [[Timestamp, User, SheetName, RowID, Action, Payload], ...]，
 *  一次 setValues() 寫完，不像逐筆 appendRow() 一列一次呼叫。 */
function logAuditBatch_(entries) {
  if (!entries || !entries.length) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('AuditLog');
  if (!sheet) return; // AuditLog 為選配表，不存在就略過
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, entries.length, 6).setValues(entries);
}

function toNumber_(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** 依某個排序欄位排序，留白視為排在最後面；相對順序穩定，不會因為排序值相同就跳來跳去 */
function sortByOrder_(rows, field) {
  var withIndex = rows.map(function (r, i) { return { row: r, i: i }; });
  withIndex.sort(function (a, b) {
    var av = a.row[field] === '' || a.row[field] === undefined || a.row[field] === null ? Infinity : toNumber_(a.row[field]);
    var bv = b.row[field] === '' || b.row[field] === undefined || b.row[field] === null ? Infinity : toNumber_(b.row[field]);
    return av !== bv ? av - bv : a.i - b.i;
  });
  return withIndex.map(function (x) { return x.row; });
}
