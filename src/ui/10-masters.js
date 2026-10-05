/* ---------------- 主檔維護（表格直接編輯，不需要先按「編輯」） ----------------
 * 車型、車系、情境三個表格放在同一頁「車型與情境」(以前是三個分頁)：每個表格各有自己的儲存鈕，
 * 底部的「儲存」/Ctrl+S 會把每個改過的表格都存起來(見 markDirtyPart_)。 */
let entityRows = {};        // key -> 目前表格上的資料列（__existing 標記是否已存在於後端）
let pendingStatus = null;   // 重畫表格後才顯示的訊息（例如建立情境後整個面板會被重繪）

function renderMastersPanel() {
  const panel = document.getElementById('panel-masters');
  if (!panel) return;
  const vt = currentVehicleTypeId;
  const section = (key, title) => `<div class="card master-card" id="master-${key}">
      <div class="card-head"><h3>${title}</h3></div>
      ${ENTITIES[key].scopedBy === 'vehicleType' && !vt
        ? '<p class="muted">請先在上面建立車型，或在右上角選擇車型。</p>'
        : gridShell(key, ENTITIES[key].label, ENTITIES[key].intro)}
    </div>`;
  panel.innerHTML = section('vehicletypes', '車型') +
    section('vehicles', `車系${vt ? `<span class="muted">（${esc(vt)}）</span>` : ''}`) +
    section('scenarios', `情境${vt ? `<span class="muted">（${esc(vt)}）</span>` : ''}`) +
    (vt ? snapshotCardShellHtml_() : '');
  Object.keys(ENTITIES).forEach(key => { if (ENTITIES[key].scopedBy !== 'vehicleType' || vt) loadEntityData(key); });
  if (vt) loadSnapshotCard_();
}
function entityDirty_(key) {
  markDirtyPart_('masters', key, () => saveEntityGrid(key), () => { clearDirtyPart_(key); loadEntityData(key); });
}

/** ENTITIES 的 scopedBy 只有 'vehicleType' 或 null，剛好對應到快取鍵要區分到什麼程度 */
function entityCacheScope_(cfg) { return cfg.scopedBy === 'vehicleType' ? 'vehicleType' : 'none'; }

function loadEntityData(key) {
  const cfg = ENTITIES[key];
  const args = cfg.scopedBy === 'vehicleType' ? [currentVehicleTypeId] : [];
  const cacheKey = panelCacheKey_(key, entityCacheScope_(cfg));
  const apply = rows => {
    // 使用者已經開始改這個表格了，背景回來的資料不要蓋掉畫面
    if (dirtyState_ && (dirtyState_.parts ? dirtyState_.parts[key] : dirtyState_.key === key)) return;
    entityRows[key] = (rows || []).map(r => Object.assign({}, r, { __existing: true }));
    drawEntityGrid(key);
  };
  if (panelDataCache_[cacheKey]) apply(panelDataCache_[cacheKey]);
  google.script.run
    .withSuccessHandler(safeHandler(rows => { panelDataCache_[cacheKey] = rows; apply(rows); }))
    .withFailureHandler(showGlobalError)
    [cfg.getFn](...args);
}

function drawEntityGrid(key) {
  const cfg = ENTITIES[key];
  const rows = entityRows[key] || [];
  const toolbar = document.getElementById('toolbar-' + key);
  if (!toolbar) return;

  toolbar.innerHTML = (cfg.createUi === 'scenario' ? scenarioToolbarHtml() : cfg.createUi === 'vehicleType'
    ? `<button type="button" class="btn" onclick="createVehicleTypeDialog()">＋ 新增車型</button>`
    : `<button type="button" class="btn" onclick="addEntityRow('${key}')">＋ 新增一列</button>`) +
    `<span class="spacer"></span><button type="button" class="btn secondary" onclick="saveEntityGrid('${key}')">儲存</button>`;

  const sortable = cfg.sortable && rows.length > 1;
  const body = rows.length
    ? rows.map((r, i) => `<tr${r.__existing ? '' : ' class="new-row"'} data-key="${i}">
        ${sortable ? `<td class="row-actions">${r.__existing ? dragHandleHtml() : ''}</td>` : ''}
        ${cfg.columns.map(col => entityCellHtml(key, i, col, r)).join('')}
        <td class="row-actions">${entityRowActionHtml(key, i, r, rows.length)}</td>
      </tr>`).join('')
    : `<tr><td class="muted" colspan="${cfg.columns.length + 2}" style="text-align:center;padding:24px;">尚無資料</td></tr>`;

  document.getElementById('grid-' + key).innerHTML = `
    <div class="grid-scroll">
      <table class="grid-table entity-table">
        <thead><tr>${sortable ? '<th style="width:36px;"></th>' : ''}${cfg.columns.map(c => `<th>${esc(c.label)}</th>`).join('')}<th>操作</th></tr></thead>
        <tbody id="entity-body-${key}">${body}</tbody>
      </table>
    </div>`;

  if (sortable) {
    makeSortable(document.getElementById('entity-body-' + key), {
      items: 'tr[data-key]',
      onEnd: keys => {
        const old = entityRows[key];
        entityRows[key] = keys.map(k => old[Number(k)]);
        if (entityRows[key].some(r => !r.__existing)) {
          drawEntityGrid(key);
          toast('新增的列還沒儲存，先按「儲存」後再調整順序會立即生效', 'warn');
          return;
        }
        const ids = entityRows[key].map(r => r[cfg.pk]);
        drawEntityGrid(key);
        google.script.run
          .withSuccessHandler(safeHandler(saved => {
            panelDataCache_[panelCacheKey_(key, entityCacheScope_(cfg))] = saved;
            Object.keys(panelDataCache_).forEach(k => { if (k.indexOf(key + '::') !== 0) delete panelDataCache_[k]; });
            toast('已更新順序', 'ok', 1400);
            if (key === 'scenarios') refreshScenarioOptions(currentScenarioId);
          }))
          .withFailureHandler(err => { toast(err.message, 'err'); loadEntityData(key); })
          [cfg.sortable](currentVehicleTypeId, ids);
      }
    });
  }
  if (pendingStatus && pendingStatus.key === key) {
    setStatus(key, pendingStatus.text, pendingStatus.cls);
    pendingStatus = null;
  }
}

function entityCellHtml(key, i, col, row) {
  const value = row[col.name] === undefined || row[col.name] === null ? '' : row[col.name];
  const locked = col.readOnly || col.auto ||
    (col.lockAfterCreate && row.__existing) ||
    (col.lockIf && col.lockIf(row));
  const style = col.width ? ` style="width:${col.width}px;"` : '';

  if (locked) {
    const shown = col.auto && !value ? '(儲存時自動編號)' : value;
    return `<td class="row-head">${esc(shown)}</td>`;
  }
  if (col.type === 'select') {
    const options = col.options.map(o => {
      const [v, text] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}"${String(value) === String(v) ? ' selected' : ''}>${esc(text)}</option>`;
    }).join('');
    return `<td><select${style} onchange="onEntityField('${key}', ${i}, '${col.name}', this.value)">${options}</select></td>`;
  }
  return `<td><input type="${col.type || 'text'}" step="any" value="${esc(value)}"${style}
    oninput="onEntityField('${key}', ${i}, '${col.name}', this.value)"></td>`;
}

function entityRowActionHtml(key, i, row) {
  if (!row.__existing) {
    return `<button type="button" class="btn ghost sm" onclick="removeEntityRow('${key}', ${i})">移除</button>`;
  }
  const cfg = ENTITIES[key];
  const renameBtn = cfg.renameFn
    ? `<button type="button" class="btn ghost sm" onclick="renameEntityRow('${key}', ${i})">改代號</button>` : '';
  return renameBtn + `<button type="button" class="btn danger sm" onclick="deleteEntityRow('${key}', ${i})">刪除</button>`;
}

/**
 * 車型/車系代號重新命名：代號是其他表格的外鍵，不能直接在格子裡改字串，
 * 改用後端的 rename 函式一次把所有引用該代號的地方(含科目表、作法、車系個別公式)都更新過去。
 */
function renameEntityRow(key, i) {
  const cfg = ENTITIES[key];
  const row = entityRows[key][i];
  const oldId = row[cfg.pk];
  openModal({
    title: '修改代號：' + oldId,
    body: '<p class="help">所有引用這個代號的資料（車系、情境、銷售構成、成本、科目表…）會一起改成新代號。</p>',
    fields: [{ name: 'id', label: '新的代號', value: oldId }],
    okText: '修改',
    validate: v => !v.id.trim() ? '代號不能空白' : ''
  }).then(v => {
    if (!v) return;
    const newId = v.id.trim();
    if (newId === oldId) return;
    const args = key === 'vehicles' ? [currentVehicleTypeId, oldId, newId] : [oldId, newId];
    setStatus(key, '修改中...');
    google.script.run
      .withSuccessHandler(safeHandler(() => {
        Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
        pendingStatus = { key: key, text: `已將「${oldId}」改為「${newId}」`, cls: 'ok' };
        // 改的是目前的車型：同一頁下面的車系/情境標題也要跟著換，整頁重新載入
        if (key === 'vehicletypes' && currentVehicleTypeId === oldId) { currentVehicleTypeId = newId; loadVehicleTypeSelector(newId); return; }
        loadEntityData(key);
        afterEntityChange(key);
      }))
      .withFailureHandler(err => setStatus(key, '錯誤：' + err.message, 'err'))
      [cfg.renameFn](...args);
  });
}

function onEntityField(key, i, field, value) {
  entityRows[key][i][field] = value;
  entityDirty_(key);
  if (key === 'scenarios' && (field === 'CreatedDate' || field === 'ScenarioType')) {
    autoFillScenarioName_(i);
  }
}

/** yyyy-MM-dd -> "MMDD"，用來組情境名稱的日期後綴 */
function dateToMMDD_(dateStr) {
  const m = String(dateStr || '').match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? m[1] + m[2] : '';
}

/**
 * 情境名稱自動帶入：選了建立日期(或改了情境性質)後，把名稱補成「情境性質+MMDD」(如「現況0901」)。
 * 只在名稱是空白、或還是上一次自動帶入的值時才覆蓋 —— 使用者手動打過的名稱不會被蓋掉。
 */
function autoFillScenarioName_(i) {
  const row = entityRows.scenarios[i];
  const suffix = dateToMMDD_(row.CreatedDate);
  if (!suffix) return;
  const auto = (row.ScenarioType || '') + suffix;
  if (!row.ScenarioName || row.ScenarioName === row.__scenarioNameAuto) {
    row.ScenarioName = auto;
    row.__scenarioNameAuto = auto;
    drawEntityGrid('scenarios');
  }
}

function addEntityRow(key) {
  const cfg = ENTITIES[key];
  const row = { __existing: false };
  cfg.columns.forEach(c => { row[c.name] = ''; });
  if (cfg.pk) row[cfg.pk] = '';
  entityRows[key].push(row);
  drawEntityGrid(key);
  entityDirty_(key);
  const inputs = document.querySelectorAll(`#entity-body-${key} tr:last-child input`);
  if (inputs[0]) inputs[0].focus();
}

/** 還沒存進後端的新增列，直接從畫面上拿掉就好 */
function removeEntityRow(key, i) {
  entityRows[key].splice(i, 1);
  drawEntityGrid(key);
}

function deleteEntityRow(key, i) {
  const cfg = ENTITIES[key];
  const row = entityRows[key][i];
  const label = row[cfg.pk] && cfg.pk !== 'ScenarioID' ? row[cfg.pk] : scenarioLabel(row);
  confirmModal('刪除「' + label + '」？', key === 'vehicletypes'
    ? '車型與它自己的科目表會一起刪除。底下的車系與情境資料不會被刪，但會看不到。這個動作無法復原。'
    : '這個動作無法復原。', '刪除', true).then(ok => {
    if (!ok) return;
    setStatus(key, '刪除中...');
    google.script.run
      .withSuccessHandler(safeHandler(() => {
        Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
        pendingStatus = { key: key, text: '已刪除', cls: 'ok' };
        // 刪掉的是目前的車型：換到剩下的車型，同一頁下面的車系/情境一起換
        if (key === 'vehicletypes' && currentVehicleTypeId === row[cfg.pk]) { currentVehicleTypeId = ''; loadVehicleTypeSelector(''); return; }
        loadEntityData(key);
        afterEntityChange(key);
      }))
      .withFailureHandler(err => setStatus(key, '錯誤：' + err.message, 'err'))
      [cfg.deleteFn](row[cfg.pk]);
  });
}

function saveEntityGrid(key) {
  const cfg = ENTITIES[key];
  const rows = (entityRows[key] || []).map(r => {
    const copy = {};
    cfg.columns.forEach(c => { copy[c.name] = r[c.name] === undefined ? '' : r[c.name]; });
    if (cfg.pk) copy[cfg.pk] = r[cfg.pk] === undefined ? '' : r[cfg.pk];
    return copy;
  });
  const args = cfg.scopedBy === 'vehicleType' ? [currentVehicleTypeId, rows] : [rows];

  setStatus(key, '儲存中...');
  google.script.run
    .withSuccessHandler(safeHandler(saved => {
      clearDirtyPart_(key);
      panelDataCache_[panelCacheKey_(key, entityCacheScope_(cfg))] = saved;
      entityRows[key] = (saved || []).map(r => Object.assign({}, r, { __existing: true }));
      drawEntityGrid(key);
      setStatus(key, '已儲存', 'ok');
      afterEntityChange(key);
    }))
    .withFailureHandler(err => setStatus(key, '錯誤：' + err.message, 'err'))
    [cfg.saveGridFn](...args);
}

/** 新增車型：同時決定這個車型的科目表從哪裡開始(標準範本，或複製某個既有車型) */
function createVehicleTypeDialog() {
  const others = (entityRows.vehicletypes || []).filter(r => r.__existing).map(r => r.VehicleTypeID);
  openModal({
    title: '新增車型',
    body: '<p class="help">科目表會依每個車型各自一份。可以從標準範本開始，或複製一個科目結構比較接近的既有車型，之後再到「科目與公式」調整。</p>',
    fields: [
      { name: 'id', label: '車型代號', placeholder: '例：K5' },
      { name: 'notes', label: '備註', placeholder: '選填' },
      { name: 'source', label: '科目表從哪裡開始', type: 'select', value: '',
        options: [['', '標準範本']].concat(others.map(id => [id, '複製「' + id + '」的科目表'])) }
    ],
    okText: '建立',
    validate: v => !v.id.trim() ? '請輸入車型代號' : ''
  }).then(v => {
    if (!v) return;
    google.script.run
      .withSuccessHandler(safeHandler(types => {
        Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
        toast('已建立車型 ' + v.id.trim(), 'ok');
        entityRows.vehicletypes = (types || []).map(r => Object.assign({}, r, { __existing: true }));
        drawEntityGrid('vehicletypes');
        currentVehicleTypeId = v.id.trim();
        loadVehicleTypeSelector(currentVehicleTypeId);
      }))
      .withFailureHandler(err => toast(err.message, 'err'))
      .createVehicleType(v.id.trim(), v.notes, v.source);
  });
}

/** 車型/情境改動後，上方的選單也要跟著更新（但不要重畫目前這個分頁） */
function afterEntityChange(key) {
  if (key === 'vehicletypes') refreshVehicleTypeOptions();
  if (key === 'scenarios') refreshScenarioOptions();
}

function refreshVehicleTypeOptions() {
  google.script.run.withSuccessHandler(safeHandler(types => {
    renderVehicleTypeOptions(types || [], currentVehicleTypeId);
  })).getVehicleTypes();
}

function refreshScenarioOptions(preferredId) {
  google.script.run.withSuccessHandler(safeHandler(scenarios => {
    renderScenarioOptions(scenarios, preferredId);
  })).getScenarios(currentVehicleTypeId);
}

/* ---- 情境：以既有情境為基礎建立 / 把既有情境的資料帶進目前情境 ----
 * 平常用不到的表單不佔畫面：兩顆按鈕，按了才跳出對話框(要帶入哪些資料的勾選也在對話框裡)。 */
function scenarioToolbarHtml() {
  const hasOthers = (entityRows.scenarios || []).some(s => s.__existing);
  return `<button type="button" class="btn" onclick="createScenarioDialog()">＋ 新增情境…</button>
    <button type="button" class="btn secondary" onclick="importIntoCurrentScenarioDialog()"${hasOthers && currentScenarioId ? '' : ' disabled'}
      data-tip="把另一個情境的資料(可勾選類別)複製進右上角目前選的情境">帶入目前情境…</button>`;
}
function scenarioSourceOptions_(excludeId) {
  return (entityRows.scenarios || []).filter(s => s.__existing && s.ScenarioID !== excludeId).map(s => [s.ScenarioID, scenarioLabel(s)]);
}
const COPY_PARTS_FIELD_ = () => ({ name: 'parts', label: '要帶入的資料', type: 'checks',
  options: SCENARIO_COPY_PARTS.map(p => [p.key, p.label]), value: SCENARIO_COPY_PARTS.map(p => p.key) });

function createScenarioDialog() {
  const autoName = type => type + dateToMMDD_(today());
  let lastAuto = autoName(SCENARIO_TYPES[0]);
  const done = openModal({
    title: '新增情境',
    fields: [
      { name: 'gate', label: 'GATE 別', type: 'select', options: GATE_OPTIONS, value: GATE_OPTIONS[0] },
      { name: 'type', label: '情境性質', type: 'select', options: SCENARIO_TYPES, value: SCENARIO_TYPES[0] },
      { name: 'name', label: '情境名稱', value: lastAuto, placeholder: '例：現況0901' },
      { name: 'source', label: '以既有情境為基礎', type: 'select', options: [['', '(不帶入，建立空白情境)']].concat(scenarioSourceOptions_('')), value: '' },
      Object.assign(COPY_PARTS_FIELD_(), { help: '有選「以既有情境為基礎」時才會帶入' })
    ],
    okText: '建立情境',
    validate: v => !v.name.trim() ? '請輸入情境名稱' : (v.source && !v.parts.length ? '請至少勾選一項要帶入的資料，或把來源改成「不帶入」' : '')
  });
  // 情境名稱還是自動帶入的值時，改情境性質就跟著換(現況0901 → 目標0901)
  const dlg = document.querySelector('dialog.modal:last-of-type');
  const typeEl = dlg && dlg.querySelector('#mf-1'), nameEl = dlg && dlg.querySelector('#mf-2');
  if (typeEl && nameEl) typeEl.addEventListener('change', () => {
    if (!nameEl.value || nameEl.value === lastAuto) { lastAuto = autoName(typeEl.value); nameEl.value = lastAuto; }
  });
  done.then(v => {
    if (!v) return;
    setStatus('scenarios', '建立中...');
    google.script.run
      .withSuccessHandler(safeHandler(saved => {
        pendingStatus = { key: 'scenarios', text: v.source ? '已建立情境，並帶入來源情境的資料' : '已建立情境', cls: 'ok' };
        loadEntityData('scenarios');
        refreshScenarioOptions(saved && saved.ScenarioID);
      }))
      .withFailureHandler(err => setStatus('scenarios', '錯誤：' + err.message, 'err'))
      .createScenarioFrom({
        ScenarioID: '', Gate: v.gate, ScenarioName: v.name.trim(), ScenarioType: v.type,
        VehicleTypeID: currentVehicleTypeId, CreatedDate: today(), Notes: ''
      }, v.source, v.source ? v.parts : []);
  });
}

function importIntoCurrentScenarioDialog() {
  if (!currentScenarioId) { toast('請先在右上角選擇要帶入的目標情境', 'warn'); return; }
  const sources = scenarioSourceOptions_(currentScenarioId);
  if (!sources.length) { toast('這個車型沒有其他情境可以帶入', 'warn'); return; }
  openModal({
    title: '帶入目前情境：' + (currentScenario ? scenarioLabel(currentScenario) : ''),
    body: '<p class="help">會先清掉目前情境所勾選類別的資料，再整批複製來源情境的內容（開發總投的挑戰低減目標會清空，請重新填寫）。</p>',
    fields: [
      { name: 'source', label: '來源情境', type: 'select', options: sources, value: sources[0][0] },
      COPY_PARTS_FIELD_()
    ],
    okText: '帶入', danger: true,
    validate: v => !v.parts.length ? '請至少勾選一項要帶入的資料' : ''
  }).then(v => {
    if (!v) return;
    setStatus('scenarios', '帶入中...');
    google.script.run
      .withSuccessHandler(safeHandler(() => {
        Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
        setStatus('scenarios', '已帶入來源情境的資料（開發總投的挑戰低減目標已清空，請重新填寫）', 'ok');
      }))
      .withFailureHandler(err => setStatus('scenarios', '錯誤：' + err.message, 'err'))
      .copyScenarioData(v.source, currentScenarioId, v.parts);
  });
}

function today() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
