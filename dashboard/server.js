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
const credentialViews = require("./lib/views-credentials");
const addonViews = require("./lib/views-addons");
const guideViews = require("./lib/views-guide");

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
app.use("/static", express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

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

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect("/login");
}

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

app.get("/setup", async (req, res) => {
  if (db.getAdmin()) return res.redirect("/login");
  if (!setupTokenValid(req.query.token))
    return res.status(404).send(views.error("Not found", "No such page."));
  res.send(views.setup({ csrf: res.locals.csrf, token: req.query.token }));
});

app.post("/setup", requireCsrf, async (req, res) => {
  if (db.getAdmin()) return res.redirect("/login");
  if (!setupTokenValid(req.body.token))
    return res.status(404).send(views.error("Not found", "No such page."));
  const { username, password, password2 } = req.body;
  const errors = [];
  if (!username || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username))
    errors.push("Username must be 3-32 characters (letters, digits, . _ -).");
  if (!password || password.length < 12)
    errors.push("Password must be at least 12 characters.");
  if (password !== password2) errors.push("Passwords do not match.");
  if (errors.length)
    return res
      .status(400)
      .send(views.setup({ csrf: res.locals.csrf, token: req.body.token, errors }));

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const secret = authenticator.generateSecret();
  db.createAdmin(username, hash, secret);

  const otpauth = authenticator.keyuri(username, "MONI VPS", secret);
  const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 });
  req.session.pendingTotpUser = username;
  res.send(views.totpEnroll({ csrf: res.locals.csrf, qr, secret }));
});

app.post("/setup/confirm", requireCsrf, async (req, res) => {
  const admin = db.getAdmin();
  if (!admin || admin.totp_confirmed) return res.redirect("/login");
  const token = String(req.body.token || "").replace(/\s/g, "");
  if (!authenticator.check(token, admin.totp_secret)) {
    const otpauth = authenticator.keyuri(admin.username, "MONI VPS", admin.totp_secret);
    const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 });
    return res.status(400).send(
      views.totpEnroll({
        csrf: res.locals.csrf,
        qr,
        secret: admin.totp_secret,
        error: "That code was not accepted. Check your device clock and try the next code.",
      })
    );
  }
  db.confirmTotp();
  res.send(views.setupDone());
});

/* --------------------------------------------------------------- login ---- */

app.get("/login", (req, res) => {
  if (!db.getAdmin()) return res.redirect("/setup");
  if (req.session.authed) return res.redirect("/");
  res.send(views.login({ csrf: res.locals.csrf }));
});

app.post("/login", loginLimiter, requireCsrf, async (req, res) => {
  const admin = db.getAdmin();
  if (!admin) return res.redirect("/setup");

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
  if (username !== admin.username) return reject("unknown user");

  let passwordOk = false;
  try {
    passwordOk = await argon2.verify(admin.password_hash, password);
  } catch (_) {
    passwordOk = false;
  }
  if (!passwordOk) return reject("bad password");

  if (!authenticator.check(String(token).replace(/\s/g, ""), admin.totp_secret))
    return reject("bad totp");

  // Regenerate the session on privilege change to prevent fixation.
  const csrf = req.session.csrf;
  req.session.regenerate((err) => {
    if (err) return res.status(500).send(views.error("Session error", String(err)));
    req.session.authed = true;
    req.session.username = admin.username;
    req.session.csrf = csrf;
    db.logLogin(ip, username, "success", null);
    res.redirect("/");
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
  return {
    hostname: os.hostname(),
    uptimeSec: os.uptime(),
    loadavg: os.loadavg(),
    cpus: os.cpus().length,
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

app.get("/", requireAuth, async (req, res) => {
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
      user: req.session.username,
      stats: systemStats(),
      status: data.status || { services: {}, jails: {} },
      statusError: data.errors.status || null,
      services: data.services || [],
      agents: data.agents || [],
      channels: data.channels || [],
      probe: data.probe || null,
      logins: db.recentLogins(8),
    })
  );
});

app.get("/api/stats", requireAuth, async (req, res) => {
  try {
    res.json({ stats: systemStats(), status: await priv.status() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------------------------------------------------- keys ---- */

app.get("/keys", requireAuth, async (req, res) => {
  try {
    const keys = await priv.listAllKeys();
    res.send(
      views.keys({
        csrf: res.locals.csrf,
        user: req.session.username,
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

app.post("/keys/add", requireAuth, requireCsrf, async (req, res) => {
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

app.post("/keys/remove", requireAuth, requireCsrf, async (req, res) => {
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

app.get("/devices", requireAuth, (req, res) => {
  res.send(
    views.devices({
      csrf: res.locals.csrf,
      user: req.session.username,
      codes: db.listPairingCodes(),
      devices: db.listDevices(),
      publicHost: PUBLIC_HOST,
      publicPort: PUBLIC_PORT,
      flash: req.query.msg || null,
    })
  );
});

app.post("/devices/code", requireAuth, requireCsrf, (req, res) => {
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

app.post("/devices/code/revoke", requireAuth, requireCsrf, (req, res) => {
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

app.get("/audit", requireAuth, async (req, res) => {
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
      user: req.session.username,
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

app.get("/agents/dashboard", requireAuth, async (req, res) => {
  const data = await gather({
    agents: () => priv.agentList(),
    channels: () => priv.channelList(),
    probe: () => priv.systemProbe(),
  });
  res.send(
    agentViews.dashboard({
      csrf: res.locals.csrf,
      user: req.session.username,
      agents: data.agents || [],
      channels: data.channels || [],
      probe: data.probe || null,
      flash: req.query.msg || null,
      err: req.query.err || data.errors.agents || null,
    })
  );
});

app.get("/agents", requireAuth, async (req, res) => {
  try {
    const agents = await priv.agentList();
    res.send(
      agentViews.list({
        csrf: res.locals.csrf,
        user: req.session.username,
        agents,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not list agents", e.message));
  }
});

app.get("/agents/new", requireAuth, async (req, res) => {
  res.send(
    agentViews.create({
      csrf: res.locals.csrf,
      user: req.session.username,
      form: {},
      probe: await probeQuietly(),
    })
  );
});

app.post("/agents/new", requireAuth, requireCsrf, async (req, res) => {
  const addons = pickAddons(req.body, "agent");
  const form = {
    name: field(req.body, "name"),
    slug: field(req.body, "slug").toLowerCase(),
    role: String(req.body.role || "").trim(),
    model: field(req.body, "model") || "claude-opus-5",
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
        user: req.session.username,
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
      verbose_level: Number(form.verbose_level),
      project_dir: form.project_dir,
      addons,
      addon_env: catalog.envFor(addons, "agent", req.body),
    });
    priv.agentMemoryIndex(form.slug).catch(() => {});
    res.redirect(
      agentRedirect(form.slug, "", {
        msg: "Agent created. Connect a channel so it can be reached.",
      })
    );
  } catch (e) {
    return res.status(400).send(
      agentViews.create({
        csrf: res.locals.csrf,
        user: req.session.username,
        form,
        errors: [e.message],
        probe: await probeQuietly(),
      })
    );
  }
});

app.get("/agents/:slug", requireAuth, async (req, res) => {
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
      user: req.session.username,
      agent,
      notes,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/agents/:slug/action", requireAuth, requireCsrf, async (req, res) => {
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

app.get("/agents/:slug/instructions", requireAuth, async (req, res) => {
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
      user: req.session.username,
      agent,
      content,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/agents/:slug/instructions", requireAuth, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  try {
    await priv.agentWriteFile(agent.slug, "CLAUDE.md", String(req.body.content || ""));
    res.redirect(agentRedirect(agent.slug, "/instructions", { msg: "Instructions saved." }));
  } catch (e) {
    res.redirect(agentRedirect(agent.slug, "/instructions", { err: e.message }));
  }
});

app.get("/agents/:slug/memory", requireAuth, async (req, res) => {
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
      user: req.session.username,
      agent,
      notes,
      query,
      hits,
      flash: req.query.msg || null,
      err,
    })
  );
});

app.post("/agents/:slug/memory/reindex", requireAuth, requireCsrf, async (req, res) => {
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

app.get("/agents/:slug/memory/note", requireAuth, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const path = String(req.query.path || "");
  try {
    const file = await priv.agentReadFile(agent.slug, path);
    res.send(
      agentViews.note({
        csrf: res.locals.csrf,
        user: req.session.username,
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

app.post("/agents/:slug/memory/note", requireAuth, requireCsrf, async (req, res) => {
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

app.get("/agents/:slug/logs", requireAuth, async (req, res) => {
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
      user: req.session.username,
      agent,
      lines,
      err,
    })
  );
});

app.get("/agents/:slug/settings", requireAuth, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  res.send(
    agentViews.settings({
      csrf: res.locals.csrf,
      user: req.session.username,
      agent,
      probe: await probeQuietly(),
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/agents/:slug/settings", requireAuth, requireCsrf, async (req, res) => {
  const agent = await loadAgent(req, res);
  if (!agent) return;
  const addons = pickAddons(req.body, "agent");
  try {
    await priv.agentUpdate({
      slug: agent.slug,
      name: field(req.body, "name"),
      role: agent.role || "",
      model: field(req.body, "model"),
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

app.post("/agents/:slug/delete", requireAuth, requireCsrf, async (req, res) => {
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

app.get("/channels", requireAuth, async (req, res) => {
  const data = await gather({
    channels: () => priv.channelList(),
    agents: () => priv.agentList(),
  });
  res.send(
    channelViews.list({
      csrf: res.locals.csrf,
      user: req.session.username,
      channels: data.channels || [],
      agents: data.agents || [],
      flash: req.query.msg || null,
      err: req.query.err || data.errors.channels || null,
    })
  );
});

app.get("/channels/new", requireAuth, async (req, res) => {
  let agents = [];
  try {
    agents = await priv.agentList();
  } catch (_) {
    /* rendering the form with no agents is still useful */
  }
  res.send(
    channelViews.create({
      csrf: res.locals.csrf,
      user: req.session.username,
      agents,
      form: { agent: req.query.agent || "" },
    })
  );
});

app.post("/channels/new", requireAuth, requireCsrf, async (req, res) => {
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
      agents = await priv.agentList();
    } catch (_) {
      /* ignore */
    }
    return res.status(400).send(
      channelViews.create({
        csrf: res.locals.csrf,
        user: req.session.username,
        agents,
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
    const msg = form.agent
      ? "Channel created and connected." +
        (bot ? " Say hello to @" + bot.username + " on Telegram." : "")
      : "Channel created. Connect it to an agent to bring it to life.";
    res.redirect(channelRedirect(form.slug, "", { msg }));
  } catch (e) {
    return rerender([e.message], bot);
  }
});

app.get("/channels/:slug", requireAuth, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  let agents = [];
  try {
    agents = await priv.agentList();
  } catch (_) {
    /* ignore */
  }
  res.send(
    channelViews.detail({
      csrf: res.locals.csrf,
      user: req.session.username,
      channel,
      agents,
      qr: null,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/channels/:slug", requireAuth, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  const token = String(req.body.token || "").trim();
  const addons = pickAddons(req.body, "channel");

  const update = {
    slug: channel.slug,
    name: field(req.body, "name"),
    type: channel.type,
    agent: field(req.body, "agent"),
    allowed_users: field(req.body, "allowed_users").replace(/\s/g, ""),
    allowed_numbers: field(req.body, "allowed_numbers").replace(/\s/g, ""),
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

app.post("/channels/:slug/delete", requireAuth, requireCsrf, async (req, res) => {
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

app.get("/services", requireAuth, async (req, res) => {
  try {
    const services = await priv.serviceList();
    res.send(
      serviceViews.system({
        csrf: res.locals.csrf,
        user: req.session.username,
        services,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not list services", e.message));
  }
});

app.post("/services/action", requireAuth, requireCsrf, async (req, res) => {
  const unit = field(req.body, "target");
  const action = field(req.body, "action");
  try {
    await priv.serviceAction(unit, action);
    res.redirect("/services?msg=" + encodeURIComponent(unit + " " + action + "ed."));
  } catch (e) {
    res.redirect("/services?err=" + encodeURIComponent(e.message));
  }
});

app.get("/services/logs", requireAuth, async (req, res) => {
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
      user: req.session.username,
      unit,
      lines,
      err,
    })
  );
});

app.get("/services/agents", requireAuth, async (req, res) => {
  try {
    const agents = await priv.agentList();
    res.send(
      serviceViews.agents({
        csrf: res.locals.csrf,
        user: req.session.username,
        agents,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(500).send(views.error("Could not list agents", e.message));
  }
});

app.post("/services/agent-action", requireAuth, requireCsrf, async (req, res) => {
  const slug = field(req.body, "target");
  const action = field(req.body, "action");
  if (!SLUG_RE.test(slug))
    return res.redirect("/services/agents?err=" + encodeURIComponent("Unknown agent."));
  try {
    await priv.agentAction(slug, action);
    res.redirect("/services/agents?msg=" + encodeURIComponent(slug + " " + action + "ed."));
  } catch (e) {
    res.redirect("/services/agents?err=" + encodeURIComponent(e.message));
  }
});

/* ---------------------------------------------------------- credentials --- */

app.get("/credentials", requireAuth, async (req, res) => {
  const data = await gather({
    credentials: () => priv.credentialList(),
    probe: () => priv.systemProbe(),
  });
  res.send(
    credentialViews.index({
      csrf: res.locals.csrf,
      user: req.session.username,
      credentials: data.credentials || [],
      probe: data.probe || null,
      flash: req.query.msg || null,
      err: req.query.err || data.errors.credentials || null,
    })
  );
});

app.get("/credentials/:name", requireAuth, async (req, res) => {
  const name = String(req.params.name || "");
  try {
    const credential = await priv.credentialGet(name);
    res.send(
      credentialViews.detail({
        csrf: res.locals.csrf,
        user: req.session.username,
        credential,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.status(404).send(views.error("Not found", e.message));
  }
});

app.post("/credentials/:name", requireAuth, requireCsrf, async (req, res) => {
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

app.post("/credentials/:name/clear", requireAuth, requireCsrf, async (req, res) => {
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

app.get("/addons", requireAuth, async (req, res) => {
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
      user: req.session.username,
      query,
      scope,
      results: catalog.search(query, scope || null),
      probe: data.probe || null,
      agents: data.agents || [],
      channels: (data.channels || []).map((c) => ({ ...c, name: c.name || c.slug })),
    })
  );
});

/* ---------------------------------------------------------------- guide --- */

app.get("/guide", requireAuth, (req, res) => {
  res.send(
    guideViews.guide({
      csrf: res.locals.csrf,
      user: req.session.username,
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
  if (!db.getAdmin()) {
    // Materialise the token at startup so an operator with shell access can read
    // it, rather than having to hit the endpoint first to bring it into being.
    getSetupToken();
    console.log("No admin account yet. Setup token is in " + DATA_DIR + "/setup.token");
  }
});
