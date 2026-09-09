"use strict";
/**
 * Roles and permissions.
 *
 * The model is deliberately small: a user has exactly one role, a role holds a
 * set of permission strings plus a scope, and every guarded action names one
 * permission. No permission inheritance, no per-user overrides, no deny rules.
 * Those are the features that make an access model impossible to reason about,
 * and "who can restart this agent" has to be answerable by reading one page.
 *
 * Scope is the second axis. A permission says *what* you may do; the scope says
 * *which* agents and channels you may do it to. `*` means all of them --
 * including ones created after the role was written, which is what you want for
 * an operator and emphatically not what you want for a contractor who should
 * only ever see one bot.
 */

/* --------------------------------------------------------- permissions --- */

// Grouped for the editor UI. `key` is what gets stored and checked; the group
// is presentation only.
const PERMISSION_GROUPS = [
  {
    key: "agents",
    label: "Agents",
    scoped: "agent",
    blurb: "Scoped by the agent scope below.",
    perms: [
      { key: "agents.view", label: "View agents", hint: "See the agent list, status and configuration." },
      { key: "agents.logs", label: "Read agent logs", hint: "Logs can contain message content." },
      { key: "agents.control", label: "Start / stop / restart", hint: "Change whether an agent is running." },
      { key: "agents.edit", label: "Edit instructions & settings", hint: "Change how the agent behaves." },
      { key: "agents.memory.read", label: "Read memory", hint: "Browse and search the agent's vault." },
      { key: "agents.memory.write", label: "Write memory", hint: "Create, edit and reindex notes." },
      { key: "agents.create", label: "Create agents", hint: "Not scoped — a new agent has no scope yet." },
      { key: "agents.delete", label: "Delete agents", hint: "Removes the workspace and the vault." },
    ],
  },
  {
    key: "channels",
    label: "Channels",
    scoped: "channel",
    blurb: "Scoped by the channel scope below.",
    perms: [
      { key: "channels.view", label: "View channels", hint: "See channels and their link state." },
      { key: "channels.logs", label: "Read channel logs" },
      { key: "channels.edit", label: "Edit channels", hint: "Rebind agents, replace tokens, link WhatsApp." },
      { key: "channels.create", label: "Create channels" },
      { key: "channels.delete", label: "Delete channels" },
    ],
  },
  {
    key: "addons",
    label: "Add-ons",
    perms: [
      { key: "addons.view", label: "Browse the catalogue" },
      { key: "addons.manage", label: "Enable and disable add-ons", hint: "Applies to agents in scope." },
    ],
  },
  {
    key: "os",
    label: "System",
    perms: [
      { key: "os.view", label: "View the OS dashboard", hint: "Host stats, capabilities, service health." },
      { key: "services.view", label: "View system services" },
      { key: "services.logs", label: "Read service logs" },
      { key: "services.control", label: "Start / stop / restart services", hint: "Core units stay protected regardless." },
      { key: "audit.view", label: "View the audit log" },
    ],
  },
  {
    key: "secrets",
    label: "Credentials & access",
    perms: [
      { key: "credentials.view", label: "View credential state", hint: "Never shows a secret value." },
      { key: "credentials.edit", label: "Set and clear credentials", hint: "Affects every agent at once." },
      { key: "keys.view", label: "View SSH keys" },
      { key: "keys.manage", label: "Add and remove SSH keys", hint: "This is shell access to the host." },
      { key: "devices.view", label: "View paired devices" },
      { key: "devices.manage", label: "Pair and unpair devices" },
    ],
  },
  {
    key: "console",
    label: "MONI Bot console",
    blurb: "Chatting with Claude Code from inside the panel.",
    perms: [
      {
        key: "console.use",
        label: "Use the console",
        hint: "Confined to the agent workspace, running as the agent account.",
      },
      {
        key: "console.full",
        label: "Run it against the whole server",
        hint: "Root, anywhere, tool permissions bypassed. This is shell access to the host.",
      },
    ],
  },
  {
    key: "access",
    label: "User management",
    perms: [
      { key: "users.view", label: "View users" },
      { key: "users.manage", label: "Create, edit and disable users" },
      { key: "roles.view", label: "View roles" },
      { key: "roles.manage", label: "Create and edit roles", hint: "Anyone with this can grant themselves anything." },
    ],
  },
];

const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.perms.map((p) => p.key));
const PERMISSION_SET = new Set(ALL_PERMISSIONS);
const PERMISSION_LABEL = Object.fromEntries(
  PERMISSION_GROUPS.flatMap((g) => g.perms.map((p) => [p.key, p.label]))
);

/**
 * Permissions that imply another. Granting "edit" without "view" produces a
 * user who can change an agent they cannot find, so the implications are closed
 * over at save time rather than being left as a trap in the editor.
 */
const IMPLIES = {
  "agents.logs": ["agents.view"],
  "agents.control": ["agents.view"],
  "agents.edit": ["agents.view"],
  "agents.delete": ["agents.view"],
  "agents.create": ["agents.view"],
  "agents.memory.read": ["agents.view"],
  "agents.memory.write": ["agents.view", "agents.memory.read"],
  "channels.logs": ["channels.view"],
  "channels.edit": ["channels.view"],
  "channels.create": ["channels.view"],
  "channels.delete": ["channels.view"],
  "addons.manage": ["addons.view", "agents.view"],
  "services.control": ["services.view", "os.view"],
  "services.logs": ["services.view", "os.view"],
  "services.view": ["os.view"],
  "credentials.edit": ["credentials.view"],
  "keys.manage": ["keys.view"],
  "devices.manage": ["devices.view"],
  "users.manage": ["users.view", "roles.view"],
  "roles.manage": ["roles.view"],
  "console.full": ["console.use"],
};

/** Expand a permission list to include everything it implies. */
function closure(perms) {
  const out = new Set();
  const queue = [...perms].filter((p) => PERMISSION_SET.has(p));
  while (queue.length) {
    const p = queue.pop();
    if (out.has(p)) continue;
    out.add(p);
    for (const dep of IMPLIES[p] || []) queue.push(dep);
  }
  return [...out].sort();
}

/* -------------------------------------------------------- system roles --- */

/**
 * Seeded on first boot. `administrator` is special: it is granted everything
 * implicitly (so a permission added in a later release does not silently fail
 * to reach the person who owns the machine) and cannot be edited or deleted.
 * The others are ordinary rows -- starting points the operator is expected to
 * bend to their own shape.
 */
const SYSTEM_ROLES = [
  {
    name: "administrator",
    label: "Administrator",
    description: "Full control over the OS and every agent. Cannot be edited or removed.",
    builtin: 1,
    permissions: ["*"],
    agent_scope: "*",
    channel_scope: "*",
  },
  {
    name: "operator",
    label: "Operator",
    description: "Runs the fleet day to day: create and control agents and channels, no host access.",
    builtin: 0,
    permissions: closure([
      "agents.create",
      "agents.delete",
      "agents.control",
      "agents.edit",
      "agents.logs",
      "agents.memory.write",
      "channels.create",
      "channels.delete",
      "channels.edit",
      "channels.logs",
      "addons.manage",
      "os.view",
      "services.view",
    ]),
    agent_scope: "*",
    channel_scope: "*",
  },
  {
    name: "viewer",
    label: "Viewer",
    description: "Read-only. Sees status and configuration, changes nothing.",
    builtin: 0,
    permissions: closure(["agents.view", "channels.view", "addons.view", "os.view", "services.view"]),
    agent_scope: "*",
    channel_scope: "*",
  },
];

/* ------------------------------------------------------------- checking --- */

/**
 * The object hung on `req.perm`. Every guard in the app goes through this, so
 * the fail-closed default lives in one place: an actor with no role can do
 * nothing at all.
 */
function actor(role) {
  const admin = !!role && Array.isArray(role.permissions) && role.permissions.includes("*");
  const held = new Set(admin ? ALL_PERMISSIONS : (role && role.permissions) || []);
  const agentScope = parseScope(role && role.agent_scope);
  const channelScope = parseScope(role && role.channel_scope);

  const can = (perm) => held.has(perm);

  return {
    role: role || null,
    admin,
    permissions: [...held],
    agentScope,
    channelScope,
    can,
    /** `can`, but also requiring the named agent to be inside the role's scope. */
    canAgent: (perm, slug) => can(perm) && inScope(agentScope, slug),
    canChannel: (perm, slug) => can(perm) && inScope(channelScope, slug),
    seesAgent: (slug) => inScope(agentScope, slug),
    seesChannel: (slug) => inScope(channelScope, slug),
    /** True if the actor can reach anything at all on that dashboard. */
    canDash: (key) =>
      key === "console"
        ? can("console.use")
        : key === "agents"
        ? can("agents.view") || can("channels.view") || can("addons.view")
        : can("os.view") ||
          can("credentials.view") ||
          can("keys.view") ||
          can("devices.view") ||
          can("audit.view") ||
          can("users.view") ||
          can("roles.view"),
  };
}

/** Scope is stored as `*` or a comma-separated slug list. */
function parseScope(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (s === "*" || s === "") return "*";
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function inScope(scope, slug) {
  if (scope === "*") return true;
  if (!slug) return false;
  return scope.includes(slug);
}

function scopeLabel(scope) {
  if (scope === "*") return "all";
  if (!scope.length) return "none";
  return scope.join(", ");
}

module.exports = {
  PERMISSION_GROUPS,
  ALL_PERMISSIONS,
  PERMISSION_SET,
  PERMISSION_LABEL,
  SYSTEM_ROLES,
  closure,
  actor,
  parseScope,
  inScope,
  scopeLabel,
};
