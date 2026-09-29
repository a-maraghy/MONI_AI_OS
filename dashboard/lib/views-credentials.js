"use strict";
/**
 * Credential management.
 *
 * The panel shows whether a credential is set, and lets it be replaced. It
 * deliberately never displays one: a token rendered into a page is a token in a
 * screenshot, a proxy log, and a browser scrollback. What you get instead is
 * enough to answer "is this configured, and is it the one I think it is" — a
 * length and the first and last few characters.
 */

const { esc, shell, card, flashes, icon, stamp, can, docLayout, tocCard } = require("./ui");

/**
 * The master list beside every credential page: each credential this panel
 * manages, with a dot for whether it is set. The voice key is listed only for
 * those who may manage it.
 */
function credNav(user, credentials, active, voiceConfigured) {
  const items = (credentials || []).map(
    (c) => `<a href="/credentials/${esc(c.name)}"${active === c.name ? ' class="on" aria-current="page"' : ""}>
      <span class="cred-ic">${icon("credentials", 16)}</span><span><b>${esc(c.label || c.name)}</b><small>${esc(
        String(c.path || c.name).split("/").pop()
      )}</small></span><span class="dot${c.configured ? "" : " off"}"></span></a>`
  );
  if (can(user, "voice.manage")) {
    items.push(`<a href="/credentials/openai-voice"${active === "openai-voice" ? ' class="on" aria-current="page"' : ""}>
      <span class="cred-ic">${icon("voice", 16)}</span><span><b>OpenAI voice</b><small>voice only</small></span>${
        voiceConfigured == null ? "<span></span>" : `<span class="dot${voiceConfigured ? "" : " off"}"></span>`
      }</a>`);
  }
  return `<section class="card hud cred-list" aria-label="Credentials">
    <div class="card-head"><h2>${icon("credentials")}Credentials</h2>${
      active ? `<a class="small" href="/credentials">All</a>` : ""
    }</div>${items.join("")}</section>`;
}

/**
 * The OpenAI voice key, as a card on the index. Only the last four characters
 * are ever shown -- enough to tell which key it is, not enough to use it.
 */
function voiceSummary(v) {
  if (!v) return "";
  if (v.error) {
    return card(
      "OpenAI voice",
      `<div class="alert warn">${icon("alert")}<div>Could not read the voice settings: ${esc(v.error)}</div></div>`,
      { icon: "voice" }
    );
  }
  return card(
    "OpenAI voice",
    `<table class="kv" id="openai-voice">
      <tr><td>Status</td><td>${
        v.configured
          ? `<span class="pill ok">configured</span> <span class="mono small muted">key ending ${esc(v.last4 || "····")}</span>`
          : `<span class="pill bad">not set</span>`
      }</td></tr>
      <tr><td>Speaks with</td><td class="mono small">${esc(v.model)} · ${esc(v.voice)}</td></tr>
      <tr><td>Hears with</td><td class="mono small">${esc(v.transcribe_model)}</td></tr>
    </table>
    <p class="muted small mt-12">Voice only: OpenAI hears you and reads MINT AI's replies aloud.
      Claude does all the thinking. The key stays on the server.</p>
    <div class="btn-row">
      <a class="btn primary small" href="/credentials/openai-voice">
        ${icon(v.configured ? "edit" : "plus")} ${v.configured ? "Manage" : "Add an OpenAI key"}</a>
    </div>`,
    { icon: "voice" }
  );
}

exports.index = ({ csrf, user, credentials, probe, flash, err, voice }) =>
  shell(
    "Credentials",
    `${flashes({ msg: flash, err })}
    ${
      probe && !probe.claude_credential
        ? `<div class="alert warn">${icon("alert")}<div>No Claude credential is set.
           Agents will start, receive messages, and then fail to answer — the logs say
           <em>authentication</em> when this is the cause.</div></div>`
        : ""
    }
    ${
      probe && (probe.credential_stale_agents || []).length
        ? `<div class="alert warn">${icon("alert")}<div>
           ${probe.credential_stale_agents.map(esc).join(", ")} started before the
           credential was last changed, so
           ${probe.credential_stale_agents.length === 1 ? "it is" : "they are"} still
           using the old one. Saving a credential here restarts agents automatically;
           this one predates that. Restart from
           <a href="/services/agents">Agent services</a>.</div></div>`
        : ""
    }

    ${docLayout(`${voiceSummary(voice)}

    ${credentials
      .map((c) =>
        card(
          c.label,
          `<table class="kv">
            <tr><td>Status</td><td>${
              c.configured
                ? `<span class="pill ok">configured</span>`
                : `<span class="pill bad">not set</span>`
            }</td></tr>
            <tr><td>File</td><td class="mono small">${esc(c.path)}</td></tr>
            <tr><td>Accepted keys</td><td class="mono small">${c.keys.map(esc).join("<br>")}</td></tr>
          </table>
          <div class="btn-row">
            <a class="btn primary small" href="/credentials/${esc(c.name)}">
              ${icon("edit")} ${c.configured ? "Replace" : "Set"}</a>
          </div>`,
          { icon: "credentials", className: "hud" }
        )
      )
      .join("")}`, credNav(user, credentials, null, voice && !voice.error ? !!voice.configured : null))}`,
    {
      user,
      csrf,
      active: "credentials",
      pattern: "c",
      heading: "Credentials",
      subtitle:
        "Secrets the agents need. Stored on disk readable only by the agent account, never displayed back.",
    }
  );

exports.detail = ({ csrf, user, credential, credentials, flash, err }) => {
  const c = credential;
  const present = c.present || {};
  const toc = [["c-state", "Current state"], ["c-file", "File contents"], ["c-set", "Set a value"]];
  if (c.name === "claude") toc.push(["c-where", "Where to get this"]);
  if (Object.keys(present).length) toc.push(["c-remove", "Remove"]);

  return shell(
    c.label,
    `${docLayout(`${flashes({ msg: flash, err })}

    ${card(
      "Current state",
      `<table class="kv">
        <tr><td>File</td><td class="mono small">${esc(c.path)}</td></tr>
        <tr><td>Exists</td><td>${c.exists ? "yes" : "no"}</td></tr>
        <tr><td>Permissions</td><td class="mono small">${esc(c.mode || "—")}</td></tr>
        <tr><td>Last changed</td><td class="mono small">${esc(stamp(c.modified))}</td></tr>
        ${c.keys
          .map(
            (k) =>
              `<tr><td>${esc(k)}</td><td>${
                present[k]
                  ? `<span class="pill ok">set</span>
                     <span class="mono small muted"> ${esc(present[k].preview)} · ${
                      present[k].length
                    } chars</span>`
                  : `<span class="pill neutral">empty</span>`
              }</td></tr>`
          )
          .join("")}
      </table>`,
      { icon: "info", id: "c-state", className: "hud" }
    )}

    ${card(
      "File contents",
      `<p class="muted small">Secret values are masked. Comments and other lines are shown as they are.</p>
       <pre>${esc(c.masked || "(file does not exist yet)")}</pre>`,
      { icon: "file", id: "c-file" }
    )}

    ${card(
      "Set a value",
      `<form method="post" action="/credentials/${esc(c.name)}" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Key
          <select name="key">
            ${c.keys
              .map((k) => `<option value="${esc(k)}">${esc(k)}</option>`)
              .join("")}
          </select></label>
        <label>Value <span class="hint">written straight to the file and never shown again</span>
          <input name="value" type="password" placeholder="sk-ant-..." required></label>
        <button class="btn primary" type="submit">${icon("save")} Save credential</button>
      </form>
      <p class="muted small mt-12">Setting one key clears the other —
        the runtime uses whichever it finds, and having both set makes it ambiguous which
        one is actually in use.</p>`,
      { icon: "credentials", id: "c-set", className: "hud" }
    )}

    ${
      c.name === "claude"
        ? card(
            "Where to get this",
            `<p>A subscription token is the usual choice — it bills against your Claude plan
              rather than per token.</p>
            <ol class="steps">
              <li>On a machine with a browser, run <code>claude setup-token</code></li>
              <li>Log in and approve when the browser opens</li>
              <li>Copy the <code>sk-ant-oat01-…</code> value it prints and paste it above,
                  with the key set to <code>CLAUDE_CODE_OAUTH_TOKEN</code></li>
            </ol>
            <p class="muted small">Prefer pay-as-you-go API billing instead? Use
              <code>ANTHROPIC_API_KEY</code> with a key from the Anthropic console.</p>
            <div class="alert info">${icon("info")}<div>Changing this affects every agent —
              they all authenticate with the same credential. Running agents pick it up on
              their next restart.</div></div>`,
            { icon: "guide", id: "c-where" }
          )
        : ""
    }

    ${
      Object.keys(present).length
        ? card(
            "Remove",
            `<p class="muted small">Clearing the credential stops every agent from being
              able to answer. They keep running and keep receiving messages.</p>
            ${c.keys
              .filter((k) => present[k])
              .map(
                (k) => `<form method="post" action="/credentials/${esc(c.name)}/clear" class="inline"
                       data-confirm="Clear ${esc(k)}? Every agent stops being able to answer.">
                  <input type="hidden" name="_csrf" value="${esc(csrf)}">
                  <input type="hidden" name="key" value="${esc(k)}">
                  <button class="btn danger small" type="submit">${icon("trash")} Clear ${esc(k)}</button>
                </form>`
              )
              .join(" ")}`,
            { icon: "trash", className: "danger-zone", id: "c-remove" }
          )
        : ""
    }`, credNav(user, credentials || [c], c.name, null) + tocCard(toc))}`,
    {
      user,
      csrf,
      active: "credentials",
      pattern: "c",
      crumbs: [["OS Dashboard", "/os"], ["Security", null], ["Credentials", "/credentials"], [c.label, null]],
      heading: c.label,
      subtitle: "Shared by every agent on this machine.",
      actions: `<a class="btn" href="/credentials">${icon("chevron")} All credentials</a>`,
    }
  );
};

/* --------------------------------------------------------- openai voice -- */

function option(value, label, current) {
  return `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`;
}

/**
 * The voice front desk switch (trial). Off by default; while off the voice is
 * exactly the direct path. Rendered only on the voice page, which is already
 * administrators-only (voice.manage).
 */
function deskCard(csrf, v, desk) {
  const d = desk || { on: false };
  const row = d.row;
  const u = d.usage && d.usage.today ? d.usage : null;
  const usd = (n) => "$" + (Number(n) || 0).toFixed(4);
  const spend = u
    ? `<p class="small mt-12" id="voice-usage-state"><span class="pill neutral">voice spend</span>
        <span class="muted">Today (Cairo) <b>${esc(usd(u.today.total))}</b>, this month <b>${esc(usd(u.month_totals.total))}</b>, from the usage
        OpenAI reports, at the prices read ${esc(u.prices.read)}. No cap: the split by kind of turn is in the Command Center's Cost today card.</span></p>`
    : "";
  return card(
    "Voice front desk (GPT)",
    `<p class="small"><span class="pill ${d.on ? "warn" : "neutral"}" id="voice-desk-state">${d.mode === "live" ? "live conversation — trial" : d.on ? "on — trial" : "off"}</span>
      <span class="muted">${row ? "Last changed " + esc(stamp(row.updated_at)) + (row.updated_by ? " by " + esc(row.updated_by) : "") : "Never switched on."}</span></p>
    <p class="muted small mt-12">A trial. When on, the Command Center's microphone talks to a GPT realtime model
      (${esc(d.model || "gpt-realtime-mini")}) that answers at once from a read-only snapshot of this VPS — services,
      disk, memory, sessions, missions, open decisions and pending approvals, counted and titled, never a command —
      makes brief small talk, and works on everything else as your request. It is MINT AI's voice and speaks as MINT AI,
      in the first person ("give me a moment, I'm checking", then "I found..."); the thinking and any action are MINT AI's
      real work, behind it. The voice itself cannot run anything, message a session, or approve or deny anything; a guard
      checks every sentence before it is spoken and cuts it off if it claims an action, a finding or a figure it was not
      given. Results are summarised aloud, held to what was actually written — the full text stays on screen. When off,
      voice goes straight to MINT AI.</p>
    <form method="post" action="/credentials/openai-voice/desk" class="btn-row">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <input type="hidden" name="enabled" value="${d.on ? "0" : "1"}">
      <button class="btn ${d.on ? "" : "primary "}small" type="submit" id="voice-desk-toggle"${v.configured || d.on ? "" : " disabled"}>
        ${icon(d.on ? "close" : "play")} ${d.on ? "Switch the front desk off" : "Switch the front desk on"}</button>
      ${v.configured ? "" : `<span class="muted small">Needs the OpenAI key above.</span>`}
    </form>
    <h3 class="mt-16" id="v-live">Live conversation (trial)</h3>
    <p class="muted small">A third mode, for administrators only, off unless chosen here. You talk and it answers at once, and you can
      interrupt it: the microphone streams to this server, which relays it to ${esc(d.liveModel || "gpt-realtime-2.1-mini")} and plays back
      only the sentences the same guard has passed. It is MINT AI's voice, speaking as MINT AI in the first person; results are read from
      MINT AI's own text (a checked summary or word for word), never made up by the voice model, and requests are worked on in your own
      words, as this server heard them. The voice can do nothing else, and saying "stop listening" ends it. At most 20 minutes a call, one call at a time. With laptop speakers the voice can leak into the
      microphone, so by default the microphone pauses while the voice speaks (speakers mode); with headphones, headphones mode lets
      you talk over it. Other users, and push to talk, keep the relay desk.</p>
    <form method="post" action="/credentials/openai-voice/desk" class="btn-row">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <input type="hidden" name="mode" value="${d.mode === "live" ? "desk" : "live"}">
      <button class="btn small" type="submit" id="voice-live-toggle"${v.configured || d.mode === "live" ? "" : " disabled"}>
        ${icon(d.mode === "live" ? "close" : "play")} ${d.mode === "live" ? "Back to the relay desk" : "Switch to live conversation (trial)"}</button>
      <a class="btn small" href="/mint-ai/voice-eval" id="voice-eval-link">${icon("voice")} Evaluate models and voices with your own voice</a>
    </form>
    ${liveAudioForm(csrf, d.liveAudio || {})}
    ${spend}
`,
    { icon: "voice", id: "v-desk" }
  );
}

/**
 * The voice persona: learned from how this administrator speaks, or chosen
 * from a fixed list (lib/voice-persona.js PRESETS). There is deliberately no
 * field to type one in.
 */
/** Live conversation: how it handles the speaker, and OpenAI's noise reduction. */
const LIVE_DUPLEX_CHOICES = [
  ["speakers", "Speakers mode (default)", "The microphone is not heard while the voice speaks, so laptop speakers can never make it interrupt itself. Interrupt it with a tap on the bar, Space or Esc."],
  ["full", "Headphones mode", "Talk over the voice to interrupt it. The page plays through the browser's echo canceller and only sustained speech above the speaker's leak interrupts; if it still hears itself it suggests speakers mode."],
];
const LIVE_NOISE_CHOICES = [
  ["far_field", "Far field (laptop or room microphone, default)"],
  ["near_field", "Near field (headset microphone)"],
  ["off", "Off"],
];
function liveAudioForm(csrf, a) {
  const duplex = a.duplex || "speakers";
  const noise = a.noise || "far_field";
  return `<form method="post" action="/credentials/openai-voice/live-audio" class="mt-8" id="voice-live-audio">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <fieldset class="radio-list"><legend class="small">Speaker handling (the default; each browser can switch from the live bar)</legend>
        ${LIVE_DUPLEX_CHOICES.map(([v, label, help]) => `<label class="radio-row"><input type="radio" name="duplex" value="${v}"${v === duplex ? " checked" : ""}><span><b>${esc(label)}</b><br><span class="muted small">${esc(help)}</span></span></label>`).join("")}
      </fieldset>
      <fieldset class="radio-list"><legend class="small">Noise reduction (OpenAI, on the microphone's audio)</legend>
        ${LIVE_NOISE_CHOICES.map(([v, label]) => `<label class="radio-row"><input type="radio" name="noise" value="${v}"${v === noise ? " checked" : ""}><span>${esc(label)}</span></label>`).join("")}
      </fieldset>
      <button class="btn small" type="submit" id="voice-live-audio-save">${icon("check")} Save live audio</button>
    </form>`;
}

const PERSONA_CHOICES = [
  ["learned", "Learn from how I speak", "The register and how it refers to itself follow how you speak to it (the default)."],
  ["cairene_f", "Cairene Egyptian — feminine", "Arabic replies in Cairo colloquial, feminine first person (أنا جاهزة، حاضر), warm; English terms in Latin script."],
  ["cairene_m", "Cairene Egyptian — masculine", "Arabic replies in Cairo colloquial, masculine first person (أنا جاهز، حاضر); English terms in Latin script."],
  ["msa_n", "Modern Standard Arabic — neutral", "Arabic replies in MSA, gender-neutral phrasing for itself."],
];
function personaCard(csrf, p) {
  const x = p || { mode: "learned", preset: null, choice: "Learn from how I speak", dialect: "not known yet", gender: "not known yet (gender-neutral)", updated_at: null };
  const cur = x.mode === "explicit" ? x.preset : "learned";
  const opts = PERSONA_CHOICES.map(
    ([v, label, hint]) =>
      `<label class="radio-row"><input type="radio" name="preset" value="${v}"${v === cur ? " checked" : ""}> <b>${esc(label)}</b> <span class="muted small" dir="auto">${esc(hint)}</span></label>`
  ).join("");
  return card(
    "Voice persona",
    `<p class="muted small">How the voice speaks Arabic, in the front desk and in live conversation. It always answers in the language
      you last used — English stays plain English — and it is always MINT AI's voice: it never claims to be human. Learned, it follows how
      you speak and changes only when your speech clearly shows a change; chosen, it stays as chosen until you change it here.</p>
    <table class="kv mt-12" id="voice-persona">
      <tr><td>Now</td><td id="voice-persona-choice">${esc(x.choice)}</td></tr>
      <tr><td>Arabic register</td><td id="voice-persona-dialect">${esc(x.dialect)}</td></tr>
      <tr><td>How it refers to itself</td><td id="voice-persona-gender">${esc(x.gender)}</td></tr>
      <tr><td>${x.mode === "explicit" ? "Chosen" : "Last learned"}</td><td class="mono small">${x.updated_at ? esc(stamp(x.updated_at)) : "—"}</td></tr>
    </table>
    <form method="post" action="/credentials/openai-voice/persona" class="mt-12" id="voice-persona-form">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <fieldset class="radio-list"><legend class="small">Arabic persona</legend>${opts}</fieldset>
      <div class="btn-row mt-12"><button class="btn primary small" type="submit" id="voice-persona-save">${icon("save")} Save</button></div>
    </form>
    <form method="post" action="/credentials/openai-voice/persona/reset" class="btn-row mt-12">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <button class="btn small" type="submit" id="voice-persona-reset">${icon("close")} Reset</button>
      <span class="muted small">Back to learning from how you speak, starting from nothing.</span>
    </form>`,
    { icon: "voice", id: "v-persona" }
  );
}

/** How each voice sounds, for the voice cards. A word or two, not a promise. */
const VOICE_NOTES = {
  marin: "warm · clear · default",
  cedar: "low · calm",
  alloy: "neutral · even",
  ash: "soft · steady",
  ballad: "gentle · lilting",
  coral: "bright · friendly",
  echo: "crisp · measured",
  sage: "calm · unhurried",
  shimmer: "light · airy",
  verse: "bright · quick",
};

exports.voice = ({ csrf, user, credentials, voice: v, desk, persona, models, voices, transcribeModels, test, flash, err }) => {
  const known = (list, id) => list.some((m) => (m.id || m) === id);
  const modelList = known(models, v.model) ? models : [{ id: v.model, label: v.model }, ...models];
  const tModels = known(transcribeModels, v.transcribe_model)
    ? transcribeModels
    : [{ id: v.transcribe_model, label: v.transcribe_model }, ...transcribeModels];
  const voiceList = voices.includes(v.voice) ? voices : [v.voice, ...voices];

  const toc = [["v-state", "Current state"], ["v-key", v.configured ? "Replace the key" : "Add the key"], ["v-voice", "Voice"], ["v-desk", "Voice front desk"], ["v-persona", "Voice persona"]];
  if (v.configured) toc.push(["v-remove", "Remove"]);
  return shell(
    "OpenAI voice",
    `${docLayout(`${flashes({ msg: flash, err })}
    ${
      test
        ? `<div class="alert ${test.ok ? "good" : "bad"}" id="voice-test-result">${icon(test.ok ? "check" : "alert")}<div>
            ${test.ok ? "<strong>Test passed.</strong> " : "<strong>Test failed.</strong> "}${esc(test.text)}</div></div>`
        : ""
    }

    ${card(
      "Current state",
      `<table class="kv">
        <tr><td>Key</td><td>${
          v.configured
            ? `<span class="pill ok">set</span> <span class="mono small muted">••••${esc(v.last4 || "")} · ${esc(v.length)} chars</span>`
            : `<span class="pill bad">not set</span> <span class="muted small">voice controls stay off until one is added</span>`
        }</td></tr>
        <tr><td>Stored in</td><td class="mono small">${esc(v.path || "")} ${v.mode ? "(" + esc(v.mode) + ", root only)" : ""}</td></tr>
        <tr><td>Last changed</td><td class="mono small">${esc(stamp(v.modified))}</td></tr>
      </table>
      ${
        v.configured
          ? `<form method="post" action="/credentials/openai-voice/test" class="btn-row">
              <input type="hidden" name="_csrf" value="${esc(csrf)}">
              <button class="btn small" type="submit" id="voice-test">${icon("play")} Test</button>
              <span class="muted small">Speaks one short line and transcribes it back — a real call, a fraction of a cent.</span>
            </form>`
          : ""
      }`,
      { icon: "info", id: "v-state", className: "hud" }
    )}

    ${card(
      v.configured ? "Replace the key" : "Add the key",
      `<form method="post" action="/credentials/openai-voice/key" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>OpenAI API key <span class="hint">written straight to a root-only file and never shown again</span>
          <input name="value" type="password" placeholder="sk-proj-…" required autocomplete="new-password" spellcheck="false"></label>
        <button class="btn primary" type="submit">${icon("save")} ${v.configured ? "Replace key" : "Save key"}</button>
      </form>
      <p class="muted small mt-12">Create one at platform.openai.com under API keys. A project key
        restricted to the Realtime and Audio endpoints is enough. This is the panel's own key —
        separate from anything the Odoo walkthrough uses.</p>`,
      { icon: "credentials", id: "v-key" }
    )}

    ${card(
      "Voice",
      `<form method="post" action="/credentials/openai-voice/options">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Speaking model <span class="hint">reads Claude's replies aloud, word for word</span>
          <select name="model">${modelList.map((m) => option(m.id, m.label + " (" + m.id + ")", v.model)).join("")}</select></label>
        <fieldset class="voice-pick"><legend>Voice</legend>
          <div class="voice-cards">${voiceList
            .map(
              (x) => `<label class="voice-card"><input type="radio" name="voice" value="${esc(x)}"${x === v.voice ? " checked" : ""}><b>${esc(
                x.charAt(0).toUpperCase() + x.slice(1)
              )}</b><span>${esc(VOICE_NOTES[x] || "")}</span></label>`
            )
            .join("")}</div></fieldset>
        <label>Listening model <span class="hint">turns what you say into text</span>
          <select name="transcribe_model">${tModels.map((m) => option(m.id, m.label + " (" + m.id + ")", v.transcribe_model)).join("")}</select></label>
        <button class="btn primary" type="submit">${icon("save")} Save voice settings</button>
      </form>`,
      { icon: "voice", id: "v-voice" }
    )}

    ${deskCard(csrf, v, desk)}
    ${personaCard(csrf, persona)}

    ${
      v.configured
        ? card(
            "Remove",
            `<p class="muted small">Voice stops at once: the microphone and read-aloud controls show
              “Add an OpenAI key in Settings” until a key is added again. Typing keeps working.</p>
            <form method="post" action="/credentials/openai-voice/clear" class="inline"
                  data-confirm="Remove the OpenAI key? Voice stops working until a key is added again.">
              <input type="hidden" name="_csrf" value="${esc(csrf)}">
              <button class="btn danger small" type="submit" id="voice-remove">${icon("trash")} Remove key</button>
            </form>`,
            { icon: "trash", className: "danger-zone", id: "v-remove" }
          )
        : ""
    }`, credNav(user, credentials, "openai-voice", !!v.configured) + tocCard(toc))}`,
    {
      user,
      csrf,
      active: "credentials",
      pattern: "c",
      crumbs: [["OS Dashboard", "/os"], ["Security", null], ["Credentials", "/credentials"], ["OpenAI voice", null]],
      heading: "OpenAI voice",
      subtitle: "Voice only: OpenAI hears and speaks, Claude thinks. Administrators only.",
      actions: `<a class="btn" href="/credentials">${icon("chevron")} All credentials</a>`,
    }
  );
};
