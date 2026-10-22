#!/usr/bin/env node
"use strict";
/**
 * The three face styles as shipped (2026-10-22): screenshots of the REAL pages on a scratch copy of the server
 * (core E, the headphones head), into mockups/bot-face-v3/shipped/:
 *   settings-<theme>.png        Settings ▸ Appearance ▸ Bot: the face picker (three live thumbnails), heads, colours
 *   cc-<face>-<theme>.png       the Command Center: the core and three sessions as heads, each face style
 *   companion-<state>.png       the desktop app's companion window (150 %) over a dark landscape, the three styles side by side
 *   dock-<theme>.png            the dock on another page, each face style
 * The first face comes from the saved preference (POST /mint-ai/api/prefs/bot); the others are switched live with
 * MintBot.setFace, as Settings does.
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright node mockups/bot-face-v3/shots-shipped.cjs
 */
const path = require("path");
const fs = require("fs");
const scratch = require(path.join(__dirname, "..", "..", "dashboard", "tools", "scratch-server.cjs"));
const OUT = path.join(__dirname, "shipped");
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 MintDesktop/0.1.13";
const FACES = ["smooth", "dots", "minimal"];
const NAMES = { smooth: "Smooth", dots: "Dot matrix", minimal: "Minimal" };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const s = await scratch.startScratch({});
  const db = require(path.join(__dirname, "..", "..", "dashboard", "lib", "db.js"));
  const errs = [];
  let browser = null;
  try {
    await s.makeUser("faces", "administrator");
    const { cookie } = await s.signIn("faces");
    const id = db.getUserByName("faces").id;
    db.setUserMintCore(id, "E"); db.setUserBotHead(id, "headphones");
    const base = "http://127.0.0.1:" + s.port;
    // the saved preference, through the API (CSRF): the first style each page opens with
    const tok = s.csrfOf((await s.req("GET", "/mint-ai", { cookie })).body);
    const r = await s.req("POST", "/mint-ai/api/prefs/bot", { cookie, headers: { Accept: "application/json", "X-CSRF-Token": tok }, body: { face: "smooth" } });
    if (r.status !== 200) throw new Error("prefs/bot: " + r.status + " " + r.body);
    browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    async function open(p, o) {
      o = o || {};
      const ctx = await browser.newContext({ viewport: { width: o.w || 1440, height: o.h || 900 }, deviceScaleFactor: o.dpr || 1, colorScheme: o.theme || "dark", userAgent: o.ua, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: base })));
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errs.push(p + ": " + e.message));
      page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(p + ": " + t); });
      if (o.route) await page.route(base + o.route.path, (q) => q.fulfill({ status: 200, contentType: "text/html", body: o.route.body }));
      await page.goto(base + p, { waitUntil: "load" });
      return { ctx, page };
    }

    /* Settings ▸ Appearance ▸ Bot */
    for (const theme of ["dark", "light"]) {
      const { ctx, page } = await open("/mint-ai/settings/appearance", { theme, w: 1280, h: 1800, dpr: 1.5 });
      await page.waitForTimeout(1500);
      const row = await page.$("#a-bot");
      await row.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await row.screenshot({ path: path.join(OUT, "settings-" + theme + ".png") });
      await ctx.close();
    }

    /* the Command Center: each style; three sessions as heads */
    for (const theme of ["dark", "light"]) {
      const { ctx, page } = await open("/mint-ai", { theme, w: 1280, h: 820, dpr: 1.5 });
      await page.waitForFunction(() => window.__mintCC && window.__mintCC.core && window.__mintCC.core.S.concept === "E", null, { timeout: 20000 });
      await page.evaluate(() => {
        const O = window.__mintCC.orbit; document.getElementById("cc-offline").hidden = true;
        setInterval(() => { const o = document.getElementById("cc-offline"); if (o) o.hidden = true; }, 100);
        O._s = O.setState; O.setState = function () {}; O.setOffline = function () {};
        window.__mintCC.core.setOffline(false);
        O.setNodes([{ id: "a", label: "Planning engine", st: "working", act: 4 }, { id: "b", label: "Customs", st: "waiting", act: 2 }, { id: "c", label: "Freight", st: "idle", act: 1 }]);
      });
      for (const f of FACES) {
        await page.evaluate((f) => { window.MintBot.setFace(f); window.__mintCC.orbit._s("idle"); }, f);
        await page.waitForTimeout(1600);
        const box = await page.evaluate(() => { const b = window.__mintCC.core.canvas.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
        await page.screenshot({ path: path.join(OUT, "cc-" + f + "-" + theme + ".png"), clip: { x: Math.max(0, box.x + box.w / 2 - 420), y: Math.max(0, box.y + box.h / 2 - 300), width: 840, height: 560 } });
      }
      await ctx.close();
    }

    /* the desktop app's companion window at 150 %, over a dark landscape; the three styles side by side */
    const WALL = `<canvas id="w" width="1"></canvas>`;
    const HARN = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:900px;height:330px;overflow:hidden;background:#0b2a4a;font:600 14px system-ui,sans-serif}
      canvas#w{position:absolute;left:0;top:0;width:900px;height:330px}iframe{position:absolute;top:0;width:176px;height:160px;border:0;background:transparent;transform-origin:0 0;transform:scale(1.5)}
      .lab{position:absolute;top:250px;width:264px;text-align:center;color:#e2e8f0}</style></head><body>${WALL}
      ${FACES.map((f, i) => `<iframe id="f${i}" allowtransparency="true" style="left:${i * 300 + 18}px" src="/mint-ai?shell=desktop&mode=companion&open=0"></iframe><div class="lab" style="left:${i * 300 + 18}px">${NAMES[f]}</div>`).join("")}
      <script>(function(){var c=document.getElementById("w");c.width=1350;c.height=495;var g=c.getContext("2d"),w=c.width,h=c.height,s=7;function r(){s=(s*16807)%2147483647;return s/2147483647}
      var sky=g.createLinearGradient(0,0,0,h);sky.addColorStop(0,"#0b2a4a");sky.addColorStop(.6,"#1d4f78");sky.addColorStop(.85,"#6f8fa8");sky.addColorStop(1,"#8aa0b0");g.fillStyle=sky;g.fillRect(0,0,w,h);
      for(var i=0;i<70;i++){g.fillStyle="rgba(255,255,255,"+(.15+.4*r())+")";g.fillRect(r()*w,r()*h*.45,1.5,1.5)}
      [[.74,.2,"#3b4a55",11,7],[.84,.28,"#252d33",23,9],[.96,.22,"#151a1e",5,11]].forEach(function(q){s=q[3];var y=h*q[0];g.beginPath();g.moveTo(0,h);for(var x=0;x<=w;x+=4){y+=(r()-.5)*q[4];y=Math.max(h*q[0]-h*q[1],Math.min(h*q[0]+h*q[1]*.3,y));g.lineTo(x,y)}g.lineTo(w,h);g.closePath();g.fillStyle=q[2];g.fill()})})();</script></body></html>`;
    for (const st of ["idle", "speaking", "needs"]) {
      const { ctx, page } = await open("/__wall", { w: 900, h: 330, ua: APP_UA, route: { path: "/__wall", body: HARN } });
      for (let i = 0; i < 3; i++) {
        const fr = await (await page.$("#f" + i)).contentFrame();
        await fr.waitForFunction(() => window.MintDesktop && window.MintDesktop.companion && window.MintDesktop.companion() && window.MintDesktop.companion().debug.core(), null, { timeout: 30000 });
        await fr.evaluate(([f, st]) => {
          setInterval(() => { const o = document.getElementById("cc-offline"); if (o) o.hidden = true; const k = window.MintDesktop.companion().debug.core(); if (k) k.setOffline(false); }, 100);
          window.MintBot.setFace(f);
          document.getElementById("cc").setAttribute("data-state", st);
        }, [FACES[i], st]);
      }
      await page.waitForTimeout(2200);
      await page.screenshot({ path: path.join(OUT, "companion-" + st + ".png") });
      await ctx.close();
    }

    /* the dock on another page */
    for (const theme of ["dark", "light"]) {
      const { ctx, page } = await open("/account", { theme, w: 1280, h: 800, dpr: 1.5 });
      await page.waitForTimeout(1500);
      const shots = [];
      for (const f of FACES) {
        await page.evaluate((f) => window.MintBot.setFace(f), f);
        await page.waitForTimeout(700);
        const p = path.join(OUT, "dock-" + f + "-" + theme + ".png");
        /* the first visible dock part (orb, bar), padded; else the page's lower right corner */
        const r = await page.evaluate(() => {
          for (const sel of ["#md-orb", ".md-dock", "#mint-dock-root"]) {
            const e = document.querySelector(sel); if (!e) continue; const b = e.getBoundingClientRect();
            if (b.width > 4 && b.height > 4) return { x: b.left, y: b.top, width: b.width, height: b.height, sel };
          }
          return null;
        });
        const W = 1280, H = 800, pad = 40, x0 = r ? Math.max(0, r.x - pad) : W - 420, y0 = r ? Math.max(0, r.y - pad) : H - 260;
        const clip = r ? { x: x0, y: y0, width: Math.min(W - x0, r.width + 2 * pad + 200), height: Math.min(H - y0, r.height + 2 * pad) } : { x: x0, y: y0, width: 420, height: 260 };
        console.log("dock", f, theme, r && r.sel, JSON.stringify(clip));
        await page.screenshot({ path: p, clip });
        shots.push(p);
      }
      await ctx.close();
    }
    console.log("wrote " + fs.readdirSync(OUT).length + " files to " + OUT);
  } finally {
    if (browser) await browser.close();
    s.stop();
  }
  if (errs.length) { console.log("PAGE ERRORS:\n" + errs.join("\n")); process.exitCode = 1; }
})().catch((e) => { console.error(e); process.exit(1); });
