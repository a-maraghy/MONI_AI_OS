"use strict";
/**
 * The Egyptian evaluation for the live conversation (M-3 Phase 1): the
 * administrator's OWN voice, 20 phrases, through each realtime model and
 * voice, compared in one table. Used by the admin-only page
 * /mint-ai/voice-eval (record, then run) and by tools/voice-live-eval.cjs
 * (the same run over a folder of WAVs, e.g. the minimal self-test).
 *
 * Each clip is streamed at real-time pace into a real LiveCall
 * (lib/voice-live.js) -- the same session, guard and hold as the live mode --
 * with a STUBBED supervisor: read_status gets a fixed snapshot, and a
 * hand-off is recorded here, never sent to MINT AI. Nothing is written to the
 * panel's usage table either: the cost is counted in the result.
 *
 * Per clip x model x voice:
 *   transcription  the session's and the full-turn transcript against the
 *                  phrase (character error rate, Arabic normalised)
 *   latency        end of speech -> first audio the page would play (after
 *                  the hold), and the hold itself
 *   guard          what the guard cut, and whether a hand-off happened (and
 *                  whether it was expected: the action request)
 *   dialect        the reply's language and register (lib/voice-persona.js
 *                  detect) against the phrase's: Egyptian answered in
 *                  Egyptian, MSA in MSA, English in English
 *   cost           every response, transcription and reading, priced
 */

const live = require("./voice-live");
const desk = require("./voice-desk");
const usage = require("./voice-usage");
const arabic = require("./voice-arabic");
const persona = require("./voice-persona");

const PHRASES = Object.freeze([
  { id: 1, kind: "small talk", lang: "egyptian", text: "إزيك؟ عامل إيه النهارده؟" },
  { id: 2, kind: "small talk", lang: "egyptian", text: "سامعني كويس؟" },
  { id: 3, kind: "status", lang: "egyptian", text: "عايز أعرف أودو شغال ولا لأ." },
  { id: 4, kind: "status", lang: "egyptian", text: "الديسك مليان قد إيه دلوقتي؟" },
  { id: 5, kind: "status", lang: "egyptian", text: "فيه أي خدمة واقعة؟" },
  { id: 6, kind: "status", lang: "mixed", text: "الـ memory usage عامل إيه على الـ server؟" },
  { id: 7, kind: "status", lang: "mixed", text: "قولي الـ status بتاع الـ dashboard." },
  { id: 8, kind: "status", lang: "msa", text: "ما هي حالة الخادم الآن؟" },
  { id: 9, kind: "status", lang: "msa", text: "هل توجد موافقات معلقة؟" },
  { id: 10, kind: "action", lang: "mixed", text: "عايزك تعمل restart للـ dashboard بعد ما تشيك على الـ disk usage." },
  { id: 11, kind: "action", lang: "egyptian", text: "امسح الباك اب القديم لو سمحت." },
  { id: 12, kind: "action", lang: "english", text: "Please push the latest fix to GitHub." },
  { id: 13, kind: "question", lang: "mixed", text: "إيه آخر حاجة MINT AI عملها في الـ mission؟" },
  { id: 14, kind: "status", lang: "english", text: "Is Odoo running, and how full is the disk?" },
  { id: 15, kind: "small talk", lang: "english", text: "Hi, how are you doing today?" },
  { id: 16, kind: "small talk", lang: "egyptian", text: "شكراً يا MINT، تسلم إيدك." },
  { id: 17, kind: "question", lang: "msa", text: "أرجو أن تخبرني بعدد الجلسات النشطة." },
  { id: 18, kind: "stop", lang: "egyptian", text: "ممكن تقفل الاستماع؟" },
  { id: 19, kind: "stop", lang: "english", text: "Okay, stop listening." },
  { id: 20, kind: "small talk", lang: "mixed", text: "تمام كده، thanks يا MINT." },
]);

const MODELS = Object.freeze(["gpt-realtime-mini", "gpt-realtime-2.1-mini", "gpt-realtime-2.1"]);
const VOICES = Object.freeze(["marin", "cedar"]);
const FRAME = 960; // 20 ms of PCM16 at 24 kHz

const SNAPSHOT = Object.freeze({
  machine: { disk: { used_percent: 41, free_gb: 156.2 }, memory: { used_percent: 62 }, load: { one: 0.4 } },
  services: { running: 11, tracked: 12, failed: ["moni-agent@admin"], list: [{ name: "odoo", state: "running" }, { name: "moni-dashboard", state: "running" }, { name: "nginx", state: "running" }] },
  sessions: { live: 3 },
  missions: { list: [{ ref: "M-3", title: "Voice full duplex", steps: [{ n: 5, title: "Live conversation", status: "running" }] }] },
  approvals: { pending: 1, titles: ["Deletes files (Bash)"] },
});

/** Character error rate of `got` against `want`, Arabic normalised, punctuation and case ignored. */
function cer(want, got) {
  const n = (s) => arabic.normalize(String(s || "")).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const a = n(want);
  const b = n(got);
  if (!a.length) return b.length ? 1 : 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.round((prev[b.length] / a.length) * 1000) / 1000;
}

/** The reply's language and register, next to the phrase's. */
function dialectNote(phraseLang, reply) {
  const t = String(reply || "");
  if (!t.trim()) return { ok: null, note: "no spoken reply" };
  const d = persona.detect(t);
  const replyAr = d.lang === "ar";
  if (phraseLang === "english") return { ok: !replyAr, note: replyAr ? "answered English in Arabic" : "English" };
  if (!replyAr) return { ok: false, note: "answered Arabic in English" };
  if (phraseLang === "msa") return { ok: d.dialect !== "egyptian", note: d.dialect === "egyptian" ? "MSA answered in Egyptian" : d.dialect === "msa" ? "MSA" : "Arabic (register unclear)" };
  return { ok: d.dialect !== "msa", note: d.dialect === "msa" ? "Egyptian answered in MSA" : d.dialect === "egyptian" ? "Egyptian" : "Arabic (register unclear)" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One clip through one model and voice. deps: {key, wsBase?, speak, transcribe,
 * isStop, now?}. Returns the row for the table.
 */
async function runClip({ pcm, phrase, model, voice, deps }) {
  const d = deps || {};
  const now = d.now || Date.now;
  const sent = [];
  const rows = [];
  const asks = [];
  const texts = { session: "", turn: "" };
  let stopped = false;
  const call = async (op, params) => {
    if (op === "snapshot") return JSON.parse(JSON.stringify(SNAPSHOT));
    if (op === "send") {
      asks.push(String(params.text || ""));
      return { turn: { id: 70000 + asks.length, status: "queued" } }; // recorded here, never sent to MINT AI
    }
    throw new Error("refused " + op);
  };
  const c = new live.LiveCall({
    cfg: { key: d.key, voice, model: "gpt-realtime-mini", transcribe_model: "gpt-4o-mini-transcribe", live_model: model, wsBase: d.wsBase },
    actor: "voice-eval",
    ops: desk.deskOps(call, "voice-eval"),
    client: {
      json: (m) => {
        if (m.type === "stop") stopped = true;
      },
      audio: (seg, buf) => sent.push({ t: now(), n: buf.length }),
      close: () => {},
    },
    persona: () => ({}),
    hearPersona: () => ({}),
    speak: d.speak,
    transcribe: d.transcribe
      ? async (a, cf, mime) => {
          const r = await d.transcribe(a, cf, mime);
          texts.turn = r.text;
          return r;
        }
      : null,
    summarise: null,
    record: (row) => {
      const usd = usage.costOf(row.tokens, row.model);
      rows.push({ ...row, usd });
      return usd;
    },
    isStop: d.isStop,
    log: () => {},
    opts: { handoff: "turn", maxMs: 60000 },
  });
  const orig = c.sessionTranscript.bind(c);
  c.sessionTranscript = (ev) => {
    texts.session = String(ev.transcript || "");
    return orig(ev);
  };
  const out = { id: phrase.id, kind: phrase.kind, lang: phrase.lang, model, voice };
  try {
    await c.open();
    const start = now();
    for (let i = 0; i < pcm.length; i += FRAME) {
      c.audioIn(pcm.subarray(i, i + FRAME));
      const wait = start + (i + FRAME) / 48 - now();
      if (wait > 0) await sleep(wait);
    }
    const speechEnd = now();
    const silence = Buffer.alloc(FRAME);
    const deadline = now() + 14000;
    while (now() < deadline && !c.closed) {
      c.audioIn(silence);
      await sleep(20);
      const last = sent.length ? sent[sent.length - 1].t : 0;
      if (c.resp && c.resp.done && !c.speechBusy && last && now() - last > 1500 && now() - speechEnd > 2500) break;
      if (!sent.length && c.resp && c.resp.done && now() - speechEnd > 9000) break;
    }
    out.first_audio_ms = sent.length ? sent[0].t - speechEnd : null;
    const fa = c.diag.firstAudio[0];
    out.hold_ms = fa ? fa.hold : null;
    out.reply = c.spoken.map((s) => s.text).join(" ");
  } catch (e) {
    out.error = String(e.message || e).replace(/sk-[A-Za-z0-9_\-]+/g, "sk-***").slice(0, 200);
  } finally {
    c.close("eval");
  }
  out.session_text = texts.session;
  out.turn_text = texts.turn;
  out.cer_session = cer(phrase.text, texts.session);
  out.cer_turn = texts.turn ? cer(phrase.text, texts.turn) : null;
  out.trips = c.diag.trips.map((t) => t.rule);
  out.handoff = asks.length > 0;
  out.handoff_expected = phrase.kind === "action";
  out.handoff_text_is_transcript = asks.length ? asks.every((a) => a === texts.turn || a === texts.session) : null;
  out.stopped = stopped;
  out.stop_expected = phrase.kind === "stop";
  const dn = dialectNote(phrase.lang, out.reply);
  out.dialect_ok = dn.ok;
  out.dialect_note = dn.note;
  out.usd = rows.reduce((n, r) => n + r.usd, 0);
  return out;
}

/** Every clip through every model and voice, a few at a time. */
async function evaluate({ clips, models, voices, deps, concurrency, onProgress }) {
  const jobs = [];
  for (const cl of clips) for (const m of models || MODELS) for (const v of voices || VOICES) jobs.push({ ...cl, model: m, voice: v });
  const results = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const r = await runClip({ pcm: j.pcm, phrase: j.phrase, model: j.model, voice: j.voice, deps });
      results.push(r);
      done++;
      if (onProgress) onProgress({ done, total: jobs.length, last: r });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency || 2, 4)) }, worker));
  results.sort((a, b) => a.id - b.id || a.model.localeCompare(b.model) || a.voice.localeCompare(b.voice));
  return { results, summary: summarise(results) };
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (xs) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 100) : null);
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** One line per model x voice: the comparison table. */
function summarise(results) {
  const groups = new Map();
  for (const r of results) {
    const k = r.model + " · " + r.voice;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const rows = [];
  for (const [k, rs] of groups) {
    const ok = rs.filter((r) => !r.error);
    rows.push({
      config: k,
      clips: rs.length,
      errors: rs.length - ok.length,
      first_audio_ms_median: median(ok.map((r) => r.first_audio_ms)),
      hold_ms_median: median(ok.map((r) => r.hold_ms)),
      cer_session: avg(ok.map((r) => r.cer_session)),
      cer_turn: avg(ok.filter((r) => r.cer_turn != null).map((r) => r.cer_turn)),
      guard_cuts: ok.reduce((n, r) => n + r.trips.length, 0),
      handoffs_right: pct(ok.filter((r) => r.handoff_expected).map((r) => r.handoff)),
      stops_right: pct(ok.filter((r) => r.stop_expected).map((r) => r.stopped)),
      dialect_ok: pct(ok.filter((r) => r.dialect_ok !== null).map((r) => r.dialect_ok)),
      usd_per_clip: avg(ok.map((r) => r.usd)),
      usd_total: ok.reduce((n, r) => n + r.usd, 0),
    });
  }
  return rows;
}

function f(n, d) {
  return n == null ? "—" : Number(n).toFixed(d == null ? 0 : d);
}

/** The table as Markdown (the CLI and the saved report). */
function tableMarkdown(summary) {
  const head = "| model · voice | clips | first audio (median ms) | hold (median ms) | CER session | CER full turn | guard cuts | hand-offs right | stops right | dialect right | $/clip | $ total |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|";
  const lines = summary.map((r) => `| ${r.config} | ${r.clips}${r.errors ? " (" + r.errors + " failed)" : ""} | ${f(r.first_audio_ms_median)} | ${f(r.hold_ms_median)} | ${f(r.cer_session, 3)} | ${f(r.cer_turn, 3)} | ${r.guard_cuts} | ${r.handoffs_right == null ? "—" : r.handoffs_right + "%"} | ${r.stops_right == null ? "—" : r.stops_right + "%"} | ${r.dialect_ok == null ? "—" : r.dialect_ok + "%"} | ${f(r.usd_per_clip, 4)} | ${f(r.usd_total, 4)} |`);
  return [head, sep, ...lines].join("\n");
}

/** A WAV (PCM16 mono 24 kHz, as the page records it) -> its samples, or an error. */
function readWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let at = 12;
  let fmt = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(at + 8), channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 24000 || fmt.bits !== 16) throw new Error("the recording must be PCM16 mono 24 kHz");
      return buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("no audio in the WAV file");
}

module.exports = { PHRASES, MODELS, VOICES, SNAPSHOT, cer, dialectNote, runClip, evaluate, summarise, tableMarkdown, readWav };
