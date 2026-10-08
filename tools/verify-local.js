/**
 * 驗證地端版(dist/FS-local.html 的後端部分)：
 *
 *   node tools/verify-local.js
 *
 * 1. 算出來的數字跟 Node 驗算層一模一樣 —— 同一組 Gate F 資料，分別用 Node 驗算層(tools/fake-apps-script.js)
 *    和地端版主機(local/host.js，走跟瀏覽器完全相同的 google.script.run 呼叫路徑)跑一次，逐格比對
 * 2. 瀏覽器暫存：關掉重開(用同一份 storage 建新主機)資料還在、數字不變
 * 3. 資料包：整份匯出 → 匯入另一台全新的主機，數字不變；只匯出某個車型時只帶那個車型的資料
 * 4. 合併匯入：兩個人各自負責不同車型、各自新增了代碼相同的自訂科目 → 合併後科目自動改號、
 *    金額跟著改過去、雙方的數字都不變；重複合併同一包不會長出重複資料；代號衝突會擋下來
 * 5. 其他保護：私有函式不能從前端呼叫、另一個分頁改過資料後這一頁停止寫入、壞掉的資料包有清楚的錯誤
 * 6. dist/FS-local.html 是最新的(改了原始檔卻忘了重新 build 會在這裡被抓到)
 */
const fs = require('fs');
const { loadAppsScript } = require('./fake-apps-script');
const gatef = require('./verify-gatef');
const build = require('./build-local');
const Shim = require('../local/gas-shim.js');
const Pack = require('../local/pack.js');
const Host = require('../local/host.js');

const failures = [];
let checks = 0;
function assert(cond, message) { checks++; if (!cond) failures.push(message); }
function throws(fn, pattern, message) {
  checks++;
  try { fn(); } catch (e) {
    if (pattern && !pattern.test(e.message)) failures.push(message + '（錯誤訊息不對：' + e.message + '）');
    return;
  }
  failures.push(message + '（沒有丟出錯誤）');
}

const factory = build.loadBackendFactory();

function memoryStorage() {
  const map = {};
  return { getItem: k => (k in map ? map[k] : null), setItem: (k, v) => { map[k] = String(v); }, map };
}
let uuidSeq = 0;
function newHost(storage, user) {
  const host = Host.createHost({
    factory, shim: Shim, pack: Pack, storage,
    getUser: () => user || '測試者',
    getUuid: () => 'u' + String(++uuidSeq).padStart(7, '0') + '-0000-0000-0000-000000000000'
  });
  host.start();
  return host;
}
/** 跟前端一樣透過 host.call 呼叫(參數與回傳值都走 JSON)，介面長得像 gs.xxx() 方便沿用 verify-gatef 的建資料流程 */
function apiOf(host) {
  return new Proxy({}, { get: (_, name) => (...args) => host.call(name, args) });
}
/**
 * 比較結果的「數字部分」：欄位標題 + 每個科目的金額，排除 ID/時間這些每次不同的東西。
 * byName：用科目名稱當鍵(合併後科目可能改號)，並略過金額為 0 的科目 —— 科目表是全域的，
 * 合併進別人新增的自訂科目後，自己車型的損益表會多一列 0，這是預期行為，不是數字變了。
 */
function numbers(comparison, byName) {
  const nameOf = {};
  comparison.lines.forEach(l => { nameOf[l.LineCode] = l.LineName; });
  return comparison.columns.map(c => {
    const amounts = {};
    Object.keys(c.amounts).sort().forEach(code => {
      if (byName && !c.amounts[code]) return;
      amounts[byName ? nameOf[code] || code : code] = Math.round(c.amounts[code] * 1e6) / 1e6;
    });
    const sorted = {};
    Object.keys(amounts).sort().forEach(k => { sorted[k] = amounts[k]; });
    return { label: c.label, amounts: sorted, checks: c.checks.length };
  });
}
function compareAll(api) {
  const opts = api.getComparisonOptions();
  const sels = [];
  JSON.parse(JSON.stringify(opts)).forEach(t => (t.scenarios || []).forEach(s => {
    (t.vehicles || []).forEach(v => sels.push({ ScenarioID: s.ScenarioID, VehicleID: v.VehicleID }));
    sels.push({ ScenarioID: s.ScenarioID, VehicleID: '' });
  }));
  return api.calculateComparison(sels);
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ---- 0. getComparisonOptions 的形狀(compareAll 依賴它)----------------------------------------- */
{
  const host = newHost(null);
  const api = apiOf(host);
  gatef.buildScenario(api);
  const opts = api.getComparisonOptions();
  assert(Array.isArray(opts) && opts[0] && Array.isArray(opts[0].scenarios) && Array.isArray(opts[0].vehicles),
    'getComparisonOptions() 的結構跟這支驗證腳本預期的不同，請更新 compareAll()：' + JSON.stringify(opts).slice(0, 200));
}

/* ---- 1. 地端版與 Node 驗算層算出來的數字完全相同 -------------------------------------------- */
const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs', 'XlsxWriter.gs', 'VerifyWorkbook.gs', 'VerifyImport.gs']);
const sidRef = gatef.buildScenario(gs);
const refSel = gatef.VEHICLES.map(v => ({ ScenarioID: sidRef, VehicleID: v.id })).concat([{ ScenarioID: sidRef, VehicleID: '' }]);
const reference = numbers(gs.calculateComparison(refSel));

const storageA = memoryStorage();
const hostA = newHost(storageA, '小明');
const apiA = apiOf(hostA);
const sidA = gatef.buildScenario(apiA);
const selA = gatef.VEHICLES.map(v => ({ ScenarioID: sidA, VehicleID: v.id })).concat([{ ScenarioID: sidA, VehicleID: '' }]);
const localNumbers = numbers(apiA.calculateComparison(selA));
assert(same(localNumbers, reference), '地端版算出的 Gate F 數字跟 Node 驗算層不同');
assert(reference[0].amounts.K !== undefined && reference.length === 4, 'Gate F 比較結果不完整（沒有營業淨利 K 或欄數不對）');
assert(localNumbers.every(c => c.checks === 0), '地端版小計驗算有對不起來的項目');

/* ---- 2. 瀏覽器暫存 ------------------------------------------------------------------------------- */
assert(hostA.state.changesSinceExport > 0, '存了資料，但「尚未匯出的修改」計數沒有增加');
const before = hostA.state.changesSinceExport;
apiA.calculateComparison(selA);
apiA.calculatePLAllVehicles(sidA);   // 會寫 PLResult 快照，但那不算使用者改資料
assert(hostA.state.changesSinceExport === before, '只是看儀表板/重算(寫 PLResult 快照)也被算成一次修改');
const saved = JSON.parse(storageA.getItem(Host.STORAGE_KEY));
assert(saved && saved.tables && !saved.tables.PLResult, '暫存裡不該有 PLResult（計算快照可重算）');
assert(saved.tables.AuditLog.length > 0 && saved.tables.AuditLog.every(r => r.User === '小明'), '稽核紀錄沒有記到地端版使用者名稱');

const hostA2 = newHost(storageA);
assert(same(numbers(apiOf(hostA2).calculateComparison(selA)), reference), '關掉重開(從暫存載入)後數字變了');
assert(hostA2.state.changesSinceExport === hostA.state.changesSinceExport, '重開後「尚未匯出的修改」計數沒有延續');

// 前導零：情境名稱 0901 不能變成 901；數字欄位的數字字串要比照 Sheets 轉成數字
const sc0901 = apiA.createScenarioFrom({ ScenarioID: '', Gate: 'GATE E', ScenarioName: '0901', ScenarioType: '現況', VehicleTypeID: 'DA' }, '', []);
apiA.saveSalesMixGrid(sc0901.ScenarioID, 'DA', [{ RowID: '', VehicleID: 'V1', SalesMixPct: '100', MonthlyVolume: '20', LifeCycleYears: '12', ListPriceTaxIncl: '1000000', ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }]);
const reopened = apiOf(newHost(storageA));
const sc0901Back = reopened.getScenarios('DA').filter(s => s.ScenarioID === sc0901.ScenarioID)[0];
assert(sc0901Back && sc0901Back.ScenarioName === '0901', '情境名稱 0901 的前導零在暫存來回後不見了：' + (sc0901Back && sc0901Back.ScenarioName));
const mix = reopened.getSalesMix(sc0901.ScenarioID)[0];
assert(mix && mix.MonthlyVolume === 20 && typeof mix.MonthlyVolume === 'number', '數字欄位的數字字串沒有比照 Sheets 轉成數字');
apiA.deleteScenario(sc0901.ScenarioID);

/* ---- 3. 資料包：整份匯出 / 匯入 ------------------------------------------------------------------- */
const fullPack = Pack.parsePack(JSON.stringify(hostA.exportPack(null)));
assert(hostA.state.changesSinceExport === 0 && hostA.state.lastExportAt, '整份匯出後沒有清掉「尚未匯出的修改」');
assert(fullPack.scope.kind === 'all' && fullPack.tables.CostOfSales.length > 0, '整份資料包內容不完整');
const hostB = newHost(memoryStorage());
hostB.replaceWithPack(fullPack);
assert(same(numbers(apiOf(hostB).calculateComparison(selA)), reference), '資料包匯入另一台主機後數字變了');

// 資料庫裡只有這一個車型時，「匯出車型」匯出的就是全部，也算整份備份過了
apiA.saveVehicleType({ VehicleTypeID: 'DA', Notes: '只有一個車型時的匯出' });
assert(hostA.state.changesSinceExport > 0, '改了資料，計數應該增加');
const onlyTypes = hostA.readTables().VehicleTypes.map(r => r.VehicleTypeID);
hostA.exportPack(onlyTypes);
assert(onlyTypes.length === 1 && hostA.state.changesSinceExport === 0, '只有一個車型時，匯出車型應該算整份備份：' + onlyTypes.join());

// 加一個車型 DE(另一個人負責)，用來測只匯出單一車型
apiA.saveVehicleType({ VehicleTypeID: 'DE', Notes: '' });
apiA.saveVehicle({ VehicleID: 'DE1', VehicleTypeID: 'DE', VehicleCode: '5人休旅' });
const deSc = apiA.createScenarioFrom({ ScenarioID: '', Gate: 'GATE E', ScenarioName: '1015', ScenarioType: '現況', VehicleTypeID: 'DE' }, '', []);
apiA.saveSalesMixGrid(deSc.ScenarioID, 'DE', [{ RowID: '', VehicleID: 'DE1', SalesMixPct: 100, MonthlyVolume: 300, LifeCycleYears: 8, ListPriceTaxIncl: 1450000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }]);
apiA.saveCostOfSalesMatrix(deSc.ScenarioID, [{ RowID: '', VehicleID: 'DE1', LineCode: 'b1', Amount: 650000, Currency: 'TWD' }]);
const dePack = hostA.exportPack(['DE']);
assert(dePack.scope.kind === 'vehicleTypes' && same(dePack.scope.vehicleTypeIds, ['DE']), '單一車型資料包的範圍標示不對');
assert(same(dePack.tables.VehicleTypes.map(r => r.VehicleTypeID), ['DE']), '單一車型資料包帶到了別的車型');
assert(dePack.tables.Vehicles.every(r => r.VehicleTypeID === 'DE'), '單一車型資料包帶到了別的車型的車系');
assert(dePack.tables.SalesMix.every(r => r.ScenarioID === deSc.ScenarioID) && dePack.tables.SalesMix.length === 1, '單一車型資料包帶到了別的情境的銷售構成');
assert(dePack.tables.PLLineItems.length > 30 && dePack.tables.PLLineItems.every(r => r.VehicleTypeID === 'DE'), '單一車型資料包要帶這個車型自己的科目表');
assert(hostA.state.changesSinceExport > 0, '只匯出單一車型不該被當成「整份備份過了」');

/* ---- 4. 合併匯入 --------------------------------------------------------------------------------- */
// 小明(hostM)負責 DA，在 DA 的科目表新增「運費」；小華(hostH)負責 DX，在 DX 的科目表先後新增「關稅」「運費」。
// 科目表跟著車型走：兩邊拿到同一個代碼也互不干擾，合併時不需要改號。
const hostM = newHost(memoryStorage(), '小明');
const apiM = apiOf(hostM);
const sidM = gatef.buildScenario(apiM);
apiM.getBootstrap('DA');
const freightM = apiM.addLineItemInline('B', '運費', 'DA');
apiM.saveCostOfSalesMatrix(sidM, [{ RowID: '', VehicleID: 'V1', LineCode: freightM.LineCode, Amount: 1234, Currency: 'TWD' }]);
const selM = gatef.VEHICLES.map(v => ({ ScenarioID: sidM, VehicleID: v.id })).concat([{ ScenarioID: sidM, VehicleID: '' }]);
const mBefore = numbers(apiM.calculateComparison(selM), true);
const codeOf = (api, type, name) => api.getPLLineItems(type).filter(d => d.LineName === name)[0].LineCode;
const daChartBefore = JSON.stringify(apiM.getPLLineItems('DA'));

const hostH = newHost(memoryStorage(), '小華');
const apiH = apiOf(hostH);
apiH.createVehicleType('DX', '', '');
apiH.saveVehicle({ VehicleID: 'DX1', VehicleTypeID: 'DX', VehicleCode: '電動廂車' });
const dxSc = apiH.createScenarioFrom({ ScenarioID: '', Gate: 'GATE D', ScenarioName: '現況', ScenarioType: '現況', VehicleTypeID: 'DX' }, '', []);
apiH.saveSalesMixGrid(dxSc.ScenarioID, 'DX', [{ RowID: '', VehicleID: 'DX1', SalesMixPct: 100, MonthlyVolume: 100, LifeCycleYears: 6, ListPriceTaxIncl: 1800000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }]);
apiH.addLineItemInline('B', '關稅', 'DX');
apiH.addLineItemInline('B', '運費', 'DX');
const dutyCodeH = codeOf(apiH, 'DX', '關稅');
const freightCodeH = codeOf(apiH, 'DX', '運費');
assert(dutyCodeH === freightM.LineCode, '測試前提不成立：小華的「關稅」應該跟小明的「運費」是同一個代碼（' + dutyCodeH + ' vs ' + freightM.LineCode + '）');
apiH.saveParamDef({ ParamName: '關稅率', Unit: '%', DefaultValue: 13 });
apiH.saveDevInvestmentGrid(dxSc.ScenarioID, [{ RowID: '', Department: '生技部', AssetType: '模具', TargetLineCode: 'b5', Amount: 6000000, Currency: 'TWD' }]);
apiH.saveCostOfSalesMatrix(dxSc.ScenarioID, [
  { RowID: '', VehicleID: 'DX1', LineCode: 'b1', Amount: 900000, Currency: 'TWD' },
  { RowID: '', VehicleID: 'DX1', LineCode: dutyCodeH, Amount: 50000, Currency: 'TWD' },
  { RowID: '', VehicleID: 'DX1', LineCode: freightCodeH, Amount: 7000, Currency: 'TWD' }
]);
apiH.saveActions(dxSc.ScenarioID, [{ Title: '關稅低減', LineCode: dutyCodeH, Effect: 5000 }]);
const selH = [{ ScenarioID: dxSc.ScenarioID, VehicleID: 'DX1' }, { ScenarioID: dxSc.ScenarioID, VehicleID: '' }];
const hBefore = numbers(apiH.calculateComparison(selH), true);
const dxPack = Pack.parsePack(JSON.stringify(hostH.exportPack(['DX'])));

const preview = hostM.previewMerge(dxPack);
assert(same(hostM.readTables().VehicleTypes.map(r => r.VehicleTypeID), ['DA']), '預覽合併不該改到資料');
const report = hostM.mergePack(dxPack);
assert(same(report, preview.report), '預覽與實際合併的結果不同');
assert(report.addedTypes.length === 1 && report.addedTypes[0].VehicleTypeID === 'DX' && report.replacedTypes.length === 0, '合併報告的車型不對');
assert(same(report.chartsReplaced, ['DX']), '合併報告沒有列出換掉的科目表：' + JSON.stringify(report.chartsReplaced));
assert(same(report.paramDefsAdded, ['關稅率']), '自訂參數沒有帶進來');
assert(/科目表/.test(Pack.describeMerge(report)), '合併說明沒有提到科目表');

assert(JSON.stringify(apiM.getPLLineItems('DA')) === daChartBefore, '合併別人的車型後，自己車型(DA)的科目表變了');
assert(same(numbers(apiM.calculateComparison(selM), true), mBefore), '合併別人的車型後，自己車型(DA)的數字變了');
assert(same(numbers(apiM.calculateComparison(selH), true), hBefore), '合併進來的車型(DX)數字跟對方原本的不同');
assert(codeOf(apiM, 'DX', '關稅') === dutyCodeH && codeOf(apiM, 'DA', '運費') === freightM.LineCode, '同一個代碼在兩個車型各自代表自己的科目');
assert(apiM.getActions(dxSc.ScenarioID).length === 1, '改善作法沒有跟著車型帶進來');

// 小華後來又改了數字，重新給一包：同一個車型以新的資料包為準，不會出現重複的列或重複的科目
apiH.saveCostOfSalesMatrix(dxSc.ScenarioID, [{ RowID: apiH.getCostOfSalesMatrix(dxSc.ScenarioID, 'DX').values.b1.DX1.RowID, VehicleID: 'DX1', LineCode: 'b1', Amount: 880000, Currency: 'TWD' }]);
const hAfter = numbers(apiH.calculateComparison(selH), true);
const lineCountBefore = apiM.getPLLineItems('DX').length;
const report2 = hostM.mergePack(Pack.parsePack(JSON.stringify(hostH.exportPack(['DX']))));
assert(report2.replacedTypes.length === 1 && report2.addedTypes.length === 0, '第二次合併同一個車型應該是「取代」');
assert(apiM.getPLLineItems('DX').length === lineCountBefore, '重複合併長出了重複的科目');
assert(same(numbers(apiM.calculateComparison(selH), true), hAfter), '第二次合併後 DX 的數字沒有更新成新的');
assert(hostM.readTables().CostOfSales.filter(r => r.ScenarioID === dxSc.ScenarioID).length === 3, '重複合併後 DX 的成本列重複了');
assert(same(numbers(apiM.calculateComparison(selM), true), mBefore), '第二次合併後 DA 的數字變了');

// 兩個人都有「關稅率」但預設值不同：合併進來的車型要算出跟對方電腦上一樣的數字(沒填的情境直接填上對方的預設值)
{
  const hostP = newHost(memoryStorage());
  const apiP = apiOf(hostP);
  apiP.getBootstrap('');
  apiP.saveParamDef({ ParamName: '關稅率', Unit: '%', DefaultValue: 1, Description: '本機自己的' });
  const r = hostP.mergePack(Pack.parsePack(JSON.stringify(hostH.exportPack(['DX']))));
  const pinned = (r.paramDefaultsPinned || [])[0];
  const hDef = apiH.getParamDefs().find(d => d.ParamName === '關稅率');
  {
    assert(Number(hDef.DefaultValue) === 13 && pinned && pinned.ParamName === '關稅率', '預設值不同的參數應該列在合併報告：' + JSON.stringify(r.paramDefaultsPinned));
    assert(/預設值不同/.test(Pack.describeMerge(r)), '合併說明沒有提到預設值不同');
  }
  const row = hostP.readTables().Parameters.find(x => x.ScenarioID === dxSc.ScenarioID && x.ParamName === '關稅率' && !x.VehicleID);
  assert(row && Number(row.Value) === 13, '資料包裡沒填關稅率的情境，應該直接填上對方的預設值 13（公式用到時才會跟對方一樣）：' + JSON.stringify(row));
  assert(same(numbers(apiP.calculateComparison(selH), true), hAfter), '參數預設值不同時，合併進來的車型數字要跟對方一樣');
  assert(apiP.getParamDefs().find(d => d.ParamName === '關稅率').DefaultValue == 1, '同名參數保留本機的定義');
}

// 舊版資料包(只有一份全域科目表、沒有 LineID)合併進來：科目表視為資料包裡那個車型自己的
{
  const legacyTables = JSON.parse(JSON.stringify(hostH.exportPack(['DX']).tables));
  legacyTables.PLLineItems = legacyTables.PLLineItems.map(r => Object.assign({}, r, { LineID: '', VehicleTypeID: '' }));
  const hostL = newHost(memoryStorage());
  apiOf(hostL).getBootstrap('');
  hostL.mergePack(Pack.parsePack({ format: Pack.FORMAT, formatVersion: 1, tables: legacyTables }));
  assert(same(numbers(apiOf(hostL).calculateComparison(selH), true), hAfter), '舊版資料包合併後 DX 的數字不同');
  assert(apiOf(hostL).getPLLineItems('DX').some(d => d.LineName === '關稅'), '舊版資料包的自訂科目沒有成為 DX 的科目');
}

// 暫存空間快滿：先縮短稽核紀錄再存，真正的資料要存得進去
{
  const big = memoryStorage();
  const hostQ = newHost(big);
  const apiQ = apiOf(hostQ);
  apiQ.getBootstrap('');
  apiQ.createVehicleType('QT', '', '');
  for (let i = 0; i < 40; i++) apiQ.saveVehicleGrid('QT', [{ VehicleID: 'QT1', VehicleCode: '名稱' + i }]);   // 灌一堆稽核紀錄
  const full = big.map[Object.keys(big.map)[0]].length;
  const audit = hostQ.readTables().AuditLog.length;
  const limit = full - 2000;   // 再多存一點就爆，但拿掉稽核紀錄就放得下
  big.setItem = (k, v) => { if (String(v).length > limit) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } big.map[k] = String(v); };
  apiQ.saveVehicleGrid('QT', [{ VehicleID: 'QT1', VehicleCode: '空間快滿' }]);
  assert(hostQ.state.storageOk && hostQ.state.auditTrimmed, '暫存快滿時應該縮短稽核紀錄後存成功：' + JSON.stringify({ ok: hostQ.state.storageOk, trimmed: hostQ.state.auditTrimmed, audit }));
  const hostQ2 = newHost(big);
  assert(apiOf(hostQ2).getVehicles('QT')[0].VehicleCode === '空間快滿', '縮短稽核紀錄後，資料要真的存進暫存');
}

// 合併結果要能存進暫存、重開後還在
const mStorage = memoryStorage();
const hostM2 = newHost(mStorage);
hostM2.replaceWithPack(Pack.parsePack(JSON.stringify(hostM.exportPack(null))));
assert(same(numbers(apiOf(newHost(mStorage)).calculateComparison(selH), true), hAfter), '合併後的資料重開後不見了');

// 代號衝突：資料包裡的車系代號在本機屬於別的車型
const hostX = newHost(memoryStorage());
const apiX = apiOf(hostX);
apiX.saveVehicleType({ VehicleTypeID: 'DZ', Notes: '' });
apiX.saveVehicle({ VehicleID: 'V1', VehicleTypeID: 'DZ', VehicleCode: '撞名車系' });
throws(() => hostM.previewMerge(Pack.parsePack(JSON.stringify(hostX.exportPack(['DZ'])))), /V1/, '車系代號跟本機其他車型衝突時應該擋下合併');

// 情境資料包：只新增/更新那一個情境，本機同車型的其他情境(包括自己另外建的)、車系、科目表都不動
{
  // 小明在合併進來的 DX 底下自己另外建了一個試算情境
  const mineSc = apiM.createScenarioFrom({ ScenarioID: '', Gate: 'GATE D', ScenarioName: '小明試算', ScenarioType: '現況', VehicleTypeID: 'DX' }, dxSc.ScenarioID, []);
  const selMine = [{ ScenarioID: mineSc.ScenarioID, VehicleID: 'DX1' }, { ScenarioID: mineSc.ScenarioID, VehicleID: '' }];
  const mineBefore = numbers(apiM.calculateComparison(selMine), true);
  const dxCostRows = hostM.readTables().CostOfSales.filter(r => r.ScenarioID === dxSc.ScenarioID).length;
  // 小華新增一個目標情境：多一個車系 DX2、科目表多一個「保險」
  apiH.saveVehicle({ VehicleID: 'DX2', VehicleTypeID: 'DX', VehicleCode: '電動客車' });
  const ins = apiH.addLineItemInline('B', '保險', 'DX');
  const tgt = apiH.createScenarioFrom({ ScenarioID: '', Gate: 'GATE D', ScenarioName: '目標', ScenarioType: '目標', VehicleTypeID: 'DX' }, dxSc.ScenarioID, []);
  apiH.saveSalesMixGrid(tgt.ScenarioID, 'DX', [
    { RowID: '', VehicleID: 'DX1', SalesMixPct: 60, MonthlyVolume: 60, LifeCycleYears: 6, ListPriceTaxIncl: 1800000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' },
    { RowID: '', VehicleID: 'DX2', SalesMixPct: 40, MonthlyVolume: 40, LifeCycleYears: 6, ListPriceTaxIncl: 2100000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }]);
  apiH.saveCostOfSalesMatrix(tgt.ScenarioID, [{ RowID: '', VehicleID: 'DX2', LineCode: ins.LineCode, Amount: 4321, Currency: 'TWD' }]);
  const selT = [{ ScenarioID: tgt.ScenarioID, VehicleID: 'DX1' }, { ScenarioID: tgt.ScenarioID, VehicleID: 'DX2' }, { ScenarioID: tgt.ScenarioID, VehicleID: '' }];
  const tH = numbers(apiH.calculateComparison(selT), true);

  const scPack = Pack.parsePack(JSON.stringify(hostH.exportPack(null, { scenarioIds: [tgt.ScenarioID] })));
  assert(scPack.scope.kind === 'scenarios' && same(scPack.scope.scenarioIds, [tgt.ScenarioID]) && scPack.tables.Scenarios.length === 1, '情境資料包只該有那一個情境');
  assert(scPack.tables.CostOfSales.every(r => r.ScenarioID === tgt.ScenarioID), '情境資料包不該帶到其他情境的輸入資料');
  assert(hostH.state.changesSinceExport > 0, '只匯出一個情境不該被當成「整份備份過了」');
  const r = hostM.mergePack(scPack);
  assert(r.mode === 'scenarios' && r.addedScenarios.length === 1 && r.replacedScenarios.length === 0, '情境合併報告不對：' + JSON.stringify(r.addedScenarios));
  assert(same(r.vehiclesAdded.map(v => v.VehicleID), ['DX2']) && r.linesAdded.some(l => l.LineName === '保險'), '本機缺的車系、科目要補上');
  assert(/新增/.test(Pack.describeMerge(r)) && /其他情境/.test(Pack.describeMerge(r)), '情境合併說明要講清楚其他情境不動：' + Pack.describeMerge(r));
  assert(apiM.getScenarios('DX').length === 3, '情境合併後 DX 應該有原本 2 個 + 新的 1 個情境');
  assert(same(numbers(apiM.calculateComparison(selMine), true), mineBefore), '情境合併不該動到本機自己建的情境');
  assert(hostM.readTables().CostOfSales.filter(x => x.ScenarioID === dxSc.ScenarioID).length === dxCostRows, '情境合併不該動到同車型其他情境的資料');
  assert(same(numbers(apiM.calculateComparison(selT), true), tH), '合併進來的情境數字跟對方原本的不同');
  assert(same(numbers(apiM.calculateComparison(selM), true), mBefore), '情境合併後 DA 的數字變了');

  // 小華改了數字再給一包：同一個情境取代，不會重複
  apiH.saveCostOfSalesMatrix(tgt.ScenarioID, [{ RowID: '', VehicleID: 'DX1', LineCode: 'b1', Amount: 777777, Currency: 'TWD' }]);
  const tH2 = numbers(apiH.calculateComparison(selT), true);
  const r2 = hostM.mergePack(Pack.parsePack(JSON.stringify(hostH.exportPack(null, { scenarioIds: [tgt.ScenarioID] }))));
  assert(r2.replacedScenarios.length === 1 && r2.addedScenarios.length === 0 && r2.linesAdded.length === 0 && r2.vehiclesAdded.length === 0, '第二次合併同一個情境應該是「取代」，不再補車系科目');
  assert(apiM.getScenarios('DX').length === 3 && same(numbers(apiM.calculateComparison(selT), true), tH2), '第二次情境合併後數字要更新、情境不重複');
  assert(same(numbers(apiM.calculateComparison(selMine), true), mineBefore), '第二次情境合併也不該動到本機自己建的情境');

  // 本機沒有這個車型：連同車型、車系、科目表一起新增
  const hostE = newHost(memoryStorage());
  apiOf(hostE).getBootstrap('');
  const rE = hostE.mergePack(Pack.parsePack(JSON.stringify(hostH.exportPack(null, { scenarioIds: [tgt.ScenarioID] }))));
  assert(rE.addedTypes.length === 1 && apiOf(hostE).getScenarios('DX').length === 1, '本機沒有的車型要整個新增，但只有那一個情境');
  assert(same(numbers(apiOf(hostE).calculateComparison(selT), true), tH2), '新增車型的情境數字跟對方原本的不同');

  // 同一個科目代碼兩邊名稱不同：合併前要提醒
  const mineLine = apiM.addLineItemInline('B', '物流費', 'DX');
  const hisLine = apiH.addLineItemInline('B', '雜支', 'DX');
  assert(mineLine.LineCode === hisLine.LineCode, '測試前提不成立：兩邊新增的科目應該拿到同一個代碼');
  const r3 = hostM.previewMerge(Pack.parsePack(JSON.stringify(hostH.exportPack(null, { scenarioIds: [tgt.ScenarioID] })))).report;
  assert(r3.lineNameConflicts.length === 1 && /⚠/.test(Pack.describeMerge(r3)) && /物流費/.test(Pack.describeMerge(r3)), '科目代碼相同名稱不同時要提醒');

  // 情境代號在本機屬於別的車型：擋下來
  const daSc = apiM.getScenarios('DA')[0];
  const fake = Pack.parsePack(JSON.stringify(hostH.exportPack(null, { scenarioIds: [tgt.ScenarioID] })));
  fake.tables.Scenarios[0].ScenarioID = daSc.ScenarioID;
  throws(() => hostM.previewMerge(fake), /無法合併/, '情境代號跟本機別的車型衝突時應該擋下');
  throws(() => hostM.exportPack(null, { scenarioIds: ['不存在'] }), /找不到/, '匯出不存在的情境要有清楚的錯誤');
}

/* ---- 5. 其他保護 --------------------------------------------------------------------------------- */
throws(() => hostA.call('sheetToObjects_', ['Vehicles']), /沒有這個後端函式/, '前端不該能呼叫私有函式');
throws(() => Pack.parsePack('not json'), /JSON/, '壞掉的檔案要有清楚的錯誤');
throws(() => Pack.parsePack({ format: 'x', tables: {} }), /不是/, '不是資料包的 JSON 要擋下來');
throws(() => Pack.parsePack({ format: Pack.FORMAT, formatVersion: Pack.FORMAT_VERSION + 1, tables: {} }), /版本/, '比工具新的資料包要擋下來');
const oldPack = Pack.parsePack({ format: Pack.FORMAT, formatVersion: 1, tables: { VehicleTypes: [{ VehicleTypeID: 'OLD', Retired: 'x' }] } });
const hostOld = newHost(memoryStorage());
hostOld.replaceWithPack(oldPack);
assert(same(apiOf(hostOld).getVehicleTypes().map(t => t.VehicleTypeID), ['OLD']), '缺少欄位/多出欄位的舊資料包讀不進來');
assert(apiOf(hostOld).getPLLineItems('OLD').length > 30, '資料包沒有科目表時應該自動補上內建科目');

const brokenStorage = memoryStorage();
brokenStorage.setItem(Host.STORAGE_KEY, '{"tables": 壞掉');
newHost(brokenStorage);
assert(brokenStorage.getItem(Host.STORAGE_KEY + '.corrupt') === '{"tables": 壞掉', '暫存壞掉時，原本的內容應該先另存一份再重建');

const hostStale = newHost(memoryStorage());
hostStale.markStale();
throws(() => hostStale.call('saveVehicleType', [{ VehicleTypeID: 'Q' }]), /另一個/, '另一個分頁改過資料後，這一頁應該停止寫入');

// google.script.run 替身：非同步回呼、withFailureHandler、withUserObject
{
  const queue = [];
  const run = Host.createScriptRun(hostA, fn => queue.push(fn));
  let got = null, err = null, user = null;
  run.withSuccessHandler((r, u) => { got = r; user = u; }).withUserObject('ctx').getVehicleTypes();
  assert(got === null, 'google.script.run 替身應該是非同步的');
  run.withFailureHandler(e => { err = e; }).notAFunction();
  queue.forEach(fn => fn());
  assert(Array.isArray(got) && got.length === 2 && user === 'ctx', 'google.script.run 替身的成功回呼/withUserObject 不對');
  assert(err instanceof Error && /沒有這個後端函式/.test(err.message), 'google.script.run 替身的失敗回呼不對');
}

/* ---- 6. 示範資料與 dist ------------------------------------------------------------------------- */
const demo = build.buildDemoPack();
const hostDemo = newHost(memoryStorage());
hostDemo.replaceWithPack(Pack.parsePack(JSON.stringify(demo)));
const demoCmp = compareAll(apiOf(hostDemo));
assert(demoCmp.columns.length >= 6 && demoCmp.columns.every(c => c.checks.length === 0), '示範資料載入後儀表板算不出來或小計對不起來');

const distOk = fs.existsSync(build.OUT_FILE) && fs.readFileSync(build.OUT_FILE, 'utf8') === build.buildHtml();
assert(distOk, 'dist/FS-local.html 不是最新的：改了 src/ 或 local/ 之後請執行 node tools/build-local.js');

if (failures.length) {
  console.log(`地端版驗證失敗：${failures.length} 項（共 ${checks} 項）`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`地端版驗證通過：${checks} 項全部符合（Gate F 數字與 Node 驗算層逐格相同、暫存/資料包/合併匯入行為正確、dist 為最新）。`);
