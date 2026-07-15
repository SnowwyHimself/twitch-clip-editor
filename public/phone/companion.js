// Companion page (phone side). Pairs once (token → localStorage), then lists the
// desktop's recent exports and downloads them over the LAN. No frameworks.
(function () {
  'use strict';
  var TOKEN_KEY = 'clipEditorPhoneToken';
  var el = function (id) { return document.getElementById(id); };

  // 1) If we just landed from /pair, capture the one-time token from the meta tag,
  //    persist it, remove the tag, and scrub ?code from the URL.
  var meta = document.querySelector('meta[name="pair-token"]');
  if (meta) {
    try { localStorage.setItem(TOKEN_KEY, meta.getAttribute('content') || ''); } catch (e) {}
    meta.parentNode.removeChild(meta);
    try { history.replaceState(null, '', '/app'); } catch (e) {}
  }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;

  function fmtDur(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtSize(bytes) {
    if (!isFinite(bytes) || bytes <= 0) return '';
    var mb = bytes / (1024 * 1024);
    if (mb < 1) return Math.round(bytes / 1024) + ' KB';
    if (mb < 1024) return mb.toFixed(1) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
  }
  function fmtWhen(ts) {
    if (!ts) return '';
    var d = new Date(ts), now = new Date();
    var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? t : (d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t);
  }

  function show(id, on) { el(id).classList.toggle('hidden', !on); }

  function renderList(items) {
    var list = el('list');
    list.innerHTML = '';
    var t = token();
    items.forEach(function (e) {
      var card = document.createElement('div');
      card.className = 'card';

      var poster = document.createElement('div');
      poster.className = 'poster';
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = '/api/poster/' + encodeURIComponent(e.name) + '?t=' + encodeURIComponent(t);
      img.addEventListener('error', function () { poster.removeChild(img); });
      poster.appendChild(img);
      if (e.durationSec) {
        var dur = document.createElement('span');
        dur.className = 'dur';
        dur.textContent = fmtDur(e.durationSec);
        poster.appendChild(dur);
      }
      card.appendChild(poster);

      var body = document.createElement('div');
      body.className = 'card-body';
      var name = document.createElement('div');
      name.className = 'card-name';
      name.textContent = e.filename || e.name;
      var metaLine = document.createElement('div');
      metaLine.className = 'card-meta';
      metaLine.textContent = [fmtSize(e.sizeBytes), fmtWhen(e.savedAt)].filter(Boolean).join(' · ');
      var dl = document.createElement('a');
      dl.className = 'dl';
      dl.href = '/api/download/' + encodeURIComponent(e.name) + '?t=' + encodeURIComponent(t);
      dl.setAttribute('download', e.filename || e.name);
      dl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg><span>Download</span>';
      body.appendChild(name);
      body.appendChild(metaLine);
      body.appendChild(dl);
      card.appendChild(body);
      list.appendChild(card);
    });
  }

  var loading = false;
  function load() {
    if (loading) return;
    if (!token()) { show('unpaired', true); return; }
    loading = true;
    el('refresh').classList.add('spinning');
    fetch('/api/exports', { headers: { Authorization: 'Bearer ' + token() } })
      .then(function (r) {
        if (r.status === 401) { clearToken(); show('list', false); show('unpaired', true); return null; }
        if (!r.ok) throw new Error('bad');
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        show('unpaired', false);
        show('error', false);
        var items = (data.exports || []);
        show('empty', items.length === 0);
        renderList(items);
        maybeHints();
      })
      .catch(function () { show('error', true); })
      .then(function () { loading = false; el('refresh').classList.remove('spinning'); });
  }

  function maybeHints() {
    // Pin hint once, only if not already installed to the home screen.
    if (!isStandalone) {
      try {
        if (!localStorage.getItem('clipEditorPinHintSeen')) show('pin-hint', true);
      } catch (e) {}
    }
    // iOS "save to Photos" hint once.
    if (isIOS) {
      try {
        if (!localStorage.getItem('clipEditorIosHintSeen')) show('ios-hint', true);
      } catch (e) {}
    }
  }

  // Wire dismiss + refresh + pull-to-refresh.
  el('pin-dismiss').addEventListener('click', function () { show('pin-hint', false); try { localStorage.setItem('clipEditorPinHintSeen', '1'); } catch (e) {} });
  el('ios-dismiss').addEventListener('click', function () { show('ios-hint', false); try { localStorage.setItem('clipEditorIosHintSeen', '1'); } catch (e) {} });
  el('refresh').addEventListener('click', load);

  // Lightweight pull-to-refresh: a downward drag from the top triggers a reload.
  var startY = null;
  window.addEventListener('touchstart', function (e) { startY = window.scrollY === 0 ? e.touches[0].clientY : null; }, { passive: true });
  window.addEventListener('touchmove', function (e) {
    if (startY == null) return;
    if (e.touches[0].clientY - startY > 70) { startY = null; load(); }
  }, { passive: true });

  window.addEventListener('pageshow', load);
  load();
})();
