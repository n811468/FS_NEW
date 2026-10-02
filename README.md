# 車型損益試算系統（地端版）

**單一 HTML 檔，雙擊即用**：把 `dist/FS-local.html` 複製到電腦任何位置，用 Chrome / Edge 雙擊打開。
不需要 Google 帳號、伺服器、網路或安裝任何東西，資料只存在自己電腦的瀏覽器裡。

用**資料包**（JSON）備份與交換：工具列「匯出全部」是備份；每個人負責自己的車型，
「匯出目前車型」交給同事「合併匯入」，就能在儀表板上跨車型並排比較。

- 打開方式、資料包、合併規則：[`local/README.md`](local/README.md)
- 各頁面怎麼填、損益公式：[`docs/usage.md`](docs/usage.md)
- 資料結構（也就是資料包裡每張表的欄位）：[`docs/data-schema.md`](docs/data-schema.md)
- 架構：[`docs/architecture.md`](docs/architecture.md)

## 專案結構

```
src/     系統本體：後端 .gs(計算引擎、資料存取) + 前端 index/script/style.html
local/   地端層：瀏覽器版模擬層、資料包、暫存、工具列
dist/    FS-local.html —— 由 tools/build-local.js 產生的單一檔案，使用者拿這一個就好
tools/   build、驗算、本機預覽(只在開發時用 Node 執行)
docs/    說明文件
```

改了 `src/` 或 `local/` 之後，執行 `node tools/build-local.js` 重新產生 `dist/FS-local.html` 再提交
（忘了也會被 `verify-local.js` 抓到）。

## 驗算

`tools/` 底下有一層 Node 版的記憶體試算表，讓 `src/*.gs` 可以直接在 Node 上跑，
不必打開瀏覽器就能驗證計算結果與畫面產出（需要 Node.js，不需要安裝任何套件）：

```bash
node tools/verify-gatef.js             # 用實際 Gate F 損益試算表的數字逐格驗算（317 格）
node tools/verify-features.js          # 情境帶入、科目自動編號、匯率精簡等行為
node tools/verify-ui.js                # 損益表版面、% 基準、小計警示、CSV 欄數
node tools/verify-write-batching.js    # 整批寫入：跨情境隔離、新增/更新/刪除混合、呼叫次數不隨格數線性成長
node tools/verify-local.js             # 地端版：數字與驗算層逐格相同、暫存、資料包、合併匯入、dist 為最新
node tools/e2e-local.js                # 地端版瀏覽器測試（需要 Playwright，找不到時略過）
```

`verify-gatef.js` 會順便把比較表印出來，方便跟原始試算表並排肉眼再對一次。

## 本機預覽（改前端時用）

```bash
node tools/dev-server.js               # 打開 http://localhost:8787
```

改 `src/script.html` / `src/style.html` 時，不必每次重新 build：存檔後按 F5 就看得到。
資料只在記憶體、重啟就回到示範資料。適合調版面、看儀表板的圖表與 hover 提示。
