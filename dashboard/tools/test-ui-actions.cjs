#!/usr/bin/env node
"use strict";
/**
 * UI control, Phase 1: the shared allowlist (public/ui-actions.js) -- the
 * same file the server requires and the page loads.
 *
 *     node dashboard/tools/test-ui-actions.cjs
 */
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const UA = require(path.join(ROOT, "public", "ui-actions.js"));
const ML = require(path.join(ROOT, "public", "cc-logic.js"));

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

console.log("the allowlist");
check("exactly the Phase 1 actions", UA.names().sort().join() === ["call.end", "call.mute", "call.interrupt", "voice.mode", "sheet.open", "sheet.close", "view", "core.set", "reply.show", "reply.read", "decision.show", "settings.open"].sort().join(), UA.names().join());
check("all Tier 1", UA.names().every((n) => UA.ACTIONS[n].tier === 1));
const TIER3 = ["approve", "deny", "approval.approve", "decision.approve", "decision.deny", "credentials.set", "key.set", "users.add", "rules.add", "gate.off", "restart", "deploy", "voice.set", "theme.set", "persona.set", "settings.set", "call.unmute", "eval", "navigate"];
check("no Tier-2 or Tier-3 name exists (approve, deny, keys, users, rules, gate, restart, deploy, settings values, unmute...)", TIER3.every((n) => !UA.validate(n, {}).ok), TIER3.filter((n) => UA.validate(n, {}).ok).join());
check("nothing named like an approval at all", !UA.names().some((n) => /approv|deny|confirm|key|user|rule|gate|restart|deploy|unmute/.test(n)));
check("the sheets are the dock's own (cc-logic) plus everything", Object.keys(UA.SHEETS).sort().join() === ML.sheetKeys().concat(["everything"]).sort().join());
check("sheet.open takes a known sheet only", UA.validate("sheet.open", { key: "missions" }).ok && !UA.validate("sheet.open", { key: "credentials" }).ok && !UA.validate("sheet.open", {}).ok);
check("the mic can be muted, never unmuted", UA.validate("call.mute", {}).ok && UA.validate("call.mute", { on: true }).ok && !UA.validate("call.mute", { on: false }).ok && /never unmuted/.test(UA.validate("call.mute", { on: false }).why));
check("voice.mode: ptt, handsfree or live", ["ptt", "handsfree", "live"].every((m) => UA.validate("voice.mode", { mode: m }).ok) && !UA.validate("voice.mode", { mode: "off" }).ok);
check("core.set: A, B or C", UA.validate("core.set", { core: "B" }).ok && !UA.validate("core.set", { core: "D" }).ok);
check("settings.open: a fixed list of pages, never a URL", UA.validate("settings.open", { page: "voice" }).ok && !UA.validate("settings.open", { page: "/credentials/keys" }).ok && !UA.validate("settings.open", { page: "https://evil.example" }).ok && UA.pageUrl("voice") === "/credentials/openai-voice" && UA.pageUrl("keys") === null);
check("  and none of them is a credentials-changing page", Object.values(UA.PAGES).every((p) => !/keys|totp|users|roles|rules/.test(p.url)));
check("an action without arguments refuses stray ones", UA.validate("sheet.close", {}).ok && !UA.validate("sheet.close", { key: "x" }).ok);
check("the toast says what Mint did", UA.toast("sheet.open", { key: "missions" }) === "Mint opened Missions" && UA.toast("call.end") === "Mint ended the call" && /approving it is yours/.test(UA.toast("decision.show")));

console.log("\nthe tool the voice sees");
const t = UA.tool();
check("one flat tool, ui_action, with the action as an enum", t.name === "ui_action" && t.parameters.properties.action.enum.join() === UA.names().join() && t.parameters.additionalProperties === false);
check("  its description says approving stays the administrator's click, and no unmute", /cannot approve, deny or confirm/.test(t.description) && /never unmute/.test(t.description));
check("fromTool splits action and args, and names stray fields", JSON.stringify(UA.fromTool({ action: "sheet.open", key: "dec" })) === JSON.stringify({ action: "sheet.open", args: { key: "dec" }, extra: [] }) && UA.fromTool({ action: "view", url: "/x" }).extra.join() === "url");

console.log("\nrate limits");
{
  const L = UA.limiter();
  const r = [];
  for (let i = 0; i < 7; i++) r.push(L.take("t1", "sheet.open", 1000 + i));
  check("at most 6 per turn", r.slice(0, 6).every((x) => x === null) && /one turn/.test(r[6]));
  check("call.end and settings.open once per turn", L.take("t2", "call.end", 2000) === null && /already done/.test(L.take("t2", "call.end", 2001)) && L.take("t3", "settings.open", 2002) === null && !!L.take("t3", "settings.open", 2003));
  const M = UA.limiter();
  let last = null;
  for (let i = 0; i < 21; i++) last = M.take("turn" + i, "sheet.open", 5000 + i);
  check("at most 20 a minute", /this minute/.test(last));
  check("  and fine again a minute later", M.take("later", "sheet.open", 5000 + 61000) === null);
}

console.log("\nclaims the guard holds to a real ui_action");
check("English: \"I opened Missions\", \"I've ended the call\", \"I muted the microphone\"", UA.claims("i opened missions") && UA.claims("i've ended the call") && UA.claims("i muted the microphone"));
check("Arabic: «فتحتلك», «قفلتلك», «كتمت»", UA.claims("فتحتلك ال missions") && UA.claims("قفلتلك المكالمه") && UA.claims("كتمت المايك"));
check("not a claim: \"I can open Missions\", \"want me to open it?\"", !UA.claims("i can open missions") && !UA.claims("want me to open it"));

console.log("\nthe file");
const src = fs.readFileSync(path.join(ROOT, "public", "ui-actions.js"), "utf8");
check("pure (no DOM, no fetch, no storage) and loaded by the page before moni-ai.js", !/document|localStorage|fetch\(|XMLHttpRequest/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")) && /"ui-actions\.js", "moni-ai\.js"/.test(fs.readFileSync(path.join(ROOT, "lib", "views-moniai.js"), "utf8")));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
