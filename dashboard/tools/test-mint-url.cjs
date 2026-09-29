/**
 * The Command Center's URL moved from /moni-ai to /mint-ai (the Mint rename).
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-mint-url.cjs
 *
 * Boots the real server.js on a scratch port with a scratch data dir (no
 * supervisor socket, so MINT AI calls answer "offline") and checks over HTTP:
 *
 *  - /mint-ai is the page and /mint-ai/api/* the API;
 *  - GET /moni-ai and any page path under it 301 to /mint-ai, query kept;
 *  - /moni-ai/api/* is an alias served by the same handlers, with the same
 *    401 (no session), 403 (no moniai.use), 403 (no CSRF) answers -- never a
 *    redirect, which would break POST, SSE and CSRF'd fetches;
 *  - no client code still names the old URL: only the alias layer in server.js.
 *
 * .cjs because it uses require, and some directories it may be run from declare
 * "type": "module".
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mint-url-"));
const LOGS = path.join(DATA, "log");
fs.mkdirSync(LOGS);
process.env.MONI_DATA_DIR = DATA;
process.env.MONI_LOG_DIR = LOGS;
const PORT = 3900 + Math.floor(Math.random() * 90);

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}

/* ------------------------------------------------------- static checks --- */

const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
check("no route is registered under /moni-ai", !/app\.(get|post|put|patch|delete|all|use)\(\s*["'`]\/moni-ai/.test(server));
check("the page route is /mint-ai", /app\.get\("\/mint-ai", requireAuth,/.test(server));
check("the API routes are under /mint-ai/api", (server.match(/app\.(get|post)\("\/mint-ai\/api\//g) || []).length >= 39); // every one of the 39 that lived under /moni-ai/api
{
  // Outside the alias block, server.js names the old URL nowhere.
  const i = server.indexOf("const LEGACY_CC");
  const rest = server.slice(0, i - 800) + server.slice(i + 600);
  check("the alias layer exists and is the one place that names the /moni-ai URL", i > 0 && !/["'`\s(]\/moni-ai[\/"'`\s)]/.test(rest));
}
{
  // Client code: every public script, every view, the guide, the READMEs.
  const files = [
    ...fs.readdirSync(path.join(ROOT, "public")).filter((f) => f.endsWith(".js") || f.endsWith(".css")).map((f) => path.join(ROOT, "public", f)),
    ...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).map((f) => path.join(ROOT, "lib", f)),
    path.join(ROOT, "README.md"),
    path.join(ROOT, "..", "moni-ai", "README.md"),
  ];
  // A URL, not a path on disk (/root/moni-ai, /etc/moni-ai, ...) nor a file
  // name (public/moni-ai.js) nor an id (the moni-ai unit, moni-ai-ctl).
  const URL_RE = /(^|[\s"'`(=])\/moni-ai(?=[\/"'`)\s?]|$)(?!\/(lib|home|hooks|tools|bin|supervisor))/m;
  const hits = [];
  for (const f of files) {
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (URL_RE.test(line)) hits.push(path.relative(ROOT, f) + ":" + (i + 1) + ": " + line.trim().slice(0, 80));
    });
  }
  check("no client code, view or README references the /moni-ai URL", hits.length === 0, hits.join(" | "));
  const ui = require(path.join(ROOT, "lib", "ui.js"));
  check("the top-bar tab points at /mint-ai", ui.NAV[0].href === "/mint-ai");
  const js = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
  check("the page's API base, event stream and speech are under /mint-ai", /fetch\("\/mint-ai\/api\/" \+ path/.test(js) && /new EventSource\("\/mint-ai\/api\/events[?"]/.test(js) && /fetch\("\/mint-ai\/api\/speak"/.test(js));
}

/* ------------------------------------------------------------- over HTTP --- */

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
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: h }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        // SSE never ends: the headers are the answer.
        if (/text\/event-stream/.test(res.headers["content-type"] || "")) {
          r.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        }
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      res.on("error", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on("error", reject);
    r.setTimeout(8000, () => r.destroy(new Error("timeout " + method + " " + p)));
    if (data) r.write(data);
    r.end();
  });
}

function cookieOf(res, prev) {
  const set = res.headers["set-cookie"];
  if (!set) return prev;
  return set.map((c) => c.split(";")[0]).join("; ");
}

async function signIn(username, password, secret) {
  const { authenticator } = require("otplib");
  const g = await req("GET", "/login");
  let cookie = cookieOf(g);
  const csrf = (g.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const form = new URLSearchParams({ _csrf: csrf, username, password, token: authenticator.generate(secret) }).toString();
  const p = await req("POST", "/login", { cookie, body: form });
  cookie = cookieOf(p, cookie);
  if (p.status !== 302 || /\/login/.test(p.headers.location || "")) throw new Error("sign-in failed: " + p.status + " " + p.headers.location);
  const page = await req("GET", "/mint-ai", { cookie });
  const pageCsrf = (page.body.match(/data-csrf="([^"]+)"/) || [])[1];
  return { cookie, csrf: pageCsrf, page };
}

async function makeUser(username, roleName) {
  const db = require(path.join(ROOT, "lib", "db.js"));
  const argon2 = require("argon2");
  const { authenticator } = require("otplib");
  const pw = "pw-" + Math.random().toString(36).slice(2);
  const secret = authenticator.generateSecret();
  const role = db.getRoleByName(roleName);
  db.createUser({ username, displayName: username, email: username + "@example.invalid", passwordHash: await argon2.hash(pw, { type: argon2.argon2id }), totpSecret: secret, roleId: role.id, createdBy: "test" });
  db.confirmUserTotp(db.getUserByName(username).id);
  return { pw, secret };
}

(async () => {
  const admin = await makeUser("urladmin", "administrator");
  const viewer = await makeUser("urlviewer", "viewer");

  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: Object.assign({}, process.env, {
      MONI_PORT: String(PORT),
      MONI_BIND: "127.0.0.1",
      MONI_AI_SOCKET: path.join(DATA, "no-such.sock"),
      NODE_ENV: "production",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = () => {
    child.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  };
  try {
    for (let i = 0; i < 60 && !/listening/.test(out); i++) await new Promise((r) => setTimeout(r, 200));
    if (!/listening/.test(out)) throw new Error("server did not start: " + out);

    /* signed out */
    let r = await req("GET", "/mint-ai");
    check("GET /mint-ai signed out -> 302 /login", r.status === 302 && r.headers.location === "/login", r.status + " " + r.headers.location);
    r = await req("GET", "/moni-ai");
    check("GET /moni-ai -> 301 /mint-ai", r.status === 301 && r.headers.location === "/mint-ai", r.status + " " + r.headers.location);
    r = await req("HEAD", "/moni-ai");
    check("HEAD /moni-ai -> 301 /mint-ai", r.status === 301 && r.headers.location === "/mint-ai", r.status + " " + r.headers.location);
    r = await req("GET", "/moni-ai?x=1&y=two");
    check("GET /moni-ai?query keeps the query", r.status === 301 && r.headers.location === "/mint-ai?x=1&y=two", r.headers.location);
    r = await req("GET", "/moni-ai/some/deep/link?tab=rules");
    check("a sub-path 301s to the same path under /mint-ai, query kept", r.status === 301 && r.headers.location === "/mint-ai/some/deep/link?tab=rules", r.headers.location);
    r = await req("GET", "/MONI-AI/");
    check("the old prefix redirects whatever its case", r.status === 301 && r.headers.location === "/mint-ai/", r.headers.location);
    r = await req("GET", "/moni-aix");
    check("a path that merely starts with moni-ai is not touched", r.status !== 301, r.status);
    for (const pfx of ["/mint-ai", "/moni-ai"]) {
      r = await req("GET", pfx + "/api/status");
      check(`GET ${pfx}/api/status signed out -> 401 JSON`, r.status === 401 && /Sign in first/.test(r.body), r.status + " " + r.body);
      r = await req("POST", pfx + "/api/send", { body: { text: "hi" } });
      check(`POST ${pfx}/api/send signed out -> 401`, r.status === 401, r.status);
      r = await req("GET", pfx + "/api/events");
      check(`GET ${pfx}/api/events signed out -> 401, not a redirect`, r.status === 401, r.status);
    }

    /* signed in, administrator */
    const a = await signIn("urladmin", admin.pw, admin.secret);
    check("GET /mint-ai signed in -> 200 Command Center", a.page.status === 200 && /id="cc"/.test(a.page.body) && !!a.csrf, a.page.status);
    check("the page's own tab link is /mint-ai", /<a href="\/mint-ai" class="top-tab ai on" aria-current="page">/.test(a.page.body));
    r = await req("GET", "/moni-ai", { cookie: a.cookie });
    check("signed in, the old URL still 301s to /mint-ai", r.status === 301 && r.headers.location === "/mint-ai", r.status);
    const st = { new: await req("GET", "/mint-ai/api/status", { cookie: a.cookie }), old: await req("GET", "/moni-ai/api/status", { cookie: a.cookie }) };
    check("status answers the same on both prefixes (offline supervisor -> 503)", st.new.status === 503 && st.old.status === 503 && st.new.body === st.old.body, st.new.status + " " + st.old.status);
    for (const pfx of ["/mint-ai", "/moni-ai"]) {
      r = await req("POST", pfx + "/api/send", { cookie: a.cookie, body: { text: "hi" } });
      check(`POST ${pfx}/api/send without CSRF -> 403`, r.status === 403 && /CSRF/.test(r.body), r.status + " " + r.body);
      r = await req("POST", pfx + "/api/send", { cookie: a.cookie, headers: { "X-CSRF-Token": a.csrf }, body: { text: "hi" } });
      check(`POST ${pfx}/api/send with CSRF reaches the handler (offline -> 503)`, r.status === 503, r.status + " " + r.body);
      r = await req("POST", pfx + "/api/speak", { cookie: a.cookie, body: { text: "x" } });
      check(`POST ${pfx}/api/speak without CSRF -> 403`, r.status === 403, r.status);
      r = await req("GET", pfx + "/api/voice/usage", { cookie: a.cookie });
      check(`GET ${pfx}/api/voice/usage -> 200 JSON`, r.status === 200 && /^\{/.test(r.body), r.status + " " + r.body);
      r = await req("POST", pfx + "/api/transcribe", { cookie: a.cookie, headers: { "X-CSRF-Token": a.csrf }, body: { data: "x".repeat(100 * 1024) } });
      check(`POST ${pfx}/api/transcribe takes a body over 64 KB (the large parser, not 413)`, r.status !== 413, r.status + " " + r.body);
      r = await req("GET", pfx + "/api/events", { cookie: a.cookie });
      check(`GET ${pfx}/api/events streams (SSE, no redirect)`, r.status === 200 && /text\/event-stream/.test(r.headers["content-type"] || ""), r.status + " " + r.headers["content-type"]);
    }

    /* signed in, a role without moniai.use */
    const v = await signIn("urlviewer", viewer.pw, viewer.secret);
    for (const pfx of ["/mint-ai", "/moni-ai"]) {
      r = await req("GET", pfx + "/api/status", { cookie: v.cookie });
      check(`GET ${pfx}/api/status without moniai.use -> 403`, r.status === 403 && /MINT AI/.test(r.body), r.status + " " + r.body);
      r = await req("POST", pfx + "/api/send", { cookie: v.cookie, headers: { "X-CSRF-Token": "x" }, body: { text: "hi" } });
      check(`POST ${pfx}/api/send without moniai.use -> 403`, r.status === 403, r.status);
    }
    r = await req("GET", "/mint-ai", { cookie: v.cookie });
    check("the page itself refuses a role without moniai.use", r.status === 403, r.status);

    /* the rest is unchanged */
    r = await req("GET", "/console", { cookie: a.cookie });
    check("/console is unchanged", r.status === 200, r.status);
  } catch (e) {
    check("the HTTP run completed", false, e.stack + "\n" + out);
  } finally {
    done();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
