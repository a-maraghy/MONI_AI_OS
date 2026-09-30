/**
 * The Command Center's voice since 2026-09-30: live conversation only, on or
 * off for everyone (Settings ▸ Voice), for those whose role includes voice.use.
 * No push to talk, no hands-free, no front desk, no mode to pick.
 *
 *     node dashboard/tools/test-voice-mode.cjs
 *
 * The server-rendered frame (lib/views-moniai.js, lib/ui.js dockMarkup) and
 * the client (public/moni-ai.js, public/mint-dock.js), checked in the source.
 * The server side (the switch, the refusals, the migration) is
 * test-voice-settings.cjs.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const views = require(path.join(ROOT, "lib", "views-moniai.js"));
const ui = require(path.join(ROOT, "lib", "ui.js"));
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
const page = (voice) => views.page({ csrf: "t", user: { name: "a", perm: admin }, voice });
const on = page({ configured: true, voice: "marin", model: "gpt-realtime-2.1-mini", manage: true, on: true, use: true, live: true });
const off = page({ configured: true, voice: "marin", model: "gpt-realtime-2.1-mini", manage: true, on: false, use: true, live: false });
const noUse = page({ configured: true, voice: "marin", model: "gpt-realtime-2.1-mini", manage: false, on: true, use: false, live: false });
const noKey = page({ configured: false, manage: true, on: true, use: true, live: false });

/* ---- the frame ---- */
const mic = (/<button[^>]*id="cc-c-mic"[^>]*>/.exec(on) || [])[0] || "";
check("voice on: the mic starts a live conversation", /title="Start a live conversation"/.test(mic) && /aria-label="Start a live conversation"/.test(mic));
check("  the hint: click the mic to talk · Esc ends", /<span class="kb" id="cc-kb-space">click the mic to talk · <kbd>Esc<\/kbd> ends<\/span>/.test(on));
check("  the voice menu button says Live · the voice", /<span id="cc-mic-mode" data-mode="live">Live · marin<\/span>/.test(on));
check("  the voice bar's tag says Live; no Direct / Front desk tag, no trial", /id="cc-vb-mode">Live</.test(on) && !/cc-voice-mode|Front desk|Direct · MINT AI|trial/i.test(on));
check("  read-aloud is there: the toggle and the reply's Read aloud", /id="cc-speak-toggle"/.test(on) && /id="cc-reply-read"/.test(on));
check("  no push to talk anywhere: no hold-to-talk hint, no send-what-you-said button", !/hold to talk|Hold to talk|Push to talk|push to talk|id="cc-vb-stop"/.test(on));
check("  the page may go live (data-voice-live) and is ready (data-voice-ready)", /data-voice-live="1"/.test(on) && /data-voice-ready="1"/.test(on) && !/data-voice-desk/.test(on));
for (const [name, html] of [["voice off", off], ["no voice.use", noUse], ["no key", noKey]]) {
  check(`${name}: no mic, no read-aloud, no live, no voice hint`, !/id="cc-c-mic"/.test(html) && !/id="cc-speak-toggle"/.test(html) && !/id="cc-reply-read"/.test(html) && /data-voice-live=""/.test(html) && /data-voice-ready=""/.test(html) && !/click the mic to talk/.test(html));
}
check("voice off, for a manager: a note that links to Settings ▸ Voice", /voice is off: <a href="\/mint-ai\/settings\/voice">switch it on in Settings ▸ Voice<\/a>/.test(off));
check("no voice.use: not even the note", !/cc-voice-off/.test(noUse));
check("the voice menu and the core switch stay (the core is not voice)", /id="cc-vm"/.test(off) && /id="cc-vm"/.test(noUse));
const ids = [...on.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
check("ids stay unique", ids.length === new Set(ids).size);
check("no inline style or handler on the voice markup", !/<button[^>]*id="cc-c-mic"[^>]*\s(style|on[a-z]+)\s*=/i.test(on));

/* ---- the dock on other pages ---- */
const perm = { can: () => true, canDash: () => true };
const dockOn = ui.dockMarkup("t", perm, {});
const dockOff = ui.dockMarkup("t", perm, { noVoice: true });
check("the dock's mic starts a live conversation", /id="md-mic" aria-label="Start a live conversation"/.test(dockOn) && /the mic starts a live call/.test(dockOn) && !/hold to talk/i.test(dockOn));
check("  and is not there when voice is off for the viewer", !/id="md-mic"/.test(dockOff) && !/live call/.test(dockOff));

/* ---- the client ---- */
const client = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
check("no voice mode left: no MODE_KEY, voiceModeFrom, push to talk, hands-free, desk", !/MODE_KEY|voiceModeFrom|pttDown|pttUp|handsfree|data-vmode|desk\/turn|desk\/summary|deskTurns|DESK\b/.test(client));
check("the mic starts and ends a live call", /if \(LIVE_OK && e\.target\.closest\("#cc-c-mic"\)\) \{ e\.stopPropagation\(\); e\.preventDefault\(\); return LiveUI\.active \? liveStop\(\) : liveStart\(\); \}/.test(client));
check("no key starts a call: Space and Esc act only while one is on", /if \(!LiveUI\.active \|\| e\.repeat \|\| liveTyping\(document\.activeElement\)\) return;/.test(client));
check("the voice menu: Live · voice, Speakers / Headphones, Read replies aloud, Voice settings, the core, Voice usage", /"<span>Live · " \+ esc\(VOICE \|\| "voice"\)/.test(client) && /data-dx="speakers"/.test(client) && /data-dx="full"/.test(client) && /data-vread/.test(client) && /href="\/mint-ai\/settings\/voice">Voice settings</.test(client) && /data-core-set=/.test(client) && /Voice usage/.test(client));
check("  with voice off it says so, and keeps the core and the spend", /"Voice is off\."/.test(client));
check("?call=1 (the dock's mic on another page) starts the call once and leaves the address", /q\.get\("call"\) !== "1"/.test(client) && /q\.delete\("call"\)/.test(client) && /history\.replaceState/.test(client) && /setTimeout\(liveStart, 0\)/.test(client));
check("call.* and voice.set are refused on the page while voice is off", /if \(\(\/\^call\\\.\/\.test\(v\.action\) \|\| v\.action === "voice\.set"\) && !READY\) return \{ ok: false, why: "voice is off" \};/.test(client));
check("read aloud is remembered per browser (mint-read-aloud), in a guarded way", /READ_KEY = "mint-read-aloud"/.test(client));
const lsLines = client.split("\n").filter((l) => /localStorage/.test(l));
check("every localStorage access is inside try/catch", lsLines.length >= 2 && lsLines.every((l) => /try \{[^}]*localStorage[^}]*\} catch/.test(l)), lsLines.join("\n"));
const dock = fs.readFileSync(path.join(ROOT, "public", "mint-dock.js"), "utf8");
check("the dock's mic goes to the Command Center with this page in its frame and call=1; in the shell it toggles the call", /"\/mint-ai\?at=" \+ encodeURIComponent\(here\) \+ "&call=1"/.test(dock) && /window\.__mintLive/.test(dock) && /L\.toggle\(\)/.test(dock));
const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const shell = fs.readFileSync(path.join(ROOT, "public", "mint-shell.js"), "utf8");
check("no Space-held-to-talk bridge from a framed page", !/mint: "space"/.test(app) && !/m\.mint === "space"/.test(shell));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
