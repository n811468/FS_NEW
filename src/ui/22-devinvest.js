/* ================= 開發總投 =================
 * 照 Excel 的看法：一個部門一列，左邊投資金額(模具/設備/費用/總計)、中間低減目標、右邊低減後、最右邊說明。
 *   - 格子直接改：一格只有一筆台幣時直接打數字(Enter 往下一格)
 *   - 一格有好幾筆或外幣(右上角小三角)、攤提落點、分攤車系、每一筆的項目名稱 → 點部門名稱，在右側面板改
 *   - 低減目標預設一個部門一個 %，也可以資產(模具＋設備)、費用分開；談定的是金額時直接填低減後金額反推 %
 *   - 從 Excel 貼上：先列出哪些會變(要你看一下 / 會更新 / 會新增 / 說明 / 不變)，確認後才套用
 * 資料還是一筆一列(DevInvestment)，部門是把同一個 Department 的列合起來看；部門說明另外存(getDevDeptNotes)。
 */
let devRows = [];
let devSummary = null;
let devNotes = {};             // { 部門: 說明 }
let devView_ = 'sum';          // sum = 部門彙總、list = 每一筆明細
const devChanged_ = new Set(); // 改過還沒存的格子：部門|模具、部門|pct、部門|note…
let devDrawer_ = null;         // 右側面板 { dept, split }
const DEV_COLS_ = ['模具', '設備', '費用'];   // 跟 Excel 一樣的欄位順序
const DEV_ASSET_ = ['模具', '設備'];

function renderDevInvestmentPanel() {
  if (!requireScope('devinvestment', true)) return;
  closeDevDrawer_(true);
  document.getElementById('panel-devinvestment').innerHTML = gridShell('devinvestment', '開發總投',
    '一個部門一列，跟 Excel 一樣左邊投資金額、右邊低減後。<b>點格子直接改</b>（Enter 往下一格）；' +
    '<b>點部門名稱</b>看每一筆、改攤提落點、分攤車系與說明。右上角有小三角的格子有好幾筆或外幣，也要點進去改。拖曳 ⠿ 調整部門順序。');
  const cacheKey = panelCacheKey_('devinvestment', 'scenario');
  const take = summary => {
    devSummary = summary;
    devRows = summary.rows.map(r => Object.assign({}, r));
    devNotes = Object.assign({}, summary.deptNotes || {});
    devChanged_.clear();
    drawDevGrid();
  };
  if (panelDataCache_[cacheKey]) take(panelDataCache_[cacheKey]);
  google.script.run
    .withSuccessHandler(safeHandler(summary => {
      panelDataCache_[cacheKey] = summary;
      if (isDirty_()) return;
      take(summary);
    }))
    .withFailureHandler(showGlobalError)
    .getDevInvestmentSummary(currentScenarioId);
}

/* ---------- 資料整理：一筆一列 → 部門 ---------- */
function devIsTarget_() { return !!devSummary && !devSummary.isBaseline; }
function devRate_(cur) {
  const r = ((devSummary && devSummary.fxRates) || {})[cur || BASE_CURRENCY_];
  return r === undefined || r === '' ? 1 : num(r);
}
const BASE_CURRENCY_ = 'TWD';
function devTwd_(r) { return num(r.Amount) * devRate_(r.Currency); }
function devPct_(r) { return devIsTarget_() ? num(r.ChallengeReductionPct) : 0; }
function devTargetCategoryOf(targetLineCode) {
  const opt = ((devSummary && devSummary.targetOptions) || []).find(o => o.value === targetLineCode);
  return opt ? opt.category : '';
}
function devCatOf_(r) { return devTargetCategoryOf(r.TargetLineCode) || r.__category || ''; }
/** 刪掉的列(沒部門也沒金額)：存檔時後端會刪 */
function devBlank_(r) { return !String(r.Department || '').trim() && (r.Amount === '' || r.Amount === null || r.Amount === undefined); }
function devDeptName_(r) { return String(r.Department || '').trim(); }
/** 每一個大類預設的攤提落點：這個大類的第一個科目(內建的模具費用/新增專屬設備/CMC開發費排在前面) */
function devDefaultTarget_(cat) {
  const opt = ((devSummary && devSummary.targetOptions) || []).find(o => o.category === cat);
  return opt ? opt.value : '';
}
function devGroups_() {
  const order = [], m = {};
  devRows.forEach((r, i) => {
    if (devBlank_(r)) return;
    const name = devDeptName_(r);
    if (!m[name]) { m[name] = { name, idx: [], cat: { '模具': [], '設備': [], '費用': [], '': [] } }; order.push(m[name]); }
    const g = m[name];
    g.idx.push(i);
    const c = devCatOf_(r);
    if (c && g.cat[c]) g.cat[c].push(i);
    else if (num(r.Amount) || r.TargetLineCode) g.cat[''].push(i);   // 舊資料：落點不屬於任何大類
  });
  order.forEach(g => {
    const pick = cs => g.idx.filter(i => { const c = devCatOf_(devRows[i]); return (c || num(devRows[i].Amount)) && (!cs || cs.indexOf(c) !== -1); });
    g.sum = cs => pick(cs).reduce((s, i) => s + devTwd_(devRows[i]), 0);
    g.red = cs => pick(cs).reduce((s, i) => s + devTwd_(devRows[i]) * (1 - devPct_(devRows[i]) / 100), 0);
    g.pcts = cs => Array.from(new Set(pick(cs).filter(i => num(devRows[i].Amount)).map(i => devPctText_(devPct_(devRows[i])))));
    g.locked = c => g.cat[c].length > 1 || g.cat[c].some(i => (devRows[i].Currency || BASE_CURRENCY_) !== BASE_CURRENCY_);
  });
  return order;
}
const devFindGroup_ = name => devGroups_().find(g => g.name === name);
function devPctText_(v) { return String(Math.round(num(v) * 100) / 100); }
function devAmt_(v) { return Math.abs(v) >= 0.5 ? fmt(v) : '-'; }
function devDeptLabel_(name) { return name || '（未填部門）'; }
/** 部門名稱放進 onclick 等屬性裡：JSON 字串再轉義，名稱有引號也不會壞 */
function devJs_(s) { return esc(JSON.stringify(String(s))); }
/** 同一組(資產/費用)或整個部門目前的 %，新的一筆沿用；都沒有就用工具列的「統一低減目標」 */
function devInheritPct_(g, cat) {
  if (!devIsTarget_()) return '';
  const same = g ? g.pcts(cat === '費用' ? ['費用'] : DEV_ASSET_) : [];
  const all = g ? g.pcts(null) : [];
  if (same.length === 1) return same[0];
  if (all.length === 1) return all[0];
  return val('dev-all-pct') || '';
}
function devMark_(key) {
  devChanged_.add(key);
  markDirty('devinvestment', saveDevGrid, () => { clearDirty(); renderDevInvestmentPanel(); });
  scheduleDevTargetsPreview_();
}

/* ---------- 主畫面 ---------- */
function drawDevGrid() {
  const toolbar = document.getElementById('toolbar-devinvestment');
  const grid = document.getElementById('grid-devinvestment');
  if (!toolbar || !grid || !devSummary) return;
  const groups = devGroups_();
  const target = devIsTarget_();
  const commonPct = (() => {
    const cnt = {};
    devRows.forEach(r => { if (!devBlank_(r) && num(r.Amount)) { const k = devPctText_(r.ChallengeReductionPct); cnt[k] = (cnt[k] || 0) + 1; } });
    const k = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    return k === undefined ? '' : k;
  })();
  const prevAll = val('dev-all-pct');
  toolbar.innerHTML = `
    <div class="seg"><button type="button" class="seg-btn${devView_ === 'sum' ? ' active' : ''}" onclick="devView_='sum';drawDevGrid()">部門彙總</button><button type="button" class="seg-btn${devView_ === 'list' ? ' active' : ''}" onclick="devView_='list';drawDevGrid()">每一筆明細</button></div>
    ${target ? `<span class="dev-allpct">統一低減目標 <input id="dev-all-pct" type="text" inputmode="decimal" value="${esc(prevAll !== '' ? prevAll : commonPct)}" placeholder="例 10"> % <button type="button" class="btn secondary sm" onclick="devApplyAll_()">套用到全部部門</button></span>` : ''}
    <span class="spacer"></span>
    <button type="button" class="btn secondary" onclick="openDevPaste_()">從 Excel 貼上…</button>
    <button type="button" class="btn secondary" onclick="devAddDept_()">＋ 新增部門</button>
    <button type="button" class="btn" onclick="saveDevGrid()">儲存</button>`;

  const T = { sum: cs => groups.reduce((s, g) => s + g.sum(cs), 0), red: cs => groups.reduce((s, g) => s + g.red(cs), 0) };
  const units = num(devSummary.lifeCycleUnits);
  const kpis = `<div class="dev-kpis">
      <div class="dev-kpi"><span>投資總額</span><b>${fmt(T.sum() / 1e8, 2)}<small>億元</small></b></div>
      ${target ? `<div class="dev-kpi"><span>低減後</span><b class="good">${fmt(T.red() / 1e8, 2)}<small>億元</small></b></div>
      <div class="dev-kpi"><span>整體低減</span><b>${T.sum() ? devPctText_((1 - T.red() / T.sum()) * 100) : '0'}<small>%（少 ${fmt((T.sum() - T.red()) / 1e8, 2)} 億）</small></b></div>` : ''}
      <div class="dev-kpi"><span>單台攤提（LC ${fmt(units)} 台）</span><b>${units ? fmt((target ? T.red() : T.sum()) / units) : '-'}<small>元/台</small></b></div>
    </div>`;

  let body;
  if (!groups.length) {
    body = emptyStateHtml('🏗️', '還沒有開發總投', '按「＋ 新增部門」一個一個填，或從 Excel 選含表頭的整塊（部門、模具、設備、費用、低減後、說明）複製進來。',
      `<div class="toolbar" style="justify-content:center;margin-top:12px;"><button type="button" class="btn" onclick="openDevPaste_()">從 Excel 貼上…</button><button type="button" class="btn secondary" onclick="devAddDept_()">＋ 新增部門</button></div>`);
  } else body = devView_ === 'list' ? devListHtml_() : devSheetHtml_(groups, T);

  grid.innerHTML = `${groups.length ? kpis : ''}${body}
    ${groups.length && devView_ === 'sum' ? `<div class="dev-legend">${target ? '<span><i class="sw red"></i>低減後（算出來的）</span>' : ''}
      <span><i class="tri"></i>這格有好幾筆或外幣，點一下在右側改</span><span><i class="sw dirty"></i>改過、還沒儲存</span><span>Enter 往下一格、Tab 往右一格</span></div>` : ''}
    <div class="card" style="margin-top:14px;">
      <div class="card-head"><h4>攤提落點 → 單台攤提</h4><span class="muted">隨畫面上的金額/低減%即時試算（含尚未儲存的變更）；損益表要儲存後才套用。</span></div>
      <div class="toolbar" style="margin-top:8px;">
        <label>攤提基準(台/月 × 12 × 年)
          <span style="display:flex;gap:6px;align-items:center;">
            <input id="dev-amort-vol" type="number" step="any" style="width:90px;" value="${esc(devSummary.amortMonthlyVolume)}" placeholder="台/月">
            ×12×<input id="dev-amort-years" type="number" step="any" style="width:70px;" value="${esc(devSummary.amortLifeCycleYears)}" placeholder="年">
            <button type="button" class="btn secondary sm" onclick="saveAmortBasis()">套用</button>
          </span>
        </label>
        <span class="muted">攤提用 LC 總台數 <b>${fmt(devSummary.lifeCycleUnits)}</b>（銷售構成推算 ${fmt(devSummary.salesMixLifeCycleUnits)}）</span>
        <span class="spacer"></span>
        <button type="button" class="btn ghost" onclick="addDevAmortTarget()">＋ 新增攤提落點科目</button>
      </div>
      <div id="dev-targets-box">${devTargetsTableHtml()}</div>
    </div>`;
  if (devView_ === 'sum' && groups.length) {
    makeSortable(document.getElementById('dev-body'), {
      items: 'tr[data-key]',
      onEnd: keys => { devReorder_(keys.map(k => groups[Number(k)].name)); }
    });
  }
  if (devDrawer_) drawDevDrawer_();
}

function devSheetHtml_(groups, T) {
  const target = devIsTarget_();
  const head = `<thead>
    <tr><th rowspan="2" class="c-dept">部門</th><th colspan="4">投資金額（元）</th>
      ${target ? '<th rowspan="2">低減目標</th><th colspan="4" class="red">低減後（元）</th>' : ''}<th rowspan="2" class="c-note">說明</th></tr>
    <tr>${DEV_COLS_.map(c => `<th class="${c === '費用' ? 'exp' : ''}">${c}</th>`).join('')}<th>總計</th>
      ${target ? DEV_COLS_.map(c => `<th class="red">${c}</th>`).join('') + '<th class="red">總計</th>' : ''}</tr></thead>`;
  const rowsHtml = groups.map((g, r) => {
    const n = esc(g.name), js = devJs_(g.name);
    const note = devNotes[g.name];
    const fallback = g.idx.map(i => devRows[i].Notes).filter(x => String(x || '').trim()).join('；');
    return `<tr data-key="${r}" data-dept="${n}" class="${g.sum() ? '' : 'empty'}">
      <td class="c-dept"><div class="dept-cell">${dragHandleHtml('拖曳調整部門順序')}<button type="button" class="dept-btn" onclick="openDevDrawer_(${js})" data-tip="看每一筆、改攤提落點與說明">${esc(devDeptLabel_(g.name))}<span class="chev">›</span></button></div></td>
      ${DEV_COLS_.map(c => devAmtCellHtml_(g, c, r)).join('')}
      <td class="num tot">${devAmt_(g.sum())}</td>
      ${target ? devPctCellHtml_(g, r) + DEV_COLS_.map(c => `<td class="num red">${devAmt_(g.red([c]))}</td>`).join('') + `<td class="num red tot">${devAmt_(g.red())}</td>` : ''}
      <td class="c-note${devChanged_.has(g.name + '|note') ? ' dirty' : ''}"><button type="button" onclick="openDevDrawer_(${js}, 'note')" data-tip="點一下修改說明">${
        note !== undefined && note !== '' ? esc(note) : fallback ? `<span class="muted">${esc(fallback)}</span>` : '<span class="muted">＋ 加說明</span>'}</button></td>
    </tr>`;
  }).join('');
  const foot = `<tr class="total"><td class="c-dept">合計</td>${DEV_COLS_.map(c => `<td class="num">${devAmt_(T.sum([c]))}</td>`).join('')}<td class="num">${devAmt_(T.sum())}</td>
    ${target ? `<td class="pct">${T.sum() ? devPctText_((1 - T.red() / T.sum()) * 100) + '%' : '-'}</td>${DEV_COLS_.map(c => `<td class="num">${devAmt_(T.red([c]))}</td>`).join('')}<td class="num">${devAmt_(T.red())}</td>` : ''}<td></td></tr>`;
  return `<div class="dev-sheet-wrap"><table class="dev-sheet">${head}<tbody id="dev-body">${rowsHtml}</tbody><tfoot>${foot}</tfoot></table></div>`;
}
function devAmtCellHtml_(g, c, r) {
  const cls = `num${c === '費用' ? ' exp' : ''}${devChanged_.has(g.name + '|' + c) ? ' dirty' : ''}`;
  const js = devJs_(g.name), n = esc(g.name);
  if (g.locked(c)) {
    const idx = g.cat[c];
    const fx = Array.from(new Set(idx.map(i => devRows[i].Currency || BASE_CURRENCY_).filter(x => x !== BASE_CURRENCY_)));
    return `<td class="${cls}"><button type="button" class="lock" onclick="openDevDrawer_(${js})" data-tip="${idx.length} 筆${fx.length ? '，含 ' + esc(fx.join('、')) : ''}：點一下在右側修改">${devAmt_(g.sum([c]))}</button></td>`;
  }
  const v = g.sum([c]);
  return `<td class="${cls}"><input class="cell" data-r="${r}" data-c="${c}" type="text" inputmode="decimal" value="${v ? fmt(v) : ''}" placeholder="-"
    onfocus="this.value=this.value.replace(/,/g,'');this.select()" onblur="devCellBlur_(this)" onchange="devSetAmt_(${js},'${c}',this.value)" onkeydown="devNav_(event)" aria-label="${n} ${c}"></td>`;
}
function devPctCellHtml_(g, r) {
  const js = devJs_(g.name), n = esc(g.name);
  const cls = `pct${devChanged_.has(g.name + '|pct') ? ' dirty' : ''}`;
  if (!g.sum()) return `<td class="${cls} muted">-</td>`;
  const all = g.pcts(null), as = g.pcts(DEV_ASSET_), fe = g.pcts(['費用']);
  if (all.length <= 1) {
    return `<td class="${cls}"><div class="pct-wrap"><input class="cell" data-r="${r}" data-c="pct" type="text" inputmode="decimal" value="${esc(all[0] || '')}"
      onfocus="this.select()" onchange="devSetPct_(${js}, this.value)" onkeydown="devNav_(event)" aria-label="${n} 低減目標%"></div></td>`;
  }
  const label = as.length === 1 && fe.length === 1 ? `資 ${as[0]}%｜費 ${fe[0]}%` : `混合 ${devPctText_((1 - g.red() / g.sum()) * 100)}%`;
  return `<td class="${cls}"><button type="button" class="lock" onclick="openDevDrawer_(${js})" data-tip="各筆的低減%不同，點一下修改">${label}</button></td>`;
}
function devCellBlur_(el) { const v = String(el.value).replace(/,/g, '').trim(); el.value = v === '' ? '' : fmt(num(v)); }
/** Enter 往下一格、Shift+Enter 往上(跳過不能直接改的格子) */
function devNav_(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const t = e.target, step = e.shiftKey ? -1 : 1, c = t.dataset.c;
  let r = Number(t.dataset.r) + step;
  t.blur();
  setTimeout(() => {
    for (; r >= 0 && r < 500; r += step) {
      const el = document.querySelector(`#dev-body [data-r="${r}"][data-c="${c}"]`);
      if (el) { el.focus(); return; }
    }
  });
}
function devListHtml_() {
  const target = devIsTarget_();
  const live = devRows.map((r, i) => ({ r, i })).filter(x => !devBlank_(x.r) && (num(x.r.Amount) || x.r.TargetLineCode));
  const lineName = code => { const o = (devSummary.targetOptions || []).find(x => x.value === code); return o ? shortLineName(o.label) : (code || '(未選)'); };
  return `<div class="grid-scroll"><table class="grid-table dev-list">
    <thead><tr><th>部門</th><th>大類</th><th>項目</th><th>攤提落點</th><th>分攤車系</th><th>金額</th><th>幣別</th>${target ? '<th>低減%</th><th>低減後（元）</th>' : ''}</tr></thead>
    <tbody>${live.map(({ r }) => `<tr onclick="openDevDrawer_(${devJs_(devDeptName_(r))})" style="cursor:pointer;">
      <td class="row-head">${esc(devDeptLabel_(devDeptName_(r)))}</td><td>${esc(devCatOf_(r) || '-')}</td><td>${esc(r.Notes || '')}</td>
      <td>${esc(lineName(r.TargetLineCode))}</td><td>${esc(vehicleScopeLabel_(r.VehicleScope))}</td>
      <td class="calc">${fmt(num(r.Amount))}</td><td>${esc(r.Currency || BASE_CURRENCY_)}</td>
      ${target ? `<td class="calc">${devPctText_(r.ChallengeReductionPct)}%</td><td class="calc">${fmt(devTwd_(r) * (1 - devPct_(r) / 100))}</td>` : ''}</tr>`).join('')}</tbody>
  </table></div><p class="help">點一列打開那個部門的面板修改。</p>`;
}
function vehicleScopeLabel_(scope) {
  const ids = String(scope || '').split(',').map(x => x.trim()).filter(x => x);
  if (!ids.length) return '全車系';
  return ids.map(id => { const v = (devSummary.vehicles || []).find(x => x.VehicleID === id); return v ? (v.VehicleCode || id) : id; }).join('、');
}

/* ---------- 改數字 ---------- */
function devNewRow_(name, cat, amount, pct) {
  return { RowID: '', Department: name, TargetLineCode: devDefaultTarget_(cat), __category: cat, Amount: amount, Currency: BASE_CURRENCY_,
    ChallengeReductionPct: pct, Notes: '', VehicleScope: '' };
}
/** 部門加一筆：先用掉只有部門名稱的空列，否則插在這個部門最後一筆後面 */
function devInsertRow_(g, row) {
  const placeholder = g ? g.idx.find(i => !devCatOf_(devRows[i]) && !num(devRows[i].Amount) && !devRows[i].TargetLineCode) : undefined;
  if (placeholder !== undefined) { row.RowID = devRows[placeholder].RowID; devRows[placeholder] = row; return placeholder; }
  const at = g && g.idx.length ? g.idx[g.idx.length - 1] + 1 : devRows.length;
  devRows.splice(at, 0, row);
  return at;
}
function devSetAmt_(name, cat, value) {
  const raw = String(value).replace(/[,\s]/g, '');
  const v = raw === '' ? '' : num(raw);
  const g = devFindGroup_(name);
  if (g.cat[cat].length === 1) devRows[g.cat[cat][0]].Amount = v;
  else if (v !== '' && v !== 0) {
    if (!devDefaultTarget_(cat)) { toast(`這個車型還沒有「${cat}」的攤提落點科目，請先按「＋ 新增攤提落點科目」`, 'err', 4000); drawDevGrid(); return; }
    devInsertRow_(g, devNewRow_(name, cat, v, devInheritPct_(g, cat)));
  }
  devMark_(name + '|' + cat);
  drawDevGrid();
}
function devSetPct_(name, value, cats) {
  const p = String(value).replace(/[%\s]/g, '');
  devRows.forEach(r => { if (!devBlank_(r) && devDeptName_(r) === name && (!cats || cats.indexOf(devCatOf_(r)) !== -1)) r.ChallengeReductionPct = p === '' ? '' : num(p); });
  devMark_(name + '|pct');
  drawDevGrid();
}
/** 談定的是低減後金額：反推 % */
function devSetReduced_(name, value, cats) {
  const g = devFindGroup_(name), total = g.sum(cats);
  if (!total) return;
  const p = Math.round((1 - num(String(value).replace(/,/g, '')) / total) * 100 * 1e6) / 1e6;
  devSetPct_(name, p, cats);
}
function devApplyAll_() {
  const p = String(val('dev-all-pct')).replace(/[%\s]/g, '');
  if (p === '' || isNaN(Number(p))) { toast('請先填統一低減目標 %', 'err'); return; }
  devRows.forEach(r => {
    if (devBlank_(r) || num(r.ChallengeReductionPct) === num(p) && r.ChallengeReductionPct !== '') return;
    r.ChallengeReductionPct = num(p);
    devMark_(devDeptName_(r) + '|pct');
  });
  drawDevGrid();
}
function devAddDept_() {
  const names = new Set(devGroups_().map(g => g.name));
  let n = 1; while (names.has('新部門' + (n > 1 ? n : ''))) n++;
  const name = '新部門' + (n > 1 ? n : '');
  devRows.push({ RowID: '', Department: name, TargetLineCode: '', Amount: '', Currency: BASE_CURRENCY_, ChallengeReductionPct: devInheritPct_(null), Notes: '', VehicleScope: '' });
  devMark_(name + '|new');
  drawDevGrid();
  openDevDrawer_(name, 'name');
}
function devReorder_(names) {
  const byName = {};
  devRows.forEach(r => { if (!devBlank_(r)) (byName[devDeptName_(r)] = byName[devDeptName_(r)] || []).push(r); });
  devRows = [].concat.apply([], names.map(n => byName[n] || [])).concat(devRows.filter(devBlank_));
  devMark_('order');
  drawDevGrid();
}

/* ---------- 右側面板：一個部門的全部細節 ---------- */
function openDevDrawer_(name, focus) {
  const g = devFindGroup_(name);
  if (!g) return;
  closeDevDrawer_(true);
  devDrawer_ = { dept: name, split: g.pcts(null).length > 1 };
  const bg = document.createElement('div'); bg.className = 'dev-drawer-bg'; bg.id = 'dev-drawer-bg'; bg.onclick = () => closeDevDrawer_();
  const dr = document.createElement('aside'); dr.className = 'dev-drawer'; dr.id = 'dev-drawer'; dr.setAttribute('aria-label', devDeptLabel_(name));
  document.body.appendChild(bg); document.body.appendChild(dr);
  document.addEventListener('keydown', devDrawerKey_);
  drawDevDrawer_(focus);
}
function devDrawerKey_(e) { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) closeDevDrawer_(); }
function closeDevDrawer_(silent) {
  ['dev-drawer', 'dev-drawer-bg'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  document.removeEventListener('keydown', devDrawerKey_);
  const had = !!devDrawer_;
  devDrawer_ = null;
  if (!silent && had) drawDevGrid();
}
function devSetSplit_(on) {
  const g = devFindGroup_(devDrawer_.dept);
  devDrawer_.split = on;
  // 改回一個 %：用目前整體的低減比例(低減後合計不變)
  if (!on && g && g.sum() && g.pcts(null).length > 1) devSetPct_(g.name, Math.round((1 - g.red() / g.sum()) * 100 * 1e6) / 1e6);
  else drawDevDrawer_();
}
function drawDevDrawer_(focus) {
  const dr = document.getElementById('dev-drawer');
  if (!dr || !devDrawer_) return;
  const g = devFindGroup_(devDrawer_.dept);
  if (!g) { closeDevDrawer_(); return; }
  const n = esc(g.name), js = devJs_(g.name), q = cats => cats ? `['${cats.join("','")}']` : 'null';
  const target = devIsTarget_();
  const pctLine = (label, cats) => {
    const ps = g.pcts(cats);
    return `<div class="pct-row"><span>${label}</span>
      <input type="text" inputmode="decimal" value="${ps.length === 1 ? esc(ps[0]) : ''}" placeholder="${ps.length > 1 ? '混合' : ''}" onchange="devSetPct_(${js}, this.value, ${q(cats)})" aria-label="${label}低減%"><span>%</span>
      <span class="res">${devAmt_(g.sum(cats))} → ${devAmt_(g.red(cats))}</span>
      <div class="or">或直接填談定的低減後金額 <input type="text" inputmode="decimal" placeholder="${devAmt_(g.red(cats))}" onchange="devSetReduced_(${js}, this.value, ${q(cats)})" aria-label="${label}低減後金額"></div></div>`;
  };
  const groups = devDrawer_.split ? [['資產', DEV_ASSET_], ['費用', ['費用']]].filter(x => g.sum(x[1]) > 0) : [['全部', null]];
  const opts = devSummary.targetOptions || [];
  const curs = devSummary.currencies && devSummary.currencies.length ? devSummary.currencies : [BASE_CURRENCY_];
  const itemHtml = (i, cat) => {
    const r = devRows[i];
    const catOpts = cat ? opts.filter(o => o.category === cat) : opts;
    const cur = r.Currency || BASE_CURRENCY_;
    return `<div class="dev-item">
      <input type="text" value="${esc(r.Notes || '')}" placeholder="項目（可空白）" onchange="devRows[${i}].Notes=this.value;devMark_(${js}+'|items')" aria-label="項目">
      <input class="amt" type="text" inputmode="decimal" value="${r.Amount === '' ? '' : fmt(num(r.Amount))}" placeholder="金額" onfocus="this.value=this.value.replace(/,/g,'');this.select()"
        onchange="devRows[${i}].Amount=this.value.replace(/[,\\s]/g,'')===''?'':num(this.value.replace(/[,\\s]/g,''));devMark_(${js}+'|${cat}');drawDevGrid()" aria-label="金額">
      <select onchange="devRows[${i}].Currency=this.value;devMark_(${js}+'|${cat}');drawDevGrid()" aria-label="幣別">${curs.concat(curs.indexOf(cur) === -1 ? [cur] : []).map(c => `<option${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <button type="button" class="btn ghost sm" onclick="devRemoveRow_(${i})" aria-label="刪除這筆">✕</button>
      <div class="meta">攤提到 <select onchange="devRows[${i}].TargetLineCode=this.value;devRows[${i}].__category=devTargetCategoryOf(this.value)||devRows[${i}].__category;devMark_(${js}+'|${cat}');drawDevGrid()" aria-label="攤提落點">
          ${r.TargetLineCode ? '' : '<option value="">(請選擇)</option>'}${catOpts.map(o => `<option value="${esc(o.value)}"${o.value === r.TargetLineCode ? ' selected' : ''}>${esc(shortLineName(o.label))}</option>`).join('')}</select>
        分攤 <button type="button" class="btn ghost sm" onclick="editDevScope(${i})">${esc(vehicleScopeLabel_(r.VehicleScope))} ▾</button>
        ${target ? `<span>· 低減 ${devPctText_(r.ChallengeReductionPct)}%</span>` : ''}</div>
      ${cur !== BASE_CURRENCY_ ? `<div class="fx">${esc(cur)} ${fmt(num(r.Amount))} × 匯率 ${fmt(devRate_(cur), 4)} ≈ ${fmt(devTwd_(r))} 元${(devSummary.fxRates || {})[cur] === undefined ? '（這個幣別還沒設定匯率，到「參數與匯率」設定）' : ''}</div>` : ''}
    </div>`;
  };
  const catBlock = c => `<div class="dev-cat" data-cat="${c}"><div class="dev-cat-h"><b>${c || '未分類（舊資料）'}</b><span class="s">${devAmt_(g.sum(c ? [c] : ['']))}${target ? ` → <em>${devAmt_(g.red(c ? [c] : ['']))}</em>` : ''}</span></div>
      ${g.cat[c].map(i => itemHtml(i, c)).join('')}
      ${c ? `<div class="add"><button type="button" class="btn ghost sm" onclick="devAddItem_(${js},'${c}')">＋ 加一筆${c}</button></div>` : ''}</div>`;
  dr.innerHTML = `
    <header><input id="dev-dr-name" type="text" value="${n}" placeholder="部門名稱" onchange="devRenameDept_(${js}, this.value)" aria-label="部門名稱">
      <button type="button" class="btn ghost" onclick="closeDevDrawer_()" aria-label="關閉">✕</button></header>
    <div class="dbody">
      ${target ? `<div class="sect"><h4>低減目標</h4><div class="pct-box">
        <div class="seg"><button type="button" class="seg-btn${devDrawer_.split ? '' : ' active'}" onclick="devSetSplit_(false)">整個部門一個 %</button><button type="button" class="seg-btn${devDrawer_.split ? ' active' : ''}" onclick="devSetSplit_(true)">資產、費用分開</button></div>
        ${g.sum() ? groups.map(x => pctLine(x[0], x[1])).join('') : '<span class="muted">先在下面加一筆投資。</span>'}
        ${devDrawer_.split ? '<span class="muted" style="font-size:12px">資產 = 模具＋設備。</span>' : ''}
      </div></div>` : ''}
      <div class="sect"><h4>投資明細</h4><div class="dev-cats">${DEV_COLS_.map(catBlock).join('')}${g.cat[''].length ? catBlock('') : ''}</div></div>
      <div class="sect"><h4>說明</h4><textarea id="dev-dr-note" class="dev-note-area" placeholder="這個部門的說明（GATE 報告「開發總投 by 部門」的說明欄）"
        onchange="devNotes[${js}]=this.value;devMark_(${js}+'|note')">${esc(devNotes[g.name] || '')}</textarea></div>
    </div>
    <footer><button type="button" class="btn ghost danger" onclick="devDeleteDept_(${js})">刪除這個部門</button><span class="spacer"></span><button type="button" class="btn" onclick="closeDevDrawer_()">完成</button></footer>`;
  const f = focus === 'note' ? 'dev-dr-note' : focus === 'name' ? 'dev-dr-name' : null;
  if (f) { const el = document.getElementById(f); el.focus(); if (el.select) el.select(); }
}
function devAddItem_(name, cat) {
  if (!devDefaultTarget_(cat)) { toast(`這個車型還沒有「${cat}」的攤提落點科目，請先按「＋ 新增攤提落點科目」`, 'err', 4000); return; }
  const g = devFindGroup_(name);
  devInsertRow_(g, devNewRow_(name, cat, '', devInheritPct_(g, cat)));
  devMark_(name + '|' + cat);
  drawDevGrid();
}
function devRemoveRow_(i) {
  const name = devDeptName_(devRows[i]), cat = devCatOf_(devRows[i]);
  const g = devFindGroup_(name);
  // 部門最後一筆：留下只有部門名稱的空列，部門不會消失
  if (g && g.idx.length === 1) Object.assign(devRows[i], { TargetLineCode: '', __category: '', Amount: '', Notes: '', VehicleScope: '' });
  else if (!devRows[i].RowID) devRows.splice(i, 1);
  else devRows[i] = { RowID: devRows[i].RowID, Department: '', TargetLineCode: '', Amount: '', Currency: BASE_CURRENCY_, ChallengeReductionPct: '', Notes: '', VehicleScope: '' };
  devMark_(name + '|' + cat);
  drawDevGrid();
}
function devRenameDept_(old, nu) {
  nu = String(nu || '').trim();
  if (nu === old) return;
  if (!nu) { toast('部門名稱不能空白', 'err'); drawDevDrawer_(); return; }
  if (devGroups_().some(g => g.name === nu)) { toast(`已經有「${nu}」這個部門`, 'err'); drawDevDrawer_(); return; }
  devRows.forEach(r => { if (!devBlank_(r) && devDeptName_(r) === old) r.Department = nu; });
  if (devNotes[old] !== undefined) { devNotes[nu] = devNotes[old]; delete devNotes[old]; }
  Array.from(devChanged_).forEach(k => { if (k.indexOf(old + '|') === 0) { devChanged_.delete(k); devChanged_.add(nu + k.slice(old.length)); } });
  devDrawer_.dept = nu;
  devMark_(nu + '|name');
  drawDevGrid();
}
function devDeleteDept_(name) {
  confirmModal('刪除部門', `要刪除「${esc(devDeptLabel_(name))}」和它底下的每一筆投資嗎？（按儲存之前都可以放棄）`, '刪除', true).then(ok => {
    if (!ok) return;
    devRows = devRows.filter(r => devBlank_(r) || devDeptName_(r) !== name || r.RowID)
      .map(r => !devBlank_(r) && devDeptName_(r) === name ? { RowID: r.RowID, Department: '', TargetLineCode: '', Amount: '', Currency: BASE_CURRENCY_, ChallengeReductionPct: '', Notes: '', VehicleScope: '' } : r);
    delete devNotes[name];
    devMark_(name + '|del');
    closeDevDrawer_();
  });
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
    devMark_(devDeptName_(devRows[i]) + '|scope');
    drawDevGrid();
  });
}

/* ---------- 攤提落點彙總 / 攤提基準 / 新增攤提落點 / 儲存 ---------- */
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
/** 送給後端的列：拿掉畫面用的欄位 */
function devRowsForSave_() {
  return devRows.map(r => {
    const o = {};
    Object.keys(r).forEach(k => { if (k.indexOf('__') !== 0) o[k] = r[k]; });
    return o;
  });
}
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
      .previewDevInvestmentSummary(currentScenarioId, devRowsForSave_().filter(r => !devBlank_(r)));
  }, 400);
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
      devSummary = Object.assign(summary, { rows: summary.rows });
      if (!isDirty_()) { devRows = summary.rows.map(r => Object.assign({}, r)); devNotes = Object.assign({}, summary.deptNotes || {}); }
      drawDevGrid();
      setStatus('devinvestment', '已套用攤提基準', 'ok');
    }))
    .withFailureHandler(err => setStatus('devinvestment', '錯誤：' + err.message, 'err'))
    .saveAmortBasis(currentScenarioId, val('dev-amort-vol'), val('dev-amort-years'));
}
function saveDevGrid() {
  // 有金額卻沒有攤提落點：攤不到任何科目，先擋下來並打開那個部門
  const miss = devRows.find(r => !devBlank_(r) && num(r.Amount) && !r.TargetLineCode);
  if (miss) {
    setStatus('devinvestment', `「${devDeptLabel_(devDeptName_(miss))}」有一筆有金額但沒選攤提落點，請在右側面板選擇。`, 'err');
    openDevDrawer_(devDeptName_(miss));
    return;
  }
  const names = new Set(devGroups_().map(g => g.name));
  const notes = {};
  Object.keys(devNotes).forEach(k => { if (names.has(k) && String(devNotes[k] || '').trim()) notes[k] = devNotes[k]; });
  setStatus('devinvestment', '儲存中...');
  google.script.run
    .withSuccessHandler(safeHandler(summary => {
      clearDirty();
      panelDataCache_[panelCacheKey_('devinvestment', 'scenario')] = summary;
      devSummary = summary;
      devRows = summary.rows.map(r => Object.assign({}, r));
      devNotes = Object.assign({}, summary.deptNotes || {});
      devChanged_.clear();
      drawDevGrid();
      setStatus('devinvestment', '已儲存', 'ok');
    }))
    .withFailureHandler(err => setStatus('devinvestment', '錯誤：' + err.message, 'err'))
    .saveDevInvestmentGrid(currentScenarioId, devRowsForSave_(), notes);
}

/* ---------- 從 Excel 貼上 ----------
 * Excel 的開發總投 by 部門：部門 | 模具 設備 費用 總計 | (低減後)模具 設備 費用 總計 | 說明。
 * 同名的欄位出現兩次：第一次是投資金額、第二次是低減後；低減後只用來反推 %，總計只用來檢查。
 */
function devParseTsv_(text) {
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"' && cell === '') q = true;
    else if (ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
}
function devPasteNum_(s) {
  s = String(s === undefined || s === null ? '' : s).trim();
  if (s === '' || s === '-' || s === '—' || s === '－') return 0;
  const neg = /^\(.*\)$/.test(s);
  const v = Number(s.replace(/[(),\s]/g, ''));
  return isNaN(v) ? NaN : neg ? -v : v;
}
function openDevPaste_() {
  if (!devSummary) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'modal wide dev-paste';
  dlg.innerHTML = `
    <div class="modal-head"><h3>從 Excel 貼上</h3><div class="dev-steps"><span class="on">① 貼上</span>›<span id="dev-st2">② 看哪些會變</span>›<span>③ 套用</span></div></div>
    <div class="modal-body">
      <div class="dev-drop"><p>在 Excel 選<b>含表頭</b>的整塊（部門、模具、設備、費用、總計${devIsTarget_() ? '、低減後那一組' : ''}、說明）→ Ctrl+C → 點下面的框 → Ctrl+V。</p>
        <textarea id="dev-paste-text" spellcheck="false" placeholder="在這裡 Ctrl+V" aria-label="貼上 Excel 的內容"></textarea></div>
      <div class="dev-opts">
        <label>Excel 的單位 <select id="dev-o-unit"><option value="1">元</option><option value="1000">千元</option><option value="10000">萬元</option></select></label>
        <label>Excel 裡沒有的部門 <select id="dev-o-missing"><option value="keep">保留</option><option value="delete">刪除</option></select></label>
        <label>有好幾筆或外幣的格子 <select id="dev-o-multi"><option value="skip">先不改，留給我處理</option><option value="scale">各筆等比例調整</option></select></label>
      </div>
      <div id="dev-paste-preview"></div>
    </div>
    <div class="modal-foot"><span class="muted" style="font-size:12.5px;margin-right:auto;">套用後跟手動改的一樣，改過的格子會標黃色，按「儲存」才會存。</span>
      <button type="button" class="btn secondary" id="dev-paste-cancel">取消</button>
      <button type="button" class="btn" id="dev-paste-ok" disabled>套用</button></div>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dlg.querySelector('#dev-paste-cancel').onclick = close;
  dlg.querySelector('#dev-paste-ok').onclick = () => { if (devApplyPaste_()) close(); };
  dlg.querySelector('#dev-paste-text').addEventListener('input', devPreviewPaste_);
  ['dev-o-unit', 'dev-o-missing', 'dev-o-multi'].forEach(id => dlg.querySelector('#' + id).addEventListener('change', devPreviewPaste_));
  dlg.showModal();
  dlg.querySelector('#dev-paste-text').focus();
}
/** 解析並跟目前資料比對：每一項 { kind: todo|chg|new|note|same, dept, what, why(HTML), act } */
function devPlanPaste_() {
  const text = val('dev-paste-text');
  if (!text.trim()) return { empty: true };
  const unit = num(val('dev-o-unit')) || 1, missingMode = val('dev-o-missing'), multiMode = val('dev-o-multi');
  const target = devIsTarget_();
  const grid = devParseTsv_(text);
  const hi = grid.findIndex(r => r.some(c => String(c).trim() === '部門'));
  if (hi < 0) return { error: '找不到「部門」表頭。請連表頭那一列一起複製。' };
  const h = grid[hi].map(c => String(c).trim());
  const col = { dept: h.indexOf('部門'), note: ['說明', '備註'].map(x => h.indexOf(x)).find(x => x >= 0) };
  if (col.note === undefined) col.note = -1;
  DEV_COLS_.concat(['總計']).forEach(c => {
    const at = h.reduce((a, x, i) => (x === c ? a.concat(i) : a), []);
    col['a' + c] = at.length ? at[0] : -1;
    col['r' + c] = at.length > 1 ? at[1] : -1;
  });
  if (DEV_COLS_.every(c => col['a' + c] < 0)) return { error: '表頭裡找不到 模具／設備／費用。' };
  const groups = devGroups_(), items = [], seen = {};
  const add = (kind, dept, what, why, act) => items.push({ kind, dept, what, why, act });
  const hasRed = DEV_COLS_.some(c => col['r' + c] >= 0);
  if (target && !hasRed) add('todo', '（全部）', '低減後', '沒有第二組 模具／設備／費用：低減% 維持目前的設定', null);
  if (!target && hasRed) add('same', '（全部）', '低減後', '現況情境不套低減，低減後那一組不匯入', null);
  grid.slice(hi + 1).forEach(r => {
    const name = String(r[col.dept] || '').trim();
    if (!name || /^(合計|總計|小計)$/.test(name)) return;
    if (seen[name]) { add('todo', name, '重複', '出現兩次，只用第一列', null); return; }
    seen[name] = true;
    const g = groups.find(x => x.name === name);
    let sum = 0;
    DEV_COLS_.forEach(c => {
      const a = col['a' + c] >= 0 ? devPasteNum_(r[col['a' + c]]) : 0;
      const rd = target && col['r' + c] >= 0 ? devPasteNum_(r[col['r' + c]]) : null;
      if (isNaN(a) || (rd !== null && isNaN(rd))) { add('todo', name, c, '不是數字，這一格略過', null); return; }
      const amt = a * unit, red = rd === null ? null : rd * unit;
      sum += amt;
      const idx = g ? g.cat[c] : [];
      const cur = idx.reduce((s, i) => s + devTwd_(devRows[i]), 0);
      const curRed = idx.reduce((s, i) => s + devTwd_(devRows[i]) * (1 - devPct_(devRows[i]) / 100), 0);
      if (!amt && !cur) return;
      const pct = red === null || !amt ? null : (1 - red / amt) * 100;
      const curPct = cur ? (1 - curRed / cur) * 100 : null;
      const pctTxt = pct !== null && (curPct === null || Math.abs(pct - curPct) > 0.005) ? `，低減 ${curPct === null ? '' : devPctText_(curPct) + '% → '}<b>${devPctText_(pct)}%</b>` : '';
      const diff = amt - cur;
      const dTxt = `${devAmt_(cur)} → <b>${devAmt_(amt)}</b> <span class="${diff > 0 ? 'up' : 'down'}">(${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))})</span>`;
      const multi = idx.length > 1 || idx.some(i => (devRows[i].Currency || BASE_CURRENCY_) !== BASE_CURRENCY_);
      if (red !== null && amt && red > amt) add('todo', name, c, `低減後 ${fmt(red)} 比投資金額還大`, null);
      if (!idx.length) {
        if (!devDefaultTarget_(c)) add('todo', name, c, `${fmt(amt)}：這個車型還沒有「${c}」的攤提落點科目，先新增再貼`, null);
        else add('new', name, c, `<b>${fmt(amt)}</b>${pct !== null ? `，低減 <b>${devPctText_(pct)}%</b>` : ''}${g ? '' : '（新部門）'}`, { t: 'new', name, c, amt, pct });
      } else if (!amt) add('todo', name, c, `Excel 是空白或 -，目前 ${fmt(cur)}：套用後會清成 0`, { t: 'set', name, c, idx, amt: 0, pct: null });
      else if (Math.abs(diff) < 1) { if (pctTxt) add('chg', name, c, `金額不變${pctTxt}`, { t: 'pct', name, c, idx, pct }); else add('same', name, c, '一樣', null); }
      else if (multi && multiMode === 'skip') add('todo', name, c, `${dTxt}。這格有 ${idx.length} 筆${idx.some(i => (devRows[i].Currency || BASE_CURRENCY_) !== BASE_CURRENCY_) ? '（含外幣）' : ''}，Excel 只有合計，不知道怎麼分：先不改，請點部門名稱自己分`, null);
      else if (multi) add('chg', name, c, `${dTxt}，${idx.length} 筆等比例調整${pctTxt}`, { t: 'scale', name, c, idx, amt, cur, pct });
      else add('chg', name, c, dTxt + pctTxt, { t: 'set', name, c, idx, amt, pct });
    });
    const tot = col['a總計'] >= 0 ? devPasteNum_(r[col['a總計']]) * unit : 0;
    if (tot && !isNaN(tot) && Math.abs(tot - sum) >= 1) add('todo', name, '總計', `Excel 總計 ${fmt(tot)}，但模具＋設備＋費用 = ${fmt(sum)}（差 ${fmt(Math.abs(tot - sum))}）。以各大類為準，總計只用來檢查`, null);
    const note = col.note >= 0 ? String(r[col.note] || '').trim() : '';
    if (note && note !== String(devNotes[name] || '').trim()) add('note', name, '說明', esc(note).replace(/\n/g, '<br>'), { t: 'note', name, note });
    if (!g && !DEV_COLS_.some(c => col['a' + c] >= 0 && devPasteNum_(r[col['a' + c]]))) add('new', name, '部門', '（沒有金額）', { t: 'dept', name });
  });
  groups.filter(g => !seen[g.name]).forEach(g => add(missingMode === 'delete' ? 'todo' : 'same', devDeptLabel_(g.name), '整個部門',
    missingMode === 'delete' ? 'Excel 沒有這個部門：會刪除' : 'Excel 沒有這個部門：保留不動', missingMode === 'delete' ? { t: 'del', name: g.name } : null));
  if (!Object.keys(seen).length) return { error: '表頭底下沒有任何部門。' };
  return { items };
}
function devPreviewPaste_() {
  const p = devPlanPaste_(), box = document.getElementById('dev-paste-preview'), ok = document.getElementById('dev-paste-ok');
  if (!box) return;
  ok.disabled = !!(p.error || p.empty) || !p.items.some(i => i.act);
  document.getElementById('dev-st2').classList.toggle('on', !(p.error || p.empty));
  if (p.empty) { box.innerHTML = ''; return; }
  if (p.error) { box.innerHTML = `<div class="callout err">${esc(p.error)}</div>`; return; }
  const by = k => p.items.filter(i => i.kind === k);
  const sec = (k, title, open) => by(k).length ? `<details class="dev-grp" data-kind="${k}"${open ? ' open' : ''}><summary><span class="cnt k-${k}">${by(k).length}</span>${title}</summary><div class="rows">
    ${by(k).map(i => `<div class="prow"><b>${esc(i.dept)}</b><span class="muted">${esc(i.what)}</span><span>${i.why}</span></div>`).join('')}</div></details>` : '';
  box.innerHTML = `${sec('todo', '要你看一下', true)}${sec('chg', '會更新', true)}${sec('new', '會新增', true)}${sec('note', '說明會更新', false)}${sec('same', '不變', false)}`;
}
function devApplyPaste_() {
  const p = devPlanPaste_();
  if (p.error || p.empty) return false;
  // 依計畫逐項套用；索引在插入新列之前都還有效(set/scale/pct 先做，新增/刪除後做)
  const acts = p.items.map(i => i.act).filter(a => a);
  const round = v => v === null || v === undefined ? null : Math.round(v * 1e6) / 1e6;
  acts.filter(a => a.t === 'set' || a.t === 'scale' || a.t === 'pct').forEach(a => {
    const pct = round(a.pct);
    a.idx.forEach(i => {
      if (a.t === 'set') devRows[i].Amount = a.amt;
      if (a.t === 'scale') devRows[i].Amount = Math.round(num(devRows[i].Amount) * a.amt / a.cur * 100) / 100;
      if (pct !== null) devRows[i].ChallengeReductionPct = pct;
    });
    if (a.t !== 'pct') devMark_(a.name + '|' + a.c);
    if (pct !== null) devMark_(a.name + '|pct');
  });
  acts.filter(a => a.t === 'note').forEach(a => { devNotes[a.name] = a.note; devMark_(a.name + '|note'); });
  acts.filter(a => a.t === 'new' || a.t === 'dept').forEach(a => {
    const g = devFindGroup_(a.name);
    if (a.t === 'dept') { if (!g) devRows.push({ RowID: '', Department: a.name, TargetLineCode: '', Amount: '', Currency: BASE_CURRENCY_, ChallengeReductionPct: devInheritPct_(null), Notes: '', VehicleScope: '' }); devMark_(a.name + '|new'); return; }
    const pct = round(a.pct);
    devInsertRow_(g, devNewRow_(a.name, a.c, a.amt, pct !== null ? pct : devInheritPct_(g, a.c)));
    devMark_(a.name + '|' + a.c);
    if (pct !== null) devMark_(a.name + '|pct');
  });
  acts.filter(a => a.t === 'del').forEach(a => {
    devRows = devRows.filter(r => devBlank_(r) || devDeptName_(r) !== a.name || r.RowID)
      .map(r => !devBlank_(r) && devDeptName_(r) === a.name ? { RowID: r.RowID, Department: '', TargetLineCode: '', Amount: '', Currency: BASE_CURRENCY_, ChallengeReductionPct: '', Notes: '', VehicleScope: '' } : r);
    delete devNotes[a.name];
    devMark_(a.name + '|del');
  });
  drawDevGrid();
  toast('已套用，檢查一下標黃色的格子，再按儲存', 'ok', 3500);
  return true;
}
