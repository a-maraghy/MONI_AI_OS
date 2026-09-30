/**
 * The Command Center's family of spheres (public/cc-family.js) and its setting.
 *
 *     node dashboard/tools/test-cc-family.cjs
 *
 * Static and wiring checks; the behaviour (layout with no overlaps at
 * 1920/1440/1366/390, 1..7 sessions, both themes, frame time, birth,
 * dissolve, hover, click, reduced motion, sub-agents) is checked in the
 * browser on a scratch stack (scratchpad pw-spheres.cjs).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return console.log("  ok   " + name); }
  failures++;
  console.log("  FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const fam = read("public/cc-family.js"), map = read("public/cc-map.js"), page = read("public/moni-ai.js"), css = read("public/moni-ai.css");
const server = read("server.js"), views = read("lib/views-moniai.js"), settings = read("public/mint-settings.js");
const logic = require(path.join(ROOT, "public", "cc-logic.js"));

console.log("the setting");
check("two views, spheres by default; anything else is spheres", logic.normSessView("") === "spheres" && logic.normSessView("orbit") === "orbit" && logic.normSessView("x") === "spheres" && logic.isSessView("orbit") && !logic.isSessView("depth"));
check("stored on the user row like mint_core", /addColumn\("users", "sessions_view"/.test(read("lib/db.js")) && /setUserSessionsView/.test(read("lib/db.js")));
check("POST /mint-ai/api/prefs/sessions: CSRF'd (moniAiWrite), validated, audited", /app\.post\("\/mint-ai\/api\/prefs\/sessions", \.\.\.moniAiWrite/.test(server) && /isSessView\(view\)/.test(server) && /"account", `Sessions view \$\{was\} -> \$\{view\}/.test(server));
check("Account › Appearance posts it too (no JavaScript) and its page script saves it at once", /req\.body\.sessions_view/.test(server) && /name="sessions_view"/.test(views) && /\/mint-ai\/api\/prefs\/sessions/.test(settings));
check("the page is rendered with data-sessview", /data-sessview="\$\{sessview\}"/.test(views) && /sessview: req\.me\.sessions_view/.test(server));
check("the canvas, the names and the card are in the page, and cc-family.js loads before cc-map.js", /id="cc-family"/.test(views) && /id="cc-kids"/.test(views) && /id="cc-kcard"/.test(views) && /"cc-family\.js", "cc-map\.js"/.test(views));

console.log("\nthe view");
check("CSP: no inline style attribute is ever written (CSSOM only)", !/style="/.test(fam) && !/setAttribute\("style"/.test(fam));
check("classic orbit hides the spheres; spheres hide the orbit", /\.cc-shell:not\(\[data-sessview="orbit"\]\) \.cc-orbit \{ display: none; \}/.test(css) && /\[data-sessview="orbit"\] \.cc-family/.test(css));
check("it rides the core's own frame and forwards delegations and replies", /family\.frame\(\)/.test(map) && /family\.send\(id\)/.test(map) && /family\.reply\(id\)/.test(map));
check("the core's delegation stream aims at the sphere", /var fp = family\.positions\(\);\s*if \(id && fp\[id\]\) \{ lastPos\[id\] = fp\[id\]; return fp\[id\]; \}/.test(map));
check("it stays clear of the top bar, caption, composer / voice bar, approval card, icon rail, reply, menus and an open sheet", ["top bar", "caption", "composer", "approval card", "icon rail", "reply", "menu"].every((n) => map.includes('"' + n + '"')) && /cc-sheet/.test(map));
check("hard guarantees every frame: her edge, the chrome, each other, the screen", /function guarantee\(live\)/.test(fam) && /herMin\(k, dy, hd\)/.test(fam) && /rects\.forEach\(function \(rc\) \{ var p = pen\(kidBox/.test(fam));
check("prefers-reduced-motion: settled once, still frames", /prefers-reduced-motion: reduce/.test(fam) && /if \(reduced\) settle\(160\);/.test(fam) && /if \(!on \|\| reduced\) return;/.test(fam));
check("needs you (waiting) is amber with a badge; a finished one blooms and says done", /k\.st === "waiting" \? "needs you" : t < k\.doneUntil \? "done"/.test(fam) && /was === "working" && k\.st === "idle"\) \{ k\.bloom = 1/.test(fam));
check("birth from her, dissolve back into her; nothing here retires anything", /form: born && !reduced \? 0 : 1/.test(fam) && /k\.dis = 0\.0001/.test(fam) && !/retire|hire\(/i.test(fam.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
check("sub-agent specks from real sub-agent data (running ones, at most 6)", /Math\.min\(6, \(d\.subs \|\| \[\]\)\.length\)/.test(fam) && /a\.status !== "done" && a\.status !== "failed"/.test(page));
check("hover card: task, last message, cost today; click / Enter opens the existing deep view", /<dt>Now<\/dt>/.test(fam) && /<dt>Last<\/dt>/.test(fam) && /<dt>Today<\/dt>/.test(fam) && /onOpen: function \(key\) \{ if \(P && P\.openDeep && findSess\(key\)\) P\.openDeep\(key\)/.test(page));
check("names are buttons (keyboard) with an aria-label; the canvas is aria-hidden", /document\.createElement\("button"\)/.test(fam) && /setAttribute\("aria-label", line \+ "\. Open its conversation\."\)/.test(fam) && /class="cc-family" id="cc-family" aria-hidden="true"/.test(views));
check("an overlap audit and frame stats are exposed for the checks", /audit: function \(\)/.test(fam) && /stats: function \(\)/.test(fam));
check("real data only in the page: task from waiting_for / mission / delegation, last from its messages, size from today's work", /function familyNode\(s\)/.test(page) && /S\.inbound\.forEach/.test(page) && /cost_today_usd_est/.test(page));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
