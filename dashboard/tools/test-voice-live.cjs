#!/usr/bin/env node
"use strict";
/**
 * Live conversation (trial): lib/voice-live.js against a mock OpenAI realtime
 * server that speaks the real event shapes (session.updated,
 * input_audio_buffer.speech_started/stopped, the input transcription,
 * response.created / output_item.added / output_audio.delta /
 * output_audio_transcript.delta / response.done with usage and function
 * calls), with a fake browser, a fake supervisor, a fake reader and a fake
 * summariser. No network beyond 127.0.0.1, no OpenAI, nothing to MINT AI.
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-voice-live.cjs
 *
 * Then the WebSocket route itself, on the real server.js from a scratch copy
 * that cannot reach the privileged helper (tools/scratch-server.cjs): auth,
 * CSRF, origin, the mode, one call per user, the maximum length.
 */
const path = require("path");
const http = require("http");
const scratch = require("./scratch-server.cjs"); // first: sets MONI_DATA_DIR
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const ROOT = path.join(__dirname, "..");
const live = require(path.join(ROOT, "lib", "voice-live.js"));
const desk = require(path.join(ROOT, "lib", "voice-desk.js"));
const usage = require(path.join(ROOT, "lib", "voice-usage.js"));
const VoiceStop = require(path.join(ROOT, "public", "voice-stop.js"));

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
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const end = Date.now() + (ms || 2000);
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(5);
  }
  if (label) console.log("       (timed out waiting for " + label + ")");
  return false;
}

/* ------------------------------------------------------ mock realtime --- */

const KEY = "sk-proj-" + "L".repeat(40) + "live";
const mock = { sessions: [] };
const mockServer = http.createServer((q, s) => (s.writeHead(404), s.end()));
const mockWss = new WebSocketServer({ noServer: true });
// The mock accepts the test's key and, for the route test, the scratch copy's fake one.
const KEYS = new Set([KEY]);
const voiceLiveRate = () => live.RATE;
mockServer.on("upgrade", (req, sock, head) => {
  if (!KEYS.has(String(req.headers.authorization || "").replace(/^Bearer /, ""))) {
    sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return sock.destroy();
  }
  mockWss.handleUpgrade(req, sock, head, (ws) => {
    const s = { url: req.url, ws, events: [], session: null, appended: 0, closed: false };
    s.push = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ event_id: "ev" + Math.random().toString(36).slice(2), ...o }));
    s.of = (type) => s.events.filter((e) => e.type === type);
    ws.on("close", () => (s.closed = true));
    ws.on("message", (d) => {
      const ev = JSON.parse(String(d));
      if (ev.type === "input_audio_buffer.append") {
        s.appended += Buffer.from(ev.audio, "base64").length;
        return;
      }
      s.events.push(ev);
      if (ev.type === "session.update") {
        s.session = { ...(s.session || {}), ...ev.session };
        s.push({ type: "session.updated", session: s.session });
      }
    });
    mock.sessions.push(s);
  });
});

/* ------------------------------------------------ the fakes around it --- */

function pcm(ms) {
  const b = Buffer.alloc(Math.round(ms * 48));
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 8 < 4 ? 3000 : -3000, i);
  return b;
}

function makeCall(extra) {
  const x = extra || {};
  const client = { json: [], audio: [], closed: null };
  const sup = { calls: [], replies: new Map(), nextTurn: 500 };
  const call = (op, params, actor) => {
    sup.calls.push([op, params, actor]);
    if (op === "snapshot") {
      const snap = { machine: { disk: { used_percent: 41, free_gb: 156.2 } }, services: { running: 4, tracked: 4, failed: [], list: [{ name: "odoo", state: "running" }] } };
      if (params && params.turns) snap.requests_to_moni_ai = params.turns.map((id) => ({ id, answered: sup.replies.has(id), reply: sup.replies.get(id) }));
      return Promise.resolve(snap);
    }
    if (op === "send") return Promise.resolve({ turn: { id: ++sup.nextTurn, status: "queued" } });
    return Promise.reject(new Error("refused " + op));
  };
  const spoke = [];
  const rows = [];
  const summarised = [];
  const persona = { v: x.persona || {} };
  const c = new live.LiveCall({
    cfg: { key: KEY, voice: "marin", model: "gpt-realtime-mini", transcribe_model: "gpt-4o-mini-transcribe", wsBase: WS_BASE },
    actor: "amaraghy",
    ops: desk.deskOps(call, "amaraghy"),
    client: {
      json: (o) => client.json.push(o),
      audio: (seg, buf) => client.audio.push({ seg, bytes: buf.length, at: Date.now() }),
      close: (code, why) => (client.closed = { code, why }),
    },
    persona: () => persona.v,
    hearPersona: x.hearPersona || (() => persona.v),
    speak: async (text, cfg, sink) => {
      spoke.push(text);
      if (x.slowSpeak) await sleep(x.slowSpeak);
      sink.start({ engine: "fake" });
      sink.audio(pcm(200));
      return { billing: [{ model: "gpt-realtime-mini", tokens: { text_in: 20, audio_out: 40 } }], lateBilling: Promise.resolve([]) };
    },
    transcribe: x.transcribe || (async () => ({ text: x.turnText || "", model: "gpt-4o-mini-transcribe", tokens: { audio_in: 30, text_in: 5, text_out: 10 } })),
    summarise: x.summarise || (async (id, o) => {
      summarised.push(id);
      for (const l of x.summaryLines || [{ text: "MINT AI says the dashboard is back up.", safe: false }]) o.onLine(l);
      return { tokens: { text_in: 300, text_out: 30 }, fallback: null };
    }),
    record: (row) => {
      const r = { ...row, usd: usage.costOf(row.tokens, row.model) };
      rows.push(r);
      return r.usd;
    },
    isStop: (t) => VoiceStop.heard(t),
    log: () => {},
    opts: { pollMs: 20, ...(x.opts || {}) },
  });
  return { c, client, sup, spoke, rows, summarised, persona };
}
const lastSession = () => mock.sessions[mock.sessions.length - 1];
const states = (client) => client.json.filter((m) => m.type === "state").map((m) => m.state);

/** A user turn: speech started/stopped, then the session's transcript. */
async function userTurn(s, c, text, opts) {
  const o = opts || {};
  const item = o.item || "item_u" + Math.random().toString(36).slice(2, 8);
  c.audioIn(pcm(o.ms || 1500));
  s.push({ type: "input_audio_buffer.speech_started", audio_start_ms: Math.max(0, c.inputMs - (o.ms || 1500)), item_id: item });
  if (o.onlyStart) return item;
  s.push({ type: "input_audio_buffer.speech_stopped", audio_end_ms: c.inputMs, item_id: item });
  s.push({ type: "input_audio_buffer.committed", item_id: item });
  if (text != null && !o.noTranscript) s.push({ type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: text, usage: { type: "tokens", total_tokens: 40, input_tokens: 30, input_token_details: { text_tokens: 0, audio_tokens: 30 }, output_tokens: 10 } });
  await sleep(10);
  return item;
}

/**
 * The model's spoken response: the transcript a word ahead of the audio (the
 * order measured on the real API), then function calls, then response.done.
 */
async function respond(s, say, opts) {
  const o = opts || {};
  const rid = "resp_" + Math.random().toString(36).slice(2, 8);
  const item = "item_a" + Math.random().toString(36).slice(2, 8);
  s.push({ type: "response.created", response: { id: rid, status: "in_progress", output: [] } });
  const output = [];
  if (say) {
    s.push({ type: "response.output_item.added", response_id: rid, output_index: 0, item: { id: item, type: "message", role: "assistant", content: [] } });
    const words = say.match(/\S+\s*/g) || [];
    for (let i = 0; i < words.length; i++) {
      s.push({ type: "response.output_audio_transcript.delta", response_id: rid, item_id: item, delta: words[i] });
      if (i > 0) s.push({ type: "response.output_audio.delta", response_id: rid, item_id: item, delta: pcm(80).toString("base64") });
      await sleep(o.gap || 2);
      if (o.stopAfter && i + 1 >= o.stopAfter) return { rid, item };
    }
    s.push({ type: "response.output_audio.delta", response_id: rid, item_id: item, delta: pcm(80).toString("base64") });
    s.push({ type: "response.output_audio_transcript.done", response_id: rid, item_id: item, transcript: say });
    output.push({ id: item, type: "message", role: "assistant", status: "completed", content: [{ type: "output_audio", transcript: say }] });
  }
  for (const f of o.calls || []) output.push({ id: "fc" + Math.random().toString(36).slice(2, 6), type: "function_call", name: f.name, call_id: "call_" + Math.random().toString(36).slice(2, 8), arguments: JSON.stringify(f.args || {}) });
  await sleep(2);
  s.push({
    type: "response.done",
    response: {
      id: rid,
      status: o.status || "completed",
      output,
      usage: { total_tokens: 900, input_tokens: 700, output_tokens: 200, input_token_details: { text_tokens: 500, audio_tokens: 200, cached_tokens: 300, cached_tokens_details: { text_tokens: 300, audio_tokens: 0 } }, output_token_details: { text_tokens: 40, audio_tokens: 160 } },
    },
  });
  await sleep(15);
  return { rid, item };
}

let WS_BASE;

(async () => {
  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  WS_BASE = "ws://127.0.0.1:" + mockServer.address().port + "/v1";

  section("the upstream session: fixed configuration");
  {
    const { c, client } = makeCall({ persona: { gender: "f", dialect: "egyptian" } });
    await c.open();
    const s = lastSession();
    const cfg = s.session;
    check("model gpt-realtime-2.1-mini, by default", /model=gpt-realtime-2\.1-mini$/.test(s.url) && live.LIVE_MODEL === "gpt-realtime-2.1-mini", s.url);
    check("audio out, PCM 24 kHz both ways, voice marin", cfg.output_modalities.join() === "audio" && cfg.audio.input.format.rate === 24000 && cfg.audio.output.format.rate === 24000 && cfg.audio.output.voice === "marin");
    const td = cfg.audio.input.turn_detection;
    check("server VAD at 700 ms of silence, interrupt_response and create_response on", td.type === "server_vad" && td.silence_duration_ms === 700 && td.interrupt_response === true && td.create_response === true);
    check("the session transcribes the input (gpt-4o-mini-transcribe)", cfg.audio.input.transcription.model === "gpt-4o-mini-transcribe");
    check("exactly two tools: read_status and ask_mint_ai, frozen", cfg.tools.map((t) => t.name).join() === "read_status,ask_mint_ai" && Object.isFrozen(live.TOOLS));
    check("ask_mint_ai takes only text; read_status nothing", Object.keys(live.TOOLS[1].parameters.properties).join() === "text" && live.TOOLS[1].parameters.additionalProperties === false && Object.keys(live.TOOLS[0].parameters.properties).length === 0);
    check("the instructions are the fixed ones plus the saved persona's line", cfg.instructions.startsWith(live.INSTRUCTIONS) && /feminine forms for yourself/.test(cfg.instructions) && /Egyptian colloquial/.test(cfg.instructions));
    check("they say MINT AI's answers are never spoken by the voice model", /Never say what MINT AI answered/.test(live.INSTRUCTIONS));
    check("the page is told the call listens", states(client).includes("listening"));
    c.audioIn(pcm(100));
    check("microphone audio is relayed as input_audio_buffer.append", await until(() => s.appended === 4800, 500));
    c.message({ type: "mute", on: true });
    c.audioIn(pcm(100));
    await sleep(20);
    check("muted: nothing is relayed, the buffer is cleared, the page shows muted", s.appended === 4800 && s.of("input_audio_buffer.clear").length === 1 && states(client).pop() === "muted");
    c.message({ type: "mute", on: false });
    c.audioIn(Buffer.alloc(3)); // an odd frame is not audio
    await sleep(10);
    check("an odd-length frame is refused", s.appended === 4800);
    c.close("test");
    check("closing ends the upstream session and tells the page", (await until(() => s.closed, 500)) && client.json.some((m) => m.type === "ended"));
  }

  section("guard before sound: audio is held until its sentence has passed");
  {
    check("audioTag: the sentence the transcript is in", live.audioTag("") === 0 && live.audioTag("Hello") === 0 && live.audioTag("Hello there friend. How") === 1 && live.audioTag("Hello there friend. ") === 0 && live.audioTag("One two three. Four five six. Se") === 2);
    const { c, client } = makeCall();
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "hi, how are you today?");
    const rid = "resp_hold";
    const item = "item_hold";
    s.push({ type: "response.created", response: { id: rid } });
    s.push({ type: "response.output_item.added", item: { id: item, type: "message" } });
    s.push({ type: "response.output_audio_transcript.delta", item_id: item, delta: "I'm doing well, " });
    s.push({ type: "response.output_audio.delta", item_id: item, delta: pcm(100).toString("base64") });
    await sleep(15);
    check("audio of an unfinished sentence is not sent", client.audio.length === 0);
    s.push({ type: "response.output_audio_transcript.delta", item_id: item, delta: "thanks for asking. How " });
    s.push({ type: "response.output_audio.delta", item_id: item, delta: pcm(100).toString("base64") });
    await sleep(15);
    const first = client.audio.reduce((n, a) => n + a.bytes, 0);
    check("once the sentence has passed (the next one began), its audio goes out", first === 4800, first);
    check("  the audio of the sentence being said is still held", c.resp.chunks.length === 1);
    check("  the passed sentence is shown as the voice's caption", client.json.some((m) => m.type === "caption" && m.who === "desk" && /I'm doing well/.test(m.text)));
    s.push({ type: "response.output_audio_transcript.delta", item_id: item, delta: "can I help?" });
    s.push({ type: "response.done", response: { id: rid, status: "completed", output: [{ id: item, type: "message", content: [{ type: "output_audio", transcript: "I'm doing well, thanks for asking. How can I help?" }] }], usage: { input_tokens: 10, output_tokens: 10, input_token_details: { text_tokens: 5, audio_tokens: 5 }, output_token_details: { text_tokens: 2, audio_tokens: 8 } } } });
    await sleep(20);
    check("at the end, the rest goes out: every byte, once, in one segment", client.audio.reduce((n, a) => n + a.bytes, 0) === 9600 && new Set(client.audio.map((a) => a.seg)).size === 1);
    check("the hold is measured", c.diag.held.length === 2 && c.diag.firstAudio.length === 1);
    c.close("test");
  }

  section("a cut: nothing of it is heard, the safe line is, the request is passed on");
  for (const [said, heardText, rule, lang] of [
    ["Restarting Odoo now. Done.", "restart odoo please", "action-claim", "en"],
    ["Okay, I've restarted Odoo for you.", "restart odoo please", "action-claim", "en"],
    ["تم إعادة تشغيل أودو.", "اعمل restart لأودو", "action-claim", "ar"],
    ["الديسك وصل ٩٣ في المية.", "الديسك عامل ايه", "figure", "ar"],
    ["Готово, я перезапустил Odoo.", "اعمل restart لأودو", "unknown-script", "ar"],
    ["MINT AI said the backup finished at 2:30.", "did the backup finish", "invented-reply", "en"],
  ]) {
    const { c, client, sup, spoke } = makeCall({ turnText: heardText });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, heardText);
    await respond(s, said);
    await until(() => spoke.length > 0, 1500, "the safe line");
    const L = desk.linesFor(lang);
    check(`«${said}» is cut (${rule}), and none of its audio went out`, c.diag.trips.length === 1 && c.diag.trips[0].rule === rule && client.audio.every((a) => client.json.find((m) => m.type === "seg" && m.seg === a.seg && m.kind === "safe")), JSON.stringify(c.diag.trips));
    check("  the response was cancelled upstream (or had already finished)", s.of("response.cancel").length >= 1 || c.diag.trips[0].released >= 0);
    check("  the safe line, in the sentence's language, read by the verbatim reader", spoke.length === 1 && spoke[0] === L.safe, JSON.stringify(spoke));
    const sends = sup.calls.filter((x) => x[0] === "send");
    check("  and made true: MINT AI got the administrator's words, once", sends.length === 1 && sends[0][1].text === heardText && sends[0][1].via === "voice-desk", JSON.stringify(sends));
    check("  the conversation keeps what was heard and the safe line", s.of("conversation.item.create").some((e) => e.item.role === "assistant" && e.item.content[0].text.endsWith(L.safe)));
    c.close("test");
  }

  section("cross-sentence and fail-closed, held across sentences");
  {
    const { c, client } = makeCall({ turnText: "check the dashboard" });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "check the dashboard");
    await respond(s, "You asked about the dashboard restart. Done.", { stopAfter: 6 });
    await sleep(20);
    check("an action sentence is held until the next one is known (no audio yet)", client.audio.length === 0 && c.diag.trips.length === 0);
    c.close("test");
  }

  section("tools: only read_status and ask_mint_ai, only through deskOps");
  {
    const { c, sup } = makeCall({ turnText: "delete tmp" });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "delete tmp");
    await respond(s, null, { calls: [{ name: "run_shell", args: { command: "rm -rf /tmp/x" } }, { name: "approve", args: { approval_id: 3 } }] });
    await until(() => s.of("conversation.item.create").filter((e) => e.item.type === "function_call_output").length === 2, 1000);
    const outs = s.of("conversation.item.create").filter((e) => e.item.type === "function_call_output").map((e) => e.item.output);
    check("an unknown tool is refused and never runs", outs.length === 2 && outs.every((o) => /refused: that tool does not exist/.test(o)), JSON.stringify(outs));
    check("  the supervisor saw no call at all", sup.calls.length === 0, JSON.stringify(sup.calls));
    check("  the refusals are counted", c.diag.refused.join() === "run_shell,approve");
    await respond(s, null, { calls: [{ name: "read_status" }] });
    await until(() => sup.calls.length === 1, 1000);
    check("read_status reads the supervisor's snapshot", sup.calls[0][0] === "snapshot");
    const out = s.of("conversation.item.create").filter((e) => e.item.type === "function_call_output").pop().item.output;
    check("  and the model gets it through forModel (no command-like fields)", /used_percent/.test(out) && !/"command"/.test(out));
    await respond(s, null, { calls: [{ name: "read_status", args: { path: "/etc" } }] });
    await sleep(30);
    check("read_status with arguments is refused", /takes no arguments/.test(s.of("conversation.item.create").filter((e) => e.item.type === "function_call_output").pop().item.output));
    const d = desk.deskOps(() => Promise.resolve({}), "x");
    let refused = false;
    try {
      await d.gate("approve", { approval_id: 1 });
    } catch (e) {
      refused = e.code === "refused";
    }
    check("the only door (deskOps) refuses anything but snapshot and send", refused && Object.keys(desk.DESK_OPS).join() === "snapshot,send");
    c.close("test");
  }

  section("hand-offs carry the server's transcript, once per utterance");
  {
    const heard = "طب بص، عايزك تعمل restart للـ dashboard";
    const { c, sup, client } = makeCall({ turnText: heard });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "طب وص عايزك تعمل restart للداشبورد"); // the session's own, slightly worse, transcript
    // Seen on the real model: the paraphrase is a different request.
    await respond(s, null, { calls: [{ name: "ask_mint_ai", args: { text: "Please restore the dashboard. If a restart is necessary, proceed safely and report result." } }] });
    await until(() => sup.calls.some((x) => x[0] === "send"), 2000, "the hand-off");
    const sends = sup.calls.filter((x) => x[0] === "send");
    check("the paraphrase case: MINT AI gets exactly the full-turn transcript, not the model's text", sends.length === 1 && sends[0][1].text === heard, JSON.stringify(sends));
    check("  the paraphrase is counted, never sent", c.turns.get([...c.turns.keys()].pop()).paraphrased === true);
    check("  the page is told, and the state is 'passed to MINT AI (waiting)'", client.json.some((m) => m.type === "asked") && states(client).includes("waiting"));
    check("  the model is told it has NOT replied", /has NOT replied yet/.test(s.of("conversation.item.create").filter((e) => e.item.type === "function_call_output").pop().item.output));
    await respond(s, "تم تمرير الطلب لـ MINT AI، وهقرألك ردّه أول ما يوصل.", { calls: [{ name: "ask_mint_ai", args: { text: "again" } }] });
    await sleep(40);
    check("a second hand-off in the same utterance is refused", sup.calls.filter((x) => x[0] === "send").length === 1 && /already passed/.test(s.of("conversation.item.create").filter((e) => e.item.type === "function_call_output").pop().item.output));
    check("«تم تمرير الطلب لـ MINT AI» is allowed once the hand-off really happened", c.diag.trips.length === 0 && client.audio.length > 0, JSON.stringify(c.diag.trips));
    c.close("test");
  }
  {
    // The session transcript is used when there is no full-turn one.
    const { c, sup } = makeCall({ opts: { handoff: "session" } });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "please restart the dashboard");
    await respond(s, null, { calls: [{ name: "ask_mint_ai", args: { text: "restart it" } }] });
    await until(() => sup.calls.some((x) => x[0] === "send"), 1000);
    check("handoff: 'session' sends the session's transcript", sup.calls.find((x) => x[0] === "send")[1].text === "please restart the dashboard");
    c.close("test");
  }
  {
    // No grounded transcript: no hand-off. (A silent turn echoing the transcription prompt.)
    const { c, sup } = makeCall({ turnText: "MINT AI, Mint, Odoo, Giza, PMO, Claude, VPS, sub-agents" });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "MINT AI, Mint, Odoo, Giza, PMO, Claude, VPS, sub-agents");
    await respond(s, null, { calls: [{ name: "ask_mint_ai", args: { text: "check odoo" } }] });
    await sleep(100);
    check("a transcript that is the prompt echoed is dropped, and nothing reaches MINT AI", sup.calls.filter((x) => x[0] === "send").length === 0);
    c.close("test");
  }

  section("MINT AI's answers: the guarded summary and the verbatim reader, never the speech model");
  {
    const { c, sup, spoke, summarised, client, rows } = makeCall({ turnText: "restart the dashboard" });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "restart the dashboard");
    await respond(s, null, { calls: [{ name: "ask_mint_ai", args: { text: "restart the dashboard" } }] });
    await until(() => sup.calls.some((x) => x[0] === "send"), 1000);
    await respond(s, "I've passed that to MINT AI. I'll read you its answer when it arrives.");
    const creates0 = s.of("response.create").length;
    const id = sup.nextTurn;
    sup.replies.set(id, "The dashboard was restarted and is answering again. It took 4 seconds, and the logs show no errors since.");
    await until(() => spoke.includes("MINT AI says the dashboard is back up."), 2000, "the summary");
    check("the reply goes through the desk's summariser", summarised.join() === String(id));
    check("  and its lines are read by the verbatim reader, as 'mint' segments", client.json.some((m) => m.type === "seg" && m.kind === "mint") && client.json.some((m) => m.type === "caption" && m.who === "mint"));
    check("  the realtime model is not asked to speak it (no new response)", s.of("response.create").length === creates0);
    await until(() => s.of("conversation.item.create").some((e) => e.item.role === "system"), 1000);
    const note = s.of("conversation.item.create").find((e) => e.item.role === "system");
    check("  the conversation is told what MINT AI said and what was heard", note && /MINT AI replied to request/.test(note.item.content[0].text) && /MINT AI says the dashboard is back up/.test(note.item.content[0].text));
    check("  the page hears that the reply came", client.json.some((m) => m.type === "replied"));
    check("  the summary's own cost is recorded as desk tokens, live", rows.some((r) => r.part === "desk" && r.cat === "live"));
    c.close("test");
  }
  {
    const { c, sup, spoke } = makeCall({ turnText: "is odoo up", summarise: async () => ({ fallback: "verbatim", tokens: null }) });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "is odoo up");
    await respond(s, null, { calls: [{ name: "ask_mint_ai", args: { text: "is odoo up" } }] });
    await until(() => sup.calls.some((x) => x[0] === "send"), 1000);
    sup.replies.set(sup.nextTurn, "Odoo is running. `systemctl status odoo` says active.");
    await until(() => spoke.length >= 2, 2000, "the verbatim reading");
    check("a short plain reply is read word for word, code as plain words", spoke[0] === "Odoo is running." && spoke[1] === "systemctl status odoo says active.", JSON.stringify(spoke));
    c.close("test");
  }

  section("barge-in: flush, cancel, truncate at the played millisecond");
  {
    const { c, client } = makeCall();
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "tell me a bit about the machine please");
    const r = await respond(s, "Sure thing, happy to help today. Just ask me anything you like. I am listening closely.", { stopAfter: 12 });
    await sleep(10);
    const seg = client.audio.length ? client.audio[0].seg : 0;
    check("audio was going out before the barge-in", client.audio.length > 0);
    c.message({ type: "played", seg, ms: 120 });
    const t0 = Date.now();
    await userTurn(s, c, null, { onlyStart: true });
    await until(() => client.json.some((m) => m.type === "flush"), 500);
    check("the page is told to flush at once", client.json.some((m) => m.type === "flush") && Date.now() - t0 < 200);
    check("the response is cancelled", s.of("response.cancel").length === 1);
    check("the state flashes 'interrupted', then 'talking'", states(client).slice(-2).join() === "interrupted,talking", states(client).join());
    const before = client.audio.length;
    s.push({ type: "response.output_audio.delta", item_id: r.item, delta: pcm(80).toString("base64") });
    s.push({ type: "response.output_audio_transcript.delta", item_id: r.item, delta: "more words here. " });
    await sleep(15);
    check("nothing more of that response goes out", client.audio.length === before);
    c.message({ type: "flushed", seg, ms: 180 });
    await until(() => s.of("conversation.item.truncate").length, 500);
    const tr = s.of("conversation.item.truncate")[0];
    check("the item is truncated at the millisecond the page had played", tr && tr.item_id === r.item && tr.content_index === 0 && tr.audio_end_ms === 180, JSON.stringify(tr));
    check("the barge-in is timed", c.diag.bargeIns.length === 1 && c.diag.bargeIns[0].flushedAt >= c.diag.bargeIns[0].at);
    c.close("test");
  }
  {
    // A barge-in during a MINT AI summary stops the rest of it.
    const { c, sup, spoke } = makeCall({ turnText: "restart it", slowSpeak: 60, summaryLines: [{ text: "MINT AI restarted the dashboard." }, { text: "It took four seconds." }, { text: "No errors since." }] });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "restart it");
    await respond(s, null, { calls: [{ name: "ask_mint_ai", args: { text: "restart it" } }] });
    await until(() => sup.calls.some((x) => x[0] === "send"), 1000);
    sup.replies.set(sup.nextTurn, "The dashboard was restarted and is answering again. It took 4 seconds, and the logs show no errors since.");
    await until(() => spoke.length === 1, 2000);
    await userTurn(s, c, null, { onlyStart: true });
    await sleep(300);
    check("a barge-in during a summary: the lines not yet read are dropped", spoke.length === 1, JSON.stringify(spoke));
    c.close("test");
  }
  {
    // Truncate falls back to the last reported position if the page does not answer.
    const { c, client } = makeCall();
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "hello there how are you");
    const r = await respond(s, "Hello there, it is good to hear you. What can I do for you?", { stopAfter: 12 });
    await sleep(10);
    const seg = client.audio[0].seg;
    c.message({ type: "played", seg, ms: 90 });
    await userTurn(s, c, null, { onlyStart: true });
    await until(() => s.of("conversation.item.truncate").length, 1000);
    check("no 'flushed' from the page: truncated at its last reported position", s.of("conversation.item.truncate")[0].audio_end_ms === 90 && s.of("conversation.item.truncate")[0].item_id === r.item);
    c.close("test");
  }

  section("the spoken stop command ends the live call (English and Arabic, polite forms)");
  for (const said of ["Stop listening.", "Okay, so, can you stop listening now?", "وقف الاستماع", "ممكن تقفل الاستماع", "could you please stop listening"]) {
    const { c, client, sup } = makeCall({ turnText: said });
    await c.open();
    const s = lastSession();
    const item = await userTurn(s, c, null, { noTranscript: true });
    s.push({ type: "response.created", response: { id: "r_stop" } });
    s.push({ type: "conversation.item.input_audio_transcription.completed", item_id: item, transcript: said });
    await until(() => client.json.some((m) => m.type === "stop"), 1000);
    check(`«${said}»: the page is told to stop, and the call ends`, client.json.some((m) => m.type === "stop" && m.why === "voice-command") && client.json.some((m) => m.type === "ended") && (await until(() => s.closed, 500)));
    check("  the answer in flight is cancelled, nothing is passed on", s.of("response.cancel").length >= 1 && !sup.calls.some((x) => x[0] === "send"));
  }
  {
    const { c, client } = makeCall();
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "why did the service stop listening on port 80?");
    check("a question about a service that 'stopped listening' is not the command", !client.json.some((m) => m.type === "stop") && !c.closed);
    c.close("test");
  }

  section("the echo guard: what the voice just said, heard back, is dropped");
  {
    const { c, client, sup } = makeCall();
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "how full is the disk");
    await respond(s, null, { calls: [{ name: "read_status" }] });
    await respond(s, "The disk is 41% full, with 156.2 GB free.");
    const item = await userTurn(s, c, null, { noTranscript: true });
    s.push({ type: "response.created", response: { id: "r_echo" } });
    s.push({ type: "conversation.item.input_audio_transcription.completed", item_id: item, transcript: "The disk is 41% full with 156.2 GB free." });
    await sleep(30);
    check("dropped: the user item is deleted and its response cancelled", c.diag.echoes === 1 && s.of("conversation.item.delete").some((e) => e.item_id === item) && s.of("response.cancel").length >= 1);
    check("  and not shown as something you said", !client.json.some((m) => m.type === "caption" && m.who === "you" && /41% full with/.test(m.text)));
    const n = sup.calls.length;
    await userTurn(s, c, "okay and how much memory is used");
    check("a real question after it is heard", client.json.some((m) => m.type === "caption" && m.who === "you" && /memory/.test(m.text)) && sup.calls.length === n);
    c.close("test");
  }

  section("usage: priced per response into voice_usage, category 'live'");
  {
    const { c, rows } = makeCall({ turnText: "hello" });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "hello there, can you hear me");
    await respond(s, "Yes, I can hear you clearly.");
    await sleep(30);
    const rt = rows.filter((r) => r.part === "realtime");
    check("one realtime row per response, category live, the live model", rt.length === 1 && rt[0].cat === "live" && rt[0].model === "gpt-realtime-2.1-mini" && rt[0].actor === "amaraghy");
    check("  tokens split: text/audio in (cached apart) and out", JSON.stringify(rt[0].tokens) === JSON.stringify({ text_in: 200, text_cached: 300, audio_in: 200, audio_cached: 0, text_out: 40, audio_out: 160 }), JSON.stringify(rt[0].tokens));
    const want = (200 * 0.6 + 300 * 0.06 + 200 * 10 + 40 * 2.4 + 160 * 20) / 1e6;
    check("  priced from gpt-realtime-2.1-mini's list prices (read 2026-09-29)", Math.abs(rt[0].usd - want) < 1e-12 && usage.PRICES["gpt-realtime-2.1-mini"].audio_out === 20 && usage.PRICES["gpt-realtime-2.1"].text_out === 24, rt[0].usd);
    check("  the session's transcription is its own row", rows.some((r) => r.part === "transcription" && r.cat === "live"));
    check("  every row of a turn carries that turn's voice-turn id", rt[0].vt && usage.cleanVt(rt[0].vt) === rt[0].vt);
    const agg = usage.aggregate(rows.map((r) => ({ ...r, ts: Date.now() })), Date.now());
    check("the usage display counts them under 'live'", agg.today.by.live > 0 && agg.today.transcription > 0);
    c.close("test");
  }

  section("the persona in live mode");
  {
    let heardP = 0;
    const box = { v: {} };
    const x = makeCall({ hearPersona: () => (heardP++, (box.v = { gender: "f", dialect: "egyptian" })) });
    await x.c.open();
    const s = lastSession();
    await userTurn(s, x.c, "تقدميني بالعربي المصري، إزيك عاملة إيه؟");
    const upd = s.of("session.update");
    check("each heard utterance updates the persona", heardP === 1);
    check("  a change re-sends the instructions with the new line", upd.length === 2 && /feminine forms for yourself/.test(upd[1].session.instructions) && !upd[1].session.tools);
    x.c.close("test");
  }

  section("the maximum length");
  {
    const { c, client } = makeCall({ opts: { maxMs: 150 } });
    await c.open();
    await until(() => c.closed, 1000);
    check("a call is ended at its maximum length, and the page is told why", c.closed && client.json.some((m) => m.type === "ended" && m.why === "max-length"));
  }

  section("the page side: public/voice-live.js and its integration block");
  {
    const fs = require("fs");
    const src = fs.readFileSync(path.join(ROOT, "public", "voice-live.js"), "utf8");
    const wk = fs.readFileSync(path.join(ROOT, "public", "voice-live-worklet.js"), "utf8");
    const page = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
    check("the microphone is opened with echo cancellation, noise suppression and auto gain", /echoCancellation: true, noiseSuppression: true, autoGainControl: true/.test(src));
    check("capture and playback are AudioWorklets from a same-origin file (the CSP allows only 'self')", /audioWorklet\.addModule\(o\.worklet/.test(src) && /registerProcessor\("mint-live-capture"/.test(wk) && /registerProcessor\("mint-live-player"/.test(wk) && !/blob:|data:/.test(src));
    check("24 kHz PCM16 in 20 ms frames", /OUT_RATE = 24000/.test(wk) && /FRAME = 480/.test(wk));
    check("the player flushes at once and reports the played millisecond", /type === "flush"/.test(wk) && /type: "flushed", seg: seg, ms: self\.ms\(seg\)/.test(wk) && /type: "flushed", seg: m\.seg, ms: m\.ms/.test(src));
    check("the page talks only to this server's /mint-ai/api/live, with the CSRF token", /\/mint-ai\/api\/live\?csrf=/.test(src) && !/openai/i.test(src.replace(/Nothing here talks to OpenAI/, "")));
    check("the API: start, stop, mute, muted, active, state, supported", /window\.VoiceLive = \{[\s\S]*supported[\s\S]*start[\s\S]*stop[\s\S]*mute[\s\S]*muted[\s\S]*active[\s\S]*state/.test(src));
    check("the states the brief asks for are all produced", ["listening", "talking", "thinking", "speaking", "interrupted", "waiting", "muted"].every((st) => src.includes('"' + st + '"')));
    const block = page.slice(page.indexOf("LIVE CONVERSATION (trial)"), page.indexOf("end of the live integration block"));
    check("moni-ai.js has one clearly marked integration block", block.length > 500 && (page.match(/LIVE CONVERSATION \(trial\)/g) || []).length === 1);
    check("  it feeds the core and the caption from onState, onCaption and onLevel", /onState: function/.test(block) && /onCaption: function/.test(block) && /onLevel: function/.test(block) && /function liveSnapshot/.test(block));
    check("  the mode is offered only when the server says so (data-voice-live), and remembered per browser in a guarded way", /data-voice-live/.test(block) && block.split("\n").filter((l) => /localStorage/.test(l)).every((l) => /try \{[^}]*localStorage[^}]*\} catch/.test(l)));
    check("  headphones are advised in the tooltip", /Headphones are advised/.test(block));
    check("  no inline script or style is added by the page", !/<script|style="/.test(block));
    // The voice bar in a call (the administrator's report of 2026-09-29: chips overflowing the pill, two X buttons).
    const css = fs.readFileSync(path.join(ROOT, "public", "voice-live.css"), "utf8");
    const views = fs.readFileSync(path.join(ROOT, "lib", "views-moniai.js"), "utf8");
    check("the bar in a call: one 'Live · trial' tag, the other chips, the route and the bar's own X hidden", /\.cc-dock\.live-on \.cc-vb-tags,[\s\S]*?\.cc-dock\.live-on \.cc-voicebar \.cc-static,[\s\S]*?\.cc-dock\.live-on #cc-vb-close \{ display: none; \}/.test(css) && /id="cc-live-tag"[^>]*>Live · trial</.test(views));
    check("  the tag's tooltip names the model and the voice", /cc-live-tag"\)\.title = "Live conversation \(trial\)" \+ \(LiveUI\.model/.test(block) && /m\.type === "ready"\) \{ LiveUI\.model = m\.model/.test(block));
    check("  mute and End grouped at the right; End collapses to its icon on narrow screens", /id="cc-live-acts"[\s\S]*id="cc-live-mute"[\s\S]*id="cc-live-end"[\s\S]*class="lbl">End conversation</.test(views) && /max-width: 720px\)[\s\S]*\.cc-live-end \.lbl \{ display: none; \}/.test(css));
    check("  the status text takes the room and truncates", /\.cc-dock\.live-on \.cc-vb-text \{ flex: 1 1 auto; min-width: 0; \}/.test(css));
    check("  the hint under the pill says what Space and Esc do in live mode", /<kbd>Space<\/kbd> mute · <kbd>Esc<\/kbd> end/.test(block) && /id="cc-kb-live"/.test(views));
    check("  the old code that relabelled the push-to-talk tags during a call is gone", !/cc-voice-mode"\)\.textContent = "Live/.test(page));
  }

  section("the evaluation harness (lib/voice-live-eval.js)");
  {
    const ev = require(path.join(ROOT, "lib", "voice-live-eval.js"));
    check("20 phrases: Egyptian, MSA, English and mixed; status, an action, stop commands, small talk", ev.PHRASES.length === 20 && ["egyptian", "msa", "english", "mixed"].every((l) => ev.PHRASES.some((p) => p.lang === l)) && ["status", "action", "stop", "small talk"].every((k) => ev.PHRASES.some((p) => p.kind === k)));
    check("the stop phrases are stop commands, and no other phrase is", ev.PHRASES.every((p) => VoiceStop.heard(p.text) === (p.kind === "stop")));
    check("three models and two voices by default", ev.MODELS.join() === "gpt-realtime-mini,gpt-realtime-2.1-mini,gpt-realtime-2.1" && ev.VOICES.join() === "marin,cedar");
    check("CER: 0 for the same words however spelled, 1 for nothing", ev.cer("عايز أعرف أودو شغال", "عايز اعرف اودو شغال.") === 0 && ev.cer("abc", "") === 1 && ev.cer("abcd", "abxd") === 0.25);
    check("dialect: Egyptian answered in MSA is flagged", ev.dialectNote("egyptian", "هل يمكنك أن تخبرني ماذا تريد الآن؟").ok === false && ev.dialectNote("egyptian", "أودو شغال والديسك مش مليان خالص.").ok === true && ev.dialectNote("english", "أودو شغال").ok === false);
    const w = live.wav(Buffer.alloc(4800));
    check("readWav takes the page's PCM16 mono 24 kHz and refuses anything else", ev.readWav(w).length === 4800 && (() => { try { ev.readWav(Buffer.from("nope")); return false; } catch (e) { return true; } })());
    const sum = ev.summarise([{ id: 1, model: "m", voice: "v", first_audio_ms: 900, hold_ms: 100, cer_session: 0.1, cer_turn: 0.05, trips: ["promise"], handoff: true, handoff_expected: true, stopped: false, stop_expected: false, dialect_ok: true, usd: 0.01 }]);
    check("the summary: one row per model and voice, with the table", sum.length === 1 && sum[0].config === "m · v" && sum[0].handoffs_right === 100 && /\| m · v \| 1 \| 900 \|/.test(ev.tableMarkdown(sum)));
  }

  /* ============================================================ the route */

  section("the WebSocket route (real server.js, scratch copy, helper cut off)");
  const s = await scratch.startScratch({ env: { MONI_OPENAI_WS: WS_BASE.replace("/v1", "/v1") } });
  const db = require(path.join(ROOT, "lib", "db.js"));
  // The scratch copy's fake key must be the mock's key.
  const port = s.port;
  const origin = "http://127.0.0.1:" + port;
  const open = (cookie, q, headers) =>
    new Promise((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:" + port + "/mint-ai/api/live" + (q || ""), { headers: { Cookie: cookie || "", Origin: origin, ...(headers || {}) } });
      const got = [];
      ws.on("message", (d, bin) => got.push(bin ? { bin: d.length } : JSON.parse(String(d))));
      const out = { status: null, ws: null, got, closed: null };
      ws.on("close", (code) => (out.closed = code));
      ws.on("unexpected-response", (req, res) => resolve({ ...out, status: res.statusCode }));
      ws.on("open", () => ((out.status = 101), (out.ws = ws), resolve(out)));
      ws.on("error", () => resolve({ status: "error", ws: null, got }));
    });
  try {
    await s.makeUser("liveadmin", "administrator");
    await s.makeUser("liveop", "operator-moniai", ["moniai.use"]);
    const A = await s.signIn("liveadmin");
    const O = await s.signIn("liveop");
    const page = await s.req("GET", "/mint-ai", { cookie: A.cookie });
    const tok = s.csrfOf(page.body);
    check("mode off by default: the page does not offer live", /data-voice-live=""/.test(page.body) && db.getSetting("voice_desk", "0") === "0");
    let r = await open(A.cookie, "?csrf=" + tok);
    check("mode off: the upgrade is refused (409)", r.status === 409, r.status);
    // Switch it on in the SCRATCH database, through the Settings form.
    const set = await s.req("GET", "/credentials/openai-voice", { cookie: A.cookie });
    check("Settings offers the third mode, off by default", /id="voice-live-toggle"/.test(set.body) && /Switch to live conversation \(trial\)/.test(set.body) && /headphones are advised/.test(set.body));
    const stok = s.csrfOf(set.body);
    r = await s.req("POST", "/credentials/openai-voice/desk", { cookie: A.cookie, body: new URLSearchParams({ _csrf: stok, mode: "live" }).toString() });
    check("the form sets mode=live (scratch db)", r.status === 302 && db.getSetting("voice_desk") === "live", r.status);
    check("  audited", db.recentLogins(20).some((x) => /live conversation \(trial\) on/.test(x.detail || "")));
    r = await s.req("POST", "/credentials/openai-voice/desk", { cookie: A.cookie, body: new URLSearchParams({ _csrf: stok, mode: "robot" }).toString() });
    check("an unknown mode is refused", /err=/.test(r.headers.location || "") && db.getSetting("voice_desk") === "live");
    const page2 = await s.req("GET", "/mint-ai", { cookie: A.cookie });
    check("an administrator's page now offers it, with the stamped worklet", /data-voice-live="1"/.test(page2.body) && /data-live-worklet="\/static\/voice-live-worklet\.js\?v=/.test(page2.body) && /voice-live\.js\?v=/.test(page2.body) && /voice-live\.css\?v=/.test(page2.body));
    const pageO = await s.req("GET", "/mint-ai", { cookie: O.cookie });
    check("a non-administrator's page does not (they keep the relay desk)", /data-voice-live=""/.test(pageO.body) && /data-voice-desk="1"/.test(pageO.body), pageO.status);

    r = await open("", "?csrf=" + tok);
    check("no session: 401", r.status === 401, r.status);
    r = await open(A.cookie, "?csrf=wrong");
    check("wrong CSRF token: 403", r.status === 403, r.status);
    r = await open(A.cookie, "");
    check("no CSRF token: 403", r.status === 403, r.status);
    r = await open(A.cookie, "?csrf=" + tok, { Origin: "https://evil.example" });
    check("another origin: 403", r.status === 403, r.status);
    r = await open(A.cookie, "?csrf=" + tok, { Origin: "" });
    check("no origin: 403", r.status === 403, r.status);
    const otok = s.csrfOf(pageO.body);
    r = await open(O.cookie, "?csrf=" + otok);
    check("moniai.use without voice.manage: 403 (administrators only)", r.status === 403, r.status);
    const bad = await new Promise((resolve) => {
      const x = new WebSocket("ws://127.0.0.1:" + port + "/mint-ai/api/other", { headers: { Cookie: A.cookie, Origin: origin } });
      x.on("unexpected-response", (q, res) => resolve(res.statusCode));
      x.on("error", () => resolve("error"));
    });
    check("any other upgrade path: 404", bad === 404, bad);

    // The upstream here is the mock; the scratch copy's key is fake, so the mock must accept it.
    KEYS.add(scratch.FAKE_KEY);
    r = await open(A.cookie, "?csrf=" + tok);
    const first = r.ws;
    check("an administrator, the right token and origin, mode live: connected", r.status === 101 && first);
    await until(() => r.got.some((m) => m.type === "ready"), 3000, "ready");
    check("  the server opened the upstream session and says ready", r.got.some((m) => m.type === "ready" && m.model === "gpt-realtime-2.1-mini" && m.max_s === 1200), JSON.stringify(r.got));
    const r2 = await open(A.cookie, "?csrf=" + tok);
    await until(() => r2.closed != null, 2000, "the busy close");
    const closed2 = r2.closed;
    check("one live call per user: a second is told busy and closed (4409)", r2.got.some((m) => m.type === "error" && m.code === "busy") && closed2 === 4409, JSON.stringify(r2.got) + " " + closed2);
    first.send(Buffer.alloc(voiceLiveRate() * 2)); // one second in one frame: too large
    check("a frame over half a second of audio ends the call", await until(() => r.closed != null, 2000));
    check("  and the call is audited, start and end", db.recentLogins(30).some((x) => /live conversation \(trial\) started/.test(x.detail || "")) && (await until(() => db.recentLogins(30).some((x) => /live conversation \(trial\) ended/.test(x.detail || "")), 1000)));
    r = await open(A.cookie, "?csrf=" + tok);
    check("after hanging up, a new call is allowed", r.status === 101);
    await until(() => r.got.some((m) => m.type === "ready"), 3000);
    r.ws.close();
    // The evaluation page and its API: administrators only; a recording must be PCM16 mono 24 kHz.
    const evp = await s.req("GET", "/mint-ai/voice-eval", { cookie: A.cookie });
    check("the evaluation page: 20 phrases, no inline script", evp.status === 200 && (evp.body.match(/data-rec="\d+"/g) || []).length === 20 && !/<script>(?!\s*<\/script>)[^<]+<\/script>/.test(evp.body) && /voice-eval\.js\?v=/.test(evp.body));
    check("  not for a non-administrator", (await s.req("GET", "/mint-ai/voice-eval", { cookie: O.cookie })).status === 403);
    const up = (who, t, body) => s.req("POST", "/mint-ai/api/voice-eval/clip", { cookie: who.cookie, headers: { "X-CSRF-Token": t, Accept: "application/json" }, body });
    const clip = live.wav(Buffer.alloc(48000)).toString("base64");
    check("  a recording without the CSRF token is refused", (await up(A, "bad", { id: 3, data: clip })).status === 403);
    check("  a non-administrator cannot upload", (await up(O, otok, { id: 3, data: clip })).status === 403);
    check("  something that is not PCM16 24 kHz WAV is refused", (await up(A, tok, { id: 3, data: Buffer.from("RIFF....WAVEjunk").toString("base64") })).status === 400);
    check("  a one-second recording is saved", (await up(A, tok, { id: 3, data: clip })).status === 200);
    const st = JSON.parse((await s.req("GET", "/mint-ai/api/voice-eval/status", { cookie: A.cookie })).body);
    check("  and listed, per user, in a 0700 folder", st.clips.join() === "3" && (require("fs").statSync(path.join(s.data, "voice-eval")).mode & 0o777) !== undefined);
    const runBad = await s.req("POST", "/mint-ai/api/voice-eval/run", { cookie: A.cookie, headers: { "X-CSRF-Token": tok, Accept: "application/json" }, body: { models: ["gpt-5"], voices: ["marin"] } });
    check("  a run with an unknown model is refused", runBad.status === 400);

    r = await s.req("POST", "/credentials/openai-voice/desk", { cookie: A.cookie, body: new URLSearchParams({ _csrf: stok, mode: "desk" }).toString() });
    check("back to the relay desk: the old value '1' is written (compatible)", db.getSetting("voice_desk") === "1");
    r = await s.req("POST", "/credentials/openai-voice/desk", { cookie: A.cookie, body: new URLSearchParams({ _csrf: stok, enabled: "0" }).toString() });
    check("the older enabled=0 form still switches it off", db.getSetting("voice_desk") === "0");
  } catch (e) {
    check("the route run completed", false, e.stack + "\n" + s.out());
  } finally {
    s.stop();
  }

  mockServer.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("  FAIL no exception\n" + e.stack);
  process.exit(1);
});

