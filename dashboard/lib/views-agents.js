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
const { graphPanel, viewSwitch } = require("./views-memgraph");
const brand = require("./brand");

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
    ["", "overview", "Overview", "overview"],
    ["/instructions", "instructions", "Instructions", "guide"],
    ["/memory", "memory", "Memory", "memory"],
    ["/logs", "logs", "Logs", "logs"],
    ["/settings", "settings", "Settings", "settings"],
  ];
  return `<nav class="tabs" aria-label="Agent sections">${items
    .map(
      ([suffix, key, label, ic]) =>
        `<a href="/agents/${esc(slug)}${suffix}" class="${active === key ? "on" : ""}"${
          active === key ? ' aria-current="page"' : ""
        }>${icon(ic, 14)}${label}</a>`
    )
    .join("")}</nav>`;
}

/** The trail for every page under one agent. */
const agentCrumbs = (agent, here) =>
  [["Agents Dashboard", "/agents/dashboard"], ["Agents", "/agents"], [agent.slug, "/agents/" + agent.slug]].concat(
    here ? [[here, null]] : []
  );

/* ------------------------------------------------------------- seedlings - */

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/**
 * An agent drawn as a seedling. Stem height from the size of its memory,
 * leaf pairs from its notes, one root per channel (a dashed one when it has
 * none). Posture from its state: an active one stands and sways, a failed one
 * droops with red tips, an inactive one is grey and still. Colours are classes,
 * so the theme repaints it.
 */
function seedling(agent) {
  const st = (agent.state && agent.state.active) || "inactive";
  const kind = st === "active" ? "on" : st === "failed" ? "failed" : "off";
  const notes = agent.notes || 0;
  // Grown from the OS leaf: a sprout, then a pair, then a sapling as its
  // memory fills.
  const stage = notes < 10 ? 1 : notes < 60 ? 2 : 3;
  const chans = agent.channel ? [agent.channel] : [];
  return brand.seedling(stage, `seed-art sd-${kind}`, {
    droop: kind === "failed",
    sway: kind === "on",
    roots: chans.map((c, j) => (chans.length === 1 ? 0 : j ? 1 : -1)),
  });
}

function pips(effort) {
  const n = Math.max(1, EFFORT_LEVELS.indexOf(effort || "medium") + 1);
  let out = "";
  for (let k = 0; k < 5; k++) out += `<i class="${k < n ? "on" : ""}"></i>`;
  return `<span class="pips" aria-label="effort ${esc(effort || "medium")}">${out}</span>`;
}

function channelLink(ch) {
  if (!ch) return `<a class="ch-link none" href="/channels/new">${icon("plus")}No channel — add one</a>`;
  const handle = ch.telegram_bot_username ? "@" + ch.telegram_bot_username : ch.type === "whatsapp" ? ch.name : "";
  return `<a class="ch-link" href="/channels/${esc(ch.slug)}">${icon(ch.type === "whatsapp" ? "whatsapp" : "telegram")}${esc(
    ch.type || "channel"
  )}${handle && handle !== ch.type ? ` <small>${esc(handle)}</small>` : ""}</a>`;
}

/** One seedling card: the agent at a glance, with its controls. */
function seedCard(csrf, user, a) {
  const st = (a.state && a.state.active) || "inactive";
  const mem = a.memory || {};
  const canControl = can(user, "agents.control", a.slug);
  return `<article class="card seed ${st === "active" ? "hud " : ""}${esc(st)}">
    <div class="seed-top">${seedling(a)}
      <div class="min0"><a class="seed-name" href="/agents/${esc(a.slug)}">${esc(a.name || a.slug)}</a>
        <div class="seed-slug">${esc(a.slug)}</div></div>
      ${agentPill(st)}</div>
    <div class="seed-ch">${channelLink(a.channel)}</div>
    <div class="seed-meta"><span><b>${a.notes || 0}</b>notes</span><span><b>${(mem.chunks || 0).toLocaleString("en-US")}</b>chunks</span><span><b>${esc(
      ago(mem.last_indexed)
    )}</b>indexed</span></div>
    <div class="seed-model"><span class="mono">${esc(a.model || "—")}</span><span><span class="pips-l">${esc(
      a.effort || "medium"
    )}</span>${pips(a.effort)}</span></div>
    <div class="seed-foot">${canControl ? controls(csrf, a) : "<span></span>"}
      <nav class="seed-links" aria-label="${esc(a.name || a.slug)} sections">
        <a href="/agents/${esc(a.slug)}/instructions" title="Instructions" aria-label="Instructions">${icon("guide")}</a>
        <a href="/agents/${esc(a.slug)}/memory" title="Memory" aria-label="Memory">${icon("memory")}</a>
        <a href="/agents/${esc(a.slug)}/logs" title="Logs" aria-label="Logs">${icon("logs")}</a>
        <a href="/agents/${esc(a.slug)}/settings" title="Settings" aria-label="Settings">${icon("settings")}</a>
      </nav></div>
  </article>`;
}

function fleetGrid(csrf, user, agents) {
  return `<div class="fleet" aria-label="Fleet">${agents.map((a) => seedCard(csrf, user, a)).join("")}${
    can(user, "agents.create")
      ? `<a class="card seed new" href="/agents/new"><span>${brand.seedling(2, "seed-new")}<b>Plant a new agent</b><span class="small">Step 1: the mind · Step 2: its channel</span></span></a>`
      : ""
  }</div>`;
}

const GETS = [
  ["Workspace", "An isolated directory it may read and write. Nothing outside it."],
  ["Memory vault", "CLAUDE.md, MEMORY.md, WORKLOG.md and memory/ — a real Obsidian vault."],
  ["Vector index", "Local embeddings over that vault, which the agent searches itself."],
  ["systemd unit", "Restarts on crash, starts on boot, logs to the journal."],
  ["A channel", "Added separately, so you can change how it is reached without rebuilding it."],
];

function getsCard(open) {
  return `<details class="card gets-d"${open ? " open" : ""}>
    <summary>${icon("info")}<b>What an agent gets</b><span>${GETS.map((g) => g[0]).join(" · ")}</span><em>show</em></summary>
    <div class="gets">${GETS.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join("")}</div>
  </details>`;
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

  const alerts = [];
  if (probe && !probe.claude_credential) {
    alerts.push(["warn", `No Claude credential is set, so agents can receive messages but cannot answer.
      <a href="/credentials">Set one now</a>.`]);
  }
  // systemd reads an EnvironmentFile only at unit start, so an agent that was
  // already running when the credential changed still holds the old one. It
  // looks configured everywhere and fails at the only moment that matters, so
  // it is called out rather than left to be discovered.
  if (probe && (probe.credential_stale_agents || []).length) {
    alerts.push(["warn", `The Claude credential changed after
      ${probe.credential_stale_agents.map(esc).join(", ")} started, so
      ${probe.credential_stale_agents.length === 1 ? "it is" : "they are"} still running with the old one and
      cannot authenticate. Restart from <a href="/services/agents">Agent services</a>.`]);
  }
  if (failed.length) {
    alerts.push(["bad", `${failed.length} agent${failed.length === 1 ? " is" : "s are"} in a failed state:
      ${failed.map((a) => `<a href="/agents/${esc(a.slug)}/logs">${esc(a.name || a.slug)}</a>`).join(", ")} — the logs say why.`]);
  }
  if (noChannel.length) {
    alerts.push(["warn", `${noChannel.length} agent${noChannel.length === 1 ? " has" : "s have"} no channel and
      cannot be reached: ${noChannel.map((a) => `<a href="/agents/${esc(a.slug)}">${esc(a.name || a.slug)}</a>`).join(", ")}.
      <a href="/channels/new">Add a channel</a>.`]);
  }
  const worst = alerts.some((a) => a[0] === "bad") ? "bad" : "warn";

  return shell(
    "Agents Dashboard",
    `${flashes({ msg: flash, err })}
    <div class="stats4">
      ${stat(running.length + " / " + agents.length, "agents running", "agents")}
      ${stat(channels.length, "channels", "channels")}
      ${stat(totalNotes.toLocaleString("en-US"), "memory notes", "memory")}
      ${stat(totalChunks.toLocaleString("en-US"), "indexed chunks", "search")}
    </div>
    ${
      alerts.length
        ? `<div class="alert ${worst}">${icon("alert")}<div>${alerts.map((a) => a[1]).join(" &nbsp;·&nbsp; ")}</div></div>`
        : ""
    }
    ${
      agents.length || can(user, "agents.create")
        ? fleetGrid(csrf, user, agents)
        : card(
            "",
            empty(
              "agents",
              "No agents yet",
              'An agent is a Claude session with its own memory. <a href="/agents/new">Create the first one</a>.'
            )
          )
    }
    ${getsCard(false)}`,
    {
      user,
      csrf,
      active: "agents-dashboard",
      pattern: "a",
      heading: "The nursery",
      subtitle: "Every agent on this machine, and what it can reach. Each is a Claude session with its own memory.",
      actions: `<span class="pill ${running.length ? "ok" : "neutral"}">${running.length} running</span>
        ${can(user, "channels.view") ? `<a class="btn" href="/channels">${icon("channels")} Channels</a>` : ""}
        ${can(user, "agents.create") ? `<a class="btn primary" href="/agents/new">${icon("plus")} New agent</a>` : ""}`,
    }
  );
};

/* ----------------------------------------------------------------- list --- */

exports.list = ({ csrf, user, agents, flash, err }) =>
  shell(
    "Agents",
    `${flashes({ msg: flash, err })}
    ${
      agents.length || can(user, "agents.create")
        ? fleetGrid(csrf, user, agents)
        : card(
            "",
            empty(
              "agents",
              "No agents yet",
              'An agent is one Claude session with its own workspace and memory. <a href="/agents/new">Create the first one</a>.'
            )
          )
    }
    ${getsCard(true)}`,
    {
      user,
      csrf,
      active: "agents",
      pattern: "a",
      heading: "Agents",
      subtitle: "Each agent is one Claude session with its own memory. They cannot see each other.",
      actions: can(user, "agents.create") ? `<a class="btn primary" href="/agents/new">${icon("plus")} New agent</a>` : "",
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
                 pattern="[a-z][a-z0-9\\-]{1,30}" maxlength="31" required></label>
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
      pattern: "c",
      heading: "Create an agent",
      subtitle: "Step 1 of 2 — the mind. The channel it answers on comes next.",
    }
  );
};

/* --------------------------------------------------------------- detail --- */

/** Journal lines as markup: escaped, one span each, warnings and errors tinted. */
const JOURNAL_PREFIX = /^(\d{4}-(\d\d-\d\d)T(\d\d:\d\d:\d\d))\S*\s+\S+\s+[^\s:]+:\s?/;

function journalHtml(lines) {
  return (lines || [])
    .map((raw) => {
      // "2026-09-27T18:36:35+02:00 host unit[pid]: message" -> "09-27 18:36:35 message":
      // the host and unit are the same on every line of an agent's own journal.
      const m = JOURNAL_PREFIX.exec(raw);
      const l = m ? raw.slice(m[0].length) : raw;
      const t = m ? `<span class="t">${esc(m[2] + " " + m[3])}</span> ` : "";
      const cls = /\b(error|failed|traceback|exception|fatal)\b/i.test(l)
        ? " e"
        : /\b(warn|warning|retry|retrying|timeout)\b/i.test(l)
        ? " w"
        : /\b(started|resumed|ready|listening)\b/i.test(l)
        ? " ok"
        : "";
      return `<span class="ln${cls}">${t}${esc(l)}</span>`;
    })
    .join("");
}
exports.journalHtml = journalHtml;

/** The agent's name, face and state: the head of every page under an agent. */
function agentHead(agent) {
  const st = (agent.state && agent.state.active) || "inactive";
  return `${esc(agent.name || agent.slug)} ${agentPill(st)}`;
}

/**
 * One agent, as a HUD (pattern A): its service, channel and configuration on
 * the left, its memory drawn as a seed head in the centre, and its journal
 * tailing live on the right -- the same privileged read, the same permission
 * and the same redaction as the Logs tab.
 */
exports.detail = ({ csrf, user, agent, notes = [], journal = null, journalErr = null, flash, err }) => {
  const mem = agent.memory || {};
  const state = agent.state || {};
  const ch = agent.channel;
  const canLogs = can(user, "agents.logs", agent.slug);
  const canControl = can(user, "agents.control", agent.slug);
  const canMemRead = can(user, "agents.memory.read", agent.slug);
  const canMemWrite = can(user, "agents.memory.write", agent.slug);

  const alerts = [];
  if (!ch) {
    alerts.push(["warn", `No channel is connected, so this agent cannot receive messages and is not running.
      <a href="/channels/new">Add a channel</a>.`]);
  }
  if (state.active === "failed") {
    alerts.push(["bad", `This agent is in a failed state. The <a href="/agents/${esc(agent.slug)}/logs">logs</a> will say
      why — a rejected bot token and a missing Claude credential are the two usual causes.`]);
  }

  return shell(
    agent.name || agent.slug,
    `${tabs(agent.slug, "overview")}
    ${flashes({ msg: flash, err })}
    ${alerts.map((a) => `<div class="alert ${a[0]}">${icon("alert")}<div>${a[1]}</div></div>`).join("")}

    <div class="ad-grid">
      <div class="col">
        <section class="card hud">
          <div class="card-head"><h2>${icon("services")}Service</h2><span class="card-aside mono">moni-agent@${esc(agent.slug)}</span></div>
          <table class="kv">
            <tr><td>State</td><td>${agentPill(state.active)}</td></tr>
            <tr><td>At boot</td><td>${esc(state.enabled || "—")}</td></tr>
            <tr><td>Since</td><td class="mono small">${esc(String(state.since || "").replace(/^[A-Z][a-z]{2} /, "").slice(0, 19) || "—")}</td></tr>
            <tr><td>Unit</td><td class="mono small">moni-agent@${esc(agent.slug)}</td></tr>
          </table>
        </section>
        <section class="card">
          <div class="card-head"><h2>${icon("channels")}Channel</h2>${
            ch ? `<a class="btn small" href="/channels/${esc(ch.slug)}">Open</a>` : ""
          }</div>
          ${
            ch
              ? `<table class="kv">
                  <tr><td>Channel</td><td><a href="/channels/${esc(ch.slug)}">${esc(ch.name)}</a></td></tr>
                  <tr><td>Type</td><td>${esc(ch.type)}</td></tr>
                  ${ch.telegram_bot_username ? `<tr><td>Bot</td><td class="mono small">@${esc(ch.telegram_bot_username)}</td></tr>` : ""}
                  <tr><td>Allowed</td><td class="mono small">${esc(ch.allowed_users || "nobody")}</td></tr>
                </table>
                ${
                  ch.telegram_bot_username
                    ? `<p class="muted small foot-note">Open the chat: <code>https://t.me/${esc(ch.telegram_bot_username)}</code></p>`
                    : ""
                }`
              : `<p class="muted">Not connected.</p>
                 <div class="btn-row"><a class="btn primary small" href="/channels/new">${icon("plus")} Add a channel</a></div>`
          }
        </section>
        <section class="card grow scroll-y">
          <div class="card-head"><h2>${icon("settings")}Configuration</h2>${
            can(user, "agents.edit", agent.slug) ? `<a class="btn small" href="/agents/${esc(agent.slug)}/settings">Edit</a>` : ""
          }</div>
          <table class="kv">
            <tr><td>Model</td><td class="mono small">${esc(agent.model || "—")}</td></tr>
            <tr><td>Thinking effort</td><td>${pips(agent.effort)} ${esc(agent.effort || "medium")}</td></tr>
            <tr><td>Verbosity</td><td>${esc(String(agent.verbose_level))}</td></tr>
            <tr><td>Max turns</td><td>${esc(String(agent.max_turns || "—"))}</td></tr>
            <tr><td>Timeout</td><td>${esc(String(agent.timeout_seconds || "—"))}s</td></tr>
            <tr><td>Project</td><td class="mono small">${esc(agent.project_dir || "none")}</td></tr>
            <tr><td>Add-ons</td><td class="small">${
              (agent.addons || []).length ? (agent.addons || []).map(esc).join(", ") : "—"
            }</td></tr>
            <tr><td>Created</td><td class="mono small">${esc(stamp(agent.created_at))}</td></tr>
          </table>
        </section>
      </div>

      <section class="card hud vault" aria-label="Memory vault">
        <div class="card-head"><h2>${icon("memory")}Memory vault</h2>
          <div class="btn-row">${
            canMemRead ? `<a class="btn small" href="/agents/${esc(agent.slug)}/memory">${icon("search")} Browse</a>` : ""
          }${
            canMemWrite
              ? `<form method="post" action="/agents/${esc(agent.slug)}/memory/reindex" class="inline">
                  <input type="hidden" name="_csrf" value="${esc(csrf)}">
                  <button class="btn small" type="submit">${icon("reindex")} Reindex</button>
                </form>`
              : ""
          }</div></div>
        <div class="vault-art">
          <svg data-vault="${esc(agent.notes || 0)}" viewBox="-160 -160 320 320" aria-hidden="true"></svg>
          <div class="v-center">${brand.osMark({ cls: "mark v-leaf" })}<b>${esc(agent.notes || 0)}</b><span>notes</span></div>
        </div>
        <div>
          <div class="vault-stats">
            <div><b>${esc(agent.notes || 0)}</b><span>md files</span></div>
            <div><b>${(mem.chunks || 0).toLocaleString("en-US")}</b><span>chunks</span></div>
            <div><b>${bytes(mem.bytes || 0)}</b><span>index</span></div>
            <div><b>${esc(ago(mem.last_indexed))}</b><span>indexed</span></div>
          </div>
          <div class="card-head"><h2 class="sub-h">Recently written memories</h2>${
            canMemRead ? `<a class="small" href="/agents/${esc(agent.slug)}/memory">All notes</a>` : ""
          }</div>
          ${
            notes.length
              ? `<ul class="notes">${notes
                  .slice(0, 8)
                  .map(
                    (n) => `<li><a href="/agents/${esc(agent.slug)}/memory/note?path=${encodeURIComponent(n.path)}" title="${esc(
                      n.path
                    )}">${esc(n.path)}</a><span>${bytes(n.bytes)}</span><span>${esc(ago(n.modified))}</span></li>`
                  )
                  .join("")}</ul>`
              : `<p class="muted small">Nothing written yet. The agent creates notes as it works — or you can write
                 the first one yourself in the vault.</p>`
          }
        </div>
      </section>

      <section class="card panel-fill">
        <div class="card-head"><h2>${icon("logs")}Journal · live tail</h2>${
          canLogs ? `<a class="btn small" href="/agents/${esc(agent.slug)}/logs" data-journal-refresh>${icon("restart")} Refresh</a>` : ""
        }</div>
        ${
          canLogs
            ? `<div class="panel-body logbox" data-journal="/api/agents/${esc(agent.slug)}/logs">${
                journalErr ? `<p class="muted small">${esc(journalErr)}</p>` : ""
              }<pre class="logs">${journalHtml(journal || [])}</pre></div>
              <p class="muted small foot-note">Secrets are stripped before this reaches the browser.
                <code>journalctl -u moni-agent@${esc(agent.slug)} -f</code></p>`
            : `<p class="muted small">Your role does not include reading this agent's logs.</p>`
        }
      </section>
    </div>`,
    {
      user,
      csrf,
      active: "agents",
      pattern: "a",
      crumbs: agentCrumbs(agent),
      heading: agent.name || agent.slug,
      headingHtml: agentHead(agent),
      headArt: seedling(agent),
      subtitle: `<span class="mono small">${esc(agent.slug)}</span> · ${esc(agent.dir || "")}`,
      actions: `${canLogs ? `<a class="btn" href="/agents/${esc(agent.slug)}/logs">${icon("logs")} Logs</a>` : ""}${
        canControl ? controls(csrf, agent).replace('class="btn-row"', 'class="btn-row flat"').replace(/ small"/g, '"') : ""
      }`,
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
      pattern: "c",
      crumbs: agentCrumbs(agent, "Instructions"),
      heading: agent.name || agent.slug,
      headingHtml: agentHead(agent),
      headArt: seedling(agent),
      subtitle: "Standing instructions.",
    }
  );

/* --------------------------------------------------------------- memory --- */

exports.memory = ({ csrf, user, agent, agents, notes, query, hits, view, flash, err }) => {
  const mem = agent.memory || {};
  const v = ["graph", "list"].includes(view) ? view : query ? "list" : "graph";
  const peers = (agents && agents.length ? agents : [agent]).filter((a) => can(user, "agents.memory.read", a.slug));
  const base = "/agents/" + agent.slug + "/memory";
  return shell(
    "Memory — " + (agent.name || agent.slug),
    `${tabs(agent.slug, "memory")}
    ${flashes({ msg: flash, err })}
    <div class="mg-page">
    ${graphPanel({
      kind: "agents",
      src: "/api/agents/memory/graph?agent=all",
      search: "/api/agents/memory/search",
      incremental: false,
      poll: 20000,
      groups: [{ key: "", label: "All agents" }].concat(
        peers.map((a) => ({
          key: a.slug,
          label: a.name || a.slug,
          dot: a.state && a.state.active === "active" ? "ok" : a.state && a.state.active === "failed" ? "bad" : "off",
        }))
      ),
      group: agent.slug,
      listHref: base,
      placeholder: "Search… (Enter = by meaning)",
      hidden: v !== "graph",
    })}
    <div data-view-panel="list"${v === "list" ? "" : " hidden"}>
    ${card(
      "Search the vault",
      `<p class="muted small">The same index the agent queries. Vector similarity finds
        paraphrase, keyword matching finds exact tokens, and the two rankings are merged.
        Everything is embedded locally — no text leaves this machine.</p>
      <form method="get" action="/agents/${esc(agent.slug)}/memory" class="searchbar">
        <input type="hidden" name="view" value="list">
        <input name="q" value="${esc(query || "")}" placeholder="what did we decide about deployments?">
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
        actions: `<span class="muted small">${notes.length} files · ${mem.chunks || 0} indexed chunks</span>
        ${
          can(user, "agents.memory.write", agent.slug)
            ? `<form method="post" action="/agents/${esc(agent.slug)}/memory/reindex" class="inline">
                <input type="hidden" name="_csrf" value="${esc(csrf)}">
                <button class="btn small" type="submit">${icon("reindex")} Reindex</button>
              </form>`
            : ""
        }`,
      }
    )}

    ${card(
      "Open in Obsidian",
      `<p class="muted small">The vault is a plain folder of Markdown, already registered
        in Obsidian on this server's desktop. Reach it over an SSH tunnel to RDP — see the
        <a href="/guide#obsidian">Guide</a>.</p>
      <pre>${esc((agent.dir || "") + "/vault")}</pre>`,
      { icon: "guide" }
    )}
    </div>
    </div>`,
    {
      user,
      csrf,
      active: "agents",
      pattern: "a",
      assets: ["memgraph.css", "memgraph.js"],
      crumbs: agentCrumbs(agent, "Memory"),
      heading: agent.name || agent.slug,
      headingHtml: agentHead(agent),
      headArt: seedling(agent),
      subtitle: "What this agent remembers — and how it connects.",
      actions: viewSwitch(v, [
        ["graph", "Graph", "network", base + "?view=graph"],
        ["list", "Notes", "logs", base + "?view=list"],
      ]),
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
      pattern: "c",
      crumbs: agentCrumbs(agent, "Memory").slice(0, -1).concat([["Memory", "/agents/" + agent.slug + "/memory"], [path, null]]),
      heading: agent.name || agent.slug,
      headingHtml: agentHead(agent),
      headArt: seedling(agent),
      subtitle: `<span class="mono">${esc(path)}</span>`,
    }
  );

/* ----------------------------------------------------------------- logs --- */

exports.logs = ({ csrf, user, agent, lines, err }) =>
  shell(
    "Logs — " + (agent.name || agent.slug),
    `${tabs(agent.slug, "logs")}
    ${flashes({ err })}
    <section class="card fill-card grow">
      <div class="card-head"><h2>${icon("logs")}Last ${esc(lines.length)} journal lines</h2>
        <a class="btn small" href="/agents/${esc(agent.slug)}/logs">${icon("restart")} Refresh</a></div>
      ${
        lines.length
          ? `<div class="panel-body logbox" data-scroll-end><pre class="logs">${journalHtml(lines)}</pre></div>`
          : `<p class="muted">Nothing logged yet.</p>`
      }
    </section>
    <p class="muted small">Secrets are stripped from this view before it reaches the
      browser. Live tail from a shell:
      <code>journalctl -u moni-agent@${esc(agent.slug)} -f</code></p>`,
    {
      user,
      csrf,
      active: "agents",
      pattern: "b",
      fill: true,
      crumbs: agentCrumbs(agent, "Logs"),
      heading: agent.name || agent.slug,
      headingHtml: agentHead(agent),
      headArt: seedling(agent),
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
      pattern: "c",
      crumbs: agentCrumbs(agent, "Settings"),
      heading: agent.name || agent.slug,
      headingHtml: agentHead(agent),
      headArt: seedling(agent),
      subtitle: "Configuration.",
    }
  );
