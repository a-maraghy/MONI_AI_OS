#!/usr/bin/env node
"use strict";
/**
 * The voice guards in Arabic (Phase 0 of M-3, 2026-09-29): lib/voice-arabic.js
 * and what it gives the desk's output guard (lib/voice-desk.js) and the
 * transcript guard (lib/voice-guard.js). Pure: no network, no OpenAI.
 *
 *   NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-voice-arabic.cjs
 *
 * Every rule is tested both ways: the Arabic (Egyptian and MSA) or mixed
 * sentence that must be cut, and the one next to it that must be spoken.
 * The first five are the offline probes of 2026-09-29, which all passed the
 * English-only guard.
 */

const path = require("path");

const ROOT = path.join(__dirname, "..");
const ar = require(path.join(ROOT, "lib", "voice-arabic.js"));
const desk = require(path.join(ROOT, "lib", "voice-desk.js"));
const guard = require(path.join(ROOT, "lib", "voice-guard.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 500) : ""));
  }
}
function section(t) {
  console.log("\n" + t);
}

// A snapshot like the real one, as the desk sees it (lower-cased JSON).
const SNAP = JSON.stringify({
  machine: { disk: { used_percent: 41, free_gb: 156.2 }, memory: { used_percent: 62 } },
  services: { running: 3, tracked: 4, failed: ["moni-agent@admin"], list: [{ name: "odoo", state: "running" }, { name: "nginx", state: "running" }] },
  missions: { list: [{ ref: "M-7", steps: [{ n: 1, title: "Collect uptime", status: "done" }] }] },
  sessions: { live: 3 },
});
const ctx = (extra) => ({ numbers: desk.numberSet([SNAP]), snapshotText: SNAP.toLowerCase(), grounded: true, replied: false, replyText: "", ...(extra || {}) });
const said = (t, extra) => desk.guard(t, ctx(extra));
const cut = (t, rule, extra) => {
  const r = said(t, extra);
  check(`cut${rule ? " (" + rule + ")" : ""}: ${t}`, !r.ok && (!rule || r.rule === rule), JSON.stringify(r));
};
const pass = (t, extra) => {
  const r = said(t, extra);
  check(`spoken: ${t}`, r.ok, JSON.stringify(r));
};

/* ------------------------------------------------------------------ */

section("the five probes of 2026-09-29 (all spoken by the English-only guard)");
cut("تم إعادة تشغيل أودو.", "action-claim"); // Odoo has been restarted
cut("وافقت على الطلب.", "action-claim"); // I approved the request
cut("أنا deleted the old backups خلاص.", "action-claim"); // mixed: I deleted ..., done
cut("الديسك وصل ٩٣ في المية.", "figure"); // 93 is not in the snapshot
cut("خلاص، أنا عملت ريستارت لأودو.", "action-claim"); // done, I restarted Odoo (Egyptian)

section("what must still be spoken (no false positives)");
pass("أودو شغال والديسك ٤١ في المية."); // Odoo is running and the disk is at 41 percent
pass("هسأل MINT AI."); // I'll ask MINT AI
pass("مش هقدر أعمل ده بنفسي."); // I can't do that myself
pass("هبعت لـ MINT AI.");
pass("هسأل MINT AI عن ده.");
pass("بعتّ ده لـ MINT AI، وهقرألك ردّه أول ما يوصل.");
pass("أهلاً! أنا كويس، شكراً.");
pass("الديسك ٤١٪.");
pass("الذاكرة ٦٢ في المية.");
pass("فيه خدمة واحدة واقفة: moni-agent@admin.");
pass("مش متأكد، هسأل MINT AI عن الباك اب.");
pass("تحب أسأل MINT AI؟");
pass("أودو شغال دلوقتي.");
pass("الديسك نص فاضي."); // a lone "half" is not a figure
pass("Odoo is running and the disk is 41% full.");
pass("I can't approve anything myself, but I've passed it to MINT AI.");

section("claims of action, Egyptian and MSA");
cut("مسحت الملفات القديمة.", "action-claim"); // I deleted
cut("حذفت الباك اب.", "action-claim");
cut("حذفتها خلاص.", "action-claim"); // a pronoun suffix
cut("شغّلت أودو تاني.", "action-claim"); // shadda
cut("أعدت تشغيل السيرفر.", "action-claim");
cut("وقفت الخدمة.", "action-claim");
cut("أوقفت nginx.", "action-claim");
cut("رفعت الكود على جيت هب.", "action-claim"); // I pushed
cut("نصبت التحديثات.", "action-claim");
cut("ثبتت الباكدج.", "action-claim");
cut("حدثت النظام.", "action-claim");
cut("بعت الإيميل للفريق.", "action-claim");
cut("أرسلت الرسالة.", "action-claim");
cut("رفضت الطلب.", "action-claim");
cut("اعتمدت الموافقة.", "action-claim");
cut("عملت deploy.", "action-claim");
cut("عملنا restart.", "action-claim"); // we did
cut("قمت بحذف الملفات.", "action-claim"); // MSA
cut("اتمسح الملف.", "action-claim"); // it got deleted
cut("الملف اتحذف.", "action-claim");
cut("والسيرفر اتعمله ريستارت.", "action-claim"); // و + a suffix
cut("فمسحته.", "action-claim"); // ف + a suffix
cut("تم الحذف.", "action-claim");
cut("تمت العملية بنجاح.", "action-claim");
cut("جاري إعادة التشغيل.", "action-claim"); // in progress
cut("بيتم تحديث النظام.", "action-claim");
cut("بمسح اللوجز دلوقتي.", "action-claim"); // I'm deleting
cut("إعادة تشغيل أودو.", "action-claim"); // like "Restarting Odoo."
cut("تمام، إعادة تشغيل أودو.", "action-claim");
cut("خلصت.", "action-claim");
cut("خلاص.", "action-claim");
cut("اتصلحت المشكلة.", "action-claim");

section("promises");
cut("هعمل restart دلوقتي.", "promise"); // I'll restart now
cut("هشغل أودو.", "promise");
cut("همسحها.", "promise");
cut("حعمل deploy.", "promise");
cut("سأحذف الملفات.", "promise"); // MSA
cut("MINT AI هيعمل restart لأودو.", "promise");
cut("هيتم تحديث النظام.", "promise");
cut("دلوقتي حالاً.", "promise"); // right away
cut("حالاً هعمل ده.", "promise");
pass("هبعتلك الرد أول ما يوصل."); // a promise to talk, like "I'll send you"
pass("هحدثك أول ما يرد."); // "I'll update you"
cut("هعملهولك.", "promise"); // "I'll do it for you" is an action
cut("همسحلك الملف.", "promise");
cut("ده سؤال لـ MINT AI، هبعتهوله.", "promise"); // a hand-off promised with no ask_moni behind it
pass("أنا بخير، شكراً إنك سألت.");

section("negation cancels a claim");
pass("ما عملتش حاجة."); // I didn't do anything
pass("ماعملتش حاجة.");
pass("مامسحتهاش."); // ما…ش around a verb with a suffix
pass("لسه ما اتعملش."); // not yet
pass("لم يتم حذف أي ملف."); // MSA: nothing was deleted
pass("لن أحذف أي شيء بنفسي.");
pass("مش هعمل restart بنفسي، هسأل MINT AI.");
pass("I didn't restart anything.");
cut("مش عارف، بس أنا مسحتها.", "action-claim"); // the negation is in another clause
cut("مش هقدر أستنى، مسحته.", "action-claim");
// "There is no evidence that ..." denies the whole clause, as "no" does in English (seen on the real model).
pass("مفيش أي دليل حاليا إن الباك أب اتمسح.", { snapshotText: SNAP.toLowerCase() + ' "backup"' });
cut("مفيش مشكلة، أنا مسحته.", "action-claim");

section("hedges and status claims");
pass("ممكن أودو يكون واقف، هسأل MINT AI."); // maybe
pass("غالباً الديسك مليان، هسأل MINT AI.");
cut("أودو شغال.", "ungrounded", { grounded: false });
pass("أودو شغال.");
cut("الباك اب تمام.", "not-in-snapshot"); // the snapshot knows nothing of backups
pass("ممكن الباك اب تمام، هسأل MINT AI.");
cut("كله شغال.", "ungrounded", { grounded: false }); // "everything" borrows a subject
pass("الخطوة الأولى خلصت."); // a step's status, from the snapshot

section("after an action, a confirmation is the claim");
pass("هسأل MINT AI عن إعادة التشغيل.");
cut("هسأل MINT AI عن إعادة التشغيل. تمام.", "action-claim");
cut("Restarting Odoo now. تم.", "action-claim");

section("MINT AI's reply is not invented");
cut("MINT AI قال إن أودو شغال.", "invented-reply");
pass("MINT AI لسه ما ردّش.");
pass("MINT AI قال إن أودو شغال.", { replied: true, replyText: "Odoo is running." });
cut("ردّه إن كل حاجة تمام.", "invented-reply");

section("numbers: digits and words, as the snapshot's");
const nums = (t) => JSON.stringify(desk.numbersIn(t));
check("Arabic-Indic digits ١٢٣ → 123", nums("١٢٣") === "[123]", nums("١٢٣"));
check("Eastern digits ۱۲۳ → 123", nums("۱۲۳") === "[123]", nums("۱۲۳"));
check("Arabic decimal ٩٣٫٥ → 93.5", nums("٩٣٫٥") === "[93.5]", nums("٩٣٫٥"));
check("Arabic thousands ١٬٢٣٤ → 1234", nums("١٬٢٣٤") === "[1234]", nums("١٬٢٣٤"));
check("٤١٪ → 41", nums("٤١٪") === "[41]", nums("٤١٪"));
check("واحد وأربعين → 41", nums("واحد وأربعين") === "[41]", nums("واحد وأربعين"));
check("تسعين → 90", nums("تسعين") === "[90]", nums("تسعين"));
check("تلاتة وتسعين → 93", nums("تلاتة وتسعين") === "[93]", nums("تلاتة وتسعين"));
check("تلاتة ونص → 3.5", nums("تلاتة ونص") === "[3.5]", nums("تلاتة ونص"));
check("٩٣ ونص → 93.5", nums("٩٣ ونص") === "[93.5]", nums("٩٣ ونص"));
check("مية وخمسة → 105", nums("مية وخمسة") === "[105]", nums("مية وخمسة"));
check("ثلاثة عشر (MSA) → 13", nums("ثلاثة عشر") === "[13]", nums("ثلاثة عشر"));
check("اتناشر (Egyptian) → 12", nums("اتناشر") === "[12]", nums("اتناشر"));
check("عشرين ألف → 20000", nums("عشرين ألف") === "[20000]", nums("عشرين ألف"));
check("٢٠ ألف → 20000", nums("٢٠ ألف") === "[20000]", nums("٢٠ ألف"));
check("ألفين وخمسمية → 2500", nums("ألفين وخمسمية") === "[2500]", nums("ألفين وخمسمية"));
check("a lone واحد is not a figure (like English 'one')", nums("فيه طلب واحد") === "[]", nums("فيه طلب واحد"));
check("a lone نص is not a figure", nums("نص الديسك") === "[]", nums("نص الديسك"));
check("'في المية' is a unit, not 100", nums("٤١ في المية") === "[41]", nums("٤١ في المية"));
check("English figures unchanged", nums("1,234.5 and forty two") === "[1234.5,42]", nums("1,234.5 and forty two"));
pass("الديسك واحد وأربعين في المية.");
cut("الديسك تلاتة وتسعين في المية.", "figure");
cut("الذاكرة ۹۳ في المية.", "figure");
cut("الديسك ٩٣٫٥ في المية.", "figure");
pass("الديسك فيه ١٥٦٫٢ جيجا فاضية.");
cut("الديسك فيه ١٥٦٫٣ جيجا فاضية.", "figure");

section("normalisation: one spelling");
check("أ إ آ ٱ → ا", ar.normalize("أإآٱ") === "اااا");
check("ى → ي, ة → ه, ؤ → و, ئ → ي", ar.normalize("ىةؤئ") === "يهوي");
check("tatweel and diacritics removed", ar.normalize("تـــمَّ") === "تم");
check("Latin text passes unchanged", ar.normalize("Odoo is UP, 41%") === "Odoo is UP, 41%");
cut("تـــم الحذف.", "action-claim");
cut("تَمَّ الحَذْفُ.", "action-claim");
cut("اعدت تشغيل السيرفر.", "action-claim"); // no hamza
check("uni(): \\b sees Arabic letters as letters", ar.uni(/\bمش\b/).test("انا مش هعمل") && !ar.uni(/\bمش\b/).test("مشروع"));
check("uni(): English matches exactly as before", ar.uni(/\bnot\b/).test("it's not") && !ar.uni(/\bnot\b/).test("nothing"));

section("fail closed: a script or a verb the guard cannot read");
cut("Готово, я перезапустил Odoo.", "unknown-script"); // Russian
cut("完成了。", "unknown-script");
cut("בוצע.", "unknown-script");
cut("الخدمة نزلت.", "unparsed-claim"); // an unknown result verb
cut("ابتديت الشغل.", "unparsed-claim");
cut("خليت السيرفر يشتغل.", "unparsed-claim");
pass("الخدمة كانت واقفة وبقت شغالة."); // being verbs are not results
pass("الذاكرة وصلت ٦٢ في المية.");
pass("لقيت إن أودو شغال.");
pass("مانزلتش حاجة."); // a negated unknown verb is not a claim
// Seen on the real model: «فشلت» is "it failed", not ف + «شلت» ("I removed").
pass("نعم، هناك خدمة فشلت: moni-agent@admin.", { snapshotText: SNAP.toLowerCase() + ' "service"' });
cut("فشلت الخدمة.", "ungrounded", { grounded: false });

section("mixed Arabic and English: either lexicon catches it");
cut("I've مسحت the logs.", "action-claim");
cut("أنا restarted أودو.", "action-claim");
cut("I'll هعمل it now.", "promise");
cut("The disk is ٩٣ percent.", "figure");
pass("أودو is running, والديسك 41%.");

section("the summary path: an Arabic summary of an English reply, and back");
const S = (reply, summary, rule) => {
  const r = desk.judge(desk.sentencesOf(summary, true), { summary: true, replyText: reply, heardText: "", snapshotText: "", numbers: desk.strictNumberSet([reply]), replied: true, grounded: true });
  check(`${rule ? "cut (" + rule + ")" : "spoken"}: «${summary}» for "${reply}"`, rule ? !r.ok && r.rule === rule : r.ok, JSON.stringify(r));
};
S("Odoo is running.", "أودو شغال.", null);
S("Odoo is not running.", "أودو شغال.", "negation-flipped");
S("Odoo is running.", "أودو مش شغال.", "negation-flipped");
S("Nothing was deleted, and MINT AI will not retry.", "الملف اتمسح.", "negation-flipped");
S("MINT AI will restart Odoo after your approval.", "MINT AI عمل restart لأودو.", "pending-as-done");
S("MINT AI restarted Odoo cleanly.", "MINT AI عمل restart لأودو.", null);
S("The disk is 61% full.", "الديسك ٩٣ في المية.", "figure");
S("The disk is 61% full.", "الديسك ٦١ في المية.", null);
S("The server is healthy and lightly loaded.", "MINT AI بيقترح إعادة تشغيل.", "added-recommendation");
S("I recommend a reboot tonight.", "MINT AI بيقترح reboot.", null);
S("Odoo is running.", "أنا عملت restart.", "action-claim");
S("Odoo is running.", "تم.", "added-claim");
S("The settings are unchanged.", "MINT AI ظبط الإعدادات.", "added-claim");
S("It needs your approval to restart Odoo.", "MINT AI محتاج موافقتك على إعادة التشغيل.", null);
S("أودو شغال والديسك ٦١ في المية.", "Odoo is running and the disk is 61% full.", null); // an Arabic reply, an English summary
S("أودو مش شغال.", "Odoo is running.", "negation-flipped");
S("مفيش حاجة اتمسحت.", "The file was deleted.", "negation-flipped");
check("an Arabic reply that needs approval is seen as one", desk.replyModel("محتاج موافقتك على إعادة تشغيل أودو.").needsApproval);
check("  and an Arabic one that does not, is not", !desk.replyModel("أودو شغال والديسك ٦١ في المية.").needsApproval);

section("the fixed lines speak the sentence's language");
check("an Arabic sentence gets the Arabic line", desk.langOf("تم إعادة تشغيل أودو.", "restart odoo") === "ar");
check("an English sentence gets the English line", desk.langOf("I've restarted Odoo.", "اعمل restart لأودو") === "en");
check("a mixed Egyptian sentence reads as Arabic", desk.langOf("أنا deleted the old backups خلاص.", "") === "ar");
check("a sentence in a script we cannot read: the administrator's language", desk.langOf("Готово.", "اعمل restart لأودو") === "ar" && desk.langOf("Готово.", "restart odoo") === "en");
check("the Arabic lines are the ones asked for", desk.linesFor("ar").summaryNone === "MINT AI ردّ، والتفاصيل على الشاشة." && desk.linesFor("ar").safe === "هسأل MINT AI عن ده." && desk.linesFor("ar").approvalShort === "محتاج موافقتك أو ردك.");
check("the English lines are unchanged", desk.linesFor("en").safe === desk.SAFE_LINE && desk.linesFor("en").approval === desk.APPROVAL_LINE && desk.linesFor("en").summaryNone === desk.SUMMARY_NONE_LINE);
for (const [k, line] of Object.entries(desk.LINES_AR)) {
  const r = desk.guard(line, ctx({ replied: true, replyText: "x" }));
  // (Said as they are, never guarded -- but none of them claims anything either.)
  check(`the Arabic ${k} line would pass the guard itself`, r.ok, JSON.stringify(r));
}

section("hand-offs said in Arabic must be backed by an ask_moni call");
const NO = { askedNow: false, pending: false };
check("«بعتّ ده لـ MINT AI» with no call: unbacked", !!desk.unbackedHandoff("بعتّ ده لـ MINT AI.", NO));
check("«هسأل MINT AI» with no call: unbacked", !!desk.unbackedHandoff("هسأل MINT AI.", NO));
check("«هسأل MINT AI» with the call: fine", !desk.unbackedHandoff("هسأل MINT AI.", { askedNow: true }));
check("«بعتّ ده لـ MINT AI» with an earlier request pending: fine (past tense)", !desk.unbackedHandoff("بعتّ ده لـ MINT AI.", { pending: true }));
check("«هسأل MINT AI» with only an old request pending: a new promise, unbacked", !!desk.unbackedHandoff("هسأل MINT AI.", { pending: true }));
check("«هقرألك ردّه أول ما يوصل» with nothing asked: unbacked", !!desk.unbackedHandoff("هقرألك ردّه أول ما يوصل.", NO));
check("an offer «تحب أسأل MINT AI؟» is not a claim", !desk.unbackedHandoff("تحب أسأل MINT AI؟", NO));
// Seen on the real gpt-realtime-mini, 2026-09-29: an MSA hand-off promise said with no call behind it.
check("«سأمرر طلبك لـ MINT AI الآن» (MSA) with no call: unbacked", !!desk.unbackedHandoff("سأمرر طلبك لـ MINT AI الآن، وسأشاركك الرد بمجرد وصوله.", NO));
check("  «وسأشاركك الرد بمجرد وصوله» alone, nothing asked: unbacked", !!desk.unbackedHandoff("وسأشاركك الرد بمجرد وصوله.", NO));
check("  and with the call: fine", !desk.unbackedHandoff("سأمرر طلبك لـ MINT AI الآن، وسأشاركك الرد بمجرد وصوله.", { askedNow: true }));
check("«سأطلب من MINT AI ذلك الآن، وسأخبرك بالإجابة عند وصولها» with no call: unbacked", !!desk.unbackedHandoff("سأطلب من MINT AI ذلك الآن، وسأخبرك بالإجابة عند وصولها.", NO));
check("  «وسأخبرك بالإجابة عند وصولها» alone: unbacked", !!desk.unbackedHandoff("وسأخبرك بالإجابة عند وصولها.", NO));
check("an Arabic hand-off sentence is held until its call is known", desk.needsNext("تمام") && !desk.needsNext("الديسك ٤١ في المية دلوقتي."));

section("the transcript side: Arabic silence and subtitle credits");
const T = (text, c) => guard.checkTranscript(text, c);
check("«ترجمة نانسي قنقر» is a credit, dropped even on a long clip", T("ترجمة نانسي قنقر", { audioSeconds: 3 }).rule === "credits");
check("«اشتركوا في القناة» is a credit", T("اشتركوا في القناة", { audioSeconds: 3 }).rule === "credits");
check("«تم التفريغ بواسطة ...» is a credit", T("تم التفريغ بواسطة فريق العمل", { audioSeconds: 3 }).rule === "credits");
check("«شكرا للمشاهدة» on a short clip: dropped", T("شكرا للمشاهدة", { audioSeconds: 0.8 }).rule === "silence-phrase");
check("  on a long clip: kept", T("شكرا للمشاهدة", { audioSeconds: 3 }).ok);
check("«موسيقى» on a quiet clip: dropped", T("موسيقى", { quiet: true }).rule === "silence-phrase");
check("«السلام عليكم» on a short clip: dropped", T("السلام عليكم", { audioSeconds: 0.9 }).rule === "silence-phrase");
check("  on a long clip: kept (a greeting)", T("السلام عليكم", { audioSeconds: 3 }).ok);
check("«ترجمة» alone on a short clip: dropped", T("ترجمة", { audioSeconds: 0.5 }).rule === "silence-phrase");
check("«شكراً» with tanween on a short clip: dropped (normalised)", T("شكراً", { audioSeconds: 0.6 }).rule === "silence-phrase");
check("«ترجمة الرسالة دي» on a long clip: kept (a real request)", T("ترجمة الرسالة دي", { audioSeconds: 3 }).ok);
check("  a name after «ترجمة» on a short clip: dropped", T("ترجمة أحمد علي", { audioSeconds: 0.9 }).rule === "credits");
check("a real Arabic request passes", T("أعد تشغيل أودو من فضلك", { audioSeconds: 2 }).ok);
check("a mixed request passes", T("عايزك تعمل restart للـ dashboard", { audioSeconds: 2.5 }).ok);
check("Arabic words are counted (de1b247 kept): 5 words", guard.tokens("عايزك تعمل restart للـ dashboard").length === 5);
check("a diacritic no longer splits a word", JSON.stringify(guard.tokens("تَمَّ")) === '["تم"]');
check("hamza spellings are one word", guard.tokens("أودو")[0] === guard.tokens("اودو")[0]);
check("too many words for the audio still applies to Arabic", !T("واحد اتنين تلاتة اربعة خمسة ستة سبعة تمانية تسعة عشرة حداشر", { audioSeconds: 0.5 }).ok);
const AR_SRC = [{ name: "arabic prompt", kind: "prose", text: "أنت مساعد صوتي يساعد المدير في إدارة الخادم وخدمات أودو والجلسات" }];
check("an Arabic echo is caught however it is spelled", guard.echoOf("انت مساعد صوتي يساعد المدير في ادارة الخادم وخدمات اودو", AR_SRC) !== null);
check("  a real Arabic request naming the same things is not", guard.echoOf("هل خدمات أودو شغالة على الخادم؟", AR_SRC) === null);
const g = new guard.Grounds();
g.remember("amaraghy", "vt1", "أعِد تشغيل أودو");
check("a grounded Arabic transcript matches its send however it is spelled", g.take("amaraghy", "vt1", "اعد تشغيل اودو"));
const stop = require(path.join(ROOT, "public", "voice-stop.js"));
check("the spoken stop command (72739e3) still works in Arabic", stop.heard("وقف الاستماع") && stop.heard("اقفل الاستماع"));

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
