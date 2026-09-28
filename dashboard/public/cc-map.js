"use strict";
/*
 * The Command Center's orbit map: one canvas, one requestAnimationFrame loop.
 *
 * MONI AI's seed core sits in the middle (golden-angle florets and HUD rings,
 * smaller than v2's hero). The live sessions sit on the inner ring, each with a
 * root back to the core; their running sub-agents circle them as moons. A
 * delegation sends a sap bead OUT along the root and the session blooms when
 * it lands; a reply comes BACK as a blue bead and the core flashes. Sessions
 * working on a step of an active mission are tinted. The outer ring is drawn
 * for the sessions MONI AI will hire later, and is empty for now.
 *
 * The core keeps the work states the page already had -- idle, listening,
 * thinking, delegating, speaking -- blended through weights, with the real
 * microphone and speaker levels when voice is on.
 *
 * DPR-aware; paused while the tab is hidden or the Missions view is showing;
 * a single still frame (redrawn only when something changes) for anyone who
 * asked for reduced motion. Colours come from the --orb-* CSS tokens, so both
 * themes work and a theme change is one palette() call. No per-frame
 * allocation beyond the packet list: typed arrays, cached sprites and label
 * widths.
 *
 * Exposes one factory, window.MoniMap(canvas, opts), used by moni-ai.js.
 */
(function () {
  window.MoniMap = function (canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext("2d");
    var reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var W = 0, H = 0, DPR = 1, CX = 0, CY = 0, R = 40, RX1 = 200, RY1 = 120, RX2 = 360, RY2 = 200;
    var TAU = Math.PI * 2, GOLDEN = Math.PI * (3 - Math.sqrt(5));
    var N = 300, FX = new Float32Array(N), FY = new Float32Array(N), FS = new Float32Array(N), FBK = new Uint8Array(N);
    var STATES = ["idle", "listening", "thinking", "delegating", "speaking"];
    var SI = 0, WGT = new Float32Array([1, 0, 0, 0, 0]);
    var PAL = {}, SPR_GLOW = null, SPR_SAP = null, SPR_REPLY = null;
    var nodes = [];        // {id, label, st, subs, mission, ang, x, y, lw, alpha, target, bloom}
    var packets = [];      // {id, dir, t0}
    var coreFlash = 0, hover = null, rot = 0, mic = 0, amp = 0;
    var micLevel = null, outLevel = null;
    var running = false, t0 = performance.now(), last = t0;
    var stats = { frames: 0, total: 0, max: 0 };
    window.__mapStats = stats;
    var FAMILY = "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif";
    var FONT_L = "600 11.5px " + FAMILY, FONT_H = "700 13px " + FAMILY, FONT_S = "700 8.5px " + FAMILY;
    var BP = { x: 0, y: 0 }, CP = new Float32Array(8);
    var visibleFn = opts.visible || function () { return true; };

    function sprite(color, size) {
      var c = document.createElement("canvas");
      c.width = c.height = size;
      var g = c.getContext("2d");
      var gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gr.addColorStop(0, color || "rgba(95,191,63,.5)");
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, size, size);
      return c;
    }
    function palette() {
      var cs = getComputedStyle(document.documentElement);
      ["floret", "floret-mid", "floret-hi", "core", "root", "root-hi", "sap", "glow", "hud", "node-bg", "label-bg", "label-line", "label-ink",
        "ink", "sub", "work", "wait", "idle", "off", "off-ink", "mis", "hire", "reply"].forEach(function (k) {
        PAL[k.replace("-", "_")] = cs.getPropertyValue("--orb-" + k).trim();
      });
      PAL.light = cs.getPropertyValue("color-scheme").indexOf("light") >= 0;
      SPR_GLOW = sprite(PAL.glow, 256);
      SPR_SAP = sprite(PAL.sap, 64);
      SPR_REPLY = sprite(PAL.reply, 64);
      measure();
      kick();
    }
    function measure() {
      ctx.font = FONT_L;
      for (var i = 0; i < nodes.length; i++) nodes[i].lw = ctx.measureText(nodes[i].label).width;
    }
    function resize() {
      var r = canvas.getBoundingClientRect();
      DPR = Math.min(2, window.devicePixelRatio || 1);
      W = r.width; H = r.height;
      if (!W || !H) return;
      canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      CX = W / 2; CY = H * 0.49;
      R = Math.max(26, Math.min(50, W * 0.05, H * 0.085));
      RX1 = Math.min(W * 0.27, 330); RY1 = Math.max(60, H * 0.29);
      RX2 = Math.min(W * 0.42, W / 2 - 40); RY2 = Math.max(80, H * 0.42);
      measure();
      kick();
    }
    function stateCol(st) { return st === "working" ? PAL.work : st === "waiting" ? PAL.wait : st === "offline" ? PAL.off : PAL.idle; }

    /** Angles spread evenly, starting up and to the left. */
    function angleFor(k, n) {
      var step = TAU / Math.max(1, n), a = -Math.PI / 2 - step / 2 + k * step;
      if (n === 1) a = -Math.PI * 0.72;
      return a - TAU * Math.floor((a + Math.PI) / TAU);
    }
    function setNodes(list) {
      var old = {};
      nodes.forEach(function (n) { old[n.id] = n; });
      nodes = list.map(function (s, k) {
        var o = old[s.id];
        return {
          id: s.id, label: s.label, st: s.st, subs: s.subs || [], mission: !!s.mission, ang: angleFor(k, list.length),
          x: o ? o.x : 0, y: o ? o.y : 0, lw: 0, alpha: o ? o.alpha : reduced ? 1 : 0, target: 1, bloom: o ? o.bloom : 0,
        };
      });
      measure();
      kick();
    }
    function idx(id) { for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return i; return -1; }

    function place(n, k, time) {
      var a = n.ang + (reduced ? 0 : 0.04 * Math.sin(time * 0.14 + k * 1.9));
      n.x = CX + Math.cos(a) * RX1;
      n.y = CY + Math.sin(a) * RY1;
    }
    function ctrl(x1, y1, k) {
      var ang = Math.atan2(y1 - CY, x1 - CX), sx = CX + Math.cos(ang) * R * 0.8, sy = CY + Math.sin(ang) * R * 0.8;
      var dx = x1 - sx, dy = y1 - sy, L = Math.sqrt(dx * dx + dy * dy) || 1, px = -dy / L, py = dx / L, b = (k % 2 ? 0.16 : -0.16) * L;
      CP[0] = sx; CP[1] = sy; CP[2] = sx + dx * 0.3 + px * b; CP[3] = sy + dy * 0.3 + py * b;
      CP[4] = sx + dx * 0.7 - px * b * 0.5; CP[5] = sy + dy * 0.7 - py * b * 0.5; CP[6] = x1; CP[7] = y1;
    }
    function bez(tt) {
      var u = 1 - tt, a = u * u * u, b = 3 * u * u * tt, c = 3 * u * tt * tt, d = tt * tt * tt;
      BP.x = a * CP[0] + b * CP[2] + c * CP[4] + d * CP[6];
      BP.y = a * CP[1] + b * CP[3] + c * CP[5] + d * CP[7];
    }
    function strokeCP(from, to) {
      ctx.beginPath(); bez(from); ctx.moveTo(BP.x, BP.y);
      if (from === 0 && to === 1) ctx.bezierCurveTo(CP[2], CP[3], CP[4], CP[5], CP[6], CP[7]);
      else for (var i = 1; i <= 20; i++) { bez(from + (to - from) * i / 20); ctx.lineTo(BP.x, BP.y); }
      ctx.stroke();
    }

    function drawRings(time) {
      ctx.save();
      ctx.strokeStyle = PAL.hud; ctx.lineWidth = 1;
      ctx.setLineDash([2, 6]); ctx.globalAlpha = 0.22;
      ctx.beginPath(); ctx.ellipse(CX, CY, Math.max(1, RX1), Math.max(1, RY1), 0, 0, TAU); ctx.stroke();
      // The outer ring is where hired sessions will orbit; empty for now.
      ctx.strokeStyle = PAL.hire; ctx.globalAlpha = 0.13; ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = reduced ? 0 : -time * 4;
      ctx.beginPath(); ctx.ellipse(CX, CY, Math.max(1, RX2), Math.max(1, RY2), 0, 0, TAU); ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
      ctx.font = FONT_S; ctx.textAlign = "center";
      ctx.fillStyle = PAL.hud; ctx.globalAlpha = 0.55; ctx.fillText("LIVE SESSIONS", CX, CY - RY1 - 6);
      ctx.fillStyle = PAL.hire; ctx.globalAlpha = 0.4; ctx.fillText("HIRED SESSIONS · COMING LATER", CX, CY - RY2 - 6);
      ctx.restore();
    }
    function drawHud(time) {
      var wl = WGT[1], wt = WGT[2], ws = WGT[4], i, a;
      ctx.save(); ctx.translate(CX, CY); ctx.strokeStyle = PAL.hud; ctx.lineWidth = 1;
      ctx.rotate(reduced ? 0 : time * (0.05 + wt * 0.25));
      var r1 = R * 1.34;
      ctx.globalAlpha = 0.2; ctx.beginPath();
      for (i = 0; i < 96; i++) { if (i % 8 === 0) continue; a = i / 96 * TAU; ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.lineTo(Math.cos(a) * (r1 + 3), Math.sin(a) * (r1 + 3)); }
      ctx.stroke(); ctx.globalAlpha = 0.55; ctx.beginPath();
      for (i = 0; i < 96; i += 8) { a = i / 96 * TAU; ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.lineTo(Math.cos(a) * (r1 + 7), Math.sin(a) * (r1 + 7)); }
      ctx.stroke(); ctx.restore();
      ctx.save(); ctx.translate(CX, CY); ctx.rotate(reduced ? 0 : -time * (0.1 + wt * 0.5));
      ctx.strokeStyle = PAL.hud; ctx.globalAlpha = 0.5 + 0.3 * wt; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, R * 1.2, 0, 0.7); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, R * 1.2, 1.3, 1.75); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, R * 1.2, 2.6, 3.9); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, R * 1.2, 4.4, 4.85); ctx.stroke();
      ctx.restore();
      // Listening: a ring of ticks that follows the microphone's level.
      if (wl > 0.01) {
        ctx.strokeStyle = PAL.hud; ctx.lineWidth = 2; ctx.globalAlpha = 0.75 * wl; ctx.beginPath();
        for (i = 0; i < 60; i++) {
          a = i / 60 * TAU;
          var lv = mic * (0.45 + 0.55 * Math.abs(Math.sin(a * 3 + time * 3.1) * Math.sin(a * 5 - time * 1.7)));
          var q1 = R * 1.06, q2 = q1 + 3 + lv * R * 0.34;
          ctx.moveTo(CX + Math.cos(a) * q1, CY + Math.sin(a) * q1); ctx.lineTo(CX + Math.cos(a) * q2, CY + Math.sin(a) * q2);
        }
        ctx.stroke();
      }
      // Speaking: ripples that follow the reply's loudness.
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
      ctx.globalAlpha = Math.min(1, (0.55 + 0.15 * wl + 0.3 * wt + 0.25 * wd + 0.35 * ws * amp + coreFlash * 0.4) * (PAL.light ? 0.7 : 0.85));
      var gs = R * (3 + coreFlash * 0.6 + 0.35 * mic * wl + 0.3 * amp * ws);
      ctx.drawImage(SPR_GLOW, CX - gs / 2, CY - gs / 2, gs, gs);
      var sp = R * Math.sqrt(Math.PI / N), i;
      for (i = 0; i < N; i++) {
        var f = (i + 0.5) / N, rn = Math.sqrt(f), th = i * div + rot, r = R * rn * breathe, b = 0.25 + 0.45 * (1 - rn);
        if (wl > 0.01) r += wl * mic * R * 0.22 * f * (0.6 + 0.4 * Math.sin(th * 3 + time * 4));
        if (wt > 0.01) { var wv = Math.sin(i * 0.05 - time * 6); b += wt * 0.5 * (wv > 0.6 ? wv : 0); }
        if (wd > 0.01) { var sw = Math.sin(rn * 12 - time * 10); b += wd * 0.4 * (sw > 0.5 ? sw : 0); }
        if (ws > 0.01) { var sv = Math.sin(rn * 14 - time * 9); r += ws * (0.3 + amp) * R * 0.06 * sv; b += ws * (0.25 + amp) * 0.6 * (sv > 0.25 ? sv : 0); }
        if (coreFlash > 0.01) b += coreFlash * 0.5 * (1 - rn);
        FX[i] = CX + Math.cos(th) * r; FY[i] = CY + Math.sin(th) * r;
        FS[i] = sp * (0.3 + 0.22 * rn) * (1 + 0.22 * (b - 0.25));
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
      ctx.beginPath(); ctx.arc(CX, CY, R * 0.08 * (1 + 0.5 * wt + coreFlash + 0.6 * amp * ws + 0.4 * mic * wl), 0, TAU); ctx.fill();
      ctx.globalAlpha = 1; ctx.textAlign = "center";
      ctx.font = FONT_H; ctx.fillStyle = PAL.ink; ctx.fillText("MONI AI", CX, CY + R * 1.34 + 22);
      ctx.font = FONT_S; ctx.fillStyle = PAL.sub; ctx.fillText("CEO · ALL SESSIONS", CX, CY + R * 1.34 + 34);
    }
    function drawRoots(time) {
      ctx.lineCap = "round";
      for (var k = 0; k < nodes.length; k++) {
        var n = nodes[k];
        if (n.alpha < 0.02) continue;
        var a = n.alpha;
        ctrl(n.x, n.y, k);
        if (n.mission) { ctx.strokeStyle = PAL.mis; ctx.lineWidth = 12; ctx.globalAlpha = 0.11 * a; strokeCP(0, 1); }
        var off = n.st === "offline";
        ctx.strokeStyle = off ? PAL.off : PAL.root;
        ctx.lineWidth = off ? 1.2 : 2.1;
        ctx.globalAlpha = (n.st === "idle" ? 0.55 : off ? 0.45 : 0.85) * a;
        if (off) ctx.setLineDash([3, 5]);
        strokeCP(0, 1);
        ctx.setLineDash([]);
        if (n.st === "working") {
          for (var s = 0; s < 2; s++) {
            var u = reduced ? (s + 0.5) / 2 : (time * 0.28 + s / 2 + k * 0.13) % 1;
            bez(u);
            ctx.globalAlpha = 0.7 * Math.sin(u * Math.PI) * a;
            ctx.drawImage(SPR_SAP, BP.x - 7, BP.y - 7, 14, 14);
          }
        }
      }
      ctx.globalAlpha = 1;
    }
    function drawPackets(now) {
      for (var p = packets.length - 1; p >= 0; p--) {
        var pk = packets[p], k = idx(pk.id);
        if (k < 0) { packets.splice(p, 1); continue; }
        var n = nodes[k], e = (now - pk.t0) / 1400;
        if (e < 0) continue;
        if (e >= 1) {
          packets.splice(p, 1);
          if (pk.dir > 0) n.bloom = 1; else coreFlash = 1;
          continue;
        }
        var u = e < 0.5 ? 2 * e * e : 1 - Math.pow(-2 * e + 2, 2) / 2;
        ctrl(n.x, n.y, k);
        var spr = pk.dir > 0 ? SPR_SAP : SPR_REPLY, col = pk.dir > 0 ? PAL.sap : PAL.reply;
        ctx.strokeStyle = pk.dir > 0 ? PAL.root_hi : PAL.reply; ctx.lineWidth = 2.6; ctx.globalAlpha = 0.8;
        if (pk.dir > 0) strokeCP(0, u); else strokeCP(1 - u, 1);
        for (var j = 6; j >= 0; j--) {
          var tu = pk.dir > 0 ? u - j * 0.025 : 1 - u + j * 0.025;
          if (tu < 0 || tu > 1) continue;
          bez(tu);
          var sz = 1 - j / 7;
          ctx.globalAlpha = 0.85 * sz;
          ctx.drawImage(spr, BP.x - 12 * sz, BP.y - 12 * sz, 24 * sz, 24 * sz);
        }
        bez(pk.dir > 0 ? u : 1 - u);
        ctx.globalAlpha = 1; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(BP.x, BP.y, 3.4, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    function rr(x, y, w, h, r) {
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    function drawNodes(time, dt) {
      for (var k = 0; k < nodes.length; k++) {
        var n = nodes[k];
        if (n.alpha < 0.02) continue;
        var a = n.alpha, x = n.x, y = n.y, col = stateCol(n.st), hov = hover === n.id;
        ctx.globalAlpha = a;
        if (n.mission) {
          ctx.save(); ctx.translate(x, y); ctx.rotate(reduced ? 0 : time * 0.4);
          ctx.strokeStyle = PAL.mis; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]); ctx.globalAlpha = 0.8 * a;
          ctx.beginPath(); ctx.arc(0, 0, 17, 0, TAU); ctx.stroke(); ctx.restore(); ctx.setLineDash([]);
        }
        // Moons: one per running sub-agent (at most 8 drawn).
        var m = Math.min(8, n.subs.length);
        if (m) {
          ctx.strokeStyle = PAL.hud; ctx.lineWidth = 0.8; ctx.globalAlpha = 0.35 * a;
          ctx.beginPath(); ctx.ellipse(x, y, 27, 25, 0, 0, TAU); ctx.stroke();
          for (var i = 0; i < m; i++) {
            var ma = (reduced ? 0.6 : time * 0.7) + i * TAU / m;
            var mx = x + Math.cos(ma) * 27, my = y + Math.sin(ma) * 27 * 0.92;
            ctx.globalAlpha = a * 0.9;
            ctx.drawImage(SPR_SAP, mx - 6, my - 6, 12, 12);
            ctx.fillStyle = PAL.work; ctx.beginPath(); ctx.arc(mx, my, 4, 0, TAU); ctx.fill();
            ctx.strokeStyle = PAL.node_bg; ctx.lineWidth = 1; ctx.stroke();
          }
        }
        if (n.bloom > 0) {
          var bl = n.bloom, open = 1 - bl, pr = 8 + open * 20;
          ctx.fillStyle = PAL.idle; ctx.globalAlpha = 0.5 * bl * a; ctx.beginPath();
          for (var p = 0; p < 8; p++) {
            var pa = p / 8 * TAU + open * 0.6, px = x + Math.cos(pa) * pr * 0.6, py = y + Math.sin(pa) * pr * 0.6;
            ctx.moveTo(px + pr * 0.4, py); ctx.ellipse(px, py, pr * 0.4, pr * 0.15, pa, 0, TAU);
          }
          ctx.fill();
          n.bloom = reduced ? 0 : Math.max(0, bl - dt * 0.9);
        }
        ctx.globalAlpha = a; ctx.fillStyle = PAL.node_bg; ctx.lineWidth = hov ? 2 : 1.3;
        ctx.strokeStyle = n.st === "offline" ? PAL.off : PAL.hud;
        ctx.beginPath(); ctx.arc(x, y, 11, 0, TAU); ctx.fill(); ctx.globalAlpha = (hov ? 1 : 0.7) * a; ctx.stroke();
        if (n.st === "working" || n.st === "waiting") {
          var kk = reduced ? 0.4 : (time * 0.8) % 1;
          ctx.beginPath(); ctx.arc(x, y, 12 + kk * 12, 0, TAU);
          ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.65 * (1 - kk) * a; ctx.stroke();
        }
        if (n.st !== "offline") { ctx.globalAlpha = 0.8 * a; ctx.drawImage(n.st === "working" ? SPR_SAP : SPR_GLOW, x - 12, y - 12, 24, 24); }
        ctx.globalAlpha = a; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, TAU); ctx.fill();
        // Label: below for nodes in the lower half, above for the upper half.
        var below = y >= CY - 4, lw = n.lw + 18, lh = 21, lx = x - lw / 2, ly = below ? y + 30 : y - 30 - lh;
        if (lx < 6) lx = 6;
        if (lx + lw > W - 6) lx = W - 6 - lw;
        ctx.fillStyle = PAL.label_bg; ctx.strokeStyle = hov ? PAL.hud : n.mission ? PAL.mis : PAL.label_line; ctx.lineWidth = 1;
        rr(lx, ly, lw, lh, 10); ctx.fill(); ctx.stroke();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(lx + 9, ly + lh / 2, 3, 0, TAU); ctx.fill();
        ctx.font = FONT_L; ctx.textAlign = "left"; ctx.fillStyle = n.st === "offline" ? PAL.off_ink : PAL.label_ink;
        ctx.fillText(n.label, lx + 15, ly + 14.5);
      }
      ctx.globalAlpha = 1;
    }
    function draw(now) {
      if (!W || !SPR_GLOW) return;
      var ts = performance.now();
      var time = (now - t0) / 1000, dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      for (var s = 0; s < 5; s++) { var tg = s === SI ? 1 : 0; WGT[s] += (tg - WGT[s]) * (reduced ? 1 : Math.min(1, dt * 4)); }
      // The microphone's real level while listening, and the reply's real level
      // while it is read aloud. A voice-like envelope stands in only when no
      // level is on offer.
      var lvl = micLevel ? micLevel() : 0;
      mic += ((0.12 + Math.min(1, lvl * 9)) - mic) * Math.min(1, dt * 12);
      var out = outLevel ? outLevel() : -1;
      var sy = out >= 0 ? Math.min(1, out * 5) : Math.abs(Math.sin(time * 9.5)) * (0.55 + 0.45 * Math.sin(time * 1.7)) * (Math.sin(time * 0.8) > -0.55 ? 1 : 0.1);
      amp += (sy - amp) * Math.min(1, dt * 14);
      if (reduced) { mic = 0.5; amp = 0.6; }
      rot += dt * (0.05 + WGT[2] * 0.5 + WGT[3] * 0.12 + WGT[1] * 0.05);
      coreFlash = reduced ? 0 : Math.max(0, coreFlash - dt * 1.4);
      for (var k = 0; k < nodes.length; k++) {
        var n = nodes[k];
        n.alpha += (n.target - n.alpha) * (reduced ? 1 : Math.min(1, dt * 2.5));
        place(n, k, time);
      }
      ctx.clearRect(0, 0, W, H);
      drawRings(time);
      drawHud(time);
      drawRoots(time);
      drawPackets(now);
      drawHead(time);
      drawNodes(time, dt);
      var el = performance.now() - ts;
      stats.frames++; stats.total += el; if (el > stats.max) stats.max = el;
    }
    function visible() { return !document.hidden && visibleFn(); }
    function loop(now) {
      if (!running) return;
      if (!visible()) { running = false; return; }
      draw(now);
      requestAnimationFrame(loop);
    }
    /** Start the loop; under reduced motion, draw one still frame instead. */
    function start() {
      if (running || !visible()) return;
      if (reduced) { draw(performance.now()); return; }
      running = true;
      last = performance.now();
      requestAnimationFrame(loop);
    }
    /** Something changed while the loop is not running: repaint once (at
        most once a frame, however many changes arrive together). */
    var pending = false;
    function kick() {
      if (running || !visible()) return;
      if (!reduced) { start(); return; }
      if (pending) return;
      pending = true;
      requestAnimationFrame(function (now) { pending = false; if (visible()) draw(now); });
    }
    document.addEventListener("visibilitychange", start);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    else window.addEventListener("resize", resize);

    canvas.addEventListener("mousemove", function (e) {
      var r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, hit = null;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.alpha > 0.5 && Math.abs(n.x - mx) < 22 && Math.abs(n.y - my) < 22) hit = n.id;
      }
      if (hit !== hover) { hover = hit; canvas.classList.toggle("hover", !!hit); kick(); }
    });
    canvas.addEventListener("mouseleave", function () { if (hover) { hover = null; canvas.classList.remove("hover"); kick(); } });
    canvas.addEventListener("click", function () { if (hover && opts.onClick) opts.onClick(hover); });

    return {
      palette: palette,
      resize: resize,
      start: start,
      kick: kick,
      setNodes: setNodes,
      setState: function (name) {
        var i = STATES.indexOf(name);
        if (i < 0 || i === SI) return;
        SI = i;
        kick();
      },
      /** A delegation goes out to this session. False if it is not on the map. */
      send: function (id) {
        if (idx(id) < 0) return false;
        if (!reduced) packets.push({ id: id, dir: 1, t0: performance.now() });
        kick();
        return true;
      },
      /** A reply comes back from this session. */
      reply: function (id) {
        if (idx(id) < 0) return false;
        if (!reduced) packets.push({ id: id, dir: -1, t0: performance.now() });
        kick();
        return true;
      },
      micSource: function (fn) { micLevel = fn; },
      outSource: function (fn) { outLevel = fn; },
      stats: stats,
    };
  };
})();
