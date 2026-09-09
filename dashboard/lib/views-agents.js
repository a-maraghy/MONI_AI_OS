"use strict";
/** Agent management pages. */

const { esc, bytes, shell, agentPill, flashes, stamp, ago } = require("./ui");

const MODELS = [
  ["claude-opus-5", "Opus 5 — most capable"],
  ["claude-sonnet-5", "Sonnet 5 — faster, cheaper"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5 — fastest"],
];

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
  const running = agent.state && agent.state.active === "active";
  const button = (action, label, cls) => `
    <form method="post" action="/agents/${esc(agent.slug)}/action" class="inline">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <input type="hidden" name="action" value="${action}">
      <button class="btn ${cls} small" type="submit">${label}</button>
    </form>`;
  return `<div class="btn-row">
    ${running ? button("restart", "Restart", "") : button("start", "Start", "primary")}
    ${running ? button("stop", "Stop", "danger") : ""}
    ${
      agent.state && agent.state.enabled === "enabled"
        ? button("disable", "Disable at boot", "")
        : button("enable", "Enable at boot", "")
    }
  </div>`;
}

/* ----------------------------------------------------------------- list --- */

exports.list = ({ csrf, user, agents, flash, err }) => {
  const rows = agents
    .map((a) => {
      const mem = a.memory || {};
      return `<tr>
        <td>
          <a class="strong" href="/agents/${esc(a.slug)}">${esc(a.name || a.slug)}</a>
          <div class="muted small mono">${esc(a.slug)}</div>
        </td>
        <td>${
          a.telegram_bot_username
            ? `<span class="mono small">@${esc(a.telegram_bot_username)}</span>`
            : `<span class="muted small">not set</span>`
        }${a.token_set ? "" : `<div class="tag warn-tag">no token</div>`}</td>
        <td>${agentPill(a.state && a.state.active)}
          ${
            a.state && a.state.enabled !== "enabled"
              ? `<div class="muted small">not enabled at boot</div>`
              : ""
          }</td>
        <td class="mono small">${a.notes || 0} notes · ${mem.chunks || 0} chunks</td>
        <td class="mono small">${esc(a.model || "—")}</td>
        <td class="right">${controls(csrf, a)}</td>
      </tr>`;
    })
    .join("");

  return shell(
    "Agents",
    `<h1>Agents</h1>
    <p class="muted">Each agent is a Telegram bot with its own Claude session, its own
      Obsidian memory vault, and its own vector index. They cannot see each other.</p>
    ${flashes({ msg: flash, err })}

    <div class="card">
      <div class="card-head">
        <h2>Running agents</h2>
        <a class="btn primary small" href="/agents/new">Create agent</a>
      </div>
      ${
        agents.length
          ? `<table class="rows">
              <thead><tr><th>Agent</th><th>Bot</th><th>State</th><th>Memory</th><th>Model</th><th></th></tr></thead>
              <tbody>${rows}</tbody></table>`
          : `<p class="muted">No agents yet. <a href="/agents/new">Create the first one</a> —
             it takes a bot token from <a href="/guide">@BotFather</a> and about a minute.</p>`
      }
    </div>

    <div class="card">
      <h2>What an agent gets</h2>
      <table class="kv">
        <tr><td>Telegram bot</td><td class="muted">Its own bot token, its own chat. One bot, one agent.</td></tr>
        <tr><td>Workspace</td><td class="muted">An isolated directory it may read and write. Nothing outside it.</td></tr>
        <tr><td>Memory vault</td><td class="muted">CLAUDE.md, MEMORY.md, WORKLOG.md and memory/ — a real Obsidian vault.</td></tr>
        <tr><td>Vector index</td><td class="muted">Local embeddings over that vault, searchable by the agent itself.</td></tr>
        <tr><td>systemd unit</td><td class="muted">Restarts on crash, starts on boot, logs to the journal.</td></tr>
      </table>
      <p class="muted">Full walkthrough on the <a href="/guide">Guide</a> page.</p>
    </div>`,
    { user, csrf, active: "agents" }
  );
};

/* ------------------------------------------------------------------ new --- */

exports.create = ({ csrf, user, form = {}, errors = [], botInfo = null }) => {
  const v = (k, d) => esc(form[k] != null && form[k] !== "" ? form[k] : d == null ? "" : d);
  return shell(
    "Create agent",
    `<h1>Create an agent</h1>
    <p class="muted">You need a bot token first. If you have not made one yet, the
      <a href="/guide#bot">Guide</a> walks through @BotFather in four steps — come back
      when you have a line that looks like <code class="mono">8123456789:AA…</code></p>

    ${errors.length ? `<div class="alert bad">${errors.map(esc).join("<br>")}</div>` : ""}
    ${
      botInfo
        ? `<div class="alert good">Token verified — this is
           <strong>@${esc(botInfo.username)}</strong> (${esc(botInfo.name)}).</div>`
        : ""
    }

    <form method="post" action="/agents/new" autocomplete="off">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">

      <div class="card">
        <h2>Identity</h2>
        <label>Display name <span class="hint">what you call it</span>
          <input name="name" value="${v("name")}" placeholder="e.g. Odoo Dev" maxlength="64" required autofocus></label>
        <label>Short name <span class="hint">lowercase, used for the folder and the systemd unit; cannot be changed later</span>
          <input name="slug" value="${v("slug")}" placeholder="odoo-dev" pattern="[a-z][a-z0-9-]{1,30}" maxlength="31" required></label>
        <label>Role <span class="hint">goes into CLAUDE.md — this is the agent's standing brief, so be specific</span>
          <textarea name="role" rows="6" placeholder="You maintain the Odoo 17 instance at /opt/projects/odoo. You handle module changes, migrations and deployment. Ask before restarting the service in working hours.">${v("role")}</textarea></label>
      </div>

      <div class="card">
        <h2>Telegram</h2>
        <label>Bot token <span class="hint">from @BotFather; stored 0600 and never shown again</span>
          <input name="telegram_bot_token" type="password" placeholder="8123456789:AAH..." required></label>
        <label>Bot username <span class="hint">optional — filled in automatically from the token</span>
          <input name="telegram_bot_username" value="${v("telegram_bot_username")}" placeholder="my_odoo_bot" maxlength="32"></label>
        <label>Allowed Telegram user IDs <span class="hint">comma separated. Leave empty and nobody can talk to it.</span>
          <input name="allowed_users" value="${v("allowed_users")}" placeholder="123456789" pattern="[0-9, ]*"></label>
        <p class="muted small">Don't know your ID? Message <code>@userinfobot</code> on Telegram
          and it replies with it. See the <a href="/guide#userid">Guide</a>.</p>
      </div>

      <div class="card">
        <h2>Behaviour</h2>
        <label>Model
          <select name="model">
            ${MODELS.map(
              ([id, label]) =>
                `<option value="${id}" ${form.model === id ? "selected" : ""}>${label}</option>`
            ).join("")}
          </select></label>
        <label>Verbosity <span class="hint">how much of its own work it narrates in chat</span>
          <select name="verbose_level">
            <option value="0" ${form.verbose_level === "0" ? "selected" : ""}>Quiet — final answer only</option>
            <option value="1" ${form.verbose_level !== "0" && form.verbose_level !== "2" ? "selected" : ""}>Normal — tool names as it works</option>
            <option value="2" ${form.verbose_level === "2" ? "selected" : ""}>Detailed — tools with inputs</option>
          </select></label>
        <label>Project directory <span class="hint">optional. Must be under /opt/projects, /srv or /opt/moni-agents/workspaces. Appears inside the vault as <code>project/</code>.</span>
          <input name="project_dir" value="${v("project_dir")}" placeholder="/opt/projects/odoo"></label>
      </div>

      <div class="card">
        <h2>Group topics <span class="muted">(optional)</span></h2>
        <p class="muted">Off by default: the agent talks to you in a private chat. Turn this
          on to run it in a group where each project gets its own topic thread. The group
          must be a forum and the bot must be an admin — see the
          <a href="/guide#topics">Guide</a>.</p>
        <label class="check"><input type="checkbox" name="enable_project_threads" value="1"
          ${form.enable_project_threads ? "checked" : ""}> Route conversations into group topics</label>
        <label>Group chat ID <span class="hint">starts with -100</span>
          <input name="project_threads_chat_id" value="${v("project_threads_chat_id")}" placeholder="-1001234567890" pattern="-?[0-9]*"></label>
      </div>

      <div class="card">
        <p class="muted">On save: the vault is scaffolded, the vector index is created,
          a systemd unit is enabled and the bot starts answering. Roughly ten seconds.</p>
        <button class="btn primary" type="submit">Create agent</button>
        <a class="btn" href="/agents">Cancel</a>
      </div>
    </form>`,
    { user, csrf, active: "agents" }
  );
};

/* --------------------------------------------------------------- detail --- */

exports.detail = ({ csrf, user, agent, notes = [], flash, err }) => {
  const mem = agent.memory || {};
  const state = agent.state || {};
  return shell(
    esc(agent.name || agent.slug),
    `<h1>${esc(agent.name || agent.slug)} ${agentPill(state.active)}</h1>
    <p class="muted mono small">${esc(agent.slug)} · ${esc(agent.dir || "")}</p>
    ${tabs(agent.slug, "overview")}
    ${flashes({ msg: flash, err })}

    ${
      !agent.token_set
        ? `<div class="alert bad">No bot token is stored for this agent, so it cannot
           connect to Telegram. Add one under <a href="/agents/${esc(agent.slug)}/settings">Settings</a>.</div>`
        : ""
    }
    ${
      state.active === "failed"
        ? `<div class="alert bad">This agent is in a failed state. The
           <a href="/agents/${esc(agent.slug)}/logs">logs</a> will say why — a bad token and a
           missing Claude credential are the two usual causes.</div>`
        : ""
    }

    <div class="grid">
      <div class="card">
        <h2>Service</h2>
        <table class="kv">
          <tr><td>State</td><td>${agentPill(state.active)}</td></tr>
          <tr><td>At boot</td><td>${esc(state.enabled || "—")}</td></tr>
          <tr><td>Since</td><td class="mono small">${esc(state.since || "—")}</td></tr>
          <tr><td>Unit</td><td class="mono small">moni-agent@${esc(agent.slug)}</td></tr>
        </table>
        ${controls(csrf, agent)}
      </div>

      <div class="card">
        <h2>Telegram</h2>
        <table class="kv">
          <tr><td>Bot</td><td class="mono small">${
            agent.telegram_bot_username ? "@" + esc(agent.telegram_bot_username) : "—"
          }</td></tr>
          <tr><td>Token</td><td>${
            agent.token_set
              ? `<span class="pill ok">stored</span>`
              : `<span class="pill bad">missing</span>`
          }</td></tr>
          <tr><td>Allowed users</td><td class="mono small">${esc(agent.allowed_users || "nobody")}</td></tr>
          <tr><td>Topics</td><td>${
            agent.enable_project_threads
              ? `on · <span class="mono small">${esc(agent.project_threads_chat_id)}</span>`
              : "off (private chat)"
          }</td></tr>
        </table>
        ${
          agent.telegram_bot_username
            ? `<p class="muted small">Open the chat:
               <code class="mono">https://t.me/${esc(agent.telegram_bot_username)}</code></p>`
            : ""
        }
      </div>

      <div class="card">
        <h2>Memory</h2>
        <table class="kv">
          <tr><td>Notes</td><td>${agent.notes || 0} markdown files</td></tr>
          <tr><td>Indexed</td><td>${mem.files || 0} files · ${mem.chunks || 0} chunks</td></tr>
          <tr><td>Index size</td><td>${bytes(mem.bytes || 0)}</td></tr>
          <tr><td>Last indexed</td><td class="mono small">${esc(ago(mem.last_indexed))}</td></tr>
        </table>
        <div class="btn-row">
          <a class="btn small" href="/agents/${esc(agent.slug)}/memory">Browse &amp; search</a>
          <form method="post" action="/agents/${esc(agent.slug)}/memory/reindex" class="inline">
            <input type="hidden" name="_csrf" value="${esc(csrf)}">
            <button class="btn small" type="submit">Reindex</button>
          </form>
        </div>
      </div>

      <div class="card">
        <h2>Configuration</h2>
        <table class="kv">
          <tr><td>Model</td><td class="mono small">${esc(agent.model || "—")}</td></tr>
          <tr><td>Verbosity</td><td>${esc(String(agent.verbose_level))}</td></tr>
          <tr><td>Max turns</td><td>${esc(String(agent.max_turns || "—"))}</td></tr>
          <tr><td>Timeout</td><td>${esc(String(agent.timeout_seconds || "—"))}s</td></tr>
          <tr><td>Project</td><td class="mono small">${esc(agent.project_dir || "none")}</td></tr>
          <tr><td>Created</td><td class="mono small">${esc(stamp(agent.created_at))}</td></tr>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Recently written memories</h2>
        <a class="btn small" href="/agents/${esc(agent.slug)}/memory">All notes</a>
      </div>
      ${
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
          : `<p class="muted">Nothing written yet. The agent creates notes as it works —
             or you can write the first one yourself in the vault.</p>`
      }
    </div>`,
    { user, csrf, active: "agents" }
  );
};

/* --------------------------------------------------------- instructions --- */

exports.instructions = ({ csrf, user, agent, content, flash, err }) =>
  shell(
    "Instructions — " + esc(agent.name || agent.slug),
    `<h1>${esc(agent.name || agent.slug)} <span class="muted">instructions</span></h1>
    ${tabs(agent.slug, "instructions")}
    ${flashes({ msg: flash, err })}
    <div class="card">
      <p class="muted">This is <code>CLAUDE.md</code> from the agent's vault. It is loaded
        into the system prompt on every single request, so it is the right place for who
        the agent is, what it may do, and how it should behave — and the wrong place for
        anything that changes often. Saving takes effect on the agent's next message; no
        restart needed.</p>
      <form method="post" action="/agents/${esc(agent.slug)}/instructions">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>CLAUDE.md
          <textarea name="content" rows="30" class="mono code" spellcheck="false">${esc(content)}</textarea></label>
        <button class="btn primary" type="submit">Save instructions</button>
      </form>
    </div>`,
    { user, csrf, active: "agents" }
  );

/* --------------------------------------------------------------- memory --- */

exports.memory = ({ csrf, user, agent, notes, query, hits, flash, err }) => {
  const mem = agent.memory || {};
  return shell(
    "Memory — " + esc(agent.name || agent.slug),
    `<h1>${esc(agent.name || agent.slug)} <span class="muted">memory</span></h1>
    ${tabs(agent.slug, "memory")}
    ${flashes({ msg: flash, err })}

    <div class="card">
      <h2>Search the vault</h2>
      <p class="muted">Hybrid search — the same index the agent itself queries. Vector
        similarity finds paraphrase, keyword matching finds exact tokens, and the two
        rankings are merged. Everything is embedded locally; no text leaves this machine.</p>
      <form method="get" action="/agents/${esc(agent.slug)}/memory" class="searchbar">
        <input name="q" value="${esc(query || "")}" placeholder="what did we decide about deployments?" autofocus>
        <button class="btn primary" type="submit">Search</button>
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
                      ${h.heading ? `<span class="muted small"> › ${esc(h.heading)}</span>` : ""}
                      <span class="muted small right">${esc(h.score.toFixed(4))}</span>
                    </div>
                    <pre class="snippet">${esc(h.text)}</pre>
                  </div>`
                )
                .join("")}</div>`
            : `<p class="muted">Nothing matched. If the vault has notes but search finds
               none, the index may be empty — try Reindex.</p>`
          : ""
      }
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Notes <span class="muted">${notes.length} files · ${mem.chunks || 0} indexed chunks</span></h2>
        <form method="post" action="/agents/${esc(agent.slug)}/memory/reindex" class="inline">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <button class="btn small" type="submit">Reindex</button>
        </form>
      </div>
      ${
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
          : `<p class="muted">The vault is empty.</p>`
      }
    </div>

    <div class="card">
      <h2>Open this vault in Obsidian</h2>
      <p class="muted">The vault is a plain folder of Markdown. Open it on the server's
        desktop over RDP — Obsidian is installed there and every agent vault is already
        registered.</p>
      <pre>${esc((agent.dir || "") + "/vault")}</pre>
      <p class="muted small">See the <a href="/guide#obsidian">Guide</a> for the RDP tunnel command.</p>
    </div>`,
    { user, csrf, active: "agents" }
  );
};

exports.note = ({ csrf, user, agent, path, content, flash, err }) =>
  shell(
    esc(path),
    `<h1>${esc(agent.name || agent.slug)} <span class="muted">memory</span></h1>
    ${tabs(agent.slug, "memory")}
    ${flashes({ msg: flash, err })}
    <div class="card">
      <div class="card-head">
        <h2 class="mono">${esc(path)}</h2>
        <a class="btn small" href="/agents/${esc(agent.slug)}/memory">Back to notes</a>
      </div>
      <p class="muted">Edit freely — the agent reads these files, and the index catches up
        on its next search. Correcting a wrong memory here is the fastest way to fix an
        agent that keeps repeating a mistake.</p>
      <form method="post" action="/agents/${esc(agent.slug)}/memory/note">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <input type="hidden" name="path" value="${esc(path)}">
        <textarea name="content" rows="28" class="mono code" spellcheck="false">${esc(content)}</textarea>
        <button class="btn primary" type="submit">Save note</button>
      </form>
    </div>`,
    { user, csrf, active: "agents" }
  );

/* ----------------------------------------------------------------- logs --- */

exports.logs = ({ csrf, user, agent, lines, err }) =>
  shell(
    "Logs — " + esc(agent.name || agent.slug),
    `<h1>${esc(agent.name || agent.slug)} <span class="muted">logs</span></h1>
    ${tabs(agent.slug, "logs")}
    ${flashes({ err })}
    <div class="card">
      <div class="card-head">
        <h2>Last ${lines.length} journal lines</h2>
        <a class="btn small" href="/agents/${esc(agent.slug)}/logs">Refresh</a>
      </div>
      ${
        lines.length
          ? `<pre class="logs">${esc(lines.join("\n"))}</pre>`
          : `<p class="muted">Nothing logged yet.</p>`
      }
      <p class="muted small">Live tail from a shell:
        <code class="mono">journalctl -u moni-agent@${esc(agent.slug)} -f</code></p>
    </div>`,
    { user, csrf, active: "agents" }
  );

/* ------------------------------------------------------------- settings --- */

exports.settings = ({ csrf, user, agent, flash, err }) =>
  shell(
    "Settings — " + esc(agent.name || agent.slug),
    `<h1>${esc(agent.name || agent.slug)} <span class="muted">settings</span></h1>
    ${tabs(agent.slug, "settings")}
    ${flashes({ msg: flash, err })}

    <form method="post" action="/agents/${esc(agent.slug)}/settings" autocomplete="off">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">

      <div class="card">
        <h2>Identity</h2>
        <label>Display name<input name="name" value="${esc(agent.name || "")}" maxlength="64" required></label>
        <p class="muted small">The short name <code class="mono">${esc(agent.slug)}</code>
          is fixed — it names the directory and the systemd unit.</p>
        <p class="muted small">The agent's brief lives in
          <a href="/agents/${esc(agent.slug)}/instructions">CLAUDE.md</a>, not here.</p>
      </div>

      <div class="card">
        <h2>Telegram</h2>
        <label>Replace bot token <span class="hint">leave empty to keep the stored one</span>
          <input name="telegram_bot_token" type="password" placeholder="${
            agent.token_set ? "•••••••• stored" : "no token stored"
          }"></label>
        <label>Bot username<input name="telegram_bot_username" value="${esc(
          agent.telegram_bot_username || ""
        )}" maxlength="32"></label>
        <label>Allowed Telegram user IDs<input name="allowed_users" value="${esc(
          agent.allowed_users || ""
        )}" pattern="[0-9, ]*"></label>
        <label class="check"><input type="checkbox" name="enable_project_threads" value="1"
          ${agent.enable_project_threads ? "checked" : ""}> Route conversations into group topics</label>
        <label>Group chat ID<input name="project_threads_chat_id" value="${esc(
          agent.project_threads_chat_id || ""
        )}" pattern="-?[0-9]*"></label>
      </div>

      <div class="card">
        <h2>Behaviour</h2>
        <label>Model
          <select name="model">
            ${MODELS.map(
              ([id, label]) =>
                `<option value="${id}" ${agent.model === id ? "selected" : ""}>${label}</option>`
            ).join("")}
          </select></label>
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
          placeholder="/opt/projects/odoo"></label>
      </div>

      <div class="card">
        <p class="muted">Saving rewrites the agent's environment and restarts it if it is
          running. In-flight conversations resume — sessions are on disk, not in memory.</p>
        <button class="btn primary" type="submit">Save settings</button>
      </div>
    </form>

    <div class="card danger-zone">
      <h2>Delete this agent</h2>
      <p class="muted">Stops the service and moves the whole agent directory — vault,
        vector index, session history — into <code class="mono">/opt/moni-agents/archived/</code>.
        Nothing is erased, but the bot stops answering immediately. The Telegram bot itself
        still exists; delete it in @BotFather if you are done with it.</p>
      <form method="post" action="/agents/${esc(agent.slug)}/delete"
            data-confirm="Delete ${esc(agent.slug)}? The service stops and the agent is archived.">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Type the agent's short name to confirm
          <input name="confirm" placeholder="${esc(agent.slug)}" autocomplete="off"></label>
        <button class="btn danger" type="submit">Delete agent</button>
      </form>
    </div>`,
    { user, csrf, active: "agents" }
  );
