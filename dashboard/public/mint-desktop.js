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
 *     focus mode. Nothing of the conversation shows by itself (0.1.2): a small
 *     chat button on the core opens the chat panel -- the recent conversation
 *     with the composer (moved in from the page) -- and a reply that comes
 *     while it is closed only lights a dot on the button;
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
    talkKey: Q.get("talk") || "Ctrl+Space", liveKey: T ? "" : Q.get("livekey") || "Ctrl+Alt+L", hidden: false, host: !!T,
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
    if (kb) {
      var keys = String(st.talkKey).split("+");
      kb.innerHTML = '<span class="dk-kb-w">hold </span>' + keys.map(function (k) { return "<b>" + esc(k) + "</b>"; }).join("") + '<span class="dk-kb-w"> to talk</span>';
      kb.title = "Hold " + keys.join("+") + " to talk";
    }
    // Focus mode: the core alone -- the session spheres (drawn by the core) go too.
    var cc2 = window.__mintCC, fam = cc2 && cc2.orbit && cc2.orbit.family, root = $("cc");
    if (fam && fam.enable && root) fam.enable(!st.focus && root.getAttribute("data-sessview") !== "orbit");
    layout();
    still();
    fitHint();
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var L = null;
  function layout() {
    L = LAY.layout({ mode: st.mode, size: st.size, pos: st.pos, focus: st.focus, W: window.innerWidth, H: window.innerHeight });
    if (!$("cc")) { layoutAuth(); return report(true); }
    var cap = $("cc-caption"), need = $("cc-need"), tools = $("dk-tools"), core = $("dk-corehit"), btn = $("dk-chatbtn"), panel = $("dk-panel");
    if (btn) place(btn, L.chatBtn.x - L.chatBtn.d / 2, L.chatBtn.y - L.chatBtn.d / 2, L.chatBtn.d, L.chatBtn.d);
    var lb = $("dk-livebtn");
    if (lb) place(lb, L.liveBtn.x - L.liveBtn.d / 2, L.liveBtn.y - L.liveBtn.d / 2, L.liveBtn.d, L.liveBtn.d);
    // Where an opened sheet, dialog or conversation goes: Floating, inside the box; otherwise a large centred panel.
    var ov = L.mode === "floating" ? { x: 8, y: L.box.y + 8, w: L.box.w - 16, h: L.box.h - 16 } : { w: Math.min(1040, L.W - 48), h: L.H - 48, y: 24 };
    if (ov.x == null) ov.x = (L.W - ov.w) / 2;
    ["x", "y", "w", "h"].forEach(function (k) { html.style.setProperty("--dk-ov-" + k, px(ov[k])); });
    if (panel) place(panel, L.panel.x, L.panel.y, L.panel.w, L.panel.h);
    if (st.focus && chatOpen()) closeChat();
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
  /**
   * The composer's "hold Ctrl Space to talk" hint never squeezes the message box: when the box is
   * too narrow for its placeholder (a small or scaled screen, a long talk key), the hint shortens to
   * the key caps alone, and if even that does not fit it goes. Measured, not guessed: the fonts differ
   * between machines. Runs when the composer or the box changes width and on apply.
   */
  var measureCv = null;
  function textW(el, text) {
    try {
      measureCv = measureCv || document.createElement("canvas");
      var g = measureCv.getContext("2d"), cs = getComputedStyle(el);
      g.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
      return g.measureText(text || "").width;
    } catch (e) { return 0; }
  }
  function fitHint() {
    var kb = $("dk-kb"), inp = $("cc-input");
    if (!kb || !inp) return;
    var form = inp.closest("form");
    if (!form || !form.getBoundingClientRect().width) return; // the panel is closed: measured when it opens
    var need = Math.ceil(textW(inp, inp.placeholder) + 8);
    kb.classList.remove("dk-kb-short", "dk-kb-none");
    if (inp.clientWidth >= need) return;
    kb.classList.add("dk-kb-short");
    if (inp.clientWidth >= need) return;
    kb.classList.add("dk-kb-none");
  }
  if (window.ResizeObserver) {
    // The form (the panel opening, a resize) and the box itself (the mic or the stop button coming and going).
    try {
      var ro = new ResizeObserver(function () { fitHint(); });
      ["cc-compose", "cc-input"].forEach(function (id) { if ($(id)) ro.observe($(id)); });
    } catch (e) { /* no observer: apply() still fits it */ }
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
    hint: function () { var kb = $("dk-kb"); return !kb ? "none" : kb.classList.contains("dk-kb-none") ? "hidden" : kb.classList.contains("dk-kb-short") ? "keys" : "full"; },
  };

  /* ---------------------------------------------------------------- the chat panel
     Closed by default. The chat button on the core opens it: the recent
     conversation (scrollable, the last LOG_KEEP exchanges, from the Command
     Center's own turns) and the composer, moved in here from the page so it
     is the same composer (moni-ai.js keeps driving it). It closes on the
     button again, its X, Esc or a click outside it. A reply that arrives
     while it is closed lights a dot on the button; nothing else shows. The
     words of a live call appear as a ghost line while they are said. */
  var LOG_KEEP = 20;
  var ghost = null;
  var dockHome = $("dk-panel-dock"), dockEl = $("cc-dock");
  if (dockHome && dockEl) dockHome.appendChild(dockEl);
  function chatOpen() { var p = $("dk-panel"); return !!(p && !p.hidden); }
  function openChat(focusInput) {
    var p = $("dk-panel"), b = $("dk-chatbtn");
    if (!p || st.focus) return;
    p.hidden = false;
    if (b) { b.setAttribute("aria-expanded", "true"); b.classList.add("on"); b.classList.remove("unread"); }
    seenAi = lastAi;
    renderChat(true);
    if (focusInput !== false) setTimeout(function () { var i = $("cc-input"); if (i && !i.closest("[hidden]")) i.focus(); }, 30);
    report(true);
  }
  function closeChat() {
    var p = $("dk-panel"), b = $("dk-chatbtn");
    if (!p || p.hidden) return;
    p.hidden = true;
    if (b) { b.setAttribute("aria-expanded", "false"); b.classList.remove("on"); }
    var a = document.activeElement;
    if (a && p.contains(a) && a.blur) a.blur();
    report(true);
  }
  var lastAi = "", seenAi = "", primed = false, bornAt = Date.now();
  function turns() { var cc = window.__mintCC; return cc && cc.recent ? cc.recent(LOG_KEEP) : []; }
  function renderChat(force) {
    var box = $("dk-log");
    if (!box) return;
    var list = turns(), out = [];
    list.forEach(function (x) { if (x.me) out.push({ who: "me", text: x.me, id: "m" + x.id }); if (x.ai) out.push({ who: "ai", text: x.ai, id: "a" + x.id }); });
    // The newest reply: a new one while the panel is closed lights the button's dot.
    var ai = out.filter(function (b) { return b.who === "ai" && b.text !== "…"; }).pop();
    var aiSig = ai ? ai.id + ":" + ai.text.length : "";
    // What the page loaded with (the history comes in its first seconds) is not new.
    if (!primed) { seenAi = aiSig; if (aiSig || Date.now() - bornAt > 4000) primed = true; }
    lastAi = aiSig;
    var btn = $("dk-chatbtn");
    if (btn) btn.classList.toggle("unread", !chatOpen() && !!aiSig && aiSig.split(":")[0] !== seenAi.split(":")[0]);
    if (chatOpen()) seenAi = aiSig;
    var sig = out.map(function (b) { return b.id + ":" + b.text.length; }).join("|") + "|" + (ghost ? ghost.text : "");
    if (!force && sig === renderChat.sig) return;
    renderChat.sig = sig;
    var atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    var h = "";
    out.forEach(function (b) {
      h += '<div class="dk-msg ' + b.who + '"><b>' + (b.who === "ai" ? "MINT AI" : "You") + "</b><span>" + esc(clip(b.text, 4000)) + "</span></div>";
    });
    if (ghost && ghost.text) h += '<div class="dk-msg me ghost"><b>You</b><span>' + esc(clip(ghost.text, 600)) + "…</span></div>";
    if (!h) h = '<p class="dk-empty">Nothing said yet. Type below, or hold the talk key to speak.</p>';
    box.innerHTML = h;
    if (atEnd || force) box.scrollTop = box.scrollHeight;
  }
  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  var cb = $("dk-chatbtn");
  if (cb) cb.addEventListener("click", function (e) { e.preventDefault(); if (chatOpen()) closeChat(); else openChat(true); });
  var px_ = $("dk-panel-x");
  if (px_) px_.addEventListener("click", function (e) { e.preventDefault(); closeChat(); });
  // A click outside the panel closes it (where the window lets clicks through, they never reach here anyway).
  document.addEventListener("pointerdown", function (e) {
    if (!chatOpen() || !e.target.closest) return;
    if (e.target.closest("#dk-panel, #dk-chatbtn, .cc-need, .cc-toast, .cc-pop, .cc-smenu, .cc-sdlg-back, .cc-modal, .cc-palette, [role=menu], [role=dialog]")) return;
    closeChat();
  }, true);
  document.addEventListener("mint-turns", function () { renderChat(false); });

  /* ---------------------------------------------------------------- the live-call button (and the app's live key)
     Not on a call: starts a hands-free live call, as a tap of the mic does. On one: ends it, as the voice
     bar's red X does. A warm hold-to-talk call is not a live one: the button starts a live call in its place. */
  var liveB = $("dk-livebtn");
  function liveMode() { var lv = window.__mintLive; return lv && lv.mode ? lv.mode() : lv && lv.active && lv.active() ? "live" : ""; }
  function liveToggle() {
    var lv = window.__mintLive;
    if (!lv || !lv.ok || !lv.ok()) return false;
    var m = liveMode();
    if (m === "live") return lv.end("button");
    if (m === "ptt") { lv.end("button"); setTimeout(function () { if (!liveMode()) lv.toggle(); }, 500); return true; }
    return lv.toggle();
  }
  function paintLiveBtn() {
    if (!liveB) return;
    var lv = window.__mintLive, ok = !!(lv && lv.ok && lv.ok()), on = liveMode() === "live";
    liveB.hidden = !ok;
    liveB.classList.toggle("on", on);
    var t = on ? "End conversation" : "Start a live conversation" + (st.liveKey ? " (" + st.liveKey + ")" : "");
    if (liveB.title !== t) { liveB.title = t; liveB.setAttribute("aria-label", on ? "End conversation" : "Start a live conversation"); }
  }
  if (liveB) {
    liveB.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); liveToggle(); setTimeout(paintLiveBtn, 50); });
    setInterval(paintLiveBtn, 250);
    paintLiveBtn();
  }
  listen("mint://live", function () { liveToggle(); setTimeout(paintLiveBtn, 50); });

  /* ---------------------------------------------------------------- listening: on the state pill only
     No voice bar while the panel is closed: the pill reads "Listening" (moni-ai.js) and a small
     meter in it follows the microphone's level. */
  var capSt = $("cc-cap-state"), meter = null;
  if (capSt) {
    meter = document.createElement("span");
    meter.className = "dk-meter";
    meter.setAttribute("aria-hidden", "true");
    meter.innerHTML = "<i></i><i></i><i></i><i></i>";
    capSt.appendChild(meter);
    var bars = meter.children, ph = 0;
    setInterval(function () {
      if (capSt.getAttribute("data-s") !== "listening") return;
      var lv = window.__mintLive, l = lv && lv.level ? Math.min(1, (lv.level() || 0) * 4) : 0;
      ph += 0.9;
      for (var i = 0; i < bars.length; i++) bars[i].style.transform = "scaleY(" + (0.25 + 0.75 * l * (0.6 + 0.4 * Math.abs(Math.sin(ph + i * 1.3)))).toFixed(2) + ")";
    }, 90);
  }
  document.addEventListener("mint-live-caption", function (e) {
    var d = (e && e.detail) || {};
    ghost = d.who === "you" && d.text && !d.final ? { text: d.text } : null;
    renderChat();
  });

  /* ---------------------------------------------------------------- click-through: what catches the mouse */
  // The chat button always; the chat panel (and the composer in it) only while it is open (a hidden element is skipped).
  var HIT = [
    "#dk-livebtn", "#dk-chatbtn", "#dk-panel", "#cc-cap-state", "#cc-cap-more", "#cc-need", "#dk-tools", "#cc-kids > *",
    "#cc-reply", "#cc-pop", "#cc-kcard.on", ".cc-smenu", ".cc-toast", ".dk-auth .auth-wrap .card", "#dk-gate", "#cc-offline", "#cc-needpill",
  ];
  // Open over everything: the whole window catches the mouse while one shows.
  // (#cc-overlay holds the conversation of a session -- the deep view -- and the forms: the whole window while one is open.)
  var FULL = ["#cc-overlay > *", ".cc-sdlg-back", ".cc-modal:not([hidden])", "#cc-sheet.open", ".cc-palette:not([hidden])", "#md-frame:not([hidden])"];
  function shown(el) {
    if (!el || el.hidden) return false;
    var r = el.getClientRects();
    if (!r.length) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  }
  function present(el) {
    if (!el || el.hidden || !el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  function measure() {
    if (!L) return [];
    var full = st.mode === "peek" && st.peekOpen;
    // (Open counts from the first frame: an overlay fading in is already there to be clicked.)
    if (!full) for (var f = 0; f < FULL.length; f++) { var fe = document.querySelectorAll(FULL[f]); for (var j = 0; j < fe.length; j++) if (present(fe[j])) { full = true; break; } if (full) break; }
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
      (mk || []).forEach(function (q) { if (q && q.r > 2 && (q.form == null || q.form > 0.3)) { var h = q.r * 1.25 + 8; els.push({ left: q.x - h, top: q.y - h, width: 2 * h, height: 2 * h, r: h }); } }); // the family's own hover radius (cc-family.js hit)
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
  // A dialog, menu or overlay added (or removed) is reported at once, not at the next tick: the first click on it must land.
  try {
    var mo = new MutationObserver(function () { report(false); });
    mo.observe(document.body, { childList: true });
    var ovl = document.getElementById("cc-overlay");
    if (ovl) mo.observe(ovl, { childList: true });
  } catch (e) { /* the tick still reports */ }
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
    ["mode", "focus", "size", "pos", "ink", "opacity", "still", "peekOpen", "talkKey", "liveKey", "hidden"].forEach(function (k) { if (p[k] !== undefined) st[k] = p[k]; });
    if (JSON.stringify(st) !== was) apply();
    if (p.focusComposer) setTimeout(function () { openChat(true); }, 120);
  });
  listen("mint://ptt", function (p) {
    var lv = window.__mintLive;
    // at / seq: the app's time of the key event and its order (moni-ai.js pttKey judges taps by them).
    if (lv && lv.ptt) lv.ptt(!!p.down, typeof p.at === "number" ? p.at : undefined, typeof p.seq === "number" ? p.seq : undefined);
  });
  listen("mint://escape", function () { escape(); });
  // The tray's Talk: a hands-free live call, as a tap of the mic starts.
  listen("mint://talk", function () { var lv = window.__mintLive; if (lv && lv.toggle && !(lv.active && lv.active())) lv.toggle(); });
  // The tray's Sign out: this device's session ends (its call too), as the avatar menu's sign-out does.
  listen("mint://signout", function () { var f = document.querySelector("form.me-logout"); if (f) f.submit(); });
  // Quit: hang up first, so the server logs why.
  listen("mint://quit", function () { var lv = window.__mintLive; if (lv && lv.active && lv.active()) lv.end("unload"); });
  function escape() {
    if (chatOpen()) { closeChat(); return; }
    var lv = window.__mintLive;
    if (lv && lv.active && lv.active()) { lv.end("esc"); return; }
    if (st.mode === "peek") invoke("hide_peek");
  }
  var ESC_OWNERS = "#cc-overlay > *, .cc-sdlg-back, .cc-modal:not([hidden]), #cc-pop:not([hidden]), .cc-smenu, .cc-sheet.open, .cc-palette:not([hidden])";
  var escOwned = false;
  window.addEventListener("keydown", function (e) { if (e.key === "Escape") escOwned = !!document.querySelector(ESC_OWNERS); }, true);
  window.addEventListener("keydown", function (e) {
    // Esc closes the topmost thing open first (an overlay, a dialog, a menu, the sheet: their own handlers,
    // which run before this one -- so whether one was open is noted as the key goes down); only then the
    // chat panel, the call, Peek.
    if (e.key === "Escape" && !e.defaultPrevented && !escOwned) escape();
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
      openChat(true);
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
  // The app's "hold still" must stick: it used to stop the core only if it was running at that moment,
  // so a core that was paused just then (the window hidden or covered: WebView2 marks the page hidden),
  // or not started yet (the app starting on battery), was started again later by the page's own
  // visibility handler or start() -- and animated on battery. Now the core's own still flag is set
  // (its start() then draws one still frame), and a slow guard catches a core swapped in later.
  var reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function still() {
    var cc = window.__mintCC, core = cc && cc.core;
    if (!core) return;
    var hold = !!(st.still || st.hidden);
    if (hold) {
      if (core.S) core.S.still = true;
      if (core.stop) core.stop();
      if (core.still) core.still(); else if (core.draw) core.draw();
    } else if (core.S) {
      var was = core.S.still;
      core.S.still = !!(reduceMq && reduceMq.matches);
      if ((was || !core.S.running) && core.start) core.start();
    }
  }
  setInterval(function () {
    if (!(st.still || st.hidden)) return;
    var cc = window.__mintCC, core = cc && cc.core;
    if (core && core.S && (core.S.running || !core.S.still)) still();
  }, 2000);

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
      if (p) ["mode", "focus", "size", "pos", "ink", "opacity", "still", "peekOpen", "talkKey", "liveKey", "hidden"].forEach(function (k) { if (p[k] !== undefined) st[k] = p[k]; });
      apply();
      invoke("page_ready", { signedIn: !!$("cc") });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { layout(); });
})();
