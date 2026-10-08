/* ================= 開發總投比較 =================
 * 開發總投頁工具列的第三個檢視：幾個情境(現況 vs 目標、前回 vs 本回、跨車型)的開發總投並排，
 * 一個部門一列，用部門名稱對應；每個比較欄位後面接一欄「與基準的差異」。
 *   數值：原始投資 / 低減後 / 低減% / 單台攤提
 *   列：部門 / 部門 × 大類 / 大類
 * 單台攤提的差異拆成「投資金額影響」與「攤提台數影響」，下方瀑布圖看 基準 → 各部門增減 → 比較欄。
 * 比較用的是已儲存的數字；比較欄位、顯示選項記在瀏覽器。
 */
const DEV_CMP_KEY_ = 'plApp.devCompare.v1';
const DEV_CMP_CATS_ = [['mold', '模具'], ['equip', '設備'], ['expense', '費用'], ['other', '其他']];
const DEV_CMP_VALUES_ = [['total', '原始投資'], ['reduced', '低減後'], ['pct', '低減 %'], ['unit', '單台攤提']];
const DEV_CMP_ROWS_ = [['dept', '部門'], ['deptcat', '部門 × 大類'], ['cat', '大類']];
let devCmp_ = null;            // { cols: [ScenarioID], base, value, rows, hide: [部門], wfCol }
let devCmpData_ = null;        // getDevComparison 的結果
let devCmpOptions_ = null;     // 車型 → 情境(不含快照)
let devCmpDraft_ = { type: '', scenario: '' };

function devCmpLoadPrefs_() {
  if (devCmp_) return;
  devCmp_ = { cols: [], base: '', value: 'reduced', rows: 'dept', hide: [], wfCol: '' };
  try {
    const p = JSON.parse(localStorage.getItem(DEV_CMP_KEY_) || 'null');
    if (p && typeof p === 'object') {
      if (Array.isArray(p.cols)) devCmp_.cols = p.cols.filter(x => typeof x === 'string');
      if (DEV_CMP_VALUES_.some(v => v[0] === p.value)) devCmp_.value = p.value;
      if (DEV_CMP_ROWS_.some(v => v[0] === p.rows)) devCmp_.rows = p.rows;
      if (Array.isArray(p.hide)) devCmp_.hide = p.hide.map(String);
      devCmp_.base = String(p.base || '');
    }
  } catch (e) { /* 讀不到就用預設 */ }
}
function devCmpSavePrefs_() {
  try { localStorage.setItem(DEV_CMP_KEY_, JSON.stringify(devCmp_)); } catch (e) { /* 存不了就算了 */ }
}

/** 進比較檢視：先拿情境清單(整理預設欄位)，再跟後端要各欄的部門彙總 */
function drawDevCompare_() {
  devCmpLoadPrefs_();
  amountUnit = loadAmountUnit_(amountUnit);
  const grid = document.getElementById('grid-devinvestment');
  if (!devCmpOptions_) {
    grid.innerHTML = '<p class="muted">載入中…</p>';
    google.script.run
      .withSuccessHandler(safeHandler(options => {
        devCmpOptions_ = (options || []).map(t => ({ VehicleTypeID: t.VehicleTypeID, scenarios: t.scenarios.filter(s => !s.isSnapshot) }));
        devCmpFetch_();
      }))
      .withFailureHandler(showGlobalError)
      .getComparisonOptions();
    return;
  }
  devCmpFetch_();
}
function devCmpScenario_(id) {
  for (const t of devCmpOptions_ || []) {
    const s = t.scenarios.find(x => x.ScenarioID === id);
    if (s) return Object.assign({ VehicleTypeID: t.VehicleTypeID }, s);
  }
  return null;
}
function devCmpIsBaseline_(s) { return !s.ScenarioType || s.ScenarioType === '現況'; }
function devCmpFetch_() {
  devCmp_.cols = devCmp_.cols.filter((id, i, a) => devCmpScenario_(id) && a.indexOf(id) === i);
  // 目前的情境一定看得到；第一次用時順便放同車型的現況當基準(現況 vs 目標)
  if (currentScenarioId && devCmp_.cols.indexOf(currentScenarioId) === -1) {
    if (!devCmp_.cols.length) {
      const cur = devCmpScenario_(currentScenarioId);
      const type = cur && devCmpOptions_.find(t => t.VehicleTypeID === cur.VehicleTypeID);
      const baseline = cur && !devCmpIsBaseline_(cur) && type ? type.scenarios.find(devCmpIsBaseline_) : null;
      if (baseline) devCmp_.cols.push(baseline.ScenarioID);
    }
    devCmp_.cols.push(currentScenarioId);
  }
  if (devCmp_.cols.indexOf(devCmp_.base) === -1) devCmp_.base = devCmp_.cols[0] || '';
  devCmpSavePrefs_();
  google.script.run
    .withSuccessHandler(safeHandler(data => {
      devCmpData_ = data || [];
      if (devView_ === 'cmp') devCmpRender_();
    }))
    .withFailureHandler(showGlobalError)
    .getDevComparison(devCmp_.cols);
}

/* ---------- 數字 ---------- */
function devCmpColLabel_(c) { return [c.Gate, c.ScenarioName].filter(x => x).join(' ') || c.ScenarioID; }
/** 某一欄、某部門(null = 全部)、某大類(null = 全部)在目前「數值」下的值；這一欄沒有這個部門回傳 null */
function devCmpValue_(col, dept, cat, mode) {
  mode = mode || devCmp_.value;
  const D = col.dev;
  let rows;
  if (dept === null) rows = D.rows;
  else if (Array.isArray(dept)) rows = D.rows.filter(r => dept.indexOf(r.Department) !== -1);
  else rows = D.rows.filter(r => r.Department === dept);
  if (!rows.length) return null;
  const amt = (r, reduced) => cat ? (reduced ? r.red[cat] : r[cat]) : (reduced ? r.reduced : r.total);
  const total = rows.reduce((s, r) => s + amt(r, false), 0);
  const reduced = rows.reduce((s, r) => s + amt(r, true), 0);
  if (mode === 'total') return total;
  if (mode === 'reduced') return reduced;
  if (mode === 'pct') return total ? (1 - reduced / total) * 100 : null;
  return num(D.lifeCycleUnits) ? reduced / num(D.lifeCycleUnits) : null;
}
/** 數值越小越好(金額、單台)；低減% 越大越好 */
function devCmpLowerBetter_(mode) { return (mode || devCmp_.value) !== 'pct'; }
function devCmpFmt_(v, mode) {
  mode = mode || devCmp_.value;
  if (v === null || v === undefined) return '<span class="muted">—</span>';
  if (mode === 'pct') return devPctText_(v) + '%';
  if (mode === 'unit') return fmt(v);
  return fmt(v / amountUnit, amountUnitDigits_(amountUnit));
}
function devCmpDeltaHtml_(v, b, mode) {
  mode = mode || devCmp_.value;
  if (v === null && b === null) return '<td class="num dlt"></td>';
  const d = (v || 0) - (b || 0);
  const shown = mode === 'pct' ? Math.round(d * 100) / 100 : mode === 'unit' ? Math.round(d) : d / amountUnit;
  if (Math.abs(shown) < (mode === 'pct' ? 0.005 : amountUnit === 1 || mode === 'unit' ? 0.5 : 0.05)) return '<td class="num dlt muted">0</td>';
  const good = devCmpLowerBetter_(mode) ? d < 0 : d > 0;
  const text = mode === 'pct' ? devPctText_(Math.abs(d)) + ' pt' : mode === 'unit' ? fmt(Math.abs(d)) : fmt(Math.abs(d) / amountUnit, amountUnitDigits_(amountUnit));
  const rel = mode !== 'pct' && b ? `（${d > 0 ? '+' : '−'}${pct1_(Math.abs(d / b * 100))}%）` : '';
  const tag = v === null ? '<small>沒有這個部門</small>' : b === null ? '<small>新增</small>' : '';
  return `<td class="num dlt ${good ? 'good' : 'bad'}" data-tip="${esc((d > 0 ? '+' : '−') + text + rel)}">${tag}${d > 0 ? '+' : '−'}${text}</td>`;
}

/** 部門清單：各欄的部門依出現順序合起來(基準欄的順序優先) */
function devCmpDepts_(cols, baseCol) {
  const out = [];
  [baseCol].concat(cols).forEach(c => { if (c) c.dev.rows.forEach(r => { if (out.indexOf(r.Department) === -1) out.push(r.Department); }); });
  return out;
}

/* ---------- 畫面 ---------- */
function devCmpRender_() {
  const grid = document.getElementById('grid-devinvestment');
  if (!grid) return;
  const byId = {};
  devCmpData_.forEach(c => { byId[c.ScenarioID] = c; });
  const cols = devCmp_.cols.map(id => byId[id]).filter(x => x);
  const baseCol = byId[devCmp_.base] || cols[0] || null;
  const depts = devCmpDepts_(cols, baseCol);
  const shown = depts.filter(d => devCmp_.hide.indexOf(d) === -1);
  const types = cols.map(c => c.VehicleTypeID).filter((t, i, a) => a.indexOf(t) === i);

  grid.innerHTML = `
    ${isDirty_() ? '<div class="callout warn">這一頁還有沒儲存的修改；比較用的是已儲存的數字，儲存後再回來看。</div>' : ''}
    ${devCmpColsCardHtml_(cols, baseCol)}
    ${cols.length ? `
    <div class="toolbar dcmp-opts">
      <span class="lbl">數值</span>${devCmpSegHtml_(DEV_CMP_VALUES_, devCmp_.value, 'value')}
      <span class="lbl">列</span>${devCmpSegHtml_(DEV_CMP_ROWS_, devCmp_.rows, 'rows')}
      ${devCmp_.rows !== 'cat' ? devCmpDeptFilterHtml_(depts) : ''}
      <span class="spacer"></span>
      ${devCmp_.value === 'unit' ? '<span class="muted">單位：元/台</span>' : `<span class="lbl">單位</span>${devCmpSegHtml_(AMOUNT_UNITS_.map(u => [u[0], u[1]]), amountUnit, 'unit')}`}
      <button type="button" class="btn secondary sm" onclick="copyReportTable('dcmp-table')">複製表格</button>
    </div>
    ${types.length > 1 ? `<p class="help">跨車型比較：部門用名稱對應，同一個部門在不同車型寫法不同（例：試驗部／試驗課）會分成兩列。</p>` : ''}
    ${devCmpTableHtml_(cols, baseCol, depts, shown)}
    ${devCmpWaterfallHtml_(cols, baseCol, depts, shown)}` : ''}`;
  makeSortable(document.getElementById('dcmp-chips'), {
    items: '.dcmp-chip',
    onEnd: keys => { devCmp_.cols = keys; devCmpSavePrefs_(); devCmpRender_(); }
  });
}
function devCmpSegHtml_(items, cur, field) {
  return `<div class="seg">${items.map(([k, label]) =>
    `<button type="button" class="seg-btn${String(k) === String(cur) ? ' active' : ''}" onclick="devCmpSet_('${field}', '${k}')">${label}</button>`).join('')}</div>`;
}
function devCmpSet_(field, v) {
  if (field === 'unit') { amountUnit = normAmountUnit_(v); saveAmountUnit_(amountUnit); }
  else devCmp_[field] = v;
  devCmpSavePrefs_();
  devCmpRender_();
}

/** 比較欄位：一個情境一個標籤，★ = 基準；下方選車型 + 情境加入 */
function devCmpColsCardHtml_(cols, baseCol) {
  if (!devCmpDraft_.type || !devCmpOptions_.some(t => t.VehicleTypeID === devCmpDraft_.type)) devCmpDraft_.type = currentVehicleTypeId || (devCmpOptions_[0] || {}).VehicleTypeID || '';
  const type = devCmpOptions_.find(t => t.VehicleTypeID === devCmpDraft_.type);
  const free = type ? type.scenarios.filter(s => devCmp_.cols.indexOf(s.ScenarioID) === -1) : [];
  if (!free.some(s => s.ScenarioID === devCmpDraft_.scenario)) devCmpDraft_.scenario = free[0] ? free[0].ScenarioID : '';
  const chips = cols.map(c => {
    const isBase = baseCol && c.ScenarioID === baseCol.ScenarioID;
    const js = devJs_(c.ScenarioID);
    return `<span class="dcmp-chip${isBase ? ' base' : ''}" data-key="${esc(c.ScenarioID)}">
      ${dragHandleHtml('拖曳調整欄位順序')}
      <button type="button" class="star" onclick="devCmpSetBase_(${js})" data-tip="${isBase ? '這一欄是基準，差異都跟它比' : '設成基準'}">${isBase ? '★' : '☆'}</button>
      <span class="t"><small>${esc(c.VehicleTypeID)}</small>${esc(devCmpColLabel_(c))}</span>
      ${c.isBaseline ? '<em class="tag">現況</em>' : '<em class="tag tgt">目標</em>'}
      <button type="button" class="x" onclick="devCmpRemove_(${js})" data-tip="移除這一欄">✕</button>
    </span>`;
  }).join('');
  return `<div class="card dcmp-cols">
    <div class="dcmp-row">
      <b class="h">比較欄位</b>
      <div class="dcmp-chips" id="dcmp-chips">${chips || '<span class="muted">還沒有比較欄位，從右邊加入。</span>'}</div>
      <span class="dcmp-add">
        <select onchange="devCmpDraft_.type=this.value;devCmpDraft_.scenario='';devCmpRender_()">${devCmpOptions_.map(t => `<option value="${esc(t.VehicleTypeID)}"${t.VehicleTypeID === devCmpDraft_.type ? ' selected' : ''}>${esc(t.VehicleTypeID)}</option>`).join('')}</select>
        <select onchange="devCmpDraft_.scenario=this.value" ${free.length ? '' : 'disabled'}>${free.map(s => `<option value="${esc(s.ScenarioID)}"${s.ScenarioID === devCmpDraft_.scenario ? ' selected' : ''}>${esc(scenarioLabel(s))}</option>`).join('') || '<option>（都加入了）</option>'}</select>
        <button type="button" class="btn sm" ${free.length ? '' : 'disabled'} onclick="devCmpAdd_()">＋ 加入</button>
      </span>
    </div>
  </div>`;
}
function devCmpAdd_() {
  if (!devCmpDraft_.scenario) return;
  devCmp_.cols.push(devCmpDraft_.scenario);
  devCmpDraft_.scenario = '';
  devCmpFetch_();
}
function devCmpRemove_(id) {
  devCmp_.cols = devCmp_.cols.filter(x => x !== id);
  if (devCmp_.base === id) devCmp_.base = devCmp_.cols[0] || '';
  devCmpSavePrefs_();
  devCmpRender_();
}
function devCmpSetBase_(id) { devCmp_.base = id; devCmpSavePrefs_(); devCmpRender_(); }

/** 只比某幾個部門：勾掉的部門不列出來，合計另外有「勾選部門小計」 */
function devCmpDeptFilterHtml_(depts) {
  const hidden = depts.filter(d => devCmp_.hide.indexOf(d) !== -1).length;
  return `<details class="dcmp-filter"><summary class="btn secondary sm">部門：${hidden ? `${depts.length - hidden} / ${depts.length}` : '全部'} ▾</summary>
    <div class="pop">
      <label><input type="checkbox" ${hidden ? '' : 'checked'} onchange="devCmpHideAll_(!this.checked)"> <b>全部</b></label>
      ${depts.map(d => `<label><input type="checkbox" ${devCmp_.hide.indexOf(d) === -1 ? 'checked' : ''} onchange="devCmpToggleDept_(${devJs_(d)}, this.checked)"> ${esc(devDeptLabel_(d))}</label>`).join('')}
    </div></details>`;
}
function devCmpToggleDept_(d, on) {
  devCmp_.hide = devCmp_.hide.filter(x => x !== d);
  if (!on) devCmp_.hide.push(d);
  devCmpSavePrefs_();
  devCmpRender_();
  const f = document.querySelector('.dcmp-filter');
  if (f) f.open = true;
}
function devCmpHideAll_(hide) {
  const byId = {};
  devCmpData_.forEach(c => { byId[c.ScenarioID] = c; });
  devCmp_.hide = hide ? devCmpDepts_(devCmp_.cols.map(id => byId[id]).filter(x => x), byId[devCmp_.base]) : [];
  devCmpSavePrefs_();
  devCmpRender_();
  const f = document.querySelector('.dcmp-filter');
  if (f) f.open = true;
}

function devCmpTableHtml_(cols, baseCol, depts, shown) {
  const mode = devCmp_.value;
  const others = cols.filter(c => c !== baseCol);
  const ordered = [baseCol].concat(others);
  const head = `<thead><tr><th class="c-dept">${devCmp_.rows === 'cat' ? '大類' : '部門'}</th>${ordered.map(c => {
    const isBase = c === baseCol;
    return `<th class="${isBase ? 'base' : ''}"><small>${esc(c.VehicleTypeID)}${isBase ? ' · 基準' : ''}</small>${esc(devCmpColLabel_(c))}</th>${isBase ? '' : '<th class="dlt">差異</th>'}`;
  }).join('')}</tr></thead>`;
  const cells = (dept, cat, m) => {
    const b = devCmpValue_(baseCol, dept, cat, m);
    return `<td class="num base">${devCmpFmt_(b, m)}</td>` + others.map(c => {
      const v = devCmpValue_(c, dept, cat, m);
      return `<td class="num">${devCmpFmt_(v, m)}</td>${devCmpDeltaHtml_(v, b, m)}`;
    }).join('');
  };
  const usedCats = DEV_CMP_CATS_.filter(([k]) => ordered.some(c => c.dev.total[k]));
  let body = '';
  if (devCmp_.rows === 'cat') {
    body = usedCats.map(([k, label]) => `<tr><td class="c-dept">${label}</td>${cells(null, k)}</tr>`).join('');
  } else {
    shown.forEach(d => {
      const note = ordered.map(c => { const r = c.dev.rows.find(x => x.Department === d); return r && r.notes ? `${devCmpColLabel_(c)}：${r.notes}` : ''; }).filter(x => x).join('\n');
      body += `<tr class="${devCmp_.rows === 'deptcat' ? 'grp' : ''}"><td class="c-dept"${note ? ` data-tip="${esc(note)}"` : ''}>${esc(devDeptLabel_(d))}</td>${cells(d, null)}</tr>`;
      if (devCmp_.rows === 'deptcat') {
        usedCats.forEach(([k, label]) => {
          const any = ordered.some(c => { const r = c.dev.rows.find(x => x.Department === d); return r && r[k]; });
          if (any) body += `<tr class="sub"><td class="c-dept">${label}</td>${cells(d, k)}</tr>`;
        });
      }
    });
  }
  if (!body) body = `<tr><td class="c-dept muted" colspan="${1 + ordered.length * 2}">沒有開發總投資料</td></tr>`;

  // 合計、整體低減、攤提台數、單台攤提(差異拆成投資金額 / 攤提台數影響)
  const filtered = devCmp_.rows !== 'cat' && shown.length < depts.length;
  let foot = '';
  if (filtered) foot += `<tr class="part"><td class="c-dept">勾選部門小計</td>${cells(shown, null)}</tr>`;
  foot += `<tr class="total"><td class="c-dept">合計</td>${cells(null, null)}</tr>`;
  if (mode !== 'pct') foot += `<tr class="kpi"><td class="c-dept">整體低減 %</td>${cells(null, null, 'pct')}</tr>`;
  const units = c => num(c.dev.lifeCycleUnits);
  foot += `<tr class="kpi"><td class="c-dept">攤提台數</td><td class="num base">${fmt(units(baseCol))}</td>${others.map(c => {
    const d = units(c) - units(baseCol);
    return `<td class="num">${fmt(units(c))}</td><td class="num dlt ${d ? (d > 0 ? 'good' : 'bad') : 'muted'}">${d ? (d > 0 ? '+' : '−') + fmt(Math.abs(d)) : '0'}</td>`;
  }).join('')}</tr>`;
  if (mode !== 'unit') foot += `<tr class="kpi"><td class="c-dept">單台攤提（元/台）</td>${cells(null, null, 'unit')}</tr>`;
  // 單台 = 低減後 ÷ 台數；差異 = (R1 − R0) ÷ U0【投資金額】 + R1 × (1/U1 − 1/U0)【攤提台數】
  const split = c => {
    const R0 = baseCol.dev.total.reduced, R1 = c.dev.total.reduced, U0 = units(baseCol), U1 = units(c);
    if (!U0 || !U1) return null;
    return { amount: (R1 - R0) / U0, volume: R1 * (1 / U1 - 1 / U0) };
  };
  if (others.some(c => { const s = split(c); return s && Math.abs(s.volume) >= 0.5; })) {
    [['amount', '└ 投資金額影響'], ['volume', '└ 攤提台數影響']].forEach(([k, label]) => {
      foot += `<tr class="kpi split"><td class="c-dept">${label}</td><td class="num base"></td>${others.map(c => {
        const s = split(c);
        return `<td class="num"></td>${s ? devCmpDeltaHtml_(s[k], 0, 'unit') : '<td class="num dlt"></td>'}`;
      }).join('')}</tr>`;
    });
  }
  return `<div class="dev-sheet-wrap dcmp-wrap"><table class="dev-sheet dcmp-table" id="dcmp-table">${head}<tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>
    <div class="dev-legend"><span><i class="sw good"></i>對損益有利（投資、單台變少；低減% 變高）</span><span><i class="sw bad"></i>不利</span>
      <span>— = 這一欄沒有這個部門</span>${devCmp_.rows !== 'cat' ? '<span>滑鼠移到部門名稱上看各欄的說明</span>' : ''}</div>`;
}

/** 基準合計 → 每個部門的增減 → 比較欄合計；勾掉的部門併成「其他部門」 */
function devCmpWaterfallHtml_(cols, baseCol, depts, shown) {
  const others = cols.filter(c => c !== baseCol);
  if (!others.length || devCmp_.value === 'pct') return '';
  const target = others.find(c => c.ScenarioID === devCmp_.wfCol) || others[others.length - 1];
  const mode = devCmp_.value;
  const unitMode = mode === 'unit';
  const scale = v => unitMode ? v : v / amountUnit;
  const steps = [{ label: devCmpColLabel_(baseCol), value: scale(devCmpValue_(baseCol, null, null) || 0), kind: 'total' }];
  let rest = 0;
  // 單台攤提：每個部門用自己欄的台數算，台數不同的部分另外一根
  const pick = (c, d) => devCmpValue_(c, d, null, unitMode ? 'reduced' : mode) || 0;
  const U0 = num(baseCol.dev.lifeCycleUnits), U1 = num(target.dev.lifeCycleUnits);
  depts.forEach(d => {
    const delta = unitMode ? (U0 ? (pick(target, d) - pick(baseCol, d)) / U0 : 0) : pick(target, d) - pick(baseCol, d);
    if (shown.indexOf(d) === -1 || devCmp_.rows === 'cat') { rest += delta; return; }
    if (Math.abs(delta) >= 0.5) steps.push({ label: devDeptLabel_(d), value: scale(delta), kind: 'delta' });
  });
  if (Math.abs(rest) >= 0.5) steps.push({ label: '其他部門', value: scale(rest), kind: 'delta' });
  if (unitMode && U0 && U1 && U0 !== U1) steps.push({ label: '攤提台數', value: target.dev.total.reduced * (1 / U1 - 1 / U0), kind: 'delta' });
  steps.push({ label: devCmpColLabel_(target), value: scale(devCmpValue_(target, null, null) || 0), kind: 'total' });
  const unitText = unitMode ? '元/台' : amountUnitText_(amountUnit);
  return `<div class="card" style="margin-top:14px;">
    <div class="card-head"><h4>差在哪些部門</h4>
      <span class="muted">${esc(devCmpColLabel_(baseCol))} →
        <select onchange="devCmp_.wfCol=this.value;devCmpSavePrefs_();devCmpRender_()">${others.map(c => `<option value="${esc(c.ScenarioID)}"${c === target ? ' selected' : ''}>${esc(c.VehicleTypeID + ' ' + devCmpColLabel_(c))}</option>`).join('')}</select>
        ，${DEV_CMP_VALUES_.find(v => v[0] === mode)[1]}（${unitText}）</span></div>
    ${wfSvg_(steps, { width: 1100, height: 340, labels: true, lowerBetter: true, fmtV: v => unitMode ? fmt(v) : fmt(v, amountUnitDigits_(amountUnit)) })}
  </div>`;
}
