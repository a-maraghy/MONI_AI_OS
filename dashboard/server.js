"use strict";
/**
 * MONI VPS admin dashboard.
 *
 * Listens on 127.0.0.1 only; nginx terminates TLS on :8443 and proxies here.
 * Never run this process as root -- privileged work goes through lib/priv.js.
 */

const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const argon2 = require("argon2");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");

const db = require("./lib/db");
const priv = require("./lib/priv");
const catalog = require("./lib/catalog");
const telegram = require("./lib/telegram");
const views = require("./lib/views");
const agentViews = require("./lib/views-agents");
const channelViews = require("./lib/views-channels");
const serviceViews = require("./lib/views-services");
const firewallViews = require("./lib/views-firewall");
const credentialViews = require("./lib/views-credentials");
const addonViews = require("./lib/views-addons");
const guideViews = require("./lib/views-guide");
const accessViews = require("./lib/views-access");
const consoleViews = require("./lib/views-console");
const rbac = require("./lib/rbac");
const totp = require("./lib/totp");

const PORT = Number(process.env.MONI_PORT || 3000);
const BIND = process.env.MONI_BIND || "127.0.0.1";
const DATA_DIR = process.env.MONI_DATA_DIR || "/var/lib/moni-dashboard";
const LOG_DIR = process.env.MONI_LOG_DIR || "/var/log/moni-dashboard";
const PUBLIC_HOST = process.env.MONI_PUBLIC_HOST || "vmi3567127.contaboserver.net";
const PUBLIC_PORT = process.env.MONI_PUBLIC_PORT || "8443";

fs.mkdirSync(LOG_DIR, { recursive: true });
const AUTH_LOG = path.join(LOG_DIR, "auth.log");

/**
 * fail2ban watches this file. Keep the format stable -- the filter regex in
 * /etc/fail2ban/filter.d/moni-dashboard.conf depends on it.
 */
function logAuthFailure(ip, reason) {
  const line = `${new Date().toISOString()} moni-dashboard: authentication failure from ${ip} (${reason})\n`;
  fs.appendFile(AUTH_LOG, line, () => {});
}

const app = express();

// nginx is the only thing talking to us, and it is on loopback. Trusting just
// loopback means X-Forwarded-For gives us the real client IP without letting a
// remote client spoof it.
app.set("trust proxy", "loopback");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"], // data: is needed for the TOTP QR code
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  })
);

app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use(express.json({ limit: "64kb" }));
// Long-lived, because every reference carries a stamp that changes when the
// file does (see asset() in lib/ui.js). The previous hour-long cache with plain
// URLs meant a deployed stylesheet reached a browser that already had the old
// one only when that hour was up -- so a fix could look like it had not shipped.
app.use(
  "/static",
  express.static(path.join(__dirname, "public"), {
    maxAge: "30d",
    setHeaders: (res, filePath) => {
      // A request without a stamp is a bookmark or a hand-typed URL, and must
      // not be cached for a month under a name that will not change.
      if (!/[?&]v=/.test(res.req.originalUrl || "")) {
        res.setHeader("Cache-Control", "public, max-age=300");
      }
    },
  })
);

// Browsers and bookmark managers ask for /favicon.ico at the root regardless of
// what the document declares, so serve it there rather than let it 404 on every
// page load. Public on purpose: it is a logo, and requiring a session for it
// would put a 302 in the console instead of a 404.
app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "favicon.ico"), {
    maxAge: "7d",
    headers: { "Content-Type": "image/x-icon" },
  });
});

app.use(
  session({
    store: new SQLiteStore({ db: "sessions.db", dir: DATA_DIR }),
    secret: loadOrCreateSessionSecret(),
    name: "moni.sid",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: true, // we are always behind TLS
      sameSite: "strict",
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

function loadOrCreateSessionSecret() {
  const p = path.join(DATA_DIR, "session.secret");
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch (_) {
    const secret = crypto.randomBytes(48).toString("hex");
    fs.writeFileSync(p, secret, { mode: 0o600 });
    return secret;
  }
}

/**
 * Pages are never cached.
 *
 * Everything here is behind a session and specific to who is asking, so a
 * cached copy is both wrong for the next person and stale for this one. It also
 * kept the fix for a visual bug from arriving: the page came from cache, so it
 * carried the old stylesheet URL, so the new stylesheet was never asked for --
 * and the bug looked unfixed twice over.
 *
 * Static files are served before this and keep their own long, stamped cache.
 */
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  next();
});

/* ---------------------------------------------------------------- CSRF ---- */

app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString("hex");
  res.locals.csrf = req.session.csrf;
  next();
});

function requireCsrf(req, res, next) {
  const supplied = req.body && req.body._csrf;
  if (!supplied || supplied !== req.session.csrf) {
    return res.status(403).send(views.error("Request rejected", "Invalid CSRF token. Reload the page and try again."));
  }
  next();
}

/* ---------------------------------------------------------------- auth ---- */

/**
 * Resolve the signed-in user on every request rather than trusting the session
 * copy. A role edit, a disabled account, or a deleted user has to take effect
 * on the very next request -- caching permissions in the session would leave a
 * revoked operator holding their old powers until they happened to sign out.
 */
function loadActor(req, res, next) {
  req.me = null;
  req.perm = rbac.actor(null);
  if (req.session && req.session.authed && req.session.userId) {
    const me = db.getUser(req.session.userId);
    if (!me || me.disabled) {
      // `revoked` is a flag, not a message: anything rendered on the sign-in
      // page that came out of a URL is text an attacker can put in front of
      // someone who is about to type their password.
      return req.session.destroy(() => res.redirect("/login?revoked=1"));
    }
    req.me = me;
    req.perm = rbac.actor(me.role);
  }
  next();
}
app.use(loadActor);

function requireAuth(req, res, next) {
  if (req.me) return next();
  return res.redirect("/login");
}

/** The viewer context every view forwards into the page shell. */
function ctx(req, dash) {
  return {
    name: req.me ? req.me.display_name || req.me.username : "",
    roleLabel: req.me && req.me.role ? req.me.role.label : null,
    perm: req.perm,
    dash: dash || null,
  };
}

/**
 * Guard a route with a permission. Denial renders a page rather than a bare
 * 403: the person hitting it is signed in and legitimate, and "your role does
 * not include this" is a far more actionable answer than a status code.
 */
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.me) return res.redirect("/login");
    if (req.perm.can(perm)) return next();
    return res
      .status(403)
      .send(accessViews.denied({ csrf: res.locals.csrf, user: ctx(req), perm }));
  };
}

/**
 * Scope guard for the per-agent and per-channel routes. Out-of-scope resources
 * are reported as absent rather than forbidden -- telling someone an agent
 * exists but is not theirs leaks the fleet's shape to a role that was
 * deliberately narrowed.
 */
function requireAgentScope(req, res, next) {
  if (req.perm.seesAgent(req.params.slug)) return next();
  return res.status(404).send(views.error("Not found", "No such agent."));
}

function requireChannelScope(req, res, next) {
  if (req.perm.seesChannel(req.params.slug)) return next();
  return res.status(404).send(views.error("Not found", "No such channel."));
}

/** Drop anything the actor's role does not scope them to. */
const scopeAgents = (req, agents) => (agents || []).filter((a) => req.perm.seesAgent(a.slug));
const scopeChannels = (req, channels) =>
  (channels || []).filter((c) => req.perm.seesChannel(c.slug));

/**
 * An argon2id hash of a random value nobody knows. When a login names a
 * username that does not exist we verify against this instead of returning
 * early, so a missing account and a wrong password cost the same wall-clock
 * time. A hand-written constant would not do: argon2 rejects a malformed
 * digest immediately, which is exactly the timing signal we are removing.
 */
const decoyHash = argon2
  .hash(crypto.randomBytes(32).toString("hex"), { type: argon2.argon2id })
  .catch(() => null);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many login attempts. Try again later.",
});

const pairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ------------------------------------------------------------ first run --- */

/**
 * /setup creates the admin account, so an unauthenticated /setup on a public
 * port is a land-grab risk: whoever loads it first owns the panel. It is
 * therefore gated behind a high-entropy token written to disk at first start,
 * readable only by root and the service account.
 *
 * Once an admin exists the endpoint is dead regardless of token.
 */
function getSetupToken() {
  const p = path.join(DATA_DIR, "setup.token");
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch (_) {
    const token = crypto.randomBytes(24).toString("base64url");
    fs.writeFileSync(p, token, { mode: 0o600 });
    return token;
  }
}

function setupTokenValid(supplied) {
  const expected = getSetupToken();
  const a = Buffer.from(String(supplied || ""));
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so check length first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** True until the very first account exists. */
const noUsersYet = () => db.userCount() === 0;

const TOTP_ISSUER = "MONI AI OS";

/**
 * The enrolment URI an authenticator app scans.
 *
 * Microsoft Authenticator lists an entry as "issuer — account name", and a
 * phone holding entries for several systems has nothing but that line to tell
 * them apart. So the account name is the person's email rather than the local
 * username, which means nothing once it is off this machine. The secret and the
 * algorithm are untouched: this is plain RFC 6238 either way, which is what
 * Microsoft Authenticator stores under "Other account".
 */
function enrolUri(user, secret) {
  return authenticator.keyuri(user.email || user.username, TOTP_ISSUER, secret);
}

const enrolQr = (user, secret) =>
  QRCode.toDataURL(enrolUri(user, secret), { margin: 1, width: 240 });

app.get("/setup", async (req, res) => {
  if (!noUsersYet()) return res.redirect("/login");
  if (!setupTokenValid(req.query.token))
    return res.status(404).send(views.error("Not found", "No such page."));
  res.send(views.setup({ csrf: res.locals.csrf, token: req.query.token }));
});

app.post("/setup", requireCsrf, async (req, res) => {
  if (!noUsersYet()) return res.redirect("/login");
  if (!setupTokenValid(req.body.token))
    return res.status(404).send(views.error("Not found", "No such page."));
  const { username, password, password2 } = req.body;
  const email = field(req.body, "email");
  const errors = [];
  if (!username || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username))
    errors.push("Username must be 3-32 characters (letters, digits, . _ -).");
  if (!EMAIL_RE.test(email)) errors.push("Enter an email address for this account.");
  if (!password || password.length < 12)
    errors.push("Password must be at least 12 characters.");
  if (password !== password2) errors.push("Passwords do not match.");
  if (errors.length)
    return res.status(400).send(
      views.setup({
        csrf: res.locals.csrf,
        token: req.body.token,
        form: { username, email },
        errors,
      })
    );

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const secret = authenticator.generateSecret();
  const role = db.getRoleByName("administrator");
  db.createUser({
    username,
    displayName: username,
    email,
    passwordHash: hash,
    totpSecret: secret,
    roleId: role.id,
    createdBy: "setup",
  });

  const qr = await enrolQr({ username, email }, secret);
  res.send(views.totpEnroll({ csrf: res.locals.csrf, qr, secret, account: email }));
});

app.post("/setup/confirm", requireCsrf, async (req, res) => {
  // Only ever completes the very first account; every later user enrols by
  // signing in, so this stays a one-shot endpoint rather than a way to confirm
  // an arbitrary account's second factor.
  const first = db.listUsers()[0];
  if (!first || db.userCount() !== 1 || first.totp_confirmed) return res.redirect("/login");
  const token = String(req.body.token || "").replace(/\s/g, "");
  if (!authenticator.check(token, first.totp_secret)) {
    return res.status(400).send(
      views.totpEnroll({
        csrf: res.locals.csrf,
        qr: await enrolQr(first, first.totp_secret),
        secret: first.totp_secret,
        account: first.email || first.username,
        error: "That code was not accepted. Check your device clock and try the next code.",
      })
    );
  }
  db.confirmUserTotp(first.id);
  res.send(views.setupDone());
});

/* --------------------------------------------------------------- login ---- */

app.get("/login", (req, res) => {
  if (noUsersYet()) return res.redirect("/setup");
  if (req.me) return res.redirect("/");
  res.send(
    views.login({
      csrf: res.locals.csrf,
      error: req.query.revoked ? "Your access has been changed. Sign in again." : null,
    })
  );
});

app.post("/login", loginLimiter, requireCsrf, async (req, res) => {
  if (noUsersYet()) return res.redirect("/setup");

  const ip = req.ip;
  const { username, password, token } = req.body;
  const reject = (reason) => {
    db.logLogin(ip, username || "", "fail", reason);
    logAuthFailure(ip, reason);
    return res
      .status(401)
      .send(views.login({ csrf: res.locals.csrf, error: "Invalid credentials." }));
  };

  if (!username || !password || !token) return reject("missing field");
  const account = db.getUserByName(String(username));

  // Verify a throwaway hash for an unknown username so a missing account and a
  // wrong password take the same time. Argon2 is slow enough that skipping it
  // would make user enumeration trivial from a stopwatch.
  if (!account) {
    const decoy = await decoyHash;
    if (decoy) await argon2.verify(decoy, String(password)).catch(() => false);
    return reject("unknown user");
  }
  if (account.disabled) return reject("account disabled");

  let passwordOk = false;
  try {
    passwordOk = await argon2.verify(account.password_hash, password);
  } catch (_) {
    passwordOk = false;
  }
  if (!passwordOk) return reject("bad password");

  // Checked and spent in one step. A code stayed usable for its whole
   // ninety-second life before, so one seen over a shoulder -- or in a screen
  // share -- was worth a session to anyone who also had the password. Only a
  // successful sign-in spends one, so retrying after a mistyped password still
  // works with the code already on screen.
  if (!totp.verifyAndConsume(account, token)) return reject("bad totp");

  // First successful sign-in also completes enrolment: producing a valid code
  // is the proof that the authenticator was set up correctly.
  if (!account.totp_confirmed) db.confirmUserTotp(account.id);
  db.touchUserLogin(account.id);

  // Regenerate the session on privilege change to prevent fixation.
  const csrf = req.session.csrf;
  req.session.regenerate((err) => {
    if (err) return res.status(500).send(views.error("Session error", String(err)));
    req.session.authed = true;
    req.session.userId = account.id;
    req.session.username = account.username;
    req.session.csrf = csrf;
    db.logLogin(ip, account.username, "success", null);
    const actor = rbac.actor(account.role);
    res.redirect(actor.can("os.view") ? "/" : "/agents/dashboard");
  });
});

app.post("/logout", requireCsrf, (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

/* ----------------------------------------------------------- dashboard ---- */

function systemStats() {
  const total = os.totalmem();
  const free = os.freemem();
  let diskTotal = null;
  let diskFree = null;
  try {
    const st = fs.statfsSync("/");
    diskTotal = st.blocks * st.bsize;
    diskFree = st.bavail * st.bsize;
  } catch (_) {
    /* statfsSync needs Node 18.15+; degrade gracefully */
  }
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    uptimeSec: os.uptime(),
    loadavg: os.loadavg(),
    cpus: cpus.length,
    cpuModel: cpus.length ? cpus[0].model.replace(/\s+/g, " ").trim() : null,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    // The panel's own uptime, which is not the machine's: a dashboard that
    // restarted an hour ago on a host up for 40 days is worth being able to see.
    panelUptimeSec: Math.floor(process.uptime()),
    panelRssBytes: process.memoryUsage().rss,
    memTotal: total,
    memUsed: total - free,
    diskTotal,
    diskUsed: diskTotal != null ? diskTotal - diskFree : null,
  };
}

/**
 * Fetch several privileged facts at once, tolerating individual failures.
 *
 * A dashboard that 500s because one helper call failed is worse than one that
 * renders with a gap: the whole point of the page is to tell you what is wrong.
 */
async function gather(map) {
  const keys = Object.keys(map);
  const settled = await Promise.allSettled(keys.map((k) => map[k]()));
  const out = { errors: {} };
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") out[keys[i]] = result.value;
    else out.errors[keys[i]] = result.reason.message;
  });
  return out;
}

app.get("/", requireAuth, requirePerm("os.view"), async (req, res) => {
  const data = await gather({
    status: () => priv.status(),
    services: () => priv.serviceList(),
    agents: () => priv.agentList(),
    channels: () => priv.channelList(),
    probe: () => priv.systemProbe(),
  });
  res.send(
    views.osDashboard({
      csrf: res.locals.csrf,
      user: ctx(req),
      stats: systemStats(),
      status: data.status || { services: {}, jails: {} },
      statusError: data.errors.status || null,
      services: data.services || [],
      agents: data.agents || [],
      channels: data.channels || [],
      probe: data.probe || null,
      logins: db.recentLogins(8),
      users: req.perm.can("users.view") ? db.listUsers() : null,
      roles: req.perm.can("roles.view") ? db.listRoles() : null,
      devices: req.perm.can("devices.view") ? db.listDevices() : null,
    })
  );
});

app.get("/api/stats", requireAuth, requirePerm("os.view"), async (req, res) => {
  try {
    res.json({ stats: systemStats(), status: await priv.status() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------------------------------------------------- keys ---- */

app.get("/keys", requireAuth, requirePerm("keys.view"), async (req, res) => {
  try {
    const keys = await priv.listAllKeys();
    res.send(
      views.keys({
        csrf: res.locals.csrf,
        user: ctx(req),
        keys,
        devices: db.listDevices(),
        flash: req.query.msg || null,
        flashError: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not read keys", e.message));
  }
});

app.post("/keys/add", requireAuth, requirePerm("keys.manage"), requireCsrf, async (req, res) => {
  const { target_user, pubkey, label } = req.body;
  const parsed = parsePublicKey(pubkey);
  if (!parsed)
    return res.redirect("/keys?err=" + encodeURIComponent("That does not look like an SSH public key."));
  try {
    await priv.addKey(target_user, parsed.type, parsed.data, sanitiseLabel(label));
    res.redirect("/keys?msg=" + encodeURIComponent("Key added to " + target_user + "."));
  } catch (e) {
    res.redirect("/keys?err=" + encodeURIComponent(e.message));
  }
});

app.post("/keys/remove", requireAuth, requirePerm("keys.manage"), requireCsrf, async (req, res) => {
  const { target_user, fingerprint } = req.body;
  try {
    await priv.removeKey(target_user, fingerprint);
    db.deleteDeviceByFp(fingerprint);
    res.redirect("/keys?msg=" + encodeURIComponent("Key revoked."));
  } catch (e) {
    res.redirect("/keys?err=" + encodeURIComponent(e.message));
  }
});

function parsePublicKey(raw) {
  if (!raw || typeof raw !== "string") return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [type, data] = parts;
  const allowed = [
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
  ];
  if (!allowed.includes(type)) return null;
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(data)) return null;
  return { type, data, comment: parts.slice(2).join(" ") };
}

function sanitiseLabel(label) {
  const clean = String(label || "").replace(/[^A-Za-z0-9 _.@:+-]/g, "").trim();
  return clean.slice(0, 64) || "added-via-dashboard";
}

/* -------------------------------------------------------------- pairing --- */

app.get("/devices", requireAuth, requirePerm("devices.view"), (req, res) => {
  res.send(
    views.devices({
      csrf: res.locals.csrf,
      user: ctx(req),
      codes: db.listPairingCodes(),
      devices: db.listDevices(),
      publicHost: PUBLIC_HOST,
      publicPort: PUBLIC_PORT,
      flash: req.query.msg || null,
    })
  );
});

app.post("/devices/code", requireAuth, requirePerm("devices.manage"), requireCsrf, (req, res) => {
  // Crockford-ish base32, no vowels, to avoid ambiguity and accidental words.
  const alphabet = "0123456789BCDFGHJKLMNPQRSTVWXZ";
  let code = "";
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) code += alphabet[bytes[i] % alphabet.length];
  code = code.slice(0, 4) + "-" + code.slice(4, 8) + "-" + code.slice(8, 12);

  const label = sanitiseLabel(req.body.label || "new device");
  const targetUser = req.body.target_user === "root" ? "root" : "ubuntu";
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.createPairingCode(code, label, targetUser, expires);
  res.redirect("/devices?msg=" + encodeURIComponent(code));
});

app.post("/devices/code/revoke", requireAuth, requirePerm("devices.manage"), requireCsrf, (req, res) => {
  db.deletePairingCode(String(req.body.code || ""));
  res.redirect("/devices");
});

// Deliberately unauthenticated: a brand-new device has no credentials yet.
// Guarded by a single-use, 15-minute, high-entropy code plus rate limiting.
app.get("/pair", pairLimiter, (req, res) => {
  res.send(views.pair({ csrf: res.locals.csrf }));
});

app.post("/pair", pairLimiter, requireCsrf, async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const row = db.getPairingCode(code);
  const fail = (msg) => {
    logAuthFailure(req.ip, "pairing: " + msg);
    return res.status(400).send(views.pair({ csrf: res.locals.csrf, error: msg }));
  };

  if (!row) return fail("Unknown or expired pairing code.");
  if (row.used_at) return fail("That pairing code has already been used.");
  if (new Date(row.expires_at) < new Date()) return fail("That pairing code has expired.");

  const parsed = parsePublicKey(req.body.pubkey);
  if (!parsed) return fail("That does not look like an SSH public key.");

  try {
    const result = await priv.addKey(row.target_user, parsed.type, parsed.data, row.label);
    db.consumePairingCode(code, result.fingerprint);
    db.addDevice(row.label, row.target_user, result.fingerprint, req.ip);
    res.send(
      views.paired({
        label: row.label,
        targetUser: row.target_user,
        fingerprint: result.fingerprint,
        publicHost: PUBLIC_HOST,
      })
    );
  } catch (e) {
    return fail(e.message);
  }
});

/* ---------------------------------------------------------------- audit --- */

app.get("/audit", requireAuth, requirePerm("audit.view"), async (req, res) => {
  let entries = [];
  let err = null;
  try {
    entries = await priv.auditTail(200);
  } catch (e) {
    err = e.message;
  }
  res.send(
    views.audit({
      csrf: res.locals.csrf,
      user: ctx(req),
      entries,
      err,
      logins: db.recentLogins(50),
    })
  );
});

/* --------------------------------------------------------------- agents --- */

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Resolve :slug into a record, or end the response.
 *
 * Every agent and channel route needs the same three things -- a validated
 * slug, the record from the privileged helper, and a 404 that does not leak
 * whether a given slug exists -- so they are done once here.
 */
function loader(fetch) {
  return async function (req, res) {
    const slug = String(req.params.slug || "");
    if (!SLUG_RE.test(slug)) {
      res.status(404).send(views.error("Not found", "No such item."));
      return null;
    }
    try {
      return await fetch(slug);
    } catch (e) {
      res.status(404).send(views.error("Not found", e.message));
      return null;
    }
  };
}

const loadAgent = loader((slug) => priv.agentGet(slug));
const loadChannel = loader((slug) => priv.channelGet(slug));

function redirectTo(base, slug, suffix, params) {
  const query = Object.entries(params || {})
    .filter(([, v]) => v)
    .map(([k, v]) => k + "=" + encodeURIComponent(v))
    .join("&");
  return base + "/" + slug + (suffix || "") + (query ? "?" + query : "");
}

const agentRedirect = (slug, suffix, params) =>
  redirectTo("/agents", slug, suffix, params);
const channelRedirect = (slug, suffix, params) =>
  redirectTo("/channels", slug, suffix, params);

/** Trim a form field to a plain single-line string. */
function field(body, name) {
  return String((body && body[name]) || "").trim();
}

/** Checkbox groups arrive as a string when one is ticked, an array when several. */
function multi(body, name) {
  const value = body && body[name];
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

/** Keep only ids that exist in the catalogue for that scope. */
function pickAddons(body, scope) {
  const valid = new Set(catalog.byScope(scope).map((a) => a.id));
  const chosen = multi(body, "addons").filter((id) => valid.has(id));
  for (const a of catalog.byScope(scope)) {
    if (a.locked && !chosen.includes(a.id)) chosen.push(a.id);
  }
  return chosen.sort();
}

async function probeQuietly() {
  try {
    return await priv.systemProbe();
  } catch (_) {
    return null;
  }
}

app.get("/agents/dashboard", requireAuth, requirePerm("agents.view"), async (req, res) => {
  const data = await gather({
    agents: () => priv.agentList(),
    channels: () => priv.channelList(),
    probe: () => priv.systemProbe(),
  });
  res.send(
    agentViews.dashboard({
      csrf: res.locals.csrf,
      user: ctx(req),
      agents: scopeAgents(req, data.agents),
      channels: scopeChannels(req, data.channels),
      probe: data.probe || null,
      flash: req.query.msg || null,
      err: req.query.err || data.errors.agents || null,
    })
  );
});

app.get("/agents", requireAuth, requirePerm("agents.view"), async (req, res) => {
  try {
    const agents = scopeAgents(req, await priv.agentList());
    res.send(
      agentViews.list({
        csrf: res.locals.csrf,
        user: ctx(req),
        agents,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not list agents", e.message));
  }
});

app.get("/agents/new", requireAuth, requirePerm("agents.create"), async (req, res) => {
  res.send(
    agentViews.create({
      csrf: res.locals.csrf,
      user: ctx(req),
      form: {},
      probe: await probeQuietly(),
    })
  );
});

app.post("/agents/new", requireAuth, requirePerm("agents.create"), requireCsrf, async (req, res) => {
  const addons = pickAddons(req.body, "agent");
  const form = {
    name: field(req.body, "name"),
    slug: field(req.body, "slug").toLowerCase(),
    role: String(req.body.role || "").trim(),
    model: field(req.body, "model") || "claude-opus-5",
    effort: field(req.body, "effort") || "medium",
    verbose_level: field(req.body, "verbose_level") || "1",
    project_dir: field(req.body, "project_dir"),
    addons,
  };
  const errors = [];
  if (!SLUG_RE.test(form.slug))
    errors.push(
      "Short name must start with a letter and contain only lowercase letters, digits and hyphens."
    );
  if (!form.name) errors.push("A display name is required.");

  if (errors.length) {
    return res.status(400).send(
      agentViews.create({
        csrf: res.locals.csrf,
        user: ctx(req),
        form,
        errors,
        probe: await probeQuietly(),
      })
    );
  }

  try {
    await priv.agentCreate({
      slug: form.slug,
      name: form.name,
      role: form.role,
      model: form.model,
      effort: form.effort,
      verbose_level: Number(form.verbose_level),
      project_dir: form.project_dir,
      addons,
      addon_env: catalog.envFor(addons, "agent", req.body),
    });
    priv.agentMemoryIndex(form.slug).catch(() => {});
    // Step two of the wizard. Anyone who genuinely wanted only an agent can
    // skip from there, but the default path leads to a working agent rather
    // than a created one, and those are not the same thing.
    res.redirect(
      "/channels/new?wizard=1&agent=" + encodeURIComponent(form.slug)
    );
  } catch (e) {
    return res.status(400).send(
      agentViews.create({
        csrf: res.locals.csrf,
        user: ctx(req),
        form,
        errors: [e.message],
        probe: await probeQuietly(),
      })
    );
  }
});

app.get("/agents/:slug", requireAuth, requirePerm("agents.view"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  let notes = [];
  try {
    notes = await priv.agentVaultList(agent.slug, "memory");
  } catch (_) {
    /* a vault with no memory/ folder yet is normal, not an error */
  }
  res.send(
    agentViews.detail({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      notes,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/agents/:slug/action", requireAuth, requirePerm("agents.control"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  try {
    await priv.agentAction(agent.slug, field(req.body, "action"));
    res.redirect(
      agentRedirect(agent.slug, "", { msg: "Agent " + field(req.body, "action") + "ed." })
    );
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "", { err: e.message }));
  }
});

app.get("/agents/:slug/instructions", requireAuth, requirePerm("agents.view"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  let content = "";
  try {
    content = (await priv.agentReadFile(agent.slug, "CLAUDE.md")).content;
  } catch (_) {
    content = "";
  }
  res.send(
    agentViews.instructions({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      content,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/agents/:slug/instructions", requireAuth, requirePerm("agents.edit"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  try {
    await priv.agentWriteFile(agent.slug, "CLAUDE.md", String(req.body.content || ""));
    res.redirect(agentRedirect(agent.slug, "/instructions", { msg: "Instructions saved." }));
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/instructions", { err: e.message }));
  }
});

app.get("/agents/:slug/memory", requireAuth, requirePerm("agents.memory.read"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const query = String(req.query.q || "").slice(0, 500).trim();
  let notes = [];
  let hits = null;
  let err = req.query.err || null;
  try {
    notes = await priv.agentVaultList(agent.slug);
  } catch (e) {
    err = e.message;
  }
  if (query) {
    try {
      hits = await priv.agentMemorySearch(agent.slug, query);
    } catch (e) {
      err = "Search failed: " + e.message;
      hits = [];
    }
  }
  res.send(
    agentViews.memory({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      notes,
      query,
      hits,
      flash: req.query.msg || null,
      err,
    })
  );
});

app.post("/agents/:slug/memory/reindex", requireAuth, requirePerm("agents.memory.write"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  try {
    const stats = await priv.agentMemoryIndex(agent.slug, true);
    res.redirect(
      agentRedirect(agent.slug, "/memory", {
        msg: "Reindexed: " + stats.files + " files, " + stats.chunks + " chunks.",
      })
    );
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/memory", { err: e.message }));
  }
});

app.get("/agents/:slug/memory/note", requireAuth, requirePerm("agents.memory.read"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const path = String(req.query.path || "");
  try {
    const file = await priv.agentReadFile(agent.slug, path);
    res.send(
      agentViews.note({
        csrf: res.locals.csrf,
        user: ctx(req),
        agent,
        path,
        content: file.content,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/memory", { err: e.message }));
  }
});

app.post("/agents/:slug/memory/note", requireAuth, requirePerm("agents.memory.write"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const path = field(req.body, "path");
  try {
    await priv.agentWriteFile(agent.slug, path, String(req.body.content || ""));
    res.redirect(
      "/agents/" +
        agent.slug +
        "/memory/note?path=" +
        encodeURIComponent(path) +
        "&msg=" +
        encodeURIComponent("Note saved. It will be re-indexed on the next search.")
    );
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/memory", { err: e.message }));
  }
});

app.get("/agents/:slug/logs", requireAuth, requirePerm("agents.logs"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  let lines = [];
  let err = null;
  try {
    lines = (await priv.agentLogs(agent.slug, 300)).lines;
  } catch (e) {
    err = e.message;
  }
  res.send(
    agentViews.logs({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      lines,
      err,
    })
  );
});

app.get("/agents/:slug/settings", requireAuth, requirePerm("agents.view"), requireAgentScope, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  res.send(
    agentViews.settings({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      probe: await probeQuietly(),
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/agents/:slug/settings", requireAuth, requirePerm("agents.edit"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const addons = pickAddons(req.body, "agent");
  try {
    await priv.agentUpdate({
      slug: agent.slug,
      name: field(req.body, "name"),
      role: agent.role || "",
      model: field(req.body, "model"),
      effort: field(req.body, "effort") || "medium",
      verbose_level: Number(field(req.body, "verbose_level") || 1),
      max_turns: Number(field(req.body, "max_turns") || 100),
      timeout_seconds: Number(field(req.body, "timeout_seconds") || 1800),
      project_dir: field(req.body, "project_dir"),
      addons,
      addon_env: catalog.envFor(addons, "agent", req.body),
    });
    res.redirect(agentRedirect(agent.slug, "/settings", { msg: "Settings saved." }));
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/settings", { err: e.message }));
  }
});

app.post("/agents/:slug/delete", requireAuth, requirePerm("agents.delete"), requireAgentScope, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  if (field(req.body, "confirm") !== agent.slug)
    return res.redirect(
      agentRedirect(agent.slug, "/settings", {
        err: "Type the agent's short name exactly to confirm deletion.",
      })
    );
  try {
    const result = await priv.agentDelete(agent.slug);
    res.redirect(
      "/agents?msg=" +
        encodeURIComponent(agent.slug + " stopped and archived to " + result.archived_to + ".")
    );
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/settings", { err: e.message }));
  }
});

/* ------------------------------------------------------------- channels --- */

app.get("/channels", requireAuth, requirePerm("channels.view"), async (req, res) => {
  const data = await gather({
    channels: () => priv.channelList(),
    agents: () => priv.agentList(),
  });
  res.send(
    channelViews.list({
      csrf: res.locals.csrf,
      user: ctx(req),
      channels: scopeChannels(req, data.channels),
      agents: scopeAgents(req, data.agents),
      flash: req.query.msg || null,
      err: req.query.err || data.errors.channels || null,
    })
  );
});

/**
 * Resolve the agent a wizard step is continuing from.
 *
 * Returns null unless `?wizard=1` names an agent that exists and is in scope,
 * so a forged link cannot make the page claim an agent was just created.
 */
async function wizardAgent(req, agents) {
  if (!req.query.wizard) return null;
  const slug = String(req.query.agent || "");
  if (!SLUG_RE.test(slug) || !req.perm.seesAgent(slug)) return null;
  const match = (agents || []).find((a) => a.slug === slug);
  return match ? { slug: match.slug, name: match.name } : null;
}

app.get("/channels/new", requireAuth, requirePerm("channels.create"), async (req, res) => {
  let agents = [];
  try {
    agents = scopeAgents(req, await priv.agentList());
  } catch (_) {
    /* rendering the form with no agents is still useful */
  }
  res.send(
    channelViews.create({
      csrf: res.locals.csrf,
      user: ctx(req),
      agents,
      wizard: await wizardAgent(req, agents),
      form: { agent: req.query.agent || "" },
    })
  );
});

app.post("/channels/new", requireAuth, requirePerm("channels.create"), requireCsrf, async (req, res) => {
  const type = field(req.body, "type") === "whatsapp" ? "whatsapp" : "telegram";
  const addons = pickAddons(req.body, "channel");
  const form = {
    name: field(req.body, "name"),
    slug: field(req.body, "slug").toLowerCase(),
    type,
    agent: field(req.body, "agent"),
    allowed_users: field(req.body, "allowed_users").replace(/\s/g, ""),
    allowed_numbers: field(req.body, "allowed_numbers").replace(/\s/g, ""),
    topics_enabled: !!req.body.topics_enabled,
    topics_chat_id: field(req.body, "topics_chat_id"),
    addons,
  };
  const token = String(req.body.token || "").trim();
  const errors = [];

  if (!SLUG_RE.test(form.slug))
    errors.push(
      "Short name must start with a letter and contain only lowercase letters, digits and hyphens."
    );
  if (!form.name) errors.push("A channel name is required.");
  if (type === "telegram" && !telegram.looksLikeToken(token))
    errors.push("That does not look like a bot token. It should read 8123456789:AA…");

  const rerender = async (extra = [], botInfo = null) => {
    let agents = [];
    try {
      agents = scopeAgents(req, await priv.agentList());
    } catch (_) {
      /* ignore */
    }
    return res.status(400).send(
      channelViews.create({
        csrf: res.locals.csrf,
        user: ctx(req),
        agents,
        wizard: await wizardAgent({ query: { wizard: req.body.wizard, agent: form.agent }, perm: req.perm }, agents),
        form,
        errors: errors.concat(extra),
        botInfo,
      })
    );
  };

  if (errors.length) return rerender();

  let bot = null;
  if (type === "telegram") {
    // Verify before writing anything. A token Telegram rejects is the most
    // common way a new channel ends up silently dead, and finding out here
    // costs one API call instead of a trip through the logs.
    try {
      bot = await telegram.getMe(token);
    } catch (e) {
      return rerender(["Telegram rejected that token: " + e.message]);
    }
    if (form.topics_enabled && !req.body.ignore_telegram_warnings) {
      try {
        const check = await telegram.checkGroup(token, form.topics_chat_id);
        if (check.problems.length) {
          return rerender(
            check.problems.concat([
              "Fix these in Telegram and submit again, or untick topics to use a private chat.",
            ]),
            bot
          );
        }
      } catch (e) {
        return rerender(["Could not check that group: " + e.message], bot);
      }
    }
  }

  try {
    await priv.channelCreate({
      slug: form.slug,
      name: form.name,
      type,
      agent: form.agent,
      token,
      telegram_bot_username: bot ? bot.username : "",
      allowed_users: form.allowed_users,
      allowed_numbers: form.allowed_numbers,
      topics_enabled: form.topics_enabled,
      topics_chat_id: form.topics_chat_id,
      addons,
      addon_env: catalog.envFor(addons, "channel", req.body),
    });
    // Finishing the wizard lands on the agent, not the channel: the thing you
    // set out to build was an agent that works, and its page is where you
    // check that it does.
    if (req.body.wizard && form.agent) {
      return res.redirect(
        agentRedirect(form.agent, "", {
          msg:
            "Agent and channel are ready." +
            (bot ? " Say hello to @" + bot.username + " on Telegram." : ""),
        })
      );
    }

    const msg = form.agent
      ? "Channel created and connected." +
        (bot ? " Say hello to @" + bot.username + " on Telegram." : "")
      : "Channel created. Connect it to an agent to bring it to life.";
    res.redirect(channelRedirect(form.slug, "", { msg }));
  } catch (e) {
    return rerender([e.message], bot);
  }
});

app.get("/channels/:slug", requireAuth, requirePerm("channels.view"), requireChannelScope, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  let agents = [];
  try {
    agents = await priv.agentList();
  } catch (_) {
    /* ignore */
  }
  // The QR is only meaningful for a WhatsApp channel that is mid-link, and it
  // expires in about a minute, so it is fetched per request rather than cached.
  let wa = null;
  if (channel.type === "whatsapp") {
    try {
      wa = await priv.waStatus(channel.slug);
    } catch (_) {
      /* the bridge may not be installed; the view handles that */
    }
  }
  res.send(
    channelViews.detail({
      csrf: res.locals.csrf,
      user: ctx(req),
      channel,
      agents,
      wa,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

/**
 * The bridge's live state, for the linking page to poll.
 *
 * WhatsApp rotates its pairing code every twenty seconds. A code rendered when
 * the page loaded is dead long before anyone has found Linked Devices on their
 * phone, which is why linking appeared not to work at all: the mechanism was
 * fine and the picture was stale. The page now asks for the current one.
 */
app.get("/channels/:slug/whatsapp/status", requireAuth, requirePerm("channels.view"), requireChannelScope, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  if (channel.type !== "whatsapp") return res.status(404).json({ error: "Not a WhatsApp channel." });

  try {
    const wa = await priv.waStatus(channel.slug);
    res.set("Cache-Control", "no-store").json({
      status: wa.status || "stopped",
      linked: !!wa.linked,
      qr: wa.qr || null,
      number: (wa.me && wa.me.number) || null,
      active: (wa.unit && wa.unit.active) || "inactive",
      updated_at: wa.updated_at || null,
      last_error: wa.last_error || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/channels/:slug/whatsapp/link", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  try {
    await priv.waLink(channel.slug);
    res.redirect(
      channelRedirect(channel.slug, "", {
        msg: "Bridge started. The QR code appears here within a few seconds — reload if it is not shown yet.",
      })
    );
  } catch (e) {
    res.redirect(channelRedirect(channel.slug, "", { err: e.message }));
  }
});

app.post("/channels/:slug/whatsapp/unlink", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  try {
    const result = await priv.waUnlink(channel.slug);
    res.redirect(
      channelRedirect(channel.slug, "", {
        msg:
          "Unlinked. The device session was archived to " +
          (result.archived_to || "the archive") +
          "; scan a new code to reconnect.",
      })
    );
  } catch (e) {
    res.redirect(channelRedirect(channel.slug, "", { err: e.message }));
  }
});

app.get("/channels/:slug/logs", requireAuth, requirePerm("channels.logs"), requireChannelScope, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  let lines = [];
  let err = null;
  try {
    lines = (await priv.waLogs(channel.slug, 300)).lines;
  } catch (e) {
    err = e.message;
  }
  res.send(
    serviceViews.logs({
      csrf: res.locals.csrf,
      user: ctx(req),
      unit: "moni-whatsapp@" + channel.slug,
      lines,
      err,
    })
  );
});

app.post("/channels/:slug", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  const token = String(req.body.token || "").trim();
  const addons = pickAddons(req.body, "channel");

  const update = {
    slug: channel.slug,
    name: field(req.body, "name"),
    type: channel.type,
    agent: field(req.body, "agent"),
    // Membership is deliberately absent. It is edited by the /members routes,
    // and the helper preserves any key the payload omits -- whereas an empty
    // string overrides the stored list. This form no longer carries those
    // fields, so posting them would have emptied the allow-list, silently,
    // every time somebody renamed a channel or changed an add-on.
    topics_enabled: !!req.body.topics_enabled,
    topics_chat_id: field(req.body, "topics_chat_id"),
    addons,
    addon_env: catalog.envFor(addons, "channel", req.body),
  };

  const bail = (msg) => res.redirect(channelRedirect(channel.slug, "", { err: msg }));

  if (token) {
    if (!telegram.looksLikeToken(token))
      return bail("That does not look like a bot token.");
    try {
      const bot = await telegram.getMe(token);
      update.telegram_bot_username = bot.username;
      update.token = token;
    } catch (e) {
      return bail("Telegram rejected that token: " + e.message);
    }
  }
  if (update.topics_enabled && !update.topics_chat_id)
    return bail("Group topic mode needs the group chat id.");

  try {
    await priv.channelUpdate(update);
    res.redirect(channelRedirect(channel.slug, "", { msg: "Channel saved." }));
  } catch (e) {
    return bail(e.message);
  }
});

app.post("/channels/:slug/delete", requireAuth, requirePerm("channels.delete"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  if (field(req.body, "confirm") !== channel.slug)
    return res.redirect(
      channelRedirect(channel.slug, "", {
        err: "Type the channel's short name exactly to confirm deletion.",
      })
    );
  try {
    const result = await priv.channelDelete(channel.slug);
    res.redirect(
      "/channels?msg=" +
        encodeURIComponent(channel.slug + " archived to " + result.archived_to + ".")
    );
  } catch (e) {
    res.redirect(channelRedirect(channel.slug, "", { err: e.message }));
  }
});

/* ------------------------------------------------------------- services --- */

app.get("/services", requireAuth, requirePerm("services.view"), async (req, res) => {
  try {
    const services = await priv.serviceList();
    res.send(
      serviceViews.system({
        csrf: res.locals.csrf,
        user: ctx(req),
        services,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not list services", e.message));
  }
});

app.post("/services/action", requireAuth, requirePerm("services.control"), requireCsrf, async (req, res) => {
  const unit = field(req.body, "target");
  const action = field(req.body, "action");
  try {
    await priv.serviceAction(unit, action);
    res.redirect("/services?msg=" + encodeURIComponent(unit + " " + action + "ed."));
  } catch (e) {
    res.redirect("/services?err=" + encodeURIComponent(e.message));
  }
});

app.get("/services/logs", requireAuth, requirePerm("services.logs"), async (req, res) => {
  const unit = String(req.query.unit || "");
  let lines = [];
  let err = null;
  try {
    lines = (await priv.serviceLogs(unit, 300)).lines;
  } catch (e) {
    err = e.message;
  }
  res.send(
    serviceViews.logs({
      csrf: res.locals.csrf,
      user: ctx(req),
      unit,
      lines,
      err,
    })
  );
});

/* ---------------------------------------------------------------- firewall - */

app.get("/firewall", requireAuth, requirePerm("firewall.view"), async (req, res) => {
  try {
    const status = await priv.firewallStatus();
    res.send(
      firewallViews.index({
        csrf: res.locals.csrf,
        user: ctx(req),
        status,
        myIp: req.ip,
        canManage: req.perm.can("firewall.manage"),
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not read the firewall", e.message));
  }
});

app.post("/firewall/ban", requireAuth, requirePerm("firewall.manage"), requireCsrf, async (req, res) => {
  const ip = field(req.body, "ip");
  const note = field(req.body, "note");
  try {
    // The helper decides whether this address may be blocked, and req.ip is the
    // half of that decision only the server knows. `trust proxy` is loopback, so
    // this is the real client address and not nginx.
    const done = await priv.firewallBan({ ip, note, requester: req.ip });
    db.logLogin(req.ip, req.me.username, "firewall", "blocked " + done.ip);
    res.redirect("/firewall?msg=" + encodeURIComponent(done.ip + " is blocked."));
  } catch (e) {
    res.redirect("/firewall?err=" + encodeURIComponent(e.message));
  }
});

app.post("/firewall/unban", requireAuth, requirePerm("firewall.manage"), requireCsrf, async (req, res) => {
  const ip = field(req.body, "ip");
  try {
    const done = await priv.firewallUnban(ip);
    db.logLogin(req.ip, req.me.username, "firewall", "unblocked " + done.ip);
    res.redirect(
      "/firewall?msg=" +
        encodeURIComponent(done.ip + " unblocked (" + done.cleared.join(", ") + ").")
    );
  } catch (e) {
    res.redirect("/firewall?err=" + encodeURIComponent(e.message));
  }
});

app.get("/services/agents", requireAuth, requirePerm("agents.view"), async (req, res) => {
  try {
    const agents = scopeAgents(req, await priv.agentList());
    res.send(
      serviceViews.agents({
        csrf: res.locals.csrf,
        user: ctx(req),
        agents,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not list agents", e.message));
  }
});

app.post("/services/agent-action", requireAuth, requirePerm("agents.control"), requireCsrf, async (req, res) => {
  const slug = field(req.body, "target");
  const action = field(req.body, "action");
  // Scope is re-checked here because the slug arrives in the body rather than
  // the path, so requireAgentScope never sees it.
  if (!SLUG_RE.test(slug) || !req.perm.seesAgent(slug))
    return res.redirect("/services/agents?err=" + encodeURIComponent("Unknown agent."));
  try {
    await priv.agentAction(slug, action);
    res.redirect("/services/agents?msg=" + encodeURIComponent(slug + " " + action + "ed."));
  } catch (e) {
    res.redirect("/services/agents?err=" + encodeURIComponent(e.message));
  }
});

/* ---------------------------------------------------------- credentials --- */

app.get("/credentials", requireAuth, requirePerm("credentials.view"), async (req, res) => {
  const data = await gather({
    credentials: () => priv.credentialList(),
    probe: () => priv.systemProbe(),
  });
  res.send(
    credentialViews.index({
      csrf: res.locals.csrf,
      user: ctx(req),
      credentials: data.credentials || [],
      probe: data.probe || null,
      flash: req.query.msg || null,
      err: req.query.err || data.errors.credentials || null,
    })
  );
});

app.get("/credentials/:name", requireAuth, requirePerm("credentials.view"), async (req, res) => {
  const name = String(req.params.name || "");
  try {
    const credential = await priv.credentialGet(name);
    res.send(
      credentialViews.detail({
        csrf: res.locals.csrf,
        user: ctx(req),
        credential,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(404).send(views.error("Not found", e.message));
  }
});

app.post("/credentials/:name", requireAuth, requirePerm("credentials.edit"), requireCsrf, async (req, res) => {
  const name = String(req.params.name || "");
  const key = field(req.body, "key");
  const value = String(req.body.value || "").trim();
  try {
    await priv.credentialSet(name, key, value);
    res.redirect(
      "/credentials/" +
        encodeURIComponent(name) +
        "?msg=" +
        encodeURIComponent(
          key + " saved. Restart your agents for them to pick it up."
        )
    );
  } catch (e) {
    res.redirect(
      "/credentials/" + encodeURIComponent(name) + "?err=" + encodeURIComponent(e.message)
    );
  }
});

app.post("/credentials/:name/clear", requireAuth, requirePerm("credentials.edit"), requireCsrf, async (req, res) => {
  const name = String(req.params.name || "");
  const key = field(req.body, "key");
  try {
    await priv.credentialClear(name, key);
    res.redirect(
      "/credentials/" + encodeURIComponent(name) + "?msg=" + encodeURIComponent(key + " cleared.")
    );
  } catch (e) {
    res.redirect(
      "/credentials/" + encodeURIComponent(name) + "?err=" + encodeURIComponent(e.message)
    );
  }
});

/* --------------------------------------------------------------- addons --- */

app.get("/addons", requireAuth, requirePerm("addons.view"), async (req, res) => {
  const query = String(req.query.q || "").slice(0, 120).trim();
  const scope = ["agent", "channel"].includes(String(req.query.scope))
    ? String(req.query.scope)
    : "";
  const data = await gather({
    agents: () => priv.agentList(),
    channels: () => priv.channelList(),
    probe: () => priv.systemProbe(),
  });
  res.send(
    addonViews.catalogue({
      csrf: res.locals.csrf,
      user: ctx(req),
      query,
      scope,
      results: catalog.search(query, scope || null),
      probe: data.probe || null,
      agents: data.agents || [],
      channels: (data.channels || []).map((c) => ({ ...c, name: c.name || c.slug })),
    })
  );
});

/* -------------------------------------------------------------- console --- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// How long a chat's process is kept alive with nobody talking to it. Long
// enough to step away and come back mid-thought; short enough that an idle tab
// does not hold a process overnight.
const CONSOLE_IDLE_MS = 30 * 60 * 1000;
const CONSOLE_MODELS = consoleViews.MODELS.map((m) => m[0]);
const CONSOLE_EFFORTS = consoleViews.EFFORTS.map((e) => e[0]);
const CONSOLE_ACCESS = consoleViews.ACCESS.map((a) => a[0]);
const CONSOLE_PERMISSION_MODES = consoleViews.MODES.map((m) => m[0]);

/**
 * Turns in flight, keyed by console session id.
 *
 * Held in memory on purpose: a turn belongs to the process that started it, and
 * if the panel restarts mid-turn the child dies with it. Persisting a pid to
 * adopt later would mean reattaching to a stream nobody is reading.
 */
const consoleTurns = new Map();

/**
 * Chats whose process is shutting down, keyed by chat id.
 *
 * A restart has to wait for the old process to finish writing its transcript,
 * or the new one resumes a conversation that is still mid-flush and comes back
 * missing the last thing that was said.
 */
const consoleClosing = new Map();

/** The access levels this actor may actually choose. */
function allowedAccess(req) {
  return CONSOLE_ACCESS.filter((a) => a !== "full" || req.perm.can("console.full"));
}

async function consoleDirs() {
  try {
    return await priv.consoleDirs();
  } catch (_) {
    return ["/"];
  }
}

/**
 * The two lists the sidebar draws.
 *
 * Archived chats are fetched even when the section is closed, because the
 * count on its label is the reason anyone opens it, and a count that needs a
 * second request is a count that arrives late.
 */
function consoleLists(req) {
  return {
    sessions: db.listConsoleSessions(req.me.id),
    archived: db.listConsoleSessions(req.me.id, { archived: true }),
  };
}

/**
 * How long a code buys before another is asked for.
 *
 * Long enough to do a piece of work without being interrupted, short enough
 * that a laptop left open does not stay a root shell all afternoon. It is not
 * extended by use: the question is how long ago somebody proved they were
 * there, and typing does not answer it.
 */
const ROOT_UNLOCK_MS = 20 * 60 * 1000;

function unlockRoot(req, sessionId) {
  if (!req.session.rootUnlocked) req.session.rootUnlocked = {};
  req.session.rootUnlocked[String(sessionId)] = Date.now() + ROOT_UNLOCK_MS;
}

/** Whether this chat needs a code before it can be opened or spoken to. */
function rootLocked(req, session) {
  if (!session || session.root_enabled !== 1) return false;
  const until = (req.session.rootUnlocked || {})[String(session.id)] || 0;
  return Date.now() >= until;
}

function loadConsoleSession(req, res) {
  const session = db.getConsoleSession(Number(req.params.id), req.me.id);
  if (!session) {
    res.status(404).send(views.error("Not found", "No such chat."));
    return null;
  }
  return session;
}

app.get("/console", requireAuth, requirePerm("console.use"), async (req, res) => {
  res.send(
    consoleViews.console({
      csrf: res.locals.csrf,
      user: ctx(req, "console"),
      ...consoleLists(req),
      session: null,
      messages: [],
      dirs: await consoleDirs(),
    })
  );
});

app.post("/console/new", requireAuth, requirePerm("console.use"), requireCsrf, (req, res) => {
  // Default to the widest access the actor is entitled to. Someone without
  // console.full gets a workspace chat rather than an error.
  const access = req.perm.can("console.full") ? "full" : "workspace";
  const info = db.createConsoleSession({
    uuid: crypto.randomUUID(),
    userId: req.me.id,
    model: "claude-opus-5",
    effort: "medium",
    access,
    cwd: access === "full" ? "/" : "/opt/moni-agents/agents",
  });
  res.redirect("/console/" + info.lastInsertRowid);
});

app.get("/console/:id", requireAuth, requirePerm("console.use"), async (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  // A root chat shows its transcript only once somebody has proved they are
  // here. The lock screen is the page, not an overlay on it -- there is no
  // point rendering the conversation and then hiding it.
  const locked = rootLocked(req, session);
  res.send(
    consoleViews.console({
      csrf: res.locals.csrf,
      user: ctx(req, "console"),
      ...consoleLists(req),
      session,
      locked,
      messages: locked ? [] : db.listConsoleMessages(session.id),
      dirs: await consoleDirs(),
      err: req.query.err || null,
    })
  );
});

app.post("/console/:id/settings", requireAuth, requirePerm("console.use"), requireCsrf, (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;

  const fields = {};
  const model = field(req.body, "model");
  const effort = field(req.body, "effort");
  const access = field(req.body, "access");
  const cwd = field(req.body, "cwd");

  if (CONSOLE_MODELS.includes(model)) fields.model = model;
  if (CONSOLE_EFFORTS.includes(effort)) fields.effort = effort;
  const mode = field(req.body, "permission_mode");
  if (CONSOLE_PERMISSION_MODES.includes(mode)) fields.permission_mode = mode;
  // Access is fixed once a session has run a turn: Claude resumes the same
  // conversation, and moving that conversation from the agent account to root
  // half way through would be a privilege change disguised as a preference.
  if (!session.started && allowedAccess(req).includes(access)) fields.access = access;
  if (/^\/[A-Za-z0-9._/-]{0,200}$/.test(cwd)) fields.cwd = cwd;

  db.updateConsoleSession(session.id, req.me.id, fields);
  // These are all fixed when the process starts, so a change only takes effect
  // on a fresh one. Closing it here means the next message uses what the page is
  // showing -- and because the close is graceful, the replacement resumes the
  // same conversation rather than starting a new one.
  closeConsoleChat(session.id);
  res.redirect("/console/" + session.id);
});

app.get("/console/:id/root", requireAuth, requirePerm("console.use"), (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  // Already on, wrong sort of chat, or not permitted: nothing to confirm.
  if (session.root_enabled === 1 || session.access !== "full" || !req.perm.can("console.full")) {
    return res.redirect("/console/" + session.id);
  }
  res.send(
    consoleViews.enableRoot({
      csrf: res.locals.csrf,
      user: ctx(req, "console"),
      session,
      err: req.query.err || null,
    })
  );
});

app.post("/console/:id/root", requireAuth, requirePerm("console.use"), requireCsrf, (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  // Only a whole-server chat has root to switch. The workspace profile never
  // had any, so a toggle there would be a control that does nothing.
  if (session.access !== "full" || !req.perm.can("console.full")) {
    return res.redirect("/console/" + session.id);
  }

  const enabled = session.root_enabled === 0;
  const back = (q) => res.redirect("/console/" + session.id + (q ? "?" + q : ""));

  // Switching root ON is the privilege change, so that is the direction that
  // asks for a code. Switching it OFF gives something up, and a control that
  // makes you prove yourself before you may reduce your own reach is a control
  // people learn to leave alone.
  if (enabled) {
    if (!totp.verifyAndConsume(req.me, req.body.code)) {
      logAuthFailure(req.ip, "bad code enabling console root");
      return res.redirect(
        "/console/" + session.id + "/root?err=" +
          encodeURIComponent("That code was not accepted. Try the next one.")
      );
    }
    unlockRoot(req, session.id);
  }

  // Fixed at spawn, so the running process has to go. It is asked to exit
  // rather than killed, so the conversation is on disk and the next message
  // resumes it: flipping this costs you nothing but the wait.
  closeConsoleChat(session.id);
  db.updateConsoleSession(session.id, req.me.id, { root_enabled: enabled ? 1 : 0 });
  db.logLogin(
    req.ip,
    req.me.username,
    "console",
    (enabled ? "enabled" : "disabled") + ` root for chat ${session.id}`
  );
  back();
});

/**
 * Unlock a root-enabled chat for a while.
 *
 * The code proves somebody is at the keyboard now. Sign-in proved it hours ago
 * on a machine that has been left alone since, which is a different claim.
 */
app.post("/console/:id/unlock", requireAuth, requirePerm("console.use"), requireCsrf, (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  if (!totp.verifyAndConsume(req.me, req.body.code)) {
    logAuthFailure(req.ip, "bad code unlocking a root console chat");
    return res.redirect(
      "/console/" + session.id + "?err=" + encodeURIComponent("That code was not accepted. Try the next one.")
    );
  }
  unlockRoot(req, session.id);
  db.logLogin(req.ip, req.me.username, "console", `unlocked root chat ${session.id}`);
  res.redirect("/console/" + session.id);
});

app.post("/console/:id/rename", requireAuth, requirePerm("console.use"), requireCsrf, (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  const title = field(req.body, "title").replace(/\s+/g, " ").slice(0, 80);
  // An empty name is a request to go back to being unnamed, not an error: the
  // next message will name the chat again from what it says.
  db.updateConsoleSession(session.id, req.me.id, { title: title || "New chat" });
  res.redirect("/console/" + session.id);
});

app.post("/console/:id/archive", requireAuth, requirePerm("console.use"), requireCsrf, (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  const archived = !session.archived;
  // Archiving closes the process; unarchiving and speaking resumes it. Keeping
  // one alive for a chat that has been put away is paying for a conversation
  // nobody is having.
  if (archived) closeConsoleChat(session.id);
  db.updateConsoleSession(session.id, req.me.id, { archived: archived ? 1 : 0 });
  res.redirect(archived ? "/console" : "/console/" + session.id);
});

app.post("/console/:id/delete", requireAuth, requirePerm("console.use"), requireCsrf, (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  closeConsoleChat(session.id);
  db.deleteConsoleSession(session.id, req.me.id);
  res.redirect("/console");
});

/**
 * End a chat's process, letting it write its transcript on the way out.
 *
 * Closing stdin rather than killing matters: a session that exits cleanly
 * leaves its conversation on disk, and the next process resumes it. That is the
 * whole reason changing a setting no longer costs you the chat. A kill is kept
 * as a fallback for a process that will not go.
 *
 * Returns a promise that settles when the process is gone, so a respawn can
 * wait for the transcript to be flushed rather than racing it.
 */
function closeConsoleChat(sessionId, { hard = false } = {}) {
  const entry = consoleTurns.get(sessionId);
  if (!entry) return Promise.resolve();

  clearTimeout(entry.idle);
  consoleTurns.delete(sessionId);

  if (consoleClosing.has(sessionId)) return consoleClosing.get(sessionId);

  const closing = new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    entry.child.once("close", done);

    try {
      if (hard) entry.child.kill("SIGTERM");
      else entry.child.stdin.end();
    } catch (_) {
      return done();
    }

    // A turn in flight keeps running until it finishes, so this is generous.
    // If it is still there afterwards it is stuck, and a stuck process holding
    // a chat open helps nobody.
    const timer = setTimeout(() => {
      try {
        entry.child.kill("SIGKILL");
      } catch (_) {
        /* already gone */
      }
      done();
    }, hard ? 4000 : 20000);
    timer.unref();
  }).then(() => {
    consoleClosing.delete(sessionId);
  });

  consoleClosing.set(sessionId, closing);
  return closing;
}

/**
 * Close a chat that nobody has spoken to for a while.
 *
 * These processes hold a conversation in memory and cost nothing to restart,
 * so there is no reason to keep one alive overnight. Losing it costs the
 * model's memory of the chat, not the chat itself -- the transcript is in the
 * database either way.
 */
function touchConsoleChat(sessionId) {
  const entry = consoleTurns.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.idle);
  entry.idle = setTimeout(() => closeConsoleChat(sessionId), CONSOLE_IDLE_MS);
  entry.idle.unref();
}

/**
 * Attachments arrive base64 in a JSON body, so this route needs a far larger
 * limit than the 64kb the rest of the panel accepts. Scoped to the route rather
 * than raised globally: nowhere else has any business receiving 40MB.
 */
const consoleUploadBody = express.json({ limit: "44mb" });

app.post("/console/:id/upload", requireAuth, requirePerm("console.use"), consoleUploadBody, requireCsrf, async (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  try {
    const saved = await priv.consoleUpload({
      chat: String(session.id),
      access: session.access,
      name: String(req.body.name || "file"),
      data: String(req.body.data || ""),
    });
    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/console/:id/transcribe", requireAuth, requirePerm("console.use"), consoleUploadBody, requireCsrf, async (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  try {
    // Saved first, then transcribed: whisper reads a file, and keeping the
    // recording means a transcription that comes out wrong can be checked
    // against what was actually said.
    const saved = await priv.consoleUpload({
      chat: String(session.id),
      access: session.access,
      name: "voice-note.webm",
      data: String(req.body.data || ""),
    });
    const out = await priv.consoleTranscribe(saved.path);
    res.json({ text: out.text, path: saved.path });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Answer the CLI's permission question. */
function answerPermission(entry, requestId, behavior, input, message) {
  const response =
    behavior === "allow"
      ? { behavior: "allow", updatedInput: input || {} }
      : { behavior: "deny", message: message || "The administrator declined." };
  try {
    entry.child.stdin.write(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
      }) + "\n"
    );
  } catch (_) {
    /* the process went away; the turn is over anyway */
  }
}

/**
 * Decide what to do when Claude asks to use a tool.
 *
 * Nothing reaches this today: driven non-interactively the CLI does not send
 * permission requests, which is why the mode picker offers Auto and Plan rather
 * than a per-action prompt. It is kept because answering is the correct
 * response to a request that may start arriving -- a future CLI that does send
 * one would otherwise wait forever for a reply nobody was writing.
 */
function handlePermissionRequest(session, entry, event, write) {
  const requestId = event.request_id;
  const req = event.request;

  if (entry.mode !== "ask") {
    return answerPermission(entry, requestId, "allow", req.input);
  }

  entry.pending.set(String(requestId), { input: req.input });
  write(
    JSON.stringify({
      type: "moni_permission",
      request_id: requestId,
      tool: req.tool_name,
      input: req.input,
      title: req.title || null,
      description: req.description || null,
    })
  );
}

app.post("/console/:id/permission", requireAuth, requirePerm("console.use"), requireCsrf, (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  const entry = consoleTurns.get(session.id);
  if (!entry) return res.status(409).json({ error: "That chat is no longer running." });

  const requestId = String(req.body.request_id || "");
  const pending = entry.pending.get(requestId);
  if (!pending) return res.status(404).json({ error: "That question has already been answered." });
  entry.pending.delete(requestId);

  const allow = field(req.body, "decision") === "allow";
  answerPermission(entry, requestId, allow ? "allow" : "deny", pending.input);
  res.json({ ok: true });
});

app.post("/console/:id/stop", requireAuth, requirePerm("console.use"), requireCsrf, (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  // Stops the turn, not the conversation: the process is asked to finish and
  // write its transcript, and the next message resumes from there. What it was
  // part way through doing may or may not have completed, so the reply says so
  // rather than pretending the interruption was clean.
  closeConsoleChat(session.id, { hard: true });
  res.json({ stopped: true });
});

/**
 * Run one turn, streaming Claude's events to the browser as they arrive.
 *
 * The response is newline-delimited JSON rather than SSE: the client reads it
 * with a streaming fetch, which lets the request be a POST carrying the CSRF
 * token in the body. An EventSource cannot POST, and putting a prompt in a
 * query string would write it into the access log.
 */
app.post("/console/:id/send", requireAuth, requirePerm("console.use"), requireCsrf, async (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;

  const prompt = String(req.body.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Say something first." });

  let entry = consoleTurns.get(session.id);
  if (entry && entry.busy)
    return res.status(409).json({ error: "This chat is already working on something." });

  if (session.access === "full" && !req.perm.can("console.full")) {
    return res
      .status(403)
      .json({ error: "Your role does not allow whole-server chats." });
  }

  // Checked again here, not only on the page. The page is a courtesy; this is
  // the thing that actually stops a message reaching a root shell after the
  // unlock has run out.
  if (rootLocked(req, session)) {
    return res.status(401).json({
      error: "This chat needs an authenticator code again. Reload the page.",
      locked: true,
    });
  }

  db.addConsoleMessage(session.id, "user", prompt);

  // Recorded because a full-access chat has the run of the machine, and that
  // should leave a trace even when the person opening one is entitled to.
  db.logLogin(
    req.ip,
    req.me.username,
    "console",
    `turn in chat ${session.id} (${session.access}, ${session.model}, ${session.effort})`
  );

  // One process per chat, kept alive between turns. The context lives in it:
  // `claude -p` writes no transcript to disk, so a fresh process per message
  // would start every turn from nothing however the session was named.
  if (!entry) {
    // A process that was closing must be allowed to finish writing before the
    // replacement tries to resume what it wrote.
    if (consoleClosing.has(session.id)) await consoleClosing.get(session.id);

    const child = priv.consoleOpen({
      model: session.model,
      effort: session.effort,
      access: session.access,
      cwd: session.cwd,
      permission_mode: session.permission_mode || "auto",
      root_enabled: session.root_enabled !== 0,
      // Pick the conversation back up where it was left. Settings fixed at
      // spawn -- the model, the root switch -- can then be changed by restarting
      // the process without the chat losing what it knows.
      resume: session.started && UUID_RE.test(session.uuid) ? session.uuid : "",
    });
    entry = {
      child,
      busy: false,
      idle: null,
      buffer: "",
      listeners: [],
      mode: session.permission_mode || "auto",
      // Permission questions the CLI has asked and the person has not answered.
      pending: new Map(),
    };
    consoleTurns.set(session.id, entry);

    // The CLI only routes permission prompts to the host once the host has
    // introduced itself. Without this handshake "ask" silently behaves like
    // "auto", which is the wrong way round for a mistake to go.
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: "init",
        request: { subtype: "initialize", hooks: null },
      }) + "\n"
    );

    child.stdout.on("data", (chunk) => {
      entry.buffer += chunk;
      const lines = entry.buffer.split("\n");
      entry.buffer = lines.pop();
      for (const line of lines) if (line.trim()) entry.listeners.forEach((fn) => fn(line));
    });
    child.stderr.on("data", (chunk) => {
      console.error("console stderr:", priv.redact(String(chunk)).slice(0, 500));
    });
    child.on("close", () => {
      entry.listeners.forEach((fn) => fn(null));
      consoleTurns.delete(session.id);
    });
    child.on("error", (e) => {
      console.error("console spawn failed:", e.message);
      entry.listeners.forEach((fn) => fn(null));
      consoleTurns.delete(session.id);
    });
  }

  entry.busy = true;
  clearTimeout(entry.idle);

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no"); // nginx would otherwise hold the stream

  let assistantText = "";
  let result = null;
  let done = false;
  // The browser can leave before the turn does. When it does we stop writing,
  // but keep listening: the answer is still being paid for and still belongs in
  // the transcript, so it must reach the database even with nobody watching.
  let watching = true;

  const write = (line) => {
    if (watching) res.write(line + "\n");
  };

  const finish = (reason) => {
    if (done) return;
    done = true;
    entry.listeners = entry.listeners.filter((fn) => fn !== onLine);
    entry.busy = false;
    touchConsoleChat(session.id);

    if (assistantText.trim()) {
      db.addConsoleMessage(session.id, "assistant", assistantText, {
        duration_ms: result && result.duration_ms,
        cost_usd: result && result.total_cost_usd,
        model: session.model,
      });
      // Name the chat from its opening message, so the list is readable
      // without opening anything.
      if (!session.title || session.title === "New chat") {
        db.updateConsoleSession(session.id, req.me.id, {
          title: prompt.replace(/\s+/g, " ").slice(0, 60),
        });
      }
      db.updateConsoleSession(session.id, req.me.id, { started: 1 });
    } else if (reason === "closed") {
      db.addConsoleMessage(session.id, "system", "That turn ended without an answer.");
    }
    if (watching) res.end();
  };

  function onLine(line) {
    // A null line means the process went away underneath us.
    if (line === null) {
      write(JSON.stringify({ type: "moni_done", exit_code: 1 }));
      return finish("closed");
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch (_) {
      return; // not an event we emitted
    }

    // The CLI asking whether it may use a tool.
    if (event.type === "control_request" && event.request) {
      if (event.request.subtype !== "can_use_tool") return;
      return handlePermissionRequest(session, entry, event, write);
    }
    if (event.type === "control_response") return; // our own handshake echoing back

    // Accumulate the prose so a finished turn can be stored and redisplayed on
    // reload without replaying the whole event stream.
    if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) assistantText += block.text;
      }
    }
    if (event.session_id && UUID_RE.test(event.session_id) && event.session_id !== session.uuid) {
      db.setConsoleSessionUuid(session.id, req.me.id, event.session_id);
      session.uuid = event.session_id;
    }

    write(priv.redact(JSON.stringify(event)));

    // `result` ends the turn but not the conversation: the response closes and
    // the process stays up holding the context for the next message.
    if (event.type === "result") {
      result = event;
      finish("result");
    }
  }

  entry.listeners.push(onLine);

  // The CLI's streaming-input format. One line per message.
  entry.child.stdin.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
      parent_tool_use_id: null,
      session_id: session.uuid,
    }) + "\n"
  );

  // If the browser goes away mid-turn, stop waiting on its behalf -- but leave
  // the process running, because the turn is still being paid for and its
  // answer belongs in the transcript when it arrives.
  req.on("close", () => {
    watching = false;
  });
});

/** Read the current allow-list of a channel as an ordered array. */
function memberList(channel) {
  const raw = channel.type === "telegram" ? channel.allowed_users : channel.allowed_numbers;
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Rewrite a channel's allow-list.
 *
 * Sent through channelUpdate rather than a dedicated helper command so the
 * ordinary path runs: the list is revalidated, the agent's environment is
 * regenerated, and the unit is restarted. A membership change that did not
 * restart the agent would leave the old list in the running process, which is
 * exactly the class of bug that made the credential editor confusing.
 */
async function saveMembers(channel, members) {
  const update = {
    slug: channel.slug,
    name: channel.name,
    type: channel.type,
    agent: channel.agent || "",
    topics_enabled: !!channel.topics_enabled,
    topics_chat_id: channel.topics_chat_id || "",
    addons: channel.addons || [],
    addon_env: channel.addon_env || {},
    telegram_bot_username: channel.telegram_bot_username || "",
  };
  // Only the key this channel type actually uses. Sending the other one as an
  // empty string would clear a list that is not being edited -- which matters
  // if a channel is ever converted between types.
  update[channel.type === "telegram" ? "allowed_users" : "allowed_numbers"] =
    members.join(",");
  await priv.channelUpdate(update);
}

const TELEGRAM_ID_RE = /^\d{4,15}$/;
const PHONE_RE = /^\+?\d{6,20}$/;

/* ------------------------------------------------------- channel members --- */

app.post("/channels/:slug/members/add", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  const id = field(req.body, "id").replace(/\s/g, "");
  const back = (q) => res.redirect("/channels/" + channel.slug + "?" + q);

  const pattern = channel.type === "telegram" ? TELEGRAM_ID_RE : PHONE_RE;
  if (!pattern.test(id))
    return back(
      "err=" +
        encodeURIComponent(
          channel.type === "telegram"
            ? "A Telegram user ID is 4-15 digits. Message @userinfobot to find yours."
            : "Use a phone number in E.164 form, like +201234567890."
        )
    );

  const members = memberList(channel);
  if (members.includes(id)) return back("err=" + encodeURIComponent("Already on the list."));

  members.push(id);
  try {
    await saveMembers(channel, members);
    back(
      "msg=" +
        encodeURIComponent(
          members.length === 1
            ? id + " added, and is the administrator of this channel."
            : id + " added."
        )
    );
  } catch (e) {
    back("err=" + encodeURIComponent(e.message));
  }
});

app.post("/channels/:slug/members/promote", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  const id = field(req.body, "id").replace(/\s/g, "");
  const back = (q) => res.redirect("/channels/" + channel.slug + "?" + q);

  const members = memberList(channel);
  if (!members.includes(id)) return back("err=" + encodeURIComponent("Not on the list."));

  // Promotion is a reorder, not an extra flag: the administrator is defined as
  // position zero, so there is only ever one and it cannot drift out of sync
  // with the list it is meant to describe.
  const reordered = [id, ...members.filter((m) => m !== id)];
  try {
    await saveMembers(channel, reordered);
    db.logLogin(req.ip, req.me.username, "admin", "made " + id + " administrator of " + channel.slug);
    back("msg=" + encodeURIComponent(id + " is now the administrator of this channel."));
  } catch (e) {
    back("err=" + encodeURIComponent(e.message));
  }
});

app.post("/channels/:slug/members/remove", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  const id = field(req.body, "id").replace(/\s/g, "");
  const back = (q) => res.redirect("/channels/" + channel.slug + "?" + q);

  const members = memberList(channel).filter((m) => m !== id);
  try {
    await saveMembers(channel, members);
    back(
      "msg=" +
        encodeURIComponent(
          members.length
            ? id + " removed. " + members[0] + " is the administrator."
            : id + " removed. Nobody can use this channel now."
        )
    );
  } catch (e) {
    back("err=" + encodeURIComponent(e.message));
  }
});

/* ---------------------------------------------------------------- users --- */

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const ROLE_NAME_RE = /^[a-z0-9_-]{2,32}$/;

// Deliberately loose. Anything stricter starts rejecting real addresses, and
// this field is a label on an authenticator entry and a way to reach the
// person -- not a credential, so nothing is decided by its exact shape. No
// domain is pinned: any address will do, and deciding which ones count is a
// policy that belongs to whoever runs the panel rather than to this line.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Scope inputs arrive as a mode radio plus a checkbox list. */
function readScope(body, name) {
  if (field(body, name + "_mode") !== "list") return "*";
  const raw = body[name];
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .map((s) => String(s).trim())
    .filter((s) => SLUG_RE.test(s));
  return [...new Set(list)].join(",");
}

/** Only slugs and display names reach the role editor's scope pickers. */
async function scopeOptions() {
  const data = await gather({
    agents: () => priv.agentList(),
    channels: () => priv.channelList(),
  });
  return {
    agents: (data.agents || []).map((a) => ({ slug: a.slug, name: a.name })),
    channels: (data.channels || []).map((c) => ({ slug: c.slug, name: c.name })),
  };
}

app.get("/users", requireAuth, requirePerm("users.view"), (req, res) => {
  res.send(
    accessViews.users({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      users: db.listUsers(),
      roles: db.listRoles(),
      missingEmail: db.usersMissingEmail(),
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.get("/users/new", requireAuth, requirePerm("users.manage"), (req, res) => {
  res.send(
    accessViews.userNew({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      roles: db.listRoles(),
    })
  );
});

app.post("/users/new", requireAuth, requirePerm("users.manage"), requireCsrf, async (req, res) => {
  const username = field(req.body, "username");
  const displayName = field(req.body, "display_name");
  const email = field(req.body, "email");
  const password = String(req.body.password || "");
  const roleId = Number(field(req.body, "role_id"));

  const errors = [];
  if (!USERNAME_RE.test(username))
    errors.push("Username must be 3-32 characters (letters, digits, . _ -).");
  if (db.getUserByName(username)) errors.push("That username is already taken.");
  if (!EMAIL_RE.test(email)) errors.push("Enter their email address.");
  else if (db.getUserByEmail(email)) errors.push("Another account already uses that email.");
  if (password.length < 12) errors.push("Password must be at least 12 characters.");
  if (!db.getRole(roleId)) errors.push("Pick a role.");
  if (errors.length)
    return res.status(400).send(
      accessViews.userNew({
        csrf: res.locals.csrf,
        user: ctx(req, "os"),
        roles: db.listRoles(),
        form: { username, display_name: displayName, email, role_id: roleId },
        errors,
      })
    );

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const secret = authenticator.generateSecret();
  const info = db.createUser({
    username,
    displayName,
    email,
    passwordHash: hash,
    totpSecret: secret,
    roleId,
    createdBy: req.me.username,
  });
  const target = db.getUser(info.lastInsertRowid);
  const qr = await enrolQr(target, secret);
  // Rendered directly rather than redirected to: the password and the secret
  // exist only in this response, and a redirect would have to carry them in a
  // URL, which is the one place they must never be.
  res.send(
    accessViews.userEnrol({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      target,
      qr,
      secret,
      password,
    })
  );
});

/** Load the target user and work out what may be done to them. */
function userContext(req) {
  const target = db.getUser(Number(req.params.id));
  if (!target) return null;
  const isSelf = req.me.id === target.id;
  const isAdmin = target.role && target.role.permissions.includes("*");
  return { target, isSelf, lastAdmin: isAdmin && db.countActiveAdmins() <= 1 };
}

app.get("/users/:id", requireAuth, requirePerm("users.view"), (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  res.send(
    accessViews.userDetail({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      ...c,
      roles: db.listRoles(),
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/users/:id", requireAuth, requirePerm("users.manage"), requireCsrf, (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  const back = "/users/" + c.target.id;

  const roleId = c.lastAdmin ? c.target.role_id : Number(field(req.body, "role_id"));
  const disabled = !c.lastAdmin && !c.isSelf && field(req.body, "disabled") === "1";
  const email = field(req.body, "email");
  if (!db.getRole(roleId))
    return res.redirect(back + "?err=" + encodeURIComponent("Unknown role."));
  if (!EMAIL_RE.test(email))
    return res.redirect(back + "?err=" + encodeURIComponent("Enter their email address."));
  const clash = db.getUserByEmail(email);
  if (clash && clash.id !== c.target.id)
    return res.redirect(
      back + "?err=" + encodeURIComponent("Another account already uses that email.")
    );

  // Changing the address changes the label an already-enrolled phone shows, but
  // not the secret -- so nothing re-enrols and nobody is locked out. The entry
  // on their phone keeps the old label until they next enrol.
  const relabelled = email.toLowerCase() !== String(c.target.email || "").toLowerCase();

  db.updateUser(c.target.id, {
    displayName: field(req.body, "display_name") || c.target.username,
    email,
    roleId,
    disabled,
  });
  res.redirect(
    back +
      "?msg=" +
      encodeURIComponent(
        relabelled && c.target.totp_confirmed
          ? "Saved. Their authenticator keeps working — the new address only shows on a fresh enrolment."
          : "Saved."
      )
  );
});

app.post("/users/:id/password", requireAuth, requirePerm("users.manage"), requireCsrf, async (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  const back = "/users/" + c.target.id;
  const password = String(req.body.password || "");
  if (password.length < 12)
    return res.redirect(back + "?err=" + encodeURIComponent("Password must be at least 12 characters."));
  db.setUserPassword(c.target.id, await argon2.hash(password, { type: argon2.argon2id }));
  db.logLogin(req.ip, req.me.username, "admin", "reset password for " + c.target.username);
  res.redirect(back + "?msg=" + encodeURIComponent("Password reset. Give them the new one directly."));
});

app.post("/users/:id/totp", requireAuth, requirePerm("users.manage"), requireCsrf, async (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  const secret = authenticator.generateSecret();
  db.setUserTotp(c.target.id, secret, false);
  db.logLogin(req.ip, req.me.username, "admin", "reset 2FA for " + c.target.username);
  const qr = await enrolQr(c.target, secret);
  res.send(
    accessViews.userEnrol({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      target: c.target,
      qr,
      secret,
      password: "(unchanged — reset it separately if they also lost that)",
    })
  );
});

app.post("/users/:id/delete", requireAuth, requirePerm("users.manage"), requireCsrf, (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  if (c.isSelf || c.lastAdmin)
    return res.redirect(
      "/users/" + c.target.id + "?err=" + encodeURIComponent("That account cannot be deleted.")
    );
  db.deleteUser(c.target.id);
  db.logLogin(req.ip, req.me.username, "admin", "deleted user " + c.target.username);
  res.redirect("/users?msg=" + encodeURIComponent(c.target.username + " removed."));
});

/* ---------------------------------------------------------------- roles --- */

app.get("/roles", requireAuth, requirePerm("roles.view"), (req, res) => {
  res.send(
    accessViews.roles({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      roles: db.listRoles(),
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.get("/roles/new", requireAuth, requirePerm("roles.manage"), async (req, res) => {
  const opts = await scopeOptions();
  res.send(
    accessViews.roleEdit({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      role: { permissions: [], agent_scope: "*", channel_scope: "*" },
      isNew: true,
      readOnly: false,
      ...opts,
    })
  );
});

app.post("/roles/new", requireAuth, requirePerm("roles.manage"), requireCsrf, async (req, res) => {
  const name = field(req.body, "name").toLowerCase();
  const label = field(req.body, "label");
  const description = field(req.body, "description");
  const raw = req.body.permissions;
  const permissions = rbac.closure(Array.isArray(raw) ? raw : raw ? [raw] : []);

  const errors = [];
  if (!ROLE_NAME_RE.test(name)) errors.push("Name must be 2-32 lowercase letters, digits, - or _.");
  if (db.getRoleByName(name)) errors.push("A role with that name already exists.");
  if (!label) errors.push("Give the role a label.");
  if (errors.length) {
    const opts = await scopeOptions();
    return res.status(400).send(
      accessViews.roleEdit({
        csrf: res.locals.csrf,
        user: ctx(req, "os"),
        role: {
          name,
          label,
          description,
          permissions,
          agent_scope: readScope(req.body, "agent_scope"),
          channel_scope: readScope(req.body, "channel_scope"),
        },
        isNew: true,
        readOnly: false,
        errors,
        ...opts,
      })
    );
  }

  db.createRole({
    name,
    label,
    description,
    permissions,
    agentScope: readScope(req.body, "agent_scope"),
    channelScope: readScope(req.body, "channel_scope"),
  });
  res.redirect("/roles?msg=" + encodeURIComponent(label + " created."));
});

app.get("/roles/:id", requireAuth, requirePerm("roles.view"), async (req, res) => {
  const role = db.getRole(Number(req.params.id));
  if (!role) return res.status(404).send(views.error("Not found", "No such role."));
  const opts = await scopeOptions();
  res.send(
    accessViews.roleEdit({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      role: { ...role, user_count: db.roleUserCount(role.id) },
      isNew: false,
      // Viewing without roles.manage, and the built-in administrator for
      // anyone, are both read-only.
      readOnly: role.builtin || !req.perm.can("roles.manage"),
      flash: req.query.msg || null,
      ...opts,
    })
  );
});

app.post("/roles/:id", requireAuth, requirePerm("roles.manage"), requireCsrf, (req, res) => {
  const role = db.getRole(Number(req.params.id));
  if (!role) return res.status(404).send(views.error("Not found", "No such role."));
  if (role.builtin)
    return res.redirect("/roles/" + role.id + "?err=" + encodeURIComponent("Built-in roles cannot be edited."));

  const raw = req.body.permissions;
  db.updateRole(role.id, {
    label: field(req.body, "label") || role.label,
    description: field(req.body, "description"),
    permissions: rbac.closure(Array.isArray(raw) ? raw : raw ? [raw] : []),
    agentScope: readScope(req.body, "agent_scope"),
    channelScope: readScope(req.body, "channel_scope"),
  });
  db.logLogin(req.ip, req.me.username, "admin", "edited role " + role.name);
  res.redirect("/roles/" + role.id + "?msg=" + encodeURIComponent("Role saved."));
});

app.post("/roles/:id/delete", requireAuth, requirePerm("roles.manage"), requireCsrf, (req, res) => {
  const role = db.getRole(Number(req.params.id));
  if (!role) return res.status(404).send(views.error("Not found", "No such role."));
  if (role.builtin || db.roleUserCount(role.id) > 0)
    return res.redirect(
      "/roles/" + role.id + "?err=" + encodeURIComponent("That role cannot be deleted right now.")
    );
  db.deleteRole(role.id);
  res.redirect("/roles?msg=" + encodeURIComponent(role.label + " deleted."));
});

/* -------------------------------------------------------------- account --- */

app.get("/account", requireAuth, (req, res) => {
  res.send(
    accessViews.account({
      csrf: res.locals.csrf,
      user: ctx(req),
      me: req.me,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/account/password", requireAuth, requireCsrf, async (req, res) => {
  const current = String(req.body.current || "");
  const password = String(req.body.password || "");
  const fail = (m) => res.redirect("/account?err=" + encodeURIComponent(m));

  if (password.length < 12) return fail("New password must be at least 12 characters.");
  if (password !== String(req.body.password2 || "")) return fail("New passwords do not match.");

  let ok = false;
  try {
    ok = await argon2.verify(req.me.password_hash, current);
  } catch (_) {
    ok = false;
  }
  if (!ok) {
    logAuthFailure(req.ip, "password change with wrong current password");
    return fail("Current password is not correct.");
  }

  db.setUserPassword(req.me.id, await argon2.hash(password, { type: argon2.argon2id }));
  res.redirect("/account?msg=" + encodeURIComponent("Password changed."));
});

/* --- moving your own authenticator to another app ----------------------- */

/**
 * How long a half-finished move stays open.
 *
 * Long enough to install an app and scan, short enough that a pending secret
 * does not sit in the session store for the rest of the day.
 */
const REENROL_MS = 15 * 60 * 1000;

/**
 * Move your second factor to a different app or phone, with no gap in cover.
 *
 * The alternative is an administrator reset, which needs a second
 * administrator on hand and leaves the account unable to sign in between the
 * reset and the new enrolment. Here the new secret lives in the session until a
 * code generated from it proves it actually arrived on the phone; only then
 * does it replace the old one. Abandon this halfway and nothing has changed.
 */
app.get("/account/authenticator", requireAuth, (req, res) => {
  res.send(
    accessViews.reenrolStart({
      csrf: res.locals.csrf,
      user: ctx(req),
      me: req.me,
      err: req.query.err || null,
    })
  );
});

app.post("/account/authenticator", requireAuth, requireCsrf, async (req, res) => {
  const fail = (m) => res.redirect("/account/authenticator?err=" + encodeURIComponent(m));

  let ok = false;
  try {
    ok = await argon2.verify(req.me.password_hash, String(req.body.password || ""));
  } catch (_) {
    ok = false;
  }
  if (!ok) {
    logAuthFailure(req.ip, "authenticator move with wrong password");
    return fail("Password is not correct.");
  }
  // A current code as well as the password: without it, a session left open on
  // an unlocked machine is enough to move the second factor to another phone,
  // which is the one thing the second factor exists to prevent.
  if (!totp.verifyAndConsume(req.me, req.body.code)) {
    logAuthFailure(req.ip, "authenticator move with bad code");
    return fail("That code was not accepted. Try the next one.");
  }

  const secret = authenticator.generateSecret();
  req.session.pendingTotp = { secret, at: Date.now() };
  res.send(
    accessViews.reenrolScan({
      csrf: res.locals.csrf,
      user: ctx(req),
      me: req.me,
      qr: await enrolQr(req.me, secret),
      secret,
      err: null,
    })
  );
});

app.post("/account/authenticator/confirm", requireAuth, requireCsrf, async (req, res) => {
  const pending = req.session.pendingTotp;
  if (!pending || Date.now() - pending.at > REENROL_MS) {
    delete req.session.pendingTotp;
    return res.redirect(
      "/account/authenticator?err=" + encodeURIComponent("That took too long. Start again.")
    );
  }

  const code = String(req.body.code || "").replace(/\s/g, "");
  // Checked against the pending secret, not the account's, so this cannot be
  // satisfied by the app being replaced.
  if (!authenticator.check(code, pending.secret)) {
    return res.status(400).send(
      accessViews.reenrolScan({
        csrf: res.locals.csrf,
        user: ctx(req),
        me: req.me,
        qr: await enrolQr(req.me, pending.secret),
        secret: pending.secret,
        err: "That code was not accepted. Check the phone's clock and try the next one.",
      })
    );
  }

  db.setUserTotp(req.me.id, pending.secret, true);
  delete req.session.pendingTotp;
  db.logLogin(req.ip, req.me.username, "account", "moved authenticator to a new app");
  res.redirect(
    "/account?msg=" +
      encodeURIComponent("Authenticator moved. Codes from the old app no longer work.")
  );
});

/* ---------------------------------------------------------------- guide --- */

app.get("/guide", requireAuth, (req, res) => {
  res.send(
    guideViews.guide({
      csrf: res.locals.csrf,
      user: ctx(req),
      publicHost: PUBLIC_HOST,
      publicPort: PUBLIC_PORT,
      sshHost: process.env.MONI_SSH_HOST || PUBLIC_HOST,
    })
  );
});

/* --------------------------------------------------------------- misc ----- */

app.get("/healthz", (req, res) => res.type("text").send("ok"));

app.use((req, res) => res.status(404).send(views.error("Not found", "No such page.")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(views.error("Server error", "Something went wrong."));
});

app.listen(PORT, BIND, () => {
  console.log(`moni-dashboard listening on ${BIND}:${PORT}`);
  if (noUsersYet()) {
    // Materialise the token at startup so an operator with shell access can read
    // it, rather than having to hit the endpoint first to bring it into being.
    getSetupToken();
    console.log("No admin account yet. Setup token is in " + DATA_DIR + "/setup.token");
  }
});
