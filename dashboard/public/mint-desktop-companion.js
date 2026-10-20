"use strict";
/*
 * Companion mode (the MINT AI desktop app, 2026-10-20; design: mockups/desk-companion/DESIGN.md): the bot
 * steps out of its box and lives on the desktop, like EMO on a real desk. The app (desktop/src-tauri/src/
 * companion.rs, companion_host.rs) moves a small window -- WIN_W x WIN_H logical px -- along the taskbar and
 * onto the top edge of the window in front; this file draws the bot in that window and makes it alive:
 *
 *   - its pose from the app (mint://companion): walk (a bob, the head leaning into the step), hop (crouch,
 *     stretch, land), step out of / into a monitor's edge, duck out (a full-screen app, a meeting) and pop
 *     up again, a look up when the cursor rests on it (attention);
 *   - the eyes follow the cursor when it is near (mint://companion-look; the app sends where it is);
 *   - idle moments: it stretches and looks around now and then; it dozes (core E's own doze: ten quiet
 *     minutes, or at night after one) and says so, so the app walks it back to the taskbar to sleep; it hops
 *     (core E's grin) when a session finishes or a long turn is done, and nods when an approval goes through;
 *   - the session bots: the heads of the sessions waiting on you walk in and gather beside it (at most
 *     MAX_HEADS, the longest waiting first), and wander off when they are no longer waiting;
 *   - its hit regions: the bot and the session bots only -- everything else lets clicks through;
 *   - a click on it opens the Command Center (the app's Peek, on its monitor); a click on a session bot opens
 *     that session there.
 * No blur: the bot has its own backplate (core E's desk mode).
 *
 * The pure parts are exported for the tests (dashboard/tools/test-desktop-companion.cjs): the numbers
 * (equal to companion.rs), layout(), motion(), gather(), kidsAt(), idlePick(), regions(). mount() is the
 * page's: mint-desktop.js calls it with its bridge (invoke, listen, its state).
 *
 * No inline style or script (the CSP): positions go through element.style; the bot is one canvas.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MintDesktopCompanion = api;
})(typeof self !== "undefined" ? self : this, function () {
  // companion.rs has the same numbers (the test reads both).
  var WIN_W = 264, WIN_H = 140, FOOT = 6, BODY_R = 38, BODY_CY = 40, HANG_CY = 46, LEAN_DX = 70;
  var HEAD_R = 30;        // the bot's drawn head radius (its backplate reaches about BODY_R); short legs below it
  var KID_R = 13;         // a session bot's head
  var MAX_HEADS = 3;      // session bots gathered at once
  var GATHER_MS = 900;    // walking in / off
  var IDLE_MIN_MS = 25000, IDLE_MAX_MS = 50000;

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function ease(k) { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); }

  /**
   * Where the bot and the session bots sit in the window (CSS px): standing, feet FOOT above the bottom;
   * hanging under a top taskbar, the head just under the top. openSide: where the screen has more room
   * (the session bots gather there first).
   */
  function layout(W, H, stance, openSide, lean) {
    W = W || WIN_W; H = H || WIN_H;
    var hang = stance === "hang", ln = lean < 0 ? -1 : lean > 0 ? 1 : 0;
    // Leaning on a side taskbar: the bot sits LEAN_DX toward it (companion.rs body() does the same).
    var cx = W / 2 + ln * LEAN_DX, cy = hang ? HANG_CY : H - FOOT - BODY_CY;
    var ky = hang ? cy - 6 : H - FOOT - KID_R - 2;
    var s = ln ? -ln : openSide === "right" ? 1 : -1;
    var slots = ln ? [{ x: cx + s * 70, y: ky }, { x: cx + s * 104, y: ky }, { x: cx + s * 138, y: ky }] : [{ x: cx + s * 70, y: ky }, { x: cx - s * 70, y: ky }, { x: cx + s * 104, y: ky + (hang ? 0 : 1) }];
    return { W: W, H: H, cx: cx, cy: cy, R: HEAD_R, body: { x: cx, y: cy, r: BODY_R }, slots: slots, hang: hang, open: s, lean: ln };
  }

  /**
   * The bot's motion for a pose at k (0..1 through it): an offset (dx, dy, CSS px), a size factor (sc) and an
   * opacity (a). walk: a bob; hop: crouch, rise, land; out / in: off the window's edge in `dir` and back;
   * duck: down out of sight; pop: up again; stretch: up tall and back; look: none (the eyes do it).
   */
  function motion(kind, k, dir, L, t) {
    k = clamp(k, 0, 1);
    var d = dir < 0 ? -1 : 1, m = { dx: 0, dy: 0, sc: 1, a: 1 };
    var edge = (L ? L.W / 2 : WIN_W / 2) + BODY_R + 4;
    switch (kind) {
      // a step every ~180 ms (t: ms into the walk), a small lift on each; level at both ends
      case "walk": m.dy = -Math.abs(Math.sin(((t || 0) / 180) * Math.PI)) * 3 * Math.min(1, k * 8, (1 - k) * 8); break;
      case "hop":
        // The window carries the arc; the bot crouches before it and squashes a little as it lands.
        if (k < 0.15) m.sc = 1 - 0.08 * ease(k / 0.15);
        else if (k < 0.85) m.sc = 0.92 + 0.12 * ease((k - 0.15) / 0.35) - 0.04 * ease((k - 0.5) / 0.35);
        else m.sc = 1 - 0.06 * Math.sin(((k - 0.85) / 0.15) * Math.PI);
        break;
      case "out": m.dx = d * edge * ease(k); m.a = 1 - ease((k - 0.6) / 0.4); break;
      case "in": m.dx = -d * edge * (1 - ease(k)); m.a = ease(k / 0.4); break;
      case "duck": m.dy = (L ? L.R * 2.6 : 80) * ease(k); m.a = 1 - ease((k - 0.3) / 0.7); break;
      case "pop": m.dy = (L ? L.R * 2.6 : 80) * (1 - ease(k)); m.a = ease(k / 0.5); m.sc = 1 + 0.05 * Math.sin(k * Math.PI); break;
      case "stretch": m.sc = 1 + 0.07 * Math.sin(k * Math.PI); m.dy = -4 * Math.sin(k * Math.PI); break;
      default: break;
    }
    return m;
  }
  var POSE_MS = { stretch: 1400, look: 2600, duck: 450, pop: 520, attention: 0 };

  /**
   * Its legs (standing) or arms (hanging under a top taskbar) and its contact shadow, for the 2D canvas under
   * the head: segments [{x0, y0, x1, y1}] and a shadow {x, y, rx, ry, a}, CSS px. t: ms (the walk's steps);
   * m: the motion now; walking: legs take turns; mid-hop: tucked; dozing: folded (it sits).
   */
  function limbs(L, m, kind, t, dozing) {
    m = m || { dx: 0, dy: 0, sc: 1, a: 1 };
    var R = L.R * m.sc, cx = L.cx + m.dx, cy = L.cy + m.dy, gap = R * 0.34, out = [];
    if (L.hang) {
      var sw = kind === "walk" ? Math.sin((t || 0) / 180 * Math.PI) * 2 : 0;
      out.push({ x0: cx - gap, y0: cy - R * 0.86, x1: cx - gap - 2 + sw, y1: 1.5 });
      out.push({ x0: cx + gap, y0: cy - R * 0.86, x1: cx + gap + 2 - sw, y1: 1.5 });
      return { legs: out, shadow: null };
    }
    var feet = L.H - FOOT, top = cy + R * 0.84, ph = (t || 0) / 180 * Math.PI, lean = L.lean || 0;
    var tuck = kind === "hop" ? 0.45 : dozing ? 0.35 : 0;
    var lift = kind === "walk" ? 3 : 0, swing = kind === "walk" ? 2.5 : 0;
    [-1, 1].forEach(function (side, i) {
      var phase = Math.sin(ph + (i ? Math.PI : 0));
      var y1 = feet - Math.max(0, phase) * lift + m.dy * (kind === "walk" ? 0 : 1);
      y1 = top + (y1 - top) * (1 - tuck);
      // leaning on a side taskbar: the feet a little away from it
      out.push({ x0: cx + side * gap, y0: top, x1: cx + side * gap + phase * swing + (dozing ? side * 4 : 0) - lean * 5, y1: Math.max(top + 2, y1) });
    });
    var lifted = Math.max(0, -m.dy);
    return { legs: out, shadow: { x: cx, y: feet + 1, rx: R * 0.78 * Math.max(0.5, 1 - lifted / 40), ry: 3.2, a: 0.32 * m.a * Math.max(0.4, 1 - lifted / 40) } };
  }

  /** A session's key and whether it waits on you (the supervisor's status; an approval it asked for counts too). */
  function sessKey(s) { return String(s.session_id || s.key || s.name || ""); }
  function waiting(s, pend) { return s.status === "waiting" || !!pend[String(s.name || "")]; }

  /**
   * The session bots by the companion: prev (the last list), the sessions now, the pending approvals'
   * origins, now (ms). Those waiting on you walk in (phase "in", then "here"), at most MAX_HEADS -- the
   * longest waiting first; one no longer waiting (or pushed out) walks off ("out") and is dropped after.
   * Each keeps its slot while it stays. on: the setting (off: all walk off).
   */
  function gather(prev, sessions, approvals, now, on) {
    prev = prev || [];
    var pend = {};
    (approvals || []).forEach(function (a) { if (a && a.status === "pending") pend[String(a.origin || "").replace(/^session:/, "")] = 1; });
    var want = [];
    if (on !== false) {
      (sessions || []).forEach(function (s) { if (s && !s.self && waiting(s, pend)) want.push(s); });
      var since = {};
      prev.forEach(function (h) { since[h.key] = h.since; });
      want.forEach(function (s) { var k = sessKey(s); if (since[k] == null) since[k] = now; s.__since = since[k]; });
      want.sort(function (a, b) { return a.__since - b.__since || (sessKey(a) < sessKey(b) ? -1 : 1); });
      want = want.slice(0, MAX_HEADS);
    }
    var keep = {}, out = [], used = {};
    want.forEach(function (s) { keep[sessKey(s)] = s; });
    prev.forEach(function (h) {
      if (keep[h.key] && h.phase !== "out") { used[h.slot] = 1; out.push(Object.assign({}, h, { phase: now - h.t0 >= GATHER_MS ? "here" : h.phase, head: keep[h.key].__head || h.head, name: keep[h.key].name || h.name })); }
      else if (h.phase === "out") { if (now - h.t0 < GATHER_MS) out.push(h); }
      else out.push(Object.assign({}, h, { phase: "out", t0: now }));
    });
    want.forEach(function (s) {
      var k = sessKey(s);
      if (out.some(function (h) { return h.key === k && h.phase !== "out"; })) return;
      var slot = 0;
      while (used[slot]) slot++;
      used[slot] = 1;
      out.push({ key: k, name: s.name || k, head: s.__head || null, slot: slot, phase: "in", t0: now, since: s.__since });
    });
    want.forEach(function (s) { delete s.__since; });
    return out;
  }

  /**
   * The session bots as core E draws its sessions (opts.kids()): walking in from the open side's edge to
   * their slot, standing there, walking off; each with a small bob while it walks and the "needs you" face.
   */
  function kidsAt(heads, now, L, still) {
    var out = [];
    (heads || []).forEach(function (h) {
      var sl = L.slots[Math.min(h.slot, L.slots.length - 1)], edgeX = L.open > 0 ? L.W + KID_R : -KID_R;
      var k = still ? 1 : clamp((now - h.t0) / GATHER_MS, 0, 1), x = sl.x, y = sl.y, a = 1;
      if (h.phase === "in") { x = edgeX + (sl.x - edgeX) * ease(k); a = ease(k / 0.3); }
      else if (h.phase === "out") { if (still) return; x = sl.x + (edgeX - sl.x) * ease(k); a = 1 - ease((k - 0.6) / 0.4); }
      var walking = !still && h.phase !== "here" && k < 1;
      if (walking) y -= Math.abs(Math.sin(k * Math.PI * 6)) * 2;
      out.push({ x: x, y: y, r: KID_R, alpha: a, form: 1, dis: 0, key: h.key, st: h.phase === "out" ? "idle" : "waiting", glow: 0, bloom: 0, head: h.head, rot: 0, phase: 0, amb: 0, shimmer: 0, catchK: 0, seed: 0 });
    });
    return out;
  }

  /**
   * An idle moment now? Only when ready and awake, not holding still, nobody near and it has been quiet for a
   * while: "stretch" or "look" (around), alternating with a little chance; next: when to ask again.
   */
  function idlePick(o) {
    if (!o || o.still || o.state !== "idle" || o.dozing || o.busy || o.now < (o.next || 0)) return null;
    var r = typeof o.rnd === "number" ? o.rnd : Math.random();
    var act = o.last === "stretch" ? (r < 0.75 ? "look" : "stretch") : (r < 0.5 ? "stretch" : "look");
    return { act: act, next: o.now + IDLE_MIN_MS + Math.round(r * (IDLE_MAX_MS - IDLE_MIN_MS)) };
  }

  /** The hit regions (CSS px): the bot's circle and each session bot that is there (not walking off). */
  function regions(L, kids, m) {
    var out = [], b = L.body, dx = m ? m.dx : 0, dy = m ? m.dy : 0;
    if (!m || m.a > 0.3) out.push({ x: Math.floor(b.x + dx - b.r), y: Math.floor(b.y + dy - b.r), w: Math.ceil(2 * b.r), h: Math.ceil(2 * b.r), r: Math.round(b.r) });
    (kids || []).forEach(function (q) {
      if (!(q.alpha > 0.5) || q.st === "idle") return;
      var h = q.r + 4;
      out.push({ x: Math.floor(q.x - h), y: Math.floor(q.y - h), w: Math.ceil(2 * h), h: Math.ceil(2 * h), r: Math.round(h), key: q.key });
    });
    return out.map(function (r) { var x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(L.W, r.x + r.w), y1 = Math.min(L.H, r.y + r.h); return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0), r: r.r, key: r.key }; }).filter(function (r) { return r.w >= 1 && r.h >= 1; });
  }

  /* -------------------------------------------------------------------- the page */
  /**
   * mount({ invoke, listen, state() -> the desktop page's state, still() -> hold still now }): builds the
   * companion's canvas and click target and runs it while the app is in Companion mode (not its Peek).
   */
  function mount(o) {
    if (typeof document === "undefined") return null;
    var doc = document, html = doc.documentElement, invoke = o.invoke;
    // The app's events (and, for the checks and the preview, the same handlers by hand: debug.event).
    var handlers = {};
    function listen(name, fn) { handlers[name] = fn; if (o.listen) o.listen(name, fn); }
    var wrap = doc.createElement("div"), cv = doc.createElement("canvas"), hit = doc.createElement("button"), hint = doc.createElement("div");
    wrap.id = "dk-comp"; wrap.hidden = true; wrap.setAttribute("aria-label", "MINT AI");
    cv.id = "dk-comp-cv"; cv.setAttribute("aria-hidden", "true");
    hit.id = "dk-comp-hit"; hit.type = "button"; hit.className = "dk-comp-hit"; hit.title = "MINT AI: open the Command Center"; hit.setAttribute("aria-label", "MINT AI: open the Command Center");
    hint.id = "dk-comp-hint"; hint.className = "dk-comp-hint"; hint.textContent = "Click to open"; hint.setAttribute("aria-hidden", "true");
    var fx = doc.createElement("canvas");
    fx.id = "dk-comp-fx"; fx.setAttribute("aria-hidden", "true");
    wrap.appendChild(fx); wrap.appendChild(cv); wrap.appendChild(hint); wrap.appendChild(hit);
    doc.body.appendChild(wrap);
    var kidBox = doc.createElement("div");
    kidBox.className = "dk-comp-kids";
    wrap.appendChild(kidBox);

    var P = { kind: "", t0: 0, ms: 0, dir: 1 }, view = {}, heads = [], core = null, L = layout(WIN_W, WIN_H, "stand", "left"), on = false;
    var lastState = "", busySince = 0, sessSt = {}, apSt = {}, dozing = false, idle = { next: Date.now() + IDLE_MIN_MS, last: "" }, looking = null, attention = false;
    var lastM = { dx: 0, dy: 0, sc: 1, a: 1 };

    function now() { return Date.now(); }
    function stNow() { return o.state ? o.state() : {}; }
    function isStill() { return !!(o.still && o.still()); }
    function ccRoot() { return doc.getElementById("cc"); }
    function botHead() { var r = ccRoot(); return (r && r.getAttribute("data-bot-head")) || "cap"; }
    function botColors() { var r = ccRoot(), ML = window.MintLogic; return r && ML && ML.normBotColors ? ML.normBotColors(r.getAttribute("data-bot-colors") || "") : null; }
    function sessHead(s) { var ML = window.MintLogic; try { return ML && ML.botHeadFor ? ML.botHeadFor(s, ML.normBotTeam ? ML.normBotTeam((ccRoot() && ccRoot().getAttribute("data-bot-team")) || "") : {}) : null; } catch (e) { return null; } }

    function ensureCore() {
      if (core || !window.MintCoreBot) return core;
      try {
        core = window.MintCoreBot(cv, {
          desk: true, backdrop: "glow", head: botHead(), colors: botColors(),
          kids: function () { return view.sessionBots === false ? [] : kidsAt(heads, now(), L, isStill()); },
          beforeDraw: function () { frame(); },
          onWake: function () { if (dozing) { dozing = false; invoke("companion", { kind: "wake" }); } },
        });
      } catch (e) { core = null; }
      return core;
    }
    function size() {
      var W = window.innerWidth || WIN_W, H = window.innerHeight || WIN_H;
      L = layout(W, H, view.stance || "stand", view.openSide || "left", view.lean || 0);
      if (core) core.resize(L.cx, L.cy, L.R, W, H);
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      fx.width = Math.round(W * dpr); fx.height = Math.round(H * dpr);
      drawLimbs(lastM, P.kind, 0);
      place(hit, L.body.x - L.body.r, L.body.y - L.body.r, 2 * L.body.r, 2 * L.body.r);
      hint.style.left = Math.round(L.cx) + "px";
      hint.style.top = Math.round(L.hang ? L.cy + L.R + 12 : Math.max(2, L.cy - L.R - 30)) + "px";
    }
    function place(el, x, y, w, h) { el.style.left = Math.round(x) + "px"; el.style.top = Math.round(y) + "px"; el.style.width = Math.round(w) + "px"; el.style.height = Math.round(h) + "px"; }

    /** Each frame (core E's beforeDraw): the pose's motion, the bot placed with it. */
    function frame() {
      var t = now(), k = P.ms > 0 ? (t - P.t0) / P.ms : 1;
      if (P.kind && k >= 1 && P.kind !== "duck") P = { kind: "", t0: 0, ms: 0, dir: P.dir };
      var m = isStill() ? { dx: 0, dy: P.kind === "duck" ? L.R * 3 : 0, sc: 1, a: P.kind === "duck" ? 0 : 1 } : motion(P.kind, k, P.dir, L, t - P.t0);
      lastM = m;
      if (core) core.place(L.cx + m.dx, L.cy + m.dy, L.R * m.sc);
      cv.style.opacity = String(Math.round(m.a * 100) / 100);
      drawLimbs(m, P.kind, t - P.t0);
    }
    /** The legs (or arms) and the contact shadow, under the head, in the ink's colours. */
    function drawLimbs(m, kind, t) {
      var g = fx.getContext && fx.getContext("2d");
      if (!g) return;
      var dpr = fx.width / (window.innerWidth || WIN_W);
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, fx.width, fx.height); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      var dz = !!(core && core.S && core.S.doze > 0.5), lim = limbs(L, m, kind, t, dz), light = html.getAttribute("data-theme") === "light";
      var a = m ? m.a : 1;
      if (lim.shadow && lim.shadow.a > 0.01) {
        g.fillStyle = "rgba(0,0,0," + (light ? lim.shadow.a * 0.6 : lim.shadow.a).toFixed(3) + ")";
        g.beginPath(); g.ellipse(lim.shadow.x, lim.shadow.y, lim.shadow.rx, lim.shadow.ry, 0, 0, Math.PI * 2); g.fill();
      }
      g.lineCap = "round";
      [[light ? "rgba(255,255,255,.55)" : "rgba(4,6,20,.55)", 5], [light ? "rgba(32,28,70,.85)" : "rgba(222,230,255,.88)", 2.6]].forEach(function (pen) {
        g.strokeStyle = pen[0]; g.lineWidth = pen[1]; g.globalAlpha = a;
        lim.legs.forEach(function (l) { g.beginPath(); g.moveTo(l.x0, l.y0); g.lineTo(l.x1, l.y1); g.stroke(); });
      });
      g.globalAlpha = 1;
    }
    function pose(kind, ms, dir) {
      P = { kind: kind, t0: now(), ms: ms || POSE_MS[kind] || 0, dir: dir || P.dir || 1 };
      if (core && kind === "hop" && core.poke) core.poke();
    }

    /* The app's events. */
    listen("mint://companion", function (p) {
      if (!p || !p.kind) return;
      switch (p.kind) {
        case "walk": case "hop": case "out": case "in": pose(p.kind, p.ms, p.dir); break;
        case "jump": pose("", 0, p.dir); break;
        case "duck": pose("duck", POSE_MS.duck); break;
        case "pop": pose("pop", POSE_MS.pop); if (core && core.react) core.react("wake"); break;
        case "arrive": if (p.view) { view = Object.assign({}, view, p.view); size(); } break;
        case "attention": attention = true; html.classList.add("dk-comp-attn"); if (core && core.look) core.look(L.cx, L.cy - L.R * 2.2); break;
        case "attention-off": attention = false; html.classList.remove("dk-comp-attn"); break;
      }
      sendRegions(true);
    });
    listen("mint://companion-look", function (p) {
      if (!core || !core.look) return;
      if (p && p.off) { looking = null; core.look(null); return; }
      if (p && isFinite(p.x) && isFinite(p.y)) { looking = [p.x, p.y]; core.look(p.x, p.y); }
    });

    /* Clicks: the bot opens the Command Center (Peek); a session bot opens its session there. */
    hit.addEventListener("click", function (e) { e.preventDefault(); invoke("companion", { kind: "open" }); });
    kidBox.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-comp-kid]");
      if (!b) return;
      e.preventDefault();
      var key = b.getAttribute("data-comp-kid");
      invoke("companion", { kind: "open" });
      setTimeout(function () { var cc = window.__mintCC; if (cc && cc.openSession) cc.openSession(key); }, 450);
    });

    /* What happens in the Command Center, mirrored: its state, reactions, the sessions gathering. */
    function tick() {
      if (!on) return;
      var r = ccRoot(), S = window.__mintCC && window.__mintCC.S, t = now();
      var state = r ? r.getAttribute("data-state") || "idle" : "idle";
      var off = doc.getElementById("cc-offline");
      if (core) {
        if (core.setOffline) core.setOffline(!!(off && !off.hidden));
        var cs = state === "needs" ? "needs" : core.STATES && core.STATES.indexOf(state) >= 0 ? state : "idle";
        if (cs !== core.S.state) core.setState(cs);
        // a long turn done: a grin (core E hops with it)
        var ML = window.MintLogic;
        if (lastState && ML && ML.botTurnDone && ML.botTurnDone(lastState, state, busySince ? t - busySince : 0) && core.react) core.react("grin");
        busySince = state === "thinking" || state === "delegating" ? busySince || t : state === "speaking" ? busySince : 0;
        lastState = state;
        if (core.setLight) core.setLight(html.getAttribute("data-theme") === "light");
      }
      if (S) {
        var list = (S.sessions || []).map(function (s) { var c = Object.assign({}, s); c.__head = sessHead(s); return c; });
        // a session that finishes (working -> idle): a hop; an approval that goes through: a nod
        list.forEach(function (s) {
          var k = sessKey(s), p = sessSt[k];
          if (p === "busy" && s.status === "idle" && core && core.react) core.react("grin");
          sessSt[k] = s.status;
        });
        var aps = [];
        if (S.approvals && S.approvals.forEach) S.approvals.forEach(function (a) { aps.push(a); if (apSt[a.id] === "pending" && a.status === "approved" && core && core.react) core.react("nod"); apSt[a.id] = a.status; });
        heads = gather(heads, list, aps, t, view.sessionBots !== false);
        syncKidTargets();
      }
      // dozing: tell the app (it walks back to the taskbar to sleep)
      var dz = !!(core && core.S && core.S.dozeT);
      if (dz !== dozing) { dozing = dz; invoke("companion", { kind: dz ? "doze" : "wake" }); }
      // idle moments
      var pick = idlePick({ now: t, next: idle.next, last: idle.last, state: core ? core.S.state : "idle", dozing: dozing, still: isStill(), busy: !!P.kind || attention || !!looking });
      if (pick) {
        idle.next = pick.next; idle.last = pick.act;
        if (pick.act === "stretch") pose("stretch");
        else if (core && core.glance) { var side = Math.random() < 0.5 ? -1 : 1; core.glance([L.cx + side * L.W, L.cy - L.R], 1100); setTimeout(function () { if (core && core.glance) core.glance([L.cx - side * L.W, L.cy - L.R * 0.5], 1000); }, 1250); }
      }
      sendRegions(false);
    }
    /* The session bots' click targets (buttons over their heads; their regions follow them). */
    function syncKidTargets() {
      var have = {};
      Array.prototype.forEach.call(kidBox.children, function (b) { have[b.getAttribute("data-comp-kid")] = b; });
      var kids = view.sessionBots === false ? [] : kidsAt(heads, now(), L, isStill());
      kids.forEach(function (q) {
        if (q.st === "idle") return;
        var b = have[q.key];
        if (!b) {
          b = doc.createElement("button"); b.type = "button"; b.className = "dk-comp-kid"; b.setAttribute("data-comp-kid", q.key);
          var h = heads.filter(function (x) { return x.key === q.key; })[0];
          b.title = (h ? h.name : q.key) + " is waiting on you"; b.setAttribute("aria-label", b.title);
          kidBox.appendChild(b);
        }
        delete have[q.key];
        place(b, q.x - q.r - 4, q.y - q.r - 4, 2 * q.r + 8, 2 * q.r + 8);
      });
      Object.keys(have).forEach(function (k) { kidBox.removeChild(have[k]); });
    }
    var lastSig = "";
    function sendRegions(force) {
      if (!on || !o.report) return;
      var regs = regions(L, view.sessionBots === false ? [] : kidsAt(heads, now(), L, isStill()), lastM).map(function (r) { return { x: r.x, y: r.y, w: r.w, h: r.h, r: r.r }; });
      var sig = JSON.stringify(regs);
      if (!force && sig === lastSig) return;
      lastSig = sig;
      o.report(regs);
    }
    var timer = null;
    /** On (Companion, its Peek closed) or off (anything else): the bot runs only while it is out. */
    function setOn(yes, v) {
      if (v) view = Object.assign({}, view, v);
      yes = !!yes;
      wrap.hidden = !yes;
      html.classList.toggle("dk-comp-out", yes);
      if (yes && !on) {
        on = true;
        ensureCore();
        size();
        if (core) { if (core.setHead) core.setHead(botHead()); if (core.setColors) core.setColors(botColors()); }
        applyStill();
        timer = setInterval(tick, 250);
        tick();
        sendRegions(true);
      } else if (!yes && on) {
        on = false;
        clearInterval(timer);
        if (core) core.stop();
        html.classList.remove("dk-comp-attn");
      } else if (yes) size();
    }
    function applyStill() {
      if (!core || !on) return;
      var s = isStill();
      core.S.still = s || !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      if (s) { core.stop(); if (core.still) core.still(); drawLimbs(lastM, "", 0); } else core.start();
    }
    window.addEventListener("resize", function () { if (on) { size(); sendRegions(true); } });
    return {
      setOn: setOn, applyStill: applyStill, size: size,
      regions: function () { return regions(L, view.sessionBots === false ? [] : kidsAt(heads, now(), L, isStill()), lastM); },
      // For the checks and the preview (a browser has no app to send the events).
      debug: {
        pose: function (kind, ms, dir) { pose(kind, ms, dir); },
        event: function (p, name) { var fn = handlers[name || "mint://companion"]; if (fn) fn(p); },
        look: function (x, y) { if (core && core.look) core.look(x, y); },
        view: function (v) { view = Object.assign({}, view, v); size(); },
        heads: function () { return heads; },
        core: function () { return core; },
        layout: function () { return L; },
        tick: tick,
      },
    };
  }

  return {
    WIN_W: WIN_W, WIN_H: WIN_H, FOOT: FOOT, BODY_R: BODY_R, BODY_CY: BODY_CY, HANG_CY: HANG_CY, LEAN_DX: LEAN_DX, HEAD_R: HEAD_R, KID_R: KID_R,
    MAX_HEADS: MAX_HEADS, GATHER_MS: GATHER_MS, IDLE_MIN_MS: IDLE_MIN_MS, IDLE_MAX_MS: IDLE_MAX_MS, POSE_MS: POSE_MS,
    layout: layout, motion: motion, limbs: limbs, gather: gather, kidsAt: kidsAt, idlePick: idlePick, regions: regions, mount: mount,
  };
});
