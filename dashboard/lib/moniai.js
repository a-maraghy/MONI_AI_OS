"use strict";
/**
 * Client for the MONI AI supervisor's unix socket.
 *
 * The supervisor (moni-ai.service, root) owns MONI AI's Claude Code process.
 * This panel talks to it over /run/moni-ai/moni-ai.sock, which only root and
 * the moniai group can open -- moniadmin is in that group, nobody else is. No
 * sudo, no helper: the socket is the privilege boundary, and the supervisor
 * validates every request again (moni-ai/lib/protocol.js).
 *
 * Each call carries the signed-in panel user as `actor`, so the supervisor's
 * audit trail names a person rather than "moniadmin".
 *
 * The request checks here mirror the supervisor's. They exist so a bad request
 * is refused with a useful message before it reaches a root process, not
 * because the supervisor would accept it.
 */

const net = require("net");
const { redactDeep } = require("./priv");

const SOCKET = process.env.MONI_AI_SOCKET || "/run/moni-ai/moni-ai.sock";
const MAX_TEXT = 20000;
const TABLES = ["delegations", "inbound", "approvals", "turns", "audit"];
const ACTOR_RE = /^[A-Za-z0-9._@-]{1,64}$/;

let counter = 0;

class MoniAiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || "error";
  }
}

/** Normalise a panel username into something the protocol accepts. */
function actorOf(username) {
  const a = String(username || "").replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 64);
  return ACTOR_RE.test(a) ? a : "unknown";
}

/**
 * One request, one reply.
 * Rejects with code "offline" when the supervisor is not listening.
 */
function call(op, params, actor, { timeout = 20000, socket = SOCKET } = {}) {
  return new Promise((resolve, reject) => {
    const id = "d" + ++counter;
    const s = net.createConnection(socket);
    let buf = "";
    let done = false;
    const finish = (err, data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      if (err) reject(err);
      else resolve(data);
    };
    const timer = setTimeout(() => finish(new MoniAiError("MONI AI did not answer in time", "timeout")), timeout);
    s.setEncoding("utf8");
    s.on("error", (e) =>
      finish(
        new MoniAiError(
          e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "MONI AI's supervisor is not running" : e.code === "EACCES" ? "The panel is not allowed to reach MONI AI (group moniai)" : e.message,
          e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "offline" : "error"
        )
      )
    );
    s.on("connect", () => s.write(JSON.stringify({ id, op, actor: actorOf(actor), ...(params || {}) }) + "\n"));
    s.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 16 * 1024 * 1024) return finish(new MoniAiError("reply too large"));
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch (_) {
        return finish(new MoniAiError("unreadable reply from MONI AI"));
      }
      if (msg.ok) finish(null, redactDeep(msg.data));
      else finish(new MoniAiError(msg.error || "MONI AI refused", "refused"));
    });
    s.on("close", () => finish(new MoniAiError("MONI AI closed the connection", "offline")));
  });
}

/**
 * Subscribe to the event stream. `onEvent(ev)` per event; `onEnd(err)` once.
 * Returns a function that closes the subscription.
 */
function subscribe(since, actor, onEvent, onEnd, { socket = SOCKET } = {}) {
  const s = net.createConnection(socket);
  let buf = "";
  let ended = false;
  const end = (err) => {
    if (ended) return;
    ended = true;
    s.destroy();
    onEnd && onEnd(err || null);
  };
  s.setEncoding("utf8");
  s.on("error", (e) => end(new MoniAiError(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "MONI AI's supervisor is not running" : e.message, "offline")));
  s.on("close", () => end(null));
  s.on("connect", () => {
    const req = { id: "sub" + ++counter, op: "events", actor: actorOf(actor) };
    if (Number.isInteger(since) && since > 0) req.since = since;
    s.write(JSON.stringify(req) + "\n");
  });
  s.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (msg.event) onEvent(redactDeep(msg.event));
      else if (msg.ok === false) end(new MoniAiError(msg.error || "refused", "refused"));
    }
  });
  return () => end(null);
}

/* --------------------------------------------------------- request checks --- */

function bad(msg) {
  return new MoniAiError(msg, "invalid");
}

function cleanSend(body) {
  const text = typeof body.text === "string" ? body.text : "";
  if (text.includes("\u0000")) throw bad("The message contains a NUL byte.");
  if (!text.trim()) throw bad("Say something first.");
  if (text.length > MAX_TEXT) throw bad(`Keep it under ${MAX_TEXT} characters.`);
  const out = { text: text.trim() };
  if (body.target !== undefined && body.target !== null && body.target !== "") {
    if (typeof body.target !== "string" || body.target.length > 300 || /[\r\n\u0000]/.test(body.target)) throw bad("That target is not a session name.");
    out.target = body.target.trim();
  }
  return out;
}

function cleanApprovalId(raw) {
  const s = String(raw == null ? "" : raw);
  if (!/^[1-9][0-9]{0,15}$/.test(s)) throw bad("No such approval.");
  return Number(s);
}

function cleanNote(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 500 || raw.includes("\u0000")) throw bad("Keep the note under 500 characters.");
  return raw.trim() || undefined;
}

function cleanLedger(table, query) {
  if (!TABLES.includes(table)) throw bad("No such ledger.");
  const out = { table };
  const int = (v, name, max) => {
    if (v === undefined || v === "") return undefined;
    if (!/^[0-9]{1,16}$/.test(String(v)) || Number(v) < 1 || Number(v) > max) throw bad(`${name} is not valid.`);
    return Number(v);
  };
  const limit = int(query.limit, "limit", 500);
  const before = int(query.before_id, "before_id", Number.MAX_SAFE_INTEGER);
  if (limit) out.limit = limit;
  if (before) out.before_id = before;
  if (query.status !== undefined && query.status !== "") {
    if (!/^[a-z_]{1,32}$/.test(String(query.status))) throw bad("status is not valid.");
    out.status = String(query.status);
  }
  return out;
}

function cleanSince(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return 0;
  if (!/^[0-9]{1,16}$/.test(s)) return 0;
  return Number(s);
}

module.exports = {
  SOCKET,
  MAX_TEXT,
  TABLES,
  MoniAiError,
  actorOf,
  call,
  subscribe,
  cleanSend,
  cleanApprovalId,
  cleanNote,
  cleanLedger,
  cleanSince,
};
