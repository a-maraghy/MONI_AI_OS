#!/usr/bin/env node
"use strict";
/**
 * Tests for the OpenAI voice: lib/voice.js against a mock OpenAI, the helper's
 * key storage, and the views' no-key state.
 *
 *   node dashboard/tools/test-voice.cjs
 *
 * The mock speaks the two protocols lib/voice.js implements -- the Realtime API
 * (session.update / conversation.item.create / response.create, audio back as
 * response.output_audio.delta) and GPT-Live (session.start, commentary with
 * delegation_id: null, audio only while silence frames arrive) -- plus the
 * transcription endpoint. It can be told to read faithfully, to improvise, to
 * refuse the key, to not know the model, or to hang.
 *
 * The helper part loads deploy/moni-helper as a Python module with its voice
 * file pointed into a temp directory, so nothing on the machine is touched.
 * No real key is used anywhere: the keys below are made up.
 *
 * .cjs because it uses require. Needs `ws` on NODE_PATH and python3.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const { WebSocketServer } = require("ws");

const ROOT = path.join(__dirname, "..");
const voice = require(path.join(ROOT, "lib", "voice.js"));
const views = require(path.join(ROOT, "lib", "views-moniai.js"));
const consoleViews = require(path.join(ROOT, "lib", "views-console.js"));
const credViews = require(path.join(ROOT, "lib", "views-credentials.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));

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

const GOOD = "sk-proj-" + "T".repeat(40) + "good";
const BAD = "sk-proj-" + "B".repeat(40) + "nope";

/* ---------------------------------------------------------------- mock --- */

const mock = {
  mode: "faithful", // faithful | improvise | improvise-once | answer | model-error | hang | handshake-401
  connections: 0,
  log: [], // per connection: { url, headers, events: [], closedEarly }
  heard: null, // the last text "spoken", returned by transcription of a RIFF upload
  transcriptions: [],
};

function speechChunk(loud) {
  const b = Buffer.alloc(4800); // 100 ms of PCM16 at 24 kHz
  if (loud) for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 === 0 ? 6000 : -6000, i);
  return b.toString("base64");
}

function readingFor(text, conn) {
  if (mock.mode === "improvise" || (mock.mode === "improvise-once" && conn === 1)) {
    return "Sure! " + text + " Is there anything else I can help you with today, or shall I carry on?";
  }
  if (mock.mode === "answer") return "Yes, I restarted it for you a moment ago and everything looks healthy now.";
  return text;
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const auth = req.headers.authorization || "";
      const txt = body.toString("latin1");
      const model = (txt.match(/name="model"\r\n\r\n([^\r]*)/) || [])[1];
      const ctype = (txt.match(/name="file"; filename="([^"]*)"\r\nContent-Type: ([^\r]*)/) || []).slice(1);
      mock.transcriptions.push({ auth, model, filename: ctype[0], type: ctype[1], bytes: body.length });
      res.setHeader("Content-Type", "application/json");
      if (auth !== "Bearer " + GOOD) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-****nope.", code: "invalid_api_key" } }));
      }
      if (model === "gpt-nonexistent-transcribe") {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: { message: "The model does not exist", code: "model_not_found" } }));
      }
      const isWav = txt.includes("RIFF") && txt.includes("WAVE");
      res.end(JSON.stringify({ text: isWav ? mock.heard || "" : "restart the dashboard please" }));
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (mock.mode === "handshake-401") {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" +
        JSON.stringify({ error: { message: "You didn't provide an API key (sk-proj-" + "Z".repeat(30) + ")." } })
    );
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const conn = ++mock.connections;
  const entry = { url: req.url, headers: req.headers, events: [], closedEarly: false, finished: false };
  mock.log.push(entry);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const authed = req.headers.authorization === "Bearer " + GOOD;

  if (req.url.startsWith("/v1/realtime")) {
    if (!authed) {
      // What the real endpoint does: upgrade, then an error event, then close.
      send({ type: "error", error: { type: "invalid_request_error", code: null, message: "Missing bearer or basic authentication in header" } });
      return setTimeout(() => ws.close(), 20);
    }
    send({ type: "session.created", session: {} });
    let text = "";
    ws.on("message", (raw) => {
      const ev = JSON.parse(String(raw));
      entry.events.push(ev);
      if (ev.type === "session.update") send({ type: "session.updated", session: ev.session });
      if (ev.type === "conversation.item.create") text = ev.item.content[0].text;
      if (ev.type === "response.create") {
        if (mock.mode === "model-error") return send({ type: "error", error: { code: "model_not_found", message: "The model gpt-nope does not exist" } });
        if (mock.mode === "hang") return;
        const reading = readingFor(text, conn);
        const parts = reading.match(/\S+\s*/g) || [];
        let i = 0;
        const step = () => {
          if (ws.readyState !== 1) {
            entry.closedEarly = i < parts.length;
            return;
          }
          if (i < parts.length) {
            send({ type: "response.output_audio_transcript.delta", delta: parts[i] });
            send({ type: "response.output_audio.delta", delta: speechChunk(true) });
            i++;
            return setTimeout(step, 5);
          }
          send({ type: "response.output_audio_transcript.done", transcript: reading });
          send({ type: "response.output_audio.done" });
          entry.finished = true;
          mock.heard = reading;
          send({ type: "response.done", response: { status: "completed" } });
        };
        step();
      }
    });
    ws.on("close", () => {
      if (!entry.finished) entry.closedEarly = true;
    });
    return;
  }

  if (req.url.startsWith("/v1/live/sessions")) {
    if (!authed) {
      send({ type: "error", error: { message: "Incorrect API key provided" } });
      return setTimeout(() => ws.close(), 20);
    }
    let text = null;
    let frames = 0;
    let said = 0;
    ws.on("message", (raw) => {
      const ev = JSON.parse(String(raw));
      entry.events.push(ev);
      if (ev.type === "session.start") send({ type: "session.started" });
      if (ev.type === "session.commentary.append") text = ev.content;
      if (ev.type === "session.input_audio.append" && text != null) {
        // It speaks only while it hears: one chunk of output per frame in.
        frames++;
        const words = readingFor(text, conn).split(" ");
        if (said < words.length) {
          send({ type: "session.output_transcript.delta", delta: (said ? " " : "") + words[said] });
          send({ type: "session.output_audio.delta", delta: speechChunk(true) });
          said++;
          if (said === words.length) mock.heard = readingFor(text, conn);
        } else {
          send({ type: "session.output_audio.delta", delta: speechChunk(false) });
        }
      }
    });
    entry.frames = () => frames;
    return;
  }
  ws.close();
});

/* --------------------------------------------------------------- tests --- */

async function expectCode(p, code) {
  try {
    await p;
    return { ok: false, got: "resolved" };
  } catch (e) {
    return { ok: e.code === code, got: e.code + ": " + e.message, e };
  }
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = { httpBase: `http://127.0.0.1:${port}/v1`, wsBase: `ws://127.0.0.1:${port}/v1` };
  const cfg = (extra) => ({ ...base, key: GOOD, model: "gpt-realtime-mini", voice: "marin", transcribe_model: "gpt-4o-mini-transcribe", ...extra });
  const allMessages = [];

  section("verbatim guard");
  const f = voice.faithful;
  check("an exact reading passes", f("The dashboard is up.", "The dashboard is up.").ok);
  check("case and punctuation do not matter", f("Restart it, now!", "restart it now").ok);
  check("numbers read as words pass", f("I found 3 sessions and 12 agents.", "I found three sessions and twelve agents.").ok);
  check("an acronym read letter by letter passes", f("Check the MRP queue.", "Check the M R P queue.").ok);
  check(
    "a continuation is rejected",
    !f("The service restarted.", "The service restarted. Would you like me to check the logs as well, or anything else?").ok
  );
  check("an answer instead of the text is rejected", !f("Do you want me to restart it?", "Yes, I will restart it right away for you.").ok);
  check("a reading that drops half the sentence is rejected", !f("Three sessions are running and two are waiting for approval.", "Three sessions are running.").ok);
  check("an empty reading is rejected", !f("Hello there.", "").ok);
  check("a short ack must be read whole", f("On it.", "On it.").ok && !f("On it.", "Sure thing, working on it now for you.").ok);

  section("wav");
  const w = voice.wav(Buffer.alloc(4800), 24000);
  check("RIFF/WAVE, 16-bit mono 24 kHz, data length right",
    w.slice(0, 4).toString() === "RIFF" && w.slice(8, 12).toString() === "WAVE" &&
    w.readUInt16LE(22) === 1 && w.readUInt32LE(24) === 24000 && w.readUInt16LE(34) === 16 && w.readUInt32LE(40) === 4800);

  section("realtime protocol (gpt-realtime-mini)");
  mock.mode = "faithful";
  let out = await voice.speak("The dashboard is running and every service is healthy.", cfg());
  let conn = mock.log[mock.log.length - 1];
  check("speaks: returns a WAV", Buffer.isBuffer(out.wav) && out.wav.slice(0, 4).toString() === "RIFF" && out.wav.length > 44 + 4800);
  check("one attempt, faithful transcript", out.attempts === 1 && /every service is healthy/.test(out.transcript));
  check("connects to /realtime with the model in the query", conn.url === "/v1/realtime?model=gpt-realtime-mini", conn.url);
  check("the key goes in the Authorization header", conn.headers.authorization === "Bearer " + GOOD);
  check("no Origin header is sent", conn.headers.origin === undefined, conn.headers.origin);
  check("no key in the URL", !conn.url.includes("sk-"));
  const su = conn.events.find((e) => e.type === "session.update");
  check("session.update: realtime, audio only, the chosen voice, PCM 24 kHz",
    su && su.session.type === "realtime" && JSON.stringify(su.session.output_modalities) === '["audio"]' &&
    su.session.audio.output.voice === "marin" && su.session.audio.output.format.rate === 24000, JSON.stringify(su));
  check("instructions tell it to read verbatim and never answer",
    /word for word/.test(su.session.instructions) && /Never answer it/.test(su.session.instructions));
  const item = conn.events.find((e) => e.type === "conversation.item.create");
  check("the text goes in as the user's input_text, untouched",
    item && item.item.content[0].type === "input_text" && item.item.content[0].text === "The dashboard is running and every service is healthy.");
  const rc = conn.events.find((e) => e.type === "response.create");
  check("response.create asks for audio only", rc && JSON.stringify(rc.response.output_modalities) === '["audio"]');

  let before = mock.connections;
  await voice.speak("On it.", cfg());
  const hit = await voice.speak("On it.", cfg());
  check("a short line is cached: the second 'On it.' makes no call", hit.cached === true && mock.connections === before + 1);
  await voice.speak("On it.", cfg({ voice: "cedar" }));
  check("the cache is per voice", mock.connections === before + 2);
  voice.clearCache();
  await voice.speak("On it.", cfg());
  check("clearCache (key or settings changed) forgets it", mock.connections === before + 3);

  section("verbatim guard, live");
  mock.mode = "improvise-once";
  mock.connections = 0;
  out = await voice.speak("I restarted the dashboard.", cfg());
  check("an improvised first reading is thrown away and the second one used", out.attempts === 2 && out.transcript === "I restarted the dashboard.", out.attempts + " " + out.transcript);
  check("the improvising reading was cut short, not paid for to the end", mock.log[mock.log.length - 2].closedEarly === true);

  mock.mode = "improvise";
  let r = await expectCode(voice.speak("The backup finished.", cfg()), "unfaithful");
  check("a voice that keeps improvising: rejected as unfaithful, nothing returned", r.ok, r.got);
  allMessages.push(r.e && r.e.message);
  mock.mode = "answer";
  r = await expectCode(voice.speak("Do you want me to restart the dashboard?", cfg()), "unfaithful");
  check("a voice that answers the question instead of reading it: rejected", r.ok, r.got);

  section("realtime errors");
  mock.mode = "faithful";
  r = await expectCode(voice.speak("Hello.", cfg({ key: BAD })), "auth");
  check("a wrong key (error event after upgrade): code auth", r.ok, r.got);
  allMessages.push(r.e && r.e.message);
  mock.mode = "handshake-401";
  r = await expectCode(voice.speak("Hello.", cfg()), "auth");
  check("a 401 at the handshake: code auth", r.ok, r.got);
  check("the error message never carries a key", r.e && !/sk-proj-Z/.test(r.e.message), r.e && r.e.message);
  allMessages.push(r.e && r.e.message);
  mock.mode = "model-error";
  r = await expectCode(voice.speak("Hello.", cfg({ model: "gpt-realtime-nope" })), "model");
  check("an unknown model: code model", r.ok, r.got);
  mock.mode = "hang";
  r = await expectCode(voice.speak("Hello.", cfg({ timeoutMs: 400 })), "timeout");
  check("no answer: code timeout", r.ok, r.got);
  r = await expectCode(voice.speak("Hello.", { ...base, wsBase: "ws://127.0.0.1:1/v1", key: GOOD, model: "gpt-realtime-mini" }), "network");
  check("unreachable: code network", r.ok, r.got);

  section("GPT-Live protocol (gpt-live-1)");
  mock.mode = "faithful";
  out = await voice.speak("Three sessions are running and none need approval.", cfg({ model: "gpt-live-1" }));
  conn = mock.log[mock.log.length - 1];
  check("connects to /live/sessions", conn.url === "/v1/live/sessions", conn.url);
  check("no Origin header (GPT-Live answers 403 to one)", conn.headers.origin === undefined);
  const start = conn.events.find((e) => e.type === "session.start");
  check("session.start carries model, instructions, PCM 24 kHz and the voice",
    start && start.session.model === "gpt-live-1" && /word for word/.test(start.session.instructions) &&
    start.session.audio.format.rate === 24000 && start.session.audio.output.voice === "marin");
  const com = conn.events.find((e) => e.type === "session.commentary.append");
  check("the text goes in as commentary with delegation_id: null",
    com && Object.prototype.hasOwnProperty.call(com, "delegation_id") && com.delegation_id === null && com.content.startsWith("Three sessions"));
  check("silence frames are streamed so it keeps talking", conn.events.filter((e) => e.type === "session.input_audio.append").length >= 8);
  check("audio comes back trimmed to the speech, faithful",
    out.wav.length > 44 && out.wav.length < 44 + 4800 * 16 && /none need approval/.test(out.transcript), out.wav.length + " " + out.transcript);
  mock.mode = "improvise";
  r = await expectCode(voice.speak("The backup finished.", cfg({ model: "gpt-live-1" })), "unfaithful");
  check("GPT-Live inventing a continuation is caught too", r.ok, r.got);

  section("transcription");
  mock.mode = "faithful";
  const text = await voice.transcribe(Buffer.from("webm-bytes"), cfg(), "audio/webm");
  const t = mock.transcriptions[mock.transcriptions.length - 1];
  check("returns the text", text === "restart the dashboard please", text);
  check("posts the configured model and the recording with its type",
    t.model === "gpt-4o-mini-transcribe" && t.type === "audio/webm" && t.filename === "speech.webm", JSON.stringify(t));
  check("with the key as a bearer token", t.auth === "Bearer " + GOOD);
  await voice.transcribe(Buffer.from("x"), cfg({ transcribe_model: "gpt-4o-transcribe" }), "audio/ogg;codecs=opus");
  const t2 = mock.transcriptions[mock.transcriptions.length - 1];
  check("the listening model is a setting; an odd mime falls back to webm", t2.model === "gpt-4o-transcribe" && t2.type === "audio/webm", JSON.stringify(t2));
  r = await expectCode(voice.transcribe(Buffer.from("x"), cfg({ key: BAD })), "auth");
  check("a wrong key: code auth", r.ok, r.got);
  check("OpenAI's masked key is scrubbed from the message too", r.e && !/sk-proj-\*/.test(r.e.message), r.e && r.e.message);
  allMessages.push(r.e && r.e.message);
  r = await expectCode(voice.transcribe(Buffer.from("x"), cfg({ transcribe_model: "gpt-nonexistent-transcribe" })), "model");
  check("an unknown model: code model", r.ok, r.got);
  r = await expectCode(voice.transcribe(Buffer.alloc(0), cfg()), "invalid");
  check("no audio: refused before any call", r.ok, r.got);

  section("no key");
  before = mock.connections;
  const nt = mock.transcriptions.length;
  r = await expectCode(voice.speak("Hello.", { ...base, key: null }), "no-key");
  check("speak without a key: code no-key, says where to add one", r.ok && /Add an OpenAI key in Settings/.test(r.e.message), r.got);
  r = await expectCode(voice.transcribe(Buffer.from("x"), { ...base, key: "" }), "no-key");
  check("transcribe without a key: code no-key", r.ok, r.got);
  check("and neither made a call", mock.connections === before && mock.transcriptions.length === nt);

  section("Settings > Test (a tiny live round trip)");
  mock.mode = "faithful";
  before = mock.connections;
  let c = await voice.check(cfg());
  check("speaks a line and transcribes that audio back", c.faithful === true && /Voice check/.test(c.heard) && c.seconds > 0, JSON.stringify(c));
  c = await voice.check(cfg());
  check("never answered from the cache", mock.connections === before + 2);
  r = await expectCode(voice.check(cfg({ key: BAD })), "auth");
  check("a wrong key: the error comes back", r.ok, r.got);

  section("the key never appears in any message");
  check("no error message contains a key", allMessages.every((m) => m && !m.includes(GOOD) && !m.includes(BAD) && !/sk-proj-[A-Za-z0-9]{8}/.test(m)), allMessages.join(" | "));
  check("scrub() masks keys and bearer tokens", voice.scrub("key sk-proj-abcdefgh1234 and Bearer xyz") === "key sk-… and Bearer …");

  section("helper: key storage");
  helperTests();

  section("views: the no-key state");
  viewTests();

  wss.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

/* ------------------------------------------------------------- helper --- */

function helperTests() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "voice-test-"));
  const driver = `
import importlib.machinery, importlib.util, io, json, os, sys, contextlib
spec = importlib.util.spec_from_loader("moni_helper", importlib.machinery.SourceFileLoader("moni_helper", sys.argv[1]))
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
tmp = sys.argv[2]
H.VOICE_DIR = os.path.join(tmp, "moni-voice")
H.VOICE_FILE = os.path.join(H.VOICE_DIR, "openai-voice.env")
H.AUDIT_LOG = os.path.join(tmp, "audit.log")
def call(name, args=(), stdin=None):
    out = io.StringIO()
    if stdin is not None:
        sys.stdin = io.TextIOWrapper(io.BytesIO(stdin.encode()))
    with contextlib.redirect_stdout(out):
        try:
            H.COMMANDS[name](list(args))
        except SystemExit:
            pass
    return out.getvalue().strip().splitlines()[-1]
res = {}
res["status0"] = call("voice-status")
res["set_bad"] = call("voice-key-set", stdin="not-a-key")
res["set_ant"] = call("voice-key-set", stdin="sk-ant-api03-" + "A"*40)
res["set_nl"] = call("voice-key-set", stdin="sk-proj-" + "A"*30 + "\\nX=1")
res["set_ok"] = call("voice-key-set", stdin=sys.argv[3] + "\\n")
st = os.stat(H.VOICE_FILE); dst = os.stat(H.VOICE_DIR)
res["mode"] = oct(st.st_mode & 0o777); res["dirmode"] = oct(dst.st_mode & 0o777); res["uid"] = st.st_uid
res["status1"] = call("voice-status")
res["read"] = call("voice-key-read")
res["opt_bad"] = call("voice-options-set", ["gpt-4o", "marin", "gpt-4o-mini-transcribe"])
res["opt_bad2"] = call("voice-options-set", ["gpt-realtime", "Marin;rm", "gpt-4o-mini-transcribe"])
res["opt_ok"] = call("voice-options-set", ["gpt-live-1", "cedar", "gpt-4o-transcribe"])
res["status2"] = call("voice-status")
res["file_after_opts"] = open(H.VOICE_FILE).read()
res["clear"] = call("voice-key-clear")
res["status3"] = call("voice-status")
res["file_after_clear"] = open(H.VOICE_FILE).read()
res["audit"] = open(H.AUDIT_LOG).read()
res["no_argv_key"] = "voice-key-set" in H.COMMANDS and H.cmd_voice_key_set.__code__.co_argcount == 1
print(json.dumps(res))
`;
  const run = spawnSync("python3", ["-c", driver, path.join(ROOT, "deploy", "moni-helper"), TMP, GOOD], { encoding: "utf8" });
  let res;
  try {
    res = JSON.parse(run.stdout.trim().split("\n").pop());
  } catch (e) {
    check("the helper driver ran", false, run.stderr || run.stdout);
    return;
  }
  const J = (s) => JSON.parse(s);
  check("no key yet: not configured, defaults shown", J(res.status0).data.configured === false && J(res.status0).data.model === "gpt-realtime-mini" && J(res.status0).data.voice === "marin");
  check("refuses something that is not an OpenAI key", J(res.set_bad).ok === false);
  check("refuses an Anthropic key with a clear reason", J(res.set_ant).ok === false && /Anthropic/.test(J(res.set_ant).error));
  check("refuses a value with a newline (no second variable smuggled in)", J(res.set_nl).ok === false);
  check("stores a real-looking key", J(res.set_ok).ok === true && J(res.set_ok).data.last4 === "good");
  check("the set reply does not echo the key", !res.set_ok.includes(GOOD));
  check("file is 0600, directory 0700, owned by root", res.mode === "0o600" && res.dirmode === "0o700" && res.uid === 0, res.mode + " " + res.dirmode + " " + res.uid);
  const s1 = J(res.status1).data;
  check("status: configured, last four only", s1.configured === true && s1.last4 === "good" && s1.length === GOOD.length);
  check("status never contains the key", !res.status1.includes(GOOD) && !res.status1.includes(GOOD.slice(0, 20)));
  check("key-read returns it (for the panel's own process)", J(res.read).data.key === GOOD);
  check("options: refuses a non-realtime model", J(res.opt_bad).ok === false);
  check("options: refuses a malformed voice", J(res.opt_bad2).ok === false);
  check("options: model, voice and listening model saved", J(res.opt_ok).ok && J(res.status2).data.model === "gpt-live-1" && J(res.status2).data.voice === "cedar" && J(res.status2).data.transcribe_model === "gpt-4o-transcribe");
  check("saving options keeps the key", res.file_after_opts.includes("OPENAI_API_KEY=" + GOOD));
  check("remove: not configured, key gone from the file, options kept",
    J(res.status3).data.configured === false && !res.file_after_clear.includes(GOOD) && res.file_after_clear.includes("OPENAI_VOICE_MODEL=gpt-live-1"));
  check("audited: set, options and clear, with the last four only",
    /voice-key-set/.test(res.audit) && /voice-options-set/.test(res.audit) && /voice-key-clear/.test(res.audit) && !res.audit.includes(GOOD) && /"last4": "good"/.test(res.audit));
  check("the key is taken on stdin, never argv", res.no_argv_key === true);
  fs.rmSync(TMP, { recursive: true, force: true });
}

/* -------------------------------------------------------------- views --- */

function viewTests() {
  const user = { name: "Tester", username: "tester", perm: rbac.actor({ permissions: ["*"] }) };
  const off = views.page({ csrf: "c", user, voice: { configured: false, manage: true, voice: "marin" } });
  check("Command Center without a key: 'Add an OpenAI key in Settings', linked", /Add an OpenAI key in Settings/.test(off) && /href="\/credentials\/openai-voice"/.test(off));
  check("  both mic buttons disabled, voice-ready flag off",
    /id="cc-mic-big"[^>]*disabled/.test(off) && /id="cc-c-mic"[^>]*disabled/.test(off) && /data-voice-ready=""/.test(off));
  const offNoManage = views.page({ csrf: "c", user, voice: { configured: false, manage: false } });
  check("  someone who cannot manage it is told to ask an administrator, with no link", /ask an administrator/.test(offNoManage) && !/href="\/credentials\/openai-voice"/.test(offNoManage));
  const on = views.page({ csrf: "c", user, voice: { configured: true, manage: true, voice: "marin", model: "gpt-realtime-mini" } });
  check("with a key: mic enabled, OpenAI and the voice named, no setup prompt",
    !/id="cc-mic-big"[^>]*disabled/.test(on) && /data-voice-ready="1"/.test(on) && />OpenAI</.test(on) && />marin</.test(on) && !/Add an OpenAI key/.test(on));
  check("no Whisper or Piper left on the page", !/Whisper|Piper/i.test(on + off));

  const session = { id: 7, access: "full", cwd: "/", model: "claude-opus-5", effort: "medium", mode: "auto", title: "t", root_on: 1 };
  let cOff = "";
  try {
    cOff = consoleViews.console({ csrf: "c", user, sessions: [], session, messages: [], dirs: ["/"], voice: { configured: false, manage: true } });
  } catch (e) {
    cOff = "render failed: " + e.message;
  }
  check("console without a key: Live and dictation disabled, says where to add one",
    /id="chat-live"[^>]*disabled/.test(cOff) && /id="chat-mic"[^>]*disabled/.test(cOff) && /Add an OpenAI key in Settings/.test(cOff), cOff.slice(0, 200));
  let cOn = "";
  try {
    cOn = consoleViews.console({ csrf: "c", user, sessions: [], session, messages: [], dirs: ["/"], voice: { configured: true, voice: "marin" } });
  } catch (e) {
    cOn = "render failed: " + e.message;
  }
  check("console with a key: Live enabled, no Piper voice picker", /id="chat-live"/.test(cOn) && !/id="chat-live"[^>]*disabled/.test(cOn) && !/chat-voice"/.test(cOn));

  const status = { configured: true, last4: "good", length: GOOD.length, model: "gpt-realtime-mini", voice: "marin", transcribe_model: "gpt-4o-mini-transcribe", path: "/var/lib/moni-voice/openai-voice.env", mode: "0o600" };
  const page = credViews.voice({ csrf: "c", user, voice: status, models: voice.MODELS, voices: voice.VOICES, transcribeModels: voice.TRANSCRIBE_MODELS });
  check("Settings: masked to the last four, with Replace, Remove and Test",
    /••••good/.test(page) && /Replace key/.test(page) && /Remove key/.test(page) && /id="voice-test"/.test(page));
  check("Settings: the key field is a write-only password input, empty", /<input name="value" type="password"[^>]*required/.test(page) && !/value="sk-/.test(page));
  check("Settings: model, voice and listening model selectors, current ones selected",
    /<option value="gpt-realtime-mini" selected>/.test(page) && /<option value="marin" selected>/.test(page) && /<option value="gpt-4o-mini-transcribe" selected>/.test(page) && /gpt-live-1/.test(page));
  const pageOff = credViews.voice({ csrf: "c", user, voice: { ...status, configured: false, last4: null, length: 0 }, models: voice.MODELS, voices: voice.VOICES, transcribeModels: voice.TRANSCRIBE_MODELS });
  check("Settings without a key: no Test or Remove, 'Save key'", !/id="voice-test"/.test(pageOff) && !/Remove key/.test(pageOff) && /Save key/.test(pageOff));
  const failed = credViews.voice({ csrf: "c", user, voice: status, models: voice.MODELS, voices: voice.VOICES, transcribeModels: voice.TRANSCRIBE_MODELS, test: { ok: false, text: "OpenAI refused the key <x>" } });
  check("Settings: a failed test is shown, escaped", /Test failed/.test(failed) && /&lt;x&gt;/.test(failed));

  check("rbac: voice.manage exists and is in no stock role",
    rbac.PERMISSION_SET.has("voice.manage") && rbac.SYSTEM_ROLES.filter((r) => r.name !== "administrator").every((r) => !r.permissions.includes("voice.manage")));
  check("rbac: the administrator holds it", rbac.actor({ permissions: ["*"] }).can("voice.manage"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
