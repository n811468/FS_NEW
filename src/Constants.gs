/**
 * 分頁名稱、欄位定義、損益科目表。
 * 個人使用版本：無登入權限控管、無情境鎖定機制，部門/科目皆允許自由新增與刪除。
 *
 * 兩個重要慣例：
 *   1. 所有「比率」欄位一律以百分比數值(0~100)輸入與儲存，如 5 代表 5%、0.5 代表 0.5%。
 *      CalcEngine 使用時一律 /100（見 CalcEngine.gs 的 pct_()）。匯率不是比率，維持原始數值。
 *   2. 部分科目為「自動計算」科目(AutoSource 有值)，不開放手動輸入，由 CalcEngine 依
 *      比率設定或開發總投攤提自動算出，避免與手動輸入重複計列。
 */

var SHEETS = {
  VEHICLE_TYPES: 'VehicleTypes',
  VEHICLES: 'Vehicles',
  SCENARIOS: 'Scenarios',
  SALES_MIX: 'SalesMix',
  COST_OF_SALES: 'CostOfSales',
  DEV_INVESTMENT: 'DevInvestment',
  OPERATING_EXPENSE: 'OperatingExpense',
  PARAMETERS: 'Parameters',
  PL_LINE_ITEMS: 'PLLineItems',
  PL_RESULT: 'PLResult',
  PARAM_DEFS: 'ParamDefs',
  LINE_NOTES: 'LineNotes',
  ACTIONS: 'Actions',
  SNAPSHOTS: 'Snapshots'
};

// 每張表的欄位順序，同時作為 Sheet 標題列與 Apps Script 讀寫時的欄位對應。
// 車型階層：VehicleTypes(車型，如 K5) 為上層主檔，Vehicles(車系，如 標準型) 為下層，
// 需先在「車型主檔」選擇/建立車型，才能在「車系設定」底下新增車系。
var SCHEMA = {
  VehicleTypes: ['VehicleTypeID', 'Notes'],
  Vehicles: ['VehicleID', 'VehicleTypeID', 'VehicleCode', 'Notes', 'SortOrder'],
  Scenarios: ['ScenarioID', 'Gate', 'ScenarioName', 'ScenarioType', 'VehicleTypeID',
    'AmortMonthlyVolume', 'AmortLifeCycleYears', 'CreatedBy', 'CreatedDate', 'Notes', 'SortOrder'],
  SalesMix: ['RowID', 'ScenarioID', 'VehicleID', 'SalesMixPct', 'MonthlyVolume', 'LifeCycleYears',
    'ListPriceTaxIncl', 'MandatoryAccessoryPrice', 'ScrapFee', 'ScrapFeeTaxStatus',
    'HorizontalPartsPriceAdj', 'EffectiveDate', 'Notes'],
  CostOfSales: ['RowID', 'ScenarioID', 'VehicleID', 'LineCode', 'Amount', 'Currency',
    'Notes', 'EffectiveDate'],
  DevInvestment: ['RowID', 'ScenarioID', 'Department', 'AssetType',
    'Amount', 'Currency', 'ChallengeReductionPct', 'Notes', 'EffectiveDate', 'TargetLineCode', 'SortOrder', 'VehicleScope'],
  OperatingExpense: ['RowID', 'ScenarioID', 'VehicleID', 'LineCode', 'Amount', 'Notes', 'EffectiveDate'],
  Parameters: ['ParamID', 'ScenarioID', 'VehicleID', 'ParamName', 'Currency', 'Value', 'EffectiveDate'],
  // 科目表依車型各自一份(VehicleTypeID)；VehicleTypeID 留白的是「標準範本」，新車型預設由它複製。
  // 主鍵 LineID = 車型 + '|' + 科目代碼(範本用 '*')，科目代碼只需在同一個車型內唯一。
  PLLineItems: ['LineID', 'VehicleTypeID', 'LineCode', 'LineName', 'ParentLine', 'Category', 'SortOrder',
    'CalcType', 'Formula', 'VehicleFormulas', 'AutoSource', 'CommodityTaxDeduct', 'DevAmortCategory', 'Description'],
  PLResult: ['ResultID', 'ScenarioID', 'VehicleID', 'LineCode', 'Amount', 'PctOfRevenue', 'PctOfExFactory', 'CalcTimestamp'],
  // 參數定義：內建的稅率/費率之外，使用者可以自己加參數(如「關稅率」「KD件CNY報價」)給公式引用
  ParamDefs: ['ParamName', 'Unit', 'DefaultValue', 'Description', 'SortOrder'],
  // 科目說明(簡報上的「說明」欄)：情境 × 科目，VehicleID 留白 = 整個科目共用一段說明
  LineNotes: ['RowID', 'ScenarioID', 'LineCode', 'VehicleID', 'Notes'],
  // 改善作法：掛在目標情境底下，說明「差距要靠哪些作法補起來」，Effect 為對營業淨利的單台改善金額(元/台)
  Actions: ['ActionID', 'VehicleTypeID', 'ScenarioID', 'LineCode', 'Title', 'Detail', 'Owner', 'Effect',
    'Status', 'DueDate', 'SortOrder'],
  // 情境快照：某個時間點的計算結果(加權平均 + 各車系的每個科目金額)，存成 JSON 放在 Data。
  // 之後輸入資料怎麼改都不影響快照，用來比較「這一版跟審議那一版差在哪」；情境刪掉快照仍保留。
  Snapshots: ['SnapshotID', 'VehicleTypeID', 'ScenarioID', 'SnapshotName', 'CreatedAt', 'CreatedBy', 'Notes', 'Data']
};

// 情境代號改用 GATE 別；同一個 GATE 底下可以有多個情境(GATE F 現況 / GATE F 目標)，
// 情境名稱由使用者自訂，ScenarioID 由系統自動產生，不需使用者自行編碼。
var GATE_OPTIONS = ['GATE F', 'GATE E', 'GATE D', 'GATE C', 'GATE B', 'GATE A', 'GATE Z'];

// 情境性質：現況情境沒有「挑戰低減目標」(一律視為 0)；目標情境才需要填低減目標，
// 且可以從其他情境把開發總投等資料整批帶入後再調整。
var SCENARIO_TYPES = ['現況', '目標'];
var SCENARIO_TYPE_BASELINE = '現況';

// 廢車處理費稅別選項：讓損益試算全程稅別口徑一致(一律換算為含稅金額後再從零售價扣除)。
var SCRAP_FEE_TAX_STATUS = ['含稅', '未稅'];

// 開發總投「攤提落點」現在直接選損益科目(DevInvestment.TargetLineCode)，不再限制成固定的
// 4 個資產類型；使用者可以在「開發總投」頁面自己新增攤提落點科目(見 AUTO_SOURCE.DEV_AMORT)。
// 以下常數只用來相容舊資料(尚未有 TargetLineCode 欄位時寫入的列)。
var DEV_ASSET_TYPES = ['模具', '設備', '費用-CMC', '費用-BASE廠'];

// 舊資料相容：以前只有一個「費用」，讀取時會依 Department 自動判斷後轉成新的選項值。
var DEV_ASSET_TYPE_LEGACY_EXPENSE = '費用';

// 舊資料的資產類型 -> 攤提落點科目，只在還沒轉成 TargetLineCode 的舊列上使用一次，
// 讀取時會直接把結果補寫回 TargetLineCode（見 DataService.gs devAmortTargetOf_）。
var DEV_ASSET_TYPE_TARGET = {
  '模具': 'b5',
  '設備': 'b8',
  '費用-CMC': 'f3',
  '費用-BASE廠': 'f4'
};

// 開發總投填寫流程：先選部門(自由輸入) → 再選「設備/模具/費用」大類 → 再選這一大類底下
// 實際要攤提到的損益科目(攤提落點)。大類本身不是損益科目，只是用來分組/篩選攤提落點選單，
// 避免自己新增的攤提落點(如「XXXX模具」)越加越多之後，整個下拉選單混在一起不好找。
// 每個科目屬於哪個大類記在 PLLineItems.DevAmortCategory；大類同時決定新增科目時要掛在
// 哪個父科目底下(設備/模具 -> B 銷貨成本，費用 -> G 產品貢獻前費用，跟內建的 b5/b8/f3/f4 一致)。
var DEV_AMORT_CATEGORIES = ['設備', '模具', '費用'];
var DEV_AMORT_CATEGORY_PARENT = { '設備': 'B', '模具': 'B', '費用': 'G' };

// Parameters 依用途分兩組管理：稅務/費用比率(0~100 百分比) vs 匯率設定(原始匯率數值)。
// 貨物稅完稅價格計算率：貨物稅完稅價格 = (廠價 - 水平配件外移調降 - 廣促margin) × 本率 ÷ (1+貨物稅率)，
// 對應實務上完稅價格的法定扣除（Gate F Excel 用 0.91）。
var TAX_RATE_PARAM_NAMES = ['營業稅率', '銷售佣金率', '季Margin率', '貨物稅率', '貨物稅完稅價格計算率'];
// 匯率只保留一種「現況匯率」：原本還有「集團預算匯率」，但全系統只有匯率設定頁面自己在顯示它，
// 沒有任何計算讀它(銷貨成本與開發總投換算都固定用 COST_FX_PARAM_NAME = 現況匯率)，
// 留著只會讓人以為要填兩種匯率，故移除。
var FX_PARAM_NAMES = ['現況匯率'];

// 匯率設定以「幣別 × 匯率種類」管理，1 外幣 = Value 台幣。
// 本位幣不需設定匯率；銷貨成本頁的幣別選單就是這裡設定過的幣別。
var BASE_CURRENCY = 'TWD';
var DEFAULT_FX_CURRENCIES = ['CNY', 'USD', 'JPY', 'EUR'];

// 銷貨成本以外幣登打時，用這個匯率種類換算成台幣（於「匯率設定」頁面維護）。
var COST_FX_PARAM_NAME = '現況匯率';

// 自動計算科目的來源代碼（PLLineItems.AutoSource）。有 AutoSource 的科目不出現在
// 手動輸入頁面的科目下拉選單中，一律由 CalcEngine 依比率或開發總投攤提算出。
var AUTO_SOURCE = {
  PRICE: 'PRICE',                          // 售價結構列，由 SalesMix 售價欄位推算
  DEV_MOLD: 'DEV_MOLD',                    // 開發總投(模具) / LIFE CYCLE 總台數
  DEV_EQUIP: 'DEV_EQUIP',                  // 開發總投(設備) / LIFE CYCLE 總台數
  DEV_EXPENSE_CMC: 'DEV_EXPENSE_CMC',      // 開發總投(費用, CMC) / LIFE CYCLE 總台數
  DEV_EXPENSE_BASE: 'DEV_EXPENSE_BASE',    // 開發總投(費用, BASE廠) / LIFE CYCLE 總台數
  RATE_COMMODITY_TAX: 'RATE_COMMODITY_TAX',// 完稅價格 × 貨物稅率
  RATE_QUARTER_MARGIN: 'RATE_QUARTER_MARGIN', // 廠價(未稅) × 季Margin率
  DEV_AMORT: 'DEV_AMORT'                   // 使用者在「開發總投」頁面自訂新增的攤提落點科目
};

// 開發總投攤提落點可以選的科目 = AutoSource 屬於這個集合的科目。
// 內建的 4 個(b5/b8/f3/f4)以及使用者新增的攤提落點科目都算，這些科目一律不能在
// 「銷貨成本」「營業費用」頁面手動輸入金額(避免跟開發總投攤提的金額重複計列)。
var DEV_AMORT_AUTO_SOURCES = [
  AUTO_SOURCE.DEV_MOLD, AUTO_SOURCE.DEV_EQUIP,
  AUTO_SOURCE.DEV_EXPENSE_CMC, AUTO_SOURCE.DEV_EXPENSE_BASE, AUTO_SOURCE.DEV_AMORT
];

// 結構科目(小計/毛利/淨利)與自動計算科目不允許在「科目設定」頁面刪除，
// 否則損益鏈會斷掉。其餘明細科目(b*/d*/f1/h*/J)皆可自由新增與刪除。
var PROTECTED_LINE_CODES = ['A', 'B', 'C', 'E', 'G', 'I', 'K'];

// 科目代碼由系統自動產生流水號：父科目字首 + 目前未被使用的最小號碼(b1、b2、d1、f1、h1...)。
// 使用者只需要選父科目、填科目名稱，不必自己編碼、也不會撞號。
var LINE_CODE_PREFIX = { B: 'b', E: 'd', G: 'f', I: 'h' };

// 「科目設定」「營業費用」等頁面共用的父科目下拉選項（父科目決定這個科目落在損益鏈的哪一段）
var PL_LINE_PARENT_OPTIONS = [
  ['B', 'B 銷貨成本'],
  ['E', 'E 銷售費用(銷貨毛利前)'],
  ['G', 'G 產品貢獻前費用'],
  ['I', 'I 固定營業費用']
];

// ---- 計算來源(PLLineItems.CalcType) ----
// 每個科目只有三種計算來源，取代以前寫死在 CalcEngine 裡的「自動計算科目」：
//   INPUT     手動輸入：在「銷貨成本」「營業費用」頁每個車系各填金額
//   FORMULA   公式：用其他科目、參數、系統變數算出來(見 FormulaEngine.gs 的語法說明)
//   DEV_AMORT 開發總投攤提：開發總投頁選到這個科目當攤提落點的金額 ÷ LC 總台數
var CALC_TYPES = { INPUT: 'INPUT', FORMULA: 'FORMULA', DEV_AMORT: 'DEV_AMORT' };
var CALC_TYPE_LABELS = { INPUT: '手動輸入', FORMULA: '公式', DEV_AMORT: '開發總投攤提' };

// 損益區段：父科目決定科目落在損益鏈的哪一段，也決定手動輸入的金額存在哪一頁
// (B 底下 → 銷貨成本頁，其餘 → 營業費用頁)。
var COST_SECTION_PARENTS = ['B'];

// 公式可以用 [名稱] 引用的系統變數(由銷售構成與情境設定提供，每個車系各自一個值)
var SYSTEM_VARIABLES = [
  { name: '建議零售價', desc: '銷售構成：建議零售價(含稅)' },
  { name: '強配件售價', desc: '銷售構成：強配件售價' },
  { name: '廢車處理費', desc: '銷售構成：廢車處理費(照登打的金額)' },
  { name: '廢車處理費(含稅)', desc: '廢車處理費換算成含稅金額(登打未稅時 × (1+營業稅率) 取整)' },
  { name: '水平配件調降', desc: '銷售構成：水平配件外移調降廠價' },
  { name: '月銷量', desc: '這個車系的預估月銷台數' },
  { name: 'LC年限', desc: '這個車系的 LC 年限' },
  { name: 'LC總台數', desc: '這個車系的 月銷量 × 12 × LC年限' },
  { name: '構成比', desc: '這個車系的銷售構成比(小數，40% = 0.4)' },
  { name: '車型月總台數', desc: '這個情境所有車系月銷量合計' },
  { name: '攤提總台數', desc: '開發總投攤提用的 LIFE CYCLE 總台數' }
];

// 損益科目鏈的「標準範本」：新車型預設複製這一份，之後各車型可以自由增刪改(科目在不同車型間差異很大，
// 不能拿某一個車型當所有車型的基底)。名稱只寫科目本身，公式另外存在 Formula 欄，畫面上看得到也改得動。
var PL_LINE_ITEMS = [
  // ---- 售價結構(P*)：由銷售構成的售價欄位與比率參數推算 ----
  { LineCode: 'P1', LineName: '建議零售價(含稅)', ParentLine: '', Category: '售價結構', SortOrder: 1, CalcType: 'FORMULA', Formula: '[建議零售價]' },
  { LineCode: 'P2', LineName: '強配件售價', ParentLine: '', Category: '售價結構', SortOrder: 2, CalcType: 'FORMULA', Formula: '[強配件售價]' },
  { LineCode: 'P3', LineName: '建議零售價(不含強配,含稅)', ParentLine: '', Category: '售價結構', SortOrder: 3, CalcType: 'FORMULA', Formula: 'P1 - P2' },
  { LineCode: 'P4', LineName: '廢車處理費(換算含稅)', ParentLine: '', Category: '售價結構', SortOrder: 4, CalcType: 'FORMULA', Formula: '[廢車處理費(含稅)]' },
  { LineCode: 'P5', LineName: '實際零售價(含稅)', ParentLine: '', Category: '售價結構', SortOrder: 5, CalcType: 'FORMULA', Formula: 'P3 - P4' },
  { LineCode: 'P6', LineName: '營業稅', ParentLine: '', Category: '售價結構', SortOrder: 6, CalcType: 'FORMULA', Formula: 'ROUND(P5 * [營業稅率] / (1 + [營業稅率]))' },
  { LineCode: 'P7', LineName: '銷售佣金', ParentLine: '', Category: '售價結構', SortOrder: 7, CalcType: 'FORMULA', Formula: 'ROUND((P5 - P6) * [銷售佣金率])' },
  { LineCode: 'P8', LineName: '廠價(未稅)', ParentLine: '', Category: '售價結構', SortOrder: 8, CalcType: 'FORMULA', Formula: 'P5 - P6 - P7' },
  { LineCode: 'P9', LineName: '強配收入(未稅)', ParentLine: '', Category: '售價結構', SortOrder: 9, CalcType: 'FORMULA', Formula: 'P2 / (1 + [營業稅率])' },

  { LineCode: 'A', LineName: '收入(未稅,含強配)', ParentLine: '', Category: '收入', SortOrder: 10, CalcType: 'FORMULA', Formula: 'P8 + P9' },
  { LineCode: 'B', LineName: '銷貨成本合計', ParentLine: '', Category: '成本', SortOrder: 20, CalcType: 'FORMULA', Formula: 'CHILDREN()' },
  // SortOrder 依實際 Gate F 損益試算表的列序排列（科目代碼維持原值，改代碼會讓已輸入的金額對不到科目）
  { LineCode: 'b1', LineName: '材料成本-LP', ParentLine: 'B', Category: '成本明細', SortOrder: 21, CalcType: 'INPUT' },
  { LineCode: 'b14', LineName: '內陸運雜', ParentLine: 'B', Category: '成本明細', SortOrder: 22, CalcType: 'INPUT' },
  { LineCode: 'b2', LineName: '材料成本-KD', ParentLine: 'B', Category: '成本明細', SortOrder: 23, CalcType: 'INPUT' },
  { LineCode: 'b3', LineName: '強配成本', ParentLine: 'B', Category: '成本明細', SortOrder: 24, CalcType: 'INPUT' },
  { LineCode: 'b4', LineName: '一般材料', ParentLine: 'B', Category: '成本明細', SortOrder: 25, CalcType: 'INPUT' },
  { LineCode: 'b10', LineName: '水平配件', ParentLine: 'B', Category: '成本明細', SortOrder: 26, CalcType: 'INPUT' },
  { LineCode: 'b8', LineName: '新增專屬設備', ParentLine: 'B', Category: '成本明細', SortOrder: 27, CalcType: 'DEV_AMORT', AutoSource: AUTO_SOURCE.DEV_EQUIP, DevAmortCategory: '設備' },
  { LineCode: 'b5', LineName: '模具費用', ParentLine: 'B', Category: '成本明細', SortOrder: 28, CalcType: 'DEV_AMORT', AutoSource: AUTO_SOURCE.DEV_MOLD, DevAmortCategory: '模具' },
  { LineCode: 'b6', LineName: '直接人工', ParentLine: 'B', Category: '成本明細', SortOrder: 29, CalcType: 'INPUT' },
  { LineCode: 'b7', LineName: '製造費用', ParentLine: 'B', Category: '成本明細', SortOrder: 30, CalcType: 'INPUT' },
  { LineCode: 'b9', LineName: '技酬金', ParentLine: 'B', Category: '成本明細', SortOrder: 31, CalcType: 'INPUT' },
  { LineCode: 'b11', LineName: '防鏽', ParentLine: 'B', Category: '成本明細', SortOrder: 32, CalcType: 'INPUT' },
  { LineCode: 'b12', LineName: '廢棄物處理及包材', ParentLine: 'B', Category: '成本明細', SortOrder: 33, CalcType: 'INPUT' },
  { LineCode: 'b13', LineName: '貨物稅', ParentLine: 'B', Category: '成本明細', SortOrder: 34, CalcType: 'FORMULA',
    Formula: '(P8 - [水平配件調降] - TAXDEDUCT()) * [貨物稅完稅價格計算率] / (1 + [貨物稅率]) * [貨物稅率]' },
  { LineCode: 'C', LineName: '生產毛利', ParentLine: '', Category: '毛利', SortOrder: 40, CalcType: 'FORMULA', Formula: 'A - B' },
  { LineCode: 'd1', LineName: '廣宣費用', ParentLine: 'E', Category: '費用明細', SortOrder: 41, CalcType: 'INPUT', CommodityTaxDeduct: 'Y' },
  { LineCode: 'd2', LineName: '促銷', ParentLine: 'E', Category: '費用明細', SortOrder: 42, CalcType: 'INPUT', CommodityTaxDeduct: 'Y' },
  { LineCode: 'd3', LineName: '批標售', ParentLine: 'E', Category: '費用明細', SortOrder: 43, CalcType: 'INPUT', CommodityTaxDeduct: 'Y' },
  { LineCode: 'd4', LineName: '季Margin', ParentLine: 'E', Category: '費用明細', SortOrder: 44, CalcType: 'FORMULA', Formula: 'P8 * [季Margin率]', CommodityTaxDeduct: 'Y' },
  { LineCode: 'd5', LineName: '索賠(含索賠取回)', ParentLine: 'E', Category: '費用明細', SortOrder: 45, CalcType: 'INPUT' },
  { LineCode: 'E', LineName: '銷貨毛利', ParentLine: '', Category: '毛利', SortOrder: 50, CalcType: 'FORMULA', Formula: 'C - CHILDREN()' },
  { LineCode: 'f1', LineName: '直接歸屬費用-CMC&SDM', ParentLine: 'G', Category: '費用明細', SortOrder: 51, CalcType: 'INPUT' },
  { LineCode: 'f3', LineName: '車型專案開發費用-CMC', ParentLine: 'G', Category: '費用明細', SortOrder: 52, CalcType: 'DEV_AMORT', AutoSource: AUTO_SOURCE.DEV_EXPENSE_CMC, DevAmortCategory: '費用' },
  { LineCode: 'f4', LineName: '車型專案開發費用-BASE廠', ParentLine: 'G', Category: '費用明細', SortOrder: 53, CalcType: 'DEV_AMORT', AutoSource: AUTO_SOURCE.DEV_EXPENSE_BASE, DevAmortCategory: '費用' },
  { LineCode: 'G', LineName: '產品貢獻', ParentLine: '', Category: '貢獻', SortOrder: 60, CalcType: 'FORMULA', Formula: 'E - CHILDREN()' },
  { LineCode: 'h1', LineName: '固定營業費用-CMC&SDM', ParentLine: 'I', Category: '費用明細', SortOrder: 61, CalcType: 'INPUT' },
  { LineCode: 'h3', LineName: '品牌廣宣費用', ParentLine: 'I', Category: '費用明細', SortOrder: 62, CalcType: 'INPUT' },
  { LineCode: 'h4', LineName: '特別加發', ParentLine: 'I', Category: '費用明細', SortOrder: 63, CalcType: 'INPUT' },
  { LineCode: 'I', LineName: '營業淨利(未扣前瞻)', ParentLine: '', Category: '淨利', SortOrder: 70, CalcType: 'FORMULA', Formula: 'G - CHILDREN()' },
  { LineCode: 'J', LineName: '前瞻費用', ParentLine: '', Category: '費用', SortOrder: 71, CalcType: 'INPUT' },
  { LineCode: 'K', LineName: '營業淨利', ParentLine: '', Category: '淨利', SortOrder: 80, CalcType: 'FORMULA', Formula: 'I - J' }
];

// 舊版科目名稱(名稱裡寫著公式)：改版時把還是舊名稱的科目換成新名稱，使用者改過的名稱不動
var LEGACY_LINE_NAMES = {
  P3: '建議零售價(不含強配,含稅)(=P1-P2)', P5: '實際零售價(含稅)(=P3-P4)', P6: '營業稅(=P5×稅率/(1+稅率))',
  P7: '銷售佣金(=(P5-P6)×佣金率)', P8: '廠價(未稅)(=P5-P6-P7)', P9: '強配收入(未稅)(=P2÷(1+稅率))',
  A: '收入(未稅,含強配)(=P8+P9)', C: '生產毛利(=A-B)', E: '銷貨毛利(=C-Σd)', G: '產品貢獻(=E-Σf)',
  I: '營業淨利(未扣前瞻)(=G-Σh)', K: '營業淨利(=I-J)',
  b8: '新增專屬設備(開發總投/LC總台數)', b5: '模具費用(開發總投/LC總台數)', b13: '貨物稅(完稅價格×貨物稅率)',
  d4: '季Margin(廠價未稅×季Margin率)', f3: '車型專案開發費用-CMC(開發總投/LC總台數)',
  f4: '車型專案開發費用-BASE廠(開發總投/LC總台數)'
};

// 標準範本裡每個科目的預設公式(恢復預設、判斷「使用者有沒有改過公式」用)
var DEFAULT_FORMULAS = (function () {
  var map = {};
  PL_LINE_ITEMS.forEach(function (d) { if (d.Formula) map[d.LineCode] = d.Formula; });
  return map;
})();

// 改善作法的狀態
var ACTION_STATUSES = ['規劃中', '進行中', '已確認', '已結案'];

// 全域預設參數（Parameters 分頁沒有查到對應值時的 fallback）。
// 比率一律為百分比數值：5 = 5%、0.5 = 0.5%。
// 內建參數的單位：'%' 以百分比數值輸入(5 = 5%)，公式取用時自動 ÷100；'數值' 原值取用。
var BUILTIN_PARAM_UNITS = { '營業稅率': '%', '銷售佣金率': '%', '季Margin率': '%', '貨物稅率': '%', '貨物稅完稅價格計算率': '%' };
var PARAM_UNITS = ['%', '數值'];

var DEFAULT_PARAMS = {
  '營業稅率': 5,
  '銷售佣金率': 6,
  '季Margin率': 0.5,
  '貨物稅率': 15,
  '貨物稅完稅價格計算率': 91,
  '現況匯率': 1
};

// 舊資料轉換用：資產類型還是舊的「費用」時，Department 等於這個值就視為 f4(BASE廠)，其餘為 f3(CMC)。
var DEV_INVESTMENT_BASE_FACTORY_DEPT = 'BASE廠開發費';

// 開發總投「部門說明」(GATE 報告開發總投 by 部門的說明欄)存在 LineNotes，LineCode = 這個前綴 + 部門名稱。
// 每一筆投資自己的 Notes 是「項目」(例：上汽開發費底下的 RMB 3000萬、技術授權金)，部門說明是整個部門一段。
var DEV_DEPT_NOTE_PREFIX = 'DEPT:';

// ChallengeReductionPct 同樣以百分比數值(0~100)輸入及儲存(如 15 代表 15%)。
// 挑戰低減目標屬於情境層級的假設：同一個 GATE 下的「現況」與「目標」情境各自填自己的低減目標，
// 因此不需要額外欄位標記，直接由該情境的 DevInvestment 列決定。

/**
 * 純文字欄位（代號/名稱/備註等）：寫入 Sheet 前一律強制成純文字格式('@')，
 * 否則 Sheet 預設的「自動偵測格式」會把長得像數字的字串（如情境名稱「0901」）
 * 自動轉成數字 901，前面的 0 就這樣不見了，而且是在存檔當下悄悄發生、不會有任何錯誤訊息。
 * 純數字/比率/日期欄位不列在這裡，維持原本的數字格式。
 */
var TEXT_COLUMNS = {
  VehicleTypes: ['VehicleTypeID', 'Notes'],
  Vehicles: ['VehicleID', 'VehicleTypeID', 'VehicleCode', 'Notes'],
  Scenarios: ['ScenarioID', 'Gate', 'ScenarioName', 'ScenarioType', 'VehicleTypeID', 'CreatedBy', 'Notes'],
  SalesMix: ['RowID', 'ScenarioID', 'VehicleID', 'ScrapFeeTaxStatus', 'Notes'],
  CostOfSales: ['RowID', 'ScenarioID', 'VehicleID', 'LineCode', 'Currency', 'Notes'],
  DevInvestment: ['RowID', 'ScenarioID', 'Department', 'AssetType', 'Currency', 'Notes', 'TargetLineCode', 'VehicleScope'],
  OperatingExpense: ['RowID', 'ScenarioID', 'VehicleID', 'LineCode', 'Notes'],
  Parameters: ['ParamID', 'ScenarioID', 'VehicleID', 'ParamName', 'Currency'],
  PLLineItems: ['LineID', 'VehicleTypeID', 'LineCode', 'LineName', 'ParentLine', 'Category', 'CalcType', 'Formula',
    'VehicleFormulas', 'AutoSource', 'CommodityTaxDeduct', 'DevAmortCategory', 'Description'],
  PLResult: ['ResultID', 'ScenarioID', 'VehicleID', 'LineCode'],
  ParamDefs: ['ParamName', 'Unit', 'Description'],
  LineNotes: ['RowID', 'ScenarioID', 'LineCode', 'VehicleID', 'Notes'],
  Actions: ['ActionID', 'VehicleTypeID', 'ScenarioID', 'LineCode', 'Title', 'Detail', 'Owner', 'Status', 'DueDate'],
  Snapshots: ['SnapshotID', 'VehicleTypeID', 'ScenarioID', 'SnapshotName', 'CreatedAt', 'CreatedBy', 'Notes', 'Data']
};
