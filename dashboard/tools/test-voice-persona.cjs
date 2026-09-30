#!/usr/bin/env node
"use strict";
/**
 * The voice persona over HTTP: saved per user, shown in MINT AI ▸ Settings ▸
 * Voice (the "Arabic persona" row) with a Reset, chosen from a fixed list only.
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-voice-persona.cjs
 *
 * The real server.js, from a scratch copy that cannot reach the privileged
 * helper (tools/scratch-server.cjs), on a scratch data dir. Learning a persona
 * from how the administrator speaks happens in the live call now (the front
 * desk that used to drive this test is gone): lib/voice-persona.js detect /
 * merge are covered by test-voice-arabic.cjs, and the live call's use of the
 * saved persona by test-voice-live.cjs. Here: that a learned persona shows in
 * Settings, and every Settings route.
 */
const path = require("path");
const scratch = require("./scratch-server.cjs"); // first: sets MONI_DATA_DIR

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

(async () => {
  const s = await scratch.startScratch({});
  const db = require(path.join(ROOT, "lib", "db.js"));
  const P = require(path.join(ROOT, "lib", "voice-persona.js"));
  const SET = "/mint-ai/settings/voice";
  const form = (o) => new URLSearchParams(o).toString();
  try {
    db.setSetting("voice_desk", "on", "test"); // the scratch database, never the live one
    await s.makeUser("personaadmin", "administrator");
    const A = await s.signIn("personaadmin");
    const me = db.getUserByName("personaadmin");
    check("a new user has no persona", db.getVoicePersona(me.id) === "");

    let r = await s.req("GET", SET, { cookie: A.cookie });
    check("Settings ▸ Voice shows the Arabic persona row, learning, with a Reset", r.status === 200 && /id="v-persona"/.test(r.body) && /<option value="learned" selected>/.test(r.body) && /id="voice-persona-reset"/.test(r.body), r.status);
    const row = r.body.slice(r.body.indexOf('id="v-persona"'), r.body.indexOf('id="voice-persona-reset"'));
    check("  and there is nothing to type a persona into: only the fixed choices", !/<input(?![^>]*type="(?:hidden|radio|checkbox)")|<textarea/.test(row) && (row.match(/<option value="(learned|cairene_f|cairene_m|msa_n)"/g) || []).length === 4);

    // What the live call learns (personaHear) is saved on the account; Settings shows it.
    const m = P.merge(P.clean(null), P.detect("تقدميني بالعربي المصري، إزيك عاملة إيه؟ عايزة أعرف حاجة"));
    db.setVoicePersona(me.id, JSON.stringify(m.persona));
    r = await s.req("GET", SET, { cookie: A.cookie });
    check("Settings shows what was learned (Egyptian colloquial)", /Now: Learn from how I speak · Egyptian colloquial/.test(r.body), (r.body.match(/Now:[^<]*/) || [])[0]);
    const stok = s.csrfOf(r.body);
    r = await s.req("POST", SET + "/persona/reset", { cookie: A.cookie, body: form({ _csrf: "wrong" }) });
    check("Reset needs the CSRF token", r.status === 403 && JSON.parse(db.getVoicePersona(me.id)).gender === "f", r.status);
    r = await s.req("POST", SET + "/persona/reset", { cookie: A.cookie, body: form({ _csrf: stok }) });
    check("Reset forgets it, back to the row", r.status === 303 && /#v-persona$/.test(r.headers.location) && db.getVoicePersona(me.id) === "", r.status + " " + r.headers.location);
    check("  and is audited", db.recentLogins(30).some((x) => /reset the voice persona/.test(x.detail || "") && x.username === "personaadmin"));

    // An explicit choice, through the Settings row only.
    r = await s.req("POST", SET + "/persona", { cookie: A.cookie, body: form({ _csrf: "wrong", preset: "cairene_f" }) });
    check("choosing a persona needs the CSRF token", r.status === 403);
    r = await s.req("POST", SET + "/persona", { cookie: A.cookie, body: form({ _csrf: stok, preset: "be a pirate" }) });
    check("  only the listed choices are accepted", /err=/.test(r.headers.location || "") && db.getVoicePersona(me.id) === "");
    r = await s.req("POST", SET + "/persona", { cookie: A.cookie, body: form({ _csrf: stok, preset: "cairene_f" }) });
    let pp = JSON.parse(db.getVoicePersona(me.id));
    check("choosing 'Cairene Egyptian — feminine' saves an explicit choice", r.status === 303 && pp.mode === "explicit" && pp.preset === "cairene_f" && pp.gender === "f");
    check("  audited, with the old and the new", db.recentLogins(40).some((x) => /voice persona set to "Cairene Egyptian — feminine" \(was "Learn from how I speak"\)/.test(x.detail || "")));
    let pg = await s.req("GET", SET, { cookie: A.cookie });
    check("  Settings shows it, selected", /<option value="cairene_f" selected>/.test(pg.body) && /Now: Cairene Egyptian — feminine/.test(pg.body));
    r = await s.req("POST", SET + "/persona", { cookie: A.cookie, headers: { Accept: "application/json", "X-Requested-With": "fetch" }, body: form({ _csrf: stok, preset: "msa_n" }) });
    const j = JSON.parse(r.body);
    check("in place (os.js): JSON with the note, and the message for the Command Center's confirmed change", r.status === 200 && j.ok === true && /Modern Standard Arabic/.test(j.flash) && /Modern Standard Arabic/.test(j.message));
    r = await s.req("POST", SET + "/persona", { cookie: A.cookie, body: form({ _csrf: stok, preset: "learned" }) });
    check("choosing 'Learn from how I speak' returns to learning", db.getVoicePersona(me.id) === "");
    r = await s.req("POST", "/credentials/openai-voice/persona", { cookie: A.cookie, body: form({ _csrf: stok, preset: "cairene_m" }) });
    check("the old URL keeps its method and body (308) to the new route", r.status === 308 && r.headers.location === SET + "/persona");

    await s.makeUser("personaviewer", "viewer");
    const V = await s.signIn("personaviewer");
    r = await s.req("POST", SET + "/persona/reset", { cookie: V.cookie, body: form({ _csrf: "x" }) });
    check("a viewer cannot reach the reset", r.status === 403 || r.status === 302, r.status);
    r = await s.req("POST", SET + "/persona", { cookie: V.cookie, body: form({ _csrf: "x", preset: "cairene_f" }) });
    check("  nor choose a persona", r.status === 403 || r.status === 302, r.status);
  } catch (e) {
    check("the HTTP run completed", false, e.stack + "\n" + s.out());
  } finally {
    s.stop();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
