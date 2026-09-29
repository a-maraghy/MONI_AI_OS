"use strict";
/*
 * The Command Center's stage: the MINT AI core in the middle (mint-core.js)
 * and the live sessions as small points on a faint orbit round it.
 *
 * The core's concept (A dotted sphere, B Siri fluid, C hybrid) is the viewer's
 * saved choice, rendered by the server as data-core on #cc before first paint
 * and switchable at any time without a reload (setConcept). Its state comes
 * from real events through moni-ai.js: thinking while a turn runs, delegating
 * when a SendMessage lands (a stream of dots flies to that session's point),
 * listening with the real microphone level, speaking with the real output
 * level of the voice, needs-you while something waits for a decision.
 *
 * Session points: working ones breathe, waiting ones are amber, idle ones
 * grey; hovering shows the name, a click opens the Sessions sheet. A reply
 * from a session flashes its point. Positions are set through element.style
 * (CSSOM), never a style attribute: the CSP refuses those.
 *
 * Exposes one factory, window.MoniMap(els, opts), used by moni-ai.js. The name
 * is the v3 map's, kept so the page's calls (setNodes, send, reply, setState,
 * micSource, outSource, palette, resize, start) read the same.
 */
(function () {
  window.MoniMap = function (els, opts) {
    opts = opts || {};
    var root = els.root, stage = els.stage, orbit = els.orbit, ring = els.ring, halo = els.halo, spark = els.spark;
    var reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var L = { cx: 0, cy: 0, R: 200, rx: 300, ry: 80 };
    var nodes = [];          // {id, label, st, subs, el}
    var pos = {};            // id -> [x, y] in CSS pixels
    var target = null, lastTarget = null, targetTimer = 0;
    var micLevel = null, outLevel = null;
    var state = "idle";

    var core = window.MintCore(els.canvas, {
      concept: root.getAttribute("data-core"),
      points: window.innerWidth <= 720 ? 2600 : 4200,
      dest: function () {
        var id = target || lastTarget;
        if (id && pos[id]) return pos[id];
        var first = nodes[0] && pos[nodes[0].id];
        return first || [L.cx + L.rx * 0.8, L.cy - L.ry * 1.6];
      },
      amp: function (st) {
        if (st === "listening" && micLevel) return Math.min(1, micLevel() * 7);
        if (st === "speaking" && outLevel) {
          var v = outLevel();
          return v < 0 ? null : Math.min(1, v * 4.5);
        }
        return null;
      },
      onFrame: onFrame,
    });
    root.classList.toggle("core-2d", !core.isGL);

    function isLight() {
      var t = document.documentElement.getAttribute("data-theme");
      if (t) return t === "light";
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    }
    function palette() { core.setLight(isLight()); }
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: light)");
      if (mq.addEventListener) mq.addEventListener("change", palette);
    }

    /* ---------------------------------------------------------- layout */
    function resize() {
      var r = stage.getBoundingClientRect();
      var phone = window.innerWidth <= 720;
      if (!r.width || !r.height) return;
      L.cx = r.left + r.width / 2;
      L.cy = r.top + r.height / 2 + (phone ? 4 : 14);
      L.R = Math.max(80, Math.min(r.width * (phone ? 0.34 : 0.36), r.height * 0.36, 275));
      L.rx = Math.min(L.R * 1.62, window.innerWidth / 2 - 20);
      L.ry = L.R * 0.34;
      core.resize(L.cx, L.cy, L.R, window.innerWidth, window.innerHeight);
      halo.style.left = L.cx + "px";
      halo.style.top = L.cy + "px";
      halo.style.width = halo.style.height = L.R * 4.2 + "px";
      spark.style.left = L.cx + "px";
      spark.style.top = L.cy + "px";
      var e = ring.firstElementChild;
      ring.setAttribute("width", String(window.innerWidth));
      ring.setAttribute("height", String(window.innerHeight));
      e.setAttribute("cx", L.cx.toFixed(1));
      e.setAttribute("cy", L.cy.toFixed(1));
      e.setAttribute("rx", L.rx.toFixed(1));
      e.setAttribute("ry", L.ry.toFixed(1));
      place(core.S.t);
    }
    window.addEventListener("resize", resize);

    /* ---------------------------------------------------------- the orbit */
    function place(t) {
      var n = nodes.length;
      for (var i = 0; i < n; i++) {
        var nd = nodes[i];
        var a = -0.9 + (i * Math.PI * 2) / n + (reduced ? 0 : t * 0.045);
        var x = L.cx + L.rx * Math.cos(a), y = L.cy + L.ry * Math.sin(a);
        var front = Math.sin(a) * 0.5 + 0.5;
        pos[nd.id] = [x, y];
        nd.el.style.transform = "translate(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px) scale(" + (0.8 + 0.3 * front).toFixed(3) + ")";
        nd.el.style.opacity = (0.45 + 0.55 * front).toFixed(2);
        nd.el.style.zIndex = front > 0.5 ? "4" : "2";
      }
    }
    function stLabel(st) { return st === "working" ? "working" : st === "waiting" ? "waiting on you" : st === "offline" ? "offline" : "idle"; }
    function setNodes(list) {
      var old = {};
      nodes.forEach(function (n) { old[n.id] = n; });
      var next = (list || []).map(function (s) {
        var n = old[s.id];
        if (!n) {
          var el = document.createElement("button");
          el.type = "button";
          el.className = "cc-sess";
          el.setAttribute("data-node", s.id);
          el.innerHTML = '<i></i><span class="nm"></span>';
          orbit.appendChild(el);
          n = { id: s.id, el: el };
        }
        delete old[s.id];
        n.label = s.label; n.st = s.st; n.subs = s.subs || []; n.mission = !!s.mission;
        var cls = s.st === "working" ? "work" : s.st === "waiting" ? "wait" : "idle";
        n.el.className = "cc-sess " + cls + (n.mission ? " mis" : "") + (n.id === target ? " target" : "") + (n.subs.length ? " subs" : "");
        var line = s.label + " · " + stLabel(s.st) + (n.subs.length ? " · " + n.subs.length + " sub-agent" + (n.subs.length === 1 ? "" : "s") : "");
        n.el.querySelector(".nm").textContent = line;
        n.el.setAttribute("aria-label", line + ". Open the sessions sheet.");
        n.el.setAttribute("data-subs", String(Math.min(n.subs.length, 9)));
        return n;
      });
      Object.keys(old).forEach(function (k) { old[k].el.remove(); delete pos[k]; });
      nodes = next;
      place(core.S.t);
    }
    orbit.addEventListener("click", function (e) {
      var b = e.target.closest("[data-node]");
      if (b && opts.onClick) opts.onClick(b.getAttribute("data-node"));
    });

    /* ---------------------------------------------------------- per frame */
    function onFrame(S, W) {
      if (!reduced) place(S.t);
      if (core.S.concept === "C") {
        var talk = W.wave + W.line;
        var k = (1 + 0.35 * S.amp * talk + 0.08 * Math.sin(S.t * 1.1)) * (1 - 0.45 * talk);
        var rot = ((W.gal + W.think) * S.t * 40) % 360;
        spark.style.transform = "translate(-50%, -50%) rotate(" + rot.toFixed(1) + "deg) scale(" + Math.max(0.2, k).toFixed(3) + ")";
      }
      if (opts.onFrame) opts.onFrame(S, W);
      if (sampler) { var f = sampler; sampler = null; f(core.canvas); }
    }
    var sampler = null;

    function node(id) { for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i]; return null; }
    function flash(id, cls, ms) {
      var n = node(id);
      if (!n) return false;
      n.el.classList.add(cls);
      setTimeout(function () { n.el.classList.remove(cls); }, ms);
      return true;
    }

    return {
      core: core,
      layout: L,
      palette: palette,
      resize: resize,
      start: function () { palette(); resize(); core.start(); },
      setNodes: setNodes,
      /** The core's state: idle, listening, thinking, delegating, speaking or needs. */
      setState: function (name) {
        if (name === state) return;
        state = name;
        core.setState(name);
        root.setAttribute("data-state", name);
      },
      setConcept: function (c) {
        core.setConcept(c);
        root.setAttribute("data-core", core.S.concept);
      },
      /** A delegation went out to this session: the stream of dots flies there. */
      send: function (id, ms) {
        var n = node(id);
        clearTimeout(targetTimer);
        nodes.forEach(function (x) { x.el.classList.toggle("target", x.id === id); });
        target = lastTarget = n ? id : null;
        targetTimer = setTimeout(function () {
          target = null;
          nodes.forEach(function (x) { x.el.classList.remove("target"); });
        }, ms || 2600);
        return !!n;
      },
      /** A session answered: its point flashes. */
      reply: function (id) { return flash(id, "reply", 1400); },
      /** Mark the session the composer is addressed to. */
      mark: function (id) { nodes.forEach(function (x) { x.el.classList.toggle("addressed", x.id === id); }); },
      micSource: function (fn) { micLevel = fn; },
      outSource: function (fn) { outLevel = fn; },
      positions: function () { return pos; },
      stats: function () { return core.stats(); },
      /** Hand the canvas to fn right after the next frame is drawn (for checks: the pixels are still there). */
      sample: function (fn) { sampler = fn; if (!core.S.running) { core.draw(); } },
    };
  };
})();
