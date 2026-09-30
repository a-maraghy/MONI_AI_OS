#!/usr/bin/env node
"use strict";
/**
 * Tests for Help ▸ Guide (lib/views-guide.js, public/guide.js).
 *
 *   NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-guide.cjs
 *
 * Renders the guide and checks: the fourteen sections are there, each with a
 * literal id in the source (the page registry scans for them), a "where" line
 * and a contents entry; the text says nothing about removed features; the old
 * detailed Telegram / memory material survived the rewrite; hosts are escaped;
 * the search script and stylesheet are loaded as external assets.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

process.env.MONI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "guide-test-"));
const ROOT = path.join(__dirname, "..");
const lib = (m) => require(path.join(ROOT, "lib", m));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? "\n       " + detail : ""));
  }
}

const rbac = lib("rbac");
const views = lib("views-guide");
const admin = rbac.actor({ permissions: ["*"], agent_scope: "*", channel_scope: "*" });
const user = { name: "Ann", roleLabel: "Administrator", perm: admin, chrome: lib("chrome").forActor(admin, null) };

const IDS = ["around", "cc", "voice", "hire", "screen", "budget", "approvals", "agents", "memory", "machine", "access", "devices", "trouble", "where"];

const page = views.guide({ csrf: "c", user, publicHost: "h<x>", publicPort: 8443, sshHost: 'ssh"<b>' });
const src = fs.readFileSync(path.join(ROOT, "lib", "views-guide.js"), "utf8");

// The document column only: the shell around it (sidebar, top bar) is not the guide's text.
const docMain = (page.match(/<div class="doc-main">([\s\S]*)<\/div><aside class="doc-side">/) || [])[1] || "";
const side = (page.match(/<aside class="doc-side">([\s\S]*?)<\/aside>/) || [])[1] || "";
const visible = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const text = visible(docMain);

console.log("sections");
const sections = [...docMain.matchAll(/<section id="([a-z0-9-]+)" class="card gd">([\s\S]*?)<\/section>/g)].map((m) => ({ id: m[1], body: m[2] }));
check("fourteen guide sections, in order", JSON.stringify(sections.map((s) => s.id)) === JSON.stringify(IDS), sections.map((s) => s.id).join(","));
IDS.forEach((id) => check(`#${id} is a literal section id in the source`, src.includes(`<section id="${id}" class="card gd">`)));
const allIds = [...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const dup = allIds.filter((id, i) => allIds.indexOf(id) !== i);
check("no id appears twice on the page", dup.length === 0, dup.join(","));
sections.forEach((s) => check(`#${s.id} has a heading and a where line`, /^\s*<h2>[^<]+<\/h2>\s*<p class="where">[^<]+<\/p>/.test(s.body)));
const whereOf = (id) => ((sections.find((s) => s.id === id) || {}).body || "").match(/<p class="where">([^<]+)<\/p>/)?.[1] || "";
check("voice sits under MINT AI › Settings › Voice", whereOf("voice") === "MINT AI › Settings › Voice");
check("hire limits point at Settings › Sessions &amp; hiring", /Sessions &amp; hiring/.test(whereOf("hire")));
check("devices sit under Access &amp; security", /^Access &amp; security › Devices/.test(whereOf("devices")));

console.log("contents");
const toc = [...side.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1]);
check("the contents list every section, in order", JSON.stringify(toc) === JSON.stringify(IDS), toc.join(","));
check("the contents are the side column's data-toc list", /data-toc/.test(side) && /class="doc-side"/.test(page));
check("the contents' first entry is highlighted", /<li><a href="#around" class="on">/.test(side));

console.log("search");
check("a search box is on the page", /<input type="search" id="guide-q"/.test(docMain));
check("an empty note for no matches", /id="gd-empty"/.test(docMain));
check("guide.css and guide.js are loaded from /static", /<link rel="stylesheet" href="[^"]*guide\.css[^"]*">/.test(page) && /<script src="[^"]*guide\.js[^"]*" defer><\/script>/.test(page));
check("no inline script (CSP)", !/<script(?![^>]*\bsrc=)[^>]*>/.test(page));
check("public/guide.js exists", fs.existsSync(path.join(ROOT, "public", "guide.js")));
check("public/guide.css hides non-matching sections", /\.gd\.hide\s*\{\s*display:\s*none/.test(fs.readFileSync(path.join(ROOT, "public", "guide.css"), "utf8")));

console.log("facts");
[
  [/\bconsole\b/i, "console"],
  [/classic chat/i, "Classic chat"],
  [/front desk/i, "front desk"],
  [/push[- ]to[- ]talk/i, "push to talk"],
  [/\btrial\b/i, "trial"],
  [/hands-free/i, "hands-free"],
  [/\$|money budget|daily budget|dollar/i, "a money budget"],
  [/OS Dashboard|Agents Dashboard/, "the old dashboards"],
].forEach(([re, label]) => check(`the guide never mentions ${label}`, !re.test(text), (text.match(new RegExp(".{0,40}" + re.source + ".{0,40}", "i")) || [])[0]));
check("voice is a live conversation", /live conversation/.test(text));
check("Disabled turns off all voice incl. read-aloud, token kept", /Disabled[^.]*all voice[^.]*read-aloud/.test(text) && /token stays stored/.test(text));
check("only administrators may talk by voice (voice.use)", /Only administrators may talk by voice/.test(text) && /voice\.use/.test(text));
check("one voice model; listening is a fixed paired transcription model, not a setting", /One voice model/.test(text) && /GPT Realtime 2\.1 mini/.test(text) && /gpt-4o-mini-transcribe/.test(text) && /not a setting/.test(text) && !/Listening model/.test(text));
check("caps count cache tokens, the N tok today figure", /input, output and cache/.test(text) && /N tok today/.test(text));
check("caps are checked at turn end and after each cost scan", /end of every MINT AI turn/.test(text) && /cost scan/.test(text));
check("your own sessions only warn", /can only warn/.test(text));
check("hire limits default 7 and 3, editable", /default up to 7 live sessions and 3 hires an hour/.test(text) && /editable/.test(text));
check("retiring always needs consent", /retiring always needs your consent/.test(text));
check("new page-map entries allowed at once by default", /allowed at once \(the default\)/.test(text));
check("an administrator may sign out other users' devices", /administrator can sign out another user's devices/.test(text));
check("SSH pairing lives under SSH keys › Pair a device, /pair unchanged", /SSH keys › Pair a device/.test(text) && /\/pair/.test(text));
check("avatar menu entries", ["Account & sign-in", "Signed-in devices", "MINT AI appearance", "Sign out"].every((s) => text.includes(s)));
check("the five sidebar groups", ["MINT AI", "Agents & sessions", "Machine", "Access & security", "Help"].every((s) => text.includes(s)));
check("the ☰ at the foot of the Command Center's icon bar", /☰ button at the bottom of that bar/.test(text));

console.log("nothing lost from the old guide");
[
  ["bot creation", /@BotFather/, "bot"],
  ["user id", /@userinfobot/, "userid"],
  ["agent + channel forms", /Short name/, "create"],
  ["bot commands", /\/verbose 0\|1\|2/, "talk"],
  ["add-ons (voice notes, files)", /whisper\.cpp/, "addons"],
  ["groups and topics", /Manage Topics/, "topics"],
  ["WhatsApp", /install-whatsapp\.sh/, "whatsapp"],
  ["broadcast channels", /can only talk, never listen/, "channels"],
  ["the vault", /WORKLOG\.md/, "vault"],
  ["the vector index", /memory_search/, "vault"],
  ["Obsidian over RDP", /13389/, "obsidian"],
  ["the agents' file tree", /claude-auth\.env/, "layout"],
  ["privilege", /moni-helper/, "where"],
  ["how it works", /No inbound port/, "how"],
].forEach(([label, re, anchor]) => check(`${label} is still covered (#${anchor})`, re.test(docMain) && allIds.includes(anchor)));
check("old anchors still resolve", ["how", "bot", "userid", "create", "talk", "addons", "topics", "whatsapp", "channels", "obsidian", "trouble", "layout"].every((id) => allIds.includes(id)));

console.log("escaping");
check("the SSH host is escaped", page.includes("ubuntu@ssh&quot;&lt;b&gt;") && !page.includes('ssh"<b>'));
const fallback = views.guide({ csrf: "c", user, publicHost: "<pub>", publicPort: 1 });
check("with no SSH host the public host is used, escaped", fallback.includes("ubuntu@&lt;pub&gt;") && !fallback.includes("<pub>"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
