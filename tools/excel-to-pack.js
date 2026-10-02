/**
 * 「Excel 轉資料包」的命令列版：跟 dist/FS-excel-to-pack.html 同一套邏輯(local/excel-*.js)，
 * 全部採用自動判斷(等於在畫面上選完檔、什麼都不改就按「建立並驗算」)，逐格驗算通過才輸出資料包。
 *
 *   node tools/excel-to-pack.js <檔案.xlsx> [選項]
 *
 *   --sheet 名稱          參考分頁(預設：第一個沒隱藏的分頁)
 *   --all-same            版面跟參考分頁相同的分頁全部一起轉，每個分頁一個情境
 *   --target 文字         分頁名稱包含這段文字的情境設為「目標」(其他為「現況」)，例如 --target 挑戰
 *   --type 代號           車型代號(預設：參考分頁名稱開頭的英數字，如 D5X)
 *   --notes 文字          車型備註
 *   --gate "GATE F"       情境的 GATE 別
 *   --exported-at ISO     資料包上的匯出時間(固定下來，重新產生時檔案內容不會只因時間不同而變動)
 *   --out 路徑            輸出位置(預設：data/<車型>_資料包.json)
 *
 * 判斷結果(每一列是公式、開發攤提、還是帶入數字與原因)與逐格驗算結果都會印出來；有不相同的格子就不輸出。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const X = require('../local/xlsx-reader.js');
const E = require('../local/excel-pack.js');
const F = require('../local/excel-formula.js');
const Pack = require('../local/pack.js');
const Host = require('../local/host.js');
const Shim = require('../local/gas-shim.js');
const build = require('./build-local');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all-same') out.allSame = true;
    else if (/^--/.test(a)) out[a.slice(2).replace(/-(\w)/g, (m, c) => c.toUpperCase())] = argv[++i];
    else out._.push(a);
  }
  return out;
}

/** 用固定的亂數種子產生 ID：同一份 Excel 重新產生時，資料包內容一模一樣，git 看得出真正改了什麼 */
function seededUuid(seed) {
  let n = 0;
  return () => {
    n++;
    const h = require('crypto').createHash('sha1').update(seed + ':' + n).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
}

async function main() {
  const o = args(process.argv.slice(2));
  const file = o._[0];
  if (!file) { console.log('用法：node tools/excel-to-pack.js <檔案.xlsx> [--sheet 名稱] [--all-same] [--target 文字] [--out 路徑]'); process.exit(1); }
  const wb = await X.readWorkbook(fs.readFileSync(file), b => zlib.inflateRawSync(b));
  const ref = o.sheet !== undefined ? wb.sheets.findIndex(s => s.name === o.sheet) : wb.sheets.findIndex(s => !s.hidden && s.maxRow > 0);
  if (ref < 0) throw new Error('找不到分頁：' + o.sheet + '\n分頁有：' + wb.sheets.map(s => s.name).join('、'));
  const sheets = o.allSame ? E.sameLayoutSheets(wb, ref) : [ref];
  const { plan, notes } = E.autoPlan(wb, ref, sheets, {
    typeId: o.type, gate: o.gate,
    typeNotes: o.notes !== undefined ? o.notes : '來源：' + path.basename(file),
    typeOf: name => (o.target && name.indexOf(o.target) !== -1 ? '目標' : '現況')
  });

  const factory = build.loadBackendFactory();
  const uuid = seededUuid(path.basename(file) + '|' + plan.typeId + '|' + sheets.join(','));
  const res = E.buildAndVerify(() => {
    const host = Host.createHost({ factory, shim: Shim, pack: Pack, storage: null, getUser: () => 'Excel 轉資料包', getUuid: uuid });
    host.start();
    return { host, api: new Proxy({}, { get: (_, n) => (...a) => host.call(n, a) }) };
  }, plan);

  // ---- 判斷結果 ----
  const tr = res.built.translation;
  const fb = res.plan.fallback || {};
  console.log(`車型 ${plan.typeId}，車系 ${plan.vehicles.map(v => v.name).join('/')}，情境 ${plan.scenarios.map(s => s.name + '(' + s.type + ')').join('、')}`);
  notes.forEach(n => console.log('  ※ ' + n));
  plan.rows.forEach(r => {
    const role = plan.roles[r.row];
    if (!role || role.role === 'skip') return;
    const t = tr.rows[r.row];
    let how = E.ROLE_LABELS[role.role];
    if (t) {
      const mode = fb[r.row] ? 'input' : res.built.formulaRows[r.row] || 'input';
      if (mode === 'amort') {
        const a = t.amort[0];
        how = `開發攤提：「${a.source}」${a.investments.length} 筆投資 ÷ ${a.units.value} 台`;
      } else if (mode === 'formula' || mode === 'mixed') {
        how = '公式：' + (t.formula ? F.displayFormula(t.formula, plan, tr.params) : '') +
          (Object.keys(t.vehicleFormulas).length ? '(車系個別公式 ' + Object.keys(t.vehicleFormulas).map(i => plan.vehicles[i].name).join('、') + ')' : '');
      } else how = '數字' + (fb[r.row] || t.reason ? '：' + (fb[r.row] || t.reason) : t.note ? '(' + t.note + ')' : '');
    }
    console.log(`  ${String(r.row).padStart(3)} ${r.label}  →  ${how}`);
  });

  // ---- 驗算 ----
  let bad = 0;
  res.verify.forEach(v => {
    bad += v.mismatches;
    console.log(`  ${v.ok ? '✓' : '✗'} ${v.sheetName} → 情境「${v.scenarioName}」：${v.checked - v.mismatches}/${v.checked} 格與 Excel 相同`);
    v.rows.forEach(row => row.cells.forEach((c, i) => {
      if (c.ok === false) console.log(`      第 ${row.row} 列 ${row.label} 第 ${i + 1} 欄：Excel ${c.excel}，系統 ${c.system}`);
    }));
  });
  if (bad) { console.log(`有 ${bad} 格跟 Excel 不同，沒有輸出資料包。請改用 dist/FS-excel-to-pack.html 逐列調整。`); process.exit(1); }

  const pack = res.env.host.exportPack([plan.typeId]);
  pack.exportedAt = o.exportedAt || pack.exportedAt;
  pack.exportedBy = 'Excel 轉資料包';
  pack.source = { kind: 'excel', file: path.basename(file), sheets: plan.scenarios.map(s => s.sheet.name) };
  const out = o.out || path.join(__dirname, '..', 'data', plan.typeId + '_資料包.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(pack, null, 1) + '\n');
  const t = pack.tables;
  console.log(`已輸出 ${path.relative(process.cwd(), out)}：${t.Scenarios.length} 個情境、${t.PLLineItems.length} 個科目、` +
    `開發總投 ${t.DevInvestment.length} 筆、參數 ${t.Parameters.length} 筆`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
