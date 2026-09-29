"use strict";
/*
 * The MINT AI Command Center, live (the simplified Mint layout).
 *
 * Reads the JSON API under /mint-ai/api/ once on load (overview, the turns,
 * approvals, delegations and inbound ledgers, then missions, decisions,
 * watchers, rules, standing orders and cost through cc-panels.js), then follows
 * the supervisor's event stream over Server-Sent Events. Everything on screen
 * is built here from that data, and every string that came from the server
 * goes through esc() or the console's markdown renderer (MD, from console.js),
 * which escapes first. Sizes that depend on data are set through element.style
 * after the markup is in place (applyBars), never as a style attribute: the
 * CSP would refuse it.
 *
 * The screen: the MINT AI core in the middle (mint-core.js, placed and fed by
 * cc-map.js) with the live sessions as points on its orbit; one caption under
 * it; one pill composer; the dock on the left opening sheets from the right;
 * one decision card top right. What the core and the caption show is decided
 * in one place, cc-logic.js (MintLogic.caption), from real events -- the
 * running turn and its current step, a SendMessage delegation and its target
 * (the stream of dots flies to that session), the sentence being read aloud
 * (its words appear as it is spoken), the microphone, and anything waiting
 * for a decision.
 *
 * The missions board, the Decisions inbox, Rules and Watchers, the standing
 * orders, the cost view, the session deep view and the Ctrl+K palette are
 * cc-panels.js, handed this file's helpers and state (the CC object below).
 *
 * Voice goes through OpenAI, on the server only: the page posts its recording
 * to /mint-ai/api/transcribe and each sentence of a reply to /mint-ai/api/speak,
 * whose audio streams back as PCM chunks (NDJSON) and starts playing with the
 * first one, with the same end-of-utterance detection and barge-in.
 * No key set, no voice: the controls say where to add one.
 *
 * Only this VPS is shown. The live Odoo server appears nowhere on this page.
 *
 * Loaded only on the Command Center (html.cc-page); returns at once elsewhere.
 */
(function () {
  var root = document.getElementById("cc");
  if (!root) return;

  var CSRF = root.getAttribute("data-csrf") || "";
  var VIEWER = root.getAttribute("data-viewer") || "you";
  var READY = root.getAttribute("data-voice-ready") === "1";   // an OpenAI key is set
  var VOICE = root.getAttribute("data-voice") || "";
  // The voice front desk (GPT, trial): switched on by an administrator in
  // Settings. When off -- the default -- nothing below changes behaviour.
  var DESK = READY && root.getAttribute("data-voice-desk") === "1";

  /* ================================================================ helpers */

  function $(id) { return document.getElementById(id); }
  /** The mic's mode from what this browser remembered: push to talk unless it chose hands-free. */
  function voiceModeFrom(stored) {
    return stored === "handsfree" ? "handsfree" : "ptt";
  }
  /** A live conversation is on (the live integration block, further down; never in a sandbox without it). */
  function liveActive() { return typeof LiveUI !== "undefined" && !!(LiveUI && LiveUI.active); }
  /** The live call's microphone or speaker loudness, for the core. */
  function liveLevel(k) { return liveActive() ? Math.min(1, (LiveUI[k] || 0) * (k === "mic" ? 3 : 2.5)) : 0; }
  /** What was said is only "stop listening" or the like (public/voice-stop.js; without it, never). */
  function isStopCommand(said) {
    return !!(window.VoiceStop && window.VoiceStop.heard(said));
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(name, cls) {
    return '<svg class="cc-i' + (cls ? " " + cls : "") + '" aria-hidden="true" focusable="false"><use href="#cc-i-' + name + '"/></svg>';
  }
  function md(text) {
    try {
      if (typeof window.MD === "function") return window.MD(String(text || ""));
    } catch (e) { /* fall through to plain text */ }
    return "<p>" + esc(text).replace(/\n/g, "<br>") + "</p>";
  }
  function num(n) { return n == null || !isFinite(n) ? "—" : Number(n).toLocaleString("en-US"); }
  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function firstLine(s) { return String(s || "").split("\n").filter(function (l) { return l.trim(); })[0] || ""; }
  /** Dollars, to the cent; under a cent shows as <$0.01 rather than $0.00. */
  function money(v) {
    if (v == null || !isFinite(v)) return "—";
    v = Number(v);
    if (v > 0 && v < 0.01) return "<$0.01";
    return "$" + v.toFixed(2);
  }
  /** Plain text of a markdown reply, for one-line previews. */
  function plain(s) {
    return String(s || "").replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*[#>*+-]+\s*/gm, "").replace(/[*_~|]/g, "").replace(/\s+/g, " ").trim();
  }

  var TZ = "Africa/Cairo";
  var fmtHMS, fmtHM, fmtDate, fmtDay;
  try {
    fmtHMS = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    fmtHM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
    fmtDate = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
    fmtDay = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" });
  } catch (e) {
    fmtHMS = fmtHM = fmtDate = fmtDay = new Intl.DateTimeFormat("en-GB");
  }
  function t(iso) { var d = iso ? new Date(iso) : null; return d && isFinite(d) ? d : null; }
  function hm(iso) {
    var d = t(iso); if (!d) return "";
    // Older than today: the date says more than the time.
    return Date.now() - d.getTime() > 20 * 3600 * 1000 ? fmtDay.format(d) : fmtHM.format(d);
  }
  function hms(iso) { var d = t(iso); return d ? fmtHMS.format(d) : ""; }
  /** Day and time together, for anything that may be days away (next runs). */
  function when(iso) { var d = t(iso); return d ? fmtDay.format(d) + " " + fmtHM.format(d) : ""; }
  function ago(iso) {
    var d = t(iso); if (!d) return "";
    var s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function dur(ms) {
    if (ms == null || !isFinite(ms)) return "—";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
    return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
  }
  function upDur(sec) {
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? "up " + d + "d " + h + "h" : h ? "up " + h + "h " + m + "m" : "up " + m + "m";
  }
  function bytesGB(n) { return n ? Math.round(n / 1073741824) + " GB" : ""; }
  function modelLabel(id) {
    var m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(String(id || ""));
    if (!m) return String(id || "");
    return m[1].charAt(0).toUpperCase() + m[1].slice(1) + " " + m[2] + (m[3] && m[3].length < 3 ? "." + m[3] : "");
  }
  function pct(v) { return Math.max(0, Math.min(100, Number(v) || 0)); }
  /** Widths, custom properties and offsets that depend on data, set after the
      markup is in place (a style attribute would be refused by the CSP). */
  function applyBars(el) {
    if (!el) return;
    var i, list = el.querySelectorAll("[data-w]");
    for (i = 0; i < list.length; i++) list[i].style.width = pct(list[i].getAttribute("data-w")) + "%";
    list = el.querySelectorAll("[data-v]");
    for (i = 0; i < list.length; i++) list[i].style.setProperty("--v", pct(list[i].getAttribute("data-v")) + "%");
    list = el.querySelectorAll("[data-l]");
    for (i = 0; i < list.length; i++) list[i].style.left = pct(list[i].getAttribute("data-l")) + "%";
  }

  var toastTimer = 0;
  function toast(text, bad) {
    var old = document.querySelector(".cc-toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "cc-toast" + (bad ? " bad" : "");
    el.setAttribute("role", "status");
    el.textContent = text;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, bad ? 5000 : 2600);
  }

  /**
   * A streamed API call (NDJSON): `onEvent` gets each object as it arrives;
   * resolves with the last {type:"done"}. A refusal before the stream starts
   * rejects like api() does, with .status and .code.
   */
  function apiStream(path, body, onEvent) {
    return fetch("/mint-ai/api/" + path, {
      method: "POST", credentials: "same-origin",
      headers: { Accept: "application/x-ndjson", "Content-Type": "application/json", "X-CSRF-Token": CSRF },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error(j.error || "HTTP " + r.status);
          e.status = r.status; e.code = j.code;
          throw e;
        });
      }
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = "", done = null;
      function take(line) {
        if (!line.trim()) return;
        var ev;
        try { ev = JSON.parse(line); } catch (e) { return; }
        if (ev.type === "error" || ev.type === "refused") { var err = new Error(ev.error || "error"); err.code = ev.code; err.refused = ev.type === "refused"; throw err; }
        if (ev.type === "done") done = ev;
        onEvent(ev);
      }
      function pump() {
        return reader.read().then(function (x) {
          if (x.value) {
            buf += dec.decode(x.value, { stream: true });
            var i;
            while ((i = buf.indexOf("\n")) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
          }
          if (x.done) { take(buf); return done || {}; }
          return pump();
        });
      }
      return pump();
    });
  }

  /** JSON API call. Writes carry the CSRF token in a header. */
  function api(path, opts) {
    opts = opts || {};
    var init = { credentials: "same-origin", headers: { Accept: "application/json" } };
    if (opts.body !== undefined) {
      init.method = "POST";
      init.headers["Content-Type"] = "application/json";
      init.headers["X-CSRF-Token"] = CSRF;
      init.body = JSON.stringify(opts.body);
    }
    return fetch("/mint-ai/api/" + path, init).then(function (r) {
      if (opts.raw) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || "HTTP " + r.status); });
        return r;
      }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error(j.error || "HTTP " + r.status);
          e.status = r.status; e.code = j.code;
          throw e;
        }
        return j;
      });
    });
  }

  /* ================================================================ state */

  var S = {
    online: false,
    offlineMsg: "",
    status: null,          // the supervisor's status
    sessions: [],          // claude agents --json merged with the ledger
    memory: null,
    agents: null,
    turns: new Map(),      // id -> turn row + live parts
    turnOrder: [],         // ids, oldest first
    oldestTurn: null,
    delegations: new Map(),
    approvals: new Map(),
    inbound: new Map(),
    feed: [],              // {key, ts, kind, html}
    steps: null,           // {turn_id, steps}
    loadSeq: 0,            // events at or below this were replayed from the ring
    lastSeq: 0,
    skew: 0,               // server clock minus ours, ms
    target: "auto",
    delegatingUntil: 0,
    delegTo: "",           // the session the last delegation went to, and what it said
    delegText: "",
    spoken: "",            // the sentence being read aloud now
    pane: null,            // the open sheet: conv | sessions | missions | dec | tl | rules | orders | cost | machine | everything
  };
  var ML = window.MintLogic;

  function nowServer() { return Date.now() + S.skew; }

  /* The assistant's names. It is MINT AI now (MONI AI until 2026-09-29, MONI
     Bot before that); "moni-ai" is its internal id. Anything that asks "is this
     name us?" accepts all of them, so a session or a note still using the old
     name is never taken for another session. */
  var AI_NAME = "MINT AI";
  function isAiName(n) {
    var k = String(n == null ? "" : n).replace(/\s*\[[0-9a-f]{4,12}\]\s*$/i, "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
    return k === "mint ai" || k === "moni ai" || k === "moni bot";
  }
  /** How an actor / sender is shown: the assistant by its current name, anyone else as they are. */
  function aiLabel(n) { return isAiName(n) ? AI_NAME : n; }
  function liveSessions() { return S.sessions.filter(function (s) { return !s.self && !isAiName(s.name); }); }
  /** Take a sessions list from the server. MINT AI itself is always shown,
      even when the list does not carry it (then it is made from the status),
      and a session the event did not tag with its mission gets it from the
      missions board. */
  function setSessions(list) {
    list = (list || []).slice();
    var st = S.status || {};
    if (!list.some(function (s) { return s.self; }) && (st.session_id || (st.process && st.process.pid))) {
      list.push({ self: true, synthetic: true, name: "MINT AI", pid: st.process && st.process.pid, session_id: st.session_id || null,
        cwd: "/root/moni-ai", where: "headless · supervisor", kind: "supervisor", status: st.busy ? "busy" : "idle", subagents: [],
        started_at: st.process && st.process.started_at, cost_today_usd_est: st.cost_today ? st.cost_today.moni_ai_usd : null });
    }
    list.forEach(function (s) {
      if ((!s.mission || s.mission.derived) && !s.self && s.name && typeof P !== "undefined" && P) s.mission = P.missionFor(s.name);
      if (s.self && s.cost_today_usd_est == null && st.cost_today) s.cost_today_usd_est = st.cost_today.moni_ai_usd;
    });
    S.sessions = list;
  }
  function selfSession() { return S.sessions.filter(function (s) { return s.self; })[0] || null; }
  function sessState(s) { return s.status === "busy" ? "working" : s.status === "waiting" ? "waiting" : "idle"; }
  function sessionFor(d) {
    var list = S.sessions;
    for (var i = 0; i < list.length; i++) if (d.target_pid && list[i].pid === d.target_pid) return list[i];
    for (var j = 0; j < list.length; j++) if (list[j].name && list[j].name === d.target_name && !list[j].self) return list[j];
    return null;
  }
  function sessionNamed(name) {
    name = String(name || "").replace(/\s*\[[0-9a-f]+\]$/, "");
    for (var i = 0; i < S.sessions.length; i++) if (!S.sessions[i].self && S.sessions[i].name === name) return S.sessions[i];
    return null;
  }
  function pendingApprovals() {
    var out = [];
    S.approvals.forEach(function (a) { if (a.status === "pending") out.push(a); });
    return out;
  }

  /* ================================================================ clock */

  function tick() {
    var d = new Date();
    $("cc-clock").textContent = fmtHM.format(d);
    $("cc-clock-date").textContent = fmtDate.format(d) + " · Cairo";
    tickApprovals();
    tickNeed();
  }

  /* ================================================================ theme
     The switch itself is the shell's (app.js); the canvas only has to repaint
     in the new palette when the theme, or the system's, changes. */

  document.addEventListener("moni-theme", function () { Orb.palette(); });

  /* ================================================================ the core and its orbit */

  var Orb = window.MoniMap({
    root: root, stage: $("cc-stage"), canvas: $("cc-core"), orbit: $("cc-orbit"), ring: $("cc-ring"), halo: $("cc-halo"), spark: $("cc-spark"),
  }, {
    onClick: function (key) { openSheet("sessions"); highlightSess(key); },
  });
  window.__mintCC = { core: Orb.core, orbit: Orb, S: S };

  /* ---- the core setting: A dotted sphere, B Siri fluid, C hybrid. The
     server rendered the saved one as data-core; this browser remembers it too
     (the fallback if the attribute is ever missing), and a switch here saves it
     for the person and swaps the running core in place, no reload. ---- */
  var CORE_KEY = "mint-core";
  function coreNow() { return Orb.core.S.concept; }
  (function () {
    var c = root.getAttribute("data-core");
    if (!c) { try { c = window.localStorage.getItem(CORE_KEY); } catch (e) { c = null; } }
    c = ML.normCore(c);
    Orb.setConcept(c);
    try { window.localStorage.setItem(CORE_KEY, c); } catch (e) { /* not remembered here; the server has it */ }
  })();
  function paintCoreSwitches() {
    var bs = document.querySelectorAll("[data-core-set]");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-checked", String(bs[i].getAttribute("data-core-set") === coreNow()));
  }
  function setCoreChoice(c) {
    c = ML.normCore(c);
    var was = coreNow();
    Orb.setConcept(c);
    paintCoreSwitches();
    try { window.localStorage.setItem(CORE_KEY, c); } catch (e) { /* the server keeps it */ }
    if (c === was) return Promise.resolve(c);
    return api("prefs/core", { body: { core: c } }).then(function (r) {
      toast("MINT AI core: " + c + " · " + ML.CORES[c]);
      return r && r.core;
    }).catch(function (e) {
      toast("The core switched here, but was not saved: " + e.message, true);
    });
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-core-set]");
    if (b) { e.preventDefault(); setCoreChoice(b.getAttribute("data-core-set")); }
  });

  /* ================================================================ core state
     One place decides what the core shows and what the caption says:
     MintLogic.caption, from a snapshot of what is really happening. */

  var stateTimer = 0;
  function failedServices() {
    var m = S.status && S.status.machine;
    return (m && m.services && m.services.failed) || [];
  }
  /** The running turn's current step, in words (the last one still running). */
  function currentStep() {
    var cur = S.status && S.status.current_turn;
    if (!cur) return "";
    var steps = S.steps && S.steps.turn_id === cur.id ? S.steps.steps : cur.steps || [];
    for (var i = (steps || []).length - 1; i >= 0; i--) {
      var st = steps[i];
      if (st && (st.st === "run" || st.st === "wait")) return STEP_NAMES[st.txt] || st.txt;
    }
    var last = steps && steps.length ? steps[steps.length - 1] : null;
    return last ? STEP_NAMES[last.txt] || last.txt : "";
  }
  /** A session MINT AI is waiting on: an open delegation from the running turn. */
  function waitingOn() {
    var cur = S.status && S.status.current_turn, out = "";
    if (!cur) return "";
    S.delegations.forEach(function (d) { if (d.turn_id === cur.id && (d.status === "sent" || d.status === "working")) out = d.target_name || out; });
    return out;
  }
  function lastReplyTurn() {
    for (var i = S.turnOrder.length - 1; i >= 0; i--) {
      var x = S.turns.get(S.turnOrder[i]);
      if (x && x.source !== "system" && x.status !== "running" && aiText(x)) return x;
    }
    return null;
  }
  function snapshot() {
    var busy = !!(S.status && S.status.busy), q = needQueue();
    var cur = S.status && S.status.current_turn, tr = cur ? S.turns.get(cur.id) : null;
    var last = lastReplyTurn(), vb = $("cc-vb-text");
    var dg = Date.now() < S.delegatingUntil;
    var snap = {
      online: S.online, offlineMsg: S.offlineMsg,
      listening: Voice.listening, speaking: Voice.speaking, voiceLive: $("cc-dock").classList.contains("voice-on"),
      voiceText: vb ? vb.textContent : "", spoken: S.spoken,
      busy: busy, stepText: currentStep(), waitingOn: waitingOn(), streamText: tr && tr.status === "running" && !Voice.speaking ? aiText(tr) : "",
      queued: (S.status && S.status.queue_depth) || 0,
      delegatingTo: dg ? S.delegTo : "", delegation: dg ? S.delegText : "",
      pending: q.length, needTitle: q.length ? (ML.card(q[0]) || {}).title : "",
      lastReply: last ? ML.gist(aiText(last)) : "",
    };
    return liveSnapshot(snap);
  }
  var capSig = "";
  function paintCaption(snap) {
    var c = ML.caption(snap || snapshot());
    var cs = $("cc-cap-state");
    cs.setAttribute("data-s", S.online ? c.state : "offline");
    $("cc-cap-label").textContent = c.label;
    var line = $("cc-cap"), sig = c.state + "|" + c.text + "|" + c.interim;
    if (sig !== capSig) {
      capSig = sig;
      line.classList.toggle("interim", !!c.interim);
      if (c.words && !reducedMotion()) {
        // The sentence being spoken: each word fades in at speaking pace.
        line.textContent = "";
        c.text.split(" ").forEach(function (w, i) {
          var sp = document.createElement("span");
          sp.className = "w";
          sp.textContent = w + " ";
          sp.style.animationDelay = Math.round(i * 300) + "ms";
          line.appendChild(sp);
        });
      } else line.textContent = c.text;
    }
    var last = lastReplyTurn();
    var more = $("cc-cap-more");
    more.hidden = !(c.state === "idle" && S.online && last);
    if (last) $("cc-cap-at").textContent = hm(last.ended_at || last.started_at || last.created_at);
    return c;
  }
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function paintState() {
    if (!Voice.speaking) S.spoken = "";
    var snap = snapshot();
    var st = ML.coreState(snap);
    Orb.setState(st);
    paintCaption(snap);
    renderNeed();
    var pending = snap.pending;
    var chip = $("cc-sys"), cdot = $("cc-sys-dot");
    var lng = chip.querySelector(".long"), sht = chip.querySelector(".short");
    function lab(l, s) { lng.textContent = l; sht.textContent = s; }
    chip.className = "cc-sys-chip";
    var proc = S.status && S.status.process;
    var failed = failedServices().length;
    if (!S.online) {
      chip.classList.add("bad"); cdot.className = "cc-dot bad"; lab("MINT AI offline", "Offline");
    } else if (proc && proc.state !== "ready") {
      chip.classList.add(proc.state === "starting" || proc.state === "stopping" ? "warn" : "bad");
      cdot.className = "cc-dot warn"; lab("MINT AI " + proc.state, proc.state);
    } else if (failed) {
      chip.classList.add("warn"); cdot.className = "cc-dot warn"; lab(failed + " failed service" + (failed === 1 ? "" : "s"), failed + " issue" + (failed === 1 ? "" : "s"));
    } else if (S.status && S.status.busy) {
      cdot.className = "cc-dot work"; lab("MINT AI working", "Working");
    } else {
      cdot.className = "cc-dot"; lab("All systems nominal", "Nominal");
    }
    $("cc-stop").hidden = !(S.status && S.status.busy);
    clearTimeout(stateTimer);
    if (S.delegatingUntil > Date.now()) stateTimer = setTimeout(paintState, S.delegatingUntil - Date.now() + 30);
  }

  /* ================================================================ left rail */

  function renderRail() {
    renderMachine();
    renderCore();
  }

  /** This VPS: vitals and failed services from status.machine (older
      supervisors only send status.vitals, which is used instead). */
  function renderMachine() {
    var st = S.status || {};
    var m = st.machine || {};
    var v = m.vitals || st.vitals || {};
    var host = m.host || v.host || "";
    $("cc-host").textContent = "This VPS";
    var sv = m.services || null;
    var failed = (sv && sv.failed) || [];
    var badge = $("cc-mach-badge");
    if (!S.online && !st.vitals) { badge.className = "cc-badge b-mute"; badge.textContent = "unknown"; }
    else if (failed.length) { badge.className = "cc-badge b-warn"; badge.textContent = failed.length + " failed"; }
    else { badge.className = "cc-badge b-ok"; badge.textContent = "healthy"; }
    var sub = [host || "this box"];
    if (v.uptime_s) sub.push(upDur(v.uptime_s));
    if (v.cpus) sub.push(v.cpus + " vCPU");
    if (v.mem && v.mem.total) sub.push(bytesGB(v.mem.total));
    $("cc-mach-sub").textContent = sub.join(" · ");
    function bar(key, label, val) {
      var el = document.querySelector('[data-mb="' + key + '"]');
      if (!el) return;
      el.firstChild.nodeValue = label + " " + (val == null ? "—" : Math.round(pct(val)) + "%");
      el.classList.toggle("hot", val != null && val > 75);
      el.style.setProperty("--v", (val == null ? 0 : pct(val)) + "%");
    }
    bar("cpu", "CPU", v.cpu_pct);
    bar("ram", "RAM", v.mem && v.mem.pct);
    bar("disk", "DISK", v.disk && v.disk.pct);
    var note = $("cc-mach-note");
    note.className = "cc-mach-note" + (failed.length ? " bad" : "");
    if (failed.length) {
      var f = failed[0];
      note.innerHTML = ic("alert") + "<span>" + esc(String(f.unit || "a service").replace(/\.service$/, "")) + " failed" + (f.since ? " " + esc(hm(f.since)) : "") +
        (failed.length > 1 ? " · +" + (failed.length - 1) + " more" : "") + "</span>";
      note.title = failed.map(function (x) { return x.unit + (x.since ? " since " + hm(x.since) : ""); }).join("\n");
    } else if (sv && sv.total) {
      note.innerHTML = ic("check") + "<span>" + esc(sv.up + " of " + sv.total + " services up") + "</span>";
      note.title = "";
    } else {
      note.innerHTML = ic("clock") + "<span>" + esc(v.load ? "load " + v.load.map(function (x) { return Number(x).toFixed(2); }).join(" · ") : "waiting for vitals") + "</span>";
      note.title = "";
    }
    $("cc-mach-aside").textContent = m.at || sv && sv.at ? "checked " + hm(m.at || sv.at) : "this VPS";
  }

  function setCore(key, val, cls, title) {
    var cell = document.querySelector('[data-cell="' + key + '"]');
    if (!cell) return;
    var b = cell.querySelector("[data-st]");
    b.textContent = val;
    b.className = cls || "";
    cell.title = title || "";
  }

  function renderCore() {
    var st = S.status || {};
    var proc = st.process || {};
    var c = st.counts || {};
    $("cc-core-aside").textContent = proc.model ? modelLabel(proc.model) + (proc.effort ? " · " + proc.effort : "") : "—";
    if (!S.online) setCore("core", "offline", "bad", S.offlineMsg || "supervisor unreachable");
    else setCore("core", proc.state === "ready" ? "online" : proc.state || "—", proc.state === "ready" ? "ok" : "warn", "MINT AI's own Claude session");

    var live = liveSessions();
    var cnt = { working: 0, waiting: 0, idle: 0 };
    live.forEach(function (s) { cnt[sessState(s)]++; });
    setCore("sessions", live.length + " live", "", cnt.working + " working · " + cnt.waiting + " waiting · " + cnt.idle + " idle");

    var ag = S.agents;
    if (ag && !ag.error && ag.total != null) {
      var down = ag.total - ag.active;
      setCore("agents", down > 0 ? down + " down" : ag.active + " ok", down > 0 ? "warn" : "ok", (ag.channels || []).join(" · "));
    } else setCore("agents", "—", "off", ag === null && S.online ? "not in your role" : "unavailable");

    var mem = S.memory;
    if (mem && !mem.error) setCore("memory", num(mem.facts), mem.healthy ? "" : "warn", num(mem.facts) + " facts · " + num(mem.chunks) + " chunks" + (mem.healthy ? "" : " · degraded"));
    else setCore("memory", "—", "off", "unavailable");

    if (c.watchers_total != null) setCore("watchers", c.watchers_on + " on", c.watchers_on ? "ok" : "off", c.watchers_on + " of " + c.watchers_total + " watchers listening");
    else setCore("watchers", "—", "off", "");
    if (c.rules_user != null || c.rules_builtin != null) setCore("rules", String((c.rules_user || 0) + (c.rules_builtin || 0)), "", (c.rules_user || 0) + " of yours · " + (c.rules_builtin || 0) + " built in");
    else setCore("rules", "—", "off", "");

    setCore("voice", Voice.listening ? "live" : READY ? "ready" : "no key", Voice.listening ? "warn" : READY ? "ok" : "off", READY ? "OpenAI · " + (VOICE || "voice") + (DESK ? " · front desk (GPT, trial)" : "") : "Add an OpenAI key in Settings to use voice");

    var pend = pendingApprovals().length;
    var mins = Math.round((st.approval_timeout_s || 300) / 60);
    setCore("guard", pend ? String(pend) : "on", pend ? "warn" : "ok", "Destructive steps wait for Approve; nobody answering in " + mins + " min means denied.");
  }

  /* ================================================================ sessions */

  var sessSig = "";
  function sessKey(s) { return String(s.pid || s.session_id || s.name); }
  function sessIcon(s) {
    var w = String(s.where || "");
    if (s.self) return "core";
    if (/Desktop/.test(w)) return "desktop";
    if (/Terminal/.test(w)) return "terminal";
    if (/Remote/.test(w)) return "remote";
    return "sessions";
  }
  function sessWhere(s) {
    var w = String(s.where || s.kind || "");
    return /Desktop/.test(w) ? "Desktop" : /Terminal/.test(w) ? "Terminal" : /Remote/.test(w) ? "Remote" : w ? clip(w, 14) : "session";
  }
  function subagentLabel(a) { return a.description || a.type || ("agent-" + a.id); }
  function sortSessions(list) {
    return list.slice().sort(function (a, b) {
      if (a.self !== b.self) return a.self ? 1 : -1;
      return String(a.started_at || "").localeCompare(String(b.started_at || "")) || (a.pid || 0) - (b.pid || 0);
    });
  }
  function selfState() { return S.status && S.status.busy ? "working" : "idle"; }
  function sessLine(s) {
    var bits = [];
    var n = (s.subagents || []).length;
    if (n) bits.push("<b>" + n + " sub-agent" + (n === 1 ? "" : "s") + "</b>");
    if (s.self) bits.push(S.status && S.status.busy ? "working on a turn" : "CEO · ready");
    else if (s.waiting_for) bits.push("waiting for " + esc(s.waiting_for));
    else {
      var d = s.last_delegation;
      if (d && Date.now() - Date.parse(d.updated_at || d.created_at) < 6 * 3600 * 1000) bits.push(esc((d.status === "ack" ? "replied" : d.status) + " " + ago(d.updated_at || d.created_at)));
      else bits.push(esc(sessState(s) + (s.status_since ? " " + ago(s.status_since) : "")));
    }
    if (s.cost_today_usd_est != null) bits.push(esc(money(s.cost_today_usd_est)) + (s.self ? "" : " est"));
    return bits.join(" · ");
  }
  function renderSessions(force) {
    var list = sortSessions(S.sessions);
    var sig = JSON.stringify(list.map(function (s) {
      return [s.pid, s.name, s.status, s.waiting_for, s.where, s.open_delegations, s.last_delegation && [s.last_delegation.id, s.last_delegation.status],
        s.mission && [s.mission.ref, s.mission.step_n, s.mission.step_status], s.cost_today_usd_est, s.cwd,
        (s.subagents || []).map(function (a) { return [a.id, a.status, a.description]; })];
    })) + "|" + S.target + "|" + (S.status && S.status.busy) + "|" + (S.status && S.status.process && S.status.process.model);
    var live = liveSessions();
    $("cc-sess-aside").textContent = live.length + " live" + (S.status && S.status.sessions_at ? " · polled " + ago(S.status.sessions_at) : "");
    if (sig === sessSig && !force) return;
    sessSig = sig;

    Orb.setNodes(sortSessions(live).map(function (s) {
      return { id: sessKey(s), label: clip(s.name || "unnamed session", 26), st: sessState(s), subs: s.subagents || [], mission: !!s.mission };
    }));
    Orb.mark(S.target !== "auto" ? (function () { var x = sessionNamed(S.target); return x ? sessKey(x) : null; })() : null);

    var el = $("cc-sessions");
    if (!list.length) {
      el.innerHTML = '<div class="cc-empty-s">' + (S.online ? "No Claude Code sessions are registered on this machine right now." : "Sessions appear here when MINT AI's supervisor is reachable.") + "</div>";
      return;
    }
    var p = (S.status && S.status.process) || {};
    var self = list.filter(function (s) { return s.self; });
    var others = list.filter(function (s) { return !s.self; });
    var h = "";
    self.forEach(function (s) {
      h += '<div class="cc-sec-t">MINT AI<span class="sp"></span><span class="cc-tag ai">CEO · you talk to it</span></div>' +
        '<div class="cc-card cc-sc self" data-sess="' + esc(sessKey(s)) + '"><div class="t"><b>MINT AI</b><span class="sp"></span><span class="cc-mono">' + esc(s.cost_today_usd_est != null ? money(s.cost_today_usd_est) : "") + "</span></div>" +
        '<div class="m">' + esc([p.model ? modelLabel(p.model) + (p.effort ? " · " + p.effort : "") : "", s.cwd || "/root/moni-ai", selfState() === "working" ? "working on a turn" : "routes work to the sessions below"].filter(Boolean).join(" · ")) + "</div>" +
        '<div class="acts"><button type="button" class="cc-btn sm" data-deep-open="' + esc(sessKey(s)) + '">' + ic("eye") + "Deep view</button></div></div>";
    });
    h += '<div class="cc-sec-t">Sessions and their sub-agents</div>';
    if (!others.length) h += '<div class="cc-empty-s">No other sessions are live.</div>';
    others.forEach(function (s) {
      var st = sessState(s), key = sessKey(s), name = s.name || "unnamed session";
      var tag = st === "working" ? '<span class="cc-tag ok">working</span>' : st === "waiting" ? '<span class="cc-tag warn">waiting' + (s.waiting_for ? " on " + esc(clip(s.waiting_for, 24)) : "") + "</span>" : '<span class="cc-tag mute">idle</span>';
      if (s.mission) tag = '<span class="cc-tag ai">' + ic("flag") + esc(s.mission.ref || "mission") + (s.mission.step_n ? " · step " + esc(s.mission.step_n) : "") + "</span>" + tag;
      var subs = s.subagents || [];
      h += '<div class="cc-card cc-sc ' + st + (S.target === s.name ? " target" : "") + '" data-sess="' + esc(key) + '" title="' + esc(name + " · " + (s.cwd || "") + " · pid " + (s.pid || "?")) + '">' +
        '<div class="t"><span class="cc-dot ' + (st === "working" ? "work" : st === "waiting" ? "wait" : "idle") + '"></span><b>' + esc(name) + '</b><span class="sp"></span>' + tag + "</div>" +
        '<div class="m">' + sessLine(s) + " · " + esc(sessWhere(s)) + "</div>" +
        (subs.length ? '<div class="cc-subagents">' + subs.map(function (a) { return "<div><i></i><b>" + esc(a.type || "agent") + "</b> " + esc(clip(a.description || "", 80)) + "</div>"; }).join("") + "</div>" : "") +
        '<div class="acts"><button type="button" class="cc-btn sm" data-deep-open="' + esc(key) + '">' + ic("eye") + "Deep view</button>" +
        (s.name ? '<button type="button" class="cc-btn sm" data-at="' + esc(s.name) + '">' + ic("message") + "Message via MINT AI</button>" : "") + "</div></div>";
    });
    el.innerHTML = h;
  }
  function findSess(key) {
    for (var i = 0; i < S.sessions.length; i++) if (sessKey(S.sessions[i]) === key) return S.sessions[i];
    return null;
  }
  function highlightSess(key) {
    var el = document.querySelector('[data-sess="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
    if (!el) return;
    el.classList.add("hl");
    setTimeout(function () { el.classList.remove("hl"); }, 2400);
  }

  $("cc-sessions").addEventListener("click", function (e) {
    var d = e.target.closest("[data-deep-open]");
    if (d) { P.openDeep(d.getAttribute("data-deep-open")); return; }
    var at = e.target.closest("[data-at]");
    if (at) { setTarget(at.getAttribute("data-at")); closeSheet(); input.focus(); }
  });

  /** The Remote Control link, fetched when asked for and never kept on the page. */
  function openRemoteControl() {
    var w = window.open("about:blank", "_blank");
    api("rc").then(function (rc) {
      var url = rc && rc.url;
      if (!rc.enabled || !url || !/^https:\/\/claude\.ai\//.test(url)) {
        if (w) w.close();
        toast(rc && rc.enabled ? "Remote Control has no session link yet." : "Remote Control is off for MINT AI.", true);
        return;
      }
      if (w) { w.opener = null; w.location.replace(url); }
      else toast("The browser blocked the new tab; allow pop-ups for this panel.", true);
    }).catch(function (e) {
      if (w) w.close();
      toast("Could not read the Remote Control link: " + e.message, true);
    });
  }
  $("cc-rc-open").addEventListener("click", openRemoteControl);

  /** Interrupt MINT AI's current turn. */
  function interrupt(btn) {
    if (btn) btn.disabled = true;
    return api("interrupt", { body: {} }).then(function () { toast("Interrupting the current turn…"); })
      .catch(function (e) { toast("Could not interrupt: " + e.message, true); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  /* ================================================================ composer */

  var input = $("cc-input");
  function setTarget(name) {
    S.target = name && name !== "auto" ? name : "auto";
    var set = S.target !== "auto";
    $("cc-target-label").textContent = set ? "→ " + clip(S.target, 26) : "Auto-route";
    $("cc-vb-target").textContent = set ? "→ " + clip(S.target, 22) : "Auto-route";
    $("cc-target").classList.toggle("set", set);
    $("cc-target").title = set ? "Addressed to " + S.target + " (MINT AI delegates it there) — click to change" : "MINT AI picks the session — click to address one";
    input.placeholder = set ? "Tell " + clip(S.target, 30) + " what to do (through MINT AI)…" : "Ask MINT AI…";
    renderSessions(true);
  }

  var menu = null;
  function closeMenu() {
    if (menu) { menu.remove(); menu = null; $("cc-target").setAttribute("aria-expanded", "false"); }
  }
  function openMenu() {
    closeMenu();
    menu = document.createElement("div");
    menu.className = "cc-target-menu";
    menu.setAttribute("role", "menu");
    var h = '<button type="button" role="menuitemradio" aria-checked="' + (S.target === "auto") + '" data-t="auto" class="' + (S.target === "auto" ? "on" : "") + '">' + ic("route") + '<span class="nm">Auto-route</span><small>MINT AI decides</small></button><hr>';
    var live = sortSessions(liveSessions());
    if (!live.length) h += '<button type="button" disabled><span class="nm">No other sessions are live</span></button>';
    live.forEach(function (s) {
      var st = sessState(s);
      h += '<button type="button" role="menuitemradio" aria-checked="' + (S.target === s.name) + '" data-t="' + esc(s.name || "") + '" class="' + (S.target === s.name ? "on" : "") + '"' + (s.name ? "" : " disabled") + '><span class="cc-dot ' + (st === "working" ? "work" : st === "waiting" ? "wait" : "idle") + '"></span><span class="nm">' + esc(s.name || "unnamed") + "</span><small>" + esc(String(s.where || "").replace(" · Remote Control", " · RC")) + "</small></button>";
    });
    menu.innerHTML = h;
    $("cc-target").appendChild(menu);
    $("cc-target").setAttribute("aria-expanded", "true");
    menu.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var b = ev.target.closest("button[data-t]");
      if (!b || b.disabled) return;
      setTarget(b.getAttribute("data-t"));
      closeMenu();
      input.focus();
    });
    menu.addEventListener("keydown", function (ev) {
      var items = Array.prototype.slice.call(menu.querySelectorAll("button[data-t]:not([disabled])"));
      var i = items.indexOf(document.activeElement);
      if (ev.key === "ArrowDown") { ev.preventDefault(); (items[i + 1] || items[0]).focus(); }
      if (ev.key === "ArrowUp") { ev.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
      if (ev.key === "Escape") { closeMenu(); input.focus(); }
    });
    var on = menu.querySelector("button.on") || menu.querySelector("button[data-t]");
    if (on) on.focus();
  }
  $("cc-target").addEventListener("click", function (e) {
    if (menu && menu.contains(e.target)) return;
    e.stopPropagation();
    if (menu) closeMenu(); else openMenu();
  });
  document.addEventListener("click", function (e) { if (menu && !$("cc-target").contains(e.target)) closeMenu(); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "@" && !input.value) { e.preventDefault(); openMenu(); }
  });
  // "@planning-engine do this": a session named at the start addresses the message to it.
  input.addEventListener("input", function () {
    $("cc-send").classList.toggle("ready", !!input.value.trim());
    var m = /^@(\S+)\s/.exec(input.value);
    if (!m) return;
    var q = m[1].toLowerCase(), hit = null;
    liveSessions().forEach(function (s) { if (!hit && s.name && s.name.toLowerCase().indexOf(q) === 0) hit = s; });
    if (hit) { setTarget(hit.name); input.value = input.value.slice(m[0].length); }
  });

  function hint(text, bad) {
    var h = $("cc-hint");
    if (!h.getAttribute("data-default")) h.setAttribute("data-default", h.innerHTML);
    if (!text) { h.innerHTML = h.getAttribute("data-default"); h.classList.remove("err"); return; }
    h.textContent = text;
    h.classList.toggle("err", !!bad);
  }

  var voiceTurns = new Set();    // turns whose reply is read aloud
  var deskTurns = new Set();     // turns the front desk passed on: their reply is summarised aloud
  var sending = false;
  function send(text, opts) {
    opts = opts || {};
    text = String(text || "").trim();
    if (!text || sending) return Promise.resolve(null);
    if (S.target !== "auto" && !liveSessions().some(function (s) { return s.name === S.target; })) {
      toast("“" + S.target + "” is no longer running. Sending with auto-route instead.", true);
      setTarget("auto");
    }
    sending = true;
    if (opts.voice || Voice.speakAll) Voice.unlock();
    $("cc-send").disabled = true;
    var body = { text: text };
    if (S.target !== "auto") body.target = S.target;
    // A voice turn names its voice-turn id: the server sends it to MINT AI
    // only if it is exactly what the server heard for that id.
    if (opts.voice && opts.vt) body.vt = opts.vt;
    return api("send", { body: body }).then(function (r) {
      hint("");
      if (!opts.voice) input.value = "";
      if (r && r.turn) {
        var tr = upsertTurn(r.turn);
        if (opts.voice || Voice.speakAll) {
          Voice.tag(r.turn.id, { vt: opts.vt || "t" + r.turn.id, cat: "direct" });
          // The turn may already be over by the time this reply lands: read it now.
          if (tr && tr.ended_at && aiText(tr)) Voice.flush(tr.id, aiText(tr));
          else voiceTurns.add(r.turn.id);
        }
        if (opts.voice && r.queued_behind) Voice.say("Got it. I'll pick that up as soon as I'm free.");
        else if (opts.voice && !opts.acked) Voice.say("On it.");
      }
      $("cc-send").classList.remove("ready");
      paintState();
      return r;
    }).catch(function (e) {
      hint("Not sent: " + e.message, true);
      if (opts.voice) Voice.say("Sorry, that did not go through.");
      return null;
    }).then(function (r) {
      sending = false;
      $("cc-send").disabled = false;
      return r;
    });
  }
  $("cc-compose").addEventListener("submit", function (e) {
    e.preventDefault();
    send(input.value);
  });
  $("cc-stop").addEventListener("click", function () { interrupt($("cc-stop")); });

  /* ================================================================ sheets
     The dock's sheets slide in from the right (a bottom sheet on a phone).
     Only one is open at a time; each keeps its own content live while closed,
     so opening one is instant. S.pane names the open one. */

  var SHEET_KEYS = ML.sheetKeys().concat(["everything"]);
  function openSheet(id, toggle) {
    if (SHEET_KEYS.indexOf(id) < 0) return;
    if (toggle && S.pane === id) return closeSheet();
    closePop();
    closeReply();
    S.pane = id;
    SHEET_KEYS.forEach(function (k) { var p = $("cc-pane-" + k); if (p) p.hidden = k !== id; });
    $("cc-sheet").classList.add("open");
    $("cc-scrim").hidden = false;
    var bs = document.querySelectorAll("#cc-rail [data-sheet]");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-expanded", String(bs[i].getAttribute("data-sheet") === id));
    if (id === "conv") { renderSteps(); requestAnimationFrame(function () { toBottom(true); }); }
    if (id === "rules") P.renderRules();
    if (id === "dec") P.renderDecisions();
    if (id === "missions") P.renderMissions();
    if (id === "sessions") renderSessions(true);
    // Focus moves into the sheet (for Escape, Tab and screen readers) without a ring on the close button.
    if (!$("cc-sheet").contains(document.activeElement)) $("cc-pane-" + id).focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!S.pane) return;
    S.pane = null;
    $("cc-sheet").classList.remove("open", "wide");
    $("cc-scrim").hidden = true;
    var bs = document.querySelectorAll("#cc-rail [data-sheet]");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-expanded", "false");
  }
  /** The v3 name for the drawer's tabs; everything that called it opens the sheet now. */
  function showPane(id) { openSheet(id); }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-sheet]");
    if (b) { openSheet(b.getAttribute("data-sheet"), !!b.closest("#cc-rail")); return; }
    if (e.target.closest("[data-sheet-close]") || e.target.id === "cc-scrim") { closeSheet(); return; }
    if (e.target.closest("[data-open-palette]")) { closeSheet(); P.openPalette(); return; }
    var th = e.target.closest("[data-theme-to]");
    if (th) { var tb = document.querySelector('.topbar [data-theme-opt="' + th.getAttribute("data-theme-to") + '"]'); if (tb) tb.click(); }
  });
  $("cc-more").addEventListener("click", function () { openSheet("everything", true); });
  $("cc-expand").addEventListener("click", function () { $("cc-sheet").classList.toggle("wide"); });

  var scroller = $("cc-chat-scroll");
  function atBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60; }
  function toBottom(force) { if (force || atBottom()) scroller.scrollTop = scroller.scrollHeight; }

  /* ---------------------------------------------------------- conversation
     One block per turn: what came in (you, Remote Control, a peer session, a
     standing order, a watcher), then MINT AI's bubble -- its text as it
     streams, the delegations the turn made and any approval it is waiting on.
     A standing order's turn is a briefing card instead. */

  var chat = $("cc-chat");
  var TURN_SRC = {
    dashboard: "You", "voice-desk": "You · via the voice front desk", remote: "You · Remote Control", peer: "Message from a session",
    idle: "Idle notice", delivery: "Delivery notice", system: "System", unknown: "Turn",
    watcher: "Watcher", order: "Standing order", "mission-request": "New mission", decision: "Decision",
  };

  function upsertTurn(row) {
    if (!row || !row.id) return null;
    var cur = S.turns.get(row.id);
    if (!cur) {
      cur = { id: row.id, blocks: [], partial: "", el: null };
      S.turns.set(row.id, cur);
      S.turnOrder.push(row.id);
      S.turnOrder.sort(function (a, b) { return a - b; });
    }
    // A snapshot taken before the turn ended (the reply to POST send, when the
    // turn was quick) must not put a finished turn back to queued or running.
    var stale = cur.ended_at && !row.ended_at;
    if (!stale) for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k)) cur[k] = row[k];
    if (S.oldestTurn == null || row.id < S.oldestTurn) S.oldestTurn = row.id;
    renderTurn(cur);
    return cur;
  }

  function turnEl(tr) {
    if (tr.el && tr.el.isConnected) return tr.el;
    var el = document.createElement("div");
    el.className = "cc-turn";
    el.setAttribute("data-turn", tr.id);
    // Keep the chat in id order: find the first later turn already on screen.
    var after = null;
    var nodes = chat.querySelectorAll(".cc-turn");
    for (var i = 0; i < nodes.length; i++) if (Number(nodes[i].getAttribute("data-turn")) > tr.id) { after = nodes[i]; break; }
    var empty = chat.querySelector(".cc-chat-empty");
    if (empty) empty.remove();
    chat.insertBefore(el, after || chat.querySelector(".cc-orphans"));
    tr.el = el;
    return el;
  }

  function aiText(tr) {
    var txt = tr.blocks.join("\n\n");
    if (tr.partial) txt += (txt ? "\n\n" : "") + tr.partial;
    if (!txt && tr.result_text) txt = tr.result_text;
    return txt;
  }

  var ORDER_RE = /^\s*\[Standing order: ([^\]\n]{1,120})\]/;
  function isOrderTurn(tr) { return tr.source === "order" || !!tr.order_id; }
  function orderName(tr) {
    var m = ORDER_RE.exec(String(tr.text || ""));
    if (m) return m[1];
    var o = tr.order_id && P.orderById(tr.order_id);
    return o ? o.name : "Standing order";
  }

  function inboundHTML(tr) {
    var who = TURN_SRC[tr.source] || "Turn";
    var when = hm(tr.created_at);
    var text = tr.text || "";
    if (isOrderTurn(tr)) return "";
    if (tr.source === "dashboard" || tr.source === "voice-desk" || tr.source === "remote" || tr.source === "mission-request") {
      var name = tr.source === "remote" ? "You · via Remote Control" : tr.source === "voice-desk" ? (tr.actor && tr.actor !== VIEWER ? esc(tr.actor) : "You") + " · via the voice front desk" : tr.actor && tr.actor !== VIEWER ? esc(tr.actor) : "You";
      var tag = tr.source === "mission-request" ? ' · <span class="cc-badge b-mis">' + ic("flag") + "new mission</span>" : "";
      return '<div class="cc-msg me"><div class="who"><b>' + name + "</b> · " + esc(when) + tag + (tr.target ? " · → " + esc(clip(tr.target, 30)) : "") + '</div><div class="cc-bubble">' + esc(text) + "</div></div>";
    }
    if (tr.source === "peer") {
      return '<div class="cc-msg ai"><div class="who"><span class="cc-av"></span><b>' + esc(tr.actor || "A session") + "</b> · " + esc(when) + ' · peer message</div><div class="cc-bubble"><div class="cc-relay"><div class="src">' + esc(tr.actor || "session") + " → MINT AI</div>" + md(clip(text, 4000)) + "</div></div></div>";
    }
    var line = clip(firstLine(text.replace(/\[Cross-session [a-z ]+\]/i, "")) || who, 160);
    return '<div class="cc-msg sys"><div class="cc-bubble">' + esc(who) + (tr.actor && tr.actor.toLowerCase() !== String(tr.source).toLowerCase() ? " · " + esc(aiLabel(tr.actor)) : "") + " · " + esc(when) + (line && line !== who ? " — " + esc(line) : "") + "</div></div>";
  }

  /** A standing order's run, as a briefing card. */
  function briefHTML(tr, body) {
    var o = tr.order_id ? P.orderById(tr.order_id) : null;
    var label = o ? o.label : "";
    return '<div class="cc-msg ai wide"><div class="cc-brief"><div class="cc-brief-h">' + ic("sun2") + "<b>" + esc(orderName(tr)) + "</b><span>" +
      esc(hm(tr.ended_at || tr.started_at || tr.created_at)) + (tr.duration_ms ? " · " + esc(dur(tr.duration_ms)) : "") + "</span></div>" +
      '<div class="cc-brief-b cc-bubble' + (tr.status === "error" ? " err" : "") + '">' + body + "</div>" +
      '<div class="cc-brief-f">' + ic("clock") + "<span>Standing order" + (label ? " · " + esc(label) : "") + (o && o.next_run_at ? " · next " + esc(P.whenText(o.next_run_at)) : "") + "</span>" +
      (o ? '<button type="button" class="cc-link" data-order="' + esc(o.id) + '">Edit</button>' : "") + "</div></div></div>";
  }

  function delegCardHTML(d) {
    var s = sessionFor(d);
    var label = { ack: "acknowledged", sent: "sent", working: "working", done: "done", failed: "failed", held: "held", denied: "denied" }[d.status] || d.status;
    var h = '<div class="cc-dcard" data-deleg="' + d.id + '">' +
      '<div class="row"><span>target</span><b>' + esc(d.target_name || d.target) + "</b></div>" +
      '<div class="row"><span>via</span><span>peer message' + (s && s.where ? " · " + esc(s.where) : "") + "</span></div>" +
      '<div class="row"><span>status</span><span class="cc-badge b-' + esc(d.status) + '">' + esc(label) + "</span>" + (d.note ? '<span class="cc-muted">' + esc(clip(d.note, 60)) + "</span>" : "") + "</div></div>";
    if (d.reply_text && (d.status === "ack" || d.status === "done")) {
      h += '<div class="cc-relay"><div class="src">Reply from ' + esc(d.target_name) + " · " + esc(hm(d.replied_at || d.done_at)) + "</div>" + md(clip(d.reply_text, 3000)) + "</div>";
    }
    return h;
  }

  function approvalTarget(a) {
    var inp = a.input || {};
    if (a.tool === "SendMessage") return String(inp.to || "").replace(/\s*\[[0-9a-f]+\]$/, "") + " · peer message";
    return "this machine · MINT AI runs it as root";
  }
  function approvalCmd(a) {
    var inp = a.input || {};
    if (a.tool === "SendMessage") return { text: String(inp.message || a.summary || ""), shell: false };
    if (typeof inp.command === "string") return { text: inp.command, shell: true };
    return { text: a.summary || a.tool, shell: false };
  }
  /** Who decided an approval, in words: a person, a rule, or the clock. */
  function decidedBy(a) {
    var by = String(a.decided_by || "");
    var m = /^rule:(.+)$/.exec(by);
    if (m) return "rule #" + m[1];
    return by || "you";
  }
  /** An approval card: Approve once, Always allow this (which shows the rule
      it would add before saving it), or Deny. Used in the conversation and in
      the Decisions inbox alike; one click handler serves both. */
  function approvalHTML(a) {
    var res = a.status === "pending" ? "" : a.status === "approved" ? "ok" : "no";
    var cmd = approvalCmd(a);
    var byRule = /^rule:/.test(String(a.decided_by || ""));
    var head = res === "ok" ? (byRule ? "Auto-approved" : "Approved") : a.status === "denied" ? "Denied" : a.status === "expired" ? "Expired" : a.status === "cancelled" ? "Withdrawn" : "Approval needed";
    var what = a.tool === "SendMessage" ? "send this to <b>" + esc(String((a.input || {}).to || "a session").replace(/\s*\[[0-9a-f]+\]$/, "")) + "</b>" : a.tool === "Bash" || a.tool === "Monitor" ? "run this command" : "use <b>" + esc(a.tool) + "</b>";
    var resText = a.status === "approved" ? (byRule ? "Approved automatically by " + esc(decidedBy(a)) : "Approved by " + esc(decidedBy(a))) + " · " + esc(hm(a.decided_at))
      : a.status === "denied" ? "Denied by " + esc(decidedBy(a)) + " · " + esc(hm(a.decided_at)) + " — nothing ran"
      : a.status === "expired" ? "Nobody answered in time — denied by default at " + esc(hm(a.decided_at))
      : a.status === "cancelled" ? "Withdrawn — answered elsewhere or the turn was interrupted" : "";
    var sug = a.rule_suggestion;
    return '<div class="cc-approval' + (res ? " resolved " + res : "") + (a.status === "denied" ? " denied" : "") + '" data-ap="' + a.id + '">' +
      '<div class="cc-ap-h">' + ic("shield") + "<span>" + head + '</span><span class="risk">destructive</span>' +
      (a.mission_ref ? '<span class="cc-badge b-mis">' + esc(a.mission_ref) + (a.step_n ? " · step " + esc(a.step_n) : "") + "</span>" : "") +
      (a.status === "pending" ? '<span class="timer" data-timer title="Nobody answering means denied">—</span><span class="cc-ap-bar" data-bar></span>' : "") + "</div>" +
      '<div class="cc-ap-body"><p>' + (a.status === "pending" ? "MINT AI wants to " + what + ". Nothing runs until you choose." : "MINT AI asked to " + what + ".") + "</p>" +
      '<div class="cc-ap-cmd' + (cmd.shell ? " shell" : "") + '">' + esc(clip(cmd.text, 2000)) + "</div>" +
      '<dl class="cc-ap-dl"><dt>target</dt><dd>' + esc(approvalTarget(a)) + "</dd>" +
      "<dt>effect</dt><dd>" + esc(a.category ? a.category.replace(/_/g, " ") + (a.label && a.label !== a.category ? " — " + a.label : "") : a.label || "a step the gate treats as destructive") + "</dd>" +
      (a.reason ? "<dt>reason</dt><dd>" + esc(clip(a.reason, 400)) + "</dd>" : "") + "</dl>" +
      '<div class="cc-ap-act"><button type="button" class="cc-btn pri sm" data-approve="' + a.id + '">' + ic("check") + 'Approve once</button>' +
      '<button type="button" class="cc-btn sm" data-always="' + a.id + '">' + ic("scale") + "Always allow this</button>" +
      '<button type="button" class="cc-btn sm" data-deny="' + a.id + '">' + ic("close") + "Deny</button></div>" +
      (a.status === "pending" && sug && sug.pattern ? '<div class="cc-ap-hint">“Always allow this” would add an allow rule for <code>' + esc(clip(sug.pattern, 160)) + "</code> — you see it before it is saved.</div>" : "") +
      '<div class="cc-ap-res">' + (res === "ok" ? ic("check") : ic("close")) + "<span>" + resText + "</span></div>" +
      '<div class="cc-ap-err" data-err hidden></div></div></div>';
  }

  function turnDelegations(id) {
    var out = [];
    S.delegations.forEach(function (d) { if (d.turn_id === id) out.push(d); });
    return out.sort(function (a, b) { return a.id - b.id; });
  }
  function turnApprovals(id) {
    var out = [];
    S.approvals.forEach(function (a) { if (a.turn_id === id) out.push(a); });
    return out.sort(function (a, b) { return a.id - b.id; });
  }

  var renderQueued = new Set(), renderRaf = 0;
  /** Coalesce streaming updates to one repaint per frame. */
  function renderTurn(tr) {
    renderQueued.add(tr.id);
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(function () {
      renderRaf = 0;
      var stick = atBottom();
      renderQueued.forEach(function (id) { var x = S.turns.get(id); if (x) paintTurn(x); });
      renderQueued.clear();
      renderOrphans();
      tickApprovals();
      toBottom(stick);
      renderSay();
    });
  }
  function paintTurn(tr) {
    var el = turnEl(tr);
    var txt = aiText(tr);
    var dels = turnDelegations(tr.id), aps = turnApprovals(tr.id);
    var h = inboundHTML(tr);
    var body = "";
    if (txt) body += "<div>" + md(txt) + "</div>";
    else if (tr.status === "running") body += '<span class="cc-typing" aria-label="MINT AI is working"><i></i><i></i><i></i></span>';
    else if (tr.status === "queued") body += '<span class="cc-muted">Queued — MINT AI will take this next.</span>';
    if (tr.status === "interrupted") body += '<p class="cc-muted">Interrupted.</p>';
    if (tr.status === "error" && tr.error) body += '<p class="cc-muted">Stopped with an error: ' + esc(clip(tr.error, 300)) + "</p>";
    body += dels.map(delegCardHTML).join("");
    body += aps.map(approvalHTML).join("");
    if (isOrderTurn(tr)) h += briefHTML(tr, body || '<span class="cc-muted">Nothing reported.</span>');
    else if (body) {
      h += '<div class="cc-msg ai' + (aps.length ? " wide" : "") + '"><div class="who"><span class="cc-av"></span><b>MINT AI</b> · ' + esc(hm(tr.ended_at || tr.started_at || tr.created_at)) +
        (tr.duration_ms ? " · " + dur(tr.duration_ms) : "") + '</div><div class="cc-bubble' + (tr.status === "error" ? " err" : "") + '">' + body + "</div></div>";
    }
    el.innerHTML = h;
  }

  /* Approvals whose turn is not on screen (older than what was loaded, or raised
     by a turn the page has not seen) still need a card somewhere. */
  function renderOrphans() {
    var list = [];
    S.approvals.forEach(function (a) { if (a.status === "pending" && !S.turns.has(a.turn_id)) list.push(a); });
    var box = chat.querySelector(".cc-orphans");
    if (!list.length) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement("div"); box.className = "cc-orphans"; chat.appendChild(box); }
    box.innerHTML = list.map(function (a) {
      return '<div class="cc-msg ai wide"><div class="who"><span class="cc-av"></span><b>MINT AI</b> · ' + esc(hm(a.created_at)) + '</div><div class="cc-bubble">' + approvalHTML(a) + "</div></div>";
    }).join("");
  }

  function renderChatEmpty() {
    if (!S.turnOrder.length && !chat.querySelector(".cc-chat-empty")) {
      chat.innerHTML = '<div class="cc-chat-empty">No conversation yet. Tell MINT AI what to do — it finds the session that owns the work and hands it over.</div>';
    }
  }

  /* Older turns on request. */
  function addMoreButton(show) {
    var b = chat.querySelector(".cc-more");
    if (!show) { if (b) b.remove(); return; }
    if (b) return;
    b = document.createElement("button");
    b.type = "button";
    b.className = "cc-more";
    b.textContent = "Load earlier turns";
    chat.insertBefore(b, chat.firstChild);
    b.addEventListener("click", function () {
      b.disabled = true;
      var h0 = scroller.scrollHeight;
      api("ledger/turns?limit=20&before_id=" + S.oldestTurn).then(function (r) {
        var rows = (r.rows || []).filter(visibleTurn);
        rows.forEach(upsertTurn);
        b.remove();
        requestAnimationFrame(function () { requestAnimationFrame(function () { scroller.scrollTop += scroller.scrollHeight - h0; addMoreButton((r.rows || []).length === 20); }); });
      }).catch(function (e) { b.disabled = false; toast("Could not load earlier turns: " + e.message, true); });
    });
  }
  function visibleTurn(row) { return row && row.source !== "system"; }

  /* ---------------------------------------------------------- the last reply
     Under the caption, "Full reply" opens MINT AI's last answer in full, with
     the way to the whole conversation and to hear it read aloud. */

  var replySig = "";
  function renderSay() {
    var last = lastReplyTurn();
    if (!$("cc-reply").hidden && last) {
      var sig = last.id + "|" + aiText(last).length;
      if (sig !== replySig) { replySig = sig; paintReply(last); }
    }
    paintCaption();
  }
  function paintReply(last) {
    $("cc-reply-h").textContent = "MINT AI · " + hm(last.ended_at || last.started_at || last.created_at) + (last.duration_ms ? " · " + dur(last.duration_ms) : "");
    $("cc-reply-body").innerHTML = md(aiText(last));
    $("cc-reply").setAttribute("data-turn", String(last.id));
  }
  function openReply() {
    var last = lastReplyTurn();
    if (!last) return;
    closePop();
    replySig = last.id + "|" + aiText(last).length;
    paintReply(last);
    $("cc-reply").hidden = false;
    $("cc-cap-more").setAttribute("aria-expanded", "true");
    $("cc-cap-more-t").textContent = "Hide reply";
    $("cc-cap-more").classList.add("open");
  }
  function closeReply() {
    if ($("cc-reply").hidden) return;
    $("cc-reply").hidden = true;
    $("cc-cap-more").setAttribute("aria-expanded", "false");
    $("cc-cap-more-t").textContent = "Full reply";
    $("cc-cap-more").classList.remove("open");
  }
  $("cc-cap-more").addEventListener("click", function () { if ($("cc-reply").hidden) openReply(); else closeReply(); });
  $("cc-reply-x").addEventListener("click", closeReply);
  $("cc-reply").addEventListener("click", function (e) { if (e.target.closest("[data-sheet]")) closeReply(); });
  $("cc-reply-read").addEventListener("click", function () {
    var last = lastReplyTurn();
    if (!last) return;
    Voice.unlock();
    Voice.flush("r" + last.id, aiText(last));
  });

  /* ---------------------------------------------------------- approvals */

  function tickApprovals() {
    var els = document.querySelectorAll(".cc-approval [data-timer]");
    for (var i = 0; i < els.length; i++) {
      var card = els[i].closest("[data-ap]");
      var a = S.approvals.get(Number(card.getAttribute("data-ap")));
      if (!a || a.status !== "pending") continue;
      var left = Math.max(0, Math.round((Date.parse(a.expires_at) - nowServer()) / 1000));
      var total = Math.max(1, Math.round((Date.parse(a.expires_at) - Date.parse(a.created_at)) / 1000));
      els[i].textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") + " left";
      els[i].classList.toggle("low", left < 60);
      var bar = card.querySelector("[data-bar]");
      if (bar) bar.style.transform = "scaleX(" + (left / total).toFixed(3) + ")";
    }
  }

  function upsertApproval(a, replay) {
    if (!a || !a.id) return;
    var cur = S.approvals.get(a.id);
    if (cur && cur.status !== "pending" && a.status === "pending") return;   // an older event replayed
    S.approvals.set(a.id, a);
    var tr = S.turns.get(a.turn_id);
    if (tr) renderTurn(tr); else renderTurn({ id: -1 });
    P.renderDecisions();
    renderTimeline();
    if (!replay && a.status === "pending" && (!cur || cur.status !== "pending")) {
      openNeed("a" + a.id);
      feedPush({ key: "ap" + a.id + "p", ts: a.created_at, kind: "approval", html: "<b>Approval needed</b> · " + esc(clip(a.summary, 140)) });
      if (Voice.on) Voice.say("I need your approval before I go on.");
    }
    if (!replay && a.status !== "pending" && (!cur || cur.status === "pending")) {
      feedPush({ key: "ap" + a.id + a.status, ts: a.decided_at, kind: a.status === "approved" ? "approved" : a.status, html: "<b>" + esc(a.status === "approved" ? "Approved" : a.status === "denied" ? "Denied" : a.status === "expired" ? "Expired" : "Withdrawn") + "</b>" + (a.decided_by && a.decided_by !== "timeout" ? " by " + esc(decidedBy(a)) : "") + " · " + esc(clip(a.summary, 120)) });
    }
    paintState();
    renderRail();
  }

  /* One handler for every approval card on the page (conversation or inbox). */
  function approvalClick(e) {
    var a = e.target.closest("[data-approve]"), d = e.target.closest("[data-deny]"), al = e.target.closest("[data-always]");
    var btn = a || d || al;
    if (!btn || btn.disabled) return;
    var card = btn.closest("[data-ap]");
    if (al) { P.openAlways(Number(al.getAttribute("data-always"))); return; }
    var id = Number(btn.getAttribute(a ? "data-approve" : "data-deny"));
    var buttons = card.querySelectorAll(".cc-ap-act button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    var err = card.querySelector("[data-err]");
    api("approvals/" + id + "/" + (a ? "approve" : "deny"), { body: {} }).then(function (r) {
      if (r && r.approval) upsertApproval(r.approval, false);
    }).catch(function (ex) {
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
      if (err) { err.hidden = false; err.textContent = "Not recorded: " + ex.message; }
    });
  }
  chat.addEventListener("click", approvalClick);
  $("cc-dec-list").addEventListener("click", approvalClick);
  chat.addEventListener("click", function (e) {
    var o = e.target.closest("[data-order]");
    if (o) P.openOrder(o.getAttribute("data-order"));
  });

  /* ---------------------------------------------------------- the decision card
     One card, top right, for everything waiting for you: approvals first (they
     expire), then watcher findings. It pages through them, and each button is
     the same call the Decisions sheet makes (MintLogic.card names the route).
     "Later" puts it away; the amber "N need you" pill brings it back. */

  var Need = { open: false, idx: 0, sig: "", busy: false, seen: {} };
  function needQueue() {
    return ML.needQueue(pendingApprovals(), typeof P !== "undefined" && P ? P.decisionsList() : []);
  }
  function openNeed(key) {
    var q = needQueue();
    if (!q.length) return;
    var i = key ? q.map(function (x) { return x.key; }).indexOf(key) : -1;
    Need.idx = i >= 0 ? i : Math.min(Need.idx, q.length - 1);
    Need.open = true;
    Need.sig = "";
    renderNeed();
  }
  function closeNeed() {
    Need.open = false;
    Need.sig = "";
    renderNeed();
  }
  function renderNeed() {
    var q = needQueue(), n = q.length;
    $("cc-needn").textContent = n;
    $("cc-needpill").hidden = !n || Need.open;
    var mir = document.querySelectorAll("[data-dec-mirror]");
    for (var m = 0; m < mir.length; m++) { mir[m].textContent = n; mir[m].hidden = !n; }
    var box = $("cc-need");
    if (Need.busy) return;
    if (!n || !Need.open) {
      if (!box.hidden) { box.hidden = true; box.innerHTML = ""; }
      if (!n) Need.open = false;
      return;
    }
    Need.idx = Math.max(0, Math.min(Need.idx, n - 1));
    var it = q[Need.idx], c = ML.card(it);
    var sig = it.key + "|" + n + "|" + Need.idx + "|" + c.title + "|" + c.why + "|" + c.actions.map(function (x) { return x.act; }).join(",");
    box.hidden = false;
    if (sig === Need.sig) return;
    Need.sig = sig;
    box.setAttribute("data-kind", c.kind.toLowerCase());
    box.innerHTML = '<div class="k">' + ic(c.icon) + "<span>Needs you · " + esc(c.kind) + '</span><span class="sp"></span>' +
      '<span class="pg">' + (n > 1 ? '<button type="button" data-need-pg="-1" aria-label="Previous">' + ic("chevl") + "</button>" : "") + (Need.idx + 1) + " of " + n +
      (n > 1 ? '<button type="button" data-need-pg="1" aria-label="Next">' + ic("chevr") + "</button>" : "") + "</span></div>" +
      "<h3>" + esc(c.title) + "</h3>" + (c.meta ? '<div class="meta">' + esc(c.meta) + "</div>" : "") +
      (c.why ? '<p class="why">' + esc(c.why) + "</p>" : "") +
      (it.type === "approval" ? '<div class="timer"><span data-need-timer>—</span><span class="bar"><i data-need-bar></i></span></div>' : "") +
      '<div class="acts">' + c.actions.map(function (x, i) {
        if (x.link) return "";
        return (x.act === "later" ? '<span class="sp"></span>' : "") +
          '<button type="button" class="cc-btn ' + (x.primary ? "pri" : x.act === "later" ? "link" : "") + '" data-need-act="' + i + '">' + (x.primary ? ic("check") : "") + esc(x.label) + "</button>";
      }).join("") + "</div>" +
      c.actions.map(function (x, i) { return x.link ? '<button type="button" class="more" data-need-act="' + i + '">' + ic("scale") + esc(x.label) + "</button>" : ""; }).join("") +
      '<div class="err" data-need-err hidden></div>';
    tickNeed();
  }
  function tickNeed() {
    var el = document.querySelector("[data-need-timer]");
    if (!el) return;
    var q = needQueue(), it = q[Need.idx];
    if (!it || it.type !== "approval") return;
    var a = it.item;
    var left = Math.max(0, Math.round((Date.parse(a.expires_at) - nowServer()) / 1000));
    var total = Math.max(1, Math.round((Date.parse(a.expires_at) - Date.parse(a.created_at)) / 1000));
    if (!isFinite(left)) return;
    el.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") + " left · then denied";
    el.classList.toggle("low", left < 60);
    var bar = document.querySelector("[data-need-bar]");
    if (bar) bar.style.transform = "scaleX(" + (left / total).toFixed(3) + ")";
  }
  $("cc-need").addEventListener("click", function (e) {
    var pg = e.target.closest("[data-need-pg]");
    var q = needQueue();
    if (pg) { Need.idx = (Need.idx + Number(pg.getAttribute("data-need-pg")) + q.length) % q.length; Need.sig = ""; renderNeed(); return; }
    var b = e.target.closest("[data-need-act]");
    if (!b || b.disabled || Need.busy) return;
    var it = q[Need.idx], c = ML.card(it);
    var act = c && c.actions[Number(b.getAttribute("data-need-act"))];
    if (!act) return;
    if (act.act === "later") { closeNeed(); return; }
    if (act.act === "always") { P.openAlways(it.id); return; }
    var bs = $("cc-need").querySelectorAll("[data-need-act]");
    for (var i = 0; i < bs.length; i++) bs[i].disabled = true;
    b.classList.add("pressed");
    Need.busy = true;
    api(act.path, { body: act.body }).then(function (r) {
      $("cc-need").classList.add("done");
      $("cc-need").querySelector(".k span").textContent = ML.doneText(act.act);
      setTimeout(function () {
        Need.busy = false;
        $("cc-need").classList.remove("done");
        Need.sig = "";
        if (r && r.approval) upsertApproval(r.approval, false);
        if (r && r.decision) P.upsertDecision(r.decision, true);
        if (r && r.turn) upsertTurn(r.turn);
        renderNeed();
        paintState();
      }, 700);
    }).catch(function (ex) {
      Need.busy = false;
      for (var j = 0; j < bs.length; j++) bs[j].disabled = false;
      b.classList.remove("pressed");
      var err = $("cc-need").querySelector("[data-need-err]");
      if (err) { err.hidden = false; err.textContent = "Not recorded: " + ex.message; }
    });
  });
  $("cc-needpill").addEventListener("click", function () { Need.idx = 0; openNeed(); });

  /* ---------------------------------------------------------- the voice menu
     Under the composer, "Push to talk ▾": the mic's mode, replies read aloud,
     which voice path is on (the front desk is switched in Settings), the MINT
     AI core (a quick switch, saved for you), and the voice's spend. */

  function closePop() {
    var p = $("cc-pop");
    if (p.hidden) return;
    p.hidden = true;
    p.innerHTML = "";
    $("cc-vm").setAttribute("aria-expanded", "false");
  }
  function openVoiceMenu() {
    var p = $("cc-pop"), mode = liveSelected() ? "live" : Voice.mode(), ready = READY;
    var h = '<div class="grp">Voice</div>' +
      '<button type="button" role="menuitemradio" data-vmode="ptt" aria-checked="' + (mode === "ptt") + '"' + (ready ? "" : " disabled") + '><span class="chk"></span>Push to talk<small>hold the mic or Space</small></button>' +
      '<button type="button" role="menuitemradio" data-vmode="handsfree" aria-checked="' + (mode === "handsfree") + '"' + (ready ? "" : " disabled") + '><span class="chk"></span>Hands-free<small>a pause sends</small></button>' +
      liveMenuItem(mode) +
      '<button type="button" role="menuitemcheckbox" data-vread aria-checked="' + Voice.speakAll + '"' + (ready ? "" : " disabled") + '><span class="chk"></span>Read replies aloud<small>streamed</small></button>' +
      '<div class="line">' + ic("route") + "<span>" + (DESK ? "Front desk · GPT (trial)" : "Direct to MINT AI") + "</span>" +
      (root.getAttribute("data-voice-manage") === "1" ? '<a href="/credentials/openai-voice#v-desk">Settings</a>' : "<small>set in Settings</small>") + "</div>" +
      (ready ? "" : '<div class="line">' + ic("info") + "<span>Voice is off until an OpenAI key is added.</span></div>") +
      "<hr>" + '<div class="grp">MINT AI core</div>' +
      '<div class="cc-core-seg" role="radiogroup" aria-label="MINT AI core">' + Object.keys(ML.CORES).map(function (k) {
        return '<button type="button" role="radio" data-core-set="' + k + '" aria-checked="' + (k === coreNow()) + '"><b>' + k + "</b><span>" + esc(ML.CORES[k]) + "</span></button>";
      }).join("") + "</div><hr>" +
      '<button type="button" data-sheet="cost">' + ic("coin") + "Voice usage<small id=\"cc-pop-vu\">" + esc(P.voiceToday ? P.voiceToday() : "") + "</small></button>";
    p.innerHTML = h;
    p.hidden = false;
    $("cc-vm").setAttribute("aria-expanded", "true");
    var r = $("cc-vm").getBoundingClientRect(), pr = p.getBoundingClientRect();
    var x = Math.min(window.innerWidth - pr.width - 12, Math.max(12, r.left + r.width / 2 - pr.width / 2));
    p.style.left = x + "px";
    p.style.top = Math.max(12, r.top - pr.height - 8) + "px";
  }
  $("cc-vm").addEventListener("click", function (e) {
    e.stopPropagation();
    if ($("cc-pop").hidden) openVoiceMenu(); else closePop();
  });
  $("cc-pop").addEventListener("click", function (e) {
    e.stopPropagation();
    var m = e.target.closest("[data-vmode]");
    if (m && !m.disabled) { var vm = m.getAttribute("data-vmode"); if (vm === "live") liveSelect(true); else { liveSelect(false); Voice.setMode(vm); } openVoiceMenu(); return; }
    var rd = e.target.closest("[data-vread]");
    if (rd && !rd.disabled) { $("cc-speak-toggle").click(); openVoiceMenu(); return; }
    var cs = e.target.closest("[data-core-set]");
    if (cs) { setCoreChoice(cs.getAttribute("data-core-set")); openVoiceMenu(); return; }
    if (e.target.closest("[data-sheet]")) { var k = e.target.closest("[data-sheet]").getAttribute("data-sheet"); closePop(); openSheet(k); }
  });
  document.addEventListener("click", function (e) { if (!$("cc-pop").hidden && !e.target.closest("#cc-pop") && !e.target.closest("#cc-vm")) closePop(); });

  /* ---------------------------------------------------------- activity */

  // Tools the supervisor has no plain-English line for arrive as their bare name.
  var STEP_NAMES = { ToolSearch: "Loaded the tools it needs", TodoWrite: "Updated its plan", ListAgents: "Listed the live sessions",
    ExitPlanMode: "Finished planning", NotebookEdit: "Edited a notebook", Skill: "Opened a skill" };
  function renderSteps() {
    var box = $("cc-steps");
    var cur = S.status && S.status.current_turn;
    var tr = cur ? S.turns.get(cur.id) || cur : null;
    var lastTurn = null;
    if (!tr) {
      for (var i = S.turnOrder.length - 1; i >= 0; i--) { var x = S.turns.get(S.turnOrder[i]); if (x && x.source !== "system") { lastTurn = x; break; } }
    }
    var show = tr || lastTurn;
    var steps = S.steps && show && S.steps.turn_id === show.id ? S.steps.steps : cur && show && cur.id === show.id ? cur.steps || [] : [];
    var items = [];
    if (show) {
      items.push({ st: "done", txt: (TURN_SRC[show.source] === "You" ? "Took your request" : "Picked up: " + (TURN_SRC[show.source] || "a turn").toLowerCase()) + (show.text ? " — " + clip(firstLine(show.text), 60) : ""), t: show.started_at || show.created_at });
      (steps || []).forEach(function (s) {
        var txt = STEP_NAMES[s.txt] || s.txt;
        items.push({ st: s.st === "wait" ? "wait" : s.st === "error" ? "error" : s.st === "run" ? "run" : "done", txt: s.st === "wait" ? "Needs your approval — " + txt : txt, t: s.done_at || s.t, sub: s.sub });
      });
      if (show.status === "running" && !items.some(function (s) { return s.st === "run" || s.st === "wait"; })) items.push({ st: "run", txt: aiText(show) ? "Writing the answer" : "Thinking", t: "" });
      if (show.status === "done") items.push({ st: "done", txt: "Answered" + (show.duration_ms ? " in " + dur(show.duration_ms) : ""), t: show.ended_at });
      if (show.status === "interrupted") items.push({ st: "error", txt: "Interrupted", t: show.ended_at });
      if (show.status === "error") items.push({ st: "error", txt: "Ended with an error", t: show.ended_at });
    }
    var busy = items.some(function (s) { return s.st === "run"; }), waiting = items.some(function (s) { return s.st === "wait"; });
    $("cc-act-dot").className = "cc-dot " + (waiting ? "warn" : busy ? "work" : "idle");
    $("cc-act-sub").textContent = tr ? "turn " + hm(tr.started_at || tr.created_at) : lastTurn ? "last turn " + hm(lastTurn.started_at || lastTurn.created_at) : "idle";
    if (!items.length) { box.innerHTML = '<li class="empty"><span class="sx"></span><span>Waiting for something to do.</span></li>'; return; }
    var stick = box.scrollHeight - box.scrollTop - box.clientHeight < 20;
    box.innerHTML = items.map(function (s) {
      var mark = s.st === "done" ? ic("check") : s.st === "wait" ? "!" : s.st === "error" ? "×" : "";
      return '<li class="' + s.st + (s.sub ? " sub" : "") + '"><span class="sx">' + mark + "</span><span>" + esc(s.txt) + "</span><time>" + esc(hms(s.t)) + "</time></li>";
    }).join("");
    if (stick) box.scrollTop = box.scrollHeight;
  }

  /* ---------------------------------------------------------- timeline */

  var TL_LAB = { done: "done", working: "working", sent: "sent", ack: "acknowledged", failed: "failed", held: "held", denied: "denied",
    pending: "needs approval", approved: "approved", expired: "expired", cancelled: "withdrawn" };
  var tlRaf = 0;
  function renderTimeline() {
    if (tlRaf) return;
    tlRaf = requestAnimationFrame(function () {
      tlRaf = 0;
      var rows = [];
      S.delegations.forEach(function (d) { rows.push({ kind: "d", ts: d.created_at, r: d }); });
      S.approvals.forEach(function (a) { rows.push({ kind: "a", ts: a.created_at, r: a }); });
      rows.sort(function (x, y) { return Date.parse(y.ts) - Date.parse(x.ts); });
      rows = rows.slice(0, 120);
      $("cc-tl-count").textContent = rows.length;
      if (!rows.length) { $("cc-timeline").innerHTML = '<li class="empty">No delegations yet. They appear here as MINT AI hands work to other sessions.</li>'; return; }
      $("cc-timeline").innerHTML = rows.map(function (x) {
        var r = x.r;
        if (x.kind === "d") {
          var bits = [];
          if (r.status === "done" && r.done_at) bits.push(dur(Date.parse(r.done_at) - Date.parse(r.created_at)));
          if (r.note) bits.push(r.note);
          else if (r.status === "ack" && r.replied_at) bits.push("replied " + hms(r.replied_at));
          return '<li><span class="cc-tl-node ' + esc(r.status) + '"></span><span class="cc-tl-time">' + esc(hm(r.created_at)) + '</span><div class="cc-tl-cmd"><div class="t full">' + esc(r.text || r.summary || "") + "</div><small>→ <b>" + esc(r.target_name) + "</b>" + (bits.length ? " · " + esc(clip(bits.join(" · "), 90)) : "") + '</small></div><span class="cc-badge b-' + esc(r.status) + '">' + esc(TL_LAB[r.status] || r.status) + "</span></li>";
        }
        var who = r.decided_by && r.decided_by !== "timeout" ? (r.status === "approved" ? "approved" : "decided") + " by " + decidedBy(r) : r.status === "expired" ? "nobody answered" : "";
        return '<li><span class="cc-tl-node ' + esc(r.status) + '"></span><span class="cc-tl-time">' + esc(hm(r.created_at)) + '</span><div class="cc-tl-cmd"><div class="t">' + esc(clip(approvalCmd(r).text, 160)) + "</div><small>→ <b>" + esc(r.tool === "SendMessage" ? approvalTarget(r).replace(" · peer message", "") : "MINT AI") + "</b> · approval" + (r.category ? " · " + esc(r.category.replace(/_/g, " ")) : "") + (who ? " · " + esc(who) : "") + '</small></div><span class="cc-badge b-' + esc(r.status) + '">' + esc(TL_LAB[r.status] || r.status) + "</span></li>";
      }).join("");
    });
  }

  function upsertDelegation(d, replay) {
    if (!d || !d.id) return;
    var cur = S.delegations.get(d.id);
    if (cur && d.updated_at && cur.updated_at && d.updated_at < cur.updated_at) return;
    S.delegations.set(d.id, d);
    var s = sessionFor(d);
    if (!replay && !cur && d.status === "sent") {
      S.delegatingUntil = Date.now() + 2600;
      S.delegTo = d.target_name || d.target || "a session";
      S.delegText = d.summary || firstLine(d.text) || "";
      if (s && Orb.send(sessKey(s), 2600)) highlightSess(sessKey(s));
      paintState();
      feedPush({ key: "d" + d.id + "sent", ts: d.created_at, kind: "live", label: "sent", html: "Delegated to <b>" + esc(d.target_name) + "</b> · " + esc(clip(d.summary || firstLine(d.text), 120)) });
    }
    // An acknowledgement is the session answering: a reply bead comes back.
    if (!replay && cur && cur.status !== d.status && d.status === "ack" && s) Orb.reply(sessKey(s));
    if (!replay && cur && cur.status !== d.status && (d.status === "failed" || d.status === "held")) {
      feedPush({ key: "d" + d.id + d.status, ts: d.updated_at, kind: d.status === "failed" ? "failed" : "held", html: "<b>" + esc(d.target_name) + "</b> · delegation " + esc(d.status) + (d.note ? " — " + esc(clip(d.note, 120)) : "") });
    }
    var tr = S.turns.get(d.turn_id);
    if (tr) renderTurn(tr);
    renderTimeline();
    renderStats();
  }

  /* ---------------------------------------------------------- event log */

  var FEED_MAX = 100;
  function feedPush(item, quiet) {
    if (!item.key) item.key = "f" + Math.random();
    for (var i = 0; i < S.feed.length; i++) if (S.feed[i].key === item.key) return;
    item.isNew = !quiet;
    S.feed.push(item);
    S.feed.sort(function (a, b) { return Date.parse(b.ts || 0) - Date.parse(a.ts || 0); });
    if (S.feed.length > FEED_MAX) S.feed.length = FEED_MAX;
    renderFeed();
  }
  var feedRaf = 0;
  function renderFeed() {
    if (feedRaf) return;
    feedRaf = requestAnimationFrame(function () {
      feedRaf = 0;
      $("cc-feed-count").textContent = S.feed.length;
      if (!S.feed.length) { $("cc-feed").innerHTML = '<li class="empty">Replies, idle notices and service events appear here as they happen.</li>'; return; }
      $("cc-feed").innerHTML = S.feed.map(function (f) {
        return "<li" + (f.isNew ? ' class="new"' : "") + "><time>" + esc(hm(f.ts)) + "</time><p>" + f.html + '</p><span class="cc-badge b-' + esc(f.kind) + '">' + esc(f.label || f.kind) + "</span></li>";
      }).join("");
      S.feed.forEach(function (f) { f.isNew = false; });
    });
  }
  function inboundFeed(row, quiet) {
    if (!row || !row.id || S.inbound.has(row.id)) return;
    S.inbound.set(row.id, row);
    var kind = row.kind === "message" ? "reply" : row.kind;
    var text = String(row.text || "").replace(/\[Cross-session [a-z ]+\]/i, "").trim();
    feedPush({
      key: "in" + row.id, ts: row.received_at, kind: kind, label: kind,
      html: "<b>" + esc(row.from_name || "a session") + "</b> → " + (row.kind === "message" ? "" : esc(row.kind) + " ") + '<span class="q">' + esc(clip(text, 300)) + "</span>",
    }, quiet);
    // A session writing back to MINT AI: a reply bead comes home.
    if (!quiet) {
      var s = sessionNamed(row.from_name);
      if (s) Orb.reply(sessKey(s));
    }
  }

  /* ---------------------------------------------------------- stats */

  function renderStats() {
    var c = (S.status && S.status.counts) || {};
    $("cc-stat-deleg").textContent = c.delegations_24h == null ? "—" : c.delegations_24h;
    var since = Date.now() - 24 * 3600 * 1000, done = 0;
    S.delegations.forEach(function (d) { if (d.status === "done" && Date.parse(d.created_at) >= since) done++; });
    $("cc-stat-done").textContent = done;
    var ds = [];
    S.turns.forEach(function (tr) { if (tr.duration_ms && (tr.source === "dashboard" || tr.source === "voice-desk" || tr.source === "remote")) ds.push(tr.duration_ms); });
    ds.sort(function (a, b) { return a - b; });
    $("cc-stat-median").textContent = ds.length ? dur(ds[Math.floor((ds.length - 1) / 2)]) : "—";
  }

  function renderDrawerHead() {
    var p = (S.status && S.status.process) || {};
    var me = selfSession();
    var sub = "CEO" + (p.model ? " · " + modelLabel(p.model) : "") + " · " + ((me && me.cwd) || "/root/moni-ai");
    $("cc-dr-sub").textContent = sub;
    $("cc-dr-sub").title = "CEO session · " + sub.slice(6);
    var rc = (S.status && S.status.remote_control) || {};
    var on = rc.enabled && (rc.state === "connected" || !rc.state);
    $("cc-rc-dot").className = "cc-dot" + (on ? "" : rc.enabled ? " warn" : " off");
    $("cc-rc-text").textContent = !S.online ? "Remote Control state unknown while MINT AI is unreachable." : on
      ? "Mirrors the MINT AI session — the same conversation in Claude Desktop (Remote Control) and here."
      : rc.enabled ? "Remote Control is " + (rc.state || "starting") + " — Claude Desktop may not see this conversation yet."
      : "Remote Control is off — this conversation is only here.";
    $("cc-rc-open").disabled = !rc.enabled;
  }

  function renderAll() {
    renderRail();
    renderSessions();
    renderSteps();
    renderStats();
    renderDrawerHead();
    renderTimeline();
    renderFeed();
    P.renderAll();
    paintState();
    var off = $("cc-offline");
    off.hidden = S.online;
    $("cc-offline-msg").textContent = S.offlineMsg || "";
  }

  /* ================================================================ loading */

  function setStatus(st) {
    var keepMachine = S.status && S.status.machine;
    S.status = st;
    if (st && !st.machine && keepMachine) st.machine = keepMachine;
    if (st && st.approvals) st.approvals.forEach(function (a) { S.approvals.set(a.id, a); });
  }

  function load() {
    return api("overview").then(function (ov) {
      S.online = true;
      S.offlineMsg = "";
      setStatus(ov.status);
      setSessions((ov.sessions && ov.sessions.sessions) || []);
      S.memory = ov.memory;
      S.agents = ov.agents;
      S.loadSeq = ov.status.seq || 0;
      (ov.timeline || []).forEach(function (d) { S.delegations.set(d.id, d); });
      P.load(ov);
      return Promise.all([
        api("ledger/turns?limit=40").catch(function () { return { rows: [] }; }),
        api("ledger/approvals?limit=60").catch(function () { return { rows: [] }; }),
        api("ledger/delegations?limit=150").catch(function () { return { rows: [] }; }),
        api("ledger/inbound?limit=40").catch(function () { return { rows: [] }; }),
      ]);
    }).then(function (r) {
      (r[1].rows || []).forEach(function (a) { if (!S.approvals.has(a.id) || a.status !== "pending") S.approvals.set(a.id, a); });
      (r[2].rows || []).forEach(function (d) { S.delegations.set(d.id, d); });
      (r[3].rows || []).slice().reverse().forEach(function (row) { inboundFeed(row, true); });
      var rows = (r[0].rows || []).filter(visibleTurn).reverse();
      rows.forEach(upsertTurn);
      var cur = S.status.current_turn;
      if (cur) { upsertTurn(cur); S.steps = { turn_id: cur.id, steps: cur.steps || [] }; }
      renderChatEmpty();
      addMoreButton((r[0].rows || []).length === 40);
      renderAll();
      renderTurn({ id: -1 });
      requestAnimationFrame(function () { toBottom(true); });
      // Approvals expire: any already waiting get the card at once.
      if (pendingApprovals().length) openNeed();
      connect(0);
    }).catch(function (e) {
      S.online = false;
      S.offlineMsg = e.status === 403 ? "Your role does not include MINT AI." : e.message;
      renderAll();
      renderChatEmpty();
      setTimeout(load, 5000);
    });
  }

  /* ================================================================ events */

  var es = null, reconnectTimer = 0;
  var EVENTS = ["proc", "init", "rc", "status", "turn", "text", "assistant", "tool", "tool_result", "steps", "result", "approval", "delegation", "inbound", "sessions", "vitals", "notice", "offline",
    "mission", "decision", "watcher", "order", "order_run", "rule", "machine"];

  function connect(since) {
    if (es) es.close();
    es = new EventSource("/mint-ai/api/events" + (since ? "?since=" + since : ""));
    es.onopen = function () {
      if (!S.online) {
        // Back after an outage: the supervisor may have restarted, which resets
        // its sequence -- re-read the state rather than trust a stale cursor.
        S.online = true;
        api("status").then(function (st) {
          if (st.seq < S.lastSeq) { S.lastSeq = 0; S.loadSeq = st.seq; connect(0); }
          setStatus(st);
          renderAll();
        }).catch(function () { /* the stream will say */ });
        P.load();
        renderAll();
      }
    };
    es.onerror = function () {
      if (es.readyState === EventSource.CLOSED) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(function () { connect(S.lastSeq); }, 4000);
      }
    };
    EVENTS.forEach(function (type) {
      es.addEventListener(type, function (m) {
        var ev;
        try { ev = JSON.parse(m.data); } catch (e) { return; }
        onEvent(type, ev);
      });
    });
  }

  function onEvent(type, ev) {
    var replay = !!(ev.seq && ev.seq <= S.loadSeq);
    if (ev.seq) S.lastSeq = Math.max(S.lastSeq, ev.seq);
    if (!replay && ev.ts) S.skew = Date.parse(ev.ts) - Date.now();
    if (type === "offline") {
      S.online = false;
      S.offlineMsg = ev.error || "MINT AI's supervisor is not running";
      renderAll();
      return;
    }
    if (!S.online) { S.online = true; renderAll(); }
    var st = S.status || (S.status = {});
    switch (type) {
      case "vitals":
        st.vitals = ev.vitals;
        if (st.machine && ev.vitals) st.machine.vitals = ev.vitals;
        renderMachine();
        return;
      case "machine":
        if (ev.machine) {
          if (st.machine && st.machine.services && ev.machine.services && !replay) diffServices(st.machine.services, ev.machine.services, ev.ts);
          st.machine = ev.machine;
        }
        renderMachine();
        paintState();
        return;
      case "sessions": {
        var before = S.sessions;
        setSessions(ev.sessions || []);
        st.sessions_at = ev.ts;
        if (!replay) diffSessions(before, S.sessions, ev.ts);
        renderSessions();
        renderRail();
        P.sessionsChanged();
        if (S.target !== "auto" && !liveSessions().some(function (s) { return s.name === S.target; })) {
          if (!replay) toast("“" + S.target + "” stopped running — back to auto-route.", true);
          setTarget("auto");
        }
        return;
      }
      case "turn": {
        var row = ev.turn;
        if (!row || !visibleTurn(row)) return;
        var tr = upsertTurn(row);
        if (ev.phase === "start") {
          st.busy = true;
          st.current_turn = row;
          S.steps = { turn_id: row.id, steps: [] };
        }
        if (ev.phase === "end") {
          if (st.current_turn && st.current_turn.id === row.id) st.current_turn = null;
          st.busy = false;
          if (tr) {
            tr.partial = "";
            if (!replay && voiceTurns.has(row.id)) { Voice.flush(row.id, aiText(tr)); voiceTurns.delete(row.id); }
            else if (!replay && deskTurns.has(row.id)) { deskTurns.delete(row.id); Voice.summary(row.id, aiText(tr)); }
          }
          if (!replay && row.status === "error") feedPush({ key: "t" + row.id + "err", ts: ev.ts, kind: "error", html: "<b>Turn ended with an error</b> · " + esc(clip(row.error || "", 140)) });
          refreshCounts();
        }
        renderSteps();
        renderStats();
        paintState();
        renderSessions(true);
        return;
      }
      case "text": {
        var tt = S.turns.get(ev.turn_id);
        if (!tt) return;
        tt.partial += ev.delta || "";
        if (voiceTurns.has(tt.id)) Voice.feed(tt.id, aiText(tt));
        renderTurn(tt);
        return;
      }
      case "assistant": {
        if (ev.parent_tool_use_id) return;
        var ta = S.turns.get(ev.turn_id);
        if (!ta) return;
        // A finished turn loaded from the ledger already has its answer.
        if (replay && ta.status !== "running" && ta.result_text) return;
        ta.blocks.push(ev.text || "");
        ta.partial = "";
        if (!replay && voiceTurns.has(ta.id)) Voice.feed(ta.id, aiText(ta));
        renderTurn(ta);
        renderSteps();
        return;
      }
      case "steps":
        S.steps = { turn_id: ev.turn_id, steps: ev.steps || [] };
        renderSteps();
        return;
      case "tool":
      case "tool_result":
        return;   // the steps event that follows carries the same, summarised
      case "result":
        if (ev.turn) {
          var tr2 = upsertTurn(ev.turn);
          if (tr2 && !tr2.blocks.length && tr2.result_text && !replay && voiceTurns.has(tr2.id)) Voice.feed(tr2.id, tr2.result_text);
        }
        return;
      case "approval":
        upsertApproval(ev.approval, replay);
        return;
      case "delegation":
        upsertDelegation(ev.delegation, replay);
        return;
      case "inbound":
        inboundFeed(ev.inbound, replay);
        return;
      case "notice":
        feedPush({ key: "n" + ev.seq, ts: ev.ts, kind: ev.level === "warn" ? "warn" : "info", label: ev.level || "info", html: esc(ev.text || "") }, replay);
        return;
      case "proc":
        st.process = st.process || {};
        if (ev.state) st.process.state = ev.state;
        if (ev.pid) st.process.pid = ev.pid;
        feedPush({ key: "p" + ev.seq, ts: ev.ts, kind: ev.state === "ready" ? "info" : ev.state === "error" || ev.state === "blocked" ? "error" : "warn", label: "service",
          html: "<b>MINT AI process</b> · " + esc(ev.state || "") + (ev.error ? " — " + esc(clip(ev.error, 120)) : "") + (ev.retry_in_s ? " · retry in " + ev.retry_in_s + "s" : "") }, replay);
        renderRail();
        paintState();
        return;
      case "init":
        st.process = st.process || {};
        if (ev.model) st.process.model = ev.model;
        renderRail();
        renderDrawerHead();
        return;
      case "rc":
        st.remote_control = st.remote_control || {};
        if (typeof ev.enabled === "boolean") st.remote_control.enabled = ev.enabled;
        if (ev.state) st.remote_control.state = ev.state;
        else if (ev.url) st.remote_control.state = "connected";
        renderDrawerHead();
        // The bridge reports several states on the way up; the log wants the
        // ones a person would care about, once each.
        var rcSay = ev.state === "connected" ? "connected" : typeof ev.enabled === "boolean" && !ev.enabled ? "off" : ev.state === "disconnected" || ev.state === "error" ? ev.state : null;
        if (rcSay && rcSay !== S.rcLast) {
          S.rcLast = rcSay;
          feedPush({ key: "rc" + ev.seq, ts: ev.ts, kind: rcSay === "connected" ? "info" : "warn", label: "remote", html: "<b>Remote Control</b> · " + esc(rcSay) }, replay);
        }
        return;
      case "status":
        return;
      default:
        // mission, decision, watcher, order, order_run, rule
        P.onEvent(type, ev, replay);
        return;
    }
  }

  function diffSessions(before, after, ts) {
    var was = {}, now = {};
    before.forEach(function (s) { was[s.pid] = s; });
    after.forEach(function (s) { now[s.pid] = s; });
    after.forEach(function (s) {
      if (s.self) return;
      if (!was[s.pid]) feedPush({ key: "s+" + s.pid, ts: ts, kind: "session", label: "session", html: "<b>" + esc(s.name || "A session") + "</b> started · " + esc(s.where || "") });
      else if (was[s.pid].status !== s.status && s.status === "waiting") feedPush({ key: "sw" + s.pid + ts, ts: ts, kind: "warn", label: "waiting", html: "<b>" + esc(s.name || "A session") + "</b> is waiting" + (s.waiting_for ? " for " + esc(s.waiting_for) : "") });
    });
    before.forEach(function (s) {
      if (!s.self && !now[s.pid]) feedPush({ key: "s-" + s.pid + ts, ts: ts, kind: "session", label: "session", html: "<b>" + esc(s.name || "A session") + "</b> ended" });
    });
  }
  function diffServices(before, after, ts) {
    var was = {};
    (before.failed || []).forEach(function (f) { was[f.unit] = 1; });
    (after.failed || []).forEach(function (f) {
      if (!was[f.unit]) feedPush({ key: "svc" + f.unit + (f.since || ts), ts: f.since || ts, kind: "error", label: "service", html: "<b>" + esc(f.unit) + "</b> failed" });
    });
  }

  var countsTimer = 0;
  function refreshCounts() {
    clearTimeout(countsTimer);
    countsTimer = setTimeout(function () {
      api("status").then(function (st) {
        var keep = S.status && S.status.vitals;
        setStatus(st);
        if (!st.vitals && keep) st.vitals = keep;
        renderAll();
      }).catch(function () { /* next event will do */ });
    }, 400);
  }
  // Status is the source of truth for anything the events do not carry
  // (counts, queued turns, today's cost); a slow poll keeps it honest.
  setInterval(function () { if (!document.hidden && S.online) refreshCounts(); }, 30000);
  setInterval(function () { if (!document.hidden) renderSessions(true); }, 30000);

  /* ================================================================ voice
     Record, notice the end of an utterance from the level, have the server
     transcribe it with OpenAI, send; read the reply back sentence by sentence
     as it streams (each sentence spoken by OpenAI's realtime voice on the
     server, its audio streamed back and played from the first chunk, the
     next ones fetched while this one plays);
     and stop talking the moment you talk over it. The browser only ever talks
     to this panel. Without a key the controls stay off and say so. */

  var Voice = (function () {
    var cMic = $("cc-c-mic"), dock = $("cc-dock"), vbText = $("cc-vb-text"), wave = $("cc-vb-wave");
    var speakBtn = $("cc-speak-toggle");
    var api_ = {
      on: false, listening: false, speaking: false, speakAll: false,
      say: function () {}, feed: function () {}, flush: function () {}, unlock: function () {}, summary: function () {}, tag: function () {},
    };
    // (Whether a live conversation holds the voice bar; false where the live block is absent, as in the tests' sandbox.)
    function liveOn() { return typeof liveActive === "function" && liveActive(); }
    var AC = window.AudioContext || window.webkitAudioContext;
    var canRecord = !!(navigator.mediaDevices && window.MediaRecorder && AC);
    var supported = canRecord && READY;
    if (!READY) {
      // The server rendered the "Add an OpenAI key in Settings" state; keep it.
      cMic.disabled = true;
    } else if (!canRecord) {
      cMic.disabled = true;
      cMic.title = "Voice unavailable: this browser cannot record audio here.";
    }

    var stream = null, ac = null, analyser = null, rec = null, chunks = [], poll = 0;
    var heard = false, quietFor = 0, floor = 0.006, calibrating = 0, lastRms = 0;
    // What this recording held: time above the speech threshold, and its peak.
    // A recording with less than SPEECH_MS of it is never uploaded: silence
    // sent to the transcription model comes back as its prompt (2026-09-29,
    // a push-to-talk press with nothing said reached MINT AI as a turn).
    var loudMs = 0, peak = 0, SPEECH_MS = 150;
    var ptt = false;
    // END_MS: how long a pause ends what you are saying. 700 ms cut the
    // administrator off mid-thought ("...when I ask you to delegate," went as
    // a whole turn); 1200 ms lets a sentence breathe.
    var SAMPLE_MS = 50, END_MS = 1200, RESET_MS = 8000, MIN_MS = 300, BARGE_MS = 450, BARGE_GRACE_MS = 700, AHEAD = 3;
    var PTT_TAIL_MS = 250, PTT_KEEP_MS = 60000, keepTimer = 0;
    var spoken = 0, queue = [], busy = false, loudFor = 0, gen = 0, clipAt = 0, lastSkipToast = 0;
    // What the voice did, for the console and for tests: window.__moniVoice.
    // items: one record per sentence played -- when it was asked for, when its
    // first chunk arrived, when it started playing, when its stream ended.
    var diag = window.__moniVoice = { fetched: 0, played: 0, playedSeconds: 0, skipped: 0, blocked: 0, bargeIns: 0, cuts: 0, silentDrops: 0, voiceStops: 0, uploads: 0, engines: [], said: [], items: [], cutAt: [] };

    // Wave bars for the voice bar, driven by the real level.
    var BARS = 44;
    wave.innerHTML = new Array(BARS + 1).join("<i></i>");
    var barEls = wave.querySelectorAll("i");

    function recorderFor(s) {
      try { return new MediaRecorder(s, { audioBitsPerSecond: 24000 }); } catch (e) { return new MediaRecorder(s); }
    }
    function speakable(text) {
      return String(text)
        .replace(/```[\s\S]*?```/g, " (code) ")
        .replace(/`[^`\n]+`/g, function (m) { return m.replace(/`/g, ""); })
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/https?:\/\/\S+/g, " a link ")
        .replace(/^\s*[#>]+\s*/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/[*_~|]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    /* Where the reader is in a reply is counted in non-space characters, not
       string offsets: the reply changes shape as it streams (deltas first, then
       the finished blocks joined by blank lines), and an offset into one shape
       used on the other skipped or repeated words at every change. */
    function nonSpace(t) { return t.replace(/\s+/g, "").length; }
    function offsetAfter(text, n) {
      var i = 0, seen = 0;
      while (i < text.length && seen < n) { if (!/\s/.test(text.charAt(i))) seen++; i++; }
      return i;
    }
    /* Whole pieces ready to be read from `rest`. A sentence ends at . ! or ?
       followed by a space (so victim-ui.txt and 2.5 stay whole) or at a line
       end; never inside an unclosed ``` fence. The first piece of a reply may
       end at a clause (a comma, colon, semicolon or dash) so the voice starts
       sooner. */
    function pieces(rest, first) {
      var out = [], at = 0, re = /[.!?]+["')\]]*(?=\s)|\n/g, m;
      if (first) {
        var b = re.exec(rest), bEnd = b ? b.index + b[0].length : Infinity;
        var clause = /[,;:](?=\s)|\s[\u2013\u2014]\s/g, c;
        clause.lastIndex = 25;
        if ((c = clause.exec(rest)) && c.index + c[0].length < bEnd && !/```/.test(rest.slice(0, c.index))) {
          at = c.index + c[0].length;
          out.push(rest.slice(0, at).trim());
        }
      }
      re.lastIndex = at;
      while ((m = re.exec(rest))) {
        var end = m.index + m[0].length;
        if ((rest.slice(0, end).match(/```/g) || []).length % 2) continue;
        var piece = rest.slice(at, end).trim();
        at = end;
        if (piece) out.push(piece);
      }
      return { list: out, consumed: at };
    }
    function level() {
      if (!analyser) return 0;
      var buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
      return Math.sqrt(sum / buf.length);
    }
    Orb.micSource(function () { return liveOn() ? liveLevel("mic") : api_.listening && !api_.speaking ? lastRms : 0; });

    /* ---- the speaker: one AudioContext, an analyser in front of it, so the
       seed core pulses with the reply's real loudness ---- */
    var outCtx = null, outAn = null, outBuf = null, source = null;
    function outContext() {
      if (!AC) return null;
      if (!outCtx) {
        outCtx = new AC();
        outAn = outCtx.createAnalyser();
        outAn.fftSize = 512;
        outAn.connect(outCtx.destination);
        outBuf = new Uint8Array(outAn.fftSize);
      }
      if (outCtx.state === "suspended" && outCtx.resume) outCtx.resume().catch(function () { /* needs a gesture */ });
      return outCtx;
    }
    function outLevel() {
      if (liveOn()) return liveLevel("out");
      if (!api_.speaking) return -1;
      if (!source || !outAn) return 0;
      outAn.getByteTimeDomainData(outBuf);
      var sum = 0;
      for (var i = 0; i < outBuf.length; i++) { var v = (outBuf[i] - 128) / 128; sum += v * v; }
      return Math.sqrt(sum / outBuf.length);
    }
    Orb.outSource(outLevel);

    function setUi() {
      if (!READY) return;
      var live = api_.on || ptt || liveOn();
      dock.classList.toggle("voice-on", live);
      cMic.classList.toggle("live", live);
      cMic.setAttribute("aria-pressed", live ? "true" : "false");
      if (live && api_.speaking) vbText.textContent = "Speaking… talk over it to cut in";
      paintState();
      renderRail();
    }

    /* ---- speaking, streamed: every sentence is a stream of PCM chunks that
       starts to play as soon as its first chunk arrives. The server reads the
       sentence (OpenAI, verbatim-checked while it streams) and sends
       start / audio / cut / end; a cut means that reading failed the check
       mid-way -- what plays of it stops at once, and the fallback's reading of
       the whole sentence follows in the same stream. Sentences are fetched a
       few ahead and play strictly in order; talking over them drops them all.
       Everything goes through one gain node per reading into the analyser, so
       the seed core pulses with the real output level. ---- */
    var RATE = 24000, PREBUF = 0.06, FADE = 0.012;
    var current = null; // the stream playing now: { stop() }

    function newStream(text, meta) {
      return { text: text, meta: meta || {}, chunks: [], ended: false, skipped: "", engine: "", cuts: 0, listener: null, ctrl: null,
        t: { asked: Date.now(), first: 0, end: 0, play: 0 } };
    }
    function pcmToFloat(b64) {
      var bin = atob(b64), n = bin.length >> 1, out = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
        out[i] = (v >= 32768 ? v - 65536 : v) / 32768;
      }
      return out;
    }
    function streamEvent(st, ev) {
      if (!st || st.ended) return;
      if (ev.type === "start") { st.engine = ev.engine || ""; if (ev.engine) diag.engines.push(ev.engine); }
      else if (ev.type === "audio" && ev.pcm) {
        if (!st.t.first) st.t.first = Date.now();
        try { st.chunks.push(pcmToFloat(ev.pcm)); } catch (e) { return; }
        if (st.listener) st.listener("audio");
      } else if (ev.type === "cut") {
        // The reading failed the verbatim check part-way: drop what is held
        // of it; if it is playing, the listener stops it now.
        st.cuts++;
        diag.cuts++;
        st.chunks = [];
        console.info("[voice] cut a reading that did not match the text (" + (ev.why || "unfaithful") + "); the fallback reads it again");
        if (st.listener) st.listener("cut");
      } else if (ev.type === "end" || ev.type === "skipped" || ev.type === "error") {
        st.ended = true;
        st.t.end = Date.now();
        if (ev.type === "skipped" || ev.skipped) st.skipped = ev.why || ev.skipped || "unfaithful";
        else if (ev.type === "error") st.skipped = ev.code || "error";
        if (st.listener) st.listener("end");
      }
    }
    function skippedNote(st) {
      diag.skipped++;
      if (st.skipped !== "unfaithful") return;
      console.warn("[voice] not read aloud (the voice would not read it as written):", st.text);
      var now = Date.now();
      if (now - lastSkipToast > 10000) { lastSkipToast = now; toast("One sentence was not read aloud. It is on the screen."); }
    }
    function readNdjson(r, onEvent) {
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = "";
      function take(line) {
        if (!line.trim()) return;
        var ev;
        try { ev = JSON.parse(line); } catch (e) { return; }
        onEvent(ev);
      }
      function pump() {
        return reader.read().then(function (x) {
          if (x.value) {
            buf += dec.decode(x.value, { stream: true });
            var i;
            while ((i = buf.indexOf("\n")) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
          }
          if (x.done) { take(buf); return; }
          return pump();
        });
      }
      return pump();
    }
    /* The direct path: one POST per sentence, its audio streamed back. */
    function fetchClip(st) {
      var ctrl = window.AbortController ? new AbortController() : null;
      st.ctrl = ctrl;
      var body = { text: st.text };
      if (st.meta.vt) body.vt = st.meta.vt;
      if (st.meta.cat) body.cat = st.meta.cat;
      fetch("/mint-ai/api/speak", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF, Accept: "application/x-ndjson" },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      }).then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (j.code === "no-key") toast("Voice needs an OpenAI key. Add one in Settings.", true);
            streamEvent(st, { type: "error", code: j.code || "error" });
          });
        }
        diag.fetched++;
        return readNdjson(r, function (ev) { streamEvent(st, ev); });
      }).catch(function () { /* aborted, or the network */ }).then(function () {
        if (!st.ended) streamEvent(st, { type: "error", code: "network" });
      });
    }
    function prefetch() {
      for (var i = 0; i < queue.length && i < AHEAD; i++) {
        if (!queue[i].fetched && !queue[i].remote) { queue[i].fetched = true; fetchClip(queue[i]); }
      }
    }
    /* A line the front desk is speaking on the server: its audio arrives in
       the desk's own stream (deskLine), so it joins the queue as it is. */
    function enqueueRemote(text) {
      var st = newStream(String(text || ""));
      st.remote = true;
      if (!READY) return st;
      diag.said.push(st.text.slice(0, 780));
      queue.push(st);
      prefetch();
      pump();
      return st;
    }
    function enqueue(piece, meta) {
      if (!READY) return;
      var say = speakable(piece);
      if (say.length < 2 || !/[a-z0-9]/i.test(say)) return;
      diag.said.push(say.slice(0, 780));
      queue.push(newStream(say.slice(0, 780), meta));
      prefetch();
      pump();
    }
    /* A browser may hold an AudioContext suspended until the page is clicked
       (autoplay rules). Then a clip "plays" into nothing: no error, no sound.
       So: resume before every clip, and if it stays suspended, say so and
       resume on the next click or key, when the waiting clip plays. */
    var unblockArmed = false;
    function blocked(c) {
      diag.blocked++;
      console.warn("[voice] the browser is holding sound back (AudioContext " + c.state + ")");
      if (unblockArmed) return;
      unblockArmed = true;
      toast("Your browser is holding MINT's voice back. Click anywhere on the page to hear it.", true);
      var go = function () {
        unblockArmed = false;
        document.removeEventListener("pointerdown", go, true);
        document.removeEventListener("keydown", go, true);
        if (outCtx && outCtx.resume) outCtx.resume().catch(function () { /* still refused */ });
      };
      document.addEventListener("pointerdown", go, true);
      document.addEventListener("keydown", go, true);
    }
    /* Play one sentence's stream: schedule each chunk right after the one
       before it (a short lead on the first, and after any underrun), stop at
       once on a cut, resolve when the stream has ended and the last chunk has
       played. */
    function playStream(st, my) {
      return new Promise(function (resolve) {
        var c = outContext();
        if (!c) { resolve(); return; }
        if (c.state !== "running" && c.resume) c.resume().then(function () { if (c.state !== "running") blocked(c); }, function () { blocked(c); });
        var gain = null, gains = [], at = 0, live = [], started = false, finished = false, rec = null;
        function freshGain() { gain = c.createGain(); gain.connect(outAn); gains.push(gain); at = 0; }
        freshGain();
        function done() {
          if (finished) return;
          finished = true;
          st.listener = null;
          // Let any fade finish, then take this reading's gain nodes off the graph.
          setTimeout(function () { gains.forEach(function (g) { try { g.disconnect(); } catch (e) { /* gone */ } }); }, 200);
          if (current && current.st === st) current = null;
          resolve();
        }
        function stopLive(fade) {
          var t = c.currentTime;
          if (fade) {
            try { gain.gain.cancelScheduledValues(t); gain.gain.setValueAtTime(gain.gain.value, t); gain.gain.linearRampToValueAtTime(0, t + FADE); } catch (e) { /* closed */ }
          }
          live.forEach(function (s) { s.onended = null; try { s.stop(fade ? t + FADE + 0.003 : 0); } catch (e) { /* ended */ } });
          live = [];
          source = null;
        }
        function maybeDone() {
          if (!st.ended || live.length || st.chunks.length) return;
          if (!started || st.skipped) skippedNote(st);
          else { diag.played++; if (rec) rec.done = Date.now(); }
          done();
        }
        function drain() {
          if (my !== gen) { stopLive(true); return done(); }
          while (st.chunks.length) {
            var f = st.chunks.shift();
            if (!f.length) continue;
            var buf = c.createBuffer(1, f.length, RATE);
            buf.getChannelData(0).set(f);
            var s = c.createBufferSource();
            s.buffer = buf;
            s.connect(gain);
            var now = c.currentTime;
            if (at < now + 0.005) at = now + (started ? 0.02 : PREBUF);
            s.start(at);
            if (!started) {
              started = true;
              st.t.play = Date.now() + Math.round((at - now) * 1000);
              clipAt = st.t.play;
              rec = { text: st.text.slice(0, 80), engine: st.engine, asked: st.t.asked, first: st.t.first, sched: Date.now(), play: st.t.play, end: st.t.end || 0, cuts: 0 };
              diag.items.push(rec);
              // The caption shows this sentence as it is heard, word by word.
              if (api_.onSpeak) { var said = st.text; setTimeout(function () { if (my === gen) api_.onSpeak(said); }, Math.max(0, st.t.play - Date.now())); }
            }
            at += buf.duration;
            diag.playedSeconds += buf.duration;
            live.push(s);
            source = s;
            s.onended = (function (node) {
              return function () {
                var i = live.indexOf(node);
                if (i >= 0) live.splice(i, 1);
                if (!live.length) source = null;
                maybeDone();
              };
            })(s);
          }
          maybeDone();
        }
        current = { st: st, stop: function () { stopLive(true); done(); } };
        st.listener = function (kind) {
          if (my !== gen) { stopLive(true); return done(); }
          if (kind === "end" && rec) rec.end = st.t.end;
          if (kind === "cut") {
            // Stop the failed reading now; the fallback's chunks start afresh.
            if (rec) rec.cuts++;
            diag.cutAt.push({ text: st.text.slice(0, 80), at: Date.now(), playing: live.length > 0 });
            stopLive(true);
            freshGain();
          }
          drain();
        };
        drain();
      });
    }
    function pump() {
      if (busy || !queue.length) return;
      busy = true;
      api_.speaking = true;
      loudFor = 0;
      if (api_.on) { recording(false); if (!poll) poll = setInterval(tick, SAMPLE_MS); }
      setUi();
      var item = queue.shift(), my = gen;
      prefetch();
      playStream(item, my).then(function () {
        if (my !== gen) return;
        busy = false;
        if (queue.length) return pump();
        api_.speaking = false;
        loudFor = 0;
        if (api_.on && !(S.status && S.status.busy)) listen(true);
        setUi();
        usageSoon();
      });
    }
    /** Stop speaking now: the stream playing, the ones fetched, the ones asked for. */
    function silence() {
      gen++;
      queue.forEach(function (q) { q.listener = null; if (q.ctrl) { try { q.ctrl.abort(); } catch (e) { /* done */ } } });
      queue = [];
      if (current) { var cur = current; current = null; cur.stop(); if (cur.st.ctrl) { try { cur.st.ctrl.abort(); } catch (e) { /* done */ } } }
      source = null;
      busy = false;
      api_.speaking = false;
      loudFor = 0;
    }
    /* The usage figures follow a voice turn, once its speech is done. */
    var usageTimer = 0;
    function usageSoon() {
      clearTimeout(usageTimer);
      usageTimer = setTimeout(function () { if (P && P.loadVoiceUsage) P.loadVoiceUsage(); }, 900);
    }

    function bargeIn() {
      if (!api_.speaking) return;
      diag.bargeIns++;
      console.info("[voice] cut in: you spoke over the reply, so the rest of it is not read");
      silence();
      // Hold-to-talk opens the microphone itself; a reply read aloud to typed
      // text may have none open yet (MediaRecorder would throw on no stream).
      if (stream) recording(true);
      vbText.textContent = "Listening…";
      setUi();
    }

    function tick() {
      if (!analyser) return;
      var rms = level();
      lastRms = rms;
      for (var i = 0; i < barEls.length; i++) {
        var h = Math.min(100, 22 + 10 * Math.abs(Math.sin(i * 0.7 + Date.now() / 260)) + rms * 900 * (0.5 + 0.5 * Math.abs(Math.sin(i * 0.9 + Date.now() / 140))));
        barEls[i].style.height = h.toFixed(0) + "%";
      }
      if (calibrating > 0) { calibrating--; floor = Math.max(floor * 0.8 + rms * 0.2, 0.004); return; }
      if (ptt) {
        if (rec && rec.state === "recording") {
          if (rms > peak) peak = rms;
          if (rms > floor * 3 + 0.004) loudMs += SAMPLE_MS;
          heard = loudMs >= SPEECH_MS;
        }
        return;
      }
      if (api_.speaking) {
        // The first moments of a clip are when echo cancelling has not caught
        // up yet, and the speaker leaks into the microphone: do not count them,
        // or MINT cuts itself off and the rest of the reply is dropped.
        if (!source || Date.now() - clipAt < BARGE_GRACE_MS) { loudFor = 0; return; }
        loudFor = rms > floor * 6 + 0.01 ? loudFor + SAMPLE_MS : 0;
        if (loudFor >= BARGE_MS) bargeIn();
        return;
      }
      if (rms > peak) peak = rms;
      if (rms > floor * 3 + 0.004) { heard = true; loudMs += SAMPLE_MS; quietFor = 0; vbText.textContent = "Listening…"; }
      else {
        quietFor += SAMPLE_MS;
        if (heard && quietFor >= END_MS) { if (rec && rec.state !== "inactive") rec.stop(); return; }
        if (!heard && quietFor >= RESET_MS) { quietFor = 0; heard = false; if (rec && rec.state !== "inactive") rec.stop(); }
      }
    }

    function newRecorder() {
      chunks = []; heard = false; quietFor = 0; loudMs = 0; peak = 0;
      var started = Date.now();
      var r = rec = recorderFor(stream);
      r.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      r.onstop = function () {
        var ms = Date.now() - started;
        var level = { ms: ms, loud_ms: loudMs, peak: Math.round(peak * 10000) / 10000 };
        var enough = ms > MIN_MS && chunks.length;
        var type = String(r.mimeType || "audio/webm").split(";")[0];
        // Speech, not just sound: long enough, and above the threshold for
        // long enough -- in both modes. Push to talk used to send whatever it
        // recorded, silence included.
        var spoke = enough && heard && loudMs >= SPEECH_MS;
        var blob = spoke ? new Blob(chunks, { type: type }) : null;
        if (blob) { ack(); transcribeAndSend(blob, undefined, level); }
        else if (ptt) nothingHeard();
        else if (api_.on) newRecorder();
      };
      r.start();
      api_.listening = true;
      setUi();
    }
    /* A push to talk with nothing said: nothing is uploaded, nothing is sent. */
    function nothingHeard() {
      diag.silentDrops++;
      console.info("[voice] nothing heard, so nothing was sent");
      ptt = false;
      listen(false);
      vbText.textContent = "I didn't hear anything.";
      if (!api_.on) keepStream();
      setUi();
    }
    /* "Stop listening" said aloud: the mic closes exactly as if its button
       were clicked, and the words go nowhere -- not to MINT AI, not to the
       desk. A note says so; nothing is spoken. */
    function stoppedByVoice(said) {
      diag.voiceStops++;
      console.info("[voice] \"" + clip(said, 60) + "\" is the stop command: listening stopped, nothing sent");
      stop();
      vbText.textContent = "Stopped listening.";
      toast("Stopped listening.");
    }
    function recording(want) {
      if (want) { if (rec && rec.state === "recording") return; newRecorder(); }
      else {
        if (rec && rec.state !== "inactive") { rec.onstop = null; rec.stop(); }
        rec = null;
        api_.listening = false;
      }
    }
    function listen(want) {
      if (want) {
        if (rec && rec.state === "recording") return;
        calibrating = 8;
        recording(true);
        if (!poll) poll = setInterval(tick, SAMPLE_MS);
        vbText.textContent = "Listening…";
      } else {
        if (poll && !api_.speaking) { clearInterval(poll); poll = 0; }
        recording(false);
      }
      setUi();
    }

    /* Front desk mode: the recording goes to the desk, which answers from the
       snapshot, makes small talk, or passes the request to MINT AI. Its
       sentences arrive one by one, each already checked, and their audio is
       streamed in the same response as it is read on the server -- each
       sentence starts playing with its first chunk. MINT AI's answer is later
       summarised aloud (deskSummary); its full text is on screen as always. */
    function deskLines(my) {
      var lines = {};
      return {
        count: 0,
        take: function (ev) {
          if (ev.type === "line") {
            if (my !== gen) return false; // talked over: the rest is not read
            this.count++;
            lines[ev.i] = enqueueRemote(ev.text);
            return true;
          }
          if (ev.i != null && lines[ev.i]) streamEvent(lines[ev.i], ev);
          return false;
        },
      };
    }
    function deskSend(blob, data, wasPtt, vt, level) {
      var dl = deskLines(gen);
      apiStream("desk/turn", { data: data, mime: blob.type, vt: vt, level: level }, function (ev) {
        if (ev.type === "heard") {
          // The desk does not answer the stop command (ev.stop); a desk that
          // predates it would, so the page checks the words as well.
          if (ev.stop || (ev.text && isStopCommand(ev.text))) return stoppedByVoice(ev.text || "");
          if (ev.text) vbText.textContent = "“" + clip(ev.text, 80) + "”";
        } else if (ev.type === "asked" && ev.turn) {
          var t = ev.turn, tr = upsertTurn(t);
          tags.set(t.id, { vt: vt, cat: "handoff" });
          if (tr && tr.ended_at && aiText(tr)) deskSummary(tr.id, aiText(tr));
          else deskTurns.add(t.id);
          paintState();
        } else dl.take(ev);
      }).then(function (d) {
        if (d.guard) console.info("[voice] the front desk's guard replaced a reply (" + d.guard.rule + ")");
        if (d.usage && P && P.setVoiceUsage) P.setVoiceUsage(d.usage);
        if (!dl.count && api_.on && !busy) listen(true);
      }).catch(function (e) {
        if (e.code === "desk-off") {
          // Switched off in Settings: go direct.
          DESK = false; paintMode();
          return transcribeAndSend(blob, wasPtt, level);
        }
        if (e.message !== "nothing said") toast("The front desk could not answer: " + e.message, true);
        if (!dl.count) enqueue("Sorry, I didn't catch that.");
        if (api_.on) listen(true);
      }).then(function () {
        if (!api_.on && wasPtt) keepStream();
        setUi();
      });
    }
    /* MINT AI's answer to a request the desk passed on: a short summary,
       spoken sentence by sentence as it streams. Read word for word instead
       when the desk says so (a short, plain reply), and whenever the desk
       cannot: switched off, or failing -- the direct path, as before. */
    function deskSummary(id, text) {
      var meta = tags.get(id) || { cat: "handoff" };
      if (!DESK) return api_.flush(id, text);
      var dl = deskLines(gen);
      apiStream("desk/summary", { turn: id, vt: meta.vt }, function (ev) { dl.take(ev); }).then(function (d) {
        if (d.usage && P && P.setVoiceUsage) P.setVoiceUsage(d.usage);
        if (d.fallback === "verbatim" || d.pending || !dl.count) return api_.flush(id, text);
        if (api_.on && !busy && !queue.length) listen(true);
      }).catch(function (e) {
        if (e.code === "desk-off") { DESK = false; paintMode(); }
        else console.warn("[voice] the front desk could not summarise; reading the answer as written:", e.message);
        if (!dl.count) api_.flush(id, text);
      });
    }
    function paintMode() {
      var tag = $("cc-voice-mode");
      if (!tag) return;
      tag.textContent = DESK ? "Front desk · GPT" : "Direct · MINT AI";
      tag.classList.toggle("desk", DESK);
      renderRail();
    }
    /* A voice turn's id, for the usage figures: sent with its transcription,
       its desk turn and every sentence spoken for it. */
    function newVt() { return "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

    function transcribeAndSend(blob, wasPttAgain, level) {
      var wasPtt = wasPttAgain === undefined ? ptt : wasPttAgain;
      var vt = newVt();
      ptt = false;
      listen(false);
      vbText.textContent = "Transcribing…";
      diag.uploads++;
      setUi();
      var reader = new FileReader();
      reader.onload = function () {
        if (DESK) return deskSend(blob, String(reader.result).split(",")[1] || "", wasPtt, vt, level);
        api("transcribe", { body: { data: String(reader.result).split(",")[1] || "", mime: blob.type, vt: vt, level: level } }).then(function (d) {
          var said = String(d.text || "").trim();
          if (!said || /^[\[(]/.test(said)) throw new Error("nothing said");
          if (isStopCommand(said)) return stoppedByVoice(said);
          vbText.textContent = "“" + clip(said, 80) + "”";
          return send(said, { voice: true, acked: true, vt: vt });
        }).catch(function (e) {
          if (e.message !== "nothing said") toast("Could not transcribe that: " + e.message, true);
          enqueue("Sorry, I didn't catch that.");
          if (api_.on) listen(true);
        }).then(function () {
          if (!api_.on && wasPtt) keepStream();
          setUi();
        });
      };
      reader.readAsDataURL(blob);
    }

    function openStream() {
      if (stream) return Promise.resolve();
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (s) {
        stream = s;
        ac = new AC();
        analyser = ac.createAnalyser();
        analyser.fftSize = 1024;
        ac.createMediaStreamSource(stream).connect(analyser);
      });
    }
    /* After a push-to-talk, the microphone stays open for a minute: opening it
       takes a moment, and whatever is said in that moment was never recorded
       (the first word went missing). The browser's mic indicator shows it. */
    function keepStream() {
      clearTimeout(keepTimer);
      keepTimer = setTimeout(function () { if (!api_.on && !ptt) { closeStream(); setUi(); } }, PTT_KEEP_MS);
    }
    function closeStream() {
      clearTimeout(keepTimer);
      if (poll) { clearInterval(poll); poll = 0; }
      recording(false);
      if (stream) stream.getTracks().forEach(function (tr) { tr.stop(); });
      stream = null;
      if (ac) { try { ac.close(); } catch (e) { /* closed */ } ac = null; }
      analyser = null;
      lastRms = 0;
    }

    // "On it." should play the instant a spoken turn is sent; asking for it
    // once here puts it in the server's cache before it is needed.
    var warmed = false;
    function warm() { if (!warmed && READY) { warmed = true; fetchClip(newStream("On it.")); } }

    /* "On it." the moment the recording ends: it is cached on the server, so it
       plays while the words are still being transcribed. */
    function ack() {
      outContext();
      if (DESK) return; // the front desk answers for itself, in well under a second
      enqueue("On it.");
    }

    function start() {
      if (!supported) return;
      clearTimeout(keepTimer);
      outContext();
      warm();
      openStream().then(function () {
        api_.on = true;
        listen(true);
      }).catch(function () { toast("Talking to MINT needs the microphone, and it was refused.", true); });
    }
    function stop() {
      api_.on = false;
      silence();
      closeStream();
      setUi();
    }

    /* ---- the mic's mode: push to talk (the default) or hands-free ----
       Push to talk: hold the mic (or Space) and release to send; a quick tap
       keeps it listening until the mic in the voice bar, or Space, sends it.
       Hands-free: the mic stays open and a pause sends (the quiet window).
       The choice is remembered per browser. */
    var MODE_KEY = "moni-voice-mode", TAP_MS = 350;
    var mode = voiceModeFrom(null), modeBtn = $("cc-mic-mode"), vbMode = $("cc-vb-mode"), downAt = 0, pttLabel = "";
    try { mode = voiceModeFrom(window.localStorage.getItem(MODE_KEY)); } catch (e) { /* storage blocked: the default */ }
    function paintVoiceMode() {
      var ptt_ = mode === "ptt";
      cMic.title = !READY ? cMic.title : !canRecord ? cMic.title
        : ptt_ ? "Push to talk: hold to talk, release to send (a quick tap keeps listening). Or hold Space."
        : "Hands-free: click to start listening; a pause sends what you said. Click again to stop.";
      cMic.setAttribute("data-mode", mode);
      if (modeBtn) {
        modeBtn.textContent = ptt_ ? "Push to talk" : "Hands-free";
        modeBtn.setAttribute("data-mode", mode);
        var vmBtn = $("cc-vm");
        if (vmBtn) vmBtn.title = ptt_ ? "Voice mode: push to talk — hold the mic or Space to talk. Open for hands-free, read-aloud and the core." : "Voice mode: hands-free — the mic listens and a pause sends. Open for push to talk, read-aloud and the core.";
      }
      if (vbMode) vbMode.textContent = ptt_ ? "Push to talk" : "Hands-free";
    }
    function setVoiceMode(m) {
      mode = voiceModeFrom(m);
      try { window.localStorage.setItem(MODE_KEY, mode); } catch (e) { /* not remembered; still switched */ }
      if (mode === "ptt" && api_.on) stop();
      paintVoiceMode();
    }
    // The switch itself is the voice menu under the composer (openVoiceMenu).
    api_.setMode = setVoiceMode;
    api_.mode = function () { return mode; };
    paintVoiceMode();

    /** Start a push-to-talk recording (Space or the mic held). */
    function pttDown(label) {
      if (!supported || api_.on || ptt) return false;
      ptt = true;
      pttLabel = label;
      outContext();
      warm();
      if (api_.speaking) bargeIn();
      clearTimeout(keepTimer);
      openStream().then(function () {
        if (!ptt) return keepStream();
        calibrating = 0;
        recording(true);
        if (!poll) poll = setInterval(tick, SAMPLE_MS);
        vbText.textContent = pttLabel;
        setUi();
      }).catch(function () { ptt = false; setUi(); toast("Talking to MINT needs the microphone, and it was refused.", true); });
      return true;
    }
    /** Release: send what was said. */
    function pttUp() {
      if (!ptt) return;
      // A short tail, so the last syllable is not cut off by a quick release.
      if (rec && rec.state === "recording") { var r0 = rec; setTimeout(function () { if (r0.state === "recording") r0.stop(); }, PTT_TAIL_MS); }
      else { ptt = false; keepStream(); setUi(); }
    }
    /** Back to typing without sending. */
    function pttCancel() {
      ptt = false;
      recording(false);
      if (poll && !api_.speaking) { clearInterval(poll); poll = 0; }
      keepStream();
      setUi();
    }

    cMic.addEventListener("pointerdown", function (e) {
      if (mode !== "ptt" || (e.button !== undefined && e.button !== 0)) return;
      e.preventDefault();
      if (!pttDown("Listening — release to send")) return;
      downAt = Date.now();
      var up = function () {
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (Date.now() - downAt >= TAP_MS) return pttUp();
        // A tap: keep listening until the voice bar's mic or Space sends it.
        if (ptt) vbText.textContent = pttLabel = "Listening — press the mic or Space to send";
      };
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
    cMic.addEventListener("click", function () {
      if (mode === "ptt") return; // pointerdown/up handle it
      api_.on ? stop() : start();
    });
    $("cc-vb-stop").addEventListener("click", function () {
      if (ptt) return pttUp();
      // Stop and send what has been said so far, if anything.
      if (rec && rec.state === "recording" && heard) { api_.on = false; rec.stop(); setTimeout(stop, 50); }
      else stop();
    });
    $("cc-vb-close").addEventListener("click", function () { if (ptt) pttCancel(); stop(); });

    /* Hold Space to talk, anywhere but a text field or a control. */
    function typing(el) { return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || el.tagName === "BUTTON" || el.getAttribute("role") === "radio"); }
    document.addEventListener("keydown", function (e) {
      if (e.code !== "Space" || e.repeat || !supported || api_.on || ptt || typing(document.activeElement)) return;
      e.preventDefault();
      pttDown("Listening — release Space to send");
    });
    document.addEventListener("keyup", function (e) {
      if (e.code !== "Space" || !ptt) return;
      e.preventDefault();
      pttUp();
    });

    speakBtn.hidden = !READY;
    speakBtn.addEventListener("click", function () {
      api_.speakAll = !api_.speakAll;
      if (api_.speakAll) outContext();
      speakBtn.setAttribute("aria-pressed", api_.speakAll ? "true" : "false");
      speakBtn.innerHTML = ic(api_.speakAll ? "speaker" : "mute");
      speakBtn.title = api_.speakAll ? "Replies are read aloud — click to keep them silent" : "Replies are silent — click to read MINT AI's replies aloud";
      if (!api_.speakAll && !api_.on) { silence(); setUi(); }
    });

    // What each turn's speech is counted as: {vt, cat}, set by send() and the desk.
    var tags = new Map();
    api_.tag = function (id, meta) { if (id != null && meta) tags.set(id, meta); };
    api_.unlock = function () { if (READY) outContext(); };
    api_.summary = function (id, text) { if (READY) deskSummary(id, text); };
    api_.say = function (text) { if (READY) enqueue(text); };
    var spokenTurn = null;
    api_.feed = function (id, text) {
      text = String(text || "");
      if (id !== spokenTurn) { spokenTurn = id; spoken = 0; }
      var rest = text.slice(offsetAfter(text, spoken));
      var found = pieces(rest, spoken === 0);
      spoken += nonSpace(rest.slice(0, found.consumed));
      var meta = tags.get(id);
      found.list.forEach(function (p) { enqueue(p, meta); });
    };
    api_.flush = function (id, text) {
      text = String(text || "");
      if (id !== spokenTurn) { spokenTurn = id; spoken = 0; }
      var rest = text.slice(offsetAfter(text, spoken));
      var found = pieces(rest, spoken === 0);
      var meta = tags.get(id);
      found.list.forEach(function (p) { enqueue(p, meta); });
      var tail = rest.slice(found.consumed).trim();
      spoken = 0;
      spokenTurn = null;
      if (tail) enqueue(tail, meta);
      if (api_.on && !busy && !queue.length) listen(true);
    };
    return api_;
  })();

  /* ================================================================ LIVE CONVERSATION (trial)
     Integration block for public/voice-live.js, which holds all of the live
     logic (see its header and the README's integration contract). This only:
       - offers the mode in the voice menu (administrators, when Settings has it
         on: data-voice-live="1"), remembered per browser;
       - starts and ends a call from the mic, the voice bar's End and close
         buttons, and mutes from its mute button (Space and push to talk are
         left alone while a call is on);
       - feeds the core and the caption: onState -> the state the core and the
         caption show (listening / thinking / speaking / delegating, with an
         "interrupted" flash on the voice bar), onCaption -> the caption's
         sentence, word by word, onLevel -> the core's amplitude. */
  var LIVE_OK = READY && root.getAttribute("data-voice-live") === "1" && !!(window.VoiceLive && window.VoiceLive.supported());
  var LIVE_KEY = "mint-voice-live";
  var LiveUI = { selected: false, active: false, state: "idle", caption: "", who: "", mic: 0, out: 0 };
  try { LiveUI.selected = LIVE_OK && window.localStorage.getItem(LIVE_KEY) === "1"; } catch (e) { /* storage blocked: not selected */ }
  var LIVE_TEXT = {
    connecting: "Connecting…", listening: "Listening — just talk", talking: "You're talking…", thinking: "Thinking…",
    speaking: "Speaking — talk over it to interrupt", interrupted: "Interrupted — go ahead", waiting: "Passed to MINT AI — waiting for its answer",
    muted: "Muted — the microphone is off", ended: "Conversation ended", error: "The live conversation stopped", idle: "",
  };
  var LIVE_TIP = "Live conversation (trial): talk freely and interrupt any time. Headphones are advised — without them the speaker can leak into the microphone. Say “stop listening” or press End to finish.";
  function liveSelected() { return !!(LiveUI && LiveUI.selected); }
  function liveMenuItem(mode) {
    if (!(READY && root.getAttribute("data-voice-live") === "1")) return "";
    var ok = !!(window.VoiceLive && window.VoiceLive.supported());
    return '<button type="button" role="menuitemradio" data-vmode="live" aria-checked="' + (mode === "live") + '"' + (ok ? "" : " disabled") + ' title="' + esc(LIVE_TIP) + '"><span class="chk"></span>Live conversation<small><b>trial</b> · headphones advised</small></button>';
  }
  function liveSelect(on) {
    LiveUI.selected = !!(on && LIVE_OK);
    try { window.localStorage.setItem(LIVE_KEY, LiveUI.selected ? "1" : "0"); } catch (e) { /* not remembered */ }
    if (!LiveUI.selected && LiveUI.active) liveStop();
    paintLiveMode();
    paintLiveKeys();
  }
  function paintLiveMode() {
    var mb = $("cc-mic-mode");
    if (LiveUI.selected) {
      if (mb) { mb.textContent = "Live conversation"; mb.setAttribute("data-mode", "live"); }
      $("cc-c-mic").title = LIVE_TIP;
    } else if (Voice.setMode) Voice.setMode(Voice.mode()); // repaint the ordinary mode
  }
  function paintLive(st) {
    LiveUI.state = st;
    var dock = $("cc-dock"), on = LiveUI.active;
    dock.classList.toggle("live-on", on);
    dock.classList.toggle("voice-on", on || Voice.on);
    dock.setAttribute("data-live", on ? st : "");
    $("cc-c-mic").classList.toggle("live", on);
    $("cc-live-acts").hidden = !on;
    $("cc-live-tag").hidden = !on;
    var muted = on && st === "muted";
    $("cc-live-mute").setAttribute("aria-pressed", muted ? "true" : "false");
    $("cc-live-mute").title = muted ? "Unmute the microphone" : "Mute the microphone (the conversation stays open)";
    // One tag says it all; the model and voice are in its tooltip.
    $("cc-live-tag").title = "Live conversation (trial)" + (LiveUI.model ? " · " + LiveUI.model : "") + (LiveUI.voice ? " · voice " + LiveUI.voice : "") + ". Headphones are advised.";
    paintLiveKeys();
    if (on) {
      if (!(LiveUI.who === "you" && st === "thinking")) $("cc-vb-text").textContent = LIVE_TEXT[st] || st;
    }
    paintState();
  }
  function liveStart() {
    if (LiveUI.active || !LIVE_OK) return;
    LiveUI.active = true;
    LiveUI.who = "";
    if (Voice.on) $("cc-vb-close").click();
    paintLive("connecting");
    window.VoiceLive.start({
      csrf: CSRF,
      worklet: root.getAttribute("data-live-worklet") || undefined,
      onState: function (st) { if (LiveUI.active) paintLive(st); },
      onCaption: function (c) {
        LiveUI.who = c.who;
        LiveUI.caption = c.text;
        if (c.who === "you") $("cc-vb-text").textContent = c.text;
        paintState();
      },
      onLevel: function (l) { LiveUI.mic = l.mic || 0; LiveUI.out = l.out || 0; },
      onEvent: function (m) {
        if (m.type === "ready") { LiveUI.model = m.model || ""; LiveUI.voice = m.voice || ""; paintLive(LiveUI.state); }
        if (m.type === "stop") toast("Stopped listening. The live conversation has ended.");
        else if (m.type === "error" && m.code === "busy") toast(m.error, true);
        if (m.type === "ended" || m.type === "error") liveEnded(m);
      },
    }).catch(function (e) {
      toast("Live conversation: " + ((e && e.message) || "could not start"), true);
      liveEnded({});
    });
  }
  function liveEnded() {
    if (!LiveUI.active) return;
    LiveUI.active = false;
    LiveUI.caption = "";
    paintLive("idle");
    Voice.setMode(Voice.mode());
    paintLiveMode();
  }
  function liveStop() { if (window.VoiceLive) window.VoiceLive.stop(); liveEnded(); }
  /** What the core and the caption show while a call is on (see snapshot()). */
  function liveSnapshot(snap) {
    if (!liveActive()) return snap;
    var st = LiveUI.state;
    snap.listening = st === "listening" || st === "talking" || st === "interrupted" || st === "connecting";
    snap.speaking = st === "speaking";
    snap.voiceLive = st === "thinking";
    snap.voiceText = $("cc-vb-text").textContent;
    snap.spoken = st === "speaking" && LiveUI.who !== "you" ? LiveUI.caption : "";
    if (st === "waiting") { snap.delegatingTo = "MINT AI"; snap.delegation = "Passed to MINT AI — its answer will be read when it arrives."; }
    return snap;
  }
  // The mic, Space and the voice bar belong to the call while one is on.
  window.addEventListener("pointerdown", function (e) {
    if (!LiveUI.selected || !e.target.closest || !e.target.closest("#cc-c-mic")) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  window.addEventListener("click", function (e) {
    if (!e.target.closest) return;
    if (LiveUI.selected && e.target.closest("#cc-c-mic")) { e.stopPropagation(); e.preventDefault(); return LiveUI.active ? liveStop() : liveStart(); }
    if (LiveUI.active && (e.target.closest("#cc-vb-close") || e.target.closest("#cc-live-end"))) { e.stopPropagation(); return liveStop(); }
    if (LiveUI.active && e.target.closest("#cc-live-mute")) { e.stopPropagation(); return window.VoiceLive.mute(!window.VoiceLive.muted()); }
  }, true);
  // Keys while live is the mode: Space starts a call, then mutes and unmutes it; Esc ends it
  // (when nothing else is open for Esc to close). Push to talk's Space is never reached.
  window.addEventListener("keydown", function (e) {
    if (!LiveUI.selected || e.repeat || liveTyping(document.activeElement)) return;
    if (e.code === "Space") {
      e.stopPropagation();
      e.preventDefault();
      if (!LiveUI.active) liveStart();
      else window.VoiceLive.mute(!window.VoiceLive.muted());
    } else if (e.key === "Escape" && LiveUI.active && $("cc-pop").hidden && $("cc-reply").hidden && !document.querySelector(".cc-sheet.open") && !document.querySelector(".cc-need:not([hidden])")) {
      e.stopPropagation();
      liveStop();
    }
  }, true);
  window.addEventListener("keyup", function (e) { if (LiveUI.selected && e.code === "Space" && !liveTyping(document.activeElement)) e.stopPropagation(); }, true);
  /** The hint under the pill: what Space and Esc do while live is the mode. */
  function paintLiveKeys() {
    var sp = $("cc-kb-space"), lk = $("cc-kb-live");
    if (!sp || !lk) return;
    sp.hidden = !!LiveUI.selected;
    lk.hidden = !LiveUI.selected;
    lk.innerHTML = LiveUI.active ? "<kbd>Space</kbd> mute · <kbd>Esc</kbd> end" : "<kbd>Space</kbd> start a conversation";
  }
  function liveTyping(el) { return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || el.tagName === "BUTTON"); }
  window.addEventListener("beforeunload", function () { if (LiveUI.active) window.VoiceLive.stop(); });
  if (LiveUI.selected) paintLiveMode();
  paintLiveKeys();
  /* ============================================================ end of the live integration block */

  /* ================================================================ panels
     Missions, Decisions, Rules and Watchers, standing orders, cost, the deep
     view and the palette live in cc-panels.js; this is what they are given. */

  var CC = {
    S: S, root: root, api: api, esc: esc, ic: ic, md: md, num: num, clip: clip, firstLine: firstLine, plain: plain, money: money,
    hm: hm, hms: hms, when: when, ago: ago, dur: dur, modelLabel: modelLabel, applyBars: applyBars, toast: toast,
    fmtDay: fmtDay, fmtHM: fmtHM, fmtDate: fmtDate, TZ: TZ,
    AI_NAME: AI_NAME, isAiName: isAiName, aiLabel: aiLabel,
    liveSessions: liveSessions, selfSession: selfSession, sessKey: sessKey, sessState: sessState, sessIcon: sessIcon, sessWhere: sessWhere,
    selfState: selfState, findSess: findSess, sessionNamed: sessionNamed, sortSessions: sortSessions, subagentLabel: subagentLabel,
    setTarget: setTarget, showPane: showPane, openSheet: openSheet, closeSheet: closeSheet, send: send, focusInput: function () { input.focus(); },
    setCore: setCoreChoice, coreNow: coreNow, renderNeed: renderNeed, openNeed: openNeed, voice: function () { return Voice; },
    pendingApprovals: pendingApprovals, approvalHTML: approvalHTML, approvalCmd: approvalCmd, upsertApproval: upsertApproval,
    upsertTurn: upsertTurn, feedPush: feedPush, renderRail: renderRail, renderSessions: renderSessions, renderTurn: renderTurn, paintState: paintState,
    openRemoteControl: openRemoteControl, interrupt: interrupt, map: Orb, TL_LAB: TL_LAB,
    resyncSessions: function () { setSessions(S.sessions.filter(function (s) { return !s.synthetic; })); renderSessions(true); },
  };
  var P = window.MoniPanels(CC);

  /* ================================================================ keys */

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (menu) { closeMenu(); return; }
    if (e.defaultPrevented) return;   // the palette or a dialog took it
    if (!$("cc-pop").hidden) { closePop(); return; }
    if (!$("cc-reply").hidden) { closeReply(); return; }
    if (S.pane) { closeSheet(); return; }
    if (Need.open) closeNeed();
  });

  /* The caption follows the voice bar's line (Listening…, what was heard,
     Transcribing…) and the sentence being spoken. */
  Voice.onSpeak = function (text) { S.spoken = text; paintState(); };
  if (window.MutationObserver) new MutationObserver(function () { paintCaption(); }).observe($("cc-vb-text"), { childList: true, characterData: true, subtree: true });

  /* ================================================================ start */

  tick();
  setInterval(tick, 1000);
  Orb.start();
  paintCoreSwitches();
  renderAll();
  load();
  // Web fonts change the caption's height, and with it where the core sits.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { Orb.resize(); });
  window.addEventListener("load", function () { Orb.resize(); });
})();
