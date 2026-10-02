/**
 * 地端版開機：在前端 script.html 執行之前，把後端主機架好、換上 google.script.run 替身。
 * 這段一定要比 script.html 早執行(build-local.js 把它放在 <body> 最前面)，
 * 前端 DOMContentLoaded 一開場就會呼叫 getBootstrap()。
 */
(function () {
  'use strict';
  var USER_KEY = 'fsLocal.user.v1';

  // 瀏覽器暫存可能整個不能用(無痕模式、公司政策封鎖)，每一次存取都要包 try/catch
  var storage = {
    getItem: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    setItem: function (k, v) { window.localStorage.setItem(k, v); }   // 寫入失敗要讓主機知道，不在這裡吞掉
  };

  function getUser() {
    var name = storage.getItem(USER_KEY);
    return name || '本機使用者';
  }

  var host = FSHost.createHost({
    factory: FSBackendFactory, shim: FSGasShim, pack: FSPack,
    storage: storage, getUser: getUser
  });
  host.start();

  window.FSLocal = {
    host: host,
    USER_KEY: USER_KEY,
    getUser: getUser,
    setUser: function (name) { try { window.localStorage.setItem(USER_KEY, name); } catch (e) { /* 存不了就只在這次有效 */ } },
    demoPack: function () {
      var el = document.getElementById('fs-demo-pack');
      return el ? FSPack.parsePack(el.textContent) : null;
    }
  };

  window.google = window.google || {};
  window.google.script = {
    run: FSHost.createScriptRun(host),
    host: { close: function () { } }
  };

  // 同一個檔案開了兩個分頁(或兩份副本，Chrome 的 file:// 共用同一份暫存)：另一邊存檔時，這邊手上的資料就過期了，
  // 再存就會把對方剛改的蓋掉。偵測到就停止寫入、請使用者重新整理。
  window.addEventListener('storage', function (e) {
    if (e.key === host.STORAGE_KEY) host.markStale();
  });
}());
