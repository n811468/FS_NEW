# 系統架構 — 地端版（單一 HTML 檔 + 資料包）

資料結構定義見 `docs/data-schema.md`，使用說明見 `docs/usage.md` 與 `local/README.md`。
本文件說明前端輸入 → 資料寫入 → 前端呈現的完整流程與專案檔案配置。

---

## 1. 整體資料流

```
使用者操作前端表單 (src/ui/*.js)
   │  google.script.run.withSuccessHandler(...).saveXxx(...)   ← 介面沿用 Apps Script 的寫法
   ▼
local/host.js：google.script.run 替身，直接呼叫同一頁裡的後端函式(非同步回呼、參數/回傳值走一次 JSON)
   │
   ▼
後端 src/*.gs (DataService.gs / CalcEngine.gs …)，包在 FSBackendFactory(G) 裡執行
   │  驗證欄位 → upsert 寫入對應的「分頁」
   ▼
記憶體試算表 (local/gas-shim.js，每個分頁 = 一張表)
   │  有改到資料(PLResult 計算快照除外) → 整份存進瀏覽器 localStorage
   │                                     → 工具列記「N 次修改尚未匯出」
   ▼
CalcEngine.gs 計算：讀 SalesMix / CostOfSales / DevInvestment / OperatingExpense / Parameters，
   依 PLLineItems 科目鏈逐項 rollup (A→B→C→...→K)
   ▼
Dashboard 頁面渲染損益表 + 結構圖表

資料包 (local/pack.js)：整份或某幾個車型 ⇄ JSON 檔，用於備份、還原與跟同事交換(合併匯入)
```

**關鍵原則：資料庫只存「輸入資料」，不存公式。**
所有損益公式都在 `CalcEngine.gs` 用 JavaScript 運算，計算邏輯集中在一處，方便改公式、加科目、驗算；
`PLResult` 只是計算快照，隨時可以重算，所以不放進暫存也不放進資料包。

為什麼後端寫成 `.gs`、用「分頁」的觀念存資料：這套系統最早是 Google Sheet + Apps Script 的線上版，
地端版沿用同一份後端程式碼，只把 `SpreadsheetApp` 換成記憶體試算表（`local/gas-shim.js`）。
這樣原本用 Gate F 實際數字逐格對過帳的計算引擎完全不用改，`tools/verify-gatef.js` 照樣可以驗。

---

## 2. 專案檔案配置

```
src/                        # 系統本體(後端 + 前端)，build 時原封不動放進 dist/FS-local.html
├─ Constants.gs            # 分頁名稱、SCHEMA、科目表、預設參數
├─ Utils.gs                # ID 產生器、日期正規化、upsert/delete、整批寫入、分頁讀取快取(單次執行內)
├─ FormulaEngine.gs        # v2：公式解析/計算(自己寫的遞迴下降解析器，不用 eval)、引用分析
├─ ChartService.gs         # v2：每個車型各自的科目表、計算來源、公式檢查(循環引用/未計入)、試算、
│                          #     參數定義、科目說明、改善作法、拖曳排序 API、範本複製、資料升級
├─ ReportService.gs        # v2：GATE 報告資料(現況/目標/前回、各車系 + 加權、說明、作法、開發總投 by 部門、損益兩平)
├─ WhatIfService.gs        # v2.1：目標反推(solveGoal)與敏感度表(sensitivityTable)，靠 CalcEngine 的記憶體覆寫重算
├─ SetupSheets.gs          # 建立分頁與科目表；重設科目排序、清除未使用參數等維護作業
├─ DataService.gs          # 各表 CRUD 與表格式整批存檔：getXxxGrid() / saveXxxGrid()
├─ CalcEngine.gs           # 損益計算引擎：依科目表逐科目取值(手動輸入/公式/開發攤提)；比較 API 與小計驗算
├─ index.html              # SPA 外殼（左側導覽 + 各 panel 容器）
├─ style.html              # 共用 CSS(設計系統、列印樣式)
└─ ui/                     # 前端 JS，依頁面拆檔；build/預覽/驗證都由 tools/frontend.js 依檔名順序串成同一段 <script>
   ├─ 00-core.js           #   共用工具、toast、對話框、未儲存提醒、拖曳排序、從 Excel 貼上、頁籤與上方選單
   ├─ 10-masters.js        #   車型 / 車系 / 情境
   ├─ 20-inputs.js         #   銷售構成、銷貨成本/營業費用矩陣(含整張表匯入)、開發總投、參數、匯率
   ├─ 30-chart.js          #   科目與公式
   ├─ 32-formula-builder.js #   科目與公式的公式編輯器（一行一項 / 自由公式膠囊 / 選單）
   ├─ 40-report.js         #   GATE 報告(含作法對帳)
   ├─ 45-whatif.js         #   目標反推與敏感度
   ├─ 50/51/52-*.js        #   損益儀表板(表格、SVG 圖表、hover 提示)
   └─ 99-init.js           #   開頁初始化

local/                      # 地端層：讓 src/ 在瀏覽器裡跑起來 + 資料包
├─ gas-shim.js             # 瀏覽器版 Apps Script 模擬層：記憶體試算表(比照 Sheets 自動偵測格式)、Lock/Cache/Session
├─ pack.js                 # 資料包(JSON)：匯出、讀取檢查、只取部分車型、合併匯入(車型取代 + 自訂科目改號)
├─ host.js                 # 後端主機：.gs 後端 + 瀏覽器暫存 + google.script.run 替身 + 多分頁保護
├─ boot.js                 # 開機：在前端程式執行前架好主機
└─ local-ui.js / local-ui.css  # 地端版工具列(匯出/匯入/合併/提醒備份)

dist/FS-local.html          # 產出物(單一檔案)，提交進 git，使用者直接複製這一個檔案

tools/                      # 開發用，只在本機用 Node 執行
├─ build-local.js          # src/ + local/ + 示範資料 → dist/FS-local.html
├─ frontend.js             # 把 src/ui/*.js 串成一段 <script>(build、本機預覽、verify-ui 共用)
├─ fake-apps-script.js     # Node 版的記憶體試算表(會數 API 呼叫次數)，讓 .gs 能在 Node 驗算
├─ verify-gatef.js         # 用實際 Gate F 表的數字逐格驗算計算引擎
├─ verify-features.js      # 情境帶入、科目自動編號、匯率精簡等行為
├─ verify-ui.js            # 前端純函式的靜態驗證（損益表結構、hover 提示內容、SVG 圖表、差異模式、公式編輯器…）
├─ verify-formula.js       # v2：公式語法、車型各自的科目表、車系個別公式、REF、分攤車系、作法、報告
├─ verify-write-batching.js # 整批寫入(batchWriteRows_)：跨情境隔離、新增/更新/刪除混合、呼叫次數量測
├─ verify-local.js         # 地端版：與 Node 驗算層逐格比對、暫存/資料包/合併、dist 為最新
├─ e2e-local.js            # 用 Chromium 以 file:// 開啟的端對端測試(需要 Playwright)
└─ dev-server.js           # 本機預覽伺服器：改前端時不必每次重新 build，存檔按 F5 就看得到
```

> 前端依頁面拆成 `src/ui/*.js`，但仍是同一段 script(共用全域函式，不是 ES module)，串接順序由檔名前綴決定。

> `.gs` 被整段包進 `FSBackendFactory(G)` 函式裡（`G` 是模擬的 Apps Script 全域物件），
> 後端的全域函式/變數不會跟前端程式的同名函式互相蓋掉。每次前端呼叫都比照
> 「每次都是新的執行」清掉單次執行快取，跟這套程式原本的假設一致。

---

## 3. 後端函式介面（DataService.gs）

```js
// 每張表都提供一致介面，例如 SalesMix：
function getSalesMix(scenarioId)            // 回傳該情境所有列 (array of object)
function saveSalesMixRow(rowObj)            // rowObj.RowID 有值→更新，無值→新增+產生RowID
function deleteSalesMixRow(rowId)

// 其餘比照：getCostOfSales / saveCostOfSalesRow / deleteCostOfSalesRow
//           getDevInvestment / saveDevInvestmentRow / deleteDevInvestmentRow
//           getVehicles / getScenarios / getParameters(scenarioId)

// 寫入時包在 withLock_() 裡(地端版的 LockService 是空殼；原本是線上版防多人同時寫入用的，保留不影響行為)：
function saveSalesMixRow(rowObj) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // 1. 驗證必填欄位
    // 2. 依 RowID 找列號，找不到就 appendRow 並產生新 RowID
    // 3. 寫入 AuditLog
  } finally {
    lock.releaseLock();
  }
}
```

**整批存檔改用整段讀一次、整段寫一次**（`Utils.gs` 的 `batchWriteRows_`）：矩陣式頁面（銷貨成本／
營業費用）一次存檔動輒十幾到上百格，若每一格各自呼叫 `upsertRow_`/`deleteRow_`（各自掃 PK 欄找列號、
讀寫文字格式、寫入、寫稽核），會在同一次執行裡打出對應數量的 Sheets API 呼叫——實測 55 格逐格處理
約 330 次呼叫，改成整批後降到個位數，而且呼叫次數不會隨格數線性成長（見
`tools/verify-write-batching.js`）。做法跟 `CalcEngine.gs` 的 `writePLResult_` 一樣：先把整張表讀一次、
在記憶體裡套用這一批的新增/更新/刪除、`clearContent()` 後一次 `setValues()` 整段寫回；
`AuditLog` 也改成 `logAuditBatch_` 一次寫完整批的稽核紀錄，不是每列各自 `appendRow()`。
全部 `saveXxxGrid` 系列都已經套用（銷貨成本／營業費用矩陣、銷售構成、車型/車系/情境主檔、
開發總投、科目設定、稅務費用比率、匯率設定、`copyScenarioData` 帶入資料、
`restoreBuiltInLineItems` 恢復內建科目），只有兩個地方刻意維持逐列處理：
- `savePLLineItemGrid` 的**新增列**：代碼由 `nextLineCode_()` 依「目前實際存在的科目」逐一分配，
  必須維持「逐列寫入 → 清快取 → 下一列重新讀最新代碼清單」，否則同一批一次新增兩個以上科目
  會撞號。新增列一次通常只有幾筆，逐列處理的成本可以忽略；同一批的**既有列**（改名、搬動）
  不受代碼分配影響，仍然整批處理。
- `syncCodeOwnedLineItems_`（`getBootstrap()` 每次都會呼叫，把程式定義科目的名稱/位置對回程式碼）：
  只有真的對不上時才寫入，穩定狀態下完全不寫、只讀取（有快取），批次化對它沒有效益。

用 `upsertRowMerge_`（只覆蓋表單有送出的欄位，其餘沿用既有值）的頁面——車型主檔、車系設定、
情境設定、科目設定的既有列——批次化時用 `mergeRowForBatch_()` 搭配 `indexByPk_()` 先在記憶體裡
把要合併的來源列建成對照表，效果等價，只是省掉逐列各自重新讀表的次數。

有驗證失敗檢查的頁面（開發總投的「有金額卻沒選攤提落點」）額外多了一個好處：原本逐列寫入時，
驗證失敗前面幾列已經寫進去了、後面的才沒寫，等於「存了一半」；改成整批寫入後驗證仍在寫入前
就擋下來，這一批要嘛全部成功、要嘛完全不寫，不會再有存一半的情況
（`tools/verify-write-batching.js` 的「原子性」測試會驗這一點）。

---

## 4. 計算引擎（CalcEngine.gs + FormulaEngine.gs）

v2 起損益公式鏈不再寫死在程式裡：每個科目的計算來源是**資料**（`PLLineItems.CalcType/Formula`，見 `data-schema.md` 2.7）。

```js
function calculatePLWithDefs_(scenarioId, vehicleId, overrideDefs) {
  // 1. 讀這個情境所屬車型的科目表(或科目設定頁傳來還沒存的版本)、SalesMix、Parameters
  // 2. 系統變數 [建議零售價]、[月銷量]、[LC總台數]、[攤提總台數]… (systemVariables_)
  // 3. 手動輸入金額 = 銷貨成本 + 營業費用 依科目代碼加總(外幣換算)
  // 4. 開發總投攤提 = 全車系分攤(÷ LC 總台數) + 只攤給這個車系的部分(÷ 那些車系的攤提台數)
  // 5. 逐科目遞迴求值(用到誰先算誰)：
  //      INPUT → 手動輸入金額；DEV_AMORT → 攤提金額；FORMULA(或車系個別公式) → evalFormulaAst_
  //      [名稱] 依序找：系統變數 → 參數(% 參數 ÷100) → XXX匯率 → 科目名稱
  //      CHILDREN() = 直接子科目合計；TAXDEDUCT() = CommodityTaxDeduct=Y 的科目合計
  //      REF(情境, 科目[, 車系]) = calculatePLCore_ 另一個情境(循環引用以 REF_STACK_ 擋下)
  //    單一科目公式出錯 → 該科目以 0 計、錯誤放在 errors，不讓整張損益表掛掉；traces 記錄每個公式的引用值給 hover 用
  return { lineValues, errors, traces, lines, revenue, exFactoryPrice };
}
```

標準範本的預設公式跟 v1 寫死的算法逐格相同，`tools/verify-gatef.js` 用實際 Gate F 表驗算 317 格。
科目設定頁存檔前會跑 `chartProblems_()`：語法錯誤、引用不存在的科目/名稱、循環引用(error，擋下存檔)；
沒有被任何小計算進營業淨利的科目(warning)。

`calculatePLAllVehicles` / `calculateComparison` / `getGateReport` 都建在 `calculatePLCore_` 之上，
同一次執行內以「情境|車系」記住結果。比較不同車型時，科目依代碼取聯集(`unionLineDefs_`)。

DevInvestment → 單台攤提：
```
LIFE CYCLE 總台數 = 情境的攤提基準(AmortMonthlyVolume × 12 × AmortLifeCycleYears)，留空用 Σ(月銷量 × 12 × LC年限)
低減後金額 = Amount × 匯率 × (1 - ChallengeReductionPct/100)  (現況情境不低減)
VehicleScope 留白 → ÷ LC 總台數，每個車系都分攤
VehicleScope 有值 → ÷ 這些車系的攤提台數合計，只加在這些車系
攤到哪個科目 = TargetLineCode(計算來源為 DEV_AMORT 的科目)
```

### 假設分析(WhatIfService.gs)

`CALC_OVERRIDES_`(CalcEngine.gs)是一組只存在記憶體的覆寫：月銷量倍數(攤提基準台數跟著變)、售價倍數、科目金額倍數、
開發攤提倍數、參數值、匯率，只套用在指定情境上。`withOverrides_()` 掛上覆寫 → 重算 → 一定拿掉並清掉計算記憶，
存檔資料不受影響(`verify-formula.js` 驗證)。`solveGoal` 先從基準值往兩邊擴大找「結果跨過目標」的區間，再二分法逼近
(公式裡有取整/IF，不假設平滑)；找不到就回報達不到。`sensitivityTable` 最多 11×11 格。

## 5. 前端頁面設計

**v2 共用元件**（`src/ui/00-core.js`）：`toast()` 右上角提示、`openModal()` 對話框(取代 prompt/confirm)、
`markDirty()/clearDirty()` 未儲存提醒(底部浮動儲存列、Ctrl+S、切頁/切車型前確認、關閉視窗前警告)、
`makeSortable()` 拖曳排序(指標事件，滑鼠/觸控都可以；把手取得焦點時 Alt+↑↓ 也能移動；巢狀清單用 `direct`)。
所有原本的 ▲▼/◀▶ 移動鈕都換成拖曳：車系/情境(放開立即 `setVehicleOrder`/`setScenarioOrder`)、
科目樹(`setLineOrder`)、開發總投列、比較欄位、改善作法(跟著頁面儲存)。

v2 新頁面：「科目與公式」(`renderChartPanel`：科目樹 + 編輯器 + 即時試算 `previewLineFormula`)、
「GATE 報告」(`renderReportPanel`：投影片式版面、`@media print` 每張一頁 16:9、複製表格成 TSV)。


所有頁面都是表格式編輯：一次看到全部資料、直接在格子裡改、最後按一次「儲存」整批送出。
沒有「先按編輯才能改某一列」的模式 —— 那會讓一次要調十幾個數字的作業變成點十幾次編輯。

匯入資料包、載入示範資料後都會整頁重新載入（使用者自己按 F5 也是）。為了不讓畫面每次都跳回第一頁，`switchTab()` /
`onVehicleTypeChange()` / `setCurrentScenario()` 都會把「目前在哪一頁、選了哪個車型/情境」存進
`localStorage`（`saveAppState_()`），開場 `DOMContentLoaded` 時讀回來還原（`loadAppState_()`）。
表格編輯頁裡「還沒存檔的修改」本來就無法安全地跨一次整頁重新整理還原，不在這個機制處理範圍內。

- **主檔維護頁**（車型 / 車系 / 情境 / 科目設定）：共用一套可直接編輯的表格元件
  （`renderEntityPanel` / `drawEntityGrid` / `saveEntityGrid`），「新增一列」在表格最後補一列空白列，
  跟其他修改一起送出（`saveVehicleTypeGrid` / `saveVehicleGrid` / `saveScenarioGrid` / `savePLLineItemGrid`）。
  - 主鍵欄位（車型代號、車系代號）建立後就鎖住：主鍵是所有資料的鍵值，改掉等於另開一筆、舊資料會變孤兒。
  - 科目設定的 `LineCode` 由後端自動編號（`nextLineCode_()`：父科目字首 + 最小未使用號碼），
    使用者只選父科目、填名稱；新增列在儲存當下才配號。
  - **自動計算科目與結構科目的名稱由程式擁有**：名稱寫的就是它的公式，畫面上不開放修改，
    且 `getBootstrap()` 每次都會呼叫 `syncCodeOwnedLineItems_()` 把 Sheet 上的舊名稱對回程式碼。
    改版重新編號（售價結構從 8 列變 9 列）之後，舊 Sheet 上會出現欄位名稱與數字對不起來的情形，
    而 `seedPLLineItems_()` 為了保留使用者改過的名稱不會覆蓋既有科目 —— 名稱是描述公式的，
    就該由公式那一邊決定。明細科目的名稱仍屬使用者，要整批回復用 `restoreBuiltInLineItems()`。
  - **沒有「內建」鎖**：`PROTECTED_LINE_CODES`（A/B/C/E/G/I/K）只用來標示「預設小計」與表格樣式，不再擋刪除或換父科目；
    刪除只擋資料完整性（公式引用、子科目、開發總投攤提落點）。預設參數（`TAX_RATE_PARAM_NAMES`）可改單位/預設值/改名/刪除，
    刪除或改名時在 ParamDefs 留一列墓碑（`Unit = DELETED`），`seedParamDefs_` 才不會補回來；`restoreBuiltInLineItems` 會移除墓碑。
  - 車型、車系、情境三個表格放在同一頁「車型與情境」（`renderMastersPanel`）。同一頁有好幾個可以各自編輯的表格時，
    用 `markDirtyPart_(page, part, save, discard)` 記每個表格各自的修改：底部「儲存」/Ctrl+S 逐一存每個改過的表格，
    某個表格自己存好了只清掉它（`clearDirtyPart_`）。「參數與匯率」頁的參數表與匯率表也是這樣。
    舊的分頁代號（vehicletypes / vehicles / scenarios / paramfx / costofsales / operatingexpense）由 `MERGED_TABS_` 導到新頁。
  - 情境另有「以既有情境為基礎建立」（`createScenarioFrom()`）與「帶入目前情境」
    （`copyScenarioData()`），限同一車型 —— 跨車型的車系對不上，會產生看不見卻仍被計入損益的資料。

- **表格編輯頁**（銷售構成 / 成本與費用 / 開發總投 / 參數與匯率）：
  一次看到全部資料、直接在格子裡改、最後按一次「儲存」整批送出，避免逐筆開表單輸入。
  - 銷售構成：依車系自動列出，台數與構成比即時互相連動（`getSalesMixGrid` / `saveSalesMixGrid`）。
  - 銷貨成本 / 營業費用：同一頁「成本與費用」的兩個子頁籤（`renderCostsPanel` / `costsView`，`switchTab('costofsales')` 會切到對應子頁籤）。
    矩陣式（列 = 科目、欄 = 車系），科目可直接在該頁新增/刪除
    （`getCostOfSalesMatrix` / `saveCostOfSalesMatrix`、`addLineItemInline` / `deleteLineItemInline`）。
    最右欄是**加權平均**而非跨車系合計：一列是同一個成本項目在各車系的單台金額，相加沒有意義；
    矩陣 API 會一併回傳各車系的 `SalesMixPct`，前端據此算 Σ(金額×構成比)÷Σ構成比。
  - 開發總投：每一列選「攤提落點」(`DEV_ASSET_TYPES`)，落點直接對應損益科目
    （`DEV_ASSET_TYPE_TARGET`：模具→b5、設備→b8、費用-CMC→f3、費用-BASE廠→f4），
    同一列旁邊就顯示會攤到哪個科目，下方另有各落點的投資總額與單台攤提對照表。
    舊版靠 `Department === 'BASE廠開發費'` 這個字串來分 f3/f4，部門是自由輸入欄位，
    打成別的字就整筆落到 f3、而且畫面上看不出來（f4 永遠是 0）；舊資料仍照原規則判讀後自動轉換。
    目標情境才顯示挑戰低減目標欄位。從其他情境整批帶入資料只在「車型與情境 → 情境」做（`copyScenarioData()`，可勾選類別）。
    使用者自訂的攤提落點（`AutoSource=DEV_AMORT`，跟內建的 b5/b8/f3/f4 不同）沒有任何情境的
    開發總投列指到它時，不會再強制以 0 出現在損益表/矩陣頁面上，也可以直接在「科目設定」刪除
    （`deletePLLineItem` 只擋「還有資料指到這裡」的情況，不像其他自動計算科目一律鎖死）。
  - 稅務費用比率：「全車系適用」一欄 + 各車系覆寫欄，留白自動沿用（`getRateGrid` / `saveRateGrid`）。
  - 匯率（畫在參數頁下半部）：以幣別管理（`getFxGrid` / `saveFxGrid`），設定過匯率的幣別才會出現在銷貨成本的幣別選單。
    只有一種「現況匯率」；舊版的「集團預算匯率」沒有任何計算讀它，已移除。

- **損益儀表板（多車型維度比較）**：
  - **拆成三個子頁籤**（`dashSubNavHtml` / `dashView`），一次只專心看一件事：
    「比較欄位」建構要比的欄位、「損益表」主表格+重點指標+小計驗算、「圖表」三種柱狀圖。
    目前停在哪個子頁籤也記在 `localStorage`，重新整理後還在原地。
    以前的「差異比較」子頁與「損益瀑布」圖跟瀑布圖工具重複，已拿掉：子頁籤列右邊的「瀑布圖…」（`dashOpenWaterfall_`）
    選兩欄就用 `openWaterfallTool_('bridge', …)` 開差異拆解、選同一欄開單一欄位損益；差異數字看損益表的「與基準的差異」。
  - **比較欄位**：每一列是一個比較欄位(車型 × 情境(GATE) × 車系，或該情境的「加權平均」)，
    整張表都是下拉選單（`comparisonBuilderHtml_`），改哪一列就直接換那一欄要比的資料 ——
    跟系統其他頁面「表格式編輯」的慣例一致，不再另外用一組獨立的挑選器 + 卡片列表。
    最後一列固定是「新增」列；改成跟別欄重複的組合會被擋下來並還原。
    可同時加入**不同車型**的欄位並排比較（如 DA GATE F 目標 vs DE GATE F 現況），可用箭頭或拖曳排序。
    加入新欄位只把「還沒算過」的欄位送後端（`calculateComparison(missing)`），算回來後在前端併進手上的結果
    （`mergeComparison_` 取科目聯集、`reorderComparison_` 依選擇順序重排）；調整順序、移除欄位完全不打後端。
    進儀表板與按「重新計算」一律整份重算，避免其他分頁剛改過的資料被舊結果蓋掉。
    比較欄位與所有顯示設定都記在瀏覽器 `localStorage`（`saveDashPrefs_` / `loadDashPrefs_`），
    下次打開不必重新加欄位；已刪掉的情境/車系會被濾掉、不合法的設定值會被忽略。
  - **重點指標卡片**：每個欄位一張，營業淨利 + 淨利率、收入與各段毛利率，以及「vs 基準」的差異(有設定比較基準才顯示)。
  - 損益表（依 `displayOrderDefs_` 的呈現順序：同層照 SortOrder；公式是 `X - CHILDREN()` 的扣減型小計排在明細後面、
    `CHILDREN()` 群組排在明細前面，跟 Excel 一樣；前端合併欄位時用同規則的 `displayOrderLines_`），版面比照實際 Gate F 損益試算表 ——
    每個比較欄位分「金額」與第二小欄，明細科目縮排在它的小計底下，小計/毛利/淨利整列反白，
    售價結構 P1~P9 另成一段（可關掉），B/E/G/I 大項可收合，這樣「哪幾列加起來等於哪一列」在畫面上是看得見的。
  - **第二小欄可切換**：對廠價(未稅) P8 %（預設）、對收入(未稅,含強配) A %、**與基準欄位的差異（金額或 %）**。
    **比較基準不是必要的** —— 預設不設定，`baselineCol_()` 不會偷偷選第一欄；用工具列的「比較基準」
    下拉選單或欄位標題/卡片上的 ★ 指定，再點一次目前的基準會取消。沒設定基準時，差異欄顯示「—」、
    hover 提示與重點指標卡片也不會出現「vs 基準」。差異的紅綠依科目方向決定
    （`lineBetter_`：收入/毛利/淨利越高越好，成本/費用越低越好；售價結構沒有方向）；
    差異數字用 `signed_()` 顯示，四捨五入後會變成「+0」但其實不是 0 時(如千元單位下差幾百元)
    自動多留小數，不會讓使用者以為這個功能沒作用。
  - **金額單位**（元 / 千元 / 萬元，全系統共用一個設定：`loadAmountUnit_` / `saveAmountUnit_`，儀表板、GATE 報告、瀑布圖工具都讀它）與**金額基礎**（單台 / 年度總額 = 單台 × 月銷量 × 12 / LC 總額 = 單台 × LC 總台數）
    一次套到表格、卡片、圖表與 CSV（`displayAmount_`）；百分比不受影響。台數資料由後端 `columnVolumeInfo_()` 隨欄位回傳，
    加權平均欄位的總台數是各車系加總，並附各車系構成比供標題 hover 顯示。
    > 加權平均欄位換算總額時有一個先天限制：單台金額是用**構成比**加權的，總額卻是乘上**台數**總和，
    > 只有兩者比例一致時，這一欄的總額才會等於各車系欄位的總額相加。「銷售構成」頁面在畫面上編輯時
    > 會自動讓構成比與台數同步，所以正常不會差；但手動改過資料包、或帶入後只調了一邊就可能不一致。
    > 這種情況不會默默算錯給使用者看 —— `weightedTotalCaveat_()` 會在欄位標題的 hover 提示裡標出
    > 相差幾個百分點，並說明怎麼調回來。
  - **標示最佳/最差**：每一列把數字最好的欄位標 ▲、最差的標 ▼（同分都標），方向同上。
  - **hover 提示**（`installTooltipEngine_`）：自己畫的 fixed 定位提示，不用原生 `title`
    （原生 title 在有橫向捲動與 sticky 釘住欄位的表格裡會被裁掉）。
    固定文字用 `data-tip`；表格格子/欄位標題/科目名稱/圖表長條用 `data-tipfn` 指定產生器，移過去才算內容：
    格子顯示欄位、科目、金額(單台與總額)、兩種百分比、與基準的差異、貨物稅的完整計算過程；
    欄位標題顯示情境性質、月銷量 × LC 年限 = 總台數、加權平均的組成；科目名稱顯示公式（代碼換成名稱，Σd 換成「Σ銷售費用」）與方向。
    表格格子的提示延遲 180ms 才出現（掃過表格時不會一路閃），捲動/點擊/重畫時一律收掉；
    量尺寸前先把提示挪回左上角，避免上一次停在靠右位置時被視窗邊緣壓扁而算錯位置。
    另有**十字游標**：滑鼠所在的列與欄一起變色（`installTableCrosshair_`）。
  - **小計自動驗算**：`subtotalChecks_()` 把 A=P8+P9、B=Σ成本明細、C=A-B、E=C-Σd、G=E-Σf、
    I=G-Σh、K=I-J 逐條重算（容差 0.5 元，吸收營業稅/佣金的四捨五入），對不起來的才回傳，
    前端在表格上方示警。加總錯誤不必靠肉眼發現。
  - 因為不同車型的科目不見得相同，只列出至少一個欄位真的算出數字的科目；
    某欄位沒有該科目時顯示「—」而非 0。另一方面，**沒填金額的成本科目仍會以 0 列出**
    （`calculatePL()` 先用 `manualLineCodesFor_(['B'])` 把 b 科目補齊），
    否則畫面上少了幾列，看到的明細加起來會對不上 B 銷貨成本合計，看起來就像加總算錯。
    自動計算科目（售價結構 P1~P9、貨物稅、季Margin、開發攤提）以圓點標示，hover 看來源。
  - 「匯出 CSV」把整張比較表（含 % 欄、目前的單位/基礎）複製貼進 Excel，可一鍵複製到剪貼簿。
  - **圖表全部是前端自己產生的 SVG**（`svgBarChart_`：浮動長條 y0→y1 的通用產生器，堆疊/瀑布都靠它），
    不再載入 Google Charts —— 外部載入在公司網路偶爾失敗、整個儀表板的初始化跟著掛掉，
    hover 的長相也跟表格不一致，而且沒辦法在 Node 裡驗證。三種圖：
    **科目比較**（橫軸 = 勾選的科目，同一組裡並排各欄位）、**依欄位**（倒過來）、
    **損益結構**（每欄一根堆疊長條：銷貨成本、各段費用、營業淨利；虛線是收入，淨利為負就落到 0 以下）。
    瀑布圖全系統只有一套（`wfSvg_`，瀑布圖工具、GATE 報告、目標反推共用）。
    數值可切金額或百分比，數值標籤可開關；viewBox 讓圖跟著視窗寬度縮放。
    要畫哪幾個科目用核取方塊勾選（`<select multiple>` 要按住 Ctrl 才選得動，等於選不動）。
  - 後端 API：`getComparisonOptions()` 取得車型→情境/車系選項樹；
    `calculateComparison([{ScenarioID, VehicleID}])` 回傳各欄位金額、兩種百分比基準、台數資訊、
    科目聯集（含 ParentLine 供縮排）與小計驗算結果。同一次執行內 `calculatePLCore_` 以（情境,車系）記住結果，
    同一情境的各車系 + 加權平均一起比較時每個車系只算一次。

---

## 6. 保存、交換與多人協作

- 資料存在使用者自己電腦的瀏覽器（`localStorage`），不上傳任何地方；完全離線可用，不載入任何外部資源。
- 瀏覽器暫存只是「關掉再打開還在」的便利。正式保存與交換一律用資料包：工具列「匯出全部」是備份，
  「匯出車型」或「匯出情境」交給同事「合併匯入」。合併規則（車型資料包以車型為單位取代、情境資料包只取代該情境）見 `local/README.md`。
- 同一份暫存被兩個分頁同時編輯時，後存檔的一方會讓另一方停止寫入並提示重新整理，避免互相覆蓋。

---

## 7. 待確認事項

1. 是否需要「核准/鎖定」機制，避免情境定案後被誤改？
2. 開發總投的部門清單是否固定，或需要讓使用者自行新增部門？（現況：自由輸入，並提供已用過的部門建議）
3. ~~圖表程式庫的資安規範~~ —— 已改成前端自己產生 SVG，不載入任何外部程式庫。
