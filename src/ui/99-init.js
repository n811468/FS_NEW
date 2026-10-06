/* ---------------- 初始化 ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  installTooltipEngine_();
  installSaveBar_();
  installExcelPaste_();
  installGridKeys_();
  applySidebarPref_();
  // 下拉選單(details.menu)：點選單外面就收起來
  document.addEventListener('click', e => {
    document.querySelectorAll('details.menu[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
  });
  const saved = loadAppState_();
  // 先把上次的車型/情境放回全域變數，再切分頁：switchTab() 會順手 saveAppState_()，
  // 這時後端資料還沒回來，全域若還是空字串就會把記住的選擇覆寫掉
  // （getBootstrap 失敗、或使用者在資料回來前就關掉分頁，記住的選擇就永久不見了）。
  currentVehicleTypeId = saved.vehicleTypeId || '';
  currentScenarioId = saved.scenarioId || '';
  // 開場先靜音：switchTab 只切畫面不渲染，等 getBootstrap 回來再渲染一次，避免同一個分頁畫兩遍
  silent = true;
  const tab = MERGED_TABS_[saved.tab] || saved.tab;   // 已經併到別頁的舊分頁(車系設定、匯率設定…)回到新的那一頁
  switchTab(tab && document.getElementById('panel-' + tab) ? tab : 'dashboard', true);
  loadVehicleTypeSelector(saved.vehicleTypeId, saved.scenarioId);
});
