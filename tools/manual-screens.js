/**
 * 使用手冊的畫面截圖：用 Chromium 以 file:// 打開 dist/FS-local.html，照手冊的順序實際操作一遍，
 * 每一步截一張圖存到 docs/manual/img/。手冊(docs/manual/index.html)裡的圖全部由這支程式產生，
 * 畫面改版後重新執行一次就好，不必手動截圖。
 *
 *   node tools/manual-screens.js             # 全部重截
 *   ONLY=dash node tools/manual-screens.js   # 只截檔名含 dash 的圖
 *
 * 需要 Playwright(找不到時說明並略過)。Excel 驗算檔的畫面另外需要 LibreOffice(soffice)與 pdftoppm：
 * 先用系統匯出真正的 .xlsx，再用 LibreOffice 轉成 PDF、pdftoppm 轉成圖片；找不到時略過那幾張。
 * 資料用內建的示範資料(車型代號、數字都是亂數產生的)。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'FS-local.html');
const OUT = path.join(REPO, 'docs', 'manual', 'img');
const ONLY = process.env.ONLY || '';

function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try { return require(c); } catch (e) { /* 試下一個 */ }
  }
  return null;
}
function have(cmd, args) {
  try { execFileSync(cmd, args || ['--version'], { stdio: 'pipe', timeout: 60000 }); return true; } catch (e) { return false; }
}

const shot = name => !ONLY || name.indexOf(ONLY) !== -1;
const FIXED_TIME = '2026-10-01T09:30:00+08:00';
// 截圖用的是哪一版系統(dist 的雜湊)：tools/verify-manual.js 用它檢查系統改了之後有沒有重新截圖
const SOURCE_FILE = path.join(OUT, '.source');
// Excel 驗算檔的截圖：[檔名, 那張工作表第一行的標題]
const XLSX_SHOTS = [['40-xlsx-info', '損益驗算檔'], ['41-xlsx-input', '輸入資料'], ['42-xlsx-dev', '開發總投攤提'], ['43-xlsx-pl', '損益試算'],
  ['44-xlsx-check', '驗算：'], ['45-xlsx-formulas', '公式區：'], ['46-verify-dialog', ''], ['47-xlsx-structure', '結構檢查：'], ['48-xlsx-impact', '科目影響：'], ['49-xlsx-changes', '變動檢查：'],
  ['50-import-preview', '']];
const done = [];
const skipped = [];

/** 在畫面上加編號圈圈與外框(截完圖再拿掉)：[{ sel, n, place: 'tl'|'tr'|'l' }] */
/** 讀不壓縮的 zip(系統匯出的驗算檔)：{ 檔名: 文字 } */
function readStoredZip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n; i++) {
    const size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    files[name] = buf.slice(start, start + size).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** { 檔名: 文字 } → 不壓縮的 zip */
function writeStoredZip(files) {
  const zlib = require('zlib');
  const parts = [], central = [];
  let offset = 0;
  Object.keys(files).forEach(name => {
    const data = Buffer.from(files[name], 'utf8'), nameBuf = Buffer.from(name, 'utf8'), crc = zlib.crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(head, nameBuf, data); central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const cdBuf = Buffer.concat(central), end = Buffer.alloc(22), n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(parts.concat([cdBuf, end]));
}

async function annotate(page, marks) {
  await page.evaluate(list => {
    const layer = document.createElement('div');
    layer.id = 'manual-marks';
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:99999;pointer-events:none;';
    document.body.appendChild(layer);
    list.forEach(m => {
      const el = document.querySelector(m.sel);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${r.left + scrollX - 3}px;top:${r.top + scrollY - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;` +
        'border:2.5px solid #e5484d;border-radius:8px;box-shadow:0 0 0 3px rgba(229,72,77,.15);';
      const dot = document.createElement('div');
      const place = m.place || 'tl';
      const x = place === 'tr' || place === 'br' ? r.right + scrollX - 12 : place === 'l' ? r.left + scrollX - 30 : r.left + scrollX - 12;
      const y = place === 'l' ? r.top + scrollY + r.height / 2 - 12 : place === 'br' ? r.bottom + scrollY - 12 : r.top + scrollY - 12;
      dot.textContent = m.n;
      dot.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:24px;height:24px;border-radius:12px;background:#e5484d;color:#fff;` +
        'font:700 13px/24px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.35);';
      layer.appendChild(box);
      layer.appendChild(dot);
    });
  }, marks);
}
async function clearMarks(page) {
  await page.evaluate(() => { const l = document.getElementById('manual-marks'); if (l) l.remove(); });
}

async function save(page, name, opts) {
  if (!shot(name)) return;
  opts = opts || {};
  const file = path.join(OUT, name + '.png');
  // 滑鼠移到角落：上一步點過的按鈕不會留著 hover 提示(要截 hover 的那張傳 hover: true)
  if (!opts.hover) { await page.mouse.move(1439, 899); await page.waitForTimeout(150); }
  if (opts.marks) await annotate(page, opts.marks);
  await page.waitForTimeout(opts.wait === undefined ? 250 : opts.wait);
  if (opts.el) {
    const loc = page.locator(opts.el).first();
    await loc.scrollIntoViewIfNeeded();
    if (opts.marks) { await clearMarks(page); await annotate(page, opts.marks); }
    await loc.screenshot({ path: file });
  } else if (opts.clip) {
    await page.screenshot({ path: file, clip: opts.clip });
  } else {
    await page.screenshot({ path: file, fullPage: !!opts.full });
  }
  if (opts.marks) await clearMarks(page);
  done.push(name);
}

async function tab(page, key, waitText) {
  await page.click(`nav button[data-tab="${key}"]`);
  if (waitText) await page.waitForFunction(([k, t]) => (document.getElementById('panel-' + k).textContent || '').indexOf(t) !== -1, [key, waitText], { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, 0));
}
async function closeModal(page) {
  const btn = page.locator('dialog.modal button[value=cancel]');
  if (await btn.count()) await btn.first().click();
  await page.waitForTimeout(200);
}
const call = (page, fn, ...args) => page.evaluate(([f, a]) => new Promise((ok, fail) => google.script.run.withSuccessHandler(ok).withFailureHandler(fail)[f](...a)), [fn, args]);

async function step(name, fn) {
  try { await fn(); } catch (e) { skipped.push(name + '：' + e.message.split('\n')[0]); }
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.log('找不到 Playwright，略過手冊截圖。'); return; }
  if (!fs.existsSync(DIST)) { console.log('找不到 dist/FS-local.html，請先執行 node tools/build-local.js'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  const launchOpts = { headless: true, env: Object.assign({}, process.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }) };
  if (fs.existsSync('/opt/pw-browsers/chromium')) {
    try { await pw.chromium.launch(launchOpts).then(b => b.close()); } catch (e) { launchOpts.executablePath = '/opt/pw-browsers/chromium'; }
  }
  const browser = await pw.chromium.launch(launchOpts);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  // 時間固定：快照名稱、匯出時間不會每次重截都不一樣，畫面沒改的圖重截出來也一樣(git 不會多一堆沒意義的變更)
  await context.clock.setFixedTime(new Date(FIXED_TIME));
  // 截長元素時頁首不要黏在畫面上方(會蓋住元素的上緣)
  await context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = '.topbar, #fs-local-bar, #local-bar-slot { position: static !important; }';
    document.head.appendChild(st);
  }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('file://' + DIST);
  await page.waitForSelector('#fs-local-bar');
  await page.waitForTimeout(600);

  /* ---------- 第 1 章：開始使用 ---------- */
  await step('01-empty', () => save(page, '01-empty', {
    marks: [{ sel: '#fs-local-banner .fsl-btn.primary', n: 1 }, { sel: '#fs-local-banner .fsl-btn:nth-of-type(2)', n: 2 }, { sel: '#fs-local-banner .fsl-btn:nth-of-type(3)', n: 3 }]
  }));
  await step('02-new-vehicle-dialog', async () => {
    await tab(page, 'masters', '車型');
    await page.click('#panel-masters button:has-text("新增車型")');
    await page.waitForSelector('dialog.modal[open]');
    await save(page, '02-new-vehicle-dialog');
    await closeModal(page);
  });

  // 載入示範資料(整頁重新載入)
  await Promise.all([page.waitForNavigation(), page.selectOption('#fs-local-bar .fsl-more', 'demo')]);
  await page.waitForFunction(() => document.querySelectorAll('#vehicletype-selector option').length >= 2);
  await page.waitForTimeout(800);
  const typeId = await page.inputValue('#vehicletype-selector');
  const scenarios = await call(page, 'getScenarios', typeId);
  const base = scenarios.find(s => s.ScenarioType === '現況') || scenarios[0];
  const target = scenarios.find(s => s.ScenarioType === '目標') || scenarios[scenarios.length - 1];
  const vehicles = await call(page, 'getVehicles', typeId);
  await page.selectOption('#scenario-selector', base.ScenarioID);
  await page.waitForTimeout(500);

  await step('03-layout', async () => {
    await tab(page, 'dashboard', '營業淨利');
    await save(page, '03-layout', { marks: [
      { sel: 'aside.sidebar nav', n: 1, place: 'br' }, { sel: '.context-bar', n: 2 }, { sel: '#fs-local-bar', n: 3 },
      { sel: '#dashboard-content .dash-subnav, #dashboard-content .dash-tabs, #dashboard-content [class*="subnav"]', n: 4 }
    ] });
  });
  await step('04-export-menu', async () => {
    await page.click('#fs-local-bar .fsl-menu summary');
    await page.waitForTimeout(200);
    await save(page, '04-export-menu', { clip: { x: 760, y: 0, width: 680, height: 300 } });
    await page.click('#fs-local-bar .fsl-menu summary');
  });

  /* ---------- 第 2 章：車型與情境 ---------- */
  await step('05-masters', async () => {
    await tab(page, 'masters', '車系');
    await save(page, '05-masters');
  });
  await step('06-scenarios', async () => {
    const card = page.locator('#panel-masters .card', { hasText: '同一個 GATE 底下可以有多個情境' }).first();
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: path.join(OUT, '06-scenarios.png') });
    done.push('06-scenarios');
  });
  await step('07-new-scenario-dialog', async () => {
    await page.click('#panel-masters button:has-text("新增情境")');
    await page.waitForSelector('dialog.modal[open]');
    await save(page, '07-new-scenario-dialog');
    await closeModal(page);
  });
  await step('08-snapshots', async () => {
    await save(page, '08-snapshots', { el: '#snapshot-card' });
  });

  /* ---------- 第 3 章：輸入資料 ---------- */
  await step('09-salesmix', async () => {
    await tab(page, 'salesmix', '構成比');
    await save(page, '09-salesmix');
  });
  await step('10-costs', async () => {
    await tab(page, 'costs', '報告說明');
    await page.evaluate(() => setCostsView('costofsales'));
    await page.waitForTimeout(800);
    await save(page, '10-costs');
  });
  await step('11-costs-paste', async () => {
    await page.evaluate(() => importMatrixDialog('costofsales'));
    await page.waitForSelector('dialog.modal[open]');
    await save(page, '11-costs-paste');
    await closeModal(page);
  });
  await step('12-opex', async () => {
    await page.evaluate(() => setCostsView('operatingexpense'));
    await page.waitForTimeout(800);
    await save(page, '12-opex');
    await page.evaluate(() => setCostsView('costofsales'));
  });
  await step('13-dev-sum', async () => {
    await page.selectOption('#scenario-selector', target.ScenarioID);
    await page.waitForTimeout(500);
    await tab(page, 'devinvestment', '部門');
    await save(page, '13-dev-sum');
  });
  await step('14-dev-drawer', async () => {
    await page.locator('#panel-devinvestment [onclick^="openDevDrawer_"]').first().click();
    await page.waitForSelector('#dev-drawer');
    await save(page, '14-dev-drawer');
    await page.evaluate(() => closeDevDrawer_());
  });
  await step('15-dev-list', async () => {
    await page.evaluate(() => { devView_ = 'list'; drawDevGrid(); });
    await page.waitForTimeout(500);
    await save(page, '15-dev-list');
  });
  await step('16-dev-compare', async () => {
    await page.evaluate(() => { devView_ = 'cmp'; drawDevGrid(); });
    await page.waitForTimeout(1500);
    await save(page, '16-dev-compare', { full: true });
    await page.evaluate(() => { devView_ = 'sum'; drawDevGrid(); });
  });

  /* ---------- 第 4 章：計算設定 ---------- */
  await page.selectOption('#scenario-selector', base.ScenarioID);
  await page.waitForTimeout(500);
  await step('17-chart-tree', async () => {
    await tab(page, 'lineitems', '科目');
    await save(page, '17-chart-tree');
  });
  await step('18-chart-rows', async () => {
    await page.evaluate(() => selectChartLine('d4'));
    await page.waitForTimeout(1500);
    await save(page, '18-chart-rows', { full: true });
  });
  await step('19-chart-chips', async () => {
    await page.evaluate(() => selectChartLine('b13'));
    await page.waitForTimeout(1500);
    await save(page, '19-chart-chips', { full: true });
    await page.evaluate(() => { if (typeof cancelChartEdit === 'function') cancelChartEdit(); });
  });
  await step('20-params', async () => {
    await tab(page, 'paramrates', '參數');
    await save(page, '20-params', { full: true });
  });

  /* ---------- 第 5 章：結果呈現 ---------- */
  const v = vehicles.map(x => x.VehicleID);
  await step('21-dash-columns', async () => {
    await tab(page, 'dashboard', '營業淨利');
    await page.evaluate(([b, t, vs]) => {
      comparisonSelections = [{ ScenarioID: b, VehicleID: '' }, { ScenarioID: t, VehicleID: '' }].concat(vs.slice(0, 2).map(id => ({ ScenarioID: t, VehicleID: id })));
      setBaselineColumnAt(0);
      setDashView('columns');
      refreshDashboard(true);
    }, [base.ScenarioID, target.ScenarioID, v]);
    await page.waitForTimeout(1500);
    await save(page, '21-dash-columns');
  });
  await step('22-dash-table', async () => {
    await page.evaluate(() => { setDashView('table'); });
    await page.waitForFunction(() => document.querySelectorAll('.pl-table thead th').length > 4, null, { timeout: 15000 });
    await page.waitForTimeout(800);
    await save(page, '22-dash-table');
  });
  await step('23-dash-hover', async () => {
    // 第三欄是車系欄(前兩欄是加權平均，加權平均沒有單一計算過程)：提示框顯示公式代入的數字
    const cell = page.locator('.pl-table td.amt[data-l="d4"]').nth(2);
    await cell.scrollIntoViewIfNeeded();
    await cell.hover();
    await page.waitForTimeout(800);
    await save(page, '23-dash-hover', { wait: 300, hover: true });
    await page.mouse.move(5, 5);
  });
  await step('24-dash-chart', async () => {
    await page.evaluate(() => { window.scrollTo(0, 0); setDashView('chart'); });
    await page.waitForTimeout(1500);
    await save(page, '24-dash-chart', { full: true });
    await page.evaluate(() => setDashView('table'));
  });
  await step('25-verify-button', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await save(page, '25-verify-button', { clip: { x: 232, y: 108, width: 1208, height: 300 },
      marks: [{ sel: '#dashboard-content button[onclick^="exportVerifyWorkbookFromDashboard"]', n: 1 }] });
  });

  await step('26-whatif-goal', async () => {
    await page.selectOption('#scenario-selector', target.ScenarioID);
    await page.waitForTimeout(500);
    await tab(page, 'whatif', '目標反推');
    await page.evaluate(() => whatIfPreset_('breakeven-price'));
    await page.waitForTimeout(400);
    await page.locator('#panel-whatif button:has-text("計算")').first().click();
    await page.waitForTimeout(2000);
    await save(page, '26-whatif-goal', { el: '#panel-whatif .card >> nth=0' });
  });
  await step('27-whatif-combo', async () => {
    await page.evaluate(() => whatIfPreset_('combo'));
    await page.waitForTimeout(400);
    await page.locator('#panel-whatif button:has-text("計算")').first().click();
    await page.waitForTimeout(2000);
    await save(page, '27-whatif-combo', { el: '#panel-whatif .card >> nth=0' });
  });
  await step('28-whatif-impact', async () => {
    await page.locator('#panel-whatif button:has-text("試算")').first().click();
    await page.waitForTimeout(2000);
    await save(page, '28-whatif-impact', { el: '#panel-whatif .card >> nth=1' });
  });
  await step('29-whatif-sens', async () => {
    await page.locator('#panel-whatif button:has-text("產生表格")').first().click();
    await page.waitForTimeout(2500);
    await save(page, '29-whatif-sens', { el: '#panel-whatif .card >> nth=2' });
  });

  await step('30-waterfall', async () => {
    await tab(page, 'waterfall', '瀑布');
    await page.waitForTimeout(2000);
    await save(page, '30-waterfall', { full: true });
  });

  await step('31-report', async () => {
    await tab(page, 'report', '損益目標');
    await page.waitForTimeout(2500);
    await save(page, '31-report');
  });
  const slides = await page.locator('#panel-report section.slide').count();
  // 手冊用到的投影片(依報告裡的順序；null = 不截)
  const slideNames = ['32-slide-summary', '33-slide-bridge', null, '35-slide-actions', null, '37-slide-reconcile', '38-slide-fs'];
  for (let i = 0; i < Math.min(slides, slideNames.length); i++) {
    if (!slideNames[i]) continue;
    await step(slideNames[i], () => save(page, slideNames[i], { el: `#panel-report section.slide >> nth=${i}` }));
  }

  /* ---------- 第 6 章：Excel 驗算檔 ---------- */
  const soffice = ['soffice', 'libreoffice'].find(c => have(c));
  if (!soffice || !have('pdftoppm', ['-v'])) {
    skipped.push('Excel 驗算檔畫面：找不到 LibreOffice 或 pdftoppm');
  } else if (XLSX_SHOTS.some(n => shot(n[0]))) {   // 50-import-preview 也在這一段(要用匯出的檔案)
    await step('40-xlsx', async () => {
      await page.selectOption('#scenario-selector', target.ScenarioID);
      await page.waitForTimeout(500);
      // 手冊示範「改了公式之後」：先存快照，再透過系統同一條路徑改幾個地方
      //   生產毛利的公式改壞、季Margin 換成固定 1%、新增一個沒掛在任何小計底下的費用
      const snap = await call(page, 'createSnapshot', target.ScenarioID, '改公式前', '');
      await call(page, 'saveChartLine', typeId, { LineCode: 'C', LineName: '生產毛利', ParentLine: '', CalcType: 'FORMULA', Formula: 'A - B + [一般材料]' });
      await call(page, 'saveChartLine', typeId, { LineCode: 'd4', LineName: '季Margin', ParentLine: 'E', CalcType: 'FORMULA', Formula: 'P8 * 1%' });
      await call(page, 'saveChartLine', typeId, { LineCode: '', LineName: '新增的認證費', ParentLine: '', CalcType: 'INPUT' });
      await tab(page, 'dashboard', '營業淨利');
      if (shot('46-verify-dialog')) {
        await page.click('#dashboard-content button[onclick^="exportVerifyWorkbookFromDashboard"]');
        await page.waitForSelector('dialog.modal[open]');
        await page.selectOption('dialog.modal select#mf-0', target.ScenarioID);
        await page.selectOption('dialog.modal select#mf-1', snap.SnapshotID);
        await page.waitForTimeout(300);
        await save(page, '46-verify-dialog', { el: 'dialog.modal' });
        await closeModal(page);
      }
      const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(([id, sn]) => exportVerifyWorkbook(id, sn), [target.ScenarioID, snap.SnapshotID])]);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-manual-'));
      const xlsx = path.join(tmp, 'verify.xlsx');
      await dl.saveAs(xlsx);
      // 每張工作表另存一個只有那張表的 PDF：用 LibreOffice 轉成 PDF(整本)，再依頁面對應工作表
      execFileSync(soffice, ['-env:UserInstallation=file://' + path.join(tmp, 'profile'), '--headless', '--convert-to', 'pdf', '--outdir', tmp, xlsx], { stdio: 'pipe', timeout: 180000 });
      execFileSync('pdftoppm', ['-png', '-r', '170', path.join(tmp, 'verify.pdf'), path.join(tmp, 'p')], { stdio: 'pipe' });
      const pages = fs.readdirSync(tmp).filter(f => /^p-\d+\.png$/.test(f)).sort();
      // 每張工作表從新的一頁開始，第一行就是那張表的標題
      const text = execFileSync('pdftotext', ['-layout', path.join(tmp, 'verify.pdf'), '-'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).split('\f');
      XLSX_SHOTS.filter(([name, marker]) => marker && shot(name)).filter(([name]) => shot(name)).forEach(([name, marker]) => {
        const idx = text.findIndex(t => t.trim().indexOf(marker) === 0);
        if (idx === -1 || !pages[idx]) { skipped.push(name + '：PDF 裡找不到「' + marker + '」'); return; }
        // 去掉頁面四周的白邊；太長的頁面只留上半部(手冊裡看得到表頭與前幾十列就夠)
        // 公式區很寬，縮成一頁後字太小：只取左上角(代碼、科目、系統公式、Excel 公式)
        const crop = name === '45-xlsx-formulas' ? ['-crop', '78%x45%+0+0'] : name === '49-xlsx-changes' ? ['-crop', '100%x60%+0+0'] : ['-crop', 'x1300+0+0'];
        execFileSync('convert', [path.join(tmp, pages[idx]), '-trim', '+repage'].concat(crop).concat(['+repage', '-bordercolor', 'white', '-border', '16', path.join(OUT, name + '.png')]), { stdio: 'pipe' });
        done.push(name);
      });
      // 在 Excel 修正：把生產毛利改回 A − B(每個車系)、改一個售價，存檔後用「從 Excel 匯入」→ 預覽畫面
      if (shot('50-import-preview')) {
        const zip = readStoredZip(fs.readFileSync(xlsx));
        // 工作表順序與每一格的位置：讀檔案裡隱藏的「_對照」表(跟系統匯入時一樣)
        const names = [];
        zip['xl/workbook.xml'].replace(/<sheet [^>]*name="([^"]+)"/g, (m, n) => { names.push(n); return m; });
        const sheetPath = n => 'xl/worksheets/sheet' + (names.indexOf(n) + 1) + '.xml';
        const mapRows = [];
        zip[sheetPath('_對照')].replace(/<row [^>]*>([\s\S]*?)<\/row>/g, (m, inner) => {
          const vals = [];
          inner.replace(/<c r="([A-Z]+)\d+"[^>]*>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)<\/c>/g, (m2, col, v, t) => { vals[col.charCodeAt(0) - 65] = v !== undefined ? v : t; return m2; });
          mapRows.push(vals);
          return m;
        });
        const pl = {}, vehicleCols = [];
        let priceRow = 0;
        mapRows.forEach(r => {
          if (r[0] === 'pl') pl[r[1]] = Number(r[2]);
          if (r[0] === 'vehicle') vehicleCols.push(r[2]);
          if (r[0] === 'in' && r[1] === 'sm:建議零售價') priceRow = Number(r[2]);
        });
        const setCell = (n, ref, inner) => { zip[sheetPath(n)] = zip[sheetPath(n)].replace(new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>[\\s\\S]*?</c>)'), (m, a) => '<c r="' + ref + '"' + a.replace(/\st="[^"]*"/, '') + '>' + inner + '</c>'); };
        vehicleCols.forEach(c => setCell('損益試算', c + pl.C, '<f>' + c + pl.A + '-' + c + pl.B + '</f>'));
        setCell('輸入', vehicleCols[0] + priceRow, '<v>949000</v>');
        const edited = path.join(tmp, '驗算_修正後.xlsx');
        fs.writeFileSync(edited, writeStoredZip(zip));
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dashboard-content button:has-text("從 Excel 匯入")')]);
        await chooser.setFiles(edited);
        await page.waitForSelector('dialog.modal[open] .vi-table', { timeout: 20000 });
        await save(page, '50-import-preview', { el: 'dialog.modal' });
        await closeModal(page);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  }

  await browser.close();
  // 縮成 256 色：介面截圖看不出差別，檔案小一半以上
  if (have('convert', ['-version'])) {
    done.forEach(name => {
      const f = path.join(OUT, name + '.png');
      // -strip 與不寫日期：畫面沒變的圖，檔案也要一模一樣
      if (fs.existsSync(f)) execFileSync('convert', [f, '-strip', '-define', 'png:exclude-chunks=date,time', '-dither', 'None', '-colors', '256', 'PNG8:' + f], { stdio: 'pipe' });
    });
  }
  // 全部重截(沒有 ONLY)而且沒有略過任何一張，才記下這一版：只重截幾張的不算
  if (!ONLY && !skipped.length) {
    fs.writeFileSync(SOURCE_FILE, require('crypto').createHash('sha256').update(fs.readFileSync(DIST)).digest('hex') + '\n');
  }
  console.log(`已截 ${done.length} 張 → docs/manual/img/`);
  if (skipped.length) console.log('略過：\n  ' + skipped.join('\n  '));
  if (errors.length) { console.log('頁面錯誤：' + errors.join(' | ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
