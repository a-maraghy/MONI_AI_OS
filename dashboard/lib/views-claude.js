"use strict";
/**
 * Claude Code: memory, sessions, and what is running now.
 *
 * Every value on these pages came through the privileged helper, which redacts
 * it, and through priv.js, which redacts it again. The views still escape
 * everything they print: redaction keeps secrets off the page, escaping keeps a
 * transcript that happens to contain markup from becoming markup.
 */

const { esc, bytes, duration, ago, stamp, shell, stat, card, flashes, empty, icon, can } =
  require("./ui");
const { graphPanel, viewSwitch } = require("./views-memgraph");

const KINDS = ["decision", "figure", "trap", "preference", "open_issue", "fact"];

/* ---------------------------------------------------------------- helpers - */

const hidden = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

/** A query string from an object, dropping empty values. */
function qs(params) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    out.set(k, v === true ? "1" : String(v));
  }
  const s = out.toString();
  return s ? "?" + s : "";
}

function pager(base, params, page, pages) {
  if (!pages || pages <= 1) return "";
  const link = (p, label, on) =>
    on
      ? `<a class="btn small" href="${esc(base + qs({ ...params, page: p }))}">${label}</a>`
      : `<span class="btn small" aria-disabled="true">${label}</span>`;
  return `<div class="cc-pager">
    ${link(1, "« First", page > 1)}
    ${link(page - 1, "‹ Prev", page > 1)}
    <span class="muted small">Page ${esc(page)} of ${esc(pages)}</span>
    ${link(page + 1, "Next ›", page < pages)}
    ${link(pages, "Last »", page < pages)}
  </div>`;
}

const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;

function unitPill(u) {
  if (!u || u.load === "not-found") return pill("neutral", "not present");
  const map = { active: "ok", activating: "warn", deactivating: "warn", failed: "bad", inactive: "neutral" };
  return pill(map[u.active] || "neutral", u.active + (u.sub && u.sub !== u.active ? " / " + u.sub : ""));
}

/** Epoch milliseconds (sessions/*.json) or ISO, to ISO. */
function iso(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v).toISOString();
  return String(v);
}

const when = (v) => {
  const t = iso(v);
  return t ? `<span title="${esc(stamp(t))}">${esc(ago(t))}</span>` : "—";
};

function snippet(text, n) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const sessionHref = (home, uuid, extra) =>
  `/claude/sessions/${encodeURIComponent(home)}/${encodeURIComponent(uuid)}${qs(extra)}`;

function tabs(active, user) {
  const items = [
    ["/claude/memory", "memory", "Memory", "claude.memory.read"],
    ["/claude/sessions", "sessions", "Sessions", "claude.sessions.view"],
    ["/claude/running", "running", "Running", "claude.running.view"],
  ].filter((i) => can(user, i[3]));
  return `<nav class="tabs">${items
    .map(([href, key, label]) => `<a href="${href}" class="${active === key ? "on" : ""}">${label}</a>`)
    .join("")}</nav>`;
}

const page = (title, body, { user, csrf, active, subtitle, actions, pattern, fill, crumbs, assets, headingHtml }) =>
  shell(title, body, {
    user,
    csrf,
    active: "claude-" + active,
    heading: title,
    headingHtml,
    subtitle,
    actions,
    wide: true,
    pattern: pattern || "c",
    fill,
    crumbs,
    assets,
  });

const memCrumbs = (here) => [["OS Dashboard", "/"], ["Claude Code", null], ["Memory", "/claude/memory"], [here, null]];

function factStatus(f) {
  if (f.superseded_by == null) return pill("ok", "current");
  if (f.superseded_by === f.id) return pill("bad", "forgotten");
  return pill("neutral", "superseded");
}

/* ----------------------------------------------------------------- memory - */

function memoryStats(stats, err) {
  const db = (stats && stats.db) || null;
  const health = (stats && stats.health) || null;
  if (!db) {
    return `<div class="alert bad">${icon("alert")}<div>The memory database did not answer: ${esc(
      (stats && stats.db_error) || err || "unknown error"
    )}</div></div>`;
  }
  const chunks = db.chunks || {};
  return `<div class="statrow">
    ${stat(db.facts.current, "current facts", "memory")}
    ${stat(db.facts.superseded + db.facts.forgotten, `superseded (${db.facts.forgotten} forgotten)`, "archive")}
    ${stat(chunks.transcript || 0, "transcript chunks", "logs")}
    ${stat((chunks.doc || 0) + (chunks.memory_file || 0), `doc / memory-file chunks`, "file")}
    ${stat(db.sessions_indexed, "sessions indexed", "agents")}
    ${stat(bytes(db.db_bytes), "database size", "cpu")}
  </div>
  <p class="muted small cc-line">
    Search service ${
      health && health.ok
        ? pill("ok", "healthy") + ` <span class="mono">${esc(health.model)}</span> · ${esc(health.dims)} dims`
        : pill("bad", "unreachable") + ` <span class="mono">${esc((stats && stats.health_error) || "")}</span>`
    }
    · last ingest ${when(db.last_ingest)} · last fact extraction ${when(db.last_facts)}
  </p>`;
}

function searchCard(query, project, search, projects, err) {
  const results = search && search.results;
  return card(
    "Search memory",
    `<p class="muted small">The same hybrid search Claude Code's hooks use: vector similarity
      and full-text, fused. Facts rank above transcript chunks.</p>
    <form method="get" action="/claude/memory" class="searchbar">
      <input name="q" value="${esc(query || "")}" placeholder="what did we decide about the purchase plan?" maxlength="500">
      <select name="sproject" class="cc-narrow" aria-label="Project">
        <option value="">All projects</option>
        ${(projects || [])
          .map((p) => `<option value="${esc(p)}"${p === project ? " selected" : ""}>${esc(p)}</option>`)
          .join("")}
      </select>
      <button class="btn primary" type="submit">${icon("search")} Search</button>
    </form>
    ${err ? `<div class="alert bad">${icon("alert")}<div>${esc(err)}</div></div>` : ""}
    ${
      query && results
        ? results.length
          ? `<div class="hits">${results
              .map(
                (h) => `<div class="hit">
                <div class="hit-head">
                  ${pill(h.kind === "fact" ? "ok" : "neutral", h.kind || "?")}
                  ${
                    h.kind === "fact"
                      ? `<a class="mono small" href="/claude/memory/facts/${esc(h.id)}">fact #${esc(h.id)}</a>
                         <span class="mono small muted">${esc(h.topic || "")}</span>`
                      : `<span class="mono small muted">${esc(h.source || "")}${
                          h.role ? " · " + esc(h.role) : ""
                        }${h.project ? " · " + esc(h.project) : ""}</span>`
                  }
                  ${
                    h.session_id
                      ? `<a class="small" href="/claude/memory/session/${esc(h.session_id)}">session ${esc(
                          String(h.session_id).slice(0, 8)
                        )}</a>`
                      : ""
                  }
                  <span class="muted small right">${esc(stamp(h.ts).slice(0, 10))} · ${esc(
                  Number(h.score || 0).toFixed(4)
                )}</span>
                </div>
                <pre class="snippet">${esc(h.content)}${h.truncated ? "…" : ""}</pre>
              </div>`
              )
              .join("")}</div>
            <p class="muted small">${esc(results.length)} results in ${esc(
              Math.round((search.timing_ms && search.timing_ms.total) || search.timing_ms || 0) || "?"
            )} ms.</p>`
          : `<p class="muted">Nothing matched.</p>`
        : ""
    }`,
    { icon: "search" }
  );
}

function factFilters(filters, stats) {
  const db = (stats && stats.db) || {};
  return `<form method="get" action="/claude/memory" class="cc-filters">
    <label>Topic prefix
      <input name="topic" value="${esc(filters.topic || "")}" list="cc-topics" placeholder="odoo.gizaseeds" maxlength="121">
      <datalist id="cc-topics">${(db.topics || []).map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
    </label>
    <label>Project
      <select name="project">
        <option value="">Any</option>
        ${(db.projects || [])
          .map((p) => `<option value="${esc(p)}"${p === filters.project ? " selected" : ""}>${esc(p)}</option>`)
          .join("")}
      </select>
    </label>
    <label>Contains
      <input name="fq" value="${esc(filters.q || "")}" maxlength="200">
    </label>
    <label class="check"><input type="checkbox" name="sup" value="1"${
      filters.superseded ? " checked" : ""
    }> Include superseded</label>
    <button class="btn small" type="submit">Filter</button>
    <a class="btn small" href="/claude/memory">Reset</a>
  </form>`;
}

function factsTable(facts, emptyText) {
  if (!facts || !facts.length) return `<p class="muted">${esc(emptyText || "No facts match.")}</p>`;
  return `<div class="cc-scroll"><table class="rows">
    <thead><tr><th>#</th><th>Topic</th><th>Fact</th><th>Kind</th><th>Project</th><th>When</th><th></th></tr></thead>
    <tbody>${facts
      .map(
        (f) => `<tr>
        <td class="mono small"><a href="/claude/memory/facts/${esc(f.id)}">${esc(f.id)}</a></td>
        <td class="mono small">${esc(f.topic || "—")}</td>
        <td class="small">${esc(snippet(f.content, 220))}</td>
        <td class="small">${esc((f.meta && f.meta.kind) || "—")}</td>
        <td class="small">${esc((f.meta && f.meta.project) || "—")}</td>
        <td class="small nowrap">${when(f.ts)}</td>
        <td>${factStatus(f)}</td>
      </tr>`
      )
      .join("")}</tbody></table></div>`;
}

function addFactForm(csrf, stats) {
  const db = (stats && stats.db) || {};
  return `<details class="mt-12">
    <summary class="btn small">${icon("plus")} Add a fact</summary>
    <form method="post" action="/claude/memory/facts" class="mt-12">
      ${hidden(csrf)}
      <label>Fact <span class="hint">One durable statement. Secrets are redacted before it is stored.</span>
        <textarea name="content" rows="3" maxlength="4000" required></textarea></label>
      <div class="cc-filters">
        <label>Topic <input name="topic" required maxlength="121" list="cc-topics" placeholder="odoo.gizaseeds.planning"></label>
        <label>Kind <select name="kind">${KINDS.map((k) => `<option${k === "fact" ? " selected" : ""}>${k}</option>`).join("")}</select></label>
        <label>Project <select name="project"><option value="">None</option>${(db.projects || [])
          .map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)
          .join("")}</select></label>
      </div>
      <button class="btn primary small" type="submit">${icon("save")} Store fact</button>
    </form>
  </details>`;
}

function memfilesCard(files, err) {
  return card(
    "Auto-memory files",
    err
      ? `<p class="muted">${esc(err)}</p>`
      : files && files.length
      ? `<table class="rows">
          <thead><tr><th>File</th><th>Project</th><th>Size</th><th>Modified</th></tr></thead>
          <tbody>${files
            .map(
              (f) => `<tr>
              <td><a class="mono small" href="/claude/memory/files/${encodeURIComponent(f.project)}/${encodeURIComponent(
                f.name
              )}">${esc(f.name)}</a></td>
              <td class="mono small">${esc(f.project)}</td>
              <td class="mono small">${bytes(f.bytes)}</td>
              <td class="small">${when(f.modified)}</td>
            </tr>`
            )
            .join("")}</tbody></table>
          <p class="muted small">Claude Code's own notes to itself, one folder per project. A save
            re-indexes them into memory in the background.</p>`
      : `<p class="muted">No memory files yet.</p>`,
    { icon: "file" }
  );
}

function hooksCard(hooks, err) {
  const fmt = (d) =>
    Object.entries(d || {})
      .filter(([, v]) => v !== null && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
  return card(
    "Hook activity",
    err
      ? `<p class="muted">${esc(err)}</p>`
      : hooks && hooks.length
      ? `<div class="cc-scroll cc-tall"><table class="rows">
          <thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
          <tbody>${hooks
            .map(
              (h) => `<tr>
              <td class="small nowrap" title="${esc(h.ts)}">${esc(String(h.ts || "").replace("T", " ").slice(5, 19))}</td>
              <td class="small strong">${esc(h.event)}</td>
              <td class="mono small">${esc(fmt(h.detail))}</td>
            </tr>`
            )
            .join("")}</tbody></table></div>
          <p class="muted small">Counts and timings only — the hook log never records content.</p>`
      : `<p class="muted">No hook activity logged yet.</p>`,
    { icon: "activity" }
  );
}

function servicesCard(csrf, user, svc, err) {
  if (!svc) return card("Memory services", `<p class="muted">${esc(err || "Unavailable.")}</p>`, { icon: "services" });
  const writable = can(user, "claude.memory.write");
  const s = svc.service || {};
  const jobs = (svc.jobs && svc.jobs.processes) || [];
  return card(
    "Memory services",
    `<table class="kv">
      <tr><td>claude-memory</td><td>${unitPill(s)} ${
        s.memory != null ? `<span class="muted small">${bytes(s.memory)}</span>` : ""
      } <span class="muted small">since ${esc(s.since || "—")}</span></td></tr>
      <tr><td>Nightly backup</td><td>${esc((svc.backup_timer && svc.backup_timer.active) || "—")} · last run ${esc(
      (svc.backup && svc.backup.exited) || "never"
    )} (${esc((svc.backup && svc.backup.result) || "—")}) · next ${esc(
      (svc.backup_timer && svc.backup_timer.next) || "—"
    )}</td></tr>
      <tr><td>cm-ingest</td><td>${unitPill(svc.ingest)} ${
      svc.ingest && svc.ingest.exited ? `<span class="muted small">last exit ${esc(svc.ingest.exited)}</span>` : ""
    }</td></tr>
      <tr><td>cm-ingest-docs</td><td>${unitPill(svc.ingest_docs)}</td></tr>
      <tr><td>Ingest processes</td><td>${
        jobs.length
          ? jobs
              .map((j) => `<span class="mono small">${esc(j.script)} ${esc((j.flags || []).join(" "))} · pid ${esc(j.pid)} · ${esc(duration(j.uptime))}</span>`)
              .join("<br>")
          : `<span class="muted small">none running</span>`
      }</td></tr>
      <tr><td>Ingest log</td><td class="small">updated ${when(svc.ingest_log && svc.ingest_log.modified)}</td></tr>
    </table>
    ${
      svc.ingest_log && svc.ingest_log.tail && svc.ingest_log.tail.length
        ? `<pre class="cc-log">${esc(svc.ingest_log.tail.join("\n"))}</pre>`
        : ""
    }
    ${
      writable
        ? `<div class="btn-row">
            <form method="post" action="/claude/memory/restart" class="inline"
                  data-confirm="Restart claude-memory? Search and memory hooks pause for a few seconds while the model reloads.">
              ${hidden(csrf)}<button class="btn small" type="submit">${icon("restart")} Restart claude-memory</button>
            </form>
            <form method="post" action="/claude/memory/ingest" class="inline"
                  data-confirm="Re-scan every transcript into memory now? It runs in the background at low priority and skips what is already indexed.">
              ${hidden(csrf)}<button class="btn small" type="submit">${icon("reindex")} Run ingest --all</button>
            </form>
          </div>`
        : ""
    }`,
    { icon: "services" }
  );
}

/**
 * Claude Code > Memory: the long-term memory as a graph (the default), the
 * facts as a list, and the machinery (stats, auto-memory files, hook activity,
 * services) as an overview -- three views of one page, switched in place and
 * remembered in the URL (?view=). A search or a filter from the list lands on
 * the list, so every link and form the page had still goes where it went.
 */
exports.memory = (d) => {
  const { csrf, user, query, searchProject, filters, stats, facts, files, hooks, services, search, errors } = d;
  const view = ["graph", "list", "overview"].includes(d.view) ? d.view : "graph";
  const f = facts || { rows: [], total: 0, page: 1, per_page: 25 };
  const pages = Math.max(1, Math.ceil((f.total || 0) / (f.per_page || 25)));
  const filterParams = {
    topic: filters.topic,
    project: filters.project,
    fq: filters.q,
    sup: filters.superseded,
  };
  const db = (stats && stats.db) || null;
  const projects = (db && db.projects) || [];
  const hide = (v) => (v === view ? "" : " hidden");
  return page(
    "Claude Code memory",
    `${tabs("memory", user)}
    ${flashes({ msg: d.flash, err: d.err })}
    <div class="mg-page">
      ${graphPanel({
        kind: "claude",
        src: "/api/claude/memory/graph",
        search: "/api/claude/memory/search",
        incremental: true,
        poll: 15000,
        groups: [{ key: "", label: "All projects" }].concat(projects.map((p) => ({ key: p, label: p, dot: "ok" }))),
        group: "",
        csrf,
        writable: can(user, "claude.memory.write"),
        factUrl: "/api/claude/memory/fact/",
        listHref: "/claude/memory",
        placeholder: "Search… (Enter = by meaning)",
        hidden: view !== "graph",
      })}
      <div data-view-panel="list"${hide("list")}>
        ${searchCard(query, searchProject, search, projects, errors.search)}
        ${card(
          "Facts",
          `${factFilters(filters, stats)}
          ${errors.facts ? `<div class="alert bad">${icon("alert")}<div>${esc(errors.facts)}</div></div>` : ""}
          <p class="muted small">${esc(f.total)} fact${f.total === 1 ? "" : "s"}, newest first. Editing a fact
            stores a new one that supersedes it, so the history is kept.</p>
          ${factsTable(f.rows)}
          ${pager("/claude/memory", Object.assign({ view: "list" }, filterParams), f.page, pages)}
          ${can(user, "claude.memory.write") ? addFactForm(csrf, stats) : ""}`,
          { icon: "memory" }
        )}
      </div>
      <div data-view-panel="overview"${hide("overview")}>
        ${memoryStats(stats, errors.stats)}
        <div class="grid cols-2">
          ${memfilesCard(files, errors.files)}
          ${hooksCard(hooks, errors.hooks)}
        </div>
        ${servicesCard(csrf, user, services, errors.services)}
      </div>
    </div>`,
    {
      user,
      csrf,
      active: "memory",
      pattern: "a",
      assets: ["memgraph.css", "memgraph.js"],
      subtitle: "What Claude Code remembers across sessions on this machine — and how it connects.",
      actions: viewSwitch(view, [
        ["graph", "Graph", "network", "/claude/memory?view=graph"],
        ["list", "List", "logs", "/claude/memory?view=list"],
        ["overview", "Overview", "activity", "/claude/memory?view=overview"],
      ]),
    }
  );
};

exports.fact = ({ csrf, user, data, flash, err }) => {
  const f = data.fact;
  const current = f.superseded_by == null;
  const writable = can(user, "claude.memory.write") && current;
  const meta = f.meta || {};
  const metaRows = Object.entries(meta)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono small">${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td></tr>`)
    .join("");
  return page(
    "Fact #" + f.id,
    `${tabs("memory", user)}
    ${flashes({ msg: flash, err })}
    ${card(
      f.topic || "Fact",
      `<pre class="snippet cc-fact">${esc(f.content)}</pre>
      <table class="kv mt-12">
        <tr><td>Status</td><td>${factStatus(f)}${
        data.newer
          ? ` replaced by <a href="/claude/memory/facts/${esc(data.newer.id)}">#${esc(data.newer.id)}</a>`
          : ""
      }</td></tr>
        <tr><td>Stored</td><td>${esc(stamp(f.ts))}</td></tr>
        <tr><td>Confidence</td><td>${esc(f.confidence == null ? "—" : f.confidence)}</td></tr>
        <tr><td>Embedded</td><td>${f.embedded ? "yes" : "no — found by full-text only"}</td></tr>
        <tr><td>Source session</td><td>${
          f.source_session
            ? `<a class="mono small" href="/claude/memory/session/${esc(f.source_session)}">${esc(f.source_session)}</a>`
            : "—"
        }</td></tr>
        ${metaRows}
      </table>`,
      {
        icon: "memory",
        actions: `<a class="btn small" href="/claude/memory">${icon("chevron")} Back to memory</a>`,
      }
    )}
    ${
      data.older && data.older.length
        ? card(
            "Earlier versions",
            `<table class="rows"><tbody>${data.older
              .map(
                (o) => `<tr><td class="mono small"><a href="/claude/memory/facts/${esc(o.id)}">#${esc(o.id)}</a></td>
                  <td class="small">${esc(snippet(o.content, 240))}</td><td class="small nowrap">${when(o.ts)}</td></tr>`
              )
              .join("")}</tbody></table>`,
            { icon: "clock" }
          )
        : ""
    }
    ${
      writable
        ? `<div class="grid cols-2">
          ${card(
            "Edit",
            `<p class="muted small">Stores the new wording as a new fact and marks this one superseded
              by it. Nothing is overwritten.</p>
            <form method="post" action="/claude/memory/facts/${esc(f.id)}/edit">
              ${hidden(csrf)}
              <label>Fact <textarea name="content" rows="5" maxlength="4000" required>${esc(f.content)}</textarea></label>
              <div class="cc-filters">
                <label>Topic <input name="topic" value="${esc(f.topic || "")}" required maxlength="121"></label>
                <label>Kind <select name="kind">${KINDS.map(
                  (k) => `<option${k === (meta.kind || "fact") ? " selected" : ""}>${k}</option>`
                ).join("")}</select></label>
              </div>
              <button class="btn primary small" type="submit">${icon("save")} Save as new version</button>
            </form>`,
            { icon: "edit" }
          )}
          ${card(
            "Forget",
            `<p class="muted small">A soft delete: the fact stays in the database, marked forgotten, and
              stops appearing in search and in the facts injected into new sessions.</p>
            <form method="post" action="/claude/memory/facts/${esc(f.id)}/forget"
                  data-confirm="Forget fact #${esc(f.id)}? It will stop being recalled. It is kept in the database and can be seen with 'Include superseded'.">
              ${hidden(csrf)}
              <label>Reason <span class="hint">Required. Recorded with the fact.</span>
                <input name="reason" required maxlength="500" placeholder="out of date since the v19 cutover"></label>
              <button class="btn danger small" type="submit">${icon("trash")} Forget this fact</button>
            </form>`,
            { icon: "ban" }
          )}
        </div>`
        : ""
    }`,
    { user, csrf, active: "memory", pattern: "c", crumbs: memCrumbs("Fact #" + f.id), subtitle: `<span class="mono">${esc(f.topic || "")}</span>` }
  );
};

exports.memfile = ({ csrf, user, file, flash, err }) => {
  const writable = can(user, "claude.memory.write") && !file.redacted;
  return page(
    file.name,
    `${tabs("memory", user)}
    ${flashes({ msg: flash, err })}
    ${
      file.redacted
        ? `<div class="alert warn">${icon("alert")}<div>This file contains something that looks like a
            secret, so it is shown redacted and cannot be saved from here — saving would write the
            placeholders over the real text. Edit it over SSH.</div></div>`
        : ""
    }
    ${card(
      file.project + "/memory/" + file.name,
      `<form method="post" action="/claude/memory/files/${encodeURIComponent(file.project)}/${encodeURIComponent(file.name)}">
        ${hidden(csrf)}
        <textarea name="content" rows="26" class="code" spellcheck="false"${writable ? "" : " readonly"}>${esc(
          file.content
        )}</textarea>
        ${writable ? `<button class="btn primary" type="submit">${icon("save")} Save file</button>` : ""}
      </form>
      <p class="muted small">${bytes(file.bytes)} · modified ${esc(stamp(file.modified))}. Saving re-runs
        <span class="mono">ingest.py --docs</span> in the background.</p>`,
      {
        icon: "file",
        actions: `<a class="btn small" href="/claude/memory">${icon("chevron")} Back to memory</a>`,
      }
    )}`,
    { user, csrf, active: "memory", pattern: "c", crumbs: memCrumbs(file.name), subtitle: `<span class="mono">${esc(file.project)}</span>` }
  );
};

exports.sessionMemory = ({ csrf, user, data, uuid, err }) => {
  const d = data || { chunks: [], facts: [], total_chunks: 0, page: 1, per_page: 40 };
  const pages = Math.max(1, Math.ceil((d.total_chunks || 0) / (d.per_page || 40)));
  return page(
    "Memory for a session",
    `${tabs("memory", user)}
    ${flashes({ err })}
    ${card(
      "Facts from this session",
      factsTable(d.facts, "No facts were extracted from this session."),
      { icon: "memory" }
    )}
    ${card(
      "Indexed chunks",
      d.chunks && d.chunks.length
        ? `<div class="hits">${d.chunks
            .map(
              (c) => `<div class="hit">
              <div class="hit-head">
                ${pill("neutral", c.role || c.source)}
                <span class="mono small muted">turn ${esc(c.turn_index == null ? "—" : c.turn_index)}${
                c.agent_type ? " · subagent " + esc(c.agent_type) : ""
              }</span>
                <span class="muted small right">${esc(stamp(c.ts))} · ${esc(c.chars)} chars</span>
              </div>
              <pre class="snippet">${esc(c.content)}${c.chars > 1500 ? "…" : ""}</pre>
            </div>`
            )
            .join("")}</div>
          ${pager("/claude/memory/session/" + uuid, {}, d.page, pages)}`
        : `<p class="muted">Nothing from this session is in the index.</p>`,
      { icon: "logs" }
    )}`,
    { user, csrf, active: "memory", pattern: "b", crumbs: memCrumbs("Session " + String(uuid).slice(0, 8)), subtitle: `<span class="mono">${esc(uuid)}</span>` }
  );
};

/* --------------------------------------------------------------- sessions - */

function statusPills(r) {
  const out = [];
  if (r.running) out.push(pill("ok", "running"));
  if (r.archived) out.push(pill("neutral", "archived"));
  if (r.released) out.push(pill("warn", "deleted in app"));
  if (r.indexed === true) out.push(pill("brand", "indexed"));
  else if (r.indexed === false && r.chunks) out.push(pill("neutral", "indexed (other copy)"));
  else if (r.indexed === false) out.push(pill("neutral", "not indexed"));
  return out.join(" ");
}

exports.sessions = ({ csrf, user, data, filters, flash, err }) => {
  const d = data || { rows: [], total: 0, page: 1, per_page: 25, homes: [], projects: [] };
  const pages = Math.max(1, Math.ceil((d.total || 0) / (d.per_page || 25)));
  const params = { home: filters.home, project: filters.project, q: filters.q, archived: filters.archived };
  return page(
    "Claude Code sessions",
    `${tabs("sessions", user)}
    ${flashes({ msg: flash, err })}
    ${card(
      filters.archived ? "Archived sessions" : "Sessions",
      `<form method="get" action="/claude/sessions" class="cc-filters">
        <label>Home <select name="home"><option value="">All homes</option>${(d.homes || [])
          .map((h) => `<option value="${esc(h.key)}"${h.key === filters.home ? " selected" : ""}>${esc(h.label)}</option>`)
          .join("")}</select></label>
        <label>Project <select name="project"><option value="">All projects</option>${(d.projects || [])
          .map(
            ([slug, n]) =>
              `<option value="${esc(slug)}"${slug === filters.project ? " selected" : ""}>${esc(
                snippet(slug, 48)
              )} (${esc(n)})</option>`
          )
          .join("")}</select></label>
        <label>Title contains <input name="q" value="${esc(filters.q || "")}" maxlength="200"></label>
        <label class="check"><input type="checkbox" name="archived" value="1"${
          filters.archived ? " checked" : ""
        }> Archived</label>
        <button class="btn small" type="submit">Filter</button>
        <a class="btn small" href="/claude/sessions">Reset</a>
      </form>
      ${
        d.index_available === false
          ? `<p class="muted small">The memory database did not answer, so "indexed" is unknown.</p>`
          : ""
      }
      ${
        d.rows && d.rows.length
          ? `<div class="cc-scroll"><table class="rows">
            <thead><tr><th>Session</th><th>Home</th><th>Project / cwd</th><th>Started</th><th>Last activity</th>
              <th class="right">Size</th><th class="right">Turns</th><th class="right">Subagents</th><th>Status</th></tr></thead>
            <tbody>${d.rows
              .map(
                (r) => `<tr>
                <td class="cc-title-cell">
                  <a class="row-title" href="${esc(sessionHref(r.home, r.uuid, { archived: r.archived }))}">${esc(
                  r.title || "(untitled)"
                )}</a>
                  ${
                    r.first && r.title_src === "custom"
                      ? `<div class="muted small">${esc(snippet(r.first, 110))}</div>`
                      : ""
                  }
                  <div class="muted small mono">${esc(r.uuid)}</div>
                </td>
                <td class="small">${esc(r.home_label)}</td>
                <td class="small"><span class="mono">${esc(snippet(r.project, 40))}</span>
                  ${r.cwd ? `<div class="muted small mono">${esc(snippet(r.cwd, 50))}</div>` : ""}</td>
                <td class="small nowrap">${when(r.started)}</td>
                <td class="small nowrap">${when(r.modified)}</td>
                <td class="mono small right">${bytes(r.bytes)}</td>
                <td class="mono small right">${esc(r.turns == null ? "—" : r.turns)}</td>
                <td class="mono small right">${esc(r.subagents || 0)}</td>
                <td>${statusPills(r)}</td>
              </tr>`
              )
              .join("")}</tbody></table></div>
            ${pager("/claude/sessions", params, d.page, pages)}
            <p class="muted small">${esc(d.total)} session${d.total === 1 ? "" : "s"}. "Deleted in app" means the
              desktop app released it; the transcript is still on disk. The Windows archive is read-only.</p>`
          : empty("logs", "No sessions", filters.archived ? "Nothing has been archived from here." : "No transcripts match.")
      }`,
      { icon: "logs" }
    )}`,
    { user, csrf, active: "sessions", pattern: "b", subtitle: "Every Claude Code transcript on this machine, across its three homes." }
  );
};

function toolRow(t) {
  return `<div class="tool-row">
    <span class="tool-name">${esc(t.name)}</span>
    <span class="tool-arg" title="${esc(t.arg)}">${esc(t.arg)}</span>
    <span class="cc-size${t.error ? " warn-text" : ""}">${
      t.size == null ? "no result" : bytes(t.size)
    }${t.error ? " · error" : ""}</span>
  </div>`;
}

function exchangeHtml(ex, n) {
  const label = { prompt: "", summary: "compaction summary", notification: "notification", preamble: "" }[ex.kind] || "";
  const parts = [];
  let tools = [];
  const flush = () => {
    if (tools.length) parts.push(`<div class="activity-body cc-tools">${tools.map(toolRow).join("")}</div>`);
    tools = [];
  };
  for (const it of ex.items || []) {
    if (it.t === "tool") {
      tools.push(it);
      continue;
    }
    flush();
    if (it.t === "text") {
      parts.push(`<div class="msg assistant"><div class="bubble cc-text">${esc(it.text)}${
        it.truncated ? `<span class="muted"> … (truncated)</span>` : ""
      }</div></div>`);
    } else if (it.t === "note") {
      parts.push(`<div class="msg system"><div class="note">${esc(it.text)}</div></div>`);
    }
  }
  flush();
  return `<div class="cc-ex" id="ex-${esc(n)}">
    <div class="msg-meta cc-ex-meta">#${esc(n)} · ${esc(stamp(ex.ts))}${label ? " · " + esc(label) : ""}${
    ex.model ? " · " + esc(ex.model) : ""
  }${ex.thinking ? " · thought " + esc(ex.thinking) + "×" : ""}</div>
    ${
      ex.kind === "preamble"
        ? ""
        : `<div class="msg user${ex.kind === "summary" ? " cc-summary" : ""}"><div class="bubble">${esc(ex.user)}${
            ex.user_truncated ? " … (truncated)" : ""
          }</div></div>`
    }
    ${parts.join("")}
  </div>`;
}

exports.session = ({ csrf, user, s, flash, err }) => {
  const manage = can(user, "claude.sessions.manage") && s.writable;
  const base = sessionHref(s.home, s.uuid);
  const params = { agent: s.agent, archived: s.archived };
  const first = (s.page - 1) * s.per_page + 1;
  const title = s.title || "(untitled session)";
  return page(
    title,
    `${tabs("sessions", user)}
    ${flashes({ msg: flash, err })}
    <div class="grid cols-2">
      ${card(
        "Session",
        `<table class="kv">
          <tr><td>Home</td><td>${esc(s.home_label)}</td></tr>
          <tr><td>Project</td><td class="mono small">${esc(s.project)}</td></tr>
          <tr><td>Working directory</td><td class="mono small">${esc(s.cwd || "—")}</td></tr>
          <tr><td>Started</td><td>${esc(stamp(s.started))}</td></tr>
          <tr><td>Last activity</td><td>${esc(stamp(s.modified))} (${when(s.modified)})</td></tr>
          <tr><td>Size</td><td>${bytes(s.bytes)} · ${esc(s.turns)} turns · ${esc(s.records)} records</td></tr>
          <tr><td>Model</td><td class="mono small">${esc(s.model || "—")}</td></tr>
          <tr><td>Entrypoint</td><td class="mono small">${esc(s.entrypoint || "—")}</td></tr>
          <tr><td>Status</td><td>${statusPills(s) || "—"}${
          s.live ? ` <a class="small" href="/claude/running">pid ${esc(s.live.pid)} · ${esc(s.live.status || "")}</a>` : ""
        }</td></tr>
          <tr><td>Memory</td><td><a href="/claude/memory/session/${esc(s.uuid)}">Chunks and facts from this session</a></td></tr>
        </table>
        ${
          s.resume
            ? `<p class="muted small mt-12">Resume it from a root shell:</p><pre class="cc-cmd">${esc(s.resume)}</pre>`
            : ""
        }`,
        { icon: "info", actions: `<a class="btn small" href="/claude/sessions">${icon("chevron")} All sessions</a>` }
      )}
      ${card(
        "Manage",
        manage
          ? s.archived
            ? `<p class="muted small">Archived from the panel. Restoring moves it back to its project folder.</p>
              <form method="post" action="${esc(base)}/restore" data-confirm="Restore this session to its project folder?">
                ${hidden(csrf)}<button class="btn primary small" type="submit">${icon("reindex")} Restore</button>
              </form>`
            : `${
                s.running
                  ? `<div class="alert warn">${icon("alert")}<div>This session is running. Rename and archive
                      are refused until it stops.</div></div>`
                  : ""
              }
              <form method="post" action="${esc(base)}/rename" class="row-form">
                ${hidden(csrf)}
                <input name="title" value="${esc(s.title_src === "custom" ? s.title : "")}" maxlength="120"
                       placeholder="New title" required aria-label="New title">
                <button class="btn small" type="submit"${s.running ? " disabled" : ""}>${icon("edit")} Rename</button>
              </form>
              <p class="muted small">Written the way Claude Code writes it: a <span class="mono">custom-title</span>
                record in the transcript and <span class="mono">custom-title.json</span> beside it.</p>
              <form method="post" action="${esc(base)}/archive" class="mt-12"
                    data-confirm="Archive this session? Its transcript moves to .claude/archive/dashboard-archived and disappears from the app's session list. Nothing is deleted and it can be restored.">
                ${hidden(csrf)}<button class="btn danger small" type="submit"${s.running ? " disabled" : ""}>${icon(
                "archive"
              )} Archive</button>
              </form>
              <p class="muted small">Archiving moves files, never deletes them. Memory already indexed from
                this session stays in the memory database.</p>`
          : `<p class="muted small">${
              s.writable ? "Your role can read sessions but not change them." : esc(s.home_label) + " is read-only."
            }</p>`,
        { icon: "settings" }
      )}
    </div>
    ${
      s.subagents && s.subagents.length
        ? card(
            "Subagents",
            `<table class="rows">
              <thead><tr><th>Type</th><th>Description</th><th>Status</th><th class="right">Size</th><th>Last write</th><th></th></tr></thead>
              <tbody>${s.subagents
                .map(
                  (a) => `<tr${a.id === s.agent ? ' class="cc-on"' : ""}>
                  <td class="small strong">${esc(a.type || "agent")}</td>
                  <td class="small">${esc(a.description || "—")}</td>
                  <td>${pill(a.status === "done" ? "ok" : a.status === "running" ? "warn" : "neutral", a.status)}</td>
                  <td class="mono small right">${bytes(a.bytes)}</td>
                  <td class="small nowrap">${when(a.modified)}</td>
                  <td class="right"><a class="btn small" href="${esc(
                    sessionHref(s.home, s.uuid, { agent: a.id, archived: s.archived })
                  )}">Read</a></td>
                </tr>`
                )
                .join("")}</tbody></table>`,
            { icon: "agents" }
          )
        : ""
    }
    ${card(
      s.agent
        ? `Subagent: ${(s.agent_meta && s.agent_meta.description) || s.agent}`
        : "Conversation",
      `${
        s.agent
          ? `<p class="small"><a href="${esc(sessionHref(s.home, s.uuid, { archived: s.archived }))}">${icon(
              "chevron"
            )} Back to the main conversation</a></p>`
          : ""
      }
      <p class="muted small">${esc(s.exchanges_total)} exchanges · showing ${esc(first)}–${esc(
        first + (s.exchanges || []).length - 1
      )}. Tool calls are folded to one line with the size of what they returned; outputs are never shown.</p>
      ${pager(base, params, s.page, s.pages)}
      ${(s.exchanges || []).length ? s.exchanges.map((ex, i) => exchangeHtml(ex, first + i)).join("") : `<p class="muted">Empty transcript.</p>`}
      ${pager(base, params, s.page, s.pages)}`,
      { icon: "logs" }
    )}`,
    {
      user,
      csrf,
      active: "sessions",
      pattern: "b",
      subtitle: `${esc(s.home_label)} · <span class="mono">${esc(s.uuid)}</span>`,
    }
  );
};

/* ---------------------------------------------------------------- running - */

const ENTRY = { "claude-desktop": "desktop", cli: "CLI", "sdk-cli": "SDK", "sdk-py": "SDK", "sdk-ts": "SDK" };

function entryLabel(s) {
  if (s.home === "console") return "console";
  if (s.home === "agents") return "agent";
  return ENTRY[s.entrypoint] || s.entrypoint || "—";
}

function sessionsRows(csrf, user, sessions) {
  if (!sessions.length) return `<tr><td colspan="10" class="muted">No Claude Code sessions are running.</td></tr>`;
  const stopper = can(user, "claude.running.stop");
  return sessions
    .map((s) => {
      const h = s.hints || {};
      const label = s.name || (s.session_id ? String(s.session_id).slice(0, 8) : "pid " + s.pid);
      let control = "";
      if (stopper && s.alive && s.claude) {
        if (s.force_available) {
          control = `<form method="post" action="/claude/running/stop" class="inline"
              data-confirm="Force stop pid ${esc(s.pid)} (${esc(label)})? The interrupt did not end it; this sends SIGTERM.">
              ${hidden(csrf)}<input type="hidden" name="pid" value="${esc(s.pid)}"><input type="hidden" name="force" value="1">
              <button class="btn danger small" type="submit">${icon("stop")} Force stop</button></form>`;
        } else if (s.stop_requested) {
          control = `<span class="muted small">interrupt sent ${when(s.stop_requested * 1000)}</span>`;
        } else {
          control = `<form method="post" action="/claude/running/stop" class="inline"
              data-confirm="Stop Claude Code session '${esc(label)}' (pid ${esc(s.pid)})? This sends an interrupt (SIGINT), like pressing Ctrl-C. Work in progress in that session stops.">
              ${hidden(csrf)}<input type="hidden" name="pid" value="${esc(s.pid)}">
              <button class="btn danger small" type="submit">${icon("stop")} Stop</button></form>`;
        }
      }
      return `<tr>
        <td>${
          s.session_id
            ? `<a class="row-title" href="${esc(sessionHref(s.home, s.session_id))}">${esc(label)}</a>`
            : `<span class="row-title">${esc(label)}</span>`
        }<div class="muted small">${esc(s.home_label)}</div></td>
        <td class="small">${esc(entryLabel(s))}</td>
        <td>${
          s.alive
            ? pill(s.status === "busy" ? "warn" : "ok", s.status || "alive")
            : pill("neutral", "not running")
        }</td>
        <td class="mono small">${esc(h.model || "—")}${
        h.permission_mode ? `<div class="muted small">${esc(h.permission_mode)}</div>` : ""
      }</td>
        <td class="mono small">${esc(snippet(s.cwd || "—", 40))}</td>
        <td class="mono small">${esc(s.pid)}</td>
        <td class="small nowrap">${s.uptime != null ? esc(duration(s.uptime)) : "—"}</td>
        <td class="mono small right">${s.cpu != null ? esc(s.cpu) + "%" : "—"}</td>
        <td class="small nowrap">${when(s.status_updated_at || s.updated_at)}</td>
        <td class="right">${control}</td>
      </tr>`;
    })
    .join("");
}

function subagentRows(list) {
  if (!list.length) return `<tr><td colspan="5" class="muted">No subagent is working right now.</td></tr>`;
  return list
    .map(
      (a) => `<tr>
      <td class="small strong">${esc(a.type || "agent")}</td>
      <td class="small">${esc(a.description || "—")}</td>
      <td class="small"><a href="${esc(sessionHref(a.home, a.session, { agent: a.id }))}">${esc(
        String(a.session).slice(0, 8)
      )}</a></td>
      <td class="mono small right">${bytes(a.bytes)}</td>
      <td class="small nowrap">${when(a.modified)}</td>
    </tr>`
    )
    .join("");
}

function processRows(list, emptyText, withCwd) {
  if (!list.length) return `<tr><td colspan="6" class="muted">${esc(emptyText)}</td></tr>`;
  return list
    .map(
      (p) => `<tr>
      <td class="mono small">${esc(p.binary || p.script || "?")}${
        p.flags && p.flags.length ? " " + esc(p.flags.join(" ")) : ""
      }</td>
      <td class="mono small">${esc(p.pid)}</td>
      <td class="small">${esc(p.user || "—")}</td>
      <td class="mono small">${withCwd ? esc(snippet(p.cwd || "—", 40)) : esc(p.parent || "")}</td>
      <td class="small nowrap">${p.uptime != null ? esc(duration(p.uptime)) : "—"}</td>
      <td class="mono small right">${p.cpu != null ? esc(p.cpu) + "%" : "—"}</td>
    </tr>`
    )
    .join("");
}

function unitRows(units) {
  if (!units.length) return `<tr><td colspan="4" class="muted">No units.</td></tr>`;
  return units
    .map(
      (u) => `<tr>
      <td class="mono small">${esc(u.unit)}</td>
      <td>${unitPill(u)}</td>
      <td class="mono small">${u.memory != null ? bytes(u.memory) : "—"}</td>
      <td class="small">${esc(u.since || u.exited || "—")}</td>
    </tr>`
    )
    .join("");
}

function hookRows(hooks) {
  if (!hooks.length) return `<tr><td colspan="3" class="muted">No subagent hook events logged.</td></tr>`;
  return hooks
    .map(
      (h) => `<tr><td class="small nowrap">${esc(String(h.ts || "").replace("T", " ").slice(5, 19))}</td>
      <td class="small strong">${esc(h.event)}</td>
      <td class="mono small">${esc((h.detail && h.detail.agent_type) || "")}</td></tr>`
    )
    .join("");
}

/** The parts of the Running page that refresh in place, keyed by section. */
function runningSections(csrf, user, r) {
  const sessions = r.sessions || [];
  const alive = sessions.filter((s) => s.alive);
  const jobs = (r.jobs && r.jobs.processes) || [];
  const jobUnits = (r.jobs && r.jobs.units) || [];
  return {
    stats: `${stat(alive.length, "live sessions", "activity")}
      ${stat((r.subagents || []).length, "subagents working", "agents")}
      ${stat((r.others || []).length, "other claude processes", "cpu")}
      ${stat(jobs.length, "memory jobs", "memory")}`,
    sessions: sessionsRows(csrf, user, sessions),
    subagents: subagentRows(r.subagents || []),
    others: processRows(r.others || [], "None — every claude process belongs to a session above.", true),
    jobs:
      processRows(jobs, "No ingest or fact-extraction job is running.", false) +
      jobUnits
        .map((u) => `<tr><td class="mono small">${esc(u.unit)}</td><td colspan="5">${unitPill(u)} <span class="muted small">${esc(u.exited || u.since || "")}</span></td></tr>`)
        .join(""),
    units: unitRows(r.units || []),
    services: processRows(r.services || [], "None.", false),
    hooks: hookRows(r.subagent_hooks || []),
  };
}
exports.runningSections = runningSections;

exports.running = ({ csrf, user, r, flash, err }) => {
  const data = r || {};
  const sec = runningSections(csrf, user, data);
  const table = (key, head) =>
    `<div class="cc-scroll"><table class="rows"><thead><tr>${head
      .map((h) => `<th${h.startsWith(">") ? ' class="right"' : ""}>${esc(h.replace(/^>/, ""))}</th>`)
      .join("")}</tr></thead><tbody data-cc-section="${key}">${sec[key]}</tbody></table></div>`;
  const panel = (title, iconName, inner, cls) =>
    `<section class="card${cls ? " " + cls : ""}"><div class="card-head"><h2>${icon(iconName)}${esc(title)}</h2></div>
      <div class="panel-body">${inner}</div></section>`;
  return page(
    "Running now",
    `${tabs("running", user)}
    ${flashes({ msg: flash, err })}
    <div data-cc-running class="cc-live">
      <div class="stats4" data-cc-section="stats">${sec.stats}</div>
      <p class="muted small cc-line">Updated <span data-cc-updated>${esc(stamp(data.ts))}</span> · refreshes every
        10 seconds while this tab is visible. <a href="/claude/running">Refresh now</a></p>
      <div class="cc-board three">
        ${panel(
          "Claude Code sessions",
          "activity",
          `${table("sessions", ["Session", "Entrypoint", "Status", "Model", "cwd", "pid", "Uptime", ">CPU", "Updated", ""])}
          <p class="muted small">Stop sends an interrupt (SIGINT), the same as Ctrl-C, and only to a pid that
            is both registered in a Claude home's <span class="mono">sessions/</span> folder and running the
            claude binary. If it is still alive ten seconds later, Force stop (SIGTERM) appears.</p>`,
          "hud span2"
        )}
        ${panel("Subagents working", "agents", table("subagents", ["Type", "Description", "Session", ">Size", "Last write"]))}
        ${panel(
          "Other claude processes",
          "cpu",
          `${table("others", ["Binary", "pid", "User", "cwd", "Uptime", ">CPU"])}
          <p class="muted small">Headless runs — fact extraction, agents answering a message — that have no
            sessions entry and so cannot be stopped from here.</p>
          <h3 class="sub-h">Supporting processes</h3>
          ${table("services", ["Process", "pid", "User", "", "Uptime", ">CPU"])}`
        )}
        ${panel("Recent subagent hooks", "clock", table("hooks", ["When", "Event", "Type"]))}
        ${panel(
          "Memory jobs",
          "memory",
          `${table("jobs", ["Job", "pid", "User", "Parent", "Uptime", ">CPU"])}
          <h3 class="sub-h">Agent and memory units</h3>
          ${table("units", ["Unit", "State", "Memory", "Since"])}`
        )}
      </div>
    </div>`,
    { user, csrf, active: "running", pattern: "a", subtitle: "Claude Code processes, subagents and memory jobs on this machine." }
  );
};
