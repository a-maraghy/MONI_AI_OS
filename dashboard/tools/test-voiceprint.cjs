#!/usr/bin/env node
"use strict";
/**
 * The voiceprint (lib/voiceprint.js, lib/voiceprint-routes.js, the relay's
 * gate in lib/voice-live.js, Settings ▸ Voice ▸ Voiceprint, the enrolment page).
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-voiceprint.cjs
 *
 * A FAKE moni-voiceprint on a Unix socket here: it reads who is speaking from
 * the audio's amplitude (1000 = the administrator, 2000 = someone else,
 * 2500 = unsure, 3000 = MINT AI's TTS voice, silence = too short) and answers
 * the matching embedding; it can be slowed, broken or stopped. A fake helper
 * seals with AES-256-GCM in the test. The relay runs against a mock OpenAI
 * realtime server (as tools/test-voice-live.cjs).
 *
 *   1. the library: verdicts and thresholds, fail-open (down, slow, nonsense),
 *      enrolment (sums only, sealed on disk, reopened by a new process), MINT
 *      AI's voice learned for the echo rule, the ledger and the 7-day stats;
 *   2. the relay: OFF = no service call at all and calls as before; SHADOW =
 *      every turn checked and logged, none blocked; the GATE = yours answered,
 *      another voice ignored (page note, never spoken, its "yes" confirms
 *      nothing), unsure asked again, MINT AI's echo dropped; switching on, off
 *      and gating mid-call (the next turn follows); fail-open with the gate on;
 *      hold-to-talk presses;
 *   3. the routes on a scratch copy of server.js: the switch (audited),
 *      the gate needs a voiceprint, enrolment from the trial's recordings and
 *      on the enrolment page, delete, delete everything (voiceprint, key,
 *      trial clips, results, ledger), permissions and CSRF, the service-down
 *      warning;
 *   4. the pages in Chromium, 1440 and 390 px, light and dark: no horizontal
 *      scroll, the switch works, the enrolment page records through the real
 *      worklet with a fake microphone, zero page errors and CSP violations.
 *   5. (when the real model and the trial's recordings are on this box) the
 *      real service on a temporary socket, the administrator's real voice
 *      against real other voices and MINT AI's real TTS voice.
 */
const scratch = require("./scratch-server.cjs"); // first: sets MONI_DATA_DIR
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const ROOT = path.join(__dirname, "..");
const db = require(path.join(ROOT, "lib", "db.js"));
const vpLib = require(path.join(ROOT, "lib", "voiceprint.js"));
const live = require(path.join(ROOT, "lib", "voice-live.js"));
const desk = require(path.join(ROOT, "lib", "voice-shared.js"));
const trialLib = require(path.join(ROOT, "lib", "voiceprint-trial.js"));
const VoiceStop = require(path.join(ROOT, "public", "voice-stop.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 700) : ""));
  }
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const end = Date.now() + (ms || 2000);
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(5);
  }
  return false;
}

/* ------------------------------------------------- the fake service ---- */

const DIM = 64;
const e = (i) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
const U = e(0); // the administrator
const O = e(1); // someone else
const T = e(2); // MINT AI's TTS voice
const M = vpLib.unit(U.map((x, k) => 0.25 * x + 0.968 * O[k])); // unsure: 0.25 against U
const OVER = vpLib.unit(T.map((x, k) => 0.8 * x + 0.1 * U[k])); // MINT AI's voice leaking back: close to T, ~0.12 to U

function speakerOf(pcm) {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  if (peak < 300) return null;
  if (peak < 1500) return U;
  if (peak < 2250) return O;
  if (peak < 2750) return M;
  if (peak < 3500) return T;
  return OVER;
}
const svc = { calls: [], mode: "ok", delay: 0 };
function startFakeService(sock) {
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(parts);
      svc.calls.push({ path: req.url, bytes: body.length });
      if (svc.delay) await sleep(svc.delay);
      if (svc.mode === "broken") return res.writeHead(500, { "Content-Type": "application/json" }), res.end(JSON.stringify({ ok: false, error: "boom" }));
      if (svc.mode === "nonsense") return res.writeHead(200), res.end("not json");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.startsWith("/health")) return res.end(JSON.stringify({ ok: true, model: "fake.onnx", dim: DIM, threads: 1, sha256: "0".repeat(64) }));
      const who = speakerOf(body);
      if (req.url.startsWith("/enrol")) {
        if (!who) return res.end(JSON.stringify({ ok: false, error: "not enough speech" }));
        return res.end(JSON.stringify({ ok: true, embedding: who.map((x) => x * 3), windows: 3, speech_ms: Math.round(body.length / (req.url.includes("24000") ? 48 : 32)), ms: 1 }));
      }
      const ms = Math.round(body.length / 48);
      res.end(JSON.stringify({ ok: true, embedding: who, too_short: !who, speech_ms: who ? ms : 0, used_ms: who ? Math.min(ms, 1200) : 0, ms: 2 }));
    });
  });
  return new Promise((r) => server.listen(sock, () => r(server)));
}

/* --------------------------------------------- a fake helper (seal) ---- */

function fakePriv(dir) {
  const kf = path.join(dir, "key");
  const calls = { seal: 0, open: 0, forget: [] };
  return {
    calls,
    voiceprintSeal: async (b64) => {
      calls.seal++;
      if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32));
      const n = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", fs.readFileSync(kf), n);
      const ct = Buffer.concat([c.update(Buffer.from(b64, "base64")), c.final()]);
      return { sealed: Buffer.concat([n, ct, c.getAuthTag()]).toString("base64") };
    },
    voiceprintOpen: async (b64) => {
      calls.open++;
      const b = Buffer.from(b64, "base64");
      const d = crypto.createDecipheriv("aes-256-gcm", fs.readFileSync(kf), b.subarray(0, 12));
      d.setAuthTag(b.subarray(b.length - 16));
      return { plain: Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("base64") };
    },
    voiceprintForget: async (keep) => {
      calls.forget.push(!!keep);
      if (!keep && fs.existsSync(kf)) fs.unlinkSync(kf);
      return { key_deleted: !keep, results_deleted: 2 };
    },
  };
}

function tone(amp, ms, rate) {
  const n = Math.round(((rate || 24000) * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 4 < 2 ? amp : -amp, i * 2);
  return b;
}

/* ------------------------------------------------ 1. the library ------- */

async function library(sock) {
  section("1. the library");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-lib-"));
  const priv = fakePriv(dir);
  const logs = [];
  let clock = Date.now();
  const mk = () => vpLib.createVoiceprint({ db, priv, dataDir: dir, socketPath: sock, log: (m) => logs.push(m), now: () => clock });
  const vp = mk();
  const me = { id: 41, username: "vpuser" };
  check("defaults: on, gate off, thresholds from the trial", vp.enabled() === true && vp.gate() === false && vp.thresholds().accept === 0.31 && vp.thresholds().reject === 0.2);
  check("not enrolled: the check is 'none' and calls nothing", (await vp.check(me, tone(1000, 1500), {})).verdict === "none" && svc.calls.length === 0);

  for (const id of ["e1", "e2", "e3"]) await vp.enrolClip(me, "laptop", id, tone(1000, 12000, 16000), 16000);
  let err = null;
  try {
    await vp.enrolSave(me, "laptop");
  } catch (x) {
    err = x;
  }
  check("enrolment refuses too little speech (36 s needed: 3 x 12 s = 36 s passes, 2 x would not)", !err, err && err.message);
  const file = path.join(dir, "voiceprint", "41.json");
  const onDisk = fs.readFileSync(file, "utf8");
  check("the voiceprint is on disk sealed (0600, in a 0700 folder), no numbers in clear", (fs.statSync(file).mode & 0o777) === 0o600 && (fs.statSync(path.join(dir, "voiceprint")).mode & 0o777) === 0o700 && !/"sum"|\[3,0,0/.test(onDisk) && JSON.parse(onDisk).sealed.length > 100);
  check("its facts are in clear: microphone, seconds, source", JSON.parse(onDisk).mics.laptop.speech_s === 36 && JSON.parse(onDisk).mics.laptop.source === "enrol");
  const vp2 = mk();
  check("a new process opens it through the helper", (await vp2.printFor(me)) && priv.calls.open === 1 && vp2.hasPrint(me));

  const c1 = await vp2.check(me, tone(1000, 1500), {});
  const c2 = await vp2.check(me, tone(2000, 1500), {});
  const c3 = await vp2.check(me, tone(2500, 1500), {});
  const c4 = await vp2.check(me, tone(100, 1500), {});
  const c5 = await vp2.check(me, tone(2000, 600), {});
  check("verdicts: yours accept (1.0), another reject (0.0), unsure (0.25) uncertain, silence short", c1.verdict === "accept" && c1.score === 1 && c2.verdict === "reject" && c3.verdict === "uncertain" && c4.verdict === "short", JSON.stringify([c1, c2, c3, c4]));
  check("  another voice on < 0.8 s of speech is only 'uncertain'", c5.verdict === "uncertain", JSON.stringify(c5));
  check("  the service was sent the first 1.2 s setting and 24 kHz", svc.calls.some((x) => /\/embed\?rate=24000&first=1.2/.test(x.path)));

  check("MINT AI's voice: learned from what was played (>= 1.5 s), then not again within a minute", (await vp2.learnTts("marin", tone(3000, 2000))) === true && (await vp2.learnTts("marin", tone(3000, 2000))) === false && !!vp2.ttsPrint("marin"));
  const ec = await vp2.check(me, tone(4000, 1500), { overVoice: true, voice: "marin" });
  const ec2 = await vp2.check(me, tone(4000, 1500), { overVoice: false, voice: "marin" });
  check("echo: over the voice and closer to MINT AI's voice -> echo; not over the voice -> reject", ec.verdict === "echo" && ec.tts_score > 0.9 && ec2.verdict === "reject", JSON.stringify([ec, ec2]));

  svc.mode = "broken";
  const f1 = await vp2.check(me, tone(1000, 1500), {});
  svc.mode = "nonsense";
  const f2 = await vp2.check(me, tone(1000, 1500), {});
  svc.mode = "ok";
  svc.delay = 600;
  const t0 = Date.now();
  const f3 = await vp2.check(me, tone(1000, 1500), {});
  const took = Date.now() - t0;
  svc.delay = 0;
  check("fail open: an error, nonsense and a slow service are 'error' (never thrown)", f1.verdict === "error" && f2.verdict === "error" && f3.verdict === "error", JSON.stringify([f1, f2, f3]));
  check("  a slow service is given up on at 400 ms", took < 550, took);
  check("  and the status says so", vp2.status(me).service.error && vp2.status(me).service.ok === false);
  const bad = vpLib.createVoiceprint({ db, priv, dataDir: dir, socketPath: path.join(dir, "nope.sock"), log: () => {} });
  await bad.printFor(me);
  check("  a missing socket is 'error' too", (await bad.check(me, tone(1000, 1500), {})).verdict === "error");
  check("  and a good answer clears it", (await vp2.check(me, tone(1000, 1500), {})).verdict === "accept" && vp2.status(me).service.error === null);

  db.voiceprintChecksDelete("vpuser");
  for (const [v, s] of [["accept", 0.62], ["accept", 0.55], ["reject", 0.05], ["uncertain", 0.25], ["echo", 0.1], ["error", null]]) vp2.ledger({ actor: "vpuser", call_id: "lvx", turn: 1, mode: "vad", verdict: v, score: s, ms: 20, acted: "shadow" });
  const st = vp2.stats(7, "vpuser");
  check("the ledger and its 7 days: counts, would-ignore, would-ask, histogram", st.checked === 6 && st.by.accept === 2 && st.would_ignore === 2 && st.would_ask === 1 && st.by.error === 1 && st.hist.reduce((a, b) => a + b, 0) === 5, JSON.stringify(st));
  check("  no audio and no embedding in a ledger row", Object.keys(db.voiceprintChecksSince(0, "vpuser")[0]).every((k) => !/emb|pcm|audio/.test(k)));

  await vp2.enrolClip(me, "headset", "e1", tone(1000, 40000, 16000), 16000);
  const sv = await vp2.enrolSave(me, "headset");
  check("a second microphone joins the voiceprint (pooled)", sv.mics.join() === "laptop,headset" && Object.keys(vp2.meta(me).mics).length === 2);
  check("removing one keeps the other", (await vp2.removeMic(me, "headset")) && Object.keys(vp2.meta(me).mics).join() === "laptop" && vp2.hasPrint(me));
  const other = { id: 42, username: "vpother" };
  await vp2.enrolClip(other, "laptop", "e1", tone(2000, 40000, 16000), 16000);
  await vp2.enrolSave(other, "laptop");
  const fa = await vp2.forgetAll(me);
  check("delete everything: the print, the ledger rows; the key kept while another voiceprint needs it", fa.print && fa.ledger_rows === 6 && priv.calls.forget[priv.calls.forget.length - 1] === true && !fs.existsSync(file) && !vp2.hasPrint(me), JSON.stringify(fa));
  await vp2.forgetAll(other);
  check("  the last one: the key goes too", priv.calls.forget[priv.calls.forget.length - 1] === false);
  check("nothing about a voice in the log lines", logs.every((l) => !/\[|\d\.\d{4}/.test(l)), logs.join("\n"));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* --------------------------------------------- 2. the relay ------------ */

const KEY = "sk-proj-" + "V".repeat(40) + "vpvp";
const mock = { sessions: [] };
const mockServer = http.createServer((q, s) => (s.writeHead(404), s.end()));
const mockWss = new WebSocketServer({ noServer: true });
mockServer.on("upgrade", (req, sock, head) => {
  mockWss.handleUpgrade(req, sock, head, (ws) => {
    const s = { ws, events: [], session: null };
    s.push = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ event_id: "ev" + Math.random().toString(36).slice(2), ...o }));
    s.of = (type) => s.events.filter((x) => x.type === type);
    ws.on("message", (d) => {
      const ev = JSON.parse(String(d));
      if (ev.type === "input_audio_buffer.append") return;
      s.events.push(ev);
      if (ev.type === "session.update") {
        s.session = { ...(s.session || {}), ...ev.session };
        s.push({ type: "session.updated", session: s.session });
      }
    });
    mock.sessions.push(s);
  });
});
let WS_BASE;

function relayCall(vp, user, extra) {
  const x = extra || {};
  const client = { json: [], audio: [] };
  const logs = [];
  const spoke = [];
  const heardConfirm = [];
  const c = new live.LiveCall({
    cfg: { key: KEY, voice: "marin", model: "gpt-realtime-mini", transcribe_model: "gpt-4o-mini-transcribe", wsBase: WS_BASE },
    actor: user.username,
    ops: desk.voiceOps(() => Promise.resolve({}), user.username),
    client: { json: (o) => client.json.push(o), audio: (seg, buf) => client.audio.push({ seg, bytes: buf.length }), close: () => {} },
    persona: () => ({}),
    speak: async (text, cfg, sink) => {
      spoke.push(text);
      sink.start({ engine: "fake" });
      sink.audio(Buffer.alloc(4800));
      return { billing: [], lateBilling: Promise.resolve([]) };
    },
    transcribe: async () => ({ text: "", model: "gpt-4o-mini-transcribe", tokens: null }),
    summarise: async () => ({ tokens: null }),
    record: () => 0,
    isStop: (t) => VoiceStop.heard(t),
    isUndo: (t) => VoiceStop.undo(t),
    isYesNo: (t) => VoiceStop.yes(t) || VoiceStop.no(t),
    confirmPending: x.confirm ? () => true : undefined,
    confirmHeard: x.confirm ? (text) => (heardConfirm.push(text), { confirmed: { id: "cf1" } }) : undefined,
    log: (m) => logs.push(m),
    voiceprint: vp
      ? { enabled: () => vp.enabled(), gate: () => vp.gate(), hasPrint: () => vp.hasPrint(user), check: (pcm, o) => vp.check(user, pcm, o), record: (row) => vp.ledger({ ...row, actor: user.username }), learnTts: (v, pcm) => vp.learnTts(v, pcm) }
      : null,
    opts: { pollMs: 20, ...(x.opts || {}) },
  });
  return { c, client, logs, spoke, heardConfirm };
}
async function turn(s, c, amp, text, o) {
  const item = "item_" + Math.random().toString(36).slice(2, 8);
  const ms = (o && o.ms) || 1500;
  c.audioIn(tone(0, 400)); // a pause between turns
  const at = c.inputMs;
  c.audioIn(tone(amp, ms));
  s.push({ type: "input_audio_buffer.speech_started", audio_start_ms: at, item_id: item });
  s.push({ type: "input_audio_buffer.speech_stopped", audio_end_ms: c.inputMs, item_id: item });
  s.push({ type: "input_audio_buffer.committed", item_id: item });
  s.push({ type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: text });
  await sleep(120);
  return item;
}
const created = (s) => s.of("response.create").length;
const deleted = (s, item) => s.of("conversation.item.delete").some((x) => x.item_id === item);

async function relay(sock) {
  section("2. the relay (lib/voice-live.js)");
  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  WS_BASE = "ws://127.0.0.1:" + mockServer.address().port + "/v1";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-relay-"));
  const priv = fakePriv(dir);
  const vp = vpLib.createVoiceprint({ db, priv, dataDir: dir, socketPath: sock, log: () => {} });
  const me = { id: 51, username: "relayuser" };
  for (const id of ["e1", "e2", "e3", "e4"]) await vp.enrolClip(me, "laptop", id, tone(1000, 10000, 16000), 16000);
  await vp.enrolSave(me, "laptop");
  db.voiceprintChecksDelete("relayuser");

  // OFF
  vp.setEnabled(false, "test");
  {
    const { c, client } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    const before = svc.calls.length;
    await turn(s, c, 2000, "what is the disk usage?");
    check("OFF: the service is never called", svc.calls.length === before);
    check("  and the turn is answered as always", created(s) === 1 && client.json.some((m) => m.type === "caption" && m.who === "you"));
    check("  nothing in the ledger", db.voiceprintChecksSince(0, "relayuser").length === 0);
    c.close("test");
  }

  // SHADOW
  vp.setEnabled(true, "test");
  {
    const { c, client, logs } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    await turn(s, c, 1000, "what is the disk usage?");
    await turn(s, c, 2000, "turn off the lights");
    await turn(s, c, 2500, "maybe me");
    await until(() => db.voiceprintChecksSince(0, "relayuser").length >= 3, 1500);
    const rows = db.voiceprintChecksSince(0, "relayuser");
    check("SHADOW: every turn checked and logged", rows.length === 3 && rows.map((r) => r.verdict).join() === "accept,reject,uncertain" && rows.every((r) => r.acted === "shadow" && !r.gated), JSON.stringify(rows.map((r) => [r.verdict, r.acted])));
    check("  nothing blocked: all three answered, no note on the page", created(s) === 3 && !client.json.some((m) => m.type === "voiceprint"));
    check("  the log names the verdict and score per turn, nothing else of the voice", logs.some((l) => /turn \d+ voiceprint: accept 1\.000/.test(l)) && logs.some((l) => /voiceprint: reject 0\.000.*\(shadow\)/.test(l)), logs.filter((l) => /voiceprint/.test(l)).join("\n"));
    c.close("test");
  }

  // GATE
  db.voiceprintChecksDelete("relayuser");
  vp.setGate(true, "test");
  {
    const { c, client, spoke } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    await turn(s, c, 1000, "what is the disk usage?");
    check("GATE: your voice is answered", created(s) === 1 && client.json.filter((m) => m.type === "caption" && m.who === "you").length === 1);
    const other = await turn(s, c, 2000, "turn off the lights");
    check("  another voice: not answered, forgotten upstream, its words never shown", created(s) === 1 && deleted(s, other) && client.json.filter((m) => m.type === "caption" && m.who === "you").length === 1);
    check("  the page is told (shown, never spoken)", client.json.some((m) => m.type === "voiceprint" && m.verdict === "reject") && !spoke.some((t) => /not your voice/i.test(t)));
    const unsure = await turn(s, c, 2500, "maybe me");
    await until(() => spoke.length > 0, 1000);
    check("  unsure: not answered; it says “Sorry, say that again?”", created(s) === 1 && deleted(s, unsure) && spoke.includes("Sorry, say that again?"), JSON.stringify(spoke));
    await turn(s, c, 2500, "maybe me again");
    check("  not twice in a row (at most every 6 s)", spoke.filter((t) => /say that again/.test(t)).length === 1);
    const rows = db.voiceprintChecksSince(0, "relayuser");
    check("  the ledger says what was done", rows.map((r) => r.acted).join("|") === "answered|ignored|asked again|ignored (asked lately)" && rows.every((r) => r.gated === 1), JSON.stringify(rows.map((r) => r.acted)));
    c.close("test");
  }
  {
    const dbg = relayCall(vp, me, { confirm: true });
    const { c, heardConfirm, client } = dbg;
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    await turn(s, c, 2000, "yes");
    check("GATE: a “yes” in another voice confirms nothing", heardConfirm.length === 0 && !client.json.some((m) => m.type === "ui-confirmed"));
    await turn(s, c, 1000, "yes");
    check("  your “yes” does", heardConfirm.length === 1 && client.json.some((m) => m.type === "ui-confirmed"), JSON.stringify({ heardConfirm, logs: dbg.logs.filter((l) => /voiceprint|dropped/.test(l)), json: client.json.map((m) => m.type) }));
    c.close("test");
  }
  {
    // MINT AI's voice leaking back: learned print, a turn over the voice
    await vp.learnTts("marin", tone(3000, 2000));
    const { c, client } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    const item = "item_echo";
    c.audioIn(tone(4000, 1500));
    c.lastAudibleAt = Date.now(); // the voice just played
    s.push({ type: "input_audio_buffer.speech_started", audio_start_ms: 0, item_id: item });
    s.push({ type: "input_audio_buffer.speech_stopped", audio_end_ms: c.inputMs, item_id: item });
    s.push({ type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: "the disk is forty one percent full and odoo is running" });
    await sleep(150);
    const row = db.voiceprintChecksSince(0, "relayuser").pop();
    check("GATE: MINT AI's own voice heard over its playback is dropped silently", created(s) === 0 && row.verdict === "echo" && row.acted === "dropped (echo)" && !client.json.some((m) => m.type === "voiceprint"), JSON.stringify(row));
    c.close("test");
  }

  // switching mid-call
  {
    const { c } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    await turn(s, c, 2000, "first");
    check("mid-call: gate on, another voice ignored", created(s) === 0);
    vp.setGate(false, "test");
    await turn(s, c, 2000, "second");
    check("  the gate switched off in Settings: the next turn is answered (watching again)", created(s) === 1);
    vp.setEnabled(false, "test");
    const before = svc.calls.length;
    await turn(s, c, 2000, "third");
    check("  the voiceprint switched off: the next turn calls nothing and is answered", svc.calls.length === before && created(s) === 2);
    vp.setEnabled(true, "test");
    vp.setGate(true, "test");
    await turn(s, c, 2000, "fourth");
    check("  on again with the gate: the next turn is checked and ignored", svc.calls.length === before + 1 && created(s) === 2);
    c.close("test");
  }

  // fail open with the gate on
  {
    const { c, logs } = relayCall(vp, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    svc.mode = "broken";
    await turn(s, c, 2000, "the service is down");
    svc.mode = "ok";
    svc.delay = 700;
    const t0 = Date.now();
    await turn(s, c, 2000, "the service is slow");
    await until(() => created(s) === 2, 1500);
    const took = Date.now() - t0;
    svc.delay = 0;
    check("FAIL OPEN: with the gate on, a broken and a slow service let the turn through", created(s) === 2, created(s));
    check("  a slow one costs at most ~400 ms", took < 800, took);
    check("  logged, and the ledger says answered (fail open)", logs.some((l) => /voiceprint: error/.test(l)) && db.voiceprintChecksSince(0, "relayuser").slice(-2).every((r) => r.verdict === "error" && r.acted === "answered (fail open)"));
    c.close("test");
  }

  // hold-to-talk
  {
    const { c, client } = relayCall(vp, me, { opts: { turn: "ptt" } });
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    const press = async (amp) => {
      c.message({ type: "ptt", on: true });
      c.audioIn(tone(amp, 1200));
      c.message({ type: "ptt", on: false });
      const item = "item_p" + Math.random().toString(36).slice(2, 6);
      s.push({ type: "input_audio_buffer.committed", item_id: item });
      s.push({ type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: "open the agents page" });
      await sleep(150);
      return item;
    };
    await press(1000);
    check("hold-to-talk, gate on: your press is answered", created(s) === 1);
    const it = await press(2000);
    check("  another voice's press is ignored", created(s) === 1 && deleted(s, it) && client.json.some((m) => m.type === "voiceprint"));
    const rows = db.voiceprintChecksSince(0, "relayuser").slice(-2);
    check("  the ledger counts presses", rows.every((r) => r.mode === "ptt") && rows.map((r) => r.turn).join() === "1,2", JSON.stringify(rows.map((r) => [r.mode, r.turn])));
    c.close("test");
  }
  {
    // MINT AI's voice is learned from what it plays, only while the voiceprint is on
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "vp-learn-"));
    const vp3 = vpLib.createVoiceprint({ db, priv: fakePriv(dir2), dataDir: dir2, socketPath: sock, log: () => {} });
    await vp3.enrolClip(me, "laptop", "e1", tone(1000, 40000, 16000), 16000);
    await vp3.enrolSave(me, "laptop");
    vp3.setGate(false, "test");
    const { c } = relayCall(vp3, me);
    await c.open();
    const s = mock.sessions[mock.sessions.length - 1];
    await turn(s, c, 1000, "tell me a story");
    const rid = "resp_learn";
    s.push({ type: "response.created", response: { id: rid } });
    s.push({ type: "response.output_item.added", item: { id: "ia", type: "message" } });
    for (let i = 0; i < 12; i++) {
      s.push({ type: "response.output_audio_transcript.delta", item_id: "ia", delta: "Once upon a time there was a quiet garden. " });
      s.push({ type: "response.output_audio.delta", item_id: "ia", delta: tone(3000, 200).toString("base64") });
    }
    s.push({ type: "response.done", response: { id: rid, status: "completed", output: [] } });
    await until(() => !!vp3.ttsPrint("marin"), 1500);
    check("MINT AI's voice print is learned from what the relay played", !!vp3.ttsPrint("marin"));
    c.close("test");
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  vp.setGate(false, "test");
  vp.setEnabled(true, "test");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* -------------------------------------------- 3. the routes ------------ */

async function routes(sock) {
  section("3. the routes (scratch copy of server.js)");
  const s = await scratch.startScratch({ fakeVoiceprint: true, fakeVoiceOptions: true, env: { MONI_VOICEPRINT_SOCKET: sock } });
  try {
    await s.makeUser("vpadmin", "administrator");
    await s.makeUser("vpop", "operator-vp2", ["moniai.use", "os.view"]);
    const ad = await s.signIn("vpadmin");
    const op = await s.signIn("vpop");
    const page = async () => s.req("GET", "/mint-ai/settings/voice", { cookie: ad.cookie });
    let pg = await page();
    const csrf = s.csrfOf(pg.body);
    const post = (p, body, who) => s.req("POST", p, { cookie: (who || ad).cookie, body: new URLSearchParams({ _csrf: csrf, ...(body || {}) }).toString(), headers: { Accept: "application/json" } });
    await post("/mint-ai/settings/voice/enabled", { enabled: "1" });
    pg = await page();
    check("Settings ▸ Voice has the Voiceprint group: On by default, the gate greyed (not enrolled)", pg.status === 200 && /id="v-vp"/.test(pg.body) && /id="vp-enabled"[^>]*checked/.test(pg.body) && /id="vp-gate"[^>]*disabled/.test(pg.body) && /Enrol your voiceprint first/.test(pg.body), pg.status);
    check("  with the model's attribution", /WeSpeaker ResNet34-LM/.test(pg.body) && /CC-BY-4\.0/.test(pg.body));
    let r = await post("/mint-ai/settings/voice/voiceprint/gate", { gate: "1" });
    check("the gate needs a voiceprint", r.status === 400 && /Enrol your voiceprint first/.test(r.body), r.body);
    r = await post("/mint-ai/settings/voice/voiceprint", {});
    pg = await page();
    check("switching it off: saved, audited, the gate row greyed with the reason", r.status === 200 && db.getSetting("voiceprint_enabled") === "off" && /id="vp-enabled"(?![^>]*checked)/.test(pg.body) && /The voiceprint is off\./.test(pg.body) && db.recentLogins(20).some((x) => /voiceprint off/.test(x.detail || "")));
    r = await post("/mint-ai/settings/voice/voiceprint", { enabled: "1" });
    check("  and on again", r.status === 200 && db.getSetting("voiceprint_enabled") === "on");
    check("without voice.manage: refused", (await post("/mint-ai/settings/voice/voiceprint", {}, op)).status === 403 && db.getSetting("voiceprint_enabled") === "on");
    check("without CSRF: refused", (await s.req("POST", "/mint-ai/settings/voice/voiceprint", { cookie: ad.cookie, body: "enabled=1", headers: { Accept: "application/json" } })).status === 403);

    // the trial's recordings, through the trial's own API
    const tpg = await s.req("GET", "/mint-ai/voiceprint-trial", { cookie: ad.cookie });
    const tcsrf = s.csrfOf(tpg.body);
    const wav24 = (amp, sec) => {
      const pcm = tone(amp, sec * 1000);
      const h = Buffer.alloc(44);
      h.write("RIFF", 0, "ascii");
      h.writeUInt32LE(36 + pcm.length, 4);
      h.write("WAVEfmt ", 8, "ascii");
      h.writeUInt32LE(16, 16);
      h.writeUInt16LE(1, 20);
      h.writeUInt16LE(1, 22);
      h.writeUInt32LE(24000, 24);
      h.writeUInt32LE(48000, 28);
      h.writeUInt16LE(2, 32);
      h.writeUInt16LE(16, 34);
      h.write("data", 36, "ascii");
      h.writeUInt32LE(pcm.length, 40);
      return Buffer.concat([h, pcm]);
    };
    const rawPost = (p, body, headers) =>
      new Promise((resolve, reject) => {
        const q = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: p, headers: { "X-Forwarded-Proto": "https", Cookie: ad.cookie, "Content-Type": "audio/wav", "Content-Length": body.length, ...(headers || {}) } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode, body: b }));
        });
        q.on("error", reject);
        q.end(body);
      });
    for (const id of ["e1", "e2", "e3", "e4"]) await rawPost("/mint-ai/api/voiceprint-trial/clip?slot=laptop&id=" + id, wav24(1000, 12), { "X-CSRF-Token": tcsrf });
    await rawPost("/mint-ai/api/voiceprint-trial/clip?slot=laptop&id=t01", wav24(1000, 1), { "X-CSRF-Token": tcsrf });
    pg = await page();
    check("the trial's recordings are offered", /id="vp-from-trial-laptop"/.test(pg.body));
    r = await post("/mint-ai/settings/voice/voiceprint/from-trial", { slot: "laptop" });
    const vpFile = path.join(s.data, "voiceprint");
    const files = fs.existsSync(vpFile) ? fs.readdirSync(vpFile).filter((f) => /^\d+\.json$/.test(f)) : [];
    check("enrol from the trial's recordings: sealed on disk, audited", r.status === 200 && files.length === 1 && !/"sum"/.test(fs.readFileSync(path.join(vpFile, files[0]), "utf8")) && db.recentLogins(20).some((x) => /enrolled from the trial recordings \(laptop, 48 s/.test(x.detail || "")), r.body);
    pg = await page();
    check("  the page shows it, and the gate can be switched on", /id="vp-mics"/.test(pg.body) && /Laptop microphone/.test(pg.body) && !/id="vp-gate"[^>]*disabled/.test(pg.body));
    r = await post("/mint-ai/settings/voice/voiceprint/gate", { gate: "1" });
    check("  gate on: saved and audited", r.status === 200 && db.getSetting("voiceprint_gate") === "on" && db.recentLogins(20).some((x) => /only respond to my voice on/.test(x.detail || "")));

    // the enrolment page and its calls
    const ep = await s.req("GET", "/mint-ai/voiceprint/enrol", { cookie: ad.cookie });
    check("the enrolment page renders (4 paragraphs, no inline script or style)", ep.status === 200 && (ep.body.match(/data-rec="e\d"/g) || []).length === 4 && !/\sstyle="/.test(ep.body) && !/<script(?![^>]*\bsrc=)[^>]*>[^<]/.test(ep.body.replace(/<script type="application\/(ld\+)?json"[\s\S]*?<\/script>/g, "")));
    check("  not for a role without voice.manage", (await s.req("GET", "/mint-ai/voiceprint/enrol", { cookie: op.cookie })).status === 403);
    const ecsrf = s.csrfOf(ep.body);
    check("  a clip without CSRF is refused", (await rawPost("/mint-ai/api/voiceprint/enrol-clip?mic=headset&id=e1", wav24(1000, 10))).status === 403);
    let tot = 0;
    for (const id of ["e1", "e2", "e3"]) {
      const x = await rawPost("/mint-ai/api/voiceprint/enrol-clip?mic=headset&id=" + id, wav24(1000, 12), { "X-CSRF-Token": ecsrf });
      tot = JSON.parse(x.body).total_s;
    }
    check("  each clip is learned at once; the total grows", tot === 36, tot);
    check("  nothing of the audio is kept on disk", !fs.readdirSync(s.data, { recursive: true }).some((f) => /headset/.test(String(f))));
    const save = await s.req("POST", "/mint-ai/api/voiceprint/enrol-save", { cookie: ad.cookie, body: { mic: "headset" }, headers: { "X-CSRF-Token": ecsrf } });
    check("  saved: the voiceprint now has two microphones", save.status === 200 && JSON.parse(save.body).mics.join() === "laptop,headset", save.body);
    const st = await s.req("GET", "/mint-ai/api/voiceprint/enrol-status?mic=headset", { cookie: ad.cookie });
    check("  and the pending sums are gone", JSON.parse(st.body).clips.length === 0);
    const bad = await rawPost("/mint-ai/api/voiceprint/enrol-clip?mic=headset&id=e1", wav24(1000, 1), { "X-CSRF-Token": ecsrf });
    check("  a 1 s paragraph is refused", bad.status === 400);

    // the service down: the warning
    svc.mode = "broken";
    pg = await page();
    svc.mode = "ok";
    check("the service down: Settings warns (fail open)", /id="vp-service-warn"/.test(pg.body) && /nothing is blocked/.test(pg.body));

    // remove a mic, delete, delete everything
    r = await post("/mint-ai/settings/voice/voiceprint/remove-mic", { mic: "headset" });
    pg = await page();
    check("remove a microphone", r.status === 200 && !/Headset<\/b>/.test(pg.body) && /Laptop microphone<\/b>/.test(pg.body));
    db.voiceprintCheckInsert({ ts: Date.now(), actor: "vpadmin", verdict: "accept", score: 0.6, acted: "shadow" });
    pg = await page();
    check("the last 7 days are shown, with the histogram", /id="vp-stats"/.test(pg.body) && /<svg class="vp-hist"/.test(pg.body) && /1<\/b> turns checked/.test(pg.body));
    r = await post("/mint-ai/settings/voice/voiceprint/forget-all", {});
    const trialDir = path.join(s.data, "voiceprint-trial", "vpadmin");
    check("delete everything: voiceprint, trial recordings, ledger, the key; the gate off", r.status === 200 && fs.readdirSync(vpFile).filter((f) => /^\d+\.json$/.test(f)).length === 0 && !fs.existsSync(trialDir) && db.voiceprintChecksSince(0, "vpadmin").length === 0 && JSON.parse(fs.readFileSync(path.join(s.data, "fake-vp-forget.json"), "utf8")).keepKey === false && db.getSetting("voiceprint_gate") === "off", r.body);
    check("  audited with counts only", db.recentLogins(30).some((x) => /deleted everything \(voiceprint yes, key deleted, 5 trial clips, 0 result folders, 1 check rows\)/.test(x.detail || "")), db.recentLogins(5).map((x) => x.detail).join("\n"));
    await browser(s, ad);
  } finally {
    s.stop();
  }
}

/* -------------------------------------------- 4. the pages -------------- */

async function browser(s, ad) {
  section("4. the pages in Chromium");
  let chromium;
  try {
    ({ chromium } = require(process.env.PLAYWRIGHT || "playwright"));
  } catch (e) {
    console.log("  skip no Playwright (set PLAYWRIGHT=/path/to/node_modules/playwright)");
    return;
  }
  const b = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const cookies = ad.cookie.split("; ").map((c) => {
    const i = c.indexOf("=");
    return { name: c.slice(0, i), value: c.slice(i + 1), domain: "127.0.0.1", path: "/" };
  });
  try {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      for (const scheme of ["light", "dark"]) {
        const tag = `${w} px ${scheme}`;
        const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, permissions: ["microphone"] });
        await ctx.addCookies(cookies);
        const page = await ctx.newPage();
        const errs = [];
        page.on("pageerror", (x) => errs.push(x.message));
        page.on("console", (m) => {
          const t = m.text();
          if ((m.type() === "error" && !/Failed to load resource|net::ERR|EventSource|503|502/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t);
        });
        await page.goto(`http://127.0.0.1:${s.port}/mint-ai/settings/voice#v-vp`);
        await page.waitForSelector("#v-vp");
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(tag + ": Settings ▸ Voice, no horizontal scroll", over <= 0, over);
        check(tag + ": the Voiceprint group is visible, the gate greyed (not enrolled)", (await page.isVisible("#v-vp")) && (await page.isDisabled("#vp-gate")));
        // switch it off through the page (os.js sends the form in place, after the confirm)
        await page.locator("#v-voiceprint label.sw").click();
        const yes = await page.waitForSelector('.cc-sdlg [data-a="yes"]', { timeout: 3000 }).catch(() => null);
        if (yes) await yes.click();
        await until(async () => db.getSetting("voiceprint_enabled") === "off", 4000);
        check(tag + ": the switch turns it off from the page (with a confirm)", !!yes && db.getSetting("voiceprint_enabled") === "off");
        db.setSetting("voiceprint_enabled", "on", "test");
        if (w === 1440 && scheme === "light") await page.locator("#v-vp").screenshot({ path: path.join(os.tmpdir(), "vp-settings-1440-light.png") }).catch(() => {});
        if (w === 390 && scheme === "dark") await page.locator("#v-vp").screenshot({ path: path.join(os.tmpdir(), "vp-settings-390-dark.png") }).catch(() => {});

        // the switch's form reloads the page after it saved: let that finish before going on
        await page.waitForTimeout(600);
        await page.waitForLoadState("networkidle").catch(() => {});
        for (let i = 0; i < 3; i++) {
          try {
            await page.goto(`http://127.0.0.1:${s.port}/mint-ai/voiceprint/enrol`);
            break;
          } catch (x) {
            if (i === 2) throw x;
            await page.waitForTimeout(500);
          }
        }
        await page.waitForSelector("#vpe");
        const over2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(tag + ": the enrolment page, no horizontal scroll", over2 <= 0, over2);
        await page.click('[data-rec="e1"]');
        await page.waitForFunction(() => /recording/.test(document.querySelector('[data-state="e1"]').textContent), null, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(3600);
        await page.click('[data-rec="e1"]');
        await page.waitForFunction(() => /done ·|refused|Nothing|not answering|HTTP|between/.test(document.querySelector('[data-state="e1"]').textContent), null, { timeout: 8000 }).catch(() => {});
        const st = await page.textContent('[data-state="e1"]');
        check(tag + ": a paragraph recorded through the worklet is learned", /done · \d/.test(st), st);
        check(tag + ": not enough yet: Save stays off", await page.isDisabled("#vpe-save"));
        if (w === 1440 && scheme === "dark") await page.screenshot({ path: path.join(os.tmpdir(), "vp-enrol-1440-dark.png") }).catch(() => {});
        check(tag + ": zero page errors and CSP violations", errs.length === 0, errs.join("\n"));
        await ctx.close();
      }
    }
  } finally {
    await b.close();
  }
}

/* ------------------------------- 5. the real service, the real voice ---- */

async function real() {
  section("5. the real service and the administrator's real recordings");
  const PY = "/root/.local/mint-voiceprint/venv/bin/python";
  const MODEL = "/root/.local/mint-voiceprint/models/wespeaker-voxceleb-resnet34-LM/voxceleb_resnet34_LM.onnx";
  const trialRoot = "/var/lib/moni-dashboard/voiceprint-trial";
  let userDir = null;
  try {
    userDir = fs.readdirSync(trialRoot).map((d) => path.join(trialRoot, d)).find((d) => fs.existsSync(path.join(d, "laptop", "e1.wav")));
  } catch (_) {
    userDir = null;
  }
  if (!fs.existsSync(PY) || !fs.existsSync(MODEL) || !userDir) {
    console.log("  skip no model or no trial recordings on this machine");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-real-"));
  const sock = path.join(dir, "vp.sock");
  const child = spawn(PY, [path.join(ROOT, "..", "voiceprint", "server.py")], { env: { ...process.env, MONI_VOICEPRINT_SOCKET: sock, MONI_VOICEPRINT_MODEL: MODEL, MONI_VOICEPRINT_THREADS: "4" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    check("the real service starts on its socket", await until(() => fs.existsSync(sock), 15000), out);
    await sleep(300);
    const vp = vpLib.createVoiceprint({ db, priv: fakePriv(dir), dataDir: dir, socketPath: sock, log: () => {}, parseWav: trialLib.parseWav, trialClips: () => ["e1", "e2", "e3", "e4"].map((id) => ({ mic: "laptop", id, part: "enrol", path: path.join(userDir, "laptop", id + ".wav") })) });
    const me = { id: 99, username: "realuser" };
    const en = await vp.enrolFromTrial(me, "laptop");
    check("enrolled from the administrator's own trial paragraphs", en.speech_s > 30, JSON.stringify(en));
    // 16 kHz clip -> 24 kHz PCM, as the relay would send
    const to24 = (file) => {
      const w = trialLib.parseWav(fs.readFileSync(file));
      const x = w.samples;
      const n = Math.floor((x.length * 3) / 2);
      const b = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) {
        const p = (i * 2) / 3;
        const a = Math.floor(p);
        const f = p - a;
        const v = (x[a] || 0) * (1 - f) + (x[Math.min(a + 1, x.length - 1)] || 0) * f;
        b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
      }
      return b;
    };
    const tests = fs.readdirSync(path.join(userDir, "laptop")).filter((f) => /^t\d+\.wav$/.test(f));
    const mine = [];
    for (const f of tests) mine.push(await vp.check(me, to24(path.join(userDir, "laptop", f)).subarray(0, 4000 * 48), {}));
    const acc = mine.filter((r) => r.verdict === "accept").length;
    const notRejected = mine.filter((r) => r.verdict !== "reject").length;
    check(`your real phrases: ${acc} of ${mine.length} accepted, none rejected`, acc >= mine.length - 2 && notRejected === mine.length, JSON.stringify(mine.map((r) => [r.verdict, r.score])));
    const others = [];
    const pub = "/root/.local/mint-voiceprint/data/public/cv-ar";
    const pubEn = "/root/.local/mint-voiceprint/data/public/cv-en";
    for (const d of [pub, pubEn]) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).slice(0, 15)) others.push(await vp.check(me, to24(path.join(d, f)), {}));
    }
    const pass = others.filter((r) => r.verdict === "accept").length;
    check(`other people (Common Voice, ${others.length} clips): ${pass} accepted`, others.length === 0 || pass <= 1, JSON.stringify(others.map((r) => r.score)));
    const echoDir = "/root/.local/mint-voiceprint/data/echo";
    if (fs.existsSync(echoDir)) {
      const files = fs.readdirSync(echoDir).filter((f) => /marin\.wav$/.test(f));
      for (const f of files.slice(0, 3)) await vp.learnTts("marin", to24(path.join(echoDir, f))).catch(() => {}), await sleep(0);
      // learnTts is rate-limited to one a minute: seed the rest straight from the service
      const echoes = [];
      for (const f of files.slice(3)) echoes.push(await vp.check(me, to24(path.join(echoDir, f)), { overVoice: true, voice: "marin" }));
      const through = echoes.filter((r) => r.verdict === "accept").length;
      check(`MINT AI's real TTS voice over its playback (${echoes.length} lines): none accepted; ${echoes.filter((r) => r.verdict === "echo").length} flagged as echo`, through === 0, JSON.stringify(echoes.map((r) => [r.verdict, r.score, r.tts_score])));
    }
    const ms = mine.map((r) => r.ms).sort((a, b) => a - b);
    const sv = mine.map((r) => r.svc_ms).sort((a, b) => a - b);
    const med = (a) => a[Math.floor(a.length / 2)];
    // ~60 ms is the aim on a quiet box; the guard here is looser, the box runs other work.
    check(`the check takes ${med(ms)} ms (median round trip; ${med(sv)} ms in the service, 4 threads; p90 ${ms[Math.floor(ms.length * 0.9)]} ms) — under 100 ms`, med(ms) < 100, JSON.stringify(ms));
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-svc-"));
  const sock = path.join(sockDir, "fake.sock");
  const fake = await startFakeService(sock);
  try {
    await library(sock);
    await relay(sock);
    await routes(sock);
    await real();
  } catch (x) {
    failed++;
    console.log("  FAIL no exception\n" + x.stack);
  } finally {
    fake.close();
    mockServer.close();
    fs.rmSync(sockDir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
