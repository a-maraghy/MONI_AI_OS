"use strict";
/**
 * The MONI Bot console -- Claude Code, in the panel.
 *
 * This is not a bot somebody messages. It is the administrator at a keyboard,
 * already past a password and a TOTP code, so it runs with the access they
 * already have by other means and there is no approval broker in the way. That
 * is a deliberate difference from the Telegram path: a delegation to a bot that
 * strangers can message needs a gate, and a shell you are sitting in front of
 * does not.
 *
 * What it does owe the reader is honesty about the one risk authentication does
 * not cover, which is why the full-access notice says what it says.
 */

const { esc, shell, card, icon, stamp, ago, empty } = require("./ui");

const MODELS = [
  ["claude-opus-5", "Opus 5", "Most capable. The default."],
  ["claude-sonnet-5", "Sonnet 5", "Faster and cheaper; strong for routine work."],
  ["claude-fable-5-1", "Fable 5.1", "Tuned for writing."],
  ["claude-haiku-4-5-20251001", "Haiku 4.5", "Quickest and cheapest."],
];

const EFFORTS = [
  ["low", "Low", "Answers fast, thinks little."],
  ["medium", "Medium", "The default. Right for most things."],
  ["high", "High", "Thinks longer on hard problems."],
  ["xhigh", "Extra high", "Slower and dearer again."],
  ["max", "Max", "Everything it has. Use sparingly."],
];

const ACCESS = [
  ["full", "Whole server", "Runs as root, anywhere on the machine."],
  ["workspace", "Agent workspace", "Runs as the agent account, confined to its tree."],
];

/**
 * What happens when it wants to change something.
 *
 * Two options, not three. Per-action approval -- "stop and ask me before each
 * command" -- is missing because the CLI does not offer it here: driven
 * non-interactively it never sends the permission requests a host would answer,
 * even in its own manual mode and after the documented handshake. Shipping a
 * third option that silently behaved like Auto would be worse than not having
 * one, so Plan is the way to look before leaping: it works the whole thing out
 * and changes nothing, and you switch to Auto when you are happy.
 */
const MODES = [
  ["auto", "Auto", "Acts without asking. Fastest, and the one to think about."],
  ["plan", "Plan first", "Works out what it would do and reports back. Changes nothing."],
];

const modelLabel = (id) => (MODELS.find((m) => m[0] === id) || [id, id])[1];

function sessionRow(s, activeId) {
  return `<a class="chat-item${s.id === activeId ? " on" : ""}" href="/console/${s.id}"
    data-search="${esc((s.title || "New chat").toLowerCase())}">
    <span class="chat-title">${esc(s.title || "New chat")}</span>
    <span class="chat-meta">${esc(ago(s.updated_at))}${
      s.message_count ? ` · ${s.message_count} message${s.message_count === 1 ? "" : "s"}` : ""
    }</span>
  </a>`;
}

/**
 * The per-chat menu.
 *
 * A details/summary rather than a scripted popover: it opens, closes and takes
 * focus correctly with no JavaScript at all, which matters on a page whose CSP
 * forbids inline handlers. The only script involved closes it when you click
 * elsewhere, and its absence would be an annoyance rather than a broken menu.
 */
function chatMenu(csrf, s) {
  return `<details class="menu">
    <summary aria-label="Chat options" title="Chat options">${icon("dots", 16)}</summary>
    <div class="menu-pop">
      <form method="post" action="/console/${s.id}/rename" class="menu-rename">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Rename
          <input name="title" value="${esc(s.title || "")}" maxlength="80"
                 placeholder="New chat" autocomplete="off"></label>
        <button class="btn primary small" type="submit">Save</button>
      </form>
      <div class="menu-sep"></div>
      <form method="post" action="/console/${s.id}/archive">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <button class="menu-item" type="submit">${icon("archive", 15)} ${
          s.archived ? "Unarchive" : "Archive"
        }</button>
      </form>
      <form method="post" action="/console/${s.id}/delete"
            data-confirm="Delete this chat? The transcript goes with it.">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <button class="menu-item danger" type="submit">${icon("trash", 15)} Delete</button>
      </form>
    </div>
  </details>`;
}

/**
 * Options for the composer's inline pickers.
 *
 * Short labels, because these sit in a strip under the message box where the
 * current value has to read as a word rather than a sentence. The explanation
 * still travels with them as the option's title, so the reasoning is a hover
 * away rather than gone.
 */
const shortOptions = (items, current) =>
  items
    .map(
      ([value, label, hint]) =>
        `<option value="${esc(value)}"${
          value === current ? " selected" : ""
        } title="${esc(hint)}">${esc(label)}</option>`
    )
    .join("");

/** One stored message, rendered the way the live stream renders new ones. */
function renderMessage(m) {
  if (m.role === "user") {
    return `<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`;
  }
  if (m.role === "system") {
    return `<div class="msg system"><div class="note">${esc(m.content)}</div></div>`;
  }
  let meta = null;
  try {
    meta = m.meta ? JSON.parse(m.meta) : null;
  } catch (_) {
    meta = null;
  }
  return `<div class="msg assistant">
    <div class="bubble" data-md>${esc(m.content)}</div>
    ${
      meta && (meta.duration_ms || meta.cost_usd)
        ? `<div class="msg-meta">${
            meta.duration_ms ? Math.round(meta.duration_ms / 100) / 10 + "s" : ""
          }${meta.cost_usd ? ` · $${Number(meta.cost_usd).toFixed(4)}` : ""}${
            meta.model ? ` · ${esc(modelLabel(meta.model))}` : ""
          }</div>`
        : ""
    }
  </div>`;
}

/**
 * The screen a root-enabled chat shows before it will open.
 *
 * The transcript is not rendered behind this -- there is nothing to reveal by
 * inspecting the page, because the server did not send it.
 */
function lockScreen(csrf, s, err) {
  return `<div class="chat-lock">
    <div class="lock-card">
      <span class="lock-ico">${icon("lock", 26)}</span>
      <h2>${esc(s.title || "New chat")}</h2>
      <p class="muted">This chat can change anything on this machine, so opening it
        takes a code as well as a session. Signing in proved who you are; this proves
        you are still the one at the keyboard.</p>
      ${
        err
          ? `<div class="alert bad">${icon("alert")}<div>${esc(err)}</div></div>`
          : ""
      }
      <form method="post" action="/console/${s.id}/unlock" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Authenticator code
          <input name="code" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000"
                 autocomplete="one-time-code" required autofocus></label>
        <button class="btn primary w-full" type="submit">${icon("lock", 15)} Unlock</button>
      </form>
      <p class="muted small">Good for 20 minutes. Turning root off from another chat
        removes the need for this one entirely.</p>
    </div>
  </div>`;
}

/** Confirming that root should be switched on, with a code. */
exports.enableRoot = ({ csrf, user, session, err }) =>
  shell(
    "Turn root on",
    `<div class="chat-lock">
      <div class="lock-card">
        <span class="lock-ico warn">${icon("lock", 26)}</span>
        <h2>Turn root on for this chat?</h2>
        <p class="muted">It will be able to change anything on this machine — install,
          delete, restart, edit any file. Everything it reads is a way to influence what
          it does, so this is worth meaning.</p>
        ${err ? `<div class="alert bad">${icon("alert")}<div>${esc(err)}</div></div>` : ""}
        <form method="post" action="/console/${session.id}/root" autocomplete="off">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <label>Authenticator code
            <input name="code" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000"
                   autocomplete="one-time-code" required autofocus></label>
          <button class="btn primary w-full" type="submit">${icon("lock", 15)} Turn root on</button>
        </form>
        <p class="muted small">The chat restarts and carries on where it left off.
          <a href="/console/${session.id}">Leave it off</a>.</p>
      </div>
    </div>`,
    { user, csrf, active: "console", dash: "console", heading: null, wide: true }
  );

exports.console = ({
  csrf,
  user,
  sessions,
  archived = [],
  session,
  messages,
  dirs,
  voices = [],
  locked = false,
  flash,
  err,
}) => {
  const active = session || null;
  // Root is on unless it has been turned off, and is meaningless outside a
  // whole-server chat -- the workspace profile has no sudo to withdraw.
  const rootOn = !!active && active.access === "full" && active.root_enabled !== 0;

  return shell(
    active ? active.title || "MONI Bot" : "MONI Bot",
    `<div class="chat-layout">
      <div class="chat-scrim" data-chats-close hidden></div>
      <aside class="chat-list" id="chat-list">
        <form method="post" action="/console/new" class="chat-new">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <button class="btn primary w-full" type="submit">${icon("plus", 15)} New chat</button>
        </form>

        ${
          sessions.length + archived.length > 6
            ? `<div class="chat-filter">
                ${icon("search", 14)}
                <input id="chat-filter" type="search" placeholder="Find a chat"
                       aria-label="Filter chats" autocomplete="off">
              </div>`
            : ""
        }

        <nav class="chat-items" id="chat-items">
          ${
            sessions.length
              ? sessions.map((s) => sessionRow(s, active && active.id)).join("")
              : `<p class="muted small chat-none">No chats yet. Start one above.</p>`
          }
        </nav>

        ${
          archived.length
            ? `<details class="chat-archive"${
                active && active.archived ? " open" : ""
              }>
                <summary>${icon("archive", 13)} Archived
                  <span class="count">${archived.length}</span></summary>
                <nav class="chat-items">
                  ${archived.map((s) => sessionRow(s, active && active.id)).join("")}
                </nav>
              </details>`
            : ""
        }
      </aside>

      <section class="chat-main">
        ${
          !active
            ? // The topline carries the only way to reach the chat list once it
              // becomes a drawer, so it is rendered even with nothing open --
              // otherwise a phone with no chat selected has no way to pick one.
              `<div class="chat-topline">
                 <button class="chats-toggle" type="button" aria-label="Chats"
                         aria-expanded="false" aria-controls="chat-list"
                         data-chats-toggle>${icon("sidebar", 18)}</button>
                 <span class="chat-name">MONI Bot</span>
               </div>
               <div class="chat-empty">${empty(
                 "agents",
                 "MONI Bot",
                 "Your direct line to this machine. Start a chat to run anything Claude Code can run, here rather than over SSH."
               )}</div>`
            : locked
              ? `<div class="chat-topline">
                   <button class="chats-toggle" type="button" aria-label="Chats"
                           aria-expanded="false" aria-controls="chat-list"
                           data-chats-toggle>${icon("sidebar", 18)}</button>
                   <span class="chat-name">${esc(active.title || "New chat")}</span>
                 </div>
                 ${lockScreen(csrf, active, err)}`
              : `
          <div class="chat-topline">
            <button class="chats-toggle" type="button" aria-label="Chats"
                    aria-expanded="false" aria-controls="chat-list"
                    data-chats-toggle>${icon("sidebar", 18)}</button>
            <span class="chat-name">${esc(active.title || "New chat")}</span>
            ${
              active.archived
                ? `<span class="pill neutral">archived</span>`
                : ""
            }
            ${chatMenu(csrf, active)}
          </div>

          ${
            active.access === "full" && rootOn
              ? `<details class="chat-notice" id="chat-notice">
                  <summary>${icon("lock", 13)} Runs as root on this machine — what that means</summary>
                  <p>The same reach you have over SSH, with tool permissions decided by the
                    mode below. Signing in took a password and a code, so that part is
                    covered. What it does not cover is that the model acts on what it
                    <em>reads</em>: a file, a page or a log containing instructions is a way to
                    make it act. Point it at untrusted content with that in mind.</p>
                  ${
                    active.started
                      ? ""
                      : `<p><a href="#" data-set-access="workspace">Confine this chat to the agent workspace instead</a>.</p>`
                  }
                </details>`
              : ""
          }

          <div class="chat-scroll" id="chat-scroll" data-session="${active.id}">
            ${
              messages.length
                ? messages.map(renderMessage).join("")
                : `<div class="chat-hint">
                    <p class="muted">Ask it anything you would ask Claude Code on this box —
                      read a log, fix a config, check why a service is unhappy, write a script.</p>
                    <div class="chips">
                      <button class="chip-link" type="button" data-suggest="Summarise what is running on this machine and flag anything unhealthy.">Health check</button>
                      <button class="chip-link" type="button" data-suggest="Show the last 50 lines of the moni-dashboard journal and explain any errors.">Read the panel log</button>
                      <button class="chip-link" type="button" data-suggest="How much disk is free, and what are the ten largest directories under /opt?">Disk usage</button>
                    </div>
                  </div>`
            }
          </div>

          <!--
            The composer is a div, not a form, because the settings controls sit
            inside it and a form cannot contain another form. The console needs
            JavaScript to work at all -- it reads a streaming response -- so
            there is no no-script behaviour being given up here.
          -->
          <div class="chat-compose" id="chat-compose" data-session="${active.id}"
               data-csrf="${esc(csrf)}">
            <div class="composer">
              <div class="attachments" id="chat-attachments" hidden></div>

              <textarea id="chat-input" rows="2"
                        placeholder="Message MONI Bot…  Paste or drop files, or hold the mic."></textarea>

              <input type="file" id="chat-file" multiple hidden>

              <div class="composer-bar">
                <form method="post" action="/console/${active.id}/settings" class="chat-controls">
                  <input type="hidden" name="_csrf" value="${esc(csrf)}">
                  <span class="pick" title="Model">
                    ${icon("cpu", 13)}
                    <select name="model" data-autosubmit aria-label="Model">
                      ${shortOptions(MODELS, active.model)}
                    </select>
                  </span>
                  <span class="pick" title="Thinking effort">
                    ${icon("activity", 13)}
                    <select name="effort" data-autosubmit aria-label="Thinking effort">
                      ${shortOptions(EFFORTS, active.effort)}
                    </select>
                  </span>
                  <span class="pick${rootOn ? " hot" : ""}"
                        title="${
                          active.started
                            ? "Fixed once a chat has started"
                            : "Where this chat can reach"
                        }">
                    ${icon(active.access === "full" ? "lock" : "shield", 13)}
                    <select name="access" data-autosubmit aria-label="Access"${
                      active.started ? " disabled" : ""
                    }>${shortOptions(ACCESS, active.access)}</select>
                  </span>
                </form>

                ${
                  active.access !== "full"
                    ? ""
                    : rootOn
                      ? `<form method="post" action="/console/${active.id}/root" class="root-toggle"
                              data-confirm="Turn root off for this chat? sudo stops working here. The conversation carries over.">
                          <input type="hidden" name="_csrf" value="${esc(csrf)}">
                          <button class="toggle on" type="submit" aria-pressed="true"
                                  title="Root is on. Click to switch it off — no code needed to give it up.">
                            <span class="toggle-track"><span class="toggle-knob"></span></span>
                            <span class="toggle-label">root</span>
                          </button>
                        </form>`
                      : // A link to a page, not a panel that unfolds here. This
                        // control sits at the bottom edge of the window inside a
                        // pane that clips, which a popover kept losing an
                        // argument with; and turning on root is a deliberate act
                        // that reads better as a screen than as a hover.
                        `<a class="toggle" href="/console/${active.id}/root"
                            title="Root is off. Switching it on needs a code from your authenticator.">
                          <span class="toggle-track"><span class="toggle-knob"></span></span>
                          <span class="toggle-label">root</span>
                        </a>`
                }

                <!--
                  A second settings form rather than one wrapping the toggle:
                  the toggle is its own POST, and forms cannot nest. Each form
                  carries only its own fields, and the route applies only values
                  it recognises, so a partial submission changes only what it
                  actually named.
                -->
                <form method="post" action="/console/${active.id}/settings" class="chat-controls grow">
                  <input type="hidden" name="_csrf" value="${esc(csrf)}">
                  <span class="pick${active.permission_mode === "plan" ? " plan" : ""}" title="What happens when it wants to change something">
                    ${icon(active.permission_mode === "plan" ? "guide" : "play", 13)}
                    <select name="permission_mode" data-autosubmit aria-label="Permission mode">
                      ${shortOptions(MODES, active.permission_mode || "auto")}
                    </select>
                  </span>
                  <span class="pick wide" title="Working directory">
                    ${icon("file", 13)}
                    <select name="cwd" data-autosubmit aria-label="Working directory">
                      ${dirs
                        .map(
                          (d) =>
                            `<option value="${esc(d)}"${
                              d === active.cwd ? " selected" : ""
                            }>${esc(d)}</option>`
                        )
                        .join("")}
                      ${
                        dirs.includes(active.cwd)
                          ? ""
                          : `<option value="${esc(active.cwd)}" selected>${esc(
                              active.cwd
                            )}</option>`
                      }
                    </select>
                  </span>
                </form>

                ${
                  voices.length
                    ? `<span class="chat-controls live-controls">
                         <button class="icon-btn live-btn" type="button" id="chat-live"
                                 aria-pressed="false"
                                 title="Live mode — talk to it and hear the answer">${icon(
                                   "voice",
                                   15
                                 )}<span>Live</span></button>
                         <select class="pick" id="chat-voice" aria-label="Voice"
                                 title="Which voice answers">
                           ${voices
                             .map(
                               (v) =>
                                 `<option value="${esc(v.name)}">${esc(v.label)}</option>`
                             )
                             .join("")}
                         </select>
                       </span>`
                    : ""
                }

                <span class="muted small composer-status" id="chat-status"></span>
                <button class="icon-btn" type="button" id="chat-attach"
                        title="Attach files (or just paste them)">${icon("plus", 15)}</button>
                <button class="icon-btn" type="button" id="chat-mic"
                        title="Record a voice message">${icon("voice", 15)}</button>
                <button class="btn small" type="button" id="chat-stop" hidden>${icon(
                  "stop",
                  14
                )} Stop</button>
                <button class="btn primary small" type="button" id="chat-send">${icon(
                  "play",
                  14
                )} Send</button>
              </div>
            </div>
            <p class="composer-hint muted small">Enter to send · Shift+Enter for a new line</p>
          </div>`
        }
      </section>
    </div>`,
    {
      user,
      csrf,
      active: "console",
      dash: "console",
      heading: null,
      wide: true,
    }
  );
};

exports.MODELS = MODELS;
exports.EFFORTS = EFFORTS;
exports.ACCESS = ACCESS;
exports.MODES = MODES;
