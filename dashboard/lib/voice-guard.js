"use strict";
/**
 * What a transcript must pass before it may become anything: a MONI AI turn, a
 * front desk turn, an ask_moni hand-off, or words dropped into a console.
 *
 * Why (2026-09-29, turn 92 in MONI AI's ledger): a push-to-talk press with
 * nothing said sent 1.7 s of near-silence to gpt-4o-mini-transcribe, which
 * answered with its own vocabulary prompt -- "MONI AI, the assistant that runs
 * their VPS, the MONI dashboard, Odoo, ..." -- and that went to MONI AI as the
 * administrator's turn. Reproduced on the real API the same day: silence,
 * near-silence, a click and room noise came back as the prompt in 15 of 15
 * calls, sometimes wrapped as "context: ###\n...\n###". A prompted transcription
 * model echoes its prompt when there is nothing to hear.
 *
 * So, in layers, each holding without the others:
 *
 *   1. audio that is not speech is never sent to be transcribed (the page
 *      measures it; the server refuses a clip too small or too short, and one
 *      the page says was quiet) -- lib/voice-intake.js;
 *   2. a transcript is dropped when it is an echo of the transcription prompt,
 *      of the front desk's instructions or tool descriptions, or of the reader's
 *      instructions; when it has more words than the audio could hold; or when
 *      it is one of the stock phrases these models invent for silence ("Thank
 *      you.", "you", subtitle credits) and the clip was short or quiet;
 *   3. the doors to MONI AI -- the desk's ask_moni and the direct voice send --
 *      refuse prompt-like text themselves, and the direct voice send must match
 *      a transcript this server produced, for this user, for this voice turn.
 *
 * Pure: no I/O. The prompt texts are pulled from their modules lazily (the
 * desk requires this file).
 */

/* ------------------------------------------------------------- tokens -- */

// Function words: they carry no evidence either way.
const STOP = new Set(
  `a an the and or but of to in on at for with by from as is are was were be been being it its this that these those
   their there them they he she we you your our my me i us his her do does did so if then than just can could would
   should will shall may might must please about into over under up down out off again all any some no not`
    .split(/\s+/)
    .filter(Boolean)
);

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 600);
}

/** Longest run of consecutive words that `a` and `b` share. */
function longestRun(a, b) {
  if (!a.length || !b.length) return 0;
  let best = 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) best = cur[j];
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return best;
}

/* ------------------------------------------------------------ sources -- */

// The sentence prompt used until 2026-09-29, kept as a source: it is the one
// that was echoed, and a stored setting could still carry it.
const LEGACY_TRANSCRIBE_PROMPT =
  "Someone talking to MONI AI, the assistant that runs their VPS: the MONI dashboard, Odoo, the allocation engine, " +
  "agents, sessions, Claude, sub-agents, deploys, services and logs.";

let cachedSources = null;
/**
 * Every text a model on this path was given as instructions rather than as the
 * administrator's words. kind "list": a vocabulary list (an echo of it is a
 * list of names); kind "prose": instructions or descriptions.
 */
function promptSources() {
  if (cachedSources) return cachedSources;
  const out = [{ name: "transcription prompt (legacy)", kind: "prose", text: LEGACY_TRANSCRIBE_PROMPT }];
  try {
    const voice = require("./voice");
    if (voice.TRANSCRIBE_PROMPT) out.push({ name: "transcription prompt", kind: voice.TRANSCRIBE_PROMPT_KIND || "list", text: voice.TRANSCRIBE_PROMPT });
    if (voice.INSTRUCTIONS) out.push({ name: "reader instructions", kind: "prose", text: voice.INSTRUCTIONS });
  } catch (_) {
    /* not loadable here: the legacy prompt still guards */
  }
  try {
    const desk = require("./voice-desk");
    if (desk.INSTRUCTIONS) out.push({ name: "desk instructions", kind: "prose", text: desk.INSTRUCTIONS });
    if (desk.SUMMARY_INSTRUCTIONS) out.push({ name: "desk summary instructions", kind: "prose", text: desk.SUMMARY_INSTRUCTIONS });
    for (const t of desk.TOOLS || []) {
      out.push({ name: `desk tool ${t.name}`, kind: "prose", text: t.description });
      for (const [k, p] of Object.entries((t.parameters && t.parameters.properties) || {})) {
        if (p && p.description) out.push({ name: `desk tool ${t.name}.${k}`, kind: "prose", text: p.description });
      }
    }
  } catch (_) {
    /* ditto */
  }
  cachedSources = out.map((s) => ({ ...s, tokens: tokens(s.text), set: new Set(tokens(s.text)) }));
  return cachedSources;
}

function prepSources(list) {
  return list.map((s) => (s.tokens ? s : { kind: "prose", ...s, tokens: tokens(s.text), set: new Set(tokens(s.text)) }));
}

/* --------------------------------------------------------------- echo -- */

// The thresholds, measured against the echoes seen on the real API and a set
// of real requests that name MONI AI, Odoo and the allocation engine
// (tools/test-voice-guard.cjs): an echo shares a long run of words with its
// source; a real request shares names, not runs.
const RUN_ALONE = 8; // this many consecutive words from a prompt: an echo, whatever else is said
const RUN_WITH_OVERLAP = 5; // or this many, when most of what was said comes from it too
const OVERLAP = 0.6; // ...share of the content words that come from the prompt
const RUN_HALF = 5; // a run this long that is half the text or more
const WRAPPER_RE = /^\s*(context|prompt|instructions?)\s*:\s*#{2,}|#{3}/i;

/**
 * Is `text` an echo of instructions rather than something said?
 * Returns null, or {rule, source, run, overlap}.
 */
function echoOf(text, sources) {
  const t = tokens(text);
  if (WRAPPER_RE.test(String(text || ""))) return { rule: "wrapper", source: "prompt markup", run: 0, overlap: 1 };
  if (!t.length) return null;
  const content = t.filter((w) => !STOP.has(w));
  const list = sources ? prepSources(sources) : promptSources();
  for (const s of list) {
    const inSource = content.filter((w) => s.set.has(w)).length;
    const overlap = content.length ? inSource / content.length : 0;
    if (s.kind === "list") {
      // A vocabulary list echoed is only names: every word of it from the list.
      if (content.length >= 2 && inSource === content.length) return { rule: "vocabulary", source: s.name, run: content.length, overlap };
      continue;
    }
    const run = longestRun(t, s.tokens);
    if (run >= RUN_ALONE) return { rule: "ngram", source: s.name, run, overlap };
    if (run >= RUN_WITH_OVERLAP && overlap >= OVERLAP) return { rule: "overlap", source: s.name, run, overlap };
    if (run >= RUN_HALF && run * 2 >= t.length) return { rule: "ngram", source: s.name, run, overlap };
  }
  return null;
}

/* ----------------------------------------------------- hallucinations -- */

// What these models write for silence or noise. Dropped when the clip was short
// or quiet; the credits always (nobody says them to MONI AI).
const SILENCE_PHRASES = new Set([
  "you", "thank you", "thank you very much", "thanks", "thanks for watching", "thank you for watching", "thank you so much for watching",
  "bye", "bye bye", "goodbye", "okay", "ok", "so", "uh", "um", "hmm", "mm", "oh", "the end", "silence", "music", "applause",
]);
const CREDITS_RE = /\b(subtitles?|captions?)\b.{0,40}\b(by|from)\b|amara\.org|\btranscribed by\b|\btranscription by\b|please subscribe|like and subscribe|\bwww\.[a-z0-9-]+\.[a-z]{2,}/i;
const SHORT_S = 1.2; // a clip shorter than this is "short"

function hallucination(text, ctx) {
  const s = String(text || "").trim();
  if (CREDITS_RE.test(s)) return "credits";
  const phrase = tokens(s).join(" ");
  if (!phrase) return "empty";
  const c = ctx || {};
  const short = c.audioSeconds != null && c.audioSeconds < SHORT_S;
  if (SILENCE_PHRASES.has(phrase) && (short || c.quiet)) return "silence-phrase";
  return null;
}

/* ------------------------------------------------------------ physics -- */

// Nobody says more than ~4 words a second; 6 plus a margin of 4 is generous.
// The echo seen in production was 23 words from 1.7 s of audio.
const MAX_WORDS_PER_S = 6;
const WORDS_MARGIN = 4;
function tooManyWords(text, audioSeconds) {
  if (audioSeconds == null || !(audioSeconds >= 0)) return false;
  return tokens(text).length > audioSeconds * MAX_WORDS_PER_S + WORDS_MARGIN;
}

/* ---------------------------------------------------------- the check -- */

/**
 * The transcript guard. `ctx`: {audioSeconds (from the model's own usage, or
 * null), quiet (the page measured no speech), sources (tests)}.
 * Returns {ok:true} or {ok:false, rule, detail}.
 */
function checkTranscript(text, ctx) {
  const c = ctx || {};
  const s = String(text || "").trim();
  if (!s) return { ok: false, rule: "empty" };
  if (/^[\[(]/.test(s)) return { ok: false, rule: "noise-label" };
  const e = echoOf(s, c.sources);
  if (e) return { ok: false, rule: "echo", detail: e };
  if (tooManyWords(s, c.audioSeconds)) return { ok: false, rule: "too-many-words", detail: { words: tokens(s).length, audio_s: c.audioSeconds } };
  const h = hallucination(s, c);
  if (h) return { ok: false, rule: h };
  return { ok: true };
}

/**
 * The door guard, for text about to reach MONI AI (ask_moni, a voice send):
 * prompt-like text is refused. Returns null, or {rule, source}.
 */
function refuseAtDoor(text, sources) {
  const s = String(text || "").trim();
  if (!s) return { rule: "empty", source: "" };
  const e = echoOf(s, sources);
  return e ? { rule: "echo", source: e.source, run: e.run } : null;
}

/** Audio seconds from a transcription's reported usage (about 10 audio tokens a second). */
const AUDIO_TOKENS_PER_S = 10;
function audioSecondsFromUsage(usage) {
  const d = usage && usage.input_token_details;
  if (d && typeof d.audio_tokens === "number") return d.audio_tokens / AUDIO_TOKENS_PER_S;
  if (usage && usage.type === "duration" && typeof usage.seconds === "number") return usage.seconds;
  return null;
}

/* ------------------------------------------------------------ grounds -- */

/**
 * The transcripts this server produced, per user and voice turn, so a voice
 * send can be held to one: MONI AI gets exactly what was heard, once.
 */
class Grounds {
  constructor(opts) {
    this.ttlMs = (opts && opts.ttlMs) || 5 * 60 * 1000;
    this.max = (opts && opts.max) || 200;
    this.map = new Map();
    this.now = (opts && opts.now) || Date.now;
  }
  key(actor, vt) {
    return String(actor || "") + "\n" + String(vt || "");
  }
  remember(actor, vt, text) {
    if (!vt || !text) return;
    this.sweep();
    this.map.set(this.key(actor, vt), { text: norm(text), at: this.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  /** Does `text` match what was heard for (actor, vt)? Single use. */
  take(actor, vt, text) {
    this.sweep();
    const k = this.key(actor, vt);
    const g = this.map.get(k);
    if (!g || g.text !== norm(text)) return false;
    this.map.delete(k);
    return true;
  }
  sweep() {
    const cut = this.now() - this.ttlMs;
    for (const [k, g] of this.map) if (g.at < cut) this.map.delete(k);
  }
}
function norm(text) {
  return tokens(text).join(" ");
}

module.exports = {
  tokens,
  longestRun,
  echoOf,
  hallucination,
  tooManyWords,
  checkTranscript,
  refuseAtDoor,
  audioSecondsFromUsage,
  promptSources,
  Grounds,
  LEGACY_TRANSCRIBE_PROMPT,
  SILENCE_PHRASES,
  RUN_ALONE,
  RUN_WITH_OVERLAP,
  OVERLAP,
};
