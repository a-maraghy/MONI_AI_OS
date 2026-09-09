"use strict";
/**
 * Second-factor checks for things that are not signing in.
 *
 * Sign-in proves who you are at the start of a session. That is a different
 * question from "is the person at the keyboard right now willing to turn on
 * root", asked possibly hours later on a laptop somebody walked past. This
 * module answers the second one.
 *
 * Every accepted code is burned. Without that a code is a bearer token for its
 * whole ninety-second life: read over a shoulder, or seen once in a screen
 * share, it would still work. Burning also protects the sign-in path, where a
 * replayed code plus a known password was previously enough.
 */

const { authenticator } = require("otplib");
const { db, nowIso } = require("./db");

// RFC 6238's step, which is what every authenticator app assumes.
const STEP_SECONDS = 30;
// Rows older than this cannot match a code that is still valid, so they are
// only taking up space.
const RETENTION_SECONDS = STEP_SECONDS * 10;

db.exec(`
  CREATE TABLE IF NOT EXISTS totp_used (
    user_id INTEGER NOT NULL,
    step    INTEGER NOT NULL,
    used_at TEXT NOT NULL,
    PRIMARY KEY (user_id, step)
  );
`);

const claim = db.prepare(
  "INSERT OR IGNORE INTO totp_used (user_id, step, used_at) VALUES (?, ?, ?)"
);
const prune = db.prepare("DELETE FROM totp_used WHERE used_at < ?");

/**
 * Which time step a code belongs to, or the current one if it cannot be told.
 *
 * Falling back to the current step spends a neighbouring code early in the rare
 * case the search fails. That costs a little convenience and never safety,
 * which is the right way round for a fallback to lean.
 */
function stepOf(secret, supplied) {
  const now = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  const saved = authenticator.options;
  try {
    for (const drift of [0, -1, 1]) {
      authenticator.options = { epoch: (now + drift) * STEP_SECONDS * 1000 };
      if (authenticator.generate(secret) === supplied) return now + drift;
    }
  } catch (_) {
    /* fall through to the current step */
  } finally {
    authenticator.options = saved;
  }
  return now;
}

/**
 * Check a code for a user and spend it.
 *
 * Returns true only if the code was valid *and* had not been used. The two are
 * one operation on purpose: checking and then separately recording leaves a
 * window in which the same code passes twice.
 */
function verifyAndConsume(user, code) {
  const supplied = String(code || "").replace(/\D/g, "");
  if (supplied.length !== 6) return false;
  if (!user || !user.totp_secret) return false;

  let ok = false;
  try {
    ok = authenticator.check(supplied, user.totp_secret);
  } catch (_) {
    ok = false;
  }
  if (!ok) return false;

  // otplib says a code is valid without saying which step it belongs to, and
  // the step is what gets burned. It is recovered by generating the code for
  // each step in the accepted window and seeing which one matches -- the window
  // either side being otplib's own tolerance for a phone with a drifting clock.
  const step = stepOf(user.totp_secret, supplied);

  const inserted = claim.run(user.id, step, nowIso()).changes;
  prune.run(new Date(Date.now() - RETENTION_SECONDS * 1000).toISOString());

  return inserted === 1;
}

module.exports = { verifyAndConsume, STEP_SECONDS };
