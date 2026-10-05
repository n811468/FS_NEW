/**
 * 地端版工具列：放在頁首下方，負責資料包的匯出/匯入、提醒使用者備份、顯示暫存狀態。
 * 前端 前端程式(src/ui) 完全不知道自己跑在地端版，所有地端專屬的介面都在這裡。
 */
(function () {
  'use strict';
  var host = window.FSLocal.host;
  var Pack = window.FSPack;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'onclick') node.addEventListener('click', attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }
  function safeName(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, '_'); }

  function currentVehicleTypeId() {
    var sel = document.getElementById('vehicletype-selector');
    return sel ? sel.value : '';
  }
  function currentScenario() {
    var sel = document.getElementById('scenario-selector');
    var opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    return sel && sel.value ? { id: sel.value, label: opt ? opt.textContent.trim() : sel.value } : null;
  }

  function download(pack, label) {
    var blob = new Blob([JSON.stringify(pack, null, 1)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: 'FS資料包_' + safeName(label) + '_' + stamp() + '.json' });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  /* ---------------- 工具列 ---------------- */
  var statusEl = el('span', { class: 'fsl-status' });
  var userBtn = el('button', { class: 'fsl-link', type: 'button', title: '地端版沒有 Google 帳號，稽核紀錄與資料包上的「匯出者」用這個名字', onclick: function () {
    var name = window.prompt('你的名字（會記在稽核紀錄與匯出的資料包上）：', window.FSLocal.getUser());
    if (name !== null && name.trim()) { window.FSLocal.setUser(name.trim()); render(); }
  } });
  var fileInput = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) readPackFile(file);
  });

  var exportAllBtn = el('button', { class: 'fsl-menu-item', type: 'button', text: '匯出全部（備份）', title: '整份資料庫存成一個資料包（備份用）', onclick: function () {
    download(host.exportPack(null), '全部');
  } });
  var exportTypeBtn = el('button', { class: 'fsl-menu-item', type: 'button', text: '匯出車型（含所有情境）', title: '匯出上方選的車型：所有情境、車系與科目表，交給同事「合併匯入」（對方這個車型會整個換成這一包）', onclick: function () {
    var id = currentVehicleTypeId();
    if (!id) { window.alert('請先在上方選擇車型。'); return; }
    download(host.exportPack([id]), id);
  } });
  var exportScenarioBtn = el('button', { class: 'fsl-menu-item', type: 'button', text: '匯出情境（只有這一個）', title: '只匯出上方選的情境，交給同事「合併匯入」（對方只新增/更新這個情境，同車型的其他情境不動）', onclick: function () {
    var id = currentVehicleTypeId(), sc = currentScenario();
    if (!id || !sc) { window.alert('請先在上方選擇車型與情境。'); return; }
    var pack;
    try { pack = host.exportPack(null, { scenarioIds: [sc.id] }); }
    catch (e) { window.alert('無法匯出：\n' + e.message); return; }
    download(pack, id + '_' + sc.label);
  } });
  // 三種匯出收在同一顆「匯出 ▾」底下(以前是三顆並排的按鈕)；點了任何一項就把選單收起來
  var exportMenu = el('details', { class: 'fsl-menu' }, [
    el('summary', { class: 'fsl-btn', text: '匯出 ▾', title: '把資料存成資料包（JSON）' }),
    el('div', { class: 'fsl-menu-list' }, [exportAllBtn, exportTypeBtn, exportScenarioBtn])
  ]);
  exportMenu.addEventListener('click', function (e) { if (e.target.classList && e.target.classList.contains('fsl-menu-item')) exportMenu.open = false; });
  document.addEventListener('click', function (e) { if (exportMenu.open && !exportMenu.contains(e.target)) exportMenu.open = false; });
  var importBtn = el('button', { class: 'fsl-btn', type: 'button', text: '匯入資料包…', onclick: function () { fileInput.click(); } });
  var moreSel = el('select', { class: 'fsl-more', title: '其他' }, [
    el('option', { value: '', text: '更多…' }),
    el('option', { value: 'demo', text: '載入示範資料（取代目前資料）' }),
    el('option', { value: 'reset', text: '清空所有資料' })
  ]);
  moreSel.addEventListener('change', function () {
    var v = moreSel.value;
    moreSel.value = '';
    if (v === 'demo') loadDemo();
    if (v === 'reset') resetAll();
  });

  var bar = el('div', { id: 'fs-local-bar' }, [
    el('span', { class: 'fsl-badge', text: '地端版', title: '資料只在這台電腦的瀏覽器裡，不會上傳到任何地方' }),
    el('span', { class: 'fsl-user' }, [document.createTextNode('使用者：'), userBtn]),
    statusEl,
    el('span', { class: 'fsl-spacer' }),
    exportMenu, importBtn, moreSel, fileInput
  ]);
  var banner = el('div', { id: 'fs-local-banner', style: 'display:none' });

  function render() {
    var s = host.state;
    userBtn.textContent = window.FSLocal.getUser();
    var parts = [];
    parts.push(s.lastExportAt ? '上次整份匯出：' + fmtTime(s.lastExportAt) : '尚未匯出過');
    statusEl.textContent = parts.join(' · ');
    if (s.changesSinceExport > 0) {
      statusEl.appendChild(el('span', { class: 'fsl-warn', text: ' · ' + s.changesSinceExport + ' 次修改尚未匯出',
        title: '資料暫存在這個瀏覽器裡，清除瀏覽資料或換電腦就會消失。請定期「匯出全部」備份。' }));
    }
    banner.innerHTML = '';
    if (s.stale) {
      showBanner('danger', '這份資料已經在另一個分頁或視窗被修改過。為了不互相覆蓋，這一頁暫停存檔。',
        el('button', { class: 'fsl-btn', type: 'button', text: '重新整理', onclick: function () { location.reload(); } }));
    } else if (!s.storageOk) {
      showBanner('danger', '瀏覽器無法暫存資料（可能是無痕視窗、空間不足或公司政策封鎖）。資料只在這一頁的記憶體裡，關閉前務必「匯出全部」。');
    } else if (!host.readTables().VehicleTypes.length) {
      showBanner('info', '目前是空的資料庫。可以從「匯入資料包…」載入同事給的資料，或從「更多…」載入示範資料看看；也可以直接在「車型與情境」開始建立。');
    } else {
      banner.style.display = 'none';
    }
  }
  function showBanner(kind, text, action) {
    banner.className = 'fsl-banner-' + kind;
    banner.appendChild(el('span', { text: text }));
    if (action) banner.appendChild(action);
    banner.style.display = 'flex';
  }

  /* ---------------- 匯入 ---------------- */
  var dialog = el('dialog', { id: 'fs-local-dialog' });

  function readPackFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var pack;
      try { pack = Pack.parsePack(String(reader.result)); }
      catch (e) { window.alert('無法讀取「' + file.name + '」：\n' + e.message); return; }
      showImportDialog(pack, file.name);
    };
    reader.onerror = function () { window.alert('讀取檔案失敗：' + file.name); };
    reader.readAsText(file, 'utf-8');
  }

  function describePack(pack) {
    var summary = Pack.summarize(pack.tables);
    var ids = Object.keys(summary);
    var lines = ['匯出時間：' + (fmtTime(pack.exportedAt) || '未知') + (pack.exportedBy ? '　匯出者：' + pack.exportedBy : ''),
      '範圍：' + (pack.scope.kind === 'all' ? '整份資料庫' : pack.scope.kind === 'scenarios' ? '單一情境' : '車型（含所有情境）')];
    if (pack.scope.kind === 'scenarios') {
      lines.push('情境：' + (pack.tables.Scenarios.map(function (r) { return r.VehicleTypeID + ' ' + Pack.scenarioLabel(r); }).join('、') || '（沒有）'));
      return lines.join('\n');
    }
    lines.push(ids.length
      ? '車型：' + ids.map(function (id) { return id + '（' + summary[id].vehicles + ' 個車系、' + summary[id].scenarios + ' 個情境）'; }).join('、')
      : '車型：（沒有）');
    return lines.join('\n');
  }

  function showImportDialog(pack, fileName) {
    dialog.innerHTML = '';
    var preview = el('pre', { class: 'fsl-pre', text: describePack(pack) });
    var mergeBtn = el('button', { class: 'fsl-btn primary', type: 'button', text: '合併匯入', onclick: function () { confirmMerge(pack); } });
    var replaceBtn = el('button', { class: 'fsl-btn danger', type: 'button', text: '取代整個資料庫', onclick: function () {
      if (!window.confirm('目前這個瀏覽器裡的所有資料都會被資料包取代（包含資料包裡沒有的車型）。\n建議先「匯出全部」備份。確定要取代嗎？')) return;
      apply(function () { host.replaceWithPack(pack); });
    } });
    dialog.appendChild(el('h3', { text: '匯入資料包：' + fileName }));
    dialog.appendChild(preview);
    dialog.appendChild(el('ul', { class: 'fsl-help' }, [
      el('li', { text: pack.scope.kind === 'scenarios'
        ? '合併匯入：只新增或更新資料包裡的情境，同車型的其他情境、車系、科目表都不動（本機沒有這個車型時才連車型一起新增）。'
        : '合併匯入：只更新資料包裡有的車型（以資料包為準，這個車型的所有情境都會換成資料包的），其他車型不動。適合把同事負責的車型併進來比較。' }),
      el('li', { text: '取代整個資料庫：清掉目前所有資料，換成資料包的內容。適合還原備份或換電腦。' }),
      el('li', { text: '畫面上還沒按「儲存」的修改，匯入後會遺失。' })
    ]));
    dialog.appendChild(el('div', { class: 'fsl-actions' }, [
      el('button', { class: 'fsl-btn', type: 'button', text: '取消', onclick: function () { dialog.close(); } }),
      replaceBtn, mergeBtn
    ]));
    if (!dialog.open) dialog.showModal();
  }

  function confirmMerge(pack) {
    var result;
    try { result = host.previewMerge(pack); }
    catch (e) { window.alert('無法合併：\n' + e.message); return; }
    dialog.innerHTML = '';
    var text = Pack.describeMerge(result.report) || '資料包裡沒有任何車型，合併不會改變資料。';
    dialog.appendChild(el('h3', { text: '確認合併內容' }));
    dialog.appendChild(el('pre', { class: 'fsl-pre', text: text }));
    dialog.appendChild(el('div', { class: 'fsl-actions' }, [
      el('button', { class: 'fsl-btn', type: 'button', text: '取消', onclick: function () { dialog.close(); } }),
      el('button', { class: 'fsl-btn primary', type: 'button', text: '確定合併', onclick: function () {
        apply(function () { host.mergePack(pack); });
      } })
    ]));
  }

  /** 匯入完整頁重新載入：前端各分頁的快取與選單全部從新資料重建，最不容易出錯 */
  function apply(fn) {
    try { fn(); }
    catch (e) { window.alert('匯入失敗，資料未變更：\n' + e.message); return; }
    if (dialog.open) dialog.close();
    location.reload();
  }

  function loadDemo() {
    if (host.readTables().VehicleTypes.length &&
      !window.confirm('示範資料會取代目前瀏覽器裡的所有資料。建議先「匯出全部」備份。確定要載入嗎？')) return;
    apply(function () { host.replaceWithPack(window.FSLocal.demoPack()); });
  }
  function resetAll() {
    if (!window.confirm('確定要清空所有資料嗎？（只留內建科目）\n建議先「匯出全部」備份，這個動作無法復原。')) return;
    apply(function () { host.resetAll(); });
  }

  host.onChange(render);
  window.addEventListener('DOMContentLoaded', function () {
    var slot = document.getElementById('local-bar-slot');
    var header = document.querySelector('header');
    if (slot) {
      slot.appendChild(bar);
      slot.appendChild(banner);
    } else if (header && header.parentNode) {
      header.parentNode.insertBefore(bar, header.nextSibling);
      bar.parentNode.insertBefore(banner, bar.nextSibling);
    } else {
      document.body.insertBefore(banner, document.body.firstChild);
      document.body.insertBefore(bar, document.body.firstChild);
    }
    document.body.appendChild(dialog);
    render();
  });
}());
