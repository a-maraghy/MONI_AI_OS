"use strict";
/*
 * MINT AI's dock on every Mint OS page that is not the Command Center (M-5
 * part 1, "dock-lite"; the approved mockup scratchpad mint-dock). The markup is
 * the server's (lib/ui.js dockMarkup): only for someone who may use MINT AI.
 *
 *   - its small dotted core and state: Ready, Listening, Thinking (a turn is
 *     running), Needs you (an approval waits) -- from the Command Center's own
 *     event stream and status, nothing polled from anywhere else;
 *   - hover: what MINT AI said last, and what you said;
 *   - push to talk: hold the mic, or hold Space (not while typing). The clip is
 *     transcribed by this server and sent to MINT AI exactly like a voice turn
 *     from the Command Center (its voice-turn id, so only what was heard is
 *     sent). No live call here: that lives in the Command Center (part 2 keeps
 *     it across pages);
 *   - MINT AI's own screen actions for this tab (its ui_action, through the
 *     event stream with this tab's id): page.open -- only to a page this
 *     viewer's role may see (data-pages) -- and settings.open work here; the
 *     rest need the Command Center, and say so;
 *   - "Mint opened ..." with Undo (back) after a page.open, and the Command
 *     Center one click away.
 * No inline script or style (the CSP forbids both): positions and sizes go
 * through the CSSOM.
 */
(function () {
  var root = document.getElementById("mint-dock-root");
  if (!root || !window.fetch) return;
  // Inside the Command Center's frame (M-5 part 2) the shell's dock is the one: this page shows none.
  var framed = false;
  try { framed = window.top !== window && !!window.top.MintShell; } catch (e) { framed = false; }
  if (framed) { root.remove(); return; }
  // In the Command Center itself the dock is the shell's (mint-shell.js feeds it; no stream, no recorder of its own).
  var SHELL = root.getAttribute("data-shell") === "1";
  root.hidden = false;
  var $ = function (id) { return document.getElementById(id); };
  var dock = $("md-dock"), CSRF = root.getAttribute("data-csrf") || "";
  var PAGES_OK = " " + (root.getAttribute("data-pages") || "") + " ";
  var UA = window.UiActions;
  var reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var TAB_ID = (function () {
    var fresh = "t" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    try {
      var t = window.sessionStorage.getItem("mint-tab");
      if (!/^[A-Za-z0-9_-]{8,40}$/.test(t || "")) { t = fresh; window.sessionStorage.setItem("mint-tab", t); }
      return t;
    } catch (e) { return fresh; }
  })();
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function clip(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function firstSentences(s) { var t = String(s || "").replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim(); var m = t.match(/^.{20,220}?[.!?](\s|$)/); return clip(m ? m[0] : t, 220); }

  function api(path, body) {
    return fetch("/mint-ai/api/" + path, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": CSRF } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || "HTTP " + r.status); e.code = j.code; throw e; } return j; });
    });
  }

  /* ---------------------------------------------------------- state and caption */
  var LABEL = { idle: "Ready", listening: "Listening", thinking: "Thinking", speaking: "Speaking", needs: "Needs you" };
  var st = { busy: false, needs: {}, listening: false, cap: "Ready when you are.", you: "", at: Date.now() };
  // The shell's feed: { state, pending, cap, live, liveSince, muted }.
  var ext = { state: "idle", pending: 0, live: false, liveSince: 0, muted: false };
  var quietT = 0;
  function needN() { return SHELL ? ext.pending : Object.keys(st.needs).length; }
  function stateNow() {
    if (SHELL) return ext.pending && ext.state !== "listening" && ext.state !== "speaking" ? "needs" : LABEL[ext.state] ? ext.state : "thinking";
    return st.listening ? "listening" : needN() ? "needs" : st.busy ? "thinking" : "idle";
  }
  function paint() {
    var s = stateNow(), n = needN();
    dock.setAttribute("data-s", s);
    $("md-state-t").textContent = SHELL && ext.live && s === "idle" ? "On the call" : LABEL[s];
    dock.classList.toggle("live", SHELL && !!ext.live);
    paintLive();
    $("md-bubble").setAttribute("data-s", s);
    $("md-b-state").textContent = LABEL[s].toUpperCase();
    var nn = $("md-need-n");
    nn.hidden = !n;
    nn.textContent = n + (n === 1 ? " needs you" : " need you");
    var ask = $("md-b-ask");
    ask.hidden = !n;
    if (n) ask.textContent = (n === 1 ? "Something is" : n + " things are") + " waiting for your approval — open the Command Center to decide.";
    $("md-b-cap").textContent = st.cap;
    $("md-b-you").innerHTML = st.you ? "You: <b>" + esc(st.you) + "</b>" : "";
    wake();
  }
  function wake() {
    dock.classList.remove("quiet");
    clearTimeout(quietT);
    quietT = setTimeout(function () { if (stateNow() === "idle" && !(SHELL && ext.live) && !dock.matches(":hover")) dock.classList.add("quiet"); }, 6000);
  }
  function ago(ms) { var s = Math.round((Date.now() - ms) / 1000); return s < 5 ? "now" : s < 60 ? s + "s ago" : Math.round(s / 60) + "m ago"; }
  dock.addEventListener("mouseenter", function () { wake(); $("md-b-at").textContent = ago(st.at); $("md-bubble").classList.add("on"); });
  dock.addEventListener("mouseleave", function () { $("md-bubble").classList.remove("on"); wake(); });

  /* ---------------------------------------------------------- toasts */
  var toastT = 0;
  function toast(text, opts) {
    opts = opts || {};
    var el = $("md-toast"), act = $("md-t-act");
    $("md-t-txt").textContent = text;
    el.classList.toggle("bad", !!opts.bad);
    var no = $("md-t-no");
    if (no) no.hidden = true;
    el.classList.remove("ask");
    act.hidden = !opts.action;
    if (opts.action) { act.textContent = opts.action.label; act.onclick = function () { el.classList.remove("on"); opts.action.fn(); }; }
    el.classList.add("on");
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.remove("on"); }, opts.action ? 9000 : 4200);
  }

  /* The page's own driver: status, the event stream, MINT AI's screen actions,
   * push to talk. Not in the Command Center's shell, which drives the dock itself. */
  function pageDriver() {
    /* ---------------------------------------------------------- the events */
    // The stream replays its recent past on connect: that fills the caption, but
    // "busy" and "needs you" come from the status read just before (baseSeq).
    var baseSeq = 0;
    function replayed(ev) { return !!(ev && ev.seq && ev.seq <= baseSeq); }
    function onTurn(ev) {
      var t = ev.turn;
      if (!t || replayed(ev)) return;
      if (ev.phase === "start") st.busy = true;
      if (ev.phase === "end") st.busy = false;
      paint();
    }
    function onResult(ev) {
      var t = ev.turn;
      var txt = (t && t.result_text) || ev.text;
      if (txt) { st.cap = firstSentences(txt); st.at = ev.ts ? Date.parse(ev.ts) || Date.now() : Date.now(); }
      if (!replayed(ev)) st.busy = false;
      paint();
    }
    function onApproval(ev) {
      var a = ev.approval;
      if (!a || !a.id || replayed(ev)) return;
      if (a.status === "pending") st.needs[a.id] = true; else delete st.needs[a.id];
      paint();
    }
    function onUi(ev) {
      if (!ev || !ev.nonce || !UA) return;
      var v = UA.validate(ev.action, ev.args || {});
      if (ev.confirm) {
        // A Tier-2 change (theme, persona, voice) is confirmed in the Command
        // Center only; here it is withdrawn at once so nothing waits on it.
        api("ui/confirm", { id: ev.confirm, decision: "cancel" }).catch(function () {});
        toast("That change needs the Command Center — ask me there.", { bad: true, action: { label: "Open", fn: function () { location.assign("/mint-ai"); } } });
        return;
      }
      var ack = function (ok, why) { api("ui/ack", { nonce: ev.nonce, ok: !!ok, why: ok ? undefined : String(why || "").slice(0, 200) }).catch(function () {}); };
      if (!v.ok) return ack(false, v.why);
      if (v.action === "page.open") {
        var np = UA.navPage(v.args.page);
        if (PAGES_OK.indexOf(" " + v.args.page + " ") < 0) { toast("Not opened: " + np.label + " — your role cannot see it.", { bad: true }); return ack(false, "their role cannot open " + np.label + " (it needs " + np.perm + ")"); }
        if (location.pathname === np.url) { toast("You are on " + np.label); return ack(true); }
        ack(true);
        openPage(v.args.page, np, 900);
        return;
      }
      if (v.action === "settings.open") {
        ack(true);
        toast(ev.toast || UA.toast(v.action, v.args), { action: { label: "Open", fn: function () { location.assign(UA.pageUrl(v.args.page)); } } });
        return;
      }
      toast("That needs the Command Center open.", { bad: true, action: { label: "Open", fn: function () { location.assign("/mint-ai"); } } });
      ack(false, "that screen action needs the Command Center open; this tab is on another page (" + location.pathname + ")");
    }
    function openPage(key, np, delay) {
      try { window.sessionStorage.setItem("mint-opened", JSON.stringify({ key: key, label: np.label, from: location.pathname, at: Date.now() })); } catch (e) { /* no undo there */ }
      toast("Mint opened " + np.label);
      setTimeout(function () { location.assign(np.url); }, delay || 0);
    }
    var es = null;
    function connect() {
      if (es) es.close();
      es = new EventSource("/mint-ai/api/events?tab=" + encodeURIComponent(TAB_ID));
      var on = function (type, fn) { es.addEventListener(type, function (m) { var ev; try { ev = JSON.parse(m.data); } catch (e) { return; } fn(ev); }); };
      on("turn", onTurn);
      on("result", onResult);
      on("approval", onApproval);
      on("ui", onUi);
      es.onerror = function () { if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000); };
    }
    api("status").then(function (s) {
      st.busy = !!s.busy;
      baseSeq = Number(s.seq) || 0;
      (s.approvals || []).forEach(function (a) { if (a && a.id) st.needs[a.id] = true; });
      paint();
    }).catch(function () { st.cap = "MINT AI is not reachable right now."; paint(); }).then(connect);

    var cameBack = null; // "undo" / "go back" said soon after a page.open
    /* A page.open brought us here: say so, with Undo (back where we came from). */
    (function () {
      var o = null;
      try { o = JSON.parse(window.sessionStorage.getItem("mint-opened") || "null"); window.sessionStorage.removeItem("mint-opened"); } catch (e) { o = null; }
      if (!o || Date.now() - o.at > 20000 || !o.from) return;
      var from = String(o.from);
      if (!/^\/[A-Za-z0-9/_-]*$/.test(from)) return; // a path of this site, nothing else
      var back = function () { if (window.history.length > 1) window.history.back(); else location.assign(from); };
      cameBack = back;
      setTimeout(function () { cameBack = null; }, 60000);
      toast("Mint opened " + o.label, { action: { label: "Undo", fn: back } });
    })();

    /* ---------------------------------------------------------- push to talk */
    var rec = null, chunks = [], stream = null, t0 = 0, holding = false, sending = false;
    function newVt() { return "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
    function startTalk() {
      if (holding || sending) return;
      if (!navigator.mediaDevices || !window.MediaRecorder) { toast("This browser cannot record here.", { bad: true }); return; }
      holding = true;
      st.listening = true; st.you = ""; paint();
      $("md-mic").classList.add("rec");
      var go = stream ? Promise.resolve(stream) : navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (s) { stream = s; return s; });
      go.then(function (s) {
        if (!holding) return;
        chunks = [];
        rec = new MediaRecorder(s);
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.start();
        t0 = Date.now();
      }).catch(function (e) {
        holding = false; st.listening = false; $("md-mic").classList.remove("rec"); paint();
        toast("The microphone is not available: " + ((e && e.message) || e), { bad: true });
      });
    }
    function stopTalk() {
      if (!holding) return;
      holding = false;
      $("md-mic").classList.remove("rec");
      st.listening = false; paint();
      var r = rec;
      rec = null;
      if (!r || r.state === "inactive") return;
      var long = Date.now() - t0 >= 350, stopAt = Date.now();
      r.onstop = function () {
        if (!long || !chunks.length) { toast("Hold to talk — keep holding while you speak."); return; }
        var blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
        var fr = new FileReader();
        var ms = stopAt - t0;
        fr.onload = function () { hear(String(fr.result).split(",")[1] || "", blob.type, { ms: ms }); };
        fr.readAsDataURL(blob);
      };
      r.stop();
    }
    function hear(data, mime, level) {
      var vt = newVt();
      sending = true;
      st.cap = "…"; paint();
      api("transcribe", { data: data, mime: mime, vt: vt, level: level }).then(function (d) {
        var said = String(d.text || "").trim();
        if (!said || /^[\[(]/.test(said)) throw new Error("nothing said");
        st.you = clip(said, 120);
        if (window.VoiceStop && window.VoiceStop.heard(said)) { st.cap = "Okay."; paint(); return null; }
        if (window.VoiceStop && window.VoiceStop.undo && window.VoiceStop.undo(said) && cameBack) { st.cap = "Going back."; paint(); cameBack(); return null; }
        return api("send", { text: said, vt: vt, tab: TAB_ID }).then(function (r) {
          if (r && r.confirm) { st.cap = r.confirm.ok ? "Confirmed." : "Cancelled."; paint(); return; }
          st.busy = true; st.cap = "On it."; st.at = Date.now(); paint();
        });
      }).catch(function (e) {
        st.cap = e.message === "nothing said" ? "I didn't hear anything." : "That did not go through: " + e.message;
        paint();
      }).then(function () { sending = false; });
    }
    var mic = $("md-mic");
    mic.addEventListener("pointerdown", function (e) { e.preventDefault(); try { mic.setPointerCapture(e.pointerId); } catch (x) { /* fine */ } startTalk(); });
    mic.addEventListener("pointerup", stopTalk);
    mic.addEventListener("pointercancel", stopTalk);
    mic.addEventListener("keydown", function (e) { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); startTalk(); } });
    mic.addEventListener("keyup", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); stopTalk(); } });
    function typing(el) { return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName || ""))); }
    document.addEventListener("keydown", function (e) {
      if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      e.preventDefault();
      startTalk();
    });
    document.addEventListener("keyup", function (e) { if (e.code === "Space" && holding) { e.preventDefault(); stopTalk(); } });
    window.addEventListener("blur", stopTalk);

    return { openPage: openPage };
  }

  /* ---------------------------------------------------------- the small core (concept C, 2D) */
  var cv = $("md-orb-c"), g = cv.getContext("2d"), PI = Math.PI;
  function points(n, s) {
    var dir = new Float32Array(n * 3), rnd = new Float32Array(n), ga = PI * (3 - Math.sqrt(5)), sd = s;
    function r_() { sd = (sd * 16807) % 2147483647; return sd / 2147483647; }
    for (var i = 0; i < n; i++) {
      var y = 1 - (i + 0.5) / n * 2, rad = Math.sqrt(1 - y * y), th = ga * i;
      dir[i * 3] = Math.cos(th) * rad; dir[i * 3 + 1] = y; dir[i * 3 + 2] = Math.sin(th) * rad; rnd[i] = r_();
    }
    return { dir: dir, rnd: rnd, n: n };
  }
  var P = points(420, 7), DPR = Math.min(2, window.devicePixelRatio || 1), t = 0, last = 0, W = { rip: 0, gal: 0, need: 0 }, rot = 0;
  cv.width = 68 * DPR; cv.height = 68 * DPR;
  function isLight() {
    var th = document.documentElement.getAttribute("data-theme");
    if (th) return th === "light";
    return !(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function mix3(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
  function col(c) { return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")"; }
  function drawOrb() {
    var light = isLight(), M = light ? [0, 143, 102] : [0, 230, 165], V = light ? [115, 33, 196] : [153, 77, 255], A = light ? [204, 115, 0] : [250, 189, 77];
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, 68, 68);
    var cx = 34, cy = 34, R = 19, cr = Math.cos(rot), sr = Math.sin(rot), base = light ? 0.16 : 0.07;
    for (var i = 0; i < P.n; i++) {
      var dx = P.dir[i * 3], dy = P.dir[i * 3 + 1], dz = P.dir[i * 3 + 2], r1 = P.rnd[i];
      var r = 1 + 0.03 * Math.sin(t * 1.05) + W.rip * 0.12 * Math.sin(Math.acos(dy) * 8 - t * 7);
      var X = (cr * dx + sr * dz) * r, Y = dy * r, Z = (-sr * dx + cr * dz) * r;
      if (W.gal > 0.01) { var ga = r1 * 6.3 - t * 1.2; X += (Math.cos(ga) * r1 - X) * W.gal * 0.7; Z += (Math.sin(ga) * r1 - Z) * W.gal * 0.7; Y *= 1 - W.gal * 0.6; }
      var Y2 = Y * 0.955 - Z * 0.296, Z2 = Y * 0.296 + Z * 0.955, persp = 3.3 / (3.3 - Z2);
      var depth = Math.max(0, Math.min(1, (Z2 + 1.25) / 2.5)), gc = Math.max(0, Math.min(1, 0.5 + 0.62 * (X * 0.6 + Y2 * 0.6)));
      g.globalAlpha = Math.min(1, base + (1 - base) * Math.pow(depth, 1.4));
      g.fillStyle = W.need > 0.3 && r1 < W.need * 0.6 ? col(A) : col(mix3(M, V, gc));
      var sz = 1.05 * (0.6 + 1.2 * depth * depth) * persp;
      g.fillRect(cx + X * R * persp - sz / 2, cy - Y2 * R * persp - sz / 2, sz, sz);
    }
    g.globalAlpha = 1;
  }
  function frame(now) {
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    t += dt;
    var s = stateNow(), k = 1 - Math.exp(-dt * 2.6);
    W.rip += ((s === "listening" || s === "speaking" ? 1 : 0) - W.rip) * k;
    W.gal += ((s === "thinking" ? 1 : 0) - W.gal) * k;
    W.need += ((s === "needs" ? 1 : 0) - W.need) * k;
    rot += dt * (0.13 + 0.25 * W.gal);
    drawOrb();
    if (!document.hidden && !(SHELL && dock.classList.contains("off"))) raf = requestAnimationFrame(frame);
    else raf = 0;
  }
  var raf = 0;
  if (reduced) { t = 2.4; drawOrb(); } else if (!(SHELL && dock.classList.contains("off"))) raf = requestAnimationFrame(frame);
  document.addEventListener("visibilitychange", function () { if (!document.hidden && !raf && !reduced && !(SHELL && dock.classList.contains("off"))) { last = 0; raf = requestAnimationFrame(frame); } });
  document.addEventListener("moni-theme", function () { if (reduced) drawOrb(); });

  /* ---------------------------------------------------------- the live call's line (shell only) */
  var liveT = 0;
  function paintLive() {
    var tag = $("md-live-t");
    if (!tag) return;
    clearInterval(liveT);
    if (!(SHELL && ext.live)) return;
    var tick = function () {
      var s = Math.max(0, Math.floor((Date.now() - (ext.liveSince || Date.now())) / 1000));
      tag.textContent = "LIVE " + String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    };
    tick();
    liveT = setInterval(tick, 1000);
    $("md-mic").classList.toggle("muted", !!ext.muted);
  }

  var api_ = { tab: TAB_ID, state: stateNow, toast: toast };
  if (!SHELL) {
    var drv = pageDriver();
    api_.openPage = function (k) { var np = UA && UA.navPage(k); if (np) drv.openPage(k, np, 0); };
  } else {
    // The shell's dock: the mic and Space are the Command Center's own (its push to talk, or,
    // on a live call, mute); the orb, the name and expand bring the Command Center back.
    var space = function (type) { document.dispatchEvent(new KeyboardEvent(type, { code: "Space", key: " ", bubbles: true, cancelable: true })); };
    var down = false;
    var mic = $("md-mic");
    mic.addEventListener("pointerdown", function (e) { e.preventDefault(); try { mic.setPointerCapture(e.pointerId); } catch (x) { /* fine */ } if (!down) { down = true; space("keydown"); } });
    var up = function () { if (down) { down = false; space("keyup"); } };
    mic.addEventListener("pointerup", up);
    mic.addEventListener("pointercancel", up);
    mic.addEventListener("keydown", function (e) { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); e.stopPropagation(); if (!down) { down = true; space("keydown"); } } });
    mic.addEventListener("keyup", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); up(); } });
    ["md-orb", "md-txt", "md-exp"].forEach(function (id) {
      $(id).addEventListener("click", function (e) { if (window.MintShell && window.MintShell.active()) { e.preventDefault(); window.MintShell.expand(); } });
    });
    var end = $("md-end");
    if (end) end.addEventListener("click", function () { var b = document.getElementById("cc-live-end"); if (b) b.click(); });
    /** mint-shell.js: what the Command Center is doing now. */
    api_.feed = function (f) {
      var was = ext.state + "|" + ext.pending + "|" + ext.cap + "|" + ext.live + "|" + ext.muted;
      ext.state = f.state || "idle"; ext.pending = f.pending || 0; ext.live = !!f.live; ext.muted = !!f.muted;
      if (f.live && !ext.liveSince) ext.liveSince = f.liveSince || Date.now();
      if (!f.live) ext.liveSince = 0;
      if (f.cap && f.cap !== st.cap) { st.cap = f.cap; st.at = Date.now(); }
      ext.cap = st.cap;
      if (was !== ext.state + "|" + ext.pending + "|" + ext.cap + "|" + ext.live + "|" + ext.muted) paint();
    };
    /** Shown (a page is up) or hidden (the Command Center is). The core only draws while shown. */
    api_.show = function (on) {
      dock.classList.toggle("off", !on);
      if (!on) { $("md-bubble").classList.remove("on"); $("md-toast").classList.remove("on"); }
      if (on && !raf && !reduced) { last = 0; raf = requestAnimationFrame(frame); }
      if (on && reduced) drawOrb();
    };
    /**
     * A Tier-2 confirm while a page is up (theme, persona, voice): Confirm / Cancel on the dock, so the
     * administrator stays on the page. It stays until answered, or until the server says it expired.
     */
    api_.confirm = function (text, onYes, onNo) {
      var el = $("md-toast"), act = $("md-t-act"), no = $("md-t-no");
      clearTimeout(toastT);
      var open = true;
      var done = function () { if (!open) return; open = false; el.classList.remove("on", "ask"); act.hidden = true; no.hidden = true; };
      $("md-t-txt").textContent = text;
      el.classList.remove("bad");
      el.classList.add("on", "ask");
      act.hidden = false; act.textContent = "Confirm"; act.onclick = function () { done(); onYes(); };
      no.hidden = false; no.textContent = "Cancel"; no.onclick = function () { done(); onNo(); };
      wake();
      return {
        remove: done,
        expired: function (msg) {
          if (!open) return;
          act.hidden = true; no.hidden = true;
          $("md-t-txt").textContent = msg;
          el.classList.add("bad");
          toastT = setTimeout(done, 4000);
        },
      };
    };
    api_.orbRect = function () { var r = $("md-orb").getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, R: r.width * 0.36 }; };
  }
  paint();
  window.__mintDock = api_;
})();
