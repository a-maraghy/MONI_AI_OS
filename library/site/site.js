/* MINT Library -- page behaviour: folder sort + search, copy buttons, the download menu.
   Plain JS, no requests. */
(function () {
  'use strict';
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  };

  /* ---------------- folder page: sort + search ---------------- */
  var grid = document.getElementById('grid');
  var sortSel = document.getElementById('sort');
  var q = document.getElementById('q');
  if (grid && sortSel && q) {
    var SORTS = {
      newest: function (a, b) { return cmp(b.dataset.date + b.dataset.added, a.dataset.date + a.dataset.added); },
      oldest: function (a, b) { return cmp(a.dataset.date + a.dataset.added, b.dataset.date + b.dataset.added); },
      title: function (a, b) { return a.dataset.title.localeCompare(b.dataset.title, 'en', { sensitivity: 'base', numeric: true }); },
      longest: function (a, b) { return parseFloat(b.dataset.dur) - parseFloat(a.dataset.dur); }
    };
    var cards = Array.prototype.slice.call(grid.children);
    var count = document.getElementById('count');
    var nomatch = document.getElementById('nomatch');
    var nomatchQ = document.getElementById('nomatch-q');
    var key = 'mintlib:sort';
    var params = new URLSearchParams(location.search);
    var s = params.get('sort');
    if (!SORTS[s]) s = store.get(key);
    if (!SORTS[s]) s = 'newest';
    sortSel.value = s;
    q.value = params.get('q') || '';

    function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
    function words(n) { return n + ' video' + (n === 1 ? '' : 's'); }
    function apply(push) {
      var mode = sortSel.value;
      var terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      cards.slice().sort(SORTS[mode]).forEach(function (c) { grid.appendChild(c); });
      var shown = 0;
      cards.forEach(function (c) {
        var ok = terms.every(function (t) { return c.dataset.text.indexOf(t) !== -1; });
        c.hidden = !ok;
        if (ok) shown++;
      });
      count.textContent = terms.length ? (shown + ' of ' + words(cards.length) + ' match') : words(cards.length);
      nomatch.hidden = shown !== 0;
      grid.hidden = shown === 0;
      if (nomatchQ) nomatchQ.textContent = '“' + q.value.trim() + '”';
      if (push) {
        var p = new URLSearchParams(location.search);
        if (mode === 'newest' && !p.has('sort')) { /* default: keep the URL clean */ } else { p.set('sort', mode); }
        if (terms.length) p.set('q', q.value.trim()); else p.delete('q');
        var qs = p.toString();
        history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
      }
    }
    sortSel.addEventListener('change', function () { store.set(key, sortSel.value); apply(true); });
    var t;
    q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { apply(true); }, 120); });
    q.addEventListener('keydown', function (e) { if (e.key === 'Escape' && q.value) { q.value = ''; apply(true); } });
    var clear = document.getElementById('clear-q');
    if (clear) clear.addEventListener('click', function () { q.value = ''; apply(true); q.focus(); });
    apply(false);
  }

  /* ---------------- copy buttons ---------------- */
  var status = document.getElementById('copy-status');
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); ok ? res() : rej(new Error('copy failed'));
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (btn) {
    var label = btn.querySelector('.btn-label');
    var orig = label.textContent;
    var timer;
    btn.addEventListener('click', function () {
      copyText(btn.getAttribute('data-copy')).then(function () {
        btn.classList.add('is-done'); label.textContent = btn.getAttribute('data-copy-label');
        if (status) { status.classList.remove('is-bad'); status.textContent = btn.getAttribute('data-copy-label') + '.'; }
      }, function () {
        if (status) { status.classList.add('is-bad'); status.textContent = 'Could not copy. Select it from the address bar instead.'; }
      });
      clearTimeout(timer);
      timer = setTimeout(function () { btn.classList.remove('is-done'); label.textContent = orig; if (status) status.textContent = ''; }, 2600);
    });
  });

  /* ---------------- menu button (download) ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll('[data-menu]'), function (wrap) {
    var btn = wrap.querySelector('[aria-haspopup]');
    var menu = wrap.querySelector('[role="menu"]');
    var items = function () { return Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]')); };
    function open(focusFirst) {
      menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
      if (focusFirst) items()[0].focus();
    }
    function close(refocus) {
      if (menu.hidden) return;
      menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus();
    }
    btn.addEventListener('click', function () { menu.hidden ? open(false) : close(false); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(true); }
    });
    menu.addEventListener('keydown', function (e) {
      var list = items(), i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') { close(false); }
    });
    menu.addEventListener('click', function () { setTimeout(function () { close(false); }, 0); });
    document.addEventListener('pointerdown', function (e) { if (!wrap.contains(e.target)) close(false); });
  });
})();
