"use strict";
/**
 * SQLite state: users and roles, pairing codes, and a login log.
 *
 * The panel began single-user, with one row in an `admin` table. That table is
 * still read once, at first boot after this upgrade, to carry the existing
 * account into `users` as an administrator -- nobody should have to re-enrol
 * their authenticator because the schema grew.
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const rbac = require("./rbac");

const DATA_DIR = process.env.MONI_DATA_DIR || "/var/lib/moni-dashboard";
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "moni.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS admin (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret   TEXT NOT NULL,
    totp_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS roles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    builtin       INTEGER NOT NULL DEFAULT 0,
    permissions   TEXT NOT NULL DEFAULT '[]',
    agent_scope   TEXT NOT NULL DEFAULT '*',
    channel_scope TEXT NOT NULL DEFAULT '*',
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE,
    display_name   TEXT NOT NULL DEFAULT '',
    password_hash  TEXT NOT NULL,
    totp_secret    TEXT NOT NULL,
    totp_confirmed INTEGER NOT NULL DEFAULT 0,
    role_id        INTEGER NOT NULL REFERENCES roles(id),
    disabled       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    created_by     TEXT,
    last_login_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS pairing_codes (
    code        TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    target_user TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    used_by_fp  TEXT
  );

  CREATE TABLE IF NOT EXISTS devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL,
    target_user TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    paired_at   TEXT NOT NULL,
    paired_ip   TEXT
  );

  -- The panel's own chats with Claude Code. One row per conversation; the
  -- uuid column is Claude's own session id, which is what --resume takes, so
  -- the CLI keeps the real history and this table keeps what to show and how
  -- the session is configured.
  CREATE TABLE IF NOT EXISTS console_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid        TEXT NOT NULL UNIQUE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'New chat',
    model       TEXT NOT NULL DEFAULT 'claude-opus-5',
    effort      TEXT NOT NULL DEFAULT 'medium',
    access      TEXT NOT NULL DEFAULT 'full',
    permission_mode TEXT NOT NULL DEFAULT 'auto',
    cwd         TEXT NOT NULL DEFAULT '/',
    started     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS console_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES console_sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    meta        TEXT,
    ts          TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS console_messages_session
    ON console_messages(session_id, id);

  CREATE TABLE IF NOT EXISTS login_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    ip         TEXT,
    username   TEXT,
    outcome    TEXT NOT NULL,
    detail     TEXT
  );
`);

const nowIso = () => new Date().toISOString();

/**
 * Add a column to a table that already exists.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that is already there, so
 * a column added to the schema above reaches new installs and no others. This
 * is how it reaches the rest, and it is written to be safe to run every start.
 */
function addColumn(table, column, definition) {
  const has = db
    .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`)
    .get(table, column).n;
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn("console_sessions", "permission_mode", "TEXT NOT NULL DEFAULT 'auto'");
addColumn("console_sessions", "archived", "INTEGER NOT NULL DEFAULT 0");

/* --------------------------------------------------------------- roles --- */

function roleRow(r) {
  if (!r) return null;
  let permissions = [];
  try {
    const parsed = JSON.parse(r.permissions);
    if (Array.isArray(parsed)) permissions = parsed;
  } catch (_) {
    /* a corrupt row grants nothing rather than everything */
  }
  return { ...r, permissions, builtin: !!r.builtin };
}

function seedRoles() {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO roles
       (name, label, description, builtin, permissions, agent_scope, channel_scope, created_at)
     VALUES (@name, @label, @description, @builtin, @permissions, @agent_scope, @channel_scope, @created_at)`
  );
  for (const r of rbac.SYSTEM_ROLES) {
    insert.run({ ...r, permissions: JSON.stringify(r.permissions), created_at: nowIso() });
  }
}

/**
 * Carry the pre-RBAC single admin into `users`. Runs once: afterwards `users`
 * is non-empty. The old `admin` row is left in place rather than deleted, so
 * rolling back to the previous release still finds its account.
 */
function migrateLegacyAdmin() {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  if (n > 0) return;
  const legacy = db.prepare("SELECT * FROM admin WHERE id = 1").get();
  if (!legacy) return;
  const role = db.prepare("SELECT id FROM roles WHERE name = 'administrator'").get();
  db.prepare(
    `INSERT INTO users
       (username, display_name, password_hash, totp_secret, totp_confirmed,
        role_id, disabled, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'migration')`
  ).run(
    legacy.username,
    legacy.username,
    legacy.password_hash,
    legacy.totp_secret,
    legacy.totp_confirmed,
    role.id,
    legacy.created_at || nowIso()
  );
}

seedRoles();
migrateLegacyAdmin();

/* --------------------------------------------------------------- users --- */

const USER_SELECT = `
  SELECT u.*, r.name AS role_name, r.label AS role_label, r.builtin AS role_builtin,
         r.permissions AS role_permissions, r.agent_scope, r.channel_scope
    FROM users u JOIN roles r ON r.id = u.role_id`;

function userRow(u) {
  if (!u) return null;
  const role = roleRow({
    id: u.role_id,
    name: u.role_name,
    label: u.role_label,
    builtin: u.role_builtin,
    permissions: u.role_permissions,
    agent_scope: u.agent_scope,
    channel_scope: u.channel_scope,
  });
  return { ...u, disabled: !!u.disabled, totp_confirmed: !!u.totp_confirmed, role };
}

module.exports = {
  db,
  nowIso,

  /* --- bootstrap ------------------------------------------------------- */

  userCount: () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n,

  /* --- users ----------------------------------------------------------- */

  listUsers: () =>
    db.prepare(USER_SELECT + " ORDER BY u.username").all().map(userRow),

  getUser: (id) => userRow(db.prepare(USER_SELECT + " WHERE u.id = ?").get(id)),

  getUserByName: (username) =>
    userRow(db.prepare(USER_SELECT + " WHERE u.username = ?").get(username)),

  createUser: ({ username, displayName, passwordHash, totpSecret, roleId, createdBy }) =>
    db
      .prepare(
        `INSERT INTO users
           (username, display_name, password_hash, totp_secret, totp_confirmed,
            role_id, disabled, created_at, created_by)
         VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)`
      )
      .run(username, displayName || username, passwordHash, totpSecret, roleId, nowIso(), createdBy || null),

  updateUser: (id, { displayName, roleId, disabled }) =>
    db
      .prepare("UPDATE users SET display_name = ?, role_id = ?, disabled = ? WHERE id = ?")
      .run(displayName, roleId, disabled ? 1 : 0, id),

  setUserPassword: (id, passwordHash) =>
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id),

  /** Used both at enrolment and when an admin resets a lost authenticator. */
  setUserTotp: (id, secret, confirmed) =>
    db
      .prepare("UPDATE users SET totp_secret = ?, totp_confirmed = ? WHERE id = ?")
      .run(secret, confirmed ? 1 : 0, id),

  confirmUserTotp: (id) =>
    db.prepare("UPDATE users SET totp_confirmed = 1 WHERE id = ?").run(id),

  touchUserLogin: (id) =>
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), id),

  deleteUser: (id) => db.prepare("DELETE FROM users WHERE id = ?").run(id),

  /** How many enabled administrators remain — the last-admin guard. */
  countActiveAdmins: () =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
          WHERE r.name = 'administrator' AND u.disabled = 0`
      )
      .get().n,

  /* --- roles ----------------------------------------------------------- */

  listRoles: () =>
    db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
           FROM roles r ORDER BY r.builtin DESC, r.label`
      )
      .all()
      .map(roleRow),

  getRole: (id) => roleRow(db.prepare("SELECT * FROM roles WHERE id = ?").get(id)),

  getRoleByName: (name) => roleRow(db.prepare("SELECT * FROM roles WHERE name = ?").get(name)),

  createRole: ({ name, label, description, permissions, agentScope, channelScope }) =>
    db
      .prepare(
        `INSERT INTO roles (name, label, description, builtin, permissions,
                            agent_scope, channel_scope, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
      )
      .run(name, label, description || "", JSON.stringify(permissions), agentScope, channelScope, nowIso()),

  updateRole: (id, { label, description, permissions, agentScope, channelScope }) =>
    db
      .prepare(
        `UPDATE roles SET label = ?, description = ?, permissions = ?,
                          agent_scope = ?, channel_scope = ?
          WHERE id = ? AND builtin = 0`
      )
      .run(label, description || "", JSON.stringify(permissions), agentScope, channelScope, id),

  deleteRole: (id) => db.prepare("DELETE FROM roles WHERE id = ? AND builtin = 0").run(id),

  roleUserCount: (id) =>
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role_id = ?").get(id).n,

  /* --- pairing & devices ----------------------------------------------- */

  createPairingCode: (code, label, targetUser, expiresAt) =>
    db
      .prepare(
        `INSERT INTO pairing_codes (code, label, target_user, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(code, label, targetUser, nowIso(), expiresAt),

  getPairingCode: (code) =>
    db.prepare("SELECT * FROM pairing_codes WHERE code = ?").get(code),

  consumePairingCode: (code, fingerprint) =>
    db
      .prepare("UPDATE pairing_codes SET used_at = ?, used_by_fp = ? WHERE code = ?")
      .run(nowIso(), fingerprint, code),

  listPairingCodes: () =>
    db.prepare("SELECT * FROM pairing_codes ORDER BY created_at DESC LIMIT 50").all(),

  deletePairingCode: (code) =>
    db.prepare("DELETE FROM pairing_codes WHERE code = ?").run(code),

  addDevice: (label, targetUser, fingerprint, ip) =>
    db
      .prepare(
        `INSERT INTO devices (label, target_user, fingerprint, paired_at, paired_ip)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(label, targetUser, fingerprint, nowIso(), ip),

  listDevices: () => db.prepare("SELECT * FROM devices ORDER BY paired_at DESC").all(),

  deleteDeviceByFp: (fingerprint) =>
    db.prepare("DELETE FROM devices WHERE fingerprint = ?").run(fingerprint),

  /* --- console ---------------------------------------------------------- */

  /**
   * A user's chats, newest first.
   *
   * Archived ones are a separate call rather than a flag on the rows: the
   * sidebar shows them in their own place, and asking for "the chats" should
   * not hand back a pile the caller has to sort out.
   */
  listConsoleSessions: (userId, { archived = false, limit = 200 } = {}) =>
    db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM console_messages m WHERE m.session_id = s.id) AS message_count
           FROM console_sessions s
          WHERE s.user_id = ? AND s.archived = ?
          ORDER BY s.updated_at DESC LIMIT ?`
      )
      .all(userId, archived ? 1 : 0, limit),

  countArchivedConsoleSessions: (userId) =>
    db
      .prepare("SELECT COUNT(*) AS n FROM console_sessions WHERE user_id = ? AND archived = 1")
      .get(userId).n,

  /** Scoped by user: one administrator's chats are not another's to read. */
  getConsoleSession: (id, userId) =>
    db
      .prepare("SELECT * FROM console_sessions WHERE id = ? AND user_id = ?")
      .get(id, userId),

  createConsoleSession: ({ uuid, userId, model, effort, access, cwd }) =>
    db
      .prepare(
        `INSERT INTO console_sessions
           (uuid, user_id, title, model, effort, access, cwd, permission_mode,
            started, created_at, updated_at)
         VALUES (?, ?, 'New chat', ?, ?, ?, ?, 'auto', 0, ?, ?)`
      )
      .run(uuid, userId, model, effort, access, cwd, nowIso(), nowIso()),

  updateConsoleSession: (id, userId, fields) => {
    const allowed = [
      "title",
      "model",
      "effort",
      "access",
      "cwd",
      "started",
      "permission_mode",
      "archived",
    ];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    db.prepare(
      `UPDATE console_sessions SET ${sets}, updated_at = @updated_at
        WHERE id = @id AND user_id = @user_id`
    ).run({ ...fields, id, user_id: userId, updated_at: nowIso() });
  },

  /**
   * Record the conversation id Claude actually created.
   *
   * Kept apart from updateConsoleSession because this is not a preference: it
   * is the identity of the conversation, and the only thing --resume will
   * accept later.
   */
  setConsoleSessionUuid: (id, userId, uuid) =>
    db
      .prepare("UPDATE console_sessions SET uuid = ? WHERE id = ? AND user_id = ?")
      .run(uuid, id, userId),

  deleteConsoleSession: (id, userId) =>
    db
      .prepare("DELETE FROM console_sessions WHERE id = ? AND user_id = ?")
      .run(id, userId),

  listConsoleMessages: (sessionId, limit = 400) =>
    db
      .prepare(
        `SELECT * FROM console_messages WHERE session_id = ?
          ORDER BY id DESC LIMIT ?`
      )
      .all(sessionId, limit)
      .reverse(),

  addConsoleMessage: (sessionId, role, content, meta) =>
    db
      .prepare(
        "INSERT INTO console_messages (session_id, role, content, meta, ts) VALUES (?, ?, ?, ?, ?)"
      )
      .run(sessionId, role, content, meta ? JSON.stringify(meta) : null, nowIso()),

  /* --- log -------------------------------------------------------------- */

  logLogin: (ip, username, outcome, detail) =>
    db
      .prepare("INSERT INTO login_log (ts, ip, username, outcome, detail) VALUES (?, ?, ?, ?, ?)")
      .run(nowIso(), ip, username, outcome, detail || null),

  recentLogins: (n = 25) =>
    db.prepare("SELECT * FROM login_log ORDER BY id DESC LIMIT ?").all(n),
};
