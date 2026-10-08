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
const { execFileSync } = require('child_process');
const { loadAppsScript } = require('./fake-apps-script');
const gatef = require('./verify-gatef');
const { seedDemoData } = require('./dev-server');
const { readZip, readNumbers, findSoffice, textFiles, editor, stripCache } = require('./xlsx-tools');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ---------- 1. 翻譯規則 ---------- */
const gsRules = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs', 'XlsxWriter.gs', 'VerifyWorkbook.gs', 'VerifyImport.gs']);
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
const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs', 'XlsxWriter.gs', 'VerifyWorkbook.gs', 'VerifyImport.gs']);
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

// (c) 改壞的科目表：先存快照，再把公式、科目改壞 —— 驗算照樣「一致」，但其他檢查要抓得到
const bad = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs', 'XlsxWriter.gs', 'VerifyWorkbook.gs', 'VerifyImport.gs']);
const badSid = gatef.buildScenario(bad);
bad.getBootstrap('DA');
let badSnap = '';
check('準備改壞的科目表(改之前先存快照)', () => {
  badSnap = bad.createSnapshot(badSid, '改公式前', '').SnapshotID;
  const r = () => { bad.SHEET_CACHE_ = {}; bad.resetCalcMemo_(); };
  bad.saveChartLine('DA', { LineCode: 'C', LineName: '生產毛利', ParentLine: '', CalcType: 'FORMULA', Formula: 'A - B + [一般材料]' });   // 小計改壞
  bad.saveChartLine('DA', { LineCode: 'd4', LineName: '季Margin', ParentLine: 'E', CalcType: 'FORMULA', Formula: 'P8 * 1%' });         // 刻意改的算法
  bad.saveChartLine('DA', { LineCode: '', LineName: '漏掛的費用', ParentLine: '', CalcType: 'INPUT' });                                 // 沒掛在任何小計底下
  bad.saveChartLine('DA', { LineCode: '', LineName: '重複的材料', ParentLine: 'I', CalcType: 'FORMULA', Formula: '[材料成本-LP]' });     // 材料成本-LP 被扣兩次
  r();
});
check('改壞的科目表：驗算照樣一致，但結構檢查、科目影響、預設比較、變動檢查都抓得到', () => {
  const built = bad.buildVerifyWorkbookModel_(badSid, { snapshotId: badSnap });
  assert(built.model.sheets.map(s => s.name).indexOf('變動檢查') !== -1, '選了快照要有「變動檢查」');
  const coefOf = name => { const d = bad.getPLLineItems('DA').filter(x => x.LineName === name)[0]; return built.meta.coef[d.LineCode].V1; };
  assert(Math.abs(coefOf('漏掛的費用')) < 0.01, '沒掛小計的科目，係數應該是 0：' + coefOf('漏掛的費用'));
  assert(Math.abs(coefOf('材料成本-LP') + 2) < 0.01, '被扣兩次的科目，係數應該是 −2：' + coefOf('材料成本-LP'));
  assert(Math.abs(coefOf('一般材料')) < 0.01, 'C 公式把一般材料加回去，係數應該是 0：' + coefOf('一般材料'));
  assert(built.meta.impactBad >= 3, '科目影響應該至少抓到 3 個：' + built.meta.impactBad);
  assert(built.meta.structureBad >= 1, '結構檢查(快取值)應該抓到 C：' + built.meta.structureBad);
  assert(built.meta.changeWarn >= 1, '變動檢查(快取值)應該有「公式沒改、數字卻變了」：' + built.meta.changeWarn);
  assert(built.meta.stdDiffCount >= 4, '跟預設比較：C、d4 與兩個新科目都不同：' + built.meta.stdDiffCount);
  const fm = built.model.sheets.filter(s => s.name === '公式區')[0];
  const d4 = fm.rows.filter(r => r && r[0] && r[0].v === 'd4')[0];
  assert(d4 && d4[10].v === '公式跟預設不同', 'd4 應標「公式跟預設不同」：' + (d4 && d4[10].v));
  const ch = built.model.sheets.filter(s => s.name === '變動檢查')[0];
  const fstate = code => (ch.rows.filter(r => r && r[0] && r[0].v === code)[0] || [])[2].v;
  assert(fstate('C') === '改過' && fstate('d4') === '改過' && fstate('E') === '相同', '變動檢查的公式比較：C ' + fstate('C') + '、d4 ' + fstate('d4') + '、E ' + fstate('E'));
});
cases.push({ gs: bad, sid: badSid, label: '改壞的科目表(含快照比較)', snapshotId: badSnap, broken: true });

/* ---------- 2. 結構 ---------- */
cases.forEach(c => {
  check('結構：' + c.label, () => {
    const built = c.gs.buildVerifyWorkbookModel_(c.sid, { snapshotId: c.snapshotId || '' });
    const names = built.model.sheets.map(s => s.name);
    assert(names.slice(0, 8).join(',') === '說明,輸入,開發總投,損益試算,驗算,公式區,結構檢查,科目影響', '工作表順序：' + names.join(','));
    if (!c.broken) assert(built.meta.impactBad === 0, '沒改壞的情境，科目影響不應該有問題：' + built.meta.impactBad);
    assert(built.meta.structureChecks.length >= 8, '結構檢查應該涵蓋 A B C E G I K 與整條損益鏈：' + built.meta.structureChecks.join('、'));
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
      const built = c.gs.buildVerifyWorkbookModel_(c.sid, { snapshotId: c.snapshotId || '' });
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
      // 改公式之後的檢查：沒改壞的情境全部通過；改壞的要在 Excel 裡(重算後)抓到
      if (!c.broken) {
        assert(info.D15 === 0, '結構檢查應該全部符合：' + info.D15);
        assert(info.D16 === 0, '科目影響應該沒有問題：' + info.D16);
      } else {
        assert(info.D15 >= 1, '結構檢查應該抓到 C 改壞：' + info.D15);
        assert(info.D16 >= 3, '科目影響應該抓到漏算、重複算：' + info.D16);
        assert(info.D18 >= 1, '變動檢查應該標出「公式沒改、數字卻變了」的科目：' + info.D18);
        // 檔案裡的快取值(不重算的檢視器看到的)要跟 LibreOffice 重算的一樣
        const cached = c.gs.buildVerifyWorkbookModel_(c.sid, { snapshotId: c.snapshotId || '' }).model.sheets[0].rows;
        [15, 16, 17, 18].forEach(r => assert(cached[r - 1][3].v === info['D' + r], `說明 D${r} 快取 ${cached[r - 1][3].v}，重算 ${info['D' + r]}`));
        const st = nums['結構檢查'];
        assert(Object.keys(st).some(k => Math.abs(st[k]) > 1), '結構檢查應該有算出差異');
      }
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

  /* ---------- 從 Excel 匯入：改過的檔案 → 系統，結果要跟 LibreOffice 重算改過的檔案一樣 ---------- */
  check('匯入：在 Excel 改公式與藍字 → 套用後，系統算出來 = LibreOffice 重算改過的檔案', () => {
    const g = loadAppsScript(['Constants.gs', 'Utils.gs', 'FormulaEngine.gs', 'DataService.gs', 'ChartService.gs', 'CalcEngine.gs', 'ReportService.gs', 'WhatIfService.gs', 'SetupSheets.gs', 'XlsxWriter.gs', 'VerifyWorkbook.gs', 'VerifyImport.gs']);
    const s = gatef.buildScenario(g);
    g.getBootstrap('DA');
    const built = g.buildVerifyWorkbookModel_(s);
    stripCache(built.model);
    const files = textFiles(Buffer.from(g.buildXlsxBase64_(built.model), 'base64'));
    const ed = editor(files, built);
    const pl = built.meta.plAt;
    ['D', 'E', 'F'].forEach(c => ed.f('損益試算', c + pl.d4, c + pl.P8 + '*1%'));            // 季Margin 改固定 1%(全部車系)
    ed.f('損益試算', 'D' + pl.C, 'D' + pl.A + '-D' + pl.B + '-500');                          // 只有第一個車系：生產毛利再扣 500
    ed.f('損益試算', 'E' + pl.b9, "ROUND('輸入'!E" + ed.inRow('月銷量') + '*10,0)');          // 手動輸入科目改成公式(只有一個車系)
    ed.f('損益試算', 'F' + pl.b6, 'VLOOKUP(1,A1:B2,2)');                                     // 系統沒有的函式 → 無法匯入
    ed.v('輸入', 'D' + ed.inRow('建議零售價'), 1500000);
    ed.v('輸入', 'C' + ed.inRow('季Margin率'), 0.006);
    ed.v('輸入', 'E' + ed.inRow('銷售佣金率'), 0.08);                                          // 原本引用共用欄 → 車系個別值
    const plan = g.previewVerifyImport(files);
    assert(plan.formulas.map(f => f.code).sort().join() === 'C,b9,d4', '公式變更：' + plan.formulas.map(f => f.code).join());
    assert(plan.inputs.length === 3, '輸入變更應該 3 項：' + plan.inputs.map(i => i.label).join('、'));
    assert(plan.problems.length === 1 && /VLOOKUP/.test(plan.problems[0].reason), '無法匯入：' + JSON.stringify(plan.problems));
    // LibreOffice 重算改過的檔案
    const src = path.join(dir, 'import.xlsx');
    fs.writeFileSync(src, Buffer.from(g.zipStore_(files)));
    execFileSync(soffice, ['-env:UserInstallation=' + profile, '--headless', '--calc', '--convert-to', 'xlsx', '--outdir', path.join(dir, 'outimp'), src], { stdio: 'pipe', timeout: 180000 });
    const lo = fs.readFileSync(path.join(dir, 'outimp', 'import.xlsx'));
    const nums = readNumbers(lo)['損益試算'];
    // LibreOffice 存過的檔案(壓縮、LibreOffice 自己的寫法)也要讀得出同樣的變更
    const plan2 = g.previewVerifyImport(textFiles(lo));
    assert(plan2.formulas.map(f => f.code + ':' + f.after).sort().join() === plan.formulas.map(f => f.code + ':' + f.after).sort().join(), 'LibreOffice 存過的檔案，公式變更不同：' + JSON.stringify(plan2.formulas.map(f => f.after)));
    assert(plan2.inputs.length === 3, 'LibreOffice 存過的檔案，輸入變更：' + plan2.inputs.length);
    // VLOOKUP 那格不匯入：把它的 Excel 值換成系統原本的值再比
    const res = g.applyVerifyImport(files, plan.formulas.map(f => f.id).concat(plan.inputs.map(i => i.id)));
    assert(!res.failed.length, '套用失敗：' + JSON.stringify(res.failed));
    assert(res.snapshot && /匯入 Excel 前/.test(res.snapshot.SnapshotName), '套用前要自動存快照');
    g.SHEET_CACHE_ = {}; g.resetCalcMemo_();
    let worst = 0, where = '';
    built.meta.vehicles.forEach((v, i) => {
      const vals = g.calculatePLCore_(s, v.id).lineValues;
      built.meta.lines.forEach(code => {
        if (code === 'b6' && i === 2) return;
        if (i === 2 && ['B', 'C', 'b13', 'E', 'G', 'I', 'K', 'd4'].indexOf(code) !== -1) return;   // 受 VLOOKUP 那格影響
        const x = nums[String.fromCharCode(68 + i) + built.meta.plAt[code]];
        const d = Math.abs((vals[code] || 0) - x);
        if (d > worst) { worst = d; where = v.id + ' ' + code + ' 系統 ' + vals[code] + ' / Excel ' + x; }
      });
    });
    assert(worst <= 0.01, '匯入後系統跟 Excel 重算不一樣：' + where);
    const again = g.previewVerifyImport(files);
    assert(!again.formulas.length && !again.inputs.length, '套用後再預覽，應該沒有要匯入的了');
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

check('匯入：沒改過的檔案沒有任何變更(含 REF、外幣、車系個別公式、部分車系分攤、目標情境)', () => {
  cases.filter(c => !c.broken).forEach(c => {
    const built = c.gs.buildVerifyWorkbookModel_(c.sid);
    const plan = c.gs.previewVerifyImport(textFiles(Buffer.from(c.gs.buildXlsxBase64_(built.model), 'base64')));
    assert(!plan.formulas.length && !plan.inputs.length && !plan.problems.length,
      c.label + '：' + JSON.stringify({ f: plan.formulas.map(f => f.code + ' ' + f.after), i: plan.inputs.map(i => i.label), p: plan.problems }));
  });
});

check('匯入：開發總投金額與低減目標、匯率、成本金額、攤提基準台數寫回情境', () => {
  const c = cases.filter(x => x.label === 'Gate F 目標(低減、攤提基準台數)')[0];
  const g = c.gs;
  const built = g.buildVerifyWorkbookModel_(c.sid);
  const files = textFiles(Buffer.from(g.buildXlsxBase64_(built.model), 'base64'));
  const ed = editor(files, built);
  const devSheet = built.model.sheets.filter(s => s.name === '開發總投')[0];
  const devRow = devSheet.rows.findIndex(r => r && r[0] && r[0].v === '上汽開發費') + 1;
  ed.v('開發總投', 'G' + devRow, 3500000);
  ed.v('開發總投', 'K' + devRow, 0.25);
  ed.v('輸入', 'C' + ed.inRow('CNY匯率'), 4.5);
  ed.v('輸入', 'E' + ed.inRow('b2 材料成本-KD'), 340000);
  ed.v('輸入', 'C' + ed.inRow('攤提基準 月銷量'), 650);
  const plan = g.previewVerifyImport(files);
  assert(plan.inputs.length === 5 && !plan.formulas.length, '應該 5 項輸入變更：' + plan.inputs.map(i => i.label).join('、'));
  const res = g.applyVerifyImport(files, plan.inputs.map(i => i.id));
  assert(!res.failed.length, '套用失敗：' + JSON.stringify(res.failed));
  reset();
  const dev = g.getDevInvestment(c.sid).filter(r => r.Department === '上汽開發費')[0];
  assert(Number(dev.Amount) === 3500000 && Math.abs(Number(dev.ChallengeReductionPct) - 25) < 1e-9, '開發總投：' + dev.Amount + ' / ' + dev.ChallengeReductionPct);
  assert(g.getParameters(c.sid).some(p => p.Currency === 'CNY' && Number(p.Value) === 4.5), 'CNY 匯率應該是 4.5');
  assert(g.getCostOfSales(c.sid, 'V2').filter(r => r.LineCode === 'b2')[0].Amount == 340000, '材料成本-KD(V2)');
  assert(Number(g.getScenarios().filter(s => s.ScenarioID === c.sid)[0].AmortMonthlyVolume) === 650, '攤提基準月銷量');
  assert(!g.previewVerifyImport(files).inputs.length, '套用後再預覽應該沒有變更');
});

check('匯入：匯出後系統也改了同一個科目 → 標「匯出後系統也改過」', () => {
  const c = cases.filter(x => x.label === 'Gate F 驗算情境(含特殊情況)')[0];
  const built = c.gs.buildVerifyWorkbookModel_(c.sid);
  const files = textFiles(Buffer.from(c.gs.buildXlsxBase64_(built.model), 'base64'));
  const ed = editor(files, built);
  ['D', 'E', 'F'].forEach(col => ed.f('損益試算', col + built.meta.plAt.d4, col + built.meta.plAt.P8 + '*2%'));
  c.gs.saveChartLine('DA', { LineCode: 'd4', LineName: '季Margin', ParentLine: 'E', CalcType: 'FORMULA', Formula: 'P8 * 3%' });
  reset();
  const plan = c.gs.previewVerifyImport(files);
  const d4 = plan.formulas.filter(f => f.code === 'd4')[0];
  assert(d4 && d4.conflict, '應該標出衝突：' + JSON.stringify(d4));
  c.gs.saveChartLine('DA', { LineCode: 'd4', LineName: '季Margin', ParentLine: 'E', CalcType: 'FORMULA', Formula: 'P8 * [季Margin率]' });
  reset();
});

check('匯入：Excel 往右拖曳複製的公式(共用公式)讀得出每一格', () => {
  const xml = '<sheetData><row r="5"><c r="D5"><f t="shared" ref="D5:F5" si="0">D3*$C$1+SUM(D1:D2)</f><v>1</v></c><c r="E5"><f t="shared" si="0"/><v>2</v></c>' +
    '<c r="F5"><f t="shared" si="0"/></c></row></sheetData>';
  const cells = gs.readSheetCells_(xml, []);
  assert(cells.E5.f === 'E3*$C$1+SUM(E1:E2)' && cells.F5.f === 'F3*$C$1+SUM(F1:F2)', '共用公式展開：' + cells.E5.f + ' / ' + cells.F5.f);
  assert(gs.normalizeExcelText_("='輸入'!$D$18 * _xlfn.FORMULATEXT(a1)") === '輸入!D18*FORMULATEXT(A1)', '比對用的正規化');
});

const failed = results.filter(r => !r.ok);
results.forEach(r => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.ok ? '' : '\n      ' + r.err)));
if (failed.length) { console.log(`\n${failed.length} 項失敗`); process.exit(1); }
console.log(`\nExcel 驗算檔：${results.length} 項全部符合`);
