"use strict";
/** Service management — system units, and the per-agent units. */

const { esc, bytes, shell, statusPill, agentPill, card, flashes, empty, icon, ago } =
  require("./ui");
const { OS_SERVICES } = require("./catalog");

const DETAIL = new Map(OS_SERVICES.map((s) => [s.unit, s]));

function controls(csrf, action, target, state) {
  const running = state.active === "active";
  const button = (act, label, cls, confirm) => `
    <form method="post" action="${action}" class="inline"${
      confirm ? ` data-confirm="${esc(confirm)}"` : ""
    }>
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <input type="hidden" name="target" value="${esc(target)}">
      <input type="hidden" name="action" value="${act}">
      <button class="btn ${cls} small" type="submit">${label}</button>
    </form>`;

  const parts = [];
  if (running) {
    parts.push(button("restart", "Restart", "", "Restart " + target + "?"));
  } else {
    parts.push(button("start", "Start", "primary"));
  }
  if (running && state.stoppable !== false) {
    parts.push(button("stop", "Stop", "danger", "Stop " + target + "?"));
  }
  return `<div style="display:flex;gap:6px;justify-content:flex-end">${parts.join("")}</div>`;
}

/* ------------------------------------------------------- system services -- */

exports.system = ({ csrf, user, services, flash, err }) =>
  shell(
    "Services",
    `${flashes({ msg: flash, err })}
    <div class="alert info">${icon("info")}<div>SSH, nginx, the firewall and this panel
      can be restarted but not stopped from here. Stopping any of them would cut off
      access to the machine or to this page, and getting back in would need the Contabo
      console.</div></div>

    ${card(
      "System services",
      `<table class="rows">
        <thead><tr><th>Service</th><th>State</th><th>At boot</th><th>Memory</th><th>Since</th><th></th></tr></thead>
        <tbody>${services
          .map((s) => {
            const meta = DETAIL.get(s.unit) || {};
            return `<tr>
              <td>
                <span class="strong">${esc(meta.name || s.unit)}</span>
                <div class="muted small mono">${esc(s.unit)}</div>
                ${meta.detail ? `<div class="muted small">${esc(meta.detail)}</div>` : ""}
              </td>
              <td>${statusPill(s.active)}</td>
              <td class="small">${esc(s.enabled)}${
                s.socket_activated
                  ? `<div class="muted small">via socket</div>`
                  : ""
              }</td>
              <td class="mono small">${s.memory != null ? bytes(s.memory) : "—"}</td>
              <td class="mono small">${esc((s.since || "").slice(0, 19) || "—")}</td>
              <td class="right">
                ${controls(csrf, "/services/action", s.unit, s)}
                <div style="margin-top:6px"><a class="btn small" href="/services/logs?unit=${encodeURIComponent(
                  s.unit
                )}">Logs</a></div>
              </td>
            </tr>`;
          })
          .join("")}</tbody></table>`,
      { icon: "services" }
    )}`,
    {
      user,
      csrf,
      active: "services",
      heading: "System services",
      subtitle: "The units that keep the machine and this panel running.",
    }
  );

/* -------------------------------------------------------- agent services -- */

exports.agents = ({ csrf, user, agents, flash, err }) =>
  shell(
    "Agent services",
    `${flashes({ msg: flash, err })}
    ${
      agents.length
        ? card(
            "Agent processes",
            `<table class="rows">
              <thead><tr><th>Agent</th><th>State</th><th>At boot</th><th>Channel</th><th>Since</th><th></th></tr></thead>
              <tbody>${agents
                .map(
                  (a) => `<tr>
                  <td>
                    <a class="strong" href="/agents/${esc(a.slug)}">${esc(a.name || a.slug)}</a>
                    <div class="muted small mono">moni-agent@${esc(a.slug)}</div>
                  </td>
                  <td>${agentPill(a.state && a.state.active)}</td>
                  <td class="small">${esc((a.state && a.state.enabled) || "—")}</td>
                  <td class="small">${
                    a.channel
                      ? `<a href="/channels/${esc(a.channel.slug)}">${esc(a.channel.name)}</a>`
                      : `<span class="muted">none</span>`
                  }</td>
                  <td class="mono small">${esc(((a.state && a.state.since) || "").slice(0, 19) || "—")}</td>
                  <td class="right">
                    ${controls(csrf, "/services/agent-action", a.slug, (a.state || {}))}
                    <div style="margin-top:6px"><a class="btn small" href="/agents/${esc(
                      a.slug
                    )}/logs">Logs</a></div>
                  </td>
                </tr>`
                )
                .join("")}</tbody></table>`,
            { icon: "agents" }
          )
        : card(
            "",
            empty(
              "agents",
              "No agents yet",
              'Create one from <a href="/agents">Agents</a>.'
            )
          )
    }`,
    {
      user,
      csrf,
      active: "agent-services",
      heading: "Agent services",
      subtitle:
        "One systemd unit per agent. Restarting an agent does not lose its memory or its conversation — both are on disk.",
    }
  );

/* ------------------------------------------------------------------ logs -- */

exports.logs = ({ csrf, user, unit, lines, err }) =>
  shell(
    "Logs — " + unit,
    `${flashes({ err })}
    ${card(
      "Last " + lines.length + " lines · " + unit,
      lines.length
        ? `<pre class="logs">${esc(lines.join("\n"))}</pre>`
        : `<p class="muted">Nothing logged.</p>`,
      {
        icon: "logs",
        actions: `<a class="btn small" href="/services/logs?unit=${encodeURIComponent(
          unit
        )}">${icon("restart")} Refresh</a>`,
      }
    )}
    <p class="muted small">Secrets are stripped from this view before it reaches the
      browser. Live tail from a shell: <code>journalctl -u ${esc(unit)} -f</code></p>`,
    {
      user,
      csrf,
      active: "services",
      heading: unit,
      subtitle: "Journal output for this unit.",
      actions: `<a class="btn" href="/services">${icon("chevron")} All services</a>`,
    }
  );
