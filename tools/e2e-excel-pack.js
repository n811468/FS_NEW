/**
 * 「Excel 轉資料包」瀏覽器端對端測試：用真的 Chromium 以 file:// 打開 dist/FS-excel-to-pack.html。
 *
 *   node tools/e2e-excel-pack.js
 *
 * 需要 Playwright(找不到時略過)。驗證：
 *   - 不連外部網路、沒有 JS 錯誤；用瀏覽器內建的解壓縮讀 .xlsx
 *   - 選檔後自動判斷欄位與每一列；同版面的分頁標示「可一起轉」
 *   - 故意把一列改成「略過」→ 驗算會抓到不相同；改回來 → 全部相同
 *   - 公式轉換：顯示轉好的系統公式與帶入數字的原因；單列關掉公式、改參數名稱；自動改回數字的列會列出來
 *   - 開發攤提：追到開發總投的列顯示「開發攤提」、直接打數字的列可以勾選回推；匯入地端版後開發總投頁有部門明細
 *   - 下載資料包 → 在 dist/FS-local.html「合併匯入」→ 車型與兩個情境都在、數字跟 Excel 相同
 *   - 對應設定會記住：重新選同一個檔案時沿用上次的調整
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const fixture = require('./excel-fixture');

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright'];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* 試下一個 */ }
  }
  return null;
}

const DIST = path.join(__dirname, '..', 'dist');
const failures = [];
let checks = 0;
function assert(cond, message) { checks++; if (!cond) failures.push(message); }

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.log('找不到 Playwright，略過瀏覽器端對端測試（node tools/verify-excel-pack.js 已涵蓋核心邏輯）。'); return; }
  const launchOpts = { headless: true, env: Object.assign({}, process.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }) };
  if (fs.existsSync('/opt/pw-browsers/chromium')) {
    try { await pw.chromium.launch(launchOpts).then(b => b.close()); } catch (e) { launchOpts.executablePath = '/opt/pw-browsers/chromium'; }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-excel-'));
  const fx = fixture.fixtureWorkbook();
  const xlsx = path.join(tmp, 'dq-fs.xlsx');
  fs.writeFileSync(xlsx, fx.bytes);

  const browser = await pw.chromium.launch(launchOpts);
  const context = await browser.newContext({ acceptDownloads: true });
  const external = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^(file|blob|data):/.test(url)) return route.continue();
    external.push(url);
    return route.abort();
  });
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => { if (d.type() === 'alert') errors.push('alert: ' + d.message()); d.accept(); });

  await page.goto('file://' + path.join(DIST, 'FS-excel-to-pack.html'));
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
  assert(await page.isHidden('#xp-card-rows'), '還沒選檔時不顯示對應表');
  await page.setInputFiles('#xp-file', xlsx);
  await page.waitForSelector('#xp-card-rows:not([hidden])');

  const vehicleNames = await page.$$eval('[data-vname]:not([disabled])', els => els.map(e => e.value));
  assert(vehicleNames.join() === '3人貨車,9人商用,9人接駁', '車系欄：' + vehicleNames.join());
  assert(await page.$eval('#xp-wcol', s => s.value) === '7', '加權欄應為 G');
  assert(await page.$eval('[data-role="13"]', s => s.value) === 'sub:B', '第 13 列應判斷為 B');
  assert(await page.$eval('[data-parent="15"]', s => s.value) === 'r14', '第 15 列應掛在第 14 列群組底下');
  const sheetRows = await page.$$eval('#xp-sheets tbody tr', trs => trs.map(tr => tr.textContent));
  assert(sheetRows.some(t => /DQ FS_目標/.test(t) && /版面相同/.test(t)), '同版面的分頁要標示可一起轉');
  assert(sheetRows.some(t => /參數/.test(t) && /隱藏/.test(t)), '隱藏分頁要標示');
  await page.check('[data-inc="1"]');
  await page.fill('#xp-type', 'DQ');
  await page.dispatchEvent('#xp-type', 'change');

  // 故意略過「貨物稅」→ 驗算要抓到
  await page.selectOption('[data-role="20"]', 'skip');
  await page.click('#xp-run');
  await page.waitForSelector('#xp-result .xp-note');
  assert(/跟 Excel 不一樣/.test(await page.textContent('#xp-result .xp-note')), '漏掉一列時驗算要抓到');
  assert(await page.$$eval('#xp-result tr.bad', trs => trs.length) > 0, '不相同的列要標紅');

  // 改回來
  await page.selectOption('[data-role="20"]', 'detail');
  await page.selectOption('[data-parent="20"]', 'B');
  await page.click('#xp-run');
  await page.waitForSelector('#xp-result .xp-note');
  const note = await page.textContent('#xp-result .xp-note');
  assert(/驗算通過/.test(note), '改回來之後應該全部相同：' + note);
  const summaries = await page.$$eval('#xp-result summary', s => s.map(x => x.textContent));
  assert(summaries.length === 2 && summaries.every(s => /✓/.test(s)), '兩個分頁都通過：' + summaries.join(' | '));

  // 公式轉換
  const calc = async r => (await page.$eval(`[data-role="${r}"]`, el => el.closest('tr').querySelector('.xp-calc').textContent)).trim();
  assert(/公式.*\[CNY匯率\].*\[關稅率\]/.test(await calc(16)), '第 16 列顯示轉好的公式：' + await calc(16));
  assert(/數字.*其他分頁「參數」/.test(await calc(22)), '第 22 列顯示帶入數字的原因：' + await calc(22));
  assert(/數字.*對不起來/.test(await calc(17)), '驗算後自動改回數字的列要顯示原因：' + await calc(17));
  const fbNote = await page.$$eval('#xp-result > .xp-note', n => n.map(x => x.textContent).join(' '));
  assert(/第 17 列「內陸運雜」/.test(fbNote), '結果要列出改回數字的列：' + fbNote);
  assert(await page.$('[data-pname="cell:P8"]') !== null, '參數表要列出關稅率');
  await page.fill('[data-pname="cell:P8"]', '進口關稅率');
  await page.dispatchEvent('[data-pname="cell:P8"]', 'change');
  await page.uncheck('[data-fon="25"]');
  assert(/數字.*手動改為帶入數字/.test(await calc(25)), '單列關掉公式：' + await calc(25));
  await page.click('#xp-run');
  await page.waitForSelector('#xp-result .xp-note');
  assert(/驗算通過/.test(await page.textContent('#xp-result .xp-note')), '改參數名稱、關掉一列公式後仍通過');
  assert(/\[進口關稅率\]/.test(await calc(16)), '公式跟著用新的參數名稱：' + await calc(16));

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#xp-download')]);
  const packFile = path.join(tmp, 'pack.json');
  await dl.saveAs(packFile);
  assert(/^FS資料包_DQ_\d{8}-\d{4}\.json$/.test(dl.suggestedFilename()), '下載檔名：' + dl.suggestedFilename());
  const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  assert(pack.format === 'FS-損益試算資料包' && pack.tables.Scenarios.length === 2 && pack.tables.Vehicles.length === 3, '資料包內容');
  assert(pack.tables.ParamDefs.some(d => d.ParamName === '進口關稅率'), '資料包帶著改過名稱的參數');
  const kdLine = pack.tables.PLLineItems.find(d => d.LineName === '材料成本-KD');
  assert(kdLine && kdLine.CalcType === 'FORMULA' && /\[CNY匯率\]/.test(kdLine.Formula), '資料包裡的科目是公式：' + (kdLine && kdLine.Formula));

  // 重新選同一個檔：沿用剛才的對應(第 20 列改過的 parent 留著)
  await page.setInputFiles('#xp-file', xlsx);
  await page.waitForSelector('#xp-card-rows:not([hidden])');
  assert(/已套用上次/.test(await page.textContent('#xp-rows')), '重新選同一個檔案時要沿用上次的對應');

  // 在地端版合併匯入
  const app = await context.newPage();
  app.on('pageerror', e => errors.push('FS-local: ' + e.message));
  await app.goto('file://' + path.join(DIST, 'FS-local.html'));
  await app.waitForSelector('#fs-local-bar');
  await app.setInputFiles('#fs-local-bar input[type=file]', packFile);
  await app.waitForSelector('#fs-local-dialog[open]');
  await app.click('#fs-local-dialog button:has-text("合併匯入")');
  await app.waitForSelector('#fs-local-dialog >> text=確認合併內容');
  await Promise.all([app.waitForNavigation(), app.click('#fs-local-dialog button:has-text("確定合併")')]);
  await app.waitForFunction(() => [...document.querySelectorAll('#vehicletype-selector option')].some(o => o.value === 'DQ'));
  const k = await app.evaluate(() => new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail).getScenarios('DQ')))
    .then(scs => app.evaluate(ids => new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail)
      .calculateComparison(ids.map(id => ({ ScenarioID: id, VehicleID: '' })))), scs.map(s => s.ScenarioID)));
  [0, 1].forEach(i => {
    const got = k.columns[i].amounts.K;
    assert(Math.abs(got - fx.expected[i][31][3]) < 0.01, `匯入後第 ${i + 1} 個情境的加權營業淨利：${got}，Excel ${fx.expected[i][31][3]}`);
  });

  // 開發攤提
  const am = fixture.amortWorkbook();
  const amFile = path.join(tmp, 'xa-fs.xlsx');
  fs.writeFileSync(amFile, am.bytes);
  await page.setInputFiles('#xp-file', amFile);
  await page.waitForSelector('[data-role="7"]');
  assert(/開發攤提.*「開發」1 筆投資.*÷ 40,000 台/.test(await calc(7)), '模具費顯示開發攤提：' + await calc(7));
  assert(/ROUND/.test(await calc(11)), '治具攤提顯示追不到的原因：' + await calc(11));
  await page.check('[data-bcalc="12"]');
  assert(/開發攤提.*回推/.test(await calc(12)), '勾選後檢具攤提改成回推：' + await calc(12));
  assert(/40,000 台\(48 個月\)/.test(await page.textContent('#xp-sc')), '第 4 步顯示攤提台數');
  await page.fill('#xp-type', 'XA');
  await page.dispatchEvent('#xp-type', 'change');
  await page.click('#xp-run');
  await page.waitForSelector('#xp-result .xp-note');
  assert(/驗算通過/.test(await page.textContent('#xp-result .xp-note')), '開發攤提的檔案驗算通過');
  assert(/5 列改成開發攤提/.test(await page.textContent('#xp-result')), '結果列出開發攤提列數');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#xp-download')]);
  const amPack = path.join(tmp, 'xa.json');
  await dl2.saveAs(amPack);
  await app.setInputFiles('#fs-local-bar input[type=file]', amPack);
  await app.waitForSelector('#fs-local-dialog[open]');
  await app.click('#fs-local-dialog button:has-text("合併匯入")');
  await app.waitForSelector('#fs-local-dialog >> text=確認合併內容');
  await Promise.all([app.waitForNavigation(), app.click('#fs-local-dialog button:has-text("確定合併")')]);
  await app.waitForFunction(() => [...document.querySelectorAll('#vehicletype-selector option')].some(o => o.value === 'XA'));
  const devRows = await app.evaluate(() => new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail).getScenarios('XA'))
    .then(scs => new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail).getDevInvestmentSummary(scs[0].ScenarioID))));
  assert(devRows.rows.length === 7 && devRows.rows.some(x => x.Department === '開發部'), '匯入後開發總投頁有部門明細：' + devRows.rows.map(x => x.Department).join(','));

  assert(errors.length === 0, '頁面有 JS 錯誤：' + errors.join(' | '));
  assert(external.length === 0, '不該連外部網路，卻請求了：' + external.join(', '));
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  if (failures.length) {
    console.log(`Excel 轉資料包瀏覽器測試失敗：${failures.length} 項（共 ${checks} 項）`);
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`Excel 轉資料包瀏覽器測試通過：${checks} 項全部符合（讀檔、自動判斷、驗算抓錯、下載、地端版合併匯入後數字相同、記住對應）。`);
}

main().catch(e => { console.error(e); process.exit(1); });
