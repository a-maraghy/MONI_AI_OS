"use strict";
/**
 * The voiceprint trial, Phase 1 (/mint-ai/voiceprint-trial, administrators
 * only): the administrator records a short trial set in their own voice --
 * about a minute of natural reading to enrol on, then 30 short test phrases
 * (very short words, commands, numbers, mixed English and Egyptian Arabic) --
 * once per microphone (laptop mic, headset). An offline harness on the VPS
 * (tools/voiceprint/evaluate.py) then scores local speaker-verification models
 * on it. Nothing here verifies anyone yet, and nothing is sent anywhere.
 *
 * The page records with the live conversation's own capture worklet and
 * microphone settings (public/voice-live-worklet.js: 24 kHz PCM16, echo
 * cancellation, noise suppression and auto gain on, as public/voice-live.js),
 * so the trial hears what a production check would hear. This server
 * resamples each clip to 16 kHz (what the models take) and stores it:
 *
 *   DATA_DIR/voiceprint-trial/<username>/            0700
 *     manifest.json                                  0600  which clip is what
 *     <slot>/<phrase id>.wav   (16 kHz mono PCM16)   0600
 *
 * never in the repository or in memory. "Delete all my trial recordings"
 * removes the user's folder. The audit log (login_log, outcome "voiceprint")
 * gets counts only: a slot started, a slot complete, everything deleted.
 */
const fs = require("fs");
const path = require("path");

const SLOTS = Object.freeze([
  { id: "laptop", label: "Laptop microphone" },
  { id: "headset", label: "Headset" },
  { id: "other", label: "Other microphone" },
]);

/* About 60 s of natural reading to enrol on: English, Egyptian, mixed, numbers. */
const ENROL = Object.freeze([
  { id: "e1", part: "enrol", lang: "en", kind: "reading", text: "I'm checking in on the server this morning. Tell me whether Odoo is running, how full the disk is, and if any service failed overnight. After that, open the agents page and read me the last thing MINT AI did on the planning mission, slowly, so I can follow." },
  { id: "e2", part: "enrol", lang: "ar", kind: "reading", text: "صباح الخير يا MINT. عايز أعرف الدنيا ماشية إزاي النهارده. شوفلي أودو شغال ولا لأ، والديسك مليان قد إيه، وفيه أي خدمة وقعت بالليل. وبعد كده افتحلي صفحة الإيجنتس وقولي آخر حاجة اتعملت في المهمة، بالراحة عشان أفهم." },
  { id: "e3", part: "enrol", lang: "mixed", kind: "reading", text: "إمبارح كنت بشتغل على الـ allocation engine لحد بالليل. الـ run الأخير طلع واحد وأربعين order، وفيه شوية proposals محتاجة review. لو سمحت ابعتلي summary بالأرقام على تيليجرام، وفكرني الصبح أراجع الـ purchase plan مع الفريق." },
  { id: "e4", part: "enrol", lang: "en", kind: "reading", text: "The numbers I care about are simple: twelve cores, forty-seven gigabytes of memory, and about four hundred and seventy gigabytes free on the disk. If any of those change much, tell me before you do anything else, and keep the answer short." },
]);

/* The test phrases: what a press of the talk key really carries, shortest first. */
const TESTS = Object.freeze(
  [
    ["en", "short", "Yes."],
    ["en", "short", "No."],
    ["en", "short", "Stop."],
    ["ar", "short", "نعم."],
    ["ar", "short", "لأ."],
    ["ar", "short", "خلاص."],
    ["mixed", "short", "Okay يا MINT."],
    ["en", "command", "Open the agents page."],
    ["en", "command", "Restart the dashboard."],
    ["en", "command", "Stop listening."],
    ["en", "command", "Send me the report on Telegram."],
    ["ar", "command", "اقفل المكالمة."],
    ["ar", "command", "افتح صفحة الخدمات."],
    ["ar", "command", "امسح الباك اب القديم لو سمحت."],
    ["mixed", "command", "اعمل restart للـ dashboard."],
    ["en", "number", "Forty-one percent."],
    ["en", "number", "The order is P M O nine zero seven seven."],
    ["en", "number", "Twelve thousand kilos, by the first of September."],
    ["ar", "number", "واحد وأربعين في المية."],
    ["ar", "number", "الساعة اتنين وربع."],
    ["en", "question", "Is Odoo running?"],
    ["en", "question", "What did MINT AI do last?"],
    ["ar", "question", "الديسك مليان قد إيه؟"],
    ["ar", "question", "فيه موافقات مستنياني؟"],
    ["mixed", "question", "الـ memory usage عامل إيه؟"],
    ["mixed", "question", "شوفلي الـ status بتاع الـ server."],
    ["mixed", "sentence", "Okay MINT، كمل اللي كنت بتعمله."],
    ["en", "sentence", "Please check the disk and tell me if anything failed overnight."],
    ["ar", "sentence", "عايزك تراجع خطة الشرا وتقولي فيه إيه جديد النهارده."],
    ["mixed", "sentence", "ابعتلي الـ summary بتاع الـ run الأخير قبل الـ meeting."],
  ].map(([lang, kind, text], i) => Object.freeze({ id: "t" + String(i + 1).padStart(2, "0"), part: "test", lang, kind, text }))
);

const PHRASES = Object.freeze([...ENROL, ...TESTS]);
const BY_ID = new Map(PHRASES.map((p) => [p.id, p]));
const LIMITS = Object.freeze({ enrol: { min: 3, max: 40 }, test: { min: 0.3, max: 12 } });
const MAX_BYTES = 44 + 40 * 24000 * 2 + 1024; // 40 s at 24 kHz PCM16, with room for a header

/** A user's folder name: the username when it is plain, else u<id>. */
function userDirName(user) {
  const u = String((user && user.username) || "");
  return /^[A-Za-z0-9._-]{1,64}$/.test(u) && !/^\.+$/.test(u) ? u : "u" + Number(user && user.id);
}

/** A WAV -> {rate, samples: Int16Array} (PCM16 mono, 16 or 24 kHz), or throws a plain reason. */
function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("That is not a WAV recording.");
  let at = 12;
  let fmt = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "fmt " && at + 24 <= buf.length) fmt = { format: buf.readUInt16LE(at + 8), channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16 || (fmt.rate !== 24000 && fmt.rate !== 16000)) throw new Error("The recording must be PCM16 mono at 16 or 24 kHz.");
      const end = Math.min(buf.length, at + 8 + size);
      const n = Math.floor((end - at - 8) / 2);
      const copy = Buffer.from(buf.subarray(at + 8, at + 8 + n * 2)); // aligned
      return { rate: fmt.rate, samples: new Int16Array(copy.buffer, copy.byteOffset, n) };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("There is no audio in that recording.");
}

/* 24 kHz -> 16 kHz: a 2:3 polyphase windowed-sinc low-pass (cut-off 7.2 kHz, 48 taps a phase). */
const HALF = 24;
const PHASES = [0, 0.5].map((frac) => {
  const fc = 7200 / 24000; // cycles per input sample
  const h = [];
  for (let k = -HALF + 1; k <= HALF; k++) {
    const t = k - frac;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / HALF) + 0.08 * Math.cos((2 * Math.PI * t) / HALF); // Blackman
    h.push(Math.abs(t) < HALF ? sinc * w : 0);
  }
  const s = h.reduce((a, b) => a + b, 0);
  return h.map((v) => v / s);
});

function to16k(samples, rate) {
  if (rate === 16000) return Int16Array.from(samples);
  const n = Math.floor((samples.length * 2) / 3);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * 1.5;
    const base = Math.floor(pos);
    const h = PHASES[pos - base === 0 ? 0 : 1];
    let acc = 0;
    for (let k = -HALF + 1, j = 0; k <= HALF; k++, j++) {
      const idx = base + k;
      if (idx >= 0 && idx < samples.length) acc += samples[idx] * h[j];
    }
    out[i] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc);
  }
  return out;
}

function wav16(samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2).copy(b, 44);
  return b;
}

/** Peak level of a clip in dBFS (a silent or clipped recording is refused). */
function peakDb(samples) {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > p) p = v;
  }
  return p ? 20 * Math.log10(p / 32768) : -Infinity;
}

function createStore(baseDir) {
  const root = path.join(baseDir, "voiceprint-trial");
  const mk = (d) => {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(d, 0o700);
    } catch (_) {
      /* best effort */
    }
    return d;
  };
  const dirOf = (user) => path.join(root, userDirName(user));
  const manifestPath = (user) => path.join(dirOf(user), "manifest.json");
  function readManifest(user) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath(user), "utf8"));
      if (m && Array.isArray(m.clips)) return m;
    } catch (_) {
      /* none yet */
    }
    return { version: 1, user: String(user.username || ""), sample_rate: 16000, capture: "live worklet, 24 kHz, echoCancellation/noiseSuppression/autoGainControl on; resampled to 16 kHz", slots: {}, clips: [] };
  }
  function writeManifest(user, m) {
    const p = manifestPath(user);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(m, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, p);
  }
  function status(user) {
    const m = readManifest(user);
    const slots = {};
    for (const s of SLOTS) slots[s.id] = { device: (m.slots[s.id] && m.slots[s.id].device) || null, clips: {} };
    for (const c of m.clips) if (slots[c.mic] && fs.existsSync(path.join(dirOf(user), c.mic, c.id + ".wav"))) slots[c.mic].clips[c.id] = c.seconds;
    return { slots, total: PHRASES.length };
  }
  /** Save one clip -> {seconds, count, started, complete}; throws {status, message} on a bad one. */
  function save(user, slot, id, buf, device) {
    const bad = (status, message) => Object.assign(new Error(message), { status });
    if (!SLOTS.some((s) => s.id === slot)) throw bad(400, "Which microphone?");
    const p = BY_ID.get(id);
    if (!p) throw bad(400, "Which phrase?");
    if (!Buffer.isBuffer(buf) || !buf.length) throw bad(400, "No audio arrived.");
    if (buf.length > MAX_BYTES) throw bad(413, "That recording is too long.");
    let w;
    try {
      w = parseWav(buf);
    } catch (e) {
      throw bad(400, e.message);
    }
    const seconds = w.samples.length / w.rate;
    const lim = LIMITS[p.part];
    if (seconds < lim.min || seconds > lim.max) throw bad(400, `This recording must be between ${lim.min} and ${lim.max} seconds.`);
    if (peakDb(w.samples) < -50) throw bad(400, "Nothing was heard. Check the microphone and record again.");
    const pcm = to16k(w.samples, w.rate);
    const m = readManifest(user);
    const before = m.clips.filter((c) => c.mic === slot).length;
    mk(path.join(mk(dirOf(user)), slot));
    const file = path.join(dirOf(user), slot, id + ".wav");
    fs.writeFileSync(file + ".tmp", wav16(pcm), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
    const dev = String(device || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
    m.slots[slot] = { device: dev || (m.slots[slot] && m.slots[slot].device) || null };
    m.clips = m.clips.filter((c) => !(c.mic === slot && c.id === id));
    m.clips.push({ mic: slot, id, part: p.part, lang: p.lang, kind: p.kind, text: p.text, seconds: Math.round(seconds * 100) / 100, device: dev || null, recorded_at: new Date().toISOString() });
    writeManifest(user, m);
    const count = m.clips.filter((c) => c.mic === slot).length;
    return { seconds: Math.round(seconds * 10) / 10, count, started: before === 0, complete: before < PHRASES.length && count === PHRASES.length };
  }
  function clipPath(user, slot, id) {
    if (!SLOTS.some((s) => s.id === slot) || !BY_ID.has(id)) return null;
    const f = path.join(dirOf(user), slot, id + ".wav");
    return fs.existsSync(f) ? f : null;
  }
  /** Delete everything of this user's -> the number of clips removed. */
  function removeAll(user) {
    const d = dirOf(user);
    let n = 0;
    for (const s of SLOTS) {
      try {
        n += fs.readdirSync(path.join(d, s.id)).filter((f) => f.endsWith(".wav")).length;
      } catch (_) {
        /* none */
      }
    }
    fs.rmSync(d, { recursive: true, force: true });
    return n;
  }
  return { root, dirOf, status, save, clipPath, removeAll, readManifest };
}

/**
 * The routes. deps: { requireAuth, requirePerm, requireApiPerm, requireApiCsrf,
 * rateLimit, express, db, ctx, views, asset, dataDir }.
 */
function mount(app, deps) {
  const { requireAuth, requirePerm, requireApiPerm, requireApiCsrf, rateLimit, express, db, ctx, views, asset, dataDir } = deps;
  const store = createStore(dataDir);
  const guard = [requireApiPerm("moniai.use"), requireApiPerm("voice.manage")];
  const raw = express.raw({ type: ["audio/wav", "audio/x-wav"], limit: MAX_BYTES });
  const uploads = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 150,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => "vp-" + (req.me ? req.me.id : "anon"),
    validate: false,
    handler: (req, res) => res.status(429).json({ error: "Too many recordings at once. Wait a few minutes and carry on." }),
  });
  const audit = (req, detail) => {
    try {
      db.logLogin(req.ip, req.me.username, "voiceprint", detail);
    } catch (_) {
      /* the recording stands either way */
    }
  };

  app.get("/mint-ai/voiceprint-trial", requireAuth, requirePerm("moniai.use"), requirePerm("voice.manage"), (req, res) => {
    res.set("Cache-Control", "no-store");
    res.send(views.page({ csrf: res.locals.csrf, user: ctx(req, "console"), slots: SLOTS, enrol: ENROL, tests: TESTS, limits: LIMITS, worklet: asset("voice-live-worklet.js") }));
  });

  app.get("/mint-ai/api/voiceprint-trial/status", ...guard, (req, res) => {
    res.set("Cache-Control", "no-store").json(store.status(req.me));
  });

  app.get("/mint-ai/api/voiceprint-trial/clip/:slot/:id", ...guard, (req, res) => {
    const f = store.clipPath(req.me, String(req.params.slot), String(req.params.id));
    if (!f) return res.status(404).json({ error: "No such recording." });
    res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(fs.readFileSync(f));
  });

  app.post(
    "/mint-ai/api/voiceprint-trial/clip",
    ...guard,
    requireApiCsrf,
    uploads,
    (req, res, next) =>
      raw(req, res, (err) => {
        if (!err) return next();
        if (err.type === "entity.too.large" || err.status === 413) return res.status(413).json({ error: "That recording is too long." });
        return res.status(400).json({ error: "The recording did not arrive whole." });
      }),
    (req, res) => {
      const slot = String(req.query.slot || "");
      const id = String(req.query.id || "");
      let device = "";
      try {
        device = decodeURIComponent(String(req.get("x-mic-label") || ""));
      } catch (_) {
        device = "";
      }
      try {
        const r = store.save(req.me, slot, id, Buffer.isBuffer(req.body) ? req.body : null, device);
        if (r.started) audit(req, `voiceprint trial: recording started on "${slot}"`);
        if (r.complete) audit(req, `voiceprint trial: "${slot}" complete, ${r.count} of ${PHRASES.length} clips`);
        res.json({ ok: true, id, slot, seconds: r.seconds, count: r.count, total: PHRASES.length });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : "The recording could not be saved." });
        if (!e.status) console.error("voiceprint trial: save failed: " + e.message);
      }
    }
  );

  app.post("/mint-ai/api/voiceprint-trial/delete", ...guard, requireApiCsrf, (req, res) => {
    const n = store.removeAll(req.me);
    audit(req, `voiceprint trial: deleted all trial recordings (${n} clips)`);
    res.json({ ok: true, deleted: n });
  });

  return store;
}

module.exports = { SLOTS, ENROL, TESTS, PHRASES, LIMITS, MAX_BYTES, userDirName, parseWav, to16k, wav16, peakDb, createStore, mount };
