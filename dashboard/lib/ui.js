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

const fs = require("fs");
const path = require("path");
const { icon } = require("./icons");
const { landing } = require("./rbac");
const brand = require("./brand");

/**
 * Cache-busting stamps for the static files.
 *
 * /static is served with a long cache, which is right for bytes that do not
 * change and wrong for bytes that just did: a deployed stylesheet could take an
 * hour to reach a browser that already had the old one, so a fix looked like it
 * had not shipped. The stamp changes when the file does, which makes the URL
 * change, which is the only thing a cache reliably notices.
 *
 * Read once at startup. These files are only replaced by a deploy, and a deploy
 * restarts the process.
 */
const ASSET_VERSIONS = new Map();

function asset(file) {
  if (!ASSET_VERSIONS.has(file)) {
    let stamp = "0";
    try {
      const { mtimeMs, size } = fs.statSync(path.join(__dirname, "..", "public", file));
      stamp = Math.round(mtimeMs).toString(36) + "-" + size.toString(36);
    } catch (_) {
      /* a missing file is the static handler's problem to report, not ours */
    }
    ASSET_VERSIONS.set(file, stamp);
  }
  return "/static/" + file + "?v=" + ASSET_VERSIONS.get(file);
}

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

/**
 * The two dashboards, each owning its own sidebar.
 *
 * The top bar answers "which world am I in" -- the machine, or the agents
 * running on it -- and the sidebar shows only that world's actions. An earlier
 * version listed everything on both, which meant the OS view carried five items
 * that had nothing to do with the OS and the two views were indistinguishable
 * at a glance. Two clean contexts beat one crowded one.
 *
 * Each sidebar is three levels: the dashboard's own landing item, then
 * categories, then sections inside them. Every item names the permission that
 * reveals it, and empty sections and categories collapse away, so a viewer's
 * sidebar is genuinely short rather than mostly dead links.
 */
const NAV = [
  {
    // The main point of contact, so it sits first in the bar. It opens the
    // MINT AI Command Center; the older console chat stays at /console. Both
    // carry their own navigation inside the page, which is why this asks for
    // no sidebar -- two lists side by side would be one too many.
    key: "console",
    href: "/mint-ai",
    label: "MINT AI",
    icon: "core",
    noSidebar: true,
    home: { key: "console", href: "/console", label: "Chat", icon: "agents" },
    categories: [],
  },
  {
    key: "os",
    href: "/os",
    label: "OS Dashboard",
    icon: "cpu",
    home: { key: "os", href: "/os", label: "Dashboard", icon: "overview", perm: "os.view" },
    categories: [
      {
        label: "Manage",
        sections: [
          {
            label: "Access",
            items: [
              { key: "users", href: "/users", label: "Users", icon: "users", perm: "users.view" },
              { key: "roles", href: "/roles", label: "Roles", icon: "shield", perm: "roles.view" },
            ],
          },
          {
            label: "Security",
            items: [
              { key: "firewall", href: "/firewall", label: "Firewall", icon: "ban", perm: "firewall.view" },
              { key: "credentials", href: "/credentials", label: "Credentials", icon: "credentials", perm: "credentials.view" },
              { key: "keys", href: "/keys", label: "SSH keys", icon: "keys", perm: "keys.view" },
              { key: "devices", href: "/devices", label: "Devices", icon: "devices", perm: "devices.view" },
            ],
          },
          {
            label: "Platform",
            items: [
              { key: "services", href: "/services", label: "Services", icon: "services", perm: "services.view" },
              { key: "audit", href: "/audit", label: "Audit log", icon: "audit", perm: "audit.view" },
            ],
          },
        ],
      },
      {
        // Claude Code's own state on this machine: what it remembers, what it
        // said, and what is running now. Administrator-only by default.
        label: "Claude Code",
        sections: [
          {
            items: [
              { key: "claude-memory", href: "/claude/memory", label: "Memory", icon: "memory", perm: "claude.memory.read" },
              { key: "claude-sessions", href: "/claude/sessions", label: "Sessions", icon: "logs", perm: "claude.sessions.view" },
              { key: "claude-running", href: "/claude/running", label: "Running", icon: "activity", perm: "claude.running.view" },
            ],
          },
        ],
      },
      {
        label: "Help",
        sections: [
          { items: [{ key: "guide", href: "/guide", label: "Guide", icon: "guide" }] },
        ],
      },
    ],
  },
  {
    key: "agents",
    href: "/agents/dashboard",
    label: "Agents Dashboard",
    icon: "agents",
    home: {
      key: "agents-dashboard",
      href: "/agents/dashboard",
      label: "Dashboard",
      icon: "overview",
      perm: "agents.view",
    },
    categories: [
      {
        label: "Manage",
        sections: [
          {
            label: "Fleet",
            items: [
              { key: "agents", href: "/agents", label: "Agents", icon: "agents", perm: "agents.view" },
              { key: "channels", href: "/channels", label: "Channels", icon: "channels", perm: "channels.view" },
            ],
          },
          {
            label: "Capabilities",
            items: [
              { key: "addons", href: "/addons", label: "Add-ons", icon: "addons", perm: "addons.view" },
              { key: "agent-services", href: "/services/agents", label: "Agent services", icon: "services", perm: "agents.view" },
            ],
          },
        ],
      },
      {
        label: "Help",
        sections: [
          { items: [{ key: "guide", href: "/guide", label: "Guide", icon: "guide" }] },
        ],
      },
    ],
  },
];

const DASHBOARDS = NAV.map((d) => ({ key: d.key, href: d.href, label: d.label, icon: d.icon }));

/** Every item on a dashboard, flattened -- used to resolve the active tab. */
function itemsOf(dash) {
  const out = dash.home ? [{ ...dash.home, dash: dash.key }] : [];
  for (const cat of dash.categories) {
    for (const sec of cat.sections) {
      for (const item of sec.items) out.push({ ...item, dash: dash.key });
    }
  }
  return out;
}

/**
 * Which top-bar tab should look active. The guide appears on both dashboards,
 * so it resolves to whichever one the visitor came from -- passed in as
 * `opts.dash` -- rather than always snapping to the OS tab.
 */
function dashboardFor(active, hint) {
  for (const dash of NAV) {
    if (itemsOf(dash).some((i) => i.key === active)) {
      // A shared item (the guide) defers to the hint.
      const shared = NAV.filter((d) => itemsOf(d).some((i) => i.key === active)).length > 1;
      if (shared && hint) return hint;
      return dash.key;
    }
  }
  return hint || null;
}

/** Where an item sits: [dashboard, category, section, item], for the crumbs. */
function locate(active, dashKey) {
  const dash = NAV.find((d) => d.key === dashKey);
  if (!dash) return null;
  if (dash.home && dash.home.key === active) return { dash, item: dash.home };
  for (const cat of dash.categories) {
    for (const sec of cat.sections) {
      const item = sec.items.find((i) => i.key === active);
      if (item) return { dash, cat, sec, item };
    }
  }
  return { dash };
}

/**
 * The trail above a page title: dashboard / section / page. Pages deeper than
 * the navigation (an agent, a fact) pass their own trail as opts.crumbs, a list
 * of [label, href] pairs; the last is where you are and is not a link.
 */
function renderCrumbs(active, dashKey, crumbs) {
  let trail = crumbs;
  if (!trail) {
    const at = locate(active, dashKey);
    if (!at) return "";
    trail = [[at.dash.label, at.dash.href]];
    if (at.sec && at.sec.label) trail.push([at.sec.label, null]);
    else if (at.cat) trail.push([at.cat.label, null]);
    if (at.item && at.item !== at.dash.home) trail.push([at.item.label, at.item.href]);
    else if (at.item) trail.push(["Overview", null]);
  }
  return `<nav class="crumbs" aria-label="Breadcrumb">${trail
    .map(([label, href], i) =>
      (i ? `<span aria-hidden="true">/</span>` : "") +
      (href && i < trail.length - 1 ? `<a href="${esc(href)}">${esc(label)}</a>` : `<span>${esc(label)}</span>`)
    )
    .join("")}</nav>`;
}

function renderSidebar(active, dashKey, perm, chrome) {
  const dash = NAV.find((d) => d.key === dashKey) || NAV[0];
  const allow = (item) => !item.perm || !perm || perm.can(item.perm);
  const badges = (chrome && chrome.badges) || {};

  const link = (i) => {
    const b = badges[i.key];
    return `<a href="${i.href}" class="side-item${active === i.key ? " on" : ""}"${
      active === i.key ? ' aria-current="page"' : ""
    } title="${esc(i.label)}">${icon(i.icon)}<span>${esc(i.label)}</span>${
      b ? `<span class="badge ${esc(b[1])}" data-badge="${esc(i.key)}">${esc(b[0])}</span>` : ""
    }</a>`;
  };

  const home = dash.home && allow(dash.home) ? `<div class="side-home">${link(dash.home)}</div>` : "";

  const categories = dash.categories
    .map((cat) => {
      const sections = cat.sections
        .map((sec) => {
          const items = sec.items.filter(allow);
          if (!items.length) return "";
          return `<div class="side-section">
            ${sec.label ? `<div class="side-sublabel">${esc(sec.label)}</div>` : ""}
            ${items.map(link).join("")}
          </div>`;
        })
        .filter(Boolean)
        .join("");
      if (!sections) return "";
      return `<div class="side-group">
        <div class="side-label">${esc(cat.label)}</div>
        ${sections}
      </div>`;
    })
    .filter(Boolean)
    .join("");

  const id = (chrome && chrome.ids && chrome.ids[dash.key]) || null;
  const idBlock = id
    ? `<div class="side-id"><span class="side-id-mark">${dash.key === "agents" ? brand.seedling(3) : brand.osMark()}</span>
        <div><b>${esc(id.name)}</b><small>${esc(id.sub)}</small></div></div>`
    : "";

  return `<div class="side-scroll">${idBlock}<nav aria-label="Section navigation">${home + categories}</nav></div>
    <div class="side-foot">
      <button class="side-collapse" type="button" data-side-collapse aria-expanded="true" title="Collapse the sidebar to icons">${icon(
        "sidebar",
        16
      )}<span>Collapse to icons</span></button>
    </div>`;
}

/** The health chip: one line saying whether anything needs you. */
function healthChip(chrome) {
  const h = chrome && chrome.health;
  if (!h) return "";
  return `<a class="sys-chip ${esc(h.cls)}" href="${esc(h.href)}" data-health title="${esc(h.text)}">
    <span class="dot${h.cls === "ok" ? "" : " " + esc(h.cls)}"></span><span class="long">${esc(h.text)}</span><span class="short">${esc(h.short)}</span></a>`;
}

/**
 * Wall clock in the administrator's zone -- the same one the Command Center
 * keeps (Africa/Cairo), so the two never disagree about the time. os.js ticks
 * it; the server's own time stands in until then.
 */
const CLOCK_TZ = "Africa/Cairo";
function clock() {
  let hms = "";
  try {
    hms = new Intl.DateTimeFormat("en-GB", { timeZone: CLOCK_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  } catch (_) {
    hms = new Date().toTimeString().slice(0, 8);
  }
  return `<div class="clock" data-clock data-tz="${CLOCK_TZ}" aria-hidden="true"><b>${hms}</b><span>${esc(CLOCK_TZ.split("/").pop())}</span></div>`;
}

/**
 * @param title   browser title
 * @param body    page markup
 * @param opts    { user, csrf, active, subtitle, actions, wide, perm, dash,
 *                  pageClass, topExtra, topEnd, assets, pattern, crumbs,
 *                  heading, headClass }
 *
 * `pattern` is how the page uses the screen: "a" one screen (nothing but
 * inner panels scrolls), "b" a fixed frame whose body panel scrolls, "c" a
 * document whose column scrolls under the frame (the default).
 * `topExtra` and `topEnd` are markup the caller has already escaped, placed
 * before and after the theme switch. `assets` are extra files from public/ --
 * .css as stylesheets, .js as deferred scripts.
 */
function shell(title, body, opts = {}) {
  // `user` is the viewer context: routes pass the object built by ctx(), but a
  // bare username string still works, which keeps the signed-out and setup
  // pages -- the only callers that have no actor -- unchanged.
  const who = typeof opts.user === "string" ? { name: opts.user } : opts.user || null;

  if (!who || !who.name) {
    // Signed out: no chrome at all, just the card. Showing navigation you
    // cannot use is noise on the one screen that has to be unambiguous.
    // The full lockup heads the card, and a large faint leaf sits behind it.
    const kind = opts.brand === "ai" ? "ai" : "os";
    const head = `<div class="auth-lockup">${brand.lockup(kind, { sub: true })}</div>`;
    const inner = /^\s*<div class="card">/.test(body) ? body.replace(/<div class="card">/, `<div class="card auth-card">${head}`) : head + body;
    return page(title, `<main class="auth-wrap">${brand.watermark(kind)}${inner}</main>`, opts);
  }

  const perm = who.perm || opts.perm || null;
  const chrome = who.chrome || null;
  const dash = dashboardFor(opts.active, who.dash || opts.dash) || "os";
  // A dashboard that carries its own navigation inside the page gets the full
  // width instead of a sidebar it would only duplicate.
  const bare = !!(NAV.find((d) => d.key === dash) || {}).noSidebar;
  // MINT AI's own world (the Command Center, its chat) wears the AI brand.
  opts = Object.assign({}, opts, { brand: opts.brand || (dash === "console" ? "ai" : "os") });
  const pattern = bare ? null : ["a", "b", "c"].includes(opts.pattern) ? opts.pattern : "c";

  // A dashboard the actor cannot reach at all is hidden rather than shown as a
  // link into a permission error.
  const tabs = DASHBOARDS.filter((d) => !perm || perm.canDash(d.key))
    .map(
      (d) =>
        `<a href="${d.href}" class="top-tab${d.key === "console" ? " ai" : ""}${dash === d.key ? " on" : ""}"${dash === d.key ? ' aria-current="page"' : ""}>
         ${d.key === "console" ? brand.spark(16) : icon(d.icon, 17)}<span>${esc(d.label)}</span>
       </a>`
    )
    .join("");

  const actions = [
    opts.statusChip ? `<span class="pill nodot mono">${opts.statusChip}</span>` : "",
    opts.actions || "",
  ].join("");

  const head =
    !bare && opts.heading !== null
      ? `<div class="page-head${opts.headClass ? " " + esc(opts.headClass) : ""}${opts.headArt ? " with-art" : ""}">
           ${opts.headArt ? `<div class="head-art">${opts.headArt}</div>` : ""}
           <div class="head-text">
             ${renderCrumbs(opts.active, dash, opts.crumbs)}
             <h1>${opts.headingHtml || esc(opts.heading || title)}</h1>
             ${opts.subtitle ? `<p class="sub">${opts.subtitle}</p>` : ""}
           </div>
           ${actions ? `<div class="page-actions">${actions}</div>` : ""}
         </div>`
      : "";

  const pageClass = [bare ? "" : "framed", opts.pageClass || ""].filter(Boolean).join(" ");

  return page(
    title,
    `<header class="topbar">
      ${
        bare
          ? ""
          : `<button class="nav-toggle" type="button" aria-label="Menu"
                     aria-expanded="false" aria-controls="sidebar"
                     data-nav-toggle>${icon("menu", 20)}</button>`
      }
      <a class="brand" href="${perm ? landing(perm) : "/"}" aria-label="${opts.brand === "ai" ? "MINT AI" : "Mint OS"} home">
        ${brand.lockup(opts.brand === "ai" ? "ai" : "os", { cls: "brand-text" })}
      </a>
      <nav class="top-tabs" aria-label="Dashboards">${tabs}</nav>
      <div class="top-right">
        ${opts.topExtra ? opts.topExtra : healthChip(chrome)}
        ${themeSwitch()}
        ${opts.topEnd ? opts.topEnd : clock()}
        <a class="whoami" href="/account" title="Your account">
          <span class="whoami-name">${esc(who.name)}</span>
          ${who.roleLabel ? `<span class="whoami-role">${esc(who.roleLabel)}</span>` : ""}
        </a>
        <form method="post" action="/logout" class="logout">
          <input type="hidden" name="_csrf" value="${esc(opts.csrf)}">
          <button type="submit" title="Sign out" aria-label="Sign out">${icon("power")}</button>
        </form>
      </div>
    </header>

    ${
      bare
        ? ""
        : // Dismisses the drawer by tap, and dims what is behind it. Inert and
          // invisible until the drawer opens, and absent entirely on a desktop
          // width where the sidebar is always there to be clicked.
          `<div class="nav-scrim" data-nav-close hidden></div>`
    }

    <div class="layout${bare ? " bare" : ""}">
      ${
        bare
          ? ""
          : `<aside class="sidebar" id="sidebar" aria-label="Sidebar">${renderSidebar(opts.active, dash, perm, chrome)}</aside>`
      }
      <main class="content${opts.wide ? " wide" : ""}${bare ? " flush" : " pat-" + pattern}">
        ${head}
        ${bare ? body : `<div class="frame-body${opts.fill ? " stretch" : ""}">${body}</div>`}
      </main>
    </div>`,
    Object.assign({}, opts, { pageClass })
  );
}

/**
 * System / Dark / Light. Rendered with System ticked; theme-init.js has already
 * applied the saved choice before paint, and app.js ticks the right button and
 * wires the clicks. Without JavaScript the page simply follows the system.
 */
function themeSwitch() {
  const opt = (value, iconName, label, title) =>
    `<button type="button" role="radio" data-theme-opt="${value}" aria-checked="${value === "system"}" title="${title}">${icon(iconName, 14)}<span>${label}</span></button>`;
  return `<div class="theme-seg" role="radiogroup" aria-label="Theme" data-theme-switch>
      ${opt("system", "monitor", "System", "Match the system setting")}${opt("dark", "moon", "Dark", "Dark")}${opt("light", "sun", "Light", "Light")}
    </div>`;
}

function page(title, inner, opts = {}) {
  const assets = (opts.assets || []).filter((f) => /^[a-z0-9-]+\.(css|js)$/.test(f));
  const css = assets.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="${asset(f)}">`).join("\n");
  const js = assets.filter((f) => f.endsWith(".js")).map((f) => `<script src="${asset(f)}" defer></script>`).join("\n");
  // The theme is applied before first paint, so a dark page never flashes
  // light. A blocking external script because the CSP forbids inline ones.
  const theme = `<script src="${asset("theme-init.js")}"></script>\n`;
  const cls = opts.pageClass && /^[a-z0-9 -]+$/.test(opts.pageClass) ? ` class="${opts.pageClass}"` : "";
  // The AI's own pages (the Command Center) carry the AI favicon and title;
  // everything else is the OS.
  const ai = opts.brand === "ai";
  return `<!doctype html>
<html lang="en"${cls}><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ai && title === "MINT AI" ? "MINT AI" : `${esc(title)} — ${ai ? "MINT AI" : "Mint OS"}`}</title>
<link rel="icon" href="${asset(`brand/favicon-${ai ? "ai" : "os"}-16.svg`)}" type="image/svg+xml" sizes="16x16">
<link rel="icon" href="${asset(`brand/favicon-${ai ? "ai" : "os"}-32.svg`)}" type="image/svg+xml" sizes="32x32">
<link rel="icon" href="${asset(ai ? "favicon-ai.svg" : "favicon.svg")}" type="image/svg+xml" sizes="any">
<link rel="alternate icon" href="${ai ? asset("favicon-ai.ico") : "/favicon.ico"}" sizes="48x48 32x32 16x16">
<link rel="apple-touch-icon" href="${asset(ai ? "favicon-ai.svg" : "favicon.svg")}">
<link rel="preload" href="/static/fonts/inter-latin-400-normal.woff2?v=5.3.0" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/static/fonts/space-grotesk-latin-700-normal.woff2?v=5.3.0" as="font" type="font/woff2" crossorigin>
${theme}<link rel="stylesheet" href="${asset("style.css")}">
<link rel="stylesheet" href="${asset("os.css")}">
${css}
<script src="${asset("app.js")}" defer></script>
<script src="${asset("console.js")}" defer></script>
<script src="${asset("os.js")}" defer></script>
${js}
</head><body>
${inner}
</body></html>`;
}

/* ------------------------------------------------------------ components - */

/**
 * Permission check for a view, given the viewer context it was handed.
 *
 * Views use this to hide buttons; routes enforce the same permission again
 * before acting. Hiding a control is a courtesy, not a boundary -- the boundary
 * is the guard on the route, and it is checked whether or not the button was
 * ever rendered. A missing context (the setup pages) allows everything, because
 * there is no actor to restrict yet.
 */
function can(user, perm, scopeSlug) {
  const p = user && typeof user === "object" ? user.perm : null;
  if (!p) return true;
  if (scopeSlug === undefined) return p.can(perm);
  return perm.startsWith("channels.")
    ? p.canChannel(perm, scopeSlug)
    : p.canAgent(perm, scopeSlug);
}

/**
 * Step indicator for the two-part agent creation flow.
 *
 * The two steps are the two existing forms, not a new combined one. Creating an
 * agent and connecting a channel are separately useful -- you add a second
 * channel to an existing agent, or rebuild a channel without touching the
 * agent's memory -- so the wizard chains the real pages rather than replacing
 * them with a bespoke path that would then have to be maintained twice.
 */
function steps(current, items) {
  return `<ol class="wizard">
    ${items
      .map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "on" : "";
        return `<li class="wizard-step ${state}">
          <span class="wizard-num">${n < current ? icon("check", 14) : n}</span>
          <span>${esc(label)}</span>
        </li>`;
      })
      .join("")}
  </ol>`;
}

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
    <div class="bar"><div class="fill ${level}" data-w="${pct}"></div></div>
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
  return `<section class="card${opts.className ? " " + opts.className : ""}"${opts.id ? ` id="${esc(opts.id)}"` : ""}>
    ${
      title
        ? `<div class="card-head"><h2>${
            opts.icon ? icon(opts.icon) : ""
          }${esc(title)}</h2>${opts.actions || ""}</div>`
        : ""
    }
    ${opts.bodyClass ? `<div class="${esc(opts.bodyClass)}">${body}</div>` : body}
  </section>`;
}

/**
 * A document page with a sticky side column (pattern C): the main column
 * scrolls with the page, the side stays in view.
 */
function docLayout(main, side) {
  return `<div class="doc-grid"><div class="doc-main">${main}</div><aside class="doc-side">${side}</aside></div>`;
}

/** "On this page": links to the sections of a document, highlighted by os.js. */
function tocCard(items, title) {
  if (!items.length) return "";
  return `<section class="card"><div class="card-head"><h2>${esc(title || "On this page")}</h2></div>
    <ul class="toc-list" data-toc>${items
      .map(([id, label], i) => `<li><a href="#${esc(id)}"${i === 0 ? ' class="on"' : ""}>${esc(label)}</a></li>`)
      .join("")}</ul></section>`;
}

function flashes({ msg, err }) {
  let out = "";
  if (msg) out += `<div class="alert good">${icon("check")}<div>${esc(msg)}</div></div>`;
  if (err) out += `<div class="alert bad">${icon("alert")}<div>${esc(err)}</div></div>`;
  return out;
}

/**
 * How to enrol, worded for Microsoft Authenticator.
 *
 * The app files a panel like this one under "Other account", not under its
 * "Work or school account" flow -- that one signs in to Entra and will not
 * accept this QR code. Somebody who taps the wrong entry gets an error that
 * explains nothing, so the path is spelled out rather than left to be found.
 *
 * Shared by first-run setup, admin enrolment and the move-app flow, because
 * three copies of an instruction is three chances for one of them to go stale.
 */
function enrolSteps(account) {
  return `<ol class="steps">
    <li>Open <strong>Microsoft Authenticator</strong> on your phone.</li>
    <li>Tap <strong>+</strong>, then <strong>Other account (Google, Facebook, etc.)</strong>
      — not "Work or school account".</li>
    <li>Scan the code${
      account ? ` — it is saved as <span class="mono">${esc(account)}</span>` : ""
    }.</li>
  </ol>
  <p class="muted small">Any other authenticator works the same way. This is standard
    RFC 6238, so Authy, 1Password and Google Authenticator all read the same code.</p>`;
}

function empty(iconName, title, body) {
  return `<div class="empty">
    <span class="empty-ico">${icon(iconName, 28)}</span>
    <p class="empty-title">${esc(title)}</p>
    <p class="muted">${body}</p>
  </div>`;
}

module.exports = {
  docLayout,
  tocCard,
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
  enrolSteps,
  icon,
  can,
  steps,
  NAV,
  DASHBOARDS,
};
