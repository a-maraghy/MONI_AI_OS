"use strict";
/**
 * The voice front desk (TRIAL, off by default): a GPT realtime model that
 * holds the spoken conversation, so a simple question gets a quick answer
 * instead of a full MINT AI turn.
 *
 * The administrator's standing choice is "voice only, Claude thinks", and this
 * does not change who thinks. The desk may do exactly two things:
 *
 *   read_status()   read a snapshot of this VPS (the supervisor's read-only
 *                   `snapshot` op: services, disk, memory, sessions, active
 *                   missions and steps, open decisions and pending approvals as
 *                   counts and titles -- never a command; no live Odoo)
 *   ask_moni(text)  hand the request to MINT AI as an ordinary `send` turn,
 *                   attributed to the panel user and marked via "voice-desk"
 *
 * and it talks: a short acknowledgement, a brief bit of small talk, an answer
 * from the snapshot -- and, when MINT AI's answer arrives, a short spoken
 * SUMMARY of it (the administrator's decision of 2026-09-29; the full text
 * stays on screen in the Command Center exactly as before). A reply that is
 * already one or two plain sentences is read word for word instead: there is
 * nothing to shorten.
 *
 * Enforcement, in layers (each holds without the others):
 *
 *   1. the realtime session is configured with only these two tools;
 *   2. a function call by any other name is refused here and never runs;
 *   3. deskOps() is the only door to the supervisor, and it opens for two ops:
 *      `snapshot` (read) and `send` (with via "voice-desk") -- never approve,
 *      deny, interrupt, rules or decisions; and `send` refuses text that is an
 *      echo of a prompt (the transcription prompt, these instructions, a tool
 *      description -- lib/voice-guard.js), as does ask_moni, which also needs
 *      a real transcript for this turn that passed the transcript guard --
 *      and what ask_moni sends is that transcript, the administrator's own
 *      words, never the model's `text` (a paraphrase can change the meaning);
 *   4. the output guard reads the desk's words. The desk answers in TEXT; a
 *      sentence is spoken (by the ordinary verbatim reader, lib/voice.js) only
 *      once the guard has passed it, so what is heard is exactly what was
 *      checked. It cuts a claim that something was done, deleted, restarted,
 *      pushed or approved (or is being); a promise of one; a figure found
 *      neither in the snapshot, nor in MINT AI's replies, nor in what the
 *      administrator said; a status claim with no snapshot behind it; "MINT AI
 *      said ..." before MINT AI has replied; "I've passed that on" with no
 *      ask_moni call behind it. A summary is held to MINT AI's reply: a figure
 *      changed or rounded wrongly, a negation flipped, a recommendation MINT AI
 *      did not make, "I'll ask the administrator" turned into "done", a name or
 *      a path it did not give -- each is cut, and a pending approval that the
 *      summary left out is said anyway.
 *
 * Arabic (M-3 Phase 0, 2026-09-29). Every rule above holds in Egyptian and
 * Modern Standard Arabic and in mixed sentences (lib/voice-arabic.js): figures
 * in Arabic-Indic or Eastern digits or in Arabic words, the Arabic claim,
 * promise, approval, negation and hedge words with their clitics, and \b / \w
 * that see Arabic letters. It fails closed: a sentence in a script it cannot
 * read, or an Arabic past-tense result verb it does not know, is not spoken.
 * The fixed lines are said in the cut sentence's language.
 *
 * Language (2026-09-29, the administrator's choice: "replies in my language
 * and saves the persona based on how I speak"): the desk answers in the
 * language of the administrator's last utterance (replyLanguage, sent with
 * every response as instructionsFor). Arabic, or Arabic mixed with English,
 * gets Arabic in the register the administrator uses (Egyptian or MSA), with
 * English technical terms in Latin script; the voice's own grammatical gender
 * follows how the administrator addresses it, gender-neutral until that is
 * known (lib/voice-persona.js, saved per user). Summaries and fixed lines
 * follow the same rule. The guard reads feminine and masculine Egyptian forms
 * («أنا عاملة ده», «مشغّلاه», «أنا عامله»: lib/voice-arabic.js participles).
 *
 * Sentence by sentence. A sentence is released as soon as the guard has
 * checked it, instead of holding the whole reply. That must not let a later
 * sentence change the meaning of one already heard ("Restarting Odoo." ...
 * "Done."). So the guard judges every sentence with the ones before it (a
 * confirmation after an action sentence is a claim about THAT sentence; "it"
 * borrows its subject from the sentence before), and a sentence that cannot be
 * judged alone -- one that mentions an action, a fragment, a hand-off whose
 * ask_moni call is not known yet -- is held until the next one (or the end)
 * arrives. What is released has passed the guard in the context that decides
 * it; whatever comes later can only cut itself.
 *
 * Cost. Every response's `usage` is priced (lib/voice-usage.js, the official
 * list read 2026-09-29) and recorded, with the speech of what the desk says,
 * per voice turn and per kind of turn (small talk, snapshot answer, hand-off).
 * There is no cap: the Command Center shows the spend instead (the
 * administrator's decision of 2026-09-29).
 *
 * Speech is streamed (createSpeaker): each released line is read at once by
 * the verbatim reader and its audio goes to the page as it arrives, strictly
 * in line order.
 *
 * Everything runs on the server, like the rest of the voice: the browser never
 * talks to OpenAI and never sees the key.
 */

const WebSocket = require("ws");
const { redactDeep } = require("./priv");
const usageLib = require("./voice-usage");
const voiceGuard = require("./voice-guard");
const arabic = require("./voice-arabic");
const personaLib = require("./voice-persona");

const uni = arabic.uni; // \b and \w that see Arabic letters as letters (lib/voice-arabic.js)

const WS_BASE = process.env.MONI_OPENAI_WS || "wss://api.openai.com/v1";
const DESK_MODEL = "gpt-realtime-mini";
const RATE = 24000;
const RESPONSE_TIMEOUT_MS = 20000;
const MAX_ROUNDS = 4; // tool call -> answer, at most a few times per utterance
// One hand-off per utterance: what reaches MINT AI is the administrator's own
// words (see runTool), and the same words twice would be the same request twice.
const MAX_ASKS_PER_TURN = 1;
const MAX_ASK_CHARS = 2000;
const IDLE_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 25 * 60 * 1000;
const GROUNDED_MS = 5 * 60 * 1000; // a snapshot this old still counts as read
// The conversation a kept session carries is re-read (mostly from the prompt
// cache) on every response. Past either limit the next utterance starts a
// fresh session; unanswered requests carry over. See the README for the
// trade-off measured on the real model.
const MAX_TURNS_PER_SESSION = 12;
const MAX_CONTEXT_TOKENS = 12000;
const REPLY_IN_CONTEXT_CHARS = 1500;
const SUMMARY_MAX_TOKENS = 220;
const VERBATIM_MAX_CHARS = 220; // a reply this short, in plain prose, is read as it is

const SAFE_LINE = "Let me pass that to MINT AI.";
const SAFE_LINE_ASKED = "I've passed that to MINT AI. I'll read you its answer when it arrives.";
const SAFE_LINE_TAIL = "I'll read you its answer when it arrives."; // when "I've passed that on" was already heard
const APPROVAL_LINE = "It needs your approval or your answer. The details are on screen.";
const APPROVAL_LINE_SHORT = "It needs your approval or your answer.";
const DETAILS_LINE = "The full answer is on screen.";
const SUMMARY_CUT_LINE = "The rest of MINT AI's answer is on screen.";
const SUMMARY_NONE_LINE = "MINT AI has replied. Its answer is on screen.";
const UNREACHABLE_LINE = "Sorry, I could not reach MINT AI.";

// The same fixed lines, in Egyptian Arabic, for a conversation (or a cut
// sentence) in Arabic. They are said as they are: the guard does not read them.
// Gender-neutral unless the saved persona (lib/voice-persona.js) knows how the
// administrator addresses the voice: then the gendered ones follow it.
const LINES_AR = Object.freeze({
  safe: "هسأل MINT AI وأرجعلك بالرد.",
  asked: "بعتّ ده لـ MINT AI، وهقرألك ردّه أول ما يوصل.",
  tail: "هقرألك ردّه أول ما يوصل.",
  approval: "الطلب محتاج موافقتك أو ردك. التفاصيل على الشاشة.",
  approvalShort: "الطلب محتاج موافقتك أو ردك.",
  details: "الرد كامل على الشاشة.",
  summaryCut: "باقي رد MINT AI على الشاشة.",
  summaryNone: "MINT AI ردّ، والتفاصيل على الشاشة.",
  unreachable: "للأسف مقدرتش أوصل لـ MINT AI.",
});
const LINES_AR_F = Object.freeze({
  ...LINES_AR,
  approval: "محتاجة موافقتك أو ردك. التفاصيل على الشاشة.",
  approvalShort: "محتاجة موافقتك أو ردك.",
  unreachable: "آسفة، مقدرتش أوصل لـ MINT AI.",
});
const LINES_AR_M = Object.freeze({
  ...LINES_AR,
  approval: "محتاج موافقتك أو ردك. التفاصيل على الشاشة.",
  approvalShort: "محتاج موافقتك أو ردك.",
  unreachable: "آسف، مقدرتش أوصل لـ MINT AI.",
});
const LINES_EN = Object.freeze({
  safe: SAFE_LINE,
  asked: SAFE_LINE_ASKED,
  tail: SAFE_LINE_TAIL,
  approval: APPROVAL_LINE,
  approvalShort: APPROVAL_LINE_SHORT,
  details: DETAILS_LINE,
  summaryCut: SUMMARY_CUT_LINE,
  summaryNone: SUMMARY_NONE_LINE,
  unreachable: UNREACHABLE_LINE,
});
function linesFor(lang, gender) {
  if (lang !== "ar") return LINES_EN;
  return gender === "f" ? LINES_AR_F : gender === "m" ? LINES_AR_M : LINES_AR;
}
/**
 * The language of a fixed line: the sentence's own, when it is one we read
 * (Latin or Arabic), else the fallback text's (what the administrator said).
 */
function langOf(sentence, fallback) {
  const s = String(sentence || "");
  const sc = arabic.scriptOf(s);
  if (!sc.other && sc.arWords + sc.laWords > 0) return arabic.isArabic(s) ? "ar" : "en";
  return arabic.isArabic(fallback || "") ? "ar" : "en";
}

/* ------------------------------------------------------------- prices -- */

// The price list and the token arithmetic live in lib/voice-usage.js, the one
// place they are kept (with the date they were read).
const PRICES = usageLib.PRICES;
const tokensOf = usageLib.realtimeTokens;
const addTokens = usageLib.addTokens;
function costOf(tokens, model) {
  return usageLib.costOf(tokens, PRICES[model] ? model : DESK_MODEL);
}

/* --------------------------------------------------------------- tools -- */

const TOOLS = Object.freeze([
  {
    type: "function",
    name: "read_status",
    description:
      "Read a fresh, read-only snapshot of this VPS: services and their state, disk, memory, CPU and load, the live Claude sessions, " +
      "MINT AI's own state, active missions with their steps, open decisions and pending approvals (counts and titles only). " +
      "Call it before answering any question about the machine. It knows nothing else: not Odoo's data, not backups, not logs, not files.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "ask_moni",
    description:
      "Pass the administrator's request to MINT AI, the Claude agent that runs this VPS, which will answer or act. " +
      "Use it for anything that is not answered by the snapshot, for every action or change of any kind (delete, restart, push, deploy, " +
      "approve, deny, fix, run, send), and whenever you are unsure. A short summary of MINT AI's answer is read aloud when it arrives.",
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
  "You are the voice front desk of MINT AI, the assistant that runs this VPS. The administrator is speaking to you; your words are read aloud.",
  "You never think for MINT AI and you never act. You do exactly three things:",
  "1. Answer questions about the machine's current state, but ONLY from the read_status tool. Call read_status first, then answer from it and nothing else. Quote figures exactly as the snapshot gives them.",
  "2. Hand everything else to MINT AI by CALLING the ask_moni tool, then say a short acknowledgement such as \"I've passed that to MINT AI. I'll read you its answer when it arrives.\"",
  "3. Small talk: a greeting, thanks, \"how are you\", \"can you hear me\" get one short, friendly, honest sentence. Small talk never includes the state of the machine, a service, a task or a request: for those, use read_status or ask_moni first.",
  "Saying that you passed something on does not pass it on: only an ask_moni call does. Never say you passed, sent or will pass a request unless you called ask_moni for it in this same turn.",
  "Hard rules:",
  "- If the answer is not in the snapshot, do not guess and do not answer from general knowledge: call ask_moni right away, in the same response. Do not merely say you will ask.",
  "- Every request to do or change something (delete, restart, stop, start, push, deploy, approve, deny, fix, run, install, send a message) goes to ask_moni. You cannot do these yourself.",
  "- Never say that anything was done, deleted, restarted, pushed, approved or fixed, or that it is being done, and never promise that it will be. You only know that you passed the request on.",
  "- Never invent MINT AI's answer. MINT AI's replies reach you as system messages beginning \"MINT AI replied\". If there is none yet, say MINT AI has not replied yet.",
  "- Never quote a number that is not in the snapshot or in MINT AI's reply.",
  "- Approvals and decisions are for the administrator to decide in the Command Center; you cannot approve or deny anything.",
  "Language: reply in the language of the administrator's LAST utterance: English gets English; Arabic, or Arabic mixed with English, gets Arabic in the register the administrator used " +
    "(Egyptian colloquial if they speak Egyptian, Modern Standard Arabic if they speak MSA), with technical terms kept in English in Latin script (Odoo, disk, restart, dashboard). " +
    "A note at the end says which, and how to refer to yourself.",
  "You are MINT AI's voice, not a person: you never claim to be human.",
  "Style: one or two short spoken sentences, no lists, no markdown.",
].join("\n");

/**
 * The language to answer in: that of the administrator's last utterance.
 * Arabic, or Arabic mixed with English terms, is Arabic (lib/voice-arabic.js
 * isArabic: at least a third of the words in Arabic script); anything else
 * is English.
 */
function replyLanguage(utterance) {
  return arabic.isArabic(String(utterance || "")) ? "ar" : "en";
}
/**
 * The desk's instructions for one response: the language of this utterance,
 * and for Arabic the register and the voice's own gender, from how the
 * administrator speaks (lib/voice-persona.js). `utterance` is the text heard;
 * `persona` the saved one (already merged with this utterance).
 */
function instructionsFor(utterance, persona) {
  return INSTRUCTIONS + "\n" + personaLib.noteFor(personaLib.detect(utterance), persona);
}

const SUMMARY_INSTRUCTIONS = [
  "You turn MINT AI's written reply into a short spoken summary for the administrator, who can see the full text on screen.",
  "Rules:",
  "- One to three short sentences, at most 45 words, in the language named at the end of the input (English, or Arabic in the register named there, with technical terms kept in English in Latin script). No lists, no markdown.",
  "- Say only what the reply says. Add no fact, figure, name, reason, recommendation or action of your own.",
  "- Keep every negation: if the reply says something did NOT happen, is NOT running, or is not known yet, say so.",
  "- Keep figures exactly as written, or leave them out. Never round them differently or convert them.",
  "- If MINT AI says it will do something, is waiting, needs the administrator's approval, decision or answer, or does not know yet, say exactly that. Never say it is done.",
  "- If the reply needs the administrator's approval, decision or answer, the summary MUST say so.",
  "- Only repeat a recommendation MINT AI itself made, as MINT AI's.",
  "- Do not read lists, code, commands, links or file paths aloud: say the details are on screen.",
  "- Speak about MINT AI in the third person (\"MINT AI says...\", \"MINT AI restarted...\"; in Arabic \"MINT AI بيقول...\"). Never say \"I\" did anything.",
].join("\n");
/** The last line of a summary's input: the language (and register) to speak in. */
function summaryLanguage(utterance, persona) {
  const t = personaLib.detect(utterance);
  if (t.lang !== "ar") return "Speak in: English.";
  const d = t.dialect || personaLib.clean(persona).dialect;
  return d === "msa" ? "Speak in: Modern Standard Arabic, technical terms in English." : d === "egyptian" ? "Speak in: Egyptian colloquial Arabic, technical terms in English." : "Speak in: Arabic, in the register of the administrator's request, technical terms in English.";
}

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
      const door = voiceGuard.refuseAtDoor(t);
      if (door) throw new DeskError(`refused: that reads as ${door.source || "a prompt"}, not as something the administrator said`, "refused");
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
  // The supervisor's key keeps the internal spelling; the desk speaks of MINT AI.
  if (s.moni_ai !== undefined) {
    s.mint_ai = s.moni_ai;
    delete s.moni_ai;
  }
  const out = strip(redactDeep(s));
  out.your_requests_to_mint_ai = reqs.map((r) => ({ request: r.id, answered: !!r.answered }));
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
  "apply|back up|clean up|free up|move|rename|cancel|pause|resume|take care of|handle|sort out|deal with|be done|be fixed|be back";
// "-ing" forms: "Restarting Odoo." is a claim that it is happening. ("running"
// is left out: "Odoo is running" is a state.)
const DO_ING =
  "deleting|removing|erasing|wiping|purging|restarting|rebooting|reloading|stopping|starting|killing|terminating|pushing|merging|committing|" +
  "deploying|releasing|approving|denying|rejecting|granting|installing|uninstalling|upgrading|updating|patching|fixing|resolving|repairing|" +
  "clearing|resetting|rolling back|reverting|creating|executing|shutting down|disabling|enabling|changing|applying|backing up|cleaning|freeing|" +
  "moving|renaming|cancell?ing|pausing|resuming|messaging|scheduling";
// (Arabic: the unambiguous particles here; ما and لا, which also mean "what" and
// "no", negate only the words right after them -- lib/voice-arabic.js.)
const NEGATION = uni(/\b(not|never|no|nothing|none|cannot|unable|without|n't|cant|can't|wont|won't|haven't|hasn't|hadn't|didn't|isn't|aren't|wasn't|weren't|don't|doesn't|nobody|neither|nor|no longer|مش|لم|لن|ليس|ليست|مفيش|مافيش|محدش|ماحدش|بدون)\b|n't\b/);
// "I've passed that to MINT AI", "I asked MINT AI to ..." -- the one thing the
// desk may say it did. Removed before any claim is looked for.
const HANDOFF_EN = new RegExp(
  [
    "\\b(?:pass(?:ed|ing)?|hand(?:ed|ing)?|sen[dt]|sending|forward(?:ed|ing)?|relay(?:ed|ing)?|put(?:ting)?|flag(?:ged|ging)?|rais(?:e|ed|ing)|giv(?:e|en|ing)|gave|refer(?:red|ring)?)\\b[^.,;!?]{0,50}?\\b(?:to|with|on to|onto|over to)\\s+(?:mint|moni)(?:\\s+ai)?\\b(?!\\s+agent)",
    "\\b(?:ask(?:ed|ing)?|tell(?:ing)?|told|check(?:ed|ing)? with)\\s+(?:mint|moni)(?:\\s+ai)?\\b(?!\\s+agent)",
    "\\blet(?:ting)?\\s+(?:mint|moni)(?:\\s+ai)?\\s+know\\b",
  ].join("|"),
  "g"
);
// ...and in Arabic: "هسأل MINT AI", "هبعت لـ MINT AI", "بعتّ ده لـ MINT AI".
const HANDOFF = new RegExp(uni(HANDOFF_EN).source + "|" + arabic.HANDOFF_AR.source, "gu");
// ("أنا deleted the old backups": an Arabic "I" before an English verb is a claim too.)
const CLAIM_FIRST = uni(new RegExp("\\b(i|i've|ive|i have|i had|i just|we|we've|weve|we have|انا|احنا|نحن)\\b(?:\\s+\\w+){0,4}?\\s+(" + DONE_WORDS + ")\\b"));
const CLAIM_THIRD = uni(new RegExp("\\b(has|have|had|was|were|is|are|it's|its|that's|thats|got|been|now|already|successfully)\\b(?:\\s+\\w+){0,3}?\\s+(" + DONE_WORDS + ")\\b"));
const CLAIM_BARE = uni(/^\s*(?:all\s+|it's\s+|its\s+|that's\s+|thats\s+)?(done|finished|completed|complete|sorted|handled|taken care of|all set|success|successful)\b/);
const PROGRESSIVE_FIRST = uni(new RegExp("\\b(i'm|im|i am|we're|were|we are|انا|احنا)\\s+(?:now\\s+|just\\s+|already\\s+|currently\\s+)?(" + DO_ING + ")\\b"));
const PROGRESSIVE_BARE = uni(new RegExp("^\\s*(?:ok(?:ay)?\\s+|sure\\s+|alright\\s+|right\\s+)?(" + DO_ING + ")\\b"));
// ("I'll update you when it replies" is a promise to talk, not to act.)
const PROMISE = uni(new RegExp("\\b(will|'ll|ll|shall|going to|gonna)\\s+(?:\\w+\\s+){0,2}?(" + DO_WORDS + ")\\b(?!\\s+(?:you|the administrator)\\b)"));
const SHOULD_BE = uni(new RegExp("\\bshould\\s+(?:now\\s+)?be\\s+(" + DONE_WORDS + "|back up|back online|working)\\b"));
// A short confirmation right after a sentence that mentions an action turns
// that sentence into a claim: "Restarting Odoo." ... "Done."
const CONFIRM_EN = /^\s*(?:yes|yep|yeah|ok|okay|done|all good|all set|success|successful|complete|completed|finished|there you go|it worked|that worked|worked|it's back|its back|back up|good to go|and done|sorted)\b/;
const CONFIRM = uni(CONFIRM_EN);
const ACTION_ANY = uni(new RegExp("\\b(" + DONE_WORDS + "|" + DO_WORDS + "|" + DO_ING + ")\\b"));
const ATTRIBUTION_EN = /\b(?:mint|moni)(?:\s+ai)?\b(?:\s+\w+){0,3}?\s+(said|says|replied|replies|answered|answers|reported|reports|confirmed|confirms|told|found|responded|thinks|wrote|mentioned|suggests|suggested|recommends|recommended|explained|explains)\b/;
const ATTRIBUTION = uni(ATTRIBUTION_EN);
const ANSWER_IS = uni(/\b(its|the|mint ai's|mints|mint's|moni ai's|monis|moni's)\s+(answer|reply|response)\s+(is|was|says|said)\b/);
const STATUS_TERM = uni(
  /\b(disk|disks|storage|memory|ram|cpu|load|uptime|service|services|odoo|nginx|postgres|postgresql|fail2ban|ssh|firewall|ufw|dashboard|session|sessions|mission|missions|step|steps|decision|decisions|approval|approvals|backup|backups|server|machine|vps|database|logs?|certificate|website|site|email|cron|agents?|telegram|github|repo|repository|commit|branch|system|systems)\b/g
);
const STATE_WORD = uni(
  /\b(running|up|down|healthy|fine|ok|okay|good|bad|failed|failing|active|inactive|full|empty|busy|idle|stopped|working|broken|stable|pending|open|online|offline|clean|dirty|expired|valid|current|behind|ahead|synced|succeeded|successful)\b/
);
// Strong enough to be a status claim even when the subject is only "it" or "everything".
const STATE_STRONG = uni(/\b(running|up|down|healthy|failed|failing|active|inactive|full|busy|idle|stopped|working|broken|stable|pending|online|offline|expired)\b/);
const PRONOUN_SUBJECT = uni(/^(?:and |but |so |also )?(it|it's|its|that|that's|thats|they|they're|theyre|this|these|those|everything|everything's|all|both|all of them)\b/);
const HEDGE = uni(/\b(whether|if|ask|asked|asking|check|checking|find out|look into|looking into|wants? to know|want me to)\b|[?؟]\s*$/);
const MINT_NAME = /mint|moni|مينت|منت|موني/;
const STEP_TALK = uni(/\b(step|steps|mission|missions|خطوه|الخطوه|خطوات|الخطوات|مهمه|المهمه|المهام|مشن|المشن)\b/);
const QUESTION_END = /[?؟]\s*$/;
const SCREEN = uni(/\bscreen\b|الشاشه/);

const NUMBER_WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

function norm(text) {
  // Arabic in one spelling, its digits in ASCII (lib/voice-arabic.js).
  return arabic
    .normalize(String(text || ""))
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");
}

/**
 * Numbers said in a text: digits (1,234.5 → 1234.5; Arabic-Indic ٤١ and Eastern
 * ۴۱ digits, ٫ and ٬ too), English number words from two up, and Arabic number
 * words («واحد وأربعين» → 41, «تلاتة ونص» → 3.5).
 */
function numbersIn(text) {
  const t = arabic.joinDigits(norm(text));
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
  if (arabic.hasArabic(t)) out.push(...arabic.numberWords(t));
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

/**
 * The figures a SUMMARY may say: exactly as written, or rounded correctly
 * (to a whole number or one decimal). 2.7 may become 3, never 2.
 */
function strictNumberSet(texts) {
  const s = new Set();
  for (const t of texts) {
    for (const n of numbersIn(t)) {
      s.add(n);
      s.add(Math.round(n));
      s.add(Math.round(n * 10) / 10);
    }
  }
  return s;
}

function clauses(text) {
  return norm(text)
    .split(/[.!?;:\n؟؛]+|,\s|،\s?|\s[—–-]\s|\s(?:but|and|so|then|because|while|although|لكن|ثم|وبعدين)\s/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Is there a negation before `idx` in this clause? (English: anywhere before; Arabic: just before.) */
function negatedBefore(clause, idx) {
  return NEGATION.test(clause.slice(0, idx)) || (arabic.hasArabic(clause) && arabic.negatedAt(clause, idx));
}

/* ------------------------------------------------ sentences, in order -- */

const SENTENCE_END = /[.!?؟]+["'”’)\]»]*(?=\s|$)/g;

/**
 * The complete sentences of `text`. While a response is still streaming the
 * last, unfinished piece is left out; once it is `final` it counts too.
 */
function sentencesOf(text, final) {
  const t = String(text || "");
  const out = [];
  let at = 0;
  SENTENCE_END.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END.exec(t))) {
    const end = m.index + m[0].length;
    if (end === t.length && !final) break; // "... 61." may still be "... 61.5"
    const s = t.slice(at, end).trim();
    at = end;
    if (s) out.push(s);
  }
  if (final) {
    const rest = t.slice(at).trim();
    if (rest) out.push(rest);
  }
  return out;
}

const HANDOFF_ANY = new RegExp(HANDOFF.source, "u"); // not global: no lastIndex to trip over
/**
 * The passive hand-off in Arabic: «تم تمرير الطلب لـ MINT AI», «طلبك اتبعت لـ
 * MINT AI» ("the request has been passed to MINT AI"). It says an action was
 * done, so it is a claim -- unless an ask_moni call really happened in this
 * turn, when it is simply true (judge ctx.askedNow). The English forms ("has
 * been passed to MINT AI") are hand-offs already.
 */
const HANDOFF_PASSIVE_AR = new RegExp(
  "(?<![\\p{L}])[وف]?(?:(?:تم|اتم|اتعمل|جري)\\s+(?:تمرير|ارسال|تحويل|توصيل|رفع|نقل|تسليم|بعت)\\p{L}*|(?:اتبعت|اتحول|اتنقل|اترفع|اتسلم|اتوصل|اترسل|تم)\\p{L}*)" +
    "(?:\\s+[^\\s.,;!?،؛؟]+){0,3}?\\s*(?:ل|لل|الي|علي|مع)?\\s*" + arabic.MINT + "(?![\\p{L}])",
  "gu"
);
const HANDOFF_FUTURE = uni(/\b(let me|i'll|i will|ill|i'm going to|im going to|going to|i'd|i would)\b/);

function withoutHandoff(text) {
  return norm(text).replace(HANDOFF, " «handoff» ");
}

/**
 * Can this sentence be released before the next one arrives? Not when it
 * mentions an action (the next sentence could be "Done."), when it is a
 * fragment ("Odoo." / "About the disk:"), or when it ends on a colon.
 */
function needsNext(sentence) {
  const s = withoutHandoff(sentence);
  const words = norm(sentence).match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length < 3) return true;
  if (/[:,;،؛]\s*$/.test(String(sentence).trim())) return true;
  return ACTION_ANY.test(s) || arabicAction(s);
}

/** Does this (normalized) text mention an action in Arabic, not negated? */
function arabicAction(s) {
  if (!arabic.hasArabic(s)) return false;
  return clauses(s).some((c) => arabic.claimsIn(c).some((x) => !x.negated) || !!arabic.nounFirst(c));
}

// A hand-off verb, Arabic or English, that MINT AI's name has not followed yet.
const HANDOFF_VERB_AR = new RegExp("(?<![\\p{L}])[وف]?(?:[هحب]|سا|س)?ا?(?:" + arabic.HANDOFF_STEMS + ")\\p{L}*", "u");
const HANDOFF_VERB_EN = uni(/\b(?:pass(?:ed|ing)?|hand(?:ed|ing)?|sen[dt]|sending|forward(?:ed|ing)?|relay(?:ed|ing)?|ask(?:ed|ing)?|told|tell(?:ing)?)\b/);
const PASSIVE_START_AR = /(?<![\p{L}])[وف]?(?:تم|اتم|جري)\s+(?:تمرير|ارسال|تحويل|توصيل|رفع|نقل|تسليم|بعت)/u;
function mayBecomeHandoff(sentence) {
  const s = norm(sentence);
  // «تم تمرير الطلب لـ ...»: a passive hand-off whose MINT AI has not arrived yet.
  const p = PASSIVE_START_AR.exec(s);
  if (p && !MINT_NAME.test(s.slice(p.index))) return true;
  // ...or one whose next word has not arrived: «تم ...». (One word later it is judged again.)
  if (/(?<![\p{L}])[وف]?(?:تم|اتم|جري)\s*$/u.test(s)) return true;
  const m = HANDOFF_VERB_AR.exec(s) || HANDOFF_VERB_EN.exec(s);
  return !!m && !MINT_NAME.test(s.slice(m.index));
}

/** Does this sentence mention passing something to MINT AI? */
function mentionsHandoff(sentence) {
  return HANDOFF_ANY.test(norm(sentence));
}

/* ---------------------------------------- the summary: held to the reply -- */

const STEM_IRREG = { ran: "run", sent: "send", did: "do", done: "do", made: "make", took: "take", gave: "give", told: "tell", found: "find", got: "get", went: "go", came: "come", wrote: "write", written: "write", shut: "shut", set: "set", put: "put", froze: "freeze", began: "begin", begun: "begin" };
// Words a summary may fairly use for one another ("make a mockup" / "create mockups").
// (Keys and values are stems.)
const SYNONYM = { creat: "mak", build: "mak", remov: "delet", eras: "delet", wip: "delet", purg: "delet", reboot: "restart", repair: "fix", resolv: "fix", pass: "send", forward: "send", deni: "deny", declin: "deny", reject: "deny", launch: "start" };
function stem(word) {
  let w = String(word || "").toLowerCase().split(" ")[0];
  if (STEM_IRREG[w]) w = STEM_IRREG[w];
  const s = w
    .replace(/ied$/, "y")
    .replace(/(ing|ed|es|s)$/, "")
    .replace(/([^aeiou])\1$/, "$1")
    .replace(/e$/, "");
  return SYNONYM[s] || s;
}

// "up"/"down" are states only after a verb of being: "Odoo is up", not "pick them up".
const ALIVE = { running: 1, active: 1, online: 1, working: 1, healthy: 1, answering: 1, live: 1, stopped: -1, inactive: -1, offline: -1, failed: -1, failing: -1, fails: -1, fail: -1, broken: -1, dead: -1, crashed: -1 };
const ALIVE_RE = uni(/\b(running|active|online|working|healthy|answering|live|stopped|inactive|offline|failed|failing|fails|fail|broken|dead|crashed)\b|\b(?:is|are|was|were|'s|s|be|been|stays?|still|back|go|goes|going|went)\s+(up|down)\b/g);
const ACTION_RE = uni(new RegExp("\\b(" + DONE_WORDS + ")\\b|\\b(" + DO_WORDS + "|" + DO_ING + ")\\b", "g"));
const FUTURE_RE = uni(/\b(will|'ll|ll|going to|gonna|shall|would|could|can|may|might|once|if|when|after|before|until|unless|should|wants? to|asked (?:it|them|me|you) to|ask(?:ed)? to|needs? (?:your|you)|to be|ready to|about to|plan(?:s|ned)? to|try(?:ing)? to|still to|yet to|لو|اذا|لما|لحد|لازم|محتاج|يحتاج|ممكن|يمكن|عايز|عاوز|طلب|سوف|هل)\b/);

/**
 * The polar statements in one clause: a state ("running", "is down") or an
 * action ("deleted", "will restart"), with its sign (a negation before it
 * flips it) and whether it is only intended (future, conditional, asked-for).
 */
function polarClaims(clause) {
  const out = [];
  ALIVE_RE.lastIndex = 0;
  let m;
  while ((m = ALIVE_RE.exec(clause))) {
    const w = m[1] || m[2];
    const base = w === "up" ? 1 : w === "down" ? -1 : ALIVE[w];
    const idx = m.index + m[0].length - w.length;
    out.push({ concept: "alive", word: w, sign: negatedBefore(clause, idx) ? -base : base, future: FUTURE_RE.test(clause.slice(0, idx)), idx });
  }
  ACTION_RE.lastIndex = 0;
  while ((m = ACTION_RE.exec(clause))) {
    const w = m[1] || m[2];
    if (ALIVE[w] !== undefined || w === "running") continue; // a state, counted above
    const past = !!m[1];
    const idx = m.index;
    const before = clause.slice(0, idx);
    out.push({ concept: "act:" + stem(w), word: w, sign: 1, future: !past || FUTURE_RE.test(before), idx });
  }
  if (arabic.hasArabic(clause)) out.push(...arabicPolar(clause));
  // A negation reaches the next polar word after it, not every one after it:
  // "nothing was SENT to delete the file" negates the sending, not the delete.
  out.sort((a, b) => a.idx - b.idx);
  let from = 0;
  for (const p of out) {
    if (p.ar) {
      from = p.idx + p.word.length; // its sign was read by the Arabic rules
      continue;
    }
    const neg = NEGATION.test(clause.slice(from, p.idx));
    const base = p.concept === "alive" ? Math.abs(p.sign) * (p.word === "up" ? 1 : p.word === "down" ? -1 : ALIVE[p.word]) : 1;
    p.sign = neg ? -base : base;
    from = p.idx + p.word.length;
  }
  return out;
}

/**
 * The Arabic polar statements of a clause: actions (by the English concept, so
 * an Arabic summary is held to an English reply and back) and states. The
 * sign comes from the Arabic negation rules (a particle just before, or ما…ش).
 */
const AR_PAST = new Set(["did1", "amb", "did3", "pass", "done", "ptc1"]);
const ACTION_WORD = new RegExp("^(?:" + DONE_WORDS + "|" + DO_WORDS + "|" + DO_ING + ")$");
function arabicPolar(clause) {
  const out = [];
  const words = arabic.wordsOf(clause);
  for (const c of arabic.claimsIn(clause)) {
    let en = c.generic ? null : c.en;
    if (!en) {
      // "عمل restart", "هيعمل deploy": an Arabic light verb with an English action.
      const i = words.findIndex((w) => w.idx === c.idx);
      const obj = words.slice(i + 1, i + 3).find((w) => ACTION_WORD.test(w.w));
      if (obj) en = obj.w;
    }
    if (!en) continue; // "done" / "I did" with no action named: a bare claim, judged in judge()
    const future = !AR_PAST.has(c.role) || FUTURE_RE.test(clause.slice(0, c.idx));
    out.push({ concept: "act:" + stem(en), word: c.word, sign: c.negated ? -1 : 1, future, idx: c.idx, ar: true });
  }
  for (const s of arabic.statesIn(clause)) {
    if (!s.alive) continue;
    out.push({ concept: "alive", word: s.word, sign: s.sign, future: FUTURE_RE.test(clause.slice(0, s.idx)), idx: s.idx, ar: true });
  }
  return out;
}

const STOP = new Set(
  "the a an and or but so to of in on at for with from by is are was were be been being it its it's this that these those there here have has had do does did not no yes you your yours i i'm i've me my we our they them their he she his her mint moni ai says said about also just only still now then than more most some any all each every which what when where who whom how why will would could should can may might must shall into onto over under again once very really".split(" ")
);
function contentWords(text) {
  const en = (norm(text).match(/[a-z][a-z0-9'@._-]{2,}/g) || [])
    .map((w) => w.replace(/['._-]+$/, "").replace(/'s$/, ""))
    .filter((w) => !STOP.has(w) && w.length >= 4)
    .map(stem);
  if (!arabic.hasArabic(text)) return en;
  // Arabic: an action word as its concept's stem, a status term as the English name.
  return en.concat(arabic.contentWords(text).map((x) => (x.concept ? stem(x.concept) : x.word)));
}

const RECOMMEND_EN = /\b(should|recommends?|recommended|recommendation|suggests?|suggested|advises?|advised|(?:best|better) to|you (?:may|might) want|consider|ought to|proposes?|proposed|you need to|you'll need to|you will need to|you have to|you must)\b/;
const RECOMMEND = uni(RECOMMEND_EN);
const REPLY_RECOMMEND_EN = /\b(should|recommend\w*|suggest\w*|advis\w*|best|better|consider|ought|propos\w*|need to|needs your|have to|must|if you (?:still )?want|want me to|say yes|reply|tell me|ask again|i'd|i would)\b|^\W*(?:\d+\W+)?(?:connect|check|open|run|get|use|ask|reply|say|tell|install|reboot|restart|approve|type|go|click|enter|switch|pick|choose|add|remove|delete|update)\b/;
const REPLY_RECOMMEND = uni(REPLY_RECOMMEND_EN);
const REPLY_NEEDS_APPROVAL_EN =
  /\b(needs?|waiting (?:for|on)|requires?|awaiting|wants?)\b[^.\n]{0,40}\b(approval|go-ahead|go ahead|decision|confirmation|answer|choice)\b|\bapproval cards?\b|\bdecisions? inbox\b|\bif you approve\b|\bsay yes\b|\bplease (?:confirm|approve|decide|choose|pick|reply)\b|\breply "|\btell me (?:which|when|whether|if)\b|\bdo you want\b|\bshould i\b/;
const REPLY_NEEDS_APPROVAL_U = uni(REPLY_NEEDS_APPROVAL_EN);
const REPLY_NEEDS_APPROVAL = { test: (t) => REPLY_NEEDS_APPROVAL_U.test(t) || arabic.NEEDS_APPROVAL_AR.test(t) };
const SUMMARY_MENTIONS_APPROVAL_EN = /\b(approv\w*|go-ahead|go ahead|your ok|your okay|your yes|confirm\w*|decid\w*|decision|your answer|your choice|choose|pick|asks? (?:if|whether|you|the administrator)|wants? to know|would like|your call|let (?:it|mint ai|moni ai) know)\b/;
const SUMMARY_MENTIONS_APPROVAL_U = uni(SUMMARY_MENTIONS_APPROVAL_EN);
const SUMMARY_MENTIONS_APPROVAL = { test: (t) => SUMMARY_MENTIONS_APPROVAL_U.test(t) || arabic.MENTIONS_APPROVAL_AR.test(t) };
const UNSPEAKABLE = uni(/(?:^|\s)\/[\w.-]+\/[\w./-]*|https?:\/\/|`|\b(?:sudo|systemctl|rm -\w+|git push)\b|\s--[a-z]/i);
const NAME_ALLOW = new Set(["mint", "moni", "ai", "i", "i'm", "i've", "command", "center", "centre", "claude", "gpt", "ok", "okay", "the", "it"]);

/** Names and identifiers in a summary that the reply (or snapshot, or the request) never gave. */
function unknownName(sentence, known) {
  const toks = String(sentence).split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i].replace(/^[("'“‘[]+|[)"'”’\].,;:!?]+$/g, "").replace(/['’]s$/, "");
    if (!tok || /^\d[\d,.%]*$/.test(tok)) continue;
    const lower = tok.toLowerCase();
    if (NAME_ALLOW.has(lower)) continue;
    const ident = (/\d/.test(tok) && /[a-z]/i.test(tok)) || /\w[._@/]\w/.test(tok);
    const capital = i > 0 && /^[A-Z][a-zA-Z]+$/.test(tok) && !/[.!?:]$/.test(toks[i - 1]);
    if ((ident || capital) && !known.includes(lower)) return tok;
  }
  return null;
}

/**
 * The summary rules for one clause. `reply` is { clauses: [{text, claims}], text }.
 */
const ADMIN_DECIDES = uni(/\b(administrator|you|your|انت|انتي|حضرتك|موافقتك|ردك|قرارك)\b|\p{L}+(?:ك|كم)(?![\p{L}])/);
const DECIDE_STEMS = new Set(["approv", "confirm", "decid", "choos", "pick", "answer", "reply", "enabl", "disabl"]);
const ASKS_ADMIN = uni(/\b(needs?|waiting|wait|required?|asks?|asking|asked|wants?|up to|محتاج|يحتاج|منتظر|مستني|عايز|عاوز|بيسال|يسال|بانتظار)\b/);
function summaryClause(cl, rawClause, reply) {
  const rec = recommendationAdded(cl, rawClause, reply);
  if (rec) return rec;
  // "The administrator needs to approve the push" restates a pending approval,
  // which the reply has: it is not a claim about an action.
  const aboutApproval = reply.needsApproval && ADMIN_DECIDES.test(cl) && ASKS_ADMIN.test(cl);
  for (const p of polarClaims(cl)) {
    if (aboutApproval && DECIDE_STEMS.has(p.concept.slice(4))) continue;
    let cands = reply.clauses.flatMap((rc) => rc.claims.filter((q) => q.concept === p.concept).map((q) => ({ ...q, anchors: rc.anchors })));
    if (!cands.length && p.concept.startsWith("act:")) {
      // The reply may say it with a verb outside the action list ("make a mockup"
      // for "create mockups"): any word of the same stem, read the same way.
      const want = p.concept.slice(4);
      cands = reply.clauses.flatMap((rc) => {
        const out = [];
        for (const m of rc.text.matchAll(/[a-z][a-z']+/g)) {
          if (stem(m[0]) !== want) continue;
          const before = rc.text.slice(0, m.index);
          out.push({ concept: p.concept, sign: negatedBefore(rc.text, m.index) ? -1 : 1, future: FUTURE_RE.test(before) || !/(ed|en|t)$/.test(m[0]), anchors: rc.anchors });
        }
        return out;
      });
    }
    if (!cands.length) {
      if (p.concept === "alive") return { rule: "not-in-reply", match: rawClause };
      return { rule: p.future ? "promise" : "added-claim", match: rawClause };
    }
    const anchors = contentWords(cl).filter((w) => w !== stem(p.word));
    const anchored = cands.filter((q) => anchors.some((a) => q.anchors.includes(a)));
    const pool = anchored.length ? anchored : cands;
    if (p.concept !== "alive" && p.sign > 0 && !p.future) {
      if (pool.some((q) => q.sign > 0 && !q.future)) continue;
      if (pool.some((q) => q.sign < 0 && !q.future)) return { rule: "negation-flipped", match: rawClause };
      return { rule: "pending-as-done", match: rawClause };
    }
    // "It wasn't deleted" is fair when the reply never says it was (only
    // that it might be): only a reply saying it happened contradicts it.
    if (p.concept !== "alive" && p.sign < 0 && !p.future) {
      if (pool.some((q) => q.sign > 0 && !q.future)) return { rule: "negation-flipped", match: rawClause };
      continue;
    }
    if (pool.some((q) => q.sign === p.sign)) continue;
    return { rule: "negation-flipped", match: rawClause };
  }
  return null;
}

/** "MINT AI suggests ..." -- only if MINT AI suggested it. */
function recommendationAdded(cl, rawClause, reply) {
  const r = RECOMMEND.exec(cl) || arabic.RECOMMEND_AR.exec(cl);
  if (!r || negatedBefore(cl, r.index)) return null;
  const words = contentWords(cl).filter((w) => !/^(recommend|suggest|advis|consider|propos|should|need)/.test(w));
  const replyWords = contentWords(reply.text);
  const shared = words.filter((w) => replyWords.includes(w));
  const backed = reply.sentences.some((s) => {
    const n = norm(s).replace(/^[\s*#>-]+/, "");
    return (REPLY_RECOMMEND.test(n) || arabic.REPLY_RECOMMEND_AR.test(n)) && contentWords(s).some((w) => words.includes(w));
  });
  // Every action it recommends must be one the reply names ("rotate the log" is not "delete the log").
  const acts = polarClaims(cl).filter((p) => p.concept.startsWith("act:")).map((p) => p.concept.slice(4));
  const replyActs = new Set(reply.clauses.flatMap((c) => c.claims.filter((p) => p.concept.startsWith("act:")).map((p) => p.concept.slice(4))));
  if (!backed || shared.length * 2 < words.length || acts.some((a) => !replyActs.has(a))) return { rule: "added-recommendation", match: rawClause };
  return null;
}

function replyModel(text) {
  const sentences = sentencesOf(text, true);
  return {
    text: String(text || ""),
    sentences,
    clauses: withAnchors(clauses(text)),
    needsApproval: REPLY_NEEDS_APPROVAL.test(norm(text)),
  };
}

/**
 * Each clause of a reply with the words it is about. "It's running" is about
 * whatever the clause before was about, so a pronoun subject borrows them.
 */
function withAnchors(list) {
  let prev = [];
  const out = list.map((c) => {
    const own = contentWords(c);
    const anchors = PRONOUN_SUBJECT.test(c) ? [...own, ...prev] : own;
    prev = anchors;
    return { text: c, claims: polarClaims(c), anchors };
  });
  // A short label ("Not installed yet:") is about what follows it.
  for (let i = 0; i < out.length - 1; i++) if ((out[i].text.match(/[\p{L}\p{N}']+/gu) || []).length <= 4) out[i].anchors = [...out[i].anchors, ...contentWords(out[i + 1].text)];
  return out;
}

/**
 * Judge sentences in order, each with the ones before it.
 *
 * @param sentences  the desk's sentences (sentencesOf)
 * @param ctx   { numbers: Set, replyText, snapshotText, heardText, replied,
 *                grounded, summary: bool (the words are a summary of replyText) }
 * @returns { ok: true } or { ok: false, rule, match, at } -- `at` is the index
 *          of the earliest sentence the failure implicates.
 */
function judge(sentences, ctx) {
  const c = ctx || {};
  const replyText = norm(c.replyText || "");
  const snapText = norm(c.snapshotText || "");
  const summary = !!c.summary;
  const reply = summary ? c.replyModel || replyModel(c.replyText || "") : null;
  const known = summary ? [norm(c.replyText || ""), snapText, norm(c.heardText || "")].join("\n") : "";
  const whole = norm(sentences.join(" "));
  // Talking about missions and their steps, from a snapshot that has step
  // statuses: "done" is a status there, not a claim. (Judged over the whole
  // text, since commas split "the first step, Design, is done".)
  const stepTalk = !summary && !!c.grounded && STEP_TALK.test(whole) && /"status":"(done|skipped)"/.test(snapText);
  const numbers = c.numbers || new Set();
  let prevTerms = [];
  let prevAction = false;
  let replyDone = null; // the actions the reply says were done, read once when needed
  const replyDid = (concept) => {
    if (!replyDone) {
      replyDone = new Set();
      for (const rc of clauses(c.replyText || "")) for (const p of polarClaims(rc)) if (p.concept !== "alive" && p.sign > 0 && !p.future) replyDone.add(p.concept);
    }
    return replyDone.has(concept);
  };
  const fail = (rule, match, at) => ({ ok: false, rule, match: String(match), at });
  for (let si = 0; si < sentences.length; si++) {
    const sentence = sentences[si];
    const sClauses = clauses(sentence);
    // Fail closed: letters in a script the guard cannot read (neither Latin nor Arabic).
    if (arabic.scriptOf(sentence).other) return fail("unknown-script", sentence, si);
    // A confirmation right after an action sentence: the pair is the claim.
    if (si > 0 && prevAction && sClauses.length && (CONFIRM.test(sClauses[0]) || arabic.confirmFirst(sClauses[0]))) return fail("action-claim", sentences[si - 1] + " " + sentence, si - 1);
    for (const raw of sClauses) {
      const cl = summary ? raw : (c.askedNow ? raw.replace(HANDOFF_PASSIVE_AR, " «handoff» ") : raw).replace(HANDOFF, " «handoff» ");
      let m;
      if ((m = CLAIM_FIRST.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length)) return fail("action-claim", raw, si);
      if ((m = PROGRESSIVE_FIRST.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length)) return fail("action-claim", raw, si);
      if (!summary && (m = PROGRESSIVE_BARE.exec(cl))) return fail("action-claim", raw, si); // in a summary a gerund is a noun ("recommends rebooting"), judged below
      if (summary) {
        const ar = arabicSummaryRule(cl);
        if (ar) return fail(ar, raw, si);
        const s = summaryClause(cl, raw, reply);
        if (s) return fail(s.rule, s.match, si);
        if ((m = CLAIM_BARE.exec(cl)) && !polarClaims(cl).length) return fail("added-claim", raw, si);
      } else {
        if ((m = CLAIM_BARE.exec(cl)) && !(stepTalk && /^(done|finished|completed)$/.test(m[1]))) return fail("action-claim", raw, si);
        if ((m = CLAIM_THIRD.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length)) {
          const word = m[2];
          const fromReply = replyText && uni(new RegExp("\\b" + word.replace(/ /g, "\\s+") + "\\b")).test(replyText);
          // "1 of 4 steps done", "the mission has completed 1 out of 4 steps": a status, from the snapshot.
          const stepStatus = /^(done|completed|finished)$/.test(word) && stepTalk;
          if (!fromReply && !stepStatus) return fail("action-claim", raw, si);
        }
        if ((m = PROMISE.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length)) return fail("promise", raw, si);
        if ((m = SHOULD_BE.exec(cl)) && !negatedBefore(cl, m.index)) return fail("promise", raw, si);
        if (!c.replied) {
          if ((m = ATTRIBUTION.exec(cl)) && !negatedBefore(cl, m.index + m[0].length)) return fail("invented-reply", raw, si);
          if ((m = ANSWER_IS.exec(cl)) && !negatedBefore(cl, m.index)) return fail("invented-reply", raw, si);
        }
        // A status claim needs the snapshot behind it, and must be about something
        // the snapshot covers ("the backups are fine" never is). "It" and
        // "everything" borrow their subject from the clause before.
        const ar = arabic.hasArabic(cl);
        if (ar) {
          const rule = arabicDeskRule(cl, { stepTalk, replyDid, replied: !!c.replied });
          if (rule) return fail(rule, raw, si);
        }
        // (Arabic status words and terms count the same, named by the snapshot's English terms.)
        const arStates = ar ? arabic.statesIn(cl) : [];
        let terms = [...cl.matchAll(STATUS_TERM)].map((x) => x[1]).concat(ar ? arabic.termsIn(cl) : []);
        const strong = STATE_STRONG.test(cl) || arStates.some((x) => x.strong);
        if (!terms.length && (PRONOUN_SUBJECT.test(cl) || (ar && arabic.pronounSubject(cl))) && strong) terms = prevTerms.length ? prevTerms : ["(unnamed)"];
        const stateWord = STATE_WORD.test(cl) || arStates.length > 0;
        const hedge = HEDGE.test(cl) || (ar && arabic.hedged(cl));
        if (terms.length && stateWord && !hedge && !MINT_NAME.test(cl)) {
          if (!c.grounded) return fail("ungrounded", raw, si);
          const knownTerm = terms.some((t) => t === "(unnamed)" || snapText.includes(t.replace(/s$/, "")));
          if (!knownTerm && !(replyText && terms.some((t) => replyText.includes(t.replace(/s$/, ""))))) return fail("not-in-snapshot", raw, si);
        }
        if (terms.length) prevTerms = terms;
      }
    }
    if (summary) {
      if (UNSPEAKABLE.test(sentence)) return fail("unspeakable", sentence, si);
      const name = unknownName(sentence, known);
      if (name) return fail("added-name", name, si);
    }
    for (const n of numbersIn(sentence)) {
      if (!numbers.has(n)) return fail("figure", String(n), si);
    }
    const s = withoutHandoff(sentence);
    prevAction = !QUESTION_END.test(sentence.trim()) && ((ACTION_ANY.test(s) && !NEGATION.test(s)) || arabicAction(s));
  }
  return { ok: true };
}

/**
 * The Arabic rules at the desk, for one clause (normalized, hand-off removed):
 * the same claims the English rules cut, read with the Arabic lexicon.
 *   I did / we did / I am doing it        → action-claim   (CLAIM_FIRST, PROGRESSIVE_FIRST)
 *   done / it was done / it is being done → action-claim, unless MINT AI's
 *                                           reply says it was (CLAIM_THIRD) or
 *                                           it is a step's status (CLAIM_BARE)
 *   I will / it will                      → promise        (PROMISE; "I'll send
 *                                           you" is a promise to talk)
 *   an action noun first ("إعادة تشغيل")  → action-claim   (PROGRESSIVE_BARE)
 *   "right now" with an action            → promise
 *   "MINT AI said ..." before a reply     → invented-reply (ATTRIBUTION)
 *   a past-tense result it cannot read    → unparsed-claim (fail closed)
 */
function arabicDeskRule(cl, { stepTalk, replyDid, replied }) {
  const claims = arabic.claimsIn(cl);
  for (const x of claims) {
    if (x.negated) continue;
    if (x.role === "did1" || x.role === "amb" || x.role === "prog1" || x.role === "ptc1") return "action-claim"; // ptc1: «أنا عاملة ده»
    if (x.role === "done" || x.role === "pass" || x.role === "prog3") {
      if (stepTalk && x.role === "done" && x.generic) continue;
      if (!x.generic && replyDid("act:" + stem(x.en))) continue;
      return "action-claim";
    }
    if (x.role === "fut1") {
      // "I'll send you / update you" is a promise to talk; "I'll delete it for you" is not.
      if (x.addressee && (x.en === "send" || x.en === "update")) continue;
      return "promise";
    }
    if (x.role === "fut3") return "promise";
  }
  if (arabic.nounFirst(cl)) return "action-claim";
  if (arabic.nowMarker(cl)) {
    const action = claims.some((x) => !x.negated) || ACTION_ANY.test(cl);
    const status = arabic.statesIn(cl).length || arabic.termsIn(cl).length || STATUS_TERM.test(cl);
    STATUS_TERM.lastIndex = 0;
    if (action || !status) return "promise";
  }
  if (!replied && arabic.attribution(cl)) return "invented-reply";
  if (arabic.unparsed(cl)) return "unparsed-claim";
  return null;
}

/**
 * The Arabic rules in a summary, beyond what summaryClause checks against the
 * reply: never "I did" (the desk speaks of MINT AI in the third person); a
 * bare "done" (تم، خلاص) that names nothing the reply did; a result it cannot read.
 */
function arabicSummaryRule(cl) {
  if (!arabic.hasArabic(cl)) return null;
  const claims = arabic.claimsIn(cl);
  for (const x of claims) {
    if (x.negated) continue;
    if (x.role === "did1" || x.role === "prog1" || x.role === "ptc1") return "action-claim";
    if (x.generic && (x.role === "done" || x.role === "pass") && !polarClaims(cl).length) return "added-claim";
  }
  if (arabic.unparsed(cl)) return "unparsed-claim";
  return null;
}

/**
 * Check the desk's own words (all of them, as one text).
 * @returns { ok: true } or { ok: false, rule, match, at }
 */
function guard(text, ctx) {
  return judge(sentencesOf(text, true), ctx);
}

/**
 * Does this say the request was (or is being) passed to MINT AI when no
 * ask_moni call backs it? `askedNow`: ask_moni ran this turn (or is in this
 * very response). `pending`: an earlier request is still unanswered, which
 * backs a past-tense mention ("I've passed that on") but not a new promise.
 */
const ANSWER_PROMISE_EN = uni(/\b(?:read|tell|give|pass|let) you\b[^.]{0,40}\b(?:answer|reply|response)\b|\b(?:its|mint ai's|moni ai's|the) (?:answer|reply|response)\b[^.]{0,20}\bwhen it (?:arrives|comes)\b/);
const ANSWER_PROMISE = { test: (t) => ANSWER_PROMISE_EN.test(t) || arabic.ANSWER_PROMISE_AR.test(t), search: (t) => Math.max(t.search(ANSWER_PROMISE_EN), t.search(arabic.ANSWER_PROMISE_AR)) };
const OFFER_EN = uni(/\b(want me to|shall i|should i|do you want|i can|i could|can i|could i)\b/);
function unbackedHandoff(text, { askedNow, pending } = {}) {
  if (askedNow) return null;
  for (const cl of clauses(text)) {
    // "I'll read you MINT AI's reply when it arrives" -- with nothing asked, there is no reply coming.
    if (!pending && ANSWER_PROMISE.test(cl) && !negatedBefore(cl, ANSWER_PROMISE.search(cl))) return { ok: false, rule: "unbacked-handoff", match: cl };
    const m = HANDOFF_ANY.exec(cl);
    if (!m) continue;
    if (QUESTION_END.test(cl) || OFFER_EN.test(cl) || arabic.OFFER_AR.test(cl)) continue; // an offer, not a claim
    if (negatedBefore(cl, m.index)) continue;
    const upTo = cl.slice(0, m.index + m[0].length);
    const future = HANDOFF_FUTURE.test(upTo) || arabic.HANDOFF_AR_FUTURE.test(upTo);
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

/**
 * Releases a streaming response sentence by sentence, each only once the
 * guard has passed it in context (see the header).
 *
 *   update(text, final, info)  text so far; `final` once the response is done;
 *                              info: { askedNow(), pending() } for hand-offs
 *
 * `released` counts sentences handed to onLine; `trip` is set once the guard
 * cuts, after which nothing more is released.
 */
class Releaser {
  constructor(ctxFn, onLine, opts) {
    this.ctxFn = ctxFn;
    this.onLine = onLine || (() => {});
    this.summary = !!(opts && opts.summary);
    this.released = 0;
    this.sentences = [];
    this.trip = null;
  }

  update(text, final, info) {
    if (this.trip) return;
    const i = info || {};
    // A summary's markdown emphasis (`code`, **bold**) is formatting, not words.
    const list = sentencesOf(this.summary ? String(text).replace(/[`*]+/g, "") : text, final);
    this.sentences = list;
    // A hand-off said in the passive is true once the ask_moni call is known.
    const ctxNow = () => ({ ...this.ctxFn(), askedNow: !!(i.askedNow && i.askedNow()) });
    const g = judge(list, ctxNow());
    if (!g.ok) {
      this.trip = { ...g, sentence: list[g.at] || "" };
      return;
    }
    // While streaming, also judge the unfinished tail (settled words only), so
    // a response going wrong is cancelled early. It releases nothing.
    // (Not for a summary: its rules need whole clauses -- "It recommends" is
    // not yet a recommendation of anything.)
    if (!final && !this.summary) {
      const partial = settled(text);
      const plist = sentencesOf(partial, true);
      const g2 = judge(plist, ctxNow());
      // (Not while the unfinished sentence may still become a hand-off:
      // «بعتّ ده ...» is a claim until «... لـ MINT AI» arrives. The whole
      // sentence is judged before it is released either way.)
      if (!g2.ok && !(g2.at === plist.length - 1 && mayBecomeHandoff(plist[g2.at]))) {
        this.trip = { ...g2, sentence: plist[g2.at] || "" };
        return;
      }
    }
    if (final && !this.summary) {
      const u = unbackedHandoff(list.slice(this.released).join(" "), { askedNow: i.askedNow && i.askedNow(), pending: i.pending && i.pending() });
      if (u) {
        this.trip = { ...u, at: this.released };
        return;
      }
    }
    for (let k = this.released; k < list.length; k++) {
      const s = list[k];
      const last = k === list.length - 1;
      if (!final && last && needsNext(s)) break; // judged with the next one, or at the end
      if (!final && !this.summary && mentionsHandoff(s) && !(i.askedNow && i.askedNow())) break; // backed only once the calls are known
      this.released = k + 1;
      this.onLine(s);
    }
  }

  /** The sentences already heard, as one text. */
  heardText() {
    return this.sentences.slice(0, this.released).join(" ");
  }
}

/* ------------------------------------------------------ the session -- */

let seq = 0;

/**
 * One realtime conversation, for one panel user. `ops` is deskOps(). The desk
 * answers in text; its sentences are spoken, once released, by the caller.
 */
class DeskSession {
  constructor({ key, voice, model, ops, wsBase, log, sayId }) {
    this.key = key;
    this.voice = voice || "marin";
    this.model = model || DESK_MODEL;
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
    this.replies = []; // MINT AI's replies the desk has been given
    this.heard = []; // what the administrator said
    this.snapshotText = "";
    this.groundedAt = 0;
    this.lastInputTokens = 0;
    this.inflight = 0;
    this.usage = {}; // billable tokens, whole session
    this.stats = { rejected: 0, trips: 0, turns: 0, summaries: 0, refusedAsks: 0, refusedHeard: 0 };
    this.id = sayId || "desk" + ++seq;
  }

  usable() {
    return !this.dead && Date.now() - this.bornAt < MAX_AGE_MS && (!this.ws || this.ws.readyState <= WebSocket.OPEN);
  }

  /** Has this conversation grown past what is worth carrying? */
  full() {
    return this.stats.turns >= MAX_TURNS_PER_SESSION || this.lastInputTokens >= MAX_CONTEXT_TOKENS;
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
        this.send({
          type: "session.update",
          session: { type: "realtime", instructions: INSTRUCTIONS, output_modalities: ["text"], tools: TOOLS, tool_choice: "auto", max_output_tokens: 400 },
        });
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

  /** Tell the model about a reply (clipped: the conversation is re-read every response). */
  noteReply(id, reply, spoken) {
    const clipped = reply.length > REPLY_IN_CONTEXT_CHARS ? reply.slice(0, REPLY_IN_CONTEXT_CHARS) + " [...the rest is on the administrator's screen]" : reply;
    const how = spoken ? `the administrator heard this summary of it: "${spoken}", and has the full text on screen` : "the administrator has it on screen";
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "system", content: [{ type: "input_text", text: `MINT AI replied to request ${id} (${how}):\n${clipped}` }] },
    });
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
      this.noteReply(r.id, mine.reply, null);
    }
  }

  /**
   * One realtime response: text and function calls, released sentence by
   * sentence through `rel`. `create` is the response.create payload (an
   * out-of-band summary passes its own).
   */
  respond(t0, timings, rel, info, create) {
    return new Promise((resolve, reject) => {
      const st = { text: "", calls: [], itemIds: [], status: null, usage: null };
      const timer = setTimeout(() => {
        this.handler = null;
        reject(new DeskError("the front desk took too long to answer", "timeout"));
      }, RESPONSE_TIMEOUT_MS);
      let cancelled = false;
      const check = (final) => {
        const before = rel.released;
        rel.update(st.text, final, info);
        if (rel.released > before && !timings.firstLine) timings.firstLine = Date.now() - t0;
        if (rel.trip && !final && !cancelled) {
          cancelled = true;
          this.send({ type: "response.cancel" });
        }
      };
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
            if (!rel.trip) check(false);
            break;
          case "response.output_item.added":
            if (ev.item && ev.item.type === "message" && ev.item.id) st.itemIds.push(ev.item.id);
            break;
          case "response.done": {
            clearTimeout(timer);
            this.handler = null;
            const r = ev.response || {};
            st.status = r.status || "completed";
            st.usage = r.usage || null;
            for (const o of r.output || []) {
              if (o.type === "function_call") st.calls.push({ name: o.name, call_id: o.call_id, arguments: o.arguments });
              if (o.type === "message") {
                if (o.id && !st.itemIds.includes(o.id)) st.itemIds.push(o.id);
                // The finished text is authoritative (deltas can be missed on a cancel).
                const full = (o.content || []).map((p) => p.transcript || p.text || "").join("");
                if (full && !rel.trip) st.text = full;
              }
            }
            if (r.status === "failed") {
              const d = r.status_details || {};
              return reject(new DeskError("OpenAI did not finish: " + scrub((d.error && d.error.message) || d.reason || "failed"), "upstream"));
            }
            if (!rel.trip) check(true);
            return resolve(st);
          }
          default:
            break;
        }
      };
      // The calls of this very response back a hand-off said in it.
      const askedNow = info.askedNow;
      info.askedNow = () => askedNow() || st.calls.some((c) => c.name === "ask_moni");
      this.send(create || { type: "response.create" });
    });
  }

  /**
   * respond(), retried once when OpenAI reports a transient server error and
   * nothing of the response was released (seen once in ~70 real calls on
   * 2026-09-29: "The server had an error while processing your request").
   */
  async respondOnce(t0, timings, relFn, info, create) {
    let rel = relFn();
    try {
      return { st: await this.respond(t0, timings, rel, info, create), rel };
    } catch (e) {
      if (!(e instanceof DeskError) || e.code !== "upstream" || !/server had an error|server_error|try again|retry/i.test(e.message) || rel.released) throw e;
      this.log("desk: OpenAI server error, retrying once: " + e.message.slice(0, 120));
      rel = relFn();
      return { st: await this.respond(t0, timings, rel, info, create), rel };
    }
  }

  /** Count what a response cost. */
  account(st, turn) {
    if (!st || !st.usage) return;
    const t = tokensOf(st.usage);
    turn.tokens = addTokens(turn.tokens, t);
    this.usage = addTokens(this.usage, t);
    this.lastInputTokens = (st.usage.input_tokens || 0);
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
      turn.snapshotChars = json.length;
      return json;
    }
    // ask_moni
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const extra = Object.keys(args).filter((k) => k !== "text");
    if (!text || text.length > MAX_ASK_CHARS || extra.length) return JSON.stringify({ error: "ask_moni takes one field, text, of 1 to " + MAX_ASK_CHARS + " characters" });
    if (turn.asked.length >= MAX_ASKS_PER_TURN) return JSON.stringify({ error: "already passed to MINT AI; do not ask again" });
    // What MINT AI receives is this server's own transcript of the turn -- the
    // administrator's words, grounded by the intake -- never the model's `text`,
    // which can be a paraphrase that changes the meaning ("restart" heard,
    // "restore" asked). The model's text is not sent at all, not even as a
    // note; it is only checked, so a prompt echoed into it still refuses the
    // call. No grounded transcript, no hand-off.
    const request = String(turn.heard || "").trim();
    const why = !turn.grounded || !request ? "ungrounded" : voiceGuard.refuseAtDoor(text) || voiceGuard.refuseAtDoor(request) ? "echo" : null;
    if (why) {
      this.stats.refusedAsks = (this.stats.refusedAsks || 0) + 1;
      turn.rejected.push("ask_moni:" + why);
      this.log(`desk: refused an ask_moni (${why})`);
      return JSON.stringify({ error: "refused: ask_moni passes on only what the administrator said in this turn. Say you did not catch that." });
    }
    if (norm(text).replace(/[^\p{L}\p{N}]/gu, "") !== norm(request).replace(/[^\p{L}\p{N}]/gu, "")) turn.paraphrased = true; // counted, never logged in words
    const r = await this.ops.ask(request);
    const t = r && r.turn;
    if (t && t.id) this.requests.set(t.id, { text: request, answered: false, reply: null });
    turn.asked.push(t || null);
    turn.tools.push("ask_moni");
    return JSON.stringify({
      status: "passed to MINT AI",
      request: t ? t.id : null,
      queued_behind_other_work: !!(r && r.queued_behind),
      note: "MINT AI has NOT replied yet. Say only that you passed it on. A summary of its answer will be read aloud when it arrives.",
    });
  }

  /**
   * One utterance in; what to say out. `opts.onLine(line)` is called for each
   * line as soon as it may be spoken ({text, safe}). Serialised per session.
   */
  turn(heard, opts) {
    return this.serial(() => this._turn(heard, opts || {}));
  }

  /** One thing at a time per conversation; `inflight` keeps deskFor from replacing a busy desk. */
  serial(fn) {
    this.inflight++;
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    const done = () => {
      this.inflight--;
    };
    run.then(done, done);
    return run;
  }

  async _turn(heard, opts) {
    await this.open();
    this.usedAt = Date.now();
    this.stats.turns++;
    const said = String(heard || "").trim().slice(0, 4000);
    if (!said) throw new DeskError("nothing heard", "invalid");
    const timings = {};
    const t0 = Date.now();
    // What was "heard" must be words, not a prompt echoed back by the
    // transcription model (the route has checked it already; this holds
    // without it). Nothing reaches the model or MINT AI.
    const echo = voiceGuard.refuseAtDoor(said);
    if (echo) {
      this.stats.refusedHeard = (this.stats.refusedHeard || 0) + 1;
      this.log(`desk: dropped an utterance that reads as ${echo.source || "a prompt"} (${echo.rule})`);
      const empty = { kind: "turn", heard: "", asked: [], tools: [], rejected: ["heard:" + echo.rule], lines: [], trip: null, tokens: {}, responses: 0, dropped: echo.rule };
      timings.done = Date.now() - t0;
      return this.result(empty, timings);
    }
    await this.refreshReplies();
    this.heard.push(said);
    const turn = { kind: "turn", heard: said, grounded: true, asked: [], tools: [], rejected: [], lines: [], trip: null, tokens: {}, responses: 0 };
    const emit = (line) => {
      turn.lines.push(line);
      if (!timings.firstLine) timings.firstLine = Date.now() - t0;
      if (opts.onLine) opts.onLine(line, Date.now() - t0);
    };
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: said }] } });
    let heardThisResponse = "";
    // Answer in the language of this utterance (Egyptian Arabic for Arabic).
    const lang = replyLanguage(said);
    turn.lang = lang;
    const persona = personaLib.clean(opts.persona);
    this.gender = persona.gender;
    const create = { type: "response.create", response: { instructions: instructionsFor(said, persona) } };
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const rt0 = Date.now();
      const rtim = {};
      const info = { askedNow: () => turn.asked.length > 0, pending: () => [...this.requests.values()].some((r) => !r.answered) };
      const askedBefore = info.askedNow;
      const { st, rel } = await this.respondOnce(rt0, rtim, () => ((info.askedNow = askedBefore), new Releaser(() => this.context(), (text) => emit({ text, safe: false }))), info, create);
      turn.responses++;
      this.account(st, turn);
      if (!timings.firstText && rtim.firstText) timings.firstText = rt0 - t0 + rtim.firstText;
      if (turn.asked.length && !timings.ackFirst && rtim.firstLine) timings.ackFirst = rtim.firstLine;
      if (rel.trip) {
        turn.trip = { ...rel.trip, said: st.text.slice(0, 400), released: rel.released, sentence: rel.trip.sentence || rel.sentences[rel.trip.at] || "" };
        heardThisResponse = rel.heardText();
        this.stats.trips++;
        this.log(`desk: guard cut a reply (${rel.trip.rule}): ${JSON.stringify(rel.trip.match).slice(0, 160)}`);
        for (const id of st.itemIds) this.send({ type: "conversation.item.delete", item_id: id });
        break;
      }
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
      // had not. The words the guard stopped are out of the conversation; what
      // was heard and the safe line go in, so the model's memory matches.
      // The line is in the cut sentence's language (Arabic or English), or in
      // the administrator's when that sentence is in a script we cannot read.
      const L = linesFor(langOf(turn.trip.sentence, said), persona.gender);
      if (!turn.asked.length) {
        try {
          const r = await this.ops.ask(said);
          const t = r && r.turn;
          if (t && t.id) this.requests.set(t.id, { text: said, answered: false, reply: null });
          turn.asked.push(t || null);
          turn.autoAsked = true;
        } catch (e) {
          this.log("desk: could not pass the request on after the guard: " + e.message);
          emit({ text: L.unreachable, safe: true });
          timings.done = Date.now() - t0;
          return this.result(turn, timings);
        }
      }
      const saidHandoff = turn.lines.some((l) => !l.safe && mentionsHandoff(l.text));
      const line = turn.autoAsked ? L.safe : saidHandoff ? L.tail : L.asked;
      const text = (heardThisResponse ? heardThisResponse + " " : "") + line;
      this.send({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
      emit({ text: line, safe: true });
    }
    timings.done = Date.now() - t0;
    return this.result(turn, timings);
  }

  /**
   * A short spoken summary of MINT AI's reply to one of this user's desk
   * requests. `opts.onLine` as for turn(). Resolves with
   * { fallback: "verbatim" } when the reply should simply be read as written
   * (short and plain, or the summary was cut before a word was said), or
   * { pending: true } when MINT AI has not answered yet.
   */
  summarise(turnId, opts) {
    return this.serial(() => this._summarise(turnId, opts || {}));
  }

  async _summarise(turnId, opts) {
    const id = Number(turnId);
    if (!Number.isInteger(id) || id <= 0) throw new DeskError("no such request", "invalid");
    const t0 = Date.now();
    const timings = {};
    const turn = { kind: "summary", heard: "", asked: [], tools: [], rejected: [], lines: [], trip: null, tokens: {}, responses: 0 };
    let r = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const snap = await this.ops.snapshot([id]);
      r = (snap.requests_to_moni_ai || []).find((x) => x.id === id) || null;
      if (!r || r.answered) break;
      await new Promise((res) => setTimeout(res, 400)); // the page heard the end a moment before the ledger shows it
    }
    if (!r) throw new DeskError("that is not one of your front desk requests", "invalid");
    if (!r.answered) return { ...this.result(turn, timings), pending: true };
    const reply = String(r.reply || "").trim();
    const mine = this.requests.get(id) || { text: "", answered: false, reply: null };
    this.requests.set(id, mine);
    const shape = replyShape(reply);
    turn.shape = shape;
    const finish = (spoken, fallback) => {
      // Tell the conversation (if one is open; otherwise the next turn's
      // refreshReplies will), so "what did MINT AI say?" has its answer.
      if (!mine.answered && this.ready && !this.dead) {
        mine.answered = true;
        mine.reply = reply;
        this.replies.push(reply);
        this.noteReply(id, reply, spoken);
      }
      timings.done = Date.now() - t0;
      return { ...this.result(turn, timings), fallback: fallback || null, shape };
    };
    if (!reply) return finish("", "verbatim");
    if (shape.plain && reply.length <= VERBATIM_MAX_CHARS && shape.sentences <= 2) return finish("", "verbatim"); // nothing to shorten
    await this.open();
    this.usedAt = Date.now();
    this.stats.summaries++;
    const emit = (line) => {
      turn.lines.push(line);
      if (!timings.firstLine) timings.firstLine = Date.now() - t0;
      if (opts.onLine) opts.onLine(line, Date.now() - t0);
    };
    const model = replyModel(reply);
    const ctx = {
      summary: true,
      replyText: reply,
      replyModel: model,
      heardText: mine.text || "",
      snapshotText: "",
      numbers: strictNumberSet([reply, mine.text || ""]),
      replied: true,
      grounded: true,
    };
    // The language of the administrator's last utterance (else the request's, else the reply's).
    const lastSaid = this.heard.length ? this.heard[this.heard.length - 1] : mine.text || "";
    const sumLang = replyLanguage(lastSaid || reply);
    turn.lang = sumLang;
    const sumPersona = personaLib.clean(opts.persona || { gender: this.gender });
    const quoted = reply.replace(/"""/g, '"');
    const create = {
      type: "response.create",
      response: {
        conversation: "none",
        output_modalities: ["text"],
        tool_choice: "none",
        tools: [],
        max_output_tokens: SUMMARY_MAX_TOKENS,
        metadata: { purpose: "summary" },
        instructions: SUMMARY_INSTRUCTIONS,
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  (mine.text ? `The administrator asked: "${mine.text.slice(0, 500)}"\n\n` : "") +
                  `MINT AI's reply, between the triple quotes:\n"""\n${quoted}\n"""\n` +
                  (shape.list || shape.code || shape.paths ? "It has lists, code or paths: do not read them, say the details are on screen.\n" : "") +
                  summaryLanguage(lastSaid || reply, sumPersona),
              },
            ],
          },
        ],
      },
    };
    const { st, rel } = await this.respondOnce(t0, timings, () => new Releaser(() => ctx, (text) => emit({ text, safe: false }), { summary: true }), { askedNow: () => true, pending: () => false }, create);
    turn.responses++;
    this.account(st, turn);
      const convLang = sumLang;
    if (rel.trip) {
      turn.trip = { ...rel.trip, said: st.text.slice(0, 400), released: rel.released };
      this.stats.trips++;
      this.log(`desk: guard cut a summary (${rel.trip.rule}): ${JSON.stringify(rel.trip.match).slice(0, 160)}`);
      if (!rel.released && reply.length <= VERBATIM_MAX_CHARS * 2 && shape.plain) return finish("", "verbatim");
      const L = linesFor(langOf(rel.trip.sentence || rel.sentences[rel.trip.at], mine.text || reply), sumPersona.gender);
      emit({ text: rel.released ? L.summaryCut : L.summaryNone, safe: true });
    }
    const spoken = turn.lines.map((l) => l.text).join(" ");
    const C = linesFor(convLang, sumPersona.gender);
    // A pending approval or question must survive the summary.
    if (REPLY_NEEDS_APPROVAL.test(norm(reply)) && !SUMMARY_MENTIONS_APPROVAL.test(norm(spoken))) {
      turn.approvalAdded = true;
      if (!turn.trip) turn.trip = { rule: "approval-dropped", match: "", said: st.text.slice(0, 400), released: rel.released, appended: true };
      emit({ text: SCREEN.test(norm(spoken)) ? C.approvalShort : C.approval, safe: true });
    } else if (!turn.trip && (shape.list || shape.code || shape.paths || reply.length > 600) && !SCREEN.test(norm(spoken))) {
      emit({ text: C.details, safe: true });
    }
    return finish(turn.lines.map((l) => l.text).join(" "));
  }

  result(turn, timings) {
    return {
      kind: turn.kind,
      heard: turn.heard,
      lines: turn.lines,
      asked: turn.asked.filter(Boolean),
      autoAsked: !!turn.autoAsked,
      tools: turn.tools,
      rejected: turn.rejected,
      trip: turn.trip ? { rule: turn.trip.rule, match: String(turn.trip.match || "").slice(0, 200), said: turn.trip.said, released: turn.trip.released || 0 } : null,
      paraphrased: !!turn.paraphrased,
      tokens: turn.tokens,
      cost_usd: costOf(turn.tokens, this.model),
      responses: turn.responses,
      snapshot_chars: turn.snapshotChars || 0,
      dropped: turn.dropped || null,
      timings,
    };
  }
}

/** What kind of reply this is: lists, code, paths, how many sentences. */
function replyShape(reply) {
  const t = String(reply || "");
  const list = /^\s*(?:[-*+]|\d+\.)\s+/m.test(t);
  const code = /```|`[^`\n]+`/.test(t);
  const paths = /(?:^|\s)\/[\w.-]+\/|https?:\/\//.test(t);
  const markup = /\*\*|^#+\s/m.test(t);
  return { chars: t.length, sentences: sentencesOf(t, true).length, list, code, paths, plain: !list && !code && !paths && !markup };
}

function scrub(text) {
  return String(text == null ? "" : text)
    .replace(/\bsk-[A-Za-z0-9_\-*.]{4,}/g, "sk-…")
    .replace(/(Bearer\s+)\S+/gi, "$1…")
    .slice(0, 300);
}

/* ------------------------------------------------ speaking, streamed -- */

/**
 * What kind of turn this was, for the usage figures: a request passed to MINT
 * AI (and, later, its summary) is a hand-off; an answer that read the snapshot
 * is a snapshot answer; anything else is small talk.
 */
function categoryOf(result) {
  const r = result || {};
  if (r.kind === "summary") return "handoff";
  if ((r.asked || []).length) return "handoff";
  if ((r.tools || []).includes("read_status")) return "snapshot";
  return "small_talk";
}

/**
 * Speak the desk's lines as they are released, streamed and in order.
 *
 * `speak(text, cfg, sink)` is voice.speakStream. Each line's reading starts
 * the moment the line is pushed (the reader runs a few at a time), and every
 * event of it goes to `write` as NDJSON-ready objects:
 *
 *   {type:"line", i, text, safe}   at once, in order: the page queues it
 *   {type:"start", i, engine}      a reading of line i begins
 *   {type:"audio", i, pcm}         PCM16 mono 24 kHz, base64, as it arrives
 *   {type:"cut", i, why}           drop what was sent of line i since its
 *                                  last start: that reading failed the check
 *   {type:"end", i, engine|skipped}  line i is complete (or was not spoken)
 *
 * The start/audio/cut/end of line i+1 are held here until line i has ended,
 * so the wire carries each sentence whole and in order -- and a sentence
 * that is read faster than the one before it waits its turn.
 */
function createSpeaker({ speak, cfg, write, t0 }) {
  const slots = [];
  let head = 0;
  let firstAudio = null;
  const billing = [];
  const late = [];
  const spoken = [];
  const out = (ev) => {
    if (ev.type === "audio" && firstAudio === null) firstAudio = Date.now() - (t0 || Date.now());
    write(ev);
  };
  const emit = (i, ev) => {
    if (i === head) out(ev);
    else slots[i].buf.push(ev);
  };
  const advance = () => {
    while (head < slots.length && slots[head].done) {
      head++;
      if (head < slots.length) slots[head].buf.splice(0).forEach(out);
    }
  };
  return {
    push(line) {
      const i = slots.length;
      const sl = { buf: [], done: false, bytes: 0 };
      slots.push(sl);
      write({ type: "line", i, text: line.text, safe: !!line.safe });
      const sink = {
        start: ({ engine }) => {
          sl.bytes = 0;
          emit(i, { type: "start", i, engine });
        },
        audio: (b) => {
          sl.bytes += b.length;
          emit(i, { type: "audio", i, pcm: b.toString("base64") });
        },
        cut: ({ why }) => {
          sl.bytes = 0;
          emit(i, { type: "cut", i, why });
        },
      };
      sl.promise = Promise.resolve()
        .then(() => speak(line.text, cfg, sink))
        .then(
          (res) => {
            billing.push(...(res.billing || []));
            if (res.lateBilling) late.push(res.lateBilling);
            emit(i, { type: "end", i, engine: res.cached ? "cache" : res.engine, fallback: !!res.fallback });
            spoken.push({ text: line.text, safe: !!line.safe, audio_s: Math.round((sl.bytes / (RATE * 2)) * 100) / 100 });
          },
          (err) => {
            if (err && err.billing) billing.push(...err.billing);
            if (err && err.lateBilling) late.push(err.lateBilling);
            emit(i, { type: "end", i, skipped: (err && err.code) || "error" });
            spoken.push({ text: line.text, safe: !!line.safe, audio_s: 0, skipped: true });
          }
        )
        .then(() => {
          sl.done = true;
          if (i === head) advance();
        });
    },
    /** Every line spoken (or skipped): {firstAudio, billing, lateBilling, spoken}. */
    async done() {
      let n = -1;
      while (n !== slots.length) {
        n = slots.length;
        await Promise.all(slots.map((s) => s.promise));
      }
      return { firstAudio, billing, lateBilling: Promise.all(late).then((xs) => xs.flat()), spoken };
    },
  };
}

/* ------------------------------------------- one desk per panel user -- */

const desks = new Map(); // actor -> DeskSession

/**
 * The desk for this panel user, opened on first use and reused while fresh.
 * `call` is moniai.call; the desk only ever reaches it through deskOps(). A
 * conversation that has grown past MAX_TURNS_PER_SESSION or
 * MAX_CONTEXT_TOKENS is replaced by a fresh one; unanswered requests carry over.
 */
function deskFor(actor, cfg, call, opts) {
  const o = opts || {};
  const id = String(actor) + "|" + String(cfg.key).slice(-6) + "|" + (cfg.voice || "");
  let d = desks.get(actor);
  let carry = null;
  if (d && (!d.usable() || d.cfgId !== id || Date.now() - d.usedAt > IDLE_MS || (d.full() && !d.inflight))) {
    if (d.cfgId === id) carry = [...d.requests.entries()].filter(([, r]) => !r.answered);
    d.close();
    d = null;
  }
  if (!d) {
    d = new DeskSession({ key: cfg.key, voice: cfg.voice, model: cfg.desk_model || DESK_MODEL, ops: deskOps(call, actor), wsBase: cfg.wsBase, log: o.log });
    d.cfgId = id;
    if (carry) for (const [k, v] of carry) d.requests.set(k, v);
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
  SUMMARY_INSTRUCTIONS,
  summaryLanguage,
  replyLanguage,
  instructionsFor,
  DESK_OPS,
  DESK_MODEL,
  SAFE_LINE,
  SAFE_LINE_ASKED,
  SAFE_LINE_TAIL,
  APPROVAL_LINE,
  APPROVAL_LINE_SHORT,
  DETAILS_LINE,
  SUMMARY_CUT_LINE,
  SUMMARY_NONE_LINE,
  FORBIDDEN_KEYS,
  PRICES,
  MAX_TURNS_PER_SESSION,
  MAX_CONTEXT_TOKENS,
  VERBATIM_MAX_CHARS,
  DeskSession,
  DeskError,
  Releaser,
  deskOps,
  deskFor,
  closeAll,
  forModel,
  guard,
  judge,
  sentencesOf,
  needsNext,
  replyShape,
  replyModel,
  strictNumberSet,
  polarClaims,
  unbackedHandoff,
  mentionsHandoff,
  HANDOFF_PASSIVE_AR,
  numbersIn,
  numberSet,
  settled,
  linesFor,
  langOf,
  LINES_AR,
  LINES_AR_F,
  LINES_AR_M,
  LINES_EN,
  UNREACHABLE_LINE,
  tokensOf,
  addTokens,
  costOf,
  categoryOf,
  createSpeaker,
  RATE,
};
