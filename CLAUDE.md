# 專案規則

- 不要加改版宣傳文字：介面上（側邊欄、頁尾、標題、提示、按鈕旁的「新」標記等）不放版本號或「v2 · 新功能…」這類標語；
  文件也不再新增「vX.Y 重點 / 改了什麼」這種改版段落，直接把現在的操作方式寫進對應章節。
- 改了 `src/` 或 `local/` 之後執行 `node tools/build-local.js` 重新產生 `dist/FS-local.html` 一起提交。
- 提交前跑 `tools/` 底下的驗證（見 README「驗算」），瀏覽器測試是 `node tools/e2e-local.js`。
