/* ================= 情境快照(版本紀錄) =================
 * 審議前後數字常常改：存一份快照，之後在儀表板、瀑布圖工具把「快照」當成一個唯讀情境，
 * 直接跟現在的數字並排比較、拆解差異。快照存的是當時的計算結果，之後資料怎麼改都不受影響。
 */
function createSnapshotDialog_(scenarioId, label) {
  if (!scenarioId) { toast('請先選擇情境', 'warn'); return; }
  const d = new Date();
  const today = `${d.getMonth() + 1}/${d.getDate()}`;
  openModal({
    title: '存成情境快照',
    body: `<p class="help">把「${esc(label || '')}」目前算出來的損益（加權平均與每個車系）存一份。之後輸入資料怎麼改都不影響快照，
      在儀表板或瀑布圖工具選「情境快照」就能跟現在的數字比較。</p>`,
    fields: [
      { name: 'name', label: '快照名稱', value: `${today} 版`, placeholder: '例：GATE F 審議版' },
      { name: 'notes', label: '備註（選填）', type: 'textarea', placeholder: '例：審議會前送出的版本' }
    ],
    okText: '存快照',
    validate: v => String(v.name || '').trim() ? '' : '請輸入快照名稱'
  }).then(v => {
    if (!v) return;
    google.script.run
      .withSuccessHandler(safeHandler(() => {
        toast(`已存快照「${v.name}」`, 'ok', 2500);
        loadSnapshotCard_();
      }))
      .withFailureHandler(err => toast(err.message, 'err', 4000))
      .createSnapshot(scenarioId, v.name, v.notes || '');
  });
}

let snapshotList_ = [];
function snapshotCardShellHtml_() {
  return `<div class="card" id="snapshot-card" style="margin-top:16px;">
    <div class="card-head"><h3>情境快照（版本紀錄）</h3><span class="muted">存下某個時間點的損益數字，之後跟現在比較「差在哪」</span>
      <span class="spacer"></span>
      <button type="button" class="btn sm" onclick="createSnapshotDialog_(currentScenarioId, currentScenario ? scenarioLabel(currentScenario) : '')">把目前情境存成快照</button></div>
    <div id="snapshot-body"><p class="muted">載入中...</p></div></div>`;
}
function loadSnapshotCard_() {
  const body = document.getElementById('snapshot-body');
  if (!body || !currentVehicleTypeId) return;
  google.script.run
    .withSuccessHandler(safeHandler(list => { snapshotList_ = list || []; drawSnapshotCard_(); }))
    .withFailureHandler(err => { body.innerHTML = `<div class="callout err">${esc(err.message)}</div>`; })
    .getSnapshots(currentVehicleTypeId);
}
function drawSnapshotCard_() {
  const body = document.getElementById('snapshot-body');
  if (!body) return;
  if (!snapshotList_.length) {
    body.innerHTML = '<p class="muted">還沒有快照。審議前、送簽前存一份，之後改了數字也能清楚交代改了什麼。</p>';
    return;
  }
  body.innerHTML = `<div class="grid-scroll"><table class="grid-table snapshot-table">
    <thead><tr><th>快照名稱</th><th>來源情境</th><th>營業淨利（加權，元/台）</th><th>建立時間</th><th>建立者</th><th>備註</th><th></th></tr></thead>
    <tbody>${snapshotList_.map((s, i) => `<tr>
      <td class="txt"><b>${esc(s.SnapshotName)}</b></td>
      <td class="txt">${esc(s.scenarioLabel)}${s.scenarioExists ? '' : ' <span class="lever-cap">情境已刪除</span>'}</td>
      <td class="${s.K < 0 ? 'negative' : ''}">${s.K === null ? '—' : fmt(s.K)}</td>
      <td class="txt">${esc(String(s.CreatedAt || '').replace('T', ' ').slice(0, 16))}</td>
      <td class="txt">${esc(s.CreatedBy || '')}</td>
      <td class="txt">${esc(s.Notes || '')}</td>
      <td class="row-actions" style="white-space:nowrap;">
        ${s.scenarioExists ? `<button type="button" class="btn secondary sm" onclick="compareSnapshotNow_(${i})" data-tip="瀑布圖：這個快照 → 現在的同一個情境，差在哪些科目">跟現在比較</button>` : ''}
        <button type="button" class="btn secondary sm" onclick="addSnapshotToDashboard_(${i})">加到儀表板</button>
        <button type="button" class="btn ghost sm" onclick="renameSnapshotDialog_(${i})">改名</button>
        <button type="button" class="btn ghost sm" onclick="deleteSnapshot_(${i})" aria-label="刪除">✕</button>
      </td></tr>`).join('')}</tbody></table></div>`;
}
function compareSnapshotNow_(i) {
  const s = snapshotList_[i];
  if (!s) return;
  loadWfPrefs_();
  wfPrefs.mode = 'bridge';
  wfPrefs.from = { scenarioId: 'snap:' + s.SnapshotID, vehicleId: '' };
  wfPrefs.to = { scenarioId: s.ScenarioID, vehicleId: '' };
  wfPrefs.end = 'K';
  saveWfPrefs_();
  switchTab('waterfall');
}
function addSnapshotToDashboard_(i) {
  const s = snapshotList_[i];
  if (!s) return;
  if (!dashPrefsLoaded_) { loadDashPrefs_(); dashPrefsLoaded_ = true; }
  const key = 'snap:' + s.SnapshotID;
  if (!comparisonSelections.some(x => x.ScenarioID === key && !x.VehicleID)) comparisonSelections.push({ ScenarioID: key, VehicleID: '' });
  if (s.scenarioExists && !comparisonSelections.some(x => x.ScenarioID === s.ScenarioID && !x.VehicleID)) comparisonSelections.push({ ScenarioID: s.ScenarioID, VehicleID: '' });
  dashView = 'table';
  saveDashPrefs_();
  switchTab('dashboard');
}
function renameSnapshotDialog_(i) {
  const s = snapshotList_[i];
  if (!s) return;
  openModal({
    title: '修改快照', okText: '儲存',
    fields: [{ name: 'name', label: '快照名稱', value: s.SnapshotName }, { name: 'notes', label: '備註', type: 'textarea', value: s.Notes || '' }],
    validate: v => String(v.name || '').trim() ? '' : '請輸入快照名稱'
  }).then(v => {
    if (!v) return;
    google.script.run.withSuccessHandler(safeHandler(() => loadSnapshotCard_())).withFailureHandler(err => toast(err.message, 'err'))
      .renameSnapshot(s.SnapshotID, v.name, v.notes || '');
  });
}
function deleteSnapshot_(i) {
  const s = snapshotList_[i];
  if (!s) return;
  confirmModal('刪除快照', `確定刪除快照「${esc(s.SnapshotName)}」？刪除後無法復原（情境本身不受影響）。`, '刪除', true).then(ok => {
    if (!ok) return;
    google.script.run.withSuccessHandler(safeHandler(() => { toast('已刪除快照', 'ok', 1500); loadSnapshotCard_(); })).withFailureHandler(err => toast(err.message, 'err'))
      .deleteSnapshot(s.SnapshotID);
  });
}
