/* =============== 圖表：純 SVG，不依賴外部圖表程式庫 ===============
 * 原本用 Google Charts：要從 gstatic 載入、在公司網路環境偶爾載不進來(整個儀表板的初始化
 * 也跟著掛掉)、每次重畫都是非同步、hover 提示的長相跟表格的提示不一樣、也沒辦法在 Node 裡驗證。
 * 改成自己產生 SVG 字串：同步、可測、視窗縮放自動跟著縮(viewBox)、hover 走同一套 data-tip 提示。
 */
const CHART_COLORS_ = ['#2b6cb0', '#dd6b20', '#38a169', '#805ad5', '#d53f8c', '#319795', '#b7791f', '#4a5568', '#e53e3e', '#3182ce', '#d69e2e', '#00a3c4'];
const SUM_GROUP_NAMES_ = { E: '銷售費用', G: '產品貢獻前費用', I: '固定營業費用' };

/** 圖上的數字要短：元 → 8.8萬 / 114.7萬；千元或百分比就照原樣 */
function shortAmount_(v) {
  const n = Number(v) || 0;
  if (amountUnit === 1 && Math.abs(n) >= 1e8) return fmt(n / 1e8, 2) + '億';
  if (amountUnit === 1 && Math.abs(n) >= 1e4) return fmt(n / 1e4, 1) + '萬';
  return fmt(n);
}
function pctLabel_(v) { return pct1_(v) + '%'; }

/** 座標軸刻度：把範圍切成 1/2/2.5/5 × 10^n 的整齊間隔 */
function niceTicks_(min, max, count) {
  count = count || 5;
  if (!(max > min)) { max = min + 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t / step) * step);
  return { lo, hi, step, ticks };
}

/** 文字寬度粗估(px)：中文/全形算 1 個字寬、其餘算 0.6 個 */
function textWidth_(s, fontSize) {
  return Array.from(String(s || '')).reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 1 : 0.6), 0) * fontSize;
}
/** 橫軸標籤：先依「 / 」拆行，每行塞不下就截斷加 …；整段完整文字放在 hover 提示 */
function wrapLabel_(label, maxWidth, fontSize, maxLines) {
  const parts = String(label || '').split(' / ').filter(p => p);
  const lines = [];
  parts.forEach((p, pi) => {
    // 一段塞不下就照寬度切成好幾行(還有行數可用時)，真的沒行數了才截斷加 …
    let rest = p;
    while (rest && lines.length < maxLines) {
      if (textWidth_(rest, fontSize) <= maxWidth) { lines.push(rest); rest = ''; break; }
      const lastLine = lines.length === maxLines - 1;
      let cut = rest;
      while (cut.length > 1 && textWidth_(cut + (lastLine ? '…' : ''), fontSize) > maxWidth) cut = cut.slice(0, -1);
      if (lastLine) { lines.push(cut + '…'); rest = ''; }
      else { lines.push(cut); rest = rest.slice(cut.length); }
    }
    if (rest && lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/…?$/, '…');
    else if (pi < parts.length - 1 && lines.length >= maxLines) lines[maxLines - 1] = lines[maxLines - 1].replace(/…?$/, '…');
  });
  return lines.length ? lines : [''];
}
/** 圖表橫軸用的欄位標籤：「車型 情境 / 車系」兩行，比整串 label 用 / 切成四行好讀 */
function colChartLabel_(col) {
  return [[col.vehicleTypeLabel, col.scenarioLabel].filter(p => p).join(' '), col.vehicleLabel].filter(p => p).join(' / ');
}

/**
 * 長條圖產生器（回傳 SVG 字串）。
 * spec = {
 *   groups: [{ label, tip }],                     橫軸每一組
 *   series: [{ name, color }],                    每組裡並排的長條(stacked 時只佔一個位置)
 *   bars:   [{ g, s, y0, y1, color, tip, label }] 從 y0 畫到 y1 的浮動長條(瀑布/堆疊都靠這個)
 *   stacked, showLabels, valueFormat, width, height, markers: [{ g, y, tip }] (虛線標記，如收入基準)
 * }
 * 每根長條帶 data-tip，hover 走跟表格同一套提示。
 */
function svgBarChart_(spec) {
  const W = spec.width || 960, H = spec.height || 340;
  const groups = spec.groups || [], series = spec.series || [], bars = spec.bars || [];
  const fmtV = spec.valueFormat || shortAmount_;
  const showLabels = spec.showLabels !== false;
  if (!groups.length || !bars.length) {
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="100%"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#a0aec0" font-size="13">沒有可以畫的資料</text></svg>`;
  }
  const values = [0];
  bars.forEach(b => { values.push(Number(b.y0) || 0); values.push(Number(b.y1) || 0); });
  (spec.markers || []).forEach(m => values.push(Number(m.y) || 0));
  // 有數值標籤時上下各留一點空間，最高/最低那根的標籤才不會壓到格線或橫軸文字
  let vMin = Math.min.apply(null, values), vMax = Math.max.apply(null, values);
  if (showLabels) { const span = (vMax - vMin) || Math.abs(vMax) || 1; if (vMin < 0) vMin -= span * 0.08; if (vMax > 0) vMax += span * 0.08; }
  const axis = niceTicks_(vMin, vMax, 5);
  const tickFont = 11;
  const leftPad = Math.max.apply(null, axis.ticks.map(t => textWidth_(fmtV(t), tickFont))) + 14;
  const m = { l: Math.max(48, leftPad), r: 12, t: 14, b: 50 };
  const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
  const y = v => m.t + plotH - (v - axis.lo) / (axis.hi - axis.lo) * plotH;
  const gw = plotW / groups.length;
  const inner = gw * 0.72;
  const slots = spec.stacked ? 1 : Math.max(1, series.length);
  const bw = Math.min(inner / slots, spec.stacked ? 72 : 56);
  const x0 = g => m.l + g * gw + (gw - bw * slots) / 2;
  // 一組只有一根長條時，標籤可以比長條寬一點(鄰組的標籤至少隔著一組的距離)；多根並排就只能跟長條一樣寬
  const maxLabelW = slots === 1 ? Math.min(gw - 4, bw + 30) : bw + 4;
  const labelFontSize = 10;

  let out = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  // 格線與刻度
  axis.ticks.forEach(t => {
    const yy = y(t);
    out += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${t === 0 ? '#718096' : '#e2e8f0'}" stroke-width="${t === 0 ? 1.2 : 1}"/>`;
    out += `<text x="${m.l - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="${tickFont}" fill="#718096">${esc(fmtV(t))}</text>`;
  });
  // 長條
  bars.forEach(b => {
    const y0v = Number(b.y0) || 0, y1v = Number(b.y1) || 0;
    const top = Math.min(y(y0v), y(y1v)), bottom = Math.max(y(y0v), y(y1v));
    const h = Math.max(bottom - top, y0v === y1v ? 1.5 : 1);
    const x = x0(b.g) + (spec.stacked ? 0 : b.s * bw) + 1;
    const color = b.color || (series[b.s] && series[b.s].color) || CHART_COLORS_[b.s % CHART_COLORS_.length];
    out += `<rect class="bar" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}"${y0v === y1v ? ' opacity=".45"' : ''} data-tip="${esc(b.tip || '')}"/>`;
    if (showLabels && !spec.stacked) {
      const text = b.label !== undefined ? b.label : fmtV(y1v - y0v);
      if (textWidth_(text, labelFontSize) <= maxLabelW) {
        const up = y1v >= y0v;
        const ly = up ? top - 4 : bottom + 11;
        out += `<text class="bar-label" x="${(x + (bw - 2) / 2).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="${labelFontSize}" fill="#4a5568">${esc(text)}</text>`;
      }
    }
  });
  if (showLabels && spec.stacked) {
    // 堆疊時每一段的數字寫在段內(段夠高才寫)
    bars.forEach(b => {
      const y0v = Number(b.y0) || 0, y1v = Number(b.y1) || 0;
      const top = Math.min(y(y0v), y(y1v)), bottom = Math.max(y(y0v), y(y1v));
      if (bottom - top < 13) return;
      const text = b.label !== undefined ? b.label : fmtV(y1v - y0v);
      if (textWidth_(text, 10) > bw) return;
      out += `<text class="bar-label" x="${(x0(b.g) + bw / 2).toFixed(1)}" y="${((top + bottom) / 2 + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" fill="#fff" pointer-events="none">${esc(text)}</text>`;
    });
  }
  // 標記線(如收入基準)
  (spec.markers || []).forEach(mk => {
    const yy = y(Number(mk.y) || 0);
    const xs = m.l + mk.g * gw + gw * 0.08, xe = m.l + (mk.g + 1) * gw - gw * 0.08;
    out += `<line class="marker" x1="${xs.toFixed(1)}" x2="${xe.toFixed(1)}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="#1a202c" stroke-width="1.5" stroke-dasharray="4 3" data-tip="${esc(mk.tip || '')}"/>`;
  });
  // 橫軸標籤
  const labelFont = 11;
  groups.forEach((g, i) => {
    const lines = wrapLabel_(g.label, gw - 6, labelFont, 3);
    const cx = m.l + i * gw + gw / 2;
    out += `<text class="x-label" x="${cx.toFixed(1)}" y="${(m.t + plotH + 14).toFixed(1)}" text-anchor="middle" font-size="${labelFont}" fill="#4a5568" data-tip="${esc(g.tip || g.label || '')}">`;
    lines.forEach((ln, k) => { out += `<tspan x="${cx.toFixed(1)}" dy="${k === 0 ? 0 : 12}">${esc(ln)}</tspan>`; });
    out += '</text>';
  });
  out += '</svg>';
  return out;
}

function chartLegendHtml_(items) {
  return `<div class="chart-legend">${items.map(it =>
    `<span class="legend-chip"><i style="background:${it.color}"></i>${esc(it.name)}</span>`).join('')}</div>`;
}

/** 圖表數值口徑：金額(單位/基礎跟表格一致) 或 百分比(跟表格的 % 基準一致，沒選 % 就對廠價) */
function chartValueOf_(col, code) {
  const v = col.amounts[code];
  if (v === undefined || v === null) return null;
  if (chartValue === 'pct') {
    const base = pctBaseOf_(col) || Number(col.exFactoryPrice) || Number(col.revenue);
    return base ? Number(v) / base * 100 : 0;
  }
  return displayAmount_(v, col);
}
function chartValueFormat_() { return chartValue === 'pct' ? pctLabel_ : shortAmount_; }
function chartValueUnitText_() {
  return chartValue === 'pct' ? `${pctBaseName_()}%` : `${unitLabel_()}・${basisLabel_()}`;
}
/** 圖表 hover 的標準內容：欄位、科目、數值、兩種百分比 */
function chartBarTip_(col, line) {
  const v = col.amounts[line.LineCode];
  const name = shortLineName(line.LineName);
  const parts = [col.label, name];
  parts.push(`${fmt(displayAmount_(v, col))} ${unitLabel_()}（${basisLabel_()}）`);
  if (volumeBasis !== 'unit') parts.push(`單台 ${fmt(v)} 元`);
  if (!line.isPriceStructure) parts.push(`對廠價 ${pctText_(v, col.exFactoryPrice)}　對收入 ${pctText_(v, col.revenue)}`);
  return parts.join('\n');
}
function pctText_(v, base) {
  base = Number(base);
  return base ? pct1_(Number(v) / base * 100) + '%' : '—';
}

/** 科目比較圖(橫軸 = 科目、每組裡一根長條 = 一個比較欄位)，或倒過來(橫軸 = 比較欄位) */
function lineComparisonChartHtml_(cols, lines) {
  const codes = chartLineCodes.length ? chartLineCodes : ['A'];
  const picked = lines.filter(l => codes.indexOf(l.LineCode) !== -1);
  if (!picked.length) return '<p class="muted">請在左邊勾選至少一個科目。</p>';
  const fmtV = chartValueFormat_();
  const byLine = chartType === 'byLine';
  const groups = byLine
    ? picked.map(l => ({ label: shortLineName(l.LineName), tip: shortLineName(l.LineName) }))
    : cols.map(c => ({ label: colChartLabel_(c), tip: c.label }));
  const series = byLine
    ? cols.map((c, i) => ({ name: c.label, color: CHART_COLORS_[i % CHART_COLORS_.length] }))
    : picked.map((l, i) => ({ name: shortLineName(l.LineName), color: CHART_COLORS_[i % CHART_COLORS_.length] }));
  const bars = [];
  picked.forEach((l, li) => cols.forEach((c, ci) => {
    const v = chartValueOf_(c, l.LineCode);
    if (v === null) return;
    bars.push({ g: byLine ? li : ci, s: byLine ? ci : li, y0: 0, y1: v, tip: chartBarTip_(c, l) });
  }));
  return chartLegendHtml_(series) +
    svgBarChart_({ groups, series, bars, showLabels: chartLabels, valueFormat: fmtV, height: 360 });
}

/** 損益結構圖的組成：收入被哪幾段吃掉、最後剩多少營業淨利 */
function structureParts_(col, lines) {
  const a = col.amounts;
  const has = code => a[code] !== undefined && a[code] !== null;
  const nameOf = code => { const l = lines.find(x => x.LineCode === code); return l ? shortLineName(l.LineName) : code; };
  const parts = [];
  if (has('B')) parts.push({ name: nameOf('B'), value: a.B, color: '#c53030', line: lines.find(l => l.LineCode === 'B') });
  if (has('C') && has('E')) parts.push({ name: SUM_GROUP_NAMES_.E, value: a.C - a.E, color: '#dd6b20', sum: 'E' });
  if (has('E') && has('G')) parts.push({ name: SUM_GROUP_NAMES_.G, value: a.E - a.G, color: '#d69e2e', sum: 'G' });
  if (has('G') && has('I')) parts.push({ name: SUM_GROUP_NAMES_.I, value: a.G - a.I, color: '#805ad5', sum: 'I' });
  if (has('J')) parts.push({ name: nameOf('J'), value: a.J, color: '#718096', line: lines.find(l => l.LineCode === 'J') });
  const k = profitCodeOf_(col);
  if (has(k)) parts.push({ name: nameOf(k), value: a[k], color: a[k] < 0 ? '#e53e3e' : '#2f855a', line: lines.find(l => l.LineCode === k), isProfit: true });
  return parts;
}

/**
 * 損益結構圖：每個比較欄位一根堆疊長條，把收入拆成銷貨成本、各段費用與營業淨利。
 * 用收入(未稅,含強配) A 當 100%：各段加起來剛好等於收入；營業淨利是負的就會落到 0 以下、
 * 上面的成本費用堆超過收入線(虛線)，一眼看得出是哪一段把利潤吃掉的。
 */
function structureChartHtml_(cols, lines) {
  const isPct = chartValue === 'pct';
  const fmtV = isPct ? pctLabel_ : shortAmount_;
  const groups = cols.map(c => ({ label: colChartLabel_(c), tip: c.label }));
  const legend = {};
  const bars = [], markers = [];
  cols.forEach((c, ci) => {
    const base = isPct ? (Number(c.revenue) || 0) : 1;
    const toV = v => isPct ? (base ? v / base * 100 : 0) : displayAmount_(v, c);
    let up = 0, down = 0;
    structureParts_(c, lines).forEach(p => {
      legend[p.name] = legend[p.name] || p.color;
      const v = toV(p.value);
      let y0, y1;
      if (v >= 0) { y0 = up; y1 = up + v; up = y1; } else { y0 = down; y1 = down + v; down = y1; }
      bars.push({
        g: ci, s: 0, y0, y1, color: p.color, label: fmtV(v),
        tip: `${c.label}\n${p.name}\n${fmt(displayAmount_(p.value, c))} ${unitLabel_()}（${basisLabel_()}）\n對收入 ${pctText_(p.value, c.revenue)}　對廠價 ${pctText_(p.value, c.exFactoryPrice)}`
      });
    });
    if (c.amounts.A !== undefined && c.amounts.A !== null) {
      markers.push({ g: ci, y: toV(c.amounts.A), tip: `${c.label}\n收入(未稅,含強配) ${fmt(displayAmount_(c.amounts.A, c))} ${unitLabel_()}${isPct ? '（= 100%）' : ''}\n虛線以上的成本費用 = 超過收入的部分` });
    }
  });
  const legendItems = Object.keys(legend).map(name => ({ name, color: legend[name] })).concat([{ name: '收入（虛線）', color: '#1a202c' }]);
  return chartLegendHtml_(legendItems) +
    svgBarChart_({ groups, series: [{ name: '結構' }], bars, markers, stacked: true, showLabels: chartLabels, valueFormat: fmtV, height: 380 });
}

/**
 * 損益瀑布圖：每個比較欄位一張小圖，從收入一路扣到營業淨利(收入 → −銷貨成本 → 生產毛利 → −銷售費用 → 銷貨毛利 ...)。
 * 深色 = 小計/毛利/淨利，紅色 = 扣掉的成本費用。幾個欄位並排就能比較「同一段」在不同車系/情境差多少。
 */
const CHART_TYPE_INFO_ = {
  byLine: { label: '科目比較', hint: '橫軸是勾選的科目，同一組裡並排的是各比較欄位，直接看同一個科目誰高誰低。' },
  byColumn: { label: '依欄位', hint: '橫軸是比較欄位，同一組裡並排的是勾選的科目。' },
  structure: { label: '損益結構', hint: '每個欄位一根堆疊長條：收入被銷貨成本、各段費用吃掉多少、最後剩多少營業淨利。虛線是收入。' }
};

/**
 * 圖表區塊：圖表類型切換 + 數值口徑 + 科目勾選(科目比較用) + 圖本身。
 * 科目勾選框跟圖放在同一區塊：勾了馬上在旁邊看到圖重畫，不必上下捲動對照。
 */
function chartSectionHtml(cols, lines) {
  const seg = (name, value, text, tip) =>
    `<button type="button" class="seg-btn${(name === 'chartType' ? chartType : chartValue) === value ? ' active' : ''}"
       onclick="setDashOption('${name}', '${value}')"${tip ? ` data-tip="${esc(tip)}"` : ''}>${text}</button>`;
  const info = CHART_TYPE_INFO_[chartType] || CHART_TYPE_INFO_.byLine;
  return `
    <div class="chart-card">
      <div class="chart-toolbar">
        <div class="seg">${Object.keys(CHART_TYPE_INFO_).map(k => seg('chartType', k, CHART_TYPE_INFO_[k].label, CHART_TYPE_INFO_[k].hint)).join('')}</div>
        <div class="seg">${seg('chartValue', 'amount', '金額')}${seg('chartValue', 'pct', '%', '對表格目前的 % 基準；損益結構以收入為 100%')}</div>
        <label class="chk"><input type="checkbox"${chartLabels ? ' checked' : ''} onchange="setDashOption('chartLabels', this.checked)">數值標籤</label>
        <span class="chart-hint">${esc(info.hint)}　<b>${esc(chartValueUnitText_())}</b></span>
      </div>
      <div class="charts-row">
        ${chartLinePickerHtml_(lines)}
        <div class="chart-area" id="chart-area">${chartAreaHtml_(cols, lines)}</div>
      </div>
    </div>`;
}
function chartLinePickerHtml_(lines) {
  if (chartType !== 'byLine' && chartType !== 'byColumn') return '';
  const chartable = lines.filter(l => !l.isPriceStructure);
  return `
    <div class="chart-picker-box">
      <div class="toolbar-block-title">要畫的科目
        <button type="button" class="link-btn" onclick="setChartLines(${esc(JSON.stringify(['A', 'C', 'E', 'G', 'I', 'K'].concat(lines.filter(l => l.isProfit).map(l => l.LineCode))))})">只留小計</button>
        <button type="button" class="link-btn" onclick="setChartLines([])">清除</button></div>
      <div class="legend-list" id="chart-lines">
        ${chartable.map(l => {
          const on = chartLineCodes.indexOf(l.LineCode) !== -1;
          return `<label class="legend-item${on ? ' on' : ''}${l.isSubtotal || l.LineCode === 'A' ? ' subtotal' : ''}${l.ParentLine ? ' detail' : ''}">
            <input type="checkbox" value="${esc(l.LineCode)}"${on ? ' checked' : ''}
              onchange="onChartLineToggle(this.value, this.checked, this)">
            <span class="legend-name">${esc(shortLineName(l.LineName))}</span>
          </label>`;
        }).join('')}
      </div>
    </div>`;
}
function chartAreaHtml_(cols, lines) {
  if (chartType === 'structure') return structureChartHtml_(cols, lines);
  return lineComparisonChartHtml_(cols, lines);
}
/** 勾選科目後只重畫圖本身，不動勾選清單（清單的捲動位置才不會跳掉） */
function rerenderChartArea_() {
  if (!lastComparison) return;
  const area = document.getElementById('chart-area');
  if (!area) return;
  hideTooltip_();
  area.innerHTML = chartAreaHtml_(lastComparison.columns || [], lastComparison.lines || []);
}
function onChartLineToggle(code, checked, el) {
  const at = chartLineCodes.indexOf(code);
  if (checked && at === -1) chartLineCodes.push(code);
  if (!checked && at !== -1) chartLineCodes.splice(at, 1);
  if (el && el.closest) el.closest('.legend-item').classList.toggle('on', checked);
  saveDashPrefs_();
  rerenderChartArea_();
}
function setChartLines(codes) {
  chartLineCodes = codes.slice();
  saveDashPrefs_();
  if (lastComparison) renderDashboard(lastComparison);
}

/** 勾選框標籤用短名稱：科目名稱後面那串公式(如「營業淨利(=I-J)」)在這裡只會佔空間 */
function shortLineName(name) {
  // v2 的科目名稱不再夾帶公式；只去掉舊資料殘留的「(=P5-P6-P7)」「(開發總投/LC總台數)」這類寫公式的括號，
  // 「營業淨利(未扣前瞻)」「收入(未稅,含強配)」這種本來就是名稱一部分的括號要留著
  return String(name || '').replace(/\s*\((?=[^()]*[=×÷\/])[^()]*\)\s*$/, '');
}

/**
 * 銷貨成本/營業費用矩陣的項目名稱：後端下拉選單的 label 是「代碼 名稱」(如「b1 材料成本-LP」)，
 * 方便在選單裡找科目，但列在表格最左欄時不需要再看到代碼 —— 跟畫面上其他地方一樣只顯示名稱，
 * 不要一半有代碼一半沒有（也不要靠 title/hover 才看得到代碼，看不懂代碼是什麼意思）。
 */
function matrixLineName(line) {
  const label = String(line.label || '');
  const code = String(line.value || '');
  const withoutCode = code && label.indexOf(code + ' ') === 0 ? label.slice(code.length + 1) : label;
  return shortLineName(withoutCode);
}

/**
 * 小計驗算結果：後端把 B=Σb、C=A-B、E=C-Σd... 每一條等式都重算過，
 * 對得起來就只顯示一行綠字，對不起來才把差異列出來。
 */
function subtotalCheckHtml(cols) {
  return noVolumeWarnHtml_(cols) + subtotalCheckInner_(cols);
}
/** 只填構成比、沒填月台數或 LC 年限：LC 總台數 = 0，開發總投攤提「÷ 0 = 0」，單台淨利會偏高卻看不出來 */
function noVolumeWarnHtml_(cols) {
  const zero = cols.filter(c => c.volume && !(num(c.volume.units) > 0) && num(c.revenue) !== 0);
  if (!zero.length) return '';
  return `<div class="callout warn"><div>${zero.map(c => esc(c.label)).join('、')} 的 LC 總台數是 0（銷售構成還沒填月台數或 LC 年限），
    開發總投攤提會算成 0，單台淨利會偏高。到 <button type="button" class="link-btn" onclick="switchTab('salesmix')">銷售構成與售價</button> 補上月台數與 LC 年限。</div></div>`;
}
function subtotalCheckInner_(cols) {
  const bad = cols.filter(c => (c.checks || []).length);
  if (!bad.length) {
    return '<p class="status-msg ok" data-tip="每一段的明細加總都等於它的小計：&#10;收入 = 廠價 + 強配收入&#10;銷貨成本 = Σ成本明細&#10;生產毛利 = 收入 − 銷貨成本&#10;銷貨毛利 = 生產毛利 − Σ銷售費用&#10;產品貢獻 = 銷貨毛利 − Σ產品貢獻前費用&#10;營業淨利(未扣前瞻) = 產品貢獻 − Σ固定營業費用&#10;營業淨利 = 營業淨利(未扣前瞻) − 前瞻費用">✔ 小計驗算通過（滑鼠移過來看驗算了哪些等式）</p>';
  }
  return `<div class="check-box">
    <strong>小計驗算發現差異：</strong>
    <ul>${bad.map(c => c.checks.map(k =>
      `<li>${esc(c.label)} — ${esc(k.label)}：表上 ${fmt(k.actual)}，應為 ${fmt(k.expected)}（差 ${fmt(k.diff)}）</li>`
    ).join('')).join('')}</ul>
  </div>`;
}

/**
 * 科目名稱後面的公式(如「營業淨利(=I-J)」)平常不必看，改成滑鼠移到科目名稱上才顯示。
 * 公式本身是用科目代碼寫的(A/B/P8/P9...)，一般人看不懂「I-J」是什麼，
 * 所以顯示前先用 codeNameMap 把代碼換成看得懂的科目名稱(如「營業淨利(未扣前瞻) − 前瞻費用」)。
 */
function nameWithFormulaHint(name, codeNameMap, formulaText, ownerCode) {
  const parts = splitFormula(name);
  const formula = formulaText ? '= ' + humanizeFormula_(formulaText, codeNameMap, ownerCode) : humanizeFormula_(parts.formula, codeNameMap);
  return esc(parts.base) + (formula
    ? ` <span class="formula-hint" tabindex="0" data-tip="${esc(formula)}">ƒ</span>` : '');
}
function splitFormula(name) {
  const s = String(name || '');
  const m = s.match(/^(.*?)\s*(\(=.*\))\s*$/);
  return m ? { base: m[1], formula: m[2] } : { base: s, formula: '' };
}

/** 從目前這張比較表用到的科目清單建立「代碼 -> 名稱」對照，供公式提示與其他 hover 文字換成看得懂的名稱 */
function buildCodeNameMap_(lines) {
  const map = {};
  (lines || []).forEach(l => { map[l.LineCode] = shortLineName(l.LineName); });
  return map;
}
/** 把公式字串裡的科目代碼(P1~P9、單一大寫字母如 A/B/I/J)換成對照表裡的名稱；查不到就照原樣顯示 */
function humanizeFormula_(formula, codeNameMap, ownerCode) {
  if (!formula || !codeNameMap) return formula;
  const sumNames = { d: SUM_GROUP_NAMES_.E, f: SUM_GROUP_NAMES_.G, h: SUM_GROUP_NAMES_.I };
  if (/^\(=/.test(formula)) {
    // 舊版寫在名稱裡的公式，如「(=I-J)」
    return formula
      .replace(/Σ([dfh])\b/g, (m, k) => 'Σ' + sumNames[k])
      .replace(/\bP[1-9]\b|\b[A-Z]\b/g, code => codeNameMap[code] || code)
      .replace(/^\(=\s*/, '= ').replace(/\)\s*$/, '');
  }
  // v2 公式：CHILDREN()/TAXDEDUCT() 換成文字、代碼換成名稱、[名稱] 拿掉中括號、* / 換成 × ÷
  return String(formula)
    .replace(/CHILDREN\s*\(\s*\)/gi, 'Σ' + (SUM_GROUP_NAMES_[ownerCode] || '子科目'))
    .replace(/TAXDEDUCT\s*\(\s*\)/gi, 'Σ可扣除貨物稅科目')
    .replace(/"[^"]*"|\[[^\]]*\]|\b[A-Za-z_][A-Za-z0-9_]*\b(?!\s*\()/g, tok => {
      if (tok[0] === '"') return tok;
      if (tok[0] === '[') return tok.slice(1, -1);
      return codeNameMap[tok] || tok;
    })
    .replace(/\*/g, '×').replace(/\//g, '÷');
}

/** 自動計算科目(AutoSource)的圓點提示：滑鼠移過去看它是怎麼算出來的 */
const AUTO_SOURCE_HINTS = {
  FORMULA: '依「科目與公式」設定的公式計算\n滑鼠移到金額上可看這一欄實際算出來的每一步',
  PRICE: '由「銷售構成」的售價欄位與稅務費用比率推算',
  DEV_MOLD: '開發總投「模具」攤提落點 ÷ LIFE CYCLE 總台數',
  DEV_EQUIP: '開發總投「設備」攤提落點 ÷ LIFE CYCLE 總台數',
  DEV_EXPENSE_CMC: '開發總投「開發費-CMC」攤提落點 ÷ LIFE CYCLE 總台數',
  DEV_EXPENSE_BASE: '開發總投「開發費-BASE廠」攤提落點 ÷ LIFE CYCLE 總台數',
  DEV_AMORT: '開發總投攤提落點 ÷ LIFE CYCLE 總台數',
  RATE_COMMODITY_TAX: '(廠價−水平配件外移調降−廣宣/促銷/批標售/季Margin)×完稅價格計算率÷(1+貨物稅率)×貨物稅率\n滑鼠移到金額上可看這一欄實際算出來的每一步',
  RATE_QUARTER_MARGIN: '廠價(未稅) × 季Margin率'
};
function autoSourceDot(autoSource) {
  if (!autoSource) return '';
  const hint = AUTO_SOURCE_HINTS[autoSource] || '自動計算';
  const dev = /^DEV/.test(autoSource);
  return ` <span class="auto-dot${dev ? ' dev' : ''}" tabindex="0" data-tip="${dev ? '開發總投攤提' : '公式計算'}\n${esc(hint)}"></span>`;
}

function plTableHtml(cols, lines) {
  const showSecond = pctBase !== 'none';
  const span = cols.length * (showSecond ? 2 : 1) + 1;
  const priceLines = lines.filter(l => l.isPriceStructure);
  const plLines = lines.filter(l => !l.isPriceStructure);
  // 底下有明細的科目(小計群組)才給收合箭頭；任何一層祖先收合，這一列就藏起來
  const groupParents = lines.filter(p => lines.some(l => l.ParentLine === p.LineCode)).map(p => p.LineCode);
  const parentOf = {};
  lines.forEach(l => { parentOf[l.LineCode] = l.ParentLine || ''; });
  const isHiddenByCollapse = code => { let p = parentOf[code], g = 0; while (p && g++ < 20) { if (collapsedGroups.has(p)) return true; p = parentOf[p]; } return false; };
  const codeNameMap = buildCodeNameMap_(lines);
  const base = baselineCol_(cols);

  const sectionRow = text => `<tr class="section"><td colspan="${span}">${esc(text)}</td></tr>`;

  const dataRow = line => {
    // 最佳/最差：同一列裡數字最好與最差的欄位(依 lineBetter_ 的方向)；只有一欄或全部一樣就不標
    // 同分的都標(兩欄一樣好就都是 ▲)；只有一欄或全部一樣就不標
    let bestSet = [], worstSet = [];
    const better = highlightBest && cols.length > 1 ? lineBetter_(line) : null;
    if (better) {
      const vals = cols.map(c => { const v = c.amounts[line.LineCode]; return v === undefined || v === null ? null : Math.round(displayAmount_(v, c)); });
      const present = vals.filter(v => v !== null);
      if (present.length > 1) {
        const lo = Math.min.apply(null, present), hi = Math.max.apply(null, present);
        if (lo !== hi) {
          const bestV = better === 'high' ? hi : lo, worstV = better === 'high' ? lo : hi;
          vals.forEach((v, i) => { if (v === bestV) bestSet.push(i); else if (v === worstV) worstSet.push(i); });
        }
      }
    }
    const cells = cols.map((col, ci) => {
      const v = col.amounts[line.LineCode];
      const attrs = ` data-c="${ci}" data-l="${esc(line.LineCode)}" data-tipfn="cell"`;
      // 該欄位沒有這個科目就留白，不要顯示 0 誤導
      if (v === undefined || v === null) {
        return `<td class="muted"${attrs}>—</td>${showSecond ? `<td class="muted"${attrs}>—</td>` : ''}`;
      }
      const mark = bestSet.indexOf(ci) !== -1 ? ' best' : worstSet.indexOf(ci) !== -1 ? ' worst' : '';
      return amountCellHtml(v, col, attrs, mark) + (showSecond ? secondCellHtml(v, col, line, cols, attrs) : '');
    }).join('');
    const autoTag = autoSourceDot(line.AutoSource);
    const isGroupHead = groupParents.indexOf(line.LineCode) !== -1;
    const toggleBtn = isGroupHead
      ? `<button class="row-toggle${isFooterGroupLine_(line) ? ' up' : ''}" data-group="${esc(line.LineCode)}" aria-expanded="${!collapsedGroups.has(line.LineCode)}"
           onclick="toggleGroupCollapse(${jsArg(line.LineCode)})" data-tip="${collapsedGroups.has(line.LineCode) ? '展開明細' : '收合明細'}">
           <svg viewBox="0 0 10 10" fill="none"><path d="M2 3.5L5 7l3-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
         </button>` : '';
    const hidden = (line.ParentLine && isHiddenByCollapse(line.LineCode)) ? ' hidden' : '';
    const cls = [line.isSubtotal ? 'subtotal' : '', line.ParentLine ? 'detail' : ''].filter(c => c).join(' ');
    const depth = Number(line.Depth) || (line.ParentLine ? 1 : 0);
    const errCols = cols.filter(c => c.errors && c.errors[line.LineCode]);
    const errTag = errCols.length ? ` <span class="err-dot" tabindex="0" data-tip="${esc('公式錯誤（以 0 計）：' + errCols[0].errors[line.LineCode])}">⚠</span>` : '';
    const showFormula = line.Formula && !line.isSubtotal ? line.Formula : (line.isSubtotal && line.Formula ? line.Formula : '');
    return `<tr class="${cls}"${hidden}><td class="row-head" data-l="${esc(line.LineCode)}" data-tipfn="line" style="padding-left:${10 + depth * 16}px;">${toggleBtn}${nameWithFormulaHint(line.LineName, codeNameMap, showFormula, line.LineCode)}${autoTag}${errTag}</td>${cells}</tr>`;
  };

  const secondHead = pctBase === 'revenue' ? '對收入%' : pctBase === 'exfactory' ? '對廠價%'
    : pctBase === 'diff' ? 'vs 基準' : 'vs 基準%';
  return `
    <table class="pl-table">
      <thead>
        <tr>
          <th rowspan="2">項目</th>
          ${cols.map((c, ci) => {
            const isBase = base && colKey_(base) === colKey_(c);
            return `<th colspan="${showSecond ? 2 : 1}" class="col-head${isBase ? ' baseline' : ''}" data-c="${ci}" data-tipfn="col">
            <div>${esc([c.vehicleTypeLabel, c.scenarioLabel].filter(p => p).join(' / '))}</div>
            <div class="th-sub">${esc(c.vehicleLabel)}
              <button type="button" class="star${isBase ? ' on' : ''}" data-tip="${isBase ? '目前的比較基準（再點一次取消）' : '設為比較基準（表格「與基準差異」與重點指標的 vs 基準都以此欄為準）'}"
                onclick="setBaselineColumnAt(${ci})">★</button></div>
          </th>`;
          }).join('')}
        </tr>
        <tr>${cols.map((c, ci) => `<th class="th-sub" data-c="${ci}">金額</th>${showSecond ? `<th class="th-sub" data-c="${ci}">${secondHead}</th>` : ''}`).join('')}</tr>
      </thead>
      <tbody>
        ${showPriceStructure && priceLines.length
          ? sectionRow('售價結構（由「銷售構成」的售價欄位與稅務費用比率推算，不計入下方損益加總）') +
            priceLines.map(dataRow).join('')
          : ''}
        ${sectionRow('損益')}
        ${plLines.map(dataRow).join('')}
      </tbody>
    </table>`;
}

/** 大項收合：只重畫損益表本體，不必整個 dashboard 重新計算 */
function toggleGroupCollapse(code) {
  if (collapsedGroups.has(code)) collapsedGroups.delete(code);
  else collapsedGroups.add(code);
  saveDashPrefs_();
  rerenderTable_();
}
/** 全部收合/展開：目前有任何一個大項是展開的就全部收合，否則全部展開 */
function toggleAllGroups() {
  if (!lastComparison) return;
  const all = lastComparison.lines || [];
  const parents = all.filter(p => all.some(l => l.ParentLine === p.LineCode)).map(p => p.LineCode);
  const anyExpanded = parents.some(p => !collapsedGroups.has(p));
  collapsedGroups = new Set(anyExpanded ? parents : []);
  saveDashPrefs_();
  rerenderTable_();
}

function amountCellHtml(v, col, attrs, mark) {
  const n = displayAmount_(v, col);
  const cls = ['amt', n < 0 ? 'negative' : '', mark ? mark.trim() : ''].filter(c => c).join(' ');
  return `<td class="${cls}"${attrs || ''}>${fmt(n, amtDigits_())}</td>`;
}

/**
 * 每個比較欄位的第二小欄：對廠價% / 對收入% / 與基準欄位的差異(金額或 %)。
 * 差異的顏色依科目方向：成本降、利潤升是綠色(good)，反之紅色(bad)。
 */
function secondCellHtml(v, col, line, cols, attrs) {
  attrs = attrs || '';
  if (pctBase === 'diff' || pctBase === 'diffpct') {
    const base = baselineCol_(cols || []);
    if (!base) return `<td class="pct muted"${attrs}>—</td>`;
    if (colKey_(base) === colKey_(col)) return `<td class="pct base-mark"${attrs}>基準</td>`;
    const bv = base.amounts[line.LineCode];
    if (bv === undefined || bv === null) return `<td class="pct muted"${attrs}>—</td>`;
    const delta = displayAmount_(v, col) - displayAmount_(bv, base);
    const tone = deltaTone_(line, delta);
    if (pctBase === 'diff') return `<td class="pct delta ${tone}"${attrs}>${signed_(delta)}</td>`;
    const bd = displayAmount_(bv, base);
    if (!bd) return `<td class="pct muted"${attrs}>—</td>`;
    return `<td class="pct delta ${tone}"${attrs}>${signed_(delta / Math.abs(bd) * 100, 1)}%</td>`;
  }
  const base = pctBaseOf_(col);
  if (!base) return `<td class="pct muted"${attrs}>—</td>`;
  const p = Number(v) / base * 100;
  return `<td class="pct${Number(pct1_(p)) < 0 ? ' negative' : ''}"${attrs}>${pct1_(p)}%</td>`;
}
/** 舊名稱，測試與其他地方仍可能呼叫：只顯示百分比那種第二小欄 */
function pctCellHtml(v, col) { return secondCellHtml(v, col, null, [], ''); }
