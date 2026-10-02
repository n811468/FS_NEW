/**
 * 前端程式：src/ui/*.js 依檔名順序串成一段 <script>。
 *
 * 前端原本全部寫在一個 4,000 多行的 script.html 裡；v2 依頁面拆成多個檔案比較好維護，
 * 但它們仍然是「同一個 script 的不同段落」(共用全域函式與變數，不是 ES module)，
 * 所以 build / 本機預覽 / 驗證一律透過這裡串起來，三個地方看到的一定是同一份程式。
 *   00-core        共用工具、對話框、未儲存提醒、拖曳排序、頁籤與上方選單
 *   10-masters     車型 / 車系 / 情境
 *   20-inputs      銷售構成、銷貨成本/營業費用矩陣、開發總投、參數、匯率、從 Excel 貼上
 *   30-chart       科目與公式
 *   40-report      GATE 報告
 *   45-whatif      目標反推與敏感度
 *   50~52          損益儀表板(表格、SVG 圖表、hover 提示)
 *   99-init        開頁初始化
 */
const fs = require('fs');
const path = require('path');

const UI_DIR = path.join(__dirname, '..', 'src', 'ui');

function frontendFiles() {
  return fs.readdirSync(UI_DIR).filter(f => /\.js$/.test(f)).sort();
}
function frontendJs() {
  return frontendFiles().map(f => `/* ===== src/ui/${f} ===== */\n` + fs.readFileSync(path.join(UI_DIR, f), 'utf8')).join('\n');
}
function frontendScript() {
  const js = frontendJs();
  if (/<\/script/i.test(js)) throw new Error('前端程式碼含有 </script>，無法放進單一檔案');
  return `<script>\n${js}\n</script>`;
}

module.exports = { frontendFiles, frontendJs, frontendScript, UI_DIR };
