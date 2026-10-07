"use strict";
/**
 * MINT AI ▸ Settings ▸ Voice (/mint-ai/settings/voice): the section's body.
 * The page around it is lib/views-settings.js; the routes are server.js's
 * voice code (they sit with the voice they change).
 *
 * Voice is live conversation only (Mint OS reorganisation, 2026-09-30): one
 * Enabled / Disabled switch for everyone, the voice model, the key, the voice
 * and how it speaks Arabic, how it listens, the live call's audio, and what it
 * spends. While voice is off the section carries `voice-off` (mint-os.css):
 * the rows that only matter with voice on dim (.dep) or hide (.dep-hide), and
 * the key row stays usable -- the key is kept while voice is off.
 *
 * Every row that changes something is a small form (V.form: sent in place by
 * os.js, a plain POST without JavaScript). The key is typed in a dialog and
 * posted once, to be handed to the helper on stdin; it is never shown again.
 *
 * The voice model holds the live call and reads replies aloud when it passed
 * the verbatim check (else gpt-realtime-2.1-mini reads them); a gated model the
 * OpenAI key cannot reach is listed, disabled (2026-10-01).
 * What the administrator said is written down by the Transcription model, a
 * setting again since the evening of 2026-09-30: OpenAI's, or whisper.cpp on
 * this server (lib/voice-transcribe.js), each option with its measured speed,
 * accuracy and cost; a local model that is not installed is listed, disabled.
 *
 * Anchors (the page registry scans them): v-model, v-transcribe,
 * v-transcribe-lang, v-token, v-voice, v-persona, v-read, v-live-audio, v-spend,
 * v-voiceprint, v-vp-gate, v-vp-strict, v-vp-people, v-vp-stats, v-vp-forget.
 *
 * The Voiceprint group (lib/voiceprint.js): the On / Off switch, "Only respond
 * to my voice" (greyed while the voiceprint is off or not enrolled), the
 * enrolment, the last 7 days of checks, and Delete everything.
 */

const { esc, icon } = require("./ui");
const V = require("./views-settings");

const BASE = "/mint-ai/settings/voice";

const GENDER = {
  female: ["♀", "Female"],
  male: ["♂", "Male"],
  neutral: ["◌", "Neutral"],
};

const PERSONAS = [
  ["learned", "Learn from how I speak (default)"],
  ["cairene_f", "Cairene Egyptian — feminine"],
  ["cairene_m", "Cairene Egyptian — masculine"],
  ["msa_n", "Modern Standard Arabic — neutral"],
];

const NOISE = [
  ["far_field", "Far field — laptop or room mic (default)"],
  ["near_field", "Near field — headset mic"],
  ["off", "Off"],
];

const MIC_LABEL = { laptop: "Laptop microphone", headset: "Headset", other: "Other microphone" };
const micLabel = (m) => MIC_LABEL[m] || m;
const pct = (n, d) => (d ? Math.round((100 * n) / d) + "%" : "—");

/** The score histogram of the last days (inline SVG: no inline style, CSP-clean). */
function vpHistogram(st, th) {
  const h = st.hist || [];
  const max = Math.max(1, ...h);
  const W = 240;
  const H = 56;
  const bw = W / Math.max(1, h.length);
  const x = (score) => ((score - st.hist_from) / (st.hist_step * h.length)) * W;
  const bars = h
    .map((n, i) => {
      const lo = st.hist_from + i * st.hist_step;
      const cls = lo >= th.accept ? "ok" : lo + st.hist_step <= th.reject ? "bad" : "mid";
      const bh = n ? Math.max(2, Math.round((n / max) * (H - 4))) : 0;
      return bh ? `<rect class="${cls}" x="${(i * bw + 1).toFixed(1)}" y="${H - bh}" width="${(bw - 2).toFixed(1)}" height="${bh}"><title>${lo.toFixed(2)}–${(lo + st.hist_step).toFixed(2)}: ${n}</title></rect>` : "";
    })
    .join("");
  const line = (v, cls) => `<line class="${cls}" x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="0" y2="${H}"></line>`;
  return `<svg class="vp-hist" viewBox="0 0 ${W} ${H + 12}" role="img" aria-label="Scores of the last ${st.days} days"><line class="base" x1="0" x2="${W}" y1="${H}" y2="${H}"></line>${bars}${line(th.accept, "acc")}${line(th.reject, "rej")}<text x="0" y="${H + 11}">${st.hist_from}</text><text x="${x(0).toFixed(1)}" y="${H + 11}" text-anchor="middle">0</text><text x="${x(th.accept).toFixed(1)}" y="${H + 11}" text-anchor="middle">${th.accept}</text><text x="${W}" y="${H + 11}" text-anchor="end">1</text></svg>`;
}

/**
 * The Voiceprint group (lib/voiceprint.js). o.voiceprint = { enabled, gate, thresholds, service, enrolled,
 * model, stats, trial: [slots with enrolment recordings] }.
 */
function voiceprintGroup(o) {
  const vp = o.voiceprint;
  if (!vp) return "";
  const csrf = o.csrf;
  const en = !!vp.enabled;
  const people = vp.people || [];
  const enrolled = people.some((p) => p.enrolled);
  const th = vp.thresholds || { accept: 0.31, reject: 0.2, stickyMin: 0.2, echo: 0.45 };
  const svcBad = en && vp.service && (vp.service.ok === false || vp.service.error);
  const warn = svcBad
    ? `<div class="alert bad vp-warn" id="vp-service-warn">${icon("alert")}<div><strong>The voiceprint service is not answering.</strong> Turns are not being checked and nothing is blocked (fail open). ${esc(
        vp.service.error || ""
      )} <span class="muted">It is <code>moni-voiceprint.service</code>, installed with <code>deploy/install-voiceprint.sh</code>.</span></div></div>`
    : "";
  const sw1 = V.row(
    "Voiceprint",
    `MINT AI checks each turn of a live call — a hold-to-talk press or a hands-free turn — against the stored voiceprints below, on this server (nothing is sent anywhere), and addresses whoever it recognised by name. On its own it only watches: nothing is blocked. Off: nothing is checked and calls work exactly as before; the voiceprints are kept. <b>A voice identifies; it never authorises:</b> approvals and destructive actions still need the signed-in user's click or Windows Hello.`,
    V.form(`${BASE}/voiceprint`, csrf, V.sw('name="enabled" value="1" id="vp-enabled" aria-label="Voiceprint"', en, "On", "Off"), {
      confirm: en ? "Switch the voiceprint off?" : null,
      confirmBody: en ? "Turns are no longer checked or named; “Only respond to stored voices” stops too. The voiceprints are kept." : null,
      confirmYes: en ? "Switch off" : null,
    }),
    { id: "v-voiceprint", scope: "everyone" }
  );
  const canGate = en && enrolled;
  const gateHelp = `When on: a stored voice → answered, by name. Once someone is recognised in a call, their later doubtful or very short turns count as theirs (see Strictness). Not sure who's speaking (and nobody recognised yet in this call) → not answered. An unknown voice (people in the room, a TV) → ignored, and a “yes” in it confirms nothing. MINT AI never speaks about either: the state pill shows “Not sure who's speaking” or “Unknown voice — ignored”. MINT AI's own voice coming back → dropped. If the check fails, the turn goes through.${
    canGate ? "" : en ? ` <span class="muted" id="vp-gate-why">Store a voiceprint first.</span>` : ` <span class="muted" id="vp-gate-why">The voiceprint is off.</span>`
  }`;
  const sw2 = V.row(
    "Only respond to stored voices",
    gateHelp,
    V.form(`${BASE}/voiceprint/gate`, csrf, V.sw(`name="gate" value="1" id="vp-gate" aria-label="Only respond to stored voices"${canGate ? "" : " disabled"}`, canGate && vp.gate, "On", "Off"), {
      confirm: vp.gate ? null : "Only respond to stored voices?",
      confirmBody: vp.gate ? null : "Unknown voices and unsure turns are not answered from the next turn on. Check the last days' figures below first.",
      confirmYes: vp.gate ? null : "Turn on",
    }),
    { id: "v-vp-gate", scope: "everyone" }
  );
  const presets = vp.presets || [];
  const cur = vp.preset || "relaxed";
  const curP = presets.find((p) => p.id === cur);
  const presetForm = V.form(
    `${BASE}/voiceprint/strictness`,
    csrf,
    `<div class="vp-presets" role="radiogroup" aria-label="Strictness">${presets
      .map(
        (p) =>
          `<label class="vp-preset${p.id === cur ? " on" : ""}"><input type="radio" name="preset" value="${esc(p.id)}"${p.id === cur ? " checked" : ""}${en ? "" : " disabled"}><span class="t"><b>${esc(p.label)}</b><small>${esc(p.effect)}</small></span></label>`
      )
      .join("")}${cur === "custom" ? `<p class="small vp-custom" id="vp-custom">Custom values (Advanced).</p>` : ""}</div>`
  );
  const num = (name, label, val, lo, hi, hint) =>
    `<label class="vp-num"><span class="small">${esc(label)}</span><input type="number" name="${name}" value="${esc(String(val))}" min="${lo}" max="${hi}" step="0.01" required data-no-live${en ? "" : " disabled"}><small class="muted">${esc(hint)}</small></label>`;
  const B = vp.bounds || { accept: [0.05, 0.8], reject: [0.05, 0.8], stickyMin: [0.05, 0.8], echo: [0.2, 0.9] };
  const adv = `<details class="vp-adv" id="vp-adv"${cur === "custom" ? " open" : ""}><summary>Advanced</summary>${V.form(
    `${BASE}/voiceprint/strictness`,
    csrf,
    `<div class="vp-nums-grid">${num("accept", "Recognised from", th.accept, B.accept[0], B.accept[1], "a score this high is you")}${num("reject", "Another voice below", th.reject, B.reject[0], B.reject[1], "lower than the next")}${num(
      "stickyMin",
      "Call's voice from",
      th.stickyMin,
      B.stickyMin[0],
      B.stickyMin[1],
      "after you're recognised; ≤ Recognised from"
    )}${num("echo", "MINT AI's own voice from", th.echo, B.echo[0], B.echo[1], "heard over its playback")}</div><p class="btn-row"><button class="btn small primary" type="submit" id="vp-adv-save"${en ? "" : " disabled"}>Save</button><button class="btn small" type="submit" name="reset" value="1" id="vp-adv-reset"${en ? "" : " disabled"}>Reset to defaults</button></p>`,
    { noSave: true }
  )}</details>`;
  const strictRow = V.row(
    "Strictness",
    `How much benefit of the doubt a call gives a speaker once they have been recognised in it. Before that, an unsure turn is never answered. At every level, a very short turn (under 0.8 s of speech) goes through unless it is clearly another voice.${curP ? "" : " Now: custom values."} <span class="muted">Figures from replaying your trial recordings and 200 other people's through the live check.</span>`,
    `<div class="vp-strict">${presetForm}${adv}</div>`,
    { id: "v-vp-strict", scope: "everyone", full: true }
  );
  const day = (t) => (t ? esc(String(t).slice(0, 10)) : "never");
  const personCard = (p) => {
    const ms = Object.keys(p.mics || {});
    const micList = ms
      .map(
        (m) =>
          `<li class="vp-mic"><span><b>${esc(micLabel(m))}</b> <span class="muted">${esc(String(p.mics[m].speech_s || "?"))} s${p.mics[m].source === "trial" ? " · trial recordings" : ""}</span></span>${V.form(
            `${BASE}/voiceprint/people/${esc(p.id)}/remove-mic`,
            csrf,
            `<input type="hidden" name="mic" value="${esc(m)}"><button class="btn small" type="submit">Remove</button>`,
            { noSave: true, cls: "inline", confirm: `Remove this microphone from ${p.name}'s voiceprint?`, confirmBody: ms.length > 1 ? "It is rebuilt from the other microphones." : "It is the only one: the voiceprint is emptied until it is enrolled again.", confirmYes: "Remove" }
          )}</li>`
      )
      .join("");
    const linked = p.user_id != null ? (vp.users || []).find((u) => u.id === p.user_id) : null;
    return `<li class="vp-person" data-person="${esc(p.id)}">
      <div class="vp-ph"><span class="vp-pn"><b>${esc(p.name)}</b>${p.spoken ? ` <span class="muted" dir="auto">«${esc(p.spoken)}»</span>` : ""}${linked ? ` <span class="tag-s" title="Dashboard user">${esc(linked.username)}</span>` : ""}${
        p.enrolled ? "" : ` <span class="pill bad">not enrolled</span>`
      }</span><span class="muted small">last heard ${day(p.last_heard)} · added ${day(p.created_at)}</span></div>
      <div class="vp-pc">${V.form(
        `${BASE}/voiceprint/people/${esc(p.id)}/command`,
        csrf,
        `<label class="vp-cmd"><span class="small">May give commands</span>${V.sw(`name="may" value="1" aria-label="${esc(p.name)} may give commands"${en ? "" : " disabled"}`, p.may_command, "On", "Off")}</label>`
      )}</div>
      ${ms.length ? `<ul class="vp-mics">${micList}</ul>` : ""}
      <div class="vp-acts"><a class="btn small${p.enrolled ? "" : " primary"}" href="/mint-ai/voiceprint/enrol?person=${encodeURIComponent(p.id)}">${icon("voice", 14)} ${p.enrolled ? "Add or redo a microphone" : "Enrol (about 2 minutes)"}</a>
        <details class="vp-rename"><summary class="btn small">Rename</summary>${V.form(
          `${BASE}/voiceprint/people/${esc(p.id)}/rename`,
          csrf,
          `<label class="vp-field"><span class="small">Name</span><input name="name" value="${esc(p.name)}" maxlength="40" required data-no-live></label><label class="vp-field"><span class="small">Spoken name (optional)</span><input name="spoken" value="${esc(p.spoken || "")}" maxlength="40" dir="auto" data-no-live></label><button class="btn small primary" type="submit">Save</button>`,
          { noSave: true, cls: "vp-rename-form" }
        )}</details>
        ${V.form(`${BASE}/voiceprint/people/${esc(p.id)}/delete`, csrf, `<button class="btn small danger" type="submit">${icon("trash", 14)} Delete</button>`, {
          noSave: true,
          cls: "inline",
          confirm: `Delete ${p.name}'s voiceprint?`,
          confirmBody: "Only this voiceprint is deleted. Their voice is unknown from the next turn.",
          confirmYes: "Delete",
        })}</div>
    </li>`;
  };
  const trial = vp.me && vp.me.mics ? (vp.trial || []).filter((sl) => !vp.me.mics[sl]) : vp.trial || [];
  const trialBtns = trial
    .map((sl) =>
      V.form(`${BASE}/voiceprint/from-trial`, csrf, `<input type="hidden" name="slot" value="${esc(sl)}"><button class="btn small" type="submit" id="vp-from-trial-${esc(sl)}"${en ? "" : " disabled"}>${icon("fingerprint", 14)} My trial recordings (${esc(micLabel(sl))}) → my voiceprint</button>`, {
        noSave: true,
        cls: "inline",
      })
    )
    .join("");
  const full = people.length >= (vp.max || 10);
  const addForm = `<form method="post" action="${BASE}/voiceprint/people" class="vp-add" id="vp-add"><input type="hidden" name="_csrf" value="${esc(csrf)}">
      <label class="vp-field"><span class="small">Name</span><input name="name" maxlength="40" required placeholder="Zaghloul" pattern="[A-Za-z0-9][A-Za-z0-9 .'\\-]{0,39}"${full || !en ? " disabled" : ""}></label>
      <label class="vp-field"><span class="small">Spoken name (optional)</span><input name="spoken" maxlength="40" dir="auto" placeholder="زغلول"${full || !en ? " disabled" : ""}></label>
      ${vp.me ? "" : `<label class="vp-me"><input type="checkbox" name="me" value="1"${full || !en ? " disabled" : ""}> This is my own voice</label>`}
      <button class="btn small primary" type="submit" id="vp-add-btn"${full || !en ? " disabled" : ""}>${icon("plus", 14)} Add and enrol</button></form>`;
  const peopleRow = V.row(
    `Stored voiceprints <span class="muted">(${people.length} of ${vp.max || 10})</span>`,
    `Each person is recognised by voice and addressed by name — the spoken name in Arabic, if given. “May give commands” off: they are answered in conversation only — nothing is handed to MINT AI, no screen is changed, and their “yes” confirms nothing. Only record someone who agreed to it. A voiceprint is a list of numbers, sealed with a key only the server's root can use — never the recordings. Model: ${esc(vp.model || "")} (WeSpeaker project).`,
    `<div class="vp-people-box">${people.length ? `<ul class="vp-people" id="vp-people">${people.map(personCard).join("")}</ul>` : `<span class="kv-mask" id="vp-none">${icon("fingerprint", 15)}<span>No voiceprints stored</span></span>`}${
      trialBtns ? `<div class="vp-acts">${trialBtns}</div>` : ""
    }${full ? `<p class="small muted">At most ${vp.max || 10} stored voiceprints.</p>` : addForm}</div>`,
    { id: "v-vp-people", full: true }
  );
  const st = vp.stats || { checked: 0, by: {} };
  const by = st.by || {};
  const perPerson = (st.people || []).map((x) => `<span><b>${x.turns}</b> ${esc(x.name)}${x.talk_only ? ` (${x.talk_only} talk only)` : ""}</span>`).join("");
  const statsBody = st.checked
    ? `<div class="vp-stats" id="vp-stats"><div class="vp-nums"><span><b>${st.checked}</b> turns checked</span>${perPerson}<span class="${st.unknown ? "vp-attn" : ""}"><b>${st.unknown || 0}</b> unknown voice</span><span><b>${
        st.unsure || 0
      }</b> not sure who</span>${by.echo ? `<span class="vp-attn"><b>${by.echo}</b> MINT AI's echo</span>` : ""}${by.unverified ? `<span><b>${by.unverified}</b> too short to check</span>` : ""}${
        by.error ? `<span class="vp-attn"><b>${by.error}</b> not checked (service)</span>` : ""
      }<span class="muted">median best score ${st.score_p50 == null ? "—" : st.score_p50} · check ${st.ms_p50 == null ? "—" : Math.round(st.ms_p50) + " ms"} (p95 ${st.ms_p95 == null ? "—" : Math.round(st.ms_p95) + " ms"})</span></div>${vpHistogram(st, th)}</div>`
    : `<span class="muted-num" id="vp-stats">${en ? (enrolled ? "No turns checked yet — talk in a live call." : "Nothing yet: store a voiceprint first.") : "The voiceprint is off."}</span>`;
  const statsRow = V.row(
    `Last ${st.days || 7} days${vp.gate ? "" : " (watching only)"}`,
    `Who was heard. With “Only respond to stored voices” off, unknown and unsure turns were still answered; on, they were not. <span id="vp-active">Now: recognised from ${th.accept}; unknown below ${th.reject}; the call's speaker from ${th.stickyMin}; MINT AI's own voice from ${th.echo}${
      curP ? ` (${esc(curP.label.replace(/ \(recommended\)$/, ""))})` : " (custom)"
    }.</span>`,
    statsBody,
    { id: "v-vp-stats", full: !!st.checked }
  );
  const forget = V.row(
    "Delete everything",
    "Every stored voiceprint, their sealing key, your voiceprint trial's recordings and evaluation results, MINT AI's own voice print and the check log — all of it, from this server.",
    V.form(`${BASE}/voiceprint/forget-all`, csrf, `<button class="btn small danger" type="submit" id="vp-forget-all">${icon("trash", 14)} Delete everything</button>`, {
      noSave: true,
      cls: "inline",
      confirm: "Delete every stored voiceprint?",
      confirmBody: "All voiceprints, the key, the trial recordings, the evaluation results and the check log are removed. This cannot be undone.",
      confirmYes: "Delete everything",
    }),
    { id: "v-vp-forget" }
  );
  return V.group("Voiceprint", "fingerprint", warn + sw1 + `<div class="vp-dep${en ? "" : " vp-off"}">${sw2}${strictRow}${peopleRow}${statsRow}</div>` + forget, { id: "v-vp" });
}

function usd(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

/** A voice card: name, gender (as the voice presents in OpenAI's samples), a word or two. */
function voiceCard(name, cur, meta) {
  const m = meta || {};
  const g = GENDER[m.gender] || null;
  const tip = m.gender === "neutral" ? "OpenAI presents alloy as neutral; labelled Neutral rather than guessed" : "as the voice presents in OpenAI's own samples (OpenAI does not label gender)";
  return `<label class="voice-card"><input type="radio" name="voice" value="${esc(name)}"${name === cur ? " checked" : ""}><span class="top"><b>${esc(
    name.charAt(0).toUpperCase() + name.slice(1)
  )}</b>${g ? `<span class="g" title="${esc(tip)}"><i aria-hidden="true">${g[0]}</i>${esc(g[1])}</span>` : ""}</span><span>${esc(m.note || "")}</span></label>`;
}

/**
 * @param o {
 *   csrf,
 *   on            the switch
 *   status        priv.voiceStatus(): configured, modified (never the key)
 *   model         the voice model now (lib/voice.js VOICE_MODELS id)
 *   models        lib/voice.js VOICE_MODELS [{id, label, short, hint, gated?}]
 *   access        lib/voice.js modelAccess(): { id: { available, known } }
 *   voice, voices, meta   the voice, the list, lib/voice.js VOICE_META
 *   transcribe    the live session's own transcription model (always OpenAI's)
 *   transcription { model, language }: the Transcription setting
 *   transcribers  lib/voice-transcribe.js TRANSCRIBERS; languages its LANGUAGES
 *   local         the helper's voice-whisper-status (installed models), or { error }
 *   persona       voice-persona describe() + mode/preset
 *   liveAudio     { duplex, noise }
 *   usage         voice-usage summary (or { error })
 *   test          { ok, text } from a no-JavaScript Test
 *   switchRow     settings row of the switch: { updated_at, updated_by } | null
 * }
 */
function body(o) {
  const on = !!o.on;
  const set = !!(o.status && o.status.configured);
  const csrf = o.csrf;

  const hero = `<div class="hero-sw"><span class="hs-ico">${icon("voice", 22)}</span><div class="hs-t"><b id="voice-state">${
    on ? "Voice is enabled" : "Voice is disabled"
  }</b><span>${
    on
      ? set
        ? `Live conversation · ${esc(o.model)} · ${esc(o.voice)}`
        : "Enabled, but no token yet — add one below"
      : "Nothing listens or speaks. The token stays stored."
  }</span></div>${V.form(`${BASE}/enabled`, csrf, V.sw('name="enabled" value="1" id="voice-master" aria-label="Voice for everyone"', on, "Enabled", "Disabled", "big"), {
    cls: "hs-form",
    confirm: on ? "Turn voice off for everyone?" : null,
    confirmBody: on ? "The microphone, read-aloud and live-call controls disappear, and any open live call ends. The token stays stored." : null,
    confirmYes: on ? "Turn voice off" : null,
  })}</div>`;

  const offnote = `<div class="offnote">${icon("info", 16)}<div>Voice is off for everyone: the microphone, read-aloud and live-call controls disappear from the Command Center and the dock, and MINT AI's voice screen actions are refused. Typing works as always. The token stays stored — you can still replace or remove it below.</div></div>`;

  const listen = o.transcribe || "gpt-4o-mini-transcribe";
  // The voice model: each option says its facts; a gated model the key cannot
  // reach is listed, disabled (lib/voice.js modelAccess), unless it is current.
  const access = o.access || {};
  const models = o.models || [];
  const reach = (m) => !m.gated || !!(access[m.id] && access[m.id].available);
  const away = (m) => (access[m.id] && access[m.id].known ? "not available on this OpenAI key" : "not checked on this OpenAI key yet");
  const mCur = models.find((m) => m.id === o.model) || models[0] || { hint: "" };
  const mHint = (m) =>
    reach(m)
      ? m.hint || ""
      : access[m.id] && access[m.id].known
        ? "Not available on this OpenAI key: its model list does not carry it. It is offered here once the key can use it."
        : "Not checked on this OpenAI key yet: it is offered once the key's model list shows it.";
  const mOpt = (m) =>
    `<option value="${esc(m.id)}" data-hint="${esc(mHint(m))}"${m.id === o.model ? " selected" : ""}${reach(m) || m.id === o.model ? "" : " disabled"}>${esc(
      (m.label || m.id) + " · " + (reach(m) ? m.short || "" : away(m)) + (m.id === o.model ? " · current" : "")
    )}</option>`;
  const modelRow = V.row(
    "Voice model",
    `Holds the live conversation. Replies are read aloud by the voice model when it reads word for word; otherwise by <code>gpt-realtime-2.1-mini</code>, so read-aloud never paraphrases. <span class="muted" id="voice-listen-note">Your words are written down by the transcription model below: MINT AI always works from that transcript, never from the voice model's retelling.</span>`,
    `<div class="tr-pick">${V.form(
      `${BASE}/options`,
      csrf,
      `<select name="model" id="voice-model" aria-label="Voice model"${on ? "" : " disabled"}>${models.map(mOpt).join("")}</select>`
    )}<small class="tr-hint" id="voice-model-hint">${esc(mHint(mCur))}</small></div>`,
    { dep: true, scope: "everyone", id: "v-model" }
  );

  const token = set
    ? `<span class="kv-mask">${icon("lock", 15)}<span>••••••••••••••••••••</span><span class="pill ok">set</span></span>
       <button type="button" class="btn small" data-modal-open="m-voice-token" id="voice-token-replace">Replace</button>
       ${V.form(`${BASE}/clear`, csrf, `<button class="btn small danger" type="submit" id="voice-remove">${icon("trash", 14)} Remove</button>`, {
         noSave: true,
         cls: "inline",
         confirm: "Remove the voice token?",
         confirmBody: "Voice stops at once for everyone until a token is added again. Typing keeps working.",
         confirmYes: "Remove token",
       })}`
    : `<span class="kv-mask">${icon("lock", 15)}<span>No token</span><span class="pill bad">not set</span></span>
       <button type="button" class="btn small primary" data-modal-open="m-voice-token" id="voice-token-replace">${icon("plus", 14)} Add token</button>`;
  const tokenRow = V.row(
    "Voice API token",
    "The OpenAI key. Written straight to a root-only file on the server and never shown again — only whether it is set.",
    `<div class="keybox">${token}</div>`,
    { id: "v-token" }
  );

  const testRow = V.row(
    "Check the voice",
    "Speaks one short line and transcribes it back with the transcription model — a real call, a fraction of a cent. It says which model answered and how long it took.",
    V.form(`${BASE}/test`, csrf, `<button class="btn small" type="submit" id="voice-test"${on && set ? "" : " disabled"}>${icon("play", 14)} Test</button>`, { noSave: true, cls: "inline" }),
    { dep: true }
  );
  const test = o.test
    ? `<div class="alert ${o.test.ok ? "good" : "bad"} test-out" id="voice-test-result">${icon(o.test.ok ? "check" : "alert")}<div><strong>${
        o.test.ok ? "Test passed." : "Test failed."
      }</strong> ${esc(o.test.text)}</div></div>`
    : "";

  const tr = o.transcription || { model: "gpt-4o-mini-transcribe", language: "auto" };
  const list = o.transcribers || [];
  const local = o.local || {};
  const installed = new Set(((local && local.models) || []).map((m) => m.model));
  const ready = (t) => t.kind === "openai" || (local.installed && installed.has(t.model));
  const cur = list.find((t) => t.id === tr.model) || list[0] || { hint: "" };
  const groups = [];
  for (const t of list) {
    let g = groups.find((x) => x.name === t.group);
    if (!g) groups.push((g = { name: t.group, items: [] }));
    g.items.push(t);
  }
  const trOpt = (t) =>
    `<option value="${esc(t.id)}" data-hint="${esc(t.hint)}"${t.id === tr.model ? " selected" : ""}${ready(t) || t.id === tr.model ? "" : " disabled"}>${esc(t.label)} · ${esc(
      ready(t) ? t.hint : "not installed on this server"
    )}</option>`;
  const notInstalled = list.some((t) => t.kind !== "openai" && !ready(t));
  const trRow = V.row(
    "Transcription",
    `Writes down what you say — the transcript MINT AI works from, in a live call and in dictation. A model on this server costs nothing but is slower; if it is down, too slow or returns junk, that turn goes to <code>gpt-4o-mini-transcribe</code> instead. <span class="muted" id="voice-session-note">Inside a live call OpenAI accepts only its own models, so the call's running transcript stays on <code>${esc(
      listen
    )}</code> whichever you pick.</span>${
      notInstalled ? ` <span class="muted" id="voice-local-note">Models on this server are installed with <code>deploy/install-voice-whisper.sh</code>.</span>` : ""
    }`,
    `<div class="tr-pick">${V.form(
      `${BASE}/transcription`,
      csrf,
      `<select name="transcriber" id="voice-transcriber" aria-label="Transcription model"${on ? "" : " disabled"}>${groups
        .map((g) => `<optgroup label="${esc(g.name)}">${g.items.map(trOpt).join("")}</optgroup>`)
        .join("")}</select>`
    )}<small class="tr-hint" id="voice-transcriber-hint">${esc(cur.hint || "")}</small></div>`,
    { dep: true, scope: "everyone", id: "v-transcribe" }
  );
  const langRow = V.row(
    "Transcription language",
    "Detect suits a mix of Arabic and English. Pin one only if you speak just that language: pinned to Arabic, English comes out as Arabic words; pinned to English, Arabic is translated. On this server, Detect can translate the Arabic half of a mixed turn into English.",
    V.form(`${BASE}/transcription`, csrf, `<select name="language" aria-label="Transcription language"${on ? "" : " disabled"}>${(o.languages || [["auto", "Detect"]])
      .map(([v, l]) => V.opt(v, l + (v === "auto" ? " (default)" : ""), tr.language))
      .join("")}</select>`),
    { dep: true, scope: "everyone", id: "v-transcribe-lang" }
  );

  const main = `<div class="group" id="v-main">${hero}${offnote}${modelRow}${trRow}${langRow}${tokenRow}${testRow}${test}</div>`;

  const hiddenNote = `<p class="hidden-note">${icon("info", 16)}Voice, Live audio and Spend are hidden while voice is off. Their values are kept.</p>`;

  const cards = o.voices.map((n) => voiceCard(n, o.voice, o.meta[n])).join("");
  const p = o.persona || {};
  const pcur = p.mode === "explicit" ? p.preset : "learned";
  const voiceGroup = V.group(
    "Voice",
    "voice",
    V.row(
      "Voice",
      "How MINT AI sounds. Changing it reconnects an open call in the new voice.",
      V.form(`${BASE}/options`, csrf, `<div class="voice-cards" role="radiogroup" aria-label="Voice">${cards}</div>`, { cls: "voice-form" }),
      { full: true, scope: "everyone", id: "v-voice" }
    ) +
      V.row(
        "Arabic persona",
        `How it speaks Arabic. It answers in the language you last used; English stays plain English. It is always MINT AI and never claims to be human.${
          p.choice ? ` <span class="muted">Now: ${esc(p.choice)}${p.mode !== "explicit" && p.dialect ? ` · ${esc(p.dialect)}` : ""}.</span>` : ""
        }`,
        V.form(`${BASE}/persona`, csrf, `<select name="preset" aria-label="Arabic persona">${PERSONAS.map(([v, l]) => V.opt(v, l, pcur)).join("")}</select>`) +
          V.form(`${BASE}/persona/reset`, csrf, `<button class="btn small" type="submit" id="voice-persona-reset">Reset</button>`, {
            noSave: true,
            cls: "inline",
            confirm: "Reset the voice persona?",
            confirmBody: "It learns again from how you speak, starting from nothing.",
            confirmYes: "Reset",
          }),
        { scope: "you", id: "v-persona" }
      ) +
      V.row(
        "Read replies aloud",
        "Typed conversations too: MINT AI's replies are read in the same voice, by the voice model, as they stream.",
        // This browser's choice (localStorage "mint-read-aloud"), set by public/mint-settings-voice.js
        // and read by the Command Center; the Command Center's speaker button switches the same one.
        `<label class="sw"><input type="checkbox" id="voice-read-aloud" data-read-aloud aria-label="Read replies aloud in this browser"><span class="tr"></span><span class="on-t">On</span><span class="off-t">Off</span></label>`,
        { scope: "this browser", id: "v-read" }
      )
  );

  const a = o.liveAudio || {};
  const liveGroup = V.group(
    "Live conversation audio",
    "network",
    V.row(
      "Speaker handling",
      "Speakers mode pauses the microphone while MINT AI speaks, so laptop speakers never make it interrupt itself — interrupt with a tap, Space or Esc. Headphones mode lets you talk over it.",
      V.form(`${BASE}/live-audio`, csrf, V.seg("duplex", [["speakers", "Speakers"], ["full", "Headphones"]], a.duplex === "full" ? "full" : "speakers")),
      { scope: "default · each browser can switch", id: "v-live-audio" }
    ) +
      V.row(
        "Noise reduction",
        "OpenAI's filter on the microphone.",
        V.form(`${BASE}/live-audio`, csrf, `<select name="noise" aria-label="Noise reduction">${NOISE.map(([v, l]) => V.opt(v, l, a.noise || "far_field")).join("")}</select>`),
        { scope: "everyone", id: "v-noise" }
      ) +
      V.row("Call limits", "Saying “stop listening”, Esc, or the red End ends a call.", `<span class="muted-num">20 min a call · one call at a time</span>`)
  );

  const u = o.usage && !o.usage.error && o.usage.today ? o.usage : null;
  const spendGroup = V.group(
    "Spend",
    "activity",
    V.row(
      "Voice spend",
      "From the usage OpenAI reports, at today's prices. The daily token caps are in Usage &amp; budget.",
      `<span class="muted-num" id="voice-spend">${u ? `today ${esc(usd(u.today.total))} · month ${esc(usd(u.month_totals.total))}` : "not available"}</span>`,
      { id: "v-spend" }
    ) +
      V.row(
        "Compare voices",
        "Record your own voice and compare models and voices side by side.",
        `<a class="btn small" href="/mint-ai/voice-eval" id="voice-eval-link">${icon("voice", 14)} Voice evaluation</a>`
      ) +
      V.row(
        "Voiceprint trial",
        "Record a short trial set so we can measure how well your own voice can be recognised. Stays on this server.",
        `<a class="btn small" href="/mint-ai/voiceprint-trial" id="voiceprint-trial-link">${icon("fingerprint", 14)} Voiceprint trial</a>`
      )
  );

  const dialog = `<section class="cc-modal os narrow" id="m-voice-token" role="dialog" aria-modal="true" aria-labelledby="m-voice-token-t" hidden>
    <div class="cc-mh">${icon("lock", 18)}<div class="cc-min0"><h2 id="m-voice-token-t">${set ? "Replace the voice token" : "Add the voice token"}</h2><small>An OpenAI API key. A project key limited to the Realtime and Audio endpoints is enough.</small></div>
      <span class="cc-sp"><button type="button" class="cc-ibtn" data-modal-close aria-label="Close">${icon("close", 16)}</button></span></div>
    <form method="post" action="${BASE}/key" autocomplete="off" id="voice-key-form">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <div class="mb"><label>OpenAI API key <span class="hint">written straight to a root-only file and never shown again</span>
        <input name="value" type="password" placeholder="sk-proj-…" required autocomplete="new-password" spellcheck="false" minlength="20"></label></div>
      <div class="mf"><span class="sp"></span><button type="button" class="btn" data-modal-close>Cancel</button><button class="btn primary" type="submit" id="voice-key-save">Save token</button></div>
    </form></section>`;

  return (
    V.head(
      "Voice",
      "Talk with MINT AI in a live conversation: you speak, it answers at once, and you can interrupt it. OpenAI hears and speaks; MINT AI thinks and acts. One switch turns voice on or off for everyone."
    ) +
    main +
    hiddenNote +
    `<div class="dep-hide">${voiceGroup}${voiceprintGroup(o)}${liveGroup}${spendGroup}</div>` +
    dialog
  );
}

module.exports = { body, voiceCard, voiceprintGroup, GENDER, BASE };
