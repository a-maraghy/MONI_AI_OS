"use strict";
/**
 * A scratch copy of the dashboard for tests that need the real server.js over
 * HTTP (and WebSocket), with NOTHING reaching the privileged helper.
 *
 * Trap (2026-09-29): a scratch copy calls the REAL /usr/local/sbin/moni-helper
 * through sudo, and submitting the voice-options form in one rewrote the live
 * voice settings. So the copy's lib/priv.js is patched before it starts:
 * callHelper() refuses every subcommand, and the voice status and key reads are
 * answered with fakes. The data dir is a temp dir, so no live setting
 * (voice_desk, the voice mode, a persona) can be written either.
 *
 *   const s = await startScratch({ env: {...}, fakeReads: { "service-list": [...] } });
 *   await s.makeUser("admin1", "administrator");
 *   const who = await s.signIn("admin1");
 *   const r = await s.req("GET", "/mint-ai", { cookie: who.cookie });
 *   s.stop();
 *
 * Set process.env.MONI_DATA_DIR before requiring lib/db.js in the test: this
 * sets it to the scratch data dir on load, so require this file first.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const SRC = path.join(__dirname, "..");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "moni-scratch-"));
const DATA = path.join(BASE, "data");
const LOGS = path.join(BASE, "log");
const APP = path.join(BASE, "dashboard");
fs.mkdirSync(DATA);
fs.mkdirSync(LOGS);
process.env.MONI_DATA_DIR = DATA;
process.env.MONI_LOG_DIR = LOGS;

const FAKE_KEY = "sk-proj-SCRATCHFAKEKEY-not-real-0000000000000000";

/**
 * Copy the dashboard and cut it off from the helper. With fakeKeys
 * ({ ubuntu: [...], root: [...] }) the SSH key list answers with those, so
 * /keys renders. With fakeVoiceOptions,
 * saving the voice settings writes a file in the scratch data dir (and the key
 * read answers from it) -- never the helper -- so a test can change the voice.
 * With fakeWhisper ({ installed: ["small-q8_0"] }) the local transcription
 * server's status and start/stop are answered from fake-whisper.json.
 */
function makeCopy(o) {
  o = o || {};
  fs.cpSync(SRC, APP, { recursive: true, filter: (p) => !/node_modules|\.git$/.test(p) });
  const p = path.join(APP, "lib", "priv.js");
  let s = fs.readFileSync(p, "utf8");
  const head = "function callHelper(subcommand, args = [], opts = {}) {\n";
  if (!s.includes(head)) throw new Error("scratch: priv.js callHelper not found; refusing to start an unguarded copy");
  // fakeReads: canned answers for read-only subcommands (e.g. "service-list"), so a
  // page that lists things can be rendered; everything else is still refused.
  const reads = o.fakeReads && typeof o.fakeReads === "object" ? o.fakeReads : null;
  const canned = reads ? "  { const F = " + JSON.stringify(reads) + "; if (Object.prototype.hasOwnProperty.call(F, subcommand) && /^(list|status|agent-list|channel-list|service-list|credential-list|system-probe|cc-)/.test(subcommand)) return Promise.resolve(JSON.parse(JSON.stringify(F[subcommand]))); }\n" : "";
  s = s.replace(head, head + canned + '  return Promise.reject(new Error("scratch copy: the helper is not called (" + subcommand + ")"));\n');
  const status = 'voiceStatus: () => callHelper("voice-status"),';
  const key = 'voiceKeyRead: () => callHelper("voice-key-read"),';
  if (!s.includes(status) || !s.includes(key)) throw new Error("scratch: priv.js voice reads not found");
  if (o.fakeVoiceOptions) {
    const setter = s.match(/voiceOptionsSet: \(model, voice, transcribeModel\) =>[\s\S]*?\),\n/);
    if (!setter) throw new Error("scratch: priv.js voiceOptionsSet not found");
    const file = JSON.stringify(path.join(DATA, "fake-voice-options.json"));
    s = s.replace(setter[0], `voiceOptionsSet: async (model, voice, transcribeModel) => { require("fs").writeFileSync(${file}, JSON.stringify({ model, voice, transcribe_model: transcribeModel })); return { ok: true }; },\n`);
    s = s.replace(key, `voiceKeyRead: async () => { let o = {}; try { o = JSON.parse(require("fs").readFileSync(${file}, "utf8")); } catch (_) { o = {}; } return { key: "${FAKE_KEY}", model: o.model || "gpt-realtime-mini", voice: o.voice || "marin", transcribe_model: o.transcribe_model || "gpt-4o-mini-transcribe" }; },`);
  }
  if (o.fakeWhisper) {
    // Local transcription (lib/voice-transcribe.js): the helper's voice-whisper-* answered from a
    // file in the scratch data dir -- {installed: [model ids], selected, active, calls: [...]}.
    const wstatus = 'voiceWhisperStatus: () => callHelper("voice-whisper-status"),';
    const wset = 'voiceWhisperSet: (model) => callHelper("voice-whisper-set", [model], { timeout: 90000 }),';
    if (!s.includes(wstatus) || !s.includes(wset)) throw new Error("scratch: priv.js voiceWhisper* not found");
    const wf = JSON.stringify(path.join(DATA, "fake-whisper.json"));
    fs.writeFileSync(path.join(DATA, "fake-whisper.json"), JSON.stringify({ installed: o.fakeWhisper.installed || [], selected: null, active: "inactive", calls: [] }));
    const read = `const F = require("fs"); const W = JSON.parse(F.readFileSync(${wf}, "utf8"));`;
    const out = `({ installed: true, binary: true, vad: true, models: W.installed.map((m) => ({ model: m, bytes: 1 })), selected: W.selected, active: W.active, enabled: W.active === "active" ? "enabled" : "disabled", install: "deploy/install-voice-whisper.sh" })`;
    s = s.replace(wstatus, `voiceWhisperStatus: async () => { ${read} return ${out}; },`);
    s = s.replace(
      wset,
      `voiceWhisperSet: async (model) => { ${read} W.calls.push(model); if (model === "off") { W.active = "inactive"; } else if (!W.installed.includes(model)) { F.writeFileSync(${wf}, JSON.stringify(W)); throw new Error("the model " + model + " is not installed on this server; run: deploy/install-voice-whisper.sh"); } else { W.selected = model; W.active = "active"; } F.writeFileSync(${wf}, JSON.stringify(W)); return ${out}; },`
    );
  }
  if (o.fakeKeys) {
    // /keys lists keys through the helper; a test that renders it gets these.
    const list = 'listAllKeys: () => callHelper("list-all-keys"),';
    if (!s.includes(list)) throw new Error("scratch: priv.js listAllKeys not found");
    s = s.replace(list, "listAllKeys: async () => (" + JSON.stringify(o.fakeKeys) + "),");
  }
  s = s
    .replace(status, 'voiceStatus: async () => ({ configured: true, last4: "fake", length: 52, path: "(scratch)", mode: "0o600", modified: null, model: "gpt-realtime-mini", voice: "marin", transcribe_model: "gpt-4o-mini-transcribe" }),')
    .replace(key, `voiceKeyRead: async () => ({ key: "${FAKE_KEY}", model: "gpt-realtime-mini", voice: "marin", transcribe_model: "gpt-4o-mini-transcribe" }),`);
  fs.writeFileSync(p, s);
  // Belt and braces: the copy must not be able to name the real helper at all.
  if (!/scratch copy: the helper is not called/.test(fs.readFileSync(p, "utf8"))) throw new Error("scratch: guard not applied");
}

async function startScratch(opts) {
  const o = opts || {};
  makeCopy(o);
  const port = o.port || 3600 + Math.floor(Math.random() * 300);
  const env = Object.assign({}, process.env, {
    MONI_PORT: String(port),
    MONI_BIND: "127.0.0.1",
    MONI_DATA_DIR: DATA,
    MONI_LOG_DIR: LOGS,
    MONI_AI_SOCKET: path.join(DATA, "no-such.sock"),
    MONI_OPENAI_HTTP: "http://127.0.0.1:1/v1",
    MONI_OPENAI_WS: "ws://127.0.0.1:1/v1",
    NODE_ENV: "production",
  }, o.env || {});
  const child = spawn(process.execPath, [path.join(APP, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 60 && !/listening/.test(out); i++) await new Promise((r) => setTimeout(r, 200));
  if (!/listening/.test(out)) {
    child.kill();
    throw new Error("scratch server did not start: " + out);
  }

  function req(method, p, { cookie, headers, body } = {}) {
    return new Promise((resolve, reject) => {
      const h = Object.assign({ "X-Forwarded-Proto": "https" }, headers || {});
      if (cookie) h.Cookie = cookie;
      let data = null;
      if (body !== undefined) {
        data = typeof body === "string" ? body : JSON.stringify(body);
        if (!h["Content-Type"]) h["Content-Type"] = typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json";
        h["Content-Length"] = Buffer.byteLength(data);
      }
      const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
        res.on("error", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      });
      r.on("error", reject);
      r.setTimeout(15000, () => r.destroy(new Error("timeout " + method + " " + p)));
      if (data) r.write(data);
      r.end();
    });
  }
  const cookieOf = (res, prev) => {
    const set = res.headers["set-cookie"];
    return set ? set.map((c) => c.split(";")[0]).join("; ") : prev;
  };
  const users = {};
  async function makeUser(username, roleName, permissions) {
    const db = require(path.join(SRC, "lib", "db.js"));
    if (permissions && !db.getRoleByName(roleName)) db.createRole({ name: roleName, label: roleName, permissions, agentScope: "*", channelScope: "*" });
    const argon2 = require("argon2");
    const { authenticator } = require("otplib");
    const pw = "pw-" + Math.random().toString(36).slice(2);
    const secret = authenticator.generateSecret();
    const role = db.getRoleByName(roleName);
    db.createUser({ username, displayName: username, email: username + "@example.invalid", passwordHash: await argon2.hash(pw, { type: argon2.argon2id }), totpSecret: secret, roleId: role.id, createdBy: "test" });
    db.confirmUserTotp(db.getUserByName(username).id);
    users[username] = { pw, secret };
    return users[username];
  }
  async function signIn(username) {
    const { authenticator } = require("otplib");
    const u = users[username];
    const g = await req("GET", "/login");
    let cookie = cookieOf(g);
    const csrf = (g.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    const form = new URLSearchParams({ _csrf: csrf, username, password: u.pw, token: authenticator.generate(u.secret) }).toString();
    const p = await req("POST", "/login", { cookie, body: form });
    cookie = cookieOf(p, cookie);
    if (p.status !== 302 || /\/login/.test(p.headers.location || "")) throw new Error("sign-in failed: " + p.status);
    return { cookie };
  }
  const csrfOf = (html) => (/data-csrf="([^"]+)"/.exec(html) || /name="_csrf" value="([^"]+)"/.exec(html) || [])[1];
  return {
    port,
    base: BASE,
    data: DATA,
    app: APP,
    out: () => out,
    req,
    makeUser,
    signIn,
    csrfOf,
    stop() {
      child.kill();
      fs.rmSync(BASE, { recursive: true, force: true });
    },
  };
}

module.exports = { startScratch, DATA, FAKE_KEY };
