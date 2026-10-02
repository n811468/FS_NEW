/**
 * 把「D5X 損益 FS_CMC」Excel 的「D5X  FS_CMC」分頁轉成資料包，並逐格驗算。
 *
 *   node tools/import-d5x-fs-cmc.js            # 產生 data/D5X_FS_CMC_資料包.json
 *
 * 作法跟 verify-gatef.js 一樣走系統自己的路徑：用地端版主機(local/host.js，就是瀏覽器裡跑的那一套)
 * 建車型、改科目表、輸入資料，再呼叫計算引擎，把每個科目跟 Excel 上的數字逐格比對(含加權欄)；
 * 比對通過才匯出資料包，並把資料包匯入一台全新的主機再驗一次，確認資料包本身是完整的。
 *
 * Excel 的科目結構跟標準範本不同，所以 D5X 有自己的科目表：
 *   B 入手價(CMC出廠價)：材料成本(K件CIF/海運BAF/關稅/內陸運輸/地產零件) + 開發攤提 + 製造 + 代繳貨物稅
 *   E 銷貨毛利 = A - B - Σ 銷售段(技酬金/廣宣/促銷/批標售/索賠/CAFÉ)
 *   I 營業淨利 = E - 固定管理費用-CMC - 固定營業費用-MGT
 *   K 營業淨利(扣返還上汽K件價格) = I - 返還上汽K件價格
 * C(A-B)、G(扣 CMC 固定管理費後)是系統的結構小計，Excel 上沒有這兩列。
 */
const fs = require('fs');
const path = require('path');
const build = require('./build-local');
const Shim = require('../local/gas-shim.js');
const Pack = require('../local/pack.js');
const Host = require('../local/host.js');

const TYPE = 'D5X';
const OUT = path.join(__dirname, '..', 'data', 'D5X_FS_CMC_資料包.json');
const TOLERANCE = 0.01;          // Excel 是一路帶小數算的，系統也是，差距應該只有浮點誤差

const CNY_RATE = 4.65;           // Excel B4
const LC_UNITS = 50000;          // 開發總投!B27：L/C 50,000 台
const LC_MONTHS = 60;            // 開發總投!C27：60 個月

const VEHICLES = [
  { id: 'D5X-入門', name: '入門', mix: 30, price: 989000 },
  { id: 'D5X-頂規', name: '頂規', mix: 70, price: 1099000 }
];

const RATES = { 營業稅率: 5, 銷售佣金率: 6, 貨物稅率: 12.5, 貨物稅完稅價格計算率: 91 };
const CUSTOM_PARAMS = [
  { ParamName: '關稅率', Unit: '%', DefaultValue: 11.5, Description: '關稅 = (K件CIF + 海運BAF) × 關稅率，以平均關稅 11.5% 計算' },
  { ParamName: '技酬金率', Unit: '%', DefaultValue: 3, Description: '技酬金 = (出廠價 - K件CIF - 關稅 - 技酬金扣除額) × 技酬金率' },
  { ParamName: '技酬金扣除額', Unit: '數值', DefaultValue: 11810, Description: '技酬金計算基礎扣除的海運保險(元/台)' },
  { ParamName: '索賠單台(CNY)', Unit: '數值', DefaultValue: 1314, Description: '索賠(含索賠取回) 每台 CNY 金額，乘上 CNY 匯率換成台幣' }
];

// 開發總投(開發總投 分頁)：一列 = 部門 × 攤提落點。target 是下面建科目時的代號鍵
const DEV_ROWS = [
  { dept: '上汽開發費', target: 'saic', amount: 357625000,
    notes: '(900萬+2000萬+1200萬+900萬)CNY×4.65÷0.8 + 2,700萬 + 4,000萬。1.上汽開發費(含FICM繁中)：CNY 3000萬元 2.延鋒評估委由台灣安富科技開發費用NT1.16億(CNY2000萬) 3.HEV電池技術授權金1350萬 4.FICM技術授權金2000萬' },
  { dept: '產專室', target: 'cmc', amount: 7500000, notes: '反送車輛3台及零件' },
  { dept: '試驗部', target: 'cmc', amount: 23611000, notes: '法規與試驗車輛報廢費用(九台)、PL-TRY車輛整修、ARTC綜合耐久試驗、台上試驗治具與零件、ARTC試驗場地租用、試驗差旅' },
  { dept: '產工部', target: 'cmc', amount: 17460000, notes: '座椅乘適性試作2回、牌照鈑轉接托架試作、法規、補胎劑測試費' },
  { dept: '開發部', target: 'mold', amount: 356321500, notes: '開發四門一蓋，尾門及補強件改K(320,689,350÷0.9)' },
  { dept: '開發部', target: 'cmc', amount: 35529500 / 0.9, notes: '開發四門一蓋，尾門及補強件改K(35,529,500÷0.9)' },
  { dept: '生技部', target: 'equip', amount: 333800000, notes: '新設ROOF激光站、研磨站、後輪弧包邊站(300,420,000÷0.9)' },
  { dept: '生技部', target: 'cmc', amount: 27420000, notes: '24,678,000÷0.9' },
  { dept: '生管部', target: 'cmc', amount: 4834000, notes: '料架及差旅' },
  { dept: '品管部', target: 'equip', amount: 5200000, notes: '四門一蓋檢具x6套、車身三次元量測用切換支撐治具、前/後綜合檢具' },
  { dept: '品管部', target: 'cmc', amount: 8474014, notes: 'P try樣車、研修、差旅、測試、特管' },
  { dept: '前瞻室', target: 'mold', amount: 2000000, notes: 'TBOX系統整合開發' },
  { dept: '前瞻室', target: 'cmc', amount: 5000000, notes: 'TBOX系統整合開發' },
  { dept: '電電部', target: 'mold', amount: 27690000, notes: 'HEV電池、蓄電池開發，FICM主機及線束確認' },
  { dept: '電電部', target: 'cmc', amount: 7300000, notes: '20,500,000 - 13,500,000 + 300,000' },
  { dept: '楊梅廠', target: 'equip', amount: 1542000, notes: '生產用板手/電槍等手工具(1,387,800÷0.9)' },
  { dept: '楊梅廠', target: 'cmc', amount: 6798294 / 0.9, notes: '上汽研修/差旅/技師指導及設備模具檢收驗收、料架/套筒工具、試裝車/教育訓練/拆裝報廢(6,798,294÷0.9)' },
  { dept: '資訊部', target: 'cmc', amount: 5710000, notes: '配合TBOX式樣進行數據中台與車主APP系統外包開發改修' },
  { dept: '服務部', target: 'cmc', amount: 155500, notes: '手冊製版、售後教育訓練、種子講師至上汽培訓' }
];

// 手動輸入的金額：[入門, 頂規]。currency 沒寫就是 TWD
const INPUTS = {
  kcif: { values: [97000, 102000], currency: 'CNY' },
  baf: { values: [6862, 6862] },
  inland: { values: [11079, 11079] },
  local: { values: [216465, 244685] },
  tbox: { values: [324, 324] },
  waste: { values: [1954, 1954] },
  pack: { values: [961, 961] },
  general: { values: [6885, 6885] },
  labor: { values: [17056.46251, 17365.13093] },
  overhead: { values: [30216.62155, 30350.19253] },
  rust: { values: [0, 0] },
  ad: { values: [9000, 9000] },
  promo: { values: [43000, 43000] },
  fleet: { values: [0, 0] },
  cafe: { values: [1700, 1700] },
  cmcFixed: { values: [25277, 25277] },
  mgtFixed: { values: [9193, 9193] },
  saicRefund: { values: [71514, 75263] }
};

// Excel 上的說明欄(L 欄)
const NOTES = {
  kcif: '上汽報價K件報價(入門:CNY 97,000，頂規: CNY 102,000 )',
  tariff: '以平均關稅11.5%計算',
  inland: '雙方物流交流後裝櫃預估當量維持原案(3.03 → 2.08)',
  local: '以廠內及過去量產車為BASE進行預估',
  tbox: '以購車贈3年免費使用評估。電信商(台哥大)雲端MG4(CMC版地產化TBOX)共用。',
  waste: '二次鋰電池45KG*39元=1,755，鉛蓄電池15.4KG*1.53，輪胎4*40，鈕扣電池0.028*214，盛裝容器0.5*7',
  cmcDev: '1.54億÷5萬台',
  mold: '3.86億÷5萬台',
  saicDev: '3.24億÷5萬台',
  equip: '3.61億÷5萬台',
  pack: '預估單台廢木產出量為5280KG/台，廢木料處理成本4.5元/KG',
  general: '塗裝5,685(新色淺灰60%、其餘車色平均40%估算)，組裝:1,200',
  labor: '入門：組裝9.182小時、車身1.333小時、塗裝3.103小時\n頂規：組裝9.436小時、車身1.333小時、塗裝3.103小時\n零品1.5小時、車品1.2小時、物流工時10小時',
  rust: '製程工藝無須規劃防鏽',
  tax: '符合2,000以下貨物稅 減半，以12.5%計算',
  royalty: '(出廠價-k(CIF)-關稅)*3%，海運保險以11810作為估算基礎。',
  claim: 'CNY 1,314/台 × CNY 匯率',
  cafe: '油耗21.4km/L，為 2030年之要求。暫以19km/L計算未達支付成本。CAFE成本1,700元/台 (差值以2.4分*700元(估值)取整數)',
  cmcFixed: '24-26年平均費率',
  mgtFixed: '26年預算',
  saicRefund: '入門 CNY 15,379、頂規 CNY 16,186'
};

// Excel「D5X  FS_CMC」分頁上的數字：[入門, 頂規, 加權]（加權欄空白的列用 null）
const EXPECTED = {
  P1: [989000, 1099000, 1066000],
  P4: [3990, 3990, 3990],
  P5: [985010, 1095010, 1062010],
  P6: [46905, 52143, 50571.6],
  P7: [56286, 62572, 60686.2],
  P8: [881819, 980295, 950752.2],
  A: [881819, 980295, 950752.2],
  B: [924302.348657059, 986413.6425524256, 967780.2543838155],
  material: [738115.88, 792259.63, 776016.505],
  kcif: [451050, 474300, 467325],
  baf: [6862, 6862, 6862],
  tariff: [52659.88, 55333.63, 54531.505],
  inland: [11079, 11079, 11079],
  local: [216465, 244685, 236219],
  tbox: [324, 324, 324],
  waste: [1954, 1954, 1954],
  cmcDev: [3089.907924444444, 3089.907924444444, 3089.907924444444],
  mold: [7720.23, 7720.23, 7720.23],
  saicDev: [7152.5, 7152.5, 7152.5],
  equip: [6810.84, 6810.84, 6810.84],
  pack: [961, 961, 961],
  general: [6885, 6885, 6885],
  labor: [17056.46251, 17365.13093, 17272.530404],
  overhead: [30216.62155, 30350.19253, 30310.121236],
  rust: [0, 0, 0],
  tax: [104015.90667261445, 111541.21116798112, 109283.61981937112],
  royalty: [12263.474059711769, 13349.100376572766, 13023.412481514466],
  ad: [9000, 9000, 9000],
  promo: [43000, 43000, 43000],
  fleet: [0, 0, 0],
  claim: [6110.1, 6110.1, 6110.1],
  cafe: [1700, 1700, 1700],
  E: [-114556.92271677079, -79277.84292899839, -89861.5668653301],
  cmcFixed: [25277, 25277, 25277],
  mgtFixed: [9193, 9193, 9193],
  I: [-149026.9227167708, -113747.84292899839, -124331.56686533011],
  saicRefund: [71514, 75263, null],
  K: [-220540.9227167708, -189010.8429289984, null]
};

let uuidSeq = 0;
function newHost() {
  const host = Host.createHost({
    factory: build.loadBackendFactory(), shim: Shim, pack: Pack, storage: null,
    getUser: () => 'D5X FS_CMC 匯入',
    getUuid: () => 'd5x' + String(++uuidSeq).padStart(5, '0') + '-0000-4000-8000-000000000000'
  });
  host.start();
  return host;
}
function apiOf(host) {
  return new Proxy({}, { get: (_, name) => (...args) => host.call(name, args) });
}

/** 科目表：從標準範本複製，改成 Excel 的結構。回傳 { 鍵: 科目代碼 } */
function buildChart(gs) {
  gs.createVehicleType(TYPE, 'D5X 開發四門一蓋版(在地化35%)', '');
  CUSTOM_PARAMS.forEach(p => gs.saveParamDef(p));

  // Excel 沒有的範本科目
  ['b3', 'b9', 'b10', 'd4', 'f3', 'f4', 'h3', 'h4'].forEach(code => gs.deletePLLineItem(code, TYPE));

  const code = { P8: 'P8', B: 'B', C: 'C', E: 'E', G: 'G', I: 'I', K: 'K', P1: 'P1', P4: 'P4', P5: 'P5', P6: 'P6', P7: 'P7', A: 'A' };
  const edit = (c, line) => gs.saveChartLine(TYPE, Object.assign({ LineCode: c }, line)).line.LineCode;
  const add = (key, line) => { code[key] = gs.saveChartLine(TYPE, Object.assign({ LineCode: '', CalcType: 'INPUT' }, line)).line.LineCode; };
  const input = (c, name, extra) => edit(c, Object.assign({ LineName: name, CalcType: 'INPUT', CommodityTaxDeduct: '' }, extra || {}));

  edit('P8', { LineName: '經銷價(未稅)', CalcType: 'FORMULA', Formula: 'P5 - P6 - P7' });
  edit('B', { LineName: '入手價(CMC出廠價)', CalcType: 'FORMULA', Formula: 'CHILDREN()' });
  edit('C', { LineName: '毛利(經銷價-入手價)', CalcType: 'FORMULA', Formula: 'A - B' });

  // ---- B：材料成本小計 + 底下五項 ----
  add('material', { LineName: '材料成本', ParentLine: 'B', CalcType: 'FORMULA', Formula: 'CHILDREN()', Description: '材料成本 = K件CIF + 海運BAF + 關稅 + 內陸運輸/雜費 + 地產零件成本' });
  code.kcif = input('b2', '材料成本K(CIF)', { ParentLine: code.material, Description: '上汽 K 件報價(CNY)，依匯率設定的 CNY 現況匯率換算' });
  add('baf', { LineName: '海運BAF', ParentLine: code.material });
  add('tariff', { LineName: '關稅', ParentLine: code.material, CalcType: 'FORMULA', Formula: '([材料成本K(CIF)] + [海運BAF]) * [關稅率]' });
  code.inland = input('b14', '內陸運輸/雜費', { ParentLine: code.material });
  code.local = input('b1', '地產零件成本D', { ParentLine: code.material });

  // ---- B：其餘明細 ----
  add('tbox', { LineName: '車載系統傳輸費', ParentLine: 'B' });
  code.waste = input('b12', '廢棄物處理費(電池、輪胎)');
  add('cmcDev', { LineName: 'CMC開發費', ParentLine: 'B', CalcType: 'DEV_AMORT', DevAmortCategory: '費用', Description: '開發總投費用類(上汽開發費以外) ÷ L/C 台數' });
  code.mold = edit('b5', { LineName: '模具費', CalcType: 'DEV_AMORT', DevAmortCategory: '模具' });
  add('saicDev', { LineName: '上汽開發費', ParentLine: 'B', CalcType: 'DEV_AMORT', DevAmortCategory: '費用', Description: '開發總投「上汽開發費」÷ L/C 台數' });
  code.equip = edit('b8', { LineName: '新增專用設備', CalcType: 'DEV_AMORT', DevAmortCategory: '設備' });
  add('pack', { LineName: '包材處理費(木箱、軟塑膠)', ParentLine: 'B' });
  code.general = input('b4', '一般材料(塗副料)');
  code.labor = input('b6', '直接人工');
  code.overhead = input('b7', '製造費用');
  code.rust = input('b11', '防鏽');

  const taxBase = ['材料成本', '車載系統傳輸費', '廢棄物處理費(電池、輪胎)', 'CMC開發費', '模具費', '上汽開發費', '新增專用設備',
    '包材處理費(木箱、軟塑膠)', '一般材料(塗副料)', '直接人工', '製造費用', '防鏽'].map(n => `[${n}]`).join(' + ');
  code.tax = edit('b13', {
    LineName: '代繳貨物稅', CalcType: 'FORMULA',
    Formula: `(${taxBase}) / 0.875 * [貨物稅完稅價格計算率] * [貨物稅率] * 0.85 + P8 * [貨物稅完稅價格計算率] / (1 + [貨物稅率]) * [貨物稅率] * 0.15`,
    Description: '同 Excel：Σ(c1~c17)÷0.875×0.91×貨物稅率×0.85 + 經銷價×0.91÷(1+貨物稅率)×貨物稅率×0.15'
  });

  // ---- E：銷售段 ----
  add('royalty', { LineName: '技酬金(Royalty)', ParentLine: 'E', CalcType: 'FORMULA', Formula: '(B - [材料成本K(CIF)] - [關稅] - [技酬金扣除額]) * [技酬金率]' });
  code.ad = input('d1', '車型廣宣費用');
  code.promo = input('d2', '促銷/批標售');
  code.fleet = input('d3', '批標售');
  code.claim = edit('d5', { LineName: '索賠(含索賠取回)', CalcType: 'FORMULA', Formula: '[索賠單台(CNY)] * [CNY匯率]' });
  add('cafe', { LineName: 'CAFÉ成本', ParentLine: 'E' });

  // ---- G / I / K ----
  code.cmcFixed = input('f1', '固定管理費用-CMC');
  edit('G', { LineName: '扣CMC固定管理費用後', CalcType: 'FORMULA', Formula: 'E - CHILDREN()' });
  code.mgtFixed = input('h1', '固定營業費用-MGT');
  edit('I', { LineName: '營業淨利', CalcType: 'FORMULA', Formula: 'G - CHILDREN()' });
  code.saicRefund = input('J', '返還上汽K件價格');
  edit('K', { LineName: '營業淨利(扣返還上汽K件價格)', CalcType: 'FORMULA', Formula: 'I - J' });

  // 依 Excel 列序排好(科目樹拖曳送出的就是這種「父科目在前」的走訪順序)
  const order = [
    ['P1', ''], ['P2', ''], ['P3', ''], ['P4', ''], ['P5', ''], ['P6', ''], ['P7', ''], ['P8', ''], ['P9', ''], ['A', ''],
    ['B', ''], [code.material, 'B'], [code.kcif, code.material], [code.baf, code.material], [code.tariff, code.material],
    [code.inland, code.material], [code.local, code.material],
    [code.tbox, 'B'], [code.waste, 'B'], [code.cmcDev, 'B'], [code.mold, 'B'], [code.saicDev, 'B'], [code.equip, 'B'],
    [code.pack, 'B'], [code.general, 'B'], [code.labor, 'B'], [code.overhead, 'B'], [code.rust, 'B'], [code.tax, 'B'],
    ['C', ''], ['E', ''], [code.royalty, 'E'], [code.ad, 'E'], [code.promo, 'E'], [code.fleet, 'E'], [code.claim, 'E'], [code.cafe, 'E'],
    ['G', ''], [code.cmcFixed, 'G'], ['I', ''], [code.mgtFixed, 'I'], ['J', ''], ['K', '']
  ];
  gs.setLineOrder(TYPE, order.map(([LineCode, ParentLine]) => ({ LineCode, ParentLine })));
  return code;
}

function buildScenario(gs, code) {
  VEHICLES.forEach(v => gs.saveVehicle({ VehicleID: v.id, VehicleTypeID: TYPE, VehicleCode: v.name }));
  const sid = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE F', ScenarioName: 'FS_CMC', ScenarioType: '現況', VehicleTypeID: TYPE,
    CreatedDate: '2026-08-04', Notes: '來源：D5X 損益 FS_CMC 0921.xlsx「D5X  FS_CMC」分頁(開發四門一蓋版、在地化35%)'
  }, '', []).ScenarioID;

  const monthly = LC_UNITS / LC_MONTHS;
  gs.saveAmortBasis(sid, monthly, LC_MONTHS / 12);
  gs.saveRateGrid(sid, Object.keys(RATES).map(n => ({ ParamID: '', ParamName: n, VehicleID: '', Value: RATES[n] }))
    .concat(CUSTOM_PARAMS.map(p => ({ ParamID: '', ParamName: p.ParamName, VehicleID: '', Value: p.DefaultValue }))));
  gs.saveFxGrid(sid, [{ ParamID: '', Currency: 'CNY', ParamName: '現況匯率', Value: CNY_RATE }]);

  gs.saveSalesMixGrid(sid, TYPE, VEHICLES.map(v => ({
    RowID: '', VehicleID: v.id, SalesMixPct: v.mix, MonthlyVolume: monthly * v.mix / 100, LifeCycleYears: LC_MONTHS / 12,
    ListPriceTaxIncl: v.price, MandatoryAccessoryPrice: '', ScrapFee: 3990, ScrapFeeTaxStatus: '含稅',
    HorizontalPartsPriceAdj: '', Notes: '廢車處理費 3,800 × 1.05'
  })));

  const costKeys = ['kcif', 'baf', 'inland', 'local', 'tbox', 'waste', 'pack', 'general', 'labor', 'overhead', 'rust'];
  const opexKeys = ['ad', 'promo', 'fleet', 'cafe', 'cmcFixed', 'mgtFixed', 'saicRefund'];
  const cells = keys => [].concat(...keys.map(k => VEHICLES.map((v, i) => ({
    RowID: '', VehicleID: v.id, LineCode: code[k], Amount: INPUTS[k].values[i], Currency: INPUTS[k].currency || 'TWD', Notes: ''
  }))));
  gs.saveCostOfSalesMatrix(sid, cells(costKeys));
  gs.saveOperatingExpenseMatrix(sid, cells(opexKeys));

  const targets = { mold: code.mold, equip: code.equip, cmc: code.cmcDev, saic: code.saicDev };
  gs.saveDevInvestmentGrid(sid, DEV_ROWS.map(r => ({
    RowID: '', Department: r.dept, TargetLineCode: targets[r.target], Amount: r.amount, Currency: 'TWD',
    ChallengeReductionPct: 0, Notes: r.notes, VehicleScope: ''
  })));

  const notes = {};
  Object.keys(NOTES).forEach(k => { notes[code[k]] = NOTES[k]; });
  gs.saveLineNotes(sid, notes);
  return sid;
}

/** 跟 Excel 逐格比對，回傳不符的項目 */
function verify(gs, sid, code) {
  const failures = [];
  let checked = 0;
  const units = gs.getLifeCycleUnits(sid);
  if (Math.abs(units - LC_UNITS) > 1e-6) failures.push(`L/C 總台數：實算 ${units}，應為 ${LC_UNITS}`);

  const all = gs.calculatePLAllVehicles(sid);
  const columns = all.vehicles.map((res, i) => ({ label: VEHICLES[i].name, lines: res.lines }))
    .concat([{ label: '加權', lines: all.weightedAverage }]);
  Object.keys(EXPECTED).forEach(key => {
    const c = code[key];
    EXPECTED[key].forEach((want, i) => {
      if (want === null) return;
      const line = columns[i].lines.find(l => l.LineCode === c);
      if (!line) { failures.push(`${columns[i].label} 缺少科目 ${key}(${c})`); return; }
      checked++;
      if (Math.abs(line.Amount - want) > TOLERANCE) {
        failures.push(`${columns[i].label} / ${c} ${line.LineName}：實算 ${line.Amount}，Excel ${want}`);
      }
    });
  });

  const cmp = gs.calculateComparison(VEHICLES.map(v => ({ ScenarioID: sid, VehicleID: v.id })).concat([{ ScenarioID: sid, VehicleID: '' }]));
  cmp.columns.forEach(col => {
    (col.checks || []).forEach(c => failures.push(`${col.label} 小計驗算：${c.label}`));
    Object.keys(col.errors || {}).forEach(c => failures.push(`${col.label} / ${c} 公式錯誤：${JSON.stringify(col.errors[c])}`));
  });
  return { failures, checked, comparison: cmp };
}

function printTable(cmp) {
  const width = s => [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
  const pad = (s, n, left) => { s = String(s); const f = ' '.repeat(Math.max(0, n - width(s))); return left ? s + f : f + s; };
  console.log(pad('科目', 40, true) + cmp.columns.map(c => pad(c.vehicleLabel, 16)).join(''));
  cmp.lines.forEach(l => {
    const indent = '  '.repeat(l.Depth || 0);
    console.log(pad(indent + l.LineCode + ' ' + l.LineName, 40, true) + cmp.columns.map(c => {
      const v = c.amounts[l.LineCode];
      return pad(v === undefined || v === null ? '—' : Math.round(v).toLocaleString('en-US'), 16);
    }).join(''));
  });
}

function main() {
  const host = newHost();
  const gs = apiOf(host);
  const code = buildChart(gs);
  const sid = buildScenario(gs, code);

  const first = verify(gs, sid, code);
  printTable(first.comparison);
  if (first.failures.length) {
    console.log(`\n驗算失敗：${first.failures.length} 項不符`);
    first.failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }

  const pack = host.exportPack([TYPE]);
  pack.exportedAt = '2026-10-02T00:00:00.000Z';
  const json = JSON.stringify(pack, null, 1);

  // 資料包匯入一台全新的主機(跟使用者「匯入資料包…→合併匯入」同一條路)，數字要完全一樣
  const fresh = newHost();
  fresh.mergePack(Pack.parsePack(json));
  const again = verify(apiOf(fresh), sid, code);
  if (again.failures.length) {
    console.log('\n資料包匯入後驗算失敗：');
    again.failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json + '\n');
  console.log(`\n驗算通過：${first.checked} 格與 Excel 相符(容差 ${TOLERANCE} 元)，資料包匯入後重算也相同。`);
  console.log('已輸出 ' + path.relative(process.cwd(), OUT));
}

main();
