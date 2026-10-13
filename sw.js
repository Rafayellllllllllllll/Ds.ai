/* Service Worker：首次访问后台预缓存整站，之后秒开、可离线打开外壳；导航网络优先保证自动更新 */
var CACHE = 'dsai-v5';

// 首屏与功能所需的全部同源核心资源（相对 SW 所在路径，子目录部署也正确）
var CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/evan-memory.js',
  './js/gate.js',
  './js/sync.js',
  './js/config.js',
  './js/utils.js',
  './js/backup-engine.js',
  './js/state.js',
  './js/core.js',
  './js/features/mood.js',
  './js/features/envelope.js',
  './js/features/reply-library.js',
  './js/features/theme-editor.js',
  './js/features/group-chat.js',
  './js/features/call.js',
  './js/games.js',
  './js/features.js',
  './js/data.js',
  './js/onboarding.js',
  './js/listeners.js',
  './js/app.js',
  './js/ai-deepseek.js',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  // 后台逐个预缓存；个别失败不阻塞安装
  e.waitUntil(caches.open(CACHE).then(function (cache) {
    return Promise.all(CORE.map(function (p) {
      return cache.add(p).catch(function () {});
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（DeepSeek / Supabase 等）一律不拦截

  // 页面导航：缓存优先（弱网也能秒开外壳），后台静默拉取最新版留到下次打开生效；首次无缓存才走网络
  if (req.mode === 'navigate') {
    e.respondWith(caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () { return null; });
      return cached || network.then(function (r) { return r || caches.match('./'); });
    }));
    return;
  }

  // 同源静态资源：缓存优先（命中即 0 延迟），后台静默更新
  e.respondWith(caches.match(req).then(function (cached) {
    var network = fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () { return cached; });
    return cached || network;
  }));
});
