/**
 * 資料包：地端版的資料交換格式(JSON)。
 *
 * 地端版的資料平常暫存在瀏覽器裡，但瀏覽器暫存不是可靠的保存方式(清快取、換電腦就沒了)，
 * 也沒辦法跟同事共用。資料包就是「把資料庫整份(或某幾個車型)抽成一個檔案」：
 *   - 封存 / 備份：定期匯出一包，就是一份完整的快照
 *   - 交換：每個人負責自己的車型，「匯出車型」(含這個車型的所有情境)那一包給別人；別人用「合併匯入」併進自己的資料庫，
 *     就能在儀表板上跨車型並排比較
 *   - 只交一個情境：「匯出情境」只帶目前選的情境(加上對方沒有這個車型時需要的車型、車系、科目表)，
 *     合併匯入時只新增/更新這個情境，對方同車型的其他情境不動
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
    'DevInvestment', 'OperatingExpense', 'Parameters', 'PLLineItems', 'ParamDefs', 'LineNotes', 'Actions', 'Snapshots'];
  var AUDIT_TABLE = 'AuditLog';
  var AUDIT_HEADERS = ['Timestamp', 'User', 'SheetName', 'RowID', 'Action', 'Payload'];

  // 依 ScenarioID 掛在情境底下的表，與各自的主鍵
  var SCENARIO_TABLES = {
    SalesMix: 'RowID', CostOfSales: 'RowID', DevInvestment: 'RowID', OperatingExpense: 'RowID', Parameters: 'ParamID',
    LineNotes: 'RowID', Actions: 'ActionID'
  };

  /**
   * 科目表依車型各自一份(VehicleTypeID)；留白的是標準範本。舊版資料包只有一份全域科目表(沒有 LineID)，
   * 視同「每個車型都用這一份」。回傳 { 車型: [科目列] }，車型沒有自己的科目表時用範本複製一份。
   */
  function lineIdOf_(typeId, code) { return (typeId || '*') + '|' + code; }
  function chartsByType_(rows, typeIds) {
    var legacy = rows.length && rows.every(function (r) { return !str_(r.LineID) && !str_(r.VehicleTypeID); });
    var template = rows.filter(function (r) { return !str_(r.VehicleTypeID); });
    var out = {};
    typeIds.forEach(function (id) {
      var own = legacy ? [] : rows.filter(function (r) { return str_(r.VehicleTypeID) === id; });
      if (!own.length) {
        own = template.map(function (r) {
          var c = clone_(r);
          c.VehicleTypeID = id;
          c.LineID = lineIdOf_(id, c.LineCode);
          return c;
        });
      }
      out[id] = own;
    });
    return out;
  }

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
      // 只帶這幾個車型自己的科目表(車型還沒有自己的一份時，帶它目前沿用的範本)
      PLLineItems: (function () {
        var charts = chartsByType_(tables.PLLineItems || [], Object.keys(types));
        return Object.keys(charts).reduce(function (all, id) { return all.concat(charts[id]); }, []);
      })(),
      ParamDefs: (tables.ParamDefs || []).slice(),
      // 情境快照跟著車型走(情境刪掉了快照仍保留，所以不是依情境篩)
      Snapshots: (tables.Snapshots || []).filter(function (r) { return types[str_(r.VehicleTypeID)]; })
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
   * 只留指定的情境：情境本身、掛在情境底下的資料、這些情境的快照；
   * 車型主檔、車系、科目表、全域參數照「整個車型」帶著，對方沒有這個車型時才建得起來。
   */
  function filterByScenarios(tables, scenarioIds) {
    var ids = set_(scenarioIds);
    var scenarios = (tables.Scenarios || []).filter(function (r) { return ids[str_(r.ScenarioID)]; });
    var typeIds = Object.keys(set_(scenarios.map(function (r) { return r.VehicleTypeID; })));
    var out = filterByVehicleTypes(tables, typeIds);
    out.Scenarios = scenarios;
    Object.keys(SCENARIO_TABLES).forEach(function (name) {
      out[name] = out[name].filter(function (r) { return ids[str_(r.ScenarioID)] || (name === 'Parameters' && !str_(r.ScenarioID)); });
    });
    out.Snapshots = out.Snapshots.filter(function (r) { return ids[str_(r.ScenarioID)]; });
    return out;
  }

  /**
   * 建立資料包。meta.scenarioIds 有值時只匯出這幾個情境；meta.vehicleTypeIds 有值時只匯出這幾個車型(一個人負責的範圍)；
   * 都沒有就是整份資料庫。
   */
  function buildPack(tables, meta) {
    meta = meta || {};
    var byScenario = meta.scenarioIds && meta.scenarioIds.length;
    var partial = byScenario || (meta.vehicleTypeIds && meta.vehicleTypeIds.length);
    var data = byScenario ? filterByScenarios(tables, meta.scenarioIds)
      : partial ? filterByVehicleTypes(tables, meta.vehicleTypeIds) : tables;
    var outTables = {};
    PACK_TABLES.forEach(function (n) { outTables[n] = clone_(data[n] || []); });
    if (!partial && data[AUDIT_TABLE] && data[AUDIT_TABLE].length) outTables[AUDIT_TABLE] = clone_(data[AUDIT_TABLE]);
    var typeIdsOf = function () { return (outTables.VehicleTypes || []).map(function (r) { return str_(r.VehicleTypeID); }); };
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      exportedAt: meta.exportedAt || new Date().toISOString(),
      exportedBy: meta.exportedBy || '',
      scope: byScenario
        ? { kind: 'scenarios', vehicleTypeIds: typeIdsOf(), scenarioIds: outTables.Scenarios.map(function (r) { return str_(r.ScenarioID); }) }
        : partial
          ? { kind: 'vehicleTypes', vehicleTypeIds: meta.vehicleTypeIds.map(str_) }
          : { kind: 'all', vehicleTypeIds: typeIdsOf() },
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

  /**
   * 合併匯入。回傳 { tables, report }，不修改傳進來的資料。
   *
   * 車型資料包(scope.kind 不是 'scenarios')：資料包裡有的車型，以資料包為準整個換掉(本機這幾個車型的車系、情境、
   * 科目表與所有輸入資料都會被取代)；資料包裡沒有的車型完全不動。對應「每個人負責自己的車型」：誰負責的車型，誰的資料包說了算。
   *
   * 情境資料包(scope.kind === 'scenarios')：只新增/更新資料包裡的情境(同一個情境代號 = 同一個情境，整個換成資料包的)，
   * 本機同車型的其他情境、車系、科目表都不動；本機沒有的車系、科目才補進來。本機根本沒有這個車型時，連同車型、車系、科目表一起新增。
   *
   * 科目表是跟著車型走的(每個車型各一份)，所以兩個人各自新增的科目就算拿到同一個代碼也不會互相干擾，
   * 不需要再逐一比對、改號。舊版資料包(只有一份全域科目表)的科目表，視為資料包裡每個車型各自的科目表。
   * 自訂參數(ParamDefs)是全域共用的：本機沒有的參數才加進來，同名參數保留本機的設定。
   */
  function mergePack(localTables, incomingTables, ctx, scope) {
    var local = clone_(localTables);
    var incoming = clone_(incomingTables);
    PACK_TABLES.concat([AUDIT_TABLE]).forEach(function (n) { local[n] = local[n] || []; incoming[n] = incoming[n] || []; });
    var byScenario = !!(scope && scope.kind === 'scenarios');

    var types = set_([].concat(
      incoming.VehicleTypes.map(function (r) { return r.VehicleTypeID; }),
      incoming.Vehicles.map(function (r) { return r.VehicleTypeID; }),
      incoming.Scenarios.map(function (r) { return r.VehicleTypeID; })
    ).filter(function (id) { return str_(id); }));
    var typeIds = Object.keys(types);
    var localTypes = set_(local.VehicleTypes.map(function (r) { return r.VehicleTypeID; })
      .concat(local.Scenarios.map(function (r) { return r.VehicleTypeID; })));

    var report = {
      mode: byScenario ? 'scenarios' : 'vehicleTypes',
      replacedTypes: [], addedTypes: [], chartsReplaced: [], paramDefsAdded: [],
      globalParamsAdded: 0, globalParamsKept: [], rowIdsReassigned: 0,
      replacedScenarios: [], addedScenarios: [], vehiclesAdded: [], linesAdded: [], lineNameConflicts: []
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
      if (owner && owner !== str_(r.VehicleTypeID) && (byScenario || !types[owner])) {
        throw new Error('車系代號「' + r.VehicleID + '」在本機屬於車型 ' + owner + '，資料包裡卻屬於車型 ' +
          r.VehicleTypeID + '。請先在其中一邊把車系改名後再合併。');
      }
    });
    var localScenarioType = {};
    local.Scenarios.forEach(function (r) { localScenarioType[str_(r.ScenarioID)] = str_(r.VehicleTypeID); });
    incoming.Scenarios.forEach(function (r) {
      var owner = localScenarioType[str_(r.ScenarioID)];
      if (owner && owner !== str_(r.VehicleTypeID) && (byScenario || !types[owner])) {
        throw new Error('情境代號「' + r.ScenarioID + '」同時出現在本機車型 ' + owner + ' 與資料包車型 ' + r.VehicleTypeID + '，無法合併。');
      }
    });

    // ---- 科目表、車型主檔、車系，以及要拿掉的本機情境 ----
    var incomingCharts = chartsByType_(incoming.PLLineItems, typeIds);
    var localTemplateEmpty = !local.PLLineItems.some(function (r) { return !str_(r.VehicleTypeID) && str_(r.LineID); });
    var dropScenarios;
    if (!byScenario) {
      // 車型資料包：這幾個車型整個換成資料包的
      local.PLLineItems = local.PLLineItems.filter(function (r) { return !types[str_(r.VehicleTypeID)]; });
      typeIds.forEach(function (id) {
        if (incomingCharts[id].length) report.chartsReplaced.push(id);
        local.PLLineItems = local.PLLineItems.concat(incomingCharts[id]);
      });
      dropScenarios = set_(local.Scenarios.filter(function (r) { return types[str_(r.VehicleTypeID)]; })
        .map(function (r) { return r.ScenarioID; }));
      local.VehicleTypes = local.VehicleTypes.filter(function (r) { return !types[str_(r.VehicleTypeID)]; });
      local.Vehicles = local.Vehicles.filter(function (r) { return !types[str_(r.VehicleTypeID)]; });
      local.VehicleTypes = local.VehicleTypes.concat(incoming.VehicleTypes);
      local.Vehicles = local.Vehicles.concat(incoming.Vehicles);
    } else {
      // 情境資料包：本機沒有的車型整個新增；本機已有的車型只補本機缺的車系、科目
      var localCharts = chartsByType_(local.PLLineItems, typeIds.filter(function (id) { return localTypes[id]; }));
      typeIds.forEach(function (id) {
        if (!localTypes[id]) {
          local.VehicleTypes = local.VehicleTypes.concat(incoming.VehicleTypes.filter(function (r) { return str_(r.VehicleTypeID) === id; }));
          local.Vehicles = local.Vehicles.concat(incoming.Vehicles.filter(function (r) { return str_(r.VehicleTypeID) === id; }));
          local.PLLineItems = local.PLLineItems.concat(incomingCharts[id]);
          return;
        }
        // 本機這個車型還在沿用範本(沒有自己的一份)：先把範本複製成它自己的，才補得進科目
        if (!local.PLLineItems.some(function (r) { return str_(r.VehicleTypeID) === id; })) local.PLLineItems = local.PLLineItems.concat(localCharts[id]);
        var byCode = {};
        localCharts[id].forEach(function (r) { byCode[str_(r.LineCode)] = r; });
        incomingCharts[id].forEach(function (r) {
          var mine = byCode[str_(r.LineCode)];
          if (!mine) {
            local.PLLineItems.push(r);
            report.linesAdded.push({ VehicleTypeID: id, LineCode: str_(r.LineCode), LineName: str_(r.LineName) });
          } else if (str_(mine.LineName) !== str_(r.LineName)) {
            report.lineNameConflicts.push({ VehicleTypeID: id, LineCode: str_(r.LineCode), local: str_(mine.LineName), incoming: str_(r.LineName) });
          }
        });
        var haveVehicle = set_(local.Vehicles.map(function (r) { return r.VehicleID; }));
        incoming.Vehicles.filter(function (r) { return str_(r.VehicleTypeID) === id && !haveVehicle[str_(r.VehicleID)]; }).forEach(function (r) {
          local.Vehicles.push(r);
          report.vehiclesAdded.push({ VehicleTypeID: id, VehicleID: str_(r.VehicleID), VehicleCode: str_(r.VehicleCode) });
        });
      });
      dropScenarios = set_(incoming.Scenarios.map(function (r) { return r.ScenarioID; }));
      incoming.Scenarios.forEach(function (r) {
        var entry = { VehicleTypeID: str_(r.VehicleTypeID), ScenarioID: str_(r.ScenarioID), label: scenarioLabel_(r) };
        (localScenarioType[str_(r.ScenarioID)] ? report.replacedScenarios : report.addedScenarios).push(entry);
      });
    }
    // 本機還是全新資料庫(沒有範本)時，順便把資料包的範本帶進來
    if (localTemplateEmpty) {
      incoming.PLLineItems.filter(function (r) { return !str_(r.VehicleTypeID) && str_(r.LineID); })
        .forEach(function (r) { local.PLLineItems.push(r); });
    }
    var localParams = set_(local.ParamDefs.map(function (r) { return r.ParamName; }));
    incoming.ParamDefs.forEach(function (r) {
      if (localParams[str_(r.ParamName)]) return;
      localParams[str_(r.ParamName)] = true;
      local.ParamDefs.push(r);
      report.paramDefsAdded.push(str_(r.ParamName));
    });

    // ---- 情境：拿掉本機要被取代的，放進資料包的 ----
    local.Scenarios = local.Scenarios.filter(function (r) { return !dropScenarios[str_(r.ScenarioID)]; }).concat(incoming.Scenarios);
    Object.keys(SCENARIO_TABLES).forEach(function (name) {
      local[name] = local[name].filter(function (r) { return !dropScenarios[str_(r.ScenarioID)]; });
    });
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

    // ---- 情境快照是歷史紀錄：兩邊都留(同一個快照代號只留一份)，不因為換掉車型資料就消失 ----
    var snapIds = set_(local.Snapshots.map(function (r) { return r.SnapshotID; }));
    report.snapshotsAdded = 0;
    incoming.Snapshots.forEach(function (r) {
      if (snapIds[str_(r.SnapshotID)]) return;
      snapIds[str_(r.SnapshotID)] = true;
      local.Snapshots.push(r);
      report.snapshotsAdded++;
    });

    // ---- 稽核紀錄：兩邊都留，去掉完全相同的列 ----
    var seen = set_(local[AUDIT_TABLE].map(function (r) { return JSON.stringify(r); }));
    incoming[AUDIT_TABLE].forEach(function (r) {
      var key = JSON.stringify(r);
      if (!seen[key]) { seen[key] = true; local[AUDIT_TABLE].push(r); }
    });

    return { tables: local, report: report };
  }
  function scenarioLabel_(r) {
    return [str_(r.Gate), str_(r.ScenarioName)].filter(function (x) { return x; }).join(' ') + (str_(r.ScenarioType) ? '（' + str_(r.ScenarioType) + '）' : '');
  }

  /** 合併結果寫成給使用者確認的文字 */
  function describeMerge(report) {
    var lines = [];
    function counts(s) { return s ? s.vehicles + ' 個車系、' + s.scenarios + ' 個情境' : '無資料'; }
    if (report.mode === 'scenarios') {
      report.replacedScenarios.forEach(function (s) {
        lines.push('・車型 ' + s.VehicleTypeID + ' 的情境「' + s.label + '」：本機已有，會被資料包的版本取代');
      });
      report.addedScenarios.forEach(function (s) {
        lines.push('・車型 ' + s.VehicleTypeID + ' 的情境「' + s.label + '」：新增');
      });
      report.addedTypes.forEach(function (t) {
        lines.push('・車型 ' + t.VehicleTypeID + '：本機沒有這個車型，連同車型、' + t.incoming.vehicles + ' 個車系與科目表一起新增');
      });
      if (report.replacedTypes.length) lines.push('・本機同車型的其他情境、車系、科目表都不動');
      if (report.vehiclesAdded.length) {
        lines.push('・補上本機沒有的車系：' + report.vehiclesAdded.map(function (v) { return v.VehicleTypeID + ' ' + (v.VehicleCode || v.VehicleID); }).join('、'));
      }
      if (report.linesAdded.length) {
        lines.push('・補上本機科目表沒有的科目：' + report.linesAdded.map(function (l) { return l.VehicleTypeID + ' ' + l.LineName + '(' + l.LineCode + ')'; }).join('、'));
      }
      report.lineNameConflicts.forEach(function (c) {
        lines.push('・⚠ 車型 ' + c.VehicleTypeID + ' 的科目代碼 ' + c.LineCode + ' 兩邊名稱不同（本機「' + c.local + '」、資料包「' + c.incoming +
          '」），這一列的數字會記在本機的「' + c.local + '」');
      });
    } else {
      report.replacedTypes.forEach(function (t) {
        lines.push('・車型 ' + t.VehicleTypeID + '：本機的資料（' + counts(t.local) + '）會被資料包（' + counts(t.incoming) + '）取代');
      });
      report.addedTypes.forEach(function (t) {
        lines.push('・車型 ' + t.VehicleTypeID + '：新增（' + counts(t.incoming) + '）');
      });
      if (report.chartsReplaced.length) {
        lines.push('・科目表跟著車型一起換成資料包的版本：' + report.chartsReplaced.join('、') + '（其他車型的科目表不受影響）');
      }
    }
    if (report.snapshotsAdded) lines.push('・新增 ' + report.snapshotsAdded + ' 份情境快照（本機原有的快照保留）');
    if (report.paramDefsAdded.length) {
      lines.push('・新增自訂參數：' + report.paramDefsAdded.join('、'));
    }
    report.globalParamsKept.forEach(function (p) {
      lines.push('・全域參數「' + p.ParamName + '」兩邊不同，保留本機的值 ' + p.local + '（資料包是 ' + p.incoming + '）');
    });
    return lines.join('\n');
  }

  return {
    FORMAT: FORMAT, FORMAT_VERSION: FORMAT_VERSION, PACK_TABLES: PACK_TABLES,
    AUDIT_TABLE: AUDIT_TABLE, AUDIT_HEADERS: AUDIT_HEADERS,
    buildPack: buildPack, parsePack: parsePack, filterByVehicleTypes: filterByVehicleTypes, filterByScenarios: filterByScenarios,
    scenarioLabel: scenarioLabel_,
    mergePack: mergePack, describeMerge: describeMerge, summarize: summarize
  };
}));
