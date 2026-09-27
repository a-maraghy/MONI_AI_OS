"use strict";
/*
 * The frame, and the OS / Agents pages that move.
 *
 * Everything here is progressive: each block looks for its own markup and does
 * nothing if the page has none, and every page is complete without it. No
 * inline handlers (the CSP forbids them) -- listeners are attached from here.
 *
 *   sidebar collapse   remembered per browser under "moni-side"
 *   clock              the browser's own time and zone, in the top bar
 *   machine core       the OS overview's canvas: growth rings and roots
 *   vitals             CPU / RAM / disk rings, refreshed from /api/stats
 *   contents           the "on this page" list of a document page
 *   journal tail       an agent's last journal lines, refreshed in place
 */

(function () {
  var root = document.documentElement;
  var reduced = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var TAU = Math.PI * 2;
  var GOLDEN = Math.PI * (3 - Math.sqrt(5));

  function store(key, value) {
    try {
      if (value == null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch (e) {
      /* storage blocked: the choice lasts until the page is left */
    }
  }

  /* ------------------------------------------------------ sidebar collapse */
  (function () {
    var btn = document.querySelector("[data-side-collapse]");
    if (!btn) return;
    function sync() {
      var c = root.getAttribute("data-side") === "collapsed";
      btn.setAttribute("aria-expanded", c ? "false" : "true");
      btn.title = c ? "Expand the sidebar" : "Collapse the sidebar to icons";
      var label = btn.querySelector("span");
      if (label) label.textContent = c ? "Expand" : "Collapse to icons";
    }
    btn.addEventListener("click", function () {
      var c = root.getAttribute("data-side") !== "collapsed";
      if (c) root.setAttribute("data-side", "collapsed");
      else root.removeAttribute("data-side");
      store("moni-side", c ? "collapsed" : null);
      sync();
      window.dispatchEvent(new Event("resize"));
    });
    sync();
  })();

  /* ----------------------------------------------------------------- clock */
  // The administrator's zone (data-tz), the same the Command Center keeps.
  (function () {
    var el = document.querySelector("[data-clock]");
    if (!el) return;
    var b = el.querySelector("b");
    var s = el.querySelector("span");
    var zone = el.getAttribute("data-tz") || undefined;
    var city = (zone || "").split("/").pop().replace(/_/g, " ");
    var fHMS, fDate;
    try {
      fHMS = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      fDate = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" });
    } catch (e) {
      fHMS = null;
    }
    function tick() {
      var d = new Date();
      if (fHMS) {
        b.textContent = fHMS.format(d);
        s.textContent = fDate.format(d) + (city ? " · " + city : "");
      } else {
        b.textContent = d.toTimeString().slice(0, 8);
      }
    }
    tick();
    setInterval(tick, 1000);
  })();

  /* ---------------------------------------------------------- contents --- */
  // A document page's "on this page" list: highlights the section in view and
  // scrolls to one smoothly (unless motion is reduced).
  (function () {
    var toc = document.querySelector("[data-toc]");
    if (!toc) return;
    var scroller = document.querySelector(".content.pat-c") || window;
    var links = Array.prototype.slice.call(toc.querySelectorAll("a[href^='#']"));
    function update() {
      var best = null;
      links.forEach(function (a) {
        var sec = document.getElementById(a.getAttribute("href").slice(1));
        if (sec && sec.getBoundingClientRect().top < 200) best = a;
      });
      links.forEach(function (a) { a.classList.toggle("on", a === (best || links[0])); });
    }
    (scroller === window ? window : scroller).addEventListener("scroll", update, { passive: true });
    toc.addEventListener("click", function (e) {
      var a = e.target.closest("a[href^='#']");
      if (!a) return;
      var sec = document.getElementById(a.getAttribute("href").slice(1));
      if (!sec) return;
      e.preventDefault();
      sec.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
      if (history.replaceState) history.replaceState(null, "", a.getAttribute("href"));
    });
    update();
  })();

  /* ---------------------------------------------------------- tokens ----- */
  function palette(names) {
    var cs = getComputedStyle(root);
    var out = {};
    names.forEach(function (n) { out[n] = cs.getPropertyValue(n).trim(); });
    return out;
  }

  /* ---------------------------------------------------- vitals rings ----- */
  function setRing(cell, pct, sub) {
    if (!cell) return;
    var val = cell.querySelector(".val");
    var b = cell.querySelector("b");
    var small = cell.querySelector("small");
    var c = 2 * Math.PI * 24;
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    if (val) {
      val.setAttribute("stroke-dasharray", (c * pct / 100).toFixed(1) + " " + c.toFixed(1));
      val.setAttribute("class", "val" + (pct > 90 ? " bad" : pct > 75 ? " hot" : ""));
    }
    if (b) b.textContent = pct + "%";
    if (small && sub) small.textContent = sub;
  }
  function gb(n) { return n == null ? "—" : (n / Math.pow(1024, 3)).toFixed(n >= 10 * Math.pow(1024, 3) ? 0 : 1); }

  /* ------------------------------------------------------ machine core --- */
  // The VPS as a tree seen in cross-section: one growth ring per day up
  // (capped at 60), a HUD of vitals arcs around the bark, and a root running
  // out to every system service. Sap beads travel the roots of active
  // services; an inactive one gets a dashed, dry root, a failed one a red
  // one. Colours come from the theme tokens and repaint when it changes.
  var core = (function () {
    var hero = document.querySelector("[data-machine-core]");
    if (!hero) return null;
    var cv = hero.querySelector("canvas");
    var ctx = cv.getContext("2d");
    var lbls = hero.querySelector(".node-labels");
    var data = {};
    try {
      data = JSON.parse(hero.getAttribute("data-machine-core") || "{}");
    } catch (e) {
      data = {};
    }
    var NODES = data.nodes || [];
    var rings = Math.max(1, Math.min(60, data.days || 1));
    var vit = data.vitals || [0, 0, 0];
    var W = 0, H = 0, raf = 0, running = false, pal = {}, nodes = [], beads = [], last = 0, T = 0, geo = { cx: 0, cy: 0, R: 1 };

    function repalette() {
      pal = palette(["--orb-floret", "--orb-floret-mid", "--orb-floret-hi", "--orb-core", "--orb-root", "--orb-root-hi", "--orb-sap",
        "--orb-glow", "--orb-hud", "--orb-node-bg", "--orb-wood-a", "--orb-wood-b", "--warn", "--bad", "--line", "--line-strong", "--accent-2"]);
      if (!running) draw(T);
    }
    function layout() {
      var r = hero.getBoundingClientRect();
      W = r.width; H = r.height;
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var compact = W < 820;
      hero.classList.toggle("compact", compact);
      var top = 62, bot = H - 54, cx = W / 2, cy = (top + bot) / 2, ry = Math.max(40, (bot - top) / 2 - 34);
      var rx = W / 2 - (compact ? 84 : 130), R = Math.max(24, Math.min(W * 0.13, ry * 0.62));
      nodes = NODES.map(function (n, i) {
        var a = -Math.PI / 2 - Math.PI / 8 + (i / Math.max(1, NODES.length)) * TAU;
        return { n: n, a: a, x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, seed: i * 1.7 };
      });
      geo = { cx: cx, cy: cy, R: R };
      var els = lbls ? lbls.children : [];
      for (var i = 0; i < els.length; i++) {
        var p = nodes[i];
        if (!p) continue;
        var el = els[i], w = el.offsetWidth, below = p.y > cy;
        el.style.left = Math.max(8, Math.min(W - w - 8, p.x - w / 2)).toFixed(0) + "px";
        el.style.top = (below ? p.y + 12 : p.y - 34).toFixed(0) + "px";
        el.classList.add("placed");
      }
    }
    function rootPath(p) {
      var cx = geo.cx, cy = geo.cy, R = geo.R;
      var sx = cx + Math.cos(p.a) * R * 1.02, sy = cy + Math.sin(p.a) * R * 1.02;
      var mx = (sx + p.x) / 2 + Math.sin(p.seed) * 30, my = (sy + p.y) / 2 + Math.cos(p.seed * 1.3) * 26;
      return [sx, sy, mx, my, p.x, p.y];
    }
    function qpt(q, t) { var u = 1 - t; return [u * u * q[0] + 2 * u * t * q[2] + t * t * q[4], u * u * q[1] + 2 * u * t * q[3] + t * t * q[5]]; }
    function stateColor(s) { return s === "ok" ? pal["--orb-root"] : s === "bad" ? pal["--bad"] : pal["--warn"]; }

    function draw(time) {
      if (!W || !H) return;
      var cx = geo.cx, cy = geo.cy, R = geo.R, k;
      ctx.clearRect(0, 0, W, H);
      ctx.save(); ctx.translate(cx, cy);
      ctx.strokeStyle = pal["--line"]; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, 0, R * 1.62, 0, TAU); ctx.stroke();
      for (k = 0; k < 120; k++) {
        var a = (k / 120) * TAU + time * 0.02, L = k % 10 ? 4 : 10;
        ctx.strokeStyle = k % 10 ? pal["--line"] : pal["--line-strong"];
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * R * 1.62, Math.sin(a) * R * 1.62);
        ctx.lineTo(Math.cos(a) * (R * 1.62 - L), Math.sin(a) * (R * 1.62 - L)); ctx.stroke();
      }
      vit.forEach(function (v, j) {
        var rr = R * (1.22 + j * 0.11);
        ctx.lineWidth = 3; ctx.lineCap = "round";
        ctx.strokeStyle = pal["--line"]; ctx.beginPath(); ctx.arc(0, 0, rr, -Math.PI / 2 - 1.1, -Math.PI / 2 + 1.1); ctx.stroke();
        ctx.strokeStyle = v > 0.9 ? pal["--bad"] : v > 0.75 ? pal["--warn"] : pal["--orb-hud"];
        ctx.globalAlpha = 0.9 - j * 0.18;
        ctx.beginPath(); ctx.arc(0, 0, rr, -Math.PI / 2 - 1.1, -Math.PI / 2 - 1.1 + 2.2 * Math.max(0.005, Math.min(1, v))); ctx.stroke();
        ctx.globalAlpha = 1;
      });
      ctx.restore();
      nodes.forEach(function (p) {
        var q = rootPath(p), ok = p.n.state === "ok";
        ctx.lineCap = "round";
        ctx.strokeStyle = stateColor(p.n.state); ctx.lineWidth = ok ? 2.2 : 1.4; ctx.globalAlpha = ok ? 0.95 : 0.75;
        ctx.setLineDash(ok ? [] : [4, 5]);
        ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.quadraticCurveTo(q[2], q[3], q[4], q[5]); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        ctx.strokeStyle = pal["--orb-root"]; ctx.lineWidth = 0.8; ctx.globalAlpha = 0.45;
        for (var j = 1; j < 4; j++) {
          var pt = qpt(q, j / 4), side = j % 2 ? 1 : -1, ang = p.a + side * 0.9, len = 10 + 6 * Math.sin(p.seed + j);
          ctx.beginPath(); ctx.moveTo(pt[0], pt[1]);
          ctx.quadraticCurveTo(pt[0] + Math.cos(ang) * len * 0.6, pt[1] + Math.sin(ang) * len * 0.6 + 3, pt[0] + Math.cos(ang) * len, pt[1] + Math.sin(ang) * len);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      });
      // trunk cross-section: the bark, then one ring per day of uptime
      var grd = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
      grd.addColorStop(0, pal["--orb-wood-a"] || "transparent"); grd.addColorStop(1, pal["--orb-wood-b"] || "transparent");
      ctx.fillStyle = grd; ctx.beginPath();
      for (k = 0; k <= 96; k++) {
        var aa = (k / 96) * TAU, r0 = R * (1 + 0.035 * Math.sin(aa * 5 + 1.3) + 0.02 * Math.sin(aa * 11));
        ctx.lineTo(cx + Math.cos(aa) * r0, cy + Math.sin(aa) * r0);
      }
      ctx.closePath(); ctx.fill();
      ctx.shadowColor = pal["--orb-glow"]; ctx.shadowBlur = 24; ctx.strokeStyle = pal["--orb-floret"]; ctx.lineWidth = 2; ctx.stroke(); ctx.shadowBlur = 0;
      for (var n = 1; n <= rings; n++) {
        var f = n / rings, breath = 1 + 0.012 * Math.sin(time * 0.8 - n * 0.5);
        ctx.beginPath();
        for (k = 0; k <= 72; k++) {
          var a2 = (k / 72) * TAU;
          var wob = 1 + 0.045 * f * Math.sin(a2 * 3 + n * 0.9) + 0.02 * Math.sin(a2 * 7 + n * 1.7);
          var r1 = R * 0.96 * Math.pow(f, 0.9) * wob * breath;
          ctx.lineTo(cx + Math.cos(a2) * r1, cy + Math.sin(a2) * r1);
        }
        ctx.closePath();
        var latest = n === rings;
        ctx.strokeStyle = latest ? pal["--orb-floret-hi"] : n % 3 ? pal["--orb-floret"] : pal["--orb-floret-mid"];
        ctx.globalAlpha = latest ? 0.9 : 0.28 + 0.45 * f; ctx.lineWidth = latest ? 1.6 : rings > 30 ? 0.7 : 1; ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal["--orb-floret-mid"]; ctx.globalAlpha = 0.18; ctx.lineWidth = 0.8;
      for (k = 0; k < 14; k++) {
        var a3 = (k / 14) * TAU + 0.2;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a3) * R * 0.12, cy + Math.sin(a3) * R * 0.12); ctx.lineTo(cx + Math.cos(a3) * R * 0.9, cy + Math.sin(a3) * R * 0.9); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (k = 0; k < 34; k++) {
        var rr2 = R * 0.018 * Math.sqrt(k) * 3.2, th = k * GOLDEN + time * 0.05;
        ctx.fillStyle = k < 5 ? pal["--orb-core"] : pal["--orb-floret-mid"];
        ctx.beginPath(); ctx.arc(cx + Math.cos(th) * rr2, cy + Math.sin(th) * rr2, 1.6, 0, TAU); ctx.fill();
      }
      beads.forEach(function (b) {
        var p = nodes[b.i]; if (!p) return;
        var pt = qpt(rootPath(p), b.t);
        ctx.fillStyle = pal["--orb-sap"]; ctx.shadowColor = pal["--orb-glow"]; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(pt[0], pt[1], 2.4, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
      });
      nodes.forEach(function (p, i) {
        var ok = p.n.state === "ok", pulse = ok && !reduced.matches ? 1 + 0.12 * Math.sin(time * 2 + i) : 1;
        ctx.fillStyle = pal["--orb-node-bg"]; ctx.strokeStyle = ok ? pal["--orb-root-hi"] : stateColor(p.n.state); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, 8 * pulse, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.fillStyle = ok ? pal["--accent-2"] : stateColor(p.n.state);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.n.fleet ? 4.2 : 3.4, 0, TAU); ctx.fill();
      });
    }
    function frame(now) {
      if (!running) return;
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now; T += dt;
      if (Math.random() < dt * 2.2 && nodes.length) {
        var i = (Math.random() * nodes.length) | 0;
        if (nodes[i] && nodes[i].n.state === "ok") beads.push({ i: i, t: 0, v: 0.35 + Math.random() * 0.3 });
      }
      beads.forEach(function (b) { b.t += b.v * dt; });
      beads = beads.filter(function (b) { return b.t < 1; });
      draw(T);
      raf = requestAnimationFrame(frame);
    }
    function start() {
      layout(); repalette();
      if (reduced.matches) {
        beads = [];
        nodes.forEach(function (p, i) { if (p.n.state === "ok" && i % 2) beads.push({ i: i, t: 0.45, v: 0 }); });
        draw(T);
        return;
      }
      if (running) return;
      running = true; last = 0; raf = requestAnimationFrame(frame);
    }
    function stop() { running = false; cancelAnimationFrame(raf); }
    if (window.ResizeObserver) new ResizeObserver(function () { layout(); draw(T); }).observe(hero);
    document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });
    document.addEventListener("moni-theme", function () { setTimeout(repalette, 0); });
    start();
    return { setVitals: function (v) { vit = v; if (!running) draw(T); } };
  })();

  /* ------------------------------------------------ live vitals (OS) ----- */
  (function () {
    var box = document.querySelector("[data-vitals]");
    if (!box) return;
    function refresh() {
      if (document.hidden) return;
      fetch("/api/stats", { credentials: "same-origin" })
        .then(function (r) { if (!r.ok) throw new Error("stats"); return r.json(); })
        .then(function (d) {
          var s = d.stats;
          var cpu = Math.min(100, (s.loadavg[0] / Math.max(1, s.cpus)) * 100);
          var ram = s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0;
          var disk = s.diskTotal ? (s.diskUsed / s.diskTotal) * 100 : 0;
          setRing(box.querySelector('[data-ring="cpu"]'), cpu);
          setRing(box.querySelector('[data-ring="ram"]'), ram, gb(s.memUsed) + " / " + gb(s.memTotal) + " GB");
          setRing(box.querySelector('[data-ring="disk"]'), disk, gb(s.diskUsed) + " / " + gb(s.diskTotal) + " GB");
          var load = document.querySelector("[data-load]");
          if (load) load.textContent = s.loadavg.map(function (n) { return n.toFixed(2); }).join(" · ");
          if (core) core.setVitals([cpu / 100, ram / 100, disk / 100]);
        })
        .catch(function () { /* keep the last values */ });
    }
    setInterval(refresh, 15000);
  })();

  /* ------------------------------------------------------ vault seed ----- */
  // The agent's memory as a seed head: one floret per note on the golden
  // angle, the newest brightest. Drawn once as SVG from the count the server
  // put on the element.
  (function () {
    var svg = document.querySelector("svg[data-vault]");
    if (!svg) return;
    var n = Math.max(0, Math.min(900, parseInt(svg.getAttribute("data-vault"), 10) || 0));
    var NS = "http://www.w3.org/2000/svg";
    function el(tag, attrs) {
      var e = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      svg.appendChild(e);
      return e;
    }
    el("circle", { r: 156, fill: "none", class: "v-ring" });
    el("circle", { r: 118, fill: "none", class: "v-ring dashed" });
    var s = 7;
    function rnd() { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }
    // Florets fill the ring between the hole and the rim whatever the count:
    // five notes and five hundred both read as a seed head, not a speck.
    var big = n < 40 ? 2.2 : n < 150 ? 1.2 : 0.4;
    for (var k = 1; k <= n; k++) {
      var rr = 50 + 96 * Math.sqrt(k / n), th = k * GOLDEN, age = k / n, sz = 1.6 + big + rnd() * 2.6, fresh = k > n - 8;
      el("circle", {
        cx: (rr * Math.cos(th)).toFixed(1), cy: (rr * Math.sin(th)).toFixed(1), r: sz.toFixed(1),
        class: fresh ? "v-fl hi" : age > 0.6 ? "v-fl mid" : "v-fl",
        opacity: (fresh ? 1 : 0.45 + 0.5 * (1 - age)).toFixed(2),
      });
    }
    for (k = 0; k < 72; k++) {
      var a = (k / 72) * TAU, L = k % 6 ? 4 : 9;
      el("line", { x1: (156 * Math.cos(a)).toFixed(1), y1: (156 * Math.sin(a)).toFixed(1), x2: ((156 - L) * Math.cos(a)).toFixed(1), y2: ((156 - L) * Math.sin(a)).toFixed(1), class: "v-tick" });
    }
    var frac = Math.max(0.04, Math.min(1, n / 400));
    var a0 = -Math.PI / 2, a1 = a0 + frac * TAU * 0.999;
    el("path", {
      d: "M" + (150 * Math.cos(a0)).toFixed(1) + " " + (150 * Math.sin(a0)).toFixed(1) + " A150 150 0 " + (a1 - a0 > Math.PI ? 1 : 0) + " 1 " + (150 * Math.cos(a1)).toFixed(1) + " " + (150 * Math.sin(a1)).toFixed(1),
      class: "v-arc", fill: "none",
    });
    el("circle", { r: 42, class: "v-hole" });
  })();

  /* ---------------------------------------------------- journal tail ----- */
  (function () {
    var box = document.querySelector("[data-journal]");
    if (!box) return;
    var url = box.getAttribute("data-journal");
    var pre = box.querySelector("pre");
    var busy = false;
    function refresh() {
      if (busy || document.hidden) return;
      busy = true;
      fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { if (!r.ok) throw new Error("logs"); return r.json(); })
        .then(function (d) {
          if (typeof d.html !== "string") return;
          var atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
          pre.innerHTML = d.html; // rendered and escaped by the server's own view code
          if (atEnd) box.scrollTop = box.scrollHeight;
        })
        .catch(function () { /* keep what is on screen */ })
        .then(function () { busy = false; });
    }
    box.scrollTop = box.scrollHeight;
    setInterval(refresh, 10000);
    var btn = document.querySelector("[data-journal-refresh]");
    if (btn) btn.addEventListener("click", function (e) { e.preventDefault(); refresh(); });
  })();

  /* ------------------------------------------------ logs start at the end */
  Array.prototype.forEach.call(document.querySelectorAll("[data-scroll-end]"), function (el) {
    el.scrollTop = el.scrollHeight;
  });
})();
