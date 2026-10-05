/* ================= 目標反推與敏感度分析 =================
 * 「月銷要多少台才損益兩平？」「材料成本要降到多少才達標？」「售價 × 台數的組合下營業淨利是多少？」
 * 所有試算都只在記憶體裡算(後端 WhatIfService.gs)，不會改到任何已存檔的資料。
 */
let whatIfOptions = null;
const WHATIF_PREFS_KEY_ = 'plWhatIf.prefs.v1';
// 目標反推只有一張卡片(multi)：只選一項 = 單項反推；加到兩項以上 = 組合拳。以前單項(goal)、多項(multi)是兩張卡片。
let whatIfPrefs = {
  multi: { metric: 'K', basis: 'unit', target: 0, mode: 'share', levers: null },
  sens: { metric: 'K', basis: 'unit', row: 'volume', rowSteps: '-20,-10,0,10,20', col: 'price', colSteps: '-10,-5,0,5,10', inReport: true,
    rowMode: 'pct', rowValues: '', colMode: 'pct', colValues: '' }
};
function loadWhatIfPrefs_() {
  try {
    const p = JSON.parse(localStorage.getItem(WHATIF_PREFS_KEY_) || 'null');
    if (p && p.sens) Object.assign(whatIfPrefs.sens, p.sens);
    if (p && p.multi) Object.assign(whatIfPrefs.multi, p.multi);
    // 舊版的單項反推設定：組合拳還沒設定過時，沿用它當成唯一的一項
    if (p && p.goal && !(p.multi && Array.isArray(p.multi.levers) && p.multi.levers.length)) {
      Object.assign(whatIfPrefs.multi, { metric: p.goal.metric || 'K', basis: p.goal.basis || 'unit', target: p.goal.target || 0,
        levers: [{ driver: p.goal.driver || 'volume', share: '', capPct: '', fixed: '' }] });
    }
  } catch (e) { /* 用預設 */ }
}
function saveWhatIfPrefs_() {
  try { localStorage.setItem(WHATIF_PREFS_KEY_, JSON.stringify(whatIfPrefs)); } catch (e) { /* 存不了就算了 */ }
}
/** driver 物件 ⇄ 下拉選單的值 */
function driverKey_(d) { return d.type === 'line' ? 'line:' + d.code : d.type === 'param' ? 'param:' + d.name : d.type === 'fx' ? 'fx:' + d.currency : d.type; }
function driverFromKey_(k) {
  const [t, x] = String(k).split(/:(.*)/);
  if (t === 'line') return { type: 'line', code: x };
  if (t === 'param') return { type: 'param', name: x };
  if (t === 'fx') return { type: 'fx', currency: x };
  return { type: t };
}
function whatIfDriverInfo_(key) { return whatIfOptions && whatIfOptions.drivers.find(d => driverKey_(d.driver) === key); }
function driverOptionsHtml_(selected) {
  const groups = {};
  whatIfOptions.drivers.forEach(d => { const g = d.group || '常用'; (groups[g] = groups[g] || []).push(d); });
  return Object.keys(groups).map(g => `<optgroup label="${esc(g)}">${groups[g].map(d => {
    const k = driverKey_(d.driver);
    return `<option value="${esc(k)}"${k === selected ? ' selected' : ''}>${esc(d.label)}（目前 ${fmt(d.base, Math.abs(d.base) < 100 ? 2 : 0)}${d.unit ? ' ' + esc(d.unit) : ''}）</option>`;
  }).join('')}</optgroup>`).join('');
}
function metricOptionsHtml_(selected) {
  return whatIfOptions.metrics.map(m => `<option value="${esc(m.code)}"${m.code === selected ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
}
function whatIfMetricLabel_(code, basis) {
  const m = whatIfOptions.metrics.find(x => x.code === code);
  return (m ? m.label : code) + (basis === 'month' ? '（月總額）' : '（單台）');
}

function renderWhatIfPanel() {
  const panel = document.getElementById('panel-whatif');
  if (!requireScope('whatif', true)) return;
  loadWhatIfPrefs_();
  wfPrefs.unit = loadAmountUnit_(wfPrefs.unit);   // 結果的瀑布圖跟全系統用同一個金額單位
  panel.innerHTML = `<p class="page-intro">用目前情境 <b>${esc(currentScenario ? scenarioLabel(currentScenario) : '')}</b> 的資料試算「如果…會怎樣」。
    <b>只在畫面上試算，不會改到任何已存檔的數字。</b></p><div id="whatif-body"><p class="muted">載入中...</p></div>`;
  google.script.run
    .withSuccessHandler(safeHandler(opts => { whatIfOptions = opts; drawWhatIf_(); }))
    .withFailureHandler(err => { document.getElementById('whatif-body').innerHTML = `<div class="callout err">${esc(err.message)}</div>`; })
    .getWhatIfOptions(currentScenarioId);
}

function drawWhatIf_() {
  const s = whatIfPrefs.sens;
  const body = document.getElementById('whatif-body');
  if (!body || !whatIfOptions) return;
  // 營業淨利(K)等預設科目可能被刪掉或換掉：記住的指標不存在時改看營業淨利(K 被刪掉時是損益表最後一行總計)
  const metrics = whatIfOptions.metrics || [];
  const profit = profitCodeOf_(whatIfOptions);
  const fallback = metrics.some(m => m.code === profit) ? profit : metrics.length ? metrics[metrics.length - 1].code : 'K';
  [s, whatIfPrefs.multi].forEach(p => { if (!metrics.some(m => m.code === p.metric)) p.metric = fallback; });
  const basisSeg = (scope, cur) => `<div class="seg">
      <button type="button" class="seg-btn${cur === 'unit' ? ' active' : ''}" onclick="whatIfPrefs.${scope}.basis='unit';saveWhatIfPrefs_();drawWhatIf_()">單台</button>
      <button type="button" class="seg-btn${cur === 'month' ? ' active' : ''}" onclick="whatIfPrefs.${scope}.basis='month';saveWhatIfPrefs_();drawWhatIf_()">月總額</button></div>`;
  body.innerHTML = `
    ${multiGoalCardHtml_()}

    <div class="card">
      <div class="card-head"><h3>敏感度分析</h3><span class="muted">兩項假設同時變動時，結果會落在哪裡（中間框起來的是目前的數字）</span>
        <span class="spacer"></span>
        <label class="chk"><input type="checkbox" ${s.inReport ? 'checked' : ''} onchange="whatIfPrefs.sens.inReport=this.checked;saveWhatIfPrefs_()"> 放進 GATE 報告</label></div>
      <div class="field-row">
        <label class="field"><span>看哪個結果</span><select onchange="whatIfPrefs.sens.metric=this.value;saveWhatIfPrefs_()">${metricOptionsHtml_(s.metric)}</select></label>
        <label class="field"><span>&nbsp;</span>${basisSeg('sens', s.basis)}</label>
      </div>
      <div class="field-row" style="margin-top:12px;">${sensAxisFieldsHtml_('row', '直列')}</div>
      <div class="field-row" style="margin-top:12px;">${sensAxisFieldsHtml_('col', '橫列')}
        <button type="button" class="btn" style="align-self:flex-end;" onclick="runSensitivity_()">產生表格</button>
      </div>
      <div id="wi-sens-result" style="margin-top:14px;"></div>
    </div>`;
  installLeverSort_();
  runSensitivity_();
}

/** 常見問題：一鍵帶入目標與調整項目。單項的直接算；組合拳要先確認目標值，不自動算 */
function whatIfPreset_(kind) {
  const m = whatIfPrefs.multi;
  const profit = profitCodeOf_(whatIfOptions);
  const one = driver => [{ driver, share: '', capPct: '', fixed: '' }];
  if (kind === 'breakeven-volume') Object.assign(m, { metric: profit, basis: 'unit', target: 0, levers: one('volume') });
  if (kind === 'breakeven-price') Object.assign(m, { metric: profit, basis: 'unit', target: 0, levers: one('price') });
  if (kind === 'material') {
    const lines = whatIfOptions.drivers.filter(d => d.driver.type === 'line').sort((a, b) => Math.abs(b.base) - Math.abs(a.base));
    Object.assign(m, { metric: profit, basis: 'unit', target: Math.max(0, Math.round((whatIfOptions.metrics.find(x => x.code === profit) || {}).value || 0)),
      levers: one(lines.length ? driverKey_(lines[0].driver) : 'volume') });
  }
  if (kind === 'combo') Object.assign(m, { metric: profit, mode: 'share', levers: defaultLevers_() });
  saveWhatIfPrefs_();
  drawWhatIf_();
  if (kind !== 'combo') runMultiGoal_();
  else { const t = document.getElementById('wi-multi-target'); if (t) { t.focus(); t.select(); } }
}

/** 只有一個調整項目：用單項反推(solveGoal)，達不到時會說明原因(例如賣越多虧越多) */
function runGoalSeek_() {
  const m = whatIfPrefs.multi, lever = m.levers[0];
  const box = document.getElementById('wi-multi-result');
  box.innerHTML = '<p class="muted">計算中...</p>';
  const info = whatIfDriverInfo_(lever.driver) || {};
  google.script.run
    .withSuccessHandler(safeHandler(r => {
      const digits = Math.abs(r.base) < 100 ? 2 : 0;
      if (!r.feasible) {
        box.innerHTML = `<div class="callout warn">${esc(r.message)}</div>`;
        return;
      }
      const pct = r.base ? (r.value / r.base - 1) * 100 : null;
      box.innerHTML = `<div class="goal-answer">
        <div class="goal-big">${esc(r.label)}：${fmt(r.base, digits)} → <b>${fmt(r.value, digits)}</b> ${esc(r.unit || '')}
          ${pct !== null ? `<span class="muted">（${signed_(pct, 1)}%）</span>` : ''}</div>
        <div class="muted">${esc(whatIfMetricLabel_(m.metric, m.basis))}：目前 ${fmt(r.metricBase)} → ${fmt(r.achieved)}（目標 ${fmt(num(m.target))}）。
          ${info.driver && info.driver.type === 'volume' ? '台數變動時，開發總投的攤提台數也一起變。' : ''}其他假設都維持目前的數字。</div>
        <div class="field-row" style="margin-top:8px;"><button type="button" class="btn secondary sm" id="wi-goal-save">另存成新情境…</button></div>
      </div>`;
      const btn = document.getElementById('wi-goal-save');
      if (btn) btn.onclick = () => saveWhatIfScenarioDialog_([{ driver: driverFromKey_(lever.driver), value: r.value }], `${r.label} ${fmt(r.base, digits)} → ${fmt(r.value, digits)}`);
    }))
    .withFailureHandler(err => { box.innerHTML = `<div class="callout err">${esc(err.message)}</div>`; })
    .solveGoal(currentScenarioId, { code: m.metric, basis: m.basis }, num(m.target), driverFromKey_(lever.driver));
}

function parseSteps_(text) {
  const arr = String(text || '').split(/[,，\s]+/).map(x => x.trim()).filter(x => x !== '').map(Number).filter(x => !isNaN(x));
  const uniq = Array.from(new Set(arr.concat([0]))).sort((a, b) => a - b);
  return uniq.slice(0, 11);
}
/** 驅動因子的實際值：基準 × (1 + 幅度%)；參數/匯率也是等比例(5% 稅率 +10% → 5.5%) */
function stepValues_(key, steps) {
  const info = whatIfDriverInfo_(key);
  const base = info ? info.base : 0;
  return steps.map(p => base * (1 + p / 100));
}
/* ---------------- 敏感度分析 ----------------
 * 每一軸可以用「變動幅度 %」(基準 × (1 + %))或直接輸入「自訂值」(例：匯率 4.5, 4.6, 4.8)。
 * 兩種方式都會自動帶入目前的值，表格中間框起來的就是目前的數字。
 */
function sensMode_(axis) { return whatIfPrefs.sens[axis + 'Mode'] === 'value' ? 'value' : 'pct'; }
/** 自訂值：逗號、分號、空白、換行分隔(不要加千分位) */
function parseSensValues_(text) {
  return String(text || '').split(/[,，;；\s]+/).map(x => x.trim()).filter(x => x !== '').map(Number).filter(x => isFinite(x));
}
/** 依基準值的量級取整(4.77 → 0.01、445,556 → 1,000)，切換成自訂值時預填用 */
function roundLike_(v, base) {
  const mag = Math.abs(base) > 0 ? Math.pow(10, Math.floor(Math.log10(Math.abs(base))) - 2) : 1;
  return Number((Math.round(v / mag) * mag).toPrecision(12));
}
function sensPrefill_(axis, base) {
  return parseSteps_(whatIfPrefs.sens[axis + 'Steps']).map(p => roundLike_(base * (1 + p / 100), base)).join(', ');
}
/**
 * 一軸實際要算的值：[{ value, label, sub, isBase }]
 *   %      → 值 = 基準 × (1 + %)，標題「-10%」、副標是實際值
 *   自訂值 → 值照輸入，標題是值、副標是跟目前差幾 %；目前的值一定會加進去(跟輸入的值幾乎一樣時視為同一個)
 */
function sensAxis_(axis, base) {
  const s = whatIfPrefs.sens;
  const dg = v => Math.abs(v) < 100 ? 2 : 0;
  if (sensMode_(axis) === 'pct') {
    return parseSteps_(s[axis + 'Steps']).map(p => {
      const value = base * (1 + p / 100);
      return { value, label: p === 0 ? '目前' : signed_(p) + '%', sub: fmt(value, dg(value)), isBase: p === 0 };
    });
  }
  const same = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(b), 1e-9) * 5e-4;
  const vals = parseSensValues_(s[axis + 'Values']).filter(v => !same(v, base)).slice(0, 10);
  vals.push(base);
  return vals.filter((v, i) => vals.findIndex(x => same(x, v)) === i).sort((a, b) => a - b).map(value => {
    const isBase = value === base;
    const pct = base ? (value / base - 1) * 100 : null;
    return { value, label: isBase ? '目前' : fmt(value, dg(value)),
      sub: isBase ? fmt(value, dg(value)) : pct === null ? '' : signed_(pct, Math.abs(pct) < 10 ? 1 : 0) + '%', isBase };
  });
}
function sensAxisFieldsHtml_(axis, name) {
  const s = whatIfPrefs.sens, mode = sensMode_(axis);
  const seg = `<div class="seg">
      <button type="button" class="seg-btn${mode === 'pct' ? ' active' : ''}" onclick="setSensMode_('${axis}','pct')" data-tip="目前的值 × (1 + %)">變動 %</button>
      <button type="button" class="seg-btn${mode === 'value' ? ' active' : ''}" onclick="setSensMode_('${axis}','value')" data-tip="直接輸入要試算的值，例如匯率 4.5, 4.6, 4.8">自訂值</button></div>`;
  const input = mode === 'pct'
    ? `<label class="field"><span>變動幅度（%，逗號分隔）</span><input type="text" id="wi-sens-${axis}-steps" value="${esc(s[axis + 'Steps'])}" style="width:180px;" oninput="whatIfPrefs.sens.${axis}Steps=this.value;saveWhatIfPrefs_()"></label>`
    : `<label class="field"><span>自訂值（逗號分隔，不要加千分位；目前的值會自動加入）</span><input type="text" id="wi-sens-${axis}-values" value="${esc(s[axis + 'Values'])}" style="width:300px;" oninput="whatIfPrefs.sens.${axis}Values=this.value;saveWhatIfPrefs_()"></label>`;
  return `<label class="field"><span>${name}：調整項目</span><select id="wi-sens-${axis}" onchange="setSensDriver_('${axis}',this.value)">${driverOptionsHtml_(s[axis])}</select></label>
    <div class="field"><span>&nbsp;</span>${seg}</div>${input}`;
}
function setSensMode_(axis, mode) {
  const s = whatIfPrefs.sens;
  s[axis + 'Mode'] = mode;
  if (mode === 'value' && !parseSensValues_(s[axis + 'Values']).length) {
    const info = whatIfDriverInfo_(s[axis]);
    s[axis + 'Values'] = info ? sensPrefill_(axis, info.base) : '';
  }
  saveWhatIfPrefs_();
  drawWhatIf_();
}
/** 換了調整項目：自訂值是上一個項目的數字，用不上了，依新項目的目前值重新預填 */
function setSensDriver_(axis, key) {
  const s = whatIfPrefs.sens;
  s[axis] = key;
  if (sensMode_(axis) === 'value') {
    const info = whatIfDriverInfo_(key);
    s[axis + 'Values'] = info ? sensPrefill_(axis, info.base) : '';
    const el = document.getElementById('wi-sens-' + axis + '-values');
    if (el) el.value = s[axis + 'Values'];
  }
  saveWhatIfPrefs_();
}
function runSensitivity_(targetBox, scenarioId, done) {
  const s = whatIfPrefs.sens;
  const box = targetBox || document.getElementById('wi-sens-result');
  if (!box) return;
  box.innerHTML = '<p class="muted">計算中...</p>';
  const go = opts => {
    const info = k => opts.drivers.find(d => driverKey_(d.driver) === k);
    const ri = info(s.row) || opts.drivers[0], ci = info(s.col) || opts.drivers[1];
    const rows = sensAxis_('row', ri.base), cols = sensAxis_('col', ci.base);
    google.script.run
      .withSuccessHandler(safeHandler(t => { box.innerHTML = sensitivityTableHtml_(t, rows, cols, s, opts); if (done) done(); }))
      .withFailureHandler(err => { box.innerHTML = `<div class="callout err">${esc(err.message)}</div>`; })
      .sensitivityTable(scenarioId || currentScenarioId, { code: s.metric, basis: s.basis }, ri.driver, rows.map(r => r.value), ci.driver, cols.map(c => c.value));
  };
  // 目標反推頁上按「產生表格」：沿用那一頁已經載入的選項。
  // 其他地方(GATE 報告)：那一頁不一定開過(whatIfOptions 還是 null)，開過也可能是別的情境或改資料前載的，一律重新抓
  if (!targetBox && whatIfOptions) go(whatIfOptions);
  else {
    google.script.run.withSuccessHandler(safeHandler(go)).withFailureHandler(err => { box.innerHTML = `<div class="callout err">${esc(err.message)}</div>`; })
      .getWhatIfOptions(scenarioId || currentScenarioId);
  }
}
function sensitivityTableHtml_(t, rows, cols, s, opts) {
  const all = [].concat.apply([], t.cells);
  const maxAbs = Math.max.apply(null, all.map(Math.abs).concat([1]));
  const metric = (opts.metrics.find(m => m.code === s.metric) || {}).label || s.metric;
  const color = v => {
    const a = Math.min(1, Math.abs(v) / maxAbs);
    return v >= 0 ? `rgba(28,138,89,${0.08 + a * 0.32})` : `rgba(210,60,60,${0.08 + a * 0.32})`;
  };
  return `<div class="grid-scroll"><table class="grid-table sens-table">
    <thead>
      <tr><th rowspan="2">${esc(t.rowLabel)} ↓ ／ ${esc(t.colLabel)} →</th>${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr>
      <tr>${cols.map(c => `<th class="th-sub">${esc(c.sub)}</th>`).join('')}</tr>
    </thead>
    <tbody>${t.cells.map((row, i) => `<tr>
      <td class="row-head">${esc(rows[i].label)} <span class="muted">${esc(rows[i].sub)}${rows[i].isBase || sensMode_('row') === 'pct' ? esc(t.rowUnit ? ' ' + t.rowUnit : '') : ''}</span></td>
      ${row.map((v, j) => `<td class="${rows[i].isBase && cols[j].isBase ? 'sens-base' : ''}${v < 0 ? ' negative' : ''}" style="background:${color(v)};">${fmt(v)}</td>`).join('')}
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="help">表內數字：${esc(metric)}${s.basis === 'month' ? '（月總額，元）' : '（加權平均，元/台）'}。綠色 = 正、紅色 = 負，顏色越深絕對值越大。</p>`;
}

/* ---------------- 目標反推(單項 / 組合拳) ----------------
 * 只選一項 = 單項反推(後端 solveGoal)。營業淨利的缺口通常不會只指派一個項目：售價、材料、銷量、開發總投…各負責一部分，
 * 加到兩項以上就是組合拳：每一項可以設「分攤比例」「最多調 ±%」或「固定值」(已經確定的數字)，後端 solveGoalMulti 一次算出每一項要調多少。
 */
function defaultLevers_() {
  const lines = whatIfOptions.drivers.filter(d => d.driver.type === 'line').sort((a, b) => Math.abs(b.base) - Math.abs(a.base));
  const out = [{ driver: 'price', share: 40, capPct: 3, fixed: '' }];
  if (lines[0]) out.push({ driver: driverKey_(lines[0].driver), share: 40, capPct: 5, fixed: '' });
  out.push({ driver: 'dev', share: 20, capPct: '', fixed: '' });
  return out;
}
function multiGoalCardHtml_() {
  const m = whatIfPrefs.multi;
  const known = k => whatIfDriverInfo_(k);
  m.levers = (Array.isArray(m.levers) ? m.levers : []).filter(l => known(l.driver));
  if (!m.levers.length) m.levers = [{ driver: 'volume', share: '', capPct: '', fixed: '' }];
  const single = m.levers.length === 1;
  const shareMode = !single && m.mode !== 'equal';
  const basisSeg = `<div class="seg">
      <button type="button" class="seg-btn${m.basis === 'unit' ? ' active' : ''}" onclick="whatIfPrefs.multi.basis='unit';saveWhatIfPrefs_();drawWhatIf_()">單台</button>
      <button type="button" class="seg-btn${m.basis === 'month' ? ' active' : ''}" onclick="whatIfPrefs.multi.basis='month';saveWhatIfPrefs_();drawWhatIf_()">月總額</button></div>`;
  const totalShare = m.levers.filter(l => l.fixed === '' || l.fixed === undefined).reduce((s, l) => s + num(l.share), 0);
  return `<div class="card" id="wi-multi">
    <div class="card-head"><h3>目標反推</h3><span class="muted">要讓某個結果達到目標值，要調哪些項目、調多少？只選一項 = 單項反推；多加幾項 = 缺口由好幾項一起分擔（組合拳）</span></div>
    <div class="tpl-row"><span class="muted">常見問題：</span>
      <button type="button" class="tpl-btn" onclick="whatIfPreset_('breakeven-volume')">損益兩平要賣幾台？</button>
      <button type="button" class="tpl-btn" onclick="whatIfPreset_('breakeven-price')">損益兩平要賣多少錢？</button>
      <button type="button" class="tpl-btn" onclick="whatIfPreset_('material')">營業淨利要達目標，材料成本要降到多少？</button>
      <button type="button" class="tpl-btn" onclick="whatIfPreset_('combo')">缺口由售價、材料、開發總投一起分擔</button>
    </div>
    <div class="goal-sentence">
      <span>要讓</span>
      <select onchange="whatIfPrefs.multi.metric=this.value;saveWhatIfPrefs_()">${metricOptionsHtml_(m.metric)}</select>
      ${basisSeg}
      <span>等於</span>
      <input id="wi-multi-target" type="number" step="any" value="${esc(m.target)}" style="width:140px;" oninput="whatIfPrefs.multi.target=this.value;saveWhatIfPrefs_()">
      <span>元，${single ? '下面這一項要調到多少？' : '由下面幾項'}</span>
      ${single ? '' : `<div class="seg">
        <button type="button" class="seg-btn${shareMode ? ' active' : ''}" onclick="whatIfPrefs.multi.mode='share';saveWhatIfPrefs_();drawWhatIf_()" data-tip="每一項負責一定比例的缺口（例：售價 40%、材料 40%、開發 20%）">依比例分攤</button>
        <button type="button" class="seg-btn${!shareMode ? ' active' : ''}" onclick="whatIfPrefs.multi.mode='equal';saveWhatIfPrefs_();drawWhatIf_()" data-tip="所有項目都往有利方向調同樣的 %，算出要調幾 %">同幅度調整</button>
      </div>`}
    </div>
    <div class="grid-scroll"><table class="grid-table lever-table">
      <thead><tr>${single ? '' : '<th style="width:28px;"></th>'}<th>調整項目（目前值）</th>${shareMode ? '<th>分攤比例 %</th>' : ''}${single ? '' : `<th data-tip="例：售價最多只能漲 3%；碰到上限後剩下的缺口由其他項目吸收">最多調 ±%</th><th data-tip="已經確定的數字直接填，不參與反推">固定為</th><th style="width:40px;"></th>`}</tr></thead>
      <tbody id="wi-lever-body">${m.levers.map((l, i) => `<tr data-key="${i}">
        ${single ? '' : `<td>${dragHandleHtml('拖曳調整順序（貢獻依這個順序逐項計算）')}</td>`}
        <td><select onchange="whatIfPrefs.multi.levers[${i}].driver=this.value;saveWhatIfPrefs_();drawWhatIf_()">${driverOptionsHtml_(l.driver)}</select></td>
        ${shareMode ? `<td><input type="number" min="0" step="any" value="${esc(l.share)}" placeholder="平均" ${l.fixed !== '' && l.fixed !== undefined ? 'disabled' : ''} oninput="whatIfPrefs.multi.levers[${i}].share=this.value;saveWhatIfPrefs_()"></td>` : ''}
        ${single ? '' : `<td><input type="number" min="0" step="any" value="${esc(l.capPct)}" placeholder="不限" ${l.fixed !== '' && l.fixed !== undefined ? 'disabled' : ''} oninput="whatIfPrefs.multi.levers[${i}].capPct=this.value;saveWhatIfPrefs_()"></td>
        <td><input type="number" step="any" value="${esc(l.fixed)}" placeholder="反推" onchange="whatIfPrefs.multi.levers[${i}].fixed=this.value;saveWhatIfPrefs_();drawWhatIf_()"></td>
        <td><button type="button" class="btn ghost icon sm" onclick="whatIfPrefs.multi.levers.splice(${i},1);saveWhatIfPrefs_();drawWhatIf_()" aria-label="刪除">✕</button></td>`}
      </tr>`).join('')}</tbody></table></div>
    <div class="field-row" style="margin-top:8px;">
      <button type="button" class="btn secondary sm" onclick="addLever_()"${single ? ' data-tip="多加幾項 = 缺口由這幾項一起分擔（組合拳）"' : ''}>＋ 加一個項目</button>
      ${shareMode ? `<span class="help">分攤比例合計 ${fmt(totalShare)}%${totalShare && Math.abs(totalShare - 100) > 0.01 ? '（會自動換算成 100%）' : totalShare ? '' : '（都沒填 = 平均分攤）'}</span>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" onclick="runMultiGoal_()">計算</button>
    </div>
    <div id="wi-multi-result"></div>
  </div>`;
}
function addLever_() {
  const used = whatIfPrefs.multi.levers.map(l => l.driver);
  const next = whatIfOptions.drivers.find(d => used.indexOf(driverKey_(d.driver)) === -1);
  if (!next) return;
  whatIfPrefs.multi.levers.push({ driver: driverKey_(next.driver), share: '', capPct: '', fixed: '' });
  saveWhatIfPrefs_();
  drawWhatIf_();
}
function installLeverSort_() {
  const body = document.getElementById('wi-lever-body');
  if (!body) return;
  makeSortable(body, { items: 'tr', onEnd: keys => {
    whatIfPrefs.multi.levers = keys.map(k => whatIfPrefs.multi.levers[Number(k)]);
    saveWhatIfPrefs_();
    drawWhatIf_();
  } });
}
let lastMultiResult_ = null;
function runMultiGoal_() {
  const m = whatIfPrefs.multi;
  if (m.levers.length === 1) { runGoalSeek_(); return; }
  const box = document.getElementById('wi-multi-result');
  box.innerHTML = '<p class="muted">計算中...（每一項都要反覆試算，項目多時會花幾秒）</p>';
  const levers = m.levers.map(l => ({ driver: driverFromKey_(l.driver), share: l.share, capPct: l.capPct, fixed: l.fixed }));
  google.script.run
    .withSuccessHandler(safeHandler(r => { lastMultiResult_ = r; box.innerHTML = multiGoalResultHtml_(r); }))
    .withFailureHandler(err => { box.innerHTML = `<div class="callout err">${esc(err.message)}</div>`; })
    .solveGoalMulti(currentScenarioId, { code: m.metric, basis: m.basis }, num(m.target), levers, m.mode);
}
function multiGoalSteps_(r) {
  const metric = whatIfMetricLabel_(whatIfPrefs.multi.metric, whatIfPrefs.multi.basis);
  return [{ label: '目前 ' + metric, value: r.metricBase, kind: 'total' }]
    .concat(r.levers.map(l => ({ label: l.label, value: l.contribution, kind: 'delta',
      tip: `${l.label}\n${fmt(l.base, Math.abs(l.base) < 100 ? 2 : 0)} → ${fmt(l.value, Math.abs(l.base) < 100 ? 2 : 0)} ${l.unit || ''}\n貢獻 ${l.contribution >= 0 ? '+' : ''}${fmt(l.contribution)}` })))
    .concat([{ label: (r.feasible ? '達成 ' : '最多做到 ') + metric, value: r.achieved, kind: 'total' }]);
}
function multiGoalResultHtml_(r) {
  const total = r.achieved - r.metricBase;
  const dg = v => Math.abs(v) < 100 ? 2 : 0;
  const head = r.feasible
    ? `<div class="callout ok">可以達成：${esc(whatIfMetricLabel_(whatIfPrefs.multi.metric, whatIfPrefs.multi.basis))} ${fmt(r.metricBase)} → <b>${fmt(r.achieved)}</b>（目標 ${fmt(r.target)}）${r.mode === 'equal' ? `，每一項都調 <b>${fmt(r.equalPct, 2)}%</b>` : ''}。</div>`
    : `<div class="callout warn">${esc(r.message)}</div>`;
  return `${head}${(r.warnings || []).map(w => `<div class="callout warn">${esc(w)}</div>`).join('')}
    <div class="grid-scroll"><table class="grid-table lever-table">
      <thead><tr><th>項目</th><th>目前</th><th>調整後</th><th>變動</th><th>對結果的貢獻</th><th>占總改善</th></tr></thead>
      <tbody>${r.levers.map(l => `<tr>
        <td>${esc(l.label)}${l.fixed ? '<span class="lever-cap" style="background:#e2e8f0;color:#2d3748;">固定</span>' : ''}${l.capped ? '<span class="lever-cap">碰到上限</span>' : ''}</td>
        <td class="amt">${fmt(l.base, dg(l.base))} ${esc(l.unit || '')}</td>
        <td class="amt"><b>${fmt(l.value, dg(l.base))}</b> ${esc(l.unit || '')}</td>
        <td class="amt">${l.pct === null ? '' : signed_(l.pct, 2) + '%'}</td>
        <td class="amt${l.contribution < 0 ? ' negative' : ''}">${l.contribution >= 0 ? '+' : ''}${fmt(l.contribution)}</td>
        <td class="amt">${total ? (l.contribution / total * 100).toFixed(1) + '%' : ''}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="help">貢獻依列表順序逐項加入計算（各項之間有交互作用，例如售價變動也會影響佣金與貨物稅），加總 = 總改善 ${total >= 0 ? '+' : ''}${fmt(total)}。拖曳 ⠿ 可以換順序。只在畫面上試算，不會改到存檔的數字。</p>
    <div class="waterfall-card">${wfSvg_(multiGoalSteps_(r), { width: 900, height: 320, labels: true, fmtV: wfShortFmt_(multiGoalSteps_(r)) })}</div>
    <div class="field-row" style="margin-top:8px;">
      <button type="button" class="btn secondary sm" onclick="saveWhatIfScenarioDialog_(lastMultiResult_.levers.map(l => ({ driver: l.driver, value: l.value })), lastMultiResult_.levers.map(l => l.label).join('、'))">另存成新情境…</button>
      <button type="button" class="btn secondary sm" onclick="openInWaterfallTool_(multiGoalSteps_(lastMultiResult_), '組合拳：' + whatIfMetricLabel_(whatIfPrefs.multi.metric, whatIfPrefs.multi.basis))">在瀑布圖工具開啟（可編輯、下載 PNG）</button></div>`;
}

/**
 * 把反推出來的假設寫成一個新情境(複製目前情境的全部資料，再把調整寫實)：
 * 之後就能像一般情境一樣在儀表板比較、在 GATE 報告當目標、繼續修改。
 */
function saveWhatIfScenarioDialog_(levers, summary) {
  const cur = currentScenario || {};
  openModal({
    title: '另存成新情境',
    body: `<p class="help">複製「${esc(scenarioLabel(cur))}」的全部資料（銷售構成、成本、開發總投、費用、參數、說明、作法），再把這次反推的調整寫進去：<br><b>${esc(summary || '')}</b></p>`,
    fields: [
      { name: 'Gate', label: 'GATE 別', type: 'select', options: GATE_OPTIONS, value: cur.Gate || 'GATE F' },
      { name: 'ScenarioName', label: '情境名稱', value: (cur.ScenarioName || '') + ' 反推' },
      { name: 'ScenarioType', label: '類型', type: 'select', options: ['目標', '現況'], value: '目標' }
    ],
    okText: '建立情境',
    validate: v => String(v.ScenarioName || '').trim() ? '' : '請輸入情境名稱'
  }).then(v => {
    if (!v) return;
    google.script.run
      .withSuccessHandler(safeHandler(res => {
        const diff = Math.abs(res.actual - res.expected);
        toast(`已建立「${res.scenario.Gate} ${res.scenario.ScenarioName}」，營業淨利 ${fmt(res.actual)} 元/台` + (diff > 1 ? `（與試算差 ${fmt(diff)}，有科目使用車系個別公式，請檢查）` : ''), diff > 1 ? 'warn' : 'ok', 4000);
        confirmModal('新情境已建立', `要切換到「${esc(res.scenario.Gate + ' ' + res.scenario.ScenarioName)}」嗎？`, '切換過去').then(ok => {
          loadScenarioSelector(ok ? res.scenario.ScenarioID : currentScenarioId);
        });
      }))
      .withFailureHandler(err => toast(err.message, 'err', 4000))
      .saveWhatIfAsScenario(currentScenarioId, levers, v);
  });
}
