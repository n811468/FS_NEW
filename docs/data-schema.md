# 車型損益試算系統 — 資料結構草案

依據實務 Gate F 損益試算 Excel（材料成本 / 開發總投 / GATE F 含TNCAP）整理而成。
架構：地端版（`dist/FS-local.html`）在瀏覽器裡用記憶體試算表當資料庫（每個分頁 = 一張表），
`src/*.gs` 作為後端、`src/ui/*.js` 作為前端；資料包（JSON）的每張表就是下面定義的欄位。

---

## 1. 命名慣例

- 每張表第 1 列為欄位標題（英文代碼），資料包裡就是每一列物件的欄位名稱。
- 每張表第 1 欄為 `RowID`（唯一鍵，格式 `表前綴-流水號`，如 `MC-000123`），方便 upsert 與追蹤。
- 所有金額欄位單位為「元」。
- **所有比率欄位一律以百分比數值（0~100）輸入與儲存**：15 代表 15%、0.5 代表 0.5%，不存 0.15。
  適用於 `SalesMixPct`、`ChallengeReductionPct`、以及 `Parameters` 的營業稅率/銷售佣金率/季Margin率/貨物稅率。
  CalcEngine 取用時一律經過 `pct_()` 除以 100。**匯率不是比率**，維持原始數值（如 4.5）。
- 日期欄位一律 `yyyy-mm-dd`。

---

## 2. 分頁（表）設計

### 2.0 `VehicleTypes` 車型主檔（上層）

前端最上層的選單單位。使用者必須先在這裡選擇/建立車型（如 `DA`），
才能在下層 `Vehicles`（車系）新增資料 —— 車系不能脫離車型獨立存在。

| 欄位 | 型別 | 說明 |
|---|---|---|
| VehicleTypeID (PK) | text | 車型代號，如 `DA`、`DE`、`DH`、`DX` |
| Notes | text | 備註 |

### 2.1 `Vehicles` 車系設定（下層，隸屬某個車型）

| 欄位 | 型別 | 說明 |
|---|---|---|
| VehicleID (PK) | text | 如 `DA-3T`、`DA-9C`、`DA-9P` |
| VehicleTypeID (FK) | text | 對應 `VehicleTypes.VehicleTypeID`，如 `DA` |
| VehicleCode | text | 車系名稱：3人貨車 / 9人客貨車(商用) / 9人客貨車(接駁) / 幼童車 / 福祉車 |
| Notes | text | 備註 |

> 不再有 `Status`（現況/開發中/量產）欄位；車型只有「存在/不存在」兩種狀態，
> 不需要的車系直接在「車系設定」頁面刪除即可。

### 2.2 `Scenarios` 情境主檔

損益試算常需要多情境比較（現況 vs 目標 vs 已知低減方向 vs DE基準 vs DH目標），
所有交易表都用 `ScenarioID` 做區隔，同一車型可以有多筆情境版本。
前端導覽以「車型」為第一層選單，「情境」是車型底下的第二層選單，
切換車型後情境選單會重新載入該車型專屬的情境清單。

| 欄位 | 型別 | 說明 |
|---|---|---|
| ScenarioID (PK) | text | 系統自動產生（`SC-xxxxxxxx`），使用者不需自行編碼 |
| Gate | text | GATE 別：`GATE F` / `GATE E` / `GATE D` / `GATE C` / `GATE B` / `GATE A` / `GATE Z` |
| ScenarioName | text | 使用者自訂，如 現況 / 目標 / 已知低減方向 |
| ScenarioType | text | 情境性質：`現況` / `目標`。現況情境沒有挑戰低減目標（計算時一律以原始金額），目標情境才套用低減率，並可從其他情境整批帶入資料 |
| AmortMonthlyVolume / AmortLifeCycleYears | number | 開發總投攤提基準台數（總台數 = 台/月 × 12 × 年）。實務上開發投資的攤提基準常與銷售構成的預估台數不同（Gate F 案例：銷售估 365 台/月，開發投資以 300 台/月 × 12 年 = 43,200 台攤提）。留空則沿用銷售構成推算值 |
| VehicleTypeID (FK) | text | 對應 `VehicleTypes.VehicleTypeID` |
| CreatedBy / CreatedDate | text/date | 建立者、日期 |
| Notes | text | 備註 |

> 情境代號即 GATE 別，**同一個 GATE 底下可以有多個情境**（如「GATE F 現況」「GATE F 目標」），
> 情境名稱自訂。不再有「衍生自(BaseScenarioID)」欄位。

### 2.3 `SalesMix` 銷售構成與售價（車型構成含售價台數）

每列 = 一個「情境 × 車型」的銷售假設。

| 欄位 | 型別 | 說明 |
|---|---|---|
| RowID (PK) | text | |
| ScenarioID (FK) | text | |
| VehicleID (FK) | text | |
| SalesMixPct | number | 銷售構成比%（0~100） |
| MonthlyVolume | number | 預估銷售台數(月) |
| LifeCycleYears | number | LC 年限（如 12） |
| ListPriceTaxIncl | currency | 建議零售價(含稅) |
| MandatoryAccessoryPrice | currency | 強配件售價 |
| ScrapFee | currency | 廢車處理費 |
| ScrapFeeTaxStatus | text | 含稅 / 未稅 —— 標明 `ScrapFee` 是否已含稅，CalcEngine 一律換算成含稅金額後再從零售價扣除，確保全份損益試算稅別口徑一致 |
| HorizontalPartsPriceAdj | currency | 水平配件外移調降廠價，計算貨物稅完稅價格時扣除；沒有就留空 |
| EffectiveDate | date | 生效日 |
| Notes | text | |

> 廠價(未稅)、實際零售價、營業稅、銷售佣金等屬於**計算欄位**，不落地存，由 CalcEngine 用 `Parameters` 的稅率/佣金率即時算出並寫入 `PLResult`。
>
> **LIFE CYCLE 總台數**（供 `DevInvestment` 單台攤提使用）= `MonthlyVolume × 12 × LifeCycleYears`，屬計算欄位不落地存。
>
> **銷售構成表格**：畫面依「車系設定」自動列出該車型底下每個車系一列（`getSalesMixGrid`），
> 使用者不需要自己一列一列新增。台數與構成比在前端即時互相連動，永遠保持一致：
>
> | 改動的欄位 | 連動結果 |
> |---|---|
> | 某車系月台數 | 車型月總台數 = 各車系加總；所有構成比依台數重算 |
> | 某車系構成比% | 以車型月總台數反推該車系台數；其餘車系構成比依台數回算 |
> | 車型月總台數 | 各車系依目前構成比重新分配台數 |
>
> 構成比合計不等於 100% 時合計列會標紅提醒。整張表以 `saveSalesMixGrid` 一次送出。

### 2.4 `CostOfSales` 銷貨成本明細（原「材料成本」）

銷貨成本即 B 科目（b1~b13）。LP（在地採購）與 KD（進口）皆為成本項目，不區分採購模式；
**成本項目本身就是損益科目**，直接引用 `PLLineItems.LineCode`，可**直接在銷貨成本頁面新增/刪除**
（`addLineItemInline` / `deleteLineItemInline`，刪除項目會一併清掉該項目已輸入的金額），不需要另外跑到「科目設定」頁。

輸入介面為矩陣式表格（`getCostOfSalesMatrix` / `saveCostOfSalesMatrix`）：一列 = 一個成本項目，
一欄 = 一個車系，所有金額填完按一次儲存；清空的格子代表該項目在該車系沒有金額，會刪除對應資料列。

| 欄位 | 型別 | 說明 |
|---|---|---|
| RowID (PK) | text | |
| ScenarioID (FK) | text | |
| VehicleID (FK) | text | |
| LineCode (FK) | text | 對應 `PLLineItems`（ParentLine = `B` 且非自動計算科目） |
| Amount | currency | 原幣別金額 |
| Currency | text | 本位幣或「匯率設定」頁設定過現況匯率的幣別；非本位幣時由 CalcEngine 依該幣別的現況匯率換算，不在本表逐筆填匯率 |
| Notes | text | 備註（幣別與備註在畫面上是「列(科目)層級」設定，儲存時寫入該列各車系的儲存格） |
| EffectiveDate | date | |

> **不在本頁輸入的成本科目**（會重複計列）：
> - `b5` 模具費用、`b8` 新增專屬設備 → 由 `DevInvestment`（模具/設備類）低減後金額 ÷ LIFE CYCLE 總台數自動攤提
> - `b13` 貨物稅 → 依完稅價格自動計算（見 2.7 的 `RATE_COMMODITY_TAX`）

### 2.5 `DevInvestment` 開發總投

對應 Excel「部門別 × 資產類(模具/設備)/費用類」結構。
（原本的 `TNCAPFlag` 欄位已移除：並非所有車型都有 TNCAP 對應評估的需求，
需要時改以「同一個 GATE 下開兩個情境」來呈現對應/不對應的差異。）

| 欄位 | 型別 | 說明 |
|---|---|---|
| RowID (PK) | text | |
| ScenarioID (FK) | text | |
| Department | text | 部門自由新增/刪除（如產專室 / 產工部 / 試驗部 / 開發部...），每一列投入金額皆可獨立刪除，不受限於固定清單 |
| AssetType | text | 攤提落點：模具 / 設備 / 費用-CMC / 費用-BASE廠（舊資料可能還是「費用」） |
| Amount | currency | 原始投入金額 |
| Currency | text | 投入金額的幣別（BASE廠開發費常以 CNY 計價），非本位幣時依匯率設定換算 |
| ChallengeReductionPct | number | 挑戰低減目標%（0~100）。屬於**情境層級的假設**：同一個 GATE 下的「現況」與「目標」情境各自填自己的低減目標，以此呈現低減前後的損益差異 |
| Notes | text | |
| EffectiveDate | date | |

> 「低減後金額」「單台攤提」皆為計算欄位，由 CalcEngine 依 LIFE CYCLE 總台數分攤
> （優先用情境的攤提基準 `AmortMonthlyVolume × 12 × AmortLifeCycleYears`，
> 沒填才用銷售構成推算的 `Σ MonthlyVolume × 12 × LifeCycleYears`），並依 `AssetType` 落到不同科目：
>
> | AssetType（攤提落點） | 落點科目 |
> |---|---|
> | 模具 | `b5` 模具費用（銷貨成本） |
> | 設備 | `b8` 新增專屬設備（銷貨成本） |
> | 費用-CMC | `f3` 車型專案開發費用-CMC |
> | 費用-BASE廠 | `f4` 車型專案開發費用-BASE廠 |
>
> 舊版的資產類型只有一個「費用」，落到 f3 還是 f4 是看 `Department` 是不是剛好等於
> `BASE廠開發費` —— 部門是自由輸入欄位，打成「BASE廠」就會整筆跑到 f3，畫面上還看不出來
> （f4 一直是 0）。現在落點是明確的選項，畫面上每一列旁邊直接顯示會攤到哪個科目。
> 舊資料仍照原本的規則判讀，讀進畫面時自動轉成新的選項值。

### 2.6 `Parameters` 參數設定

前端拆成兩個獨立分頁籤管理（底層仍是同一張 `Parameters` 表，只是依 `ParamName` 篩選）：
- **稅務/費用比率**：營業稅率 / 銷售佣金率 / 季Margin率 / 貨物稅率
- **匯率設定**：現況匯率（銷貨成本與開發總投的外幣金額都用它換算）

> 舊版還有一個「集團預算匯率」，但沒有任何計算讀它 —— 換算一律走 `COST_FX_PARAM_NAME`(現況匯率)，
> 留著只會讓匯率設定頁多一欄怎麼填都不影響結果的數字，已移除。

| 欄位 | 型別 | 說明 |
|---|---|---|
| ParamID (PK) | text | |
| ScenarioID | text | 空白代表全域預設值 |
| VehicleID | text | 空白代表全車系適用；只有某個車系費率不同時才填該車系覆寫值 |
| ParamName | text | 營業稅率 / 銷售佣金率 / 貨物稅率 / 季Margin率 / 貨物稅完稅價格計算率 / 現況匯率 |
| Currency | text | 只有匯率列會填（1 外幣 = Value 台幣）；比率列留空 |
| Value | number | 比率為 0~100 百分比數值；匯率為原始匯率數值 |
| EffectiveDate | date | |

> **費率沿用機制**：同一車型各車系費率大多相同，畫面上只需填「全車系適用」那一欄（`VehicleID` 空白）。
> 車系欄位留白就自動沿用全車系值，只有真的不同的車系才會產生覆寫列。
> 尚未設定過的比率會帶入 `DEFAULT_PARAMS` 的系統預設值。

### 2.7 `PLLineItems` 損益科目定義（每個車型各自一份，「科目與公式」頁面維護）

**每個車型各自一份科目表**：`VehicleTypeID` 是車型代號；留白的那一組是「標準範本」，新建車型時可以選擇
從範本或從某個既有車型複製。科目在不同車型間差異很大，所以增刪改只影響自己的車型。
主鍵是 `LineID` = `車型|科目代碼`（範本用 `*|科目代碼`），`LineCode` 只需在同一個車型內唯一。
車型還沒有自己的科目表時，讀取一律沿用範本；第一次修改（或開頁時的資料升級）才會複製一份。

| 欄位 | 說明 |
|---|---|
| LineID (PK) | `車型|科目代碼`，系統產生 |
| VehicleTypeID | 車型代號；留白 = 標準範本 |
| LineCode | 科目代碼，系統依父科目自動編號（B→b、E→d、G→f、I→h、其他群組用父科目代碼小寫加底線、頂層用 S），同一車型內不重複 |
| LineName | 科目名稱（使用者擁有，不再夾帶公式） |
| ParentLine | 計入哪個小計（父科目）。手動輸入的金額：父科目鏈上有 `B` 的存在銷貨成本頁，其他存在營業費用頁 |
| Category | 分類（`售價結構` 決定顯示在售價結構段，其餘為說明用） |
| SortOrder | 同一層的順序（科目樹拖曳時依呈現順序整批重編；扣減型小計一律呈現在明細下面，跟 Excel 相同） |
| **CalcType** | 計算來源：`INPUT` 手動輸入 / `FORMULA` 公式 / `DEV_AMORT` 開發總投攤提 |
| **Formula** | 公式（`CalcType = FORMULA` 時），語法見 `usage.md`，解析/計算在 `src/FormulaEngine.gs` |
| **VehicleFormulas** | 車系個別公式，JSON `{ "車系ID": "公式" }`；有值的車系不論 CalcType 一律用它 |
| AutoSource | 舊欄位，保留相容；`DEV_AMORT` = 使用者自訂的攤提落點（沒有開發總投列指到時不顯示） |
| CommodityTaxDeduct | `Y` = 貨物稅完稅價格可扣除；公式裡 `TAXDEDUCT()` 是這些科目的合計 |
| DevAmortCategory | 攤提落點的大類（設備/模具/費用），開發總投頁用來分組 |
| Description | 科目說明（算法依據、資料來源） |

標準範本（`PL_LINE_ITEMS`）的預設公式，跟原本寫死在 CalcEngine 的算法逐格相同：

| 科目 | 預設公式 |
|---|---|
| P1 / P2 | `[建議零售價]` / `[強配件售價]` |
| P3 / P4 / P5 | `P1 - P2` / `[廢車處理費(含稅)]` / `P3 - P4` |
| P6 營業稅 | `ROUND(P5 * [營業稅率] / (1 + [營業稅率]))` |
| P7 銷售佣金 | `ROUND((P5 - P6) * [銷售佣金率])` |
| P8 廠價(未稅) / P9 | `P5 - P6 - P7` / `P2 / (1 + [營業稅率])` |
| A 收入 | `P8 + P9` |
| B 銷貨成本合計 | `CHILDREN()` |
| b13 貨物稅 | `(P8 - [水平配件調降] - TAXDEDUCT()) * [貨物稅完稅價格計算率] / (1 + [貨物稅率]) * [貨物稅率]` |
| C / E / G / I / K | `A - B` / `C - CHILDREN()` / `E - CHILDREN()` / `G - CHILDREN()` / `I - J` |
| d4 季Margin | `P8 * [季Margin率]` |
| b5 / b8 / f3 / f4 | 計算來源 = 開發總投攤提 |
| 其餘明細 | 手動輸入 |

結構科目（A/B/C/E/G/I/K）不可刪除、父科目不可改（儀表板與報告要用），但公式可以改。
其他科目被別的公式引用、底下還有子科目、或還有開發總投列攤提到它時，刪除會被擋下來。
小計驗算（`subtotalChecks_`）只驗「還是預設公式」的結構科目。

> **舊資料升級**（`migrateDataModel_`，開頁與載入資料包時自動執行）：v1 只有一份全域科目表、沒有
> `LineID/CalcType/Formula`，名稱裡寫公式（`廠價(未稅)(=P5-P6-P7)`）。升級時補 `LineID`、依 `AutoSource`
> 推算 `CalcType`、補預設公式、把舊版名稱換成新名稱（使用者改過的名稱不動），標成標準範本，再替每個車型各複製一份。
> 升級前後所有數字相同（`tools/verify-features.js` 驗證）。

### 2.7b `ParamDefs` 參數定義

| 欄位 | 說明 |
|---|---|
| ParamName (PK) | 參數名稱，公式用 `[參數名稱]` 取用 |
| Unit | `%`（以百分比輸入，公式取出 ÷100）或 `數值` |
| DefaultValue | 情境沒有填時的預設值 |
| Description / SortOrder | 說明、顯示順序 |

內建 5 個稅率/費率參數不可刪除；自訂參數的值一樣存在 `Parameters`（情境 × 車系）。

### 2.7c `LineNotes` 科目說明（GATE 報告的「說明」欄）

`RowID` / `ScenarioID` / `LineCode` / `VehicleID`(留白 = 整個科目) / `Notes`。
銷貨成本/營業費用頁的「說明」欄與報告上的說明是同一份；沒有另外寫說明的科目沿用該頁的舊備註。

### 2.7d `Actions` 改善作法

`ActionID` / `VehicleTypeID` / `ScenarioID`(目標情境) / `LineCode`(對應科目，選填) / `Title` / `Detail` /
`Owner`(擔當) / `Effect`(對營業淨利的單台改善金額，正數 = 改善) / `Status`(規劃中/進行中/已確認/已結案) / `DueDate` / `SortOrder`。
報告用來算「作法覆蓋率 = Σ Effect ÷ (目標營業淨利 − 現況營業淨利)」與「尚待補足」。

### 2.7e 其他 v2 新增欄位

- `Scenarios.SortOrder`：情境選單順序（情境設定頁拖曳）。
- `DevInvestment.VehicleScope`：分攤車系，逗號分隔車系代號；留白 = 全車系(÷ LC 總台數)，
  有值 = 只攤給這些車系(÷ 這些車系的攤提台數合計，有填攤提基準時依構成比分配基準台數)。

### 2.8 `PLResult` 損益計算結果（CalcEngine 寫回）

| 欄位 | 型別 | 說明 |
|---|---|---|
| ResultID (PK) | text | |
| ScenarioID (FK) | text | |
| VehicleID (FK) | text | 空白代表「DA車加權平均」列 |
| LineCode (FK) | text | 對應 PLLineItems |
| Amount | currency | |
| PctOfRevenue | % | 佔 A 收入(未稅,含強配)的比例，即 Gate F 表上的 % 欄 |
| PctOfExFactory | % | 佔 P8 廠價(未稅)的比例；沒有強配件時與 PctOfRevenue 相同 |
| CalcTimestamp | datetime | 計算時間，用來判斷是否為最新結果 |

> PLResult 是計算快照，不放進瀏覽器暫存，也不放進資料包；需要時隨時重算。

### 2.9 `OperatingExpense` 營業費用明細（d / f1 / h 科目）

銷貨成本表只涵蓋 B 銷貨成本（b1~b13）。E 之後的廣宣、促銷、費用類科目（d1~d5、f1、h1、h3、h4、J）另立一張表，結構與 `CostOfSales` 相同、只是科目集合不同，方便同一輸入表單的邏輯重用。科目同樣引用 `PLLineItems`，可在「科目設定」頁面增刪。

| 欄位 | 型別 | 說明 |
|---|---|---|
| RowID (PK) | text | |
| ScenarioID (FK) | text | |
| VehicleID (FK) | text | |
| LineCode (FK) | text | 對應 `PLLineItems`（ParentLine ∈ E/G/I 或 `J`，且非自動計算科目）：d1廣宣費用 / d2促銷 / d3批標售 / d5索賠 / f1直接歸屬費用 / h1固定營業費用 / h3品牌廣宣費用 / h4特別加發 / J前瞻費用 |
| Amount | currency | |
| Notes | text | |
| EffectiveDate | date | |

> **不在此表手動輸入的科目**：
> - `d4` 季Margin：即原「0.5%Margin」，直接由「稅務費用比率」頁的季Margin率 × 廠價(未稅) 算出。
> - `f3`/`f4` 車型專案開發費用：由 `DevInvestment` 費用類低減後金額 ÷ LIFE CYCLE 總台數（月台數 × 12 × LC年限）自動攤提。

### 2.10 `AuditLog` 異動紀錄（選配，建議加）

| 欄位 | 型別 | 說明 |
|---|---|---|
| Timestamp | datetime | |
| User | text | `Session.getActiveUser().getEmail()` |
| SheetName | text | 異動的表 |
| RowID | text | |
| Action | text | INSERT / UPDATE / DELETE |
| OldValue / NewValue | text | JSON 字串 |

---

## 3. 資料表關聯

```
VehicleTypes ──< Vehicles(車系) ──┬──< SalesMix >──┐
                                   ├──< CostOfSales >──┤
                                   └──< DevInvestment(部門別，不綁單一車系) >──┤
VehicleTypes ──< Scenarios ────────────────────────────┤
                                                          ├─ Scenarios
Parameters ───(依 ScenarioID/VehicleID 查詢)──────────────┤
                                                          │
PLLineItems ──(靜態科目表)──> CalcEngine ──> PLResult >──┘
```

- 前端導覽順序：先選「車型」(`VehicleTypes`，如 DA)，車型底下管理「車系」(`Vehicles`，如 3人貨車/9人客貨車) 與「情境」(`Scenarios`)；情境是車型的次要選單，同一車型下可以有多個 `ScenarioID`（現況/目標/已知低減方向），前端可並排比較。
- `DevInvestment` 是「部門別」層級，不直接綁車系；分攤到車系時透過 `SalesMix` 的 `LifeCycleYears × MonthlyVolume` 算出的「總台數」比例分攤（對應 Excel 的 CMC單台 / BASE廠單台邏輯）。

---

## 4. 架構與資料流

見 `docs/architecture.md`。

## Snapshots（情境快照）

| 欄位 | 說明 |
|---|---|
| SnapshotID | 主鍵（SNAP-…） |
| VehicleTypeID / ScenarioID | 來源車型、情境（情境刪除後快照仍保留） |
| SnapshotName / Notes | 名稱、備註 |
| CreatedAt / CreatedBy | 建立時間（ISO）、建立者 |
| Data | JSON：`{ v, scenario, lines, columns: [{ vehicleId, vehicleLabel, isWeighted, amounts, revenue, exFactoryPrice, volume }] }`，存的是計算結果 |

比較功能裡以 `snap:<SnapshotID>` 當成唯讀情境代號（`calculateComparison`、`getComparisonOptions`、瀑布圖工具）。
