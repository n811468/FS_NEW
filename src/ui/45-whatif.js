/* ================= 目標反推與敏感度分析 =================
 * 「月銷要多少台才損益兩平？」「材料成本要降到多少才達標？」「售價 × 台數的組合下營業淨利是多少？」
 * 所有試算都只在記憶體裡算(後端 WhatIfService.gs)，不會改到任何已存檔的資料。
 */
let whatIfOptions = null;
const WHATIF_PREFS_KEY_ = 'plWhatIf.prefs.v1';
let whatIfPrefs = {
  goal: { metric: 'K', basis: 'unit', target: 0, driver: 'volume' },
  multi: { metric: 'K', basis: 'unit', target: 0, mode: 'share', levers: null },
  sens: { metric: 'K', basis: 'unit', row: 'volume', rowSteps: '-20,-10,0,10,20', col: 'price', colSteps: '-10,-5,0,5,10', inReport: true }
};
function loadWhatIfPrefs_() {
  try {
    const p = JSON.parse(localStorage.getItem(WHATIF_PREFS_KEY_) || 'null');
    if (p && p.goal) Object.assign(whatIfPrefs.goal, p.goal);
    if (p && p.sens) Object.assign(whatIfPrefs.sens, p.sens);
    if (p && p.multi) Object.assign(whatIfPrefs.multi, p.multi);
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
  panel.innerHTML = `<p class="page-intro">用目前情境 <b>${esc(currentScenario ? scenarioLabel(currentScenario) : '')}</b> 的資料試算「如果…會怎樣」。
    <b>只在畫面上試算，不會改到任何已存檔的數字。</b></p><div id="whatif-body"><p class="muted">載入中...</p></div>`;
  google.script.run
    .withSuccessHandler(safeHandler(opts => { whatIfOptions = opts; drawWhatIf_(); }))
    .withFailureHandler(err => { document.getElementById('whatif-body').innerHTML = `<div class="callout err">${esc(err.message)}</div>`; })
    .getWhatIfOptions(currentScenarioId);
}

function drawWhatIf_() {
  const g = whatIfPrefs.goal, s = whatIfPrefs.sens;
  const body = document.getElementById('whatif-body');
  if (!body || !whatIfOptions) return;
  const basisSeg = (scope, cur) => `<div class="seg">
      <button type="button" class="seg-btn${cur === 'unit' ? ' active' : ''}" onclick="whatIfPrefs.${scope}.basis='unit';saveWhatIfPrefs_();drawWhatIf_()">單台</button>
      <button type="button" class="seg-btn${cur === 'month' ? ' active' : ''}" onclick="whatIfPrefs.${scope}.basis='month';saveWhatIfPrefs_();drawWhatIf_()">月總額</button></div>`;
  body.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>目標反推</h3><span class="muted">要讓某個科目達到目標值，某一項假設要調到多少？</span></div>
      <div class="tpl-row"><span class="muted">常見問題：</span>
        <button type="button" class="tpl-btn" onclick="whatIfPreset_('breakeven-volume')">損益兩平要賣幾台？</button>
        <button type="button" class="tpl-btn" onclick="whatIfPreset_('breakeven-price')">損益兩平要賣多少錢？</button>
        <button type="button" class="tpl-btn" onclick="whatIfPreset_('material')">營業淨利要達目標，材料成本要降到多少？</button>
      </div>
      <div class="goal-sentence">
        <span>要讓</span>
        <select id="wi-goal-metric" onchange="whatIfPrefs.goal.metric=this.value;saveWhatIfPrefs_()">${metricOptionsHtml_(g.metric)}</select>
        ${basisSeg('goal', g.basis)}
        <span>等於</span>
        <input id="wi-goal-target" type="number" step="any" value="${esc(g.target)}" style="width:140px;" oninput="whatIfPrefs.goal.target=this.value;saveWhatIfPrefs_()">
        <span>元，</span>
        <select id="wi-goal-driver" onchange="whatIfPrefs.goal.driver=this.value;saveWhatIfPrefs_()">${driverOptionsHtml_(g.driver)}</select>
        <span>要調到多少？</span>
        <button type="button" class="btn" onclick="runGoalSeek_()">計算</button>
      </div>
      <div id="wi-goal-result"></div>
    </div>

    ${multiGoalCardHtml_()}

    <div class="card">
      <div class="card-head"><h3>敏感度分析</h3><span class="muted">兩項假設同時變動時，結果會落在哪裡（中間框起來的是目前的數字）</span>
        <span class="spacer"></span>
        <label class="chk"><input type="checkbox" ${s.inReport ? 'checked' : ''} onchange="whatIfPrefs.sens.inReport=this.checked;saveWhatIfPrefs_()"> 放進 GATE 報告</label></div>
      <div class="field-row">
        <label class="field"><span>看哪個結果</span><select onchange="whatIfPrefs.sens.metric=this.value;saveWhatIfPrefs_()">${metricOptionsHtml_(s.metric)}</select></label>
        <label class="field"><span>&nbsp;</span>${basisSeg('sens', s.basis)}</label>
        <label class="field"><span>直列：調整項目</span><select onchange="whatIfPrefs.sens.row=this.value;saveWhatIfPrefs_()">${driverOptionsHtml_(s.row)}</select></label>
        <label class="field"><span>變動幅度（%，逗號分隔）</span><input type="text" value="${esc(s.rowSteps)}" style="width:160px;" oninput="whatIfPrefs.sens.rowSteps=this.value;saveWhatIfPrefs_()"></label>
        <label class="field"><span>橫列：調整項目</span><select onchange="whatIfPrefs.sens.col=this.value;saveWhatIfPrefs_()">${driverOptionsHtml_(s.col)}</select></label>
        <label class="field"><span>變動幅度（%）</span><input type="text" value="${esc(s.colSteps)}" style="width:160px;" oninput="whatIfPrefs.sens.colSteps=this.value;saveWhatIfPrefs_()"></label>
        <button type="button" class="btn" style="align-self:flex-end;" onclick="runSensitivity_()">產生表格</button>
      </div>
      <div id="wi-sens-result" style="margin-top:14px;"></div>
    </div>`;
  installLeverSort_();
  runSensitivity_();
}

function whatIfPreset_(kind) {
  const g = whatIfPrefs.goal;
  if (kind === 'breakeven-volume') Object.assign(g, { metric: 'K', basis: 'unit', target: 0, driver: 'volume' });
  if (kind === 'breakeven-price') Object.assign(g, { metric: 'K', basis: 'unit', target: 0, driver: 'price' });
  if (kind === 'material') {
    const lines = whatIfOptions.drivers.filter(d => d.driver.type === 'line').sort((a, b) => Math.abs(b.base) - Math.abs(a.base));
    Object.assign(g, { metric: 'K', basis: 'unit', target: Math.max(0, Math.round((whatIfOptions.metrics.find(m => m.code === 'K') || {}).value || 0)), driver: lines.length ? driverKey_(lines[0].driver) : 'volume' });
  }
  saveWhatIfPrefs_();
  drawWhatIf_();
  runGoalSeek_();
}

function runGoalSeek_() {
  const g = whatIfPrefs.goal;
  const box = document.getElementById('wi-goal-result');
  box.innerHTML = '<p class="muted">計算中...</p>';
  const info = whatIfDriverInfo_(g.driver) || {};
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
        <div class="muted">${esc(whatIfMetricLabel_(g.metric, g.basis))}：目前 ${fmt(r.metricBase)} → ${fmt(r.achieved)}（目標 ${fmt(num(g.target))}）。
          ${info.driver && info.driver.type === 'volume' ? '台數變動時，開發總投的攤提台數也一起變。' : ''}其他假設都維持目前的數字。</div>
        <div class="field-row" style="margin-top:8px;"><button type="button" class="btn secondary sm" id="wi-goal-save">另存成新情境…</button></div>
      </div>`;
      const btn = document.getElementById('wi-goal-save');
      if (btn) btn.onclick = () => saveWhatIfScenarioDialog_([{ driver: driverFromKey_(g.driver), value: r.value }], `${r.label} ${fmt(r.base, digits)} → ${fmt(r.value, digits)}`);
    }))
    .withFailureHandler(err => { box.innerHTML = `<div class="callout err">${esc(err.message)}</div>`; })
    .solveGoal(currentScenarioId, { code: g.metric, basis: g.basis }, num(g.target), driverFromKey_(g.driver));
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
function runSensitivity_(targetBox, scenarioId, done) {
  const s = whatIfPrefs.sens;
  const box = targetBox || document.getElementById('wi-sens-result');
  if (!box) return;
  const rowSteps = parseSteps_(s.rowSteps), colSteps = parseSteps_(s.colSteps);
  box.innerHTML = '<p class="muted">計算中...</p>';
  const go = opts => {
    const info = k => opts.drivers.find(d => driverKey_(d.driver) === k);
    const ri = info(s.row) || opts.drivers[0], ci = info(s.col) || opts.drivers[1];
    const rv = rowSteps.map(p => ri.base * (1 + p / 100)), cv = colSteps.map(p => ci.base * (1 + p / 100));
    google.script.run
      .withSuccessHandler(safeHandler(t => { box.innerHTML = sensitivityTableHtml_(t, rowSteps, colSteps, s, opts); if (done) done(); }))
      .withFailureHandler(err => { box.innerHTML = `<div class="callout err">${esc(err.message)}</div>`; })
      .sensitivityTable(scenarioId || currentScenarioId, { code: s.metric, basis: s.basis }, ri.driver, rv, ci.driver, cv);
  };
  if (scenarioId && scenarioId !== currentScenarioId) {
    google.script.run.withSuccessHandler(go).withFailureHandler(err => { box.innerHTML = `<div class="callout err">${esc(err.message)}</div>`; }).getWhatIfOptions(scenarioId);
  } else go(whatIfOptions);
}
function sensitivityTableHtml_(t, rowSteps, colSteps, s, opts) {
  const all = [].concat.apply([], t.cells);
  const maxAbs = Math.max.apply(null, all.map(Math.abs).concat([1]));
  const metric = (opts.metrics.find(m => m.code === s.metric) || {}).label || s.metric;
  const dg = v => Math.abs(v) < 100 ? 2 : 0;
  const color = v => {
    const a = Math.min(1, Math.abs(v) / maxAbs);
    return v >= 0 ? `rgba(28,138,89,${0.08 + a * 0.32})` : `rgba(210,60,60,${0.08 + a * 0.32})`;
  };
  return `<div class="grid-scroll"><table class="grid-table sens-table">
    <thead>
      <tr><th rowspan="2">${esc(t.rowLabel)} ↓ ／ ${esc(t.colLabel)} →</th>${colSteps.map((p, j) => `<th>${p === 0 ? '目前' : signed_(p) + '%'}</th>`).join('')}</tr>
      <tr>${t.colValues.map(v => `<th class="th-sub">${fmt(v, dg(v))}</th>`).join('')}</tr>
    </thead>
    <tbody>${t.cells.map((row, i) => `<tr>
      <td class="row-head">${rowSteps[i] === 0 ? '目前' : signed_(rowSteps[i]) + '%'} <span class="muted">${fmt(t.rowValues[i], dg(t.rowValues[i]))}${esc(t.rowUnit ? ' ' + t.rowUnit : '')}</span></td>
      ${row.map((v, j) => `<td class="${rowSteps[i] === 0 && colSteps[j] === 0 ? 'sens-base' : ''}${v < 0 ? ' negative' : ''}" style="background:${color(v)};">${fmt(v)}</td>`).join('')}
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="help">表內數字：${esc(metric)}${s.basis === 'month' ? '（月總額，元）' : '（加權平均，元/台）'}。綠色 = 正、紅色 = 負，顏色越深絕對值越大。</p>`;
}

/* ---------------- 多項目標反推(組合拳) ----------------
 * 營業淨利的缺口通常不會只指派一個項目：售價、材料、銷量、開發總投…各負責一部分。
 * 每一項可以設「分攤比例」「最多調 ±%」或「固定值」(已經確定的數字)，後端 solveGoalMulti 一次算出每一項要調多少。
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
  if (!Array.isArray(m.levers) || !m.levers.length) m.levers = defaultLevers_();
  const known = k => whatIfDriverInfo_(k);
  m.levers = m.levers.filter(l => known(l.driver));
  const shareMode = m.mode !== 'equal';
  const basisSeg = `<div class="seg">
      <button type="button" class="seg-btn${m.basis === 'unit' ? ' active' : ''}" onclick="whatIfPrefs.multi.basis='unit';saveWhatIfPrefs_();drawWhatIf_()">單台</button>
      <button type="button" class="seg-btn${m.basis === 'month' ? ' active' : ''}" onclick="whatIfPrefs.multi.basis='month';saveWhatIfPrefs_();drawWhatIf_()">月總額</button></div>`;
  const totalShare = m.levers.filter(l => l.fixed === '' || l.fixed === undefined).reduce((s, l) => s + num(l.share), 0);
  return `<div class="card" id="wi-multi">
    <div class="card-head"><h3>多項目標反推（組合拳）</h3><span class="muted">缺口由好幾個項目一起分擔：每一項要調多少？</span></div>
    <div class="goal-sentence">
      <span>要讓</span>
      <select onchange="whatIfPrefs.multi.metric=this.value;saveWhatIfPrefs_()">${metricOptionsHtml_(m.metric)}</select>
      ${basisSeg}
      <span>等於</span>
      <input id="wi-multi-target" type="number" step="any" value="${esc(m.target)}" style="width:140px;" oninput="whatIfPrefs.multi.target=this.value;saveWhatIfPrefs_()">
      <span>元，由下面幾項</span>
      <div class="seg">
        <button type="button" class="seg-btn${shareMode ? ' active' : ''}" onclick="whatIfPrefs.multi.mode='share';saveWhatIfPrefs_();drawWhatIf_()" data-tip="每一項負責一定比例的缺口（例：售價 40%、材料 40%、開發 20%）">依比例分攤</button>
        <button type="button" class="seg-btn${!shareMode ? ' active' : ''}" onclick="whatIfPrefs.multi.mode='equal';saveWhatIfPrefs_();drawWhatIf_()" data-tip="所有項目都往有利方向調同樣的 %，算出要調幾 %">同幅度調整</button>
      </div>
    </div>
    <div class="grid-scroll"><table class="grid-table lever-table">
      <thead><tr><th style="width:28px;"></th><th>調整項目（目前值）</th>${shareMode ? '<th>分攤比例 %</th>' : ''}<th data-tip="例：售價最多只能漲 3%；碰到上限後剩下的缺口由其他項目吸收">最多調 ±%</th><th data-tip="已經確定的數字直接填，不參與反推">固定為</th><th style="width:40px;"></th></tr></thead>
      <tbody id="wi-lever-body">${m.levers.map((l, i) => `<tr data-key="${i}">
        <td>${dragHandleHtml('拖曳調整順序（貢獻依這個順序逐項計算）')}</td>
        <td><select onchange="whatIfPrefs.multi.levers[${i}].driver=this.value;saveWhatIfPrefs_();drawWhatIf_()">${driverOptionsHtml_(l.driver)}</select></td>
        ${shareMode ? `<td><input type="number" min="0" step="any" value="${esc(l.share)}" placeholder="平均" ${l.fixed !== '' && l.fixed !== undefined ? 'disabled' : ''} oninput="whatIfPrefs.multi.levers[${i}].share=this.value;saveWhatIfPrefs_()"></td>` : ''}
        <td><input type="number" min="0" step="any" value="${esc(l.capPct)}" placeholder="不限" ${l.fixed !== '' && l.fixed !== undefined ? 'disabled' : ''} oninput="whatIfPrefs.multi.levers[${i}].capPct=this.value;saveWhatIfPrefs_()"></td>
        <td><input type="number" step="any" value="${esc(l.fixed)}" placeholder="反推" onchange="whatIfPrefs.multi.levers[${i}].fixed=this.value;saveWhatIfPrefs_();drawWhatIf_()"></td>
        <td><button type="button" class="btn ghost icon sm" onclick="whatIfPrefs.multi.levers.splice(${i},1);saveWhatIfPrefs_();drawWhatIf_()" aria-label="刪除">✕</button></td>
      </tr>`).join('')}</tbody></table></div>
    <div class="field-row" style="margin-top:8px;">
      <button type="button" class="btn secondary sm" onclick="addLever_()">＋ 加一個項目</button>
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
