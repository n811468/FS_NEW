/* ================= 瀑布圖工具 =================
 * 全系統的瀑布圖都集中在這裡(儀表板、GATE 報告、目標反推都有按鈕帶過來)：
 *   兩個情境的差異  現況 → 目標(或任兩個 車型×情境×車系)的營業淨利，差在哪些科目
 *   單一情境損益    一個欄位從收入一路扣到指定的小計，可以看到明細
 *   作法拆解        現況 → 每一項作法/原因的效果 → 目標，沒寫作法的差異單獨一根；
 *                   可以看營業淨利，也可以只看某一個科目(例：材料成本-KD F → E 惡化 50，其中座椅低減 +30、規格追加 −80)
 *   自訂            自己輸入每一根(也可以把上面任何一張圖「轉成自訂」再改名稱、合併)
 * 圖是純 SVG(跟儀表板同一套)，可以下載 PNG / SVG、複製表格貼到 Excel / PPT。
 */
const WF_PREFS_KEY_ = 'plWaterfall.prefs.v1';
let wfPrefs = {
  mode: 'bridge',
  from: { scenarioId: '', vehicleId: '' }, to: { scenarioId: '', vehicleId: '' },
  end: 'K', level: 'detail', basis: 'unit', volumeEffect: true, unit: 1,
  actionLine: '',          // 作法拆解看哪個科目：空白 = 營業淨利
  manualLowerBetter: false, // 自訂：數字變大是變差(成本/費用的瀑布轉成自訂時會帶過來)
  sort: 'pl', topN: 0, minAbs: 0, subtotals: true, labels: true, axisFrom0: false, titles: {},
  manual: [
    { label: '現況營業淨利', value: -100000, kind: 'total' },
    { label: '售價調整', value: 30000, kind: 'delta' },
    { label: '材料成本低減', value: 45000, kind: 'delta' },
    { label: '開發總投低減', value: 12000, kind: 'delta' },
    { label: '目標營業淨利', value: '', kind: 'total' }
  ]
};
let wfLists = null;      // { scenarios, vehicles }
let wfLast = null;       // 目前這張圖的 steps(轉成自訂、匯出用)

function loadWfPrefs_() {
  try {
    const p = JSON.parse(localStorage.getItem(WF_PREFS_KEY_) || 'null');
    if (p) Object.keys(wfPrefs).forEach(k => { if (p[k] !== undefined) wfPrefs[k] = p[k]; });
  } catch (e) { /* 用預設 */ }
  wfPrefs.unit = loadAmountUnit_(wfPrefs.unit);   // 金額單位全系統共用
}
/** 圖表標題每個模式各記一份(從反推帶過來的標題不會跑到差異拆解) */
function wfTitle_() { return (wfPrefs.titles && wfPrefs.titles[wfPrefs.mode]) || ''; }
function wfSetTitle_(t) { if (!wfPrefs.titles || typeof wfPrefs.titles !== 'object') wfPrefs.titles = {}; wfPrefs.titles[wfPrefs.mode] = t; }
function saveWfPrefs_() {
  saveAmountUnit_(wfPrefs.unit);
  try { localStorage.setItem(WF_PREFS_KEY_, JSON.stringify(wfPrefs)); } catch (e) { /* 存不了就算了 */ }
}

/* ---------------- 圖：瀑布 SVG ---------------- */
/**
 * steps = [{ label, value, kind: 'total' | 'delta', tip }]
 *   total = 從 0 畫到 value 的整根(起點、小計、終點)；delta = 從目前累計往上/往下的一段
 * opts = { width, height, fmtV, labels, title, lowerBetter }
 * 增加綠色、減少紅色、整根深色(負數紅底深框)；每根之間有虛線連接，看得出累計的走向。
 */
function wfSvg_(steps, opts) {
  opts = opts || {};
  const W = opts.width || 1100, H = opts.height || 420;
  const fmtV = opts.fmtV || shortAmount_;
  const showLabels = opts.labels !== false;
  const titleH = opts.title ? 26 : 0;
  if (!steps.length) {
    return `<svg class="chart-svg wf-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#a0aec0" font-size="13">沒有可以畫的資料</text></svg>`;
  }
  // 先算每一根的上下緣
  let run = 0;
  const bars = steps.map(st => {
    const v = Number(st.value) || 0;
    if (st.kind === 'total') { run = v; return { st, y0: 0, y1: v }; }
    const b = { st, y0: run, y1: run + v };
    run += v;
    return b;
  });
  const vals = [0];
  bars.forEach(b => { vals.push(b.y0, b.y1); });
  let vMin = Math.min.apply(null, vals), vMax = Math.max.apply(null, vals);
  // 縱軸要不要從 0 開始：全部都是正數、而且變動只佔整根的一小段(例：15 萬 → 15.9 萬)時，從 0 畫起來中間每一根都看不見。
  // opts.axisFrom0 === false 一律放大；未指定時自動判斷；整根(起點/小計/終點)就從圖的底部畫起，圖上註明「縱軸未從 0 開始」
  const lows = bars.map(b => b.st.kind === 'total' ? b.y1 : Math.min(b.y0, b.y1));
  const lowest = Math.min.apply(null, lows);
  const zoom = opts.axisFrom0 !== true && lowest > 0 && vMax > 0 &&
    (opts.axisFrom0 === false || (vMax - lowest) < vMax * 0.35);
  if (zoom) vMin = Math.max(0, lowest - (vMax - lowest) * 0.6);
  const span = (vMax - vMin) || Math.abs(vMax) || 1;
  if (showLabels) { vMax += span * 0.08; if (vMin < 0) vMin -= span * 0.08; }
  const axis = niceTicks_(vMin, vMax, 6);
  if (zoom && axis.lo > 0) bars.forEach(b => { if (b.st.kind === 'total') b.y0 = axis.lo; });
  const tickFont = 11;
  const leftPad = Math.max.apply(null, axis.ticks.map(t => textWidth_(fmtV(t), tickFont))) + 14;
  const n = bars.length;
  const gw0 = (W - Math.max(52, leftPad) - 12) / n;
  const labelLines = gw0 < 70 ? 4 : 3;
  const m = { l: Math.max(52, leftPad), r: 12, t: 12 + titleH, b: 16 + labelLines * 13 };
  const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
  const y = v => m.t + plotH - (v - axis.lo) / (axis.hi - axis.lo) * plotH;
  const gw = plotW / n, bw = Math.min(gw * 0.66, 64);
  const xOf = i => m.l + i * gw + (gw - bw) / 2;
  const font = 'font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Noto Sans TC\',\'Microsoft JhengHei\',sans-serif"';
  let out = `<svg class="chart-svg wf-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" ${font}>`;
  out += `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`;
  if (opts.title) out += `<text x="${W / 2}" y="20" text-anchor="middle" font-size="15" font-weight="600" fill="#1a202c">${esc(opts.title)}</text>`;
  if (zoom && axis.lo > 0) out += `<text x="${W - 12}" y="${12 + titleH}" text-anchor="end" font-size="10.5" fill="#a0aec0">縱軸未從 0 開始</text>`;
  axis.ticks.forEach(t => {
    const yy = y(t);
    out += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${t === 0 ? '#718096' : '#e2e8f0'}" stroke-width="${t === 0 ? 1.2 : 1}"/>`;
    out += `<text x="${m.l - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="${tickFont}" fill="#718096">${esc(fmtV(t))}</text>`;
  });
  bars.forEach((b, i) => {
    const top = Math.min(y(b.y0), y(b.y1)), bottom = Math.max(y(b.y0), y(b.y1));
    const h = Math.max(bottom - top, 1.5);
    const x = xOf(i);
    const v = b.y1 - b.y0;
    const isTotal = b.st.kind === 'total';
    // 成本/費用科目的瀑布(opts.lowerBetter)：數字變大是變差，紅綠反過來
    const good = opts.lowerBetter ? v <= 0 : v >= 0;
    const color = isTotal ? (b.y1 < 0 ? '#c53030' : '#2d3748') : (good ? '#38a169' : '#e53e3e');
    out += `<rect class="bar wf-bar" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" data-tip="${esc(b.st.tip || (b.st.label + '\n' + (isTotal ? '' : (v >= 0 ? '+' : '')) + fmt(isTotal ? b.y1 : v)))}"/>`;
    // 連接線：這一根的終點 → 下一根的起點
    if (i < n - 1) {
      const yy = y(b.y1);
      out += `<line x1="${(x + bw).toFixed(1)}" x2="${(xOf(i + 1)).toFixed(1)}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="#a0aec0" stroke-width="1" stroke-dasharray="3 3"/>`;
    }
    if (showLabels) {
      const text = isTotal ? fmtV(b.y1) : (v >= 0 ? '+' : '−') + fmtV(Math.abs(v));
      if (textWidth_(text, 10.5) <= gw - 2) {
        const up = isTotal ? b.y1 >= 0 : v >= 0;
        const ly = up ? top - 4 : bottom + 12;
        out += `<text class="bar-label" x="${(x + bw / 2).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="${isTotal ? 600 : 400}" fill="#2d3748">${esc(text)}</text>`;
      }
    }
    const lines = wrapLabel_(String(b.st.label || '').replace(/\//g, '／'), gw - 4, 11, labelLines);
    const cx = m.l + i * gw + gw / 2;
    out += `<text class="x-label" x="${cx.toFixed(1)}" y="${(m.t + plotH + 15).toFixed(1)}" text-anchor="middle" font-size="11" fill="#4a5568" font-weight="${isTotal ? 600 : 400}" data-tip="${esc(b.st.label || '')}">`;
    lines.forEach((ln, k) => { out += `<tspan x="${cx.toFixed(1)}" dy="${k === 0 ? 0 : 13}">${esc(ln)}</tspan>`; });
    out += '</text>';
  });
  out += '</svg>';
  return out;
}

/** 自訂模式的列 → steps：小計列沒填數字 = 前面的累計 */
function wfManualSteps_(rows) {
  let run = 0;
  return (rows || []).filter(r => String(r.label || '').trim() || String(r.value) !== '').map(r => {
    const blank = r.value === '' || r.value === null || r.value === undefined || isNaN(Number(r.value));
    if (r.kind === 'total') {
      const v = blank ? run : Number(r.value);
      run = v;
      return { label: r.label, value: v, kind: 'total' };
    }
    const v = blank ? 0 : Number(r.value);
    run += v;
    return { label: r.label, value: v, kind: 'delta' };
  });
}

/* ---------------- 從損益結果組出 steps ---------------- */
/**
 * 看損益表的結構(不寫死科目代碼，自訂科目也適用)：
 *   最上層的科目依呈現順序走；公式引用其他上層科目的是「結果列」(生產毛利 = 收入 − 銷貨成本、營業淨利 = …)，
 *   其他是「增減項」(收入、銷貨成本、前瞻費用…)；結果列底下若有明細(銷貨毛利 = 生產毛利 − Σ明細)，那些明細也是增減項。
 *   對結果的方向：收入 +，其餘成本費用 −；「X + CHILDREN()」型的明細為 +。
 */
function wfStructure_(lines) {
  const pl = lines.filter(l => !l.isPriceStructure);
  const codes = new Set(pl.map(l => l.LineCode));
  const roots = pl.filter(l => !l.ParentLine || !codes.has(l.ParentLine));
  const rootCodes = new Set(roots.map(r => r.LineCode));
  const kids = code => pl.filter(l => l.ParentLine === code);
  const leaves = l => { const k = kids(l.LineCode); return k.length ? [].concat.apply([], k.map(leaves)) : [l]; };
  const isResult = l => (String(l.Formula || '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).some(t => t !== l.LineCode && rootCodes.has(t));
  return { pl, roots, kids, leaves, isResult };
}
/** 可以選的「畫到哪一列」：結果列(生產毛利、銷貨毛利…營業淨利) */
function wfEndOptions_(lines) {
  const S = wfStructure_(lines);
  return S.roots.filter(S.isResult);
}
/**
 * 依設定把損益科目分成一根一根的項目，到 endCode 為止。
 * 回傳 [{ key, label, sign, codes, isResult }]，isResult 的項目是中間小計(只在單一情境模式畫)。
 */
function wfItems_(lines, endCode, level) {
  const S = wfStructure_(lines);
  const items = [];
  for (const r of S.roots) {
    const result = S.isResult(r);
    const children = S.kids(r.LineCode);
    if (result) {
      if (children.length) {
        const sign = /-\s*CHILDREN\s*\(/i.test(r.Formula || '') ? -1 : 1;
        if (level === 'detail') [].concat.apply([], children.map(S.leaves)).forEach(l => items.push({ key: l.LineCode, label: shortLineName(l.LineName), sign, codes: [l.LineCode] }));
        else items.push({ key: 'Σ' + r.LineCode, label: SUM_GROUP_NAMES_[r.LineCode] || (shortLineName(r.LineName) + ' 扣除項'), sign, codes: children.map(c => c.LineCode) });
      }
      items.push({ key: r.LineCode, label: shortLineName(r.LineName), isResult: true, codes: [r.LineCode] });
      if (r.LineCode === endCode) break;
      continue;
    }
    const sign = r.LineCode === 'A' || r.Category === '收入' ? 1 : -1;
    if (level === 'detail' && children.length) S.leaves(r).forEach(l => items.push({ key: l.LineCode, label: shortLineName(l.LineName), sign, codes: [l.LineCode] }));
    else items.push({ key: r.LineCode, label: shortLineName(r.LineName), sign, codes: [r.LineCode] });
  }
  return items;
}
function wfFactor_(col, basis) {
  const v = (col && col.volume) || {};
  if (basis === 'year') return (Number(v.monthlyVolume) || 0) * 12;
  if (basis === 'lc') return Number(v.units) || 0;
  return 1;
}
/** 欄位名稱：同車型比較時省略車型，加權平均不寫 */
function wfColName_(c, other) {
  const type = other && other.vehicleTypeLabel === c.vehicleTypeLabel ? '' : c.vehicleTypeLabel;
  return [type, c.scenarioLabel, c.isWeighted ? '' : c.vehicleLabel].filter(x => x).join(' ');
}
function wfBasisLabel_(basis) { return basis === 'year' ? '年度總額' : basis === 'lc' ? 'LC 總額' : '單台'; }
function wfValueOf_(col, codes) { return codes.reduce((s, c) => s + (Number(col.amounts[c]) || 0), 0); }

/** 排序、只留前 N 項、太小的併成「其他」 */
function wfTrim_(deltas) {
  let list = deltas.slice();
  if (wfPrefs.sort === 'abs') list.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const minAbs = Math.abs(num(wfPrefs.minAbs)) * (num(wfPrefs.unit) || 1);
  const topN = Math.max(0, Math.floor(num(wfPrefs.topN)));
  let keep = list.filter(d => d.pinned || Math.abs(d.value) >= Math.max(minAbs, 0.5));
  let rest = list.filter(d => keep.indexOf(d) === -1);
  if (topN && keep.filter(d => !d.pinned).length > topN) {
    const ranked = keep.filter(d => !d.pinned).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const drop = ranked.slice(topN);
    keep = keep.filter(d => drop.indexOf(d) === -1);
    rest = rest.concat(drop);
  }
  const restSum = rest.reduce((s, d) => s + d.value, 0);
  if (rest.length && Math.abs(restSum) >= 0.5) keep.push({ label: `其他（${rest.length} 項）`, value: restSum, kind: 'delta', tip: '其他：\n' + rest.map(d => `${d.label} ${fmt(d.value)}`).join('\n') });
  return keep;
}

function wfBridgeSteps_(cmp) {
  const [cf, ct] = cmp.columns;
  const lines = cmp.lines;
  const chosen = wfEndOptions_(lines).some(l => l.LineCode === wfPrefs.end) ? wfPrefs.end : '';
  // 畫到營業淨利時，兩欄各看自己車型的淨利科目(不同車型可能一個還是 K、一個已經換成別的科目)
  const pf = profitCodeOf_(cf), pt = profitCodeOf_(ct);
  const toProfit = !chosen || chosen === pf || chosen === pt;
  const endFrom = toProfit ? pf : chosen, endTo = toProfit ? pt : chosen;
  const rootOrder = wfStructure_(lines).roots.map(r => r.LineCode);
  const end = rootOrder.indexOf(endTo) >= rootOrder.indexOf(endFrom) ? endTo : endFrom;   // 扣除項列到比較後面的那一個
  const lineOf = code => lines.find(l => l.LineCode === code) || { LineName: code };
  const endLine = lineOf(end);
  const items = wfItems_(lines, end, wfPrefs.level).filter(it => !it.isResult);
  const ff = wfFactor_(cf, wfPrefs.basis), ft = wfFactor_(ct, wfPrefs.basis);
  const splitVolume = wfPrefs.basis !== 'unit' && wfPrefs.volumeEffect;
  const mFrom = (Number(cf.amounts[endFrom]) || 0), mTo = (Number(ct.amounts[endTo]) || 0);
  const start = mFrom * ff, finish = mTo * ft;
  const deltas = [];
  if (splitVolume && Math.abs(ft - ff) > 1e-9) {
    deltas.push({ label: '銷量影響', value: mFrom * (ft - ff), kind: 'delta', pinned: true,
      tip: `銷量影響\n${shortLineName(endLine.LineName)}(單台) ${fmt(mFrom)} × 台數差 ${fmt(ft - ff)}` });
  }
  items.forEach(it => {
    const a = wfValueOf_(cf, it.codes), b = wfValueOf_(ct, it.codes);
    const v = splitVolume ? it.sign * (b - a) * ft : it.sign * (b * ft - a * ff);
    deltas.push({ label: it.label, value: v, kind: 'delta',
      tip: `${it.label}\n${wfColName_(cf, ct)}：${fmt(a)}\n${wfColName_(ct, cf)}：${fmt(b)}（單台）\n對${shortLineName(endLine.LineName)}的影響 ${v >= 0 ? '+' : ''}${fmt(v)}` });
  });
  const residual = (finish - start) - deltas.reduce((s, d) => s + d.value, 0);
  if (Math.abs(residual) >= 0.5) deltas.push({ label: '其他（公式交互/尾差）', value: residual, kind: 'delta', pinned: true, tip: '不能直接歸到單一科目的差異（例如自訂公式的交互作用、四捨五入）' });
  return [{ label: `${wfColName_(cf, ct)} ${shortLineName(lineOf(endFrom).LineName)}`, value: start, kind: 'total' }]
    .concat(wfTrim_(deltas))
    .concat([{ label: `${wfColName_(ct, cf)} ${shortLineName(lineOf(endTo).LineName)}`, value: finish, kind: 'total' }]);
}

function wfStructureSteps_(cmp) {
  const col = cmp.columns[0];
  const lines = cmp.lines;
  const end = wfEndOptions_(lines).some(l => l.LineCode === wfPrefs.end) ? wfPrefs.end : profitCodeOf_(cmp.columns[0]);
  const f = wfFactor_(col, wfPrefs.basis);
  const items = wfItems_(lines, end, wfPrefs.level);
  const steps = [];
  let pending = [];
  const flush = () => { if (pending.length) { wfTrim_(pending).forEach(s => steps.push(s)); pending = []; } };
  items.forEach((it, idx) => {
    if (it.isResult) {
      flush();
      if (wfPrefs.subtotals || it.key === end) steps.push({ label: it.label, value: wfValueOf_(col, it.codes) * f, kind: 'total' });
      return;
    }
    const v = it.sign * wfValueOf_(col, it.codes) * f;
    // 第一根是收入(而且收入只有一根)：畫成從 0 起的整根
    if (idx === 0 && it.sign > 0 && !(items[1] && !items[1].isResult && items[1].sign > 0)) {
      steps.push({ label: it.label, value: v, kind: 'total' });
      return;
    }
    pending.push({ label: it.label, value: v, kind: 'delta', tip: `${it.label}\n${fmt(v)}` });
  });
  flush();
  return steps;
}

/**
 * 某個科目的變動對營業淨利是加還是減：收入、小計/毛利/淨利 +1；成本、費用 −1。
 * 群組底下的明細跟著群組(「X − CHILDREN()」型小計底下的明細是 −1)。
 */
function wfLineSign_(lines, code) {
  const by = {};
  lines.forEach(l => { by[l.LineCode] = l; });
  const l = by[code];
  if (!l) return 1;
  const S = wfStructure_(lines);
  let root = l, guard = 0;
  while (root.ParentLine && by[root.ParentLine] && root.ParentLine !== root.LineCode && guard++ < 20) root = by[root.ParentLine];
  const income = r => r.LineCode === 'A' || r.Category === '收入';
  if (root === l) return S.isResult(l) || income(l) ? 1 : -1;
  if (S.isResult(root)) return /-\s*CHILDREN\s*\(/i.test(root.Formula || '') ? -1 : 1;
  return income(root) ? 1 : -1;
}
/** 作法拆解可以看的科目：營業淨利(空白) + 售價結構以外的科目，依損益表順序 */
function wfActionLineOptions_(lines) {
  return lines.filter(l => !l.isPriceStructure);
}
function wfFillActionLineOptions_(lines) {
  const sel = document.getElementById('wf-act-line');
  if (!sel) return;
  const opts = wfActionLineOptions_(lines);
  if (wfPrefs.actionLine && !opts.some(o => o.LineCode === wfPrefs.actionLine)) wfPrefs.actionLine = '';
  sel.innerHTML = `<option value="">營業淨利（全部作法）</option>` + opts.map(o =>
    `<option value="${esc(o.LineCode)}"${o.LineCode === wfPrefs.actionLine ? ' selected' : ''}>${esc((o.ParentLine ? '　' : '') + shortLineName(o.LineName))}</option>`).join('');
}
/**
 * 作法拆解。actionLine 空白：營業淨利 現況 → 每一項作法 → 目標。
 * 指定科目：只看那個科目(含底下的明細)自己的數字 F → E，每一根是掛在這個科目的作法/原因，
 * 作法的效果是「對營業淨利」的(正數 = 改善)，成本/費用科目換算成科目本身的變動(效果 +30 = 成本少 30)。
 * 回傳 { steps, lowerBetter, lineName }
 */
function wfActionSteps_(cmp, actions, actionLine) {
  const [cf, ct] = cmp.columns;
  const nameOf = code => { const l = cmp.lines.find(x => x.LineCode === code); return l ? shortLineName(l.LineName) : ''; };
  const line = actionLine ? cmp.lines.find(l => l.LineCode === actionLine) : null;
  let codes = null, sign = 1, mFrom, mTo, label;
  if (line) {
    codes = new Set([line.LineCode]);
    let grew = true;
    while (grew) { grew = false; cmp.lines.forEach(l => { if (l.ParentLine && codes.has(l.ParentLine) && !codes.has(l.LineCode)) { codes.add(l.LineCode); grew = true; } }); }
    sign = wfLineSign_(cmp.lines, line.LineCode);
    mFrom = Number(cf.amounts[line.LineCode]) || 0; mTo = Number(ct.amounts[line.LineCode]) || 0;
    label = shortLineName(line.LineName);
  } else {
    mFrom = Number(cf.amounts[profitCodeOf_(cf)]) || 0; mTo = Number(ct.amounts[profitCodeOf_(ct)]) || 0;
    label = '營業淨利';
  }
  const deltas = actions.filter(a => String(a.Title || '').trim() && num(a.Effect) && (!codes || codes.has(a.LineCode))).map(a => {
    const v = num(a.Effect) * sign;   // 對科目本身的變動
    return { label: a.Title, value: v, kind: 'delta',
      tip: `${a.Title}\n${[nameOf(a.LineCode), a.Owner, a.Status].filter(x => x).join('｜')}\n效果 ${fmt(num(a.Effect))} 元/台（對營業淨利${num(a.Effect) >= 0 ? '改善' : '惡化'}）${line ? `\n${label} ${v >= 0 ? '+' : ''}${fmt(v)}` : ''}` };
  });
  const residual = (mTo - mFrom) - deltas.reduce((s, d) => s + d.value, 0);
  if (Math.abs(residual) >= 0.5) deltas.push({ label: line ? '其他（沒有對應的作法/原因）' : '其他差異（沒有對應作法）', value: residual, kind: 'delta', pinned: true,
    tip: line ? `${label}的變動中，沒有寫成作法/原因的部分` : '目標與現況的營業淨利差異中，沒有寫成作法的部分' });
  return {
    lowerBetter: sign < 0, lineName: label,
    steps: [{ label: `${wfColName_(cf, ct)} ${label}`, value: mFrom, kind: 'total' }]
      .concat(wfTrim_(deltas))
      .concat([{ label: `${wfColName_(ct, cf)} ${label}`, value: mTo, kind: 'total' }])
  };
}

/* ---------------- 原因拆解：原因直接在瀑布圖工具填 ----------------
 * 原因存在終點情境的作法清單(跟 GATE 報告「目標成本作法」同一份)，效果 = 對營業淨利的影響(正 = 優化、負 = 惡化)。
 * 這裡用「優化 / 惡化 + 金額」填，不必想正負號；看成本科目時，優化 30 = 成本少 30。 */
let wfActions = [];      // 終點情境的全部作法/原因(編輯中)
let wfActCmp = null;     // 起點、終點兩欄的計算結果
function wfActRecalc_(redrawEditor) {
  if (!wfActCmp) return;
  const cmp = wfActCmp;
  const colName = c => wfColName_(c, cmp.columns.find(x => x !== c));
  const r = wfActionSteps_(cmp, wfActions, wfPrefs.actionLine);
  wfLast = { steps: r.steps, lowerBetter: r.lowerBetter, title: `${r.lineName}：${colName(cmp.columns[0])} → ${colName(cmp.columns[1])}（原因拆解，元/台）` };
  wfRedraw_();
  if (redrawEditor) wfActEditorDraw_();
}
/** 這個科目(含底下明細)的代碼集合；營業淨利 = null(全部) */
function wfActCodes_() {
  if (!wfPrefs.actionLine || !wfActCmp) return null;
  const codes = new Set([wfPrefs.actionLine]);
  let grew = true;
  while (grew) { grew = false; wfActCmp.lines.forEach(l => { if (l.ParentLine && codes.has(l.ParentLine) && !codes.has(l.LineCode)) { codes.add(l.LineCode); grew = true; } }); }
  return codes;
}
function wfActEditorDraw_() {
  const box = document.getElementById('wf-act-editor');
  if (!box || !wfActCmp) return;
  if (String(wfPrefs.to.scenarioId).indexOf('snap:') === 0) { box.innerHTML = '<p class="muted">終點是情境快照，不能填原因；請選一般情境。</p>'; return; }
  const codes = wfActCodes_();
  const lineOpts = wfActCmp.lines.filter(l => !l.isPriceStructure);
  const rows = wfActions.map((a, i) => ({ a, i })).filter(x => !codes || codes.has(x.a.LineCode));
  const lineName = wfPrefs.actionLine ? shortLineName((wfActCmp.lines.find(l => l.LineCode === wfPrefs.actionLine) || {}).LineName || '') : '營業淨利';
  box.innerHTML = `<div class="wf-act-box">
    <div class="toolbar-block-title">${esc(lineName)}的原因（存在終點情境，GATE 報告「目標成本作法」也看得到）</div>
    <table class="grid-table lever-table wf-act-table"><thead><tr><th>原因 / 作法</th><th>科目</th><th>優化 / 惡化</th><th>金額（元/台）</th><th></th></tr></thead>
    <tbody>${rows.length ? rows.map(({ a, i }) => {
      const eff = num(a.Effect), good = a.Effect === '' || a.Effect === undefined ? true : eff >= 0;
      return `<tr>
        <td><input type="text" value="${esc(a.Title)}" placeholder="例：座椅低減、規格追加" oninput="wfActions[${i}].Title=this.value;wfActDirty_()"></td>
        <td><select onchange="wfActions[${i}].LineCode=this.value;wfActDirty_(true)"><option value="">（不指定）</option>${lineOpts.map(l =>
          `<option value="${esc(l.LineCode)}"${a.LineCode === l.LineCode ? ' selected' : ''}>${esc(shortLineName(l.LineName))}</option>`).join('')}</select></td>
        <td><select onchange="wfActSetSign_(${i}, this.value === 'good')"><option value="good"${good ? ' selected' : ''}>優化</option><option value="bad"${good ? '' : ' selected'}>惡化</option></select></td>
        <td><input type="number" min="0" step="any" value="${a.Effect === '' || a.Effect === undefined ? '' : esc(Math.abs(eff))}" oninput="wfActSetAmount_(${i}, this.value, this)"></td>
        <td><button type="button" class="btn ghost icon sm" onclick="wfActions.splice(${i},1);wfActDirty_(true)" aria-label="刪除">✕</button></td></tr>`;
    }).join('') : '<tr><td colspan="5" class="muted" style="text-align:center;padding:12px;">還沒有原因，按「＋ 新增原因」</td></tr>'}</tbody></table>
    <div class="field-row" style="margin-top:8px;">
      <button type="button" class="btn secondary sm" onclick="wfActAdd_()">＋ 新增原因</button>
      <span class="help">優化 = 對營業淨利有利（成本少、收入多），惡化相反。</span>
      <span class="spacer"></span>
      <button type="button" class="btn sm" onclick="wfActSave_()">儲存原因</button>
    </div></div>`;
}
function wfActDirty_(redrawEditor) {
  markDirty('waterfall', wfActSave_, () => { clearDirty(); runWaterfall_(); });
  wfActRecalc_(!!redrawEditor);
}
function wfActSetSign_(i, good) {
  const a = wfActions[i];
  if (a.Effect !== '' && a.Effect !== undefined) a.Effect = (good ? 1 : -1) * Math.abs(num(a.Effect));
  a.__bad = !good;
  wfActDirty_();
}
function wfActSetAmount_(i, value, el) {
  const a = wfActions[i];
  const sel = el && el.closest('tr') && el.closest('tr').querySelector('td:nth-child(3) select');
  const good = sel ? sel.value === 'good' : !a.__bad;
  a.Effect = value === '' ? '' : (good ? 1 : -1) * Math.abs(num(value));
  wfActDirty_();
}
function wfActAdd_() {
  wfActions.push({ ActionID: '', Title: '', LineCode: wfPrefs.actionLine || '', Effect: '', Owner: '', Status: '', DueDate: '' });
  wfActDirty_(true);
  const inputs = document.querySelectorAll('#wf-act-editor tbody tr:last-child input[type=text]');
  if (inputs[0]) inputs[0].focus();
}
function wfActSave_() {
  const sid = wfPrefs.to.scenarioId;
  google.script.run
    .withSuccessHandler(safeHandler(list => {
      clearDirty();
      wfActions = list.map(a => Object.assign({}, a));
      Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
      toast('已儲存原因', 'ok');
      wfActRecalc_(true);
    }))
    .withFailureHandler(err => toast(err.message, 'err'))
    .saveActions(sid, wfActions.map(a => { const c = Object.assign({}, a); delete c.__bad; return c; }));
}
/** 換科目/情境前，原因還沒存就先問 */
function wfConfirmLeaveActions_(go, sel) {
  if (!isDirty_()) { go(); return; }
  confirmLeave_().then(ok => { if (ok) go(); else if (sel) sel.value = wfPrefs.actionLine; });
}

/* ---------------- 頁面 ---------------- */
function renderWaterfallPanel() {
  const panel = document.getElementById('panel-waterfall');
  if (!panel) return;
  loadWfPrefs_();
  panel.innerHTML = `<p class="page-intro">把任兩個欄位的差異、單一欄位的損益、改善作法，或自己輸入的數字畫成瀑布圖；可以下載 PNG / SVG 或複製表格貼到簡報。</p>
    <div id="wf-body"><p class="muted">載入中...</p></div>`;
  google.script.run
    .withSuccessHandler(safeHandler(res => {
      if (!(res.scenarios || []).length) {
        panel.innerHTML = emptyStateHtml('📉', '還沒有情境', '瀑布圖要比較情境的損益。先到「車型與情境」建立情境並填好數字。',
          `<button class="btn" onclick="switchTab('masters')">前往車型與情境</button>`);
        return;
      }
      wfLists = res;
      wfDefaultsFromContext_();
      drawWaterfallTool_();
    }))
    .withFailureHandler(err => { document.getElementById('wf-body').innerHTML = `<div class="callout err">${esc(err.message)}</div>`; })
    .getWaterfallSources();
}
/** 沒選過起點/終點：終點 = 目前情境，起點 = 同車型的「現況」情境(沒有就第一個) */
function wfDefaultsFromContext_() {
  const ids = wfLists.scenarios.map(s => s.ScenarioID);
  if (ids.indexOf(wfPrefs.to.scenarioId) !== -1 && ids.indexOf(wfPrefs.from.scenarioId) !== -1) return;
  // 起點 = 現況、終點 = 目標：目前情境是現況就當起點，否則當終點
  const cur = wfLists.scenarios.find(s => s.ScenarioID === currentScenarioId) || wfLists.scenarios[0] || {};
  const same = wfLists.scenarios.filter(s => s.VehicleTypeID === cur.VehicleTypeID && s.ScenarioID !== cur.ScenarioID);
  const other = type => same.find(s => s.ScenarioType === type) || same[0] || cur;
  const pair = cur.ScenarioType === '現況' ? [cur, other('目標')] : [other('現況'), cur];
  wfPrefs.from = { scenarioId: pair[0].ScenarioID || '', vehicleId: '' };
  wfPrefs.to = { scenarioId: pair[1].ScenarioID || '', vehicleId: '' };
}
function wfScenarioSelectHtml_(side, onlyWeighted) {
  const sel = wfPrefs[side];
  const sc = wfLists.scenarios.find(s => s.ScenarioID === sel.scenarioId) || {};
  const byType = {};
  wfLists.scenarios.forEach(s => { (byType[s.VehicleTypeID] = byType[s.VehicleTypeID] || []).push(s); });
  const vehicles = wfLists.vehicles.filter(v => v.VehicleTypeID === sc.VehicleTypeID);
  return `<select id="wf-${side}-sc" onchange="wfPrefs.${side}={scenarioId:this.value,vehicleId:''};saveWfPrefs_();drawWaterfallTool_()">
      ${Object.keys(byType).map(t => `<optgroup label="${esc(t)}">${byType[t].filter(s => !s.isSnapshot).map(s => `<option value="${esc(s.ScenarioID)}"${s.ScenarioID === sel.scenarioId ? ' selected' : ''}>${esc(t + ' ' + scenarioLabel(s))}</option>`).join('')}</optgroup>` +
        (byType[t].some(s => s.isSnapshot) ? `<optgroup label="${esc(t)} 情境快照">${byType[t].filter(s => s.isSnapshot).map(s => `<option value="${esc(s.ScenarioID)}"${s.ScenarioID === sel.scenarioId ? ' selected' : ''}>${esc(t + ' ' + scenarioLabel(s))}</option>`).join('')}</optgroup>` : '')).join('')}
    </select>
    ${onlyWeighted ? '' : `<select id="wf-${side}-v" onchange="wfPrefs.${side}.vehicleId=this.value;saveWfPrefs_();runWaterfall_()">
      <option value="">加權平均</option>
      ${vehicles.map(v => `<option value="${esc(v.VehicleID)}"${v.VehicleID === sel.vehicleId ? ' selected' : ''}>${esc(v.VehicleCode || v.VehicleID)}</option>`).join('')}
    </select>`}`;
}

function drawWaterfallTool_() {
  const body = document.getElementById('wf-body');
  if (!body || !wfLists) return;
  const p = wfPrefs;
  const modes = [['bridge', '兩個欄位的差異'], ['structure', '單一欄位損益'], ['actions', '原因拆解'], ['manual', '自訂']];
  const seg = (key, opts, cur) => `<div class="seg">${opts.map(([v, t]) => `<button type="button" class="seg-btn${String(cur) === String(v) ? ' active' : ''}" onclick="wfPrefs.${key}=${typeof v === 'number' ? v : `'${v}'`};saveWfPrefs_();drawWaterfallTool_()">${t}</button>`).join('')}</div>`;
  const chk = (key, label) => `<label class="chk"><input type="checkbox" ${p[key] ? 'checked' : ''} onchange="wfPrefs.${key}=this.checked;saveWfPrefs_();runWaterfall_()"> ${label}</label>`;
  let source = '';
  if (p.mode === 'bridge') {
    source = `<div class="field-row">
      <label class="field"><span>起點</span><div class="inline">${wfScenarioSelectHtml_('from')}</div></label>
      <label class="field"><span>終點</span><div class="inline">${wfScenarioSelectHtml_('to')}</div></label>
      <button type="button" class="btn secondary sm" style="align-self:flex-end;" onclick="wfSwap_()" data-tip="起點、終點對調">⇄</button></div>`;
  } else if (p.mode === 'structure') {
    source = `<div class="field-row"><label class="field"><span>欄位</span><div class="inline">${wfScenarioSelectHtml_('to')}</div></label></div>`;
  } else if (p.mode === 'actions') {
    source = `<div class="field-row">
      <label class="field"><span>起點情境</span><div class="inline">${wfScenarioSelectHtml_('from', true)}</div></label>
      <label class="field"><span>終點情境（原因存在這個情境）</span><div class="inline">${wfScenarioSelectHtml_('to', true)}</div></label>
      <label class="field"><span>看哪個科目</span><select id="wf-act-line" onchange="wfConfirmLeaveActions_(() => { wfPrefs.actionLine=this.value;saveWfPrefs_();runWaterfall_(); }, this)"><option value="">營業淨利（全部作法）</option></select></label></div>
      <p class="help">起點、終點是這個科目在兩個情境的數字（加權平均，元/台）；中間每一根是下面自己填的原因，原因加總跟實際變動對不起來的部分自動變成「其他」。</p>
      <div id="wf-act-editor"></div>`;
  }
  const lineOpts = p.mode === 'bridge' || p.mode === 'structure';
  // 不常改的選項收在「進階」；改過(不是預設值)就展開，才不會忘了自己設過
  const advOpen = p.sort !== 'pl' || num(p.topN) > 0 || num(p.minAbs) > 0 || !p.labels || !!p.axisFrom0 || !!String(wfTitle_()).trim();
  body.innerHTML = `
    <div class="card">
      <div class="field-row">${seg('mode', modes, p.mode)}</div>
      ${source}
      ${p.mode === 'manual' ? wfManualEditorHtml_() : ''}
      <div class="field-row wf-opts">
        ${lineOpts ? `<label class="field"><span>畫到</span><select id="wf-end" onchange="wfPrefs.end=this.value;saveWfPrefs_();runWaterfall_()"></select></label>
          <label class="field"><span>明細程度</span>${seg('level', [['major', '大項'], ['detail', '明細科目']], p.level)}</label>
          <label class="field"><span>數值</span>${seg('basis', [['unit', '單台'], ['year', '年度'], ['lc', 'LC 總額']], p.basis)}</label>` : ''}
        <label class="field" data-tip="全系統共用：儀表板、GATE 報告、瀑布圖工具用同一個金額單位"><span>金額單位</span>${seg('unit', [[1, '元'], [1000, '千元'], [10000, '萬元']], p.unit)}</label>
        ${p.mode === 'bridge' && p.basis !== 'unit' ? chk('volumeEffect', '拆出「銷量影響」') : ''}
        ${p.mode === 'structure' ? chk('subtotals', '顯示中間小計（生產毛利、銷貨毛利…）') : ''}
        ${p.mode === 'manual' ? chk('manualLowerBetter', '數字變大是變差（成本、費用的瀑布）') : ''}
      </div>
      <details class="ed-adv wf-adv"${advOpen ? ' open' : ''}>
        <summary>進階（排序、顯示幾項、數字標籤、圖表標題）</summary>
        <div class="field-row">
          ${p.mode !== 'manual' ? `<label class="field"><span>排序</span>${seg('sort', [['pl', '損益表順序'], ['abs', '影響大到小']], p.sort)}</label>
            <label class="field"><span>最多顯示幾項（0 = 全部）</span><input type="number" min="0" style="width:90px;" value="${esc(p.topN)}" onchange="wfPrefs.topN=this.value;saveWfPrefs_();runWaterfall_()"></label>
            <label class="field"><span>小於多少併入「其他」</span><input type="number" min="0" style="width:110px;" value="${esc(p.minAbs)}" onchange="wfPrefs.minAbs=this.value;saveWfPrefs_();runWaterfall_()"></label>` : ''}
          ${chk('labels', '顯示數字')}
          ${chk('axisFrom0', '縱軸一律從 0 開始（不勾 = 差異很小時自動放大）')}
          <label class="field grow"><span>圖表標題（留空 = 自動）</span><input type="text" id="wf-title" value="${esc(wfTitle_())}" placeholder="自動" oninput="wfSetTitle_(this.value);saveWfPrefs_();wfRedraw_()"></label>
        </div>
      </details>
    </div>
    <div class="card">
      <div class="card-head"><h3 id="wf-heading">瀑布圖</h3><span class="spacer"></span>
        ${p.mode !== 'manual' ? '<button type="button" class="btn secondary sm" onclick="wfToManual_()" data-tip="把這張圖的每一根複製到「自訂」，可以再改名稱、合併、調整順序">轉成自訂（可再編輯）</button>' : ''}
        <button type="button" class="btn secondary sm" onclick="wfCopyTable_()">複製表格</button>
        <button type="button" class="btn secondary sm" onclick="wfDownload_('svg')">下載 SVG</button>
        <button type="button" class="btn sm" onclick="wfDownload_('png')">下載 PNG</button></div>
      <div id="wf-chart"><p class="muted">計算中...</p></div>
      <div id="wf-table"></div>
    </div>`;
  if (p.mode === 'manual') installWfManual_();
  runWaterfall_();
}
function wfSwap_() {
  const t = wfPrefs.from; wfPrefs.from = wfPrefs.to; wfPrefs.to = t;
  saveWfPrefs_(); drawWaterfallTool_();
}

function runWaterfall_() {
  const p = wfPrefs;
  const box = document.getElementById('wf-chart');
  if (!box) return;
  if (p.mode === 'manual') { wfLast = { steps: wfManualSteps_(p.manual), title: '', lowerBetter: !!p.manualLowerBetter }; wfRedraw_(); return; }
  const sels = p.mode === 'structure' ? [p.to] : [p.from, p.to];
  if (sels.some(s => !s.scenarioId)) { box.innerHTML = '<p class="muted">請先選擇情境。</p>'; return; }
  const selections = sels.map(s => ({ ScenarioID: s.scenarioId, VehicleID: p.mode === 'actions' ? '' : (s.vehicleId || '') }));
  box.innerHTML = '<p class="muted">計算中...</p>';
  const fail = err => { box.innerHTML = `<div class="callout err">${esc(err.message)}</div>`; };
  google.script.run.withFailureHandler(fail).withSuccessHandler(safeHandler(cmp => {
    if (p.mode !== 'manual') wfFillEndOptions_(cmp.lines);
    if (p.mode === 'actions') wfFillActionLineOptions_(cmp.lines);
    const colName = c => wfColName_(c, cmp.columns.find(x => x !== c));
    if (p.mode === 'actions') {
      wfActCmp = cmp;
      if (String(p.to.scenarioId).indexOf('snap:') === 0) { wfActions = []; wfActRecalc_(true); return; }
      google.script.run.withFailureHandler(fail).withSuccessHandler(safeHandler(actions => {
        wfActions = actions.map(a => Object.assign({}, a));
        wfActRecalc_(true);
      })).getActions(p.to.scenarioId);
      return;
    }
    const endLine = cmp.lines.find(l => l.LineCode === p.end) || cmp.lines.find(l => l.LineCode === profitCodeOf_(cmp.columns[0])) || {};
    const basis = wfBasisLabel_(p.basis);
    if (p.mode === 'bridge') {
      wfLast = { steps: wfBridgeSteps_(cmp), title: `${shortLineName(endLine.LineName || '')}差異：${colName(cmp.columns[0])} → ${colName(cmp.columns[1])}（${basis}）` };
    } else {
      wfLast = { steps: wfStructureSteps_(cmp), title: `${colName(cmp.columns[0])}：收入到${shortLineName(endLine.LineName || '')}（${basis}）` };
    }
    wfRedraw_();
  })).calculateComparison(selections);
}
function wfFillEndOptions_(lines) {
  const sel = document.getElementById('wf-end');
  if (!sel) return;
  const opts = wfEndOptions_(lines);
  if (!opts.some(o => o.LineCode === wfPrefs.end)) wfPrefs.end = opts.length ? opts[opts.length - 1].LineCode : 'K';
  sel.innerHTML = opts.map(o => `<option value="${esc(o.LineCode)}"${o.LineCode === wfPrefs.end ? ' selected' : ''}>${esc(shortLineName(o.LineName))}</option>`).join('');
}
function wfUnitText_() { const u = num(wfPrefs.unit) || 1; return u === 1000 ? '千元' : u === 10000 ? '萬元' : '元'; }
/** 圖上的數字要短，而且整張圖用同一個單位(刻度與標籤一致)：元 → 萬 / 億；千元、萬元照單位 */
function wfShortFmt_(steps) {
  const u = num(wfPrefs.unit) || 1;
  let run = 0, maxAbs = 0;
  (steps || []).forEach(st => { run = st.kind === 'total' ? Number(st.value) || 0 : run + (Number(st.value) || 0); maxAbs = Math.max(maxAbs, Math.abs(run), Math.abs(Number(st.value) || 0)); });
  if (u === 1 && maxAbs >= 1e8) return v => fmt((Number(v) || 0) / 1e8, 2) + '億';
  if (u === 1 && maxAbs >= 1e5) return v => fmt((Number(v) || 0) / 1e4, 1) + '萬';
  return v => fmt((Number(v) || 0) / u, u === 1 ? 0 : 1);
}
function wfFmt_(v) { const u = num(wfPrefs.unit) || 1; return fmt(v / u, u === 1 ? 0 : 1); }

function wfRedraw_() {
  const box = document.getElementById('wf-chart');
  if (!box || !wfLast) return;
  const title = String(wfTitle_()).trim() || wfLast.title || '';
  const heading = document.getElementById('wf-heading');
  if (heading) heading.textContent = title || '瀑布圖';
  const u = num(wfPrefs.unit) || 1;
  box.innerHTML = wfSvg_(wfLast.steps, { title, labels: wfPrefs.labels, axisFrom0: wfPrefs.axisFrom0 ? true : undefined, fmtV: wfShortFmt_(wfLast.steps), lowerBetter: !!wfLast.lowerBetter });
  const tbl = document.getElementById('wf-table');
  if (!tbl) return;
  let run = 0;
  const start = wfLast.steps.length && wfLast.steps[0].kind === 'total' ? wfLast.steps[0].value : 0;
  const end = wfLast.steps.length ? wfLast.steps[wfLast.steps.length - 1] : null;
  const total = end && end.kind === 'total' && wfLast.steps.length > 1 ? end.value - start : null;
  tbl.innerHTML = `<div class="grid-scroll"><table class="grid-table wf-table"><thead><tr><th>項目</th><th>數值（${wfUnitText_()}）</th><th>累計</th>${total ? '<th>占總差異</th>' : ''}</tr></thead>
    <tbody>${wfLast.steps.map(s => {
      if (s.kind === 'total') run = s.value; else run += s.value;
      return `<tr class="${s.kind === 'total' ? 'subtotal' : ''}"><td>${esc(s.label)}</td>
        <td class="amt${(s.kind === 'delta' && wfLast.lowerBetter ? s.value > 0 : s.value < 0) ? ' negative' : ''}">${s.kind === 'delta' && s.value > 0 ? '+' : ''}${wfFmt_(s.value)}</td>
        <td class="amt${run < 0 ? ' negative' : ''}">${wfFmt_(run)}</td>
        ${total ? `<td class="amt">${s.kind === 'delta' ? pct1_(s.value / total * 100) + '%' : ''}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>`;
}

/* ---------------- 自訂模式 ---------------- */
function wfManualEditorHtml_() {
  return `<div class="wf-manual">
    <table class="grid-table" id="wf-manual-table"><thead><tr><th style="width:28px;"></th><th>名稱</th><th style="width:150px;">數值（元）</th><th style="width:170px;">類型</th><th style="width:40px;"></th></tr></thead>
    <tbody id="wf-manual-body">${wfPrefs.manual.map((r, i) => `<tr data-key="${i}">
      <td>${dragHandleHtml('拖曳調整順序')}</td>
      <td><input type="text" value="${esc(r.label)}" oninput="wfPrefs.manual[${i}].label=this.value;wfManualChanged_()"></td>
      <td><input type="number" step="any" value="${esc(r.value)}" placeholder="${r.kind === 'total' ? '留空 = 累計' : ''}" oninput="wfPrefs.manual[${i}].value=this.value;wfManualChanged_()"></td>
      <td><select onchange="wfPrefs.manual[${i}].kind=this.value;wfManualChanged_(true)">
        <option value="delta"${r.kind !== 'total' ? ' selected' : ''}>增減（正 = 增加）</option>
        <option value="total"${r.kind === 'total' ? ' selected' : ''}>整根（起點/小計/終點）</option></select></td>
      <td><button type="button" class="btn ghost icon sm" onclick="wfPrefs.manual.splice(${i},1);wfManualChanged_(true)" aria-label="刪除">✕</button></td>
    </tr>`).join('')}</tbody></table>
    <div class="field-row">
      <button type="button" class="btn secondary sm" onclick="wfPrefs.manual.push({label:'',value:'',kind:'delta'});wfManualChanged_(true)">＋ 加一根</button>
      <button type="button" class="btn secondary sm" onclick="wfPasteDialog_()">從 Excel 貼上…</button>
      <button type="button" class="btn ghost sm" onclick="wfPrefs.manual=[];wfManualChanged_(true)">清空</button>
      <span class="help">「整根」沒填數字 = 自動帶前面的累計（用在小計、終點）。</span>
    </div></div>`;
}
function installWfManual_() {
  makeSortable(document.getElementById('wf-manual-body'), { items: 'tr', onEnd: keys => {
    wfPrefs.manual = keys.map(k => wfPrefs.manual[Number(k)]);
    wfManualChanged_(true);
  } });
}
function wfManualChanged_(redrawEditor) {
  saveWfPrefs_();
  if (redrawEditor) { drawWaterfallTool_(); return; }
  runWaterfall_();
}
/** 貼上兩欄(名稱、數值)，可以有第三欄寫「小計/合計/整根」 */
function wfPasteDialog_() {
  openModal({
    title: '從 Excel 貼上瀑布圖資料', wide: true, okText: '套用',
    body: '<p class="help">每列：名稱 ⇥ 數值（⇥ 類型，可省略）。第一列與最後一列自動當成整根；第三欄寫「小計」「合計」「整根」的也是整根。最後一列數值留空 = 自動累計。</p>',
    fields: [{ name: 'text', type: 'textarea', label: '貼上（Ctrl+V）', placeholder: '現況營業淨利\t-120000\n售價調整\t25000\n材料低減\t60000\n目標營業淨利' }]
  }).then(out => {
    if (!out) return;
    const rows = String(out.text || '').split(/\r?\n/).map(l => l.split('\t')).filter(c => c.join('').trim());
    if (!rows.length) return;
    wfPrefs.manual = rows.map((c, i) => {
      const v = parsePastedNumber_(c[1]);
      const isTotal = /小計|合計|整根|total/i.test(c[2] || '') || i === 0 || i === rows.length - 1;
      return { label: String(c[0] || '').trim(), value: v === null || v === '' ? '' : v, kind: isTotal ? 'total' : 'delta' };
    });
    wfManualChanged_(true);
  });
}
function wfToManual_() {
  if (!wfLast || !wfLast.steps.length) return;
  wfPrefs.manual = wfLast.steps.map((s, i) => ({ label: s.label, value: s.kind === 'total' && i > 0 && i === wfLast.steps.length - 1 ? '' : Math.round(s.value), kind: s.kind }));
  const t = String(wfTitle_()).trim() || wfLast.title || '';
  wfPrefs.mode = 'manual';
  wfPrefs.manualLowerBetter = !!wfLast.lowerBetter;
  wfSetTitle_(t);
  saveWfPrefs_();
  drawWaterfallTool_();
  toast('已複製到「自訂」，可以直接改名稱、數字或拖曳順序', 'ok');
}
/**
 * 從其他頁面(儀表板、情境快照、GATE 報告)直接開一張瀑布圖：mode = 'bridge' 兩欄差異 / 'structure' 單一欄位損益 / 'actions' 作法拆解；
 * from/to = { scenarioId, vehicleId }，null = 不改；extra = 其他要一起設定的選項(如 { end: 'K' })。
 * 圖表標題清回自動，避免沿用上一次手動打的標題。
 */
function openWaterfallTool_(mode, from, to, extra) {
  loadWfPrefs_();
  wfPrefs.mode = mode;
  if (extra) Object.assign(wfPrefs, extra);
  if (from) wfPrefs.from = { scenarioId: from.scenarioId || '', vehicleId: from.vehicleId || '' };
  if (to) wfPrefs.to = { scenarioId: to.scenarioId || '', vehicleId: to.vehicleId || '' };
  wfSetTitle_('');
  saveWfPrefs_();
  switchTab('waterfall');
}
/** 從其他頁面(例如多項目標反推)把一組 steps 帶到瀑布圖工具 */
function openInWaterfallTool_(steps, title) {
  loadWfPrefs_();
  wfPrefs.manual = steps.map((s, i) => ({ label: s.label, value: s.kind === 'total' && i === steps.length - 1 && i > 0 ? '' : Math.round(s.value), kind: s.kind }));
  wfPrefs.mode = 'manual';
  wfPrefs.manualLowerBetter = false;
  wfSetTitle_(title || '');
  saveWfPrefs_();
  switchTab('waterfall');
}

/* ---------------- 匯出 ---------------- */
function wfFileName_(ext) {
  const t = String(wfTitle_() || (wfLast && wfLast.title) || '瀑布圖').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  return t + '.' + ext;
}
function wfSaveBlob_(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function wfDownload_(kind) {
  const svg = document.querySelector('#wf-chart svg');
  if (!svg) return;
  const clone = svg.cloneNode(true);
  clone.removeAttribute('width');
  const vb = (svg.getAttribute('viewBox') || '0 0 1100 420').split(/\s+/).map(Number);
  clone.setAttribute('width', vb[2]); clone.setAttribute('height', vb[3]);
  const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  if (kind === 'svg') { wfSaveBlob_(new Blob([text], { type: 'image/svg+xml' }), wfFileName_('svg')); return; }
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = vb[2] * scale; canvas.height = vb[3] * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(b => { if (b) wfSaveBlob_(b, wfFileName_('png')); else toast('瀏覽器不允許輸出圖片，請改用下載 SVG', 'err'); }, 'image/png');
  };
  img.onerror = () => toast('無法轉成 PNG，請改用下載 SVG', 'err');
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
}
function wfCopyTable_() {
  if (!wfLast) return;
  let run = 0;
  const rows = [['項目', '數值(' + wfUnitText_() + ')', '累計']].concat(wfLast.steps.map(s => {
    if (s.kind === 'total') run = s.value; else run += s.value;
    const u = num(wfPrefs.unit) || 1;
    return [s.label, String(Math.round(s.value / u * 10) / 10), String(Math.round(run / u * 10) / 10)];
  }));
  const tsv = rows.map(r => r.join('\t')).join('\n');
  const done = () => toast('已複製，可以直接貼到 Excel', 'ok', 1600);
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = tsv; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('複製失敗', 'err'); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tsv).then(done, fallback);
  else fallback();
}
