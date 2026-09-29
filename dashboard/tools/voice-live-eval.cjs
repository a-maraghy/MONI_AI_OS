#!/usr/bin/env node
"use strict";
/**
 * The live conversation's Egyptian evaluation from the command line
 * (lib/voice-live-eval.js; the page /mint-ai/voice-eval does the same after
 * recording the administrator's own voice).
 *
 *   sudo NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/voice-live-eval.cjs --dir <folder> [--models a,b] [--voices marin,cedar] [--out report.md]
 *       <folder> holds clip-01.wav .. clip-20.wav (PCM16 mono 24 kHz), one per
 *       phrase of PHRASES by number -- e.g. the page's saved recordings,
 *       /var/lib/moni-dashboard/voice-eval/<user id>/.
 *
 *   sudo NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/voice-live-eval.cjs --self-test [--n 3]
 *       the minimal self-test: n phrases made with gpt-4o-mini-tts (not a
 *       voice anyone should judge dialect by), through every model and voice,
 *       to prove the harness works end to end.
 *
 * A stubbed supervisor: nothing reaches MINT AI. The key is read through the
 * helper (voice-key-read) into memory and never printed. Costs a few cents per
 * clip per model (see the $ columns).
 */
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ev = require(path.join(ROOT, "lib", "voice-live-eval.js"));
const voice = require(path.join(ROOT, "lib", "voice.js"));
const VoiceStop = require(path.join(ROOT, "public", "voice-stop.js"));

const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};

function key() {
  const raw = execFileSync("/usr/local/sbin/moni-helper", ["voice-key-read"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  const k = JSON.parse(raw).data.key;
  if (!k) throw new Error("no OpenAI key is set");
  return k;
}

async function tts(k, text, lang) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: "Bearer " + k, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "ash",
      input: text,
      response_format: "pcm",
      instructions: lang === "english" ? undefined : lang === "msa" ? "Speak Modern Standard Arabic, clearly." : "Speak natural Egyptian Arabic (Cairene); say the English words in English.",
    }),
  });
  if (!r.ok) throw new Error("tts " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

(async () => {
  const k = key();
  const models = (arg("--models", "") || "").split(",").filter(Boolean);
  const voices = (arg("--voices", "") || "").split(",").filter(Boolean);
  let clips = [];
  if (args.includes("--self-test")) {
    const n = Math.min(3, Number(arg("--n", "3")) || 3);
    const pick = [10, 3, 14].slice(0, n).map((id) => ev.PHRASES.find((p) => p.id === id));
    for (const p of pick) clips.push({ phrase: p, pcm: await tts(k, p.text, p.lang) });
    console.log(`self-test: ${clips.length} TTS clips (${pick.map((p) => "#" + p.id).join(", ")})`);
  } else {
    const dir = arg("--dir");
    if (!dir) throw new Error("--dir <folder> or --self-test");
    for (const p of ev.PHRASES) {
      const f = path.join(dir, "clip-" + String(p.id).padStart(2, "0") + ".wav");
      if (fs.existsSync(f)) clips.push({ phrase: p, pcm: ev.readWav(fs.readFileSync(f)) });
    }
    if (!clips.length) throw new Error("no clip-NN.wav in " + dir);
  }
  const t0 = Date.now();
  const out = await ev.evaluate({
    clips,
    models: models.length ? models : undefined,
    voices: voices.length ? voices : undefined,
    concurrency: 2,
    deps: { key: k, speak: voice.speakStream, transcribe: voice.transcribeFull, isStop: (t) => VoiceStop.heard(t) },
    onProgress: (p) => process.stdout.write(`\r${p.done}/${p.total} ${p.last.model} ${p.last.voice} #${p.last.id}${p.last.error ? " ERROR " + p.last.error : ""}      `),
  });
  console.log("\n");
  const md =
    `# Live conversation evaluation (${new Date().toISOString()})\n\n${clips.length} clips, ${Math.round((Date.now() - t0) / 1000)} s.\n\n` +
    ev.tableMarkdown(out.summary) +
    "\n\n## Per clip\n\n" +
    out.results
      .map((r) => `- #${r.id} ${r.kind}/${r.lang} · ${r.model} · ${r.voice}: first audio ${r.first_audio_ms ?? "—"} ms, CER ${r.cer_session}/${r.cer_turn ?? "—"}, ${r.trips.length ? "cut: " + r.trips.join(",") : "no cut"}, ${r.handoff ? "handed off" : "no hand-off"}${r.stopped ? ", stopped" : ""}, ${r.dialect_note}, $${r.usd.toFixed(4)}${r.error ? " ERROR " + r.error : ""}\n  heard: ${JSON.stringify(r.turn_text || r.session_text)}\n  said: ${JSON.stringify(r.reply || "")}`)
      .join("\n");
  console.log(md);
  const o = arg("--out");
  if (o) {
    fs.writeFileSync(o, md);
    fs.writeFileSync(o.replace(/\.md$/, "") + ".json", JSON.stringify(out, null, 1));
  }
})().catch((e) => {
  console.error(String(e.message || e).replace(/sk-[A-Za-z0-9_\-]+/g, "sk-***"));
  process.exit(1);
});
