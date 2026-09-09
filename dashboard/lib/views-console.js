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

const modelLabel = (id) => (MODELS.find((m) => m[0] === id) || [id, id])[1];

function sessionRow(s, activeId) {
  return `<a class="chat-item${s.id === activeId ? " on" : ""}" href="/console/${s.id}">
    <span class="chat-title">${esc(s.title || "New chat")}</span>
    <span class="chat-meta">${esc(modelLabel(s.model))} · ${esc(ago(s.updated_at))}</span>
  </a>`;
}

const optionList = (items, current) =>
  items
    .map(
      ([value, label, hint]) =>
        `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(
          label
        )} — ${esc(hint)}</option>`
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
    <div class="bubble">${esc(m.content)}</div>
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

exports.console = ({ csrf, user, sessions, session, messages, dirs, flash, err }) => {
  const active = session || null;

  return shell(
    active ? active.title || "MONI Bot" : "MONI Bot",
    `<div class="chat-layout">
      <aside class="chat-list">
        <form method="post" action="/console/new">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <button class="btn primary w-full" type="submit">${icon("plus")} New chat</button>
        </form>
        <div class="chat-items">
          ${
            sessions.length
              ? sessions.map((s) => sessionRow(s, active && active.id)).join("")
              : `<p class="muted small pad-8">No chats yet.</p>`
          }
        </div>
      </aside>

      <section class="chat-main">
        ${
          !active
            ? `<div class="chat-empty">${empty(
                "agents",
                "MONI Bot",
                "Your direct line to this machine. Start a chat to run anything Claude Code can run, here rather than over SSH."
              )}</div>`
            : `
          <div class="chat-head">
            <form method="post" action="/console/${active.id}/settings" class="chat-controls">
              <input type="hidden" name="_csrf" value="${esc(csrf)}">
              <label class="tight">Model
                <select name="model" data-autosubmit>${optionList(MODELS, active.model)}</select>
              </label>
              <label class="tight">Effort
                <select name="effort" data-autosubmit>${optionList(EFFORTS, active.effort)}</select>
              </label>
              <label class="tight">Access
                <select name="access" data-autosubmit${
                  active.started ? " disabled" : ""
                }>${optionList(ACCESS, active.access)}</select>
              </label>
              <label class="tight grow">Directory
                <select name="cwd" data-autosubmit>
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
                      : `<option value="${esc(active.cwd)}" selected>${esc(active.cwd)}</option>`
                  }
                </select>
              </label>
              <noscript><button class="btn small" type="submit">Apply</button></noscript>
            </form>
            <div class="chat-head-right">
              <form method="post" action="/console/${active.id}/delete" class="inline"
                    data-confirm="Delete this chat?">
                <input type="hidden" name="_csrf" value="${esc(csrf)}">
                <button class="btn danger small" type="submit">${icon("trash")}</button>
              </form>
            </div>
          </div>

          ${
            active.access === "full"
              ? `<div class="alert warn chat-notice">${icon("alert")}<div>
                  This chat runs as <strong>root on the whole machine</strong>, with tool
                  permissions bypassed — the same reach you have over SSH. Signing in took a
                  password and a code, so that part is covered. What it does not cover is that
                  the model acts on what it reads: a file, a page, or a log containing
                  instructions is a way to make it act. Point it at untrusted content with that
                  in mind.
                  ${
                    active.started
                      ? ""
                      : ` <a href="#" data-set-access="workspace">Confine to the agent workspace instead</a>.`
                  }
                </div></div>`
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

          <form class="chat-compose" id="chat-compose" data-session="${active.id}"
                data-csrf="${esc(csrf)}" method="post" action="/console/${active.id}/send">
            <input type="hidden" name="_csrf" value="${esc(csrf)}">
            <textarea name="prompt" id="chat-input" rows="3"
                      placeholder="Message MONI Bot…  (Enter to send, Shift+Enter for a new line)"
                      required></textarea>
            <div class="chat-send-row">
              <span class="muted small" id="chat-status"></span>
              <button class="btn" type="button" id="chat-stop" hidden>${icon("stop")} Stop</button>
              <button class="btn primary" type="submit" id="chat-send">${icon("play")} Send</button>
            </div>
          </form>`
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
