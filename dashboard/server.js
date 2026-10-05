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
const deviceSessions = require("./lib/sessions");
const priv = require("./lib/priv");
const catalog = require("./lib/catalog");
const telegram = require("./lib/telegram");
const views = require("./lib/views");
const agentViews = require("./lib/views-agents");
const channelViews = require("./lib/views-channels");
const topics = require("./lib/topics");
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
// Passkeys (Windows Hello) as the sign-in's second step; the authenticator stays as the fallback.
const passkeys = require("./lib/passkeys");
const voice = require("./lib/voice");
const voiceShared = require("./lib/voice-shared"); // the guard, the supervisor door, the summaries (was voice-desk.js)
const voiceUsage = require("./lib/voice-usage");
const voicePersona = require("./lib/voice-persona");
const voiceLive = require("./lib/voice-live");
// MINT AI ▸ Settings; the Voice section is rendered and handled with the voice code below.
const settingsRoutes = require("./lib/routes-settings");
const UiActions = require("./public/ui-actions.js");
// UI control Phase 2: the ui tokens this server minted, in memory only (lib/ui-relay.js).
const uiRelay = require("./lib/ui-relay").createRelay();
const uiTab = require("./lib/ui-relay").TAB_RE;
// UI control Phase 3: Tier-2 preferences wait for the administrator's confirm (lib/ui-confirm.js).
// An unanswered confirm is not silent: audited, the chip told, the voice says so once (uiConfirmExpired).
const uiConfirms = require("./lib/ui-confirm").createConfirms({ onExpire: (actor, e) => uiConfirmExpired(actor, e) });
// The event streams open per user and tab, so the server can reach a chip (a confirm that expired).
const uiStreams = new Set(); // { actor, tab, res }
function uiConfirmExpired(actor, e) {
  db.logLogin(e.ip || null, actor, "mint-ui", `${e.action} ${JSON.stringify(e.args)} expired, nothing changed`);
  const line = voicePersona.expiredLine(personaOfActor(actor));
  const data = JSON.stringify({ type: "ui-confirm", state: "expired", id: e.id, action: e.action, line });
  for (const st of uiStreams) if (st.actor === actor) st.res.write(`event: ui-confirm\ndata: ${data}\n\n`);
  const call = voiceLive.callFor(actor);
  if (call && call.confirmExpired) call.confirmExpired(e);
}
function personaOfActor(actor) {
  try {
    const u = db.getUserByName(actor);
    return u ? personaOf(u.id) : null;
  } catch (_) {
    return null;
  }
}
/**
 * Open a Tier-2 confirm for `who` ({username, ip, canVoice}): the page shows
 * the question; nothing changes until a click or a heard "yes". persona.set
 * and voice.set need voice.manage (their routes check it again); voice.set
 * never while a live call is open (changing it ends every call).
 */
function uiConfirmOpen(who, v, tab, by) {
  if ((v.action === "persona.set" || v.action === "voice.set") && !who.canVoice) return { error: "this account cannot change voice settings" };
  if (uiVoiceOff(v.action)) return { error: "voice is off" };
  if (v.action === "voice.set" && uiConfirms.anyPending("voice.set")) return { error: "another voice change is already waiting for a confirm" };
  const o = uiConfirms.open({ actor: who.username, action: v.action, args: v.args, tab, ip: who.ip });
  if (o.error) return o;
  db.logLogin(who.ip, who.username, "mint-ui", `${v.action} ${JSON.stringify(v.args)} asked by ${by}: waiting for the administrator's confirm`);
  return { id: o.id, question: UiActions.toast(v.action, v.args) };
}
/** A voice screen action (call.*, voice.set) while voice is off: refused, wherever it comes from. */
function uiVoiceOff(action) {
  return (/^call\./.test(String(action || "")) || action === "voice.set") && !voiceEnabled();
}
/** The administrator's next utterance against a pending confirm (null when none is pending). */
function uiConfirmHeard(who, text, where) {
  const r = uiConfirms.heard(who.username, text, voiceStop);
  if (r && (r.confirmed || r.cancelled)) {
    const e = r.confirmed || r.cancelled;
    db.logLogin(who.ip, who.username, "mint-ui", `${e.action} ${JSON.stringify(e.args)} ${r.confirmed ? "confirmed by a spoken yes" : "cancelled by a spoken no"} (${where})`);
  }
  return r;
}
/** moniai.call for the live call: a send carrying a ui token binds it to the turn it started. */
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
const voiceTranscribe = require("./lib/voice-transcribe"); // which model writes down what was said (Settings ▸ Voice ▸ Transcription)
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
        // 'self': the Command Center hosts Mint OS pages in a same-origin iframe (M-5), so a live call survives moving between them.
        // X-Frame-Options stays SAMEORIGIN (helmet's frameguard default) for older browsers.
        frameAncestors: ["'self'"],
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
const PAYLOAD_ROUTES = /^(\/console\/\d+\/(upload|transcribe)|\/mint-ai\/api\/voice-eval\/clip)$/;
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
// The store and the secret are also handed to lib/sessions.js, which lists a
// user's signed-in browsers (Devices) and signs them out through this store.
const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;
const sessionStore = new SQLiteStore({ db: "sessions.db", dir: DATA_DIR });
const sessionMw = session({
    store: sessionStore,
    secret: (() => {
      const secret = loadOrCreateSessionSecret();
      deviceSessions.configure({ dataDir: DATA_DIR, secret, maxAge: SESSION_MAX_AGE, store: sessionStore });
      return secret;
    })(),
    name: "moni.sid",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: true, // we are always behind TLS
      sameSite: "strict",
      maxAge: SESSION_MAX_AGE,
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
      endLiveCallsForSession(req.sessionID, "signed-out");
      return req.session.destroy(() => res.redirect("/login?revoked=1"));
    }
    req.me = me;
    req.perm = rbac.actor(me.role);
    // Devices' "last seen". At most once a minute, so a busy page does not
    // rewrite its session row on every poll.
    const now = Date.now();
    if (!(req.session.seenAt > now - 60 * 1000)) req.session.seenAt = now;
  }
  next();
}
app.use(loadActor);
// Whether this viewer gets the dock's microphone (voiceDockOk, with the voice code): pages only.
app.use((req, res, next) => {
  if (req.method !== "GET" || !req.me || /^\/(?:mint|moni)-ai\/api\//.test(req.path) || /\.[a-z0-9]{2,5}$/i.test(req.path)) return next();
  voiceDockOk(req).then(
    (ok) => {
      req.voiceMic = ok;
      next();
    },
    () => next()
  );
});

// The frame's badges and health chip, from a shared 30-second cache (see
// lib/chrome.js). A change made through the panel forgets the cache, so the
// page it redirects to counts what is true now rather than half a minute ago.
chrome.configure({ priv, db, catalog, devicesFor: (userId) => deviceSessions.countFor(userId), voiceOff: () => !voiceEnabled() });

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
    voice: !!req.voiceMic, // the dock's mic: voice on, a key, and voice.use (see voiceDockOk)
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

// The passkey half of the second step: the options call and the answer are two
// requests per sign-in, so they get their own, roomier budget. A passkey cannot
// be guessed; this is about load, and the per-attempt cap below is the guard.
const passkeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
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
  // A half-finished sign-in is abandoned by coming back here.
  if (req.session) delete req.session.pendingLogin;
  res.send(
    views.login({
      csrf: res.locals.csrf,
      error: req.query.revoked ? "Your access has been changed. Sign in again." : req.query.again ? "Invalid credentials." : null,
      passkeys: !!passkeys.rpFor(req),
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

  // `second=passkey` (set by public/passkey.js when the page offers it): no code
  // now, the second step comes next. Without it a missing code is a missing
  // field, exactly as before passkeys existed.
  const viaPasskey = !String(token || "").trim() && req.body.second === "passkey" && !!passkeys.rpFor(req);
  if (!username || !password || (!token && !viaPasskey)) return reject("missing field");
  const account = db.getUserByName(String(username));

  /**
   * The passkey step is reached whatever happened to the password.
   *
   * Asking for the code on the same form meant a wrong password and a wrong
   * code got the same answer, so a password could not be tested on its own.
   * A second step must not give that up: the next page looks the same for a
   * right password, a wrong one and an unknown user, and the passkey prompt it
   * starts names no credentials (a discoverable-credential request), so
   * nothing on it says which case this is. Only the end of the step tells,
   * and it tells "Invalid credentials" for all of them.
   */
  const toSecondStep = (userId, pwOk, reason) => {
    if (!pwOk) {
      db.logLogin(ip, username || "", "fail", reason);
      logAuthFailure(ip, reason);
    }
    req.session.pendingLogin = { userId: pwOk ? userId : null, username: String(username).slice(0, 64), at: Date.now(), fails: 0 };
    return res.redirect("/login/verify");
  };

  // Verify a throwaway hash for an unknown username so a missing account and a
  // wrong password take the same time. Argon2 is slow enough that skipping it
  // would make user enumeration trivial from a stopwatch.
  if (!account) {
    const decoy = await decoyHash;
    if (decoy) await argon2.verify(decoy, String(password)).catch(() => false);
    return viaPasskey ? toSecondStep(null, false, "unknown user") : reject("unknown user");
  }
  if (account.disabled) return viaPasskey ? toSecondStep(null, false, "account disabled") : reject("account disabled");

  let passwordOk = false;
  try {
    passwordOk = await argon2.verify(account.password_hash, password);
  } catch (_) {
    passwordOk = false;
  }
  if (!passwordOk) return viaPasskey ? toSecondStep(null, false, "bad password") : reject("bad password");
  if (viaPasskey) return toSecondStep(account.id, true, null);

  // Checked and spent in one step. A code stayed usable for its whole
   // ninety-second life before, so one seen over a shoulder -- or in a screen
  // share -- was worth a session to anyone who also had the password. Only a
  // successful sign-in spends one, so retrying after a mistyped password still
  // works with the code already on screen.
  if (!totp.verifyAndConsume(account, token)) return reject("bad totp");

  // First successful sign-in also completes enrolment: producing a valid code
  // is the proof that the authenticator was set up correctly.
  if (!account.totp_confirmed) db.confirmUserTotp(account.id);
  completeLogin(req, res, account, null, (err, to) =>
    err ? res.status(500).send(views.error("Session error", String(err))) : res.redirect(to)
  );
});

/**
 * Both factors are in: make this browser signed in. `done(err, landing)`.
 * `how` is the audit detail (null for the code, as it always was).
 */
function completeLogin(req, res, account, how, done) {
  const ip = req.ip;
  db.touchUserLogin(account.id);

  // Regenerate the session on privilege change to prevent fixation.
  const csrf = req.session.csrf;
  req.session.regenerate((err) => {
    if (err) return done(err);
    req.session.authed = true;
    req.session.userId = account.id;
    req.session.username = account.username;
    req.session.csrf = csrf;
    // When both factors were last shown: adding a passkey soon after needs no code again.
    req.session.authAt = Date.now();
    // What Devices shows for this browser. The user agent is capped: it is
    // the client's own text, stored until the session ends.
    req.session.device = { ua: String(req.get("user-agent") || "").slice(0, 300), ip, at: Date.now() };
    req.session.seenAt = Date.now();
    deviceSessions.forget(account.id);
    db.logLogin(ip, account.username, "success", how);
    const actor = rbac.actor(account.role);
    done(null, rbac.landing(actor));
  });
}

/* --- the second step: a passkey, or the authenticator code ------------- */

// A half-finished sign-in lasts this long, and survives this many failed tries.
const PENDING_LOGIN_MS = 5 * 60 * 1000;
const PENDING_LOGIN_TRIES = 5;

/** The pending sign-in of this browser, or null (expired or none). */
function pendingLogin(req) {
  const p = req.session && req.session.pendingLogin;
  if (!p || !(Date.now() - p.at < PENDING_LOGIN_MS) || p.fails >= PENDING_LOGIN_TRIES) {
    if (req.session) delete req.session.pendingLogin;
    return null;
  }
  return p;
}

/** The account a pending sign-in may finish as: password right, still enabled. */
function pendingAccount(p) {
  if (!p || !p.userId) return null;
  const a = db.getUser(p.userId);
  return a && !a.disabled ? a : null;
}

/** One failed second step: logged, counted, and the sign-in dropped at the cap. */
function secondStepFailed(req, p, reason) {
  p.fails = (p.fails || 0) + 1;
  // A wrong password was logged at the first step; the step itself is logged
  // only for a sign-in that could have succeeded, so one attempt is one line.
  if (p.userId) {
    db.logLogin(req.ip, p.username, "fail", reason);
    logAuthFailure(req.ip, reason);
  }
  if (p.fails >= PENDING_LOGIN_TRIES) delete req.session.pendingLogin;
}

app.get("/login/verify", (req, res) => {
  if (req.me) return res.redirect(rbac.landing(req.perm));
  const p = pendingLogin(req);
  if (!p) return res.redirect("/login");
  const rp = passkeys.rpFor(req);
  res.send(
    views.loginVerify({
      csrf: res.locals.csrf,
      username: p.username,
      passkeys: !!rp,
      primary: passkeys.primaryOrigin(),
      error: req.query.err ? "That did not work. Try again, or use your authenticator code." : null,
    })
  );
});

/** Options for navigator.credentials.get(): the same shape for every pending sign-in. */
app.post("/login/passkey/options", passkeyLimiter, requireCsrf, async (req, res) => {
  const p = pendingLogin(req);
  if (!p) return res.status(409).json({ error: "Start again.", restart: true });
  const rp = passkeys.rpFor(req);
  if (!rp) return res.status(400).json({ error: "Passkeys do not work at this address. Use your authenticator code." });
  req.session.pendingLogin.slot = req.session.pendingLogin.slot || {};
  res.json({ options: await passkeys.loginOptions(rp, req.session.pendingLogin.slot) });
});

app.post("/login/passkey", passkeyLimiter, requireCsrf, async (req, res) => {
  const p = pendingLogin(req);
  if (!p) return res.status(409).json({ error: "Start again.", restart: true });
  const rp = passkeys.rpFor(req);
  const account = pendingAccount(p);
  const fail = (reason) => {
    secondStepFailed(req, p, "bad passkey: " + reason);
    // One answer for every failure: which part was wrong is not said.
    return res.status(401).json({ error: "Invalid credentials.", restart: !req.session.pendingLogin });
  };
  if (!rp) return fail("address not allowed (" + passkeys.hostOf(req) + ")");
  p.slot = p.slot || {};
  if (!account) {
    // A wrong password: spend the challenge all the same, then refuse.
    passkeys.discardChallenge(p.slot);
    return fail("password was not accepted");
  }
  const r = await passkeys.verifyAuthentication(account, rp, p.slot, req.body && req.body.response);
  if (!r.ok) return fail(r.error);
  delete req.session.pendingLogin;
  completeLogin(req, res, account, `passkey "${r.passkey.name}" (${rp.rpID})`, (err, to) =>
    err ? res.status(500).json({ error: "Session error." }) : res.json({ ok: true, redirect: to })
  );
});

/** The fallback: the authenticator code, on the same pending sign-in. */
app.post("/login/code", loginLimiter, requireCsrf, (req, res) => {
  const p = pendingLogin(req);
  if (!p) return res.redirect("/login");
  const account = pendingAccount(p);
  if (!account || !totp.verifyAndConsume(account, req.body.token)) {
    if (account) secondStepFailed(req, p, "bad totp");
    // As on the one-step form: a wrong code and a wrong password look the
    // same, so the sign-in starts again rather than offering another try here.
    delete req.session.pendingLogin;
    return res.redirect("/login?again=1");
  }
  if (!account.totp_confirmed) db.confirmUserTotp(account.id);
  delete req.session.pendingLogin;
  completeLogin(req, res, account, null, (err, to) =>
    err ? res.status(500).send(views.error("Session error", String(err))) : res.redirect(to)
  );
});

app.post("/logout", requireCsrf, (req, res) => {
  endLiveCallsForSession(req.sessionID, "signed-out"); // this device's live call ends with its session
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
      devices: req.perm.can("keys.pair") ? db.listDevices() : null,
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
        canManage: req.perm.can("keys.manage"),
        canPair: req.perm.can("keys.pair"),
        codes: req.perm.can("keys.pair") ? db.listPairingCodes() : [],
        // A code just created: shown once, on the page the create redirected to.
        newCode: req.perm.can("keys.pair") && /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(String(req.query.code || "")) ? String(req.query.code) : null,
        publicHost: PUBLIC_HOST,
        publicPort: PUBLIC_PORT,
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

/* -------------------------------------------------------------- devices --- */

/**
 * Devices: the browsers signed in to Mint OS as you (lib/sessions.js). Every
 * signed-in user sees and may sign out their own; no permission is needed.
 * Signing a browser out destroys its session in the store -- its next request
 * lands on the sign-in page -- and ends any live voice call bound to it.
 */
function endCallsFor(sids, why) {
  // Added by the live-voice work; this branch must run without it.
  if (typeof endLiveCallsForSession !== "function") return;
  for (const sid of sids) {
    try {
      endLiveCallsForSession(sid, why);
    } catch (_) {
      /* the session is gone either way */
    }
  }
}

app.get("/devices", requireAuth, (req, res) => {
  res.send(
    views.devices({
      csrf: res.locals.csrf,
      user: ctx(req),
      devices: deviceSessions.listFor(req.me.id, req.sessionID),
      canPair: req.perm.can("keys.pair"),
      flash: req.query.msg || null,
      flashError: req.query.err || null,
    })
  );
});

app.post("/devices/signout-others", requireAuth, requireCsrf, async (req, res) => {
  const sids = deviceSessions.sidsFor(req.me.id, req.sessionID);
  const n = await deviceSessions.destroyMany(sids);
  endCallsFor(sids, "signed out");
  deviceSessions.forget(req.me.id);
  db.logLogin(req.ip, req.me.username, "devices", `signed out ${n} other device${n === 1 ? "" : "s"}`);
  res.redirect("/devices?msg=" + encodeURIComponent(n ? `Signed out ${n} other device${n === 1 ? "" : "s"}.` : "No other device was signed in."));
});

app.post("/devices/:id/signout", requireAuth, requireCsrf, async (req, res) => {
  const sid = deviceSessions.resolve(req.me.id, String(req.params.id));
  if (!sid) return res.redirect("/devices?err=" + encodeURIComponent("That device is no longer signed in."));
  if (sid === req.sessionID)
    return res.redirect("/devices?err=" + encodeURIComponent("This is the device you are using. Sign out from the avatar menu instead."));
  const row = deviceSessions.listFor(req.me.id, req.sessionID).find((d) => d.id === req.params.id);
  try {
    await deviceSessions.destroy(sid);
  } catch (e) {
    return res.redirect("/devices?err=" + encodeURIComponent("Could not sign that device out: " + e.message));
  }
  endCallsFor([sid], "signed out");
  deviceSessions.forget(req.me.id);
  const what = row ? row.label + (row.ip ? " (" + row.ip + ")" : "") : "a device";
  db.logLogin(req.ip, req.me.username, "devices", "signed out " + what);
  res.redirect("/devices?msg=" + encodeURIComponent("Signed out " + (row ? row.label : "that device") + "."));
});

/* -------------------------------------------------------------- pairing --- */

/**
 * Pairing a laptop for SSH lives on SSH keys (card "Pair a device"): a code
 * installs a key, it is not a sign-in. The POST URLs it had under /devices
 * answer 307 so a form still open on an old page keeps working (307 keeps the
 * method and the body, CSRF token included).
 */
app.post("/keys/pair", requireAuth, requirePerm("keys.pair"), requireCsrf, (req, res) => {
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
  db.logLogin(req.ip, req.me.username, "keys", `created a pairing code for "${label}" (${targetUser})`);
  res.redirect("/keys?code=" + encodeURIComponent(code) + "#pair");
});

app.post("/keys/pair/revoke", requireAuth, requirePerm("keys.pair"), requireCsrf, (req, res) => {
  const code = String(req.body.code || "");
  const gone = db.deletePairingCode(code).changes;
  if (gone) db.logLogin(req.ip, req.me.username, "keys", "revoked a pairing code");
  res.redirect("/keys?msg=" + encodeURIComponent(gone ? "Pairing code revoked." : "That code was already gone.") + "#pair");
});

app.post("/devices/code", (req, res) => res.redirect(307, "/keys/pair"));
app.post("/devices/code/revoke", (req, res) => res.redirect(307, "/keys/pair/revoke"));

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

/**
 * The "Send files to chat" switch. An unticked checkbox sends nothing, so the
 * form also carries file_send_shown; without it the answer is `missing`.
 */
function fileSendField(body, missing) {
  if (!body || field(body, "file_send_shown") !== "1") return missing;
  return field(body, "file_send") === "1";
}

/** The "Images (drawn in code)" switch, read the same way as fileSendField. */
function drawingField(body, missing) {
  if (!body || field(body, "drawing_shown") !== "1") return missing;
  return field(body, "drawing") === "1";
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

/* Agents & sessions ▸ Overview: the sessions round MINT AI, the Telegram nursery, capabilities. */
app.get("/agents/dashboard", requireAuth, async (req, res) => {
  const seesAgents = req.perm.can("agents.view");
  const seesTeam = req.perm.can("moniai.use");
  if (!seesAgents && !seesTeam && !req.perm.can("claude.running.view")) return res.status(403).send(views.error("Not allowed", "Your role does not include Agents & sessions."));
  const data = await gather({
    agents: () => (seesAgents ? priv.agentList() : Promise.resolve([])),
    channels: () => (seesAgents ? priv.channelList() : Promise.resolve([])),
    probe: () => (seesAgents ? priv.systemProbe() : Promise.resolve(null)),
    running: () => (req.perm.can("claude.running.view") ? priv.ccRunning() : Promise.resolve(null)),
    memory: () => (req.perm.can("claude.memory.read") ? moniAiMemoryCounts() : Promise.resolve(null)),
  });
  const team = seesTeam ? await sessionsTeam(req) : null;
  let limits = null;
  if (seesTeam) limits = await moniai.call("hire-limits", {}, req.me.username).catch(() => null);
  let facts = null;
  try {
    facts = data.memory && data.memory.facts != null ? data.memory.facts : null;
  } catch (_) {
    facts = null;
  }
  res.send(
    agentViews.dashboard({
      csrf: res.locals.csrf,
      user: ctx(req),
      agents: scopeAgents(req, data.agents || []),
      channels: scopeChannels(req, data.channels || []),
      probe: data.probe || null,
      flash: req.query.msg || null,
      err: req.query.err || (seesAgents ? data.errors.agents : null) || null,
      team,
      limits,
      facts,
      running: data.running || null,
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
    file_send: fileSendField(req.body, true),
    drawing: drawingField(req.body, true),
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
      file_send: form.file_send,
      drawing: form.drawing,
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
      // undefined (form without the switch) leaves the stored value alone
      file_send: fileSendField(req.body, undefined),
      drawing: drawingField(req.body, undefined),
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
  const topicsForm = topics.parseTopicsForm(req.body);
  const token = String(req.body.token || "").trim();
  const errors = [];
  if (type === "telegram") errors.push(...topics.checkTopics(topicsForm));

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
    const created = await priv.channelCreate({
      slug: form.slug,
      name: form.name,
      type,
      agent: form.agent,
      token,
      telegram_bot_username: bot ? bot.username : "",
      allowed_users: form.allowed_users,
      allowed_numbers: form.allowed_numbers,
      ...topics.topicsPayload(topicsForm),
      addons,
      addon_env: catalog.envFor(addons, "channel", req.body),
    });
    // The channel exists either way; a Topics setting that did not start was
    // switched off by the helper, which says why.
    const topicsNote = created && created.topics_error ? " " + created.topics_error : "";
    // Finishing the wizard lands on the agent, not the channel: the thing you
    // set out to build was an agent that works, and its page is where you
    // check that it does.
    if (req.body.wizard && form.agent) {
      return res.redirect(
        agentRedirect(form.agent, "", {
          msg:
            "Agent and channel are ready." +
            (bot ? " Say hello to @" + bot.username + " on Telegram." : "") +
            topicsNote,
        })
      );
    }

    const msg = (form.agent
      ? "Channel created and connected." +
        (bot ? " Say hello to @" + bot.username + " on Telegram." : "")
      : "Channel created. Connect it to an agent to bring it to life.") + topicsNote;
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
  // The folders a topic may map to (inside the connected agent's folder), and
  // the proposed default list for a channel that has none yet.
  let topicFolders = null;
  if (channel.type === "telegram" && channel.agent) {
    try {
      topicFolders = await priv.channelTopicsFolders(channel.slug);
    } catch (_) {
      /* the view falls back to a plain text field */
    }
  }
  res.send(
    channelViews.detail({
      csrf: res.locals.csrf,
      user: ctx(req),
      channel,
      agents,
      wa,
      topicFolders,
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
    addons,
    addon_env: catalog.envFor(addons, "channel", req.body),
  };

  const bail = (msg) => res.redirect(channelRedirect(channel.slug, "", { err: msg }));
  if (channel.type === "telegram") {
    const t = topics.parseTopicsForm(req.body);
    const problems = topics.checkTopics(t);
    if (problems.length) return bail("Topics not saved: " + problems.join(" "));
    Object.assign(update, topics.topicsPayload(t));
    const r = topics.parseRespondForm(req.body);
    const rProblems = topics.checkRespond(r);
    if (r.has_respond && rProblems.length) return bail("Not saved: " + rProblems.join(" "));
    Object.assign(update, topics.respondPayload(r));
  }

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
  try {
    const saved = await priv.channelUpdate(update);
    const check = saved && saved.topics_check;
    res.redirect(
      channelRedirect(channel.slug, "", {
        msg:
          "Channel saved." +
          (check && check.ok
            ? check.state === "slow"
              ? (update.topics_enabled ? " Topics are on; the" : " The") + " bot is still starting, so check its log in a minute."
              : update.topics_enabled
                ? " Topics are on and the bot started in topic mode."
                : " The bot started with the new settings."
            : ""),
      })
    );
  } catch (e) {
    return bail(e.message);
  }
});

/**
 * Telegram Topics ▸ Trash: put a deleted topic's folder back in topics/, or
 * delete it now. The helper checks the path against the bot's own list
 * (projects.auto.json) under its lock; this only refuses the obviously wrong.
 */
app.post("/channels/:slug/topics/trash", requireAuth, requirePerm("channels.edit"), requireChannelScope, requireCsrf, async (req, res) => {
  const channel = await loadChannel(req, res);
  if (!channel) return;
  const op = field(req.body, "op");
  const trashPath = field(req.body, "trash_path");
  const back = (params) => res.redirect(channelRedirect(channel.slug, "", params));
  if (channel.type !== "telegram" || !channel.agent) return back({ err: "This channel has no topic folders." });
  if (!["restore", "delete"].includes(op)) return back({ err: "Unknown action." });
  if (!/^\.trash\/topics\/[^/\\\x00-\x1f]{1,120}$/.test(trashPath)) return back({ err: "That is not a folder in the trash." });
  try {
    const r = await priv.channelTopicsTrash(channel.slug, op, trashPath);
    back({
      msg: op === "restore"
        ? "Folder restored to " + ((r && r.path) || "topics/") + ". A new topic with its name is linked to it again."
        : "Folder deleted.",
    });
  } catch (e) {
    back({ err: e.message });
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

/* Machine ▸ Services: tabs All / System (services.view) and Agents (agents.view; was /services/agents). */
app.get("/services", requireAuth, async (req, res) => {
  const seesSvc = req.perm.can("services.view");
  const seesAgents = req.perm.can("agents.view");
  if (!seesSvc && !seesAgents) return res.status(403).send(views.error("Not allowed", "Your role does not include services."));
  let kind = ["all", "system", "agents"].includes(req.query.kind) ? req.query.kind : seesSvc ? "all" : "agents";
  if (kind === "agents" && !seesAgents) kind = "all";
  if (kind !== "agents" && !seesSvc) kind = "agents";
  const flash = req.query.msg || null;
  const err = req.query.err || null;
  try {
    if (kind === "agents") {
      const agents = scopeAgents(req, await priv.agentList());
      return res.send(serviceViews.agents({ csrf: res.locals.csrf, user: ctx(req), agents, flash, err, counts: { agents: agents.length } }));
    }
    const list = await priv.serviceList();
    primeFrame(req, list);
    const services = chrome.visibleServices(list, req.perm);
    const system = services.filter((s) => !serviceViews.isAgentUnit(s));
    res.send(
      serviceViews.system({
        csrf: res.locals.csrf,
        user: ctx(req),
        services: kind === "system" ? system : services,
        kind,
        counts: { all: services.length, system: system.length },
        flash,
        err,
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

// What was Agents ▸ Agent services is Machine ▸ Services ▸ Agents.
app.get("/services/agents", requireAuth, (req, res) => {
  const q = new URLSearchParams({ kind: "agents" });
  if (req.query.msg) q.set("msg", String(req.query.msg));
  if (req.query.err) q.set("err", String(req.query.err));
  res.redirect(302, "/services?" + q.toString());
});

app.post("/services/agent-action", requireAuth, requirePerm("agents.control"), requireCsrf, async (req, res) => {
  const slug = field(req.body, "target");
  const action = field(req.body, "action");
  // Scope is re-checked here because the slug arrives in the body rather than
  // the path, so requireAgentScope never sees it.
  if (!SLUG_RE.test(slug) || !req.perm.seesAgent(slug))
    return res.redirect("/services?kind=agents&err=" + encodeURIComponent("Unknown agent."));
  try {
    await priv.agentAction(slug, action);
    res.redirect("/services?kind=agents&msg=" + encodeURIComponent(slug + " " + action + "ed."));
  } catch (e) {
    res.redirect("/services?kind=agents&err=" + encodeURIComponent(e.message));
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

/**
 * Drop the cached voice settings. `live` says what happens to open live
 * calls: "close" (the key was removed: nothing to talk with), "keep" (a test
 * of what is on disk: nothing changed), or "reconnect" (a new key or new voice
 * settings: every call reconnects its upstream with them and goes on -- see
 * voiceReconnect). A live call is never dropped for a change it can survive.
 */
function voiceForget(live) {
  voiceCache = { at: 0, cfg: null, pending: null };
  voice.clearCache();
  voiceShared.closeAll(); // a changed key or voice must not keep a summariser open on the old one
  if (live === "close") voiceLive.closeAll("settings-changed");
}
/** After voiceForget("reconnect"): every open live call reconnects with the settings now on disk. */
async function voiceReconnect(greetActor) {
  if (!voiceLive.activeCount()) return [];
  const cfg = await voiceConfig();
  if (!cfg.key) {
    voiceLive.closeAll("settings-changed");
    return [];
  }
  const out = await voiceLive.swapAll(liveCfgOf(cfg), greetActor);
  out.forEach((r) => console.log(`live: ${r.actor}'s call ${r.ok ? "reconnected" : "could not reconnect"} after a voice settings change${r.ms != null ? " (" + r.ms + " ms)" : ""}`));
  return out;
}
/**
 * A voice.set the administrator confirmed (UI control Phase 3): while its
 * confirm is open the voice is locked -- no other change of voice gets in --
 * and once taken, the options post that applies it may greet in the new voice.
 */
const voiceGreet = new Map(); // actor -> until (ms): their confirmed voice.set is being applied
/** Is a voice.set waiting for anyone's confirm? (The voice is global.) */
function uiConfirmsVoicePending() {
  return uiConfirms.anyPending("voice.set");
}

/**
 * Voice on or off, for everyone: one switch (MINT AI ▸ Settings ▸ Voice). A
 * panel setting, not a secret, so it lives in the panel's database -- in the
 * key the front desk's three-way mode used ("voice_desk"), with new values:
 *   "on"   voice is live conversation, for those who may use it (voice.use)
 *   "off"  no voice at all: no microphone, no read-aloud, no live call, and
 *          MINT AI's voice screen actions are refused. The key stays stored.
 * The old values map onto them when read (0 -> off; 1 and live -> on), and are
 * rewritten once at start (migrateVoiceSetting), so a downgrade reads "on" /
 * "off" as its own "off" (an unknown value) -- never as voice on.
 */
const VOICE_SETTING = "voice_desk";
function voiceSettingValue(raw) {
  const v = String(raw == null ? "" : raw).trim();
  return v === "on" || v === "1" || v === "live" ? "on" : "off";
}
function voiceEnabled() {
  try {
    return voiceSettingValue(db.getSetting(VOICE_SETTING, "off")) === "on";
  } catch (_) {
    return false;
  }
}
/** The one-time rewrite of the old values (idempotent: on / off / unset are left alone). */
function migrateVoiceSetting() {
  try {
    const raw = db.getSetting(VOICE_SETTING, null);
    if (raw === null || raw === undefined || raw === "on" || raw === "off") return null;
    const now = voiceSettingValue(raw);
    db.setSetting(VOICE_SETTING, now, "migration");
    console.log(`voice: the voice setting ${JSON.stringify(String(raw).slice(0, 10))} became "${now}" (voice is live conversation only)`);
    return now;
  } catch (e) {
    console.log("voice: could not migrate the voice setting: " + e.message);
    return null;
  }
}
migrateVoiceSetting();
/** May this actor talk to MINT AI by voice (administrators by default)? */
function voiceAllowed(perm) {
  return !!(perm && perm.can && perm.can("moniai.use") && perm.can("voice.use"));
}
/**
 * The voice model (Settings ▸ Voice): the live call's realtime model, and the
 * model that reads replies aloud when it passed the verbatim check
 * (lib/voice.js READER_MODELS; any other choice is read by
 * gpt-realtime-2.1-mini: readerModelFor). What the administrator said is
 * written down by the transcription model chosen under it (the Transcription
 * setting below, since 2026-09-30). A panel setting; the helper's file holds
 * the same reader model and the live session's transcription model, rewritten
 * to match on every save and once at start (migrateVoiceHelperModels).
 */
const VOICE_MODEL_SETTING = "voice_model";
/**
 * The chosen voice model, as stored (a VOICE_MODELS id). A gated model the key
 * is KNOWN not to reach (voiceAccess below) gives the default instead, so a
 * call never starts on a model OpenAI will refuse; not known yet keeps the
 * choice (it was available when it was saved).
 */
function voiceModel() {
  try {
    const v = db.getSetting(VOICE_MODEL_SETTING, "");
    if (!voice.VOICE_MODELS.some((m) => m.id === v)) return voice.VOICE_MODEL_DEFAULT;
    const a = voiceModelAccess()[v];
    return a && a.known && !a.available ? voice.VOICE_MODEL_DEFAULT : v;
  } catch (_) {
    return voice.VOICE_MODEL_DEFAULT;
  }
}
/** The id the live call connects with: a gated model's listed id or dated snapshot, else the model itself. */
function voiceLiveModelId(model) {
  const a = voiceModelAccess()[model];
  return (a && a.use) || model;
}
/**
 * Which voice models the key reaches (lib/voice.js modelAccess): its free
 * /v1/models listing, read at start, after the key changes, when Settings ▸
 * Voice is opened with an answer older than VOICE_ACCESS_TTL_MS (in the
 * background), and before a gated model is saved. Only ids are kept. So
 * GPT-4o Mini Realtime enables itself once the key gains it.
 */
// (The two env values exist for the tests: tools/test-voice-models.cjs.)
const VOICE_ACCESS_TTL_MS = Number(process.env.MONI_VOICE_ACCESS_TTL_MS) >= 0 && process.env.MONI_VOICE_ACCESS_TTL_MS ? Number(process.env.MONI_VOICE_ACCESS_TTL_MS) : 6 * 60 * 60 * 1000;
const VOICE_ACCESS_RECHECK_MS = Number(process.env.MONI_VOICE_ACCESS_RECHECK_MS) >= 0 && process.env.MONI_VOICE_ACCESS_RECHECK_MS ? Number(process.env.MONI_VOICE_ACCESS_RECHECK_MS) : 60 * 1000;
let voiceAccess = { at: 0, ids: null, error: null, pending: null };
function voiceModelAccess() {
  return voice.modelAccess(voiceAccess.ids);
}
function checkVoiceAccess(opts) {
  const force = !!(opts && opts.force);
  if (!force && voiceAccess.at && Date.now() - voiceAccess.at < VOICE_ACCESS_TTL_MS) return Promise.resolve(voiceAccess);
  if (voiceAccess.pending) return voiceAccess.pending;
  const pending = voiceConfig()
    .then((cfg) => {
      if (!cfg.key) return { ids: null, error: "no token" };
      return voice.listModels({ key: cfg.key, httpBase: process.env.MONI_OPENAI_HTTP || undefined }).then(
        (ids) => ({ ids, error: null }),
        (e) => ({ ids: null, error: priv.redact(String(e.message || e)) })
      );
    })
    .catch((e) => ({ ids: null, error: priv.redact(String(e.message || e)) }))
    .then((r) => {
      const was = JSON.stringify(voiceModelAccess());
      // A failed check keeps the last good listing (a blip must not disable a working choice).
      voiceAccess = { at: Date.now(), ids: r.ids || voiceAccess.ids, error: r.error, pending: null };
      if (r.error) console.log("voice: could not list the key's models: " + r.error);
      if (JSON.stringify(voiceModelAccess()) !== was) voiceCache = { at: 0, cfg: null, pending: null };
      return voiceAccess;
    });
  voiceAccess.pending = pending;
  return pending;
}
/**
 * The voice model setting, cleaned once at start. Idempotent: nothing stored
 * or a value in VOICE_MODELS is left alone -- gpt-realtime-mini and GPT-4o
 * Mini Realtime are choices again (2026-10-01), so the rewrite of 2026-09-30
 * that turned them into gpt-realtime-2.1-mini no longer happens; only an
 * unknown value (gpt-realtime, gpt-live-1, junk) becomes the default. The
 * helper's file is rewritten only when it differs (and holds a key).
 */
function migrateVoiceModelSetting() {
  try {
    const raw = db.getSetting(VOICE_MODEL_SETTING, null);
    if (raw === null || raw === undefined || raw === "" || voice.VOICE_MODELS.some((m) => m.id === raw)) return null;
    const now = voice.VOICE_MODEL_DEFAULT;
    db.setSetting(VOICE_MODEL_SETTING, now, "migration");
    console.log(`voice: the voice model ${JSON.stringify(String(raw).slice(0, 40))} is not offered; it became "${now}"`);
    return now;
  } catch (e) {
    console.log("voice: could not migrate the voice model: " + e.message);
    return null;
  }
}
async function migrateVoiceHelperModels() {
  try {
    const d = await priv.voiceKeyRead();
    if (!d || !d.key) return null; // nothing stored yet: the first save writes the pair
    const model = voiceModel();
    const reader = voice.readerModelFor(model);
    const listen = voiceTranscribe.sessionModelFor(transcription().model);
    if (d.model === reader && d.transcribe_model === listen) return null;
    const name = voice.VOICES.includes(d.voice) ? d.voice : voice.DEFAULTS.voice;
    await priv.voiceOptionsSet(reader, name, listen);
    voiceCache = { at: 0, cfg: null, pending: null };
    console.log(`voice: the helper's voice options became ${reader} / ${name} / ${listen} (were ${String(d.model || "-").slice(0, 40)} / ${String(d.transcribe_model || "-").slice(0, 40)})`);
    return { reader, listen };
  } catch (e) {
    console.log("voice: could not migrate the helper's voice options: " + priv.redact(String(e.message || e)));
    return null;
  }
}
migrateVoiceModelSetting();

/**
 * Transcription (Settings ▸ Voice ▸ Transcription, 2026-09-30): which model
 * writes down the full turn -- the transcript MINT AI works from -- and the
 * language hint. A panel setting, JSON {model, language}
 * (lib/voice-transcribe.js TRANSCRIBERS / LANGUAGES); nothing stored means
 * gpt-4o-mini-transcribe and "auto", the behaviour before the setting. The live
 * session's own transcription stays on an OpenAI model (sessionModelFor), held
 * in the helper's file as before. A local model runs on this server
 * (moni-voice-whisper.service), started and stopped through the helper.
 */
const VOICE_TRANSCRIPTION_SETTING = "voice_transcription";
function transcription() {
  let v = null;
  try {
    v = JSON.parse(db.getSetting(VOICE_TRANSCRIPTION_SETTING, "") || "null");
  } catch (_) {
    v = null;
  }
  return voiceTranscribe.clean(v);
}
/** Idempotent: an unreadable or unknown stored value becomes the cleaned one; nothing stored stays nothing (the default). */
function migrateTranscriptionSetting() {
  try {
    const raw = db.getSetting(VOICE_TRANSCRIPTION_SETTING, null);
    if (raw === null || raw === undefined || raw === "") return null;
    const now = JSON.stringify(transcription());
    if (raw === now) return null;
    db.setSetting(VOICE_TRANSCRIPTION_SETTING, now, "migration");
    console.log(`voice: the transcription setting ${JSON.stringify(String(raw).slice(0, 60))} became ${now}`);
    return now;
  } catch (e) {
    console.log("voice: could not migrate the transcription setting: " + e.message);
    return null;
  }
}
migrateTranscriptionSetting();
/** What is installed for local transcription (the helper), or {error}. */
async function whisperStatus() {
  try {
    return await priv.voiceWhisperStatus();
  } catch (e) {
    return { error: priv.redact(String(e.message || e)) };
  }
}
/**
 * At start: a local model selected means its server should run (after a
 * reboot the unit is enabled and does already; this covers a stopped one).
 * The helper restarts it only when it is not running or runs another model.
 */
async function syncLocalTranscriber() {
  const t = voiceTranscribe.byId(transcription().model);
  if (!t || t.kind === "openai") return null;
  try {
    const st = await priv.voiceWhisperSet(t.model);
    console.log(`voice: local transcription server ${st && st.active === "active" ? "running" : "not running"} with ${t.model}`);
    return st;
  } catch (e) {
    console.log(`voice: could not start the local transcription server for ${t.id} (turns fall back to ${voiceTranscribe.FALLBACK_MODEL}): ` + priv.redact(String(e.message || e)));
    return null;
  }
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
 * every call -- the live call's audio, its summaries, every sentence spoken --
 * per voice turn and per kind of turn (lib/voice-usage.js). Shown in the
 * Command Center's Cost today card. No cap (the administrator's decision of
 * 2026-09-29): the voice is never refused for what it has spent (the daily
 * token caps in Usage & budget are separate).
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

/** The full-turn transcriber's part of the voice config (lib/voice-transcribe.js reads it). */
function transcriberCfg(tr) {
  return { transcriber: tr.model, transcribe_language: tr.language, heard_wait_ms: voiceTranscribe.heardWaitMs(tr.model) };
}
/** The fields a live call takes from the voice config (a new call, or a reconnect after a change). */
function liveCfgOf(cfg) {
  return { key: cfg.key, voice: cfg.voice, model: cfg.model, live_model: cfg.live_model, transcribe_model: cfg.transcribe_model, transcriber: cfg.transcriber, transcribe_language: cfg.transcribe_language, heard_wait_ms: cfg.heard_wait_ms };
}

async function voiceConfig() {
  if (voiceCache.cfg && Date.now() - voiceCache.at < VOICE_TTL_MS) return voiceCache.cfg;
  if (voiceCache.pending) return voiceCache.pending;
  const pending = priv
    .voiceKeyRead()
    .then((d) => {
      const live = voiceModel();
      const tr = transcription();
      const cfg = {
        key: d && d.key ? String(d.key) : null,
        // The voice model talks live; it reads aloud too only when it passed the
        // verbatim check (readerModelFor: otherwise gpt-realtime-2.1-mini reads).
        model: voice.readerModelFor(live),
        live_model: voiceLiveModelId(live),
        voice_model: live,
        voice: (d && d.voice) || voice.DEFAULTS.voice,
        // The live session's own transcription: always an OpenAI model.
        transcribe_model: voiceTranscribe.sessionModelFor(tr.model),
        ...transcriberCfg(tr),
      };
      if (voiceCache.pending === pending) voiceCache = { at: Date.now(), cfg, pending: null };
      return cfg;
    })
    .catch((e) => {
      if (voiceCache.pending === pending) voiceCache.pending = null;
      const tr = transcription();
      return { key: null, ...voice.DEFAULTS, live_model: voiceLiveModelId(voiceModel()), voice_model: voiceModel(), transcribe_model: voiceTranscribe.sessionModelFor(tr.model), ...transcriberCfg(tr), error: e.message };
    });
  voiceCache.pending = pending;
  return pending;
}

/**
 * What a page may know: whether voice works for this viewer, and with what.
 * Never the key. `on` is the Settings switch; `use` this viewer's voice.use;
 * `live` all of it and a key -- the only case in which any mic, read-aloud or
 * live control is rendered.
 */
async function voicePublic(req) {
  const cfg = await voiceConfig();
  const on = voiceEnabled();
  const use = voiceAllowed(req && req.perm);
  return {
    configured: !!cfg.key,
    model: cfg.voice_model || cfg.live_model,
    voice: cfg.voice,
    provider: "OpenAI",
    manage: !!(req && req.perm && req.perm.can("voice.manage")),
    on,
    use,
    live: !!cfg.key && on && use,
    liveDuplex: liveAudio().duplex,
  };
}
/**
 * The dock's microphone on the other pages (lib/ui.js dockMarkup): shown only
 * when live conversation works for this viewer. The voice settings are cached,
 * so this costs nothing once they have been read; until then (the first page
 * after a restart) it waits for them once.
 */
async function voiceDockOk(req) {
  if (!req.me || !voiceEnabled() || !voiceAllowed(req.perm)) return false;
  const cfg = await voiceConfig();
  return !!cfg.key;
}

/** Voice is off for everyone (Settings ▸ Voice): the refusal a voice route gives. */
function voiceOffRefuse(res) {
  return res.status(409).json({ error: "Voice is off. An administrator can switch it on in MINT AI ▸ Settings ▸ Voice.", code: "voice-off" });
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

/** The console's dictation: base64 recording in, text out (the Command Center's push to talk used it too, until 2026-09-30). */
async function voiceTranscribeRoute(req, res) {
  if (!voiceEnabled()) return voiceOffRefuse(res);
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
      transcribe: voiceTranscribe.transcribeFull,
      grounds: voiceGrounds,
      actor: req.me && req.me.username,
      vt,
    });
    const text = got.text;
    const usd = got.heard ? recordTranscription({ vt, actor: req.me && req.me.username, heard: got.heard }) : 0;
    voiceLog("transcribe", 200, {
      model: (got.heard && (got.heard.transcriber || got.heard.model)) || cfg.transcriber,
      fallback_from: got.heard && got.heard.fallback ? got.heard.fallback.from + ":" + got.heard.fallback.why : undefined,
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
    voiceLog("transcribe", e.code || "error", { model: cfg && cfg.transcriber, ms: Date.now() - t0, bytes: audio.length, why: e.message });
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
  if (!voiceEnabled()) return voiceOffRefuse(res);
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

/* MINT AI ▸ Settings ▸ Voice (/mint-ai/settings/voice): the section and its
   forms. The key is write-only: it is posted once, handed to the helper on
   stdin into the same root-only file, and from then on the panel only says
   whether it is set. Every form answers os.js in place (JSON with the note)
   and a plain POST with a redirect back to the row. */

const voiceSettingsViews = require("./lib/views-settings-voice");

async function voiceSettings() {
  try {
    return await priv.voiceStatus();
  } catch (e) {
    return { error: e.message, configured: false, ...voice.DEFAULTS };
  }
}

/** Answer a voice form: settingsRoutes' reply, plus {message|error} for the Command Center's confirmed changes. */
function voiceReply(req, res, { msg, err, anchor, reload } = {}) {
  if (settingsRoutes.wantsJson(req)) {
    const { flashes } = require("./lib/ui");
    return res.status(err ? 400 : 200).json({ ok: !err, flash: flashes({ msg, err }), reload: !!reload, ...(err ? { error: err } : { message: msg || "" }) });
  }
  return settingsRoutes.reply(req, res, "voice", { msg, err, anchor, reload });
}
/** Signed in, MINT AI and voice.manage (the section's own rule), then the CSRF token. */
function voiceSettingsPerm(req, res, next) {
  if (req.perm.can("moniai.use") && req.perm.can("voice.manage")) return next();
  if (settingsRoutes.wantsJson(req)) return res.status(403).json({ ok: false, error: "This account cannot change voice settings." });
  return requirePerm("voice.manage")(req, res, next);
}
const voiceGuardSettings = [requireAuth, voiceSettingsPerm, requireCsrf];

settingsRoutes.sections.voice = async (req, res) => {
  const on = voiceEnabled();
  // Which voice models the key reaches: a stale answer is refreshed in the background (the next visit shows it).
  checkVoiceAccess().catch(() => {});
  const [status, cfg, local] = await Promise.all([voiceSettings(), voiceConfig(), whisperStatus()]);
  const test = req.query.test ? { ok: req.query.test === "ok", text: String(req.query.t || "").slice(0, 600) } : null;
  const persona = personaOf(req.me.id);
  return {
    body: voiceSettingsViews.body({
      csrf: res.locals.csrf,
      on,
      status: status.error ? { configured: !!cfg.key } : status,
      model: cfg.voice_model || cfg.live_model,
      models: voice.VOICE_MODELS,
      access: voiceModelAccess(),
      voice: cfg.voice,
      voices: voice.VOICES,
      meta: voice.VOICE_META,
      transcribe: cfg.transcribe_model,
      transcription: transcription(),
      transcribers: voiceTranscribe.TRANSCRIBERS,
      languages: voiceTranscribe.LANGUAGES,
      local,
      persona: { ...voicePersona.describe(persona), mode: persona.mode, preset: persona.preset },
      liveAudio: liveAudio(),
      usage: voiceUsageSummary(),
      test,
    }),
    secClass: on ? "" : "voice-off",
    assets: ["mint-settings-voice.css", "mint-settings-voice.js"],
  };
};
settingsRoutes.marks.push(async () => ({ voice: voiceEnabled() ? "on" : "off" }));

/*
 * The old /credentials/openai-voice URLs (bookmarks, the Guide, the page
 * registry until it is rescanned): a page GET goes to the section (302);
 * a form POST keeps its method and body and goes to its new route (308), so
 * an old form or a Command Center still running the old script keeps working.
 * The desk switch is gone: its POST lands on the section with a note.
 */
app.get("/credentials/openai-voice", requireAuth, (req, res) => res.redirect(302, "/mint-ai/settings/voice"));
for (const k of ["key", "clear", "test", "options", "persona", "persona/reset", "live-audio", "transcription"]) {
  app.post("/credentials/openai-voice/" + k, (req, res) => res.redirect(308, "/mint-ai/settings/voice/" + k));
}
app.post("/credentials/openai-voice/desk", requireAuth, (req, res) =>
  res.redirect(303, "/mint-ai/settings/voice?msg=" + encodeURIComponent("The voice front desk is gone: voice is live conversation, switched on or off here."))
);

/** The switch: voice on or off, for everyone. Off ends every open live call; the key is kept. */
app.post("/mint-ai/settings/voice/enabled", ...voiceGuardSettings, (req, res) => {
  const want = req.body.enabled === "1" || req.body.enabled === "on" ? "on" : "off";
  const was = voiceEnabled() ? "on" : "off";
  db.setSetting(VOICE_SETTING, want, req.me.username);
  let closed = 0;
  if (want === "off") {
    closed = voiceLive.activeCount();
    voiceLive.closeAll("disabled");
    voiceShared.closeAll();
  }
  db.logLogin(req.ip, req.me.username, "voice", `voice ${want === "on" ? "enabled" : "disabled"} for everyone${was === want ? " (unchanged)" : ""}${closed ? ` (${closed} live call(s) ended)` : ""}`);
  voiceReply(req, res, {
    msg: want === "on" ? "Voice is on: live conversation, for those whose role includes it." : "Voice is off for everyone. The token stays stored." + (closed ? ` ${closed} live call${closed === 1 ? "" : "s"} ended.` : ""),
    anchor: "v-main",
    reload: true,
  });
});

app.post("/mint-ai/settings/voice/key", ...voiceGuardSettings, async (req, res) => {
  const value = String((req.body && req.body.value) || "").trim();
  try {
    const out = await priv.voiceKeySet(value);
    voiceForget("reconnect");
    voiceReconnect(null).catch(() => {});
    checkVoiceAccess({ force: true }).catch(() => {}); // a new key may reach other models
    db.logLogin(req.ip, req.me.username, "voice", "set the OpenAI voice key (…" + out.last4 + ")");
    voiceReply(req, res, { msg: "Token saved. Press Test to check it.", anchor: "v-token", reload: true });
  } catch (e) {
    voiceReply(req, res, { err: priv.redact(e.message), anchor: "v-token" });
  }
});

app.post("/mint-ai/settings/voice/clear", ...voiceGuardSettings, async (req, res) => {
  try {
    await priv.voiceKeyClear();
    voiceForget("close");
    db.logLogin(req.ip, req.me.username, "voice", "removed the OpenAI voice key");
    voiceReply(req, res, { msg: "Token removed. Voice stays off until a new one is added.", anchor: "v-token", reload: true });
  } catch (e) {
    voiceReply(req, res, { err: priv.redact(e.message), anchor: "v-token" });
  }
});

/**
 * The voice model and the voice. Each Settings row posts only its own field; a
 * confirmed voice.set from the Command Center posts the voice. The voice model
 * is the panel's setting (the live call); the helper keeps the reader's
 * model (readerModelFor: the same model when verified, else 2.1 mini), the voice and the live session's transcription
 * model (from the Transcription setting: sessionModelFor). A `transcribe_model`
 * field (an older page) is ignored: transcription has its own row and route.
 */
app.post("/mint-ai/settings/voice/options", ...voiceGuardSettings, async (req, res) => {
  const cur = await voiceConfig();
  const has = (k) => typeof (req.body && req.body[k]) === "string" && req.body[k] !== "";
  const vmodel = has("model") ? field(req.body, "model") : cur.voice_model || voiceModel();
  const name = has("voice") ? field(req.body, "voice") : cur.voice;
  const entry = voice.VOICE_MODELS.find((m) => m.id === vmodel);
  if (!entry || !voice.VOICES.includes(name)) {
    return voiceReply(req, res, { err: "Pick a voice model and a voice from the lists.", anchor: has("model") ? "v-model" : "v-voice" });
  }
  // A gated model is saved only when the key's model list carries it (checked
  // again now unless the answer is under VOICE_ACCESS_RECHECK_MS old), so a live call never
  // starts on a model OpenAI will refuse.
  if (entry.gated && vmodel !== voiceModel()) {
    if (!voiceModelAccess()[vmodel].available && Date.now() - voiceAccess.at >= VOICE_ACCESS_RECHECK_MS) await checkVoiceAccess({ force: true });
    if (!voiceModelAccess()[vmodel].available) {
      return voiceReply(req, res, {
        err: `${entry.label} is not available on this OpenAI key${voiceAccess.error ? " (the model list could not be read: " + voiceAccess.error + ")" : ""}. The voice model is unchanged.`,
        anchor: "v-model",
      });
    }
  }
  // The voice is locked while someone's confirm for a voice.set is open (their confirm applies it).
  const lock = uiConfirmsVoicePending();
  if (lock) return voiceReply(req, res, { err: "A voice change is waiting for a confirm on the Command Center; answer that first.", anchor: "v-voice" });
  try {
    const reader = voice.readerModelFor(vmodel);
    const listen = voiceTranscribe.sessionModelFor(transcription().model);
    await priv.voiceOptionsSet(reader, name, listen);
    // Compared with what is stored too: a stored gated model that is out of reach reads as the default.
    const stored = db.getSetting(VOICE_MODEL_SETTING, "") || "";
    if (vmodel !== voiceModel() || (stored && stored !== vmodel)) db.setSetting(VOICE_MODEL_SETTING, vmodel, req.me.username);
    voiceForget("reconnect");
    const greet = (voiceGreet.get(req.me.username) || 0) > Date.now() ? req.me.username : null;
    voiceGreet.delete(req.me.username);
    // Open live calls reconnect with the new settings and go on; the one whose confirm this is says a line in it.
    voiceReconnect(greet).catch(() => {});
    db.logLogin(req.ip, req.me.username, "voice", `voice settings ${vmodel} (live; read-aloud ${reader}; the call's own transcription ${listen}) / ${name}${voiceLive.activeCount() ? ` (${voiceLive.activeCount()} live call(s) reconnect with it)` : ""}`);
    const what = has("model") && !has("voice") ? `Voice model: ${vmodel}.${reader !== vmodel ? ` Replies are read aloud by ${reader}, which reads word for word.` : ""}` : has("voice") && !has("model") ? `Voice: ${name}.` : "Voice settings saved.";
    voiceReply(req, res, { msg: what, anchor: has("model") && !has("voice") ? "v-model" : "v-voice" });
  } catch (e) {
    voiceReply(req, res, { err: e.message, anchor: "v-voice" });
  }
});

/*
 * The voice persona: learned from speech, or chosen here from a fixed list of
 * presets (lib/voice-persona.js PRESETS) -- never typed. A choice is kept until
 * it is changed here or reset; speech never overrides it. Reset forgets it and
 * learns again. Per user (the scope "you").
 */
app.post("/mint-ai/settings/voice/persona", ...voiceGuardSettings, (req, res) => {
  const preset = field(req.body, "preset");
  const p = voicePersona.choose(preset);
  if (!p) return voiceReply(req, res, { err: "Choose one of the voice personas.", anchor: "v-persona" });
  const was = voicePersona.describe(personaOf(req.me.id));
  db.setVoicePersona(req.me.id, p.mode === "explicit" ? JSON.stringify(p) : "");
  const now = voicePersona.describe(p);
  db.logLogin(req.ip, req.me.username, "voice", `voice persona set to "${now.choice}" (was "${was.choice}")`);
  voiceReply(req, res, { msg: p.mode === "explicit" ? `Voice persona: ${now.choice}. Arabic replies use it from the next utterance; English stays English.` : "Voice persona: learned from how you speak again.", anchor: "v-persona" });
});

app.post("/mint-ai/settings/voice/persona/reset", ...voiceGuardSettings, (req, res) => {
  db.setVoicePersona(req.me.id, "");
  db.logLogin(req.ip, req.me.username, "voice", "reset the voice persona (back to learning from speech; register and self-gender forgotten)");
  voiceReply(req, res, { msg: "Voice persona reset. It is learned again from how you speak.", anchor: "v-persona", reload: true });
});

/** Speaker handling and noise reduction (each row posts its own field; the other is kept). */
app.post("/mint-ai/settings/voice/live-audio", ...voiceGuardSettings, (req, res) => {
  const was = liveAudio();
  const duplex = req.body && req.body.duplex !== undefined ? field(req.body, "duplex") : was.duplex;
  const noise = req.body && req.body.noise !== undefined ? field(req.body, "noise") : was.noise;
  if (!voiceLive.DUPLEX.includes(duplex) || !voiceLive.NOISE_REDUCTION.includes(noise)) {
    return voiceReply(req, res, { err: "Choose speakers or headphones, and a noise reduction.", anchor: "v-live-audio" });
  }
  db.setSetting(VOICE_LIVE_AUDIO_SETTING, JSON.stringify({ duplex, noise }), req.me.username);
  db.logLogin(req.ip, req.me.username, "voice", `live conversation audio: ${duplex === "speakers" ? "speakers mode" : "headphones mode"}, noise reduction ${noise} (was ${was.duplex}, ${was.noise})`);
  voiceReply(req, res, { msg: "Live conversation audio saved. It applies to the next call; each browser can still switch from the live bar.", anchor: "v-live-audio" });
});

/**
 * Transcription: which model writes down the full turn, and the language hint
 * (each row posts its own field; the other is kept). A local model is started
 * through the helper first -- refused, and nothing saved, when it is not
 * installed; going back to an OpenAI model stops the local server. The live
 * session's own transcription model (always OpenAI's) is written to the
 * helper's file, and open calls reconnect with it.
 */
app.post("/mint-ai/settings/voice/transcription", ...voiceGuardSettings, async (req, res) => {
  const was = transcription();
  const has = (k) => typeof (req.body && req.body[k]) === "string" && req.body[k] !== "";
  const want = voiceTranscribe.clean({ model: has("transcriber") ? field(req.body, "transcriber") : was.model, language: has("language") ? field(req.body, "language") : was.language });
  if ((has("transcriber") && want.model !== field(req.body, "transcriber")) || (has("language") && want.language !== field(req.body, "language"))) {
    return voiceReply(req, res, { err: "Pick a transcription model and a language from the lists.", anchor: "v-transcribe" });
  }
  const t = voiceTranscribe.byId(want.model);
  const before = voiceTranscribe.byId(was.model);
  let note = "";
  try {
    if (t.kind !== "openai") {
      const st = await priv.voiceWhisperSet(t.model);
      note = st && st.active === "active" ? " Its server is running on this machine." : " Its server is starting.";
    } else if (before && before.kind !== "openai") {
      await priv.voiceWhisperSet("off").catch((e) => {
        note = " The local server could not be stopped: " + priv.redact(String(e.message || e));
      });
    }
  } catch (e) {
    return voiceReply(req, res, { err: `${t.label} cannot be used: ${priv.redact(String(e.message || e))}`, anchor: "v-transcribe" });
  }
  db.setSetting(VOICE_TRANSCRIPTION_SETTING, JSON.stringify(want), req.me.username);
  const listen = voiceTranscribe.sessionModelFor(want.model);
  try {
    // The helper's file, not the cached config (which already reads the new setting).
    const d = await priv.voiceKeyRead();
    if (d && d.key && d.transcribe_model !== listen) await priv.voiceOptionsSet(voice.readerModelFor(voiceModel()), voice.VOICES.includes(d.voice) ? d.voice : voice.DEFAULTS.voice, listen);
  } catch (e) {
    console.log("voice: could not store the live session's transcription model: " + priv.redact(String(e.message || e)));
  }
  voiceForget("reconnect");
  voiceReconnect(null).catch(() => {});
  db.logLogin(req.ip, req.me.username, "voice", `transcription ${want.model} (${t.kind === "openai" ? "OpenAI" : "on this server"}), language ${want.language}; the call's own transcription ${listen} (was ${was.model}, ${was.language})`);
  const lang = (voiceTranscribe.LANGUAGES.find(([v]) => v === want.language) || [])[1] || want.language;
  const msg = has("transcriber") && !has("language") ? `Transcription: ${t.label}.${note}` : has("language") && !has("transcriber") ? `Transcription language: ${lang}.` : `Transcription saved.${note}`;
  voiceReply(req, res, { msg, anchor: "v-transcribe" });
});

/**
 * Test: one short line spoken by the voice model -- the reader MINT AI's
 * replies are read with -- and transcribed back by its paired listening model.
 * A real call; a passing Test shows the model reads aloud word for word.
 */
app.post("/mint-ai/settings/voice/test", ...voiceGuardSettings, async (req, res) => {
  voiceForget("keep"); // test what is on disk now, not a cached copy; open calls are not touched
  let ok = false;
  let text;
  try {
    const cfg = await voiceConfig();
    const out = await voice.check({ ...cfg, model: cfg.live_model }, { transcribe: voiceTranscribe.transcribeFull });
    ok = out.faithful && !!out.heard;
    const fb = out.heard_fallback;
    text =
      `${out.model} (${out.voice}) spoke ${out.seconds != null ? out.seconds + " s of audio " : ""}in ${out.speak_ms} ms` +
      (out.faithful ? ", word for word" : `, but not as written — it said “${out.speak_transcript}”`) +
      (out.heard != null
        ? `; transcription by ${out.heard_by}${fb ? ` (${fb.from} failed: ${fb.why}, so it fell back)` : ""} heard “${out.heard}” in ${out.transcribe_ms} ms.`
        : ".");
  } catch (e) {
    text = e.message;
  }
  text = priv.redact(voice.scrub(text));
  db.logLogin(req.ip, req.me.username, "voice", "tested the OpenAI voice key: " + (ok ? "ok" : "failed"));
  if (settingsRoutes.wantsJson(req)) return voiceReply(req, res, ok ? { msg: "Test passed. " + text } : { err: "Test failed. " + text });
  res.redirect(303, "/mint-ai/settings/voice?test=" + (ok ? "ok" : "fail") + "&t=" + encodeURIComponent(text) + "#v-main");
});

/* ---------------------------------------------------------- credentials --- */

app.get("/credentials", requireAuth, requirePerm("credentials.view"), async (req, res) => {
  const data = await gather({
    credentials: () => priv.credentialList(),
    probe: () => priv.systemProbe(),
  });
  const voiceState = req.perm.can("voice.manage") ? { ...(await voiceSettings()), on: voiceEnabled() } : null;
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

/*
 * Classic chat is hidden (the 2026-09-30 reorganisation): every /console URL
 * goes to the Command Center. Its data (console_sessions, console_messages) is
 * kept, and so are the handlers below, unreachable, for one release -- per-chat
 * root mode and file upload have no other home yet.
 */
app.all(/^\/console(?:\/|$)/, (req, res) => res.redirect(302, "/mint-ai"));

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
      sessview: req.me.sessions_view,
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
/**
 * The sessions view round the core, per person: "spheres" (the family of
 * spheres, the default) or "orbit" (the classic dots). Stored and audited like
 * the core (users.sessions_view; "account": "Sessions view ..."), written into
 * the Command Center as data-sessview.
 */
function setSessionsView(req, view) {
  const was = mintLogic.normSessView(req.me.sessions_view);
  db.setUserSessionsView(req.me.id, view);
  db.logLogin(req.ip, req.me.username, "account", `Sessions view ${was} -> ${view} (${mintLogic.SESS_VIEWS[view]})${was === view ? " (unchanged)" : ""}`);
}
app.post("/mint-ai/api/prefs/sessions", ...moniAiWrite, (req, res) => {
  const view = req.body && req.body.view;
  if (!mintLogic.isSessView(view)) return res.status(400).json({ error: "The sessions view must be spheres or orbit.", code: "invalid" });
  setSessionsView(req, view);
  res.json({ view, name: mintLogic.SESS_VIEWS[view] });
});

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

/**
 * Hired sessions (M-6): the administrator keeps / unkeeps one, or retires it
 * (the Command Center's Keep / Retire dialog is the consent). The supervisor
 * refuses both for sessions not hired through MINT AI, and retire for a kept one.
 */
const cleanSlug = (v) => (/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(v || "")) ? String(v) : null);
app.post("/mint-ai/api/sessions/:slug/keep", ...moniAiWrite, async (req, res) => {
  const slug = cleanSlug(req.params.slug);
  const kept = req.body && req.body.kept;
  if (!slug) return res.status(404).json({ error: "No such session." });
  if (typeof kept !== "boolean") return res.status(400).json({ error: "kept must be true or false." });
  try {
    const out = await moniai.call("session-keep", { slug, kept }, req.me.username);
    db.logLogin(req.ip, req.me.username, "moni-ai", `${kept ? "kept" : "unkept"} hired session ${slug}`);
    res.json(out);
  } catch (e) {
    moniAiFail(res, e);
  }
});
app.post("/mint-ai/api/sessions/:slug/retire", ...moniAiWrite, async (req, res) => {
  const slug = cleanSlug(req.params.slug);
  if (!slug) return res.status(404).json({ error: "No such session." });
  try {
    const params = { slug };
    const note = moniai.cleanNote(req.body && req.body.note);
    if (note) params.note = note;
    const out = await moniai.call("session-retire", params, req.me.username, { timeout: 60000 });
    db.logLogin(req.ip, req.me.username, "moni-ai", `retired hired session ${slug}`);
    res.json(out);
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
  const stream = { actor: req.me.username, tab, res };
  uiStreams.add(stream);
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
    uiStreams.delete(stream);
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
  if (uiVoiceOff(v.action)) return void ack(false, "voice is off");
  // Settings > Screen control > Allow screen actions (per person): off keeps MINT AI to words.
  if (v.tier === 1 && !settingsRoutes.uiActionsEnabled(db, req.me.id)) return void ack(false, "screen actions are off (the administrator switched them off in Settings > Screen control)");
  if (v.tier === 2) {
    const o = uiConfirmOpen({ username: actor, ip: req.ip, canVoice: req.perm.can("voice.manage") }, v, tab, `MINT AI (turn ${ev.turn_id})`);
    if (o.error) return void ack(false, o.error);
    res.write(`event: ui\ndata: ${JSON.stringify({ type: "ui", nonce: ev.nonce, action: v.action, args: v.args, toast: o.question, confirm: o.id, deep: true })}\n\n`);
    return void moniai.call("ui-ack", { nonce: ev.nonce, ok: true, pending: true }, actor).catch(() => {});
  }
  db.logLogin(req.ip, actor, "mint-ui", `${what} by MINT AI (turn ${ev.turn_id}), to the tab that asked`);
  if (v.where === "server") {
    const call = voiceLive.callFor(actor);
    if (!call) return void ack(false, "no voice call is open");
    const out = call.deepUi(v);
    return void ack(out.ok, out.why);
  }
  res.write(`event: ui\ndata: ${JSON.stringify({ type: "ui", nonce: ev.nonce, action: v.action, args: v.args, toast: UiActions.toast(v.action, v.args), deep: true })}\n\n`);
}

/**
 * The page's decision on a Tier-2 confirm: {id, decision: "confirm"|"cancel"}.
 * Hands the pending action over once (a click, or after a heard yes); the page
 * then applies it through the existing CSRF'd route, under this session's
 * permissions. For voice.set it also gets the current model and listening
 * model, so the existing form route keeps them.
 */
app.post("/mint-ai/api/ui/confirm", ...moniAiWrite, async (req, res) => {
  const b = req.body || {};
  if (typeof b.id !== "string" || !/^[0-9a-f]{18}$/.test(b.id) || (b.decision !== "confirm" && b.decision !== "cancel")) return res.status(400).json({ error: "Bad confirm." });
  const t = uiConfirms.take(req.me.username, b.id, b.decision);
  if (!t) return res.status(404).json({ error: "That confirm has expired.", code: "expired" });
  const what = `${t.action} ${JSON.stringify(t.args)}`;
  if (t.cancelled) {
    db.logLogin(req.ip, req.me.username, "mint-ui", `${what} cancelled`);
    return res.json({ ok: true, cancelled: true });
  }
  if ((t.action === "persona.set" || t.action === "voice.set") && !req.perm.can("voice.manage")) return res.status(403).json({ error: "This account cannot change voice settings." });
  if (uiVoiceOff(t.action)) return res.status(409).json({ error: "Voice is off.", code: "voice-off" });
  let form = null;
  if (t.action === "persona.set") form = { preset: t.args.preset };
  if (t.action === "voice.set") {
    // Only the voice: the voice model and the listening model are kept (Settings ▸ Voice options).
    form = { voice: t.args.voice };
    // Its options post reconnects the open live calls; this user's call says a line in the new voice.
    voiceGreet.set(req.me.username, Date.now() + 20000);
  }
  db.logLogin(req.ip, req.me.username, "mint-ui", `${what} confirmed (${t.spoken ? "spoken yes" : "click"}); the page applies it`);
  res.json({ ok: true, action: t.action, args: t.args, form, done: UiActions.doneText(t.action, t.args) });
});

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

/**
 * The page's end reason when a socket message cannot carry it: leaving the
 * page (navigator.sendBeacon on pagehide / unload, public/voice-live.js). The
 * body is {_csrf, call, why}. Ends that call if it is still open (the socket's
 * close may not have arrived yet) and logs the reason either way.
 */
app.post("/mint-ai/api/live/end", ...moniAiWrite, (req, res) => {
  const b = req.body || {};
  const why = typeof b.why === "string" && /^(?:unload|navigate|button|error:[^\u0000-\u001f]{0,80})$/.test(b.why) ? b.why : "unspecified";
  const id = typeof b.call === "string" && /^lv[a-z0-9]{1,40}$/.test(b.call) ? b.call : null;
  const call = voiceLive.callFor(req.me.username);
  if (call && id && call.id === id) call.close("hung-up", undefined, why);
  else console.log(`live: call ${id || "?"} end reason from the page (beacon): ${why}${call ? "" : " (already ended)"}`);
  res.status(204).end();
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
    // A pending Tier-2 confirm: this "yes" / "no" answers it and goes no further.
    const conf = uiConfirmHeard({ username: req.me.username, ip: req.ip }, params.text, "typed or direct voice");
    if (conf && (conf.confirmed || conf.cancelled)) return res.json({ confirm: { id: (conf.confirmed || conf.cancelled).id, ok: !!conf.confirmed } });
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
 * Read-aloud for the Command Center ("Read replies aloud" and a reply's Read
 * aloud), through OpenAI and only through this server: a reply is read a
 * sentence at a time, its audio streamed back. The browser never talks to
 * OpenAI. Nothing is saved. Refused (409 voice-off) while voice is off, and
 * only for those who may use the voice (voice.use).
 *
 * The Command Center's push to talk (/mint-ai/api/transcribe) and the voice
 * front desk (/mint-ai/api/desk/turn, /desk/summary) were removed on
 * 2026-09-30: voice is live conversation only, and the live call hears on the
 * server (lib/voice-live.js).
 */
app.post("/mint-ai/api/speak", ...moniAiWrite, requireApiPerm("voice.use"), voiceSpeakRoute);

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
  if (!["approve", "dismiss", "ask", "resume"].includes(action)) return res.status(404).json({ error: "No such action." });
  // Resume is a daily-token-cap card's (Settings > Usage & budget): the supervisor's budget-resume.
  if (action === "resume") {
    const id = moniAiClean(res, () => moniai.idOf(req.params.id, "decision"));
    if (id !== undefined) moniAiOp(req, res, "budget-resume", { decision_id: id }, { log: `resumed past the daily cap (decision ${id})` });
    return;
  }
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

// usage: Claude plan limits as Claude Code's /usage shows them (the supervisor
// asks the CLI; no credential passes through here) and the token counts.
app.get("/mint-ai/api/usage", ...moniAiGuard, (req, res) => moniAiOp(req, res, "usage", req.query.plan_only === "1" ? { plan_only: true } : {}, { timeout: 35000 }));

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
      meId: req.me.id,
      canManage: req.perm.can("users.manage"),
      sessionsOf: (id) => { try { return deviceSessions.sessionsFor(id).count; } catch (_) { return null; } },
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
      passkeyCount: passkeys.countFor(c.target.id),
      roles: db.listRoles(),
      flash: req.query.msg || null,
      err: req.query.err || null,
    })
  );
});

app.post("/users/:id", requireAuth, requirePerm("users.manage"), requireCsrf, (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  // Users > Manage (the dialog on /users) comes back to the list; the full page to itself.
  const back = field(req.body, "back") === "/users" ? "/users" : "/users/" + c.target.id;

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
  // A reset is for a lost or compromised device, and a passkey is a device:
  // every one of theirs goes with the old authenticator.
  const cleared = passkeys.clearFor(c.target.id);
  db.logLogin(
    req.ip,
    req.me.username,
    "admin",
    "reset 2FA for " + c.target.username + (cleared ? ` and removed ${cleared} passkey${cleared === 1 ? "" : "s"}` : "")
  );
  const qr = await enrolQr(c.target, secret);
  res.send(
    accessViews.userEnrol({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      target: c.target,
      qr,
      secret,
      password: "(unchanged — reset it separately if they also lost that)",
      reset: { passkeys: cleared },
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

/**
 * Sign every browser of another user out (Users ▸ Manage). Their live voice
 * calls end with the sessions. Your own go through Devices, which keeps the
 * one you are using -- so your own id is refused here. `back=detail` returns
 * to the full-page /users/:id; anything else to /users.
 */
app.post("/users/:id/signout-all", requireAuth, requirePerm("users.manage"), requireCsrf, async (req, res) => {
  const c = userContext(req);
  if (!c) return res.status(404).send(views.error("Not found", "No such user."));
  const back = field(req.body, "back") === "detail" ? "/users/" + c.target.id : "/users";
  if (c.isSelf)
    return res.redirect(back + "?err=" + encodeURIComponent("Use Devices to sign out your own browsers; it keeps the one you are using."));
  const sids = deviceSessions.sidsFor(c.target.id, null);
  const n = await deviceSessions.destroyMany(sids);
  endCallsFor(sids, "signed out by an administrator");
  deviceSessions.forget(c.target.id);
  db.logLogin(req.ip, req.me.username, "admin", `signed out ${n} browser${n === 1 ? "" : "s"} of ${c.target.username}`);
  res.redirect(back + "?msg=" + encodeURIComponent(n ? `Signed ${c.target.username} out of ${n} browser${n === 1 ? "" : "s"}.` : `${c.target.username} was not signed in anywhere.`));
});

/* ---------------------------------------------------------------- roles --- */

app.get("/roles", requireAuth, requirePerm("roles.view"), async (req, res) => {
  const canManage = req.perm.can("roles.manage");
  // The Manage dialogs carry the scope pickers, so they need the agent and channel lists.
  const opts = canManage ? await scopeOptions() : { agents: [], channels: [] };
  res.send(
    accessViews.roles({
      csrf: res.locals.csrf,
      user: ctx(req, "os"),
      roles: db.listRoles(),
      flash: req.query.msg || null,
      err: req.query.err || null,
      canManage,
      ...opts,
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
  // Roles > Manage (the dialog on /roles) comes back to the list.
  const back = field(req.body, "back") === "/roles" ? "/roles" : "/roles/" + role.id;
  res.redirect(back + "?msg=" + encodeURIComponent(role.label + " saved."));
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
      // A pointer to Settings > Appearance, for those who can open the Command Center.
      appearance: req.perm.can("moniai.use"),
      passkeys: accountPasskeys(req),
    })
  );
});

/* --- passkeys (Windows Hello) on your own account ------------------------ */

/**
 * Adding a passkey adds a way past the second step, so it asks for the second
 * factor again: a current authenticator code, unless both factors were shown
 * within the last few minutes (a fresh sign-in, or a code given here).
 */
const PASSKEY_REAUTH_MS = Number(process.env.MONI_PASSKEY_REAUTH_MS) > 0 ? Number(process.env.MONI_PASSKEY_REAUTH_MS) : 5 * 60 * 1000;
const freshAuth = (req) => Date.now() - Number(req.session.authAt || 0) < PASSKEY_REAUTH_MS;

/** What the account page shows: this address, its passkeys and the rest. */
function accountPasskeys(req) {
  const rp = passkeys.rpFor(req);
  const all = passkeys.listFor(req.me.id);
  return {
    host: passkeys.hostOf(req),
    rpID: rp ? rp.rpID : null,
    primary: passkeys.primaryOrigin(),
    list: all,
    here: rp ? all.filter((p) => p.rp_id === rp.rpID).length : 0,
    fresh: freshAuth(req),
    suggestedName: ((l) => (l === "Unknown browser" ? "" : l))(deviceSessions.parseUA(req.get("user-agent")).label),
  };
}

app.post("/account/passkeys/options", requireAuth, passkeyLimiter, requireCsrf, async (req, res) => {
  const rp = passkeys.rpFor(req);
  if (!rp) return res.status(400).json({ error: "Passkeys cannot be added at this address. Open " + (passkeys.primaryOrigin() || "the panel's main address") + " and add it there." });
  if (!freshAuth(req)) {
    if (!totp.verifyAndConsume(req.me, req.body && req.body.code)) {
      logAuthFailure(req.ip, "bad code adding a passkey");
      db.logLogin(req.ip, req.me.username, "fail", "bad code adding a passkey");
      return res.status(403).json({ error: "That code was not accepted. Try the next one.", code: true });
    }
    req.session.authAt = Date.now();
  }
  req.session.passkeyReg = {};
  res.json({ options: await passkeys.registrationOptions(req.me, rp, req.session.passkeyReg) });
});

app.post("/account/passkeys", requireAuth, passkeyLimiter, requireCsrf, async (req, res) => {
  const rp = passkeys.rpFor(req);
  const slot = req.session.passkeyReg || {};
  delete req.session.passkeyReg;
  if (!rp) return res.status(400).json({ error: "Passkeys cannot be added at this address." });
  const name = passkeys.cleanName(req.body && req.body.name, deviceSessions.parseUA(req.get("user-agent")).label);
  const r = await passkeys.verifyRegistration(req.me, rp, slot, req.body && req.body.response, name);
  if (!r.ok) {
    db.logLogin(req.ip, req.me.username, "fail", "passkey not added: " + r.error);
    return res.status(400).json({ error: "The passkey was not added (" + r.error + ")." });
  }
  db.logLogin(req.ip, req.me.username, "account", `added passkey "${r.passkey.name}" for ${rp.rpID}`);
  res.json({ ok: true, msg: `Passkey "${r.passkey.name}" added. Next time, sign in with Windows Hello on this device.` });
});

app.post("/account/passkeys/:id/rename", requireAuth, requireCsrf, (req, res) => {
  const was = passkeys.listFor(req.me.id).find((p) => p.id === Number(req.params.id));
  const pk = passkeys.rename(req.me.id, req.params.id, req.body.name);
  if (!pk) return res.redirect("/account?err=" + encodeURIComponent("No such passkey.") + "#passkeys");
  db.logLogin(req.ip, req.me.username, "account", `renamed passkey "${was.name}" to "${pk.name}"`);
  res.redirect("/account?msg=" + encodeURIComponent(`Renamed to "${pk.name}".`) + "#passkeys");
});

app.post("/account/passkeys/:id/delete", requireAuth, requireCsrf, (req, res) => {
  const pk = passkeys.remove(req.me.id, req.params.id);
  if (!pk) return res.redirect("/account?err=" + encodeURIComponent("No such passkey.") + "#passkeys");
  db.logLogin(req.ip, req.me.username, "account", `removed passkey "${pk.name}" (${pk.rp_id})`);
  res.redirect(
    "/account?msg=" +
      encodeURIComponent(`Passkey "${pk.name}" removed. Remove it from Windows too (Settings ▸ Accounts ▸ Passkeys) so it stops being offered.`) +
      "#passkeys"
  );
});

/* Account > Appearance without JavaScript: a plain form post (see setMintCore). */
app.post("/account/appearance", requireAuth, requirePerm("moniai.use"), requireCsrf, (req, res) => {
  const core = String((req.body && req.body.core) || "");
  const view = req.body && req.body.sessions_view !== undefined ? String(req.body.sessions_view) : null;
  // The no-JavaScript path of Settings > Appearance: back there with a note.
  const back = "/mint-ai/settings/appearance";
  if (!mintLogic.isCore(core)) return res.redirect(back + "?err=" + encodeURIComponent("Choose core A, B or C.") + "#a-core");
  if (view !== null && !mintLogic.isSessView(view)) return res.redirect(back + "?err=" + encodeURIComponent("Choose Spheres or Classic orbit.") + "#a-sessions");
  setMintCore(req, core);
  if (view !== null) setSessionsView(req, view);
  res.redirect(back + "?msg=" + encodeURIComponent(`MINT AI core: ${core} · ${mintLogic.CORES[core]}${view ? ` · Sessions view: ${mintLogic.SESS_VIEWS[view]}` : ""}.`) + "#a-core");
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
    mm: () => priv.ccMmSessions(),
  });
  const asked = String(req.query.view || "");
  const mmQuery = {
    q: String(req.query.sq || "").slice(0, 120).trim(),
    sort: String(req.query.sort || ""),
    dir: String(req.query.dir || ""),
  };
  const filtered = query || filters.topic || filters.project || filters.q || filters.superseded || filters.page > 1;
  res.send(
    claudeViews.memory({
      csrf: res.locals.csrf,
      user: ctx(req),
      view: claudeViews.MEMORY_VIEWS.some((v) => v[0] === asked) ? asked : filtered ? "list" : "graph",
      mmQuery,
      mmErr: data.errors && data.errors.mm,
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

/* ------------------------------------------------- memory by session --- */

/**
 * Memory > Sessions: one session's facts and chunks (claude.memory.read), and
 * hide / unhide / delete over them (claude.memory.manage, administrators only by
 * default). Every write goes through the helper, which keeps it inside the one
 * session, refuses whole-session changes to a live session, re-checks the
 * confirmed counts and audits counts only. A delete never happens on the first
 * POST: that renders the confirm page with the counts (or, for a whole session,
 * the name to type back), and only its own POST deletes.
 */
const MM_STATUS = ["", "active", "hidden", "superseded"];
const MM_SHOW = ["", "facts", "chunks"];
const MM_OPS = {
  "hide-items": ["hide", "items"],
  "unhide-items": ["unhide", "items"],
  "delete-items": ["delete", "items"],
  "hide-filtered": ["hide", "filtered"],
  "unhide-filtered": ["unhide", "filtered"],
  "delete-filtered": ["delete", "filtered"],
  "hide-session": ["hide", "session"],
  "unhide-session": ["unhide", "session"],
};

function mmFilters(src, prefix) {
  const g = (k) => String((src && src[(prefix || "") + k]) || "");
  const status = g("status");
  const show = g("show");
  const topic = g("topic").slice(0, 121).trim();
  return {
    q: g("q").slice(0, 200).trim(),
    topic: /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,120}$/.test(topic) ? topic : "",
    status: MM_STATUS.includes(status) ? status : "",
    show: MM_SHOW.includes(show) ? show : "",
  };
}

const mmIds = (v) =>
  []
    .concat(v == null ? [] : v)
    .map(String)
    .filter((x) => /^\d{1,15}$/.test(x))
    .map(Number)
    .slice(0, 20000);

function mmPath(uuid, filters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters || {})) if (v) p.set(k, v);
  const q = p.toString();
  return "/claude/memory/session/" + uuid + (q ? "?" + q : "");
}

function mmMessage(out) {
  const n = (x, one) => `${x || 0} ${one}${x === 1 ? "" : "s"}`;
  if (out.action === "hide")
    return `Hidden: ${n(out.facts, "fact")} and ${n(out.chunks, "chunk")}. They stay in the database and can be unhidden.`;
  if (out.action === "unhide") return `Unhidden: ${n(out.facts, "fact")} and ${n(out.chunks, "chunk")}. They are recalled again.`;
  let m = `Deleted permanently: ${n(out.facts, "fact")} and ${n(out.chunks, "chunk")}.`;
  if (out.hidden_older) m += ` ${n(out.hidden_older, "older version")} of deleted facts hidden.`;
  if (out.repointed) m += ` ${n(out.repointed, "older version")} now point at the surviving newer fact.`;
  return m;
}

app.get("/claude/memory/session/:uuid", requireAuth, requirePerm("claude.memory.read"), async (req, res) => {
  const uuid = req.params.uuid;
  if (!CC_UUID.test(uuid)) return res.status(404).send(views.error("Not found", "No such session."));
  let data = null;
  let err = null;
  try {
    data = await priv.ccMmSession(Object.assign({ session: uuid, page: qint(req.query.page, 1) }, mmFilters(req.query)));
  } catch (e) {
    err = e.message;
  }
  res.send(
    claudeViews.sessionMemory({
      csrf: res.locals.csrf,
      user: ctx(req),
      data,
      uuid,
      err: err || req.query.err || null,
      flash: req.query.msg || null,
    })
  );
});

app.post("/claude/memory/session/:uuid/apply", requireAuth, requirePerm("claude.memory.manage"), requireCsrf, async (req, res) => {
  const uuid = req.params.uuid;
  if (!CC_UUID.test(uuid)) return res.status(404).send(views.error("Not found", "No such session."));
  const filters = mmFilters(req.body, "f_");
  const back = mmPath(uuid, filters);
  const op = MM_OPS[String(req.body.op || "")];
  if (!op) return res.redirect(withMsg(back, "err", "Choose what to do with the selection."));
  const [action, scope] = op;
  const request = Object.assign({ session: uuid, action, scope }, scope === "filtered" ? filters : {});
  if (scope === "items") {
    request.facts = mmIds(req.body.f);
    request.chunks = mmIds(req.body.c);
    if (!request.facts.length && !request.chunks.length) return res.redirect(withMsg(back, "err", "Nothing is selected."));
  }
  try {
    if (action === "delete" && req.body.confirmed !== "1") {
      const preview = await priv.ccMmPreview(request);
      return res.send(claudeViews.mmConfirmDelete({ csrf: res.locals.csrf, user: ctx(req), uuid, preview, body: req.body }));
    }
    if (action === "delete") {
      const count = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : -1);
      request.expect = { facts: count(req.body.expect_facts), chunks: count(req.body.expect_chunks) };
    }
    const out = await priv.ccMmApply(Object.assign(request, { actor: ccActor(req) }));
    res.redirect(withMsg(back, "msg", mmMessage(out)));
  } catch (e) {
    res.redirect(withMsg(back, "err", e.message));
  }
});

app.post("/claude/memory/session/:uuid/delete", requireAuth, requirePerm("claude.memory.manage"), requireCsrf, async (req, res) => {
  const uuid = req.params.uuid;
  if (!CC_UUID.test(uuid)) return res.status(404).send(views.error("Not found", "No such session."));
  const back = mmPath(uuid);
  const confirmPage = async (err) => {
    const preview = await priv.ccMmPreview({ session: uuid, action: "delete", scope: "session" });
    if (preview.session && preview.session.live) throw new Error("This session is live (" + preview.session.live_reason + "); it cannot be deleted.");
    return claudeViews.mmConfirmSession({ csrf: res.locals.csrf, user: ctx(req), uuid, preview, err });
  };
  try {
    if (req.body.step !== "confirm") return res.send(await confirmPage(null));
    const out = await priv.ccMmDeleteSession({
      session: uuid,
      actor: ccActor(req),
      confirm: String(req.body.confirm || "").slice(0, 200),
      delete_files: req.body.delete_files === "1",
    });
    let m = `Session deleted from memory: ${out.facts} facts and ${out.chunks} chunks. It will not be indexed again.`;
    if (out.files_removed) m += ` ${out.files_removed} transcript file(s) deleted.`;
    if (out.files_kept_readonly) m += ` ${out.files_kept_readonly} read-only archive cop${out.files_kept_readonly === 1 ? "y" : "ies"} kept.`;
    if (out.files_error) m += " Transcript files: " + out.files_error;
    res.redirect(withMsg("/claude/memory?view=sessions", "msg", m));
  } catch (e) {
    if (req.body.step === "confirm" && /type the session's name/.test(e.message)) {
      try {
        return res.send(await confirmPage(e.message));
      } catch (_) {
        /* fall through to the redirect */
      }
    }
    res.redirect(withMsg(back, "err", e.message));
  }
});

app.post("/claude/memory/session/:uuid/reindex", requireAuth, requirePerm("claude.memory.manage"), requireCsrf, async (req, res) => {
  const uuid = req.params.uuid;
  if (!CC_UUID.test(uuid)) return res.status(404).send(views.error("Not found", "No such session."));
  try {
    const out = await priv.ccMmReindex({ session: uuid, actor: ccActor(req) });
    res.redirect(
      withMsg(mmPath(uuid), "msg", out.lifted ? "It may be indexed again: the next re-scan picks up any transcript left on disk." : "It was not excluded.")
    );
  } catch (e) {
    res.redirect(withMsg(mmPath(uuid), "err", e.message));
  }
});

/**
 * Agents & sessions ▸ Sessions: tabs Live (what was Claude Code ▸ Running, with
 * MINT AI's view of each session on top), All and Archived (the transcripts).
 * ?archived=1 is the old spelling of the Archived tab.
 */
app.get("/claude/sessions", requireAuth, async (req, res) => {
  const canLive = req.perm.can("claude.running.view");
  const canAll = req.perm.can("claude.sessions.view");
  if (!canLive && !canAll) return res.status(403).send(views.error("Not allowed", "Your role does not include Claude Code sessions."));
  let tab = ["live", "all", "archived"].includes(req.query.tab) ? req.query.tab : req.query.archived === "1" ? "archived" : canLive ? "live" : "all";
  if (tab === "live" && !canLive) tab = "all";
  if (tab !== "live" && !canAll) tab = "live";
  const flash = req.query.msg || null;
  let err = req.query.err || null;

  if (tab === "live") {
    let r = null;
    try {
      r = await priv.ccRunning();
    } catch (e) {
      err = e.message;
    }
    const team = req.perm.can("moniai.use") ? await sessionsTeam(req) : null;
    const live = team && !team.error ? team.sessions.filter((x) => !x.self).length : r ? (r.sessions || []).filter((x) => x.alive).length : null;
    return res.send(claudeViews.live({ csrf: res.locals.csrf, user: ctx(req), r, team, flash, err, counts: { live } }));
  }

  const filters = {
    home: CC_HOMES.has(String(req.query.home || "")) ? String(req.query.home) : "",
    project: CC_SLUG.test(String(req.query.project || "")) ? String(req.query.project) : "",
    q: String(req.query.q || "").slice(0, 200).trim(),
    archived: tab === "archived",
    page: qint(req.query.page, 1),
    per_page: 25,
  };
  let data = null;
  try {
    data = await priv.ccSessionsList(filters);
  } catch (e) {
    err = e.message;
  }
  res.send(claudeViews.sessions({ csrf: res.locals.csrf, user: ctx(req), data, filters, flash, err }));
});

/**
 * MINT AI's view of the live sessions for Sessions ▸ Live and the Overview:
 * the supervisor's sessions (hired, kept, yours, itself) and each one's token
 * cap row, by cap key. { sessions, caps, error } -- never throws.
 */
async function sessionsTeam(req) {
  try {
    const [s, c] = await Promise.all([
      moniai.call("sessions", {}, req.me.username),
      moniai.call("token-caps", {}, req.me.username).catch(() => null),
    ]);
    const caps = {};
    for (const row of (c && c.sessions) || []) caps[row.key] = row;
    return { sessions: (s && s.sessions) || [], caps, error: null, max_live: null };
  } catch (e) {
    return { sessions: [], caps: {}, error: "MINT AI is not reachable: " + e.message };
  }
}

/* Sessions ▸ Live, the forms behind Keep / Stop keeping / Retire… / Resume (the
   Command Center does the same through /mint-ai/api/sessions/...). */
const liveBack = (res, kind, text) => res.redirect(303, "/claude/sessions?tab=live&" + kind + "=" + encodeURIComponent(text) + "#s-live");
app.post("/claude/sessions/live/:slug/keep", requireAuth, requirePerm("moniai.use"), requireCsrf, async (req, res) => {
  const slug = /^[a-z0-9][a-z0-9-]{0,39}$/.test(req.params.slug) ? req.params.slug : null;
  if (!slug) return liveBack(res, "err", "No such session.");
  const kept = field(req.body, "kept") === "1";
  try {
    await moniai.call("session-keep", { slug, kept }, req.me.username);
    db.logLogin(req.ip, req.me.username, "moni-ai", `${kept ? "kept" : "unkept"} hired session ${slug}`);
    liveBack(res, "msg", kept ? "Kept: MINT AI can never retire it." : "No longer kept.");
  } catch (e) {
    liveBack(res, "err", e.message);
  }
});
app.post("/claude/sessions/live/:slug/retire", requireAuth, requirePerm("moniai.use"), requireCsrf, async (req, res) => {
  const slug = /^[a-z0-9][a-z0-9-]{0,39}$/.test(req.params.slug) ? req.params.slug : null;
  if (!slug) return liveBack(res, "err", "No such session.");
  try {
    await moniai.call("session-retire", { slug }, req.me.username, { timeout: 60000 });
    db.logLogin(req.ip, req.me.username, "moni-ai", `retired hired session ${slug}`);
    liveBack(res, "msg", "Retired. Its transcript is kept.");
  } catch (e) {
    liveBack(res, "err", e.message);
  }
});
app.post("/claude/sessions/live/resume", requireAuth, requirePerm("moniai.use"), requireCsrf, async (req, res) => {
  if (!req.perm.admin) return liveBack(res, "err", "Resuming past a cap is the administrator's.");
  const key = String(field(req.body, "key") || "");
  if (!/^[A-Za-z0-9<>._:-]{1,80}$/.test(key)) return liveBack(res, "err", "No such session.");
  try {
    await moniai.call("budget-resume", { key }, req.me.username);
    db.logLogin(req.ip, req.me.username, "moni-ai", `resumed ${key} past its daily cap`);
    liveBack(res, "msg", "Resumed for the rest of today.");
  } catch (e) {
    liveBack(res, "err", e.message);
  }
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

// What was Claude Code ▸ Running is Sessions ▸ Live.
app.get("/claude/running", requireAuth, (req, res) => {
  const q = new URLSearchParams({ tab: "live" });
  if (req.query.msg) q.set("msg", String(req.query.msg));
  if (req.query.err) q.set("err", String(req.query.err));
  res.redirect(302, "/claude/sessions?" + q.toString());
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
  if (!Number.isInteger(pid) || pid <= 1) return res.redirect(withMsg("/claude/sessions?tab=live", "err", "Bad pid."));
  const force = field(req.body, "force") === "1";
  try {
    const out = await priv.ccStop(pid, force, ccActor(req));
    res.redirect(
      withMsg(
        "/claude/sessions?tab=live",
        "msg",
        out.signal + " sent to pid " + pid + "." + (force ? "" : " If it is still running in 10 seconds, Force stop appears.")
      )
    );
  } catch (e) {
    res.redirect(withMsg("/claude/sessions?tab=live", "err", e.message));
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

/* ------------------------------------------------ MINT AI ▸ Settings ---- */
/*
 * /mint-ai/settings/<section> (lib/routes-settings.js, views lib/views-settings.js).
 * The Voice section's renderer and routes sit with the voice code below it.
 */
// The page map (Settings > Screen control): scanned now, and again on Rescan pages.
const pageMap = require("./lib/page-map");
pageMap.configure({ db, moniai });
try {
  pageMap.scan("panel start");
} catch (e) {
  console.error("page map: the scan failed, page.open keeps its built-in pages: " + e.message);
}
settingsRoutes.mount(app, { requireAuth, requireCsrf, ctx, db, moniai, pageMap });

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
 * Live conversation (lib/voice-live.js): the Command Center streams the
 * microphone here over a WebSocket, and this server relays it to OpenAI's
 * realtime model and plays back only what the guard has passed. The browser
 * never talks to OpenAI and never sees the key.
 *
 * GET /mint-ai/api/live?csrf=<token> (Upgrade: websocket). Refused, before
 * the upgrade, unless all of these hold:
 *   - the Origin is this host (a page elsewhere cannot open it with the cookie);
 *   - a signed-in session (the same cookie and store as every page), a user
 *     who is not disabled, with moniai.use AND voice.use (administrators by default);
 *   - the session's CSRF token in the query;
 *   - voice is on (Settings ▸ Voice; 403 while it is off) and an OpenAI key is set.
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
  return voiceAllowed(perm);
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
      if (!voiceEnabled()) return refuseUpgrade(socket, 403, "Voice is off");
      const cfg = await voiceConfig();
      if (!cfg.key) return refuseUpgrade(socket, 409, "No OpenAI key");
      if (voiceLive.activeCount() >= LIVE_MAX_CALLS && !voiceLive.callFor(me.username)) return refuseUpgrade(socket, 503, "Too many live calls");
      const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const ip = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || "") && fwd ? fwd : req.socket.remoteAddress;
      const audio = liveAudio();
      const duplex = voiceLive.DUPLEX.includes(q.get("duplex")) ? q.get("duplex") : audio.duplex;
      const route = q.get("route") === "loopback" ? "loopback" : q.get("route") === "direct" ? "direct" : "unknown";
      const tab = q.get("tab") || null;
      const sid = req.sessionID || null; // the device's session: signing it out ends this call (endLiveCallsForSession)
      // The page coming back after the dashboard restarted (it was told "restarting"): the voice says it is back.
      const resume = q.get("resume") === "restart" ? { lang: q.get("lang") === "ar" ? "ar" : "en" } : null;
      liveWss.handleUpgrade(req, socket, head, (ws) => liveConnected(ws, { me, cfg, ip, duplex, noise: audio.noise, route, tab, canVoice: perm.can("voice.manage"), sid, resume }));
    } catch (e) {
      console.log("live: upgrade failed: " + e.message);
      refuseUpgrade(socket, 500, "Server error");
    }
  });
}

function liveConnected(ws, { me, cfg, ip, duplex, noise, route, tab, canVoice, sid, resume }) {
  const actor = me.username;
  const json = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  if (voiceLive.callFor(actor)) {
    json({ type: "error", code: "busy", error: "You already have a live conversation open (another tab?). End it there first." });
    return ws.close(4409, "busy");
  }
  const call = new voiceLive.LiveCall({
    cfg: { ...liveCfgOf(cfg), noise_reduction: noise },
    actor,
    ops: voiceShared.voiceOps(moniCall, actor),
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
    transcribe: voiceTranscribe.transcribeFull, // the full-turn transcript: the selected model (a local one falls back to OpenAI)
    summarise: (id, o) => voiceShared.summariserFor(actor, cfg, moniCall, { log: (m) => console.log(m) }).summarise(id, o),
    record: (row) => recordVoice(() => voiceLedger.add(row).usd),
    isStop: (t) => voiceStop.heard(t),
    isUndo: (t) => voiceStop.undo(t),
    // A hand-off to MINT AI carries a ui token for the tab that holds the call (UI control Phase 2).
    uiTicket: () => uiRelay.mint({ actor, tab, via: "live", callId: call.id }),
    // Tier 2: asked for by the live voice, confirmed by a click or the next "yes" this server hears.
    openConfirm: (v) => uiConfirmOpen({ username: actor, ip, canVoice }, v, tab, "the live voice"),
    confirmHeard: (text) => uiConfirmHeard({ username: actor, ip }, text, "live call"),
    confirmPending: () => !!uiConfirms.pending(actor),
    // A whole yes / no (either language): checked against a pending confirm even just after the voice.
    isYesNo: (text) => voiceStop.yes(text) || voiceStop.no(text),
    // The confirm's 30 s start when the voice has finished asking.
    armConfirm: (id) => uiConfirms.arm(actor, id),
    log: (m) => console.log(m),
    opts: { duplex },
  });
  call.sid = sid || null;
  voiceLive.register(actor, call);
  db.logLogin(ip, actor, "voice", `live conversation started (${duplex === "full" ? "headphones" : "speakers"} mode, playback ${route}, noise reduction ${noise})`);
  console.log(`live: call ${call.id} started: ${duplex} mode, playback ${route}, noise reduction ${noise}${resume ? ", resumed after a restart" : ""}`);
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
  // The page's socket closed. A call it ended itself ({type: "end", why}) is already closed with its
  // reason; anything else (a tab killed, a network drop, a reload without the unload beacon) is
  // "page-closed", with the close code -- not "hung-up", which is only ever the page's own end.
  ws.on("close", (code, reason) => {
    clearInterval(ping);
    if (!call.closed) call.close("page-closed", undefined, "code " + code + (reason && reason.length ? " " + JSON.stringify(String(reason).slice(0, 60)) : ""));
    voiceLive.unregister(actor, call);
    const dg = call.diag;
    const end = call.endWhy || { why: "ended", detail: "" };
    db.logLogin(ip, actor, "voice", `live conversation ended (${end.why}${end.detail ? ": " + end.detail : ""}) after ${Math.round((Date.now() - call.bornAt) / 1000)} s, $${call.usd.toFixed(4)}; ${call.duplex} mode, barge-ins ${dg.bargeIns.length} of ${dg.candidates.length} candidates, phantom turns ${dg.leaks}, upstream reconnects ${dg.drops.length}`);
  });
  ws.on("error", () => {});
  call
    .connect()
    .then(() => {
      json({ type: "ready", call: call.id, model: call.model, voice: cfg.voice, max_s: Math.round(call.opts.maxMs / 1000), rate: voiceLive.RATE, duplex: call.duplex, noise, resumed: !!resume });
      if (resume) call.sayReconnected(resume.lang);
    })
    .catch((e) => {
      json({ type: "error", code: "upstream", error: voice.scrub(e.message) });
      call.close("upstream", voice.scrub(e.message), "could not connect");
    });
}

/**
 * End every live call bound to this browser session (its id, req.sessionID):
 * signing a device out ends that device's call -- the logout here, and the
 * Devices page's sign-out of another device. Returns how many were ended.
 */
function endLiveCallsForSession(sid, reason) {
  if (!sid) return 0;
  let n = 0;
  for (const call of voiceLive.all()) {
    if (call.sid !== sid) continue;
    try {
      call.close(reason || "signed-out");
      n++;
    } catch (e) {
      console.log("live: could not end a call on sign-out: " + e.message);
    }
  }
  return n;
}

const httpServer = app.listen(PORT, BIND, () => {
  console.log(`moni-dashboard listening on ${BIND}:${PORT}`);
  if (noUsersYet()) {
    // Materialise the token at startup so an operator with shell access can read
    // it, rather than having to hit the endpoint first to bring it into being.
    getSetupToken();
    console.log("No admin account yet. Setup token is in " + DATA_DIR + "/setup.token");
  }
  // Bring the helper's stored reader/listening models in line with the settings once.
  migrateVoiceHelperModels();
  // Which voice models the key reaches (GPT-4o Mini Realtime is offered only when listed).
  checkVoiceAccess({ force: true }).catch(() => {});
  // A local transcription model selected: make sure its server runs.
  syncLocalTranscriber();
});
httpServer.on("upgrade", liveUpgrade);

/* ------------------------------------------- restarts and deploys ---- */

/**
 * The open live calls, in a file the deploy scripts read before they restart
 * anything (deploy/deploy-dashboard.sh and deploy-moni-ai.sh warn about open
 * calls). Rewritten whenever a call starts or ends; {count: 0} at start.
 */
const LIVE_STATUS_FILE = path.join(DATA_DIR, "live-calls.json");
function writeLiveStatus() {
  try {
    fs.writeFileSync(LIVE_STATUS_FILE + ".tmp", JSON.stringify({ count: voiceLive.activeCount(), calls: voiceLive.status(), pid: process.pid, at: new Date().toISOString() }) + "\n", { mode: 0o640 });
    fs.renameSync(LIVE_STATUS_FILE + ".tmp", LIVE_STATUS_FILE);
  } catch (e) {
    console.log("live: could not write " + LIVE_STATUS_FILE + ": " + e.message);
  }
}
voiceLive.setOnChange(writeLiveStatus);
writeLiveStatus();

/**
 * SIGTERM (systemctl restart / stop, a deploy): every live call's page is told
 * {type: "restarting"} before its call ends, and reconnects by itself with
 * backoff once the new process listens. Then this process exits.
 */
let stopping = false;
function stopGracefully(sig) {
  if (stopping) return;
  stopping = true;
  const n = voiceLive.restartAll(); // (rewrites the status file only when calls were open)
  if (!n) process.exit(0); // nothing to tell: stop at once, as before this handler existed
  console.log(`moni-dashboard: ${sig}; ${n} live call(s) told the dashboard is restarting`);
  try {
    httpServer.close();
  } catch (_) {
    /* already closing */
  }
  // A moment for the "restarting" frames and the close handshakes to leave.
  setTimeout(() => process.exit(0), 400).unref();
}
process.on("SIGTERM", () => stopGracefully("SIGTERM"));
process.on("SIGINT", () => stopGracefully("SIGINT"));

/**
 * MINT AI hears that the dashboard (re)started, with what was deployed
 * (deploy-dashboard.sh writes DEPLOYED next to server.js: the commit and when):
 * the supervisor passes it on with MINT AI's next turn. Retried while the
 * supervisor is not up.
 */
function deployedStamp(file) {
  try {
    const out = {};
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^([a-z_]+)=([^\s]{1,80})$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch (_) {
    return {};
  }
}
function announceStart(tries) {
  const d = deployedStamp(path.join(__dirname, "DEPLOYED"));
  const params = { component: "dashboard", started_at: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString() };
  if (d.commit && /^[0-9a-f]{7,40}$/.test(d.commit)) params.commit = d.commit;
  if (d.deployed_at && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(d.deployed_at)) params.deployed_at = d.deployed_at;
  moniai
    .call("deploy-event", params, "moni-dashboard", { timeout: 5000 })
    .catch((e) => {
      if (tries > 0 && !stopping) setTimeout(() => announceStart(tries - 1), 30000).unref();
      else console.log("moni-dashboard: MINT AI was not told about this start (" + e.message + ")");
    });
}
if (process.env.MONI_ANNOUNCE_START !== "0") setTimeout(() => announceStart(10), 2000).unref();

