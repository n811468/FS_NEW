/**
 * 地端版的 Google Apps Script 模擬層：讓 src/*.gs 原封不動地跑在瀏覽器裡。
 *
 * 跟 tools/fake-apps-script.js 的差別：那一份是給 Node 驗算用的(會數 API 呼叫次數、用 vm 載入檔案)，
 * 這一份是正式給使用者用的，所以：
 *   - 儲存格寫入比照真的 Google Sheets「自動偵測格式」：一般格式的儲存格裡，長得像數字的字串會變成 Number
 *     (純文字格式 '@' 的欄位不轉，前導零得以保留)。這樣讀回來的型別跟這套程式
 *     原本在 Google Sheets 上的行為一致(.gs 裡的比對邏輯是照那個行為寫的)。
 *   - CacheService 是不快取的空殼：資料本來就在記憶體裡，跨執行快取只會多一個讀到舊資料的機會。
 *   - Session.getActiveUser() 回傳使用者在地端版工具列上自己填的名字(沒有 Google 帳號可用)。
 *
 * 同一份檔案在瀏覽器(window.FSGasShim)與 Node(require)都能用，Node 端由 tools/verify-local.js 驗證。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSGasShim = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Sheets 在一般格式儲存格輸入純數字字串時會自動轉成數字；這裡只認最常見的十進位寫法，
  // 前導零(0901)、千分位、日期字串一律維持字串 —— 寧可少轉，也不要把代號轉壞。
  var NUMERIC_RE_ = /^-?(0|[1-9]\d*)(\.\d+)?$/;
  function autoDetectCellValue_(v, format) {
    if (format === '@') return v;
    if (typeof v === 'string' && NUMERIC_RE_.test(v)) return Number(v);
    return v;
  }
  function filled_(v) { return v !== '' && v !== null && v !== undefined; }

  function Sheet(name, onWrite) {
    this.name = name;
    this.grid = [];
    this.formats = [];
    this._onWrite = onWrite;
  }
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.setFrozenRows = function () { };
  Sheet.prototype._ensure = function (rows, cols) {
    while (this.grid.length < rows) this.grid.push([]);
    while (this.formats.length < rows) this.formats.push([]);
    this.grid.forEach(function (row) { while (row.length < cols) row.push(''); });
    this.formats.forEach(function (row) { while (row.length < cols) row.push('general'); });
  };
  Sheet.prototype.getLastRow = function () {
    var last = 0;
    this.grid.forEach(function (row, i) { if (row.some(filled_)) last = i + 1; });
    return last;
  };
  Sheet.prototype.getLastColumn = function () {
    var last = 0;
    this.grid.forEach(function (row) { row.forEach(function (v, j) { if (filled_(v)) last = Math.max(last, j + 1); }); });
    return last;
  };
  Sheet.prototype.appendRow = function (values) {
    var r = this.getLastRow();
    this._ensure(r + 1, values.length);
    for (var j = 0; j < values.length; j++) this.grid[r][j] = autoDetectCellValue_(values[j], this.formats[r][j]);
    this._onWrite(this.name);
  };
  Sheet.prototype.deleteRow = function (rowIndex) {
    this.grid.splice(rowIndex - 1, 1);
    this.formats.splice(rowIndex - 1, 1);
    this._onWrite(this.name);
  };
  Sheet.prototype.getRange = function (row, col, numRows, numCols) {
    var sheet = this;
    var nr = numRows || 1;
    var nc = numCols || 1;
    sheet._ensure(row + nr - 1, col + nc - 1);
    function each(fn) {
      for (var i = 0; i < nr; i++) for (var j = 0; j < nc; j++) fn(row - 1 + i, col - 1 + j, i, j);
    }
    function read(src) {
      var out = [];
      for (var i = 0; i < nr; i++) {
        var line = [];
        for (var j = 0; j < nc; j++) line.push(src[row - 1 + i][col - 1 + j]);
        out.push(line);
      }
      return out;
    }
    return {
      getValues: function () { return read(sheet.grid); },
      setValues: function (values) {
        sheet._ensure(row + nr - 1, col + nc - 1);
        each(function (r, c, i, j) { sheet.grid[r][c] = autoDetectCellValue_(values[i][j], sheet.formats[r][c]); });
        sheet._onWrite(sheet.name);
      },
      clearContent: function () {
        each(function (r, c) { sheet.grid[r][c] = ''; });
        sheet._onWrite(sheet.name);
      },
      getValue: function () { return sheet.grid[row - 1][col - 1]; },
      setValue: function (v) {
        sheet._ensure(row, col);
        sheet.grid[row - 1][col - 1] = autoDetectCellValue_(v, sheet.formats[row - 1][col - 1]);
        sheet._onWrite(sheet.name);
      },
      getNumberFormats: function () { return read(sheet.formats); },
      setNumberFormats: function (formats) {
        sheet._ensure(row + nr - 1, col + nc - 1);
        each(function (r, c, i, j) { sheet.formats[r][c] = formats[i][j]; });
      }
    };
  };

  /**
   * 記憶體版試算表。onWrite(分頁名稱) 在任何一次寫入後被呼叫，地端版靠它知道「這次呼叫有改到資料、要存檔」。
   */
  function Spreadsheet(onWrite) {
    this.sheets = [];
    this._onWrite = onWrite || function () { };
  }
  Spreadsheet.prototype.getSheetByName = function (name) {
    for (var i = 0; i < this.sheets.length; i++) if (this.sheets[i].name === name) return this.sheets[i];
    return null;
  };
  Spreadsheet.prototype.insertSheet = function (name) {
    var s = new Sheet(name, this._onWrite);
    this.sheets.push(s);
    this._onWrite(name);
    return s;
  };
  Spreadsheet.prototype.getSheets = function () { return this.sheets.slice(); };
  Spreadsheet.prototype.deleteSheet = function (sheet) {
    this.sheets = this.sheets.filter(function (s) { return s !== sheet; });
    this._onWrite(sheet.name);
  };

  /**
   * 把整張表換成 headers + rows(物件陣列)。資料包載入用：直接寫格子、不經過 setValues 的自動轉型，
   * 資料包裡是什麼型別就是什麼型別；textColumns 這幾欄標成純文字格式，之後寫入同欄也不會被轉成數字。
   */
  Spreadsheet.prototype.replaceTable = function (name, headers, rows, textColumns) {
    var sheet = this.getSheetByName(name) || this.insertSheet(name);
    var text = {};
    (textColumns || []).forEach(function (h) { text[h] = true; });
    sheet.grid = [headers.slice()].concat((rows || []).map(function (obj) {
      return headers.map(function (h) { return obj[h] === undefined || obj[h] === null ? '' : obj[h]; });
    }));
    sheet.formats = sheet.grid.map(function () {
      return headers.map(function (h) { return text[h] ? '@' : 'general'; });
    });
    this._onWrite(name);
    return sheet;
  };

  /** 整張表讀成物件陣列(第一列是標題)，濾掉全空白的列。匯出資料包用，不經過 .gs 的快取。 */
  Spreadsheet.prototype.readTable = function (name) {
    var sheet = this.getSheetByName(name);
    if (!sheet || !sheet.grid.length) return [];
    var headers = sheet.grid[0];
    return sheet.grid.slice(1)
      .filter(function (row) { return row.some(filled_); })
      .map(function (row) {
        var obj = {};
        headers.forEach(function (h, i) {
          if (!h) return;
          var v = row[i];
          obj[h] = Object.prototype.toString.call(v) === '[object Date]' ? v.toISOString() : (v === undefined ? '' : v);
        });
        return obj;
      });
  };

  function randomUuid_() {
    var c = (typeof crypto !== 'undefined') ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var hex = '';
    for (var i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function pad2_(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * .gs 需要的全域物件。.gs 只用到 Utilities.formatDate(d, tz, 'yyyy-MM-dd') 這一種格式，
   * 用本機時區輸出(地端版本來就是使用者自己的電腦)。
   */
  function createGlobals(spreadsheet, opts) {
    opts = opts || {};
    var getUser = opts.getUser || function () { return '本機使用者'; };
    var nullCache = { get: function () { return null; }, put: function () { }, remove: function () { } };
    return {
      SpreadsheetApp: {
        getActiveSpreadsheet: function () { return spreadsheet; },
        getUi: function () { throw new Error('地端版沒有試算表選單'); }
      },
      LockService: { getScriptLock: function () { return { waitLock: function () { }, releaseLock: function () { } }; } },
      CacheService: { getScriptCache: function () { return nullCache; } },
      Utilities: {
        getUuid: opts.getUuid || randomUuid_,
        formatDate: function (d) { return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate()); }
      },
      Session: {
        getScriptTimeZone: function () { return 'Asia/Taipei'; },
        getActiveUser: function () { return { getEmail: function () { return getUser(); } }; }
      },
      Logger: { log: function () { } }
    };
  }

  return { Spreadsheet: Spreadsheet, createGlobals: createGlobals, autoDetectCellValue_: autoDetectCellValue_ };
}));
