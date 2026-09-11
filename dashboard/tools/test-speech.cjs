/** Exercises lib/speech.js the way the route does, without a browser. */
const path = require("path");
const speech = require(path.join(__dirname, "..", "lib", "speech.js"));

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "  " + extra : ""));
  if (!cond) fails++;
};

(async () => {
  ok("piper and at least one voice are installed", speech.available());
  const vs = speech.voices();
  ok("voices have names, labels and sample rates",
     vs.length > 0 && vs.every(v => v.name && v.label && v.rate > 0),
     vs.map(v => v.name + "@" + v.rate).join(", "));
  ok("a default voice is chosen", !!speech.defaultVoice(), speech.defaultVoice());

  const t0 = Date.now();
  const wav = await speech.speak("The dashboard is running and every service is healthy.");
  const ms = Date.now() - t0;
  ok("speak returns a buffer", Buffer.isBuffer(wav), wav.length + " bytes");
  ok("it is a RIFF/WAVE file",
     wav.slice(0, 4).toString() === "RIFF" && wav.slice(8, 12).toString() === "WAVE");
  const rate = wav.readUInt32LE(24), bits = wav.readUInt16LE(34), ch = wav.readUInt16LE(22);
  ok("header describes 16-bit mono at the voice's rate", bits === 16 && ch === 1 && rate > 0,
     rate + "Hz " + bits + "-bit " + ch + "ch");
  const dataLen = wav.readUInt32LE(40);
  ok("the declared data length matches the file", dataLen === wav.length - 44,
     dataLen + " vs " + (wav.length - 44));
  const seconds = dataLen / (rate * 2);
  ok("it is fast enough to speak while it thinks", seconds / (ms / 1000) >= 1.3,
     seconds.toFixed(2) + "s speech in " + (ms / 1000).toFixed(2) + "s = x" +
     (seconds / (ms / 1000)).toFixed(2) + " realtime");

  // Refusals
  for (const [name, arg] of [["empty text", ""], ["whitespace only", "   \n "]]) {
    let threw = false;
    try { await speech.speak(arg); } catch (_) { threw = true; }
    ok("refuses " + name, threw);
  }
  let threw = false;
  try { await speech.speak("x".repeat(speech.MAX_CHARS + 1)); } catch (_) { threw = true; }
  ok("refuses text past the length cap", threw);

  // An unknown voice falls back rather than failing the turn.
  const fb = await speech.speak("Fallback.", "en_US-nonexistent-medium");
  ok("an unknown voice falls back to the default", Buffer.isBuffer(fb) && fb.length > 44);

  // Concurrency: more requests than slots must all still complete.
  const many = await Promise.all(
    ["One.", "Two.", "Three.", "Four.", "Five."].map(t => speech.speak(t))
  );
  ok("five concurrent requests all return audio",
     many.every(b => Buffer.isBuffer(b) && b.length > 44));

  console.log(fails ? "\nFAILURES: " + fails : "\nALL SPEECH TESTS PASSED");
  process.exit(fails ? 1 : 0);
})();
