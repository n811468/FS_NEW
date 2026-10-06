/**
 * 地端版瀏覽器端對端測試：用真的 Chromium 以 file:// 打開 dist/FS-local.html(跟使用者雙擊一樣)。
 *
 *   node tools/e2e-local.js
 *
 * 需要 Playwright(本專案不安裝任何套件，找不到時會說明並略過)。驗證：
 *   - 完全不連外部網路(所有非 file:// 的請求都會被擋下並記錄)，頁面沒有任何 JS 錯誤
 *   - 空資料庫有提示 → 載入示範資料 → 儀表板算得出來
 *   - 修改會自動暫存：重新整理後還在，工具列顯示「還沒整份備份」
 *   - 匯出全部 → 清空 → 用檔案選擇器匯入(取代) → 資料回來
 *   - 合併匯入：只更新資料包裡的車型
 *   - 同時開兩個分頁：一邊存檔後，另一邊停止寫入並提示重新整理
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { demoNames } = require('./demo-data');
// 示範資料的車型代號是亂數產生的(固定種子)：主車型 MAIN(有現況/目標與作法)、另一個車型 OTHER
const { main: MAIN, other: OTHER } = demoNames();

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright'];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* 試下一個 */ }
  }
  return null;
}

const DIST = path.join(__dirname, '..', 'dist', 'FS-local.html');
const URL_ = 'file://' + DIST;
const failures = [];
let checks = 0;
const ERRS = [];
function assert(cond, message) { checks++; if (!cond) failures.push(message); }

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.log('找不到 Playwright，略過瀏覽器端對端測試（node tools/verify-local.js 已涵蓋後端邏輯）。'); return; }
  if (!fs.existsSync(DIST)) { console.log('找不到 dist/FS-local.html，請先執行 node tools/build-local.js'); process.exit(1); }

  // 沒設定語系的 Linux 環境(如 CI 容器)裡，Chromium 存不了中文檔名、會改叫 download；
  // Windows / macOS 上的 Chrome、Edge 不受影響，這裡補上 UTF-8 語系讓測試環境跟實際一致
  const launchOpts = { headless: true, env: Object.assign({}, process.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }) };
  if (fs.existsSync('/opt/pw-browsers/chromium')) {
    // 雲端環境預裝的 Chromium；本機有自己的 Playwright 瀏覽器就用預設的
    try { await pw.chromium.launch(launchOpts).then(b => b.close()); } catch (e) { launchOpts.executablePath = '/opt/pw-browsers/chromium'; }
  }
  const browser = await pw.chromium.launch(launchOpts);
  // E2E_ONLY=dev：只跑開發總投從零開始(改這一頁時快速檢查)
  if (process.env.E2E_ONLY === 'dev') {
    await devFromScratch(browser, () => { });
    await browser.close();
    if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
    console.log(`開發總投從零開始：${checks} 項全部符合`);
    return;
  }
  const context = await browser.newContext({ acceptDownloads: true });
  const external = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('file://') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    external.push(url);
    return route.abort();
  });
  const errors = ERRS;
  const watch = page => {
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('dialog', d => { if (d.type() === 'alert') errors.push('alert: ' + d.message()); d.accept(); });   // confirm() 一律按確定；alert 代表出錯
  };

  const page = await context.newPage();
  watch(page);
  await page.goto(URL_);
  await page.waitForSelector('#fs-local-bar');
  assert(await page.isVisible('#fs-local-banner.fsl-banner-info'), '空資料庫時應該顯示「可以匯入或載入示範資料」的提示');

  // 載入示範資料(整頁重新載入)
  await Promise.all([page.waitForNavigation(), page.selectOption('#fs-local-bar .fsl-more', 'demo')]);
  await page.waitForFunction(() => document.querySelectorAll('#vehicletype-selector option').length >= 2);
  const types = await page.$$eval('#vehicletype-selector option', os => os.map(o => o.value));
  assert(types.includes(MAIN) && types.includes(OTHER), `示範資料載入後車型選單應該有 ${MAIN}、${OTHER}：` + types.join(','));
  assert(!types.includes('DA') && !types.includes('DE'), '示範資料不該有 DA/DE：' + types.join(','));

  // 儀表板算得出來
  await page.click('nav button[data-tab="dashboard"]');
  await page.waitForFunction(() => /營業淨利/.test(document.getElementById('dashboard-content').textContent || ''), null, { timeout: 15000 });
  assert(!(await page.isVisible('#global-error')), '儀表板顯示錯誤：' + (await page.textContent('#global-error')));
  // 儀表板沒有自己的差異比較/損益瀑布了：「瀑布圖…」選同一欄 = 單一欄位損益，帶到瀑布圖工具
  assert(!(await page.$('.dash-subnav-btn:has-text("差異比較")')), '儀表板不該再有「差異比較」子頁');
  await page.click('.dash-subnav button:has-text("瀑布圖…")');
  await page.waitForSelector('dialog.modal select#mf-1');
  await page.selectOption('dialog.modal select#mf-1', '0');
  await page.click('dialog.modal button[value=ok]');
  await page.waitForFunction(() => document.querySelectorAll('#wf-chart .wf-bar').length >= 3, null, { timeout: 15000 });
  assert(await page.$('#wf-body .seg-btn.active:has-text("單一欄位損益")'), '儀表板的「瀑布圖…」選同一欄應該開成單一欄位損益');

  // 頁首 ☰：寬螢幕把側邊欄收成只剩圖示，重新整理後還記得；再按一次展開
  await page.click('.sidebar-toggle');
  assert(await page.waitForFunction(() => document.body.classList.contains('nav-collapsed') && document.querySelector('.sidebar').getBoundingClientRect().width < 80,
    null, { timeout: 3000 }).then(() => true, () => false), '按 ☰ 側邊欄要收成只剩圖示');
  assert(await page.getAttribute('.nav-item[data-tab="dashboard"]', 'data-tip') === '損益儀表板', '收起來時滑鼠移上去要看得到頁名');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#vehicletype-selector option').length >= 2);
  assert(await page.evaluate(() => document.body.classList.contains('nav-collapsed')), '重新整理後側邊欄維持收起來');
  await page.click('.sidebar-toggle');
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width > 200);
  assert(!(await page.evaluate(() => document.body.classList.contains('nav-collapsed'))), '再按一次展開');

  // 儀表板：比較欄位裡有一個車系在這個情境沒有銷售構成 → 只略過那一欄、說明原因，可以一鍵移除
  await page.click('nav button[data-tab="dashboard"]');
  await page.waitForFunction(() => /營業淨利/.test(document.getElementById('dashboard-content').textContent || ''), null, { timeout: 15000 });
  await page.evaluate(() => new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail)
    .saveVehicle({ VehicleID: 'E2E-NOMIX', VehicleTypeID: document.getElementById('vehicletype-selector').value, VehicleCode: '入門' })));
  const colsBefore = await page.evaluate(() => comparisonSelections.length);
  await page.evaluate(() => { comparisonSelections.push({ ScenarioID: currentScenarioId, VehicleID: 'E2E-NOMIX' }); refreshDashboard(true); });
  await page.waitForSelector('#dashboard-content .dash-unavailable', { timeout: 15000 });
  assert(/入門/.test(await page.textContent('.dash-unavailable')) && /銷售構成/.test(await page.textContent('.dash-unavailable')), '要說明哪一欄、為什麼算不出來');
  assert(!/計算失敗/.test(await page.textContent('#dashboard-content')), '其他欄位不能因為這一欄整個算不出來');
  await page.click('.dash-unavailable button:has-text("從比較欄位移除")');
  await page.waitForFunction(n => !document.querySelector('.dash-unavailable') && comparisonSelections.length === n, colsBefore, { timeout: 15000 });
  await page.evaluate(() => new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail).deleteVehicle('E2E-NOMIX')));

  // 參數與匯率同一頁：兩個表格都改，Ctrl+S 一次兩個都存
  await page.click('nav button[data-tab="paramrates"]');
  await page.waitForSelector('#grid-paramrates .rate-global');
  await page.waitForSelector('#grid-paramfx .fx-cell');
  await page.fill('#grid-paramrates .rate-global[data-name="營業稅率"]', '6');
  await page.fill('#grid-paramfx .fx-cell >> nth=0', '4.321');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.getElementById('savebar').classList.contains('show'), null, { timeout: 10000 });
  const savedParams = await page.evaluate(() => {
    const sc = document.getElementById('scenario-selector').value;
    return Promise.all([
      new Promise(ok => google.script.run.withSuccessHandler(ok).getRateGrid(sc, document.getElementById('vehicletype-selector').value)),
      new Promise(ok => google.script.run.withSuccessHandler(ok).getFxGrid(sc))
    ]);
  });
  const vat = savedParams[0].rates.find(r => r.ParamName === '營業稅率');
  const fxVals = [].concat.apply([], savedParams[1].rows.map(r => Object.keys(r.cells).map(k => Number(r.cells[k].Value))));
  assert(vat && Number(vat.globalValue) === 6 && fxVals.indexOf(4.321) !== -1, 'Ctrl+S 應該把參數與匯率兩個表格都存起來：' + JSON.stringify({ vat: vat && vat.globalValue, fxVals }));

  // v2：GATE 報告每一張投影片都畫得出來
  await page.click('nav button[data-tab="report"]');
  await page.waitForFunction(() => document.querySelectorAll('#panel-report .slide').length >= 6, null, { timeout: 15000 });
  assert(/目標成本作法/.test(await page.textContent('#panel-report')), 'GATE 報告應該有「目標成本作法」');
  assert(/差距/.test(await page.textContent('#panel-report .slide')), '報告第一頁應該有現況與目標的差距');

  // 目前情境就是報告的目標情境、這次開頁還沒進過「目標反推」頁：敏感度投影片也要畫得出來
  const targetScenario = await page.$$eval('#scenario-selector option', os => (os.find(o => /目標/.test(o.textContent)) || {}).value);
  await page.selectOption('#scenario-selector', targetScenario);
  await page.click('nav button[data-tab="report"]');
  await page.waitForFunction(() => document.querySelector('#rpt-sens .sens-table') || document.querySelector('#rpt-sens .callout.err') ||
    (document.getElementById('global-error') && document.getElementById('global-error').offsetParent), null, { timeout: 15000 });
  assert(!(await page.isVisible('#global-error')), '目標情境開 GATE 報告顯示錯誤：' + (await page.textContent('#global-error')));
  assert(await page.$('#rpt-sens .sens-table'), '目標情境開 GATE 報告時，敏感度投影片應該有表格');
  // 敏感度投影片的開關在報告頁：取消勾選就拿掉那一張，再勾回來
  await page.uncheck('#panel-report label:has-text("附敏感度分析") input');
  await page.waitForFunction(() => !document.getElementById('rpt-sens'), null, { timeout: 10000 });
  await page.check('#panel-report label:has-text("附敏感度分析") input');
  await page.waitForSelector('#rpt-sens .sens-table', { timeout: 15000 });

  // v2：科目與公式 —— 改季Margin 的公式，Ctrl+S 存檔，後端真的換成新公式
  await page.click('nav button[data-tab="lineitems"]');
  await page.waitForSelector('.tree-row:has-text("季Margin")');
  await page.click('.tree-row:has-text("季Margin")');
  // 拆得成一行一項的公式預設用一行一項：一行「廠價(未稅) × 季Margin率」，每行旁邊有試算值
  await page.waitForSelector('.fx-rows .fx-row');
  assert((await page.$$('.fx-rows .fx-row')).length === 1 && /廠價\(未稅\)/.test(await page.textContent('.fx-rows')) && /季Margin率/.test(await page.textContent('.fx-rows')),
    '季Margin 應該顯示成一行：廠價(未稅) × 季Margin率');
  await page.waitForFunction(() => /\d/.test((document.querySelector('.fx-row-val') || {}).textContent || ''));
  // 自由公式 → 文字輸入
  await page.click('.fx-mode [data-mode="chips"]');
  await page.waitForSelector('#ce-chips .fx-chip');
  await page.click('button:has-text("用文字輸入")');
  await page.waitForSelector('#ce-formula');
  await page.fill('#ce-formula', 'P8 * 1%');
  await page.waitForFunction(() => /✔/.test((document.getElementById('ce-status') || {}).textContent || ''));
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.getElementById('savebar').classList.contains('show'));
  const d4 = await page.evaluate(t => new Promise(ok => google.script.run.withSuccessHandler(ok).getPLLineItems(t)), MAIN);
  assert(d4.find(l => l.LineCode === 'd4').Formula === 'P8 * 1%', '科目與公式存檔後，後端的公式應該換成新的');
  const de4 = await page.evaluate(t => new Promise(ok => google.script.run.withSuccessHandler(ok).getPLLineItems(t)), OTHER);
  assert(de4.find(l => l.LineCode === 'd4').Formula === 'P8 * [季Margin率]', '改主車型的公式不該影響另一個車型的科目表');

  // v2.1：公式用科目名稱顯示；輸入 [ 會跳出清單，選了之後存成代碼
  await page.click('.tree-row:has-text("季Margin")');
  await page.waitForSelector('#ce-formula');   // 同一個科目重畫時保留使用者選的模式(文字輸入)
  assert((await page.inputValue('#ce-formula')) === '[廠價(未稅)] * 1%', '公式應該用科目名稱顯示：' + await page.inputValue('#ce-formula'));
  await page.fill('#ce-formula', '');
  await page.click('#ce-formula');
  await page.keyboard.type('[廠價');
  await page.waitForSelector('#ce-ac:not([hidden]) .ac-item');
  await page.keyboard.press('Enter');
  await page.keyboard.type('* [季Margin率]');
  await page.waitForFunction(() => /✔/.test((document.getElementById('ce-status') || {}).textContent || ''));
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.getElementById('savebar').classList.contains('show'));
  const d4b = await page.evaluate(t => new Promise(ok => google.script.run.withSuccessHandler(ok).getPLLineItems(t)), MAIN);
  assert(d4b.find(l => l.LineCode === 'd4').Formula === 'P8 * [季Margin率]', '自動完成選的科目應存成代碼：' + d4b.find(l => l.LineCode === 'd4').Formula);

  // v2.2：一行一項從頭組公式 —— 加一項 → 搜尋選科目 → 乘參數 → 減一項選子科目合計，存成代碼
  await page.click('.fx-mode [data-mode="chips"]');
  await page.click('.fx-mode [data-mode="rows"]');
  await page.waitForSelector('.fx-rows');
  await page.click('.fx-row .fx-del');
  await page.click('button:has-text("＋ 加一項")');
  await page.waitForSelector('.fx-picker');
  await page.keyboard.type('廠價');
  await page.keyboard.press('Enter');
  await page.click('.fx-add-factor');
  await page.waitForSelector('.fx-picker');
  await page.keyboard.type('季Margin率');
  await page.keyboard.press('Enter');
  await page.click('button:has-text("− 減一項")');
  await page.waitForSelector('.fx-picker');
  await page.click('.fx-pk-item:has-text("固定金額")');
  await page.fill('.fx-row:nth-child(2) .fx-num', '100');
  await page.waitForFunction(() => /✔/.test((document.getElementById('ce-status') || {}).textContent || ''));
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.getElementById('savebar').classList.contains('show'));
  const d4c = await page.evaluate(t => new Promise(ok => google.script.run.withSuccessHandler(ok).getPLLineItems(t)), MAIN);
  assert(d4c.find(l => l.LineCode === 'd4').Formula === 'P8 * [季Margin率] - 100', '一行一項組的公式應存成代碼：' + d4c.find(l => l.LineCode === 'd4').Formula);
  // 拆不成一行一項的公式(貨物稅)自動用自由公式(膠囊)，每顆膠囊底下有目前的值
  await page.click('.tree-row:has-text("貨物稅")');
  await page.waitForSelector('#ce-chips .fx-chip.kind-param');
  await page.waitForFunction(() => /%/.test((document.querySelector('#ce-chips .fx-chip.kind-param .cv') || {}).textContent || ''));

  // 從 Excel 貼上一整塊數字到銷貨成本(成本與費用頁的子頁籤)
  await page.click('nav button[data-tab="costs"]');
  await page.click('#panel-costs .dash-subnav-btn:has-text("銷貨成本")');
  await page.waitForSelector('input[data-line="b4"]');
  await page.evaluate(() => {
    const el = document.querySelector('input[data-line="b4"]'); el.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', '1,111\t2,222\t3,333\n');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  const pasted = await page.$$eval('input[data-line="b4"]', els => els.map(e => e.value).join(','));
  assert(pasted === '1111,2222,3333', '從 Excel 貼上的一整列應該依序填入各車系：' + pasted);
  // 表格裡按 ↓ / Enter 是換到下一列同一欄，不能把數字框的值加減 1
  await page.focus('input[data-line="b4"]');
  await page.keyboard.press('ArrowDown');
  const afterDown = await page.evaluate(() => ({ v: document.querySelector('input[data-line="b4"]').value, line: document.activeElement.dataset.line }));
  assert(afterDown.v === '1111' && afterDown.line && afterDown.line !== 'b4', '按 ↓ 應該換到下一列、數字不變：' + JSON.stringify(afterDown));
  await page.click('#savebar-discard');
  await page.click('#panel-costs .dash-subnav-btn:has-text("營業費用")');
  await page.waitForSelector('#grid-operatingexpense table');
  assert(!(await page.$('#grid-costofsales')), '切到營業費用子頁籤後，銷貨成本的表格應該換掉');

  // v2.1：目標反推頁算得出答案、GATE 報告有作法對帳與敏感度表
  await page.click('nav button[data-tab="whatif"]');
  await page.waitForSelector('button:has-text("損益兩平要賣多少錢")');
  await page.click('button:has-text("損益兩平要賣多少錢")');
  await page.waitForSelector('#wi-multi-result .goal-answer, #wi-multi-result .callout', { timeout: 15000 });
  assert(/建議零售價/.test(await page.textContent('#wi-multi-result')), '目標反推(只有一項)應該回答售價要調到多少');
  await page.click('nav button[data-tab="report"]');
  await page.waitForFunction(() => /作法對帳/.test(document.getElementById('panel-report').textContent) &&
    document.querySelector('#rpt-sens .sens-table'), null, { timeout: 15000 });

  // 差距拆解：「調整長條」把前兩個科目合併成一根，長條少一根、終點不變
  const bridgeTips = () => page.$$eval('#rpt-bridge rect.bar', rs => rs.map(r => r.getAttribute('data-tip')));
  const tipsBefore = await bridgeTips();
  await page.click('#rpt-bridge-edit');
  await page.waitForSelector('dialog .bridge-group');
  const groupInputs = await page.$$('dialog .bridge-group');
  await groupInputs[0].fill('合併測試');
  await groupInputs[1].fill('合併測試');
  await page.click('dialog button[value=ok]');
  await page.waitForFunction(n => document.querySelectorAll('#rpt-bridge rect.bar').length === n - 1, tipsBefore.length, { timeout: 5000 });
  const tipsAfter = await bridgeTips();
  assert(tipsAfter.some(t => /^合併測試\n/.test(t)), '合併後應該有一根「合併測試」：' + tipsAfter.join(' | '));
  assert(tipsAfter[tipsAfter.length - 1] === tipsBefore[tipsBefore.length - 1], '合併科目不應該改變目標營業淨利');
  assert(/2 個科目已合併/.test(await page.textContent('#rpt-bridge .bridge-tools')), '長條上方要提示目前的合併設定');

  // 敏感度：直列改成自訂值，預填目前值附近的數字；改成自己的數字後表格照著算
  await page.click('nav button[data-tab="whatif"]');
  await page.waitForSelector('#wi-sens-row');
  await page.click(`.seg-btn[onclick*="setSensMode_('row','value')"]`);
  await page.waitForSelector('#wi-sens-row-values');
  assert((await page.inputValue('#wi-sens-row-values')).split(',').length === 5, '切到自訂值時應該依目前的變動 % 預填 5 個值');
  await page.selectOption('#wi-sens-row', 'volume');
  await page.fill('#wi-sens-row-values', '100, 250, 600');
  await page.click('button:has-text("產生表格")');
  await page.waitForFunction(() => {
    const heads = Array.from(document.querySelectorAll('#wi-sens-result .sens-table tbody .row-head')).map(td => td.textContent);
    return heads.length === 4 && heads.some(h => /^250/.test(h.trim()));
  }, null, { timeout: 15000 });
  assert(await page.$('#wi-sens-result .sens-table .sens-base'), '自訂值的表格也要框出目前的數字');
  await page.click(`.seg-btn[onclick*="setSensMode_('row','pct')"]`);

  // 調整影響試算(正推)：材料降 3% → 損益表每一行的變動；兩項時拆出每一項的影響
  await page.click('nav button[data-tab="whatif"]');
  await page.waitForSelector('#wi-impact-body tr');
  await page.click('#wi-impact button:has-text("試算")');
  await page.waitForSelector('#wi-impact-result .impact-table', { timeout: 15000 });
  const impactProfit = await page.textContent('#wi-impact-result .impact-table tr.impact-profit');
  assert(/\+/.test(impactProfit), '成本降 3%，營業淨利那一行應該變好：' + impactProfit);
  await page.click('#wi-impact button:has-text("加一項調整")');
  await page.waitForFunction(() => document.querySelectorAll('#wi-impact-body tr').length === 2);
  await page.fill('#wi-impact-body tr:nth-child(2) input[type=number]', '2');
  await page.dispatchEvent('#wi-impact-body tr:nth-child(2) input[type=number]', 'change');
  await page.click('#wi-impact button:has-text("試算")');
  await page.waitForFunction(() => document.querySelectorAll('#wi-impact-result .impact-table thead th').length === 7, null, { timeout: 15000 });
  await page.click('#wi-impact-result .seg-btn:has-text("月總額")');
  assert(/元\/月/.test(await page.textContent('#wi-impact-result')), '切到月總額要換單位');
  await page.click('#wi-impact-body tr:nth-child(2) button[aria-label="刪除"]');

  // 目標反推(組合拳)：三種方式各一(已知調整、負責金額、補足缺口)，結果表 + 瀑布圖，可以帶到瀑布圖工具
  await page.click('nav button[data-tab="whatif"]');
  await page.waitForSelector('#wi-multi');
  await page.click('button:has-text("組合拳範例")');
  await page.waitForFunction(() => document.querySelectorAll('#wi-lever-body tr').length === 4);
  const modes = await page.$$eval('#wi-lever-body select.lever-mode', ss => ss.map(s => s.value));
  assert(modes.join() === 'known,amount,fill,fill', '組合拳範例應該是 已知調整、負責金額、補足缺口×2：' + modes.join());
  // 目標 = 目前營業淨利 + 3 萬(要改善才達得到)
  const planTarget = await page.evaluate(() => Math.round(whatIfOptions.metrics.find(m => m.code === profitCodeOf_(whatIfOptions)).value + 30000));
  await page.fill('#wi-multi-target', String(planTarget));
  await page.click('#wi-multi button:has-text("計算")');
  await page.waitForSelector('#wi-multi-result .lever-table', { timeout: 30000 });
  const planText = await page.textContent('#wi-multi-result');
  assert(/可以達成/.test(planText), '組合拳應該達得到：' + planText.slice(0, 200));
  assert(/已知調整/.test(planText) && /負責金額/.test(planText) && /補足缺口/.test(planText), '結果表要列出每一項的方式');
  const planBars = (await page.$$('#wi-multi-result .wf-bar')).length;
  assert(planBars >= 4, '組合拳的瀑布圖至少要有 目前 + 兩項 + 達成：' + planBars);
  await page.click('#wi-multi-result button:has-text("在瀑布圖工具開啟")');
  await page.waitForSelector('#wf-manual-body tr');
  assert((await page.$$('#wf-chart .wf-bar')).length === planBars, '帶到瀑布圖工具(自訂)後根數應該一樣');

  // 瀑布圖工具：兩個欄位的差異，每一根加總要剛好接到終點；可以下載 PNG
  await page.click('#wf-body .seg-btn:has-text("兩個欄位的差異")');
  await page.waitForFunction(() => document.querySelectorAll('#wf-chart .wf-bar').length >= 3 && document.querySelector('#wf-table tbody tr'), null, { timeout: 15000 });
  const wfRows = await page.$$eval('#wf-table tbody tr', rs => rs.map(r => Array.from(r.querySelectorAll('td')).map(td => td.textContent.trim())));
  const numOf = t => Number(String(t).replace(/[,+]/g, ''));
  const last = wfRows[wfRows.length - 1];
  assert(Math.abs(numOf(last[1]) - numOf(wfRows[wfRows.length - 2][2])) <= 1, '差異拆解的累計要剛好接到終點：' + JSON.stringify(wfRows.slice(-2)));
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('#wf-body button:has-text("下載 PNG")')]);
  assert(/\.png$/.test(dl.suggestedFilename()), '下載 PNG 的檔名：' + dl.suggestedFilename());
  for (const mode of ['單一欄位損益', '原因拆解']) {
    await page.click(`#wf-body .seg-btn:has-text("${mode}")`);
    await page.waitForFunction(() => document.querySelectorAll('#wf-chart .wf-bar').length >= 3, null, { timeout: 15000 });
  }
  // 原因拆解看單一科目：材料成本-KD 現況 → 原因 → 目標；原因直接在這裡填，存到終點情境(跟 GATE 報告的作法同一份)
  await page.waitForSelector('#wf-act-line option[value="b2"]', { state: 'attached' });
  await page.selectOption('#wf-act-line', 'b2');
  await page.waitForFunction(() => /材料成本-KD/.test(document.getElementById('wf-heading').textContent) && document.querySelector('.wf-act-table'), null, { timeout: 15000 });
  const barsBefore = (await page.$$('#wf-chart .wf-bar')).length;
  await page.click('#wf-act-editor button:has-text("新增原因")');
  await page.fill('#wf-act-editor tbody tr:last-child input[type=text]', 'E2E規格追加');
  await page.selectOption('#wf-act-editor tbody tr:last-child td:nth-child(3) select', 'bad');
  await page.fill('#wf-act-editor tbody tr:last-child input[type=number]', '5000');
  await page.waitForFunction(n => document.querySelectorAll('#wf-chart .wf-bar').length > n, barsBefore, { timeout: 5000 });
  assert(/E2E規格追加/.test(await page.textContent('#wf-table')), '新填的原因要馬上出現在瀑布圖');
  await page.click('#wf-act-editor button:has-text("儲存原因")');
  await page.waitForFunction(() => !document.getElementById('savebar').classList.contains('show'), null, { timeout: 10000 });
  const savedActs = await page.evaluate(() => new Promise(ok => google.script.run.withSuccessHandler(ok).getActions(wfPrefs.to.scenarioId)));
  const added = savedActs.find(x => x.Title === 'E2E規格追加');
  assert(added && Number(added.Effect) === -5000 && added.LineCode === 'b2', '惡化 5,000 要存成效果 −5000、科目 b2：' + JSON.stringify(added));
  assert(savedActs.length > 1, '存原因時不能把其他科目的作法洗掉：' + savedActs.length);
  // 成本科目的瀑布：成本變多(惡化)是紅色
  const badColor = await page.$$eval('#wf-chart .wf-bar', rs => { const r = rs.find(x => /E2E規格追加/.test(x.getAttribute('data-tip') || '')); return r && r.getAttribute('fill'); });
  assert(badColor === '#e53e3e', '成本科目惡化的長條應該是紅色：' + badColor);
  await page.click('#wf-act-editor tbody tr:last-child button[aria-label="刪除"]');
  await page.click('#wf-act-editor button:has-text("儲存原因")');
  await page.waitForFunction(() => !document.getElementById('savebar').classList.contains('show'), null, { timeout: 10000 });

  // GATE 報告：現況 → 作法 → 目標 瀑布投影片
  await page.click('nav button[data-tab="report"]');
  await page.waitForFunction(() => document.querySelectorAll('#rpt-act-wf .wf-bar').length >= 3, null, { timeout: 15000 });
  assert(/現況 → 作法 → 目標/.test(await page.textContent('#panel-report')), 'GATE 報告應該有「現況 → 作法 → 目標」');

  // 情境快照：車型與情境頁存一份 → 出現在清單 → 加到儀表板 → 跟現在比較(瀑布圖)
  await page.click('nav button[data-tab="masters"]');
  await page.waitForSelector('#snapshot-card button:has-text("把目前情境存成快照")');
  await page.click('#snapshot-card button:has-text("把目前情境存成快照")');
  await page.waitForSelector('dialog.modal input#mf-0');
  await page.fill('dialog.modal input#mf-0', '審議版E2E');
  await page.click('dialog.modal button[value=ok]');
  await page.waitForSelector('#snapshot-body td:has-text("審議版E2E")', { timeout: 10000 });
  await page.click('#snapshot-body button:has-text("加到儀表板")');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.pl-table thead th')).some(th => /快照 審議版E2E/.test(th.textContent)), null, { timeout: 15000 });
  const snapK = await page.$$eval('.pl-table tbody tr', rs => {
    const r = rs.find(x => x.querySelector('td.row-head[data-l="K"]'));
    return r ? Array.from(r.querySelectorAll('td.amt')).map(td => td.textContent.trim()) : [];
  });
  assert(snapK.length >= 2 && snapK.some((v, i) => snapK.indexOf(v) !== i), '快照欄位的營業淨利應該跟現在一樣(剛存的)：' + snapK.join(','));
  await page.click('nav button[data-tab="masters"]');
  await page.waitForSelector('#snapshot-body button:has-text("跟現在比較")');
  await page.click('#snapshot-body button:has-text("跟現在比較")');
  await page.waitForFunction(() => document.querySelectorAll('#wf-chart .wf-bar').length >= 2, null, { timeout: 15000 });
  assert(/快照 審議版E2E/.test(await page.textContent('#wf-heading')), '瀑布圖工具起點應該是快照：' + await page.textContent('#wf-heading'));

  // v2：拖曳把手可以用鍵盤 Alt+↓ 調整車系順序，放開(按下)就存檔
  await page.click('nav button[data-tab="masters"]');
  await page.waitForSelector('#entity-body-vehicles .drag-handle');
  const before = await page.evaluate(t => new Promise(ok => google.script.run.withSuccessHandler(ok).getVehicles(t)), MAIN);
  await page.focus('#entity-body-vehicles tr:first-child .drag-handle');
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForTimeout(500);
  const after = await page.evaluate(t => new Promise(ok => google.script.run.withSuccessHandler(ok).getVehicles(t)), MAIN);
  assert(after[1].VehicleID === before[0].VehicleID, '用鍵盤把第一個車系往下移，應該立即存成新的順序');

  // 新增情境改成對話框：名稱跟著情境性質自動帶入，建立後出現在情境表格
  await page.click('#master-scenarios button:has-text("新增情境…")');
  await page.waitForSelector('dialog.modal #mf-2');
  await page.selectOption('dialog.modal #mf-1', '目標');
  assert(/^目標\d{4}$/.test(await page.inputValue('dialog.modal #mf-2')), '改情境性質時，自動帶入的名稱要跟著變');
  await page.fill('dialog.modal #mf-2', 'E2E新情境');
  await page.click('dialog.modal button[value=ok]');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#entity-body-scenarios input')).some(i => i.value === 'E2E新情境'), null, { timeout: 10000 });

  // 科目樹拖曳(Alt+↓ 把「廣宣費用」往下移)之後，儀表板仍然是 Excel 的順序：明細在上、銷貨毛利在下，前瞻費用在營業淨利前
  await page.click('nav button[data-tab="lineitems"]');
  await page.waitForSelector('.tree-block[data-key="d1"] .drag-handle');
  await page.focus('.tree-block[data-key="d1"] > .tree-row .drag-handle');
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForFunction(() => { const b = document.querySelector('.tree-block[data-key="d1"]'); return b && b.previousElementSibling && b.previousElementSibling.getAttribute('data-key') === 'd2'; }, null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const treeOrder = await page.$$eval('#chart-tree-body .tree-row', rs => rs.map(r => r.closest('.tree-block').getAttribute('data-key')));
  assert(treeOrder.indexOf('d5') < treeOrder.indexOf('E') && treeOrder.indexOf('E') < treeOrder.indexOf('f1'), '科目樹：銷貨毛利應該在明細下面：' + treeOrder.join(','));
  await page.click('nav button[data-tab="dashboard"]');
  await page.waitForFunction(() => /營業淨利/.test(document.getElementById('dashboard-content').textContent || ''), null, { timeout: 15000 });
  const dashOrder = await page.$$eval('.pl-table tbody tr td.row-head', ts => ts.map(t => t.getAttribute('data-l')));
  const at = c => dashOrder.indexOf(c);
  assert(at('d2') < at('d1') && at('d1') < at('E') && at('d5') < at('E') && at('C') < at('d2'), '儀表板：明細要在銷貨毛利上面：' + dashOrder.join(','));
  assert(at('h4') < at('I') && at('I') < at('J') && at('J') < at('K') && at('b13') < at('C'), '儀表板：I、J、K 跟 Excel 同順序：' + dashOrder.join(','));

  // 透過前端同一條路徑(google.script.run)改資料：新增車型 DQ
  await page.evaluate(() => new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail)
    .saveVehicleTypeGrid([{ VehicleTypeID: 'DQ', Notes: '端對端測試' }])));
  await page.waitForFunction(() => /還沒整份備份/.test(document.getElementById('fs-local-bar').textContent));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#vehicletype-selector option').length >= 3);
  assert((await page.$$eval('#vehicletype-selector option', os => os.map(o => o.value))).includes('DQ'), '重新整理後新增的車型不見了（沒有暫存）');

  // 匯出全部
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#fs-local-bar .fsl-menu summary').then(() => page.click('#fs-local-bar button:has-text("匯出全部")'))]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-local-'));
  const packFile = path.join(tmp, download.suggestedFilename());
  await download.saveAs(packFile);
  const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  assert(/^FS資料包_全部_\d{8}-\d{4}\.json$/.test(download.suggestedFilename()), '匯出檔名格式不對：' + download.suggestedFilename());
  assert(pack.tables.VehicleTypes.length === 3, '匯出的資料包應該有 3 個車型');
  assert(!/還沒整份備份/.test(await page.textContent('#fs-local-bar')), '整份匯出後「還沒整份備份」提示應該消失');

  // 只匯出車型(OTHER)，之後拿來測合併
  await page.selectOption('#vehicletype-selector', OTHER);
  await page.waitForTimeout(300);
  const [dlDe] = await Promise.all([page.waitForEvent('download'), page.click('#fs-local-bar .fsl-menu summary').then(() => page.click('#fs-local-bar button:has-text("匯出車型")'))]);
  const deFile = path.join(tmp, dlDe.suggestedFilename());
  await dlDe.saveAs(deFile);
  assert(JSON.parse(fs.readFileSync(deFile, 'utf8')).tables.VehicleTypes.map(r => r.VehicleTypeID).join() === OTHER, '「匯出車型」應該只有 ' + OTHER);

  // 匯出情境：只有上方選的那一個情境
  await page.selectOption('#vehicletype-selector', MAIN);
  const daIds = await page.evaluate(t => new Promise(ok => google.script.run.withSuccessHandler(ok).getScenarios(t)), MAIN).then(l => l.map(x => x.ScenarioID).sort());
  // 換車型後情境選單會重建：等到選單裡剛好是主車型的情境、而且已經選定一個
  await page.waitForFunction(ids => {
    const sel = document.getElementById('scenario-selector');
    const vals = Array.from(sel.options).map(o => o.value).filter(v => v).sort();
    return JSON.stringify(vals) === JSON.stringify(ids) && ids.indexOf(sel.value) !== -1;
  }, daIds, { timeout: 10000 });
  const daScenarioCount = await page.$$eval('#scenario-selector option', os => os.filter(o => o.value).length);
  const curScenario = await page.inputValue('#scenario-selector');
  const [dlSc] = await Promise.all([page.waitForEvent('download'), page.click('#fs-local-bar .fsl-menu summary').then(() => page.click('#fs-local-bar button:has-text("匯出情境")'))]);
  const scPack = JSON.parse(fs.readFileSync(await dlSc.path(), 'utf8'));
  assert(daScenarioCount >= 2 && scPack.scope.kind === 'scenarios' && scPack.tables.Scenarios.length === 1 && scPack.tables.Scenarios[0].ScenarioID === curScenario,
    '「匯出情境」應該只有目前選的情境：' + JSON.stringify(scPack.scope));
  assert(new RegExp('^FS資料包_' + MAIN + '_').test(dlSc.suggestedFilename()), '情境資料包的檔名應該帶車型與情境：' + dlSc.suggestedFilename());

  // 清空 → 用匯入取代 → 資料回來
  // 清空要先在對話框確認(用系統自己的對話框，不是瀏覽器的 confirm)
  await page.selectOption('#fs-local-bar .fsl-more', 'reset');
  await page.waitForSelector('dialog.modal[open]');
  assert(/清空所有資料/.test(await page.textContent('dialog.modal[open]')), '清空前應該先問');
  await Promise.all([page.waitForNavigation(), page.click('dialog.modal[open] button[value=ok]')]);
  await page.waitForSelector('#fs-local-bar');
  assert((await page.$$eval('#vehicletype-selector option', os => os.filter(o => o.value).length)) === 0, '清空後應該沒有車型');
  await page.setInputFiles('#fs-local-bar input[type=file]', packFile);
  await page.waitForSelector('#fs-local-dialog[open]');
  await page.click('#fs-local-dialog button:has-text("取代整個資料庫")');
  await page.waitForSelector('dialog.modal[open]');
  await Promise.all([page.waitForNavigation(), page.click('dialog.modal[open] button[value=ok]')]);
  await page.waitForFunction(() => document.querySelectorAll('#vehicletype-selector option').length >= 3);
  assert((await page.$$eval('#vehicletype-selector option', os => os.map(o => o.value).filter(v => v))).sort().join() === [MAIN, OTHER, 'DQ'].sort().join(), '匯入取代後車型不對');

  // 合併：刪掉 OTHER 再合併 OTHER 的資料包 → OTHER 回來、主車型/DQ 不受影響
  await page.evaluate(t => new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail).deleteVehicleType(t)), OTHER);
  await page.reload();
  await page.waitForSelector('#fs-local-bar');
  await page.setInputFiles('#fs-local-bar input[type=file]', deFile);
  await page.waitForSelector('#fs-local-dialog[open]');
  await page.click('#fs-local-dialog button:has-text("合併匯入")');
  await page.waitForSelector('#fs-local-dialog >> text=確認合併內容');
  // 刪除車型會連車系/情境一起刪掉，所以合併時 OTHER 是「新增」
  assert(new RegExp('車型 ' + OTHER + '：(新增|本機沒有這個車型)').test(await page.textContent('#fs-local-dialog')), '合併確認畫面沒有列出要新增的車型 ' + OTHER);
  await Promise.all([page.waitForNavigation(), page.click('#fs-local-dialog button:has-text("確定合併")')]);
  await page.waitForFunction(() => document.querySelectorAll('#vehicletype-selector option').length >= 3);
  assert((await page.$$eval('#vehicletype-selector option', os => os.map(o => o.value).filter(v => v))).sort().join() === [MAIN, OTHER, 'DQ'].sort().join(), '合併後車型不對');

  // 兩個分頁：第二個分頁存檔後，第一個分頁停止寫入
  const page2 = await context.newPage();
  watch(page2);
  await page2.goto(URL_);
  await page2.waitForSelector('#fs-local-bar');
  await page2.evaluate(() => new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail)
    .saveVehicleTypeGrid([{ VehicleTypeID: 'DR', Notes: '' }])));
  await page.waitForSelector('#fs-local-banner.fsl-banner-danger', { timeout: 5000 });
  const staleErr = await page.evaluate(() => new Promise(ok => google.script.run.withSuccessHandler(() => ok('')).withFailureHandler(e => ok(e.message))
    .saveVehicleTypeGrid([{ VehicleTypeID: 'DS', Notes: '' }])));
  assert(/另一個/.test(staleErr), '另一個分頁存檔後，這一頁應該拒絕寫入：' + staleErr);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#vehicletype-selector option').length >= 4);
  assert((await page.$$eval('#vehicletype-selector option', os => os.map(o => o.value))).includes('DR'), '重新整理後應該看到另一個分頁新增的車型');

  // 「這一頁暫停存檔」造成的錯誤是刻意的，其他任何 JS 錯誤都不該出現
  const unexpected = errors.filter(e => !/另一個視窗或分頁/.test(e));
  assert(unexpected.length === 0, '頁面有 JS 錯誤：' + unexpected.join(' | '));
  assert(external.length === 0, '地端版不該連外部網路，卻請求了：' + external.join(', '));

  // 開發總投：另開一個全新的資料庫(空白)，從一張空表開始全部用畫面操作
  await devFromScratch(browser, launchErrors => errors.push(...launchErrors));

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  if (failures.length) {
    console.log(`地端版瀏覽器測試失敗：${failures.length} 項（共 ${checks} 項）`);
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`地端版瀏覽器測試通過：${checks} 項全部符合（file:// 開啟、不連外部網路、GATE 報告、科目與公式、自動完成、Excel 貼上、目標反推、多項反推、調整影響試算、開發總投從零開始、側邊欄收合、儀表板略過算不出來的欄位、瀑布圖工具、情境快照、拖曳排序、暫存/匯出/匯入/合併/多分頁保護）。`);
}

/**
 * 開發總投從零開始：全新的瀏覽器資料(空資料庫) → 只建一個車型、一個目標情境(攤提基準 100 台/月 × 5 年 = 6,000 台)，
 * 開發總投頁從空表開始，全部用畫面操作：新增部門、右側面板加筆數、格子直接打數字、低減 %、資產/費用分開、
 * 統一低減目標、從 Excel 貼上、部門說明、刪除部門、儲存後重新整理還在，最後跟後端的攤提彙總與 GATE 報告對數字。
 */
let devPage_ = null;   // 失敗時截圖用
async function devFromScratch(browser, reportErrors) {
  const ctx = await browser.newContext();
  await ctx.route('**/*', route => (/^(file|blob|data):/.test(route.request().url()) ? route.continue() : route.abort()));
  const page = await ctx.newPage();
  devPage_ = page;
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('dialog', d => d.accept());
  const run = (fn, ...args) => page.evaluate(([fn, args]) => new Promise((ok, fail) =>
    google.script.run.withSuccessHandler(ok).withFailureHandler(e => fail(new Error(e.message)))[fn](...args)), [fn, args]);
  const cellText = async (dept, nth) => (await page.locator(`#dev-body tr[data-dept="${dept}"] td`).nth(nth).innerText()).trim();
  const inputVal = (dept, c) => page.inputValue(`#dev-body tr[data-dept="${dept}"] input[data-c="${c}"]`);
  const typeCell = async (dept, c, v) => {
    const sel = `#dev-body tr[data-dept="${dept}"] input[data-c="${c}"]`;
    await page.click(sel);
    await page.fill(sel, String(v));
    await page.keyboard.press('Enter');
  };
  // 欄位：0 部門 | 1 模具 2 設備 3 費用 4 總計 | 5 低減目標 | 6 模具 7 設備 8 費用 9 總計(低減後) | 10 說明
  const openDrawer = async dept => { await page.click(`#dev-body tr[data-dept="${dept}"] .dept-btn`); await page.waitForSelector('#dev-drawer'); };
  const closeDrawer = async () => { await page.click('#dev-drawer footer button:has-text("完成")'); await page.waitForSelector('#dev-drawer', { state: 'detached' }); };

  await page.goto(URL_);
  await page.waitForSelector('#fs-local-bar');
  assert(await page.isVisible('#fs-local-banner.fsl-banner-info'), '開發總投從零開始：應該是空資料庫');
  await run('saveVehicleTypeGrid', [{ VehicleTypeID: 'EZ', Notes: '' }]);
  await run('saveScenario', { ScenarioID: '', Gate: 'GATE F', ScenarioName: '目標', ScenarioType: '目標', VehicleTypeID: 'EZ',
    AmortMonthlyVolume: 100, AmortLifeCycleYears: 5 });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('vehicletype-selector').value === 'EZ' && document.getElementById('scenario-selector').value);
  await page.click('nav button[data-tab="devinvestment"]');
  await page.waitForSelector('#grid-devinvestment .empty-state');
  assert(/還沒有開發總投/.test(await page.textContent('#grid-devinvestment')), '空表要有說明怎麼開始');

  // 1. 新增部門 → 右側面板：改名、加一筆模具、一筆費用、低減 10%
  await page.click('#toolbar-devinvestment button:has-text("新增部門")');
  await page.waitForSelector('#dev-drawer');
  await page.fill('#dev-dr-name', '開發部');
  await page.press('#dev-dr-name', 'Tab');
  await page.click('#dev-drawer button:has-text("加一筆模具")');
  await page.fill('#dev-drawer .dev-cat[data-cat="模具"] .dev-item input.amt', '1000000');
  await page.press('#dev-drawer .dev-cat[data-cat="模具"] .dev-item input.amt', 'Tab');
  await page.fill('#dev-drawer .dev-cat[data-cat="模具"] .dev-item input[aria-label="項目"]', '四門一蓋模具');
  await page.press('#dev-drawer .dev-cat[data-cat="模具"] .dev-item input[aria-label="項目"]', 'Tab');
  await page.click('#dev-drawer button:has-text("加一筆費用")');
  await page.fill('#dev-drawer .dev-cat[data-cat="費用"] .dev-item input.amt', '200000');
  await page.press('#dev-drawer .dev-cat[data-cat="費用"] .dev-item input.amt', 'Tab');
  await page.fill('#dev-drawer input[aria-label="全部低減%"]', '10');
  await page.press('#dev-drawer input[aria-label="全部低減%"]', 'Tab');
  await closeDrawer();
  assert(await cellText('開發部', 1) === '1,000,000' || await inputVal('開發部', '模具') === '1,000,000', '開發部模具 1,000,000');
  assert(await cellText('開發部', 4) === '1,200,000', '開發部總計 1,200,000：' + await cellText('開發部', 4));
  assert(await cellText('開發部', 9) === '1,080,000', '開發部低減後 10% = 1,080,000：' + await cellText('開發部', 9));
  assert(await page.isVisible('#savebar.show'), '改過之後底部要出現儲存提示');

  // 2. 第二個部門：在主表格子直接打數字(Enter 往下)
  await page.click('#toolbar-devinvestment button:has-text("新增部門")');
  await page.fill('#dev-dr-name', '生技部');
  await page.press('#dev-dr-name', 'Tab');
  await closeDrawer();
  await typeCell('生技部', '設備', '3,000,000');
  await typeCell('生技部', 'pct', '15');
  assert(await cellText('生技部', 9) === '2,550,000', '生技部設備 300 萬低減 15% = 2,550,000：' + await cellText('生技部', 9));
  assert(await page.$('#dev-body tr[data-dept="生技部"] td.dirty'), '改過的格子要標出來');

  // 3. 統一低減目標 10% → 全部部門
  await page.fill('#dev-all-pct', '10');
  await page.click('#toolbar-devinvestment button:has-text("套用到全部部門")');
  assert(await inputVal('生技部', 'pct') === '10', '套用到全部部門後生技部是 10%');

  // 4. 開發部資產、費用分開：費用 20%
  await openDrawer('開發部');
  await page.click('#dev-drawer .seg-btn:has-text("資產、費用分開")');
  await page.fill('#dev-drawer input[aria-label="費用低減%"]', '20');
  await page.press('#dev-drawer input[aria-label="費用低減%"]', 'Tab');
  await closeDrawer();
  assert(await cellText('開發部', 5) === '資 10%｜費 20%', '分開後低減目標顯示「資 10%｜費 20%」：' + await cellText('開發部', 5));
  assert(await cellText('開發部', 9) === '1,060,000', '模具 90 萬 + 費用 16 萬 = 1,060,000：' + await cellText('開發部', 9));

  // 5. 開發部費用再加一筆：這一格變成「好幾筆」，不能直接改
  await openDrawer('開發部');
  await page.click('#dev-drawer button:has-text("加一筆費用")');
  await page.locator('#dev-drawer .dev-cat[data-cat="費用"] .dev-item input.amt').nth(1).fill('50000');
  await page.locator('#dev-drawer .dev-cat[data-cat="費用"] .dev-item input.amt').nth(1).press('Tab');
  await closeDrawer();
  assert(await page.$('#dev-body tr[data-dept="開發部"] td:nth-child(4) button.lock'), '費用有兩筆時要變成點了開面板的格子');
  assert(await cellText('開發部', 3) === '250,000', '費用兩筆合計 250,000：' + await cellText('開發部', 3));

  // 6. 從 Excel 貼上：開發部費用(兩筆)金額不同 → 先不改；生技部設備改 320 萬、低減後 288 萬；新部門品管部；說明
  const tsv = ['\t\t\t\t\t10.00%', '部門\t模具\t設備\t費用\t總計\t模具\t設備\t費用\t總計\t說明',
    '開發部\t1,000,000\t\t260,000\t1,260,000\t900,000\t\t208,000\t1,108,000\t開發四門一蓋',
    '生技部\t\t3,200,000\t-\t3,200,000\t\t2,880,000\t-\t2,880,000\t"新設ROOF激光站\n研磨站"',
    '品管部\t\t\t500,000\t500,000\t-\t-\t450,000\t450,000\t檢具'].join('\n');
  await page.click('#toolbar-devinvestment button:has-text("從 Excel 貼上")');
  await page.waitForSelector('dialog.dev-paste[open]');
  await page.fill('#dev-paste-text', tsv);
  await page.waitForSelector('#dev-paste-preview details');
  const todo = await page.textContent('#dev-paste-preview details[data-kind="todo"]');
  assert(/開發部/.test(todo) && /2 筆/.test(todo), '開發部費用有兩筆、金額不同，要列在「要你看一下」：' + todo);
  assert(/生技部/.test(await page.textContent('#dev-paste-preview details[data-kind="chg"]')), '生技部設備要列在「會更新」');
  assert(/品管部/.test(await page.textContent('#dev-paste-preview details[data-kind="new"]')), '品管部要列在「會新增」');
  await page.click('#dev-paste-ok');
  await page.waitForSelector('dialog.dev-paste', { state: 'detached' });
  assert(await cellText('開發部', 3) === '250,000', '開發部費用(兩筆)貼上時不該被改');
  assert(await inputVal('生技部', '設備') === '3,200,000' && await cellText('生技部', 9) === '2,880,000', '生技部設備 320 萬、低減後 288 萬');
  assert(await inputVal('品管部', '費用') === '500,000' && await inputVal('品管部', 'pct') === '10', '品管部費用 50 萬、低減 10%');
  assert(/新設ROOF激光站/.test(await cellText('生技部', 10)), '貼上的說明要出現在說明欄');

  // 7. 說明：點說明欄 → 面板 → 改
  await page.click('#dev-body tr[data-dept="品管部"] td.c-note button');
  await page.waitForSelector('#dev-dr-note');
  await page.fill('#dev-dr-note', '四門一蓋檢具x6套');
  await page.press('#dev-dr-note', 'Tab');
  await closeDrawer();

  // 8. 儲存 → 重新整理 → 還在
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.getElementById('savebar').classList.contains('show'), null, { timeout: 10000 });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('scenario-selector').value);
  await page.click('nav button[data-tab="devinvestment"]');
  await page.waitForSelector('#dev-body tr');
  const depts = await page.$$eval('#dev-body .dept-btn', bs => bs.map(b => b.closest('tr').getAttribute('data-dept')));
  assert(depts.join() === '開發部,生技部,品管部', '重新整理後部門順序：' + depts.join());
  assert(await cellText('開發部', 5) === '資 10%｜費 20%' && await cellText('開發部', 9) === '1,100,000', '開發部 模具 90 萬 + 費用 25 萬×0.8 = 1,100,000：' + await cellText('開發部', 9));
  assert(/四門一蓋檢具x6套/.test(await cellText('品管部', 10)), '部門說明存得起來');
  const totalRed = 1100000 + 2880000 + 450000;
  assert((await page.locator('#grid-devinvestment tfoot td').nth(9).innerText()).trim() === totalRed.toLocaleString('en-US'), '合計低減後');
  // 後端：攤提彙總(6,000 台)、GATE 報告開發總投 by 部門
  const sid = await page.inputValue('#scenario-selector');
  const sum = await run('getDevInvestmentSummary', sid);
  const tot = sum.targets.reduce((s, t) => s + t.Total, 0);
  assert(Math.abs(tot - totalRed) < 1 && sum.lifeCycleUnits === 6000, '攤提彙總要等於低減後合計：' + tot);
  const item = sum.rows.find(r => r.Notes === '四門一蓋模具');
  assert(item && item.Amount === 1000000, '面板裡的項目名稱存在那一筆上');
  const rep = await run('getGateReport', sid, sid, '');
  const qa = (rep.dev || rep.target && rep.target.dev || { rows: [] }).rows.find(r => r.Department === '品管部');
  assert(qa && qa.notes === '四門一蓋檢具x6套' && Math.abs(qa.reduced - 450000) < 1, 'GATE 報告開發總投 by 部門要用部門說明：' + JSON.stringify(qa));

  // 9. 刪除部門 → 儲存 → 不見了；部門說明跟著刪
  await openDrawer('品管部');
  await page.click('#dev-drawer button:has-text("刪除這個部門")');
  await page.click('dialog.modal[open] button[value=ok]');
  await page.waitForSelector('#dev-drawer', { state: 'detached' });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.getElementById('savebar').classList.contains('show'), null, { timeout: 10000 });
  const after = await run('getDevInvestmentSummary', sid);
  assert(!after.rows.some(r => r.Department === '品管部') && !after.deptNotes['品管部'], '刪除部門後明細與說明都要刪掉');
  // 每一筆明細檢視也看得到
  await page.click('#toolbar-devinvestment .seg-btn:has-text("每一筆明細")');
  assert((await page.$$('#grid-devinvestment table.dev-list tbody tr')).length === 4, '明細：開發部 3 筆 + 生技部 1 筆');

  assert(errs.length === 0, '開發總投從零開始：頁面有 JS 錯誤：' + errs.join(' | '));
  reportErrors([]);
  await ctx.close();
}

main().catch(async e => {
  if (devPage_) { const shot = path.join(os.tmpdir(), 'e2e-dev-fail.png'); try { await devPage_.screenshot({ path: shot, fullPage: true }); console.error('失敗畫面：' + shot); } catch (x) { /* 已關閉 */ } } console.error(e); if (ERRS.length) console.error('頁面錯誤：', ERRS.join(' | ')); process.exit(1); });
