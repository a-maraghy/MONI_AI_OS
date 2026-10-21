#!/usr/bin/env node
"use strict";
/**
 * Frame cost of the face options (bot face v3, 2026-10-21): the shipped renderer, then the prototype with each
 * face style, in headless Chromium (SwiftShader), the same scene as dashboard/tools/bench-bot-core.cjs: one 1920 x 1080
 * canvas, the core (R 260) plus six session heads drifting round it, idle / thinking / speaking (with a spectrum),
 * 4 s each. Reports the median / p95 JavaScript cost per frame (prepare + draw submission) and the frame rate
 * (SwiftShader rasterises on the CPU, so a heavier fragment shader shows up there, not in the JS cost).
 *
 *     PLAYWRIGHT=/root/e2e/pw/node_modules/playwright node mockups/bot-face-v3/bench.cjs [--2d]
 */
const path = require("path");
const fs = require("fs");
const PUB = path.join(__dirname, "..", "..", "dashboard", "public");
const FORCE2D = process.argv.includes("--2d");

async function bench(browser, src, style, label) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.setContent("<!doctype html><html><body style='margin:0;background:#0D1117'><canvas id='c' style='position:fixed;inset:0;width:1920px;height:1080px'></canvas></body></html>");
  await page.addScriptTag({ content: fs.readFileSync(path.join(PUB, "cc-logic.js"), "utf8") });
  await page.addScriptTag({ content: src });
  const out = await page.evaluate(async ([force2d, style]) => {
    const cv = document.getElementById("c");
    const kids = [];
    for (let i = 0; i < 6; i++) kids.push({ key: "k" + i, x: 0, y: 0, r: 34, st: ["working", "idle", "waiting", "idle", "working", "idle"][i], form: 1, dis: 0, alpha: 1, head: ["headset", "mortar", "cap", "antennas", "headphones", "headphones"][i] });
    const t0 = performance.now(), bins = new Uint8Array(256);
    const core = window.MintCoreBot(cv, {
      noGuard: true, force2d, head: "cap", faceStyle: style || undefined, amp: () => 0.5,
      spec: () => { const ph = Math.floor(performance.now() / 200) % 3; for (let i = 0; i < 256; i++) bins[i] = (ph === 0 ? i > 1 && i < 6 : ph === 1 ? i > 6 && i < 19 : i > 21 && i < 90) ? 220 : 40; return { bins, hz: 93.75 }; },
      kids: () => { const t = (performance.now() - t0) / 1000; kids.forEach((k, i) => { const a = i / 6 * 6.283 + t * 0.05; k.x = 960 + Math.cos(a) * 520; k.y = 540 + Math.sin(a) * 330; }); return kids; },
    });
    core.resize(960, 540, 260, 1920, 1080);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const res = {};
    if (force2d) {
      // 2D: SwiftShader's accelerated 2D canvas wedges the compositor after a few seconds (the shipped renderer
      // too), so no frame loop: core.tick() timed directly -- prepare + draw, the same figure stats() gives
      for (const st of ["idle", "thinking", "speaking"]) {
        core.setState(st); for (let i = 0; i < 30; i++) core.tick(1 / 60);
        const t = []; for (let i = 0; i < 120; i++) { const t0 = performance.now(); core.tick(1 / 60); t.push(performance.now() - t0); }
        t.sort((a, b) => a - b); res[st] = { med: +t[60].toFixed(2), p95: +t[114].toFixed(2), fps: 0 };
      }
      core.destroy();
      return res;
    }
    core.start();
    for (const st of ["idle", "thinking", "speaking"]) {
      core.setState(st); await wait(1000); core.resetStats(); await wait(4000);
      const s = core.stats(); res[st] = s ? { med: +s.cpuMed.toFixed(2), p95: +s.cpuP95.toFixed(2), fps: +s.fps.toFixed(1) } : { frames: core.S.frames.length, running: core.S.running, gl: core.isGL, w: core.canvas.width };
    }
    core.destroy();
    return res;
  }, [FORCE2D, style]);
  await ctx.close();
  return { label, out, errs };
}

(async () => {
  require(path.join(__dirname, "build-proto.cjs"));
  const { chromium } = require(process.env.PLAYWRIGHT || "/root/e2e/pw/node_modules/playwright");
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const shipped = fs.readFileSync(path.join(PUB, "mint-core-bot.js"), "utf8"), proto = fs.readFileSync(path.join(__dirname, "proto-core-bot.js"), "utf8");
  try {
    const runs = [];
    runs.push(await bench(browser, shipped, null, "shipped"));
    for (const st of ["cur", "a", "b", "c"]) runs.push(await bench(browser, proto, st, "proto " + st));
    runs.push(await bench(browser, shipped, null, "shipped again"));
    for (const r of runs) console.log(r.label.padEnd(14), JSON.stringify(r.out), r.errs.length ? "ERR " + r.errs.join(" | ") : "");
    fs.writeFileSync(path.join(__dirname, FORCE2D ? "bench-2d.json" : "bench.json"), JSON.stringify({ at: new Date().toISOString(), force2d: FORCE2D, runs }, null, 1));
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
