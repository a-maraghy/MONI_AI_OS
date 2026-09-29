#!/usr/bin/env node
"use strict";
/**
 * The MINT AI core setting: which of the three cores (A dotted sphere, B Siri
 * fluid, C hybrid) the Command Center draws, per person, default C.
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-mint-core.cjs
 *
 * Static checks on the pieces (cc-logic.js, db.js, server.js, the page
 * scripts), then the real server.js on a scratch port with a scratch data dir,
 * signed in over HTTP as an administrator, a second administrator and a
 * viewer:
 *
 *  - stored per user (users.mint_core), default C for anyone who never chose;
 *  - the saved core is in the served HTML as data-core, before any script runs;
 *  - the quick switch (POST /mint-ai/api/prefs/core) needs moniai.use and CSRF,
 *    refuses anything but A/B/C, saves, and leaves an audit line;
 *  - Account > Appearance shows the three cores to those who can open the
 *    Command Center, and its no-JavaScript form saves the same way;
 *  - the page swaps the running core in place (no reload).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mint-core-"));
const LOGS = path.join(DATA, "log");
fs.mkdirSync(LOGS);
process.env.MONI_DATA_DIR = DATA;
process.env.MONI_LOG_DIR = LOGS;
const PORT = 3700 + Math.floor(Math.random() * 90);

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
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/* ------------------------------------------------------- static checks --- */

const logic = require(path.join(ROOT, "public", "cc-logic.js"));
check("three cores: A dotted sphere, B Siri fluid, C hybrid", JSON.stringify(logic.CORES) === JSON.stringify({ A: "Dotted sphere", B: "Siri fluid", C: "Hybrid" }));
check("the default is C", logic.CORE_DEFAULT === "C" && logic.normCore("") === "C" && logic.normCore(null) === "C" && logic.normCore(undefined) === "C");
check("a saved choice is kept, in any case", logic.normCore("a") === "A" && logic.normCore(" B ") === "B" && logic.normCore("C") === "C");
check("anything else reads as the default", logic.normCore("D") === "C" && logic.normCore('"><x') === "C" && logic.normCore(7) === "C");
check("the API accepts exactly A, B or C", logic.isCore("A") && logic.isCore("B") && logic.isCore("C") && !logic.isCore("a") && !logic.isCore("") && !logic.isCore(null) && !logic.isCore(["A"]));

const dbSrc = read("lib/db.js");
check("db: users.mint_core is added the migration way, empty by default", /addColumn\("users", "mint_core", "TEXT NOT NULL DEFAULT ''"\)/.test(dbSrc));
check("db: setUserMintCore writes only that column, by id", /setUserMintCore: \(id, core\) =>\s*db\.prepare\("UPDATE users SET mint_core = \? WHERE id = \?"\)/.test(dbSrc));

const server = read("server.js");
check("server: the quick switch needs moniai.use and CSRF", /app\.post\("\/mint-ai\/api\/prefs\/core", \.\.\.moniAiWrite,/.test(server));
check("server: the Appearance form needs a session, moniai.use and CSRF", /app\.post\("\/account\/appearance", requireAuth, requirePerm\("moniai\.use"\), requireCsrf,/.test(server));
check("server: both validate with isCore and save through one function", (server.match(/mintLogic\.isCore\(core\)/g) || []).length === 2 && (server.match(/  setMintCore\(req, core\);/g) || []).length === 2);
check("server: the change is audited", /db\.logLogin\(req\.ip, req\.me\.username, "account", `MINT AI core \$\{was\} -> \$\{core\}/.test(server));
check("server: the page is given the saved core", /moniAiViews\.page\(\{[\s\S]{0,200}core: req\.me\.mint_core/.test(server));
check("server: /account shows Appearance only with moniai.use", /appearance: req\.perm\.can\("moniai\.use"\) \? moniAiViews\.appearance\(/.test(server));

const main = read("public/moni-ai.js"), map = read("public/cc-map.js"), core = read("public/mint-core.js"), settings = read("public/mint-settings.js");
check("page: the saved core comes from data-core, localStorage only as the fallback", /var c = root\.getAttribute\("data-core"\);\s*if \(!c\) \{ try \{ c = window\.localStorage\.getItem\(CORE_KEY\); \} catch/.test(main));
check("page: every localStorage use for the core is inside try/catch", main.split("\n").filter((l) => /localStorage/.test(l) && /CORE_KEY/.test(l)).every((l) => /try \{[^}]*localStorage[^}]*\} catch/.test(l)));
check("page: the quick switch swaps the core in place, then saves it", /function setCoreChoice\(c\) \{[\s\S]{0,160}Orb\.setConcept\(c\);[\s\S]{0,400}api\("prefs\/core", \{ body: \{ core: c \} \}\)/.test(main));
check("page: nothing reloads the page to switch", !/location\.reload|location\.href\s*=/.test(main + map + settings));
check("core: switching concept keeps the running loop (no new canvas, no new context)", /setConcept: function \(c\) \{[\s\S]{0,120}S\.concept = c;/.test(core) && (core.match(/getContext\("webgl"/g) || []).length === 1);
check("map: the concept is written back to data-core", /root\.setAttribute\("data-core", core\.S\.concept\)/.test(map));
check("settings: the Account previews save through the same route, CSRF in a header", /fetch\("\/mint-ai\/api\/prefs\/core"/.test(settings) && /"X-CSRF-Token": CSRF/.test(settings));
check("settings: its localStorage write is guarded", settings.split("\n").filter((l) => /localStorage/.test(l)).every((l) => /try \{[^}]*localStorage[^}]*\} catch/.test(l)));

/* the views */
const views = require(path.join(ROOT, "lib", "views-moniai.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const admin = rbac.actor({ permissions: ["*"] });
const pageFor = (core) => views.page({ csrf: "t", user: { name: "a", perm: admin }, core, voice: { configured: true, voice: "marin", manage: true } });
check("view: the saved core is on #cc before first paint", /<div class="cc-shell" id="cc"\s+data-core="B"/.test(pageFor("B")));
check("view: never chosen renders C", /id="cc"\s+data-core="C"/.test(pageFor(undefined)) && /id="cc"\s+data-core="C"/.test(pageFor("")));
check("view: a bad stored value cannot reach the markup", /id="cc"\s+data-core="C"/.test(pageFor('"><script>')) && !/"><script>/.test(pageFor('"><script>')));
check("view: the brand spark (concept C) is in the page, shown by CSS on data-core", /id="cc-spark"/.test(pageFor("C")) && /\.cc-shell\[data-core="C"\] \.cc-spark \{ opacity: 1; \}/.test(read("public/moni-ai.css")));
check("view: the quick switch is in the Everything sheet (and the voice menu builds the same)", (pageFor("A").match(/data-core-set="[ABC]"/g) || []).length === 3 && /data-core-set="A" aria-checked="true"/.test(pageFor("A")) && /data-core-set=/.test(main));
const ap = views.appearance({ csrf: 'x"y', core: "B" });
check("appearance: three options, the saved one checked, a preview canvas each", (ap.html.match(/name="core" value="[ABC]"/g) || []).length === 3 && /value="B" checked/.test(ap.html) && (ap.html.match(/data-prev-core="[ABC]"/g) || []).length === 3);
check("appearance: works without JavaScript (a form post with the CSRF token)", /<form method="post" action="\/account\/appearance"/.test(ap.html) && /name="_csrf" value="x&quot;y"/.test(ap.html));
check("appearance: loads its own stylesheet and scripts, the core renderer first", ap.assets.join(" ") === "mint-settings.css mint-core.js mint-settings.js");
check("appearance: no inline style or handler", !/\sstyle\s*=|\son[a-z]+\s*=/i.test(ap.html));

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
  return { cookie, landed: p.headers.location };
}

async function makeUser(username, roleName, permissions) {
  const db = require(path.join(ROOT, "lib", "db.js"));
  if (permissions && !db.getRoleByName(roleName))
    db.createRole({ name: roleName, label: roleName, permissions, agentScope: "*", channelScope: "*" });
  const argon2 = require("argon2");
  const { authenticator } = require("otplib");
  const pw = "pw-" + Math.random().toString(36).slice(2);
  const secret = authenticator.generateSecret();
  const role = db.getRoleByName(roleName);
  db.createUser({ username, displayName: username, email: username + "@example.invalid", passwordHash: await argon2.hash(pw, { type: argon2.argon2id }), totpSecret: secret, roleId: role.id, createdBy: "test" });
  db.confirmUserTotp(db.getUserByName(username).id);
  return { pw, secret };
}
const coreOn = (html) => (/<div class="cc-shell" id="cc"\s+data-core="([^"]*)"/.exec(html) || [])[1];
const csrfOf = (html) => (/data-csrf="([^"]+)"/.exec(html) || /name="_csrf" value="([^"]+)"/.exec(html) || [])[1];

(async () => {
  const a1 = await makeUser("coreadmin", "administrator");
  const a2 = await makeUser("coreadmin2", "administrator");
  const vw = await makeUser("coreviewer", "viewer");
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: Object.assign({}, process.env, { MONI_PORT: String(PORT), MONI_BIND: "127.0.0.1", MONI_AI_SOCKET: path.join(DATA, "no-such.sock"), NODE_ENV: "production" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = () => { child.kill(); fs.rmSync(DATA, { recursive: true, force: true }); };
  try {
    for (let i = 0; i < 60 && !/listening/.test(out); i++) await new Promise((r) => setTimeout(r, 200));
    if (!/listening/.test(out)) throw new Error("server did not start: " + out);
    const A1 = await signIn("coreadmin", a1.pw, a1.secret);
    const A2 = await signIn("coreadmin2", a2.pw, a2.secret);
    const V = await signIn("coreviewer", vw.pw, vw.secret);

    let r = await req("GET", "/mint-ai", { cookie: A1.cookie });
    check("never chosen: the page is served with core C", r.status === 200 && coreOn(r.body) === "C", r.status + " " + coreOn(r.body));
    const tok = csrfOf(r.body);
    const post = (who, body, token) => req("POST", "/mint-ai/api/prefs/core", { cookie: who.cookie, headers: Object.assign({ Accept: "application/json" }, token ? { "X-CSRF-Token": token } : {}), body });

    r = await post(A1, { core: "A" });
    check("quick switch without the CSRF token: refused (403)", r.status === 403, r.status);
    r = await post(A1, { core: "D" }, tok);
    check("quick switch to an unknown core: refused (400)", r.status === 400 && /A, B or C/.test(r.body), r.status + " " + r.body);
    r = await post(A1, { core: "a" }, tok);
    check("only the capital letter is a core (the page sends exactly A/B/C)", r.status === 400, r.status);
    r = await post(A1, { core: "A" }, tok);
    check("quick switch to A: saved", r.status === 200 && JSON.parse(r.body).core === "A" && JSON.parse(r.body).name === "Dotted sphere", r.status + " " + r.body);
    r = await req("GET", "/mint-ai", { cookie: A1.cookie });
    check("the next page load is drawn as A from its first paint (data-core in the HTML)", coreOn(r.body) === "A", coreOn(r.body));
    r = await req("GET", "/mint-ai", { cookie: A2.cookie });
    check("per person: another administrator still has C", coreOn(r.body) === "C", coreOn(r.body));

    const db = require(path.join(ROOT, "lib", "db.js"));
    const rows = db.recentLogins(20).filter((x) => x.outcome === "account" && /MINT AI core/.test(x.detail || ""));
    check("audited: one line per change, who and what", rows.length === 1 && rows[0].username === "coreadmin" && /MINT AI core C -> A \(Dotted sphere\)/.test(rows[0].detail), JSON.stringify(rows));
    check("stored on the user row", db.getUserByName("coreadmin").mint_core === "A" && db.getUserByName("coreadmin2").mint_core === "");

    r = await req("GET", "/account", { cookie: A1.cookie });
    check("Account shows Appearance with the saved core checked", r.status === 200 && /id="appearance"/.test(r.body) && /value="A" checked/.test(r.body), r.status);
    check("…and loads the previews' scripts", /mint-core\.js\?v=/.test(r.body) && /mint-settings\.js\?v=/.test(r.body) && /mint-settings\.css\?v=/.test(r.body));
    const accTok = csrfOf(r.body);
    r = await req("POST", "/account/appearance", { cookie: A1.cookie, body: new URLSearchParams({ _csrf: accTok, core: "B" }).toString() });
    check("the no-JavaScript form saves too, and returns to Appearance", r.status === 302 && /^\/account\?msg=.*#appearance$/.test(r.headers.location), r.status + " " + r.headers.location);
    r = await req("GET", "/mint-ai", { cookie: A1.cookie });
    check("…the page then draws B", coreOn(r.body) === "B", coreOn(r.body));
    r = await req("POST", "/account/appearance", { cookie: A1.cookie, body: new URLSearchParams({ _csrf: accTok, core: "Z" }).toString() });
    check("the form refuses anything but A/B/C", r.status === 302 && /err=/.test(r.headers.location) && db.getUserByName("coreadmin").mint_core === "B", r.headers.location);
    r = await req("POST", "/account/appearance", { cookie: A1.cookie, body: new URLSearchParams({ _csrf: "wrong", core: "C" }).toString() });
    check("the form needs its CSRF token", r.status === 403 && db.getUserByName("coreadmin").mint_core === "B", r.status);

    r = await req("GET", "/account", { cookie: V.cookie });
    check("a viewer's Account has no Appearance card", r.status === 200 && !/id="appearance"/.test(r.body) && !/mint-settings\.js/.test(r.body), r.status);
    r = await req("GET", "/mint-ai", { cookie: V.cookie });
    check("a viewer does not get the Command Center", !coreOn(r.body), r.status);
    const vtok = csrfOf((await req("GET", "/account", { cookie: V.cookie })).body);
    r = await post(V, { core: "A" }, vtok);
    check("a viewer cannot set a core (403)", r.status === 403, r.status);
    r = await req("POST", "/account/appearance", { cookie: V.cookie, body: new URLSearchParams({ _csrf: vtok, core: "A" }).toString() });
    check("…through the form either", r.status === 403 && db.getUserByName("coreviewer").mint_core === "", r.status);
    r = await req("POST", "/mint-ai/api/prefs/core", { headers: { Accept: "application/json" }, body: { core: "A" } });
    check("signed out: 401", r.status === 401, r.status);
  } catch (e) {
    check("the HTTP run completed", false, e.stack + "\n" + out);
  } finally {
    done();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
