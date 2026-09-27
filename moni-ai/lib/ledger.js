"use strict";
/**
 * The delegation ledger: SQLite at /var/lib/moni-ai/ledger.db.
 *
 * The supervisor is its only writer. Hooks do not open it; they post to the
 * supervisor's hook socket, so there is one process deciding what a delegation's
 * state is and no two writers racing over the same row.
 *
 * Tables
 *   delegations  one per SendMessage: sent -> working -> ack (replied) -> done,
 *                or held / failed / denied
 *   inbound      every cross-session message, idle notice and delivery notice
 *   approvals    every Approve / Deny card, with who answered and when
 *   turns        every turn MONI AI ran, and where it came from
 *   audit        every action taken through the socket, with the panel user
 */

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS delegations (
  id              INTEGER PRIMARY KEY,
  msg_id          TEXT UNIQUE,
  tool_use_id     TEXT,
  turn_id         INTEGER,
  target          TEXT NOT NULL,
  target_name     TEXT NOT NULL,
  target_pid      INTEGER,
  target_session  TEXT,
  text            TEXT NOT NULL,
  summary         TEXT,
  notify_idle     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  note            TEXT,
  reply_text      TEXT,
  created_at      TEXT NOT NULL,
  working_at      TEXT,
  replied_at      TEXT,
  done_at         TEXT,
  failed_at       TEXT,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS delegations_open ON delegations(status, target_pid, target_name);

CREATE TABLE IF NOT EXISTS inbound (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL,
  from_name       TEXT,
  from_pid        INTEGER,
  text            TEXT NOT NULL,
  delegation_id   INTEGER REFERENCES delegations(id),
  received_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id              INTEGER PRIMARY KEY,
  request_id      TEXT NOT NULL,
  tool_use_id     TEXT,
  turn_id         INTEGER,
  tool            TEXT NOT NULL,
  input_json      TEXT NOT NULL,
  summary         TEXT NOT NULL,
  category        TEXT,
  label           TEXT,
  reason          TEXT,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  decided_at      TEXT,
  decided_by      TEXT,
  note            TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id              INTEGER PRIMARY KEY,
  uuid            TEXT UNIQUE,
  source          TEXT NOT NULL,
  actor           TEXT,
  text            TEXT NOT NULL,
  target          TEXT,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  ended_at        TEXT,
  duration_ms     INTEGER,
  cost_usd        REAL,
  result_text     TEXT,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id              INTEGER PRIMARY KEY,
  at              TEXT NOT NULL,
  actor           TEXT NOT NULL,
  op              TEXT NOT NULL,
  detail          TEXT,
  ok              INTEGER NOT NULL,
  error           TEXT
);
`;

const now = () => new Date().toISOString();

class Ledger {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {
      /* not ours to fix if it fails */
    }
    this.q = {};
  }

  prep(sql) {
    if (!this.q[sql]) this.q[sql] = this.db.prepare(sql);
    return this.q[sql];
  }

  get(table, id) {
    return this.prep(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null;
  }

  /* ------------------------------------------------------------- turns --- */

  addTurn({ uuid, source, actor, text, target, status }) {
    const r = this.prep(
      "INSERT INTO turns (uuid, source, actor, text, target, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(uuid || null, source, actor || null, text, target || null, status || "queued", now());
    return this.get("turns", Number(r.lastInsertRowid));
  }
  turnByUuid(uuid) {
    return this.prep("SELECT * FROM turns WHERE uuid = ?").get(uuid) || null;
  }
  updateTurn(id, fields) {
    return this.update("turns", id, fields);
  }

  /* ------------------------------------------------------- delegations --- */

  addDelegation(d) {
    const t = now();
    const r = this.prep(
      `INSERT INTO delegations (msg_id, tool_use_id, turn_id, target, target_name, target_pid, target_session,
         text, summary, notify_idle, status, note, created_at, updated_at, failed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(msg_id) DO NOTHING`
    ).run(
      d.msg_id || null,
      d.tool_use_id || null,
      d.turn_id || null,
      d.target,
      d.target_name,
      d.target_pid || null,
      d.target_session || null,
      d.text,
      d.summary || null,
      d.notify_idle ? 1 : 0,
      d.status,
      d.note || null,
      t,
      t,
      d.status === "failed" || d.status === "denied" ? t : null
    );
    if (!r.changes) return this.prep("SELECT * FROM delegations WHERE msg_id = ?").get(d.msg_id) || null;
    return this.get("delegations", Number(r.lastInsertRowid));
  }

  /** Open delegations to a session, newest first. */
  openDelegationsFor({ pid, name }) {
    return this.prep(
      `SELECT * FROM delegations
        WHERE status IN ('sent', 'working', 'ack', 'held')
          AND ((? IS NOT NULL AND target_pid = ?) OR (target_name = ?))
        ORDER BY id DESC`
    ).all(pid || null, pid || null, name || "");
  }
  openDelegations() {
    return this.prep("SELECT * FROM delegations WHERE status IN ('sent', 'working', 'ack', 'held') ORDER BY id").all();
  }
  updateDelegation(id, fields) {
    return this.update("delegations", id, { ...fields, updated_at: now() });
  }

  /* ----------------------------------------------------------- inbound --- */

  addInbound({ kind, from_name, from_pid, text, delegation_id }) {
    const r = this.prep(
      "INSERT INTO inbound (kind, from_name, from_pid, text, delegation_id, received_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(kind, from_name || null, from_pid || null, text, delegation_id || null, now());
    return this.get("inbound", Number(r.lastInsertRowid));
  }

  /* --------------------------------------------------------- approvals --- */

  addApproval(a) {
    const r = this.prep(
      `INSERT INTO approvals (request_id, tool_use_id, turn_id, tool, input_json, summary, category, label, reason,
         status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(
      a.request_id,
      a.tool_use_id || null,
      a.turn_id || null,
      a.tool,
      a.input_json,
      a.summary,
      a.category || null,
      a.label || null,
      a.reason || null,
      now(),
      a.expires_at
    );
    return this.get("approvals", Number(r.lastInsertRowid));
  }
  pendingApprovals() {
    return this.prep("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all();
  }
  updateApproval(id, fields) {
    return this.update("approvals", id, fields);
  }

  /* ------------------------------------------------------------- audit --- */

  audit(actor, op, detail, ok, error) {
    this.prep("INSERT INTO audit (at, actor, op, detail, ok, error) VALUES (?, ?, ?, ?, ?, ?)").run(
      now(),
      actor,
      op,
      detail == null ? null : JSON.stringify(detail).slice(0, 4000),
      ok ? 1 : 0,
      error ? String(error).slice(0, 500) : null
    );
  }

  /* ------------------------------------------------------------- query --- */

  list(table, { limit = 50, before_id, status } = {}) {
    const col = table === "inbound" ? "kind" : "status";
    const where = [];
    const args = [];
    if (before_id) {
      where.push("id < ?");
      args.push(before_id);
    }
    if (status && table !== "audit") {
      where.push(`${col} = ?`);
      args.push(status);
    }
    const sql = `SELECT * FROM ${table} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit);
  }

  counts() {
    const one = (sql) => (this.prep(sql).get() || {}).n || 0;
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    return {
      delegations_open: one("SELECT count(*) AS n FROM delegations WHERE status IN ('sent','working','ack','held')"),
      delegations_24h: this.prep("SELECT count(*) AS n FROM delegations WHERE created_at >= ?").get(since).n,
      approvals_pending: one("SELECT count(*) AS n FROM approvals WHERE status = 'pending'"),
      turns_24h: this.prep("SELECT count(*) AS n FROM turns WHERE created_at >= ?").get(since).n,
    };
  }

  /* ----------------------------------------------------------- helpers --- */

  update(table, id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return this.get(table, id);
    for (const k of keys) if (!/^[a-z_]+$/.test(k)) throw new Error("bad column " + k);
    const sql = `UPDATE ${table} SET ${keys.map((k) => k + " = ?").join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => (fields[k] === undefined ? null : fields[k])), id);
    return this.get(table, id);
  }

  close() {
    try {
      this.db.close();
    } catch (_) {
      /* already closed */
    }
  }
}

module.exports = { Ledger, now };
