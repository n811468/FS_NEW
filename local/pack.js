/**
 * 資料包：地端版的資料交換格式(JSON)。
 *
 * 地端版的資料平常暫存在瀏覽器裡，但瀏覽器暫存不是可靠的保存方式(清快取、換電腦就沒了)，
 * 也沒辦法跟同事共用。資料包就是「把資料庫整份(或某幾個車型)抽成一個檔案」：
 *   - 封存 / 備份：定期匯出一包，就是一份完整的快照
 *   - 交換：每個人負責自己的車型，匯出「目前車型」那一包給別人；別人用「合併匯入」併進自己的資料庫，
 *     就能在儀表板上跨車型並排比較
 *
 * 內容就是各張表的列(欄位名稱跟 Constants.gs 的 SCHEMA 一致)，沒有公式；PLResult 是計算快照，
 * 隨時可以重算，所以不放。舊版資料包少了的欄位一律視為空白，多出來(已經不用)的欄位載入時忽略。
 *
 * 這一層全是純函式(輸入表格、輸出表格)，不碰瀏覽器也不碰 .gs，Node 端由 tools/verify-local.js 驗證。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSPack = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMAT = 'FS-損益試算資料包';
  var FORMAT_VERSION = 1;

  // 資料包收錄的表(順序即匯出順序)。PLResult 是計算快照不收；AuditLog 另外處理。
  var PACK_TABLES = ['VehicleTypes', 'Vehicles', 'Scenarios', 'SalesMix', 'CostOfSales',
    'DevInvestment', 'OperatingExpense', 'Parameters', 'PLLineItems'];
  var AUDIT_TABLE = 'AuditLog';
  var AUDIT_HEADERS = ['Timestamp', 'User', 'SheetName', 'RowID', 'Action', 'Payload'];

  // 依 ScenarioID 掛在情境底下的表，與各自的主鍵
  var SCENARIO_TABLES = { SalesMix: 'RowID', CostOfSales: 'RowID', DevInvestment: 'RowID', OperatingExpense: 'RowID', Parameters: 'ParamID' };

  function str_(v) { return v === undefined || v === null ? '' : String(v); }
  function set_(list) { var s = {}; list.forEach(function (k) { s[str_(k)] = true; }); return s; }
  function clone_(obj) { return JSON.parse(JSON.stringify(obj)); }
  function emptyTables_() { var t = {}; PACK_TABLES.forEach(function (n) { t[n] = []; }); t[AUDIT_TABLE] = []; return t; }

  /** 只留指定車型的資料。科目表是全域共用的，整份帶著，對方才對得到科目代碼。 */
  function filterByVehicleTypes(tables, vehicleTypeIds) {
    var types = set_(vehicleTypeIds);
    var vehicles = (tables.Vehicles || []).filter(function (r) { return types[str_(r.VehicleTypeID)]; });
    var scenarios = (tables.Scenarios || []).filter(function (r) { return types[str_(r.VehicleTypeID)]; });
    var vehicleIds = set_(vehicles.map(function (r) { return r.VehicleID; }));
    var scenarioIds = set_(scenarios.map(function (r) { return r.ScenarioID; }));
    var out = {
      VehicleTypes: (tables.VehicleTypes || []).filter(function (r) { return types[str_(r.VehicleTypeID)]; }),
      Vehicles: vehicles,
      Scenarios: scenarios,
      PLLineItems: (tables.PLLineItems || []).slice()
    };
    Object.keys(SCENARIO_TABLES).forEach(function (name) {
      out[name] = (tables[name] || []).filter(function (r) {
        if (scenarioIds[str_(r.ScenarioID)]) return true;
        // 沒有情境的參數是全域參數：只帶「全車系」或屬於這幾個車型車系的那幾列
        return name === 'Parameters' && !str_(r.ScenarioID) && (!str_(r.VehicleID) || vehicleIds[str_(r.VehicleID)]);
      });
    });
    out[AUDIT_TABLE] = [];
    return out;
  }

  /**
   * 建立資料包。meta.vehicleTypeIds 有值時只匯出這幾個車型(一個人負責的範圍)，否則整份資料庫。
   */
  function buildPack(tables, meta) {
    meta = meta || {};
    var partial = meta.vehicleTypeIds && meta.vehicleTypeIds.length;
    var data = partial ? filterByVehicleTypes(tables, meta.vehicleTypeIds) : tables;
    var outTables = {};
    PACK_TABLES.forEach(function (n) { outTables[n] = clone_(data[n] || []); });
    if (!partial && data[AUDIT_TABLE] && data[AUDIT_TABLE].length) outTables[AUDIT_TABLE] = clone_(data[AUDIT_TABLE]);
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      exportedAt: meta.exportedAt || new Date().toISOString(),
      exportedBy: meta.exportedBy || '',
      scope: partial
        ? { kind: 'vehicleTypes', vehicleTypeIds: meta.vehicleTypeIds.map(str_) }
        : { kind: 'all', vehicleTypeIds: (outTables.VehicleTypes || []).map(function (r) { return str_(r.VehicleTypeID); }) },
      tables: outTables
    };
  }

  /** 讀入並檢查資料包(字串或已解析的物件)，錯誤訊息直接給使用者看 */
  function parsePack(input) {
    var pack = input;
    if (typeof input === 'string') {
      try { pack = JSON.parse(input); } catch (e) { throw new Error('檔案不是有效的 JSON，可能不是資料包或檔案已損毀。'); }
    }
    if (!pack || typeof pack !== 'object' || pack.format !== FORMAT) {
      throw new Error('這個檔案不是車型損益試算的資料包。');
    }
    if (typeof pack.formatVersion !== 'number' || pack.formatVersion > FORMAT_VERSION) {
      throw new Error('資料包版本(' + pack.formatVersion + ')比這個工具新，請改用新版的地端版開啟。');
    }
    if (!pack.tables || typeof pack.tables !== 'object') throw new Error('資料包缺少資料內容(tables)。');
    var tables = emptyTables_();
    Object.keys(tables).forEach(function (name) {
      var rows = pack.tables[name];
      if (rows === undefined) return;
      if (!Array.isArray(rows)) throw new Error('資料包的「' + name + '」格式不正確。');
      tables[name] = rows.filter(function (r) { return r && typeof r === 'object'; });
    });
    pack.tables = tables;
    if (!pack.scope) pack.scope = { kind: 'all', vehicleTypeIds: tables.VehicleTypes.map(function (r) { return str_(r.VehicleTypeID); }) };
    return pack;
  }

  /** 每個車型有幾個車系/情境，匯入前給使用者確認用 */
  function summarize(tables) {
    var byType = {};
    function bucket(id) { id = str_(id); return byType[id] || (byType[id] = { vehicles: 0, scenarios: 0 }); }
    (tables.VehicleTypes || []).forEach(function (r) { bucket(r.VehicleTypeID); });
    (tables.Vehicles || []).forEach(function (r) { bucket(r.VehicleTypeID).vehicles++; });
    (tables.Scenarios || []).forEach(function (r) { bucket(r.VehicleTypeID).scenarios++; });
    return byType;
  }

  function lineSignature_(d) {
    return [str_(d.ParentLine), str_(d.AutoSource), str_(d.LineName).trim()].join('|');
  }

  /**
   * 合併匯入：資料包裡有的車型，以資料包為準整個換掉(本機這幾個車型的車系、情境與所有輸入資料都會被取代)；
   * 資料包裡沒有的車型完全不動。對應「每個人負責自己的車型」：誰負責的車型，誰的資料包說了算。
   *
   * 科目表是全域共用的，兩邊各自新增的自訂科目可能拿到同一個代碼(兩人都新增了 b15，但一個是「運費」一個是「關稅」)，
   * 所以科目要逐一比對：
   *   - 內建科目(PL_LINE_ITEMS 裡的代碼)：代碼相同就是同一個科目，沿用本機的設定
   *   - 代碼、父科目、名稱都相同：同一個科目
   *   - 本機已經有「父科目+名稱」相同、代碼不同的科目：視為同一個科目，資料包的金額改掛到本機的代碼
   *   - 代碼撞到本機另一個不同的科目：重新配號(父科目字首 + 最小未使用號碼，規則跟 nextLineCode_ 一樣)，
   *     資料包裡指到舊代碼的金額、攤提落點一起改過去
   *
   * ctx.lineCodePrefix：Constants.gs 的 LINE_CODE_PREFIX；ctx.builtInLineCodes：內建科目代碼清單。
   * 回傳 { tables, report }，不修改傳進來的資料。
   */
  function mergePack(localTables, incomingTables, ctx) {
    var local = clone_(localTables);
    var incoming = clone_(incomingTables);
    PACK_TABLES.concat([AUDIT_TABLE]).forEach(function (n) { local[n] = local[n] || []; incoming[n] = incoming[n] || []; });
    var prefixOf = ctx.lineCodePrefix || {};
    var builtIn = set_(ctx.builtInLineCodes || []);

    var types = set_([].concat(
      incoming.VehicleTypes.map(function (r) { return r.VehicleTypeID; }),
      incoming.Vehicles.map(function (r) { return r.VehicleTypeID; }),
      incoming.Scenarios.map(function (r) { return r.VehicleTypeID; })
    ).filter(function (id) { return str_(id); }));
    var typeIds = Object.keys(types);

    var report = {
      replacedTypes: [], addedTypes: [],
      lineItemsAdded: [], lineItemsRemapped: [], lineItemsReused: [],
      globalParamsAdded: 0, globalParamsKept: [], rowIdsReassigned: 0
    };
    var localSummary = summarize(local);
    var incomingSummary = summarize(incoming);
    typeIds.forEach(function (id) {
      var entry = { VehicleTypeID: id, local: localSummary[id] || null, incoming: incomingSummary[id] || { vehicles: 0, scenarios: 0 } };
      (localSummary[id] ? report.replacedTypes : report.addedTypes).push(entry);
    });

    // ---- 衝突檢查：車系代號/情境代號是全域唯一的，不能跟本機「其他車型」的撞在一起 ----
    var localVehicleType = {};
    local.Vehicles.forEach(function (r) { localVehicleType[str_(r.VehicleID)] = str_(r.VehicleTypeID); });
    incoming.Vehicles.forEach(function (r) {
      var owner = localVehicleType[str_(r.VehicleID)];
      if (owner && !types[owner]) {
        throw new Error('車系代號「' + r.VehicleID + '」在本機屬於車型 ' + owner + '，資料包裡卻屬於車型 ' +
          r.VehicleTypeID + '。請先在其中一邊把車系改名後再合併。');
      }
    });
    var localScenarioType = {};
    local.Scenarios.forEach(function (r) { localScenarioType[str_(r.ScenarioID)] = str_(r.VehicleTypeID); });
    incoming.Scenarios.forEach(function (r) {
      var owner = localScenarioType[str_(r.ScenarioID)];
      if (owner && !types[owner]) {
        throw new Error('情境代號「' + r.ScenarioID + '」同時出現在本機車型 ' + owner + ' 與資料包車型 ' + r.VehicleTypeID + '，無法合併。');
      }
    });

    // ---- 科目對照 ----
    var localByCode = {}, localBySig = {};
    local.PLLineItems.forEach(function (d) {
      localByCode[str_(d.LineCode)] = d;
      if (!localBySig[lineSignature_(d)]) localBySig[lineSignature_(d)] = d;
    });
    var taken = {};
    local.PLLineItems.forEach(function (d) { taken[str_(d.LineCode)] = true; });
    incoming.PLLineItems.forEach(function (d) { taken[str_(d.LineCode)] = true; });
    var codeMap = {};
    incoming.PLLineItems.forEach(function (d) {
      var code = str_(d.LineCode);
      var mine = localByCode[code];
      if (builtIn[code]) {
        codeMap[code] = code;
        if (!mine) { local.PLLineItems.push(d); localByCode[code] = d; }
        return;
      }
      if (mine && lineSignature_(mine) === lineSignature_(d)) { codeMap[code] = code; return; }
      var same = localBySig[lineSignature_(d)];
      if (same) {
        codeMap[code] = str_(same.LineCode);
        report.lineItemsReused.push({ from: code, to: str_(same.LineCode), name: str_(d.LineName) });
        return;
      }
      if (mine) {
        var prefix = prefixOf[str_(d.ParentLine)];
        if (!prefix) throw new Error('科目「' + d.LineName + '」(' + code + ') 跟本機的科目撞號，且無法自動改號。');
        var n = 1;
        while (taken[prefix + n]) n++;
        var newCode = prefix + n;
        taken[newCode] = true;
        codeMap[code] = newCode;
        var copy = clone_(d);
        copy.LineCode = newCode;
        local.PLLineItems.push(copy);
        localByCode[newCode] = copy;
        localBySig[lineSignature_(copy)] = copy;
        report.lineItemsRemapped.push({ from: code, to: newCode, name: str_(d.LineName) });
        return;
      }
      codeMap[code] = code;
      local.PLLineItems.push(d);
      localByCode[code] = d;
      localBySig[lineSignature_(d)] = d;
      report.lineItemsAdded.push({ code: code, name: str_(d.LineName) });
    });
    function mapCode(c) { return codeMap[str_(c)] !== undefined ? codeMap[str_(c)] : c; }
    incoming.CostOfSales.forEach(function (r) { r.LineCode = mapCode(r.LineCode); });
    incoming.OperatingExpense.forEach(function (r) { r.LineCode = mapCode(r.LineCode); });
    incoming.DevInvestment.forEach(function (r) { if (str_(r.TargetLineCode)) r.TargetLineCode = mapCode(r.TargetLineCode); });

    // ---- 拿掉本機這幾個車型的舊資料 ----
    var dropScenarios = set_(local.Scenarios.filter(function (r) { return types[str_(r.VehicleTypeID)]; })
      .map(function (r) { return r.ScenarioID; }));
    local.VehicleTypes = local.VehicleTypes.filter(function (r) { return !types[str_(r.VehicleTypeID)]; });
    local.Vehicles = local.Vehicles.filter(function (r) { return !types[str_(r.VehicleTypeID)]; });
    local.Scenarios = local.Scenarios.filter(function (r) { return !types[str_(r.VehicleTypeID)]; });
    Object.keys(SCENARIO_TABLES).forEach(function (name) {
      local[name] = local[name].filter(function (r) { return !dropScenarios[str_(r.ScenarioID)]; });
    });

    // ---- 放進資料包的資料 ----
    local.VehicleTypes = local.VehicleTypes.concat(incoming.VehicleTypes);
    local.Vehicles = local.Vehicles.concat(incoming.Vehicles);
    local.Scenarios = local.Scenarios.concat(incoming.Scenarios);
    Object.keys(SCENARIO_TABLES).forEach(function (name) {
      var pk = SCENARIO_TABLES[name];
      var usedPk = set_(local[name].map(function (r) { return r[pk]; }));
      incoming[name].forEach(function (r) {
        if (name === 'Parameters' && !str_(r.ScenarioID)) {
          // 全域參數(沒掛情境)：本機已有同一個參數就保留本機的值，不默默蓋掉別人的設定
          var exists = local.Parameters.filter(function (p) {
            return !str_(p.ScenarioID) && str_(p.ParamName) === str_(r.ParamName) &&
              str_(p.VehicleID) === str_(r.VehicleID) && str_(p.Currency) === str_(r.Currency);
          })[0];
          if (exists) {
            if (str_(exists.Value) !== str_(r.Value)) report.globalParamsKept.push({ ParamName: str_(r.ParamName), local: exists.Value, incoming: r.Value });
            return;
          }
          report.globalParamsAdded++;
        }
        // 主鍵理論上是隨機產生、不會撞；真的撞了就換一個，否則之後存檔時一列會蓋掉另一列
        if (usedPk[str_(r[pk])]) {
          var base = str_(r[pk]), k = 1;
          while (usedPk[base + '-m' + k]) k++;
          r[pk] = base + '-m' + k;
          report.rowIdsReassigned++;
        }
        usedPk[str_(r[pk])] = true;
        local[name].push(r);
      });
    });

    // ---- 稽核紀錄：兩邊都留，去掉完全相同的列 ----
    var seen = set_(local[AUDIT_TABLE].map(function (r) { return JSON.stringify(r); }));
    incoming[AUDIT_TABLE].forEach(function (r) {
      var key = JSON.stringify(r);
      if (!seen[key]) { seen[key] = true; local[AUDIT_TABLE].push(r); }
    });

    return { tables: local, report: report };
  }

  /** 合併結果寫成給使用者確認的文字 */
  function describeMerge(report) {
    var lines = [];
    function counts(s) { return s ? s.vehicles + ' 個車系、' + s.scenarios + ' 個情境' : '無資料'; }
    report.replacedTypes.forEach(function (t) {
      lines.push('・車型 ' + t.VehicleTypeID + '：本機的資料（' + counts(t.local) + '）會被資料包（' + counts(t.incoming) + '）取代');
    });
    report.addedTypes.forEach(function (t) {
      lines.push('・車型 ' + t.VehicleTypeID + '：新增（' + counts(t.incoming) + '）');
    });
    if (report.lineItemsAdded.length) {
      lines.push('・新增科目：' + report.lineItemsAdded.map(function (x) { return x.code + ' ' + x.name; }).join('、'));
    }
    report.lineItemsRemapped.forEach(function (x) {
      lines.push('・科目「' + x.name + '」代碼跟本機撞號，改為 ' + x.to + '（原 ' + x.from + '）');
    });
    report.lineItemsReused.forEach(function (x) {
      lines.push('・科目「' + x.name + '」本機已有（' + x.to + '），資料包的 ' + x.from + ' 併到同一個科目');
    });
    report.globalParamsKept.forEach(function (p) {
      lines.push('・全域參數「' + p.ParamName + '」兩邊不同，保留本機的值 ' + p.local + '（資料包是 ' + p.incoming + '）');
    });
    return lines.join('\n');
  }

  return {
    FORMAT: FORMAT, FORMAT_VERSION: FORMAT_VERSION, PACK_TABLES: PACK_TABLES,
    AUDIT_TABLE: AUDIT_TABLE, AUDIT_HEADERS: AUDIT_HEADERS,
    buildPack: buildPack, parsePack: parsePack, filterByVehicleTypes: filterByVehicleTypes,
    mergePack: mergePack, describeMerge: describeMerge, summarize: summarize
  };
}));
