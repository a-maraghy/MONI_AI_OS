"use strict";
/**
 * Which model writes down what the administrator said (MINT AI ▸ Settings ▸
 * Voice ▸ Transcription), and the local backend for the ones that run on this
 * server.
 *
 * What the choice governs. The FULL-TURN transcript: the text that grounds a
 * live call's hand-off to MINT AI (lib/voice-live.js transcribeTurn -- MINT AI
 * acts on the server's transcript, never the voice model's retelling), and the
 * console's dictation (lib/voice-intake.js). It does NOT govern the live
 * session's own input transcription: inside a realtime session OpenAI accepts
 * only its own transcription models, so that one stays on an OpenAI model --
 * the selected one when it is gpt-4o-mini-transcribe or gpt-4o-transcribe
 * (known to work there), else gpt-4o-mini-transcribe (sessionModelFor). The
 * Settings help says so.
 *
 * The list (TRANSCRIBERS) is data: one entry per option, with the figures the
 * selector shows. Adding an option is one entry -- and, for a new `kind`, one
 * function in BACKENDS with the signature of openaiBackend / whisperBackend.
 * The figures are measured on this VPS (2026-09-30; 12 vCPU EPYC, AVX2, no
 * GPU; 12 real clips, English, Egyptian Arabic and mixed) or OpenAI's list
 * prices read that day:
 *
 *   gpt-4o-mini-transcribe  CER 0.004, median 0.44 s; keeps the English words
 *                           of a mixed sentence in Latin script, which the
 *                           guards were tuned on. $0.003/min. Retires
 *                           2027-02-26.
 *   gpt-transcribe          its successor; writes some English words in Arabic
 *                           script ("ريستارت للداشبورد") -- the guards read
 *                           those too (tools/test-voice-arabic.cjs). $0.0045/min.
 *   gpt-4o-transcribe       $0.006/min.
 *   whisper large-v3-turbo  (q8_0, whisper.cpp, 8 threads) CER ~0.05, 6-13 s a
 *                           turn on a warm server, 1.1 GB resident. Free.
 *   whisper small           (q8_0) 1-2 s, CER 0.11-0.16, writes English in
 *                           Arabic script; without VAD a noise clip ran away
 *                           for 50-60 s. Free.
 *
 * The local backend (kind "whisper"): a resident whisper-server
 * (moni-voice-whisper.service, 127.0.0.1:8093, niced, 8 threads, Silero VAD on
 * so silence and noise come back empty). It runs ONLY while a local model is
 * selected: choosing one starts it through the helper (voice-whisper-set),
 * choosing an OpenAI model stops it. Per turn: ffmpeg turns the recording into
 * 16 kHz mono PCM; the request asks for temperature 0 with no temperature
 * fallback (the fallback loop is what runs away on noise), an audio context
 * sized to the clip (whisper otherwise encodes a 30 s window for a 3 s turn),
 * and the language setting ("auto" lets whisper detect it -- which, on a mixed
 * Arabic/English turn, can TRANSLATE the Arabic half into English; "ar" or "en"
 * pins it). A hard timeout bounds it. Non-speech markers ("[BLANK_AUDIO]",
 * "*thud*", "(static)", "♪") are taken out; nothing left is silence.
 *
 * Fallback: when the local server is down, times out, errors, or returns junk
 * (a stock silence phrase, a repeating loop, more words than the audio holds,
 * garbled text), the same audio goes to gpt-4o-mini-transcribe and the result
 * says so ({fallback: {from, why}}); the caller logs it (never the words).
 */

const { spawn } = require("child_process");
const voice = require("./voice");
const guard = require("./voice-guard");

const FALLBACK_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_ID = "gpt-4o-mini-transcribe";
const WHISPER_URL = process.env.MONI_WHISPER_URL || "http://127.0.0.1:8093";
const FFMPEG = process.env.MONI_FFMPEG || "ffmpeg";
const FFMPEG_TIMEOUT_MS = 10000;
const LOCAL_RATE = 16000;
const LANGUAGES = Object.freeze([
  ["auto", "Detect"],
  ["ar", "Arabic"],
  ["en", "English"],
]);

/*
 * kind     "openai" (POST /audio/transcriptions) | "whisper" (the local server)
 * model    the OpenAI model id, or the local model's file id (ggml-<model>.bin)
 * hint     the short line the selector shows: speed · accuracy · cost
 * live     may be the live session's own transcription model (OpenAI's only)
 * ctxMin   whisper: the smallest audio context this model was measured at
 * timeoutMs  whisper: the hard limit for one turn before the fallback
 */
const TRANSCRIBERS = Object.freeze([
  {
    id: "gpt-4o-mini-transcribe",
    kind: "openai",
    model: "gpt-4o-mini-transcribe",
    label: "GPT-4o mini Transcribe",
    group: "OpenAI",
    hint: "~0.4 s · CER 0.004 · $0.003/min · the default",
    live: true,
  },
  {
    id: "gpt-transcribe",
    kind: "openai",
    model: "gpt-transcribe",
    label: "GPT Transcribe",
    group: "OpenAI",
    hint: "$0.0045/min · writes some English words in Arabic script",
    // Not put into the live session until OpenAI is known to accept it there
    // (untested: no transcription calls were made for this change).
    live: false,
  },
  {
    id: "gpt-4o-transcribe",
    kind: "openai",
    model: "gpt-4o-transcribe",
    label: "GPT-4o Transcribe",
    group: "OpenAI",
    hint: "$0.006/min",
    live: true,
  },
  {
    id: "whisper-large-v3-turbo",
    kind: "whisper",
    model: "large-v3-turbo-q8_0",
    label: "Whisper large-v3-turbo (on this server)",
    group: "On this server (whisper.cpp)",
    hint: "6–13 s a turn · CER ~0.05 · free · 1.1 GB RAM while selected",
    ctxMin: 768,
    timeoutMs: 25000,
  },
  {
    id: "whisper-small",
    kind: "whisper",
    model: "small-q8_0",
    label: "Whisper small (on this server)",
    group: "On this server (whisper.cpp)",
    hint: "1–2 s · CER 0.11–0.16, English in Arabic script · free",
    ctxMin: 512,
    timeoutMs: 10000,
  },
]);

function byId(id) {
  return TRANSCRIBERS.find((t) => t.id === id) || null;
}
/** A stored choice, cleaned: an unknown id reads as the default. */
function clean(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    model: byId(o.model) ? o.model : DEFAULT_ID,
    language: LANGUAGES.some(([v]) => v === o.language) ? o.language : "auto",
  };
}
/** The live session's own transcription model: the selected one if OpenAI's, else the default. */
function sessionModelFor(id) {
  const t = byId(id);
  return t && t.live ? t.model : FALLBACK_MODEL;
}
/** How long a live hand-off waits for the full-turn transcript: the local timeout and a fallback's round trip. */
function heardWaitMs(id) {
  const t = byId(id);
  return t && t.kind !== "openai" ? t.timeoutMs + 3000 : null;
}

/* ------------------------------------------------------------ openai -- */

function openaiBackend(audio, cfg, mime, t, language) {
  return voice.transcribeFull(audio, { ...cfg, transcribe_model: t.model, transcribe_language: language }, mime);
}

/* ----------------------------------------------------------- whisper -- */

class LocalError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** The recording (webm/opus, wav, ...) as 16 kHz mono PCM16, through ffmpeg. */
function toPcm16k(audio, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = (o.spawn || spawn)(o.ffmpeg || FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-map_metadata", "-1", "-vn", "-ac", "1", "-ar", String(LOCAL_RATE), "-f", "s16le", "pipe:1"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return reject(new LocalError("could not run ffmpeg: " + e.message, "ffmpeg"));
    }
    const out = [];
    let err = "";
    let done = false;
    const finish = (e, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (e) {
        try {
          child.kill("SIGKILL");
        } catch (_) {
          /* gone */
        }
        reject(e);
      } else resolve(v);
    };
    const timer = setTimeout(() => finish(new LocalError("ffmpeg took too long", "ffmpeg")), o.timeoutMs || FFMPEG_TIMEOUT_MS);
    child.on("error", (e) => finish(new LocalError("could not run ffmpeg: " + e.message, "ffmpeg")));
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => {
      if (err.length < 400) err += d;
    });
    child.on("close", (code) => {
      const pcm = Buffer.concat(out);
      if (code !== 0 || !pcm.length) return finish(new LocalError("ffmpeg could not read the recording" + (err ? ": " + err.trim().slice(0, 120) : ""), "ffmpeg"));
      finish(null, pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm);
    });
    child.stdin.on("error", () => {}); // ffmpeg may close its input early on a bad file; the close reports it
    child.stdin.end(audio);
  });
}

/**
 * The audio context for a clip of `seconds`: whisper encodes 50 frames a
 * second; a full window is 1500 (30 s). Sized to the clip (with a margin,
 * rounded up to 64) but never below what the model was measured at; 0 (the
 * whole window) when the clip is too long for a smaller one.
 */
function audioCtx(seconds, ctxMin) {
  if (!ctxMin) return 0;
  const need = Math.ceil((Math.ceil(seconds * 50) + 64) / 64) * 64;
  if (need >= 1500) return 0;
  return Math.max(ctxMin, need);
}

const stripMarkers = guard.stripMarkers;

/**
 * Why a local transcript is not to be trusted (then the fallback hears the
 * audio), or null. `text` has its markers taken out already.
 */
function junk(text, seconds) {
  if (/�/.test(text)) return "garbled";
  const toks = guard.tokens(text);
  if (!toks.length) return null;
  const phrase = toks.join(" ");
  // A stock silence phrase, whatever the length of the clip: VAD should have
  // left nothing, so whisper made it up -- or the administrator said "thank
  // you", which the fallback will then write down as that.
  if (guard.SILENCE_PHRASES.has(phrase) || guard.hallucination(text, { quiet: true })) return "stock-phrase";
  // A loop: the same few words over and over.
  if (toks.length >= 8 && new Set(toks).size / toks.length < 0.3) return "loop";
  for (let n = 1; n <= 4; n++) {
    let run = 1;
    for (let i = n; i + n <= toks.length; i += n) {
      if (toks.slice(i, i + n).join(" ") === toks.slice(i - n, i).join(" ")) {
        if (++run >= 5) return "loop";
      } else run = 1;
    }
  }
  if (guard.tooManyWords(text, seconds)) return "too-many-words";
  return null;
}

async function whisperBackend(audio, cfg, mime, t, language) {
  const t0 = Date.now();
  const pcm = await toPcm16k(audio, { ffmpeg: cfg.ffmpeg, spawn: cfg.spawn });
  const seconds = pcm.length / 2 / LOCAL_RATE;
  const form = new FormData();
  form.append("file", new Blob([voice.wav(pcm, LOCAL_RATE)], { type: "audio/wav" }), "speech.wav");
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("temperature_inc", "0");
  form.append("no_timestamps", "true");
  form.append("language", language || "auto");
  const ctx = audioCtx(seconds, t.ctxMin);
  if (ctx) form.append("audio_ctx", String(ctx));
  const limit = Number(cfg.localTimeoutMs) || t.timeoutMs; // cfg.localTimeoutMs: tests only
  const left = Math.max(200, limit - (Date.now() - t0));
  let res;
  try {
    res = await fetch((cfg.whisperUrl || WHISPER_URL) + "/inference", { method: "POST", body: form, signal: AbortSignal.timeout(left) });
  } catch (e) {
    if (e.name === "TimeoutError") throw new LocalError(`the local model took longer than ${Math.round(limit / 100) / 10} s`, "timeout");
    throw new LocalError("the local transcription server is not running", "down");
  }
  const body = await res.text().catch(() => "");
  let data = null;
  try {
    data = JSON.parse(body);
  } catch (_) {
    /* below */
  }
  if (!res.ok || !data || data.error || typeof data.text !== "string") {
    throw new LocalError("the local transcription server answered " + res.status + (data && data.error ? ": " + String(data.error).slice(0, 120) : ""), "upstream");
  }
  const text = stripMarkers(data.text);
  const why = junk(text, seconds);
  if (why) throw new LocalError("the local model returned " + why, "junk:" + why);
  return { text, model: t.id, usage: { type: "duration", seconds: Math.round(seconds * 100) / 100 }, tokens: null, audioSeconds: seconds, local: true };
}

const BACKENDS = { openai: openaiBackend, whisper: whisperBackend };

/* ------------------------------------------------------------- entry -- */

/**
 * voice.transcribeFull's signature, with the selected model: cfg.transcriber
 * (a TRANSCRIBERS id; missing = the default) and cfg.transcribe_language.
 * Resolves {text, model, usage, tokens, transcriber, ms, fallback?}. `tokens`
 * is null for a local model (nothing is billed). `fallback` = {from, why} when
 * a local model failed and gpt-4o-mini-transcribe answered instead; `log` (on
 * cfg, or console.log) gets one line about it, never the words.
 */
async function transcribeFull(audio, cfg, mime) {
  const c = cfg || {};
  const t = byId(c.transcriber) || byId(DEFAULT_ID);
  const language = clean({ language: c.transcribe_language }).language;
  const t0 = Date.now();
  const backend = BACKENDS[t.kind];
  if (t.kind === "openai") {
    const out = await backend(audio, c, mime, t, language);
    return { ...out, transcriber: t.id, ms: Date.now() - t0 };
  }
  try {
    const out = await backend(audio, c, mime, t, language);
    return { ...out, transcriber: t.id, ms: Date.now() - t0 };
  } catch (e) {
    const why = String(e.code || "error");
    const log = typeof c.log === "function" ? c.log : console.log;
    if (!c.key) throw new voice.VoiceError(`${t.label} failed (${e.message}) and there is no OpenAI key to fall back on.`, "upstream");
    log(`voice transcribe: ${t.id} failed (${why}: ${voice.scrub(e.message).slice(0, 120)}) after ${Date.now() - t0} ms; falling back to ${FALLBACK_MODEL}`);
    const fb = await openaiBackend(audio, c, mime, byId(FALLBACK_MODEL), language);
    return { ...fb, transcriber: FALLBACK_MODEL, ms: Date.now() - t0, fallback: { from: t.id, why } };
  }
}

module.exports = {
  TRANSCRIBERS,
  LANGUAGES,
  DEFAULT_ID,
  FALLBACK_MODEL,
  WHISPER_URL,
  BACKENDS,
  byId,
  clean,
  sessionModelFor,
  heardWaitMs,
  transcribeFull,
  toPcm16k,
  audioCtx,
  stripMarkers,
  junk,
};
