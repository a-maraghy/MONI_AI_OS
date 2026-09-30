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
 * One voice model (2026-09-30): the model talks live and reads replies aloud.
 * What the administrator said is written down by the Transcription model, a
 * setting again since the evening of 2026-09-30: OpenAI's, or whisper.cpp on
 * this server (lib/voice-transcribe.js), each option with its measured speed,
 * accuracy and cost; a local model that is not installed is listed, disabled.
 *
 * Anchors (the page registry scans them): v-model, v-transcribe,
 * v-transcribe-lang, v-token, v-voice, v-persona, v-read, v-live-audio, v-spend.
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
 *   models        [{id, label}]
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
  const modelRow = V.row(
    "Voice model",
    `One model for the whole voice: it holds the live conversation and reads MINT AI's replies aloud, word for word. <span class="muted" id="voice-listen-note">Your words are written down by the transcription model below: MINT AI always works from that transcript, never from the voice model's retelling.</span>`,
    V.form(
      `${BASE}/options`,
      csrf,
      `<select name="model" aria-label="Voice model"${on ? "" : " disabled"}>${o.models
        .map((m) => V.opt(m.id, (m.label || m.id) + (m.id === o.model ? " · current" : ""), o.model))
        .join("")}</select>`
    ),
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
    `<div class="dep-hide">${voiceGroup}${liveGroup}${spendGroup}</div>` +
    dialog
  );
}

module.exports = { body, voiceCard, GENDER, BASE };
