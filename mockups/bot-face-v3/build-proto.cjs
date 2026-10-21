#!/usr/bin/env node
"use strict";
/**
 * Bot face v3 (2026-10-21, options for the user to pick -- NOT shipped): a prototype of core E built from the real
 * renderer (dashboard/public/mint-core-bot.js) with the eyes and mouth drawn by a vector face layer (face-v3.js next
 * to this file) instead of lit grid nodes. The look is picked per core: opts.faceStyle | core.faceStyle(s) |
 * window.MINT_FACE_V3, one of "a" (smooth glyphs), "b" (dot matrix), "c" (minimal), "cur" (the shipped faces).
 * MintBot.thumb takes { faceStyle } too.
 *
 *     node mockups/bot-face-v3/build-proto.cjs   -> proto-core-bot.js next to this file
 *
 * Every patch is a literal string replacement that must match once: if the renderer changes, this says where.
 */
const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "..", "..", "dashboard", "public", "mint-core-bot.js");
const FACE = fs.readFileSync(path.join(__dirname, "face-v3.js"), "utf8");
let s = fs.readFileSync(SRC, "utf8");
function patch(name, from, to) {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error("patch " + name + ": expected 1 match, found " + n);
  s = s.replace(from, () => to);
}

// 1. the face layer (module scope, before the 2D renderer)
patch("insert",
  "  /* ------------------------------------------------------------ Canvas 2D (the fallback, and the thumbnails) */",
  FACE + "\n  /* ------------------------------------------------------------ Canvas 2D (the fallback, and the thumbnails) */");

// 2. GL: its program and per-head-type patch buffers
patch("prog", "progZ = prog(ZZZ_VS, WIRE_FS);", "progZ = prog(ZZZ_VS, WIRE_FS); progF = prog(FV3.VS, FV3.FS);");
patch("prog-var", "var progW = null, progQ = null,", "var progF = null, fvGeos = {}, progW = null, progQ = null,");
patch("fvgeo",
  "    function freeGeos() {",
  [
    "    function fvGeo(p) {",
    "      if (fvGeos[p]) return fvGeos[p];",
    "      var P = FV3.patch(p), o = { vao: gl.createVertexArray(), n: P.i.length };",
    "      gl.bindVertexArray(o.vao);",
    "      o.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, o.vbo); gl.bufferData(gl.ARRAY_BUFFER, P.v, gl.STATIC_DRAW);",
    "      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);",
    "      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);",
    "      o.ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, P.i, gl.STATIC_DRAW);",
    "      gl.bindVertexArray(null);",
    "      return (fvGeos[p] = o);",
    "    }",
    "    function freeGeos() {",
  ].join("\n"));

// 3. state: the look; a face vector per head row
patch("state", "      ind: null,\n    };", "      ind: null,\n      fstyle: FV3.style(opts.faceStyle),\n    };");
patch("fvec", "    var nHeads = 0;", "    var nHeads = 0;\n    var FVEC = []; for (var fvi = 0; fvi < MAXK + 1; fvi++) FVEC.push(new Float32Array(FV3.N));");

// 4. per frame: the core's and the sessions' faces
patch("core-w",
  "      weights(an, W8, 0, W.speak > 0.05 ? S.amp : 0, rc < SMALL, S.vis);",
  "      if (S.fstyle === \"cur\") weights(an, W8, 0, W.speak > 0.05 ? S.amp : 0, rc < SMALL, S.vis);\n      else FV3.vec(S.fstyle, an, rc, S.dpr, W.speak > 0.05 ? S.amp : 0, W.speak > 0.05 ? S.vis : null, FVEC[0], W8, 0);");
patch("kid-w",
  "          weights(ka, W8, (i + 1) * NF, sf.state === \"speaking\" ? 0.35 + 0.55 * synthAmp(ka.t + ka.ph) : 0, kr < SMALL, null);",
  "          if (S.fstyle === \"cur\") weights(ka, W8, (i + 1) * NF, sf.state === \"speaking\" ? 0.35 + 0.55 * synthAmp(ka.t + ka.ph) : 0, kr < SMALL, null);\n          else FV3.vec(S.fstyle, ka, kr, S.dpr, sf.state === \"speaking\" ? 0.35 + 0.55 * synthAmp(ka.t + ka.ph) : 0, null, FVEC[i + 1], W8, (i + 1) * NF);");

// 5. GL draw: the glow pass and the face itself replace the lit nodes, strokes and node glow
patch("glow-skip",
  "          if (h.cssR < SMALL) continue; // small heads: no blurred face glow (it would swallow the pixels)",
  "          if (S.fstyle !== \"cur\") continue;\n          if (h.cssR < SMALL) continue; // small heads: no blurred face glow (it would swallow the pixels)");
patch("glow-v3",
  "        gl.bindFramebuffer(gl.FRAMEBUFFER, null);\n      }\n      gl.viewport(0, 0, cw, ch);",
  [
    "        if (S.fstyle !== \"cur\") {",
    "          gl.useProgram(progF.p);",
    "          for (i = 0; i < nHeads; i++) { h = POOL[i]; FV3.drawGL(gl, progF, fvGeo(HEADS[h.head].p), h, FVEC[h.row], fboW, fboH, fs, dpr, S.cssH, true, S.light > 0.5); }",
    "        }",
    "        gl.bindFramebuffer(gl.FRAMEBUFFER, null);\n      }\n      gl.viewport(0, 0, cw, ch);",
  ].join("\n"));
patch("face-v3",
  [
    "        if (o.segN) {",
    "          gl.bindVertexArray(o.segVao); gl.uniform1f(u.u_mode, 3);",
    "          gl.drawArrays(gl.POINTS, 0, o.segN);",
    "          gl.bindVertexArray(o.vao);",
    "        }",
    "        gl.uniform1f(u.u_mode, 2);",
    "        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibF); gl.drawElements(gl.POINTS, o.geo.front.length, gl.UNSIGNED_SHORT, 0);",
  ].join("\n"),
  [
    "        if (S.fstyle !== \"cur\") {",
    "          gl.useProgram(progF.p);",
    "          FV3.drawGL(gl, progF, fvGeo(HEADS[h.head].p), h, FVEC[h.row], cw, ch, 1, dpr, S.cssH, false, S.light > 0.5);",
    "          gl.useProgram(progW.p);",
    "          continue;",
    "        }",
    "        if (o.segN) {",
    "          gl.bindVertexArray(o.segVao); gl.uniform1f(u.u_mode, 3);",
    "          gl.drawArrays(gl.POINTS, 0, o.segN);",
    "          gl.bindVertexArray(o.vao);",
    "        }",
    "        gl.uniform1f(u.u_mode, 2);",
    "        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.ibF); gl.drawElements(gl.POINTS, o.geo.front.length, gl.UNSIGNED_SHORT, 0);",
  ].join("\n"));

// 6. 2D draw: the same face layer
patch("2d-o", "        o2.ind = i === 0 ? S.ind : null;", "        o2.ind = i === 0 ? S.ind : null;\n        o2.fv = S.fstyle !== \"cur\" ? FVEC[h.row] : null;");
patch("2d-head",
  "    // the lit face: glow, strokes, dots\n",
  "    if (o.fv) { FV3.draw2d(g, o, cyw, syw, ct, stt, R, fade); return; }\n    // the lit face: glow, strokes, dots\n");

// 7. thumbnails
patch("thumb-w",
  "    var w8 = new Uint8Array(NF);\n    weights(an, w8, 0, fo.face === \"speak\" ? 0.6 : 0);\n    var r = Math.min(w, h) * 0.3, cfg = HEADS[head] || HEADS.cap;",
  [
    "    var w8 = new Uint8Array(NF), fst = FV3.style(o.faceStyle), r = Math.min(w, h) * 0.3, cfg = HEADS[head] || HEADS.cap, fvv = null;",
    "    if (fst === \"cur\") weights(an, w8, 0, fo.face === \"speak\" ? 0.6 : 0);",
    "    else { fvv = new Float32Array(FV3.N); FV3.vec(fst, an, r, dpr, 0.6, null, fvv, w8, 0); }",
  ].join("\n"));
patch("thumb-fv", "      rimK: o.light ? 0.035 : 0.26,", "      fv: fvv, rimK: o.light ? 0.035 : 0.26,");

// 8. the API
patch("api",
  "      setHead: function (id) {",
  [
    "      /** The prototype: the face's look, \"a\" | \"b\" | \"c\" | \"cur\". */",
    "      faceStyle: function (st) { if (st == null) return S.fstyle; S.fstyle = FV3.style(st); redrawIfIdle(); return S.fstyle; },",
    "      setHead: function (id) {",
  ].join("\n"));
patch("export", "    create: create, thumb: thumb,", "    FV3: FV3, create: create, thumb: thumb,");

s = "/* GENERATED by mockups/bot-face-v3/build-proto.cjs from dashboard/public/mint-core-bot.js + face-v3.js -- a prototype, not shipped */\n" + s;
fs.writeFileSync(path.join(__dirname, "proto-core-bot.js"), s);
console.log("wrote proto-core-bot.js (" + s.length + " bytes)");
