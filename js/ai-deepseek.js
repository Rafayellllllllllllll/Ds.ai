/* ============================================================
 * DeepSeek AI 接入模块（纯前端 / 仅本人使用）
 *  - API Key 只保存在使用者自己浏览器的 localStorage，不写入代码、不上传
 *  - 开启后，对方回复由 DeepSeek 根据对话与人设实时生成
 *  - 关闭或调用失败时自动回退到网站原本的随机回复库
 * ============================================================ */
(function () {
  'use strict';

  var LS_KEY = 'MILK_DS_CONFIG_V1';
  var ENDPOINT = 'https://api.deepseek.com/chat/completions';

  var defaultConfig = {
    enabled: false,
    apiKey: '',
    model: 'deepseek-chat',
    persona: ''        // 可选：补充对方性格/设定（partnerName 会自动带入）
  };

  function loadConfig() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return Object.assign({}, defaultConfig);
      return Object.assign({}, defaultConfig, JSON.parse(raw));
    } catch (e) {
      return Object.assign({}, defaultConfig);
    }
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  var config = loadConfig();
  var busy = false;

  /* 读取最近的对话，组装成 DeepSeek 的消息格式 */
  function buildMessages(partnerName, lastUserText) {
    var sysName = (partnerName && String(partnerName).trim()) || '对方';
    var persona = (config.persona || '').trim();

    var systemPrompt =
      '你正在和用户进行一对一的聊天，你要扮演的角色名叫「' + sysName + '」，是用户非常亲密、在乎的人。' +
      '请完全代入这个角色，用「' + sysName + '」的口吻、以即时聊天的方式回复用户。' +
      '要求：1) 回复自然、口语化、有温度，符合亲密关系的语气；' +
      '2) 每次只回复一条聊天消息，长度简短，通常不超过50个字，不要分段、不要写称呼前缀、不要解释、不要输出引号或旁白；' +
      '3) 顺着用户的话回应，记住你们最近聊过的内容；' +
      '4) 不要承认自己是AI、不要提模型或程序。' +
      (persona ? ('5) 角色的具体设定与性格：' + persona) : '');

    var msgs = [{ role: 'system', content: systemPrompt }];

    var history = null;
    try {
      if (Array.isArray(window.messages)) history = window.messages;
      else if (Array.isArray(window.__milkMessages)) history = window.__milkMessages;
    } catch (e) {}

    if (history && history.length) {
      var recent = history.filter(function (m) {
        return m && typeof m.text === 'string' && m.text.trim() && !m.image;
      }).slice(-16);
      recent.forEach(function (m) {
        if (m.sender === 'user') {
          msgs.push({ role: 'user', content: m.text.trim() });
        } else if (m.sender !== null && m.sender !== undefined) {
          msgs.push({ role: 'assistant', content: m.text.trim() });
        }
      });
    } else if (lastUserText) {
      msgs.push({ role: 'user', content: String(lastUserText).trim() });
    }
    return msgs;
  }

  /* 调用 DeepSeek，返回回复文本；失败返回 null（交由回退逻辑处理） */
  function callDeepSeek(partnerName, lastUserText) {
    if (!config.apiKey) return Promise.resolve(null);

    var ctrl = new AbortController();
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 30000);

    var body = {
      model: config.model || 'deepseek-chat',
      messages: buildMessages(partnerName, lastUserText),
      stream: false,
      temperature: 0.9,
      max_tokens: 200
    };

    return fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            var detail = '';
            try { detail = JSON.parse(t).error.message; } catch (e) { detail = t; }
            throw new Error('HTTP ' + res.status + ' ' + detail);
          });
        }
        return res.json();
      })
      .then(function (data) {
        var text = data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content : '';
        text = String(text || '').trim()
          .replace(/^["'“”]+|["'“”]+$/g, '')
          .replace(/\s+/g, ' ');
        return text || null;
      })
      .catch(function (err) {
        console.warn('[DeepSeek] 调用失败，回退随机回复：', err);
        try {
          if (typeof window.showNotification === 'function') {
            window.showNotification('AI 暂时没回应，已切回随机回复', 'info', 2500);
          }
        } catch (e) {}
        return null;
      })
      .finally(function () { clearTimeout(timer); });
  }

  /* 供 core.js 调用：是否启用 AI */
  window.__dsIsEnabled = function () {
    return !!(config.enabled && config.apiKey) && !busy;
  };

  /* 供 core.js 调用：生成一条 AI 回复 */
  window.__dsGenerate = function (partnerName, lastUserText) {
    if (busy) return Promise.resolve(null);
    busy = true;
    return callDeepSeek(partnerName, lastUserText).finally(function () { busy = false; });
  };

  /* ====================== 设置面板 UI ====================== */
  function el(tag, attrs, html) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'style') node.setAttribute('style', attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function openPanel() {
    var existing = document.getElementById('ds-panel');
    if (existing) { existing.style.display = 'flex'; return; }

    var mask = el('div', { id: 'ds-panel', style:
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.45);padding:20px;box-sizing:border-box;' });

    var box = el('div', { style:
      'width:100%;max-width:420px;max-height:90vh;overflow:auto;background:var(--primary-bg,#fff);color:var(--text-primary,#222);' +
      'border-radius:18px;padding:22px;box-shadow:0 12px 40px rgba(0,0,0,.3);box-sizing:border-box;' +
      'font-family:-apple-system,"Noto Serif SC",serif;' });

    box.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">' +
        '<div style="font-size:18px;font-weight:600;">DeepSeek AI 设置</div>' +
        '<div id="ds-close" style="cursor:pointer;font-size:20px;opacity:.6;line-height:1;">✕</div>' +
      '</div>' +

      '<label style="display:flex;align-items:center;gap:8px;margin-bottom:16px;cursor:pointer;font-size:15px;">' +
        '<input type="checkbox" id="ds-enabled" ' + (config.enabled ? 'checked' : '') + ' style="width:18px;height:18px;">' +
        '<span>开启 AI 回复（关闭则用原本的随机回复）</span>' +
      '</label>' +

      '<div style="font-size:13px;margin-bottom:6px;opacity:.8;">API Key（仅保存在本机浏览器）</div>' +
      '<input id="ds-key" type="password" placeholder="sk-..." value="' + (config.apiKey || '').replace(/"/g, '&quot;') + '" ' +
        'style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border-color,#ccc);border-radius:10px;font-size:14px;margin-bottom:14px;background:transparent;color:inherit;">' +

      '<div style="font-size:13px;margin-bottom:6px;opacity:.8;">模型</div>' +
      '<select id="ds-model" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border-color,#ccc);border-radius:10px;font-size:14px;margin-bottom:14px;background:var(--primary-bg,#fff);color:inherit;">' +
        '<option value="deepseek-chat">deepseek-chat（通用对话，便宜快）</option>' +
        '<option value="deepseek-reasoner">deepseek-reasoner（推理，较慢较贵）</option>' +
      '</select>' +

      '<div style="font-size:13px;margin-bottom:6px;opacity:.8;">对方性格 / 设定（可选）</div>' +
      '<textarea id="ds-persona" rows="3" placeholder="例如：温柔、爱撒娇、偶尔毒舌；是我恋爱多年的恋人……" ' +
        'style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border-color,#ccc);border-radius:10px;font-size:14px;margin-bottom:18px;resize:vertical;background:transparent;color:inherit;">' +
        (config.persona || '').replace(/</g, '&lt;') + '</textarea>' +

      '<div style="display:flex;gap:10px;">' +
        '<button id="ds-save" style="flex:1;padding:12px;border:none;border-radius:12px;background:var(--accent-color,#c98b5f);color:#fff;font-size:15px;cursor:pointer;">保存</button>' +
        '<button id="ds-test" style="padding:12px 16px;border:1px solid var(--border-color,#ccc);border-radius:12px;background:transparent;color:inherit;font-size:14px;cursor:pointer;">测试连接</button>' +
      '</div>' +
      '<div id="ds-tip" style="font-size:12px;opacity:.7;margin-top:12px;line-height:1.6;">Key 只存在你当前浏览器里，不会写进公开网页，也不会上传。换设备/浏览器需要重新填写。</div>';

    mask.appendChild(box);
    document.body.appendChild(mask);

    var close = function () { mask.style.display = 'none'; };
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    box.querySelector('#ds-close').addEventListener('click', close);

    box.querySelector('#ds-model').value = config.model || 'deepseek-chat';

    box.querySelector('#ds-save').addEventListener('click', function () {
      config.enabled = box.querySelector('#ds-enabled').checked;
      config.apiKey = box.querySelector('#ds-key').value.trim();
      config.model = box.querySelector('#ds-model').value;
      config.persona = box.querySelector('#ds-persona').value.trim();
      saveConfig(config);
      if (typeof window.__dsRefreshFab === 'function') window.__dsRefreshFab();
      var tip = box.querySelector('#ds-tip');
      tip.textContent = config.enabled
        ? (config.apiKey ? '✅ 已保存并开启 AI 回复，去发条消息试试～' : '⚠️ 已开启，但还没填 API Key')
        : '✅ 已保存，当前为原本的随机回复模式';
      if (config.enabled && config.apiKey) setTimeout(close, 1200);
    });

    box.querySelector('#ds-test').addEventListener('click', function () {
      var tip = box.querySelector('#ds-tip');
      var key = box.querySelector('#ds-key').value.trim();
      if (!key) { tip.textContent = '⚠️ 请先填写 API Key'; return; }
      tip.textContent = '⏳ 正在测试…';
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model: box.querySelector('#ds-model').value, messages: [{ role: 'user', content: '在吗？回复一个字' }], max_tokens: 10 })
      })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          tip.textContent = '✅ 连接成功，Key 有效！记得点「保存」';
        })
        .catch(function (e) { tip.textContent = '❌ 连接失败：' + e.message + '（检查 Key / 余额 / 网络）'; });
    });
  }

  function mountButton() {
    if (document.getElementById('ds-fab')) return;
    var btn = el('div', { id: 'ds-fab', title: 'DeepSeek AI 设置', style:
      'position:fixed;right:14px;bottom:86px;z-index:99998;width:46px;height:46px;border-radius:50%;' +
      'background:var(--accent-color,#c98b5f);color:#fff;display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;font-size:20px;user-select:none;' }, '🤖');
    btn.addEventListener('click', openPanel);
    document.body.appendChild(btn);

    var dot = el('span', { id: 'ds-dot', style:
      'position:absolute;top:2px;right:2px;width:11px;height:11px;border-radius:50%;border:2px solid #fff;' +
      'background:' + (config.enabled && config.apiKey ? '#3ecf6b' : '#bbb') + ';' });
    btn.appendChild(dot);
  }

  window.__dsRefreshFab = function () {
    var dot = document.getElementById('ds-dot');
    if (dot) dot.style.background = (config.enabled && config.apiKey) ? '#3ecf6b' : '#bbb';
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountButton);
  } else {
    mountButton();
  }
})();
