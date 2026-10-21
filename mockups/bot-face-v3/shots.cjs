#!/usr/bin/env node
"use strict";
/**
 * Bot face v3 -- three professional face options for core E, rendered with the real renderer (the prototype built
 * from it by build-proto.cjs). 2026-10-21, NOT shipped. Writes, next to this file:
 *   stills/<style>-<size>-<theme>.png   every expression at one size and theme (style: cur | a | b | c)
 *   presets-<style>-<theme>.png          the five colour presets x six states
 *   thumbs-<theme>.png                   Settings thumbnails (MintBot.thumb, 2D) and the 2D fallback, every style
 *   <style>-companion.gif / <style>-core.gif   the sequence: idle, listening, thinking, speaking, needs you, arming -> ready
 *   compare-companion.png, compare-desk.png    current vs A / B / C at the companion size over a dark landscape
 *   index.html                           the contact sheet
 *
 *     PLAYWRIGHT=/root/e2e/pw/node_modules/playwright node mockups/bot-face-v3/shots.cjs [--only=stills,gifs,...]
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const OUT = __dirname;
const ROOT = path.join(OUT, "..", "..");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const ARG = (k) => (process.argv.find((a) => a.startsWith("--" + k + "=")) || "").slice(k.length + 3).split(",").filter(Boolean);
const STYLES = ["cur", "a", "b", "c"];
const STYLE_NAME = { cur: "Current (shipped)", a: "A · Smooth glyphs", b: "B · Refined dot matrix", c: "C · Minimal" };
const SIZES = [
  { id: "core", r: 150, dpr: 1, desk: false, name: "Command Center core · ~300 px · 100 %" },
  { id: "companion", r: 39.9, dpr: 1.5, desk: true, name: "Companion · ~80 px · 150 % (the user's)" },
  { id: "session", r: 25, dpr: 2, desk: false, name: "Session head · ~50 px · 200 %" },
  { id: "dock", r: 14, dpr: 1.5, desk: false, name: "Dock / small · ~28 px · 150 %" },
];
const EXPRS = [
  ["idle", "idle / base"], ["listening", "listening"], ["thinking", "thinking"], ["speak-open", "speaking · open"], ["speak-wide", "speaking · ee"], ["speak-round", "speaking · oo"],
  ["needs", "needs you"], ["error", "error"], ["sleep", "sleep / doze"], ["grin", "grin"], ["nod", "nod"], ["shake", "headshake"],
  ["arming", "L&S arming"], ["ready", "L&S ready"], ["ls-listening", "L&S listening"], ["paused", "L&S paused"],
];

/* ------------------------------------------------------------ the page side */
function pageLib() {
  /* eslint-disable no-undef */
  const W = (window.__drv = { amp: 0, spec: null });
  const BINS = new Uint8Array(256);
  function specFor(kind) {
    for (let i = 0; i < 256; i++) BINS[i] = 40;
    const R = kind === "round" ? [2, 6] : kind === "open" ? [7, 19] : kind === "wide" ? [22, 90] : null;
    if (R) for (let i = R[0]; i < R[1]; i++) BINS[i] = 220;
    return { bins: BINS, hz: 93.75 };
  }
  window.__specFor = specFor;
  function mk(o) {
    const cv = document.createElement("canvas");
    cv.style.cssText = "position:absolute;left:0;top:0;width:" + o.w + "px;height:" + o.h + "px";
    document.body.appendChild(cv);
    const core = window.MintCoreBot(cv, {
      noGuard: true, preserve: true, head: o.head || "headphones", colors: o.colors ? window.MintLogic.normBotColors(o.colors) : null, desk: !!o.desk, backdrop: "glow",
      faceStyle: o.style, force2d: !!o.force2d, kids: () => [], amp: () => W.amp, spec: () => W.spec,
    });
    const R = o.r / 0.57;
    core.resize(o.w / 2, o.h / 2 + 0.15 * o.r - 0.12 * R, R, o.w, o.h);
    if (o.light) core.setLight(true, true);
    const A = core._anim(); A.blinkAt = 1e9; A.glanceAt = 1e9;
    return { core, cv };
  }
  function ticks(core, s) { const n = Math.round(s * 60); for (let i = 0; i < n; i++) { core.S.actAt = core.S.dozeT ? core.S.actAt : Date.now(); core.tick(1 / 60); } }
  function expr(core, name) {
    W.amp = 0; W.spec = null;
    const S = core.S;
    if (name === "listening") { core.setState("listening"); W.amp = 0.5; }
    else if (name === "thinking") core.setState("thinking");
    else if (name.startsWith("speak-")) { core.setState("speaking"); W.amp = 0.75; W.spec = specFor(name.slice(6)); }
    else if (name === "needs") core.setState("needs");
    else if (name === "error") core.setOffline(true);
    else if (name === "sleep") { S.actAt = Date.now() - 3600e3; S.dozeT = 1; S.doze = 1; }
    else if (name === "arming") core.indicate({ phase: "arming", arm: 0.55 });
    else if (name === "ready") { core.indicate({ phase: "arming", arm: 0.95 }); }
    else if (name === "ls-listening") { core.setState("listening"); W.amp = 0.5; core.indicate({ phase: "listening" }); }
    else if (name === "paused") { core.setState("speaking"); core.indicate({ phase: "paused" }); }
    ticks(core, 1.2);
    if (name === "ready") { core.indicate({ phase: "ready" }); ticks(core, 1.1); }
    if (name === "grin") { core.react("grin"); ticks(core, 0.45); }
    if (name === "nod") { core.react("nod"); ticks(core, 0.3); }
    if (name === "shake") { core.react("shake"); ticks(core, 0.1); }
    S.t = 6.87; // the sway's zero: every still at the same pose
    core.tick(0.0001);
  }
  window.__strip = function (o) {
    // o: { style, r, dpr, desk, light, exprs: [[id,label]], cols, head, colors, rowsLabels }
    const dpr = window.devicePixelRatio;
    const cw = Math.round(Math.max(o.r * (o.desk ? 3.9 : 3.4), 96)), chh = Math.round(o.r * (o.desk ? 3.9 : 3.2)), lab = 18;
    const cols = o.cols || o.exprs.length, rows = Math.ceil(o.exprs.length / cols);
    const out = document.createElement("canvas"); out.width = cw * cols * dpr; out.height = (chh + lab) * rows * dpr;
    const g = out.getContext("2d"); g.scale(dpr, dpr);
    g.fillStyle = o.light ? "#F8FAFC" : "#0D1117"; g.fillRect(0, 0, cw * cols, (chh + lab) * rows);
    o.exprs.forEach((e, i) => {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * (chh + lab);
      const m = mk({ style: e[2] || o.style, r: o.r, w: cw, h: chh, desk: o.desk, light: o.light, head: o.head, colors: e[3] || o.colors, force2d: o.force2d });
      expr(m.core, e[0]);
      g.drawImage(m.cv, x, y, cw, chh);
      m.core.destroy(); m.cv.remove();
      g.fillStyle = o.light ? "#475569" : "#94A3B8"; g.font = "11px system-ui, sans-serif"; g.textAlign = "center";
      g.fillText(e[1], x + cw / 2, y + chh + 12);
    });
    return out.toDataURL("image/png");
  };
  window.__thumbs = function (o) {
    const dpr = window.devicePixelRatio, states = ["idle", "listening", "thinking", "speaking", "needs"], cw = 96, ch = 96, lab = 16;
    const out = document.createElement("canvas"); out.width = cw * states.length * dpr; out.height = (ch + lab) * dpr;
    const g = out.getContext("2d"); g.scale(dpr, dpr); g.fillStyle = o.light ? "#F8FAFC" : "#0D1117"; g.fillRect(0, 0, cw * states.length, ch + lab);
    states.forEach((st, i) => {
      const cv = document.createElement("canvas"); cv.style.width = cw + "px"; cv.style.height = ch + "px";
      window.MintBot.thumb(cv, "headphones", { state: st, light: o.light, w: 84, h: 84, faceStyle: o.style });
      g.drawImage(cv, i * cw + 6, 6, 84, 84);
      g.fillStyle = o.light ? "#475569" : "#94A3B8"; g.font = "11px system-ui, sans-serif"; g.textAlign = "center"; g.fillText(st, i * cw + cw / 2, ch + 10);
    });
    return out.toDataURL("image/png");
  };
  /* a dark sky over mountains (a stand-in for the user's wallpaper) */
  function rnd(s) { return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }
  window.__wall = function (w, h) {
    const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d");
    const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#0b2a4a"); sky.addColorStop(0.55, "#1d4f78"); sky.addColorStop(0.8, "#6f8fa8"); sky.addColorStop(1, "#8aa0b0");
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    const r = rnd(7);
    for (let i = 0; i < 60; i++) { g.fillStyle = "rgba(255,255,255," + (0.15 + 0.4 * r()) + ")"; g.fillRect(r() * w, r() * h * 0.4, 1, 1); }
    function ridge(base, amp, col, seed, rough) {
      const rr = rnd(seed); let y = base, pts = [];
      for (let x = 0; x <= w; x += 4) { y += (rr() - 0.5) * rough; y = Math.max(base - amp, Math.min(base + amp * 0.3, y)); pts.push([x, y - amp * 0.6 * Math.exp(-Math.pow((x - w * (0.3 + 0.4 * ((seed * 0.37) % 1))) / (w * 0.18), 2))]); }
      g.beginPath(); g.moveTo(0, h); pts.forEach((p) => g.lineTo(p[0], p[1])); g.lineTo(w, h); g.closePath(); g.fillStyle = col; g.fill();
    }
    ridge(h * 0.72, h * 0.22, "#3b4a55", 11, 7);
    ridge(h * 0.82, h * 0.3, "#252d33", 23, 9);
    ridge(h * 0.95, h * 0.25, "#151a1e", 5, 11);
    const tx = rnd(3); g.globalAlpha = 0.07; for (let i = 0; i < 900; i++) { g.fillStyle = tx() < 0.5 ? "#fff" : "#000"; g.fillRect(tx() * w, h * 0.65 + tx() * h * 0.35, 2, 1); } g.globalAlpha = 1;
    return c;
  };
  window.__compare = function (o) {
    // columns: styles; rows: expressions; each cell over the same crop of the wallpaper (desk mode, dark)
    const dpr = window.devicePixelRatio, cw = Math.round(o.r * 4.2), ch = Math.round(o.r * 3.9), head = 22, lab = 16;
    const cols = o.styles.length, rows = o.exprs.length;
    const out = document.createElement("canvas"); out.width = cw * cols * dpr; out.height = (head + rows * (ch + lab)) * dpr;
    const g = out.getContext("2d"); g.scale(dpr, dpr); g.fillStyle = "#0b1016"; g.fillRect(0, 0, cw * cols, head + rows * (ch + lab));
    const wall = window.__wall(Math.round(cw * dpr * 3), Math.round(ch * dpr * 3));
    o.styles.forEach((st, ci) => {
      g.fillStyle = "#cbd5e1"; g.font = "600 12px system-ui, sans-serif"; g.textAlign = "center"; g.fillText(o.names[st], ci * cw + cw / 2, 15);
      o.exprs.forEach((e, ri) => {
        const x = ci * cw, y = head + ri * (ch + lab);
        g.drawImage(wall, wall.width * 0.36, wall.height * 0.12, cw * dpr, ch * dpr, x, y, cw, ch);
        const m = mk({ style: st, r: o.r, w: cw, h: ch, desk: true, light: false, head: o.head });
        expr(m.core, e[0]); g.drawImage(m.cv, x, y, cw, ch); m.core.destroy(); m.cv.remove();
        g.fillStyle = "#94A3B8"; g.font = "11px system-ui, sans-serif"; g.fillText(e[1], x + cw / 2, y + ch + 12);
      });
    });
    return out.toDataURL("image/png");
  };
  window.__desk = function (o) {
    // one wide wallpaper, the four companions at the top like the user's screenshot
    const dpr = window.devicePixelRatio, W = 980, H = 300, wall = window.__wall(Math.round(W * dpr), Math.round(H * dpr));
    const out = document.createElement("canvas"); out.width = W * dpr; out.height = H * dpr; const g = out.getContext("2d"); g.scale(dpr, dpr);
    g.drawImage(wall, 0, 0, W, H);
    const cw = 176, ch = 160;
    o.styles.forEach((st, i) => {
      const x = 40 + i * 240, y = 4;
      const m = mk({ style: st, r: o.r, w: cw, h: ch, desk: true, light: false, head: o.head });
      expr(m.core, o.expr || "idle"); g.drawImage(m.cv, x, y, cw, ch); m.core.destroy(); m.cv.remove();
      g.font = "600 11px system-ui, sans-serif"; const tw = g.measureText(o.names[st]).width + 20;
      g.fillStyle = "rgba(10,14,20,.6)"; g.fillRect(x + cw / 2 - tw / 2, y + ch + 2, tw, 20);
      g.fillStyle = "#e2e8f0"; g.textAlign = "center"; g.fillText(o.names[st], x + cw / 2, y + ch + 16);
    });
    return out.toDataURL("image/png");
  };
  /* the GIF: a timeline; returns one frame (dataURL) per call to __gifStep */
  window.__gifStart = function (o) {
    const dpr = window.devicePixelRatio, cw = Math.round(o.r * (o.desk ? 4.2 : 3.4)), ch = Math.round(o.r * (o.desk ? 3.9 : 3.2));
    const m = mk({ style: o.style, r: o.r, w: cw, h: ch, desk: o.desk, light: o.light, head: o.head });
    const A = m.core._anim(); A.blinkAt = 1.2; // blinks as it would
    const out = document.createElement("canvas"); out.width = cw * dpr; out.height = (ch + 18) * dpr; const g = out.getContext("2d"); g.scale(dpr, dpr);
    const wall = o.desk ? window.__wall(Math.round(cw * dpr * 3), Math.round(ch * dpr * 3)) : null;
    const T = [[0, "idle", "ready"], [1.8, "listening", "listening"], [3.8, "thinking", "thinking"], [5.8, "speaking", "speaking"], [9.2, "needs", "needs you"], [11.2, "arming", "look and speak: arming"], [12.4, "ready", "ready"], [14.2, "end"]];
    let t = 0, idx = -1;
    const seq = ["round", "open", "wide", "open", "closed", "wide", "round", "open", "open", "wide", "closed", "round"];
    window.__gifStep = function (dt) {
      while (idx + 1 < T.length && T[idx + 1][0] <= t) {
        idx++; const k = T[idx][1];
        if (k === "end") return null;
        m.core.indicate(null);
        if (k === "arming") { m.core.setState("idle"); m.core.indicate({ phase: "arming", arm: 0, armMs: 1100 }); }
        else if (k === "ready") m.core.indicate({ phase: "ready" });
        else m.core.setState(k);
      }
      const st = T[idx][1];
      W.amp = st === "listening" ? 0.25 + 0.5 * Math.abs(Math.sin(t * 5.3) * Math.sin(t * 1.7)) : st === "speaking" ? 0.35 + 0.55 * Math.abs(Math.sin(t * 6.1)) : 0;
      const ph = seq[Math.floor(t / 0.16) % seq.length];
      W.spec = st === "speaking" ? specFor(ph) : null;
      if (st === "speaking" && ph === "closed") W.amp = 0.05;
      m.core.tick(dt); t += dt;
      g.clearRect(0, 0, cw, ch + 18);
      if (wall) g.drawImage(wall, wall.width * 0.36, wall.height * 0.12, cw * dpr, (ch + 18) * dpr, 0, 0, cw, ch + 18);
      else { g.fillStyle = o.light ? "#F8FAFC" : "#0D1117"; g.fillRect(0, 0, cw, ch + 18); }
      g.drawImage(m.cv, 0, 0, cw, ch);
      g.fillStyle = o.desk ? "#e2e8f0" : o.light ? "#475569" : "#94A3B8"; g.font = "11px system-ui, sans-serif"; g.textAlign = "center"; g.fillText(T[idx][2], cw / 2, ch + 12);
      return out.toDataURL("image/png");
    };
    return true;
  };
}

(async () => {
  spawnSync(process.execPath, [path.join(OUT, "build-proto.cjs")], { stdio: "inherit" });
  const proto = fs.readFileSync(path.join(OUT, "proto-core-bot.js"), "utf8");
  const logic = fs.readFileSync(path.join(ROOT, "dashboard", "public", "cc-logic.js"), "utf8");
  const { chromium } = require(process.env.PLAYWRIGHT || "/root/e2e/pw/node_modules/playwright");
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const errs = [];
  const pages = {};
  async function pageAt(dpr) {
    if (pages[dpr]) return pages[dpr];
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
    await page.setContent("<!doctype html><html><body style='margin:0;background:#000'></body></html>");
    await page.addScriptTag({ content: logic });
    await page.addScriptTag({ content: proto });
    await page.evaluate(pageLib);
    return (pages[dpr] = page);
  }
  const save = (f, url, raw) => {
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(url.split(",")[1], "base64"));
    if (!raw && f.startsWith(OUT + path.sep)) quantise(f); // the stills: 256 colours, a light ordered dither (~5x smaller, no banding)
  };
  function quantise(f) {
    const tmp = f + ".q.png";
    const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", f, "-vf", "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", tmp]);
    if (r.status === 0) fs.renameSync(tmp, f); else if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  try {
    if (want("stills")) {
      for (const sz of SIZES) {
        if (ARG("sizes").length && !ARG("sizes").includes(sz.id)) continue;
        const page = await pageAt(sz.dpr);
        for (const st of STYLES) for (const light of [false, true]) {
          if ((ARG("styles").length && !ARG("styles").includes(st)) || (ARG("themes").length && !ARG("themes").includes(light ? "light" : "dark"))) continue;
          const url = await page.evaluate((o) => window.__strip(o), { style: st, r: sz.r, desk: sz.desk, light, exprs: EXPRS, cols: 8 });
          save(path.join(OUT, "stills", `${st}-${sz.id}-${light ? "light" : "dark"}.png`), url);
        }
        console.log("stills", sz.id);
      }
    }
    if (want("presets")) {
      const page = await pageAt(2);
      const PRE = ["default", "mint", "mono", "ocean", "sunset"], ST = [["idle", "idle"], ["listening", "listening"], ["thinking", "thinking"], ["speak-open", "speaking"], ["needs", "needs you"], ["error", "error"]];
      for (const st of STYLES) for (const light of [false, true]) {
        const exprs = [];
        PRE.forEach((p) => ST.forEach((e) => exprs.push([e[0], (e === ST[0] ? p + " · " : "") + e[1], null, { p }])));
        const url = await page.evaluate((o) => window.__strip(o), { style: st, r: 30, desk: false, light, exprs, cols: 6 });
        save(path.join(OUT, `presets-${st}-${light ? "light" : "dark"}.png`), url);
      }
      console.log("presets");
    }
    if (want("thumbs")) {
      const page = await pageAt(2);
      for (const light of [false, true]) {
        const parts = [];
        for (const st of STYLES) parts.push(await page.evaluate((o) => window.__thumbs(o), { style: st, light }));
        parts.forEach((u, i) => save(path.join(OUT, "stills", `thumbs-${STYLES[i]}-${light ? "light" : "dark"}.png`), u));
        for (const st of STYLES) {
          const url = await page.evaluate((o) => window.__strip(o), { style: st, r: 40, desk: false, light, force2d: true, exprs: [["idle", "2D · idle"], ["speak-open", "2D · speaking"], ["needs", "2D · needs you"], ["sleep", "2D · sleep"], ["error", "2D · error"]], cols: 5 });
          save(path.join(OUT, "stills", `fallback2d-${st}-${light ? "light" : "dark"}.png`), url);
        }
      }
      console.log("thumbs");
    }
    if (want("compare")) {
      const page = await pageAt(1.5);
      const url = await page.evaluate((o) => window.__compare(o), { styles: STYLES, names: STYLE_NAME, r: 39.9, head: "headphones", exprs: [["idle", "idle"], ["listening", "listening"], ["thinking", "thinking"], ["speak-open", "speaking"], ["needs", "needs you"], ["sleep", "sleep"]] });
      save(path.join(OUT, "compare-companion.png"), url);
      save(path.join(OUT, "compare-desk.png"), await page.evaluate((o) => window.__desk(o), { styles: STYLES, names: STYLE_NAME, r: 39.9, head: "headphones" }));
      console.log("compare");
    }
    if (want("gifs")) {
      for (const st of STYLES) for (const kind of ["companion", "core"]) {
        const dpr = kind === "companion" ? 1.5 : 1;
        const page = await pageAt(dpr);
        await page.evaluate((o) => window.__gifStart(o), kind === "companion" ? { style: st, r: 39.9, desk: true, light: false, head: "headphones" } : { style: st, r: 110, desk: false, light: true, head: "headphones" });
        const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "bfv3-"));
        let n = 0;
        for (;;) {
          const url = await page.evaluate(() => window.__gifStep(1 / 20));
          if (!url) break;
          save(path.join(dir, String(n++).padStart(4, "0") + ".png"), url, true);
        }
        const gif = path.join(OUT, `${st}-${kind}.gif`);
        const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "20", "-i", path.join(dir, "%04d.png"), "-vf", kind === "core" ? "scale=iw*0.8:-1:flags=lanczos,fps=12.5,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" : "split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", "-loop", "0", gif]);
        if (ff.status !== 0) console.log("ffmpeg failed " + gif + ": " + String(ff.stderr));
        fs.rmSync(dir, { recursive: true, force: true });
        console.log("gif", st, kind, n + " frames");
      }
    }
  } finally {
    await browser.close();
  }
  if (errs.length) { console.log("PAGE ERRORS:\n" + [...new Set(errs)].join("\n")); process.exitCode = 1; }
})().catch((e) => { console.error(e); process.exit(1); });
