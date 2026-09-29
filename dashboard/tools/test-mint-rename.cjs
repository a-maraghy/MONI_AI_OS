#!/usr/bin/env node
"use strict";
/**
 * The rename: the web OS is "Mint OS" and its assistant "MINT AI" (they were
 * MONI AI OS and MONI AI until 2026-09-29).
 *
 *   NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-mint-rename.cjs
 *
 * Checks what the administrator sees and hears -- the top bar, the page
 * titles, the Command Center, the login page, the guide, the voice prompts and
 * the desk's instructions -- and that everything matching the assistant by
 * NAME accepts both the new and the old name during the transition: the voice
 * desk's guard, the desk's model view, and the Command Center's own helper
 * (cut out of public/moni-ai.js and run here, so this tests the shipped code).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

process.env.MONI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mint-test-"));
const ROOT = path.join(__dirname, "..");
const lib = (m) => require(path.join(ROOT, "lib", m));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 400) : ""));
  }
}

// "MONI" as a word a person sees. Internal ids stay (moni-ai, moni-agent@,
// /opt/moni-agents, MONI_*), so only the upper-case / title-case name counts.
const OLD_NAME = /\bMONI\b(?![_-])|\bMoni\b(?![A-Z_-])/;
const visible = (html) =>
  String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ");
const titleOf = (html) => ((/<title>([^<]*)<\/title>/.exec(html) || [])[1] || "");

const ui = lib("ui");
const rbac = lib("rbac");
const views = lib("views");
const admin = rbac.actor({ permissions: ["*"] });
const user = { name: "Ann", roleLabel: "Administrator", perm: admin, dash: "os" };

console.log("the frame");
{
  const page = ui.shell("Overview", "<p>x</p>", { user, csrf: "c", active: "services" });
  check("the page title ends in Mint OS", / — Mint OS$/.test(titleOf(page)), titleOf(page));
  check("the top-bar brand is the MINT [OS] lockup", /<span class="lockup os brand-text" aria-label="MINT OS">[\s\S]*?<span class="lk-mint">MINT<\/span><span class="pill-brand pill-os">\[<b>OS<\/b>\]<\/span>/.test(page));
  check("the brand link is labelled Mint OS home", /aria-label="Mint OS home"/.test(page));
  check("the assistant's tab reads MINT AI", />MINT AI</.test(page) && /href="\/mint-ai"/.test(page));
  check("no old name anywhere a person reads", !OLD_NAME.test(visible(page)) && !/MONI AI/.test(page), (visible(page).match(/.{0,40}\bMONI\b.{0,40}/) || [])[0]);
  const nav = ui.NAV.find((n) => n.key === "console");
  check("the NAV entry is labelled MINT AI", nav && nav.label === "MINT AI");
}

console.log("login, setup, pair");
{
  const login = views.login({ csrf: "c" });
  check("the login page title says Mint OS", /Mint OS/.test(titleOf(login)), titleOf(login));
  check("the login card carries the MINT [OS] lockup and says Sign in", /class="card auth-card"><div class="auth-lockup"><span class="lockup os full" aria-label="MINT OS">/.test(login) && /<h2[^>]*>Sign in<\/h2>/.test(login));
  check("no old name on the login page", !OLD_NAME.test(visible(login)));
  for (const [name, html] of [["setup", views.setup({ csrf: "c", token: "t" })], ["pair", views.pair({ csrf: "c" })]]) {
    check(`the ${name} page says Mint OS, not MONI`, /Mint OS/.test(titleOf(html)) && !OLD_NAME.test(visible(html)), titleOf(html));
  }
}

console.log("the Command Center");
{
  const cc = lib("views-moniai").page({
    csrf: "c",
    user: { name: "Ann", roleLabel: "Administrator", perm: admin, dash: "console" },
    voice: { configured: true, voice: "marin", model: "gpt-realtime-mini", manage: true, desk: true },
  });
  check("its title is MINT AI (the AI brand names itself once)", titleOf(cc) === "MINT AI", titleOf(cc));
  check("the core card is MINT AI Core", /<h2 id="cc-core-h">MINT AI Core<\/h2>/.test(cc));
  check("the drawer is headed MINT AI", /<h2>MINT AI<\/h2>/.test(cc));
  check("the composer says Tell MINT AI what to do…", /placeholder="Tell MINT AI what to do…"/.test(cc));
  check("the voice bar says TALK TO MINT", /TALK TO MINT/.test(cc) && /aria-label="Talk to MINT"/.test(cc));
  check("no old name in the Command Center", !OLD_NAME.test(visible(cc)) && !/MONI/.test(cc.replace(/moni-ai|MoniMap|MoniPanels/g, "")), (cc.match(/.{0,40}MONI.{0,40}/) || [])[0]);

  const pub = (f) => fs.readFileSync(path.join(ROOT, "public", f), "utf8");
  for (const f of ["moni-ai.js", "cc-panels.js", "cc-map.js", "console.js", "mycelium.js"]) {
    const src = pub(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // Only the name matchers may still spell the old name (lower case, in a regex / string compare).
    check(`public/${f} shows no MONI to a person`, !/MONI(?!_)/.test(src) && !/\bMoni\b(?![A-Z])/.test(src), (src.match(/.{0,50}MONI(?!_).{0,50}/) || [])[0]);
  }
  check("the orbit map labels the core MINT AI", /fillText\("MINT AI"/.test(pub("cc-map.js")));
  check("the favicon is labelled Mint OS", /aria-label="Mint OS"/.test(pub("favicon.svg")));
}

console.log("guide and settings");
{
  const guide = lib("views-guide").guide({ csrf: "c", user, publicHost: "h", publicPort: 1, sshHost: "h" });
  check("the guide shows no old name", !OLD_NAME.test(visible(guide)), (visible(guide).match(/.{0,40}\bMONI\b.{0,40}/) || [])[0]);
  const voicePage = lib("views-credentials").voice({
    csrf: "c", user, credentials: [], voice: { configured: true, last4: "abcd", model: "gpt-realtime-mini", voice: "marin", transcribe_model: "gpt-4o-mini-transcribe" },
    desk: { enabled: true }, models: [], voices: [], transcribeModels: [], test: null,
  });
  check("Settings › OpenAI voice speaks of MINT AI", /MINT AI/.test(voicePage) && !OLD_NAME.test(visible(voicePage)), (visible(voicePage).match(/.{0,40}\bMONI\b.{0,40}/) || [])[0]);
  const perms = rbac.GROUPS || rbac.PERMISSION_GROUPS || null;
  const rbacSrc = fs.readFileSync(path.join(ROOT, "lib", "rbac.js"), "utf8");
  check("the permission labels say MINT AI", /label: "MINT AI"/.test(rbacSrc) && /Command MINT AI/.test(rbacSrc) && !/MONI AI/.test(rbacSrc), perms && "");
}

console.log("voice");
{
  const voice = lib("voice");
  const desk = lib("voice-desk");
  check("the transcription vocabulary names Mint and MINT AI", /Mint/.test(voice.TRANSCRIBE_PROMPT) && /MINT AI/.test(voice.TRANSCRIBE_PROMPT), voice.TRANSCRIBE_PROMPT);
  check("the transcription vocabulary no longer says MONI", !/MONI/.test(voice.TRANSCRIBE_PROMPT), voice.TRANSCRIBE_PROMPT);
  const instr = [desk.INSTRUCTIONS, desk.SUMMARY_INSTRUCTIONS, JSON.stringify(desk.TOOLS)].join("\n");
  check("the front desk's instructions name MINT AI", /front desk of MINT AI/.test(desk.INSTRUCTIONS) && /MINT AI replied/.test(desk.INSTRUCTIONS), desk.INSTRUCTIONS.slice(0, 200));
  check("no MONI in the desk's instructions or tool descriptions", !/MONI/.test(instr), (instr.match(/.{0,40}MONI.{0,40}/) || [])[0]);
  const lines = [desk.SAFE_LINE, desk.SAFE_LINE_ASKED, desk.SAFE_LINE_TAIL, desk.APPROVAL_LINE, desk.APPROVAL_LINE_SHORT, desk.DETAILS_LINE, desk.SUMMARY_CUT_LINE, desk.SUMMARY_NONE_LINE];
  check("every fixed spoken line is free of MONI", lines.every((l) => !/MONI/i.test(String(l || ""))), lines.join(" | "));
  check("the fixed lines that name the assistant say MINT AI", /MINT AI/.test(desk.SAFE_LINE) && /MINT AI/.test(desk.SUMMARY_NONE_LINE));

  // The guard catches the same claims about either name.
  const ctx = { grounded: true, snapshotText: "{}" };
  for (const n of ["MINT AI", "MONI AI", "Mint"]) {
    const g = desk.guard(`${n} said the backups are fine.`, ctx);
    check(`an invented "${n} said…" is cut`, !g.ok && g.rule === "invented-reply", JSON.stringify(g));
    const h = desk.unbackedHandoff(`I've passed that to ${n}.`, { askedNow: false, pending: false });
    check(`an unbacked "passed that to ${n}" is cut`, h && h.rule === "unbacked-handoff", JSON.stringify(h));
    check(`backed by a call, "passed that to ${n}" passes`, desk.unbackedHandoff(`I've passed that to ${n}.`, { askedNow: true }) === null);
  }
  const view = desk.forModel({ moni_ai: { state: "Ready" }, requests_to_moni_ai: [{ id: 3, answered: true, reply: "x" }] });
  check("the desk's model view speaks of mint_ai, not moni_ai", view.mint_ai && view.mint_ai.state === "Ready" && !("moni_ai" in view) && Array.isArray(view.your_requests_to_mint_ai), JSON.stringify(view));
}

console.log("the Command Center's name helper (public/moni-ai.js)");
{
  const src = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
  const a = src.indexOf("  var AI_NAME = ");
  const b = src.indexOf("  function liveSessions()");
  check("the helper is there", a > 0 && b > a);
  const sb = { S: { sessions: [] } };
  vm.runInNewContext(src.slice(a, src.indexOf("\n", b) + 1) + "\nthis.isAiName = isAiName; this.aiLabel = aiLabel; this.liveSessions = liveSessions; this.AI_NAME = AI_NAME;", sb);
  check("the display name is MINT AI", sb.AI_NAME === "MINT AI");
  for (const n of ["MINT AI", "MONI AI", "mint ai", "Moni AI", "moni-ai", "MINT AI [a1b2c3]", "MONI Bot"]) check(`"${n}" is the assistant`, sb.isAiName(n) === true);
  for (const n of ["MONI Agent OS", "Odoo 19 VPS setup", "mint", "", null]) check(`"${n}" is not the assistant`, sb.isAiName(n) === false);
  check("actors are shown by the new name", sb.aiLabel("moni-ai") === "MINT AI" && sb.aiLabel("MONI AI") === "MINT AI" && sb.aiLabel("amaraghy") === "amaraghy");
  sb.S.sessions = [{ name: "MINT AI", self: true }, { name: "MONI AI" }, { name: "MINT AI" }, { name: "MONI Agent OS" }];
  const live = sb.liveSessions().map((s) => s.name);
  check("a session carrying either name is never a delegation target", JSON.stringify(live) === '["MONI Agent OS"]', JSON.stringify(live));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
