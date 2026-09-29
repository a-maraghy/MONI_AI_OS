#!/usr/bin/env node
"use strict";
/**
 * Tests for the Command Center's streamed voice playback: the Voice module of
 * public/moni-ai.js, cut out of the file that ships and run here in a sandbox
 * with a fake Web Audio clock, a fake fetch whose NDJSON body the test feeds a
 * line at a time, and a fake desk stream.
 *
 *   node dashboard/tools/test-voice-stream.cjs
 *
 * What it holds the page to:
 *   - a sentence starts playing with its first chunk, before its stream ends;
 *   - sentences play strictly in order, whichever arrives first;
 *   - a cut (the reading failed the verbatim check mid-way) stops what is
 *     playing at once -- a short fade, every scheduled chunk stopped -- and the
 *     fallback's reading plays after it, from a fresh start;
 *   - talking over it (barge-in) stops the stream playing, aborts the ones
 *     fetched, and nothing more of them plays;
 *   - the front desk's lines, streamed in its own response, play in line order;
 *   - the orb's speaking level is the analyser's real output level;
 *   - every sentence carries its voice turn and kind, for the usage figures.
 *
 * .cjs because it uses require.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 400) : ""));
  }
}
function section(t) {
  console.log("\n" + t);
}
const flush = () => new Promise((r) => setImmediate(r));
async function settle(n) {
  for (let i = 0; i < (n || 6); i++) await flush();
}

/* ------------------------------------------------ the Voice module's text --- */

const start = SRC.indexOf("  var Voice = (function () {");
const endMark = "    return api_;\n  })();";
const end = SRC.indexOf(endMark, start);
if (start < 0 || end < 0) {
  console.log("  FAIL could not find the Voice module in moni-ai.js");
  process.exit(1);
}
// The mic-mode and stop-command helpers live with the page's other helpers,
// outside the Voice module, so they are carried into the sandbox alongside it.
const helperStart = SRC.indexOf("  function voiceModeFrom(");
const helperEnd = SRC.indexOf("\n  }\n", SRC.indexOf("  function isStopCommand(", helperStart));
if (helperStart < 0 || helperEnd < 0 || SRC.indexOf("  function isStopCommand(", helperStart) < 0) {
  console.log("  FAIL could not find voiceModeFrom and isStopCommand in moni-ai.js");
  process.exit(1);
}
// What the browser loads before moni-ai.js: window.VoiceStop.
const VoiceStop = require(path.join(ROOT, "public", "voice-stop.js"));
const VOICE_SRC = SRC.slice(helperStart, helperEnd + 4) + "\n" + SRC.slice(start, end + endMark.length);

/* ---------------------------------------------------------------- fakes --- */

function fakeEl(id) {
  const cls = new Set();
  return {
    id,
    disabled: false,
    hidden: false,
    title: "",
    textContent: "",
    innerHTML: "",
    style: {},
    classList: { toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)), add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return this.attrs[k] == null ? null : this.attrs[k];
    },
    listeners: {},
    addEventListener(t, fn) {
      (this.listeners[t] = this.listeners[t] || []).push(fn);
    },
    querySelectorAll: () => Array.from({ length: 44 }, () => ({ style: {} })),
  };
}

/** A Web Audio context whose clock only moves when the test says so. */
class FakeAC {
  constructor() {
    this.currentTime = 0;
    this.state = "running";
    this.sources = [];
    this.gains = [];
    this.destination = {};
    this.loud = false; // what the analyser hears
    FakeAC.last = this;
  }
  resume() {
    return Promise.resolve();
  }
  close() {}
  createAnalyser() {
    const ctx = this;
    return {
      fftSize: 512,
      connect() {},
      getByteTimeDomainData(buf) {
        // micLoud: somebody talking into the microphone this context listens to.
        for (let i = 0; i < buf.length; i++) buf[i] = ctx.micLoud || (ctx.loud && ctx.sources.some((s) => s.playing())) ? (i % 2 ? 200 : 56) : 128;
      },
    };
  }
  createGain() {
    const g = { ramps: [], gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime(v, t) { g.ramps.push([v, t]); } }, connect() {}, disconnect() { g.off = true; } };
    this.gains.push(g);
    return g;
  }
  createBuffer(ch, len, rate) {
    const data = new Float32Array(len);
    return { duration: len / rate, length: len, getChannelData: () => data };
  }
  createBufferSource() {
    const ctx = this;
    const s = {
      buffer: null,
      gainNode: null,
      startAt: null,
      stoppedAt: null,
      ended: false,
      onended: null,
      connect(g) {
        s.gainNode = g;
      },
      start(t) {
        s.startAt = t;
        ctx.sources.push(s);
      },
      stop(t) {
        s.stoppedAt = t == null ? ctx.currentTime : t;
      },
      playing() {
        return s.startAt != null && s.stoppedAt == null && !s.ended && ctx.currentTime >= s.startAt;
      },
      value() {
        return s.buffer.getChannelData(0)[0];
      },
    };
    return s;
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  /** Move the clock; sources that have finished end. */
  advance(dt) {
    this.currentTime += dt;
    for (const s of this.sources) {
      if (s.ended || s.stoppedAt != null) continue;
      if (s.startAt + s.buffer.duration <= this.currentTime + 1e-9) {
        s.ended = true;
        if (s.onended) s.onended();
      }
    }
  }
}

/** A fetch whose NDJSON response body the test writes a line at a time. */
const fetches = [];
function fakeFetch(url, init) {
  const f = { url, init, body: JSON.parse(init.body), lines: [], waiters: [], ended: false, aborted: false };
  fetches.push(f);
  const signal = init.signal;
  if (signal) signal.addEventListener("abort", () => {
    f.aborted = true;
    f.waiters.splice(0).forEach((w) => w.reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  f.push = (obj) => {
    f.lines.push(Buffer.from(JSON.stringify(obj) + "\n"));
    const w = f.waiters.shift();
    if (w) w.resolve({ value: f.lines.shift(), done: false });
  };
  f.end = () => {
    f.ended = true;
    const w = f.waiters.shift();
    if (w) w.resolve({ value: undefined, done: true });
  };
  const reader = {
    read() {
      if (f.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (f.lines.length) return Promise.resolve({ value: f.lines.shift(), done: false });
      if (f.ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => f.waiters.push({ resolve, reject }));
    },
  };
  return Promise.resolve({ ok: true, status: 200, headers: { get: () => "application/x-ndjson" }, body: { getReader: () => reader }, json: () => Promise.resolve({}) });
}

/** The desk's stream (apiStream in moni-ai.js), fed by the test. */
const deskCalls = [];
function fakeApiStream(p, body, onEvent) {
  return new Promise((resolve, reject) => deskCalls.push({ path: p, body, onEvent, resolve, reject }));
}

function pcm(value, ms) {
  const n = Math.round(24 * (ms || 100));
  const b = Buffer.alloc(n * 2);
  const v = Math.round(value * 32768);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  return b.toString("base64");
}

/* ------------------------------------------------------------ the sandbox --- */

function boot(opts) {
  const o = opts || {};
  fetches.length = 0;
  deskCalls.length = 0;
  const els = {};
  const docListeners = {};
  const toasts = [];
  let outLevelFn = null;
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error: console.error },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    atob: (s) => Buffer.from(s, "base64").toString("latin1"),
    Float32Array,
    Uint8Array,
    TextDecoder,
    Promise,
    Map,
    Set,
    JSON,
    Math,
    Date,
    String,
    Number,
    Array,
    Object,
    Error,
    Blob: class {},
    FileReader: class {},
    AbortController,
    fetch: fakeFetch,
    navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) } },
    document: {
      activeElement: { tagName: "BODY", isContentEditable: false, getAttribute: () => null },
      addEventListener(t, fn) {
        (docListeners[t] = docListeners[t] || []).push(fn);
      },
      removeEventListener(t, fn) {
        docListeners[t] = (docListeners[t] || []).filter((x) => x !== fn);
      },
    },
    $: (id) => (els[id] = els[id] || fakeEl(id)),
    READY: true,
    VOICE: "marin",
    DESK: !!o.desk,
    CSRF: "tok",
    S: { status: { busy: false } },
    Orb: { micSource() {}, outSource(fn) { outLevelFn = fn; } },
    toast: (m) => toasts.push(m),
    clip: (s, n) => String(s).slice(0, n),
    ic: () => "",
    api: () => Promise.resolve({}),
    apiStream: fakeApiStream,
    send: () => Promise.resolve(null),
    upsertTurn: (t) => t,
    aiText: () => "",
    showPane() {},
    deskTurns: new Set(),
    renderRail() {},
    paintState() {},
    P: { loadVoiceUsage() { sandbox.usageLoads++; }, setVoiceUsage(u) { sandbox.usageSet.push(u); } },
    usageLoads: 0,
    usageSet: [],
  };
  class FakeRecorder {
    constructor() {
      this.state = "inactive";
      this.mimeType = "audio/webm";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      if (this.onstop) this.onstop();
    }
  }
  sandbox.window = { AudioContext: FakeAC, MediaRecorder: FakeRecorder, AbortController, __moniVoice: null };
  sandbox.MediaRecorder = sandbox.window.MediaRecorder;
  vm.createContext(sandbox);
  vm.runInContext(VOICE_SRC + "\nthis.Voice = Voice;", sandbox);
  return {
    Voice: sandbox.Voice,
    diag: () => sandbox.window.__moniVoice,
    ctx: () => FakeAC.last,
    toasts,
    sandbox,
    outLevel: () => outLevelFn(),
    keydown: (code) => (docListeners.keydown || []).forEach((fn) => fn({ code, repeat: false, preventDefault() {} })),
    keyup: (code) => (docListeners.keyup || []).forEach((fn) => fn({ code, repeat: false, preventDefault() {} })),
  };
}

/**
 * The microphone end of the page, for the spoken stop command: the level
 * meter's tick driven by hand, recorders counted, the upload and the
 * transcription faked, and whatever would be sent to MINT AI recorded.
 */
function micRig(t, transcript) {
  const sb = t.sandbox;
  const rig = { sent: [], asked: [], recs: [], tracks: [{ stopped: false, stop() { this.stopped = true; } }], tick: null };
  sb.window.VoiceStop = VoiceStop;
  sb.setInterval = (fn) => ((rig.tick = fn), 1);
  const Base = sb.window.MediaRecorder;
  sb.MediaRecorder = sb.window.MediaRecorder = class extends Base {
    constructor(st, o) {
      super(st, o);
      rig.recs.push(this);
    }
  };
  sb.navigator.mediaDevices.getUserMedia = () => Promise.resolve({ getTracks: () => rig.tracks });
  sb.FileReader = class {
    readAsDataURL() {
      this.result = "data:audio/webm;base64,AAAA";
      this.onload();
    }
  };
  sb.Blob = class {
    constructor(parts, o) {
      this.type = (o && o.type) || "";
    }
  };
  sb.send = (text) => (rig.sent.push(text), Promise.resolve(null));
  sb.api = (p) => (rig.asked.push(p), Promise.resolve(p === "transcribe" ? { text: transcript } : {}));
  /** Say something: loud for a while, with audio recorded, long enough to count. */
  rig.speak = async () => {
    const mic = t.ctx();
    for (let i = 0; i < 8; i++) rig.tick(); // hands-free calibrates first; push to talk does not
    mic.micLoud = true;
    for (let i = 0; i < 6; i++) rig.tick();
    rig.recs[rig.recs.length - 1].ondataavailable({ data: { size: 100 } });
    await new Promise((r) => setTimeout(r, 330)); // longer than MIN_MS
    mic.micLoud = false;
  };
  /** Then a pause, which sends it in hands-free (END_MS of quiet). */
  rig.pause = async () => {
    for (let i = 0; i < 30; i++) rig.tick();
    await settle(10);
  };
  rig.handsFree = async () => {
    t.Voice.setMode("handsfree"); // the voice menu's switch: push to talk -> hands-free
    sb.$("cc-c-mic").listeners.click[0](); // the mic button: start listening
    await settle();
  };
  return rig;
}

/* ----------------------------------------------------------------- tests --- */

(async () => {
  section("direct path: a sentence plays from its first chunk");
  {
    const t = boot();
    t.Voice.unlock(); // the first click: the AudioContext exists
    t.Voice.tag(41, { vt: "vturn41", cat: "direct" });
    t.Voice.flush(41, "Every service on this machine is healthy.");
    await settle();
    check("one POST to /mint-ai/api/speak, asking for a stream", fetches.length === 1 && fetches[0].url === "/mint-ai/api/speak" && fetches[0].init.headers.Accept === "application/x-ndjson");
    check("  it carries the sentence, the voice turn and its kind (for the usage figures)", fetches[0].body.text === "Every service on this machine is healthy." && fetches[0].body.vt === "vturn41" && fetches[0].body.cat === "direct", JSON.stringify(fetches[0].body));
    const f = fetches[0];
    f.push({ type: "start", engine: "gpt-realtime-mini", rate: 24000 });
    f.push({ type: "audio", pcm: pcm(0.25, 100) });
    await settle();
    const ctx = t.ctx();
    check("the first chunk is scheduled at once, with a short lead, before the stream has ended", ctx.sources.length === 1 && !f.ended && ctx.sources[0].startAt > 0 && ctx.sources[0].startAt <= 0.1, ctx.sources.map((s) => s.startAt).join());
    check("  and the samples are the PCM that arrived (0.25)", Math.abs(ctx.sources[0].value() - 0.25) < 1e-4);
    check("  the voice is speaking", t.Voice.speaking === true);
    ctx.loud = true;
    ctx.advance(0.07);
    check("the orb's speaking level is the analyser's real output level", t.outLevel() > 0.3, t.outLevel());
    f.push({ type: "audio", pcm: pcm(0.25, 100) });
    await settle();
    check("the next chunk is scheduled right after the first, gapless", ctx.sources.length === 2 && Math.abs(ctx.sources[1].startAt - (ctx.sources[0].startAt + 0.1)) < 1e-6, ctx.sources.map((s) => s.startAt).join());
    f.push({ type: "end", engine: "realtime" });
    f.end();
    await settle();
    ctx.advance(0.5);
    await settle();
    const d = t.diag();
    check("when the stream has ended and the last chunk played, the sentence is done", t.Voice.speaking === false && d.played === 1 && d.items.length === 1 && d.items[0].sched <= d.items[0].end && d.items[0].first <= d.items[0].sched, JSON.stringify(d.items));
    check("  a quiet voice has level -1 (not speaking)", t.outLevel() === -1);
    check("  and the usage figures are refreshed after the speech", await new Promise((r) => setTimeout(() => r(t.sandbox.usageLoads === 1), 1000)));
  }

  section("ordering: sentences play in order, whichever arrives first");
  {
    const t = boot();
    t.Voice.unlock();
    t.Voice.say("The first sentence is here.");
    t.Voice.say("The second sentence is here.");
    await settle();
    check("both are fetched ahead", fetches.length === 2);
    const [a, b] = fetches;
    b.push({ type: "start", engine: "gpt-realtime-mini" });
    b.push({ type: "audio", pcm: pcm(0.5, 100) });
    b.push({ type: "end", engine: "realtime" });
    b.end();
    await settle();
    const ctx = t.ctx();
    check("the second, arriving first, does not play before the first", ctx.sources.length === 0);
    a.push({ type: "start", engine: "gpt-realtime-mini" });
    a.push({ type: "audio", pcm: pcm(0.25, 100) });
    await settle();
    check("the first plays as soon as its audio arrives", ctx.sources.length === 1 && Math.abs(ctx.sources[0].value() - 0.25) < 1e-4);
    a.push({ type: "end", engine: "realtime" });
    a.end();
    await settle();
    ctx.advance(0.2);
    await settle();
    check("then the second, after the first has finished", ctx.sources.length === 2 && Math.abs(ctx.sources[1].value() - 0.5) < 1e-4 && ctx.sources[1].startAt >= ctx.sources[0].startAt + 0.1 - 1e-9, ctx.sources.map((s) => s.startAt + ":" + s.value().toFixed(2)).join());
  }

  section("a cut mid-clip: playback stops at once, the fallback reads the sentence from the start");
  {
    const t = boot();
    t.Voice.unlock();
    t.Voice.say("Three sessions are running and two are waiting.");
    t.Voice.say("After that, nothing else.");
    await settle();
    const f = fetches[0];
    f.push({ type: "start", engine: "gpt-realtime-mini" });
    f.push({ type: "audio", pcm: pcm(0.25, 100) });
    f.push({ type: "audio", pcm: pcm(0.25, 100) });
    f.push({ type: "audio", pcm: pcm(0.25, 100) });
    await settle();
    const ctx = t.ctx();
    ctx.advance(0.12); // part-way into the first chunks
    const before = ctx.sources.slice();
    const g0 = before[0].gainNode;
    f.push({ type: "cut", why: "unfaithful" });
    await settle();
    check("every scheduled chunk of the failed reading is stopped", before.length === 3 && before.every((s) => s.stoppedAt != null), before.map((s) => s.stoppedAt).join());
    check("  within a short fade (no click): the gain ramps to 0 in ~12 ms", g0.ramps.length === 1 && g0.ramps[0][0] === 0 && g0.ramps[0][1] - ctx.currentTime <= 0.0125 + 1e-9 && before.every((s) => s.stoppedAt <= ctx.currentTime + 0.016), JSON.stringify(g0.ramps));
    check("  the cut is counted, while it was playing", t.diag().cuts === 1 && t.diag().cutAt.length === 1 && t.diag().cutAt[0].playing === true);
    f.push({ type: "start", engine: "gpt-4o-mini-tts" });
    f.push({ type: "audio", pcm: pcm(0.75, 100) });
    await settle();
    const after = ctx.sources.slice(3);
    check("the fallback's reading plays next, through a fresh gain, from a fresh start", after.length === 1 && Math.abs(after[0].value() - 0.75) < 1e-4 && after[0].gainNode !== g0 && after[0].startAt >= ctx.currentTime, after.map((s) => s.startAt).join());
    f.push({ type: "end", engine: "fallback", fallback: true });
    f.end();
    await settle();
    ctx.advance(0.2);
    await settle();
    check("the next sentence still follows, in order", ctx.sources.length === 4 || fetches[1].lines.length === 0, ctx.sources.length);
    check("  the sentence counts as played once, with one cut", t.diag().played === 1 && t.diag().items[0].cuts === 1);

    // A cut before a sentence's turn: what it held is dropped, nothing of it plays.
    const g = fetches[1];
    g.push({ type: "start", engine: "gpt-realtime-mini" });
    g.push({ type: "cut", why: "unfaithful" });
    g.push({ type: "start", engine: "gpt-4o-mini-tts" });
    g.push({ type: "audio", pcm: pcm(0.9, 50) });
    g.push({ type: "end", engine: "fallback" });
    g.end();
    await settle();
    ctx.advance(0.2);
    await settle();
    check("a sentence cut before it played plays only the fallback's reading", ctx.sources.length === 5 && Math.abs(ctx.sources[4].value() - 0.9) < 1e-4, ctx.sources.map((s) => s.value().toFixed(2)).join());

    // Skipped (the fallback failed too): nothing plays, the text stays on screen.
    t.Voice.say("This one will not be read.");
    await settle();
    const h = fetches[2];
    h.push({ type: "start", engine: "gpt-realtime-mini" });
    h.push({ type: "audio", pcm: pcm(0.3, 50) });
    await settle();
    h.push({ type: "cut", why: "unfaithful" });
    h.push({ type: "skipped", why: "unfaithful" });
    h.end();
    await settle();
    ctx.advance(0.2);
    await settle();
    check("cut and then skipped: stopped, and the skip is said once (the words are on screen)", ctx.sources[5] && ctx.sources[5].stoppedAt != null && t.toasts.some((m) => /not read aloud/.test(m)) && t.Voice.speaking === false, t.toasts.join("|"));
  }

  section("barge-in during a stream");
  {
    const t = boot();
    t.Voice.unlock();
    t.Voice.say("A long answer starts here.");
    t.Voice.say("And it goes on.");
    t.Voice.say("And on.");
    await settle();
    const [a, b, c] = fetches;
    a.push({ type: "start", engine: "gpt-realtime-mini" });
    a.push({ type: "audio", pcm: pcm(0.25, 300) });
    b.push({ type: "start", engine: "gpt-realtime-mini" });
    b.push({ type: "audio", pcm: pcm(0.5, 300) });
    await settle();
    const ctx = t.ctx();
    ctx.advance(0.1);
    check("speaking the first", t.Voice.speaking === true && ctx.sources.length === 1);
    t.keydown("Space"); // hold to talk over it
    await settle();
    check("talking over it stops what is playing at once", ctx.sources[0].stoppedAt != null && t.Voice.speaking === false && t.diag().bargeIns === 1);
    check("  and aborts every sentence fetched ahead", a.aborted && b.aborted && c.aborted);
    a.push({ type: "audio", pcm: pcm(0.25, 100) });
    await settle();
    ctx.advance(1);
    await settle();
    check("  nothing more of them plays", ctx.sources.length === 1, ctx.sources.length);
  }

  section("front desk: its lines stream in its own response, and play in line order");
  {
    const t = boot({ desk: true });
    t.Voice.unlock();
    t.Voice.tag(77, { vt: "vdesk77", cat: "handoff" });
    t.Voice.summary(77, "MINT AI's full answer, on screen.");
    await settle();
    check("the summary is asked for with the hand-off's voice turn", deskCalls.length === 1 && deskCalls[0].path === "desk/summary" && deskCalls[0].body.turn === 77 && deskCalls[0].body.vt === "vdesk77", JSON.stringify(deskCalls[0] && deskCalls[0].body));
    const on = deskCalls[0].onEvent;
    on({ type: "line", i: 0, text: "The server is healthy.", safe: false });
    on({ type: "line", i: 1, text: "Nothing needs doing.", safe: false });
    // Line 1's audio shows up first (the page copes even if the wire did not order it).
    on({ type: "start", i: 1, engine: "gpt-realtime-mini" });
    on({ type: "audio", i: 1, pcm: pcm(0.5, 100) });
    on({ type: "end", i: 1, engine: "gpt-realtime-mini" });
    await settle();
    const ctx = t.ctx();
    check("no direct fetches: the desk's audio comes in its own stream", fetches.length === 0);
    check("line 1 does not play before line 0", ctx.sources.length === 0);
    on({ type: "start", i: 0, engine: "gpt-realtime-mini" });
    on({ type: "audio", i: 0, pcm: pcm(0.25, 100) });
    await settle();
    check("line 0 plays from its first chunk", ctx.sources.length === 1 && Math.abs(ctx.sources[0].value() - 0.25) < 1e-4);
    on({ type: "cut", i: 0, why: "unfaithful" });
    on({ type: "start", i: 0, engine: "gpt-4o-mini-tts" });
    on({ type: "audio", i: 0, pcm: pcm(0.75, 100) });
    on({ type: "end", i: 0, engine: "gpt-4o-mini-tts" });
    await settle();
    check("a cut in the desk's stream stops line 0 and plays its fallback", ctx.sources[0].stoppedAt != null && ctx.sources.length === 2 && Math.abs(ctx.sources[1].value() - 0.75) < 1e-4);
    ctx.advance(0.3);
    await settle();
    check("then line 1", ctx.sources.length === 3 && Math.abs(ctx.sources[2].value() - 0.5) < 1e-4, ctx.sources.map((s) => s.value().toFixed(2)).join());
    deskCalls[0].resolve({ type: "done", fallback: null, usage: { today: { total: 0.01 } } });
    await settle();
    check("the done event's usage figures go straight to the Cost card", t.sandbox.usageSet.length === 1 && t.sandbox.usageSet[0].today.total === 0.01);

    // Talked over mid-desk-stream: later lines of that stream are not queued.
    t.Voice.summary(77, "again");
    await settle();
    const on2 = deskCalls[1].onEvent;
    on2({ type: "line", i: 0, text: "First line.", safe: false });
    on2({ type: "start", i: 0, engine: "gpt-realtime-mini" });
    on2({ type: "audio", i: 0, pcm: pcm(0.25, 300) });
    await settle();
    const n = ctx.sources.length;
    t.keydown("Space");
    on2({ type: "line", i: 1, text: "Second line.", safe: false });
    on2({ type: "start", i: 1, engine: "gpt-realtime-mini" });
    on2({ type: "audio", i: 1, pcm: pcm(0.5, 100) });
    await settle();
    ctx.advance(1);
    await settle();
    check("barge-in during the desk's stream: what plays stops, and its later lines are not read", ctx.sources[n - 1].stoppedAt != null && ctx.sources.length === n, `${n} ${ctx.sources.length}`);
  }

  section("the stop command said aloud, hands-free: listening stops, nothing is sent");
  {
    const t = boot();
    const rig = micRig(t, "Stop listening.");
    await rig.handsFree();
    check("hands-free is on and listening", t.Voice.on === true && t.Voice.listening === true && rig.recs.length === 1);
    await rig.speak();
    await rig.pause();
    check("the pause sent the recording to be transcribed", rig.asked.indexOf("transcribe") >= 0 && t.diag().uploads === 1, rig.asked.join());
    check("  the words were not sent to MINT AI", rig.sent.length === 0, rig.sent.join(" | "));
    check("  listening is off, as if the mic button were clicked", t.Voice.on === false && t.Voice.listening === false && t.sandbox.$("cc-c-mic").attrs["aria-pressed"] === "false");
    check("  and the microphone is released", rig.tracks[0].stopped === true);
    check("  a note says so", t.toasts.indexOf("Stopped listening.") >= 0 && t.sandbox.$("cc-vb-text").textContent === "Stopped listening.", t.toasts.join(" | "));
    check("  nothing is said about it (no \"didn't catch that\")", !t.diag().said.some((x) => /catch that/.test(x)) && t.diag().voiceStops === 1, t.diag().said.join(" | "));
    check("  no new recorder was opened after it", rig.recs.length === 1 && rig.recs[0].state === "inactive");
  }

  section("a sentence that merely contains the words is sent as usual");
  {
    const t = boot();
    const rig = micRig(t, "Why did the service stop listening on port 80?");
    await rig.handsFree();
    await rig.speak();
    await rig.pause();
    check("it is sent to MINT AI, word for word", rig.sent.length === 1 && rig.sent[0] === "Why did the service stop listening on port 80?", rig.sent.join(" | "));
    check("  and hands-free stays on", t.Voice.on === true && rig.tracks[0].stopped === false && t.toasts.indexOf("Stopped listening.") < 0);
  }

  section("the stop command in Arabic, through the front desk");
  {
    const t = boot({ desk: true });
    const rig = micRig(t, "");
    await rig.handsFree();
    await rig.speak();
    await rig.pause();
    check("the recording went to the desk", deskCalls.length === 1 && deskCalls[0].path === "desk/turn" && rig.asked.indexOf("transcribe") < 0);
    deskCalls[0].onEvent({ type: "heard", text: "وقف الاستماع", stop: true });
    deskCalls[0].resolve({ type: "done", asked: [], lines: 0, stop: true });
    await settle();
    check("the desk's stop flag closes the mic, and nothing is sent", t.Voice.on === false && rig.tracks[0].stopped === true && rig.sent.length === 0 && t.toasts.indexOf("Stopped listening.") >= 0);
    check("  and hands-free does not start listening again when the desk is done", t.Voice.listening === false && rig.recs.length === 1);

    // A desk that predates the flag: the page reads the words itself.
    const t2 = boot({ desk: true });
    const rig2 = micRig(t2, "");
    await rig2.handsFree();
    await rig2.speak();
    await rig2.pause();
    deskCalls[0].onEvent({ type: "heard", text: "اقفل ال live session" });
    deskCalls[0].resolve({ type: "done", asked: [], lines: 0 });
    await settle();
    check("  without the flag, the words alone stop it too", t2.Voice.on === false && rig2.tracks[0].stopped === true && t2.toasts.indexOf("Stopped listening.") >= 0);
  }

  section("the stop command in push to talk: not sent, and the mic kept open for the next press is released");
  {
    const t = boot();
    const rig = micRig(t, "Okay, stop listening, please.");
    t.keydown("Space");
    await settle();
    check("holding Space records", rig.recs.length === 1 && rig.recs[0].state === "recording");
    const mic = t.ctx();
    mic.micLoud = true;
    for (let i = 0; i < 6; i++) rig.tick();
    rig.recs[0].ondataavailable({ data: { size: 100 } });
    await new Promise((r) => setTimeout(r, 330));
    mic.micLoud = false;
    t.keyup("Space");
    await new Promise((r) => setTimeout(r, 300)); // the release's short tail
    await settle(10);
    check("it was transcribed and not sent", rig.asked.indexOf("transcribe") >= 0 && rig.sent.length === 0, rig.asked.join() + " / " + rig.sent.join());
    check("  the microphone is released at once, not kept for a minute", rig.tracks[0].stopped === true && t.Voice.on === false && t.toasts.indexOf("Stopped listening.") >= 0);
  }

  section("Arabic on the direct path (the simple Command Center): a sentence is sent, the command stops");
  {
    const t = boot();
    const rig = micRig(t, "ما هي حالة الخدمات على هذا الخادم؟");
    await rig.handsFree();
    await rig.speak();
    await rig.pause();
    check("an Arabic sentence is sent to MINT AI word for word", rig.sent.length === 1 && rig.sent[0] === "ما هي حالة الخدمات على هذا الخادم؟", rig.sent.join(" | "));
    check("  and hands-free stays on", t.Voice.on === true && t.toasts.indexOf("Stopped listening.") < 0);

    const t2 = boot();
    const rig2 = micRig(t2, "ممكن توقف الاستماع");
    await rig2.handsFree();
    await rig2.speak();
    await rig2.pause();
    check("the Arabic stop command, asked politely, closes the mic and sends nothing", rig2.sent.length === 0 && t2.Voice.on === false && rig2.tracks[0].stopped === true && t2.toasts.indexOf("Stopped listening.") >= 0, rig2.sent.join(" | "));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("  FAIL no exception\n" + e.stack);
  process.exit(1);
});
