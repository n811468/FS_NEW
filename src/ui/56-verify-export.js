/* ================= 匯出 Excel 驗算檔 =================
 * 一個情境一個檔：輸入數字 + 由「科目與公式」翻成的 Excel 公式 + 驗算頁 + 公式區(見後端 VerifyWorkbook.gs)。
 * 匯出前的對話框選情境(儀表板的比較欄位有好幾個情境時)與要比較的快照；沒有快照、也只有一個情境時直接匯出。
 */
function verifyScenarioChoices_() {
  const seen = {}, out = [];
  const labelOf = id => {
    for (const t of comparisonOptions || []) {
      const s = (t.scenarios || []).find(x => x.ScenarioID === id);
      if (s) return [t.VehicleTypeID, s.Gate, s.ScenarioName].filter(Boolean).join(' ');
    }
    const s = (scenarioCache || []).find(x => x.ScenarioID === id);
    return s ? [s.VehicleTypeID, s.Gate, s.ScenarioName].filter(Boolean).join(' ') : id;
  };
  const add = id => { if (id && !seen[id] && !/^snap:/.test(id)) { seen[id] = true; out.push([id, labelOf(id)]); } };
  add(currentScenarioId);
  (comparisonSelections || []).forEach(s => add(s.ScenarioID));
  return out;
}

function exportVerifyWorkbookFromDashboard() { exportVerifyWorkbookDialog(); }

/**
 * 匯出對話框：選情境，另外可以選一個快照(改公式、科目之前存的)，驗算檔就會多一頁「變動檢查」。
 * 沒有快照、也只有一個情境可選時直接匯出。
 */
function exportVerifyWorkbookDialog(scenarioId) {
  const choices = verifyScenarioChoices_();
  if (scenarioId && !choices.some(c => c[0] === scenarioId)) choices.unshift([scenarioId, scenarioId]);
  if (!choices.length) { toast('請先在右上角選擇情境', 'err'); return; }
  const first = scenarioId || choices[0][0];
  google.script.run
    .withSuccessHandler(safeHandler(snaps => {
      snaps = (snaps || []).filter(s => s.scenarioExists !== false);
      if (!snaps.length && choices.length === 1) { exportVerifyWorkbook(first); return; }
      const day = iso => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
      const latest = snaps.find(s => s.ScenarioID === first);
      openModal({
        title: '匯出 Excel 驗算檔',
        body: '<p class="muted">一個情境一個檔：輸入數字、每個科目的 Excel 公式、驗算頁、公式區，以及改公式／科目之後的檢查（結構檢查、科目影響、跟系統預設比較）。</p>',
        okText: '匯出',
        fields: [
          { name: 'sid', label: '情境', type: 'select', value: first, options: choices },
          { name: 'snap', label: '跟快照比（選填）', type: 'select', value: latest ? latest.SnapshotID : '',
            options: [['', '（不比較）']].concat(snaps.map(s => [s.SnapshotID, `${s.SnapshotName}（${[s.VehicleTypeID, s.scenarioLabel].filter(Boolean).join(' ')}，${day(s.CreatedAt)}）`])),
            help: '改公式、科目之前先存情境快照，這裡選它，驗算檔會多一頁「變動檢查」：逐科目列出改前 → 改後的差異，標出公式沒改、數字卻變了的科目。' }
        ]
      }).then(r => { if (r) exportVerifyWorkbook(r.sid, r.snap); });
    }))
    .withFailureHandler(showGlobalError)
    .getSnapshots('');
}

function exportVerifyWorkbook(scenarioId, snapshotId) {
  const sid = scenarioId || currentScenarioId;
  if (!sid) { toast('請先在右上角選擇情境', 'err'); return; }
  toast('正在產生 Excel 驗算檔…');
  google.script.run
    .withSuccessHandler(safeHandler(res => {
      const bin = atob(res.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url; a.download = res.fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast(`已下載 ${res.fileName}（${res.lines} 個科目 × ${res.vehicles} 個車系）`, 'ok', 4000);
      if (res.impactBad) toast(`有 ${res.impactBad} 個科目沒算進營業淨利、重複計算或正負號相反，看驗算檔的「科目影響」`, 'err');
      if (res.errors && res.errors.length) toast(`有 ${res.errors.length} 個科目的公式在系統裡就是錯誤（以 0 計），驗算檔的公式區有標出來`, 'err');
    }))
    .withFailureHandler(showGlobalError)
    .exportVerifyWorkbook(sid, snapshotId || '');
}

/* ================= 從 Excel 驗算檔匯入 =================
 * 選檔 → 瀏覽器解壓縮(xlsx 是 zip) → 後端 previewVerifyImport 列出會改什麼 → 勾選確認 → applyVerifyImport。
 * 後端會先自動存一份快照；公式一律走「科目與公式」同一個存檔函式，擋得下來的錯誤(循環引用…)照樣擋。
 */
function importVerifyWorkbookDialog() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    toast('讀取 ' + file.name + '…');
    file.arrayBuffer().then(unzipXlsxTexts_).then(files => {
      google.script.run
        .withSuccessHandler(safeHandler(plan => showVerifyImportPreview_(file.name, files, plan)))
        .withFailureHandler(showGlobalError)
        .previewVerifyImport(files);
    }).catch(e => toast('無法讀取「' + file.name + '」：' + e.message, 'err'));
  };
  input.click();
}

/** xlsx(zip) → { 檔名: 文字 }：只取 XML；壓縮過的用瀏覽器內建的 DecompressionStream 解開 */
async function unzipXlsxTexts_(buf) {
  const view = new DataView(buf), bytes = new Uint8Array(buf);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('這不是 Excel 檔(xlsx)');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.(xml|rels)$/.test(name)) continue;
    const lNameLen = view.getUint16(offset + 26, true), lExtraLen = view.getUint16(offset + 28, true);
    const data = bytes.subarray(offset + 30 + lNameLen + lExtraLen, offset + 30 + lNameLen + lExtraLen + size);
    if (method === 0) files[name] = dec.decode(data);
    else if (method === 8) {
      if (typeof DecompressionStream !== 'function') throw new Error('這個瀏覽器太舊，請用新版 Chrome 或 Edge');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      files[name] = dec.decode(await new Response(stream).arrayBuffer());
    } else throw new Error('不支援的壓縮方式');
  }
  return files;
}

function showVerifyImportPreview_(fileName, files, plan) {
  const fmtVal = (v, pct) => typeof v === 'number' ? (pct ? (v * 100).toLocaleString('zh-TW', { maximumFractionDigits: 6 }) + '%' : v.toLocaleString('zh-TW', { maximumFractionDigits: 6 })) : esc(v);
  const conflictTag = '<span class="vi-conflict" data-tip="匯出這個檔案之後，系統裡的這個地方也改過了；確認要用 Excel 的版本蓋掉才勾">匯出後系統也改過</span>';
  const fRows = plan.formulas.map(f => `<tr>
      <td><input type="checkbox" class="vi-pick" value="${esc(f.id)}"${f.conflict ? '' : ' checked'}></td>
      <td class="vi-name">${esc(f.name)}<div class="muted">${esc(f.vehicles.join('、'))}</div></td>
      <td><code>${esc(f.before)}</code></td><td><code>${esc(f.after)}</code></td>
      <td>${f.conflict ? conflictTag : ''}${f.notes.map(n => `<div class="muted">${esc(n)}</div>`).join('')}</td></tr>`).join('');
  const iRows = plan.inputs.map(x => `<tr>
      <td><input type="checkbox" class="vi-pick" value="${esc(x.id)}"${x.conflict ? '' : ' checked'}></td>
      <td class="vi-name">${esc(x.label)}<div class="muted">${esc(x.vehicle)}</div></td>
      <td class="num">${fmtVal(x.before, x.isPct)}</td><td class="num"><b>${fmtVal(x.after, x.isPct)}</b></td>
      <td>${x.conflict ? conflictTag : ''}${x.notes.map(n => `<div class="muted">${esc(n)}</div>`).join('')}</td></tr>`).join('');
  const pRows = plan.problems.map(p => `<tr><td class="vi-name">${esc(p.label)}<div class="muted">${esc(p.where)}</div></td>
      <td>${esc(p.reason)}${p.excel ? `<div class="muted"><code>=${esc(p.excel)}</code></div>` : ''}</td></tr>`).join('');
  const nothing = !plan.formulas.length && !plan.inputs.length;
  const body = `
    <p>檔案：<b>${esc(fileName)}</b>　情境：<b>${esc(plan.scenario.label)}</b></p>
    ${nothing ? '<p>這個檔案跟系統現在的公式、數字一樣，沒有要匯入的修改。</p>' : `<p class="muted">勾選要匯入的項目。匯入前系統會自動存一份快照「匯入 Excel 前」，之後匯出驗算檔選它就能看到改了什麼。</p>`}
    ${plan.formulas.length ? `<h4 class="vi-h">公式（${plan.formulas.length}）<span class="muted">科目表是整個車型共用，會影響 ${esc(plan.scenario.typeId)} 的所有情境</span></h4>
      <div class="grid-scroll vi-scroll"><table class="grid-table vi-table"><thead><tr><th></th><th>科目</th><th>現在</th><th>匯入後</th><th>說明</th></tr></thead><tbody>${fRows}</tbody></table></div>` : ''}
    ${plan.inputs.length ? `<h4 class="vi-h">輸入數字（${plan.inputs.length}）<span class="muted">寫回情境 ${esc(plan.scenario.label)}</span></h4>
      <div class="grid-scroll vi-scroll"><table class="grid-table vi-table"><thead><tr><th></th><th>項目</th><th>現在</th><th>匯入後</th><th>說明</th></tr></thead><tbody>${iRows}</tbody></table></div>` : ''}
    ${plan.problems.length ? `<h4 class="vi-h">無法匯入（${plan.problems.length}）<span class="muted">這些格子不會存，請在系統裡改，或改成系統看得懂的寫法再匯入</span></h4>
      <div class="grid-scroll vi-scroll"><table class="grid-table vi-table vi-problems"><thead><tr><th>格子</th><th>原因</th></tr></thead><tbody>${pRows}</tbody></table></div>` : ''}`;
  openModal({
    title: '從 Excel 驗算檔匯入', body, wide: true, okText: nothing ? '知道了' : '匯入勾選的項目', noCancel: nothing,
    collect: dlg => ({ ids: Array.from(dlg.querySelectorAll('.vi-pick:checked')).map(x => x.value) })
  }).then(r => {
    if (!r || nothing) return;
    if (!r.ids.length) { toast('沒有勾選任何項目', 'err'); return; }
    google.script.run
      .withSuccessHandler(safeHandler(res => {
        const ok = `已匯入 ${res.applied} 項` + (res.snapshot ? `，匯入前的數字存成快照「${res.snapshot.SnapshotName}」` : '');
        if (res.failed.length) {
          openModal({ title: '部分項目沒有匯入', okText: '知道了', noCancel: true,
            body: `<p>${esc(ok)}。下面這些沒有存：</p><ul>${res.failed.map(f => `<li><b>${esc(f.label)}</b>：${esc(f.error)}</li>`).join('')}</ul>` });
        } else toast(ok, 'ok', 5000);
        if (typeof renderTab === 'function') renderTab(currentTab);
      }))
      .withFailureHandler(showGlobalError)
      .applyVerifyImport(files, r.ids);
  });
}
