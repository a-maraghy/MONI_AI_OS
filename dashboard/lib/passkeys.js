"use strict";
/**
 * Passkeys (WebAuthn) as the second sign-in step: Windows Hello's face,
 * fingerprint or PIN on a trusted device, instead of typing the authenticator
 * code.
 *
 * The authenticator (TOTP) stays. It is still enrolled for every account, it
 * is offered on every sign-in ("Use authenticator code instead"), and it is
 * what root unlock and approvals ask for -- those are not touched by this
 * module. A passkey only ever replaces the code at sign-in, after the password.
 *
 * A passkey belongs to one domain (its RP ID), so one registered on
 * os.mint-stack.com does nothing at vmi3567127.contaboserver.net. The RP comes
 * from the request's Host header -- the raw header, not Express's hostname,
 * which honours X-Forwarded-Host and so would take a value the client chose --
 * and only when that host is on the allow-list. Anything else gets no passkeys
 * at all, and the code works as before.
 *
 * Allow-list: MONI_PASSKEY_ORIGINS, comma-separated origins. The RP ID is each
 * origin's hostname and the origin is what clientDataJSON must carry exactly.
 */

const crypto = require("crypto");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const { db, nowIso } = require("./db");

const DEFAULT_ORIGINS = ["https://os.mint-stack.com", "https://vmi3567127.contaboserver.net:8443"];
const RP_NAME = "Mint OS";
// A challenge outlives the browser's own prompt (60 s) a little, and no more.
const CHALLENGE_MS = 2 * 60 * 1000;
// EdDSA, ES256, RS256: what Windows Hello, security keys and phones use. The
// library's default list now includes post-quantum algorithms nothing here
// needs, and a narrower list is less to trust.
const ALGORITHMS = [-8, -7, -257];
const NAME_MAX = 60;

db.exec(`
  CREATE TABLE IF NOT EXISTS passkeys (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,      -- base64url, as the browser sends it
    public_key    BLOB NOT NULL,             -- COSE key
    counter       INTEGER NOT NULL DEFAULT 0,
    transports    TEXT NOT NULL DEFAULT '[]',
    rp_id         TEXT NOT NULL,             -- the domain it was registered for
    name          TEXT NOT NULL,
    aaguid        TEXT NOT NULL DEFAULT '',
    device_type   TEXT NOT NULL DEFAULT '',  -- singleDevice | multiDevice
    backed_up     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS passkeys_user_rp ON passkeys(user_id, rp_id);

  -- WebAuthn's user handle: random, stable per account, so registering the
  -- same device twice replaces its entry rather than adding a second one, and
  -- never the database id, which would tell an authenticator nothing it needs.
  CREATE TABLE IF NOT EXISTS passkey_handles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    handle  TEXT NOT NULL UNIQUE
  );
`);

/* -------------------------------------------------------- relying party --- */

function parseOrigins(raw) {
  const list = String(raw == null ? "" : raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const o of list.length ? list : DEFAULT_ORIGINS) {
    try {
      const u = new URL(o);
      if (!/^https?:$/.test(u.protocol)) continue;
      out.push({ rpID: u.hostname.toLowerCase(), origin: u.origin });
    } catch (_) {
      /* a malformed entry is skipped, not trusted */
    }
  }
  return out;
}

let RPS = parseOrigins(process.env.MONI_PASSKEY_ORIGINS);

/** For tests: replace the allow-list. */
function configure(origins) {
  RPS = parseOrigins(Array.isArray(origins) ? origins.join(",") : origins);
}

/** The hostname in the raw Host header, lower case, without a port. */
function hostOf(req) {
  const h = String((req && req.headers && req.headers.host) || "").trim().toLowerCase();
  if (!h || h.length > 255) return "";
  const m = h.match(/^\[[^\]]+\]|^[^:]+/); // [ipv6] or name
  return m ? m[0] : "";
}

/** {rpID, origin} for this request, or null when its host is not allowed. */
function rpFor(req) {
  const host = hostOf(req);
  return RPS.find((r) => r.rpID === host) || null;
}

const allowedHosts = () => RPS.map((r) => r.rpID);
/** The main address, for "open it there" hints. */
const primaryOrigin = () => (RPS[0] ? RPS[0].origin : null);

/* -------------------------------------------------------------- storage --- */

function row(r) {
  if (!r) return null;
  let transports = [];
  try {
    transports = JSON.parse(r.transports || "[]");
  } catch (_) {
    transports = [];
  }
  return { ...r, transports, backed_up: !!r.backed_up };
}

function handleFor(userId) {
  const got = db.prepare("SELECT handle FROM passkey_handles WHERE user_id = ?").get(userId);
  if (got) return got.handle;
  const handle = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO passkey_handles (user_id, handle) VALUES (?, ?)").run(userId, handle);
  return handle;
}

/** Every passkey of a user (rpID given: only those for that domain), newest first. */
function listFor(userId, rpID) {
  const rows = rpID
    ? db.prepare("SELECT * FROM passkeys WHERE user_id = ? AND rp_id = ? ORDER BY id DESC").all(userId, rpID)
    : db.prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY id DESC").all(userId);
  return rows.map(row);
}

const countFor = (userId, rpID) =>
  rpID
    ? db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ? AND rp_id = ?").get(userId, rpID).n
    : db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").get(userId).n;

const getOwn = (userId, id) => row(db.prepare("SELECT * FROM passkeys WHERE id = ? AND user_id = ?").get(Number(id), userId));

function cleanName(name, fallback) {
  const s = String(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
  return s || String(fallback || "Passkey").slice(0, NAME_MAX);
}

function rename(userId, id, name) {
  const pk = getOwn(userId, id);
  if (!pk) return null;
  const n = cleanName(name, pk.name);
  db.prepare("UPDATE passkeys SET name = ? WHERE id = ?").run(n, pk.id);
  return { ...pk, name: n };
}

function remove(userId, id) {
  const pk = getOwn(userId, id);
  if (!pk) return null;
  db.prepare("DELETE FROM passkeys WHERE id = ?").run(pk.id);
  return pk;
}

/** An administrator's 2FA reset: every passkey of the account goes. Returns how many. */
function clearFor(userId) {
  return db.prepare("DELETE FROM passkeys WHERE user_id = ?").run(userId).changes;
}

/* ----------------------------------------------------------- ceremonies --- */

/**
 * Challenges live in the caller's session object (`slot`), one at a time, and
 * are taken out before they are checked: a second attempt with the same
 * challenge finds nothing, whatever happened to the first.
 */
// Every challenge handed out and not yet spent, process-wide. The session copy
// says which one this browser is answering; this map is what makes it
// single-use even when two requests from the same session arrive together and
// both load the session before either has saved it.
const ISSUED = new Map(); // value -> {purpose, rpID, at}

function issue(slot, purpose, rp, value) {
  const now = Date.now();
  for (const [k, v] of ISSUED) if (now - v.at > CHALLENGE_MS) ISSUED.delete(k);
  if (ISSUED.size > 5000) ISSUED.clear(); // a flood empties it rather than growing it
  ISSUED.set(value, { purpose, rpID: rp.rpID, at: now });
  slot.challenge = { value, purpose, rpID: rp.rpID, at: now };
}

function takeChallenge(slot, rp, purpose) {
  const c = slot && slot.challenge;
  if (slot) delete slot.challenge;
  if (!c || !c.value || !(c.at > 0)) return { error: "no challenge (it was used already, or never issued)" };
  const live = ISSUED.get(c.value);
  // Synchronous get-and-delete: only one request can get past this line.
  if (!live || !ISSUED.delete(c.value)) return { error: "challenge already used" };
  if (live.purpose !== purpose || c.purpose !== purpose) return { error: "challenge was issued for something else" };
  if (Date.now() - c.at > CHALLENGE_MS) return { error: "challenge expired" };
  if (!rp || c.rpID !== rp.rpID) return { error: "challenge was issued for another address" };
  return { challenge: c.value };
}

/** Options for navigator.credentials.create(); the challenge goes into `slot`. */
async function registrationOptions(user, rp, slot) {
  const existing = listFor(user.id, rp.rpID);
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: user.email || user.username,
    userDisplayName: user.display_name || user.username,
    userID: Buffer.from(handleFor(user.id), "base64url"),
    attestationType: "none",
    timeout: 60000,
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports })),
    // Discoverable, because the sign-in request names no credentials (see
    // loginOptions). Windows Hello always makes one; a key that cannot is
    // refused here rather than accepted and then never offered at sign-in.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: ALGORITHMS,
  });
  // Windows Hello first, without refusing a security key: a hint, not
  // authenticatorAttachment "platform" (which would hard-block keys).
  opts.hints = ["client-device"];
  issue(slot, "register", rp, opts.challenge);
  return opts;
}

/** Verify a registration and store it. Returns {ok, passkey} or {ok: false, error}. */
async function verifyRegistration(user, rp, slot, response, name) {
  const t = takeChallenge(slot, rp, "register");
  if (t.error) return { ok: false, error: t.error };
  let v;
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge: t.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  if (!v || !v.verified || !v.registrationInfo) return { ok: false, error: "not verified" };
  const info = v.registrationInfo;
  const cred = info.credential;
  if (db.prepare("SELECT 1 FROM passkeys WHERE credential_id = ?").get(cred.id))
    return { ok: false, error: "this passkey is already registered" };
  const ins = db
    .prepare(
      `INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, rp_id, name,
                             aaguid, device_type, backed_up, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      user.id,
      cred.id,
      Buffer.from(cred.publicKey),
      cred.counter || 0,
      JSON.stringify(Array.isArray(cred.transports) ? cred.transports.slice(0, 8) : []),
      rp.rpID,
      cleanName(name, "Passkey"),
      String(info.aaguid || ""),
      String(info.credentialDeviceType || ""),
      info.credentialBackedUp ? 1 : 0,
      nowIso()
    );
  return { ok: true, passkey: getOwn(user.id, ins.lastInsertRowid) };
}

/**
 * Options for navigator.credentials.get() at sign-in.
 *
 * They name no credentials (a discoverable-credential request) and do not
 * depend on who is signing in, so the page and the prompt are identical for a
 * right password, a wrong one and an unknown user -- the second step must not
 * become a way to test a password. The browser offers whatever passkey it holds
 * for this domain; the answer is then checked against the account the password
 * named.
 */
async function loginOptions(rp, slot) {
  const opts = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: [],
    userVerification: "required",
    timeout: 60000,
  });
  opts.hints = ["client-device"];
  issue(slot, "login", rp, opts.challenge);
  return opts;
}

/** Spend whatever challenge this slot holds without checking anything. */
function discardChallenge(slot) {
  const c = slot && slot.challenge;
  if (c && c.value) ISSUED.delete(c.value);
  if (slot) delete slot.challenge;
}

/**
 * Verify a sign-in assertion. The credential must be this user's and
 * registered for this domain; origin, RP ID, user verification and the sign
 * counter are checked by the library, the counter again here. Returns
 * {ok, passkey} or {ok: false, error}.
 */
async function verifyAuthentication(user, rp, slot, response) {
  const t = takeChallenge(slot, rp, "login");
  if (t.error) return { ok: false, error: t.error };
  const id = response && typeof response.id === "string" ? response.id : "";
  const pk = row(db.prepare("SELECT * FROM passkeys WHERE credential_id = ? AND user_id = ?").get(id, user.id));
  if (!pk) return { ok: false, error: "unknown passkey" };
  if (pk.rp_id !== rp.rpID) return { ok: false, error: "passkey belongs to another address" };
  // The user handle the authenticator stored must be this account's.
  const uh = response.response && response.response.userHandle;
  if (uh && uh !== handleFor(user.id)) return { ok: false, error: "passkey is for another account" };
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: t.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: { id: pk.credential_id, publicKey: new Uint8Array(pk.public_key), counter: pk.counter, transports: pk.transports },
    });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200), passkey: pk };
  }
  if (!v || !v.verified) return { ok: false, error: "not verified", passkey: pk };
  const next = v.authenticationInfo.newCounter;
  // The library refuses a counter that did not move forward; kept here too so
  // a library change cannot quietly drop the clone check. Both zero is an
  // authenticator that does not count (allowed by the spec).
  if ((next > 0 || pk.counter > 0) && !(next > pk.counter))
    return { ok: false, error: "sign counter went backwards (possible cloned passkey)", passkey: pk };
  db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(next, nowIso(), pk.id);
  return { ok: true, passkey: { ...pk, counter: next } };
}

module.exports = {
  configure,
  rpFor,
  hostOf,
  allowedHosts,
  primaryOrigin,
  listFor,
  countFor,
  rename,
  remove,
  clearFor,
  cleanName,
  registrationOptions,
  verifyRegistration,
  loginOptions,
  discardChallenge,
  verifyAuthentication,
  CHALLENGE_MS,
  NAME_MAX,
};
