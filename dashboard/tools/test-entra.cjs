/**
 * Checks that verifyIdToken refuses everything it should.
 *
 * Runs against a throwaway RSA key standing in for the tenant's, injected into
 * the JWKS cache, so nothing here touches Microsoft or the network.
 */
const crypto = require("crypto");
const path = require("path");
process.env.MONI_DATA_DIR = process.env.MONI_DATA_DIR || "/tmp/entra-test-data";
require("fs").mkdirSync(process.env.MONI_DATA_DIR, { recursive: true });

const entra = require(path.join(__dirname, "..", "lib", "entra.js"));

const TENANT = "f749d504-c247-4f5d-94d6-dbd5caa454ad";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const KID = "test-key-1";
const cfg = { tenant_id: TENANT, client_id: CLIENT, client_secret: "s", redirect_uri: "https://x/y" };

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, kty: "RSA", alg: "RS256", use: "sig" };
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

// Prime the module's JWKS cache so no fetch happens.

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(claims, { key = privateKey, header = {} } = {}) {
  const h = b64({ alg: "RS256", kid: KID, typ: "JWT", ...header });
  const p = b64(claims);
  if (header.alg === "none") return h + "." + p + ".";
  const sig = crypto.sign("RSA-SHA256", Buffer.from(h + "." + p), key).toString("base64url");
  return h + "." + p + "." + sig;
}

const now = Math.floor(Date.now() / 1000);
const good = {
  iss: "https://login.microsoftonline.com/" + TENANT + "/v2.0",
  aud: CLIENT, tid: TENANT, exp: now + 600, nbf: now - 10, iat: now - 10,
  nonce: "NONCE", preferred_username: "Amaraghy@GizaSeeds.com", amr: ["pwd", "mfa"],
};

// Stub the network: replace global fetch with the JWKS this test controls.
global.fetch = async (url) => {
  if (String(url).includes("/discovery/v2.0/keys"))
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  throw new Error("unexpected fetch: " + url);
};

let pass = 0, fail = 0;
async function check(name, fn, expect) {
  let outcome;
  try { await fn(); outcome = "accepted"; }
  catch (e) { outcome = "refused: " + e.message; }
  const ok = expect === "accept" ? outcome === "accepted" : outcome.startsWith("refused");
  console.log((ok ? "  ok   " : "  FAIL ") + name.padEnd(46) + " -> " + outcome);
  ok ? pass++ : fail++;
}

(async () => {
  await check("a well-formed token", () => entra.verifyIdToken(cfg, sign(good), "NONCE"), "accept");
  await check("signature from the wrong key", () => entra.verifyIdToken(cfg, sign(good, { key: other.privateKey }), "NONCE"), "reject");
  await check("alg: none", () => entra.verifyIdToken(cfg, sign(good, { header: { alg: "none" } }), "NONCE"), "reject");
  await check("alg: HS256 downgrade", () => entra.verifyIdToken(cfg, sign(good, { header: { alg: "HS256" } }), "NONCE"), "reject");
  await check("wrong issuer", () => entra.verifyIdToken(cfg, sign({ ...good, iss: "https://evil/v2.0" }), "NONCE"), "reject");
  await check("wrong tenant in tid", () => entra.verifyIdToken(cfg, sign({ ...good, tid: "00000000-0000-0000-0000-000000000000" }), "NONCE"), "reject");
  await check("wrong audience", () => entra.verifyIdToken(cfg, sign({ ...good, aud: "someone-else" }), "NONCE"), "reject");
  await check("expired", () => entra.verifyIdToken(cfg, sign({ ...good, exp: now - 300 }), "NONCE"), "reject");
  await check("not yet valid", () => entra.verifyIdToken(cfg, sign({ ...good, nbf: now + 600 }), "NONCE"), "reject");
  await check("nonce mismatch (replay)", () => entra.verifyIdToken(cfg, sign(good), "OTHER"), "reject");
  await check("no nonce expected", () => entra.verifyIdToken(cfg, sign(good), ""), "reject");
  await check("unknown signing key id", () => entra.verifyIdToken(cfg, sign(good, { header: { kid: "nope" } }), "NONCE"), "reject");
  await check("garbage", () => entra.verifyIdToken(cfg, "not.a.token", "NONCE"), "reject");

  const claims = await entra.verifyIdToken(cfg, sign(good), "NONCE");
  const t = (name, got, want) => {
    const ok = got === want;
    console.log((ok ? "  ok   " : "  FAIL ") + name.padEnd(46) + " -> " + JSON.stringify(got));
    ok ? pass++ : fail++;
  };
  t("email is lower-cased for matching", entra.emailOf(claims), "amaraghy@gizaseeds.com");
  t("amr [pwd, mfa] counts as MFA", entra.usedMfa(claims), true);
  t("amr [pwd] alone does not", entra.usedMfa({ amr: ["pwd"] }), false);
  t("missing amr does not", entra.usedMfa({}), false);

  console.log("\n" + (fail ? "FAILED: " + fail : "ALL ENTRA TESTS PASSED") + " (" + pass + " passed)");
  process.exit(fail ? 1 : 0);
})();
