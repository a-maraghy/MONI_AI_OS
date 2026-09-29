"use strict";
/*
 * The Command Center as a shell (M-5 part 2). Another Mint OS page opens in a
 * same-origin frame over the Command Center instead of replacing it, so what
 * lives here goes on while you look at the other page: the live call, the
 * event stream, the voice. MINT AI's core flies down into the dock and back up
 * when you return (from the approved mockup, scratchpad mint-dock).
 *
 *   MintShell.open(url)   show that page (a path of this site) -- page.open, or
 *                         a link clicked in the Command Center
 *   MintShell.expand()    back to the Command Center
 *   MintShell.back()      the browser's back (Undo of a page.open)
 *   MintShell.active()    a page is up (or on its way up)
 *   MintShell.feed(f)     moni-ai.js: what the Command Center is doing, for the dock
 *   MintShell.toast(...)  a note on the dock while a page is up
 *
 * History: each switch is an entry (/mint-ai?at=<path> for a page, /mint-ai
 * for the Command Center), so back and forward move between them; moves inside
 * the frame are the browser's own entries, and the address follows them. A
 * link to /mint-ai?at=<path> opens straight onto that page (a deep link).
 *
 * The page in the frame talks back through app.js (only when framed): where it
 * is and its title, Space held to talk, theme changes; a signed-out page,
 * logout and the Command Center itself leave the frame. Messages are accepted
 * only from this origin and from the frame's own window.
 *
 * Nothing here changes how the Command Center looks while it is the one shown:
 * every class and inline style set for a flight is removed when it lands.
 */
(function () {
  var root = document.getElementById("mint-dock-root");
  var frame = document.getElementById("md-frame");
  var hero = document.getElementById("md-hero");
  if (!root || !frame || !hero || root.getAttribute("data-shell") !== "1") return;
  var html = document.documentElement;
  var cc = document.getElementById("cc");
  var dockEl = document.getElementById("md-dock");
  var ORIGIN = location.origin;
  var reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var D = function () { return window.__mintDock || null; };
  var CCx = function () { return window.__mintCC || null; };
  var baseTitle = document.title;
  var mode = "full"; // full | down | dock | up
  var fl = null, raf = 0, last = 0;

  /* ------------------------------------------------------------ where */
  function isCC(path) { return path === "/mint-ai" || path === "/mint-ai/"; }
  /** A path of this site that may be shown in the frame, normalised; null otherwise. */
  function safePath(u) {
    var x;
    try { x = new URL(String(u || ""), ORIGIN); } catch (e) { return null; }
    if (x.origin !== ORIGIN || !/^\/(?!\/)/.test(x.pathname)) return null;
    if (isCC(x.pathname) || /^\/(logout|login|mint-ai\/api)(\/|$)/.test(x.pathname)) return null;
    return x.pathname + x.search + x.hash;
  }
  function frameUrl() {
    try {
      var l = frame.contentWindow.location;
      return l.href === "about:blank" ? null : l.pathname + l.search + l.hash;
    } catch (e) { return null; }
  }
  function ccUrl(p) { return "/mint-ai?at=" + encodeURIComponent(p); }

  /* ------------------------------------------------------------ the Command Center under the frame */
  // Out of reach of the keyboard and screen readers while a page is up (no visual change).
  function setInert(on) {
    (function walk(parent) {
      [].forEach.call(parent.children, function (el) {
        if (el === root || el.tagName === "SCRIPT") return;
        if (el.contains(root)) return walk(el);
        if (on) { if (!el.hasAttribute("inert")) { el.setAttribute("inert", ""); el.setAttribute("data-md-inert", ""); } }
        else if (el.hasAttribute("data-md-inert")) { el.removeAttribute("inert"); el.removeAttribute("data-md-inert"); }
      });
    })(document.body);
  }
  function coreStop() { var c = CCx(); if (c && c.core && c.core.stop) c.core.stop(); }
  function coreStart() { var c = CCx(); if (!c) return; if (c.orbit && c.orbit.resize) c.orbit.resize(); if (c.core && c.core.start) c.core.start(); }
  function coreLayout() {
    var c = CCx(), L = c && c.orbit && c.orbit.layout;
    if (L && L.R) return { cx: L.cx, cy: L.cy, R: L.R };
    return { cx: innerWidth / 2, cy: innerHeight / 2, R: Math.min(innerWidth, innerHeight) * 0.3 };
  }

  /* ------------------------------------------------------------ the dotted core in flight (2D, concept C) */
  var PI = Math.PI, t = 0, DPR = 1, VW = 0, VH = 0, g = hero.getContext("2d");
  function points(n, seed) {
    var dir = new Float32Array(n * 3), rnd = new Float32Array(n), ga = PI * (3 - Math.sqrt(5)), sd = seed;
    function r_() { sd = (sd * 16807) % 2147483647; return sd / 2147483647; }
    for (var i = 0; i < n; i++) {
      var y = 1 - (i + 0.5) / n * 2, rad = Math.sqrt(1 - y * y), th = ga * i;
      dir[i * 3] = Math.cos(th) * rad; dir[i * 3 + 1] = y; dir[i * 3 + 2] = Math.sin(th) * rad; rnd[i] = r_();
    }
    return { dir: dir, rnd: rnd, n: n };
  }
  var PBIG = points(2600, 7), PMID = points(900, 7), PSMALL = points(420, 7);
  function isLight() {
    var th = html.getAttribute("data-theme");
    if (th) return th === "light";
    return !(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function mix(a, b, k) { return a + (b - a) * k; }
  function mix3(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
  function rgb(c) { return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")"; }
  function rgba(c, a) { return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + a.toFixed(3) + ")"; }
  function ease(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function drawCore(P, cx, cy, R, size, alpha) {
    var light = isLight(), M = light ? [0, 143, 102] : [0, 230, 165], V = light ? [115, 33, 196] : [153, 77, 255];
    var rot = t * 0.18, cr = Math.cos(rot), sr = Math.sin(rot), base = light ? 0.16 : 0.07;
    for (var i = 0; i < P.n; i++) {
      var dx = P.dir[i * 3], dy = P.dir[i * 3 + 1], dz = P.dir[i * 3 + 2], r1 = P.rnd[i];
      var r = 1 + 0.022 * Math.sin(t * 1.05) + 0.03 * Math.sin(Math.acos(dy) * 5 + t * 0.7);
      var X = (cr * dx + sr * dz) * r, Y = dy * r, Z = (-sr * dx + cr * dz) * r;
      var Y2 = Y * 0.955 - Z * 0.296, Z2 = Y * 0.296 + Z * 0.955, persp = 3.3 / (3.3 - Z2);
      var depth = clamp((Z2 + 1.25) / 2.5, 0, 1), gc = clamp(0.5 + 0.62 * (X * 0.6 + Y2 * 0.6), 0, 1);
      g.globalAlpha = Math.min(1, (base + (1 - base) * Math.pow(depth, 1.4)) * alpha);
      g.fillStyle = rgb(mix3(M, V, gc));
      var sz = size * (0.6 + 1.2 * depth * depth) * persp * (r1 > 0.975 ? 1.7 : 1);
      g.fillRect(cx + X * R * persp - sz / 2, cy - Y2 * R * persp - sz / 2, sz, sz);
    }
    g.globalAlpha = 1;
    var hg = g.createRadialGradient(cx, cy, R * 0.15, cx, cy, R * 1.5);
    hg.addColorStop(0, rgba(M, (light ? 0.08 : 0.13) * alpha)); hg.addColorStop(1, rgba(V, 0));
    g.fillStyle = hg; g.fillRect(cx - R * 1.6, cy - R * 1.6, R * 3.2, R * 3.2);
  }
  function heroSize() {
    DPR = Math.min(2, window.devicePixelRatio || 1); VW = innerWidth; VH = innerHeight;
    hero.width = Math.round(VW * DPR); hero.height = Math.round(VH * DPR);
  }
  function pose() {
    var p = ease(fl.p), a = fl.from, b = fl.to;
    return {
      cx: mix(a.cx, b.cx, p),
      cy: mix(a.cy, b.cy, p) - Math.sin(p * PI) * (fl.dir === "down" ? 40 : -30),
      R: Math.exp(mix(Math.log(a.R), Math.log(b.R), p)),
    };
  }

  /* ------------------------------------------------------------ the flights */
  function setOp(el, o) { if (el) el.style.opacity = o === "" ? "" : String(o); }
  function step(now) {
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    t += dt;
    if (!fl) { raf = 0; return; }
    fl.p = Math.min(1, fl.p + dt / fl.dur);
    var p = fl.p;
    if (fl.dir === "down") {
      setOp(cc, 1 - clamp(p / 0.38, 0, 1));
      setOp(frame, clamp((p - 0.4) / 0.42, 0, 1));
      setOp(dockEl, clamp((p - 0.7) / 0.3, 0, 1));
    } else {
      setOp(frame, 1 - clamp(p / 0.33, 0, 1));
      setOp(dockEl, 1 - clamp(p / 0.25, 0, 1));
      if (p > 0.35 && !frame.hidden) frame.hidden = true;
      setOp(cc, clamp((p - 0.55) / 0.4, 0, 1));
      if (p > 0.9 && html.classList.contains("md-flying")) html.classList.remove("md-flying"); // the real core takes over
    }
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, VW, VH);
    var q = pose(), fade = fl.dir === "up" ? 1 - clamp((p - 0.9) / 0.1, 0, 1) : 1;
    drawCore(q.R > 90 ? PBIG : q.R > 40 ? PMID : PSMALL, q.cx, q.cy, q.R, q.R > 90 ? 1.5 : 1.15, fade);
    if (p >= 1) return land();
    raf = requestAnimationFrame(step);
  }
  function fly(dir) {
    heroSize();
    fl = { dir: dir, p: 0, dur: dir === "down" ? 1.05 : 1.0 };
    if (dir === "down") { fl.from = coreLayout(); fl.to = D().orbRect(); }
    else { fl.from = D().orbRect(); coreStart(); fl.to = coreLayout(); }
    html.classList.add("md-flying");
    hero.classList.add("on");
    last = 0;
    if (!raf) raf = requestAnimationFrame(step);
  }
  function land() {
    var dir = fl ? fl.dir : mode === "down" ? "down" : "up";
    fl = null;
    raf = 0;
    hero.classList.remove("on");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, hero.width, hero.height);
    html.classList.remove("md-flying");
    setOp(cc, ""); setOp(frame, ""); setOp(dockEl, "");
    if (dir === "down") {
      mode = "dock";
      frame.hidden = false;
      setInert(true);
      coreStop();
      document.title = frameTitle() || baseTitle;
      if (!root.contains(document.activeElement)) { try { frame.focus(); } catch (e) { /* fine */ } }
    } else {
      mode = "full";
      frame.hidden = true;
      D().show(false);
      document.title = baseTitle;
    }
    paintFeed();
  }
  /** Finish a flight at once (a new switch arrives while one is under way). */
  function finish() { if (fl) { fl.p = 1; step(performance.now()); } }

  /* ------------------------------------------------------------ open / expand */
  function loadFrame(p) {
    var cur = frameUrl();
    if (cur === p) return;
    if (!frame.getAttribute("src") || !cur) frame.setAttribute("src", p); // the first load replaces about:blank
    else frame.contentWindow.location.replace(p); // no extra history entry: the shell writes its own
  }
  function open(url, o) {
    o = o || {};
    var p = safePath(url);
    if (!p) return false;
    finish();
    if (mode === "dock") {
      // A page is up already: move the frame, as a normal step in its history.
      if (frameUrl() !== p) { try { frame.contentWindow.location.assign(p); } catch (e) { loadFrame(p); } }
      return true;
    }
    loadFrame(p);
    if (o.push !== false) history.pushState({ mint: "frame", url: p }, "", ccUrl(p));
    mode = "down";
    D().show(true);
    if (reduced || o.instant) { frame.hidden = false; land(); return true; }
    setOp(frame, 0);
    setOp(dockEl, 0);
    frame.hidden = false;
    fly("down");
    return true;
  }
  function expand(o) {
    o = o || {};
    finish();
    if (mode !== "dock") return false;
    if (o.push !== false) history.pushState({ mint: "cc" }, "", "/mint-ai");
    mode = "up";
    setInert(false);
    if (reduced || o.instant) { coreStart(); land(); return true; }
    setOp(cc, 0);
    fly("up");
    return true;
  }

  /* ------------------------------------------------------------ history */
  window.addEventListener("popstate", function (e) {
    var s = e.state;
    if (s && s.mint === "frame" && safePath(s.url)) {
      if (mode === "dock" || mode === "down") { if (frameUrl() !== s.url) loadFrame(s.url); return; }
      open(s.url, { push: false });
    } else if (mode === "dock" || mode === "down") expand({ push: false });
  });

  /* ------------------------------------------------------------ the frame's page */
  function frameTitle() { try { return frame.contentDocument.title || ""; } catch (e) { return ""; } }
  function followFrame() {
    var p = frameUrl();
    if (!p) return;
    try {
      if (isCC(frame.contentWindow.location.pathname)) { // the Command Center inside itself: come back instead
        frame.contentWindow.location.replace("about:blank");
        frame.removeAttribute("src");
        return void expand();
      }
    } catch (e) { return; }
    if (mode === "dock" || mode === "down") {
      history.replaceState({ mint: "frame", url: p }, "", ccUrl(p));
      if (mode === "dock") document.title = frameTitle() || baseTitle;
    }
    sendTheme();
  }
  frame.addEventListener("load", followFrame);
  function applyTheme(pref) {
    if (["system", "dark", "light"].indexOf(pref) < 0) return;
    var now = html.getAttribute("data-theme") || "system";
    if (now === pref) return;
    var b = document.querySelector('[data-theme-switch] button[data-theme-opt="' + pref + '"]');
    if (b) b.click();
    else {
      if (pref === "system") html.removeAttribute("data-theme"); else html.setAttribute("data-theme", pref);
      try { window.localStorage.setItem("moni-theme", pref); } catch (e) { /* storage blocked */ }
      document.dispatchEvent(new CustomEvent("moni-theme", { detail: { theme: pref } }));
    }
  }
  function sendTheme() {
    try { frame.contentWindow.postMessage({ mint: "theme", theme: html.getAttribute("data-theme") || "system" }, ORIGIN); } catch (e) { /* not loaded */ }
  }
  document.addEventListener("moni-theme", sendTheme);
  function space(type) { document.dispatchEvent(new KeyboardEvent(type, { code: "Space", key: " ", bubbles: true, cancelable: true })); }
  var spaceDown = false;
  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN || e.source !== frame.contentWindow) return;
    var m = e.data && typeof e.data === "object" ? e.data : {};
    if (m.mint === "nav") followFrame();
    else if (m.mint === "space") {
      if (mode !== "dock") return;
      if (m.down && !spaceDown) { spaceDown = true; space("keydown"); }
      else if (!m.down && spaceDown) { spaceDown = false; space("keyup"); }
    } else if (m.mint === "expand") expand();
    else if (m.mint === "theme") applyTheme(m.theme);
  });

  /* ------------------------------------------------------------ links in the Command Center open in the frame */
  document.addEventListener("click", function (e) {
    if (mode !== "full" || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest("a[href]");
    if (!a || root.contains(a) || a.target === "_blank" || a.hasAttribute("download")) return;
    var href = a.getAttribute("href");
    if (!href || href.charAt(0) === "#") return;
    var p = safePath(a.href);
    if (!p) return;
    e.preventDefault();
    open(p);
  });

  /* ------------------------------------------------------------ the dock's feed and notes */
  var lastFeed = null;
  function paintFeed() { if (lastFeed && D() && D().feed) D().feed(lastFeed); }
  function toast(text, undo, link, bad) {
    var d = D();
    if (!d) return;
    var action = undo ? { label: "Undo", fn: undo } : link ? { label: "Open", fn: function () { open(link) || location.assign(link); } } : null;
    d.toast(text, { action: action, bad: !!bad });
  }

  window.MintShell = {
    open: open,
    expand: function () { return expand(); },
    back: function () { history.back(); },
    active: function () { return mode === "dock" || mode === "down"; },
    framed: function () { return mode === "dock"; },
    mode: function () { return mode; },
    feed: function (f) { lastFeed = f; if (D() && D().feed) D().feed(f); },
    toast: toast,
    finish: finish,
  };

  /* ------------------------------------------------------------ boot: a deep link, and this entry's state */
  var at = null;
  try { at = new URLSearchParams(location.search).get("at"); } catch (e) { at = null; }
  var deep = at ? safePath(at) : null;
  if (deep) {
    history.replaceState({ mint: "cc" }, "", "/mint-ai" + (location.hash || "")); // back from the page lands here
    open(deep, { instant: true });
  } else history.replaceState({ mint: "cc" }, "", location.pathname + location.search + location.hash);
})();
