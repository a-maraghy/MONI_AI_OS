#!/usr/bin/env node
"use strict";
/**
 * The guard between a microphone and MONI AI (lib/voice-guard.js,
 * lib/voice-intake.js, their wiring in server.js and public/moni-ai.js).
 *
 *   NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-voice-guard.cjs
 *
 * The case it exists for (2026-09-29, MONI AI ledger turn 92): a push-to-talk
 * press with nothing said sent 1.7 s of near-silence (5,078 bytes, 17 audio
 * tokens) to gpt-4o-mini-transcribe, which answered with its own vocabulary
 * prompt; the page sent that to MONI AI as the administrator's turn. The texts
 * below are what the real API returned for silence, near-silence, a click and
 * room noise when this was reproduced the same day.
 *
 * Checked:
 *   - echo detection: every echo seen on the real API, the new vocabulary
 *     list, the desk's instructions and tool descriptions -- and no false
 *     positive on real requests that name MONI AI, Odoo, the allocation engine;
 *   - stock silence phrases, and more words than the audio could hold;
 *   - the intake: silence is never sent to be transcribed (too small, too
 *     short, too quiet), an echoed prompt is dropped, real speech passes;
 *   - REGRESSION, direct path: a mock transcriber returning the prompt for a
 *     silent clip -> nothing reaches the supervisor's send, even when a page
 *     sends the words anyway; a voice send must match what the server heard,
 *     once;
 *   - the page: a silent push-to-talk press uploads nothing; a click does not
 *     count as speech; speech is uploaded with its level;
 *   - server.js routes use all of it.
 * (The front desk and its regression tests are gone: voice is live conversation only.)
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const guard = require(path.join(ROOT, "lib", "voice-guard.js"));
const intakeLib = require(path.join(ROOT, "lib", "voice-intake.js"));
const voice = require(path.join(ROOT, "lib", "voice.js"));
const shared = require(path.join(ROOT, "lib", "voice-shared.js")); // (was voice-desk.js; the front desk is gone)

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
const flush = () => new Promise((r) => setImmediate(r));
async function settle(n) {
  for (let i = 0; i < (n || 8); i++) await flush();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What reached MONI AI as turn 92, verbatim from the ledger.
const TURN_92 =
  "MONI AI, the assistant that runs their VPS, the MONI dashboard, Odoo, the allocation engine, agents, sessions, Claude, sub-agents, deploys, services, and logs.";
// What the real API returned for silent / quiet clips, 2026-09-29.
const REAL_ECHOES = [
  "context: ###\nSomeone talking to MONI AI, the assistant that runs their VPS: the MONI dashboard, Odoo, the allocation engine, agents, sessions, Claude, sub-agents, deploys, services and logs.\n###",
  "Context: ###\nSomeone talking to MONI AI, the assistant that runs their VPS: the MONI dashboard, Odoo, the allocation engine, agents, sessions, Claude, sub-agents, deploys, services and logs.\n###",
  "Someone talking to MONI AI, the assistant that runs their VPS: the MONI dashboard, Odoo, the allocation engine, agents, sessions, Claude, sub-agents, deploys, services, and logs.",
  "MONI AI, the assistant that runs their VPS: the MONI dashboard, Odoo, the allocation engine, agents, sessions, Claude, sub-agents, deploys, services and logs.",
  "The MONI dashboard, Odoo, the allocation engine, agents, sessions, Claude, sub-agents, deploys, services and logs.",
  "MONI AI, MONI, Odoo, Giza, PMO, Claude, VPS, sub-agents", // the list prompt before the rename, echoed
  "MINT AI, Mint, Odoo, Giza, PMO, Claude, VPS, sub-agents", // the list prompt now (Mint), echoed
  "MINT AI, Mint, Odoo, Giza, PMO, Claude, VPS, sub-agents.",
];
// Real requests: names from the prompt, but said as requests.
const REAL_SPEECH = [
  "MONI AI, restart the dashboard, please.",
  "Hey, MONI, is Odoo up on the trial box?",
  "Ask Moni AI to check PMO9045 in Odoo.",
  "How is the allocation engine doing for Giza today?",
  "Tell Claude to spin up a sub-agent for the deploy.",
  "MONI AI, can you check whether Odoo and the allocation engine are running on the VPS?",
  "Restart the MONI dashboard, Odoo and the allocation engine services.",
  "Is the MONI dashboard up?",
  "MONI AI, what are the sessions, agents and services doing, and are there errors in the logs?",
  "Okay, so give me one, what should I do next to speed up the process even more?",
  "You still take a little bit longer than expected to respond. Could you please check and let me know what you can do?",
  "Are we live?",
  "Hey MONI AI",
  // the same requests under the new name (2026-09-29 rename)
  "MINT AI, restart the dashboard, please.",
  "Hey, Mint, is Odoo up on the trial box?",
  "Ask Mint AI to check PMO9045 in Odoo.",
  "MINT AI, can you check whether Odoo and the allocation engine are running on the VPS?",
  "Is the Mint OS dashboard up?",
  "Hey MINT AI",
  "Okay, thank you.",
];

(async () => {
  section("echo detection");
  check("turn 92 itself is an echo of the transcription prompt", !!guard.echoOf(TURN_92) && guard.checkTranscript(TURN_92, {}).rule === "echo", JSON.stringify(guard.echoOf(TURN_92)));
  for (const e of REAL_ECHOES) {
    const r = guard.checkTranscript(e, {});
    check(`echo dropped: ${JSON.stringify(e.slice(0, 60))}`, !r.ok && r.rule === "echo", JSON.stringify(r));
  }
  for (const s of REAL_SPEECH) {
    const r = guard.checkTranscript(s, { audioSeconds: 4 });
    check(`real speech passes: ${JSON.stringify(s.slice(0, 60))}`, r.ok, JSON.stringify(r));
  }
  {
    const ins = shared.SUMMARY_INSTRUCTIONS.split("\n").filter((l) => l.split(/\s+/).length >= 8);
    check("a (long enough) line of the summary instructions is an echo", ins.slice(0, 3).every((l) => guard.echoOf(l)), ins.slice(0, 3).filter((l) => !guard.echoOf(l)).join(" | "));
    check("the summary instructions are an echo", !!guard.echoOf(shared.SUMMARY_INSTRUCTIONS));
    check("the reader's instructions are an echo", !!guard.echoOf(voice.INSTRUCTIONS));
    check("a partial echo inside a few extra words is still one", !!guard.echoOf("Okay. " + TURN_92.slice(0, 90)));
    check("a sentence quoting four prompt words in a row is not", !guard.echoOf("Please check the MONI dashboard, Odoo and nothing else today."));
  }
  check("the vocabulary list: names only is an echo, names in a request are not", !!guard.echoOf("Odoo, Claude, PMO") && !guard.echoOf("Odoo is down, tell Claude"));
  check("thresholds as documented", guard.RUN_ALONE === 8 && guard.RUN_WITH_OVERLAP === 5 && guard.OVERLAP === 0.6);
  check("the transcription prompt is a vocabulary list now, not a sentence", voice.TRANSCRIBE_PROMPT_KIND === "list" && !/Someone talking/.test(voice.TRANSCRIBE_PROMPT) && /MINT AI/.test(voice.TRANSCRIBE_PROMPT) && /Mint\b/.test(voice.TRANSCRIBE_PROMPT) && !/MONI/.test(voice.TRANSCRIBE_PROMPT) && /Odoo/.test(voice.TRANSCRIBE_PROMPT));
  check("the echo guard compares against the prompt in use (Mint)", guard.promptSources().some((s) => s.name === "transcription prompt" && s.text === voice.TRANSCRIBE_PROMPT && /MINT AI/.test(s.text)));
  check("and against the summary instructions in use (MINT AI); the desk's are gone", guard.promptSources().some((s) => s.name === "summary instructions" && s.text === shared.SUMMARY_INSTRUCTIONS && /MINT AI/.test(s.text)) && !guard.promptSources().some((s) => /desk/.test(s.name)));
  check("the old sentence prompt stays a guarded source", guard.promptSources().some((s) => s.text === guard.LEGACY_TRANSCRIBE_PROMPT));

  section("silence phrases and physics");
  check("\"Thank you.\" from a short clip is dropped", guard.checkTranscript("Thank you.", { audioSeconds: 0.8 }).rule === "silence-phrase");
  check("  from a quiet clip too", guard.checkTranscript("you", { audioSeconds: 3, quiet: true }).rule === "silence-phrase");
  check("  but said properly, at length and loud, it passes", guard.checkTranscript("Thank you.", { audioSeconds: 1.6 }).ok);
  check("subtitle credits are always dropped", guard.checkTranscript("Subtitles by the Amara.org community", { audioSeconds: 4 }).rule === "credits");
  check("23 words from 1.7 s of audio (turn 92's shape) is too many", guard.tooManyWords("a b c d e f g h i j k l m n o p q r s t u v w", 1.7));
  check("  23 words from 5.5 s (a real turn of 23 words) is fine", !guard.tooManyWords("a b c d e f g h i j k l m n o p q r s t u v w", 5.5));
  check("audio seconds from the transcription's usage (10 tokens a second)", guard.audioSecondsFromUsage({ input_token_details: { audio_tokens: 17 } }) === 1.7);
  check("a bracketed noise label is dropped", guard.checkTranscript("[music]", {}).rule === "noise-label");

  section("the intake: silence is never transcribed");
  const PROMPT_ECHO = { text: TURN_92, usage: { type: "tokens", input_tokens: 59, input_token_details: { audio_tokens: 17, text_tokens: 42 }, output_tokens: 43 }, model: "gpt-4o-mini-transcribe", tokens: {} };
  function mockTranscriber(result) {
    const calls = [];
    const fn = (audio, cfg, mime) => (calls.push({ bytes: audio.length, mime }), Promise.resolve(typeof result === "function" ? result(audio) : result));
    fn.calls = calls;
    return fn;
  }
  const SILENT_CLIP = Buffer.alloc(5078, 1); // turn 92's size
  {
    const tr = mockTranscriber(PROMPT_ECHO);
    const r = await intakeLib.intake({ audio: Buffer.alloc(700), mime: "audio/webm", level: null, cfg: {}, transcribe: tr });
    check("a clip under 1,200 bytes is not sent to OpenAI", r.dropped === "tiny" && r.text === "" && tr.calls.length === 0);
    const r2 = await intakeLib.intake({ audio: SILENT_CLIP, mime: "audio/webm", level: { ms: 220, loud_ms: 200, peak: 0.2 }, cfg: {}, transcribe: tr });
    check("a clip the page measured under 300 ms is not sent", r2.dropped === "short" && tr.calls.length === 0);
    const r3 = await intakeLib.intake({ audio: SILENT_CLIP, mime: "audio/webm", level: { ms: 1700, loud_ms: 0, peak: 0.003 }, cfg: {}, transcribe: tr });
    check("a clip the page measured as quiet is not sent", r3.dropped === "quiet" && tr.calls.length === 0);
    const r4 = await intakeLib.intake({ audio: SILENT_CLIP, mime: "audio/webm", level: null, cfg: {}, transcribe: tr });
    check("a page that measured nothing (an old page): transcribed, and the echo dropped", tr.calls.length === 1 && r4.dropped === "echo" && r4.text === "" && r4.heard === PROMPT_ECHO);
    check("  the page's level is cleaned (junk ignored)", intakeLib.cleanLevel({ ms: "x", loud_ms: -1 }) === null && JSON.stringify(intakeLib.cleanLevel({ ms: 900, loud_ms: 300, peak: 0.1 })) === '{"ms":900,"loud_ms":300,"peak":0.1}');
    const said = { text: "MONI AI, restart the dashboard, please.", usage: { input_token_details: { audio_tokens: 24 } } };
    const r5 = await intakeLib.intake({ audio: SILENT_CLIP, mime: "audio/webm", level: { ms: 2600, loud_ms: 1400, peak: 0.21 }, cfg: {}, transcribe: mockTranscriber(said) });
    check("real speech passes the intake", !r5.dropped && r5.text === said.text);
  }

  section("REGRESSION, direct path: the prompt echoed for a silent clip never reaches MONI AI");
  {
    const sup = { calls: [], call(op, params, actor) { sup.calls.push([op, params, actor]); return Promise.resolve({ turn: { id: 1 } }); } };
    const grounds = new guard.Grounds();
    const actor = "amaraghy";
    // /mint-ai/api/send, as server.js does it: cleanSend, sendRefusal, then call.
    const moniai = require(path.join(ROOT, "lib", "moniai.js"));
    async function sendRoute(body) {
      const params = moniai.cleanSend(body);
      const refusal = intakeLib.sendRefusal({ grounds, actor, body, text: params.text });
      if (refusal) return { status: 422, refusal };
      return { status: 200, r: await sup.call("send", params, actor) };
    }
    // The page, direct path: transcribe, then send what came back (if anything).
    async function pageTurn(clip, level, transcriber) {
      const vt = "v" + Math.random().toString(36).slice(2, 12);
      const got = await intakeLib.transcribeTurn({ audio: clip, mime: "audio/webm", level, cfg: {}, transcribe: transcriber, grounds, actor, vt });
      if (!got.text) return { sent: false, got };
      return { sent: true, got, res: await sendRoute({ text: got.text, vt }) };
    }
    const a = await pageTurn(SILENT_CLIP, null, mockTranscriber(PROMPT_ECHO));
    check("the transcript comes back empty (\"didn't catch that\")", a.sent === false && a.got.dropped === "echo");
    check("  and the supervisor's send was never called", sup.calls.length === 0);
    const b = await sendRoute({ text: TURN_92, vt: "vforged123" });
    check("a page that sends the echoed words anyway, as a voice turn, is refused", b.status === 422 && b.refusal.rule === "echo" && sup.calls.length === 0, JSON.stringify(b));
    const c = await sendRoute({ text: "Restart Odoo now.", vt: "vneverheard1" });
    check("a voice send the server never heard is refused (ungrounded)", c.status === 422 && c.refusal.rule === "ungrounded" && sup.calls.length === 0);
    const d = await sendRoute({ text: "Restart Odoo now.", vt: "bad vt!" });
    check("a malformed voice-turn id is refused", d.status === 422 && d.refusal.rule === "bad-vt");
    const said = { text: "MONI AI, restart the dashboard, please.", usage: { input_token_details: { audio_tokens: 24 } } };
    const e = await pageTurn(SILENT_CLIP, { ms: 2600, loud_ms: 1400, peak: 0.21 }, mockTranscriber(said));
    check("real speech still reaches MONI AI, once", e.sent && e.res.status === 200 && sup.calls.length === 1 && sup.calls[0][0] === "send" && sup.calls[0][1].text === said.text, JSON.stringify(e.res));
    const vt = "vtwice12345";
    grounds.remember(actor, vt, "Check the disk.");
    const f1 = await sendRoute({ text: "Check the disk.", vt });
    const f2 = await sendRoute({ text: "Check the disk.", vt });
    check("a transcript grounds one send only", f1.status === 200 && f2.status === 422 && f2.refusal.rule === "ungrounded");
    grounds.remember(actor, "vother12345", "Check the disk.");
    const g = await sendRoute({ text: "Delete the backups.", vt: "vother12345" });
    check("and only its own words", g.status === 422 && g.refusal.rule === "ungrounded");
    grounds.remember("someoneelse", "vuser123456", "Check the disk.");
    const h = await sendRoute({ text: "Check the disk.", vt: "vuser123456" });
    check("and only for the user it was heard for", h.status === 422);
    const typed = await sendRoute({ text: "Why did I get a turn saying 'MONI AI, the assistant that runs their VPS'?" });
    check("a typed turn (no voice-turn id) passes as before", typed.status === 200);
    let t = 0;
    const gr = new guard.Grounds({ ttlMs: 1000, now: () => t });
    gr.remember(actor, "vold1234567", "Hello there.");
    t = 5000;
    check("a transcript expires", !gr.take(actor, "vold1234567", "Hello there."));
  }

  section("the page records nothing itself");
  {
    const SRC = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
    check("no push to talk: no recorder, no transcribe upload, no desk turn (voice is live conversation, public/voice-live.js)", !/MediaRecorder|api\("transcribe"|desk\/turn|getUserMedia/.test(SRC));
  }

  section("server.js uses all of it");
  {
    const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    const route = (p) => {
      const i = server.indexOf(p);
      return i < 0 ? "" : server.slice(i, i + 4000);
    };
    const tr = server.slice(server.indexOf("async function voiceTranscribeRoute("), server.indexOf("async function voiceTranscribeRoute(") + 2500);
    check("the transcribe route goes through the intake (and remembers the transcript)", /voiceIntake\.transcribeTurn\(/.test(tr) && /grounds: voiceGrounds/.test(tr) && !/voice\.transcribeFull\(audio/.test(tr));
    check("  a drop answers as for silence, with no text", /if \(got\.dropped\) return res\.json\(\{ text: "", dropped: got\.dropped \}\)/.test(tr));
    check("  and logs the rule, never the words", /dropped: got\.dropped \|\| undefined/.test(tr) && !/text: text|said:/.test(tr.slice(tr.indexOf("voiceLog"), tr.indexOf("voiceLog") + 600)));
    check("the desk route and the Command Center's transcribe route are gone", !route('app.post("/mint-ai/api/desk/turn"') && !route('app.post("/mint-ai/api/transcribe"'));
    const sd = route('app.post("/mint-ai/api/send"');
    check("the send route refuses an ungrounded or prompt-like voice turn before calling MONI AI", /voiceIntake\.sendRefusal\(/.test(sd) && sd.indexOf("sendRefusal") < sd.indexOf('moniai.call("send"') && /status\(422\)/.test(sd));
    check("  and logs the refusal (rule only)", /voiceLog\("send", "refused", \{ rule: refusal\.rule/.test(sd));
    check("the console's dictation shares the transcribe route (and the guard)", /app\.post\("\/console\/:id\/transcribe"[\s\S]{0,400}return voiceTranscribeRoute\(req, res\)/.test(server));
    const js = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
    check("the page sends its voice-turn id with a voice send", /if \(opts\.voice && opts\.vt\) body\.vt = opts\.vt;/.test(js));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("  FAIL no exception\n" + e.stack);
  process.exit(1);
});
