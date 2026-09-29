"use strict";
/**
 * The supervisor's socket protocol, and the one place it is validated.
 *
 * Newline-delimited JSON over a unix socket. Each request is one line:
 *
 *   {"id": "r1", "op": "status", "actor": "amaraghy"}
 *
 * and gets one reply line:
 *
 *   {"id": "r1", "ok": true, "data": {...}}
 *   {"id": "r1", "ok": false, "error": "..."}
 *
 * `events` is the exception: after its reply the connection carries
 * {"event": {...}} lines until the client hangs up.
 *
 * `actor` is the signed-in panel user the dashboard is acting for. The socket
 * is reachable only by root and the moniai group, so the actor is taken on the
 * dashboard's word -- but it is always required and always recorded, so the
 * audit trail says who asked rather than "moniadmin".
 *
 * Everything is re-validated here even though the dashboard validates first:
 * this is the boundary between a web-facing process and a root one.
 */

const MAX_LINE = 64 * 1024;
const MAX_TEXT = 20000;
const ACTOR_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

const TABLES = ["delegations", "inbound", "approvals", "turns", "audit"];
const WATCHERS = ["service_failed", "ban_burst", "disk", "agent_failing", "odoo_errors"];
const STATUSES = {
  delegations: ["sent", "working", "ack", "held", "done", "failed", "denied"],
  approvals: ["pending", "approved", "denied", "expired", "cancelled"],
  turns: ["queued", "running", "done", "error", "interrupted", "lost"],
  inbound: ["message", "idle", "delivery"],
  audit: [],
};

// op -> { mutating, params: { name: validator } }
const OPS = {
  ping: { mutating: false, params: {} },
  status: { mutating: false, params: {} },
  sessions: { mutating: false, params: {} },
  "rc-url": { mutating: false, params: {} },
  events: { mutating: false, params: { since: optInt(0, Number.MAX_SAFE_INTEGER) } },
  ledger: {
    mutating: false,
    params: {
      table: enumOf(TABLES),
      limit: optInt(1, 500),
      before_id: optInt(1, Number.MAX_SAFE_INTEGER),
      status: optString(32, /^[a-z_]+$/),
    },
  },
  send: {
    mutating: true,
    params: {
      text: text(1, MAX_TEXT),
      target: optString(300, /^[^\n\r\u0000]*$/),
      // "voice-desk": passed on by the voice front desk (trial). Recorded as the
      // turn's source; it changes nothing else about the turn.
      via: optEnum(["voice-desk"]),
      // The one-time ui token the Command Center minted for this send (UI
      // control Phase 2): lets MINT AI's ui_action reach the tab that asked,
      // during this turn only. Kept in memory, never in the ledger or events.
      ut: optString(40, /^[A-Za-z0-9_-]{16,40}$/),
    },
  },
  // MINT AI's ui_action (its MCP tool): change what the administrator sees in
  // the tab that asked. Accepted only from actor "moni-ai", only while a turn
  // the administrator started (dashboard / voice-desk) with a ui token runs.
  "ui-action": { mutating: true, params: { action: str(40, /^[a-z]+(\.[a-z_]+)?$/), args: uiArgs() } },
  // The Command Center's answer to one ui event (the page did it, or refused).
  // pending: a Tier-2 preference shown for the administrator's confirm (nothing changed yet).
  "ui-ack": { mutating: true, params: { nonce: str(40, /^[A-Za-z0-9]{8,40}$/), ok: bool(), why: optText(200), pending: optBool() } },
  interrupt: { mutating: true, params: {} },
  approve: {
    mutating: true,
    params: { approval_id: int(1, Number.MAX_SAFE_INTEGER), note: optText(500), rule_pattern: optText(2000), rule_tool: optEnum(["Bash", "SendMessage"]) },
  },
  deny: { mutating: true, params: { approval_id: int(1, Number.MAX_SAFE_INTEGER), note: optText(500) } },
  rc: { mutating: true, params: { enabled: bool() } },
  restart: { mutating: true, params: {} },
  // Start MINT AI in a new conversation (new session id; the old transcript stays on disk).
  fresh: { mutating: true, params: { reason: optText(300), force: optBool() } },

  /* ---- phase 1 of Command Center v3: reads ---- */
  machine: { mutating: false, params: {} },
  missions: { mutating: false, params: { status: optEnum(["active", "all"]), limit: optInt(1, 200) } },
  mission: { mutating: false, params: { mission_id: missionId() } },
  decisions: { mutating: false, params: { status: optEnum(["open", "all"]), limit: optInt(1, 200) } },
  watchers: { mutating: false, params: {} },
  orders: { mutating: false, params: {} },
  "order-runs": { mutating: false, params: { order_id: int(1, Number.MAX_SAFE_INTEGER), limit: optInt(1, 100) } },
  rules: { mutating: false, params: {} },
  "rule-test": { mutating: false, params: { command: text(1, 8000), tool: optEnum(["Bash", "SendMessage"]) } },
  "rule-suggest": { mutating: false, params: { approval_id: int(1, Number.MAX_SAFE_INTEGER) } },
  cost: { mutating: false, params: {} },
  // The voice front desk's read-only view: counts, titles and figures, never a
  // command. `turns`: the desk's own earlier requests, to learn their replies.
  snapshot: { mutating: false, params: { turns: optIntList(1, Number.MAX_SAFE_INTEGER, 20) } },
  "session-mirror": { mutating: false, params: { session_id: str(36, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) } },

  /* ---- writes ---- */
  "mission-create": { mutating: true, params: { title: text(1, 200), goal: optText(4000), steps: optArray(stepSpec(), 50) } },
  "mission-step-add": { mutating: true, params: { mission_id: missionId(), title: text(1, 300), detail: optText(4000), target: optString(300, /^[^\n\r\u0000]*$/) } },
  "mission-step-update": {
    mutating: true,
    params: {
      mission_id: missionId(),
      step: int(1, 1000),
      status: optEnum(["planned", "delegated", "working", "waiting_approval", "done", "failed", "skipped"]),
      target: optString(300, /^[^\n\r\u0000]*$/),
      result: optText(4000),
      note: optText(1000),
      title: optText(300),
      detail: optText(4000),
    },
  },
  "mission-update": { mutating: true, params: { mission_id: missionId(), status: optEnum(["planned", "active", "done", "failed", "cancelled"]), title: optText(200), goal: optText(4000) } },
  "mission-request": { mutating: true, params: { goal: text(1, 4000) } },
  "decision-propose": { mutating: true, params: { decision_id: int(1, Number.MAX_SAFE_INTEGER), summary: text(1, 4000), evidence: optText(8000), fix_command: optText(4000) } },
  "decision-update": { mutating: true, params: { decision_id: int(1, Number.MAX_SAFE_INTEGER), status: enumOf(["done", "failed"]), result: optText(4000) } },
  "decision-approve": { mutating: true, params: { decision_id: int(1, Number.MAX_SAFE_INTEGER), note: optText(500) } },
  "decision-dismiss": { mutating: true, params: { decision_id: int(1, Number.MAX_SAFE_INTEGER), note: optText(500) } },
  "decision-ask": { mutating: true, params: { decision_id: int(1, Number.MAX_SAFE_INTEGER), text: text(1, 4000) } },
  "watcher-set": { mutating: true, params: { key: enumOf(WATCHERS), enabled: bool() } },
  "watcher-inject": { mutating: true, params: { watcher: enumOf(WATCHERS), subject: str(120, /^[A-Za-z0-9@._\/-]{1,120}$/), detail: optText(2000), evidence: optText(4000) } },
  "order-create": { mutating: true, params: orderParams(false) },
  "order-update": { mutating: true, params: { order_id: int(1, Number.MAX_SAFE_INTEGER), ...orderParams(true) } },
  "order-delete": { mutating: true, params: { order_id: int(1, Number.MAX_SAFE_INTEGER) } },
  "order-run": { mutating: true, params: { order_id: int(1, Number.MAX_SAFE_INTEGER) } },
  "order-pause": { mutating: true, params: { order_id: int(1, Number.MAX_SAFE_INTEGER), paused: bool() } },
  "rule-create": { mutating: true, params: { effect: enumOf(["allow", "ask", "deny"]), tool: enumOf(["Bash", "SendMessage", "any"]), pattern: text(1, 2000), note: optText(500) } },
  "rule-update": {
    mutating: true,
    params: { rule_id: int(1, Number.MAX_SAFE_INTEGER), effect: optEnum(["allow", "ask", "deny"]), tool: optEnum(["Bash", "SendMessage", "any"]), pattern: optText(2000), note: optText(500) },
  },
  "rule-delete": { mutating: true, params: { rule_id: int(1, Number.MAX_SAFE_INTEGER) } },
  "cost-budget": { mutating: true, params: { daily_usd: nullableNumber(0, 100000), warn_pct: int(50, 100) } },
};

/* ------------------------------------------------------------ validators --- */

/** A screen action's flat arguments: at most six known keys, short strings or booleans. */
function uiArgs() {
  const KEYS = ["key", "mode", "name", "core", "page", "on", "theme", "preset", "voice"]; // = UiActions.ARG_KEYS (tested)
  const f = (v, name) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${name} must be an object`);
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (!KEYS.includes(k)) throw new Error(`${name} has an unexpected field: ${k.slice(0, 40)}`);
      if (typeof x === "boolean") out[k] = x;
      else if (typeof x === "string" && x.length <= 40 && /^[A-Za-z0-9._-]*$/.test(x)) out[k] = x;
      else throw new Error(`${name}.${k} is not valid`);
    }
    return out;
  };
  f.optional = true;
  return f;
}

function optIntList(min, max, maxLen) {
  const f = (v, name) => {
    if (!Array.isArray(v) || v.length > maxLen || v.some((x) => typeof x !== "number" || !Number.isInteger(x) || x < min || x > max))
      throw new Error(`${name} must be a list of at most ${maxLen} integers`);
    return [...new Set(v)];
  };
  f.optional = true;
  return f;
}
function optEnum(values) {
  const f = enumOf(values);
  f.optional = true;
  return f;
}
function str(max, re) {
  return (v, name) => {
    if (typeof v !== "string" || v.length > max || !re.test(v)) throw new Error(`${name} is not valid`);
    return v.trim();
  };
}
function missionId() {
  return (v, name) => {
    const s = typeof v === "number" ? String(v) : v;
    if (typeof s !== "string" || !/^(M-)?[1-9][0-9]{0,8}$/i.test(s.trim())) throw new Error(`${name} must look like M-12`);
    return Number(s.trim().replace(/^M-/i, ""));
  };
}
function nullableNumber(min, max) {
  const f = (v, name) => {
    if (v === false) return null;
    if (typeof v !== "number" || !isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number ${min}..${max} or null`);
    return Math.round(v * 100) / 100;
  };
  f.nullable = true;
  return f;
}
/** An array of objects, each checked by `item`. */
function optArray(item, max) {
  const f = (v, name) => {
    if (!Array.isArray(v)) throw new Error(`${name} must be a list`);
    if (v.length > max) throw new Error(`${name} has more than ${max} items`);
    return v.map((x, i) => item(x, `${name}[${i}]`));
  };
  f.optional = true;
  return f;
}
/** An object with exactly these fields. */
function objOf(spec) {
  return (v, name) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${name} must be an object`);
    for (const k of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(spec, k)) throw new Error(`${name} has an unexpected field: ${k.slice(0, 40)}`);
    const out = {};
    for (const [k, check] of Object.entries(spec)) {
      if (v[k] === undefined || v[k] === null) {
        if (check.optional) continue;
        throw new Error(`${name}.${k} is required`);
      }
      out[k] = check(v[k], `${name}.${k}`);
    }
    return out;
  };
}
function stepSpec() {
  return objOf({ title: text(1, 300), detail: optText(4000), target: optString(300, /^[^\n\r\u0000]*$/) });
}
function orderParams(partial) {
  const o = (f) => {
    if (!partial) return f;
    const g = (v, n) => f(v, n);
    g.optional = true;
    return g;
  };
  const schedule = objOf({
    kind: enumOf(["daily", "weekdays", "weekly", "hours", "cron"]),
    at: optString(5, /^([01][0-9]|2[0-3]):[0-5][0-9]$/),
    dow: optInt(0, 6),
    every_h: optInt(1, 24),
    cron: optString(100, /^[0-9*,\/ -]{9,100}$/),
  });
  const delivery = (v, name) => {
    if (!Array.isArray(v) || !v.length || v.length > 2 || v.some((x) => !["cc", "telegram"].includes(x))) throw new Error(`${name} must be a list of cc / telegram`);
    return [...new Set(v)];
  };
  return {
    name: o(text(1, 120)),
    schedule: o(schedule),
    target: o(str(300, /^[^\n\r\u0000]{1,300}$/)),
    prompt: o(text(1, 8000)),
    delivery: o(delivery),
    paused: optBool(),
  };
}
function optBool() {
  const f = bool();
  f.optional = true;
  return f;
}

function int(min, max) {
  return (v, name) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer ${min}..${max}`);
    return v;
  };
}
function optInt(min, max) {
  const f = int(min, max);
  f.optional = true;
  return f;
}
function bool() {
  return (v, name) => {
    if (typeof v !== "boolean") throw new Error(`${name} must be true or false`);
    return v;
  };
}
function enumOf(values) {
  return (v, name) => {
    if (typeof v !== "string" || !values.includes(v)) throw new Error(`${name} must be one of ${values.join(", ")}`);
    return v;
  };
}
function text(min, max) {
  return (v, name) => {
    if (typeof v !== "string") throw new Error(`${name} must be a string`);
    if (v.includes("\u0000")) throw new Error(`${name} contains a NUL byte`);
    const t = v.trim();
    if (t.length < min) throw new Error(`${name} is empty`);
    if (v.length > max) throw new Error(`${name} is longer than ${max} characters`);
    return t;
  };
}
function optText(max) {
  const f = (v, name) => {
    if (typeof v !== "string") throw new Error(`${name} must be a string`);
    if (v.includes("\u0000")) throw new Error(`${name} contains a NUL byte`);
    if (v.length > max) throw new Error(`${name} is longer than ${max} characters`);
    return v.trim();
  };
  f.optional = true;
  return f;
}
function optString(max, re) {
  const f = (v, name) => {
    if (typeof v !== "string" || v.length > max || !re.test(v)) throw new Error(`${name} is not valid`);
    return v.trim();
  };
  f.optional = true;
  return f;
}

/**
 * Parse and validate one request line.
 * Returns { ok: true, req: { id, op, actor, params, mutating } } or
 *         { ok: false, id, error }.
 */
function parseRequest(line) {
  if (typeof line !== "string") return { ok: false, id: null, error: "request must be text" };
  if (Buffer.byteLength(line, "utf8") > MAX_LINE) return { ok: false, id: null, error: "request too large" };
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    return { ok: false, id: null, error: "request is not valid JSON" };
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { ok: false, id: null, error: "request must be a JSON object" };

  const id = typeof msg.id === "number" && Number.isInteger(msg.id) ? String(msg.id) : msg.id;
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, id: null, error: "id is missing or malformed" };

  const spec = Object.prototype.hasOwnProperty.call(OPS, msg.op) ? OPS[msg.op] : null;
  if (!spec) return { ok: false, id, error: "unknown op" };

  if (typeof msg.actor !== "string" || !ACTOR_RE.test(msg.actor)) return { ok: false, id, error: "actor is missing or malformed" };

  const params = {};
  for (const key of Object.keys(msg)) {
    if (key === "id" || key === "op" || key === "actor") continue;
    if (!Object.prototype.hasOwnProperty.call(spec.params, key)) return { ok: false, id, error: `unexpected field: ${key.slice(0, 40)}` };
  }
  for (const [name, check] of Object.entries(spec.params)) {
    const v = msg[name];
    if (v === null && check.nullable) {
      params[name] = null;
      continue;
    }
    if (v === undefined || v === null) {
      if (check.optional) continue;
      return { ok: false, id, error: `${name} is required` };
    }
    try {
      params[name] = check(v, name);
    } catch (e) {
      return { ok: false, id, error: e.message };
    }
  }

  if (msg.op === "ledger" && params.status !== undefined) {
    const allowed = STATUSES[params.table] || [];
    if (!allowed.includes(params.status)) return { ok: false, id, error: "status is not valid for that table" };
  }

  return { ok: true, req: { id, op: msg.op, actor: msg.actor, params, mutating: spec.mutating } };
}

/** Serialise a reply line. */
function reply(id, data) {
  return JSON.stringify({ id, ok: true, data }) + "\n";
}
function replyError(id, error) {
  return JSON.stringify({ id, ok: false, error: String(error).slice(0, 500) }) + "\n";
}

module.exports = { OPS, TABLES, WATCHERS, STATUSES, MAX_LINE, MAX_TEXT, ACTOR_RE, parseRequest, reply, replyError };
