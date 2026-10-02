/* ---------------- 初始化 ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  installTooltipEngine_();
  installSaveBar_();
  installExcelPaste_();
  const saved = loadAppState_();
  // 先把上次的車型/情境放回全域變數，再切分頁：switchTab() 會順手 saveAppState_()，
  // 這時後端資料還沒回來，全域若還是空字串就會把記住的選擇覆寫掉
  // （getBootstrap 失敗、或使用者在資料回來前就關掉分頁，記住的選擇就永久不見了）。
  currentVehicleTypeId = saved.vehicleTypeId || '';
  currentScenarioId = saved.scenarioId || '';
  // 開場先靜音：switchTab 只切畫面不渲染，等 getBootstrap 回來再渲染一次，避免同一個分頁畫兩遍
  silent = true;
  switchTab(saved.tab && document.getElementById('panel-' + saved.tab) ? saved.tab : 'dashboard', true);
  loadVehicleTypeSelector(saved.vehicleTypeId, saved.scenarioId);
});
