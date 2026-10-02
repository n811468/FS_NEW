/**
 * 讓 src/*.gs 可以在 Node 上跑起來的最小 Google Apps Script 模擬層(Node 驗算用)。
 * 只實作專案實際用到的 API：記憶體版的試算表、LockService、Utilities、Session、Logger。
 *
 * 目的是讓驗算腳本走完整條真實路徑（setupSpreadsheet → 各 save 函式 → CalcEngine），
 * 而不是另外抄一份公式來對答案 —— 抄一份的話，抄錯或程式改了沒同步都驗不出來。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Sheets 的「自動偵測格式」：純數字字串(含前導零)在一般格式('general')的儲存格裡
// 會被自動轉成 Number，前導零因此消失；格式設成 '@'(純文字)就不會被轉換。
// 這裡只模擬這一種會咬掉前導零的情況，其餘型別維持字串/數字原樣，足以驗證 applyTextColumnFormats_ 有沒有生效。
function autoDetectCellValue_(v, format) {
  if (format === '@') return v;
  if (typeof v === 'string' && /^0\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * 呼叫次數計數器：真的 Apps Script 對 Google Sheets 的每一次 getValues/setValues/
 * getLastRow…都是一次網路來回，是「存檔為什麼感覺卡」的主因。這裡在假的試算表層
 * 記下每一種方法被呼叫了幾次，讓 tools/verify-write-batching.js 能拿實際數字
 * 比較「逐列寫入」跟「整批寫入」差多少次 API 呼叫，不必猜。
 */
let API_CALL_COUNTS_ = {};
function countApiCall_(name) { API_CALL_COUNTS_[name] = (API_CALL_COUNTS_[name] || 0) + 1; }
function resetApiCallCounts_() { API_CALL_COUNTS_ = {}; }
function getApiCallCounts_() { return Object.assign({}, API_CALL_COUNTS_); }
function totalApiCalls_() { return Object.values(API_CALL_COUNTS_).reduce((s, n) => s + n, 0); }

class FakeSheet {
  constructor(name) { this.name = name; this.grid = []; this.formats = []; }
  getName() { return this.name; }
  setFrozenRows() { }

  _ensure(rows, cols) {
    while (this.grid.length < rows) this.grid.push([]);
    while (this.formats.length < rows) this.formats.push([]);
    this.grid.forEach(row => { while (row.length < cols) row.push(''); });
    this.formats.forEach(row => { while (row.length < cols) row.push('general'); });
  }
  _filled(v) { return v !== '' && v !== null && v !== undefined; }

  getLastRow() {
    countApiCall_('getLastRow');
    let last = 0;
    this.grid.forEach((row, i) => { if (row.some(v => this._filled(v))) last = i + 1; });
    return last;
  }
  getLastColumn() {
    countApiCall_('getLastColumn');
    let last = 0;
    this.grid.forEach(row => row.forEach((v, j) => { if (this._filled(v)) last = Math.max(last, j + 1); }));
    return last;
  }
  appendRow(values) {
    countApiCall_('appendRow');
    // 不透過 getLastRow()/setValues() 走，避免這一列本身被計算成另外兩次呼叫
    // (真的 Apps Script 的 appendRow 是單一次 API 呼叫)
    let r = 0;
    this.grid.forEach((row, i) => { if (row.some(v => this._filled(v))) r = i + 1; });
    this._ensure(r + 1, values.length);
    values.forEach((v, j) => { this.grid[r][j] = v; });
  }
  deleteRow(rowIndex) { countApiCall_('deleteRow'); this.grid.splice(rowIndex - 1, 1); }

  getRange(row, col, numRows, numCols) {
    const sheet = this;
    const nr = numRows || 1;
    const nc = numCols || 1;
    sheet._ensure(row + nr - 1, col + nc - 1);
    return {
      getValues() {
        countApiCall_('getValues');
        const out = [];
        for (let i = 0; i < nr; i++) {
          const line = [];
          for (let j = 0; j < nc; j++) line.push(sheet.grid[row - 1 + i][col - 1 + j]);
          out.push(line);
        }
        return out;
      },
      setValues(values) {
        countApiCall_('setValues');
        sheet._ensure(row + nr - 1, col + nc - 1);
        for (let i = 0; i < nr; i++) {
          for (let j = 0; j < nc; j++) {
            const fmt = sheet.formats[row - 1 + i][col - 1 + j];
            sheet.grid[row - 1 + i][col - 1 + j] = autoDetectCellValue_(values[i][j], fmt);
          }
        }
      },
      clearContent() {
        countApiCall_('clearContent');
        for (let i = 0; i < nr; i++) {
          for (let j = 0; j < nc; j++) sheet.grid[row - 1 + i][col - 1 + j] = '';
        }
      },
      getValue() { countApiCall_('getValue'); return sheet.grid[row - 1][col - 1]; },
      setValue(v) { countApiCall_('setValue'); sheet._ensure(row, col); sheet.grid[row - 1][col - 1] = v; },
      getNumberFormats() {
        countApiCall_('getNumberFormats');
        const out = [];
        for (let i = 0; i < nr; i++) {
          const line = [];
          for (let j = 0; j < nc; j++) line.push(sheet.formats[row - 1 + i][col - 1 + j]);
          out.push(line);
        }
        return out;
      },
      setNumberFormats(formats) {
        countApiCall_('setNumberFormats');
        sheet._ensure(row + nr - 1, col + nc - 1);
        for (let i = 0; i < nr; i++) {
          for (let j = 0; j < nc; j++) sheet.formats[row - 1 + i][col - 1 + j] = formats[i][j];
        }
      }
    };
  }
}

class FakeSpreadsheet {
  constructor() { this.sheets = []; }
  getSheetByName(name) { return this.sheets.filter(s => s.getName() === name)[0] || null; }
  insertSheet(name) { const s = new FakeSheet(name); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(sheet) { this.sheets = this.sheets.filter(s => s !== sheet); }
}

/** 假的 CacheService：純記憶體版，行為只求跟真的介面一致，不模擬過期時間等細節 */
class FakeCache {
  constructor() { this.map = {}; }
  get(key) { return this.map[key] !== undefined ? this.map[key] : null; }
  put(key, value) { this.map[key] = value; }
  remove(key) { delete this.map[key]; }
}

/** 載入 src/ 的 .gs 檔並回傳可以直接呼叫其中函式的 context */
function loadAppsScript(files) {
  const spreadsheet = new FakeSpreadsheet();
  let uuidSeq = 0;

  const context = {
    console: console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      // 從編輯器(而非 Sheets 選單)執行時 getUi() 本來就不能用，程式已有 try/catch
      getUi: () => { throw new Error('no UI in this context'); }
    },
    LockService: { getScriptLock: () => ({ waitLock() { }, releaseLock() { } }) },
    Utilities: {
      getUuid: () => 'uuid' + String(++uuidSeq).padStart(8, '0'),
      formatDate: (d) => d.toISOString().slice(0, 10)
    },
    Session: {
      getScriptTimeZone: () => 'Asia/Taipei',
      getActiveUser: () => ({ getEmail: () => 'verify@local' })
    },
    Logger: { log: () => { } },
    CacheService: { getScriptCache: () => (context.__scriptCache || (context.__scriptCache = new FakeCache())) }
  };
  vm.createContext(context);

  files.forEach(file => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  });
  return context;
}

module.exports = { loadAppsScript, resetApiCallCounts_, getApiCallCounts_, totalApiCalls_ };
