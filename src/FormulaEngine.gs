/**
 * 公式引擎：讓每個損益科目的「計算來源」可以用公式自由設定，不再寫死在 CalcEngine 裡。
 *
 * 語法（刻意貼近 Excel，財務同仁不必另外學）：
 *   數字       1000、0.5、15%（= 0.15）
 *   科目代碼   P8、b1、B、K（直接打代碼）
 *   [名稱]     中括號裡放：系統變數(如 [建議零售價]、[LC總台數])、參數(如 [營業稅率]、自訂參數)、
 *              或同一張科目表裡的科目名稱(如 [材料成本-LP])。比率參數取出來就是小數(5% → 0.05)。
 *   運算子     + - * / ^ ( )，比較 < > <= >= = <>（成立為 1、不成立為 0）
 *              也接受全形與數學符號：× ÷ − （ ），方便直接從簡報/Excel 貼上
 *   函式       SUM(a,b,...)、ROUND(x[,位數])、ROUNDUP、ROUNDDOWN、MIN、MAX、ABS、IF(條件,成立,不成立)
 *              CHILDREN()    這個科目底下所有子科目的合計(小計用)
 *              TAXDEDUCT()   勾選「貨物稅完稅價格可扣除」的科目合計
 *              REF("情境ID","科目代碼"[,"車系ID"])  引用另一個情境(可以是別的車型)的科目金額，
 *                            例如「一般材料以前代車型為基準 × 1.2」：REF("SC-xxx","b4") * 1.2
 *                            沒指定車系時：該情境有同一個車系就取那個車系，否則取加權平均
 *
 * 安全性：自己寫的遞迴下降解析器，不用 eval / new Function —— 公式來自使用者輸入、也會跟著
 * 資料包在同事之間交換，不能讓它有機會執行任意程式碼。
 *
 * 除以 0 的結果為 0（不是錯誤）：試算初期常常台數還沒填，整張損益表因此全部變成錯誤訊息
 * 反而看不出其他數字對不對。
 */

var FORMULA_FUNCTIONS = ['SUM', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'MIN', 'MAX', 'ABS', 'IF', 'CHILDREN', 'TAXDEDUCT', 'REF'];

/** 解析結果快取（同一段公式字串只解析一次） */
var FORMULA_AST_CACHE_ = {};

function formulaError_(message, pos) {
  var e = new Error(message + (pos !== undefined && pos !== null ? '（第 ' + (pos + 1) + ' 個字附近）' : ''));
  e.isFormulaError = true;
  return e;
}

/** 全形/數學符號 → 半形運算子 */
function normalizeFormulaText_(src) {
  return String(src === undefined || src === null ? '' : src)
    .replace(/[×＊]/g, '*').replace(/[÷／]/g, '/').replace(/[−–—－]/g, '-').replace(/＋/g, '+')
    .replace(/（/g, '(').replace(/）/g, ')').replace(/，/g, ',').replace(/［/g, '[').replace(/］/g, ']')
    .replace(/％/g, '%').replace(/＝/g, '=').replace(/[＜]/g, '<').replace(/[＞]/g, '>')
    .replace(/[“”]/g, '"').replace(/^\s*=/, '');
}

function tokenizeFormula_(src) {
  var s = normalizeFormulaText_(src);
  var tokens = [];
  var i = 0;
  while (i < s.length) {
    var ch = s.charAt(i);
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      var m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m) throw formulaError_('數字格式不正確', i);
      var n = Number(m[0]);
      i += m[0].length;
      tokens.push({ t: 'num', v: n, pos: i - m[0].length });
      continue;
    }
    if (ch === '[') {
      var end = s.indexOf(']', i);
      if (end === -1) throw formulaError_('中括號 [ 沒有對應的 ]', i);
      var name = s.slice(i + 1, end).trim();
      if (!name) throw formulaError_('中括號裡沒有名稱', i);
      tokens.push({ t: 'name', v: name, pos: i });
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      var close = s.indexOf(ch, i + 1);
      if (close === -1) throw formulaError_('字串缺少結尾的引號', i);
      tokens.push({ t: 'str', v: s.slice(i + 1, close), pos: i });
      i = close + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      var id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))[0];
      tokens.push({ t: 'id', v: id, pos: i });
      i += id.length;
      continue;
    }
    var two = s.substr(i, 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=') {
      tokens.push({ t: 'op', v: two === '!=' ? '<>' : two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/^(),%<>='.indexOf(ch) !== -1) {
      tokens.push({ t: 'op', v: ch, pos: i });
      i++;
      continue;
    }
    throw formulaError_('看不懂的字元「' + ch + '」', i);
  }
  tokens.push({ t: 'end', pos: s.length });
  return tokens;
}

/**
 * 遞迴下降解析：
 *   compare := additive ( (< > <= >= = <>) additive )*
 *   additive := term ( (+|-) term )*
 *   term := unary ( (*|/) unary )*
 *   unary := (+|-) unary | power
 *   power := postfix ( ^ unary )?
 *   postfix := primary %*
 */
function parseFormula_(src) {
  var key = String(src === undefined || src === null ? '' : src);
  if (FORMULA_AST_CACHE_[key]) return FORMULA_AST_CACHE_[key];
  var tokens = tokenizeFormula_(key);
  var p = 0;
  function peek() { return tokens[p]; }
  function isOp(v) { var t = tokens[p]; return t.t === 'op' && t.v === v; }
  function expectOp(v) {
    if (!isOp(v)) throw formulaError_('這裡應該是「' + v + '」', tokens[p].pos);
    p++;
  }
  function compare() {
    var left = additive();
    while (peek().t === 'op' && ['<', '>', '<=', '>=', '=', '<>'].indexOf(peek().v) !== -1) {
      var op = tokens[p++].v;
      left = { t: 'bin', op: op, a: left, b: additive() };
    }
    return left;
  }
  function additive() {
    var left = term();
    while (isOp('+') || isOp('-')) {
      var op = tokens[p++].v;
      left = { t: 'bin', op: op, a: left, b: term() };
    }
    return left;
  }
  function term() {
    var left = unary();
    while (isOp('*') || isOp('/')) {
      var op = tokens[p++].v;
      left = { t: 'bin', op: op, a: left, b: unary() };
    }
    return left;
  }
  function unary() {
    if (isOp('-')) { p++; return { t: 'neg', a: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  function power() {
    var base = postfix();
    if (isOp('^')) { p++; return { t: 'bin', op: '^', a: base, b: unary() }; }
    return base;
  }
  function postfix() {
    var node = primary();
    while (isOp('%')) { p++; node = { t: 'bin', op: '/', a: node, b: { t: 'num', v: 100 } }; }
    return node;
  }
  function primary() {
    var tok = tokens[p];
    if (tok.t === 'num') { p++; return { t: 'num', v: tok.v }; }
    if (tok.t === 'str') { p++; return { t: 'str', v: tok.v }; }
    if (tok.t === 'name') { p++; return { t: 'name', v: tok.v, pos: tok.pos }; }
    if (tok.t === 'id') {
      p++;
      if (isOp('(')) {
        var fname = tok.v.toUpperCase();
        if (FORMULA_FUNCTIONS.indexOf(fname) === -1) throw formulaError_('沒有「' + tok.v + '」這個函式', tok.pos);
        p++;
        var args = [];
        if (!isOp(')')) {
          args.push(compare());
          while (isOp(',')) { p++; args.push(compare()); }
        }
        expectOp(')');
        return { t: 'call', name: fname, args: args, pos: tok.pos };
      }
      return { t: 'code', v: tok.v, pos: tok.pos };
    }
    if (isOp('(')) {
      p++;
      var inner = compare();
      expectOp(')');
      return inner;
    }
    if (tok.t === 'end') throw formulaError_('公式不完整', tok.pos);
    throw formulaError_('這裡不應該出現「' + tok.v + '」', tok.pos);
  }
  if (peek().t === 'end') throw formulaError_('公式是空的');
  var ast = compare();
  if (peek().t !== 'end') throw formulaError_('多出了「' + peek().v + '」', peek().pos);
  FORMULA_AST_CACHE_[key] = ast;
  return ast;
}

/** 走訪 AST 收集引用：科目代碼、[名稱]、用到的函式 */
function formulaRefs_(ast) {
  var refs = { codes: [], names: [], calls: [], refCalls: [] };
  function add(list, v) { if (list.indexOf(v) === -1) list.push(v); }
  (function walk(n) {
    if (!n) return;
    if (n.t === 'code') add(refs.codes, n.v);
    else if (n.t === 'name') add(refs.names, n.v);
    else if (n.t === 'call') {
      add(refs.calls, n.name);
      if (n.name === 'REF') refs.refCalls.push(n);
      n.args.forEach(walk);
    } else if (n.t === 'bin') { walk(n.a); walk(n.b); }
    else if (n.t === 'neg') walk(n.a);
  })(ast);
  return refs;
}

/**
 * 計算 AST。env 提供：
 *   code(c)       → 科目金額(會觸發相依科目先算)
 *   name(n)       → [名稱] 的值(變數/參數/科目名稱)
 *   children()    → 子科目合計
 *   taxDeduct()   → 可扣除貨物稅的科目合計
 *   ref(sid, code, vid) → 跨情境引用
 */
function evalFormulaAst_(n, env) {
  switch (n.t) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'code': return toNumber_(env.code(n.v, n.pos));
    case 'name': return toNumber_(env.name(n.v, n.pos));
    case 'neg': return -num_(evalFormulaAst_(n.a, env));
    case 'bin': {
      var a = evalFormulaAst_(n.a, env), b = evalFormulaAst_(n.b, env);
      switch (n.op) {
        case '+': return num_(a) + num_(b);
        case '-': return num_(a) - num_(b);
        case '*': return num_(a) * num_(b);
        case '/': return num_(b) === 0 ? 0 : num_(a) / num_(b);
        case '^': return Math.pow(num_(a), num_(b));
        case '<': return num_(a) < num_(b) ? 1 : 0;
        case '>': return num_(a) > num_(b) ? 1 : 0;
        case '<=': return num_(a) <= num_(b) ? 1 : 0;
        case '>=': return num_(a) >= num_(b) ? 1 : 0;
        case '=': return (typeof a === 'string' || typeof b === 'string') ? (String(a) === String(b) ? 1 : 0) : (num_(a) === num_(b) ? 1 : 0);
        case '<>': return (typeof a === 'string' || typeof b === 'string') ? (String(a) !== String(b) ? 1 : 0) : (num_(a) !== num_(b) ? 1 : 0);
      }
      break;
    }
    case 'call': return evalFormulaCall_(n, env);
  }
  throw formulaError_('無法計算的公式片段');
}

function num_(v) { return typeof v === 'number' ? (isFinite(v) ? v : 0) : toNumber_(v); }

function evalFormulaCall_(n, env) {
  var args = n.args;
  var vals = function () { return args.map(function (a) { return num_(evalFormulaAst_(a, env)); }); };
  var need = function (min, max) {
    if (args.length < min || (max !== undefined && args.length > max)) {
      throw formulaError_(n.name + '() 的參數個數不正確', n.pos);
    }
  };
  var roundTo = function (x, digits, mode) {
    var f = Math.pow(10, digits || 0);
    var v = x * f;
    // 跟 Excel 一樣：ROUND 是「四捨五入、遠離 0」，負數 -2.5 → -3（JS 的 Math.round 會變 -2）
    if (mode === 'up') v = v < 0 ? -Math.ceil(-v - 1e-9) : Math.ceil(v - 1e-9);
    else if (mode === 'down') v = v < 0 ? -Math.floor(-v + 1e-9) : Math.floor(v + 1e-9);
    else v = v < 0 ? -Math.round(-v) : Math.round(v);
    return v / f;
  };
  switch (n.name) {
    case 'SUM': return vals().reduce(function (s, x) { return s + x; }, 0);
    case 'MIN': need(1); return Math.min.apply(null, vals());
    case 'MAX': need(1); return Math.max.apply(null, vals());
    case 'ABS': need(1, 1); return Math.abs(vals()[0]);
    case 'ROUND': need(1, 2); var r = vals(); return roundTo(r[0], r[1] || 0);
    case 'ROUNDUP': need(1, 2); var u = vals(); return roundTo(u[0], u[1] || 0, 'up');
    case 'ROUNDDOWN': need(1, 2); var d = vals(); return roundTo(d[0], d[1] || 0, 'down');
    case 'IF':
      need(2, 3);
      // 只算被選到的那一支：沒選到的分支裡可能引用了這個車系沒有的資料
      return num_(evalFormulaAst_(args[0], env)) ? evalFormulaAst_(args[1], env) : (args[2] ? evalFormulaAst_(args[2], env) : 0);
    case 'CHILDREN': need(0, 0); return env.children(n.pos);
    case 'TAXDEDUCT': need(0, 0); return env.taxDeduct(n.pos);
    case 'REF': {
      need(2, 3);
      var parts = args.map(function (a) { return evalFormulaAst_(a, env); });
      return env.ref(String(parts[0]), String(parts[1]), parts[2] === undefined ? '' : String(parts[2]), n.pos);
    }
  }
  throw formulaError_('沒有「' + n.name + '」這個函式', n.pos);
}

/**
 * 檢查公式語法並回傳引用清單；語法錯誤時回傳 { ok:false, error }，不丟例外。
 * 給「科目設定」頁面即時檢查用。
 */
function inspectFormula_(src) {
  try {
    var ast = parseFormula_(src);
    return { ok: true, ast: ast, refs: formulaRefs_(ast) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 公式文字的標準化（存檔前用）：去掉開頭的 = 與多餘空白，全形符號轉半形 */
function cleanFormulaText_(src) {
  return normalizeFormulaText_(src).replace(/\s+/g, ' ').trim();
}
