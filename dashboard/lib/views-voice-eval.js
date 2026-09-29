"use strict";
/**
 * The live conversation's Egyptian evaluation page (/mint-ai/voice-eval,
 * administrators only): record the 20 phrases in your own voice, then run them
 * through each realtime model and voice (lib/voice-live-eval.js) and read the
 * comparison table. No inline script or style: public/voice-eval.js and
 * voice-eval.css, the phrases passed as an escaped data attribute.
 */
const { esc, shell, card } = require("./ui");

function page({ csrf, user, phrases, models, voices, worklet }) {
  const rows = phrases
    .map(
      (p) => `<li class="ve-row" data-id="${p.id}">
      <span class="ve-n">${p.id}</span>
      <span class="ve-text" dir="auto">${esc(p.text)}</span>
      <span class="ve-kind">${esc(p.kind)} · ${esc(p.lang)}</span>
      <span class="ve-ctl"><button type="button" class="btn small" data-rec="${p.id}">Record</button><button type="button" class="btn small" data-play="${p.id}" hidden>Play</button><span class="ve-state muted small" data-state="${p.id}">not recorded</span></span>
    </li>`
    )
    .join("");
  const checks = (name, list, on) => list.map((m) => `<label class="ve-chk"><input type="checkbox" name="${name}" value="${esc(m)}"${on.includes(m) ? " checked" : ""}> ${esc(m)}</label>`).join("");
  const body = `<div id="ve" data-csrf="${esc(csrf)}" data-worklet="${esc(worklet)}">
${card(
  "1. Record the 20 phrases, in your own voice",
  `<p class="muted small">Say each phrase the way you would say it to MINT AI (Egyptian, MSA, or mixed, as written), then press Stop.
    A phrase can be recorded again. The recordings stay on this server, in your folder, and are used only for this evaluation.
    Headphones are not needed here: nothing plays while you record.</p>
   <ol class="ve-list">${rows}</ol>`,
  { icon: "voice", id: "ve-rec" }
)}
${card(
  "2. Run the comparison",
  `<p class="muted small">Every recorded phrase goes through each model and voice below, as a live conversation would (the same session, guard
    and hold), with a stubbed MINT AI: nothing is sent to MINT AI. It takes about 15 s per phrase per model and voice, a few at a time, and
    costs roughly $0.004–0.02 per phrase per model and voice (gpt-realtime-2.1 is the dearest).</p>
   <div class="ve-opts"><div><b class="small">Models</b> ${checks("model", models, models)}</div><div><b class="small">Voices</b> ${checks("voice", voices, voices)}</div></div>
   <p class="btn-row"><button type="button" class="btn primary small" id="ve-run">Run the comparison</button><span class="muted small" id="ve-progress"></span></p>`,
  { icon: "play", id: "ve-run-card" }
)}
${card("3. Results", `<div id="ve-results" class="ve-results"><p class="muted small">No results yet.</p></div>`, { icon: "activity", id: "ve-res" })}
</div>`;
  return shell("Live voice evaluation", body, {
    user,
    csrf,
    active: "moni-ai",
    subtitle: "Egyptian and mixed speech through the live conversation's models and voices — with your own voice",
    assets: ["voice-eval.css", "voice-eval.js"],
    crumbs: [["MINT AI", "/mint-ai"], ["Live voice evaluation", null]],
  });
}

module.exports = { page };
