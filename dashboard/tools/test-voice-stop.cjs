/**
 * "Stop listening", said aloud: the spoken command that closes the mic.
 *
 *     node dashboard/tools/test-voice-stop.cjs
 *
 * The matcher (public/voice-stop.js) is required as it ships -- the same file
 * the browser loads and the server requires for the front desk -- and run on
 * English, Egyptian Arabic and mixed utterances, and on sentences that merely
 * contain the words, which must still be sent. Then the wiring: every page
 * loads it before console.js and moni-ai.js, the Command Center and the chat's
 * live mode check it before sending, and the desk ends the turn on it. The
 * flow itself (listening stops, nothing is sent) is run in
 * test-voice-stream.cjs, against the Voice module.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const VoiceStop = require(path.join(ROOT, "public", "voice-stop.js"));

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
const misses = (list) => list.filter((s) => !VoiceStop.heard(s));
const hits = (list) => list.filter((s) => VoiceStop.heard(s));

/* ---- normalising ---- */
check("case and punctuation go", VoiceStop.norm("  Stop, LISTENING!!  ") === "stop listening");
check("hyphens join words with a space", VoiceStop.norm("Hands-free off.") === "hands free off");
check("Arabic: alef forms become ا", VoiceStop.norm("أقفل الإستماع آ ٱ") === "اقفل الاستماع ا ا");
check("Arabic: ى becomes ي and ة becomes ه", VoiceStop.norm("الجلسة المباشرة على") === "الجلسه المباشره علي");
check("Arabic: diacritics and tatweel go", VoiceStop.norm("وَقِّفْ الاسـتماع") === "وقف الاستماع");
check("Arabic punctuation goes (، ؟ ؛)", VoiceStop.norm("خلاص، اقفل الاستماع؟") === "خلاص اقفل الاستماع");
check("the article written onto an English word is split off", VoiceStop.norm("اقفل الـlive session") === "اقفل ال live session");
check("nothing in, nothing out", VoiceStop.norm(null) === "" && VoiceStop.norm(undefined) === "" && VoiceStop.norm("...") === "");

/* ---- English ---- */
const EN = [
  "stop listening", "Stop listening.", "STOP LISTENING!", "Stop live.", "stop live", "Close listening.",
  "Close the live session.", "close live session", "End the live session", "Stop the live session.",
  "Exit live mode.", "Turn off the mic.", "Switch off the microphone", "Mic off.", "Hands-free off.",
  "Stop hands-free.", "Pause listening.", "Stop listen.",
  "Okay, stop listening.", "Stop listening, please.", "Please stop listening now.", "Mint, stop listening.",
  "Hey Mint, close the live session.", "Stop listening for now, thanks.", "You can stop listening.",
];
check("English: every form of the command matches", misses(EN).length === 0, misses(EN).join(" | "));

/* ---- Egyptian Arabic, and Arabic with English words in it ---- */
const AR = [
  "وقف الاستماع", "وقّف الاستماع", "اوقف الاستماع", "اقفل الاستماع", "أقفل الإستماع", "قفل الاستماع",
  "اقفل ال live session", "اقفل الـlive session", "اقفل الـ live session.", "اقفل اللايف", "اقفل اللايف سيشن",
  "اقفل ال لايف سيشن", "وقف اللايف", "اقفل المايك", "اطفي المايك", "بطّل تسمع", "بطل الاستماع",
  "خلاص، اقفل الاستماع", "اقفل الاستماع من فضلك", "وقف الاستماع لو سمحت", "يا مينت وقف الاستماع",
  "وقف الاستماع يا مينت.", "اقفل الاستماع دلوقتي", "اقفل الجلسة المباشرة",
];
check("Arabic: every form of the command matches", misses(AR).length === 0, misses(AR).join(" | "));

/* ---- the phrases the administrator named ---- */
const NAMED = ["وقف الاستماع", "اقفل الاستماع", "اقفل ال live session", "stop listening", "stop live", "close listening"];
check("the administrator's own phrases are in the list, word for word", NAMED.every((p) => VoiceStop.phrases().indexOf(VoiceStop.norm(p)) >= 0));
check("the list is already normalised (what norm() makes of a phrase is itself)", VoiceStop.phrases().every((p) => VoiceStop.norm(p) === p), VoiceStop.phrases().filter((p) => VoiceStop.norm(p) !== p).join(" | "));

/* ---- not the command: sent as said ---- */
const NOT = [
  "why did the service stop listening on port 80",
  "Why did the service stop listening on port 80?",
  "the service stopped listening",
  "stop listening to port 80",
  "nginx should stop listening on port 8080 after the change",
  "don't stop listening",
  "can you check why it keeps stopping to listen",
  "stop", "Stop.", "close", "end", "listening", "live session",
  "stop the dashboard", "close the session", "end the session", "stop the service", "close the terminal",
  "stop the turn", "stop talking", "cancel that",
  "okay", "please", "mint", "thanks", "okay please", "يا مينت", "خلاص", "",
  "وقف", "اقفل", "وقف السيرفس", "اقفل البورت", "اقفل الجلسه",
  "ليه السيرفس وقف الاستماع على بورت 80", "هو ليه الخدمة بطلت تسمع على البورت",
  "stop listening stop listening stop listening stop listening stop listening",
];
check("sentences that merely contain the words are not the command", hits(NOT).length === 0, hits(NOT).join(" | "));
check("null and non-strings are not the command", !VoiceStop.heard(null) && !VoiceStop.heard(undefined) && !VoiceStop.heard(80));

/* ---- asked politely: "can you stop listening", "ممكن تقفل الاستماع" ---- */
const ASKED_EN = [
  "Okay, so, can you stop listening now?", // said to the live page, 2026-09-29, and missed
  "okay so can you stop listening now", "Can you stop listening?", "Could you stop listening, please?",
  "Would you close the live session?", "Will you stop live?", "Can you please stop listening.",
  "Could you please close the live session?", "I want you to stop listening.", "I need you to turn off the mic.",
  "Mint, can you stop listening, please?", "Hey Mint, could you stop listening for now, thanks.", "Can you mic off?",
];
check("English requests before the command match, with the usual polite words around them", misses(ASKED_EN).length === 0, misses(ASKED_EN).join(" | "));
const ASKED_AR = [
  "ممكن تقفل الاستماع دلوقتي", "ممكن تقفل الاستماع؟", "ممكن توقف الاستماع", "ممكن تـقفل الاستماع", "ممكن تـ قفل الاستماع",
  "ممكن اقفل الاستماع", "عايزك تقفل اللايف", "عاوزك تقفل المايك", "محتاجك تبطل تسمع", "يا ريت توقف الاستماع",
  "ياريت تقفل ال live session", "خلاص، ممكن تقفل الاستماع يا مينت", "طيب عايزك توقف اللايف سيشن دلوقتي",
];
check("Egyptian Arabic requests (ممكن / عايزك / يا ريت, the second-person verb) match", misses(ASKED_AR).length === 0, misses(ASKED_AR).join(" | "));
const NOT_ASKED = [
  "can you tell me why nginx stopped listening", "can you stop the dashboard", "can you close the session",
  "can you not stop listening", "can you", "could you please", "i want you to", "ممكن", "عايزك", "يا ريت",
  "can you can you stop listening", "can you stop listening on port 80", "could you check whether nginx will stop listening",
  "ممكن تقفل البورت", "عايزك تقولي ليه nginx وقف الاستماع", "ممكن تقفل الجلسه",
  "can you please please please stop listening to port 80 on the old box now",
];
check("a request for anything else, or with more in it, is not the command", hits(NOT_ASKED).length === 0, hits(NOT_ASKED).join(" | "));
check("the second-person verbs need a request in front of them", !VoiceStop.heard("تقفل الاستماع") && !VoiceStop.heard("توقف الاستماع") && VoiceStop.heard("ممكن تقفل الاستماع"));
check("the 9-word cap still holds with a request", !VoiceStop.heard("okay so mint can you please stop listening for now thanks") && VoiceStop.heard("okay so can you please stop listening now"));
check("the request list is the one asked for", ["can you", "could you", "would you", "will you", "can you please", "could you please", "i want you to", "i need you to", "ممكن", "ممكن ت", "عايزك", "عاوزك", "محتاجك", "يا ريت"].every((w) => VoiceStop.requests().indexOf(w) >= 0));
check("  and every request and second-person phrase is already normalised", VoiceStop.requests().concat(VoiceStop.asked()).every((p) => VoiceStop.norm(p) === p));

/* ---- ending the call (2026-09-29: "Now end the conversation, please." became a turn) ---- */
const END_EN = [
  "Perfect, thank you so much. Now end the conversation, please.", // said in live mode, 2026-09-29, and missed
  "perfect thank you so much now end the conversation please", "End the conversation.", "end the call", "End the call, please.",
  "Close the call.", "Stop the conversation.", "Finish the conversation.", "Hang up.", "Hang up, please.", "hang up now",
  "Close the live conversation.", "End the voice chat.", "Stop the voice chat.", "OK thanks, end the call.",
  "Great, thanks, hang up now.", "Thank you very much, end the call please.", "Can you end the conversation, please?",
  "Could you hang up the call?", "Thanks a lot. Now end this call.",
];
check("English: ending the call (conversation / call / live conversation / voice chat, and hang up), with pleasantries in front", misses(END_EN).length === 0, misses(END_EN).join(" | "));
const END_AR = [
  "اقفل المكالمة", "اقفل المكالمة لو سمحت", "انهي المحادثة", "وقف المكالمة", "سكر الكول", "اقفل الكلام ده",
  "ممكن تقفل المكالمة", "ممكن تقفلي المكالمة", "ممكن تنهي المحادثة", "عايزك تقفلي الكول", "يا ريت توقفي المكالمة",
  "اقفلي المكالمة", "وقفي الكلام ده", "بطلي الكلام ده", "سكري المكالمة", "انهي المحادثة من فضلك",
  "كفاية كده", "خلاص كده شكرا", "طيب، كفاية كده", "تمام شكرا، اقفل المكالمة", "شكراً جداً، كفاية كده", "ممكن تبطلي الكلام ده",
];
check("Egyptian Arabic: ending the call, masculine and feminine imperatives, «كفاية كده», «خلاص كده شكرا»", misses(END_AR).length === 0, misses(END_AR).join(" | "));
const NOT_END = [
  "end the conversation with the supplier in Odoo", "close the call log", "end the call with the supplier",
  "stop the call recording", "close the conversation window", "can you end the conversation with the supplier",
  "اقفل المكالمة مع العميل", "انهي المحادثة مع المورد", "اقفل الكول بتاع العميل", "ليه المكالمة وقفت",
  "that's all", "that is all", "we're done for now", "we are done for now", "I think we're done", "thank you", "perfect",
  "thank you so much", "perfect, thank you", "كده", "شكرا", "تمام", "خلاص", "the call", "the conversation", "hang",
  "why did the call end", "did you end the conversation", "hang up the logs", "كفاية", "كفاية كده من التقرير ده",
];
check("not ending the call: a qualifier, a question, pleasantries alone, \"that's all\"", hits(NOT_END).length === 0, hits(NOT_END).join(" | "));
check("pleasantries do not count toward the cap, the rest still does", VoiceStop.heard("Perfect, thank you so much. Now end the conversation, please.") && !VoiceStop.heard("okay so mint can you please stop listening for now thanks") && !VoiceStop.heard("perfect thank you so much now please end the conversation with the supplier in odoo today"));
check("  and every pleasantry is already normalised", VoiceStop.pleasantries().every((p) => VoiceStop.norm(p) === p));

/* ---- the wiring ---- */
const views = require(path.join(ROOT, "lib", "views-moniai.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const html = views.page({ csrf: "t", user: { name: "a", perm: rbac.actor({ permissions: ["*"] }) }, voice: { configured: true, voice: "marin", model: "gpt-realtime-mini", manage: true } });
const at = (f) => html.search(new RegExp('<script src="/static/' + f.replace(".", "\\.") + '\\?v=[^"]+" defer></script>'));
check("every page loads voice-stop.js, before console.js and moni-ai.js", at("voice-stop.js") > 0 && at("voice-stop.js") < at("console.js") && at("console.js") < at("moni-ai.js"));
check("the file is a browser global and a CommonJS module, and pure", /^var VoiceStop = \(function \(\) \{/m.test(fs.readFileSync(path.join(ROOT, "public", "voice-stop.js"), "utf8")) &&
  !/document|window|localStorage|fetch\(/.test(fs.readFileSync(path.join(ROOT, "public", "voice-stop.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));

const client = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
const direct = client.slice(client.indexOf("function transcribeAndSend("), client.indexOf("function openStream("));
check("Command Center, direct path: checked after the transcript, before it is sent", /if \(isStopCommand\(said\)\) return stoppedByVoice\(said\);/.test(direct) && direct.indexOf("isStopCommand(said)") < direct.indexOf("send(said"));
const desk = client.slice(client.indexOf("function deskSend("), client.indexOf("function deskSummary("));
check("Command Center, front desk: the desk's flag or the words themselves stop it", /ev\.stop \|\| \(ev\.text && isStopCommand\(ev\.text\)\)/.test(desk));
const sbv = client.slice(client.indexOf("function stoppedByVoice("), client.indexOf("function recording("));
check("  stopping by voice is the mic button's stop(), with a visible note and nothing spoken", /\bstop\(\);/.test(sbv) && /Stopped listening\./.test(sbv) && /toast\(/.test(sbv) && !/enqueue\(|say\(/.test(sbv));
check("  without voice-stop.js loaded, nothing is ever the command", /return !!\(window\.VoiceStop && window\.VoiceStop\.heard\(said\)\);/.test(client));

const chat = fs.readFileSync(path.join(ROOT, "public", "console.js"), "utf8");
const liveSend = chat.slice(chat.indexOf("function transcribeAndSend(blob)"), chat.indexOf("function recording(want)"));
check("the chat's live mode checks it too, before sending", /window\.VoiceStop && window\.VoiceStop\.heard\(said\)\) return stoppedByVoice\(\);/.test(liveSend) && liveSend.indexOf("VoiceStop") < liveSend.indexOf("send(said)"));
check("  and stops live mode as its button does, with a note", /function stoppedByVoice\(\) \{\s*stop\(\);\s*status\.textContent = "stopped listening";/.test(chat));

const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const route = server.slice(server.indexOf('app.post("/mint-ai/api/desk/turn"'), server.indexOf('app.post("/mint-ai/api/desk/summary"'));
check("the server requires the same file", /const voiceStop = require\("\.\/public\/voice-stop\.js"\);/.test(server));
check("the desk ends the turn on it: heard with stop, done, and never desk().turn", /const stop = !!heard && voiceStop\.heard\(heard\);/.test(route) &&
  /type: "heard"[^\n]*stop: stop \|\| undefined/.test(route) && /if \(stop\) \{[^}]*\}\);\s*out\.write\(\{ type: "done", asked: \[\], lines: 0, stop: true[^\n]*\}\);\s*return out\.end\(\);/.test(route) &&
  route.indexOf("voiceStop.heard(heard)") < route.indexOf("desk().turn("));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
