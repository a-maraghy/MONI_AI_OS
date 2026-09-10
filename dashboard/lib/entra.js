"use strict";
/**
 * Sign in with Microsoft, so the second factor can be an Authenticator push.
 *
 * The panel's own two-factor is TOTP, and TOTP is all a code-only app can do:
 * the "Approve sign-in?" prompt with number matching is sent by Microsoft's
 * identity platform to a phone enrolled against an Entra account, and there is
 * no API for anyone else to send one. So getting that prompt means handing the
 * sign-in itself to Entra and letting the tenant's own policy decide how the
 * person proves who they are. That is what this file does, and it is the whole
 * reason it exists.
 *
 * Written against the protocol rather than a client library: the dashboard is
 * CommonJS and the maintained OIDC clients are ESM-only, and the alternative --
 * pinning an abandoned major version to keep require() working -- is worse than
 * two hundred lines that do exactly what the spec says. Everything security
 * relevant is still checked: PKCE, state, nonce, the signature against the
 * tenant's published keys, the issuer, the audience, the tenant id, and expiry.
 *
 * What this deliberately does NOT do is create accounts. A valid token from the
 * tenant proves who somebody is at Microsoft, not that they may administer this
 * machine -- so the address has to already belong to an enabled panel user.
 * Otherwise every employee in the company becomes an administrator of a VPS the
 * moment this is switched on.
 */

const crypto = require("crypto");
const db = require("./db");

const SETTING_KEY = "entra";
const AUTHORITY = "https://login.microsoftonline.com";

/** Method references Entra reports when a second factor was actually used. */
const MFA_METHODS = new Set(["mfa", "ngcmfa", "fido", "wia", "pop", "hwk", "otp"]);

const DEFAULTS = {
  enabled: false,
  tenant_id: "",
  client_id: "",
  client_secret: "",
  // On by default. Without it, Microsoft is asked "is this person signed in"
  // and answers from a session cookie -- one click, no phone, no push. The
  // whole point here is that the phone is involved, so the prompt is forced.
  force_prompt: true,
  // Also on by default: accept the sign-in only if Microsoft says a second
  // factor was used. A tenant with no MFA policy would otherwise turn this
  // button into single-factor access to a root console.
  require_mfa: true,
  redirect_uri: "",
};

/* ------------------------------------------------------------- config ---- */

function publicOrigin() {
  const host = process.env.MONI_PUBLIC_HOST || "localhost";
  const port = String(process.env.MONI_PUBLIC_PORT || "8443");
  return "https://" + host + (port === "443" ? "" : ":" + port);
}

function defaultRedirectUri() {
  return publicOrigin() + "/auth/microsoft/callback";
}

function config() {
  const saved = db.getSetting(SETTING_KEY, {}) || {};
  const merged = { ...DEFAULTS, ...saved };
  merged.redirect_uri = merged.redirect_uri || defaultRedirectUri();
  return merged;
}

/** Everything needed to run the flow is present. */
function configured(cfg = config()) {
  return !!(cfg.tenant_id && cfg.client_id && cfg.client_secret);
}

/** Present, and switched on. This is what the login page asks. */
function active(cfg = config()) {
  return !!cfg.enabled && configured(cfg);
}

function save(patch) {
  const next = { ...config(), ...patch };
  db.setSetting(SETTING_KEY, next);
  jwksCache.clear();
  return next;
}

/**
 * The config with the secret replaced by a shape, never the value.
 *
 * A settings page has to answer "is this the secret I think it is" without
 * being a place an attacker can read one back out of.
 */
function redacted() {
  const cfg = config();
  const secret = cfg.client_secret || "";
  return {
    ...cfg,
    client_secret: "",
    secret_set: !!secret,
    secret_hint: secret ? secret.slice(0, 3) + "…" + secret.slice(-2) : "",
    secret_length: secret.length,
    configured: configured(cfg),
    active: active(cfg),
    default_redirect_uri: defaultRedirectUri(),
  };
}

/* ------------------------------------------------------------- helpers --- */

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (s) => Buffer.from(String(s), "base64url");
const random = (bytes = 32) => b64url(crypto.randomBytes(bytes));

function issuer(cfg) {
  return AUTHORITY + "/" + cfg.tenant_id + "/v2.0";
}

/* --------------------------------------------------------------- flow ---- */

/**
 * Start a sign-in: the URL to send the browser to, and the three secrets that
 * have to survive until the callback. The caller keeps those in the session --
 * they are what ties the response to this browser and this request.
 */
function begin(cfg = config()) {
  const verifier = random(32);
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = random(16);
  const nonce = random(16);

  const params = new URLSearchParams({
    client_id: cfg.client_id,
    response_type: "code",
    redirect_uri: cfg.redirect_uri,
    response_mode: "query",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (cfg.force_prompt) params.set("prompt", "login");

  return {
    url: AUTHORITY + "/" + cfg.tenant_id + "/oauth2/v2.0/authorize?" + params.toString(),
    state,
    nonce,
    verifier,
  };
}

async function exchange(cfg, code, verifier) {
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirect_uri,
    code_verifier: verifier,
    scope: "openid profile email",
  });

  const res = await fetch(AUTHORITY + "/" + cfg.tenant_id + "/oauth2/v2.0/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Microsoft's error_description carries the AADSTS code, which is the only
    // part of a failure anybody can act on. Truncated because it also carries
    // correlation ids and a trace url that turn an alert into a paragraph.
    throw new Error(
      "Microsoft rejected the sign-in: " +
        String(json.error_description || json.error || res.status).split("\n")[0].slice(0, 200)
    );
  }
  if (!json.id_token) throw new Error("Microsoft returned no id_token");
  return json;
}

/* --------------------------------------------------------------- keys ---- */

// Signing keys rotate, so they are fetched and cached rather than configured.
// A kid that is not in the cache forces one refresh -- that is what a rotation
// looks like from here -- and the short floor between refreshes keeps a token
// with a made-up kid from turning into a request to Microsoft per attempt.
const jwksCache = new Map();
const JWKS_TTL_MS = 12 * 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 60 * 1000;

async function keysFor(cfg, { refresh = false } = {}) {
  const now = Date.now();
  const hit = jwksCache.get(cfg.tenant_id);
  if (hit && !refresh && now - hit.at < JWKS_TTL_MS) return hit.keys;
  if (hit && refresh && now - hit.at < JWKS_MIN_REFRESH_MS) return hit.keys;

  const res = await fetch(
    AUTHORITY + "/" + cfg.tenant_id + "/discovery/v2.0/keys",
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error("could not fetch Microsoft's signing keys");
  const json = await res.json();
  const keys = Array.isArray(json.keys) ? json.keys : [];
  jwksCache.set(cfg.tenant_id, { at: now, keys });
  return keys;
}

async function publicKeyFor(cfg, kid) {
  for (const refresh of [false, true]) {
    const keys = await keysFor(cfg, { refresh });
    const jwk = keys.find((k) => k.kid === kid && (k.kty === "RSA" || !k.kty));
    if (jwk) {
      return crypto.createPublicKey({ key: jwk, format: "jwk" });
    }
  }
  throw new Error("the token was signed with a key this tenant does not publish");
}

/* ------------------------------------------------------------ id token --- */

/**
 * Verify an id_token and return its claims.
 *
 * The token arrived over a TLS connection this process opened to Microsoft, so
 * the signature check is not the only thing standing between us and a forged
 * token -- but everything below is cheap and each line closes a real hole, so
 * none of it is skipped on the grounds that another layer probably caught it.
 */
async function verifyIdToken(cfg, idToken, expectedNonce) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");

  const header = JSON.parse(fromB64url(parts[0]).toString("utf8"));
  const claims = JSON.parse(fromB64url(parts[1]).toString("utf8"));

  if (header.alg !== "RS256") {
    // Anything else, "none" above all, is an attempt rather than a variation.
    throw new Error("unexpected token algorithm: " + String(header.alg).slice(0, 20));
  }

  const key = await publicKeyFor(cfg, header.kid);
  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(parts[0] + "." + parts[1]),
    key,
    fromB64url(parts[2])
  );
  if (!ok) throw new Error("the token's signature did not verify");

  if (claims.iss !== issuer(cfg))
    throw new Error("the token came from a different issuer");
  // Guards a multi-tenant app registration: without it, anybody with a Microsoft
  // account anywhere could present a valid token for this client id.
  if (claims.tid && claims.tid !== cfg.tenant_id)
    throw new Error("the token came from a different tenant");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(cfg.client_id))
    throw new Error("the token was issued for a different application");

  const now = Math.floor(Date.now() / 1000);
  const skew = 120;
  if (typeof claims.exp !== "number" || claims.exp + skew < now)
    throw new Error("the token has expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now)
    throw new Error("the token is not valid yet");
  // Ties the token to the request that started this sign-in, which is what
  // stops one captured elsewhere from being replayed into this browser.
  if (!expectedNonce || claims.nonce !== expectedNonce)
    throw new Error("this response does not belong to the sign-in that started here");

  return claims;
}

/** Did Microsoft actually put a second factor in front of this sign-in? */
function usedMfa(claims) {
  const amr = Array.isArray(claims.amr) ? claims.amr : [];
  return amr.some((m) => MFA_METHODS.has(String(m).toLowerCase()));
}

/** The address to match against a panel account. */
function emailOf(claims) {
  return String(claims.preferred_username || claims.email || claims.upn || "")
    .trim()
    .toLowerCase();
}

module.exports = {
  SETTING_KEY,
  config,
  configured,
  active,
  save,
  redacted,
  defaultRedirectUri,
  begin,
  exchange,
  verifyIdToken,
  usedMfa,
  emailOf,
};
