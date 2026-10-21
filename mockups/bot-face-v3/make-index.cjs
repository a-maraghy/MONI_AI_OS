#!/usr/bin/env node
"use strict";
/** The contact sheet for bot face v3 (index.html next to this file), from the files shots.cjs and bench.cjs wrote. */
const fs = require("fs");
const path = require("path");
const D = __dirname;
const ex = (f) => fs.existsSync(path.join(D, f));
const STY = [
  ["cur", "Current (shipped)", "The 18-wide pixel maps lit on the head's 19-node grid; under 40 px radius every other node. What the user saw: blocky eyes with gaps, a broken-bracket mouth. The maps are also off-centre by half a node (18 columns on 19 nodes)."],
  ["a", "A · Smooth glyphs", "Rounded-rectangle eyes and a smooth arc mouth, anti-aliased vector shapes drawn on the head's front surface (they turn and tilt with it), a soft glow. Expressions morph (eyes squash to lids, arcs, an x); the mouth is a rounded D that opens with the voice (open / ee / oo). Reads at every size; the most 'product' look."],
  ["b", "B · Refined dot matrix", "The LED look kept, done properly: the same shapes sampled on a symmetric dot grid whose pitch is picked per device size (40 / 30 / 22 / 16 / 12 dots across), every shape snapped to whole dots, curves one dot per column. Solid eyes, no holes, symmetric at every size; the smallest sizes get their own coarse set (2 x 2 eyes, flat mouth)."],
  ["c", "C · Minimal", "Two soft pills and a thin line. States change shape only a little (taller pills listening, short pills thinking, a dot mouth when it needs you), with a wider calm glow. Quietest on the desktop; the least expressive at the dock size."],
];
const SIZES = [["core", "Command Center core · head ~300 px · 100 %"], ["companion", "Companion · head ~80 px · 150 % (the user's setup)"], ["session", "Session head · ~50 px · 200 %"], ["dock", "Dock / small · ~28 px · 150 %"]];
let bench = "";
if (ex("bench.json")) {
  const B = JSON.parse(fs.readFileSync(path.join(D, "bench.json"), "utf8"));
  const row = (r) => `<tr><td>${r.label}</td>${["idle", "thinking", "speaking"].map((k) => r.out[k] ? `<td>${r.out[k].med} / ${r.out[k].p95} ms${r.out[k].fps ? " · " + r.out[k].fps + " fps" : ""}</td>` : "<td>-</td>").join("")}</tr>`;
  bench = `<table><thead><tr><th>renderer</th><th>idle</th><th>thinking</th><th>speaking</th></tr></thead><tbody>${B.runs.map(row).join("")}</tbody></table>
  <p class="note">JS cost per frame (median / p95, prepare + draw submission) and frame rate, headless Chromium with SwiftShader (CPU rasteriser), 1920 x 1080, the core (R 260) + six session heads, ${B.at.slice(0, 16).replace("T", " ")} UTC. "proto cur" is the prototype drawing the shipped faces.</p>`;
}
if (ex("bench-2d.json")) {
  const B = JSON.parse(fs.readFileSync(path.join(D, "bench-2d.json"), "utf8"));
  bench += `<h3>2D fallback (no WebGL2) · core.tick() timed directly</h3><p class="note">SwiftShader\'s accelerated 2D canvas stops producing frames after a few seconds with seven heads on screen -- the shipped renderer\'s 2D path too -- so the 2D figures are prepare + draw timed in a loop, no frame rate.</p><table><thead><tr><th>renderer</th><th>idle</th><th>thinking</th><th>speaking</th></tr></thead><tbody>${B.runs.map((r) => `<tr><td>${r.label}</td>${["idle", "thinking", "speaking"].map((k) => r.out[k] ? `<td>${r.out[k].med} / ${r.out[k].p95} ms${r.out[k].fps ? " · " + r.out[k].fps + " fps" : ""}</td>` : "<td>-</td>").join("")}</tr>`).join("")}</tbody></table>`;
}
const img = (f, cls) => ex(f) ? `<img src="${f}" alt="${f}" loading="lazy"${cls ? ` class="${cls}"` : ""}>` : `<p class="note">(missing ${f})</p>`;
const sect = STY.map(([id, name, take]) => `
<section id="${id}">
  <h2>${name}</h2>
  <p>${take}</p>
  <div class="gifs"><figure>${img(`${id}-companion.gif`)}<figcaption>companion, over a dark landscape (150 %)</figcaption></figure><figure>${img(`${id}-core.gif`)}<figcaption>big core, light theme</figcaption></figure></div>
  ${SIZES.map(([sz, sn]) => `<h3>${sn}</h3><div class="pair">${img(`stills/${id}-${sz}-dark.png`)}${img(`stills/${id}-${sz}-light.png`)}</div>`).join("")}
  <h3>Colour presets (default, mint, mono, ocean, sunset) · session size</h3><div class="pair">${img(`presets-${id}-dark.png`)}${img(`presets-${id}-light.png`)}</div>
  <h3>Settings thumbnails (MintBot.thumb, 2D) and the 2D fallback renderer</h3><div class="pair">${img(`stills/thumbs-${id}-dark.png`)}${img(`stills/thumbs-${id}-light.png`)}</div><div class="pair">${img(`stills/fallback2d-${id}-dark.png`)}${img(`stills/fallback2d-${id}-light.png`)}</div>
</section>`).join("\n");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bot face v3</title>
<style>
:root{--bg:#0b0f15;--fg:#e2e8f0;--mut:#94a3b8;--card:#111823;--line:#1f2937;--acc:#00e6a5}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f8fafc;--fg:#0f172a;--mut:#475569;--card:#fff;--line:#e2e8f0;--acc:#00785a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1500px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:26px;margin:0 0 4px} h2{font-size:21px;margin:48px 0 6px;padding-top:12px;border-top:1px solid var(--line)} h3{font-size:14px;color:var(--mut);margin:22px 0 8px;font-weight:600}
p{max-width:900px} .note{color:var(--mut);font-size:13px}
nav a{color:var(--acc);margin-right:14px;text-decoration:none}
img{max-width:100%;height:auto;display:block;border-radius:8px;border:1px solid var(--line)}
.pair{display:grid;gap:10px} .gifs{display:flex;flex-wrap:wrap;gap:18px} figure{margin:0} figcaption{color:var(--mut);font-size:12px;margin-top:4px}
table{border-collapse:collapse;font-size:13px;background:var(--card)} td,th{border:1px solid var(--line);padding:6px 10px;text-align:left}
.rec{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);padding:12px 16px;border-radius:8px;max-width:900px}
</style></head><body><main>
<h1>Bot face v3 — three professional faces for core E</h1>
<p class="note">2026-10-21 · options only, not shipped · rendered with the real renderer (mockups/bot-face-v3/proto-core-bot.js, built from dashboard/public/mint-core-bot.js by build-proto.cjs) · headphones head · every expression at four sizes, dark and light.</p>
<nav><a href="#compare">Compare</a>${STY.map(([id, n]) => `<a href="#${id}">${n}</a>`).join("")}<a href="#perf">Performance</a></nav>
<div class="rec"><b>How it works (all three):</b> the eyes and mouth are no longer lit grid nodes. One parametric face (two mirrored eyes, a mouth; signed distance fields in the face grid's own coordinates) is drawn on a patch that sits on the head's front surface, so it turns, tilts, nods and shakes with the head. Every expression is a parameter set and morphs into the next; blink, glance and the voice's visemes (open / ee / oo) act on the parameters. The grid nodes under a feature are hidden. Options differ only in parameters and in how the shapes are drawn (anti-aliased vs a snapped dot grid). The Settings thumbnails and the 2D fallback draw the same shapes as vector paths through the same projection.</div>
<div class="rec"><b>Recommendation: A · Smooth glyphs.</b> It fixes exactly what the user saw (blocky eyes with holes, a broken mouth) at every size, keeps the wireframe head and the glow, and is the most expressive of the three: lids for thinking, a catchlight when it needs you, happy arcs, an x, a mouth that really opens with the voice. B is the right pick only if the LED character is part of the brand (it is clean now, but at the dock size a 2 x 2 dot eye says less than a glyph). C is the calmest on a desktop but loses expression below ~50 px and when the colour preset is "mint" or "mono" (the states differ mostly by colour). Cost: on the GPU path +0.1-0.2 ms JS per frame; the face patch is one extra small draw per head. Under SwiftShader (CPU rasteriser) the per-pixel shapes cost a vsync step (30 -> 20 fps in the 7-head 1080p bench); on a real GPU that is a few thousand fragments. The 2D fallback is as cheap as before.</div>
<section id="compare"><h2>Current vs A / B / C at the companion size, on a dark landscape</h2>
${img("compare-desk.png")}<p class="note">At the top of the screen, as in the user's screenshot (desktop mode, 150 %).</p>
${img("compare-companion.png")}</section>
${sect}
<section id="perf"><h2>Performance</h2>${bench || '<p class="note">(run bench.cjs)</p>'}</section>
</main></body></html>`;
fs.writeFileSync(path.join(D, "index.html"), html);
console.log("wrote index.html");
