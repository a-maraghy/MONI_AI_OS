#!/usr/bin/env node
"use strict";
/**
 * The voice persona over HTTP: learned from how the administrator speaks,
 * saved per user, shown read-only in Settings with a Reset.
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-voice-persona.cjs
 *
 * The real server.js, from a scratch copy that cannot reach the privileged
 * helper (tools/scratch-server.cjs), on a scratch data dir, with a mock
 * realtime server standing in for OpenAI: the desk's turns go to it, and it
 * records the instructions each response was asked for.
 */
const path = require("path");
const http = require("http");
const scratch = require("./scratch-server.cjs"); // first: sets MONI_DATA_DIR
const { WebSocketServer } = require("ws");

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

/* A mock realtime: text sessions answer small talk; audio sessions (the reader) are refused. */
const asked = [];
const mockHttp = http.createServer((q, s) => (s.writeHead(404), s.end()));
const wss = new WebSocketServer({ noServer: true });
mockHttp.on("upgrade", (req, sock, head) => {
  if (req.headers.authorization !== "Bearer " + scratch.FAKE_KEY) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => {
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    ws.on("message", (d) => {
      const ev = JSON.parse(String(d));
      if (ev.type === "session.update") {
        const mods = (ev.session && ev.session.output_modalities) || ["audio"];
        if (mods[0] !== "text") return ws.close(); // the reader: fails fast, the line is skipped
        return send({ type: "session.updated", session: ev.session });
      }
      if (ev.type === "response.create") {
        asked.push((ev.response && ev.response.instructions) || "");
        const say = "أهلاً! تحت أمرك.";
        const item = { id: "item_" + asked.length, type: "message", role: "assistant", content: [] };
        send({ type: "response.output_item.added", item });
        send({ type: "response.output_text.delta", item_id: item.id, delta: say });
        send({ type: "response.done", response: { id: "r" + asked.length, status: "completed", output: [{ ...item, content: [{ type: "output_text", text: say }] }], usage: { input_tokens: 100, output_tokens: 8, input_token_details: { text_tokens: 100 }, output_token_details: { text_tokens: 8 } } } });
      }
    });
  });
});

(async () => {
  await new Promise((r) => mockHttp.listen(0, "127.0.0.1", r));
  const WS = "ws://127.0.0.1:" + mockHttp.address().port + "/v1";
  const s = await scratch.startScratch({ env: { MONI_OPENAI_WS: WS } });
  const db = require(path.join(ROOT, "lib", "db.js"));
  try {
    db.setSetting("voice_desk", "1", "test"); // the scratch database, never the live one
    await s.makeUser("personaadmin", "administrator");
    const A = await s.signIn("personaadmin");
    const me = db.getUserByName("personaadmin");
    check("a new user has no persona", db.getVoicePersona(me.id) === "");

    let r = await s.req("GET", "/credentials/openai-voice", { cookie: A.cookie });
    check("Settings shows the persona card, not known yet, read-only with a Reset", r.status === 200 && /id="v-persona"/.test(r.body) && /id="voice-persona-gender">not known yet/.test(r.body) && /id="voice-persona-reset"/.test(r.body), r.status);
    const card = r.body.slice(r.body.indexOf('id="v-persona"') - 400, r.body.indexOf('id="voice-persona-reset"'));
    check("  and there is nothing to type a persona into", !/<input(?![^>]*type="hidden")|<textarea/.test(card));
    const tok = s.csrfOf((await s.req("GET", "/mint-ai", { cookie: A.cookie })).body);
    const turn = (text) => s.req("POST", "/mint-ai/api/desk/turn", { cookie: A.cookie, headers: { "X-CSRF-Token": tok, Accept: "application/json" }, body: { text } });

    r = await turn("تقدميني بالعربي المصري، إزيك عاملة إيه؟ عايزة أعرف حاجة");
    check("an Arabic turn with a feminine address is answered", r.status === 200 && /"type":"done"/.test(r.body), r.status + " " + r.body.slice(0, 200));
    let p = JSON.parse(db.getVoicePersona(me.id) || "{}");
    check("the persona is saved: feminine, Egyptian", p.gender === "f" && p.dialect === "egyptian", JSON.stringify(p));
    check("  and the reply was asked for in feminine Egyptian", /Egyptian colloquial/.test(asked[asked.length - 1]) && /feminine forms for yourself/.test(asked[asked.length - 1]));
    const audit = db.recentLogins(30).filter((x) => /voice persona learned/.test(x.detail || ""));
    check("the change is audited, with who and what", audit.length === 1 && audit[0].username === "personaadmin" && /self-gender feminine/.test(audit[0].detail) && /Egyptian/.test(audit[0].detail), JSON.stringify(audit));

    r = await turn("Is Odoo running?");
    check("English: answered in English", /plain English\.$/.test(asked[asked.length - 1]));
    check("  and the persona is kept (English says nothing about it)", JSON.parse(db.getVoicePersona(me.id)).gender === "f");
    r = await turn("الديسك مليان قد إيه؟");
    check("a later Arabic turn with no address still uses the saved feminine persona (it carries over)", /feminine forms for yourself/.test(asked[asked.length - 1]));
    check("  no new audit line when nothing changed", db.recentLogins(30).filter((x) => /voice persona learned/.test(x.detail || "")).length === 1);

    r = await s.req("GET", "/credentials/openai-voice", { cookie: A.cookie });
    check("Settings shows what was learned", /id="voice-persona-gender">feminine/.test(r.body) && /id="voice-persona-dialect">Egyptian colloquial/.test(r.body));
    const stok = s.csrfOf(r.body);
    r = await s.req("POST", "/credentials/openai-voice/persona/reset", { cookie: A.cookie, body: new URLSearchParams({ _csrf: "wrong" }).toString() });
    check("Reset needs the CSRF token", r.status === 403 && JSON.parse(db.getVoicePersona(me.id)).gender === "f", r.status);
    r = await s.req("POST", "/credentials/openai-voice/persona/reset", { cookie: A.cookie, body: new URLSearchParams({ _csrf: stok }).toString() });
    check("Reset forgets it", r.status === 302 && /#v-persona$/.test(r.headers.location) && db.getVoicePersona(me.id) === "", r.status + " " + r.headers.location);
    check("  and is audited", db.recentLogins(30).some((x) => /reset the voice persona/.test(x.detail || "") && x.username === "personaadmin"));
    r = await turn("الديسك مليان قد إيه؟");
    check("after a reset: gender-neutral again", /gender-neutral phrasing/.test(asked[asked.length - 1]));
    r = await turn("إنتَ سامعني؟ إنت مصري يا باشا؟");
    check("a masculine address: saved masculine", JSON.parse(db.getVoicePersona(me.id)).gender === "m" && /masculine forms for yourself/.test(asked[asked.length - 1]));

    await s.makeUser("personaviewer", "viewer");
    const V = await s.signIn("personaviewer");
    r = await s.req("POST", "/credentials/openai-voice/persona/reset", { cookie: V.cookie, body: new URLSearchParams({ _csrf: "x" }).toString() });
    check("a viewer cannot reach the reset", r.status === 403 || r.status === 302, r.status);
  } catch (e) {
    check("the HTTP run completed", false, e.stack + "\n" + s.out());
  } finally {
    s.stop();
    mockHttp.close();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
