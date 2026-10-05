/* ================= 公式編輯器：一行一項 + 自由公式(膠囊) =================
 *
 * 科目設定頁 ② 公式 的編輯介面，取代原本「空白文字框 + 常用寫法按鈕」：
 *   - 一行一項(預設)：損益表的公式大多是「幾個東西加加減減，每個東西再乘/除幾個比率」，
 *     所以拆成一行一項：每行選一個來源(科目/參數/子科目合計/別的情境/固定金額)，後面可以接好幾個
 *     × 或 ÷ 的係數(參數、固定 %/倍數、(1 + 參數)、科目)，每行右邊直接顯示這一行算出多少。
 *   - 自由公式：有 IF/ROUND/括號巢狀等拆不成一行一項的公式，用一顆一顆膠囊編輯，每顆底下顯示目前的值；
 *     點選單插入科目/參數/函式，鍵盤直接打數字與運算符號。還可以切成純文字輸入(進階、貼上用)。
 * 兩種模式存的都是同一個「名稱版」公式文字(chartDraft.Formula)，存檔時後端照樣換成代碼。
 * 每一行/每顆膠囊的值，是把那一段公式當成「探測公式」(Probes)跟著試算一起送給後端算的加權平均。
 */
let fxMode = 'rows';        // 'rows' 一行一項 / 'chips' 自由公式(膠囊) / 'text' 文字輸入
let fxTerms = [];           // 一行一項：[{ sign: 1|-1, src: 原子, factors: [{ op: '*'|'/', a: 原子 }] }]
let fxToks = [];            // 膠囊：公式拆成的 token
let fxCaret = 0;            // 膠囊游標位置(第幾顆之前)
let fxSelTok = -1;          // 選取中的膠囊
let fxProbeVals = {};       // 公式片段 → 目前情境的加權平均值
let fxDraftKey_ = null;     // 目前的編輯狀態屬於哪一個科目(換科目才重新判斷模式)
let fxProbeScenario_ = null; // fxProbeVals 是哪一個情境算的(換情境就清掉，不顯示上一個情境的數字)
let fxPicker_ = null;       // 選單狀態

const FX_SPECIAL_FNS_ = { CHILDREN: '子科目合計', TAXDEDUCT: '可扣除貨物稅科目合計' };

/* ---------------- 公式文字 ⇄ token ---------------- */
/** 名稱版公式拆成 token；有引號字串等膠囊表達不了的寫法時回傳 null(只能用文字輸入) */
function fxTokenize_(text) {
  const s = String(text || '')
    .replace(/[×＊]/g, '*').replace(/[÷／]/g, '/').replace(/[−–—－]/g, '-').replace(/＋/g, '+')
    .replace(/（/g, '(').replace(/）/g, ')').replace(/，/g, ',').replace(/［/g, '[').replace(/］/g, ']')
    .replace(/％/g, '%').replace(/＝/g, '=').replace(/＜/g, '<').replace(/＞/g, '>').replace(/[“”]/g, '"').replace(/^\s*=/, '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s.charAt(i), rest = s.slice(i);
    let m;
    if (/\s/.test(ch)) { i++; continue; }
    if ((m = /^(\d+\.?\d*|\.\d+)(\s*%)?/.exec(rest))) {
      out.push({ t: 'num', v: m[1] + (m[2] ? '%' : '') });
      i += m[0].length; continue;
    }
    if (ch === '[') {
      const end = s.indexOf(']', i);
      if (end === -1) return null;
      out.push({ t: 'name', v: s.slice(i + 1, end).trim() });
      i = end + 1; continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      const id = m[0], up = id.toUpperCase(), after = s.slice(i + id.length);
      if (/^\s*\(/.test(after)) {
        let mm;
        if (FX_SPECIAL_FNS_[up] && (mm = /^\s*\(\s*\)/.exec(after))) { out.push({ t: 'fn0', v: up }); i += id.length + mm[0].length; continue; }
        if (up === 'REF') {
          mm = /^\s*\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*(?:,\s*"([^"]*)"\s*)?\)/.exec(after);
          if (!mm) return null;
          out.push({ t: 'ref', sc: mm[1], code: mm[2], vid: mm[3] || '' });
          i += id.length + mm[0].length; continue;
        }
        const open = /^\s*\(/.exec(after)[0];
        out.push({ t: 'fn', v: up });
        i += id.length + open.length; continue;
      }
      out.push({ t: 'code', v: id });
      i += id.length; continue;
    }
    const two = s.substr(i, 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=') { out.push({ t: 'op', v: two === '!=' ? '<>' : two }); i += 2; continue; }
    if ('+-*/^(),%<>='.indexOf(ch) !== -1) { out.push({ t: 'op', v: ch }); i++; continue; }
    return null;
  }
  return out;
}
function fxTokText_(t) {
  if (!t) return '';
  if (t.t === 'name') return '[' + t.v + ']';
  if (t.t === 'fn0') return t.v + '()';
  if (t.t === 'fn') return t.v + '(';
  if (t.t === 'ref') return `REF("${t.sc}", "${t.code}"${t.vid ? `, "${t.vid}"` : ''})`;
  if (t.t === 'onePlus') return '(1 + ' + fxTokText_(t.a) + ')';
  return String(t.v);
}
const FX_BIN_OPS_ = ['+', '-', '*', '/', '^', '<', '>', '<=', '>=', '=', '<>'];
/** token → 公式文字：二元運算子前後空一格，負號、括號、逗號照一般寫法 */
function fxToksToText_(toks) {
  let out = '', prev = null;
  toks.forEach(t => {
    if (t.t === 'op' && FX_BIN_OPS_.indexOf(t.v) !== -1) {
      const unary = (t.v === '-' || t.v === '+') && (!prev || prev.t === 'fn' || (prev.t === 'op' && prev.v !== ')' && prev.v !== '%'));
      out += unary ? t.v : ' ' + t.v + ' ';
    } else if (t.t === 'op' && t.v === ',') out += ', ';
    else out += fxTokText_(t);
    prev = t;
  });
  return out.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

/* ---------------- token ⇄ 一行一項 ---------------- */
const FX_ATOM_TYPES_ = ['name', 'code', 'fn0', 'ref', 'num'];
/** 拆得成「± 來源 (×÷ 係數)*」就回傳各行；拆不成(有函式、括號巢狀、比較…)回傳 null */
function fxTermsFromToks_(toks) {
  if (!toks) return null;
  if (!toks.length) return [];
  let i = 0;
  const isOp = (v, k) => { const t = toks[k === undefined ? i : k]; return !!t && t.t === 'op' && t.v === v; };
  const atom = () => { const t = toks[i]; if (t && FX_ATOM_TYPES_.indexOf(t.t) !== -1) { i++; return Object.assign({}, t); } return null; };
  const terms = [];
  let sign = 1;
  if (isOp('-')) { sign = -1; i++; } else if (isOp('+')) i++;
  for (;;) {
    const src = atom();
    if (!src) return null;
    const factors = [];
    while (isOp('*') || isOp('/')) {
      const op = toks[i++].v;
      let a = atom();
      if (!a) {
        // (1 + 參數)：常見的「÷ (1 + 營業稅率)」
        const inner = toks[i + 3];
        if (isOp('(') && toks[i + 1] && toks[i + 1].t === 'num' && toks[i + 1].v === '1' && isOp('+', i + 2) &&
          inner && (inner.t === 'name' || inner.t === 'code') && isOp(')', i + 4)) {
          a = { t: 'onePlus', a: Object.assign({}, inner) };
          i += 5;
        } else return null;
      }
      factors.push({ op, a });
    }
    terms.push({ sign, src, factors });
    if (i >= toks.length) break;
    if (isOp('+')) sign = 1; else if (isOp('-')) sign = -1; else return null;
    i++;
  }
  return terms;
}
function fxAtomComplete_(a) { return !!a && (a.t !== 'num' || String(a.v).replace('%', '').trim() !== '' && !isNaN(Number(String(a.v).replace('%', '')))); }
/** 一行的公式(不含正負號)；還沒選來源的行回傳空字串 */
function fxTermCore_(t) {
  if (!fxAtomComplete_(t.src)) return '';
  return fxTokText_(t.src) + t.factors.filter(f => fxAtomComplete_(f.a.t === 'onePlus' ? f.a.a : f.a)).map(f => ` ${f.op} ${fxTokText_(f.a)}`).join('');
}
function fxTermsText_(terms) {
  let out = '';
  terms.forEach(t => {
    const core = fxTermCore_(t);
    if (!core) return;
    out += out ? (t.sign < 0 ? ' - ' : ' + ') + core : (t.sign < 0 ? '-' : '') + core;
  });
  return out;
}

/* ---------------- 原子的顯示名稱、種類 ---------------- */
function fxParamDef_(name) { return ((chartEditor && chartEditor.params) || []).find(p => p.ParamName === name); }
function fxAtomInfo_(a) {
  if (!a) return { label: '', kind: 'empty' };
  if (a.t === 'onePlus') { const inner = fxAtomInfo_(a.a); return { label: '(1 + ' + inner.label + ')', kind: inner.kind }; }
  if (a.t === 'num') return { label: a.v, kind: 'num' };
  if (a.t === 'fn0') return { label: FX_SPECIAL_FNS_[a.v] || a.v, kind: 'special' };
  if (a.t === 'fn') return { label: a.v + '(', kind: 'fn' };
  if (a.t === 'ref') {
    const sc = ((chartEditor && chartEditor.referenceScenarios) || []).find(r => r.ScenarioID === a.sc);
    const line = chartLineByCode_(a.code);
    return { label: `${sc ? sc.label : a.sc} 的 ${line ? line.LineName : a.code}`, kind: 'ref' };
  }
  if (a.t === 'code') {
    const line = chartLineByCode_(a.code || a.v);
    return line ? { label: line.LineName, kind: 'line' } : { label: a.v, kind: 'bad', hint: '找不到這個科目代碼' };
  }
  if (a.t === 'name') {
    if (fxParamDef_(a.v)) return { label: a.v, kind: 'param' };
    if (((chartEditor && chartEditor.variables) || []).some(v => v.name === a.v)) return { label: a.v, kind: 'var' };
    if (/^[A-Za-z]{3}匯率$/.test(a.v)) return { label: a.v, kind: 'var' };
    if (chartEditor && chartEditor.lines.some(l => l.LineName === a.v)) return { label: a.v, kind: 'line' };
    return { label: a.v, kind: 'bad', hint: '找不到這個科目或參數' };
  }
  return { label: String(a.v || ''), kind: 'op' };
}
/** 值的顯示：% 參數顯示百分比；小數字留小數；金額取整 */
function fxFmtVal_(v, a) {
  if (v === undefined) return '…';
  if (v === null || isNaN(v)) return '—';
  const inner = a && a.t === 'onePlus' ? null : a;
  const p = inner && inner.t === 'name' ? fxParamDef_(inner.v) : null;
  if (p && p.Unit === '%') return fmt(v * 100, 3) + '%';
  if (Math.abs(v) < 100 && Math.round(v) !== v) return fmt(v, 4);
  return fmt(v);
}
/** 可以放進探測的公式片段(數字、函式開頭這類不需要問後端) */
function fxProbeText_(a) { return a && (a.t !== 'num' && a.t !== 'fn' && a.t !== 'op') ? fxTokText_(a) : ''; }
function fxProbeSpan_(text, a, cls) {
  if (!text) return '';
  return `<span class="${cls || 'v'}" data-probe="${esc(text)}" data-fmt="${esc(JSON.stringify(a || null))}">${fxFmtVal_(fxProbeVals[text], a)}</span>`;
}

/* ---------------- 試算：探測公式 ---------------- */
function fxProbeList_() {
  const set = [];
  const add = s => { if (s && set.indexOf(s) === -1) set.push(s); };
  if (!chartDraft || chartDraft.CalcType !== 'FORMULA') return set;
  if (fxMode === 'rows') {
    fxTerms.forEach(t => {
      add(fxProbeText_(t.src));
      t.factors.forEach(f => add(fxProbeText_(f.a)));
      if (t.factors.length) add(fxTermCore_(t));
    });
  } else if (fxMode === 'chips') fxToks.forEach(t => add(fxProbeText_(t)));
  return set;
}
/** 試算結果回來：算各探測公式的加權平均、更新畫面上的數字(不重畫，輸入框不會掉焦點) */
function fxApplyProbes_(preview, probes) {
  fxProbeScenario_ = currentScenarioId;
  if (!preview || !preview.probes) {
    probes.forEach(text => { fxProbeVals[text] = null; });   // 算不出來(沒有情境、試算失敗)：顯示 —，不留舊數字
  } else {
    probes.forEach((text, idx) => {
      let sum = 0, w = 0, any = false;
      Object.keys(preview.probes).forEach(vid => {
        const v = preview.probes[vid][idx];
        if (v === null || v === undefined) return;
        const wt = num((preview.weights || {})[vid]);
        sum += v * wt; w += wt; any = true;
      });
      fxProbeVals[text] = any && w ? sum / w : null;
    });
  }
  fxRefreshValues_();
}
function fxRefreshValues_() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('#ce-calc-body [data-probe]').forEach(el => {
    const text = el.getAttribute('data-probe');
    let a = null;
    try { a = JSON.parse(el.getAttribute('data-fmt') || 'null'); } catch (e) { a = null; }
    const v = fxProbeVals[text];
    el.textContent = el.hasAttribute('data-signed') && v !== undefined && v !== null ? fxSigned_(v * Number(el.getAttribute('data-signed'))) : fxFmtVal_(v, a);
  });
  const total = document.getElementById('ce-fx-total');
  if (total) total.textContent = fxTotalText_();
}
function fxSigned_(v) { return (v < 0 ? '−' : '') + fxFmtVal_(Math.abs(v)); }
function fxTotalText_() {
  if (!chartDraft || !String(chartDraft.Formula || '').trim()) return '—';
  const pv = chartPreview && chartPreview.preview;
  if (!pv) return chartPreview && chartPreview.problems && chartPreview.problems.length ? '—' : '…';
  const v = chartWeightedValue_(chartSelected === '__new__' ? '__NEW__' : chartDraft.LineCode, pv);
  return v === null ? '—' : fmt(v);
}

/* ---------------- 模式 ---------------- */
/** 換科目時：拆得成一行一項就用一行一項，否則自由公式；同一個科目重畫時保留使用者選的模式 */
function fxInitForDraft_() {
  const key = chartSelected + '|' + (chartDraft ? chartDraft.LineCode : '');
  const text = chartDraft ? chartDraft.Formula || '' : '';
  const toks = fxTokenize_(text);
  const terms = fxTermsFromToks_(toks);
  if (fxProbeScenario_ !== currentScenarioId) { fxProbeScenario_ = currentScenarioId; fxProbeVals = {}; }
  if (fxDraftKey_ !== key) {
    fxDraftKey_ = key;
    fxProbeVals = {};
    fxMode = terms ? 'rows' : toks ? 'chips' : 'text';
  } else if (fxMode === 'rows' && !terms) fxMode = toks ? 'chips' : 'text';
  else if (fxMode === 'chips' && !toks) fxMode = 'text';
  fxTerms = terms || [];
  fxToks = toks || [];
  fxCaret = fxToks.length;
  fxSelTok = -1;
}
function setFxMode(mode) {
  if (!chartDraft || mode === fxMode) return;
  const text = chartDraft.Formula || '';
  const toks = fxTokenize_(text);
  if (mode === 'rows') {
    const terms = fxTermsFromToks_(toks);
    if (!terms) { toast('這個公式有函式、括號或比較，拆不成一行一項，請用自由公式編輯', 'warn', 4000); return; }
    fxTerms = terms;
  } else if (mode === 'chips') {
    if (!toks) { toast('公式裡有引號字串等寫法，膠囊沒辦法表示，請用文字輸入', 'warn', 4000); return; }
    fxToks = toks; fxCaret = toks.length; fxSelTok = -1;
  }
  fxMode = mode;
  fxRedraw_();
  if (mode === 'text') { const ta = document.getElementById('ce-formula'); if (ta) ta.focus(); }
  if (mode === 'chips') { const bar = document.getElementById('ce-chips'); if (bar) bar.focus(); }
}
function fxRedraw_() {
  closeFxPicker_();
  const body = document.getElementById('ce-fx-body');
  if (body) body.innerHTML = fxModeBodyHtml_();
  document.querySelectorAll('.fx-mode .seg-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-mode') === (fxMode === 'text' ? 'chips' : fxMode)));
  fxRefreshValues_();
}
/** 一行一項/膠囊改了之後：寫回公式文字 → 未儲存 → 重新試算 */
function fxCommit_(redraw) {
  chartDraft.Formula = fxMode === 'rows' ? fxTermsText_(fxTerms) : fxToksToText_(fxToks);
  chartDirty_();
  if (redraw !== false) fxRedraw_();
  schedulePreview_();
}

/* ---------------- 畫面 ---------------- */
function fxEditorHtml_() {
  closeFxPicker_();   // 編輯器整個重畫(存檔、換科目…)：舊選單記的行號已經不對，直接關掉
  fxInitForDraft_();
  const segMode = fxMode === 'text' ? 'chips' : fxMode;
  return `<div class="ed-step-title"><span class="step-no">2</span>公式
      <span class="seg fx-mode" style="margin-left:auto;">
        <button type="button" class="seg-btn${segMode === 'rows' ? ' active' : ''}" data-mode="rows" onclick="setFxMode('rows')"
          data-tip="每行一個科目或參數，可以再乘/除比率；大部分的公式都這樣寫">一行一項</button>
        <button type="button" class="seg-btn${segMode === 'chips' ? ' active' : ''}" data-mode="chips" onclick="setFxMode('chips')"
          data-tip="有 IF、ROUND、括號的公式用這個">自由公式</button>
      </span></div>
    <div id="ce-fx-body">${fxModeBodyHtml_()}</div>
    <div class="formula-status" id="ce-status"></div>`;
}
function fxModeBodyHtml_() {
  if (fxMode === 'rows') return fxRowsHtml_();
  if (fxMode === 'chips') return fxChipsHtml_();
  return fxTextHtml_();
}

/* --- 一行一項 --- */
function fxSlotHtml_(a, onclick, placeholder) {
  if (!a) return `<button type="button" class="fx-slot empty" onclick="${onclick}">${esc(placeholder)}</button>`;
  const info = fxAtomInfo_(a);
  return `<button type="button" class="fx-slot kind-${info.kind}" onclick="${onclick}"${info.hint ? ` data-tip="${esc(info.hint)}"` : ''}>
    <span class="nm">${esc(info.label)}</span>${fxProbeSpan_(fxProbeText_(a), a)}</button>`;
}
function fxRowsHtml_() {
  const name = chartDraft.LineName || '這個科目';
  const rows = fxTerms.map((t, i) => {
    const src = t.src;
    let srcHtml;
    if (src && src.t === 'num') {
      // 固定金額，或像「15% × 某科目」這種寫在最前面的百分比(數字框不能放 %，單位另外切換)
      const pct = /%$/.test(src.v);
      srcHtml = `<span class="fx-inline">固定 <input type="number" step="any" class="fx-num" value="${esc(String(src.v).replace('%', ''))}" placeholder="${pct ? '百分比' : '金額'}"
        oninput="fxSetNum_(${i}, -1, this.value)"><span class="seg fx-unit">
        <button type="button" class="seg-btn${pct ? '' : ' active'}" onclick="fxSetPct_(${i}, -1, false)">元</button>
        <button type="button" class="seg-btn${pct ? ' active' : ''}" onclick="fxSetPct_(${i}, -1, true)">%</button></span>
        <button type="button" class="link-btn" onclick="fxPickSrc_(${i}, this)">換</button></span>`;
    } else if (src && src.t === 'ref') {
      const scs = chartEditor.referenceScenarios || [];
      srcHtml = `<span class="fx-inline fx-ref">
        <select onchange="fxSetRef_(${i}, 'sc', this.value)">${scs.map(r => `<option value="${esc(r.ScenarioID)}"${r.ScenarioID === src.sc ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
          ${scs.some(r => r.ScenarioID === src.sc) ? '' : `<option selected>${esc(src.sc)}</option>`}</select> 的
        <select onchange="fxSetRef_(${i}, 'code', this.value)">${chartEditor.lines.map(l => `<option value="${esc(l.LineCode)}"${l.LineCode === src.code ? ' selected' : ''}>${esc(l.LineName)}</option>`).join('')}</select>
        ${fxProbeSpan_(fxProbeText_(src), src)} <button type="button" class="link-btn" onclick="fxPickSrc_(${i}, this)">換</button></span>`;
    } else {
      srcHtml = fxSlotHtml_(src, `fxPickSrc_(${i}, this)`, '選一個科目、參數…');
    }
    const factors = src ? t.factors.map((f, k) => {
      const op = `<button type="button" class="fx-op" onclick="fxFlipOp_(${i}, ${k})" data-tip="點一下切換 × / ÷">${f.op === '/' ? '÷' : '×'}</button>`;
      const rm = `<button type="button" class="fx-x" onclick="fxDelFactor_(${i}, ${k})" data-tip="拿掉這個係數">✕</button>`;
      if (f.a.t === 'num') {
        const pct = /%$/.test(f.a.v);
        return `<span class="fx-factor">${op}<input type="number" step="any" class="fx-num sm" value="${esc(String(f.a.v).replace('%', ''))}"
          oninput="fxSetNum_(${i}, ${k}, this.value)"><span class="seg fx-unit">
          <button type="button" class="seg-btn${pct ? '' : ' active'}" onclick="fxSetPct_(${i}, ${k}, false)">倍</button>
          <button type="button" class="seg-btn${pct ? ' active' : ''}" onclick="fxSetPct_(${i}, ${k}, true)">%</button></span>${rm}</span>`;
      }
      return `<span class="fx-factor">${op}${fxSlotHtml_(f.a, `fxPickFactor_(${i}, ${k}, this)`, '')}${rm}</span>`;
    }).join('') : '';
    return `<div class="fx-row">
      <button type="button" class="fx-sign ${t.sign < 0 ? 'minus' : 'plus'}" onclick="fxToggleSign_(${i})" data-tip="點一下切換加 / 減">${t.sign < 0 ? '−' : '＋'}</button>
      <div class="fx-row-main">${srcHtml}${factors}
        ${src ? `<button type="button" class="fx-add-factor" onclick="fxPickFactor_(${i}, -1, this)">× 乘 / ÷ 除…</button>` : ''}</div>
      ${fxRowValHtml_(t)}
      <button type="button" class="fx-del" onclick="fxDelTerm_(${i})" data-tip="刪除這一行">✕</button>
    </div>`;
  }).join('');
  return `<div class="fx-eq-head"><b>${esc(name)}</b> =</div>
    ${fxTerms.length ? `<div class="fx-rows">${rows}</div>`
      : '<div class="callout info"><div>按「＋ 加一項」開始，例如：材料成本-KD × 關稅率。要扣掉的東西用「− 減一項」。</div></div>'}
    <div class="fx-add-row">
      <button type="button" class="btn sm secondary" onclick="fxAddTerm_(1, this)">＋ 加一項</button>
      <button type="button" class="btn sm secondary" onclick="fxAddTerm_(-1, this)">− 減一項</button>
    </div>
    ${fxTerms.length ? `<div class="fx-total"><span>${esc(name)}（目前情境加權平均）</span><b id="ce-fx-total">${fxTotalText_()}</b></div>` : ''}`;
}

/** 固定數字的值：15% → 0.15 */
function fxNumValue_(v) { const s = String(v || ''); return /%$/.test(s) ? Number(s.replace('%', '')) / 100 : Number(s); }
/** 一行右邊的小計：有乘除就問後端整行的值，沒有就是來源本身的值(固定金額直接顯示) */
function fxRowValHtml_(t) {
  const core = fxTermCore_(t);
  if (!core) return '<span class="fx-row-val muted">—</span>';
  const neg = t.sign < 0 ? ' neg' : '';
  const key = t.factors.length ? core : fxProbeText_(t.src);
  if (!key) return `<span class="fx-row-val${neg}">${fxSigned_(fxNumValue_(t.src.v) * t.sign)}</span>`;
  const v = fxProbeVals[key];
  return `<span class="fx-row-val${neg}" data-probe="${esc(key)}" data-signed="${t.sign}">${v === undefined ? '…' : v === null ? '—' : fxSigned_(v * t.sign)}</span>`;
}

/* --- 自由公式(膠囊) --- */
function fxChipHtml_(t, i) {
  const sel = i === fxSelTok ? ' sel' : '';
  if (t.t === 'op') return `<span class="fx-chip op${sel}" data-i="${i}">${esc({ '*': '×', '/': '÷', '-': '−', '<>': '≠', '<=': '≤', '>=': '≥' }[t.v] || t.v)}</span>`;
  if (t.t === 'num') return `<span class="fx-chip num${sel}" data-i="${i}">${esc(t.v)}</span>`;
  if (t.t === 'fn') return `<span class="fx-chip fn${sel}" data-i="${i}">${esc(t.v)}(</span>`;
  const info = fxAtomInfo_(t);
  return `<span class="fx-chip kind-${info.kind}${sel}" data-i="${i}"${info.hint ? ` data-tip="${esc(info.hint)}"` : ''}>${esc(info.label)}${fxProbeSpan_(fxProbeText_(t), t, 'cv')}</span>`;
}
function fxChipsBarInner_() {
  let h = '';
  fxToks.forEach((t, i) => { if (i === fxCaret && fxSelTok < 0) h += '<span class="fx-caret"></span>'; h += fxChipHtml_(t, i); });
  if (fxCaret >= fxToks.length && fxSelTok < 0) h += '<span class="fx-caret"></span>';
  if (!fxToks.length) h += '<span class="muted fx-chips-ph">按下面的「＋ 科目 / 參數」開始，數字和 + − × ÷ ( ) 可以直接用鍵盤打</span>';
  return h;
}
function fxChipsHtml_() {
  const keys = [['+', '＋'], ['-', '−'], ['*', '×'], ['/', '÷'], ['(', '('], [')', ')'], [',', ','], ['>', '>'], ['<', '<'], ['=', '=']];
  return `<div class="fx-eq-head"><b>${esc(chartDraft.LineName || '這個科目')}</b> =</div>
    <div class="fx-chips" id="ce-chips" tabindex="0" onkeydown="fxChipKey_(event)" onmousedown="fxChipMouse_(event)">${fxChipsBarInner_()}</div>
    <div class="fx-keys">
      ${keys.map(k => `<button type="button" class="fx-key" onmousedown="event.preventDefault()" onclick="fxInsertTok_({ t: 'op', v: '${k[0]}' })">${k[1]}</button>`).join('')}
      <button type="button" class="btn sm" onmousedown="event.preventDefault()" onclick="fxPickChip_(this, 'item')">＋ 科目 / 參數</button>
      <button type="button" class="btn sm secondary" onmousedown="event.preventDefault()" onclick="fxPickChip_(this, 'fn')">ƒ 函式</button>
    </div>
    <div class="fx-chip-help muted">點膠囊可以選取，再插入會取代它、按 Backspace 刪除；← → 移動游標。
      <button type="button" class="link-btn" onclick="setFxMode('text')">用文字輸入</button></div>`;
}

/* --- 文字輸入(進階) --- */
function fxTextHtml_() {
  const d = chartDraft;
  return `<div class="formula-box" id="ce-formula-box">
      <textarea id="ce-formula" rows="2" spellcheck="false"
        oninput="onFormulaInput_(this)" onkeydown="onFormulaKeydown_(event)" onblur="onFormulaBlur_(this)"
        placeholder="例：[廠價(未稅)] * [季Margin率]　　輸入 [ 會跳出科目與參數清單">${esc(d.Formula || '')}</textarea>
      <div class="ac-list" id="ce-ac" hidden></div>
    </div>
    <div class="formula-tools">
      <button type="button" class="link-btn" onclick="setFxMode('chips')">← 改回膠囊</button>
      <span class="muted">運算：+ − × ÷ ( )，可以直接打 15%</span>
      <details class="fx-help"><summary class="link-btn">函式與變數說明</summary>
        <table class="grid-table"><tbody>
          ${FORMULA_FUNCTIONS_UI.map(f => `<tr><td class="row-head"><code>${esc(f[0])}</code></td><td style="text-align:left;">${esc(f[1])}</td><td><button type="button" class="ins-chip fn" onclick="insertFormulaText('${esc(f[0].replace(/, …/, ''))}')">插入</button></td></tr>`).join('')}
          ${(chartEditor.variables || []).map(v => `<tr><td class="row-head"><code>[${esc(v.name)}]</code></td><td style="text-align:left;">${esc(v.desc)}</td><td><button type="button" class="ins-chip var" onclick="insertFormulaText('[${esc(v.name)}]')">插入</button></td></tr>`).join('')}
        </tbody></table>
      </details>
    </div>`;
}

/* ---------------- 一行一項：操作 ---------------- */
function fxAddTerm_(sign, btn) {
  fxTerms.push({ sign, src: null, factors: [] });
  fxRedraw_();
  const i = fxTerms.length - 1;
  const slot = document.querySelectorAll('#ce-fx-body .fx-row')[i];
  fxPickSrc_(i, slot ? slot.querySelector('.fx-slot') : btn);
}
function fxDelTerm_(i) { fxTerms.splice(i, 1); fxCommit_(); }
function fxToggleSign_(i) { fxTerms[i].sign *= -1; fxCommit_(); }
function fxFlipOp_(i, k) { const f = fxTerms[i].factors[k]; f.op = f.op === '/' ? '*' : '/'; fxCommit_(); }
function fxDelFactor_(i, k) { fxTerms[i].factors.splice(k, 1); fxCommit_(); }
function fxSetNum_(i, k, value) {
  const a = k < 0 ? fxTerms[i].src : fxTerms[i].factors[k].a;
  const pct = /%$/.test(a.v);
  a.v = String(value).trim() + (pct ? '%' : '');
  fxCommit_(false);   // 不重畫：游標留在輸入框，只換掉這一行的小計
  const row = document.querySelectorAll('#ce-fx-body .fx-row')[i];
  const cell = row && row.querySelector('.fx-row-val');
  if (cell) cell.outerHTML = fxRowValHtml_(fxTerms[i]);
}
function fxSetPct_(i, k, pct) {
  const a = k < 0 ? fxTerms[i].src : fxTerms[i].factors[k].a;
  a.v = String(a.v).replace('%', '') + (pct ? '%' : '');
  fxCommit_();
}
function fxSetRef_(i, field, value) { fxTerms[i].src[field] = value; fxCommit_(); }
function fxPickSrc_(i, anchor) {
  const row = fxTerms[i];
  openFxPicker_(anchor, fxSourceSections_(), item => {
    if (fxTerms[i] !== row) return;
    if (item.special === 'const') { fxTerms[i].src = { t: 'num', v: '' }; fxCommit_(); fxFocusNum_(i, -1); return; }
    if (item.special === 'ref') {
      const sc = (chartEditor.referenceScenarios || []).find(r => r.ScenarioID !== currentScenarioId) || (chartEditor.referenceScenarios || [])[0];
      if (!sc) { toast('還沒有其他情境可以參考', 'warn'); return; }
      fxTerms[i].src = { t: 'ref', sc: sc.ScenarioID, code: chartDraft.LineCode || chartEditor.lines[0].LineCode, vid: '' };
      fxCommit_();
      return;
    }
    fxTerms[i].src = item.tok;
    fxCommit_();
  }, () => { if (fxTerms[i] === row && !row.src) { fxTerms.splice(i, 1); fxRedraw_(); } });
}
function fxPickFactor_(i, k, anchor) {
  const row = fxTerms[i];
  openFxPicker_(anchor, fxFactorSections_(), item => {
    const t = fxTerms[i];
    if (t !== row) return;
    const set = a => { if (k < 0) t.factors.push({ op: item.op || '*', a }); else { t.factors[k].a = a; if (item.op) t.factors[k].op = item.op; } };
    if (item.special === 'pct' || item.special === 'mul') {
      set({ t: 'num', v: item.special === 'pct' ? '%' : '' });
      fxCommit_();
      fxFocusNum_(i, k < 0 ? t.factors.length - 1 : k);
      return;
    }
    if (item.special === 'onePlus') {
      openFxPicker_(anchor, fxParamSections_(), p => { set({ t: 'onePlus', a: p.tok }); fxCommit_(); });
      return;
    }
    set(item.tok);
    fxCommit_();
  });
}
/** 第 i 行的數字輸入框(k = -1 是來源的固定金額，其餘是第 k 個係數) */
function fxFocusNum_(i, k) {
  const row = document.querySelectorAll('#ce-fx-body .fx-row')[i];
  if (!row) return;
  const el = k < 0 ? row.querySelector('.fx-inline .fx-num') : (row.querySelectorAll('.fx-factor')[k] || {}).querySelector && row.querySelectorAll('.fx-factor')[k].querySelector('.fx-num');
  if (el) el.focus();
}

/* ---------------- 膠囊：操作 ---------------- */
function fxRedrawChips_() {
  const bar = document.getElementById('ce-chips');
  if (bar) bar.innerHTML = fxChipsBarInner_();
  fxRefreshValues_();
}
function fxInsertTok_(t) {
  if (fxSelTok >= 0) { fxToks[fxSelTok] = t; fxCaret = fxSelTok + 1; fxSelTok = -1; }
  else { fxToks.splice(fxCaret, 0, t); fxCaret++; }
  fxCommit_(false);
  fxRedrawChips_();
  const bar = document.getElementById('ce-chips');
  if (bar) bar.focus();
}
function fxChipMouse_(e) {
  const el = e.target.closest('.fx-chip');
  if (el) { const i = Number(el.getAttribute('data-i')); fxSelTok = fxSelTok === i ? -1 : i; fxCaret = i + 1; }
  else { fxSelTok = -1; fxCaret = fxToks.length; }
  fxRedrawChips_();
}
function fxChipKey_(e) {
  const k = e.key;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'Backspace' || k === 'Delete') {
    e.preventDefault();
    if (fxSelTok >= 0) { fxToks.splice(fxSelTok, 1); fxCaret = fxSelTok; fxSelTok = -1; }
    else if (k === 'Backspace' && fxCaret > 0) {
      const t = fxToks[fxCaret - 1];
      if (t.t === 'num' && String(t.v).length > 1) t.v = String(t.v).slice(0, -1);
      else { fxToks.splice(fxCaret - 1, 1); fxCaret--; }
    } else if (k === 'Delete' && fxCaret < fxToks.length) fxToks.splice(fxCaret, 1);
    fxCommit_(false); fxRedrawChips_();
  } else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') {
    e.preventDefault();
    fxSelTok = -1;
    fxCaret = k === 'Home' ? 0 : k === 'End' ? fxToks.length : Math.max(0, Math.min(fxToks.length, fxCaret + (k === 'ArrowLeft' ? -1 : 1)));
    fxRedrawChips_();
  } else if (/^[0-9.%]$/.test(k)) {
    e.preventDefault();
    const prev = fxToks[fxCaret - 1];
    if (fxSelTok < 0 && prev && prev.t === 'num' && !/%$/.test(prev.v)) { prev.v += k; fxCommit_(false); fxRedrawChips_(); }
    else if (k === '%') fxInsertTok_({ t: 'op', v: '%' });
    else fxInsertTok_({ t: 'num', v: k });
  } else if ('+-*/^(),<>='.indexOf(k) !== -1 && k.length === 1) {
    e.preventDefault();
    fxInsertTok_({ t: 'op', v: k });
  } else if (k === 'Escape') {
    fxSelTok = -1; fxRedrawChips_();
  } else if (k.length === 1 && /\S/.test(k) || k === 'Process' || k === 'Enter') {
    // 打字(含中文輸入法)：打開選單，字直接進搜尋框
    e.preventDefault();
    const btn = document.querySelector('#ce-fx-body .fx-keys .btn');
    fxPickChip_(btn, 'item', k.length === 1 && k !== '[' ? k : '');
  }
}
function fxPickChip_(anchor, what, query) {
  const sections = what === 'fn' ? fxFunctionSections_() : fxSourceSections_(true).concat(fxFunctionSections_());
  openFxPicker_(anchor, sections, item => {
    if (item.fn) { fxInsertTok_({ t: 'fn', v: item.fn }); return; }
    if (item.special === 'ref') { fxRefModal_().then(t => { if (t) fxInsertTok_(t); }); return; }
    if (item.special === 'const') { fxInsertTok_({ t: 'num', v: '0' }); return; }
    fxInsertTok_(item.tok);
  }, null, query);
}
function fxRefModal_() {
  const lineOpts = chartEditor.lines.map(l => [l.LineCode, l.LineName]);
  return openModal({
    title: '另一個情境（或車型）的科目',
    body: '<p class="help">例：一般材料以前代車型的實績為基準。對方情境有同一個車系就取同一個車系，否則取它的加權平均；對方的數字改了，這裡會跟著變。</p>',
    fields: [
      { name: 'sc', label: '參考的情境', type: 'select', options: (chartEditor.referenceScenarios || []).map(r => [r.ScenarioID, r.label]) },
      { name: 'code', label: '參考的科目', type: 'select', options: lineOpts, value: chartDraft.LineCode || (lineOpts[0] || [''])[0] }
    ], okText: '插入'
  }).then(v => v ? { t: 'ref', sc: v.sc, code: v.code, vid: '' } : null);
}

/* ---------------- 選單內容 ---------------- */
function fxLineTok_(l) { return chartNameUsable_(l) ? { t: 'name', v: l.LineName } : { t: 'code', v: l.LineCode }; }
function fxLineSections_() {
  const depth = {};
  const lines = chartEditor.lines.filter(l => !chartDraft || l.LineCode !== chartDraft.LineCode);
  chartEditor.lines.forEach(l => { let n = 0, cur = l, g = 0; while (cur && cur.ParentLine && g++ < 20) { n++; cur = chartLineByCode_(cur.ParentLine); } depth[l.LineCode] = n; });
  const isGroup = code => chartEditor.lines.some(x => x.ParentLine === code);
  const item = l => ({ label: l.LineName, hint: chartShowCodes ? l.LineCode : '', search: l.LineCode, value: fxFmtVal_(chartWeightedValue_(l.LineCode)),
    indent: depth[l.LineCode] || 0, strong: isGroup(l.LineCode) || l.isProtected, tok: fxLineTok_(l), kind: 'line' });
  return [
    { g: '售價結構', items: lines.filter(l => l.Category === '售價結構').map(item) },
    { g: '損益表科目', items: lines.filter(l => l.Category !== '售價結構').map(item) }
  ];
}
function fxParamSections_() {
  const pv = chartEditor.paramValues || {};
  return [
    { g: '參數（參數與比率頁）', items: (chartEditor.params || []).map(p => ({ label: p.ParamName, hint: p.Description || '', kind: 'param',
      value: pv[p.ParamName] === undefined ? (p.Unit === '%' ? '%' : '') : fxFmtVal_(pv[p.ParamName], { t: 'name', v: p.ParamName }), tok: { t: 'name', v: p.ParamName } })) },
    { g: '系統變數（每個車系各自的值）', items: (chartEditor.variables || []).map(v => ({ label: v.name, hint: v.desc, kind: 'var', tok: { t: 'name', v: v.name } }))
      .concat((chartEditor.currencies || ['CNY', 'USD', 'JPY', 'EUR']).map(c => ({ label: c + '匯率', hint: '1 ' + c + ' = ? 元', kind: 'var', tok: { t: 'name', v: c + '匯率' } }))) }
  ];
}
function fxSourceSections_(forChips) {
  // 新增中的科目還沒有代碼，也不會有子科目(否則 ParentLine 空白的頂層科目全部會被當成它的子科目)
  const kids = chartDraft && chartDraft.LineCode ? chartEditor.lines.filter(l => l.ParentLine === chartDraft.LineCode) : [];
  const kidsSum = kids.reduce((s, l) => s + (chartWeightedValue_(l.LineCode) || 0), 0);
  const special = { g: '特殊', items: [
    { label: '子科目合計', kind: 'special', tok: { t: 'fn0', v: 'CHILDREN' },
      hint: kids.length ? kids.map(l => l.LineName).join('、') : '把其他科目的「計入」選成這個科目，就會加進來', value: kids.length ? fxFmtVal_(kidsSum) : '' },
    { label: '可扣除貨物稅科目合計', kind: 'special', tok: { t: 'fn0', v: 'TAXDEDUCT' }, hint: '進階設定勾了「貨物稅完稅價格可以扣除」的科目' },
    { label: '另一個情境（或車型）的科目…', kind: 'special', special: 'ref', hint: '例：前代車型實績的一般材料' },
    { label: forChips ? '數字' : '固定金額…', kind: 'special', special: 'const', hint: forChips ? '也可以直接用鍵盤打' : '每台固定 N 元' }
  ] };
  return fxLineSections_().concat(fxParamSections_(), [special]);
}
function fxFactorSections_() {
  const fixed = { g: '固定數字', items: [
    { label: '固定百分比…', hint: '例：× 15%', kind: 'num', special: 'pct' },
    { label: '固定倍數…', hint: '例：× 1.2', kind: 'num', special: 'mul' },
    { label: '÷ (1 + 參數)…', hint: '例：含稅 ÷ (1 + 營業稅率) = 未稅', kind: 'special', special: 'onePlus', op: '/' }
  ] };
  return fxParamSections_().concat([fixed], fxLineSections_());
}
function fxFunctionSections_() {
  // 跟文字輸入的「函式與變數說明」同一份清單(30-chart.js 的 FORMULA_FUNCTIONS_UI)；REF 用「另一個情境的科目…」插入
  const fns = FORMULA_FUNCTIONS_UI.map(f => ({ fn: (/^([A-Z]+)\(/.exec(f[0]) || [])[1], usage: f[0], desc: f[1] }))
    .filter(f => f.fn && !FX_SPECIAL_FNS_[f.fn] && f.fn !== 'REF');
  return [{ g: '函式', items: fns.map(f => ({ label: f.fn + '(　)', hint: f.usage + '：' + f.desc, kind: 'fn', fn: f.fn, search: f.desc })) }];
}

/* ---------------- 選單(可搜尋、方向鍵、Enter) ---------------- */
function openFxPicker_(anchor, sections, onPick, onCancel, query) {
  closeFxPicker_();
  const box = document.createElement('div');
  box.className = 'fx-picker';
  box.innerHTML = `<input type="text" class="fx-picker-q" placeholder="搜尋科目、參數…（可以打代碼）"><div class="fx-picker-list"></div>`;
  document.body.appendChild(box);
  fxPicker_ = { box, sections, onPick, onCancel, hl: 0, flat: [] };
  const r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : { left: 100, bottom: 100, top: 100 };
  const w = Math.min(360, window.innerWidth - 24);
  box.style.width = w + 'px';
  box.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + 'px';
  const below = window.innerHeight - r.bottom;
  if (below < 300 && r.top > below) { box.style.bottom = (window.innerHeight - r.top + 4) + 'px'; } else { box.style.top = (r.bottom + 4) + 'px'; }
  const q = box.querySelector('.fx-picker-q');
  q.value = query || '';
  q.addEventListener('input', () => { fxPicker_.hl = 0; drawFxPicker_(); });
  q.addEventListener('keydown', e => {
    const n = fxPicker_.flat.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) fxPicker_.hl = (fxPicker_.hl + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      drawFxPicker_();
    } else if (e.key === 'Enter') { e.preventDefault(); if (n) pickFx_(fxPicker_.hl); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelFxPicker_(); }
  });
  box.addEventListener('mousedown', e => {
    const el = e.target.closest('.fx-pk-item');
    if (el) { e.preventDefault(); pickFx_(Number(el.getAttribute('data-i'))); }
  });
  drawFxPicker_();
  q.focus();
  setTimeout(() => document.addEventListener('mousedown', fxPickerOutside_), 0);
}
function fxPickerOutside_(e) { if (fxPicker_ && !fxPicker_.box.contains(e.target)) cancelFxPicker_(); }
function drawFxPicker_() {
  const p = fxPicker_;
  const q = p.box.querySelector('.fx-picker-q').value.trim().toLowerCase();
  p.flat = [];
  const html = p.sections.map(g => {
    const items = g.items.filter(it => !q || it.label.toLowerCase().indexOf(q) !== -1 || String(it.search || '').toLowerCase() === q ||
      String(it.hint || '').toLowerCase().indexOf(q) !== -1);
    if (!items.length) return '';
    return `<div class="fx-pk-group">${esc(g.g)}</div>` + items.map(it => {
      const i = p.flat.length;
      p.flat.push(it);
      return `<div class="fx-pk-item kind-${it.kind || ''}${i === p.hl ? ' hl' : ''}${it.strong ? ' strong' : ''}" data-i="${i}" style="padding-left:${10 + (q ? 0 : (it.indent || 0) * 14)}px;">
        <div class="fx-pk-text"><span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</div><span class="fx-pk-v">${esc(it.value || '')}</span></div>`;
    }).join('');
  }).join('');
  const list = p.box.querySelector('.fx-picker-list');
  list.innerHTML = html || '<div class="muted" style="padding:10px;">找不到符合的項目</div>';
  scrollListTo_(list, list.querySelector('.hl'));
}
/** 只捲清單本身讓選到的項目看得到(scrollIntoView 會連外層的框、整頁一起捲) */
function scrollListTo_(list, item) {
  if (!list || !item) return;
  const lr = list.getBoundingClientRect(), ir = item.getBoundingClientRect();
  if (ir.top < lr.top) list.scrollTop -= lr.top - ir.top;
  else if (ir.bottom > lr.bottom) list.scrollTop += ir.bottom - lr.bottom;
}
function pickFx_(i) {
  const p = fxPicker_;
  const item = p && p.flat[i];
  if (!item) return;
  closeFxPicker_();
  p.onPick(item);
}
function cancelFxPicker_() {
  const p = fxPicker_;
  closeFxPicker_();
  if (p && p.onCancel) p.onCancel();
}
function closeFxPicker_() {
  if (!fxPicker_) return;
  document.removeEventListener('mousedown', fxPickerOutside_);
  if (fxPicker_.box.parentNode) fxPicker_.box.parentNode.removeChild(fxPicker_.box);
  fxPicker_ = null;
}
