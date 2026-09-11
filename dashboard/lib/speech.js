"use strict";
/**
 * Turning a reply into speech, for live mode.
 *
 * Piper rather than something larger, and the reason is arithmetic rather than
 * taste. Chatterbox -- the obvious candidate, and the better voice -- was
 * measured on this machine at 0.17x realtime: seventeen seconds of work for
 * every three seconds of speech, because there is no GPU here and a 350M
 * transformer on a 2GHz virtualised core is simply not going to keep up. Piper
 * is a VITS model in ONNX, built for exactly this, and measured on the same
 * sentences at 3.5x with the medium voice and 2.2x with the high one. Anything
 * above about 1.3x can speak a reply while it generates the next sentence,
 * which is what makes a conversation rather than a wait.
 *
 * It needs no privilege. Piper reads a model file and writes audio to stdout,
 * so the dashboard's own unprivileged account runs it directly -- no helper, no
 * sudo, and nothing here that could be talked into touching anything else.
 *
 * The process is held open between sentences, and that was a correction rather
 * than a plan. Starting one per request cost 0.8 seconds a sentence, of which
 * measurement said roughly 0.1 was synthesis and the rest was startup and
 * reading a 61MB model off disk -- once per sentence, for a model that never
 * changes. Piper reads lines from stdin for as long as you leave it open and
 * writes one file per line, so a warm process answers in about 0.1 seconds.
 *
 * A warm process is a thing that can die, so it is treated as one: the pool
 * respawns on demand, a crash rejects only the sentences in flight, and an idle
 * voice is closed rather than held forever.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PIPER = process.env.MONI_PIPER_BIN || "/opt/moni-tts/piper/piper";
const VOICE_DIR = process.env.MONI_PIPER_VOICES || "/opt/moni-tts/voices";

// One sentence at a time is the design; this is the guard against a caller that
// has other ideas. Long enough for any sentence a person would say aloud.
const MAX_CHARS = 800;

// Each request is one process and the box has other jobs -- agents, the panel,
// whisper. Past this, callers wait rather than the machine thrashing.
const MAX_CONCURRENT = 3;

// Comfortably past the worst measured sentence; a piper that has not answered
// by now is stuck rather than slow.
const TIMEOUT_MS = 30000;

// Four threads, not twelve. Measured on this host, whisper took 2.69s at four
// and 3.92s at twelve on the same clip: these are virtualised cores, and
// oversubscribing them costs more in contention than the parallelism returns.
const THREADS = process.env.MONI_PIPER_THREADS || "4";

let running = 0;
const waiting = [];

/* ---------------------------------------------------------------- voices -- */

const VOICE_RE = /^[a-z]{2}_[A-Z]{2}-[a-z0-9_]+-(x_low|low|medium|high)$/;

/** The installed voices, by name, with the sample rate each one produces. */
function voices() {
  let files = [];
  try {
    files = fs.readdirSync(VOICE_DIR);
  } catch (_) {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".onnx"))
    .map((f) => f.slice(0, -5))
    .filter((name) => VOICE_RE.test(name))
    .map((name) => {
      let rate = 22050;
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(VOICE_DIR, name + ".onnx.json"), "utf8")
        );
        rate = Number((meta.audio || {}).sample_rate) || rate;
      } catch (_) {
        /* a voice with no readable metadata still speaks; it just uses 22050 */
      }
      return { name, rate, label: label(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "en_US-lessac-medium" -> "Lessac (medium)", which is what a menu wants. */
function label(name) {
  const parts = name.split("-");
  const who = (parts[1] || name).replace(/_/g, " ");
  return who.charAt(0).toUpperCase() + who.slice(1) + " (" + (parts[2] || "") + ")";
}

function defaultVoice() {
  const all = voices();
  if (!all.length) return null;
  // Medium before high: at 3.5x against 2.2x it puts the first syllable out
  // sooner, and in a conversation that is worth more than the extra fidelity.
  const medium = all.find((v) => v.name.endsWith("-medium"));
  return (medium || all[0]).name;
}

function available() {
  try {
    fs.accessSync(PIPER, fs.constants.X_OK);
  } catch (_) {
    return false;
  }
  return voices().length > 0;
}

/* ------------------------------------------------------------------- wav -- */

/**
 * Piper writes headerless PCM, so the header is ours to add.
 *
 * 16-bit mono at the voice's own rate. Written by hand rather than by a library
 * because it is forty-four bytes of well-specified structure, and a dependency
 * that turns up in a panel with root on it should have to earn its place.
 */
function wavHeader(bytes, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + bytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); // PCM header length
  h.writeUInt16LE(1, 20); // format: PCM
  h.writeUInt16LE(1, 22); // channels
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); // byte rate: rate * channels * bytesPerSample
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(bytes, 40);
  return h;
}

/* ----------------------------------------------------------------- speak -- */

function slot() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) return next();
  running = Math.max(0, running - 1);
}

/* ------------------------------------------------------------ warm pool -- */

// Under PrivateTmp this is the unit's own /tmp, invisible to the rest of the
// box. Clips live in it for the few milliseconds between being written and
// being read back.
const OUT_DIR = path.join(os.tmpdir(), "moni-tts");
try {
  fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
} catch (_) {
  /* reported properly by the first synthesis that needs it */
}

// Long enough that a conversation never pays startup twice, short enough that
// a panel left open overnight is not holding a model in memory for nobody.
const IDLE_MS = 10 * 60 * 1000;

const pool = new Map(); // voice name -> warm process

function shutdown(entry, why) {
  if (!entry) return;
  clearTimeout(entry.idle);
  pool.delete(entry.voice.name);
  for (const job of entry.queue.splice(0)) job.reject(new Error(why));
  try {
    entry.child.kill("SIGTERM");
  } catch (_) {
    /* already gone */
  }
}

function warm(voice) {
  const live = pool.get(voice.name);
  if (live && live.child.exitCode === null && !live.child.killed) return live;

  const child = spawn(
    PIPER,
    ["--model", path.join(VOICE_DIR, voice.name + ".onnx"), "--output_dir", OUT_DIR],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OMP_NUM_THREADS: THREADS } }
  );

  const entry = { voice, child, queue: [], buf: "", idle: null };
  pool.set(voice.name, entry);

  // One path per line, in the order the lines went in -- piper is strictly
  // sequential, which is what lets a queue this simple stay correct.
  child.stdout.on("data", (d) => {
    entry.buf += d;
    let nl;
    while ((nl = entry.buf.indexOf("\n")) >= 0) {
      const line = entry.buf.slice(0, nl).trim();
      entry.buf = entry.buf.slice(nl + 1);
      const job = entry.queue.shift();
      if (job) job.resolve(line);
    }
  });
  child.stderr.on("data", (d) => {
    if (entry.err === undefined) entry.err = "";
    if (entry.err.length < 2048) entry.err += d;
  });
  child.on("error", () => shutdown(entry, "the speech synthesiser could not be started"));
  child.on("close", () => shutdown(entry, "the speech synthesiser stopped"));
  child.stdin.on("error", () => {
    /* the close handler reports it */
  });

  return entry;
}

function touch(entry) {
  clearTimeout(entry.idle);
  entry.idle = setTimeout(() => shutdown(entry, "idle"), IDLE_MS);
  if (entry.idle.unref) entry.idle.unref();
}

/** Hand one line to a warm piper and wait for the file it writes. */
function synthesise(voice, line) {
  const entry = warm(voice);
  touch(entry);
  return new Promise((resolve, reject) => {
    const job = { resolve, reject };
    job.timer = setTimeout(() => {
      const at = entry.queue.indexOf(job);
      if (at >= 0) entry.queue.splice(at, 1);
      // A piper that has stopped answering is not one to keep handing work to.
      shutdown(entry, "the speech synthesiser timed out");
      reject(new Error("the speech synthesiser timed out"));
    }, TIMEOUT_MS);
    if (job.timer.unref) job.timer.unref();

    const done = (fn) => (value) => {
      clearTimeout(job.timer);
      fn(value);
    };
    job.resolve = done(resolve);
    job.reject = done(reject);

    entry.queue.push(job);
    entry.child.stdin.write(line + "\n");
  });
}

/**
 * Speak one piece of text. Resolves with a complete WAV.
 *
 * The text goes in over stdin, never on the command line: an argument is
 * readable in /proc by anyone on the box for as long as the call runs, and what
 * this machine says out loud is as much the operator's business as what it is
 * told.
 */
async function speak(text, voiceName) {
  const say = String(text || "").replace(/\s+/g, " ").trim();
  if (!say) throw new Error("nothing to say");
  if (say.length > MAX_CHARS) throw new Error("that is too long to speak in one go");

  const all = voices();
  if (!all.length) throw new Error("no voices are installed");
  const voice = all.find((v) => v.name === voiceName) || all.find((v) => v.name === defaultVoice());
  if (!voice) throw new Error("unknown voice");

  await slot();
  let file = null;
  try {
    // A newline would be read as the end of this sentence and the start of
    // another, which would put the queue one reply out of step for good.
    file = await synthesise(voice, say.replace(/[\r\n]+/g, " "));
    if (!file || !file.startsWith(OUT_DIR)) throw new Error("the synthesiser wrote nowhere");
    const wav = await fs.promises.readFile(file);
    if (wav.length <= 44) throw new Error("the synthesiser produced no audio");
    return wav;
  } finally {
    if (file) fs.promises.unlink(file).catch(() => {});
    release();
  }
}

/** Stop every warm process. Used by the tests; the pool otherwise self-manages. */
function shutdownAll() {
  for (const entry of [...pool.values()]) shutdown(entry, "shutting down");
}

module.exports = { speak, voices, defaultVoice, available, shutdownAll, MAX_CHARS };
