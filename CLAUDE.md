# 專案規則

- 不要加改版宣傳文字：介面上（側邊欄、頁尾、標題、提示、按鈕旁的「新」標記等）不放版本號或「v2 · 新功能…」這類標語；
  文件也不再新增「vX.Y 重點 / 改了什麼」這種改版段落，直接把現在的操作方式寫進對應章節。
- 改了 `src/` 或 `local/` 之後執行 `node tools/build-local.js` 重新產生 `dist/FS-local.html` 一起提交。
- 提交前跑 `tools/` 底下的驗證（見 README「驗算」），瀏覽器測試是 `node tools/e2e-local.js`。
- 使用手冊要跟系統同步：功能或畫面有調整（改了 `src/`、`local/`）時，同一個 PR 裡一起更新手冊——
  1. 改 `docs/manual/index.html` 對應章節的說明與圖說（照現在的操作方式寫）；新的頁面、對話框或操作，在 `tools/manual-screens.js` 加一步截圖並寫進手冊；
     `docs/usage.md` 的對應段落也一起改。
  2. `node tools/build-local.js` → `node tools/manual-screens.js`（全部重截，會記下截圖用的是哪一版系統）→ `node tools/build-manual.js`（產生 GitHub 上看的 `docs/manual/README.md`）。
  3. `node tools/verify-manual.js` 要通過：README.md 是最新的、圖都在也沒有多的、截圖是目前這一版系統、左側導覽的每一頁手冊都有寫到。
  只改 `index.html`，不要直接改 `README.md`；手冊的線上版（claude.ai 的 Artifact）是另外發布的副本，以 GitHub 上的為準。
