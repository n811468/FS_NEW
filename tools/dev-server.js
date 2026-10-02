/**
 * 本機預覽伺服器：不用部署到 Apps Script 就能在瀏覽器打開整個前端。
 *
 *   node tools/dev-server.js            # http://localhost:8787
 *   PORT=9000 node tools/dev-server.js
 *
 * 做法：用 tools/fake-apps-script.js 的記憶體版試算表把 src/*.gs 跑起來，
 * 灌一組示範資料(Gate F 現況 + 目標情境、另一個車型)，然後把 index.html 的
 * `<?!= include('style'); ?>` 這類樣板語法替換成實際檔案內容，並補上一個假的
 * `google.script.run`：前端呼叫什麼後端函式，就 POST /rpc 到這裡、由 Node 端的 .gs 執行後回傳。
 *
 * 前端 src/ui/*.js / style.html 完全是原檔，不需要為了本機預覽另外改寫；
 * 每次重新整理頁面都會重新讀檔，改完前端存檔、按 F5 就看得到。
 * 資料只存在記憶體，重啟伺服器就回到示範資料。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadAppsScript } = require('./fake-apps-script');
const gatef = require('./verify-gatef');

const ROOT = path.join(__dirname, '..', 'src');
const PORT = Number(process.env.PORT) || 8787;

/* ---- 示範資料：Gate F 現況(來自驗算腳本)、由它衍生的目標情境、再加一個別的車型 ---- */
function seedDemoData() {
  const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs']);
  const baselineId = gatef.buildScenario(gs);

  gs.getBootstrap('DA');   // 開頁時的資料升級：DA 有自己的一份科目表

  // 現況的科目說明(簡報「說明」欄)
  gs.saveLineNotes(baselineId, {
    b1: 'LP件：BASE廠報價展開，座椅/車身尚未低減', b2: 'BASE廠報價 CNY62,500，平均關稅率13%',
    b4: '生技部提供，先以 DE×1.2 倍放入計算', b6: '生技部工時 × 24~26 平均費率', b7: '含物流工時、品檢',
    b9: '使用中華標，沒有 BASE 廠跟 MMC 標相關技酬金', b12: '主要為 2 次鋰電池 1,950 元/台',
    b13: '客貨車貨物稅率 15%，提撥金以各車型廣促計算', d1: '依業務部提供', d2: '依業務部提供',
    f1: '2024~2026 年平均', h1: '2024~2026 年平均'
  });

  // 目標情境：整批帶入現況資料，再依「目標成本作法」調整
  const target = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE F', ScenarioName: '901 目標', ScenarioType: '目標',
    VehicleTypeID: 'DA', CreatedDate: '2026-08-15', Notes: '示範：材料成本低減、開發總投挑戰低減 20%'
  }, baselineId, []);
  const targetId = target.ScenarioID;
  const cost = gs.getCostOfSalesMatrix(targetId, 'DA');
  const factor = { b1: 0.72, b2: 0.83 };   // LP 件 -28%(座椅/車身/式樣/VAVE)、KD 件議價 -17%
  const cells = [];
  Object.keys(cost.values).forEach(code => {
    Object.keys(cost.values[code]).forEach(vehicleId => {
      const cell = cost.values[code][vehicleId];
      const amount = Number(cell.Amount) || 0;
      cells.push({ RowID: cell.RowID || '', VehicleID: vehicleId, LineCode: code,
        Amount: factor[code] ? Math.round(amount * factor[code]) : (code === 'b11' ? 0 : amount), Currency: cell.Currency || 'TWD', Notes: '' });
    });
  });
  gs.saveCostOfSalesMatrix(targetId, cells);
  const dev = gs.getDevInvestmentSummary(targetId);
  gs.saveDevInvestmentGrid(targetId, dev.rows.map(r => Object.assign({}, r, { ChallengeReductionPct: 20 })));
  gs.saveLineNotes(targetId, {
    b1: 'LP件：座椅 -3.1萬、車身 -3.3萬、式樣低減 1.1萬、VAVE', b2: 'BASE廠目標報價 CNY59,000，平均關稅率13%',
    b5: 'C/D 20%，NTD 14.80→11.84 億元', b8: 'C/D 20%，NTD 4.96→3.97 億元', b11: '取消防鏽',
    f3: 'C/D 20%，NTD 7.00→5.60 億元', f4: 'NTD 3.49 億元(CNY 6,000 萬)'
  });
  gs.saveActions(targetId, [
    { Title: '座椅低減：新增 BASE 廠座椅供應商與國內競價', LineCode: 'b1', Owner: '採購部', Effect: 31294, Status: '進行中' },
    { Title: '車身低減：設計整合優化，台份成本 100,000 為目標', LineCode: 'b1', Owner: '產工部', Effect: 32992, Status: '進行中' },
    { Title: '式樣變更：車燈 LED→鹵素、外觀素材色(加權)', LineCode: 'b1', Owner: '業務部', Effect: 11024, Status: '已確認' },
    { Title: 'VAVE 改善：Benchmark 競車、D→K 可行性評估', LineCode: 'b1', Owner: '開發部', Effect: 80184, Status: '規劃中' },
    { Title: 'K件議價：CNY 62,500 → 59,000', LineCode: 'b2', Owner: '採購部', Effect: 18391, Status: '進行中' },
    { Title: '開發總投挑戰低減 20%(發估海外廠商、擴大共用 BASE 車零件)', LineCode: 'b5', Owner: '開發部', Effect: 9400, Status: '規劃中' },
    { Title: '取消防鏽', LineCode: 'b11', Owner: '業務部', Effect: 764, Status: '已確認' }
  ]);

  // 另一個車型：科目表跟 DA 不同(沒有 KD 件、多一個「動力電池」)，用來看「每個車型各自一份科目表」與跨車型比較
  gs.createVehicleType('DE', '示範車型', '');
  gs.saveVehicle({ VehicleID: 'DE1', VehicleTypeID: 'DE', VehicleCode: '5人休旅' });
  const battery = gs.addLineItemInline('B', '動力電池', 'DE');
  const de = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE E', ScenarioName: '1015', ScenarioType: '現況', VehicleTypeID: 'DE', CreatedDate: '2026-08-20'
  }, '', []);
  gs.saveSalesMixGrid(de.ScenarioID, 'DE', [
    { RowID: '', VehicleID: 'DE1', SalesMixPct: 100, MonthlyVolume: 300, LifeCycleYears: 8,
      ListPriceTaxIncl: 1450000, MandatoryAccessoryPrice: 20000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }
  ]);
  gs.saveCostOfSalesMatrix(de.ScenarioID, [
    { RowID: '', VehicleID: 'DE1', LineCode: 'b1', Amount: 650000, Currency: 'TWD' },
    { RowID: '', VehicleID: 'DE1', LineCode: battery.LineCode, Amount: 98000, Currency: 'TWD' },
    { RowID: '', VehicleID: 'DE1', LineCode: 'b6', Amount: 21000, Currency: 'TWD' },
    { RowID: '', VehicleID: 'DE1', LineCode: 'b7', Amount: 33000, Currency: 'TWD' }
  ]);
  gs.deletePLLineItem('b2', 'DE');
  gs.saveOperatingExpenseMatrix(de.ScenarioID, [
    { RowID: '', VehicleID: 'DE1', LineCode: 'd1', Amount: 8000 },
    { RowID: '', VehicleID: 'DE1', LineCode: 'd2', Amount: 25000 },
    { RowID: '', VehicleID: 'DE1', LineCode: 'h1', Amount: 45000 }
  ]);
  return gs;
}

/* ---- 樣板：把 <?!= include('xxx'); ?> 換成檔案內容，再塞進假的 google.script.run ---- */
const RUN_STUB = `
<script>
  // 本機預覽用的 google.script.run 替身：呼叫鏈跟真的一樣，實際是 POST /rpc 給 dev-server
  window.google = window.google || {};
  google.script = {
    run: new Proxy({}, {
      get(_, fn) {
        const state = { ok: r => r, fail: e => console.error(e) };
        const chain = new Proxy({}, {
          get(_, name) {
            if (name === 'withSuccessHandler') return h => { state.ok = h; return chain; };
            if (name === 'withFailureHandler') return h => { state.fail = h; return chain; };
            if (name === 'withUserObject') return () => chain;
            return (...args) => {
              fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fn: name, args }) })
                .then(r => r.json())
                .then(res => { if (res.error) state.fail(new Error(res.error)); else state.ok(res.result); })
                .catch(err => state.fail(err));
            };
          }
        });
        return chain[fn];
      }
    }),
    host: { close() { } }
  };
</script>`;

function renderIndex() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  html = html.replace(/<\?!=\s*include\('([^']+)'\);?\s*\?>/g, (m, name) =>
    name === 'script' ? require('./frontend').frontendScript() : fs.readFileSync(path.join(ROOT, name + '.html'), 'utf8'));
  // 假的 google.script.run 要在前端程式之前就位
  return html.replace('<body>', '<body>' + RUN_STUB);
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
  });
}

function start() {
  let gs = seedDemoData();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.indexOf('/?') === 0)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderIndex());
      return;
    }
    if (req.method === 'POST' && req.url === '/reset') {
      gs = seedDemoData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === 'POST' && req.url === '/rpc') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
        if (typeof gs[payload.fn] !== 'function' || /_$/.test(payload.fn)) {
          throw new Error('沒有這個後端函式：' + payload.fn);
        }
        // 模擬 google.script.run：每次呼叫都是新的執行，單次執行內的快取要清掉
        gs.SHEET_CACHE_ = {};
        gs.resetCalcMemo_();
        const result = gs[payload.fn].apply(null, payload.args || []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: result === undefined ? null : result }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  server.listen(PORT, () => {
    console.log(`本機預覽：http://localhost:${PORT}  （示範資料在記憶體，POST /reset 可重灌）`);
  });
  return server;
}

if (require.main === module) start();
module.exports = { start, seedDemoData, renderIndex };
