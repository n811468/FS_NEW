/* ================= 匯出 Excel 驗算檔 =================
 * 一個情境一個檔：輸入數字 + 由「科目與公式」翻成的 Excel 公式 + 驗算頁 + 公式區(見後端 VerifyWorkbook.gs)。
 * 儀表板的比較欄位有好幾個情境時，先問要匯出哪一個；只有一個(或從工具列進來)就直接匯出目前情境。
 */
function verifyScenarioChoices_() {
  const seen = {}, out = [];
  const labelOf = id => {
    for (const t of comparisonOptions || []) {
      const s = (t.scenarios || []).find(x => x.ScenarioID === id);
      if (s) return [t.VehicleTypeID, s.Gate, s.ScenarioName].filter(Boolean).join(' ');
    }
    const s = (scenarioCache || []).find(x => x.ScenarioID === id);
    return s ? [s.VehicleTypeID, s.Gate, s.ScenarioName].filter(Boolean).join(' ') : id;
  };
  const add = id => { if (id && !seen[id] && !/^snap:/.test(id)) { seen[id] = true; out.push([id, labelOf(id)]); } };
  add(currentScenarioId);
  (comparisonSelections || []).forEach(s => add(s.ScenarioID));
  return out;
}

function exportVerifyWorkbookFromDashboard() {
  const choices = verifyScenarioChoices_();
  if (!choices.length) { toast('請先在右上角選擇情境', 'err'); return; }
  if (choices.length === 1) { exportVerifyWorkbook(choices[0][0]); return; }
  openModal({
    title: '匯出 Excel 驗算檔',
    body: '<p class="muted">一個情境一個檔：輸入數字、每個科目的 Excel 公式、驗算頁與公式區。</p>',
    okText: '匯出',
    fields: [{ name: 'sid', label: '情境', type: 'select', value: choices[0][0], options: choices }]
  }).then(r => { if (r) exportVerifyWorkbook(r.sid); });
}

function exportVerifyWorkbook(scenarioId) {
  const sid = scenarioId || currentScenarioId;
  if (!sid) { toast('請先在右上角選擇情境', 'err'); return; }
  toast('正在產生 Excel 驗算檔…');
  google.script.run
    .withSuccessHandler(safeHandler(res => {
      const bin = atob(res.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url; a.download = res.fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast(`已下載 ${res.fileName}（${res.lines} 個科目 × ${res.vehicles} 個車系）`, 'ok', 4000);
      if (res.errors && res.errors.length) toast(`有 ${res.errors.length} 個科目的公式在系統裡就是錯誤（以 0 計），驗算檔的公式區有標出來`, 'err');
    }))
    .withFailureHandler(showGlobalError)
    .exportVerifyWorkbook(sid);
}
