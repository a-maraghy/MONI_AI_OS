"use strict";
/**
 * Live conversation (M-3 Phase 1, option C of the full-duplex proposal;
 * since 2026-09-30 the only voice there is): the administrator talks and the voice answers at once, and can be
 * interrupted. The voice speaks AS MINT AI, in the first person (the
 * administrator, 2026-09-29: "you are MINT AI; don't say you delegate to MINT
 * AI"); its thinking and doing are the look_into call -- the supervisor --
 * so the speech model itself still never decides or acts.
 *
 *   browser mic ──PCM16 24 kHz──▶ this server ──▶ OpenAI realtime (speech to speech)
 *   browser speaker ◀──held, guarded PCM── this server ◀── its audio + transcript
 *
 * The browser talks only to this server (an authenticated WebSocket, see
 * server.js); the key never leaves it. One LiveCall per browser call, owning
 * one upstream realtime session with a fixed configuration:
 *
 *   - model gpt-realtime-2.1-mini, server VAD with 700 ms of silence (500 ms
 *     split an Egyptian greeting's pause into a false turn) at threshold 0.7,
 *     far-field noise reduction (configurable), and NEITHER create_response
 *     NOR interrupt_response: this server decides both (see "Self-hearing");
 *   - exactly two tools, read_status and look_into (it was ask_mint_ai until
 *     2026-09-29: speaking AS MINT AI, the audio model read that name aloud as
 *     «هسأل MINT»); any other name is refused
 *     here and never runs, and both go through voiceOps() (lib/voice-shared.js):
 *     `snapshot` and `send` only;
 *   - the instructions: the voice's rules, spoken, plus the language and persona
 *     line learned from how the administrator speaks (lib/voice-persona.js).
 *
 * Guard before sound. The model's audio arrives with its own transcript, a
 * little ahead of it (40-360 ms, measured 2026-09-29). Every audio chunk is
 * tagged with the sentence the transcript was in when the chunk arrived --
 * that sentence or a later one, since the transcript leads -- and is HELD here
 * until that sentence has passed the output guard (Releaser / judge(), with
 * the sentences before it, the Arabic rules, and fail-closed). On a cut, the
 * held audio is dropped, the response is cancelled, the item is truncated at
 * what was sent, and the safe line is read (in the cut sentence's language)
 * by the ordinary verbatim reader. The request is worked on (sent to MINT AI's supervisor) if it had
 * not been. What cannot be guaranteed: the guard reads the model's transcript
 * of its audio, not the audio itself (see the README).
 *
 * MINT AI's answers never come from the speech model. When MINT AI answers a
 * request passed on here, the reply goes through the guarded summary
 * (SUMMARY_INSTRUCTIONS -> judge()) and the verbatim reader, and is played into
 * the same stream; the realtime conversation is then told what was said.
 *
 * Hand-offs carry this server's own transcript of the turn -- a full-turn
 * gpt-4o-mini-transcribe of the audio this server relayed (or, failing that,
 * the session's own input transcription) that passed the transcript guard --
 * never the model's `text`. At most one per utterance.
 *
 * Barge-in: when the administrator really talks over the voice, the page is
 * told to flush what it has buffered (it answers with the millisecond it had
 * played), the response is cancelled, and the item truncated there. MINT AI
 * summaries being read stop too.
 *
 * Self-hearing (2026-09-29: laptop speakers leaked into the microphone and the
 * voice kept interrupting itself). Three layers:
 *   - "speakers" mode (half-duplex, the default until the page's echo-cancelled
 *     playback is proven): while anything is audible, and for TAIL_MS after,
 *     the microphone's audio is not relayed at all. The administrator
 *     interrupts with a tap, Space or Esc (the page sends "interrupt").
 *   - "full" mode (headphones): the upstream VAD's speech_started while the
 *     voice is audible is only a CANDIDATE; the barge-in happens when the page
 *     also reports sustained voice above the speaker's leak
 *     (public/voice-live-detect.js). Speech that stops first is not one.
 *   - Before any answer: a turn heard during (or just after) playback that
 *     was not a confirmed barge-in, and whose transcript is empty or one or
 *     two words, is the speaker's leak ("echo-leak"): no response is created,
 *     nothing is paid for it, and its item is deleted while it is still the
 *     last one. Responses are created here (create_response off) only for
 *     turns that passed. Two such leaks within 10 s in full mode make the page
 *     suggest speakers mode.
 *
 * Also here: the echo guard (a transcript that matches what the voice just
 * said is dropped: the speaker leaking into the mic), the spoken stop command
 * (public/voice-stop.js: ends the call), usage per response priced into the
 * voice_usage table under the category "live", and a 20-minute cap.
 *
 * Pure of I/O except through what it is given (tests pass fakes).
 */

const WebSocket = require("ws");
const desk = require("./voice-shared"); // the guard, the fixed lines, the supervisor door (was voice-desk.js)
const voiceGuard = require("./voice-guard");
const personaLib = require("./voice-persona");
const usageLib = require("./voice-usage");
const arabic = require("./voice-arabic");
const UiActions = require("../public/ui-actions");
const UI_ACK_MS = 3000; // a page action the tab has not confirmed by then did not happen
const UI_END_MAX_MS = 8000; // call.end: the goodbye may be said, then the call ends regardless

const LIVE_MODEL = "gpt-realtime-2.1-mini";
const RATE = 24000;
const BYTES_PER_MS = (RATE * 2) / 1000; // 48
const SILENCE_MS = 700;
const MAX_CALL_MS = 20 * 60 * 1000;
const KEEP_INPUT_MS = 90 * 1000; // the relayed audio kept for full-turn transcripts
const HEARD_WAIT_MS = 6000; // how long a hand-off waits for the turn's transcript
const REPLY_POLL_MS = 2000;
const REPLY_WATCH_MS = 30 * 60 * 1000;
const TRUNCATE_WAIT_MS = 400;
const ECHO_WINDOW_MS = 30 * 1000;
const VAD_THRESHOLD = 0.7; // 0.5 (the default) fired on the speaker's leak
const NOISE_REDUCTION = ["far_field", "near_field", "off"];
const DUPLEX = ["speakers", "full"];
const TAIL_MS = 300; // speakers mode: the room's tail after the voice stops
const LEAK_AFTER_MS = 1500; // a turn starting this soon after playback is still suspect
const TRANSCRIPT_WAIT_MS = 3000; // a turn with no transcript by then: answered (or dropped if suspect)
const SUGGEST_WINDOW_MS = 10 * 1000;
const ECHO_LEAK_WORDS = 2;
const FAST_MIN_MS = 450; // a turn this long, nowhere near the voice, is answered at once (no wait for its transcript)
const MAX_ROUNDS = 4;
const MAX_ASK_CHARS = 2000;
const VERBATIM_MAX_SENTENCES = 8;
const REPLY_IN_CONTEXT_CHARS = 1500;
const WS_BASE = process.env.MONI_OPENAI_WS || "wss://api.openai.com/v1";
/*
 * Keeping the upstream leg alive (2026-09-30: 13 calls ended "upstream"; the
 * firewall showed OpenAI's IPv6 packets arriving 13-21 s after our side's TCP
 * connection had died, so the drop was ours or the path's, not OpenAI's):
 *   - IPv4 only for the OpenAI WebSocket (MONI_OPENAI_IPV4=0, or cfg.ipv4 =
 *     false, goes back to the resolver's choice);
 *   - a ping every KEEPALIVE_MS; a leg that has answered nothing (no pong, no
 *     event) for KEEPALIVE_DEAD_MS is dead and is replaced at once;
 *   - an unexpected close is reconnected (swapUpstream) with a recap of the
 *     last lines, and the voice says it is back -- at most RECONNECT_PER_MIN
 *     times a minute, then the call ends with the reason shown;
 *   - opening a session is tried twice (OPEN_TRIES), OPEN_RETRY_MS apart.
 */
const FORCE_IPV4 = process.env.MONI_OPENAI_IPV4 !== "0";
const KEEPALIVE_MS = 10 * 1000;
const KEEPALIVE_DEAD_MS = 25 * 1000;
const RECONNECT_PER_MIN = 2;
const OPEN_TRIES = 2;
const OPEN_RETRY_MS = 800;
const RECAP_LINES = 6;
const EARLIER_MS = 45 * 1000; // a result arriving this long after its ask (or after newer words) is introduced
// What the page may say when it ends a call ({type: "end", why}); anything else is logged as "unspecified".
const END_WHY = /^(?:button|esc|mic|navigate|unload|track-ended|devicechange|voice-changed|error:[^\u0000-\u001f]{0,80})$/;
const BACK_LINE = { en: "The line dropped for a second — I'm back.", ar: "الخط قطع لثانية، وأنا معاك تاني." };
const RECONNECTED_LINE = { en: "Reconnected.", ar: "الاتصال رجع، وأنا معاك." };
const EARLIER_LINE = { en: "About your earlier question:", ar: "بخصوص سؤالك اللي فات:" };

const TOOLS = [
  {
    type: "function",
    name: "read_status",
    description:
      "Read a fresh, read-only snapshot of this VPS: services and their state, disk, memory, CPU and load, the live Claude sessions, " +
      "your own state, active missions with their steps, open decisions and pending approvals (counts and titles only). " +
      "Call it before answering any question about the machine. It knows nothing else: not Odoo's data, not backups, not logs, not files.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "look_into",
    description:
      "Your own thinking and doing: work on the administrator's request properly (look into it, reason about it, act on it) -- it takes a while, and your result arrives later. " +
      "Use it for anything that is not answered by the snapshot, for every action or change on the machine of any kind (delete, restart, push, deploy, " +
      "approve, deny, fix, run, send), and whenever you are unsure. Never for this screen: dark or light mode, the voice, the voice persona, panels, the core -- those are ui_action. " +
      "When the result arrives it is read to the administrator in your voice, as a checked summary or word for word.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The request, in the administrator's own words as closely as possible." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];
// Screen control (UI control Phase 1, 2026-09-29): the third tool, from the shared allowlist.
TOOLS.push(UiActions.tool());
Object.freeze(TOOLS);
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const INSTRUCTIONS = [
  "You are the voice of MINT AI, the assistant that runs this VPS, in a live spoken conversation with the administrator. You speak; you are heard at once. You speak as MINT AI, in the first person (\"I\"): one identity.",
  "You never work anything out yourself and you never act on the machine. You do exactly four things:",
  "1. Answer questions about the machine's current state, but ONLY from the read_status tool. Call read_status first, then answer from it and nothing else. Quote figures exactly as the snapshot gives them.",
  "2. Hand everything else to your own deeper work by CALLING the look_into tool first; its output tells you what to say.",
  "3. Small talk: a greeting, thanks, \"how are you\", \"can you hear me\" get one short, friendly, honest sentence, with nothing about the machine in it.",
  "4. This screen: anything about what the administrator sees here -- dark or light mode, the voice, the Arabic voice persona, a panel, the core, the voice mode, this call -- is done by CALLING the ui_action tool, never look_into. Examples:",
  "   \"Switch to dark mode\" / \"dark mode please\" / «خلّيها دارك» / «حوّلي للوضع الليلي» -> ui_action action=theme.set theme=dark; \"light mode\" / «خلّيها لايت» -> theme.set theme=light; \"follow the system theme\" -> theme.set theme=system.",
  "   \"Change the voice to cedar\" / «غيّري الصوت لـ cedar» -> ui_action action=voice.set voice=cedar (after their confirm this call reconnects by itself and I speak in the new voice).",
  "   «خلّيكي مصرية بنت» / \"speak as an Egyptian woman\" -> ui_action action=persona.set preset=cairene_f; «خلّيك مصري ولد» / \"Egyptian man\" -> preset=cairene_m; \"formal Arabic\" / «فصحى» -> preset=msa_n; \"learn from how I speak\" -> preset=learned.",
  "   \"Open the missions\" -> action=sheet.open key=missions; \"close the missions\" / «اقفلي المهام» -> action=sheet.close key=missions.",
  "   Another page of Mint OS: \"open the OS dashboard\" / «افتحلي الـ OS dashboard» -> action=page.open page=os-overview; \"the agents dashboard\" -> page=agents; \"the Telegram agents\" -> page=agents-fleet; \"users\" -> page=manage-users. " +
    "It opens in the Command Center's frame at once and this live call carries on there: say in one short sentence that it is open.",
  "Only a look_into call starts any checking: never say you are checking or looking into something unless you called it (or a request is still being worked on).",
  "Hard rules:",
  "- If the answer is not in the snapshot, do not guess: call look_into right away.",
  "- Every request to do or change something on the machine goes to look_into. You cannot do anything to the machine yourself. Requests about this screen (rule 4) go to ui_action.",
  "- Never say that anything was done, deleted, restarted, pushed, approved or fixed, or that it is being done, and never promise that it will be -- unless your result says so.",
  "- Before your result arrives, never say what you found. Your results are read to the administrator separately, word for word or as a checked summary; you are then told what was said. Do not read them out again; if asked, say the details are on screen.",
  "- Never say you passed, sent, forwarded or delegated anything, and never speak of MINT AI as someone else.",
  "- Never quote a number that is not in the snapshot.",
  "- Approvals and decisions are for the administrator to make in the Command Center; you cannot approve or deny anything.",
  "- Before a tool call say nothing, or at most a two-word acknowledgement.",
  "- The screen: when the administrator asks you to change what they see on this Command Center (open or close a panel, show the missions, the last reply or the waiting card, switch the core or the voice mode, end or mute this call, stop reading), call ui_action. " +
    "Say what you did only after it returns ok (\"I opened Missions.\"). You cannot approve, deny or change other settings with it, and you can mute but never unmute. " +
    "Closing a panel (\"close the missions\", «اقفلي المهام», «اقفل الميشنز») is sheet.close, never ending the call; the panel names in Arabic are in the tool's description. " +
    "Changing the theme (theme.set), the Arabic voice persona (persona.set) or the voice's sound (voice.set) also goes through ui_action, but it only ASKS: the result is status confirm and nothing has changed. " +
    "Then say only the waiting line (below): \"Waiting for your confirmation.\" Never tell them to say yes, never say you set, changed or switched it, and never say yes or no yourself while it waits.",
  "While a request is being worked on you may keep talking naturally: acknowledge, say in general terms what you are looking at, ask a clarifying question, make small talk, or help the administrator draft or structure a report from what they tell you -- without inventing progress or results.",
  "Style: one or two short spoken sentences. If the administrator starts talking, stop and listen.",
].join("\n");

function instructionsFor(persona) {
  const w = personaLib.waitingLine(persona);
  return INSTRUCTIONS + "\nThe waiting line, after a confirm is asked: \"" + w.en + "\" (only if they speak Arabic: «" + w.ar + "»)." + "\n" + personaLib.liveNote(persona);
}

/* ------------------------------------------------------------ helpers -- */

function scrub(text) {
  return String(text == null ? "" : text)
    .replace(/\bsk-[A-Za-z0-9_\-*.]{4,}/g, "sk-…")
    .replace(/(Bearer\s+)\S+/gi, "$1…")
    .slice(0, 300);
}

/**
 * The sentence the transcript is in right now: the last one with any words in
 * it. Audio that arrives now belongs to that sentence or an earlier one (the
 * transcript leads the audio), so holding it until this one is released is safe.
 */
function audioTag(text) {
  const complete = desk.sentencesOf(text, false).length;
  const all = desk.sentencesOf(text, true).length;
  return all > complete ? complete : Math.max(0, complete - 1);
}

/** A WAV around PCM16 mono 24 kHz, for the full-turn transcription. */
function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** MINT AI's reply as sentences to read aloud: no code, no links, no markup. */
function speakableSentences(reply) {
  const t = String(reply || "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]+`/g, (m) => m.replace(/`/g, ""))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*[#>]+\s*/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return desk.sentencesOf(t, true);
}

let callSeq = 0;

/* ------------------------------------------------------------ the call -- */

/**
 * One live call.
 *
 * deps:
 *   cfg        { key, voice, model (the reader's), transcribe_model, live_model?, wsBase? }
 *   actor      the panel user (username); userId for the persona
 *   ops        voiceShared.voiceOps(moniai.call, actor) -- the only supervisor door
 *   client     { json(obj), audio(seg, pcmBuffer), close(code, why) } -- the browser
 *   persona()  the saved persona; hearPersona(text) -> the persona after that utterance
 *   speak      voice.speakStream (the verbatim reader)
 *   transcribe voice.transcribeFull(audio, cfg, mime)
 *   summarise  (turnId, {onLine, persona, request, lastSaid}) -> the guarded summary
 *              (voiceShared.summariserFor(...).summarise)
 *   record     ({vt, cat, part, model, tokens}) -> usd
 *   isStop     (text) -> the spoken stop command (public/voice-stop.js)
 *   isUndo     (text) -> the spoken undo command (the same file); acted on
 *              only while the page says its last screen action can be undone
 *   log, now, opts: { maxMs, silenceMs, handoff: "turn" | "session", pollMs }
 */
class LiveCall {
  constructor(deps) {
    const d = deps || {};
    this.d = d;
    this.cfg = d.cfg || {};
    this.model = this.cfg.live_model || LIVE_MODEL;
    this.opts = { maxMs: MAX_CALL_MS, silenceMs: SILENCE_MS, handoff: "turn", pollMs: REPLY_POLL_MS, ...(d.opts || {}) };
    this.now = d.now || Date.now;
    this.log = d.log || (() => {});
    this.id = "lv" + (++callSeq).toString(36) + Math.random().toString(36).slice(2, 6);
    this.ws = null;
    this.ready = null;
    this.closed = false;
    this.muted = false;
    this.bornAt = this.now();
    this.persona = personaLib.clean(d.persona ? d.persona() : null);
    // the relayed audio: [{at (ms from the call's start), buf}]
    this.input = [];
    this.inputMs = 0;
    this.turns = new Map(); // user item id -> turn
    this.turnSeq = 0;
    this.lastTurn = null;
    this.resp = null;
    this.segSeq = 0;
    this.segs = new Map(); // seg -> { kind, itemId, sentBytes, playedMs }
    this.played = new Map(); // seg -> ms the page has played
    this.speechChain = Promise.resolve();
    this.speechGen = 0;
    this.speechBusy = 0;
    this.requests = new Map(); // MINT AI turn id -> { text, answered }
    this.replies = [];
    this.heard = [];
    this.snapshotText = "";
    this.groundedAt = 0;
    this.spoken = []; // [{text, at}] what the voice said, for the echo guard
    this.timers = new Set();
    this.usd = 0;
    this.duplex = DUPLEX.includes(this.opts.duplex) ? this.opts.duplex : "speakers";
    this.noise = NOISE_REDUCTION.includes(this.cfg.noise_reduction) ? this.cfg.noise_reduction : "far_field";
    this.playStartAt = null; // when the current stretch of audible voice began
    this.lastAudibleAt = 0;
    this.pendingBarge = null; // { turn, at, sincePlay }: VAD heard speech over the voice, not yet confirmed
    this.voiceOn = false; // the page's detector: sustained voice above the speaker's leak
    this.voiceOnAt = 0;
    this.queued = null; // a turn to answer once the cancelled response has finished
    this.billed = new Set(); // response ids already recorded (response.done can arrive twice)
    this.leaks = []; // times of echo-leak turns, for the speakers-mode suggestion
    this.suggested = false;
    this.uiLimit = UiActions.limiter();
    this.uiPending = new Map(); // nonce -> resolve (the page's ui-ack)
    this.endAfterSpeech = 0; // call.end: when it was asked
    this.undoUntil = 0; // the page's last screen action can be undone until then (ui-undoable)
    this.diag = { ui: [], responses: 0, trips: [], bargeIns: [], candidates: [], held: [], firstAudio: [], echoes: 0, leaks: 0, stops: 0, refused: [], handoffs: [], transcripts: [], gatedMs: 0, dupUsage: 0, created: 0, drops: [], merged: 0 };
    this.recap = []; // [{who: "you" | "me", text}]: the last lines, for a new upstream session
    this.drops = []; // when the upstream leg dropped (the per-minute cap)
    this.keepT = null;
    this.endWhy = null; // { why, detail } once ended
    this.state = "connecting";
  }

  /* ---- plumbing ---- */

  timer(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }
  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
  toClient(obj) {
    if (!this.closed) this.d.client.json(obj);
  }
  setState(s, extra) {
    if (this.closed) return;
    if (this.muted && s !== "muted" && s !== "ended") s = "muted";
    this.state = s;
    this.toClient({ type: "state", state: s, ...(extra || {}) });
  }
  record(row) {
    try {
      const usd = this.d.record ? this.d.record({ cat: "live", actor: this.d.actor, ...row }) || 0 : 0;
      this.usd += usd;
      return usd;
    } catch (e) {
      this.log("live: could not record usage: " + e.message);
      return 0;
    }
  }

  /**
   * The upstream session is replaced and the call goes on -- the same page,
   * its socket, microphone and playback, the same mode, persona, mute and
   * noise settings. What was playing stops; the old session is closed quietly;
   * the new one gets a note of what happened and a recap of the last lines.
   * Two reasons (o.reason):
   *   "voice" (the default): a new voice (or key, or listening model) while the
   *     call is open. With `greet`, the voice says one short line in its new
   *     voice (a true claim: the change is applied);
   *   "drop": the upstream leg closed unexpectedly (upstreamLost); the voice
   *     says the line dropped and it is back.
   * Opening is tried OPEN_TRIES times. Returns { ok, ms } -- ms from the swap
   * to the new session being ready.
   */
  async swapUpstream(patch, o) {
    o = o || {};
    if (this.closed) return { ok: false, why: "the call has ended" };
    const drop = o.reason === "drop";
    const t0 = this.now();
    const was = this.cfg.voice;
    this.cfg = { ...this.cfg, ...(patch || {}) };
    this.model = this.cfg.live_model || LIVE_MODEL; // the voice model may have changed too
    this.speechGen++;
    this.toClient({ type: "flush", at: this.now() });
    for (const s of this.segs.values()) s.over = true;
    const old = this.ws;
    this.ws = null;
    this.ready = null;
    this.resp = null;
    this.pendingRound = null;
    this.queued = null;
    this.pendingBarge = null;
    this.stopKeepalive();
    try {
      if (old) old.close(1000, drop ? "replaced" : "voice changed");
    } catch (_) {
      /* already gone */
    }
    this.setState("connecting");
    try {
      await this.connect();
    } catch (e) {
      if (!this.closed) this.close("upstream", (drop ? "The connection to OpenAI dropped and could not be restored: " : "Could not reconnect with the new voice: ") + scrub(e.message), "reconnect failed");
      return { ok: false, why: e.message };
    }
    if (this.closed) return { ok: false, why: "the call has ended" };
    const ms = this.now() - t0;
    if (drop) this.diag.drops.push({ ms, why: o.why || "" });
    else this.diag.swaps = (this.diag.swaps || []).concat([{ ms, voice: this.cfg.voice }]);
    this.log(drop ? `live: call ${this.id} upstream reconnected in ${ms} ms` : `live: call ${this.id} reconnected with voice ${this.cfg.voice} (was ${was}) in ${ms} ms${o.greet ? ", greeting" : ""}`);
    // The new session knows nothing of the old one: tell it what just happened, and the last lines.
    const what = drop ? "the connection dropped for a moment and was restored; this is the same conversation" : "the voice was just changed to " + this.cfg.voice + " at the administrator's request, after their confirmation. The conversation goes on";
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "(System note, not the administrator speaking: " + what + "." + this.recapText() + ")" }] } });
    if (drop) this.toClient({ type: "reconnected", ms });
    else this.toClient({ type: "voice-changed", voice: this.cfg.voice, greet: !!o.greet, ms });
    if (this.muted) this.setState("muted");
    else this.setState(this.anyPending() ? "waiting" : "listening");
    const lang = desk.langOf(this.heard.length ? this.heard[this.heard.length - 1] : "", "");
    if (drop) this.sayFixed(lang === "ar" ? BACK_LINE.ar : BACK_LINE.en, "the back line");
    else if (o.greet) {
      const line = voiceChangedLine(lang, this.persona);
      const g = desk.judge(desk.sentencesOf(line, true), { uiOk: true });
      if (g.ok) {
        this.send({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: line }] } });
        this.say([{ text: line, safe: true }], "safe", null);
      } else this.log("live: the new-voice line did not pass the guard (" + g.rule + "); not said");
    }
    return { ok: true, ms };
  }

  /** A call the page reconnected after the dashboard restarted (?resume=restart): the voice says so, once. */
  sayReconnected(lang) {
    return this.sayFixed(lang === "ar" ? RECONNECTED_LINE.ar : RECONNECTED_LINE.en, "the reconnected line");
  }

  /**
   * A fixed line of this server's own (not the model's): it is put in the
   * realtime conversation as the voice's, and read by the verbatim reader.
   * Judged like the voice's words; a line that does not pass is not said --
   * except a screen confirmation (o.trusted): it is built only from the
   * action's toast and the page map's labels ("Opened MINT AI Settings."),
   * which the third-person rule would otherwise take for MINT AI as someone else.
   */
  sayFixed(line, what, turn, o) {
    if (this.closed || !line) return false;
    const g = o && o.trusted ? { ok: true } : desk.judge(desk.sentencesOf(line, true), { uiOk: true });
    if (!g.ok) {
      this.log(`live: ${what || "a fixed line"} did not pass the guard (${g.rule}); not said`);
      return false;
    }
    this.send({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: line }] } });
    this.say([{ text: line, safe: true }], "safe", turn || null);
    return true;
  }

  /** The last few lines heard and said, for a new upstream session (short, most recent last). */
  recapText() {
    const lines = this.recap.slice(-RECAP_LINES);
    if (!lines.length) return "";
    return " The last lines, most recent last: " + lines.map((l) => (l.who === "you" ? "Administrator: " : "You: ") + JSON.stringify(String(l.text).slice(0, 200))).join(" / ");
  }
  addRecap(who, text) {
    const t = String(text || "").trim();
    if (!t) return;
    this.recap.push({ who, text: t });
    if (this.recap.length > 12) this.recap.shift();
  }

  /** open(), tried OPEN_TRIES times (a connect failure is retried once). */
  async connect() {
    const tries = Math.max(1, this.opts.openTries || OPEN_TRIES);
    let last = null;
    for (let i = 0; i < tries; i++) {
      if (this.closed) throw new Error("the call has ended");
      if (i) {
        await new Promise((r) => this.timer(r, this.opts.openRetryMs != null ? this.opts.openRetryMs : OPEN_RETRY_MS));
        if (this.closed) throw new Error("the call has ended");
        this.log(`live: call ${this.id} retrying the upstream connection (${last && last.message})`);
      }
      try {
        return await this.open();
      } catch (e) {
        last = e;
        this.ws = null;
        this.ready = null;
      }
    }
    throw last || new Error("could not connect");
  }

  /** IPv4 only for the OpenAI WebSocket (on by default; see FORCE_IPV4). */
  ipv4() {
    return this.cfg.ipv4 != null ? !!this.cfg.ipv4 : FORCE_IPV4;
  }

  stopKeepalive() {
    if (this.keepT) clearInterval(this.keepT);
    this.keepT = null;
  }

  /**
   * Open the upstream session with the fixed configuration. Everything about
   * how it ends is logged (close code and reason, the socket error's code, the
   * last event it sent); an unexpected end of the current session goes to
   * upstreamLost().
   */
  open() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const base = this.cfg.wsBase || WS_BASE;
      const ws = (this.ws = new WebSocket(base + "/realtime?model=" + encodeURIComponent(this.model), {
        headers: { Authorization: "Bearer " + this.cfg.key },
        handshakeTimeout: 10000,
        perMessageDeflate: false,
        ...(this.ipv4() ? { family: 4 } : {}),
      }));
      const up = { at: this.now(), heardAt: this.now(), last: "none", err: "" };
      let opened = false;
      let gone = false;
      // Only the current session can end the call; one replaced by swapUpstream() goes quietly.
      const lost = (detail) => {
        if (gone) return;
        gone = true;
        if (ws === this.ws) this.stopKeepalive();
        if (ws !== this.ws || this.closed) return !opened && reject(new Error("replaced"));
        const secs = Math.round((this.now() - up.at) / 1000);
        this.log(`live: call ${this.id} upstream ${opened ? "lost" : "failed"}: ${detail}${up.err ? ", " + up.err : ""}, after ${secs} s, last event ${up.last}`);
        const why = opened
          ? "OpenAI closed the live session (" + detail + ")"
          : /^HTTP (\d+)/.test(detail)
            ? "OpenAI refused the live session (" + detail.slice(5) + ")"
            : "Could not reach OpenAI (" + (up.err || detail) + ")";
        if (!opened) return reject(new Error(why));
        this.upstreamLost(why);
      };
      ws.on("unexpected-response", (req, res) => {
        lost("HTTP " + res.statusCode);
        try {
          req.destroy();
        } catch (_) {
          /* gone */
        }
      });
      ws.on("error", (e) => {
        up.err = "error " + ((e && e.code) || "") + " " + scrub((e && e.message) || "").slice(0, 120);
        up.err = up.err.replace(/\s+/g, " ").trim();
      });
      ws.on("close", (code, reason) => lost("code " + code + (reason && reason.length ? ' "' + scrub(String(reason)).slice(0, 120) + '"' : "")));
      ws.on("pong", () => (up.heardAt = this.now()));
      ws.on("open", () => this.send({ type: "session.update", session: this.sessionConfig() }));
      ws.on("message", (data) => {
        if (ws !== this.ws) return;
        up.heardAt = this.now();
        let ev;
        try {
          ev = JSON.parse(String(data));
        } catch (_) {
          return;
        }
        up.last = String(ev.type || "?").slice(0, 60);
        if (!opened) {
          if (ev.type === "session.updated") {
            opened = true;
            this.sessionAt = this.now();
            if (!this.maxTimer) this.maxTimer = this.timer(() => this.close("max-length", "The live conversation reached its 20-minute limit."), this.opts.maxMs);
            this.startKeepalive(ws, up);
            this.setState("listening");
            return resolve(this);
          }
          if (ev.type === "error") {
            up.err = "OpenAI error " + scrub((ev.error && (ev.error.code || ev.error.message)) || "");
            this.log(`live: call ${this.id} OpenAI refused the session: ${scrub((ev.error && ev.error.message) || "OpenAI error")}`);
            gone = true;
            try {
              ws.close(1000, "refused");
            } catch (_) {
              /* closed */
            }
            return reject(new Error(scrub((ev.error && ev.error.message) || "OpenAI error")));
          }
          return;
        }
        try {
          this.onUpstream(ev);
        } catch (e) {
          this.log("live: event " + ev.type + " failed: " + e.message);
        }
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  /** A ping on the upstream leg every KEEPALIVE_MS; silence for KEEPALIVE_DEAD_MS ends it (and the call reconnects). */
  startKeepalive(ws, up) {
    this.stopKeepalive();
    const every = this.opts.keepaliveMs || KEEPALIVE_MS;
    const dead = this.opts.keepaliveDeadMs || KEEPALIVE_DEAD_MS;
    this.keepT = setInterval(() => {
      if (ws !== this.ws || this.closed) return this.stopKeepalive();
      if (ws.readyState !== WebSocket.OPEN) return;
      if (this.now() - up.heardAt > dead) {
        this.log(`live: call ${this.id} upstream silent for ${Math.round((this.now() - up.heardAt) / 1000)} s (no pong, no event); dropping it`);
        up.err = "no answer to pings";
        try {
          ws.terminate();
        } catch (_) {
          /* gone */
        }
        return;
      }
      try {
        ws.ping();
      } catch (_) {
        /* closing */
      }
    }, every);
    if (this.keepT.unref) this.keepT.unref();
  }

  /**
   * The current upstream session ended without being asked to: reconnect with
   * a recap and say so -- unless it has dropped RECONNECT_PER_MIN times in the
   * last minute already, then the call ends with the reason shown.
   */
  upstreamLost(why) {
    if (this.closed) return;
    const now = this.now();
    this.drops = this.drops.filter((t) => now - t < 60 * 1000);
    const cap = this.opts.reconnectPerMin != null ? this.opts.reconnectPerMin : RECONNECT_PER_MIN;
    if (this.opts.reconnect === false || this.drops.length >= cap) {
      if (this.drops.length >= cap && cap > 0) this.log(`live: call ${this.id} upstream dropped ${this.drops.length + 1} times within a minute; ending the call`);
      return this.close("upstream", this.drops.length >= cap && cap > 0 ? "The connection to OpenAI dropped " + (this.drops.length + 1) + " times within a minute. Start the call again when the line is steadier." : why, why);
    }
    this.drops.push(now);
    this.toClient({ type: "reconnecting", why: "upstream" });
    this.swapUpstream(null, { reason: "drop", why }).catch((e) => this.close("upstream", "Could not reconnect: " + scrub(e.message)));
  }

  sessionConfig() {
    return {
      type: "realtime",
      instructions: instructionsFor(this.persona),
      output_modalities: ["audio"],
      tools: TOOLS,
      tool_choice: "auto",
      max_output_tokens: 1200,
      audio: {
        input: {
          format: { type: "audio/pcm", rate: RATE },
          noise_reduction: this.noise === "off" ? null : { type: this.noise },
          turn_detection: { type: "server_vad", threshold: this.opts.vadThreshold || VAD_THRESHOLD, silence_duration_ms: this.opts.silenceMs, prefix_padding_ms: 300, create_response: false, interrupt_response: false },
          // Always an OpenAI model (a realtime session takes no other); a pinned language goes with it.
          transcription: { model: this.cfg.transcribe_model || "gpt-4o-mini-transcribe", ...(this.cfg.transcribe_language === "ar" || this.cfg.transcribe_language === "en" ? { language: this.cfg.transcribe_language } : {}) },
        },
        output: { format: { type: "audio/pcm", rate: RATE }, voice: this.cfg.voice || "marin" },
      },
    };
  }

  /**
   * End the call. why: the category the logs and the page use (hung-up,
   * upstream, voice-command, mint-ended, max-length, page-closed, restarting,
   * signed-out, ...); text: what the page shows; detail: a short note for the
   * log only (the page's end reason, a close code, the stop phrase).
   */
  close(why, text, detail) {
    if (this.closed) return;
    this.endWhy = { why: why || "ended", detail: detail ? String(detail).slice(0, 120) : "" };
    this.toClient({ type: "ended", why: why || "ended", text: text || undefined });
    this.closed = true;
    this.speechGen++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.stopKeepalive();
    try {
      if (this.ws) this.ws.close();
    } catch (_) {
      /* closed */
    }
    try {
      this.d.client.close(1000, why || "ended");
    } catch (_) {
      /* gone */
    }
    this.log(`live: call ${this.id} ended (${why}${this.endWhy.detail ? ": " + this.endWhy.detail : ""}) after ${Math.round((this.now() - this.bornAt) / 1000)} s, $${this.usd.toFixed(4)}`);
  }

  /* ---- from the browser ---- */

  /** PCM16 mono 24 kHz from the page's microphone. */
  audioIn(buf) {
    if (this.closed || this.muted || !buf || !buf.length || buf.length % 2) return;
    const audible = this.audibleNow();
    if (this.duplex === "speakers" && (audible || this.now() - this.lastAudibleAt < TAIL_MS)) {
      // Half-duplex: the microphone is not heard while the voice speaks.
      this.diag.gatedMs += buf.length / BYTES_PER_MS;
      return;
    }
    this.input.push({ at: this.inputMs, buf });
    this.inputMs += buf.length / BYTES_PER_MS;
    while (this.input.length && this.input[0].at < this.inputMs - KEEP_INPUT_MS) this.input.shift();
    this.send({ type: "input_audio_buffer.append", audio: buf.toString("base64") });
  }

  /** A control message from the page. */
  message(m) {
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "played": {
        const seg = Number(m.seg);
        const ms = Number(m.ms);
        if (this.segs.has(seg) && Number.isFinite(ms) && ms >= 0) this.played.set(seg, ms);
        break;
      }
      case "flushed": {
        const seg = Number(m.seg);
        if (this.segs.has(seg) && Number.isFinite(Number(m.ms))) this.played.set(seg, Number(m.ms));
        const b = this.diag.bargeIns[this.diag.bargeIns.length - 1];
        if (b && !b.flushedAt) b.flushedAt = this.now();
        if (this.pendingTruncate) this.pendingTruncate();
        break;
      }
      case "mute":
        this.mute(!!m.on);
        break;
      case "voice":
        // The page's detector (public/voice-live-detect.js).
        this.voiceOn = !!m.on;
        if (this.voiceOn) {
          this.voiceOnAt = this.now();
          if (this.pendingBarge) this.confirmBarge("voice");
        }
        break;
      case "interrupt":
        // A tap, Space or Esc while the voice speaks.
        if (this.audibleNow() || this.resp_active()) {
          this.log(`live: interrupted by the administrator (${this.duplex} mode, +${this.sincePlay()} ms into playback)`);
          this.pendingBarge = null;
          this.bargeIn("tap");
          this.setState("listening");
        }
        break;
      case "duplex":
        this.setDuplex(m.mode);
        break;
      case "ui-undoable":
        this.undoUntil = Number(m.ms) > 0 ? this.now() + Math.min(60000, Number(m.ms)) : 0;
        break;
      case "ui-ack": {
        const done = this.uiPending.get(String(m.nonce || ""));
        if (done) done({ ok: !!m.ok, why: typeof m.why === "string" ? m.why.slice(0, 200) : "" });
        break;
      }
      case "end": {
        // The page says why ({type: "end", why}): the red button, a mic track that ended, leaving the page...
        const w = typeof m.why === "string" ? m.why.replace(/[\u0000-\u001f]/g, " ").slice(0, 90) : "";
        this.close("hung-up", undefined, END_WHY.test(w) ? w : "unspecified");
        break;
      }
      default:
        break;
    }
  }

  setDuplex(mode) {
    if (!DUPLEX.includes(mode) || mode === this.duplex || this.closed) return;
    this.duplex = mode;
    this.pendingBarge = null;
    this.log(`live: call ${this.id} switched to ${mode} mode`);
    this.toClient({ type: "duplex", mode });
  }

  mute(on) {
    if (this.closed) return;
    this.muted = on;
    if (on) this.send({ type: "input_audio_buffer.clear" });
    this.setState(on ? "muted" : "listening");
  }

  /* ---- from OpenAI ---- */

  onUpstream(ev) {
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        return this.speechStarted(ev);
      case "input_audio_buffer.speech_stopped":
        return this.speechStopped(ev);
      case "conversation.item.input_audio_transcription.completed":
        return this.sessionTranscript(ev);
      case "conversation.item.input_audio_transcription.failed": {
        const t = this.turnFor(ev.item_id);
        t.sessionFailed = true;
        if (!t.sessionText) t.resolveSession(null);
        if (this.suspect(t)) this.drop(t, "echo-leak");
        else this.answer(t);
        return;
      }
      case "response.created":
        return this.responseCreated(ev);
      case "response.output_item.added":
        if (this.resp && ev.item && ev.item.type === "message") this.resp.itemId = ev.item.id;
        return;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (!this.resp || this.resp.cancelled) return;
        this.resp.text += ev.delta || "";
        return this.release(false);
      case "response.output_audio.delta":
      case "response.audio.delta":
        return this.audioOut(ev);
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        return this.transcriptDone(ev);
      case "response.done":
        return this.responseDone(ev);
      case "error": {
        const msg = String((ev.error && (ev.error.message || ev.error.code)) || "");
        if (/cancel|no active response|already|not found/i.test(msg)) return; // a late cancel or truncate: harmless
        this.log("live: OpenAI error: " + scrub(msg));
        return;
      }
      default:
        return;
    }
  }

  /** One user turn per input item. */
  turnFor(itemId) {
    let t = this.turns.get(itemId);
    if (!t) {
      let resolveSession;
      const sessionP = new Promise((r) => (resolveSession = r));
      t = { itemId, n: ++this.turnSeq, startMs: null, endMs: null, sessionText: "", turnText: null, turnP: null, sessionP, resolveSession, asked: null, dropped: null };
      t.vt = (this.id + "t" + t.n).slice(0, 48);
      this.turns.set(itemId, t);
      this.lastTurn = t;
      if (this.turns.size > 60) this.turns.delete(this.turns.keys().next().value);
    }
    return t;
  }

  anythingAudible() {
    if (this.resp && !this.resp.done && !this.resp.cancelled && this.resp.sentBytes > 0) return true;
    if (this.speechBusy) return true;
    const now = this.now();
    for (const [seg, s] of this.segs) {
      if (s.over || !s.sentBytes) continue;
      const sentMs = s.sentBytes / BYTES_PER_MS;
      // The page cannot still be playing a segment long after it could have finished.
      if (s.firstAt && now > s.firstAt + sentMs + 1500) continue;
      if (sentMs > (this.played.get(seg) || 0) + 40) return true;
    }
    return false;
  }

  /** anythingAudible(), keeping when the current stretch of voice began and ended. */
  audibleNow() {
    const a = this.anythingAudible();
    const now = this.now();
    if (a) {
      if (this.playStartAt == null) this.playStartAt = now;
      this.lastAudibleAt = now;
    } else if (this.playStartAt != null) {
      this.playStartAt = null;
    }
    return a;
  }
  sincePlay() {
    return this.playStartAt == null ? -1 : this.now() - this.playStartAt;
  }
  /** Audio went out to the page: the voice is audible from now. */
  sentAudio(s, n) {
    if (!s.firstAt) s.firstAt = this.now();
    s.sentBytes += n;
    this.audibleNow();
  }

  speechStarted(ev) {
    const t = this.turnFor(ev.item_id);
    t.startMs = ev.audio_start_ms != null ? ev.audio_start_ms : this.inputMs;
    t.startedAt = this.now();
    const audible = this.audibleNow();
    t.overVoice = audible || (this.lastAudibleAt > 0 && t.startedAt - this.lastAudibleAt < LEAK_AFTER_MS);
    t.sincePlay = audible ? this.sincePlay() : null;
    if (!audible) return this.setState("talking");
    // Speech over the voice is only a candidate until the page confirms sustained voice.
    const p = { turn: t, at: t.startedAt, sincePlay: t.sincePlay };
    this.pendingBarge = p;
    this.diag.candidates.push({ turn: t.n, sincePlay: p.sincePlay, confirmed: false });
    this.log(`live: barge-in candidate +${p.sincePlay} ms into playback (${this.duplex} mode)`);
    if (this.voiceOn) this.confirmBarge("voice-already");
  }

  confirmBarge(how) {
    const p = this.pendingBarge;
    if (!p) return;
    this.pendingBarge = null;
    p.turn.bargeConfirmed = true;
    const c = this.diag.candidates.find((x) => x.turn === p.turn.n);
    if (c) c.confirmed = true;
    this.log(`live: barge-in confirmed (${how}) +${p.sincePlay} ms into playback, ${this.now() - p.at} ms after the candidate`);
    this.bargeIn(how);
    this.setState("talking");
  }

  /**
   * The administrator talked over the voice: the page drops what it has
   * buffered (and says how far it had played), the response is cancelled, the
   * realtime item is truncated there, and any summary being read stops.
   */
  bargeIn(how) {
    const at = this.now();
    const b = { at, flushedAt: null, how: how || "voice", sincePlay: this.sincePlay() };
    this.diag.bargeIns.push(b);
    this.toClient({ type: "flush", at });
    this.setState("interrupted");
    this.speechGen++; // summaries and safe lines queued or being read stop here
    for (const s of this.segs.values()) s.over = true; // flushed: nothing of them is audible any more
    this.playStartAt = null;
    this.lastAudibleAt = at;
    const r = this.resp;
    if (r && !r.done) {
      r.cancelled = true;
      r.chunks = [];
      this.send({ type: "response.cancel" });
    }
    // Truncate the realtime item the administrator was hearing, at what was played.
    const audible = [...this.segs.entries()].filter(([, s]) => s.kind === "desk" && s.itemId && !s.truncated && s.sentBytes > 0);
    const target = audible.length ? audible[audible.length - 1] : null;
    if (!target) return;
    const [seg, s] = target;
    const doIt = () => {
      this.pendingTruncate = null;
      if (s.truncated) return;
      s.truncated = true;
      const sent = Math.floor(s.sentBytes / BYTES_PER_MS);
      const ms = Math.max(0, Math.min(sent, Math.floor(this.played.get(seg) || 0)));
      this.send({ type: "conversation.item.truncate", item_id: s.itemId, content_index: 0, audio_end_ms: ms });
      b.truncatedAt = ms;
    };
    this.pendingTruncate = doIt;
    this.timer(() => this.pendingTruncate === doIt && doIt(), TRUNCATE_WAIT_MS);
  }

  speechStopped(ev) {
    const t = this.turnFor(ev.item_id);
    t.endMs = ev.audio_end_ms != null ? ev.audio_end_ms : this.inputMs;
    t.stoppedAt = this.now();
    if (t.startMs == null) t.startMs = Math.max(0, t.endMs - 3000);
    if (this.pendingBarge && this.pendingBarge.turn === t) {
      this.pendingBarge = null;
      this.log(`live: barge-in candidate dropped (speech stopped after ${t.stoppedAt - t.startedAt} ms without sustained voice)`);
    }
    if (!this.suspect(t)) this.setState("thinking");
    if (this.opts.handoff === "turn" && this.d.transcribe && !this.suspect(t)) t.turnP = this.transcribeTurn(t);
    // Fast path: a real-length turn that did not overlap the voice cannot be its leak, so it is
    // answered now (as create_response did) instead of after its transcript (~0.7 s later).
    // Anything heard over the voice, or too short to be sure of, waits for the transcript guard.
    // Not while an undo or a confirm is waiting: that turn may be its answer ("undo", "yes"), which the model must not hear.
    const awaiting = this.undoUntil > this.now() || !!(this.d.confirmPending && this.d.confirmPending());
    if (!this.suspect(t) && !awaiting && this.opts.fastAnswer !== false && t.endMs - t.startMs >= FAST_MIN_MS) this.answer(t);
    // No transcript in time: a real turn is answered anyway (the model hears the audio); a suspect one is dropped.
    this.timer(() => {
      if (t.dropped || t.answered || this.closed) return;
      if (this.suspect(t)) return this.drop(t, "echo-leak");
      this.answer(t);
    }, (this.opts.transcriptWaitMs || TRANSCRIPT_WAIT_MS) + (awaiting && this.suspect(t) ? 2000 : 0));
  }

  /** Heard over (or just after) the voice, and not a confirmed barge-in: maybe the speaker's leak. */
  suspect(t) {
    return !!(t && t.overVoice && !t.bargeConfirmed);
  }

  /** The turn's audio, from what this server relayed. */
  turnAudio(t) {
    const from = Math.max(0, t.startMs - 200);
    const to = t.endMs + 150;
    const parts = [];
    for (const c of this.input) {
      const end = c.at + c.buf.length / BYTES_PER_MS;
      if (end <= from || c.at >= to) continue;
      const a = Math.max(0, Math.floor((from - c.at) * BYTES_PER_MS) & ~1);
      const z = Math.min(c.buf.length, Math.ceil((to - c.at) * BYTES_PER_MS) & ~1);
      if (z > a) parts.push(c.buf.subarray(a, z));
    }
    return Buffer.concat(parts);
  }

  /** A full-turn transcript of what this server relayed, through the transcript guard. */
  async transcribeTurn(t) {
    const pcm = this.turnAudio(t);
    const t0 = this.now();
    if (pcm.length < BYTES_PER_MS * 250) return null;
    try {
      const heard = await this.d.transcribe(wav(pcm), this.cfg, "audio/wav");
      if (heard && heard.tokens) this.record({ vt: t.vt, part: "transcription", model: heard.model, tokens: heard.tokens });
      const text = String((heard && heard.text) || "").trim();
      const audioSeconds = pcm.length / BYTES_PER_MS / 1000;
      const g = voiceGuard.checkTranscript(text, { audioSeconds, sources: liveSources() });
      this.diag.transcripts.push({ turn: t.n, kind: "turn", ms: this.now() - t0, ok: g.ok });
      t.turnText = g.ok ? text : "";
      if (!g.ok) t.turnDropped = g.rule;
      return t.turnText;
    } catch (e) {
      this.log("live: full-turn transcription failed: " + scrub(e.message));
      t.turnText = null;
      return null;
    }
  }

  /** The session's own transcript of a user turn: the echo, stop and persona checks. */
  sessionTranscript(ev) {
    const t = this.turnFor(ev.item_id);
    const text = String(ev.transcript || "").trim();
    if (ev.usage) this.record({ vt: t.vt, part: "transcription", model: this.cfg.transcribe_model || "gpt-4o-mini-transcribe", tokens: usageLib.transcribeTokens(ev.usage) });
    const audioSeconds = t.endMs != null && t.startMs != null ? (t.endMs - t.startMs) / 1000 : null;
    const g = voiceGuard.checkTranscript(text, { audioSeconds, sources: liveSources() });
    t.sessionText = g.ok ? text : "";
    this.diag.transcripts.push({ turn: t.n, kind: "session", ms: t.stoppedAt ? this.now() - t.stoppedAt : null, ok: g.ok });
    if (t.dropped) return t.resolveSession(null);
    const suspect = this.suspect(t);
    if (!g.ok) return this.drop(t, suspect ? "echo-leak" : g.rule), t.resolveSession(null);
    if (this.d.isStop && this.d.isStop(text)) {
      this.diag.stops++;
      t.resolveSession(null);
      return this.stopByVoice(t, text);
    }
    // A pending Tier-2 confirm: a whole "yes" / "no" answers it (and is not a turn); anything else drops it.
    // Heard just after the voice (suspect), a whole yes / no still answers it -- the administrator's quick
    // "yes" lands there -- unless the voice itself said a yes/no word lately, which could be its own leak.
    // A suspect turn that is anything else never touches the confirm (it may be the voice's echo).
    let conf = null;
    if (this.d.confirmHeard && t.n > (this.confirmAfter || 0) && (!this.d.confirmPending || this.d.confirmPending())) {
      if (!suspect) conf = this.d.confirmHeard(text);
      else if (this.d.isYesNo && this.d.isYesNo(text) && !this.voiceSaidYesNo()) {
        conf = this.d.confirmHeard(text);
        if (conf && (conf.confirmed || conf.cancelled)) this.log(`live: a ${conf.confirmed ? "yes" : "no"} heard just after the voice answered the pending confirm (turn ${t.n})`);
      }
    }
    if (conf && (conf.confirmed || conf.cancelled)) {
      const e = conf.confirmed || conf.cancelled;
      t.resolveSession(null);
      this.toClient({ type: "flush", at: this.now() });
      this.drop(t, "confirm-answer");
      this.toClient({ type: conf.confirmed ? "ui-confirmed" : "ui-confirm-cancelled", id: e.id });
      this.toClient({ type: "caption", who: "you", text, final: true });
      return;
    }
    if (this.undoUntil > this.now() && this.d.isUndo && this.d.isUndo(text) && !suspect) {
      this.diag.undos = (this.diag.undos || 0) + 1;
      t.resolveSession(null);
      return this.undoByVoice(t, text);
    }
    if (suspect && voiceGuard.tokens(text).length <= ECHO_LEAK_WORDS) return this.drop(t, "echo-leak"), t.resolveSession(null);
    if (this.isEcho(text, suspect)) {
      this.diag.echoes++;
      return this.drop(t, "echo-of-voice"), t.resolveSession(null);
    }
    if (this.d.hearPersona) {
      const before = JSON.stringify([this.persona.dialect, this.persona.gender]);
      this.persona = personaLib.clean(this.d.hearPersona(text));
      if (JSON.stringify([this.persona.dialect, this.persona.gender]) !== before) this.send({ type: "session.update", session: { type: "realtime", instructions: instructionsFor(this.persona) } });
    }
    this.heard.push(text);
    this.lastHeardN = t.n;
    this.addRecap("you", text);
    this.toClient({ type: "caption", who: "you", text, final: true });
    t.resolveSession(text);
    this.answer(t);
  }

  /**
   * The turn passed: create its response (create_response is off upstream).
   * Over a voice still audible it is a late barge-in; over a response still
   * being generated, that response is cancelled first and this one follows.
   */
  answer(t) {
    if (!t || t.answered || t.dropped || this.closed) return;
    t.answered = true;
    if (this.opts.handoff === "turn" && this.d.transcribe && !t.turnP && t.endMs != null) t.turnP = this.transcribeTurn(t);
    if (this.audibleNow()) {
      this.log(`live: late barge-in (a turn over the voice passed the guard, ${this.duplex} mode)`);
      this.bargeIn("turn");
    } else if (this.resp_active() && !this.resp.cancelled && this.resp.turn !== t) {
      this.resp.cancelled = true;
      this.resp.chunks = [];
      this.send({ type: "response.cancel" });
    }
    if (this.resp_active()) {
      this.queued = t;
      return;
    }
    this.createFor(t);
  }
  createFor(t) {
    this.pendingRound = { turn: t, round: 0 };
    this.diag.created++;
    t.createdAt = this.now();
    this.setState("thinking");
    this.send({ type: "response.create" });
  }

  /** Did the voice say a yes / no word (either language) lately? Then a "yes" heard just after it may be its own. */
  voiceSaidYesNo() {
    if (!this.d.isYesNo) return true;
    const cut = this.now() - LEAK_AFTER_MS - 10000;
    const words = this.spoken.filter((s) => s.at >= cut).map((s) => s.text).join(" ").split(/[\s,.!?؟،;:«»"“”()]+/).filter(Boolean);
    return words.some((w) => this.d.isYesNo(w));
  }

  /**
   * A Tier-2 confirm's 30 s start when the voice has finished asking for it, not when it was asked
   * (a long reply would eat the window). Polled until the voice is quiet; the server re-arms the entry.
   */
  armConfirmWhenQuiet(id) {
    if (!this.d.armConfirm) return;
    const t0 = this.now();
    const tick = () => {
      if (this.closed) return;
      const quiet = !this.resp_active() && !this.anythingAudible() && this.now() - t0 >= 400;
      if (quiet || this.now() - t0 > 25000) {
        this.d.armConfirm(id);
        this.log(`live: the confirm's window starts now (${this.now() - t0} ms after the ask)`);
        return;
      }
      this.timer(tick, 200);
    };
    this.timer(tick, 200);
  }

  /** The server: a pending confirm ran out. The page shows it; the voice says so once, briefly. */
  confirmExpired(e) {
    if (this.closed) return;
    this.toClient({ type: "ui-confirm-expired", id: e && e.id });
    const line = personaLib.expiredLine(this.persona);
    const text = desk.langOf(this.heard.length ? this.heard[this.heard.length - 1] : "", "") === "ar" ? line.ar : line.en;
    const g = desk.judge(desk.sentencesOf(text, true), { uiOk: true });
    if (!g.ok) return this.log("live: the expiry line did not pass the guard (" + g.rule + "); not said");
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "(System note, not the administrator speaking: the " + ((e && e.action) || "change") + " confirm expired; nothing changed.)" }] } });
    this.send({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
    this.say([{ text, safe: true }], "safe", null);
  }

  /** Was this "heard" text what the voice itself just said, coming back through the mic? */
  isEcho(text, suspect) {
    const cut = this.now() - ECHO_WINDOW_MS;
    const recent = this.spoken.filter((s) => s.at >= cut).map((s) => s.text).join(" ");
    if (!recent) return false;
    const heard = voiceGuard.tokens(text);
    if (heard.length < 2) return false;
    // Heard over the voice: most of it being the voice's own words is enough.
    if (suspect) {
      const said = new Set(voiceGuard.tokens(recent));
      if (heard.filter((w) => said.has(w)).length / heard.length >= 0.7) return true;
    }
    const said = new Set(voiceGuard.tokens(recent));
    const inSaid = heard.filter((w) => said.has(w)).length;
    const run = voiceGuard.longestRun(heard, voiceGuard.tokens(recent));
    return (inSaid / heard.length >= 0.8 && run >= Math.min(4, heard.length)) || run >= 6;
  }

  /** Nothing of this turn is answered or passed on; the model forgets it. */
  drop(t, rule) {
    if (t.dropped) return;
    t.dropped = rule;
    if (this.pendingBarge && this.pendingBarge.turn === t) this.pendingBarge = null;
    if (rule === "echo-leak") {
      this.diag.leaks++;
      const at = this.now();
      this.leaks = this.leaks.filter((x) => at - x < SUGGEST_WINDOW_MS);
      this.leaks.push(at);
      this.log(`live: phantom turn (echo-leak) ${t.sincePlay != null && t.sincePlay >= 0 ? "+" + t.sincePlay + " ms into playback" : "just after playback"}, ${this.duplex} mode`);
      if (this.duplex === "full" && this.leaks.length >= 2 && !this.suggested) {
        this.suggested = true;
        this.log(`live: suggested speakers mode (${this.leaks.length} phantom turns within ${SUGGEST_WINDOW_MS / 1000} s)`);
        this.toClient({ type: "suggest", mode: "speakers", why: "echo" });
      }
    } else this.log(`live: dropped a turn (${rule})`);
    const r = this.resp;
    if (r && r.turn === t && !r.done) {
      r.cancelled = true;
      r.chunks = [];
      this.send({ type: "response.cancel" });
    }
    // No response was made for it, so it is still the last item: deleting it keeps the cached prefix.
    this.send({ type: "conversation.item.delete", item_id: t.itemId });
    if (!this.anythingAudible() && !this.resp_active()) this.setState(this.anyPending() ? "waiting" : "listening");
  }

  /**
   * "Undo" said aloud while the page's last screen action can still be
   * undone: the page undoes it (the toast's Undo), and the words go nowhere
   * else -- the turn is dropped, any answer already started is cut.
   */
  undoByVoice(t, text) {
    this.undoUntil = 0;
    this.toClient({ type: "flush", at: this.now() });
    this.drop(t, "undo-command");
    this.toClient({ type: "ui-undo" });
    this.toClient({ type: "caption", who: "you", text, final: true });
    try {
      if (this.d.audit) this.d.audit(`undo by the live voice ("${text.slice(0, 40)}")`);
    } catch (_) {
      /* best effort */
    }
  }

  /** "Stop listening" said aloud: the voice stops, and the call ends. */
  stopByVoice(t, text) {
    t.dropped = "stop-command";
    const r = this.resp;
    if (r && !r.done) {
      r.cancelled = true;
      r.chunks = [];
      this.send({ type: "response.cancel" });
    }
    this.toClient({ type: "flush", at: this.now() });
    this.toClient({ type: "stop", why: "voice-command", text });
    this.close("voice-command", undefined, JSON.stringify(String(text || "").slice(0, 60)));
  }

  responseCreated(ev) {
    const id = ev.response && ev.response.id;
    const turn = this.pendingRound ? this.pendingRound.turn : this.lastTurn;
    const round = this.pendingRound ? this.pendingRound.round : 0;
    this.pendingRound = null;
    const r = {
      id,
      turn,
      round,
      text: "",
      chunks: [],
      sentBytes: 0,
      seg: 0,
      itemId: null,
      calls: [],
      done: false,
      cancelled: false,
      createdAt: this.now(),
      firstAudioIn: null,
      firstAudioOut: null,
    };
    r.rel = new desk.Releaser(() => this.context(), (text) => this.onRelease(r, text));
    r.info = { askedNow: () => !!(turn && turn.asked), pending: () => [...this.requests.values()].some((x) => !x.answered), uiCalling: () => (r.uiCalls === undefined ? null : r.uiCalls) };
    this.resp = r;
    this.diag.responses++;
    // A turn already dropped (an echo, a stop command) gets no answer.
    if (turn && turn.dropped) {
      r.cancelled = true;
      this.send({ type: "response.cancel" });
    }
  }

  /** The guard context: what the voice may say, from what it was given. */
  context() {
    const ids = [...this.requests.keys()].map(String);
    return {
      numbers: desk.numberSet([this.snapshotText, ...this.replies, ...this.heard, ...ids]),
      replyText: this.replies.join("\n"),
      snapshotText: this.snapshotText,
      replied: this.replies.length > 0,
      grounded: this.now() - this.groundedAt < 5 * 60 * 1000,
      // "I opened Missions": true only when a ui_action in this turn returned ok.
      uiOk: !!(this.resp && this.resp.turn && this.resp.turn.uiOk),
    };
  }

  audioOut(ev) {
    const r = this.resp;
    if (!r || r.cancelled || r.trip) return;
    const buf = Buffer.from(ev.delta || "", "base64");
    if (!buf.length) return;
    if (r.firstAudioIn == null) r.firstAudioIn = this.now();
    if (!r.seg) {
      r.seg = ++this.segSeq;
      this.segs.set(r.seg, { kind: "desk", itemId: r.itemId || ev.item_id || null, sentBytes: 0 });
      this.toClient({ type: "seg", seg: r.seg, kind: "desk" });
    }
    const s = this.segs.get(r.seg);
    if (!s.itemId) s.itemId = r.itemId || ev.item_id || null;
    r.chunks.push({ tag: audioTag(r.text), buf, at: this.now() });
    this.pump(r);
  }

  /** Send every held chunk whose sentence has passed the guard. */
  pump(r) {
    if (r.cancelled || r.trip) return;
    const s = this.segs.get(r.seg);
    if (!s) return;
    while (r.chunks.length && r.chunks[0].tag < r.rel.released) {
      const c = r.chunks.shift();
      if (r.firstAudioOut == null) {
        r.firstAudioOut = this.now();
        const t = r.turn;
        this.diag.firstAudio.push({ turn: t && t.n, round: r.round, afterSpeechStop: t && t.stoppedAt ? r.firstAudioOut - t.stoppedAt : null, hold: r.firstAudioOut - r.firstAudioIn });
        this.setState("speaking");
      }
      this.diag.held.push(this.now() - c.at);
      this.sentAudio(s, c.buf.length);
      r.sentBytes += c.buf.length;
      this.d.client.audio(r.seg, c.buf);
    }
  }

  onRelease(r, text) {
    this.spoken.push({ text, at: this.now() });
    this.addRecap("me", text);
    if (this.spoken.length > 40) this.spoken.shift();
    this.toClient({ type: "caption", who: "desk", text, final: true, seg: r.seg || undefined });
  }

  /**
   * The spoken text is complete (its audio may still be arriving): judge it
   * as final now rather than at response.done, so a one-sentence answer is not
   * held until the whole response has been generated. Not when it mentions a
   * hand-off -- a function call later in the same response could be what backs
   * it -- which waits for response.done as before.
   */
  transcriptDone(ev) {
    const r = this.resp;
    if (!r || r.cancelled || r.trip || r.done) return;
    if (typeof ev.transcript === "string" && ev.transcript) r.text = ev.transcript;
    // "I'm checking" is backed only once the response's calls are known (response.done), unless a request is already in progress.
    const inProgress = r.info.askedNow() || r.info.pending();
    if (!inProgress && (desk.mentionsChecking(r.text) || desk.unbackedChecking(r.text, { askedNow: false, pending: false }))) return;
    // "I'll open the missions" is backed by the ui_action call, known at response.done.
    if (desk.uiAnnounce(r.text)) return;
    r.rel.update(r.text, true, r.info);
    if (r.rel.trip) return this.trip(r);
    r.textFinal = true;
    this.pump(r);
  }

  /** The guard over the transcript so far; a cut stops the response. */
  release(final) {
    const r = this.resp;
    if (!r || r.cancelled) return;
    const before = r.rel.released;
    r.rel.update(r.text, final, r.info);
    if (r.rel.trip && !r.trip) return this.trip(r);
    if (r.rel.released > before || final) this.pump(r);
  }

  trip(r) {
    r.trip = { ...r.rel.trip };
    r.chunks = [];
    this.diag.trips.push({ rule: r.trip.rule, released: r.rel.released });
    this.log(`live: guard cut a reply (${r.trip.rule}): ${JSON.stringify(String(r.trip.match || "")).slice(0, 160)}`);
    if (!r.done) this.send({ type: "response.cancel" });
  }

  async responseDone(ev) {
    const r = this.resp;
    const resp = ev.response || {};
    const dup = resp.id ? this.billed.has(resp.id) : false;
    if (dup) {
      this.diag.dupUsage++;
      this.log(`live: a second response.done for ${String(resp.id).slice(0, 40)} was ignored (not billed twice)`);
      return;
    }
    if (resp.id) this.billed.add(resp.id);
    if (resp.usage) this.record({ vt: r && r.turn ? r.turn.vt : this.id, part: "realtime", model: this.model, tokens: usageLib.realtimeTokens(resp.usage) });
    if (!r || (r.id && resp.id && r.id !== resp.id)) return;
    if (r.done) return;
    r.done = true;
    if (this.queued) {
      const q = this.queued;
      this.queued = null;
      if (q !== r.turn && !q.dropped) this.createFor(q);
    }
    const calls = (resp.output || []).filter((o) => o.type === "function_call").map((o) => ({ name: o.name, call_id: o.call_id, arguments: o.arguments }));
    r.uiCalls = calls.some((c) => c.name === "ui_action");
    for (const o of resp.output || []) {
      if (o.type === "message" && !r.trip && !r.cancelled) {
        const full = (o.content || []).map((p) => p.transcript || p.text || "").join("");
        if (full) r.text = full;
      }
    }
    if (!r.cancelled && !r.trip && !r.textFinal) {
      const askedBefore = r.info.askedNow;
      r.info.askedNow = () => askedBefore() || calls.some((c) => c.name === "look_into");
      r.info.lookedNow = () => calls.some((c) => c.name === "read_status");
      r.rel.update(r.text, true, r.info);
      if (r.rel.trip) this.trip(r);
      else this.pump(r);
    }
    if (r.textFinal && !r.trip && !r.cancelled) this.pump(r);
    if (r.trip) {
      const s = this.segs.get(r.seg);
      if (s && s.itemId) {
        s.truncated = true;
        this.send({ type: "conversation.item.truncate", item_id: s.itemId, content_index: 0, audio_end_ms: Math.floor(s.sentBytes / BYTES_PER_MS) });
      }
      // A cut response that also called a tool: the calls run (the next round speaks, a ui_action says
      // its own confirmation, look_into passes the request on) -- no second hand-off of the same words.
      if (calls.length) {
        this.log(`live: the cut reply called ${calls.map((c) => String(c.name).slice(0, 30)).join(", ")}; the calls run, no hand-off`);
        return this.runCalls(r, calls);
      }
      return this.afterTrip(r);
    }
    if (r.cancelled) return;
    if (calls.length) return this.runCalls(r, calls);
    if (this.endAfterSpeech) return this.endWhenQuiet();
    if (r.turn && r.turn.asked) this.setState("waiting");
    else if (this.state !== "talking") this.setState("listening");
  }

  /** call.end: once the goodbye has been played, the call ends. */
  endWhenQuiet() {
    const tick = () => {
      if (this.closed) return;
      if (this.anythingAudible() && this.now() - this.endAfterSpeech < UI_END_MAX_MS) return this.timer(tick, 100);
      this.close("mint-ended", "Mint ended the call.");
    };
    tick();
  }

  /** After a cut: make the safe line true (pass the request on), then say it. */
  async afterTrip(r) {
    const t = r.turn;
    const lang = desk.langOf(r.trip.sentence || r.rel.sentences[r.trip.at] || "", t ? t.sessionText : "");
    const L = desk.linesFor(lang, this.persona.gender);
    let line = L.asked;
    if (t && !t.asked && !t.dropped) {
      const request = await this.groundedText(t);
      if (request) {
        try {
          await this.passOn(t, request);
          line = L.safe;
        } catch (e) {
          line = L.unreachable;
        }
      } else line = L.notCaught || L.safe; // nothing grounded to work on: never "I'm checking" with nothing behind it
    } else if (t && t.asked) {
      const said = r.rel.sentences.slice(0, r.rel.released).join(" ");
      line = desk.mentionsChecking(said) ? L.tail : L.asked;
    }
    const heardSoFar = r.rel.sentences.slice(0, r.rel.released).join(" ");
    this.send({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: (heardSoFar ? heardSoFar + " " : "") + line }] } });
    this.say([{ text: line, safe: true }], "safe", t);
  }

  /** The turn's words as this server heard them (the hand-off's text), or "". */
  async groundedText(t) {
    // A transcriber on this server takes longer (cfg.heard_wait_ms: its timeout and a fallback's round trip).
    const waitMs = Math.max(HEARD_WAIT_MS, Number(this.cfg.heard_wait_ms) || 0);
    const wait = (p) => Promise.race([p, new Promise((res) => this.timer(() => res(null), waitMs))]);
    let text = null;
    if (this.opts.handoff === "turn" && t.turnP) text = await wait(t.turnP);
    if (!text) text = await wait(t.sessionP);
    if (t.dropped) return "";
    return String(text || "").trim().slice(0, 20000);
  }

  async passOn(t, request) {
    let ut = null;
    try {
      ut = this.d.uiTicket ? this.d.uiTicket() : null; // UI control Phase 2: MINT AI may change this tab's screen, in this turn
    } catch (_) {
      ut = null;
    }
    // `call`: this call's id, so the supervisor can fold a repeat that is still queued into the same turn.
    const res = await this.d.ops.ask(request, { ...(ut ? { ut } : {}), call: this.id });
    const tt = res && res.turn;
    t.asked = (tt && tt.id) || true;
    const mine = tt && tt.id ? this.requests.get(tt.id) : null;
    const merged = !!(mine && !mine.answered);
    if (merged) {
      // Said again while the first was still waiting in MINT AI's queue: one turn, one answer.
      mine.text += "\n" + request;
      this.diag.merged++;
      this.log(`live: call ${this.id} turn ${t.n} folded into the queued request ${tt.id}`);
    } else if (tt && tt.id) this.requests.set(tt.id, { text: request, answered: false, askedAt: this.now(), turnN: t.n });
    this.diag.handoffs.push({ turn: t.n, chars: request.length, merged });
    this.toClient({ type: "asked", turn: tt ? { id: tt.id, status: tt.status } : null, merged: merged || undefined });
    this.setState("waiting");
    if (tt && tt.id && !merged) this.watchReply(tt.id, request);
    return tt;
  }

  async runCalls(r, calls) {
    const outputs = [];
    for (const call of calls) {
      let output;
      const before = (r.uiConfirms || []).length;
      try {
        output = await this.runTool(call, r);
      } catch (e) {
        output = JSON.stringify({ error: "that did not work: " + scrub(e.message) });
      }
      outputs.push({ call, output, confirm: (r.uiConfirms || []).length > before ? r.uiConfirms[r.uiConfirms.length - 1] : null });
    }
    if (this.closed) return;
    for (const o of outputs) this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: o.call.call_id, output: o.output } });
    // Only screen actions, all confirmed by the page: this server says so in a fixed line (grounded in the
    // page's ui-ack), and the model is not asked to speak about it (it cannot claim more than was done).
    if (outputs.length && outputs.every((o) => o.confirm)) {
      const line = outputs.map((o) => o.confirm[this.lang()]).join(" ");
      if (!this.sayFixed(line, "the screen confirmation", r.turn, { trusted: true })) this.setState("listening");
      return;
    }
    if (r.round + 1 >= MAX_ROUNDS) return this.setState("listening");
    // A new utterance in the meantime takes over; this round is not answered.
    if (this.lastTurn !== r.turn && this.lastTurn && this.lastTurn.startedAt > r.createdAt) return;
    this.pendingRound = { turn: r.turn, round: r.round + 1 };
    this.send({ type: "response.create" });
  }

  /** One tool call, through the only door. Returns the output text for the model. */
  async runTool(call, r) {
    if (!TOOL_NAMES.has(call.name)) {
      this.diag.refused.push(String(call.name).slice(0, 60));
      this.log(`live: refused a call to an unknown tool ${JSON.stringify(String(call.name).slice(0, 60))}`);
      return JSON.stringify({ error: "refused: that tool does not exist. You have read_status, look_into and ui_action only." });
    }
    let args = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch (_) {
      return JSON.stringify({ error: "the arguments were not valid JSON" });
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
    if (call.name === "ui_action") return this.uiAction(args, r);
    if (call.name === "read_status") {
      if (Object.keys(args).length) return JSON.stringify({ error: "read_status takes no arguments" });
      const snap = desk.forModel(await this.d.ops.snapshot());
      const json = JSON.stringify(snap);
      this.snapshotText = json.toLowerCase();
      this.groundedAt = this.now();
      return json;
    }
    // look_into: what MINT AI receives is this server's transcript of the
    // turn -- never the model's `text` (a paraphrase can change the meaning).
    const t = r.turn;
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const extra = Object.keys(args).filter((k) => k !== "text");
    if (!text || text.length > MAX_ASK_CHARS || extra.length) return JSON.stringify({ error: "look_into takes one field, text, of 1 to " + MAX_ASK_CHARS + " characters" });
    if (!t) return JSON.stringify({ error: "refused: nothing was said in this turn" });
    if (t.asked) return JSON.stringify({ error: "you are already working on this request; do not call look_into again" });
    const request = await this.groundedText(t);
    const why = !request ? "ungrounded" : voiceGuard.refuseAtDoor(text) || voiceGuard.refuseAtDoor(request) ? "echo" : null;
    if (why) {
      this.diag.refused.push("look_into:" + why);
      this.log(`live: refused an look_into (${why})`);
      return JSON.stringify({ error: "refused: look_into works only on what the administrator said in this turn. Say you did not catch that." });
    }
    if (t.asked) return JSON.stringify({ error: "you are already working on this request; do not call look_into again" });
    const normed = (s) => arabic.normalize(String(s)).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (normed(text) !== normed(request)) t.paraphrased = true; // counted, never logged in words
    const tt = await this.passOn(t, request);
    return JSON.stringify({
      status: "working on it",
      request: tt ? tt.id : null,
      note: "Your result is NOT ready yet. Say one short first-person line that you are on it (\"Give me a moment, I'm checking.\"); state no finding, progress or result. It is read to the administrator in your voice when it arrives.",
    });
  }

  /**
   * ui_action: change what the administrator sees (public/ui-actions.js, the
   * shared allowlist). Only in a turn the administrator really started (a
   * transcript this server heard), rate-limited, audited, and shown on the
   * page with a toast. call.end / call.mute / call.interrupt act on this call
   * here; everything else goes to the tab that holds the call, which confirms
   * (ui-ack) -- no confirmation, no "ok".
   */
  async uiAction(args, r) {
    const t = r && r.turn;
    const refuse = (why) => {
      this.diag.refused.push("ui_action:" + why.slice(0, 40));
      this.log(`live: refused a ui_action (${why.slice(0, 80)})`);
      return JSON.stringify({ error: "refused: " + why + ". Tell the administrator plainly that you could not do it." });
    };
    if (!t || t.dropped) return refuse("only when the administrator asked in this turn");
    const f = UiActions.fromTool(args);
    if (f.extra.length) return refuse("unknown arguments");
    const v = UiActions.validate(f.action, f.args);
    if (!v.ok) return refuse(v.why);
    const lim = this.uiLimit.take(t.n, v.action, this.now());
    if (lim) return refuse(lim);
    const toast = UiActions.toast(v.action, v.args);
    if (v.tier === 2) {
      // A preference (theme / persona / voice): the page asks; the answer is a click or the next "yes" this server hears.
      const o = this.d.openConfirm ? this.d.openConfirm(v) : { error: "a preference cannot be changed from here" };
      if (!o || o.error) return refuse((o && o.error) || "not now");
      this.confirmAfter = t.n; // only a LATER utterance answers it (this turn's own transcript may still arrive)
      this.toClient({ type: "ui", action: v.action, args: v.args, toast: o.question, confirm: o.id });
      this.diag.ui.push({ turn: t.n, action: v.action + ":confirm" });
      this.log(`live: ui_action ${v.action} waits for the administrator's confirm (turn ${t.n})`);
      this.armConfirmWhenQuiet(o.id);
      const w = personaLib.waitingLine(this.persona);
      return JSON.stringify({ status: "confirm", asked: o.question, note: "Nothing has changed yet: the screen asks the administrator to confirm. Say only: \"" + w.en + "\" (only if they speak Arabic: «" + w.ar + "»). Never tell them to say yes, never say yes or no yourself, and never say it is done, set or switched." });
    }
    const audit = (how) => {
      try {
        if (this.d.audit) this.d.audit(`${v.action}${Object.keys(v.args).length ? " " + JSON.stringify(v.args) : ""} by the live voice, turn ${t.n} (${how})`);
      } catch (_) {
        /* the audit line is best effort */
      }
    };
    let result;
    if (v.where === "server") {
      this.toClient({ type: "ui", action: v.action, args: v.args, toast, server: true });
      if (v.action === "call.end") {
        this.endAfterSpeech = this.now();
        this.timer(() => this.endAfterSpeech && this.close("mint-ended", "Mint ended the call."), UI_END_MAX_MS);
        result = { status: "ok", done: toast, note: "The call ends after you say one short goodbye, in the first person." };
      } else if (v.action === "call.mute") {
        this.mute(true);
        result = { status: "ok", done: toast, note: "The microphone is muted; only the administrator can unmute it. Say so in one short sentence." };
      } else {
        this.speechGen++;
        this.toClient({ type: "flush", at: this.now() });
        for (const s of this.segs.values()) s.over = true;
        result = { status: "ok", done: toast };
      }
    } else {
      const nonce = Math.random().toString(36).slice(2, 12);
      const ack = await new Promise((resolve) => {
        this.uiPending.set(nonce, resolve);
        this.toClient({ type: "ui", nonce, action: v.action, args: v.args, toast });
        this.timer(() => resolve(null), this.opts.uiAckMs || UI_ACK_MS);
      });
      this.uiPending.delete(nonce);
      if (!ack) {
        audit("no answer from the page");
        return refuse("the screen did not answer");
      }
      if (!ack.ok) {
        audit("refused by the page: " + ack.why);
        return refuse(ack.why || "the screen refused it");
      }
      const said = uiConfirmLine(v.action, v.args);
      if (said) {
        // Spoken by this server once the calls have run (runCalls): the page's answer is what backs it.
        r.uiConfirms = (r.uiConfirms || []).concat([said]);
        result = { status: "ok", done: toast, note: "Done, and already said aloud to the administrator (\"" + said[this.lang()] + "\"). Do not say it again or add to it." + (v.action === "page.open" ? " The page is open in the Command Center's frame and this live call carries on." : "") };
      } else
        result = v.action === "page.open"
          ? { status: "ok", done: toast, note: "The page is open in the Command Center's frame and this live call carries on. Say in one short first-person sentence that it is open." }
          : { status: "ok", done: toast, note: "Say in one short first-person sentence what you did." };
    }
    t.uiOk = true;
    this.diag.ui.push({ turn: t.n, action: v.action });
    this.log(`live: ui_action ${v.action} (turn ${t.n})`);
    audit("ok");
    return JSON.stringify(result);
  }

  /**
   * MINT AI's own ui_action (Phase 2) for this call: call.end / call.mute /
   * call.interrupt, relayed by the server after the supervisor and the ui
   * token checks. call.end lets whatever is playing finish first.
   */
  deepUi(v) {
    if (this.closed) return { ok: false, why: "the call has ended" };
    const toast = UiActions.toast(v.action, v.args);
    this.toClient({ type: "ui", action: v.action, args: v.args, toast, server: true });
    if (v.action === "call.end") {
      this.endAfterSpeech = this.now();
      this.timer(() => this.endAfterSpeech && this.close("mint-ended", "Mint ended the call."), UI_END_MAX_MS);
      if (!this.resp_active()) this.endWhenQuiet();
    } else if (v.action === "call.mute") {
      this.mute(true);
    } else if (v.action === "call.interrupt") {
      this.speechGen++;
      this.toClient({ type: "flush", at: this.now() });
      for (const s of this.segs.values()) s.over = true;
    } else return { ok: false, why: "not a call action" };
    this.diag.ui.push({ turn: "mint", action: v.action });
    this.log(`live: ui_action ${v.action} (from MINT AI)`);
    return { ok: true };
  }

  /* ---- MINT AI's answers: the guarded summary, then the verbatim reader ---- */

  watchReply(id, request) {
    const started = this.now();
    const poll = async () => {
      if (this.closed || this.now() - started > REPLY_WATCH_MS) return;
      let snap = null;
      try {
        snap = await this.d.ops.snapshot([id]);
      } catch (e) {
        this.log("live: could not read MINT AI's reply: " + e.message);
      }
      const row = snap && (snap.requests_to_moni_ai || []).find((x) => x.id === id);
      if (row && row.answered) return this.deliverReply(id, String(row.reply || ""), request);
      this.timer(poll, this.opts.pollMs);
    };
    this.timer(poll, this.opts.pollMs);
  }

  async deliverReply(id, reply, request) {
    const mine = this.requests.get(id);
    if (!mine || mine.answered) return;
    mine.answered = true;
    this.toClient({ type: "replied", turn: id });
    const lines = [];
    // A result for an older request (the administrator has said more since, or it took a while): say which.
    const vt0 = this.id + "r" + id;
    if ((this.lastHeardN || 0) > (mine.turnN || 0) || (mine.askedAt && this.now() - mine.askedAt > EARLIER_MS)) {
      const intro = arabic.isArabic(mine.text || "") ? EARLIER_LINE.ar : EARLIER_LINE.en;
      this.say([{ text: intro, safe: true }], "mint", null, vt0);
    }
    let fallback = !this.d.summarise;
    let deskTokens = null;
    const vt = this.id + "r" + id;
    if (this.d.summarise) {
      try {
        // Each summary line is read the moment the guard has released it.
        const out = await this.d.summarise(id, {
          onLine: (l) => {
            lines.push(l);
            this.say([l], "mint", null, vt);
          },
          persona: this.persona,
          // What was asked (the server's own transcript) and the last words heard: the
          // summary may use their figures, and speaks in the administrator's language.
          request: String((mine && mine.text) || (typeof request === "string" ? request : "") || ""),
          lastSaid: this.heard.length ? this.heard[this.heard.length - 1] : "",
        });
        if (out && out.tokens) deskTokens = out.tokens;
        if (out && (out.fallback === "verbatim" || out.pending) && !lines.length) fallback = true;
      } catch (e) {
        this.log("live: the summary failed: " + scrub(e.message));
        if (!lines.length) fallback = true;
      }
    }
    if (deskTokens) this.record({ vt, part: "desk", model: desk.SUMMARY_MODEL, tokens: deskTokens }); // "desk": the summariser's usage part
    if (fallback) {
      const sents = speakableSentences(reply);
      for (const s of sents.slice(0, VERBATIM_MAX_SENTENCES)) lines.push({ text: s, safe: false });
      if (sents.length > VERBATIM_MAX_SENTENCES) lines.push({ text: desk.linesFor(arabic.isArabic(reply) ? "ar" : "en", this.persona.gender).details, safe: true });
      if (lines.length) this.say(lines, "mint", null, vt);
    }
    // Tell the realtime conversation what MINT AI said and what was heard of it.
    this.replies.push(reply);
    const spoken = lines.map((l) => l.text).join(" ");
    const clipped = reply.length > REPLY_IN_CONTEXT_CHARS ? reply.slice(0, REPLY_IN_CONTEXT_CHARS) + " [...the rest is on the administrator's screen]" : reply;
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "system", content: [{ type: "input_text", text: `Your result for request ${id} arrived (the administrator heard${fallback ? " it read aloud" : " this summary of it"}: "${spoken.slice(0, 600)}", and has the full text on screen):\n${clipped}` }] },
    });
  }

  /**
   * Read lines with the verbatim reader into the call, one segment each, after
   * whatever is being said now. A barge-in (speechGen) stops the rest.
   */
  say(lines, kind, turn, vt) {
    const gen = this.speechGen;
    this.speechChain = this.speechChain.then(async () => {
      // Wait for the realtime model to finish talking.
      for (let i = 0; i < 200 && this.resp && !this.resp.done && !this.closed; i++) await new Promise((r) => setTimeout(r, 50));
      for (const line of lines) {
        if (this.closed || gen !== this.speechGen) return;
        await this.sayOne(line, kind, turn, vt, gen);
      }
      if (!this.closed && gen === this.speechGen && !this.resp_active()) this.setState(this.anyPending() ? "waiting" : "listening");
    });
    return this.speechChain;
  }

  resp_active() {
    return !!(this.resp && !this.resp.done);
  }
  anyPending() {
    return [...this.requests.values()].some((x) => !x.answered);
  }
  /** The call's language: the last thing heard ("ar" or "en"). */
  lang() {
    return desk.langOf(this.heard.length ? this.heard[this.heard.length - 1] : "", "") === "ar" ? "ar" : "en";
  }

  async sayOne(line, kind, turn, vt, gen) {
    const seg = ++this.segSeq;
    const s = { kind, itemId: null, sentBytes: 0 };
    this.segs.set(seg, s);
    this.speechBusy++;
    const live = () => !this.closed && gen === this.speechGen;
    this.toClient({ type: "seg", seg, kind });
    this.toClient({ type: "caption", who: kind === "mint" ? "mint" : "desk", text: line.text, final: true, seg });
    this.setState("speaking");
    this.spoken.push({ text: line.text, at: this.now() });
    this.addRecap("me", line.text);
    try {
      const res = await this.d.speak(line.text, { ...this.cfg, voice: this.cfg.voice }, {
        start: () => {},
        audio: (b) => {
          if (!live()) return;
          this.sentAudio(s, b.length);
          this.d.client.audio(seg, b);
        },
        cut: () => {
          if (!live()) return;
          s.sentBytes = 0;
          s.over = true;
          this.toClient({ type: "cut", seg });
        },
      });
      const bill = (res && res.billing) || [];
      for (const b of bill) this.record({ vt: vt || (turn ? turn.vt : this.id), part: "speech", model: b.model, tokens: b.tokens });
      if (res && res.lateBilling) res.lateBilling.then((more) => (more || []).forEach((b) => this.record({ vt: vt || this.id, part: "speech", model: b.model, tokens: b.tokens })), () => {});
    } catch (e) {
      for (const b of (e && e.billing) || []) this.record({ vt: vt || this.id, part: "speech", model: b.model, tokens: b.tokens });
      this.log("live: a line was not read (" + ((e && e.code) || "error") + ")");
    } finally {
      this.speechBusy--;
      this.toClient({ type: "segend", seg });
    }
  }
}

/** Every text the live voice model was given as instructions (the echo guard's sources). */
let liveSourcesCache = null;
function liveSources() {
  if (!liveSourcesCache) {
    liveSourcesCache = [...voiceGuard.promptSources(), { name: "live instructions", kind: "prose", text: INSTRUCTIONS }];
    for (const t of TOOLS) liveSourcesCache.push({ name: "live tool " + t.name, kind: "prose", text: t.description });
  }
  return liveSourcesCache;
}

/**
 * The line the voice says in its new voice, in the administrator's language.
 * A first-person claim the guard lets through only after a screen action was
 * applied (uiOk) -- which it just was. «غيّرت» is the same for either gender;
 * the persona still decides the Arabic register of everything else.
 */
function voiceChangedLine(lang, persona) {
  void persona;
  return lang === "ar" ? "غيّرت صوتي، ده صوتي الجديد." : "I switched my voice, this is my new voice.";
}

/**
 * The fixed line this server says after the page confirmed a screen action
 * (its ui-ack): { en, ar }, or null for an action that speaks for itself
 * (reply.read reads the reply aloud) or is not the page's. Built from the
 * action's own toast ("Mint opened Agents & sessions" -> "Opened Agents &
 * sessions."); names of pages and panels stay as the screen shows them.
 */
function uiConfirmLine(action, args) {
  const a = args || {};
  const toast = UiActions.toast(action, a);
  if (!toast || action === "reply.read" || /^call\./.test(action)) return null;
  // (decision.show's toast, "showed the waiting card -- approving it is yours", reads as a claim to the guard.)
  const en = action === "decision.show" ? "The waiting card is open; the decision is yours." : toast.replace(/^Mint\s+/, "").replace(/\s+--\s+/g, "; ").replace(/^./, (c) => c.toUpperCase()).replace(/[.!]?$/, ".");
  const label = (s) => String(s || "").trim();
  const page = action === "page.open" ? UiActions.navPage(a.page) : null;
  const sheet = /^Mint (?:opened|closed) (.+)$/.exec(toast);
  const ar = {
    "page.open": () => "فتحت " + label(page ? page.label : a.page) + ".",
    "sheet.open": () => "فتحت " + label(sheet && sheet[1]) + ".",
    "sheet.close": () => (a.key ? "قفلت " + label(sheet && sheet[1]) + "." : "قفلت اللوحة."),
    view: () => (a.name === "map" ? "فتحت الخريطة." : "فتحت Missions."),
    "core.set": () => "غيّرت الـ core لـ " + label(a.core) + ".",
    "reply.show": () => "فتحت آخر رد.",
    "decision.show": () => "فتحت الكارت اللي مستنيك، والقرار ليك.",
  }[action];
  return { en, ar: ar ? ar() : en };
}

/* ------------------------------------------------ one call per user -- */

const calls = new Map(); // actor -> LiveCall
let onChange = null; // server.js: the open calls changed (the deploy scripts read the count it writes)

function changed() {
  try {
    if (onChange) onChange(activeCount());
  } catch (_) {
    /* best effort */
  }
}
function setOnChange(fn) {
  onChange = typeof fn === "function" ? fn : null;
}
function callFor(actor) {
  const c = calls.get(actor);
  return c && !c.closed ? c : null;
}
function register(actor, call) {
  calls.set(actor, call);
  changed();
}
function unregister(actor, call) {
  if (calls.get(actor) === call) calls.delete(actor);
  changed();
}
function closeAll(why) {
  for (const c of calls.values()) c.close(why || "closed");
  calls.clear();
  changed();
}
/**
 * The dashboard is stopping (SIGTERM: a deploy or a restart): every page is
 * told first ({type: "restarting"}), so it reconnects by itself with backoff
 * instead of showing a dead call. Returns how many calls were open.
 */
function restartAll() {
  let n = 0;
  for (const c of [...calls.values()]) {
    if (c.closed) continue;
    c.toClient({ type: "restarting" });
    c.close("restarting", "The dashboard is restarting; the call reconnects by itself.", "SIGTERM");
    n++;
  }
  calls.clear();
  if (n) changed(); // (with no call open the status file already says 0: nothing is written while stopping)
  return n;
}
/**
 * The voice settings changed (the voice is global): every open call is
 * reconnected with them instead of being dropped. `greetActor`'s call says its
 * one line in the new voice; the others just tell their page. Returns
 * [{actor, ok, ms}].
 */
async function swapAll(patch, greetActor) {
  const out = [];
  for (const [actor, c] of [...calls.entries()]) {
    if (c.closed) continue;
    const r = await c.swapUpstream(patch, { greet: actor === greetActor });
    out.push({ actor, ok: r.ok, ms: r.ms });
  }
  return out;
}
/** Every open call (server.js endLiveCallsForSession reads each call's `sid`). */
function all() {
  return [...calls.values()].filter((c) => !c.closed);
}
function activeCount() {
  return [...calls.values()].filter((c) => !c.closed).length;
}
/** The open calls, for the status file the deploy scripts read: no words, no ids of anything else. */
function status() {
  return all().map((c) => ({ call: c.id, actor: c.d.actor, since: new Date(c.bornAt).toISOString(), state: c.state }));
}

module.exports = {
  LIVE_MODEL,
  RATE,
  SILENCE_MS,
  VAD_THRESHOLD,
  NOISE_REDUCTION,
  DUPLEX,
  TAIL_MS,
  MAX_CALL_MS,
  TOOLS,
  TOOL_NAMES,
  INSTRUCTIONS,
  instructionsFor,
  audioTag,
  speakableSentences,
  wav,
  LiveCall,
  callFor,
  register,
  unregister,
  closeAll,
  restartAll,
  setOnChange,
  swapAll,
  voiceChangedLine,
  uiConfirmLine,
  activeCount,
  status,
  all,
  liveSources,
};
