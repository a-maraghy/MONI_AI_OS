#!/usr/bin/env node
"use strict";
/**
 * Companion mode in the MINT AI desktop app (2026-10-20; mockups/desk-companion/DESIGN.md): the page side,
 * public/mint-desktop-companion.js, and its seams with mint-desktop.js and the app.
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-desktop-companion.cjs
 *
 * Pure parts first (the numbers against companion.rs, the layout, the motion, the legs, the session bots
 * gathering, the idle moments, the hit regions); then the app's sources (the command, the tray switch, no blur
 * in this mode, the loop); then headless Chromium on a scratch copy of the server with a stand-in for the app's
 * bridge: the bot out in its small window, the Command Center's pieces resting, only the bot catching the mouse,
 * a click opening its Peek, the session bots walking in and off, holding still -- with no page errors or CSP
 * violations.
 */
const scratch = require("./scratch-server.cjs"); // first: sets MONI_DATA_DIR
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const D = path.join(ROOT, "..", "desktop");
const C = require(path.join(ROOT, "public", "mint-desktop-companion.js"));
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 MintDesktop/0.1.12";

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 600) : ""));
  }
}
const section = (t) => console.log("\n" + t);
const near = (a, b, e) => Math.abs(a - b) <= (e || 0.5);
const S = (st, name, extra) => Object.assign({ session_id: name, name, status: st, cwd: "/root/moni" }, extra || {});

(async () => {
  section("the numbers: the page and the app (companion.rs) agree");
  {
    const rs = fs.readFileSync(path.join(D, "src-tauri", "src", "companion.rs"), "utf8");
    const num = (k) => { const m = new RegExp("pub const " + k + ": f64 = ([0-9.]+);").exec(rs); return m ? Number(m[1]) : NaN; };
    for (const k of ["WIN_W", "WIN_H", "FOOT", "BODY_R", "BODY_CY", "HANG_CY", "LEAN_DX"]) check("  " + k + " = " + C[k] + " on both sides", num(k) === C[k], num(k));
    check("  the bot's head fits inside its hit circle, and the circle ends above the feet (never over what it stands on)", C.HEAD_R < C.BODY_R && C.BODY_CY - C.BODY_R >= 0 && C.BODY_CY - C.BODY_R <= 4);
    check("  a small window: 264 x 140 logical px (not a full-screen overlay)", C.WIN_W * C.WIN_H < 40000);
  }

  section("layout: standing on a shelf, hanging under a top taskbar; the session bots' slots");
  {
    const L = C.layout(264, 140, "stand", "left");
    check("standing: the head centred, BODY_CY above the feet (FOOT above the window's bottom)", L.cx === 132 && L.cy === 140 - C.FOOT - C.BODY_CY && !L.hang);
    check("  three slots on the ground, the open side first (left), all inside the window", L.slots.length === C.MAX_HEADS && L.slots[0].x < L.cx && L.slots[1].x > L.cx && L.slots.every((s) => s.x - C.KID_R >= 0 && s.x + C.KID_R <= 264 && s.y + C.KID_R <= 140 - C.FOOT));
    check("  the slots clear of the bot", L.slots.every((s) => Math.abs(s.x - L.cx) >= C.BODY_R + C.KID_R));
    const R = C.layout(264, 140, "stand", "right");
    check("  open side right: the first slot on the right", R.slots[0].x > R.cx);
    const H = C.layout(264, 140, "hang", "left");
    check("hanging: the head HANG_CY under the window's top", H.hang && H.cy === C.HANG_CY);
    const Lf = C.layout(264, 140, "stand", "left", -1), Rt = C.layout(264, 140, "stand", "left", 1);
    check("leaning on a left taskbar: the bot LEAN_DX toward it, every slot on the other side, inside the window", Lf.cx === 132 - C.LEAN_DX && Lf.body.x - C.BODY_R >= 0 && Lf.slots.every((s) => s.x > Lf.cx && s.x + C.KID_R <= 264));
    check("  on a right one: mirrored", Rt.cx === 132 + C.LEAN_DX && Rt.body.x + C.BODY_R <= 264 && Rt.slots.every((s) => s.x < Rt.cx && s.x - C.KID_R >= 0));
  }

  section("motion: the poses the app sends");
  {
    const L = C.layout(264, 140, "stand", "left");
    const w0 = C.motion("walk", 0, 1, L, 0), wm = C.motion("walk", 0.5, 1, L, 90), w1 = C.motion("walk", 1, 1, L, 2000);
    check("walk: a small bob (a step every 180 ms), level at both ends", w0.dy === 0 && wm.dy < 0 && wm.dy >= -3 && Math.abs(w1.dy) < 1e-9 && wm.a === 1);
    const o1 = C.motion("out", 1, 1, L), i0 = C.motion("in", 0, 1, L), i1 = C.motion("in", 1, 1, L);
    check("out: it walks off the window's edge in its direction and is gone; in: from the other side, and there", o1.dx > L.W / 2 && o1.a === 0 && i0.dx < -L.W / 2 && i0.a === 0 && i1.dx === 0 && i1.a === 1);
    check("  out to the left goes left", C.motion("out", 1, -1, L).dx < -L.W / 2);
    check("duck: down and out of sight; pop: back up", C.motion("duck", 1, 1, L).a === 0 && C.motion("duck", 1, 1, L).dy > 0 && C.motion("pop", 1, 1, L).dy === 0 && C.motion("pop", 1, 1, L).a === 1);
    const h = [0.1, 0.5, 0.95].map((k) => C.motion("hop", k, 1, L).sc);
    check("hop: a crouch before, a squash on landing (the window carries the arc)", h[0] < 1 && h[2] < 1 && near(C.motion("hop", 1, 1, L).sc, 1, 1e-9));
    check("stretch: up tall and back; no pose: still", C.motion("stretch", 0.5, 1, L).sc > 1 && near(C.motion("stretch", 1, 1, L).sc, 1, 1e-9) && JSON.stringify(C.motion("", 0.5, 1, L)) === JSON.stringify({ dx: 0, dy: 0, sc: 1, a: 1 }));
  }

  section("legs and arms");
  {
    const L = C.layout(264, 140, "stand", "left");
    const st = C.limbs(L, null, "", 0, false), feet = 140 - C.FOOT;
    check("standing: two legs from under the head to the feet; a contact shadow at the feet", st.legs.length === 2 && st.legs.every((l) => near(l.y1, feet, 0.01) && l.y0 > L.cy && l.y0 < feet) && st.shadow && near(st.shadow.y, feet + 1));
    const hop = C.limbs(L, null, "hop", 0, false);
    check("  mid-hop: tucked up", hop.legs.every((l) => l.y1 < feet - 2));
    const dz = C.limbs(L, null, "", 0, true);
    check("  dozing: folded (it sits)", dz.legs.every((l) => l.y1 < feet - 2));
    const wk = [0, 90, 180, 270].map((t) => C.limbs(L, null, "walk", t, false).legs.map((l) => l.y1));
    check("  walking: the feet take turns", wk.some((y) => y[0] < feet - 1 && y[1] === feet) && wk.some((y) => y[1] < feet - 1 && y[0] === feet));
    const H = C.layout(264, 140, "hang", "left"), hg = C.limbs(H, null, "", 0, false);
    check("hanging: two arms up to the taskbar's edge, no shadow", hg.legs.length === 2 && hg.legs.every((l) => l.y1 < 3 && l.y0 < H.cy) && hg.shadow === null);
  }

  section("the session bots: they gather when a session needs you, and wander off");
  {
    let h = C.gather([], [S("waiting", "Invoice audit"), S("busy", "Odoo dev"), S("idle", "Customs")], [], 0, true);
    check("only the one waiting on you walks in, into the first slot", h.length === 1 && h[0].key === "Invoice audit" && h[0].phase === "in" && h[0].slot === 0);
    h = C.gather(h, [S("waiting", "Invoice audit"), S("busy", "Odoo dev")], [{ id: 3, status: "pending", origin: "session:Odoo dev" }], 300, true);
    check("  a session that asked for an approval needs you too (it walks in, next slot)", h.length === 2 && h[1].key === "Odoo dev" && h[1].slot === 1);
    h = C.gather(h, [S("waiting", "Invoice audit"), S("busy", "Odoo dev")], [{ id: 3, status: "pending", origin: "session:Odoo dev" }], 1000, true);
    check("  after GATHER_MS the first is there", h[0].phase === "here" && h[1].phase === "in");
    const many = ["a", "b", "c", "d", "e"].map((n) => S("waiting", n));
    let g = C.gather([], many.slice(0, 2), [], 0, true);
    g = C.gather(g, many, [], 500, true);
    check("at most MAX_HEADS (3), the longest waiting first", g.filter((x) => x.phase !== "out").length === 3 && g.slice(0, 2).map((x) => x.key).join() === "a,b");
    let off = C.gather(h, [S("busy", "Invoice audit"), S("busy", "Odoo dev")], [], 2000, true);
    check("no longer waiting: they walk off (phase out) ...", off.length === 2 && off.every((x) => x.phase === "out"));
    off = C.gather(off, [S("busy", "Invoice audit")], [], 2000 + C.GATHER_MS + 1, true);
    check("  ... and are gone after GATHER_MS", off.length === 0);
    const kept = C.gather(C.gather([], [S("waiting", "a"), S("waiting", "b")], [], 0, true), [S("waiting", "b")], [], 100, true);
    check("  one leaving does not move the one that stays (it keeps its slot)", kept.find((x) => x.key === "b").slot === 1);
    check("the setting off: none gather", C.gather([], many, [], 0, false).length === 0);
    check("  MINT AI's own session never comes", C.gather([], [Object.assign(S("waiting", "MINT AI"), { self: true })], [], 0, true).length === 0);
    const L = C.layout(264, 140, "stand", "left");
    const ki = C.kidsAt([{ key: "x", slot: 0, phase: "in", t0: 0 }], 0, L, false)[0];
    const kh = C.kidsAt([{ key: "x", slot: 0, phase: "here", t0: 0 }], 5000, L, false)[0];
    const ko = C.kidsAt([{ key: "x", slot: 0, phase: "out", t0: 0 }], C.GATHER_MS, L, false)[0];
    check("kids for core E: walking in from the open side's edge, at the slot, walking off; the waiting face", ki.x < 0 && ki.alpha === 0 && kh.x === L.slots[0].x && kh.st === "waiting" && ko.x < 0 && ko.alpha === 0 && ko.st === "idle");
    check("  holding still: at their slots at once, the ones leaving not drawn", C.kidsAt([{ key: "x", slot: 0, phase: "in", t0: 0 }], 0, L, true)[0].x === L.slots[0].x && C.kidsAt([{ key: "x", slot: 0, phase: "out", t0: 0 }], 0, L, true).length === 0);
  }

  section("idle moments");
  {
    const base = { now: 100000, next: 0, state: "idle" };
    check("now and then: stretch or look around, and when to ask again (25-50 s)", (() => { const p = C.idlePick(Object.assign({ rnd: 0.2 }, base)); return p && p.act === "stretch" && p.next >= 100000 + C.IDLE_MIN_MS && p.next <= 100000 + C.IDLE_MAX_MS; })());
    check("  after a stretch, mostly a look around", C.idlePick(Object.assign({ rnd: 0.3, last: "stretch" }, base)).act === "look");
    check("  never while busy, dozing, holding still, not ready, or before its time", [{ busy: true }, { dozing: true }, { still: true }, { state: "thinking" }, { next: 200000 }].every((x) => C.idlePick(Object.assign({}, base, x)) === null));
  }

  section("hit regions: the bot and the session bots that are there");
  {
    const L = C.layout(264, 140, "stand", "left");
    const r = C.regions(L, [], null);
    check("the bot alone: its circle", r.length === 1 && r[0].w === 2 * C.BODY_R && r[0].r === C.BODY_R && near(r[0].x + r[0].w / 2, L.cx, 1));
    const kids = C.kidsAt([{ key: "a", slot: 0, phase: "here", t0: 0 }, { key: "b", slot: 1, phase: "out", t0: 0 }], 99999, L, false);
    check("  plus a session bot that is there (not one walking off)", C.regions(L, kids, null).length === 2);
    check("  ducked out (faded): nothing", C.regions(L, [], { dx: 0, dy: 80, sc: 1, a: 0 }).length === 0);
    check("  moved with the bot (a step out of the edge) and clipped to the window", C.regions(L, [], { dx: 150, dy: 0, sc: 1, a: 1 }).every((q) => q.x + q.w <= 264));
  }

  section("the app's side (sources)");
  {
    const lib = fs.readFileSync(path.join(D, "src-tauri", "src", "lib.rs"), "utf8");
    const host = fs.readFileSync(path.join(D, "src-tauri", "src", "companion_host.rs"), "utf8");
    const remote = fs.readFileSync(path.join(D, "src-tauri", "capabilities", "remote.json"), "utf8");
    const build = fs.readFileSync(path.join(D, "src-tauri", "build.rs"), "utf8");
    check("the page may say three things (companion: open / doze / wake), granted to the site; nothing else is taken", /"allow-companion"/.test(remote) && /"companion"/.test(build) && /fn companion\(app: AppHandle, kind: String/.test(lib) && /"open" =>/.test(host) && /"doze" \| "wake" =>/.test(host) && /_ => \{\}/.test(host));
    check("no blur in Companion mode (its window moves; a shown blur window never may)", /a\.settings\.mode != Mode::Companion && acrylic::live\(\)/.test(lib));
    check("the tray switch: Companion on, and off back to the mode it came from", /"mode:companion"/.test(lib) && /before_companion/.test(lib));
    check("the loop runs on its own thread and moves the window asynchronously (never waits on the main thread)", /std::thread::spawn\(move \|\| companion_host::run\(/.test(lib) && /SWP_ASYNCWINDOWPOS/.test(fs.readFileSync(path.join(D, "src-tauri", "src", "platform.rs"), "utf8")));
    check("  it reads window geometry only: no screen capture, no input injection", !/BitBlt|PrintWindow|GetDIBits|SendInput|keybd_event|mouse_event|Graphics\.Capture/.test(host + fs.readFileSync(path.join(D, "src-tauri", "src", "companion.rs"), "utf8")));
    check("  full screen and meetings duck it out (policy::fullscreen_hold, the camera / microphone in use)", /policy::fullscreen_hold\(/.test(host) && /cap_use\("webcam"\)/.test(host) && /cap_use\("microphone"\)/.test(host));
    const sh = fs.readFileSync(path.join(D, "dist", "settings.html"), "utf8"), sj = fs.readFileSync(path.join(D, "dist", "settings.js"), "utf8");
    check("Settings: Mode ▸ Companion; where it sits (taskbar / windows / both), session bots, stay on this monitor", /data-v="companion">Companion</.test(sh) && /data-k="perch"><button data-v="taskbar">Taskbar<\/button><button data-v="windows">Windows<\/button><button data-v="both">Both<\/button>/.test(sh) && /id="comp-bots"/.test(sh) && /id="comp-stay"/.test(sh) && /comp\(\)\.session_bots = \$\("comp-bots"\)\.checked; comp\(\)\.stay_on_monitor = \$\("comp-stay"\)\.checked/.test(sj) && /k === "perch" \? comp\(\)\.perch/.test(sj));
    const views = fs.readFileSync(path.join(ROOT, "lib", "views-moniai.js"), "utf8");
    check("the page loads the companion before mint-desktop.js (the desktop render mode only)", /"mint-desktop-companion\.js", "moni-ai\.js"[^\]]*"mint-desktop\.js"\]/.test(views));
    const md = fs.readFileSync(path.join(ROOT, "public", "mint-desktop.js"), "utf8");
    check("mint-desktop.js: the bot's regions only while it is out; Esc / empty space close its Peek; the Command Center's core rests", /if \(compOut\(\) && comp\) return comp\.regions\(\)/.test(md) && /if \(peekish\(\)\) invoke\("hide_peek"\)/.test(md) && /st\.hidden \|\| compOut\(\)/.test(md));
  }

  section("in the browser (a scratch server, a stand-in for the app's bridge)");
  {
    let chromium;
    try { ({ chromium } = require(process.env.PLAYWRIGHT || "playwright")); } catch (e) { chromium = null; }
    if (!chromium) { check("playwright is available (set PLAYWRIGHT)", false); }
    else {
      const s = await scratch.startScratch({});
      let browser = null;
      try {
        await s.makeUser("comp", "administrator");
        const { cookie } = await s.signIn("comp");
        browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
        async function open(host, W, H) {
          const ctx = await browser.newContext({ viewport: { width: W || 264, height: H || 140 }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
          await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
          const page = await ctx.newPage();
          const errs = [];
          page.on("pageerror", (e) => errs.push(e.message));
          page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t); });
          await page.addInitScript((h) => {
            window.__csp = [];
            document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
            window.__calls = [];
            const L = (window.__listeners = {});
            window.__TAURI__ = {
              core: { invoke: (cmd, args) => { window.__calls.push([cmd, args || {}]); return Promise.resolve(cmd === "get_state" ? h : null); } },
              event: { listen: (n, f) => { (L[n] = L[n] || []).push(f); return Promise.resolve(() => {}); } },
            };
            window.__emit = (n, p) => (L[n] || []).forEach((f) => f({ payload: p }));
            setInterval(() => { const o = document.getElementById("cc-offline"); if (o) o.hidden = true; }, 50);
          }, host);
          await page.goto("http://127.0.0.1:" + s.port + "/mint-ai?shell=desktop", { waitUntil: "load" });
          await page.waitForTimeout(900);
          return { ctx, page, errs };
        }
        const HOST = { mode: "companion", peekOpen: false, still: false, companion: { perch: "both", sessionBots: true, stance: "stand", lean: 0, openSide: "left", ducked: false } };
        const { ctx, page, errs } = await open(HOST);
        const st = await page.evaluate(() => {
          const regs = window.__calls.filter((c) => c[0] === "set_hit_regions").map((c) => c[1].regions);
          const cc = document.getElementById("cc");
          return { mode: document.documentElement.getAttribute("data-dk-mode"), out: document.documentElement.classList.contains("dk-comp-out"), comp: !document.getElementById("dk-comp").hidden, ccVis: getComputedStyle(cc).visibility, last: regs[regs.length - 1], core: window.MintDesktop.companion().debug.core() ? window.MintDesktop.companion().debug.core().S.concept : null, ccStill: !!(window.__mintCC.core && window.__mintCC.core.S && window.__mintCC.core.S.still) };
        });
        check("the bot is out: its own core E in the small window, the Command Center's pieces resting (hidden, its core still)", st.mode === "companion" && st.out && st.comp && st.ccVis === "hidden" && st.core === "E" && st.ccStill, JSON.stringify(st));
        check("  only the bot catches the mouse: one circle", st.last && st.last.length === 1 && st.last[0].w === 2 * C.BODY_R && st.last[0].r === C.BODY_R, JSON.stringify(st.last));
        // the app's poses
        const pz = await page.evaluate(async () => {
          window.__emit("mint://companion", { kind: "walk", ms: 1200, dir: 1 });
          await new Promise((r) => setTimeout(r, 300));
          const k = window.MintDesktop.companion().debug.core();
          const mid = k.S.c[1];
          window.__emit("mint://companion", { kind: "arrive", view: { stance: "hang", openSide: "right", sessionBots: true } });
          await new Promise((r) => setTimeout(r, 100));
          const L = window.MintDesktop.companion().debug.layout();
          return { hang: L.hang, open: L.open, mid };
        });
        check("  a pose from the app plays; arriving under a top taskbar it hangs, the open side follows", pz.hang === true && pz.open === 1, JSON.stringify(pz));
        await page.evaluate(() => window.__emit("mint://companion", { kind: "arrive", view: { stance: "stand", openSide: "left" } }));
        // the session bots
        const g = await page.evaluate(async () => {
          const cc = window.__mintCC;
          cc.S.sessions = ["Invoice audit", "Planning engine", "Freight quotes", "Label check", "Odoo dev"].map((n, i) => ({ session_id: "s" + i, name: n, status: i < 4 ? "waiting" : "busy", cwd: "/root/moni" }));
          await new Promise((r) => setTimeout(r, 1500));
          const n1 = window.MintDesktop.companion().regions().length, b1 = document.querySelectorAll(".dk-comp-kid").length;
          cc.S.sessions = cc.S.sessions.map((s) => Object.assign({}, s, { status: "busy" }));
          await new Promise((r) => setTimeout(r, 1500));
          return { n1, b1, n2: window.MintDesktop.companion().regions().length, b2: document.querySelectorAll(".dk-comp-kid").length };
        });
        check("  four sessions waiting: three session bots gather (each catches the mouse, a button with its name); back to work: they wander off", g.n1 === 4 && g.b1 === 3 && g.n2 === 1 && g.b2 === 0, JSON.stringify(g));
        // a click on the bot: its Peek
        await page.click("#dk-comp-hit");
        const clicked = await page.evaluate(() => window.__calls.some((c) => c[0] === "companion" && c[1].kind === "open"));
        check("a click on the bot asks the app to open its Command Center (companion: open)", clicked);
        await page.setViewportSize({ width: 1440, height: 860 });
        await page.evaluate(() => window.__emit("mint://state", { mode: "companion", peekOpen: true, companion: { stance: "stand", openSide: "left" } }));
        await page.waitForTimeout(400);
        const pk = await page.evaluate(() => { const regs = window.__calls.filter((c) => c[0] === "set_hit_regions").map((c) => c[1].regions); const r = regs[regs.length - 1]; return { mode: document.documentElement.getAttribute("data-dk-mode"), open: document.documentElement.classList.contains("dk-peek-open"), comp: document.getElementById("dk-comp").hidden, ccVis: getComputedStyle(document.getElementById("cc")).visibility, all: r && r.length === 1 && r[0].w === 1440 }; });
        check("  its Peek: laid out as Peek, the whole window catches the mouse, the bot's canvas away", pk.mode === "peek" && pk.open && pk.comp && pk.ccVis === "visible" && pk.all, JSON.stringify(pk));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
        check("  Esc asks the app to close it (hide_peek)", await page.evaluate(() => window.__calls.some((c) => c[0] === "hide_peek")));
        const csp = await page.evaluate(() => window.__csp);
        check("no page errors, no CSP violations", errs.length === 0 && csp.length === 0, JSON.stringify(errs.concat(csp)));
        await ctx.close();
        // holding still (battery saver, energy saver, full screen): one still frame, no loop
        const b = await open(Object.assign({}, HOST, { still: true }));
        const still = await b.page.evaluate(async () => { await new Promise((r) => setTimeout(r, 600)); const k = window.MintDesktop.companion().debug.core(); return { still: k.S.still, running: k.S.running }; });
        check("holding still: the bot draws one still frame and does not run its loop", still.still === true && still.running === false, JSON.stringify(still));
        check("  no page errors", b.errs.length === 0, JSON.stringify(b.errs));
        await b.ctx.close();
        // another mode: the companion stays away
        const f = await open({ mode: "floating", peekOpen: false }, 480, 860);
        const fl = await f.page.evaluate(() => ({ comp: document.getElementById("dk-comp").hidden, out: document.documentElement.classList.contains("dk-comp-out") }));
        check("Floating: no companion bot (its canvas hidden, nothing of it in the regions)", fl.comp && !fl.out, JSON.stringify(fl));
        await f.ctx.close();
      } finally {
        if (browser) await browser.close();
        s.stop();
      }
    }
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
