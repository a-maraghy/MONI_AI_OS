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
 *   (machine core      the OS overview's mycelium lives in mycelium.js)
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
