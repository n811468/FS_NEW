/**
 * 示範資料：本機預覽(tools/dev-server.js)和地端版「載入示範資料」(tools/build-local.js)共用。
 *
 * 數字全部是亂數產生的，不是任何真實車型的資料；範圍參考一般車型損益表的結構抓得「合理」
 * (成本占廠價的比例、開發總投的量級、費用水準)，說明欄與改善對策的文字也是依產生出來的數字組的。
 *
 * 用固定種子的亂數，每次產生的資料都一樣 —— dist/FS-local.html 才不會每次建置都變、
 * tools/verify-local.js 檢查 dist 是否最新也才有意義。想換一組數字看看：
 *
 *   DEMO_SEED=123 node tools/dev-server.js
 */
const DEFAULT_SEED = 20261005;

/** mulberry32：小而夠用的種子亂數 */
function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (min, max) => min + (max - min) * next();
  return {
    between,
    /** min~max 之間，取到 step 的倍數 */
    round: (min, max, step) => Math.round(between(min, max) / (step || 1)) * (step || 1),
    int: (min, max) => Math.floor(between(min, max + 1))
  };
}

/** 把 total 依隨機權重拆成 n 份整數，加總剛好等於 total */
function split(rng, total, n) {
  const w = Array.from({ length: n }, () => rng.between(0.6, 1.4));
  const sum = w.reduce((a, b) => a + b, 0);
  const parts = w.map(x => Math.round(total * x / sum));
  parts[n - 1] += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}

const yi = n => (n / 1e8).toFixed(2);   // 元 → 億元

const DA_VEHICLES = [
  { id: 'V1', name: '3人貨車' },
  { id: 'V2', name: '9人客貨車(商用)' },
  { id: 'V3', name: '9人客貨車(接駁)' }
];

/**
 * 在已經載入 .gs 的 gs 上灌示範資料：
 *   DA 車型 GATE F 現況 + 由現況衍生的目標情境(含改善對策)、DE 車型(科目表不同)一個現況情境。
 */
function seedDemo(gs, seed) {
  const rng = makeRng(seed === undefined ? DEFAULT_SEED : seed);

  gs.setupSpreadsheet();
  gs.saveVehicleType({ VehicleTypeID: 'DA', Notes: '示範車型(數字為亂數產生)' });
  DA_VEHICLES.forEach(v => gs.saveVehicle({ VehicleID: v.id, VehicleTypeID: 'DA', VehicleCode: v.name }));

  const baseline = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE F', ScenarioName: '901', ScenarioType: '現況',
    VehicleTypeID: 'DA', CreatedDate: '2026-08-01', Notes: ''
  }, '', []);
  const sid = baseline.ScenarioID;

  gs.saveRateGrid(sid, [
    ['營業稅率', 5], ['銷售佣金率', rng.round(6, 8, 0.5)], ['季Margin率', 0.5],
    ['貨物稅率', 15], ['貨物稅完稅價格計算率', 91]
  ].map(([name, value]) => ({ ParamID: '', ParamName: name, VehicleID: '', Value: value })));

  // 銷售組合：貨車便宜、量少；客貨車兩款價差約 15~25%
  const totalMonthly = rng.round(320, 480, 10);
  const mixV1 = rng.int(4, 10);
  const mixV2 = rng.int(30, 45);
  const mix = [mixV1, mixV2, 100 - mixV1 - mixV2];
  const lifeYears = rng.int(8, 12);
  const priceV2 = rng.round(950000, 1150000, 1000);
  const prices = [rng.round(priceV2 * 0.9, priceV2 * 0.97, 1000), priceV2, rng.round(priceV2 * 1.15, priceV2 * 1.25, 1000)];
  gs.saveSalesMixGrid(sid, 'DA', DA_VEHICLES.map((v, i) => ({
    RowID: '', VehicleID: v.id, SalesMixPct: mix[i], MonthlyVolume: Math.round(totalMonthly * mix[i] / 100),
    LifeCycleYears: lifeYears, ListPriceTaxIncl: prices[i], MandatoryAccessoryPrice: '', ScrapFee: 3990,
    ScrapFeeTaxStatus: '含稅', HorizontalPartsPriceAdj: '', Notes: ''
  })));

  // 開發總投(元)
  const dev = {
    mold: rng.round(9e8, 16e8, 1e6), equip: rng.round(3e8, 6e8, 1e6),
    cmc: rng.round(4e8, 8e8, 1e6), base: rng.round(2e8, 4.5e8, 1e6)
  };
  gs.saveDevInvestmentGrid(sid, [
    { RowID: '', Department: '生技部', AssetType: '模具', Amount: dev.mold, Currency: 'TWD' },
    { RowID: '', Department: '生技部', AssetType: '設備', Amount: dev.equip, Currency: 'TWD' },
    { RowID: '', Department: 'CMC開發費', AssetType: '費用-CMC', Amount: dev.cmc, Currency: 'TWD' },
    { RowID: '', Department: 'BASE廠開發費', AssetType: '費用-BASE廠', Amount: dev.base, Currency: 'TWD' }
  ]);

  // 成本：LP 件跟著車價走，KD 件(BASE 廠報價)三款共用；其餘小項依車款差一點點
  const kdCny = rng.round(70000, 82000, 500);
  const cnyRate = rng.round(4.35, 4.55, 0.01);
  const kdTariff = rng.int(10, 15);
  const kd = Math.round(kdCny * cnyRate * (1 + kdTariff / 100));
  const lpRatio = rng.between(0.4, 0.46);
  const exFactory = prices.map(p => p / 1.05);
  const same = (min, max, step) => { const x = rng.round(min, max, step); return [x, x, x]; };
  const near = (min, max) => { const x = rng.round(min, max, 1); return exFactory.map(p => Math.round(x * (0.97 + 0.06 * p / exFactory[2]))); };
  const costs = {
    b1: exFactory.map(p => Math.round(p * lpRatio * rng.between(0.97, 1.03))),
    b14: same(2500, 4000, 1),
    b2: [kd, kd, kd],
    b4: same(5000, 9000, 1),
    b6: near(15000, 21000),
    b7: near(25000, 33000),
    b11: same(600, 900, 1),
    b12: same(1800, 2800, 1)
  };
  const costCells = [];
  Object.keys(costs).forEach(code => DA_VEHICLES.forEach((v, i) => {
    costCells.push({ RowID: '', VehicleID: v.id, LineCode: code, Amount: costs[code][i], Currency: 'TWD', Notes: '' });
  }));
  gs.saveCostOfSalesMatrix(sid, costCells);

  const opex = {
    d1: rng.round(4000, 7000, 1), d2: rng.round(18000, 28000, 1), d3: rng.round(15000, 24000, 1), d5: rng.round(2500, 4500, 1),
    f1: rng.round(2500, 4000, 1), h1: rng.round(35000, 48000, 1), h3: rng.round(1500, 3000, 1), h4: rng.round(5000, 9000, 1)
  };
  const opexCells = [];
  Object.keys(opex).forEach(code => DA_VEHICLES.forEach(v => {
    opexCells.push({ RowID: '', VehicleID: v.id, LineCode: code, Amount: opex[code], Notes: '' });
  }));
  gs.saveOperatingExpenseMatrix(sid, opexCells);

  gs.getBootstrap('DA');   // 開頁時的資料升級：DA 有自己的一份科目表

  const avgRate = rng.int(23, 27);
  gs.saveLineNotes(sid, {
    b1: 'LP件：BASE廠報價展開，座椅/車身尚未低減', b2: `BASE廠報價 CNY${kdCny.toLocaleString('en-US')}，平均關稅率${kdTariff}%`,
    b4: '生技部提供，先以 DE×1.2 倍放入計算', b6: `生技部工時 × ${avgRate - 1}~${avgRate + 1} 平均費率`, b7: '含物流工時、品檢',
    b9: '使用中華標，沒有 BASE 廠跟 MMC 標相關技酬金', b12: '主要為 2 次鋰電池',
    b13: '客貨車貨物稅率 15%，提撥金以各車型廣促計算', d1: '依業務部提供', d2: '依業務部提供',
    f1: '近 3 年平均', h1: '近 3 年平均'
  });

  // 目標情境：整批帶入現況資料，再依「目標成本作法」調整
  const target = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE F', ScenarioName: '901 目標', ScenarioType: '目標',
    VehicleTypeID: 'DA', CreatedDate: '2026-08-15', Notes: '示範：材料成本低減、開發總投挑戰低減'
  }, sid, []);
  const targetId = target.ScenarioID;
  const lpCut = rng.round(0.2, 0.3, 0.01);
  const kdTargetCny = rng.round(kdCny * 0.9, kdCny * 0.95, 500);
  const factor = { b1: 1 - lpCut, b2: kdTargetCny / kdCny };
  const cost = gs.getCostOfSalesMatrix(targetId, 'DA');
  const cells = [];
  Object.keys(cost.values).forEach(code => {
    Object.keys(cost.values[code]).forEach(vehicleId => {
      const cell = cost.values[code][vehicleId];
      const amount = Number(cell.Amount) || 0;
      cells.push({ RowID: cell.RowID || '', VehicleID: vehicleId, LineCode: code,
        Amount: factor[code] ? Math.round(amount * factor[code]) : (code === 'b11' ? 0 : amount), Currency: cell.Currency || 'TWD', Notes: '' });
    });
  });
  gs.saveCostOfSalesMatrix(targetId, cells);
  const challengePct = rng.int(15, 25);
  const devRows = gs.getDevInvestmentSummary(targetId).rows;
  gs.saveDevInvestmentGrid(targetId, devRows.map(r => Object.assign({}, r, { ChallengeReductionPct: challengePct })));

  // 改善對策的效果(元/台，以加權平均計)要跟上面調整的幅度對得起來
  const weighted = arr => arr.reduce((a, x, i) => a + x * mix[i] / 100, 0);
  const lcUnits = totalMonthly * 12 * lifeYears;
  const lpEffect = split(rng, Math.round(weighted(costs.b1) * lpCut), 4);
  const kdEffect = Math.round(kd * (1 - factor.b2));
  const after = n => yi(n * (1 - challengePct / 100));
  gs.saveLineNotes(targetId, {
    b1: `LP件：座椅 -${(lpEffect[0] / 1e4).toFixed(1)}萬、車身 -${(lpEffect[1] / 1e4).toFixed(1)}萬、式樣低減 ${(lpEffect[2] / 1e4).toFixed(1)}萬、VAVE`,
    b2: `BASE廠目標報價 CNY${kdTargetCny.toLocaleString('en-US')}，平均關稅率${kdTariff}%`,
    b5: `C/D ${challengePct}%，NTD ${yi(dev.mold)}→${after(dev.mold)} 億元`,
    b8: `C/D ${challengePct}%，NTD ${yi(dev.equip)}→${after(dev.equip)} 億元`, b11: '取消防鏽',
    f3: `C/D ${challengePct}%，NTD ${yi(dev.cmc)}→${after(dev.cmc)} 億元`,
    f4: `NTD ${yi(dev.base)} 億元(CNY ${Math.round(dev.base / cnyRate / 1e4).toLocaleString('en-US')} 萬)`
  });
  gs.saveActions(targetId, [
    { Title: '座椅低減：新增 BASE 廠座椅供應商與國內競價', LineCode: 'b1', Owner: '採購部', Effect: lpEffect[0], Status: '進行中' },
    { Title: '車身低減：設計整合優化', LineCode: 'b1', Owner: '產工部', Effect: lpEffect[1], Status: '進行中' },
    { Title: '式樣變更：車燈 LED→鹵素、外觀素材色(加權)', LineCode: 'b1', Owner: '業務部', Effect: lpEffect[2], Status: '已確認' },
    { Title: 'VAVE 改善：Benchmark 競車、D→K 可行性評估', LineCode: 'b1', Owner: '開發部', Effect: lpEffect[3], Status: '規劃中' },
    { Title: `K件議價：CNY ${kdCny.toLocaleString('en-US')} → ${kdTargetCny.toLocaleString('en-US')}`, LineCode: 'b2', Owner: '採購部', Effect: kdEffect, Status: '進行中' },
    { Title: `開發總投挑戰低減 ${challengePct}%(發估海外廠商、擴大共用 BASE 車零件)`, LineCode: 'b5', Owner: '開發部',
      Effect: Math.round(dev.mold * challengePct / 100 / lcUnits), Status: '規劃中' },
    { Title: '取消防鏽', LineCode: 'b11', Owner: '業務部', Effect: costs.b11[0], Status: '已確認' }
  ]);

  // 另一個車型：科目表跟 DA 不同(沒有 KD 件、多一個「動力電池」)，用來看「每個車型各自一份科目表」與跨車型比較
  gs.createVehicleType('DE', '示範車型', '');
  gs.saveVehicle({ VehicleID: 'DE1', VehicleTypeID: 'DE', VehicleCode: '5人休旅' });
  const battery = gs.addLineItemInline('B', '動力電池', 'DE');
  const de = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE E', ScenarioName: '1015', ScenarioType: '現況', VehicleTypeID: 'DE', CreatedDate: '2026-08-20'
  }, '', []);
  const dePrice = rng.round(1300000, 1600000, 1000);
  gs.saveSalesMixGrid(de.ScenarioID, 'DE', [
    { RowID: '', VehicleID: 'DE1', SalesMixPct: 100, MonthlyVolume: rng.round(200, 400, 10), LifeCycleYears: rng.int(6, 9),
      ListPriceTaxIncl: dePrice, MandatoryAccessoryPrice: rng.round(15000, 30000, 1000), ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }
  ]);
  gs.saveCostOfSalesMatrix(de.ScenarioID, [
    { RowID: '', VehicleID: 'DE1', LineCode: 'b1', Amount: Math.round(dePrice * rng.between(0.52, 0.58)), Currency: 'TWD' },
    { RowID: '', VehicleID: 'DE1', LineCode: battery.LineCode, Amount: rng.round(80000, 120000, 100), Currency: 'TWD' },
    { RowID: '', VehicleID: 'DE1', LineCode: 'b6', Amount: rng.round(18000, 24000, 100), Currency: 'TWD' },
    { RowID: '', VehicleID: 'DE1', LineCode: 'b7', Amount: rng.round(28000, 36000, 100), Currency: 'TWD' }
  ]);
  gs.deletePLLineItem('b2', 'DE');
  gs.saveOperatingExpenseMatrix(de.ScenarioID, [
    { RowID: '', VehicleID: 'DE1', LineCode: 'd1', Amount: rng.round(6000, 10000, 100) },
    { RowID: '', VehicleID: 'DE1', LineCode: 'd2', Amount: rng.round(20000, 30000, 100) },
    { RowID: '', VehicleID: 'DE1', LineCode: 'h1', Amount: rng.round(38000, 50000, 100) }
  ]);
  return { baselineId: sid, targetId, deScenarioId: de.ScenarioID };
}

module.exports = { seedDemo, makeRng, DEFAULT_SEED };
