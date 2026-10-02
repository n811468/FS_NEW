/* ================= 科目與公式：每個車型各自的科目表 + 公式式計算來源 =================
 *
 * v2.1 重新設計，目標是「不懂代碼也能直覺操作」：
 *   - 左邊長得像損益表：科目縮排在它的小計底下，旁邊直接顯示目前情境算出來的金額(加權平均)，
 *     群組可以收合；小計列上的「＋」直接在那一段新增科目；拖曳 ⠿ 調整順序。
 *   - 右邊一步一步：① 怎麼算(三選一) ② 公式/輸入說明 ③ 結果，進階設定收起來。
 *   - 公式一律用「科目名稱」顯示與編輯([材料成本-KD] × [關稅率])，存檔時後端自動換成代碼，
 *     所以科目改名不會讓公式斷掉。編輯介面(一行一項 / 自由公式膠囊 / 文字)在 32-formula-builder.js。
 */
let chartEditor = null;      // getChartEditor 的結果
let chartSelected = '';      // 目前選中的科目代碼('' = 沒選；'__new__' = 新增中)
let chartDraft = null;       // 編輯中的科目(公式是「名稱版」)
let chartFilter = '';
let chartPreview = null;     // previewLineFormula 的結果
let chartPreviewTimer_ = null;
let chartShowProblems = false;
let chartAc_ = null;         // 自動完成清單狀態 { items, index, start }
const CHART_PREFS_KEY_ = 'plChart.prefs.v1';
let chartCollapsed = new Set(['__price__']);
let chartShowCodes = false;

const CALC_TYPE_INFO = {
  INPUT: ['手動輸入', '每個車系在「銷貨成本」或「營業費用」頁各填一個金額', '✎'],
  FORMULA: ['公式計算', '用其他科目、參數算出來，例如 廠價 × 季Margin率', 'ƒ'],
  DEV_AMORT: ['開發總投攤提', '開發總投選這個科目當攤提落點，金額 ÷ 攤提台數', '⚙']
};
const FORMULA_FUNCTIONS_UI = [
  ['CHILDREN()', '這個科目底下所有子科目的合計（小計用）'],
  ['TAXDEDUCT()', '勾選「貨物稅完稅價格可扣除」的科目合計'],
  ['ROUND(x)', '四捨五入到整數；ROUND(x, 2) 到小數 2 位'],
  ['SUM(a, b, …)', '加總'], ['MAX(a, b)', '取大'], ['MIN(a, b)', '取小'], ['ABS(x)', '絕對值'],
  ['IF(條件, 成立, 不成立)', '例：IF([月銷量] > 100, 1, 2)'],
  ['REF("情境", "科目代碼")', '引用另一個情境（可以是別的車型）的科目金額']
];

function loadChartPrefs_() {
  try {
    const p = JSON.parse(localStorage.getItem(CHART_PREFS_KEY_) || 'null');
    if (p && Array.isArray(p.collapsed)) chartCollapsed = new Set(p.collapsed.map(String));
    if (p && typeof p.showCodes === 'boolean') chartShowCodes = p.showCodes;
  } catch (e) { /* 沒有就用預設 */ }
}
function saveChartPrefs_() {
  try { localStorage.setItem(CHART_PREFS_KEY_, JSON.stringify({ collapsed: Array.from(chartCollapsed), showCodes: chartShowCodes })); } catch (e) { /* 存不了就算了 */ }
}

function renderChartPanel() {
  const panel = document.getElementById('panel-lineitems');
  if (!requireScope('lineitems', false)) return;
  loadChartPrefs_();
  panel.innerHTML = `<div id="chart-root"><p class="muted">載入中...</p></div>`;
  loadChartEditor_();
}

function loadChartEditor_(keepSelection) {
  const cacheKey = panelCacheKey_('lineitems', 'both');
  const apply = data => {
    chartEditor = data;
    if (chartSelected && chartSelected !== '__new__') {
      const line = data.lines.find(l => l.LineCode === chartSelected);
      chartDraft = line ? draftFromLine_(line) : null;
      if (!line) chartSelected = '';
    } else if (!keepSelection && chartSelected !== '__new__') {
      chartDraft = null;
    }
    drawChartEditor_();
  };
  if (panelDataCache_[cacheKey] && !isDirty_()) apply(panelDataCache_[cacheKey]);
  google.script.run
    .withSuccessHandler(safeHandler(data => {
      panelDataCache_[cacheKey] = data;
      if (isDirty_() && chartEditor) { chartEditor.problems = data.problems; chartEditor.preview = data.preview; drawChartTreeBody_(); return; }
      apply(data);
    }))
    .withFailureHandler(showGlobalError)
    .getChartEditor(currentVehicleTypeId, currentScenarioId);
}

/* ---------------- 公式的「名稱版」：代碼 ⇄ [科目名稱] ---------------- */
function chartLineByCode_(code) { return chartEditor ? chartEditor.lines.find(l => l.LineCode === code) : null; }
function chartCodeNameMap_() {
  const map = {};
  (chartEditor ? chartEditor.lines : []).forEach(l => { map[l.LineCode] = l.LineName; });
  return map;
}
/** 系統變數與參數名稱：[名稱] 會先被解讀成這些，所以撞名的科目只能用代碼表示 */
function chartReservedNames_() {
  const set = new Set();
  ((chartEditor && chartEditor.variables) || []).forEach(v => set.add(v.name));
  ((chartEditor && chartEditor.params) || []).forEach(p => set.add(p.ParamName));
  return set;
}
/** 這個科目能不能用 [名稱] 表示：名稱裡沒有 ]、不跟變數/參數撞名、沒有其他科目同名 */
function chartNameUsable_(line) {
  if (!line || /[\[\]"]/.test(line.LineName) || /^[A-Za-z]{3}匯率$/.test(line.LineName)) return false;
  if (chartReservedNames_().has(line.LineName)) return false;
  return chartEditor.lines.filter(l => l.LineName === line.LineName).length === 1;
}
/** 存的公式(代碼) → 畫面上編輯用的名稱版 */
function toNameForm_(formula) {
  if (!formula || !chartEditor) return formula || '';
  return String(formula).replace(/"[^"]*"|'[^']*'|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*/g, (tok, offset, str) => {
    if (/^["'\[]/.test(tok)) return tok;
    if (/^\s*\(/.test(str.slice(offset + tok.length))) return tok;   // 函式名稱
    const line = chartLineByCode_(tok);
    return line && chartNameUsable_(line) ? '[' + line.LineName + ']' : tok;
  });
}
function draftFromLine_(line) {
  const d = JSON.parse(JSON.stringify(line));
  d.Formula = toNameForm_(d.Formula);
  const vf = d.VehicleFormulas || {};
  Object.keys(vf).forEach(k => { vf[k] = toNameForm_(vf[k]); });
  d.VehicleFormulas = vf;
  return d;
}

/* ---------------- 版面 ---------------- */
function drawChartEditor_() {
  const root = document.getElementById('chart-root');
  if (!root || !chartEditor) return;
  const errs = chartEditor.problems.filter(p => p.level === 'error');
  const warns = chartEditor.problems.filter(p => p.level === 'warning');
  const others = chartEditor.otherTypes || [];
  root.innerHTML = `
    <div class="chart-topbar">
      <p class="page-intro" style="margin:0;flex:1;">車型 <b>${esc(currentVehicleTypeId)}</b> 自己的科目表（改這裡不影響其他車型）。
        點左邊的科目就能改它<b>怎麼算</b>；金額是目前情境 <b>${esc(currentScenario ? scenarioLabel(currentScenario) : '—')}</b> 的加權平均。</p>
      <details class="menu">
        <summary class="btn ghost">⋯ 整份科目表</summary>
        <div class="menu-list">
          <button type="button" ${others.length ? '' : 'disabled'} onclick="copyChartDialog()">從其他車型或範本複製…<span>整份換掉</span></button>
          <button type="button" onclick="saveChartAsTemplateUi()">存成標準範本<span>之後新建車型的預設</span></button>
          <button type="button" onclick="restoreChartDefaults()">恢復預設科目<span>預設科目回到系統預設（刪掉的會補回來），自訂科目不動</span></button>
        </div>
      </details>
    </div>
    <div class="chart-layout">
      <div class="chart-tree">
        <div class="chart-tree-head">
          <input type="search" placeholder="搜尋科目…" value="${esc(chartFilter)}" oninput="chartFilter=this.value;drawChartTreeBody_()">
          <button type="button" class="btn sm" onclick="startNewChartLine('B')">＋ 新增科目</button>
        </div>
        <div class="chart-tree-tools">
          ${errs.length || warns.length ? `<button type="button" class="problem-pill ${errs.length ? 'err' : 'warn'}" onclick="chartShowProblems=!chartShowProblems;drawChartEditor_()">
            ${errs.length ? `⚠ ${errs.length} 個公式錯誤` : ''}${errs.length && warns.length ? '・' : ''}${warns.length ? `${warns.length} 個提醒` : ''} ${chartShowProblems ? '▴' : '▾'}</button>` : '<span class="ok-pill">✔ 科目表沒有問題</span>'}
          <span style="flex:1"></span>
          <label class="chk"><input type="checkbox" ${chartShowCodes ? 'checked' : ''} onchange="chartShowCodes=this.checked;saveChartPrefs_();drawChartTreeBody_()"> 顯示代碼</label>
          <button type="button" class="link-btn" onclick="toggleAllChartGroups_()">全部收合/展開</button>
        </div>
        ${chartShowProblems ? `<ul class="problem-list tree-problems">${chartEditor.problems.map(p =>
          `<li class="${p.level}"><a href="#" onclick="selectChartLine('${esc(p.code)}');return false;">${esc(p.message)}</a></li>`).join('')}</ul>` : ''}
        <div class="chart-tree-body" id="chart-tree-body"></div>
        <div class="tree-legend"><span><b class="ti ti-INPUT">✎</b> 手動輸入</span><span><b class="ti ti-FORMULA">ƒ</b> 公式</span><span><b class="ti ti-DEV_AMORT">⚙</b> 開發攤提</span><span>⠿ 拖曳排序</span></div>
      </div>
      <div id="chart-editor-pane">${chartEditorPaneHtml_()}</div>
    </div>`;
  drawChartTreeBody_();
  afterChartEditorRender_();
}

/** 目前情境的加權平均金額(依銷售構成比)；沒有銷售構成時回傳 null */
function chartWeightedValue_(code, source) {
  const pv = source || (chartEditor && chartEditor.preview);
  if (!pv || !pv.values) return null;
  let sum = 0, w = 0;
  Object.keys(pv.values).forEach(vid => {
    const v = pv.values[vid][code];
    if (v === undefined) return;
    const wt = num((pv.weights || {})[vid]);
    sum += v * wt; w += wt;
  });
  return w ? sum / w : null;
}

/** 科目樹：售價結構一段、損益一段；子科目縮排在小計底下、可收合，各層各自拖曳排序 */
function drawChartTreeBody_() {
  const body = document.getElementById('chart-tree-body');
  if (!body) return;
  const lines = chartEditor.lines;
  const kids = {};
  const codes = {};
  lines.forEach(l => { codes[l.LineCode] = true; });
  lines.forEach(l => { const p = l.ParentLine && codes[l.ParentLine] ? l.ParentLine : ''; (kids[p] = kids[p] || []).push(l); });
  const problemsOf = {};
  chartEditor.problems.forEach(p => { (problemsOf[p.code] = problemsOf[p.code] || []).push(p); });
  const q = chartFilter.trim().toLowerCase();
  const matches = l => !q || l.LineName.toLowerCase().indexOf(q) !== -1 || l.LineCode.toLowerCase() === q;
  const subtreeMatches = l => matches(l) || (kids[l.LineCode] || []).some(subtreeMatches);

  const rowHtml = (l, depth) => {
    const probs = problemsOf[l.LineCode] || [];
    const hasErr = probs.some(p => p.level === 'error'), hasWarn = probs.some(p => p.level === 'warning');
    const isGroup = (kids[l.LineCode] || []).length > 0;
    const collapsed = isGroup && !q && chartCollapsed.has(l.LineCode);
    const v = chartWeightedValue_(l.LineCode);
    const cls = ['tree-row', isGroup ? 'group' : '', l.isProtected ? 'subtotal-row' : '', chartSelected === l.LineCode ? 'selected' : '', q && !matches(l) ? 'dimmed' : ''].filter(c => c).join(' ');
    const info = CALC_TYPE_INFO[l.CalcType];
    const typeTip = info[0] + (l.CalcType === 'FORMULA' ? '：' + humanizeFormula_(l.Formula, chartCodeNameMap_(), l.LineCode) : '');
    return `<div class="${cls}" style="padding-left:${6 + depth * 18}px;" onclick="selectChartLine('${esc(l.LineCode)}')">
      ${q ? '<span class="tree-spacer"></span>' : dragHandleHtml('拖曳調整「' + l.LineName + '」的順序')}
      ${isGroup ? `<button type="button" class="tree-toggle${collapsed ? ' collapsed' : ''}" onclick="event.stopPropagation();toggleChartGroup('${esc(l.LineCode)}')" aria-label="收合/展開">▾</button>` : '<span class="tree-toggle-space"></span>'}
      <span class="tree-name" title="${esc(l.LineName)}">${esc(l.LineName)}</span>
      ${hasErr ? '<span class="tree-err" data-tip="公式有錯誤，暫時以 0 計">!</span>' : hasWarn ? '<span class="tree-warn" data-tip="沒有被算進營業淨利">?</span>' : ''}
      ${isGroup ? `<button type="button" class="tree-add" onclick="event.stopPropagation();startNewChartLine('${esc(l.LineCode)}')" data-tip="在「${esc(l.LineName)}」底下新增科目">＋</button>` : ''}
      <span class="tree-val${v !== null && v < 0 ? ' negative' : ''}">${v === null ? '' : fmt(v)}</span>
      <b class="ti ti-${esc(l.CalcType)}" data-tip="${esc(typeTip)}">${info[2]}</b>
      ${chartShowCodes ? `<span class="tree-code">${esc(l.LineCode)}</span>` : ''}
    </div>`;
  };
  const blockHtml = (l, depth) => {
    if (q && !subtreeMatches(l)) return '';
    const children = kids[l.LineCode] || [];
    const collapsed = !q && chartCollapsed.has(l.LineCode);
    const childBox = children.length ? `<div class="tree-children" data-parent="${esc(l.LineCode)}"${collapsed ? ' hidden' : ''}>${children.map(c => blockHtml(c, depth + 1)).join('')}</div>` : '';
    // 扣減型小計(銷貨毛利 = 生產毛利 − Σ明細)跟 Excel 一樣：明細在上、小計列在下
    return isFooterGroupLine_(l) && childBox
      ? `<div class="tree-block footer-group" data-key="${esc(l.LineCode)}">${childBox}${rowHtml(l, depth)}</div>`
      : `<div class="tree-block" data-key="${esc(l.LineCode)}">${rowHtml(l, depth)}${childBox}</div>`;
  };
  const top = kids[''] || [];
  const price = top.filter(l => l.Category === '售價結構');
  const pl = top.filter(l => l.Category !== '售價結構');
  const priceCollapsed = !q && chartCollapsed.has('__price__');
  body.innerHTML = `
    ${price.length ? `<button type="button" class="tree-section" onclick="toggleChartGroup('__price__')">${priceCollapsed ? '▸' : '▾'} 售價結構（P1~P9，由售價與稅率推算）</button>
      <div class="tree-top" data-parent="" data-section="price"${priceCollapsed ? ' hidden' : ''}>${price.map(l => blockHtml(l, 0)).join('')}</div>` : ''}
    <div class="tree-section static">損益</div><div class="tree-top" data-parent="" data-section="pl">${pl.map(l => blockHtml(l, 0)).join('')}</div>`;
  if (q) return;
  body.querySelectorAll('.tree-top, .tree-children').forEach(container => {
    makeSortable(container, { items: '.tree-block', direct: true, onEnd: () => saveChartOrderFromDom_() });
  });
}

function toggleChartGroup(code) {
  if (chartCollapsed.has(code)) chartCollapsed.delete(code); else chartCollapsed.add(code);
  saveChartPrefs_();
  drawChartTreeBody_();
}
function toggleAllChartGroups_() {
  const groups = chartEditor.lines.filter(p => chartEditor.lines.some(l => l.ParentLine === p.LineCode)).map(l => l.LineCode).concat(['__price__']);
  const anyOpen = groups.some(g => !chartCollapsed.has(g));
  chartCollapsed = new Set(anyOpen ? groups : []);
  saveChartPrefs_();
  drawChartTreeBody_();
}

/** 拖曳放開後：依畫面上的樹狀順序組出完整順序(含父科目)一次送後端 */
function saveChartOrderFromDom_() {
  const items = [];
  const walk = (container, parent) => {
    Array.from(container.children).forEach(block => {
      if (!block.classList.contains('tree-block')) return;
      items.push({ LineCode: block.getAttribute('data-key'), ParentLine: parent });
      const childBox = block.querySelector(':scope > .tree-children');
      if (childBox) walk(childBox, block.getAttribute('data-key'));
    });
  };
  document.querySelectorAll('#chart-tree-body .tree-top').forEach(top => walk(top, ''));
  google.script.run
    .withSuccessHandler(safeHandler(() => {
      Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
      toast('已更新科目順序', 'ok', 1400);
      loadChartEditor_(true);
    }))
    .withFailureHandler(err => { toast(err.message, 'err'); loadChartEditor_(true); })
    .setLineOrder(currentVehicleTypeId, items);
}

function selectChartLine(code) {
  if (code === chartSelected) return;
  const go = () => {
    clearDirty();
    chartSelected = code;
    const line = chartLineByCode_(code);
    chartDraft = line ? draftFromLine_(line) : null;
    chartPreview = null;
    // 選到被收合的子科目時，把它的父科目展開
    let p = line && line.ParentLine, g = 0;
    while (p && g++ < 20) { chartCollapsed.delete(p); const pl = chartLineByCode_(p); p = pl && pl.ParentLine; }
    if (line && line.Category === '售價結構') chartCollapsed.delete('__price__');
    drawChartTreeBody_();
    const pane = document.getElementById('chart-editor-pane');
    if (pane) pane.innerHTML = chartEditorPaneHtml_();
    afterChartEditorRender_();
  };
  if (isDirty_()) confirmLeave_().then(ok => { if (ok) go(); }); else go();
}

function startNewChartLine(parent) {
  const go = () => {
    clearDirty();
    chartSelected = '__new__';
    const parentLine = parent && chartLineByCode_(parent) ? parent : 'B';
    chartDraft = { LineCode: '', LineName: '', ParentLine: parentLine, CalcType: 'INPUT', Formula: '', VehicleFormulas: {}, CommodityTaxDeduct: '', DevAmortCategory: '', Description: '', isProtected: false };
    chartPreview = null;
    chartCollapsed.delete(parentLine);
    drawChartTreeBody_();
    document.getElementById('chart-editor-pane').innerHTML = chartEditorPaneHtml_();
    afterChartEditorRender_();
    const name = document.getElementById('ce-name');
    if (name) name.focus();
  };
  if (isDirty_()) confirmLeave_().then(ok => { if (ok) go(); }); else go();
}

/** 父科目選項：公式裡有 CHILDREN() 的科目(會把子科目加總起來的才適合當父科目)，或目前已經有子科目的科目 */
function chartParentOptions_(selfCode) {
  const lines = chartEditor.lines;
  const descendants = {};
  const mark = code => lines.filter(l => l.ParentLine === code).forEach(l => { descendants[l.LineCode] = true; mark(l.LineCode); });
  if (selfCode) mark(selfCode);
  const opts = lines.filter(l => l.LineCode !== selfCode && !descendants[l.LineCode] &&
    ((l.CalcType === 'FORMULA' && /CHILDREN\s*\(/i.test(l.Formula || '')) || lines.some(x => x.ParentLine === l.LineCode)));
  return [['', '（不計入任何小計）']].concat(opts.map(l => [l.LineCode, l.LineName]));
}

/* ---------------- 右邊的編輯器 ---------------- */
function chartEditorPaneHtml_() {
  if (!chartDraft) {
    return `<div class="card editor-empty">
      <div style="font-size:30px;opacity:.5;">ƒx</div>
      <h4 style="color:var(--text);margin:8px 0 6px;">點左邊的科目來設定</h4>
      <div class="howto">
        <div><b>改算法</b>：點科目 → 選「怎麼算」→ 一行一項選科目、乘上比率，每一行旁邊立刻看到結果</div>
        <div><b>加科目</b>：小計那一列右邊的「＋」，直接加在那一段底下</div>
        <div><b>改順序</b>：抓住 ⠿ 拖到想要的位置，放開就存</div>
        <div><b>貼 Excel</b>：成本、費用的金額可以在「銷貨成本」「營業費用」頁直接整塊貼上</div>
      </div></div>`;
  }
  const d = chartDraft;
  const isNew = chartSelected === '__new__';
  const parentOpts = chartParentOptions_(d.LineCode);
  const typeBtns = Object.keys(CALC_TYPE_INFO).map(t => `
    <button type="button" class="calc-type-card${d.CalcType === t ? ' active' : ''}" data-type="${t}" onclick="setChartCalcType('${t}')">
      <b><i class="ti ti-${t}">${CALC_TYPE_INFO[t][2]}</i> ${esc(CALC_TYPE_INFO[t][0])}</b><span>${esc(CALC_TYPE_INFO[t][1])}</span></button>`).join('');
  const overrides = d.VehicleFormulas || {};
  const overrideCount = Object.keys(overrides).filter(k => String(overrides[k] || '').trim()).length;
  const vehicles = chartEditor.vehicles || [];
  return `
    <div class="card editor">
      <div class="ed-head">
        <input id="ce-name" class="ed-name" type="text" value="${esc(d.LineName)}" placeholder="科目名稱，例如：關稅"
          oninput="chartDraft.LineName=this.value;chartDirty_()">
        <div class="ed-sub">
          <label>計入
            <select onchange="chartDraft.ParentLine=this.value;chartDirty_();schedulePreview_()">
              ${parentOpts.map(o => `<option value="${esc(o[0])}"${String(d.ParentLine || '') === o[0] ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}
            </select></label>
          ${isNew ? '<span class="muted">代碼儲存時自動產生</span>' : `<span class="tree-code">代碼 ${esc(d.LineCode)}</span>`}
          ${d.isProtected ? '<span class="type-badge" data-tip="預設的小計/毛利/淨利。跟其他科目一樣可以改名、改算法、移動或刪除；儀表板重點指標、GATE 報告會用到它，刪除後那些地方會顯示空白">預設小計</span>' : ''}
          ${!isNew && d.usage ? `<span class="muted">${d.usage} 筆輸入金額</span>` : ''}
        </div>
      </div>

      <div class="ed-step">
        <div class="ed-step-title"><span class="step-no">1</span>這個科目怎麼算？</div>
        <div class="calc-type-cards">${typeBtns}</div>
      </div>

      <div class="ed-step" id="ce-calc-body">${chartCalcBodyHtml_()}</div>

      <div class="ed-step">
        <div class="ed-step-title"><span class="step-no">3</span>結果 <span class="muted" style="font-weight:400;">目前情境：${esc(currentScenario ? scenarioLabel(currentScenario) : '未選擇')}，還沒儲存不影響其他頁面</span></div>
        <div id="ce-preview">${chartPreviewHtml_()}</div>
      </div>

      <details class="ed-adv"${overrideCount || d.Description ? ' open' : ''}>
        <summary>進階設定${overrideCount ? `（${overrideCount} 個車系另外指定算法）` : ''}</summary>
        <div class="ed-adv-body">
          <div class="field"><span>個別車系的算法不一樣？</span>
            <span class="help">同一個車型裡，某個車系要用不同算法才填（例：3人貨車的一般材料 = DE 實績 × 1.2）。留白 = 照上面的設定。</span></div>
          ${vehicles.length ? `<table class="grid-table override-table"><tbody>${vehicles.map(v => `<tr>
              <td class="row-head" style="width:170px;">${esc(v.VehicleCode || v.VehicleID)}</td>
              <td><input type="text" value="${esc(overrides[v.VehicleID] || '')}" placeholder="（照上面的設定）"
                oninput="setChartOverride('${esc(v.VehicleID)}', this.value)"></td></tr>`).join('')}</tbody></table>` : '<p class="muted">這個車型還沒有車系。</p>'}
          <label class="chk" style="margin-top:12px;" data-tip="貨物稅的完稅價格要扣除這個科目（預設：廣宣、促銷、批標售、季Margin）。公式 TAXDEDUCT() 就是這些科目的合計。">
            <input type="checkbox" ${String(d.CommodityTaxDeduct).toUpperCase() === 'Y' ? 'checked' : ''}
              onchange="chartDraft.CommodityTaxDeduct=this.checked?'Y':'';chartDirty_();schedulePreview_()"> 貨物稅完稅價格可以扣除這個科目</label>
          <label class="field" style="margin-top:12px;"><span>科目說明（算法依據、資料來源）</span>
            <textarea rows="2" oninput="chartDraft.Description=this.value;chartDirty_()" placeholder="例：依生技部工時 × 24~26 年平均費率">${esc(d.Description || '')}</textarea></label>
        </div>
      </details>

      <div class="ed-foot">
        ${!isNew ? `<button type="button" class="btn danger" onclick="deleteChartLine()">刪除科目</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="btn secondary" onclick="cancelChartEdit()">${isNew ? '取消' : '還原'}</button>
        <button type="button" class="btn" onclick="saveChartLineUi()">${isNew ? '新增科目' : '儲存'}</button>
      </div>
    </div>`;
}

function chartCalcBodyHtml_() {
  const d = chartDraft;
  const title = `<div class="ed-step-title"><span class="step-no">2</span>${d.CalcType === 'DEV_AMORT' ? '攤提設定' : '金額在哪裡填'}</div>`;
  if (d.CalcType === 'INPUT') {
    const isCost = chartIsCostSection_(d);
    return title + `<div class="callout info">每個車系的金額在「${isCost ? '銷貨成本' : '營業費用'}」頁填（也可以從 Excel 整塊貼上）。
      <button type="button" class="link-btn" onclick="switchTab('${isCost ? 'costofsales' : 'operatingexpense'}')">前往${isCost ? '銷貨成本' : '營業費用'} →</button></div>`;
  }
  if (d.CalcType === 'DEV_AMORT') {
    return title + `<div class="field-row"><label class="field"><span>開發總投大類</span>
        <select onchange="chartDraft.DevAmortCategory=this.value;chartDirty_()">${(chartEditor.devCategories || ['設備', '模具', '費用']).map(c =>
          `<option value="${c}"${d.DevAmortCategory === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label></div>
      <div class="callout info" style="margin-top:10px;">在「開發總投」頁把投資列的攤提落點選成這個科目，金額 ÷ 攤提台數就會出現在這裡（可以只攤給部分車系）。
        <button type="button" class="link-btn" onclick="switchTab('devinvestment')">前往開發總投 →</button></div>`;
  }
  return fxEditorHtml_();
}

function chartIsCostSection_(d) {
  let cur = d, guard = 0;
  while (cur && cur.ParentLine && guard++ < 20) {
    if (cur.ParentLine === 'B') return true;
    cur = chartLineByCode_(cur.ParentLine);
  }
  return false;
}

function afterChartEditorRender_() {
  if (chartDraft) schedulePreview_(true);
}

/* ---------------- 公式輸入：自動完成 ---------------- */
/** 可以放進公式的東西：科目(用名稱)、系統變數、參數、匯率 */
function formulaCandidates_() {
  const out = [];
  chartEditor.lines.forEach(l => {
    if (chartDraft && l.LineCode === chartDraft.LineCode) return;
    out.push({ kind: '科目', label: l.LineName, insert: chartNameUsable_(l) ? '[' + l.LineName + ']' : l.LineCode, hint: l.LineCode });
  });
  (chartEditor.params || []).forEach(p => out.push({ kind: '參數', label: p.ParamName, insert: '[' + p.ParamName + ']', hint: p.Unit === '%' ? '%' : '數值' }));
  (chartEditor.variables || []).forEach(v => out.push({ kind: '變數', label: v.name, insert: '[' + v.name + ']', hint: '' }));
  (chartEditor.currencies || ['CNY', 'USD', 'JPY', 'EUR']).forEach(c => out.push({ kind: '匯率', label: c + '匯率', insert: '[' + c + '匯率]', hint: '1 ' + c + ' = ? 元' }));
  return out;
}
/** 游標前面是不是一個還沒關起來的 [ ：是的話回傳 [ 的位置與已經打的字 */
function openBracketAt_(text, caret) {
  const before = text.slice(0, caret);
  const i = before.lastIndexOf('[');
  if (i === -1 || before.indexOf(']', i) !== -1) return null;
  return { start: i, query: before.slice(i + 1) };
}
function onFormulaInput_(ta) {
  chartDraft.Formula = ta.value;
  chartDirty_();
  schedulePreview_();
  const ob = openBracketAt_(ta.value, ta.selectionStart || 0);
  if (!ob) { closeFormulaAc_(); return; }
  const q = ob.query.trim().toLowerCase();
  const items = formulaCandidates_().filter(c => !q || c.label.toLowerCase().indexOf(q) !== -1 || (c.hint || '').toLowerCase() === q).slice(0, 40);
  if (!items.length) { closeFormulaAc_(); return; }
  chartAc_ = { items, index: 0, start: ob.start };
  drawFormulaAc_();
}
function drawFormulaAc_() {
  const box = document.getElementById('ce-ac');
  if (!box || !chartAc_) return;
  let lastKind = '';
  box.innerHTML = chartAc_.items.map((c, i) => {
    const head = c.kind !== lastKind ? `<div class="ac-group">${esc(c.kind)}</div>` : '';
    lastKind = c.kind;
    return head + `<div class="ac-item${i === chartAc_.index ? ' active' : ''}" onmousedown="event.preventDefault();pickFormulaAc_(${i})">
      <span>${esc(c.label)}</span><span class="muted">${esc(c.hint || '')}</span></div>`;
  }).join('');
  box.hidden = false;
  scrollListTo_(box, box.querySelector('.ac-item.active'));
}
/**
 * 離開公式框稍後再關清單(讓滑鼠點清單來得及)。到時候游標又回到框裡、或這個框已經被重畫掉(存檔後編輯器重畫，
 * 移除舊框也會觸發 blur)就不關 —— 不然新框裡剛打開的清單會被舊的計時器關掉，按 Enter 變成換行。
 */
function onFormulaBlur_(ta) {
  setTimeout(() => { if (ta.isConnected && document.activeElement !== ta) closeFormulaAc_(); }, 150);
}
function closeFormulaAc_() {
  chartAc_ = null;
  const box = document.getElementById('ce-ac');
  if (box) box.hidden = true;
}
function onFormulaKeydown_(e) {
  if (!chartAc_) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    chartAc_.index = (chartAc_.index + (e.key === 'ArrowDown' ? 1 : -1) + chartAc_.items.length) % chartAc_.items.length;
    drawFormulaAc_();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickFormulaAc_(chartAc_.index);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFormulaAc_();
  }
}
function pickFormulaAc_(i) {
  const ta = document.getElementById('ce-formula');
  if (!ta || !chartAc_) return;
  const c = chartAc_.items[i];
  const caret = ta.selectionStart || 0;
  const after = ta.value.slice(caret);
  const closeLen = /^[^\[\]]*\]/.test(after) ? after.indexOf(']') + 1 : 0;   // 已經有 ] 就一起換掉
  ta.value = ta.value.slice(0, chartAc_.start) + c.insert + ' ' + after.slice(closeLen);
  const pos = chartAc_.start + c.insert.length + 1;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  closeFormulaAc_();
  chartDraft.Formula = ta.value;
  chartDirty_();
  schedulePreview_();
}

function insertFormulaText(text) {
  const ta = document.getElementById('ce-formula');
  if (!ta) return;
  const start = ta.selectionStart || 0, end = ta.selectionEnd || 0;
  const v = ta.value;
  const needSpace = start > 0 && /[\w\]\)]$/.test(v.slice(0, start)) && /^[\w\[]/.test(text);
  const ins = (needSpace ? ' ' : '') + text;
  ta.value = v.slice(0, start) + ins + v.slice(end);
  const pos = start + ins.length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  chartDraft.Formula = ta.value;
  chartDirty_();
  schedulePreview_();
}
/** 公式的可讀版本(儀表板/報告/矩陣頁用)：代碼換成科目名稱、[名稱] 與函式上色 */
function formulaReadableHtml_(formula) {
  if (!formula || !String(formula).trim()) return '<span class="muted">（輸入公式後，這裡會用科目名稱顯示）</span>';
  const map = chartCodeNameMap_();
  const refLabels = {};
  (chartEditor.referenceScenarios || []).forEach(r => { refLabels[r.ScenarioID] = r.label; });
  const src = String(formula);
  let out = '', i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = /^\[[^\]]*\]/.exec(rest))) { out += `<span class="fx-tok-name">${esc(m[0].slice(1, -1))}</span>`; i += m[0].length; continue; }
    if ((m = /^"[^"]*"/.exec(rest))) { const inner = m[0].slice(1, -1); out += esc(refLabels[inner] ? '「' + refLabels[inner] + '」' : m[0]); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/.exec(rest))) {
      const fnLabel = { CHILDREN: 'Σ子科目', TAXDEDUCT: 'Σ可扣除貨物稅科目' }[m[0].toUpperCase()];
      out += `<span class="fx-tok-fn">${esc(fnLabel || m[0].toUpperCase())}</span>`;
      i += m[0].length;
      if (fnLabel) { const close = /^\s*\(\s*\)/.exec(src.slice(i)); if (close) i += close[0].length; }
      continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      out += map[m[0]] ? `<span class="fx-tok-code">${esc(map[m[0]])}</span>` : `<span class="negative">${esc(m[0])}</span>`;
      i += m[0].length; continue;
    }
    out += esc(rest[0].replace('*', '×').replace('/', '÷'));
    i++;
  }
  return '= ' + out;
}

function setChartCalcType(t) {
  if (!chartDraft || chartDraft.CalcType === t) return;
  chartDraft.CalcType = t;
  if (t === 'DEV_AMORT' && !chartDraft.DevAmortCategory) chartDraft.DevAmortCategory = chartDraft.ParentLine === 'G' ? '費用' : '模具';
  document.querySelectorAll('.calc-type-card').forEach(el => el.classList.toggle('active', el.getAttribute('data-type') === t));
  document.getElementById('ce-calc-body').innerHTML = chartCalcBodyHtml_();
  afterChartEditorRender_();
  chartDirty_();
  if (t === 'FORMULA' && fxMode === 'text') { const ta = document.getElementById('ce-formula'); if (ta) ta.focus(); }
}
function setChartOverride(vehicleId, formula) {
  chartDraft.VehicleFormulas = chartDraft.VehicleFormulas || {};
  chartDraft.VehicleFormulas[vehicleId] = formula;
  chartDirty_();
  schedulePreview_();
}
function chartDirty_() { markDirty('lineitems', saveChartLineUi, cancelChartEdit); }

function chartDraftPayload_() {
  const d = chartDraft;
  return {
    LineCode: chartSelected === '__new__' ? '' : d.LineCode,
    LineName: d.LineName, ParentLine: d.ParentLine || '', CalcType: d.CalcType,
    Formula: d.CalcType === 'FORMULA' ? d.Formula : '', VehicleFormulas: d.VehicleFormulas || {},
    CommodityTaxDeduct: d.CommodityTaxDeduct || '', DevAmortCategory: d.DevAmortCategory || '', Description: d.Description || ''
  };
}

/** 邊打公式邊試算：debounce 後送「還沒存的這一個科目」給後端算，不寫入任何資料 */
function schedulePreview_(immediate) {
  if (chartPreviewTimer_) clearTimeout(chartPreviewTimer_);
  chartPreviewTimer_ = setTimeout(() => {
    if (!chartDraft) return;
    if (chartDraft.CalcType === 'FORMULA' && !String(chartDraft.Formula || '').trim()) { chartPreview = null; renderChartPreview_(); return; }   // 還沒寫公式不算錯
    const probes = fxProbeList_();
    google.script.run
      .withSuccessHandler(res => { chartPreview = res; renderChartPreview_(); fxApplyProbes_(res && res.preview, probes); })
      .withFailureHandler(err => { chartPreview = { problems: [{ message: err.message }] }; renderChartPreview_(); })
      .previewLineFormula(currentVehicleTypeId, currentScenarioId, Object.assign(chartDraftPayload_(), { Probes: probes }));
  }, immediate ? 0 : 350);
}
function renderChartPreview_() {
  const box = document.getElementById('ce-preview');
  if (box) box.innerHTML = chartPreviewHtml_();
  const st = document.getElementById('ce-status');
  if (st && chartDraft && chartDraft.CalcType === 'FORMULA') {
    const probs = chartPreview && chartPreview.problems || [];
    if (!String(chartDraft.Formula || '').trim()) { st.className = 'formula-status'; st.innerHTML = ''; }
    else if (probs.length) { st.className = 'formula-status err'; st.textContent = '✘ ' + probs.map(p => p.message.replace(/^「[^」]*」/, '')).join('；'); }
    else if (chartPreview) { st.className = 'formula-status ok'; st.innerHTML = '✔ ' + formulaReadableHtml_(chartDraft.Formula); }
  }
  fxRefreshValues_();
}
/** 結果：每個車系「目前 → 修改後」與對營業淨利的影響；計算過程收在展開區 */
function chartPreviewHtml_() {
  if (!currentScenarioId) return '<p class="muted">右上角選一個情境就能看到試算結果。</p>';
  const cur = chartEditor.preview;
  const next = chartPreview && chartPreview.preview;
  const probs = (chartPreview && chartPreview.problems) || [];
  if (!cur && !next) return '<p class="muted">這個情境還沒有銷售構成資料，無法試算。</p>';
  const vehicles = (chartEditor.vehicles || []).filter(v => (cur && cur.values[v.VehicleID]) || (next && next.values[v.VehicleID]));
  if (!vehicles.length) return '<p class="muted">這個情境還沒有銷售構成資料，無法試算。</p>';
  const code = chartSelected === '__new__' ? '__NEW__' : chartDraft.LineCode;   // 還沒新增的科目用暫時代碼試算
  const kCode = profitCodeOf_(chartEditor);
  const map = chartCodeNameMap_();
  const row = (label, a, b, k0, k1, cls) => {
    const changed = b !== undefined && a !== undefined && Math.abs(a - b) > 0.5;
    const dk = (k1 !== undefined && k0 !== undefined) ? k1 - k0 : 0;
    return `<tr class="${cls || ''}"><td class="row-head">${esc(label)}</td>
      <td class="calc">${a === undefined || a === null ? '—' : fmt(a)}</td>
      <td class="calc" style="${changed ? 'font-weight:700;' : ''}">${b === undefined || b === null ? (probs.length ? '—' : '…') : fmt(b)}</td>
      <td class="calc ${Math.abs(dk) > 0.5 ? (dk > 0 ? 'good' : 'bad') : 'muted'}">${Math.abs(dk) > 0.5 ? signed_(dk) : '—'}</td></tr>`;
  };
  const traces = vehicles.map(v => {
    const err = next && next.errors[v.VehicleID] && (next.errors[v.VehicleID][code] || next.errors[v.VehicleID]['*']);
    const trace = next && next.traces[v.VehicleID] && next.traces[v.VehicleID][code];
    return `<div class="trace-item"><b>${esc(v.VehicleCode || v.VehicleID)}</b><pre>${err ? '⚠ ' + esc(err) : esc(traceText_(trace, map) || '（手動輸入）')}</pre></div>`;
  }).join('');
  return `${probs.length ? `<div class="callout err">${probs.map(p => esc(p.message)).join('<br>')}</div>` : ''}
    <table class="grid-table preview-table">
      <thead><tr><th>車系</th><th>目前</th><th>修改後</th><th>營業淨利變化</th></tr></thead>
      <tbody>${vehicles.map(v => {
        const a = cur && cur.values[v.VehicleID] || {}, b = next && next.values[v.VehicleID] || null;
        return row(v.VehicleCode || v.VehicleID, a[code], b ? b[code] : undefined, a[kCode], b ? b[kCode] : undefined);
      }).join('')}
      ${row('加權平均', chartWeightedValue_(code, cur), next ? chartWeightedValue_(code, next) : undefined,
        chartWeightedValue_(kCode, cur), next ? chartWeightedValue_(kCode, next) : undefined, 'subtotal')}</tbody>
    </table>
    <details class="trace-box"><summary class="link-btn">看計算過程</summary>${traces}</details>`;
}

function saveChartLineUi() {
  if (!chartDraft) return;
  const payload = chartDraftPayload_();
  if (!String(payload.LineName || '').trim()) { toast('請輸入科目名稱', 'warn'); const n = document.getElementById('ce-name'); if (n) n.focus(); return; }
  payload.__scenarioId = currentScenarioId;
  google.script.run
    .withSuccessHandler(safeHandler(res => {
      clearDirty();
      Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
      chartEditor = res.editor;
      chartSelected = res.line.LineCode;
      const line = chartEditor.lines.find(l => l.LineCode === chartSelected);
      chartDraft = draftFromLine_(line || res.line);
      chartPreview = null;
      toast(payload.LineCode ? '已儲存「' + res.line.LineName + '」' : '已新增科目「' + res.line.LineName + '」', 'ok');
      drawChartEditor_();
    }))
    .withFailureHandler(err => toast(err.message, 'err'))
    .saveChartLine(currentVehicleTypeId, payload);
}
function cancelChartEdit() {
  clearDirty();
  if (chartSelected === '__new__') { chartSelected = ''; chartDraft = null; }
  else { const l = chartLineByCode_(chartSelected); chartDraft = l ? draftFromLine_(l) : null; }
  chartPreview = null;
  drawChartEditor_();
}
function deleteChartLine() {
  const d = chartDraft;
  let profitNote = '';
  if (d.LineCode === profitCodeOf_(chartEditor)) {
    // 刪掉營業淨利：儀表板重點指標、GATE 報告、目標反推會改看損益表最後一行總計(同後端 profitLineCode_)
    const rest = chartEditor.lines.filter(l => l.LineCode !== d.LineCode && !l.ParentLine && l.Category !== '售價結構');
    const next = rest[rest.length - 1];
    profitNote = `<div class="callout warn" style="margin-top:10px;"><div>這是目前的營業淨利。刪除後，儀表板重點指標、GATE 報告、目標反推會改用損益表最後一行${next ? `<b>「${esc(next.LineName)}」</b>` : '（目前沒有其他總計科目）'}當營業淨利。只是想換名稱或公式的話，直接改這個科目就好，不必刪除。</div></div>`;
  }
  confirmModal('刪除科目「' + d.LineName + '」？',
    `只影響車型 <b>${esc(currentVehicleTypeId)}</b>。${d.usage ? `這個科目在 ${esc(currentVehicleTypeId)} 的情境裡有 <b>${d.usage}</b> 筆輸入金額，會一起清掉。` : ''}被其他公式引用、或底下還有子科目時會被擋下來。${profitNote}`,
    '刪除', true).then(ok => {
    if (!ok) return;
    google.script.run
      .withSuccessHandler(safeHandler(() => {
        clearDirty();
        Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
        toast('已刪除科目', 'ok');
        chartSelected = ''; chartDraft = null;
        loadChartEditor_();
      }))
      .withFailureHandler(err => toast(err.message, 'err'))
      .deletePLLineItem(d.LineCode, currentVehicleTypeId);
  });
}
function copyChartDialog() {
  const others = chartEditor.otherTypes || [];
  openModal({
    title: '複製科目表到 ' + currentVehicleTypeId,
    body: `<div class="callout warn">${esc(currentVehicleTypeId)} 目前的科目表會整份換掉。代碼相同的科目，已輸入的金額照樣對得到；新科目表沒有的科目，金額會留著但不再計入。</div>`,
    fields: [{ name: 'source', label: '複製來源', type: 'select', value: '', options: [['', '標準範本']].concat(others.map(t => [t, '車型 ' + t])) }],
    okText: '整份換掉', danger: true
  }).then(v => {
    if (!v) return;
    google.script.run
      .withSuccessHandler(safeHandler(() => {
        clearDirty();
        Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
        chartSelected = ''; chartDraft = null;
        toast('已複製科目表', 'ok');
        loadChartEditor_();
      }))
      .withFailureHandler(err => toast(err.message, 'err'))
      .copyChartFromType(currentVehicleTypeId, v.source);
  });
}
function saveChartAsTemplateUi() {
  confirmModal('把 ' + currentVehicleTypeId + ' 的科目表存成標準範本？', '之後新建車型時選「標準範本」就會複製這一份。已經存在的車型不受影響。', '存成範本').then(ok => {
    if (!ok) return;
    google.script.run.withSuccessHandler(n => toast('已存成標準範本（' + n + ' 個科目）', 'ok'))
      .withFailureHandler(err => toast(err.message, 'err')).saveChartAsTemplate(currentVehicleTypeId);
  });
}
function restoreChartDefaults() {
  confirmModal('恢復預設科目？', '預設科目的名稱、公式、父科目與排序會回復成系統預設，刪掉的預設科目會補回來；你自己新增的科目與車系個別公式不受影響。', '恢復', true).then(ok => {
    if (!ok) return;
    google.script.run.withSuccessHandler(safeHandler(() => {
      clearDirty();
      Object.keys(panelDataCache_).forEach(k => delete panelDataCache_[k]);
      toast('已恢復預設科目', 'ok');
      loadChartEditor_(true);
    })).withFailureHandler(err => toast(err.message, 'err')).restoreBuiltInLineItems(currentVehicleTypeId);
  });
}
