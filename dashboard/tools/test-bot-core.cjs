#!/usr/bin/env node
"use strict";
/**
 * Core E ("Bot", public/mint-core-bot.js): the head style and colour settings,
 * the state -> face / colour mapping, the renderer, the pickers.
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-bot-core.cjs
 *
 * Pure parts first (cc-logic.js: heads, presets, the derived theme shades and
 * their 3:1 contrast, the hex-only check, the too-close warning, the state
 * mapping; mint-core-bot.js: faces, blink, gaze, the speaking mouth, the head
 * buffers), then a scratch copy of the server over HTTP (POST
 * /mint-ai/api/prefs/bot: CSRF, permission, validation, audit, storage; the
 * page and the dock carry the choice), then headless Chromium: the Command
 * Center with core E in dark and light (no console or CSP error, a non-blank
 * canvas, states, offline, the sessions as heads, the 2D fallback), and
 * Settings ▸ Appearance (thumbnails, choosing a head, a preset, custom colours
 * with the warning, reset). Without PLAYWRIGHT the browser part is skipped.
 */
const scratch = require("./scratch-server.cjs"); // first: sets MONI_DATA_DIR
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 600) : "")); }
}
const section = (t) => console.log("\n" + t);
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const L = require(path.join(ROOT, "public", "cc-logic.js"));
const B = require(path.join(ROOT, "public", "mint-core-bot.js"));

(async () => {
  section("the setting (cc-logic.js)");
  const HEADS = ["cap", "headphones", "beanie", "goggles", "headset", "ears", "halo", "mortar", "antennas", "bowtie"];
  check("ten heads, the approved mockup's, in its order; the renderer has the same ten", JSON.stringify(Object.keys(L.BOT_HEADS)) === JSON.stringify(HEADS) && JSON.stringify(B.HEAD_IDS) === JSON.stringify(HEADS));
  check("a head reads as itself in any case; empty or unknown is cap", L.normBotHead("Goggles") === "goggles" && L.normBotHead("") === "cap" && L.normBotHead(null) === "cap" && L.normBotHead("x") === "cap");
  check("the API accepts exactly the ten names", HEADS.every((h) => L.isBotHead(h)) && !L.isBotHead("Cap") && !L.isBotHead("") && !L.isBotHead(null) && !L.isBotHead(["cap"]));
  const D = L.BOT_PRESETS.default;
  check("Default is the approved set, dark and light", JSON.stringify(D.dark) === JSON.stringify({ ready: "#00E6A5", listening: "#38D6FF", thinking: "#966EFF", speaking: "#FF5AC8", needs: "#FFBE3C", error: "#FF5050", wire: "#E1E8F8" }) && JSON.stringify(D.light) === JSON.stringify({ ready: "#00785A", listening: "#006EAA", thinking: "#6D2BC8", speaking: "#BE1E8C", needs: "#B46900", error: "#C81E1E", wire: "#262E40" }));
  check("presets: Default, Mint only, Mono, Ocean, Sunset", JSON.stringify(Object.keys(L.BOT_PRESETS).map((k) => L.BOT_PRESETS[k].name)) === JSON.stringify(["Default", "Mint only", "Mono", "Ocean", "Sunset"]));
  const pD = L.botPalette({ p: "mint" }, false), pM = L.botPalette({ p: "mono" }, false), pMl = L.botPalette({ p: "mono" }, true);
  check("Mint only: every state mint (the face tells them apart)", L.BOT_STATE_ITEMS.every((k) => L.rgbHex(pD[k]) === "#00E6A5"));
  check("Mono: white in dark, black in light", L.BOT_STATE_ITEMS.every((k) => L.rgbHex(pM[k]) === "#FFFFFF" && L.rgbHex(pMl[k]) === "#0A0A0A"));
  const hue = (hex) => { const [r, g, b] = L.hexRgb(hex).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return 0; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; return h < 0 ? h + 360 : h; };
  check("Ocean and Sunset keep needs-you warm and error red", ["ocean", "sunset"].every((p) => { const b = L.BOT_PRESETS[p].base, hn = hue(b.needs), he = hue(b.error); return hn >= 25 && hn <= 50 && (he <= 12 || he >= 340); }), ["ocean", "sunset"].map((p) => hue(L.BOT_PRESETS[p].base.needs).toFixed(0) + "/" + hue(L.BOT_PRESETS[p].base.error).toFixed(0)).join(" "));
  check("Default, Ocean and Sunset: no two state colours too close (either theme)", ["default", "ocean", "sunset"].every((p) => L.botClosePairs({ p }).length === 0), ["default", "ocean", "sunset"].map((p) => JSON.stringify(L.botClosePairs({ p }))).join(" "));
  check("every preset reaches 3:1 on its background in both themes", Object.keys(L.BOT_PRESETS).every((p) => [false, true].every((lt) => L.BOT_STATE_ITEMS.every((k) => L.contrast(L.botPalette({ p }, lt)[k], lt ? L.BOT_BG.light : L.BOT_BG.dark) >= 2.95))));

  section("custom colours: the derived shades");
  let rs = 12345;
  const rnd = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };
  let worst = 99, bad = [];
  for (let i = 0; i < 400; i++) {
    const hex = L.rgbHex([rnd() * 255, rnd() * 255, rnd() * 255]);
    const d = L.botShade(hex, "dark"), l = L.botShade(hex, "light");
    const cd = L.contrast(d, L.BOT_BG.dark), cl = L.contrast(l, L.BOT_BG.light);
    worst = Math.min(worst, cd, cl);
    if (cd < 2.98 || cl < 2.98) bad.push(hex + " " + d + " " + cd.toFixed(2) + " " + l + " " + cl.toFixed(2));
  }
  check("any colour: its dark shade reaches 3:1 on the dark background, its light shade 3:1 on the light one (400 random)", !bad.length, bad.slice(0, 5).join("; ") + " worst " + worst);
  check("a colour that already reaches 3:1 is kept as picked", L.botShade("#00E6A5", "dark") === "#00E6A5" && L.botShade("#6D2BC8", "light") === "#6D2BC8");
  const lum = (h) => { const [r, g, b] = L.hexRgb(h); return r + g + b; };
  check("too dark on dark: lightened; too light on light: darkened (same hue family)", lum(L.botShade("#202040", "dark")) > lum("#202040") && lum(L.botShade("#FFFF66", "light")) < lum("#FFFF66") && Math.abs(hue(L.botShade("#FFFF66", "light")) - hue("#FFFF66")) < 6);
  const cust = { p: "custom", c: { ready: "#00E6A5", listening: "#10D8A8", thinking: "#966EFF", speaking: "#FF5AC8", needs: "#FFBE3C", error: "#FF5050", wire: "#E1E8F8" } };
  check("two state colours close together are named (ready and listening)", JSON.stringify(L.botClosePairs(cust)) === JSON.stringify([["ready", "listening"]]), JSON.stringify(L.botClosePairs(cust)));
  check("custom palette: each item is its derived shade per theme", L.rgbHex(L.botPalette(cust, true).ready) === L.botShade("#00E6A5", "light") && L.rgbHex(L.botPalette(cust, false).wire) === L.botShade("#E1E8F8", "dark"));

  section("validation (hex only)");
  const ok = (v) => L.checkBotColors(v).ok;
  check("a preset alone is fine", ok({ preset: "mono" }) && L.checkBotColors({ preset: "mono" }).value.p === "mono");
  check("an unknown preset, a non-object, an array: refused", !ok({ preset: "neon" }) && !ok("default") && !ok(null) && !ok([1]) && !ok({ preset: 3 }));
  const full = Object.assign({}, cust.c);
  check("custom with all seven #rrggbb: accepted, stored upper-case", ok({ preset: "custom", custom: full }) && L.checkBotColors({ preset: "custom", custom: Object.assign({}, full, { ready: "#abcdef" }) }).value.c.ready === "#ABCDEF");
  check("custom refuses names, short hex, bad digits, url / script, unknown items, missing items", ["red", "#fff", "#12345g", "javascript:alert(1)", "#00E6A5;x", "rgb(1,2,3)", 7, null].every((v) => !ok({ preset: "custom", custom: Object.assign({}, full, { ready: v }) })) && !ok({ preset: "custom", custom: Object.assign({}, full, { glow: "#000000" }) }) && !ok({ preset: "custom", custom: { ready: "#000000" } }));
  check("stored form: a preset keeps no colours; custom keeps all seven", L.botColorsJson({ p: "ocean" }) === '{"p":"ocean"}' && Object.keys(JSON.parse(L.botColorsJson(cust)).c).length === 7);
  check("a stored value that is not JSON (or hostile) reads as Default", L.normBotColors("{oops").p === "default" && L.normBotColors('{"p":"custom","c":{"ready":"</script>"}}').c.ready === "#00E6A5");
  check("audit line names the preset, or every custom colour", L.botColorsLine({ p: "sunset" }) === "Sunset" && /^Custom \(ready #00E6A5, listening #10D8A8/.test(L.botColorsLine(cust)));

  section("state -> face and colour");
  const F = { idle: ["ready", "base"], listening: ["listening", "listen"], thinking: ["thinking", "focus"], speaking: ["speaking", "speak"], needs: ["needs", "pupils"], delegating: ["thinking", "base"], offline: ["error", "err"] };
  check("the core: ready smile, listening wide eyes, thinking brows, speaking waveform, needs pupils, delegating in thinking's colour, offline x x", Object.keys(F).every((s) => L.botFace(s).state === F[s][0] && L.botFace(s).face === F[s][1] && B.coreFace(s === "offline" ? "idle" : s, s === "offline").face === F[s][1]));
  const SS = [[{ st: "waiting" }, "needs", "pupils"], [{ st: "working" }, "thinking", "focus"], [{ st: "idle" }, "ready", "base"], [{ st: "idle", catchK: 0.6 }, "listening", "listen"], [{ st: "idle", glow: 0.8 }, "speaking", "speak"], [{ st: "idle", bloom: 0.9 }, "ready", "grin"], [{ st: "waiting", catchK: 1 }, "needs", "pupils"]];
  check("a session: waiting -> needs you, working -> thinking, idle -> ready, a delegation landing -> listening, a reply -> speaking, done -> a grin; needs you wins", SS.every(([k, s, f]) => L.botSessState(k).state === s && L.botSessState(k).face === f));

  section("the renderer's pure parts (mint-core-bot.js)");
  const lit = (an, amp) => { const w = new Uint8Array(B.NF); B.weights(an, w, 0, amp || 0); let n = 0; for (const v of w) if (v > 127) n++; return { n, w }; };
  const mk = (face) => { const a = new B.Anim(3); a.set(face, "ready"); a.settle(); return a; };
  const faceN = {};
  Object.keys(B.FMAP).forEach((f) => { faceN[f] = lit(mk(f)).n; });
  check("every face lights nodes of the 19 x 19 front grid", Object.values(faceN).every((n) => n > 10), JSON.stringify(faceN));
  check("the faces are the mockup's maps (base / listen / focus / speak / pupils / err / grin)", ["base", "listen", "focus", "speak", "pupils", "err", "grin"].every((f) => B.FMAP[f]) && B.FMAP.err[1] === "..c...c....c...c..");
  const bl = mk("listen"); bl.blinkP = 0.5; const open = lit(mk("listen")).n, shut = lit(bl).n;
  check("a blink collapses the eyes to a line", shut < open * 0.6 && shut > 0, open + " -> " + shut);
  const g0 = lit(mk("base")).w, ga = mk("base"); ga.gx = 2; const g2 = lit(ga).w;
  let moved = 0; for (let i = 0; i < B.NF; i++) if ((g0[i] > 127) !== (g2[i] > 127)) moved++;
  check("a glance / gaze moves the eyes on the grid (not the mouth)", moved > 10, moved);
  const sp = mk("speak"); const q = lit(sp, 0).n, loud = lit(sp, 1).n;
  check("speaking: a flat mouth when silent, a waveform with the voice level", loud > q + 4, q + " -> " + loud);
  const fx = mk("base"); fx.set("pupils", "needs"); fx.fk = 0.5; const mid = lit(fx).w; let half = 0; for (const v of mid) if (v > 40 && v < 215) half++;
  check("a face change cross-fades (half-lit nodes mid-way), never a pop", half > 10, half);
  const sizes = HEADS.map((h) => { const hi = B.build(h, "hi"), lo = B.build(h, "lo"); return [h, hi.n, lo.n, hi.front.length, lo.front.length, hi.lines.length % 2, hi.seg.length > 0, lo.seg.length]; });
  check("each head builds (hi for the core, lo for sessions and the dock): < 65,536 vertices, 361 face nodes, line pairs", sizes.every((x) => x[1] < 65536 && x[3] === 361 && x[4] === 361 && x[5] === 0 && x[6] && x[7] === 0 && x[2] < x[1]), JSON.stringify(sizes));
  check("lit accessories: the twin antennas' joints and the mortarboard's tassel take the state colour; the cap's antenna joints stay neutral", (() => { const k = (h) => { const g = B.build(h, "hi"); const c = {}; for (let i = 0; i < g.n; i++) c[g.v[i * 7 + 3]] = (c[g.v[i * 7 + 3]] || 0) + 1; return c; }; return k("antennas")[4] === 4 && k("mortar")[4] === 2 && !k("cap")[4] && k("cap")[3] === 3 && k("headset")[2] > 50; })());
  const src = read("public/mint-core-bot.js");
  check("no eval, no inline style, no CDN; WebGL2 with a 2D fallback; stops when hidden; reduced motion; a resolution guard", !/\beval\(|new Function|\.style\.|setAttribute\("style"|https?:\/\//.test(src.replace(/\/\*[\s\S]*?\*\//g, "")) && /getContext\("webgl2"/.test(src) && /getContext\("2d"\)/.test(src) && /visibilitychange/.test(src) && /prefers-reduced-motion: reduce/.test(src) && /S\.lowRes = true/.test(src));
  check("the same instance API as core D (cc-map, the shell's flight, the dock, the desktop app drive both)", ["setState", "setLight", "resize", "start", "stop", "still", "stats", "draw", "destroy", "setConcept", "place", "tick", "adopt", "setHead", "setColors", "setOffline"].every((m) => new RegExp("\\b" + m + ": ").test(src)) && /concept: "E"/.test(src));
  check("no per-frame allocation in the hot path: weights into one Uint8Array, a fixed pool of heads", /var W8 = new Uint8Array\(NF \* ROWS\)/.test(src) && /var POOL = \[\];/.test(src) && /texSubImage2D\(gl\.TEXTURE_2D, 0, 0, 0, NF, ROWS, gl\.RED, gl\.UNSIGNED_BYTE, W8\)/.test(src));

  section("the views");
  const views = require(path.join(ROOT, "lib", "views-moniai.js"));
  const rbac = require(path.join(ROOT, "lib", "rbac.js"));
  const admin = rbac.actor({ permissions: ["*"] });
  const pageFor = (o) => views.page(Object.assign({ csrf: "t", user: { name: "a", perm: admin }, voice: { configured: true, voice: "marin", manage: true } }, o));
  const pg = pageFor({ core: "E", botHead: "goggles", botColors: '{"p":"mono"}' });
  check("the page carries core E, its head and colours on #cc before first paint", /data-core="E"/.test(pg) && /data-bot-head="goggles"/.test(pg) && /data-bot-colors="\{&quot;p&quot;:&quot;mono&quot;\}"/.test(pg));
  const evil = pageFor({ core: "E", botHead: '"><script>', botColors: '{"p":"custom","c":{"ready":"\\"><img src=x onerror=1>"}}' });
  check("a hostile stored value cannot reach the markup", !/"><script>/.test(evil) && !/<img src=x/.test(evil) && /data-bot-head="cap"/.test(evil));
  check("the page loads the bot renderer, and the dock gets the same core", /mint-core-bot\.js\?v=/.test(pg) && /id="mint-dock-root" data-core="E" data-bot-head="goggles"/.test(pg));
  const ap = views.appearance({ csrf: "x", core: "E", botHead: "halo", botColors: JSON.stringify(cust) });
  check("Appearance: ten head options with a thumbnail canvas each, the saved one checked", (ap.html.match(/name="bot_head" value="/g) || []).length === 10 && /value="halo" checked/.test(ap.html) && (ap.html.match(/data-bot-thumb="/g) || []).length === 10);
  check("Appearance: five presets + Custom (checked), seven colour pickers with their dark / light shade, reset, the warning, the six states in both themes", (ap.html.match(/name="bot_preset" value="/g) || []).length === 6 && /value="custom" checked/.test(ap.html) && (ap.html.match(/type="color"/g) || []).length === 7 && (ap.html.match(/data-shade="/g) || []).length === 14 && /id="mint-bot-reset"/.test(ap.html) && /id="mint-bot-warn"/.test(ap.html) && (ap.html.match(/data-bot-state="/g) || []).length === 12);
  check("Appearance: no inline style or handler (swatches are painted through the CSSOM)", !/\sstyle\s*=|\son[a-z]+\s*=/i.test(ap.html) && /data-swatch="#00E6A5"/.test(ap.html));

  /* ------------------------------------------------------------- over HTTP --- */
  section("over HTTP (a scratch copy)");
  const s = await scratch.startScratch({});
  const db = require(path.join(ROOT, "lib", "db.js"));
  let browser = null;
  try {
    await s.makeUser("botadmin", "administrator");
    await s.makeUser("botviewer", "viewer");
    const A = await s.signIn("botadmin");
    const V = await s.signIn("botviewer");
    let r = await s.req("GET", "/mint-ai", { cookie: A.cookie });
    const tok = s.csrfOf(r.body);
    check("never chosen: the page says cap and Default", /data-bot-head="cap"/.test(r.body) && /data-bot-colors="\{&quot;p&quot;:&quot;default&quot;\}"/.test(r.body));
    const post = (who, body, token) => s.req("POST", "/mint-ai/api/prefs/bot", { cookie: who.cookie, headers: Object.assign({ Accept: "application/json" }, token ? { "X-CSRF-Token": token } : {}), body });
    r = await post(A, { head: "halo" });
    check("without the CSRF token: refused (403)", r.status === 403, r.status);
    r = await post(A, { head: "robot" }, tok);
    check("an unknown head: refused (400)", r.status === 400 && /The head must be one of/.test(r.body), r.status + " " + r.body);
    r = await post(A, { colors: { preset: "custom", custom: Object.assign({}, full, { ready: "red" }) } }, tok);
    check("a colour that is not #rrggbb: refused (400), nothing saved", r.status === 400 && /hex/.test(r.body) && db.getUserByName("botadmin").mint_bot_colors === "", r.status + " " + r.body);
    r = await post(A, {}, tok);
    check("nothing to set: refused (400)", r.status === 400, r.status);
    r = await post(A, { head: "halo" }, tok);
    check("a head: saved", r.status === 200 && JSON.parse(r.body).head === "halo" && db.getUserByName("botadmin").mint_bot_head === "halo", r.body);
    r = await post(A, { colors: { preset: "ocean" } }, tok);
    check("a preset: saved (compact)", r.status === 200 && db.getUserByName("botadmin").mint_bot_colors === '{"p":"ocean"}' && JSON.parse(r.body).colorsName === "Ocean", r.body);
    r = await post(A, { colors: { preset: "custom", custom: cust.c } }, tok);
    const j = JSON.parse(r.body);
    check("custom colours: saved, and the answer names the close pair", r.status === 200 && JSON.parse(db.getUserByName("botadmin").mint_bot_colors).c.listening === "#10D8A8" && JSON.stringify(j.close) === '[["ready","listening"]]', r.body);
    const rows = db.recentLogins(50).filter((x) => x.outcome === "account" && /MINT AI bot/.test(x.detail || ""));
    check("audited: head and colours, who and what", rows.some((x) => x.username === "botadmin" && /MINT AI bot head cap -> halo \(Halo\)/.test(x.detail)) && rows.some((x) => /MINT AI bot colours Default -> Ocean/.test(x.detail)) && rows.some((x) => /MINT AI bot colours Ocean -> Custom \(ready #00E6A5/.test(x.detail)), JSON.stringify(rows.map((x) => x.detail)));
    const vt = s.csrfOf((await s.req("GET", "/account", { cookie: V.cookie })).body);
    r = await post(V, { head: "halo" }, vt);
    check("a viewer cannot set it (403)", r.status === 403 && db.getUserByName("botviewer").mint_bot_head === "", r.status);
    r = await s.req("POST", "/mint-ai/api/prefs/bot", { headers: { Accept: "application/json" }, body: { head: "halo" } });
    check("signed out: 401", r.status === 401, r.status);
    await s.req("POST", "/mint-ai/api/prefs/core", { cookie: A.cookie, headers: { Accept: "application/json", "X-CSRF-Token": tok }, body: { core: "E" } });
    r = await s.req("GET", "/mint-ai", { cookie: A.cookie });
    check("the Command Center then draws E with the saved head and colours", /id="cc"\s+data-core="E"/.test(r.body) && /data-bot-head="halo"/.test(r.body) && /&quot;listening&quot;:&quot;#10D8A8&quot;/.test(r.body));
    r = await s.req("GET", "/account", { cookie: A.cookie });
    const at = (f) => r.body.indexOf("/static/" + f + "?v=");
    check("on other pages the dock is the bot too (cc-logic + mint-core-bot loaded before mint-dock)", /id="mint-dock-root" data-core="E" data-bot-head="halo"/.test(r.body) && at("cc-logic.js") > 0 && at("cc-logic.js") < at("mint-core-bot.js") && at("mint-core-bot.js") < at("mint-dock.js"), (r.body.match(/<script src="[^"]+"/g) || []).join(" "));
    r = await s.req("GET", "/mint-ai/settings/appearance", { cookie: A.cookie });
    const st = s.csrfOf(r.body);
    check("Settings ▸ Appearance: the bot row, its scripts", /id="a-bot"/.test(r.body) && /mint-core-bot\.js\?v=/.test(r.body) && /cc-logic\.js\?v=/.test(r.body) && /value="halo" checked/.test(r.body));
    r = await s.req("POST", "/account/appearance", { cookie: A.cookie, body: new URLSearchParams({ _csrf: st, core: "E", bot_head: "beanie", bot_preset: "sunset" }).toString() });
    check("without JavaScript the form saves the head and the preset", r.status === 302 && db.getUserByName("botadmin").mint_bot_head === "beanie" && db.getUserByName("botadmin").mint_bot_colors === '{"p":"sunset"}', r.status + " " + r.headers.location);
    r = await s.req("POST", "/account/appearance", { cookie: A.cookie, body: new URLSearchParams({ _csrf: st, core: "E", bot_head: "zeppelin" }).toString() });
    check("…and refuses an unknown head", r.status === 302 && /err=/.test(r.headers.location) && db.getUserByName("botadmin").mint_bot_head === "beanie", r.headers.location);

    /* ------------------------------------------------------------- in the browser --- */
    let chromium = null;
    try { chromium = require(process.env.PLAYWRIGHT || "playwright").chromium; } catch (e) { chromium = null; }
    if (!chromium) { console.log("\n(browser part skipped: set PLAYWRIGHT=/path/to/node_modules/playwright)"); }
    else {
      section("in the browser");
      browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
      const errs = [];
      async function open(theme, p, W, H) {
        const ctx = await browser.newContext({ viewport: { width: W || 1440, height: H || 900 }, colorScheme: theme, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addCookies(String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push(theme + " " + p + ": " + e.message));
        page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(theme + " " + p + ": " + t); });
        await page.goto("http://127.0.0.1:" + s.port + p, { waitUntil: "load" });
        return { ctx, page };
      }
      const nonBlank = (page) => page.evaluate(() => new Promise((res) => window.__mintCC.orbit.sample((cv) => {
        const c = document.createElement("canvas"); c.width = 160; c.height = 100; const g = c.getContext("2d"); g.drawImage(cv, 0, 0, 160, 100);
        const d = g.getImageData(0, 0, 160, 100).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++; res(n);
      })));
      db.setUserBotColors(db.getUserByName("botadmin").id, "");
      for (const theme of ["dark", "light"]) {
        const { ctx, page } = await open(theme, "/mint-ai");
        await page.waitForFunction(() => window.__mintCC && window.__mintCC.core && window.__mintCC.core.S.concept === "E", null, { timeout: 15000 }).catch(() => {});
        const info = await page.evaluate(() => ({ c: window.__mintCC.core.S.concept, gl: window.__mintCC.core.isGL, head: window.__mintCC.core.S.head, light: window.__mintCC.core.S.lightT, data: document.getElementById("cc").getAttribute("data-core") }));
        check(theme + ": core E runs on WebGL2 with the saved head, in the page's theme", info.c === "E" && info.gl && info.head === "beanie" && info.data === "E" && info.light === (theme === "light" ? 1 : 0), JSON.stringify(info));
        const offl = await page.waitForFunction(() => window.__mintCC.core.S.offline === true, null, { timeout: 8000 }).then(() => true).catch(() => false);
        check(theme + ": the page itself shows the x x face once MINT AI is known to be unreachable (this copy has no supervisor)", offl);
        await page.waitForTimeout(300);
        const n = await nonBlank(page);
        check(theme + ": the canvas is drawn (not blank)", n > 300, n);
        await page.evaluate(() => {
          // the scratch copy has no supervisor: the page is offline (the bot's x x face); the test drives the state itself from here
          const O = window.__mintCC.orbit; document.getElementById("cc-offline").hidden = true; O._s = O.setState; O.setState = function () {}; O.setOffline = function () {};
          window.__mintCC.core.setOffline(false);
          O.setNodes([{ id: "a", label: "One", st: "working", act: 4 }, { id: "b", label: "Two", st: "waiting", act: 2 }, { id: "c", label: "Three", st: "idle", act: 1, hired: true }]);
        });
        await page.waitForTimeout(400);
        const fam = await page.evaluate(() => { const f = window.__mintCC.orbit.family; const k = f.kids(); return { n: k.length, mesh: f.meshKids() ? f.meshKids().length : -1, keys: (f.meshKids() || []).map((x) => x.key + ":" + x.st).join(",") }; });
        check(theme + ": the sessions are handed to the core as heads (meshKids with key and state)", fam.n === 3 && fam.mesh === 3 && fam.keys === "a:working,b:waiting,c:idle", JSON.stringify(fam));
        const states = [];
        for (const sname of ["listening", "thinking", "speaking", "needs", "delegating", "idle"]) {
          await page.evaluate((x) => window.__mintCC.orbit._s(x), sname);
          await page.waitForTimeout(250);
          states.push(await page.evaluate(() => window.__mintCC.core.S.state + ":" + window.__mintCC.core._anim().face + ":" + window.__mintCC.core._anim().col));
        }
        check(theme + ": each state shows its face and colour", states.join(" ") === "listening:listen:listening thinking:focus:thinking speaking:speak:speaking needs:pupils:needs delegating:base:thinking idle:base:ready", states.join(" "));
        await page.evaluate(() => window.__mintCC.core.setOffline(true));
        await page.waitForTimeout(200);
        check(theme + ": offline: the red x x", await page.evaluate(() => window.__mintCC.core._anim().face === "err" && window.__mintCC.core._anim().col === "error"));
        await page.evaluate(() => window.__mintCC.core.setOffline(false));
        // a live change of head and colours (the setting reaching an open page)
        await page.evaluate(() => window.__mintCC.orbit.setBot("antennas", { p: "mono" }));
        check(theme + ": head and colours switch in place (no new canvas)", await page.evaluate(() => window.__mintCC.core.S.head === "antennas" && document.getElementById("cc").getAttribute("data-bot-head") === "antennas"));
        // a change saved in Settings in another tab (or the shell's frame) arrives as a storage event
        await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "mint-bot", newValue: JSON.stringify({ head: "halo", colors: { p: "sunset" } }) })));
        check(theme + ": a change made in Settings elsewhere reaches the open page (storage event)", await page.evaluate(() => window.__mintCC.core.S.head === "halo" && /sunset/.test(document.getElementById("cc").getAttribute("data-bot-colors"))));
        await page.evaluate(() => window.__mintCC.orbit.setBot("antennas", { p: "mono" }));
        // switching to D and back to E swaps the renderer on a fresh canvas
        await page.evaluate(() => window.__mintCC.orbit.setConcept("D"));
        const dOk = await page.evaluate(() => window.__mintCC.core.S.concept === "D");
        await page.evaluate(() => window.__mintCC.orbit.setConcept("E"));
        check(theme + ": E -> D -> E swaps the renderer and keeps the head", dOk && (await page.evaluate(() => window.__mintCC.core.S.concept === "E" && window.__mintCC.core.S.head === "antennas")));
        // the 2D fallback draws too
        const n2 = await page.evaluate(() => { const cv = document.createElement("canvas"); cv.style.width = "300px"; document.body.appendChild(cv); const k = window.MintCoreBot(cv, { force2d: true, head: "goggles" }); k.resize(150, 150, 100, 300, 300); k.setState("needs"); k.still(); const g = cv.getContext("2d"), d = g.getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++; k.destroy(); cv.remove(); return n; });
        check(theme + ": without WebGL2 the 2D renderer draws the head", n2 > 1000, n2);
        // reduced motion / hold still: one still frame per change
        const still = await page.evaluate(() => new Promise((res) => { const k = window.__mintCC.core; k.setOffline(false); k.S.still = true; k.stop(); k.resetStats(); k.setState("speaking"); setTimeout(() => res({ running: k.S.running, frames: k.S.frames.length, face: k._anim().face, fk: k._anim().fk }), 400); }));
        check(theme + ": hold still: no loop, the new state drawn at once (face fully there)", !still.running && still.frames === 0 && still.face === "speak" && still.fk === 1, JSON.stringify(still));
        await ctx.close();
      }
      // prefers-reduced-motion: no loop, a still frame per change
      {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", reducedMotion: "reduce", extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addCookies(String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push("reduced: " + e.message));
        await page.goto("http://127.0.0.1:" + s.port + "/mint-ai", { waitUntil: "load" });
        await page.waitForTimeout(1200);
        const rm = await page.evaluate(() => ({ c: window.__mintCC.core.S.concept, still: window.__mintCC.core.S.still, running: window.__mintCC.core.S.running, frames: window.__mintCC.core.S.frames.length }));
        const n = await nonBlank(page);
        check("reduced motion: still frames only (no loop), and the head is drawn", rm.c === "E" && rm.still && !rm.running && rm.frames === 0 && n > 300, JSON.stringify(rm) + " lit " + n);
        await ctx.close();
      }
      // Settings ▸ Appearance
      {
        db.setUserBotColors(db.getUserByName("botadmin").id, "");
        const { ctx, page } = await open("dark", "/mint-ai/settings/appearance", 1440, 1400);
        await page.waitForTimeout(600);
        const vis = await page.evaluate(() => ({ e: document.getElementById("mint-appearance").classList.contains("core-e"), shown: getComputedStyle(document.getElementById("mint-bot")).display !== "none" }));
        check("Settings: the bot section shows while E is chosen", vis.e && vis.shown, JSON.stringify(vis));
        const thumbs = await page.evaluate(() => Array.from(document.querySelectorAll("canvas[data-bot-thumb]")).map((c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++; return n; }));
        check("Settings: ten head thumbnails drawn", thumbs.length === 10 && thumbs.every((n) => n > 200), thumbs.join(","));
        await page.click('[data-bot-head-opt="goggles"]');
        await page.waitForTimeout(400);
        check("Settings: choosing a head saves it at once", db.getUserByName("botadmin").mint_bot_head === "goggles");
        await page.click('[data-bot-preset-opt="mint"]');
        await page.waitForTimeout(400);
        check("Settings: choosing a preset saves it", db.getUserByName("botadmin").mint_bot_colors === '{"p":"mint"}');
        await page.click('[data-bot-preset-opt="custom"]');
        await page.waitForTimeout(300);
        const shown = await page.evaluate(() => !document.getElementById("mint-bot-custom").hidden);
        await page.evaluate(() => { const i = document.querySelector('input[data-bot-item="listening"]'); i.value = "#00e8a8"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); });
        await page.waitForTimeout(500);
        const saved = JSON.parse(db.getUserByName("botadmin").mint_bot_colors || "{}");
        const warn = await page.evaluate(() => ({ hidden: document.getElementById("mint-bot-warn").hidden, text: document.getElementById("mint-bot-warn").textContent, shade: document.querySelector('[data-shade="listening:light"]').style.background }));
        check("Settings: Custom opens the pickers; a pick saves custom colours (hex)", shown && saved.p === "custom" && saved.c && saved.c.listening === "#00E8A8", JSON.stringify(saved));
        check("Settings: two colours too close: the warning names them; the derived light shade is shown", !warn.hidden && /Ready and Listening/.test(warn.text) && /rgb\(/.test(warn.shade), JSON.stringify(warn));
        await page.selectOption("#mint-bot-reset-from", "default");
        await page.click("#mint-bot-reset");
        await page.waitForTimeout(400);
        const reset = JSON.parse(db.getUserByName("botadmin").mint_bot_colors || "{}");
        check("Settings: reset to a preset puts its colours back in the pickers (and saves them)", reset.p === "custom" && reset.c.listening === "#38D6FF" && (await page.evaluate(() => document.getElementById("mint-bot-warn").hidden)), JSON.stringify(reset));
        await page.click('[data-core-opt="D"]');
        await page.waitForTimeout(300);
        check("Settings: with another core the bot section hides", await page.evaluate(() => getComputedStyle(document.getElementById("mint-bot")).display === "none"));
        await ctx.close();
      }
      check("no page error, console error or CSP violation anywhere", !errs.length, errs.join("\n"));
    }
  } catch (e) {
    check("the run completed", false, e.stack + "\n" + s.out());
  } finally {
    if (browser) await browser.close();
    s.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
