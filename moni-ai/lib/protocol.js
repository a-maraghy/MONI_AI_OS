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
    },
  },
  interrupt: { mutating: true, params: {} },
  approve: { mutating: true, params: { approval_id: int(1, Number.MAX_SAFE_INTEGER), note: optText(500) } },
  deny: { mutating: true, params: { approval_id: int(1, Number.MAX_SAFE_INTEGER), note: optText(500) } },
  rc: { mutating: true, params: { enabled: bool() } },
  restart: { mutating: true, params: {} },
};

/* ------------------------------------------------------------ validators --- */

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

module.exports = { OPS, TABLES, STATUSES, MAX_LINE, MAX_TEXT, ACTOR_RE, parseRequest, reply, replyError };
