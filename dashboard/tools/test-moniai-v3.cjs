/**
 * Tests for the Command Center v3 page (phase 1): the new frame in
 * lib/views-moniai.js, and the pure helpers in public/moni-ai.js,
 * public/cc-panels.js and public/cc-map.js, cut out of the files that ship
 * and run here (the approach of test-moniai-page.cjs).
 *
 *     node dashboard/tools/test-moniai-v3.cjs
 *
 * What it holds the page to: this VPS only (no live Odoo anywhere), the
 * approved layout (rail, centre Map | Missions, drawer Conversation |
 * Decisions | Timeline | Rules), voice kept in the composer, no inline style
 * or script, every server string escaped, and the helpers that turn schedules,
 * rule patterns and palette queries into what the page shows.
 *
 * The interactions themselves (approvals, rules, watchers, standing orders,
 * missions, budget, deep view, palette) are exercised against a scratch
 * supervisor by the Playwright run described in the v3 hand-off.
 *
 * .cjs because it uses require, and some directories it may be run from declare
 * "type": "module".
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const views = require(path.join(ROOT, "lib", "views-moniai.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const read = (f) => fs.readFileSync(path.join(ROOT, "public", f), "utf8");
const main = read("moni-ai.js"), panels = read("cc-panels.js"), map = read("cc-map.js"), css = read("moni-ai.css");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + detail + ")" : ""));
}
function cut(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("no function " + name);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unbalanced " + name);
}

/* ------------------------------------------------------------ the frame --- */

const admin = rbac.actor({ permissions: ["*"] });
const EVIL = `<img src=x onerror=alert(1)>"'&`;
const html = views.page({ csrf: "t", user: { name: EVIL, perm: admin }, voice: { configured: true, voice: "marin", model: "gpt-realtime-mini", manage: true } });
const noKey = views.page({ csrf: "t", user: { name: "a", perm: admin }, voice: { configured: false, manage: true } });

check("no live Odoo anywhere in the frame", !/live odoo|gizaseeds\.cloud|test\.gizaseeds/i.test(html + noKey));
check("no live Odoo anywhere in the page scripts", ![main, panels, map].some((s) => /live odoo|gizaseeds\.cloud/i.test(s.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, ""))));
check("no machine filter (Trial / Live) and no second machine card", !/data-m="live"|data-m="trial"|mach-filter/.test(html) && (html.match(/class="cc-mach-this"/g) || []).length === 1);
check("'Add a machine' is there, disabled, and says it comes later", /class="cc-mach-add" aria-disabled="true"[^>]*>[\s\S]{0,200}Add a machine[\s\S]{0,40}coming later/.test(html));
check("the rail has Machines, MONI AI Core, Cost today, Standing orders", ["Machines", "MONI AI Core", "Cost today", "Standing orders"].every((h) => html.includes(">" + h + "</h2>")));
check("the core grid has its eight cells", ["core", "sessions", "agents", "memory", "watchers", "rules", "voice", "guard"].every((k) => html.includes(`data-core="${k}"`)));
check("the Vitals rings card and the big Talk to MONI card are gone", !/cc-rings|cc-mic-big|cc-voice-card|Talk to MONI<\/h2>/.test(html));
check("the centre switches Map | Missions", /data-view="map"/.test(html) && /data-view="missions"/.test(html) && /id="cc-map"/.test(html) && /id="cc-lanes"/.test(html));
check("the missions view starts hidden", /id="cc-view-missions" hidden/.test(html));
check("the drawer has Conversation | Decisions | Timeline | Rules", ["conv", "dec", "tl", "rules"].every((p) => html.includes(`data-pane="${p}"`)) && !/data-pane="feed"/.test(html));
check("the event log lives under Decisions", /id="cc-pane-dec"[\s\S]*id="cc-evlog"[\s\S]*id="cc-feed"[\s\S]*id="cc-pane-tl"/.test(html));
check("the composer keeps the mic, the voice bar and hold-to-talk", /id="cc-c-mic"/.test(html) && /id="cc-voicebar"/.test(html) && /<kbd>Space<\/kbd> hold to talk/.test(html));
check("replies-aloud toggle moved to the drawer head", /class="cc-dr-head"[\s\S]{0,900}id="cc-speak-toggle"/.test(html));
check("without a key: toggle hidden, mic disabled, the hint links to Settings", /id="cc-speak-toggle"[^>]*hidden/.test(noKey) && /id="cc-c-mic"[^>]*disabled/.test(noKey) && /href="\/credentials\/openai-voice"/.test(noKey));
check("the palette button is in the top bar, with its shortcut", /id="cc-kbtn"[^>]*aria-keyshortcuts="Control\+K"/.test(html));
check("no mockup leftovers (sample-data tag, Play flow, Hire)", !/SAMPLE DATA|Play flow|demo-btn|data-open="hire"|>Hire</.test(html + main + panels));
check("scripts load in order: map, panels, then the page", (() => {
  const a = html.indexOf("cc-map.js"), b = html.indexOf("cc-panels.js"), c = html.indexOf("/moni-ai.js");
  return a > 0 && a < b && b < c;
})());
check("every page script is deferred", ["cc-map.js", "cc-panels.js", "moni-ai.js"].every((f) => new RegExp(`/static/${f.replace(".", "\\.")}\\?v=[^"]+" defer>`).test(html)));
check("the overlay root is outside the shell", /<\/div>\s*<div id="cc-overlay"><\/div>/.test(html));
check("no inline style anywhere in the frame", !/\sstyle\s*=/i.test(html) && !/<style[\s>]/i.test(html));
check("the viewer name is escaped", !html.includes(EVIL));
check("every id is unique", (() => { const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]); return ids.length === new Set(ids).size; })());

/* ----------------------------------------------------- the icons in use --- */

check("every icon the palette and panels name is in the sprite", (() => {
  const names = new Set();
  for (const src of [main, panels]) {
    for (const m of src.matchAll(/\bic\(\s*"([a-z0-9]+)"/g)) names.add(m[1]);
    for (const m of src.matchAll(/add\("[^"]+", [^\n]*?, "([a-z0-9]+)", "(?:m|)", /g)) names.add(m[1]);
    for (const m of src.matchAll(/\bic\([^()]*? \? "([a-z0-9]+)" : "([a-z0-9]+)"\)/g)) { names.add(m[1]); names.add(m[2]); }
  }
  ["core", "desktop", "terminal", "remote", "sessions"].forEach((n) => names.add(n)); // sessIcon()
  const missing = [...names].filter((n) => !views.SPRITE[n] && !/^(work|wait|idle|off|bad|warn|ok|done|x|w|est|hot|on|mis|self)$/.test(n));
  return missing.length === 0 || (console.log("   missing:", missing.join(", ")), false);
})());

/* ------------------------------------------------------ pure helpers --- */

const box = {};
vm.runInNewContext(
  ["scheduleLabel", "globMatch", "fuzzy", "tokens"].map((n) => cut(panels, n)).join("\n") + "\nvar DOW = " + /var DOW = (\[[^\]]+\])/.exec(panels)[1] + ";",
  box
);
check("schedule: every day", box.scheduleLabel({ kind: "daily", at: "07:30" }) === "Every day at 07:30");
check("schedule: weekdays, time padded", box.scheduleLabel({ kind: "weekdays", at: "7:05" }) === "Weekdays at 07:05");
check("schedule: weekly names the day (0 = Sunday)", box.scheduleLabel({ kind: "weekly", at: "09:15", dow: 3 }) === "Every Wednesday at 09:15" && /Sunday/.test(box.scheduleLabel({ kind: "weekly", at: "09:00", dow: 0 })));
check("schedule: every N hours, clamped 1..24", box.scheduleLabel({ kind: "hours", every_h: 6 }) === "Every 6 hours" && box.scheduleLabel({ kind: "hours", every_h: 1 }) === "Every hour" && box.scheduleLabel({ kind: "hours", every_h: 99 }) === "Every 24 hours");
check("schedule: cron shows the expression", box.scheduleLabel({ kind: "cron", cron: "30 7 * * 1-5" }) === "Cron: 30 7 * * 1-5");
check("schedule: a bad time never renders as a time", box.scheduleLabel({ kind: "daily", at: "7pm" }) === "Every day at --:--");

check("glob: * is any text, over the whole command", box.globMatch("systemctl restart *", "systemctl restart odoo") && !box.globMatch("systemctl restart *", "sudo systemctl restart odoo"));
check("glob: \\* is a literal star", box.globMatch("ls \\*", "ls *") && !box.globMatch("ls \\*", "ls a"));
check("glob: regex characters are literal", box.globMatch("rm /tmp/a.b", "rm /tmp/a.b") && !box.globMatch("rm /tmp/a.b", "rm /tmp/axb") && box.globMatch("echo (x)|[y]", "echo (x)|[y]"));
check("glob: * crosses newlines (a message body)", box.globMatch("fake-target: *", "fake-target: line one\nline two"));

check("fuzzy: a substring wins over scattered letters", box.fuzzy("odoo", "Deep view · Odoo 19 VPS").score > box.fuzzy("odoo", "Open Decisions · no odd ones overall").score);
check("fuzzy: letters in order match, with their positions", (() => { const m = box.fuzzy("thm lght", "Theme: light"); return m && m.idx.length === 7; })());
check("fuzzy: out of order does not match", box.fuzzy("zx", "Theme: light") === null);

check("tokens read like people say them", box.tokens(812) === "812" && box.tokens(44000) === "44k" && box.tokens(3100000) === "3.1M" && box.tokens(null) === "—");

const box2 = {};
vm.runInNewContext(["esc", "money", "plain", "pct", "applyBars", "clip"].map((n) => cut(main, n)).join("\n"), box2);
check("money: cents, under a cent, and missing", box2.money(11.4) === "$11.40" && box2.money(0.004) === "<$0.01" && box2.money(0) === "$0.00" && box2.money(null) === "—");
check("plain: markdown becomes one line of text", box2.plain("**Disk** 6%\n- `nginx` ok\n[docs](https://x)") === "Disk 6% nginx ok docs");
check("applyBars: widths, --v and left from data attributes, clamped", (() => {
  const mk = (attr, v) => ({ attr, v, style: { setProperty(k, x) { this[k] = x; } }, getAttribute() { return this.v; } });
  const w = mk("data-w", "150"), v = mk("data-v", "42"), l = mk("data-l", "-5");
  box2.applyBars({ querySelectorAll: (sel) => (sel === "[data-w]" ? [w] : sel === "[data-v]" ? [v] : [l]) });
  return w.style.width === "100%" && v.style["--v"] === "42%" && l.style.left === "0%";
})());

/* An approval card, run with the real code: three choices, escaped, rule-aware. */
{
  const b = {
    hm: () => "12:00",
    ic: (n) => `<svg data-i="${n}"></svg>`,
  };
  vm.runInNewContext(["esc", "clip", "approvalTarget", "approvalCmd", "decidedBy", "approvalHTML"].map((n) => cut(main, n)).join("\n"), b);
  const a = { id: 7, tool: "Bash", status: "pending", input: { command: `rm -rf /tmp/"x"<b>` }, category: "delete", label: "Deletes files", reason: EVIL,
    rule_suggestion: { tool: "Bash", pattern: "rm -rf /tmp/<p>" }, mission_ref: "M-7", step_n: 3, expires_at: "2026-09-28T12:10:00Z", created_at: "2026-09-28T12:00:00Z" };
  const h = b.approvalHTML(a);
  check("approval card: Approve once, Always allow this, Deny", /data-approve="7"[^>]*>[\s\S]*Approve once/.test(h) && /data-always="7"[\s\S]*Always allow this/.test(h) && /data-deny="7"/.test(h));
  check("approval card: command, reason and suggested pattern are escaped", !h.includes('"x"<b>') && !h.includes(EVIL) && !h.includes("/tmp/<p>") && h.includes("rm -rf /tmp/&lt;p&gt;"));
  check("approval card: names its mission step", /M-7 · step 3/.test(h));
  const auto = b.approvalHTML(Object.assign({}, a, { status: "approved", decided_by: "rule:12", decided_at: "2026-09-28T12:01:00Z" }));
  check("approval card: a rule's answer reads as auto-approved by that rule", /Auto-approved/.test(auto) && /rule #12/.test(auto) && /resolved ok/.test(auto));
  const sm = b.approvalHTML({ id: 8, tool: "SendMessage", status: "pending", input: { to: "Odoo 19 VPS [ab12cd]", message: "hello" }, created_at: "x", expires_at: "y" });
  check("approval card: a message names its session without the ref", /send this to <b>Odoo 19 VPS<\/b>/.test(sm));
}

/* ----------------------------------------------------- the map's palette --- */

{
  const keys = (/\["floret"[\s\S]*?\]/.exec(map) || [""])[0].match(/"([a-z-]+)"/g).map((k) => "--orb-" + k.replace(/"/g, ""));
  const block = (re) => (re.exec(css) || ["", ""])[1];
  const dark = block(/:root\.cc-page \{([\s\S]*?)\n\}/), light = block(/:root\.cc-page\[data-theme="light"\] \{([\s\S]*?)\n\}/), sys = block(/@media \(prefers-color-scheme: light\) \{\s*:root\.cc-page:not\(\[data-theme="dark"\]\) \{([\s\S]*?)\n  \}/);
  const miss = (b) => keys.filter((k) => !b.includes(k + ":"));
  check("the map reads every colour from a token the dark theme sets", miss(dark).length === 0, miss(dark).join(" "));
  check("…and the chosen light theme", miss(light).filter((k) => !/-(glow|core|hud)$/.test(k) || !dark.includes(k)).length === 0 || miss(light).length === 0, miss(light).join(" "));
  check("…and the system light theme", miss(sys).length === miss(light).length, miss(sys).join(" "));
}
check("the map pauses when hidden or not on the Map view", /visibilitychange/.test(map) && /visible\(\)/.test(map) && /S\.view === "map"/.test(main));
check("the map honours reduced motion with still frames", /prefers-reduced-motion: reduce/.test(map) && /if \(reduced\) \{ draw\(performance\.now\(\)\); return; \}/.test(map));
check("the map is DPR-aware", /devicePixelRatio/.test(map) && /setTransform\(DPR/.test(map));
check("delegation beads go out, reply beads come back", /send: function \(id\)/.test(map) && /reply: function \(id\)/.test(map) && /Orb\.send\(/.test(main) && /Orb\.reply\(/.test(main));

/* ------------------------------------------------ events the page follows --- */

check("the page follows the new event types", ["mission", "decision", "watcher", "order", "order_run", "rule", "machine"].every((t) => new RegExp(`"${t}"`).test(main.slice(main.indexOf("var EVENTS"), main.indexOf("var EVENTS") + 600))));
check("the panels handle mission, decision, watcher, order, order_run, rule", ["mission", "decision", "watcher", "order", "order_run", "rule"].every((t) => panels.includes(`case "${t}":`)));
check("the deep view refreshes every 5 s and stops when closed", /setInterval\(function \(\) \{ if \(!document\.hidden\) fetchDeep\(\); \}, 5000\)/.test(panels) && /clearInterval\(OV\.timer\)/.test(panels));
check("Interrupt and Open in Claude Desktop only in MONI AI's own deep view", /s\.self \? \(st === "working" \? '<button[^']*data-deep="interrupt"/.test(panels) && /data-deep="rc"/.test(panels));
check("'Always allow this' shows the rule before it saves", /rule-suggestion/.test(panels) && /approvals\/" \+ id \+ "\/approve", \{ body: \{ rule: \{ pattern: pattern, tool: tool \} \} \}/.test(panels));
check("Telegram delivery is offered disabled, with the server's reason", /Telegram<\/button>/.test(panels) && /tg\.why/.test(panels));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
