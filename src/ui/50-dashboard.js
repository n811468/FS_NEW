/* ================= 儀表板：多車型 / 多情境比較 ================= */
let comparisonOptions = [];
let comparisonSelections = [];
let lastComparison = null;
let dashPrefsLoaded_ = false;
let dashView = 'table';               // 目前顯示哪個子頁：'columns' 比較欄位 / 'table' 損益表 / 'chart' 圖表 / 'diff' 差異比較
// 新增比較欄位那一列還沒送出的草稿(車型/情境/車系)，跟已經加入的 comparisonSelections 分開放
let builderDraft_ = { vehicleTypeId: '', scenarioId: '', vehicleId: '' };

function loadComparisonPicker() {
  google.script.run
    .withSuccessHandler(safeHandler(options => {
      comparisonOptions = options || [];
      // 第一次進儀表板先把上次的比較欄位/顯示設定從瀏覽器還原回來(見 loadDashPrefs_)，
      // 不必每次打開都重新加一遍欄位；已被刪掉的情境/車系會被濾掉。
      if (!dashPrefsLoaded_) { loadDashPrefs_(); dashPrefsLoaded_ = true; }
      comparisonSelections = comparisonSelections.filter(selectionExists_);
      // 上方選了哪個情境，儀表板就該看得到那個情境 —— 不管是第一次進來(還沒加任何比較欄位)，
      // 還是已經加過其他欄位、中途把上方情境切到別的(如切去改「目標」的開發總投再回來看儀表板)，
      // 只要目前選的情境還沒被加進來，就補一欄「加權平均」；只新增不刪除，不會把使用者原本
      // 排好的比較欄位洗掉，也不會重複加(已經有這個情境的欄位就不動)。
      if (currentScenarioId && !comparisonSelections.some(s => s.ScenarioID === currentScenarioId)) {
        // 原本一欄都沒有(第一次用、或剛載入資料)時自動補上的這一欄，直接給使用者看損益表
        if (!comparisonSelections.length && dashView === 'columns') dashView = 'table';
        comparisonSelections.push({ ScenarioID: currentScenarioId, VehicleID: '' });
      }
      if (!comparisonSelections.length) dashView = 'columns';   // 還沒有任何比較欄位時，直接停在「比較欄位」頁面
      // 進儀表板一律重新跟後端要一次：其他分頁可能剛改過成本/費用，快取在手上的舊結果不能信
      refreshDashboard(true);
    }))
    .withFailureHandler(showGlobalError)
    .getComparisonOptions();
}

/** 這組(情境,車系)在目前的選項樹裡還存在嗎？情境或車系被刪掉後，記住的比較欄位就不該再出現 */
function selectionExists_(sel) {
  return comparisonOptions.some(t =>
    t.scenarios.some(s => s.ScenarioID === sel.ScenarioID) &&
    (!sel.VehicleID || t.vehicles.some(v => v.VehicleID === sel.VehicleID)));
}

/**
 * 建構比較欄位：整張表都是下拉選單，改哪一列就直接換那一欄要比的資料 ——
 * 跟系統其他頁面「表格式編輯」的慣例一致，不再另外用一組獨立的挑選器 + 卡片列表。
 * 最後一列永遠是「新增」列，選好車型/情境/車系後按「加入」才會變成一個真正的比較欄位。
 */
function comparisonBuilderHtml_() {
  if (!comparisonOptions.length) return '<p class="muted">尚無車型資料，請先在「車型主檔」建立車型。</p>';
  if (!builderDraft_.vehicleTypeId || !comparisonOptions.some(t => t.VehicleTypeID === builderDraft_.vehicleTypeId)) {
    builderDraft_.vehicleTypeId = comparisonOptions[0].VehicleTypeID;
    builderDraft_.scenarioId = ''; builderDraft_.vehicleId = '';
  }
  const draftType = comparisonOptions.find(t => t.VehicleTypeID === builderDraft_.vehicleTypeId);
  if (!draftType.scenarios.some(s => s.ScenarioID === builderDraft_.scenarioId)) {
    builderDraft_.scenarioId = (draftType.scenarios[0] && draftType.scenarios[0].ScenarioID) || '';
  }
  if (builderDraft_.vehicleId && !draftType.vehicles.some(v => v.VehicleID === builderDraft_.vehicleId)) {
    builderDraft_.vehicleId = '';
  }

  const rows = comparisonSelections.map((sel, i) => builderRowHtml_(sel, i)).join('');
  return `
    <p class="page-intro">每一列是一個比較欄位（車型 × 情境 × 車系）。改下拉選單直接換這一欄要比的資料，
      拖曳 ⠿ 調整欄位順序；最後一列選好之後按「加入」新增一欄。可以把不同車型放在一起比。</p>
    <div class="grid-scroll"><table class="grid-table builder-table">
      <thead><tr><th></th><th>車型</th><th>情境</th><th>車系</th><th></th></tr></thead>
      <tbody id="builder-rows">
        ${rows}
        ${builderNewRowHtml_(draftType)}
      </tbody>
    </table></div>
    ${comparisonSelections.length ? `<div class="toolbar"><button type="button" class="btn secondary" onclick="clearComparisonColumns()">全部清除</button></div>` : ''}
  `;
}

function builderRowHtml_(sel, i) {
  const type = comparisonOptions.find(t => t.scenarios.some(s => s.ScenarioID === sel.ScenarioID));
  const typeId = type ? type.VehicleTypeID : '';
  const scenarios = type ? type.scenarios : [];
  const vehicles = type ? type.vehicles : [];
  return `<tr data-key="${i}" data-idx="${i}">
    <td class="row-actions">${dragHandleHtml('拖曳調整比較欄位順序')}</td>
    <td><select onchange="onBuilderRowTypeChange_(${i}, this.value)">
      ${comparisonOptions.map(t => `<option value="${esc(t.VehicleTypeID)}"${t.VehicleTypeID === typeId ? ' selected' : ''}>${esc(t.VehicleTypeID)}</option>`).join('')}
    </select></td>
    <td><select onchange="onBuilderRowScenarioChange_(${i}, this.value)">${scenarioOptionsHtml_(scenarios, sel.ScenarioID)}</select></td>
    <td><select onchange="onBuilderRowVehicleChange_(${i}, this.value)">
      <option value=""${!sel.VehicleID ? ' selected' : ''}>加權平均</option>
      ${vehicles.map(v => `<option value="${esc(v.VehicleID)}"${v.VehicleID === sel.VehicleID ? ' selected' : ''}>${esc(v.VehicleCode || v.VehicleID)}</option>`).join('')}
    </select></td>
    <td class="row-actions"><button type="button" class="btn ghost sm" onclick="removeComparisonColumn(${i})" data-tip="移除這一欄">✕</button></td>
  </tr>`;
}

function builderNewRowHtml_(draftType) {
  const scenarios = draftType ? draftType.scenarios : [];
  const vehicles = draftType ? draftType.vehicles : [];
  return `<tr class="builder-new-row">
    <td class="row-actions muted">+</td>
    <td><select onchange="onBuilderDraftChange_('vehicleTypeId', this.value)">
      ${comparisonOptions.map(t => `<option value="${esc(t.VehicleTypeID)}"${t.VehicleTypeID === builderDraft_.vehicleTypeId ? ' selected' : ''}>${esc(t.VehicleTypeID)}</option>`).join('')}
    </select></td>
    <td>${scenarios.length ? `<select onchange="onBuilderDraftChange_('scenarioId', this.value)">${scenarioOptionsHtml_(scenarios, builderDraft_.scenarioId)}</select>` : '<span class="muted">(此車型尚無情境)</span>'}</td>
    <td><select onchange="onBuilderDraftChange_('vehicleId', this.value)">
      <option value=""${!builderDraft_.vehicleId ? ' selected' : ''}>加權平均</option>
      ${vehicles.map(v => `<option value="${esc(v.VehicleID)}"${v.VehicleID === builderDraft_.vehicleId ? ' selected' : ''}>${esc(v.VehicleCode || v.VehicleID)}</option>`).join('')}
    </select></td>
    <td class="row-actions">
      <button type="button" class="btn" ${scenarios.length ? '' : 'disabled'} onclick="addComparisonColumn()" data-tip="把這一欄加入比較">加入</button>
      <button type="button" class="btn secondary" ${scenarios.length ? '' : 'disabled'}
        onclick="addAllVehiclesOfScenario()" data-tip="把這個情境底下所有車系(含加權平均)都加入">全部車系</button>
    </td>
  </tr>`;
}

/** 情境下拉：一般情境在前，情境快照(唯讀的歷史版本)另成一組 */
function scenarioOptionsHtml_(scenarios, selected) {
  const opt = s => `<option value="${esc(s.ScenarioID)}"${s.ScenarioID === selected ? ' selected' : ''}>${esc(scenarioLabel(s))}</option>`;
  const live = scenarios.filter(s => !s.isSnapshot), snaps = scenarios.filter(s => s.isSnapshot);
  return live.map(opt).join('') + (snaps.length ? `<optgroup label="情境快照（歷史版本）">${snaps.map(opt).join('')}</optgroup>` : '');
}
function onBuilderDraftChange_(field, value) {
  builderDraft_[field] = value;
  if (field === 'vehicleTypeId') { builderDraft_.scenarioId = ''; builderDraft_.vehicleId = ''; }
  if (field === 'scenarioId') { builderDraft_.vehicleId = ''; }
  rerenderCurrentView_();
}

/** 編輯已加入的比較欄位：換車型等於整欄換掉，情境/車系跟著重選第一個 */
function onBuilderRowTypeChange_(i, typeId) {
  const type = comparisonOptions.find(t => t.VehicleTypeID === typeId);
  const scenarioId = (type && type.scenarios[0] && type.scenarios[0].ScenarioID) || '';
  applyBuilderEdit_(i, { ScenarioID: scenarioId, VehicleID: '' });
}
function onBuilderRowScenarioChange_(i, scenarioId) {
  applyBuilderEdit_(i, { ScenarioID: scenarioId, VehicleID: comparisonSelections[i].VehicleID });
}
function onBuilderRowVehicleChange_(i, vehicleId) {
  applyBuilderEdit_(i, { ScenarioID: comparisonSelections[i].ScenarioID, VehicleID: vehicleId });
}
/** 套用一列的編輯結果；如果改完會跟另一欄重複，就擋下來、把選單復原成原本的值 */
function applyBuilderEdit_(i, next) {
  if (comparisonSelections.some((s, j) => j !== i && s.ScenarioID === next.ScenarioID && s.VehicleID === next.VehicleID)) {
    showGlobalError('這個比較欄位已經加入過了。');
    rerenderCurrentView_();
    return;
  }
  comparisonSelections[i] = next;
  refreshDashboard();
}

function addComparisonColumn() {
  if (!builderDraft_.scenarioId) { showGlobalError('此車型尚無情境，請先在「情境設定」建立情境。'); return; }
  pushSelection(builderDraft_.scenarioId, builderDraft_.vehicleId);
  refreshDashboard();
}

/** 一次把某情境底下所有車系都加進來比較（常用：看單一情境各車系的差異） */
function addAllVehiclesOfScenario() {
  const type = comparisonOptions.find(t => t.VehicleTypeID === builderDraft_.vehicleTypeId);
  if (!builderDraft_.scenarioId || !type) return;
  type.vehicles.forEach(v => pushSelection(builderDraft_.scenarioId, v.VehicleID));
  pushSelection(builderDraft_.scenarioId, '');
  refreshDashboard();
}

function pushSelection(scenarioId, vehicleId) {
  if (comparisonSelections.some(s => s.ScenarioID === scenarioId && s.VehicleID === vehicleId)) return;
  comparisonSelections.push({ ScenarioID: scenarioId, VehicleID: vehicleId });
}

function removeComparisonColumn(idx) {
  comparisonSelections.splice(idx, 1);
  refreshDashboard();
}
function clearComparisonColumns() {
  comparisonSelections = [];
  refreshDashboard();
}

/**
 * 比較欄位排序可自訂：交換陣列順序後重畫。
 * 已經算好的欄位不必再跟後端要一次 —— refreshDashboard() 會依 comparisonSelections 的順序
 * 從 lastComparison 裡挑出對應的欄位(reorderComparison_)，只有新加進來、還沒算過的欄位才送後端。
 */
function moveComparisonColumn(idx, dir) {
  const target = idx + dir;
  if (target < 0 || target >= comparisonSelections.length) return;
  const tmp = comparisonSelections[idx];
  comparisonSelections[idx] = comparisonSelections[target];
  comparisonSelections[target] = tmp;
  refreshDashboard();
}

/* ---- 儀表板顯示選項（切換時只重畫，不重算；全部記在瀏覽器裡，下次打開還在） ---- */
let pctBase = 'exfactory';            // 第二小欄：'exfactory' 對廠價% / 'revenue' 對收入% / 'diff' 與基準差異 / 'diffpct' 與基準差異% / 'none'
let showPriceStructure = true;        // 是否顯示 P1~P9 售價結構
let chartLineCodes = ['A', 'K'];      // 「科目比較」圖要畫哪幾個科目
let collapsedGroups = new Set();      // 目前收合中的大項(B/E/G/I)，切換 % 基準等重畫時要保留住
let diffPairs = [];                   // 使用者自己選的差異比較組合 [{aKey, bKey}]，key 見 colKey_()
let baselineKey = '';                 // 比較基準欄位(colKey_)；空字串 = 不設定比較基準
let amountUnit = 1;                   // 金額單位：1 = 元、1000 = 千元
let volumeBasis = 'unit';             // 金額基礎：'unit' 單台 / 'year' 年度總額(×月銷量×12) / 'lc' LC 總額(×LC 總台數)
let highlightBest = false;            // 每一列標示最佳/最差的欄位
let showKpi = true;                   // 顯示重點指標卡片
let chartType = 'byLine';             // 'byLine' 科目比較(橫軸=科目) / 'byColumn' (橫軸=比較欄位) / 'structure' 損益結構 / 'waterfall' 損益瀑布
let chartValue = 'amount';            // 圖表數值：'amount' 金額 / 'pct' 百分比
let chartLabels = true;               // 圖上顯示數值標籤

const DASH_PREFS_KEY_ = 'plDashboard.prefs.v1';
function dashPrefsSnapshot_() {
  return {
    selections: comparisonSelections, diffPairs, pctBase, showPriceStructure, chartLineCodes,
    baselineKey, amountUnit, volumeBasis, highlightBest, showKpi, chartType, chartValue, chartLabels,
    dashView, collapsed: Array.from(collapsedGroups)
  };
}
function saveDashPrefs_() {
  try { localStorage.setItem(DASH_PREFS_KEY_, JSON.stringify(dashPrefsSnapshot_())); } catch (e) { /* 無痕模式等情況存不了就算了 */ }
}
function loadDashPrefs_() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(DASH_PREFS_KEY_) || 'null'); } catch (e) { p = null; }
  if (!p || typeof p !== 'object') return;
  if (Array.isArray(p.selections)) comparisonSelections = p.selections.filter(s => s && s.ScenarioID).map(s => ({ ScenarioID: String(s.ScenarioID), VehicleID: String(s.VehicleID || '') }));
  if (Array.isArray(p.diffPairs)) diffPairs = p.diffPairs.filter(d => d && d.aKey && d.bKey);
  if (['exfactory', 'revenue', 'diff', 'diffpct', 'none'].indexOf(p.pctBase) !== -1) pctBase = p.pctBase;
  if (typeof p.showPriceStructure === 'boolean') showPriceStructure = p.showPriceStructure;
  if (Array.isArray(p.chartLineCodes) && p.chartLineCodes.length) chartLineCodes = p.chartLineCodes.map(String);
  if (typeof p.baselineKey === 'string') baselineKey = p.baselineKey;
  if (p.amountUnit === 1 || p.amountUnit === 1000) amountUnit = p.amountUnit;
  if (['unit', 'year', 'lc'].indexOf(p.volumeBasis) !== -1) volumeBasis = p.volumeBasis;
  if (typeof p.highlightBest === 'boolean') highlightBest = p.highlightBest;
  if (typeof p.showKpi === 'boolean') showKpi = p.showKpi;
  if (['byLine', 'byColumn', 'structure', 'waterfall'].indexOf(p.chartType) !== -1) chartType = p.chartType;
  if (p.chartValue === 'amount' || p.chartValue === 'pct') chartValue = p.chartValue;
  if (typeof p.chartLabels === 'boolean') chartLabels = p.chartLabels;
  if (['columns', 'table', 'chart', 'diff'].indexOf(p.dashView) !== -1) dashView = p.dashView;
  if (Array.isArray(p.collapsed)) collapsedGroups = new Set(p.collapsed.map(String));
}

/** 工具列上的每一個開關都走這裡：改狀態 → 記住 → 重畫（不重算） */
function setDashOption(name, value) {
  switch (name) {
    case 'pctBase': pctBase = value; break;
    case 'showPriceStructure': showPriceStructure = !!value; break;
    case 'amountUnit': amountUnit = Number(value) === 1000 ? 1000 : 1; break;
    case 'volumeBasis': volumeBasis = value; break;
    case 'highlightBest': highlightBest = !!value; break;
    case 'showKpi': showKpi = !!value; break;
    case 'chartType': chartType = value; break;
    case 'chartValue': chartValue = value; break;
    case 'chartLabels': chartLabels = !!value; break;
    default: return;
  }
  saveDashPrefs_();
  if (lastComparison) renderDashboard(lastComparison);
}
function setPctBase(v) { setDashOption('pctBase', v); }
function setShowPriceStructure(v) { setDashOption('showPriceStructure', v); }

/**
 * 設定比較基準欄位（表格第二小欄的「與基準差異」、重點指標卡片的 vs 基準都以它為準）。
 * 比較基準不是必要的 —— 沒設定就是沒有，不會偷偷預設成第一欄；再點一次目前的基準會取消設定。
 */
function setBaselineColumn(key) {
  key = key || '';
  baselineKey = (key && key === baselineKey) ? '' : key;
  saveDashPrefs_();
  rerenderCurrentView_();
}

/** 比較欄位的唯一鍵值：情境+車系（跟 comparisonSelections 是同一組資料，只是換一種查法） */
function colKey_(col) {
  return (col.scenarioId || '') + '|' + (col.vehicleId || '');
}
/**
 * 星星按鈕改用「第幾欄」而不是把 colKey_ 直接寫進 onclick 的字串裡。
 * 車系代號是使用者自己輸入的，裡面只要有一個單引號(如 Driver's Van)就會把
 * onclick="setBaselineColumn('...')" 的 JS 字串截斷 —— 而且 esc() 也救不了：
 * HTML 屬性裡的實體(&#39;)會先被解碼、才輪到 JS 解析，等於原封不動把引號送進去。
 * 索引是程式自己產生的數字，沒有這個問題。
 */
function setBaselineColumnAt(i) {
  const col = lastComparison && (lastComparison.columns || [])[i];
  if (col) setBaselineColumn(colKey_(col));
}
function selKey_(sel) {
  return (sel.ScenarioID || '') + '|' + (sel.VehicleID || '');
}

/**
 * 重新取得比較結果。
 * force = true：整份重新跟後端算(進儀表板、按「重新計算」)。
 * 否則只把「還沒算過」的欄位送後端，算回來後併進手上的結果(mergeComparison_)；
 * 純粹調整順序或移除欄位完全不打後端。Apps Script 每一次呼叫都要一兩秒，
 * 加一欄就把全部欄位重算一次，欄位一多會越加越慢。
 */
let dashRequestSeq_ = 0;
function refreshDashboard(force) {
  if (!comparisonOptions.length) { loadComparisonPicker(); return; }
  saveDashPrefs_();
  if (!comparisonSelections.length) {
    lastComparison = { columns: [], lines: [] };
    setDashStatus_('');
    renderDashboard(lastComparison);
    return;
  }
  const known = (!force && lastComparison) ? (lastComparison.columns || []) : [];
  const missing = comparisonSelections.filter(sel => !known.some(c => colKey_(c) === selKey_(sel)));
  if (!missing.length) {
    lastComparison = reorderComparison_(lastComparison, comparisonSelections);
    renderDashboard(lastComparison);
    return;
  }
  const seq = ++dashRequestSeq_;
  if (force || !lastComparison) setDashViewHtml_('<p class="muted">計算中...</p>');
  setDashStatus_(force ? '計算中…' : `計算新增的 ${missing.length} 個欄位…`);
  google.script.run
    .withSuccessHandler(safeHandler(result => {
      // 比這次更晚送出的請求已經在路上了，舊的結果一律丟掉(不分整份重算或只算新增欄位)：
      // 較新的那次請求的 missing 是照「目前手上已經有哪幾欄」算出來的，一定涵蓋舊請求要算的欄位，
      // 丟掉不會少算，反而是讓晚回來的舊結果蓋回去才會把新資料改回舊數字。
      if (seq !== dashRequestSeq_) return;
      setDashStatus_('');
      lastComparison = force ? result : mergeComparison_(lastComparison, result);
      lastComparison = reorderComparison_(lastComparison, comparisonSelections);
      renderDashboard(lastComparison);
    }))
    .withFailureHandler(err => {
      if (seq !== dashRequestSeq_) return;
      setDashStatus_('');
      // 只換子頁籤的內容，不能把整個 dashboard-content 洗掉 —— 子頁籤列跟「重新計算」都在裡面，
      // 洗掉之後使用者就沒有任何入口可以去「比較欄位」把算不出來的那一欄移除了
      // (比較欄位記在 localStorage，重新整理也還在，等於整個儀表板從此打不開)。
      setDashViewHtml_('<p class="status-msg err">計算失敗：' + esc(err && err.message ? err.message : err) +
        '</p><p class="muted">請切到「比較欄位」把算不出來的那一欄移除或改選（例如該車系在這個情境沒有銷售構成資料）。</p>');
    })
    .calculateComparison(force ? comparisonSelections : missing);
}
function setDashStatus_(text) {
  const el = document.getElementById('dash-status');
  if (el) el.textContent = text || '';
}

/** 只換子頁籤的內容區；外框(子頁籤列)還沒畫過就先補畫一次，之後一律只動內容 */
function setDashViewHtml_(html) {
  const view = document.getElementById('dash-view');
  if (view) { view.innerHTML = html; return; }
  const content = document.getElementById('dashboard-content');
  if (content) content.innerHTML = `${dashSubNavHtml((lastComparison && lastComparison.columns) || [])}<div id="dash-view">${html}</div>`;
}

/** 把後端新算回來的欄位併進手上的結果：同鍵值的欄位以新的為準，科目取聯集後照呈現順序排(同 Excel：扣減型小計在明細下面) */
function mergeComparison_(base, add) {
  if (!base) return add;
  const cols = (base.columns || []).slice();
  (add.columns || []).forEach(c => {
    const at = cols.findIndex(x => colKey_(x) === colKey_(c));
    if (at === -1) cols.push(c); else cols[at] = c;
  });
  const lines = (base.lines || []).slice();
  (add.lines || []).forEach(l => { if (!lines.some(x => x.LineCode === l.LineCode)) lines.push(l); });
  return Object.assign({}, base, { columns: cols, lines: displayOrderLines_(lines) });
}

/** 依目前的比較欄位順序挑出對應的欄位；沒有任何欄位有數字的科目不再列出(跟後端的規則一致) */
function reorderComparison_(result, selections) {
  if (!result) return result;
  const cols = selections.map(sel => (result.columns || []).find(c => colKey_(c) === selKey_(sel))).filter(c => c);
  const lines = (result.lines || []).filter(l => cols.some(c => c.amounts[l.LineCode] !== undefined && c.amounts[l.LineCode] !== null));
  return Object.assign({}, result, { columns: cols, lines: lines });
}

/**
 * 儀表板拆成四個子頁籤，一次只專心看一件事，不再把建構欄位/損益表/圖表/差異比較全部疊在同一頁：
 *   比較欄位 — 加入/調整要比較的車型×情境×車系
 *   損益表   — 主表格 + 重點指標卡片 + 小計驗算
 *   圖表     — 四種柱狀圖
 *   差異比較 — 使用者自選兩欄的差異卡片
 * 子頁籤本身也記在瀏覽器裡，下次打開還在同一頁。
 */
function renderDashboard(result) {
  const content = document.getElementById('dashboard-content');
  const cols = (result && result.columns) || [];
  const lines = (result && result.lines) || [];

  // 重畫會把整個內容換掉：正在顯示的提示要收掉、表格的橫向捲動位置要留住
  hideTooltip_();
  const oldScroller = content.querySelector('.grid-scroll');
  const scrollLeft = oldScroller && oldScroller.scrollLeft ? oldScroller.scrollLeft : 0;

  content.innerHTML = `${dashSubNavHtml(cols)}<div id="dash-view">${dashViewHtml_(cols, lines)}</div>`;
  const scroller = content.querySelector('.grid-scroll');
  if (scroller && scrollLeft) scroller.scrollLeft = scrollLeft;
  installTableCrosshair_(content);
  installBuilderSortable_();
}

/** 比較欄位表：拖曳放開就照新順序重排(不打後端，已算好的欄位直接重排) */
function installBuilderSortable_() {
  makeSortable(document.getElementById('builder-rows'), {
    items: 'tr[data-key]',
    onEnd: keys => {
      const old = comparisonSelections;
      comparisonSelections = keys.map(k => old[Number(k)]);
      refreshDashboard();
    }
  });
}

/** 沒有 lastComparison(還沒算過、或選過又清空)時也能安全重畫目前這一頁 */
function rerenderCurrentView_() {
  renderDashboard(lastComparison || { columns: [], lines: [] });
}

function dashSubNavHtml(cols) {
  const tabs = [
    ['columns', '比較欄位' + (cols.length ? `（${cols.length}）` : '')],
    ['table', '損益表'],
    ['chart', '圖表'],
    ['diff', '差異比較']
  ];
  return `
    <div class="dash-subnav">
      ${tabs.map(([key, label]) => `<button type="button" class="dash-subnav-btn${dashView === key ? ' active' : ''}"
          onclick="setDashView('${key}')">${esc(label)}</button>`).join('')}
      <span class="dash-subnav-status" id="dash-status"></span>
      <button type="button" class="btn secondary dash-subnav-refresh" onclick="refreshDashboard(true)"
        data-tip="整份重新跟後端計算（平常加入欄位只算新加的那幾欄）">重新計算</button>
    </div>`;
}
function setDashView(key) {
  dashView = key;
  saveDashPrefs_();
  rerenderCurrentView_();
}

function dashViewHtml_(cols, lines) {
  if (dashView === 'columns') return comparisonBuilderHtml_();
  if (!cols.length) return '<p class="muted">請先切到「比較欄位」加入至少一個比較欄位。</p>';
  if (dashView === 'chart') return chartSectionHtml(cols, lines);
  if (dashView === 'diff') return diffSectionHtml_(cols, lines);
  return tableViewHtml_(cols, lines);
}

function tableViewHtml_(cols, lines) {
  return `
    ${dashboardToolbarHtml(cols)}
    ${subtotalCheckHtml(cols)}
    ${kpiStripHtml(cols, lines)}
    <div id="csv-output" style="display:none;"></div>
    <div class="table-meta">${tableMetaText_(cols)}</div>
    <div class="grid-scroll" id="pl-table-wrap">${plTableHtml(cols, lines)}</div>
  `;
}

/** 只重畫損益表本體（收合大項用）：卡片不動，表格的捲動位置也不動 */
function rerenderTable_() {
  if (!lastComparison) return;
  const wrap = document.getElementById('pl-table-wrap');
  if (!wrap) { rerenderCurrentView_(); return; }
  hideTooltip_();
  wrap.innerHTML = plTableHtml(lastComparison.columns || [], lastComparison.lines || []);
}

/* ---- 金額的顯示口徑：單位(元/千元) × 基礎(單台/年度/LC 總額) ---- */
function basisFactor_(col) {
  const v = (col && col.volume) || {};
  if (volumeBasis === 'year') return (Number(v.monthlyVolume) || 0) * 12;
  if (volumeBasis === 'lc') return Number(v.units) || 0;
  return 1;
}
/** 表格/圖表/卡片一律用這個把後端的單台金額換成畫面上要顯示的數字 */
function displayAmount_(v, col) {
  return Number(v) * basisFactor_(col) / amountUnit;
}
function unitLabel_() { return amountUnit === 1000 ? '千元' : '元'; }
function basisLabel_() {
  return volumeBasis === 'year' ? '年度總額' : volumeBasis === 'lc' ? 'LC 總額' : '單台';
}
function basisFormula_(col) {
  const v = (col && col.volume) || {};
  if (volumeBasis === 'year') return `單台 × 月銷量 ${fmt(v.monthlyVolume)} 台 × 12`;
  if (volumeBasis === 'lc') return `單台 × LC 總台數 ${fmt(v.units)} 台`;
  return '';
}
function pctBaseOf_(col) {
  return pctBase === 'revenue' ? Number(col.revenue) : Number(col.exFactoryPrice);
}
function pctBaseName_() {
  return pctBase === 'revenue' ? '對收入' : '對廠價';
}
/**
 * 帶正負號的差異顯示：+1,234 / -1,234。
 * 四捨五入到指定小數位後如果變成 0、但其實不是真的 0(常見於「千元」單位下差幾百元)，
 * 就多留幾位小數，最多到 3 位 —— 不然使用者會看到一排「vs 基準 +0」，
 * 以為這個功能沒作用，其實只是差異被四捨五入蓋掉了。
 */
function signed_(v, digits) {
  const n = Number(v) || 0;
  if (n === 0) return '0';
  let d = digits === undefined ? 0 : digits;
  const maxD = d + 3;
  while (d < maxD && Number(n.toFixed(d)) === 0) d++;
  return (n > 0 ? '+' : '') + fmt(n, d);
}
function tableMetaText_(cols) {
  const parts = [`金額單位：${unitLabel_()}`, `基礎：${basisLabel_()}`];
  if (pctBase === 'exfactory' || pctBase === 'revenue') parts.push(`第二欄：${pctBaseName_()}%`);
  if (pctBase === 'diff' || pctBase === 'diffpct') {
    const b = baselineCol_(cols);
    parts.push(b
      ? `第二欄：與基準（${b.label}）的${pctBase === 'diffpct' ? '差異%' : '差異'}`
      : '尚未設定比較基準，第二欄先顯示「—」（用上面的「比較基準」下拉選單或欄位標題的 ☆ 設定）');
  }
  if (highlightBest && cols.length > 1) parts.push('▲ 該列最佳　▼ 該列最差');
  return parts.map(esc).join('　・　');
}

/**
 * 這個科目「越高越好」還是「越低越好」：收入/毛利/淨利越高越好，成本與費用越低越好。
 * 表格的最佳/最差標示、與基準差異的顏色、差異柱狀圖的紅綠都用這一個判斷，口徑一致。
 * 售價結構(P1~P9)沒有好壞可言，回傳 null。
 */
function lineBetter_(line) {
  if (!line || line.isPriceStructure) return null;
  if (['A', 'C', 'E', 'G', 'I', 'K'].indexOf(line.LineCode) !== -1) return 'high';
  if (line.ParentLine === 'A') return 'high';
  if (line.ParentLine || line.LineCode === 'B' || line.LineCode === 'J') return 'low';
  return null;
}
/** 差異是好是壞：'good' / 'bad' / ''（沒有方向或沒有差異） */
function deltaTone_(line, delta) {
  const better = lineBetter_(line);
  if (!better || !delta) return '';
  return (delta > 0) === (better === 'high') ? 'good' : 'bad';
}

/** 目前的比較基準欄位；不一定要設，沒設定就回傳 null(不會偷偷預設成第一欄) */
function baselineCol_(cols) {
  if (!baselineKey) return null;
  return (cols || []).find(c => colKey_(c) === baselineKey) || null;
}

function dashboardToolbarHtml(cols) {
  cols = cols || [];
  const opt = (v, text, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${text}</option>`;
  const chk = (name, checked, text, tip) =>
    `<label class="chk"${tip ? ` data-tip="${esc(tip)}"` : ''}><input type="checkbox"${checked ? ' checked' : ''}
       onchange="setDashOption('${name}', this.checked)">${text}</label>`;
  return `
    <div class="toolbar dash-toolbar">
      <label>第二小欄
        <select onchange="setDashOption('pctBase', this.value)">
          ${opt('exfactory', '對廠價(未稅)%', pctBase)}
          ${opt('revenue', '對收入(未稅,含強配)%', pctBase)}
          ${opt('diff', '與基準的差異', pctBase)}
          ${opt('diffpct', '與基準的差異%', pctBase)}
          ${opt('none', '不顯示', pctBase)}
        </select>
      </label>
      <label data-tip="哪一欄要當作比較的基準；不設定也可以，只是就看不到「與基準的差異」跟卡片的 vs 基準。&#10;也可以直接點欄位標題或重點指標卡片上的 ☆。">比較基準
        <select onchange="setBaselineColumn(this.value)">
          <option value=""${!baselineKey ? ' selected' : ''}>(不設定)</option>
          ${cols.map(c => `<option value="${esc(colKey_(c))}"${colKey_(c) === baselineKey ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
        </select>
      </label>
      <label>金額單位
        <select onchange="setDashOption('amountUnit', this.value)">
          ${opt('1', '元', String(amountUnit))}
          ${opt('1000', '千元', String(amountUnit))}
        </select>
      </label>
      <label data-tip="單台：損益表原本的口徑&#10;年度總額：單台 × 月銷量 × 12&#10;LC 總額：單台 × LC 總台數（月銷量 × 12 × LC 年限）&#10;百分比不受影響">金額基礎
        <select onchange="setDashOption('volumeBasis', this.value)">
          ${opt('unit', '單台', volumeBasis)}
          ${opt('year', '年度總額', volumeBasis)}
          ${opt('lc', 'LC 總額', volumeBasis)}
        </select>
      </label>
      <span class="toolbar-sep"></span>
      ${chk('showKpi', showKpi, '重點指標')}
      ${chk('showPriceStructure', showPriceStructure, '售價結構(P1~P9)')}
      ${chk('highlightBest', highlightBest, '標示最佳/最差', '每一列把數字最好的欄位標 ▲、最差的標 ▼：收入/毛利/淨利越高越好，成本/費用越低越好')}
      <span class="toolbar-sep"></span>
      <button type="button" class="btn secondary" onclick="toggleAllGroups()">全部收合/展開大項</button>
      <button type="button" class="btn secondary" onclick="showComparisonCsv()">匯出 CSV</button>
    </div>`;
}

/**
 * 重點指標卡片：每個比較欄位一張，一眼看到營業淨利與各段毛利率，不必在整張損益表裡找小計列。
 * 卡片上的 vs 基準差異跟表格的「與基準差異」是同一個基準欄位。
 */
function kpiStripHtml(cols, lines) {
  if (!showKpi || !cols.length) return '';
  const nameOf = code => { const l = lines.find(x => x.LineCode === code); return l ? shortLineName(l.LineName) : code; };
  const base = baselineCol_(cols);
  const kLine = lines.find(l => l.LineCode === 'K');
  const maxAbsPct = Math.max.apply(null, cols.map(c => Math.abs(pctOf_(c, 'K'))).concat([0.0001]));
  const cards = cols.map((c, i) => {
    const k = c.amounts.K;
    const kPct = pctOf_(c, 'K');
    const isBase = base && colKey_(base) === colKey_(c);
    const rows = ['A', 'C', 'E', 'G'].map(code => {
      const v = c.amounts[code];
      if (v === undefined || v === null) return '';
      return `<div class="kpi-row"><span>${esc(nameOf(code))}</span>
        <span class="kpi-num${v < 0 ? ' negative' : ''}">${fmt(displayAmount_(v, c))}</span>
        <span class="kpi-pct">${code === 'A' ? '' : pctOf_(c, code).toFixed(1) + '%'}</span></div>`;
    }).join('');
    let vsBase = '';
    if (base && !isBase && k !== undefined && k !== null && base.amounts.K !== undefined && base.amounts.K !== null) {
      const baseShown = displayAmount_(base.amounts.K, base);
      const delta = displayAmount_(k, c) - baseShown;
      const tone = deltaTone_(kLine, delta);
      // 百分比的分母要用畫面上實際顯示的基準金額：基準欄的月銷量/總台數是 0 時，
      // 單台金額不是 0、但年度/LC 總額會是 0，用原始單台金額當判斷就會除以 0 印出 ∞%
      vsBase = `<div class="kpi-vs ${tone}">vs 基準 ${signed_(delta)}${baseShown ? `（${signed_(delta / Math.abs(baseShown) * 100, 1)}%）` : ''}</div>`;
    } else if (isBase) {
      vsBase = '<div class="kpi-vs muted">比較基準</div>';
    }
    const barW = Math.min(100, Math.abs(kPct) / maxAbsPct * 100);
    return `<div class="kpi-card${isBase ? ' baseline' : ''}" data-c="${i}" data-tipfn="col">
      <div class="kpi-title"><span class="kpi-type" title="${esc([c.vehicleTypeLabel, c.scenarioLabel].filter(p => p).join(' / '))}">${esc([c.vehicleTypeLabel, c.scenarioLabel].filter(p => p).join(' / '))}</span>
        <span class="kpi-vehicle" title="${esc(c.vehicleLabel)}">${esc(c.vehicleLabel)}</span>
        <button type="button" class="star${isBase ? ' on' : ''}" data-tip="${isBase ? '目前的比較基準（再點一次取消）' : '設為比較基準'}"
          onclick="setBaselineColumnAt(${i})">★</button></div>
      <div class="kpi-main"><span class="kpi-main-label">${esc(nameOf('K'))}</span>
        <span class="kpi-main-num${k < 0 ? ' negative' : ''}">${k === undefined || k === null ? '—' : fmt(displayAmount_(k, c))}</span>
        <span class="kpi-main-pct${kPct < 0 ? ' negative' : ''}">${kPct.toFixed(1)}%</span></div>
      <div class="kpi-bar"><div class="kpi-bar-fill${kPct < 0 ? ' negative' : ''}" style="width:${barW.toFixed(1)}%"></div></div>
      ${rows}${vsBase}
    </div>`;
  }).join('');
  return `<div class="kpi-strip">${cards}</div>`;
}
/** 某科目對目前 % 基準的百分比（基準為 0 時回 0） */
function pctOf_(col, code) {
  const base = pctBaseOf_(col) || Number(col.exFactoryPrice) || Number(col.revenue);
  const v = Number(col.amounts[code]);
  return base && !isNaN(v) ? v / base * 100 : 0;
}

/**
 * 差異比較挑選器：使用者自己選「比較基準」跟「比較對象」兩個欄位，按「加入差異比較」
 * 才會產生一組差異卡片(可以同時加好幾組，如「現況 vs 目標」再加一組「A情境 vs B情境」)。
 * 不像原本自動兩兩相減整排欄位、被迫照順序來 —— 使用者要比哪兩欄就直接選那兩欄。
 */
function diffPairPickerHtml(cols) {
  if (cols.length < 2) return '<p class="muted">差異比較至少要有兩個比較欄位。</p>';
  const options = cols.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('');
  const chips = diffPairs.map((p, i) => {
    const a = cols.find(c => colKey_(c) === p.aKey);
    const b = cols.find(c => colKey_(c) === p.bKey);
    if (!a || !b) return '';
    return `<span class="cmp-chip">
      <span class="chip-label">${esc(a.label)} <span class="diff-arrow">→</span> ${esc(b.label)}</span>
      <button type="button" class="btn danger" onclick="removeDiffPair(${i})">✕</button></span>`;
  }).join('');
  return `
    <div class="toolbar">
      <label>比較基準
        <select id="diff-a-select">${options}</select>
      </label>
      <label>比較對象
        <select id="diff-b-select">${cols.map((c, i) => `<option value="${i}"${i === 1 ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
      </label>
      <button type="button" class="btn secondary" onclick="addDiffPair()">加入差異比較</button>
    </div>
    ${diffPairs.length ? `<div class="toolbar">${chips}
      <button type="button" class="btn secondary" onclick="clearDiffPairs()">全部清除</button></div>` : ''}`;
}

function addDiffPair() {
  if (!lastComparison) return;
  const cols = lastComparison.columns || [];
  const aIdx = Number(val('diff-a-select'));
  const bIdx = Number(val('diff-b-select'));
  if (isNaN(aIdx) || isNaN(bIdx) || aIdx === bIdx || !cols[aIdx] || !cols[bIdx]) return;
  const aKey = colKey_(cols[aIdx]), bKey = colKey_(cols[bIdx]);
  if (diffPairs.some(p => p.aKey === aKey && p.bKey === bKey)) return;
  diffPairs.push({ aKey: aKey, bKey: bKey });
  saveDashPrefs_();
  renderDashboard(lastComparison);
}
function removeDiffPair(i) { diffPairs.splice(i, 1); saveDashPrefs_(); renderDashboard(lastComparison); }
function clearDiffPairs() { diffPairs = []; saveDashPrefs_(); renderDashboard(lastComparison); }

/** 差異卡片與差異柱狀圖共用的關鍵科目：收入 + 各段小計/毛利/淨利 */
function keyLines_(lines) {
  return lines.filter(l => !l.isPriceStructure && (l.isSubtotal || l.LineCode === 'A'));
}

/**
 * 情境差異卡片：只算使用者自己選過的組合(diffPairs)，只挑小計/毛利/淨利等關鍵科目，
 * 避免每個明細都列出來反而看不出重點。每張卡下面附一個差異柱狀圖，
 * 綠色 = 往好的方向變(成本降、利潤升)、紅色 = 往壞的方向變。
 */
function diffSectionHtml_(cols, lines) {
  const picker = diffPairPickerHtml(cols);
  if (!diffPairs.length) {
    return `<div class="diff-section">${picker}
      <p class="muted">選好要比較的兩個欄位後按「加入差異比較」，下面會列出金額/百分比差異與差異柱狀圖。</p></div>`;
  }
  const keyLines = keyLines_(lines);
  const cards = diffPairs.map((pair, i) => {
    const a = cols.find(c => colKey_(c) === pair.aKey);
    const b = cols.find(c => colKey_(c) === pair.bKey);
    if (!a || !b) return '';
    const rows = keyLines.map(l => {
      const va = a.amounts[l.LineCode], vb = b.amounts[l.LineCode];
      if (va === undefined || va === null || vb === undefined || vb === null) return '';
      const da = displayAmount_(va, a), db = displayAmount_(vb, b);
      const delta = db - da;
      const pct = da ? (delta / Math.abs(da) * 100) : null;
      const tone = deltaTone_(l, delta);
      return `<tr class="${l.isSubtotal ? 'subtotal' : ''}">
        <td class="row-head">${esc(shortLineName(l.LineName))}</td>
        <td class="${da < 0 ? 'negative' : ''}">${fmt(da)}</td><td class="${db < 0 ? 'negative' : ''}">${fmt(db)}</td>
        <td class="delta ${tone}">${signed_(delta)}</td>
        <td class="delta ${tone}">${pct === null ? '—' : signed_(pct, 1) + '%'}</td>
      </tr>`;
    }).join('');
    return `<div class="diff-card">
      <div class="diff-card-title">${esc(a.label)} <span class="diff-arrow">→</span> ${esc(b.label)}
        <span class="muted">（${esc(unitLabel_())}・${esc(basisLabel_())}）</span></div>
      <table class="grid-table diff-table">
        <thead><tr><th>項目</th><th>${esc(a.vehicleLabel || a.label)}</th><th>${esc(b.vehicleLabel || b.label)}</th><th>差異</th><th>差異%</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="chart-box diff-chart-box">${diffChartSvg_(a, b, keyLines)}</div>
    </div>`;
  }).join('');
  return `<div class="diff-section">${picker}<div class="diff-cards-row">${cards}</div></div>`;
}

/** 每組差異比較底下的柱狀圖：關鍵科目的差異金額(b-a)，跟差異卡片的表格是同一組數字 */
function diffChartSvg_(a, b, keyLines) {
  const groups = [], bars = [];
  keyLines.forEach(l => {
    const va = a.amounts[l.LineCode], vb = b.amounts[l.LineCode];
    if (va === undefined || va === null || vb === undefined || vb === null) return;
    const da = displayAmount_(va, a), db = displayAmount_(vb, b);
    const delta = db - da;
    const tone = deltaTone_(l, delta);
    const g = groups.length;
    groups.push({ label: shortLineName(l.LineName) });
    bars.push({
      g: g, s: 0, y0: 0, y1: delta,
      color: tone === 'good' ? '#2f855a' : tone === 'bad' ? '#e53e3e' : '#718096',
      tip: `${shortLineName(l.LineName)}\n${a.label}：${fmt(da)}\n${b.label}：${fmt(db)}\n差異：${signed_(delta)}${da ? `（${signed_(delta / Math.abs(da) * 100, 1)}%）` : ''}${tone === 'good' ? '\n✔ 往好的方向' : tone === 'bad' ? '\n✘ 往壞的方向' : ''}`
    });
  });
  return svgBarChart_({ groups, series: [{ name: '差異' }], bars, width: 640, height: 240, showLabels: chartLabels, valueFormat: shortAmount_ });
}
