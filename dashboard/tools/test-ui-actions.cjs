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
check("exactly the Phase 1 actions plus the three Tier-2 preferences", UA.names().sort().join() === ["call.end", "call.mute", "call.interrupt", "voice.mode", "sheet.open", "sheet.close", "view", "core.set", "reply.show", "reply.read", "decision.show", "settings.open", "page.open", "theme.set", "persona.set", "voice.set"].sort().join(), UA.names().join());
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

console.log("\nclosing a named panel (\"close the missions\", «اقفلي المهام»)");
check("sheet.close takes the panel it names (optional), and only a real one", UA.validate("sheet.close", { key: "missions" }).ok && UA.validate("sheet.close", { key: "missions" }).args.key === "missions" && !UA.validate("sheet.close", { key: "odoo" }).ok && !UA.validate("sheet.close", { key: "missions", mode: "live" }).ok);
check("  its toast names it", UA.toast("sheet.close", { key: "missions" }) === "Mint closed Missions" && UA.toast("sheet.close", {}) === "Mint closed the panel");
{
  const d = UA.tool().description;
  check("the tool gives the Arabic panel names (المهام، الميشنز، الجلسات، السيشنز، التكلفة، القرارات)", ["المهام", "الميشنز", "الجلسات", "السيشنز", "التكلفة", "القرارات"].every((w) => d.includes(w)));
  check("  and says closing a panel is sheet.close, never the call", /«اقفلي المهام», «اقفل الميشنز»[^.]*close that PANEL \(sheet\.close\), never the call/.test(d));
  check("  and does not offer «المحادثة» (the conversation) as a panel: that ends the call", !d.includes("المحادثة"));
}
{
  const page = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
  check("the page closes a named panel only if it is the one open", /if \(a\.key && a\.key !== wasC && a\.key !== "everything"\) return \{ ok: false, why: "that panel is not the one open" \};/.test(page));
  for (const f of ["voice-live.js"]) { // the front desk (voice-desk.js) is gone
    const src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
    check(`lib/${f}: the instructions say closing a panel is sheet.close, never ending the call`, /Closing a panel \(\\"close the missions\\", «اقفلي المهام», «اقفل الميشنز»\) is sheet\.close, never ending the call/.test(src));
  }
}

console.log("\nTier 2 (Phase 3): preferences, only after a confirm");
{
  const persona = require(path.join(ROOT, "lib", "voice-persona.js"));
  const voice = require(path.join(ROOT, "lib", "voice.js"));
  check("theme.set / persona.set / voice.set are tier 2, on the page", ["theme.set", "persona.set", "voice.set"].every((n) => UA.ACTIONS[n].tier === 2 && UA.ACTIONS[n].where === "page"));
  check("  every other action is tier 1", UA.names().filter((n) => !["theme.set", "persona.set", "voice.set"].includes(n)).every((n) => UA.ACTIONS[n].tier === 1));
  check("the personas are lib/voice-persona.js PRESETS plus learned", Object.keys(UA.PERSONAS).sort().join() === [...Object.keys(persona.PRESETS), "learned"].sort().join());
  check("the voices are lib/voice.js VOICES", Object.keys(UA.VOICE_NAMES).sort().join() === [...voice.VOICES].sort().join());
  check("validation: only listed values", UA.validate("theme.set", { theme: "dark" }).ok && !UA.validate("theme.set", { theme: "neon" }).ok && UA.validate("persona.set", { preset: "cairene_f" }).ok && !UA.validate("persona.set", { preset: "evil" }).ok && UA.validate("voice.set", { voice: "cedar" }).ok && !UA.validate("voice.set", { voice: "onyx" }).ok);
  check("the toast is a question, doneText the result", /\?/.test(UA.toast("voice.set", { voice: "cedar" })) && UA.doneText("voice.set", { voice: "cedar" }) === "The voice is now cedar" && UA.doneText("sheet.open", { key: "missions" }) === "Mint opened Missions");
  check("the tool takes theme / preset / voice, and says these need a confirm", ["theme", "preset", "voice"].every((k) => UA.tool().parameters.properties[k]) && /status \\?"confirm\\?"|status "confirm"/.test(UA.tool().description) && /never confirm for them/.test(UA.tool().description));
  check("fromTool keeps them", JSON.stringify(UA.fromTool({ action: "voice.set", voice: "cedar" })) === JSON.stringify({ action: "voice.set", args: { voice: "cedar" }, extra: [] }));
  const proto = fs.readFileSync(path.join(ROOT, "..", "moni-ai", "lib", "protocol.js"), "utf8");
  check("the supervisor's protocol takes exactly the same argument keys", proto.includes("const KEYS = " + JSON.stringify(UA.ARG_KEYS).replace(/,/g, ", ") + ";"));
}
console.log("\npage.open (M-5): another page of Mint OS, by a fixed key");
{
  const KEYS = ["os-overview", "agents", "agents-fleet", "agents-channels", "agents-addons", "agents-services", "os-services", "os-audit", "os-firewall", "manage-credentials", "manage-ssh-keys", "manage-devices", "manage-users", "manage-roles", "claude-memory", "claude-sessions", "claude-running", "guide", "account", "voice-settings", "command-center"];
  check("exactly the 21 allowlisted pages", Object.keys(UA.NAV_PAGES).sort().join() === KEYS.slice().sort().join(), Object.keys(UA.NAV_PAGES).join());
  check("tier 1, on the page, once per turn", UA.ACTIONS["page.open"].tier === 1 && UA.ACTIONS["page.open"].where === "page" && UA.ACTIONS["page.open"].once === true);
  check("a key only, never a URL or a path (stray fields are not carried)", UA.validate("page.open", { page: "os-audit" }).ok && !UA.validate("page.open", { page: "/audit" }).ok && !UA.validate("page.open", { page: "https://evil.example" }).ok && !UA.validate("page.open", {}).ok && JSON.stringify(UA.validate("page.open", { page: "os-audit", key: "x" }).args) === '{"page":"os-audit"}');
  check("every target is a same-site path with its permission (guide, account and your own devices need none)", Object.entries(UA.NAV_PAGES).every(([k, v]) => /^\/[a-z/-]*$/.test(v.url) && v.label && (v.perm === null ? ["guide", "account", "manage-devices"].includes(k) : /^[a-z.]+$/.test(v.perm))));
  check("navPage / navKeysFor follow the role", UA.navPage("os-audit").url === "/audit" && UA.navPage("nope") === null && UA.navKeysFor((p) => p === "os.view").join() === "os-overview,manage-devices,guide,account");
  check("the toast names the page", UA.toast("page.open", { page: "os-audit" }) === "Mint opened the audit log");
  const L = UA.limiter();
  check("once per turn", L.take("p1", "page.open", 1) === null && /already done/.test(L.take("p1", "page.open", 2)));
  const t = UA.tool();
  check("the tool's page enum is settings.open's pages plus these keys", t.parameters.properties.page.enum.slice().sort().join() === [...new Set([...Object.keys(UA.PAGES), ...KEYS])].sort().join());
  check("  and the description says what page.open is for", /page\.open/.test(t.description));
  const page = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
  check("the Command Center checks the role (data-pages) before moving", /case "page\.open"/.test(page) && /data-pages|dataset\.pages/.test(page));
  check("the Command Center page carries data-pages", /data-pages=/.test(fs.readFileSync(path.join(ROOT, "lib", "views-moniai.js"), "utf8")));
  for (const f of ["voice-live.js"]) check(`lib/${f} tells the voice about page.open`, /page\.open/.test(fs.readFileSync(path.join(ROOT, "lib", f), "utf8")));
  check("the supervisor's copy is byte-identical", fs.readFileSync(path.join(ROOT, "public", "ui-actions.js"), "utf8") === fs.readFileSync(path.join(ROOT, "..", "moni-ai", "lib", "ui-actions.js"), "utf8"));
}

console.log("\nthe MCP catalog (ui_actions_list) and ui_do's stable schema");
{
  const c = UA.catalog();
  check("the catalog lists every action, with what it does", c.actions.map((a) => a.action).join() === UA.names().join() && c.actions.every((a) => a.what));
  check("  needs_confirm is exactly tier 2", c.actions.every((a) => a.needs_confirm === (UA.ACTIONS[a.action].tier === 2)));
  const bad = [];
  c.actions.forEach((a) => Object.entries(a.args).forEach(([k, spec]) => Object.keys(spec.values).forEach((v) => { const o = {}; o[k] = k === "on" ? true : v; if (!UA.validate(a.action, o).ok) bad.push(a.action + " " + k + "=" + v); })));
  check("  every value it lists is accepted by validate()", bad.length === 0, bad.join(", "));
  const noArgs = c.actions.filter((a) => !Object.keys(a.args).length).map((a) => a.action);
  check("  an action it lists without arguments validates with none", noArgs.every((n) => UA.validate(n, {}).ok), noArgs.join());
  check("  a required argument it lists is really required", c.actions.every((a) => Object.entries(a.args).every(([k, spec]) => !spec.required || !UA.validate(a.action, {}).ok)));
  const sch = UA.stableSchema();
  check("ui_do's schema: action a plain string, every argument key, no enum", sch.properties.action.type === "string" && !/enum/.test(JSON.stringify(sch)) && Object.keys(sch.properties).join() === ["action"].concat(UA.ARG_KEYS).join() && sch.additionalProperties === false);
}

console.log("\nTier 3: never by voice or AI -- no action names at all");
check("nothing about keys, users, roles, 2FA, rules, watchers, voice mode, budget, orders, restart, deploy, approve", !UA.names().some((n) => /key|user|role|totp|2fa|password|rule|watcher|desk|budget|order|restart|deploy|approve|deny|fresh|gate|credential|service|firewall/.test(n)), UA.names().join());

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
