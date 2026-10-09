/* ---------------------------------------------------------------
 * 前端分成兩種頁面：
 *   1. ENTITIES  — 單純的主檔維護(車型/車系/情境)，沿用「表單 + 列表」通用元件，三個表格放在同一頁「車型與情境」。
 *   2. 表格編輯頁 — 銷售構成、銷貨成本、營業費用、開發總投、參數與比率(含匯率)，
 *      改成一次看到全部、直接在格子裡改、最後按一次「儲存」的表格式介面。
 * ------------------------------------------------------------- */
const GATE_OPTIONS = ['GATE F', 'GATE E', 'GATE D', 'GATE C', 'GATE B', 'GATE A', 'GATE Z'];
const SCENARIO_TYPES = ['現況', '目標'];
// 結構科目與自動計算科目不能刪、父科目也不能改，否則損益鏈會接錯段（後端也會擋，這裡只是不畫按鈕）
const PROTECTED_LINE_CODES = ['A', 'B', 'C', 'E', 'G', 'I', 'K'];
/** 營業淨利是哪個科目：後端在比較欄位/報告/科目表上附 profitCode(預設 K；K 被刪掉時是損益表最後一行總計) */
function profitCodeOf_(obj) { return (obj && obj.profitCode) || 'K'; }
const PL_LINE_PARENT_OPTIONS = [
  ['B', 'B 銷貨成本'],
  ['E', 'E 銷售費用(銷貨毛利前)'],
  ['G', 'G 產品貢獻前費用'],
  ['I', 'I 固定營業費用']
];
const LINE_PARENT_OPTIONS = [['', '(結構科目，不可改)']].concat(PL_LINE_PARENT_OPTIONS);
// 開發總投填寫流程：部門 -> 設備/模具/費用大類 -> 實際攤提落點。大類只是用來分組/篩選
// 攤提落點選單，避免自己新增的攤提落點越加越多之後全部混在同一個下拉選單裡不好找。
const DEV_AMORT_CATEGORIES = ['設備', '模具', '費用'];
// 建立新情境時可以整批帶入的資料類別
const SCENARIO_COPY_PARTS = [
  { key: 'salesmix', label: '銷售構成' },
  { key: 'costofsales', label: '銷貨成本' },
  { key: 'devinvestment', label: '開發總投' },
  { key: 'operatingexpense', label: '營業費用' },
  { key: 'parameters', label: '費率/匯率' },
  { key: 'linenotes', label: '報告說明' },
  { key: 'actions', label: '改善作法' }
];

const ENTITIES = {
  vehicletypes: {
    label: '車型主檔', pk: 'VehicleTypeID',
    getFn: 'getVehicleTypes', saveGridFn: 'saveVehicleTypeGrid', deleteFn: 'deleteVehicleType',
    renameFn: 'renameVehicleType', scopedBy: null, createUi: 'vehicleType',
    intro: '車型是最上層的單位。<b>每個車型各自有一份科目表</b>（科目在不同車型間差異很大，各自調整互不影響），建立車型時可以選擇從標準範本或從既有車型複製。',
    columns: [
      { name: 'VehicleTypeID', label: '車型代號', lockAfterCreate: true, width: 140 },
      { name: 'Notes', label: '備註', width: 420 }
    ]
  },
  vehicles: {
    label: '車系設定', pk: 'VehicleID',
    getFn: 'getVehicles', saveGridFn: 'saveVehicleGrid', deleteFn: 'deleteVehicle',
    renameFn: 'renameVehicle', scopedBy: 'vehicleType', sortable: 'setVehicleOrder',
    intro: '車系是車型底下的細車型（如 標準型、豪華型、長軸版）。拖曳 ⠿ 調整順序，放開就生效 —— 所有頁面的車系欄位都照這個順序排。',
    columns: [
      { name: 'VehicleID', label: '車系代號', lockAfterCreate: true, width: 140 },
      { name: 'VehicleCode', label: '車系名稱', width: 240 },
      { name: 'Notes', label: '備註', width: 360 }
    ]
  },
  scenarios: {
    label: '情境設定', pk: 'ScenarioID',
    getFn: 'getScenarios', saveGridFn: 'saveScenarioGrid', deleteFn: 'deleteScenario',
    scopedBy: 'vehicleType', createUi: 'scenario', sortable: 'setScenarioOrder',
    intro: '同一個 GATE 底下可以有多個情境（現況 / 目標，例如上一次審議的目標就是 GATE 報告裡的「前回」）。目標情境才有挑戰低減目標；新情境可以整批帶入既有情境的資料再調整。拖曳 ⠿ 調整情境選單的順序。',
    columns: [
      { name: 'Gate', label: 'GATE 別', type: 'select', options: GATE_OPTIONS, width: 110 },
      { name: 'ScenarioName', label: '情境名稱', width: 200 },
      { name: 'ScenarioType', label: '情境性質', type: 'select', options: SCENARIO_TYPES, width: 90 },
      { name: 'CreatedDate', label: '建立日期', type: 'date', width: 140 },
      { name: 'Notes', label: '備註', width: 300 }
    ]
  }
};

/** 結構科目或自動計算科目：父科目固定、名稱不可改 */
function isFixedLineItem(row) {
  return PROTECTED_LINE_CODES.indexOf(row.LineCode) !== -1 || !!row.AutoSource;
}
/**
 * DEV_AMORT 是使用者自己在「開發總投」頁面新增的攤提落點，跟其他內建的自動計算科目
 * (售價結構、貨物稅、季Margin、模具/設備/CMC/BASE廠開發費攤提)不一樣：那些是程式定義、
 * 名稱代表固定公式；DEV_AMORT 是使用者自訂的科目，理當跟其他手動科目一樣可以刪除
 * （後端 deletePLLineItem 仍會擋住「還有開發總投資料指到這裡」的情況，不會憑空弄丟資料）。
 */
function isDeletableAutoLineItem(row) {
  return row.AutoSource === 'DEV_AMORT';
}

// 表格編輯頁：key -> 渲染函式名稱
const GRID_PANELS = {
  salesmix: 'renderSalesMixPanel',
  costs: 'renderCostsPanel',          // 銷貨成本 / 營業費用 兩個子頁籤
  devinvestment: 'renderDevInvestmentPanel',
  paramrates: 'renderRatePanel'      // 匯率(renderFxPanel)畫在同一頁下半部
};

let currentVehicleTypeId = '';
let currentScenarioId = '';
let currentScenario = null;      // 目前情境的完整資料(含 Gate / ScenarioType)
let scenarioCache = [];
let currentTab = 'masters';

/**
 * 表格編輯頁的資料快取：切分頁很常常常是「切回剛剛看過的那頁」，
 * 每次都重新跟後端要資料會讓畫面先空白一下才畫出來，感覺卡頓。
 * 有快取就先用快取立刻畫出來，同時仍照常在背景重新取一次最新資料、拿到後才重畫，
 * 兩次畫面之間使用者已經看得到內容，不再面對空白等待。
 */
const panelDataCache_ = {};
/**
 * scope 決定這個快取鍵要不要跟著車型/情境變動：
 * 'none' 兩者都跟資料無關（如車型主檔、科目設定 —— 全系統共用一份）、
 * 'vehicleType' 只跟車型有關（如車系設定 —— 情境換了不影響）、
 * 'scenario' 只跟情境有關（如開發總投 —— 車型換了情境也會跟著清空，不必重複區分）、
 * 省略或 'both' 則兩者都要區分（如銷售構成、銷貨成本）。
 * 沒分清楚的話，資料明明沒變，換一下情境或車型就會讓不相關頁面的快取失效，
 * 切回去時又要空等一次伺服器回應，感覺像整頁重新載入。
 */
function panelCacheKey_(prefix, scope) {
  const vt = (scope === 'none' || scope === 'scenario') ? '' : currentVehicleTypeId;
  const sc = (scope === 'none' || scope === 'vehicleType') ? '' : currentScenarioId;
  return prefix + '::' + vt + '::' + sc;
}
// 靜默模式：初始化(或切換車型)時會連續設定車型/情境，每一步都重繪會造成
// 同一個分頁被畫三、四次、也重複打伺服器。開啟後只更新狀態不渲染，最後統一渲染一次。
let silent = false;

/* ---------------- 共用工具 ---------------- */
/** 扣減型小計(公式「X − CHILDREN()」，例：銷貨毛利)：跟 Excel 一樣排在明細下面 */
function isFooterGroupLine_(l) {
  return !!l && /-\s*CHILDREN\s*\(\s*\)/i.test(String(l.Formula || ''));
}
/** 科目呈現順序(跟後端 displayOrderDefs_ 同一套規則)：同層依 SortOrder；一般群組列在明細上面，扣減型小計列在明細下面 */
function displayOrderLines_(lines) {
  const sorted = (lines || []).slice().sort((a, b) => (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0));
  const codes = {};
  sorted.forEach(l => { codes[l.LineCode] = true; });
  const kids = {};
  sorted.forEach(l => { const p = l.ParentLine && l.ParentLine !== l.LineCode && codes[l.ParentLine] ? l.ParentLine : ''; (kids[p] = kids[p] || []).push(l); });
  const out = [], seen = {};
  const emit = l => {
    if (seen[l.LineCode]) return;
    seen[l.LineCode] = true;
    const children = kids[l.LineCode] || [];
    if (children.length && isFooterGroupLine_(l)) { children.forEach(emit); out.push(l); }
    else { out.push(l); children.forEach(emit); }
  };
  (kids[''] || []).forEach(emit);
  sorted.forEach(l => { if (!seen[l.LineCode]) { seen[l.LineCode] = true; out.push(l); } });
  return out;
}
function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function fmt(v, digits) {
  if (v === '' || v === null || v === undefined) return '';
  const d = digits === undefined ? 0 : digits;
  const n = Number(v);
  // 四捨五入後是 0 的負數(如 -0.3)不要顯示成「-0」
  if (Math.abs(n) < 0.5 * Math.pow(10, -d)) return '0';
  return n.toLocaleString(undefined, { maximumFractionDigits: d });
}
/** 百分比取一位小數：-0.04% 四捨五入是 0，不要顯示成「-0.0」 */
function pct1_(v) {
  const r = Math.round((Number(v) || 0) * 10) / 10;
  return (r === 0 ? 0 : r).toFixed(1);
}
/**
 * 金額單位：全系統共用一個設定(儀表板、GATE 報告、瀑布圖工具、目標反推的瀑布圖)，任何一頁改了，其他頁下次打開就跟著變。
 * 以前每頁各記一份，常常儀表板看千元、報告還是元。
 */
const AMOUNT_UNIT_KEY_ = 'plApp.amountUnit.v1';
const AMOUNT_UNITS_ = [[1, '元'], [1000, '千元'], [10000, '萬元']];
function normAmountUnit_(u) { u = Number(u); return u === 1000 || u === 10000 ? u : 1; }
function loadAmountUnit_(fallback) {
  try {
    const raw = localStorage.getItem(AMOUNT_UNIT_KEY_);
    if (raw !== null && raw !== '') return normAmountUnit_(raw);
  } catch (e) { /* 存不了就用各頁原本的值 */ }
  return normAmountUnit_(fallback);
}
function saveAmountUnit_(u) {
  try { localStorage.setItem(AMOUNT_UNIT_KEY_, String(normAmountUnit_(u))); } catch (e) { /* 無痕模式等情況存不了就算了 */ }
}
function amountUnitText_(u) { u = normAmountUnit_(u); return u === 1000 ? '千元' : u === 10000 ? '萬元' : '元'; }
function amountUnitDigits_(u) { return normAmountUnit_(u) === 1 ? 0 : 1; }
/** 科目名稱/備註等使用者輸入會被塞進 HTML，& < > " 都要轉義，否則表格會被破壞 */
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** 放進 onclick 等屬性裡當 JS 字串參數：HTML 會先把 &#39; 解回 '，光用 esc() 包在 '...' 裡擋不住引號，要先變成 JS 字串字面值再轉義 */
function jsArg(s) { return esc(JSON.stringify(String(s === undefined || s === null ? '' : s))); }
function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }

function showGlobalError(err) {
  const box = document.getElementById('global-error');
  const msg = '發生錯誤：' + (err && err.message ? err.message : err);
  console.error(err);
  if (!box) return;
  box.textContent = msg;
  box.style.display = 'block';
}
function clearGlobalError() {
  const box = document.getElementById('global-error');
  if (box) box.style.display = 'none';
}
/** 包住 success handler：伺服器呼叫成功後前端渲染若丟例外，也要顯示在畫面上 */
function safeHandler(fn) {
  return function () {
    try { clearGlobalError(); return fn.apply(null, arguments); }
    catch (e) { showGlobalError(e); }
  };
}
/** 狀態訊息：處理中的文字留在頁面上；成功/失敗另外跳 toast(看得到又不會一直佔位置) */
function setStatus(key, text, cls) {
  const el = document.getElementById('status-' + key);
  if (el) {
    el.textContent = cls ? '' : text;
    el.className = 'status-msg';
  }
  if (cls === 'ok') toast(text, 'ok');
  else if (cls === 'err') toast(String(text).replace(/^錯誤：/, ''), 'err');
}
/** 表格編輯頁的共用外框：標題 + 工具列 + 狀態 + 內容 */
function gridShell(key, title, intro) {
  return `
    ${intro ? `<p class="page-intro">${intro}</p>` : ''}
    <div id="toolbar-${key}" class="toolbar"></div>
    <div id="status-${key}" class="status-msg"></div>
    <div id="grid-${key}"></div>
  `;
}
function emptyStateHtml(icon, title, text, actionHtml) {
  return `<div class="card empty-state"><div class="empty-icon">${icon}</div><h4>${esc(title)}</h4><p>${text}</p>${actionHtml || ''}</div>`;
}
function scenarioLabel(s) {
  return [s.Gate, s.ScenarioName].filter(v => v).join(' ') || s.ScenarioID;
}
function requireScope(key, needScenario) {
  const panel = document.getElementById('panel-' + key);
  if (!currentVehicleTypeId) {
    panel.innerHTML = emptyStateHtml('🚗', '還沒有選擇車型', '請先在右上角選擇車型；還沒有車型的話，到「車型與情境」建立一個。',
      `<button class="btn" onclick="switchTab('masters')">前往車型與情境</button>`);
    return false;
  }
  if (needScenario && !currentScenarioId) {
    panel.innerHTML = emptyStateHtml('🧭', '還沒有選擇情境', '請先在右上角選擇情境；這個車型還沒有情境的話，到「車型與情境」建立。',
      `<button class="btn" onclick="switchTab('masters')">前往車型與情境</button>`);
    return false;
  }
  return true;
}

/* ================= v2 共用介面元件：Toast / 對話框 / 未儲存提醒 / 拖曳排序 ================= */

/** 右上角短暫提示：儲存成功、錯誤等不必停在畫面上的訊息 */
function toast(text, kind, ms) {
  const box = document.getElementById('toasts');
  if (!box || !text) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 250); }, ms || (kind === 'err' ? 6000 : 2600));
}

/**
 * 對話框：取代瀏覽器的 prompt()/confirm()（那兩個長得很突兀、不能放說明、也不能一次問好幾個欄位）。
 * openModal({ title, body(HTML), okText, danger, wide, fields:[{name,label,value,type,options,help,placeholder}] })
 * 回傳 Promise：按確定 → 欄位值物件(沒有欄位就是 true)；按取消/Esc → null。
 */
function openModal(opts) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal' + (opts.wide ? ' wide' : '');
    const fields = opts.fields || [];
    const fieldHtml = fields.map((f, i) => {
      const id = 'mf-' + i;
      let input;
      if (f.type === 'select') {
        input = `<select id="${id}">${(f.options || []).map(o => {
          const [v, t] = Array.isArray(o) ? o : [o, o];
          return `<option value="${esc(v)}"${String(v) === String(f.value || '') ? ' selected' : ''}>${esc(t)}</option>`;
        }).join('')}</select>`;
      } else if (f.type === 'textarea') {
        input = `<textarea id="${id}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`;
      } else if (f.type === 'checks') {
        input = `<div class="chip-list" id="${id}">${(f.options || []).map(o => `<label class="chk"><input type="checkbox" value="${esc(o[0])}"${(f.value || []).indexOf(o[0]) !== -1 ? ' checked' : ''}> ${esc(o[1])}</label>`).join('')}</div>`;
      } else {
        input = `<input id="${id}" type="${f.type || 'text'}" step="any" value="${esc(f.value === undefined ? '' : f.value)}" placeholder="${esc(f.placeholder || '')}">`;
      }
      return `<label class="field"><span>${esc(f.label)}</span>${input}${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</label>`;
    }).join('');
    dlg.innerHTML = `
      <form method="dialog">
        <div class="modal-head"><h3>${esc(opts.title || '')}</h3></div>
        <div class="modal-body">${opts.body || ''}${fieldHtml}</div>
        <div class="modal-foot">
          ${opts.noCancel ? '' : `<button type="button" class="btn secondary" value="cancel">${esc(opts.cancelText || '取消')}</button>`}
          <button type="submit" class="btn${opts.danger ? ' danger solid' : ''}" value="ok">${esc(opts.okText || '確定')}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    let done = false;
    const finish = val => { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(val); };
    dlg.querySelector('button[value=cancel]') && dlg.querySelector('button[value=cancel]').addEventListener('click', () => finish(null));
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
    dlg.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      if (!fields.length && !opts.collect) { finish(true); return; }
      const out = opts.collect ? opts.collect(dlg) : {};
      fields.forEach((f, i) => {
        const el = dlg.querySelector('#mf-' + i);
        out[f.name] = f.type === 'checks' ? Array.from(el.querySelectorAll('input:checked')).map(x => x.value) : el.value;
      });
      if (opts.validate) {
        const msg = opts.validate(out);
        if (msg) { toast(msg, 'err'); return; }
      }
      finish(out);
    });
    dlg.showModal();
    const first = dlg.querySelector('input,select,textarea');
    if (first) { first.focus(); if (first.select) first.select(); }
  });
}
function confirmModal(title, body, okText, danger) {
  return openModal({ title, body: `<p>${body}</p>`, okText: okText || '確定', danger: !!danger });
}

/**
 * 未儲存的修改：表格編輯頁一改東西就在畫面底部浮出「有尚未儲存的修改」+ 儲存/放棄，
 * 不必回到頁首找儲存鈕；Ctrl+S 也能存。切換分頁/車型/情境、關閉視窗前會先確認，不會默默把改到一半的東西丟掉。
 */
let dirtyState_ = null;   // { key, save, discard, count }
function markDirty(key, save, discard) {
  if (!dirtyState_ || dirtyState_.key !== key) dirtyState_ = { key, save, discard, count: 0 };
  dirtyState_.save = save; dirtyState_.discard = discard || dirtyState_.discard;
  dirtyState_.count++;
  const bar = document.getElementById('savebar');
  if (bar) bar.classList.add('show');
}
/**
 * 同一頁有好幾個可以各自編輯的表格(車型與情境頁的車型/車系/情境、參數頁的參數/匯率)：
 * 每個表格是一個 part，底部的「儲存」(Ctrl+S)會把每個改過的表格都存起來；某個表格自己存好了只清掉它自己，
 * 其他表格還有沒存的修改時，提醒列不會消失。
 */
function markDirtyPart_(page, part, save, discard) {
  if (!dirtyState_ || dirtyState_.key !== page || !dirtyState_.parts) dirtyState_ = { key: page, parts: {}, count: 0 };
  const st = dirtyState_;
  st.parts[part] = { save, discard };
  st.count++;
  st.save = () => Object.keys(st.parts).forEach(k => st.parts[k].save());
  st.discard = () => Object.keys(st.parts).forEach(k => { if (st.parts[k].discard) st.parts[k].discard(); });
  const bar = document.getElementById('savebar');
  if (bar) bar.classList.add('show');
}
/** 某個表格存好了：只清掉它；沒有分 part 的頁面就是整頁清掉 */
function clearDirtyPart_(part) {
  if (dirtyState_ && dirtyState_.parts) {
    delete dirtyState_.parts[part];
    if (Object.keys(dirtyState_.parts).length) return;
  }
  clearDirty();
}
function clearDirty() {
  dirtyState_ = null;
  const bar = document.getElementById('savebar');
  if (bar) bar.classList.remove('show');
}
function isDirty_() { return !!dirtyState_; }
/** 要離開目前畫面前問一下；回傳 Promise<boolean>(true = 可以離開) */
function confirmLeave_() {
  if (!dirtyState_) return Promise.resolve(true);
  return openModal({
    title: '有尚未儲存的修改', body: '<p>這一頁還有修改沒有儲存。要保留的話，按「留在這一頁」再按儲存（Ctrl+S）；離開的話這些修改會被丟掉。</p>',
    okText: '放棄修改並離開', danger: true, cancelText: '留在這一頁'
  }).then(ok => { if (ok) clearDirty(); return !!ok; });
}
function installSaveBar_() {
  const save = document.getElementById('savebar-save');
  const discard = document.getElementById('savebar-discard');
  if (save) save.onclick = () => { if (dirtyState_ && dirtyState_.save) dirtyState_.save(); };
  if (discard) discard.onclick = () => {
    const d = dirtyState_;
    clearDirty();
    if (d && d.discard) d.discard(); else renderTab(currentTab);
  };
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (dirtyState_ && dirtyState_.save) dirtyState_.save();
    }
  });
  window.addEventListener('beforeunload', e => { if (dirtyState_) { e.preventDefault(); e.returnValue = ''; } });
}

/**
 * 拖曳排序(全系統共用)：取代一次只能移一格的 ▲▼/◀▶ 按鈕。
 *   - 抓住 ⠿ 把手拖到想要的位置放開(滑鼠、觸控都可以)，拖曳中其他列即時讓位
 *   - 鍵盤：把手取得焦點後 Alt+↑/↓(或 ←/→) 一次移一格
 * makeSortable(container, { items: '選擇器', handle: '選擇器', onEnd(keys, moved) })
 *   items 要有 data-key；放開後依畫面順序回傳 key 陣列，由呼叫端決定要不要立即存檔。
 *   group(item) 可選：回傳群組鍵，只允許在同一群組內移動(科目樹的同一個父科目底下)。
 */
function makeSortable(container, opts) {
  if (!container || !container.addEventListener || container.__sortable) return;
  container.__sortable = true;
  const itemSel = opts.items, handleSel = opts.handle || '.drag-handle';
  // direct：只管直接子元素(巢狀清單如科目樹，每一層各自排序，互不干擾)
  const itemsNow = () => Array.from(container.querySelectorAll(itemSel)).filter(el => !opts.direct || el.parentNode === container);
  const keysNow = () => itemsNow().map(el => el.getAttribute('data-key'));
  let drag = null;
  const groupOf = el => opts.group ? opts.group(el) : '';

  container.addEventListener('pointerdown', e => {
    const handle = e.target.closest(handleSel);
    if (!handle || !container.contains(handle) || e.button > 0) return;
    const item = handle.closest(itemSel);
    if (!item || (opts.direct && item.parentNode !== container)) return;
    e.preventDefault();
    drag = { item, startY: e.clientY, startX: e.clientX, before: keysNow().join('\u0001'), group: groupOf(item), moved: false };
    item.classList.add('sort-dragging');
    document.body.classList.add('sorting');
    hideTooltip_ && hideTooltip_();
    handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
  });
  container.addEventListener('pointermove', e => {
    if (!drag) return;
    const horizontal = !!opts.horizontal;
    const siblings = itemsNow().filter(el => el !== drag.item && groupOf(el) === drag.group);
    const pos = horizontal ? e.clientX : e.clientY;
    for (const sib of siblings) {
      const r = sib.getBoundingClientRect();
      const mid = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
      const isAfterDrag = drag.item.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (isAfterDrag && pos > mid) { insertAfterGroupBlock_(sib, drag.item, opts); drag.moved = true; break; }
      if (!isAfterDrag && pos < mid) { sib.parentNode.insertBefore(drag.item, sib); moveTrailing_(drag.item, opts); drag.moved = true; break; }
    }
  });
  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    d.item.classList.remove('sort-dragging');
    document.body.classList.remove('sorting');
    const after = keysNow();
    if (after.join('\u0001') !== d.before) {
      d.item.classList.add('sort-flash');
      setTimeout(() => d.item.classList.remove('sort-flash'), 900);
      opts.onEnd(after, d.item.getAttribute('data-key'));
    }
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  container.addEventListener('keydown', e => {
    const handle = e.target.closest && e.target.closest(handleSel);
    if (!handle || !e.altKey) return;
    const dir = (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const item = handle.closest(itemSel);
    if (!item || (opts.direct && item.parentNode !== container)) return;
    const g = groupOf(item);
    const peers = itemsNow().filter(el => groupOf(el) === g);
    const idx = peers.indexOf(item), j = idx + dir;
    if (j < 0 || j >= peers.length) return;
    // 真的把 DOM 搬過去(有些呼叫端是照畫面順序讀，如科目樹)，再回傳新順序
    const ref = peers[j];
    if (dir < 0) ref.parentNode.insertBefore(item, ref);
    else ref.parentNode.insertBefore(item, ref.nextSibling);
    const key = item.getAttribute('data-key');
    opts.onEnd(keysNow(), key, true);
    // 重畫之後把焦點放回同一個把手，可以連續按 Alt+↑↓
    setTimeout(() => {
      const box = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
      const again = box && Array.from(box.querySelectorAll(handleSel)).find(h => h.closest(itemSel) === box);
      if (again) again.focus();
    }, 700);
  });
}
/** 科目樹拖曳：一個父科目連同它底下的子科目要一起搬(items 用 data-block 標出區塊成員) */
function insertAfterGroupBlock_(sib, item, opts) {
  let ref = sib;
  if (opts.blockOf) { const tail = opts.blockOf(sib); if (tail) ref = tail; }
  ref.parentNode.insertBefore(item, ref.nextSibling);
  moveTrailing_(item, opts);
}
function moveTrailing_(item, opts) {
  if (!opts.trailingOf) return;
  const trail = opts.trailingOf(item);
  let ref = item;
  trail.forEach(el => { ref.parentNode.insertBefore(el, ref.nextSibling); ref = el; });
}
/**
 * 頁首的 ☰：寬螢幕把側邊欄收成只剩圖示(記在瀏覽器裡，下次打開一樣)；窄螢幕(手機)側邊欄平常是藏起來的，☰ 是把它叫出來。
 */
const SIDEBAR_PREF_KEY_ = 'fs.sidebarCollapsed';
function isNarrowScreen_() { return !!(window.matchMedia && window.matchMedia('(max-width: 860px)').matches); }
function toggleSidebar_() {
  if (isNarrowScreen_()) { document.body.classList.toggle('nav-open'); syncSidebarToggle_(); return; }
  const collapsed = !document.body.classList.contains('nav-collapsed');
  try { localStorage.setItem(SIDEBAR_PREF_KEY_, collapsed ? '1' : ''); } catch (e) { /* 存不了就只有這次有效 */ }
  setSidebarCollapsed_(collapsed);
}
function setSidebarCollapsed_(collapsed) {
  document.body.classList.toggle('nav-collapsed', collapsed);
  // 收起來只剩圖示：滑鼠移上去要看得到是哪一頁
  document.querySelectorAll('.sidebar .nav-item').forEach(b => {
    if (collapsed) b.setAttribute('data-tip', b.textContent.trim()); else b.removeAttribute('data-tip');
  });
  syncSidebarToggle_();
}
function syncSidebarToggle_() {
  const btn = document.querySelector('.sidebar-toggle');
  if (!btn) return;
  const open = isNarrowScreen_() ? document.body.classList.contains('nav-open') : !document.body.classList.contains('nav-collapsed');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function applySidebarPref_() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_PREF_KEY_) === '1'; } catch (e) { /* 預設展開 */ }
  setSidebarCollapsed_(collapsed);
}

/** ⠿ 拖曳把手的 HTML(可以用鍵盤 Alt+↑↓ 操作) */
function dragHandleHtml(label) {
  return `<span class="drag-handle" tabindex="0" role="button" aria-label="${esc(label || '拖曳調整順序')}" data-tip="拖曳調整順序（或 Alt+↑↓）">⠿</span>`;
}

const PAGE_META = {
  dashboard: ['結果呈現', '損益儀表板'], report: ['結果呈現', 'GATE 審議報告'], whatif: ['結果呈現', '目標反推與敏感度分析'], waterfall: ['結果呈現', '瀑布圖工具'],
  salesmix: ['輸入資料', '銷售構成與售價'], costs: ['輸入資料', '成本與費用'], devinvestment: ['輸入資料', '開發總投'],
  lineitems: ['計算設定', '科目與公式'], paramrates: ['計算設定', '參數與匯率'],
  masters: ['主檔', '車型與情境']
};
/** 已經併到別頁的舊分頁(記在瀏覽器裡的上次位置、其他頁的「前往」按鈕)：導到新的那一頁 */
const MERGED_TABS_ = { vehicletypes: 'masters', vehicles: 'masters', scenarios: 'masters', paramfx: 'paramrates',
  costofsales: 'costs', operatingexpense: 'costs' };

/* ---------------- 頁籤 / 上方選單 ---------------- */
function switchTab(key, force) {
  if (MATRIX_CONFIG[key]) costsView = key;   // 「前往銷貨成本/營業費用」：到成本與費用頁的那個子頁籤
  key = MERGED_TABS_[key] || key;
  if (!force && key !== currentTab && isDirty_()) {
    confirmLeave_().then(ok => { if (ok) switchTab(key, true); });
    return;
  }
  clearDirty();
  currentTab = key;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === key));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + key));
  const meta = PAGE_META[key] || ['', ''];
  const crumb = document.getElementById('page-crumb'), title = document.getElementById('page-title');
  if (crumb) crumb.textContent = meta[0];
  if (title) title.textContent = meta[1];
  document.body.classList.remove('nav-open');
  saveAppState_();
  renderTab(key);
}

/**
 * 記住「目前在哪一頁、選了哪個車型/情境」，讓整頁重新載入後能回到原本的位置。
 * 地端版匯入資料包、載入示範資料後都會整頁重新載入，使用者自己按 F5 也是；沒有這層記憶的話，
 * 畫面每次都會跳回「車型主檔」分頁、車型/情境選單也重設成第一筆。存最基本的三個狀態就好，
 * 表格編輯頁裡「還沒存檔的修改」本來就無法安全地跨頁面重新載入還原，不在這裡處理。
 */
const APP_STATE_KEY_ = 'plApp.state.v1';
function saveAppState_() {
  try {
    localStorage.setItem(APP_STATE_KEY_, JSON.stringify({
      tab: currentTab, vehicleTypeId: currentVehicleTypeId, scenarioId: currentScenarioId
    }));
  } catch (e) { /* 無痕模式等情況存不了就算了，不影響功能 */ }
}
function loadAppState_() {
  try {
    const s = JSON.parse(localStorage.getItem(APP_STATE_KEY_) || 'null');
    if (s && typeof s === 'object') return s;
  } catch (e) { /* 壞掉的資料當作沒有 */ }
  return {};
}

function renderTab(key) {
  if (silent) return;
  if (key === 'dashboard') loadComparisonPicker();
  else if (key === 'report') renderReportPanel();
  else if (key === 'whatif') renderWhatIfPanel();
  else if (key === 'waterfall') renderWaterfallPanel();
  else if (key === 'lineitems') renderChartPanel();
  else if (GRID_PANELS[key]) window[GRID_PANELS[key]]();
  else if (key === 'masters') renderMastersPanel();
}

/** 開場：車型 + 情境一次取回，期間不重繪，最後只渲染一次目前分頁 */
function loadVehicleTypeSelector(preferredId, preferredScenarioId) {
  silent = true;
  google.script.run
    .withSuccessHandler(safeHandler(data => {
      renderVehicleTypeOptions(data.vehicleTypes || [], data.vehicleTypeId);
      currentVehicleTypeId = data.vehicleTypeId || '';
      renderScenarioOptions(data.scenarios || [], preferredScenarioId);
      silent = false;
      renderTab(currentTab);
    }))
    .withFailureHandler(err => { silent = false; showGlobalError(err); renderTab(currentTab); })
    .getBootstrap(preferredId || currentVehicleTypeId);
}

function renderVehicleTypeOptions(types, pick) {
  const sel = document.getElementById('vehicletype-selector');
  sel.innerHTML = '<option value="">-- 選擇車型 --</option>' +
    types.map(t => `<option value="${esc(t.VehicleTypeID)}">${esc(t.VehicleTypeID)}</option>`).join('');
  sel.value = pick || '';
}

/** 把情境選單畫出來並決定選哪一個，不觸發伺服器呼叫 */
function renderScenarioOptions(scenarios, preferredId) {
  scenarioCache = scenarios || [];
  const sel = document.getElementById('scenario-selector');
  sel.innerHTML = '<option value="">-- 選擇情境 --</option>' +
    scenarioCache.map(s => `<option value="${esc(s.ScenarioID)}">${esc(scenarioLabel(s))}</option>`).join('');
  const ids = scenarioCache.map(s => s.ScenarioID);
  const pick = (preferredId && ids.indexOf(preferredId) !== -1) ? preferredId
    : (currentScenarioId && ids.indexOf(currentScenarioId) !== -1) ? currentScenarioId
    : ids[0] || '';
  sel.value = pick;
  setCurrentScenario(pick);
}

/** 只更新目前情境狀態與標籤，渲染交給呼叫端決定 */
function setCurrentScenario(value) {
  currentScenarioId = value;
  currentScenario = scenarioCache.filter(s => s.ScenarioID === value)[0] || null;
  const badge = document.getElementById('scenario-type-badge');
  if (badge) {
    const t = currentScenario ? (currentScenario.ScenarioType || '現況') : '';
    badge.textContent = t;
    badge.className = 'type-badge t-' + t;
    badge.style.display = currentScenario ? 'inline-flex' : 'none';
  }
  saveAppState_();
  if (typeof syncMastersScenarioMarks_ === 'function') syncMastersScenarioMarks_();
}

function onVehicleTypeChange(value) {
  if (isDirty_()) {
    const sel = document.getElementById('vehicletype-selector');
    sel.value = currentVehicleTypeId;
    confirmLeave_().then(ok => { if (ok) { sel.value = value; onVehicleTypeChange(value); } });
    return;
  }
  currentVehicleTypeId = value;
  currentScenarioId = '';
  currentScenario = null;
  saveAppState_();
  // 車型換了之後情境清單也要換，換完才渲染一次，避免同一個分頁畫兩遍
  loadScenarioSelector();
}

function loadScenarioSelector(preferredId) {
  const sel = document.getElementById('scenario-selector');
  if (!currentVehicleTypeId) {
    sel.innerHTML = '<option value="">-- 請先選車型 --</option>';
    scenarioCache = [];
    setCurrentScenario('');
    renderTab(currentTab);
    return;
  }
  silent = true;
  google.script.run
    .withSuccessHandler(safeHandler(scenarios => {
      renderScenarioOptions(scenarios, preferredId);
      silent = false;
      renderTab(currentTab);
    }))
    .withFailureHandler(err => { silent = false; showGlobalError(err); })
    .getScenarios(currentVehicleTypeId);
}

function onScenarioChange(value) {
  if (isDirty_()) {
    const sel = document.getElementById('scenario-selector');
    sel.value = currentScenarioId;
    confirmLeave_().then(ok => { if (ok) { sel.value = value; onScenarioChange(value); } });
    return;
  }
  setCurrentScenario(value);
  renderTab(currentTab);
}

/* ================= 從 Excel 貼上 =================
 * 在任何表格的輸入格按 Ctrl+V，如果剪貼簿是從 Excel 複製的「一整塊」(有 Tab 或換行)，
 * 就從目前這一格開始往右、往下依序填進去，不必一格一格輸入。
 * 填完會觸發每一格原本的 input 事件，連動計算(構成比、加權平均、低減後金額…)與未儲存提醒都照常運作。
 */
/** Excel 複製出來的數字：去掉千分位逗號、空白、貨幣符號；(1,234) 視為負數；「-」視為 0；百分比去掉 % */
function parsePastedNumber_(s) {
  // 全形數字/符號(中文輸入法、部分 Excel 範本)先轉成半形：９９９、１,０００、（１２３）、－５、３．５
  let t = String(s === undefined || s === null ? '' : s)
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/，/g, ',').replace(/．/g, '.').replace(/[－−]/g, '-').replace(/（/g, '(').replace(/）/g, ')').replace(/％/g, '%').replace(/\u3000/g, ' ')
    .trim();
  if (!t) return '';
  if (/^[-–—]$/.test(t)) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[,\s$¥￥]|NT\$|TWD|元/gi, '').replace(/%$/, '');
  if (/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t)) return (neg ? -1 : 1) * Number(t);
  return null;
}
/** 剪貼簿文字 → 二維陣列(去掉 Excel 多帶的最後一個空行) */
function parseClipboardGrid_(text) {
  const rows = String(text || '').replace(/\r/g, '').split('\n');
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows.map(r => r.split('\t'));
}
/**
 * 表格裡的鍵盤操作跟 Excel 一樣：Enter / ↓ 到下一列同一欄、Shift+Enter / ↑ 到上一列。
 * 數字輸入框原本按 ↑↓ 會把數值加減 1(5,100,000 → 5,099,999)，想換列的人會不知不覺改到數字，所以一律攔下來換列。
 */
function installGridKeys_() {
  document.addEventListener('keydown', e => {
    const el = e.target;
    if (!el || el.tagName !== 'INPUT' || el.type === 'checkbox' || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    const td = el.closest('td'), table = el.closest('table.grid-table');
    if (!td || !table || el.closest('.modal')) return;
    let dir = 0;
    if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)) dir = 1;
    else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) dir = -1;
    if (!dir) return;
    e.preventDefault();   // 不要讓數字框加減 1，也不要送出表單
    const tr = td.parentElement, body = tr.parentElement;
    const rows = Array.from(body.children).filter(r => r.tagName === 'TR' && r.style.display !== 'none' && !r.hidden && !r.classList.contains('group-row'));
    const col = Array.from(tr.children).indexOf(td);
    for (let i = rows.indexOf(tr) + dir; i >= 0 && i < rows.length; i += dir) {
      const cell = rows[i].children[col];
      const next = cell && cell.querySelector('input:not([type=checkbox]):not([disabled])');
      if (next) { next.focus(); if (next.select) next.select(); return; }
    }
  });
  // 滑鼠滾輪停在數字框上也會改數字：有焦點的數字框收到滾輪就先失焦，讓頁面照常捲動
  document.addEventListener('wheel', e => {
    const el = document.activeElement;
    if (el && el.type === 'number' && el === e.target) el.blur();
  }, { passive: true });
}
function installExcelPaste_() {
  document.addEventListener('paste', e => {
    const el = e.target;
    if (!el || !el.closest || !/^(INPUT|SELECT)$/.test(el.tagName)) return;
    const td = el.closest('td');
    const table = el.closest('table.grid-table');
    if (!td || !table || el.closest('.modal')) return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!/[\t\n]/.test(String(text).replace(/\r?\n$/, ''))) return;   // 單一格就照瀏覽器原本的貼上
    e.preventDefault();
    const grid = parseClipboardGrid_(text);
    const tr = td.parentElement;
    const body = tr.parentElement;
    // 小標題列(.group-row)不是資料列，貼上時跳過，Excel 連續的一塊才會對到連續的科目
    const rows = Array.from(body.children).filter(r => r.tagName === 'TR' && r.style.display !== 'none' && !r.hidden && !r.classList.contains('group-row'));
    const r0 = rows.indexOf(tr), c0 = Array.from(tr.children).indexOf(td);
    let filled = 0, skipped = 0;
    const bad = [];   // 填不進去的內容(畫面上把那一格標起來，提示裡列出前幾個)
    const skip = (cell, raw) => {
      skipped++;
      if (bad.length < 3 && String(raw).trim()) bad.push(String(raw).trim());
      if (cell) { cell.classList.add('paste-skip'); setTimeout(() => cell.classList.remove('paste-skip'), 8000); }
    };
    grid.forEach((cells, dr) => {
      const row = rows[r0 + dr];
      if (!row) { skipped += cells.length; return; }
      cells.forEach((raw, dc) => {
        const cell = row.children[c0 + dc];
        const input = cell && cell.querySelector('input:not([type=checkbox]):not([disabled]),select:not([disabled])');
        if (!input) { if (String(raw).trim()) skip(cell, raw); return; }
        let v = raw.trim();
        if (input.type === 'number') {
          const n = parsePastedNumber_(v);
          if (n === null) { skip(cell, raw); return; }
          v = n === '' ? '' : String(n);
        } else if (input.tagName === 'SELECT') {
          const opt = Array.from(input.options).find(o => o.value === v || o.text === v);
          if (!opt) { skip(cell, raw); return; }
          v = opt.value;
        }
        input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        filled++;
      });
    });
    toast(`已從剪貼簿填入 ${filled} 格` + (skipped ? `，${skipped} 格無法填入（超出表格、唯讀或不是數字${bad.length ? '，例如「' + bad.join('」「') + '」' : ''}；表格上標紅的格子）` : '') + '。確認後記得儲存。', skipped ? 'warn' : 'ok', skipped ? 8000 : 4500);
  });
}
