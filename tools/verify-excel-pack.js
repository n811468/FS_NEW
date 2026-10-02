/**
 * 驗證「Excel 轉資料包」(dist/FS-excel-to-pack.html 的核心邏輯)：
 *
 *   node tools/verify-excel-pack.js
 *
 * 1. .xlsx 讀取：共用字串、inlineStr、XML 跳脫字元、共用公式(往下/往右拖曳)展開、合併儲存格、隱藏分頁
 * 2. 版面判斷：科目名稱欄、車系欄(排除百分比欄與加權欄)、加權欄、說明欄
 * 3. 角色判斷：依 Excel 小計公式找出 B、群組、C、E/G/I/K 損益鏈、K 前面有兩個扣項時 J 變群組
 * 4. 建立 + 驗算：兩個分頁(同版面)各成一個情境，每一格跟 Excel 相同(含加權欄)
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
function autoPlan(wb, refIndex, sheetIndexes, typeId) {
  const sheet = wb.sheets[refIndex];
  const layout = E.analyzeSheet(sheet);
  const rows = E.extractRows(sheet, layout);
  const sug = E.suggestRoles(rows, layout);
  const plan = {
    typeId, typeNotes: '', vehicles: layout.vehicles, weightedCol: layout.weightedCol, noteCol: layout.noteCol,
    labelCol: layout.labelCol, rows, roles: sug.roles
  };
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
  assert(wb.sheets.length === 3 && wb.sheets[2].hidden && !wb.sheets[0].hidden, '分頁數與隱藏狀態');
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

  /* ---- 4. 建立 + 驗算 ---- */
  const host = newHost();
  const api = apiOf(host);
  const built = E.buildFromPlan(api, plan);
  const result = E.verifyPlan(api, plan, built);
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
