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
 *     a reply playing pauses after ~1.5 s looking away, and goes on when you look back.
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

  /* ---------------------------------------------------------------- look and speak, a reply's pause */
  function live() { return window.__mintLive || null; }
  MP.hooks({
    speak: function () { var lv = live(); return !!(lv && lv.lookTalk && lv.lookTalk()); },
    // Voice off (Settings > Voice) or not usable here: look and speak cannot start a turn -- the pill says so.
    ready: function () { var lv = live(); return !!(lv && lv.ok && lv.ok()); },
    busy: function () { var lv = live(); return !!(lv && lv.busy && lv.busy()); },
    speaking: function () { var V = window.VoiceLive, c = window.__mintCC; return !!((V && V.speaking && V.speaking()) || (c && c.speaking && c.speaking())); },
    pause: function (on) {
      var V = window.VoiceLive, c = window.__mintCC;
      if (V && V.pause && V.active && V.active()) V.pause(on);
      if (c && c.pauseSpeaking) c.pauseSpeaking(on);
    },
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
