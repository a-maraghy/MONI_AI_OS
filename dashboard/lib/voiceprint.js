"use strict";
/**
 * The voiceprint (2026-10-07): MINT AI's live voice can tell the enrolled
 * administrator's voice from other voices -- people in the room, a TV, its own
 * voice coming back through the speakers.
 *
 *   Settings > Voice > Voiceprint     On / Off (default On). Off: the relay never
 *                                     calls the service; nothing is scored or logged.
 *   "Only respond to my voice"        Off by default = SHADOW mode: every turn is
 *                                     scored and logged, nothing is blocked. On =
 *                                     the gate below.
 *
 * Per turn (a hold-to-talk press, a hands-free VAD segment) the relay
 * (lib/voice-live.js) sends the first ~1.2 s of speech to moni-voiceprint
 * (voiceprint/server.py: WeSpeaker ResNet34-LM in ONNX Runtime on a Unix
 * socket) and compares the embedding it gets back with the enrolled print
 * (cosine). Verdicts, thresholds from the trial on the administrator's own
 * recordings (tools/voiceprint/, 2026-10-07: accept >= 0.31 = FAR 1 %; the
 * user's lowest phrase scored 0.41, the best impostor 0.455):
 *
 *   accept     score >= accept                         -> the turn goes on
 *   uncertain  reject <= score < accept, or too little  -> "Sorry, say that again?"
 *              speech (< 0.3 s), or a reject on < 0.8 s
 *   reject     score < reject                          -> ignored, never spoken; the
 *                                                         page shows "Not your voice -- ignored"
 *   echo       heard over MINT AI's own playback and   -> dropped silently
 *              closer to MINT AI's TTS voice than to the user's
 *   none       no voiceprint enrolled                  -> not checked at all
 *   error      the service is down, slow (> 400 ms) or -> FAIL OPEN: the turn goes on;
 *              answered nonsense                         logged, Settings warns
 *
 * Storage. The print is an embedding (256 numbers), biometric data: kept only
 * SEALED (AES-256-GCM) by the helper, whose key is root-only and never leaves
 * it (moni-helper voiceprint-seal / -open / -forget). On disk here:
 * DATA_DIR/voiceprint/<user id>.json (0600) = the sealed blob + non-secret
 * facts (which microphones, how many seconds, when). Opened into this
 * process's memory when a call needs it. Never in a log, the audit log, MINT
 * AI's memory, or a page. MINT AI's own voice print (for the echo rule) is
 * learned from what the relay plays, DATA_DIR/voiceprint/tts.json.
 *
 * Enrolment never stores audio: each clip is embedded as it arrives and only
 * the sums are kept (in memory until saved, then sealed).
 *
 * The ledger (table voiceprint_checks): one row per turn checked -- scores,
 * verdict, what was done -- for tuning and the 7-day view in Settings.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const SOCKET = process.env.MONI_VOICEPRINT_SOCKET || "/run/moni-voiceprint/voiceprint.sock";
const ENABLED_SETTING = "voiceprint_enabled";
const GATE_SETTING = "voiceprint_gate";
const THRESHOLDS_SETTING = "voiceprint_thresholds";
const DEFAULTS = Object.freeze({ accept: 0.31, reject: 0.2, echo: 0.45, first: 1.2, min: 0.8, timeoutMs: 400 });
const MODEL = "WeSpeaker ResNet34-LM (VoxCeleb2), CC-BY-4.0";
const MIC_RE = /^[a-z][a-z0-9-]{0,23}$/;
const MIN_ENROL_MS = 30000; // speech needed for a microphone's print
const TTS_MAX = 40;
const TTS_EVERY_MS = 60 * 1000;
const KEEP_DAYS = 90;
const DAY = 24 * 3600 * 1000;
const HIST = { from: -0.2, to: 1.0, step: 0.05 };

function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

/** One request to the service on its Unix socket -> parsed JSON; rejects on a timeout or a bad answer. */
function request(socketPath, method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      fn(v);
    };
    const req = http.request({ socketPath, method, path: p, headers: body ? { "Content-Type": "application/octet-stream", "Content-Length": body.length } : {} }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        let j = null;
        try {
          j = JSON.parse(Buffer.concat(parts).toString("utf8"));
        } catch (_) {
          return finish(reject, new Error("the voiceprint service answered something that is not JSON"));
        }
        if (res.statusCode !== 200 || !j || j.ok === false) return finish(reject, Object.assign(new Error((j && j.error) || "HTTP " + res.statusCode), { status: res.statusCode }));
        finish(resolve, j);
      });
      res.on("error", (e) => finish(reject, e));
    });
    const t = setTimeout(() => {
      req.destroy();
      finish(reject, Object.assign(new Error("the voiceprint service took longer than " + timeoutMs + " ms"), { code: "TIMEOUT" }));
    }, timeoutMs);
    req.on("error", (e) => finish(reject, e));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * deps: { db, priv: {voiceprintSeal, voiceprintOpen, voiceprintForget}, dataDir,
 *         socketPath?, log?, now?, trialClips?(user) -> [{mic, id, path}] }
 */
function createVoiceprint(deps) {
  const d = deps || {};
  const db = d.db;
  const priv = d.priv;
  const log = d.log || (() => {});
  const now = d.now || Date.now;
  const socketPath = d.socketPath || SOCKET;
  const dir = path.join(d.dataDir, "voiceprint");
  const prints = new Map(); // user id -> { vec: number[] (unit), mics: {mic: {sum, windows}}, meta }
  const loading = new Map(); // user id -> Promise
  const pending = new Map(); // user id + mic -> { sum, windows, speech_ms, clips: {id: speech_ms}, at }
  let service = { ok: null, at: 0, error: null, errorAt: 0, failures: 0, checked: 0, health: null };
  let tts = null; // { voices: { name: { sum, n, at } } }
  let lastTtsAt = 0;
  let pruned = 0;

  const mk = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch (_) {
      /* best effort */
    }
  };
  const fileOf = (user) => path.join(dir, String(Number(user.id)) + ".json");
  const writeJson = (p, obj) => {
    mk();
    fs.writeFileSync(p + ".tmp", JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(p + ".tmp", p);
  };
  const readJson = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (_) {
      return null;
    }
  };

  /* ---- the switches ---- */

  const enabled = () => db.getSetting(ENABLED_SETTING, "on") !== "off";
  const gate = () => enabled() && db.getSetting(GATE_SETTING, "off") === "on";
  function thresholds() {
    let t = {};
    try {
      t = JSON.parse(db.getSetting(THRESHOLDS_SETTING, "") || "{}") || {};
    } catch (_) {
      t = {};
    }
    const o = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (Number.isFinite(Number(t[k]))) o[k] = Number(t[k]);
    if (o.reject > o.accept) o.reject = o.accept;
    return o;
  }
  function setEnabled(on, by) {
    db.setSetting(ENABLED_SETTING, on ? "on" : "off", by);
  }
  function setGate(on, by) {
    db.setSetting(GATE_SETTING, on ? "on" : "off", by);
  }

  /* ---- the service ---- */

  function failed(e) {
    service = { ...service, ok: false, error: String((e && e.message) || e).slice(0, 200), errorAt: now(), failures: service.failures + 1 };
  }
  function worked() {
    service = { ...service, ok: true, at: now(), failures: 0 };
  }
  async function health(force) {
    if (!force && service.health && now() - service.at < 30000) return service.health;
    try {
      const h = await request(socketPath, "GET", "/health", null, 1500);
      service = { ...service, ok: true, at: now(), health: h };
      return h;
    } catch (e) {
      failed(e);
      return null;
    }
  }
  /** pcm: PCM16 LE mono at `rate` -> {embedding|null, speech_ms, used_ms, ms, too_short}. */
  async function embed(pcm, rate, first, timeoutMs) {
    const j = await request(socketPath, "POST", `/embed?rate=${rate}&first=${first == null ? thresholds().first : first}`, pcm, timeoutMs || thresholds().timeoutMs);
    if (j.embedding != null && (!Array.isArray(j.embedding) || j.embedding.length < 64 || !j.embedding.every(Number.isFinite))) throw new Error("the voiceprint service answered a malformed embedding");
    return j;
  }
  async function enrolEmbed(pcm, rate) {
    const j = await request(socketPath, "POST", `/enrol?rate=${rate}`, pcm, 30000);
    if (!Array.isArray(j.embedding) || !j.embedding.every(Number.isFinite)) throw new Error("the voiceprint service answered a malformed embedding");
    return j;
  }

  /* ---- the print: sealed on disk, open in memory ---- */

  function meta(user) {
    const f = readJson(fileOf(user));
    if (!f || !f.sealed) return null;
    return { created_at: f.created_at, updated_at: f.updated_at, mics: f.mics || {}, model: f.model || MODEL };
  }
  function hasPrint(user) {
    return prints.has(Number(user.id));
  }
  /** Open the user's print (once; then from memory). -> {vec, mics} | null. */
  function printFor(user) {
    const id = Number(user.id);
    if (prints.has(id)) return Promise.resolve(prints.get(id));
    if (loading.has(id)) return loading.get(id);
    const p = (async () => {
      const f = readJson(fileOf(user));
      if (!f || !f.sealed) return null;
      const r = await priv.voiceprintOpen(f.sealed);
      const plain = JSON.parse(Buffer.from(r.plain, "base64").toString("utf8"));
      const pr = build(plain.mics || {});
      if (!pr) return null;
      prints.set(id, pr);
      return pr;
    })()
      .catch((e) => {
        log("voiceprint: could not open the voiceprint of user " + id + ": " + e.message);
        return null;
      })
      .finally(() => loading.delete(id));
    loading.set(id, p);
    return p;
  }
  function build(mics) {
    const keys = Object.keys(mics).filter((m) => mics[m] && Array.isArray(mics[m].sum) && mics[m].windows > 0);
    if (!keys.length) return null;
    const dim = mics[keys[0]].sum.length;
    const sum = new Array(dim).fill(0);
    for (const m of keys) mics[m].sum.forEach((v, i) => (sum[i] += v));
    return { vec: unit(sum), mics };
  }
  async function save(user, mics, info) {
    const plain = Buffer.from(JSON.stringify({ v: 1, model: MODEL, mics }), "utf8").toString("base64");
    const r = await priv.voiceprintSeal(plain);
    const was = readJson(fileOf(user)) || {};
    const at = new Date(now()).toISOString();
    writeJson(fileOf(user), { v: 1, model: MODEL, sealed: r.sealed, created_at: was.created_at || at, updated_at: at, mics: info });
    const pr = build(mics);
    if (pr) prints.set(Number(user.id), pr);
    else prints.delete(Number(user.id));
  }

  /* ---- enrolment ---- */

  const pkey = (user, mic) => Number(user.id) + "|" + mic;
  /** One clip of a guided enrolment: embedded now, kept as a sum in memory. */
  async function enrolClip(user, mic, clipId, pcm, rate) {
    if (!MIC_RE.test(mic)) throw Object.assign(new Error("Which microphone?"), { status: 400 });
    const j = await enrolEmbed(pcm, rate);
    const k = pkey(user, mic);
    const p = pending.get(k) || { clips: {}, at: now() };
    p.clips[clipId] = { sum: j.embedding, windows: j.windows, speech_ms: j.speech_ms };
    p.at = now();
    pending.set(k, p);
    return { speech_ms: j.speech_ms, windows: j.windows, total_ms: Object.values(p.clips).reduce((n, c) => n + c.speech_ms, 0) };
  }
  function pendingOf(user, mic) {
    const p = pending.get(pkey(user, mic));
    return p ? { clips: Object.keys(p.clips), total_ms: Object.values(p.clips).reduce((n, c) => n + c.speech_ms, 0) } : { clips: [], total_ms: 0 };
  }
  function discardPending(user, mic) {
    pending.delete(pkey(user, mic));
  }
  /** Save the guided enrolment of one microphone into the user's print (replacing that microphone's part). */
  async function enrolSave(user, mic, source) {
    const k = pkey(user, mic);
    const p = pending.get(k);
    const clips = p ? Object.values(p.clips) : [];
    const total = clips.reduce((n, c) => n + c.speech_ms, 0);
    if (total < MIN_ENROL_MS) throw Object.assign(new Error(`Not enough speech yet: ${Math.round(total / 1000)} s of the ${MIN_ENROL_MS / 1000} s needed.`), { status: 400 });
    const sum = new Array(clips[0].sum.length).fill(0);
    let windows = 0;
    for (const c of clips) {
      c.sum.forEach((v, i) => (sum[i] += v));
      windows += c.windows;
    }
    const cur = (await printFor(user)) || { mics: {} };
    const mics = { ...cur.mics, [mic]: { sum, windows } };
    const info = { ...((meta(user) || {}).mics || {}), [mic]: { windows, speech_s: Math.round(total / 100) / 10, clips: clips.length, source: source || "enrol", at: new Date(now()).toISOString() } };
    await save(user, mics, info);
    pending.delete(k);
    return { mic, windows, speech_s: info[mic].speech_s, mics: Object.keys(mics) };
  }
  /** Enrol from the voiceprint trial's recordings (their reading paragraphs, one microphone slot). */
  async function enrolFromTrial(user, slot) {
    const clips = (d.trialClips ? d.trialClips(user) : []).filter((c) => c.mic === slot && c.part === "enrol");
    if (!clips.length) throw Object.assign(new Error("There are no trial recordings to enrol from."), { status: 400 });
    discardPending(user, slot);
    for (const c of clips) {
      const buf = fs.readFileSync(c.path);
      const w = d.parseWav(buf);
      const pcm = Buffer.from(w.samples.buffer, w.samples.byteOffset, w.samples.length * 2);
      await enrolClip(user, slot, c.id, pcm, w.rate);
    }
    return enrolSave(user, slot, "trial");
  }
  async function removeMic(user, mic) {
    const cur = await printFor(user);
    if (!cur || !cur.mics[mic]) return false;
    const mics = { ...cur.mics };
    delete mics[mic];
    if (!Object.keys(mics).length) return removePrint(user).then(() => true);
    const info = { ...((meta(user) || {}).mics || {}) };
    delete info[mic];
    await save(user, mics, info);
    return true;
  }
  async function removePrint(user) {
    prints.delete(Number(user.id));
    for (const k of [...pending.keys()]) if (k.startsWith(Number(user.id) + "|")) pending.delete(k);
    try {
      fs.unlinkSync(fileOf(user));
      return true;
    } catch (_) {
      return false;
    }
  }
  /** Everything of this user's: the print, the ledger rows; the key too when no other print needs it. */
  async function forgetAll(user) {
    const had = await removePrint(user);
    const rows = db.voiceprintChecksDelete(user.username);
    let others = 0;
    try {
      others = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).length;
    } catch (_) {
      others = 0;
    }
    const helper = await priv.voiceprintForget(others > 0);
    return { print: had, ledger_rows: rows, key_deleted: !!(helper && helper.key_deleted), results_deleted: (helper && helper.results_deleted) || 0 };
  }

  /* ---- MINT AI's own voice (the echo rule) ---- */

  function ttsLoad() {
    if (!tts) tts = readJson(path.join(dir, "tts.json")) || { voices: {} };
    return tts;
  }
  function ttsPrint(voice) {
    const v = ttsLoad().voices[voice];
    return v && v.n > 0 ? unit(v.sum) : null;
  }
  /** Audio the relay played in this voice (PCM16 24 kHz, >= 1.5 s): folded into its print, now and then. */
  async function learnTts(voice, pcm) {
    if (!enabled() || !/^[a-z]{2,20}$/.test(String(voice || "")) || !pcm || pcm.length < 24000 * 2 * 1.5) return false;
    const v = ttsLoad().voices[voice];
    if ((v && v.n >= TTS_MAX) || now() - lastTtsAt < TTS_EVERY_MS) return false;
    lastTtsAt = now();
    try {
      const j = await embed(pcm, 24000, 3, 1500);
      if (!j.embedding) return false;
      const cur = ttsLoad().voices[voice] || { sum: new Array(j.embedding.length).fill(0), n: 0 };
      cur.sum = cur.sum.map((x, i) => x + j.embedding[i]);
      cur.n += 1;
      cur.at = new Date(now()).toISOString();
      ttsLoad().voices[voice] = cur;
      writeJson(path.join(dir, "tts.json"), tts);
      return true;
    } catch (e) {
      failed(e);
      return false;
    }
  }

  /* ---- the check ---- */

  /**
   * One turn: pcm = PCM16 24 kHz (what the relay relayed). Never throws: a
   * failure is {verdict: "error"} (the caller goes on: fail open).
   * o: { overVoice, voice }
   */
  async function check(user, pcm, o) {
    const t0 = now();
    const th = thresholds();
    const pr = prints.get(Number(user.id)) || (await printFor(user));
    if (!pr) return { verdict: "none", ms: now() - t0 };
    let j;
    try {
      j = await embed(pcm, 24000, th.first, th.timeoutMs);
      worked();
      service.checked++;
    } catch (e) {
      failed(e);
      return { verdict: "error", error: String(e.message).slice(0, 120), ms: now() - t0 };
    }
    const out = { speech_ms: j.speech_ms, used_ms: j.used_ms, svc_ms: j.ms, ms: now() - t0 };
    if (!j.embedding) return { ...out, verdict: "short" };
    const score = dot(pr.vec, j.embedding);
    const tp = o && o.voice ? ttsPrint(o.voice) : null;
    const tts = tp ? dot(tp, j.embedding) : null;
    let verdict = score >= th.accept ? "accept" : score < th.reject ? "reject" : "uncertain";
    if (verdict === "reject" && j.speech_ms < th.min * 1000) verdict = "uncertain"; // too little speech to refuse outright
    if (o && o.overVoice && tts != null && tts >= th.echo && tts > score) verdict = "echo";
    return { ...out, verdict, score: r3(score), tts_score: r3(tts) };
  }

  /* ---- the ledger ---- */

  function ledger(row) {
    try {
      db.voiceprintCheckInsert({ ts: now(), ...row });
      if (now() - pruned > DAY) {
        pruned = now();
        db.voiceprintChecksPrune(now() - KEEP_DAYS * DAY);
      }
    } catch (e) {
      log("voiceprint: could not write the ledger: " + e.message);
    }
  }
  /** The last `days` days: counts per verdict, what the gate would have done, a score histogram. */
  function stats(days, actor) {
    const rows = db.voiceprintChecksSince(now() - (days || 7) * DAY, actor || null);
    const by = { accept: 0, uncertain: 0, reject: 0, echo: 0, short: 0, error: 0 };
    const acted = {};
    const bins = Math.round((HIST.to - HIST.from) / HIST.step);
    const hist = new Array(bins).fill(0);
    const scores = [];
    const ms = [];
    for (const r of rows) {
      if (by[r.verdict] !== undefined) by[r.verdict]++;
      if (r.acted) acted[r.acted] = (acted[r.acted] || 0) + 1;
      if (r.score != null) {
        scores.push(r.score);
        const i = Math.max(0, Math.min(bins - 1, Math.floor((r.score - HIST.from) / HIST.step)));
        hist[i]++;
      }
      if (r.ms != null) ms.push(r.ms);
    }
    scores.sort((a, b) => a - b);
    ms.sort((a, b) => a - b);
    const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
    return {
      days: days || 7,
      checked: rows.length,
      by,
      acted,
      would_ignore: by.reject + by.echo,
      would_ask: by.uncertain + by.short,
      hist,
      hist_from: HIST.from,
      hist_step: HIST.step,
      score_p10: r3(q(scores, 0.1)),
      score_p50: r3(q(scores, 0.5)),
      ms_p50: q(ms, 0.5),
      ms_p95: q(ms, 0.95),
      last: rows.length ? rows[rows.length - 1].ts : null,
    };
  }

  function status(user) {
    const recentError = service.errorAt && now() - service.errorAt < 10 * 60 * 1000 && service.ok === false;
    return {
      enabled: enabled(),
      gate: gate(),
      thresholds: thresholds(),
      service: { ok: service.ok, error: recentError ? service.error : null, errorAt: service.errorAt || null, health: service.health ? { model: service.health.model, dim: service.health.dim, threads: service.health.threads } : null },
      enrolled: user ? meta(user) : null,
      model: MODEL,
    };
  }

  return {
    SOCKET: socketPath,
    enabled,
    gate,
    thresholds,
    setEnabled,
    setGate,
    health,
    embed,
    check,
    hasPrint,
    printFor,
    meta,
    enrolClip,
    enrolSave,
    enrolFromTrial,
    pendingOf,
    discardPending,
    removeMic,
    removePrint,
    forgetAll,
    learnTts,
    ttsPrint,
    ledger,
    stats,
    status,
    serviceState: () => ({ ...service }),
  };
}

module.exports = { createVoiceprint, DEFAULTS, MODEL, ENABLED_SETTING, GATE_SETTING, THRESHOLDS_SETTING, MIN_ENROL_MS, MIC_RE, request, unit, dot };
