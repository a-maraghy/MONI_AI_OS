"use strict";
/*
 * The Command Center's desktop render mode (/mint-ai?shell=desktop): the page
 * the MINT AI desktop app for Windows shows in its transparent window
 * (desktop/ in this repo; design: mockups/desktop-app/DESIGN.md).
 *
 * It is the same Command Center (moni-ai.js, the core, the spheres, the
 * composer, the decision card, the live call) with no page around it. This
 * file only:
 *   - lays the pieces out for the app's mode (Floating, Peek, Desktop layer;
 *     public/mint-desktop-layout.js holds the numbers), size, position and
 *     focus mode, and keeps the last exchanges as bubbles under the core;
 *   - tells the app which parts of the window catch the mouse, so the rest
 *     lets clicks through to the desktop (set_hit_regions, ~10 a second while
 *     anything moves, only when the list changed);
 *   - passes the app's hotkeys in (hold-to-talk, focus, Esc) and the core's
 *     state out (the tray dot, a Windows toast when something needs you and
 *     the layer cannot be seen -- the app decides; a toast only opens or
 *     denies, never approves);
 *   - on the sign-in pages, makes the card float on the desktop and offers
 *     "sign in in your browser" (the app's one-time-code hand-off).
 *
 * The bridge to the app is Tauri's (window.__TAURI__, injected by the app
 * only into os.mint-stack.com): a fixed list of commands, none of which can
 * run a program or read a file (desktop/src-tauri/capabilities/remote.json).
 * In a plain browser there is no bridge: the page reads its mode from the
 * address (?mode=floating&focus=1&size=M&ink=light) so it can be looked at
 * and tested, and does nothing else.
 *
 * No inline style or script (the CSP): positions go through element.style.
 */
(function () {
  var html = document.documentElement;
  if (!html.classList.contains("cc-desk")) return;
  var LAY = window.MintDesktopLayout;
  var T = window.__TAURI__ || null;
  function invoke(cmd, args) {
    if (!T || !T.core || !T.core.invoke) return Promise.resolve(null);
    try { return T.core.invoke(cmd, args || {}).catch(function () { return null; }); } catch (e) { return Promise.resolve(null); }
  }
  function listen(name, fn) {
    if (!T || !T.event || !T.event.listen) return;
    try { T.event.listen(name, function (e) { try { fn(e.payload || {}); } catch (x) { /* one bad event never stops the page */ } }); } catch (e) { /* no events */ }
  }
  function $(id) { return document.getElementById(id); }
  function px(n) { return Math.round(n) + "px"; }

  var Q;
  try { Q = new URLSearchParams(location.search); } catch (e) { Q = { get: function () { return null; } }; }
  var st = {
    mode: Q.get("mode") || "floating", focus: Q.get("focus") === "1", size: Q.get("size") || "M", pos: Q.get("pos") || "",
    ink: Q.get("ink") === "dark" ? "dark" : "light", opacity: 100, still: Q.get("still") === "1", peekOpen: Q.get("open") !== "0",
    talkKey: Q.get("talk") || "Ctrl+Space", hidden: false, host: !!T,
  };
  html.classList.toggle("dk-host", !!T);

  /* ---------------------------------------------------------------- applying the app's state */
  function apply() {
    html.setAttribute("data-dk-mode", st.mode);
    html.classList.toggle("dk-focus", !!st.focus);
    html.classList.toggle("dk-peek-open", st.mode === "peek" && !!st.peekOpen);
    html.classList.toggle("dk-still", !!st.still);
    // Ink follows the wallpaper: light ink (the dark theme) on a dark or busy wallpaper, dark ink on a light one.
    html.setAttribute("data-theme", st.ink === "dark" ? "light" : "dark");
    try { document.dispatchEvent(new CustomEvent("moni-theme")); } catch (e) { /* old engine */ }
    var cc = $("cc") || document.body;
    cc.style.opacity = String(Math.max(0.35, Math.min(1, (Number(st.opacity) || 100) / 100)));
    var kb = $("dk-kb");
    if (kb) kb.innerHTML = "hold " + String(st.talkKey).split("+").map(function (k) { return "<b>" + esc(k) + "</b>"; }).join("") + " to talk";
    // Focus mode: the core alone -- the session spheres (drawn by the core) go too.
    var cc2 = window.__mintCC, fam = cc2 && cc2.orbit && cc2.orbit.family, root = $("cc");
    if (fam && fam.enable && root) fam.enable(!st.focus && root.getAttribute("data-sessview") !== "orbit");
    layout();
    still();
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var L = null;
  function layout() {
    L = LAY.layout({ mode: st.mode, size: st.size, pos: st.pos, focus: st.focus, W: window.innerWidth, H: window.innerHeight });
    if (!$("cc")) { layoutAuth(); return report(true); }
    var dock = $("cc-dock"), cap = $("cc-caption"), chat = $("dk-chat"), need = $("cc-need"), tools = $("dk-tools"), core = $("dk-corehit");
    place(dock, L.composer.x, L.composer.y, L.composer.w);
    if (chat) {
      chat.style.left = px(L.chat.x); chat.style.width = px(L.chat.w);
      chat.style.top = "auto"; chat.style.bottom = px(L.H - (L.chat.y + L.chat.h));
      chat.style.maxHeight = px(Math.max(0, L.chat.h));
    }
    if (cap) { cap.style.left = px(L.caption.x); cap.style.top = px(L.caption.y); }
    if (need) {
      need.style.left = px(L.card.x); need.style.width = px(L.card.w);
      if (L.card.bottom != null) { need.style.top = "auto"; need.style.bottom = px(L.card.bottom); need.style.maxHeight = px(L.card.h); }
      else { need.style.bottom = "auto"; need.style.top = px(L.card.y); need.style.maxHeight = px(L.card.h); }
    }
    if (tools) { tools.hidden = !L.tools; if (L.tools) place(tools, L.tools.x, L.tools.y); }
    if (core) place(core, L.cx - L.R, L.cy - L.R, 2 * L.R, 2 * L.R);
    // "Not reachable": under the core, where the sign-in card goes, not over it.
    var off = $("cc-offline");
    if (off) { off.style.left = px(L.gate.x); off.style.top = px(L.gate.y); off.style.transform = "translateX(-50%)"; }
    // Floating: the core's glow is clipped to the box with round corners (the mockup's clip), never the window's square.
    var clip = L.mode === "floating" ? "inset(" + px(L.box.y) + " " + px(L.W - L.box.x - L.box.w) + " " + px(L.H - L.box.y - L.box.h) + " " + px(L.box.x) + " round 28px)" : "none";
    ["cc-core", "cc-family"].forEach(function (id) { var c = $(id); if (c) c.style.clipPath = clip; });
    var cc = window.__mintCC;
    if (cc && cc.orbit && cc.orbit.resize) cc.orbit.resize();
    renderChat();
    report(true);
  }
  function place(el, x, y, w, h) {
    if (!el) return;
    el.style.left = px(x); el.style.top = px(y);
    if (w != null) el.style.width = px(w);
    if (h != null) el.style.height = px(h);
  }
  /**
   * The sign-in pages: the core grey and still (signed out), the card under it, where the
   * mode's gate goes; a tall card pushes the core up rather than off the window.
   */
  var authCore = null;
  function layoutAuth() {
    var card = document.querySelector(".auth-wrap .card");
    if (!card) return;
    var w = Math.min(360, L.W - 24);
    card.style.width = px(w);
    var ch = card.offsetHeight, R = st.focus ? L.R : Math.min(L.R, 120);
    var y = L.mode === "floating" ? Math.max(8, L.H - ch - 16) : Math.max(16, Math.min(L.gate.y, L.H - ch - 16));
    var x = L.mode === "floating" ? (L.W - w) / 2 : L.cx - w / 2;
    place(card, Math.max(12, Math.min(L.W - w - 12, x)), y);
    var cy = Math.min(L.cy, y - R - 24), cx = L.mode === "floating" ? L.W / 2 : L.cx;
    if (cy - R < 0 || !window.MintCoreD) { if (authCore) authCore.cv.hidden = true; return; }
    if (!authCore) {
      var cv = document.createElement("canvas");
      cv.className = "dk-auth-core";
      cv.setAttribute("aria-hidden", "true");
      document.body.appendChild(cv);
      try { authCore = { cv: cv, core: window.MintCoreD(cv, { backdrop: "glow" }) }; } catch (e) { authCore = { cv: cv, core: null }; }
    }
    authCore.cv.hidden = false;
    var k = authCore.core;
    if (!k) return;
    k.resize(cx, cy, R, L.W, L.H);
    if (k.setLight) k.setLight(st.ink === "dark");
    if (k.S && k.S.running) k.stop();
    if (k.still) k.still(); else if (k.draw) k.draw();
  }

  /** Where the core is, for cc-map.js (it asks through moni-ai.js). */
  window.MintDesktop = {
    coreLayout: function () { return L ? { cx: L.cx, cy: L.cy, R: L.R } : null; },
    state: function () { return st; },
    layout: function () { return L; },
    regions: function () { return lastRegions; },
  };

  /* ---------------------------------------------------------------- chat bubbles
     The last exchanges (three; two in Floating) under the core, from the
     Command Center's own turns. Older ones fade. The words of a live call
     appear as a ghost bubble while they are said. */
  var ghost = null;
  function turns() { var cc = window.__mintCC; return cc && cc.recent ? cc.recent(L ? L.keep : 3) : []; }
  function renderChat() {
    var box = $("dk-chat");
    if (!box || !L) return;
    var list = turns(), keepEx = L.keep, out = [];
    list.forEach(function (x) { if (x.me) out.push({ who: "me", text: x.me, id: "m" + x.id }); if (x.ai) out.push({ who: "ai", text: x.ai, id: "a" + x.id }); });
    out = out.slice(-keepEx * 2);
    var sig = out.map(function (b) { return b.id + ":" + b.text.length; }).join("|") + "|" + (ghost ? ghost.text : "");
    if (sig === renderChat.sig) return;
    renderChat.sig = sig;
    var h = "";
    out.forEach(function (b, i) {
      h += '<div class="dk-bub ' + b.who + '"><b>' + (b.who === "ai" ? "MINT AI" : "You") + "</b><span>" + esc(clip(b.text, 420)) + "</span></div>";
    });
    if (ghost && ghost.text) h += '<div class="dk-bub me ghost"><b>You</b><span>' + esc(clip(ghost.text, 300)) + "…</span></div>";
    box.innerHTML = h;
    // What does not fit goes, oldest first (measured by the bubbles' own heights: their entry
    // animation moves them, and an overflow measure would count that).
    var max = parseFloat(box.style.maxHeight) || 1e9;
    var used = function () { var h = 0; for (var i = 0; i < box.children.length; i++) h += box.children[i].offsetHeight + 8; return h - 8; };
    var guard = 0;
    while (used() > max && box.children.length > 1 && guard++ < 8) box.removeChild(box.firstElementChild);
    var all = box.querySelectorAll(".dk-bub:not(.ghost)");
    for (var j = 0; j < all.length; j++) all[j].classList.toggle("old", all.length > 2 && j < all.length - 2);
  }
  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  document.addEventListener("mint-turns", renderChat);
  document.addEventListener("mint-live-caption", function (e) {
    var d = (e && e.detail) || {};
    ghost = d.who === "you" && d.text && !d.final ? { text: d.text } : null;
    renderChat();
  });

  /* ---------------------------------------------------------------- click-through: what catches the mouse */
  var HIT = [
    "#cc-compose", "#cc-voicebar", "#cc-cap-state", "#cc-cap-more", "#dk-chat .dk-bub", "#cc-need", "#dk-tools", "#cc-kids > *",
    "#cc-reply", "#cc-pop", ".cc-smenu", ".cc-toast", ".dk-auth .auth-wrap .card", "#dk-gate", "#cc-offline", "#cc-needpill",
  ];
  // Open over everything: the whole window catches the mouse while one shows.
  var FULL = [".cc-sdlg-back", ".cc-modal:not([hidden])", "#cc-sheet.open", ".cc-palette:not([hidden])", "#md-frame:not([hidden])"];
  function shown(el) {
    if (!el || el.hidden) return false;
    var r = el.getClientRects();
    if (!r.length) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  }
  function measure() {
    if (!L) return [];
    var full = st.mode === "peek" && st.peekOpen;
    if (!full) for (var f = 0; f < FULL.length; f++) { var fe = document.querySelectorAll(FULL[f]); for (var j = 0; j < fe.length; j++) if (shown(fe[j])) { full = true; break; } if (full) break; }
    if (full) return LAY.regions(L, [], { all: true });
    var els = [];
    for (var i = 0; i < HIT.length; i++) {
      var list = document.querySelectorAll(HIT[i]);
      for (var k = 0; k < list.length; k++) {
        if (!shown(list[k])) continue;
        var r = list[k].getBoundingClientRect();
        var rad = parseFloat(getComputedStyle(list[k]).borderTopLeftRadius) || 0;
        els.push({ left: r.left, top: r.top, width: r.width, height: r.height, r: Math.min(rad, r.height / 2, r.width / 2) });
      }
    }
    // The session spheres the core draws (no DOM of their own): a circle each.
    var cc = window.__mintCC, fam = cc && cc.orbit && cc.orbit.family;
    if (fam && fam.enabled && fam.enabled() && !st.focus) {
      var mk = fam.meshKids ? fam.meshKids() : null;
      (mk || []).forEach(function (q) { if (q && q.r > 2 && (q.form == null || q.form > 0.3)) els.push({ left: q.x - q.r, top: q.y - q.r, width: 2 * q.r, height: 2 * q.r, r: q.r }); });
    }
    // The core is a circle that catches the mouse; the sign-in pages have no core.
    return LAY.regions($("cc") ? L : { W: L.W, H: L.H, R: 0 }, els);
  }
  var lastRegions = [], lastSig = "", lastSent = 0;
  function report(force) {
    var regs = measure();
    var sig = JSON.stringify(regs);
    if (!force && sig === lastSig) return;
    var now = Date.now();
    lastRegions = regs;
    lastSig = sig;
    lastSent = now;
    invoke("set_hit_regions", { regions: regs, dpr: window.devicePixelRatio || 1 });
  }
  setInterval(function () { report(false); }, 100);
  window.addEventListener("resize", function () { apply(); });

  /* ---------------------------------------------------------------- the core's state, out to the tray */
  var lastStatus = "";
  function status() {
    var cc = $("cc");
    var stt = cc ? cc.getAttribute("data-state") || "idle" : "signedout";
    var off = $("cc-offline");
    if (off && !off.hidden) stt = "offline";
    var needs = 0, n = $("cc-needn");
    if (n) needs = Number(n.textContent) || 0;
    var S = window.__mintCC && window.__mintCC.S;
    var sessions = S && S.sessions ? S.sessions.filter(function (s) { return !s.self; }).length : 0;
    var sig = stt + "|" + needs + "|" + sessions;
    if (sig === lastStatus) return;
    lastStatus = sig;
    invoke("set_status", { state: stt, needs: needs, sessions: sessions });
  }
  setInterval(status, 500);

  /* ---------------------------------------------------------------- needs you: the toast (the app decides when) */
  var toasted = {};
  function needsYou() {
    var cc = window.__mintCC, S = cc && cc.S;
    if (!S || !S.approvals) return;
    S.approvals.forEach(function (a) {
      if (a.status !== "pending" || toasted[a.id]) return;
      toasted[a.id] = 1;
      var who = String(a.origin || "").replace(/^session:/, "") || "MINT AI";
      invoke("needs_you", { id: a.id, title: (who === "MINT AI" ? "MINT AI" : who) + " needs you", body: clip(String(a.summary || "A step waits for your approval."), 180) + " Nothing runs until you choose." });
    });
  }
  document.addEventListener("mint-needs", needsYou);
  setInterval(needsYou, 2000);
  // The toast's Deny: the same call the card's Deny makes. (Open just shows the layer: the app does that.)
  listen("mint://toast-deny", function (p) {
    var cc = window.__mintCC;
    if (cc && cc.decide && p && p.id) cc.decide(Number(p.id), "deny");
  });

  /* ---------------------------------------------------------------- the app's hotkeys and state, in */
  listen("mint://state", function (p) {
    var was = JSON.stringify(st);
    ["mode", "focus", "size", "pos", "ink", "opacity", "still", "peekOpen", "talkKey", "hidden"].forEach(function (k) { if (p[k] !== undefined) st[k] = p[k]; });
    if (JSON.stringify(st) !== was) apply();
    if (p.focusComposer) setTimeout(function () { var i = $("cc-input"); if (i) i.focus(); }, 120);
  });
  listen("mint://ptt", function (p) {
    var lv = window.__mintLive;
    if (lv && lv.ptt) lv.ptt(!!p.down);
  });
  listen("mint://escape", function () { escape(); });
  // The tray's Talk: a hands-free live call, as a tap of the mic starts.
  listen("mint://talk", function () { var lv = window.__mintLive; if (lv && lv.toggle && !(lv.active && lv.active())) lv.toggle(); });
  // The tray's Sign out: this device's session ends (its call too), as the avatar menu's sign-out does.
  listen("mint://signout", function () { var f = document.querySelector("form.me-logout"); if (f) f.submit(); });
  // Quit: hang up first, so the server logs why.
  listen("mint://quit", function () { var lv = window.__mintLive; if (lv && lv.active && lv.active()) lv.end("unload"); });
  function escape() {
    var lv = window.__mintLive;
    if (lv && lv.active && lv.active()) { lv.end("esc"); return; }
    if (st.mode === "peek") invoke("hide_peek");
  }
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".cc-sdlg-back, .cc-modal:not([hidden]), #cc-pop:not([hidden])")) escape();
  });
  // Peek: a click on empty space sends it away (the whole window catches clicks while it shows).
  document.addEventListener("pointerdown", function (e) {
    if (st.mode !== "peek" || !st.peekOpen) return;
    var t = e.target;
    if (t === document.body || t === html || t.id === "cc" || t.classList.contains("cc-main") || t.id === "cc-stage" || t.id === "cc-family" || t.tagName === "CANVAS") {
      if (!(L && Math.hypot(e.clientX - L.cx, e.clientY - L.cy) < L.R)) invoke("hide_peek");
    }
  });

  /* ---------------------------------------------------------------- the core: drag (Floating), focus the composer (others) */
  var ch = $("dk-corehit");
  if (ch) {
    ch.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (st.mode === "floating") { e.preventDefault(); invoke("start_drag"); return; }
      var i = $("cc-input"); if (i) i.focus();
    });
  }
  var tl = $("dk-tools");
  if (tl) tl.addEventListener("click", function (e) {
    var b = e.target.closest("[data-dk]");
    if (!b) return;
    var v = b.getAttribute("data-dk");
    if (v === "drag") return;
    invoke("tool", { name: v });
  });
  if (tl) tl.addEventListener("pointerdown", function (e) { var b = e.target.closest("[data-dk=drag]"); if (b && e.button === 0) { e.preventDefault(); invoke("start_drag"); } });
  var full = $("dk-open-full");
  if (full) full.addEventListener("click", function (e) { e.preventDefault(); invoke("open_full_cc"); });

  /* ---------------------------------------------------------------- battery saver: a still core */
  function still() {
    var cc = window.__mintCC, core = cc && cc.core;
    if (!core) return;
    if (st.still || st.hidden) { if (core.S && core.S.running) core.stop(); if (core.still) core.still(); else if (core.draw) core.draw(); }
    else if (core.S && !core.S.running && core.start) core.start();
  }

  /* ---------------------------------------------------------------- sign-in: the browser hand-off */
  var bs = $("dk-browser-signin");
  if (bs) {
    if (!T) bs.hidden = true;
    bs.addEventListener("click", function (e) {
      e.preventDefault();
      bs.disabled = true;
      var note = $("dk-browser-note");
      if (note) note.textContent = "Sign in in the browser window that opened. This card comes back signed in.";
      invoke("browser_signin").then(function (r) {
        bs.disabled = false;
        if (r && r.error && note) note.textContent = r.error;
      });
    });
  }

  /* ---------------------------------------------------------------- boot */
  apply(); // from the address (or the defaults) at once; the app's own state follows
  function boot() {
    invoke("get_state").then(function (p) {
      if (p) ["mode", "focus", "size", "pos", "ink", "opacity", "still", "peekOpen", "talkKey", "hidden"].forEach(function (k) { if (p[k] !== undefined) st[k] = p[k]; });
      apply();
      invoke("page_ready", { signedIn: !!$("cc") });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { layout(); });
})();
