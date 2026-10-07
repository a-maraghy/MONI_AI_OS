"use strict";
/**
 * The voiceprint's routes (lib/voiceprint.js): the Settings ▸ Voice ▸
 * Voiceprint forms, and the guided enrolment page with its two calls.
 *
 *   POST /mint-ai/settings/voice/voiceprint             enabled=1|absent   On / Off
 *   POST /mint-ai/settings/voice/voiceprint/gate        gate=1|absent      Only respond to my voice
 *   POST /mint-ai/settings/voice/voiceprint/from-trial  slot               enrol from the trial's recordings
 *   POST /mint-ai/settings/voice/voiceprint/remove-mic  mic
 *   POST /mint-ai/settings/voice/voiceprint/delete                         the voiceprint
 *   POST /mint-ai/settings/voice/voiceprint/forget-all                     voiceprint, key, trial clips,
 *                                                                          results, ledger
 *   GET  /mint-ai/voiceprint/enrol                                         the page
 *   POST /mint-ai/api/voiceprint/enrol-clip?mic=&id=    audio/wav           embedded at once, never stored
 *   POST /mint-ai/api/voiceprint/enrol-save             {mic}
 *   GET  /mint-ai/api/voiceprint/enrol-status?mic=
 *
 * All of it needs moniai.use + voice.manage (the voice section's own rule) and
 * the CSRF token; every change is audited (login_log, outcome "voice"), counts
 * and names of microphones only.
 */
const vpLib = require("./voiceprint");

const SET = "/mint-ai/settings/voice/voiceprint";
const MAX_WAV = 44 + 40 * 24000 * 2 + 1024;

function mount(app, deps) {
  const { vprint, trialStore, trial, settingsGuard, reply, requireAuth, requirePerm, requireApiPerm, requireApiCsrf, rateLimit, express, db, ctx, views, asset } = deps;
  const audit = (req, line) => {
    try {
      db.logLogin(req.ip, req.me.username, "voice", line);
    } catch (_) {
      /* best effort */
    }
  };
  const on = (v) => v === "1" || v === "on" || v === true;

  app.post(SET, ...settingsGuard, (req, res) => {
    const want = on(req.body && req.body.enabled);
    const was = vprint.enabled();
    vprint.setEnabled(want, req.me.username);
    audit(req, `voiceprint ${want ? "on (watching; the gate is " + (vprint.gate() ? "on" : "off") + ")" : "off: no turn is checked"}${was === want ? " (unchanged)" : ""}`);
    reply(req, res, { msg: want ? "Voiceprint on. Turns are checked from the next one" + (vprint.gate() ? ", and only your voice is answered." : "; nothing is blocked (watching only).") : "Voiceprint off. Nothing is checked; your voiceprint is kept.", anchor: "v-voiceprint", reload: true });
  });

  app.post(SET + "/gate", ...settingsGuard, async (req, res) => {
    const want = on(req.body && req.body.gate);
    if (want && !vprint.enabled()) return reply(req, res, { err: "Switch the voiceprint on first.", anchor: "v-vp-gate" });
    if (want && !(await vprint.printFor(req.me))) return reply(req, res, { err: "Enrol your voiceprint first.", anchor: "v-vp-gate" });
    const was = vprint.gate();
    vprint.setGate(want, req.me.username);
    audit(req, `voiceprint: only respond to my voice ${want ? "on" : "off"}${was === want ? " (unchanged)" : ""}`);
    reply(req, res, { msg: want ? "Only your voice is answered from the next turn. Other voices are ignored; unsure turns are asked again." : "Back to watching only: every turn is answered, and checked.", anchor: "v-vp-gate", reload: true });
  });

  app.post(SET + "/from-trial", ...settingsGuard, async (req, res) => {
    const slot = String((req.body && req.body.slot) || "");
    if (!vpLib.MIC_RE.test(slot)) return reply(req, res, { err: "Which microphone?", anchor: "v-vp-enrol" });
    try {
      const r = await vprint.enrolFromTrial(req.me, slot);
      audit(req, `voiceprint enrolled from the trial recordings (${slot}, ${r.speech_s} s of speech)`);
      reply(req, res, { msg: `Voiceprint made from your trial recordings (${r.speech_s} s of speech). Turns are checked from the next one.`, anchor: "v-vp-enrol", reload: true });
    } catch (e) {
      reply(req, res, { err: e.status ? e.message : "The voiceprint could not be made: " + String(e.message).slice(0, 160), anchor: "v-vp-enrol" });
    }
  });

  app.post(SET + "/remove-mic", ...settingsGuard, async (req, res) => {
    const mic = String((req.body && req.body.mic) || "");
    if (!vpLib.MIC_RE.test(mic)) return reply(req, res, { err: "Which microphone?", anchor: "v-vp-enrol" });
    try {
      const done = await vprint.removeMic(req.me, mic);
      if (!(await vprint.printFor(req.me)) && vprint.gate()) vprint.setGate(false, req.me.username);
      audit(req, `voiceprint: removed the ${mic} microphone${done ? "" : " (it was not there)"}`);
      reply(req, res, { msg: done ? "Removed." : "That microphone was not in your voiceprint.", anchor: "v-vp-enrol", reload: true });
    } catch (e) {
      reply(req, res, { err: "Could not change the voiceprint: " + String(e.message).slice(0, 160), anchor: "v-vp-enrol" });
    }
  });

  app.post(SET + "/delete", ...settingsGuard, async (req, res) => {
    const had = await vprint.removePrint(req.me);
    if (vprint.gate()) vprint.setGate(false, req.me.username);
    audit(req, `voiceprint deleted${had ? "" : " (there was none)"}; only-my-voice off`);
    reply(req, res, { msg: had ? "Your voiceprint is deleted." : "There was no voiceprint.", anchor: "v-vp-enrol", reload: true });
  });

  app.post(SET + "/forget-all", ...settingsGuard, async (req, res) => {
    try {
      const r = await vprint.forgetAll(req.me);
      const clips = trialStore.removeAll(req.me);
      if (vprint.gate()) vprint.setGate(false, req.me.username);
      audit(req, `voiceprint: deleted everything (voiceprint ${r.print ? "yes" : "none"}, key ${r.key_deleted ? "deleted" : "kept"}, ${clips} trial clips, ${r.results_deleted} result folders, ${r.ledger_rows} check rows)`);
      reply(req, res, { msg: `Deleted: ${r.print ? "your voiceprint, " : ""}${clips} trial recordings, ${r.results_deleted} evaluation results, ${r.ledger_rows} check log rows${r.key_deleted ? ", and the sealing key" : ""}.`, anchor: "v-vp", reload: true });
    } catch (e) {
      reply(req, res, { err: "Not everything could be deleted: " + String(e.message).slice(0, 160), anchor: "v-vp" });
    }
  });

  /* ---- the guided enrolment ---- */

  const guard = [requireApiPerm("moniai.use"), requireApiPerm("voice.manage")];
  const uploads = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => "vpe-" + (req.me ? req.me.id : "anon"),
    validate: false,
    handler: (req, res) => res.status(429).json({ error: "Too many recordings at once. Wait a few minutes." }),
  });
  const raw = express.raw({ type: ["audio/wav", "audio/x-wav"], limit: MAX_WAV });

  app.get("/mint-ai/voiceprint/enrol", requireAuth, requirePerm("moniai.use"), requirePerm("voice.manage"), (req, res) => {
    res.set("Cache-Control", "no-store");
    res.send(views.page({ csrf: res.locals.csrf, user: ctx(req, "console"), paragraphs: trial.ENROL, slots: trial.SLOTS, worklet: asset("voice-live-worklet.js"), enabled: vprint.enabled(), enrolled: vprint.meta(req.me), minSeconds: vpLib.MIN_ENROL_MS / 1000 }));
  });

  app.get("/mint-ai/api/voiceprint/enrol-status", ...guard, (req, res) => {
    const mic = String(req.query.mic || "");
    if (!vpLib.MIC_RE.test(mic)) return res.status(400).json({ error: "Which microphone?" });
    res.set("Cache-Control", "no-store").json(vprint.pendingOf(req.me, mic));
  });

  app.post(
    "/mint-ai/api/voiceprint/enrol-clip",
    ...guard,
    requireApiCsrf,
    uploads,
    (req, res, next) => raw(req, res, (err) => (err ? res.status(err.status === 413 || err.type === "entity.too.large" ? 413 : 400).json({ error: "That recording is too long." }) : next())),
    async (req, res) => {
      const mic = String(req.query.mic || "");
      const id = String(req.query.id || "");
      if (!vpLib.MIC_RE.test(mic)) return res.status(400).json({ error: "Which microphone?" });
      if (!trial.ENROL.some((p) => p.id === id)) return res.status(400).json({ error: "Which paragraph?" });
      if (!vprint.enabled()) return res.status(409).json({ error: "The voiceprint is off. Switch it on in Settings ▸ Voice first." });
      let w;
      try {
        w = trial.parseWav(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      const seconds = w.samples.length / w.rate;
      if (seconds < 3 || seconds > 40) return res.status(400).json({ error: "A paragraph must be between 3 and 40 seconds." });
      if (trial.peakDb(w.samples) < -50) return res.status(400).json({ error: "Nothing was heard. Check the microphone and record again." });
      try {
        const r = await vprint.enrolClip(req.me, mic, id, Buffer.from(w.samples.buffer, w.samples.byteOffset, w.samples.length * 2), w.rate);
        res.json({ ok: true, id, mic, speech_s: Math.round(r.speech_ms / 100) / 10, total_s: Math.round(r.total_ms / 100) / 10, need_s: vpLib.MIN_ENROL_MS / 1000 });
      } catch (e) {
        res.status(e.status === 422 ? 400 : 503).json({ error: e.status === 422 ? "Not enough speech in that recording. Record it again." : "The voiceprint service is not answering; try again in a minute." });
      }
    }
  );

  app.post("/mint-ai/api/voiceprint/enrol-save", ...guard, requireApiCsrf, express.json({ limit: "4kb" }), async (req, res) => {
    const mic = String((req.body && req.body.mic) || "");
    if (!vpLib.MIC_RE.test(mic)) return res.status(400).json({ error: "Which microphone?" });
    try {
      const r = await vprint.enrolSave(req.me, mic, "enrol");
      audit(req, `voiceprint enrolled (${mic}, ${r.speech_s} s of speech; microphones: ${r.mics.join(", ")})`);
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : "The voiceprint could not be saved: " + String(e.message).slice(0, 160) });
    }
  });

}

module.exports = { mount, SET };
