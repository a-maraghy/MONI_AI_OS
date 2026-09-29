"use strict";
/**
 * The MONI AI Command Center (v3).
 *
 * One screen, no page scroll. Left rail: this machine, MONI AI's core, today's
 * cost and the standing orders. Centre: the orbit map (MONI AI's seed core with
 * the live sessions around it) or the missions board, the sessions strip and
 * the composer with voice. Right drawer: Conversation, Decisions (approvals,
 * watcher findings and the event log), Timeline and Rules.
 *
 * Everything that changes is filled in by public/moni-ai.js (with
 * public/cc-map.js and public/cc-panels.js) from the JSON and SSE API under
 * /moni-ai/api/ -- this renders the frame, the labels and the few facts the
 * server already knows (who is looking, whether a voice is installed), all
 * escaped here. No inline script, style or handler anywhere: the CSP refuses
 * them.
 *
 * Only this VPS is shown. The live Odoo server appears nowhere on this page.
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

/** One cell of the rail's MONI AI Core grid. Values arrive from the page script. */
function coreCell(key, label) {
  return `<div data-core="${key}"><span>${esc(label)}</span><b data-st>—</b></div>`;
}

/* Top-bar additions: the status chip and the command palette button before the
   theme switch (which is the shell's own, on every page), the clock after it. */
const TOP_CHIP =
  `<span class="cc-sys-chip" id="cc-sys" role="status"><span class="cc-dot" id="cc-sys-dot"></span><span id="cc-sys-label"><span class="long">Connecting</span><span class="short">Connecting</span></span></span>` +
  `<button type="button" class="cc-kbtn" id="cc-kbtn" title="Command palette (Ctrl+K)" aria-keyshortcuts="Control+K">${ic("search")}<span class="kl">Search or run</span><kbd>Ctrl K</kbd></button>`;
const TOP_CLOCK = `<div class="cc-clock" aria-hidden="true"><b id="cc-clock">--:--:--</b><span id="cc-clock-date">Cairo</span></div>`;

/**
 * @param o  { csrf, user, voice: {configured, model, voice, manage, desk} }
 */
function page(o) {
  const voice = o.voice || {};
  const voiceOff = voice.configured
    ? ""
    : voice.manage
    ? ` · voice is off: <a href="/credentials/openai-voice">Add an OpenAI key in Settings</a>`
    : ` · voice is off: Add an OpenAI key in Settings — ask an administrator`;
  const body = `${sprite()}
<div class="cc-shell" id="cc"
     data-csrf="${esc(o.csrf)}"
     data-viewer="${esc(o.user && o.user.name)}"
     data-voice-ready="${voice.configured ? "1" : ""}"
     data-voice-manage="${voice.manage ? "1" : ""}"
     data-voice="${esc(voice.voice || "")}"
     data-voice-model="${esc(voice.model || "")}"
     data-voice-desk="${voice.configured && voice.desk ? "1" : ""}">

  <aside class="cc-rail" aria-label="Machine, core, cost and standing orders">
    <section class="cc-card cc-hud" aria-labelledby="cc-mach-h">
      <div class="cc-card-h"><h2 id="cc-mach-h">Machines</h2><span class="cc-aside" id="cc-mach-aside">this VPS</span></div>
      <ul class="cc-mach">
        <li class="cc-mach-this" id="cc-mach-this">
          <div class="cc-mach-top">${ic("server")}<b id="cc-host">This VPS</b><span class="cc-badge b-mute" id="cc-mach-badge">—</span></div>
          <div class="cc-mach-sub" id="cc-mach-sub">this box</div>
          <div class="cc-mach-bars">
            <span class="cc-mb" data-mb="cpu">CPU —<i></i></span><span class="cc-mb" data-mb="ram">RAM —<i></i></span><span class="cc-mb" data-mb="disk">DISK —<i></i></span>
          </div>
          <div class="cc-mach-note" id="cc-mach-note">—</div>
        </li>
        <li class="cc-mach-add" aria-disabled="true" title="Watching another machine comes later">${ic("plus")}Add a machine<em>coming later</em></li>
      </ul>
    </section>

    <section class="cc-card" aria-labelledby="cc-core-h">
      <div class="cc-card-h"><h2 id="cc-core-h">MONI AI Core</h2><span class="cc-aside cc-mono" id="cc-core-aside">—</span></div>
      <div class="cc-core-grid" id="cc-core-grid">
        ${coreCell("core", "Core")}${coreCell("sessions", "Sessions")}
        ${coreCell("agents", "Agents")}${coreCell("memory", "Memory")}
        ${coreCell("watchers", "Watchers")}${coreCell("rules", "Rules")}
        ${coreCell("voice", "Voice")}${coreCell("guard", "Guardrails")}
      </div>
    </section>

    <section class="cc-card" aria-labelledby="cc-cost-h">
      <div class="cc-card-h"><h2 id="cc-cost-h">Cost today</h2><button type="button" class="cc-link" data-open="cost">Details</button></div>
      <div id="cc-cost-widget"><div class="cc-empty-s">—</div></div>
    </section>

    <section class="cc-card cc-orders-card" aria-labelledby="cc-orders-h">
      <div class="cc-card-h"><h2 id="cc-orders-h">Standing orders</h2><button type="button" class="cc-link" data-open="order-new">+ New</button></div>
      <ul class="cc-orders cc-scroll" id="cc-orders"></ul>
    </section>
  </aside>

  <main class="cc-center" id="cc-center">
    <div class="cc-ctr-head">
      <h1>Command Center</h1>
      <div class="cc-seg" role="tablist" aria-label="Centre view">
        <button type="button" role="tab" aria-selected="true" data-view="map">${ic("orbit")}Map</button>
        <button type="button" role="tab" aria-selected="false" data-view="missions">${ic("flag")}Missions<span class="cc-count" id="cc-mis-count" hidden>0</span></button>
      </div>
      <div class="cc-sp">
        <button type="button" class="cc-mis-chip" id="cc-mis-chip" title="Open the mission board" hidden></button>
        <div class="cc-state-pill" id="cc-state" role="status"><span class="cc-dot" id="cc-state-dot"></span><span id="cc-state-label">Idle</span></div>
      </div>
    </div>

    <section class="cc-stage" id="cc-stage">
      <div class="cc-view" id="cc-view-map">
        <canvas id="cc-map" role="img" aria-label="Orbit map: MONI AI at the centre, the live sessions on the inner ring, their sub-agents as moons"></canvas>
        <div class="cc-map-say" id="cc-map-say" hidden></div>
        <div class="cc-map-legend" aria-hidden="true">
          <span><span class="lg-ring"></span>inner: live sessions</span>
          <span><span class="lg-moon"></span>sub-agent</span>
          <span><span class="lg-out"></span>delegation</span>
          <span><span class="lg-back"></span>reply</span>
          <span><span class="lg-mis"></span>mission</span>
        </div>
        <div class="cc-map-stats">
          <div><b id="cc-stat-deleg">—</b><span>delegated · 24h</span></div>
          <div><b id="cc-stat-done">—</b><span>done · 24h</span></div>
          <div><b id="cc-stat-median">—</b><span>median turn</span></div>
        </div>
      </div>
      <div class="cc-view" id="cc-view-missions" hidden>
        <div class="cc-missions">
          <div class="cc-mis-tabs" id="cc-mis-tabs"></div>
          <div class="cc-mis-head" id="cc-mis-head"></div>
          <div class="cc-lanes" id="cc-lanes"></div>
        </div>
      </div>
      <div class="cc-offline" id="cc-offline" hidden><b>MONI AI is not reachable</b><span id="cc-offline-msg"></span></div>
    </section>

    <section class="cc-sess-sec" aria-labelledby="cc-sess-h">
      <div class="cc-sec-h"><h2 id="cc-sess-h">Sessions</h2><span class="cc-aside" id="cc-sess-aside">—</span></div>
      <div class="cc-strip" id="cc-sessions"></div>
    </section>

    <div class="cc-dock" id="cc-dock">
      <form class="cc-composer" id="cc-compose" autocomplete="off">
        <button type="button" class="cc-c-mic" id="cc-c-mic" title="${voice.configured ? "Talk to MONI (voice mode)" : "Add an OpenAI key in Settings to use voice"}" aria-label="Talk to MONI"${voice.configured ? "" : " disabled"}>${ic("voice")}</button>
        <input id="cc-input" name="text" placeholder="Tell MONI AI what to do…" aria-label="Message MONI AI" maxlength="20000" autocomplete="off">
        <button type="button" class="cc-target" id="cc-target" aria-haspopup="menu" aria-expanded="false">${ic("route")}<span id="cc-target-label">Auto-route</span>${ic("chev")}</button>
        <button type="button" class="cc-c-stop" id="cc-stop" title="Interrupt the current turn" aria-label="Interrupt" hidden>${ic("stop")}</button>
        <button type="submit" class="cc-c-send" id="cc-send" title="Send" aria-label="Send">${ic("send")}</button>
      </form>
      <div class="cc-voicebar" id="cc-voicebar">
        <button type="button" class="cc-c-mic live" id="cc-vb-stop" title="Stop talking" aria-label="Stop voice mode">${ic("voice")}</button>
        <div class="cc-vb-text"><b>TALK TO MONI</b><span id="cc-vb-text">Listening…</span></div>
        <div class="cc-vb-wave" id="cc-vb-wave" aria-hidden="true"></div>
        <span class="cc-vb-tags"><span class="cc-tag${voice.configured && voice.desk ? " desk" : ""}" id="cc-voice-mode" title="${
          voice.configured && voice.desk
            ? "Voice front desk (GPT, trial): quick answers from a read-only snapshot; everything else goes to MONI AI. Switch it off in Settings › OpenAI voice."
            : "Voice goes straight to MONI AI: OpenAI only hears and reads aloud."
        }">${voice.configured && voice.desk ? "Front desk · GPT" : "Direct · MONI AI"}</span><span class="cc-tag">OpenAI</span><span class="cc-tag" id="cc-voice-tag">${esc(voice.configured ? String(voice.voice || "voice") : "no key")}</span></span>
        <span class="cc-target cc-static">${ic("route")}<span id="cc-vb-target">Auto-route</span></span>
        <button type="button" class="cc-c-kbd" id="cc-vb-close" title="Back to typing" aria-label="Back to typing">${ic("close")}</button>
      </div>
      <div class="cc-hint"><kbd>Enter</kbd> send · <kbd>@</kbd> session · <kbd>Ctrl K</kbd> palette${voice.configured ? " · <kbd>Space</kbd> hold to talk" : ""} · destructive commands wait for your approval${voiceOff}</div>
    </div>
  </main>

  <aside class="cc-drawer" id="cc-drawer" aria-label="MONI AI conversation and inbox">
    <div class="cc-dr-head">
      <span class="cc-av cc-av-lg"></span>
      <div class="cc-min0 cc-dr-title"><h2>MONI AI</h2><small id="cc-dr-sub">CEO session · /root/moni-ai</small></div>
      <div class="cc-sp">
        <button type="button" class="cc-iconbtn" id="cc-speak-toggle" aria-pressed="false" title="Replies are silent — click to read MONI AI's replies aloud" aria-label="Read replies aloud"${voice.configured ? "" : " hidden"}>${ic("mute")}</button>
        <button type="button" class="cc-iconbtn" id="cc-rc-open" title="Open in Claude Desktop (Remote Control)" aria-label="Open in Claude Desktop">${ic("open")}</button>
        <button type="button" class="cc-iconbtn" id="cc-expand" title="Widen the drawer" aria-label="Widen the drawer">${ic("expand")}</button>
        <button type="button" class="cc-iconbtn" id="cc-collapse" title="Collapse or open the drawer" aria-label="Collapse the drawer">${ic("panel")}</button>
      </div>
    </div>
    <div class="cc-dr-tabs" role="tablist">
      <button type="button" role="tab" aria-selected="true" data-pane="conv" id="cc-tab-conv">Conversation</button>
      <button type="button" role="tab" aria-selected="false" data-pane="dec" id="cc-tab-dec">Decisions<span class="cc-count warn" id="cc-dec-count" hidden>0</span></button>
      <button type="button" role="tab" aria-selected="false" data-pane="tl">Timeline<span class="cc-count opt" id="cc-tl-count">0</span></button>
      <button type="button" role="tab" aria-selected="false" data-pane="rules">Rules</button>
    </div>
    <div class="cc-pane" id="cc-pane-conv" role="tabpanel">
      <section class="cc-activity" id="cc-activity">
        <h3><span class="cc-dot" id="cc-act-dot"></span>Current AI activity<span class="cc-muted" id="cc-act-sub">—</span></h3>
        <ol class="cc-steps" id="cc-steps"></ol>
      </section>
      <div class="cc-pane-scroll cc-chat-scroll" id="cc-chat-scroll"><div class="cc-chat" id="cc-chat" aria-live="polite"></div></div>
    </div>
    <div class="cc-pane" id="cc-pane-dec" role="tabpanel" hidden>
      <div class="cc-pane-scroll" id="cc-dec-scroll">
        <div id="cc-dec-list"></div>
        <details class="cc-evlog" id="cc-evlog" open>
          <summary class="cc-inbox-h">${ic("bolt")}Event log<span class="cc-muted"><span id="cc-feed-count">0</span> events · this VPS</span></summary>
          <ul class="cc-feed" id="cc-feed"></ul>
        </details>
      </div>
    </div>
    <div class="cc-pane" id="cc-pane-tl" role="tabpanel" hidden><div class="cc-pane-scroll"><ul class="cc-timeline" id="cc-timeline"></ul></div></div>
    <div class="cc-pane" id="cc-pane-rules" role="tabpanel" hidden><div class="cc-pane-scroll" id="cc-rules-pane"></div></div>
    <div class="cc-dr-foot"><span class="cc-dot" id="cc-rc-dot"></span><span id="cc-rc-text">Mirrors the MONI AI session — the same conversation in Claude Desktop (Remote Control) and here.</span></div>
  </aside>
</div>
<div id="cc-overlay"></div>
<noscript><div class="cc-noscript">The Command Center needs JavaScript. The older chat is at <a href="/console">/console</a>.</div></noscript>`;

  return shell("MONI AI", body, {
    user: o.user,
    csrf: o.csrf,
    active: "moni-ai",
    dash: "console",
    heading: null,
    pageClass: "cc-page",
    assets: ["moni-ai.css", "cc-map.js", "cc-panels.js", "moni-ai.js"],
    topExtra: TOP_CHIP,
    topEnd: TOP_CLOCK,
  });
}

module.exports = { page, SPRITE };
