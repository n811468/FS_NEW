/**
 * 驗證「Excel 轉資料包」(dist/FS-excel-to-pack.html 的核心邏輯)：
 *
 *   node tools/verify-excel-pack.js
 *
 * 1. .xlsx 讀取：共用字串、inlineStr、XML 跳脫字元、共用公式(往下/往右拖曳)展開、合併儲存格、隱藏分頁
 * 2. 版面判斷：科目名稱欄、車系欄(排除百分比欄與加權欄)、加權欄、說明欄
 * 3. 角色判斷：依 Excel 小計公式找出 B、群組、C、E/G/I/K 損益鏈、K 前面有兩個扣項時 J 變群組
 * 4. 建立 + 驗算：兩個分頁(同版面)各成一個情境，每一格跟 Excel 相同(含加權欄)
 * 4b. Excel 公式 → 系統公式：每一種寫法轉成什麼、轉不過去的原因、對不起來時自動改回數字、改參數結果會跟著動
 * 4c. 整張貼上值(沒有公式)：由數字推斷出跟有公式時一樣的結構
 * 4d. 開發總投攤提：追進開發總投分頁 → 開發攤提科目 + 部門投資 + 攤提台數；相消、低減%、ROUND、直接打數字回推
 * 5. 資料包：合併匯入一台全新的地端版主機後數字不變
 * 6. 沒有售價結構的極簡版面也轉得過去；對應設定有矛盾時會擋下來
 * 7. dist/FS-excel-to-pack.html 是最新的
 *
 * 測試檔是 tools/excel-fixture.js 自己組出來的 .xlsx，版面刻意跟 D5X 不同。
 * 另外可以指定一個真實的 Excel 一起跑(只印結果，不會存任何東西)：
 *   node tools/verify-excel-pack.js 某個檔案.xlsx
 */
const fs = require('fs');
const zlib = require('zlib');
const X = require('../local/xlsx-reader.js');
const E = require('../local/excel-pack.js');
const Pack = require('../local/pack.js');
const Host = require('../local/host.js');
const Shim = require('../local/gas-shim.js');
const build = require('./build-local');
const F = require('../local/excel-formula.js');
const fixture = require('./excel-fixture');

const failures = [];
let checks = 0;
function assert(cond, message) { checks++; if (!cond) failures.push(message); }
function near(a, b, message, tol) { assert(a !== null && a !== undefined && Math.abs(a - b) <= (tol || 0.01), `${message}：實際 ${a}，應為 ${b}`); }

const factory = build.loadBackendFactory();
function newHost() {
  const host = Host.createHost({ factory, shim: Shim, pack: Pack, storage: null, getUser: () => '測試' });
  host.start();
  return host;
}
const apiOf = host => new Proxy({}, { get: (_, name) => (...args) => host.call(name, args) });
const inflate = b => zlib.inflateRawSync(b);

/** 照工具畫面的預設值組出 plan(使用者什麼都不改、全部採用自動判斷) */
function autoPlan(wb, refIndex, sheetIndexes, typeId, extra) {
  const sheet = wb.sheets[refIndex];
  const layout = E.analyzeSheet(sheet);
  const rows = E.extractRows(sheet, layout);
  const sug = E.suggestRoles(rows, layout);
  const plan = {
    typeId, typeNotes: '', vehicles: layout.vehicles, weightedCol: layout.weightedCol, noteCol: layout.noteCol,
    labelCol: layout.labelCol, firstRow: layout.firstRow, rows, roles: sug.roles, workbook: wb
  };
  Object.assign(plan, extra || {});
  plan.scenarios = sheetIndexes.map(i => ({
    sheet: wb.sheets[i], name: wb.sheets[i].name, gate: 'GATE F', type: '現況',
    rates: E.inferRates(E.extractRows(wb.sheets[i], layout), sug.roles),
    mix: E.mixFor(wb.sheets[i], plan)
  }));
  return { plan, layout, notes: sug.notes };
}

async function main() {
  /* ---- 1. 讀取 ---- */
  const fx = fixture.fixtureWorkbook();
  const wb = await X.readWorkbook(fx.bytes, inflate);
  assert(wb.sheets.length === 4 && wb.sheets[2].hidden && !wb.sheets[0].hidden, '分頁數與隱藏狀態');
  const s0 = wb.sheets[0];
  const at = ref => { const p = X.parseRef(ref); return X.cell(s0, p.r, p.c); };
  assert(at('B33').v === '單位：元', 'inlineStr 文字：' + JSON.stringify(at('B33')));
  assert(at('J15').v === '依 BOM 估算 & 含運費 <暫估>', 'XML 跳脫字元：' + JSON.stringify(at('J15')));
  assert(at('E9').f === 'E7-E8' && at('F9').f === 'F7-F8', '往右拖曳的共用公式要平移：' + at('E9').f + ' / ' + at('F9').f);
  assert(at('G20').f === 'D20*$D$6+E20*$E$6+F20*$F$6', '往下拖曳的共用公式要平移、絕對參照不動：' + at('G20').f);
  assert(s0.merges.length === 1 && s0.merges[0].c1 === 4 && s0.merges[0].c2 === 7, '合併儲存格');
  assert(X.shiftFormula('SUM(D16:D20)+$O$7*LOG10(A1)+開發總投!E24+"D9"', 2, 1) === 'SUM(E18:E22)+$O$7*LOG10(B3)+開發總投!F26+"D9"',
    '公式平移不能動到函式名稱與字串');
  let bad = null;
  try { await X.readWorkbook(Buffer.from('not a zip at all'), inflate); } catch (e) { bad = e; }
  assert(bad && /不是 \.xlsx/.test(bad.message), '不是 xlsx 的檔案要有清楚的錯誤：' + (bad && bad.message));

  /* ---- 2. 版面 ---- */
  const { plan, layout, notes } = autoPlan(wb, 0, [0, 1], 'DQ');
  assert(layout.labelCol === 2, '科目名稱欄應為 B：' + layout.labelCol);
  assert(layout.vehicles.map(v => v.col + ':' + v.name).join() === '4:3人貨車,5:9人商用,6:9人接駁', '車系欄：' + JSON.stringify(layout.vehicles));
  assert(layout.weightedCol === 7, '加權欄應為 G：' + layout.weightedCol);
  assert(layout.noteCol === 10, '說明欄應為 J：' + layout.noteCol);
  assert(layout.firstRow === 6 && layout.lastRow === 31, '資料列範圍：' + layout.firstRow + '~' + layout.lastRow);

  /* ---- 3. 角色 ---- */
  const role = r => plan.roles[r] && plan.roles[r].role + (plan.roles[r].parent ? '@' + plan.roles[r].parent : '');
  const want = {
    6: 'mix', 7: 'price:list', 8: 'price:scrap', 9: 'check:P5', 10: 'check:P6', 11: 'check:P7', 12: 'check:P8',
    13: 'sub:B', 14: 'group@B', 15: 'detail@r14', 16: 'detail@r14', 17: 'detail@r14', 18: 'detail@B', 19: 'detail@B', 20: 'detail@B',
    21: 'sub:C', 22: 'detail@E', 23: 'detail@E', 24: 'sub:E', 25: 'detail@G', 26: 'sub:G', 27: 'detail@I', 28: 'sub:I',
    29: 'detail@J', 30: 'detail@J', 31: 'sub:K'
  };
  Object.keys(want).forEach(r => assert(role(r) === want[r], `第 ${r} 列角色：${role(r)}，應為 ${want[r]}`));
  assert(notes.length === 0, '四段損益鏈全部對得上，不應該有提醒：' + notes.join(' / '));
  assert(plan.scenarios[0].rates.營業稅率 === 5 && plan.scenarios[0].rates.銷售佣金率 === 7, '反推比率：' + JSON.stringify(plan.scenarios[0].rates));
  assert(plan.scenarios[0].mix.join() === '20,30,50', '構成比 0.2 → 20%：' + plan.scenarios[0].mix.join());
  assert(E.sameLayout(wb.sheets[1], plan).length === 0, '同版面的第二個分頁');
  assert(E.planProblems(plan).length === 0, '自動判斷的對應不應該有矛盾：' + E.planProblems(plan).join(' / '));

  /* ---- 4. 建立 + 驗算(含公式轉換與自動改回數字) ---- */
  const run = E.buildAndVerify(() => { const h = newHost(); return { host: h, api: apiOf(h) }; }, plan);
  const host = run.env.host, api = run.env.api, built = run.built, result = run.verify;
  result.forEach((res, si) => {
    assert(res.checked >= 100, `${res.sheetName} 比對格數太少：${res.checked}`);
    res.rows.forEach(row => row.cells.forEach((c, ci) => {
      if (c.ok === false) failures.push(`${res.sheetName} 第 ${row.row} 列 ${row.label} 第 ${ci + 1} 欄：系統 ${c.system}，Excel ${c.excel}`);
    }));
    // 跟測試檔自己算的值再對一次(不只是跟 Excel 快取值比)
    near(row31(api, built, res.scenarioId), fx.expected[si][31][3], `${res.sheetName} 加權營業淨利`);
  });
  const defs = api.getPLLineItems('DQ');
  const j = defs.find(d => d.LineCode === 'J');
  assert(j.CalcType === 'FORMULA' && defs.filter(d => d.ParentLine === 'J').length === 2, 'K 前面兩個扣項：J 應該變成群組');
  assert(defs.find(d => d.LineCode === 'K').LineName === '營業淨利', 'K 改成 Excel 的名稱');
  const lp = defs.find(d => d.LineName === '材料成本-LP');
  assert(lp && defs.find(d => d.LineCode === lp.ParentLine).LineName === '材料成本', '巢狀群組');
  const order = api.calculateComparison([{ ScenarioID: built.scenarioIds[0], VehicleID: '' }]).lines.map(l => l.LineName);
  assert(order.indexOf('材料成本-LP') < order.indexOf('直接人工') && order.indexOf('直接人工') < order.indexOf('貨物稅'), '科目順序照 Excel 列序');
  const notesSaved = api.getLineNotes(built.scenarioIds[0]);
  assert(JSON.stringify(notesSaved).indexOf('廠價 × 10%') !== -1, '說明欄帶進科目說明');
  assert(api.getScenarios('DQ').length === 2, '兩個分頁 → 兩個情境');

  /* ---- 4b. 公式轉換 ---- */
  const tr = built.translation;
  const show = r => F.displayFormula(tr.rows[r].formula, plan, tr.params);
  const fb = run.plan.fallback;
  const lineOf = r => defs.find(d => d.LineCode === built.codes[r]);
  assert(built.formulaRows[16] === 'formula' && show(16) === '[材料成本-KD(RMB)] × [CNY匯率] × (1 + [關稅率])', '第 16 列 RMB × 匯率 × (1+關稅率)：' + show(16));
  assert(/對不起來/.test(fb[17] || '') && !built.formulaRows[17], 'Excel 的 -2^2 跟系統算法不同：要自動改回數字：' + fb[17]);
  assert(built.formulaRows[18] === 'formula' && Object.keys(tr.rows[18].vehicleFormulas).length === 2 &&
    Object.keys(JSON.parse(lineOf(18).VehicleFormulas || '{}')).length === 2, '各車系係數不同 → 車系個別公式');
  assert(tr.rows[19].mode === 'input' && !tr.rows[19].reason && /照抄/.test(tr.rows[19].note), '頂規 = 入門(照抄) → 數字並註明：' + JSON.stringify(tr.rows[19]));
  assert(built.formulaRows[20] && show(20) === 'ROUND([廠價(未稅)] × [貨物稅率], 0)', '標籤是「貨物稅率」→ 內建參數：' + show(20));
  assert(/其他分頁「參數」B2/.test(tr.rows[22].reason), '引用其他分頁：' + tr.rows[22].reason);
  assert(/IFERROR/.test(tr.rows[23].reason), '系統沒有的函式：' + tr.rows[23].reason);
  assert(built.formulaRows[25] && show(25) === 'ROUND([廣宣費用] × (57.52/100), 0)', '百分比常數：' + show(25));
  assert(/「3人貨車」欄|「9人商用」欄/.test(tr.rows[27].reason), '引用其他車系欄：' + tr.rows[27].reason);
  assert(/各分頁/.test(tr.rows[29].reason), '兩個分頁的公式不同：' + tr.rows[29].reason);
  assert(built.formulaRows[30] === 'mixed' && lineOf(30).CalcType === 'INPUT' && Object.keys(JSON.parse(lineOf(30).VehicleFormulas)).length === 2,
    '一個車系是數字、其他是公式 → 數字 + 車系個別公式');
  const params = api.getParameters(built.scenarioIds[0]).filter(p => p.ScenarioID === built.scenarioIds[0]);
  const pv = (n, vid) => (params.find(p => p.ParamName === n && (p.VehicleID || '') === (vid || '')) || {}).Value;
  assert(pv('關稅率') === 10 && pv('貨物稅率') === 10, '參數值(% 以百分比數值儲存)：關稅率 ' + pv('關稅率') + '、貨物稅率 ' + pv('貨物稅率'));
  assert(pv('材料成本-KD(RMB)', built.vehicleIds[1]) === 75000, '車系別參數');
  assert(params.some(p => p.ParamName === '現況匯率' && p.Currency === 'CNY' && p.Value === 4.5), '匯率寫進匯率設定');
  // 轉成公式之後，改參數結果要跟著動(這就是轉公式的目的)
  const tariff = params.find(p => p.ParamName === '關稅率' && !p.VehicleID);
  api.saveRateGrid(built.scenarioIds[0], [{ ParamID: tariff.ParamID, ParamName: '關稅率', VehicleID: '', Value: 20 }]);
  const kd = api.calculatePLAllVehicles(built.scenarioIds[0]).vehicles[0].lines.find(l => l.LineCode === built.codes[16]).Amount;
  near(kd, 75000 * 4.5 * 1.2, '關稅率改成 20% 後 KD 成本跟著變');
  api.saveRateGrid(built.scenarioIds[0], [{ ParamID: tariff.ParamID, ParamName: '關稅率', VehicleID: '', Value: 10 }]);

  // 關掉公式轉換：全部帶入數字，一樣跟 Excel 相同
  const off = E.buildAndVerify(() => { const h = newHost(); return { host: h, api: apiOf(h) }; }, Object.assign({}, plan, { useFormulas: false }));
  assert(Object.keys(off.built.formulaRows).length === 0 && off.verify.every(v => v.ok), '關閉公式轉換時全部帶入數字且驗算通過');

  /* ---- 4c. 貼上值 ---- */
  const flatPlan = autoPlan(wb, 3, [3], 'DQV');
  const flatRole = r => flatPlan.plan.roles[r] && flatPlan.plan.roles[r].role + (flatPlan.plan.roles[r].parent ? '@' + flatPlan.plan.roles[r].parent : '');
  const structural = [13, 14, 15, 16, 21, 24, 26, 28, 29, 30, 31, 12, 9];
  structural.forEach(r => assert(flatRole(r) === want[r], `貼上值第 ${r} 列：${flatRole(r)}，應與有公式時相同(${want[r]})`));
  assert(flatPlan.plan.rows.find(r => r.row === 14).shape.inferred && F.describeShape(flatPlan.plan.rows.find(r => r.row === 13).shape, 4) === 'D14+SUM(D18:D20)',
    '推斷的算式：' + F.describeShape(flatPlan.plan.rows.find(r => r.row === 13).shape, 4));
  const flatRun = E.buildAndVerify(() => { const h = newHost(); return { host: h, api: apiOf(h) }; }, flatPlan.plan);
  assert(flatRun.verify[0].ok, '貼上值的分頁也要逐格相同');

  /* ---- 4d. 開發總投攤提 ---- */
  const am = fixture.amortWorkbook();
  const wb3 = await X.readWorkbook(am.bytes, inflate);
  const ap = autoPlan(wb3, 0, [0, 1], 'XA', { backcalc: { 12: true } });
  ap.plan.scenarios[1].type = '目標';
  const aRun = E.buildAndVerify(() => { const h = newHost(); return { host: h, api: apiOf(h) }; }, ap.plan);
  const aApi = aRun.env.api, aBuilt = aRun.built, aTr = aBuilt.translation;
  assert(aRun.verify.every(v => v.ok), '開發攤提的兩個情境逐格跟 Excel 相同：' + aRun.verify.map(v => v.mismatches).join('/'));
  ['7', '8', '9', '10'].forEach(r => assert(aBuilt.formulaRows[r] === 'amort', `第 ${r} 列應該變成開發攤提：${aBuilt.formulaRows[r]} ${aTr.rows[r].amortReason || ''}`));
  const depts = r => aTr.rows[r].amort[0].investments.map(x => x.dept).sort().join();
  assert(depts(9) === '生技部,開發部', 'CMC開發費 = 費用總計 - 上汽：上汽要相消，而且「CMC費用」那列不是一筆投資：' + depts(9));
  assert(depts(8) === '品管部,生技部', '設備費只加 Excel 總計範圍內的部門(不含治具)：' + depts(8));
  assert(aTr.rows[7].category === '模具' && aTr.rows[8].category === '設備' && aTr.rows[9].category === '費用', '攤提大類依欄標題');
  assert(/ROUND/.test(aTr.rows[11].amortReason || '') && !aBuilt.formulaRows[11], 'ROUND 的攤提帶入數字並說明：' + aTr.rows[11].amortReason);
  assert(aBuilt.formulaRows[12] === 'backcalc', '直接打數字的檢具攤提：使用者選擇用攤提台數回推');
  const aDefs = aApi.getPLLineItems('XA');
  assert(aDefs.filter(d => d.CalcType === 'DEV_AMORT').length === 5, '5 個開發攤提科目');
  const [sid0, sid1] = aBuilt.scenarioIds;
  near(aApi.getLifeCycleUnits(sid0), 40000, '攤提台數(L/C 40000 台)');
  const sc0 = aApi.getScenarios('XA').find(x => x.ScenarioID === sid0);
  assert(sc0.AmortLifeCycleYears === 4, 'L/C 48 個月 → 4 年：' + sc0.AmortLifeCycleYears);
  const dev0 = aApi.getDevInvestmentSummary(sid0), dev1 = aApi.getDevInvestmentSummary(sid1);
  assert(dev0.rows.length === 7 && dev0.rows.some(x => x.Department === '檢具攤提(由單台回推)' && Math.abs(x.Amount - 1500 * 40000) < 1e-6),
    '開發總投頁有部門明細與回推的投資：' + dev0.rows.map(x => x.Department + ':' + x.Amount).join(', '));
  const cut = dev1.rows.filter(x => x.ChallengeReductionPct === 10);
  assert(cut.length === 5 && cut.some(x => x.Department === '開發部' && Math.abs(x.Amount - 300000000 / 0.9) < 1e-3),
    '目標情境：「原始 × (1 - 低減率)」帶原始金額與挑戰低減 10%：' + dev1.rows.map(x => x.Department + ':' + x.Amount + '-' + x.ChallengeReductionPct).join(', '));
  // 連動：攤提台數加倍 → 單台攤提減半(帶入數字的話不會動)
  const moldCode = aBuilt.codes[7];
  const moldAt = sid => aApi.calculatePLAllVehicles(sid).vehicles[0].lines.find(l => l.LineCode === moldCode).Amount;
  const before = moldAt(sid0);
  aApi.saveAmortBasis(sid0, 40000 / 48 * 2, 4);
  near(moldAt(sid0), before / 2, '攤提台數加倍，模具單台攤提減半');
  // 同一份資料改成現況情境：低減不套用(系統的現況情境沒有挑戰低減)，所以不能帶原始金額 → 一定要依情境性質帶
  const ap2 = autoPlan(wb3, 0, [1], 'XB');
  const cutRun = E.buildAndVerify(() => { const h = newHost(); return { host: h, api: apiOf(h) }; }, ap2.plan);
  assert(cutRun.verify[0].ok && cutRun.env.api.getDevInvestmentSummary(cutRun.built.scenarioIds[0]).rows.every(x => !x.ChallengeReductionPct),
    '現況情境引用低減版：帶低減後金額、不帶低減%');
  const noAmort = autoPlan(wb3, 0, [0], 'XC', { useAmort: false });
  const r3 = E.buildAndVerify(() => { const h = newHost(); return { host: h, api: apiOf(h) }; }, noAmort.plan);
  assert(r3.verify[0].ok && !Object.values(r3.built.formulaRows).some(m => m === 'amort'), '關閉開發攤提追蹤時全部帶入數字');

  /* ---- 5. 資料包 ---- */
  const pack = host.exportPack(['DQ']);
  const fresh = newHost();
  fresh.mergePack(Pack.parsePack(JSON.stringify(pack)));
  const again = E.verifyPlan(apiOf(fresh), plan, built);
  assert(again.every(r => r.ok), '資料包匯入全新主機後重算，仍然跟 Excel 相同');

  /* ---- 6. 極簡版面、錯誤 ---- */
  const mini = fixture.minimalFs();
  const wb2 = await X.readWorkbook(fixture.makeXlsx([mini.sheet]), inflate);
  const p2 = autoPlan(wb2, 0, [0], 'XS');
  assert(p2.layout.labelCol === 1 && p2.layout.vehicles.map(v => v.name).join() === '車型A,車型B' && !p2.layout.weightedCol, '極簡版面的欄位：' + JSON.stringify(p2.layout.vehicles));
  const r2 = r => p2.plan.roles[r].role + (p2.plan.roles[r].parent ? '@' + p2.plan.roles[r].parent : '');
  assert([2, 3, 4, 5, 6].map(r2).join() === 'check:P8,detail@B,detail@B,sub:B,sub:C', '極簡版面角色：' + [2, 3, 4, 5, 6].map(r2).join());
  const h2 = newHost();
  const b2 = E.buildFromPlan(apiOf(h2), p2.plan);
  const v2 = E.verifyPlan(apiOf(h2), p2.plan, b2);
  assert(v2[0].ok && v2[0].checked === 10, '沒有售價結構也能轉，收入直接帶入：' + JSON.stringify(v2[0].rows.map(r => r.cells.map(c => c.system))));
  near(apiOf(h2).calculatePLAllVehicles(b2.scenarioIds[0]).vehicles[1].lines.find(l => l.LineCode === 'K').Amount, mini.expected[6][1], '極簡版面 K = 毛利');

  const broken = Object.assign({}, p2.plan, { typeId: '', roles: Object.assign({}, p2.plan.roles, { 3: { role: 'detail', parent: '' }, 5: { role: 'sub:B', parent: '' }, 6: { role: 'sub:B', parent: '' } }) });
  const probs = E.planProblems(broken);
  assert(probs.some(p => /車型代號/.test(p)) && probs.some(p => /只能對應一列/.test(p)) && probs.some(p => /沒有選要掛在哪個小計/.test(p)), '矛盾的對應要擋下來：' + probs.join(' / '));
  let threw = null;
  try { E.buildFromPlan(apiOf(newHost()), broken); } catch (e) { threw = e; }
  assert(threw, '有矛盾時 buildFromPlan 不應該建立任何資料');

  /* ---- 7. dist ---- */
  const distOk = fs.existsSync(build.EXCEL_OUT_FILE) && fs.readFileSync(build.EXCEL_OUT_FILE, 'utf8') === build.buildExcelPackHtml();
  assert(distOk, 'dist/FS-excel-to-pack.html 不是最新的：改了 local/ 或 src/ 之後請執行 node tools/build-local.js');

  /* ---- 指定的真實 Excel(選用) ---- */
  if (process.argv[2]) await realFile(process.argv[2]);

  if (failures.length) {
    console.log(`Excel 轉資料包驗證失敗：${failures.length} 項`);
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`Excel 轉資料包驗證通過：${checks} 項全部符合（讀檔、版面與角色判斷、兩個情境逐格與 Excel 相同、資料包可匯入、dist 為最新）。`);
}

function row31(api, built, sid) {
  return api.calculatePLAllVehicles(sid).weightedAverage.find(l => l.LineCode === built.codes[31]).Amount;
}

async function realFile(file) {
  const wb = await X.readWorkbook(fs.readFileSync(file), inflate);
  const ref = wb.sheets.findIndex(s => !s.hidden && s.maxRow > 0);
  const layout = E.analyzeSheet(wb.sheets[ref]);
  const probe = autoPlan(wb, ref, [ref], 'TEST');
  const same = wb.sheets.map((s, i) => i).filter(i => !wb.sheets[i].hidden && wb.sheets[i].maxRow > 0 && E.sameLayout(wb.sheets[i], probe.plan).length === 0);
  const { plan } = autoPlan(wb, ref, same, 'TEST');
  const host = newHost();
  const built = E.buildFromPlan(apiOf(host), plan);
  const res = E.verifyPlan(apiOf(host), plan, built);
  console.log(`\n${file}：參考分頁「${wb.sheets[ref].name}」，車系 ${layout.vehicles.map(v => v.name).join('/')}，${same.length} 個同版面分頁`);
  res.forEach(r => console.log(`  ${r.ok ? '✓' : '✗'} ${r.sheetName}：${r.checked - r.mismatches}/${r.checked} 格相同`));
}

main().catch(e => { console.error(e); process.exit(1); });
