"use strict";
/** SQLite state: the single admin account, pairing codes, and a login log. */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = process.env.MONI_DATA_DIR || "/var/lib/moni-dashboard";
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "moni.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS admin (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret   TEXT NOT NULL,
    totp_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
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

module.exports = {
  db,
  nowIso,

  getAdmin: () => db.prepare("SELECT * FROM admin WHERE id = 1").get(),

  createAdmin: (username, passwordHash, totpSecret) =>
    db
      .prepare(
        `INSERT INTO admin (id, username, password_hash, totp_secret, totp_confirmed, created_at)
         VALUES (1, ?, ?, ?, 0, ?)`
      )
      .run(username, passwordHash, totpSecret, nowIso()),

  confirmTotp: () =>
    db.prepare("UPDATE admin SET totp_confirmed = 1 WHERE id = 1").run(),

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
    db
      .prepare("SELECT * FROM pairing_codes ORDER BY created_at DESC LIMIT 50")
      .all(),

  deletePairingCode: (code) =>
    db.prepare("DELETE FROM pairing_codes WHERE code = ?").run(code),

  addDevice: (label, targetUser, fingerprint, ip) =>
    db
      .prepare(
        `INSERT INTO devices (label, target_user, fingerprint, paired_at, paired_ip)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(label, targetUser, fingerprint, nowIso(), ip),

  listDevices: () =>
    db.prepare("SELECT * FROM devices ORDER BY paired_at DESC").all(),

  deleteDeviceByFp: (fingerprint) =>
    db.prepare("DELETE FROM devices WHERE fingerprint = ?").run(fingerprint),

  logLogin: (ip, username, outcome, detail) =>
    db
      .prepare(
        "INSERT INTO login_log (ts, ip, username, outcome, detail) VALUES (?, ?, ?, ?, ?)"
      )
      .run(nowIso(), ip, username, outcome, detail || null),

  recentLogins: (n = 25) =>
    db.prepare("SELECT * FROM login_log ORDER BY id DESC LIMIT ?").all(n),
};
