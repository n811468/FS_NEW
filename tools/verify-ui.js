/**
 * 前端渲染的靜態驗證：
 *
 *   node tools/verify-ui.js
 *
 * 前端程式(src/ui/*.js)只有在瀏覽器裡才跑得到，但裡面產生 HTML 的函式其實是純函式。
 * 這裡把前端 JS 串起來(tools/frontend.js)、給最小的 document/google 假物件，
 * 再用計算引擎真實算出來的資料呼叫那些函式，檢查產出的表格結構是否正確
 * （欄數、colspan、縮排、% 欄基準），避免版面改壞了卻要部署後才發現。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadAppsScript } = require('./fake-apps-script');

const failures = [];
function assert(cond, message) { if (!cond) failures.push(message); }

/* ---- 1. 用計算引擎算出一份真實的比較結果 ---- */
const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs', 'XlsxWriter.gs', 'VerifyWorkbook.gs', 'VerifyImport.gs']);
gs.setupSpreadsheet();
gs.saveVehicleType({ VehicleTypeID: 'DA' });
gs.saveVehicle({ VehicleID: 'V1', VehicleTypeID: 'DA', VehicleCode: '3人貨車' });
gs.saveVehicle({ VehicleID: 'V2', VehicleTypeID: 'DA', VehicleCode: '9人客貨車' });
const sc = gs.createScenarioFrom({
  ScenarioID: '', Gate: 'GATE F', ScenarioName: '901', ScenarioType: '現況', VehicleTypeID: 'DA'
}, '', []);
gs.saveSalesMixGrid(sc.ScenarioID, 'DA', [
  { RowID: '', VehicleID: 'V1', SalesMixPct: 40, MonthlyVolume: 40, LifeCycleYears: 10, ListPriceTaxIncl: 1000000, MandatoryAccessoryPrice: 10574, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' },
  { RowID: '', VehicleID: 'V2', SalesMixPct: 60, MonthlyVolume: 60, LifeCycleYears: 10, ListPriceTaxIncl: 1200000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }
]);
gs.saveCostOfSalesMatrix(sc.ScenarioID, [
  { RowID: '', VehicleID: 'V1', LineCode: 'b1', Amount: 400000, Currency: 'TWD' },
  { RowID: '', VehicleID: 'V2', LineCode: 'b1', Amount: 500000, Currency: 'TWD' }
]);
const comparison = gs.calculateComparison([
  { ScenarioID: sc.ScenarioID, VehicleID: 'V1' },
  { ScenarioID: sc.ScenarioID, VehicleID: 'V2' },
  { ScenarioID: sc.ScenarioID, VehicleID: '' }
]);

/* ---- 2. 把前端 JS 載進來 ---- */
const js = require('./frontend').frontendJs();
const noopEl = {
  innerHTML: '', textContent: '', className: '', value: '', style: {}, options: [],
  querySelector: () => noopEl, querySelectorAll: () => [], insertAdjacentHTML: () => { }, select: () => { },
  classList: { add: () => { }, remove: () => { }, toggle: () => { }, contains: () => false }
};
// draw*() 函式常常對好幾個不同 id 的元素各自設 innerHTML(工具列/表格分開設定)，
// 單一共用的 noopEl 會讓後面的賦值蓋掉前面的內容，測試就讀不到工具列那段 HTML。
// 這裡改成依 id 各自存一份，才能個別檢查每個區塊實際產生的內容。
const elById_ = {};
function elFor_(id) {
  if (!elById_[id]) {
    elById_[id] = Object.assign({}, noopEl, { innerHTML: '' });
  }
  return elById_[id];
}
// google.script.run 呼叫鏈(withSuccessHandler().withFailureHandler().任何RPC函式())在 Node 裡沒有
// 真的後端可以回應，這裡用一個「呼叫什麼都回傳自己」的 Proxy 接住整條鏈，讓 draw*/render* 這類
// 會觸發 google.script.run 的函式在測試裡也能正常跑完，不會因為 run 是空物件而丟例外。
const scriptRunStub = new Proxy(() => scriptRunStub, { get: () => scriptRunStub });
const ctx = {
  console,
  document: { getElementById: id => elFor_(id), querySelector: () => noopEl, querySelectorAll: () => [] },
  window: { addEventListener: () => { } },
  google: { charts: { load: () => { }, setOnLoadCallback: () => { } }, script: { run: scriptRunStub } },
  confirm: () => true, alert: () => { }
};
vm.createContext(ctx);
vm.runInContext(js, ctx, { filename: 'src/ui' });

// 前端用 const/let 宣告，這些是 context 的語彙繫結而不是 global 屬性，
// 不能用 ctx.xxx 存取，得在同一個 context 裡再跑一段程式碼才拿得到／改得動。
const api = expr => vm.runInContext(expr, ctx);
ctx.__in = {};   // 要塞進 context 的外部資料先掛在這裡

/* ---- 3. 檢查損益表的結構 ---- */
const countTag = (s, tag) => (s.match(new RegExp('<' + tag + '[\\s>]', 'g')) || []).length;
const cols = comparison.columns;
const lines = comparison.lines;
/** 跟前端 colKey_() 同一個公式，測試裡用來組出比較欄位的鍵值 */
const colKeyOf_ = col => (col.scenarioId || '') + '|' + (col.vehicleId || '');

function checkTable(pctBase, showPriceStructure) {
  api(`pctBase = ${JSON.stringify(pctBase)}`);
  api(`showPriceStructure = ${showPriceStructure}`);
  const label = `pctBase=${pctBase} 售價結構=${showPriceStructure}`;
  const table = api('plTableHtml')(cols, lines);
  const perCol = pctBase === 'none' ? 1 : 2;
  const span = cols.length * perCol + 1;

  assert(table.indexOf('undefined') === -1, `${label}：表格中出現 undefined`);
  assert(table.indexOf('[object Object]') === -1, `${label}：表格中出現 [object Object]`);

  // 區段標題列的 colspan 要剛好蓋滿整張表
  const spans = (table.match(/colspan="(\d+)"/g) || []).map(m => Number(m.match(/\d+/)[0]));
  const sectionSpans = spans.filter(n => n > 2);
  assert(sectionSpans.length > 0, `${label}：找不到區段標題列`);
  sectionSpans.forEach(n => assert(n === span, `${label}：區段列 colspan ${n} 應為 ${span}`));

  // 每一列的儲存格數 = 項目(不含科目代碼) + 各比較欄位
  const bodyRows = table.split('<tbody>')[1].split('</tbody>')[0]
    .split('<tr').slice(1).filter(r => r.indexOf('class="section"') === -1);
  bodyRows.forEach(row => {
    const tds = countTag(row, 'td');
    assert(tds === span, `${label}：資料列的儲存格數為 ${tds}，應為 ${span}`);
  });

  // 科目代碼欄已移除(不利閱讀)，改用售價結構的區段標題判斷有沒有顯示
  // (不能用「廠價(未稅)」字樣本身 —— 貨物稅格子的 hover 提示文字裡也會出現這幾個字)
  const priceRowShown = table.indexOf('class="section"><td colspan') !== -1 && table.indexOf('售價結構（由「銷售構成」') !== -1;
  assert(priceRowShown === showPriceStructure, `${label}：售價結構的顯示狀態不正確`);
  assert(table.indexOf('<td class="code">') === -1, `${label}：不應再出現科目代碼欄`);

  // 明細科目要縮排、小計要反白
  assert(table.indexOf('class="detail"') !== -1, `${label}：成本明細列應該帶 detail 樣式`);
  assert(table.indexOf('<tr class="subtotal">') !== -1, `${label}：小計列應該帶 subtotal 樣式`);
  return table;
}

const tableExFactory = checkTable('exfactory', true);
checkTable('revenue', true);
checkTable('none', false);

/* ---- 3b. 損益表：B/E/G/I 大項可收合，且提示改用 data-tip(不是原生 title) ---- */
api('collapsedGroups = new Set()');
const expandedTable = api('plTableHtml')(cols, lines);
assert(expandedTable.indexOf('class="row-toggle"') !== -1, '大項小計列應該有收合按鈕');
assert(expandedTable.indexOf('aria-expanded="true"') !== -1, '預設應該是展開狀態');
assert(expandedTable.indexOf(' title="') === -1, '公式/自動計算提示不該用原生 title(會被表格的橫向捲動裁切)');
assert((expandedTable.match(/data-tip="/g) || []).length > 0, '公式/自動計算提示應該用 data-tip');
assert(expandedTable.indexOf('class="auto-dot"') !== -1, '自動計算科目應該有提示用的圓點');
// 每一格金額/%、每個欄位標題、每個科目名稱都要能 hover 出說明(內容移過去才算，用 data-tipfn 指定產生器)
assert(expandedTable.indexOf('data-tipfn="cell"') !== -1, '金額格子應該帶 data-tipfn="cell"');
assert(expandedTable.indexOf('data-tipfn="col"') !== -1, '欄位標題應該帶 data-tipfn="col"');
assert(expandedTable.indexOf('data-tipfn="line"') !== -1, '科目名稱應該帶 data-tipfn="line"');
assert((expandedTable.match(/data-c="\d+"/g) || []).length > cols.length * 10, '每一格都要標記所屬欄位(十字游標與提示用)');
assert(expandedTable.indexOf('class="star') !== -1, '欄位標題應該有設為比較基準的星號');

api("toggleGroupCollapse('B')");
assert(api('collapsedGroups').has('B'), '收合後 collapsedGroups 應該記得 B 已收合');
const collapsedTable = api('plTableHtml')(cols, lines);
assert(collapsedTable.indexOf('aria-expanded="false"') !== -1, '收合後按鈕狀態應該變成 false');
const collapsedDetailRows = collapsedTable.split('<tbody>')[1].split('</tbody>')[0]
  .split('<tr').slice(1).filter(r => r.indexOf('class="detail"') !== -1 && r.indexOf(' hidden') !== -1);
assert(collapsedDetailRows.length > 0, 'B 收合後，B 底下的明細列應該帶 hidden 屬性');
api("toggleGroupCollapse('B')"); // 復原，避免影響後面的測試
assert(!api('collapsedGroups').has('B'), '再次點擊應該恢復展開');

/* ---- 4. % 欄的基準要真的不同（這份資料有強配件，廠價 ≠ 收入） ---- */
api("pctBase = 'exfactory'");
const col0 = cols[0];
assert(Math.abs(col0.revenue - col0.exFactoryPrice) > 1,
  '測試資料應該要有強配收入，才能分辨兩種百分比基準');
const pctEx = api('pctCellHtml')(col0.amounts.B, col0);
api("pctBase = 'revenue'");
const pctRev = api('pctCellHtml')(col0.amounts.B, col0);
assert(pctEx !== pctRev, '切換 % 基準後銷貨成本的百分比應該要改變');
const expectedEx = (col0.amounts.B / col0.exFactoryPrice * 100).toFixed(1) + '%';
assert(pctEx.indexOf(expectedEx) !== -1, `對廠價% 應為 ${expectedEx}，實際 ${pctEx}`);

/* ---- 5. 小計驗算與工具列 ---- */
assert(api('subtotalCheckHtml')(cols).indexOf('小計驗算通過') !== -1, '正常資料應顯示驗算通過');
const broken = [{ label: '測試欄', checks: [{ label: 'C = A - B', actual: 1, expected: 2, diff: -1 }] }];
assert(api('subtotalCheckHtml')(broken).indexOf('check-box') !== -1, '有差異時應顯示警告框');

api("chartLineCodes = ['A', 'K']");
api("chartType = 'byLine'");
const toolbar = api('dashboardToolbarHtml')(cols);
assert(toolbar.indexOf('id="chart-lines"') === -1, '% 基準工具列不該再混著圖表科目選擇區(已移到圖表旁邊)');
['pctBase', 'amountUnit', 'volumeBasis', 'highlightBest', 'showKpi'].forEach(name => {
  assert(toolbar.indexOf(`setDashOption('${name}'`) !== -1, `工具列應該有 ${name} 的開關`);
});
assert(toolbar.indexOf('value="diff"') !== -1 && toolbar.indexOf('value="diffpct"') !== -1, '第二小欄應該可以選「與基準差異」');
assert(toolbar.indexOf('onchange="setBaselineColumn(this.value)"') !== -1, '工具列應該有比較基準下拉選單');
assert(toolbar.indexOf('>(不設定)<') !== -1, '比較基準下拉選單應該有「(不設定)」選項');
const chartSection = api('chartSectionHtml')(cols, lines);
assert(chartSection.indexOf('id="chart-lines"') !== -1, '圖表區塊應該有科目選擇區');
assert(chartSection.indexOf('id="chart-area"') !== -1, '圖表區塊應該跟科目選擇區放在一起');
assert(chartSection.indexOf('<svg') !== -1, '圖表應該直接以 SVG 產生，不依賴外部圖表程式庫');
assert(chartSection.indexOf('google.visualization') === -1 && js.indexOf('gstatic.com/charts') === -1, '不該再用 Google Charts');
// 原生 multiple select 要按住 Ctrl 才能複選，等於選不動；必須是核取方塊
assert(chartSection.indexOf('multiple') === -1, '圖表科目不該用原生 multiple select');
const chartPicker = chartSection.split('id="chart-lines"')[1].split('</div>')[0];
assert((chartPicker.match(/type="checkbox"/g) || []).length > 10, '每個科目都應該有一個核取方塊');
assert((chartPicker.match(/ checked/g) || []).length === 2, '預設應勾選 A 與 K 兩個科目');
assert(chartPicker.indexOf('onchange="onChartLineToggle') !== -1, '勾選應該即時重畫圖表');
assert(chartPicker.indexOf('value="P8"') === -1, '售價結構科目不應出現在圖表科目選單');
['科目比較', '依欄位', '損益結構'].forEach(t => assert(chartSection.indexOf(t) !== -1, `圖表類型切換應該有「${t}」`));
assert(chartSection.indexOf('損益瀑布') === -1, '圖表類型不該再有「損益瀑布」(統一用瀑布圖工具)');

// 勾選/取消要真的改變圖表要畫的科目
api("chartLineCodes = ['A', 'K']");
api('onChartLineToggle')('C', true);
assert(api('chartLineCodes').join(',') === 'A,K,C', `勾選後應加入科目，實際 ${api('chartLineCodes')}`);
api('onChartLineToggle')('A', false);
assert(api('chartLineCodes').join(',') === 'K,C', `取消勾選後應移除科目，實際 ${api('chartLineCodes')}`);
api("chartLineCodes = ['A', 'K']");

/* ---- 6. 主檔表格：主鍵鎖定；科目與公式編輯器 ---- */
const ENTITIES = api('ENTITIES');
const entityCellHtml = api('entityCellHtml');
assert(!ENTITIES.lineitems, '科目設定改用專用的「科目與公式」編輯器，不再是通用主檔表格');
const typeCfg = ENTITIES.vehicletypes;
const idCol = typeCfg.columns[0];
assert(entityCellHtml('vehicletypes', 0, idCol, { __existing: true, VehicleTypeID: 'DA' }).indexOf('<input') === -1,
  '已建立的車型代號應該鎖住');
assert(entityCellHtml('vehicletypes', 0, idCol, { __existing: false, VehicleTypeID: '' }).indexOf('<input') !== -1,
  '新增列的車型代號應該可以輸入');
assert(ENTITIES.vehicles.sortable === 'setVehicleOrder' && !ENTITIES.vehicles.columns.some(c => c.name === 'SortOrder'),
  '車系順序改用拖曳(放開即存)，不再要使用者自己填排序值');

ctx.__in.chartEditor = gs.getChartEditor('DA', sc.ScenarioID);
api('chartEditor = __in.chartEditor');
ctx.__in.sid = sc.ScenarioID;
api('currentScenarioId = __in.sid');
const readable = api('formulaReadableHtml_')('P8 * [季Margin率] + CHILDREN() - zz9');
assert(readable.indexOf('廠價(未稅)') !== -1, '公式的可讀版本應該把代碼換成科目名稱');
assert(readable.indexOf('季Margin率') !== -1 && readable.indexOf('[') === -1, '[名稱] 應顯示成名稱、不留中括號');
assert(readable.indexOf('Σ子科目') !== -1, 'CHILDREN() 應顯示成「Σ子科目」');
assert(/negative">zz9/.test(readable), '不存在的代碼要標紅');
const parents = api('chartParentOptions_')('b1').map(o => o[0]);
assert(parents.indexOf('B') !== -1 && parents.indexOf('E') !== -1 && parents.indexOf('') !== -1, '父科目選項應包含各段小計與頂層');
assert(parents.indexOf('P8') === -1 && parents.indexOf('b1') === -1, '不會加總子科目的科目、自己都不該是父科目選項');
assert(api('chartParentOptions_')('B').indexOf('b1') === -1, '不能把自己的子科目選成父科目');
api("chartSelected = 'd4'");
api("chartDraft = JSON.parse(JSON.stringify(chartEditor.lines.find(l => l.LineCode === 'd4')))");
const paneHtml = api('chartEditorPaneHtml_')();
assert(paneHtml.indexOf('calc-type-card active') !== -1 && paneHtml.indexOf('class="fx-rows"') !== -1, '公式科目應該選中「公式」，拆得成一行一項就用一行一項');
assert(/fx-slot kind-line[^>]*>\s*<span class="nm">廠價\(未稅\)/.test(paneHtml) && /fx-slot kind-param[^>]*>\s*<span class="nm">季Margin率/.test(paneHtml),
  '季Margin 應該顯示成一行：廠價(未稅) × 季Margin率');
assert(paneHtml.indexOf('tpl-btn') === -1, '常用寫法按鈕已經拿掉');
// 公式文字 ⇄ 一行一項 來回轉換：拆得成的轉回去意思不變；拆不成的(函式、括號巢狀)回傳 null 改用膠囊
const fxRound = f => { const t = api('fxTermsFromToks_')(api('fxTokenize_')(f)); return t ? api('fxTermsText_')(t) : null; };
[
  ['[廠價(未稅)] * [季Margin率]', '[廠價(未稅)] * [季Margin率]'],
  ['C - CHILDREN()', 'C - CHILDREN()'],
  ['P5-P6-P7', 'P5 - P6 - P7'],
  ['P2 / (1 + [營業稅率])', 'P2 / (1 + [營業稅率])'],
  ['REF("SC-1","b4")*1.2', 'REF("SC-1", "b4") * 1.2'],
  ['-[a] + 15% × [b] ÷ 2', '-[a] + 15% * [b] / 2'],
  ['', '']
].forEach(([src, want]) => assert(fxRound(src) === want, `一行一項來回轉換：${src} → ${fxRound(src)}（應為 ${want}）`));
['ROUND(P5 * [營業稅率] / (1 + [營業稅率]))', '(P8 - [水平配件調降] - TAXDEDUCT()) * [貨物稅完稅價格計算率]', 'IF([月銷量] > 100, 1, 2)', '[a] * ([b] + [c])']
  .forEach(f => assert(fxRound(f) === null, '拆不成一行一項的公式應改用自由公式：' + f));
const chipsRound = f => api('fxToksToText_')(api('fxTokenize_')(f));
['ROUND(P5 * [營業稅率] / (1 + [營業稅率]))', 'IF([月銷量] >= 100, -1, 2)', '(P8 - [水平配件調降] - TAXDEDUCT()) * 91%']
  .forEach(f => assert(chipsRound(f) === f, `膠囊來回轉換應該不變：${f} → ${chipsRound(f)}`));
assert(api('fxTokenize_')('IF([x] = "a", 1, 0)') === null, '引號字串只能用文字輸入');
// 寫在最前面的固定百分比(15% × …)：數字框放 15、單位選 %，存回去還是 15%(不會變成 15 倍)
api("fxMode = 'rows'; fxTerms = fxTermsFromToks_(fxTokenize_('-[a] + 15% × [b] ÷ 2'))");
const pctRows = api('fxRowsHtml_')();
assert(/class="fx-num" value="15"/.test(pctRows) && /seg-btn active"[^>]*fxSetPct_\(1, -1, true\)/.test(pctRows), '來源是 15% 時數字框是 15、單位選 %');
assert(api('fxNumValue_')('15%') === 0.15 && api('fxNumValue_')('15') === 15, '固定數字的值');
api("fxTerms[1].src.v = '20%'");
assert(api('fxTermsText_(fxTerms)') === '-[a] + 20% * [b] / 2', '改數字後 % 要保留：' + api('fxTermsText_(fxTerms)'));
// 新增中的科目(還沒有代碼)不會把頂層科目全部當成子科目
const saved = api('chartDraft');
api("chartDraft = { LineCode: '', LineName: '', ParentLine: '', CalcType: 'FORMULA', Formula: '' }");
const kidsItem = api('fxSourceSections_()').find(g => g.g === '特殊').items.find(it => it.label === '子科目合計');
assert(kidsItem.value === '' && kidsItem.hint.indexOf('、') === -1, '新增中的科目沒有子科目：' + kidsItem.hint);
ctx.__in.saved = saved; api('chartDraft = __in.saved');
// 瀑布圖工具的差異拆解：兩欄是不同車型、一個還是 K、一個已經換成 Y 時，起點/終點各看自己的淨利科目
ctx.__in.wfCmp = {
  lines: [
    { LineCode: 'A', LineName: '收入', ParentLine: '', Category: '收入', CalcType: 'INPUT', Formula: '' },
    { LineCode: 'B', LineName: '成本', ParentLine: '', Category: '成本', CalcType: 'INPUT', Formula: '' },
    { LineCode: 'K', LineName: '營業淨利', ParentLine: '', Category: '淨利', CalcType: 'FORMULA', Formula: 'A - B' },
    { LineCode: 'Y', LineName: '淨利Y', ParentLine: '', Category: '自訂', CalcType: 'FORMULA', Formula: 'A - B' }
  ],
  columns: [
    { profitCode: 'K', amounts: { A: 100, B: 60, K: 40 }, volume: {}, vehicleTypeLabel: 'DA', scenarioLabel: '現況', isWeighted: true },
    { profitCode: 'Y', amounts: { A: 120, B: 70, Y: 50 }, volume: {}, vehicleTypeLabel: 'DQ', scenarioLabel: '目標', isWeighted: true }
  ]
};
api("wfPrefs.end = 'K'; wfPrefs.basis = 'unit'");
const wfSteps = api('wfBridgeSteps_(__in.wfCmp)');
assert(wfSteps[0].value === 40 && wfSteps[wfSteps.length - 1].value === 50, '起點 40(K)、終點 50(Y)：' + wfSteps.map(x => x.value));
assert(!wfSteps.some(x => /其他（公式交互/.test(x.label)), '收入 +20、成本 −10 剛好解釋 +10，不該有尾差：' + JSON.stringify(wfSteps));
assert(paneHtml.indexOf('個別車系的算法') !== -1, '應該可以設定車系個別公式');
assert(api('toNameForm_')('P8 * [季Margin率] + ROUND(B)') === '[廠價(未稅)] * [季Margin率] + ROUND([銷貨成本合計])', '公式應該用科目名稱顯示，函式名稱不動：' + api('toNameForm_')('P8 * [季Margin率] + ROUND(B)'));
assert(api('toNameForm_')('P2') === 'P2', '科目名稱跟系統變數撞名(強配件售價)時要保留代碼，不然存回去意思會變');
const previewHtml = api('chartPreviewHtml_')();
api("currentScenarioId = ''");
assert(previewHtml.indexOf('3人貨車') !== -1 && previewHtml.indexOf('目前') !== -1, '試算表應列出各車系目前的值');

/* ---- 6b. 開發總投：部門彙總(Excel 樣式)、攤提落點直接選損益科目、從 Excel 貼上的比對 ---- */
gs.saveDevInvestmentGrid(sc.ScenarioID, [
  { RowID: '', Department: '大陸廠', TargetLineCode: 'f4', Amount: 8000, Currency: 'TWD' }
], { '大陸廠': '大陸廠的說明' });
const devSummary = gs.getDevInvestmentSummary(sc.ScenarioID);
assert(devSummary.rows[0].TargetLineCode === 'f4', '存檔後攤提落點應為 f4');
assert(devSummary.deptNotes['大陸廠'] === '大陸廠的說明', '部門說明要存得起來');
assert(!Object.keys(gs.getLineNotes(sc.ScenarioID)).some(k => /^DEPT:/.test(k)), '部門說明不能混進科目說明');
assert((devSummary.targetOptions || []).some(o => o.value === 'f4'), '落點選項應包含 f4');
assert((devSummary.targetOptions || []).every(o => !/^[a-z]\d/.test(o.label)),
  '落點選項的顯示名稱不該以科目代碼開頭');
ctx.__in.devSummary = devSummary;
ctx.setTimeout = () => 0; ctx.clearTimeout = () => { };
api('toast = function () {}');
api('devSummary = __in.devSummary');
api('devRows = __in.devSummary.rows.map(r => Object.assign({}, r))');
api('devNotes = Object.assign({}, __in.devSummary.deptNotes)');
api('drawDevGrid')();
const devGridHtml = elFor_('grid-devinvestment').innerHTML;
assert(api('devGroups_()')[0].cat['費用'].length === 1, 'f4 屬於「費用」大類，應該歸在費用那一格');
assert(/data-c="費用"[^>]*value="8,000"|value="8,000"[^>]*data-c="費用"/.test(devGridHtml), '費用那一格應該可以直接改，顯示 8,000');
assert(devGridHtml.indexOf('大陸廠的說明') !== -1, '說明欄應該顯示部門說明');
assert(devGridHtml.indexOf('新增攤提落點科目') !== -1, '應該有新增攤提科目的入口');
assert(elFor_('toolbar-devinvestment').innerHTML.indexOf('從 Excel 貼上') !== -1, '工具列要有從 Excel 貼上');
assert(api("devDefaultTarget_('費用')") && api("devTargetCategoryOf(devDefaultTarget_('費用'))") === '費用', '費用的預設攤提落點要是費用大類的科目');
assert(api("devDefaultTarget_('模具')") !== api("devDefaultTarget_('費用')"), '各大類的預設落點不同');
// 直接在格子打數字：模具沒有任何一筆 → 新增一筆，攤提落點用模具的預設
api("devSetAmt_('大陸廠', '模具', '12,000')");
const mold = api('devRows').find(r => r.Department === '大陸廠' && api('devCatOf_')(r) === '模具');
assert(mold && mold.Amount === 12000 && mold.TargetLineCode === api("devDefaultTarget_('模具')"), '模具格子打 12,000 應該新增一筆模具：' + JSON.stringify(mold));
// 從 Excel 貼上：表頭同名欄位出現兩次(投資/低減後)、千分位、-、引號包起來的換行說明
const tsv = ['\t\t\t\t\t10.00%', '部門\t模具\t設備\t費用\t總計\t模具\t設備\t費用\t總計\t說明',
  '大陸廠\t12,000\t\t9,000\t21,000\t\t\t9,000\t9,000\t"第一行\n第二行"',
  '新部門A\t\t5,000\t-\t5,000\t\t4,500\t-\t4,500\t新的'].join('\n');
elFor_('dev-paste-text').value = tsv; elFor_('dev-o-unit').value = '1'; elFor_('dev-o-missing').value = 'keep'; elFor_('dev-o-multi').value = 'skip';
// 這個情境是現況：低減後那一組不匯入
const plan = api('devPlanPaste_()');
assert(!plan.error, '應該解析得出來：' + plan.error);
const kinds = k => plan.items.filter(i => i.kind === k).map(i => i.dept + '/' + i.what);
assert(kinds('chg').indexOf('大陸廠/費用') !== -1, '大陸廠費用 8,000 → 9,000 要列在「會更新」：' + JSON.stringify(plan.items));
assert(kinds('new').indexOf('新部門A/設備') !== -1, '新部門A 的設備要列在「會新增」');
assert(kinds('note').indexOf('大陸廠/說明') !== -1 && plan.items.find(i => i.what === '說明').why.indexOf('第二行') !== -1, '引號包起來的多行說明要整段讀進來');
assert(kinds('same').indexOf('大陸廠/模具') !== -1, '模具 12,000 沒變');
api('devApplyPaste_()');
const g2 = api('devGroups_()');
assert(g2.find(g => g.name === '新部門A').sum(['設備']) === 5000 && g2.find(g => g.name === '大陸廠').sum(['費用']) === 9000, '套用後金額要對');
assert(api('devNotes')['大陸廠'] === '第一行\n第二行', '套用後說明要更新');
// 總計對不上要提醒、單位千元要乘上去
elFor_('dev-paste-text').value = '部門\t模具\t設備\t費用\t總計\n大陸廠\t12\t\t9\t22'; elFor_('dev-o-unit').value = '1000';
const plan2 = api('devPlanPaste_()');
assert(plan2.items.some(i => i.kind === 'todo' && i.what === '總計'), '總計對不上要列在「要你看一下」');
assert(plan2.items.filter(i => i.dept === '大陸廠' && (i.what === '模具' || i.what === '費用')).every(i => i.kind === 'same'), '單位千元：12 → 12,000 跟目前一樣');
elFor_('dev-paste-text').value = '';

/* ---- 7. CSV 匯出欄數 ---- */
ctx.__in.comparison = comparison;
api('lastComparison = __in.comparison');
api("pctBase = 'exfactory'");
api('showPriceStructure = true');
let csvHtml = '';
ctx.document.getElementById = () => ({
  style: {}, set innerHTML(v) { csvHtml = v; }, get innerHTML() { return csvHtml; },
  querySelector: () => ({ select: () => { } })
});
api('showComparisonCsv')();
// CSV 內容是用 esc() 轉義後才塞進 textarea 的（科目名稱可能含 & < >），比對前要還原
const csvBody = csvHtml.split('<textarea class="csv-box">')[1].split('</textarea>')[0]
  .replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const csvRows = csvBody.split('\n');
const headerCells = csvRows[0].split('","').length;
assert(headerCells === 2 + cols.length * 2, `CSV 標題列應有 ${2 + cols.length * 2} 欄，實際 ${headerCells}`);
csvRows.forEach((r, i) => {
  const n = r.split('","').length;
  assert(n === headerCells, `CSV 第 ${i + 1} 列有 ${n} 欄，應為 ${headerCells}`);
});

/* ---- 8. 圖表 SVG：科目比較 / 依欄位 / 損益結構，瀑布圖工具 ---- */
api("pctBase = 'exfactory'"); api('amountUnit = 1'); api("volumeBasis = 'unit'"); api("chartValue = 'amount'"); api('chartLabels = true');
const countRects = svg => (svg.match(/<rect class="bar"/g) || []).length;
api("chartType = 'byLine'"); api("chartLineCodes = ['A', 'K']");
const byLine = api('chartAreaHtml_')(cols, lines);
assert(countRects(byLine) === 2 * cols.length, `科目比較圖應有 科目數×欄位數 = ${2 * cols.length} 根長條，實際 ${countRects(byLine)}`);
assert(byLine.indexOf('data-tip="') !== -1, '每根長條都要有 hover 提示');
assert(byLine.indexOf('NaN') === -1 && byLine.indexOf('undefined') === -1, '圖表不該出現 NaN/undefined');
assert(byLine.indexOf('class="chart-legend"') !== -1, '圖表要有圖例');
assert(byLine.indexOf('<line') !== -1 && byLine.indexOf('stroke="#718096"') !== -1, '圖表要有 0 基準線');
assert((byLine.match(/class="bar-label"/g) || []).length > 0, '數值標籤開啟時要畫出數字');
api('chartLabels = false');
assert((api('chartAreaHtml_')(cols, lines).match(/class="bar-label"/g) || []).length === 0, '關掉數值標籤就不該有數字');
api('chartLabels = true');
api("chartType = 'byColumn'");
const byCol = api('chartAreaHtml_')(cols, lines);
assert(countRects(byCol) === 2 * cols.length, '依欄位圖的長條數應相同');
assert(byCol.indexOf('3人貨車') !== -1, '依欄位圖的橫軸應該是比較欄位(顯示車系名稱)');
api("chartType = 'structure'");
const structure = api('chartAreaHtml_')(cols, lines);
assert(countRects(structure) === 6 * cols.length, `損益結構圖每欄應有 6 段(銷貨成本/銷售費用/產品貢獻前費用/固定營業費用/前瞻費用/營業淨利)，實際 ${countRects(structure)}`);
assert((structure.match(/class="marker"/g) || []).length === cols.length, '損益結構圖每欄要有一條收入虛線');
// 堆疊各段加起來要等於收入(K 為負時往下堆)：第一欄的段 = B、C-E、E-G、G-I、J、K
const c0 = cols[0].amounts;
const segSum = c0.B + (c0.C - c0.E) + (c0.E - c0.G) + (c0.G - c0.I) + c0.J + c0.K;
assert(Math.abs(segSum - c0.A) < 1, `結構圖各段加總 ${segSum} 應等於收入 ${c0.A}`);
// 儀表板不再自己畫瀑布圖/差異圖(統一用瀑布圖工具)：圖表類型只剩三種，子頁籤沒有「差異比較」
const subnavNoDiff = api('dashSubNavHtml')(cols);
assert(subnavNoDiff.indexOf('差異比較') === -1 && subnavNoDiff.indexOf('dashOpenWaterfall_()') !== -1, '子頁籤沒有「差異比較」，改成「瀑布圖…」帶到瀑布圖工具');
// 瀑布圖工具的單一欄位損益：從收入一路扣到營業淨利，最後一根 = 營業淨利
const structSteps = api('wfStructureSteps_')({ columns: [cols[0]], lines });
assert(structSteps.length > 3 && Math.abs(structSteps[structSteps.length - 1].value - cols[0].amounts.K) < 1, '瀑布圖工具的單一欄位損益最後一根應該是營業淨利');
// 純 SVG 產生器本身：負值往下、零值也要留一根細條可 hover
const svg = api('svgBarChart_')({ groups: [{ label: 'a' }, { label: 'b' }], series: [{ name: 's' }],
  bars: [{ g: 0, s: 0, y0: 0, y1: -5, tip: 'neg' }, { g: 1, s: 0, y0: 0, y1: 0, tip: 'zero' }], valueFormat: v => String(v) });
assert(countRects(svg) === 2 && svg.indexOf('data-tip="zero"') !== -1, '零值長條也要可以 hover');
assert(svg.indexOf('opacity=".45"') !== -1, '零值長條要用淡色細條標示');
assert(api('wrapLabel_')('DA GATE F 901 / 加權平均', 120, 11, 3).length === 2, '橫軸標籤應依「 / 」拆行');
assert(api('wrapLabel_')('產品貢獻前費用', 45, 11, 2).length === 2, '太長的單段標籤要照寬度切行而不是直接截斷');
const ticks = api('niceTicks_')(-214924, 1147009, 5);
assert(ticks.lo <= -214924 && ticks.hi >= 1147009 && ticks.ticks.indexOf(0) !== -1, '座標軸刻度要包住範圍且含 0');

/* ---- 9. hover 提示內容、與基準差異、最佳/最差、單位與基礎 ---- */
ctx.__in.comparison = comparison;
api('lastComparison = __in.comparison');
const fakeEl = attrs => ({ getAttribute: k => attrs[k] === undefined ? null : String(attrs[k]) });

// 比較基準預設是「不設定」，不會偷偷選第一欄；沒設定時任何欄位都不該出現 vs 基準
api("baselineKey = ''");
assert(api('baselineCol_')(cols) === null, '沒設定比較基準時 baselineCol_() 應該回傳 null，不該偷偷選第一欄');
assert(api('cellTipText_')(fakeEl({ 'data-c': 1, 'data-l': 'B' })).indexOf('vs 基準') === -1,
  '沒設定比較基準時，格子提示不該出現 vs 基準');
api("pctBase = 'diff'");
assert(api('secondCellHtml')(cols[1].amounts.B, cols[1], lines.find(l => l.LineCode === 'B'), cols, '').indexOf('muted') !== -1,
  '沒設定比較基準時，差異欄應顯示「—」而不是硬選一欄當基準');
assert(api('tableMetaText_')(cols).indexOf('尚未設定比較基準') !== -1, '表格說明文字應提示尚未設定比較基準');
const noBaseKpi = api('kpiStripHtml')(cols, lines);
assert(noBaseKpi.indexOf('class="kpi-vs') === -1,
  '沒設定比較基準時，重點指標卡片不該出現 vs 基準或「比較基準」標記');
api("pctBase = 'exfactory'");

// 設定比較基準之後才驗證正常的 hover/差異行為
api("baselineKey = __in.comparison.columns[0].scenarioId + '|' + __in.comparison.columns[0].vehicleId");
const cellTip = api('cellTipText_')(fakeEl({ 'data-c': 1, 'data-l': 'B' }));
assert(cellTip.indexOf(cols[1].label) === 0, '格子提示第一行應是欄位名稱');
assert(cellTip.indexOf('銷貨成本合計') !== -1 && cellTip.indexOf('對廠價') !== -1 && cellTip.indexOf('對收入') !== -1, '格子提示應含科目、兩種百分比');
assert(cellTip.indexOf('vs 基準') !== -1, '非基準欄位的格子提示應含與基準的差異');
const baseTip = api('cellTipText_')(fakeEl({ 'data-c': 0, 'data-l': 'B' }));
assert(baseTip.indexOf('vs 基準') === -1, '基準欄位自己不該顯示 vs 基準');
const b13Tip = api('cellTipText_')(fakeEl({ 'data-c': 0, 'data-l': 'b13' }));
assert(b13Tip.indexOf('計算過程') !== -1 && b13Tip.indexOf('完稅價格') !== -1, '貨物稅格子提示應附完整計算過程');
const wTip = api('cellTipText_')(fakeEl({ 'data-c': 2, 'data-l': 'b13' }));
assert(wTip.indexOf('加權平均') !== -1 && wTip.indexOf('沒有單一計算過程') !== -1, '加權平均欄的貨物稅要說明為何沒有計算過程');
const colTip = api('colTipText_')(fakeEl({ 'data-c': 0 }));
assert(colTip.indexOf('月銷量 40 台') !== -1 && colTip.indexOf('4,800 台') !== -1, `欄位標題提示應含月銷量與 LC 總台數，實際：${colTip}`);
const wColTip = api('colTipText_')(fakeEl({ 'data-c': 2 }));
assert(wColTip.indexOf('3人貨車 40%') !== -1 && wColTip.indexOf('9人客貨車 60%') !== -1, `加權平均欄的提示應列出各車系構成比，實際：${wColTip}`);
const lineTip = api('lineTipText_')(fakeEl({ 'data-l': 'E' }));
assert(lineTip.indexOf('Σ銷售費用') !== -1 && lineTip.indexOf('越高越好') !== -1, `科目提示應把 Σd 換成看得懂的名稱並標示方向，實際：${lineTip}`);
assert(api('lineTipText_')(fakeEl({ 'data-l': 'b1' })).indexOf('越低越好') !== -1, '成本明細應標示越低越好');

// 與基準差異模式
api("pctBase = 'diff'");
const diffTable = api('plTableHtml')(cols, lines);
assert(diffTable.indexOf('vs 基準') !== -1 && diffTable.indexOf('>基準<') !== -1, '差異模式：基準欄第二小欄顯示「基準」');
const bDelta = Math.round(cols[1].amounts.B - cols[0].amounts.B);
assert(diffTable.indexOf((bDelta > 0 ? '+' : '') + bDelta.toLocaleString('en-US')) !== -1, `差異模式應顯示 B 的差異 ${bDelta}`);
assert(diffTable.indexOf('class="pct delta bad"') !== -1 || diffTable.indexOf('class="pct delta good"') !== -1, '差異應依方向標好壞顏色');
api("pctBase = 'diffpct'");
assert(api('plTableHtml')(cols, lines).indexOf('vs 基準%') !== -1, '差異% 模式的欄名');
api("baselineKey = __in.comparison.columns[1].scenarioId + '|' + __in.comparison.columns[1].vehicleId");
api("pctBase = 'diff'");
const diffTable2 = api('plTableHtml')(cols, lines);
assert(diffTable2.split('>基準<').length === lines.length + 1, '換基準欄後，「基準」字樣應出現在第二欄的每一列');
api("baselineKey = ''"); api("pctBase = 'exfactory'");

// 最佳/最差：材料成本 b1 越低越好 → V1(400,000) 最佳、V2(500,000) 最差；收入 A 越高越好
api('highlightBest = true');
const bestTable = api('plTableHtml')(cols, lines);
const b1Row = bestTable.split('<tr').filter(r => r.indexOf('data-l="b1"') !== -1)[0];
assert(b1Row.indexOf('class="amt best" data-c="0"') !== -1, '材料成本最低的車系應標最佳');
assert(b1Row.indexOf('class="amt worst" data-c="1"') !== -1, '材料成本最高的車系應標最差');
const aRow = bestTable.split('<tr').filter(r => r.indexOf('data-l="A"') !== -1)[0];
assert(aRow.indexOf('best" data-c="1"') !== -1, '收入最高的車系應標最佳');
api('highlightBest = false');

// 單位與基礎：千元 = 元 ÷ 1000；年度總額 = 單台 × 月銷量 × 12
api('amountUnit = 1000');
assert(api('amountCellHtml')(882180, cols[0], '', '').indexOf('>882<') !== -1, '千元模式應顯示 882');
api('amountUnit = 1'); api("volumeBasis = 'year'");
assert(api('displayAmount_')(1000, cols[0]) === 1000 * 40 * 12, '年度總額 = 單台 × 月銷量 × 12');
api("volumeBasis = 'lc'");
assert(api('displayAmount_')(1000, cols[0]) === 1000 * 4800, 'LC 總額 = 單台 × LC 總台數');
assert(api('displayAmount_')(1000, cols[2]) === 1000 * (4800 + 7200), '加權平均欄的 LC 總台數 = 各車系加總');
api("volumeBasis = 'unit'");
// 百分比不受單位/基礎影響
api('amountUnit = 1000'); api("volumeBasis = 'lc'");
assert(api('pctCellHtml')(cols[0].amounts.B, cols[0]) === pctEx, '切換單位/基礎後百分比不變');
api('amountUnit = 1'); api("volumeBasis = 'unit'");

// 重點指標卡片(要有比較基準才看得到 vs 基準)
api("baselineKey = __in.comparison.columns[0].scenarioId + '|' + __in.comparison.columns[0].vehicleId");
const kpi = api('kpiStripHtml')(cols, lines);
assert((kpi.match(/class="kpi-card/g) || []).length === cols.length, '每個欄位一張重點指標卡片');
assert(kpi.indexOf('比較基準') !== -1 && kpi.indexOf('vs 基準') !== -1, '卡片應標示基準與 vs 基準差異');
api("baselineKey = ''");

/* ---- 10. 只算新增欄位：合併與排序不打後端 ---- */
const partial = gs.calculateComparison([{ ScenarioID: sc.ScenarioID, VehicleID: 'V2' }]);
const merged = api('mergeComparison_')({ columns: [comparison.columns[0]], lines: comparison.lines.slice(0, 5) }, partial);
assert(merged.columns.length === 2 && merged.columns[1].vehicleId === 'V2', '合併後應多出新欄位');
assert(merged.lines.length === comparison.lines.length, '合併後科目應為聯集');
assert(merged.lines.every((l, i) => i === 0 || l.SortOrder >= merged.lines[i - 1].SortOrder), '合併後科目應照 SortOrder 排序');
const reordered = api('reorderComparison_')(comparison, [
  { ScenarioID: sc.ScenarioID, VehicleID: '' }, { ScenarioID: sc.ScenarioID, VehicleID: 'V1' }
]);
assert(reordered.columns.length === 2 && reordered.columns[0].isWeighted && reordered.columns[1].vehicleId === 'V1', '依選擇順序重排並移除未選的欄位');
assert(api('mergeComparison_')(null, partial) === partial, '沒有既有結果時直接用新結果');

/* ---- 11. 瀏覽器端記住設定：存/讀要對稱，壞掉的資料要被忽略 ---- */
let stored = null;
ctx.localStorage = { setItem: (k, v) => { stored = v; }, getItem: () => stored };
api("pctBase = 'revenue'"); api("chartType = 'structure'"); api('amountUnit = 1000'); api("dashView = 'chart'");
api('saveDashPrefs_')();
api("pctBase = 'exfactory'"); api("chartType = 'byLine'"); api('amountUnit = 1'); api("dashView = 'table'");
api('loadDashPrefs_')();
assert(api('pctBase') === 'revenue' && api('chartType') === 'structure' && api('amountUnit') === 1000 && api('dashView') === 'chart',
  '重新載入後顯示設定(含目前的子頁籤)應該還原');
api("dashView = 'table'");
// 已經拿掉的「損益瀑布」「差異比較」：記住的是它們就回到預設
stored = '{"chartType":"waterfall","dashView":"diff"}';
api("chartType = 'byLine'"); api("dashView = 'table'");   // 開頁時的預設值
api('loadDashPrefs_')();
assert(api('chartType') === 'byLine' && api('dashView') === 'table', '舊設定的損益瀑布/差異比較應該回到科目比較/損益表');
stored = '{"pctBase":"bogus","amountUnit":7,"chartType":"nope","dashView":"nope"}';
api("pctBase = 'exfactory'"); api('amountUnit = 1'); api("chartType = 'byLine'"); api("dashView = 'table'");
api('loadDashPrefs_')();
assert(api('pctBase') === 'exfactory' && api('amountUnit') === 1 && api('chartType') === 'byLine' && api('dashView') === 'table',
  '不合法的設定值(含 dashView)應被忽略');
stored = 'not json';
api('loadDashPrefs_')();   // 不該丟例外
api("pctBase = 'exfactory'"); api("chartType = 'byLine'"); api('amountUnit = 1');

/* ---- 12. 比較基準：點兩次同一顆星星要能取消，signed_() 差異數字四捨五入不能蓋掉真的有差異 ---- */
api("baselineKey = ''");
api(`setBaselineColumn(${JSON.stringify(colKeyOf_(cols[0]))})`);
assert(api('baselineKey') === colKeyOf_(cols[0]), '點星星應該設定比較基準');
api(`setBaselineColumn(${JSON.stringify(colKeyOf_(cols[0]))})`);
assert(api('baselineKey') === '', '再點一次目前的比較基準應該取消設定');
api("baselineKey = ''");

assert(api('signed_')(0) === '0', '差異為 0 就顯示 0，不加正負號');
assert(api('signed_')(1234) === '+1,234', '正數差異要有 + 號');
assert(api('signed_')(-1234) === '-1,234', '負數差異要有 - 號');
// 千元單位下差 400 元 = 0.4 千元，四捨五入到 0 位小數會變成「+0」，看起來像沒有差異；
// signed_() 應該自動多留小數，讓使用者看得出真的有差異
assert(api('signed_')(0.4) === '+0.4', `差異被四捨五入蓋掉時應該自動加小數，實際：${api('signed_')(0.4)}`);
// 從 Excel/中文輸入法貼上的全形數字
[['９９９', 999], ['１,０００', 1000], ['（１,２３４）', -1234], ['－５', -5], ['３．５％', 3.5], ['1,234', 1234], ['N/A', null]].forEach(([raw, want]) =>
  assert(api('parsePastedNumber_')(raw) === want, `貼上「${raw}」應該是 ${want}，實際：${api('parsePastedNumber_')(raw)}`));
assert(api('pct1_')(-0.04) === '0.0', `-0.04% 不該顯示成 -0.0：${api('pct1_')(-0.04)}`);
assert(api('signed_')(-0.04) === '-0.04', `更小的差異要再多一位小數，實際：${api('signed_')(-0.04)}`);
assert(api('signed_')(1234.4, 0) === '+1,234', '差異夠大時仍照原本的整數顯示，不必多留小數');

/* ---- 13. 比較欄位改用表格式編輯：新增列、編輯既有列、拖曳/上下移動、重複偵測 ---- */
ctx.__in.comparisonOptions = gs.getComparisonOptions();
api('comparisonOptions = __in.comparisonOptions');
api('comparisonSelections = [{ ScenarioID: __in.comparison.columns[0].scenarioId, VehicleID: "V1" }, ' +
  '{ ScenarioID: __in.comparison.columns[0].scenarioId, VehicleID: "V2" }]');
api('builderDraft_ = { vehicleTypeId: "", scenarioId: "", vehicleId: "" }');
const builderHtml = api('comparisonBuilderHtml_')();
assert((builderHtml.match(/class="drag-handle"/g) || []).length === 2, '已加入的比較欄位每一列都應該有拖曳把手');
assert(builderHtml.indexOf('builder-new-row') !== -1, '最後應該有一列新增列');
assert(builderHtml.indexOf('onchange="onBuilderRowTypeChange_') !== -1 &&
  builderHtml.indexOf('onchange="onBuilderRowScenarioChange_') !== -1 &&
  builderHtml.indexOf('onchange="onBuilderRowVehicleChange_') !== -1,
  '每一列的車型/情境/車系都應該是可以直接改的下拉選單');
assert(builderHtml.indexOf('id="cmp-vehicletype"') === -1 && builderHtml.indexOf('cmp-chip') === -1,
  '不該再用舊的挑選器下拉選單或卡片列表');

// 編輯既有列：改成另一欄已經存在的組合要擋下來，不能改成跟別欄重複
api('onBuilderRowVehicleChange_(0, "V2")');
assert(api('comparisonSelections')[0].VehicleID === 'V1', '改成跟別欄重複時應該擋下來，維持原本的值');
// 改成沒人用過的組合要成功
api('onBuilderRowVehicleChange_(0, "")');
assert(api('comparisonSelections')[0].VehicleID === '', '改成沒有人用過的組合應該套用成功');

/* ---- 14. 開發總投攤提落點：使用者自訂的科目沒人用時不出現在損益表、也刪得掉；有人用時不能刪除 ---- */
const orphanCode = gs.addDevAmortLineItem('費用', '測試攤提落點(沒人用)').LineCode;
let freshLines = gs.calculateComparison([{ ScenarioID: sc.ScenarioID, VehicleID: 'V1' }]).lines;
assert(!freshLines.some(l => l.LineCode === orphanCode), '還沒有任何開發總投列指到這裡，就不該出現在損益表');
gs.deletePLLineItem(orphanCode);   // 不該丟例外
assert(!gs.getPLLineItems().some(l => l.LineCode === orphanCode), '沒人用的自訂攤提落點應該可以直接刪除');

const usedCode = gs.addDevAmortLineItem('費用', '測試攤提落點(有人用)').LineCode;
const devRow = gs.saveDevInvestmentRow({
  RowID: '', ScenarioID: sc.ScenarioID, Department: '測試部門', Amount: 12000, Currency: 'TWD', TargetLineCode: usedCode
});
freshLines = gs.calculateComparison([{ ScenarioID: sc.ScenarioID, VehicleID: 'V1' }]).lines;
assert(freshLines.some(l => l.LineCode === usedCode), '這個情境的開發總投有列指到這裡，就應該出現在損益表');
let deleteThrew = false;
try { gs.deletePLLineItem(usedCode); } catch (e) {
  deleteThrew = true;
  assert(e.message.indexOf('開發總投') !== -1, `錯誤訊息應該指向開發總投，實際：${e.message}`);
}
assert(deleteThrew, '還有開發總投列指到這個科目時，不該讓刪除成功');
gs.deleteDevInvestmentRow(devRow.RowID);
gs.deletePLLineItem(usedCode);   // 移除引用後應該可以刪除，不該丟例外
assert(!gs.getPLLineItems().some(l => l.LineCode === usedCode), '移除引用後應該可以刪除');

/* ---- 15. 這次 code review 抓到的問題：不要再犯 ---- */
// 車系代號含單引號時，星星按鈕不能把它直接寫進 onclick 的 JS 字串裡(HTML 實體會先被解碼，esc() 擋不住)
gs.saveVehicle({ VehicleID: "Q'1", VehicleTypeID: 'DA', VehicleCode: "Driver's Van" });
gs.saveSalesMixGrid(sc.ScenarioID, 'DA', [
  { RowID: '', VehicleID: 'V1', SalesMixPct: 40, MonthlyVolume: 40, LifeCycleYears: 10, ListPriceTaxIncl: 1000000, MandatoryAccessoryPrice: 10574, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' },
  { RowID: '', VehicleID: 'V2', SalesMixPct: 40, MonthlyVolume: 40, LifeCycleYears: 10, ListPriceTaxIncl: 1200000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' },
  { RowID: '', VehicleID: "Q'1", SalesMixPct: 20, MonthlyVolume: 20, LifeCycleYears: 10, ListPriceTaxIncl: 1100000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }
]);
const quoted = gs.calculateComparison([{ ScenarioID: sc.ScenarioID, VehicleID: "Q'1" }]);
ctx.__in.quoted = quoted;
api('lastComparison = __in.quoted');
const quotedTable = api('plTableHtml')(quoted.columns, quoted.lines);
const quotedKpi = api('kpiStripHtml')(quoted.columns, quoted.lines);
[['損益表', quotedTable], ['重點指標卡片', quotedKpi]].forEach(([what, html]) => {
  assert(html.indexOf("setBaselineColumn('") === -1, `${what}：星星按鈕不該把欄位鍵值直接寫進 onclick 的字串`);
  assert(/onclick="setBaselineColumnAt\(\d+\)"/.test(html), `${what}：星星按鈕應該改用欄位索引`);
});
// 索引真的能對回正確的欄位
api('lastComparison = __in.comparison');
api("baselineKey = ''");
api('setBaselineColumnAt(1)');
assert(api('baselineKey') === colKeyOf_(cols[1]), '用索引設定比較基準應該對到第 2 欄');
api('setBaselineColumnAt(99)');   // 超出範圍不該爆掉，也不該亂改
assert(api('baselineKey') === colKeyOf_(cols[1]), '索引超出範圍時不該改動比較基準');
api("baselineKey = ''");

// 基準欄的台數是 0 時，年度/LC 總額的 vs 基準百分比不可以變成 ∞%
ctx.__in.zeroVol = {
  columns: [
    Object.assign({}, cols[0], { volume: { monthlyVolume: 0, units: 0, mix: [] } }),
    Object.assign({}, cols[1], { volume: { monthlyVolume: 100, units: 12000, mix: [] } })
  ],
  lines: lines
};
api('lastComparison = __in.zeroVol');
api("baselineKey = __in.zeroVol.columns[0].scenarioId + '|' + __in.zeroVol.columns[0].vehicleId");
api("volumeBasis = 'year'");
const zeroVolKpi = api('kpiStripHtml')(api('lastComparison').columns, lines);
assert(zeroVolKpi.indexOf('Infinity') === -1 && zeroVolKpi.indexOf('∞') === -1 && zeroVolKpi.indexOf('NaN') === -1,
  '基準欄台數為 0 時，vs 基準的百分比不該印出 Infinity/NaN');
api("volumeBasis = 'unit'"); api("baselineKey = ''"); api('lastComparison = __in.comparison');

// 瀑布圖工具：扣除項本身是負數時(負的前瞻費用)等於加回來，標正號、不該印出 −-5,000
const negCol = Object.assign({}, cols[0], { amounts: Object.assign({}, cols[0].amounts, { J: -5000 }) });
const negSteps = api('wfStructureSteps_')({ columns: [negCol], lines });
const negJ = negSteps.find(st => st.kind === 'delta' && /前瞻/.test(st.label));
assert(negJ && Math.abs(negJ.value - 5000) < 1, '負的扣除項在瀑布圖工具應該是 +5,000：' + JSON.stringify(negJ));
const negSvg = api('wfSvg_')(negSteps, { labels: true });
assert(negSvg.indexOf('−-') === -1 && negSvg.indexOf('−−') === -1, '扣除項是負數時，瀑布圖不該印出兩個負號');

// 計算失敗/計算中只換內容區，不可以把子頁籤列(含「重新計算」)一起洗掉
const subnav = api('dashSubNavHtml')(cols);
assert(subnav.indexOf('id="dash-status"') !== -1 && subnav.indexOf('refreshDashboard(true)') !== -1,
  '子頁籤列應該含狀態文字與「重新計算」按鈕');
let dashHtml = '';
ctx.document.getElementById = id => (id === 'dash-view' ? null : {
  style: {}, set innerHTML(v) { dashHtml = v; }, get innerHTML() { return dashHtml; },
  querySelector: () => noopEl, querySelectorAll: () => [], addEventListener: () => { }
});
api('setDashViewHtml_')('<p class="status-msg err">計算失敗：測試</p>');
assert(dashHtml.indexOf('dash-subnav') !== -1 && dashHtml.indexOf('id="dash-view"') !== -1,
  '外框還沒畫過時，setDashViewHtml_ 應該連子頁籤列一起補畫，而不是只留下錯誤訊息');
assert(dashHtml.indexOf('計算失敗：測試') !== -1, '錯誤訊息應該出現在內容區');
ctx.document.getElementById = id => elFor_(id);

// 加權平均欄換算總額時，構成比與台數比例不一致要主動提醒
assert(api('weightedTotalCaveat_')({ isWeighted: false, volume: { mix: [] } }) === '', '單一車系欄位不需要這個提醒');
assert(api('weightedTotalCaveat_')({
  isWeighted: true, volume: { mix: [{ pct: 50, monthlyVolume: 50 }, { pct: 50, monthlyVolume: 50 }] }
}) === '', '構成比與台數比例一致時不該多嘴');
assert(api('weightedTotalCaveat_')({
  isWeighted: true, volume: { mix: [{ pct: 80, monthlyVolume: 20 }, { pct: 20, monthlyVolume: 80 }] }
}).indexOf('⚠') === 0, '構成比與台數比例差很多時應該提醒總額兜不攏');

// 差距拆解：合併科目、最多幾根、小於門檻併入「其他」；不管怎麼合併，長條加總都要等於原本的差距
{
  const contribs = [
    { code: 'b1', label: '材料LP', value: -22000 }, { code: 'b2', label: '材料KD', value: -11000 },
    { code: 'b13', label: '貨物稅', value: -3784 }, { code: 'x1', label: '關稅', value: -1240 },
    { code: 'x2', label: '技酬金', value: -780 }, { code: 'x3', label: '索賠', value: -152 }, { code: 'd1', label: '廣宣', value: 500 }
  ];
  const total = contribs.reduce((a, c) => a + c.value, 0);
  const sum = bars => bars.reduce((a, b) => a + b.value, 0);
  const bridgeBars = api('bridgeBars_');
  const plain = bridgeBars(contribs, { topN: 10, minAbs: 0, groups: {} });
  assert(plain.length === 7 && Math.abs(sum(plain) - total) < 1e-6, '沒有設定時每個科目一根：' + plain.length);
  const grouped = bridgeBars(contribs, { topN: 10, minAbs: 0, groups: { x1: '其他成本', x2: '其他成本', x3: ' 其他成本 ', b1: '材料', b2: '材料' } });
  const names = grouped.map(b => b.label);
  assert(names.length === 4 && names[0] === '材料' && names.indexOf('其他成本') !== -1, '同名的科目要合成一根，依影響大小排序：' + names.join(','));
  assert(Math.abs(grouped[0].value - -33000) < 1e-6 && /材料LP/.test(grouped[0].tip) && /材料KD/.test(grouped[0].tip), '合併的長條數字是加總，hover 要列出組成科目');
  assert(Math.abs(sum(grouped) - total) < 1e-6, '合併後長條加總要等於原本的差距');
  const capped = bridgeBars(contribs, { topN: 2, minAbs: 0, groups: {} });
  assert(capped.length === 3 && capped[2].label === '其他 5 個科目' && Math.abs(sum(capped) - total) < 1e-6, '超過根數的併成「其他 N 個科目」：' + capped.map(b => b.label).join(','));
  const small = bridgeBars(contribs, { topN: 0, minAbs: 1000, groups: {} });
  assert(small.length === 5 && small[4].label === '其他 3 個科目' && Math.abs(sum(small) - total) < 1e-6, '影響小於門檻的併入「其他」、0 根 = 不限：' + small.map(b => b.label).join(','));
}

// 敏感度：變動 % 與自訂值兩種方式
{
  api('whatIfPrefs').sens = Object.assign(api('whatIfPrefs').sens, { rowMode: 'pct', rowSteps: '-10, 10', colMode: 'value', colValues: '4.5, 4.6 4.6;5,abc' });
  const rows = api('sensAxis_')('row', 200);
  assert(JSON.stringify(rows.map(r => Math.round(r.value * 1e6) / 1e6)) === JSON.stringify([180, 200, 220]) && rows[1].isBase && rows[1].label === '目前', '變動 % 要自動帶入 0% 並依基準換算：' + JSON.stringify(rows));
  const cols = api('sensAxis_')('col', 4.77);
  assert(JSON.stringify(cols.map(c => c.value)) === JSON.stringify([4.5, 4.6, 4.77, 5]), '自訂值要去重、排序、自動加入目前值：' + JSON.stringify(cols.map(c => c.value)));
  assert(cols[2].isBase && cols[2].label === '目前' && cols[0].label === '4.5' && /^-5\.7%$/.test(cols[0].sub), '自訂值的標題是值、副標是跟目前差幾 %：' + JSON.stringify(cols[0]));
  api('whatIfPrefs').sens.colValues = '4.7701, 4.9';
  assert(api('sensAxis_')('col', 4.77).length === 2, '跟目前值幾乎一樣的自訂值視為目前值，不要重複出現');
  api('whatIfPrefs').sens.rowSteps = '-20,-10,0,10,20';
  assert(api('sensPrefill_')('row', 445556) === '356000, 401000, 446000, 490000, 535000' && api('sensPrefill_')('row', 4.77) === '3.82, 4.29, 4.77, 5.25, 5.72',
    '切換成自訂值時依目前值的量級預填：' + api('sensPrefill_')('row', 445556) + ' / ' + api('sensPrefill_')('row', 4.77));
  const html = api('sensitivityTableHtml_')({ cells: [[1, -2], [3, 4]], rowLabel: 'R', colLabel: 'C', rowUnit: '台', rowValues: [], colValues: [] },
    [{ label: '目前', sub: '1', isBase: true }, { label: '+10%', sub: '2', isBase: false }],
    [{ label: '4.50', sub: '-5.7%', isBase: false }, { label: '目前', sub: '4.77', isBase: true }], { metric: 'K', basis: 'unit' }, { metrics: [] });
  assert((html.match(/sens-base/g) || []).length === 1 && /<td class="sens-base negative"[^>]*>-2</.test(html), '框起來的是兩軸都是目前值的那一格');
}

if (failures.length) {
  console.log(`前端驗證失敗：${failures.length} 項`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('前端驗證通過：損益表結構、% 基準/差異模式、hover 提示內容、SVG 圖表、最佳/最差標示、單位換算、欄位合併、設定記憶、主檔表格鎖定與 CSV 欄數皆正確。');
console.log('');
console.log('損益表前 12 列的產出片段：');
console.log(tableExFactory.split('<tr').slice(0, 13).join('<tr').replace(/\n\s+/g, ' '));
