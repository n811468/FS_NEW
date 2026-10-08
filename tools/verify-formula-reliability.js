/**
 * 改公式的可靠度驗證：整套系統都在算損益，改了公式之後算出來的數字一定要對。
 *
 *   node tools/verify-formula-reliability.js
 *   SEED=123 ROUNDS=300 node tools/verify-formula-reliability.js   # 換一組亂數、跑更多回合
 *
 * 作法是「拿另一套獨立寫的算法來對答案」：測試裡自己寫了一份公式解析器、計算器與整張損益表的算法
 * (不呼叫系統的公式引擎)，然後大量隨機改公式，兩邊逐格比對。另外再用等價改寫、手算答案、Excel 已知答案、
 * LibreOffice 重算從不同方向交叉檢查。
 *
 * 1. 公式引擎 vs 參考實作：隨機產生上千條公式(全形符號、多餘括號、大小寫、百分比、次方、比較、函式)，
 *    算出來要一樣；再把公式隨機弄壞，兩邊對「這條公式能不能用」的判斷也要一樣。
 * 2. 跟 Excel 一致的細節：四捨五入、浮點尾差、運算優先順序，用 Excel 的已知答案逐條對。
 * 3. 整張損益表 vs 參考實作：在 Gate F 驗算情境上隨機改科目表(科目公式、車系個別公式、新增科目、
 *    改父科目、勾選可扣貨物稅、改名、改回手動輸入)，每改一次就把所有車系、所有科目、加權平均逐格比對；
 *    系統擋下的循環引用，參考實作也要判定是循環；邊打邊看的試算值 = 存檔之後的值。
 * 4. 等價改寫：換一種寫法但意思相同(展開 CHILDREN()、改用 [名稱]、SUM、全形、多包括號、把引用的公式代進來、
 *    改名、重新排序)，所有情境、所有車系的每個數字不變；改回原本的公式後跟改之前一個位元都不差。
 * 5. 手算答案：改一個地方，損益照會計關係變動(成本 +1000 → 營業淨利 −1000；可扣貨物稅的費用 +1000 →
 *    營業淨利 −1000 × (1 − 91% × 15% ÷ 115%)；只換父科目，營業淨利不變…)。
 * 6. 守門：打錯字、引用不存在的東西、參數個數不對、循環引用(直接、經由名稱、CHILDREN()、TAXDEDUCT()、
 *    車系個別公式)一律在存檔時擋下，而且擋下之後科目表與每個數字完全沒變；
 *    跨情境 REF 的循環在計算時明確報錯，不會默默變成 0。
 * 7. 實際操作路徑(地端版主機，跟瀏覽器同一條呼叫路徑)：存檔後立刻看到新數字、改回來完全復原、關掉重開還在。
 * 8. Excel 驗算檔：隨機改過的科目表匯出 Excel 再匯入，公式不變；有 LibreOffice 時從頭重算，逐格等於系統。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadAppsScript } = require('./fake-apps-script');
const gatef = require('./verify-gatef');
const { seedDemoData } = require('./dev-server');
const { readNumbers, findSoffice, textFiles, stripCache } = require('./xlsx-tools');

const SEED = Number(process.env.SEED || 20261008);
const ROUNDS = Number(process.env.ROUNDS || 120);
const FORMULAS = Number(process.env.FORMULAS || 4000);
const GS_FILES = ['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs', 'XlsxWriter.gs', 'VerifyWorkbook.gs', 'VerifyImport.gs'];

const results = [];
function check(name, fn) {
  const t0 = Date.now();
  try { const note = fn(); results.push({ name, ok: true, note, ms: Date.now() - t0 }); } catch (e) { results.push({ name, ok: false, err: e.stack && !e.plain ? e.message + '\n' + e.stack.split('\n').slice(1, 3).join('\n') : e.message }); }
}
function fail(msg) { const e = new Error(msg); e.plain = true; throw e; }
function assert(cond, msg) { if (!cond) fail(msg); }
/** 金額比對：相對誤差 1e-9(或絕對 1e-6)以內算相同 —— 不是四捨五入後的容差，是浮點運算順序不同才可能有的差 */
function same(a, b) { return a === b || Math.abs(a - b) <= Math.max(1e-6, 1e-9 * Math.max(Math.abs(a), Math.abs(b))); }

/* ---------- 亂數(固定種子，失敗時可以重現) ---------- */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = makeRng(SEED);
const pick = arr => arr[Math.floor(R() * arr.length)];
const chance = p => R() < p;
const int = (a, b) => a + Math.floor(R() * (b - a + 1));

/* =====================================================================
 * 參考實作：照公式說明(FormulaEngine.gs 開頭的語法說明)獨立寫的解析器與計算器，不呼叫系統的公式引擎。
 *   優先順序(低 → 高)：比較 < 加減 < 乘除 < 負號 < 次方(右結合) < 百分比
 *   除以 0 為 0；比較成立為 1；ROUND 遠離 0；比較與四捨五入前先取 15 位有效數字(同 Excel)
 * ===================================================================== */
const Ref = (() => {
  const FUNCS = { SUM: [0, Infinity], ROUND: [1, 2], ROUNDUP: [1, 2], ROUNDDOWN: [1, 2], MIN: [1, Infinity], MAX: [1, Infinity], ABS: [1, 1], IF: [2, 3], CHILDREN: [0, 0], TAXDEDUCT: [0, 0], REF: [2, 3] };
  const WIDE = { '×': '*', '＊': '*', '÷': '/', '／': '/', '−': '-', '–': '-', '—': '-', '－': '-', '＋': '+', '（': '(', '）': ')', '，': ',', '［': '[', '］': ']', '％': '%', '＝': '=', '＜': '<', '＞': '>', '“': '"', '”': '"' };
  const BIN = { '<': 1, '>': 1, '<=': 1, '>=': 1, '=': 1, '<>': 1, '+': 2, '-': 2, '*': 3, '/': 3 };
  const syntax = msg => { const e = new Error('參考實作：' + msg); e.refSyntax = true; return e; };

  function lex(src) {
    const s = Array.from(String(src)).map(c => WIDE[c] || c).join('').replace(/^\s*=/, '');
    const out = [];
    let i = 0, m;
    while (i < s.length) {
      const c = s[i];
      const rest = s.slice(i);
      if (/\s/.test(c)) { i++; continue; }
      if ((m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest))) { out.push({ k: 'n', v: Number(m[0]) }); i += m[0].length; continue; }
      if (c === '.') throw syntax('數字');
      if (c === '[') {
        const j = s.indexOf(']', i);
        if (j < 0 || !s.slice(i + 1, j).trim()) throw syntax('中括號');
        out.push({ k: 'name', v: s.slice(i + 1, j).trim() }); i = j + 1; continue;
      }
      if (c === '"' || c === "'") {
        const j = s.indexOf(c, i + 1);
        if (j < 0) throw syntax('引號');
        out.push({ k: 's', v: s.slice(i + 1, j) }); i = j + 1; continue;
      }
      if ((m = /^[A-Za-z_]\w*/.exec(rest))) { out.push({ k: 'id', v: m[0] }); i += m[0].length; continue; }
      const two = s.substr(i, 2);
      if (['<=', '>=', '<>', '!='].includes(two)) { out.push({ k: 'op', v: two === '!=' ? '<>' : two }); i += 2; continue; }
      if ('+-*/^(),%<>='.includes(c)) { out.push({ k: 'op', v: c }); i++; continue; }
      throw syntax('字元 ' + c);
    }
    out.push({ k: 'end' });
    return out;
  }

  // 優先順序爬升(precedence climbing)：跟系統的遞迴下降寫法不同，才有交叉檢查的意義
  function parse(src) {
    const t = lex(src);
    let p = 0;
    const isOp = v => t[p].k === 'op' && t[p].v === v;
    const need = v => { if (!isOp(v)) throw syntax('缺 ' + v); p++; };
    function expr(min) {
      let left = prefix();
      while (t[p].k === 'op' && BIN[t[p].v] >= min) {
        const op = t[p++].v;
        left = { t: 'bin', op, a: left, b: expr(BIN[op] + 1) };
      }
      return left;
    }
    function prefix() {
      if (isOp('-')) { p++; return { t: 'neg', a: prefix() }; }
      if (isOp('+')) { p++; return prefix(); }
      const base = postfix();
      if (isOp('^')) { p++; return { t: 'bin', op: '^', a: base, b: prefix() }; }
      return base;
    }
    function postfix() {
      let n = primary();
      while (isOp('%')) { p++; n = { t: 'pct', a: n }; }
      return n;
    }
    function primary() {
      const tok = t[p];
      if (tok.k === 'n') { p++; return { t: 'num', v: tok.v }; }
      if (tok.k === 's') { p++; return { t: 'str', v: tok.v }; }
      if (tok.k === 'name') { p++; return { t: 'name', v: tok.v }; }
      if (tok.k === 'id') {
        p++;
        if (!isOp('(')) return { t: 'code', v: tok.v };
        const f = tok.v.toUpperCase();
        if (!FUNCS[f]) throw syntax('函式 ' + f);
        p++;
        const args = [];
        if (!isOp(')')) { args.push(expr(1)); while (isOp(',')) { p++; args.push(expr(1)); } }
        need(')');
        if (args.length < FUNCS[f][0] || args.length > FUNCS[f][1]) throw syntax(f + ' 參數個數');
        return { t: 'call', f, args };
      }
      if (isOp('(')) { p++; const e = expr(1); need(')'); return e; }
      throw syntax('不完整');
    }
    if (t[0].k === 'end') throw syntax('空的');
    const ast = expr(1);
    if (t[p].k !== 'end') throw syntax('多出來的東西');
    return ast;
  }

  const fin = x => (typeof x === 'number' ? (Number.isFinite(x) ? x : 0) : (isNaN(Number(x)) ? 0 : Number(x)));
  const x15 = x => { x = fin(x); return x === 0 ? 0 : Number(x.toPrecision(15)); };
  function round(x, digits, mode) {
    const d = Math.trunc(fin(digits));
    const f = Math.pow(10, d);
    const v = x15(x * f);
    const a = Math.abs(v);
    const r = mode === 'up' ? Math.ceil(a) : mode === 'down' ? Math.floor(a) : Math.round(a);
    return (v < 0 ? -r : r) / f;
  }
  function evaluate(n, env) {
    switch (n.t) {
      case 'num': case 'str': return n.v;
      case 'code': return fin(env.code(n.v));
      case 'name': return fin(env.name(n.v));
      case 'neg': return -fin(evaluate(n.a, env));
      case 'pct': return fin(evaluate(n.a, env)) / 100;
      case 'bin': {
        const ra = evaluate(n.a, env), rb = evaluate(n.b, env);
        const a = fin(ra), b = fin(rb);
        const str = typeof ra === 'string' || typeof rb === 'string';
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b === 0 ? 0 : a / b;
          case '^': return Math.pow(a, b);
          case '<': return x15(a) < x15(b) ? 1 : 0;
          case '>': return x15(a) > x15(b) ? 1 : 0;
          case '<=': return x15(a) <= x15(b) ? 1 : 0;
          case '>=': return x15(a) >= x15(b) ? 1 : 0;
          case '=': return (str ? String(ra) === String(rb) : x15(a) === x15(b)) ? 1 : 0;
          case '<>': return (str ? String(ra) !== String(rb) : x15(a) !== x15(b)) ? 1 : 0;
        }
        throw new Error('參考實作：未知運算子 ' + n.op);
      }
      case 'call': {
        const v = () => n.args.map(a => fin(evaluate(a, env)));
        switch (n.f) {
          case 'SUM': return v().reduce((s, x) => s + x, 0);
          case 'MIN': return Math.min(...v());
          case 'MAX': return Math.max(...v());
          case 'ABS': return Math.abs(v()[0]);
          case 'ROUND': { const a = v(); return round(a[0], a[1] || 0); }
          case 'ROUNDUP': { const a = v(); return round(a[0], a[1] || 0, 'up'); }
          case 'ROUNDDOWN': { const a = v(); return round(a[0], a[1] || 0, 'down'); }
          case 'IF': return fin(evaluate(n.args[0], env)) ? evaluate(n.args[1], env) : (n.args[2] ? evaluate(n.args[2], env) : 0);
          case 'CHILDREN': return env.children();
          case 'TAXDEDUCT': return env.taxDeduct();
          case 'REF': return env.ref(...n.args.map(a => String(evaluate(a, env))));
        }
      }
    }
    throw new Error('參考實作：未知節點 ' + n.t);
  }
  /** 公式直接引用到的東西(靜態，IF 兩支都算)：循環引用的判斷用 */
  function refs(ast) {
    const out = { codes: new Set(), names: new Set(), children: false, taxDeduct: false };
    (function walk(n) {
      if (n.t === 'code') out.codes.add(n.v);
      else if (n.t === 'name') out.names.add(n.v);
      else if (n.t === 'call') { if (n.f === 'CHILDREN') out.children = true; if (n.f === 'TAXDEDUCT') out.taxDeduct = true; n.args.forEach(walk); }
      else if (n.a) { walk(n.a); if (n.b) walk(n.b); }
    })(ast);
    return out;
  }
  return { parse, evaluate, refs, fin, FUNCS };
})();

/* ---------- 參考實作：整張損益表(科目表、輸入金額、參數都從資料讀，計算全部自己來) ---------- */
function parseVF(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) || {}; } catch (e) { return {}; } }

function refChart(gs, sid) {
  const sc = gs.getScenarios().filter(s => s.ScenarioID === sid)[0];
  const defs = gs.getPLLineItems(sc.VehicleTypeID);
  const byCode = {}, byName = {}, kids = {};
  defs.forEach(d => {
    byCode[d.LineCode] = d;
    if (!(d.LineName in byName)) byName[d.LineName] = d.LineCode;
    if (d.ParentLine) (kids[d.ParentLine] = kids[d.ParentLine] || []).push(d.LineCode);
  });
  const taxCodes = defs.filter(d => String(d.CommodityTaxDeduct || '').toUpperCase() === 'Y').map(d => d.LineCode);
  return { sc, defs, byCode, byName, kids, taxCodes };
}

/** 名稱是不是系統變數/參數/匯率(這些優先，不是科目) */
function reservedName(gs, n, paramNames) {
  return gs.SYSTEM_VARIABLES.some(v => v.name === n) || paramNames.has(n) || /^[A-Za-z]{3}匯率$/.test(n);
}

/** 靜態循環引用檢查(參考實作)：有循環回傳環上的科目代碼，沒有回傳 null */
function refFindCycle(gs, defs) {
  const paramNames = new Set(gs.getParamDefs().map(p => p.ParamName));
  const byName = {}, kids = {};
  defs.forEach(d => { if (!(d.LineName in byName)) byName[d.LineName] = d.LineCode; if (d.ParentLine) (kids[d.ParentLine] = kids[d.ParentLine] || []).push(d.LineCode); });
  const taxCodes = defs.filter(d => String(d.CommodityTaxDeduct || '').toUpperCase() === 'Y').map(d => d.LineCode);
  const deps = {};
  defs.forEach(d => {
    const fs = [];
    if (d.CalcType === 'FORMULA') fs.push(d.Formula);
    Object.values(parseVF(d.VehicleFormulas)).forEach(f => fs.push(f));
    const set = new Set();
    fs.forEach(f => {
      const r = Ref.refs(Ref.parse(f));
      r.codes.forEach(c => set.add(c));
      r.names.forEach(n => { if (!reservedName(gs, n, paramNames) && byName[n]) set.add(byName[n]); });
      if (r.children) (kids[d.LineCode] || []).forEach(c => set.add(c));
      if (r.taxDeduct) taxCodes.forEach(c => set.add(c));
    });
    deps[d.LineCode] = [...set];
  });
  const state = {};
  let found = null;
  const visit = (c, stack) => {
    if (found || state[c] === 2) return;
    if (state[c] === 1) { found = stack.slice(stack.indexOf(c)).concat([c]); return; }
    state[c] = 1;
    (deps[c] || []).forEach(x => visit(x, stack.concat([c])));
    state[c] = 2;
  };
  defs.forEach(d => visit(d.LineCode, []));
  return found;
}

/** 參考實作算整個情境：{ vehicles: { 車系: { 科目: 金額 } }, weighted: { 科目: 金額 } } */
function refCalcScenario(gs, sid) {
  const { defs, byCode, byName, kids, taxCodes } = refChart(gs, sid);
  const mix = gs.getSalesMix(sid);
  const params = gs.calcParameters_(sid);
  const pdefs = {};
  gs.getParamDefs().forEach(d => { pdefs[d.ParamName] = d; });
  const dev = gs.amortizeDevInvestmentPerUnit_(sid, null);
  const vehicles = {};
  mix.forEach(row => {
    const vid = row.VehicleID;
    const vars = gs.systemVariables_(sid, row, mix, params, vid);
    const inputs = {};
    gs.getCostOfSales(sid, vid).concat(gs.getOperatingExpense(sid, vid)).forEach(r => {
      if (!byCode[r.LineCode]) return;
      inputs[r.LineCode] = (inputs[r.LineCode] || 0) + Ref.fin(r.Amount) * gs.fxRateFor_(params, r.Currency, vid);
    });
    const val = {}, busy = {};
    const valueOf = code => {
      if (code in val) return val[code];
      const d = byCode[code];
      if (!d) throw new Error('參考實作：找不到科目 ' + code);
      if (busy[code]) throw new Error('參考實作：存檔後的科目表竟然有循環 ' + code);
      busy[code] = true;
      const own = parseVF(d.VehicleFormulas)[vid];
      const f = own !== undefined && String(own).trim() !== '' ? String(own) : d.CalcType === 'FORMULA' ? d.Formula : null;
      let v;
      if (f !== null) {
        v = Ref.fin(Ref.evaluate(Ref.parse(f), {
          code: c => valueOf(c),
          name: n => {
            if (n in vars) return vars[n];
            if (pdefs[n]) return gs.paramValueForFormula_(params, pdefs[n], vid);
            if (/^[A-Za-z]{3}匯率$/.test(n)) return gs.fxRateFor_(params, n.slice(0, 3).toUpperCase(), vid);
            if (n in byName) return valueOf(byName[n]);
            throw new Error('參考實作：找不到 [' + n + ']');
          },
          children: () => (kids[code] || []).reduce((s, c) => s + valueOf(c), 0),
          taxDeduct: () => taxCodes.reduce((s, c) => s + valueOf(c), 0),
          ref: () => { throw new Error('參考實作不處理 REF'); }
        }));
      } else if (d.CalcType === 'DEV_AMORT') {
        v = ((dev.perUnit || {})[code] || 0) + (((dev.perVehicle || {})[vid] || {})[code] || 0);
      } else {
        v = inputs[code] || 0;
      }
      busy[code] = false;
      val[code] = Number.isFinite(v) ? v : 0;
      return val[code];
    };
    defs.forEach(d => valueOf(d.LineCode));
    vehicles[vid] = val;
  });
  const total = mix.reduce((s, r) => s + Ref.fin(r.SalesMixPct), 0) || 1;
  const weighted = {};
  mix.forEach(r => defs.forEach(d => { weighted[d.LineCode] = (weighted[d.LineCode] || 0) + vehicles[r.VehicleID][d.LineCode] * Ref.fin(r.SalesMixPct) / total; }));
  return { vehicles, weighted };
}

/** 系統算整個情境(同樣的形狀) */
function sysCalcScenario(gs, sid) {
  const all = gs.calculatePLAllVehicles(sid);
  const vehicles = {};
  all.vehicles.forEach(v => { vehicles[v.vehicleId] = Object.assign({}, v.lineValues); });
  const weighted = {};
  all.weightedAverage.forEach(l => { weighted[l.LineCode] = l.Amount; });
  const errors = {};
  all.vehicles.forEach(v => { if (Object.keys(v.errors).length) errors[v.vehicleId] = v.errors; });
  return { vehicles, weighted, errors };
}

/** 兩組數字逐格比，回傳不同的地方(最多 5 筆) */
function diffNumbers(a, b, exact) {
  const out = [];
  const cmp = (x, y, where) => {
    const kx = Object.keys(x).sort(), ky = Object.keys(y).sort();
    if (kx.join() !== ky.join()) { out.push(where + ' 科目不同：' + kx.join(',') + ' / ' + ky.join(',')); return; }
    kx.forEach(k => { if (exact ? !Object.is(x[k] + 0, y[k] + 0) : !same(x[k], y[k])) out.push(`${where} ${k}：${x[k]} ≠ ${y[k]}`); });
  };
  Object.keys(a.vehicles).forEach(v => cmp(a.vehicles[v], b.vehicles[v] || {}, v));
  if (Object.keys(a.vehicles).length !== Object.keys(b.vehicles).length) out.push('車系數不同');
  cmp(a.weighted, b.weighted, '加權平均');
  return out.slice(0, 5);
}

/** 所有情境的數字(等價改寫、守門用) */
function allNumbers(gs) {
  const out = {};
  gs.getScenarios().forEach(s => { out[s.ScenarioID] = sysCalcScenario(gs, s.ScenarioID); });
  return out;
}
function diffAll(a, b, exact) {
  const out = [];
  Object.keys(a).forEach(sid => diffNumbers(a[sid], b[sid] || { vehicles: {}, weighted: {} }, exact).forEach(d => out.push(sid + ' ' + d)));
  return out.slice(0, 5);
}
function chartRows(gs, typeId) {
  return JSON.stringify(gs.getPLLineItems(typeId).map(d => [d.LineCode, d.LineName, d.ParentLine, d.CalcType, d.Formula, d.VehicleFormulas, d.CommodityTaxDeduct, d.SortOrder]));
}
/** 把科目原樣存回去(還原用) */
function lineAsSaved(d) {
  return {
    LineCode: d.LineCode, LineName: d.LineName, ParentLine: d.ParentLine, CalcType: d.CalcType, Formula: d.Formula,
    VehicleFormulas: parseVF(d.VehicleFormulas), CommodityTaxDeduct: d.CommodityTaxDeduct || '', DevAmortCategory: d.DevAmortCategory || ''
  };
}

/* =====================================================================
 * 1. 公式引擎 vs 參考實作
 * ===================================================================== */
const engine = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs']);
const CODES = { P8: 882180, b4: 7166.4, B: 1079185.25, K: -246488.7, x0: 0, d4: 4410.9 };
const NAMES = { 營業稅率: 0.05, 月銷量: 160, 零: 0, 構成比: 0.4, 貨物稅率: 0.15 };
const fixedEnv = {
  code: c => (c in CODES ? CODES[c] : 0),
  name: n => (n in NAMES ? NAMES[n] : 0),
  children: () => 1234.5,
  taxDeduct: () => 53872.9,
  ref: () => 0
};

const NUMS = [0, 1, 2, 3, 7, 15, 100, 1000, 0.5, 0.1, 0.2, 0.3, 1.005, 2.675, 1.15, 0.91, 0.001, 12345.678, 2500];
function genLeaf() {
  const r = R();
  if (r < 0.4) return { t: 'num', v: pick(NUMS) };
  if (r < 0.7) return { t: 'code', v: pick(Object.keys(CODES)) };
  if (r < 0.92) return { t: 'name', v: pick(Object.keys(NAMES)) };
  return { t: 'call', f: pick(['CHILDREN', 'TAXDEDUCT']), args: [] };
}
function genExpr(depth) {
  if (depth <= 0 || chance(0.25)) return genLeaf();
  const r = R(), sub = () => genExpr(depth - 1);
  if (r < 0.42) return { t: 'bin', op: pick(['+', '-', '*', '/', '+', '-', '*']), a: sub(), b: sub() };
  if (r < 0.50) return { t: 'bin', op: pick(['<', '>', '<=', '>=', '=', '<>']), a: sub(), b: sub() };
  if (r < 0.56) return { t: 'bin', op: '^', a: sub(), b: pick([{ t: 'num', v: 2 }, { t: 'num', v: 0.5 }, { t: 'neg', a: { t: 'num', v: 1 } }, genLeaf(), sub()]) };
  if (r < 0.64) return { t: 'neg', a: sub() };
  if (r < 0.70) return { t: 'pct', a: sub() };
  const f = pick(['SUM', 'MIN', 'MAX', 'ABS', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'IF', 'ROUND', 'IF']);
  const [lo, hi] = Ref.FUNCS[f];
  let n = int(lo, Math.min(hi, 4));
  const args = [];
  for (let i = 0; i < n; i++) args.push(sub());
  if (/^ROUND/.test(f) && n === 2) args[1] = { t: 'num', v: pick([0, 1, 2, 3]) };
  if (/^ROUND/.test(f) && n === 2 && chance(0.3)) args[1] = { t: 'neg', a: { t: 'num', v: pick([1, 2]) } };
  return { t: 'call', f, args };
}

/**
 * AST → 公式文字：照優先順序只加必要的括號(這樣才測得到解析器的優先順序)，
 * 再隨機加多餘括號、空白、全形符號、小寫函式名稱、開頭的 =。
 */
const FW = { '*': ['×', '＊'], '/': ['÷', '／'], '-': ['−', '－'], '+': ['＋'], '(': ['（'], ')': ['）'], ',': ['，'], '%': ['％'], '=': ['＝'] };
function printExpr(ast, style) {
  const sp = () => (style.spaces && chance(0.5) ? ' ' : '');
  const w = s => (style.wide && FW[s] && chance(0.5) ? pick(FW[s]) : s);
  const par = s => w('(') + s + w(')');
  const fmtNum = v => String(v);
  function show(n) {
    let out;
    switch (n.t) {
      case 'num': out = { s: fmtNum(n.v), p: 9 }; break;
      case 'code': out = { s: n.v, p: 9 }; break;
      case 'name': out = { s: '[' + n.v + ']', p: 9 }; break;
      case 'neg': { const a = show(n.a); out = { s: w('-') + (a.p >= 4 ? a.s : par(a.s)), p: 4 }; break; }
      case 'pct': { const a = show(n.a); out = { s: (a.p >= 6 ? a.s : par(a.s)) + w('%'), p: 6 }; break; }
      case 'bin': {
        const a = show(n.a), b = show(n.b);
        const lv = { '^': [6, 4, 5], '*': [3, 4, 3], '/': [3, 4, 3], '+': [2, 3, 2], '-': [2, 3, 2] }[n.op] || [1, 2, 1];
        const op = n.op === '<>' && chance(0.3) ? '!=' : n.op.length === 1 ? w(n.op) : n.op;
        out = { s: (a.p >= lv[0] ? a.s : par(a.s)) + sp() + op + sp() + (b.p >= lv[1] ? b.s : par(b.s)), p: lv[2] };
        break;
      }
      case 'call': {
        const name = style.lower && chance(0.5) ? n.f.toLowerCase() : n.f;
        out = { s: name + w('(') + n.args.map(a => show(a).s).join(w(',') + sp()) + w(')'), p: 9 };
        break;
      }
    }
    if (style.extraParens && out.p < 9 && chance(0.12)) out = { s: par(out.s), p: 9 };
    return out;
  }
  const text = show(ast).s;
  return (style.eq ? pick(['=', '＝']) : '') + text;
}

check(`公式引擎 vs 參考實作：隨機 ${FORMULAS} 條公式，解析結果與算出來的值都一樣`, () => {
  const bad = [];
  let compared = 0;
  for (let i = 0; i < FORMULAS && bad.length < 5; i++) {
    const ast = genExpr(int(1, 5));
    const style = { spaces: chance(0.6), wide: chance(0.3), lower: chance(0.3), extraParens: chance(0.5), eq: chance(0.1) };
    const text = printExpr(ast, style);
    const want = Ref.fin(Ref.evaluate(ast, fixedEnv));                 // 直接算產生出來的 AST
    const viaRef = Ref.fin(Ref.evaluate(Ref.parse(text), fixedEnv));   // 參考解析器讀文字再算
    let got;
    try { got = engine.num_(engine.evalFormulaAst_(engine.parseFormula_(text), fixedEnv)); } catch (e) { bad.push(`${text} → 系統解析失敗：${e.message}`); continue; }
    if (!same(viaRef, want)) bad.push(`${text} → 參考解析器 ${viaRef}，AST ${want}(測試本身的印表/解析有誤)`);
    else if (!same(got, want)) bad.push(`${text} → 系統 ${got}，參考 ${want}`);
    compared++;
  }
  assert(!bad.length, bad.join('\n      '));
  return compared + ' 條';
});

check('公式引擎 vs 參考實作：把公式隨機弄壞，「能不能用」的判斷一致，能用的算出來也一樣', () => {
  const INSERT = ['+', '-', '*', '/', '^', '(', ')', '%', ',', '[', ']', '"', '<', '>', '=', '1', '.', 'a', 'Z', ' ', 'SUM(', 'IF(', '×', '－', '（'];
  const bad = [];
  let accepted = 0, rejected = 0;
  for (let i = 0; i < FORMULAS && bad.length < 5; i++) {
    let text = printExpr(genExpr(int(1, 4)), { spaces: chance(0.5), wide: chance(0.2), lower: false, extraParens: chance(0.3), eq: false });
    const edits = int(1, 2);
    for (let k = 0; k < edits; k++) {
      const at = int(0, text.length);
      const r = R();
      if (r < 0.35 && text.length) text = text.slice(0, at) + text.slice(at + 1);
      else if (r < 0.8) text = text.slice(0, at) + pick(INSERT) + text.slice(at);
      else if (at > 0 && at < text.length) text = text.slice(0, at - 1) + text[at] + text[at - 1] + text.slice(at + 1);
    }
    let refAst = null, refErr = null, sysAst = null, sysErr = null;
    try { refAst = Ref.parse(text); } catch (e) { if (!e.refSyntax) throw e; refErr = e.message; }
    try { sysAst = engine.parseFormula_(text); } catch (e) { if (!e.isFormulaError) { bad.push(`${text} → 系統丟出非公式錯誤：${e.message}`); continue; } sysErr = e.message; }
    if (!!refErr !== !!sysErr) { bad.push(`「${text}」→ 系統${sysErr ? '擋下(' + sysErr + ')' : '接受'}，參考${refErr ? '擋下(' + refErr + ')' : '接受'}`); continue; }
    if (refErr) { rejected++; continue; }
    accepted++;
    const hasStr = JSON.stringify(refAst).indexOf('"t":"str"') !== -1;
    if (hasStr) continue;
    const want = Ref.fin(Ref.evaluate(refAst, fixedEnv));
    const got = engine.num_(engine.evalFormulaAst_(sysAst, fixedEnv));
    if (!same(got, want)) bad.push(`「${text}」→ 系統 ${got}，參考 ${want}`);
  }
  assert(!bad.length, bad.join('\n      '));
  assert(accepted > 100 && rejected > 100, `弄壞的公式應該有接受也有擋下：接受 ${accepted}、擋下 ${rejected}`);
  return `接受 ${accepted}、擋下 ${rejected}`;
});

/* =====================================================================
 * 2. 跟 Excel 一致的細節(右邊是 Excel 的答案)
 * ===================================================================== */
check('跟 Excel 的已知答案一致：四捨五入、浮點尾差、比較、百分比、除以 0', () => {
  const env = { code: () => 0, name: () => 0, children: () => 0, taxDeduct: () => 0, ref: () => 0 };
  const cases = [
    ['ROUND(1.005, 2)', 1.01], ['ROUND(2.675, 2)', 2.68], ['ROUND(-1.005, 2)', -1.01], ['ROUND(1234.5)', 1235], ['ROUND(-2.5)', -3],
    ['ROUND(0.5)', 1], ['ROUND(1234.5678, -2)', 1200], ['ROUND(1250, -2)', 1300], ['ROUND(1234.5678, 1.9)', 1234.6],
    ['ROUNDUP(0.1 + 0.2, 1)', 0.3], ['ROUNDUP(1.0000000001)', 2], ['ROUNDUP(-1.2)', -2], ['ROUNDUP(3.2, 0)', 4],
    ['ROUNDDOWN(4.35 * 100)', 435], ['ROUNDDOWN(-1.7)', -1], ['ROUNDDOWN(0.29 * 100)', 29], ['ROUNDDOWN(2.9999999999999996)', 3],
    ['0.1 + 0.2 = 0.3', 1], ['0.1 + 0.2 <> 0.3', 0], ['0.1 + 0.2 <= 0.3', 1], ['0.1 + 0.2 > 0.3', 0], ['1 = 1.0', 1],
    ['15% * 7', 1.05], ['50%^2', 0.25], ['200% * 3', 6], ['10 / 0', 0], ['IF(1 > 2, 5)', 0], ['2^-1', 0.5],
    // 系統跟數學課本一樣：負號比次方晚算、次方由右往左；Excel 剛好相反(-2^2=4、2^3^2=64)。
    // 匯出 Excel 驗算檔時會補括號(見下一項)，所以驗算檔的數字照樣跟系統一樣。
    ['-2^2', -4], ['2^3^2', 512], ['(-2)^2', 4], ['(2^3)^2', 64]
  ];
  const bad = cases.filter(([f, want]) => !same(engine.num_(engine.evalFormulaAst_(engine.parseFormula_(f), env)), want))
    .map(([f, want]) => `${f}：系統 ${engine.num_(engine.evalFormulaAst_(engine.parseFormula_(f), env))}，應為 ${want}`);
  assert(!bad.length, bad.join('\n      '));
});

check('負號、次方、百分比翻成 Excel 公式時補上括號，Excel 算出來跟系統一樣', () => {
  const g = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'XlsxWriter.gs', 'VerifyWorkbook.gs']);
  const ctx = { code: c => c, name: n => n, sumOf: () => 'SUM()', ref: () => '0', note: () => { } };
  const tr = f => g.verifyPrintAst_(g.parseFormula_(f), ctx, 'excel');
  const cases = [['-2^2', '-(2^2)'], ['2^3^2', '2^(3^2)'], ['-P8^2', '-(P8^2)'], ['P8^-1', 'P8^(-1)'], ['-P8%', '-(P8/100)']];
  const bad = cases.filter(([f, want]) => tr(f).replace(/\s/g, '') !== want).map(([f, want]) => `${f} → ${tr(f)}，應為 ${want}`);
  assert(!bad.length, bad.join('\n      '));
});

/* =====================================================================
 * 3. 整張損益表 vs 參考實作(隨機改科目表)
 * ===================================================================== */
const gs = loadAppsScript(GS_FILES);
const sid = gatef.buildScenario(gs);
gs.getBootstrap('DA');
const origDefs = gs.getPLLineItems('DA').map(lineAsSaved);
const baseline = sysCalcScenario(gs, sid);

check('改公式之前：系統 = 參考實作(Gate F 驗算情境，每個車系每個科目＋加權平均)', () => {
  const d = diffNumbers(sysCalcScenario(gs, sid), refCalcScenario(gs, sid));
  assert(!d.length, d.join('\n      '));
  assert(!Object.keys(baseline.errors).length, '不應該有公式錯誤：' + JSON.stringify(baseline.errors));
});

const PARENTS = ['B', 'E', 'G', 'I'];
const VAR_NAMES = ['[月銷量]', '[構成比]', '[營業稅率]', '[季Margin率]', '[LC總台數]', '[建議零售價]', '[貨物稅率]'];
function randomChartFormula(defs, self) {
  const others = defs.filter(d => d.LineCode !== self);
  const any = () => pick(others);
  const term = () => {
    const r = R(), d = any();
    if (r < 0.32) return d.LineCode;
    if (r < 0.48) return '[' + d.LineName + ']';
    if (r < 0.58) return pick(VAR_NAMES) + (chance(0.5) ? ' * ' + pick(['1000', '12.5', '3']) : '');
    if (r < 0.66) return String(pick([1000, 2500.5, 7166, 12, 0.15]));
    if (r < 0.74) return 'CHILDREN()';
    if (r < 0.79) return 'TAXDEDUCT()';
    if (r < 0.87) return pick(['ROUND', 'ROUNDUP', 'ROUNDDOWN']) + '(' + d.LineCode + ' * ' + pick(['0.3', '1.05', '15%', '0.005']) + (chance(0.6) ? ', ' + pick([0, 1, 2, -2]) : '') + ')';
    if (r < 0.94) return 'IF(' + d.LineCode + ' ' + pick(['>', '<', '>=', '=']) + ' ' + pick([0, 10000, 500000]) + ', ' + any().LineCode + ', ' + pick(['0', '-' + any().LineCode, String(int(1, 9) * 1000)]) + ')';
    return pick(['MIN', 'MAX']) + '(' + d.LineCode + ', ' + any().LineCode + (chance(0.4) ? ', 0' : '') + ')';
  };
  let f = term();
  const n = int(0, 3);
  for (let i = 0; i < n; i++) {
    const op = pick(['+', '-', '+', '-', '*', '/']);
    f += ' ' + op + ' ' + (op === '*' || op === '/' ? pick(['0.5', '2', '10%', '1.05', '(1 + [營業稅率])']) : term());
  }
  return chance(0.15) ? '(' + f + ') * ' + pick(['0.9', '1.1', '50%']) : f;
}

/** 隨機產生一個改動：{ kind, line, preview } line 是要送給 saveChartLine 的內容 */
function randomEdit(defs, vehicles, added) {
  const r = R();
  const d = pick(defs);
  const base = lineAsSaved(d);
  if (r < 0.32) return { kind: '改公式', line: Object.assign(base, { CalcType: 'FORMULA', Formula: randomChartFormula(defs, d.LineCode) }) };
  if (r < 0.47) {
    const vf = Object.assign({}, base.VehicleFormulas);
    vf[pick(vehicles)] = randomChartFormula(defs, d.LineCode);
    return { kind: '車系個別公式', line: Object.assign(base, { VehicleFormulas: vf }) };
  }
  if (r < 0.57) {
    const o = origDefs.filter(x => x.LineCode === d.LineCode)[0];
    if (o) return { kind: '改回原本', line: Object.assign({}, o, { LineName: d.LineName }) };
    return { kind: '清掉車系個別公式', line: Object.assign(base, { VehicleFormulas: {} }) };
  }
  if (r < 0.67 && added < 8) {
    return { kind: '新增科目', line: { LineCode: '', LineName: '隨機科目' + int(1000, 9999), ParentLine: pick(PARENTS.concat([''])), CalcType: 'FORMULA', Formula: randomChartFormula(defs, '') } };
  }
  if (r < 0.75) return { kind: '切換可扣貨物稅', line: Object.assign(base, { CommodityTaxDeduct: base.CommodityTaxDeduct === 'Y' ? '' : 'Y' }) };
  if (r < 0.84) {
    const leaf = pick(defs.filter(x => x.ParentLine && !defs.some(y => y.ParentLine === x.LineCode)));
    return { kind: '換父科目', line: Object.assign(lineAsSaved(leaf), { ParentLine: pick(PARENTS) }) };
  }
  if (r < 0.92) {
    const f = defs.filter(x => x.CalcType === 'FORMULA' && PARENTS.indexOf(x.LineCode) === -1);
    if (f.length) return { kind: '改成手動輸入', line: Object.assign(lineAsSaved(pick(f)), { CalcType: 'INPUT', Formula: '' }) };
  }
  return { kind: '改名', line: Object.assign(base, { LineName: d.LineName.replace(/(·改\d+)?$/, '·改' + int(1, 99)) }) };
}

const xlsxStates = [];   // 第 8 段要拿去 Excel 重算的科目表狀態
check(`隨機改科目表 ${ROUNDS} 回合：每改一次，系統 = 參考實作(所有車系、所有科目、加權平均)`, () => {
  const vehicles = gatef.VEHICLES.map(v => v.id);
  const bad = [];
  const kinds = {};
  let added = 0, saved = 0, blocked = 0, previewChecked = 0;
  for (let round = 1; round <= ROUNDS && bad.length < 3; round++) {
    const defs = gs.getPLLineItems('DA');
    const edit = randomEdit(defs, vehicles, added);
    const where = `第 ${round} 回合(${edit.kind} ${edit.line.LineCode || '新科目'})：`;
    const before = chartRows(gs, 'DA');
    const beforeNums = sysCalcScenario(gs, sid);
    // 參考實作先判斷這個改動會不會造成循環引用
    const nextDefs = edit.line.LineCode
      ? defs.map(x => (x.LineCode === edit.line.LineCode ? Object.assign({}, x, edit.line, { VehicleFormulas: JSON.stringify(edit.line.VehicleFormulas || {}) }) : x))
      : defs.concat([Object.assign({ LineCode: '__NEW__', SortOrder: 9999 }, edit.line)]);
    nextDefs.forEach(x => { if (x.CalcType !== 'FORMULA') x.Formula = ''; });
    const cycle = refFindCycle(gs, nextDefs);
    // 邊打邊看(還沒存)的試算值
    let preview = null;
    if (edit.line.CalcType === 'FORMULA' || edit.kind === '車系個別公式') {
      const pv = gs.previewLineFormula('DA', sid, Object.assign({}, edit.line));
      if (!pv.problems.length) preview = pv.preview;
      else if (!cycle) { bad.push(where + '試算說有問題，參考實作沒找到循環：' + pv.problems.map(p => p.message).join('；') + '\n      公式：' + edit.line.Formula); break; }
    }
    let res = null, err = null;
    try { res = gs.saveChartLine('DA', Object.assign({ __scenarioId: sid }, edit.line)); } catch (e) { err = e.message; }
    if (err) {
      blocked++;
      if (!cycle) { bad.push(where + '系統擋下但參考實作認為沒問題：' + err + '\n      公式：' + (edit.line.Formula || JSON.stringify(edit.line.VehicleFormulas))); break; }
      if (!/循環引用/.test(err)) { bad.push(where + '擋下的理由應該是循環引用：' + err); break; }
      if (chartRows(gs, 'DA') !== before) { bad.push(where + '被擋下卻改到了科目表'); break; }
      const d0 = diffNumbers(beforeNums, sysCalcScenario(gs, sid), true);
      if (d0.length) { bad.push(where + '被擋下卻改到了數字：' + d0.join('；')); break; }
      continue;
    }
    if (cycle) { bad.push(where + '參考實作找到循環 ' + cycle.join('→') + '，系統卻存檔了'); break; }
    saved++;
    kinds[edit.kind] = (kinds[edit.kind] || 0) + 1;
    if (edit.kind === '新增科目') added++;
    const sys = sysCalcScenario(gs, sid);
    const ref = refCalcScenario(gs, sid);
    if (Object.keys(sys.errors).length) { bad.push(where + '系統有公式錯誤：' + JSON.stringify(sys.errors)); break; }
    const d = diffNumbers(sys, ref);
    if (d.length) { bad.push(where + '系統 ≠ 參考實作：\n        ' + d.join('\n        ') + '\n      公式：' + (edit.line.Formula || JSON.stringify(edit.line.VehicleFormulas))); break; }
    // 存檔回傳給畫面的試算值、存檔前邊打邊看的試算值，都要等於存檔後真正算出來的值
    const code = res.line.LineCode;
    const shown = res.editor.preview;
    vehicles.forEach(v => {
      Object.keys(sys.vehicles[v]).forEach(c => {
        if (!same(shown.values[v][c], sys.vehicles[v][c])) bad.push(`${where}存檔後畫面上的 ${v} ${c} 是 ${shown.values[v][c]}，實際 ${sys.vehicles[v][c]}`);
      });
      if (preview) {
        const pvals = preview.values[v];
        Object.keys(pvals).forEach(c => {
          const real = sys.vehicles[v][c === '__NEW__' ? code : c];
          if (!same(pvals[c], real)) bad.push(`${where}存檔前試算 ${v} ${c} = ${pvals[c]}，存檔後 = ${real}`);
        });
      }
    });
    if (preview) previewChecked++;
    if (round % 40 === 0 && xlsxStates.length < 3) {
      const built = gs.buildVerifyWorkbookModel_(sid);
      xlsxStates.push({ round, base64: gs.buildXlsxBase64_(stripCache(built.model)), built, sys });
      const plan = gs.previewVerifyImport(textFiles(Buffer.from(gs.buildXlsxBase64_(gs.buildVerifyWorkbookModel_(sid).model), 'base64')));
      if (plan.formulas.length || plan.inputs.length || plan.problems.length) {
        bad.push(`${where}匯出 Excel 再匯入，應該沒有任何變更：` + JSON.stringify({ f: plan.formulas.map(f => f.code + ' ' + f.before + ' → ' + f.after), p: plan.problems }));
      }
      if (built.meta.fallbacks.length) bad.push(where + '有公式翻不成 Excel：' + built.meta.fallbacks.join(','));
    }
  }
  assert(!bad.length, bad.join('\n      '));
  assert(saved >= ROUNDS * 0.5, `存檔成功的回合太少：${saved}/${ROUNDS}`);
  return `存檔 ${saved} 次(${Object.keys(kinds).map(k => k + ' ' + kinds[k]).join('、')})、擋下循環 ${blocked} 次、比對存檔前試算 ${previewChecked} 次`;
});

check('隨機改完之後換回標準範本：數字跟一開始一個位元都不差', () => {
  // 先拿掉車系個別公式、新增的科目改成手動輸入(只會拿掉引用，不會產生循環)，
  // 再換回標準範本(公式、名稱、父科目)，新增的科目就沒有人引用了，最後刪掉
  gs.getPLLineItems('DA').forEach(d => { if (Object.keys(parseVF(d.VehicleFormulas)).length) gs.saveChartLine('DA', Object.assign(lineAsSaved(d), { VehicleFormulas: {} })); });
  gs.getPLLineItems('DA').filter(d => !origDefs.some(o => o.LineCode === d.LineCode))
    .forEach(d => gs.saveChartLine('DA', Object.assign(lineAsSaved(d), { CalcType: 'INPUT', Formula: '' })));
  gs.restoreBuiltInLineItems('DA');
  gs.getPLLineItems('DA').filter(d => !origDefs.some(o => o.LineCode === d.LineCode)).forEach(d => gs.deletePLLineItem(d.LineCode, 'DA'));
  assert(chartRows(gs, 'DA').indexOf('隨機科目') === -1, '新增的科目應該都刪掉了');
  const d = diffNumbers(baseline, sysCalcScenario(gs, sid), true);
  assert(!d.length, d.join('\n      '));
});

/* =====================================================================
 * 4. 等價改寫：意思相同的寫法，數字不能變；改回來要完全一樣
 * ===================================================================== */
const WIDE_OPS = { '*': '×', '/': '÷', '-': '−', '+': '＋', '(': '（', ')': '）', ',': '，' };
/** 只改 [名稱] 與 "字串" 以外的部分 */
function mapOutside(f, fn) { return String(f).split(/("[^"]*"|\[[^\]]*\])/).map((part, i) => (i % 2 ? part : fn(part))).join(''); }
const joinOr0 = (list, sep) => (list.length ? '(0 + ' + list.join(sep) + ')' : '0');
const TRANSFORMS = {
  '多包一層括號': () => f => '(' + f + ')',
  '全形符號與開頭的 =': () => f => '＝' + mapOutside(f, s => s.replace(/[*/\-+(),]/g, c => WIDE_OPS[c])),
  '加 0': () => f => '(' + f + ') + 0',
  '乘 1': () => f => '1 * (' + f + ')',
  '負負得正': () => f => '-(-(' + f + '))',
  'CHILDREN() 展開成科目代碼': c => (f, self) => mapOutside(f, s => s.replace(/CHILDREN\(\)/g, () => joinOr0(c.kids[self] || [], ' + '))),
  'CHILDREN() 改成 SUM(…)': c => (f, self) => mapOutside(f, s => s.replace(/CHILDREN\(\)/g, () => 'SUM(' + (c.kids[self] || []).join(', ') + ')')),
  'CHILDREN() 改成 [科目名稱]': c => (f, self) => mapOutside(f, s => s.replace(/CHILDREN\(\)/g, () => joinOr0((c.kids[self] || []).map(k => '[' + c.byCode[k].LineName + ']'), ' + '))),
  'TAXDEDUCT() 展開': c => f => mapOutside(f, s => s.replace(/TAXDEDUCT\(\)/g, () => joinOr0(c.taxCodes, ' + '))),
  '把引用的公式代進來': c => f => mapOutside(f, s => s.replace(/\b([A-Za-z_]\w*)\b(?!\s*\()/g, (m, code) => {
    const d = c.byCode[code];
    if (!d || d.CalcType !== 'FORMULA' || Object.keys(parseVF(d.VehicleFormulas)).length || /CHILDREN|TAXDEDUCT|REF/i.test(d.Formula)) return m;
    return '(' + d.Formula + ')';
  }))
};

function equivalenceSuite(label, g) {
  const types = g.getVehicleTypes().map(t => t.VehicleTypeID).filter(t => g.getScenarios(t).length);
  const before = allNumbers(g);
  Object.keys(TRANSFORMS).forEach(name => {
    check(`等價改寫(${label})：${name}，所有情境的數字不變；改回來一個位元都不差`, () => {
      let edited = 0;
      types.forEach(typeId => {
        const defs = g.getPLLineItems(typeId);
        const original = defs.map(lineAsSaved);
        const c = { byCode: {}, kids: {}, taxCodes: defs.filter(d => String(d.CommodityTaxDeduct || '').toUpperCase() === 'Y').map(d => d.LineCode) };
        defs.forEach(d => { c.byCode[d.LineCode] = d; if (d.ParentLine) (c.kids[d.ParentLine] = c.kids[d.ParentLine] || []).push(d.LineCode); });
        const tf = TRANSFORMS[name](c);
        original.forEach(o => {
          const vf = {};
          Object.keys(o.VehicleFormulas).forEach(v => { vf[v] = tf(o.VehicleFormulas[v], o.LineCode); });
          const f = o.CalcType === 'FORMULA' ? tf(o.Formula, o.LineCode) : '';
          if (f === o.Formula && JSON.stringify(vf) === JSON.stringify(o.VehicleFormulas)) return;
          g.saveChartLine(typeId, Object.assign({}, o, { Formula: f, VehicleFormulas: vf }));
          edited++;
        });
        const d = diffAll(before, allNumbers(g));
        assert(!d.length, typeId + '：' + d.join('\n      '));
        original.forEach(o => g.saveChartLine(typeId, o));
        assert(chartRows(g, typeId) === JSON.stringify(original.map(o => [o.LineCode, o.LineName, o.ParentLine, o.CalcType, o.Formula, Object.keys(o.VehicleFormulas).length ? JSON.stringify(o.VehicleFormulas) : '', o.CommodityTaxDeduct, g.getPLLineItems(typeId).filter(x => x.LineCode === o.LineCode)[0].SortOrder])), typeId + '：改回來之後科目表跟原本不同');
      });
      const d = diffAll(before, allNumbers(g), true);
      assert(!d.length, '改回來之後：' + d.join('\n      '));
      assert(edited > 0, '這個改寫沒有改到任何公式');
      return `改了 ${edited} 個公式`;
    });
  });
  check(`等價改寫(${label})：科目改名(公式用 [名稱] 引用)、子科目倒過來排，數字不變`, () => {
    types.forEach(typeId => {
      const defs = g.getPLLineItems(typeId);
      const original = defs.map(lineAsSaved);
      const byCode = {};
      defs.forEach(d => { byCode[d.LineCode] = d; });
      // 先把 CHILDREN() 換成 [名稱]，再把每個被引用的科目改名：公式存的是代碼，改名不影響
      original.filter(o => o.CalcType === 'FORMULA' && /CHILDREN\(\)/.test(o.Formula)).forEach(o => {
        const kids = defs.filter(d => d.ParentLine === o.LineCode);
        if (kids.length) g.saveChartLine(typeId, Object.assign({}, o, { Formula: o.Formula.replace(/CHILDREN\(\)/g, '(' + kids.map(k => '[' + k.LineName + ']').join(' + ') + ')') }));
      });
      defs.forEach(d => g.saveChartLine(typeId, Object.assign(lineAsSaved(g.getPLLineItems(typeId).filter(x => x.LineCode === d.LineCode)[0]), { LineName: d.LineName + '(改名)' })));
      g.setLineOrder(typeId, g.getPLLineItems(typeId).slice().reverse().map(d => ({ LineCode: d.LineCode, ParentLine: d.ParentLine })));
      const d = diffAll(before, allNumbers(g));
      assert(!d.length, typeId + '：' + d.join('\n      '));
      original.forEach(o => g.saveChartLine(typeId, o));
    });
    const d = diffAll(before, allNumbers(g));
    assert(!d.length, '改回來之後：' + d.join('\n      '));
  });
}
equivalenceSuite('Gate F', gs);
equivalenceSuite('示範資料', seedDemoData());

/* =====================================================================
 * 5. 手算答案
 * ===================================================================== */
check('手算答案：改一個地方，損益照會計關係變動，改回來完全復原', () => {
  const g = loadAppsScript(GS_FILES);
  const s = gatef.buildScenario(g);
  g.getBootstrap('DA');
  const base = sysCalcScenario(g, s);
  const line = code => lineAsSaved(g.getPLLineItems('DA').filter(d => d.LineCode === code)[0]);
  const TAX_SHARE = 0.91 * 0.15 / 1.15;   // 可扣貨物稅的費用每多 1 元，貨物稅少多少
  const bad = [];
  const expect = (label, edit, wants) => {
    edit();
    const now = sysCalcScenario(g, s);
    Object.keys(wants).forEach(k => {
      const [vid, code] = k.split('.');
      const got = vid === 'W' ? now.weighted[code] - base.weighted[code] : now.vehicles[vid][code] - base.vehicles[vid][code];
      const want = typeof wants[k] === 'function' ? wants[k](now) : wants[k];
      if (Math.abs(got - want) > 1e-6) bad.push(`${label}：${k} 變動 ${got}，手算 ${want}`);
    });
    if (!Object.keys(now.errors).length === false) bad.push(label + '：有公式錯誤 ' + JSON.stringify(now.errors));
  };
  const revert = (...codes) => {
    codes.forEach(c => g.saveChartLine('DA', origDefs.filter(o => o.LineCode === c)[0]));
    const d = diffNumbers(base, sysCalcScenario(g, s), true);
    if (d.length) bad.push('改回 ' + codes.join(',') + ' 之後沒有完全復原：' + d.join('；'));
  };

  expect('一般材料(V1) +1000', () => g.saveChartLine('DA', Object.assign(line('b4'), { VehicleFormulas: { V1: '7166 + 1000' } })),
    { 'V1.b4': 1000, 'V1.B': 1000, 'V1.C': -1000, 'V1.K': -1000, 'V2.K': 0, 'V3.K': 0, 'W.K': -1000 * 0.05, 'V1.b13': 0 });
  revert('b4');

  expect('廣宣費用(V1，可扣貨物稅) +1000', () => g.saveChartLine('DA', Object.assign(line('d1'), { VehicleFormulas: { V1: '5556 + 1000' } })),
    { 'V1.b13': -1000 * TAX_SHARE, 'V1.E': -1000 + 1000 * TAX_SHARE, 'V1.K': -1000 + 1000 * TAX_SHARE, 'V2.K': 0, 'W.K': (-1000 + 1000 * TAX_SHARE) * 0.05 });
  revert('d1');

  expect('前瞻費用(V1) 50000', () => g.saveChartLine('DA', Object.assign(line('J'), { VehicleFormulas: { V1: '50000' } })),
    { 'V1.I': 0, 'V1.K': -50000, 'V2.K': 0 });
  revert('J');

  expect('季Margin 0.5% → 1%', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'P8 * 1%' })),
    { 'V1.d4': 882180 * 0.005, 'V1.K': -882180 * 0.005 * (1 - TAX_SHARE), 'V2.d4': 926466 * 0.005, 'V3.d4': 1147009 * 0.005 });
  revert('d4');

  // 售價(V1)加 105,000：P5 1,101,010 → 營業稅 ROUND(1,101,010×5/105)=52,429、佣金 ROUND(1,048,581×7%)=73,401、廠價 975,180
  expect('建議零售價(V1) +105,000', () => g.saveChartLine('DA', Object.assign(line('P1'), { VehicleFormulas: { V1: '[建議零售價] + 105000' } })),
    {
      'V1.P5': 105000, 'V1.P6': 52429 - 47429, 'V1.P7': 73401 - 66401, 'V1.P8': 975180 - 882180, 'V1.A': 93000,
      'V1.d4': 93000 * 0.005, 'V1.b13': 93000 * (1 - 0.005) * TAX_SHARE,
      'V1.K': 93000 - 93000 * 0.005 - 93000 * (1 - 0.005) * TAX_SHARE, 'V2.K': 0
    });
  revert('P1');

  expect('索賠勾選可扣貨物稅', () => g.saveChartLine('DA', Object.assign(line('d5'), { CommodityTaxDeduct: 'Y' })),
    { 'V1.b13': -3431 * TAX_SHARE, 'V1.K': 3431 * TAX_SHARE, 'V3.K': 3431 * TAX_SHARE, 'W.K': 3431 * TAX_SHARE });
  revert('d5');

  expect('固定營業費用從「營業淨利(未扣前瞻)」移到「產品貢獻」底下', () => g.saveChartLine('DA', Object.assign(line('h1'), { ParentLine: 'G' })),
    { 'V1.G': -41131, 'V1.I': 0, 'V1.K': 0, 'V2.G': -41131, 'W.K': 0 });
  revert('h1');

  expect('固定營業費用移到銷貨成本底下', () => g.saveChartLine('DA', Object.assign(line('h1'), { ParentLine: 'B' })),
    { 'V1.B': 41131, 'V1.C': -41131, 'V1.E': -41131, 'V1.G': -41131, 'V1.I': 0, 'V1.K': 0, 'V1.b13': 0 });
  revert('h1');

  expect('新增「關稅」= 材料成本-KD × 10%，掛在銷貨成本底下', () => g.saveChartLine('DA', { LineCode: '', LineName: '關稅', ParentLine: 'B', CalcType: 'FORMULA', Formula: '[材料成本-KD] * 10%' }),
    { 'V1.B': 37214.8, 'V1.K': -37214.8, 'V2.K': -37214.8, 'W.K': -37214.8 });
  const tax = g.getPLLineItems('DA').filter(d => d.LineName === '關稅')[0];
  if (!tax || tax.Formula !== 'b2 * 10%') bad.push('[名稱] 存檔時應換成代碼：' + (tax && tax.Formula));
  g.deletePLLineItem(tax.LineCode, 'DA');
  const d = diffNumbers(base, sysCalcScenario(g, s), true);
  if (d.length) bad.push('刪掉新增的科目之後沒有完全復原：' + d.join('；'));

  assert(!bad.length, bad.join('\n      '));
});

/* =====================================================================
 * 6. 守門：錯的公式存不進去，存不進去就什麼都沒變
 * ===================================================================== */
check('守門：打錯、引用不存在、參數個數不對、各種循環引用一律擋下，擋下後科目表與數字完全沒變', () => {
  const g = loadAppsScript(GS_FILES);
  const s = gatef.buildScenario(g);
  g.getBootstrap('DA');
  const line = code => lineAsSaved(g.getPLLineItems('DA').filter(d => d.LineCode === code)[0]);
  // 一個還有子科目、但沒有被任何公式引用的小計(測「有子科目不能刪」)
  const group = g.saveChartLine('DA', { LineCode: '', LineName: '其他費用小計', ParentLine: '', CalcType: 'INPUT' }).line.LineCode;
  g.saveChartLine('DA', { LineCode: '', LineName: '其他費用明細', ParentLine: group, CalcType: 'INPUT' });
  const rows = chartRows(g, 'DA');
  const nums = allNumbers(g);
  const attempts = [
    ['少了運算元', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'P8 *' })), /不完整/],
    ['括號沒關', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'P8 * (1 + 2' })), /\)/],
    ['連續兩個乘號', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'P8 ** 2' })), /不應該出現/],
    ['不存在的函式', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'SUMX(P8)' })), /沒有「SUMX」/],
    ['不存在的科目代碼', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'zz9 * 2' })), /不存在的科目代碼/],
    ['不存在的名稱', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: '[不存在的東西] * 2' })), /不是系統變數/],
    ['ROUND 三個參數', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'ROUND(P8, 1, 2)' })), /參數個數/],
    ['IF 少了成立的值', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'IF(P8 > 0)' })), /參數個數/],
    ['ABS 沒有參數', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'ABS()' })), /參數個數/],
    ['CHILDREN 帶參數', () => g.saveChartLine('DA', Object.assign(line('B'), { Formula: 'CHILDREN(1)' })), /參數個數/],
    ['公式是空的', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: '  ' })), /請輸入公式/],
    ['REF 找不到情境', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'REF("不存在的情境", "b4")' })), /REF 找不到情境/],
    ['引用自己', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'd4 + 1' })), /循環引用/],
    ['繞一圈引用回來(廠價引用營業淨利)', () => g.saveChartLine('DA', Object.assign(line('P8'), { Formula: 'P5 - P6 - P7 + K * 0' })), /循環引用/],
    ['子科目引用父科目(經由 CHILDREN)', () => g.saveChartLine('DA', Object.assign(line('b4'), { CalcType: 'FORMULA', Formula: 'B * 0.1' })), /循環引用/],
    ['經由 [名稱] 繞回來', () => g.saveChartLine('DA', Object.assign(line('b4'), { CalcType: 'FORMULA', Formula: '[銷貨成本合計] * 0.1' })), /循環引用/],
    ['可扣貨物稅的科目引用貨物稅(經由 TAXDEDUCT)', () => g.saveChartLine('DA', Object.assign(line('d1'), { CalcType: 'FORMULA', Formula: 'b13 * 0.1' })), /循環引用/],
    ['只有一個車系的個別公式繞回來', () => g.saveChartLine('DA', Object.assign(line('b4'), { VehicleFormulas: { V2: 'C * 0.01' } })), /循環引用/],
    ['IF 沒選到的那一支也算循環', () => g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'IF(1 > 2, K, P8 * 1%)' })), /循環引用/],
    ['父科目是自己', () => g.saveChartLine('DA', Object.assign(line('b4'), { ParentLine: 'b4' })), /自己的父科目/],
    ['父科目不存在', () => g.saveChartLine('DA', Object.assign(line('b4'), { ParentLine: 'ZZZ' })), /父科目不存在/],
    ['科目名稱重複', () => g.saveChartLine('DA', Object.assign(line('b4'), { LineName: '材料成本-LP' })), /./],
    ['刪除還被公式引用的科目', () => g.deletePLLineItem('P8', 'DA'), /被這些科目的公式引用/],
    ['刪除還有子科目的小計', () => g.deletePLLineItem(group, 'DA'), /子科目/],
    ['拖曳排序造成循環(貨物稅搬到可扣科目底下再被 CHILDREN 引用)', () => g.setLineOrder('DA', [{ LineCode: 'b13', ParentLine: 'd4' }, { LineCode: 'd4', ParentLine: 'E' }].concat([])) && g.saveChartLine('DA', Object.assign(line('d4'), { Formula: 'CHILDREN()' })), /循環引用/]
  ];
  const bad = [];
  attempts.forEach(([label, fn, pattern]) => {
    let msg = null;
    try { fn(); } catch (e) { msg = e.message; }
    if (msg === null) bad.push(label + '：沒有擋下來');
    else if (!pattern.test(msg)) bad.push(label + '：錯誤訊息不對「' + msg + '」');
    if (label.indexOf('拖曳排序') === 0) { g.setLineOrder('DA', origDefs.map(o => ({ LineCode: o.LineCode, ParentLine: o.ParentLine }))); return; }
    if (chartRows(g, 'DA') !== rows) bad.push(label + '：擋下之後科目表被改到了');
    const d = diffAll(nums, allNumbers(g), true);
    if (d.length) bad.push(label + '：擋下之後數字變了 ' + d.join('；'));
  });
  const d = diffAll(nums, allNumbers(g), true);
  if (d.length) bad.push('全部試完之後數字變了：' + d.join('；'));
  assert(!bad.length, bad.join('\n      '));
  return attempts.length + ' 種錯誤';
});

check('守門：跨情境 REF 互相引用 → 計算時明確報錯(損益表、Excel 驗算檔都看得到)，不會默默變成 0', () => {
  const g = loadAppsScript(GS_FILES);
  const s = gatef.buildScenario(g);
  g.getBootstrap('DA');
  g.createVehicleType('DE', '', '');
  g.saveVehicle({ VehicleID: 'E1', VehicleTypeID: 'DE', VehicleCode: '8人座' });
  const de = g.createScenarioFrom({ ScenarioID: '', Gate: 'GATE Z', ScenarioName: '實績', ScenarioType: '現況', VehicleTypeID: 'DE' }, '', []);
  g.saveSalesMixGrid(de.ScenarioID, 'DE', [{ RowID: '', VehicleID: 'E1', SalesMixPct: 100, MonthlyVolume: 150, LifeCycleYears: 10, ListPriceTaxIncl: 800000, ScrapFee: 0, ScrapFeeTaxStatus: '含稅' }]);
  g.getBootstrap('DE');
  const lineOf = (t, code) => lineAsSaved(g.getPLLineItems(t).filter(d => d.LineCode === code)[0]);
  g.saveChartLine('DE', Object.assign(lineOf('DE', 'b4'), { CalcType: 'FORMULA', Formula: `REF("${s}", "b4")` }));
  g.saveChartLine('DA', Object.assign(lineOf('DA', 'b4'), { CalcType: 'FORMULA', Formula: `REF("${de.ScenarioID}", "b4") * 1.2` }));
  const res = g.calculatePLCore_(s, 'V1');
  assert(res.errors.b4 && /循環/.test(res.errors.b4), '損益計算應該回報 REF 循環：' + JSON.stringify(res.errors));
  const cmp = g.calculateComparison([{ ScenarioID: s, VehicleID: 'V1' }]);
  assert(cmp.columns[0].errors && cmp.columns[0].errors.b4, '儀表板欄位應該帶出錯誤，畫面才會標示');
  const built = g.buildVerifyWorkbookModel_(s);
  assert(built.meta.errors.length, 'Excel 驗算檔應該列出公式錯誤');
  // 引用那個情境裡跟循環無關的科目：照常取值、不報錯
  g.saveChartLine('DA', Object.assign(lineOf('DA', 'd4'), { Formula: `REF("${de.ScenarioID}", "P8") * 1%` }));
  const ok = g.calculatePLCore_(s, 'V1');
  assert(!ok.errors.d4, '引用沒問題的科目不應該報錯：' + ok.errors.d4);
  assert(same(ok.lineValues.d4, g.calculatePLCore_(de.ScenarioID, 'E1').lineValues.P8 * 0.01), '引用沒問題的科目，值應該照算');
  // 循環一拆掉，兩邊都恢復正常
  g.saveChartLine('DE', Object.assign(lineOf('DE', 'b4'), { CalcType: 'INPUT', Formula: '' }));
  const fixed = g.calculatePLCore_(s, 'V1');
  assert(!Object.keys(fixed.errors).length, '拆掉循環之後不應該還有錯誤：' + JSON.stringify(fixed.errors));
});

/* =====================================================================
 * 7. 實際操作路徑(地端版主機：跟瀏覽器一樣走 google.script.run，每次呼叫都是新的執行)
 * ===================================================================== */
check('實際操作路徑：存檔後立刻看到新數字(含儀表板)，改回來完全復原，關掉重開還在', () => {
  const build = require('./build-local');
  const Shim = require('../local/gas-shim.js');
  const Pack = require('../local/pack.js');
  const Host = require('../local/host.js');
  const factory = build.loadBackendFactory();
  const map = {};
  const storage = { getItem: k => (k in map ? map[k] : null), setItem: (k, v) => { map[k] = String(v); } };
  let seq = 0;
  const newHost = () => {
    const h = Host.createHost({ factory, shim: Shim, pack: Pack, storage, getUser: () => '測試者', getUuid: () => 'u' + String(++seq).padStart(7, '0') + '-0000-0000-0000-000000000000' });
    h.start();
    return new Proxy({}, { get: (_, name) => (...args) => h.call(name, args) });
  };
  const api = newHost();
  const s = gatef.buildScenario(api);
  api.getBootstrap('DA');
  const numbersOf = a => {
    const all = a.calculatePLAllVehicles(s);
    const out = {};
    all.vehicles.forEach(v => { out[v.vehicleId] = v.lineValues; });
    all.weightedAverage.forEach(l => { (out.W = out.W || {})[l.LineCode] = l.Amount; });
    return out;
  };
  const dash = a => a.calculateComparison(gatef.VEHICLES.map(v => ({ ScenarioID: s, VehicleID: v.id })));
  const before = numbersOf(api);
  const d4 = api.getPLLineItems('DA').filter(d => d.LineCode === 'd4')[0];
  const edit = Object.assign(lineAsSaved(d4), { Formula: 'P8 * 2% + [月銷量] * 10' });
  const pv = api.previewLineFormula('DA', s, edit);
  assert(!pv.problems.length, '試算不應該有問題');
  const saved = api.saveChartLine('DA', Object.assign({ __scenarioId: s }, edit));
  const after = numbersOf(api);
  gatef.VEHICLES.forEach(v => {
    const want = after[v.id].P8 * 0.02 + v.monthly * 10;
    assert(same(after[v.id].d4, want), `${v.id} 季Margin：${after[v.id].d4}，應為 ${want}`);
    Object.keys(after[v.id]).forEach(c => {
      assert(same(pv.preview.values[v.id][c], after[v.id][c]), `${v.id} ${c}：存檔前試算 ${pv.preview.values[v.id][c]}，存檔後 ${after[v.id][c]}`);
      assert(same(saved.editor.preview.values[v.id][c], after[v.id][c]), `${v.id} ${c}：存檔回傳 ${saved.editor.preview.values[v.id][c]}，實際 ${after[v.id][c]}`);
    });
  });
  assert(after.V1.K !== before.V1.K, '營業淨利應該跟著變');
  const board = dash(api);
  gatef.VEHICLES.forEach((v, i) => assert(Object.is(board.columns[i].amounts.K, after[v.id].K), `儀表板 ${v.id} 營業淨利 ${board.columns[i].amounts.K}，計算 ${after[v.id].K}`));
  // 關掉重開(用同一份瀏覽器暫存建新主機)：公式與數字都還在
  const reopened = newHost();
  const again = numbersOf(reopened);
  ['V1', 'V2', 'V3', 'W'].forEach(v => Object.keys(after[v]).forEach(c => assert(Object.is(again[v][c], after[v][c]), `重開之後 ${v} ${c} 不同`)));
  // 改回來：每個數字跟改之前完全一樣
  reopened.saveChartLine('DA', lineAsSaved(d4));
  const back = numbersOf(reopened);
  ['V1', 'V2', 'V3', 'W'].forEach(v => Object.keys(before[v]).forEach(c => assert(Object.is(back[v][c], before[v][c]), `改回來之後 ${v} ${c}：${back[v][c]}，原本 ${before[v][c]}`)));
});

/* =====================================================================
 * 8. Excel 驗算檔：隨機改過的科目表，LibreOffice 從頭重算要等於系統
 * ===================================================================== */
const soffice = findSoffice();
if (!xlsxStates.length) {
  results.push({ name: 'Excel 重算：沒有隨機科目表的狀態可以驗(ROUNDS 太少)', ok: true });
} else if (!soffice) {
  console.log('找不到 LibreOffice(soffice)，略過「隨機改過的科目表 → Excel 重算 = 系統數字」。');
} else {
  check(`Excel 重算：隨機改過的科目表(${xlsxStates.map(x => '第 ' + x.round + ' 回合').join('、')})，LibreOffice 從頭重算 = 系統`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-rel-'));
    try {
      const files = xlsxStates.map((st, i) => { const f = path.join(dir, 'r' + i + '.xlsx'); fs.writeFileSync(f, Buffer.from(st.base64, 'base64')); return f; });
      execFileSync(soffice, ['-env:UserInstallation=file://' + path.join(dir, 'profile'), '--headless', '--calc', '--convert-to', 'xlsx', '--outdir', path.join(dir, 'out')].concat(files), { stdio: 'pipe', timeout: 300000 });
      const bad = [];
      xlsxStates.forEach((st, i) => {
        const nums = readNumbers(fs.readFileSync(path.join(dir, 'out', 'r' + i + '.xlsx')));
        const pl = nums['損益試算'];
        const meta = st.built.meta;
        meta.vehicles.forEach((v, j) => {
          const col = String.fromCharCode(68 + j);
          meta.lines.forEach(code => {
            const x = pl[col + meta.plAt[code]], y = st.sys.vehicles[v.id][code];
            if (x === undefined || Math.abs(x - y) > Math.max(0.01, 1e-9 * Math.abs(y))) bad.push(`第 ${st.round} 回合 ${v.id} ${code}：Excel ${x}，系統 ${y}`);
          });
        });
        if (nums['說明'].C9 !== 0) bad.push(`第 ${st.round} 回合：驗算頁有 ${nums['說明'].C9} 個科目不一致`);
      });
      assert(!bad.length, bad.slice(0, 8).join('\n      '));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

/* ---------- 結果 ---------- */
const failed = results.filter(r => !r.ok);
results.forEach(r => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.ok ? (r.note ? '（' + r.note + '）' : '') : '\n      ' + r.err)));
console.log(`\n亂數種子 SEED=${SEED}（失敗時用同一個種子可以重現）`);
if (failed.length) { console.log(`${failed.length} 項失敗`); process.exit(1); }
console.log(`改公式的可靠度：${results.length} 項全部通過`);
