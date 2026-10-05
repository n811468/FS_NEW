/* ---- hover 提示的內容產生器：表格格子/欄位標題/科目名稱不用事先把整段文字塞進 HTML，移過去才算 ---- */
function tipColOf_(el) {
  const i = Number(el.getAttribute('data-c'));
  return lastComparison && lastComparison.columns ? lastComparison.columns[i] : null;
}
function tipLineOf_(el) {
  const code = el.getAttribute('data-l');
  return lastComparison && lastComparison.lines ? lastComparison.lines.find(l => l.LineCode === code) : null;
}
/** 表格格子：這是哪一欄、哪個科目、金額(單台/總額)、兩種百分比、跟基準差多少、貨物稅的計算過程 */
function cellTipText_(el) {
  const col = tipColOf_(el), line = tipLineOf_(el);
  if (!col || !line) return '';
  const v = col.amounts[line.LineCode];
  const name = shortLineName(line.LineName);
  if (v === undefined || v === null) return `${col.label}\n${name}\n此欄位沒有這個科目`;
  const parts = [col.label, name + (line.AutoSource ? '（自動計算）' : '')];
  parts.push(`${fmt(displayAmount_(v, col))} ${unitLabel_()}（${basisLabel_()}${volumeBasis !== 'unit' ? '：' + basisFormula_(col) : ''}）`);
  if (volumeBasis !== 'unit' || amountUnit !== 1) parts.push(`單台 ${fmt(v)} 元`);
  if (!line.isPriceStructure) parts.push(`對廠價(未稅) ${pctText_(v, col.exFactoryPrice)}　對收入 ${pctText_(v, col.revenue)}`);
  const base = baselineCol_(lastComparison.columns || []);
  if (base && colKey_(base) !== colKey_(col)) {
    const bv = base.amounts[line.LineCode];
    if (bv !== undefined && bv !== null) {
      const delta = displayAmount_(v, col) - displayAmount_(bv, base);
      const bd = displayAmount_(bv, base);
      const tone = deltaTone_(line, delta);
      parts.push(`vs 基準（${base.vehicleLabel || base.label}）${signed_(delta)}${bd ? `（${signed_(delta / Math.abs(bd) * 100, 1)}%）` : ''}${tone === 'good' ? ' ✔' : tone === 'bad' ? ' ✘' : ''}`);
    }
  }
  const trace = col.traces && col.traces[line.LineCode];
  if (col.errors && col.errors[line.LineCode]) parts.push('⚠ 公式錯誤（以 0 計）：' + col.errors[line.LineCode]);
  if (trace && !line.isSubtotal) parts.push('計算過程：\n' + traceText_(trace, buildCodeNameMap_(lastComparison.lines)));
  else if (col.isWeighted && line.Formula && !line.isSubtotal) parts.push('加權平均是多個車系混出來的，沒有單一計算過程；請看各車系欄位');
  return parts.join('\n');
}
/** 欄位標題/重點指標卡片：這一欄的情境性質、台數基礎、加權平均的組成 */
function colTipText_(el) {
  const col = tipColOf_(el);
  if (!col) return '';
  const v = col.volume || {};
  const parts = [col.label];
  const meta = [col.scenarioType ? `情境性質：${col.scenarioType}` : '', col.scenarioNotes ? `備註：${col.scenarioNotes}` : ''].filter(p => p);
  if (meta.length) parts.push(meta.join('　'));
  if (col.isWeighted) {
    const mix = (v.mix || []).filter(m => m.pct || m.monthlyVolume);
    parts.push('加權平均：' + (mix.length ? mix.map(m => `${m.vehicleLabel} ${fmt(m.pct, 1)}%`).join('・') : '（此情境沒有銷售構成）'));
    const years = v.lifeCycleYearsMax && v.lifeCycleYearsMax !== v.lifeCycleYears ? `${v.lifeCycleYears}~${v.lifeCycleYearsMax}` : String(v.lifeCycleYears || 0);
    parts.push(`總月銷量 ${fmt(v.monthlyVolume)} 台・LC ${years} 年・LC 總台數 ${fmt(v.units)} 台`);
  } else {
    parts.push(`月銷量 ${fmt(v.monthlyVolume)} 台 × 12 × LC ${fmt(v.lifeCycleYears)} 年 = ${fmt(v.units)} 台・構成比 ${fmt(v.salesMixPct, 1)}%`);
  }
  parts.push(`廠價(未稅) ${fmt(col.exFactoryPrice)}　收入 ${fmt(col.revenue)}`);
  const k = col.amounts[profitCodeOf_(col)];
  if (k !== undefined && k !== null) parts.push(`營業淨利 ${fmt(k)}（對廠價 ${pctText_(k, col.exFactoryPrice)}）`);
  if (volumeBasis !== 'unit') {
    parts.push(`表上金額 = ${basisFormula_(col)}`);
    const warn = weightedTotalCaveat_(col);
    if (warn) parts.push(warn);
  }
  return parts.join('\n');
}

/**
 * 加權平均欄位換算成年度/LC 總額時的提醒。
 * 加權平均的單台金額是用「銷售構成比(SalesMixPct)」加權出來的，總額卻是乘上各車系台數的總和；
 * 只有在構成比跟台數比例一致時，這個總額才會等於各車系欄位總額相加。
 * 「銷售構成」頁面在畫面上編輯時會自動讓兩者同步，所以正常情況不會差；但直接在 Sheet 上改數字、
 * 或從別的情境帶入後只調了其中一邊，就可能對不起來 —— 這裡直接講出來，
 * 而不是讓使用者自己拿計算機加完才發現兜不攏。
 */
function weightedTotalCaveat_(col) {
  if (!col.isWeighted) return '';
  const mix = ((col.volume || {}).mix || []).filter(m => m.pct || m.monthlyVolume);
  const totalPct = mix.reduce((s, m) => s + (Number(m.pct) || 0), 0);
  const totalVol = mix.reduce((s, m) => s + (Number(m.monthlyVolume) || 0), 0);
  if (mix.length < 2 || !totalPct || !totalVol) return '';
  const maxGap = Math.max.apply(null, mix.map(m =>
    Math.abs((Number(m.pct) || 0) / totalPct - (Number(m.monthlyVolume) || 0) / totalVol) * 100));
  if (maxGap < 1) return '';
  return `⚠ 構成比與台數比例相差最多 ${maxGap.toFixed(1)} 個百分點，` +
    '這一欄的總額(加權單台 × 總台數)不會等於各車系欄位的總額相加；' +
    '要對得起來請到「銷售構成」重新輸入一次台數(輸入時構成比會自動跟著重算)。';
}
/** 科目名稱：公式、自動計算來源、屬於哪一段 */
function lineTipText_(el) {
  const line = tipLineOf_(el);
  if (!line || !lastComparison) return '';
  const codeNameMap = buildCodeNameMap_(lastComparison.lines);
  const parts = [shortLineName(line.LineName)];
  const formula = line.Formula ? '= ' + humanizeFormula_(line.Formula, codeNameMap, line.LineCode) : humanizeFormula_(splitFormula(line.LineName).formula, codeNameMap);
  if (formula) parts.push(formula);
  if (line.CalcType === 'INPUT') parts.push('手動輸入');
  else if (line.AutoSource) parts.push((AUTO_SOURCE_HINTS[line.AutoSource] || '').split('\n')[0]);
  if (line.ParentLine) parts.push(`計入：${codeNameMap[line.ParentLine] || line.ParentLine}`);
  else if (line.isPriceStructure) parts.push('售價結構，不計入損益加總');
  else if (line.isSubtotal) parts.push('小計/毛利/淨利列');
  const better = lineBetter_(line);
  if (better) parts.push(better === 'high' ? '越高越好' : '越低越好');
  return parts.join('\n');
}
const TIP_PROVIDERS_ = { cell: cellTipText_, col: colTipText_, line: lineTipText_ };

/**
 * 表格的十字游標：滑鼠在哪一格，那一列與那一欄一起變色。
 * 比較欄位一多(每欄還有金額/%兩小欄)，眼睛很難從格子對回上面的標題，這比 hover 提示更常用。
 * 事件掛在 dashboard-content 上(只掛一次)，表格重畫也不用重掛。
 */
function installTableCrosshair_(root) {
  if (!root || !root.addEventListener || root.__crosshair) return;
  root.__crosshair = true;
  let curCol = null, curRow = null;
  const setCol = (c, on) => root.querySelectorAll(`.pl-table [data-c="${c}"]`).forEach(el => el.classList.toggle('hl-col', on));
  const clear = () => {
    if (curCol !== null) setCol(curCol, false);
    if (curRow) curRow.classList.remove('hl-row');
    curCol = null; curRow = null;
  };
  root.addEventListener('mouseover', e => {
    const cell = e.target.closest && e.target.closest('td[data-c], th[data-c], td.row-head');
    if (!cell || !cell.closest('table.pl-table')) { clear(); return; }
    const c = cell.getAttribute('data-c');
    if (c !== curCol) { if (curCol !== null) setCol(curCol, false); if (c !== null) setCol(c, true); curCol = c; }
    const row = cell.closest('tr');
    const inBody = row && row.parentElement && row.parentElement.tagName === 'TBODY';
    if (row !== curRow) { if (curRow) curRow.classList.remove('hl-row'); if (inBody) row.classList.add('hl-row'); curRow = inBody ? row : null; }
  });
  root.addEventListener('mouseout', e => {
    const to = e.relatedTarget;
    if (!to || !to.closest || !to.closest('table.pl-table')) clear();
  });
  root.__clearCrosshair = clear;
}

/** Apps Script 沙箱不方便直接下載檔案，改成把 CSV 內容顯示出來供複製貼上到 Excel */
function showComparisonCsv() {
  if (!lastComparison) return;
  const cols = lastComparison.columns;
  const showPct = pctBase === 'exfactory' || pctBase === 'revenue';
  const pctHeader = pctBase === 'revenue' ? '對收入%' : '對廠價%';

  const header = ['科目', '項目'];
  cols.forEach(c => {
    header.push(`${c.label}（${unitLabel_()}・${basisLabel_()}）`);
    if (showPct) header.push(c.label + ' ' + pctHeader);
  });

  const rows = [header];
  lastComparison.lines
    .filter(line => showPriceStructure || !line.isPriceStructure)
    .forEach(line => {
      const row = [line.LineCode, line.LineName];
      cols.forEach(c => {
        const v = c.amounts[line.LineCode];
        if (v === undefined || v === null) {
          row.push('');
          if (showPct) row.push('');
          return;
        }
        row.push(amtDigits_() ? Math.round(displayAmount_(v, c) * 10) / 10 : Math.round(displayAmount_(v, c)));
        if (showPct) {
          const base = pctBaseOf_(c);
          row.push(base ? (v / base * 100).toFixed(1) : '');
        }
      });
      rows.push(row);
    });

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const box = document.getElementById('csv-output');
  box.style.display = 'block';
  box.innerHTML = `<div class="toolbar"><span class="muted">全選複製後可直接貼進 Excel：</span>
    <button type="button" class="btn secondary" onclick="copyCsvToClipboard()">複製到剪貼簿</button>
    <button type="button" class="btn secondary" onclick="document.getElementById('csv-output').style.display='none'">關閉</button>
    <span id="csv-copy-status" class="status-msg"></span></div>
    <textarea class="csv-box">${esc(csv)}</textarea>`;
  box.querySelector('textarea').select();
}
function copyCsvToClipboard() {
  const box = document.getElementById('csv-output');
  const ta = box && box.querySelector('textarea');
  const status = document.getElementById('csv-copy-status');
  if (!ta) return;
  const done = ok => { if (status) { status.textContent = ok ? '已複製' : '無法自動複製，請手動 Ctrl+C'; status.className = 'status-msg ' + (ok ? 'ok' : 'err'); } };
  ta.select();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(ta.value).then(() => done(true), () => done(document.execCommand && document.execCommand('copy')));
  } else {
    done(document.execCommand && document.execCommand('copy'));
  }
}

/**
 * 全域 tooltip：滑鼠移到任何帶 data-tip(固定文字) 或 data-tipfn(移過去才算內容) 的元素上就顯示，
 * 用固定定位 + 依元素座標計算，不會被表格的橫向捲動(.grid-scroll)或釘住欄位(sticky)裁切掉
 * —— 這是改用瀏覽器原生 title 屬性做不到的地方。同時支援鍵盤 focus。
 * 幾個容易出錯的細節：
 *   - 量尺寸前先把提示挪回左上角：fixed 元素若還停在上一次靠右的位置，量到的寬度會被視窗右緣壓扁，
 *     算出來的位置就偏掉(這就是之前偶爾「提示跑到奇怪的地方/被截掉」的原因)。
 *   - 滑鼠從元素移到它自己的子元素(如按鈕裡的 svg)會觸發 mouseout，不能因此就把提示關掉。
 *   - 捲動、點擊、表格重畫時都要把提示收掉，不然提示會留在原地跟內容對不上。
 *   - 表格格子的提示延遲 180ms 才出現：滑鼠掃過整張表時不會一路閃提示；圖示/長條則立刻出現。
 */
let tipEl_ = null, tipTimer_ = null, tipCurrent_ = null;
function hideTooltip_() {
  if (tipTimer_) { clearTimeout(tipTimer_); tipTimer_ = null; }
  tipCurrent_ = null;
  if (tipEl_) tipEl_.style.display = 'none';
}
function tooltipTextFor_(el) {
  const fn = el.getAttribute('data-tipfn');
  if (fn && TIP_PROVIDERS_[fn]) {
    try { return TIP_PROVIDERS_[fn](el) || ''; } catch (e) { console.error(e); return ''; }
  }
  return el.getAttribute('data-tip') || '';
}
function showTooltip_(el) {
  const text = tooltipTextFor_(el);
  if (!text) { hideTooltip_(); return; }
  tipCurrent_ = el;
  tipEl_.textContent = text;
  tipEl_.style.left = '0px';
  tipEl_.style.top = '0px';
  tipEl_.style.display = 'block';
  const r = el.getBoundingClientRect();
  const tw = tipEl_.offsetWidth, th = tipEl_.offsetHeight;
  let top = r.top - th - 8, below = false;
  if (top < 8) { top = r.bottom + 8; below = true; }
  if (top + th > window.innerHeight - 8) top = Math.max(8, window.innerHeight - th - 8);
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  tipEl_.style.top = top + 'px';
  tipEl_.style.left = left + 'px';
  tipEl_.classList.toggle('below', below);
}
function installTooltipEngine_() {
  tipEl_ = document.createElement('div');
  tipEl_.className = 'js-tooltip';
  tipEl_.id = 'js-tooltip';
  document.body.appendChild(tipEl_);

  const target = e => (e.target && e.target.closest) ? e.target.closest('[data-tip],[data-tipfn]') : null;
  const schedule = el => {
    if (tipTimer_) { clearTimeout(tipTimer_); tipTimer_ = null; }
    const slow = el.tagName === 'TD' || el.tagName === 'TH';
    if (!slow) { showTooltip_(el); return; }
    tipTimer_ = setTimeout(() => { tipTimer_ = null; showTooltip_(el); }, 180);
  };
  document.addEventListener('mouseover', e => {
    const t = target(e);
    if (!t || t === tipCurrent_) return;
    schedule(t);
  });
  document.addEventListener('mouseout', e => {
    const t = target(e);
    if (!t) return;
    if (e.relatedTarget && t.contains(e.relatedTarget)) return;   // 只是移到自己的子元素
    hideTooltip_();
  });
  document.addEventListener('focusin', e => { const t = target(e); if (t) showTooltip_(t); });
  document.addEventListener('focusout', e => { const t = target(e); if (t) hideTooltip_(); });
  document.addEventListener('scroll', hideTooltip_, true);
  document.addEventListener('click', hideTooltip_, true);
  window.addEventListener('resize', hideTooltip_);
}
