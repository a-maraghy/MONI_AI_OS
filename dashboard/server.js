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
const moniAiViews = require("./lib/views-moniai");
const mintLogic = require("./public/cc-logic");
const claudeViews = require("./lib/views-claude");
const moniai = require("./lib/moniai");
const rbac = require("./lib/rbac");
const totp = require("./lib/totp");
const voice = require("./lib/voice");
const voiceDesk = require("./lib/voice-desk");
const voiceUsage = require("./lib/voice-usage");
const voicePersona = require("./lib/voice-persona");
const voiceLive = require("./lib/voice-live");
const UiActions = require("./public/ui-actions.js");
// UI control Phase 2: the ui tokens this server minted, in memory only (lib/ui-relay.js).
const uiRelay = require("./lib/ui-relay").createRelay();
const uiTab = require("./lib/ui-relay").TAB_RE;
/** moniai.call for the voice desk and the live call: a send carrying a ui token binds it to the turn it started. */
function moniCall(op, params, actor, opts) {
  return moniai.call(op, params, actor, opts).then((r) => {
    if (op === "send" && params && params.ut && r && r.turn) uiRelay.bind(params.ut, r.turn.id);
    return r;
  });
}
const voiceEval = require("./lib/voice-live-eval");
const voiceEvalViews = require("./lib/views-voice-eval");
const { asset } = require("./lib/ui");
const { WebSocketServer } = require("ws");
const voiceGuard = require("./lib/voice-guard");
const voiceIntake = require("./lib/voice-intake");
// The spoken "stop listening" command; the same file runs in the browser.
const voiceStop = require("./public/voice-stop.js");
const chrome = require("./lib/chrome");
const memgraph = require("./lib/memgraph");
const pulse = require("./lib/pulse");

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

/**
 * The Command Center moved from /moni-ai to /mint-ai with the Mint rename.
 * This is the only place that still knows the old prefix, and it runs first so
 * everything after it -- the body parsers, auth, CSRF, permissions, the routes
 * -- sees only the new one.
 *
 *  - /moni-ai/api/* is an alias, not a redirect: the URL is rewritten in place
 *    and served by the same handlers with the same checks. A redirect would
 *    break POST bodies, the SSE stream and CSRF'd fetches from pages opened
 *    before the move.
 *  - Any other GET/HEAD under /moni-ai (the page itself, bookmarks) is a 301 to
 *    the same path under /mint-ai, query string kept.
 */
const LEGACY_CC = /^\/moni-ai(?=\/|\?|$)/i;
app.use((req, res, next) => {
  if (!LEGACY_CC.test(req.url)) return next();
  const rest = req.url.replace(LEGACY_CC, "");
  if (/^\/api(\/|\?|$)/i.test(rest) || (req.method !== "GET" && req.method !== "HEAD")) {
    req.url = "/mint-ai" + rest;
    return next();
  }
  return res.redirect(301, "/mint-ai" + rest);
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"], // data: is needed for the TOTP QR code
        // Spoken replies arrive as a WAV body and are played from a blob URL,
        // which is same-origin but is not 'self' as far as CSP is concerned.
        // Without this the audio is fetched, decoded, and then silently refused
        // at the moment it would play.
        mediaSrc: ["'self'", "blob:"],
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

/**
 * 64KB is the right ceiling for a form, and the wrong one for the two routes
 * that carry a file.
 *
 * Those mount their own parser allowing 44MB -- but a parser mounted here runs
 * first, so it is this limit a large upload meets, and it answers by throwing
 * rather than by refusing politely. Skipping them here is what lets their own
 * parser be the one that decides. Everything else keeps the small ceiling,
 * which is the point of having one.
 */
const PAYLOAD_ROUTES = /^(\/console\/\d+\/(upload|transcribe)|\/mint-ai\/api\/transcribe|\/mint-ai\/api\/voice-eval\/clip)$/;
const smallJson = express.json({ limit: "64kb" });
app.use((req, res, next) =>
  PAYLOAD_ROUTES.test(req.path) ? next() : smallJson(req, res, next)
);

/** A body over the limit is a 413 with a reason, not a stack trace. */
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({ error: "That is too large to send in one request." });
  }
  return next(err);
});
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

// Kept as a value: the live conversation's WebSocket upgrade reads the same
// session (see liveUpgrade), and an upgrade never passes through app.use.
const sessionMw = session({
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
  });
app.use(sessionMw);

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

// The frame's badges and health chip, from a shared 30-second cache (see
// lib/chrome.js). A change made through the panel forgets the cache, so the
// page it redirects to counts what is true now rather than half a minute ago.
chrome.configure({ priv, db, catalog });

// The Machine core's live feed: one poller for every viewer, reading the
// helper's pulse-feed, this panel's own sign-ins and audit log, and MINT AI's
// ledger. It only runs while someone has the overview open.
const pulseFeed = pulse.createFeed({ priv, db, moniai, auditLog: path.join(LOG_DIR, "audit.log") });
app.use((req, res, next) => {
  if (req.method === "POST") chrome.invalidate();
  next();
});
app.use(chrome.middleware());

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
    chrome: req.chrome || null,
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

const TOTP_ISSUER = "Mint OS";

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
  if (req.me) return res.redirect(rbac.landing(req.perm));
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
    res.redirect(rbac.landing(actor));
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

/**
 * The unit list, at most UNITS_MS old, shared by every overview's poll. Each
 * fresh read is folded into the frame's cache so badge, chip and page agree.
 */
const UNITS_MS = 10 * 1000;
let unitsCache = { at: 0, list: null, pending: null };
function freshServices() {
  if (unitsCache.list && Date.now() - unitsCache.at < UNITS_MS) return Promise.resolve(unitsCache.list);
  if (!unitsCache.pending) {
    unitsCache.pending = priv
      .serviceList()
      .then((list) => {
        unitsCache = { at: Date.now(), list, pending: null };
        chrome.prime({ services: list });
        return list;
      })
      .catch((e) => {
        unitsCache.pending = null;
        throw e;
      });
  }
  return unitsCache.pending;
}
function primeFrame(req, services) {
  unitsCache = { at: Date.now(), list: services, pending: null };
  const merged = chrome.prime({ services });
  if (merged && req.chrome) req.chrome = chrome.forActor(req.perm, merged);
}

// `/` is the default landing, not a page: MINT AI for those who may use it,
// else the first dashboard the role can open (rbac.landing). A 302 so the
// default can change again; the OS overview itself lives at /os.
app.get("/", requireAuth, (req, res) => res.redirect(302, rbac.landing(req.perm)));

app.get("/os", requireAuth, requirePerm("os.view"), async (req, res) => {
  const data = await gather({
    status: () => priv.status(),
    services: () => priv.serviceList(),
    agents: () => priv.agentList(),
    channels: () => priv.channelList(),
    probe: () => priv.systemProbe(),
    audit: () => (req.perm.can("audit.view") ? priv.auditTail(14) : Promise.resolve(null)),
  });
  if (Array.isArray(data.services)) primeFrame(req, data.services);
  res.send(
    views.osDashboard({
      csrf: res.locals.csrf,
      user: ctx(req),
      stats: systemStats(),
      status: data.status || { services: {}, jails: {} },
      statusError: data.errors.status || null,
      services: chrome.visibleServices(data.services || [], req.perm),
      agents: data.agents || [],
      channels: data.channels || [],
      graph: pulse.buildGraph({
        services: chrome.visibleServices(data.services || [], req.perm),
        agents: scopeAgents(req, data.agents),
        channels: scopeChannels(req, data.channels),
        detail: new Map(catalog.OS_SERVICES.map((s) => [s.unit, s])),
      }),
      totals: await pulseFeed.getTotals(),
      probe: data.probe || null,
      logins: db.recentLogins(20),
      audit: data.audit || null,
      users: req.perm.can("users.view") ? db.listUsers() : null,
      roles: req.perm.can("roles.view") ? db.listRoles() : null,
      devices: req.perm.can("devices.view") ? db.listDevices() : null,
    })
  );
});

/**
 * The Machine core's events since `since` (a sequence number this endpoint
 * handed out), plus the units' current states from the shared 30 s cache.
 * Cheap on purpose: the page asks every few seconds, and however many pages
 * ask, the sources are read at most once per pulse.MIN_INTERVAL_MS.
 */
app.get("/api/os/pulse", requireAuth, requirePerm("os.view"), async (req, res) => {
  const since = /^[0-9]{1,12}$/.test(String(req.query.since || "")) ? Number(req.query.since) : 0;
  const wantTotals = since === 0 || req.query.totals === "1";
  try {
    await Promise.race([pulseFeed.poll(), new Promise((r) => setTimeout(r, 2500))]);
  } catch (_) {
    /* the feed logs its own failures; an empty answer is still an answer */
  }
  let all = [];
  try {
    all = await freshServices();
  } catch (_) {
    const facts = (await chrome.facts()) || {};
    all = Array.isArray(facts.services) ? facts.services : [];
  }
  const services = chrome.visibleServices(all, req.perm);
  const seen = new Set(services.map((s) => s.unit));
  const canAudit = req.perm.can("audit.view");
  const allow = (e) => {
    if (e.type === "audit") return canAudit;
    if (e.type === "start") return seen.has(e.unit);
    if (e.type === "reply") return seen.has("moni-agent@" + e.agent);
    return true;
  };
  const events = pulseFeed.since(since, allow).map((e) => {
    const o = { seq: e.seq, type: e.type, at: e.at };
    for (const k of ["unit", "jail", "agent", "source", "action", "n"]) if (e[k] != null) o[k] = e[k];
    return o;
  });
  res.set("Cache-Control", "no-store");
  res.json({
    seq: pulseFeed.seq,
    events,
    units: services.map((s) => ({ unit: s.unit, active: s.active, since: pulse.shortSince(s.since), memory: s.memory })),
    totals: wantTotals ? await pulseFeed.getTotals() : undefined,
  });
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
  // The journal tail on the overview is the Logs tab's own read -- same
  // helper call, same permission, same redaction -- just fewer lines.
  let journal = null;
  let journalErr = null;
  if (req.perm.canAgent("agents.logs", agent.slug)) {
    try {
      journal = (await priv.agentLogs(agent.slug, 80)).lines;
    } catch (e) {
      journalErr = e.message;
    }
  }
  res.send(
    agentViews.detail({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      notes,
      journal,
      journalErr,
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
  let peers = [];
  try {
    peers = scopeAgents(req, await priv.agentList());
  } catch (_) {
    /* the chips then offer this agent alone */
  }
  res.send(
    agentViews.memory({
      csrf: res.locals.csrf,
      user: ctx(req),
      agent,
      agents: peers,
      view: String(req.query.view || ""),
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

/**
 * The overview's journal tail, refreshed in place. The same permission and the
 * same redacting helper call as the Logs page; JSON so a lapsed session gets a
 * status code rather than a sign-in form in the middle of the panel.
 */
app.get("/api/agents/:slug/logs", async (req, res) => {
  if (!req.me) return res.status(401).json({ error: "Sign in first." });
  if (!req.perm.can("agents.logs")) return res.status(403).json({ error: "Your role does not include agent logs." });
  const slug = String(req.params.slug || "");
  if (!SLUG_RE.test(slug) || !req.perm.seesAgent(slug)) return res.status(404).json({ error: "No such agent." });
  try {
    const lines = (await priv.agentLogs(slug, 80)).lines;
    res.json({ html: agentViews.journalHtml(lines), count: lines.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
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
    const list = await priv.serviceList();
    primeFrame(req, list);
    const services = chrome.visibleServices(list, req.perm);
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

/* --------------------------------------------------------- openai voice --- */

/**
 * The voice's configuration, key included, held in this process's memory.
 *
 * It lives in a root-only file the helper owns; reading it costs a sudo call,
 * so it is cached, and dropped the moment Settings changes it. The key never
 * leaves this object: routes get voicePublic(), which has no key in it, and
 * nothing here logs it.
 */
let voiceCache = { at: 0, cfg: null, pending: null };
const VOICE_TTL_MS = 5 * 60 * 1000;

function voiceForget() {
  voiceCache = { at: 0, cfg: null, pending: null };
  voice.clearCache();
  voiceDesk.closeAll(); // a changed key or voice must not keep a front desk open on the old one
  voiceLive.closeAll("settings-changed"); // and no live call keeps talking on the old one
}

/**
 * The voice front desk (TRIAL): a GPT realtime model answers from a read-only
 * snapshot or hands the request to MINT AI (lib/voice-desk.js). Off unless an
 * administrator switches it on in Settings; while off, nothing about the voice
 * changes. A panel setting, not a secret, so it lives in the panel's database.
 */
const VOICE_DESK_SETTING = "voice_desk";
/**
 * The voice mode, one setting with three values (the existing ones kept):
 *   "0" (or unset)  off: the direct path
 *   "1"             the relay front desk
 *   "live"          Live conversation (trial, lib/voice-live.js), for
 *                   administrators (voice.manage); everyone else, and the
 *                   push-to-talk mic, keep the relay desk
 */
const VOICE_MODES = { off: "0", desk: "1", live: "live" };
function voiceMode() {
  try {
    const v = db.getSetting(VOICE_DESK_SETTING, "0");
    return v === "live" ? "live" : v === "1" ? "desk" : "off";
  } catch (_) {
    return "off";
  }
}
function voiceDeskOn() {
  return voiceMode() !== "off";
}
/**
 * How live conversation handles the speaker (a panel setting, JSON):
 *   duplex  "speakers" (half-duplex: the microphone is not heard while the
 *           voice speaks; the default) | "full" (headphones: talk over it).
 *           Each browser can override it from the live bar (remembered there).
 *   noise   OpenAI's input noise reduction: "far_field" (laptop microphone,
 *           the default) | "near_field" (headset) | "off".
 */
const VOICE_LIVE_AUDIO_SETTING = "voice_live_audio";
function liveAudio() {
  let v = {};
  try {
    v = JSON.parse(db.getSetting(VOICE_LIVE_AUDIO_SETTING, "") || "{}") || {};
  } catch (_) {
    v = {};
  }
  return {
    duplex: voiceLive.DUPLEX.includes(v.duplex) ? v.duplex : "speakers",
    noise: voiceLive.NOISE_REDUCTION.includes(v.noise) ? v.noise : "far_field",
  };
}

/**
 * What the voice costs, recorded here from the real usage OpenAI reports for
 * every call -- transcription, the desk's responses, every sentence spoken --
 * per voice turn and per kind of turn (lib/voice-usage.js). Shown in the
 * Command Center's Cost today card. No cap (the administrator's decision of
 * 2026-09-29): the desk is never refused for what it has spent.
 */
const voiceLedger = voiceUsage.createLedger({ insert: (r) => db.voiceUsageInsert(r), rowsSince: (ms) => db.voiceUsageSince(ms) });
function voiceUsageSummary() {
  try {
    return voiceLedger.summary();
  } catch (e) {
    return { error: e.message };
  }
}
/** Record priced calls; a failure to record never fails the voice. */
function recordVoice(fn) {
  try {
    return fn() || 0;
  } catch (e) {
    console.log("voice usage: could not record: " + e.message);
    return 0;
  }
}
/** Speech billing now, and the late part (cut readings) when it lands. */
function recordSpeech({ vt, cat, actor, billing, lateBilling }) {
  const usd = recordVoice(() => voiceLedger.addBilling({ vt, cat, actor, billing }));
  if (lateBilling) lateBilling.then((more) => more && more.length && recordVoice(() => voiceLedger.addBilling({ vt, cat, actor, billing: more })), () => {});
  return usd;
}
function recordTranscription({ vt, actor, heard }) {
  if (!heard || !heard.tokens) return 0;
  return recordVoice(() => voiceLedger.add({ vt, part: "transcription", model: heard.model, tokens: heard.tokens, actor }).usd);
}
function bodyVt(req) {
  return voiceUsage.cleanVt(req.body && req.body.vt);
}

/**
 * How the voice speaks to this user (lib/voice-persona.js): the register and
 * the voice's own gender, learned from how they speak to it and saved on their
 * account. personaHear() reads one utterance and saves (and audits) a change
 * only when the utterance clearly shows one.
 */
function personaOf(userId) {
  try {
    return voicePersona.clean(db.getVoicePersona(userId));
  } catch (_) {
    return voicePersona.clean(null);
  }
}
function personaHear({ userId, username, ip }, text) {
  const saved = personaOf(userId);
  const m = voicePersona.merge(saved, voicePersona.detect(text));
  if (m.changed.length) {
    try {
      db.setVoicePersona(userId, JSON.stringify(m.persona));
      const d = voicePersona.describe(m.persona);
      db.logLogin(ip, username, "voice", `voice persona learned from speech: ${m.changed.map((k) => (k === "dialect" ? "dialect " + d.dialect : "self-gender " + d.gender)).join(", ")}`);
    } catch (e) {
      console.log("voice persona: could not save: " + e.message);
    }
  }
  return m.persona;
}

/**
 * A refusal the page expects (desk off). 409 for a plain JSON caller; a
 * streaming page gets it as its first and only line, so a normal fallback
 * does not show up in the browser console as a failed request.
 */
function deskRefuse(req, res, body) {
  if (/application\/x-ndjson/.test(String(req.get("accept") || ""))) {
    res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ type: "refused", ...body }) + "\n");
  }
  return res.status(409).json(body);
}

function ndjson(res) {
  let open = true;
  res.on("close", () => (open = false));
  return {
    start() {
      res.status(200);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    },
    write(obj) {
      if (open) res.write(JSON.stringify(obj) + "\n");
    },
    end() {
      if (open) res.end();
    },
  };
}

async function voiceConfig() {
  if (voiceCache.cfg && Date.now() - voiceCache.at < VOICE_TTL_MS) return voiceCache.cfg;
  if (voiceCache.pending) return voiceCache.pending;
  const pending = priv
    .voiceKeyRead()
    .then((d) => {
      const cfg = {
        key: d && d.key ? String(d.key) : null,
        model: (d && d.model) || voice.DEFAULTS.model,
        voice: (d && d.voice) || voice.DEFAULTS.voice,
        transcribe_model: (d && d.transcribe_model) || voice.DEFAULTS.transcribe_model,
      };
      if (voiceCache.pending === pending) voiceCache = { at: Date.now(), cfg, pending: null };
      return cfg;
    })
    .catch((e) => {
      if (voiceCache.pending === pending) voiceCache.pending = null;
      return { key: null, ...voice.DEFAULTS, error: e.message };
    });
  voiceCache.pending = pending;
  return pending;
}

/** What a page may know: whether voice works, and with what. Never the key. */
async function voicePublic(req) {
  const cfg = await voiceConfig();
  return {
    configured: !!cfg.key,
    model: cfg.model,
    voice: cfg.voice,
    provider: "OpenAI",
    manage: !!(req && req.perm && req.perm.can("voice.manage")),
    desk: !!cfg.key && voiceDeskOn(),
    mode: voiceMode(),
    // Live conversation: a key, the mode set to live, and an administrator.
    live: !!cfg.key && voiceMode() === "live" && liveAllowed(req && req.perm),
    liveDuplex: liveAudio().duplex,
  };
}

function voiceFail(res, e) {
  const status =
    e.code === "no-key" ? 503 : e.code === "invalid" ? 400 : e.code === "unfaithful" ? 422 : e.code === "timeout" ? 504 : 502;
  res.status(status).json({ error: e.message, code: e.code || "error" });
}

const AUDIO_MIME_RE = /^audio\/[a-z0-9.+-]{1,30}$/;

/**
 * The transcripts this server produced, per user and voice turn: a voice send
 * to MINT AI must be one of them (see /mint-ai/api/send). In memory only; a
 * restart just means a voice turn in flight is said again.
 */
const voiceGrounds = new voiceGuard.Grounds();

/**
 * A recording through lib/voice-intake.js: silence is not sent to OpenAI, and
 * a transcript that is a prompt echo, too long for its audio, or a stock
 * silence phrase is dropped. Returns {text, dropped, heard, audioSeconds}.
 */
function voiceHear(audio, mime, level, cfg) {
  return voiceIntake.intake({ audio, mime: AUDIO_MIME_RE.test(mime) ? mime : "audio/webm", level, cfg, transcribe: voice.transcribeFull });
}

/** Shared by the console and the Command Center: base64 recording in, text out. */
async function voiceTranscribeRoute(req, res) {
  const data = typeof (req.body && req.body.data) === "string" ? req.body.data : "";
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: "No audio arrived.", code: "invalid" });
  const mime = String((req.body && req.body.mime) || "").split(";")[0].trim().toLowerCase();
  const t0 = Date.now();
  const audio = Buffer.from(data, "base64");
  let cfg = null;
  try {
    cfg = await voiceConfig();
    const vt = bodyVt(req);
    // Speech is wanted next ("On it.", then the reply): open a socket now --
    // unless the clip will not even be transcribed.
    if (!voiceIntake.preCheck(audio, voiceIntake.cleanLevel(req.body && req.body.level))) voice.warm(cfg);
    const got = await voiceIntake.transcribeTurn({
      audio,
      mime: AUDIO_MIME_RE.test(mime) ? mime : "audio/webm",
      level: req.body && req.body.level,
      cfg,
      transcribe: voice.transcribeFull,
      grounds: voiceGrounds,
      actor: req.me && req.me.username,
      vt,
    });
    const text = got.text;
    const usd = got.heard ? recordTranscription({ vt, actor: req.me && req.me.username, heard: got.heard }) : 0;
    voiceLog("transcribe", 200, {
      model: cfg.transcribe_model,
      ms: Date.now() - t0,
      bytes: audio.length,
      audio_s: got.audioSeconds != null ? Math.round(got.audioSeconds * 10) / 10 : undefined,
      words: text.split(/\s+/).filter(Boolean).length,
      dropped: got.dropped || undefined,
      echo_of: got.why && got.why.source ? JSON.stringify(got.why.source) : undefined,
      usd: usd ? usd.toFixed(6) : undefined,
    });
    if (got.dropped) return res.json({ text: "", dropped: got.dropped });
    res.json({ text });
  } catch (e) {
    voiceLog("transcribe", e.code || "error", { model: cfg && cfg.transcribe_model, ms: Date.now() - t0, bytes: audio.length, why: e.message });
    voiceFail(res, e);
  }
}

/**
 * One line per voice call in the journal: outcome, model, timings, sizes.
 * Never the key, never what was said -- counts only.
 */
function voiceLog(kind, status, f) {
  const parts = ["voice", kind, String(status)];
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(k + "=" + (k === "why" ? JSON.stringify(voice.scrub(String(v)).slice(0, 120)) : v));
  }
  console.log(parts.join(" "));
}

/**
 * One sentence in, its audio out.
 *
 * Streamed (Accept: application/x-ndjson, what the Command Center asks for):
 * one JSON object a line, as OpenAI produces the reading --
 *   {type:"start", engine, rate}  a reading begins
 *   {type:"audio", pcm}           PCM16 mono 24 kHz, base64
 *   {type:"cut", why}             the reading failed the verbatim check (or
 *                                 broke) mid-way: stop it and drop what came
 *                                 since its start; a start from the fallback
 *                                 (gpt-4o-mini-tts, which reads verbatim)
 *                                 follows and reads the sentence from its start
 *   {type:"end", engine, fallback, cached} | {type:"skipped", why} | {type:"error"}
 * Whole (anything else, e.g. the console): a WAV -- or 204 when the voice
 * would not read it as written.
 *
 * Body: {text, vt?, cat?} -- vt ties the sentence to a voice turn and cat says
 * what kind (the direct path by default), for the usage figures.
 */
async function voiceSpeakRoute(req, res) {
  const text = typeof (req.body && req.body.text) === "string" ? req.body.text : "";
  if (!text.trim()) return res.status(400).json({ error: "Nothing to say.", code: "invalid" });
  const t0 = Date.now();
  const words = text.split(/\s+/).filter(Boolean).length;
  const vt = bodyVt(req);
  const cat = voiceUsage.cleanCat(req.body && req.body.cat) || "direct";
  const actor = req.me && req.me.username;
  const streamed = /application\/x-ndjson/.test(String(req.get("accept") || ""));
  let cfg = null;
  if (streamed) {
    const out = ndjson(res);
    let started = false;
    const write = (o) => {
      if (!started) {
        out.start();
        started = true;
      }
      out.write(o);
    };
    let aborted = false;
    res.on("close", () => (aborted = !res.writableEnded));
    let bytes = 0;
    try {
      cfg = await voiceConfig();
      const r = await voice.speakStream(text, cfg, {
        start: ({ engine }) => write({ type: "start", engine, rate: voice.RATE }),
        audio: (b) => {
          bytes += b.length;
          write({ type: "audio", pcm: b.toString("base64") });
        },
        cut: ({ why }) => {
          bytes = 0;
          write({ type: "cut", why });
        },
      });
      const usd = recordSpeech({ vt, cat, actor, billing: r.billing, lateBilling: r.lateBilling });
      voiceLog("speak", 200, {
        engine: r.cached ? undefined : r.engine,
        ms: Date.now() - t0,
        first_audio_ms: r.firstAudioMs,
        warm: r.cached ? undefined : r.warm ? 1 : 0,
        cached: r.cached ? 1 : undefined,
        fallback: r.fallback ? r.why || "unfaithful" : undefined,
        cuts: r.cuts || undefined,
        audio_s: Math.round((bytes / (voice.RATE * 2)) * 100) / 100,
        words,
        streamed: 1,
        aborted: aborted ? 1 : undefined,
        usd: usd ? usd.toFixed(6) : undefined,
      });
      write({ type: "end", engine: r.cached ? "cache" : r.fallback ? "fallback" : "realtime", fallback: !!r.fallback, cached: !!r.cached });
      out.end();
    } catch (e) {
      if (e.billing) recordSpeech({ vt, cat, actor, billing: e.billing, lateBilling: e.lateBilling });
      voiceLog("speak", e.code === "unfaithful" ? 204 : e.code || "error", { model: cfg && cfg.model, ms: Date.now() - t0, words, streamed: 1, why: e.message });
      if (!started && e.code !== "unfaithful") return voiceFail(res, e);
      // Unfaithful and no fallback: skipped -- the sentence stays on screen.
      write(e.code === "unfaithful" ? { type: "skipped", why: "unfaithful" } : { type: "error", error: voice.scrub(e.message), code: e.code || "error" });
      out.end();
    }
    return;
  }
  try {
    cfg = await voiceConfig();
    const out = await voice.speak(text, cfg);
    const usd = recordSpeech({ vt, cat, actor, billing: out.billing, lateBilling: out.lateBilling });
    voiceLog("speak", 200, {
      engine: out.engine || cfg.model,
      ms: Date.now() - t0,
      first_audio_ms: out.firstAudioMs,
      warm: out.cached ? undefined : out.warm ? 1 : 0,
      cached: out.cached ? 1 : undefined,
      fallback: out.fallback ? out.why || "unfaithful" : undefined,
      audio_s: Math.round(((out.wav.length - 44) / (voice.RATE * 2)) * 100) / 100,
      words,
      usd: usd ? usd.toFixed(6) : undefined,
    });
    res.set({
      "Content-Type": "audio/wav",
      "Content-Length": String(out.wav.length),
      "Cache-Control": "no-store",
      "X-Voice-Engine": out.fallback ? "fallback" : out.cached ? "cache" : "realtime",
    });
    res.send(out.wav);
  } catch (e) {
    if (e.billing) recordSpeech({ vt, cat, actor, billing: e.billing, lateBilling: e.lateBilling });
    voiceLog("speak", e.code === "unfaithful" ? 204 : e.code || "error", { model: cfg && cfg.model, ms: Date.now() - t0, words, why: e.message });
    // Not an error to the page: the sentence is skipped, and it stays on screen.
    // With the text-to-speech fallback this should now be rare; the page says so when it happens.
    if (e.code === "unfaithful") return res.status(204).set({ "X-Voice-Skipped": "unfaithful", "Cache-Control": "no-store" }).end();
    voiceFail(res, e);
  }
}

/* Settings: the key is write-only. It is posted once, handed to the helper on
   stdin, and from then on the panel shows its last four characters. */

async function voiceSettings() {
  try {
    return await priv.voiceStatus();
  } catch (e) {
    return { error: e.message, configured: false, ...voice.DEFAULTS };
  }
}

app.get("/credentials/openai-voice", requireAuth, requirePerm("voice.manage"), async (req, res) => {
  const v = await voiceSettings();
  if (v.error) return res.status(500).send(views.error("Voice settings unavailable", v.error));
  const test = req.query.test ? { ok: req.query.test === "ok", text: String(req.query.t || "").slice(0, 600) } : null;
  const list = req.perm.can("credentials.view") ? await priv.credentialList().catch(() => []) : [];
  res.send(
    credentialViews.voice({
      csrf: res.locals.csrf,
      user: ctx(req),
      credentials: list,
      voice: v,
      desk: { on: voiceDeskOn(), mode: voiceMode(), row: db.settingRow(VOICE_DESK_SETTING), model: voiceDesk.DESK_MODEL, liveModel: voiceLive.LIVE_MODEL, usage: voiceUsageSummary(), liveAudio: liveAudio() },
      persona: voicePersona.describe(personaOf(req.me.id)),
      models: voice.MODELS,
      voices: voice.VOICES,
      transcribeModels: voice.TRANSCRIBE_MODELS,
      test,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/credentials/openai-voice/key", requireAuth, requirePerm("voice.manage"), requireCsrf, async (req, res) => {
  const value = String((req.body && req.body.value) || "").trim();
  try {
    const out = await priv.voiceKeySet(value);
    voiceForget();
    db.logLogin(req.ip, req.me.username, "voice", "set the OpenAI voice key (…" + out.last4 + ")");
    res.redirect("/credentials/openai-voice?msg=" + encodeURIComponent("Key saved. Press Test to check it."));
  } catch (e) {
    res.redirect("/credentials/openai-voice?err=" + encodeURIComponent(priv.redact(e.message)));
  }
});

app.post("/credentials/openai-voice/clear", requireAuth, requirePerm("voice.manage"), requireCsrf, async (req, res) => {
  try {
    await priv.voiceKeyClear();
    voiceForget();
    db.logLogin(req.ip, req.me.username, "voice", "removed the OpenAI voice key");
    res.redirect("/credentials/openai-voice?msg=" + encodeURIComponent("Key removed. Voice is off until a key is added."));
  } catch (e) {
    res.redirect("/credentials/openai-voice?err=" + encodeURIComponent(e.message));
  }
});

app.post("/credentials/openai-voice/options", requireAuth, requirePerm("voice.manage"), requireCsrf, async (req, res) => {
  const model = field(req.body, "model");
  const name = field(req.body, "voice");
  const tmodel = field(req.body, "transcribe_model");
  if (!voice.MODELS.some((m) => m.id === model) || !voice.VOICES.includes(name) || !voice.TRANSCRIBE_MODELS.some((m) => m.id === tmodel)) {
    return res.redirect("/credentials/openai-voice?err=" + encodeURIComponent("Pick a model, voice and listening model from the lists."));
  }
  try {
    await priv.voiceOptionsSet(model, name, tmodel);
    voiceForget();
    db.logLogin(req.ip, req.me.username, "voice", `voice settings ${model} / ${name} / ${tmodel}`);
    res.redirect("/credentials/openai-voice?msg=" + encodeURIComponent("Voice settings saved."));
  } catch (e) {
    res.redirect("/credentials/openai-voice?err=" + encodeURIComponent(e.message));
  }
});

/*
 * The voice persona: learned from speech, or chosen here from a fixed list of
 * presets (lib/voice-persona.js PRESETS) -- never typed. A choice is kept until
 * it is changed here or reset; speech never overrides it. Reset forgets it and
 * learns again.
 */
app.post("/credentials/openai-voice/persona", requireAuth, requirePerm("voice.manage"), requireCsrf, (req, res) => {
  const preset = field(req.body, "preset");
  const p = voicePersona.choose(preset);
  if (!p) return res.redirect("/credentials/openai-voice?err=" + encodeURIComponent("Choose one of the voice personas.") + "#v-persona");
  const was = voicePersona.describe(personaOf(req.me.id));
  db.setVoicePersona(req.me.id, p.mode === "explicit" ? JSON.stringify(p) : "");
  const now = voicePersona.describe(p);
  db.logLogin(req.ip, req.me.username, "voice", `voice persona set to "${now.choice}" (was "${was.choice}")`);
  res.redirect("/credentials/openai-voice?msg=" + encodeURIComponent(p.mode === "explicit" ? `Voice persona: ${now.choice}. Arabic replies use it from the next utterance; English stays English.` : "Voice persona: learned from how you speak again.") + "#v-persona");
});

app.post("/credentials/openai-voice/persona/reset", requireAuth, requirePerm("voice.manage"), requireCsrf, (req, res) => {
  db.setVoicePersona(req.me.id, "");
  db.logLogin(req.ip, req.me.username, "voice", "reset the voice persona (back to learning from speech; register and self-gender forgotten)");
  res.redirect("/credentials/openai-voice?msg=" + encodeURIComponent("Voice persona reset. It is learned again from how you speak.") + "#v-persona");
});

app.post("/credentials/openai-voice/desk", requireAuth, requirePerm("voice.manage"), requireCsrf, (req, res) => {
  // mode=off|desk|live, or the older enabled=1|0 (off / relay desk).
  const m = field(req.body, "mode");
  const e = field(req.body, "enabled");
  const mode = m ? (Object.prototype.hasOwnProperty.call(VOICE_MODES, m) ? m : null) : e === "1" ? "desk" : e === "0" ? "off" : null;
  if (!mode) return res.redirect("/credentials/openai-voice?err=" + encodeURIComponent("Choose off, the relay desk or live conversation."));
  const was = voiceMode();
  db.setSetting(VOICE_DESK_SETTING, VOICE_MODES[mode], req.me.username);
  if (mode === "off") voiceDesk.closeAll();
  if (mode !== "live") voiceLive.closeAll("mode-changed");
  const label = { off: "off", desk: "relay desk on", live: "live conversation (trial) on" }[mode];
  db.logLogin(req.ip, req.me.username, "voice", `voice front desk (GPT, trial) ${label}${was === mode ? " (unchanged)" : ""}`);
  const msg = {
    off: "Voice front desk is off. The Command Center's voice talks to MINT AI directly again.",
    desk: "Voice front desk is on. Reload the Command Center to use it.",
    live: "Live conversation (trial) is on for administrators. Reload the Command Center and pick it in the voice menu; headphones are advised.",
  }[mode];
  res.redirect("/credentials/openai-voice?msg=" + encodeURIComponent(msg) + "#v-desk");
});

app.post("/credentials/openai-voice/live-audio", requireAuth, requirePerm("voice.manage"), requireCsrf, (req, res) => {
  const duplex = field(req.body, "duplex");
  const noise = field(req.body, "noise");
  if (!voiceLive.DUPLEX.includes(duplex) || !voiceLive.NOISE_REDUCTION.includes(noise)) {
    return res.redirect("/credentials/openai-voice?err=" + encodeURIComponent("Choose speakers or headphones, and a noise reduction.") + "#v-live");
  }
  const was = liveAudio();
  db.setSetting(VOICE_LIVE_AUDIO_SETTING, JSON.stringify({ duplex, noise }), req.me.username);
  db.logLogin(req.ip, req.me.username, "voice", `live conversation audio: ${duplex === "speakers" ? "speakers mode" : "headphones mode"}, noise reduction ${noise} (was ${was.duplex}, ${was.noise})`);
  res.redirect("/credentials/openai-voice?msg=" + encodeURIComponent("Live conversation audio saved. It applies to the next call; each browser can still switch from the live bar.") + "#v-live");
});

app.post("/credentials/openai-voice/test", requireAuth, requirePerm("voice.manage"), requireCsrf, async (req, res) => {
  voiceForget(); // test what is on disk now, not a cached copy
  let ok = false;
  let text;
  try {
    const out = await voice.check(await voiceConfig());
    ok = out.faithful && !!out.heard;
    text =
      `${out.model} (${out.voice}) spoke ${out.seconds != null ? out.seconds + " s of audio " : ""}in ${out.speak_ms} ms` +
      (out.faithful ? ", word for word" : `, but not as written — it said “${out.speak_transcript}”`) +
      (out.heard != null ? `; listening heard “${out.heard}” in ${out.transcribe_ms} ms.` : ".");
  } catch (e) {
    text = e.message;
  }
  db.logLogin(req.ip, req.me.username, "voice", "tested the OpenAI voice key: " + (ok ? "ok" : "failed"));
  res.redirect("/credentials/openai-voice?test=" + (ok ? "ok" : "fail") + "&t=" + encodeURIComponent(priv.redact(voice.scrub(text))));
});

/* ---------------------------------------------------------- credentials --- */

app.get("/credentials", requireAuth, requirePerm("credentials.view"), async (req, res) => {
  const data = await gather({
    credentials: () => priv.credentialList(),
    probe: () => priv.systemProbe(),
  });
  const voiceState = req.perm.can("voice.manage") ? await voiceSettings() : null;
  res.send(
    credentialViews.index({
      csrf: res.locals.csrf,
      user: ctx(req),
      credentials: data.credentials || [],
      probe: data.probe || null,
      voice: voiceState,
      flash: req.query.msg || null,
      err: req.query.err || data.errors.credentials || null,
    })
  );
});

app.get("/credentials/:name", requireAuth, requirePerm("credentials.view"), async (req, res) => {
  const name = String(req.params.name || "");
  try {
    const credential = await priv.credentialGet(name);
    const list = await priv.credentialList().catch(() => [credential]);
    res.send(
      credentialViews.detail({
        csrf: res.locals.csrf,
        user: ctx(req),
        credential,
        credentials: list,
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
      voice: await voicePublic(req),
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
      voice: await voicePublic(req),
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

/**
 * Dictation and live mode: the recording goes to OpenAI's transcription model
 * from here, never from the browser. Nothing is saved -- the audio is posted,
 * the text comes back, and the recording is gone.
 */
app.post("/console/:id/transcribe", requireAuth, requirePerm("console.use"), consoleUploadBody, requireCsrf, async (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  if (rootLocked(req, session))
    return res.status(401).json({ error: "This chat needs an authenticator code again." });
  return voiceTranscribeRoute(req, res);
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

/**
 * Speak one sentence of a reply, through OpenAI's realtime voice.
 *
 * Called once per sentence rather than once per turn: the browser plays each
 * clip while fetching the next, so the first words arrive shortly after the
 * reply starts instead of after the whole thing is written.
 *
 * The text comes from the client, which sounds worse than it is -- it is the
 * client's own transcript being read back to the person who is already looking
 * at it. Nothing here reads the session, and a chat still locked behind a code
 * is refused anyway, so this cannot be used to listen to one.
 */
app.post("/console/:id/speak", requireAuth, requirePerm("console.use"), requireCsrf, async (req, res) => {
  const session = loadConsoleSession(req, res);
  if (!session) return;
  if (rootLocked(req, session))
    return res.status(401).json({ error: "This chat needs an authenticator code again." });
  return voiceSpeakRoute(req, res);
});

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

/* --------------------------------------------------------------- moni ai --- */

/**
 * MINT AI: the JSON / SSE API the Command Center page consumes.
 *
 * Everything proxies to the MINT AI supervisor's unix socket (lib/moniai.js),
 * which owns the one long-lived root Claude Code session that delegates to the
 * others. One permission, moniai.use, in no stock role: it reaches a root
 * session that can message every other session on the machine, so it is the
 * administrator's until a role is deliberately given it.
 *
 * API routes answer in JSON, including their refusals -- a page polling for
 * status should get {"error": ...} and a status code, not a login form.
 * Writes take the CSRF token in the JSON body (_csrf) or an X-CSRF-Token
 * header. Every write reaches the supervisor with the panel user as actor, and
 * the supervisor audits it; the panel's own audit gets a line as well.
 */

function requireApiPerm(perm) {
  return (req, res, next) => {
    if (!req.me) return res.status(401).json({ error: "Sign in first." });
    if (!req.perm.can(perm)) return res.status(403).json({ error: "Your role does not include MINT AI." });
    next();
  };
}

function requireApiCsrf(req, res, next) {
  const supplied = (req.body && req.body._csrf) || req.get("x-csrf-token");
  if (!supplied || supplied !== req.session.csrf) {
    return res.status(403).json({ error: "Invalid CSRF token. Reload the page and try again." });
  }
  next();
}

const moniAiGuard = [requireApiPerm("moniai.use")];
const moniAiWrite = [requireApiPerm("moniai.use"), requireApiCsrf];

function moniAiFail(res, e) {
  const status =
    e.code === "invalid" ? 400 : e.code === "refused" ? 409 : e.code === "offline" ? 503 : e.code === "timeout" ? 504 : 500;
  res.status(status).json({ error: e.message, code: e.code || "error" });
}

/** Memory counts for the rail. The helper call is slow, so it is cached. */
let moniAiMemory = { at: 0, data: null, pending: null };
async function moniAiMemoryCounts() {
  if (moniAiMemory.data && Date.now() - moniAiMemory.at < 60000) return moniAiMemory.data;
  if (moniAiMemory.pending) return moniAiMemory.pending;
  moniAiMemory.pending = priv
    .ccMemoryStats()
    .then((s) => {
      const db = (s && s.db) || {};
      const chunks = db.chunks || {};
      const data = {
        facts: db.facts ? db.facts.current : null,
        chunks: Object.values(chunks).reduce((a, b) => a + (Number(b) || 0), 0) || null,
        sessions: db.sessions_indexed == null ? null : db.sessions_indexed,
        last_ingest: db.last_ingest || null,
        last_facts: db.last_facts || null,
        topics: Array.isArray(db.topics) ? db.topics.slice(0, 6).map((t) => String(t).slice(0, 40)) : [],
        healthy: !!(s && s.health && s.health.ok),
      };
      moniAiMemory = { at: Date.now(), data, pending: null };
      return data;
    })
    .catch((e) => {
      moniAiMemory.pending = null;
      return { error: e.message };
    });
  return moniAiMemory.pending;
}

/**
 * Agent counts for the rail: how many, how many running, and on which kinds of
 * channel. Only counts and channel types leave here -- an agent's role text,
 * allowed users and addon settings are the agents pages' business. Cached for
 * a minute like the memory counts, because it is a helper call.
 */
let moniAiAgents = { at: 0, data: null, pending: null };
async function moniAiAgentCounts(req) {
  if (!req.perm.can("agents.view")) return null;
  if (!(moniAiAgents.data && Date.now() - moniAiAgents.at < 60000)) {
    if (!moniAiAgents.pending) {
      moniAiAgents.pending = priv
        .agentList()
        .then((list) => {
          moniAiAgents = { at: Date.now(), data: Array.isArray(list) ? list : [], pending: null };
          return moniAiAgents.data;
        })
        .catch((e) => {
          moniAiAgents.pending = null;
          throw e;
        });
    }
    await moniAiAgents.pending;
  }
  const mine = scopeAgents(req, moniAiAgents.data);
  const types = [...new Set(mine.map((a) => a.channel && a.channel.type).filter(Boolean))];
  return {
    total: mine.length,
    active: mine.filter((a) => a.state && a.state.active === "active").length,
    channels: types.map((t) => String(t).slice(0, 20)),
  };
}

/** What the page's voice controls can rely on: whether a key is set, and which voice. */
function moniAiVoice(req) {
  return voicePublic(req);
}

app.get("/mint-ai", requireAuth, async (req, res) => {
  // The tab is shared with the older console: someone who may use that but not
  // MINT AI lands where they are allowed to be rather than on a refusal.
  if (!req.perm.can("moniai.use")) {
    if (req.perm.can("console.use")) return res.redirect("/console");
    return requirePerm("moniai.use")(req, res, () => {});
  }
  res.send(
    moniAiViews.page({
      csrf: res.locals.csrf,
      user: ctx(req, "console"),
      voice: await moniAiVoice(req),
      core: req.me.mint_core,
    })
  );
});

/**
 * The MINT AI core, per person: A (dotted sphere), B (Siri fluid) or C
 * (hybrid, the default). Saved on the user row (users.mint_core) and written
 * into the Command Center as data-core, so the page paints the right core from
 * its first frame. Two ways to change it, one rule: the Command Center's quick
 * switch (JSON, below) and Account > Appearance (a form, further down; its page
 * script uses the JSON route too). Both need moniai.use -- someone who cannot
 * open the Command Center has no core to choose -- and both leave an audit
 * line ("account": "MINT AI core ...").
 */
function setMintCore(req, core) {
  const was = mintLogic.normCore(req.me.mint_core);
  db.setUserMintCore(req.me.id, core);
  db.logLogin(req.ip, req.me.username, "account", `MINT AI core ${was} -> ${core} (${mintLogic.CORES[core]})${was === core ? " (unchanged)" : ""}`);
}
app.post("/mint-ai/api/prefs/core", ...moniAiWrite, (req, res) => {
  const core = req.body && req.body.core;
  if (!mintLogic.isCore(core)) return res.status(400).json({ error: "The core must be A, B or C.", code: "invalid" });
  setMintCore(req, core);
  res.json({ core, name: mintLogic.CORES[core] });
});

app.get("/mint-ai/api/status", ...moniAiGuard, async (req, res) => {
  try {
    res.json(await moniai.call("status", {}, req.me.username));
  } catch (e) {
    moniAiFail(res, e);
  }
});

/** Everything the page needs on load, in one round trip. */
app.get("/mint-ai/api/overview", ...moniAiGuard, async (req, res) => {
  const who = req.me.username;
  const [status, sessions, delegations, memory, agents, voiceInfo, missions, decisions, orders, watchers] = await Promise.allSettled([
    moniai.call("status", {}, who),
    moniai.call("sessions", {}, who),
    moniai.call("ledger", { table: "delegations", limit: 30 }, who),
    moniAiMemoryCounts(),
    moniAiAgentCounts(req),
    moniAiVoice(req),
    moniai.call("missions", { status: "all", limit: 20 }, who),
    moniai.call("decisions", { status: "open" }, who),
    moniai.call("orders", {}, who),
    moniai.call("watchers", {}, who),
  ]);
  const opt = (r, key) => (r.status === "fulfilled" ? r.value[key] : null);
  if (status.status === "rejected") return moniAiFail(res, status.reason);
  res.json({
    status: status.value,
    sessions: sessions.status === "fulfilled" ? sessions.value : { error: sessions.reason.message },
    timeline: delegations.status === "fulfilled" ? delegations.value.rows : [],
    memory: memory.status === "fulfilled" ? memory.value : { error: memory.reason.message },
    agents: agents.status === "fulfilled" ? agents.value : { error: agents.reason.message },
    voice: voiceInfo.status === "fulfilled" ? voiceInfo.value : { configured: false },
    viewer: { name: req.me.display_name || req.me.username, csrf: res.locals.csrf },
    missions: opt(missions, "missions"),
    decisions: opt(decisions, "decisions"),
    orders: opt(orders, "orders"),
    orders_tz: opt(orders, "tz"),
    telegram: opt(orders, "telegram"),
    watchers: opt(watchers, "watchers"),
  });
});

app.get("/mint-ai/api/sessions", ...moniAiGuard, async (req, res) => {
  try {
    res.json(await moniai.call("sessions", {}, req.me.username));
  } catch (e) {
    moniAiFail(res, e);
  }
});

app.get("/mint-ai/api/memory", ...moniAiGuard, async (req, res) => {
  res.json(await moniAiMemoryCounts());
});

app.get("/mint-ai/api/rc", ...moniAiGuard, async (req, res) => {
  try {
    res.json(await moniai.call("rc-url", {}, req.me.username));
  } catch (e) {
    moniAiFail(res, e);
  }
});

app.get("/mint-ai/api/ledger/:table", ...moniAiGuard, async (req, res) => {
  try {
    const params = moniai.cleanLedger(req.params.table, req.query || {});
    res.json(await moniai.call("ledger", params, req.me.username));
  } catch (e) {
    moniAiFail(res, e);
  }
});

/**
 * Live events as Server-Sent Events.
 *
 * A GET, so it carries no CSRF token, which is fine: it changes nothing, and
 * the session cookie is SameSite=strict. `Last-Event-ID` (or ?since=) resumes
 * from the supervisor's ring buffer after a reconnect. X-Accel-Buffering stops
 * nginx holding events back until a buffer fills.
 */
app.get("/mint-ai/api/events", ...moniAiGuard, (req, res) => {
  const since = moniai.cleanSince(req.get("last-event-id") || (req.query && req.query.since));
  // This tab's id (sessionStorage): MINT AI's screen actions reach only the tab that asked.
  const tab = typeof (req.query && req.query.tab) === "string" && uiTab.test(req.query.tab) ? req.query.tab : null;
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  const beat = setInterval(() => res.write(": keep-alive\n\n"), 20000);
  const close = moniai.subscribe(
    since,
    req.me.username,
    (ev) => {
      if (ev.type === "ui") return uiDeliver(ev, req, tab, res); // never written as it came
      const data = JSON.stringify(ev);
      res.write((ev.seq ? `id: ${ev.seq}\n` : "") + `event: ${ev.type}\ndata: ${data}\n\n`);
    },
    (err) => {
      clearInterval(beat);
      if (err) res.write(`event: offline\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  );
  req.on("close", () => {
    clearInterval(beat);
    close();
  });
});

/**
 * One of MINT AI's screen actions (its MCP ui_action, relayed live by the
 * supervisor), as seen by the event stream of one tab. lib/ui-relay.js decides:
 * only the tab whose send minted the token acts on it, once; an event with a
 * token this server never minted (a send forged onto the supervisor's socket)
 * is dropped and audited. call.* act on the administrator's live call here;
 * everything else goes to the tab, which answers through /ui/ack.
 */
function uiDeliver(ev, req, tab, res) {
  const actor = req.me.username;
  const r = uiRelay.route(ev, actor, tab);
  const what = `${String(ev.action || "?").slice(0, 40)}${ev.args && Object.keys(ev.args).length ? " " + JSON.stringify(ev.args).slice(0, 120) : ""}`;
  const ack = (ok, why) => moniai.call("ui-ack", { nonce: ev.nonce, ok, ...(why ? { why: String(why).slice(0, 200) } : {}) }, actor).catch(() => {});
  if (r.forged) {
    db.logLogin(req.ip, actor, "mint-ui", `dropped a screen action (${what}) whose token this panel never minted`);
    return;
  }
  if (!r.deliver) return;
  const v = UiActions.validate(ev.action, ev.args || {});
  if (!v.ok) return void ack(false, v.why);
  db.logLogin(req.ip, actor, "mint-ui", `${what} by MINT AI (turn ${ev.turn_id}), to the tab that asked`);
  if (v.where === "server") {
    const call = voiceLive.callFor(actor);
    if (!call) return void ack(false, "no voice call is open");
    const out = call.deepUi(v);
    return void ack(out.ok, out.why);
  }
  res.write(`event: ui\ndata: ${JSON.stringify({ type: "ui", nonce: ev.nonce, action: v.action, args: v.args, toast: UiActions.toast(v.action, v.args), deep: true })}\n\n`);
}

/** The tab's answer to one of MINT AI's screen actions: done, or refused and why. */
app.post("/mint-ai/api/ui/ack", ...moniAiWrite, async (req, res) => {
  const b = req.body || {};
  if (typeof b.nonce !== "string" || !/^[A-Za-z0-9]{8,40}$/.test(b.nonce) || typeof b.ok !== "boolean") return res.status(400).json({ error: "Bad answer." });
  if (!uiRelay.takeAck(b.nonce, req.me.username)) return res.status(404).json({ error: "No such screen action is waiting." });
  try {
    const why = typeof b.why === "string" ? b.why.replace(/[\u0000-\u001f]/g, " ").slice(0, 200) : "";
    res.json(await moniai.call("ui-ack", { nonce: b.nonce, ok: b.ok, ...(why ? { why } : {}) }, req.me.username));
  } catch (e) {
    moniAiFail(res, e);
  }
});

app.post("/mint-ai/api/send", ...moniAiWrite, async (req, res) => {
  try {
    const params = moniai.cleanSend(req.body || {});
    // A voice turn (the page sends its voice-turn id): MINT AI gets exactly
    // what this server heard for it, once -- never a prompt echo, never words
    // that no transcript here produced. Typed turns are the administrator's
    // own keystrokes and pass as before.
    const refusal = voiceIntake.sendRefusal({ grounds: voiceGrounds, actor: req.me.username, body: req.body || {}, text: params.text });
    if (refusal) {
      voiceLog("send", "refused", { rule: refusal.rule, source: refusal.source ? JSON.stringify(refusal.source) : undefined });
      return res.status(422).json({ error: "That voice turn was not sent: it does not match what was heard.", code: "ungrounded" });
    }
    db.logLogin(req.ip, req.me.username, "moni-ai", `turn${params.target ? " for " + params.target : ""}`);
    // A one-time ui token for this send, from this tab (lib/ui-relay.js).
    const ut = uiRelay.mint({ actor: req.me.username, tab: (req.body || {}).tab, via: "page" });
    if (ut) params.ut = ut;
    const sent = await moniai.call("send", params, req.me.username);
    if (ut && sent && sent.turn) uiRelay.bind(ut, sent.turn.id); // this token, that turn only
    res.json(sent);
  } catch (e) {
    moniAiFail(res, e);
  }
});

app.post("/mint-ai/api/interrupt", ...moniAiWrite, async (req, res) => {
  try {
    res.json(await moniai.call("interrupt", {}, req.me.username));
  } catch (e) {
    moniAiFail(res, e);
  }
});

app.post("/mint-ai/api/approvals/:id/:decision", ...moniAiWrite, async (req, res) => {
  const decision = req.params.decision;
  if (decision !== "approve" && decision !== "deny") return res.status(404).json({ error: "No such action." });
  try {
    const params = { approval_id: moniai.cleanApprovalId(req.params.id) };
    const note = moniai.cleanNote(req.body && req.body.note);
    if (note) params.note = note;
    const always = decision === "approve" ? moniai.cleanAlwaysRule(req.body) : null;
    if (always) Object.assign(params, always);
    const out = await moniai.call(decision, params, req.me.username);
    db.logLogin(req.ip, req.me.username, "moni-ai", `${decision === "approve" ? "approved" : "denied"} request ${params.approval_id}${always ? " and saved an always-allow rule" : ""}`);
    res.json(out);
  } catch (e) {
    moniAiFail(res, e);
  }
});

app.post("/mint-ai/api/rc", ...moniAiWrite, async (req, res) => {
  const enabled = req.body && req.body.enabled;
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false." });
  try {
    db.logLogin(req.ip, req.me.username, "moni-ai", `remote control ${enabled ? "on" : "off"}`);
    res.json(await moniai.call("rc", { enabled }, req.me.username, { timeout: 60000 }));
  } catch (e) {
    moniAiFail(res, e);
  }
});

/**
 * Voice for the Command Center, through OpenAI and only through this server:
 * the recording is posted here and transcribed with the key held here; a reply
 * is read aloud a sentence at a time and comes back as a WAV. The browser
 * never talks to OpenAI. Nothing is saved.
 */
const moniAiAudioBody = express.json({ limit: "44mb" });

app.post("/mint-ai/api/transcribe", requireApiPerm("moniai.use"), moniAiAudioBody, requireApiCsrf, voiceTranscribeRoute);

app.post("/mint-ai/api/speak", ...moniAiWrite, voiceSpeakRoute);

/**
 * The voice front desk (TRIAL, off by default): one utterance in -- a recording,
 * or text -- and what the desk says back, streamed as NDJSON as it happens:
 * {type:"heard"}; per released sentence {type:"line", i, text} and then its
 * audio as it is read -- {type:"start"|"audio"|"cut"|"end", i, ...}, strictly
 * in sentence order (voiceDesk.createSpeaker); {type:"asked", turn} for a
 * request passed to MINT AI; and {type:"done"} with what the turn cost and the
 * voice usage figures. The page reads MINT AI's answer later through
 * /desk/summary. Refused with 409 while the Settings switch is off
 * ("desk-off"), so the page falls back to the direct path. There is no budget.
 */
app.post("/mint-ai/api/desk/turn", requireApiPerm("moniai.use"), moniAiAudioBody, requireApiCsrf, async (req, res) => {
  if (!voiceDeskOn()) return deskRefuse(req, res, { error: "The voice front desk is off.", code: "desk-off" });
  const t0 = Date.now();
  const body = req.body || {};
  const vt = bodyVt(req);
  const actor = req.me.username;
  let cfg = null;
  let heard = "";
  let tTranscribe = null;
  let transcribeUsd = 0;
  const out = ndjson(res);
  let started = false;
  try {
    cfg = await voiceConfig();
    if (!cfg.key) throw new voice.VoiceError("Add an OpenAI key in Settings to use voice.", "no-key");
    const desk = () => voiceDesk.deskFor(req.me.username, cfg, moniCall, { log: (m) => console.log(m) });
    let dropped = null;
    if (typeof body.text === "string" && body.text.trim()) {
      if (body.text.length > 4000 || body.text.includes("\u0000")) return res.status(400).json({ error: "That is too long.", code: "invalid" });
      heard = body.text.trim();
      const door = voiceGuard.refuseAtDoor(heard);
      if (door) {
        dropped = door.rule;
        heard = "";
      }
    } else {
      const data = typeof body.data === "string" ? body.data : "";
      if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: "No audio arrived.", code: "invalid" });
      const mime = String(body.mime || "").split(";")[0].trim().toLowerCase();
      const audio = Buffer.from(data, "base64");
      // Nothing is opened for a clip that will not be transcribed.
      if (!voiceIntake.preCheck(audio, voiceIntake.cleanLevel(body.level))) {
        desk().open(); // the socket opens while the words are transcribed
        voice.warm(cfg); // and the reader's, for the first sentence
      }
      const got = await voiceHear(audio, mime, body.level, cfg);
      heard = got.text;
      dropped = got.dropped;
      if (got.heard) transcribeUsd = recordTranscription({ vt, actor, heard: got.heard });
      tTranscribe = Date.now() - t0;
    }
    if (dropped) voiceLog("desk", 200, { ms: Date.now() - t0, transcribe_ms: tTranscribe, dropped, lines: 0 });
    out.start();
    started = true;
    // "Stop listening" said aloud: the page closes the mic, and the desk
    // neither answers it nor passes it to MINT AI.
    const stop = !!heard && voiceStop.heard(heard);
    // "Undo" said while the tab can still undo its last screen action: the
    // page undoes it, and the desk neither answers it nor passes it on.
    const undo = !stop && body.undoable === true && !!heard && voiceStop.undo(heard);
    out.write({ type: "heard", text: heard && !/^[\[(]/.test(heard) ? heard : "", stop: stop || undefined, undo: undo || undefined });
    if (!heard || /^[\[(]/.test(heard)) {
      out.write({ type: "done", asked: [], lines: 0, cost_usd: transcribeUsd, usage: voiceUsageSummary() });
      return out.end();
    }
    if (undo) {
      voiceLog("desk", 200, { ms: Date.now() - t0, transcribe_ms: tTranscribe, undo: "voice-command", lines: 0 });
      db.logLogin(req.ip, req.me.username, "mint-ui", "undo by the voice front desk");
      out.write({ type: "done", asked: [], lines: 0, undo: true, cost_usd: transcribeUsd, usage: voiceUsageSummary() });
      return out.end();
    }
    if (stop) {
      voiceLog("desk", 200, { ms: Date.now() - t0, transcribe_ms: tTranscribe, stop: "voice-command", lines: 0 });
      out.write({ type: "done", asked: [], lines: 0, stop: true, cost_usd: transcribeUsd, usage: voiceUsageSummary() });
      return out.end();
    }
    const speaker = voiceDesk.createSpeaker({ speak: voice.speakStream, cfg, write: out.write, t0 });
    const persona = personaHear({ userId: req.me.id, username: req.me.username, ip: req.ip }, heard);
    const r = await desk().turn(heard, {
      onLine: (line) => speaker.push(line),
      persona,
      // A hand-off to MINT AI carries a ui token for this tab (UI control Phase 2).
      uiTicket: () => uiRelay.mint({ actor, tab: body.tab, via: "page" }),
      // Screen actions (public/ui-actions.js) go back to this tab, in this stream; audited.
      onUi: (ui) => {
        out.write(ui);
        db.logLogin(req.ip, req.me.username, "mint-ui", `${ui.action}${Object.keys(ui.args || {}).length ? " " + JSON.stringify(ui.args) : ""} by the voice front desk`);
      },
    });
    for (const t of r.asked) out.write({ type: "asked", turn: t });
    const sp = await speaker.done();
    const cat = voiceDesk.categoryOf(r);
    const deskUsd = recordVoice(() => voiceLedger.add({ vt, cat, part: "desk", model: voiceDesk.DESK_MODEL, tokens: r.tokens, actor }).usd);
    const speechUsd = recordSpeech({ vt, cat, actor, billing: sp.billing, lateBilling: sp.lateBilling });
    const usage = voiceUsageSummary();
    if (r.asked.length) db.logLogin(req.ip, req.me.username, "moni-ai", "turn via the voice front desk");
    voiceLog("desk", 200, {
      ms: Date.now() - t0,
      transcribe_ms: tTranscribe,
      first_line_ms: r.timings.firstLine != null ? (tTranscribe || 0) + r.timings.firstLine : undefined,
      first_audio_ms: sp.firstAudio,
      desk_ms: r.timings.done,
      tools: r.tools.join("+") || undefined,
      asked: r.asked.length || undefined,
      guard: r.trip ? r.trip.rule : undefined,
      refused_tools: r.rejected.length || undefined,
      lines: r.lines.length,
      audio_s: Math.round(sp.spoken.reduce((n, l) => n + l.audio_s, 0) * 100) / 100,
      cat,
      usd: (transcribeUsd + deskUsd + speechUsd).toFixed(5),
      day_usd: usage.today ? usage.today.total.toFixed(4) : undefined,
    });
    out.write({
      type: "done",
      asked: r.asked,
      cat,
      guard: r.trip ? { rule: r.trip.rule } : null,
      ms: { total: Date.now() - t0, transcribe: tTranscribe, desk: r.timings.done, first_line: r.timings.firstLine, first_audio: sp.firstAudio },
      cost_usd: transcribeUsd + deskUsd + speechUsd,
      usage,
    });
    out.end();
  } catch (e) {
    voiceLog("desk", e.code || "error", { ms: Date.now() - t0, why: e.message });
    if (started) {
      out.write({ type: "error", error: voice.scrub(e.message), code: e.code || "error" });
      return out.end();
    }
    if (e instanceof voiceDesk.DeskError && e.code === "invalid") return res.status(400).json({ error: e.message, code: "invalid" });
    if (e.code === "no-key" || e.code === "invalid" || e.code === "timeout") return voiceFail(res, e);
    res.status(502).json({ error: voice.scrub(e.message), code: e.code || "error" });
  }
});

/**
 * MINT AI's answer to a request the desk passed on, as a short spoken summary
 * (streamed like /desk/turn, a hand-off's cost). The full text is on screen
 * already. {type:"done", fallback:"verbatim"} tells the page to read the
 * reply as written instead (it was short and plain, or the guard cut the
 * summary before a word was said); {pending:true} that MINT AI has not
 * answered yet. Refused like /desk/turn. Body: {turn, vt?}.
 */
app.post("/mint-ai/api/desk/summary", ...moniAiWrite, async (req, res) => {
  if (!voiceDeskOn()) return deskRefuse(req, res, { error: "The voice front desk is off.", code: "desk-off" });
  const id = Number(req.body && req.body.turn);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Which request?", code: "invalid" });
  const vt = bodyVt(req);
  const actor = req.me.username;
  const t0 = Date.now();
  const out = ndjson(res);
  let started = false;
  try {
    const cfg = await voiceConfig();
    if (!cfg.key) throw new voice.VoiceError("Add an OpenAI key in Settings to use voice.", "no-key");
    voice.warm(cfg);
    const desk = voiceDesk.deskFor(req.me.username, cfg, moniCall, { log: (m) => console.log(m) });
    out.start();
    started = true;
    const speaker = voiceDesk.createSpeaker({ speak: voice.speakStream, cfg, write: out.write, t0 });
    const r = await desk.summarise(id, { onLine: (line) => speaker.push(line), persona: personaOf(req.me.id) });
    const sp = await speaker.done();
    const deskUsd = r.cost_usd ? recordVoice(() => voiceLedger.add({ vt, cat: "handoff", part: "desk", model: voiceDesk.DESK_MODEL, tokens: r.tokens, actor }).usd) : 0;
    const speechUsd = recordSpeech({ vt, cat: "handoff", actor, billing: sp.billing, lateBilling: sp.lateBilling });
    const usage = voiceUsageSummary();
    voiceLog("desk-summary", 200, {
      ms: Date.now() - t0,
      first_line_ms: r.timings.firstLine,
      first_audio_ms: sp.firstAudio,
      fallback: r.fallback || (r.pending ? "pending" : undefined),
      guard: r.trip ? r.trip.rule : undefined,
      reply_chars: r.shape ? r.shape.chars : undefined,
      lines: r.lines.length,
      audio_s: Math.round(sp.spoken.reduce((n, l) => n + l.audio_s, 0) * 100) / 100,
      usd: (deskUsd + speechUsd).toFixed(5),
      day_usd: usage.today ? usage.today.total.toFixed(4) : undefined,
    });
    out.write({
      type: "done",
      fallback: r.fallback || null,
      pending: !!r.pending,
      guard: r.trip ? { rule: r.trip.rule } : null,
      ms: { total: Date.now() - t0, first_line: r.timings.firstLine, first_audio: sp.firstAudio },
      cost_usd: deskUsd + speechUsd,
      usage,
    });
    out.end();
  } catch (e) {
    voiceLog("desk-summary", e.code || "error", { ms: Date.now() - t0, why: e.message });
    if (started) {
      out.write({ type: "error", error: voice.scrub(e.message), code: e.code || "error" });
      return out.end();
    }
    if (e.code === "invalid") return res.status(400).json({ error: e.message, code: "invalid" });
    if (e.code === "no-key" || e.code === "timeout") return voiceFail(res, e);
    res.status(502).json({ error: voice.scrub(e.message), code: e.code || "error" });
  }
});

/**
 * The voice's usage figures for the Command Center: today's and this month's
 * spend (Cairo), split by kind of turn and transcription, and the last turn.
 */
app.get("/mint-ai/api/voice/usage", ...moniAiGuard, (req, res) => {
  const u = voiceUsageSummary();
  if (u.error) return res.status(500).json({ error: "Voice usage is not available." });
  res.json(u);
});

app.post("/mint-ai/api/restart", ...moniAiWrite, async (req, res) => {
  try {
    db.logLogin(req.ip, req.me.username, "moni-ai", "restarted MINT AI");
    res.json(await moniai.call("restart", {}, req.me.username, { timeout: 90000 }));
  } catch (e) {
    moniAiFail(res, e);
  }
});

/* ------------------------------- MINT AI: Command Center v3, phase 1 --- */
/*
 * Missions, decisions and watchers, standing orders, approval rules, cost, the
 * machine card and the read-only session mirror. Each route is a thin, checked
 * proxy to one supervisor op (moni-ai/lib/protocol.js re-validates all of it).
 * Writes carry CSRF, reach the supervisor with the panel user as actor (it
 * audits them) and leave a line in the panel's own log too.
 */

async function moniAiOp(req, res, op, params, { log: what, timeout } = {}) {
  try {
    const out = await moniai.call(op, params || {}, req.me.username, timeout ? { timeout } : undefined);
    if (what) db.logLogin(req.ip, req.me.username, "moni-ai", String(what).slice(0, 200));
    res.json(out);
  } catch (e) {
    moniAiFail(res, e);
  }
}
/** Run a cleaner; answer 400 on a bad request. Returns undefined when it already answered. */
function moniAiClean(res, fn) {
  try {
    return fn();
  } catch (e) {
    moniAiFail(res, e);
    return undefined;
  }
}

app.get("/mint-ai/api/machine", ...moniAiGuard, (req, res) => moniAiOp(req, res, "machine"));

// approvals: the narrow "Always allow this" rule to show before saving it
app.get("/mint-ai/api/approvals/:id/rule-suggestion", ...moniAiGuard, (req, res) => {
  const id = moniAiClean(res, () => moniai.cleanApprovalId(req.params.id));
  if (id !== undefined) moniAiOp(req, res, "rule-suggest", { approval_id: id });
});

// missions
app.get("/mint-ai/api/missions", ...moniAiGuard, (req, res) => {
  const status = req.query && req.query.status === "active" ? "active" : "all";
  moniAiOp(req, res, "missions", { status });
});
app.get("/mint-ai/api/missions/:id", ...moniAiGuard, (req, res) => {
  const id = moniAiClean(res, () => moniai.missionIdOf(req.params.id));
  if (id !== undefined) moniAiOp(req, res, "mission", { mission_id: id });
});
app.post("/mint-ai/api/missions/request", ...moniAiWrite, (req, res) => {
  const goal = moniAiClean(res, () => moniai.str(req.body && req.body.goal, "The goal", { max: 4000 }));
  if (goal !== undefined) moniAiOp(req, res, "mission-request", { goal }, { log: "asked for a mission" });
});

// decisions
app.get("/mint-ai/api/decisions", ...moniAiGuard, (req, res) => {
  moniAiOp(req, res, "decisions", { status: req.query && req.query.status === "all" ? "all" : "open" });
});
app.post("/mint-ai/api/decisions/:id/:action", ...moniAiWrite, (req, res) => {
  const action = req.params.action;
  if (!["approve", "dismiss", "ask"].includes(action)) return res.status(404).json({ error: "No such action." });
  const params = moniAiClean(res, () => {
    const p = { decision_id: moniai.idOf(req.params.id, "decision") };
    if (action === "ask") p.text = moniai.str(req.body && req.body.text, "Your question", { max: 4000 });
    else {
      const note = moniai.cleanNote(req.body && req.body.note);
      if (note) p.note = note;
    }
    return p;
  });
  if (params) moniAiOp(req, res, "decision-" + action, params, { log: `${action} decision ${params.decision_id}` });
});

// watchers
app.get("/mint-ai/api/watchers", ...moniAiGuard, (req, res) => moniAiOp(req, res, "watchers"));
app.post("/mint-ai/api/watchers/:key", ...moniAiWrite, (req, res) => {
  const params = moniAiClean(res, () => {
    const key = moniai.oneOf(req.params.key, "Watcher", moniai.WATCHERS);
    const enabled = req.body && req.body.enabled;
    if (typeof enabled !== "boolean") throw new moniai.MoniAiError("enabled must be true or false.", "invalid");
    return { key, enabled };
  });
  if (params) moniAiOp(req, res, "watcher-set", params, { log: `watcher ${params.key} ${params.enabled ? "on" : "off"}` });
});

// standing orders
app.get("/mint-ai/api/orders", ...moniAiGuard, (req, res) => moniAiOp(req, res, "orders"));
app.get("/mint-ai/api/orders/:id/runs", ...moniAiGuard, (req, res) => {
  const id = moniAiClean(res, () => moniai.idOf(req.params.id, "standing order"));
  if (id !== undefined) moniAiOp(req, res, "order-runs", { order_id: id });
});
app.post("/mint-ai/api/orders", ...moniAiWrite, (req, res) => {
  const p = moniAiClean(res, () => moniai.cleanOrder(req.body, false));
  if (p) moniAiOp(req, res, "order-create", p, { log: "created a standing order" });
});
app.post("/mint-ai/api/orders/:id", ...moniAiWrite, (req, res) => {
  const p = moniAiClean(res, () => ({ order_id: moniai.idOf(req.params.id, "standing order"), ...moniai.cleanOrder(req.body, true) }));
  if (p) moniAiOp(req, res, "order-update", p, { log: `updated standing order ${p.order_id}` });
});
app.post("/mint-ai/api/orders/:id/:action", ...moniAiWrite, (req, res) => {
  const action = req.params.action;
  if (!["delete", "run", "pause"].includes(action)) return res.status(404).json({ error: "No such action." });
  const p = moniAiClean(res, () => {
    const o = { order_id: moniai.idOf(req.params.id, "standing order") };
    if (action === "pause") {
      if (typeof (req.body && req.body.paused) !== "boolean") throw new moniai.MoniAiError("paused must be true or false.", "invalid");
      o.paused = req.body.paused;
    }
    return o;
  });
  if (p) moniAiOp(req, res, "order-" + action, p, { log: `${action} standing order ${p.order_id}` });
});

// approval rules
app.get("/mint-ai/api/rules", ...moniAiGuard, (req, res) => moniAiOp(req, res, "rules"));
app.post("/mint-ai/api/rules/test", ...moniAiWrite, (req, res) => {
  const p = moniAiClean(res, () =>
    strip2({ command: moniai.str(req.body && req.body.command, "The command", { max: 8000 }), tool: moniai.oneOf(req.body && req.body.tool, "Tool", ["Bash", "SendMessage"], true) })
  );
  if (p) moniAiOp(req, res, "rule-test", p);
});
app.post("/mint-ai/api/rules", ...moniAiWrite, (req, res) => {
  const p = moniAiClean(res, () => moniai.cleanRule(req.body, false));
  if (p) moniAiOp(req, res, "rule-create", p, { log: `added a ${p.effect} rule` });
});
app.post("/mint-ai/api/rules/:id", ...moniAiWrite, (req, res) => {
  const p = moniAiClean(res, () => ({ rule_id: moniai.idOf(req.params.id, "rule"), ...moniai.cleanRule(req.body, true) }));
  if (p) moniAiOp(req, res, "rule-update", p, { log: `changed rule ${p.rule_id}` });
});
app.post("/mint-ai/api/rules/:id/delete", ...moniAiWrite, (req, res) => {
  const id = moniAiClean(res, () => moniai.idOf(req.params.id, "rule"));
  if (id !== undefined) moniAiOp(req, res, "rule-delete", { rule_id: id }, { log: `deleted rule ${id}` });
});
function strip2(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

// cost
app.get("/mint-ai/api/cost", ...moniAiGuard, (req, res) => moniAiOp(req, res, "cost"));
app.post("/mint-ai/api/cost/budget", ...moniAiWrite, (req, res) => {
  const p = moniAiClean(res, () => moniai.cleanBudget(req.body));
  if (p) moniAiOp(req, res, "cost-budget", p, { log: "set the daily budget" });
});

// the read-only session deep view
app.get("/mint-ai/api/sessions/:sid/mirror", ...moniAiGuard, (req, res) => {
  if (!moniai.SESSION_ID_RE.test(String(req.params.sid || ""))) return res.status(404).json({ error: "No such session." });
  moniAiOp(req, res, "session-mirror", { session_id: req.params.sid });
});

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
      // The Appearance card only for those who can open the Command Center.
      appearance: req.perm.can("moniai.use") ? moniAiViews.appearance({ csrf: res.locals.csrf, core: req.me.mint_core }) : null,
    })
  );
});

/* Account > Appearance without JavaScript: a plain form post (see setMintCore). */
app.post("/account/appearance", requireAuth, requirePerm("moniai.use"), requireCsrf, (req, res) => {
  const core = String((req.body && req.body.core) || "");
  if (!mintLogic.isCore(core)) return res.redirect("/account?err=" + encodeURIComponent("Choose core A, B or C.") + "#appearance");
  setMintCore(req, core);
  res.redirect("/account?msg=" + encodeURIComponent(`MINT AI core: ${core} · ${mintLogic.CORES[core]}.`) + "#appearance");
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

/**
 * Confirm the authenticator you have just scanned, without signing out.
 *
 * A reset leaves the account "enrolment pending" until a code arrives, and the
 * only thing that used to deliver one was a fresh sign-in. Somebody who resets
 * their own factor, scans the new code and stays in an existing session is then
 * looking at a page that says they are not enrolled while their phone is
 * producing perfectly good codes. This closes that: one code, from the app they
 * just set up, and the account is confirmed.
 */
app.post("/account/authenticator/verify", requireAuth, requireCsrf, (req, res) => {
  if (req.me.totp_confirmed) return res.redirect("/account");
  if (!totp.verifyAndConsume(req.me, req.body.code)) {
    logAuthFailure(req.ip, "bad code confirming enrolment");
    return res.redirect(
      "/account?err=" +
        encodeURIComponent("That code was not accepted. Check the phone's clock and try the next one.")
    );
  }
  db.confirmUserTotp(req.me.id);
  db.logLogin(req.ip, req.me.username, "account", "confirmed authenticator enrolment");
  res.redirect("/account?msg=" + encodeURIComponent("Authenticator confirmed."));
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

/* ---------------------------------------------------------- claude code --- */

/*
 * Claude Code's memory, sessions and live processes. Administrator-only by
 * default (the claude.* permissions are in no stock role): transcripts carry
 * client data and this panel faces the internet.
 *
 * Every privileged step is a cc-* helper subcommand. The helper validates its
 * arguments again and writes the audit line; the checks here exist so an
 * obviously malformed request never reaches sudo at all.
 */

const CC_HOMES = new Set(["root", "console", "agents", "winarchive"]);
const CC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CC_SLUG = /^[A-Za-z0-9_.-]{1,255}$/;
const CC_MEMFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/;
const CC_AGENT = /^[A-Za-z0-9_-]{1,64}$/;

const ccActor = (req) => req.me.username;
const qint = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const withMsg = (path, key, text) =>
  path + (path.includes("?") ? "&" : "?") + key + "=" + encodeURIComponent(text);

/** 404 for a session address that could not possibly be valid. */
function ccSessionParams(req, res, next) {
  if (CC_HOMES.has(req.params.home) && CC_UUID.test(req.params.uuid)) return next();
  return res.status(404).send(views.error("Not found", "No such session."));
}

/* ------------------------------------------------------ memory graphs --- */

/**
 * The memory graphs' data, as JSON for the page's canvas (public/memgraph.js).
 *
 * Read-only: every one of these reads through the privileged helper, which
 * redacts, and is redacted again here. The permissions are the ones the pages
 * already use -- claude.memory.read for Claude Code's memory, and for an
 * agent's vault agents.memory.read plus the agent inside the actor's scope, so
 * an agent's memory is visible to exactly those who could open its Memory tab.
 * JSON refusals, not pages: a poll that loses its session should see a status
 * code rather than a sign-in form.
 */
function apiPerm(perm) {
  return (req, res, next) => {
    if (!req.me) return res.status(401).json({ error: "Sign in first." });
    if (!req.perm.can(perm)) return res.status(403).json({ error: "Your role does not include this." });
    next();
  };
}
const CURSOR_RE = /^\d{1,15}$/;

app.get("/api/claude/memory/graph", apiPerm("claude.memory.read"), async (req, res) => {
  const params = {};
  for (const [q, key] of [["after_f", "after_f"], ["after_c", "after_c"]]) {
    const v = String(req.query[q] || "");
    if (v && !CURSOR_RE.test(v)) return res.status(400).json({ error: "bad cursor" });
    if (v) params[key] = Number(v);
  }
  try {
    const raw = await priv.ccMemoryGraph(params);
    res.json(priv.redactDeep(memgraph.buildClaude(raw)));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/claude/memory/search", apiPerm("claude.memory.read"), async (req, res) => {
  const q = String(req.query.q || "").slice(0, 500).trim();
  if (!q) return res.status(400).json({ error: "Type something to search for." });
  const project = String(req.query.project || "").slice(0, 61).trim();
  try {
    const out = await priv.ccMemorySearch(q, 30, project && CC_SLUG.test(project) ? project : null);
    res.json({ hits: memgraph.claudeHits(out.results), timing_ms: out.timing_ms || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/claude/memory/fact/:id(\\d+)", apiPerm("claude.memory.read"), async (req, res) => {
  try {
    res.json(priv.redactDeep(await priv.ccFactGet(req.params.id)));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

/** The agents whose memory this actor may read: all in scope, or one. */
async function memoryAgents(req, which) {
  const all = scopeAgents(req, await priv.agentList());
  if (!which || which === "all") return all.slice(0, 24);
  if (!SLUG_RE.test(which)) return [];
  return all.filter((a) => a.slug === which);
}

app.get("/api/agents/memory/graph", apiPerm("agents.memory.read"), async (req, res) => {
  try {
    const agents = await memoryAgents(req, String(req.query.agent || "all"));
    const vaults = await Promise.all(
      agents.map((a) =>
        priv
          .agentMemoryGraph(a.slug)
          .then((graph) => ({ slug: a.slug, name: a.name || a.slug, graph }))
          .catch((e) => ({ slug: a.slug, name: a.name || a.slug, error: e.message }))
      )
    );
    res.json(priv.redactDeep(memgraph.buildAgents(vaults)));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/agents/memory/search", apiPerm("agents.memory.read"), async (req, res) => {
  const q = String(req.query.q || "").slice(0, 500).trim();
  if (!q) return res.status(400).json({ error: "Type something to search for." });
  try {
    const agents = await memoryAgents(req, String(req.query.agent || "all"));
    const per = await Promise.all(
      agents.map((a) =>
        priv
          .agentMemorySearch(a.slug, q)
          .then((hits) => memgraph.agentHits(a.slug, hits))
          .catch(() => [])
      )
    );
    const hits = [].concat(...per).sort((x, y) => (y.score || 0) - (x.score || 0));
    res.json({ hits: priv.redactDeep(hits) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/agents/:slug/memory/note", apiPerm("agents.memory.read"), async (req, res) => {
  const slug = String(req.params.slug || "");
  if (!SLUG_RE.test(slug) || !req.perm.seesAgent(slug)) return res.status(404).json({ error: "No such agent." });
  try {
    const file = await priv.agentReadFile(slug, String(req.query.path || ""));
    const content = String(file.content || "");
    res.json(priv.redactDeep({ path: file.path, content: content.slice(0, 6000), truncated: content.length > 6000 }));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get("/claude", requireAuth, (req, res) => res.redirect("/claude/memory"));

app.get("/claude/memory", requireAuth, requirePerm("claude.memory.read"), async (req, res) => {
  const query = String(req.query.q || "").slice(0, 500).trim();
  const searchProject = String(req.query.sproject || "").slice(0, 61).trim();
  const filters = {
    topic: String(req.query.topic || "").slice(0, 121).trim(),
    project: String(req.query.project || "").slice(0, 61).trim(),
    superseded: req.query.sup === "1",
    q: String(req.query.fq || "").slice(0, 200).trim(),
    page: qint(req.query.page, 1),
    per_page: 25,
  };
  const data = await gather({
    stats: () => priv.ccMemoryStats(),
    facts: () => priv.ccFactsList(filters),
    files: () => priv.ccMemfilesList(),
    hooks: () => priv.ccHooksTail(50),
    services: () => priv.ccMemoryServices(),
    search: () => (query ? priv.ccMemorySearch(query, 12, searchProject || null) : Promise.resolve(null)),
  });
  const asked = String(req.query.view || "");
  const filtered = query || filters.topic || filters.project || filters.q || filters.superseded || filters.page > 1;
  res.send(
    claudeViews.memory({
      csrf: res.locals.csrf,
      user: ctx(req),
      view: ["graph", "list", "overview"].includes(asked) ? asked : filtered ? "list" : "graph",
      query,
      searchProject,
      filters,
      ...data,
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.get("/claude/memory/facts/:id(\\d+)", requireAuth, requirePerm("claude.memory.read"), async (req, res) => {
  try {
    const data = await priv.ccFactGet(req.params.id);
    res.send(
      claudeViews.fact({
        csrf: res.locals.csrf,
        user: ctx(req),
        data,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.redirect(withMsg("/claude/memory", "err", e.message));
  }
});

app.post("/claude/memory/facts", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  try {
    const out = await priv.ccFactAdd({
      content: String(req.body.content || ""),
      topic: field(req.body, "topic"),
      kind: field(req.body, "kind"),
      project: field(req.body, "project"),
      actor: ccActor(req),
    });
    const similar = (out.similar || []).map((s) => "#" + s.id).join(", ");
    res.redirect(
      withMsg(
        "/claude/memory/facts/" + out.id,
        "msg",
        "Stored as fact #" + out.id + "." + (similar ? " Similar existing facts: " + similar + "." : "")
      )
    );
  } catch (e) {
    res.redirect(withMsg("/claude/memory", "err", e.message));
  }
});

app.post("/claude/memory/facts/:id(\\d+)/edit", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  try {
    const out = await priv.ccFactEdit({
      id: Number(req.params.id),
      content: String(req.body.content || ""),
      topic: field(req.body, "topic"),
      kind: field(req.body, "kind"),
      actor: ccActor(req),
    });
    res.redirect(
      withMsg("/claude/memory/facts/" + out.id, "msg", "Saved as fact #" + out.id + "; #" + req.params.id + " is now superseded.")
    );
  } catch (e) {
    res.redirect(withMsg("/claude/memory/facts/" + req.params.id, "err", e.message));
  }
});

app.post("/claude/memory/facts/:id(\\d+)/forget", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  try {
    await priv.ccFactForget({ id: Number(req.params.id), reason: field(req.body, "reason"), actor: ccActor(req) });
    res.redirect(withMsg("/claude/memory/facts/" + req.params.id, "msg", "Forgotten. It will no longer be recalled."));
  } catch (e) {
    res.redirect(withMsg("/claude/memory/facts/" + req.params.id, "err", e.message));
  }
});

app.get("/claude/memory/files/:project/:name", requireAuth, requirePerm("claude.memory.read"), async (req, res) => {
  const { project, name } = req.params;
  if (!CC_SLUG.test(project) || !CC_MEMFILE.test(name)) {
    return res.status(404).send(views.error("Not found", "No such memory file."));
  }
  try {
    const file = await priv.ccMemfileRead(project, name);
    res.send(
      claudeViews.memfile({
        csrf: res.locals.csrf,
        user: ctx(req),
        file,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.redirect(withMsg("/claude/memory", "err", e.message));
  }
});

app.post("/claude/memory/files/:project/:name", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  const { project, name } = req.params;
  if (!CC_SLUG.test(project) || !CC_MEMFILE.test(name)) {
    return res.status(404).send(views.error("Not found", "No such memory file."));
  }
  const back = "/claude/memory/files/" + encodeURIComponent(project) + "/" + encodeURIComponent(name);
  try {
    const out = await priv.ccMemfileWrite(project, name, String(req.body.content || ""), ccActor(req));
    const ingest = out.ingest || {};
    res.redirect(
      withMsg(
        back,
        "msg",
        "Saved. " + (ingest.started ? "Re-indexing in the background." : "Re-index not started: " + (ingest.reason || "unknown") + ".")
      )
    );
  } catch (e) {
    res.redirect(withMsg(back, "err", e.message));
  }
});

app.post("/claude/memory/restart", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  try {
    await priv.ccMemoryRestart(ccActor(req));
    res.redirect(withMsg("/claude/memory", "msg", "claude-memory restarted."));
  } catch (e) {
    res.redirect(withMsg("/claude/memory", "err", e.message));
  }
});

app.post("/claude/memory/ingest", requireAuth, requirePerm("claude.memory.write"), requireCsrf, async (req, res) => {
  try {
    const out = await priv.ccIngestAll(ccActor(req));
    res.redirect(
      withMsg(
        "/claude/memory",
        out.started ? "msg" : "err",
        out.started ? "ingest.py --all started as cm-ingest (nice 10)." : "Not started: " + (out.reason || "unknown") + "."
      )
    );
  } catch (e) {
    res.redirect(withMsg("/claude/memory", "err", e.message));
  }
});

app.get("/claude/memory/session/:uuid", requireAuth, requirePerm("claude.memory.read"), async (req, res) => {
  const uuid = req.params.uuid;
  if (!CC_UUID.test(uuid)) return res.status(404).send(views.error("Not found", "No such session."));
  let data = null;
  let err = null;
  try {
    data = await priv.ccSessionMemory(uuid, qint(req.query.page, 1));
  } catch (e) {
    err = e.message;
  }
  res.send(claudeViews.sessionMemory({ csrf: res.locals.csrf, user: ctx(req), data, uuid, err }));
});

app.get("/claude/sessions", requireAuth, requirePerm("claude.sessions.view"), async (req, res) => {
  const filters = {
    home: CC_HOMES.has(String(req.query.home || "")) ? String(req.query.home) : "",
    project: CC_SLUG.test(String(req.query.project || "")) ? String(req.query.project) : "",
    q: String(req.query.q || "").slice(0, 200).trim(),
    archived: req.query.archived === "1",
    page: qint(req.query.page, 1),
    per_page: 25,
  };
  let data = null;
  let err = req.query.err || null;
  try {
    data = await priv.ccSessionsList(filters);
  } catch (e) {
    err = e.message;
  }
  res.send(
    claudeViews.sessions({ csrf: res.locals.csrf, user: ctx(req), data, filters, flash: req.query.msg || null, err })
  );
});

app.get("/claude/sessions/:home/:uuid", requireAuth, requirePerm("claude.sessions.view"), ccSessionParams, async (req, res) => {
  const agent = String(req.query.agent || "");
  if (agent && !CC_AGENT.test(agent)) return res.status(404).send(views.error("Not found", "No such subagent."));
  try {
    const s = await priv.ccSessionGet(req.params.home, req.params.uuid, {
      page: req.query.page ? qint(req.query.page, 1) : null,
      agent: agent || null,
      archived: req.query.archived === "1",
    });
    res.send(
      claudeViews.session({
        csrf: res.locals.csrf,
        user: ctx(req),
        s,
        flash: req.query.msg || null,
        err: req.query.err || null,
      })
    );
  } catch (e) {
    res.redirect(withMsg("/claude/sessions", "err", e.message));
  }
});

const ccSessionPath = (req, archived) =>
  "/claude/sessions/" + req.params.home + "/" + req.params.uuid + (archived ? "?archived=1" : "");

app.post("/claude/sessions/:home/:uuid/rename", requireAuth, requirePerm("claude.sessions.manage"), ccSessionParams, requireCsrf, async (req, res) => {
  try {
    await priv.ccSessionRename(req.params.home, req.params.uuid, field(req.body, "title"), ccActor(req));
    res.redirect(withMsg(ccSessionPath(req), "msg", "Renamed."));
  } catch (e) {
    res.redirect(withMsg(ccSessionPath(req), "err", e.message));
  }
});

app.post("/claude/sessions/:home/:uuid/archive", requireAuth, requirePerm("claude.sessions.manage"), ccSessionParams, requireCsrf, async (req, res) => {
  try {
    await priv.ccSessionArchive(req.params.home, req.params.uuid, ccActor(req));
    res.redirect(withMsg(ccSessionPath(req, true), "msg", "Archived. Nothing was deleted; Restore moves it back."));
  } catch (e) {
    res.redirect(withMsg(ccSessionPath(req), "err", e.message));
  }
});

app.post("/claude/sessions/:home/:uuid/restore", requireAuth, requirePerm("claude.sessions.manage"), ccSessionParams, requireCsrf, async (req, res) => {
  try {
    await priv.ccSessionRestore(req.params.home, req.params.uuid, ccActor(req));
    res.redirect(withMsg(ccSessionPath(req), "msg", "Restored to its project folder."));
  } catch (e) {
    res.redirect(withMsg(ccSessionPath(req, true), "err", e.message));
  }
});

app.get("/claude/running", requireAuth, requirePerm("claude.running.view"), async (req, res) => {
  let r = null;
  let err = req.query.err || null;
  try {
    r = await priv.ccRunning();
  } catch (e) {
    err = e.message;
  }
  res.send(claudeViews.running({ csrf: res.locals.csrf, user: ctx(req), r, flash: req.query.msg || null, err }));
});

// Polled by public/app.js every 10 s. The fragments are rendered here, by the
// same functions as the page, so there is one template and the browser only
// swaps markup that was already escaped.
app.get("/api/claude/running", requireAuth, requirePerm("claude.running.view"), async (req, res) => {
  try {
    const r = await priv.ccRunning();
    res.json({
      ts: r.ts,
      updated: String(r.ts || "").replace("T", " ").slice(0, 19),
      html: claudeViews.runningSections(res.locals.csrf, ctx(req), r),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/claude/running/stop", requireAuth, requirePerm("claude.running.stop"), requireCsrf, async (req, res) => {
  const pid = Number(field(req.body, "pid"));
  if (!Number.isInteger(pid) || pid <= 1) return res.redirect(withMsg("/claude/running", "err", "Bad pid."));
  const force = field(req.body, "force") === "1";
  try {
    const out = await priv.ccStop(pid, force, ccActor(req));
    res.redirect(
      withMsg(
        "/claude/running",
        "msg",
        out.signal + " sent to pid " + pid + "." + (force ? "" : " If it is still running in 10 seconds, Force stop appears.")
      )
    );
  } catch (e) {
    res.redirect(withMsg("/claude/running", "err", e.message));
  }
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

/* ------------------------------------ live voice evaluation (admin) ---- */

/**
 * The Egyptian evaluation for the live conversation (lib/voice-live-eval.js):
 * an administrator records the 20 phrases in their own voice here (PCM16 mono
 * 24 kHz WAVs, kept in DATA_DIR/voice-eval/<user id>/, 0700), then runs them
 * through each realtime model and voice. A stubbed supervisor: nothing reaches
 * MINT AI, and nothing is written to the usage table (each run's cost is in
 * its results). One run per user at a time, in this process.
 */
const evalGuard = [requireApiPerm("moniai.use"), requireApiPerm("voice.manage")];
const evalJobs = new Map(); // user id -> {running, done, total, started_at, finished_at, summary, results, error}
function evalDir(userId) {
  const d = path.join(DATA_DIR, "voice-eval", String(Number(userId)));
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
const evalClip = (userId, id) => path.join(evalDir(userId), "clip-" + String(id).padStart(2, "0") + ".wav");
function evalClips(userId) {
  return voiceEval.PHRASES.filter((p) => fs.existsSync(evalClip(userId, p.id))).map((p) => p.id);
}

app.get("/mint-ai/voice-eval", requireAuth, requirePerm("moniai.use"), requirePerm("voice.manage"), (req, res) => {
  res.send(voiceEvalViews.page({ csrf: res.locals.csrf, user: ctx(req, "console"), phrases: voiceEval.PHRASES, models: voiceEval.MODELS, voices: voiceEval.VOICES, worklet: asset("voice-live-worklet.js") }));
});

app.get("/mint-ai/api/voice-eval/status", ...evalGuard, (req, res) => {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(evalDir(req.me.id), "results.json"), "utf8"));
  } catch (_) {
    /* none yet */
  }
  const job = evalJobs.get(req.me.id) || null;
  res.json({ clips: evalClips(req.me.id), job: job ? { ...job, results: undefined } : null, last: saved });
});

app.get("/mint-ai/api/voice-eval/clip/:id", ...evalGuard, (req, res) => {
  const id = Number(req.params.id);
  if (!voiceEval.PHRASES.some((p) => p.id === id) || !fs.existsSync(evalClip(req.me.id, id))) return res.status(404).json({ error: "No such recording." });
  res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(fs.readFileSync(evalClip(req.me.id, id)));
});

app.post("/mint-ai/api/voice-eval/clip", ...evalGuard, express.json({ limit: "3mb" }), requireApiCsrf, (req, res) => {
  const id = Number(req.body && req.body.id);
  const data = typeof (req.body && req.body.data) === "string" ? req.body.data : "";
  if (!voiceEval.PHRASES.some((p) => p.id === id)) return res.status(400).json({ error: "Which phrase?" });
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: "No audio arrived." });
  const wav = Buffer.from(data, "base64");
  let pcm;
  try {
    pcm = voiceEval.readWav(wav);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const seconds = pcm.length / 48000;
  if (seconds < 0.4 || seconds > 20) return res.status(400).json({ error: "A recording must be between 0.4 and 20 seconds." });
  fs.writeFileSync(evalClip(req.me.id, id), wav, { mode: 0o600 });
  res.json({ ok: true, id, seconds: Math.round(seconds * 10) / 10 });
});

app.post("/mint-ai/api/voice-eval/run", ...evalGuard, requireApiCsrf, async (req, res) => {
  const uid = req.me.id;
  const cur = evalJobs.get(uid);
  if (cur && cur.running) return res.status(409).json({ error: "A run is already going." });
  const pick = (v, list) => (Array.isArray(v) ? v.filter((x) => list.includes(x)) : []);
  const models = pick(req.body && req.body.models, voiceEval.MODELS);
  const voices = pick(req.body && req.body.voices, voiceEval.VOICES);
  if (!models.length || !voices.length) return res.status(400).json({ error: "Pick at least one model and one voice." });
  const ids = evalClips(uid);
  if (!ids.length) return res.status(400).json({ error: "Record at least one phrase first." });
  const cfg = await voiceConfig();
  if (!cfg.key) return res.status(409).json({ error: "Add an OpenAI key in Settings first." });
  const clips = ids.map((id) => ({ phrase: voiceEval.PHRASES.find((p) => p.id === id), pcm: voiceEval.readWav(fs.readFileSync(evalClip(uid, id))) }));
  const job = { running: true, done: 0, total: clips.length * models.length * voices.length, started_at: new Date().toISOString(), models, voices };
  evalJobs.set(uid, job);
  db.logLogin(req.ip, req.me.username, "voice", `live voice evaluation started: ${clips.length} phrases x ${models.join(",")} x ${voices.join(",")}`);
  res.json({ ok: true, total: job.total });
  voiceEval
    .evaluate({
      clips,
      models,
      voices,
      concurrency: 2,
      deps: { key: cfg.key, speak: voice.speakStream, transcribe: voice.transcribeFull, isStop: (t) => voiceStop.heard(t) },
      onProgress: (p) => (job.done = p.done),
    })
    .then((out) => {
      Object.assign(job, { running: false, finished_at: new Date().toISOString(), summary: out.summary, table: voiceEval.tableMarkdown(out.summary) });
      const report = { at: job.finished_at, models, voices, summary: out.summary, results: out.results };
      fs.writeFileSync(path.join(evalDir(uid), "results.json"), JSON.stringify(report, null, 1), { mode: 0o600 });
      fs.writeFileSync(path.join(evalDir(uid), "results.md"), job.table + "\n", { mode: 0o600 });
      console.log(`voice-eval: done for ${req.me.username}, $${out.summary.reduce((n, r) => n + r.usd_total, 0).toFixed(4)}`);
    })
    .catch((e) => Object.assign(job, { running: false, error: voice.scrub(e.message) }));
});

/* --------------------------------------------------------------- misc ----- */

app.get("/healthz", (req, res) => res.type("text").send("ok"));

app.use((req, res) => res.status(404).send(views.error("Not found", "No such page.")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(views.error("Server error", "Something went wrong."));
});

/* ------------------------------------------- live conversation (WS) ---- */

/**
 * Live conversation (TRIAL, lib/voice-live.js): the Command Center streams the
 * microphone here over a WebSocket, and this server relays it to OpenAI's
 * realtime model and plays back only what the guard has passed. The browser
 * never talks to OpenAI and never sees the key.
 *
 * GET /mint-ai/api/live?csrf=<token> (Upgrade: websocket). Refused, before
 * the upgrade, unless all of these hold:
 *   - the Origin is this host (a page elsewhere cannot open it with the cookie);
 *   - a signed-in session (the same cookie and store as every page), a user
 *     who is not disabled, with moniai.use AND voice.manage (administrators);
 *   - the session's CSRF token in the query;
 *   - the voice mode is "live" and an OpenAI key is set.
 * Then: one live call per user (a second is told "busy" and closed), at most
 * LIVE_MAX_CALLS at once, 20 minutes at most (lib/voice-live.js), frames of at
 * most half a second of audio or 4 KB of JSON, and no more audio than twice
 * real time. A keep-alive ping every 15 s keeps nginx's 60 s read timeout from
 * cutting a quiet call.
 *
 * Wire: page -> server: binary PCM16 mono 24 kHz; JSON {type: "played"|
 * "flushed"|"mute"|"end"}. server -> page: binary [uint32 LE seg][PCM16];
 * JSON {type: "ready"|"state"|"seg"|"segend"|"cut"|"flush"|"caption"|"asked"|
 * "replied"|"stop"|"ended"|"error"}. See the README's integration contract.
 */
const LIVE_PATH = /^\/(?:mint|moni)-ai\/api\/live(?:\?|$)/;
const LIVE_MAX_CALLS = 4;
const LIVE_MAX_FRAME = voiceLive.RATE; // bytes: half a second of PCM16
function liveAllowed(perm) {
  return !!(perm && perm.can("moniai.use") && perm.can("voice.manage"));
}
function hostOnly(h) {
  return String(h || "").trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
}
/** The Origin must be this very host (by name; nginx sends Host without the port). */
function liveOriginOk(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let u;
  try {
    u = new URL(origin);
  } catch (_) {
    return false;
  }
  const local = /^(127\.0\.0\.1|localhost|::1)$/.test(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return false;
  return hostOnly(u.host) === hostOnly(req.headers.host);
}
function sameToken(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
function refuseUpgrade(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  } catch (_) {
    /* gone */
  }
  socket.destroy();
}
const liveWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

function liveUpgrade(req, socket, head) {
  if (!LIVE_PATH.test(req.url || "")) return refuseUpgrade(socket, 404, "Not Found");
  if (!liveOriginOk(req)) return refuseUpgrade(socket, 403, "Forbidden origin");
  sessionMw(req, {}, async () => {
    try {
      const sess = req.session;
      const me = sess && sess.authed && sess.userId ? db.getUser(sess.userId) : null;
      if (!me || me.disabled) return refuseUpgrade(socket, 401, "Unauthorized");
      const perm = rbac.actor(me.role);
      if (!liveAllowed(perm)) return refuseUpgrade(socket, 403, "Forbidden");
      const q = new URL(req.url, "http://x").searchParams;
      if (!sameToken(q.get("csrf"), sess.csrf)) return refuseUpgrade(socket, 403, "Invalid CSRF token");
      if (voiceMode() !== "live") return refuseUpgrade(socket, 409, "Live conversation is off");
      const cfg = await voiceConfig();
      if (!cfg.key) return refuseUpgrade(socket, 409, "No OpenAI key");
      if (voiceLive.activeCount() >= LIVE_MAX_CALLS && !voiceLive.callFor(me.username)) return refuseUpgrade(socket, 503, "Too many live calls");
      const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const ip = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || "") && fwd ? fwd : req.socket.remoteAddress;
      const audio = liveAudio();
      const duplex = voiceLive.DUPLEX.includes(q.get("duplex")) ? q.get("duplex") : audio.duplex;
      const route = q.get("route") === "loopback" ? "loopback" : q.get("route") === "direct" ? "direct" : "unknown";
      const tab = q.get("tab") || null;
      liveWss.handleUpgrade(req, socket, head, (ws) => liveConnected(ws, { me, cfg, ip, duplex, noise: audio.noise, route, tab }));
    } catch (e) {
      console.log("live: upgrade failed: " + e.message);
      refuseUpgrade(socket, 500, "Server error");
    }
  });
}

function liveConnected(ws, { me, cfg, ip, duplex, noise, route, tab }) {
  const actor = me.username;
  const json = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  if (voiceLive.callFor(actor)) {
    json({ type: "error", code: "busy", error: "You already have a live conversation open (another tab?). End it there first." });
    return ws.close(4409, "busy");
  }
  const call = new voiceLive.LiveCall({
    cfg: { key: cfg.key, voice: cfg.voice, model: cfg.model, transcribe_model: cfg.transcribe_model, noise_reduction: noise },
    actor,
    ops: voiceDesk.deskOps(moniCall, actor),
    client: {
      json,
      audio: (seg, buf) => {
        if (ws.readyState !== 1) return;
        const h = Buffer.alloc(4);
        h.writeUInt32LE(seg >>> 0, 0);
        ws.send(Buffer.concat([h, buf]));
      },
      close: (code, why) => {
        try {
          ws.close(code || 1000, String(why || "").slice(0, 100));
        } catch (_) {
          /* closed */
        }
      },
    },
    persona: () => personaOf(me.id),
    hearPersona: (text) => personaHear({ userId: me.id, username: actor, ip }, text),
    audit: (line) => db.logLogin(ip, actor, "mint-ui", line),
    speak: voice.speakStream,
    transcribe: voice.transcribeFull,
    summarise: (id, o) => voiceDesk.deskFor(actor, cfg, moniCall, { log: (m) => console.log(m) }).summarise(id, o),
    record: (row) => recordVoice(() => voiceLedger.add(row).usd),
    isStop: (t) => voiceStop.heard(t),
    isUndo: (t) => voiceStop.undo(t),
    // A hand-off to MINT AI carries a ui token for the tab that holds the call (UI control Phase 2).
    uiTicket: () => uiRelay.mint({ actor, tab, via: "live", callId: call.id }),
    log: (m) => console.log(m),
    opts: { duplex },
  });
  voiceLive.register(actor, call);
  db.logLogin(ip, actor, "voice", `live conversation (trial) started (${duplex === "full" ? "headphones" : "speakers"} mode, playback ${route}, noise reduction ${noise})`);
  console.log(`live: call ${call.id} started: ${duplex} mode, playback ${route}, noise reduction ${noise}`);
  // Twice real time is the most a microphone can send; more is not a microphone.
  let window0 = Date.now();
  let bytes = 0;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      if (buf.length > LIVE_MAX_FRAME) return call.close("refused", "A frame was too large.");
      if (Date.now() - window0 > 5000) {
        window0 = Date.now();
        bytes = 0;
      }
      bytes += buf.length;
      if (bytes > voiceLive.RATE * 2 * 5 * 2) return call.close("refused", "Too much audio.");
      return call.audioIn(buf);
    }
    if (data.length > 4096) return;
    let m = null;
    try {
      m = JSON.parse(String(data));
    } catch (_) {
      return;
    }
    call.message(m);
  });
  const ping = setInterval(() => {
    try {
      ws.ping();
    } catch (_) {
      /* closed */
    }
  }, 15000);
  ws.on("close", () => {
    clearInterval(ping);
    call.close("hung-up");
    voiceLive.unregister(actor, call);
    const dg = call.diag;
    db.logLogin(ip, actor, "voice", `live conversation (trial) ended after ${Math.round((Date.now() - call.bornAt) / 1000)} s, $${call.usd.toFixed(4)}; ${call.duplex} mode, barge-ins ${dg.bargeIns.length} of ${dg.candidates.length} candidates, phantom turns ${dg.leaks}`);
  });
  ws.on("error", () => {});
  call
    .open()
    .then(() => json({ type: "ready", call: call.id, model: call.model, voice: cfg.voice, max_s: Math.round(call.opts.maxMs / 1000), rate: voiceLive.RATE, duplex: call.duplex, noise }))
    .catch((e) => {
      json({ type: "error", code: "upstream", error: voice.scrub(e.message) });
      call.close("upstream");
    });
}

const httpServer = app.listen(PORT, BIND, () => {
  console.log(`moni-dashboard listening on ${BIND}:${PORT}`);
  if (noUsersYet()) {
    // Materialise the token at startup so an operator with shell access can read
    // it, rather than having to hit the endpoint first to bring it into being.
    getSetupToken();
    console.log("No admin account yet. Setup token is in " + DATA_DIR + "/setup.token");
  }
});
httpServer.on("upgrade", liveUpgrade);
