"use strict";
/**
 * Speech to text, from a model that is already in memory.
 *
 * The panel used to transcribe by running whisper-cli once per recording,
 * through the privileged helper, loading a 142MB model each time. Measured on
 * this box that was 2.26 seconds for a five-second clip -- and 2.20 seconds for
 * a half-second one, which is the tell: almost none of it was the audio. It was
 * the model, read from disk and built into a graph, for every sentence spoken.
 *
 * whisper.cpp ships a server that keeps the model resident. The same clip
 * through it takes 0.12 seconds. That is the difference between a conversation
 * and a walkie-talkie, and it is most of what made live mode feel not-live.
 *
 * It also drops a privileged call from the path. The server runs as its own
 * account with no sudo entitlement and no shell, which is a better place to
 * parse a stranger's audio than a helper running as root.
 */

const priv = require("./priv");

const URL_BASE = process.env.MONI_WHISPER_URL || "http://127.0.0.1:8081";
const TIMEOUT_MS = 45000;

// Whisper emits bracketed labels for sound it heard but could not read as
// words. They are not something anybody said, so they are not returned.
const NOISE = /^\s*[\[(][^\])]*[\])]\s*$/;

let lastFailure = 0;

/** Whether the resident server answered recently enough to be worth trying. */
async function ready() {
  try {
    const res = await fetch(URL_BASE + "/", { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch (_) {
    return false;
  }
}

/**
 * Transcribe a recording.
 *
 * `audio` is whatever the browser produced -- webm/opus in practice. The server
 * converts it with ffmpeg itself, so nothing here has to know the format.
 */
async function transcribe(audio, filename) {
  const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(audio, "base64");
  if (!buf.length) throw new Error("there was no audio in that");

  const form = new FormData();
  form.append("file", new Blob([buf]), filename || "utterance.webm");
  form.append("response_format", "text");
  form.append("temperature", "0");

  const res = await fetch(URL_BASE + "/inference", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("the transcriber returned " + res.status);

  const text = (await res.text()).trim();
  return NOISE.test(text) ? "" : text;
}

/**
 * Transcribe, falling back to the old per-request path.
 *
 * The resident server is an optimisation, not a dependency: if it is stopped or
 * has not been installed, this still works -- just slowly, the way it did
 * before. A voice note is not worth an outage.
 */
async function transcribeWithFallback(base64, saveViaHelper) {
  try {
    return await transcribe(base64);
  } catch (e) {
    lastFailure = Date.now();
    if (typeof saveViaHelper !== "function") throw e;
    const out = await saveViaHelper();
    return String((out && out.text) || "").trim();
  }
}

module.exports = { transcribe, transcribeWithFallback, ready, lastFailure: () => lastFailure, URL_BASE };
