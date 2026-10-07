#!/usr/bin/env node
"use strict";
/**
 * The voiceprint trial's recording page (/mint-ai/voiceprint-trial,
 * lib/voiceprint-trial.js): the store, the resampler, the routes and the page.
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-voiceprint-trial.cjs
 *
 * (without PLAYWRIGHT, or if it cannot be loaded, the browser part is skipped
 * and says so.)
 *
 *   - the phrase list: 4 enrolment paragraphs + 30 test phrases, unique ids,
 *     very short words and both languages present;
 *   - 24 -> 16 kHz: length 2/3, a 1 kHz tone keeps its pitch and level, a
 *     10 kHz tone (above the new Nyquist) is cut by > 40 dB;
 *   - the store: 0700 folders, 0600 files, a 16 kHz WAV and a manifest line per
 *     clip, re-recording replaces, limits (too short, too long, silent, wrong
 *     format, unknown slot or phrase), delete removes everything;
 *   - the routes, on a scratch copy of server.js: signed out, a role without
 *     voice.manage, no CSRF -> refused; an administrator records, lists, plays
 *     back and deletes; the audit log has counts only;
 *   - the page in headless Chromium with a fake microphone, 1440 and 390 px,
 *     light and dark: no horizontal scroll, a phrase recorded and saved through
 *     the real worklet, the count per microphone, delete through the confirm,
 *     zero page errors and zero CSP violations.
 */
const scratch = require("./scratch-server.cjs"); // first: sets MONI_DATA_DIR
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const vp = require(path.join(ROOT, "lib", "voiceprint-trial.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 800) : ""));
  }
}
const section = (t) => console.log("\n" + t);

function tone(freq, seconds, rate, amp) {
  const n = Math.round(seconds * rate);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round((amp || 0.5) * 32767 * Math.sin((2 * Math.PI * freq * i) / rate));
  return a;
}
function wavOf(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2).copy(b, 44);
  return b;
}
const rms = (a, from, to) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
};
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);

function unit() {
  section("phrases");
  check("4 enrolment paragraphs, 30 test phrases", vp.ENROL.length === 4 && vp.TESTS.length === 30);
  const ids = vp.PHRASES.map((p) => p.id);
  check("ids are unique", new Set(ids).size === ids.length);
  check("very short words in both languages", ["Yes.", "Stop.", "نعم.", "اقفل المكالمة."].every((t) => vp.TESTS.some((p) => p.text === t)));
  check("English, Egyptian and mixed tests", ["en", "ar", "mixed"].every((l) => vp.TESTS.filter((p) => p.lang === l).length >= 6));
  check("username folder: plain kept, odd ones by id", vp.userDirName({ id: 3, username: "amaraghy" }) === "amaraghy" && vp.userDirName({ id: 3, username: "../x" }) === "u3" && vp.userDirName({ id: 4, username: ".." }) === "u4");

  section("24 -> 16 kHz");
  const t1 = tone(1000, 1, 24000, 0.5);
  const o1 = vp.to16k(t1, 24000);
  check("length is two thirds", o1.length === 16000, o1.length);
  let zc = 0;
  for (let i = 1; i < o1.length; i++) if (o1[i - 1] < 0 && o1[i] >= 0) zc++;
  check("a 1 kHz tone stays 1 kHz", Math.abs(zc - 1000) <= 2, zc);
  const lvl = rms(o1, 200, 15800) / rms(t1, 200, 23800);
  check("and keeps its level (within 0.5 dB)", Math.abs(20 * Math.log10(lvl)) < 0.5, lvl);
  const o2 = vp.to16k(tone(10000, 1, 24000, 0.5), 24000);
  const att = 20 * Math.log10(rms(o2, 200, 15800) / (0.5 * 32767 / Math.SQRT2));
  check("a 10 kHz tone is cut by more than 40 dB", att < -40, att.toFixed(1));
  const w = vp.parseWav(vp.wav16(o1));
  check("wav16 round-trips", w.rate === 16000 && w.samples.length === 16000 && w.samples[100] === o1[100]);

  section("the store");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vp-store-"));
  const st = vp.createStore(base);
  const me = { id: 7, username: "admin1" };
  const r1 = st.save(me, "laptop", "t01", wavOf(tone(300, 1.2, 24000, 0.3), 24000), "Built-in Microphone (Realtek)");
  const dir = path.join(base, "voiceprint-trial", "admin1");
  check("first clip: started, 1.2 s", r1.started === true && r1.count === 1 && r1.seconds === 1.2, JSON.stringify(r1));
  check("folders 0700, file and manifest 0600", mode(path.join(base, "voiceprint-trial")) === "700" && mode(dir) === "700" && mode(path.join(dir, "laptop")) === "700" && mode(path.join(dir, "laptop", "t01.wav")) === "600" && mode(path.join(dir, "manifest.json")) === "600");
  const saved = vp.parseWav(fs.readFileSync(path.join(dir, "laptop", "t01.wav")));
  check("stored as 16 kHz", saved.rate === 16000 && saved.samples.length === 19200, saved.samples.length);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  check("manifest: slot device, clip with phrase, language, seconds", m.slots.laptop.device === "Built-in Microphone (Realtek)" && m.clips.length === 1 && m.clips[0].id === "t01" && m.clips[0].text === "Yes." && m.clips[0].lang === "en" && m.clips[0].part === "test" && m.clips[0].seconds === 1.2);
  const r2 = st.save(me, "laptop", "t01", wavOf(tone(300, 0.8, 16000, 0.3), 16000), "");
  check("re-recording replaces (16 kHz input taken as is)", r2.count === 1 && r2.started === false && JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).clips.length === 1 && vp.parseWav(fs.readFileSync(path.join(dir, "laptop", "t01.wav"))).samples.length === 12800);
  const err = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e;
    }
  };
  check("too short refused", /between 0.3 and 12/.test((err(() => st.save(me, "laptop", "t02", wavOf(tone(300, 0.2, 24000), 24000))) || {}).message));
  check("a test phrase over 12 s refused", /between/.test((err(() => st.save(me, "laptop", "t02", wavOf(tone(300, 13, 24000), 24000))) || {}).message));
  check("an enrolment paragraph of 30 s accepted", st.save(me, "laptop", "e1", wavOf(tone(300, 30, 24000, 0.2), 24000)).seconds === 30);
  check("silence refused", /Nothing was heard/.test((err(() => st.save(me, "laptop", "t02", wavOf(new Int16Array(24000), 24000))) || {}).message));
  check("48 kHz refused", /16 or 24 kHz/.test((err(() => st.save(me, "laptop", "t02", wavOf(tone(300, 1, 48000), 48000))) || {}).message));
  check("not a WAV refused", /not a WAV/.test((err(() => st.save(me, "laptop", "t02", Buffer.from("hello world, this is not audio at all......................"))) || {}).message));
  check("unknown slot or phrase refused", (err(() => st.save(me, "kitchen", "t02", wavOf(tone(300, 1, 24000), 24000))) || {}).status === 400 && (err(() => st.save(me, "laptop", "../x", wavOf(tone(300, 1, 24000), 24000))) || {}).status === 400);
  check("clipPath refuses traversal", st.clipPath(me, "laptop", "../manifest") === null && st.clipPath(me, "..", "t01") === null && !!st.clipPath(me, "laptop", "t01"));
  st.save(me, "headset", "t03", wavOf(tone(300, 1, 24000), 24000), "Jabra");
  const s1 = st.status(me);
  check("status per slot", Object.keys(s1.slots.laptop.clips).length === 2 && s1.slots.headset.clips.t03 === 1 && s1.slots.headset.device === "Jabra" && s1.total === 34);
  check("delete removes everything and counts it", st.removeAll(me) === 3 && !fs.existsSync(dir));
  fs.rmSync(base, { recursive: true, force: true });
}

async function server() {
  section("the routes (scratch copy of server.js)");
  const s = await scratch.startScratch({});
  try {
    await s.makeUser("vpadmin", "administrator");
    await s.makeUser("vpop", "operator-vp", ["moniai.use", "os.view"]);
    const anon = await s.req("GET", "/mint-ai/voiceprint-trial");
    check("signed out: the page sends to sign-in", anon.status === 302 && /login/.test(anon.headers.location || ""), anon.status);
    const anonApi = await s.req("GET", "/mint-ai/api/voiceprint-trial/status");
    check("signed out: the API is 401", anonApi.status === 401, anonApi.status);
    const op = await s.signIn("vpop");
    check("without voice.manage: the page is 403", (await s.req("GET", "/mint-ai/voiceprint-trial", { cookie: op.cookie })).status === 403);
    check("without voice.manage: the API is 403", (await s.req("GET", "/mint-ai/api/voiceprint-trial/status", { cookie: op.cookie })).status === 403);
    const ad = await s.signIn("vpadmin");
    const pg = await s.req("GET", "/mint-ai/voiceprint-trial", { cookie: ad.cookie });
    check("administrator: the page renders", pg.status === 200 && /Voiceprint trial/.test(pg.body) && /data-rec="e1"/.test(pg.body) && /data-rec="t30"/.test(pg.body), pg.status);
    check("no inline script or style on the page", !/<script>(?!\s*<\/script>)|<script(?![^>]*\bsrc=)[^>]*>[^<]/.test(pg.body.replace(/<script type="application\/(ld\+)?json"[\s\S]*?<\/script>/g, "")) && !/\sstyle="/.test(pg.body) && !/\son[a-z]+="/.test(pg.body));
    check("a Content-Security-Policy is sent", /script-src/.test(pg.headers["content-security-policy"] || ""));
    const csrf = s.csrfOf(pg.body);
    const up = (cookie, q, body, h) =>
      new Promise((resolve, reject) => {
        const http = require("http");
        const r = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: "/mint-ai/api/voiceprint-trial/clip?" + q, headers: Object.assign({ "X-Forwarded-Proto": "https", Cookie: cookie, "Content-Type": "audio/wav", "Content-Length": body.length }, h || {}) }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode, body: b }));
        });
        r.on("error", reject);
        r.end(body);
      });
    const clip = wavOf(tone(220, 1.5, 24000, 0.3), 24000);
    check("an upload without CSRF is refused", (await up(ad.cookie, "slot=laptop&id=t01", clip)).status === 403);
    check("a role without voice.manage cannot upload", (await up(op.cookie, "slot=laptop&id=t01", clip, { "X-CSRF-Token": csrf })).status === 403);
    const ok = await up(ad.cookie, "slot=laptop&id=t01", clip, { "X-CSRF-Token": csrf, "X-Mic-Label": encodeURIComponent("Headset Microphone (Jabra Evolve2 65)") });
    check("administrator: a clip is saved", ok.status === 200 && JSON.parse(ok.body).count === 1 && JSON.parse(ok.body).seconds === 1.5, ok.body);
    const bad = await up(ad.cookie, "slot=laptop&id=t02", wavOf(new Int16Array(24000), 24000), { "X-CSRF-Token": csrf });
    check("a silent clip is refused with a reason", bad.status === 400 && /Nothing was heard/.test(bad.body), bad.body);
    const big = await up(ad.cookie, "slot=laptop&id=e1", Buffer.alloc(vp.MAX_BYTES + 10), { "X-CSRF-Token": csrf });
    check("an oversized upload is refused (413)", big.status === 413, big.status);
    const stj = JSON.parse((await s.req("GET", "/mint-ai/api/voiceprint-trial/status", { cookie: ad.cookie })).body);
    check("status lists it with the device", stj.slots.laptop.clips.t01 === 1.5 && stj.slots.laptop.device === "Headset Microphone (Jabra Evolve2 65)" && Object.keys(stj.slots.headset.clips).length === 0);
    const get = await s.req("GET", "/mint-ai/api/voiceprint-trial/clip/laptop/t01", { cookie: ad.cookie });
    check("play back: a 16 kHz WAV, not cached", get.status === 200 && /audio\/wav/.test(get.headers["content-type"]) && /no-store/.test(get.headers["cache-control"] || ""));
    check("play back an unknown clip: 404", (await s.req("GET", "/mint-ai/api/voiceprint-trial/clip/laptop/t09", { cookie: ad.cookie })).status === 404);
    const ud = path.join(s.data, "voiceprint-trial", "vpadmin");
    check("stored under DATA_DIR/voiceprint-trial/<user>/<slot>/, 0700/0600", fs.existsSync(path.join(ud, "laptop", "t01.wav")) && mode(ud) === "700" && mode(path.join(ud, "laptop", "t01.wav")) === "600");
    check("delete without CSRF is refused", (await s.req("POST", "/mint-ai/api/voiceprint-trial/delete", { cookie: ad.cookie, body: {} })).status === 403);
    const del = await s.req("POST", "/mint-ai/api/voiceprint-trial/delete", { cookie: ad.cookie, body: {}, headers: { "X-CSRF-Token": csrf } });
    check("delete removes the folder", del.status === 200 && JSON.parse(del.body).deleted === 1 && !fs.existsSync(ud), del.body);
    const db = require(path.join(ROOT, "lib", "db.js"));
    const rows = db.recentLogins(50).filter((r) => r.outcome === "voiceprint");
    check("audit: started and deleted, counts only", rows.some((r) => /recording started on "laptop"/.test(r.detail)) && rows.some((r) => /deleted all trial recordings \(1 clips\)/.test(r.detail)) && rows.every((r) => !/Jabra|t01/.test(r.detail)), JSON.stringify(rows));
    const vs = await s.req("GET", "/mint-ai/settings/voice", { cookie: ad.cookie });
    check("Settings ▸ Voice links to the trial", vs.status !== 200 || /href="\/mint-ai\/voiceprint-trial"/.test(vs.body), vs.status);
    await browser(s, ad);
  } finally {
    s.stop();
  }
}

async function browser(s, ad) {
  section("the page in Chromium (fake microphone)");
  let chromium;
  try {
    ({ chromium } = require(process.env.PLAYWRIGHT || "playwright"));
  } catch (e) {
    console.log("  skip no Playwright (set PLAYWRIGHT=/path/to/node_modules/playwright)");
    return;
  }
  const b = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const cookies = ad.cookie.split("; ").map((c) => {
      const i = c.indexOf("=");
      return { name: c.slice(0, i), value: c.slice(i + 1), domain: "127.0.0.1", path: "/" };
    });
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      for (const scheme of ["light", "dark"]) {
        const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, permissions: ["microphone"] });
        await ctx.addCookies(cookies);
        const page = await ctx.newPage();
        const errs = [];
        page.on("pageerror", (e) => errs.push(e.message));
        page.on("console", (m) => {
          const t = m.text();
          if ((m.type() === "error" && !/Failed to load resource|net::ERR|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t);
        });
        const tag = `${w} px ${scheme}`;
        await page.goto(`http://127.0.0.1:${s.port}/mint-ai/voiceprint-trial`);
        await page.waitForSelector("#vp");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(tag + ": no horizontal scroll", overflow <= 0, overflow);
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        check(tag + ": the theme applies", scheme === "dark" ? !/255, 255, 255/.test(bg) : true, bg);
        if (await page.isVisible("#vp-allow")) await page.click("#vp-allow");
        await page.waitForFunction(() => document.querySelectorAll("#vp-device option").length > 1, null, { timeout: 5000 }).catch(() => {});
        const devs = await page.$$eval("#vp-device option", (o) => o.length);
        check(tag + ": the microphone list fills after allowing", devs > 1, devs);
        if (devs > 1) await page.selectOption("#vp-device", { index: 1 });
        await page.click('[data-rec="t05"]');
        await page.waitForFunction(() => /recording/.test(document.querySelector('[data-state="t05"]').textContent), null, { timeout: 5000 });
        await page.waitForTimeout(1300);
        await page.click('[data-rec="t05"]');
        await page.waitForFunction(() => /recorded ·|between|Nothing|HTTP/.test(document.querySelector('[data-state="t05"]').textContent), null, { timeout: 8000 }).catch(() => {});
        const st = await page.textContent('[data-state="t05"]');
        check(tag + ": a phrase is recorded through the worklet and saved", /recorded · 1\.[2-6] s/.test(st), st);
        check(tag + ": the count says 1 for this microphone", (await page.textContent("#vp-count")) === "1");
        const focused = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-rec"));
        check(tag + ": the next phrase is ready", focused === "t06", focused);
        check(tag + ": Play is offered", await page.isVisible('[data-play="t05"]'));
        await page.selectOption("#vp-slot", "headset");
        check(tag + ": another microphone starts at 0", (await page.textContent("#vp-count")) === "0" && /not recorded/.test(await page.textContent('[data-state="t05"]')));
        await page.selectOption("#vp-slot", "laptop");
        const ud = path.join(s.data, "voiceprint-trial", "vpadmin", "laptop", "t05.wav");
        const saved = fs.existsSync(ud) ? vp.parseWav(fs.readFileSync(ud)) : null;
        check(tag + ": on disk as 16 kHz with sound in it", saved && saved.rate === 16000 && vp.peakDb(saved.samples) > -40, saved && vp.peakDb(saved.samples));
        await page.click("#vp-delete");
        const yes = await page.waitForSelector('.cc-sdlg [data-a="yes"]', { timeout: 3000 }).catch(() => null);
        check(tag + ": delete asks first", !!yes);
        if (yes) await yes.click();
        await page.waitForFunction(() => /Deleted/.test(document.querySelector("#vp-del-state").textContent), null, { timeout: 5000 }).catch(() => {});
        check(tag + ": delete through the confirm", /Deleted 1 recording/.test(await page.textContent("#vp-del-state")) && !fs.existsSync(ud), await page.textContent("#vp-del-state"));
        if (w === 390 && scheme === "dark") await page.screenshot({ path: path.join(os.tmpdir(), "vp-390-dark.png"), fullPage: false });
        if (w === 1440 && scheme === "light") await page.screenshot({ path: path.join(os.tmpdir(), "vp-1440-light.png"), fullPage: false });
        check(tag + ": zero page errors and CSP violations", errs.length === 0, errs.join("\n"));
        await ctx.close();
      }
    }
  } finally {
    await b.close();
  }
}

(async () => {
  try {
    unit();
    await server();
  } catch (e) {
    failed++;
    console.log("  FAIL no exception\n" + e.stack);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
