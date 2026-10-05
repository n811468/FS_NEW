/* ================= 銷售構成（依車系自動列出，台數/構成比動態連動） ================= */
let salesMixRows = [];

function renderSalesMixPanel() {
  if (!requireScope('salesmix', true)) return;
  const panel = document.getElementById('panel-salesmix');
  panel.innerHTML = gridShell('salesmix', '銷售構成與售價',
    '每個車系一列。<b>台數與構成比會自動互相連動</b>：改台數 → 構成比重算；改構成比 → 依車型月總台數反推台數。售價欄位是售價結構(P1~P9)公式的來源。');
  const cacheKey = panelCacheKey_('salesmix');
  if (panelDataCache_[cacheKey]) { salesMixRows = panelDataCache_[cacheKey].rows || []; drawSalesMixGrid(); }
  google.script.run
    .withSuccessHandler(safeHandler(data => {
      panelDataCache_[cacheKey] = data;
      if (isDirty_()) return;
      salesMixRows = data.rows || [];
      drawSalesMixGrid();
    }))
    .withFailureHandler(showGlobalError)
    .getSalesMixGrid(currentScenarioId, currentVehicleTypeId);
}

function drawSalesMixGrid() {
  const grid = document.getElementById('grid-salesmix');
  if (!salesMixRows.length) {
    document.getElementById('toolbar-salesmix').innerHTML = '';
    grid.innerHTML = emptyStateHtml('📋', '這個車型還沒有車系', '銷售構成依車系逐列輸入，請先建立車系。', `<button class="btn" onclick="switchTab('masters')">前往車型與情境</button>`);
    return;
  }
  const totalUnits = salesMixRows.reduce((s, r) => s + num(r.MonthlyVolume), 0);

  document.getElementById('toolbar-salesmix').innerHTML = `
    <label>車型月總台數
      <input id="sm-total" type="number" step="any" style="width:120px;" value="${totalUnits || ''}"
             oninput="onSalesMixTotalInput()">
    </label>
    <span class="muted" style="align-self:flex-end;padding-bottom:8px;">LIFE CYCLE 總台數 = 月台數 × 12 × LC年限</span>
    <span class="spacer"></span>
    <button type="button" class="btn secondary" onclick="saveSalesMixGrid()">儲存</button>
  `;

  grid.innerHTML = `
    <div class="grid-scroll">
    <table class="grid-table sticky-head-col">
      <thead><tr>
        <th>車系</th><th>構成比%</th><th>月台數</th><th>LC年限</th><th>LC總台數</th>
        <th>建議零售價<br>(含稅)</th><th>強配件<br>售價</th><th>廢車<br>處理費</th><th>稅別</th>
        <th title="計算貨物稅完稅價格時，從廠價扣除這個金額">水平配件外移<br>調降廠價</th>
        <th>備註</th>
      </tr></thead>
      <tbody>
        ${salesMixRows.map((r, i) => `
          <tr>
            <td class="row-head">${esc(r.VehicleID)}${r.VehicleCode ? ' - ' + esc(r.VehicleCode) : ''}</td>
            <td><input type="number" step="any" value="${esc(r.SalesMixPct)}" oninput="onSalesMixPctInput(${i}, this.value)"></td>
            <td><input type="number" step="any" value="${esc(r.MonthlyVolume)}" oninput="onSalesMixVolumeInput(${i}, this.value)"></td>
            <td><input type="number" step="any" value="${esc(r.LifeCycleYears)}" oninput="onSalesMixField(${i}, 'LifeCycleYears', this.value)"></td>
            <td class="calc" id="sm-lc-${i}">${fmt(num(r.MonthlyVolume) * 12 * num(r.LifeCycleYears))}</td>
            <td><input type="number" step="any" value="${esc(r.ListPriceTaxIncl)}" oninput="onSalesMixField(${i}, 'ListPriceTaxIncl', this.value)"></td>
            <td><input type="number" step="any" value="${esc(r.MandatoryAccessoryPrice)}" oninput="onSalesMixField(${i}, 'MandatoryAccessoryPrice', this.value)"></td>
            <td><input type="number" step="any" value="${esc(r.ScrapFee)}" oninput="onSalesMixField(${i}, 'ScrapFee', this.value)"></td>
            <td><select onchange="onSalesMixField(${i}, 'ScrapFeeTaxStatus', this.value)">
              ${['含稅', '未稅'].map(o => `<option value="${o}"${r.ScrapFeeTaxStatus === o ? ' selected' : ''}>${o}</option>`).join('')}
            </select></td>
            <td><input type="number" step="any" value="${esc(r.HorizontalPartsPriceAdj)}" oninput="onSalesMixField(${i}, 'HorizontalPartsPriceAdj', this.value)"></td>
            <td><input type="text" class="note-input" value="${esc(r.Notes)}" oninput="onSalesMixField(${i}, 'Notes', this.value)"></td>
          </tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <td class="row-head">合計</td>
        <td id="sm-sum-pct" class="calc"></td>
        <td id="sm-sum-units" class="calc"></td>
        <td></td><td id="sm-sum-lc" class="calc"></td>
        <td colspan="6"></td>
      </tr></tfoot>
    </table>
    </div>`;
  updateSalesMixTotals();
}

function smDirty_() { markDirty('salesmix', saveSalesMixGrid, () => { clearDirty(); renderSalesMixPanel(); }); }
function onSalesMixField(i, field, value) { salesMixRows[i][field] = value; updateSalesMixTotals(); smDirty_(); }

/** 改台數：總台數 = 各車系台數加總，所有構成比依台數重算 */
function onSalesMixVolumeInput(i, value) {
  salesMixRows[i].MonthlyVolume = value === '' ? '' : num(value);
  smDirty_();
  const total = salesMixRows.reduce((s, r) => s + num(r.MonthlyVolume), 0);
  salesMixRows.forEach(r => { r.SalesMixPct = total > 0 ? round2(num(r.MonthlyVolume) / total * 100) : ''; });
  document.getElementById('sm-total').value = total || '';
  syncSalesMixInputs({ skipVolumeIndex: i });
}

/** 改構成比：以車型月總台數為基準反推該車系台數，其餘車系的構成比再依台數回算 */
function onSalesMixPctInput(i, value) {
  salesMixRows[i].SalesMixPct = value === '' ? '' : num(value);
  smDirty_();
  const total = num(val('sm-total'));
  if (total > 0) {
    // 台數保留小數：構成比 5% × 365 台 = 18.25 台，四捨五入會讓構成比對不回去
    salesMixRows[i].MonthlyVolume = round2(num(value) / 100 * total);
  }
  syncSalesMixInputs({ skipPctIndex: i });
}

/** 改車型月總台數：各車系依目前構成比重新分配台數 */
function onSalesMixTotalInput() {
  smDirty_();
  const total = num(val('sm-total'));
  if (total > 0) {
    salesMixRows.forEach(r => { r.MonthlyVolume = round2(num(r.SalesMixPct) / 100 * total); });
  }
  syncSalesMixInputs({});
}

function round2(n) { return Math.round(n * 100) / 100; }

/** 把 salesMixRows 的值寫回輸入框（跳過使用者正在輸入的那一格，避免游標跳動） */
function syncSalesMixInputs(opts) {
  const rows = document.querySelectorAll('#grid-salesmix tbody tr');
  salesMixRows.forEach((r, i) => {
    const tr = rows[i];
    if (!tr) return;
    const pctInput = tr.children[1].querySelector('input');
    const volInput = tr.children[2].querySelector('input');
    if (opts.skipPctIndex !== i) pctInput.value = r.SalesMixPct === '' ? '' : r.SalesMixPct;
    if (opts.skipVolumeIndex !== i) volInput.value = r.MonthlyVolume === '' ? '' : r.MonthlyVolume;
  });
  updateSalesMixTotals();
}

function updateSalesMixTotals() {
  const sumPct = salesMixRows.reduce((s, r) => s + num(r.SalesMixPct), 0);
  const sumUnits = salesMixRows.reduce((s, r) => s + num(r.MonthlyVolume), 0);
  let sumLc = 0;
  salesMixRows.forEach((r, i) => {
    const lc = num(r.MonthlyVolume) * 12 * num(r.LifeCycleYears);
    sumLc += lc;
    const cell = document.getElementById('sm-lc-' + i);
    if (cell) cell.textContent = fmt(lc);
  });
  const pctCell = document.getElementById('sm-sum-pct');
  if (pctCell) {
    pctCell.textContent = fmt(sumPct, 2) + '%';
    // 構成比合計不是 100% 時標紅，避免加權平均被算錯還沒發現
    pctCell.className = 'calc' + (Math.abs(sumPct - 100) > 0.01 && sumPct !== 0 ? ' negative' : '');
  }
  const unitCell = document.getElementById('sm-sum-units');
  if (unitCell) unitCell.textContent = fmt(sumUnits);
  const lcCell = document.getElementById('sm-sum-lc');
  if (lcCell) lcCell.textContent = fmt(sumLc);
}

function saveSalesMixGrid() {
  setStatus('salesmix', '儲存中...');
  google.script.run
    .withSuccessHandler(safeHandler(data => {
      clearDirty();
      panelDataCache_[panelCacheKey_('salesmix')] = data;
      salesMixRows = data.rows || [];
      drawSalesMixGrid();
      setStatus('salesmix', '已儲存', 'ok');
    }))
    .withFailureHandler(err => setStatus('salesmix', '錯誤：' + err.message, 'err'))
    .saveSalesMixGrid(currentScenarioId, currentVehicleTypeId, salesMixRows);
}

/* ================= 金額矩陣（銷貨成本 / 營業費用共用） ================= */
const MATRIX_CONFIG = {
  costofsales: {
    title: '銷貨成本',
    getFn: 'getCostOfSalesMatrix', saveFn: 'saveCostOfSalesMatrix',
    parentLine: 'B', hasCurrency: true, totalLabel: '手動輸入合計',
    intro: '列 = 成本項目、欄 = 車系，每格填單台金額。<b>計算來源是「手動輸入」的科目</b>才會出現在上半部；公式或開發總投攤提的科目列在下方唯讀，滑鼠移到金額上可以看計算過程。「報告說明」欄會直接印在 GATE 報告的「說明」欄。'
  },
  operatingexpense: {
    title: '營業費用',
    getFn: 'getOperatingExpenseMatrix', saveFn: 'saveOperatingExpenseMatrix',
    parentLine: 'E', hasCurrency: false, totalLabel: '手動輸入合計',
    parentOptions: [['E', '銷售費用(銷貨毛利前)'], ['G', '產品貢獻前費用'], ['I', '固定營業費用']],
    intro: '銷售費用、產品貢獻前費用、固定營業費用、前瞻費用的單台金額。季Margin、開發費用攤提等由公式或開發總投算出，列在下方唯讀。「報告說明」欄會直接印在 GATE 報告的「說明」欄。'
  }
};

let matrixData = {};   // key -> {lines, vehicles, values, currencies, lineNotes, autoLines...}

/**
 * 成本與費用：銷貨成本、營業費用兩張表用同一個元件，放在同一頁用子頁籤切換(以前是兩個分頁)。
 * 目前在哪個子頁籤記在瀏覽器裡。
 */
const COSTS_VIEW_KEY_ = 'plCosts.view.v1';
let costsView = (() => { try { const v = localStorage.getItem(COSTS_VIEW_KEY_); return v === 'operatingexpense' ? v : 'costofsales'; } catch (e) { return 'costofsales'; } })();
function renderCostsPanel() {
  const panel = document.getElementById('panel-costs');
  if (!panel || !requireScope('costs', true)) return;
  panel.innerHTML = `<div class="dash-subnav">${Object.keys(MATRIX_CONFIG).map(k =>
      `<button type="button" class="dash-subnav-btn${costsView === k ? ' active' : ''}" onclick="setCostsView('${k}')">${esc(MATRIX_CONFIG[k].title)}</button>`).join('')}</div>
    <div id="costs-body"></div>`;
  renderMatrixPanel(costsView);
}
function setCostsView(key) {
  if (key === costsView) return;
  const go = () => {
    clearDirty();
    costsView = key;
    try { localStorage.setItem(COSTS_VIEW_KEY_, key); } catch (e) { /* 存不了就算了 */ }
    renderCostsPanel();
  };
  if (isDirty_()) confirmLeave_().then(ok => { if (ok) go(); }); else go();
}

function renderMatrixPanel(key) {
  const cfg = MATRIX_CONFIG[key];
  const body = document.getElementById('costs-body');
  if (!body) return;
  body.innerHTML = gridShell(key, cfg.title, cfg.intro);
  const cacheKey = panelCacheKey_(key);
  if (panelDataCache_[cacheKey]) { matrixData[key] = panelDataCache_[cacheKey]; drawMatrix(key); }
  google.script.run
    .withSuccessHandler(safeHandler(data => {
      panelDataCache_[cacheKey] = data;
      if (isDirty_()) return;
      matrixData[key] = data; drawMatrix(key);
    }))
    .withFailureHandler(showGlobalError)
    [cfg.getFn](currentScenarioId, currentVehicleTypeId);
}

/** 公式/攤提的計算過程文字(hover 用)：公式換成看得懂的名稱，再列出每個引用到的值 */
function traceText_(trace, codeNameMap) {
  if (!trace) return '';
  if (trace.kind === 'dev') {
    return `開發總投攤提\n投資總額(低減後) ${fmt(trace.total)} ÷ 攤提台數 ${fmt(trace.units)}\n= 全車系分攤 ${fmt(trace.total && trace.units ? trace.total / trace.units : 0)}\n本車系合計 ${fmt(trace.perUnit)}（含只攤給部分車系的金額）`;
  }
  const lines = ['= ' + humanizeFormula_(trace.formula, codeNameMap)];
  Object.keys(trace.refs || {}).forEach(k => {
    let label = k;
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) label = codeNameMap[k] ? `${codeNameMap[k]}(${k})` : k;
    else if (k === 'CHILDREN()') label = 'Σ子科目';
    else if (k === 'TAXDEDUCT()') label = 'Σ可扣除貨物稅的科目';
    lines.push(`${label}：${fmt(trace.refs[k], 4)}`);
  });
  return lines.join('\n');
}

function drawMatrix(key) {
  const cfg = MATRIX_CONFIG[key];
  const data = matrixData[key];
  const grid = document.getElementById('grid-' + key);
  if (!grid) return;

  const parentSelect = cfg.parentOptions
    ? `<select id="${key}-new-parent">${cfg.parentOptions.map(o => `<option value="${o[0]}">${o[1]}</option>`).join('')}</select>`
    : '';
  document.getElementById('toolbar-' + key).innerHTML = `
    ${parentSelect}
    <input id="${key}-new-name" type="text" placeholder="新增項目名稱" style="width:180px;"
      onkeydown="if(event.key==='Enter'){addMatrixLine('${key}')}">
    <button type="button" class="btn secondary" onclick="addMatrixLine('${key}')">＋ 新增項目</button>
    <button type="button" class="btn secondary" onclick="importMatrixDialog('${key}')" data-tip="把 Excel 上的整張表(含科目名稱、車系標題)複製過來，依名稱自動對應">從 Excel 貼上整張表…</button>
    <span class="spacer"></span>
    <button type="button" class="btn ghost" onclick="switchTab('lineitems')" data-tip="改科目的計算來源/公式、調整科目順序">科目與公式 →</button>
    <button type="button" class="btn secondary" onclick="saveMatrix('${key}')">儲存</button>
  `;

  if (!data.vehicles.length) {
    grid.innerHTML = emptyStateHtml('📋', '這個車型還沒有車系', '請先到「車型與情境」建立車系。', `<button class="btn" onclick="switchTab('masters')">前往車型與情境</button>`);
    return;
  }
  const codeNameMap = {};
  data.lines.concat(data.autoLines || []).forEach(l => { codeNameMap[l.value] = matrixLineName(l); });

  const currencyCell = line => {
    if (!cfg.hasCurrency) return '';
    const cur = firstCellProp(data, line.value, 'Currency') || 'TWD';
    const opts = (data.currencies || ['TWD']).slice();
    if (opts.indexOf(cur) === -1) opts.push(cur);
    return `<td><select id="${key}-cur-${esc(line.value)}" onchange="matrixDirty_('${key}')">
      ${opts.map(c => `<option value="${c}"${c === cur ? ' selected' : ''}>${c}</option>`).join('')}
    </select></td>`;
  };
  const noteOf = code => (data.lineNotes && data.lineNotes[code] !== undefined) ? data.lineNotes[code] : firstCellProp(data, code, 'Notes');

  const mixTotal = data.vehicles.reduce((sum, v) => sum + num(v.SalesMixPct), 0);
  grid.innerHTML = `
    ${mixTotal ? '' : '<div class="callout warn">這個情境還沒有銷售構成比，加權平均無法計算，請先到「銷售構成」頁填構成比。</div>'}
    <div class="grid-scroll">
    <table class="grid-table sticky-head-col">
      <thead><tr>
        <th>項目</th>
        ${cfg.hasCurrency ? '<th>幣別</th>' : ''}
        ${data.vehicles.map(v => `<th>${esc(v.VehicleCode || v.VehicleID)}<div class="th-sub">構成比 ${fmt(num(v.SalesMixPct), 1)}%</div></th>`).join('')}
        <th>加權平均</th><th data-tip="這個情境的說明，會印在 GATE 報告的「說明」欄（在報告上改也是同一份）">報告說明</th><th></th>
      </tr></thead>
      <tbody>
        ${data.lines.length ? '' : `<tr><td colspan="${data.vehicles.length + 5}" class="muted" style="text-align:center;padding:18px;">還沒有手動輸入的項目，用上方「新增項目」新增</td></tr>`}
        ${data.lines.map(line => `
          <tr data-line="${esc(line.value)}">
            <td class="row-head">${esc(matrixLineName(line))}</td>
            ${currencyCell(line)}
            ${data.vehicles.map(v => {
              const cell = (data.values[line.value] || {})[v.VehicleID] || {};
              return `<td><input type="number" step="any" value="${esc(cell.Amount)}"
                data-line="${esc(line.value)}" data-vehicle="${esc(v.VehicleID)}" data-rowid="${esc(cell.RowID)}"
                oninput="updateMatrixTotals('${key}'); matrixDirty_('${key}')"></td>`;
            }).join('')}
            <td class="calc" id="${key}-sum-${esc(line.value)}"></td>
            <td><input type="text" class="note-input wide" id="${key}-note-${esc(line.value)}" value="${esc(noteOf(line.value))}"
              oninput="matrixDirty_('${key}')" placeholder="例：依業務部提供"></td>
            <td class="row-actions"><button type="button" class="btn ghost sm" onclick="deleteMatrixLine('${key}', '${esc(line.value)}')" data-tip="刪除這個項目">✕</button></td>
          </tr>`).join('')}
        ${(data.autoLines || []).length ? `<tr><td class="row-head" colspan="${data.vehicles.length + (cfg.hasCurrency ? 5 : 4)}"
            style="background:var(--surface-3);font-size:12px;color:var(--text-2);">由公式或開發總投算出（唯讀，要改算法請到「科目與公式」）</td></tr>` : ''}
        ${(data.autoLines || []).map(line => `
          <tr class="auto-line" data-line="${esc(line.value)}">
            <td class="row-head">${esc(matrixLineName(line))} <span class="ct-badge ct-${esc(line.calcType)}">${line.calcType === 'DEV_AMORT' ? '攤提' : '公式'}</span></td>
            ${cfg.hasCurrency ? '<td></td>' : ''}
            ${data.vehicles.map(v => autoLineCellHtml(data, line.value, v.VehicleID, codeNameMap)).join('')}
            <td class="calc muted">—</td><td class="muted" style="text-align:left;">${line.formula ? `<code style="font-size:11px;">${esc(humanizeFormula_(line.formula, codeNameMap))}</code>` : ''}</td><td></td>
          </tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <td class="row-head">${esc(cfg.totalLabel)}</td>
        ${cfg.hasCurrency ? '<td></td>' : ''}
        ${data.vehicles.map(v => `<td class="calc" id="${key}-colsum-${esc(v.VehicleID)}"></td>`).join('')}
        <td class="calc" id="${key}-grandsum"></td><td colspan="2"></td>
      </tr>
      ${(data.autoLines || []).length ? `<tr>
        <td class="row-head">合計(含公式/攤提)</td>
        ${cfg.hasCurrency ? '<td></td>' : ''}
        ${data.vehicles.map(v => `<td class="calc" id="${key}-colsum-withauto-${esc(v.VehicleID)}"></td>`).join('')}
        <td colspan="3"></td>
      </tr>` : ''}</tfoot>
    </table>
    </div>
    <p class="muted">加權平均 = 依各車系銷售構成比加權，跟儀表板同口徑。</p>`;
  updateMatrixTotals(key);
}
/**
 * 從 Excel 貼上整張表：第一欄是科目名稱、有一列是車系名稱(標題)，依名稱自動對應，順序不用一樣。
 * 沒有標題列時，數字欄位依序對到畫面上的車系。對不到的科目可以選擇自動新增。
 */
function importMatrixDialog(key) {
  if (isDirty_()) { toast('先儲存目前的修改再匯入', 'warn'); return; }
  const data = matrixData[key];
  const cfg = MATRIX_CONFIG[key];
  openModal({
    title: '從 Excel 貼上整張表（' + cfg.title + '）', wide: true,
    body: `<p class="help">在 Excel 選取「科目名稱那一欄 + 各車系的金額」(標題列可以一起選)，複製後貼在下面。<br>
      科目依名稱對應（空白、全形半形括號不影響）；車系依標題列的名稱對應，沒有標題列就依畫面上的車系順序：
      ${data.vehicles.map(v => esc(v.VehicleCode || v.VehicleID)).join('、')}。</p>`,
    fields: [{ name: 'text', label: '貼上', type: 'textarea', placeholder: '科目 → 標準型 → 豪華型 …（直接從 Excel 複製貼上）' }],
    okText: '下一步：檢查對應'
  }).then(v => {
    if (!v || !v.text.trim()) return;
    const parsed = parseMatrixPaste_(v.text, data.vehicles);
    if (!parsed.rows.length) { toast('沒有讀到任何「科目名稱 + 金額」的列', 'err'); return; }
    const known = new Set(data.lines.map(l => normalizeNameKey_(matrixLineName(l))));
    const auto = new Set((data.autoLines || []).map(l => normalizeNameKey_(l.label)));
    const isNew = r => !known.has(normalizeNameKey_(r.name)) && !auto.has(normalizeNameKey_(r.name));
    const newOnes = parsed.rows.filter(isNew);
    const vehicleName = id => { const x = data.vehicles.find(v2 => v2.VehicleID === id); return x ? (x.VehicleCode || id) : id; };
    const body = `
      <p>欄位對應：${parsed.columns.map(c => `<b>${esc(c.header || ('第 ' + (c.index + 1) + ' 欄'))}</b> → ${esc(vehicleName(c.vehicleId))}`).join('、')}
        ${parsed.byHeader ? '' : '<br><span class="negative">沒有找到車系標題列，依畫面上的車系順序對應，請確認。</span>'}</p>
      <div class="grid-scroll" style="max-height:260px;"><table class="grid-table"><thead><tr><th>科目</th>${parsed.columns.map(c => `<th>${esc(vehicleName(c.vehicleId))}</th>`).join('')}<th></th></tr></thead>
        <tbody>${parsed.rows.map(r => `<tr><td class="row-head">${esc(r.name)}</td>${parsed.columns.map(c => `<td class="calc">${r.values[c.vehicleId] === undefined ? '' : fmt(r.values[c.vehicleId], 2)}</td>`).join('')}
          <td>${auto.has(normalizeNameKey_(r.name)) ? '<span class="muted">公式/攤提，略過</span>' : isNew(r) ? '<span class="auto-tag">新科目</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
      ${newOnes.length ? `<p style="margin-top:10px;">有 ${newOnes.length} 個科目在 ${esc(currentVehicleTypeId)} 的科目表裡找不到：${newOnes.map(r => esc(r.name)).join('、')}</p>` : ''}`;
    const fields = newOnes.length ? [
      { name: 'create', label: '找不到的科目', type: 'select', value: 'yes', options: [['yes', '自動新增成手動輸入科目'], ['no', '略過，不匯入']] }
    ].concat(cfg.parentOptions ? [{ name: 'parent', label: '新科目放在哪一段', type: 'select', options: cfg.parentOptions }] : []) : [];
    return openModal({ title: '確認匯入', wide: true, body, fields, okText: `匯入 ${parsed.rows.length} 個科目` }).then(c => {
      if (!c) return;
      google.script.run
        .withSuccessHandler(safeHandler(rep => {
          Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
          const msg = [`已填入 ${rep.updated} 格`];
          if (rep.created.length) msg.push(`新增科目：${rep.created.join('、')}`);
          if (rep.skipped.length) msg.push(`略過：${rep.skipped.map(x => x.name + '（' + x.reason + '）').join('、')}`);
          if (rep.unmatched.length) msg.push(`沒有匯入：${rep.unmatched.join('、')}`);
          toast(msg.join('\n'), rep.skipped.length || rep.unmatched.length ? 'warn' : 'ok', 7000);
          renderMatrixPanel(key);
        }))
        .withFailureHandler(err => toast(err.message, 'err'))
        .importMatrixRows(currentScenarioId, currentVehicleTypeId, key === 'costofsales' ? 'cost' : 'opex', parsed.rows,
          c === true ? false : c.create === 'yes', c === true ? '' : (c.parent || ''));
    });
  });
}
function normalizeNameKey_(s) {
  return String(s || '').replace(/（/g, '(').replace(/）/g, ')').replace(/[－—–]/g, '-').replace(/\s+/g, '').toLowerCase();
}
/** 解析貼上的整張表：找車系標題列、每一列的第一個文字當科目名稱、數字依欄位對到車系 */
function parseMatrixPaste_(text, vehicles) {
  const grid = parseClipboardGrid_(text);
  const keyOf = v => [normalizeNameKey_(v.VehicleCode), normalizeNameKey_(v.VehicleID)];
  let headerRow = -1, colMap = {};
  grid.forEach((cells, ri) => {
    if (headerRow !== -1) return;
    const map = {};
    cells.forEach((c, ci) => {
      const k = normalizeNameKey_(c);
      if (!k) return;
      const v = vehicles.find(x => keyOf(x).indexOf(k) !== -1);
      if (v && !Object.values(map).includes(v.VehicleID)) map[ci] = v.VehicleID;
    });
    if (Object.keys(map).length) { headerRow = ri; colMap = map; }
  });
  const rows = [];
  let positional = null;
  grid.forEach((cells, ri) => {
    if (ri === headerRow) return;
    const nameIdx = cells.findIndex(c => String(c).trim() && parsePastedNumber_(c) === null);
    if (nameIdx === -1) return;
    const values = {};
    if (headerRow !== -1) {
      Object.keys(colMap).forEach(ci => { const n = parsePastedNumber_(cells[ci]); if (n !== null && n !== '') values[colMap[ci]] = n; });
    } else {
      const nums = [];
      cells.forEach((c, ci) => { if (ci > nameIdx) { const n = parsePastedNumber_(c); if (n !== null && n !== '') nums.push({ ci, n }); } });
      if (!positional && nums.length) positional = nums.map(x => x.ci);
      nums.forEach((x, i) => { if (vehicles[i]) values[vehicles[i].VehicleID] = x.n; });
    }
    if (Object.keys(values).length) rows.push({ name: String(cells[nameIdx]).trim(), values });
  });
  const columns = headerRow !== -1
    ? Object.keys(colMap).map(ci => ({ index: Number(ci), header: grid[headerRow][ci], vehicleId: colMap[ci] }))
    : vehicles.slice(0, (positional || []).length).map((v, i) => ({ index: positional[i], header: '', vehicleId: v.VehicleID }));
  return { rows, columns, byHeader: headerRow !== -1 };
}

function matrixDirty_(key) { markDirty(key, () => saveMatrix(key), () => { clearDirty(); renderMatrixPanel(key); }); }

/** 公式/攤提科目的格子：唯讀，滑鼠移過去看計算過程 */
function autoLineCellHtml(data, lineCode, vehicleId, codeNameMap) {
  const amt = (data.autoValues[lineCode] || {})[vehicleId];
  if (amt === undefined) return '<td class="calc muted">—</td>';
  const trace = ((data.autoTraces || {})[lineCode] || {})[vehicleId];
  const err = ((data.autoErrors || {})[lineCode] || {})[vehicleId];
  const tipText = (err ? '⚠ 公式錯誤：' + err + '\n' : '') + traceText_(trace, codeNameMap || {});
  const tip = tipText ? ` tabindex="0" data-tip="${esc(tipText)}"` : '';
  return `<td class="calc${err ? ' negative' : ''}"${tip}>${err ? '⚠ ' : ''}${fmt(amt)}</td>`;
}

/** 同一列(科目)的幣別/備註是列層級設定，讀取時取該列第一個有值的格子 */
function firstCellProp(data, lineCode, prop) {
  const row = data.values[lineCode] || {};
  const key = Object.keys(row).filter(k => row[k] && row[k][prop])[0];
  return key ? row[key][prop] : '';
}

/**
 * 右邊那一欄是「加權平均」而不是合計：一列是同一個成本項目在各車系的單台金額，相加沒有意義。
 * 表尾則是各車系自己的科目合計（同一車系各科目相加是有意義的）。
 */
function updateMatrixTotals(key) {
  const data = matrixData[key];
  const mix = {};
  let mixTotal = 0;
  data.vehicles.forEach(v => { mix[v.VehicleID] = num(v.SalesMixPct); mixTotal += num(v.SalesMixPct); });

  const colSum = {};
  let weightedGrand = 0;
  data.lines.forEach(line => {
    let weighted = 0;
    document.querySelectorAll(`#grid-${key} input[data-line="${line.value}"]`).forEach(inp => {
      const v = num(inp.value);
      colSum[inp.dataset.vehicle] = (colSum[inp.dataset.vehicle] || 0) + v;
      weighted += v * (mix[inp.dataset.vehicle] || 0);
    });
    weighted = mixTotal ? weighted / mixTotal : 0;
    weightedGrand += weighted;
    const cell = document.getElementById(`${key}-sum-${line.value}`);
    if (cell) cell.textContent = mixTotal ? fmt(weighted) : '—';
  });

  const autoSum = {};
  (data.autoLines || []).forEach(line => {
    data.vehicles.forEach(v => {
      const amt = (data.autoValues[line.value] || {})[v.VehicleID];
      if (amt !== undefined) autoSum[v.VehicleID] = (autoSum[v.VehicleID] || 0) + amt;
    });
  });

  data.vehicles.forEach(v => {
    const cell = document.getElementById(`${key}-colsum-${v.VehicleID}`);
    if (cell) cell.textContent = fmt(colSum[v.VehicleID] || 0);
    const withAutoCell = document.getElementById(`${key}-colsum-withauto-${v.VehicleID}`);
    if (withAutoCell) withAutoCell.textContent = fmt((colSum[v.VehicleID] || 0) + (autoSum[v.VehicleID] || 0));
  });
  const g = document.getElementById(`${key}-grandsum`);
  if (g) g.textContent = mixTotal ? fmt(weightedGrand) : '—';
}

function saveMatrix(key) {
  const cfg = MATRIX_CONFIG[key];
  const cells = [], lineNotes = {};
  document.querySelectorAll(`#grid-${key} input[data-line]`).forEach(inp => {
    const line = inp.dataset.line;
    const cell = {
      RowID: inp.dataset.rowid || '',
      VehicleID: inp.dataset.vehicle,
      LineCode: line,
      Amount: inp.value === '' ? '' : num(inp.value),
      Notes: ''
    };
    if (cfg.hasCurrency) cell.Currency = val(`${key}-cur-${line}`) || 'TWD';
    cells.push(cell);
    lineNotes[line] = val(`${key}-note-${line}`);
  });

  setStatus(key, '儲存中...');
  google.script.run
    .withSuccessHandler(() => { clearDirty(); setStatus(key, '已儲存', 'ok'); renderMatrixPanel(key); })
    .withFailureHandler(err => setStatus(key, '錯誤：' + err.message, 'err'))
    [cfg.saveFn](currentScenarioId, cells, lineNotes);
}

function addMatrixLine(key) {
  const cfg = MATRIX_CONFIG[key];
  const name = val(`${key}-new-name`).trim();
  if (!name) { toast('請先輸入項目名稱', 'warn'); return; }
  const parent = cfg.parentOptions ? val(`${key}-new-parent`) : cfg.parentLine;
  const go = () => {
    setStatus(key, '新增中...');
    google.script.run
      .withSuccessHandler(() => { clearDirty(); delete panelDataCache_[panelCacheKey_('lineitems', 'vehicleType')]; setStatus(key, `已在 ${currentVehicleTypeId} 新增項目「${name}」`, 'ok'); renderMatrixPanel(key); })
      .withFailureHandler(err => setStatus(key, '錯誤：' + err.message, 'err'))
      .addLineItemInline(parent, name, currentVehicleTypeId);
  };
  if (isDirty_()) { toast('先儲存目前的修改再新增項目', 'warn'); return; }
  go();
}

function deleteMatrixLine(key, lineCode) {
  const line = (matrixData[key].lines || []).find(l => l.value === lineCode);
  confirmModal('刪除項目「' + (line ? matrixLineName(line) : lineCode) + '」？',
    `只會影響車型 <b>${esc(currentVehicleTypeId)}</b>：這個科目會從 ${esc(currentVehicleTypeId)} 的科目表移除，並清掉它在 ${esc(currentVehicleTypeId)} 所有情境已輸入的金額。其他車型不受影響。`,
    '刪除', true).then(ok => {
    if (!ok) return;
    setStatus(key, '刪除中...');
    google.script.run
      .withSuccessHandler(() => { clearDirty(); setStatus(key, '已刪除項目', 'ok'); renderMatrixPanel(key); })
      .withFailureHandler(err => setStatus(key, '錯誤：' + err.message, 'err'))
      .deleteLineItemInline(lineCode, currentVehicleTypeId);
  });
}

/* ================= 開發總投 ================= */
let devRows = [];
let devSummary = null;

function renderDevInvestmentPanel() {
  if (!requireScope('devinvestment', true)) return;
  document.getElementById('panel-devinvestment').innerHTML = gridShell('devinvestment', '開發總投',
    '每一列：部門 → 大類(設備/模具/費用) → 攤提落點科目。低減後金額 ÷ 攤提台數 = 單台攤提。' +
    '<b>「分攤車系」</b>可以讓某筆投資只攤給部分車系（例如某個式樣、某項法規認證只有部分車系要），其他車系不分攤。拖曳 ⠿ 調整列的順序。');

  const cacheKey = panelCacheKey_('devinvestment', 'scenario');
  if (panelDataCache_[cacheKey]) {
    devSummary = panelDataCache_[cacheKey];
    devRows = devSummary.rows.map(r => Object.assign({}, r));
    drawDevGrid();
  }
  google.script.run
    .withSuccessHandler(safeHandler(summary => {
      panelDataCache_[cacheKey] = summary;
      if (isDirty_()) return;
      devSummary = summary;
      devRows = summary.rows.map(r => Object.assign({}, r));
      drawDevGrid();
    }))
    .withFailureHandler(showGlobalError)
    .getDevInvestmentSummary(currentScenarioId);
}

function devDirty_() { markDirty('devinvestment', saveDevGrid, () => { clearDirty(); renderDevInvestmentPanel(); }); }

function vehicleScopeLabel_(scope) {
  const ids = String(scope || '').split(',').map(x => x.trim()).filter(x => x);
  if (!ids.length) return '全車系';
  const names = ids.map(id => { const v = (devSummary.vehicles || []).find(x => x.VehicleID === id); return v ? (v.VehicleCode || id) : id; });
  return names.join('、');
}

function drawDevGrid() {
  const isTarget = !devSummary.isBaseline;
  const toolbar = document.getElementById('toolbar-devinvestment');
  if (!toolbar) return;

  toolbar.innerHTML = `
    <button type="button" class="btn" onclick="addDevRow()">＋ 新增一列</button>
    <span class="toolbar-sep"></span>
    <label>攤提基準(台/月 × 12 × 年)
      <span style="display:flex;gap:6px;align-items:center;">
        <input id="dev-amort-vol" type="number" step="any" style="width:90px;" value="${esc(devSummary.amortMonthlyVolume)}" placeholder="台/月">
        ×12×<input id="dev-amort-years" type="number" step="any" style="width:70px;" value="${esc(devSummary.amortLifeCycleYears)}" placeholder="年">
        <button type="button" class="btn secondary sm" onclick="saveAmortBasis()">套用</button>
      </span>
    </label>
    <span class="spacer"></span>
    <button type="button" class="btn ghost" onclick="addDevAmortTarget()">＋ 新增攤提落點科目</button>
    <button type="button" class="btn secondary" onclick="saveDevGrid()">儲存</button>
  `;

  document.getElementById('grid-devinvestment').innerHTML = `
    <div class="grid-scroll">
    <table class="grid-table">
      <thead><tr>
        <th style="width:36px;"></th><th>部門</th><th>大類</th><th>攤提落點</th><th>分攤車系</th><th>金額</th><th>幣別</th>
        ${isTarget ? '<th>挑戰低減目標%</th><th>低減後金額</th>' : ''}
        <th>備註</th><th></th>
      </tr></thead>
      <tbody id="dev-body">
        ${devRows.length ? '' : `<tr><td colspan="${isTarget ? 11 : 9}" class="muted" style="text-align:center;padding:18px;">尚無開發總投資料，按「新增一列」開始</td></tr>`}
        ${devRows.map((r, i) => {
          const category = r.__category || devTargetCategoryOf(r.TargetLineCode);
          const targetOptions = (devSummary.targetOptions || []).filter(o => !category || o.category === category);
          const blank = !r.Department && (r.Amount === '' || r.Amount === undefined || r.Amount === null) && r.RowID;
          return `
          <tr data-key="${i}"${blank ? ' style="display:none;"' : ''}>
            <td class="row-actions">${dragHandleHtml()}</td>
            <td><input type="text" list="dev-departments" value="${esc(r.Department)}" oninput="onDevField(${i}, 'Department', this.value)"></td>
            <td><select onchange="onDevCategoryChange(${i}, this.value)">
              <option value="">(請選擇)</option>
              ${DEV_AMORT_CATEGORIES.map(c => `<option value="${c}"${category === c ? ' selected' : ''}>${c}</option>`).join('')}
            </select></td>
            <td><select onchange="onDevField(${i}, 'TargetLineCode', this.value)">
              <option value="">(請選擇)</option>
              ${targetOptions.map(o =>
                `<option value="${esc(o.value)}"${r.TargetLineCode === o.value ? ' selected' : ''}>${esc(shortLineName(o.label))}</option>`).join('')}
            </select></td>
            <td><button type="button" class="btn ghost sm" onclick="editDevScope(${i})" data-tip="點一下選擇這筆投資要攤給哪些車系">${esc(vehicleScopeLabel_(r.VehicleScope))} ▾</button></td>
            <td><input type="number" step="any" value="${esc(r.Amount)}" oninput="onDevField(${i}, 'Amount', this.value)"></td>
            <td><select onchange="onDevField(${i}, 'Currency', this.value)">
              ${(devSummary.currencies || ['TWD']).map(c => `<option value="${c}"${(r.Currency || 'TWD') === c ? ' selected' : ''}>${c}</option>`).join('')}
            </select></td>
            ${isTarget ? `
              <td><input type="number" step="any" id="dev-pct-${i}" value="${esc(r.ChallengeReductionPct)}" oninput="onDevPctInput(${i}, this.value)"></td>
              <td><input type="number" step="any" id="dev-reduced-${i}" value="${esc(devReducedAmount(r))}" oninput="onDevReducedInput(${i}, this.value)"></td>` : ''}
            <td><input type="text" class="note-input" value="${esc(r.Notes)}" oninput="onDevField(${i}, 'Notes', this.value)"></td>
            <td class="row-actions"><button type="button" class="btn ghost sm" onclick="removeDevRow(${i})" data-tip="刪除這一列">✕</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>
    <datalist id="dev-departments"></datalist>
    <div class="summary-box">
      <div><span class="muted">攤提用 LIFE CYCLE 總台數</span><strong>${fmt(devSummary.lifeCycleUnits)}</strong></div>
      <div><span class="muted">銷售構成推算台數</span><strong>${fmt(devSummary.salesMixLifeCycleUnits)}</strong></div>
    </div>
    <div class="card">
      <div class="card-head"><h4>攤提落點 → 單台攤提</h4><span class="muted">隨畫面上的金額/低減%即時試算（含尚未儲存的變更）；損益表要儲存後才套用。</span></div>
      <div id="dev-targets-box">${devTargetsTableHtml()}</div>
    </div>`;

  makeSortable(document.getElementById('dev-body'), {
    items: 'tr[data-key]',
    onEnd: keys => {
      const old = devRows;
      devRows = keys.map(k => old[Number(k)]);
      drawDevGrid();
      devDirty_();
    }
  });

  google.script.run.withSuccessHandler(safeHandler(list => {
    const dl = document.getElementById('dev-departments');
    if (dl) dl.innerHTML = (list || []).map(v => `<option value="${esc(v)}">`).join('');
  })).getKnownDepartments();
}

/** 「攤提落點 → 投資總額(低減後)/單台攤提(各車系)」彙總表 */
function devTargetsTableHtml() {
  const vehicles = devSummary.vehicles || [];
  const rows = (devSummary.targets || []).filter(t => t.Total);
  if (!rows.length) return '<p class="muted">還沒有攤提金額。</p>';
  return `
    <div class="grid-scroll"><table class="grid-table">
      <thead><tr><th>攤提落點</th><th>投資總額(低減後)</th><th>單台攤提(加權)</th>
        ${vehicles.map(v => `<th>${esc(v.VehicleCode || v.VehicleID)}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map(t => `
          <tr>
            <td class="row-head">${esc(shortLineName(t.LineName))}</td>
            <td class="calc">${fmt(t.Total)}</td>
            <td class="calc">${fmt(t.PerUnit)}</td>
            ${vehicles.map(v => `<td class="calc">${fmt((t.PerVehicle || {})[v.VehicleID] || 0)}</td>`).join('')}
          </tr>`).join('')}
      </tbody>
    </table></div>`;
}

/** 金額/低減%/攤提落點改變時 debounce 一下，拿畫面上(含未存檔)的資料試算彙總表(唯讀) */
let devPreviewTimer_ = null;
function scheduleDevTargetsPreview_() {
  if (!currentScenarioId || !devSummary) return;
  if (devPreviewTimer_) clearTimeout(devPreviewTimer_);
  devPreviewTimer_ = setTimeout(() => {
    google.script.run
      .withSuccessHandler(preview => {
        if (!devSummary) return;
        devSummary.targets = preview.targets;
        devSummary.lifeCycleUnits = preview.lifeCycleUnits;
        const box = document.getElementById('dev-targets-box');
        if (box) box.innerHTML = devTargetsTableHtml();
      })
      .withFailureHandler(() => {})
      .previewDevInvestmentSummary(currentScenarioId, devRows);
  }, 400);
}

function onDevField(i, field, value) {
  devRows[i][field] = value;
  syncDevReduced_(i);
  scheduleDevTargetsPreview_();
  devDirty_();
}

/** 低減後金額 = 金額 × (1 - 低減目標%/100)，四捨五入到整數方便對數字 */
function devReducedAmount(r) {
  return Math.round(num(r.Amount) * (1 - num(r.ChallengeReductionPct) / 100));
}
function syncDevReduced_(i) {
  const cell = document.getElementById('dev-reduced-' + i);
  if (cell) cell.value = devReducedAmount(devRows[i]);
}
function onDevPctInput(i, value) {
  devRows[i].ChallengeReductionPct = value;
  syncDevReduced_(i);
  scheduleDevTargetsPreview_();
  devDirty_();
}
/** 雙向試算：直接輸入「低減後金額」時反推低減目標% */
function onDevReducedInput(i, value) {
  const amount = num(devRows[i].Amount);
  const reduced = num(value);
  devRows[i].ChallengeReductionPct = amount ? Math.round((1 - reduced / amount) * 10000) / 100 : 0;
  const pctInput = document.getElementById('dev-pct-' + i);
  if (pctInput) pctInput.value = devRows[i].ChallengeReductionPct;
  scheduleDevTargetsPreview_();
  devDirty_();
}
function addDevRow() {
  devRows.push({ RowID: '', Department: '', TargetLineCode: '', Amount: '', Currency: 'TWD', ChallengeReductionPct: '', Notes: '', VehicleScope: '' });
  drawDevGrid();
  devDirty_();
}
function editDevScope(i) {
  const cur = String(devRows[i].VehicleScope || '').split(',').filter(x => x);
  openModal({
    title: '分攤車系',
    body: '<p class="help">不勾 = 全車系分攤(÷ LC 總台數)。勾選部分車系 = 只攤給這些車系(÷ 這些車系的攤提台數合計)，其他車系這筆是 0。</p>',
    fields: [{ name: 'ids', label: '只攤給這些車系', type: 'checks', value: cur,
      options: (devSummary.vehicles || []).map(v => [v.VehicleID, v.VehicleCode || v.VehicleID]) }],
    okText: '套用'
  }).then(v => {
    if (!v) return;
    devRows[i].VehicleScope = v.ids.join(',');
    drawDevGrid();
    scheduleDevTargetsPreview_();
    devDirty_();
  });
}

function devTargetCategoryOf(targetLineCode) {
  const opt = (devSummary.targetOptions || []).find(o => o.value === targetLineCode);
  return opt ? opt.category : '';
}
function onDevCategoryChange(i, category) {
  devRows[i].__category = category;
  const target = devTargetCategoryOf(devRows[i].TargetLineCode);
  if (target !== category) devRows[i].TargetLineCode = '';
  drawDevGrid();
  scheduleDevTargetsPreview_();
  devDirty_();
}

function addDevAmortTarget() {
  if (isDirty_()) { toast('先儲存目前的修改再新增攤提落點', 'warn'); return; }
  openModal({
    title: '新增攤提落點科目',
    body: `<p class="help">新增到車型 <b>${esc(currentVehicleTypeId)}</b> 的科目表。設備/模具會放在銷貨成本底下，費用放在產品貢獻前費用底下。</p>`,
    fields: [
      { name: 'category', label: '大類', type: 'select', options: DEV_AMORT_CATEGORIES, value: '模具' },
      { name: 'name', label: '科目名稱', placeholder: '例：法規認證模具' }
    ],
    okText: '新增', validate: v => !v.name.trim() ? '請輸入科目名稱' : ''
  }).then(v => {
    if (!v) return;
    google.script.run
      .withSuccessHandler(safeHandler(() => { toast('已新增攤提落點科目', 'ok'); renderDevInvestmentPanel(); }))
      .withFailureHandler(err => toast(err.message, 'err'))
      .addDevAmortLineItem(v.category, v.name.trim(), currentVehicleTypeId);
  });
}

function saveAmortBasis() {
  setStatus('devinvestment', '套用中...');
  google.script.run
    .withSuccessHandler(safeHandler(summary => {
      panelDataCache_[panelCacheKey_('devinvestment', 'scenario')] = summary;
      devSummary = summary;
      if (!isDirty_()) devRows = summary.rows.map(r => Object.assign({}, r));
      drawDevGrid();
      setStatus('devinvestment', '已套用攤提基準', 'ok');
    }))
    .withFailureHandler(err => setStatus('devinvestment', '錯誤：' + err.message, 'err'))
    .saveAmortBasis(currentScenarioId, val('dev-amort-vol'), val('dev-amort-years'));
}
function removeDevRow(i) {
  // 清空欄位即可：儲存時後端會把空白列(含既有 RowID)刪掉；還沒存過的列直接拿掉
  if (!devRows[i].RowID) devRows.splice(i, 1);
  else devRows[i] = { RowID: devRows[i].RowID, Department: '', TargetLineCode: '', Amount: '', Currency: 'TWD', ChallengeReductionPct: '', Notes: '', VehicleScope: '' };
  drawDevGrid();
  scheduleDevTargetsPreview_();
  devDirty_();
}

function saveDevGrid() {
  setStatus('devinvestment', '儲存中...');
  google.script.run
    .withSuccessHandler(safeHandler(summary => {
      clearDirty();
      panelDataCache_[panelCacheKey_('devinvestment', 'scenario')] = summary;
      devSummary = summary;
      devRows = summary.rows.map(r => Object.assign({}, r));
      drawDevGrid();
      setStatus('devinvestment', '已儲存', 'ok');
    }))
    .withFailureHandler(err => setStatus('devinvestment', '錯誤：' + err.message, 'err'))
    .saveDevInvestmentGrid(currentScenarioId, devRows);
}

/* ================= 參數與比率(預設參數 + 自訂參數，全部可改、可刪) + 匯率 =================
 * 匯率跟參數一樣是「每個情境各填一份、公式用 [名稱] 取用」，所以放在同一頁的下半部(以前是獨立的「匯率設定」分頁)。
 * 兩個表格各自有儲存鈕；底部的「儲存」/Ctrl+S 兩個一起存(見 markDirtyPart_)。 */
let rateData = null;
function rateDirty_() { markDirtyPart_('paramrates', 'paramrates', saveRateGrid, () => { clearDirtyPart_('paramrates'); loadRateGrid_(); }); }
function fxDirty_() { markDirtyPart_('paramrates', 'paramfx', saveFxGrid, () => { clearDirtyPart_('paramfx'); renderFxPanel(); }); }

function renderRatePanel() {
  if (!requireScope('paramrates', true)) return;
  document.getElementById('panel-paramrates').innerHTML = `<div class="card">
      <div class="card-head"><h3>參數與比率</h3></div>
      ${gridShell('paramrates', '參數與比率',
    '公式裡用 <b>[參數名稱]</b> 取用（例：<code>[營業稅率]</code>、<code>[關稅率]</code>）。單位是 % 的參數以百分比輸入(5 = 5%)，公式取出來自動變成小數。' +
    '「全車系」是這個情境的預設值，個別車系不同時才填車系欄位（留白 = 沿用）。可以自己新增參數，例如關稅率、KD件報價、倍率。')}
    </div>
    <div class="card" id="fx-section"></div>`;
  renderFxPanel();
  loadRateGrid_();
}
/** 只重新載入參數表(存檔後用)：不重畫整頁，下面匯率表還沒存的修改才不會不見 */
function loadRateGrid_() {
  const cacheKey = panelCacheKey_('paramrates');
  if (panelDataCache_[cacheKey]) { rateData = panelDataCache_[cacheKey]; drawRateGrid(); }
  google.script.run
    .withSuccessHandler(safeHandler(data => { panelDataCache_[cacheKey] = data; if (dirtyState_ && dirtyState_.parts && dirtyState_.parts.paramrates) return; rateData = data; drawRateGrid(); }))
    .withFailureHandler(showGlobalError)
    .getRateGrid(currentScenarioId, currentVehicleTypeId);
}

function drawRateGrid() {
  const toolbar = document.getElementById('toolbar-paramrates');
  if (!toolbar) return;
  toolbar.innerHTML = `<button type="button" class="btn" onclick="addParamDialog()">＋ 新增參數</button>
    <span class="spacer"></span><button type="button" class="btn secondary" onclick="saveRateGrid()">儲存</button>`;
  const dirty = () => 'rateDirty_()';

  document.getElementById('grid-paramrates').innerHTML = `
    <div class="grid-scroll">
    <table class="grid-table sticky-head-col">
      <thead><tr>
        <th>參數</th><th>單位</th><th>全車系</th>
        ${rateData.vehicles.map(v => `<th>${esc(v.VehicleCode || v.VehicleID)}</th>`).join('')}
        <th>說明</th><th></th>
      </tr></thead>
      <tbody>
        ${rateData.rates.map(rate => `
          <tr>
            <td class="row-head">${esc(rate.ParamName)}${rate.isDefault ? ' <span class="auto-tag" data-tip="這個情境還沒設定，目前用預設值">預設</span>' : ''}</td>
            <td class="calc" style="text-align:center;">${esc(rate.unit || '%')}</td>
            <td><input type="number" step="any" class="rate-global" data-name="${esc(rate.ParamName)}"
              data-paramid="${esc(rate.globalParamID)}" value="${esc(rate.globalValue)}"
              oninput="updateRatePlaceholders('${esc(rate.ParamName)}'); ${dirty()}"></td>
            ${rateData.vehicles.map(v => {
              const o = rate.overrides[v.VehicleID] || {};
              return `<td><input type="number" step="any" class="rate-override" data-name="${esc(rate.ParamName)}"
                data-vehicle="${esc(v.VehicleID)}" data-paramid="${esc(o.ParamID)}" value="${esc(o.Value)}"
                placeholder="${esc(rate.globalValue)}" oninput="${dirty()}"></td>`;
            }).join('')}
            <td class="muted" style="text-align:left;max-width:260px;white-space:normal;">${esc(rate.description || '')}</td>
            <td class="row-actions" style="white-space:nowrap;"><button type="button" class="btn ghost sm" onclick="editParamDialog(${rateData.rates.indexOf(rate)})">編輯</button><button type="button" class="btn ghost sm" onclick="deleteParam(${rateData.rates.indexOf(rate)})" aria-label="刪除">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
    </div>
    <p class="muted">車系欄位留白 = 沿用全車系的值（灰字為目前沿用的數值）。</p>`;
}

function updateRatePlaceholders(paramName) {
  const globalInput = document.querySelector(`.rate-global[data-name="${paramName}"]`);
  document.querySelectorAll(`.rate-override[data-name="${paramName}"]`)
    .forEach(inp => { inp.placeholder = globalInput.value; });
}

function saveRateGrid() {
  const rows = [];
  document.querySelectorAll('#grid-paramrates .rate-global').forEach(inp => {
    rows.push({ ParamID: inp.dataset.paramid || '', ParamName: inp.dataset.name, VehicleID: '', Value: inp.value === '' ? '' : num(inp.value) });
  });
  document.querySelectorAll('#grid-paramrates .rate-override').forEach(inp => {
    rows.push({ ParamID: inp.dataset.paramid || '', ParamName: inp.dataset.name, VehicleID: inp.dataset.vehicle, Value: inp.value === '' ? '' : num(inp.value) });
  });
  setStatus('paramrates', '儲存中...');
  google.script.run
    .withSuccessHandler(() => { clearDirtyPart_('paramrates'); setStatus('paramrates', '已儲存', 'ok'); loadRateGrid_(); })
    .withFailureHandler(err => setStatus('paramrates', '錯誤：' + err.message, 'err'))
    .saveRateGrid(currentScenarioId, rows);
}

function paramDialog_(title, def, isNew) {
  return openModal({
    title,
    body: '<p class="help">參數是全系統共用的定義(名稱/單位/預設值)；每個情境、每個車系的實際數值在這張表上填。</p>',
    fields: [
      { name: 'ParamName', label: '參數名稱', value: def.ParamName || '', placeholder: '例：關稅率', help: isNew ? '' : '改名時，公式裡的 [舊名稱] 與各情境填的數值會一起改過去' },
      { name: 'Unit', label: '單位', type: 'select', value: def.Unit || '%', options: [['%', '%（以百分比輸入，公式取出時 ÷100）'], ['數值', '數值（原值取用，如倍率、金額）']] },
      { name: 'DefaultValue', label: '預設值', type: 'number', value: def.DefaultValue === undefined ? '' : def.DefaultValue, help: '情境沒有填這個參數時用這個值' },
      { name: 'Description', label: '說明', value: def.Description || '', placeholder: '選填，例：KD件平均關稅率' }
    ],
    okText: isNew ? '新增' : '儲存',
    validate: v => !v.ParamName.trim() ? '請輸入參數名稱' : ''
  });
}
function addParamDialog() {
  if (isDirty_()) { toast('先儲存目前的修改再新增參數', 'warn'); return; }
  paramDialog_('新增參數', {}, true).then(v => {
    if (!v) return;
    google.script.run.withSuccessHandler(safeHandler(() => { toast('已新增參數「' + v.ParamName.trim() + '」', 'ok'); renderRatePanel(); }))
      .withFailureHandler(err => toast(err.message, 'err')).saveParamDef(v);
  });
}
function editParamDialog(i) {
  const rate = rateData.rates[i];
  if (!rate) return;
  const name = rate.ParamName;
  paramDialog_('編輯參數', { ParamName: name, Unit: rate.unit, DefaultValue: rate.defaultValue, Description: rate.description }, false).then(v => {
    if (!v) return;
    const newName = String(v.ParamName || '').trim();
    const save = () => {
      v.ParamName = newName;
      google.script.run.withSuccessHandler(safeHandler(() => { toast('已更新參數', 'ok'); renderRatePanel(); }))
        .withFailureHandler(err => toast(err.message, 'err')).saveParamDef(v);
    };
    if (newName === name) { save(); return; }
    // 改名：公式裡的 [舊名稱] 與各情境填的數值一起改過去，再存單位/預設值/說明
    google.script.run.withSuccessHandler(safeHandler(save))
      .withFailureHandler(err => toast(err.message, 'err')).renameParamDef(name, newName);
  });
}
function deleteParam(i) {
  const rate = rateData.rates[i];
  if (!rate) return;
  const name = rate.ParamName;
  confirmModal('刪除參數「' + esc(name) + '」？', '所有情境填過的數值會一起刪除。有公式還在使用這個參數時會被擋下來（先改公式再刪）。', '刪除', true).then(ok => {
    if (!ok) return;
    google.script.run.withSuccessHandler(safeHandler(() => { toast('已刪除參數', 'ok'); renderRatePanel(); }))
      .withFailureHandler(err => toast(err.message, 'err', 5000)).deleteParamDef(name);
  });
}

/* ---------------- 匯率(畫在參數與比率頁的下半部) ---------------- */
let fxData = null;

function renderFxPanel() {
  const box = document.getElementById('fx-section');
  if (!box) return;
  box.innerHTML = '<div class="card-head"><h3>匯率</h3></div>' + gridShell('paramfx', '匯率',
    '1 外幣 = ? 台幣。銷貨成本與開發總投以外幣登打時用這個匯率換算；公式裡也可以用 <b>[CNY匯率]</b> 這種寫法取用。');
  const cacheKey = panelCacheKey_('paramfx', 'scenario');
  if (panelDataCache_[cacheKey]) { fxData = panelDataCache_[cacheKey]; drawFxGrid(); }
  google.script.run
    .withSuccessHandler(safeHandler(data => { panelDataCache_[cacheKey] = data; fxData = data; drawFxGrid(); }))
    .withFailureHandler(showGlobalError)
    .getFxGrid(currentScenarioId);
}

function drawFxGrid() {
  document.getElementById('toolbar-paramfx').innerHTML = `
    <input id="fx-new-currency" type="text" placeholder="幣別代碼，如 KRW" style="width:150px;">
    <button type="button" class="btn secondary" onclick="addFxCurrency()">＋ 新增幣別</button>
    <span class="spacer"></span>
    <button type="button" class="btn secondary" onclick="saveFxGrid()">儲存</button>
  `;

  document.getElementById('grid-paramfx').innerHTML = `
    <div class="grid-scroll">
    <table class="grid-table">
      <thead><tr><th>幣別</th>${fxData.paramNames.map(n =>
        `<th>${esc(n)}<div class="th-sub">1 外幣 = ? ${esc(fxData.baseCurrency)}</div></th>`).join('')}</tr></thead>
      <tbody>
        <tr><td class="row-head">${esc(fxData.baseCurrency)}（本位幣）</td>
          ${fxData.paramNames.map(() => '<td class="calc">1</td>').join('')}</tr>
        ${fxData.rows.map(row => `
          <tr>
            <td class="row-head">${esc(row.Currency)}</td>
            ${fxData.paramNames.map(name => {
              const cell = row.cells[name] || {};
              return `<td><input type="number" step="any" class="fx-cell" data-currency="${esc(row.Currency)}"
                data-name="${esc(name)}" data-paramid="${esc(cell.ParamID)}" value="${esc(cell.Value)}"
                oninput="fxDirty_()"></td>`;
            }).join('')}
          </tr>`).join('')}
      </tbody>
    </table>
    </div>
    <p class="muted">留白 = 未設定該幣別的匯率；銷貨成本與開發總投以外幣登打時會用這個匯率換算。</p>`;
}

function addFxCurrency() {
  const c = val('fx-new-currency').trim().toUpperCase();
  if (!c) { setStatus('paramfx', '請輸入幣別代碼', 'err'); return; }
  if (c === fxData.baseCurrency) { setStatus('paramfx', '本位幣不需要設定匯率', 'err'); return; }
  if (fxData.rows.some(r => r.Currency === c)) { setStatus('paramfx', '這個幣別已經在列表中', 'err'); return; }
  const cells = {};
  fxData.paramNames.forEach(n => { cells[n] = { ParamID: '', Value: '' }; });
  fxData.rows.push({ Currency: c, cells: cells });
  drawFxGrid();
}

function saveFxGrid() {
  const cells = [];
  document.querySelectorAll('#grid-paramfx .fx-cell').forEach(inp => {
    cells.push({
      ParamID: inp.dataset.paramid || '', Currency: inp.dataset.currency,
      ParamName: inp.dataset.name, Value: inp.value === '' ? '' : num(inp.value)
    });
  });
  setStatus('paramfx', '儲存中...');
  google.script.run
    .withSuccessHandler(safeHandler(data => { clearDirtyPart_('paramfx'); fxData = data; drawFxGrid(); setStatus('paramfx', '已儲存', 'ok'); }))
    .withFailureHandler(err => setStatus('paramfx', '錯誤：' + err.message, 'err'))
    .saveFxGrid(currentScenarioId, cells);
}
