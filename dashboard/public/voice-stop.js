"use strict";
/*
 * "Stop listening", said aloud: the spoken command that closes the mic.
 *
 * In hands-free the mic stays open and a pause sends what was said, so the
 * only way out used to be a click. Now saying "stop listening", "close the
 * live session", "وقف الاستماع", "اقفل ال live session" and the like closes it
 * too -- exactly as the mic button would -- and the words are not sent.
 *
 * Only when the whole utterance is the command. "Why did the service stop
 * listening on port 80" is a question, and is sent as one: the text is
 * normalised (case, punctuation, Arabic letter forms), a few polite words
 * around it are allowed ("okay", "please", "خلاص", "يا مينت"), and what is
 * left must be one of the phrases below, word for word.
 *
 * Loaded on every page before console.js and moni-ai.js (window.VoiceStop),
 * and required by the server for the voice front desk, which hears the words
 * itself (module.exports). Pure: no DOM, no state.
 */
var VoiceStop = (function () {
  // Verbs x objects, English then Egyptian Arabic, all already normalised
  // (lowercase; alef, ya and ta marbuta in one form each -- see norm()).
  var EN_VERBS = ["stop", "close", "end", "quit", "exit", "pause", "turn off", "switch off", "shut off"];
  var EN_OBJECTS = [
    "listening", "listen", "the listening",
    "live", "the live", "live session", "the live session", "live mode", "the live mode",
    "hands free", "the hands free", "hands free mode",
    "the mic", "mic", "the microphone", "microphone",
  ];
  var AR_VERBS = ["وقف", "اوقف", "قفل", "اقفل", "سكر", "بطل", "انهي", "اطفي"];
  var AR_OBJECTS = [
    "الاستماع", "استماع", "السماع",
    "اللايف", "ال لايف", "لايف", "اللايف سيشن", "ال لايف سيشن", "لايف سيشن",
    "ال live", "ال live session", "live", "live session", "الجلسه المباشره",
    "المايك", "الميك", "المايكروفون", "الميكروفون",
  ];
  // Whole commands that are not verb + object.
  var EXTRA = [
    "stop listening now", "you can stop listening", "stop listening to me",
    "mic off", "microphone off", "listening off", "live off", "hands free off",
    "بطل تسمع", "كفايه استماع", "خلاص كده اقفل",
  ];
  // Allowed around the command, never on their own.
  var LEAD = ["ok", "okay", "alright", "all right", "please", "hey mint", "mint ai", "mint", "moni", "so", "now",
    "خلاص", "طيب", "يا مينت", "مينت", "من فضلك", "لو سمحت"];
  var TAIL = ["please", "for now", "now", "thanks", "thank you", "mint", "mint ai",
    "خلاص", "من فضلك", "لو سمحت", "دلوقتي", "شكرا", "يا مينت"];
  // A request: one of these, once, right before a whole command ("can you
  // stop listening", "عايزك تقفل اللايف"). Longest first. "ممكن ت" is the
  // prefix written apart ("ممكن تـ قفل" once normalised); written onto the
  // verb it is the second-person form below.
  var ASK = ["can you please", "could you please", "would you please", "will you please",
    "can you", "could you", "would you", "will you", "i want you to", "i need you to",
    "ممكن ت", "ممكن", "عايزك", "عاوزك", "محتاجك", "يا ريت", "ياريت"];
  // After a request, Arabic uses the verb's second-person form: تقفل, توقف...
  var AR_ASKED_VERBS = ["توقف", "تقفل", "تسكر", "تبطل", "تنهي", "تطفي"];
  // Longer than this after normalising, it is a sentence, not a command.
  var MAX_WORDS = 9;

  var PHRASES = {};
  function add(p) { PHRASES[p] = true; }
  EN_VERBS.forEach(function (v) { EN_OBJECTS.forEach(function (o) { add(v + " " + o); }); });
  AR_VERBS.forEach(function (v) { AR_OBJECTS.forEach(function (o) { add(v + " " + o); }); });
  EXTRA.forEach(add);
  // Only after a request (ASK): "ممكن تقفل الاستماع", "عايزك تبطل تسمع".
  var ASKED = {};
  AR_ASKED_VERBS.forEach(function (v) { AR_OBJECTS.forEach(function (o) { ASKED[v + " " + o] = true; }); });
  ASKED["تبطل تسمع"] = true;

  /**
   * Lowercase; Arabic diacritics and tatweel out; alef forms to ا, ى to ي,
   * ة to ه, ؤ to و, ئ to ي; Arabic and Latin letters that touch are split;
   * hyphens joining words become spaces; anything else that is not a Latin
   * or Arabic letter or digit goes; spaces squeezed.
   */
  function norm(text) {
    return String(text == null ? "" : text)
      .toLowerCase()
      .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
      .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
      .replace(/\u0649/g, "\u064A")
      .replace(/\u0629/g, "\u0647")
      .replace(/\u0624/g, "\u0648")
      .replace(/\u0626/g, "\u064A")
      // "al-" written onto an English word ("الـlive"): split them
      .replace(/([\u0621-\u064A])([a-z])/g, "$1 $2")
      .replace(/([a-z])([\u0621-\u064A])/g, "$1 $2")
      .replace(/[^a-z0-9\u0621-\u064A\u0660-\u0669]+/g, " ")
      .replace(/^ +| +$/g, "");
  }

  function strip(s, words, atEnd) {
    for (var again = true; again && s;) {
      again = false;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (atEnd ? s.slice(-(w.length + 1)) === " " + w : s.slice(0, w.length + 1) === w + " ") {
          s = atEnd ? s.slice(0, -(w.length + 1)) : s.slice(w.length + 1);
          again = true;
        }
      }
    }
    return s;
  }

  /** True when what was said is the stop command and nothing more. */
  function heard(text) {
    var s = norm(text);
    if (!s || s.split(" ").length > MAX_WORDS) return false;
    if (PHRASES[s]) return true;
    s = strip(strip(s, LEAD, false), TAIL, true);
    if (PHRASES[s]) return true;
    // "Can you stop listening": one request, then the whole command.
    for (var i = 0; i < ASK.length; i++) {
      if (s.slice(0, ASK[i].length + 1) === ASK[i] + " ") {
        var rest = s.slice(ASK[i].length + 1);
        return !!(PHRASES[rest] || ASKED[rest]);
      }
    }
    return false;
  }

  return {
    heard: heard, norm: norm,
    phrases: function () { return Object.keys(PHRASES); },
    asked: function () { return Object.keys(ASKED); },
    requests: function () { return ASK.slice(); },
  };
})();
if (typeof module === "object" && module.exports) module.exports = VoiceStop;
