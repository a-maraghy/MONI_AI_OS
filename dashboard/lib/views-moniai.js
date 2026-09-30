"use strict";
/**
 * The MINT AI Command Center, simplified (Mint, 2026-09-29).
 *
 * One quiet screen: the MINT AI core in the middle (a WebGL canvas, three
 * concepts -- A dotted sphere, B Siri fluid, C hybrid -- chosen per person in
 * Settings and switchable any time), the live sessions as points on a faint
 * orbit round it, a one-line caption under it saying what is happening, and
 * one pill composer with voice. Everything else is one tap away: the faint
 * icon bar on the left opens sheets from the right (Conversation, Sessions,
 * Missions, Decisions, Timeline, Rules & watchers, Standing orders, Cost &
 * voice usage, Machine); on a phone a grid button opens them all. Anything that
 * needs a decision appears as one card, top right.
 *
 * Everything that changes is filled in by public/moni-ai.js (with cc-logic.js,
 * mint-core.js, cc-map.js and cc-panels.js) from the JSON and SSE API under
 * /mint-ai/api/ -- this renders the frame, the labels and the few facts the
 * server already knows (who is looking, whether a voice is installed, which
 * core they chose), all escaped here. No inline script, style or handler
 * anywhere: the CSP refuses them. The chosen core is written as data-core on
 * #cc, so the right one is drawn from the first frame.
 *
 * Only this VPS is shown. The live Odoo server appears nowhere on this page.
 */

const { esc, shell, card, asset, dockMarkup } = require("./ui");
const marks = require("./marks");
const logic = require("../public/cc-logic");
const UiActions = require("../public/ui-actions");

/* Icons for the page, as one sprite referenced by <use>. */
const SPRITE = {
  core: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',
  sessions: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  agents: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  memory: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  remote: '<path d="M5 12a7 7 0 0 1 14 0"/><path d="M8.5 12a3.5 3.5 0 0 1 7 0"/><circle cx="12" cy="15" r="1.5"/><path d="M12 16.5V21"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12.5 15h4.5"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7Z"/><path d="M11 13l9-9"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5"/>',
  chev: '<path d="M6 15l6-6 6 6"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  delegate: '<path d="M4 12h11"/><path d="M11 7l5 5-5 5"/><path d="M20 5v14"/>',
  check: '<path d="M5 12.5 10 17.5 19.5 7"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6Z"/><path d="M12 8v5M12 16.5h.01"/>',
  speaker: '<path d="M4 9.5h4l5-4v13l-5-4H4Z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3.5" y="14" width="4" height="6.5" rx="1.5"/><rect x="16.5" y="14" width="4" height="6.5" rx="1.5"/>',
  mute: '<path d="M4 9.5h4l5-4v13l-5-4H4Z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  message: '<path d="M4 5h16v11H8l-4 4V5Z"/><path d="M8 9h8M8 12.5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  orbit: '<circle cx="12" cy="12" r="2.5"/><ellipse cx="12" cy="12" rx="9.5" ry="5.5"/><circle cx="20" cy="9" r="1.4"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  play: '<path d="M7 5v14l11-7Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.6.8-2.6 2s1.1 1.6 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2c-1.2 0-2.2-.5-2.7-1.3M12 6.5V8M12 16v1.5"/>',
  scale: '<path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7 2.5 13a2.8 2.8 0 0 0 5 0Z"/><path d="M19 7l-2.5 6a2.8 2.8 0 0 0 5 0Z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  alert: '<path d="M12 3.5 2.5 20h19Z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  sun2: '<circle cx="12" cy="13" r="4"/><path d="M4 20h16M12 3v3M5 8l1.5 1.5M19 8l-1.5 1.5"/>',
  jump: '<path d="M5 12h12"/><path d="M13 7l5 5-5 5"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
};

/* Icons the simple Command Center added: the dock, the menus, the chevrons. */
Object.assign(SPRITE, {
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6Z"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  chevd: '<path d="M6 9l6 6 6-6"/>',
  chevl: '<path d="M15 6l-6 6 6 6"/>',
  chevr: '<path d="M9 6l6 6-6 6"/>',
  up: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  gauge: '<path d="M4.2 17.5a9 9 0 1 1 15.6 0"/><path d="M12 13.5l4-5"/><circle cx="12" cy="14" r="1.6"/>',
  spark: '<path d="M12 2.5c.6 4.6 2.9 6.9 9.5 9.5-6.6 2.6-8.9 4.9-9.5 9.5-.6-4.6-2.9-6.9-9.5-9.5 6.6-2.6 8.9-4.9 9.5-9.5Z"/>',
});

function ic(name, cls) {
  return `<svg class="cc-i${cls ? " " + cls : ""}" aria-hidden="true" focusable="false"><use href="#cc-i-${name}"/></svg>`;
}

function sprite() {
  return (
    `<svg class="cc-sprite" aria-hidden="true" focusable="false">` +
    Object.keys(SPRITE)
      .map((k) => `<symbol id="cc-i-${k}" viewBox="0 0 24 24">${SPRITE[k]}</symbol>`)
      .join("") +
    `</svg>`
  );
}

/** The brand spark at the heart of concept C (a DOM element the page places over the core). */
function sparkSvg() {
  return (
    `<svg viewBox="-26 -26 52 52" aria-hidden="true" focusable="false"><defs>` +
    `<radialGradient id="cc-spg" cx="0" cy="0" r="24" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".4" stop-color="#C9FFEC"/><stop offset="1" stop-color="#5FE8BF"/></radialGradient>` +
    `<linearGradient id="cc-spl" x1="-20" y1="20" x2="20" y2="-20" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00B884"/><stop offset=".55" stop-color="#1FA3B0"/><stop offset="1" stop-color="#7A2BD6"/></linearGradient>` +
    `</defs><path class="sp-d" d="${marks.spark(0, 0, 24, 24, 24)}" fill="url(#cc-spg)"/><path class="sp-l" d="${marks.spark(0, 0, 24, 24, 24)}" fill="url(#cc-spl)"/></svg>`
  );
}

/** One cell of the Machine sheet's MINT AI core grid. Values arrive from the page script. */
function coreCell(key, label) {
  return `<div data-cell="${key}"><span>${esc(label)}</span><b data-st>—</b></div>`;
}

/** A sheet behind the dock: its head (title, a line under it, actions, close) and body. */
function pane(key, title, sub, actions, body, foot) {
  return `<section class="cc-pane" id="cc-pane-${key}" data-sheet-pane="${key}" role="dialog" aria-labelledby="cc-h-${key}" tabindex="-1" hidden>
    <div class="sh-hd"><div class="cc-min0"><h2 id="cc-h-${key}">${esc(title)}</h2><div class="sub">${sub}</div></div><span class="sp"></span>${actions || ""}<button type="button" class="cc-ibtn" data-sheet-close title="Close (Esc)" aria-label="Close">${ic("close")}</button></div>
    <div class="sh-bd cc-scroll"${key === "conv" ? ' id="cc-chat-scroll"' : ""}>${body}</div>${foot ? `<div class="sh-ft">${foot}</div>` : ""}
  </section>`;
}

/** The dock: the sheets, in the order MintLogic.SHEETS gives them, then search. */
function dock() {
  const badge = { dec: `<span class="cc-badge-n warn" id="cc-dec-count" hidden>0</span>`, missions: `<span class="cc-badge-n" id="cc-mis-count" hidden>0</span>` };
  return (
    logic.SHEETS.map((s) =>
      s === "-"
        ? `<span class="sep" aria-hidden="true"></span>`
        : `<button type="button" data-sheet="${s.key}" aria-expanded="false" aria-label="${esc(s.label)}">${ic(s.icon)}${badge[s.key] || ""}<span class="tip">${esc(s.label)}</span></button>`
    ).join("") +
    `<span class="sep" aria-hidden="true"></span>` +
    `<button type="button" id="cc-kbtn" aria-label="Search or run (Ctrl+K)" aria-keyshortcuts="Control+K">${ic("search")}<span class="tip">Search or run · Ctrl K</span></button>`
  );
}

/** The core choice as three buttons (the voice menu and the Everything sheet use the same markup). */
function coreSwitch(core, cls) {
  return `<div class="cc-core-seg${cls ? " " + cls : ""}" role="radiogroup" aria-label="MINT AI core">${Object.keys(logic.CORES)
    .map((k) => `<button type="button" role="radio" data-core-set="${k}" aria-checked="${k === core}"><b>${k}</b><span>${esc(logic.CORES[k])}</span></button>`)
    .join("")}</div>`;
}

/* Top-bar additions, before the theme switch: the status chip, the amber
   "N need you" pill, the active mission, and the phone's Everything button.
   The clock goes after it. */
function topExtra() {
  return (
    `<span class="cc-sys-chip" id="cc-sys" role="status"><span class="cc-dot" id="cc-sys-dot"></span><span id="cc-sys-label"><span class="long">Connecting</span><span class="short">Connecting</span></span></span>` +
    `<button type="button" class="cc-needpill" id="cc-needpill" hidden><span class="cc-dot warn"></span><span id="cc-needn">0</span> need you</button>` +
    `<button type="button" class="cc-mis-chip" id="cc-mis-chip" title="Open the missions" hidden></button>` +
    `<button type="button" class="cc-ibtn cc-evbtn" id="cc-more" aria-label="Everything">${ic("grid")}</button>`
  );
}
const TOP_CLOCK = `<div class="cc-clock" aria-hidden="true"><b id="cc-clock">--:--</b><span id="cc-clock-date">Cairo</span></div>`;

/**
 * @param o  { csrf, user, core, voice: {configured, model, voice, manage, desk} }
 *   core  the viewer's saved MINT AI core (A / B / C; anything else is C),
 *         rendered here so the page paints the right one from the first frame
 */
function page(o) {
  const voice = o.voice || {};
  const core = logic.normCore(o.core);
  const sessview = logic.normSessView(o.sessview);
  const perm = o.user && o.user.perm;
  const voiceOff = voice.configured
    ? ""
    : voice.manage
    ? `<span class="cc-voice-off">voice is off: <a href="/credentials/openai-voice">Add an OpenAI key in Settings</a></span>`
    : `<span class="cc-voice-off">voice is off: Add an OpenAI key in Settings — ask an administrator</span>`;
  const deskOn = !!(voice.configured && voice.desk);
  const dashLinks = [
    ["/os", "cpu", "OS Dashboard", "os"],
    ["/agents/dashboard", "bot", "Agents", "agents"],
  ]
    .filter((d) => !perm || perm.canDash(d[3]))
    .concat([["/account", "user", "Your account", ""]])
    .map((d) => `<a class="cc-card cc-link-card" href="${d[0]}">${ic(d[1])}<b>${esc(d[2])}</b><span class="sp"></span>${ic("chevr")}</a>`)
    .join("");

  const body = `${sprite()}
<div class="cc-shell" id="cc"
     data-core="${core}" data-state="idle" data-sessview="${sessview}"
     data-pages="${esc(UiActions.navKeysFor((p) => !perm || perm.can(p)).join(" "))}"
     data-csrf="${esc(o.csrf)}"
     data-viewer="${esc(o.user && o.user.name)}"
     data-voice-ready="${voice.configured ? "1" : ""}"
     data-voice-manage="${voice.manage ? "1" : ""}"
     data-voice="${esc(voice.voice || "")}"
     data-voice-model="${esc(voice.model || "")}"
     data-voice-desk="${deskOn ? "1" : ""}"
     data-voice-live="${voice.configured && voice.live ? "1" : ""}"
     data-live-worklet="${voice.configured && voice.live ? esc(asset("voice-live-worklet.js")) : ""}"
     data-live-duplex="${voice.configured && voice.live ? esc(voice.liveDuplex || "speakers") : ""}">
  <div class="cc-bg" aria-hidden="true"></div>
  <div class="cc-halo" id="cc-halo" aria-hidden="true"></div>
  <canvas class="cc-core" id="cc-core" aria-hidden="true"></canvas>
  <div class="cc-spark" id="cc-spark" aria-hidden="true">${sparkSvg()}</div>
  <div class="cc-orbit" id="cc-orbit" role="group" aria-label="Live sessions"><svg class="cc-ring" id="cc-ring" aria-hidden="true" focusable="false"><ellipse/></svg></div>
  <canvas class="cc-family" id="cc-family" aria-hidden="true"></canvas>
  <div class="cc-kids" id="cc-kids" role="group" aria-label="Live sessions"></div>
  <div class="cc-kcard" id="cc-kcard" aria-hidden="true"></div>

  <main class="cc-main" id="cc-center" aria-label="MINT AI">
    <h1 class="cc-sr">MINT AI Command Center</h1>
    <div class="cc-stage" id="cc-stage"><div class="cc-offline" id="cc-offline" hidden><b>MINT AI is not reachable</b><span id="cc-offline-msg"></span></div></div>
    <div class="cc-caption">
      <span class="cc-cap-state" id="cc-cap-state" data-s="idle"><span class="d" aria-hidden="true"></span><span id="cc-cap-label">Connecting</span></span>
      <div class="cc-cap-line" id="cc-cap" aria-live="polite">Connecting to MINT AI…</div>
      <button type="button" class="cc-cap-more" id="cc-cap-more" aria-expanded="false" aria-controls="cc-reply" hidden>${ic("chev")}<span id="cc-cap-more-t">Full reply</span> · <span id="cc-cap-at"></span></button>
    </div>
    <div class="cc-dock" id="cc-dock">
      <form class="cc-composer" id="cc-compose" autocomplete="off">
        <button type="button" class="cc-c-mic" id="cc-c-mic" title="${voice.configured ? "Talk to MINT AI (hold, or hold Space)" : "Add an OpenAI key in Settings to use voice"}" aria-label="Talk to MINT AI"${voice.configured ? "" : " disabled"}>${ic("voice")}</button>
        <button type="button" class="cc-target" id="cc-target" aria-haspopup="menu" aria-expanded="false" title="MINT AI picks the session">${ic("route")}<span id="cc-target-label">Auto-route</span></button>
        <input id="cc-input" name="text" placeholder="Ask MINT AI…" aria-label="Message MINT AI" maxlength="20000" autocomplete="off">
        <button type="button" class="cc-c-stop" id="cc-stop" title="Interrupt the current turn" aria-label="Interrupt" hidden>${ic("stop")}</button>
        <button type="submit" class="cc-c-send" id="cc-send" title="Send" aria-label="Send">${ic("up")}</button>
      </form>
      <div class="cc-voicebar" id="cc-voicebar">
        <button type="button" class="cc-c-mic live" id="cc-vb-stop" title="Send what you said" aria-label="Stop and send">${ic("voice")}</button>
        <div class="cc-vb-text"><b>TALK TO MINT AI</b><span id="cc-vb-text">Listening…</span></div>
        <div class="cc-vb-wave" id="cc-vb-wave" aria-hidden="true"></div>
        <span class="cc-vb-tags"><span class="cc-tag cc-tag-mode" id="cc-vb-mode">Push to talk</span><span class="cc-tag${deskOn ? " desk" : ""}" id="cc-voice-mode" title="${
          deskOn
            ? "Voice front desk (GPT, trial): MINT AI's voice, speaking as MINT AI -- quick answers from a read-only snapshot, and short spoken summaries of MINT AI's own results. Switch it off in Settings › OpenAI voice."
            : "Voice goes straight to MINT AI: OpenAI only hears and reads aloud."
        }">${deskOn ? "Front desk · GPT" : "Direct · MINT AI"}</span><span class="cc-tag">OpenAI</span><span class="cc-tag" id="cc-voice-tag">${esc(voice.configured ? String(voice.voice || "voice") : "no key")}</span></span>
        <span class="cc-target cc-static">${ic("route")}<span id="cc-vb-target">Auto-route</span></span>
        <span class="cc-tag cc-live-tag cc-live-only" id="cc-live-tag" title="Live conversation (trial)" hidden>Live · trial</span>
        <span class="cc-live-acts cc-live-only" id="cc-live-acts" hidden><button type="button" class="cc-btn sm cc-live-duplex" id="cc-live-duplex" data-duplex="speakers" title="Speakers mode" aria-label="Speakers mode: switch to headphones mode">${ic("speaker", "dx-sp")}${ic("headphones", "dx-hp")}<span class="lbl" id="cc-live-duplex-lbl">Speakers</span></button><button type="button" class="cc-ibtn" id="cc-live-mute" title="Mute the microphone (the conversation stays open)" aria-label="Mute" aria-pressed="false">${ic("mute")}</button><button type="button" class="cc-btn sm cc-live-end" id="cc-live-end" title="End the live conversation" aria-label="End conversation">${ic("close")}<span class="lbl">End conversation</span></button></span>
        <button type="button" class="cc-ibtn" id="cc-vb-close" title="Back to typing" aria-label="Back to typing">${ic("close")}</button>
      </div>
      <div class="cc-hint" id="cc-hint"><button type="button" class="cc-vm" id="cc-vm" aria-haspopup="menu" aria-expanded="false" title="Voice and core settings">${ic("voice")}<span id="cc-mic-mode" data-mode="ptt">Push to talk</span>${ic("chevd")}</button>${
        voice.configured ? `<span class="kb" id="cc-kb-space"><kbd>Space</kbd> hold to talk</span><span class="kb cc-live-only" id="cc-kb-live" hidden></span>` : ""
      }<span class="kb"><kbd>@</kbd> a session</span><span class="kb"><kbd>Ctrl K</kbd> everything</span><span class="kb cc-guard">destructive steps wait for your approval</span>${voiceOff}</div>
    </div>
  </main>

  <nav class="cc-rail" id="cc-rail" aria-label="Behind the scenes">${dock()}</nav>
</div>

<section class="cc-reply" id="cc-reply" aria-label="MINT AI's last reply" hidden>
  <div class="hd"><span id="cc-reply-h">MINT AI</span><span class="sp"></span><button type="button" class="cc-ibtn" id="cc-reply-x" aria-label="Close">${ic("close")}</button></div>
  <div class="bd cc-scroll" id="cc-reply-body"></div>
  <div class="ft"><button type="button" class="cc-btn sm" data-sheet="conv">${ic("message")}Whole conversation</button><button type="button" class="cc-btn sm" id="cc-reply-read"${voice.configured ? "" : " hidden"}>${ic("speaker")}Read aloud</button></div>
</section>

<aside class="cc-need" id="cc-need" role="alertdialog" aria-label="Needs you" hidden></aside>
<div class="cc-pop" id="cc-pop" role="menu" hidden></div>
<div class="cc-sheet-scrim" id="cc-scrim" hidden></div>
<aside class="cc-sheet" id="cc-sheet" aria-label="Behind the scenes">
  ${pane(
    "conv",
    "Conversation",
    `<span id="cc-dr-sub">the MINT AI session</span>`,
    `<button type="button" class="cc-ibtn" id="cc-speak-toggle" aria-pressed="false" title="Replies are silent — click to read MINT AI's replies aloud" aria-label="Read replies aloud"${voice.configured ? "" : " hidden"}>${ic("mute")}</button>` +
      `<button type="button" class="cc-ibtn" id="cc-rc-open" title="Open in Claude Desktop (Remote Control)" aria-label="Open in Claude Desktop">${ic("open")}</button>` +
      `<button type="button" class="cc-ibtn" id="cc-expand" title="Widen the sheet" aria-label="Widen the sheet">${ic("expand")}</button>`,
    `<section class="cc-activity" id="cc-activity"><h3><span class="cc-dot" id="cc-act-dot"></span>Current AI activity<span class="cc-muted" id="cc-act-sub">—</span></h3><ol class="cc-steps" id="cc-steps"></ol></section>
      <div class="cc-chat" id="cc-chat" aria-live="polite"></div>`,
    `<span class="cc-dot" id="cc-rc-dot"></span><span id="cc-rc-text">Mirrors the MINT AI session — the same conversation in Claude Desktop (Remote Control) and here.</span>`
  )}
  ${pane(
    "sessions",
    "Sessions",
    `<span id="cc-sess-aside">—</span>`,
    "",
    `<div class="cc-stats"><div><b id="cc-stat-deleg">—</b><span>delegated · 24h</span></div><div><b id="cc-stat-done">—</b><span>done · 24h</span></div><div><b id="cc-stat-median">—</b><span>median turn</span></div></div>
      <div class="cc-sess-list" id="cc-sessions"></div>
      <div class="cc-card dashed cc-hire-note" id="cc-hire-note">
        <div class="t">${ic("plus")}<b>Hire a session</b><span class="sp"></span><span class="cc-tag mute" id="cc-hire-count">—</span></div>
        <div class="m">Ask MINT AI to hire a session for a job that needs its own context. At most 7 sessions at a time and 3 hires an hour. Keep or retire a hired session with its buttons here, or right-click its sphere. MINT AI can only ask to retire one; you decide.</div>
      </div>`
  )}
  ${pane(
    "missions",
    "Missions",
    `<span id="cc-mis-sub">goals MINT AI plans into steps</span>`,
    `<button type="button" class="cc-btn pri sm" data-open="mission-new">${ic("plus")}New mission</button>`,
    `<div class="cc-mis-tabs" id="cc-mis-tabs"></div><div class="cc-mis-head" id="cc-mis-head" hidden></div><div class="cc-lanes" id="cc-lanes"></div>`
  )}
  ${pane(
    "dec",
    "Decisions",
    `<span id="cc-dec-sub">approvals and watcher findings</span>`,
    "",
    `<div id="cc-dec-list"></div>
      <details class="cc-evlog" id="cc-evlog" open><summary class="cc-inbox-h">${ic("bolt")}Event log<span class="cc-muted"><span id="cc-feed-count">0</span> events · this VPS</span></summary><ul class="cc-feed" id="cc-feed"></ul></details>`
  )}
  ${pane("tl", "Timeline", `<span id="cc-tl-count">0</span> delegations and approvals, newest first`, "", `<ul class="cc-timeline" id="cc-timeline"></ul>`)}
  ${pane("rules", "Rules & watchers", "what needs your approval, what is watched", "", `<div id="cc-rules-pane"></div>`)}
  ${pane(
    "orders",
    "Standing orders",
    "run on a schedule, as MINT AI or a session",
    `<button type="button" class="cc-btn pri sm" data-open="order-new">${ic("plus")}New</button>`,
    `<ul class="cc-orders" id="cc-orders"></ul>`
  )}
  ${pane(
    "cost",
    "Usage",
    "Claude plan limits · tokens · voice",
    `<button type="button" class="cc-btn sm" data-open="cost">Details</button>`,
    `<div id="cc-cost-widget"><div class="cc-empty-s">—</div></div>${
      voice.configured
        ? `<details class="cc-vu-box" id="cc-vu-box"><summary>${ic("coin")}<span>Voice · OpenAI</span><small class="cc-muted">billed separately</small><b id="cc-vu-sum"></b></summary><div class="cc-vu" id="cc-voice-usage" aria-live="polite"><div class="cc-empty-s">Voice usage —</div></div></details>`
        : ""
    }`
  )}
  ${pane(
    "machine",
    "Machine",
    `<span id="cc-mach-aside">this VPS</span>`,
    "",
    `<div class="cc-card cc-mach-this" id="cc-mach-this">
        <div class="cc-mach-top">${ic("server")}<b id="cc-host">This VPS</b><span class="sp"></span><span class="cc-tag mute" id="cc-mach-badge">—</span></div>
        <div class="cc-mach-sub cc-mono" id="cc-mach-sub">this box</div>
        <div class="cc-mach-bars"><span class="cc-mb" data-mb="cpu">CPU —<i></i></span><span class="cc-mb" data-mb="ram">RAM —<i></i></span><span class="cc-mb" data-mb="disk">DISK —<i></i></span></div>
        <div class="cc-mach-note" id="cc-mach-note">—</div>
      </div>
      <div class="cc-sec-t">MINT AI core<span class="cc-muted cc-mono" id="cc-core-aside">—</span></div>
      <div class="cc-core-grid" id="cc-core-grid">
        ${coreCell("core", "Core")}${coreCell("sessions", "Sessions")}${coreCell("agents", "Agents")}${coreCell("memory", "Memory")}
        ${coreCell("watchers", "Watchers")}${coreCell("rules", "Rules")}${coreCell("voice", "Voice")}${coreCell("guard", "Guardrails")}
      </div>
      <div class="cc-sec-t">Other machines</div>
      <div class="cc-card dashed cc-mach-add" aria-disabled="true" title="Watching another machine comes later">${ic("plus")}<b>Add a machine</b><span class="sp"></span><em class="cc-tag mute">coming later</em></div>`
  )}
  ${pane(
    "everything",
    "Everything",
    "one tap away",
    "",
    `<div class="cc-everything">${logic.SHEETS.filter((s) => s !== "-")
      .map((s) => `<button type="button" data-sheet="${s.key}">${ic(s.icon)}<span>${esc(s.label.replace(" & voice usage", "").replace(" & watchers", ""))}</span>${s.key === "dec" ? `<span class="cc-badge-n warn" data-dec-mirror hidden>0</span>` : ""}</button>`)
      .join("")}<button type="button" data-open-palette>${ic("search")}<span>Search or run</span></button></div>
      ${dashLinks ? `<div class="cc-sec-t">Dashboards</div>${dashLinks}` : ""}
      <div class="cc-sec-t">MINT AI core</div>${coreSwitch(core, "wide")}
      <div class="cc-sec-t">Theme</div>
      <div class="cc-theme-mini" role="group" aria-label="Theme"><button type="button" data-theme-to="system" aria-label="System theme">${ic("monitor")}</button><button type="button" data-theme-to="dark" aria-label="Dark theme">${ic("moon")}</button><button type="button" data-theme-to="light" aria-label="Light theme">${ic("sun")}</button></div>`
  )}
</aside>
<div id="cc-overlay"></div>
${perm ? dockMarkup(o.csrf, perm, { shell: true, noVoice: !voice.configured }) : ""}
<noscript><div class="cc-noscript">The Command Center needs JavaScript. The older chat is at <a href="/console">/console</a>.</div></noscript>`;

  return shell("MINT AI", body, {
    user: o.user,
    csrf: o.csrf,
    active: "moni-ai",
    dash: "console",
    brand: "ai",
    heading: null,
    pageClass: "cc-page",
    assets: ["moni-ai.css", "voice-live.css", "mint-dock.css", "cc-logic.js", "mint-core.js", "cc-family.js", "cc-map.js", "cc-panels.js", "voice-live-detect.js", "voice-live.js", "ui-actions.js", "moni-ai.js", "mint-dock.js", "mint-shell.js"],
    topExtra: topExtra(),
    topEnd: TOP_CLOCK,
  });
}

/* ------------------------------------------------ Account ▸ Appearance --- */

/**
 * The Appearance card on /account: the three cores, each with a small live
 * preview, the saved one ticked; and the sessions view (Spheres / Classic orbit). Works without JavaScript (a plain form post
 * to /account/appearance); mint-settings.js switches it in place instead, and
 * any open Command Center picks the change up on its next load -- or at once,
 * from its own quick switch.
 *
 * @param o { csrf, core }
 */
function appearance(o) {
  const core = logic.normCore(o.core);
  const sessview = logic.normSessView(o.sessview);
  const sessDesc = {
    spheres: "New: each live session is a small sphere like MINT AI, with its name, drifting round her; delegations and replies stream between you.",
    orbit: "The classic view: each live session is a dot on a faint orbit round the core.",
  };
  const sessOpts = Object.keys(logic.SESS_VIEWS)
    .map(
      (k) => `<label class="mint-sess-opt" data-sessview-opt="${k}">
        <input type="radio" name="sessions_view" value="${k}"${k === sessview ? " checked" : ""}>
        <span class="mint-core-name"><b>${esc(logic.SESS_VIEWS[k])}</b>${k === "spheres" ? " · new" : ""}</span>
        <span class="mint-core-desc">${esc(sessDesc[k])}</span>
      </label>`
    )
    .join("");
  const desc = {
    A: "A sphere of dots that ripples when you talk, knots while it thinks and gathers into rings when it needs you.",
    B: "A glassy fluid orb that melts into voice waves when it listens and speaks.",
    C: "The dotted sphere with the brand spark at its heart. The default.",
  };
  const opts = Object.keys(logic.CORES)
    .map(
      (k) => `<label class="mint-core-opt" data-core-opt="${k}">
        <input type="radio" name="core" value="${k}"${k === core ? " checked" : ""}>
        <span class="mint-prev"><canvas data-prev-core="${k}" aria-hidden="true"></canvas>${k === "C" ? `<span class="mint-prev-spark" aria-hidden="true">${sparkSvg().replace(/cc-sp/g, "mp-sp")}</span>` : ""}</span>
        <span class="mint-core-name"><b>${k}</b> · ${esc(logic.CORES[k])}</span>
        <span class="mint-core-desc">${esc(desc[k])}</span>
      </label>`
    )
    .join("");
  return {
    html: card(
      "Appearance",
      `<form method="post" action="/account/appearance" class="mint-appearance" id="mint-appearance" data-csrf="${esc(o.csrf)}">
        <input type="hidden" name="_csrf" value="${esc(o.csrf)}">
        <p class="muted">The MINT AI core in the Command Center. Switch any time; an open Command Center can switch too, from its voice menu.</p>
        <fieldset class="mint-core-opts"><legend class="cc-sr">MINT AI core</legend>${opts}</fieldset>
        <p class="muted mint-sess-h"><b>Sessions view</b> — how the live sessions are shown round the core.</p>
        <fieldset class="mint-sess-opts"><legend class="cc-sr">Sessions view</legend>${sessOpts}</fieldset>
        <div class="btn-row"><button class="btn primary mint-core-save" type="submit">Save</button><span class="muted small" id="mint-appearance-note" role="status"></span></div>
      </form>`,
      { icon: "eye", id: "appearance" }
    ),
    assets: ["mint-settings.css", "mint-core.js", "mint-settings.js"],
  };
}

module.exports = { page, appearance, SPRITE, coreSwitch };
