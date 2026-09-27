"use strict";
/**
 * The MONI AI Command Center.
 *
 * One screen, no page scroll: a rail of vitals on the left, the seed core and
 * the live sessions in the middle, and MONI AI's own conversation on the right.
 * Everything that changes is filled in by public/moni-ai.js from the JSON and
 * SSE API under /moni-ai/api/ -- this renders the frame, the labels and the
 * few facts the server already knows (who is looking, whether a voice is
 * installed), all escaped here.
 *
 * Three themes: System (the default, following prefers-color-scheme live),
 * Dark and Light, switched from the top bar like every other page. The choice
 * is applied before first paint by theme-init.js; this page's palette lives in
 * public/moni-ai.css as custom properties.
 */

const { esc, shell } = require("./ui");

/* Icons for the page, as one sprite referenced by <use>. Kept separate from
   lib/icons.js because the canvas-drawn page needs a few that nothing else
   does, and a sprite lets the client script draw them without markup of its
   own beyond a reference. */
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
  mute: '<path d="M4 9.5h4l5-4v13l-5-4H4Z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
};

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

/** The rail's MONI AI Core list. Values arrive from the page script. */
function coreRow(key, iconName, label) {
  return `<li data-core="${key}">
      <span class="cc-core-ic">${ic(iconName)}</span>
      <div><b>${esc(label)}</b><small data-sub>—</small></div>
      <span class="cc-st" data-st>—</span>
    </li>`;
}

/* Top-bar additions: the status chip before the theme switch (which is the
   shell's own, on every page), the clock after it. */
const TOP_CHIP = `<span class="cc-sys-chip" id="cc-sys" role="status"><span class="cc-dot" id="cc-sys-dot"></span><span id="cc-sys-label"><span class="long">Connecting</span><span class="short">Connecting</span></span></span>`;
const TOP_CLOCK = `<div class="cc-clock" aria-hidden="true"><b id="cc-clock">--:--:--</b><span id="cc-clock-date">Cairo</span></div>`;

/**
 * @param o  { csrf, user, voice: {tts, voice, stt} }
 */
function page(o) {
  const voice = o.voice || {};
  const body = `${sprite()}
<div class="cc-shell" id="cc"
     data-csrf="${esc(o.csrf)}"
     data-viewer="${esc(o.user && o.user.name)}"
     data-tts="${voice.tts ? "1" : ""}"
     data-voice="${esc(voice.voice || "")}">

  <aside class="cc-rail" aria-label="MONI AI status">
    <section class="cc-card cc-hud">
      <div class="cc-card-h"><h2>MONI AI Core</h2><span class="cc-aside cc-mono" id="cc-host">—</span></div>
      <ul class="cc-core">
        ${coreRow("core", "core", "Core")}
        ${coreRow("sessions", "sessions", "Sessions")}
        ${coreRow("agents", "agents", "Agents")}
        ${coreRow("memory", "memory", "Memory")}
        ${coreRow("voice", "voice", "Voice")}
        ${coreRow("guard", "shield", "Guardrails")}
      </ul>
    </section>

    <section class="cc-card cc-voice-card">
      <button type="button" class="cc-mic-big" id="cc-mic-big" aria-pressed="false" aria-label="Talk to MONI">${ic("voice")}</button>
      <div class="cc-min0">
        <h2>Talk to MONI</h2>
        <b id="cc-mic-label">Tap to talk</b>
        <div class="cc-sub" id="cc-mic-sub">or hold <kbd>Space</kbd> to talk</div>
        <div class="cc-chips"><span class="cc-tag">Whisper</span><span class="cc-tag" id="cc-voice-tag">${esc(
          voice.tts ? String(voice.voice || "Piper").replace(/^en_US-/, "").replace(/-(medium|high|low)$/, "") : "text only"
        )}</span><button type="button" class="cc-tag cc-tag-btn" id="cc-speak-toggle" aria-pressed="false" title="Read MONI AI's replies aloud">${ic("mute")}<span>replies silent</span></button></div>
      </div>
    </section>

    <section class="cc-card cc-vitals">
      <div class="cc-card-h"><h2>Vitals</h2><span class="cc-aside" id="cc-vit-aside">—</span></div>
      <div class="cc-rings" id="cc-rings"></div>
      <div class="cc-vit-foot"><span id="cc-load">Load —</span><span id="cc-up">—</span></div>
      <div class="cc-vit-div"></div>
      <div class="cc-card-h cc-tight"><h2>Memory</h2><span class="cc-aside" id="cc-mem-aside">—</span></div>
      <div class="cc-mem-wrap">
        <svg viewBox="0 0 96 96" id="cc-constellation" aria-hidden="true"></svg>
        <div class="cc-mem-stats">
          <div><b id="cc-mem-facts">—</b><span>facts</span></div>
          <div><b id="cc-mem-chunks">—</b><span>chunks</span></div>
          <div><b id="cc-mem-sessions">—</b><span>sessions</span></div>
          <div><b id="cc-mem-last">—</b><span>last fact</span></div>
        </div>
      </div>
      <div class="cc-chips cc-mem-topics" id="cc-mem-topics"></div>
    </section>
  </aside>

  <main class="cc-center" id="cc-center">
    <section class="cc-hero" id="cc-hero">
      <canvas id="cc-orb" role="img" aria-label="MONI AI seed core, with a root out to each live session"></canvas>
      <div class="cc-hero-title"><h1>Command Center</h1><p>MONI AI delegates to every Claude session on this box</p></div>
      <div class="cc-state-pill" id="cc-state" role="status"><span class="cc-dot" id="cc-state-dot"></span><span id="cc-state-label">Idle</span></div>
      <div class="cc-hero-legend" aria-hidden="true">
        <span><span class="cc-dot work"></span>working</span>
        <span><span class="cc-dot wait"></span>waiting</span>
        <span><span class="cc-dot idle"></span>idle</span>
      </div>
      <div class="cc-hero-stats">
        <div><b id="cc-stat-deleg">—</b><span>delegated · 24h</span></div>
        <div><b id="cc-stat-done">—</b><span>done · 24h</span></div>
        <div><b id="cc-stat-median">—</b><span>median turn</span></div>
      </div>
      <div class="cc-offline" id="cc-offline" hidden><b>MONI AI is not reachable</b><span id="cc-offline-msg"></span></div>
    </section>

    <section class="cc-sess-sec" aria-labelledby="cc-sess-h">
      <div class="cc-sec-h"><h2 id="cc-sess-h">Sessions</h2><span class="cc-aside" id="cc-sess-aside">—</span></div>
      <div class="cc-sessions" id="cc-sessions"></div>
    </section>

    <div class="cc-dock" id="cc-dock">
      <form class="cc-composer" id="cc-compose" autocomplete="off">
        <button type="button" class="cc-c-mic" id="cc-c-mic" title="Talk to MONI (voice mode)" aria-label="Talk to MONI">${ic("voice")}</button>
        <input id="cc-input" name="text" placeholder="Tell MONI AI what to do…" aria-label="Message MONI AI" maxlength="20000" autocomplete="off">
        <button type="button" class="cc-target" id="cc-target" aria-haspopup="menu" aria-expanded="false">${ic("route")}<span id="cc-target-label">Auto-route</span>${ic("chev")}</button>
        <button type="button" class="cc-c-stop" id="cc-stop" title="Interrupt the current turn" aria-label="Interrupt" hidden>${ic("stop")}</button>
        <button type="submit" class="cc-c-send" id="cc-send" title="Send" aria-label="Send">${ic("send")}</button>
      </form>
      <div class="cc-voicebar" id="cc-voicebar">
        <button type="button" class="cc-c-mic live" id="cc-vb-stop" title="Stop talking" aria-label="Stop voice mode">${ic("voice")}</button>
        <div class="cc-vb-text"><b>TALK TO MONI</b><span id="cc-vb-text">Listening…</span></div>
        <div class="cc-vb-wave" id="cc-vb-wave" aria-hidden="true"></div>
        <span class="cc-target cc-static">${ic("route")}<span id="cc-vb-target">Auto-route</span></span>
        <button type="button" class="cc-c-kbd" id="cc-vb-close" title="Back to typing" aria-label="Back to typing">${ic("close")}</button>
      </div>
      <div class="cc-hint"><kbd>Enter</kbd> send · <kbd>@</kbd> pick a session · <kbd>Space</kbd> hold to talk · destructive commands wait for your approval</div>
    </div>
  </main>

  <aside class="cc-drawer" id="cc-drawer" aria-label="MONI AI conversation">
    <div class="cc-dr-head">
      <span class="cc-av cc-av-lg"></span>
      <div class="cc-min0 cc-dr-title"><h2>MONI AI</h2><small id="cc-dr-sub">CEO session · /root/moni-ai</small></div>
      <div class="cc-sp">
        <button type="button" class="cc-iconbtn" id="cc-rc-open" title="Open in Claude Desktop (Remote Control)" aria-label="Open in Claude Desktop">${ic("open")}</button>
        <button type="button" class="cc-iconbtn" id="cc-expand" title="Widen the conversation" aria-label="Widen the conversation">${ic("expand")}</button>
        <button type="button" class="cc-iconbtn" id="cc-collapse" title="Collapse or open the conversation" aria-label="Collapse the conversation">${ic("panel")}</button>
      </div>
    </div>
    <div class="cc-dr-tabs" role="tablist">
      <button type="button" role="tab" aria-selected="true" data-pane="conv" id="cc-tab-conv">Conversation<span class="cc-count warn" id="cc-ap-count" hidden>0</span></button>
      <button type="button" role="tab" aria-selected="false" data-pane="tl">Timeline<span class="cc-count" id="cc-tl-count">0</span></button>
      <button type="button" role="tab" aria-selected="false" data-pane="feed">Live feed<span class="cc-count" id="cc-feed-count">0</span></button>
    </div>
    <div class="cc-pane" id="cc-pane-conv" role="tabpanel">
      <section class="cc-activity" id="cc-activity">
        <h3><span class="cc-dot" id="cc-act-dot"></span>Current AI Activity<span class="cc-muted" id="cc-act-sub">—</span></h3>
        <ol class="cc-steps" id="cc-steps"></ol>
      </section>
      <div class="cc-pane-scroll cc-chat-scroll" id="cc-chat-scroll"><div class="cc-chat" id="cc-chat" aria-live="polite"></div></div>
    </div>
    <div class="cc-pane" id="cc-pane-tl" role="tabpanel" hidden><div class="cc-pane-scroll"><ul class="cc-timeline" id="cc-timeline"></ul></div></div>
    <div class="cc-pane" id="cc-pane-feed" role="tabpanel" hidden><div class="cc-pane-scroll"><ul class="cc-feed" id="cc-feed"></ul></div></div>
    <div class="cc-dr-foot"><span class="cc-dot" id="cc-rc-dot"></span><span id="cc-rc-text">Mirrors the MONI AI session — the same conversation in Claude Desktop (Remote Control) and here.</span></div>
  </aside>
</div>
<noscript><div class="cc-noscript">The Command Center needs JavaScript. The older chat is at <a href="/console">/console</a>.</div></noscript>`;

  return shell("MONI AI", body, {
    user: o.user,
    csrf: o.csrf,
    active: "moni-ai",
    dash: "console",
    heading: null,
    pageClass: "cc-page",
    assets: ["moni-ai.css", "moni-ai.js"],
    topExtra: TOP_CHIP,
    topEnd: TOP_CLOCK,
  });
}

module.exports = { page, SPRITE };
