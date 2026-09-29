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

  function approvalWhat(a) {
    var inp = a.input || {};
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
      var a = q.item, w = approvalWhat(a);
      return {
        kind: "Approval", icon: "shield", title: w.title,
        meta: oneLine(w.cmd, 160) + (a.mission_ref ? " · " + a.mission_ref + (a.step_n ? " step " + a.step_n : "") : ""),
        why: oneLine(a.reason || (a.category ? String(a.category).replace(/_/g, " ") + (a.label && a.label !== a.category ? " — " + a.label : "") : "A step the gate treats as destructive. Nothing runs until you choose."), 280),
        expires: a.expires_at || null, created: a.created_at || null,
        actions: [
          { act: "approve", label: "Approve", primary: true, path: "approvals/" + id + "/approve", body: {} },
          { act: "deny", label: "Deny", path: "approvals/" + id + "/deny", body: {} },
          { act: "always", label: "Always allow…", local: true, link: true },
          later,
        ],
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
    { key: "cost", icon: "coin", label: "Cost & voice usage" },
    { key: "machine", icon: "server", label: "Machine" },
  ];
  function sheetKeys() {
    return SHEETS.filter(function (s) { return s !== "-"; }).map(function (s) { return s.key; });
  }

  return {
    CORES: CORES, CORE_DEFAULT: CORE_DEFAULT, normCore: normCore, isCore: isCore,
    SESS_VIEWS: SESS_VIEWS, SESS_VIEW_DEFAULT: SESS_VIEW_DEFAULT, normSessView: normSessView, isSessView: isSessView,
    STATES: STATES, LABEL: LABEL, coreState: coreState, caption: caption, lastSentence: lastSentence, gist: gist,
    needQueue: needQueue, card: card, doneText: doneText,
    SHEETS: SHEETS, sheetKeys: sheetKeys,
  };
});
