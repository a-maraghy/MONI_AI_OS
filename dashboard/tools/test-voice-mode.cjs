/**
 * The Command Center's voice mode: push to talk by default, hands-free still
 * selectable, the choice remembered per browser.
 *
 *     node dashboard/tools/test-voice-mode.cjs
 *
 * The server-rendered frame (lib/views-moniai.js) and the client
 * (public/moni-ai.js): the pure helper is cut out and run, the wiring is
 * checked in the source. The behaviour in a real browser is checked by the
 * Playwright pass recorded in the step-7 report.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const views = require(path.join(ROOT, "lib", "views-moniai.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}

const admin = rbac.actor({ permissions: ["*"] });
const html = views.page({ csrf: "t", user: { name: "a", perm: admin }, voice: { configured: true, voice: "marin", model: "gpt-realtime-mini", manage: true } });
const noKey = views.page({ csrf: "t", user: { name: "a", perm: admin }, voice: { configured: false, manage: true } });

/* ---- the frame ---- */
// The mode lives under the composer: "Push to talk ▾" opens the voice menu
// (push to talk / hands-free, read aloud, the core), built by moni-ai.js.
const toggle = (/<button[^>]*id="cc-vm"[^>]*>[\s\S]*?<\/button>/.exec(html) || [])[0] || "";
check("the voice-mode button sits under the composer, after the mic and the input", !!toggle && html.indexOf('id="cc-c-mic"') < html.indexOf('id="cc-input"') && html.indexOf('id="cc-input"') < html.indexOf('id="cc-vm"'));
check("it renders as push to talk (the default), so nothing flips on load", /<span id="cc-mic-mode" data-mode="ptt">Push to talk<\/span>/.test(toggle));
check("it opens a menu that switches it", /aria-haspopup="menu"/.test(toggle) && /data-vmode="ptt"/.test(client0()) && /data-vmode="handsfree"/.test(client0()) && /Voice\.setMode\(/.test(client0()));
check("the voice bar shows the active mode", /id="cc-vb-mode"[^>]*>Push to talk</.test(html));
check("without a key the menu's modes are disabled and Space is not offered", /\(ready \? "" : " disabled"\)/.test(client0()) && !/<kbd>Space<\/kbd>/.test(noKey));
check("no inline style or handler on the new markup", !/\sstyle\s*=|\son[a-z]+\s*=/i.test(toggle));
check("hold-to-talk hint is still there", /<kbd>Space<\/kbd> hold to talk/.test(html));
function client0() { return fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8"); }
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
check("ids stay unique", ids.length === new Set(ids).size);

/* ---- the client ---- */
const client = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
function cut(name) {
  const start = client.indexOf("function " + name + "(");
  if (start < 0) throw new Error("no function " + name);
  let depth = 0;
  for (let i = client.indexOf("{", start); i < client.length; i++) {
    if (client[i] === "{") depth++;
    else if (client[i] === "}" && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error("unbalanced " + name);
}
const sb = {};
vm.runInNewContext(cut("voiceModeFrom"), sb);
check("nothing remembered: push to talk", sb.voiceModeFrom(null) === "ptt" && sb.voiceModeFrom(undefined) === "ptt" && sb.voiceModeFrom("") === "ptt");
check("hands-free remembered: hands-free", sb.voiceModeFrom("handsfree") === "handsfree");
check("anything else: push to talk", sb.voiceModeFrom("HANDSFREE") === "ptt" && sb.voiceModeFrom("ptt") === "ptt" && sb.voiceModeFrom("<x>") === "ptt");

const lsLines = client.split("\n").filter((l) => /localStorage/.test(l));
check("every localStorage access is inside try/catch", lsLines.length >= 2 && lsLines.every((l) => /try \{[^}]*localStorage[^}]*\} catch/.test(l)), lsLines.join("\n"));
check("the mode is remembered under one key", /MODE_KEY = "moni-voice-mode"/.test(client) && /localStorage\.getItem\(MODE_KEY\)/.test(client) && /localStorage\.setItem\(MODE_KEY, mode\)/.test(client));
check("in push to talk a click on the mic does not open hands-free", /cMic\.addEventListener\("click", function \(\) \{\s*if \(mode === "ptt"\) return;/.test(client));
check("in push to talk the mic is held (pointerdown, released anywhere)", /cMic\.addEventListener\("pointerdown"[\s\S]{0,200}mode !== "ptt"/.test(client) && /window\.addEventListener\("pointerup", up\)/.test(client));
check("switching to push to talk stops a running hands-free session", /if \(mode === "ptt" && api_\.on\) stop\(\);/.test(client));
check("Space and the mic share one push-to-talk path", (client.match(/pttDown\(/g) || []).length >= 3 && (client.match(/pttUp\(\)/g) || []).length >= 3);
check("the voice bar's mic sends a push-to-talk recording instead of dropping it", /\$\("cc-vb-stop"\)\.addEventListener\("click", function \(\) \{\s*if \(ptt\) return pttUp\(\);/.test(client));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
