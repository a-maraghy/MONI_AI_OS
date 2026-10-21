#!/usr/bin/env node
"use strict";
/**
 * Eye contact (2026-10-20, mockups/eye-contact/DESIGN.md): camera presence.
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-presence.cjs [--shots DIR]
 *
 * 1. The pure logic (public/mint-presence-logic.js) on synthetic landmark streams: the model's output reduced
 *    (no landmarks kept), head pose, "at the screen" / "at the bot", the presence / attention state machine and
 *    its hysteresis, the eyes' direction, the person among other faces, look and speak's gate, a reply's pause,
 *    the held notes and their summary, the frame rate / release rules, the switches' defaults; core E's doze.
 * 2. The wiring: assets on the page, the worker's own CSP, Settings off by default, the app's half (settings,
 *    capability: the page may switch it off, never on; presence.rs tested in core-tests).
 * 3. Headless Chromium with a fake camera (--use-fake-device-for-media-stream): off by default (the camera is
 *    never asked for), on -> the vendored face model runs in its worker on the frames, the indicator shows, and
 *    NO request leaves for anywhere but this site's own static files (every request and every request body is
 *    watched), the camera is let go of (locked, off from Settings, the indicator's Off, hidden); then the page
 *    side driven by a stand-in camera module: the bot's eyes and doze, the glance cards, held toasts / sounds /
 *    Windows toasts and the one summary, the catch-up, look and speak, a reply's pause. Zero CSP violations.
 *    --shots DIR writes the Settings screen.
 * 4. Which camera (2026-10-21): Automatic's ranking and the fallbacks on realistic Windows camera lists (pure);
 *    then Chromium with three fake cameras renamed like a laptop's (a phone through Phone Link, the integrated
 *    webcam, its IR camera): Automatic opens the webcam (deviceId exact), the pill names it, the Settings
 *    selector lists them and switches the open Command Center at once, a stale id with the same name, a removed
 *    camera (devicechange) and a camera that is gone fall back to Automatic and say so; the names only after
 *    "Allow the camera once" (released at once); in the app's render mode too; no request carries a camera's
 *    name or id. --shots DIR also writes the selector (browser + app, dark + light).
 */
const scratch = require("./scratch-server.cjs"); // first: sets MONI_DATA_DIR
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const D = path.join(ROOT, "..", "desktop");
const L = require(path.join(ROOT, "public", "mint-presence-logic.js"));
const BOT = require(path.join(ROOT, "public", "mint-core-bot.js"));
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 MintDesktop/0.1.12";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 900) : "")); }
}
const section = (t) => console.log("\n" + t);

/* ------------------------------------------------------------------ synthetic landmark streams */
/**
 * One face as FaceLandmarker returns it: 478 landmarks filling a box (cx, cy, w; the camera's own unmirrored
 * image, fractions), the head's facial transformation matrix for (yaw, pitch), the jawOpen blendshape.
 */
function face(o) {
  const w = o.w || 0.24, h = w * 1.3, pts = [];
  for (let i = 0; i < 478; i++) { const a = (i * 2.399) % (2 * Math.PI), r = Math.sqrt((i + 0.5) / 478); pts.push({ x: o.cx + Math.cos(a) * r * w / 2, y: o.cy + Math.sin(a) * r * h / 2, z: 0 }); }
  // the extremes, so the box is exactly the one asked for
  pts.push({ x: o.cx - w / 2, y: o.cy, z: 0 }, { x: o.cx + w / 2, y: o.cy, z: 0 }, { x: o.cx, y: o.cy - h / 2, z: 0 }, { x: o.cx, y: o.cy + h / 2, z: 0 });
  return { pts, m: L.matrixOf(o.yaw || 0, o.pitch || 0), jaw: o.jaw == null ? 0.02 : o.jaw, eyeDown: o.eyeDown, eyeUp: o.eyeUp };
}
function result(faces) {
  return {
    faceLandmarks: faces.map((f) => f.pts),
    facialTransformationMatrixes: faces.map((f) => ({ rows: 4, columns: 4, data: f.m })),
    faceBlendshapes: faces.map((f) => ({ categories: [{ categoryName: "eyeBlinkLeft", score: 0.1 }, { categoryName: "jawOpen", score: f.jaw }].concat(
      f.eyeDown != null || f.eyeUp != null ? ["Left", "Right"].flatMap((k) => [{ categoryName: "eyeLookDown" + k, score: f.eyeDown || 0 }, { categoryName: "eyeLookUp" + k, score: f.eyeUp || 0 }]) : []) })),
  };
}
/** A stream: [{ ms, faces: [face opts] }...] at fps -> the tracker's snapshots. */
function run(tr, segs, fps, t0) {
  let t = t0 || 0;
  const out = [];
  const dt = 1000 / (fps || 5);
  segs.forEach((s) => {
    const end = t + s.ms;
    for (; t < end; t += dt) {
      const fs_ = (typeof s.faces === "function" ? s.faces(t) : s.faces || []).map(face);
      out.push(Object.assign({ t }, tr.push(L.summarize(result(fs_)), t)));
    }
  });
  return { out, t, last: out[out.length - 1] };
}
const BOTPOS = { x: 0.85, y: 0.85 };
// Looking at the screen's middle from the middle of the camera's view; at the bot (bottom right); away.
const AT_SCREEN = { cx: 0.5, cy: 0.5, w: 0.24, yaw: 0, pitch: -8 };
const AT_BOT = { cx: 0.5, cy: 0.5, w: 0.24, yaw: 11, pitch: -16 };
const SIDEWAYS = { cx: 0.5, cy: 0.5, w: 0.24, yaw: 55, pitch: -5 };

(async () => {
  section("the model's output, reduced (synthetic landmark streams)");
  {
    const r = result([face({ cx: 0.4, cy: 0.55, w: 0.2, yaw: 20, pitch: -10, jaw: 0.3 })]);
    const s = L.summarize(r);
    check("one face -> one record: box centre / width, yaw / pitch, jawOpen", s.length === 1 && Math.abs(s[0].cx - 0.4) < 1e-6 && Math.abs(s[0].cy - 0.55) < 1e-6 && Math.abs(s[0].w - 0.2) < 1e-6 && Math.abs(s[0].yaw - 20) < 1e-6 && Math.abs(s[0].pitch + 10) < 1e-6 && s[0].jaw === 0.3, JSON.stringify(s));
    check("  the landmarks stop there: only those seven numbers (ey: the eyes' up/down, null without eye blendshapes)", JSON.stringify(Object.keys(s[0]).sort()) === JSON.stringify(["cx", "cy", "ey", "jaw", "pitch", "w", "yaw"]) && s[0].ey === null);
    const se = L.summarize(result([face({ cx: 0.5, cy: 0.5, w: 0.24, eyeDown: 0.4 })]))[0];
    check("  the eyes looking down 0.4 -> about 10 degrees down (eyeLookDown, no left/right ambiguity)", Math.abs(se.ey + 10) < 1e-9, se.ey);
    check("  nothing seen -> []; a face with no pose matrix is skipped", L.summarize({ faceLandmarks: [] }).length === 0 && L.summarize({ faceLandmarks: [r.faceLandmarks[0]], facialTransformationMatrixes: [] }).length === 0);
    let worst = 0;
    for (let y = -60; y <= 60; y += 15) for (let p = -40; p <= 40; p += 10) { const q = L.poseOf(L.matrixOf(y, p)); worst = Math.max(worst, Math.abs(q.yaw - y), Math.abs(q.pitch - p)); }
    check("head pose from the transformation matrix: yaw / pitch back within 1e-9 over +-60 / +-40 degrees", worst < 1e-9, worst);
  }

  section("where they look");
  {
    const c = (f) => L.classify(f, BOTPOS);
    check("frontal, at the screen's middle -> at the screen, not at the bot (bottom right)", c(AT_SCREEN).screen && !c(AT_SCREEN).bot, JSON.stringify(c(AT_SCREEN)));
    check("  turned toward the bot -> at the screen and at the bot, frontal enough to speak", c(AT_BOT).screen && c(AT_BOT).bot && c(AT_BOT).speak, JSON.stringify(c(AT_BOT)));
    check("  turned 55 degrees aside -> neither", !c(SIDEWAYS).screen && !c(SIDEWAYS).bot);
    check("  looking up over the screen / far down at the desk -> not at the screen", !c({ ...AT_SCREEN, pitch: 25 }).screen && !c({ ...AT_SCREEN, pitch: -45 }).screen);
    check("  a bot at the top left: the same head turned to the bottom right is no longer at it", !L.classify(AT_BOT, { x: 0.1, y: 0.1 }).bot);
    const a = L.aim(AT_SCREEN, BOTPOS);
    check("  the geometry: a face 0.24 of the frame wide sits about 54 cm away; the bot is 12 deg right, 18 deg down", Math.abs(a.at.D - 54) < 1 && Math.abs(a.bot.yaw - 12.4) < 0.5 && Math.abs(a.bot.pitch + 18.3) < 0.5, JSON.stringify(a));
  }

  section("the eyes: where the person is, seen from the bot");
  {
    const g = (f, b) => L.gazeFor(f, b || BOTPOS);
    const mid = g(AT_SCREEN), right = g({ ...AT_SCREEN, cx: 0.2 }), left = g({ ...AT_SCREEN, cx: 0.8 });
    check("in the middle, the bot at the bottom right -> it looks up and to the left", mid.x < 0 && mid.y < 0, JSON.stringify(mid));
    check("  they move to their right (the camera's image left) -> the eyes follow to the screen's right", right.x > mid.x && left.x < mid.x, JSON.stringify({ left, mid, right }));
    check("  they lean down / sit up -> the eyes follow down / up", g({ ...AT_SCREEN, cy: 0.8 }).y > mid.y && g({ ...AT_SCREEN, cy: 0.2 }).y < mid.y);
    check("  coarse: quarters only, inside -1..1", [mid, right, left, g({ ...AT_SCREEN, cx: 0 }), g({ ...AT_SCREEN, cy: 1, w: 0.6 })].every((v) => Math.abs(v.x * 4 - Math.round(v.x * 4)) < 1e-9 && Math.abs(v.y * 4 - Math.round(v.y * 4)) < 1e-9 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1));
    const top = g(AT_SCREEN, { x: 0.5, y: 0.02 });
    check("  a bot right under the camera looks straight out (about 0, 0)", Math.abs(top.x) <= 0.25 && Math.abs(top.y) <= 0.25, JSON.stringify(top));
  }

  section("the presence / attention state machine (5 fps)");
  {
    const tr = L.createTracker({ bot: BOTPOS });
    let r = run(tr, [{ ms: 3000, faces: [] }]);
    check("the camera has just opened on an empty desk: unknown (null) for the first seconds", r.out.every((s) => s.state === null));
    r = run(tr, [{ ms: 6000, faces: [] }], 5, r.t);
    check("  ...then away once it has watched the empty desk for 8 s", r.last.state === "away");
    const sit = run(tr, [{ ms: 1400, faces: [AT_SCREEN] }], 5, r.t);
    const firstPresent = sit.out.find((s) => s.state && s.state !== "away");
    check("someone sits down facing the screen: here within half a second, looking right after", firstPresent && firstPresent.t - r.t <= 600 && sit.last.state === "looking", JSON.stringify(sit.out.map((s) => s.state)));
    check("  the change is flagged once", sit.out.filter((s) => s.changed).length <= 2);
    let k = run(tr, [{ ms: 800, faces: [SIDEWAYS] }, { ms: 600, faces: [AT_SCREEN] }], 5, sit.t);
    check("a glance aside under 1.2 s (the keyboard, a note) keeps them 'looking': no flicker", k.out.every((s) => s.state === "looking"), JSON.stringify(k.out.map((s) => s.state)));
    k = run(tr, [{ ms: 2400, faces: [SIDEWAYS] }], 5, k.t);
    check("  turned away for longer -> 'present' (here, not looking)", k.last.state === "present" && k.last.turnedAwayMs >= 2000, JSON.stringify(k.last));
    k = run(tr, [{ ms: 600, faces: [AT_SCREEN] }], 5, k.t);
    check("  back to the screen -> looking within 0.3-0.6 s", k.last.state === "looking");
    const flick = run(tr, [{ ms: 4000, faces: (t) => (Math.floor(t / 200) % 2 ? [AT_SCREEN] : []) }], 5, k.t);
    check("the model missing every other frame does not flap the state", flick.out.every((s) => s.state === "looking"), JSON.stringify(flick.out.map((s) => s.state)));
    let w = run(tr, [{ ms: 5000, faces: [] }], 5, flick.t);
    check("they step out: still 'present' (not looking) for the first 5 s -- a lean out of the frame is not leaving", w.last.state === "present", w.last.state);
    w = run(tr, [{ ms: 3600, faces: [] }], 5, w.t);
    check("  gone 8 s -> away; the eyes have nowhere to look (gaze null)", w.last.state === "away" && w.last.gaze === null);
    const back = run(tr, [{ ms: 1000, faces: [{ ...AT_SCREEN, cx: 0.3 }] }], 5, w.t);
    check("  back -> looking, with the eyes on them again", back.last.state === "looking" && back.last.gaze && back.last.gaze.x > -0.5, JSON.stringify(back.last));
    const tr2 = L.createTracker({ bot: BOTPOS });
    const fast = run(tr2, [{ ms: 1000, faces: [AT_SCREEN] }], 2);
    check("at 2 fps (battery) the same: here and looking within a second", fast.last.state === "looking", JSON.stringify(fast.out.map((s) => s.state)));
    const tr3 = L.createTracker({ bot: BOTPOS });
    const blip = run(tr3, [{ ms: 9000, faces: [] }, { ms: 200, faces: [AT_SCREEN] }, { ms: 3000, faces: [] }], 5);
    check("one stray detection on an empty desk is not someone sitting down", blip.out.every((s) => s.state !== "present" && s.state !== "looking"), JSON.stringify(blip.out.map((s) => s.state).filter(Boolean).slice(-20)));
  }

  section("the person among other faces");
  {
    const me = { cx: 0.5, cy: 0.5, w: 0.26 }, far = { cx: 0.85, cy: 0.3, w: 0.07 }, near = { cx: 0.15, cy: 0.5, w: 0.2 };
    const p = L.pickPrimary([far, me]);
    check("the biggest (nearest) face is the person; a small one far behind is not counted", p.face === me && p.others === 0);
    check("  someone as close beside them is counted (look and speak stands down)", L.pickPrimary([me, near]).others === 1);
    const prev = { cx: 0.15, cy: 0.5 };
    check("  the one being tracked stays the person while about as big (no hopping between two people)", L.pickPrimary([me, near], prev).face === near && L.pickPrimary([me, { ...near, w: 0.1 }], prev).face === me);
  }

  section("look and speak: conservative");
  {
    function scene(o) {
      const tr = L.createTracker({ bot: BOTPOS }), gate = L.createSpeakGate();
      let t = 0, start = null;
      const look = o.look || AT_BOT;
      for (; t < 4000; t += 50) {
        if (t % 200 === 0) {
          const jaw = o.mouth === false ? 0.03 : 0.03 + (t > 2000 ? 0.25 * (Math.floor(t / 200) % 2) : 0);
          const faces = [{ ...look, jaw }].concat(o.extra ? [o.extra] : []);
          gate.vision(tr.push(L.summarize(result(faces.map(face))), t), t);
        }
        const loud = o.level ? o.level(t) : t >= 2200 && t < 3200 ? 0.08 : 0.003;
        if (gate.audio(loud, t, !!o.busy) === "start" && start === null) start = t;
      }
      return start;
    }
    const ok = scene({});
    check("they face the bot, their mouth moves, speech starts -> listening starts at the onset (~160 ms in)", ok !== null && ok >= 2200 && ok <= 2450, ok);
    check("  looking at the screen but not at the bot -> no", scene({ look: AT_SCREEN }) === null);
    check("  turned aside -> no", scene({ look: SIDEWAYS }) === null);
    check("  someone else as close in view -> no", scene({ extra: { cx: 0.15, cy: 0.5, w: 0.22, yaw: -30 } }) === null);
    check("  their mouth still (someone else talking off camera) -> no", scene({ mouth: false }) === null);
    check("  a call already held / the voice speaking -> no", scene({ busy: true }) === null);
    check("  a click (under 160 ms) -> no", scene({ level: (t) => (t >= 2500 && t < 2600 ? 0.2 : 0.003) }) === null);
    check("  a steady fan (the floor follows the room) -> no", scene({ level: () => 0.03 }) === null);
    const g = L.createSpeakGate();
    const lk = { state: "looking", atBot: true, speak: true, others: 0, mouth: true };
    g.vision(lk, 0); g.vision(lk, 700);
    let n = 0;
    for (let t = 700; t < 5000; t += 50) { g.vision(lk, t); if (g.audio(t % 1000 < 600 ? 0.1 : 0.002, t, false) === "start") n++; }
    check("  one turn, then 3 s cool-down: 2 starts in 4.3 s of on-and-off talk", n === 2, n);
  }

  section("look and speak with a real face's numbers (2026-10-21: it never started on a laptop)");
  {
    // A real person 55 cm from a laptop camera looks at a bot 12 deg right / 18 deg down mostly with their eyes: the head
    // turns ~4 deg, tips ~8 deg, the eyes look down; MediaPipe's head pose jitters +-3 deg frame to frame.
    const REAL = { cx: 0.5, cy: 0.5, w: 0.24, yaw: 4, pitch: -8, eyeDown: 0.4 };
    const jit = (f, t) => ({ ...f, yaw: f.yaw + [0, 3, -3, 2, -2, 3.5][Math.floor(t / 200) % 6], pitch: f.pitch + [0, -2, 2, -3, 3, 1][Math.floor(t / 200) % 6] });
    function scene2(o) {
      const tr = L.createTracker({ bot: BOTPOS }), gate = L.createSpeakGate(), old = o.old;
      let start = null, armedAt = null;
      for (let t = 0; t < 5000; t += 50) {
        if (t % 200 === 0) {
          const jaw = o.mouth === false ? 0.03 : 0.03 + (t > 2400 ? 0.25 * (Math.floor(t / 200) % 2) : 0);
          const me = { ...(o.look ? o.look(t) : jit(REAL, t)), jaw };
          const faces = [me].concat(o.extra ? [o.extra] : []);
          gate.vision(tr.push(L.summarize(result(faces.map(face))), t), t);
          if (gate.armed() && armedAt === null) armedAt = t;
        }
        const loud = o.level ? o.level(t) : t >= 2600 && t < 3600 ? 0.08 : 0.003;
        if (gate.audio(loud, t, false) === "start" && start === null) start = t;
      }
      return { start, armedAt, st: gate.status() };
    }
    const r = scene2({});
    check("a real look at the bot (head 4 deg, eyes down, +-3 deg jitter) arms within a second and a sentence starts listening", r.armedAt !== null && r.armedAt <= 1200 && r.start !== null && r.start >= 2600 && r.start <= 2900, JSON.stringify(r));
    const head = L.classify({ ...REAL, ey: null }, BOTPOS);
    check("  (the cause: 0.1.12 judged the head alone, within 7 deg sideways / 10 up -- this look is " + Math.abs(head.dy).toFixed(1) + " deg sideways and " + head.dp.toFixed(1) + " up off the bot)", Math.abs(head.dy) > 7 && head.dp > 10, JSON.stringify(head));
    const screenMid = scene2({ look: (t) => jit({ cx: 0.5, cy: 0.5, w: 0.24, yaw: 0, pitch: -6, eyeDown: 0.1 }, t) });
    check("  reading the middle of the screen, then talking (on the phone) -> no", screenMid.start === null, JSON.stringify(screenMid));
    const glance = scene2({ look: (t) => (t >= 2000 && t < 2400 ? REAL : { ...SIDEWAYS, eyeDown: 0 }) , level: (t) => (t >= 2200 && t < 3200 ? 0.08 : 0.003) });
    check("  a side glance at the bot (0.4 s) while someone talks -> no", glance.start === null, JSON.stringify(glance));
    check("  someone else talking off camera (their mouth still) -> no", scene2({ mouth: false }).start === null);
    const tv = scene2({ mouth: false, extra: { cx: 0.8, cy: 0.3, w: 0.08, yaw: 0, pitch: 0, jaw: 0.4 } });
    check("  a TV behind them (a small face talking, theirs still) -> no", tv.start === null, JSON.stringify(tv));
    check("  someone as close beside them -> no", scene2({ extra: { cx: 0.15, cy: 0.5, w: 0.22, yaw: -30 } }).start === null);
    const st = r.st;
    check("the checklist ('Show what it sees'): numbers only -- face, facing (degrees off, held), mouth, level vs needed, busy, cool-down", ["face", "facing", "dy", "dp", "held", "mouth", "level", "need", "busy", "coolLeft"].every((k) => k in st) && Object.values(st).every((v) => v === null || ["number", "boolean"].includes(typeof v)), JSON.stringify(st));
    const tr = L.createTracker({ bot: BOTPOS });
    let flips = 0, prev = null;
    for (let t = 0; t < 3000; t += 200) { const sn = tr.push(L.summarize(result([face(jit(REAL, t))])), t); if (prev !== null && sn.atBot !== prev) flips++; prev = sn.atBot; }
    check("  jitter does not flap 'at the bot' (median of three frames)", flips <= 1, flips);
  }

  section("a reply pauses while you look away");
  {
    const rp = L.createReplyPause();
    check("speaking, looked away 1.4 s -> goes on", rp.feed(1400, false, true) === null);
    check("  1.5 s -> pause", rp.feed(1500, false, true) === "pause" && rp.paused());
    check("  still away -> stays paused (nothing repeated)", rp.feed(4000, false, true) === null);
    check("  looks back -> resume", rp.feed(0, true, true) === "resume" && !rp.paused());
    check("  not speaking -> never pauses", rp.feed(9000, false, false) === null);
    rp.feed(2000, false, true);
    check("  the camera let go meanwhile -> resumed", rp.reset() === "resume");
  }

  section("held while away, one summary when back");
  {
    const h = L.createHolder();
    check("here (or the camera off): nothing is held", h.offer("toast", "x") === false && h.setState(null) === null && h.offer("sound", "job") === false);
    h.setState("away");
    ["Reconnected.", "Planning engine finished", "Reconnected."].forEach((t) => h.offer("toast", t));
    h.offer("native", { title: "Planning engine needs you", body: "A step waits for your approval." });
    ["done", "approval", "job"].forEach((s) => h.offer("sound", s));
    check("away: toasts, the app's Windows toasts and sounds are held", h.held() === 7);
    const sum = h.setState("looking");
    check("back: ONE summary -- the notes once each, and one sound, the most important (approval)", sum && sum.notes === 3 && sum.lines[0] === "Reconnected." && sum.lines[2] === "Planning engine needs you: A step waits for your approval." && sum.sound === "approval" && /^While you were away: Reconnected\. — and 2 more$/.test(sum.text), JSON.stringify(sum));
    check("  then nothing is held any more", h.held() === 0 && h.offer("toast", "y") === false);
    h.setState("away");
    check("  away with nothing happening -> no summary", h.setState("present") === null);
    h.setState("away"); h.offer("sound", "wake");
    check("  only a sound -> a summary with no notes, just the sound", (() => { const s = h.setState("present"); return s && s.notes === 0 && s.sound === "wake"; })());
  }

  section("the camera's frame rate, or none");
  {
    const R = (o) => L.rate(Object.assign({ on: true }, o));
    check("off -> 0 (let go)", L.rate({ on: false }).fps === 0 && L.rate({}).why === "off");
    check("  hidden / locked / another app's meeting -> 0", R({ hidden: true }).fps === 0 && R({ locked: true }).why === "locked" && R({ meeting: true }).why === "meeting");
    check("  energy saver: 0 when 'release in energy saver' (the default), else 2", R({ saver: true, releaseOnSaver: true }).fps === 0 && R({ saver: true, releaseOnSaver: false }).fps === 2);
    check("  on battery 2, nobody there 2, else 5", R({ battery: true }).fps === 2 && R({ state: "away" }).fps === 2 && R({ state: "looking" }).fps === 5 && R({}).fps === 5);
    const d = L.normPrefs(null);
    check("the switches: all off by default; 'release in energy saver' on; look and speak needs the camera", !d.cam && !d.speak && d.saver && !L.normPrefs({ speak: true }).speak && L.normPrefs('{"cam":true,"speak":true}').speak && L.normPrefs("garbage").cam === false);
  }

  section("core E: dozing follows presence while the camera is on");
  {
    const dz = (o) => BOT.dozeWanted(Object.assign({ state: "idle", quietMs: 0, hour: 14 }, o));
    check("camera off (no presence): the 10-minute timer as before", !dz({ quietMs: 9 * 60000 }) && dz({ quietMs: 10 * 60000 }));
    check("  away -> dozes at once (the state machine already waited 8 s)", dz({ presence: "away" }));
    check("  looking -> never, even after an hour or at night", !dz({ presence: "looking", quietMs: 3600000 }) && !dz({ presence: "looking", quietMs: 3600000, hour: 2 }));
    check("  here, not looking: no timer by day; the night rule (a quiet minute) still holds", !dz({ presence: "present", quietMs: 3600000 }) && dz({ presence: "present", quietMs: 61000, hour: 23 }) && !dz({ presence: "present", quietMs: 30000, hour: 23 }));
    check("  never while working, offline, or the pointer near", !dz({ presence: "away", state: "thinking" }) && !dz({ presence: "away", offline: true }) && !dz({ presence: "away", near: true }));
  }

  section("which camera: Automatic and the fallbacks (realistic Windows lists)");
  {
    const v = (id, label) => ({ kind: "videoinput", deviceId: id, label, groupId: "g" + id });
    const mic = { kind: "audioinput", deviceId: "m1", label: "Microphone Array (Realtek(R) Audio)" };
    const phone = [mic, v("p", "Connected Camera (Phone Link)"), v("w", "Integrated Webcam (0c45:6a1d)")];
    check("Phone Link first in the list + the Integrated Webcam -> the webcam", L.pickCamera(phone, null).id === "w" && L.pickCamera(phone, null).how === "auto");
    const ltw = [v("l", "Link to Windows Camera"), v("h", "HD User Facing (04f2:b6dd)")];
    check("  'Link to Windows' + 'HD User Facing' -> HD User Facing", L.pickCamera(ltw, null).id === "h");
    const ir = [v("i", "Integrated IR Camera"), v("r", "Integrated Camera (04f2:b71a)")];
    check("an IR camera listed first + the RGB one -> the RGB one", L.pickCamera(ir, null).id === "r");
    check("  only an IR camera -> it (nothing else)", L.pickCamera([v("i", "Integrated IR Camera")], null).id === "i");
    check("  IR and a phone -> the IR camera before the phone", L.pickCamera([v("p", "Phone Link"), v("i", "Integrated IR Camera")], null).id === "i");
    const virt = [v("o", "OBS Virtual Camera")];
    check("only a virtual camera -> it (better than nothing)", L.pickCamera(virt, null).id === "o" && L.pickCamera(virt, null).how === "auto");
    const many = [v("o", "OBS Virtual Camera"), v("n", "NVIDIA Broadcast"), v("d", "DroidCam Source 3"), v("c", "Camo"), v("e", "EpocCam"), v("u", "Iriun Webcam"), v("s", "Snap Camera"), v("x", "Windows Virtual Camera"), v("k", "Continuity Camera"), v("g", "Logitech BRIO")];
    check("  every phone / virtual name avoided: OBS, NVIDIA Broadcast, DroidCam, Camo, EpocCam, Iriun, Snap, Windows Virtual, Continuity -> the Logitech", L.pickCamera(many, null).id === "g" && many.slice(0, 9).every((d) => L.cameraKind(d.label) === "virtual"), many.map((d) => d.label + ":" + L.cameraKind(d.label)).join(", "));
    check("  'Iriun' is not an IR camera, 'firmware' words are not IR", L.cameraKind("Iriun Webcam") === "virtual" && L.cameraKind("USB Camera Firmware IRIS") !== "ir" && L.cameraKind("Integrated IR Camera") === "ir");
    check("a built-in camera first, another real one next (a USB webcam plugged in keeps the built-in)", L.pickCamera([v("g", "Logitech C920"), v("w", "Integrated Webcam")], null).id === "w" && L.pickCamera([v("p", "Phone Link"), v("g", "Logitech C920")], null).id === "g");
    check("a stored choice wins, even a phone", L.pickCamera(phone, { id: "p", label: "Connected Camera (Phone Link)" }).id === "p" && L.pickCamera(phone, { id: "p", label: "x" }).how === "chosen");
    const re = [v("new-id", "Integrated Webcam (0c45:6a1d)"), v("p", "Connected Camera (Phone Link)")];
    const cl = L.pickCamera(re, { id: "old-id", label: "Integrated Webcam (0c45:6a1d)" });
    check("  the same camera under a new deviceId: found by its name", cl.id === "new-id" && cl.how === "chosen-label" && !cl.note, JSON.stringify(cl));
    check("  ... the name without Windows' USB ids matches too", L.pickCamera(re, { id: "old", label: "Integrated Webcam" }).id === "new-id");
    const gone = L.pickCamera(phone, { id: "c920", label: "Logitech C920" });
    check("a removed camera: Automatic (the webcam), and the note says so", gone.id === "w" && gone.how === "auto" && gone.note === "Logitech C920 is not connected — using Automatic", JSON.stringify(gone));
    const fail = L.pickCamera(phone, { id: "w", label: "Integrated Webcam (0c45:6a1d)" }, { avoid: ["w"] });
    check("  the chosen camera failed to open: the next best, and the note says it could not be opened", fail.id === "p" && /could not be opened — using Automatic/.test(fail.note), JSON.stringify(fail));
    const nolab = [v("", ""), { kind: "audioinput", deviceId: "", label: "" }];
    const nl = L.pickCamera(nolab, null);
    check("before the camera was ever allowed (no names, no ids): no deviceId -- the browser's default, decided again once the names show", nl.id === null && nl.how === "default");
    check("no camera at all: the default (the camera module then says 'no camera')", L.pickCamera([mic], null).id === null);
    check("the pill's short name: no USB ids, at most 26 characters", L.shortCam("Integrated Webcam (0c45:6a1d)") === "Integrated Webcam" && L.shortCam("Microsoft® LifeCam HD-3000 Very Long Model Name").length <= 26);
    check("the stored choice is checked: {id,label} only, junk -> Automatic", JSON.stringify(L.normCamChoice('{"id":"a","label":"b","x":1}')) === '{"id":"a","label":"b"}' && L.normCamChoice("nope") === null && L.normCamChoice({}) === null && L.normCamChoice(null) === null);
  }

  section("the wiring");
  {
    const views = fs.readFileSync(path.join(ROOT, "lib", "views-moniai.js"), "utf8");
    const lists = views.match(/\["(?:mint-desktop-webauthn|voice-live\.css)[^\]]+\]/g) || [];
    check("both Command Center pages load the logic, the camera module, its binding and CSS (desktop render mode and browser)", lists.length === 2 && lists.every((l) => /"mint-presence\.css", "mint-presence-logic\.js", "mint-presence\.js", "mint-presence-bind\.js"/.test(l)), lists.length);
    const vend = path.join(ROOT, "public", "vendor", "mediapipe");
    const need = ["tasks-vision-0.10.21/vision_bundle.js", "tasks-vision-0.10.21/wasm/vision_wasm_internal.js", "tasks-vision-0.10.21/wasm/vision_wasm_internal.wasm", "models/face_landmarker-float16-v1.task", "LICENSE-Apache-2.0.txt", "README.md"];
    check("the face model and its runtime are vendored, pinned, with the licence and checksums", need.every((f) => fs.existsSync(path.join(vend, f))), need.filter((f) => !fs.existsSync(path.join(vend, f))));
    const readme = fs.existsSync(path.join(vend, "README.md")) ? fs.readFileSync(path.join(vend, "README.md"), "utf8") : "";
    const crypto = require("crypto");
    const sums = need.slice(0, 4).map((f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(vend, f))).digest("hex"));
    check("  README's sha256 match the files", sums.every((h) => readme.includes(h)));
    const pres = fs.readFileSync(path.join(ROOT, "public", "mint-presence.js"), "utf8"), wk = fs.readFileSync(path.join(ROOT, "public", "mint-presence-worker.js"), "utf8");
    check("  the camera module and its worker make no request of their own (no fetch / XHR / WebSocket / beacon)", ![pres, wk].some((s) => /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))));
    const sett = fs.readFileSync(path.join(D, "src-tauri", "src", "settings.rs"), "utf8"), lib = fs.readFileSync(path.join(D, "src-tauri", "src", "lib.rs"), "utf8");
    const remote = JSON.parse(fs.readFileSync(path.join(D, "src-tauri", "capabilities", "remote.json"), "utf8"));
    check("the app: a presence setting (off by default, presence.rs); the site may say it holds the camera and switch it off -- no command switches it on", /pub presence: crate::presence::Presence/.test(sett) && remote.permissions.includes("allow-presence-off") && remote.permissions.includes("allow-presence-status") && !remote.permissions.some((p) => /presence-on|settings-set/.test(p)));
    check("  the camera request goes through presence::permission; the profile's stored permission follows the setting; a request is never saved", /presence::permission\(ask, ours, camera_on\)/.test(lib) && /SetPermissionState\(COREWEBVIEW2_PERMISSION_KIND_CAMERA/.test(lib) && /SetSavesInProfile\(false\)/.test(lib));
    check("  the tray has the 'Camera presence' switch", /CheckMenuItem::with_id\(app, "presence"/.test(lib));
  }

  section("in the browser (a fake camera)");
  {
    let chromium;
    try { ({ chromium } = require(process.env.PLAYWRIGHT || "playwright")); } catch (e) { chromium = null; }
    if (!chromium) { check("playwright is available (set PLAYWRIGHT)", false); }
    else {
      const s = await scratch.startScratch({});
      let browser = null;
      try {
        await s.makeUser("eyes", "administrator");
        const { cookie } = await s.signIn("eyes");
        const ORIGIN = "http://127.0.0.1:" + s.port;
        const wr = await s.req("GET", "/static/mint-presence-worker.js", { cookie });
        const wcsp = String((wr.headers && wr.headers["content-security-policy"]) || "");
        const pg = await s.req("GET", "/mint-ai", { cookie });
        const pcsp = String((pg.headers && pg.headers["content-security-policy"]) || "");
        check("the worker has its own policy: WebAssembly yes, eval of JavaScript no, this site only", /script-src 'self' 'wasm-unsafe-eval'/.test(wcsp) && /connect-src 'self'/.test(wcsp) && !/unsafe-eval'(?!.*wasm)/.test(wcsp.replace("'wasm-unsafe-eval'", "")), wcsp);
        check("  the pages keep theirs (no wasm, no eval)", /script-src 'self'/.test(pcsp) && !/unsafe-eval/.test(pcsp), pcsp);
        browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream=device-count=3", "--use-fake-ui-for-media-stream", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
        async function open(o) {
          o = o || {};
          const ctx = o.ctx || await browser.newContext({ viewport: { width: o.W || 1280, height: o.H || 800 }, colorScheme: o.scheme || "light", userAgent: o.ua, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, permissions: ["camera", "microphone"] });
          if (!o.ctx) await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
          const reqs = [];
          ctx.on("request", (r) => { const b = r.postDataBuffer(); reqs.push({ url: r.url(), method: r.method(), type: r.resourceType(), body: b ? b.length : 0, txt: b ? b.toString("latin1") : "", hdr: JSON.stringify(r.headers()), img: b ? /data:image|\x89PNG|\xff\xd8\xff|JFIF|RIFF....WEBP/.test(b.toString("latin1")) : false }); });
          const page = await ctx.newPage();
          const errs = [];
          page.on("pageerror", (e) => errs.push(e.message));
          page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource|^INFO: Created TensorFlow Lite/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t); });
          page.on("worker", (w) => { w.on("console", (m) => { if (m.type() === "error" && !/^INFO: Created TensorFlow Lite/.test(m.text())) errs.push("worker: " + m.text()); }); });
          await page.addInitScript((a) => {
            window.__csp = [];
            document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
            // The camera asks and what became of each track (stopped = let go).
            window.__gum = [];
            const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
            if (a.cams) {
              // The fake cameras renamed like a laptop's (a.cams[i] for fake_device_i); a.hide: ids not listed (unplugged);
              // a.noLabels: names and ids hidden until the camera has been allowed once in this page (as before a first permission).
              const en = md.enumerateDevices.bind(md);
              window.__hide = a.hide || [];
              md.enumerateDevices = () => en().then((l) => l.map((d) => {
                if (d.kind !== "videoinput") return d;
                const m = /fake_device_(\d+)/.exec(d.label), lab = m && a.cams[+m[1]] != null ? a.cams[+m[1]] : d.label;
                const blind = a.noLabels && !window.__gum.some((g) => g.video);
                return { kind: d.kind, deviceId: blind ? "" : d.deviceId, groupId: d.groupId, label: blind ? "" : lab, toJSON() { return this; } };
              }).filter((d) => !window.__hide.includes(d.deviceId)));
            }
            md.getUserMedia = (c) => orig(c).then((st) => { const vt = st.getVideoTracks()[0]; const rec = { c: JSON.parse(JSON.stringify(c)), dev: vt && vt.getSettings ? vt.getSettings().deviceId : "", video: !!c.video, audio: !!c.audio, tracks: st.getTracks().map((t) => ({ kind: t.kind, on: true })) }; st.getTracks().forEach((t, i) => { const stop = t.stop.bind(t); t.stop = () => { rec.tracks[i].on = false; stop(); }; }); window.__gum.push(rec); return st; });
            window.__camOpen = () => window.__gum.filter((g) => g.video && g.tracks.some((t) => t.on)).length;
            if (a.prefs) try { localStorage.setItem("mint-presence", JSON.stringify(a.prefs)); } catch (e) { /* no storage */ }
            if (a.fake) {
              // A stand-in camera module: the page's side driven with chosen states (the real one needs a face).
              const subs = [];
              let hooks = {};
              window.MintPresence = { configure: (c) => { window.__mpCfg = c; }, on: (f) => subs.push(f), snapshot: () => ({}), hooks: (h) => { hooks = h; }, release: () => {}, turnEnded: () => {}, diag: () => ({}) };
              window.__mp = { emit: (s) => subs.forEach((f) => f(s)), hooks: () => hooks };
            }
            if (a.tauri) {
              window.__calls = [];
              const Lz = (window.__listeners = {});
              window.__TAURI__ = { core: { invoke: (cmd, args) => { window.__calls.push([cmd, args || {}]); return Promise.resolve(cmd === "get_state" ? a.tauri : null); } }, event: { listen: (n, f) => { (Lz[n] = Lz[n] || []).push(f); return Promise.resolve(() => {}); } } };
              window.__emit = (n, p) => (Lz[n] || []).forEach((f) => f({ payload: p }));
            }
          }, o);
          if (o.camChoice !== undefined) await page.addInitScript((v) => { try { if (v) localStorage.setItem("mint-presence-camera", JSON.stringify(v)); else localStorage.removeItem("mint-presence-camera"); } catch (e) { /* no storage */ } }, o.camChoice);
          await page.goto(ORIGIN + (o.path || "/mint-ai"), { waitUntil: "load" });
          await page.waitForTimeout(o.wait || 1500);
          return { ctx, page, errs, reqs };
        }
        const isStaticOk = (u) => { const x = new URL(u); return x.origin === ORIGIN; };

        // 1. Off by default: the camera is never asked for.
        const a = await open({ wait: 3000 });
        const off = await a.page.evaluate(() => ({ gum: window.__gum.length, pill: !!document.getElementById("mp-cam"), snap: window.MintPresence && window.MintPresence.snapshot(), worker: window.MintPresence.diag().worker }));
        check("off by default: the camera is never asked for, no worker, no indicator, the state unknown (null)", off.gum === 0 && !off.pill && !off.worker && off.snap.state === null && off.snap.camera === false, JSON.stringify(off));
        const offPaths = new Set(a.reqs.map((r) => new URL(r.url).pathname));
        check("  nothing of the face model is even downloaded", ![...offPaths].some((p) => /vendor\/mediapipe|mint-presence-worker/.test(p)), [...offPaths].filter((p) => /presence|mediapipe/.test(p)).join(", "));
        await a.ctx.close();

        // 2. Switched on in this browser: the model runs on the camera's frames, in its worker.
        const b = await open({ prefs: { cam: true }, wait: 500 });
        let d = null;
        for (let i = 0; i < 60; i++) { await b.page.waitForTimeout(500); d = await b.page.evaluate(() => window.MintPresence.diag()); if (d.frames >= 8) break; }
        const st1 = await b.page.evaluate(() => ({ gum: window.__gum.map((g) => ({ v: g.video, a: g.audio })), open: window.__camOpen(), pill: !!document.getElementById("mp-cam"), cls: document.documentElement.classList.contains("mp-cam-on"), snap: window.MintPresence.snapshot() }));
        check("switched on: the camera opens (video only), the face model loads in its worker and reads frames", st1.open === 1 && st1.gum.length === 1 && st1.gum[0].v && !st1.gum[0].a && d && d.ready && d.frames >= 8, JSON.stringify({ st1, d }));
        check("  the 'Camera on' indicator shows while it is open", st1.pill && st1.cls);
        check("  small and slow: about 5 frames a second, each read in the worker (" + (d && d.ms) + " ms for the last one)", d && d.fps === 5 && d.ms >= 0, JSON.stringify(d));
        check("  only the state leaves the module: the snapshot is { state, gaze, camera, why }", JSON.stringify(Object.keys(st1.snap).sort()) === JSON.stringify(["camera", "gaze", "state", "why"]) && st1.snap.camera === true);
        await b.page.waitForTimeout(9000);
        const awaySnap = await b.page.evaluate(() => window.MintPresence.snapshot());
        check("  the fake camera shows no one: after 8 s 'away'", awaySnap.state === "away", JSON.stringify(awaySnap));
        const tcam = b.reqs.length;
        await b.page.waitForTimeout(6000); // six more seconds of frames: what goes out meanwhile?
        const during = b.reqs.slice(tcam);
        check("no frame leaves: every request goes to this site; the model's files are GETs of its own static files", b.reqs.every((r) => isStaticOk(r.url)) && b.reqs.filter((r) => /presence|mediapipe/.test(r.url)).every((r) => r.method === "GET" && /^\/static\//.test(new URL(r.url).pathname)), JSON.stringify(b.reqs.filter((r) => !isStaticOk(r.url)).map((r) => r.url)));
        check("  ~30 frames read meanwhile and nothing sent for them: no request but the page's usual polling (GETs), no upload", during.every((r) => r.method === "GET" && /^\/mint-ai\/api\//.test(new URL(r.url).pathname)), JSON.stringify(during.map((r) => r.method + " " + new URL(r.url).pathname)));
        check("  no request body ever carries an image, and none is larger than a few kB", b.reqs.every((r) => !r.img && r.body < 4096), JSON.stringify(b.reqs.filter((r) => r.body).map((r) => [new URL(r.url).pathname, r.body])));
        await b.page.click("#mp-cam .mp-off");
        await b.page.waitForTimeout(300);
        const pk = await b.page.evaluate(() => ({ open: window.__camOpen(), pill: !!document.getElementById("mp-cam"), snap: window.MintPresence.snapshot(), d: window.MintPresence.diag(), ls: JSON.parse(localStorage.getItem("mint-presence") || "{}") }));
        check("the indicator's Off: the camera let go of at once (its track stopped), the worker ended, the indicator gone, the state null; off for this browser", pk.open === 0 && !pk.pill && pk.snap.state === null && !pk.d.worker && pk.ls.cam === false, JSON.stringify(pk));
        // on again, then off from Settings in another tab: the storage event
        await b.page.evaluate(() => { localStorage.setItem("mint-presence", JSON.stringify({ cam: true })); window.dispatchEvent(new StorageEvent("storage", { key: "mint-presence" })); });
        await b.page.waitForTimeout(1500);
        const tabs = await b.ctx.newPage();
        await tabs.goto(ORIGIN + "/mint-ai/settings/appearance", { waitUntil: "load" });
        await tabs.waitForTimeout(500);
        const before = await b.page.evaluate(() => window.__camOpen());
        await tabs.click("#mp-cam-row label.sw");
        await b.page.waitForTimeout(600);
        const after = await b.page.evaluate(() => window.__camOpen());
        check("  switched off in Settings (another tab): the open Command Center lets go of it at once", before === 1 && after === 0, before + " -> " + after);
        await tabs.click("#mp-cam-row label.sw"); // on again
        await b.page.waitForTimeout(1500);
        const again = await b.page.evaluate(() => window.__camOpen());
        await b.page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
        await b.page.waitForTimeout(3000);
        const brief = await b.page.evaluate(() => window.__camOpen());
        await b.page.waitForTimeout(7600);
        const hid = await b.page.evaluate(() => ({ open: window.__camOpen(), why: window.MintPresence.diag().why }));
        check("  on again, then the page hidden: kept through a quick switch away (3 s), let go after 10 s", again === 1 && brief === 1 && hid.open === 0 && hid.why === "hidden", JSON.stringify({ again, brief, hid }));
        const csp1 = await b.page.evaluate(() => window.__csp);
        check("no page errors, no CSP violations (the WebAssembly ran under the worker's own policy)", b.errs.length === 0 && csp1.length === 0, JSON.stringify(b.errs.concat(csp1)));
        await b.ctx.close();

        // the desktop app's render mode, the real module: the app's lock / meeting / energy saver let go of it
        const AH = { mode: "floating", peekOpen: true, presence: { camera: true, speak: false, releaseOnSaver: true, onBattery: false, energySaver: false, locked: false, meeting: false, inUse: false } };
        const ap = await open({ path: "/mint-ai?shell=desktop", ua: APP_UA, tauri: AH, W: 480, H: 860, wait: 3000 });
        const pv = (o) => Object.assign({}, AH.presence, o);
        const cam = () => ap.page.evaluate(() => ({ open: window.__camOpen(), why: window.MintPresence.diag().why, st: window.__calls.filter((c) => c[0] === "presence_status").map((c) => c[1].inUse) }));
        const a0 = await cam();
        check("in the app, on: the camera opens; the page tells the app (presence_status inUse)", a0.open === 1 && a0.st.includes(true), JSON.stringify(a0));
        const res = {};
        for (const [k, o] of [["locked", { locked: true }], ["meeting", { meeting: true }], ["energy saver", { energySaver: true }], ["off", { camera: false }]]) {
          await ap.page.evaluate((p) => window.__emit("mint://state", { presence: p }), pv(o));
          await ap.page.waitForTimeout(300);
          res[k] = await cam();
          await ap.page.evaluate((p) => window.__emit("mint://state", { presence: p }), pv({}));
          await ap.page.waitForTimeout(1800);
          res[k].back = (await cam()).open;
        }
        check("  the screen locked / another app's meeting / energy saver / switched off in the app: let go at once, and back after", ["locked", "meeting", "energy saver", "off"].every((k) => res[k].open === 0 && res[k].back === 1) && res.locked.why === "locked" && res.meeting.why === "meeting" && res["energy saver"].why === "energy saver" && res.off.why === "off", JSON.stringify(res));
        await ap.page.evaluate((p) => window.__emit("mint://state", { presence: p }), pv({ energySaver: true }));
        await ap.page.evaluate(() => window.__emit("mint://state", { presence: { camera: true, speak: false, releaseOnSaver: false, onBattery: true, energySaver: false, locked: false, meeting: false } }));
        await ap.page.waitForTimeout(1500);
        const bat = await ap.page.evaluate(() => window.MintPresence.diag());
        check("  on battery: kept, at 2 frames a second", bat.fps === 2, JSON.stringify(bat));
        check("  the app's last word was 'let go' -> it was told (presence_status false)", (await cam()).st.includes(false));
        // the "Camera on" pill in the app: its Off button shows and is a hit region (mint-desktop.js HIT), so a click reaches it
        await ap.page.evaluate((p) => window.__emit("mint://state", { presence: p }), pv({}));
        await ap.page.waitForTimeout(1800);
        const pl = await ap.page.evaluate(async () => {
          const pill = document.getElementById("mp-cam"), b = pill && pill.querySelector(".mp-off");
          if (!b) return { pill: !!pill };
          await new Promise((r) => setTimeout(r, 300));
          const q = b.getBoundingClientRect(), x = q.left + q.width / 2, y = q.top + q.height / 2;
          const regs = window.MintDesktop.regions();
          return { pill: true, shown: q.width > 0 && q.height > 0 && getComputedStyle(b).display !== "none", hit: regs.some((g) => x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h), top: document.elementFromPoint(x, y) === b };
        });
        check("  the \"Camera on\" pill in the app: its Off button shows and catches the mouse (a hit region, on top)", pl.pill && pl.shown && pl.hit && pl.top, JSON.stringify(pl));
        if (pl.shown) {
          await ap.page.evaluate(() => { window.__calls.length = 0; });
          await ap.page.click("#mp-cam .mp-off");
          await ap.page.waitForTimeout(200);
          const pc = await ap.page.evaluate(() => ({ off: window.__calls.some((c) => c[0] === "presence_off"), open: window.__camOpen() }));
          check("  a click on Off: the camera is let go and the app is told (presence_off)", pc.off && pc.open === 0, JSON.stringify(pc));
        }
        const csp3 = await ap.page.evaluate(() => window.__csp);
        check("  no page errors, no CSP violations", ap.errs.length === 0 && csp3.length === 0, JSON.stringify(ap.errs.concat(csp3)));
        await ap.ctx.close();

        // 3. Settings: the opt-in screen.
        const so = await open({ path: "/mint-ai/settings/appearance", wait: 800 });
        const set0 = await so.page.evaluate(() => { const b = document.getElementById("mp-set"); const q = (k) => b.querySelector('[data-mp="' + k + '"]'); return { has: !!b, text: b.textContent, cam: q("cam").checked, speak: q("speak").checked, saver: q("saver").checked, speakDis: q("speak").disabled }; });
        check("Settings > Appearance > Eye contact: a plain explanation, everything off (release in energy saver on), look and speak waits for the camera", set0.has && /No picture, video or face data is stored or sent anywhere/.test(set0.text) && !set0.cam && !set0.speak && set0.saver && set0.speakDis, JSON.stringify(set0).slice(0, 300));
        await so.page.click("#mp-cam-row label.sw");
        await so.page.waitForTimeout(150);
        const set1 = await so.page.evaluate(() => ({ ls: JSON.parse(localStorage.getItem("mint-presence")), note: document.getElementById("mp-note").textContent, gum: window.__gum.length }));
        check("  switched on: this browser's switch only (never sent), and the Settings page itself never opens the camera", set1.ls.cam === true && /browser asks you once/.test(set1.note) && set1.gum === 0, JSON.stringify(set1));
        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          await so.page.evaluate(() => { document.getElementById("mp-set").scrollIntoView({ block: "start" }); });
          await so.page.waitForTimeout(200);
          const el = await so.page.$("#mp-set");
          await el.screenshot({ path: path.join(SHOTS, "settings-opt-in.png") });
        }
        check("  no page errors on Settings", so.errs.length === 0, JSON.stringify(so.errs));
        await so.ctx.close();

        // 3b. Which camera: three fake cameras named like a laptop's (Phone Link first, as Windows lists it).
        const CAMS = ["Connected Camera (Phone Link)", "Integrated Webcam (0c45:6a1d)", "Integrated IR Camera"];
        const cc = await open({ prefs: { cam: true }, cams: CAMS, wait: 2500 });
        const ids = await cc.page.evaluate(() => navigator.mediaDevices.enumerateDevices().then((l) => l.filter((d) => d.kind === "videoinput").map((d) => d.deviceId)));
        const camNow = (pg) => pg.page.evaluate(() => { const live = window.__gum.filter((g) => g.video && g.tracks.some((t) => t.on)); return { open: live.length, dev: live.length ? live[live.length - 1].dev : null, exact: live.length ? JSON.stringify(live[live.length - 1].c.video.deviceId || null) : null, pill: (document.querySelector("#mp-cam .mp-t") || {}).textContent || null, device: window.MintPresence.device(), why: window.MintPresence.snapshot().why }; });
        const c0 = await camNow(cc);
        check("which camera: three cameras, Phone Link listed first -> Automatic opens the Integrated Webcam, by deviceId exact", ids.length === 3 && c0.open === 1 && c0.dev === ids[1] && /"exact"/.test(c0.exact) && c0.device && c0.device.how === "auto", JSON.stringify({ ids, c0 }));
        check("  the pill names it: 'Camera on · Integrated Webcam'", c0.pill === "Camera on · Integrated Webcam", c0.pill);
        const st = (await open({ ctx: cc.ctx, path: "/mint-ai/settings/appearance", cams: CAMS, wait: 700 })).page;
        const sl = await st.evaluate(() => { const s = document.querySelector("[data-mp-camsel]"); return { opts: [...s.options].map((o) => o.textContent), val: s.value, hint: document.querySelector("[data-mp-camhint]").hidden, used: document.querySelector("[data-mp-camused]").textContent, gum: window.__gum ? window.__gum.length : 0, named: !!s.closest("form"), name: s.getAttribute("name") }; });
        check("the selector in Settings > Appearance > Eye contact: Automatic (naming its pick) + each camera by name, phone / IR marked; no hint (names known)", sl.opts[0] === "Automatic — Integrated Webcam" && sl.opts.slice(1).join("|") === "Connected Camera (Phone Link) (phone / virtual)|Integrated Webcam|Integrated IR Camera (infrared)" && sl.val === "" && sl.hint, JSON.stringify(sl));
        check("  it shows the camera in use; it is in no form and has no name (nothing to submit)", /Last used: Integrated Webcam \(automatic\)/.test(sl.used) && !sl.named && !sl.name, JSON.stringify(sl));
        // (Headless Chromium gives every page its own device ids -- the name fallback is what carries the choice over here.)
        await st.selectOption("[data-mp-camsel]", { label: "Connected Camera (Phone Link) (phone / virtual)" });
        await cc.page.waitForTimeout(2000);
        const c1 = await camNow(cc);
        const ls1 = await st.evaluate(() => JSON.parse(localStorage.getItem("mint-presence-camera")));
        check("choosing the phone: stored here (id + name), the open Command Center switches at once, the old camera let go", ls1.id && ls1.label === CAMS[0] && c1.open === 1 && c1.dev === ids[0] && /^chosen/.test(c1.device.how) && /^Camera on · Connected Camera/.test(c1.pill), JSON.stringify({ ls1, c1 }));
        await st.selectOption("[data-mp-camsel]", "");
        await cc.page.waitForTimeout(2000);
        const c2 = await camNow(cc);
        check("  back to Automatic: the choice forgotten, the webcam again", c2.open === 1 && c2.dev === ids[1] && (await st.evaluate(() => localStorage.getItem("mint-presence-camera"))) === null, JSON.stringify(c2));
        // unplugged: the webcam leaves the list (devicechange) -> the next best
        await cc.page.evaluate((id) => { window.__hide.push(id); navigator.mediaDevices.dispatchEvent(new Event("devicechange")); }, ids[1]);
        await cc.page.waitForTimeout(2000);
        const c3 = await camNow(cc);
        check("the camera in use unplugged (devicechange): the next best at once (the IR camera before the phone)", c3.open === 1 && c3.dev === ids[2], JSON.stringify(c3));
        await cc.page.evaluate(() => { window.__hide.length = 0; navigator.mediaDevices.dispatchEvent(new Event("devicechange")); });
        await cc.page.waitForTimeout(2000);
        check("  plugged back in: the webcam again", (await camNow(cc)).dev === ids[1]);
        const leak = cc.reqs.concat([]).filter((r) => ids.some((id) => (r.url + r.txt + r.hdr).includes(id)) || /Integrated|Phone Link|Connected Camera|mint-presence-camera|cam-used/.test(r.url + r.txt + r.hdr));
        check("no request carries a camera's name or id (URLs, bodies, headers of every request of both tabs)", leak.length === 0 && cc.reqs.length > 5, JSON.stringify(leak.map((r) => r.method + " " + r.url)));
        await cc.ctx.close();

        // a stale id with the same name; a camera that is gone; the names before the camera was ever allowed
        const sa = await open({ prefs: { cam: true }, cams: CAMS, camChoice: { id: "stale-id-from-last-week", label: "Integrated IR Camera" }, wait: 2500 });
        const ids2 = await sa.page.evaluate(() => navigator.mediaDevices.enumerateDevices().then((l) => l.filter((d) => d.kind === "videoinput").map((d) => d.deviceId)));
        const s1 = await camNow(sa);
        check("a stored choice whose id changed: found by its name (the IR camera, as chosen)", s1.dev === ids2[2] && s1.device.how === "chosen-label" && !s1.why, JSON.stringify(s1));
        await sa.ctx.close();
        const gn = await open({ prefs: { cam: true }, cams: CAMS, camChoice: { id: "c920-id", label: "Logitech C920 (046d:082d)" }, wait: 2500 });
        const g1 = await camNow(gn);
        check("the chosen camera is gone: Automatic (the webcam); the state's why says so", g1.open === 1 && /Integrated Webcam/.test(g1.pill) && g1.why === "Logitech C920 is not connected — using Automatic", JSON.stringify(g1));
        const gs = (await open({ ctx: gn.ctx, path: "/mint-ai/settings/appearance", cams: CAMS, wait: 700 })).page;
        const gsv = await gs.evaluate(() => { const s = document.querySelector("[data-mp-camsel]"); const u = document.querySelector("[data-mp-camused]"); return { sel: s.options[s.selectedIndex].textContent, used: u.textContent, warn: u.classList.contains("warn") }; });
        check("  ... and Settings says so: 'Logitech C920 — not connected' selected, the note under it", gsv.sel === "Logitech C920 — not connected" && /Logitech C920 is not connected — using Automatic\. Last used: Integrated Webcam/.test(gsv.used) && gsv.warn, JSON.stringify(gsv));
        await gn.ctx.close();
        const nl = await open({ path: "/mint-ai/settings/appearance", cams: CAMS, noLabels: true, wait: 800 });
        const n0 = await nl.page.evaluate(() => ({ hint: !document.querySelector("[data-mp-camhint]").hidden, opts: document.querySelector("[data-mp-camsel]").options.length, gum: window.__gum.length }));
        check("names not known yet (never allowed), eye contact off: 'Allow the camera once to see the camera names', and the camera is NOT asked for", n0.hint && n0.opts === 1 && n0.gum === 0, JSON.stringify(n0));
        await nl.page.click("[data-mp-allow]");
        await nl.page.waitForTimeout(800);
        const n1 = await nl.page.evaluate(() => ({ hint: !document.querySelector("[data-mp-camhint]").hidden, opts: [...document.querySelector("[data-mp-camsel]").options].map((o) => o.textContent), gum: window.__gum.length, open: window.__camOpen() }));
        check("  the button: the camera asked for once and let go at once; the names listed", n1.gum === 1 && n1.open === 0 && !n1.hint && n1.opts.length === 4 && n1.opts[0] === "Automatic — Integrated Webcam", JSON.stringify(n1));
        await nl.ctx.close();
        const nl2 = await open({ path: "/mint-ai/settings/appearance", prefs: { cam: true }, cams: CAMS, noLabels: true, wait: 1200 });
        const n2 = await nl2.page.evaluate(() => ({ opts: document.querySelector("[data-mp-camsel]").options.length, gum: window.__gum.length, open: window.__camOpen() }));
        check("  eye contact on: asked by itself, released at once, names listed", n2.gum === 1 && n2.open === 0 && n2.opts === 4, JSON.stringify(n2));
        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          for (const scheme of ["dark", "light"]) {
            const sh = await open({ path: "/mint-ai/settings/appearance", prefs: { cam: true }, cams: CAMS, scheme, W: 1100, H: 900, wait: 900 });
            await sh.page.evaluate(() => { localStorage.setItem("mint-presence-cam-used", JSON.stringify({ label: "Integrated Webcam", how: "auto", note: "", t: Date.now() })); document.getElementById("mp-camera-row").scrollIntoView({ block: "center" }); });
            await sh.page.waitForTimeout(3200);
            await (await sh.page.$("#mp-set")).screenshot({ path: path.join(SHOTS, "camera-selector-browser-" + scheme + ".png") });
            await sh.ctx.close();
          }
        }

        // look and speak with voice off (this scratch server has no voice key): said plainly, the mic never opened for it
        const vo = await open({ prefs: { cam: true, speak: true }, cams: CAMS, wait: 2500 });
        const v0 = await vo.page.evaluate(() => ({ pill: (document.querySelector("#mp-cam .mp-t") || {}).textContent, look: window.MintPresence.look(), mics: window.__gum.filter((g) => g.audio).length, ok: window.__mintLive.ok() }));
        check("voice off: the pill says 'look and speak: voice is off' (it used to do nothing, silently); no microphone opened for it", v0.ok === false && /Camera on · Integrated Webcam · look and speak: voice is off/.test(v0.pill) && v0.look.voice === false && v0.mics === 0, JSON.stringify(v0));
        const vs = (await open({ ctx: vo.ctx, path: "/mint-ai/settings/appearance", cams: CAMS, wait: 800 })).page;
        const vs0 = await vs.evaluate(() => ({ off: (document.querySelector("[data-mp-voiceoff]") || {}).textContent || "", link: (document.querySelector("[data-mp-voiceoff] a") || {}).href || "", gum: window.__gum.length }));
        check("  ... and Settings says so under Look and speak, with the way to switch voice on", /Look and speak needs voice, and voice is off/.test(vs0.off) && /\/mint-ai\/settings\/voice$/.test(vs0.link) && vs0.gum === 0, JSON.stringify(vs0));
        await vs.click("[data-mp-show] summary");
        await vs.waitForTimeout(3500);
        const sw0 = await vs.evaluate(() => ({ rows: [...document.querySelectorAll("[data-mp-checks] li")].map((l) => l.className + ":" + l.querySelector("b").textContent + "=" + l.querySelector(".v").textContent), open: window.__camOpen(), note: document.querySelector("[data-mp-show-note]").textContent }));
        check("'Show what it sees': opened, the camera runs on that page and the checklist reads -- no face (the fake camera), voice ready ✗", sw0.open === 1 && sw0.rows.length === 7 && /^no:Face found=no face/.test(sw0.rows[0]) && sw0.rows.some((r) => /^no:Voice ready=voice is off/.test(r)) && sw0.rows.some((r) => /^ok:Cool-down=ready/.test(r)), JSON.stringify(sw0));
        if (SHOTS) {
          await vs.evaluate(() => document.getElementById("mp-show-row").scrollIntoView({ block: "center" }));
          await vs.waitForTimeout(300);
          await (await vs.$("#mp-speak-row")).screenshot({ path: path.join(SHOTS, "look-and-speak-voice-off.png") });
          await (await vs.$("#mp-show-row")).screenshot({ path: path.join(SHOTS, "show-what-it-sees.png") });
        }
        await vs.click("[data-mp-show] summary");
        await vs.waitForTimeout(500);
        check("  closed: the camera let go at once", (await vs.evaluate(() => window.__camOpen())) === 0);
        const vleak = vo.reqs.filter((r) => r.method !== "GET" && /presence|camera|look|level|face/i.test(r.url + r.txt));
        check("  nothing of it is sent: no request names the camera, a level or a face", vleak.length === 0, JSON.stringify(vleak.map((r) => r.method + " " + r.url)));
        await vo.ctx.close();

        // the app's render mode, the real module: the choice made in the page's Settings is followed there too
        const AP2 = { mode: "floating", peekOpen: true, presence: { camera: true, speak: false, releaseOnSaver: true, onBattery: false, energySaver: false, locked: false, meeting: false, inUse: false } };
        const dsk = await open({ path: "/mint-ai?shell=desktop", ua: APP_UA, tauri: AP2, cams: CAMS, W: 480, H: 860, wait: 3000 });
        const d0 = await camNow(dsk);
        check("in the app (?shell=desktop): Automatic opens the webcam, the pill says so", d0.open === 1 && /Integrated Webcam/.test(d0.pill) && d0.device.how === "auto", JSON.stringify(d0));
        const dset = await open({ ctx: dsk.ctx, path: "/mint-ai/settings/appearance?shell=desktop", ua: APP_UA, tauri: AP2, cams: CAMS, wait: 1000 });
        const ds = await dset.page.evaluate(() => { const s = document.querySelector("[data-mp-camsel]"); return { app: document.getElementById("mp-set").classList.contains("mp-app"), dis: s.disabled, opts: s.options.length, scope: document.querySelector("#mp-camera-row .scope") ? document.querySelector("#mp-camera-row .scope").textContent : "" }; });
        check("  the app's Settings page: the selector works there too (not read-only like the switches), 'this computer'", ds.app && !ds.dis && ds.opts === 4 && /this computer/.test(ds.scope), JSON.stringify(ds));
        const pid = await dsk.page.evaluate(() => navigator.mediaDevices.enumerateDevices().then((l) => l.filter((d) => d.kind === "videoinput")[0].deviceId));
        await dset.page.selectOption("[data-mp-camsel]", { label: "Connected Camera (Phone Link) (phone / virtual)" });
        await dsk.page.waitForTimeout(2000);
        const d1 = await camNow(dsk);
        check("  chosen there: the app's Command Center switches at once", d1.open === 1 && d1.dev === pid && /^chosen/.test(d1.device.how) && /Connected Camera/.test(d1.pill), JSON.stringify(d1));
        if (SHOTS) {
          await dset.page.selectOption("[data-mp-camsel]", "");
          await dset.page.close();
          for (const scheme of ["dark", "light"]) {
            const sh = await open({ path: "/mint-ai/settings/appearance?shell=desktop", ua: APP_UA, tauri: AP2, cams: CAMS, scheme, W: 760, H: 900, wait: 900 });
            await sh.page.evaluate(() => { localStorage.setItem("mint-presence-cam-used", JSON.stringify({ label: "Integrated Webcam", how: "auto", note: "", t: Date.now() })); document.getElementById("mp-camera-row").scrollIntoView({ block: "center" }); });
            await sh.page.waitForTimeout(3200);
            await sh.page.screenshot({ path: path.join(SHOTS, "camera-selector-app-" + scheme + ".png") });
            await sh.ctx.close();
            const pc = await open({ path: "/mint-ai?shell=desktop", ua: APP_UA, tauri: AP2, cams: CAMS, scheme, W: 480, H: 300, wait: 3000 });
            await pc.page.screenshot({ path: path.join(SHOTS, "camera-pill-app-" + scheme + ".png"), clip: { x: 0, y: 0, width: 300, height: 40 } });
            await pc.ctx.close();
          }
        }
        check("  no page errors (the app's pages)", dsk.errs.length === 0 && dset.errs.length === 0, JSON.stringify(dsk.errs.concat(dset.errs)));
        await dsk.ctx.close();

        // 4. The desktop app's render mode with a stand-in camera module: what the page does with the state.
        const HOST = { mode: "floating", peekOpen: true, glance: true, presence: { camera: true, speak: true, releaseOnSaver: true, onBattery: false, energySaver: false, locked: false, meeting: false, inUse: false } };
        const dk = await open({ path: "/mint-ai?shell=desktop", ua: APP_UA, fake: true, tauri: HOST, W: 480, H: 860, wait: 1500 });
        const cfg = await dk.page.evaluate(() => window.__mpCfg);
        check("the app's setting reaches the module (camera + look and speak on, the app's power / lock state)", cfg && cfg.prefs.cam === true && cfg.prefs.speak === true && cfg.host.locked === false && cfg.bot && isFinite(cfg.bot.x), JSON.stringify(cfg));
        await dk.page.evaluate(() => window.__emit("mint://state", { presence: { camera: true, speak: false, releaseOnSaver: true, onBattery: true, energySaver: true, locked: true, meeting: false } }));
        const cfg2 = await dk.page.evaluate(() => window.__mpCfg);
        check("  the app's lock / battery / energy saver follow (mint://state)", cfg2.host.locked && cfg2.host.battery && cfg2.host.saver && !cfg2.prefs.speak, JSON.stringify(cfg2));
        await dk.page.evaluate(() => { window.__mintCC.orbit.setConcept("E"); });
        await dk.page.waitForTimeout(400);
        const eyes = await dk.page.evaluate(async () => {
          const k = window.__mintCC.core;
          window.__mp.emit({ state: "looking", gaze: { x: 0.75, y: -0.5 }, camera: true });
          await new Promise((r) => setTimeout(r, 700));
          const a = { presence: k.S.presence, contact: k.S.contact, gx: k._anim().gx, gy: k._anim().gy, cls: document.documentElement.className };
          window.__mp.emit({ state: "looking", gaze: { x: -0.75, y: -0.5 }, camera: true });
          await new Promise((r) => setTimeout(r, 700));
          a.gx2 = k._anim().gx;
          return a;
        });
        check("the bot meets your eyes: core E gets the state and the direction; its eyes go there and follow when you move", eyes.presence === "looking" && eyes.contact && eyes.gx > 1 && Math.round(eyes.gy) === -1 && eyes.gx2 < -1, JSON.stringify(eyes));
        check("  html says 'looking' (the glance cards come forward)", /\bmp-looking\b/.test(eyes.cls));
        const away = await dk.page.evaluate(async () => {
          const k = window.__mintCC.core;
          k.setOffline(false); k.setOffline = () => {}; k.setState("idle"); // (no supervisor here: the page would show the core offline, and an offline bot never dozes)
          window.__mp.emit({ state: "away", gaze: null, camera: true });
          await new Promise((r) => setTimeout(r, 1500));
          const r = { dozeT: k.S.dozeT, contact: k.S.contact, cls: document.documentElement.className };
          // held while away
          const st0 = window.__calls.filter((c) => c[0] === "presence_status" && c[1].inUse === true).length; // told once that the camera is in use (only changes are sent)
          window.__calls.length = 0;
          const held1 = window.MintPresenceHold.toast("Planning engine finished");
          const held2 = window.MintPresenceHold.native({ title: "Invoice audit needs you", body: "A step waits." });
          const snd = window.MintSound ? window.MintSound.play("approval", { role: "core" }) : null;
          r.held = [held1, held2, snd && snd.why];
          r.toasts = document.querySelectorAll(".cc-toast").length;
          window.__mp.emit({ state: "looking", gaze: { x: 0, y: -0.25 }, camera: true });
          await new Promise((r2) => setTimeout(r2, 250));
          r.awake = k.S.dozeT; r.lookUp = k.S.lookUpUntil > k.S.t;
          const sum = document.getElementById("mp-sum");
          r.sum = sum ? sum.textContent : null;
          r.native = window.__calls.filter((c) => c[0] === "needs_you").map((c) => c[1].title);
          r.status = st0 + window.__calls.filter((c) => c[0] === "presence_status").length;
          return r;
        });
        check("you walk away: the bot dozes (presence instead of the timer), its eyes have nowhere to go", away.dozeT === 1 && away.contact === null && /\bmp-away\b/.test(away.cls), JSON.stringify(away));
        check("  meanwhile a toast, a Windows toast and a sound are held (nothing shown or played)", away.held[0] === true && away.held[1] === true && away.held[2] === "away" && away.toasts === 0, JSON.stringify(away.held));
        check("  back: it wakes and looks up; ONE summary with both notes, one Windows toast for it", away.awake === 0 && away.lookUp && away.sum && /While you were away · 2/.test(away.sum) && /Planning engine finished/.test(away.sum) && /Invoice audit needs you/.test(away.sum) && away.native.length === 1 && away.native[0] === "While you were away", JSON.stringify(away));
        // the glance cards: dimmed while not looking
        const gl = await dk.page.evaluate(async () => {
          const g = document.getElementById("dk-glance");
          if (!g) return null;
          document.documentElement.classList.add("mp-cam-on");
          window.__mp.emit({ state: "present", gaze: { x: 0, y: 0 }, camera: true });
          await new Promise((r) => setTimeout(r, 700));
          const dim = getComputedStyle(g).opacity;
          window.__mp.emit({ state: "looking", gaze: { x: 0, y: 0 }, camera: true });
          await new Promise((r) => setTimeout(r, 700));
          return { dim: Number(dim), full: Number(getComputedStyle(g).opacity) };
        });
        check("the glance cards step back while you look elsewhere and come forward when you look at this screen", gl && gl.dim < 0.5 && gl.full === 1, JSON.stringify(gl));
        // look and speak + a reply's pause, through the hooks
        const hk = await dk.page.evaluate(() => {
          const h = window.__mp.hooks();
          const lv = window.__mintLive;
          const r = { hooks: Object.keys(h).sort().join(","), busy: h.busy(), speaking: h.speaking() };
          let called = 0; const orig = lv.lookTalk; lv.lookTalk = () => { called++; return true; };
          h.speak(); r.speak = called; lv.lookTalk = orig;
          let paused = []; const cc = window.__mintCC, op = cc.pauseSpeaking; cc.pauseSpeaking = (on) => { paused.push(on); return true; };
          h.pause(true); h.pause(false); cc.pauseSpeaking = op; r.paused = paused;
          r.lookTalk = typeof lv.lookTalk === "function" && typeof lv.busy === "function";
          r.vl = typeof window.VoiceLive.pause === "function";
          return r;
        });
        check("look and speak and a reply's pause are wired to the voice: lookTalk on the hold-to-talk path, VoiceLive.pause, the read-aloud pause", hk.hooks === "busy,off,pause,ready,speak,speaking" && hk.speak === 1 && JSON.stringify(hk.paused) === "[true,false]" && hk.lookTalk && hk.vl && hk.busy === false, JSON.stringify(hk));
        const offc = await dk.page.evaluate(() => { window.__calls.length = 0; window.__mp.hooks().off(); return window.__calls.map((c) => c[0]); });
        check("  in the app the page's Off asks the app (presence_off); camera use is reported (presence_status)", offc.includes("presence_off") && away.status >= 1, JSON.stringify(offc));
        const csp2 = await dk.page.evaluate(() => window.__csp);
        check("  no page errors, no CSP violations", dk.errs.length === 0 && csp2.length === 0, JSON.stringify(dk.errs.concat(csp2)));
        await dk.ctx.close();

        // 5. The read-aloud pause really stops the speaker's clock.
        const ra = await open({ wait: 800 });
        const rr = await ra.page.evaluate(async () => {
          const AC = window.AudioContext;
          const c = new AC();
          // what moni-ai.js's Voice.pause does with its own context
          await c.suspend(); const s1 = c.state; await c.resume(); return { s1, s2: c.state, has: typeof window.__mintCC.pauseSpeaking === "function" };
        });
        check("the read-aloud pause: suspend / resume of the speaker's context (pauseSpeaking exposed)", rr.s1 === "suspended" && rr.has, JSON.stringify(rr));
        await ra.ctx.close();
      } finally {
        if (browser) await browser.close();
        s.stop();
      }
    }
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
