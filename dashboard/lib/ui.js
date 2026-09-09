"use strict";
/**
 * Page chrome: a top bar carrying the two dashboards, and a left sidebar
 * carrying everything you manage.
 *
 * The split is deliberate. The top bar answers "which world am I looking at" --
 * the machine, or the agents running on it -- and there are only ever two
 * answers, so they are tabs rather than a menu. The sidebar answers "what am I
 * working on", which is a longer and growing list, so it is a list.
 *
 * Server-rendered, no client framework, no external assets: the CSP blocks
 * them, and a panel that can grant SSH access is the last place to be pulling
 * scripts off a CDN.
 */

const { icon } = require("./icons");

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bytes(n) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + " " + units[i];
}

function duration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function ago(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}

function stamp(iso) {
  return String(iso || "").replace("T", " ").slice(0, 19) || "—";
}

/* ------------------------------------------------------- navigation model - */

// Which top-bar dashboard a sidebar item belongs to. An item with no dashboard
// shows in both, because things like the guide and sign-out are not about
// either world in particular.
const SIDEBAR = [
  {
    group: "Manage",
    items: [
      { key: "agents", href: "/agents", label: "Agents", icon: "agents", dash: "agents" },
      { key: "channels", href: "/channels", label: "Channels", icon: "channels", dash: "agents" },
      { key: "addons", href: "/addons", label: "Add-ons", icon: "addons", dash: "agents" },
      { key: "agent-services", href: "/services/agents", label: "Agent services", icon: "services", dash: "agents" },
    ],
  },
  {
    group: "System",
    items: [
      { key: "services", href: "/services", label: "Services", icon: "services", dash: "os" },
      { key: "credentials", href: "/credentials", label: "Credentials", icon: "credentials", dash: "os" },
      { key: "keys", href: "/keys", label: "SSH keys", icon: "keys", dash: "os" },
      { key: "devices", href: "/devices", label: "Devices", icon: "devices", dash: "os" },
      { key: "audit", href: "/audit", label: "Audit log", icon: "audit", dash: "os" },
    ],
  },
  {
    group: "Help",
    items: [{ key: "guide", href: "/guide", label: "Guide", icon: "guide" }],
  },
];

const DASHBOARDS = [
  { key: "os", href: "/", label: "OS Dashboard", icon: "cpu" },
  { key: "agents", href: "/agents/dashboard", label: "Agents Dashboard", icon: "agents" },
];

/** Which top-bar tab should look active, given the current sidebar key. */
function dashboardFor(active) {
  if (active === "os" || active === "home") return "os";
  if (active === "agents-dashboard") return "agents";
  for (const group of SIDEBAR) {
    for (const item of group.items) {
      if (item.key === active) return item.dash || null;
    }
  }
  return null;
}

function renderSidebar(active, dash) {
  return SIDEBAR.map((group) => {
    // Show items for the current dashboard plus the dashboard-agnostic ones.
    const items = group.items.filter((i) => !i.dash || !dash || i.dash === dash);
    if (!items.length) return "";
    return `<div class="side-group">
      <div class="side-label">${esc(group.group)}</div>
      ${items
        .map(
          (i) =>
            `<a href="${i.href}" class="side-item${active === i.key ? " on" : ""}">
               ${icon(i.icon)}<span>${esc(i.label)}</span>
             </a>`
        )
        .join("")}
    </div>`;
  }).join("");
}

/**
 * @param title   browser title
 * @param body    page markup
 * @param opts    { user, csrf, active, subtitle, actions, wide }
 */
function shell(title, body, opts = {}) {
  if (!opts.user) {
    // Signed out: no chrome at all, just the card. Showing navigation you
    // cannot use is noise on the one screen that has to be unambiguous.
    return page(title, `<main class="auth-wrap">${body}</main>`);
  }

  const dash = dashboardFor(opts.active);

  const tabs = DASHBOARDS.map(
    (d) =>
      `<a href="${d.href}" class="top-tab${dash === d.key ? " on" : ""}">
         ${icon(d.icon, 17)}<span>${esc(d.label)}</span>
       </a>`
  ).join("");

  return page(
    title,
    `<header class="topbar">
      <a class="brand" href="/">
        <span class="brand-mark">${icon("overview", 20)}</span>
        <span class="brand-text">MONI<em>AI OS</em></span>
      </a>
      <nav class="top-tabs">${tabs}</nav>
      <div class="top-right">
        ${
          opts.statusChip
            ? `<span class="chip">${opts.statusChip}</span>`
            : ""
        }
        <form method="post" action="/logout" class="logout">
          <input type="hidden" name="_csrf" value="${esc(opts.csrf)}">
          <button type="submit" title="Sign out">${icon("power")}<span>${esc(
      opts.user
    )}</span></button>
        </form>
      </div>
    </header>

    <div class="layout">
      <aside class="sidebar">${renderSidebar(opts.active, dash)}</aside>
      <main class="content${opts.wide ? " wide" : ""}">
        ${
          title
            ? `<div class="page-head">
                 <div>
                   <h1>${esc(opts.heading || title)}</h1>
                   ${opts.subtitle ? `<p class="sub">${opts.subtitle}</p>` : ""}
                 </div>
                 ${opts.actions ? `<div class="page-actions">${opts.actions}</div>` : ""}
               </div>`
            : ""
        }
        ${body}
      </main>
    </div>`
  );
}

function page(title, inner) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — MONI AI OS</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head><body>
${inner}
</body></html>`;
}

/* ------------------------------------------------------------ components - */

function statusPill(state) {
  const good = state === "active";
  return `<span class="pill ${good ? "ok" : "bad"}">${esc(state)}</span>`;
}

function agentPill(state) {
  const map = {
    active: "ok",
    activating: "warn",
    deactivating: "warn",
    failed: "bad",
    inactive: "neutral",
  };
  return `<span class="pill ${map[state] || "neutral"}">${esc(state || "unknown")}</span>`;
}

function meter(name, label, used, total) {
  const pct = total ? Math.round((used / total) * 100) : 0;
  const level = pct > 90 ? "bad" : pct > 75 ? "warn" : "ok";
  return `<div class="meter" data-meter="${esc(name)}">
    <div class="meter-head"><span>${esc(label)}</span>
      <span class="muted">${bytes(used)} / ${bytes(total)}</span></div>
    <div class="bar"><div class="fill ${level}" style="width:${pct}%"></div></div>
  </div>`;
}

function stat(value, label, iconName) {
  return `<div class="statbox">
    ${iconName ? `<span class="statbox-ico">${icon(iconName, 20)}</span>` : ""}
    <span class="statbox-value">${esc(String(value))}</span>
    <span class="statbox-label">${esc(label)}</span>
  </div>`;
}

function card(title, body, opts = {}) {
  return `<section class="card${opts.className ? " " + opts.className : ""}">
    ${
      title
        ? `<div class="card-head"><h2>${
            opts.icon ? icon(opts.icon) : ""
          }${esc(title)}</h2>${opts.actions || ""}</div>`
        : ""
    }
    ${body}
  </section>`;
}

function flashes({ msg, err }) {
  let out = "";
  if (msg) out += `<div class="alert good">${icon("check")}<div>${esc(msg)}</div></div>`;
  if (err) out += `<div class="alert bad">${icon("alert")}<div>${esc(err)}</div></div>`;
  return out;
}

function empty(iconName, title, body) {
  return `<div class="empty">
    <span class="empty-ico">${icon(iconName, 28)}</span>
    <p class="empty-title">${esc(title)}</p>
    <p class="muted">${body}</p>
  </div>`;
}

module.exports = {
  esc,
  bytes,
  duration,
  ago,
  stamp,
  shell,
  page,
  statusPill,
  agentPill,
  meter,
  stat,
  card,
  flashes,
  empty,
  icon,
  SIDEBAR,
  DASHBOARDS,
};
