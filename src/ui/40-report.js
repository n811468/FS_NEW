/* ================= GATE 審議報告(簡報)：現況與目標的差距、作法、說明 ================= */
let reportData = null;
let reportSel = { target: '', base: '', prev: '' };
let reportUnit = 1;              // 1 元 / 1000 千元 / 10000 萬元(全系統共用，見 loadAmountUnit_)
let reportActions = [];          // 編輯中的作法(目標情境)
let reportNoteEdits = {};        // { scenarioId: { LineCode: 說明 } } 還沒存的說明
let reportShowPrice = false;
/** 差距拆解的長條設定(每個車型各一份)：最多幾根、多小的併入「其他」、哪些科目合併成同一根 { LineCode: 合併後的名稱 } */
let reportBridgeCfg = null;
function defaultBridgeCfg_() { return { topN: 10, minAbs: 0, groups: {} }; }
const REPORT_PREFS_KEY_ = 'plReport.prefs.v1';

function loadReportPrefs_() {
  try {
    const p = JSON.parse(localStorage.getItem(REPORT_PREFS_KEY_) || 'null') || {};
    if (p.sel && p.sel[currentVehicleTypeId]) reportSel = Object.assign({ target: '', base: '', prev: '' }, p.sel[currentVehicleTypeId]);
    else reportSel = { target: '', base: '', prev: '' };
    if ([1, 1000, 10000].indexOf(p.unit) !== -1) reportUnit = p.unit;
    if (typeof p.showPrice === 'boolean') reportShowPrice = p.showPrice;
    reportBridgeCfg = Object.assign(defaultBridgeCfg_(), p.bridge && p.bridge[currentVehicleTypeId]);
  } catch (e) { reportBridgeCfg = defaultBridgeCfg_(); }
  reportUnit = loadAmountUnit_(reportUnit);   // 金額單位全系統共用
}
function saveReportPrefs_() {
  try {
    const p = JSON.parse(localStorage.getItem(REPORT_PREFS_KEY_) || 'null') || {};
    p.sel = p.sel || {};
    p.sel[currentVehicleTypeId] = reportSel;
    p.unit = reportUnit; p.showPrice = reportShowPrice;
    p.bridge = p.bridge || {};
    p.bridge[currentVehicleTypeId] = reportBridgeCfg;
    localStorage.setItem(REPORT_PREFS_KEY_, JSON.stringify(p));
  } catch (e) { /* 存不了就算了 */ }
}

/** 沒選過時的預設：目標 = 目前情境(若是目標情境)或最後一個目標情境；現況 = 同一個 GATE 的現況情境 */
function defaultReportSel_() {
  const scs = scenarioCache;
  const ids = scs.map(s => s.ScenarioID);
  const valid = id => id && ids.indexOf(id) !== -1;
  if (!valid(reportSel.target)) {
    const cur = scs.find(s => s.ScenarioID === currentScenarioId);
    const targets = scs.filter(s => s.ScenarioType === '目標');
    reportSel.target = cur && cur.ScenarioType === '目標' ? cur.ScenarioID : (targets.length ? targets[targets.length - 1].ScenarioID : (cur ? cur.ScenarioID : (ids[0] || '')));
  }
  if (reportSel.base && !valid(reportSel.base)) reportSel.base = '';
  if (reportSel.prev && !valid(reportSel.prev)) reportSel.prev = '';
  if (!reportSel.base) {
    const t = scs.find(s => s.ScenarioID === reportSel.target);
    const base = scs.find(s => s.ScenarioType !== '目標' && t && s.Gate === t.Gate && s.ScenarioID !== t.ScenarioID) ||
      scs.find(s => s.ScenarioType !== '目標' && s.ScenarioID !== reportSel.target);
    reportSel.base = base ? base.ScenarioID : '';
  }
}

function renderReportPanel() {
  const panel = document.getElementById('panel-report');
  if (!requireScope('report', false)) return;
  if (!scenarioCache.length) {
    panel.innerHTML = emptyStateHtml('🗂', '這個車型還沒有情境', '報告比較「現況」與「目標」兩個情境，請先建立情境。', `<button class="btn" onclick="switchTab('masters')">前往車型與情境</button>`);
    return;
  }
  loadReportPrefs_();
  defaultReportSel_();
  const opt = (id, allowEmpty, emptyText) => (allowEmpty ? `<option value="">${emptyText}</option>` : '') +
    scenarioCache.map(s => `<option value="${esc(s.ScenarioID)}"${s.ScenarioID === id ? ' selected' : ''}>${esc(scenarioLabel(s))}（${esc(s.ScenarioType || '現況')}）</option>`).join('');
  panel.innerHTML = `
    <div class="card no-print">
      <div class="report-controls">
        <label class="field rpt-pick base"><span><i class="rpt-dot"></i>現況（差距的比較基準）</span><select id="rpt-sel-base" onchange="setReportSel('base', this.value)">${opt(reportSel.base, true, '（不比較）')}</select></label>
        <span class="rpt-arrow" aria-hidden="true">→</span>
        <label class="field rpt-pick target"><span><i class="rpt-dot"></i>目標 / 本回</span><select id="rpt-sel-target" onchange="setReportSel('target', this.value)">${opt(reportSel.target)}</select></label>
        <label class="field rpt-pick prev"><span>前回（選填，跟本回比）</span><select id="rpt-sel-prev" onchange="setReportSel('prev', this.value)">${opt(reportSel.prev, true, '（不比較）')}</select></label>
      </div>
      <div class="report-controls" style="margin-top:12px;">
        <label class="field" data-tip="全系統共用：儀表板、GATE 報告、瀑布圖工具用同一個金額單位"><span>金額單位</span><div class="seg">
          ${AMOUNT_UNITS_.map(([u, t]) => `<button type="button" class="seg-btn${reportUnit === u ? ' active' : ''}" data-unit="${u}" onclick="setReportUnit(${u})">${t}/台</button>`).join('')}</div></label>
        <label class="chk" style="align-self:center;"><input type="checkbox" ${reportShowPrice ? 'checked' : ''} onchange="reportShowPrice=this.checked;saveReportPrefs_();drawReport_()"> 顯示售價結構</label>
        <span style="flex:1"></span>
        <button type="button" class="btn secondary" onclick="createSnapshotDialog_(reportSel.target, (scenarioCache.find(s => s.ScenarioID === reportSel.target) || {}).ScenarioName ? scenarioLabel(scenarioCache.find(s => s.ScenarioID === reportSel.target)) : '')" data-tip="把目標情境現在的數字存一份，之後可以比較改了什麼">存成快照</button>
        <button type="button" class="btn secondary" onclick="loadReport_()">重新計算</button>
        <button type="button" class="btn" onclick="printReport_()">列印 / 存成 PDF</button>
      </div>
      <p class="help" style="margin:10px 0 0;">每一張卡片是一頁 16:9 投影片，列印時每頁一張。「說明」欄可以直接點進去改（會存回該情境的科目說明，銷貨成本頁的說明欄也是同一份）；作法清單可以拖曳 ⠿ 排序。每張右上角的「複製」可以把表格貼進 PowerPoint / Excel。</p>
    </div>
    <div id="report-body"><p class="muted">計算中...</p></div>`;
  loadReport_();
}

function setReportSel(field, value) {
  const go = () => {
    reportSel[field] = value;
    saveReportPrefs_();
    loadReport_();
  };
  if (isDirty_()) confirmLeave_().then(ok => { if (ok) go(); }); else go();
}
function setReportUnit(u) {
  reportUnit = normAmountUnit_(u);
  saveAmountUnit_(reportUnit);
  saveReportPrefs_();
  document.querySelectorAll('#panel-report .report-controls .seg-btn[data-unit]').forEach(b => b.classList.toggle('active', Number(b.dataset.unit) === reportUnit));
  drawReport_();
}

function loadReport_() {
  const body = document.getElementById('report-body');
  if (!reportSel.target) { if (body) body.innerHTML = '<p class="muted">請選擇目標情境。</p>'; return; }
  if (body && !reportData) body.innerHTML = '<p class="muted">計算中...</p>';
  google.script.run
    .withSuccessHandler(safeHandler(data => {
      clearDirty();
      reportData = data;
      reportActions = (data.actions || []).map(a => Object.assign({}, a));
      reportNoteEdits = {};
      drawReport_();
    }))
    .withFailureHandler(err => { if (body) body.innerHTML = `<div class="callout err">報告計算失敗：${esc(err.message)}</div>`; })
    .getGateReport(reportSel.target === reportSel.base ? '' : reportSel.base, reportSel.target, reportSel.prev === reportSel.target ? '' : reportSel.prev);
}

/* ---- 報告用的小工具 ---- */
function rAmt_(v) { return v === undefined || v === null ? '' : fmt(Number(v) / reportUnit, amountUnitDigits_(reportUnit)); }
function rSigned_(v) { return v === undefined || v === null ? '' : signed_(Number(v) / reportUnit, amountUnitDigits_(reportUnit)); }
function rUnit_() { return amountUnitText_(reportUnit) + '/台'; }
function rPct_(v, base) { return base ? (Number(v) / base * 100).toFixed(1) + '%' : ''; }
/** 目標情境的營業淨利科目(預設 K；K 被刪掉時後端指定損益表最底下的總計) */
function rK_() { return profitCodeOf_(reportData); }
/** 某個情境(目標/現況/前回)的營業淨利：各看自己車型的淨利科目，不同車型可能不是同一個代碼 */
function rProfit_(block) { return block ? (block.weighted[block.profitCode || rK_()] || 0) : 0; }
function reportLineName_(code) { const l = reportData.lines.find(x => x.LineCode === code); return l ? shortLineName(l.LineName) : code; }
function reportCodeNameMap_() { const m = {}; reportData.lines.forEach(l => { m[l.LineCode] = shortLineName(l.LineName); }); return m; }
function noteFor_(block, code) {
  const sid = block.meta.ScenarioID;
  if (reportNoteEdits[sid] && reportNoteEdits[sid][code] !== undefined) return reportNoteEdits[sid][code];
  return (block.notes || {})[code] || '';
}
function noteCellHtml_(block, code) {
  const sid = block.meta.ScenarioID;
  const dirty = reportNoteEdits[sid] && reportNoteEdits[sid][code] !== undefined;
  return `<td class="note${dirty ? ' dirty' : ''}" contenteditable="true" data-sc="${esc(sid)}" data-code="${esc(code)}" oninput="onReportNote(this)">${esc(noteFor_(block, code))}</td>`;
}
function onReportNote(el) {
  const sid = el.getAttribute('data-sc'), code = el.getAttribute('data-code');
  reportNoteEdits[sid] = reportNoteEdits[sid] || {};
  reportNoteEdits[sid][code] = el.innerText.replace(/\n+$/, '');
  el.classList.add('dirty');
  markDirty('report', saveReport_, () => { clearDirty(); loadReport_(); });
}
/** 科目對營業淨利的方向：收入類(A 底下或 A 本身) +1；成本/費用類 -1；小計與售價結構不算 */
function profitSign_(line) {
  if (line.isPriceStructure) return 0;
  if (line.LineCode === 'A') return 1;
  if (line.isSubtotal) return 0;
  let cur = line, guard = 0;
  while (cur && cur.ParentLine && guard++ < 20) {
    if (cur.ParentLine === 'A') return 1;
    cur = reportData.lines.find(l => l.LineCode === cur.ParentLine);
  }
  return -1;
}
function slideHtml_(no, title, sub, inner, copyId) {
  const t = reportData.target.meta;
  return `<section class="slide">
    <div class="slide-actions no-print">${copyId ? `<button type="button" class="btn secondary sm" onclick="copyReportTable('${copyId}')">複製表格</button>` : ''}</div>
    <div class="slide-head"><span class="slide-no">${esc(no)}</span><h2>${esc(title)}</h2><div class="slide-sub">${sub || ''}</div></div>
    ${inner}
    <div class="slide-foot"><span>${esc(reportData.vehicleTypeId)} 車型 ${esc(t.Gate)} 審議 · F/S 試算與目標成本作法說明</span><span>機密 · 單位：${esc(rUnit_())}</span></div>
  </section>`;
}

function drawReport_() {
  const body = document.getElementById('report-body');
  if (!body || !reportData) return;
  const R = reportData, T = R.target, B = R.base, P = R.prev;
  const slides = [];
  let n = 0;
  const no = () => String(++n).padStart(2, '0');
  slides.push(slideHtml_(no(), '損益目標與差距摘要', `${esc(R.vehicleTypeId)}　${B ? '現況 ' + esc(B.meta.label) + ' → ' : ''}目標 ${esc(T.meta.label)}`, reportSummaryHtml_()));
  if (B) slides.push(slideHtml_(no(), '現況 → 目標：營業淨利差距拆解', '每一根長條 = 該科目讓營業淨利增加(綠)或減少(紅)多少', '<div id="rpt-bridge">' + reportBridgeHtml_() + '</div>'));
  if (B) slides.push(slideHtml_(no(), '現況與目標對照（加權平均）', '差距 = 目標 − 現況；對淨利影響已依科目方向換算', reportCompareHtml_(), 'rpt-compare'));
  slides.push(slideHtml_(no(), '目標成本作法', '差距由哪些作法補起來、擔當單位與進度', reportActionsHtml_(), 'rpt-actions'));
  if (B) slides.push(slideHtml_(no(), '現況 → 作法 → 目標', '營業淨利：每一項作法補了多少，還差多少', '<div id="rpt-act-wf">' + reportActionWaterfallHtml_() + '</div>'));
  if (B) slides.push(slideHtml_(no(), '作法對帳', '作法寫的效果，跟現況 → 目標的實際數字對得起來嗎？', '<div id="rpt-recon-wrap">' + reportReconHtml_() + '</div>', 'rpt-recon'));
  slides.push(slideHtml_(no(), `細車型 FS 損益狀況（${T.meta.label}）`, `${esc(T.meta.ScenarioType)}情境`, reportFsHtml_(T, 'rpt-fs-target'), 'rpt-fs-target'));
  if (B) slides.push(slideHtml_(no(), `細車型 FS 損益狀況（${B.meta.label}）`, `${esc(B.meta.ScenarioType)}情境，供參`, reportFsHtml_(B, 'rpt-fs-base'), 'rpt-fs-base'));
  if (P) slides.push(slideHtml_(no(), '前回 vs 本回', `${esc(P.meta.label)} → ${esc(T.meta.label)}`, reportPrevHtml_(), 'rpt-prev'));
  loadWhatIfPrefs_();
  if (whatIfPrefs.sens.inReport) slides.push(slideHtml_(no(), '敏感度分析', `${esc(T.meta.label)}：兩項假設同時變動時的結果`, '<div id="rpt-sens"><p class="muted">計算中...</p></div>'));
  slides.push(slideHtml_(no(), '開發總投（by 部門）', `攤提台數 ${fmt(T.dev.lifeCycleUnits)} 台`, reportDevHtml_(), 'rpt-dev'));
  const errCodes = Object.keys(T.errors || {});
  body.innerHTML = (errCodes.length ? `<div class="callout err no-print">目標情境有公式錯誤（以 0 計）：${errCodes.map(c => esc(reportLineName_(c)) + '：' + esc(T.errors[c])).join('；')}</div>` : '') + slides.join('');
  const sensBox = document.getElementById('rpt-sens');
  if (sensBox) runSensitivity_(sensBox, reportSel.target);
  makeSortable(document.getElementById('rpt-actions-body'), {
    items: 'tr[data-key]',
    onEnd: keys => {
      const old = reportActions;
      reportActions = keys.map(k => old[Number(k)]);
      redrawReportActions_();
      markDirty('report', saveReport_, () => { clearDirty(); loadReport_(); });
    }
  });
}

function reportSummaryHtml_() {
  const R = reportData, T = R.target, B = R.base;
  const tK = rProfit_(T), bK = B ? rProfit_(B) : null;
  const tRev = T.weighted.P8 || T.weighted.A || 0, bRev = B ? (B.weighted.P8 || B.weighted.A || 0) : 0;
  const tVol = T.volume.monthlyVolume || 0;
  const gap = B ? tK - bK : null;
  const effect = reportActions.reduce((s, a) => s + num(a.Effect), 0);
  const cover = gap && gap > 0 ? effect / gap : null;
  const byStatus = {};
  reportActions.forEach(a => { byStatus[a.Status] = (byStatus[a.Status] || 0) + num(a.Effect); });
  const statusColors = { '已結案': '#6a3dbd', '已確認': '#1c8a59', '進行中': '#3157d5', '規劃中': '#a3acc0' };
  const hero = (cls, label, numV, sub, name) => `<div class="hero ${cls}"><div class="hero-label">${label}</div>${name ? `<div class="hero-name" title="${esc(name)}">${esc(name)}</div>` : ''}<div class="hero-num${numV < 0 ? ' negative' : ''}">${rAmt_(numV)}</div><div class="hero-sub">${sub}</div></div>`;
  const keyCodes = ['A', 'B', 'C', 'E', 'G', 'I'].concat([rK_()]).filter((c, i, a) => a.indexOf(c) === i && T.weighted[c] !== undefined);
  return `
    <div class="kpi-hero">
      ${B ? hero('base', '現況 營業淨利/台', bK, `淨利率 ${rPct_(bK, bRev)}・月 ${fmt((B.volume.monthlyVolume || 0))} 台・月淨利 ${fmt(bK * (B.volume.monthlyVolume || 0) / 10000, 0)} 萬`, B.meta.label) : ''}
      ${hero('target', '目標 營業淨利/台', tK, `淨利率 ${rPct_(tK, tRev)}・月 ${fmt(tVol)} 台・月淨利 ${fmt(tK * tVol / 10000, 0)} 萬` +
        (T.breakEvenVolume !== null && T.breakEvenVolume !== undefined ? `<br>損益兩平月銷量 ≈ <b>${fmt(Math.ceil(T.breakEvenVolume))}</b> 台` : '<br>只靠台數無法損益兩平'), T.meta.label)}
      ${B ? `<div class="hero gap"><div class="hero-label">差距（目標 − 現況）</div><div class="hero-num${gap < 0 ? ' negative' : ''}">${rSigned_(gap)}</div>
        <div class="hero-sub">月效益 ${signed_(gap * tVol / 10000, 0)} 萬・LC ${fmt(T.lifeCycleUnits)} 台合計 ${signed_(gap * T.lifeCycleUnits / 1e8, 2)} 億</div></div>` : ''}
      <div class="hero cover"><div class="hero-label">作法覆蓋率</div>
        <div class="hero-num">${cover === null ? '—' : (cover * 100).toFixed(0) + '%'}</div>
        <div class="hero-sub">作法效果合計 ${rAmt_(effect)}${gap ? `・尚待補足 ${rAmt_(Math.max(0, gap - effect))}` : ''}
          ${B && reconRows_().some(r => r.tone !== 'ok') ? `<br><span class="negative">⚠ ${reconRows_().filter(r => r.tone !== 'ok').length} 個科目作法與數字對不起來</span>` : ''}</div>
        ${gap > 0 ? `<div class="cover-bar">${Object.keys(statusColors).map(st => byStatus[st] ? `<i style="width:${Math.min(100, byStatus[st] / gap * 100)}%;background:${statusColors[st]};" data-tip="${esc(st)} ${fmt(byStatus[st])}"></i>` : '').join('')}</div>` : ''}
      </div>
    </div>
    <div class="grid-scroll"><table class="rpt-table">
      <thead><tr><th style="text-align:left;">重點科目（加權平均）</th>${B ? '<th>現況</th><th>%</th>' : ''}<th>目標</th><th>%</th>${B ? '<th>差距</th>' : ''}<th style="text-align:left;">說明</th></tr></thead>
      <tbody>${keyCodes.map(c => {
        // 營業淨利這一行：現況看自己車型的淨利科目(可能跟目標的代碼不同)
        const bv = B ? (c === rK_() ? bK : B.weighted[c]) : undefined;
        const d = B ? (T.weighted[c] || 0) - (bv || 0) : 0;
        const good = (c === 'B' ? -d : d) > 0.5, bad = (c === 'B' ? -d : d) < -0.5;
        return `<tr class="${c === rK_() ? 'key' : 'subtotal'}"><td class="name">${esc(reportLineName_(c))}</td>
          ${B ? `<td>${rAmt_(bv)}</td><td class="pct">${rPct_(bv, bRev)}</td>` : ''}
          <td>${rAmt_(T.weighted[c])}</td><td class="pct">${rPct_(T.weighted[c], tRev)}</td>
          ${B ? `<td class="${good ? 'gap-good' : bad ? 'gap-bad' : ''}">${rSigned_(d)}</td>` : ''}
          ${noteCellHtml_(T, c)}</tr>`;
      }).join('')}</tbody>
    </table></div>
    <p class="help">月銷 ${fmt(tVol)} 台・LC ${esc(String(T.volume.lifeCycleYears || ''))} 年・攤提台數 ${fmt(T.lifeCycleUnits)} 台；車系構成：${(T.vehicles || []).map(v => `${esc(v.VehicleCode)} ${fmt(v.salesMixPct, 1)}%`).join('・')}</p>`;
}

/** 差距拆解：每個科目對營業淨利的影響(已依科目方向換算)，依影響大小排序 */
function reportBridgeContribs_() {
  const R = reportData, T = R.target, B = R.base;
  return R.lines.map(l => {
    const sign = profitSign_(l);
    if (!sign) return null;
    if (R.lines.some(x => x.ParentLine === l.LineCode)) return null;   // 有子科目的群組不重複算
    const d = ((T.weighted[l.LineCode] || 0) - (B.weighted[l.LineCode] || 0)) * sign;
    return Math.abs(d) >= 0.5 ? { code: l.LineCode, label: shortLineName(l.LineName), value: d } : null;
  }).filter(x => x).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}
/**
 * 依設定把科目變成長條：同一個合併名稱的科目合成一根；影響小於門檻、或超過根數上限的併成「其他」。
 * 回傳 [{ label, value, tip }]
 */
function bridgeBars_(contribs, cfg) {
  const groups = cfg.groups || {};
  const items = [], byName = {};
  contribs.forEach(c => {
    const g = String(groups[c.code] || '').trim();
    if (!g) { items.push({ label: c.label, value: c.value, members: [c] }); return; }
    if (!byName[g]) { byName[g] = { label: g, value: 0, members: [] }; items.push(byName[g]); }
    byName[g].value += c.value;
    byName[g].members.push(c);
  });
  items.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const topN = num(cfg.topN) > 0 ? Math.floor(num(cfg.topN)) : Infinity, minAbs = Math.max(0, num(cfg.minAbs));
  const shown = [], rest = [];
  items.forEach(it => { (shown.length < topN && Math.abs(it.value) >= minAbs && Math.abs(it.value) >= 0.5 ? shown : rest).push(it); });
  const tipOf = it => it.label + '\n' + signed_(it.value) + ' 元/台' +
    (it.members.length > 1 ? '\n' + it.members.map(m => `・${m.label} ${signed_(m.value)}`).join('\n') : '');
  const bars = shown.map(it => ({ label: it.label, value: it.value, tip: tipOf(it) }));
  const restMembers = [].concat.apply([], rest.map(it => it.members));
  const restSum = restMembers.reduce((a, m) => a + m.value, 0);
  if (restMembers.length && Math.abs(restSum) >= 0.5) {
    const other = { label: `其他 ${restMembers.length} 個科目`, value: restSum, members: restMembers };
    bars.push({ label: other.label, value: restSum, tip: tipOf(other) });
  }
  return bars;
}
/** 差距拆解的每一根(跟瀑布圖工具同一種 steps 格式，所以可以直接「在瀑布圖工具開啟」) */
function reportBridgeSteps_() {
  const R = reportData, T = R.target, B = R.base;
  const contribs = reportBridgeContribs_();
  const start = rProfit_(B), end = rProfit_(T);
  const steps = bridgeBars_(contribs, reportBridgeCfg || defaultBridgeCfg_()).map(b => ({ label: b.label, value: b.value, kind: 'delta', tip: b.tip }));
  const other = (end - start) - contribs.reduce((s, c) => s + c.value, 0);
  if (Math.abs(other) >= 1) steps.push({ label: '公式/取整差異', value: other, kind: 'delta' });
  return [{ label: '現況 營業淨利', value: start, kind: 'total' }].concat(steps, [{ label: '目標 營業淨利', value: end, kind: 'total' }]);
}
/** 差距拆解(瀑布圖)：現況營業淨利 → 各科目的影響 → 目標營業淨利。根數、合併方式可以在「調整長條」設定 */
function reportBridgeHtml_() {
  const contribs = reportBridgeContribs_();
  const cfg = reportBridgeCfg || defaultBridgeCfg_();
  const nGroups = Object.keys(cfg.groups || {}).filter(k => String(cfg.groups[k] || '').trim() && contribs.some(c => c.code === k)).length;
  const actionsByCode = {};
  reportActions.forEach(a => { if (a.LineCode) (actionsByCode[a.LineCode] = actionsByCode[a.LineCode] || []).push(a); });
  return `
    <div class="bridge-tools no-print"><button type="button" class="btn secondary sm" id="rpt-bridge-edit" onclick="editBridgeCfg_()">調整長條（合併科目／顯示幾根）…</button>
      <span class="muted">${num(cfg.topN) > 0 ? `最多 ${Math.floor(num(cfg.topN))} 根` : '不限根數'}${num(cfg.minAbs) > 0 ? `・影響小於 ${fmt(num(cfg.minAbs))} 元/台併入「其他」` : ''}${nGroups ? `・${nGroups} 個科目已合併` : ''}</span></div>
    <div class="bridge-legend"><span><i style="display:inline-block;width:10px;height:10px;background:#2d3748;border-radius:2px;"></i> 營業淨利</span>
      <span><i style="display:inline-block;width:10px;height:10px;background:#38a169;border-radius:2px;"></i> 改善</span>
      <span><i style="display:inline-block;width:10px;height:10px;background:#e53e3e;border-radius:2px;"></i> 惡化</span>
      <span class="spacer"></span><button type="button" class="btn secondary sm no-print" onclick="openInWaterfallTool_(reportBridgeSteps_(), '營業淨利：現況 → 目標 差距拆解')">在瀑布圖工具開啟</button></div>
    ${wfSvg_(reportBridgeSteps_(), { width: 1180, height: 380, labels: true, fmtV: v => shortAmount_(v / reportUnit) })}
    <div class="two-col" style="margin-top:10px;">
      <div><b style="font-size:13px;">改善最多</b><ul class="problem-list">${contribs.filter(c => c.value > 0).slice(0, 5).map(c =>
        `<li>${esc(c.label)} <b class="good">${rSigned_(c.value)}</b>${actionsByCode[c.code] ? ` — 作法：${actionsByCode[c.code].map(a => esc(a.Title)).join('、')}` : ''}</li>`).join('') || '<li class="muted">（無）</li>'}</ul></div>
      <div><b style="font-size:13px;">惡化最多</b><ul class="problem-list">${contribs.filter(c => c.value < 0).slice(0, 5).map(c =>
        `<li>${esc(c.label)} <b class="bad">${rSigned_(c.value)}</b></li>`).join('') || '<li class="muted">（無）</li>'}</ul></div>
    </div>`;
}
/** 調整長條：每個科目可以填「合併成」的名稱(同名的合成一根)，另外設最多幾根、多小的併入「其他」 */
function editBridgeCfg_() {
  const contribs = reportBridgeContribs_();
  const cfg = reportBridgeCfg || defaultBridgeCfg_();
  const names = Array.from(new Set(Object.keys(cfg.groups || {}).map(k => String(cfg.groups[k] || '').trim()).filter(x => x)));
  const body = `
    <p class="help">同一個「合併成」名稱的科目會合成一根長條（例如把關稅、技酬金、索賠都填「其他成本」）；留白 = 單獨一根。
      設定只存在這台電腦的瀏覽器，每個車型各一份。</p>
    <div class="field-row" style="margin-bottom:10px;">
      <label class="field"><span>最多顯示幾根（0 = 不限）</span><input type="number" min="0" step="1" id="bridge-topn" value="${esc(cfg.topN)}" style="width:120px;"></label>
      <label class="field"><span>影響小於多少元/台併入「其他」</span><input type="number" min="0" step="any" id="bridge-minabs" value="${esc(cfg.minAbs || 0)}" style="width:160px;"></label>
      <button type="button" class="btn secondary sm" style="align-self:flex-end;" onclick="this.closest('dialog').querySelectorAll('.bridge-group').forEach(i => { i.value = ''; })">全部取消合併</button>
    </div>
    <datalist id="bridge-group-names">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="grid-scroll" style="max-height:50vh;"><table class="grid-table">
      <thead><tr><th style="text-align:left;">科目</th><th>對淨利影響（元/台）</th><th style="text-align:left;">合併成</th></tr></thead>
      <tbody>${contribs.map(c => `<tr><td style="text-align:left;">${esc(c.label)}</td><td class="${c.value < 0 ? 'negative' : ''}" style="text-align:right;">${signed_(c.value)}</td>
        <td><input type="text" class="bridge-group" data-code="${esc(c.code)}" list="bridge-group-names" value="${esc((cfg.groups || {})[c.code] || '')}" placeholder="（單獨一根）" style="width:180px;"></td></tr>`).join('')}</tbody>
    </table></div>`;
  openModal({
    title: '調整差距拆解的長條', body, wide: true, okText: '套用',
    collect: dlg => {
      const groups = Object.assign({}, cfg.groups);   // 這次沒出現的科目(目前沒有差異)保留原本的設定
      dlg.querySelectorAll('.bridge-group').forEach(i => { const v = i.value.trim(); if (v) groups[i.dataset.code] = v; else delete groups[i.dataset.code]; });
      return { topN: Math.max(0, Math.floor(num(dlg.querySelector('#bridge-topn').value))), minAbs: Math.max(0, num(dlg.querySelector('#bridge-minabs').value)), groups };
    }
  }).then(res => {
    if (!res) return;
    reportBridgeCfg = res;
    saveReportPrefs_();
    const box = document.getElementById('rpt-bridge');
    if (box && reportData) box.innerHTML = reportBridgeHtml_();
  });
}
function reportCompareHtml_() {
  const R = reportData, T = R.target, B = R.base;
  const tRev = T.weighted.P8 || 0, bRev = B.weighted.P8 || 0;
  const actionsByCode = {};
  reportActions.forEach(a => { if (a.LineCode) (actionsByCode[a.LineCode] = actionsByCode[a.LineCode] || []).push(a); });
  const rows = R.lines.filter(l => reportShowPrice || !l.isPriceStructure);
  let section = '';
  return `<div class="grid-scroll"><table class="rpt-table" id="rpt-compare">
    <thead><tr><th style="text-align:left;">科目</th><th>現況</th><th>%</th><th>目標</th><th>%</th><th>差距</th><th>對淨利影響</th><th style="text-align:left;">對應作法</th><th style="text-align:left;">說明（目標）</th></tr></thead>
    <tbody>${rows.map(l => {
      let head = '';
      const sec = l.isPriceStructure ? '售價結構' : '損益';
      if (sec !== section) { section = sec; head = `<tr class="section"><td colspan="9">${sec}</td></tr>`; }
      const tv = T.weighted[l.LineCode], bv = B.weighted[l.LineCode];
      const d = (tv || 0) - (bv || 0);
      const sign = l.isSubtotal ? (l.LineCode === 'B' ? -1 : 1) : profitSign_(l);
      const eff = d * sign;
      const cls = !sign || Math.abs(eff) < 0.5 ? '' : eff > 0 ? 'gap-good' : 'gap-bad';
      const acts = actionsByCode[l.LineCode] || [];
      return head + `<tr class="${l.LineCode === rK_() ? 'key' : l.isSubtotal ? 'subtotal' : ''}">
        <td class="name" style="padding-left:${8 + (l.Depth || 0) * 14}px;">${esc(shortLineName(l.LineName))}</td>
        <td>${rAmt_(bv)}</td><td class="pct">${l.isPriceStructure ? '' : rPct_(bv, bRev)}</td>
        <td>${rAmt_(tv)}</td><td class="pct">${l.isPriceStructure ? '' : rPct_(tv, tRev)}</td>
        <td class="${cls}">${Math.abs(d) < 0.5 ? '' : rSigned_(d)}</td>
        <td class="${cls}">${!sign || Math.abs(eff) < 0.5 ? '' : rSigned_(eff)}</td>
        <td class="actions-cell">${acts.map(a => `• ${esc(a.Title)}`).join('<br>')}</td>
        ${noteCellHtml_(T, l.LineCode)}</tr>`;
    }).join('')}</tbody></table></div>`;
}

function reportFsHtml_(block, tableId) {
  const R = reportData;
  const vehicles = block.vehicles || [];
  const rev = block.weighted.P8 || 0;
  const rows = R.lines.filter(l => reportShowPrice || !l.isPriceStructure || ['P1'].indexOf(l.LineCode) !== -1);
  return `<div class="grid-scroll"><table class="rpt-table" id="${tableId}">
    <thead><tr><th style="text-align:left;">車型</th>${vehicles.map(v => `<th>${esc(v.VehicleCode)}</th>`).join('')}<th>${esc(R.vehicleTypeId)} 加權平均</th><th>%</th><th style="text-align:left;">說明</th></tr>
      <tr class="sub"><th style="text-align:left;">銷售構成比</th>${vehicles.map(v => `<th>${fmt(v.salesMixPct, 1)}%</th>`).join('')}<th>100%</th><th></th><th></th></tr>
      <tr class="sub"><th style="text-align:left;">預估銷售台數(月)</th>${vehicles.map(v => `<th>${fmt(v.monthlyVolume)}</th>`).join('')}<th>${fmt(block.volume.monthlyVolume)}</th><th></th><th style="text-align:left;">L/C ${esc(String(block.volume.lifeCycleYears || ''))} 年，合計 ${fmt(block.volume.units)} 台</th></tr></thead>
    <tbody>${rows.map(l => `<tr class="${l.LineCode === rK_() ? 'key' : l.isSubtotal ? 'subtotal' : ''}">
      <td class="name" style="padding-left:${8 + (l.Depth || 0) * 14}px;">${esc(shortLineName(l.LineName))}</td>
      ${vehicles.map(v => { const x = v.amounts[l.LineCode]; return `<td class="${x < 0 ? 'negative' : ''}">${x === undefined ? '' : rAmt_(x)}</td>`; }).join('')}
      <td class="${block.weighted[l.LineCode] < 0 ? 'negative' : ''}" style="font-weight:700;">${rAmt_(block.weighted[l.LineCode])}</td>
      <td class="pct">${l.isPriceStructure ? '' : rPct_(block.weighted[l.LineCode], rev)}</td>
      ${noteCellHtml_(block, l.LineCode)}</tr>`).join('')}</tbody></table></div>`;
}

function reportActionsHtml_() {
  return `<div id="rpt-actions-wrap">${reportActionsTableHtml_()}</div>
    <div class="toolbar no-print" style="margin-top:10px;">
      <button type="button" class="btn secondary" onclick="addReportAction()">＋ 新增作法</button>
      <span class="spacer"></span>
      <span class="muted">效果 = 對營業淨利的單台改善金額（正數 = 改善）</span>
    </div>`;
}
function reportActionsTableHtml_() {
  const R = reportData, T = R.target, B = R.base;
  const gap = B ? rProfit_(T) - rProfit_(B) : null;
  const vol = T.volume.monthlyVolume || 0;
  const lineOpts = R.lines.filter(l => !l.isPriceStructure && !l.isSubtotal);
  const total = reportActions.reduce((s, a) => s + num(a.Effect), 0);
  const dirty = "markDirty('report', saveReport_, () => { clearDirty(); loadReport_(); })";
  return `<div class="grid-scroll"><table class="grid-table rpt-table action-table" id="rpt-actions">
    <thead><tr><th class="no-print" style="width:34px;"></th><th>項次</th><th style="text-align:left;">作法</th><th>科目</th><th>擔當</th><th>效果(元/台)</th><th>月效益(萬)</th><th>狀態</th><th>預計完成</th><th class="no-print"></th></tr></thead>
    <tbody id="rpt-actions-body">${reportActions.length ? reportActions.map((a, i) => `<tr data-key="${i}">
      <td class="row-actions no-print">${dragHandleHtml()}</td>
      <td style="text-align:center;">${i + 1}</td>
      <td style="text-align:left;"><input type="text" class="title-input" value="${esc(a.Title)}" placeholder="作法說明" oninput="reportActions[${i}].Title=this.value;${dirty}"></td>
      <td><select onchange="reportActions[${i}].LineCode=this.value;refreshRecon_();${dirty}"><option value="">（不指定）</option>${lineOpts.map(l =>
        `<option value="${esc(l.LineCode)}"${a.LineCode === l.LineCode ? ' selected' : ''}>${esc(shortLineName(l.LineName))}</option>`).join('')}</select></td>
      <td><input type="text" value="${esc(a.Owner)}" style="width:90px;" placeholder="部門" oninput="reportActions[${i}].Owner=this.value;${dirty}"></td>
      <td><input type="number" step="any" value="${esc(a.Effect)}" oninput="reportActions[${i}].Effect=this.value;updateReportActionTotals_();${dirty}"></td>
      <td class="calc" id="rpt-act-month-${i}">${fmt(num(a.Effect) * vol / 10000, 1)}</td>
      <td><select onchange="reportActions[${i}].Status=this.value;${dirty}">${(R.actionStatuses || []).map(st => `<option${a.Status === st ? ' selected' : ''}>${st}</option>`).join('')}</select></td>
      <td><input type="date" value="${esc(a.DueDate)}" onchange="reportActions[${i}].DueDate=this.value;${dirty}"></td>
      <td class="row-actions no-print"><button type="button" class="btn ghost sm" onclick="removeReportAction(${i})">✕</button></td>
    </tr>`).join('') : `<tr><td colspan="10" class="muted" style="text-align:center;padding:16px;">還沒有作法。按「新增作法」說明差距要靠什麼補起來。</td></tr>`}</tbody>
    <tfoot>
      <tr class="total"><td class="no-print"></td><td colspan="4" style="text-align:left;">作法效果合計</td><td id="rpt-act-total">${fmt(total)}</td><td id="rpt-act-total-m">${fmt(total * vol / 10000, 1)}</td><td colspan="3"></td></tr>
      ${gap !== null ? `<tr class="total"><td class="no-print"></td><td colspan="4" style="text-align:left;">現況 → 目標差距</td><td>${fmt(gap)}</td><td>${fmt(gap * vol / 10000, 1)}</td><td colspan="3"></td></tr>
      <tr class="total"><td class="no-print"></td><td colspan="4" style="text-align:left;">尚待補足（差距 − 作法）</td><td id="rpt-act-remain" class="${gap - total > 0.5 ? 'negative' : 'good'}">${fmt(gap - total)}</td><td></td><td colspan="3"></td></tr>` : ''}
    </tfoot></table></div>`;
}
/**
 * 作法瀑布：現況營業淨利 → 每一項作法的效果 → 目標營業淨利。
 * 作法加總跟實際差距對不起來的部分單獨一根：差距比作法多 =「尚待補足」，作法比差距多 =「作法高估/其他惡化」。
 * 作法超過 10 項時，效果小的併成「其他作法」。表格上改作法，這張圖即時跟著變。
 */
function reportActionWfSteps_() {
  const R = reportData, T = R.target, B = R.base;
  if (!B) return [];
  const start = rProfit_(B), end = rProfit_(T);
  let acts = reportActions.filter(a => String(a.Title || '').trim() && num(a.Effect))
    .map(a => ({ label: a.Title, value: num(a.Effect), kind: 'delta', tip: `${a.Title}\n${[a.LineCode ? reportLineName_(a.LineCode) : '', a.Owner, a.Status].filter(x => x).join('｜')}\n${signed_(num(a.Effect))} 元/台` }));
  if (acts.length > 10) {
    const ranked = acts.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const drop = ranked.slice(9);
    acts = acts.filter(a => drop.indexOf(a) === -1);
    acts.push({ label: `其他 ${drop.length} 項作法`, value: drop.reduce((s, a) => s + a.value, 0), kind: 'delta' });
  }
  const steps = [{ label: `現況 ${reportLineName_(B.profitCode || rK_())}`, value: start, kind: 'total' }].concat(acts);
  const remain = (end - start) - acts.reduce((s, a) => s + a.value, 0);
  if (Math.abs(remain) >= 0.5) steps.push({ label: remain > 0 ? '其他改善（沒有寫成作法）' : '作法高估或其他惡化', value: remain, kind: 'delta', remain: true });
  steps.push({ label: `目標 ${reportLineName_(rK_())}`, value: end, kind: 'total' });
  return steps;
}
function reportActionWaterfallHtml_() {
  const R = reportData;
  if (!R.base) return '';
  const steps = reportActionWfSteps_();
  const start = steps[0].value, end = steps[steps.length - 1].value;
  const remainStep = steps.find(x => x.remain);
  const remain = remainStep ? remainStep.value : 0;
  const total = end - start - remain;
  return `${wfSvg_(steps, { width: 1180, height: 400, labels: true, fmtV: v => shortAmount_(v / reportUnit) })}
    <div class="field-row" style="margin-top:6px;"><span class="muted">作法效果合計 <b>${rSigned_(total)}</b>　現況 → 目標差距 <b>${rSigned_(end - start)}</b>${remainStep ? `　<span class="${remain < 0 ? 'bad' : ''}">${remain > 0 ? '差距中沒有對應作法' : '作法比實際改善多'} <b>${rSigned_(Math.abs(remain))}</b></span>` : '　作法與差距吻合'}</span>
      <span class="spacer"></span><button type="button" class="btn secondary sm no-print" onclick="openInWaterfallTool_(reportActionWfSteps_(), '營業淨利：現況 → 作法 → 目標')">在瀑布圖工具開啟</button></div>`;
}
function refreshActionWaterfall_() {
  const w = document.getElementById('rpt-act-wf');
  if (w) w.innerHTML = reportActionWaterfallHtml_();
}
function refreshRecon_() {
  const w = document.getElementById('rpt-recon-wrap');
  if (w) w.innerHTML = reportReconHtml_();
}
function updateReportActionTotals_() {
  refreshRecon_();
  refreshActionWaterfall_();
  const R = reportData, vol = R.target.volume.monthlyVolume || 0;
  const total = reportActions.reduce((s, a) => s + num(a.Effect), 0);
  reportActions.forEach((a, i) => { const el = document.getElementById('rpt-act-month-' + i); if (el) el.textContent = fmt(num(a.Effect) * vol / 10000, 1); });
  const t = document.getElementById('rpt-act-total'); if (t) t.textContent = fmt(total);
  const tm = document.getElementById('rpt-act-total-m'); if (tm) tm.textContent = fmt(total * vol / 10000, 1);
  if (R.base) {
    const gap = rProfit_(R.target) - rProfit_(R.base);
    const r = document.getElementById('rpt-act-remain');
    if (r) { r.textContent = fmt(gap - total); r.className = gap - total > 0.5 ? 'negative' : 'good'; }
  }
}
function redrawReportActions_() {
  const wrap = document.getElementById('rpt-actions-wrap');
  if (!wrap) return;
  refreshRecon_();
  refreshActionWaterfall_();
  wrap.innerHTML = reportActionsTableHtml_();
  makeSortable(document.getElementById('rpt-actions-body'), {
    items: 'tr[data-key]',
    onEnd: keys => { const old = reportActions; reportActions = keys.map(k => old[Number(k)]); redrawReportActions_(); markDirty('report', saveReport_, () => { clearDirty(); loadReport_(); }); }
  });
}
function addReportAction() {
  reportActions.push({ ActionID: '', Title: '', LineCode: '', Owner: '', Effect: '', Status: '規劃中', DueDate: '' });
  redrawReportActions_();
  markDirty('report', saveReport_, () => { clearDirty(); loadReport_(); });
  const inputs = document.querySelectorAll('#rpt-actions-body .title-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}
function removeReportAction(i) {
  reportActions.splice(i, 1);
  redrawReportActions_();
  markDirty('report', saveReport_, () => { clearDirty(); loadReport_(); });
}

function reportPrevHtml_() {
  const R = reportData, T = R.target, P = R.prev;
  const rows = R.lines.filter(l => !l.isPriceStructure || l.LineCode === 'P1');
  const vol = (b) => b.volume.monthlyVolume || 0;
  return `<div class="grid-scroll"><table class="rpt-table" id="rpt-prev">
    <thead><tr><th style="text-align:left;">項目（加權平均）</th><th>前回 ${esc(P.meta.label)}</th><th>本回 ${esc(T.meta.label)}</th><th>差異</th><th style="text-align:left;">說明（本回）</th></tr></thead>
    <tbody>
      <tr><td class="name">L/C 及月銷數</td><td>${esc(String(P.volume.lifeCycleYears || ''))} 年，每月 ${fmt(vol(P))} 台</td><td>${esc(String(T.volume.lifeCycleYears || ''))} 年，每月 ${fmt(vol(T))} 台</td><td>${signed_(vol(T) - vol(P))} 台</td><td class="note"></td></tr>
      ${rows.map(l => {
        const pv = P.weighted[l.LineCode], tv = T.weighted[l.LineCode];
        const d = (tv || 0) - (pv || 0);
        const sign = l.isSubtotal ? (l.LineCode === 'B' ? -1 : 1) : profitSign_(l);
        const cls = !sign || Math.abs(d) < 0.5 ? '' : d * sign > 0 ? 'gap-good' : 'gap-bad';
        return `<tr class="${l.isProfit ? 'key' : l.isSubtotal ? 'subtotal' : ''}"><td class="name" style="padding-left:${8 + (l.Depth || 0) * 14}px;">${esc(shortLineName(l.LineName))}</td>
          <td>${rAmt_(pv)}</td><td>${rAmt_(tv)}</td><td class="${cls}">${Math.abs(d) < 0.5 ? '' : rSigned_(d)}</td>${noteCellHtml_(T, l.LineCode)}</tr>`;
      }).join('')}
      <tr class="key"><td class="name">營業淨利(每月)</td><td>${fmt(rProfit_(P) * vol(P) / 10000, 0)} 萬</td><td>${fmt(rProfit_(T) * vol(T) / 10000, 0)} 萬</td><td>${signed_((rProfit_(T) * vol(T) - rProfit_(P) * vol(P)) / 10000, 0)} 萬</td><td class="note"></td></tr>
    </tbody></table></div>`;
}

function reportDevHtml_() {
  const R = reportData, T = R.target.dev, B = R.base ? R.base.dev : null;
  const yi = v => fmt(v / 1e8, 2);
  return `<div class="grid-scroll"><table class="rpt-table" id="rpt-dev">
    <thead><tr><th style="text-align:left;">部門別</th><th>模具</th><th>設備</th><th>費用類</th>${T.total.other ? '<th>其他</th>' : ''}<th>小計</th><th>挑戰低減%</th><th>低減後小計</th><th style="text-align:left;">說明</th></tr></thead>
    <tbody>${T.rows.map(r => `<tr><td class="name">${esc(r.Department)}</td><td>${fmt(r.mold)}</td><td>${fmt(r.equip)}</td><td>${fmt(r.expense)}</td>${T.total.other ? `<td>${fmt(r.other)}</td>` : ''}
      <td style="font-weight:700;">${fmt(r.total)}</td><td>${r.pct ? r.pct.toFixed(0) + '%' : ''}</td><td>${fmt(r.reduced)}</td><td class="note">${esc(r.notes)}</td></tr>`).join('') ||
      '<tr><td colspan="9" class="muted" style="text-align:center;">沒有開發總投資料</td></tr>'}</tbody>
    <tfoot><tr class="subtotal"><td class="name">總計</td><td>${fmt(T.total.mold)}</td><td>${fmt(T.total.equip)}</td><td>${fmt(T.total.expense)}</td>${T.total.other ? `<td>${fmt(T.total.other)}</td>` : ''}
      <td>${fmt(T.total.total)}</td><td>${T.total.total ? ((1 - T.total.reduced / T.total.total) * 100).toFixed(0) + '%' : ''}</td><td>${fmt(T.total.reduced)}</td><td class="note"></td></tr></tfoot>
  </table></div>
  <p class="help">總額 ${yi(T.total.total)} 億元（模具 ${yi(T.total.mold)}、設備 ${yi(T.total.equip)}、費用 ${yi(T.total.expense)}），低減後 ${yi(T.total.reduced)} 億元，
    以攤提台數 ${fmt(T.lifeCycleUnits)} 台分攤，單台 ${fmt(T.lifeCycleUnits ? T.total.reduced / T.lifeCycleUnits : 0)} 元/台。
    ${B ? `現況總額 ${yi(B.total.total)} 億元，差異 ${signed_((T.total.reduced - B.total.reduced) / 1e8, 2)} 億元。` : ''}</p>`;
}

/* ---- 作法對帳：作法寫的效果，跟現況 → 目標的實際數字對得起來嗎？ ---- */
/** 科目對營業淨利的方向(對帳用)：收入/毛利/淨利 +1；成本與費用(含自訂群組) −1；售價結構 0 */
function reconSign_(l) {
  if (!l || l.isPriceStructure) return 0;
  if (l.isProfit || ['A', 'C', 'E', 'G', 'I', 'K'].indexOf(l.LineCode) !== -1) return 1;
  let cur = l, guard = 0;
  while (cur && cur.ParentLine && guard++ < 20) {
    if (cur.ParentLine === 'A') return 1;
    cur = reportData.lines.find(x => x.LineCode === cur.ParentLine);
  }
  return -1;
}
/**
 * 每個科目一列：作法效果合計 vs 實際改善(目標 − 現況，換算成對營業淨利的影響)。
 * 容差：500 元或實際改善的 5%(取大)。沒有掛科目的作法另外列一列，不參與對帳。
 * 實際變動超過 1,000 元/台卻沒有任何作法的科目也列出來 —— 簡報上最容易被問「這個是怎麼降的？」
 */
function reconRows_() {
  const R = reportData, T = R.target, B = R.base;
  if (!B) return [];
  const byCode = {};
  reportActions.forEach(a => {
    if (!String(a.Title || '').trim() && !num(a.Effect)) return;
    const k = a.LineCode || '';
    (byCode[k] = byCode[k] || { effect: 0, actions: [] });
    byCode[k].effect += num(a.Effect);
    byCode[k].actions.push(a);
  });
  const rows = [];
  R.lines.forEach(l => {
    const sign = reconSign_(l);
    const hasKids = R.lines.some(x => x.ParentLine === l.LineCode);
    const actual = ((T.weighted[l.LineCode] || 0) - (B.weighted[l.LineCode] || 0)) * sign;
    const a = byCode[l.LineCode];
    if (!a && (hasKids || !sign || l.isSubtotal || Math.abs(actual) < 1000)) return;
    const effect = a ? a.effect : 0;
    const tol = Math.max(500, Math.abs(actual) * 0.05);
    let status, tone;
    if (!a) { status = actual > 0 ? '有改善但沒有寫作法' : '變差了，沒有對應說明'; tone = 'warn'; }
    else if (Math.abs(effect - actual) <= tol) { status = '吻合'; tone = 'ok'; }
    else if (effect > actual) { status = '作法高估：數字只改善 ' + fmt(actual); tone = 'err'; }
    else { status = '數字改善比作法多 ' + fmt(actual - effect) + '，可補寫作法'; tone = 'warn'; }
    rows.push({ code: l.LineCode, name: shortLineName(l.LineName), effect, actual, diff: effect - actual, status, tone, count: a ? a.actions.length : 0 });
  });
  if (byCode['']) rows.push({ code: '', name: '（作法沒有指定科目）', effect: byCode[''].effect, actual: null, diff: null, status: '無法對帳，建議指定科目', tone: 'warn', count: byCode[''].actions.length });
  return rows;
}
function reportReconHtml_() {
  const rows = reconRows_();
  if (!rows.length) return '<p class="muted">沒有需要對帳的科目。</p>';
  const bad = rows.filter(r => r.tone !== 'ok').length;
  return `${bad ? `<div class="callout warn">有 ${bad} 個科目的作法效果跟實際數字對不起來，審議時容易被追問，建議先釐清。</div>` : '<div class="callout ok">每個科目的作法效果都跟實際數字吻合。</div>'}
    <div class="grid-scroll"><table class="rpt-table" id="rpt-recon">
    <thead><tr><th style="text-align:left;">科目</th><th>作法數</th><th>作法效果合計</th><th>實際改善（目標 − 現況）</th><th>差異</th><th style="text-align:left;">判讀</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td class="name">${esc(r.name)}</td><td>${r.count || ''}</td>
      <td>${r.count ? fmt(r.effect) : '—'}</td>
      <td class="${r.actual === null ? '' : r.actual > 0.5 ? 'gap-good' : r.actual < -0.5 ? 'gap-bad' : ''}">${r.actual === null ? '—' : signed_(r.actual)}</td>
      <td>${r.diff === null ? '—' : signed_(r.diff)}</td>
      <td class="note recon-${r.tone}">${r.tone === 'ok' ? '✔ ' : '⚠ '}${esc(r.status)}</td></tr>`).join('')}</tbody>
  </table></div>
  <p class="help">實際改善 = 該科目從現況到目標的變動，換算成對營業淨利的影響（成本降 = 正）。容差 500 元或 5%。</p>`;
}

/** 說明與作法一起存：說明逐情境存回科目說明，作法存到目標情境 */
function saveReport_() {
  const jobs = [];
  Object.keys(reportNoteEdits).forEach(sid => {
    jobs.push(new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail).saveLineNotes(sid, reportNoteEdits[sid])));
  });
  jobs.push(new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail).saveActions(reportSel.target, reportActions)));
  Promise.all(jobs).then(() => {
    clearDirty();
    Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
    toast('已儲存說明與作法', 'ok');
    loadReport_();
  }, err => toast(err.message || String(err), 'err'));
}

function printReport_() {
  if (isDirty_()) toast('提醒：還有未儲存的修改，列印內容以畫面為準', 'warn');
  window.print();
}
/** 把表格轉成 Tab 分隔文字放進剪貼簿，貼進 PowerPoint/Excel 會自動變成表格 */
function copyReportTable(id) {
  const table = document.getElementById(id);
  if (!table) return;
  const rows = Array.from(table.querySelectorAll('tr')).map(tr => Array.from(tr.children)
    .filter(td => !td.classList.contains('no-print'))
    .map(td => {
      const inp = td.querySelector('input,select');
      const text = inp ? (inp.tagName === 'SELECT' ? (inp.options[inp.selectedIndex] || {}).text || '' : inp.value) : td.innerText;
      return String(text).replace(/\s*\n\s*/g, ' ').trim();
    }).join('\t'));
  const tsv = rows.join('\n');
  const done = ok => toast(ok ? '已複製表格，可以直接貼進 PowerPoint 或 Excel' : '無法自動複製，請改用列印存成 PDF', ok ? 'ok' : 'err');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tsv).then(() => done(true), () => done(false));
  else done(false);
}
