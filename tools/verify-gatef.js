/**
 * 用實際的 Gate F 損益試算表數字驗算計算引擎。
 *
 *   node tools/verify-gatef.js
 *
 * 作法：在記憶體版的試算表上跑完整條真實路徑 —— setupSpreadsheet() 建表、
 * 用系統自己的 save 函式輸入資料、再呼叫 calculatePLAllVehicles()，
 * 然後把每一個科目的結果跟 Gate F 表上的數字逐格比對（含加權平均欄）。
 *
 * 容差 2 元：Gate F 表上的每一格都是四捨五入後的整數，而系統是一路帶小數算到最後，
 * 兩者在小計會累積出 1 元上下的差（例如 3人貨車的銷貨毛利，表上 -174,573、實算 -174,573.7）。
 *
 * 開發總投的原始投資總額在附表上只有註記金額(億元)，沒有逐筆明細，
 * 因此這裡用「表上的單台攤提金額 × LIFE CYCLE 總台數」回推投資總額，
 * 驗的是攤提與後續整條損益鏈，不是投資明細本身。
 */
const { loadAppsScript } = require('./fake-apps-script');

const TOLERANCE = 2;
const LC_UNITS = 57600;          // 400 台/月 × 12 個月 × 12 年
const PER_UNIT = { mold: 25833, equip: 8621, cmcExpense: 12131, baseExpense: 6055 };

const VEHICLES = [
  { id: 'V1', name: '3人貨車', mix: 5, monthly: 20, price: 1000000 },
  { id: 'V2', name: '9人客貨車(商用)', mix: 40, monthly: 160, price: 1050000 },
  { id: 'V3', name: '9人客貨車(接駁)', mix: 55, monthly: 220, price: 1299000 }
];

// 手動輸入的成本(一列 = 一個科目，值依序對應 V1/V2/V3)
const COSTS = {
  b1: [433466, 506850, 581823],   // 材料成本-LP
  b14: [3391, 3391, 3391],        // 內陸運雜
  b2: [372148, 372148, 372148],   // 材料成本-KD
  b4: [7166, 7166, 7166],         // 一般材料
  b6: [18232, 18480, 18626],      // 直接人工
  b7: [29526, 29934, 30011],      // 製造費用
  b11: [764, 764, 764],           // 防鏽
  b12: [2396, 2396, 2396]         // 廢棄物處理及包材
};

// 手動輸入的費用（三個車系相同）
const OPEX = {
  d1: 5556, d2: 23158, d3: 20283, d5: 3431,   // 廣宣/促銷/批標售/索賠
  f1: 3196,                                    // 直接歸屬費用-CMC&SDM
  h1: 41131, h3: 2164, h4: 7237                // 固定營業費用/品牌廣宣/特別加發
};

const RATES = {
  營業稅率: 5, 銷售佣金率: 7, 季Margin率: 0.5, 貨物稅率: 15, 貨物稅完稅價格計算率: 91
};

// Gate F 表上的數字（欄序：3人貨車 / 9人客貨車(商用) / 9人客貨車(接駁) / DA車加權平均）
const EXPECTED = {
  P5: [996010, 1046010, 1295010],
  P6: [47429, 49810, 61667],
  P7: [66401, 69734, 86334],
  P8: [882180, 926466, 1147009, 1045550],
  A: [882180, 926466, 1147009, 1045550],
  b1: [433466, 506850, 581823, 544416],
  b14: [3391, 3391, 3391, 3391],
  b2: [372148, 372148, 372148, 372148],
  b4: [7166, 7166, 7166, 7166],
  b8: [8621, 8621, 8621, 8621],
  b5: [25833, 25833, 25833, 25833],
  b6: [18232, 18480, 18626, 18548],
  b7: [29526, 29934, 30011, 29956],
  b11: [764, 764, 764, 764],
  b12: [2396, 2396, 2396, 2396],
  b13: [98372, 103602, 129649, 117666],
  B: [999915, 1079185, 1180428, 1130905],
  C: [-117735, -152719, -33419, -85355],
  d1: [5556, 5556, 5556, 5556],
  d2: [23158, 23158, 23158, 23158],
  d3: [20283, 20283, 20283, 20283],
  d4: [4411, 4632, 5735, 5228],
  d5: [3431, 3431, 3431, 3431],
  E: [-174573, -209779, -91581, -143010],
  f1: [3196, 3196, 3196, 3196],
  f3: [12131, 12131, 12131, 12131],
  f4: [6055, 6055, 6055, 6055],
  G: [-195955, -231161, -112963, -164392],
  h1: [41131, 41131, 41131, 41131],
  h3: [2164, 2164, 2164, 2164],
  h4: [7237, 7237, 7237, 7237],
  I: [-246487, -281693, -163495, -214924]
};

// 表上的 % 欄（對強配收入 = A）。只抽查幾個代表性的科目，確認百分比欄位的基準正確。
const EXPECTED_PCT_OF_REVENUE = {
  B: [113.3, 116.5, 102.9, 108.2],
  C: [-13.3, -16.5, -2.9, -8.2],
  E: [-19.8, -22.6, -8.0, -13.7],
  G: [-22.2, -25.0, -9.8, -15.7],
  I: [-27.9, -30.4, -14.3, -20.6]
};

function buildScenario(gs) {
  gs.setupSpreadsheet();
  gs.saveVehicleType({ VehicleTypeID: 'DA', Notes: 'Gate F 驗算' });
  VEHICLES.forEach(v => gs.saveVehicle({ VehicleID: v.id, VehicleTypeID: 'DA', VehicleCode: v.name }));

  const scenario = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE F', ScenarioName: '901', ScenarioType: '現況',
    VehicleTypeID: 'DA', CreatedDate: '2026-08-01', Notes: ''
  }, '', []);
  const sid = scenario.ScenarioID;

  gs.saveRateGrid(sid, Object.keys(RATES).map(name => ({
    ParamID: '', ParamName: name, VehicleID: '', Value: RATES[name]
  })));

  gs.saveSalesMixGrid(sid, 'DA', VEHICLES.map(v => ({
    RowID: '', VehicleID: v.id, SalesMixPct: v.mix, MonthlyVolume: v.monthly, LifeCycleYears: 12,
    ListPriceTaxIncl: v.price, MandatoryAccessoryPrice: '', ScrapFee: 3990,
    ScrapFeeTaxStatus: '含稅', HorizontalPartsPriceAdj: '', Notes: ''
  })));

  gs.saveDevInvestmentGrid(sid, [
    { RowID: '', Department: '生技部', AssetType: '模具', Amount: PER_UNIT.mold * LC_UNITS, Currency: 'TWD' },
    { RowID: '', Department: '生技部', AssetType: '設備', Amount: PER_UNIT.equip * LC_UNITS, Currency: 'TWD' },
    { RowID: '', Department: 'CMC開發費', AssetType: '費用-CMC', Amount: PER_UNIT.cmcExpense * LC_UNITS, Currency: 'TWD' },
    { RowID: '', Department: 'BASE廠開發費', AssetType: '費用-BASE廠', Amount: PER_UNIT.baseExpense * LC_UNITS, Currency: 'TWD' }
  ]);

  const costCells = [];
  Object.keys(COSTS).forEach(code => {
    VEHICLES.forEach((v, i) => {
      costCells.push({ RowID: '', VehicleID: v.id, LineCode: code, Amount: COSTS[code][i], Currency: 'TWD', Notes: '' });
    });
  });
  gs.saveCostOfSalesMatrix(sid, costCells);

  const opexCells = [];
  Object.keys(OPEX).forEach(code => {
    VEHICLES.forEach(v => {
      opexCells.push({ RowID: '', VehicleID: v.id, LineCode: code, Amount: OPEX[code], Notes: '' });
    });
  });
  gs.saveOperatingExpenseMatrix(sid, opexCells);

  return sid;
}

function main() {
  const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'DataService.gs', 'CalcEngine.gs', 'SetupSheets.gs']);
  const sid = buildScenario(gs);

  // LIFE CYCLE 總台數必須先對，否則 b5/b8/f3/f4 全部會偏
  const units = gs.getLifeCycleUnits(sid);
  const failures = [];
  if (units !== LC_UNITS) failures.push(`LIFE CYCLE 總台數：實算 ${units}，應為 ${LC_UNITS}`);

  const all = gs.calculatePLAllVehicles(sid);
  const columns = all.vehicles.map((res, i) => ({ label: VEHICLES[i].name, lines: res.lines }))
    .concat([{ label: 'DA車加權平均', lines: all.weightedAverage }]);

  let checked = 0;
  Object.keys(EXPECTED).forEach(code => {
    EXPECTED[code].forEach((want, colIdx) => {
      const col = columns[colIdx];
      const line = col.lines.filter(l => l.LineCode === code)[0];
      if (!line) { failures.push(`${col.label} 缺少科目 ${code}`); return; }
      checked++;
      const diff = line.Amount - want;
      if (Math.abs(diff) > TOLERANCE) {
        failures.push(`${col.label} / ${code} ${line.LineName}：實算 ${line.Amount.toFixed(2)}，表上 ${want}（差 ${diff.toFixed(2)}）`);
      }
    });
  });

  Object.keys(EXPECTED_PCT_OF_REVENUE).forEach(code => {
    EXPECTED_PCT_OF_REVENUE[code].forEach((want, colIdx) => {
      const col = columns[colIdx];
      const line = col.lines.filter(l => l.LineCode === code)[0];
      if (!line) return;
      checked++;
      const got = line.PctOfRevenue * 100;
      if (Math.abs(got - want) > 0.1) {
        failures.push(`${col.label} / ${code} 對收入%：實算 ${got.toFixed(1)}%，表上 ${want}%`);
      }
    });
  });

  // 沒有強配件時廠價 = 收入，兩個百分比基準必須一致
  columns.forEach(col => {
    col.lines.forEach(line => {
      checked++;
      if (Math.abs(line.PctOfRevenue - line.PctOfExFactory) > 1e-9) {
        failures.push(`${col.label} / ${line.LineCode}：無強配件時對廠價% 應等於對收入%`);
      }
    });
  });

  // 小計驗算：損益鏈上每一條等式都要成立
  const comparison = gs.calculateComparison(
    VEHICLES.map(v => ({ ScenarioID: sid, VehicleID: v.id })).concat([{ ScenarioID: sid, VehicleID: '' }])
  );
  comparison.columns.forEach(col => {
    checked++;
    (col.checks || []).forEach(c => {
      failures.push(`${col.label} 小計驗算：${c.label} 表上 ${c.actual.toFixed(2)}、應為 ${c.expected.toFixed(2)}`);
    });
  });

  printTable(comparison);

  console.log('');
  if (failures.length) {
    console.log(`驗算失敗：${failures.length} 項不符（共比對 ${checked} 格）`);
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`驗算通過：${checked} 格全部與 Gate F 表相符（容差 ${TOLERANCE} 元）。`);
}

/** 把比較結果印成跟 Gate F 表一樣的版面，方便肉眼再對一次 */
function printTable(comparison) {
  const pad = (s, n, left) => {
    s = String(s);
    const w = [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
    const fill = ' '.repeat(Math.max(0, n - w));
    return left ? s + fill : fill + s;
  };
  const header = pad('科目', 34, true) + comparison.columns
    .map(c => pad(c.vehicleLabel, 20) + pad('%', 8)).join('');
  console.log(header);
  console.log('-'.repeat([...header].reduce((a, ch) => a + (ch.charCodeAt(0) > 127 ? 2 : 1), 0)));
  comparison.lines.forEach(line => {
    const cells = comparison.columns.map(col => {
      const v = col.amounts[line.LineCode];
      if (v === undefined) return pad('—', 20) + pad('—', 8);
      const pct = col.exFactoryPrice ? (v / col.exFactoryPrice * 100).toFixed(1) + '%' : '—';
      return pad(Math.round(v).toLocaleString('en-US'), 20) + pad(pct, 8);
    }).join('');
    console.log(pad(line.LineCode + ' ' + line.LineName, 34, true) + cells);
  });
}

if (require.main === module) main();

// 讓 tools/dev-server.js 可以直接沿用這一組 Gate F 示範資料當本機預覽的種子資料
module.exports = { buildScenario, VEHICLES, COSTS, OPEX, RATES, PER_UNIT, LC_UNITS };
