  /* ================================================================ FACE V3 (prototype, 2026-10-21, NOT shipped)
   * mockups/bot-face-v3: the eyes and mouth as a vector face layer instead of lit grid nodes. One parametric face
   * (two mirrored eyes + a mouth, each a signed distance field in face space: a = across, b = up, the front grid's
   * own coordinates, -1..1) drawn on a patch that sits on the head's front surface, so it turns and tilts with the
   * head. Expressions are parameter sets and MORPH (no cross-fade of pixels); blink, glance and the voice's visemes
   * act on the parameters. Three looks share it:
   *   a  smooth glyphs   rounded-rect eyes, a smooth arc mouth, anti-aliased (fwidth), a soft glow
   *   b  dot matrix      the same shapes sampled on a symmetric LED grid whose pitch is picked per device size
   *                      (12 / 16 / 22 / 30 / 40 dots across the face), the shapes snapped to whole dots
   *   c  minimal         two soft pills and a thin line, a wider calmer glow
   *   cur                the shipped renderer's node faces (for comparison)
   * The grid nodes under a feature are hidden (their weight row holds the feature's coverage), so the wireframe never
   * shows through the glyphs. 2D twin (fallback, Settings thumbnails): the same SDF per device pixel, inverted through
   * the head's projection (quasi-Newton from the affine map), then blitted with a blurred copy for the glow.
   */
  var FV3 = (function () {
    var N = 28;
    var EX = 0, EY = 1, EW = 2, EH = 3, ER = 4, LT = 5, LB = 6, CA = 7, AW = 8, AC = 9, XW = 10, ET = 11, MW = 12, MY = 13, MH = 14, MC = 15, MT = 16, MV = 17, OX = 18, OY = 19, PI_ = 20, GW = 21, DOTS = 22, GK = 23, AO = 24;
    var KEYS_ = { ex: EX, ey: EY, ew: EW, eh: EH, er: ER, lt: LT, lb: LB, ca: CA, aw: AW, ac: AC, xw: XW, et: ET, mw: MW, my: MY, mh: MH, mc: MC, mt: MT, mv: MV, ox: OX, oy: OY };
    var ZERO = { ex: 0.4, ey: 0.13, ew: 0.14, eh: 0.18, er: 0.6, lt: 0, lb: 0, ca: 0, aw: 0, ac: 0, xw: 0, et: 0.035, mw: 0.2, my: -0.37, mh: 0, mc: 0.06, mt: 0.034, mv: 1, ox: 0, oy: 0 };
    function vec(o, base) { var v = new Float32Array(N), k; for (k in KEYS_) v[KEYS_[k]] = o[k] != null ? o[k] : base && base[k] != null ? base[k] : ZERO[k]; return v; }
    function set(base, faces) { var out = {}; Object.keys(faces).forEach(function (f) { var o = {}, k; for (k in base) o[k] = base[k]; for (k in faces[f]) o[k] = faces[f][k]; out[f] = vec(o); }); return out; }

    /* ---- the three looks: per face name (the renderer's: base, listen, focus, speak, pupils, err, sleep, grin) */
    var A0 = { ex: 0.4, ey: 0.13, ew: 0.14, eh: 0.18, er: 0.62, mw: 0.2, my: -0.37, mc: 0.06, mt: 0.034 };
    var STY = {
      a: {
        faces: set(A0, {
          base: {},
          listen: { ew: 0.152, eh: 0.215, ey: 0.15, er: 0.66, mw: 0.095, mc: 0.012 },
          focus: { ew: 0.15, eh: 0.17, lt: 0.44, ey: 0.11, ox: -0.035, oy: 0.025, mw: 0.11, mc: 0, my: -0.38 },
          speak: {},
          pupils: { ew: 0.165, eh: 0.205, er: 0.85, ca: 0.05, ey: 0.14, mw: 0.05, mh: 0.045, mt: 0.03, mc: 0, my: -0.4 },
          err: { xw: 1, ew: 0.11, eh: 0.11, et: 0.036, ey: 0.13, mw: 0.16, mc: -0.05, my: -0.41 },
          sleep: { aw: 1, ac: -1, ew: 0.135, eh: 0.075, et: 0.032, ey: 0.06, mw: 0.05, mc: 0, mt: 0.03, my: -0.37 },
          grin: { aw: 1, ac: 1, ew: 0.14, eh: 0.1, et: 0.04, ey: 0.15, mw: 0.24, mh: 0.085, mc: 0.085, my: -0.31 },
        }),
        vis: { closed: [0.19, 0, 0.03], open: [0.15, 0.1, 0], wide: [0.25, 0.05, 0.03], round: [0.075, 0.085, 0] },
        gw: 0.2, gk: 1, smallK: 0.3, small: 1,
      },
      b: {
        faces: set({ ex: 0.4, ey: 0.14, ew: 0.15, eh: 0.2, er: 0.55, mw: 0.22, my: -0.38, mc: 0.07, mt: 0.04 }, {
          base: {},
          listen: { ew: 0.16, eh: 0.24, er: 0.6, mw: 0.09, mc: 0 },
          focus: { ew: 0.16, eh: 0.2, lt: 0.5, ey: 0.12, ox: -0.05, mw: 0.12, mc: 0 },
          speak: {},
          pupils: { ew: 0.18, eh: 0.22, er: 0.7, mw: 0.05, mh: 0.05, mc: 0, my: -0.42 },
          err: { xw: 1, ew: 0.14, eh: 0.14, et: 0.04, mw: 0.18, mc: -0.06 },
          sleep: { aw: 1, ac: -1, ew: 0.15, eh: 0.08, ey: 0.06, mw: 0.05, mc: 0 },
          grin: { aw: 1, ac: 1, ew: 0.15, eh: 0.1, ey: 0.16, mw: 0.25, mh: 0.1, mc: 0.1, my: -0.32 },
        }),
        vis: { closed: [0.2, 0, 0.03], open: [0.16, 0.11, 0], wide: [0.27, 0.06, 0.03], round: [0.08, 0.1, 0] },
        gw: 0.16, gk: 0.8, smallK: 0, small: 0.7, dots: true,
      },
      c: {
        faces: set({ ex: 0.31, ey: 0.11, ew: 0.078, eh: 0.165, er: 1, mw: 0.12, my: -0.36, mc: 0.016, mt: 0.021, et: 0.022 }, {
          base: {},
          listen: { ew: 0.086, eh: 0.205, ey: 0.13, mw: 0.075, mc: 0 },
          focus: { ew: 0.09, eh: 0.072, ey: 0.09, ox: -0.035, mw: 0.09, mc: 0 },
          speak: {},
          pupils: { ew: 0.095, eh: 0.18, ey: 0.12, mw: 0.022, mt: 0.026, mc: 0 },
          err: { xw: 1, ew: 0.072, eh: 0.072, et: 0.021, mw: 0.1, mc: -0.035 },
          sleep: { aw: 1, ac: -1, ew: 0.09, eh: 0.04, ey: 0.05, mv: 0 },
          grin: { aw: 1, ac: 1, ew: 0.09, eh: 0.06, et: 0.024, ey: 0.12, mw: 0.16, mc: 0.055, mt: 0.022 },
        }),
        vis: { closed: [0.12, 0, 0.014], open: [0.1, 0.06, 0], wide: [0.15, 0.03, 0.012], round: [0.05, 0.05, 0] },
        gw: 0.3, gk: 1.2, smallK: 0.45, small: 1,
      },
    };
    var DEF_STYLE = "a";
    function style(s) {
      if (s == null && typeof window !== "undefined" && window.MINT_FACE_V3) s = window.MINT_FACE_V3;
      return s === "cur" || STY[s] ? s : DEF_STYLE;
    }

    /* ---- the B grid: dots across the face (2 units), picked so a dot is >= ~5 device px; then the shapes snap */
    var DOTN = [40, 30, 22, 16, 12];
    function pitchFor(cssR, dpr) {
      var unit = cssR * dpr; // device px per face unit
      for (var i = 0; i < DOTN.length; i++) if (2 * unit / DOTN[i] >= 5.2) return 2 / DOTN[i];
      return 2 / DOTN[DOTN.length - 1];
    }
    function snapCount(hw, p, min) { return Math.max(min || 1, Math.round(2 * hw / p)); }
    function snapPos(x, p, n) { return n % 2 ? Math.round(x / p) * p : (Math.floor(x / p) + 0.5) * p; }
    function snapDots(v, p) {
      var nW = snapCount(v[EW], p), nH = snapCount(v[EH], p);
      if (v[XW] > 0.5) { nW = nH = Math.max(3, nW | 1); } // an x: odd and square, so its arms meet on a dot
      v[EX] = snapPos(v[EX], p, nW); v[EY] = snapPos(v[EY], p, nH);
      v[EW] = (nW / 2 - 0.5) * p + 0.32 * p; v[EH] = (nH / 2 - 0.5) * p + 0.32 * p;
      v[ET] = 0.52 * p; v[CA] = 0;
      // arcs: whole dots wide, the peak on a row and the ends exactly one (or more) rows lower -- no half-lit rows
      if (v[AW] > 0.5) { v[EW] = Math.max(1, Math.round(v[EW] / p)) * p; v[EH] = Math.max(1, Math.round(v[EH] / p)) * p; v[AO] = 1; v[ET] = 0.45 * p; v[EX] = Math.round(v[EX] / p) * p; v[EY] = Math.round(v[EY] / p) * p; }
      var nM = 2 * Math.max(1, Math.round(v[MW] / p)) + 1;
      v[MW] = (nM / 2 - 0.5) * p + 0.32 * p; v[MY] = Math.round(v[MY] / p) * p; v[MT] = 0.5 * p;
      v[MH] = Math.round(v[MH] / p) * p;
      // a curve shallower than a dot reads as noise on a coarse grid: flat, or a whole row
      v[MC] = p > 0.1 ? (Math.abs(v[MC]) < 0.5 * p ? 0 : (v[MC] < 0 ? -1 : 1) * p) : Math.round(v[MC] / p * 2) * p / 2;
      v[OX] = Math.round(v[OX] / p) * p; v[OY] = Math.round(v[OY] / p) * p;
    }

    /* ---- one face vector: the anim's face morphing from its previous one, the voice, blink, gaze, size */
    var TA = new Float32Array(N), TB = new Float32Array(N);
    function faceOf(T, name, vm, amp, out) {
      var src = T.faces[name] || T.faces.base;
      for (var i = 0; i < 20; i++) out[i] = src[i];
      if (name === "speak") {
        var V = T.vis, c, o, w, r;
        if (vm) { c = vm.closed; o = vm.open; w = vm.wide; r = vm.round; } else { o = Math.max(0, Math.min(1, amp * 1.6)); c = 1 - o; w = r = 0; }
        var s = c + o + w + r || 1;
        for (var j = 0; j < 3; j++) out[[MW, MH, MC][j]] = (c * V.closed[j] + o * V.open[j] + w * V.wide[j] + r * V.round[j]) / s;
      }
      return out;
    }
    function sm(x) { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); }
    /**
     * vecFor(style, an, cssR, dpr, amp, vm, out, W8, off): out <- the face vector; W8[off ..] <- the front nodes'
     * coverage (hides the grid under the features).
     */
    function vecFor(st, an, cssR, dpr, amp, vm, out, W8, off) {
      var T = STY[st] || STY.a;
      var A = faceOf(T, an.face, vm, amp, TA), P = faceOf(T, an.prev, vm, amp, TB), k = sm(an.fk);
      for (var i = 0; i < 20; i++) out[i] = P[i] + (A[i] - P[i]) * k;
      var bl = an.blink();
      if (out[AW] < 0.5) out[EH] = Math.max(out[EH] * bl, 0.018 + (T.dots ? 0 : 0)); // shut: a short line
      out[OX] += clamp(an.gx, -2.2, 2.2) * 0.075; out[OY] += -an.gy * 0.07;
      var smallness = clamp((44 - cssR) / 28, 0, 1), sc = 1 + T.smallK * smallness;
      out[EW] *= sc; out[EH] *= sc; out[MW] *= sc; out[MH] *= sc; out[MT] *= sc; out[ET] *= sc; out[CA] *= sc;
      if (smallness > 0.5) out[CA] = 0; // a catchlight under ~30 px is noise
      var mp = 1 / Math.max(1, cssR * dpr); // face units per device px
      out[AO] = 0.5;
      if (T.dots) { out[PI_] = pitchFor(cssR, dpr); out[DOTS] = 1; snapDots(out, out[PI_]); }
      else {
        out[PI_] = 0; out[DOTS] = 0;
        out[EW] = Math.max(out[EW], 1.3 * mp); out[EH] = Math.max(out[EH], 0.85 * mp);
        out[MT] = Math.max(out[MT], 0.8 * mp); out[ET] = Math.max(out[ET], 0.8 * mp);
      }
      out[GW] = T.gw; out[GK] = T.gk * (cssR < 40 ? T.small : 1);
      if (!T.dots) out[AO] = 0.5;
      if (W8) for (var r = 0; r < GN; r++) for (var c = 0; c < GN; c++) {
        var a = 2 * c / G - 1, b = 1 - 2 * r / G;
        var cv = cov(out, a, b, 0.09);
        W8[off + r * GN + c] = Math.min(255, (cv * 1.7 * 255 + 0.5) | 0);
      }
      return out;
    }

    /* ---- the shapes (the GLSL below is their twin) */
    function sdRB(px, py, bx, by, r) {
      var qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
      return Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    }
    function sdSeg(px, py, ax, ay, bx, by) {
      var pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay, h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
      return Math.sqrt((pax - bax * h) * (pax - bax * h) + (pay - bay * h) * (pay - bay * h));
    }
    function eyeFill(v, px, py, ux) {
      var hw = v[EW], hh = v[EH], r = Math.min(v[ER], 1) * Math.min(hw, hh);
      var d = sdRB(px, py, hw, hh, r);
      d = Math.max(d, py - hh * (1 - 2 * v[LT]));
      d = Math.max(d, -py - hh * (1 - 2 * v[LB]));
      if (v[CA] > 0) d = Math.max(d, -(Math.sqrt((ux - hw * 0.4) * (ux - hw * 0.4) + (py - hh * 0.45) * (py - hh * 0.45)) - v[CA]));
      return d;
    }
    function eyeArc(v, px, py) {
      var w = v[EW], h = v[EH] * v[AC], ao = v[AO], u = clamp(px, -w, w), y = h * (1 - u * u / (w * w)) - h * ao;
      if (Math.abs(px) > w) return Math.sqrt((Math.abs(px) - w) * (Math.abs(px) - w) + (py + h * ao) * (py + h * ao)) - v[ET];
      var s = v[DOTS] > 0.5 ? 0 : -2 * h * u / (w * w);
      return Math.abs(py - y) / Math.sqrt(1 + s * s) - v[ET];
    }
    function eyeX(v, px, py) { var w = v[EW] * 0.9, h = v[EH] * 0.9; return Math.min(sdSeg(px, py, -w, -h, w, h), sdSeg(px, py, -w, h, w, -h)) - v[ET]; }
    function mouthD(v, px, py) {
      // an open mouth: a superellipse (n 3) under the lip line -- a rounded D, not a drop
      var w = Math.max(v[MW], 1e-4), s = clamp(px / w, -1, 1), as = Math.abs(s), q = Math.pow(Math.max(0, 1 - as * as * as), 1 / 3);
      if (Math.abs(px) > w) return Math.sqrt((Math.abs(px) - w) * (Math.abs(px) - w) + py * py) - v[MT];
      var base = -v[MC] * (1 - s * s), sl = 2 * v[MC] * s / w, sg = s < 0 ? -1 : 1, dq = q > 1e-3 ? -sg * s * s / (w * q * q) : -sg * 1e3;
      var up = base + 0.55 * v[MH] * q + v[MT], lo = base - v[MH] * q - v[MT], mid = (up + lo) / 2, g;
      var gk = v[DOTS] > 0.5 ? 0 : 1;
      if (py >= mid) { g = gk * clamp(sl + 0.55 * v[MH] * dq, -20, 20); return (py - up) / Math.sqrt(1 + g * g); }
      g = gk * clamp(sl - v[MH] * dq, -20, 20); return (lo - py) / Math.sqrt(1 + g * g);
    }
    function cv(d, aa) { var x = 0.5 - d / aa; return x < 0 ? 0 : x > 1 ? 1 : x; }
    /** Coverage 0..1 of the face at (a, b) with an edge aa wide (face units). */
    function cov(v, a, b, aa) {
      var ex = a - v[OX], ey = b - v[EY] - v[OY], sx = ex < 0 ? -1 : 1, px = Math.abs(ex) - v[EX], ux = ex - sx * v[EX];
      var aw = v[AW], xw = v[XW], fw = Math.max(0, 1 - aw - xw), ce = 0;
      if (fw > 0.001) ce += fw * cv(eyeFill(v, px, ey, ux), aa);
      if (aw > 0.001) ce += aw * cv(eyeArc(v, px, ey), aa);
      if (xw > 0.001) ce += xw * cv(eyeX(v, px, ey), aa);
      var cm = v[MV] > 0.001 ? v[MV] * cv(mouthD(v, a - v[OX] * 0.35, b - v[MY] - v[OY] * 0.3), aa) : 0;
      return Math.min(1, Math.max(ce, cm));
    }
    function covAt(v, a, b, aa) {
      if (v[DOTS] < 0.5) return cov(v, a, b, aa);
      var p = v[PI_], cx = Math.floor(a / p + 0.5) * p, cy = Math.floor(b / p + 0.5) * p;
      var lit = cov(v, cx, cy, p * 0.2), dd = Math.sqrt((a - cx) * (a - cx) + (b - cy) * (b - cy)) - p * (p > 0.12 ? 0.46 : 0.4);
      return lit * cv(dd, aa);
    }

    /* ---- GL: the patch over the front face (head space + face coords), the program */
    var patchCache = {};
    function patch(p) {
      if (patchCache[p]) return patchCache[p];
      var NU = 26, NV = 24, A0_ = -0.9, A1 = 0.9, B0 = -0.88, B1 = 0.74, vs = [], ix = [];
      for (var j = 0; j <= NV; j++) for (var i = 0; i <= NU; i++) {
        var a = A0_ + (A1 - A0_) * i / NU, b = B0 + (B1 - B0) * j / NV, k = Math.pow(Math.pow(Math.abs(a), p) + Math.pow(Math.abs(b), p) + 1, -1 / p);
        vs.push(a * k, b * k * 0.98, k * 1.003, a, b);
      }
      for (j = 0; j < NV; j++) for (i = 0; i < NU; i++) { var q = j * (NU + 1) + i; ix.push(q, q + 1, q + NU + 1, q + 1, q + NU + 2, q + NU + 1); }
      return (patchCache[p] = { v: new Float32Array(vs), i: new Uint16Array(ix) });
    }
    var VS = [
      "#version 300 es",
      "precision highp float;",
      "layout(location=0) in vec3 a_p; layout(location=1) in vec2 a_uv;",
      "uniform vec2 u_res,u_c; uniform float u_r,u_fs,u_sc,u_yaw,u_tilt;",
      "out vec2 v_uv;",
      "void main(){ vec3 p=a_p; float cy=cos(u_yaw),sy=sin(u_yaw),ct=cos(u_tilt),st=sin(u_tilt);",
      " float x1=p.x*cy+p.z*sy, z1=-p.x*sy+p.z*cy; float y2=p.y*ct-z1*st;",
      " vec2 px=(u_c+vec2(x1,y2)*u_r*u_sc)*u_fs; v_uv=a_uv; gl_Position=vec4(px/u_res*2.0-1.0,0.0,1.0); }",
    ].join("\n");
    var FS = [
      "#version 300 es",
      "precision highp float;",
      "in vec2 v_uv; uniform vec4 u_f[7]; uniform vec3 u_st; uniform float u_lit,u_alpha,u_gl; out vec4 o;",
      "#define EX u_f[0].x", "#define EY u_f[0].y", "#define EW u_f[0].z", "#define EH u_f[0].w",
      "#define ER u_f[1].x", "#define LT u_f[1].y", "#define LB u_f[1].z", "#define CA u_f[1].w",
      "#define AW u_f[2].x", "#define AC u_f[2].y", "#define XW u_f[2].z", "#define ET u_f[2].w",
      "#define MW u_f[3].x", "#define MY u_f[3].y", "#define MH u_f[3].z", "#define MC u_f[3].w",
      "#define MT u_f[4].x", "#define MV u_f[4].y", "#define OX u_f[4].z", "#define OY u_f[4].w",
      "#define PIT u_f[5].x", "#define GWD u_f[5].y", "#define DOTS u_f[5].z", "#define AO u_f[6].x",
      "float sdRB(vec2 p,vec2 b,float r){ vec2 q=abs(p)-b+r; return length(max(q,0.0))+min(max(q.x,q.y),0.0)-r; }",
      "float sdSeg(vec2 p,vec2 a,vec2 b){ vec2 pa=p-a,ba=b-a; float h=clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0); return length(pa-ba*h); }",
      "float eyeFill(vec2 p,float ux){ float r=min(ER,1.0)*min(EW,EH); float d=sdRB(p,vec2(EW,EH),r);",
      " d=max(d,p.y-EH*(1.0-2.0*LT)); d=max(d,-p.y-EH*(1.0-2.0*LB));",
      " if(CA>0.0) d=max(d,-(length(vec2(ux-EW*0.4,p.y-EH*0.45))-CA)); return d; }",
      "float eyeArc(vec2 p){ float w=EW,h=EH*AC; float u=clamp(p.x,-w,w); float y=h*(1.0-u*u/(w*w))-h*AO;",
      " if(abs(p.x)>w) return length(vec2(abs(p.x)-w,p.y+h*AO))-ET; float s=DOTS>0.5?0.0:-2.0*h*u/(w*w); return abs(p.y-y)/sqrt(1.0+s*s)-ET; }",
      "float eyeX(vec2 p){ float w=EW*0.9,h=EH*0.9; return min(sdSeg(p,vec2(-w,-h),vec2(w,h)),sdSeg(p,vec2(-w,h),vec2(w,-h)))-ET; }",
      "float mouthD(vec2 p){ float w=max(MW,1e-4); float s=clamp(p.x/w,-1.0,1.0); float as_=abs(s); float q=pow(max(0.0,1.0-as_*as_*as_),1.0/3.0);",
      " if(abs(p.x)>w) return length(vec2(abs(p.x)-w,p.y))-MT;",
      " float base=-MC*(1.0-s*s); float sl=2.0*MC*s/w; float sg=s<0.0?-1.0:1.0; float dq=q>1e-3?-sg*s*s/(w*q*q):-sg*1e3;",
      " float up=base+0.55*MH*q+MT, lo=base-MH*q-MT, mid=(up+lo)*0.5;",
      " float gk=DOTS>0.5?0.0:1.0;",
      " if(p.y>=mid){ float g=gk*clamp(sl+0.55*MH*dq,-20.0,20.0); return (p.y-up)/sqrt(1.0+g*g); }",
      " float g=gk*clamp(sl-MH*dq,-20.0,20.0); return (lo-p.y)/sqrt(1.0+g*g); }",
      "float cvv(float d,float aa){ return clamp(0.5-d/aa,0.0,1.0); }",
      "float cov(vec2 q,float aa){ vec2 e=vec2(q.x-OX,q.y-EY-OY); float sx=e.x<0.0?-1.0:1.0; vec2 p=vec2(abs(e.x)-EX,e.y); float ux=e.x-sx*EX;",
      " float fw=max(0.0,1.0-AW-XW); float ce=0.0;",
      " if(fw>0.001) ce+=fw*cvv(eyeFill(p,ux),aa); if(AW>0.001) ce+=AW*cvv(eyeArc(p),aa); if(XW>0.001) ce+=XW*cvv(eyeX(p),aa);",
      " float cm=MV>0.001?MV*cvv(mouthD(vec2(q.x-OX*0.35,q.y-MY-OY*0.3)),aa):0.0; return min(1.0,max(ce,cm)); }",
      "void main(){ vec2 q=v_uv; float fw=max(fwidth(q.x),fwidth(q.y)); float c;",
      " if(u_gl>0.5) c=cov(q,GWD)*0.9;",
      " else if(DOTS>0.5){ vec2 ce=floor(q/PIT+0.5)*PIT; float lit=cov(ce,PIT*0.2); float dd=length(q-ce)-PIT*(PIT>0.12?0.46:0.4); c=lit*cvv(dd,fw*1.1); }",
      " else c=cov(q,fw*1.15);",
      " float a=clamp(c*u_lit,0.0,1.0)*u_alpha; if(a<0.003) discard; o=vec4(u_st*a,a); }",
    ].join("\n");
    /** One head's face on GL (P: the program, g: {vao, n}, h: the pool head, v: its vector). */
    function drawGL(gl, P, g, h, v, resW, resH, fs, dpr, cssH, glowPass, light) {
      var u = P.u, fa = h.alpha * (h.form < 1 ? h.form * h.form : 1) * (1 - h.dis);
      if (fa < 0.01) return;
      gl.uniform2f(u.u_res, resW, resH); gl.uniform2f(u.u_c, h.cx * dpr, (cssH - h.cy) * dpr);
      gl.uniform1f(u.u_r, h.r * dpr); gl.uniform1f(u.u_fs, fs); gl.uniform1f(u.u_sc, h.sc); gl.uniform1f(u.u_yaw, h.yaw); gl.uniform1f(u.u_tilt, h.tilt);
      gl.uniform4fv(u["u_f[0]"], v);
      gl.uniform3f(u.u_st, h.st[0] / 255, h.st[1] / 255, h.st[2] / 255);
      gl.uniform1f(u.u_lit, glowPass ? h.lit * h.glowK * v[GK] * (light ? 0.28 : 0.55) : h.lit);
      gl.uniform1f(u.u_alpha, fa); gl.uniform1f(u.u_gl, glowPass ? 1 : 0);
      gl.bindVertexArray(g.vao); gl.drawElements(gl.TRIANGLES, g.n, gl.UNSIGNED_SHORT, 0);
    }

    /*
     * ---- 2D (the fallback and the Settings thumbnails): the same shapes as vector paths, every vertex through the
     * head's exact projection, so canvas anti-aliases them; B's dots are circles at the lit grid centres; the glow is
     * the fill's shadow. (A per-pixel twin was tried first: correct, but its putImageData uploads stalled the
     * compositor once six session heads were on screen.)
     */
    var PT = [0, 0];
    function draw2d(g, o, cyw, syw, ct, stt, R, fade) {
      var v = o.fv, p = o.geo.cfg.p, dpr = o.dpr || 1;
      function F(a, b) {
        var k = Math.pow(Math.pow(Math.abs(a), p) + Math.pow(Math.abs(b), p) + 1, -1 / p), x = a * k, y = b * k * 0.98, z = k;
        var x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw, y2 = y * ct - z1 * stt;
        PT[0] = o.cx + x1 * R; PT[1] = o.cy - y2 * R; return PT;
      }
      function to(a, b, first) { F(a, b); if (first) g.moveTo(PT[0], PT[1]); else g.lineTo(PT[0], PT[1]); }
      var lit = Math.min(1, o.lit) * fade, gk = v[GK] * (o.light ? 0.45 : 0.9), col = rgba(o.st, 1);
      if (lit < 0.01) return;
      g.save();
      g.fillStyle = col; g.strokeStyle = col; g.lineCap = "round"; g.lineJoin = "round";
      if (gk > 0.01) { g.shadowColor = rgba(o.st, Math.min(1, gk)); g.shadowBlur = Math.max(2, R * v[GW] * 0.5) * dpr; }
      var oy = v[EY] + v[OY], fw = Math.max(0, 1 - v[AW] - v[XW]), sx, cx, i, n;
      if (v[DOTS] > 0.5) {
        // the dot grid: every lit centre inside the features' rectangles, full dots in one path, partial ones alone
        var pp = v[PI_], rad = pp * (pp > 0.12 ? 0.46 : 0.4) * R * 0.97, m = pp, ac = Math.abs(v[MC]);
        var ew = v[EW] + v[ET] + m, eh = v[EH] + v[ET] + m, mx = v[OX] * 0.35, my = v[MY] + v[OY] * 0.3, mw = v[MW] + v[MT] + m;
        var rects = [[v[OX] + v[EX] - ew, v[OX] + v[EX] + ew, oy - eh, oy + eh], [v[OX] - v[EX] - ew, v[OX] - v[EX] + ew, oy - eh, oy + eh]];
        if (v[MV] > 0.001) rects.push([mx - mw, mx + mw, my - ac - v[MH] - v[MT] - m, my + ac + 0.55 * v[MH] + v[MT] + m]);
        g.globalAlpha = lit; g.beginPath();
        var seen = {}, part = [];
        for (var ri = 0; ri < rects.length; ri++) {
          var rc = rects[ri];
          for (var gy = Math.ceil(rc[2] / pp); gy * pp <= rc[3]; gy++) for (var gx = Math.ceil(rc[0] / pp); gx * pp <= rc[1]; gx++) {
            var key = gx + "," + gy; if (seen[key]) continue; seen[key] = 1;
            var lv = cov(v, gx * pp, gy * pp, pp * 0.2);
            if (lv < 0.02) continue;
            F(gx * pp, gy * pp);
            if (lv > 0.98) { g.moveTo(PT[0] + rad, PT[1]); g.arc(PT[0], PT[1], rad, 0, 2 * PI); }
            else part.push(PT[0], PT[1], lv);
          }
        }
        g.fill();
        for (i = 0; i < part.length; i += 3) { g.globalAlpha = lit * part[i + 2]; g.beginPath(); g.arc(part[i], part[i + 1], rad, 0, 2 * PI); g.fill(); }
        g.restore();
        return;
      }
      for (var side = -1; side <= 1; side += 2) {
        cx = v[OX] + side * v[EX];
        var hw = v[EW], hh = v[EH];
        if (fw > 0.001) { // a rounded rectangle, cut by the lids; a catchlight as an even-odd hole
          var r = Math.min(v[ER], 1) * Math.min(hw, hh), yT = hh * (1 - 2 * v[LT]), yB = -hh * (1 - 2 * v[LB]), first = true;
          var CC = [[1, 1, 0], [-1, 1, PI / 2], [-1, -1, PI], [1, -1, 1.5 * PI]];
          g.globalAlpha = lit * fw; g.beginPath();
          for (var q = 0; q < 4; q++) for (i = 0; i <= 8; i++) {
            var an = CC[q][2] + i / 8 * PI / 2, px = CC[q][0] * (hw - r) + Math.cos(an) * r, py = CC[q][1] * (hh - r) + Math.sin(an) * r;
            to(cx + px, oy + Math.max(yB, Math.min(yT, py)), first); first = false;
          }
          g.closePath();
          if (v[CA] > 0) { for (i = 0; i <= 16; i++) { var ca = i / 16 * 2 * PI; to(cx + hw * 0.4 + Math.cos(ca) * v[CA], oy + hh * 0.45 + Math.sin(ca) * v[CA], i === 0); } g.closePath(); }
          g.fill("evenodd");
        }
        g.lineWidth = 2 * v[ET] * R;
        if (v[AW] > 0.001) { // an arc
          var h = hh * v[AC]; g.globalAlpha = lit * v[AW]; g.beginPath(); n = 14;
          for (i = 0; i <= n; i++) { var u = -hw + 2 * hw * i / n; to(cx + u, oy + h * (1 - u * u / (hw * hw)) - h * v[AO], i === 0); }
          g.stroke();
        }
        if (v[XW] > 0.001) { // an x
          var xw = hw * 0.9, xh = hh * 0.9; g.globalAlpha = lit * v[XW]; g.beginPath();
          to(cx - xw, oy - xh, true); to(cx + xw, oy + xh); to(cx - xw, oy + xh, true); to(cx + xw, oy - xh); g.stroke();
        }
      }
      if (v[MV] > 0.001) { // the mouth: the open shape's outline, filled and stroked MT wide (its rounded ends)
        var mw2 = Math.max(v[MW], 1e-4), mx2 = v[OX] * 0.35, my2 = v[MY] + v[OY] * 0.3; n = 24;
        g.globalAlpha = lit * v[MV]; g.lineWidth = 2 * v[MT] * R; g.beginPath();
        for (i = 0; i <= n; i++) { var s = -1 + 2 * i / n, qq = Math.pow(Math.max(0, 1 - Math.abs(s * s * s)), 1 / 3); to(mx2 + s * mw2, my2 - v[MC] * (1 - s * s) + 0.55 * v[MH] * qq, i === 0); }
        for (i = n; i >= 0; i--) { var s2 = -1 + 2 * i / n, q2 = Math.pow(Math.max(0, 1 - Math.abs(s2 * s2 * s2)), 1 / 3); to(mx2 + s2 * mw2, my2 - v[MC] * (1 - s2 * s2) - v[MH] * q2); }
        g.closePath(); if (v[MH] > 0.002) g.fill(); g.stroke();
      }
      g.restore();
    }

    return { N: N, STY: STY, style: style, vec: vecFor, cov: cov, covAt: covAt, patch: patch, VS: VS, FS: FS, drawGL: drawGL, draw2d: draw2d, pitchFor: pitchFor };
  })();

