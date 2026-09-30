#!/usr/bin/env node
"use strict";
/**
 * MINT AI ▸ Settings ▸ Voice ▸ Voice model, over HTTP and the live WebSocket
 * (2026-10-01: gpt-realtime-mini and GPT-4o Mini Realtime offered again).
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-voice-models.cjs
 *
 * The real server.js from a scratch copy (tools/scratch-server.cjs, helper
 * faked), a mock OpenAI that answers GET /v1/models with a list the test
 * changes, and a mock realtime socket.
 *
 *   - a stored gpt-realtime-mini survives the start (no migration rewrite);
 *   - the key's model list is read at start; GPT-4o Mini Realtime is listed,
 *     disabled, "not available on this OpenAI key" while the list lacks it, and
 *     a save of it is refused after a fresh check;
 *   - once the list carries it (a dated snapshot here) it is offered, saved,
 *     the live call connects with the listed id, read-aloud stays on 2.1 mini;
 *   - when the list loses it, the stored choice is kept but reads as the
 *     default (the call goes to 2.1 mini) and the option is disabled again;
 *     when it comes back, it enables itself;
 *   - the key never appears in the server's output.
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const scratch = require("./scratch-server.cjs"); // first: sets MONI_DATA_DIR
const { WebSocketServer, WebSocket } = require("ws");

const ROOT = path.join(__dirname, "..");
let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 400) + ")" : ""));
}
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 2000)) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !!(await fn());
}

const SNAP = "gpt-4o-mini-realtime-preview-2024-12-17";
let listed = ["gpt-realtime-mini", "gpt-realtime-2.1-mini", "gpt-4o-mini-transcribe"];
let gets = 0;
const sessions = [];
const mockHttp = http.createServer((q, s) => {
  if (q.method === "GET" && q.url === "/v1/models") {
    gets++;
    s.setHeader("Content-Type", "application/json");
    if (q.headers.authorization !== "Bearer " + scratch.FAKE_KEY) return (s.statusCode = 401), s.end('{"error":{"message":"bad key"}}');
    return s.end(JSON.stringify({ object: "list", data: listed.map((id) => ({ id, object: "model" })) }));
  }
  s.writeHead(404);
  s.end();
});
const wss = new WebSocketServer({ noServer: true });
mockHttp.on("upgrade", (req, sock, head) => {
  if (req.headers.authorization !== "Bearer " + scratch.FAKE_KEY) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => {
    const s = { url: req.url, closed: false };
    sessions.push(s);
    ws.on("close", () => (s.closed = true));
    ws.on("message", (d) => {
      const ev = JSON.parse(String(d));
      if (ev.type === "session.update") ws.send(JSON.stringify({ type: "session.updated", session: ev.session }));
    });
  });
});

(async () => {
  await new Promise((r) => mockHttp.listen(0, "127.0.0.1", r));
  const HTTP = "http://127.0.0.1:" + mockHttp.address().port + "/v1";
  const WS = "ws://127.0.0.1:" + mockHttp.address().port + "/v1";
  const db = require(path.join(ROOT, "lib", "db.js"));
  // The administrator's choice from before the one-model cut: it must survive the start now.
  db.setSetting("voice_model", "gpt-realtime-mini", "before");
  db.setSetting("voice_desk", "on", "before");
  const s = await scratch.startScratch({
    env: { MONI_OPENAI_WS: WS, MONI_OPENAI_HTTP: HTTP, MONI_VOICE_ACCESS_TTL_MS: "0", MONI_VOICE_ACCESS_RECHECK_MS: "0" },
    fakeVoiceOptions: true,
  });
  const SET = "/mint-ai/settings/voice";
  const form = (o) => new URLSearchParams(o).toString();
  const origin = "http://127.0.0.1:" + s.port;
  const opts = () => JSON.parse(fs.readFileSync(path.join(s.data, "fake-voice-options.json"), "utf8"));
  const sel = (body) => (body.match(/<select name="model"[\s\S]*?<\/select>/) || [""])[0];
  const open = (cookie, csrf) =>
    new Promise((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:" + s.port + "/mint-ai/api/live?csrf=" + encodeURIComponent(csrf || ""), { headers: { Cookie: cookie || "", Origin: origin } });
      const out = { status: null, ws: null, got: [], closed: null };
      ws.on("message", (d, bin) => !bin && out.got.push(JSON.parse(String(d))));
      ws.on("close", (code) => (out.closed = code));
      ws.on("unexpected-response", (q, res) => resolve({ ...out, status: res.statusCode }));
      ws.on("open", () => ((out.status = 101), (out.ws = ws), resolve(out)));
      ws.on("error", () => resolve({ ...out, status: out.status || "error" }));
    });
  const callModel = async (A) => {
    const cc = await s.req("GET", "/mint-ai", { cookie: A.cookie });
    const call = await open(A.cookie, s.csrfOf(cc.body));
    await until(() => call.got.some((m) => m.type === "ready"), 3000);
    const ready = call.got.find((m) => m.type === "ready");
    const url = sessions.length ? sessions[sessions.length - 1].url : "";
    if (call.ws) call.ws.close();
    await until(() => call.closed != null, 3000);
    return { status: call.status, model: ready && ready.model, url };
  };
  try {
    check("start: a stored gpt-realtime-mini is left alone (no migration rewrite)", db.getSetting("voice_model") === "gpt-realtime-mini" && db.settingRow("voice_model").updated_by === "before" && !/the voice model .* is not offered/.test(s.out()), s.out().slice(-400));
    check("start: the key's model list is read once (GET /v1/models)", await until(() => gets >= 1, 3000), gets);
    check("  the helper's reader stays 2.1 mini (gpt-realtime-mini did not pass the verbatim check)", (await until(() => fs.existsSync(path.join(s.data, "fake-voice-options.json")), 3000)) && opts().model === "gpt-realtime-2.1-mini");

    await s.makeUser("madmin", "administrator");
    const A = await s.signIn("madmin");
    let set = await s.req("GET", SET, { cookie: A.cookie });
    const stok = s.csrfOf(set.body);
    let m = sel(set.body);
    check("Settings: gpt-realtime-mini current; GPT-4o Mini Realtime disabled, 'not available on this OpenAI key'", /<option value="gpt-realtime-mini" data-hint="[^"]*" selected>GPT Realtime mini · 14\/18 word for word · retires 20 Jan 2027 · current</.test(m) && /<option value="gpt-4o-mini-realtime-preview" data-hint="Not available on this OpenAI key[^"]*" disabled>GPT-4o Mini Realtime · not available on this OpenAI key</.test(m), m);
    check("  the help says replies are read by 2.1 mini when the model does not read word for word", /Replies are read aloud by the voice model when it reads word for word; otherwise by <code>gpt-realtime-2\.1-mini<\/code>/.test(set.body));

    let c = await callModel(A);
    check("a live call on gpt-realtime-mini: connects with it", c.status === 101 && c.model === "gpt-realtime-mini" && /model=gpt-realtime-mini$/.test(c.url), JSON.stringify(c));

    let before = gets;
    let r = await s.req("POST", SET + "/options", { cookie: A.cookie, body: form({ _csrf: stok, model: "gpt-4o-mini-realtime-preview" }) });
    check("saving GPT-4o Mini Realtime while the key lacks it: refused after a fresh check, nothing changed", /err=/.test(r.headers.location || "") && /not%20available%20on%20this%20OpenAI%20key/.test(r.headers.location || "") && gets > before && db.getSetting("voice_model") === "gpt-realtime-mini", r.headers.location);

    listed = listed.concat([SNAP]);
    before = gets;
    r = await s.req("POST", SET + "/options", { cookie: A.cookie, body: form({ _csrf: stok, model: "gpt-4o-mini-realtime-preview" }) });
    check("the key gains it (a dated snapshot): saved after a fresh check; read-aloud stays on 2.1 mini", r.status === 303 && /msg=/.test(r.headers.location || "") && gets > before && db.getSetting("voice_model") === "gpt-4o-mini-realtime-preview" && opts().model === "gpt-realtime-2.1-mini", r.headers.location + " " + JSON.stringify(opts()));
    check("  the message names the reader", /Replies%20are%20read%20aloud%20by%20gpt-realtime-2.1-mini/.test(r.headers.location || ""), r.headers.location);
    set = await s.req("GET", SET, { cookie: A.cookie });
    m = sel(set.body);
    check("  Settings: GPT-4o Mini Realtime current, offered normally, nothing disabled", /<option value="gpt-4o-mini-realtime-preview" data-hint="A preview model[^"]*" selected>GPT-4o Mini Realtime · preview · replies read by 2\.1 mini · current</.test(m) && !/ disabled>/.test(m), m);
    c = await callModel(A);
    check("  a live call connects with the listed snapshot id", c.status === 101 && c.model === SNAP && c.url.endsWith("model=" + SNAP), JSON.stringify(c));

    listed = listed.filter((x) => x !== SNAP);
    before = gets;
    await s.req("GET", SET, { cookie: A.cookie }); // a stale answer (TTL 0 here) is refreshed in the background
    await until(() => gets > before, 3000);
    set = await s.req("GET", SET, { cookie: A.cookie });
    m = sel(set.body);
    check("the key loses it: the stored choice is kept, but reads as 2.1 mini; the option is disabled again", db.getSetting("voice_model") === "gpt-4o-mini-realtime-preview" && /<option value="gpt-realtime-2\.1-mini" data-hint="[^"]*" selected>[^<]*· current</.test(m) && /<option value="gpt-4o-mini-realtime-preview" data-hint="Not available[^"]*" disabled>/.test(m), m);
    c = await callModel(A);
    check("  a live call goes to 2.1 mini, never to the refused model", c.status === 101 && c.model === "gpt-realtime-2.1-mini" && /model=gpt-realtime-2\.1-mini$/.test(c.url), JSON.stringify(c));

    listed = listed.concat(["gpt-4o-mini-realtime-preview"]);
    before = gets;
    await s.req("GET", SET, { cookie: A.cookie });
    await until(() => gets > before, 3000);
    set = await s.req("GET", SET, { cookie: A.cookie });
    m = sel(set.body);
    check("it comes back (the plain id): the option enables itself, the stored choice is current again", /<option value="gpt-4o-mini-realtime-preview" data-hint="A preview model[^"]*" selected>[^<]*· current</.test(m) && !/ disabled>/.test(m), m);
    c = await callModel(A);
    check("  a live call connects with it", c.model === "gpt-4o-mini-realtime-preview" && c.url.endsWith("model=gpt-4o-mini-realtime-preview"), JSON.stringify(c));

    r = await s.req("POST", SET + "/options", { cookie: A.cookie, body: form({ _csrf: stok, model: "gpt-realtime-2.1-mini" }) });
    check("back to 2.1 mini (the default): saved; it reads aloud itself", db.getSetting("voice_model") === "gpt-realtime-2.1-mini" && opts().model === "gpt-realtime-2.1-mini");

    await s.makeUser("mop", "operator-voice", ["moniai.use", "voice.use", "os.view"]);
    const O = await s.signIn("mop");
    const cc = await s.req("GET", "/mint-ai", { cookie: O.cookie });
    r = await s.req("POST", SET + "/options", { cookie: O.cookie, body: form({ _csrf: s.csrfOf(cc.body), model: "gpt-realtime-mini" }) });
    check("without voice.manage the voice model cannot be changed", r.status === 403 && db.getSetting("voice_model") === "gpt-realtime-2.1-mini", r.status);

    check("the key never appears in the server's output", !s.out().includes(scratch.FAKE_KEY));
  } catch (e) {
    check("the run finished", false, e.stack);
  } finally {
    s.stop();
    wss.close();
    mockHttp.close();
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  }
})();
