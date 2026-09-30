/*
 * What MINT AI's voice may do on the Command Center screen (UI control,
 * Phase 1: the desk's ui_action tool). One allowlist, required by the server
 * (lib/voice-live.js, lib/voice-desk.js) and loaded by the page (moni-ai.js),
 * so both sides refuse the same things. Pure: no DOM, no state.
 *
 * Tier 1 only -- harmless, instant, shown with a toast (and an undo where
 * sensible). Nothing here can approve or deny anything, touch keys, users,
 * rules, the gate, settings values, restarts or deploys: those have no action
 * name at all, so nothing can reach them whatever the model is told. A card
 * can be SHOWN (decision.show); pressing Approve stays a human click. The
 * microphone can be muted by voice but never unmuted (a hijacked turn must
 * not turn a muted microphone back on).
 *
 *   UiActions.validate(name, args) -> { ok: true, action, args } | { ok: false, why }
 *   UiActions.toast(action, args)  -> "Mint opened Missions"
 *   UiActions.tool()               -> the realtime tool definition (ui_action)
 *   UiActions.limiter()            -> per-turn / per-minute rate limits
 *
 * Where an action runs: "server" (the live call itself: end, mute, interrupt)
 * or "page" (the tab that holds the call, or that sent the relay-desk turn).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.UiActions = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // The dock's sheets (public/cc-logic.js SHEETS), plus the phone's Everything grid.
  var SHEETS = {
    conv: "Conversation", sessions: "Sessions", missions: "Missions", dec: "Decisions",
    tl: "Timeline", rules: "Rules & watchers", orders: "Standing orders", cost: "Usage",
    machine: "Machine", everything: "Everything",
  };
  // The words people use for each panel (English and Egyptian Arabic), for the tool's description.
  var PANEL_WORDS = [
    "conv = the chat panel (الشات)",
    "sessions (الجلسات، السيشنز)",
    "missions (المهام، الميشنز)",
    "dec = decisions / approvals (القرارات، الموافقات)",
    "tl = timeline / activity (التايم لاين، السجل)",
    "rules = rules & watchers (القواعد، الووتشرز)",
    "orders = standing orders (الأوامر الدائمة، الأوردرز)",
    "cost = cost & voice usage (التكلفة، المصاريف)",
    "machine = the machine / server (الماشين، السيرفر)",
    "everything (كل حاجة)",
  ].join("; ");
  var CORES = { A: "A", B: "B", C: "C" };
  // Tier 2 (UI control Phase 3): preferences, applied only after a confirm the server checks.
  var THEMES = { system: "the system theme", dark: "the dark theme", light: "the light theme" };
  // lib/voice-persona.js PRESETS plus "learned" (tested to match).
  var PERSONAS = { cairene_f: "Cairene Egyptian, feminine", cairene_m: "Cairene Egyptian, masculine", msa_n: "Modern Standard Arabic, neutral", learned: "learned from how you speak" };
  // lib/voice.js VOICES (tested to match).
  var VOICE_NAMES = { marin: "marin", cedar: "cedar", alloy: "alloy", ash: "ash", ballad: "ballad", coral: "coral", echo: "echo", sage: "sage", shimmer: "shimmer", verse: "verse" };
  var MODES = { ptt: "push to talk", handsfree: "hands-free", live: "live conversation" };
  var VIEWS = { map: "the map", missions: "Missions" };
  // settings.open: a fixed list of pages, never a URL from the model.
  var PAGES = {
    voice: { url: "/credentials/openai-voice", label: "voice settings" },
    account: { url: "/account", label: "your account" },
    "voice-eval": { url: "/mint-ai/voice-eval", label: "the voice evaluation" },
  };

  // page.open (M-5): the pages MINT AI may take the administrator to -- a fixed
  // map, GET pages only (none has a real side effect), no parameters, no query
  // strings. perm: what the page needs (checked on the page before it moves;
  // null = anyone signed in). Nothing on a page is ever clicked for them.
  var NAV_PAGES = {
    "os-overview": { url: "/os", label: "the OS dashboard", perm: "os.view" },
    agents: { url: "/agents/dashboard", label: "the agents dashboard", perm: "agents.view" },
    "agents-fleet": { url: "/agents", label: "the Telegram agents", perm: "agents.view" },
    "agents-channels": { url: "/channels", label: "the channels", perm: "channels.view" },
    "agents-addons": { url: "/addons", label: "the add-ons", perm: "addons.view" },
    "agents-services": { url: "/services/agents", label: "the agent services", perm: "agents.view" },
    "os-services": { url: "/services", label: "the services", perm: "services.view" },
    "os-audit": { url: "/audit", label: "the audit log", perm: "audit.view" },
    "os-firewall": { url: "/firewall", label: "the firewall", perm: "firewall.view" },
    "manage-credentials": { url: "/credentials", label: "the credentials", perm: "credentials.view" },
    "manage-ssh-keys": { url: "/keys", label: "the SSH keys", perm: "keys.view" },
    "manage-devices": { url: "/devices", label: "your signed-in devices", perm: null },
    "manage-users": { url: "/users", label: "the users", perm: "users.view" },
    "manage-roles": { url: "/roles", label: "the roles", perm: "roles.view" },
    "claude-memory": { url: "/claude/memory", label: "Claude's memory", perm: "claude.memory.read" },
    "claude-sessions": { url: "/claude/sessions", label: "the Claude sessions", perm: "claude.sessions.view" },
    "claude-running": { url: "/claude/running", label: "the running sessions", perm: "claude.running.view" },
    guide: { url: "/guide", label: "the guide", perm: null },
    account: { url: "/account", label: "your account", perm: null },
    "voice-settings": { url: "/credentials/openai-voice", label: "the voice settings", perm: "voice.manage" },
    "command-center": { url: "/mint-ai", label: "the Command Center", perm: "moniai.use" },
  };

  function oneOf(map, key) {
    return function (a) {
      var v = a && a[key];
      return typeof v === "string" && Object.prototype.hasOwnProperty.call(map, v) ? (function () { var o = {}; o[key] = v; return o; })() : null;
    };
  }
  function none(a) {
    return a && typeof a === "object" && Object.keys(a).some(function (k) { return a[k] !== undefined && a[k] !== null && a[k] !== ""; }) ? null : {};
  }

  function optKey(a) {
    var x = a && typeof a === "object" ? a : {};
    var extra = Object.keys(x).some(function (k) { return k !== "key" && x[k] !== undefined && x[k] !== null && x[k] !== ""; });
    if (extra) return null;
    if (x.key === undefined || x.key === null || x.key === "") return {};
    return Object.prototype.hasOwnProperty.call(SHEETS, x.key) ? { key: x.key } : null;
  }

  var ACTIONS = {
    "call.end": { tier: 1, where: "server", once: true, args: none, toast: function () { return "Mint ended the call"; } },
    // Mute only: `on` must be true (or absent). Unmuting is by hand.
    "call.mute": {
      tier: 1, where: "server",
      args: function (a) { var on = a && a.on; return on === undefined || on === null || on === true || on === "true" ? { on: true } : null; },
      why: "the microphone can be muted by voice, never unmuted -- the administrator unmutes it by hand",
      toast: function () { return "Mint muted the microphone"; },
    },
    "call.interrupt": { tier: 1, where: "server", args: none, toast: function () { return "Mint stopped reading"; } },
    "voice.mode": { tier: 1, where: "page", args: oneOf(MODES, "mode"), toast: function (a) { return "Mint switched the voice to " + MODES[a.mode]; } },
    "sheet.open": { tier: 1, where: "page", args: oneOf(SHEETS, "key"), toast: function (a) { return "Mint opened " + SHEETS[a.key]; } },
    // key is optional: "close the missions" may name the panel it closes.
    "sheet.close": { tier: 1, where: "page", args: optKey, toast: function (a) { return a.key ? "Mint closed " + SHEETS[a.key] : "Mint closed the panel"; } },
    view: { tier: 1, where: "page", args: oneOf(VIEWS, "name"), toast: function (a) { return "Mint showed " + VIEWS[a.name]; } },
    "core.set": { tier: 1, where: "page", args: oneOf(CORES, "core"), toast: function (a) { return "Mint switched the core to " + a.core; } },
    "reply.show": { tier: 1, where: "page", args: none, toast: function () { return "Mint opened the last reply"; } },
    "reply.read": { tier: 1, where: "page", args: none, toast: function () { return "Mint is reading the last reply"; } },
    "decision.show": { tier: 1, where: "page", args: none, toast: function () { return "Mint showed the waiting card -- approving it is yours"; } },
    "settings.open": { tier: 1, where: "page", once: true, args: oneOf(PAGES, "page"), toast: function (a) { return "Mint suggests " + PAGES[a.page].label; } },
    // Takes the administrator to one page of the fixed map (M-5). Once a turn.
    "page.open": { tier: 1, where: "page", once: true, args: oneOf(NAV_PAGES, "page"), toast: function (a) { return "Mint opened " + NAV_PAGES[a.page].label; } },
    // Tier 2: the toast is the question; done() is what is shown once confirmed and applied.
    "theme.set": { tier: 2, where: "page", args: oneOf(THEMES, "theme"), toast: function (a) { return "Switch to " + THEMES[a.theme] + "?"; }, done: function (a) { return "Switched to " + THEMES[a.theme]; } },
    "persona.set": { tier: 2, where: "page", args: oneOf(PERSONAS, "preset"), toast: function (a) { return "Set the voice persona to " + PERSONAS[a.preset] + "?"; }, done: function (a) { return "Voice persona: " + PERSONAS[a.preset]; } },
    "voice.set": { tier: 2, where: "page", args: oneOf(VOICE_NAMES, "voice"), toast: function (a) { return "Switch the voice to " + a.voice + "? (for everyone; an open call reconnects with it)"; }, done: function (a) { return "The voice is now " + a.voice; } },
  };

  function names() { return Object.keys(ACTIONS); }

  /** Is this a known action with good arguments? Unknown names are refused, whatever they are. */
  function validate(name, args) {
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(ACTIONS, name)) return { ok: false, why: "no such screen action (allowed: " + names().join(", ") + ")" };
    var a = ACTIONS[name];
    var clean = a.args(args && typeof args === "object" && !Array.isArray(args) ? args : {});
    if (!clean) return { ok: false, why: a.why || "bad arguments for " + name };
    return { ok: true, action: name, args: clean, where: a.where, tier: a.tier, once: !!a.once };
  }

  /** Tier 2: the line shown once the change is confirmed and applied. */
  function doneText(name, args) {
    var a = ACTIONS[name];
    return a && a.done ? a.done(args || {}) : toast(name, args);
  }

  function toast(name, args) {
    var a = ACTIONS[name];
    return a ? a.toast(args || {}) : "";
  }

  function pageUrl(page) {
    return PAGES[page] ? PAGES[page].url : null;
  }
  /** page.open: { url, label, perm } for a key of the fixed map, or null. */
  function navPage(key) {
    return Object.prototype.hasOwnProperty.call(NAV_PAGES, key) ? NAV_PAGES[key] : null;
  }
  /** The page.open keys a viewer may use, given can(perm). */
  function navKeysFor(can) {
    return Object.keys(NAV_PAGES).filter(function (k) { var p = NAV_PAGES[k].perm; return !p || !!can(p); });
  }

  /**
   * The realtime tool. Flat, optional arguments so the model can fill them
   * without nesting: action, and key / mode / name / core / page as the
   * action needs.
   */
  function tool() {
    return {
      type: "function",
      name: "ui_action",
      description:
        "Change what the administrator sees on this Command Center screen, at once: end or mute this call (never unmute), stop reading, " +
        "switch the voice mode, open or close a panel (" + Object.keys(SHEETS).join(", ") + "), show the map or missions, switch the core (A/B/C), " +
        "show or read the last reply, show the waiting decision card, or suggest a settings page (voice, account, voice-eval). " +
        "page.open takes the administrator to another page of Mint OS (page = one of: " + Object.keys(NAV_PAGES).join(", ") + "): " +
        "\"open the OS dashboard\" / «افتحلي الـ OS dashboard» -> os-overview; \"the agents dashboard\" -> agents; \"the Telegram agents\" -> agents-fleet; \"users\" -> manage-users; " +
        "\"back to the Command Center\" -> command-center. It only opens the page (nothing on it is clicked), is refused when their role cannot see that page, and is once a turn. " +
        "Panel names as the administrator may say them: " + PANEL_WORDS + ". " +
        "\"Close the missions\", \"hide the decisions\", «اقفلي المهام», «اقفل الميشنز», «شيل القرارات» close that PANEL (sheet.close), never the call: " +
        "call.end only when they name the call or the conversation (\"end the call\", «اقفل المكالمة»). " +
        "Three preferences need the administrator's own confirmation: theme.set (system/dark/light -- \"dark mode\", «دارك», «الوضع الليلي»), " +
        "persona.set (the Arabic voice persona: cairene_f = Egyptian woman «مصرية بنت», cairene_m = Egyptian man «مصري ولد», msa_n = formal Arabic «فصحى», learned = learn from how I speak) and voice.set " +
        "(the voice's sound, for everyone; after the confirm any open live call reconnects in the new voice by itself). For those the result is status \"confirm\": nothing has changed yet -- say only that you are waiting for their confirmation (\"Waiting for your confirmation.\"); never tell them to say yes. " +
        "Never say it is done until they have confirmed, and never confirm for them. " +
        "It cannot approve, deny or confirm anything, change keys, users, rules, other settings, restart or deploy: approving stays the administrator's click. " +
        "Use it only when the administrator asks for it in this turn.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: names() },
          key: { type: "string", enum: Object.keys(SHEETS), description: "sheet.open: which panel; sheet.close: optional, the panel named" },
          mode: { type: "string", enum: Object.keys(MODES), description: "voice.mode" },
          name: { type: "string", enum: Object.keys(VIEWS), description: "view" },
          core: { type: "string", enum: Object.keys(CORES), description: "core.set" },
          page: { type: "string", enum: Object.keys(PAGES).concat(Object.keys(NAV_PAGES).filter(function (k) { return !PAGES[k]; })), description: "settings.open: voice, account or voice-eval; page.open: a page key from the list" },
          theme: { type: "string", enum: Object.keys(THEMES), description: "theme.set (needs confirm)" },
          preset: { type: "string", enum: Object.keys(PERSONAS), description: "persona.set (needs confirm)" },
          voice: { type: "string", enum: Object.keys(VOICE_NAMES), description: "voice.set (needs confirm; an open call reconnects with it)" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    };
  }

  var ARG_KEYS = ["key", "mode", "name", "core", "page", "on", "theme", "preset", "voice"];

  /*
   * MINT AI's MCP tools (bin/moni-ai-mcp). A resumed claude CLI keeps the
   * schema it first loaded for a tool (its deferred_tools_record), so the MCP
   * tool's schema must never change when an action or a page is added: `ui_do`
   * takes `action` as a plain string and every argument as a plain field
   * (ARG_KEYS, a fixed superset), and validation stays where it is (validate(),
   * on the supervisor and again on the page). What exists right now is read at
   * run time from `ui_actions_list` (catalog() below).
   */
  var WHAT = {
    "call.end": "end the administrator's live voice call",
    "call.mute": "mute their microphone in the live call (never unmute)",
    "call.interrupt": "stop reading aloud",
    "voice.mode": "switch the voice mode",
    "sheet.open": "open a Command Center panel",
    "sheet.close": "close the open panel (or the panel named, if it is the one open)",
    view: "show the map or the missions",
    "core.set": "switch the Command Center core",
    "reply.show": "open your last reply in full",
    "reply.read": "read your last reply aloud",
    "decision.show": "show the waiting decision card (approving it stays theirs)",
    "settings.open": "suggest a settings page (a toast with a link; nothing opens by itself)",
    "page.open": "take the administrator to another page of Mint OS (only the page opens; refused when their role cannot see it)",
    "theme.set": "ask to switch the theme (they confirm)",
    "persona.set": "ask to set the Arabic voice persona (they confirm)",
    "voice.set": "ask to switch the voice's sound, for everyone (they confirm; an open call reconnects in it)",
  };
  function labels(map, f) { var o = {}; Object.keys(map).forEach(function (k) { o[k] = f ? f(map[k], k) : map[k]; }); return o; }
  var ARG_SPEC = {
    "call.mute": { on: { required: false, values: { "true": "mute (the only value)" } } },
    "voice.mode": { mode: { required: true, values: MODES } },
    "sheet.open": { key: { required: true, values: SHEETS } },
    "sheet.close": { key: { required: false, values: SHEETS } },
    view: { name: { required: true, values: VIEWS } },
    "core.set": { core: { required: true, values: CORES } },
    "settings.open": { page: { required: true, values: labels(PAGES, function (p) { return p.label; }) } },
    "page.open": { page: { required: true, values: labels(NAV_PAGES, function (p) { return p.label + (p.perm ? " (needs " + p.perm + ")" : ""); }) } },
    "theme.set": { theme: { required: true, values: THEMES } },
    "persona.set": { preset: { required: true, values: PERSONAS } },
    "voice.set": { voice: { required: true, values: VOICE_NAMES } },
  };
  /** ui_actions_list: the live allowlist -- actions, tiers, arguments and values, which need a confirm. */
  function catalog() {
    return {
      call_with: "ui_do, with action and its arguments as plain fields, e.g. {\"action\": \"page.open\", \"page\": \"os-audit\"}",
      rules: [
        "Only while you answer a request the administrator sent from the Command Center or the MINT AI dock, and only when they asked for it in that request.",
        "It acts on the tab they asked from. It never approves, denies or confirms anything, and never changes keys, users, rules or other settings.",
        "Tier 2 (needs_confirm): the result is status confirm -- nothing has changed yet; say only that you are waiting for their confirmation (never tell them to say yes); never confirm for them.",
        "The result is ok, refused (with why), confirm or no-screen; say what really happened.",
        "At most 6 a request and 20 a minute; an action marked once works once a request.",
      ],
      actions: names().map(function (n) {
        var a = ACTIONS[n];
        return { action: n, what: WHAT[n] || "", tier: a.tier, needs_confirm: a.tier === 2, once_per_request: !!a.once, args: ARG_SPEC[n] || {} };
      }),
    };
  }
  /** ui_do's input schema: fixed forever (a snapshot test holds it). */
  function stableSchema() {
    var p = { action: { type: "string", description: "An action name from ui_actions_list." } };
    ARG_KEYS.forEach(function (k) { p[k] = k === "on" ? { type: "boolean", description: "call.mute only: true (muting; never unmuting)" } : { type: "string", description: "As ui_actions_list gives for the action." }; });
    return { type: "object", properties: p, required: ["action"], additionalProperties: false };
  }
  /** The tool's flat arguments split into action and args. */
  function fromTool(args) {
    var a = args && typeof args === "object" ? args : {};
    var out = {};
    ARG_KEYS.forEach(function (k) { if (a[k] !== undefined) out[k] = a[k]; });
    var extra = Object.keys(a).filter(function (k) { return k !== "action" && ARG_KEYS.indexOf(k) < 0; });
    return { action: a.action, args: out, extra: extra };
  }

  /**
   * Rate limits: at most `perTurn` actions per turn and `perMinute` per
   * minute, and a `once` action (call.end, settings.open) once per turn.
   */
  function limiter(opts) {
    var o = opts || {};
    var perTurn = o.perTurn || 6, perMinute = o.perMinute || 20;
    var times = [];
    var turns = {};
    return {
      take: function (turnKey, action, now) {
        var t = now || Date.now();
        times = times.filter(function (x) { return t - x < 60000; });
        var k = String(turnKey || "");
        var tu = turns[k] || (turns[k] = { n: 0, once: {} });
        if (times.length >= perMinute) return "too many screen actions this minute";
        if (tu.n >= perTurn) return "too many screen actions in one turn";
        if (ACTIONS[action] && ACTIONS[action].once && tu.once[action]) return action + " was already done in this turn";
        times.push(t);
        tu.n++;
        tu.once[action] = true;
        var keys = Object.keys(turns);
        if (keys.length > 50) delete turns[keys[0]];
        return null;
      },
    };
  }

  // What a claim of a screen action sounds like: "I opened Missions", «فتحتلك الـ missions».
  // (The desk's guard allows it only when a ui_action in this turn returned ok.)
  var CLAIM_EN = /\b(?:i|i've|ive|i have|i just|i've just)\s+(?:just\s+|now\s+)?(?:opened|closed|muted|ended|switched|showed|shown|brought up|pulled up|put up|hung up|interrupted|stopped reading|set|changed|turned)\b/;
  var CLAIM_AR = /(?:^|[^ء-ي])[وف]?(?:فتحت|فتحتلك|فتحتهالك|ا?قفلت|ا?قفلتلك|قفلتهالك|كتمت|نهيت|انهيت|غيرت|غيرتلك|حولت|حولتلك|عرضت|عرضتلك|طلعتلك|وقفت\s+القرايه|سكرت)(?:[ء-ي]*)/;
  function claims(normText) {
    // Diacritics, tatweel and alef forms out, so «قفّلت» and «أقفلت» read as written plainly.
    var t = String(normText || "").replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627");
    return CLAIM_EN.test(t) || CLAIM_AR.test(t);
  }

  return {
    ACTIONS: ACTIONS, SHEETS: SHEETS, CORES: CORES, MODES: MODES, VIEWS: VIEWS, PAGES: PAGES, THEMES: THEMES, PERSONAS: PERSONAS, VOICE_NAMES: VOICE_NAMES, ARG_KEYS: ARG_KEYS,
    names: names, validate: validate, toast: toast, doneText: doneText, navPage: navPage, navKeysFor: navKeysFor, NAV_PAGES: NAV_PAGES, pageUrl: pageUrl, tool: tool, fromTool: fromTool, catalog: catalog, stableSchema: stableSchema, limiter: limiter, claims: claims,
  };
});
