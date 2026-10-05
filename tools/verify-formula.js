/**
 * 公式式計算來源、車型各自的科目表、改善作法與 GATE 報告的驗證：
 *
 *   node tools/verify-formula.js
 *
 * 走真實的後端路徑(記憶體試算表)，從 Gate F 驗算情境出發，確認：
 *   - 公式語法、錯誤訊息、循環引用會被擋下
 *   - 改公式/加科目只影響自己的車型，不會影響別的車型
 *   - 車系個別公式、[參數]、自訂參數、REF 跨情境引用的結果正確
 *   - 開發總投可以只攤給部分車系
 *   - 科目說明、改善作法、排序、GATE 報告的資料正確
 */
const { loadAppsScript } = require('./fake-apps-script');
const gatef = require('./verify-gatef');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, msg, tol) { if (Math.abs(a - b) > (tol || 0.01)) throw new Error(`${msg}：實際 ${a}，預期 ${b}`); }
function throws(fn, pattern, msg) {
  try { fn(); } catch (e) {
    if (pattern && !pattern.test(e.message)) throw new Error(`${msg}：錯誤訊息不符「${e.message}」`);
    return;
  }
  throw new Error(msg + '：應該要擋下來');
}

const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs']);
const sid = gatef.buildScenario(gs);
gs.getBootstrap('DA');   // 開頁：DA 會有自己的一份科目表
const amt = (scenarioId, vid, code) => gs.calculatePLCore_(scenarioId, vid).lineValues[code];
const reset = () => { gs.SHEET_CACHE_ = {}; gs.resetCalcMemo_(); };

check('公式語法：全形符號、百分比、函式、錯誤位置', () => {
  const env = { code: c => ({ P8: 1000 })[c] || 0, name: () => 0.05, children: () => 0, taxDeduct: () => 0, ref: () => 0 };
  near(gs.evalFormulaAst_(gs.parseFormula_('（P8 − 100）× 10%'), env), 90, '全形');
  near(gs.evalFormulaAst_(gs.parseFormula_('ROUND(P8 * [營業稅率] / (1 + [營業稅率]))'), env), 48, 'ROUND');
  near(gs.evalFormulaAst_(gs.parseFormula_('IF(P8 > 500, 1, 2)'), env), 1, 'IF');
  near(gs.evalFormulaAst_(gs.parseFormula_('P8 / 0'), env), 0, '除以 0 為 0');
  throws(() => gs.parseFormula_('P8 +'), /不完整/, '不完整的公式');
  throws(() => gs.parseFormula_('FOO(1)'), /沒有「FOO」/, '不存在的函式');
});

check('改公式只影響這個車型；別的車型(仍用範本)不受影響', () => {
  gs.createVehicleType('DX', '', '');
  gs.saveVehicle({ VehicleID: 'X1', VehicleTypeID: 'DX', VehicleCode: '測試車' });
  const dx = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE F', ScenarioName: '現況', ScenarioType: '現況', VehicleTypeID: 'DX' }, '', []);
  gs.saveSalesMixGrid(dx.ScenarioID, 'DX', [{ RowID: '', VehicleID: 'X1', SalesMixPct: 100, MonthlyVolume: 100, LifeCycleYears: 10, ListPriceTaxIncl: 1000000, ScrapFee: 0, ScrapFeeTaxStatus: '含稅' }]);
  const before = amt(dx.ScenarioID, 'X1', 'd4');
  const p8 = amt(sid, 'V1', 'P8');
  gs.saveChartLine('DA', { LineCode: 'd4', LineName: '季Margin', CalcType: 'FORMULA', Formula: 'P8 * 1%' });
  reset();
  near(amt(sid, 'V1', 'd4'), p8 * 0.01, 'DA 的季Margin 改成 1%');
  near(amt(dx.ScenarioID, 'X1', 'd4'), before, 'DX 的季Margin 不應受影響');
  gs.saveChartLine('DA', { LineCode: 'd4', LineName: '季Margin', CalcType: 'FORMULA', Formula: 'P8 * [季Margin率]' });
  reset();
});

check('新增科目只出現在自己的車型，代碼不跟別的車型互相影響', () => {
  gs.addLineItemInline('B', '關稅', 'DA');
  const da = gs.getPLLineItems('DA').filter(d => d.LineName === '關稅');
  const dx = gs.getPLLineItems('DX').filter(d => d.LineName === '關稅');
  assert(da.length === 1, 'DA 應有關稅');
  assert(dx.length === 0, 'DX 不應有關稅');
});

check('存檔前擋下：未知科目、未知名稱、循環引用；沒被小計算進去的科目會提醒', () => {
  throws(() => gs.saveChartLine('DA', { LineCode: 'b4', LineName: '一般材料', CalcType: 'FORMULA', Formula: 'zz9 * 2' }), /不存在的科目代碼/, '未知代碼');
  throws(() => gs.saveChartLine('DA', { LineCode: 'b4', LineName: '一般材料', CalcType: 'FORMULA', Formula: '[不存在的東西]' }), /不是系統變數/, '未知名稱');
  throws(() => gs.saveChartLine('DA', { LineCode: 'b4', LineName: '一般材料', CalcType: 'FORMULA', Formula: 'B * 0.1' }), /循環引用/, '循環引用');
  const added = gs.saveChartLine('DA', { LineCode: '', LineName: '獨立試算', ParentLine: '', CalcType: 'FORMULA', Formula: 'P8 * 2' });
  const warn = gs.getChartEditor('DA', sid).problems.filter(p => p.level === 'warning' && p.code === added.line.LineCode);
  assert(warn.length === 1, '沒被算進營業淨利的科目要提醒');
  gs.deletePLLineItem(added.line.LineCode, 'DA');
});

check('[科目名稱] 引用、自訂參數(數值與%)、匯率名稱', () => {
  gs.saveParamDef({ ParamName: '一般材料倍率', Unit: '數值', DefaultValue: 1.2 });
  gs.saveParamDef({ ParamName: '關稅率', Unit: '%', DefaultValue: 13 });
  gs.saveRateGrid(sid, [{ ParamID: '', ParamName: '關稅率', VehicleID: 'V2', Value: 10 }]);
  gs.saveFxGrid(sid, [{ ParamID: '', Currency: 'CNY', ParamName: '現況匯率', Value: 4.65 }]);
  reset();
  const b2 = amt(sid, 'V1', 'b2');
  const tax = gs.getPLLineItems('DA').filter(d => d.LineName === '關稅')[0];
  gs.saveChartLine('DA', { LineCode: tax.LineCode, LineName: '關稅', CalcType: 'FORMULA', Formula: '[材料成本-KD] * [關稅率]' });
  reset();
  near(amt(sid, 'V1', tax.LineCode), b2 * 0.13, '預設關稅率 13%');
  near(amt(sid, 'V2', tax.LineCode), amt(sid, 'V2', 'b2') * 0.10, 'V2 覆寫成 10%');
  gs.saveChartLine('DA', { LineCode: tax.LineCode, LineName: '關稅', CalcType: 'FORMULA', Formula: '59000 * [CNY匯率] * [一般材料倍率]' });
  reset();
  near(amt(sid, 'V1', tax.LineCode), 59000 * 4.65 * 1.2, '匯率 × 自訂數值參數');
  // B = CHILDREN() 會把新科目算進去
  const pl = gs.calculatePLCore_(sid, 'V1').lineValues;
  const kids = gs.getPLLineItems('DA').filter(d => d.ParentLine === 'B').reduce((s, d) => s + (pl[d.LineCode] || 0), 0);
  near(pl.B, kids, 'B 應等於所有子科目合計');
  gs.deletePLLineItem(tax.LineCode, 'DA');
  reset();
});

check('車系個別公式：只改那個車系', () => {
  const v2Before = amt(sid, 'V2', 'b4');
  gs.saveChartLine('DA', { LineCode: 'b4', LineName: '一般材料', CalcType: 'INPUT', VehicleFormulas: { V1: '7166 * 1.2' } });
  reset();
  near(amt(sid, 'V1', 'b4'), 7166 * 1.2, 'V1 用個別公式');
  near(amt(sid, 'V2', 'b4'), v2Before, 'V2 維持手動輸入');
  gs.saveChartLine('DA', { LineCode: 'b4', LineName: '一般材料', CalcType: 'INPUT', VehicleFormulas: {} });
  reset();
});

check('REF 跨情境/跨車型引用(例：以 DE 為 BASE × 1.2)', () => {
  gs.createVehicleType('DE', '', '');
  gs.saveVehicle({ VehicleID: 'E1', VehicleTypeID: 'DE', VehicleCode: '8人座' });
  const de = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE Z', ScenarioName: '實績', ScenarioType: '現況', VehicleTypeID: 'DE' }, '', []);
  gs.saveSalesMixGrid(de.ScenarioID, 'DE', [{ RowID: '', VehicleID: 'E1', SalesMixPct: 100, MonthlyVolume: 150, LifeCycleYears: 10, ListPriceTaxIncl: 800000, ScrapFee: 0, ScrapFeeTaxStatus: '含稅' }]);
  gs.saveCostOfSalesMatrix(de.ScenarioID, [{ RowID: '', VehicleID: 'E1', LineCode: 'b4', Amount: 5972, Currency: 'TWD' }]);
  gs.saveChartLine('DA', { LineCode: 'b4', LineName: '一般材料', CalcType: 'FORMULA', Formula: `REF("${de.ScenarioID}", "b4") * 1.2` });
  reset();
  near(amt(sid, 'V1', 'b4'), 5972 * 1.2, '以 ID 引用');
  gs.saveChartLine('DA', { LineCode: 'b4', LineName: '一般材料', CalcType: 'FORMULA', Formula: 'REF("DE GATE Z 實績", "b4") * 1.2' });
  reset();
  near(amt(sid, 'V3', 'b4'), 5972 * 1.2, '以名稱引用');
  gs.saveChartLine('DA', { LineCode: 'b4', LineName: '一般材料', CalcType: 'INPUT', Formula: '' });
  reset();
  near(amt(sid, 'V1', 'b4'), 7166, '改回手動輸入');
});

check('開發總投可以只攤給部分車系(中低規式樣/TNCAP 由各車型分別攤提)', () => {
  const before = { V1: amt(sid, 'V1', 'b5'), V2: amt(sid, 'V2', 'b5'), V3: amt(sid, 'V3', 'b5') };
  const dev = gs.getDevInvestmentSummary(sid);
  const rows = dev.rows.map(r => Object.assign({}, r));
  rows.push({ RowID: '', Department: '開發部', TargetLineCode: 'b5', Amount: 220 * 12 * 12 * 1000, Currency: 'TWD', VehicleScope: 'V3' });
  gs.saveDevInvestmentGrid(sid, rows);
  reset();
  near(amt(sid, 'V1', 'b5'), before.V1, 'V1 不分攤');
  near(amt(sid, 'V3', 'b5'), before.V3 + 1000, 'V3 多分攤 1000/台', 0.5);
  // 開發總投整批存檔：要刪除的列是「清空欄位」送出(跟畫面上按刪除一樣)
  const added = gs.getDevInvestmentSummary(sid).rows.filter(r => r.VehicleScope === 'V3')[0];
  gs.saveDevInvestmentGrid(sid, dev.rows.concat([{ RowID: added.RowID, Department: '', Amount: '' }]));
  reset();
  near(amt(sid, 'V3', 'b5'), before.V3, '刪除後回到原值', 0.5);
});

check('科目說明：銷貨成本備註自動帶入，另存的說明優先', () => {
  gs.saveCostOfSalesMatrix(sid, [{ RowID: '', VehicleID: 'V1', LineCode: 'b9', Amount: 0, Currency: 'TWD', Notes: '使用中華標' }]);
  assert(gs.getLineNotes(sid).b9 === '使用中華標', '備註帶入說明');
  gs.saveLineNotes(sid, { b9: '使用中華標，沒有技酬金' });
  assert(gs.getLineNotes(sid).b9 === '使用中華標，沒有技酬金', '另存的說明優先');
});

check('改善作法：依順序儲存、空白列刪除', () => {
  const saved = gs.saveActions(sid, [
    { Title: '座椅低減', LineCode: 'b1', Owner: '採購部', Effect: 31294, Status: '進行中' },
    { Title: '', Effect: '' },
    { Title: 'K件議價', LineCode: 'b2', Owner: '採購部', Effect: 18391 }
  ]);
  assert(saved.length === 2, '空白列不存');
  assert(saved[0].Title === '座椅低減' && saved[1].Title === 'K件議價', '順序');
  const reordered = gs.saveActions(sid, [saved[1], saved[0]]);
  assert(reordered[0].Title === 'K件議價' && reordered[0].ActionID === saved[1].ActionID, '重新排序保留 ID');
});

check('拖曳排序：車系與科目一次送完整順序', () => {
  const order = gs.setVehicleOrder('DA', ['V3', 'V1', 'V2']).map(v => v.VehicleID);
  assert(order.join() === 'V3,V1,V2', '車系順序：' + order.join());
  const bKids = gs.getPLLineItems('DA').map(d => ({ LineCode: d.LineCode, ParentLine: d.ParentLine }));
  const i1 = bKids.findIndex(x => x.LineCode === 'b1'), i2 = bKids.findIndex(x => x.LineCode === 'b2');
  const tmp = bKids[i1]; bKids[i1] = bKids[i2]; bKids[i2] = tmp;
  const lines = gs.setLineOrder('DA', bKids).map(d => d.LineCode);
  assert(lines.indexOf('b2') < lines.indexOf('b1'), 'b2 應排到 b1 前面');
  // 預設的小計科目也能換父科目(全部都是「預設」不是「內建」)；循環父子仍會擋下
  const before = gs.getPLLineItems('DA').map(d => ({ LineCode: d.LineCode, ParentLine: d.ParentLine || '' }));
  gs.setLineOrder('DA', [{ LineCode: 'J', ParentLine: 'I' }]);
  assert(gs.getPLLineItems('DA').find(d => d.LineCode === 'J').ParentLine === 'I', '預設科目可以換父科目');
  gs.setLineOrder('DA', before);
  assert(gs.getPLLineItems('DA').find(d => d.LineCode === 'J').ParentLine === '', '換回來');
  gs.setVehicleOrder('DA', ['V1', 'V2', 'V3']);
});

check('科目呈現順序跟 Excel 一樣：扣減型小計在明細下面，舊版「父科目在前」的排序也會自動修正', () => {
  const EXCEL = ['A', 'B', 'b', 'C', 'd', 'E', 'f', 'G', 'h', 'I', 'J', 'K'];
  const shape = codes => codes.filter(c => !/^P\d/.test(c)).map(c => /^[bdfh]\d/.test(c) ? c[0] : c)
    .filter((c, i, a) => i === 0 || a[i - 1] !== c).join(',');
  const cmpCodes = () => gs.calculateComparison([{ ScenarioID: sid, VehicleID: '' }]).lines.map(l => l.LineCode);
  assert(shape(cmpCodes()) === EXCEL.join(), '儀表板順序：' + shape(cmpCodes()));
  // 舊版拖曳會把父科目排在子科目前面(E、d1…d5、G、f…)：存成這樣也要照 Excel 呈現
  const parentFirst = [];
  const defs = gs.getPLLineItems('DA');
  const walk = p => defs.filter(d => (d.ParentLine || '') === p).sort((a, b) => a.SortOrder - b.SortOrder)
    .forEach(d => { parentFirst.push(d); walk(d.LineCode); });
  walk('');
  gs.savePLLineItemGrid(parentFirst.map((d, i) => ({ LineCode: d.LineCode, LineName: d.LineName, SortOrder: (i + 1) * 10 })), 'DA');
  const rawSorted = gs.getPLLineItems('DA').slice().sort((a, b) => a.SortOrder - b.SortOrder).map(d => d.LineCode);
  assert(rawSorted.indexOf('E') < rawSorted.indexOf('d1'), '測試前提：存的 SortOrder 是父科目在前');
  assert(shape(cmpCodes()) === EXCEL.join(), '父科目在前的舊排序：' + shape(cmpCodes()));
  assert(shape(gs.getGateReport(sid, sid, '').lines.map(l => l.LineCode)) === EXCEL.join(), '報告順序');
  // 科目樹拖曳送出的是「父在前」的走訪順序，存回去的 SortOrder 本身就要是 Excel 順序
  const saved = gs.setLineOrder('DA', parentFirst.map(d => ({ LineCode: d.LineCode, ParentLine: d.ParentLine || '' })));
  const bySort = saved.slice().sort((a, b) => a.SortOrder - b.SortOrder).map(d => d.LineCode);
  assert(shape(bySort) === EXCEL.join(), '存回的 SortOrder：' + shape(bySort));
});

check('GATE 報告：現況 vs 目標差距與作法、開發總投 by 部門', () => {
  const target = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE F', ScenarioName: '目標', ScenarioType: '目標', VehicleTypeID: 'DA' }, sid, []);
  const dev = gs.getDevInvestmentSummary(target.ScenarioID);
  gs.saveDevInvestmentGrid(target.ScenarioID, dev.rows.map(r => Object.assign({}, r, { ChallengeReductionPct: 20 })));
  gs.saveActions(target.ScenarioID, [{ Title: '開發總投低減 20%', LineCode: 'b5', Owner: '開發部', Effect: 5000 }]);
  const rep = gs.getGateReport(sid, target.ScenarioID, '');
  assert(rep.base && rep.target, '兩個情境都要有');
  const gap = rep.target.weighted.K - rep.base.weighted.K;
  const b5gap = rep.base.weighted.b5 - rep.target.weighted.b5;
  near(b5gap, 25833 * 0.2, '模具攤提低減 20%', 2);
  assert(gap > 0, '目標的營業淨利應高於現況');
  assert(rep.actions.length === 1 && rep.actions[0].Effect === 5000, '作法');
  assert(rep.target.dev.rows.length > 0 && Math.abs(rep.target.dev.total.reduced - rep.target.dev.total.total * 0.8) < 1, '開發總投低減後 = 80%');
  assert(rep.lines.some(l => l.LineCode === 'K'), '報告要有營業淨利');
});

check('科目表：複製其他車型 / 另存範本 / 恢復預設', () => {
  gs.copyChartFromType('DX', 'DA');
  assert(gs.getPLLineItems('DX').length === gs.getPLLineItems('DA').length, 'DX 複製 DA');
  gs.saveChartAsTemplate('DA');
  assert(gs.getPLLineItems('').length === gs.getPLLineItems('DA').length, '範本 = DA');
  gs.saveChartLine('DX', { LineCode: 'P8', LineName: '廠價', CalcType: 'FORMULA', Formula: 'P5' });
  gs.restoreBuiltInLineItems('DX');
  const p8 = gs.getPLLineItems('DX').filter(d => d.LineCode === 'P8')[0];
  assert(p8.Formula === 'P5 - P6 - P7' && p8.LineName === '廠價(未稅)', '恢復預設公式與名稱');
});

check('公式用科目名稱寫，存成代碼；科目改名不會讓公式斷掉', () => {
  gs.saveChartLine('DA', { LineCode: 'd4', LineName: '季Margin', CalcType: 'FORMULA', Formula: '[廠價(未稅)] * [季Margin率]' });
  const d4 = () => gs.getPLLineItems('DA').filter(d => d.LineCode === 'd4')[0];
  assert(d4().Formula === 'P8 * [季Margin率]', '名稱應存成代碼、參數維持名稱：' + d4().Formula);
  // 舊資料：另一個科目直接用 [名稱] 寫在車系個別公式裡
  const raw = gs.getPLLineItems('DA').filter(d => d.LineCode === 'b4')[0];
  gs.upsertRow_('PLLineItems', 'LineID', Object.assign({}, raw, { VehicleFormulas: JSON.stringify({ V1: '[廠價(未稅)] * 0' }) }));
  reset();
  gs.saveChartLine('DA', { LineCode: 'P8', LineName: '廠價', CalcType: 'FORMULA', Formula: 'P5 - P6 - P7' });
  reset();
  const b4 = gs.getPLLineItems('DA').filter(d => d.LineCode === 'b4')[0];
  assert(JSON.parse(b4.VehicleFormulas).V1 === 'P8 * 0', '改名時舊的 [名稱] 引用應改成代碼：' + b4.VehicleFormulas);
  near(amt(sid, 'V1', 'b4'), 0, '改名後公式照樣算得出來');
  gs.saveChartLine('DA', { LineCode: 'P8', LineName: '廠價(未稅)', CalcType: 'FORMULA', Formula: 'P5 - P6 - P7' });
  gs.saveChartLine('DA', { LineCode: 'b4', LineName: '一般材料', CalcType: 'INPUT', VehicleFormulas: {} });
  reset();
});

check('損益兩平點很低時(遠低於目前銷量)也找得到；假設銷量 0 台要照算，不能當成沒調整', () => {
  reset();
  const k0 = gs.calculatePLAllVehicles(sid).weightedAverage.filter(l => l.LineCode === 'K')[0].Amount;
  const zero = gs.sensitivityTable(sid, { code: 'K', basis: 'month' }, { type: 'volume' }, [0], null, []);
  near(zero.cells[0][0], 0, '銷量 0 台時月營業淨利(變動部分)應該是 0，不是目前的數字', 1);
  // 材料成本降到很低 → 單台淨利大幅轉正，只剩開發攤提要靠台數攤平 → 損益兩平點遠低於目前銷量
  const m = gs.getCostOfSalesMatrix(sid, 'DA');
  const orig = [], low = [];
  Object.keys(m.values.b1 || {}).forEach(v => {
    const c = m.values.b1[v];
    orig.push({ RowID: c.RowID, VehicleID: v, LineCode: 'b1', Amount: c.Amount, Currency: c.Currency, Notes: c.Notes || '' });
    low.push({ RowID: c.RowID, VehicleID: v, LineCode: 'b1', Amount: 1000, Currency: 'TWD', Notes: c.Notes || '' });
  });
  gs.saveCostOfSalesMatrix(sid, low, {});
  reset();
  const v = gs.solveGoal(sid, { code: 'K', basis: 'unit' }, 0, { type: 'volume' });
  assert(v.feasible && v.value > 0 && v.value < v.base * 0.2, '損益兩平月銷量應該找得到且遠低於目前銷量：' + JSON.stringify(v));
  near(v.achieved, 0, '代回去單台營業淨利應為 0', 1);
  gs.saveCostOfSalesMatrix(sid, orig, {});
  reset();
  near(gs.calculatePLAllVehicles(sid).weightedAverage.filter(l => l.LineCode === 'K')[0].Amount, k0, '還原後數字不變', 0.01);
});

check('公式試算(邊打邊算)就要抓到循環引用，不是存檔才發現', () => {
  const pv = gs.previewLineFormula('DA', sid, { LineCode: '', LineName: '循環測試', ParentLine: 'B', CalcType: 'FORMULA', Formula: '[生產毛利] * 1%' });
  assert(pv.problems.length && /循環引用/.test(pv.problems[0].message), '新科目引用生產毛利(又被算進銷貨成本)應該當場報循環引用：' + JSON.stringify(pv.problems));
});

check('REF 用情境名稱寫：可以省略車型代號、存檔換成情境代號，情境改名後公式不會斷；找不到的情境當場報錯', () => {
  reset();
  const other = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE C', ScenarioName: 'REF來源', ScenarioType: '現況', VehicleTypeID: 'DA' }, sid, ['salesmix', 'costofsales']);
  const bad = gs.previewLineFormula('DA', sid, { LineCode: '', LineName: 'REF測試', ParentLine: 'B', CalcType: 'FORMULA', Formula: 'REF("GATE C 沒有這個", "b1")' });
  assert(bad.problems.length && /REF 找不到情境/.test(bad.problems[0].message), '找不到的情境應該當場報錯：' + JSON.stringify(bad.problems));
  gs.saveChartLine('DA', { LineCode: '', LineName: 'REF測試', ParentLine: 'B', CalcType: 'FORMULA', Formula: 'REF("GATE C REF來源", "b1") * 0' });
  const saved = gs.getPLLineItems('DA').filter(d => d.LineName === 'REF測試')[0];
  assert(saved.Formula.indexOf(other.ScenarioID) !== -1, '存檔後 REF 應該存成情境代號：' + saved.Formula);
  const rows = gs.getScenarios('DA').map(r => r.ScenarioID === other.ScenarioID ? Object.assign({}, r, { ScenarioName: 'REF來源改名' }) : r);
  gs.saveScenarioGrid('DA', rows);
  reset();
  const errs = gs.calculatePLAllVehicles(sid).vehicles.map(v => v.errors[saved.LineCode]).filter(Boolean);
  assert(!errs.length, '情境改名後 REF 不該出錯：' + errs.join());
  gs.deletePLLineItem(saved.LineCode, 'DA');
  gs.deleteScenario(other.ScenarioID);
  reset();
});

check('從 Excel 匯入整張表：名稱對應、新增缺少的科目、略過公式科目', () => {
  const rep = gs.importMatrixRows(sid, 'DA', 'cost', [
    { name: '材料成本 - LP', values: { V1: 433466, V2: 506850 } },
    { name: '運費(海運)', values: { V1: 1200, V3: 1500 } },
    { name: '貨物稅', values: { V1: 1 } }
  ], true, '');
  assert(rep.matched.length === 1 && rep.created.join() === '運費(海運)' && rep.skipped.length === 1, JSON.stringify(rep));
  assert(rep.updated === 4, '應填入 4 格：' + rep.updated);
  reset();
  const freight = gs.getPLLineItems('DA').filter(d => d.LineName === '運費(海運)')[0];
  near(amt(sid, 'V3', freight.LineCode), 1500, '新科目的金額');
  gs.deletePLLineItem(freight.LineCode, 'DA');
  reset();
});

check('目標反推與敏感度：解出來的值代回去會達到目標，且不改到存檔資料', () => {
  reset();
  const k0 = gs.calculatePLAllVehicles(sid).weightedAverage.filter(l => l.LineCode === 'K')[0].Amount;
  const r = gs.solveGoal(sid, { code: 'K', basis: 'unit' }, 0, { type: 'price' });
  assert(r.feasible && r.value > r.base, '損益兩平售價應該高於目前售價：' + JSON.stringify(r));
  near(r.achieved, 0, '代回去營業淨利應為 0', 1);
  const m = gs.solveGoal(sid, { code: 'K', basis: 'unit' }, k0 + 10000, { type: 'line', code: 'b1' });
  near(m.base - m.value, 10000, '材料成本-LP 少 1 萬，營業淨利就多 1 萬(LP 不影響貨物稅)', 1);
  const v = gs.solveGoal(sid, { code: 'K', basis: 'unit' }, 0, { type: 'volume' });
  assert(!v.feasible && /達不到/.test(v.message), '單台變動成本高於售價時，只靠台數不可能損益兩平');
  const t = gs.sensitivityTable(sid, { code: 'K' }, { type: 'volume' }, [200, 400], { type: 'fx', currency: 'CNY' }, [4.5, 4.65]);
  near(t.cells[1][1], k0, '敏感度表的「目前」那一格應等於目前的營業淨利', 1);
  assert(t.cells[0][1] < t.cells[1][1], '台數減半，開發攤提變重，營業淨利應該變差');
  reset();
  near(gs.calculatePLAllVehicles(sid).weightedAverage.filter(l => l.LineCode === 'K')[0].Amount, k0, '試算完存檔的數字不能變', 0.01);
});

check('目標反推(組合拳)：已知調整、負責金額、補足缺口依序計算，貢獻加總 = 總改善', () => {
  reset();
  const k0 = gs.calculatePLAllVehicles(sid).weightedAverage.filter(l => l.LineCode === 'K')[0].Amount;
  const goal = k0 + 30000;
  const M = { code: 'K', basis: 'unit' };
  const sum = r => r.levers.reduce((s, l) => s + l.contribution, 0);
  // 已知調整：材料成本-LP 降 2%(照 % 套用)，剩下的由售價補
  const a = gs.solveGoalPlan(sid, M, goal, [
    { driver: { type: 'line', code: 'b1' }, mode: 'known', by: 'pct', known: -2 },
    { driver: { type: 'price' }, mode: 'fill' }
  ]);
  assert(a.feasible, '應該達得到：' + a.message);
  near(a.levers[0].pct, -2, '已知調整 −2% 直接套用', 1e-6);
  near(a.achieved, goal, '售價補足剩下的缺口', 1);
  near(sum(a), goal - k0, '逐項貢獻加總 = 總改善', 1);
  assert(a.levers[1].value > a.levers[1].base, '售價往上補');
  // 已知調整的另外兩種寫法：加減、調到
  const b = gs.solveGoalPlan(sid, M, goal, [
    { driver: { type: 'line', code: 'b1' }, mode: 'known', by: 'abs', known: -10000 },
    { driver: { type: 'volume' }, mode: 'known', by: 'to', known: 500 }
  ]);
  near(b.levers[0].base - b.levers[0].value, 10000, '加減：少 1 萬', 1e-6);
  assert(b.levers[1].value === 500, '調到：銷量就是 500');
  assert(!b.feasible && /還差/.test(b.message) && /補足缺口/.test(b.message), '沒有補足項目時說明還差多少：' + b.message);
  // 負責金額：材料負責 8,000，剩下的由售價補
  const c = gs.solveGoalPlan(sid, M, goal, [
    { driver: { type: 'line', code: 'b1' }, mode: 'amount', amount: 8000 },
    { driver: { type: 'price' }, mode: 'fill' }
  ]);
  near(c.levers[0].contribution, 8000, '材料成本-LP 負責 8,000 元/台', 1);
  near(c.achieved, goal, '剩下由售價補足', 1);
  // 補足缺口依順序：售價最多 0.5%，碰到上限後換材料
  const d = gs.solveGoalPlan(sid, M, goal, [
    { driver: { type: 'price' }, mode: 'fill', capPct: 0.5 },
    { driver: { type: 'line', code: 'b1' }, mode: 'fill' }
  ]);
  near(d.achieved, goal, '售價碰到上限，剩下由材料補', 1);
  assert(d.levers[0].capped && Math.abs(d.levers[0].pct - 0.5) < 1e-6, '售價應標示碰到上限 0.5%：' + JSON.stringify(d.levers[0]));
  // 第一個補足項目就夠了：後面的不動
  const e = gs.solveGoalPlan(sid, M, k0 + 1000, [
    { driver: { type: 'line', code: 'b1' }, mode: 'fill' }, { driver: { type: 'price' }, mode: 'fill' }
  ]);
  assert(e.feasible && e.levers[1].value === e.levers[1].base, '第一項補得滿，第二項不該動');
  // 已知調整就超過目標：補足項目不動
  const f = gs.solveGoalPlan(sid, M, k0 + 1000, [
    { driver: { type: 'line', code: 'b1' }, mode: 'known', by: 'abs', known: -5000 }, { driver: { type: 'price' }, mode: 'fill' }
  ]);
  assert(f.reachedByKnown && f.levers[1].value === f.levers[1].base, '已知調整就超過目標時，補足項目不動');
  // 目標比目前還差(已經達到)：補足項目不會為了剛好等於目標而往壞的方向調；負責金額照樣是改善
  const g = gs.solveGoalPlan(sid, M, k0 - 20000, [
    { driver: { type: 'line', code: 'b1' }, mode: 'amount', amount: 3000 }, { driver: { type: 'price' }, mode: 'fill' }
  ]);
  assert(g.alreadyMet && g.reachedByKnown && g.levers[1].value === g.levers[1].base, '已經達到目標時補足項目不動：' + JSON.stringify(g.levers[1]));
  near(g.levers[0].contribution, 3000, '負責金額一律是往好的方向改善', 1);
  // 看成本科目時，越低越好：負責金額讓成本降低
  const h = gs.solveGoalPlan(sid, { code: 'B', basis: 'unit' }, 0, [{ driver: { type: 'line', code: 'b1' }, mode: 'amount', amount: 5000 }]);
  near(h.levers[0].contribution, -5000, '銷貨成本負責 5,000 = 成本少 5,000', 1);
  // 上限內補不滿：說明最多做到多少
  const x = gs.solveGoalPlan(sid, M, k0 + 1e7, [{ driver: { type: 'price' }, mode: 'fill', capPct: 1 }, { driver: { type: 'line', code: 'b1' }, mode: 'fill', capPct: 1 }]);
  assert(!x.feasible && /上限/.test(x.message) && x.levers.every(l => l.capped), '上限內達不到要說明：' + x.message);
  reset();
  near(gs.calculatePLAllVehicles(sid).weightedAverage.filter(l => l.LineCode === 'K')[0].Amount, k0, '試算完存檔的數字不能變', 0.01);
});

check('目標反推另存成新情境：資料寫實後重算的營業淨利 = 試算值，來源情境不變', () => {
  reset();
  const k0 = gs.calculatePLAllVehicles(sid).weightedAverage.filter(l => l.LineCode === 'K')[0].Amount;
  const r = gs.solveGoalPlan(sid, { code: 'K', basis: 'unit' }, k0 + 40000, [
    { driver: { type: 'volume' }, mode: 'known', by: 'pct', known: 10 }, { driver: { type: 'dev' }, mode: 'known', by: 'pct', known: -10 },
    { driver: { type: 'line', code: 'b1' }, mode: 'amount', amount: 10000 }, { driver: { type: 'price' }, mode: 'fill' }
  ]);
  assert(r.feasible, r.message);
  const saved = gs.saveWhatIfAsScenario(sid, r.levers.map(l => ({ driver: l.driver, value: l.value })), { ScenarioName: '反推目標', ScenarioType: '目標' });
  near(saved.actual, saved.expected, '新情境重算 = 試算', 1);
  near(saved.actual, k0 + 40000, '新情境營業淨利 = 目標', 1);
  assert(/建議零售價/.test(saved.scenario.Notes), '情境備註記錄調整內容：' + saved.scenario.Notes);
  const p = gs.saveWhatIfAsScenario(sid, [{ driver: { type: 'param', name: '季Margin率' }, value: 1 }, { driver: { type: 'fx', currency: 'CNY' }, value: 4.3 }], { ScenarioName: '參數反推' });
  near(p.actual, p.expected, '參數/匯率另存後重算 = 試算', 1);
  near(gs.calculatePLAllVehicles(sid).weightedAverage.filter(l => l.LineCode === 'K')[0].Amount, k0, '來源情境不變', 0.01);
  gs.deleteScenario(saved.scenario.ScenarioID); gs.deleteScenario(p.scenario.ScenarioID);
});

check('情境快照：存下當時的數字，之後改資料不影響；可以當成比較欄位', () => {
  reset();
  const kOf = () => gs.calculatePLAllVehicles(sid).weightedAverage.filter(l => l.LineCode === 'K')[0].Amount;
  const k0 = kOf();
  const snap = gs.createSnapshot(sid, '審議版');
  assert(snap.SnapshotID, '建立快照');
  const list = gs.getSnapshots('DA');
  assert(list.length === 1 && Math.abs(list[0].K - k0) < 0.01 && list[0].scenarioExists, '快照清單：' + JSON.stringify(list));
  // 改資料：材料成本加 1 萬
  const v1 = gs.getCostOfSales(sid, 'V1').filter(r => r.LineCode === 'b1')[0];
  gs.saveCostOfSalesMatrix(sid, [{ RowID: v1.RowID, VehicleID: 'V1', LineCode: 'b1', Amount: Number(v1.Amount) + 10000, Currency: v1.Currency || 'TWD' }]);
  assert(Math.abs(kOf() - k0) > 1, '資料改了，營業淨利應該變');
  const opt = gs.getComparisonOptions().find(t => t.VehicleTypeID === 'DA').scenarios.find(x => x.isSnapshot);
  assert(opt && opt.ScenarioID === 'snap:' + snap.SnapshotID, '比較選項列出快照');
  const cmp = gs.calculateComparison([{ ScenarioID: opt.ScenarioID, VehicleID: '' }, { ScenarioID: sid, VehicleID: '' }, { ScenarioID: opt.ScenarioID, VehicleID: 'V1' }]);
  near(cmp.columns[0].amounts.K, k0, '快照欄位 = 存快照當時的營業淨利', 0.01);
  near(cmp.columns[1].amounts.K, kOf(), '目前欄位 = 改過的數字', 0.01);
  assert(cmp.columns[2].amounts.b1 > 0 && /快照 審議版/.test(cmp.columns[0].scenarioLabel), '快照的車系欄位與名稱：' + cmp.columns[0].scenarioLabel);
  assert(cmp.lines.some(l => l.LineCode === 'K'), '科目聯集含快照科目');
  gs.renameSnapshot(snap.SnapshotID, '審議版 v2');
  assert(gs.getSnapshots('DA')[0].SnapshotName === '審議版 v2', '改名');
  gs.saveCostOfSalesMatrix(sid, [{ RowID: v1.RowID, VehicleID: 'V1', LineCode: 'b1', Amount: Number(v1.Amount), Currency: v1.Currency || 'TWD' }]);
  gs.deleteSnapshot(snap.SnapshotID);
  assert(!gs.getSnapshots('DA').length, '刪除');
  near(kOf(), k0, '還原', 0.01);
});

check('所有科目、參數都可以刪除/改名：預設小計(K)可刪，預設參數可改名/刪除且不會被補回來', () => {
  reset();
  gs.saveVehicleType({ VehicleTypeID: 'DZ' });
  gs.saveVehicle({ VehicleID: 'Z1', VehicleTypeID: 'DZ', VehicleCode: 'Z車' });
  const zs = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE F', ScenarioName: '刪科目測試', ScenarioType: '現況', VehicleTypeID: 'DZ' }, '', []);
  gs.saveSalesMixGrid(zs.ScenarioID, 'DZ', [{ RowID: '', VehicleID: 'Z1', SalesMixPct: 100, MonthlyVolume: 10, LifeCycleYears: 5, ListPriceTaxIncl: 500000 }]);
  gs.deletePLLineItem('K', 'DZ');
  assert(!gs.getPLLineItems('DZ').some(d => d.LineCode === 'K'), '營業淨利(K)可以刪除');
  throws(() => gs.deletePLLineItem('I', 'DZ'), /被這些科目的公式引用|子科目/, '還有子科目/被引用時仍會擋下');
  gs.setLineOrder('DZ', gs.getPLLineItems('DZ').map(d => ({ LineCode: d.LineCode, ParentLine: d.LineCode === 'J' ? 'I' : d.ParentLine || '' })));
  assert(gs.getPLLineItems('DZ').find(d => d.LineCode === 'J').ParentLine === 'I', '預設科目可以換父科目');
  const cmp = gs.calculateComparison([{ ScenarioID: zs.ScenarioID, VehicleID: '' }]);
  assert(cmp.lines.length && !cmp.lines.some(l => l.LineCode === 'K'), '刪掉 K 之後儀表板照常計算');
  gs.getWhatIfOptions(zs.ScenarioID);
  gs.getGateReport('', zs.ScenarioID, '');
  // 預設參數：被公式用到時擋下；改名會連公式一起改；刪掉後資料升級不會補回來；恢復預設科目時補回
  throws(() => gs.deleteParamDef('季Margin率'), /公式使用/, '被公式使用的參數不能刪');
  const k0 = gs.calculatePLAllVehicles(sid).weightedAverage.find(l => l.LineCode === 'K').Amount;
  gs.renameParamDef('營業稅率', '營業稅稅率');
  assert(gs.getParamDefs().some(p => p.ParamName === '營業稅稅率') && !gs.getParamDefs().some(p => p.ParamName === '營業稅率'), '改名');
  assert(/\[營業稅稅率\]/.test(gs.getPLLineItems('DA').find(d => d.LineCode === 'P6').Formula), '公式跟著改名：' + gs.getPLLineItems('DA').find(d => d.LineCode === 'P6').Formula);
  near(gs.calculatePLAllVehicles(sid).weightedAverage.find(l => l.LineCode === 'K').Amount, k0, '改名後數字不變', 0.01);
  gs.setupSpreadsheet();
  assert(!gs.getParamDefs().some(p => p.ParamName === '營業稅率'), '改名後資料升級不會把舊的預設參數補回來');
  gs.renameParamDef('營業稅稅率', '營業稅率');
  near(gs.calculatePLAllVehicles(sid).weightedAverage.find(l => l.LineCode === 'K').Amount, k0, '改回來數字不變', 0.01);
  gs.saveParamDef({ ParamName: '貨物稅完稅價格計算率', Unit: '%', DefaultValue: 90, Description: '改過' });
  assert(gs.getParamDefs().find(p => p.ParamName === '貨物稅完稅價格計算率').DefaultValue === 90, '預設參數可以改預設值');
  gs.saveParamDef({ ParamName: '貨物稅完稅價格計算率', Unit: '%', DefaultValue: 91, Description: '預設參數' });
  gs.saveParamDef({ ParamName: '測試參數', Unit: '數值', DefaultValue: 1 });
  gs.deleteParamDef('測試參數');
  assert(!gs.getParamDefs().some(p => p.ParamName === '測試參數'), '自訂參數刪除');
  gs.deleteScenario(zs.ScenarioID);
});

check('另建營業淨利再刪掉 K：儀表板、GATE 報告、目標反推、快照改看新的淨利科目，數字不變', () => {
  reset();
  gs.saveVehicleType({ VehicleTypeID: 'DQ' });
  gs.saveVehicle({ VehicleID: 'Q1', VehicleTypeID: 'DQ', VehicleCode: 'Q車' });
  const qs = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE F', ScenarioName: '淨利替換', ScenarioType: '現況', VehicleTypeID: 'DQ' }, '', []);
  gs.saveSalesMixGrid(qs.ScenarioID, 'DQ', [{ RowID: '', VehicleID: 'Q1', SalesMixPct: 100, MonthlyVolume: 50, LifeCycleYears: 5, ListPriceTaxIncl: 800000 }]);
  const before = gs.calculateComparison([{ ScenarioID: qs.ScenarioID, VehicleID: '' }]).columns[0];
  assert(before.profitCode === 'K', '還有 K 時營業淨利就是 K：' + before.profitCode);
  const bev0 = gs.getGateReport('', qs.ScenarioID, '').target.breakEvenVolume;
  const y = gs.saveChartLine('DQ', { LineCode: '', LineName: '營業淨利Y', ParentLine: '', CalcType: 'FORMULA', Formula: 'I - J' }).line.LineCode;
  gs.deletePLLineItem('K', 'DQ');
  reset();
  const cmp = gs.calculateComparison([{ ScenarioID: qs.ScenarioID, VehicleID: '' }]);
  const col = cmp.columns[0];
  assert(col.profitCode === y, '刪掉 K 後營業淨利應改看 ' + y + '：' + col.profitCode);
  near(col.amounts[y], before.amounts.K, '新淨利科目的金額跟原本 K 相同');
  const yl = cmp.lines.find(l => l.LineCode === y);
  assert(yl && yl.isProfit && yl.isSubtotal, '新淨利科目在損益表上標成淨利/小計');
  const rpt = gs.getGateReport('', qs.ScenarioID, '');
  assert(rpt.profitCode === y && rpt.lines.find(l => l.LineCode === y).isProfit, 'GATE 報告的營業淨利科目');
  near(rpt.target.breakEvenVolume, bev0, '損益兩平月銷量不變', 0.5);
  assert(gs.getWhatIfOptions(qs.ScenarioID).profitCode === y, '目標反推的預設指標');
  near(gs.whatIfMetric_(qs.ScenarioID, { code: 'K', basis: 'unit' }), before.amounts.K, '存下來的指標還是 K 也看新的淨利科目');
  assert(gs.getChartEditor('DQ', qs.ScenarioID).profitCode === y, '科目編輯器的營業淨利');
  assert(!gs.getChartEditor('DQ', qs.ScenarioID).problems.some(p => p.code === y), '新淨利科目本身不該被提醒「沒有算進營業淨利」');
  gs.createSnapshot(qs.ScenarioID, '刪 K 後', '');
  near(gs.getSnapshots('DQ')[0].K, before.amounts.K, '快照清單的營業淨利');
});

check('刪掉 K 沒有另建淨利科目：營業淨利改看最後一個總計(I)，不會把手動輸入的前瞻費用(J)當成淨利', () => {
  const noK = gs.PL_LINE_ITEMS.filter(d => d.LineCode !== 'K');
  assert(gs.profitLineCode_(noK) === 'I', '應該是 I：' + gs.profitLineCode_(noK));
  // 新的淨利科目沒有放在最後一行也找得到(它沒有被其他公式引用)
  const yBeforeJ = noK.concat([{ LineCode: 'Y', LineName: '淨利Y', ParentLine: '', Category: '自訂', SortOrder: 70.5, CalcType: 'FORMULA', Formula: 'I - J' }]);
  assert(gs.profitLineCode_(yBeforeJ) === 'Y', '應該是 Y：' + gs.profitLineCode_(yBeforeJ));
  // 用名稱引用也算被引用
  const byName = noK.concat([{ LineCode: 'Y', LineName: '淨利Y', ParentLine: '', Category: '自訂', SortOrder: 90, CalcType: 'FORMULA', Formula: '[營業淨利(未扣前瞻)] - J' }]);
  assert(gs.profitLineCode_(byName) === 'Y', '名稱引用：' + gs.profitLineCode_(byName));
  reset();
  assert(gs.getChartEditor('DA', sid).nextProfitCode === 'I', '刪除 K 的確認視窗要說改用 I');
});

check('GATE 報告：現況是另一個還有 K 的車型時，各自看自己的營業淨利', () => {
  reset();
  const dq = gs.getScenarios('DQ').find(s => s.ScenarioName === '淨利替換');
  const y = gs.profitLineCode_(gs.getPLLineItems('DQ'));
  assert(y && y !== 'K', 'DQ 的淨利科目不是 K：' + y);
  const rpt = gs.getGateReport(sid, dq.ScenarioID, sid);
  assert(rpt.target.profitCode === y && rpt.base.profitCode === 'K' && rpt.prev.profitCode === 'K', '各情境的淨利科目：' + [rpt.target.profitCode, rpt.base.profitCode, rpt.prev.profitCode]);
  assert(rpt.base.weighted.K !== undefined && rpt.base.weighted[y] === undefined, '現況(DA)只有 K');
  ['K', y].forEach(c => assert(rpt.lines.find(l => l.LineCode === c).isProfit, c + ' 要標成營業淨利'));
});

check('公式編輯器：公式有錯時其他行照樣試算、參數值依車系加權平均', () => {
  reset();
  const res = gs.previewLineFormula('DA', sid, { LineCode: '', LineName: '測試', CalcType: 'FORMULA', Formula: 'P8 + [不存在的名稱]', Probes: ['P8', '[不存在的名稱]'] });
  assert(res.problems.length && !res.preview, '公式錯誤要回報');
  assert(res.probes && res.probes.probes, '還是要回傳各行的值');
  const vids = Object.keys(res.probes.probes);
  assert(vids.length, '有車系的值');
  vids.forEach(v => {
    near(res.probes.probes[v][0], amt(sid, v, 'P8'), v + ' 的 P8');
    assert(res.probes.probes[v][1] === null, v + ' 有錯的那一行是 null');
  });
  const mix = gs.getSalesMix(sid);
  const w = mix.reduce((s, r) => s + Number(r.SalesMixPct), 0);
  const expect = mix.reduce((s, r) => s + (r.VehicleID === 'V2' ? 0.10 : 0.13) * Number(r.SalesMixPct), 0) / w;
  near(gs.getChartEditor('DA', sid).paramValues['關稅率'], expect, '關稅率(V2 另外設 10%)', 1e-9);
});

check('預設公式下 Gate F 數字不變(回歸)', () => {
  reset();
  const all = gs.calculatePLAllVehicles(sid);
  near(all.weightedAverage.filter(l => l.LineCode === 'I')[0].Amount, -214924, '加權平均營業淨利(未扣前瞻)', 2);
});

const failed = results.filter(r => !r.ok);
results.forEach(r => console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' — ' + r.err}`));
console.log(failed.length ? `\n${failed.length} / ${results.length} 項未通過` : `\n全部 ${results.length} 項通過`);
process.exit(failed.length ? 1 : 0);
