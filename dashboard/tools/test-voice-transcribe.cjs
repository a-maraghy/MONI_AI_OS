#!/usr/bin/env node
"use strict";
/**
 * The transcription choice (MINT AI ▸ Settings ▸ Voice ▸ Transcription,
 * 2026-09-30): lib/voice-transcribe.js -- the list, the OpenAI path, the local
 * whisper.cpp backend and its fallback -- the guards over what whisper writes,
 * and the helper's voice-whisper-* commands. No real OpenAI and no real
 * whisper-server: both are mocks on 127.0.0.1. The real ffmpeg converts the
 * recordings (it is what the backend runs).
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-voice-transcribe.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const T = require(path.join(ROOT, "lib", "voice-transcribe.js"));
const voice = require(path.join(ROOT, "lib", "voice.js"));
const guard = require(path.join(ROOT, "lib", "voice-guard.js"));
const usage = require(path.join(ROOT, "lib", "voice-usage.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 500) : ""));
  }
}
function section(t) {
  console.log("\n" + t);
}

const KEY = "sk-proj-" + "T".repeat(40) + "fake";

/* A 1.5 s 440 Hz tone as a 24 kHz WAV (what a live call hands over). */
function tone(seconds, rate) {
  const r = rate || 24000;
  const n = Math.round(seconds * r);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / r) * 8000), i * 2);
  return voice.wav(pcm, r);
}

/* ------------------------------------------------------------ mocks -- */

const seen = { openai: [], whisper: [] };
const field = (txt, name) => (txt.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`)) || [])[1];
const openai = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const txt = Buffer.concat(chunks).toString("latin1");
    seen.openai.push({ url: req.url, model: field(txt, "model"), language: field(txt, "language"), auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ text: "restart the dashboard please", usage: { type: "tokens", input_tokens: 32, input_token_details: { text_tokens: 0, audio_tokens: 32 }, output_tokens: 6 } }));
  });
});
const whisper = { answer: "Restart the dashboard.", delay: 0, status: 200 };
const local = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const txt = body.toString("latin1");
    const wavAt = txt.indexOf("RIFF");
    const rate = wavAt >= 0 ? body.readUInt32LE(wavAt + 24) : null;
    seen.whisper.push({
      url: req.url,
      language: field(txt, "language"),
      temperature: field(txt, "temperature"),
      temperature_inc: field(txt, "temperature_inc"),
      audio_ctx: field(txt, "audio_ctx"),
      prompt: field(txt, "prompt"),
      rate,
      channels: wavAt >= 0 ? body.readUInt16LE(wavAt + 22) : null,
    });
    setTimeout(() => {
      res.statusCode = whisper.status;
      res.setHeader("Content-Type", "application/json");
      res.end(whisper.status === 200 ? JSON.stringify({ text: whisper.answer }) : JSON.stringify({ error: "failed to process audio" }));
    }, whisper.delay);
  });
});

(async () => {
  await new Promise((r) => openai.listen(0, "127.0.0.1", r));
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const httpBase = "http://127.0.0.1:" + openai.address().port + "/v1";
  const whisperUrl = "http://127.0.0.1:" + local.address().port;
  const logs = [];
  const cfg = (x) => ({ key: KEY, httpBase, whisperUrl, log: (m) => logs.push(m), ...(x || {}) });
  const clip = tone(1.5);

  section("the list");
  const ids = T.TRANSCRIBERS.map((t) => t.id);
  check("five options: three OpenAI, two on this server; the default is gpt-4o-mini-transcribe", ids.join() === "gpt-4o-mini-transcribe,gpt-transcribe,gpt-4o-transcribe,whisper-large-v3-turbo,whisper-small" && T.DEFAULT_ID === "gpt-4o-mini-transcribe", ids.join());
  check("every option carries a hint with its measured figures or price, a label, a group and a known kind", T.TRANSCRIBERS.every((t) => t.hint && t.label && t.group && T.BACKENDS[t.kind]));
  check("  the local ones name their speed, accuracy and cost; each has a hard timeout and a measured minimum audio context", T.TRANSCRIBERS.filter((t) => t.kind === "whisper").every((t) => /s/.test(t.hint) && /CER/.test(t.hint) && /free/.test(t.hint) && t.timeoutMs > 0 && t.ctxMin > 0));
  check("clean(): nothing stored is the default and Detect; unknown values read as those", JSON.stringify(T.clean(null)) === '{"model":"gpt-4o-mini-transcribe","language":"auto"}' && JSON.stringify(T.clean({ model: "whisper-1", language: "fr" })) === '{"model":"gpt-4o-mini-transcribe","language":"auto"}' && T.clean({ model: "whisper-small", language: "ar" }).model === "whisper-small");
  check("the live session's own model is always OpenAI's: gpt-4o-transcribe kept, gpt-transcribe and the local ones fall back to gpt-4o-mini-transcribe",
    T.sessionModelFor("gpt-4o-transcribe") === "gpt-4o-transcribe" && T.sessionModelFor("gpt-4o-mini-transcribe") === "gpt-4o-mini-transcribe" && T.sessionModelFor("gpt-transcribe") === "gpt-4o-mini-transcribe" && T.sessionModelFor("whisper-large-v3-turbo") === "gpt-4o-mini-transcribe");
  check("a hand-off waits longer for a local model (its timeout + 3 s), as before for OpenAI's", T.heardWaitMs("whisper-large-v3-turbo") === 28000 && T.heardWaitMs("whisper-small") === 13000 && T.heardWaitMs("gpt-4o-mini-transcribe") === null);
  check("audio context: sized to the clip, never below the measured minimum, the whole window for a long clip", T.audioCtx(3, 768) === 768 && T.audioCtx(3, 512) === 512 && T.audioCtx(14, 768) === 768 && T.audioCtx(20, 768) === 1088 && T.audioCtx(29, 768) === 0 && T.audioCtx(5, 0) === 0);

  section("OpenAI models");
  seen.openai.length = 0;
  let r = await T.transcribeFull(clip, cfg({ transcriber: "gpt-transcribe" }), "audio/wav");
  check("gpt-transcribe: posted to /audio/transcriptions with that model; the result names it, with its usage and time", seen.openai[0] && seen.openai[0].model === "gpt-transcribe" && r.transcriber === "gpt-transcribe" && r.model === "gpt-transcribe" && r.tokens && r.tokens.audio_in === 32 && typeof r.ms === "number", JSON.stringify([seen.openai[0], r]));
  check("  no language sent on Detect (as before the setting)", seen.openai[0].language === undefined);
  await T.transcribeFull(clip, cfg({ transcriber: "gpt-4o-mini-transcribe", transcribe_language: "ar" }), "audio/wav");
  check("  a pinned language goes with it", seen.openai[1] && seen.openai[1].language === "ar" && seen.openai[1].model === "gpt-4o-mini-transcribe");
  await T.transcribeFull(clip, cfg({}), "audio/wav");
  check("  nothing chosen: gpt-4o-mini-transcribe", seen.openai[2] && seen.openai[2].model === "gpt-4o-mini-transcribe");
  check("gpt-transcribe is priced (per minute, from its audio tokens)", usage.costOf({ audio_in: 600 }, "gpt-transcribe") > 0 && Math.abs(usage.costOf({ audio_in: 600 }, "gpt-transcribe") - 0.0045) < 1e-9 && Math.abs(usage.costOf({ seconds: 60 }, "gpt-transcribe") - 0.0045) < 1e-9);

  section("whisper.cpp on this server (mock server, real ffmpeg)");
  seen.openai.length = 0;
  seen.whisper.length = 0;
  whisper.answer = "Restart the dashboard.";
  r = await T.transcribeFull(clip, cfg({ transcriber: "whisper-small" }), "audio/wav");
  const w0 = seen.whisper[0] || {};
  check("a turn goes to the local server's /inference, as 16 kHz mono WAV", w0.url === "/inference" && w0.rate === 16000 && w0.channels === 1, JSON.stringify(w0));
  check("  temperature 0 with no temperature fallback (the loop that ran away on noise), Detect as 'auto', no vocabulary prompt", w0.temperature === "0" && w0.temperature_inc === "0" && w0.language === "auto" && w0.prompt === undefined);
  check("  an audio context sized to the clip (small's minimum, 512, for 1.5 s)", w0.audio_ctx === "512");
  check("  the text comes back as the local model's, nothing billed, OpenAI never called", r.text === "Restart the dashboard." && r.transcriber === "whisper-small" && r.model === "whisper-small" && r.tokens === null && r.local === true && !r.fallback && seen.openai.length === 0, JSON.stringify(r));
  check("  its usage carries the clip's length (the guard's words-per-second check uses it)", r.usage && r.usage.type === "duration" && Math.abs(r.usage.seconds - 1.5) < 0.05 && Math.abs(guard.audioSecondsFromUsage(r.usage) - 1.5) < 0.05);
  await T.transcribeFull(clip, cfg({ transcriber: "whisper-large-v3-turbo", transcribe_language: "ar" }), "audio/wav");
  check("turbo: a pinned language, and its own minimum audio context (768)", seen.whisper[1] && seen.whisper[1].language === "ar" && seen.whisper[1].audio_ctx === "768");
  const webm = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=1", "-c:a", "libopus", "-f", "webm", "pipe:1"], { maxBuffer: 1 << 22 });
  if (webm.status === 0 && webm.stdout.length) {
    r = await T.transcribeFull(webm.stdout, cfg({ transcriber: "whisper-small" }), "audio/webm");
    check("a browser recording (webm/opus) is converted too", r.text === "Restart the dashboard." && seen.whisper[2] && seen.whisper[2].rate === 16000);
  } else check("(ffmpeg could make a webm to test with)", false, webm.stderr && webm.stderr.toString());

  whisper.answer = "[BLANK_AUDIO] Restart the dashboard. *thud*";
  r = await T.transcribeFull(clip, cfg({ transcriber: "whisper-small" }), "audio/wav");
  check("markers are taken out of a transcript: '[BLANK_AUDIO] … *thud*'", r.text === "Restart the dashboard." && !r.fallback, JSON.stringify(r.text));
  for (const m of ["", "[BLANK_AUDIO]", " *thud* ", "(static)", "♪ ♪"]) {
    whisper.answer = m;
    r = await T.transcribeFull(clip, cfg({ transcriber: "whisper-small" }), "audio/wav");
    check(`  VAD / markers only (${JSON.stringify(m)}): an empty transcript, no fallback (silence is not an error)`, r.text === "" && !r.fallback && seen.openai.length === 0, JSON.stringify(r));
  }

  section("fallback to gpt-4o-mini-transcribe, logged");
  const fallback = async (name, setup, why) => {
    seen.openai.length = 0;
    logs.length = 0;
    setup();
    const out = await T.transcribeFull(clip, cfg({ transcriber: "whisper-small", localTimeoutMs: 400, ...(name.cfg || {}) }), "audio/wav");
    check(`${name.label}: the turn is heard by gpt-4o-mini-transcribe, and the result says why`, out.text === "restart the dashboard please" && out.transcriber === "gpt-4o-mini-transcribe" && out.fallback && out.fallback.from === "whisper-small" && why.test(out.fallback.why) && seen.openai.length === 1 && seen.openai[0].model === "gpt-4o-mini-transcribe", JSON.stringify(out));
    check(`  logged, without the words`, logs.length === 1 && /voice transcribe: whisper-small failed/.test(logs[0]) && /falling back to gpt-4o-mini-transcribe/.test(logs[0]) && !/restart the dashboard|thank you/i.test(logs[0]), logs.join(" | "));
    whisper.delay = 0;
    whisper.status = 200;
  };
  for (const [label, text, why] of [
    ["'you' (whisper's word for silence)", "you", /junk:stock-phrase/],
    ["'Thank you.'", " Thank you.", /junk:stock-phrase/],
    ["a subtitle credit (Arabic)", "ترجمة نانسي قنقر", /junk:stock-phrase/],
    ["a loop", "go to the go to the go to the go to the go to the go to the", /junk:loop/],
    ["more words than 1.5 s can hold", "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", /junk:too-many-words/],
    ["garbled text", "Rest�rt", /junk:garbled/],
  ]) await fallback({ label: "junk: " + label }, () => (whisper.answer = text), why);
  await fallback({ label: "the server answers an error" }, () => (whisper.status = 500), /upstream/);
  await fallback({ label: "the server takes too long (hard timeout)" }, () => ((whisper.answer = "late"), (whisper.delay = 1500)), /timeout/);
  await fallback({ label: "the server is down", cfg: { whisperUrl: "http://127.0.0.1:1" } }, () => {}, /down/);
  await fallback({ label: "ffmpeg cannot read the recording", cfg: { ffmpeg: "/bin/false" } }, () => {}, /ffmpeg/);
  seen.openai.length = 0;
  let noKey = null;
  try {
    await T.transcribeFull(clip, { whisperUrl: "http://127.0.0.1:1", log: () => {}, transcriber: "whisper-small" }, "audio/wav");
  } catch (e) {
    noKey = e;
  }
  check("no key to fall back on: an error that says so (no OpenAI call)", noKey && /no OpenAI key to fall back on/.test(noKey.message) && seen.openai.length === 0, noKey && noKey.message);
  whisper.answer = "Restart the dashboard.";
  r = await T.transcribeFull(clip, { transcriber: "whisper-small", whisperUrl, log: () => {} }, "audio/wav");
  check("  but a local model works without a key", r.text === "Restart the dashboard.");

  section("the settings Test: which model answered, and how long it took");
  {
    let spokenTo = null;
    const fakeCheck = await voice
      .check({ key: KEY, httpBase: "http://127.0.0.1:1/v1", wsBase: "ws://127.0.0.1:1/v1" }, { transcribe: async (a, c) => ((spokenTo = c), { text: "x", transcriber: "whisper-small" }) })
      .catch((e) => ({ err: e.code }));
    check("voice.check takes the selected transcriber (here the speaking half fails first: no transcription without audio)", fakeCheck.err === "network" && spokenTo === null, JSON.stringify(fakeCheck));
    const src = fs.readFileSync(path.join(ROOT, "lib", "voice.js"), "utf8");
    check("  and reports heard_by (the model that answered) and a fallback", /out\.heard_by = heard\.transcriber/.test(src) && /out\.heard_fallback = heard\.fallback/.test(src));
    const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    check("  the Test route names it: 'transcription by <model> … heard … in N ms'", /voice\.check\(\{ \.\.\.cfg, model: cfg\.live_model \}, \{ transcribe: voiceTranscribe\.transcribeFull \}\)/.test(server) && /transcription by \$\{out\.heard_by\}/.test(server) && /in \$\{out\.transcribe_ms\} ms/.test(server));
    check("the live call and dictation use the selected transcriber; a live hand-off waits heard_wait_ms", /transcribe: voiceTranscribe\.transcribeFull, \/\/ the full-turn transcript/.test(server) && /transcribe: voiceTranscribe\.transcribeFull,\n\s+grounds: voiceGrounds/.test(server) && /heard_wait_ms/.test(fs.readFileSync(path.join(ROOT, "lib", "voice-live.js"), "utf8")));
  }

  section("the transcript guard over what whisper writes");
  for (const t of ["*thud*", "[BLANK_AUDIO]", "(static)", "♪", "♪ ♪", "<|nospeech|>"]) {
    const g = guard.checkTranscript(t, { audioSeconds: 4 });
    check(`dropped: ${JSON.stringify(t)} (noise-label)`, !g.ok && g.rule === "noise-label", JSON.stringify(g));
  }
  for (const t of ["you", "Thank you.", "Thanks for watching!"]) {
    const g = guard.checkTranscript(t, { audioSeconds: 0.8 });
    check(`dropped on a short clip: ${JSON.stringify(t)}`, !g.ok, JSON.stringify(g));
  }
  for (const t of ["عايزك تعمل ريستارت للداشبورد بعد ما تشيك على الديسك يوزج", "اعمل ريستارت للداشبورد دلوقتي", "Restart it (now), please."]) {
    const g = guard.checkTranscript(t, { audioSeconds: 5 });
    check(`kept: ${t}`, g.ok, JSON.stringify(g));
  }
  check("stripMarkers leaves words alone", guard.stripMarkers("Restart the dashboard.") === "Restart the dashboard." && guard.stripMarkers("[Music] hi *cough* there ♪") === "hi there");

  section("helper: voice-whisper-status / voice-whisper-set (systemctl stubbed)");
  helperTests();

  local.close();
  openai.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("CRASH " + e.stack);
  process.exit(1);
});

function helperTests() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "voice-whisper-test-"));
  const driver = `
import importlib.machinery, importlib.util, io, json, os, sys, contextlib, types
spec = importlib.util.spec_from_loader("moni_helper", importlib.machinery.SourceFileLoader("moni_helper", sys.argv[1]))
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
tmp = sys.argv[2]
H.WHISPER_DIR = os.path.join(tmp, "w")
H.WHISPER_MODELS_DIR = os.path.join(H.WHISPER_DIR, "models")
H.WHISPER_BIN = os.path.join(H.WHISPER_DIR, "bin", "whisper-server")
H.WHISPER_ENV = os.path.join(H.WHISPER_DIR, "server.env")
H.WHISPER_VAD = os.path.join(H.WHISPER_MODELS_DIR, "ggml-silero-v5.1.2.bin")
H.AUDIT_LOG = os.path.join(tmp, "audit.log")
H.VOICE_DIR = os.path.join(tmp, "moni-voice")
H.VOICE_FILE = os.path.join(H.VOICE_DIR, "openai-voice.env")
state = {"active": "inactive", "enabled": "disabled"}
calls = []
def fake_run(argv, **kw):
    calls.append(" ".join(argv))
    out = ""
    if argv[:2] == ["systemctl", "is-active"]: out = state["active"]
    elif argv[:2] == ["systemctl", "is-enabled"]: out = state["enabled"]
    elif argv[:2] == ["systemctl", "enable"]: state["enabled"] = "enabled"
    elif argv[:2] == ["systemctl", "restart"]: state["active"] = "active"
    elif argv[:3] == ["systemctl", "disable", "--now"]: state.update(active="inactive", enabled="disabled")
    return types.SimpleNamespace(returncode=0, stdout=out + "\\n", stderr="")
H.run = fake_run
def call(name, args=()):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            H.COMMANDS[name](list(args))
        except SystemExit:
            pass
    return json.loads(out.getvalue().strip().splitlines()[-1])
res = {}
res["status0"] = call("voice-whisper-status")
res["set_uninstalled"] = call("voice-whisper-set", ["small-q8_0"])
os.makedirs(os.path.join(H.WHISPER_DIR, "bin")); os.makedirs(H.WHISPER_MODELS_DIR)
open(H.WHISPER_BIN, "w").write("x"); open(H.WHISPER_VAD, "w").write("x")
open(os.path.join(H.WHISPER_MODELS_DIR, "ggml-small-q8_0.bin"), "w").write("x" * 10)
res["status1"] = call("voice-whisper-status")
res["set_missing_model"] = call("voice-whisper-set", ["large-v3-turbo-q8_0"])
res["set_bad"] = call("voice-whisper-set", ["../../etc/passwd"])
res["set_vad"] = call("voice-whisper-set", ["silero-v5.1.2"])
n0 = len(calls)
res["set_ok"] = call("voice-whisper-set", ["small-q8_0"])
res["env"] = open(H.WHISPER_ENV).read()
res["env_mode"] = oct(os.stat(H.WHISPER_ENV).st_mode & 0o777)
res["calls_set"] = calls[n0:]
n1 = len(calls)
res["set_again"] = call("voice-whisper-set", ["small-q8_0"])
res["calls_again"] = calls[n1:]
n2 = len(calls)
res["off"] = call("voice-whisper-set", ["off"])
res["calls_off"] = calls[n2:]
res["opt_gpt_transcribe"] = call("voice-options-set", ["gpt-realtime-2.1-mini", "marin", "gpt-transcribe"])
res["opt_whisper"] = call("voice-options-set", ["gpt-realtime-2.1-mini", "marin", "whisper-small"])
res["audit"] = open(H.AUDIT_LOG).read()
print(json.dumps(res))
`;
  const run = spawnSync("python3", ["-c", driver, path.join(ROOT, "deploy", "moni-helper"), TMP], { encoding: "utf8" });
  let res;
  try {
    res = JSON.parse(run.stdout.trim().split("\n").pop());
  } catch (e) {
    check("the helper driver ran", false, run.stderr || run.stdout);
    return;
  }
  check("status with nothing installed: not installed, no models, the install command named", res.status0.ok && res.status0.data.installed === false && res.status0.data.models.length === 0 && /install-voice-whisper\.sh/.test(res.status0.data.install));
  check("set refused while not installed, naming the install script", !res.set_uninstalled.ok && /not installed.*install-voice-whisper\.sh/.test(res.set_uninstalled.error), JSON.stringify(res.set_uninstalled));
  check("status lists installed models (not the VAD model)", res.status1.data.installed === true && res.status1.data.models.map((m) => m.model).join() === "small-q8_0");
  check("a model that is not installed is refused; a path or the VAD model is not a model id", !res.set_missing_model.ok && /large-v3-turbo-q8_0 is not installed/.test(res.set_missing_model.error) && !res.set_bad.ok && /not a local model id/.test(res.set_bad.error) && !res.set_vad.ok);
  check("set <model>: writes the environment file (root-readable 0644) and enables + starts the unit", res.set_ok.ok && res.set_ok.data.active === "active" && res.set_ok.data.selected === "small-q8_0" && /WHISPER_MODEL=.*\/models\/ggml-small-q8_0\.bin/.test(res.env) && res.env_mode === "0o644" && res.calls_set.includes("systemctl enable moni-voice-whisper.service") && res.calls_set.includes("systemctl restart moni-voice-whisper.service"), JSON.stringify(res.calls_set));
  check("  the same model again while it runs: not restarted", res.set_again.ok && !res.calls_again.some((c) => /restart|enable /.test(c)), JSON.stringify(res.calls_again));
  check("set off: disabled and stopped", res.off.ok && res.off.data.active === "inactive" && res.calls_off.includes("systemctl disable --now moni-voice-whisper.service"));
  check("the live session's model may be gpt-transcribe now (VOICE_TRANSCRIBE_RE); a local model id is not one", res.opt_gpt_transcribe.ok && !res.opt_whisper.ok);
  check("audited", /voice-whisper-set/.test(res.audit) && /"small-q8_0"/.test(res.audit) && /"off"/.test(res.audit));
  fs.rmSync(TMP, { recursive: true, force: true });
}
