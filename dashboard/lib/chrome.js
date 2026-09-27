"use strict";
/**
 * What the frame shows on every page: the live count badges in the sidebar,
 * the health chip in the top bar, and the line under each dashboard's name.
 *
 * Every page draws the frame, so none of this may cost a page a helper round
 * trip. The facts are fetched together, at most once every CACHE_MS, and held
 * for everyone: a page render reads the cache, and a stale cache is refreshed
 * in the background while the stale copy is served. Only the very first page
 * after a start waits, and not for long -- if the helper is slow the frame
 * simply renders without numbers.
 *
 * The cache is shared, the numbers are not: badges are derived per actor at
 * render time, so a role scoped to one agent counts one agent, and a role that
 * cannot see users never sees how many are pending.
 */

const os = require("os");

const CACHE_MS = 30 * 1000;
const FIRST_WAIT_MS = 1500;

let deps = null; // { priv, db, catalog } -- injected so tests can fake them
let cache = null; // { at, data }
let inflight = null;

function configure(d) {
  deps = d;
  cache = null;
  inflight = null;
}

async function settle(map) {
  const keys = Object.keys(map);
  const out = {};
  const results = await Promise.allSettled(keys.map((k) => map[k]()));
  results.forEach((r, i) => {
    out[keys[i]] = r.status === "fulfilled" ? r.value : null;
  });
  return out;
}

function refresh() {
  if (inflight) return inflight;
  const { priv } = deps;
  inflight = settle({
    services: () => priv.serviceList(),
    agents: () => priv.agentList(),
    channels: () => priv.channelList(),
    status: () => priv.status(),
    credentials: () => priv.credentialList(),
    keys: () => priv.listAllKeys(),
    memory: () => priv.ccMemoryStats(),
    running: () => priv.ccRunning(),
  })
    .then((data) => {
      cache = { at: Date.now(), data };
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The shared facts, fresh within CACHE_MS; stale ones while a refresh runs. */
async function facts() {
  if (!deps) return null;
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.data;
  const p = refresh().catch(() => null);
  if (cache) return cache.data; // serve stale, refresh behind it
  const timeout = new Promise((r) => setTimeout(() => r(null), FIRST_WAIT_MS));
  const got = await Promise.race([p, timeout]);
  return got ? got.data : null;
}

const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");

function uptimeShort(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d ? d + "d" : h + "h";
}

/**
 * The frame for one actor. `perm` is the actor from rbac; `data` the shared
 * facts (null when the helper has not answered yet -- then only what this
 * process knows by itself is shown).
 */
function forActor(perm, data) {
  const can = (p) => !perm || perm.can(p);
  const sees = (slug) => !perm || perm.seesAgent(slug);
  const seesCh = (slug) => !perm || perm.seesChannel(slug);
  const d = data || {};
  const badges = {};

  const services = Array.isArray(d.services) ? d.services : null;
  const agents = Array.isArray(d.agents) ? d.agents.filter((a) => sees(a.slug)) : null;
  const channels = Array.isArray(d.channels) ? d.channels.filter((c) => seesCh(c.slug)) : null;
  const down = services ? services.filter((s) => s.active !== "active") : [];
  const failed = agents ? agents.filter((a) => a.state && a.state.active === "failed") : [];
  const running = agents ? agents.filter((a) => a.state && a.state.active === "active") : [];

  if (services && can("services.view")) {
    badges.services = [services.length - down.length + "/" + services.length, down.length ? "warn" : "plain"];
  }
  if (d.status && d.status.jails && can("firewall.view")) {
    const banned = Object.values(d.status.jails).reduce((n, j) => n + (j.banned || 0), 0);
    badges.firewall = [banned + " banned", banned ? "warn" : "plain"];
  }
  if (Array.isArray(d.credentials) && can("credentials.view")) {
    const set = d.credentials.filter((c) => c.configured).length;
    badges.credentials = [set + " set", set ? "ok" : "warn"];
  }
  if (d.keys && typeof d.keys === "object" && can("keys.view")) {
    const n = Object.values(d.keys).reduce((m, list) => m + (Array.isArray(list) ? list.length : 0), 0);
    badges.keys = [String(n), "plain"];
  }
  if (deps && deps.db) {
    try {
      if (can("users.view")) {
        const users = deps.db.listUsers();
        const pending = users.filter((u) => !u.totp_confirmed && !u.disabled).length;
        badges.users = pending ? [pending + " pending", "warn"] : [String(users.length), "plain"];
      }
      if (can("roles.view")) badges.roles = [String(deps.db.listRoles().length), "plain"];
      if (can("devices.view")) badges.devices = [String(deps.db.listDevices().length), "plain"];
    } catch (_) {
      /* the database is this process's own; if it fails the page will say so */
    }
  }
  if (d.memory && d.memory.db && can("claude.memory.read")) {
    badges["claude-memory"] = [String(d.memory.db.facts.current), "plain"];
  }
  if (d.running && Array.isArray(d.running.sessions) && can("claude.running.view")) {
    const live = d.running.sessions.filter((s) => s.alive !== false).length;
    badges["claude-running"] = [live + " live", live ? "ok" : "plain"];
  }
  if (agents && can("agents.view")) {
    badges.agents = failed.length ? [failed.length + " failed", "bad"] : [String(agents.length), "plain"];
  }
  if (channels && can("channels.view")) badges.channels = [String(channels.length), "plain"];
  if (deps && deps.catalog && can("addons.view")) {
    try {
      badges.addons = [String(deps.catalog.ADDONS ? deps.catalog.ADDONS.length : deps.catalog.all().length), "plain"];
    } catch (_) {
      /* no count is better than a wrong one */
    }
  }

  // The health chip: what needs attention, among what this actor may see.
  let health = null;
  const svcIssue = services && can("services.view") ? down.length : 0;
  const agentIssue = agents && can("agents.view") ? failed.length : 0;
  if (svcIssue || agentIssue) {
    const parts = [];
    if (svcIssue) parts.push(plural(svcIssue, "service") + (svcIssue === 1 ? " needs" : " need") + " attention");
    if (agentIssue) parts.push(plural(agentIssue, "agent") + " failed");
    health = {
      cls: agentIssue ? "bad" : "warn",
      text: parts.join(" · "),
      short: svcIssue + agentIssue + " attention",
      href: svcIssue ? "/services" : "/agents/dashboard",
    };
  } else if ((services && can("services.view")) || (agents && can("agents.view"))) {
    health = { cls: "ok", text: "All systems nominal", short: "Nominal", href: can("services.view") ? "/services" : "/agents/dashboard" };
  }

  const mem = os.totalmem();
  const ids = {
    os: {
      name: os.hostname(),
      sub: os.cpus().length + " vCPU · " + Math.round(mem / 1024 ** 3) + " GB · up " + uptimeShort(os.uptime()),
    },
    agents: {
      name: "Agent fleet",
      sub: agents
        ? running.length + " of " + agents.length + " running" + (channels ? " · " + plural(channels.length, "channel") : "")
        : "—",
    },
  };

  return { badges, health, ids };
}

/** Express middleware: attaches req.chrome for signed-in page requests. */
function middleware() {
  return async (req, res, next) => {
    req.chrome = null;
    if (!req.me || req.method !== "GET" || req.path.startsWith("/api/") || req.path.includes("/api/")) return next();
    try {
      req.chrome = forActor(req.perm, await facts());
    } catch (_) {
      req.chrome = null;
    }
    next();
  };
}

/** Forget the cache, so a page after a change shows the change. */
function invalidate() {
  if (cache) cache.at = 0;
}

module.exports = { configure, facts, forActor, middleware, invalidate, CACHE_MS };
