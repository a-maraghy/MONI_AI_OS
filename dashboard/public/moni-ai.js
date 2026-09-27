"use strict";
/*
 * The MONI AI Command Center, live.
 *
 * Reads the JSON API under /moni-ai/api/ once on load (overview, the turns,
 * approvals, delegations and inbound ledgers), then follows the supervisor's
 * event stream over Server-Sent Events. Everything on screen is built here from
 * that data, and every string that came from the server goes through esc() or
 * the console's markdown renderer (MD, from console.js), which escapes first.
 *
 * The seed core in the middle is one canvas driven by requestAnimationFrame:
 * DPR-aware, paused while the tab is hidden, and a still frame for anyone who
 * has asked for reduced motion. Its states come from real events -- thinking
 * while a turn runs, delegating when a SendMessage lands (light runs down the
 * root to that session), listening while the microphone records, speaking
 * while a reply is read aloud.
 *
 * Voice goes through OpenAI, on the server only: the page posts its recording
 * to /moni-ai/api/transcribe and each sentence of a reply to /moni-ai/api/speak
 * (a WAV comes back), with the same end-of-utterance detection and barge-in.
 * No key set, no voice: the controls say where to add one.
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
  var reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  /* ================================================================ helpers */

  function $(id) { return document.getElementById(id); }
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
    return fetch("/moni-ai/api/" + path, init).then(function (r) {
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
  };

  function nowServer() { return Date.now() + S.skew; }

  function liveSessions() { return S.sessions.filter(function (s) { return !s.self; }); }
  function selfSession() { return S.sessions.filter(function (s) { return s.self; })[0] || null; }
  function sessState(s) { return s.status === "busy" ? "working" : s.status === "waiting" ? "waiting" : "idle"; }
  function sessionFor(d) {
    var list = S.sessions;
    for (var i = 0; i < list.length; i++) if (d.target_pid && list[i].pid === d.target_pid) return list[i];
    for (var j = 0; j < list.length; j++) if (list[j].name && list[j].name === d.target_name && !list[j].self) return list[j];
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
    $("cc-clock").textContent = fmtHMS.format(d);
    $("cc-clock-date").textContent = fmtDate.format(d) + " · Cairo";
    tickApprovals();
  }

  /* ================================================================ theme
     The switch itself is the shell's (app.js); the canvas only has to repaint
     in the new palette when the theme, or the system's, changes. */

  document.addEventListener("moni-theme", function () { Orb.palette(); });

  /* ================================================================ the seed core
     A sunflower head of florets laid on the golden angle, with a root grown out
     to every live session. A delegation sends a bead of sap down that root and
     the session blooms when it lands. States blend through weights. No per-frame
     allocation: typed arrays, cached sprites, cached label widths. */

  var Orb = (function () {
    var canvas = $("cc-orb"), ctx = canvas.getContext("2d");
    var W = 0, H = 0, DPR = 1, CX = 0, CY = 0, R = 60, RX = 100, RY = 100;
    var STATES = ["idle", "listening", "thinking", "delegating", "speaking"];
    var SI = 0;
    var WGT = new Float32Array([1, 0, 0, 0, 0]);
    var GOLDEN = Math.PI * (3 - Math.sqrt(5)), TAU = Math.PI * 2;
    var N = 460;
    var FX = new Float32Array(N), FY = new Float32Array(N), FS = new Float32Array(N), FBK = new Uint8Array(N);
    var MAXN = 12;
    var NODES = [];                      // {key, label, st}
    var NS = 0;
    var NODE_ANG = new Float32Array(MAXN), NX = new Float32Array(MAXN), NY = new Float32Array(MAXN), BLOOM = new Float32Array(MAXN);
    var RT = new Float32Array(MAXN * 8);
    var BEND = new Float32Array([0.22, -0.2, 0.18, -0.22, 0.2, -0.18, 0.21, -0.19, 0.17, -0.21, 0.19, -0.17]);
    var LABEL_W = new Float32Array(MAXN);
    var DASH = [3, 5], NODASH = [];
    var PAL = {}, SPR_GLOW = null, SPR_SAP = null;
    var PK_N = 4, PK_K = new Int8Array(PK_N).fill(-1), PK_T0 = new Float64Array(PK_N), PK_DUR = 1300;
    var BP = { x: 0, y: 0 };
    var mic = 0, amp = 0, rot = 0, targetK = 0, micLevel = null, outLevel = null;
    var t0 = performance.now(), last = t0, running = false;
    var STATS = { frames: 0, total: 0 };
    window.__orbStats = STATS;
    var FONT_LABEL = "600 11.5px ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif";
    var FONT_TITLE = "700 15px ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif";
    var FONT_SUB = "700 9.5px ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif";

    function sprite(color, size) {
      var c = document.createElement("canvas"); c.width = c.height = size; var g = c.getContext("2d");
      var gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gr.addColorStop(0, color); gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr; g.fillRect(0, 0, size, size); return c;
    }
    function measure() {
      ctx.font = FONT_LABEL;
      for (var k = 0; k < NS; k++) LABEL_W[k] = ctx.measureText(NODES[k].label).width;
    }
    function palette() {
      var cs = getComputedStyle(document.documentElement);
      ["floret", "floret-mid", "floret-hi", "core", "root", "root-hi", "sap", "glow", "hud", "node-bg", "label-bg", "label-line", "label-ink", "ink", "sub", "work", "wait", "idle", "off", "off-ink"].forEach(function (k) {
        PAL[k.replace("-", "_")] = cs.getPropertyValue("--orb-" + k).trim();
      });
      PAL.light = cs.getPropertyValue("color-scheme").indexOf("light") >= 0;
      SPR_GLOW = sprite(PAL.glow || "rgba(95,191,63,.5)", 256);
      SPR_SAP = sprite(PAL.sap || "#eaffd2", 64);
      measure();
      if (!running) draw(performance.now());
    }
    function stateCol(k) { var s = NODES[k].st; return s === "working" ? PAL.work : s === "waiting" ? PAL.wait : s === "offline" ? PAL.off : PAL.idle; }

    /** Angles spread evenly, starting up and to the left as in the design. */
    function angles() {
      var step = TAU / Math.max(1, NS), start = -Math.PI / 2 - step / 2;
      for (var k = 0; k < NS; k++) {
        var a = start + k * step;
        a = a - TAU * Math.floor((a + Math.PI) / TAU);
        NODE_ANG[k] = a;
      }
    }
    function setNodes(list) {
      NODES = list.slice(0, MAXN);
      NS = NODES.length;
      angles();
      measure();
      if (targetK >= NS) targetK = 0;
      if (!running) draw(performance.now());
    }
    function resize() {
      var r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1);
      W = r.width; H = r.height; if (!W || !H) return;
      canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      CX = W / 2; CY = H * 0.5;
      R = Math.max(40, Math.min(W * 0.12, H * 0.17));
      RX = Math.min(W * 0.38, W / 2 - 110); RY = Math.min(H * 0.36, H / 2 - 64);
      measure();
      draw(performance.now());
    }
    function bez(k, tt) {
      var o = k * 8, u = 1 - tt, a = u * u * u, b = 3 * u * u * tt, c = 3 * u * tt * tt, d = tt * tt * tt;
      BP.x = a * RT[o] + b * RT[o + 2] + c * RT[o + 4] + d * RT[o + 6];
      BP.y = a * RT[o + 1] + b * RT[o + 3] + c * RT[o + 5] + d * RT[o + 7];
    }
    function layoutNodes(time) {
      for (var k = 0; k < NS; k++) {
        var a = NODE_ANG[k] + (reduced ? 0 : 0.035 * Math.sin(time * 0.25 + k * 1.7));
        var nx = CX + Math.cos(a) * RX, ny = CY + Math.sin(a) * RY;
        NX[k] = nx; NY[k] = ny;
        var ang = Math.atan2(ny - CY, nx - CX), sx = CX + Math.cos(ang) * R * 0.78, sy = CY + Math.sin(ang) * R * 0.78;
        var dx = nx - sx, dy = ny - sy, L = Math.sqrt(dx * dx + dy * dy) || 1, px = -dy / L, py = dx / L;
        var sway = reduced ? 0 : Math.sin(time * 0.6 + k * 2.1) * 0.05;
        var b = (BEND[k] + sway) * L, o = k * 8;
        RT[o] = sx; RT[o + 1] = sy;
        RT[o + 2] = sx + dx * 0.3 + px * b; RT[o + 3] = sy + dy * 0.3 + py * b;
        RT[o + 4] = sx + dx * 0.7 - px * b * 0.55; RT[o + 5] = sy + dy * 0.7 - py * b * 0.55;
        RT[o + 6] = nx; RT[o + 7] = ny;
      }
    }
    function strokeRoot(k, upto) {
      var o = k * 8;
      ctx.beginPath(); ctx.moveTo(RT[o], RT[o + 1]);
      if (upto >= 1) ctx.bezierCurveTo(RT[o + 2], RT[o + 3], RT[o + 4], RT[o + 5], RT[o + 6], RT[o + 7]);
      else for (var i = 1; i <= 24; i++) { bez(k, upto * i / 24); ctx.lineTo(BP.x, BP.y); }
      ctx.stroke();
    }
    function drawRoots(time) {
      ctx.lineCap = "round";
      for (var k = 0; k < NS; k++) {
        var st = NODES[k].st, off = st === "offline";
        ctx.strokeStyle = off ? PAL.off : PAL.root;
        ctx.setLineDash(off ? DASH : NODASH);
        ctx.globalAlpha = off ? 0.55 : 0.9; ctx.lineWidth = off ? 1.2 : 2.2; strokeRoot(k, 1);
        ctx.setLineDash(NODASH);
        ctx.lineWidth = 1; ctx.globalAlpha = off ? 0.3 : 0.55;
        ctx.beginPath();
        for (var j = 1; j <= 3; j++) {
          var tt = 0.22 * j + 0.06, side = (j + k) % 2 ? 1 : -1;
          bez(k, tt); var x0 = BP.x, y0 = BP.y; bez(k, tt + 0.02);
          var tx = BP.x - x0, ty = BP.y - y0, tl = Math.sqrt(tx * tx + ty * ty) || 1; tx /= tl; ty /= tl;
          var len = 9 + 5 * ((j * 7 + k) % 3), ca = 0.8 * side;
          var rx = tx * Math.cos(ca) - ty * Math.sin(ca), ry = tx * Math.sin(ca) + ty * Math.cos(ca);
          ctx.moveTo(x0, y0); ctx.quadraticCurveTo(x0 + rx * len * 0.6 + tx * 3, y0 + ry * len * 0.6 + ty * 3, x0 + rx * len, y0 + ry * len);
        }
        ctx.stroke();
        if (st === "working") {
          for (var s = 0; s < 3; s++) {
            var u = reduced ? (s + 0.5) / 3 : (time * 0.32 + s / 3) % 1;
            bez(k, u); ctx.globalAlpha = 0.9 * Math.sin(u * Math.PI);
            ctx.drawImage(SPR_SAP, BP.x - 9, BP.y - 9, 18, 18);
            ctx.fillStyle = PAL.sap; ctx.beginPath(); ctx.arc(BP.x, BP.y, 1.8, 0, TAU); ctx.fill();
          }
        }
      }
      ctx.globalAlpha = 1;
    }
    function drawHud(time) {
      var wl = WGT[1], ws = WGT[4], wt = WGT[2];
      ctx.save(); ctx.translate(CX, CY);
      ctx.strokeStyle = PAL.hud; ctx.globalAlpha = 0.13; ctx.lineWidth = 1; ctx.setLineDash(DASH);
      ctx.beginPath(); ctx.ellipse(0, 0, Math.max(1, RX), Math.max(1, RY), 0, 0, TAU); ctx.stroke(); ctx.setLineDash(NODASH);
      ctx.rotate(reduced ? 0 : time * (0.05 + wt * 0.25));
      var r1 = R * 1.34, i, a;
      ctx.globalAlpha = 0.18; ctx.beginPath();
      for (i = 0; i < 120; i++) { if (i % 10 === 0) continue; a = i / 120 * TAU; ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.lineTo(Math.cos(a) * (r1 + 4), Math.sin(a) * (r1 + 4)); }
      ctx.stroke();
      ctx.globalAlpha = 0.55; ctx.beginPath();
      for (i = 0; i < 120; i += 10) { a = i / 120 * TAU; ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.lineTo(Math.cos(a) * (r1 + 9), Math.sin(a) * (r1 + 9)); }
      ctx.stroke();
      ctx.restore();
      ctx.save(); ctx.translate(CX, CY); ctx.rotate(reduced ? 0 : -time * (0.1 + wt * 0.5));
      ctx.strokeStyle = PAL.hud; ctx.globalAlpha = 0.5 + 0.3 * wt; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, R * 1.22, 0, 0.7); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, R * 1.22, 1.3, 1.75); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, R * 1.22, 2.6, 3.9); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, R * 1.22, 4.4, 4.85); ctx.stroke();
      ctx.restore();
      if (wl > 0.01) {
        ctx.strokeStyle = PAL.hud; ctx.lineWidth = 2; ctx.globalAlpha = 0.75 * wl; ctx.beginPath();
        for (i = 0; i < 72; i++) {
          a = i / 72 * TAU;
          var lv = mic * (0.45 + 0.55 * Math.abs(Math.sin(a * 3 + time * 3.1) * Math.sin(a * 5 - time * 1.7)));
          var q1 = R * 1.06, q2 = q1 + 3 + lv * R * 0.34;
          ctx.moveTo(CX + Math.cos(a) * q1, CY + Math.sin(a) * q1); ctx.lineTo(CX + Math.cos(a) * q2, CY + Math.sin(a) * q2);
        }
        ctx.stroke();
      }
      if (ws > 0.01) {
        ctx.strokeStyle = PAL.hud; ctx.lineWidth = 1.5;
        for (i = 0; i < 4; i++) {
          var kk = reduced ? i / 4 : (time * 0.55 + i / 4) % 1;
          ctx.globalAlpha = ws * (0.45 * (1 - kk)) * (0.5 + amp);
          ctx.beginPath(); ctx.arc(CX, CY, R * (1.05 + kk * 1.1), 0, TAU); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
    function drawHead(time) {
      var wi = WGT[0], wl = WGT[1], wt = WGT[2], wd = WGT[3], ws = WGT[4];
      var breathe = 1 + (reduced ? 0 : 0.035 * Math.sin(time * 1.15)) * (wi + 0.4);
      var div = GOLDEN + wt * 0.0065 * Math.sin(time * 0.9);
      var tang = NS ? Math.atan2(NY[targetK] - CY, NX[targetK] - CX) : 0;
      var glow = 0.55 + 0.15 * wl + 0.3 * wt + 0.25 * wd + 0.35 * ws * amp;
      ctx.globalAlpha = Math.min(1, glow * (PAL.light ? 0.7 : 0.85));
      var gs = R * (2.9 + 0.35 * mic * wl + 0.3 * amp * ws);
      ctx.drawImage(SPR_GLOW, CX - gs / 2, CY - gs / 2, gs, gs);
      var sp = R * Math.sqrt(Math.PI / N), i;
      for (i = 0; i < N; i++) {
        var f = (i + 0.5) / N, rn = Math.sqrt(f), th = i * div + rot;
        var r = R * rn * breathe;
        var b = 0.25 + 0.45 * (1 - rn);
        if (wl > 0.01) r += wl * mic * R * 0.22 * f * (0.6 + 0.4 * Math.sin(th * 3 + time * 4));
        if (wt > 0.01) { var wv = Math.sin(i * 0.045 - time * 6); b += wt * 0.5 * (wv > 0.6 ? wv : 0); }
        if (ws > 0.01) { var sw = Math.sin(rn * 14 - time * 9); r += ws * (0.3 + amp) * R * 0.06 * sw; b += ws * (0.25 + amp) * 0.6 * (sw > 0.25 ? sw : 0); }
        if (wd > 0.01 && NS) {
          var dA = th - tang; dA = dA - TAU * Math.floor((dA + Math.PI) / TAU);
          var arm = 1 - Math.abs(dA) / 0.55;
          if (arm > 0) { var pulse = 0.5 + 0.5 * Math.sin(rn * 12 - time * 14); arm *= wd * pulse; r *= 1 + 0.16 * arm * rn; b += arm * 0.9; }
        }
        FX[i] = CX + Math.cos(th) * r; FY[i] = CY + Math.sin(th) * r;
        FS[i] = sp * (0.26 + 0.2 * rn) * (1 + 0.22 * (b - 0.25));
        FBK[i] = b > 0.85 ? 3 : b > 0.6 ? 2 : b > 0.4 ? 1 : 0;
      }
      for (var bk = 0; bk < 4; bk++) {
        ctx.beginPath();
        for (i = 0; i < N; i++) if (FBK[i] === bk) { ctx.moveTo(FX[i] + FS[i], FY[i]); ctx.arc(FX[i], FY[i], FS[i], 0, TAU); }
        ctx.fillStyle = bk === 3 ? PAL.floret_hi : bk === 2 ? PAL.floret_mid : PAL.floret;
        ctx.globalAlpha = bk === 3 ? 0.95 : PAL.light ? 0.62 + bk * 0.13 : 0.45 + bk * 0.2;
        ctx.fill();
      }
      ctx.globalAlpha = 0.9; ctx.fillStyle = PAL.core;
      ctx.beginPath(); ctx.arc(CX, CY, R * 0.07 * (1 + 0.5 * wt + 0.6 * amp * ws + 0.4 * mic * wl), 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.textAlign = "center"; ctx.font = FONT_TITLE; ctx.fillStyle = PAL.ink;
      ctx.fillText("MONI AI", CX, CY + R * 1.34 + 26);
      ctx.font = FONT_SUB; ctx.fillStyle = PAL.sub;
      ctx.fillText("CEO · ALL SESSIONS", CX, CY + R * 1.34 + 40);
    }
    function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
    function drawNodes(time) {
      for (var k = 0; k < NS; k++) {
        var x = NX[k], y = NY[k], st = NODES[k].st, col = stateCol(k), r = 7;
        if (BLOOM[k] > 0) {
          var bl = BLOOM[k], open = 1 - bl, pr = 8 + open * 22;
          ctx.fillStyle = PAL.idle; ctx.globalAlpha = 0.55 * bl;
          ctx.beginPath();
          for (var p = 0; p < 8; p++) {
            var pa = p / 8 * TAU + open * 0.6, px = x + Math.cos(pa) * pr * 0.6, py = y + Math.sin(pa) * pr * 0.6;
            ctx.moveTo(px + pr * 0.42, py); ctx.ellipse(px, py, pr * 0.42, pr * 0.16, pa, 0, TAU);
          }
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(x, y, r + 5, 0, TAU); ctx.fillStyle = PAL.node_bg; ctx.fill();
        ctx.lineWidth = 1.2; ctx.strokeStyle = st === "offline" ? PAL.off : PAL.hud; ctx.globalAlpha = st === "offline" ? 0.8 : 0.6; ctx.stroke();
        if (st === "working" || st === "waiting") {
          var kk = reduced ? 0.4 : (time * 0.8) % 1;
          ctx.beginPath(); ctx.arc(x, y, r + 5 + kk * 13, 0, TAU); ctx.strokeStyle = col; ctx.globalAlpha = 0.7 * (1 - kk); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (st !== "offline") { ctx.globalAlpha = 0.8; ctx.drawImage(st === "working" ? SPR_SAP : SPR_GLOW, x - 13, y - 13, 26, 26); ctx.globalAlpha = 1; }
        ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, TAU); ctx.fillStyle = col; ctx.fill();
        var tw = LABEL_W[k], lw = tw + 16, lh = 20;
        var above = NODE_ANG[k] < -0.3;
        var lx = x - lw / 2, ly = above ? y - r - 10 - lh : y + r + 9;
        if (lx < 8) lx = 8; if (lx + lw > W - 8) lx = W - 8 - lw;
        ctx.fillStyle = PAL.label_bg; ctx.strokeStyle = BLOOM[k] > 0 ? PAL.hud : PAL.label_line; ctx.lineWidth = 1;
        roundRect(lx, ly, lw, lh, 10); ctx.fill(); ctx.stroke();
        ctx.font = FONT_LABEL; ctx.textAlign = "left"; ctx.fillStyle = st === "offline" ? PAL.off_ink : PAL.label_ink;
        ctx.fillText(NODES[k].label, lx + 8, ly + 14);
      }
    }
    function drawPackets(now, dt) {
      for (var p = 0; p < PK_N; p++) {
        var k = PK_K[p]; if (k < 0) continue;
        if (k >= NS) { PK_K[p] = -1; continue; }
        var e = (now - PK_T0[p]) / PK_DUR;
        if (e >= 1.6) { PK_K[p] = -1; continue; }
        var u = e < 1 ? (e < 0.5 ? 2 * e * e : 1 - Math.pow(-2 * e + 2, 2) / 2) : 1;
        var fade = e < 1 ? 1 : (1.6 - e) / 0.6;
        ctx.strokeStyle = PAL.sap; ctx.lineWidth = 8; ctx.globalAlpha = 0.18 * fade; strokeRoot(k, u);
        ctx.strokeStyle = PAL.root_hi; ctx.lineWidth = 3; ctx.globalAlpha = 0.95 * fade; strokeRoot(k, u);
        if (e < 1) {
          for (var j = 7; j >= 0; j--) {
            var tu = u - j * 0.022; if (tu < 0) continue;
            bez(k, tu); var sz = (1 - j / 8);
            ctx.globalAlpha = 0.85 * sz; ctx.drawImage(SPR_SAP, BP.x - 14 * sz, BP.y - 14 * sz, 28 * sz, 28 * sz);
          }
          bez(k, u); ctx.globalAlpha = 1; ctx.fillStyle = PAL.sap; ctx.beginPath(); ctx.arc(BP.x, BP.y, 3.6, 0, TAU); ctx.fill();
        } else if (BLOOM[k] <= 0 && e < 1.05) { BLOOM[k] = 1; }
      }
      for (var k2 = 0; k2 < NS; k2++) if (BLOOM[k2] > 0) BLOOM[k2] = Math.max(0, BLOOM[k2] - dt * 0.9);
      ctx.globalAlpha = 1;
    }
    function draw(now) {
      if (!W || !SPR_GLOW) return;
      var tStart = performance.now();
      var time = (now - t0) / 1000, dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
      for (var s = 0; s < 5; s++) { var tg = s === SI ? 1 : 0; WGT[s] += (tg - WGT[s]) * (reduced ? 1 : Math.min(1, dt * 4)); }
      // The microphone's real level while listening, and the reply's real level
      // while it is read aloud (from an analyser on the speaker). A voice-like
      // envelope stands in only when no level is on offer.
      var lvl = micLevel ? micLevel() : 0;
      mic += ((0.12 + Math.min(1, lvl * 9)) - mic) * Math.min(1, dt * 12);
      var out = outLevel ? outLevel() : -1;
      var sy = out >= 0 ? Math.min(1, out * 5) : Math.abs(Math.sin(time * 9.5)) * (0.55 + 0.45 * Math.sin(time * 1.7)) * (Math.sin(time * 0.8) > -0.55 ? 1 : 0.1);
      amp += (sy - amp) * Math.min(1, dt * 14);
      if (reduced) { mic = 0.5; amp = 0.6; }
      rot += dt * (0.05 + WGT[2] * 0.55 + WGT[3] * 0.1 + WGT[1] * 0.05);
      ctx.clearRect(0, 0, W, H);
      layoutNodes(time);
      drawHud(time);
      drawRoots(time);
      drawPackets(now, dt);
      drawHead(time);
      drawNodes(time);
      STATS.frames++; STATS.total += performance.now() - tStart;
    }
    function loop(now) { if (!running) return; draw(now); requestAnimationFrame(loop); }
    function start() { if (reduced || running || document.hidden) return; running = true; last = performance.now(); requestAnimationFrame(loop); }
    function stop() { running = false; }
    document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });
    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas); else window.addEventListener("resize", resize);

    return {
      palette: palette,
      resize: resize,
      start: start,
      setNodes: setNodes,
      setState: function (name) {
        var i = STATES.indexOf(name);
        if (i < 0 || i === SI) return;
        SI = i;
        if (!running) draw(performance.now());
      },
      pulse: function (key) {
        var k = -1;
        for (var i = 0; i < NS; i++) if (NODES[i].key === key) k = i;
        if (k < 0) return false;
        targetK = k;
        for (var p = 0; p < PK_N; p++) if (PK_K[p] < 0) { PK_K[p] = k; PK_T0[p] = performance.now(); break; }
        if (reduced) { BLOOM[k] = 0.6; draw(performance.now()); }
        return true;
      },
      micSource: function (fn) { micLevel = fn; },
      outSource: function (fn) { outLevel = fn; },
    };
  })();

  /* ================================================================ core state
     One place decides what the seed core shows and what the pills say. */

  var stateTimer = 0;
  function orbState() {
    if (Voice.listening && !Voice.speaking) return "listening";
    if (Voice.speaking) return "speaking";
    if (Date.now() < S.delegatingUntil) return "delegating";
    if (S.status && S.status.busy) return "thinking";
    return "idle";
  }
  var LABEL = { idle: "Idle", listening: "Listening", thinking: "Thinking", delegating: "Delegating", speaking: "Speaking" };
  function paintState() {
    var st = orbState();
    Orb.setState(st);
    var pending = pendingApprovals().length;
    var pill = $("cc-state"), dot = $("cc-state-dot"), label = $("cc-state-label");
    pill.className = "cc-state-pill";
    if (!S.online) {
      label.textContent = "Offline"; dot.className = "cc-dot bad"; pill.classList.add("bad");
    } else if (pending) {
      label.textContent = "Awaiting approval"; dot.className = "cc-dot warn"; pill.classList.add("warn");
    } else {
      label.textContent = LABEL[st]; dot.className = "cc-dot" + (st === "thinking" || st === "delegating" ? " work" : "");
    }
    var chip = $("cc-sys"), cdot = $("cc-sys-dot");
    var lng = chip.querySelector(".long"), sht = chip.querySelector(".short");
    function lab(l, s) { lng.textContent = l; sht.textContent = s; }
    chip.className = "cc-sys-chip";
    var proc = S.status && S.status.process;
    if (!S.online) {
      chip.classList.add("bad"); cdot.className = "cc-dot bad"; lab("MONI AI offline", "Offline");
    } else if (proc && proc.state !== "ready") {
      chip.classList.add(proc.state === "starting" || proc.state === "stopping" ? "warn" : "bad");
      cdot.className = "cc-dot warn"; lab("MONI AI " + proc.state, proc.state);
    } else if (pending) {
      chip.classList.add("warn"); cdot.className = "cc-dot warn"; lab("Awaiting approval", "Approval");
    } else if (S.status && S.status.busy) {
      cdot.className = "cc-dot work"; lab("MONI AI working", "Working");
    } else {
      cdot.className = "cc-dot"; lab("All systems nominal", "Nominal");
    }
    $("cc-stop").hidden = !(S.status && S.status.busy);
    clearTimeout(stateTimer);
    if (S.delegatingUntil > Date.now()) stateTimer = setTimeout(paintState, S.delegatingUntil - Date.now() + 30);
  }

  /* ================================================================ left rail */

  function setCore(key, sub, st, cls) {
    var li = document.querySelector('[data-core="' + key + '"]');
    if (!li) return;
    li.querySelector("[data-sub]").textContent = sub;
    var el = li.querySelector("[data-st]");
    el.textContent = st;
    el.className = "cc-st" + (cls ? " " + cls : "");
  }

  function renderRail() {
    var st = S.status || {};
    var proc = st.process || {};
    var vit = st.vitals || {};
    $("cc-host").textContent = vit.host || "—";
    if (!S.online) setCore("core", S.offlineMsg || "supervisor unreachable", "Offline", "bad");
    else setCore("core", modelLabel(proc.model) + (proc.effort ? " · " + proc.effort : ""), proc.state === "ready" ? "Online" : proc.state || "—", proc.state === "ready" ? "" : "warn");

    var live = liveSessions();
    var c = { working: 0, waiting: 0, idle: 0 };
    live.forEach(function (s) { c[sessState(s)]++; });
    var parts = [];
    if (c.working) parts.push(c.working + " working");
    if (c.waiting) parts.push(c.waiting + " waiting");
    parts.push(c.idle + " idle");
    setCore("sessions", parts.join(" · "), live.length + " live", "");

    var ag = S.agents;
    if (ag && !ag.error && ag.total != null) {
      var names = (ag.channels || []).map(function (x) { return x.charAt(0).toUpperCase() + x.slice(1); });
      setCore("agents", names.length ? names.join(" · ") : "no channels", ag.active + (ag.active !== ag.total ? "/" + ag.total : ""), ag.active ? "" : "off");
    } else {
      setCore("agents", ag === null && S.online && S.status ? "not in your role" : "unavailable", "—", "off");
    }

    var mem = S.memory;
    if (mem && !mem.error) {
      setCore("memory", num(mem.facts) + " facts", mem.healthy ? "Synced" : "Degraded", mem.healthy ? "" : "warn");
    } else setCore("memory", "unavailable", "—", "off");

    setCore("voice", READY ? "OpenAI · " + (VOICE || "voice") : "OpenAI · no key", Voice.listening ? "Live" : READY ? "Ready" : "Off", Voice.listening ? "warn" : READY ? "" : "off");

    var pend = pendingApprovals().length;
    var mins = Math.round((st.approval_timeout_s || 300) / 60);
    setCore("guard", "Asks before destructive", pend ? pend + " waiting" : "On", pend ? "warn" : "");
    var gl = document.querySelector('[data-core="guard"]');
    if (gl) gl.title = "Destructive steps wait for Approve; nobody answering in " + mins + " min means denied.";

    renderVitals();
    renderMemory();
  }

  var RING_C = 2 * Math.PI * 30;
  function ring(label, v) {
    var pct = v == null ? 0 : Math.max(0, Math.min(100, v));
    return '<div><div class="cc-ring"><svg viewBox="0 0 76 76" aria-hidden="true"><circle class="trk" cx="38" cy="38" r="30" fill="none" stroke-width="6"/>' +
      (v == null ? "" : '<circle class="val' + (pct > 75 ? " hot" : "") + '" cx="38" cy="38" r="30" fill="none" stroke-width="6" stroke-linecap="round" stroke-dasharray="' + (RING_C * pct / 100).toFixed(1) + " " + RING_C.toFixed(1) + '"/>') +
      '<circle class="tick" cx="38" cy="38" r="36" fill="none" stroke-width="1" stroke-dasharray="1 4"/></svg>' +
      '<span class="v">' + (v == null ? "—" : Math.round(pct) + "%") + '</span></div><div class="cc-ring-l">' + label + "</div></div>";
  }
  function renderVitals() {
    var v = (S.status && S.status.vitals) || {};
    $("cc-rings").innerHTML = ring("CPU", v.cpu_pct) + ring("RAM", v.mem && v.mem.pct) + ring("DISK", v.disk && v.disk.pct);
    $("cc-vit-aside").textContent = "live" + (v.cpus ? " · " + v.cpus + " vCPU" : "") + (v.mem ? " · " + bytesGB(v.mem.total) : "");
    $("cc-load").textContent = v.load ? "Load " + v.load.map(function (x) { return x.toFixed(2); }).join(" · ") : "Load —";
    $("cc-up").textContent = v.uptime_s ? upDur(v.uptime_s) : "—";
  }
  function renderMemory() {
    var m = S.memory || {};
    $("cc-mem-facts").textContent = num(m.facts);
    $("cc-mem-chunks").textContent = num(m.chunks);
    $("cc-mem-sessions").textContent = num(m.sessions);
    $("cc-mem-last").textContent = m.last_facts ? hm(m.last_facts) : "—";
    $("cc-mem-aside").textContent = m.last_ingest ? "ingest " + hm(m.last_ingest) : m.error ? "unavailable" : "—";
    $("cc-mem-topics").innerHTML = (m.topics || []).slice(0, 4).map(function (x) { return '<span class="cc-tag">' + esc(x) + "</span>"; }).join("");
  }
  (function constellation() {
    var pts = [], s = "", i, j;
    for (i = 0; i < 18; i++) { var a = i * 2.39996, rr = 6 + 36 * Math.sqrt((i + 0.5) / 18); pts.push([48 + rr * Math.cos(a), 48 + rr * Math.sin(a)]); }
    for (i = 0; i < pts.length; i++) for (j = i + 1; j < pts.length; j++) {
      var dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
      if (dx * dx + dy * dy < 420) s += '<line class="ln" x1="' + pts[i][0].toFixed(1) + '" y1="' + pts[i][1].toFixed(1) + '" x2="' + pts[j][0].toFixed(1) + '" y2="' + pts[j][1].toFixed(1) + '" stroke-width=".8"/>';
    }
    pts.forEach(function (p, k) { s += '<circle class="pt' + (k % 5 === 0 ? " big" : "") + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (k % 5 === 0 ? 3 : 1.8) + '"/>'; });
    $("cc-constellation").innerHTML = '<circle class="rim" cx="48" cy="48" r="46" stroke-dasharray="2 3"/>' + s;
  })();

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
  function sessLast(s) {
    var d = s.last_delegation;
    if (s.self) return S.status && S.status.busy ? "working on a turn now" : "the CEO session · ready";
    if (d && Date.now() - Date.parse(d.updated_at || d.created_at) < 6 * 3600 * 1000) {
      return ago(d.updated_at || d.created_at) + " · " + (d.status === "ack" ? "replied" : d.status) + ": " + clip(d.summary || firstLine(d.text), 60);
    }
    if (s.waiting_for) return "waiting for " + s.waiting_for;
    return (sessState(s) === "idle" ? "idle " : "busy ") + (s.status_since ? ago(s.status_since) : "") + " · " + (s.cwd || "");
  }
  function sortSessions(list) {
    return list.slice().sort(function (a, b) {
      if (a.self !== b.self) return a.self ? 1 : -1;
      return String(a.started_at || "").localeCompare(String(b.started_at || "")) || (a.pid || 0) - (b.pid || 0);
    });
  }
  function renderSessions(force) {
    var list = sortSessions(S.sessions);
    var sig = JSON.stringify(list.map(function (s) {
      return [s.pid, s.name, s.status, s.waiting_for, s.where, s.open_delegations, s.last_delegation && [s.last_delegation.id, s.last_delegation.status]];
    })) + "|" + S.target + "|" + (S.status && S.status.busy);
    var live = liveSessions();
    $("cc-sess-aside").textContent = live.length + " live" + (S.status && S.status.sessions_at ? " · polled " + ago(S.status.sessions_at) : "") + " · → delegate · open where it runs";
    if (sig === sessSig && !force) return;
    sessSig = sig;

    Orb.setNodes(sortSessions(live).map(function (s) {
      return { key: sessKey(s), label: clip(s.name || "unnamed session", 26), st: sessState(s) };
    }));

    var el = $("cc-sessions");
    if (!list.length) {
      el.innerHTML = '<div class="cc-sessions-empty">' + (S.online ? "No Claude Code sessions are registered on this machine right now." : "Sessions appear here when MONI AI's supervisor is reachable.") + "</div>";
      return;
    }
    el.innerHTML = list.map(function (s) {
      var st = s.self ? (S.status && S.status.busy ? "working" : "idle") : sessState(s);
      var key = sessKey(s);
      var name = s.name || "unnamed session";
      return '<article class="cc-card cc-sess ' + st + (s.self ? " self" : "") + '" data-sess="' + esc(key) + '" title="' + esc((s.cwd || "") + " · pid " + (s.pid || "?")) + '">' +
        '<span class="cc-sess-ic">' + ic(sessIcon(s)) + "</span>" +
        '<div class="cc-sess-main"><div class="cc-sess-name">' + esc(name) + "</div>" +
        '<div class="cc-sess-where"><span class="cc-st-inline ' + st + '">' + st + " · </span>" + esc(s.where || s.kind || "session") + "</div>" +
        '<div class="cc-sess-last">' + esc(sessLast(s)) + "</div></div>" +
        '<span class="cc-sess-state ' + st + '"><span class="cc-dot ' + (st === "working" ? "work" : st === "waiting" ? "wait" : "idle") + '"></span>' + st + "</span>" +
        '<div class="cc-sess-actions">' +
        '<button type="button" class="cc-ib pri" data-delegate="' + esc(key) + '" title="' + (s.self ? "MONI AI is the one you are talking to" : "Delegate to " + esc(name) + "…") + '" aria-label="Delegate to ' + esc(name) + '"' + (s.self ? " disabled" : "") + ">" + ic("delegate") + "</button>" +
        '<button type="button" class="cc-ib" data-open="' + esc(key) + '" title="' + (s.self ? "Open in Claude Desktop" : "Where it runs") + '" aria-label="Open ' + esc(name) + '">' + ic("open") + "</button></div></article>";
    }).join("");
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
    var d = e.target.closest("[data-delegate]"), o = e.target.closest("[data-open]");
    if (d && !d.disabled) {
      var s = findSess(d.getAttribute("data-delegate"));
      if (s) setTarget(s.name);
      $("cc-input").focus();
    }
    if (o) {
      var so = findSess(o.getAttribute("data-open"));
      if (so) openPopover(so, o);
    }
  });

  /* A small card by the button: where the session runs, and how to get to it. */
  var pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  function placePop(el, anchor) {
    var r = anchor.getBoundingClientRect();
    var w = 320, h = el.offsetHeight;
    var x = Math.min(window.innerWidth - w - 12, Math.max(12, r.right - w));
    var y = r.top - h - 8;
    if (y < 64) y = Math.min(window.innerHeight - h - 12, r.bottom + 8);
    el.style.left = x + "px";
    el.style.top = y + "px";
  }
  function openPopover(s, anchor) {
    closePop();
    pop = document.createElement("div");
    pop.className = "cc-pop";
    pop.setAttribute("role", "dialog");
    var st = s.self ? (S.status && S.status.busy ? "working" : "idle") : sessState(s);
    var rows = [
      ["runs in", s.where || s.kind || "—"],
      ["directory", s.cwd || "—"],
      ["state", st + (s.status_since ? " since " + hm(s.status_since) : "")],
      ["started", s.started_at ? hm(s.started_at) + " · pid " + (s.pid || "?") : "—"],
    ];
    if (!s.self) rows.push(["open", String(s.open_delegations || 0) + " delegation" + (s.open_delegations === 1 ? "" : "s")]);
    var how = s.self
      ? "MONI AI is reached from Claude Desktop through Remote Control only — never by resuming its session, which would fork it."
      : /Desktop/.test(s.where || "")
      ? "It is a Claude Desktop session: open it from the Desktop app's session list on the machine that started it" + (s.remote_control ? ", or from claude.ai/code, since Remote Control is on." : ".")
      : s.remote_control
      ? "Remote Control is on: it is listed in Claude Desktop and at claude.ai/code."
      : "It runs in a terminal on this machine; attach to it there.";
    pop.innerHTML = "<h4>" + ic(sessIcon(s)) + esc(clip(s.name || "unnamed session", 40)) + "</h4><dl>" +
      rows.map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>"; }).join("") + "</dl><p>" + esc(how) + "</p>" +
      '<div class="cc-pop-act">' + (s.self ? '<button type="button" class="cc-btn pri" data-rc>' + ic("open") + "Open in Claude Desktop</button>" : "") +
      '<button type="button" class="cc-btn" data-close>Close</button></div>';
    document.body.appendChild(pop);
    placePop(pop, anchor);
    pop.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-close]")) closePop();
      if (ev.target.closest("[data-rc]")) { openRemoteControl(); closePop(); }
    });
    var first = pop.querySelector("button");
    if (first) first.focus();
  }
  document.addEventListener("click", function (e) {
    if (pop && !pop.contains(e.target) && !e.target.closest("[data-open]")) closePop();
  });

  /** The Remote Control link, fetched when asked for and never kept on the page. */
  function openRemoteControl() {
    var w = window.open("about:blank", "_blank");
    api("rc").then(function (rc) {
      var url = rc && rc.url;
      if (!rc.enabled || !url || !/^https:\/\/claude\.ai\//.test(url)) {
        if (w) w.close();
        toast(rc && rc.enabled ? "Remote Control has no session link yet." : "Remote Control is off for MONI AI.", true);
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

  /* ================================================================ composer */

  var input = $("cc-input");
  function setTarget(name) {
    S.target = name && name !== "auto" ? name : "auto";
    var set = S.target !== "auto";
    $("cc-target-label").textContent = set ? "→ " + clip(S.target, 26) : "Auto-route";
    $("cc-vb-target").textContent = set ? "→ " + clip(S.target, 22) : "Auto-route";
    $("cc-target").classList.toggle("set", set);
    $("cc-target").title = set ? "Addressed to " + S.target + " (MONI AI delegates it there)" : "MONI AI picks the session";
    input.placeholder = set ? "Tell " + clip(S.target, 30) + " what to do…" : "Tell MONI AI what to do…";
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
    var h = '<button type="button" role="menuitemradio" aria-checked="' + (S.target === "auto") + '" data-t="auto" class="' + (S.target === "auto" ? "on" : "") + '">' + ic("route") + '<span class="nm">Auto-route</span><small>MONI AI decides</small></button><hr>';
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

  function hint(text, bad) {
    var h = document.querySelector(".cc-hint");
    if (!h.getAttribute("data-default")) h.setAttribute("data-default", h.innerHTML);
    if (!text) { h.innerHTML = h.getAttribute("data-default"); h.classList.remove("err"); return; }
    h.textContent = text;
    h.classList.toggle("err", !!bad);
  }

  var voiceTurns = new Set();    // turns whose reply is read aloud
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
    return api("send", { body: body }).then(function (r) {
      hint("");
      if (!opts.voice) input.value = "";
      if (r && r.turn) {
        upsertTurn(r.turn);
        if (opts.voice || Voice.speakAll) voiceTurns.add(r.turn.id);
        if (opts.voice) Voice.say(r.queued_behind ? "Got it. I'll pick that up as soon as I'm free." : "On it.");
      }
      showPane("conv");
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
  $("cc-stop").addEventListener("click", function () {
    $("cc-stop").disabled = true;
    api("interrupt", { body: {} }).then(function () { toast("Interrupting the current turn…"); })
      .catch(function (e) { toast("Could not interrupt: " + e.message, true); })
      .then(function () { $("cc-stop").disabled = false; });
  });

  /* ================================================================ drawer */

  function showPane(id) {
    var bs = document.querySelectorAll(".cc-dr-tabs button");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-selected", bs[i].getAttribute("data-pane") === id ? "true" : "false");
    ["conv", "tl", "feed"].forEach(function (p) { $("cc-pane-" + p).hidden = p !== id; });
    if (id === "conv") toBottom(true);
  }
  document.querySelector(".cc-dr-tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-pane]");
    if (b) showPane(b.getAttribute("data-pane"));
  });
  $("cc-collapse").addEventListener("click", function () { root.classList.remove("drawer-wide"); root.classList.toggle("drawer-closed"); setTimeout(Orb.resize, 240); });
  $("cc-expand").addEventListener("click", function () { root.classList.remove("drawer-closed"); root.classList.toggle("drawer-wide"); setTimeout(Orb.resize, 240); });

  var scroller = $("cc-chat-scroll");
  function atBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60; }
  function toBottom(force) { if (force || atBottom()) scroller.scrollTop = scroller.scrollHeight; }

  /* ---------------------------------------------------------- conversation
     One block per turn: what came in (you, Remote Control, or a peer session),
     then MONI AI's bubble -- its text as it streams, the delegations the turn
     made and any approval it is waiting on. */

  var chat = $("cc-chat");
  var TURN_SRC = {
    dashboard: "You", remote: "You · Remote Control", peer: "Message from a session",
    idle: "Idle notice", delivery: "Delivery notice", system: "System", unknown: "Turn",
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
    for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k)) cur[k] = row[k];
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

  function inboundHTML(tr) {
    var who = TURN_SRC[tr.source] || "Turn";
    var when = hm(tr.created_at);
    var text = tr.text || "";
    if (tr.source === "dashboard" || tr.source === "remote") {
      var name = tr.source === "dashboard" ? (tr.actor && tr.actor !== VIEWER ? esc(tr.actor) : "You") : "You · via Remote Control";
      return '<div class="cc-msg me"><div class="who"><b>' + name + "</b> · " + esc(when) + (tr.target ? " · → " + esc(clip(tr.target, 30)) : "") + '</div><div class="cc-bubble">' + esc(text) + "</div></div>";
    }
    if (tr.source === "peer") {
      return '<div class="cc-msg ai"><div class="who"><span class="cc-av"></span><b>' + esc(tr.actor || "A session") + "</b> · " + esc(when) + ' · peer message</div><div class="cc-bubble"><div class="cc-relay"><div class="src">' + esc(tr.actor || "session") + " → MONI AI</div>" + md(clip(text, 4000)) + "</div></div></div>";
    }
    var line = clip(firstLine(text.replace(/\[Cross-session [a-z ]+\]/i, "")) || who, 160);
    return '<div class="cc-msg sys"><div class="cc-bubble">' + esc(who) + (tr.actor ? " · " + esc(tr.actor) : "") + " · " + esc(when) + (line && line !== who ? " — " + esc(line) : "") + "</div></div>";
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
    return "this machine · MONI AI runs it as root";
  }
  function approvalCmd(a) {
    var inp = a.input || {};
    if (a.tool === "SendMessage") return { text: String(inp.message || a.summary || ""), shell: false };
    if (typeof inp.command === "string") return { text: inp.command, shell: true };
    return { text: a.summary || a.tool, shell: false };
  }
  function approvalHTML(a) {
    var res = a.status === "pending" ? "" : a.status === "approved" ? "ok" : "no";
    var cmd = approvalCmd(a);
    var head = res === "ok" ? "Approved" : a.status === "denied" ? "Denied" : a.status === "expired" ? "Expired" : a.status === "cancelled" ? "Withdrawn" : "Approval needed";
    var what = a.tool === "SendMessage" ? "send this to <b>" + esc(String((a.input || {}).to || "a session").replace(/\s*\[[0-9a-f]+\]$/, "")) + "</b>" : a.tool === "Bash" || a.tool === "Monitor" ? "run this command" : "use <b>" + esc(a.tool) + "</b>";
    var resText = a.status === "approved" ? "Approved by " + esc(a.decided_by || "you") + " · " + esc(hm(a.decided_at))
      : a.status === "denied" ? "Denied by " + esc(a.decided_by || "you") + " · " + esc(hm(a.decided_at)) + " — nothing ran"
      : a.status === "expired" ? "Nobody answered in time — denied by default at " + esc(hm(a.decided_at))
      : a.status === "cancelled" ? "Withdrawn — answered elsewhere or the turn was interrupted" : "";
    return '<div class="cc-approval' + (res ? " resolved " + res : "") + '" data-ap="' + a.id + '">' +
      '<div class="cc-ap-h">' + ic("shield") + "<span>" + head + '</span><span class="risk">destructive</span>' +
      (a.status === "pending" ? '<span class="timer" data-timer title="Nobody answering means denied">—</span><span class="cc-ap-bar" data-bar></span>' : "") + "</div>" +
      '<div class="cc-ap-body"><p>' + (a.status === "pending" ? "MONI AI wants to " + what + ". Nothing runs until you choose." : "MONI AI asked to " + what + ".") + "</p>" +
      '<div class="cc-ap-cmd' + (cmd.shell ? " shell" : "") + '">' + esc(clip(cmd.text, 2000)) + "</div>" +
      '<dl class="cc-ap-dl"><dt>target</dt><dd>' + esc(approvalTarget(a)) + "</dd>" +
      "<dt>effect</dt><dd>" + esc(a.category ? a.category.replace(/_/g, " ") + (a.label && a.label !== a.category ? " — " + a.label : "") : a.label || "a step the gate treats as destructive") + "</dd>" +
      (a.reason ? "<dt>reason</dt><dd>" + esc(clip(a.reason, 400)) + "</dd>" : "") + "</dl>" +
      '<div class="cc-ap-act"><button type="button" class="cc-btn danger" data-approve="' + a.id + '">' + ic("check") + 'Approve &amp; run</button><button type="button" class="cc-btn" data-deny="' + a.id + '">' + ic("close") + "Deny</button></div>" +
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
    });
  }
  function paintTurn(tr) {
    var el = turnEl(tr);
    var txt = aiText(tr);
    var dels = turnDelegations(tr.id), aps = turnApprovals(tr.id);
    var h = inboundHTML(tr);
    var body = "";
    if (txt) body += "<div>" + md(txt) + "</div>";
    else if (tr.status === "running") body += '<span class="cc-typing" aria-label="MONI AI is working"><i></i><i></i><i></i></span>';
    else if (tr.status === "queued") body += '<span class="cc-muted">Queued — MONI AI will take this next.</span>';
    if (tr.status === "interrupted") body += '<p class="cc-muted">Interrupted.</p>';
    if (tr.status === "error" && tr.error) body += '<p class="cc-muted">Stopped with an error: ' + esc(clip(tr.error, 300)) + "</p>";
    body += dels.map(delegCardHTML).join("");
    body += aps.map(approvalHTML).join("");
    if (body) {
      h += '<div class="cc-msg ai' + (aps.length ? " wide" : "") + '"><div class="who"><span class="cc-av"></span><b>MONI AI</b> · ' + esc(hm(tr.ended_at || tr.started_at || tr.created_at)) +
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
      return '<div class="cc-msg ai wide"><div class="who"><span class="cc-av"></span><b>MONI AI</b> · ' + esc(hm(a.created_at)) + '</div><div class="cc-bubble">' + approvalHTML(a) + "</div></div>";
    }).join("");
  }

  function renderChatEmpty() {
    if (!S.turnOrder.length && !chat.querySelector(".cc-chat-empty")) {
      chat.innerHTML = '<div class="cc-chat-empty">No conversation yet. Tell MONI AI what to do — it finds the session that owns the work and hands it over.</div>';
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
    renderApprovalCount();
    renderTimeline();
    if (!replay && a.status === "pending" && (!cur || cur.status !== "pending")) {
      showPane("conv");
      feedPush({ key: "ap" + a.id + "p", ts: a.created_at, kind: "approval", html: "<b>Approval needed</b> · " + esc(clip(a.summary, 140)) });
      if (Voice.on) Voice.say("I need your approval before I go on.");
    }
    if (!replay && a.status !== "pending" && cur && cur.status === "pending") {
      feedPush({ key: "ap" + a.id + a.status, ts: a.decided_at, kind: a.status === "approved" ? "approved" : a.status, html: "<b>" + esc(a.status === "approved" ? "Approved" : a.status === "denied" ? "Denied" : a.status === "expired" ? "Expired" : "Withdrawn") + "</b>" + (a.decided_by && a.decided_by !== "timeout" ? " by " + esc(a.decided_by) : "") + " · " + esc(clip(a.summary, 120)) });
    }
    paintState();
    renderRail();
  }
  function renderApprovalCount() {
    var n = pendingApprovals().length;
    $("cc-ap-count").hidden = !n;
    $("cc-ap-count").textContent = n;
  }

  chat.addEventListener("click", function (e) {
    var a = e.target.closest("[data-approve]"), d = e.target.closest("[data-deny]");
    var btn = a || d;
    if (!btn) return;
    var id = Number(btn.getAttribute(a ? "data-approve" : "data-deny"));
    var card = btn.closest("[data-ap]");
    var buttons = card.querySelectorAll(".cc-ap-act button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    var err = card.querySelector("[data-err]");
    api("approvals/" + id + "/" + (a ? "approve" : "deny"), { body: {} }).then(function (r) {
      if (r && r.approval) upsertApproval(r.approval, false);
    }).catch(function (ex) {
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
      if (err) { err.hidden = false; err.textContent = "Not recorded: " + ex.message; }
    });
  });

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
      if (!rows.length) { $("cc-timeline").innerHTML = '<li class="empty">No delegations yet. They appear here as MONI AI hands work to other sessions.</li>'; return; }
      $("cc-timeline").innerHTML = rows.map(function (x) {
        var r = x.r;
        if (x.kind === "d") {
          var bits = [];
          if (r.status === "done" && r.done_at) bits.push(dur(Date.parse(r.done_at) - Date.parse(r.created_at)));
          if (r.note) bits.push(r.note);
          else if (r.status === "ack" && r.replied_at) bits.push("replied " + hms(r.replied_at));
          return '<li><span class="cc-tl-node ' + esc(r.status) + '"></span><span class="cc-tl-time">' + esc(hm(r.created_at)) + '</span><div class="cc-tl-cmd"><div class="t">' + esc(r.summary || firstLine(r.text)) + "</div><small>→ <b>" + esc(r.target_name) + "</b>" + (bits.length ? " · " + esc(clip(bits.join(" · "), 90)) : "") + '</small></div><span class="cc-badge b-' + esc(r.status) + '">' + esc(TL_LAB[r.status] || r.status) + "</span></li>";
        }
        var who = r.decided_by && r.decided_by !== "timeout" ? (r.status === "approved" ? "approved" : "decided") + " by " + r.decided_by : r.status === "expired" ? "nobody answered" : "";
        return '<li><span class="cc-tl-node ' + esc(r.status) + '"></span><span class="cc-tl-time">' + esc(hm(r.created_at)) + '</span><div class="cc-tl-cmd"><div class="t">' + esc(clip(approvalCmd(r).text, 160)) + "</div><small>→ <b>" + esc(r.tool === "SendMessage" ? approvalTarget(r).replace(" · peer message", "") : "MONI AI") + "</b> · approval" + (r.category ? " · " + esc(r.category.replace(/_/g, " ")) : "") + (who ? " · " + esc(who) : "") + '</small></div><span class="cc-badge b-' + esc(r.status) + '">' + esc(TL_LAB[r.status] || r.status) + "</span></li>";
      }).join("");
    });
  }

  function upsertDelegation(d, replay) {
    if (!d || !d.id) return;
    var cur = S.delegations.get(d.id);
    if (cur && d.updated_at && cur.updated_at && d.updated_at < cur.updated_at) return;
    S.delegations.set(d.id, d);
    if (!replay && !cur && d.status === "sent") {
      var s = sessionFor(d);
      S.delegatingUntil = Date.now() + 2600;
      if (s && Orb.pulse(sessKey(s))) highlightSess(sessKey(s));
      paintState();
      feedPush({ key: "d" + d.id + "sent", ts: d.created_at, kind: "live", html: "Delegated to <b>" + esc(d.target_name) + "</b> · " + esc(clip(d.summary || firstLine(d.text), 120)) });
    }
    if (!replay && cur && cur.status !== d.status && (d.status === "failed" || d.status === "held")) {
      feedPush({ key: "d" + d.id + d.status, ts: d.updated_at, kind: d.status === "failed" ? "failed" : "held", html: "<b>" + esc(d.target_name) + "</b> · delegation " + esc(d.status) + (d.note ? " — " + esc(clip(d.note, 120)) : "") });
    }
    var tr = S.turns.get(d.turn_id);
    if (tr) renderTurn(tr);
    renderTimeline();
    renderStats();
  }

  /* ---------------------------------------------------------- live feed */

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
        return "<li" + (f.isNew ? ' class="new"' : "") + '><span class="cc-badge b-' + esc(f.kind) + '">' + esc(f.label || f.kind) + "</span><p>" + f.html + "</p><time>" + esc(hm(f.ts)) + "</time></li>";
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
  }

  /* ---------------------------------------------------------- stats */

  function renderStats() {
    var c = (S.status && S.status.counts) || {};
    $("cc-stat-deleg").textContent = c.delegations_24h == null ? "—" : c.delegations_24h;
    var since = Date.now() - 24 * 3600 * 1000, done = 0;
    S.delegations.forEach(function (d) { if (d.status === "done" && Date.parse(d.created_at) >= since) done++; });
    $("cc-stat-done").textContent = done;
    var ds = [];
    S.turns.forEach(function (tr) { if (tr.duration_ms && (tr.source === "dashboard" || tr.source === "remote")) ds.push(tr.duration_ms); });
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
    $("cc-rc-text").textContent = !S.online ? "Remote Control state unknown while MONI AI is unreachable." : on
      ? "Mirrors the MONI AI session — the same conversation in Claude Desktop (Remote Control) and here."
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
    renderApprovalCount();
    renderTimeline();
    renderFeed();
    paintState();
    var off = $("cc-offline");
    off.hidden = S.online;
    $("cc-offline-msg").textContent = S.offlineMsg || "";
  }

  /* ================================================================ loading */

  function setStatus(st) {
    S.status = st;
    if (st && st.approvals) st.approvals.forEach(function (a) { S.approvals.set(a.id, a); });
  }

  function load() {
    return api("overview").then(function (ov) {
      S.online = true;
      S.offlineMsg = "";
      setStatus(ov.status);
      S.sessions = (ov.sessions && ov.sessions.sessions) || [];
      S.memory = ov.memory;
      S.agents = ov.agents;
      S.loadSeq = ov.status.seq || 0;
      (ov.timeline || []).forEach(function (d) { S.delegations.set(d.id, d); });
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
      connect(0);
    }).catch(function (e) {
      S.online = false;
      S.offlineMsg = e.status === 403 ? "Your role does not include MONI AI." : e.message;
      renderAll();
      renderChatEmpty();
      setTimeout(load, 5000);
    });
  }

  /* ================================================================ events */

  var es = null, reconnectTimer = 0;
  var EVENTS = ["proc", "init", "rc", "status", "turn", "text", "assistant", "tool", "tool_result", "steps", "result", "approval", "delegation", "inbound", "sessions", "vitals", "notice", "offline"];

  function connect(since) {
    if (es) es.close();
    es = new EventSource("/moni-ai/api/events" + (since ? "?since=" + since : ""));
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
      S.offlineMsg = ev.error || "MONI AI's supervisor is not running";
      renderAll();
      return;
    }
    if (!S.online) { S.online = true; renderAll(); }
    var st = S.status || (S.status = {});
    switch (type) {
      case "vitals":
        st.vitals = ev.vitals;
        renderVitals();
        return;
      case "sessions": {
        var before = S.sessions;
        S.sessions = ev.sessions || [];
        st.sessions_at = ev.ts;
        if (!replay) diffSessions(before, S.sessions, ev.ts);
        renderSessions();
        renderRail();
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
          if (tr) { tr.partial = ""; if (!replay && voiceTurns.has(row.id)) { Voice.flush(row.id, aiText(tr)); voiceTurns.delete(row.id); } }
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
          html: "<b>MONI AI process</b> · " + esc(ev.state || "") + (ev.error ? " — " + esc(clip(ev.error, 120)) : "") + (ev.retry_in_s ? " · retry in " + ev.retry_in_s + "s" : "") }, replay);
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
        // The bridge reports several states on the way up; the feed wants the
        // ones a person would care about, once each.
        var rcSay = ev.state === "connected" ? "connected" : typeof ev.enabled === "boolean" && !ev.enabled ? "off" : ev.state === "disconnected" || ev.state === "error" ? ev.state : null;
        if (rcSay && rcSay !== S.rcLast) {
          S.rcLast = rcSay;
          feedPush({ key: "rc" + ev.seq, ts: ev.ts, kind: rcSay === "connected" ? "info" : "warn", label: "remote", html: "<b>Remote Control</b> · " + esc(rcSay) }, replay);
        }
        return;
      case "status":
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
  // (counts, queued turns); a slow poll keeps it honest.
  setInterval(function () { if (!document.hidden && S.online) refreshCounts(); }, 30000);
  setInterval(function () { if (!document.hidden) renderSessions(true); }, 30000);

  /* ================================================================ voice
     Record, notice the end of an utterance from the level, have the server
     transcribe it with OpenAI, send; read the reply back sentence by sentence
     as it streams (each sentence spoken by OpenAI's realtime voice on the
     server and returned as a WAV, the next one fetched while this one plays);
     and stop talking the moment you talk over it. The browser only ever talks
     to this panel. Without a key the controls stay off and say so. */

  var Voice = (function () {
    var bigBtn = $("cc-mic-big"), cMic = $("cc-c-mic"), dock = $("cc-dock"), vbText = $("cc-vb-text"), wave = $("cc-vb-wave");
    var speakBtn = $("cc-speak-toggle");
    var api_ = {
      on: false, listening: false, speaking: false, speakAll: false,
      say: function () {}, feed: function () {}, flush: function () {}, unlock: function () {},
    };
    var AC = window.AudioContext || window.webkitAudioContext;
    var canRecord = !!(navigator.mediaDevices && window.MediaRecorder && AC);
    var supported = canRecord && READY;
    if (!READY) {
      // The server rendered the "Add an OpenAI key in Settings" state; keep it.
      bigBtn.disabled = true; cMic.disabled = true;
    } else if (!canRecord) {
      bigBtn.disabled = true; cMic.disabled = true;
      $("cc-mic-label").textContent = "Voice unavailable";
      $("cc-mic-sub").textContent = "This browser cannot record audio here.";
    }

    var stream = null, ac = null, analyser = null, rec = null, chunks = [], poll = 0;
    var heard = false, quietFor = 0, floor = 0.006, calibrating = 0, lastRms = 0;
    var ptt = false;
    var SAMPLE_MS = 50, END_MS = 700, RESET_MS = 8000, MIN_MS = 300, BARGE_MS = 330, AHEAD = 3;
    var spoken = 0, queue = [], busy = false, loudFor = 0, gen = 0;

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
    function sentences(text, from) {
      var rest = text.slice(from), out = [], at = 0, re = /[^.!?\n]*[.!?\n]+/g, m;
      while ((m = re.exec(rest))) { var piece = m[0].trim(); at = re.lastIndex; if (piece) out.push(piece); }
      return { list: out, consumed: from + at };
    }
    function level() {
      if (!analyser) return 0;
      var buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
      return Math.sqrt(sum / buf.length);
    }
    Orb.micSource(function () { return api_.listening && !api_.speaking ? lastRms : 0; });

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
      var live = api_.on || ptt;
      dock.classList.toggle("voice-on", live);
      bigBtn.classList.toggle("live", live);
      bigBtn.setAttribute("aria-pressed", live ? "true" : "false");
      if (canRecord) {
        $("cc-mic-label").textContent = api_.speaking ? "Speaking…" : ptt ? "Listening — release to send" : api_.on ? (api_.listening ? "Listening…" : "Working…") : "Tap to talk";
        $("cc-mic-sub").innerHTML = api_.on ? "tap again to stop · talk over a reply to cut in" : "or hold <kbd>Space</kbd> to talk";
      }
      paintState();
      renderRail();
    }

    /* ---- speaking: fetch ahead, play in order, drop everything on barge-in ---- */
    function fetchClip(text) {
      var ctrl = window.AbortController ? new AbortController() : null;
      var clip = fetch("/moni-ai/api/speak", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF, Accept: "audio/wav, application/json" },
        body: JSON.stringify({ text: text }),
        signal: ctrl ? ctrl.signal : undefined,
      }).then(function (r) {
        // 204: the voice would not read this sentence as written, so it is
        // skipped -- the words are on the screen, and invented speech is worse.
        if (r.status === 204) return null;
        if (r.ok) return r.arrayBuffer();
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (j.code === "no-key") toast("Voice needs an OpenAI key. Add one in Settings.", true);
          return null;
        });
      }).catch(function () { return null; });
      return { clip: clip, ctrl: ctrl };
    }
    function prefetch() {
      for (var i = 0; i < queue.length && i < AHEAD; i++) {
        if (!queue[i].clip) { var f = fetchClip(queue[i].text); queue[i].clip = f.clip; queue[i].ctrl = f.ctrl; }
      }
    }
    function enqueue(piece) {
      if (!READY) return;
      var say = speakable(piece);
      if (say.length < 2 || !/[a-z0-9]/i.test(say)) return;
      queue.push({ text: say.slice(0, 780) });
      prefetch();
      pump();
    }
    function play(ab, my) {
      var c = outContext();
      if (!c) return Promise.resolve();
      return new Promise(function (resolve) {
        c.decodeAudioData(ab, function (buf) {
          if (my !== gen) return resolve();
          source = c.createBufferSource();
          source.buffer = buf;
          source.connect(outAn);
          source.onended = function () { source = null; resolve(); };
          source.start();
        }, function () { resolve(); });
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
      item.clip.then(function (ab) {
        if (my !== gen || !ab) return;
        return play(ab, my);
      }).then(function () {
        if (my !== gen) return;
        busy = false;
        if (queue.length) return pump();
        api_.speaking = false;
        loudFor = 0;
        if (api_.on && !(S.status && S.status.busy)) listen(true);
        setUi();
      });
    }
    /** Stop speaking now: the clip playing, the ones fetched, the ones asked for. */
    function silence() {
      gen++;
      queue.forEach(function (q) { if (q.ctrl) { try { q.ctrl.abort(); } catch (e) { /* done */ } } });
      queue = [];
      if (source) { try { source.onended = null; source.stop(); } catch (e) { /* ended */ } source = null; }
      busy = false;
      api_.speaking = false;
      loudFor = 0;
    }

    function bargeIn() {
      if (!api_.speaking) return;
      silence();
      recording(true);
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
      if (ptt) return;
      if (api_.speaking) {
        loudFor = rms > floor * 6 + 0.01 ? loudFor + SAMPLE_MS : 0;
        if (loudFor >= BARGE_MS) bargeIn();
        return;
      }
      if (rms > floor * 3 + 0.004) { heard = true; quietFor = 0; vbText.textContent = "Listening…"; }
      else {
        quietFor += SAMPLE_MS;
        if (heard && quietFor >= END_MS) { if (rec && rec.state !== "inactive") rec.stop(); return; }
        if (!heard && quietFor >= RESET_MS) { quietFor = 0; heard = false; if (rec && rec.state !== "inactive") rec.stop(); }
      }
    }

    function newRecorder() {
      chunks = []; heard = false; quietFor = 0;
      var started = Date.now();
      var r = rec = recorderFor(stream);
      r.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      r.onstop = function () {
        var enough = Date.now() - started > MIN_MS && chunks.length;
        var type = String(r.mimeType || "audio/webm").split(";")[0];
        var blob = enough ? new Blob(chunks, { type: type }) : null;
        if (blob && (heard || ptt)) transcribeAndSend(blob);
        else if (api_.on) newRecorder();
      };
      r.start();
      api_.listening = true;
      setUi();
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

    function transcribeAndSend(blob) {
      var wasPtt = ptt;
      ptt = false;
      listen(false);
      vbText.textContent = "Transcribing…";
      setUi();
      var reader = new FileReader();
      reader.onload = function () {
        api("transcribe", { body: { data: String(reader.result).split(",")[1] || "", mime: blob.type } }).then(function (d) {
          var said = String(d.text || "").trim();
          if (!said || /^[\[(]/.test(said)) throw new Error("nothing said");
          vbText.textContent = "“" + clip(said, 80) + "”";
          return send(said, { voice: true });
        }).catch(function (e) {
          if (e.message !== "nothing said") toast("Could not transcribe that: " + e.message, true);
          if (api_.on) listen(true);
        }).then(function () {
          if (!api_.on && wasPtt) closeStream();
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
    function closeStream() {
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
    function warm() { if (!warmed && READY) { warmed = true; fetchClip("On it."); } }

    function start() {
      if (!supported) return;
      outContext();
      warm();
      openStream().then(function () {
        api_.on = true;
        listen(true);
      }).catch(function () { toast("Talking to MONI needs the microphone, and it was refused.", true); });
    }
    function stop() {
      api_.on = false;
      silence();
      closeStream();
      setUi();
    }

    bigBtn.addEventListener("click", function () { api_.on ? stop() : start(); });
    cMic.addEventListener("click", start);
    $("cc-vb-stop").addEventListener("click", function () {
      // Stop and send what has been said so far, if anything.
      if (rec && rec.state === "recording" && heard) { api_.on = false; rec.stop(); setTimeout(stop, 50); }
      else stop();
    });
    $("cc-vb-close").addEventListener("click", stop);

    /* Hold Space to talk, anywhere but a text field or a control. */
    function typing(el) { return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || el.tagName === "BUTTON" || el.getAttribute("role") === "radio"); }
    document.addEventListener("keydown", function (e) {
      if (e.code !== "Space" || e.repeat || !supported || api_.on || ptt || typing(document.activeElement)) return;
      e.preventDefault();
      ptt = true;
      outContext();
      warm();
      if (api_.speaking) bargeIn();
      openStream().then(function () {
        if (!ptt) return closeStream();
        calibrating = 0;
        recording(true);
        if (!poll) poll = setInterval(tick, SAMPLE_MS);
        vbText.textContent = "Listening — release Space to send";
        setUi();
      }).catch(function () { ptt = false; setUi(); toast("Talking to MONI needs the microphone, and it was refused.", true); });
    });
    document.addEventListener("keyup", function (e) {
      if (e.code !== "Space" || !ptt) return;
      e.preventDefault();
      if (rec && rec.state === "recording") rec.stop();
      else { ptt = false; closeStream(); setUi(); }
    });

    speakBtn.hidden = !READY;
    speakBtn.addEventListener("click", function () {
      api_.speakAll = !api_.speakAll;
      if (api_.speakAll) outContext();
      speakBtn.setAttribute("aria-pressed", api_.speakAll ? "true" : "false");
      speakBtn.innerHTML = ic(api_.speakAll ? "speaker" : "mute") + "<span>" + (api_.speakAll ? "replies aloud" : "replies silent") + "</span>";
      if (!api_.speakAll && !api_.on) { silence(); setUi(); }
    });

    api_.unlock = function () { if (READY) outContext(); };
    api_.say = function (text) { if (READY) enqueue(text); };
    var spokenTurn = null;
    api_.feed = function (id, text) {
      if (id !== spokenTurn) { spokenTurn = id; spoken = 0; }
      var found = sentences(text, spoken);
      spoken = found.consumed;
      found.list.forEach(enqueue);
    };
    api_.flush = function (id, text) {
      if (id !== spokenTurn) { spokenTurn = id; spoken = 0; }
      var rest = String(text || "").slice(spoken).trim();
      spoken = 0;
      spokenTurn = null;
      if (rest) enqueue(rest);
      if (api_.on && !busy && !queue.length) listen(true);
    };
    return api_;
  })();

  /* ================================================================ keys */

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeMenu(); closePop(); }
  });

  /* ================================================================ start */

  Orb.palette();
  tick();
  setInterval(tick, 1000);
  Orb.resize();
  Orb.start();
  renderAll();
  load();
})();
