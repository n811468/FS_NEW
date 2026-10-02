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
  throws(() => gs.setLineOrder('DA', [{ LineCode: 'B', ParentLine: 'E' }]), /結構科目/, '結構科目不能換父科目');
  gs.setVehicleOrder('DA', ['V1', 'V2', 'V3']);
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

check('預設公式下 Gate F 數字不變(回歸)', () => {
  reset();
  const all = gs.calculatePLAllVehicles(sid);
  near(all.weightedAverage.filter(l => l.LineCode === 'I')[0].Amount, -214924, '加權平均營業淨利(未扣前瞻)', 2);
});

const failed = results.filter(r => !r.ok);
results.forEach(r => console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' — ' + r.err}`));
console.log(failed.length ? `\n${failed.length} / ${results.length} 項未通過` : `\n全部 ${results.length} 項通過`);
process.exit(failed.length ? 1 : 0);
