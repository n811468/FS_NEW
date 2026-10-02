/**
 * 這次改動的行為驗證（跑在同一套記憶體版試算表上）：
 *
 *   node tools/verify-features.js
 *
 * 涵蓋：情境帶入、科目代碼自動編號與直接編輯、集團預算匯率移除、
 * 銷貨成本矩陣的加權欄位資料、以及銷貨成本明細不再因為沒填金額就消失。
 */
const { loadAppsScript } = require('./fake-apps-script');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (e) {
    results.push({ name: name, ok: false, message: e.message });
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
function assertEqual(actual, expected, message) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${message}：實際 ${actual}，預期 ${expected}`);
  }
}

const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'DataService.gs', 'CalcEngine.gs', 'SetupSheets.gs']);
gs.setupSpreadsheet();
gs.saveVehicleType({ VehicleTypeID: 'DA' });
gs.saveVehicleType({ VehicleTypeID: 'DE' });
gs.saveVehicle({ VehicleID: 'V1', VehicleTypeID: 'DA', VehicleCode: '3人貨車' });
gs.saveVehicle({ VehicleID: 'V2', VehicleTypeID: 'DA', VehicleCode: '9人客貨車' });
gs.saveVehicle({ VehicleID: 'W1', VehicleTypeID: 'DE', VehicleCode: 'DE車系' });

const base = gs.createScenarioFrom({
  ScenarioID: '', Gate: 'GATE F', ScenarioName: '現況', ScenarioType: '現況', VehicleTypeID: 'DA'
}, '', []);

gs.saveSalesMixGrid(base.ScenarioID, 'DA', [
  { RowID: '', VehicleID: 'V1', SalesMixPct: 40, MonthlyVolume: 40, LifeCycleYears: 10, ListPriceTaxIncl: 1000000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' },
  { RowID: '', VehicleID: 'V2', SalesMixPct: 60, MonthlyVolume: 60, LifeCycleYears: 10, ListPriceTaxIncl: 1200000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }
]);
gs.saveCostOfSalesMatrix(base.ScenarioID, [
  { RowID: '', VehicleID: 'V1', LineCode: 'b1', Amount: 400000, Currency: 'TWD' },
  { RowID: '', VehicleID: 'V2', LineCode: 'b1', Amount: 500000, Currency: 'TWD' }
]);
gs.saveDevInvestmentGrid(base.ScenarioID, [
  { RowID: '', Department: '生技部', AssetType: '模具', Amount: 12000000, Currency: 'TWD', ChallengeReductionPct: '' }
]);

check('以既有情境為基礎建立新情境，資料會整批帶過去', () => {
  const target = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE F', ScenarioName: '目標 26/8', ScenarioType: '目標', VehicleTypeID: 'DA'
  }, base.ScenarioID, ['salesmix', 'costofsales', 'devinvestment']);

  assertEqual(gs.getSalesMix(target.ScenarioID).length, 2, '帶入後的銷售構成列數');
  assertEqual(gs.getCostOfSales(target.ScenarioID).length, 2, '帶入後的銷貨成本列數');
  assertEqual(gs.getDevInvestment(target.ScenarioID).length, 1, '帶入後的開發總投列數');
  // 來源情境不能被動到
  assertEqual(gs.getSalesMix(base.ScenarioID).length, 2, '來源情境的銷售構成列數');
  // 挑戰低減目標屬於目標情境自己的假設，帶入後要歸零
  assertEqual(gs.getDevInvestment(target.ScenarioID)[0].ChallengeReductionPct, '', '帶入後的挑戰低減目標');
});

check('不能跨車型帶入（車系對不上會算出看不見的成本）', () => {
  const other = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE F', ScenarioName: 'DE 現況', ScenarioType: '現況', VehicleTypeID: 'DE'
  }, '', []);
  let threw = '';
  try { gs.copyScenarioData(base.ScenarioID, other.ScenarioID, ['salesmix']); }
  catch (e) { threw = e.message; }
  assert(threw.indexOf('只能從同一個車型') === 0, '應該擋下跨車型帶入，實際訊息：' + (threw || '(沒有丟錯)'));
});

check('新增科目時代碼自動編流水號', () => {
  const created = gs.addLineItemInline('B', '測試成本項目');
  assertEqual(created.LineCode, 'b15', '自動產生的成本科目代碼');   // b1~b14 已被內建科目用掉
  const created2 = gs.savePLLineItemGrid([{ LineCode: '', LineName: '第二個測試項目', ParentLine: 'E' }])
    .filter(d => d.LineName === '第二個測試項目')[0];
  assertEqual(created2.LineCode, 'd6', '自動產生的費用科目代碼');   // d1~d5 已被內建科目用掉
});

check('科目直接改名/改排序，一次儲存就生效', () => {
  const before = gs.getPLLineItems().filter(d => d.LineCode === 'b15')[0];
  assert(before, '找不到剛新增的 b15');
  gs.savePLLineItemGrid([
    { LineCode: 'b15', LineName: '改過名字的項目', ParentLine: 'B', Category: '成本明細', SortOrder: 26.5 }
  ]);
  const after = gs.getPLLineItems().filter(d => d.LineCode === 'b15')[0];
  assertEqual(after.LineName, '改過名字的項目', '改名後的科目名稱');
  assertEqual(after.SortOrder, 26.5, '改過的排序值');
});

check('結構科目與自動計算科目不可刪除，父科目也改不掉', () => {
  let threw = 0;
  try { gs.deletePLLineItem('B'); } catch (e) { threw++; }
  try { gs.deletePLLineItem('b13'); } catch (e) { threw++; }
  assertEqual(threw, 2, '應該擋下的刪除次數');

  gs.savePLLineItemGrid([{ LineCode: 'b13', LineName: '貨物稅', ParentLine: 'E', SortOrder: 34 }]);
  assertEqual(gs.getPLLineItems().filter(d => d.LineCode === 'b13')[0].ParentLine, 'B',
    '自動計算科目的父科目應維持原值');
});

check('匯率設定只剩現況匯率', () => {
  const grid = gs.getFxGrid(base.ScenarioID);
  assertEqual(grid.paramNames.length, 1, '匯率種類數量');
  assertEqual(grid.paramNames[0], '現況匯率', '唯一的匯率種類');
  assert(gs.DEFAULT_PARAMS['集團預算匯率'] === undefined, '預設參數不應再有集團預算匯率');
});

check('清除未使用的參數會刪掉舊的集團預算匯率資料', () => {
  gs.saveParameterRow({
    ParamID: '', ScenarioID: base.ScenarioID, VehicleID: '',
    ParamName: '集團預算匯率', Currency: 'CNY', Value: 4.5, EffectiveDate: ''
  });
  assertEqual(gs.getParameters(base.ScenarioID).filter(p => p.ParamName === '集團預算匯率').length, 1,
    '清除前的殘留列數');
  gs.removeUnusedParameters();
  assertEqual(gs.getParameters(base.ScenarioID).filter(p => p.ParamName === '集團預算匯率').length, 0,
    '清除後的殘留列數');
});

check('成本矩陣帶出銷售構成比，讓畫面可以算加權平均', () => {
  const matrix = gs.getCostOfSalesMatrix(base.ScenarioID, 'DA');
  assertEqual(matrix.vehicles.length, 2, '車系數量');
  assertEqual(matrix.vehicles[0].SalesMixPct, 40, 'V1 的銷售構成比');
  assertEqual(matrix.vehicles[1].SalesMixPct, 60, 'V2 的銷售構成比');

  // 畫面上的加權平均算法：Σ(金額×構成比) ÷ Σ構成比
  const weighted = (400000 * 40 + 500000 * 60) / 100;
  assertEqual(weighted, 460000, 'b1 材料成本-LP 的加權平均');
});

check('沒填金額的成本科目仍會出現，B 才等於畫面上明細的加總', () => {
  const result = gs.calculatePL(base.ScenarioID, 'V1');
  const codes = result.lines.map(l => l.LineCode);
  ['b3', 'b9', 'b10', 'b11', 'b12'].forEach(code => {
    assert(codes.indexOf(code) !== -1, `沒填金額的 ${code} 也應該列出來`);
  });
  const detailSum = result.lines
    .filter(l => l.ParentLine === 'B')
    .reduce((s, l) => s + l.Amount, 0);
  const b = result.lines.filter(l => l.LineCode === 'B')[0].Amount;
  assert(Math.abs(detailSum - b) < 0.01, `B ${b} 應等於成本明細加總 ${detailSum}`);
});

check('儀表板的小計驗算對正常資料不應報警', () => {
  const cmp = gs.calculateComparison([
    { ScenarioID: base.ScenarioID, VehicleID: 'V1' },
    { ScenarioID: base.ScenarioID, VehicleID: '' }
  ]);
  cmp.columns.forEach(col => {
    assertEqual((col.checks || []).length, 0, `${col.label} 的小計驗算差異數`);
    assert(col.exFactoryPrice > 0, `${col.label} 應該有廠價可以當百分比基準`);
  });
  assert(cmp.lines.some(l => l.isPriceStructure), '應該標示出售價結構科目');
  assert(cmp.lines.some(l => l.isSubtotal), '應該標示出小計科目');
});

check('舊版留下的科目名稱會自動對回程式碼（欄位名稱不再跟數字對不起來）', () => {
  // 重現使用者 Sheet 的狀態：舊版售價結構只有 8 列，P2 是廢車處理費、P7 才是廠價。
  // 改版重新編號後 seedPLLineItems_ 不覆蓋既有名稱，於是新代碼配著舊名稱留在 Sheet 上。
  const stale = {
    P2: '廢車處理費(換算含稅)', P3: '實際零售價(含稅)(=P1-P2)', P4: '營業稅(內含反推)',
    P5: '銷售佣金', P6: '實際零售價(未稅)', P7: '廠價(未稅)', P8: '強配件售價',
    f3: '車型專案開發費用-CMC(單台攤提)'
  };
  Object.keys(stale).forEach(code => {
    const row = gs.getPLLineItems().filter(d => d.LineCode === code)[0];
    gs.upsertRow_('PLLineItems', 'LineCode', Object.assign({}, row, { LineName: stale[code] }));
  });
  assertEqual(gs.getPLLineItems().filter(d => d.LineCode === 'P2')[0].LineName, stale.P2, '前置：P2 應為舊名稱');

  // 開啟頁面就會自動修好，使用者不必知道有維護選單
  gs.getBootstrap('DA');

  const nameOf = code => gs.getPLLineItems().filter(d => d.LineCode === code)[0].LineName;
  assert(nameOf('P2').indexOf('強配件售價') === 0, `P2 應為強配件售價，實際 ${nameOf('P2')}`);
  assert(nameOf('P4').indexOf('廢車處理費') === 0, `P4 應為廢車處理費，實際 ${nameOf('P4')}`);
  assert(nameOf('P6').indexOf('營業稅') === 0, `P6 應為營業稅，實際 ${nameOf('P6')}`);
  assert(nameOf('P8').indexOf('廠價(未稅)') === 0, `P8 應為廠價，實際 ${nameOf('P8')}`);
  assert(nameOf('f3').indexOf('開發總投') !== -1, `f3 名稱應說明攤提來源，實際 ${nameOf('f3')}`);

  // 名稱與數字必須指的是同一件事：P8 的數字就是廠價 = P5-P6-P7
  const lines = gs.calculatePL(base.ScenarioID, 'V1').lines;
  const v = code => lines.filter(l => l.LineCode === code)[0].Amount;
  assert(Math.abs(v('P8') - (v('P5') - v('P6') - v('P7'))) < 0.01, 'P8 的數字應為 P5-P6-P7');
});

check('明細科目的名稱不會被自動修復蓋掉', () => {
  gs.savePLLineItemGrid([{ LineCode: 'b1', LineName: '材料成本-LP(自己改的)', ParentLine: 'B', Category: '成本明細', SortOrder: 21 }]);
  gs.getBootstrap('DA');
  assertEqual(gs.getPLLineItems().filter(d => d.LineCode === 'b1')[0].LineName, '材料成本-LP(自己改的)',
    '使用者改過的明細科目名稱應該保留');
  // 一鍵回復才會把它還原
  gs.restoreBuiltInLineItems();
  assertEqual(gs.getPLLineItems().filter(d => d.LineCode === 'b1')[0].LineName, '材料成本-LP',
    '回復內建預設值後的明細科目名稱');
});

check('開發總投的攤提落點由選項決定，f4 BASE廠不再靠部門名稱猜', () => {
  const sid = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE E', ScenarioName: '攤提測試', ScenarioType: '現況', VehicleTypeID: 'DA'
  }, base.ScenarioID, ['salesmix']).ScenarioID;

  gs.saveDevInvestmentGrid(sid, [
    { RowID: '', Department: '生技部', AssetType: '模具', Amount: 1000, Currency: 'TWD' },
    { RowID: '', Department: '生技部', AssetType: '設備', Amount: 2000, Currency: 'TWD' },
    // 部門名稱刻意不叫「BASE廠開發費」—— 舊邏輯會把它整筆算進 f3
    { RowID: '', Department: '中華 CMC', AssetType: '費用-CMC', Amount: 4000, Currency: 'TWD' },
    { RowID: '', Department: '大陸廠', AssetType: '費用-BASE廠', Amount: 8000, Currency: 'TWD' }
  ]);

  const units = gs.getLifeCycleUnits(sid);
  assert(units > 0, 'LIFE CYCLE 總台數應大於 0');
  const summary = gs.getDevInvestmentSummary(sid);
  const byLine = {};
  summary.targets.forEach(t => { byLine[t.LineCode] = t.Total; });
  assertEqual(byLine.b5, 1000, '模具應攤到 b5');
  assertEqual(byLine.b8, 2000, '設備應攤到 b8');
  assertEqual(byLine.f3, 4000, '費用-CMC 應攤到 f3');
  assertEqual(byLine.f4, 8000, '費用-BASE廠 應攤到 f4（不看部門名稱）');

  const lines = gs.calculatePL(sid, 'V1').lines;
  const v = code => lines.filter(l => l.LineCode === code)[0].Amount;
  assert(Math.abs(v('f4') - 8000 / units) < 1e-9, `f4 單台攤提應為 ${8000 / units}，實際 ${v('f4')}`);
  assert(v('f4') > 0, 'f4 不應為 0');
  // 每一列都看得到自己會攤到哪個科目
  const baseRow = summary.rows.filter(r => r.Department === '大陸廠')[0];
  assertEqual(baseRow.TargetLineCode, 'f4', '畫面上該列顯示的攤提落點');
});

check('舊的「費用」資料仍照原本的規則攤提，並自動轉成新選項', () => {
  const sid = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE D', ScenarioName: '舊資料', ScenarioType: '現況', VehicleTypeID: 'DA'
  }, base.ScenarioID, ['salesmix']).ScenarioID;

  // 直接寫入舊格式的列（AssetType = '費用'），模擬既有 Sheet
  gs.saveDevInvestmentRow({ RowID: '', ScenarioID: sid, Department: 'BASE廠開發費', AssetType: '費用', Amount: 9000, Currency: 'TWD' });
  gs.saveDevInvestmentRow({ RowID: '', ScenarioID: sid, Department: '研發處', AssetType: '費用', Amount: 3000, Currency: 'TWD' });

  const summary = gs.getDevInvestmentSummary(sid);
  const byLine = {};
  summary.targets.forEach(t => { byLine[t.LineCode] = t.Total; });
  assertEqual(byLine.f4, 9000, '舊資料的 BASE廠開發費仍應落在 f4');
  assertEqual(byLine.f3, 3000, '舊資料的其他部門仍應落在 f3');
  // 讀進畫面時就把落點解析成 TargetLineCode，使用者一存檔就寫回去
  assertEqual(summary.rows.filter(r => r.Department === 'BASE廠開發費')[0].TargetLineCode, 'f4',
    '舊「費用」應解析成落點 f4');
  assertEqual(summary.rows.filter(r => r.Department === '研發處')[0].TargetLineCode, 'f3',
    '舊「費用」應解析成落點 f3');
  // 轉換後的值存得回去
  gs.saveDevInvestmentGrid(sid, summary.rows);
});

check('銷貨成本頁看得到自動計算科目與貨物稅計算過程', () => {
  const matrix = gs.getCostOfSalesMatrix(base.ScenarioID, 'DA');
  const autoCodes = matrix.autoLines.map(l => l.value);
  assert(autoCodes.indexOf('b13') !== -1, '貨物稅(b13)應該出現在自動計算科目');
  assert(autoCodes.indexOf('b5') !== -1, '模具費用(b5)應該出現在自動計算科目');
  assert(matrix.autoValues.b13.V1 > 0, 'V1 的貨物稅應該算得出數字');
  const detail = matrix.commodityTaxDetail.V1;
  assert(detail && detail.tax === matrix.autoValues.b13.V1, '貨物稅計算過程的 tax 應該跟 autoValues 的金額一致');
  assert(detail.deductTotal > 0, '完稅價格的扣除項(廣宣/促銷/批標售/季Margin)應該有值');
});

check('車系可以自訂排列順序，影響銷貨成本矩陣等所有用車系排欄位的地方', () => {
  const sid = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE C', ScenarioName: '排序測試', ScenarioType: '現況', VehicleTypeID: 'DA'
  }, '', []).ScenarioID;
  gs.saveVehicle({ VehicleID: 'V1', VehicleTypeID: 'DA', VehicleCode: '3人貨車', SortOrder: 2 });
  gs.saveVehicle({ VehicleID: 'V2', VehicleTypeID: 'DA', VehicleCode: '9人客貨車', SortOrder: 1 });
  const order1 = gs.getVehicles('DA').map(v => v.VehicleID);
  assertEqual(order1.indexOf('V2') < order1.indexOf('V1'), true, 'SortOrder 較小的車系應該排在前面');
  const matrixVehicles = gs.getCostOfSalesMatrix(sid, 'DA').vehicles.map(v => v.VehicleID);
  assertEqual(matrixVehicles.join(','), order1.join(','), '銷貨成本矩陣的欄位順序應該跟車系排序一致');

  // 調整排序後，順序要跟著變
  gs.saveVehicle({ VehicleID: 'V1', VehicleTypeID: 'DA', VehicleCode: '3人貨車', SortOrder: 0 });
  const order2 = gs.getVehicles('DA').map(v => v.VehicleID);
  assertEqual(order2.indexOf('V1') < order2.indexOf('V2'), true, '改小排序值後應該排到前面');
});

check('開發總投攤提落點分成設備/模具/費用三大類，可以在對應大類下新增新落點', () => {
  const options = gs.getDevAmortTargetOptions();
  const byCode = {};
  options.forEach(o => { byCode[o.value] = o; });
  assertEqual(byCode.b5.category, '模具', '內建 b5 模具費用應屬於「模具」大類');
  assertEqual(byCode.b8.category, '設備', '內建 b8 新增專屬設備應屬於「設備」大類');
  assertEqual(byCode.f3.category, '費用', '內建 f3 車型專案開發費用-CMC 應屬於「費用」大類');
  assertEqual(byCode.f4.category, '費用', '內建 f4 車型專案開發費用-BASE廠 應屬於「費用」大類');

  const created = gs.addDevAmortLineItem('模具', 'XXXX模具');
  assertEqual(created.ParentLine, 'B', '「模具」大類新增的科目應該掛在 B 銷貨成本底下');
  assertEqual(created.DevAmortCategory, '模具', '新科目應該記住自己屬於「模具」大類');
  const options2 = gs.getDevAmortTargetOptions();
  const newOpt = options2.filter(o => o.value === created.LineCode)[0];
  assert(newOpt && newOpt.category === '模具', '新科目應該出現在「模具」大類的攤提落點選項裡');
});

check('銷貨成本頁顯示自動計算科目不應該寫入 PLResult 快照(避免拖慢鎖定)', () => {
  const before = gs.getPLResult(base.ScenarioID, 'V1').length;
  gs.getCostOfSalesMatrix(base.ScenarioID, 'DA');
  gs.getOperatingExpenseMatrix(base.ScenarioID, 'DA');
  const after = gs.getPLResult(base.ScenarioID, 'V1').length;
  assertEqual(after, before, '單純顯示自動計算科目不應該多寫 PLResult 快照');
});

check('車型代號重新命名會連動更新車系與情境', () => {
  gs.saveVehicleType({ VehicleTypeID: 'RENAME_SRC' });
  gs.saveVehicle({ VehicleID: 'RN_V1', VehicleTypeID: 'RENAME_SRC', VehicleCode: '測試車系' });
  const sc = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE Z', ScenarioName: '改名測試', ScenarioType: '現況', VehicleTypeID: 'RENAME_SRC'
  }, '', []);
  gs.renameVehicleType('RENAME_SRC', 'RENAME_DST');
  assert(!gs.getVehicleTypes().some(t => t.VehicleTypeID === 'RENAME_SRC'), '舊車型代號應該消失');
  assert(gs.getVehicleTypes().some(t => t.VehicleTypeID === 'RENAME_DST'), '新車型代號應該存在');
  assertEqual(gs.getVehicles('RENAME_DST').length, 1, '車系應該跟著新代號查得到');
  assertEqual(gs.getScenarios('RENAME_DST').length, 1, '情境應該跟著新代號查得到');
  assert(!gs.getVehicles('RENAME_SRC').length, '舊代號底下不應該再查得到車系');
});

check('車系代號重新命名會連動更新銷售構成等資料', () => {
  gs.saveVehicle({ VehicleID: 'RN_V2', VehicleTypeID: 'DA', VehicleCode: '改名前車系' });
  gs.saveSalesMixRow({ RowID: '', ScenarioID: base.ScenarioID, VehicleID: 'RN_V2', SalesMixPct: 0, MonthlyVolume: 0, LifeCycleYears: 5 });
  gs.renameVehicle('DA', 'RN_V2', 'RN_V2_NEW');
  assert(!gs.getVehicles('DA').some(v => v.VehicleID === 'RN_V2'), '舊車系代號應該消失');
  assert(gs.getVehicles('DA').some(v => v.VehicleID === 'RN_V2_NEW'), '新車系代號應該存在');
  assert(!gs.getSalesMix(base.ScenarioID).some(r => r.VehicleID === 'RN_V2'), '銷售構成的舊車系代號應該消失');
  assert(gs.getSalesMix(base.ScenarioID).some(r => r.VehicleID === 'RN_V2_NEW'), '銷售構成應該跟著改成新車系代號');
});

const failed = results.filter(r => !r.ok);
results.forEach(r => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.ok ? '' : ' — ' + r.message)));
console.log('');
console.log(failed.length ? `${failed.length} / ${results.length} 項未通過` : `全部 ${results.length} 項通過`);
process.exit(failed.length ? 1 : 0);
