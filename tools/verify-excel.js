/**
 * Excel 驗算檔的驗證：
 *
 *   node tools/verify-excel.js
 *
 * 1. 系統公式翻成 Excel 公式的規則(括號、除以 0、比較式、ROUND 位數、IF 少參數…)
 * 2. 檔案結構：zip 裡有哪些檔、損益試算每一格都是公式、沒有「翻不過去只好帶數字」的科目
 * 3. 有 LibreOffice(soffice)時：把公式的快取值全部拿掉，讓 LibreOffice 從頭重算，
 *    再讀回「驗算」頁的差異與「說明」頁的不一致科目數 —— 證明 Excel 公式算出來跟系統一樣。
 *    情境涵蓋：示範資料、Gate F 驗算情境，再加上車系個別公式、REF 跨車型、外幣成本、只攤給部分車系的外幣開發投資、
 *    攤提基準台數、目標情境的低減、車系個別參數、廢車處理費未稅、IF/比較/除法/ROUNDUP/次方/負號的自訂公式。
 *    找不到 soffice 時說明並略過這一段。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { loadAppsScript } = require('./fake-apps-script');
const gatef = require('./verify-gatef');
const { seedDemoData } = require('./dev-server');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ---------- 讀 zip(LibreOffice 存的檔案是 deflate 壓縮) ---------- */
function readZip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(offset + 26), lExtraLen = buf.readUInt16LE(offset + 28);
    const data = buf.slice(offset + 30 + lNameLen + lExtraLen, offset + 30 + lNameLen + lExtraLen + size);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
/** 讀出每張工作表的數值格 { 工作表名稱: { A1: 數字 } }(文字格不需要) */
function readNumbers(buf) {
  const files = readZip(buf);
  const wb = files['xl/workbook.xml'].toString('utf8');
  const rels = files['xl/_rels/workbook.xml.rels'].toString('utf8');
  const out = {};
  const sheetRe = /<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g;
  let m;
  while ((m = sheetRe.exec(wb))) {
    const target = new RegExp('Id="' + m[2] + '"[^>]*Target="([^"]+)"').exec(rels) || new RegExp('Target="([^"]+)"[^>]*Id="' + m[2] + '"').exec(rels);
    const xml = files['xl/' + target[1].replace(/^\/?xl\//, '')].toString('utf8');
    const cells = {};
    const cellRe = /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = cellRe.exec(xml))) {
      if (/t="(s|str|inlineStr|e|b)"/.test(c[2])) continue;
      const v = /<v>([^<]*)<\/v>/.exec(c[3] || '');
      if (v) cells[c[1]] = Number(v[1]);
    }
    out[m[1].replace(/&amp;/g, '&')] = cells;
  }
  return out;
}

function findSoffice() {
  for (const cmd of ['soffice', 'libreoffice']) {
    try { execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 60000 }); return cmd; } catch (e) { /* 試下一個 */ }
  }
  return null;
}

/** 拿掉公式格的快取值，強迫 LibreOffice 自己算 */
function stripCache(model) {
  model.sheets.forEach(s => (s.rows || []).forEach(row => (row || []).forEach(c => { if (c && typeof c === 'object' && c.f) delete c.v; })));
  return model;
}

/* ---------- 1. 翻譯規則 ---------- */
const gsRules = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs', 'XlsxWriter.gs', 'VerifyWorkbook.gs']);
check('系統公式 → Excel 公式：括號、除以 0、比較式、函式參數', () => {
  const ctx = {
    code: c => ({ P5: 'D10', P6: 'D11', B: 'D20', A: 'D19' })[c] || 'X1',
    name: n => ({ '營業稅率': "'輸入'!D30", '月銷量': "'輸入'!D9" })[n] || "'輸入'!D99",
    sumOf: () => 'SUM(D1,D2)', ref: () => "'輸入'!D50", note: () => { }
  };
  const tr = f => gsRules.verifyPrintAst_(gsRules.parseFormula_(f), ctx, 'excel');
  const cases = [
    ['ROUND(P5 * [營業稅率] / (1 + [營業稅率]))', "ROUND(IF(1+'輸入'!D30=0,0,D10*'輸入'!D30/(1+'輸入'!D30)),0)"],
    ['ROUND((P5 - P6) * [營業稅率])', "ROUND((D10-D11)*'輸入'!D30,0)"],
    ['A - B', 'D19-D20'],
    ['A - (B - P5)', 'D19-(D20-D10)'],
    ['A / 2', 'D19/2'],
    ['A / [月銷量]', "IF('輸入'!D9=0,0,D19/'輸入'!D9)"],
    ['-A ^ 2', '-(D19^2)'],
    ['(-A) ^ 2', '(-D19)^2'],
    ['A > B', '(D19>D20)*1'],
    ['IF(A > B, A)', 'IF(D19>D20,D19,0)'],
    ['A * 15%', 'D19*(15/100)'],
    ['CHILDREN()', 'SUM(D1,D2)'],
    ['A - -B', 'D19-(-D20)'],
    ['SUM()', '0'],
    ['ROUNDUP(A, -3)', 'ROUNDUP(D19,-3)'],
    ['REF("SC-1", "b4") * 1.2', "'輸入'!D50*1.2"]
  ];
  cases.forEach(([src, want]) => {
    const got = tr(src);
    assert(got === want, `「${src}」應翻成 ${want}，實際 ${got}`);
  });
});

/* ---------- 準備資料 ---------- */
// (a) 示範資料
const demo = seedDemoData();
// (b) Gate F 驗算情境 + 各種特殊情況
const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs', 'XlsxWriter.gs', 'VerifyWorkbook.gs']);
const sid = gatef.buildScenario(gs);
gs.getBootstrap('DA');
const reset = () => { gs.SHEET_CACHE_ = {}; gs.resetCalcMemo_(); };
let targetSid = '', refSid = '';
check('準備特殊情況的資料', () => {
  gs.createVehicleType('DE', '', '');
  gs.saveVehicle({ VehicleID: 'E1', VehicleTypeID: 'DE', VehicleCode: '8人座' });
  const de = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE Z', ScenarioName: '實績', ScenarioType: '現況', VehicleTypeID: 'DE' }, '', []);
  refSid = de.ScenarioID;
  gs.saveSalesMixGrid(de.ScenarioID, 'DE', [{ RowID: '', VehicleID: 'E1', SalesMixPct: 100, MonthlyVolume: 150, LifeCycleYears: 10, ListPriceTaxIncl: 800000, ScrapFee: 0, ScrapFeeTaxStatus: '含稅' }]);
  gs.saveCostOfSalesMatrix(de.ScenarioID, [{ RowID: '', VehicleID: 'E1', LineCode: 'b4', Amount: 5972, Currency: 'TWD' }]);

  gs.saveParamDef({ ParamName: '關稅率', Unit: '%', DefaultValue: 13 });
  gs.saveParamDef({ ParamName: '一般材料倍率', Unit: '數值', DefaultValue: 1.2 });
  gs.saveRateGrid(sid, [{ ParamID: '', ParamName: '關稅率', VehicleID: 'V2', Value: 10 }]);
  gs.saveFxGrid(sid, [{ ParamID: '', Currency: 'CNY', ParamName: '現況匯率', Value: 4.65 }]);
  reset();
  // 外幣成本：V1 的一般材料用 CNY 登打
  const v1b4 = gs.getCostOfSales(sid, 'V1').filter(r => r.LineCode === 'b4')[0];
  gs.saveCostOfSalesMatrix(sid, [{ RowID: v1b4 ? v1b4.RowID : '', VehicleID: 'V1', LineCode: 'b4', Amount: 1500, Currency: 'CNY' }]);
  // 新科目：關稅(自訂 % 參數、車系個別值)、REF、IF/比較/除法/次方/負號/ROUNDUP
  gs.addLineItemInline('B', '關稅', 'DA');
  gs.addLineItemInline('B', '試算項', 'DA');
  reset();
  const tax = gs.getPLLineItems('DA').filter(d => d.LineName === '關稅')[0];
  const trial = gs.getPLLineItems('DA').filter(d => d.LineName === '試算項')[0];
  gs.saveChartLine('DA', { LineCode: tax.LineCode, LineName: '關稅', ParentLine: 'B', CalcType: 'FORMULA', Formula: '[材料成本-KD] * [關稅率]' });
  gs.saveChartLine('DA', { LineCode: trial.LineCode, LineName: '試算項', ParentLine: 'B', CalcType: 'FORMULA',
    Formula: 'IF([月銷量] > 100, ROUNDUP([建議零售價] / [月銷量], -2), -([LC年限] ^ 2)) + ([構成比] >= 0.3) * 1000 + 59 * [CNY匯率] * [一般材料倍率]',
    VehicleFormulas: { V3: `REF("DE GATE Z 實績", "b4") * 1.2 + MAX(0, [攤提總台數] / 1000)` } });
  // 只攤給 V3 的外幣開發投資
  const dev = gs.getDevInvestmentSummary(sid);
  const rows = dev.rows.map(r => Object.assign({}, r));
  rows.push({ RowID: '', Department: '上汽開發費', TargetLineCode: 'b5', Amount: 3000000, Currency: 'CNY', VehicleScope: 'V3' });
  rows.push({ RowID: '', Department: '法規認證', TargetLineCode: 'b5', Amount: 9000000, Currency: 'TWD', VehicleScope: 'V1,V2' });
  gs.saveDevInvestmentGrid(sid, rows);
  // 廢車處理費未稅
  reset();
  const mix = gs.getSalesMix(sid).map(r => Object.assign({}, r));
  mix.forEach(r => { if (r.VehicleID === 'V2') { r.ScrapFee = 3800; r.ScrapFeeTaxStatus = '未稅'; } });
  gs.saveSalesMixGrid(sid, 'DA', mix);
  reset();
  // 目標情境：整批帶入，再加低減目標與攤提基準台數
  const tg = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE F', ScenarioName: '目標', ScenarioType: '目標', VehicleTypeID: 'DA' }, sid,
    ['salesmix', 'costofsales', 'devinvestment', 'operatingexpense', 'parameters']);
  targetSid = tg.ScenarioID;
  reset();
  const tRows = gs.getDevInvestmentSummary(targetSid).rows.map((r, i) => Object.assign({}, r, { ChallengeReductionPct: 5 + i * 3 }));
  gs.saveDevInvestmentGrid(targetSid, tRows);
  const scen = gs.getScenarios().filter(s => s.ScenarioID === targetSid)[0];
  gs.saveScenarioGrid('DA', [Object.assign({}, scen, { AmortMonthlyVolume: 700, AmortLifeCycleYears: 10 })]);
  reset();
});

const cases = [];
demo.getScenarios().forEach(s => cases.push({ gs: demo, sid: s.ScenarioID, label: '示範資料 ' + s.VehicleTypeID + ' ' + s.Gate + ' ' + s.ScenarioName }));
cases.push({ gs, sid, label: 'Gate F 驗算情境(含特殊情況)' });
if (targetSid) cases.push({ gs, sid: targetSid, label: 'Gate F 目標(低減、攤提基準台數)' });

/* ---------- 2. 結構 ---------- */
cases.forEach(c => {
  check('結構：' + c.label, () => {
    const built = c.gs.buildVerifyWorkbookModel_(c.sid);
    const names = built.model.sheets.map(s => s.name);
    assert(names.join(',') === '說明,輸入,開發總投,損益試算,驗算,公式區', '工作表順序：' + names.join(','));
    assert(!built.meta.fallbacks.length, '有科目翻不成 Excel 公式：' + built.meta.fallbacks.join(','));
    assert(!built.meta.errors.length, '系統這個情境有公式錯誤：' + built.meta.errors.join(','));
    const pl = built.model.sheets.filter(s => s.name === '損益試算')[0];
    let nonFormula = 0;
    built.meta.lines.forEach(code => {
      const row = pl.rows[built.meta.plAt[code] - 1];
      for (let i = 0; i <= built.meta.vehicles.length; i++) if (!row[3 + i] || !row[3 + i].f) nonFormula++;
    });
    assert(nonFormula === 0, `損益試算有 ${nonFormula} 格不是公式`);
    const out = c.gs.exportVerifyWorkbook(c.sid);
    const files = readZip(Buffer.from(out.base64, 'base64'));
    ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet6.xml'].forEach(f => assert(files[f], '缺少 ' + f));
    const fm = files['xl/worksheets/sheet6.xml'].toString('utf8');
    assert(/_xlfn\.FORMULATEXT/.test(fm), 'FORMULATEXT 要寫成 _xlfn.FORMULATEXT，不然 Excel/LibreOffice 認不得');
    assert(/fullCalcOnLoad="1"/.test(files['xl/workbook.xml'].toString('utf8')), '打開時要重算全部公式');
  });
});
check('特殊情況真的有用到：REF、車系個別公式、外幣、部分車系分攤', () => {
  const built = gs.buildVerifyWorkbookModel_(sid);
  const input = built.model.sheets.filter(s => s.name === '輸入')[0];
  const labels = input.rows.map(r => r && r[0] && r[0].v).filter(Boolean);
  assert(labels.some(l => /^REF：DE GATE Z 實績/.test(l)), '輸入表應有跨情境引用列');
  assert(labels.indexOf('CNY匯率') !== -1, '輸入表應有 CNY 匯率');
  const fm = built.model.sheets.filter(s => s.name === '公式區')[0];
  const trialRows = fm.rows.filter(r => r && r[1] && r[1].v === '試算項');
  assert(trialRows.length === 2, '試算項有車系個別公式，公式區應分兩列：' + trialRows.length);
  const devS = built.model.sheets.filter(s => s.name === '開發總投')[0];
  assert(devS.rows.filter(r => r && r[5] && r[5].v && r[5].v !== '全車系' && r[5].v !== '分攤車系').length === 2, '開發總投應有兩筆只攤給部分車系的列');
});

/* ---------- 3. LibreOffice 重算 ---------- */
const soffice = findSoffice();
if (!soffice) {
  console.log('找不到 LibreOffice(soffice)，略過「Excel 公式重算 = 系統數字」的驗證。');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-xlsx-'));
  const profile = 'file://' + path.join(dir, 'profile');
  cases.forEach((c, idx) => {
    check('LibreOffice 從頭重算 = 系統數字：' + c.label, () => {
      const built = c.gs.buildVerifyWorkbookModel_(c.sid);
      stripCache(built.model);
      const src = path.join(dir, 'in' + idx + '.xlsx');
      fs.writeFileSync(src, Buffer.from(c.gs.buildXlsxBase64_(built.model), 'base64'));
      const outDir = path.join(dir, 'out' + idx);
      execFileSync(soffice, ['-env:UserInstallation=' + profile, '--headless', '--calc', '--convert-to', 'xlsx', '--outdir', outDir, src], { stdio: 'pipe', timeout: 180000 });
      const nums = readNumbers(fs.readFileSync(path.join(outDir, 'in' + idx + '.xlsx')));
      const ck = nums['驗算'], info = nums['說明'], pl = nums['損益試算'];
      assert(ck && info && pl, '讀不到重算後的工作表');
      // 驗算頁：差異欄全部在容差內
      const nV = built.meta.vehicles.length;
      let worst = 0, where = '', count = 0;
      built.meta.lines.forEach(code => {
        const r = built.meta.plAt[code];
        for (let k = 0; k <= nV; k++) {
          const col = String.fromCharCode(65 + 2 + nV + 1 + k);
          const v = ck[col + r];
          assert(v !== undefined, `驗算!${col}${r}（${code}）沒有算出數字`);
          count++;
          if (Math.abs(v) > Math.abs(worst)) { worst = v; where = code + ' ' + col + r; }
        }
      });
      assert(Math.abs(worst) <= 0.01, `Excel 重算跟系統差 ${worst}（${where}）`);
      assert(info.C9 === 0, '說明頁的不一致科目數應為 0：' + info.C9);
      // 損益試算的營業淨利直接跟計算引擎比
      const k = built.meta.profitCode;
      built.meta.vehicles.forEach((v, i) => {
        const col = String.fromCharCode(65 + 3 + i);
        const sys = c.gs.calculatePLCore_(c.sid, v.id).lineValues[k];
        assert(Math.abs(pl[col + built.meta.plAt[k]] - sys) <= 0.01, `${v.label} 營業淨利：Excel ${pl[col + built.meta.plAt[k]]}，系統 ${sys}`);
      });
      assert(count > 40, '比對的格數太少：' + count);
    });
  });
  // 改輸入會讓損益跟著變(證明不是貼數字)：把第一個車系的建議零售價加 10 萬，營業淨利應該改變
  check('改「輸入」的建議零售價，損益試算跟著重算', () => {
    const built = gs.buildVerifyWorkbookModel_(sid);
    const input = built.model.sheets.filter(s => s.name === '輸入')[0];
    const row = input.rows.filter(r => r && r[0] && r[0].v === '建議零售價')[0];
    row[3].v += 100000;
    stripCache(built.model);
    const src = path.join(dir, 'edit.xlsx');
    fs.writeFileSync(src, Buffer.from(gs.buildXlsxBase64_(built.model), 'base64'));
    const outDir = path.join(dir, 'outedit');
    execFileSync(soffice, ['-env:UserInstallation=' + profile, '--headless', '--calc', '--convert-to', 'xlsx', '--outdir', outDir, src], { stdio: 'pipe', timeout: 180000 });
    const nums = readNumbers(fs.readFileSync(path.join(outDir, 'edit.xlsx')));
    const k = built.meta.profitCode;
    const sys = gs.calculatePLCore_(sid, built.meta.vehicles[0].id).lineValues[k];
    const excel = nums['損益試算']['D' + built.meta.plAt[k]];
    assert(excel - sys > 50000, `售價加 10 萬，營業淨利應該增加：Excel ${excel}，系統 ${sys}`);
    assert(nums['說明'].C9 > 0, '改過輸入之後，驗算頁應顯示有差異');
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
results.forEach(r => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.ok ? '' : '\n      ' + r.err)));
if (failed.length) { console.log(`\n${failed.length} 項失敗`); process.exit(1); }
console.log(`\nExcel 驗算檔：${results.length} 項全部符合`);
