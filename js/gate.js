/* ============================================================
 * 私密空间密码锁（打开页面即拦截，口令正确才可进入）
 *  - 记忆内容经 AES-256-GCM 加密（window.__EVAN_MEMORY_BUNDLE__）
 *  - 口令用 PBKDF2 派生密钥；口令错误时 GCM 认证失败，拒绝进入
 *  - 口令本身永不写入代码；勾选“记住我”后仅在本机保存派生密钥
 * ============================================================ */
(function () {
  'use strict';

  var KEY_STORE = 'DS_GATE_KEY_V1';
  var unlocked = false;

  function utf8(str) { return new TextEncoder().encode(str); }
  function b64ToBuf(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function bufToUtf8(buf) { return new TextDecoder().decode(buf); }

  function deriveKey(password, saltBuf) {
    var baseKey = crypto.subtle.importKey(
      'raw', utf8(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return baseKey.then(function (bk) {
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: saltBuf, iterations: 200000, hash: 'SHA-256' },
        bk, { name: 'AES-GCM', length: 256 }, true, ['decrypt', 'encrypt']
      );
    });
  }

  function decryptWith(key, bundle) {
    var iv = b64ToBuf(bundle.iv);
    var ctAndTag = b64ToBuf(bundle.data); // 末尾 16 字节为 GCM 认证标签
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ctAndTag);
  }

  function tryDecrypt(password, bundle) {
    return deriveKey(password, b64ToBuf(bundle.salt)).then(function (key) {
      return decryptWith(key, bundle).then(function (plainBuf) {
        return { key: key, text: bufToUtf8(plainBuf) };
      });
    });
  }

  function failUI(msg) {
    var gate = document.getElementById('ds-gate');
    var err = document.getElementById('ds-gate-err');
    var input = document.getElementById('ds-gate-input');
    if (err) { err.textContent = msg || '密码不对，进不去哦'; err.classList.add('show'); }
    if (gate) {
      gate.classList.remove('shake');
      void gate.offsetWidth;
      gate.classList.add('shake');
    }
    if (input) { input.value = ''; input.focus(); }
  }

  var SESSION_KEY = 'DS_GATE_SESSION_V1';
  function rawToB64(raw) {
    var bytes = new Uint8Array(raw);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /* 解锁成功：注入记忆、放开页面、把名字设成 Evan / Iris */
  function unlock(memoryText, key, remember) {
    if (unlocked) return;
    unlocked = true;
    try { window.__EVAN_MEMORY__ = memoryText; } catch (e) {}
    if (key && key.extractable) {
      crypto.subtle.exportKey('raw', key).then(function (raw) {
        var b64 = rawToB64(raw);
        // 会话级保存：同一标签页内同步刷新/重载时免再输密码（关掉标签即失效）
        try { sessionStorage.setItem(SESSION_KEY, b64); } catch (e) {}
        // 勾选“记住我”：本机长期保存
        if (remember) { try { localStorage.setItem(KEY_STORE, b64); } catch (e) {} }
      }).catch(function () {});
    }
    var root = document.documentElement;
    root.classList.remove('ds-locked');
    var gate = document.getElementById('ds-gate');
    if (gate) gate.remove();
    try { document.dispatchEvent(new CustomEvent('ds:unlocked', { detail: { memory: memoryText, key: key } })); } catch (e) {}
    scheduleDefaultNames();
  }

  /* 等主站设置加载完成后，若仍是默认名则改为 Evan / Iris（只设一次，之后不覆盖用户修改） */
  function scheduleDefaultNames() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      try {
        var done = false;
        if (typeof settings !== 'undefined' && settings) {
          if (!settings.partnerName || settings.partnerName === '梦角' || settings.partnerName === '对方') {
            settings.partnerName = 'Evan'; done = true;
          }
          if (!settings.myName || settings.myName === '我') { settings.myName = 'Iris'; done = true; }
          if (done) {
            if (typeof updateUI === 'function') { try { updateUI(); } catch (e) {} }
            if (typeof throttledSaveData === 'function') { try { throttledSaveData(); } catch (e) {} }
            else if (typeof saveData === 'function') { try { saveData(); } catch (e) {} }
          }
          clearInterval(timer);
        }
      } catch (e) {}
      if (tries > 60) clearInterval(timer);
    }, 500);
  }

  function rememberMeChecked() {
    var cb = document.getElementById('ds-gate-remember-cb');
    return !!(cb && cb.checked);
  }

  function bindGate() {
    var root = document.documentElement;
    root.classList.add('ds-locked');
    var form = document.getElementById('ds-gate-form');
    var input = document.getElementById('ds-gate-input');
    var bundle = window.__EVAN_MEMORY_BUNDLE__;

    if (!bundle) { failUI('记忆数据缺失，无法进入'); return; }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var pw = (input.value || '').trim();
      if (!pw) { failUI('请输入密码'); return; }
      var btn = document.getElementById('ds-gate-btn');
      if (btn) btn.disabled = true;
      tryDecrypt(pw, bundle).then(function (r) {
        unlock(r.text, r.key, rememberMeChecked());
      }).catch(function () {
        if (btn) btn.disabled = false;
        failUI('密码不对，进不去哦');
      });
    });

    // 免密自动解锁：优先会话级（同标签页重载），其次本机“记住我”
    var savedRaw = null;
    try { savedRaw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(KEY_STORE); } catch (e) {}
    if (savedRaw) {
      try {
        var bin = atob(savedRaw);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        crypto.subtle.importKey(
          'raw', bytes, { name: 'AES-GCM' }, true, ['decrypt']
        ).then(function (key) {
          return decryptWith(key, bundle).then(function (plainBuf) {
            unlock(bufToUtf8(plainBuf), key, false);
          });
        }).catch(function () {
          try { sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(KEY_STORE); } catch (e) {}
          if (input) input.focus();
        });
      } catch (e) { if (input) input.focus(); }
    } else {
      setTimeout(function () { if (input) input.focus(); }, 100);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindGate);
  } else {
    bindGate();
  }
})();
