#!/usr/bin/env node
"use strict";
/**
 * Preview of Companion mode (the MINT AI desktop app, 2026-10-20; mockups/desk-companion/DESIGN.md) for review:
 * the bot out of its box, walking along the taskbar, hopping onto the window in front, crossing to the second
 * monitor, the session bots gathering, stepping aside from the cursor, ducking out of a full-screen video,
 * dozing back on the taskbar.
 *
 * The path is the app's own logic: desktop/core-tests/examples/companion_sim.rs runs companion.rs on the
 * user's desk (the laptop at 150 % and the Samsung at 100 % to its right) and writes the window's place and
 * the events frame by frame. This tool draws that desk (wallpaper, taskbars, the windows, the cursor) and puts
 * the REAL companion page (/mint-ai?shell=desktop&mode=companion, a scratch copy of the server) in the moving
 * window, scaled by each monitor's DPI, and hands it the app's events as the app would. Headless Chromium
 * records it; ffmpeg cuts the GIFs.
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/shots-desk-companion.cjs OUT_DIR [frames.json]
 *
 * Without frames.json it runs `cargo run --example companion_sim` in desktop/core-tests.
 */
const scratch = require("./scratch-server.cjs");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const OUT = process.argv[2];
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 MintDesktop/0.1.12";
const VW = 960, VH = 540;

// The sessions waiting on you (the role table picks their heads) -- they gather, then go back to work.
const SESSIONS = [
  { session_id: "s1", pid: 101, name: "Invoice audit", cwd: "/root/moni", status: "waiting", waiting_for: "your approval", where: "Terminal" },
  { session_id: "s2", pid: 102, name: "Planning engine", cwd: "/root/moni/giza-planning-engine", status: "waiting", waiting_for: "a decision", where: "Terminal" },
  { session_id: "s3", pid: 103, name: "Customs docs", cwd: "/root/moni", status: "busy", where: "Terminal", hired: true, hire: { slug: "customs", kept: false } },
  { session_id: "s4", pid: 104, name: "Odoo dev", cwd: "/opt/odoo/custom", status: "idle", where: "Terminal" },
];

// The GIFs: [name, from ms, to ms] of the scripted run.
const CUTS = [
  ["walk-and-hop", 1800, 9200],
  ["cross-monitors", 10300, 14400],
  ["session-bots", 14200, 19000],
  ["step-aside", 18800, 25000],
  ["duck-fullscreen", 25800, 31000],
  ["doze-on-taskbar", 32600, 40000],
];
// The camera: zoom by time (world px -> screen px), following the bot.
const ZOOM = [[0, 0.25], [1600, 0.6], [10100, 0.3], [14000, 0.95], [25700, 0.42], [31000, 0.62]];

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><style>
html{color-scheme:dark}html,body{margin:0;width:${VW}px;height:${VH}px;overflow:hidden;background:#05060c;font:12px/1.2 "Segoe UI",system-ui,sans-serif}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
.mon{position:absolute;overflow:hidden;background:radial-gradient(1200px 700px at 30% 30%,#2b2f6b 0%,#14183a 45%,#0a0c1e 100%)}
.mon.b{background:radial-gradient(1200px 700px at 70% 40%,#3a2557 0%,#181333 50%,#0b0a1a 100%)}
.lab{position:absolute;left:24px;top:18px;color:rgba(255,255,255,.35);font-size:26px}
.tb{position:absolute;background:rgba(22,24,38,.94);border-top:1px solid rgba(255,255,255,.08)}
.tb i{position:absolute;top:22%;width:5%;height:56%;border-radius:8px;background:rgba(255,255,255,.12)}
.win{position:absolute;background:#f4f5f8;border-radius:10px;box-shadow:0 18px 60px rgba(0,0,0,.45);overflow:hidden;opacity:.97}
.win .tt{height:44px;background:#e6e8ef;color:#333;padding:0 16px;display:flex;align-items:center;font-size:20px}
.win .tt b{margin-left:auto;letter-spacing:22px;color:#888}
.win .ln{margin:22px 26px;height:16px;border-radius:8px;background:#dde0e8}
.win.front{outline:3px solid rgba(95,240,200,.55)}
.full{position:absolute;background:#000;display:flex;align-items:center;justify-content:center}
.full:after{content:"";border-left:90px solid rgba(255,255,255,.75);border-top:56px solid transparent;border-bottom:56px solid transparent}
#comp{color-scheme:dark;position:absolute;width:264px;height:140px;border:0;background:transparent;transform-origin:0 0}
#cur{position:absolute;width:22px;height:30px;z-index:9;display:none}
#cap{position:absolute;left:14px;bottom:12px;color:#e9ebff;background:rgba(0,0,0,.55);padding:6px 12px;border-radius:10px;font-size:14px;z-index:10}
</style></head><body><div id="world"></div><iframe id="comp" allowtransparency="true"></iframe>
<svg id="cur" viewBox="0 0 22 30"><path d="M2 2 L2 24 L8 18 L12 28 L16 26 L12 16 L20 16 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>
<div id="cap"></div></body></html>`;

(async () => {
  if (!OUT) throw new Error("usage: shots-desk-companion.cjs OUT_DIR [frames.json]");
  fs.mkdirSync(OUT, { recursive: true });
  let sim;
  if (process.argv[3]) sim = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  else sim = JSON.parse(execFileSync("cargo", ["run", "-q", "--example", "companion_sim"], { cwd: path.join(__dirname, "..", "..", "desktop", "core-tests"), maxBuffer: 64 << 20 }).toString());
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const s = await scratch.startScratch({});
  const db = require(path.join(__dirname, "..", "lib", "db.js"));
  const errs = [];
  let browser = null;
  try {
    await s.makeUser("desk", "administrator");
    const { cookie } = await s.signIn("desk");
    const id = db.getUserByName("desk").id;
    db.setUserMintCore(id, "E");
    db.setUserBotHead(id, "headphones");
    browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    const vdir = path.join(OUT, "video-tmp");
    const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, recordVideo: { dir: vdir, size: { width: VW, height: VH } } });
    const t0Video = Date.now();
    await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errs.push("harness: " + e.message));
    page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t); });
    const base = "http://127.0.0.1:" + s.port;
    await page.route(base + "/__desk", (r) => r.fulfill({ status: 200, contentType: "text/html", body: HARNESS }));
    await page.goto(base + "/__desk", { waitUntil: "load" });
    // The companion page in the window.
    await page.evaluate((u) => { document.getElementById("comp").src = u; }, base + "/mint-ai?shell=desktop&mode=companion&open=0");
    const frame = await (await page.$("#comp")).contentFrame();
    await frame.waitForFunction(() => window.MintDesktop && window.MintDesktop.companion && window.MintDesktop.companion() && window.MintDesktop.companion().debug.core(), null, { timeout: 20000 });
    frame.page().on("pageerror", (e) => errs.push("companion: " + e.message));
    await frame.evaluate((list) => {
      // A scratch server has no supervisor: keep the "not reachable" card and state away (the bot would show its offline face).
      setInterval(() => { const o = document.getElementById("cc-offline"); if (o) o.hidden = true; }, 100);
      window.__deskSessions = list;
    }, SESSIONS);
    await page.waitForTimeout(800);
    // Play the run in real time: the window's place, the desk, the events into the page.
    const simStart = await page.evaluate(async ({ sim, ZOOM, VW, VH }) => {
      const W = document.getElementById("world"), F = document.getElementById("comp"), C = document.getElementById("cur"), cap = document.getElementById("cap");
      const fw = F.contentWindow, comp = () => fw.MintDesktop.companion();
      const el = (cls, r, html) => { const e = document.createElement("div"); e.className = cls; Object.assign(e.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" }); if (html) e.innerHTML = html; W.appendChild(e); return e; };
      sim.monitors.forEach((m, i) => el("mon" + (i ? " b" : ""), m, '<div class="lab">' + m.name + "</div>"));
      const wins = sim.windows.map((w) => el("win", w, '<div class="tt">' + w.title + "<b>– ▢ ✕</b></div>" + '<div class="ln"></div>'.repeat(Math.max(2, Math.floor(w.h / 90)))));
      sim.taskbars.forEach((t) => { const e = el("tb", t); for (let i = 0; i < 7; i++) { const d = document.createElement("i"); d.style.left = 34 + i * 6 + "%"; e.appendChild(d); } });
      const full = el("full", sim.monitors[1]);
      full.style.display = "none";
      full.style.zIndex = 5;
      const zoomAt = (t) => { let z = ZOOM[0][1]; for (const [tt, zz] of ZOOM) if (t >= tt) z = zz; return z; };
      const caption = (t) => t < 1600 ? "The desk: laptop (150 %) and the Samsung (100 %)" : t < 10100 ? "Word, then Outlook in front: it walks along the taskbar and hops up" : t < 14000 ? "A window on the other monitor: it walks off and steps in there" : t < 18900 ? "Sessions waiting on you gather beside it" : t < 25600 ? "The cursor near: it steps aside; resting on it: click to open" : t < 31000 ? "A full-screen video on its monitor: it ducks out" : "Late at night: back on the taskbar, dozing";
      let cam = null, z = ZOOM[0][1], i = 0, dozed = false, sessOn = false, sessOff = false;
      const t0 = performance.now();
      function draw() {
        const t = performance.now() - t0;
        while (i < sim.frames.length - 1 && sim.frames[i + 1].t <= t) {
          i++;
          const f = sim.frames[i];
          (f.events || []).forEach((ev) => { try { comp().debug.event(ev); } catch (e) { /* the page not ready */ } });
          try { if (f.look) comp().debug.event({ x: f.look[0], y: f.look[1] }, "mint://companion-look"); else comp().debug.event({ off: true }, "mint://companion-look"); } catch (e) { /* fine */ }
        }
        const f = sim.frames[i];
        // the desk
        wins.forEach((w, k) => { const fr = f.front; w.classList.toggle("front", !!fr && fr.title === sim.windows[k].title); });
        const fullOn = !!(f.front && f.front.full);
        full.style.display = fullOn ? "flex" : "none";
        // sessions: waiting ones gather at ~14.5 s, back to work at ~17.5 s
        if (t > 14500 && !sessOn) { sessOn = true; const cc = fw.__mintCC; if (cc) { cc.S.sessions = fw.__deskSessions; } }
        if (t > 17600 && !sessOff) { sessOff = true; const cc = fw.__mintCC; if (cc) cc.S.sessions = fw.__deskSessions.map((s) => Object.assign({}, s, { status: s.status === "waiting" ? "busy" : s.status })); }
        if (f.dozing && !dozed && t > 37200) { dozed = true; const k = comp().debug.core(); if (k) { k.S.actAt = Date.now() - 11 * 60000; k._doze(); } }
        // the camera follows the bot
        const bx = f.x + f.w / 2, by = f.y + f.h / 2;
        z += (zoomAt(t) - z) * 0.08;
        const want = { x: bx - VW / 2 / z, y: by - VH * 0.58 / z };
        cam = cam ? { x: cam.x + (want.x - cam.x) * 0.12, y: cam.y + (want.y - cam.y) * 0.12 } : want;
        const maxX = 3840 - VW / z, maxY = 1200 - VH / z;
        // Inside the desk; a desk smaller than the view is centred in it.
        const cx = maxX < 0 ? maxX / 2 : Math.max(0, Math.min(maxX, cam.x)), cy = maxY < 0 ? maxY / 2 : Math.max(0, Math.min(maxY, cam.y));
        W.style.transform = "scale(" + z + ") translate(" + -cx + "px," + -cy + "px)";
        F.style.display = f.hidden ? "none" : "block";
        F.style.left = (f.x - cx) * z + "px";
        F.style.top = (f.y - cy) * z + "px";
        F.style.transform = "scale(" + f.scale * z + ")";
        if (f.cursor) { C.style.display = "block"; C.style.left = (f.cursor[0] - cx) * z + "px"; C.style.top = (f.cursor[1] - cy) * z + "px"; } else C.style.display = "none";
        cap.textContent = caption(t);
        if (t < sim.frames[sim.frames.length - 1].t) requestAnimationFrame(draw);
        else window.__done = true;
      }
      requestAnimationFrame(draw);
      return Date.now();
    }, { sim, ZOOM, VW, VH });
    await page.waitForFunction(() => window.__done, null, { timeout: 120000, polling: 500 });
    await page.screenshot({ path: path.join(OUT, "desk-end.png") });
    const off = (simStart - t0Video) / 1000;
    const v = page.video();
    await ctx.close();
    const webm = await v.path();
    for (const [name, a, b] of CUTS) {
      const vf = "fps=12,scale=600:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(off + a / 1000), "-t", String((b - a) / 1000), "-i", webm, "-vf", vf, path.join(OUT, name + ".gif")]);
      const still = path.join(OUT, name + ".png");
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(off + (a + (b - a) * 0.55) / 1000), "-i", webm, "-frames:v", "1", still]);
    }
    fs.rmSync(vdir, { recursive: true, force: true });
    // The perches side by side (a still): on a bottom taskbar, hanging under a top one, leaning on a left one,
    // on the edge of an auto-hidden one -- light and dark ink.
    {
      const pctx = await browser.newContext({ viewport: { width: 1200, height: 520 }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
      await pctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: base })));
      const pp = await pctx.newPage();
      pp.on("pageerror", (e) => errs.push("perches: " + e.message));
      const PANELS = [
        ["On the taskbar", "stand", 0, "bottom", "light"],
        ["Under a top taskbar", "hang", 0, "top", "light"],
        ["Against a left taskbar", "stand", -1, "left", "light"],
        ["Auto-hidden taskbar: on the edge", "stand", 0, "hidden", "dark"],
      ];
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>html{color-scheme:dark}body{margin:0;background:#05060c;font:15px "Segoe UI",system-ui,sans-serif;color:#e9ebff}
        .p{position:absolute;width:290px;height:240px;overflow:hidden;border-radius:12px}.p.d{background:linear-gradient(160deg,#2b2f6b,#0a0c1e)}.p.l{background:linear-gradient(160deg,#eef1fb,#c9d2f0)}
        .t{position:absolute;left:0;right:0;height:36px;background:rgba(22,24,38,.94)}.v{position:absolute;top:0;bottom:0;width:36px;background:rgba(22,24,38,.94)}.h{position:absolute;left:0;right:0;bottom:0;height:2px;background:rgba(22,24,38,.94)}
        iframe{position:absolute;width:264px;height:140px;border:0;background:transparent;color-scheme:dark}.c{position:absolute;color:#cfd3ff}</style></head><body></body></html>`;
      await pp.route(base + "/__perches", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
      await pp.goto(base + "/__perches", { waitUntil: "load" });
      for (let i = 0; i < PANELS.length; i++) {
        const [cap, stance, lean, bar, theme] = PANELS[i];
        const x = 10 + i * 297, y = 40;
        await pp.evaluate(({ i, cap, stance, bar, theme, x, y, u }) => {
          const p = document.createElement("div");
          p.className = "p " + (i % 2 ? "l" : "d");
          Object.assign(p.style, { left: x + "px", top: y + "px" });
          const bars = { bottom: ["t", { bottom: "0" }], top: ["t", { top: "0" }], left: ["v", { left: "0" }], hidden: ["h", {}] }[bar];
          const b = document.createElement("div"); b.className = bars[0]; Object.assign(b.style, bars[1]); p.appendChild(b);
          const f = document.createElement("iframe");
          const fy = bar === "bottom" ? 240 - 36 - 134 : bar === "top" ? 36 : 240 - 4 - 134;
          Object.assign(f.style, { left: (bar === "left" ? 36 + 2 + 38 - (132 - 70) : 13) + "px", top: fy + "px" });
          f.src = u + (i % 2 ? "&ink=dark" : ""); f.style.colorScheme = i % 2 ? "light" : "dark";
          f.id = "f" + i;
          p.appendChild(f);
          document.body.appendChild(p);
          const c = document.createElement("div"); c.className = "c"; c.textContent = cap; Object.assign(c.style, { left: x + 6 + "px", top: y + 250 + "px" }); document.body.appendChild(c);
        }, { i, cap, stance, bar, theme, x, y, u: base + "/mint-ai?shell=desktop&mode=companion&open=0" });
      }
      for (let i = 0; i < PANELS.length; i++) {
        const fr = await (await pp.$("#f" + i)).contentFrame();
        await fr.waitForFunction(() => window.MintDesktop && window.MintDesktop.companion && window.MintDesktop.companion() && window.MintDesktop.companion().debug.core(), null, { timeout: 20000 });
        await fr.evaluate((v) => { setInterval(() => { const o = document.getElementById("cc-offline"); if (o) o.hidden = true; }, 100); window.MintDesktop.companion().debug.event({ kind: "arrive", view: v }); }, { stance: PANELS[i][1], lean: PANELS[i][2], openSide: "right" });
      }
      await pp.waitForTimeout(1500);
      await pp.screenshot({ path: path.join(OUT, "perches.png") });
      await pctx.close();
    }
    console.log(JSON.stringify({ gifs: CUTS.map((c) => c[0] + ".gif"), frames: sim.frames.length, errors: errs }, null, 1));
    if (errs.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    s.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
