"use strict";
/*
 * Eye contact (2026-10-20; mockups/eye-contact/DESIGN.md): what the Command Center (and the desktop app's
 * render mode) does with the camera module's state. The camera module (mint-presence.js) only ever says
 * "present" | "looking" | "away" (null: off) and a coarse direction for the eyes; this file:
 *
 *   - which camera: the choice made in Settings > Appearance > Eye contact (localStorage "mint-presence-camera",
 *     in the browser and in the app alike; never sent), else Automatic (the camera module decides);
 *   - decides whether it may run: OFF unless switched on -- in a browser by that browser's own switch
 *     (localStorage "mint-presence", Settings > Appearance > Eye contact); in the desktop app by the app's
 *     setting (its Settings window or the tray; the page can only switch it OFF), with the app's lock /
 *     battery / energy saver / meeting state;
 *   - the bot: core E's presence() and contact() -- the eyes meet yours and follow you, it looks up when you
 *     sit down, dozes when you walk away (presence replaces its timer); the companion bot the same;
 *   - the glance cards (desktop app): forward only while you look at this screen, dimmed otherwise;
 *   - while you are away: toasts, the app's Windows toasts and sounds are held, and when you are back ONE
 *     summary is shown (and one sound played), and the "while you were away" catch-up is asked for;
 *   - look and speak (its own switch): a voice turn on the hold-to-talk path (window.__mintLive.lookTalk);
 *     a reply playing pauses after ~1.5 s looking away, and goes on when you look back;
 *   - the indications on the bot (2026-10-21, mockups/eye-contact/indicators): a soft ring round the bot's head
 *     when you look at it, the ring filling over look and speak's 0.6 s hold (then full: it listens for your
 *     voice), and a caption under it -- "Listening — you looked and spoke" / "Paused — look back to continue"
 *     (aria-live polite). On the core, or on the companion bot when it is out on the desk. Both are drawn only:
 *     pointer-events none, never a hit region, never a glass surface (no blur behind them); reduced motion /
 *     hold still: a still ring, nothing animated. From the camera module's own state (hooks.ind); nothing sent.
 */
(function () {
  var MP = window.MintPresence, Logic = window.MintPresenceLogic;
  var cc = document.getElementById("cc");
  if (!MP || !Logic || !cc) return;
  var html = document.documentElement;
  var T = window.__TAURI__ || null;
  var DESK = !!T && html.classList.contains("cc-desk");
  var KEY = "mint-presence", CAMKEY = "mint-presence-camera"; // the camera choice: this browser's / app's own, in both
  function invoke(cmd, a) { if (!T || !T.core || !T.core.invoke) return Promise.resolve(null); try { return T.core.invoke(cmd, a || {}).catch(function () { return null; }); } catch (e) { return Promise.resolve(null); } }
  function listen(n, fn) { if (T && T.event && T.event.listen) try { T.event.listen(n, function (e) { try { fn(e.payload || {}); } catch (x) { /* never stops the page */ } }); } catch (e) { /* no events */ } }

  /* ---------------------------------------------------------------- the switches and the host */
  function browserPrefs() { var v = null; try { v = window.localStorage.getItem(KEY); } catch (e) { v = null; } return Logic.normPrefs(v); }
  var prefs = DESK ? Logic.normPrefs(null) : browserPrefs();
  var host = { hidden: false, locked: false, meeting: false, saver: false, battery: false };
  function fromApp(p) {
    var v = p && p.presence;
    if (!v) return;
    prefs = Logic.normPrefs({ cam: !!v.camera, speak: !!v.speak, saver: v.releaseOnSaver !== false });
    host = { hidden: !!p.hidden, locked: !!v.locked, meeting: !!v.meeting, saver: !!v.energySaver, battery: !!v.onBattery };
    configure();
  }
  function camChoice() { var v = null; try { v = window.localStorage.getItem(CAMKEY); } catch (e) { v = null; } return Logic.normCamChoice(v); }
  var camera = camChoice();
  window.addEventListener("storage", function (e) { if (e.key === CAMKEY || e.key === null) { camera = camChoice(); configure(); } });
  if (DESK) {
    invoke("get_state").then(function (p) { if (p) fromApp(p); });
    listen("mint://state", fromApp);
  } else {
    window.addEventListener("storage", function (e) { if (e.key === KEY) { prefs = browserPrefs(); configure(); } });
    if (navigator.getBattery) navigator.getBattery().then(function (b) {
      var up = function () { host.battery = !b.charging; configure(); };
      b.addEventListener("chargingchange", up); up();
    }, function () { /* unknown: as plugged in */ });
  }

  /** The bot's centre as fractions of the screen (the geometry for "looking at the bot"). */
  function botAt() {
    var sw = screen.width || window.innerWidth, sh = screen.height || window.innerHeight;
    var x = window.innerWidth / 2, y = window.innerHeight / 2;
    var c = window.__mintCC && window.__mintCC.core, S = c && c.S;
    if (!html.classList.contains("dk-comp-out") && S && S.dpr && c.canvas && c.canvas.getBoundingClientRect) {
      var r = c.canvas.getBoundingClientRect();
      x = r.left + S.c[0] / S.dpr; y = r.top + (S.cssH - S.c[1] / S.dpr);
    }
    return { x: (window.screenX + x) / sw, y: (window.screenY + y) / sh };
  }
  var botSaid = "";
  function configure() {
    var b = botAt();
    MP.configure({ prefs: prefs, host: host, bot: b, camera: camera });
    // Where the bot sits (two fractions of the screen), for Settings' "Show what it sees": this computer only.
    var k = Math.round(b.x * 50) / 50 + "," + Math.round(b.y * 50) / 50;
    if (k !== botSaid) { botSaid = k; try { window.localStorage.setItem("mint-presence-bot", JSON.stringify({ x: b.x, y: b.y })); } catch (e) { /* no storage */ } }
  }
  setInterval(function () { if (prefs.cam) configure(); }, 2000);

  /* ---------------------------------------------------------------- the state, applied */
  var holder = Logic.createHolder();
  var last = { state: null, gaze: null };
  function cores() {
    var out = [], c = window.__mintCC && window.__mintCC.core;
    if (c && c.S && c.S.concept === "E") out.push(c);
    return out;
  }
  function companion() { var D = window.MintDesktop; try { return D && D.companion ? D.companion() : null; } catch (e) { return null; } }
  function toBots(s) {
    cores().forEach(function (k) { if (k.presence) k.presence(s.state); if (k.contact) k.contact(s.state && s.state !== "away" ? s.gaze : null); });
    var cp = companion();
    if (cp && cp.presence) { cp.presence(s.state); cp.contact(s.state && s.state !== "away" ? s.gaze : null); }
  }
  function classes(s) {
    html.classList.toggle("mp-looking", s.state === "looking");
    html.classList.toggle("mp-present", s.state === "present");
    html.classList.toggle("mp-away", s.state === "away");
  }
  MP.on(function (s) {
    var was = last.state;
    last = s;
    classes(s);
    toBots(s);
    var sum = holder.setState(s.state);
    if (sum) deliver(sum);
    if (was === "away" && s.state && s.state !== "away") {
      var PA = window.MintProactive;
      if (PA && PA.active) PA.active(); // the "while you were away" catch-up, if anything happened
    }
    if (DESK && !!s.camera !== camSaid) { camSaid = !!s.camera; invoke("presence_status", { inUse: camSaid }); }
  });
  var camSaid = null; // what the app was last told (the tray's "camera on")
  // A core swapped in later (another concept, the page flight) gets the state too.
  setInterval(function () { if (last.state) toBots(last); }, 1000);

  /* ---------------------------------------------------------------- held while away, one summary when back */
  window.MintPresenceHold = {
    toast: function (text) { return holder.offer("toast", String(text || "")); },
    native: function (a) { return holder.offer("native", { title: a && a.title, body: a && a.body }); },
    held: function () { return holder.held(); },
  };
  if (window.MintSound && window.MintSound.heldBy) window.MintSound.heldBy(function (name) { return holder.offer("sound", name); });
  function deliver(sum) {
    if (sum.notes) {
      var old = document.getElementById("mp-sum");
      if (old) old.remove();
      var el = document.createElement("div");
      el.id = "mp-sum"; el.className = "mp-sum"; el.setAttribute("role", "status");
      el.innerHTML = '<b></b><ul></ul><button type="button" class="mp-x" aria-label="Close">×</button>';
      el.querySelector("b").textContent = sum.notes === 1 ? "While you were away" : "While you were away · " + sum.notes;
      var ul = el.querySelector("ul");
      sum.lines.forEach(function (l) { var li = document.createElement("li"); li.textContent = l; ul.appendChild(li); });
      el.querySelector(".mp-x").addEventListener("click", function () { el.remove(); });
      document.body.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.remove(); }, 12000);
      // The app's Windows toast for them: one, and only if MINT AI cannot be seen (the app decides).
      if (DESK) invoke("needs_you", { id: -(4e12 + Date.now()), title: "While you were away", body: sum.text.replace(/^While you were away: /, "").slice(0, 280) });
    }
    if (sum.sound && window.MintSound && window.MintSound.play) window.MintSound.play(sum.sound, { role: "core" });
  }

  /* ---------------------------------------------------------------- the ring and the caption on the bot */
  var NS = "http://www.w3.org/2000/svg";
  var ringEl = null, capEl = null, capTx = null, cur = null, raf = 0, armSig = "";
  function build() {
    if (ringEl) return;
    ringEl = document.createElement("div");
    ringEl.id = "mp-ring"; ringEl.className = "mp-ind mp-ring"; ringEl.setAttribute("aria-hidden", "true"); ringEl.hidden = true;
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    // the backplate (a soft band of the plate's colour, so the ring reads on any wallpaper), the track, the arc
    [["mp-rb", null], ["mp-rt", null], ["mp-ra", "100"]].forEach(function (a) {
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("class", a[0]); c.setAttribute("cx", "50"); c.setAttribute("cy", "50"); c.setAttribute("r", "45");
      if (a[1]) { c.setAttribute("pathLength", a[1]); c.setAttribute("transform", "rotate(-90 50 50)"); }
      svg.appendChild(c);
    });
    ringEl.appendChild(svg);
    capEl = document.createElement("div");
    capEl.id = "mp-caption"; capEl.className = "mp-ind mp-caption";
    capEl.setAttribute("role", "status"); capEl.setAttribute("aria-live", "polite"); capEl.setAttribute("aria-atomic", "true");
    capTx = document.createElement("span");
    capEl.appendChild(capTx);
    document.body.appendChild(ringEl); document.body.appendChild(capEl);
  }
  function still() {
    return html.classList.contains("dk-still") || !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  /** The bot's head on this page (CSS px): the core, or the companion bot while it is out. null: not on screen. */
  function head() {
    var k = null, cv = null;
    if (html.classList.contains("dk-comp-out")) {
      var cp = companion(); k = cp && cp.debug && cp.debug.core ? cp.debug.core() : null; cv = document.getElementById("dk-comp-cv");
    } else {
      var c = window.__mintCC && window.__mintCC.core; k = c; cv = c && c.canvas;
    }
    if (!k || !k.S || !cv || !cv.getBoundingClientRect) return null;
    var r = cv.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    for (var e = cv; e && e !== html; e = e.parentElement) { var cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return null; }
    var S = k.S, dpr = S.dpr || window.devicePixelRatio || 1, x, y, R;
    if (S.concept === "E" && S.c && S.cssH) { x = r.left + S.c[0] / dpr; y = r.top + S.cssH - S.c[1] / dpr + S.R / dpr * 0.12; R = S.R / dpr * 0.57; }
    else { x = r.left + r.width / 2; y = r.top + r.height / 2; R = Math.min(r.width, r.height) * 0.22; }
    if (!(R > 4) || x < -R || y < -R || x > window.innerWidth + R || y > window.innerHeight + R) return null;
    return { x: x, y: y, R: R };
  }
  function place() {
    raf = 0;
    if (!cur) return;
    var h = head(), want = !!(cur.ring && h);
    ringEl.hidden = !want;
    if (want) {
      var rr = Math.round(h.R * 1.26), d = 2 * rr;
      ringEl.style.left = Math.round(h.x - rr) + "px"; ringEl.style.top = Math.round(h.y - rr) + "px";
      ringEl.style.width = d + "px"; ringEl.style.height = d + "px";
    }
    if (cur.caption) {
      var W = window.innerWidth, H = window.innerHeight, cw = capEl.offsetWidth || 220, ch = capEl.offsetHeight || 24, x, y;
      if (h) {
        var below = h.y + h.R * 1.4 + 6;
        y = below + ch <= H - 4 ? below : Math.max(4, h.y - h.R * 1.4 - 6 - ch); // under the bot, else over it (the companion's small window)
        x = h.x - cw / 2;
      } else { // no bot on screen: next to the pill
        var p = document.getElementById("mp-cam"), pr = p && p.getBoundingClientRect();
        x = pr ? pr.left : 8; y = pr ? (pr.top > H / 2 ? pr.top - ch - 6 : pr.bottom + 6) : 8;
      }
      capEl.style.left = Math.round(Math.max(4, Math.min(W - cw - 4, x))) + "px";
      capEl.style.top = Math.round(Math.max(4, Math.min(H - ch - 4, y))) + "px";
    }
    raf = requestAnimationFrame(place); // the bot moves (the companion walks, the core breathes, Peek slides): follow it
  }
  function draw(ind) {
    build();
    cur = ind && (ind.ring || ind.caption) ? ind : null;
    var ring = cur && cur.ring, cap = cur && cur.caption;
    ringEl.className = "mp-ind mp-ring" + (ring ? " mp-r-" + ring : "") + (still() ? " mp-r-still" : "");
    // the hold filling: from where it is to full, linear over what is left of the 0.6 s (restarted only when it starts over)
    var arc = ringEl.querySelector(".mp-ra");
    if (ring === "arming" && !still()) {
      if (armSig !== "arming" || ind.arm + 0.1 < (arc.__arm || 0)) {
        arc.style.transition = "none"; arc.style.strokeDashoffset = String(100 * (1 - ind.arm));
        void arc.getBoundingClientRect();
        arc.style.transition = "stroke-dashoffset " + Math.max(60, ind.armLeft) + "ms linear";
        arc.style.strokeDashoffset = "0";
      }
    } else {
      arc.style.transition = "none";
      // ready: full; reduced motion / hold still: a still, full (dashed) ring while it arms; otherwise empty
      arc.style.strokeDashoffset = ring === "ready" || ring === "arming" ? "0" : "100";
    }
    arc.__arm = ring === "arming" ? ind.arm : 0; armSig = ring || "";
    var txt = cap ? Logic.CAPTION_TEXT[cap] : "";
    if (capTx.textContent !== txt) capTx.textContent = txt;
    capEl.className = "mp-ind mp-caption" + (cap ? " on mp-c-" + cap : "");
    html.classList.toggle("mp-capt-on", !!cap);
    if (!cur) { ringEl.hidden = true; if (raf) cancelAnimationFrame(raf); raf = 0; return; }
    if (!raf) place();
  }

  /* ---------------------------------------------------------------- look and speak, a reply's pause */
  function live() { return window.__mintLive || null; }
  function speakingNow() { var V = window.VoiceLive, c = window.__mintCC; return !!((V && V.speaking && V.speaking()) || (c && c.speaking && c.speaking())); }
  MP.hooks({
    // o.preroll: the audio from just before the speech began (mint-presence.js), so the turn has its first words
    speak: function (o) { var lv = live(); return !!(lv && lv.lookTalk && lv.lookTalk(o)); },
    // until the voice's own microphone flows, the camera module's feeds the turn (false: enough, close yours)
    feed: function (f) { var V = window.VoiceLive; return !!(V && V.feed && V.feed(f.pcm, f.level)); },
    // the look armed look and speak: the voice call opens now, so the turn does not wait for it
    warm: function () { var lv = live(); return !!(lv && lv.lookWarm && !speakingNow() && lv.lookWarm()); },
    // Voice off (Settings > Voice) or not usable here: look and speak cannot start a turn -- the pill says so.
    ready: function () { var lv = live(); return !!(lv && lv.ok && lv.ok()); },
    busy: function () { var lv = live(); return !!(lv && lv.busy && lv.busy()); },
    speaking: speakingNow,
    pause: function (on) {
      var V = window.VoiceLive, c = window.__mintCC;
      if (V && V.pause && V.active && V.active()) V.pause(on);
      if (c && c.pauseSpeaking) c.pauseSpeaking(on);
    },
    // A turn look and speak opened is still listening (latched: sent after a pause, or by the key).
    listening: function () { var lv = live(); return !!(lv && lv.latched && lv.latched()); },
    ind: function (ind) { draw(ind); },
    off: function () {
      if (DESK) { invoke("presence_off"); return; }
      var p = browserPrefs(); p.cam = false; p.speak = false;
      try { window.localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* off for this page anyway */ }
      prefs = Logic.normPrefs(p); configure();
    },
  });

  configure();
  window.MintPresenceBind = { prefs: function () { return Logic.normPrefs(prefs); }, host: function () { return Object.assign({}, host); }, botAt: botAt, last: function () { return { state: last.state, camera: !!last.camera }; } };
})();
