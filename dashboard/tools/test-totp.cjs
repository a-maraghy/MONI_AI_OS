/**
 * Tests for the second-factor checks in lib/totp.js.
 *
 *     node dashboard/tools/test-totp.cjs
 *
 * Runs against a scratch database, so it never touches the panel's own. The
 * cases that matter are replay and near-misses: a code that works twice would
 * make every gate built on this decorative.
 *
 * .cjs because it uses require, and some directories it may be run from declare
 * "type": "module".
 */
process.env.MONI_DATA_DIR = "/tmp/totp-test-" + Date.now();

const { authenticator } = require("otplib");
const totp = require(require("path").join(__dirname, "..", "lib", "totp.js"));

const user = { id: 1, totp_secret: authenticator.generateSecret() };
const other = { id: 2, totp_secret: authenticator.generateSecret() };

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) return console.log("ok   " + name);
  failures++;
  console.log("FAIL " + name + "  (got " + actual + ", wanted " + expected + ")");
}

const code = authenticator.generate(user.totp_secret);

check("a valid code is accepted", totp.verifyAndConsume(user, code), true);
check("the same code is refused a second time", totp.verifyAndConsume(user, code), false);
check("a third attempt is still refused", totp.verifyAndConsume(user, code), false);

check("a wrong code is refused", totp.verifyAndConsume(user, "000000"), false);
check("a short code is refused", totp.verifyAndConsume(user, "12345"), false);
check("a non-numeric code is refused", totp.verifyAndConsume(user, "abcdef"), false);
check("an empty code is refused", totp.verifyAndConsume(user, ""), false);
check("a missing user is refused", totp.verifyAndConsume(null, code), false);
check(
  "a user with no secret is refused",
  totp.verifyAndConsume({ id: 3, totp_secret: "" }, code),
  false
);

// Someone else's current code must not work here, and burning one user's code
// must not burn another's.
const otherCode = authenticator.generate(other.totp_secret);
check("another user's code is refused", totp.verifyAndConsume(user, otherCode), false);
check("that code still works for its owner", totp.verifyAndConsume(other, otherCode), true);

// Spaces are how people paste a code off a phone. A third account, so this
// does not depend on the clock having crossed a thirty-second boundary.
const spaced = { id: 4, totp_secret: authenticator.generateSecret() };
const spacedCode = authenticator.generate(spaced.totp_secret);
check(
  "a code with spaces is accepted",
  totp.verifyAndConsume(spaced, spacedCode.slice(0, 3) + " " + spacedCode.slice(3)),
  true
);
check("and the same code is then refused", totp.verifyAndConsume(spaced, spacedCode), false);

console.log(failures ? "\nFAILURES: " + failures : "\nALL TOTP TESTS PASSED");
process.exit(failures ? 1 : 0);
