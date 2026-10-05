/**
 * 地端版的「後端主機」：把 .gs 後端、記憶體試算表、瀏覽器暫存、資料包串在一起。
 *
 *   前端 script.html ──google.script.run──▶ host.call(函式名, 參數)
 *                                              │ 跟 Apps Script 一樣：每次呼叫都是一次新的執行(清掉單次執行快取)
 *                                              ▼
 *                                   .gs 後端(原檔，包在 FSBackendFactory 裡)
 *                                              │ 讀寫
 *                                              ▼
 *                                   記憶體試算表(gas-shim.js) ──有改到資料──▶ 存進瀏覽器暫存(localStorage)
 *
 * 瀏覽器暫存只是「關掉再打開還在」的便利，不是正式保存：清除瀏覽資料、換電腦、換瀏覽器就沒了。
 * 正式保存與交換一律用資料包(pack.js)，所以這裡記著「上次匯出後改了幾次」，讓工具列提醒使用者匯出。
 *
 * createHost() 不直接碰 window/localStorage(由呼叫端傳入 storage)，Node 端可以用假的 storage 驗證。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSHost = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORAGE_KEY = 'fsLocal.db.v1';
  var AUDIT_KEEP_ROWS = 3000;   // 稽核紀錄只留最近這麼多列，避免瀏覽器暫存被它塞爆
  // 寫到這些分頁不算「資料有變更」：PLResult 是每次開儀表板都會重寫的計算快照
  var NON_DATA_SHEETS = { PLResult: true };

  /**
   * opts: {
   *   factory: FSBackendFactory, shim: FSGasShim, pack: FSPack,
   *   storage: { getItem, setItem }  (可省略 = 不暫存),
   *   getUser: () => 使用者名稱, getUuid: 可省略
   * }
   */
  function createHost(opts) {
    var shim = opts.shim, Pack = opts.pack;
    var storage = opts.storage || null;
    var changed = false;
    var state = { savedAt: '', changesSinceExport: 0, lastExportAt: '', storageOk: true, stale: false, firstRun: false };
    var listeners = [];

    var spreadsheet = new shim.Spreadsheet(function (sheetName) {
      if (!NON_DATA_SHEETS[sheetName]) changed = true;
    });
    var backend = opts.factory(shim.createGlobals(spreadsheet, { getUser: opts.getUser, getUuid: opts.getUuid }));
    var C = backend.consts;

    function notify() { listeners.forEach(function (fn) { try { fn(state); } catch (e) { /* UI 自己的錯不影響資料 */ } }); }

    function readTables() {
      var tables = {};
      Pack.PACK_TABLES.forEach(function (name) { tables[name] = spreadsheet.readTable(name); });
      tables[Pack.AUDIT_TABLE] = spreadsheet.readTable(Pack.AUDIT_TABLE);
      return tables;
    }

    /** 整份資料庫換成 tables(資料包內容或暫存內容)，再補齊分頁與內建科目 */
    function writeTables(tables) {
      Object.keys(C.SCHEMA).forEach(function (name) {
        spreadsheet.replaceTable(name, C.SCHEMA[name], name === 'PLResult' ? [] : (tables[name] || []), C.TEXT_COLUMNS[name]);
      });
      var audit = (tables[Pack.AUDIT_TABLE] || []).slice(-AUDIT_KEEP_ROWS);
      spreadsheet.replaceTable(Pack.AUDIT_TABLE, Pack.AUDIT_HEADERS, audit, []);
      backend.beginExecution();
      backend.fns.setupSpreadsheet();   // 補齊缺少的分頁/標題列、灌入缺少的內建科目
      backend.beginExecution();
    }

    function persist() {
      if (!storage) return true;
      var tables = readTables();
      tables[Pack.AUDIT_TABLE] = tables[Pack.AUDIT_TABLE].slice(-AUDIT_KEEP_ROWS);
      state.savedAt = new Date().toISOString();
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({
          savedAt: state.savedAt, changesSinceExport: state.changesSinceExport,
          lastExportAt: state.lastExportAt, tables: tables
        }));
        state.storageOk = true;
      } catch (e) {
        state.storageOk = false;   // 無痕模式、空間不足等：資料還在這個分頁的記憶體裡，但關掉就沒了
      }
      return state.storageOk;
    }

    /** 開頁：有暫存就載入暫存，沒有就建一個空的資料庫(只有內建科目) */
    function start() {
      var saved = null;
      if (storage) {
        var raw = storage.getItem(STORAGE_KEY);
        try { saved = JSON.parse(raw || 'null'); } catch (e) {
          saved = null;
          // 暫存壞掉(理論上不會)：下面會建一個空資料庫並存檔，先把原本的內容另存一份，不要就這樣蓋掉
          try { storage.setItem(STORAGE_KEY + '.corrupt', raw); } catch (e2) { /* 空間不足就沒辦法了 */ }
        }
      }
      if (saved && saved.tables) {
        writeTables(saved.tables);
        state.savedAt = saved.savedAt || '';
        state.changesSinceExport = saved.changesSinceExport || 0;
        state.lastExportAt = saved.lastExportAt || '';
      } else {
        writeTables({});
        state.firstRun = true;
        persist();
      }
      changed = false;
      notify();
    }

    /** 前端呼叫後端函式。跟 google.script.run 一樣只開放公開函式(結尾不是底線)，參數與回傳值都走一次 JSON。 */
    function call(fnName, args) {
      if (state.stale) throw new Error('資料已在另一個視窗或分頁更新過，請重新整理這一頁再繼續操作（避免互相覆蓋）。');
      var fn = backend.fns[fnName];
      if (typeof fn !== 'function' || /_$/.test(fnName)) {
        throw new Error('沒有這個後端函式：' + fnName);
      }
      backend.beginExecution();
      changed = false;
      var result;
      try {
        result = fn.apply(null, JSON.parse(JSON.stringify(args || [])));
      } finally {
        if (changed) {
          state.changesSinceExport++;
          persist();
          notify();
        }
        changed = false;
      }
      return result === undefined ? null : JSON.parse(JSON.stringify(result));
    }

    /** 匯出資料包：vehicleTypeIds 有值 = 只匯出這幾個車型；opts2.scenarioIds 有值 = 只匯出這幾個情境；都沒有 = 整份 */
    function exportPack(vehicleTypeIds, opts2) {
      var scenarioIds = opts2 && opts2.scenarioIds && opts2.scenarioIds.length ? opts2.scenarioIds : null;
      var pack = Pack.buildPack(readTables(), {
        vehicleTypeIds: vehicleTypeIds && vehicleTypeIds.length ? vehicleTypeIds : null,
        scenarioIds: scenarioIds,
        exportedBy: opts.getUser ? opts.getUser() : ''
      });
      if (scenarioIds && !pack.tables.Scenarios.length) throw new Error('找不到要匯出的情境。');
      // 只有整份匯出才算「備份過了」；只匯出某個車型/情境不代表其他資料也有備份
      if ((!vehicleTypeIds || !vehicleTypeIds.length) && !scenarioIds) {
        state.changesSinceExport = 0;
        state.lastExportAt = pack.exportedAt;
        persist();
        notify();
      }
      return pack;
    }

    /** 取代匯入：整份資料庫換成資料包的內容 */
    function replaceWithPack(pack) {
      writeTables(pack.tables);
      state.changesSinceExport = pack.scope && pack.scope.kind === 'all' ? 0 : 1;
      persist();
      notify();
    }

    function mergeContext() {
      return { lineCodePrefix: C.LINE_CODE_PREFIX, builtInLineCodes: C.PL_LINE_ITEMS.map(function (d) { return d.LineCode; }) };
    }
    /** 合併匯入的預覽：不改資料，回傳要給使用者確認的報告 */
    function previewMerge(pack) { return Pack.mergePack(readTables(), pack.tables, mergeContext(), pack.scope); }
    function mergePack(pack) {
      var merged = Pack.mergePack(readTables(), pack.tables, mergeContext(), pack.scope);
      writeTables(merged.tables);
      state.changesSinceExport++;
      persist();
      notify();
      return merged.report;
    }

    /** 清空資料庫(只留內建科目) */
    function resetAll() {
      writeTables({});
      state.changesSinceExport = 0;
      persist();
      notify();
    }

    /** 另一個分頁存了同一份暫存：這個分頁手上的資料已經過期，再寫就會把對方的修改蓋掉 */
    function markStale() { state.stale = true; notify(); }

    return {
      STORAGE_KEY: STORAGE_KEY,
      start: start, call: call, state: state,
      onChange: function (fn) { listeners.push(fn); },
      readTables: readTables, exportPack: exportPack,
      replaceWithPack: replaceWithPack, previewMerge: previewMerge, mergePack: mergePack,
      resetAll: resetAll, markStale: markStale,
      backend: backend
    };
  }

  /**
   * 跟 google.script.run 同樣用法的替身：
   *   google.script.run.withSuccessHandler(fn).withFailureHandler(fn).someBackendFn(args...)
   * 一樣是非同步回呼(前端程式碼依賴「呼叫完不會立刻拿到結果」的時序)。
   */
  function createScriptRun(host, defer) {
    defer = defer || function (fn) { setTimeout(fn, 0); };
    function runner(ok, fail, userObject) {
      return new Proxy({}, {
        get: function (_, name) {
          if (name === 'withSuccessHandler') return function (h) { return runner(h, fail, userObject); };
          if (name === 'withFailureHandler') return function (h) { return runner(ok, h, userObject); };
          if (name === 'withUserObject') return function (u) { return runner(ok, fail, u); };
          return function () {
            var args = Array.prototype.slice.call(arguments);
            defer(function () {
              var result;
              try {
                result = host.call(name, args);
              } catch (e) {
                var err = e instanceof Error ? e : new Error(String(e));
                if (fail) fail(err, userObject); else if (typeof console !== 'undefined') console.error(err);
                return;
              }
              if (ok) ok(result, userObject);
            });
          };
        }
      });
    }
    return runner(null, null, undefined);
  }

  return { createHost: createHost, createScriptRun: createScriptRun, STORAGE_KEY: STORAGE_KEY };
}));
