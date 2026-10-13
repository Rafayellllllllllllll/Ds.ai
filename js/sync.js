/* ============================================================
 * 跨设备加密云同步（Supabase）
 *  - 所有数据在浏览器内用解锁密钥（派生自口令）做 AES-GCM 加密后才上传，云端只有密文
 *  - 首次在某设备解锁：若云端已有数据，整份继承（换机即有全部记录/设置/Key）
 *  - 之后按“每一项最后修改时间”合并；消息数组在并列时取更全的一份
 *  - 同步范围：整站 localforage 数据（聊天记录/设置/头像等）+ DeepSeek 配置
 * ============================================================ */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://srpumxqpwayoomzmjhis.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_t1Nk21YModCYOFH-lJ9qEQ_60mtWaGs';
  var ROW_ID = 'b64d62af531790793e21bee63477be02cd1b1b163444b17e';
  var REST = SUPABASE_URL + '/rest/v1/ds_vault';

  var LS_DS_CFG = 'MILK_DS_CONFIG_V1';
  var LS_DS_CFG_ALIAS = '__localStorage__' + LS_DS_CFG;
  var META_KEY = 'DS_SYNC_META_V2';

  var dataKey = null;
  var started = false, busy = false;
  var lastReloadAt = 0;

  /* ---------- 基础工具 ---------- */
  function b64ToBuf(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bufToB64(buf) {
    var bytes = new Uint8Array(buf), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function encObj(obj) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var data = new TextEncoder().encode(JSON.stringify(obj));
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, dataKey, data).then(function (ct) {
      return { iv: bufToB64(iv), ct: bufToB64(ct) };
    });
  }
  function decObj(env) {
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(env.iv) }, dataKey, b64ToBuf(env.ct)
    ).then(function (plain) { return JSON.parse(new TextDecoder().decode(plain)); });
  }
  function isMessagesKey(k) { return /_chatMessages$/.test(k); }
  function sigOf(v) {
    var len = Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0);
    return JSON.stringify(v).length + ':' + len;
  }
  function loadMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY)) || { init: false, sig: {}, ts: {} }; }
    catch (e) { return { init: false, sig: {}, ts: {} }; }
  }
  function saveMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {} }

  /* ---------- 本机数据收集 / 落盘 ---------- */
  function collectLocal() {
    var out = {};
    var p = Promise.resolve();
    if (window.localforage && localforage.keys) {
      p = localforage.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k.indexOf('CHAT_APP_V3_') !== 0) return null;
          return localforage.getItem(k).then(function (v) {
            if (v !== null && v !== undefined) out[k] = v;
          }).catch(function () {});
        }));
      }).catch(function () {});
    }
    return p.then(function () {
      try {
        var cfg = localStorage.getItem(LS_DS_CFG);
        if (cfg) out[LS_DS_CFG_ALIAS] = JSON.parse(cfg);
      } catch (e) {}
      return out;
    });
  }
  function applyItem(k, value) {
    if (k === LS_DS_CFG_ALIAS) {
      try { localStorage.setItem(LS_DS_CFG, JSON.stringify(value)); } catch (e) {}
      return Promise.resolve();
    }
    var v = value;
    if (isMessagesKey(k) && Array.isArray(v)) {
      v = v.map(function (m) {
        if (m && !(m.timestamp instanceof Date) && m.timestamp) {
          m = Object.assign({}, m, { timestamp: new Date(m.timestamp) });
        }
        return m;
      });
    }
    if (window.localforage) return localforage.setItem(k, v).catch(function () {});
    return Promise.resolve();
  }

  /* ---------- Supabase REST ---------- */
  function headers(extra) {
    return Object.assign({
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
    }, extra || {});
  }
  function fetchEnvelope() {
    return fetch(REST + '?id=eq.' + ROW_ID + '&select=payload', { headers: headers() })
      .then(function (res) { if (!res.ok) throw new Error('pull ' + res.status); return res.json(); })
      .then(function (rows) {
        if (!rows || !rows.length || !rows[0].payload) return null;
        return JSON.parse(rows[0].payload);
      });
  }
  function uploadEnvelope(envelope) {
    return fetch(REST, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ id: ROW_ID, payload: JSON.stringify(envelope), updated_at: envelope.ts }])
    }).then(function (res) { if (!res.ok) throw new Error('push ' + res.status); });
  }

  /* ---------- 主同步 ---------- */
  function fullSync(initial) {
    if (busy) return Promise.resolve();
    busy = true;
    var meta = loadMeta();
    var tNow = Date.now();

    collectLocal().then(function (localData) {
      // 1) 发现本机相对上次同步发生变化的项，刷新它们的本地修改时间
      var localSig = {};
      Object.keys(localData).forEach(function (k) {
        localSig[k] = sigOf(localData[k]);
        if (!meta.sig || meta.sig[k] !== localSig[k]) meta.ts[k] = tNow;
      });

      // 2) 拉取云端密文
      return fetchEnvelope().then(function (envelope) {
        var hasRemote = !!(envelope && envelope.ct);
        var remoteData = {}, remoteTs = {};
        if (hasRemote) {
          return decObj(envelope).then(function (rp) {
            remoteData = rp.data || {};
            remoteTs = rp.__ts__ || {};
          }).catch(function () { hasRemote = false; });
        }
      }).then(function () {
        var takeKeys = [];
        var merged = Object.assign({}, localData);
        var adoptAll = false;

        if (!meta.init) {
          // 本设备首次同步：云端有东西就整体继承（换机场景）；云端空则这台是“第一台”
          meta.init = true;
          if (Object.keys(remoteData).length) { adoptAll = true; takeKeys = Object.keys(remoteData); }
        } else {
          Object.keys(remoteData).forEach(function (k) {
            var rv = remoteData[k], lv = merged[k];
            var rt = remoteTs[k] || 0, lt = meta.ts[k] || 0;
            var take = false;
            if (lv === undefined) take = true;
            else if (rt > lt) take = true;
            else if (rt === lt && rt > 0 && isMessagesKey(k) && Array.isArray(rv) && Array.isArray(lv) && rv.length > lv.length) take = true;
            if (take) takeKeys.push(k);
          });
        }

        if (adoptAll) merged = Object.assign({}, remoteData);
        takeKeys.forEach(function (k) { merged[k] = remoteData[k]; });

        // 3) 权威时间戳表：每项取本地/远端较新者
        var tsMap = {};
        Object.keys(merged).forEach(function (k) {
          tsMap[k] = Math.max(meta.ts[k] || 0, remoteTs[k] || 0, tNow);
        });

        // 4) 远端带来的项落本机
        return Promise.all(takeKeys.map(function (k) { return applyItem(k, merged[k]); })).then(function () {
          var mergedSig = {};
          Object.keys(merged).forEach(function (k) { mergedSig[k] = sigOf(merged[k]); });

          // 5) 加密上传合并后的整份快照（内容无变化则跳过）
          var changed = Object.keys(mergedSig).some(function (k) { return meta.sig[k] !== mergedSig[k]; }) ||
                        Object.keys(meta.sig).length !== Object.keys(mergedSig).length;

          var uploadP = Promise.resolve();
          if (changed || initial) {
            uploadP = encObj({ data: merged, __ts__: tsMap }).then(function (env) {
              return uploadEnvelope({ v: 1, ts: tNow, iv: env.iv, ct: env.ct });
            }).catch(function (e) { console.warn('[sync] 上传失败', e); });
          }
          return uploadP.then(function () {
            meta.sig = mergedSig;
            meta.ts = tsMap;
            saveMeta(meta);

            // 6) 若本机界面被远端更新，刷新一次让界面/内存重载（限流防循环）
            if (takeKeys.length) {
              var now2 = Date.now();
              if (adoptAll || now2 - lastReloadAt > 30000) {
                lastReloadAt = now2;
                setTimeout(function () { location.reload(); }, 500);
              }
            }
          });
        });
      });
    }).catch(function (e) {
      console.warn('[sync] 同步失败', e);
    }).then(function () { busy = false; });
  }

  /* ---------- 启动 ---------- */
  function start(key) {
    if (started || !key) return;
    started = true;
    dataKey = key;
    setTimeout(function () { fullSync(true); }, 1200);
    setInterval(function () { fullSync(false); }, 15000);
    var flush = function () { /* 页面隐藏/关闭时尽快补一次（尽力而为） */ };
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') fullSync(false);
    });
  }

  document.addEventListener('ds:unlocked', function (e) {
    var key = e.detail && e.detail.key;
    if (key) start(key);
  });
})();
