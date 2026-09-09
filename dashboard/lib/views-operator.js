"use strict";
/**
 * The server-operator role: which agent may propose root actions, and the
 * passphrase that lets one actually run.
 *
 * This page is written to be read by someone deciding whether to hand a
 * language model the keys to their machine. It therefore spends more space than
 * usual saying what the mechanism does and does not protect against, because
 * the failure mode here is not a broken page -- it is somebody assuming a
 * guarantee that was never made.
 */

const { esc, shell, card, flashes, icon, stamp, ago, empty, can } = require("./ui");

const SUMMARY = `The operator agent can <em>ask</em> to run commands as root. It cannot run
  one. Every request is shown to you in the chat with the exact command, and runs only after
  you approve it with the passphrase below — which the agent never sees.`;

exports.index = ({ csrf, user, operator, agents, audit, flash, err }) => {
  const root = (operator && operator.root) || {};
  const holder = operator && operator.agent;
  const candidates = agents.filter((a) => a.channel);

  return shell(
    "Server operator",
    `${flashes({ msg: flash, err })}

    ${
      holder && !root.configured
        ? `<div class="alert warn">${icon("alert")}<div><strong>${esc(
            operator.agent_name || holder
          )}</strong> holds the role but no approval passphrase is set, so no root action can
          ever be approved. The agent is told this and will say so rather than proposing
          anything. Set one below to make the role usable.</div></div>`
        : ""
    }
    ${
      holder && !operator.administrator
        ? `<div class="alert bad">${icon("alert")}<div>The bound channel has no allowed users,
          so there is no administrator to approve anything and the role is inert. Add your own
          ID to <a href="/channels/${esc(operator.channel)}">the channel</a> — the first entry
          in the list is the administrator.</div></div>`
        : ""
    }
    ${
      root.locked_for
        ? `<div class="alert warn">${icon("alert")}<div>The approval broker is locked for
          another ${Math.ceil(root.locked_for / 60)} minute(s) after repeated wrong
          passphrases. If that was not you, change the passphrase.</div></div>`
        : ""
    }

    ${card(
      "How this works",
      `<p>${SUMMARY}</p>
      <ol class="steps">
        <li>The agent proposes a command, with a written explanation of what it does.</li>
        <li>You are shown the explanation <em>and the exact command</em> in the chat.</li>
        <li>You tap Approve and type the passphrase. Your message is deleted immediately and
            is never passed to the model.</li>
        <li>The command runs as root, once. The ticket cannot be reused.</li>
      </ol>
      <div class="alert info">${icon("info")}<div><strong>What this does not protect against.</strong>
        The agent writes both the explanation and the command, and they need not agree. Read the
        command, not the description. That judgement is yours and nothing here can make it for
        you.</div></div>`,
      { icon: "guide" }
    )}

    ${card(
      "Who holds the role",
      holder
        ? `<table class="kv">
            <tr><td>Agent</td><td><a href="/agents/${esc(holder)}">${esc(
              operator.agent_name || holder
            )}</a> <span class="mono small muted">${esc(holder)}</span></td></tr>
            <tr><td>Channel</td><td>${
              operator.channel
                ? `<a href="/channels/${esc(operator.channel)}">${esc(operator.channel)}</a>
                   <span class="muted small">${esc(operator.channel_type || "")}</span>`
                : `<span class="pill bad">not connected</span>`
            }</td></tr>
            <tr><td>Administrator</td><td>${
              operator.administrator
                ? `<code>${esc(operator.administrator)}</code>
                   <span class="muted small">the only principal who may exercise the role</span>`
                : `<span class="pill bad">none set</span>`
            }</td></tr>
            <tr><td>Other members</td><td>${
              (operator.members || []).length
                ? `${operator.members.map((m) => `<code>${esc(m)}</code>`).join(" ")}
                   <div class="muted small">Can talk to the agent. Their messages are marked as
                     relayed, run unprivileged, and are copied to the administrator.</div>`
                : `<span class="muted">none</span>`
            }</td></tr>
          </table>
          ${
            can(user, "operator.assign")
              ? `<form method="post" action="/operator/assign" class="mt-16"
                       data-confirm="Remove the server operator role from ${esc(
                         operator.agent_name || holder
                       )}?">
                  <input type="hidden" name="_csrf" value="${esc(csrf)}">
                  <input type="hidden" name="agent" value="">
                  <button class="btn danger small" type="submit">${icon(
                    "ban"
                  )} Remove the role</button>
                </form>`
              : ""
          }`
        : `${empty(
            "shield",
            "No agent holds the role",
            "Nothing on this host can propose a root action."
          )}
          ${
            can(user, "operator.assign")
              ? candidates.length
                ? `<form method="post" action="/operator/assign" class="mt-16">
                    <input type="hidden" name="_csrf" value="${esc(csrf)}">
                    <label>Grant it to
                      <select name="agent">
                        ${candidates
                          .map(
                            (a) =>
                              `<option value="${esc(a.slug)}">${esc(a.name)} — ${esc(
                                a.channel
                              )}</option>`
                          )
                          .join("")}
                      </select></label>
                    <p class="muted small">Only one agent may hold it, and only an agent with a
                      channel: the role is exercised by one named person messaging one bot, so
                      an agent nobody can talk to cannot use it.</p>
                    <button class="btn primary" type="submit"
                            data-confirm="Grant the server operator role? That agent will be able to propose commands that run as root.">
                      ${icon("shield")} Grant the role</button>
                  </form>`
                : `<p class="muted mt-12">No agent has a channel yet. Connect one first —
                    the role needs a named administrator to approve anything.</p>`
              : ""
          }`,
      { icon: "shield" }
    )}

    ${
      can(user, "operator.passphrase")
        ? card(
            "Approval passphrase",
            `<table class="kv">
              <tr><td>Status</td><td>${
                root.configured
                  ? `<span class="pill ok">set</span>`
                  : `<span class="pill bad">not set — root actions are disabled</span>`
              }</td></tr>
              <tr><td>Waiting proposals</td><td>${root.pending || 0}</td></tr>
            </table>
            <form method="post" action="/operator/passphrase" autocomplete="off" class="mt-16">
              <input type="hidden" name="_csrf" value="${esc(csrf)}">
              <div class="grid cols-2">
                <label>${root.configured ? "Replace passphrase" : "Set passphrase"}
                  <span class="hint">at least 10 characters; a phrase beats a password</span>
                  <input name="passphrase" type="password" minlength="10" required
                         autocomplete="new-password"></label>
                <label>Repeat
                  <input name="passphrase2" type="password" minlength="10" required
                         autocomplete="new-password"></label>
              </div>
              <p class="muted small">You will type this into the chat each time you approve
                something. Changing it cancels every proposal currently waiting.</p>
              <button class="btn primary" type="submit">${icon("save")} Save passphrase</button>
            </form>
            ${
              root.configured
                ? `<form method="post" action="/operator/passphrase/clear" class="mt-12"
                         data-confirm="Clear the approval passphrase? No root action can be approved until a new one is set.">
                    <input type="hidden" name="_csrf" value="${esc(csrf)}">
                    <button class="btn danger small" type="submit">${icon(
                      "trash"
                    )} Clear passphrase</button>
                  </form>`
                : ""
            }`,
            { icon: "lock" }
          )
        : card(
            "Approval passphrase",
            `<p class="muted">${
              root.configured
                ? "A passphrase is set. Your role does not include changing it."
                : "No passphrase is set, so no root action can be approved."
            }</p>`,
            { icon: "lock" }
          )
    }

    ${card(
      "Root action log",
      audit && audit.length
        ? `<table class="rows">
            <thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
            <tbody>${audit
              .slice()
              .reverse()
              .map(
                (e) => `<tr>
                  <td class="mono small">${esc(stamp(e.ts))}</td>
                  <td><span class="pill ${auditTone(e.event)}">${esc(e.event)}</span></td>
                  <td class="mono small">${esc(auditDetail(e))}</td>
                </tr>`
              )
              .join("")}</tbody></table>`
        : `<p class="muted">Nothing has been proposed yet. Every proposal, approval, refusal and
            failed passphrase appears here — written by the broker as root, where the agent
            cannot edit it.</p>`,
      { icon: "audit" }
    )}`,
    {
      user,
      csrf,
      active: "operator",
      dash: "os",
      heading: "Server operator",
      subtitle: "One agent may propose root commands. You approve each one, in chat, with a passphrase.",
    }
  );
};

function auditTone(event) {
  if (event === "executed" || event === "approved") return "ok";
  if (event === "denied" || event === "proposed") return "neutral";
  return "bad";
}

function auditDetail(entry) {
  const bits = [];
  if (entry.command) bits.push(entry.command);
  else if (entry.reason) bits.push(entry.reason);
  if (entry.exit_code !== undefined) bits.push("exit " + entry.exit_code);
  if (entry.reason && entry.command) bits.push("— " + entry.reason);
  return bits.join(" ").slice(0, 220) || "—";
}
