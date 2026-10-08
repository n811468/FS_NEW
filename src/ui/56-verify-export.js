/* ================= 匯出 Excel 驗算檔 =================
 * 一個情境一個檔：輸入數字 + 由「科目與公式」翻成的 Excel 公式 + 驗算頁 + 公式區(見後端 VerifyWorkbook.gs)。
 * 匯出前的對話框選情境(儀表板的比較欄位有好幾個情境時)與要比較的快照；沒有快照、也只有一個情境時直接匯出。
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

function exportVerifyWorkbookFromDashboard() { exportVerifyWorkbookDialog(); }

/**
 * 匯出對話框：選情境，另外可以選一個快照(改公式、科目之前存的)，驗算檔就會多一頁「變動檢查」。
 * 沒有快照、也只有一個情境可選時直接匯出。
 */
function exportVerifyWorkbookDialog(scenarioId) {
  const choices = verifyScenarioChoices_();
  if (scenarioId && !choices.some(c => c[0] === scenarioId)) choices.unshift([scenarioId, scenarioId]);
  if (!choices.length) { toast('請先在右上角選擇情境', 'err'); return; }
  const first = scenarioId || choices[0][0];
  google.script.run
    .withSuccessHandler(safeHandler(snaps => {
      snaps = (snaps || []).filter(s => s.scenarioExists !== false);
      if (!snaps.length && choices.length === 1) { exportVerifyWorkbook(first); return; }
      const day = iso => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
      const latest = snaps.find(s => s.ScenarioID === first);
      openModal({
        title: '匯出 Excel 驗算檔',
        body: '<p class="muted">一個情境一個檔：輸入數字、每個科目的 Excel 公式、驗算頁、公式區，以及改公式／科目之後的檢查（結構檢查、科目影響、跟系統預設比較）。</p>',
        okText: '匯出',
        fields: [
          { name: 'sid', label: '情境', type: 'select', value: first, options: choices },
          { name: 'snap', label: '跟快照比（選填）', type: 'select', value: latest ? latest.SnapshotID : '',
            options: [['', '（不比較）']].concat(snaps.map(s => [s.SnapshotID, `${s.SnapshotName}（${[s.VehicleTypeID, s.scenarioLabel].filter(Boolean).join(' ')}，${day(s.CreatedAt)}）`])),
            help: '改公式、科目之前先存情境快照，這裡選它，驗算檔會多一頁「變動檢查」：逐科目列出改前 → 改後的差異，標出公式沒改、數字卻變了的科目。' }
        ]
      }).then(r => { if (r) exportVerifyWorkbook(r.sid, r.snap); });
    }))
    .withFailureHandler(showGlobalError)
    .getSnapshots('');
}

function exportVerifyWorkbook(scenarioId, snapshotId) {
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
      if (res.impactBad) toast(`有 ${res.impactBad} 個科目沒算進營業淨利、重複計算或正負號相反，看驗算檔的「科目影響」`, 'err');
      if (res.errors && res.errors.length) toast(`有 ${res.errors.length} 個科目的公式在系統裡就是錯誤（以 0 計），驗算檔的公式區有標出來`, 'err');
    }))
    .withFailureHandler(showGlobalError)
    .exportVerifyWorkbook(sid, snapshotId || '');
}
