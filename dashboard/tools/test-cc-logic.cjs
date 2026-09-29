#!/usr/bin/env node
"use strict";
/**
 * The simplified Command Center's logic and wiring (public/cc-logic.js, the
 * page scripts, lib/views-moniai.js).
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-cc-logic.cjs
 *
 *   - caption / core state: what the core shows and the one line under it say,
 *     from real events (turn step, delegation target, the spoken sentence, the
 *     microphone, anything that needs you);
 *   - the decision card: which items, in what order, and each button -> the
 *     existing API route it calls;
 *   - the dock's sheets and the data each one is filled with;
 *   - "nothing lost": every API call, control, overlay, shortcut and voice path
 *     of the v3 page is still reachable in the new client code.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const L = require(path.join(ROOT, "public", "cc-logic.js"));
const views = require(path.join(ROOT, "lib", "views-moniai.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const main = read("public/moni-ai.js"), panels = read("public/cc-panels.js"), map = read("public/cc-map.js"), server = read("server.js");
const client = main + "\n" + panels + "\n" + map;

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 400) + ")" : ""));
}
function section(t) { console.log("\n" + t); }

/* ------------------------------------------------------ caption and state */
section("caption and core state, from events");
const base = { online: true, listening: false, speaking: false, voiceLive: false, busy: false, pending: 0, delegatingTo: "", lastReply: "" };
const cap = (o) => L.caption(Object.assign({}, base, o));

let c = cap({ lastReply: "Stale requests will be listed, not counted." });
check("idle: Ready, and the gist of the last reply", c.state === "idle" && c.label === "Ready" && c.text === "Stale requests will be listed, not counted.", JSON.stringify(c));
check("idle with nothing said yet", cap({}).text === "Ready when you are.");
c = cap({ online: false, offlineMsg: "MINT AI's supervisor is not running" });
check("offline: says so, and why", c.label === "Offline" && /supervisor is not running/.test(c.text) && c.state === "idle");
c = cap({ busy: true, stepText: "Reading the live server summary" });
check("a running turn: Thinking, with its current step", c.state === "thinking" && c.label === "Thinking" && c.text === "Reading the live server summary…", JSON.stringify(c));
c = cap({ busy: true, streamText: "Looking now. The plan is recomputed: 91 tonnes to buy. Open requests cover the rest" });
check("…and while the reply streams, its latest whole sentence", c.text === "The plan is recomputed: 91 tonnes to buy.", c.text);
c = cap({ busy: true, waitingOn: "planning-engine", queued: 2 });
check("…waiting on a session it delegated to, with the queue behind it", c.label === "Waiting on planning-engine · 2 queued", c.label);
c = cap({ busy: true, delegatingTo: "planning-engine", delegation: "Recompute the Q4 purchase plan" });
check("a SendMessage just went out: Delegating → the target, with what it said", c.state === "delegating" && c.label === "Delegating → planning-engine" && c.text === "Recompute the Q4 purchase plan", JSON.stringify(c));
check("…the core's state is delegating (the stream flies to that session)", L.coreState(Object.assign({}, base, { busy: true, delegatingTo: "x" })) === "delegating");
c = cap({ listening: true, voiceText: "Listening — release to send" });
check("the microphone: Listening, the voice bar's line, marked interim", c.state === "listening" && c.interim && c.text === "Listening — release to send");
c = cap({ speaking: true, spoken: "The plan is recomputed: 91 tonnes to buy." });
check("speaking: the sentence being read aloud, revealed word by word", c.state === "speaking" && c.words && c.text === "The plan is recomputed: 91 tonnes to buy.");
check("…never the microphone's old line while the first sentence loads", cap({ speaking: true, voiceText: "Listening…" }).text === "…");
c = cap({ pending: 3, needTitle: "Upgrade 252 modules on the trial box", busy: true });
check("needs you: waiting for you, the first item, how many more", c.state === "needs" && c.label === "Needs you" && c.text === "Waiting for you: upgrade 252 modules on the trial box (2 more).", c.text);
check("needs you wins over a running turn and a delegation", L.coreState(Object.assign({}, base, { pending: 1, busy: true, delegatingTo: "x" })) === "needs");
check("your voice wins over everything (listening, then speaking)", L.coreState(Object.assign({}, base, { pending: 1, listening: true })) === "listening" && L.coreState(Object.assign({}, base, { pending: 1, speaking: true, listening: true })) === "speaking");
c = cap({ voiceLive: true, voiceText: "Transcribing…" });
check("after a recording, before the turn starts: Heard / Transcribing", c.state === "thinking" && c.label === "Heard" && c.text === "Transcribing…" && c.interim);
check("every state is one the core knows", ["idle", "listening", "thinking", "delegating", "speaking", "needs"].join() === L.STATES.join());
check("gist: the first sentence of a markdown reply, as text", L.gist("**Disk** is at 6%. Nothing else.\n- a") === "Disk is at 6%.", L.gist("**Disk** is at 6%. Nothing else.\n- a"));
check("the page feeds the caption from real events (step, delegation, spoken sentence, voice bar)", /stepText: currentStep\(\)/.test(main) && /S\.delegTo = d\.target_name/.test(main) && /Voice\.onSpeak = function \(text\) \{ S\.spoken = text;/.test(main) && /api_\.onSpeak\(said\)/.test(main) && /new MutationObserver\(function \(\) \{ paintCaption\(\); \}\)\.observe\(\$\("cc-vb-text"\)/.test(main));
check("the spoken sentence reaches the caption when its audio starts, not when it is fetched", /setTimeout\(function \(\) \{ if \(my === gen\) api_\.onSpeak\(said\); \}, Math\.max\(0, st\.t\.play - Date\.now\(\)\)\)/.test(main));
check("caption words are revealed through CSSOM, not style attributes", /sp\.style\.animationDelay = /.test(main) && !/style=\\?"/.test(main.replace(/\.style\./g, "")));

/* ------------------------------------------------------ the decision card */
section("the decision card: each button -> its existing API");
const ap = { id: 12, status: "pending", tool: "Bash", input: { command: "rm -rf /tmp/x" }, category: "delete", label: "Deletes files or records", created_at: "2026-09-29T10:00:00Z", expires_at: "2026-09-29T10:10:00Z" };
const dProposed = { id: 7, kind: "watcher", watcher: "disk", status: "proposed", title: "/var/log grew 4.1 GB", proposal: "Rotate now.", fix_command: "logrotate -f /etc/logrotate.conf", last_seen: "2026-09-29T10:05:00Z" };
const dOpen = { id: 8, kind: "watcher", status: "open", title: "nginx failed", last_seen: "2026-09-29T10:06:00Z" };
const dRetire = { id: 9, kind: "retire", status: "proposed", title: "Retire the idle mint-dashboard session", last_seen: "2026-09-29T09:00:00Z" };
const q = L.needQueue([ap, Object.assign({}, ap, { id: 3 }), Object.assign({}, ap, { id: 4, status: "approved" })], [dProposed, dOpen, dRetire, { id: 10, status: "done", kind: "watcher", title: "x" }]);
check("the queue: pending approvals first (oldest first), then open findings (freshest first); done ones never", q.map((x) => x.key).join(" ") === "a3 a12 d8 d7 d9", q.map((x) => x.key).join(" "));
const acts = (item) => L.card(item).actions.map((a) => a.act + (a.path ? "=" + a.path : "") + (a.local ? "(local)" : "")).join(" | ");
check("approval: Approve -> approvals/:id/approve, Deny -> approvals/:id/deny, Always allow (rule dialog), Later",
  acts(q[1]) === "approve=approvals/12/approve | deny=approvals/12/deny | always(local) | later(local)", acts(q[1]));
check("watcher with a proposed fix: Apply fix -> decisions/:id/approve, Dismiss -> decisions/:id/dismiss, Later", acts(q[3]) === "approve=decisions/7/approve | dismiss=decisions/7/dismiss | later(local)", acts(q[3]));
check("open finding: Investigate -> decisions/:id/ask (with the Investigate text), Dismiss, Later",
  acts(q[2]) === "investigate=decisions/8/ask | dismiss=decisions/8/dismiss | later(local)" && L.card(q[2]).actions[0].body.text === "Investigate this and propose a fix.", acts(q[2]));
check("a retire proposal: Retire -> decisions/:id/approve, Keep -> decisions/:id/dismiss, Later", acts(q[4]) === "approve=decisions/9/approve | dismiss=decisions/9/dismiss | later(local)" && L.card(q[4]).actions.map((a) => a.label).join() === "Retire,Keep,Later");
check("labels as the mockup: Approve/Deny, Apply fix/Dismiss, Retire/Keep/Later", L.card(q[1]).actions.map((a) => a.label).slice(0, 2).join() === "Approve,Deny" && L.card(q[3]).actions.map((a) => a.label).join() === "Apply fix,Dismiss,Later");
check("an id is URL-encoded into its route", L.card({ type: "decision", id: "a/b", item: { status: "proposed", title: "t" } }).actions[0].path === "decisions/a%2Fb/approve");
{
  // Every route the card names is one server.js serves (under moniAiWrite).
  const routes = [/app\.post\("\/mint-ai\/api\/approvals\/:id\/:decision", \.\.\.moniAiWrite/, /app\.post\("\/mint-ai\/api\/decisions\/:id\/:action", \.\.\.moniAiWrite/, /\["approve", "dismiss", "ask"\]\.includes\(action\)/];
  check("every route the card calls exists on the server, behind moniai.use + CSRF", routes.every((r) => r.test(server)));
}
check("the card's click handler posts exactly the action's path and body", /api\(act\.path, \{ body: act\.body \}\)/.test(main) && /if \(act\.act === "always"\) \{ P\.openAlways\(it\.id\); return; \}/.test(main) && /if \(act\.act === "later"\) \{ closeNeed\(\); return; \}/.test(main));
check("the card pages (1 of N) and the amber pill brings it back", /data-need-pg/.test(main) && /\$\("cc-needpill"\)\.addEventListener\("click"/.test(main));
check("a new approval opens the card (and still says so aloud when voice is on)", /openNeed\("a" \+ a\.id\)/.test(main) && /Voice\.say\("I need your approval before I go on\."\)/.test(main));
check("approvals already waiting on load get the card", /if \(pendingApprovals\(\)\.length\) openNeed\(\);/.test(main));
check("the card counts down an approval's expiry", /data-need-timer/.test(main) && /function tickNeed\(\)/.test(main) && /tickNeed\(\);/.test(main));

/* ------------------------------------------------------ the dock's sheets */
section("the dock's sheets and their data");
const html = views.page({ csrf: "t", user: { name: "a", perm: rbac.actor({ permissions: ["*"] }) }, voice: { configured: true, voice: "marin", manage: true } });
const paneOf = (k) => {
  const i = html.indexOf(`id="cc-pane-${k}"`);
  const n = html.indexOf('<section class="cc-pane"', i + 10);
  const j = n > 0 ? n : html.indexOf("</aside>", i);
  return i < 0 ? "" : html.slice(i, j);
};
const FILL = {
  conv: [["cc-steps", "renderSteps"], ["cc-chat", "paintTurn"], ["cc-rc-text", "renderDrawerHead"], ["cc-speak-toggle", "speakBtn"]],
  sessions: [["cc-sessions", "renderSessions"], ["cc-stat-deleg", "renderStats"], ["cc-sess-aside", "renderSessions"]],
  missions: [["cc-mis-tabs", "renderMissions"], ["cc-lanes", "renderMissions"], ["cc-mis-head", "renderMissions"]],
  dec: [["cc-dec-list", "renderDecisions"], ["cc-feed", "renderFeed"], ["cc-evlog", "Event log"]],
  tl: [["cc-timeline", "renderTimeline"], ["cc-tl-count", "renderTimeline"]],
  rules: [["cc-rules-pane", "renderRules"]],
  orders: [["cc-orders", "renderOrders"]],
  cost: [["cc-cost-widget", "renderCostWidget"], ["cc-voice-usage", "renderVoiceUsage"]],
  machine: [["cc-mach-note", "renderMachine"], ["cc-core-grid", "renderCore"], ["cc-mach-badge", "renderMachine"]],
};
for (const k of Object.keys(FILL)) {
  const p = paneOf(k);
  const missing = FILL[k].filter(([id, fn]) => !p.includes(`id="${id}"`) || !(client.includes(`function ${fn}(`) || client.includes(fn)));
  check(`sheet ${k}: holds ${FILL[k].map((x) => "#" + x[0]).join(", ")}, filled by the page`, p && !missing.length, missing.map((x) => x[0]).join(" "));
}
check("the Machine sheet's grid cells are what renderCore writes (data-cell)", /querySelector\('\[data-cell="' \+ key \+ '"\]'\)/.test(main) && (paneOf("machine").match(/data-cell="/g) || []).length === 8);
check("opening a sheet refreshes it (rules, decisions, missions, sessions, conversation)", /if \(id === "rules"\) P\.renderRules\(\);/.test(main) && /if \(id === "dec"\) P\.renderDecisions\(\);/.test(main) && /if \(id === "missions"\) P\.renderMissions\(\);/.test(main) && /if \(id === "sessions"\) renderSessions\(true\);/.test(main));
check("the sessions sheet: MINT AI as CEO, each session with its sub-agents, Deep view and Message via MINT AI", /CEO · you talk to it/.test(main) && /cc-subagents/.test(main) && /data-deep-open=/.test(main) && /Message via MINT AI/.test(main) && /data-at=/.test(main));
check("a session point on the orbit opens the Sessions sheet", /onClick: function \(key\) \{ openSheet\("sessions"\); highlightSess\(key\); \}/.test(main));
check("Escape closes, in order: palette/dialog, menu, reply, sheet, card", /if \(e\.defaultPrevented\) return;/.test(main) && /if \(S\.pane\) \{ closeSheet\(\); return; \}/.test(main));

/* ------------------------------------------------------ nothing lost */
section("nothing lost from v3");
// Every API path the v3 client called (moni-ai.js, cc-panels.js at 26aee75), and where it is used now.
const API = [
  "ledger/turns", "ledger/approvals", "ledger/delegations", "ledger/inbound", "overview", "status", "send", "interrupt", "rc", "transcribe", "speak",
  "desk/turn", "desk/summary", "voice/usage", "missions", "missions/request", "decisions", "watchers", "rules", "rules/test", "orders", "cost", "cost/budget",
  "sessions/", "rule-suggestion", "approvals/",
];
const missingApi = API.filter((a) => !new RegExp(`["'/]${a.replace(/[/?]/g, "\\$&")}`).test(client) && !client.includes('"' + a));
check("every API path the v3 page called is still called", missingApi.length === 0, missingApi.join(" "));
check("the event stream and every event type it follows", /new EventSource\("\/mint-ai\/api\/events[?"]/.test(main) && ["proc", "init", "rc", "status", "turn", "text", "assistant", "tool", "tool_result", "steps", "result", "approval", "delegation", "inbound", "sessions", "vitals", "notice", "offline", "mission", "decision", "watcher", "order", "order_run", "rule", "machine"].every((t) => main.includes('"' + t + '"')));
// Every element the client reaches by id exists in the served page (or is built by the client itself).
{
  const built = new Set(["cc-ov", "cc-pal-q", "cc-pal-list", "cc-mis-goal", "cc-mis-err", "cc-mis-go", "cc-al-body", "cc-al-err", "cc-al-save", "cc-al-pat", "cc-al-match", "cc-try-in", "cc-try-btn", "cc-try-res", "cc-ord-form", "cc-ord-side", "cc-ord-foot", "cc-ord-name", "cc-ord-at", "cc-ord-every", "cc-ord-cron", "cc-ord-prompt", "cc-ord-words", "cc-ord-err", "cc-cost-body", "cc-bud", "cc-bud-err", "cc-bud-save", "cc-deep-in", "cc-vu-today", "cc-vu-month", "cc-vu-last", "cc-pop-vu"]);
  const ids = new Set();
  for (const m of client.matchAll(/\$\("([a-z0-9-]+)"\)/g)) ids.add(m[1]);
  for (const m of client.matchAll(/getElementById\("([a-z0-9-]+)"\)/g)) ids.add(m[1]);
  const missing = [...ids].filter((id) => !built.has(id) && !html.includes(`id="${id}"`));
  check("every element the page scripts reach by id is in the served page", missing.length === 0, missing.join(" "));
}
const KEEP = [
  ["the composer: send, interrupt, auto-route / @ a session", /\$\("cc-compose"\)\.addEventListener\("submit"/.test(main) && /\$\("cc-stop"\)\.addEventListener\("click"/.test(main) && /function openMenu\(\)/.test(main) && /e\.key === "@" && !input\.value/.test(main)],
  ["push to talk (the default) and hands-free", /function voiceModeFrom\(stored\) \{\s*return stored === "handsfree" \? "handsfree" : "ptt";/.test(main) && /cMic\.addEventListener\("pointerdown"/.test(main) && /api_\.on \? stop\(\) : start\(\);/.test(main)],
  ["Space hold-to-talk", /pttDown\("Listening — release Space to send"\)/.test(main)],
  ["\"On it.\" the moment a recording ends", /enqueue\("On it\."\)/.test(main)],
  ["streamed reader audio (NDJSON PCM chunks)", /Accept: "application\/x-ndjson"/.test(main) && /function playStream\(st, my\)/.test(main)],
  ["barge-in", /function bargeIn\(\)/.test(main) && /if \(loudFor >= BARGE_MS\) bargeIn\(\);/.test(main)],
  ["the front desk (and its fallback to the direct path)", /apiStream\("desk\/turn"/.test(main) && /apiStream\("desk\/summary"/.test(main) && /e\.code === "desk-off"/.test(main)],
  ["the voice guards: silence is never uploaded (SPEECH_MS), voice turns carry their vt", /var loudMs = 0, peak = 0, SPEECH_MS = 150;/.test(main) && /if \(opts\.voice && opts\.vt\) body\.vt = opts\.vt;/.test(main)],
  ["replies read aloud (toggle) and the Full reply's Read aloud", /\$\("cc-speak-toggle"\)/.test(main) && /\$\("cc-reply-read"\)\.addEventListener/.test(main)],
  ["Remote Control link (claude.ai only) and Interrupt", /function openRemoteControl\(\)/.test(main) && /function interrupt\(btn\)/.test(main)],
  ["the Ctrl+K palette", /String\(e\.key\)\.toLowerCase\(\) === "k"/.test(panels) && /function openPalette\(q\)/.test(panels)],
  ["the session deep view (5 s refresh, Interrupt / Open in Claude for MINT AI only)", /function openDeep\(key\)/.test(panels) && /data-deep="interrupt"/.test(panels)],
  ["new mission, standing order editor, cost detail and budget, Always allow", /function openNewMission\(goal\)/.test(panels) && /function openOrder\(id\)/.test(panels) && /function openCost\(\)/.test(panels) && /function openAlways\(id\)/.test(panels)],
  ["watchers on/off, rule add/edit/delete/test", /function toggleWatcher\(btn\)/.test(panels) && /api\("rules\/test"/.test(panels) && /"\/delete", \{ body: \{\} \}/.test(panels)],
  ["the active mission chip", /id="cc-mis-chip"/.test(html) && /function renderMisChip\(\)/.test(panels)],
  ["load earlier turns", /Load earlier turns/.test(main)],
  ["the status chip and clock in the top bar", /id="cc-sys"/.test(html) && /id="cc-clock"/.test(html)],
  ["the offline notice", /id="cc-offline"/.test(html) && /off\.hidden = S\.online;/.test(main)],
  ["theme: System / Dark / Light (shell switch, palette, Everything sheet)", /data-theme-to="light"/.test(html) && /Theme: dark/.test(panels)],
];
KEEP.forEach(([name, ok]) => check("kept: " + name, !!ok));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
