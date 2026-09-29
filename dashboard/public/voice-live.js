/*
 * Live conversation (TRIAL): the page side, self-contained. See
 * lib/voice-live.js for the server and the README ("Live conversation") for
 * the integration contract any page can use:
 *
 *   VoiceLive.supported()            the browser can do it (getUserMedia + AudioWorklet + WebSocket)
 *   VoiceLive.start({ csrf, worklet, url?, onState, onCaption, onLevel, onEvent }) -> Promise
 *   VoiceLive.stop()                 hang up
 *   VoiceLive.mute(on) / .muted()    a hard mute: the microphone sends nothing
 *   VoiceLive.active() / .state()
 *
 *   onState(state)     "connecting" | "listening" | "talking" | "thinking" |
 *                      "speaking" | "interrupted" | "waiting" | "muted" |
 *                      "ended" | "error"  ("waiting": passed to MINT AI)
 *   onCaption({who, text, final})   who: "you" | "desk" | "mint"
 *   onLevel({mic, out})             0..1-ish loudness, for the core
 *   onEvent(msg)                    every server message (asked, replied, stop, ended, error)
 *
 * The microphone is opened with echo cancellation, noise suppression and
 * automatic gain; an AudioWorklet (voice-live-worklet.js, same origin) turns it
 * into 24 kHz PCM16 and streams it to this server's /mint-ai/api/live
 * WebSocket. What comes back is played through a second worklet that can be
 * flushed the moment the server says the administrator started talking; it
 * reports how many milliseconds of each segment were played, so the server
 * can cut the conversation exactly there. Nothing here talks to OpenAI.
 */
(function () {
  "use strict";
  var AC = window.AudioContext || window.webkitAudioContext;
  var S = null; // the running call
  var diag = (window.__mintLive = { calls: 0, frames: 0, bytesIn: 0, segs: 0, flushes: [], states: [], captions: [], played: 0, errors: [] });

  function supported() {
    return !!(AC && window.AudioWorkletNode && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebSocket);
  }

  function emit(fn, v) {
    try { if (fn) fn(v); } catch (e) { diag.errors.push(String(e && e.message)); }
  }

  function setState(st) {
    if (!S) return;
    // "speaking" is decided here, from what is really playing.
    S.serverState = st;
    paint();
  }
  function paint() {
    if (!S) return;
    var st;
    if (S.ended) st = "ended";
    else if (S.muted) st = "muted";
    else if (S.flash) st = "interrupted";
    else if (S.serverState === "talking") st = "talking";
    else if (S.playing) st = "speaking";
    else if (S.serverState === "speaking") st = S.anyAsked ? "waiting" : "listening"; // it finished playing
    else st = S.serverState;
    if (st === S.shown) return;
    S.shown = st;
    diag.states.push(st);
    emit(S.o.onState, st);
  }

  function start(o) {
    if (S) return Promise.resolve();
    if (!supported()) return Promise.reject(new Error("This browser cannot hold a live conversation (no AudioWorklet or microphone)."));
    o = o || {};
    diag.calls++;
    S = { o: o, serverState: "connecting", shown: "", muted: false, playing: false, ended: false, flash: 0, anyAsked: false, ws: null, ctx: null, stream: null, cap: null, player: null, src: null, mic: 0, out: 0, lastPos: null };
    var me = S;
    paint();
    return navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
      .then(function (stream) {
        if (me !== S) { stream.getTracks().forEach(function (t) { t.stop(); }); throw new Error("stopped"); }
        me.stream = stream;
        me.ctx = new AC({ latencyHint: "interactive" });
        return me.ctx.audioWorklet.addModule(o.worklet || "/static/voice-live-worklet.js");
      })
      .then(function () {
        if (me !== S) throw new Error("stopped");
        var ctx = me.ctx;
        me.src = ctx.createMediaStreamSource(me.stream);
        me.cap = new AudioWorkletNode(ctx, "mint-live-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
        me.player = new AudioWorkletNode(ctx, "mint-live-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
        me.player.connect(ctx.destination);
        me.src.connect(me.cap);
        me.player.port.onmessage = function (e) { onPlayer(me, e.data || {}); };
        me.cap.port.onmessage = function (e) { onFrame(me, e.data || {}); };
        if (ctx.state === "suspended" && ctx.resume) ctx.resume();
        return openSocket(me);
      })
      .catch(function (e) {
        if (me === S) fail(e && e.message === "stopped" ? "" : (e && e.name === "NotAllowedError" ? "The microphone was refused." : String((e && e.message) || e)));
        throw e;
      });
  }

  function openSocket(me) {
    var o = me.o;
    var url = o.url || (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/mint-ai/api/live?csrf=" + encodeURIComponent(o.csrf || "");
    return new Promise(function (resolve, reject) {
      var ws = (me.ws = new WebSocket(url));
      ws.binaryType = "arraybuffer";
      var opened = false;
      ws.onopen = function () { opened = true; };
      ws.onmessage = function (e) {
        if (me !== S) return;
        if (typeof e.data !== "string") return onAudio(me, e.data);
        var m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        onMessage(me, m);
        if (m.type === "ready") resolve();
        if (m.type === "error" && !opened) reject(new Error(m.error || "refused"));
      };
      ws.onerror = function () { if (!opened) reject(new Error("The live conversation could not connect.")); };
      ws.onclose = function (e) {
        if (me !== S) return;
        if (!opened) reject(new Error("The live conversation was refused (" + (e.code || "closed") + ")."));
        end(me.endWhy || "closed");
      };
    });
  }

  function onFrame(me, m) {
    if (m.type !== "frame") return;
    me.mic = m.level || 0;
    emit(me.o.onLevel, { mic: me.mic, out: me.out });
    if (me.muted || !me.ws || me.ws.readyState !== 1) return;
    me.ws.send(m.pcm);
    diag.frames++;
    diag.bytesIn += m.pcm.byteLength;
  }

  function onAudio(me, buf) {
    if (buf.byteLength < 6) return;
    var seg = new DataView(buf).getUint32(0, true);
    var pcm = buf.slice(4);
    me.player.port.postMessage({ type: "push", seg: seg, pcm: pcm }, [pcm]);
    me.playing = true;
    paint();
  }

  function onPlayer(me, m) {
    if (m.type === "pos") {
      me.out = m.level || 0;
      emit(me.o.onLevel, { mic: me.mic, out: me.out });
      var was = me.playing;
      me.playing = !!m.playing;
      if (m.seg && me.ws && me.ws.readyState === 1 && (m.playing || was)) me.ws.send(JSON.stringify({ type: "played", seg: m.seg, ms: m.ms }));
      if (me.playing !== was) paint();
      diag.played = m.ms;
    } else if (m.type === "flushed") {
      var f = diag.flushes[diag.flushes.length - 1];
      if (f) { f.flushedAt = performance.now(); f.ms = m.ms; f.seg = m.seg; }
      if (me.ws && me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: "flushed", seg: m.seg, ms: m.ms }));
      me.playing = false;
      paint();
    }
  }

  function onMessage(me, m) {
    emit(me.o.onEvent, m);
    switch (m.type) {
      case "state":
        return setState(m.state);
      case "seg":
        diag.segs++;
        return;
      case "cut":
        me.player.port.postMessage({ type: "drop", seg: m.seg });
        return;
      case "flush":
        // The administrator started talking: drop what is buffered, at once.
        diag.flushes.push({ at: performance.now(), serverAt: m.at });
        me.player.port.postMessage({ type: "flush", at: m.at });
        me.flash = 1;
        paint();
        clearTimeout(me.flashT);
        me.flashT = setTimeout(function () { me.flash = 0; paint(); }, 700);
        return;
      case "caption":
        diag.captions.push({ who: m.who, text: m.text });
        return emit(me.o.onCaption, { who: m.who, text: m.text, final: m.final !== false });
      case "asked":
        me.anyAsked = true;
        return;
      case "replied":
        me.anyAsked = false;
        return;
      case "stop":
        me.endWhy = "voice-command";
        return;
      case "ended":
        me.endWhy = m.why || "ended";
        return;
      case "error":
        diag.errors.push(m.code || "error");
        return;
      default:
        return;
    }
  }

  function fail(why) {
    if (!S) return;
    if (why) diag.errors.push(why);
    var o = S.o;
    teardown();
    emit(o.onState, "error");
    emit(o.onEvent, { type: "error", error: why });
  }

  function end(why) {
    if (!S) return;
    var o = S.o;
    S.ended = true;
    paint();
    teardown();
    emit(o.onEvent, { type: "ended", why: why });
  }

  function teardown() {
    var me = S;
    S = null;
    if (!me) return;
    clearTimeout(me.flashT);
    try { if (me.ws && me.ws.readyState <= 1) me.ws.close(1000, "hung up"); } catch (e) { /* closed */ }
    try { if (me.src) me.src.disconnect(); } catch (e) { /* gone */ }
    try { if (me.cap) me.cap.disconnect(); } catch (e) { /* gone */ }
    try { if (me.player) me.player.disconnect(); } catch (e) { /* gone */ }
    if (me.stream) me.stream.getTracks().forEach(function (t) { t.stop(); });
    if (me.ctx && me.ctx.close) me.ctx.close().catch(function () {});
  }

  function stop() {
    if (!S) return;
    try { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "end" })); } catch (e) { /* closed */ }
    end("hung-up");
  }

  function mute(on) {
    if (!S) return;
    S.muted = !!on;
    if (S.cap) S.cap.port.postMessage({ type: "mute", on: S.muted });
    try { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "mute", on: S.muted })); } catch (e) { /* closed */ }
    paint();
  }

  window.VoiceLive = {
    supported: supported,
    start: start,
    stop: stop,
    mute: mute,
    muted: function () { return !!(S && S.muted); },
    active: function () { return !!S; },
    state: function () { return S ? S.shown : "idle"; },
  };
})();
