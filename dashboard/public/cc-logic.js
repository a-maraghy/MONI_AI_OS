"use strict";
/*
 * The Command Center's pure logic, shared by the page and the tests.
 *
 * No DOM, no fetch: every function takes plain data and returns plain data, so
 * node can require this file (tools/test-cc-logic.cjs) and the page loads the
 * same text as window.MintLogic. What lives here:
 *
 *   - the MINT AI core setting: the three concepts and the default (C);
 *   - coreState / caption: what the core shows and what the one-line caption
 *     under it says, from what is really happening (the turn and its current
 *     step, a delegation and its target, the sentence being spoken, the
 *     microphone, anything waiting for you);
 *   - the decision card: which items need you, in what order, and which
 *     buttons each one gets -- every button names the existing API it calls;
 *   - the dock: the sheets behind the left icon bar, in order.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MintLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  /* ------------------------------------------------------------ the core */

  var CORES = { A: "Dotted sphere", B: "Siri fluid", C: "Hybrid" };
  var CORE_DEFAULT = "C";
  /** A saved or requested core, as one of A / B / C; anything else is the default. */
  function normCore(c) {
    c = String(c == null ? "" : c).trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(CORES, c) ? c : CORE_DEFAULT;
  }
  /** Whether a request names a core at all (the API refuses anything else). */
  function isCore(c) {
    return typeof c === "string" && Object.prototype.hasOwnProperty.call(CORES, c);
  }

  /* The sessions view round the core: the family of spheres (the default) or the classic orbit of dots. */
  var SESS_VIEWS = { spheres: "Spheres", orbit: "Classic orbit" };
  var SESS_VIEW_DEFAULT = "spheres";
  function normSessView(v) {
    v = String(v == null ? "" : v).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(SESS_VIEWS, v) ? v : SESS_VIEW_DEFAULT;
  }
  function isSessView(v) { return typeof v === "string" && Object.prototype.hasOwnProperty.call(SESS_VIEWS, v); }

  var STATES = ["idle", "listening", "thinking", "delegating", "speaking", "needs"];
  var LABEL = { idle: "Ready", listening: "Listening", thinking: "Thinking", delegating: "Delegating", speaking: "Speaking", needs: "Needs you" };

  function lcFirst(s) {
    s = String(s || "");
    return s.charAt(0).toLowerCase() + s.slice(1);
  }
  function oneLine(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    n = n || 180;
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function endStop(s) {
    s = String(s || "").trim();
    return !s || /[.!?…:]$/.test(s) ? s : s + ".";
  }

  /**
   * The core's state from a snapshot of the page:
   *   { online, listening, speaking, voiceLive, delegatingTo, busy, pending }
   * Order: the microphone and the voice first (they are you, now), then
   * anything waiting for you, then a delegation just sent, then a running turn.
   */
  function coreState(s) {
    s = s || {};
    if (!s.online) return "idle";
    if (s.listening && !s.speaking) return "listening";
    if (s.speaking) return "speaking";
    if (s.pending > 0) return "needs";
    if (s.delegatingTo) return "delegating";
    if (s.busy || s.voiceLive) return "thinking";
    return "idle";
  }

  /**
   * The caption under the core: { state, label, text, interim, words }.
   *   words   true: the text is a sentence being spoken, revealed word by word
   *   interim true: what the microphone is hearing, not yet sent
   * Snapshot fields beyond coreState's:
   *   voiceText   the voice bar's line (what was heard, "Listening…", "Transcribing…")
   *   spoken      the sentence playing now
   *   stepText    the running turn's current step, in words
   *   streamText  the reply as it streams (its latest sentence is shown)
   *   delegation  the text or summary of the delegation just sent
   *   needTitle   the first thing waiting for you
   *   queued      turns waiting behind the running one
   *   lastReply   the gist of MINT AI's last answer
   *   offlineMsg  why the supervisor is unreachable
   */
  function caption(s) {
    s = s || {};
    var st = coreState(s);
    var out = { state: st, label: LABEL[st], text: "", interim: false, words: false };
    if (!s.online) {
      out.label = "Offline";
      out.text = oneLine(s.offlineMsg || "MINT AI is not reachable right now.");
      return out;
    }
    if (st === "listening") {
      out.interim = true;
      out.text = oneLine(s.voiceText || "Listening…");
      return out;
    }
    if (st === "speaking") {
      out.words = true;
      out.text = oneLine(s.spoken || "…", 260);
      return out;
    }
    if (st === "needs") {
      var more = s.pending > 1 ? " (" + (s.pending - 1) + " more)" : "";
      out.text = s.needTitle ? "Waiting for you: " + endStop(lcFirst(oneLine(s.needTitle, 140))).replace(/\.$/, "") + more + "." : "Waiting for your decision.";
      return out;
    }
    if (st === "delegating") {
      out.label = "Delegating → " + oneLine(s.delegatingTo, 40);
      out.text = s.delegation ? oneLine(s.delegation, 200) : "Handing it to " + oneLine(s.delegatingTo, 60) + "…";
      return out;
    }
    if (st === "thinking") {
      if (s.voiceLive && !s.busy) {
        out.label = "Heard";
        out.text = oneLine(s.voiceText || "Transcribing…");
        out.interim = true;
        return out;
      }
      if (s.waitingOn) out.label = "Waiting on " + oneLine(s.waitingOn, 40);
      var line = lastSentence(s.streamText);
      out.text = line ? oneLine(line, 220) : s.stepText ? endStop(oneLine(s.stepText, 200)).replace(/\.$/, "…") : "Thinking it through…";
      if (s.queued > 0) out.label += " · " + s.queued + " queued";
      return out;
    }
    out.text = s.lastReply ? oneLine(s.lastReply, 220) : "Ready when you are.";
    return out;
  }

  /*
   * The last reply rests after a quiet spell: with nothing happening for
   * CAPTION_REST_MS the caption's reply line fades and only "See last reply"
   * stays. Never while MINT AI thinks, speaks, listens, delegates or waits on
   * you (any state but idle), while you type, while a voice call is on, while the
   * full reply is open, or when there is no reply to rest. `quietSince` is the
   * last activity (the page bumps it on each of those and on a new caption).
   */
  var CAPTION_REST_MS = 15000;
  function captionRests(o) {
    o = o || {};
    if (o.state !== "idle" || !o.hasReply || o.typing || o.voice || o.replyOpen || !o.online) return false;
    return (o.now || 0) - (o.quietSince || 0) >= CAPTION_REST_MS;
  }
  /**
   * The composer rests translucent when nothing is going on: online, MINT AI
   * idle, no text in it, no voice turn or live call. Hover and focus lift it in
   * CSS; anything else here lifts it too.
   */
  function composerCalm(o) {
    o = o || {};
    return !!o.online && o.state === "idle" && !o.text && !o.voice && !o.live;
  }
  /** When to look again (ms from now), or null when nothing is counting down. */
  function captionRestIn(o) {
    o = o || {};
    if (o.state !== "idle" || !o.hasReply || o.typing || o.voice || o.replyOpen || !o.online) return null;
    return Math.max(0, CAPTION_REST_MS - ((o.now || 0) - (o.quietSince || 0)));
  }

  /** The last whole sentence of a streaming reply (or its tail, if none is whole yet). */
  function lastSentence(text) {
    var t = String(text || "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/[`*_#>|]/g, "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    var parts = t.match(/[^.!?]+[.!?]+(?=\s|$)/g);
    if (parts && parts.length) return parts[parts.length - 1].trim();
    return t.length > 160 ? "…" + t.slice(-159) : t;
  }

  /** The gist of a reply for the idle caption: its first sentence, as plain text. */
  function gist(text) {
    var t = String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*[#>*+-]+\s*/gm, "").replace(/[*_~|]/g, "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    var m = /^.{12,}?[.!?](?=\s|$)/.exec(t);
    return oneLine(m ? m[0] : t, 200);
  }

  /* ------------------------------------------------- the decision card */

  var DEC_NEED = { investigating: 1, proposed: 1, open: 1 };

  /** Everything waiting for you, oldest approval first, then the freshest findings. */
  function needQueue(approvals, decisions) {
    var aps = (approvals || []).filter(function (a) { return a && a.status === "pending"; })
      .sort(function (a, b) { return a.id - b.id; })
      .map(function (a) { return { type: "approval", id: a.id, key: "a" + a.id, item: a }; });
    var ds = (decisions || []).filter(function (d) { return d && DEC_NEED[d.status]; })
      .sort(function (a, b) { return String(b.last_seen || b.updated_at || "").localeCompare(String(a.last_seen || a.updated_at || "")); })
      .map(function (d) { return { type: "decision", id: d.id, key: "d" + d.id, item: d }; });
    return aps.concat(ds);
  }

  /* ---- token counts, as the Usage sheet shows them (cc-panels.js tokens(), TOK_KEYS) ---- */
  var TOK_KEYS = [["input", "Input"], ["output", "Output"], ["cache_read", "Cache read"], ["cache_write", "Cache write"]];
  /** Tokens as people read them: 812, 44k, 3.1M. */
  function tokens(n) {
    if (n == null || !isFinite(n)) return "—";
    n = Number(n);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(Math.round(n));
  }
  function fullNum(n) { return Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  /** "1.2M tok" (+ suffix) from {input, output, cache_read, cache_write, total}; "" when there is nothing. */
  function tokLine(t, suffix) {
    if (!t || t.total == null) return "";
    return tokens(t.total) + " tok" + (suffix ? " " + suffix : "");
  }
  /** The tooltip: the split, in full numbers. */
  function tokTip(t, note) {
    if (!t) return "";
    return TOK_KEYS.map(function (k) { return k[1] + " " + fullNum(t[k[0]]); }).join(" · ") + " · Total " + fullNum(t.total) + " (" + (note || "counted on this box from the transcripts") + ")";
  }

  /** Who asks: MINT AI, or a session it hired (M-6: origin "session:<slug>"). */
  function approvalFrom(a) {
    return a && /^session:/.test(String(a.origin || "")) ? String(a.origin_name || a.origin.slice(8)) : "MINT AI";
  }
  /** A card that must never grow an always-allow rule: a hired session's question, or a retire. */
  function approvalNoRule(a) {
    return !!a && (a.tool === "SessionRetire" || /^session:/.test(String(a.origin || "")));
  }
  function approvalWhat(a) {
    var inp = a.input || {};
    if (a.tool === "SessionRetire") return { title: "Retire the session " + String(inp.session || inp.name || "?"), cmd: "Ends it gracefully; its transcript is kept" };
    if (a.tool === "SendMessage") return { title: "Send a message to " + String(inp.to || "a session").replace(/\s*\[[0-9a-f]+\]$/, ""), cmd: String(inp.message || a.summary || "") };
    if (typeof inp.command === "string") return { title: a.label ? String(a.label) : "Run a command", cmd: inp.command };
    return { title: "Use " + (a.tool || "a tool"), cmd: String(a.summary || a.tool || "") };
  }

  /**
   * The card for one queue item: { kind, icon, title, meta, why, actions }.
   * Each action is { act, label, primary?, path?, body?, local? }: `path` is the
   * existing /mint-ai/api/ route it posts to; `local` ones never leave the page
   * (Later hides the card, Always allow opens its rule dialog).
   */
  function card(q) {
    if (!q) return null;
    var id = encodeURIComponent(String(q.id));
    var later = { act: "later", label: "Later", local: true };
    if (q.type === "approval") {
      var a = q.item, w = approvalWhat(a), from = approvalFrom(a);
      if (a.tool === "SessionRetire") {
        // MINT AI asks to retire a session it hired: the Keep / Retire consent (M-6).
        return {
          kind: "Retire", icon: "stop", title: w.title, meta: "Asked by MINT AI · " + w.cmd,
          why: oneLine(a.reason || "Nothing ends unless you choose Retire.", 280),
          expires: a.expires_at || null, created: a.created_at || null,
          actions: [
            { act: "approve", label: "Retire", primary: true, path: "approvals/" + id + "/approve", body: {} },
            { act: "deny", label: "Keep", path: "approvals/" + id + "/deny", body: {} },
            later,
          ],
        };
      }
      var acts = [
        { act: "approve", label: "Approve", primary: true, path: "approvals/" + id + "/approve", body: {} },
        { act: "deny", label: "Deny", path: "approvals/" + id + "/deny", body: {} },
      ];
      if (!approvalNoRule(a)) acts.push({ act: "always", label: "Always allow…", local: true, link: true });
      acts.push(later);
      return {
        kind: "Approval", icon: "shield", title: w.title,
        meta: (from !== "MINT AI" ? "From " + from + " (hired) · " : "") + oneLine(w.cmd, 160) + (a.mission_ref ? " · " + a.mission_ref + (a.step_n ? " step " + a.step_n : "") : ""),
        why: oneLine(a.reason || (a.category ? String(a.category).replace(/_/g, " ") + (a.label && a.label !== a.category ? " — " + a.label : "") : "A step the gate treats as destructive. Nothing runs until you choose."), 280),
        expires: a.expires_at || null, created: a.created_at || null,
        actions: acts,
      };
    }
    var d = q.item;
    var retire = d.kind === "retire";
    var meta = [d.kind === "watcher" ? "watcher" + (d.watcher ? " · " + String(d.watcher).replace(/_/g, " ") : "") : d.kind || "decision"];
    if (d.subject) meta.push(oneLine(d.subject, 50));
    if (d.count > 1) meta.push("×" + d.count);
    if (d.fix_command) meta.push("$ " + oneLine(d.fix_command, 80));
    var why = d.proposal || d.detail || (d.status === "investigating" ? "MINT AI is investigating…" : "");
    var out = { kind: retire ? "Retire" : d.kind === "watcher" ? "Watcher" : "Decision", icon: retire ? "stop" : "alert", title: oneLine(d.title || "A decision", 140), meta: meta.join(" · "), why: oneLine(why, 280), actions: [] };
    if (retire && (d.status === "proposed" || d.status === "open")) {
      out.actions = [
        { act: "approve", label: "Retire", primary: true, path: "decisions/" + id + "/approve", body: {} },
        { act: "dismiss", label: "Keep", path: "decisions/" + id + "/dismiss", body: {} },
        later,
      ];
    } else if (d.status === "proposed") {
      out.actions = [
        { act: "approve", label: "Apply fix", primary: true, path: "decisions/" + id + "/approve", body: {} },
        { act: "dismiss", label: "Dismiss", path: "decisions/" + id + "/dismiss", body: {} },
        later,
      ];
    } else if (d.status === "open") {
      out.actions = [
        { act: "investigate", label: "Investigate", primary: true, path: "decisions/" + id + "/ask", body: { text: "Investigate this and propose a fix." } },
        { act: "dismiss", label: "Dismiss", path: "decisions/" + id + "/dismiss", body: {} },
        later,
      ];
    } else {
      out.actions = [{ act: "dismiss", label: "Dismiss", path: "decisions/" + id + "/dismiss", body: {} }, later];
    }
    return out;
  }

  /** What the card says once a choice went through. */
  function doneText(act) {
    return { approve: "Approved", deny: "Denied", dismiss: "Dismissed", investigate: "Asked MINT AI to investigate" }[act] || "Done";
  }

  /* ------------------------------------------------------------ the dock */

  /** The sheets behind the left icon bar (and the phone's Everything grid), in order. */
  var SHEETS = [
    { key: "conv", icon: "message", label: "Conversation" },
    { key: "sessions", icon: "orbit", label: "Sessions" },
    { key: "missions", icon: "flag", label: "Missions" },
    { key: "dec", icon: "inbox", label: "Decisions" },
    "-",
    { key: "tl", icon: "clock", label: "Timeline" },
    { key: "rules", icon: "shield", label: "Rules & watchers" },
    { key: "orders", icon: "repeat", label: "Standing orders" },
    "-",
    { key: "cost", icon: "gauge", label: "Usage" },
    { key: "machine", icon: "server", label: "Machine" },
  ];
  function sheetKeys() {
    return SHEETS.filter(function (s) { return s !== "-"; }).map(function (s) { return s.key; });
  }

  /* ------------------------------------------------ who a delegation went to (the dot stream's target) */
  /** A session name as the supervisor compares them (moni-ai/lib/names.js norm): no [ref], lower case, spaces/dashes/underscores folded. */
  function normName(name) {
    return String(name == null ? "" : name).replace(/\s*\[[0-9a-f]{4,12}\]\s*$/i, "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  }
  /**
   * Names a session was known by: every session_id -> name pair seen (sessions events, delegation rows),
   * so an old name ("MONI Agent OS") still finds the session it belonged to.
   */
  function makeAliases() {
    var byName = {}; // normalised name -> { session_id: true }
    function add(name, sid) {
      var n = normName(name);
      if (!n || !sid) return;
      (byName[n] = byName[n] || {})[sid] = true;
    }
    return {
      learnSessions: function (list) { (list || []).forEach(function (s) { if (s && !s.self) add(s.name, s.session_id); }); },
      learnDelegation: function (d) { if (d) add(d.target_name || d.target, d.target_session); },
      /** The one session id this name was seen with, or null (unknown, or seen with several). */
      idFor: function (name) { var ids = Object.keys(byName[normName(name)] || {}); return ids.length === 1 ? ids[0] : null; },
    };
  }
  function only(list) { return list.length === 1 ? list[0] : null; }
  /**
   * The live session a delegation went to, by stable id first:
   *   target_session (= session_id), then target_pid, then a UNIQUE normalised name, then the alias table.
   * Returns { session, why }: why is "ambiguous" (namesakes), "gone" (known id, not live) or "unknown".
   */
  function resolveTarget(d, sessions, aliases) {
    var live = (sessions || []).filter(function (s) { return s && !s.self; });
    if (!d) return { session: null, why: "unknown" };
    if (d.target_session) {
      var a = only(live.filter(function (s) { return s.session_id === d.target_session; }));
      if (a) return { session: a, why: "session" };
    }
    if (d.target_pid) {
      var b = only(live.filter(function (s) { return s.pid === d.target_pid; }));
      if (b) return { session: b, why: "pid" };
    }
    var nm = normName(d.target_name || d.target);
    if (nm) {
      var byName = live.filter(function (s) { return normName(s.name) === nm; });
      if (byName.length === 1) return { session: byName[0], why: "name" };
      if (byName.length > 1) return { session: null, why: "ambiguous" };
      var sid = aliases && aliases.idFor(nm);
      if (sid) {
        var c = only(live.filter(function (s) { return s.session_id === sid; }));
        if (c) return { session: c, why: "alias" };
      }
    }
    return { session: null, why: d.target_session || d.target_pid ? "gone" : "unknown" };
  }
  /** The live session an inbound message came from: from_pid first, then a unique normalised name. */
  function resolveFrom(row, sessions) {
    var live = (sessions || []).filter(function (s) { return s && !s.self; });
    if (!row) return null;
    if (row.from_pid) { var a = only(live.filter(function (s) { return s.pid === row.from_pid; })); if (a) return a; }
    var nm = normName(row.from_name);
    return nm ? only(live.filter(function (s) { return normName(s.name) === nm; })) : null;
  }
  /** What the ghost marker says for a target with no sphere. */
  function ghostWhere(d, why) {
    var k = d && d.target_kind;
    if (k === "remote") return "Remote";
    if (k === "subagent" || /^a?[0-9a-f]{12,20}$/.test(String((d && (d.target_name || d.target)) || ""))) return "sub-agent";
    if (why === "ambiguous") return "more than one session has this name";
    return "offline";
  }

  return {
    CORES: CORES, CORE_DEFAULT: CORE_DEFAULT, normCore: normCore, isCore: isCore,
    SESS_VIEWS: SESS_VIEWS, SESS_VIEW_DEFAULT: SESS_VIEW_DEFAULT, normSessView: normSessView, isSessView: isSessView,
    STATES: STATES, LABEL: LABEL, coreState: coreState, caption: caption, CAPTION_REST_MS: CAPTION_REST_MS, captionRests: captionRests, captionRestIn: captionRestIn, composerCalm: composerCalm, lastSentence: lastSentence, gist: gist,
    needQueue: needQueue, card: card, doneText: doneText, approvalFrom: approvalFrom, approvalNoRule: approvalNoRule,
    TOK_KEYS: TOK_KEYS, tokens: tokens, tokLine: tokLine, tokTip: tokTip,
    SHEETS: SHEETS, sheetKeys: sheetKeys,
    normName: normName, makeAliases: makeAliases, resolveTarget: resolveTarget, resolveFrom: resolveFrom, ghostWhere: ghostWhere,
  };
});
