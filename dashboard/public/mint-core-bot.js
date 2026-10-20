"use strict";
/*
 * MINT AI core E, "Bot" (approved 2026-10-19, mockups/emo-core-states): a faint
 * wireframe head -- a cube grid projected onto a rounded box (superellipsoid
 * |x|^p + |y|^p + |z|^p = 1, even grid on the front so the face keeps its
 * pixels), grid nodes as small dots, one of ten accessories -- whose FACE is
 * lit on the front grid's nodes in ONE state colour, with a soft glow of that
 * colour (and in the dark theme a faint cyan -> violet glow behind the head).
 * The geometry is the mockup generator's (mockups/emo-core-states/src/page.html:
 * head(), cap, headphones, beanie, antenna, ears, goggles, mic, halo, mortar,
 * bow; the face maps F.*), rebuilt here as 3D buffers and animated.
 *
 *   ready (idle)  base smile; slow breathing, a slow yaw sway, a blink every 3-6 s, a glance now and then
 *   listening     wide eyes; the glow and the lit nodes pulse with the microphone level
 *   thinking      furrowed brows; a shimmer sweeps across the head's nodes
 *   speaking      a waveform mouth driven by the voice's real output level
 *   delegating    thinking's colour; the eyes and the head turn toward the session, a stream of dots flies there
 *   needs you     wide eyes with pupils, amber, a soft double pulse
 *   error/offline red x x, still
 * A face change cross-fades the lit nodes over ~250 ms (colours over ~300 ms): nothing pops.
 *
 * Expressive (2026-10-20, mockups/bot-design-upgrades):
 *   the mouth     speaking: four viseme-like shapes (closed / open / wide / round, MOUTH) mixed per node from the
 *                 voice's spectrum (opts.spec: an AnalyserNode's bytes, viseme()); level only without one
 *   the eyes      follow the pointer (opts.pointer: the window's pointer moves; core.look by hand) and drift back
 *                 when it leaves; glance at a session that needs you or replied (core.glance, cc-map.js)
 *   dozing        idle and 10 quiet minutes, or at night (23:00-06:00 local) after one: lids down, the sleep face,
 *                 slow deep breaths, z z z rising on the left (dozeWanted); a message, a card, voice, typing or
 *                 the pointer near wakes it (core.poke): a blink and a hop
 *   reactions     core.react: surprise (going offline), grin + hops (a job done), nod (approved), wake
 *   still frames  (reduced motion, hold still): the faces only -- a still sleep face, a grin for its moment; no motion
 * The sessions wear their own heads (k.head, cc-logic.js botHeadFor: by role, or the viewer's pin).
 *
 * Same instance contract as mint-core-d.js (cc-map.js, mint-shell.js, mint-dock.js and
 * mint-desktop.js drive both the same way):
 *   var core = window.MintCoreBot(canvas, { amp, dest, onFrame, backdrop, kids, beforeDraw, head, colors, force2d, noGuard, desk, spec, pointer, now, hour })
 * opts.desk: the desktop app's render mode (?shell=desktop): the page is transparent over the wallpaper, so
 * every head gets a soft contrast backplate (dark under light lines, light under dark ones) and a stronger
 * wireframe; the browser Command Center look is unchanged without it.
 *   core.S.concept === "E" · setState · setLight · resize(cx, cy, R, w, h) · start · stop · still · stats · draw
 *   · place · tick · adopt · destroy · setConcept (no-op) · setHead(id) · setColors({p, c}) · setOffline(bool)
 *   · poke() · react(kind) · glance(point | fn, ms) · look(x, y | null)
 * opts.kids(): the Command Center's session spheres (cc-family.js meshKids) -- drawn here as
 * small bot heads in the same style, with their own state in the same colour + face language
 * (MintLogic.botSessState): waiting -> needs you, working -> thinking, a delegation landing ->
 * listening, a reply going back -> speaking, just finished -> a grin, idle -> ready; born out of
 * the core's dots, dissolving back into them. The sessions wear their role's head (k.head), else the core's.
 *
 * WebGL2 (lines + point sprites; the glows drawn at quarter resolution and blended up), else a
 * Canvas-2D renderer of the same geometry (also used for the Settings thumbnails: MintBot.thumb).
 * DPR <= 2; no allocation per frame (typed arrays reused); the loop stops while the tab is
 * hidden; prefers-reduced-motion and the desktop app's "hold still" (S.still) draw one still
 * frame per change. No eval, no inline style: CSP-safe. Colours come from MintLogic.botPalette
 * (cc-logic.js), with the approved Default set built in if that file is not on the page.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") { window.MintBot = api; window.MintCoreBot = api.create; }
})(typeof self !== "undefined" ? self : this, function () {
  var PI = Math.PI;
  var STATES = ["idle", "listening", "thinking", "delegating", "speaking", "needs"];
  var KEYS = ["listen", "think", "speak", "deleg", "need", "err"];
  var TARGETS = { idle: {}, listening: { listen: 1 }, thinking: { think: 1 }, delegating: { deleg: 1, think: 0.4 }, speaking: { speak: 1 }, needs: { need: 1 }, error: { err: 1 } };
  var G = 18, GN = G + 1, NF = GN * GN; // the front grid: 19 x 19 nodes, the face maps' pixels
  var MAXK = 12, ROWS = MAXK + 2;        // weight rows: 0 the core, 1.. the sessions
  var STREAM = 420;
  var SMALL = 40; // CSS px head radius below which a head is "small" (sessions, the dock): coarse, crisp face, no face glow

  /* ------------------------------------------------------------ faces (the mockup's maps) */
  var FMAP = {
    base: ["..................", "..................", "...cccc....cccc...", "..c.cc.c..c.cc.c..", "..cccccc..cccccc..", "..c.cc.c..c.cc.c..", "...cccc....cccc...", "..................", "..................", "..m............m..", "...m..........m...", "....mmmmmmmmmm....", ".................."],
    grin: ["..................", "...ccc......ccc...", "..c...c....c...c..", ".c.....c..c.....c.", "..................", "..................", "..mmmmmmmmmmmmmm..", "..m.w.w.w.w.w.wm..", "...m..........m...", "....mmmmmmmmmm....", ".................."],
    pupils: ["..................", "..vvvvv....vvvvv..", ".v.....v..v.....v.", ".v..ww.v..v..ww.v.", ".v..ww.v..v..ww.v.", "..vvvvv....vvvvv..", "..................", "..................", ".......mmmm.......", "......m....m......", ".................."],
    focus: ["..cc..........cc..", "....cc......cc....", "......c....c......", "..................", "..vvvvv....vvvvv..", "..vvvvv....vvvvv..", "..................", "..................", "......mmmmmm......", ".................."],
    listen: ["..................", "..cccccc..cccccc..", "..cccccc..cccccc..", "..cccccc..cccccc..", "..cccccc..cccccc..", "..cccccc..cccccc..", "..................", "..................", ".......mmmm.......", ".......mmmm.......", ".................."],
    speak: ["..................", "...cccc....cccc...", "...cccc....cccc...", "...cccc....cccc...", "..................", "..................", "...m.m.m.m.m.m....", "..mmmmmmmmmmmmmm..", "...m.m.m.m.m.m....", ".................."],
    err: ["..................", "..c...c....c...c..", "...c.c......c.c...", "....c........c....", "...c.c......c.c...", "..c...c....c...c..", "..................", "..................", ".....cccccccc.....", ".................."],
    // dozing (2026-10-20): the eyes shut as two downward arcs, a small slack mouth
    sleep: ["..................", "..................", "..................", "..c....c..c....c..", "...cccc....cccc...", "..................", "..................", "..................", ".......mmmm.......", ".................."],
  };
  /*
   * Speaking mouths (2026-10-20): four viseme-like shapes, drawn on the speak face's mouth rows (map rows
   * 5..9) and mixed by the voice's spectrum (viseme() below): closed (silence, m b p), open (a), wide
   * (ee, s -- energy high up), round (o u -- energy low down). Mixed per node, so a change of shape fades.
   */
  var MOUTH = {
    closed: ["..................", "..................", "...mmmmmmmmmmmm...", "..................", ".................."],
    open: [".....mmmmmmmm.....", "....m........m....", "....m........m....", "....m........m....", ".....mmmmmmmm....."],
    wide: ["..................", "..mmmmmmmmmmmmmm..", "..m............m..", "...mmmmmmmmmmmm...", ".................."],
    round: [".......mmmm.......", "......m....m......", "......m....m......", ".......mmmm.......", ".................."],
  };
  var VIS = ["closed", "open", "wide", "round"];
  var MOUTHB = {};
  VIS.forEach(function (k) { var m = MOUTH[k], b = new Uint8Array(5 * 18); for (var r = 0; r < 5; r++) for (var c = 0; c < 18; c++) b[r * 18 + c] = m[r].charAt(c) !== "." ? 1 : 0; MOUTHB[k] = b; });
  function mouthAt(vm, ri, ci) {
    if (ci < 0 || ci > 17) return 0;
    var o = (ri - 5) * 18 + ci;
    return Math.min(1, vm.closed * MOUTHB.closed[o] + vm.open * MOUTHB.open[o] + vm.wide * MOUTHB.wide[o] + vm.round * MOUTHB.round[o]);
  }
  function sstep(a, b, x) { x = (x - a) / (b - a); x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); }
  /** Mean of a byte spectrum's bins between f0 and f1 Hz, above a noise floor, 0..1. */
  function bandOf(bins, hz, f0, f1) {
    var a = Math.max(1, Math.floor(f0 / hz)), b = Math.min(bins.length - 1, Math.ceil(f1 / hz)), s = 0;
    if (b < a) return 0;
    for (var i = a; i <= b; i++) { var v = bins[i] - 70; if (v > 0) s += v; }
    return s / (b - a + 1) / 185;
  }
  /**
   * The mouth shape for this instant: viseme(bins, hz, level, out) -> out {closed, open, wide, round}
   * (they sum to 1). bins: an AnalyserNode's getByteFrequencyData (hz = sampleRate / fftSize per bin), or
   * null: then level only (closed <-> open). How far the mouth opens follows the level; which shape it opens
   * into follows where the energy sits: low (150-600 Hz) round, the middle (0.6-1.8 kHz) open, high up
   * (1.8-9 kHz: ee, s, t) wide. No allocation (out is filled in place).
   */
  function viseme(bins, hz, level, out) {
    out = out || { closed: 1, open: 0, wide: 0, round: 0 };
    level = level > 1 ? 1 : level > 0 ? level : 0;
    var k = sstep(0.06, 0.5, level);
    if (!bins || !hz || !bins.length) { out.closed = 1 - k; out.open = k; out.wide = 0; out.round = 0; return out; }
    var lo = bandOf(bins, hz, 150, 600), mid = bandOf(bins, hz, 600, 1800), hi = bandOf(bins, hz, 1800, 4500) + 1.2 * bandOf(bins, hz, 4500, 9000), tot = lo + mid + hi;
    if (tot < 0.015) { out.closed = 1; out.open = out.wide = out.round = 0; return out; }
    var R = Math.max(0, lo / tot - 0.5) * 2.4, Wd = Math.max(0, hi / tot - 0.3) * 2.6, O = mid / tot + 0.25, n = R + Wd + O;
    out.closed = 1 - k; out.open = k * O / n; out.wide = k * Wd / n; out.round = k * R / n;
    return out;
  }

  /* ------------------------------------------------------------ moods and reactions (2026-10-20) */
  var DOZE_QUIET_MS = 10 * 60 * 1000, NIGHT_QUIET_MS = 60 * 1000;
  function isNight(hour) { return hour >= 23 || hour < 6; }
  /**
   * Should the bot doze? Only when idle and reachable, nobody's pointer near it, and either nothing has
   * happened for 10 minutes or it is night (23:00-06:00 local) and a minute has passed quietly.
   */
  function dozeWanted(o) {
    if (!o || o.state !== "idle" || o.offline || o.near) return false;
    var q = o.quietMs || 0;
    return q >= DOZE_QUIET_MS || (isNight(o.hour) && q >= NIGHT_QUIET_MS);
  }
  // reactions: how long each plays (s); surprise (an error / going offline), grin (a job done), nod (approved), wake
  var REACT = { surprise: 0.9, grin: 1.6, nod: 0.9, wake: 0.6 };
  /**
   * The core's face and colour item: the state's (FACE_OF), unless a reaction or dozing shows over it.
   * surprise: wide eyes; grin: the grin (in the ready colour, while idle or speaking); dozing (doze > 0.65,
   * idle): the sleep face.
   */
  function pickFace(state, offline, rk, doze) {
    var fo = coreFace(state, offline);
    if (rk === "surprise") return { face: "listen", state: fo.state };
    if (rk === "grin" && !offline && (state === "idle" || state === "speaking")) return { face: "grin", state: "ready" };
    if (!offline && state === "idle" && doze > 0.65 && rk !== "wake") return FACE_SLEEP;
    return fo;
  }
  var FACE_SLEEP = { face: "sleep", state: "ready" };
  /**
   * One dot of the dozing "z z z" (i: 0..29, three z's of ten grid dots: a top bar of four, a two-dot
   * diagonal, a bottom bar of four) at time t: [dx, dy, size, alpha] in head radii, y up. They rise up and
   * to the LEFT of the head (the cap's antenna and the brim are on its right).
   */
  var ZD = [-1.5, 1.5, -0.5, 1.5, 0.5, 1.5, 1.5, 1.5, 0.5, 0.5, -0.5, -0.5, -1.5, -1.5, -0.5, -1.5, 0.5, -1.5, 1.5, -1.5], ZN = 30;
  function zDot(i, t, out) {
    var zi = (i / 10) | 0, d = i % 10, p = (t / 3.6 + zi / 3) % 1, s = 0.038 + 0.03 * p;
    out[0] = -0.98 - 0.36 * p + 0.05 * Math.sin(t * 1.3 + zi * 2.1) + ZD[d * 2] * s;
    out[1] = 0.55 + 0.95 * p + ZD[d * 2 + 1] * s;
    out[2] = 0.55 + 0.6 * p;
    out[3] = Math.sin(PI * p);
    return out;
  }
  // eye band (map rows that blink and glance) and, for speak, the mouth band drawn from the voice level
  var FBAND = { base: [2, 6], grin: [1, 3], pupils: [1, 5], focus: [4, 5], listen: [1, 5], speak: [1, 3], err: null, sleep: null };
  var FACES = {};
  Object.keys(FMAP).forEach(function (k) {
    var m = FMAP[k], fr = m.length, fc = m[0].length, bits = new Uint8Array(fr * fc);
    for (var r = 0; r < fr; r++) for (var c = 0; c < fc; c++) bits[r * fc + c] = m[r].charAt(c) !== "." ? 1 : 0;
    var band = FBAND[k], col = null;
    if (band) { col = new Uint8Array(fc); for (var c2 = 0; c2 < fc; c2++) for (var r2 = band[0]; r2 <= band[1]; r2++) if (bits[r2 * fc + c2]) col[c2] = 1; }
    // the same centring as the mockup's head(): ci = i - round((G - fc + 1) / 2), ri = j - round((G - fr + 1) / 2)
    FACES[k] = { fr: fr, fc: fc, bits: bits, band: band, col: col, oR: Math.round((G - fr + 1) / 2), oC: Math.round((G - fc + 1) / 2), wave: k === "speak" };
  });
  function px(F, r, c) { return r >= 0 && r < F.fr && c >= 0 && c < F.fc ? F.bits[r * F.fc + c] : 0; }
  /**
   * One face's lit value (0..1) at front node (row r, col c), with the eyes shifted (gx, gy), blinking (s: 1 open
   * .. 0 shut) and the voice: vm (the viseme mix, the core) shapes the mouth, else amp / t draw the waveform (sessions).
   */
  function faceAt(F, r, c, gxi, gy, s, amp, t, vm) {
    var ri = r - F.oR, ci = c - F.oC, B = F.band;
    if (B) {
      var rs = ri - gy, cs = ci - gxi;
      if (rs >= B[0] && rs <= B[1]) {
        if (s > 0.97) return px(F, rs, cs);
        var ec = (B[0] + B[1]) / 2;
        if (s < 0.3) return rs === Math.round(ec) && cs >= 0 && cs < F.fc ? F.col[cs] : 0;
        var src = Math.round(ec + (rs - ec) / s);
        return src >= B[0] && src <= B[1] ? px(F, src, cs) : 0;
      }
      if (ri >= B[0] && ri <= B[1]) return 0; // the eyes moved away from here
    }
    if (F.wave && ri >= 5 && ri <= 9) {
      if (vm) return mouthAt(vm, ri, ci);
      if (ci < 2 || ci > 15) return 0;
      var h = amp * 2.4 * (0.55 + 0.45 * Math.sin(ci * 1.7 + t * 11) * Math.sin(ci * 0.6 - t * 5.3));
      return Math.abs(ri - 7) <= h + 0.25 ? 1 : 0;
    }
    return px(F, ri, ci);
  }

  /* ------------------------------------------------------------ heads (the mockup's HEADS) */
  var HEADS = {
    cap: { p: 4, yaw: 0.32, acc: ["cap", "headphones", "ant1"] },
    headphones: { p: 5, yaw: 0.25, acc: ["headphones"] },
    beanie: { p: 3.2, yaw: -0.3, acc: ["beanie"] },
    goggles: { p: 4.5, yaw: 0.35, acc: ["goggles"] },
    headset: { p: 4, yaw: 0.3, acc: ["headphones", "mic"] },
    ears: { p: 4, yaw: -0.28, acc: ["ears"] },
    halo: { p: 5, yaw: 0.3, acc: ["halo"] },
    mortar: { p: 4.5, yaw: 0.35, tilt: 0.26, acc: ["mortar"] },
    antennas: { p: 3.6, yaw: -0.25, acc: ["ant2"] },
    bowtie: { p: 6, yaw: 0.3, acc: ["headphones", "bow"] },
  };
  var HEAD_IDS = Object.keys(HEADS);

  /*
   * Vertex: x, y, z (head units: half-width 1), kind, face node (-1 none), rnd, size (or, on a lit-stroke
   * point, its second face node). Kinds: 0 head surface (hidden on the back), 1 accessory, 2 lit accessory
   * (state colour), 3 joint, 4 lit joint, 5 a front node drawn only when lit, 6 antenna rod, 8 lit-stroke point.
   */
  function Builder(lod, stride) {
    this.v = []; this.lines = []; this.pts = []; this.front = []; this.segs = []; this.n = 0; this.lod = lod; this.s = stride; this.seed = 7;
  }
  Builder.prototype.rnd = function () { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; };
  Builder.prototype.add = function (x, y, z, kind, face, size) { this.v.push(x, y, z, kind, face, this.rnd(), size == null ? 1 : size); return this.n++; };
  Builder.prototype.N = function (n) { return Math.max(3, Math.round(n * this.lod)); };
  Builder.prototype.mesh = function (fn, nu, nv, o) {
    o = o || {}; nu = this.N(nu); nv = this.N(nv);
    var P = [], kind = o.kind != null ? o.kind : 1;
    for (var i = 0; i <= nu; i++) { P[i] = []; for (var j = 0; j <= nv; j++) { var q = fn(i / nu, j / nv); P[i][j] = this.add(q[0], q[1], q[2], kind, -1, 1); if (o.nodes !== false) this.pts.push(P[i][j]); } }
    for (i = 0; i <= nu; i++) for (j = 0; j <= nv; j++) {
      var a = P[i][j], b = i < nu ? P[i + 1][j] : o.closeU ? P[0][j] : -1;
      if (b >= 0) this.lines.push(a, b);
      if (j < nv) this.lines.push(a, P[i][j + 1]);
    }
  };
  Builder.prototype.poly = function (pts, lit, js) {
    var prev = -1;
    for (var i = 0; i < pts.length; i++) {
      var q = pts[i], v = this.add(q[0], q[1], q[2], lit ? 2 : 6, -1, 1);
      if (prev >= 0) this.lines.push(prev, v);
      prev = v;
      if (i > 0) this.pts.push(this.add(q[0], q[1], q[2], lit ? 4 : 3, -1, js || 7));
    }
  };
  Builder.prototype.head = function (p, ax, ay) {
    var s = this.s;
    for (var fi = 0; fi < 6; fi++) {
      var GG = fi === 0 ? G : Math.round(G / s), st = fi === 0 ? s : 1, idx = [];
      for (var i = 0; i <= GG; i++) {
        idx[i] = [];
        for (var j = 0; j <= GG; j++) {
          var a = i / GG * 2 - 1, b = j / GG * 2 - 1, x, y, z;
          if (fi === 0) { x = a; y = b; z = 1; } else if (fi === 1) { x = 1; y = b; z = -a; } else if (fi === 2) { x = -1; y = b; z = a; }
          else if (fi === 3) { x = a; y = 1; z = -b; } else if (fi === 4) { x = a; y = -1; z = b; } else { x = -a; y = b; z = -1; }
          var k = Math.pow(Math.pow(Math.abs(x), p) + Math.pow(Math.abs(y), p) + Math.pow(Math.abs(z), p), -1 / p);
          var lat = i % st === 0 && j % st === 0, face = fi === 0 ? (G - j) * GN + i : -1;
          var vi = this.add(x * k * ax, y * k * ay, z * k, lat ? 0 : 5, face, 1);
          idx[i][j] = vi;
          if (lat) this.pts.push(vi);
          if (fi === 0) this.front.push(vi);
        }
      }
      for (i = 0; i <= GG; i++) for (j = 0; j <= GG; j++) {
        if (i % st || j % st) continue;
        if (i + st <= GG) this.lines.push(idx[i][j], idx[i + st][j]);
        if (j + st <= GG) this.lines.push(idx[i][j], idx[i][j + st]);
      }
      // the lit strokes run along the face grid's edges: every edge on a large head, the coarse (every other node) grid on a small one
      if (fi === 0) for (i = 0; i <= GG; i += st) for (j = 0; j <= GG; j += st) {
        if (i + st <= GG) this.segs.push(idx[i][j], idx[i + st][j]);
        if (j + st <= GG) this.segs.push(idx[i][j], idx[i][j + st]);
      }
    }
  };
  /* accessories (the mockup's, verbatim in shape) */
  function torusArc(g, c, R0, R1, t0, t1, plane, tube, nu, nv) {
    g.mesh(function (u, v) {
      var t = t0 + (t1 - t0) * u, w = v * 2 * PI, px_ = Math.cos(t) * R0, py = Math.sin(t) * R1, nx = Math.cos(t), ny = Math.sin(t);
      var o0 = nx * Math.cos(w) * tube, o1 = ny * Math.cos(w) * tube, o2 = Math.sin(w) * tube;
      return plane === "xz" ? [c[0] + px_ + o0, c[1] + o2, c[2] + py + o1] : [c[0] + px_ + o0, c[1] + py + o1, c[2] + o2];
    }, nu || 60, nv || 8);
  }
  function cup(g, x, y, side) {
    var r = 0.36, len = 0.2, z = 0;
    g.mesh(function (u, v) { var a = u * 2 * PI; return [x + side * v * len, y + Math.sin(a) * r, z + Math.cos(a) * r]; }, 40, 4, { closeU: false });
    g.mesh(function (u, v) { var a = u * 2 * PI, rr = r * (1 - v * 0.95); return [x + side * len, y + Math.sin(a) * rr, z + Math.cos(a) * rr]; }, 40, 6);
    g.mesh(function (u, v) { var a = u * 2 * PI; return [x + side * (len + 0.06 * Math.sin(v * PI)), y + Math.sin(a) * r * (0.55 + 0.1 * v), z + Math.cos(a) * r * (0.55 + 0.1 * v)]; }, 40, 3);
  }
  var ACC = {
    headphones: function (g, ax, ay) { torusArc(g, [0, ay * 0.05, 0], ax * 1.12, ay * 1.18, 0.05, PI - 0.05, "xy", 0.07); cup(g, ax, 0, 1); cup(g, -ax, 0, -1); },
    cap: function (g, ax, ay) {
      g.mesh(function (u, v) { var a = u * 2 * PI, b = v * PI / 2 * 0.92, rr = Math.cos(b); return [Math.cos(a) * ax * 1.06 * rr, ay * 0.42 + Math.sin(b) * ay * 0.78, Math.sin(a) * 1.06 * rr]; }, 44, 10);
      g.mesh(function (u, v) { var a = -1.15 + 2.3 * u, s = 1.0 + 0.55 * v; return [Math.sin(a) * ax * s * 1.02, ay * 0.45 - 0.12 * v * v, Math.cos(a) * s]; }, 30, 6);
    },
    beanie: function (g, ax, ay) {
      g.mesh(function (u, v) { var a = u * 2 * PI, b = v * PI / 2, rr = Math.cos(b); return [Math.cos(a) * ax * 1.06 * rr, ay * 0.35 + Math.sin(b) * ay * 0.9, Math.sin(a) * 1.06 * rr]; }, 44, 12);
      g.mesh(function (u, v) { var a = u * 2 * PI; return [Math.cos(a) * ax * 1.1, ay * 0.3 + v * 0.22, Math.sin(a) * 1.1]; }, 44, 3);
      g.mesh(function (u, v) { var a = u * 2 * PI, b = v * PI; return [Math.cos(a) * Math.sin(b) * 0.16, ay * 1.32 + Math.cos(b) * 0.16, Math.sin(a) * Math.sin(b) * 0.16]; }, 16, 8);
    },
    ant1: function (g, ax, ay) { g.poly([[0.35, ay * 1.18, 0], [0.55, ay * 1.75, -0.1], [0.95, ay * 1.45, -0.1], [1.25, ay * 2.0, -0.2]], false); },
    ant2: function (g, ax, ay) { g.poly([[-0.4, ay * 1.0, 0], [-0.6, ay * 1.6, -0.1], [-0.85, ay * 1.95, -0.1]], true); g.poly([[0.4, ay * 1.0, 0], [0.6, ay * 1.6, -0.1], [0.85, ay * 1.95, -0.1]], true); },
    ears: function (g, ax, ay) { [-1, 1].forEach(function (s) { g.mesh(function (u, v) { var a = u * 2 * PI, rr = (1 - v) * 0.32; return [s * (ax * 0.55) + Math.cos(a) * rr * 1.1 + s * v * 0.12, ay * 0.75 + v * 0.75, Math.sin(a) * rr * 0.6]; }, 14, 6); }); },
    goggles: function (g, ax, ay) { [-1, 1].forEach(function (s) { torusArc(g, [s * 0.42, ay * 0.8, 0.72], 0.3, 0.3, 0, 2 * PI, "xy", 0.07, 40); }); torusArc(g, [0, ay * 0.8, 0], ax * 1.05, 1.05, -0.1, PI + 0.1, "xz", 0.04, 50); },
    mic: function (g, ax, ay) {
      g.poly([[-ax * 1.15, 0, 0.15], [-ax * 1.05, -0.45, 0.7], [-ax * 0.6, -0.62, 1.05], [-ax * 0.3, -0.62, 1.12]], false);
      g.mesh(function (u, v) { var a = u * 2 * PI, b = v * PI; return [-ax * 0.22 + Math.cos(a) * Math.sin(b) * 0.1, -0.62 + Math.cos(b) * 0.1, 1.14 + Math.sin(a) * Math.sin(b) * 0.1]; }, 14, 8, { kind: 2 });
    },
    halo: function (g, ax, ay) { torusArc(g, [0, ay * 1.4, 0], ax * 0.85, 0.85, 0, 2 * PI, "xz", 0.06, 60); },
    mortar: function (g, ax, ay) {
      g.mesh(function (u, v) { return [(-1 + 2 * u) * ax * 1.25, ay * 1.18, (-1 + 2 * v) * 1.15]; }, 14, 14);
      g.mesh(function (u, v) { var a = u * 2 * PI; return [Math.cos(a) * ax * 0.85, ay * 0.55 + v * 0.62, Math.sin(a) * 0.85]; }, 40, 5);
      g.poly([[0, ay * 1.2, 0], [ax * 0.95, ay * 1.18, 0.6], [ax * 1.05, ay * 0.55, 0.75]], true);
    },
    bow: function (g, ax, ay) { [-1, 1].forEach(function (s) { g.mesh(function (u, v) { var a = -1 + 2 * u; return [s * (0.08 + 0.38 * v), -ay * 1.08 + a * (0.08 + 0.22 * v), 1.0 - 0.1 * v]; }, 6, 6); }); },
  };
  var geoCache = {};
  /** The head's buffers. detail "hi": every grid line, the lit strokes; "lo" (sessions, the dock): every other line, half the accessory rings. */
  function build(head, detail) {
    head = HEADS[head] ? head : "cap";
    var key = head + ":" + detail;
    if (geoCache[key]) return geoCache[key];
    var hi = detail === "hi", cfg = HEADS[head], g = new Builder(hi ? 1 : 0.5, hi ? 1 : 2), ax = 1, ay = 0.98;
    g.head(cfg.p, ax, ay);
    cfg.acc.forEach(function (a) { ACC[a](g, ax, ay); });
    // the lit strokes: points along each front grid edge, lit where both its ends are (the mockup's 3 px lit lines)
    var sp = [], K = hi ? 4 : 3, V = g.v;
    for (var i = 0; i < g.segs.length; i += 2) {
      var A = g.segs[i] * 7, Bv = g.segs[i + 1] * 7;
      for (var k = 1; k <= K; k++) {
        var t = k / (K + 1);
        sp.push(V[A] + (V[Bv] - V[A]) * t, V[A + 1] + (V[Bv + 1] - V[A + 1]) * t, V[A + 2] + (V[Bv + 2] - V[A + 2]) * t, 8, V[A + 4], (i * 0.618 + k * 0.31) % 1, V[Bv + 4]);
      }
    }
    var out = { head: head, cfg: cfg, v: new Float32Array(g.v), lines: new Uint16Array(g.lines), pts: new Uint16Array(g.pts), front: new Uint16Array(g.front), seg: new Float32Array(sp), n: g.n };
    geoCache[key] = out;
    return out;
  }

  /* ------------------------------------------------------------ colours */
  var DEF = {
    dark: { ready: [0, 230, 165], listening: [56, 214, 255], thinking: [150, 110, 255], speaking: [255, 90, 200], needs: [255, 190, 60], error: [255, 80, 80], wire: [225, 232, 248], wireK: 1, rim: [[56, 214, 255], [150, 110, 255]], rimL: [109, 43, 200] },
    light: { ready: [0, 120, 90], listening: [0, 110, 170], thinking: [109, 43, 200], speaking: [190, 30, 140], needs: [180, 105, 0], error: [200, 30, 30], wire: [38, 46, 64], wireK: 1, rim: [[56, 214, 255], [150, 110, 255]], rimL: [109, 43, 200] },
  };
  function logic() { return typeof window !== "undefined" && window.MintLogic ? window.MintLogic : null; }
  function palettes(colors) {
    var L = logic();
    if (L && L.botPalette) return { dark: L.botPalette(colors, false), light: L.botPalette(colors, true) };
    return { dark: DEF.dark, light: DEF.light };
  }
  function sessState(k) {
    var L = logic();
    if (L && L.botSessState) return L.botSessState(k);
    if (k.st === "waiting") return { state: "needs", face: "pupils" };
    if (k.st === "working") return { state: "thinking", face: "focus" };
    return { state: "ready", face: "base" };
  }
  var FACE_OF = {
    idle: { state: "ready", face: "base" }, listening: { state: "listening", face: "listen" }, thinking: { state: "thinking", face: "focus" },
    delegating: { state: "thinking", face: "base" }, speaking: { state: "speaking", face: "speak" }, needs: { state: "needs", face: "pupils" }, error: { state: "error", face: "err" },
  };
  function coreFace(st, offline) { return offline ? FACE_OF.error : FACE_OF[st] || FACE_OF.idle; }

  /* ------------------------------------------------------------ one head's life: face, colour, blink, glance */
  function Anim(seed) {
    this.face = "base"; this.prev = "base"; this.fk = 1;
    this.col = "ready"; this.pcol = [0, 0, 0]; this.ck = 1; this.rgb = [0, 0, 0];
    var s = seed || 1;
    this.r = function () { s = (s * 16807) % 2147483647; return s / 2147483647; };
    this.blinkAt = 1.5 + this.r() * 3; this.blinkP = -1; this.glanceAt = 4 + this.r() * 4; this.glanceUntil = 0;
    this.gx = 0; this.gy = 0; this.gxT = 0; this.gyT = 0; this.ph = this.r() * 6.28; this.t = 0; this.seen = 0; this.fresh = true; this.lid = 1;
  }
  Anim.prototype.set = function (face, col) {
    if (this.fresh) { this.fresh = false; this.face = this.prev = face; this.col = col; this.fk = this.ck = 1; this.pcol[0] = -1; return; }
    if (face !== this.face) {
      if (face === this.prev) { this.prev = this.face; this.face = face; this.fk = 1 - this.fk; } // straight back: reverse the fade, no jump
      else { if (this.fk >= 0.5) this.prev = this.face; this.face = face; this.fk = 0; }
    }
    if (col !== this.col) { this.pcol[0] = this.rgb[0]; this.pcol[1] = this.rgb[1]; this.pcol[2] = this.rgb[2]; this.col = col; this.ck = 0; }
  };
  Anim.prototype.step = function (dt, calm, idle) {
    this.t += dt;
    this.fk = Math.min(1, this.fk + dt / 0.25); this.ck = Math.min(1, this.ck + dt / 0.3);
    if (calm) { this.blinkP = -1; } else {
      if (this.blinkP >= 0) { this.blinkP += dt / 0.16; if (this.blinkP >= 1) { this.blinkP = -1; this.blinkAt = this.t + 3 + this.r() * 3; } }
      else if (this.t > this.blinkAt) this.blinkP = 0;
      if (idle && this.t > this.glanceAt) { this.glanceAt = this.t + 4 + this.r() * 5; this.glanceUntil = this.t + 0.7 + this.r() * 0.6; this.glx = this.r() < 0.5 ? -1.6 : 1.6; this.gly = this.r() < 0.3 ? -1 : 0; }
    }
  };
  Anim.prototype.blink = function () { var b = this.blinkP < 0 ? 1 : 1 - 0.95 * Math.sin(Math.min(1, this.blinkP) * PI); return b < this.lid ? b : this.lid; };
  Anim.prototype.settle = function () { this.fk = 1; this.ck = 1; this.blinkP = -1; this.gx = this.gxT; this.gy = this.gyT; };
  Anim.prototype.color = function (pal) {
    var c = pal[this.col] || pal.ready, k = this.ck * this.ck * (3 - 2 * this.ck);
    if (this.pcol[0] < 0) k = 1; // a fresh head: its colour at once
    this.rgb[0] = this.pcol[0] + (c[0] - this.pcol[0]) * k; this.rgb[1] = this.pcol[1] + (c[1] - this.pcol[1]) * k; this.rgb[2] = this.pcol[2] + (c[2] - this.pcol[2]) * k;
    return this.rgb;
  };
  /** Fill one row of face weights (0..255, 361 nodes) from the anim's faces, cross-faded. */
  var FW = new Float32Array(NF); // one head's full-resolution weights, before a small head's coarse grid (reused)
  /**
   * coarse (a small head: a session, the dock): the face is drawn on every other node only, each node lit
   * by the brightest of the 2 x 2 face pixels it stands for -- eyes and mouth become a few clear pixels
   * instead of a blur of 2-px dots.
   */
  function weights(an, out, off, amp, coarse, vm) {
    if (coarse) {
      weights(an, FW, -1, amp, false, vm);
      for (var rr = 0; rr < GN; rr++) for (var cc = 0; cc < GN; cc++) {
        var v = 0;
        if (!(rr & 1) && !(cc & 1)) {
          v = FW[rr * GN + cc];
          if (rr + 1 < GN) v = Math.max(v, FW[(rr + 1) * GN + cc]);
          if (cc + 1 < GN) v = Math.max(v, FW[rr * GN + cc + 1]);
          if (rr + 1 < GN && cc + 1 < GN) v = Math.max(v, FW[(rr + 1) * GN + cc + 1]);
        }
        out[off + rr * GN + cc] = (v * 255 + 0.5) | 0;
      }
      return;
    }
    var A = FACES[an.face] || FACES.base, P = FACES[an.prev] || FACES.base, k = an.fk * an.fk * (3 - 2 * an.fk), s = an.blink();
    var gx = an.gx, g0 = Math.floor(gx), gf = gx - g0, gy = Math.round(an.gy), t = an.t;
    for (var r = 0; r < GN; r++) for (var c = 0; c < GN; c++) {
      var a = faceAt(A, r, c, g0, gy, s, amp, t, vm);
      if (gf > 0.01) a = a * (1 - gf) + faceAt(A, r, c, g0 + 1, gy, s, amp, t, vm) * gf;
      var w = a;
      if (k < 1) {
        var b = faceAt(P, r, c, g0, gy, s, amp, t, vm);
        if (gf > 0.01) b = b * (1 - gf) + faceAt(P, r, c, g0 + 1, gy, s, amp, t, vm) * gf;
        w = b + (a - b) * k;
      }
      if (off < 0) out[r * GN + c] = w; else out[off + r * GN + c] = (w * 255 + 0.5) | 0;
    }
  }

  /* ------------------------------------------------------------ shaders */
  var WIRE_VS = [
    "#version 300 es",
    "precision highp float;",
    "layout(location=0) in vec3 a_p; layout(location=1) in vec4 a_i;",
    "uniform vec2 u_res,u_c,u_home; uniform vec3 u_wire,u_st; uniform sampler2D u_wt;",
    "uniform float u_r,u_fs,u_sc,u_yaw,u_tilt,u_form,u_dis,u_row,u_wa,u_lit,u_alpha,u_mode,u_psz,u_jsz,u_lsz,u_gsz,u_shimX,u_shimA,u_maxPt,u_snap,u_segK;",
    "out vec4 v_c; out float v_j;",
    "float wt(float f){ if(f<0.0) return 0.0; return texelFetch(u_wt,ivec2(int(f+0.5),int(u_row+0.5)),0).r; }",
    "float h1(float n){ return fract(sin(n*91.7+7.3)*43758.5453); }",
    "void main(){",
    " int kind=int(a_i.x+0.5); float rnd=a_i.z; vec3 p=a_p;",
    " float cy=cos(u_yaw),sy=sin(u_yaw),ct=cos(u_tilt),st=sin(u_tilt);",
    " float x1=p.x*cy+p.z*sy, z1=-p.x*sy+p.z*cy; float y2=p.y*ct-z1*st, z2=z1*ct+p.y*st;",
    " vec2 px=u_c+vec2(x1,y2)*u_r*u_sc;",
    " if(u_form<1.0){ float pp=clamp((u_form-rnd*0.45)/0.55,0.0,1.0); pp=pp*pp*(3.0-2.0*pp); vec2 m=(u_home+px)*0.5+vec2(rnd-0.5,h1(rnd)-0.5)*u_r*3.0; float u=1.0-pp; px=u*u*u_home+2.0*u*pp*m+pp*pp*px; }",
    " if(u_dis>0.0){ float q=clamp((u_dis-rnd*0.4)/0.6,0.0,1.0); q=q*q*(3.0-2.0*q); vec2 m=(u_home+px)*0.5+vec2(h1(rnd)-0.5,rnd-0.5)*u_r*4.0*sin(q*3.14159); float u=1.0-q; px=u*u*px+2.0*u*q*m+q*q*u_home; }",
    " float d=clamp((z2+1.0)*0.5,0.0,1.0);",
    " float vis=(kind==0||kind==5||kind==8)?smoothstep(-0.03,0.07,z2):1.0;",
    " float sh=u_shimA*exp(-pow((p.x-u_shimX)/0.22,2.0))*(0.6+0.4*rnd);",
    " vec3 col=u_wire; float a=0.0, size=1.0; v_j=0.0;",
    " if(u_mode<0.5){",                                             // the wireframe
    "  a=(0.05+0.28*d*d)*u_wa; if(kind==6) a=0.55*u_wa;",
    "  if(kind==2||kind==4){ col=u_st; a=0.9*u_lit; }",
    "  a+=sh*0.3; col=mix(col,u_st,clamp(sh,0.0,1.0)*0.6);",
    "  a*=smoothstep(0.95,1.0,u_form)*(1.0-smoothstep(0.0,0.1,u_dis));",
    " } else if(u_mode<1.5){",                                      // the grid nodes (and joints)
    "  float w=wt(a_i.y);",
    "  a=(0.08+0.35*d*d)*u_wa*1.2*(1.0-w); size=(0.6+1.7*d)*u_psz;",
    "  if(kind==5) a=0.0;",
    "  if(kind==3){ a=0.8*min(1.0,u_wa); size=u_jsz; v_j=1.0; }",
    "  if(kind==4){ col=u_st; a=u_lit; size=u_jsz*0.85; }",
    "  if(kind==2){ col=u_st; a=0.6*u_lit; }",
    "  a+=sh*0.6*(1.0-w); col=mix(col,u_st,clamp(sh,0.0,1.0)*0.7); size*=1.0+sh*0.7;",
    " } else if(u_mode<2.5){ float w=wt(a_i.y); a=w*u_lit; size=u_lsz; col=u_st; }",          // the lit face
    " else if(u_mode<3.5){ float w=min(wt(a_i.y),wt(a_i.w)); a=w*u_lit*0.95; size=u_lsz*u_segK; col=u_st; }", // its lit strokes
    " else { float w=wt(a_i.y); a=w*u_lit; size=u_gsz; col=u_st; }",                         // its glow (quarter resolution)
    " a*=vis*u_alpha;",
    " if(u_form<1.0) a*=0.4+0.6*u_form;",
    " if(u_dis>0.0) a*=1.0-u_dis*0.85;",
    " v_c=vec4(col,clamp(a,0.0,1.0));",
    " px*=u_fs;",
    " gl_Position=(u_mode>0.5&&a<=0.003)?vec4(2.0,2.0,0.0,1.0):vec4(px/u_res*2.0-1.0,0.0,1.0);",
    " size=clamp(size*u_fs,1.0,u_maxPt);",
    // a small head's face: whole device pixels, on the pixel grid (odd sizes on pixel centres, even on corners)
    " if(u_snap>0.5&&(u_mode>1.5&&u_mode<3.5)){ size=max(2.0,floor(size+0.5)); vec2 q=floor(px); px=mod(size,2.0)>0.5?q+0.5:floor(px+0.5); gl_Position=a<=0.003?vec4(2.0,2.0,0.0,1.0):vec4(px/u_res*2.0-1.0,0.0,1.0); }",
    " gl_PointSize=size;",
    "}",
  ].join("\n");
  var WIRE_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec4 v_c; in float v_j; uniform float u_pt,u_soft,u_sq,u_mode; out vec4 o;",
    "void main(){ float a=v_c.a; vec3 c=v_c.rgb;",
    " if(u_pt>0.5&&!(u_sq>0.5&&u_mode>1.5&&u_mode<3.5)){ vec2 q=gl_PointCoord*2.0-1.0; float r2=dot(q,q); if(r2>1.0) discard;",
    "  a*=u_soft>0.5?exp(-r2*3.2):smoothstep(1.0,0.55,r2);",
    "  if(v_j>0.5&&r2<0.42){ c=vec3(1.0); a=max(a,0.9*v_c.a); } }",
    " o=vec4(c*a,a); }",
  ].join("\n");
  var QUAD_VS = [
    "#version 300 es",
    "uniform vec4 u_box; uniform vec2 u_res;",
    "void main(){ int i=gl_VertexID; vec2 c=vec2((i==1||i==4||i==5)?1.0:0.0,(i==2||i==3||i==5)?1.0:0.0);",
    " vec2 p=mix(u_box.xy,u_box.zw,c); gl_Position=vec4(p/u_res*2.0-1.0,0.0,1.0); }",
  ].join("\n");
  var QUAD_FS = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 u_c,u_so; uniform float u_r,u_rimK,u_stK; uniform vec3 u_rA,u_rB,u_st; out vec4 o;",
    "void main(){ vec2 d=(gl_FragCoord.xy-u_c)/u_r; float L=length(d);",
    " float rim=u_rimK*(1.0-smoothstep(0.45,1.6,L)); vec3 rc=mix(u_rA,u_rB,clamp(d.x*0.45+0.5,0.0,1.0));",
    " float sg=u_stK*(1.0-smoothstep(0.15,1.05,length(d-u_so)));",
    " o=vec4(rc*rim+u_st*sg,rim+sg-rim*sg); }",
  ].join("\n");
  var COMP_VS = "#version 300 es\nvoid main(){ int i=gl_VertexID; vec2 p=vec2(i==1?3.0:-1.0,i==2?3.0:-1.0); gl_Position=vec4(p,0.0,1.0); }";
  var COMP_FS = [
    "#version 300 es",
    "precision highp float;",
    "uniform sampler2D u_tex; uniform vec2 u_res,u_tx; uniform float u_k; out vec4 o;",
    "void main(){ vec2 uv=gl_FragCoord.xy/u_res;",
    " vec4 c=texture(u_tex,uv+vec2(-0.75,-0.75)*u_tx)+texture(u_tex,uv+vec2(0.75,-0.75)*u_tx)+texture(u_tex,uv+vec2(-0.75,0.75)*u_tx)+texture(u_tex,uv+vec2(0.75,0.75)*u_tx);",
    " c*=0.25; o=vec4(c.rgb,c.a*u_k); }",
  ].join("\n");
  /* the desktop's contrast backplate: a soft disc of one colour, full to 45 % of its radius, gone at its edge */
  var PLATE_FS = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 u_c; uniform float u_r; uniform vec4 u_col; out vec4 o;",
    "void main(){ float L=length(gl_FragCoord.xy-u_c)/u_r; float a=u_col.a*(1.0-smoothstep(0.45,1.0,L)); o=vec4(u_col.rgb*a,a); }",
  ].join("\n");
  var PLATE = { dark: [8, 11, 18], light: [250, 251, 253], aDark: 0.76, aLight: 0.72, core: 1.8, kid: 1.7 };
  var STREAM_VS = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 u_res,u_c,u_dest; uniform float u_r,u_bead,u_deleg,u_psz; uniform vec3 u_st;",
    "out vec4 v_c; out float v_j;",
    "vec4 h4(float n){ return fract(sin(vec4(n*12.9898,n*78.233,n*37.719,n*93.989))*43758.5453); }",
    "void main(){ vec4 h=h4(float(gl_VertexID)+333.0); float s=fract(u_bead*(0.85+0.3*h.x)+h.y); float e=s*s*(3.0-2.0*s);",
    " vec2 dv0=u_dest-u_c; float L=max(length(dv0),1.0); vec2 dir=dv0/L;",
    " vec2 P0=u_c+dir*u_r*0.9+(h.zw-0.5)*u_r*0.5; vec2 P2=u_dest+(h.zw-0.5)*max(u_r*0.12,6.0);",
    " vec2 dv=P2-P0; vec2 pr=vec2(-dv.y,dv.x); vec2 P1=(P0+P2)*0.5+pr*(0.16+0.1*(h.w-0.5)); float q=1.0-e;",
    " vec2 px=q*q*P0+2.0*q*e*P1+e*e*P2;",
    " float a=u_deleg*u_deleg*pow(sin(3.14159*s),0.5)*(0.5+0.5*h.z)*1.6;",
    " v_c=vec4(mix(u_st,vec3(1.0),0.2*e),clamp(a,0.0,1.0)); v_j=0.0;",
    " gl_Position=a<0.003?vec4(2.0,2.0,0.0,1.0):vec4(px/u_res*2.0-1.0,0.0,1.0); gl_PointSize=u_psz*(0.9+1.2*h.w); }",
  ].join("\n");

  /* the dozing "z z z": 21 square dots (three z's of seven, zDot's twin), rising up and to the right of the head */
  var ZZZ_VS = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 u_res,u_c; uniform float u_r,u_t,u_k,u_psz; uniform vec3 u_st;",
    "out vec4 v_c; out float v_j;",
    "const float ZD[20]=float[20](-1.5,1.5,-0.5,1.5,0.5,1.5,1.5,1.5,0.5,0.5,-0.5,-0.5,-1.5,-1.5,-0.5,-1.5,0.5,-1.5,1.5,-1.5);",
    "void main(){ int i=gl_VertexID; int zi=i/10; int d=i-zi*10; float p=fract(u_t/3.6+float(zi)/3.0); float s=0.038+0.03*p;",
    " vec2 q=vec2(-0.98-0.36*p+0.05*sin(u_t*1.3+float(zi)*2.1)+ZD[d*2]*s, 0.55+0.95*p+ZD[d*2+1]*s);",
    " float a=u_k*sin(3.14159*p); v_c=vec4(u_st,clamp(a,0.0,1.0)); v_j=0.0;",
    " vec2 px=u_c+q*u_r; gl_Position=a<0.003?vec4(2.0,2.0,0.0,1.0):vec4(px/u_res*2.0-1.0,0.0,1.0); gl_PointSize=max(2.0,floor(u_psz*(0.55+0.6*p)+0.5)); }",
  ].join("\n");

  /* ------------------------------------------------------------ Canvas 2D (the fallback, and the thumbnails) */
  var spriteCache = {};
  function glowSprite(rgb) {
    var key = (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0);
    if (spriteCache[key]) return spriteCache[key];
    var c = document.createElement("canvas"); c.width = c.height = 64;
    var g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(" + key + ",1)"); gr.addColorStop(0.35, "rgba(" + key + ",0.45)"); gr.addColorStop(1, "rgba(" + key + ",0)");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    var keys = Object.keys(spriteCache); if (keys.length > 24) delete spriteCache[keys[0]];
    spriteCache[key] = c;
    return c;
  }
  function rgba(c, a) { return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")"; }
  var P2 = null; // projected positions, reused
  /**
   * One head on a 2D context (CSS px, y down): o = { geo, cx, cy, r, yaw, tilt, sc, wire, st, wa, lit, alpha, w (Uint8Array),
   * off, light, rimA, rimB, rimL, rimK, stK, form, dis, homeX, homeY, shimX, shimA, dpr }.
   */
  function draw2dHead(g, o) {
    var geo = o.geo, V = geo.v, n = geo.n;
    if (!P2 || P2.length < n * 3) P2 = new Float32Array(Math.max(n * 3, 16384));
    var cyw = Math.cos(o.yaw), syw = Math.sin(o.yaw), ct = Math.cos(o.tilt), stt = Math.sin(o.tilt), R = o.r * o.sc;
    for (var i = 0; i < n; i++) {
      var b = i * 7, x = V[b], y = V[b + 1], z = V[b + 2];
      var x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw, y2 = y * ct - z1 * stt, z2 = z1 * ct + y * stt;
      var X = o.cx + x1 * R, Y = o.cy - y2 * R;
      if (o.form < 1 || o.dis > 0) {
        var rn = V[b + 5], p, u;
        if (o.form < 1) { p = Math.max(0, Math.min(1, (o.form - rn * 0.45) / 0.55)); p = p * p * (3 - 2 * p); u = 1 - p; X = u * u * o.homeX + 2 * u * p * (o.homeX + X) / 2 + p * p * X; Y = u * u * o.homeY + 2 * u * p * (o.homeY + Y) / 2 + p * p * Y; }
        if (o.dis > 0) { p = Math.max(0, Math.min(1, (o.dis - rn * 0.4) / 0.6)); p = p * p * (3 - 2 * p); u = 1 - p; X = u * u * X + 2 * u * p * (o.homeX + X) / 2 + p * p * o.homeX; Y = u * u * Y + 2 * u * p * (o.homeY + Y) / 2 + p * p * o.homeY; }
      }
      P2[i * 3] = X; P2[i * 3 + 1] = Y; P2[i * 3 + 2] = z2;
    }
    var fade = o.alpha * (o.form < 1 ? 0.4 + 0.6 * o.form : 1) * (o.dis > 0 ? 1 - o.dis * 0.85 : 1);
    var sst = function (a, b, x) { x = Math.max(0, Math.min(1, (x - a) / (b - a))); return x * x * (3 - 2 * x); };
    var lf = sst(0.95, 1, o.form) * (1 - sst(0, 0.1, o.dis)); // a head forming or dissolving is dots only: its lines would stretch
    var W8 = o.w, off = o.off;
    function wAt(f) { return f < 0 ? 0 : W8[off + f] / 255; }
    // glow behind
    if (o.rimK > 0.001) {
      var gr = g.createRadialGradient(o.cx, o.cy, o.r * 0.2, o.cx, o.cy, o.r * 1.6);
      var rc = o.light ? o.rimL : [(o.rimA[0] + o.rimB[0]) / 2, (o.rimA[1] + o.rimB[1]) / 2, (o.rimA[2] + o.rimB[2]) / 2];
      gr.addColorStop(0, rgba(rc, o.rimK * fade)); gr.addColorStop(0.55, rgba(rc, o.rimK * 0.6 * fade)); gr.addColorStop(1, rgba(rc, 0));
      g.fillStyle = gr; g.fillRect(o.cx - o.r * 1.7, o.cy - o.r * 1.7, o.r * 3.4, o.r * 3.4);
    }
    if (o.stK > 0.001) {
      var sy0 = o.cy + o.r * 0.12, gs = g.createRadialGradient(o.cx, sy0, 0, o.cx, sy0, o.r * 1.05);
      gs.addColorStop(0, rgba(o.st, o.stK * fade)); gs.addColorStop(1, rgba(o.st, 0));
      g.fillStyle = gs; g.fillRect(o.cx - o.r * 1.1, sy0 - o.r * 1.1, o.r * 2.2, o.r * 2.2);
    }
    // the wireframe, in five depth buckets (one stroke each)
    var L = geo.lines;
    g.lineWidth = o.dpr > 1.4 ? 0.6 : 0.8;
    for (var bk = 0; bk < 5; bk++) {
      g.beginPath();
      var any = false;
      for (i = 0; i < L.length; i += 2) {
        var a0 = L[i], b0 = L[i + 1], za = P2[a0 * 3 + 2], zb = P2[b0 * 3 + 2], ka = V[a0 * 7 + 3];
        if (ka === 2 || ka === 6) continue;
        if (ka === 0 && (za < 0 || zb < 0)) continue;
        var d = Math.max(0, Math.min(1, ((za + zb) / 2 + 1) / 2)), bb = Math.min(4, (d * 5) | 0);
        if (bb !== bk) continue;
        g.moveTo(P2[a0 * 3], P2[a0 * 3 + 1]); g.lineTo(P2[b0 * 3], P2[b0 * 3 + 1]); any = true;
      }
      if (!any) continue;
      var dm = (bk + 0.5) / 5;
      g.strokeStyle = rgba(o.wire, (0.05 + 0.28 * dm * dm) * o.wa * 1.25 * fade * lf);
      g.stroke();
    }
    // rods and lit accessory lines
    for (i = 0; i < L.length; i += 2) {
      var k2 = V[L[i] * 7 + 3];
      if (k2 !== 2 && k2 !== 6) continue;
      g.strokeStyle = k2 === 2 ? rgba(o.st, 0.9 * o.lit * fade * lf) : rgba(o.wire, 0.55 * o.wa * fade * lf);
      g.beginPath(); g.moveTo(P2[L[i] * 3], P2[L[i] * 3 + 1]); g.lineTo(P2[L[i + 1] * 3], P2[L[i + 1] * 3 + 1]); g.stroke();
    }
    // nodes
    var Pt = geo.pts, ps = Math.max(0.55, Math.min(1.5, o.r / 120));
    g.fillStyle = rgba(o.wire, 1);
    for (i = 0; i < Pt.length; i++) {
      var vi = Pt[i], kk = V[vi * 7 + 3], z = P2[vi * 3 + 2];
      if ((kk === 0 || kk === 5) && z < 0) continue;
      if (kk === 5) continue;
      var dd = Math.max(0, Math.min(1, (z + 1) / 2)), w = wAt(V[vi * 7 + 4]);
      if (kk === 3 || kk === 4) {
        var jr = 3.6 * ps;
        g.globalAlpha = 1; g.fillStyle = kk === 4 ? rgba(o.st, o.lit * fade) : rgba(o.wire, 0.8 * fade);
        g.beginPath(); g.arc(P2[vi * 3], P2[vi * 3 + 1], jr, 0, 7); g.fill();
        if (kk === 3) { g.fillStyle = "rgba(255,255,255," + (0.85 * fade).toFixed(3) + ")"; g.beginPath(); g.arc(P2[vi * 3], P2[vi * 3 + 1], jr * 0.62, 0, 7); g.fill(); }
        g.fillStyle = rgba(o.wire, 1);
        continue;
      }
      var a = (0.08 + 0.35 * dd * dd) * o.wa * 1.2 * (1 - w) * fade;
      if (kk === 2) { g.fillStyle = rgba(o.st, 0.6 * o.lit * fade); a = 1; }
      if (a < 0.01) continue;
      var sh = o.shimA > 0 ? o.shimA * Math.exp(-Math.pow((V[vi * 7] - o.shimX) / 0.22, 2)) : 0;
      g.globalAlpha = Math.min(1, a + sh * 0.6);
      var sz = (0.6 + 1.7 * dd) * ps * (1 + sh * 0.7);
      g.fillRect(P2[vi * 3] - sz / 2, P2[vi * 3 + 1] - sz / 2, sz, sz);
      if (kk === 2) g.fillStyle = rgba(o.wire, 1);
    }
    g.globalAlpha = 1;
    // the lit face: glow, strokes, dots
    var F = geo.front, lsz = Math.max(o.r < 40 ? 2.4 : 1.5, 0.062 * o.r), spr = glowSprite(o.st), gsz = o.r * (o.r < 40 ? 0.42 : 0.3);
    g.globalAlpha = 1;
    for (i = 0; i < F.length; i++) {
      var fv = F[i], fw = wAt(V[fv * 7 + 4]);
      if (fw < 0.02 || P2[fv * 3 + 2] < -0.03) continue;
      g.globalAlpha = Math.min(1, fw * o.lit * (o.light ? 0.3 : 0.6) * fade);
      g.drawImage(spr, P2[fv * 3] - gsz / 2, P2[fv * 3 + 1] - gsz / 2, gsz, gsz);
    }
    g.globalAlpha = 1;
    var S = geo.seg;
    if (S.length) {
      for (i = 0; i < S.length; i += 7) {
        var sw = Math.min(wAt(S[i + 4]), wAt(S[i + 6]));
        if (sw < 0.02) continue;
        var sx = S[i], syy = S[i + 1], sz2 = S[i + 2];
        var x1s = sx * cyw + sz2 * syw, z1s = -sx * syw + sz2 * cyw, y2s = syy * ct - z1s * stt;
        g.fillStyle = rgba(o.st, sw * o.lit * 0.95 * fade);
        var q = lsz * 0.45;
        g.fillRect(o.cx + x1s * R - q / 2, o.cy - y2s * R - q / 2, q, q);
      }
    }
    for (i = 0; i < F.length; i++) {
      var fv2 = F[i], fw2 = wAt(V[fv2 * 7 + 4]);
      if (fw2 < 0.02 || P2[fv2 * 3 + 2] < -0.03) continue;
      g.fillStyle = rgba(o.st, fw2 * o.lit * fade);
      g.beginPath(); g.arc(P2[fv2 * 3], P2[fv2 * 3 + 1], lsz / 2, 0, 7); g.fill();
    }
  }

  /* ------------------------------------------------------------ the core */
  function synthAmp(t) {
    var phrase = Math.sin(t * 0.9) * 0.5 + 0.5 > 0.18 ? 1 : 0.1, syl = Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1.2));
    return Math.min(1, (0.18 + 0.75 * syl + 0.12 * Math.sin(t * 17.0)) * phrase);
  }
  function synthListen(t) {
    var phrase = Math.sin(t * 0.7 + 2.0) * 0.5 + 0.5 > 0.3 ? 1 : 0.08, syl = Math.abs(Math.sin(t * 5.9 + 0.4) * Math.sin(t * 2.3));
    return Math.min(1, (0.1 + 0.8 * syl) * phrase);
  }
  function beat(t) { var b = (t / 1.8) % 1; return Math.exp(-Math.pow((b - 0.05) / 0.05, 2)) + 0.7 * Math.exp(-Math.pow((b - 0.25) / 0.055, 2)); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

  function create(canvas, opts) {
    opts = opts || {};
    var GLOW = opts.backdrop !== "none";
    var DESK = !!opts.desk; // the desktop app: backplates + a stronger wireframe (see the header)
    var reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var S = {
      concept: "E", state: "idle", amp: 0, ampSlow: 0, t: 0, c: [0, 0], R: 200, light: 0, lightT: 0, dpr: 1, cssW: 0, cssH: 0,
      head: HEADS[opts.head] ? opts.head : "cap", offline: false, bead: 0, arrive: 0,
      desk: DESK, running: false, wanted: false, still: !!(reduceMq && reduceMq.matches), frames: [], gl: false, lowRes: false,
      // expressive (2026-10-20): the mouth's viseme mix, the pointer, a glance, dozing, a reaction
      vis: { closed: 1, open: 0, wide: 0, round: 0 }, ptr: [0, 0], ptrOn: false, near: false, lookK: 0,
      gzUntil: 0, gzAt: null, doze: 0, dozeT: 0, dozeChk: 0, actAt: 0, rk: "", rt: 0, rd: 0,
    };
    var now = opts.now || function () { return Date.now(); };
    var hourOf = opts.hour || function () { return new Date().getHours(); };
    var specFn = opts.spec || null; // () -> { bins: Uint8Array (getByteFrequencyData), hz: Hz per bin } | null
    S.actAt = now();
    var VT = { closed: 1, open: 0, wide: 0, round: 0 }; // this frame's viseme target (reused)
    var ZP = [0, 0, 0, 0];
    var W = {};
    KEYS.forEach(function (k) { W[k] = 0; });
    var colors = opts.colors || null, PAL = palettes(colors), pal = { wire: [0, 0, 0], rim: [[0, 0, 0], [0, 0, 0]], rimL: [0, 0, 0] };
    var ampFn = opts.amp || null, destFn = opts.dest || null, onFrame = opts.onFrame || null, lastSize = null;
    var gl = null, ctx = null, raf = 0, last = 0;
    var progW = null, progQ = null, progC = null, progS = null, progP = null, progZ = null, emptyVao = null, wtTex = null, fbo = null, fboTex = null, fboW = 0, fboH = 0, maxPt = 64;
    var W8 = new Uint8Array(NF * ROWS);
    var coreAnim = new Anim(11), kidAnims = {}, kidSeen = 0;
    var geos = {}; // detail -> { geo, vao, vbo, ibL, ibP, ibF, segVao, segN }

    /* ---------------- GL setup */
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "compile");
      return s;
    }
    function prog(vs, fs) {
      var p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
      var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < n; i++) { var a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
      return { p: p, u: u };
    }
    function initGL() {
      if (opts.force2d) return false;
      try {
        gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: !!opts.preserve });
        if (!gl) return false;
        progW = prog(WIRE_VS, WIRE_FS); progQ = prog(QUAD_VS, QUAD_FS); progC = prog(COMP_VS, COMP_FS); progS = prog(STREAM_VS, WIRE_FS); progP = prog(QUAD_VS, PLATE_FS); progZ = prog(ZZZ_VS, WIRE_FS);
        emptyVao = gl.createVertexArray();
        var range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
        maxPt = range && range[1] ? range[1] : 64;
        wtTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, wtTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, NF, ROWS);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return true;
      } catch (e) {
        if (window.console) console.warn("[core E] WebGL2 unavailable, drawing in 2D:", e && e.message);
        gl = null;
        if (canvas.parentNode) { var fresh = canvas.cloneNode(false); canvas.parentNode.replaceChild(fresh, canvas); canvas = fresh; }
        return false;
      }
    }
    function geoFor(head, detail) {
      var key = head + ":" + detail;
      if (geos[key]) return geos[key];
      var geo = build(head, detail), o = { geo: geo };
      if (gl) {
        o.vao = gl.createVertexArray(); gl.bindVertexArray(o.vao);
        o.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, o.vbo); gl.bufferData(gl.ARRAY_BUFFER, geo.v, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
        o.ibL = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibL); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.lines, gl.STATIC_DRAW);
        o.ibP = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibP); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.pts, gl.STATIC_DRAW);
        o.ibF = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibF); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.front, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        o.segN = geo.seg.length / 7;
        if (o.segN) {
          o.segVao = gl.createVertexArray(); gl.bindVertexArray(o.segVao);
          o.segVbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, o.segVbo); gl.bufferData(gl.ARRAY_BUFFER, geo.seg, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
          gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
          gl.bindVertexArray(null);
        }
      }
      geos[key] = o;
      return o;
    }
    function freeGeos() {
      if (gl) Object.keys(geos).forEach(function (k) {
        var o = geos[k];
        [o.vbo, o.ibL, o.ibP, o.ibF, o.segVbo].forEach(function (b) { if (b) gl.deleteBuffer(b); });
        if (o.vao) gl.deleteVertexArray(o.vao); if (o.segVao) gl.deleteVertexArray(o.segVao);
      });
      geos = {};
    }
    function ensureFbo() {
      var w = Math.max(1, Math.ceil(canvas.width / 4)), h = Math.max(1, Math.ceil(canvas.height / 4));
      if (fbo && w === fboW && h === fboH) return;
      if (fboTex) gl.deleteTexture(fboTex);
      if (!fbo) fbo = gl.createFramebuffer();
      fboTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      fboW = w; fboH = h;
    }

    /* ---------------- per frame: the heads to draw (no allocation: a fixed pool) */
    var POOL = [];
    for (var pi = 0; pi < MAXK + 1; pi++) POOL.push({ cx: 0, cy: 0, r: 0, yaw: 0, tilt: 0, sc: 1, st: [0, 0, 0], wa: 1, lit: 1, alpha: 1, row: 0, form: 1, dis: 0, rimK: 0, stK: 0, shimX: 0, shimA: 0, detail: "hi", head: "cap", glowK: 1, cssR: 0 });
    var nHeads = 0;
    function mixPal() {
      var a = PAL.dark, b = PAL.light, k = S.light;
      ["ready", "listening", "thinking", "speaking", "needs", "error", "wire"].forEach(function (key) {
        if (!pal[key]) pal[key] = [0, 0, 0];
        for (var i = 0; i < 3; i++) pal[key][i] = a[key][i] + (b[key][i] - a[key][i]) * k;
      });
      for (var i = 0; i < 3; i++) { pal.rim[0][i] = a.rim[0][i]; pal.rim[1][i] = a.rim[1][i]; pal.rimL[i] = b.rimL[i]; }
      pal.wireK = a.wireK + (b.wireK - a.wireK) * k;
    }
    function detailFor(cssR) { return cssR >= 60 ? "hi" : "lo"; }
    function headR() { return S.R / S.dpr * 0.57; }
    /** Where the core's head is, in CSS px (y down). */
    function coreCss() { return [S.c[0] / S.dpr, S.cssH - S.c[1] / S.dpr + S.R / S.dpr * 0.12]; }
    function prepare(dt) {
      mixPal();
      nHeads = 0;
      var dpr = S.dpr, cc = coreCss(), rc = headR(), cfg = HEADS[S.head];
      var M = 1 - W.err; // offline: still
      var dz = S.doze, awake = 1 - dz;
      // the core: its state's face, unless a reaction or dozing shows over it
      var fo = pickFace(S.state, S.offline, S.rk, dz);
      var an = coreAnim;
      an.set(fo.face, fo.state);
      an.lid = S.rk === "surprise" ? 1 : 1 - 0.8 * sstep(0, 0.6, dz); // drowsy: the lids come down before the sleep face
      if (S.still) { an.fk = 1; an.ck = 1; } // still frames (reduced motion, hold still): the new face at once
      an.step(dt, S.still || S.offline || W.err > 0.5, S.state === "idle" && !S.offline && dz < 0.3);
      var dst = null, ddx = 0, ddy = 0;
      if (W.deleg > 0.02) {
        dst = destFn ? destFn() : null;
        if (dst) { ddx = clamp((dst[0] - cc[0]) / (rc * 3.5), -1, 1); ddy = clamp((dst[1] - cc[1]) / (rc * 3.5), -1, 1); }
      }
      // where the eyes go: a delegation's target, else a glance at a session (it needs you, it replied), else the pointer, else an idle glance
      var gzOn = !S.still && S.gzUntil > S.t, gp = null, follow = false, lx = 0, ly = 0;
      if (gzOn) { gp = typeof S.gzAt === "function" ? S.gzAt() : S.gzAt; if (!gp) gzOn = false; }
      if (gzOn) { lx = clamp((gp[0] - cc[0]) / (rc * 3), -1, 1); ly = clamp((gp[1] - cc[1]) / (rc * 3), -1, 1); }
      else if (S.ptrOn && !S.still && dz < 0.5) { follow = true; lx = clamp((S.ptr[0] - cc[0]) / (rc * 3.2), -1, 1); ly = clamp((S.ptr[1] - cc[1]) / (rc * 3.2), -1, 1); }
      var gl_ = !S.still && !gzOn && !follow && an.glanceUntil > an.t ? 1 : 0; // a still frame never freezes mid-glance
      if (S.state === "delegating") { an.gxT = ddx * 2; an.gyT = ddy > 0.35 ? 1 : ddy < -0.35 ? -1 : 0; }
      else if (gzOn || follow) { an.gxT = lx * (gzOn ? 2 : 1.5); an.gyT = ly > 0.4 ? 1 : ly < -0.4 ? -1 : 0; }
      else { an.gxT = gl_ ? an.glx : 0; an.gyT = gl_ ? an.gly : 0; }
      if (dz > 0.5) { an.gxT = 0; an.gyT = 0; }
      var back = !gzOn && !follow && an.gxT === 0 && an.gyT === 0;
      var ek = S.still ? 1 : 1 - Math.exp(-dt * (back ? 3 : 10)); // the pointer left: drift back, slowly
      an.gx += (an.gxT - an.gx) * ek; an.gy += (an.gyT - an.gy) * ek;
      if (S.still) an.gx = Math.round(an.gx); // a still frame: the eyes on whole nodes (a frozen in-between shift reads as a garbled face)
      S.lookK += ((gzOn || follow ? 1 : 0) - S.lookK) * (S.still ? 1 : 1 - Math.exp(-dt * 4));
      weights(an, W8, 0, W.speak > 0.05 ? S.amp : 0, rc < SMALL, S.vis);
      var h = POOL[nHeads++];
      var tt = S.t;
      h.head = S.head; h.detail = detailFor(rc); h.cssR = rc;
      // a reaction's motion: a hop (grin: two, waking: one), a start (surprise), a nod; never in a still frame
      var rp = S.rk && !S.still ? Math.min(1, S.rt / S.rd) : 0, bob = 0, nod = 0, pop = 0;
      if (rp) {
        if (S.rk === "grin") bob = Math.abs(Math.sin(rp * 2 * PI)) * (1 - rp) * 0.09;
        else if (S.rk === "wake") bob = Math.sin(rp * PI) * 0.06;
        else if (S.rk === "surprise") { bob = Math.sin(Math.min(1, rp * 2.5) * PI) * 0.05; pop = 0.04 * Math.sin(Math.min(1, rp * 2) * PI); }
        else if (S.rk === "nod") nod = 0.22 * Math.sin(rp * 4 * PI) * (1 - rp);
      }
      h.cx = cc[0]; h.cy = cc[1] - bob * rc; h.r = rc;
      var lk = S.lookK * (1 - W.deleg);
      h.yaw = cfg.yaw * (1 - 0.5 * W.deleg) + M * awake * (0.15 * Math.sin(tt * 0.37 + 0.6) + 0.05 * gl_ * (an.glx || 0) / 1.6) + W.deleg * ddx * 0.7 + lk * 0.14 * an.gx;
      h.tilt = (cfg.tilt || 0.1) + M * 0.03 * awake * Math.sin(tt * 0.29) + W.deleg * ddy * 0.35 + lk * 0.1 * an.gy + 0.12 * dz + nod;
      h.sc = 1 + M * (0.014 * awake * Math.sin(tt * 1.25) + 0.03 * dz * Math.sin(tt * 0.55)) + pop; // dozing: slow, deeper breaths
      var c = an.color(pal);
      h.st[0] = c[0]; h.st[1] = c[1]; h.st[2] = c[2];
      var bt = beat(tt);
      h.wa = pal.wireK * (S.light > 0.5 ? 1.1 : 1) * (DESK ? 1.6 : 1); h.alpha = 1;
      h.lit = (1 + 0.3 * W.listen * S.amp) * (1 + W.need * (0.3 * bt - 0.12)) * (1 - 0.15 * W.err) * (1 - 0.3 * dz);
      h.glowK = (1 + 0.8 * W.listen * S.amp + 0.25 * W.speak * S.amp) * (1 + W.need * (0.5 * bt - 0.1)) * (1 - 0.4 * dz);
      // the desktop: the backglow is for a dark page; over a wallpaper it would wash out the dark backplate (and the lines)
      h.rimK = GLOW ? ((1 - S.light) * 0.32 + S.light * 0.1) * (DESK ? 0.2 : 1) : 0;
      h.stK = GLOW ? ((1 - S.light) * 0.2 + S.light * 0.11) * h.glowK * (DESK ? 0.6 : 1) : 0;
      h.shimA = W.think * 0.9 * M; h.shimX = -1.6 + ((tt * 0.62) % 1) * 3.2;
      h.form = 1; h.dis = 0; h.row = 0;
      // the sessions
      var list = opts.kids ? opts.kids() : null;
      kidSeen++;
      if (list && list.length) {
        var n = Math.min(MAXK, list.length);
        for (var i = 0; i < n; i++) {
          var k = list[i], key = k.key != null ? String(k.key) : "k" + i;
          var ka = kidAnims[key] || (kidAnims[key] = new Anim(97 + i * 131 + key.length * 17));
          ka.seen = kidSeen;
          var sf = k.form < 0.6 ? { state: "ready", face: "base" } : sessState(k);
          ka.set(sf.face, sf.state);
          if (S.still) { ka.fk = 1; ka.ck = 1; } // still frames: the new face at once
          ka.step(dt, S.still, k.st === "idle");
          var kr = k.r * 0.86;
          var dx = clamp((cc[0] - k.x) / (rc * 4), -1, 1), dy = clamp((cc[1] - k.y) / (rc * 4), -1, 1);
          // the pointer close by: that session looks at it
          var pdx = S.ptr[0] - k.x, pdy = S.ptr[1] - k.y, kp = S.ptrOn && !S.still && Math.abs(pdx) < kr * 3 && Math.abs(pdy) < kr * 3;
          ka.gxT = kp ? clamp(pdx / (kr * 2.2), -1, 1) * 1.6 : !S.still && ka.glanceUntil > ka.t ? ka.glx : dx * 1.2; ka.gyT = 0;
          ka.gx += (ka.gxT - ka.gx) * ek; ka.gy = 0;
          if (S.still) ka.gx = Math.round(ka.gx);
          weights(ka, W8, (i + 1) * NF, sf.state === "speaking" ? 0.35 + 0.55 * synthAmp(ka.t + ka.ph) : 0, kr < SMALL, null);
          var q = POOL[nHeads++];
          q.head = k.head && HEADS[k.head] ? k.head : S.head; // its role's accessory (cc-logic botHeadFor), else the core's
          q.detail = "lo"; q.cssR = kr; q.row = i + 1;
          q.cx = k.x; q.cy = k.y + k.r * 0.06; q.r = kr;
          q.yaw = 0.45 * dx + (S.still ? 0 : 0.1 * Math.sin(ka.t * 0.4 + ka.ph));
          q.tilt = 0.1 + 0.2 * dy;
          q.sc = 1 + (S.still ? 0 : 0.012 * Math.sin(ka.t * 1.3 + ka.ph));
          var kc = ka.color(pal);
          q.st[0] = kc[0]; q.st[1] = kc[1]; q.st[2] = kc[2];
          q.wa = pal.wireK * (S.light > 0.5 ? 0.9 : 0.85) * (DESK ? 1.5 : 1); q.alpha = Math.min(1.2, k.alpha == null ? 1 : k.alpha);
          var pb = sf.state === "needs" ? 1 + 0.25 * (k.amb || 0.5) : 1;
          q.lit = pb; q.glowK = pb;
          q.rimK = GLOW ? ((1 - S.light) * 0.14 + S.light * 0.05) * (DESK ? 0.2 : 1) : 0;
          q.stK = GLOW ? ((1 - S.light) * 0.07 + S.light * 0.05) * pb : 0; // faint: the face itself carries the colour
          q.shimA = sf.state === "thinking" && !S.still ? 0.8 : 0; q.shimX = -1.6 + (((ka.t + ka.ph) * 0.62) % 1) * 3.2;
          q.form = k.form == null ? 1 : k.form; q.dis = k.dis || 0;
        }
      }
      if (kidSeen % 120 === 0) Object.keys(kidAnims).forEach(function (kk) { if (kidAnims[kk].seen < kidSeen - 60) delete kidAnims[kk]; });
    }

    /* ---------------- draw (WebGL2) */
    function setHeadU(u, h, fs, dpr, home) {
      gl.uniform2f(u.u_c, h.cx * dpr, (S.cssH - h.cy) * dpr);
      gl.uniform1f(u.u_r, h.r * dpr); gl.uniform1f(u.u_fs, fs); gl.uniform1f(u.u_sc, h.sc);
      gl.uniform1f(u.u_yaw, h.yaw); gl.uniform1f(u.u_tilt, h.tilt); gl.uniform1f(u.u_form, h.form); gl.uniform1f(u.u_dis, h.dis);
      gl.uniform2f(u.u_home, home[0], home[1]);
      gl.uniform1f(u.u_row, h.row); gl.uniform1f(u.u_wa, h.wa); gl.uniform1f(u.u_lit, h.lit); gl.uniform1f(u.u_alpha, h.alpha);
      gl.uniform3f(u.u_st, h.st[0] / 255, h.st[1] / 255, h.st[2] / 255);
      gl.uniform1f(u.u_shimX, h.shimX); gl.uniform1f(u.u_shimA, h.shimA);
      var ps = dpr * clamp(h.cssR / 120, 0.55, 1.5);
      gl.uniform1f(u.u_psz, ps); gl.uniform1f(u.u_jsz, 7.2 * ps);
      var small = h.cssR < SMALL;
      // small: a face pixel ~60 % of the coarse grid's spacing (2 x 2 face cells), strokes ~45 % so lit runs join into bars
      gl.uniform1f(u.u_lsz, small ? Math.max(2, 0.118 * h.cssR * dpr) : Math.max(1.5, 0.062 * h.cssR) * dpr * (DESK ? 1.2 : 1)); // the desktop: a slightly bolder face over the wallpaper
      gl.uniform1f(u.u_segK, small ? 0.75 : 0.45); gl.uniform1f(u.u_snap, small ? 1 : 0); gl.uniform1f(u.u_sq, small ? 1 : 0);
      gl.uniform1f(u.u_gsz, h.cssR * (h.cssR < 40 ? 0.4 : 0.24) * dpr * h.glowK);
    }
    function drawGL() {
      var cw = canvas.width, ch = canvas.height, dpr = S.dpr, i, h, o, u;
      if (GLOW) ensureFbo(); // (binds its texture: the weights go back on unit 0 just below)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, wtTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NF, ROWS, gl.RED, gl.UNSIGNED_BYTE, W8);
      var home = [S.c[0], S.c[1]];
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      // 1. the glows, at quarter resolution
      if (GLOW) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, fboW, fboH);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        var fs = fboW / cw;
        gl.useProgram(progQ.p); u = progQ.u; gl.bindVertexArray(emptyVao);
        gl.uniform2f(u.u_res, fboW, fboH);
        var dk = 1 - S.light;
        for (i = 0; i < nHeads; i++) {
          h = POOL[i];
          var fa = h.alpha * (h.form < 1 ? h.form : 1) * (1 - h.dis);
          if (fa < 0.01) continue;
          var X = h.cx * dpr * fs, Y = (S.cssH - h.cy) * dpr * fs, Rr = h.r * dpr * fs, E = Rr * 1.75;
          gl.uniform4f(u.u_box, X - E, Y - E, X + E, Y + E);
          gl.uniform2f(u.u_c, X, Y); gl.uniform1f(u.u_r, Rr); gl.uniform2f(u.u_so, 0, -0.12);
          gl.uniform1f(u.u_rimK, h.rimK * fa); gl.uniform1f(u.u_stK, h.stK * fa);
          var rA = pal.rim[0], rB = pal.rim[1], rl = pal.rimL;
          gl.uniform3f(u.u_rA, (rA[0] * dk + rl[0] * S.light) / 255, (rA[1] * dk + rl[1] * S.light) / 255, (rA[2] * dk + rl[2] * S.light) / 255);
          gl.uniform3f(u.u_rB, (rB[0] * dk + rl[0] * S.light) / 255, (rB[1] * dk + rl[1] * S.light) / 255, (rB[2] * dk + rl[2] * S.light) / 255);
          gl.uniform3f(u.u_st, h.st[0] / 255, h.st[1] / 255, h.st[2] / 255);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        gl.useProgram(progW.p); u = progW.u;
        gl.uniform2f(u.u_res, fboW, fboH); gl.uniform1i(u.u_wt, 0); gl.uniform1f(u.u_maxPt, maxPt);
        gl.uniform1f(u.u_pt, 1); gl.uniform1f(u.u_soft, 1); gl.uniform1f(u.u_mode, 4);
        for (i = 0; i < nHeads; i++) {
          h = POOL[i]; o = geoFor(h.head, h.detail);
          if (h.cssR < SMALL) continue; // small heads: no blurred face glow (it would swallow the pixels)
          setHeadU(u, h, fs, dpr, home);
          gl.uniform1f(u.u_lit, h.lit * (S.light > 0.5 ? 0.26 : 0.55));
          gl.bindVertexArray(o.vao); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibF);
          gl.drawElements(gl.POINTS, o.geo.front.length, gl.UNSIGNED_SHORT, 0);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (DESK) {
        gl.useProgram(progP.p); u = progP.u; gl.bindVertexArray(emptyVao);
        gl.uniform2f(u.u_res, cw, ch);
        var pk = S.light, pc = PLATE.dark, pl = PLATE.light, pa = PLATE.aDark + (PLATE.aLight - PLATE.aDark) * pk;
        for (i = 0; i < nHeads; i++) {
          h = POOL[i];
          var pf = h.alpha * (h.form < 1 ? h.form : 1) * (1 - h.dis);
          if (pf < 0.01) continue;
          var PX = h.cx * dpr, PY = (S.cssH - h.cy) * dpr, PR = h.r * dpr * (i ? PLATE.kid : PLATE.core);
          gl.uniform4f(u.u_box, PX - PR, PY - PR, PX + PR, PY + PR);
          gl.uniform2f(u.u_c, PX, PY); gl.uniform1f(u.u_r, PR);
          gl.uniform4f(u.u_col, (pc[0] + (pl[0] - pc[0]) * pk) / 255, (pc[1] + (pl[1] - pc[1]) * pk) / 255, (pc[2] + (pl[2] - pc[2]) * pk) / 255, Math.min(1, pa * pf));
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }
      if (GLOW) {
        gl.useProgram(progC.p); u = progC.u; gl.bindVertexArray(emptyVao);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, fboTex); gl.uniform1i(u.u_tex, 1);
        gl.uniform2f(u.u_res, cw, ch); gl.uniform2f(u.u_tx, 1 / fboW, 1 / fboH); gl.uniform1f(u.u_k, S.light > 0.5 ? 1 : 0.6);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, wtTex);
      }
      // 2. the delegation stream
      if (W.deleg > 0.01 && destFn) {
        var dd = destFn();
        if (dd) {
          gl.useProgram(progS.p); u = progS.u; gl.bindVertexArray(emptyVao);
          var c0 = POOL[0];
          gl.uniform2f(u.u_res, cw, ch); gl.uniform2f(u.u_c, c0.cx * dpr, (S.cssH - c0.cy) * dpr); gl.uniform2f(u.u_dest, dd[0] * dpr, (S.cssH - dd[1]) * dpr);
          gl.uniform1f(u.u_r, c0.r * dpr); gl.uniform1f(u.u_bead, S.bead); gl.uniform1f(u.u_deleg, W.deleg); gl.uniform1f(u.u_psz, dpr * 1.6);
          gl.uniform3f(u.u_st, c0.st[0] / 255, c0.st[1] / 255, c0.st[2] / 255);
          gl.uniform1f(u.u_pt, 1); gl.uniform1f(u.u_soft, 0);
          gl.drawArrays(gl.POINTS, 0, STREAM);
        }
      }
      // 3. the heads: wireframe, nodes, lit strokes, lit face
      gl.useProgram(progW.p); u = progW.u;
      gl.uniform2f(u.u_res, cw, ch); gl.uniform1i(u.u_wt, 0); gl.uniform1f(u.u_maxPt, maxPt);
      gl.uniform3f(u.u_wire, pal.wire[0] / 255, pal.wire[1] / 255, pal.wire[2] / 255);
      var lineGain = dpr > 1.4 ? 1.25 : 0.85;
      for (i = nHeads - 1; i >= 0; i--) { // the sessions first, the core on top
        h = POOL[i]; o = geoFor(h.head, h.detail);
        setHeadU(u, h, 1, dpr, home);
        gl.bindVertexArray(o.vao);
        gl.uniform1f(u.u_pt, 0); gl.uniform1f(u.u_mode, 0); gl.uniform1f(u.u_wa, h.wa * lineGain);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibL); gl.drawElements(gl.LINES, o.geo.lines.length, gl.UNSIGNED_SHORT, 0);
        gl.uniform1f(u.u_wa, h.wa);
        gl.uniform1f(u.u_pt, 1); gl.uniform1f(u.u_soft, 0); gl.uniform1f(u.u_mode, 1);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibP); gl.drawElements(gl.POINTS, o.geo.pts.length, gl.UNSIGNED_SHORT, 0);
        if (o.segN) {
          gl.bindVertexArray(o.segVao); gl.uniform1f(u.u_mode, 3);
          gl.drawArrays(gl.POINTS, 0, o.segN);
          gl.bindVertexArray(o.vao);
        }
        gl.uniform1f(u.u_mode, 2);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibF); gl.drawElements(gl.POINTS, o.geo.front.length, gl.UNSIGNED_SHORT, 0);
      }
      // 4. dozing: the z z z
      var zk = zzzK();
      if (zk > 0.01) {
        var c0z = POOL[0];
        gl.useProgram(progZ.p); u = progZ.u; gl.bindVertexArray(emptyVao);
        gl.uniform2f(u.u_res, cw, ch); gl.uniform2f(u.u_c, c0z.cx * dpr, (S.cssH - c0z.cy) * dpr); gl.uniform1f(u.u_r, c0z.r * dpr);
        gl.uniform1f(u.u_t, zzzT()); gl.uniform1f(u.u_k, zk); gl.uniform1f(u.u_psz, Math.max(2, 0.05 * c0z.cssR * dpr));
        gl.uniform3f(u.u_st, c0z.st[0] / 255, c0z.st[1] / 255, c0z.st[2] / 255);
        gl.uniform1f(u.u_pt, 1); gl.uniform1f(u.u_soft, 0); gl.uniform1f(u.u_sq, 1); gl.uniform1f(u.u_mode, 2);
        gl.drawArrays(gl.POINTS, 0, ZN);
      }
      gl.bindVertexArray(null);
    }

    /* ---------------- draw (Canvas 2D) */
    var o2 = { dpr: 1 };
    function draw2d() {
      var dpr = S.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var home = coreCss();
      for (var i = nHeads - 1; i >= 0; i--) {
        var h = POOL[i];
        o2.geo = build(h.head, h.detail); o2.cx = h.cx; o2.cy = h.cy; o2.r = h.r; o2.yaw = h.yaw; o2.tilt = h.tilt; o2.sc = h.sc;
        o2.wire = pal.wire; o2.st = h.st; o2.wa = h.wa; o2.lit = h.lit; o2.alpha = h.alpha; o2.w = W8; o2.off = h.row * NF; o2.light = S.light > 0.5;
        o2.rimA = pal.rim[0]; o2.rimB = pal.rim[1]; o2.rimL = pal.rimL; o2.rimK = h.rimK * 0.8; o2.stK = h.stK * 1.2; o2.form = h.form; o2.dis = h.dis;
        o2.homeX = home[0]; o2.homeY = home[1]; o2.shimX = h.shimX; o2.shimA = h.shimA; o2.dpr = dpr;
        if (DESK) plate2d(ctx, h, i ? PLATE.kid : PLATE.core);
        draw2dHead(ctx, o2);
      }
      var zk = zzzK();
      if (zk > 0.01) {
        var c0 = POOL[0], zt = zzzT(), zs = Math.max(2 / dpr, 0.05 * c0.cssR);
        for (var j = 0; j < ZN; j++) {
          zDot(j, zt, ZP);
          var za = ZP[3] * zk, sz = zs * ZP[2];
          if (za < 0.01) continue;
          ctx.fillStyle = rgba(c0.st, za);
          ctx.fillRect(c0.cx + ZP[0] * c0.r - sz / 2, c0.cy - ZP[1] * c0.r - sz / 2, sz, sz);
        }
      }
    }
    /** How visible the dozing z z z are (0..1), and their clock (a still frame: one fixed moment). */
    function zzzK() { return S.offline || S.state !== "idle" ? 0 : sstep(0.6, 1, S.doze); }
    function zzzT() { return S.still ? 1.3 : S.t; }

    /** The desktop's contrast backplate on the 2D context (the GL one's twin). */
    function plate2d(g, h, k) {
      var pf = h.alpha * (h.form < 1 ? h.form : 1) * (1 - h.dis);
      if (pf < 0.01) return;
      var pk = S.light, c = [0, 1, 2].map(function (j) { return PLATE.dark[j] + (PLATE.light[j] - PLATE.dark[j]) * pk; });
      var a = Math.min(1, (PLATE.aDark + (PLATE.aLight - PLATE.aDark) * pk) * pf), R = h.r * k;
      var gr = g.createRadialGradient(h.cx, h.cy, 0, h.cx, h.cy, R);
      gr.addColorStop(0, rgba(c, a)); gr.addColorStop(0.45, rgba(c, a)); gr.addColorStop(0.73, rgba(c, a * 0.5)); gr.addColorStop(1, rgba(c, 0));
      g.fillStyle = gr; g.fillRect(h.cx - R, h.cy - R, R * 2, R * 2);
    }

    /* ---------------- simulation + loop */
    function step(dt) {
      S.t += dt;
      var st = S.offline ? "error" : S.state, tg = TARGETS[st] || {}, k = 1 - Math.exp(-dt * 4);
      KEYS.forEach(function (key) { W[key] += ((tg[key] || 0) - W[key]) * k; });
      S.light += (S.lightT - S.light) * (1 - Math.exp(-dt * 4));
      var talking = S.state === "listening" || S.state === "speaking";
      var real = talking && ampFn ? ampFn(S.state) : null;
      var target = !talking ? 0 : real == null || real < 0 ? (S.state === "listening" ? synthListen(S.t) : synthAmp(S.t)) : Math.max(0, Math.min(1, real));
      S.amp += (target - S.amp) * (1 - Math.exp(-dt * (target > S.amp ? 24 : 8)));
      S.ampSlow += (S.amp - S.ampSlow) * (1 - Math.exp(-dt * 3));
      S.bead += dt * 0.38;
      S.arrive += ((S.state === "delegating" ? 1 : 0) - S.arrive) * (1 - Math.exp(-dt * 2));
      // the mouth: a viseme from the voice's spectrum (level only without one), eased so shapes flow
      var sp = S.state === "speaking" && real != null && real >= 0 && specFn ? specFn() : null;
      if (S.state === "speaking") viseme(sp ? sp.bins : null, sp ? sp.hz : 0, S.amp, VT);
      else { VT.closed = 1; VT.open = VT.wide = VT.round = 0; }
      var vk = 1 - Math.exp(-dt * 20);
      S.vis.closed += (VT.closed - S.vis.closed) * vk; S.vis.open += (VT.open - S.vis.open) * vk;
      S.vis.wide += (VT.wide - S.vis.wide) * vk; S.vis.round += (VT.round - S.vis.round) * vk;
      // moods: dozing is checked once a second; it settles over ~2 s and lifts at once
      S.dozeChk -= dt;
      if (S.dozeChk <= 0) { S.dozeChk = 1; evalDoze(); }
      S.doze += (S.dozeT - S.doze) * (1 - Math.exp(-dt * (S.dozeT > S.doze ? 0.6 : 6)));
      if (S.rk) { S.rt += dt; if (S.rt >= S.rd) S.rk = ""; }
      prepare(dt);
    }
    /* ---------------- moods, reactions, the pointer, glances */
    function evalDoze() {
      var want = dozeWanted({ state: S.state, offline: S.offline, near: S.near, quietMs: now() - S.actAt, hour: hourOf() });
      if (want && !S.dozeT) S.dozeT = 1;
      else if (!want && S.dozeT) wake();
    }
    function wake() {
      S.dozeT = 0;
      if (S.doze > 0.5) react("wake");
      if (S.still) S.doze = 0;
    }
    /** Something happened (a state change, a message, a card, a pointer near): the quiet spell restarts, a dozing bot wakes. */
    function poke() { S.actAt = now(); if (S.dozeT) { wake(); if (S.still) stillFrame(); } }
    var rkTimer = 0;
    /** A short reaction: "surprise" (error / offline), "grin" (a job done), "nod" (approved), "wake". Still frames: the face only. */
    function react(kind) {
      if (!REACT[kind]) return false;
      S.actAt = now();
      if (S.dozeT && kind !== "wake") { S.dozeT = 0; if (S.still) S.doze = 0; }
      if (S.still) {
        if (kind !== "grin" && kind !== "surprise") return false; // motion only: nothing to show in a still frame
        S.rk = kind; S.rt = 0; S.rd = REACT[kind]; S.rkStill = true;
        clearTimeout(rkTimer);
        rkTimer = setTimeout(function () { S.rk = ""; if (S.still) stillFrame(); }, REACT[kind] * 1000);
        stillFrame();
        return true;
      }
      S.rk = kind; S.rt = 0; S.rd = REACT[kind]; S.rkStill = false;
      if (kind === "wake" || kind === "surprise") coreAnim.blinkP = 0;
      return true;
    }
    /** Look at a point (CSS px, or a function giving one each frame) for ms: a session that needs you, a reply. */
    function glance(at, ms) {
      if (!at) return;
      S.gzAt = at; S.gzUntil = S.t + (ms || 1400) / 1000;
      poke();
    }
    var ptrRect = null, ptrRectAt = 0;
    function onPtr(e) {
      var tn = e.timeStamp || 0;
      if (!ptrRect || tn - ptrRectAt > 500 || tn < ptrRectAt) { ptrRect = canvas.getBoundingClientRect(); ptrRectAt = tn; }
      S.ptr[0] = e.clientX - ptrRect.left; S.ptr[1] = e.clientY - ptrRect.top; S.ptrOn = true;
      var cc = coreCss(), r = headR(), dx = S.ptr[0] - cc[0], dy = S.ptr[1] - cc[1], near = dx * dx + dy * dy < r * r * 6.25;
      if (near && !S.near) { S.near = true; poke(); } else S.near = near;
      if (near) S.actAt = now();
    }
    function onPtrOut(e) { if (!e.relatedTarget) { S.ptrOn = false; S.near = false; } }
    function onBlur() { S.ptrOn = false; S.near = false; }
    if (opts.pointer) {
      window.addEventListener("pointermove", onPtr, { passive: true });
      document.addEventListener("pointerout", onPtrOut);
      window.addEventListener("blur", onBlur);
    }
    // still frames (reduced motion, hold still): no loop to notice a quiet spell, so look now and then
    var stillTimer = setInterval(function () {
      if (!S.still || !S.wanted) return;
      var was = S.dozeT; evalDoze();
      if (S.dozeT !== was) { S.doze = S.dozeT; stillFrame(); }
    }, 20000);
    function draw() {
      if (!canvas.width || !canvas.height) return;
      if (!nHeads) prepare(0);
      if (gl) drawGL(); else if (ctx) draw2d();
      if (onFrame) onFrame(S, W);
    }
    var slowSince = 0;
    function guard(now) {
      if (S.lowRes || opts.noGuard || S.frames.length < 30) return;
      var f = S.frames, iv = (f[f.length - 1][0] - f[f.length - 30][0]) / 29;
      if (iv > 22) { if (!slowSince) slowSince = now; else if (now - slowSince > 2000) { S.lowRes = true; if (lastSize) resize.apply(null, lastSize); if (window.console) console.info("[core E] drawing at 0.7x resolution (" + iv.toFixed(1) + " ms a frame)"); } }
      else slowSince = 0;
    }
    function frame(now) {
      raf = 0;
      if (!S.running) return;
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      var t0 = performance.now();
      if (opts.beforeDraw) opts.beforeDraw(S, W); // the family moves first, so heads and names agree
      step(dt);
      draw();
      S.frames.push([now, performance.now() - t0]);
      if (S.frames.length > 360) S.frames.shift();
      guard(now);
      raf = requestAnimationFrame(frame);
    }
    function start() {
      S.wanted = true;
      if (S.still) { stillFrame(); return; }
      if (S.running || document.hidden) return;
      S.running = true; last = 0; raf = requestAnimationFrame(frame);
    }
    function stop(keep) { S.running = false; if (!keep) S.wanted = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    /** One still frame of the current state (reduced motion, hold still): the face fully there, eyes open, no sway. */
    function stillFrame() {
      var st = S.offline ? "error" : S.state, tg = TARGETS[st] || {};
      KEYS.forEach(function (k) { W[k] = tg[k] || 0; });
      S.light = S.lightT;
      S.amp = S.state === "listening" || S.state === "speaking" ? 0.55 : 0;
      if (S.rk && !S.rkStill) S.rk = ""; // a reaction the loop was playing does not freeze into a still frame
      S.doze = S.dozeT; S.lookK = 0; viseme(null, 0, S.amp, S.vis);
      var wasStill = S.still; S.still = true;
      prepare(0);
      coreAnim.settle(); Object.keys(kidAnims).forEach(function (k) { kidAnims[k].settle(); });
      prepare(0);
      S.still = wasStill;
      if (canvas.width && canvas.height) { if (gl) drawGL(); else if (ctx) draw2d(); if (onFrame) onFrame(S, W); }
    }
    function onVis() { if (document.hidden) stop(true); else if (S.wanted) start(); }
    document.addEventListener("visibilitychange", onVis);
    function onReduce() { S.still = reduceMq.matches; if (S.still) { stop(true); stillFrame(); } else if (S.wanted) start(); }
    if (reduceMq && reduceMq.addEventListener) reduceMq.addEventListener("change", onReduce);
    function resize(cx, cy, R, w, h) {
      lastSize = [cx, cy, R, w, h];
      var dpr = Math.min(window.devicePixelRatio || 1, 2) * (S.lowRes ? 0.7 : 1);
      w = w || canvas.clientWidth || window.innerWidth; h = h || canvas.clientHeight || window.innerHeight;
      var pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      S.cssW = w; S.cssH = h; S.dpr = dpr;
      S.c = [cx * dpr, (h - cy) * dpr]; S.R = R * dpr;
      if (S.still || !S.running) { prepare(0); draw(); }
    }
    function stats() {
      var f = S.frames; if (f.length < 10) return null;
      var cost = f.map(function (x) { return x[1]; }).sort(function (a, b) { return a - b; }), iv = [];
      for (var i = 1; i < f.length; i++) iv.push(f[i][0] - f[i - 1][0]);
      iv.sort(function (a, b) { return a - b; });
      var med = function (a) { return a[Math.floor(a.length / 2)]; }, p95 = function (a) { return a[Math.floor(a.length * 0.95)]; };
      return { cpuMed: med(cost), cpuP95: p95(cost), interval: med(iv), intervalP95: p95(iv), fps: 1000 / med(iv), n: f.length, gl: !!gl };
    }
    function redrawIfIdle() { if (S.still) stillFrame(); else if (!S.running) { prepare(0); draw(); } }

    if (initGL()) S.gl = true; else ctx = canvas.getContext("2d");
    mixPal(); coreAnim.color(pal); coreAnim.pcol = coreAnim.rgb.slice();

    return {
      S: S, W: W, STATES: STATES,
      get isGL() { return !!gl; },
      get canvas() { return canvas; },
      setState: function (s) { if (STATES.indexOf(s) < 0) s = "idle"; if (s === S.state) return; S.state = s; poke(); if (S.still) stillFrame(); },
      /** MINT AI unreachable: red x x, still (the Command Center's offline state). */
      setOffline: function (on) { on = !!on; if (on === S.offline) return; S.offline = on; if (on) react("surprise"); else { if (S.rk === "surprise") S.rk = ""; poke(); } redrawIfIdle(); },
      /** Expressive (2026-10-20): something happened (poke), a reaction (react), a look at a point (glance), the pointer by hand (look). */
      poke: poke, react: react, glance: glance,
      look: function (x, y) { if (x == null) { S.ptrOn = false; S.near = false; return; } S.ptr[0] = x; S.ptr[1] = y; S.ptrOn = true; var cc = coreCss(), r = headR(), dx = x - cc[0], dy = y - cc[1]; S.near = dx * dx + dy * dy < r * r * 6.25; if (S.near) poke(); },
      /** Checks: whether it would doze now (and evaluate it). */
      _doze: function () { evalDoze(); return S.dozeT; },
      setLight: function (on, instant) { S.lightT = on ? 1 : 0; if (instant) S.light = S.lightT; if (S.still || !S.running) { S.light = S.lightT; redrawIfIdle(); } },
      /** The head style (one of MintBot.HEADS); the sessions follow. */
      setHead: function (id) { if (!HEADS[id] || id === S.head) return; S.head = id; redrawIfIdle(); },
      /** The colours ({p, c} as MintLogic.normBotColors gives); every head takes them at once. */
      setColors: function (c) { colors = c; PAL = palettes(colors); redrawIfIdle(); },
      resize: resize, start: start, stop: function () { stop(false); }, still: stillFrame, stats: stats,
      /** Draw now (reduced motion / a stopped core: the sessions moved, so the heads are gathered again first). */
      draw: function () { if (!S.running) prepare(0); draw(); },
      resetStats: function () { S.frames = []; },
      setGuard: function (on) { opts.noGuard = !on; },
      /** Driven from outside (mint-shell.js's flight): move without drawing (place), then advance and draw one frame (tick). */
      place: function (cx, cy, R) { lastSize = [cx, cy, R, S.cssW, S.cssH]; S.c = [cx * S.dpr, (S.cssH - cy) * S.dpr]; S.R = R * S.dpr; },
      tick: function (dt) {
        if (!gl && !ctx) return;
        if (opts.beforeDraw) opts.beforeDraw(S, W);
        step(Math.max(0, Math.min(0.05, dt || 0.016)));
        draw();
      },
      /** Carry on exactly where another core E left off: state, weights, voice level, face and phases. */
      adopt: function (o) {
        if (!o || !o.S || o.S.concept !== "E") return;
        var a = o.S;
        ["t", "amp", "ampSlow", "bead", "arrive", "light", "lightT", "doze", "dozeT", "actAt"].forEach(function (k) { if (typeof a[k] === "number") S[k] = a[k]; });
        S.state = a.state; S.offline = !!a.offline; if (a.head && HEADS[a.head]) S.head = a.head;
        KEYS.forEach(function (k) { if (typeof o.W[k] === "number") W[k] = o.W[k]; });
        if (o._anim) { var src = o._anim(); ["face", "prev", "fk", "col", "ck", "t", "blinkAt", "blinkP", "gx", "gy", "glanceAt", "glanceUntil"].forEach(function (k) { coreAnim[k] = src[k]; }); coreAnim.pcol = src.pcol.slice(); }
      },
      _anim: function () { return coreAnim; },
      setConcept: function () {},
      /** Stop and give the GPU context back (cc-map.js calls it before swapping to another core). */
      destroy: function () {
        stop(false);
        document.removeEventListener("visibilitychange", onVis);
        window.removeEventListener("pointermove", onPtr); document.removeEventListener("pointerout", onPtrOut); window.removeEventListener("blur", onBlur);
        clearInterval(stillTimer); clearTimeout(rkTimer);
        if (reduceMq && reduceMq.removeEventListener) reduceMq.removeEventListener("change", onReduce);
        try { freeGeos(); var lc = gl && gl.getExtension("WEBGL_lose_context"); if (lc) lc.loseContext(); } catch (e) { /* gone already */ }
        gl = null; ctx = null;
      },
    };
  }

  /**
   * A still picture of one head for the Settings pickers (Canvas 2D, no loop): thumb(canvas, head,
   * { state, light, colors, w, h }). The canvas is sized for the device pixel ratio.
   */
  function thumb(canvas, head, o) {
    o = o || {};
    var w = o.w || canvas.clientWidth || 96, h = o.h || canvas.clientHeight || 96, dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    var g = canvas.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var P = palettes(o.colors || null)[o.light ? "light" : "dark"], fo = FACE_OF[o.state] || FACE_OF.idle, an = new Anim(5);
    an.set(fo.face, fo.state); an.settle();
    var w8 = new Uint8Array(NF);
    weights(an, w8, 0, fo.face === "speak" ? 0.6 : 0);
    var r = Math.min(w, h) * 0.3, cfg = HEADS[head] || HEADS.cap;
    draw2dHead(g, {
      geo: build(HEADS[head] ? head : "cap", r >= 60 ? "hi" : "lo"), cx: w / 2, cy: h / 2 + r * 0.3, r: r, yaw: cfg.yaw, tilt: cfg.tilt || 0.1, sc: 1,
      wire: P.wire, st: P[fo.state], wa: P.wireK * 1.3, lit: 1, alpha: 1, w: w8, off: 0, light: !!o.light, rimA: P.rim[0], rimB: P.rim[1], rimL: P.rimL,
      rimK: o.light ? 0.035 : 0.26, stK: o.light ? 0.1 : 0.22, form: 1, dis: 0, homeX: 0, homeY: 0, shimX: 0, shimA: 0, dpr: dpr,
    });
  }

  return {
    create: create, thumb: thumb, build: build, HEADS: HEADS, HEAD_IDS: HEAD_IDS, FACES: FACES, FMAP: FMAP, faceAt: faceAt, weights: weights, Anim: Anim,
    FACE_OF: FACE_OF, coreFace: coreFace, sessState: sessState, NF: NF, GN: GN,
    viseme: viseme, MOUTH: MOUTH, VIS: VIS, dozeWanted: dozeWanted, isNight: isNight, DOZE_QUIET_MS: DOZE_QUIET_MS, NIGHT_QUIET_MS: NIGHT_QUIET_MS, pickFace: pickFace, REACT: REACT, zDot: zDot, ZN: ZN,
  };
});
