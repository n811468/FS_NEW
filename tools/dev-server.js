/**
 * 本機預覽伺服器：不用部署到 Apps Script 就能在瀏覽器打開整個前端。
 *
 *   node tools/dev-server.js            # http://localhost:8787
 *   PORT=9000 node tools/dev-server.js
 *
 * 做法：用 tools/fake-apps-script.js 的記憶體版試算表把 src/*.gs 跑起來，
 * 灌一組亂數產生的示範資料(Gate F 現況 + 目標情境、另一個車型)，然後把 index.html 的
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
const { seedDemo } = require('./demo-data');

const ROOT = path.join(__dirname, '..', 'src');
const PORT = Number(process.env.PORT) || 8787;

/* ---- 示範資料：亂數產生(固定種子)，內容見 tools/demo-data.js ---- */
function seedDemoData() {
  const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs']);
  seedDemo(gs, process.env.DEMO_SEED ? Number(process.env.DEMO_SEED) : undefined);
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
