"use strict";
/**
 * The voiceprint trial's recording page (/mint-ai/voiceprint-trial,
 * administrators only; lib/voiceprint-trial.js). No inline script or style:
 * public/voiceprint-trial.js and voiceprint-trial.css.
 */
const { esc, shell, card, icon } = require("./ui");

function rows(list, limits) {
  return list
    .map(
      (p) => `<li class="vp-row" data-id="${esc(p.id)}" data-part="${esc(p.part)}" data-max="${limits[p.part].max}">
      <span class="vp-n">${esc(p.id)}</span>
      <span class="vp-text" dir="auto" lang="${p.lang === "en" ? "en" : "ar"}">${esc(p.text)}</span>
      <span class="vp-kind">${esc(p.kind)} · ${esc(p.lang === "ar" ? "Egyptian" : p.lang === "en" ? "English" : "mixed")}</span>
      <span class="vp-ctl"><button type="button" class="btn small vp-rec" data-rec="${esc(p.id)}">Record</button><button type="button" class="btn small" data-play="${esc(p.id)}" hidden>Play</button><span class="vp-state muted small" data-state="${esc(p.id)}" aria-live="polite">not recorded</span></span>
    </li>`
    )
    .join("");
}

function page({ csrf, user, slots, enrol, tests, limits, worklet }) {
  const total = enrol.length + tests.length;
  const slotOpts = slots.map((s, i) => `<option value="${esc(s.id)}"${i === 0 ? " selected" : ""}>${esc(s.label)}</option>`).join("");
  const body = `<div id="vp" data-csrf="${esc(csrf)}" data-worklet="${esc(worklet)}" data-total="${total}">
${card(
  "Why, and what happens to the recordings",
  `<p>This is a trial for a future <b>voiceprint</b>: MINT AI would act only on your voice, and ignore other people in the room, a TV, or its own voice coming back through the speakers.
     Before building it, we measure how well local models tell your voice apart, in English and Egyptian Arabic, on your laptop microphone and on a headset.</p>
   <ul class="vp-facts">
     <li>${icon("lock", 14)} The recordings stay on this server, in your own folder that only the panel can read. They are not sent to OpenAI or anyone else, and are not kept in the repository or in MINT AI's memory.</li>
     <li>${icon("cpu", 14)} They are scored offline, on this server, by open speaker-recognition models. Nothing is decided from them: no voiceprint is switched on.</li>
     <li>${icon("trash", 14)} You can delete all of them at any time with the button at the bottom of this page.</li>
   </ul>
   <p class="muted small">About 5 minutes per microphone (${total} recordings). Do the whole list once with the laptop microphone and once with the headset — a different session for each, picked below.
     Speak as you would to MINT AI, at your normal volume. A quiet room is best, but it does not have to be silent.</p>`,
  { icon: "info", id: "vp-why" }
)}
${card(
  "1. Pick the microphone",
  `<div class="vp-mic">
     <label class="vp-field"><span class="small">This session is for</span><select id="vp-slot">${slotOpts}</select></label>
     <label class="vp-field"><span class="small">Microphone</span><select id="vp-device"><option value="">The browser's default microphone</option></select></label>
     <button type="button" class="btn small" id="vp-allow">${icon("voice", 14)} Allow the microphone</button>
   </div>
   <p class="muted small" id="vp-mic-note">The microphone names appear once the browser has been allowed to use the microphone.</p>
   <div class="vp-meter" aria-hidden="true"><span id="vp-level"></span></div>
   <p class="small"><b id="vp-count">0</b> of ${total} recorded for this microphone.</p>`,
  { icon: "voice", id: "vp-mic-card" }
)}
${card(
  "2. Read these aloud (about a minute in all)",
  `<p class="muted small">Press Record, read the paragraph at a natural pace, then press Stop. Each one stops by itself after ${limits.enrol.max} seconds. Mistakes do not matter: just carry on.</p>
   <ol class="vp-list">${rows(enrol, limits)}</ol>`,
  { icon: "file", id: "vp-enrol" }
)}
${card(
  "3. Say the short phrases",
  `<p class="muted small">One phrase per recording, as you would say it to MINT AI. Press Record, say it, press Stop (or Space again). After saving, the next phrase is ready. Re-record any one you are unhappy with.</p>
   <ol class="vp-list">${rows(tests, limits)}</ol>`,
  { icon: "play", id: "vp-tests" }
)}
${card(
  "Delete",
  `<p class="muted small">Removes every trial recording of yours, on every microphone, from this server. The deletion is noted in the audit log (counts only).</p>
   <p class="btn-row"><button type="button" class="btn danger small" id="vp-delete">${icon("trash", 14)} Delete all my trial recordings</button><span class="muted small" id="vp-del-state" aria-live="polite"></span></p>`,
  { icon: "trash", id: "vp-del" }
)}
</div>`;
  return shell("Voiceprint trial", body, {
    user,
    csrf,
    active: "moni-ai",
    subtitle: "Record a short trial set so we can measure how well your own voice can be recognised",
    assets: ["voiceprint-trial.css", "voiceprint-trial.js"],
    crumbs: [["MINT AI", "/mint-ai"], ["Voiceprint trial", null]],
  });
}

module.exports = { page };
