"use strict";
/** Agent management, and the Agents Dashboard. */

const {
  esc,
  bytes,
  shell,
  agentPill,
  card,
  stat,
  flashes,
  empty,
  icon,
  stamp,
  ago,
  can,
  steps,
} = require("./ui");
const { byScope } = require("./catalog");
const { renderAddons } = require("./views-addons");

const MODELS = [
  ["claude-opus-5", "Opus 5 — most capable"],
  ["claude-sonnet-5", "Sonnet 5 — faster, cheaper"],
  ["claude-fable-5-1", "Fable 5.1 — tuned for writing"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5 — fastest"],
];

/** How hard the agent thinks before answering. */
const EFFORTS = [
  ["low", "Low — answers fast, thinks little"],
  ["medium", "Medium — the default, right for most agents"],
  ["high", "High — thinks longer on hard problems"],
  ["xhigh", "Extra high — slower and dearer again"],
  ["max", "Max — everything it has, for genuinely hard reasoning"],
];

const effortSelect = (current) =>
  `<label>Thinking effort <span class="hint">higher levels cost noticeably more time and tokens on every turn, so raise it for agents that reason rather than agents that answer</span>
    <select name="effort">
      ${EFFORTS.map(
        ([id, label]) =>
          `<option value="${id}"${
            (current || "medium") === id ? " selected" : ""
          }>${label}</option>`
      ).join("")}
    </select></label>`;

function tabs(slug, active) {
  const items = [
    ["", "overview", "Overview"],
    ["/instructions", "instructions", "Instructions"],
    ["/memory", "memory", "Memory"],
    ["/logs", "logs", "Logs"],
    ["/settings", "settings", "Settings"],
  ];
  return `<nav class="tabs">${items
    .map(
      ([suffix, key, label]) =>
        `<a href="/agents/${esc(slug)}${suffix}" class="${active === key ? "on" : ""}">${label}</a>`
    )
    .join("")}</nav>`;
}

function controls(csrf, agent) {
  const state = agent.state || {};
  const running = state.active === "active";
  const button = (action, label, cls, iconName) => `
    <form method="post" action="/agents/${esc(agent.slug)}/action" class="inline">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <input type="hidden" name="action" value="${action}">
      <button class="btn ${cls} small" type="submit">${icon(iconName)} ${label}</button>
    </form>`;
  const parts = [];
  if (running) {
    parts.push(button("restart", "Restart", "", "restart"));
    parts.push(button("stop", "Stop", "danger", "stop"));
  } else {
    parts.push(button("start", "Start", "primary", "play"));
  }
  return `<div class="btn-row">${parts.join("")}</div>`;
}

/* ------------------------------------------------------ agents dashboard - */

exports.dashboard = ({ csrf, user, agents, channels, probe, flash, err }) => {
  const running = agents.filter((a) => a.state && a.state.active === "active");
  const failed = agents.filter((a) => a.state && a.state.active === "failed");
  const noChannel = agents.filter((a) => !a.channel);
  const totalNotes = agents.reduce((n, a) => n + (a.notes || 0), 0);
  const totalChunks = agents.reduce((n, a) => n + ((a.memory || {}).chunks || 0), 0);

  return shell(
    "Agents Dashboard",
    `${flashes({ msg: flash, err })}
    ${
      probe && !probe.claude_credential
        ? `<div class="alert warn">${icon("alert")}<div>No Claude credential is set, so
           agents can receive messages but cannot answer.
           <a href="/credentials">Set one now</a>.</div></div>`
        : ""
    }
    ${
      // systemd reads an EnvironmentFile only at unit start, so an agent that
      // was already running when the credential changed still holds the old
      // one. It looks configured everywhere and fails at the only moment that
      // matters, so it is called out rather than left to be discovered.
      probe && (probe.credential_stale_agents || []).length
        ? `<div class="alert warn">${icon("alert")}<div>The Claude credential changed after
           ${probe.credential_stale_agents.map(esc).join(", ")} started, so
           ${probe.credential_stale_agents.length === 1 ? "it is" : "they are"} still
           running with the old one and cannot authenticate. Restart from
           <a href="/services/agents">Agent services</a>.</div></div>`
        : ""
    }
    ${
      failed.length
        ? `<div class="alert bad">${icon("alert")}<div>${failed.length} agent${
            failed.length === 1 ? " is" : "s are"
          } in a failed state:
           ${failed.map((a) => `<a href="/agents/${esc(a.slug)}/logs">${esc(a.name || a.slug)}</a>`).join(", ")}</div></div>`
        : ""
    }
    ${
      noChannel.length
        ? `<div class="alert warn">${icon("alert")}<div>${noChannel.length} agent${
            noChannel.length === 1 ? " has" : "s have"
          } no channel and cannot be reached:
           ${noChannel.map((a) => `<a href="/agents/${esc(a.slug)}">${esc(a.name || a.slug)}</a>`).join(", ")}.
           <a href="/channels/new">Add a channel</a>.</div></div>`
        : ""
    }

    <div class="statrow">
      ${stat(running.length + " / " + agents.length, "agents running", "agents")}
      ${stat(channels.length, "channels", "channels")}
      ${stat(totalNotes, "memory notes", "memory")}
      ${stat(totalChunks, "indexed chunks", "search")}
    </div>

    ${
      agents.length
        ? card(
            "Fleet",
            `<table class="rows">
              <thead><tr><th>Agent</th><th>State</th><th>Channel</th><th>Memory</th><th>Model</th><th></th></tr></thead>
              <tbody>${agents
                .map(
                  (a) => `<tr>
                  <td>
                    <a class="strong" href="/agents/${esc(a.slug)}">${esc(a.name || a.slug)}</a>
                    <div class="muted small mono">${esc(a.slug)}</div>
                  </td>
                  <td>${agentPill(a.state && a.state.active)}</td>
                  <td class="small">${
                    a.channel
                      ? `<a href="/channels/${esc(a.channel.slug)}">${esc(a.channel.name)}</a>
                         ${
                           // Only when it adds something: a channel named after
                           // its bot would otherwise print the handle twice.
                           a.channel.telegram_bot_username &&
                           a.channel.name !== "@" + a.channel.telegram_bot_username
                             ? `<div class="muted small mono">@${esc(a.channel.telegram_bot_username)}</div>`
                             : ""
                         }`
                      : `<span class="muted">none</span>`
                  }</td>
                  <td class="mono small">${a.notes || 0} notes · ${(a.memory || {}).chunks || 0} chunks</td>
                  <td class="mono small">${esc(a.model || "—")}</td>
                  <td class="right">${controls(csrf, a)}</td>
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
              'An agent is a Claude session with its own memory. <a href="/agents/new">Create the first one</a>.'
            )
          )
    }`,
    {
      user,
      csrf,
      active: "agents-dashboard",
      heading: "Agents Dashboard",
      subtitle: "Every agent on this machine, and what it can reach.",
      statusChip: running.length + " running",
      actions: `<a class="btn primary" href="/agents/new">${icon("plus")} New agent</a>`,
    }
  );
};

/* ----------------------------------------------------------------- list --- */

exports.list = ({ csrf, user, agents, flash, err }) =>
  shell(
    "Agents",
    `${flashes({ msg: flash, err })}
    ${
      agents.length
        ? card(
            "All agents",
            `<table class="rows">
              <thead><tr><th>Agent</th><th>State</th><th>Channel</th><th>Memory</th><th>Model</th><th></th></tr></thead>
              <tbody>${agents
                .map(
                  (a) => `<tr>
                  <td>
                    <a class="strong" href="/agents/${esc(a.slug)}">${esc(a.name || a.slug)}</a>
                    <div class="muted small mono">${esc(a.slug)}</div>
                  </td>
                  <td>${agentPill(a.state && a.state.active)}</td>
                  <td class="small">${
                    a.channel
                      ? `<a href="/channels/${esc(a.channel.slug)}">${esc(a.channel.name)}</a>`
                      : `<span class="muted">none</span>`
                  }</td>
                  <td class="mono small">${a.notes || 0} notes · ${(a.memory || {}).chunks || 0} chunks</td>
                  <td class="mono small">${esc(a.model || "—")}</td>
                  <td class="right">${controls(csrf, a)}</td>
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
              'An agent is one Claude session with its own workspace and memory. <a href="/agents/new">Create the first one</a>.'
            )
          )
    }

    ${card(
      "What an agent gets",
      `<table class="kv">
        <tr><td>Workspace</td><td class="muted">An isolated directory it may read and write. Nothing outside it.</td></tr>
        <tr><td>Memory vault</td><td class="muted">CLAUDE.md, MEMORY.md, WORKLOG.md and memory/ — a real Obsidian vault.</td></tr>
        <tr><td>Vector index</td><td class="muted">Local embeddings over that vault, which the agent searches itself.</td></tr>
        <tr><td>systemd unit</td><td class="muted">Restarts on crash, starts on boot, logs to the journal.</td></tr>
        <tr><td>A channel</td><td class="muted">Added separately, so you can change how it is reached without rebuilding it.</td></tr>
      </table>`,
      { icon: "info" }
    )}`,
    {
      user,
      csrf,
      active: "agents",
      heading: "Agents",
      subtitle:
        "Each agent is one Claude session with its own memory. They cannot see each other.",
      actions: `<a class="btn primary" href="/agents/new">${icon("plus")} New agent</a>`,
    }
  );

/* ------------------------------------------------------------------ new --- */

exports.create = ({ csrf, user, form = {}, errors = [], probe }) => {
  const v = (k, d) => esc(form[k] != null && form[k] !== "" ? form[k] : d == null ? "" : d);
  const chosen =
    form.addons ||
    byScope("agent")
      .filter((a) => a.default || a.locked)
      .map((a) => a.id);

  return shell(
    "New agent",
    `${steps(1, ["Create the agent", "Connect a channel"])}
    ${errors.length ? `<div class="alert bad">${icon("alert")}<div>${errors.map(esc).join("<br>")}</div></div>` : ""}
    <div class="alert info">${icon("info")}<div>An agent is the mind: a workspace, a memory
      vault and a role. It has no way to be reached until a channel is connected, which is
      the next step — you will be taken straight there.</div></div>

    <form method="post" action="/agents/new" autocomplete="off">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">

      ${card(
        "Identity",
        `<label>Display name <span class="hint">what you call it</span>
          <input name="name" value="${v("name")}" placeholder="e.g. Odoo Dev" maxlength="64" required autofocus></label>
        <label>Short name <span class="hint">lowercase; names the folder and the systemd unit, and cannot be changed later</span>
          <input name="slug" value="${v("slug")}" placeholder="odoo-dev"
                 pattern="[a-z][a-z0-9-]{1,30}" maxlength="31" required></label>
        <label>Role <span class="hint">written into CLAUDE.md and loaded on every request — this is the field that decides whether the agent is useful</span>
          <textarea name="role" rows="7" placeholder="You maintain the Odoo 17 instance at /opt/projects/odoo. You handle module changes, migrations and deployment. You may edit code and run tests unattended. Ask before restarting the service during working hours.">${v("role")}</textarea></label>`,
        { icon: "agents" }
      )}

      ${card(
        "Behaviour",
        `<label>Model
          <select name="model">
            ${MODELS.map(
              ([id, label]) =>
                `<option value="${id}" ${form.model === id ? "selected" : ""}>${label}</option>`
            ).join("")}
          </select></label>
        ${effortSelect(form.effort)}
        <label>Verbosity <span class="hint">how much of its own work it narrates in chat</span>
          <select name="verbose_level">
            <option value="0" ${form.verbose_level === "0" ? "selected" : ""}>Quiet — final answer only</option>
            <option value="1" ${form.verbose_level !== "0" && form.verbose_level !== "2" ? "selected" : ""}>Normal — tool names as it works</option>
            <option value="2" ${form.verbose_level === "2" ? "selected" : ""}>Detailed — tools with inputs</option>
          </select></label>
        <label>Project directory <span class="hint">optional. Must be under /opt/projects, /srv or /opt/moni-agents/workspaces. Appears inside the vault as <code>project/</code>.</span>
          <input name="project_dir" value="${v("project_dir")}" placeholder="/opt/projects/odoo"></label>`,
        { icon: "settings" }
      )}

      ${card(
        "Add-ons",
        `<p class="muted small">What this agent can do once a message reaches it. What it
          can <em>receive</em> is set on its channel.</p>
        ${renderAddons(byScope("agent"), chosen, probe)}`,
        { icon: "addons" }
      )}

      ${card(
        "",
        `<p class="muted small">On save the vault is scaffolded and the vector index is
          built. Takes a few seconds. You then go straight to connecting a channel.</p>
        <button class="btn primary" type="submit">${icon("plus")} Create agent and continue</button>
        <a class="btn" href="/agents">Cancel</a>`
      )}
    </form>`,
    {
      user,
      csrf,
      active: "agents",
      heading: "Create an agent",
      subtitle: "Step 1 of 2 — the mind. The channel it answers on comes next.",
    }
  );
};

/* --------------------------------------------------------------- detail --- */

exports.detail = ({ csrf, user, agent, notes = [], flash, err }) => {
  const mem = agent.memory || {};
  const state = agent.state || {};
  const ch = agent.channel;

  return shell(
    agent.name || agent.slug,
    `${tabs(agent.slug, "overview")}
    ${flashes({ msg: flash, err })}

    ${
      !ch
        ? `<div class="alert warn">${icon("alert")}<div>No channel is connected, so this
           agent cannot receive messages and is not running.
           <a href="/channels/new">Add a channel</a>.</div></div>`
        : ""
    }
    ${
      state.active === "failed"
        ? `<div class="alert bad">${icon("alert")}<div>This agent is in a failed state. The
           <a href="/agents/${esc(agent.slug)}/logs">logs</a> will say why — a rejected bot
           token and a missing Claude credential are the two usual causes.</div></div>`
        : ""
    }
    ${
      agent.server_operator
        ? `<div class="alert warn">${icon("shield")}<div>This agent holds the
           <strong>server operator</strong> role: it can ask to run commands as root on this
           machine. It cannot run one — each request is shown to the channel's administrator
           with the exact command, and runs only after they approve it with the passphrase.
           <a href="/operator">Manage the role</a>.</div></div>`
        : ""
    }

    <div class="grid">
      ${card(
        "Service",
        `<table class="kv">
          <tr><td>State</td><td>${agentPill(state.active)}</td></tr>
          <tr><td>At boot</td><td>${esc(state.enabled || "—")}</td></tr>
          <tr><td>Since</td><td class="mono small">${esc((state.since || "").slice(0, 19) || "—")}</td></tr>
          <tr><td>Unit</td><td class="mono small">moni-agent@${esc(agent.slug)}</td></tr>
        </table>
        ${controls(csrf, agent)}`,
        { icon: "services" }
      )}

      ${card(
        "Channel",
        ch
          ? `<table class="kv">
              <tr><td>Channel</td><td><a href="/channels/${esc(ch.slug)}">${esc(ch.name)}</a></td></tr>
              <tr><td>Type</td><td>${esc(ch.type)}</td></tr>
              ${
                ch.telegram_bot_username
                  ? `<tr><td>Bot</td><td class="mono small">@${esc(ch.telegram_bot_username)}</td></tr>`
                  : ""
              }
              <tr><td>Allowed</td><td class="mono small">${esc(ch.allowed_users || "nobody")}</td></tr>
            </table>
            ${
              ch.telegram_bot_username
                ? `<p class="muted small mt-8">Open the chat:
                   <code>https://t.me/${esc(ch.telegram_bot_username)}</code></p>`
                : ""
            }`
          : `<p class="muted">Not connected.</p>
             <div class="btn-row"><a class="btn primary small" href="/channels/new">${icon(
               "plus"
             )} Add a channel</a></div>`,
        { icon: "channels" }
      )}

      ${card(
        "Memory",
        `<table class="kv">
          <tr><td>Notes</td><td>${agent.notes || 0} markdown files</td></tr>
          <tr><td>Indexed</td><td>${mem.files || 0} files · ${mem.chunks || 0} chunks</td></tr>
          <tr><td>Index size</td><td>${bytes(mem.bytes || 0)}</td></tr>
          <tr><td>Last indexed</td><td class="mono small">${esc(ago(mem.last_indexed))}</td></tr>
        </table>
        <div class="btn-row">
          <a class="btn small" href="/agents/${esc(agent.slug)}/memory">${icon("search")} Browse</a>
          <form method="post" action="/agents/${esc(agent.slug)}/memory/reindex" class="inline">
            <input type="hidden" name="_csrf" value="${esc(csrf)}">
            <button class="btn small" type="submit">${icon("reindex")} Reindex</button>
          </form>
        </div>`,
        { icon: "memory" }
      )}

      ${card(
        "Configuration",
        `<table class="kv">
          <tr><td>Model</td><td class="mono small">${esc(agent.model || "—")}</td></tr>
          <tr><td>Thinking effort</td><td>${esc(agent.effort || "medium")}</td></tr>
          <tr><td>Verbosity</td><td>${esc(String(agent.verbose_level))}</td></tr>
          <tr><td>Max turns</td><td>${esc(String(agent.max_turns || "—"))}</td></tr>
          <tr><td>Timeout</td><td>${esc(String(agent.timeout_seconds || "—"))}s</td></tr>
          <tr><td>Project</td><td class="mono small">${esc(agent.project_dir || "none")}</td></tr>
          <tr><td>Add-ons</td><td class="small">${
            (agent.addons || []).length ? (agent.addons || []).map(esc).join(", ") : "—"
          }</td></tr>
          <tr><td>Created</td><td class="mono small">${esc(stamp(agent.created_at))}</td></tr>
        </table>`,
        { icon: "settings" }
      )}
    </div>

    ${card(
      "Recently written memories",
      notes.length
        ? `<table class="rows">
            <thead><tr><th>Note</th><th>Size</th><th>Modified</th></tr></thead>
            <tbody>${notes
              .slice(0, 8)
              .map(
                (n) => `<tr>
                <td><a class="mono small" href="/agents/${esc(agent.slug)}/memory/note?path=${encodeURIComponent(
                  n.path
                )}">${esc(n.path)}</a></td>
                <td class="mono small">${bytes(n.bytes)}</td>
                <td class="mono small">${esc(ago(n.modified))}</td>
              </tr>`
              )
              .join("")}</tbody></table>`
        : `<p class="muted">Nothing written yet. The agent creates notes as it works — or
           you can write the first one yourself in the vault.</p>`,
      {
        icon: "memory",
        actions: `<a class="btn small" href="/agents/${esc(agent.slug)}/memory">All notes</a>`,
      }
    )}`,
    {
      user,
      csrf,
      active: "agents",
      heading: agent.name || agent.slug,
      subtitle: `<span class="mono small">${esc(agent.slug)}</span> · ${esc(agent.dir || "")}`,
    }
  );
};

/* --------------------------------------------------------- instructions --- */

exports.instructions = ({ csrf, user, agent, content, flash, err }) =>
  shell(
    "Instructions — " + (agent.name || agent.slug),
    `${tabs(agent.slug, "instructions")}
    ${flashes({ msg: flash, err })}
    ${card(
      "CLAUDE.md",
      `<p class="muted small">Loaded into the system prompt on every single request. The
        right place for who the agent is, what it may do, and how it should behave — and
        the wrong place for anything that changes often. Saving takes effect on the next
        message; no restart needed.</p>
      <form method="post" action="/agents/${esc(agent.slug)}/instructions">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <textarea name="content" rows="30" class="code" spellcheck="false">${esc(content)}</textarea>
        <button class="btn primary" type="submit">${icon("save")} Save instructions</button>
      </form>`,
      { icon: "guide" }
    )}`,
    {
      user,
      csrf,
      active: "agents",
      heading: agent.name || agent.slug,
      subtitle: "Standing instructions.",
    }
  );

/* --------------------------------------------------------------- memory --- */

exports.memory = ({ csrf, user, agent, notes, query, hits, flash, err }) => {
  const mem = agent.memory || {};
  return shell(
    "Memory — " + (agent.name || agent.slug),
    `${tabs(agent.slug, "memory")}
    ${flashes({ msg: flash, err })}

    ${card(
      "Search the vault",
      `<p class="muted small">The same index the agent queries. Vector similarity finds
        paraphrase, keyword matching finds exact tokens, and the two rankings are merged.
        Everything is embedded locally — no text leaves this machine.</p>
      <form method="get" action="/agents/${esc(agent.slug)}/memory" class="searchbar">
        <input name="q" value="${esc(query || "")}" placeholder="what did we decide about deployments?" autofocus>
        <button class="btn primary" type="submit">${icon("search")} Search</button>
      </form>
      ${
        query
          ? hits && hits.length
            ? `<div class="hits">${hits
                .map(
                  (h) => `<div class="hit">
                    <div class="hit-head">
                      <a class="mono small" href="/agents/${esc(agent.slug)}/memory/note?path=${encodeURIComponent(
                    h.path
                  )}">${esc(h.path)}</a>
                      ${h.heading ? `<span class="muted small">› ${esc(h.heading)}</span>` : ""}
                      <span class="muted small right">${esc(h.score.toFixed(4))}</span>
                    </div>
                    <pre class="snippet">${esc(h.text)}</pre>
                  </div>`
                )
                .join("")}</div>`
            : `<p class="muted">Nothing matched. If the vault has notes but search finds
               none, the index may be empty — try Reindex.</p>`
          : ""
      }`,
      { icon: "search" }
    )}

    ${card(
      "Notes",
      notes.length
        ? `<table class="rows">
            <thead><tr><th>Path</th><th>Size</th><th>Modified</th></tr></thead>
            <tbody>${notes
              .map(
                (n) => `<tr>
                <td><a class="mono small" href="/agents/${esc(agent.slug)}/memory/note?path=${encodeURIComponent(
                  n.path
                )}">${esc(n.path)}</a></td>
                <td class="mono small">${bytes(n.bytes)}</td>
                <td class="mono small">${esc(stamp(n.modified))}</td>
              </tr>`
              )
              .join("")}</tbody></table>`
        : `<p class="muted">The vault is empty.</p>`,
      {
        icon: "memory",
        actions: `<span class="muted small">${notes.length} files · ${
          mem.chunks || 0
        } indexed chunks</span>
        <form method="post" action="/agents/${esc(agent.slug)}/memory/reindex" class="inline">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <button class="btn small" type="submit">${icon("reindex")} Reindex</button>
        </form>`,
      }
    )}

    ${card(
      "Open in Obsidian",
      `<p class="muted small">The vault is a plain folder of Markdown, already registered
        in Obsidian on this server's desktop. Reach it over an SSH tunnel to RDP — see the
        <a href="/guide#obsidian">Guide</a>.</p>
      <pre>${esc((agent.dir || "") + "/vault")}</pre>`,
      { icon: "guide" }
    )}`,
    {
      user,
      csrf,
      active: "agents",
      heading: agent.name || agent.slug,
      subtitle: "What this agent remembers.",
    }
  );
};

exports.note = ({ csrf, user, agent, path, content, flash, err }) =>
  shell(
    path,
    `${tabs(agent.slug, "memory")}
    ${flashes({ msg: flash, err })}
    ${card(
      path,
      `<p class="muted small">Edit freely — the agent reads these files and the index
        catches up on its next search. Correcting a wrong memory here is the fastest way to
        fix an agent that keeps repeating a mistake.</p>
      <form method="post" action="/agents/${esc(agent.slug)}/memory/note">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <input type="hidden" name="path" value="${esc(path)}">
        <textarea name="content" rows="26" class="code" spellcheck="false">${esc(content)}</textarea>
        <button class="btn primary" type="submit">${icon("save")} Save note</button>
      </form>`,
      {
        icon: "file",
        actions: `<a class="btn small" href="/agents/${esc(agent.slug)}/memory">${icon(
          "chevron"
        )} Back to notes</a>`,
      }
    )}`,
    {
      user,
      csrf,
      active: "agents",
      heading: agent.name || agent.slug,
      subtitle: `<span class="mono">${esc(path)}</span>`,
    }
  );

/* ----------------------------------------------------------------- logs --- */

exports.logs = ({ csrf, user, agent, lines, err }) =>
  shell(
    "Logs — " + (agent.name || agent.slug),
    `${tabs(agent.slug, "logs")}
    ${flashes({ err })}
    ${card(
      "Last " + lines.length + " journal lines",
      lines.length
        ? `<pre class="logs">${esc(lines.join("\n"))}</pre>`
        : `<p class="muted">Nothing logged yet.</p>`,
      {
        icon: "logs",
        actions: `<a class="btn small" href="/agents/${esc(agent.slug)}/logs">${icon(
          "restart"
        )} Refresh</a>`,
      }
    )}
    <p class="muted small">Secrets are stripped from this view before it reaches the
      browser. Live tail from a shell:
      <code>journalctl -u moni-agent@${esc(agent.slug)} -f</code></p>`,
    {
      user,
      csrf,
      active: "agents",
      heading: agent.name || agent.slug,
      subtitle: "Journal output.",
    }
  );

/* ------------------------------------------------------------- settings --- */

exports.settings = ({ csrf, user, agent, probe, flash, err }) =>
  shell(
    "Settings — " + (agent.name || agent.slug),
    `${tabs(agent.slug, "settings")}
    ${flashes({ msg: flash, err })}

    <form method="post" action="/agents/${esc(agent.slug)}/settings" autocomplete="off">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">

      ${card(
        "Identity",
        `<label>Display name<input name="name" value="${esc(agent.name || "")}" maxlength="64" required></label>
        <p class="muted small">The short name <code>${esc(agent.slug)}</code> is fixed — it
          names the directory and the systemd unit.</p>
        <p class="muted small">The agent's brief lives in
          <a href="/agents/${esc(agent.slug)}/instructions">CLAUDE.md</a>, not here.</p>`,
        { icon: "agents" }
      )}

      ${card(
        "Behaviour",
        `<label>Model
          <select name="model">
            ${MODELS.map(
              ([id, label]) =>
                `<option value="${id}" ${agent.model === id ? "selected" : ""}>${label}</option>`
            ).join("")}
          </select></label>
        ${effortSelect(agent.effort)}
        <label>Verbosity
          <select name="verbose_level">
            <option value="0" ${agent.verbose_level === 0 ? "selected" : ""}>Quiet</option>
            <option value="1" ${agent.verbose_level === 1 ? "selected" : ""}>Normal</option>
            <option value="2" ${agent.verbose_level === 2 ? "selected" : ""}>Detailed</option>
          </select></label>
        <label>Max turns per request<input name="max_turns" type="number" min="1" max="500"
          value="${esc(String(agent.max_turns || 100))}"></label>
        <label>Request timeout (seconds)<input name="timeout_seconds" type="number" min="60" max="7200"
          value="${esc(String(agent.timeout_seconds || 1800))}"></label>
        <label>Project directory<input name="project_dir" value="${esc(agent.project_dir || "")}"
          placeholder="/opt/projects/odoo"></label>`,
        { icon: "settings" }
      )}

      ${card(
        "Add-ons",
        `<p class="muted small">What this agent can do. What it can receive is set on
          <a href="${agent.channel ? "/channels/" + esc(agent.channel.slug) : "/channels"}">its channel</a>.</p>
        ${renderAddons(byScope("agent"), agent.addons || [], probe)}`,
        { icon: "addons" }
      )}

      ${card(
        "",
        `<p class="muted small">Saving rewrites the agent's environment and restarts it if
          it is running. Conversations resume — sessions are on disk, not in memory.</p>
        <button class="btn primary" type="submit">${icon("save")} Save settings</button>`
      )}
    </form>

    ${card(
      "Server operator role",
      agent.server_operator
        ? `<p>This agent <strong>holds</strong> the role. It can propose commands that run as
            root; each one needs the channel administrator's approval and passphrase in chat.</p>
           <div class="btn-row"><a class="btn" href="/operator">${icon(
             "shield"
           )} Manage the role</a></div>`
        : `<p class="muted">This agent does not hold the server operator role, so it cannot
            reach anything outside its own workspace and project directory.</p>
           <p class="muted small">The role is granted on its own page rather than here — only
            one agent on the machine may hold it, so it is a decision about the host, not a
            setting on an agent.</p>
           <div class="btn-row"><a class="btn" href="/operator">${icon(
             "shield"
           )} Server operator</a></div>`,
      { icon: "lock" }
    )}

    ${card(
      "Delete this agent",
      `<p class="muted small">Stops the service and moves the whole agent directory — vault,
        vector index, session history — into <code>/opt/moni-agents/archived/</code>.
        Nothing is erased, but the agent stops answering immediately.</p>
      <form method="post" action="/agents/${esc(agent.slug)}/delete"
            data-confirm="Delete ${esc(agent.slug)}? The service stops and the agent is archived.">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Type the agent's short name to confirm
          <input name="confirm" placeholder="${esc(agent.slug)}" autocomplete="off"></label>
        <button class="btn danger" type="submit">${icon("trash")} Delete agent</button>
      </form>`,
      { icon: "trash", className: "danger-zone" }
    )}`,
    {
      user,
      csrf,
      active: "agents",
      heading: agent.name || agent.slug,
      subtitle: "Configuration.",
    }
  );
