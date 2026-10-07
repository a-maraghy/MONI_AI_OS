"use strict";
/*
 * The MINT AI desktop app's layouts (Floating, Peek, Desktop layer), as one
 * pure function, shared by the page (public/mint-desktop.js) and the tests
 * (tools/test-desktop-shell.cjs). The numbers are the approved mockup's
 * (mockups/desktop-app, L() and layoutChrome()).
 *
 * The app's window is not the screen: in Floating it is the box (480 x 580 at
 * size M) with HEADROOM above it for a decision card, so the card grows above
 * the box and never covers its own core; in Peek and Desktop layer it is the
 * monitor's work area. So every number here is in the window's own CSS
 * pixels, (0, 0) at its top left.
 *
 *   MintDesktopLayout.layout({ mode, size, pos, focus, W, H }) ->
 *     { mode, box, cx, cy, R, chatBtn, liveBtn, panel, caption, card, gate, tools }
 *
 * Since 0.1.2 nothing of the conversation shows by itself: the core, the
 * session spheres and the state pill; a small round chat button on the core's
 * lower right (chatBtn: its centre and diameter) opens the chat panel (panel:
 * the recent conversation with the composer inside), under the core.
 *   MintDesktopLayout.windowSize({ mode, size, focus }) -> { w, h } (Floating only)
 *
 * The host (desktop/src-tauri/src/layout.rs) sizes the Floating window with
 * the same numbers; tools/test-desktop-shell.cjs checks they agree.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MintDesktopLayout = api;
})(typeof self !== "undefined" ? self : this, function () {
  var SIZES = { S: 0.8, M: 1, L: 1.22 };
  var MODES = { desktop: 1, floating: 1, peek: 1 };
  var HEADROOM = 280; // above the Floating box: where its decision card goes
  var MARGIN = 14;
  var BTN = 34; // the chat button's diameter
  var PANEL_MAX_H = 440;

  /*
   * The core's two round buttons, on its rim at the lower right: chat at 10
   * degrees below the horizontal (about 3 o'clock), the live call at 42 (about
   * half past 4) -- clear of each other and of the state pill under the core
   * at every size.
   */
  function rimBtn(L, deg) {
    var D = L.R * 1.02 + 8, a = (deg * Math.PI) / 180;
    return { x: L.cx + D * Math.cos(a), y: L.cy + D * Math.sin(a), d: BTN };
  }
  function chatBtn(L) { return rimBtn(L, 10); }
  function liveBtn(L) { return rimBtn(L, 42); }

  function sizeK(s) { return SIZES[s] || 1; }
  function mode(m) { return MODES[m] ? m : "floating"; }

  /** The Floating window: the box, plus the headroom above it (none in focus mode: no card shows). */
  function windowSize(o) {
    o = o || {};
    var k = sizeK(o.size);
    var bw = Math.round((o.focus ? 168 : 480) * k), bh = Math.round((o.focus ? 168 : 580) * k);
    return { w: bw, h: bh + (o.focus ? 0 : HEADROOM), box: { w: bw, h: bh } };
  }

  function layout(o) {
    o = o || {};
    var m = mode(o.mode), k = sizeK(o.size), W = Math.max(1, o.W || 1), H = Math.max(1, o.H || 1);
    var focus = !!o.focus;
    var L = { mode: m, focus: focus, W: W, H: H };
    if (m === "floating") {
      // A bottom corner (the default): the box at the bottom of the window, the card's headroom above it.
      // A top corner: the box at the top, the headroom below (the app places the window the same way).
      var up = /^t/.test(o.pos || "");
      var ws = windowSize(o), bw = ws.box.w, bh = ws.box.h, top = up ? 0 : H - bh;
      L.box = { x: 0, y: top, w: bw, h: bh };
      L.cx = bw / 2;
      L.cy = focus ? top + bh / 2 : top + bh * 0.36;
      L.R = focus ? bw * 0.3 : bw * 0.163;
      L.caption = { x: L.cx, y: L.cy + L.R + 6 };
      L.chatBtn = chatBtn(L);
    L.liveBtn = liveBtn(L);
      L.liveBtn = liveBtn(L);
      // The chat panel: the box's lower part, under the state pill.
      var pTop = L.cy + L.R + 40;
      L.panel = { x: MARGIN, y: pTop, w: bw - 2 * MARGIN, h: Math.max(120, top + bh - MARGIN - pTop) };
      // The card: in the headroom, 10 px off the box, right-aligned; never over the core.
      var cw = Math.min(330, bw - 16);
      L.card = up ? { x: Math.max(8, bw - cw - 8), y: bh + 10, w: cw, h: Math.max(0, H - bh - 18), bottom: null } : { x: Math.max(8, bw - cw - 8), y: 8, w: cw, h: Math.max(0, top - 18), bottom: H - top + 10 };
      L.gate = { x: bw / 2, y: top + bh - 170, w: Math.min(340, bw - 20) };
      L.tools = { x: bw - 136, y: top + 8 };
      return L;
    }
    var R = (m === "peek" ? 180 : 170) * k;
    var fx = m === "peek" ? 0.5 : { left: 0.36, centre: 0.5, right: 0.56 }[o.pos || "right"] || 0.56;
    L.box = { x: 0, y: 0, w: W, h: H };
    L.cx = W * fx;
    L.cy = H * (m === "peek" ? 0.4 : 0.42);
    L.R = R;
    // Small screens: the core leaves room under it for the state pill and the chat panel's top.
    if (L.cy + L.R + 60 > H - 72) L.R = Math.max(60, H - 72 - 60 - L.cy);
    L.caption = { x: L.cx, y: L.cy + L.R + 16 };
    L.chatBtn = chatBtn(L);
    L.liveBtn = liveBtn(L);
    // The chat panel: under the core, centred on it; where there is no room under it, beside it.
    var pw = Math.min(m === "peek" ? 560 : 460, W - 32);
    var py = L.cy + L.R + 56, ph = Math.min(PANEL_MAX_H, H - 24 - py);
    if (ph >= 220) L.panel = { x: Math.max(16, Math.min(W - 16 - pw, L.cx - pw / 2)), y: py, w: pw, h: ph };
    else {
      ph = Math.min(PANEL_MAX_H, H - 32);
      var right = W - 16 - (L.cx + L.R + 32) >= L.cx - L.R - 32 - 16; // the wider side
      pw = Math.max(260, Math.min(pw, right ? W - 16 - (L.cx + L.R + 32) : L.cx - L.R - 48));
      L.panel = { x: right ? Math.min(W - 16 - pw, L.cx + L.R + 32) : Math.max(16, L.cx - L.R - 32 - pw), y: Math.max(16, Math.min(H - 16 - ph, L.cy - ph / 2)), w: pw, h: ph };
    }
    L.card = { x: Math.max(16, W - 16 - 330), y: 72, w: Math.min(330, W - 32), h: H - 72 - 16, bottom: null };
    L.gate = { x: L.cx, y: L.cy + L.R + 60, w: 340 };
    L.tools = null;
    return L;
  }

  /**
   * The rectangles that catch the mouse, for the host's click-through: a list
   * of { x, y, w, h, r } (r: corner radius; a circle is w = h = 2r).
   * `els` are rects already measured (DOMRect-like); the core is a circle.
   * Anything zero-sized or wholly outside the window is dropped; the rest are
   * clipped to it and rounded outward to whole pixels.
   */
  function regions(L, els, opts) {
    opts = opts || {};
    var out = [];
    function add(x, y, w, h, r) {
      var x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
      var x1 = Math.min(L.W, Math.ceil(x + w)), y1 = Math.min(L.H, Math.ceil(y + h));
      if (x1 - x0 < 1 || y1 - y0 < 1) return;
      out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, r: Math.max(0, Math.round(r || 0)) });
    }
    if (opts.all) { add(0, 0, L.W, L.H, 0); return out; }
    if (L.R > 0) add(L.cx - L.R, L.cy - L.R, 2 * L.R, 2 * L.R, L.R);
    (els || []).forEach(function (e) {
      if (!e || !(e.width > 0) || !(e.height > 0)) return;
      add(e.left != null ? e.left : e.x, e.top != null ? e.top : e.y, e.width, e.height, e.r || 0);
    });
    return out;
  }

  return { layout: layout, windowSize: windowSize, regions: regions, SIZES: SIZES, HEADROOM: HEADROOM };
});
