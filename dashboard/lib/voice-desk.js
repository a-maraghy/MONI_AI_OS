"use strict";
/**
 * The voice front desk (TRIAL, off by default): a GPT realtime model that
 * holds the spoken conversation, so a simple question gets a sub-second answer
 * instead of a full MONI AI turn.
 *
 * The administrator's standing choice is "voice only, Claude thinks", and this
 * does not change who thinks. The desk may do exactly two things:
 *
 *   read_status()   read a snapshot of this VPS (the supervisor's read-only
 *                   `snapshot` op: services, disk, memory, sessions, active
 *                   missions and steps, open decisions and pending approvals as
 *                   counts and titles -- never a command; no live Odoo)
 *   ask_moni(text)  hand the request to MONI AI as an ordinary `send` turn,
 *                   attributed to the panel user and marked via "voice-desk"
 *
 * and it says a short acknowledgement. MONI AI's answer is read aloud by the
 * page's existing verbatim reader (the /speak route with its word-for-word
 * guard), exactly as in the direct voice path -- the desk never paraphrases it.
 *
 * Enforcement, in layers (each holds without the others):
 *
 *   1. the realtime session is configured with only these two tools;
 *   2. a function call by any other name is refused here and never runs;
 *   3. deskOps() is the only door to the supervisor, and it opens for two ops:
 *      `snapshot` (read) and `send` (with via "voice-desk") -- never approve,
 *      deny, interrupt, rules or decisions;
 *   4. the output guard reads the desk's own words as they stream. A claim that
 *      something was done, deleted, restarted, pushed or approved; a promise of
 *      such a result; a figure found neither in the snapshot, nor in MONI AI's
 *      replies, nor in what the administrator said; a status claim with no
 *      snapshot behind it; "MONI AI said ..." before MONI AI has replied --
 *      any of these cuts the response off. Its audio is dropped (it was never
 *      sent to the browser: a reply is released only once it has passed), the
 *      words are taken out of the conversation, and a safe line is said
 *      instead ("Let me pass that to MONI AI."), with the request really
 *      passed to MONI AI if the desk had not done so.
 *
 * Everything runs on the server, like the rest of the voice: the browser never
 * talks to OpenAI and never sees the key.
 */

const WebSocket = require("ws");
const { redactDeep } = require("./priv");

const WS_BASE = process.env.MONI_OPENAI_WS || "wss://api.openai.com/v1";
const DESK_MODEL = "gpt-realtime-mini";
const RATE = 24000;
const RESPONSE_TIMEOUT_MS = 20000;
const MAX_ROUNDS = 4; // tool call -> answer, at most a few times per utterance
const MAX_ASKS_PER_TURN = 2;
const MAX_ASK_CHARS = 2000;
const IDLE_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 25 * 60 * 1000;
const GROUNDED_MS = 5 * 60 * 1000; // a snapshot this old still counts as read

const SAFE_LINE = "Let me pass that to MONI AI.";
const SAFE_LINE_ASKED = "I've passed that to MONI AI. I'll read you its answer when it arrives.";

/* --------------------------------------------------------------- tools -- */

const TOOLS = Object.freeze([
  {
    type: "function",
    name: "read_status",
    description:
      "Read a fresh, read-only snapshot of this VPS: services and their state, disk, memory, CPU and load, the live Claude sessions, " +
      "MONI AI's own state, active missions with their steps, open decisions and pending approvals (counts and titles only). " +
      "Call it before answering any question about the machine. It knows nothing else: not Odoo's data, not backups, not logs, not files.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "ask_moni",
    description:
      "Pass the administrator's request to MONI AI, the Claude agent that runs this VPS, which will answer or act. " +
      "Use it for anything that is not answered by the snapshot, for every action or change of any kind (delete, restart, push, deploy, " +
      "approve, deny, fix, run, send), and whenever you are unsure. MONI AI's answer is read aloud to the administrator when it arrives.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The request, in the administrator's own words as closely as possible." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
]);
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const INSTRUCTIONS = [
  "You are the voice front desk of MONI AI, the assistant that runs this VPS. The administrator is speaking to you; your words are read aloud.",
  "You never think for MONI AI and you never act. You do exactly two things:",
  "1. Answer questions about the machine's current state, but ONLY from the read_status tool. Call read_status first, then answer from it and nothing else. Quote figures exactly as the snapshot gives them.",
  "2. Hand everything else to MONI AI by CALLING the ask_moni tool, then say a short acknowledgement such as \"I've passed that to MONI AI. I'll read you its answer when it arrives.\"",
  "Saying that you passed something on does not pass it on: only an ask_moni call does. Never say you passed, sent or will pass a request unless you called ask_moni for it in this same turn.",
  "Hard rules:",
  "- If the answer is not in the snapshot, do not guess and do not answer from general knowledge: call ask_moni right away, in the same response. Do not merely say you will ask.",
  "- Every request to do or change something (delete, restart, stop, start, push, deploy, approve, deny, fix, run, install, send a message) goes to ask_moni. You cannot do these yourself.",
  "- Never say that anything was done, deleted, restarted, pushed, approved or fixed, and never promise that it will be. You only know that you passed the request on.",
  "- Never invent MONI AI's answer. MONI AI's replies reach you as system messages beginning \"MONI AI replied\". If there is none yet, say MONI AI has not replied yet.",
  "- Never quote a number that is not in the snapshot or in MONI AI's reply.",
  "- Approvals and decisions are for the administrator to decide in the Command Center; you cannot approve or deny anything.",
  "Style: one or two short spoken sentences, plain English, no lists, no markdown. A brief greeting or thanks may get a brief, friendly reply.",
].join("\n");

/* ------------------------------------------------ the supervisor door -- */

/** The only supervisor ops the desk may ever reach, and how. */
const DESK_OPS = Object.freeze({ snapshot: "read", send: "write" });

class DeskError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || "error";
  }
}

/**
 * `call(op, params, actor)` is moniai.call. Everything the desk does to the
 * supervisor goes through here, and here only `snapshot` and `send` pass.
 */
function deskOps(call, actor) {
  const gate = (op, params) => {
    if (!Object.prototype.hasOwnProperty.call(DESK_OPS, op)) throw new DeskError("the voice front desk may not call " + String(op).slice(0, 40), "refused");
    return call(op, params, actor);
  };
  return {
    gate,
    snapshot: (turns) => gate("snapshot", turns && turns.length ? { turns } : {}),
    ask: (text) => {
      const t = String(text || "").trim();
      if (!t) throw new DeskError("nothing to pass on", "invalid");
      return gate("send", { text: t.slice(0, 20000), via: "voice-desk" });
    },
  };
}

/* ------------------------------------------------ what the model sees -- */

const FORBIDDEN_KEYS = new Set(["command", "fix_command", "evidence", "input", "input_json", "summary", "proposal", "detail", "key", "token", "password", "reply", "result", "result_text"]);

function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!FORBIDDEN_KEYS.has(k)) o[k] = strip(x);
    return o;
  }
  return v;
}

/**
 * The read_status payload. The supervisor's snapshot is already counts and
 * titles; this is the second lock -- no command-like field survives it, secrets
 * are redacted again, and the desk's own requests appear as answered or not
 * (their replies reach the model as system messages instead).
 */
function forModel(snap) {
  const s = { ...(snap || {}) };
  const reqs = Array.isArray(s.requests_to_moni_ai) ? s.requests_to_moni_ai : [];
  delete s.requests_to_moni_ai;
  const out = strip(redactDeep(s));
  out.your_requests_to_moni_ai = reqs.map((r) => ({ request: r.id, answered: !!r.answered }));
  return out;
}

/* ---------------------------------------------------------- the guard -- */

const DONE_WORDS =
  "done|deleted|removed|erased|wiped|purged|restarted|rebooted|reloaded|stopped|started|killed|terminated|pushed|merged|committed|deployed|" +
  "released|approved|denied|rejected|granted|installed|uninstalled|upgraded|updated|patched|fixed|resolved|repaired|cleared|reset|" +
  "rolled back|reverted|created|executed|ran|completed|finished|shut down|disabled|enabled|changed|applied|backed up|cleaned|freed|" +
  "moved|renamed|cancell?ed|canceled|paused|resumed|taken care of|handled|sorted|dealt with|sent|messaged|delegated|scheduled";
const DO_WORDS =
  "delete|remove|erase|wipe|purge|restart|reboot|reload|stop|start|kill|terminate|push|merge|commit|deploy|release|approve|deny|reject|grant|" +
  "install|uninstall|upgrade|update|patch|fix|resolve|repair|clear|reset|roll back|revert|create|execute|run|shut down|disable|enable|change|" +
  "apply|back up|clean|free|move|rename|cancel|pause|resume|take care of|handle|sort out|deal with|be done|be fixed|be back";
const NEGATION = /\b(not|never|no|nothing|none|cannot|unable|without|n't|cant|can't|wont|won't|haven't|hasn't|hadn't|didn't|isn't|aren't|wasn't|weren't|don't|doesn't)\b/;
// "I've passed that to MONI AI", "I asked MONI AI to ..." -- the one thing the
// desk may say it did. Removed before any claim is looked for.
const HANDOFF = new RegExp(
  [
    "\\b(?:pass(?:ed|ing)?|hand(?:ed|ing)?|sen[dt]|sending|forward(?:ed|ing)?|relay(?:ed|ing)?|put(?:ting)?|flag(?:ged|ging)?|rais(?:e|ed|ing)|giv(?:e|en|ing)|gave|refer(?:red|ring)?)\\b[^.,;!?]{0,50}?\\b(?:to|with|on to|onto|over to)\\s+moni(?:\\s+ai)?\\b",
    "\\b(?:ask(?:ed|ing)?|tell(?:ing)?|told|check(?:ed|ing)? with)\\s+moni(?:\\s+ai)?\\b",
    "\\blet(?:ting)?\\s+moni(?:\\s+ai)?\\s+know\\b",
  ].join("|"),
  "g"
);
const FIRST_PERSON = /\b(i|i've|ive|i have|i had|i'd|i just|we|we've|weve|we have|i'm|im|i am)\b/;
const CLAIM_FIRST = new RegExp("\\b(i|i've|ive|i have|i had|i just|we|we've|weve|we have)\\b(?:\\s+\\w+){0,4}?\\s+(" + DONE_WORDS + ")\\b");
const CLAIM_THIRD = new RegExp("\\b(has|have|had|was|were|is|are|it's|its|that's|thats|got|been|now|already|successfully)\\b(?:\\s+\\w+){0,3}?\\s+(" + DONE_WORDS + ")\\b");
const CLAIM_BARE = /^\s*(?:all\s+|it's\s+|its\s+|that's\s+|thats\s+)?(done|finished|completed|sorted|handled|taken care of|all set)\b/;
const PROMISE = new RegExp("\\b(will|'ll|ll|shall|going to|gonna)\\s+(?:\\w+\\s+){0,2}?(" + DO_WORDS + ")\\b");
const SHOULD_BE = new RegExp("\\bshould\\s+(?:now\\s+)?be\\s+(" + DONE_WORDS + "|back up|back online|working)\\b");
const ATTRIBUTION = /\bmoni(?:\s+ai)?\b(?:\s+\w+){0,3}?\s+(said|says|replied|replies|answered|answers|reported|reports|confirmed|confirms|told|found|responded|thinks|wrote|mentioned|suggests|suggested|recommends|recommended|explained|explains)\b/;
const ANSWER_IS = /\b(its|the|moni ai's|monis|moni's)\s+(answer|reply|response)\s+(is|was|says|said)\b/;
const STATUS_TERM =
  /\b(disk|disks|storage|memory|ram|cpu|load|uptime|service|services|odoo|nginx|postgres|postgresql|fail2ban|ssh|firewall|ufw|dashboard|session|sessions|mission|missions|step|steps|decision|decisions|approval|approvals|backup|backups|server|machine|vps|database|logs?|certificate|website|site|email|cron|agents?|telegram|github|repo|repository|commit|branch)\b/g;
const STATE_WORD =
  /\b(running|up|down|healthy|fine|ok|okay|good|bad|failed|failing|active|inactive|full|empty|busy|idle|stopped|working|broken|stable|pending|open|online|offline|clean|dirty|expired|valid|current|behind|ahead|synced|succeeded|successful)\b/;
const HEDGE = /\b(whether|if|ask|asked|asking|check|checking|find out|look into|looking into|wants? to know|want me to)\b|\?\s*$/;

const NUMBER_WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ");
}

/** Numbers said in a text: digits (1,234.5 → 1234.5) and number words from two up. */
function numbersIn(text) {
  const t = norm(text);
  const out = [];
  for (const m of t.matchAll(/(?<![a-z0-9])\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,(?=\d{3}\b)/g, "").replace(/,/g, ""));
    if (isFinite(n)) out.push(n);
  }
  const w = t.replace(/-/g, " ").split(/[^a-z]+/);
  for (let i = 0; i < w.length; i++) {
    const v = NUMBER_WORDS[w[i]];
    if (v === undefined) continue;
    if (v >= 20 && v < 100 && UNITS[w[i + 1]]) {
      out.push(v + UNITS[w[i + 1]]);
      i++;
    } else out.push(v);
  }
  return out;
}

/** Every figure the desk may say, with their plain roundings. */
function numberSet(texts) {
  const s = new Set();
  for (const t of texts) {
    for (const n of numbersIn(t)) {
      s.add(n);
      s.add(Math.round(n));
      s.add(Math.round(n * 10) / 10);
      s.add(Math.floor(n));
    }
  }
  return s;
}

function clauses(text) {
  return norm(text)
    .split(/[.!?;:\n]+|,\s|\s[—–-]\s|\s(?:but|and|so|then|because)\s/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Is there a negation before `idx` in this clause? */
function negatedBefore(clause, idx) {
  return NEGATION.test(clause.slice(0, idx));
}

/**
 * Check the desk's own words.
 *
 * @param text  what it has said so far (the transcript, or the text output)
 * @param ctx   { numbers: Set (numberSet over snapshot + replies + what the
 *                administrator said), replyText: MONI AI's replies joined,
 *                snapshotText: the snapshot as the model saw it, lowercased,
 *                replied: bool, grounded: bool }
 * @returns { ok: true } or { ok: false, rule, match }
 */
function guard(text, ctx) {
  const c = ctx || {};
  const replyText = norm(c.replyText || "");
  const snapText = norm(c.snapshotText || "");
  // Talking about missions and their steps, from a snapshot that has step
  // statuses: "done" is a status there, not a claim. (Judged over the whole
  // reply, since commas split "the first step, Design, is done".)
  const stepTalk = !!c.grounded && /\b(step|steps|mission|missions)\b/.test(norm(text)) && /"status":"(done|skipped)"/.test(snapText);
  for (const raw of clauses(text)) {
    const cl = raw.replace(HANDOFF, " «handoff» ");
    let m;
    if ((m = CLAIM_BARE.exec(cl)) && !(stepTalk && /^(done|finished|completed)$/.test(m[1]))) return { ok: false, rule: "action-claim", match: raw };
    if ((m = CLAIM_FIRST.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length)) return { ok: false, rule: "action-claim", match: raw };
    if ((m = CLAIM_THIRD.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length)) {
      const word = m[2];
      const fromReply = replyText && new RegExp("\\b" + word.replace(/ /g, "\\s+") + "\\b").test(replyText);
      // "1 of 4 steps done", "the mission has completed 1 out of 4 steps": a status, from the snapshot.
      const stepStatus = /^(done|completed|finished)$/.test(word) && stepTalk;
      if (!fromReply && !stepStatus) return { ok: false, rule: "action-claim", match: raw };
    }
    if ((m = PROMISE.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length)) return { ok: false, rule: "promise", match: raw };
    if ((m = SHOULD_BE.exec(cl)) && !negatedBefore(cl, m.index)) return { ok: false, rule: "promise", match: raw };
    if (!c.replied) {
      if ((m = ATTRIBUTION.exec(cl)) && !negatedBefore(cl, m.index + m[0].length)) return { ok: false, rule: "invented-reply", match: raw };
      if ((m = ANSWER_IS.exec(cl)) && !negatedBefore(cl, m.index)) return { ok: false, rule: "invented-reply", match: raw };
    }
    // A status claim needs the snapshot behind it, and must be about something
    // the snapshot covers ("the backups are fine" never is).
    const terms = [...cl.matchAll(STATUS_TERM)].map((x) => x[1]);
    if (terms.length && STATE_WORD.test(cl) && !HEDGE.test(cl) && !/moni/.test(cl)) {
      if (!c.grounded) return { ok: false, rule: "ungrounded", match: raw };
      const known = terms.some((t) => snapText.includes(t.replace(/s$/, "")));
      if (!known && !(replyText && terms.some((t) => replyText.includes(t.replace(/s$/, ""))))) return { ok: false, rule: "not-in-snapshot", match: raw };
    }
  }
  const numbers = c.numbers || new Set();
  for (const n of numbersIn(text)) {
    if (!numbers.has(n)) return { ok: false, rule: "figure", match: String(n) };
  }
  return { ok: true };
}

const HANDOFF_ANY = new RegExp(HANDOFF.source); // not global: no lastIndex to trip over
const HANDOFF_FUTURE = /\b(let me|i'll|i will|ill|i'm going to|im going to|going to|i'd|i would)\b/;

/**
 * Does this say the request was (or is being) passed to MONI AI when no
 * ask_moni call backs it? `askedNow`: ask_moni ran this turn (or is in this
 * very response). `pending`: an earlier request is still unanswered, which
 * backs a past-tense mention ("I've passed that on") but not a new promise.
 */
function unbackedHandoff(text, { askedNow, pending } = {}) {
  if (askedNow) return null;
  for (const cl of clauses(text)) {
    const m = HANDOFF_ANY.exec(cl);
    if (!m) continue;
    if (/\?\s*$/.test(cl) || /\b(want me to|shall i|should i|do you want|i can|i could|can i|could i)\b/.test(cl)) continue; // an offer, not a claim
    if (negatedBefore(cl, m.index)) continue;
    const future = HANDOFF_FUTURE.test(cl.slice(0, m.index + m[0].length));
    if (future || !pending) return { ok: false, rule: "unbacked-handoff", match: cl };
  }
  return null;
}

/** The part of a streaming text whose last word is complete. */
function settled(text) {
  const t = String(text || "");
  const i = Math.max(t.lastIndexOf(" "), t.lastIndexOf("\n"));
  return i < 0 ? "" : t.slice(0, i);
}

/* ------------------------------------------------------ the session -- */

let seq = 0;

/**
 * One realtime conversation, for one panel user. `ops` is deskOps(); `mode`
 * "audio" (the Command Center) or "text" (the evaluation).
 */
class DeskSession {
  constructor({ key, voice, model, mode, ops, wsBase, log, sayId }) {
    this.key = key;
    this.voice = voice || "marin";
    this.model = model || DESK_MODEL;
    this.mode = mode === "text" ? "text" : "audio";
    this.ops = ops;
    this.wsBase = wsBase || WS_BASE;
    this.log = log || (() => {});
    this.bornAt = Date.now();
    this.usedAt = Date.now();
    this.dead = false;
    this.ws = null;
    this.ready = null;
    this.handler = null;
    this.queue = Promise.resolve();
    this.requests = new Map(); // turn id -> { text, answered, reply }
    this.replies = []; // MONI AI's replies the desk has been given
    this.heard = []; // what the administrator said
    this.snapshotText = "";
    this.groundedAt = 0;
    this.stats = { rejected: 0, trips: 0, turns: 0 };
    this.id = sayId || "desk" + ++seq;
  }

  usable() {
    return !this.dead && Date.now() - this.bornAt < MAX_AGE_MS && (!this.ws || this.ws.readyState <= WebSocket.OPEN);
  }

  open() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(this.wsBase + "/realtime?model=" + encodeURIComponent(this.model), {
        headers: { Authorization: "Bearer " + this.key },
        handshakeTimeout: 10000,
        perMessageDeflate: false,
      }));
      let opened = false;
      const fail = (err) => {
        this.close();
        if (!opened) reject(err);
        else if (this.handler) this.handler({ type: "__fail", error: err });
      };
      ws.on("unexpected-response", (req, res) => {
        let body = "";
        res.on("data", (d) => {
          if (body.length < 4096) body += d;
        });
        res.on("end", () => fail(new DeskError("OpenAI refused the front desk (" + res.statusCode + "): " + scrub(body), res.statusCode === 401 ? "auth" : "upstream")));
      });
      ws.on("error", (e) => fail(new DeskError("Could not reach OpenAI: " + scrub(e.message), "network")));
      ws.on("close", () => fail(new DeskError("OpenAI closed the front desk's connection", "upstream")));
      ws.on("open", () => {
        const session = {
          type: "realtime",
          instructions: INSTRUCTIONS,
          output_modalities: [this.mode],
          tools: TOOLS,
          tool_choice: "auto",
          max_output_tokens: 400,
        };
        if (this.mode === "audio") session.audio = { output: { format: { type: "audio/pcm", rate: RATE }, voice: this.voice } };
        this.send({ type: "session.update", session });
      });
      ws.on("message", (data) => {
        let ev;
        try {
          ev = JSON.parse(String(data));
        } catch (_) {
          return;
        }
        if (!opened) {
          if (ev.type === "session.updated") {
            opened = true;
            return resolve(this);
          }
          if (ev.type === "error") return fail(new DeskError(scrub((ev.error && ev.error.message) || "OpenAI error"), "upstream"));
          return;
        }
        if (this.handler) this.handler(ev);
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close() {
    if (this.dead) return;
    this.dead = true;
    try {
      if (this.ws) this.ws.close();
    } catch (_) {
      /* closed */
    }
  }

  /** Guard context from everything the desk has been given so far. */
  context(extraHeard) {
    const heard = extraHeard ? [...this.heard, extraHeard] : this.heard;
    const ids = [...this.requests.keys()].map(String);
    return {
      numbers: numberSet([this.snapshotText, ...this.replies, ...heard, ...ids]),
      replyText: this.replies.join("\n"),
      snapshotText: this.snapshotText,
      replied: this.replies.length > 0,
      grounded: Date.now() - this.groundedAt < GROUNDED_MS,
    };
  }

  /** Learn the replies to earlier requests, and tell the model about them. */
  async refreshReplies() {
    const pending = [...this.requests.entries()].filter(([, r]) => !r.answered).map(([id]) => id);
    if (!pending.length) return;
    let snap;
    try {
      snap = await this.ops.snapshot(pending);
    } catch (e) {
      this.log("desk: could not refresh replies: " + e.message);
      return;
    }
    for (const r of snap.requests_to_moni_ai || []) {
      const mine = this.requests.get(r.id);
      if (!mine || mine.answered || !r.answered) continue;
      mine.answered = true;
      mine.reply = String(r.reply || "");
      this.replies.push(mine.reply);
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: `MONI AI replied to request ${r.id} (it has already been read aloud to the administrator word for word):\n${mine.reply}` }],
        },
      });
    }
  }

  /** One realtime response: text, audio, function calls. Cut short when the guard trips. */
  respond(t0, timings, ctxFn) {
    return new Promise((resolve, reject) => {
      const st = { text: "", pcm: [], calls: [], itemIds: [], trip: null, status: null };
      const timer = setTimeout(() => {
        this.handler = null;
        reject(new DeskError("the front desk took too long to answer", "timeout"));
      }, RESPONSE_TIMEOUT_MS);
      this.handler = (ev) => {
        switch (ev.type) {
          case "__fail":
            clearTimeout(timer);
            this.handler = null;
            return reject(ev.error);
          case "error":
            // A cancel that arrives after the response ended is harmless.
            if (ev.error && /no active response|cancel/i.test(String(ev.error.message || ev.error.code || ""))) return;
            clearTimeout(timer);
            this.handler = null;
            return reject(new DeskError(scrub((ev.error && ev.error.message) || "OpenAI error"), "upstream"));
          case "response.output_text.delta":
          case "response.output_audio_transcript.delta":
          case "response.audio_transcript.delta":
            if (!timings.firstText) timings.firstText = Date.now() - t0;
            st.text += ev.delta || "";
            if (!st.trip) {
              const g = guard(settled(st.text), ctxFn());
              if (!g.ok) {
                st.trip = g;
                this.send({ type: "response.cancel" });
              }
            }
            break;
          case "response.output_audio.delta":
          case "response.audio.delta":
            if (!timings.firstAudio) timings.firstAudio = Date.now() - t0;
            if (!st.trip && ev.delta) st.pcm.push(Buffer.from(ev.delta, "base64"));
            break;
          case "response.output_item.added":
            if (ev.item && ev.item.type === "message" && ev.item.id) st.itemIds.push(ev.item.id);
            break;
          case "response.done": {
            clearTimeout(timer);
            this.handler = null;
            const r = ev.response || {};
            st.status = r.status || "completed";
            for (const o of r.output || []) {
              if (o.type === "function_call") st.calls.push({ name: o.name, call_id: o.call_id, arguments: o.arguments });
              if (o.type === "message") {
                if (o.id && !st.itemIds.includes(o.id)) st.itemIds.push(o.id);
                // The finished text is authoritative (deltas can be missed on a cancel).
                const full = (o.content || []).map((p) => p.transcript || p.text || "").join("");
                if (full && !st.trip) st.text = full;
              }
            }
            if (!st.trip && st.text) {
              const g = guard(st.text, ctxFn());
              if (!g.ok) st.trip = g;
            }
            if (r.status === "failed") {
              const d = r.status_details || {};
              return reject(new DeskError("OpenAI did not finish: " + scrub((d.error && d.error.message) || d.reason || "failed"), "upstream"));
            }
            return resolve(st);
          }
          default:
            break;
        }
      };
      this.send({ type: "response.create" });
    });
  }

  /** Run one tool call. Returns the output string for the model. */
  async runTool(call, turn) {
    if (!TOOL_NAMES.has(call.name)) {
      this.stats.rejected++;
      turn.rejected.push(String(call.name).slice(0, 60));
      this.log(`desk: refused a call to an unknown tool ${JSON.stringify(String(call.name).slice(0, 60))}`);
      return JSON.stringify({ error: "refused: that tool does not exist. You have read_status and ask_moni only." });
    }
    let args = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch (_) {
      return JSON.stringify({ error: "the arguments were not valid JSON" });
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
    if (call.name === "read_status") {
      if (Object.keys(args).length) return JSON.stringify({ error: "read_status takes no arguments" });
      const snap = forModel(await this.ops.snapshot());
      const json = JSON.stringify(snap);
      this.snapshotText = json.toLowerCase();
      this.groundedAt = Date.now();
      turn.tools.push("read_status");
      return json;
    }
    // ask_moni
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const extra = Object.keys(args).filter((k) => k !== "text");
    if (!text || text.length > MAX_ASK_CHARS || extra.length) return JSON.stringify({ error: "ask_moni takes one field, text, of 1 to " + MAX_ASK_CHARS + " characters" });
    if (turn.asked.length >= MAX_ASKS_PER_TURN) return JSON.stringify({ error: "already passed to MONI AI; do not ask again" });
    const r = await this.ops.ask(withWords(text, turn.heard));
    const t = r && r.turn;
    if (t && t.id) this.requests.set(t.id, { text, answered: false, reply: null });
    turn.asked.push(t || null);
    turn.tools.push("ask_moni");
    return JSON.stringify({
      status: "passed to MONI AI",
      request: t ? t.id : null,
      queued_behind_other_work: !!(r && r.queued_behind),
      note: "MONI AI has NOT replied yet. Say only that you passed it on. Its answer will be read aloud when it arrives.",
    });
  }

  /** One utterance in; what to say out. Serialised per session. */
  turn(heard) {
    const run = this.queue.then(() => this._turn(heard));
    this.queue = run.catch(() => {});
    return run;
  }

  async _turn(heard) {
    await this.open();
    this.usedAt = Date.now();
    this.stats.turns++;
    const said = String(heard || "").trim().slice(0, 4000);
    if (!said) throw new DeskError("nothing heard", "invalid");
    await this.refreshReplies();
    this.heard.push(said);
    const turn = { heard: said, asked: [], tools: [], rejected: [], lines: [], trip: null };
    const timings = {};
    const t0 = Date.now();
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: said }] } });
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const rt0 = Date.now();
      const rtim = {};
      const st = await this.respond(rt0, rtim, () => this.context());
      if (!timings.firstText && rtim.firstText) timings.firstText = rt0 - t0 + rtim.firstText;
      if (!timings.firstAudio && rtim.firstAudio) timings.firstAudio = rt0 - t0 + rtim.firstAudio;
      // "I've passed that to MONI AI" is only true once ask_moni has run. Found
      // on the real model: it said so without calling the tool for 5 of 6
      // action requests. Checked here, once the response's calls are known.
      if (!st.trip && st.text) {
        const u = unbackedHandoff(st.text, { askedNow: turn.asked.length > 0 || st.calls.some((c) => c.name === "ask_moni"), pending: [...this.requests.values()].some((r) => !r.answered) });
        if (u) st.trip = u;
      }
      const first = Math.min(rtim.firstText || Infinity, rtim.firstAudio || Infinity);
      // When the administrator hears the first word, from when they stopped speaking.
      if (!timings.firstWords && isFinite(first)) timings.firstWords = rt0 - t0 + first;
      if (turn.asked.length && !timings.ackFirst && isFinite(first)) timings.ackFirst = first;
      if (st.trip) {
        turn.trip = { ...st.trip, said: st.text.slice(0, 400) };
        this.stats.trips++;
        this.log(`desk: guard cut a reply (${st.trip.rule}): ${JSON.stringify(st.trip.match).slice(0, 160)}`);
        for (const id of st.itemIds) this.send({ type: "conversation.item.delete", item_id: id });
        break;
      }
      if (st.text) turn.lines.push({ text: st.text.trim(), pcm: st.pcm.length ? Buffer.concat(st.pcm) : null });
      if (!st.calls.length) break;
      for (const call of st.calls) {
        let output;
        try {
          output = await this.runTool(call, turn);
        } catch (e) {
          output = JSON.stringify({ error: "that did not work: " + scrub(e.message) });
        }
        this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output } });
      }
      if (round === MAX_ROUNDS - 1) turn.trip = { ok: false, rule: "too-many-rounds", match: "", said: "" };
    }
    if (turn.trip) {
      // Say the safe line, and make it true: pass the request on if the desk
      // had not. The words the guard stopped are out of the conversation; the
      // safe line goes in, so the model's memory matches what was heard.
      if (!turn.asked.length) {
        try {
          const r = await this.ops.ask(said);
          const t = r && r.turn;
          if (t && t.id) this.requests.set(t.id, { text: said, answered: false, reply: null });
          turn.asked.push(t || null);
          turn.autoAsked = true;
        } catch (e) {
          this.log("desk: could not pass the request on after the guard: " + e.message);
          turn.lines.push({ text: "Sorry, I could not reach MONI AI.", pcm: null, safe: true });
          timings.done = Date.now() - t0;
          return this.result(turn, timings);
        }
      }
      const line = turn.autoAsked ? SAFE_LINE : SAFE_LINE_ASKED;
      this.send({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: line }] } });
      turn.lines.push({ text: line, pcm: null, safe: true });
    }
    timings.done = Date.now() - t0;
    return this.result(turn, timings);
  }

  result(turn, timings) {
    return {
      heard: turn.heard,
      lines: turn.lines,
      asked: turn.asked.filter(Boolean),
      autoAsked: !!turn.autoAsked,
      tools: turn.tools,
      rejected: turn.rejected,
      trip: turn.trip ? { rule: turn.trip.rule, match: String(turn.trip.match || "").slice(0, 200), said: turn.trip.said } : null,
      timings,
    };
  }
}

/** The administrator's own words go with the desk's phrasing, so nothing is lost in paraphrase. */
function withWords(text, heard) {
  const a = String(text || "").trim();
  const h = String(heard || "").trim();
  if (!h || norm(a).replace(/[^a-z0-9]/g, "") === norm(h).replace(/[^a-z0-9]/g, "")) return a;
  return `${a}\n\n(The administrator's own words: "${h.slice(0, 1500)}")`;
}

function scrub(text) {
  return String(text == null ? "" : text)
    .replace(/\bsk-[A-Za-z0-9_\-*.]{4,}/g, "sk-…")
    .replace(/(Bearer\s+)\S+/gi, "$1…")
    .slice(0, 300);
}

/* ------------------------------------------- one desk per panel user -- */

const desks = new Map(); // actor -> DeskSession

/**
 * The desk for this panel user, opened on first use and reused while fresh.
 * `call` is moniai.call; the desk only ever reaches it through deskOps().
 */
function deskFor(actor, cfg, call, opts) {
  const o = opts || {};
  const id = String(actor) + "|" + String(cfg.key).slice(-6) + "|" + (cfg.voice || "");
  let d = desks.get(actor);
  if (d && (!d.usable() || d.cfgId !== id || Date.now() - d.usedAt > IDLE_MS)) {
    d.close();
    d = null;
  }
  if (!d) {
    d = new DeskSession({ key: cfg.key, voice: cfg.voice, model: cfg.desk_model || DESK_MODEL, mode: o.mode || "audio", ops: deskOps(call, actor), wsBase: cfg.wsBase, log: o.log });
    d.cfgId = id;
    desks.set(actor, d);
  }
  return d;
}

function closeAll() {
  for (const d of desks.values()) d.close();
  desks.clear();
}

const sweeper = setInterval(() => {
  for (const [k, d] of desks) {
    if (!d.usable() || Date.now() - d.usedAt > IDLE_MS) {
      d.close();
      desks.delete(k);
    }
  }
}, 60000);
if (sweeper.unref) sweeper.unref();

module.exports = {
  TOOLS,
  TOOL_NAMES,
  INSTRUCTIONS,
  DESK_OPS,
  DESK_MODEL,
  SAFE_LINE,
  SAFE_LINE_ASKED,
  FORBIDDEN_KEYS,
  DeskSession,
  DeskError,
  deskOps,
  deskFor,
  closeAll,
  forModel,
  guard,
  unbackedHandoff,
  numbersIn,
  numberSet,
  settled,
  withWords,
  RATE,
};
