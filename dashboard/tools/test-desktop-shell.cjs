#!/usr/bin/env node
"use strict";
/**
 * The MINT AI desktop app's server side (lib/desktop.js, the ?shell=desktop
 * render mode, the desktop sign-in pages, the update feed) and its page side
 * (public/mint-desktop-layout.js, public/mint-desktop.js).
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-desktop-shell.cjs [--shots DIR]
 *
 * Pure parts first (the layouts, the hit regions, the session length, the
 * one-time codes); then a scratch copy of the real server.js
 * (tools/scratch-server.cjs: the helper is blocked, the data dir is a temp
 * dir) over HTTP; then headless Chromium with a transparent background: the
 * three modes, focus mode, both inks, at the app's window sizes, plus the
 * download page at 1440 and 390, with zero CSP violations and page errors.
 * The browser's user agent carries "MintDesktop/0.1.0", as the app's does.
 */
const scratch = require("./scratch-server.cjs"); // first: sets MONI_DATA_DIR
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const LAY = require(path.join(ROOT, "public", "mint-desktop-layout.js"));
const DK = require(path.join(ROOT, "lib", "desktop.js"));
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? process.argv[i + 1] : null; })();
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 MintDesktop/0.1.0";
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

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

(async () => {
  section("the layouts (public/mint-desktop-layout.js): the mockup's numbers");
  {
    const ws = LAY.windowSize({ mode: "floating", size: "M" });
    check("Floating M: a 480 x 580 box with 280 px of headroom above it for the card", ws.w === 480 && ws.h === 860 && ws.box.h === 580);
    check("  S and L scale it (0.8 / 1.22); focus mode is the core alone, 168 px, no headroom", LAY.windowSize({ size: "S" }).w === 384 && LAY.windowSize({ size: "L" }).w === 586 && LAY.windowSize({ focus: true }).w === 168 && LAY.windowSize({ focus: true }).h === 168);
    const f = LAY.layout({ mode: "floating", size: "M", W: 480, H: 860 });
    check("  the box sits at the bottom of the window; the core 36 % down it, radius 16.3 % of its width", f.box.y === 280 && near(f.cy, 280 + 580 * 0.36) && near(f.R, 480 * 0.163) && f.cx === 240);
    check("  the composer at the bottom of the box, 14 px in; the chat between core and composer; two exchanges", f.composer.y === 280 + 580 - 14 - 48 && f.composer.w === 452 && f.chat.y > f.cy + f.R && f.chat.y + f.chat.h <= f.composer.y && f.keep === 2);
    check("  the card in the headroom, 10 px above the box, never over the core", f.card.bottom === 860 - 280 + 10 && f.card.y + f.card.h <= 280);
    const d = LAY.layout({ mode: "desktop", W: 1920, H: 1032 });
    check("Desktop layer: core 170 px at 56 % across (right), 42 % down; three exchanges", near(d.R, 170) && near(d.cx, 1920 * 0.56) && near(d.cy, 1032 * 0.42) && d.keep === 3 && d.tools === null);
    check("  left / centre presets move it; the card top right", near(LAY.layout({ mode: "desktop", pos: "left", W: 1920, H: 1032 }).cx, 1920 * 0.36) && near(LAY.layout({ mode: "desktop", pos: "centre", W: 1920, H: 1032 }).cx, 960) && d.card.x === 1920 - 16 - 330 && d.card.y === 72);
    const p = LAY.layout({ mode: "peek", W: 1366, H: 720 });
    check("Peek: centred, 180 px, 40 % down; a 620 px composer under the core", p.cx === 683 && near(p.R, 180) && near(p.cy, 288) && p.composer.w === 620 && p.composer.y > p.cy + p.R);
    const tiny = LAY.layout({ mode: "desktop", W: 1024, H: 560 });
    check("  a small screen: the composer stays on screen and below the core", tiny.composer.y + tiny.composer.h <= 560 && tiny.composer.y > tiny.cy + tiny.R);
    const rg = LAY.regions(f, [{ left: 10, top: 10, width: 20, height: 10 }, { left: 0, top: 0, width: 0, height: 9 }, { left: 470, top: 850, width: 50, height: 50, r: 4 }]);
    check("the hit regions: the core as a circle first, empty boxes dropped, the rest clipped to the window", rg.length === 3 && rg[0].r === Math.round(f.R) && rg[0].w === rg[0].h && rg[2].x === 470 && rg[2].w === 10 && rg[2].h === 10);
    check("  'all': the whole window (Peek while it shows, a dialog open)", JSON.stringify(LAY.regions(f, [], { all: true })) === JSON.stringify([{ x: 0, y: 0, w: 480, h: 860, r: 0 }]));
    // The host sizes the Floating window with the same numbers.
    const rs = fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "src", "layout.rs"), "utf8");
    check("  the app's own sizes (desktop/src-tauri/src/layout.rs) are the same: 480 x 580, 168, headroom 280, S/M/L", /BOX_W:\s*f64\s*=\s*480\.0/.test(rs) && /BOX_H:\s*f64\s*=\s*580\.0/.test(rs) && /FOCUS:\s*f64\s*=\s*168\.0/.test(rs) && /HEADROOM:\s*f64\s*=\s*280\.0/.test(rs) && /0\.8/.test(rs) && /1\.22/.test(rs));
  }

  section("lib/desktop.js: the app's user agent, session length, one-time codes");
  {
    check("the app is told from a browser by MintDesktop/<version> only", DK.appVersion({ headers: { "user-agent": APP_UA } }) === "0.1.0" && !DK.isApp({ headers: { "user-agent": WEB_UA } }) && !DK.isApp({ headers: { "user-agent": "MintDesktop/x" } }));
    check("days: whole, 1 to 90", DK.cleanDays("14") === 14 && DK.cleanDays(1) === 1 && DK.cleanDays(90) === 90 && DK.cleanDays(0) === null && DK.cleanDays(91) === null && DK.cleanDays("7.5") === null && DK.cleanDays("x") === null);
    const store = {};
    const fakeDb = { getSetting: (k, f) => (k in store ? store[k] : f), setSetting: (k, v) => (store[k] = v) };
    let t = 1_000_000_000_000;
    const d = DK.create({ db: fakeDb, dir: null, now: () => t });
    check("14 days by default; a setting changes it, a bad one does not", d.days() === 14 && d.setDays(30, "x") && d.days() === 30 && !d.setDays(500) && d.days() === 30);
    d.setDays(14);
    const mkReq = (ua) => ({ headers: { "user-agent": ua }, get: (h) => (h.toLowerCase() === "user-agent" ? ua : ""), session: { authed: true, authAt: t, cookie: { maxAge: 8 * 3600e3 } } });
    const rq = mkReq(APP_UA);
    check("a sign-in in the app: a desktop session of 14 days", d.markSession(rq) && rq.session.desktop && rq.session.cookie.maxAge === 14 * 86400e3);
    const wb = mkReq(WEB_UA);
    check("  in a browser: unchanged (8 h idle)", !d.markSession(wb) && !wb.session.desktop && wb.session.cookie.maxAge === 8 * 3600e3);
    t += 13 * 86400e3;
    check("  13 days on: still signed in, the cookie keeps the day that is left (counted from the sign-in, not the last request)", d.checkSession(rq) === "ok" && rq.session.cookie.maxAge === 86400e3);
    t += 86400e3 + 1;
    check("  after 14 days: expired", d.checkSession(rq) === "expired");
    check("  a browser session is never touched", d.checkSession(wb) === null);
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const code = d.issue(7, challenge);
    check("a code: 43 characters, for a well-formed challenge only", /^[A-Za-z0-9_-]{43}$/.test(code) && d.issue(7, "short") === null && d.issue(null, challenge) === null);
    check("  redeemed with the right secret: the user, once", d.redeem(code, verifier) === 7 && d.redeem(code, verifier) === null);
    const c2 = d.issue(8, challenge);
    check("  the wrong secret: refused, and the code is spent", d.redeem(c2, crypto.randomBytes(32).toString("base64url")) === null && d.redeem(c2, verifier) === null);
    const c3 = d.issue(9, challenge);
    t += DK.CODE_MS + 1;
    check("  after two minutes: gone", d.redeem(c3, verifier) === null && d.pending() === 0);
    check("feed file names: plain names only", !!DK.create({ db: fakeDb, dir: "/x" }).feedPath("MINT AI_0.1.0_x64-setup.exe") && !DK.create({ db: fakeDb, dir: "/x" }).feedPath("../latest.json") && !DK.create({ db: fakeDb, dir: "/x" }).feedPath("a/b.exe") && !DK.create({ db: fakeDb, dir: "/x" }).feedPath(".hidden.exe"));
  }

  const PW = process.env.PLAYWRIGHT || "playwright";
  let chromium = null;
  try {
    ({ chromium } = require(PW));
  } catch (e) {
    check("playwright found (set PLAYWRIGHT=/path/to/node_modules/playwright)", false, e.message);
  }

  const s = await scratch.startScratch({});
  const { authenticator } = require("otplib");
  try {
    section("the server: render mode, sign-in pages, session length (scratch copy, helper cut off)");
    const cookieOf = (res, prev) => {
      const set = res.headers["set-cookie"];
      if (!set) return prev;
      const jar = {};
      String(prev || "").split("; ").filter(Boolean).forEach((c) => (jar[c.split("=")[0]] = c));
      set.forEach((c) => { const kv = c.split(";")[0]; jar[kv.split("=")[0]] = kv; });
      return Object.values(jar).join("; ");
    };
    async function signIn(username, ua) {
      const u = users[username];
      const g = await s.req("GET", "/login", { headers: { "User-Agent": ua } });
      let cookie = cookieOf(g);
      const csrf = s.csrfOf(g.body);
      const p = await s.req("POST", "/login", { cookie, headers: { "User-Agent": ua }, body: new URLSearchParams({ _csrf: csrf, username, password: u.pw, token: authenticator.generate(u.secret) }).toString() });
      cookie = cookieOf(p, cookie);
      return { cookie, res: p };
    }
    const users = {};
    users.deskadmin = await s.makeUser("deskadmin", "administrator");
    users.webadmin = await s.makeUser("webadmin", "administrator");
    users.linker = await s.makeUser("linker", "administrator");

    const lw = await s.req("GET", "/login", { headers: { "User-Agent": WEB_UA } });
    check("a browser's sign-in page is unchanged (no desktop class, no hand-off)", lw.status === 200 && !/cc-desk/.test(lw.body) && !/dk-browser-signin/.test(lw.body) && /8 h idle/.test(lw.body));
    const la = await s.req("GET", "/login", { headers: { "User-Agent": APP_UA } });
    check("the app's sign-in page: the floating card, the browser hand-off, 14 days", /<html lang="en" class="cc-desk dk-auth">/.test(la.body) && /id="dk-browser-signin"/.test(la.body) && /stays signed in for 14 days/.test(la.body) && /mint-desktop\.js\?v=/.test(la.body));
    check("  its CSP adds only Tauri's IPC to connect-src; a browser's does not", /connect-src 'self' http:\/\/ipc\.localhost ipc:(;|$)/.test(la.headers["content-security-policy"]) && /connect-src 'self'(;|$)/.test(lw.headers["content-security-policy"]) && /script-src 'self';/.test(la.headers["content-security-policy"]), la.headers["content-security-policy"] + " | " + lw.headers["content-security-policy"]);

    // COOP same-origin stays for the app too: the start card's page and the site never share an opener, and 0.1.0 showed the site fine with it.
    check("  COOP is the same for the app and a browser (left as it is: it did not stop the app)", la.headers["cross-origin-opener-policy"] === lw.headers["cross-origin-opener-policy"]);
    const ping = await s.req("GET", "/desktop/ping", { headers: { "User-Agent": APP_UA } });
    check("/desktop/ping (the start card's probe): 204, CORP cross-origin, no-store, no cookie, no session", ping.status === 204 && ping.headers["cross-origin-resource-policy"] === "cross-origin" && /no-store/.test(ping.headers["cache-control"] || "") && !ping.headers["set-cookie"]);
    const startJs = fs.readFileSync(path.join(ROOT, "..", "desktop", "dist", "index.js"), "utf8");
    check("  the start card probes /desktop/ping and asks the app to navigate (go_site); it never sends the window to the site itself", /\/desktop\/ping/.test(startJs) && /invoke\("go_site"\)/.test(startJs) && !/location\.(replace|assign|href\s*=)\s*\(?\s*origin/.test(startJs));
    const libRs = fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "src", "lib.rs"), "utf8");
    check("  the app: go_site is a command, granted to the local pages only", /fn go_site\(/.test(libRs) && /"allow-go-site"/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "capabilities", "local.json"), "utf8")) && !/go-site/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "capabilities", "remote.json"), "utf8")));
    // The 0.1.0 freeze: the lock held across a call the main thread answers. No `monitor_for(app, &a)` on a guard,
    // and nothing asks the main thread for monitors while the env loop's guard is held.
    check("  the app never asks the main thread for monitors while holding its lock (the 0.1.0 freeze)", !/monitor_for\(app, &a\)/.test(libRs) && !/let a = shared\.lock\(\)\.unwrap\(\);\s*monitor_for/.test(libRs) && /fn monitor_for\(app: &AppHandle, settings: &Settings\)/.test(libRs));
    // The "Not Responding" hang: the background loops never wait on the main thread.
    const fnBody = (name) => { const i = libRs.indexOf("fn " + name + "("); const j = libRs.indexOf("\nfn ", i + 3); return i < 0 ? "" : libRs.slice(i, j < 0 ? undefined : j); };
    const hitBody = fnBody("hit_loop"), envBody = fnBody("env_loop");
    check("  the click-through loop takes the lock with try_lock, reads the cursor and window from Windows, posts its changes (on_main)", /shared\.try_lock\(\)/.test(hitBody) && /platform::cursor\(\)/.test(hitBody) && /platform::window_rect\(raw\)/.test(hitBody) && /on_main\(/.test(hitBody) && !/cursor_position\(|outer_position\(|outer_size\(/.test(hitBody));
    check("  the environment loop posts window changes (on_main) and reads 'minimised' from Windows", /on_main\(/.test(envBody) && /platform::minimized\(raw\)/.test(envBody) && !/is_minimized\(/.test(envBody) && !/\bapply\(&app/.test(envBody));
    check("  a watchdog logs a main thread that stalls more than 2 s; the log is %LOCALAPPDATA%\\MINT AI\\logs\\mint-desktop.log", /fn watchdog\(/.test(libRs) && /lag > 2000/.test(libRs) && /std::thread::spawn\(move \|\| watchdog\(/.test(libRs) && /"MINT AI"\)\.join\("logs"\)/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "src", "log.rs"), "utf8")) && /mint-desktop\.log/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "src", "log.rs"), "utf8")));
    check("  Windows Hello: webauthn_ceremony is a command the site may call (it makes the window clickable, on top, focused)", /fn webauthn_ceremony\(/.test(libRs) && /"allow-webauthn-ceremony"/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "capabilities", "remote.json"), "utf8")) && /"webauthn_ceremony"/.test(fs.readFileSync(path.join(ROOT, "..", "desktop", "src-tauri", "build.rs"), "utf8")) && /set_ignore_cursor_events\(false\)[\s\S]{0,400}set_focus\(\)/.test(fnBody("webauthn_ceremony")));
    const aIdx = (b, f) => b.indexOf(f + "?v=");
    check("the app's sign-in page loads mint-desktop-webauthn.js before every other script; a browser's does not load it", aIdx(la.body, "mint-desktop-webauthn.js") > 0 && aIdx(la.body, "mint-desktop-webauthn.js") < aIdx(la.body, "mint-desktop.js") && (aIdx(la.body, "passkey.js") < 0 || aIdx(la.body, "mint-desktop-webauthn.js") < aIdx(la.body, "passkey.js")) && !/mint-desktop-webauthn/.test(lw.body));
    check("  'Sign in in your browser' is a full-width button, not a small link", /class="btn w-full dk-browser-btn" id="dk-browser-signin"/.test(la.body) && /Sign in in your browser/.test(la.body));
    const fam = fs.readFileSync(path.join(ROOT, "public", "cc-family.js"), "utf8");
    const mdj = fs.readFileSync(path.join(ROOT, "public", "mint-desktop.js"), "utf8");
    check("session spheres: hover works in the app's small box (not taken for a phone), the card is in the hit regions, the sphere's region is the hover radius", /phone = W <= 720 && !document\.documentElement\.classList\.contains\("cc-desk"\)/.test(fam) && /"#cc-kcard\.on"/.test(mdj) && /q\.r \* 1\.25 \+ 8/.test(mdj) && /html\.cc-desk \.cc-kcard \{ display: block/.test(fs.readFileSync(path.join(ROOT, "public", "mint-desktop.css"), "utf8")));
    const A = await signIn("deskadmin", APP_UA);
    const maxAge = Number(((A.res.headers["set-cookie"] || []).join(";").match(/Max-Age=(\d+)/i) || [])[1] || (Date.parse(((A.res.headers["set-cookie"] || []).join(";").match(/Expires=([^;]+)/i) || [])[1]) - Date.now()) / 1000);
    check("signed in in the app: it lands on the desktop render mode", A.res.status === 302 && A.res.headers.location === "/mint-ai?shell=desktop", A.res.status + " " + A.res.headers.location);
    check("  and its session cookie lasts 14 days", maxAge > 13.9 * 86400 && maxAge <= 14 * 86400 + 5, maxAge);
    const W = await signIn("webadmin", WEB_UA);
    const wAge = Number(((W.res.headers["set-cookie"] || []).join(";").match(/Max-Age=(\d+)/i) || [])[1] || (Date.parse(((W.res.headers["set-cookie"] || []).join(";").match(/Expires=([^;]+)/i) || [])[1]) - Date.now()) / 1000);
    check("signed in in a browser: lands as always, 8 h", W.res.headers.location !== "/mint-ai?shell=desktop" && wAge > 7.9 * 3600 && wAge <= 8 * 3600 + 5, W.res.headers.location + " " + wAge);

    const pg = await s.req("GET", "/mint-ai?shell=desktop", { cookie: A.cookie, headers: { "User-Agent": APP_UA } });
    check("/mint-ai?shell=desktop: the Command Center in its desktop mode", pg.status === 200 && /class="cc-page cc-desk"/.test(pg.body) && /id="cc" data-shell="desktop"/.test(pg.body) && /id="dk-chat"/.test(pg.body) && /id="dk-corehit"/.test(pg.body) && /id="dk-kb"/.test(pg.body));
    check("  the same scripts, plus the desktop ones; no Mint OS dock or page shell", /moni-ai\.js\?v=/.test(pg.body) && /mint-desktop\.js\?v=/.test(pg.body) && /mint-desktop-layout\.js\?v=/.test(pg.body) && /mint-desktop\.css\?v=/.test(pg.body) && !/mint-dock\.js/.test(pg.body) && !/mint-shell\.js/.test(pg.body) && !/id="mint-dock-root"/.test(pg.body));
    check("  no inline script or style anywhere", !/<script>(?!\s*<\/script>)/.test(pg.body) && !/\sstyle="/.test(pg.body) && !/\son[a-z]+="/.test(pg.body));
    const pw = await s.req("GET", "/mint-ai", { cookie: W.cookie, headers: { "User-Agent": WEB_UA } });
    check("/mint-ai without it is unchanged (the dock, the shell, no desktop parts)", pw.status === 200 && /id="mint-dock-root"/.test(pw.body) && /mint-shell\.js/.test(pw.body) && !/cc-desk/.test(pw.body) && !/dk-chat/.test(pw.body));

    // The live call's hold-to-talk turn mode is asked for by the desktop page only.
    const ma = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
    check("hold-to-talk: asked for only by the desktop page (o.ptt, set by pttPress on the desktop page)", /turn: o\.ptt \? "ptt" : undefined/.test(ma) && /if \(DESKTOP\) \{\s*window\.addEventListener\("pointerdown"/.test(ma) && /liveStart\(\{ ptt: true \}\)/.test(ma));

    section("the browser hand-off and the feed");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const port = 49731;
    const bad = await s.req("GET", "/desktop/link?c=short&p=80", { headers: { "User-Agent": WEB_UA } });
    check("a malformed link is refused", bad.status === 400);
    const out = await s.req("GET", `/desktop/link?c=${challenge}&p=${port}`, { headers: { "User-Agent": WEB_UA } });
    check("signed out: off to sign in first", out.status === 302 && out.headers.location === "/login");
    // Sign in in that same browser; it comes back to the link page.
    let bc = cookieOf(out);
    const lg = await s.req("GET", "/login", { cookie: bc, headers: { "User-Agent": WEB_UA } });
    bc = cookieOf(lg, bc);
    const lp = await s.req("POST", "/login", { cookie: bc, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(lg.body), username: "linker", password: users.linker.pw, token: authenticator.generate(users.linker.secret) }).toString() });
    bc = cookieOf(lp, bc);
    check("  and after both factors, back to the link page", lp.status === 302 && lp.headers.location === `/desktop/link?c=${challenge}&p=${port}`, lp.headers.location);
    const lk = await s.req("GET", lp.headers.location, { cookie: bc, headers: { "User-Agent": WEB_UA } });
    check("the link page asks before linking, naming the account", lk.status === 200 && /Link the app/.test(lk.body) && /linker/.test(lk.body));
    const post = await s.req("POST", "/desktop/link", { cookie: bc, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(lk.body), c: challenge, p: String(port) }).toString() });
    const to = (/data-to="([^"]+)"/.exec(post.body) || [])[1] || "";
    const code = (/code=([A-Za-z0-9_-]{43})/.exec(to) || [])[1];
    check("Link: the browser goes to the app's loopback with a one-time code (script + plain link)", post.status === 200 && new RegExp(`^http://127\\.0\\.0\\.1:${port}/mint-callback\\?code=[A-Za-z0-9_-]{43}$`).test(to) && /mint-desktop-link\.js/.test(post.body), to);
    const noCsrf = await s.req("POST", "/desktop/link", { cookie: bc, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ c: challenge, p: String(port) }).toString() });
    check("  Link without the CSRF token is refused", noCsrf.status === 403);
    const fromWeb = await s.req("GET", `/desktop/redeem?code=${code}&v=${verifier}`, { headers: { "User-Agent": WEB_UA } });
    check("redeeming is for the app only", fromWeb.status === 403);
    const wrong = await s.req("GET", `/desktop/redeem?code=${code}&v=${crypto.randomBytes(32).toString("base64url")}`, { headers: { "User-Agent": APP_UA } });
    check("  with the wrong secret: refused (and the code is spent)", wrong.status === 302 && wrong.headers.location === "/login?again=1");
    // A fresh code, redeemed properly.
    const post2 = await s.req("POST", "/desktop/link", { cookie: bc, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(lk.body), c: challenge, p: String(port) }).toString() });
    const code2 = (/code=([A-Za-z0-9_-]{43})/.exec(post2.body) || [])[1];
    const red = await s.req("GET", `/desktop/redeem?code=${code2}&v=${verifier}`, { headers: { "User-Agent": APP_UA } });
    const rc = cookieOf(red);
    check("  with the right one: the app is signed in, on its render mode", red.status === 302 && red.headers.location === "/mint-ai?shell=desktop" && !!rc);
    const cc = await s.req("GET", "/mint-ai?shell=desktop", { cookie: rc, headers: { "User-Agent": APP_UA } });
    check("  and the session works", cc.status === 200 && /data-shell="desktop"/.test(cc.body));
    const again = await s.req("GET", `/desktop/redeem?code=${code2}&v=${verifier}`, { headers: { "User-Agent": APP_UA } });
    check("  a second redeem of the same code is refused", again.status === 302 && again.headers.location === "/login?again=1");
    const dev = await s.req("GET", "/devices", { cookie: W.cookie, headers: { "User-Agent": WEB_UA } });
    check("Devices still renders (desktop sessions are labelled there)", dev.status === 200);

    const feed0 = await s.req("GET", "/desktop/latest.json");
    check("the feed: 404 until a release is published", feed0.status === 404);
    const dir = path.join(s.data, "desktop");
    fs.mkdirSync(path.join(dir, "files"), { recursive: true });
    fs.writeFileSync(path.join(dir, "files", "MINT AI_0.1.0_x64-setup.exe"), Buffer.alloc(2048, 1));
    fs.writeFileSync(path.join(dir, "files", "mint-desktop-codesign.cer"), Buffer.alloc(600, 2));
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ version: "0.1.0", notes: "First release.", pub_date: "2026-10-07T12:00:00Z", platforms: { "windows-x86_64": { signature: "dW50cnVzdGVkIGNvbW1lbnQ=", url: "https://os.mint-stack.com/desktop/files/MINT%20AI_0.1.0_x64-setup.exe" } } }));
    const feed = await s.req("GET", "/desktop/latest.json");
    check("  then the signed manifest, public and never cached long", feed.status === 200 && JSON.parse(feed.body).version === "0.1.0" && /no-cache/.test(feed.headers["cache-control"]));
    const file = await s.req("GET", "/desktop/files/MINT%20AI_0.1.0_x64-setup.exe");
    check("  the installer is public (the updater has no cookie)", file.status === 200 && file.body.length === 2048 && /attachment/.test(file.headers["content-disposition"] || ""));
    const trav = await s.req("GET", "/desktop/files/..%2Flatest.json");
    check("  nothing else from there", trav.status === 404 && (await s.req("GET", "/desktop/files/x.js")).status === 404);
    const dl = await s.req("GET", "/desktop/", { cookie: W.cookie, headers: { "User-Agent": WEB_UA } });
    check("the download page: signed in only; the installer, its size, the certificate and how to trust it", dl.status === 200 && /MINT AI_0\.1\.0_x64-setup\.exe/.test(dl.body) && /2 KB/.test(dl.body) && /mint-desktop-codesign\.cer/.test(dl.body) && /TrustedPublisher/.test(dl.body) && (await s.req("GET", "/desktop/")).status === 302);

    section("Settings > General > Desktop app");
    const sg = await s.req("GET", "/mint-ai/settings/general", { cookie: W.cookie, headers: { "User-Agent": WEB_UA } });
    check("the row is there with 14 days", sg.status === 200 && /id="g-desktop"/.test(sg.body) && /name="days"[^>]*value="14"/.test(sg.body));
    const sv = await s.req("POST", "/mint-ai/settings/general/desktop", { cookie: W.cookie, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(sg.body), days: "21" }).toString() });
    const sb = await s.req("POST", "/mint-ai/settings/general/desktop", { cookie: W.cookie, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(sg.body), days: "365" }).toString() });
    const la2 = await s.req("GET", "/login", { headers: { "User-Agent": APP_UA } });
    check("  saved (21), audited; 365 refused; the app's sign-in page says 21", sv.status === 303 && /msg=/.test(sv.headers.location) && /err=/.test(sb.headers.location) && /21 days/.test(la2.body));
    await s.req("POST", "/mint-ai/settings/general/desktop", { cookie: W.cookie, headers: { "User-Agent": WEB_UA }, body: new URLSearchParams({ _csrf: s.csrfOf(sg.body), days: "14" }).toString() });

    if (chromium) {
      section("headless Chromium: the render mode on a transparent window");
      const browser = await chromium.launch();
      const errs = [];
      async function view(W_, H_, q, ua, cookieStr) {
        const ctx = await browser.newContext({ viewport: { width: W_, height: H_ }, userAgent: ua, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        const cookies = String(cookieStr || "").split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port }));
        if (cookies.length) await ctx.addCookies(cookies);
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push(q + ": " + e.message));
        page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(m.text())) errs.push(q + ": console " + m.text()); });
        page.on("console", (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errs.push(q + ": CSP " + m.text()); });
        await page.goto("http://127.0.0.1:" + s.port + q, { waitUntil: "load" });
        await page.waitForTimeout(900);
        return { ctx, page };
      }
      async function alphaAt(page, pts) {
        const buf = await page.screenshot({ omitBackground: true });
        // A PNG: read it back in the page (no image library here).
        return page.evaluate(async ({ b64, pts }) => {
          const img = new Image();
          img.src = "data:image/png;base64," + b64;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.width; c.height = img.height;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0);
          return pts.map((p) => g.getImageData(p[0], p[1], 1, 1).data[3]);
        }, { b64: buf.toString("base64"), pts });
      }
      const modes = [
        { name: "floating", W: 480, H: 860, q: "/mint-ai?shell=desktop&mode=floating" },
        { name: "floating-focus", W: 168, H: 168, q: "/mint-ai?shell=desktop&mode=floating&focus=1" },
        { name: "desktop", W: 1440, H: 852, q: "/mint-ai?shell=desktop&mode=desktop" },
        { name: "desktop-light-ink", W: 1440, H: 852, q: "/mint-ai?shell=desktop&mode=desktop&ink=dark" },
        { name: "peek", W: 1440, H: 852, q: "/mint-ai?shell=desktop&mode=peek" },
      ];
      for (const m of modes) {
        const { ctx, page } = await view(m.W, m.H, m.q, APP_UA, A.cookie);
        const info = await page.evaluate(() => {
          const L = window.MintDesktop && window.MintDesktop.layout();
          const r = window.MintDesktop && window.MintDesktop.regions();
          const comp = document.getElementById("cc-compose").getBoundingClientRect();
          const bg = getComputedStyle(document.body).backgroundColor;
          const top = getComputedStyle(document.querySelector(".topbar")).display;
          const core = window.__mintCC && window.__mintCC.orbit.layout;
          return { L, n: r ? r.length : 0, regs: r, comp: { x: comp.x, y: comp.y, w: comp.width, h: comp.height }, bg, top, core: core && { cx: core.cx, cy: core.cy, R: core.R }, theme: document.documentElement.getAttribute("data-theme") };
        });
        const L = info.L;
        check(`${m.name}: laid out for its window; no top bar; the core where the layout says`, L && L.mode === m.name.split("-")[0] && info.top === "none" && info.core && Math.abs(info.core.cx - L.cx) < 1 && Math.abs(info.core.R - L.R) < 1, JSON.stringify({ L: L && { cx: L.cx, R: L.R }, core: info.core, top: info.top }));
        if (!/focus/.test(m.name)) check(`  the composer is where the layout puts it`, Math.abs(info.comp.x - L.composer.x) < 1.5 && Math.abs(info.comp.y - L.composer.y) < 1.5 && Math.abs(info.comp.w - L.composer.w) < 1.5, JSON.stringify(info.comp) + " " + JSON.stringify(L.composer));
        else check(`  focus mode: the composer is hidden`, info.comp.w === 0);
        if (m.name === "peek") check("  Peek while it shows: the whole window catches the mouse (a click on empty space hides it)", info.n === 1 && info.regs[0].w === m.W && info.regs[0].h === m.H);
        else check(`  the hit regions: the core${/focus/.test(m.name) ? "" : " and the composer"}, not the whole window`, info.n >= (/focus/.test(m.name) ? 1 : 2) && !info.regs.some((r) => r.w === m.W && r.h === m.H) && info.regs.some((r) => r.r > 10), JSON.stringify(info.regs));
        check(`  ink: ${/light-ink/.test(m.name) ? "dark ink (light theme) for a light wallpaper" : "light ink (dark theme)"}`, info.theme === (/light-ink/.test(m.name) ? "light" : "dark"));
        if (m.name !== "peek") {
          // The far corners: nothing but the last breath of the core's glow (a few of 255), or nothing at all
          // where Floating clips the glow to its box's round corners.
          const a = await alphaAt(page, [[1, 1], [m.W - 2, 1], [1, m.H - 2], [m.W - 2, m.H - 2]]);
          check(`  transparent where nothing is drawn (corner alpha ${a.join("/")})`, a.every((x) => x <= 12) && (m.name !== "floating" || a[0] === 0));
        }
        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: path.join(SHOTS, "desk-" + m.name + ".png"), omitBackground: true });
        }
        await ctx.close();
      }
      // The bubbles: the last exchanges, from the Command Center's own turns.
      {
        const { ctx, page } = await view(1440, 852, "/mint-ai?shell=desktop&mode=desktop", APP_UA, A.cookie);
        const n = await page.evaluate(() => {
          const S = window.__mintCC.S;
          document.getElementById("cc-offline").hidden = true; // the scratch copy has no supervisor; the bubbles hide while offline
          [[1, "What's waiting for me today?", "Two things: the invoice audit and the freight quotes."], [2, "Hire someone for the customs papers", "I hired Customs docs."], [3, "Thanks", "You're welcome."], [4, "And the label check?", "It is running."]].forEach(function (x) {
            S.turns.set(x[0], { id: x[0], source: "dashboard", text: x[1], blocks: [x[2]], partial: "", status: "done", created_at: new Date().toISOString() });
            S.turnOrder.push(x[0]);
          });
          document.dispatchEvent(new CustomEvent("mint-turns"));
          const b = document.querySelectorAll("#dk-chat .dk-bub");
          const box = document.getElementById("dk-chat");
          return { n: b.length, last: b.length ? b[b.length - 1].textContent : "", first: b.length ? b[0].textContent : "", old: document.querySelectorAll("#dk-chat .dk-bub.old").length, hs: [].map.call(b, (x) => Math.round(x.getBoundingClientRect().height)), box: [box.clientHeight, box.scrollHeight, getComputedStyle(box).maxHeight] };
        });
        // As many of the last three exchanges as fit between the core and the composer (the mockup's rule), newest last.
        check("the bubbles: the newest exchanges that fit under the core, newest last", n.n >= 2 && n.n <= 6 && /It is running/.test(n.last) && /And the label check/.test(n.n >= 2 ? n.first + n.last : ""), JSON.stringify(n));
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "desk-desktop-chat.png"), omitBackground: true });
        await ctx.close();
      }
      // The sign-in card as the app shows it, and the browser pages.
      {
        const { ctx, page } = await view(480, 860, "/login?mode=floating", APP_UA, "");
        const r = await page.evaluate(() => { const c = document.querySelector(".auth-wrap .card").getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height, regs: window.MintDesktop.regions(), hand: !!document.getElementById("dk-browser-signin") }; });
        check("the app's sign-in card floats in the window, and only it catches the mouse", r.w > 300 && r.y + r.h <= 860 && r.regs.length >= 1 && r.regs.every((g) => g.w < 480 || g.h < 860) && r.hand, JSON.stringify(r));
        const a = await alphaAt(page, [[2, 2], [470, 10]]);
        check("  transparent round it (the grey core's glow fades out)", a.every((x) => x <= 12), a.join("/"));
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "desk-signin.png"), omitBackground: true });
        await ctx.close();
      }
      // Windows Hello inside the app: the page tells the app when a passkey ceremony starts and ends,
      // and a failed one lights up the browser sign-in. (Tauri's IPC is stood in for; the ceremony fails at once: wrong rpId.)
      {
        const ctx = await browser.newContext({ viewport: { width: 480, height: 860 }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addInitScript(() => {
          window.__calls = [];
          window.__TAURI__ = { core: { invoke: (cmd, args) => { window.__calls.push(cmd === "webauthn_ceremony" ? "ceremony:" + args.on : cmd); return Promise.resolve(null); } }, event: { listen: () => Promise.resolve(() => {}) } };
        });
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push("webauthn: " + e.message));
        await page.goto("http://127.0.0.1:" + s.port + "/login?mode=floating", { waitUntil: "load" });
        const r = await page.evaluate(async () => {
          let err = null;
          try { await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: "example.com", timeout: 2000, userVerification: "preferred" } }); } catch (e) { err = e.name; }
          await new Promise((ok) => setTimeout(ok, 50));
          const b = document.getElementById("dk-browser-signin");
          return { err, calls: window.__calls.filter((c) => /^ceremony/.test(c)), urge: b && b.classList.contains("dk-urge"), note: (document.getElementById("dk-browser-note") || {}).textContent || "", h: b && b.getBoundingClientRect().height, w: b && b.getBoundingClientRect().width, card: document.querySelector(".auth-wrap .card button[type=submit]").getBoundingClientRect().width };
        });
        check("a passkey ceremony in the app: the app is told it starts and ends; when it fails the browser sign-in is lit up", !!r.err && JSON.stringify(r.calls) === JSON.stringify(["ceremony:true", "ceremony:false"]) && r.urge && /did not finish inside the app/.test(r.note), JSON.stringify(r));
        check("  the browser sign-in button is big: at least 40 px tall, as wide as the Sign in button", r.h >= 40 && Math.abs(r.w - r.card) < 2, JSON.stringify(r));
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "desk-signin-hello-failed.png"), omitBackground: true });
        await ctx.close();
      }
      // The start path, as the app's start card meets it: a page of another origin (the app's is
      // http://tauri.localhost; here a second server on another port, same address space).
      {
        const http = require("http");
        const other = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end("<!doctype html><title>start</title>"); });
        await new Promise((r) => other.listen(0, "127.0.0.1", r));
        const oport = other.address().port;
        const SITE = "http://127.0.0.1:" + s.port;
        const ctx = await browser.newContext({ userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        const page = await ctx.newPage();
        await page.goto("http://localhost:" + oport + "/");
        const probe = await page.evaluate(async (site) => {
          const one = (u) => fetch(u, { mode: "no-cors", cache: "no-store" }).then(() => "ok", (e) => "refused: " + e.message);
          return { ping: await one(site + "/desktop/ping"), manifest: await one(site + "/manifest.webmanifest"), login: await one(site + "/login") };
        }, SITE);
        check("cross-origin probe from the start card's origin: /desktop/ping and /manifest.webmanifest answer; an ordinary page is refused by CORP (the 0.1.0 'Offline' trap)", probe.ping === "ok" && probe.manifest === "ok" && /refused/.test(probe.login), JSON.stringify(probe));
        // The session cookie is SameSite=Strict: a navigation the start page makes is cross-site and goes without it.
        const jar = String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Strict" }));
        await ctx.addCookies(jar);
        await Promise.all([page.waitForURL(/127\.0\.0\.1/, { waitUntil: "load" }), page.evaluate((u) => { location.href = u; }, SITE + "/mint-ai?shell=desktop")]);
        const viaPage = page.url();
        // ...and the sign-in page it lands on starts a new session, whose cookie replaces the signed-in one.
        const anon = await s.req("GET", "/login", { headers: { "User-Agent": APP_UA } });
        check("  (and its second half: that sign-in page sets a new moni.sid, which would replace the still-valid one)", /^moni\.sid=/.test((anon.headers["set-cookie"] || [""])[0]) && /SameSite=Strict/i.test((anon.headers["set-cookie"] || [""])[0]));
        await ctx.addCookies(jar);
        await page.goto(SITE + "/mint-ai?shell=desktop"); // what the app's go_site does: a navigation with no initiating site
        const viaApp = page.url();
        const shell = await page.evaluate(() => !!document.querySelector('#cc[data-shell="desktop"]'));
        check("SameSite=Strict: the start page's own navigation lands on sign-in although signed in; the app's navigation (go_site) opens the Command Center", /\/login/.test(viaPage) && /\/mint-ai\?shell=desktop$/.test(viaApp) && shell, viaPage + " | " + viaApp);
        await ctx.close();
        other.close();
      }
      // Signed out in the app: the sign-in page renders visibly, with its assets, and only its card catches the mouse.
      {
        const { ctx, page } = await view(480, 860, "/mint-ai?shell=desktop", APP_UA, "");
        const r = await page.evaluate(() => {
          const c = document.querySelector(".auth-wrap .card");
          const b = c && c.getBoundingClientRect();
          return { url: location.pathname, css: [].some.call(document.styleSheets, (x) => /mint-desktop\.css/.test(x.href || "")), core: !!window.MintCoreD, card: b && { y: b.y, h: b.height, vis: getComputedStyle(c).visibility, op: getComputedStyle(c).opacity }, hand: !!document.getElementById("dk-browser-signin"), regs: window.MintDesktop && window.MintDesktop.regions() };
        });
        check("signed out, /mint-ai?shell=desktop -> the app's sign-in page: its stylesheet and scripts load, the card is visible inside the window", r.url === "/login" && r.css && r.core && r.card && r.card.y >= 0 && r.card.y + r.card.h <= 860 && r.card.vis === "visible" && r.card.op === "1" && r.regs && r.regs.length >= 1, JSON.stringify(r));
        await ctx.close();
      }
      for (const [w, h, theme] of [[1440, 900, "light"], [390, 844, "light"], [1440, 900, "dark"], [390, 844, "dark"]]) {
        const { ctx, page } = await view(w, h, "/desktop/", WEB_UA, W.cookie);
        await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); }, theme);
        const ov = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        check(`the download page at ${w} (${theme}): no sideways scroll`, ov);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `desktop-download-${w}-${theme}.png`), fullPage: true });
        await ctx.close();
      }
      check("zero page errors and CSP violations across all of it", errs.length === 0, errs.join("\n"));
      await browser.close();
    }
  } catch (e) {
    check("the server run completed", false, e.stack + "\n" + s.out().slice(-2000));
  } finally {
    s.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("  FAIL no exception\n" + e.stack);
  process.exit(1);
});
