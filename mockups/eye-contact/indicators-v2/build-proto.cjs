#!/usr/bin/env node
"use strict";
/**
 * Look and speak indications v2 (2026-10-21, options for the user to pick -- NOT shipped): a prototype of core E
 * built from the real renderer (dashboard/public/mint-core-bot.js) with three ways to show look and speak drawn in
 * the bot's own language, switched by core.indicate({ mode, phase, arm }):
 *
 *   mode "a"  the bot itself: the head's own grid nodes along its edge light up clockwise as the look is held
 *             (arming), all of them when ready (the eyes go wide, one nod), they pulse with your voice while it
 *             listens, dim and blink slowly while a reply is paused
 *   mode "b"  a thin orbit of dots round the head, the wireframe's dot style: fills clockwise while arming,
 *             breathes when ready, ripples with your voice while listening, a sparse slow turn while paused
 *   mode "c"  the headphones' pads light (the accessory): rising while arming, steady when ready, pulsing with
 *             your voice while listening, a slow blink while paused; the face only brightens
 *   phase     "arming" (arm 0..1) | "ready" | "listening" | "paused" | null
 *
 *     node mockups/eye-contact/indicators-v2/build-proto.cjs   -> proto-core-bot.js next to this file
 *
 * Every patch is a literal string replacement that must match once: if the renderer changes, this says where.
 */
const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "..", "..", "..", "dashboard", "public", "mint-core-bot.js");
let s = fs.readFileSync(SRC, "utf8");
function patch(name, from, to) {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error("patch " + name + ": expected 1 match, found " + n);
  s = s.replace(from, to);
}

// 1. the shader: options a (the head's edge nodes) and c (the headphone pads, kind 9)
patch("uniforms",
  '"uniform float u_r,u_fs,u_sc,u_yaw,u_tilt,u_form,u_dis,u_row,u_wa,u_lit,u_alpha,u_mode,u_psz,u_jsz,u_lsz,u_gsz,u_shimX,u_shimA,u_maxPt,u_snap,u_segK;",',
  '"uniform float u_r,u_fs,u_sc,u_yaw,u_tilt,u_form,u_dis,u_row,u_wa,u_lit,u_alpha,u_mode,u_psz,u_jsz,u_lsz,u_gsz,u_shimX,u_shimA,u_maxPt,u_snap,u_segK;",\n    "uniform float u_ind,u_arm,u_indA;",');
patch("shader-ind",
  '    " a*=vis*u_alpha;",',
  [
    '    " if(u_ind>0.5&&u_ind<1.5&&u_mode>0.5&&u_mode<1.5&&kind==0){",', // a: the head's own nodes along its edge
    // the front face's outer rows of nodes (head space, so the order round it holds as the head turns)
    '    "  float e=max(abs(p.x),abs(p.y)/0.98); float rim=smoothstep(0.7,0.86,e)*step(0.25,p.z);",',
    '    "  float f=fract(atan(p.x,p.y)/6.2831853+1.0);",',
    '    "  float on=clamp((u_arm-f)*40.0,0.0,1.0); float lead=u_arm<0.999?exp(-pow((u_arm-f)*16.0,2.0)):0.0;",',
    '    "  float k=rim*(on*u_indA+lead*0.9);",',
    '    "  a=max(a,k); col=mix(col,u_st,clamp(k*1.5,0.0,1.0)); size*=1.0+1.2*k; if(lead*rim>0.45) v_j=1.0;",',
    '    " }",',
    '    " if(u_ind>1.5&&kind==9){ float k=u_indA;",', // c: the headphones' pads
    '    "  if(u_mode<0.5){ a=max(a,0.9*k); col=mix(col,u_st,clamp(k*1.3,0.0,1.0)); }",',
    '    "  else if(u_mode<1.5){ a=max(a,k); col=mix(col,u_st,clamp(k*1.3,0.0,1.0)); size*=1.0+1.4*k; } }",',
    '    " a*=vis*u_alpha;",',
  ].join("\n"));
// the headphones' outer pad ring is its own kind (9): drawn as any accessory line until it lights
patch("cup-kind",
  "return [x + side * (len + 0.06 * Math.sin(v * PI)), y + Math.sin(a) * r * (0.55 + 0.1 * v), z + Math.cos(a) * r * (0.55 + 0.1 * v)]; }, 40, 3);",
  "return [x + side * (len + 0.06 * Math.sin(v * PI)), y + Math.sin(a) * r * (0.55 + 0.1 * v), z + Math.cos(a) * r * (0.55 + 0.1 * v)]; }, 40, 3, { kind: 9 });");

// 2. option b: an orbit of dots (its own small program, the wireframe's point shader)
patch("orbit-vs",
  "  /* ------------------------------------------------------------ Canvas 2D (the fallback, and the thumbnails) */",
  [
    "  var ORB_N = 64;",
    "  var ORB_VS = [",
    '    "#version 300 es",',
    '    "precision highp float;",',
    '    "uniform vec2 u_res,u_c; uniform float u_r,u_arm,u_k,u_t,u_amp,u_psz,u_ph,u_n; uniform vec3 u_st,u_wire;",',
    '    "out vec4 v_c; out float v_j;",',
    '    "void main(){ float fi=float(gl_VertexID); float f=fi/u_n; float ang=f*6.2831853+(u_ph>3.5?u_t*0.25:0.0);",',
    '    " float rr=1.0+(u_ph>2.5&&u_ph<3.5?0.045*u_amp*sin(ang*5.0-u_t*7.0)+0.02*u_amp:0.0);",',
    '    " vec2 q=vec2(sin(ang),cos(ang))*rr;",',
    '    " float on=u_ph<1.5?clamp((u_arm-f)*u_n,0.0,1.0):(u_ph>3.5?(mod(fi,4.0)<0.5?1.0:0.0):1.0);",',
    '    " float lead=(u_ph<1.5&&abs(u_arm-f)<1.0/u_n&&u_arm<0.999)?1.0:0.0;",',
    '    " float a=0.2*(1.0-on)+on*u_k; v_j=lead;",',
    '    " vec3 col=mix(u_wire,u_st,on);",',
    '    " v_c=vec4(col,clamp(a,0.0,1.0));",',
    '    " vec2 px=u_c+q*u_r; gl_Position=a<0.003?vec4(2.0,2.0,0.0,1.0):vec4(px/u_res*2.0-1.0,0.0,1.0);",',
    '    " gl_PointSize=u_psz*(1.0+0.7*on+0.8*lead); }",',
    "  ].join(\"\\n\");",
    "",
    "  /* ------------------------------------------------------------ Canvas 2D (the fallback, and the thumbnails) */",
  ].join("\n"));
patch("orbit-prog",
  "progZ = prog(ZZZ_VS, WIRE_FS);",
  "progZ = prog(ZZZ_VS, WIRE_FS); progO = prog(ORB_VS, WIRE_FS);");
patch("orbit-var",
  "var progW = null, progQ = null,",
  "var progO = null, progW = null, progQ = null,");

// 3. per frame: the indication's strength, the faces it asks for, the amp
patch("state",
  "      presence: null, contact: null, lookUpUntil: 0,\n    };",
  "      presence: null, contact: null, lookUpUntil: 0,\n      ind: null, // the prototype's indication { mode, phase, arm, k }\n    };");
patch("amp",
  "      var real = talking && ampFn ? ampFn(S.state) : null;",
  "      var real = S.ind && S.ind.phase === \"paused\" ? 0 : talking && ampFn && !(S.ind && S.ind.phase) ? ampFn(S.state) : null;");
patch("face",
  "      var fo = pickFace(S.state, S.offline, S.rk, dz);",
  [
    "      var fo = pickFace(S.state, S.offline, S.rk, dz);",
    "      var IND = S.ind;",
    "      if (IND && IND.phase) {",
    "        var ph = IND.phase, br = S.still ? 0.5 : 0.5 + 0.5 * Math.sin(S.t * 2.4);",
    "        IND.k = ph === \"arming\" ? 0.9 : ph === \"ready\" ? 0.62 + 0.3 * br : ph === \"listening\" ? 0.45 + 0.55 * Math.min(1, S.amp * 1.7) : 0.22 + 0.3 * (S.still ? 1 : Math.max(0, Math.sin(S.t * 2.2)));",
    "        if (IND.mode === \"c\" && ph === \"arming\") IND.k = 0.15 + 0.75 * IND.arm * (S.still ? 1 : 0.85 + 0.15 * Math.sin(S.t * 18));",
    "        // a: the face says it -- wide eyes when ready; looking at you, waiting, while a reply is paused",
    "        if (IND.mode === \"a\" && ph === \"ready\" && S.state === \"idle\" && !S.rk) fo = { face: \"listen\", state: \"ready\" };",
    "        if (IND.mode === \"a\" && ph === \"paused\") fo = { face: \"pupils\", state: fo.state };",
    "      }",
  ].join("\n"));
patch("lit",
  "      h.lit = (1 + 0.3 * W.listen * S.amp)",
  "      h.lit = (IND && IND.phase === \"arming\" && IND.mode !== \"b\" ? 1 + 0.3 * IND.arm : IND && IND.phase === \"ready\" && IND.mode === \"c\" ? 1.15 : 1) * (1 + 0.3 * W.listen * S.amp)");

// 4. drawing: the uniforms for a / c on the core only, the orbit after the heads
patch("glow-ind-off",
  "        gl.uniform1f(u.u_pt, 1); gl.uniform1f(u.u_soft, 1); gl.uniform1f(u.u_mode, 4);",
  "        gl.uniform1f(u.u_pt, 1); gl.uniform1f(u.u_soft, 1); gl.uniform1f(u.u_mode, 4); if (u.u_ind) gl.uniform1f(u.u_ind, 0);");
patch("heads-ind",
  "        setHeadU(u, h, 1, dpr, home);\n        gl.bindVertexArray(o.vao);",
  [
    "        setHeadU(u, h, 1, dpr, home);",
    "        var hi_ = i === 0 && S.ind && S.ind.phase ? S.ind : null;",
    "        if (u.u_ind) gl.uniform1f(u.u_ind, hi_ && hi_.mode === \"a\" ? 1 : hi_ && hi_.mode === \"c\" ? 2 : 0);",
    "        if (u.u_arm) gl.uniform1f(u.u_arm, hi_ ? (hi_.phase === \"arming\" ? hi_.arm : 1) : 0);",
    "        if (u.u_indA) gl.uniform1f(u.u_indA, hi_ ? hi_.k : 0);",
    "        gl.bindVertexArray(o.vao);",
  ].join("\n"));
patch("orbit-draw",
  "      // 4. dozing: the z z z",
  [
    "      // the prototype's option b: the orbit",
    "      if (S.ind && S.ind.mode === \"b\" && S.ind.phase && progO) {",
    "        var c0o = POOL[0], po = S.ind.phase;",
    "        gl.useProgram(progO.p); u = progO.u; gl.bindVertexArray(emptyVao);",
    "        gl.uniform2f(u.u_res, cw, ch); gl.uniform2f(u.u_c, c0o.cx * dpr, (S.cssH - c0o.cy) * dpr); gl.uniform1f(u.u_r, c0o.r * dpr * 1.5 * c0o.sc);",
    "        gl.uniform1f(u.u_arm, po === \"arming\" ? S.ind.arm : 1); gl.uniform1f(u.u_k, S.ind.k); gl.uniform1f(u.u_t, S.still ? 0 : S.t); gl.uniform1f(u.u_amp, S.amp);",
    "        gl.uniform1f(u.u_ph, po === \"arming\" ? 1 : po === \"ready\" ? 2 : po === \"listening\" ? 3 : 4); gl.uniform1f(u.u_n, ORB_N);",
    "        gl.uniform1f(u.u_psz, Math.max(2, 0.03 * c0o.cssR * dpr));",
    "        gl.uniform3f(u.u_st, c0o.st[0] / 255, c0o.st[1] / 255, c0o.st[2] / 255); gl.uniform3f(u.u_wire, pal.wire[0] / 255, pal.wire[1] / 255, pal.wire[2] / 255);",
    "        gl.uniform1f(u.u_pt, 1); gl.uniform1f(u.u_soft, 0); gl.uniform1f(u.u_sq, 0); gl.uniform1f(u.u_mode, 1);",
    "        gl.drawArrays(gl.POINTS, 0, ORB_N);",
    "      }",
    "      // 4. dozing: the z z z",
  ].join("\n"));

// 5. the API
patch("api",
  "      setHead: function (id) {",
  [
    "      /** The prototype: indicate({ mode: 'a'|'b'|'c', phase: 'arming'|'ready'|'listening'|'paused'|null, arm: 0..1 }). */",
    "      indicate: function (o) {",
    "        o = o || {};",
    "        var was = S.ind ? S.ind.phase : null;",
    "        S.ind = o.phase ? { mode: o.mode || \"a\", phase: o.phase, arm: Math.max(0, Math.min(1, +o.arm || 0)), k: 0 } : null;",
    "        if (S.ind && S.ind.mode === \"a\" && o.phase === \"ready\" && was !== \"ready\" && !o.noNod) react(\"nod\");",
    "        redrawIfIdle();",
    "      },",
    "      setHead: function (id) {",
  ].join("\n"));

s = "/* GENERATED by mockups/eye-contact/indicators-v2/build-proto.cjs from dashboard/public/mint-core-bot.js -- a prototype, not shipped */\n" + s;
fs.writeFileSync(path.join(__dirname, "proto-core-bot.js"), s);
console.log("wrote proto-core-bot.js (" + s.length + " bytes)");
