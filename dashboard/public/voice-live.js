/*
 * Live conversation (TRIAL): the page side, self-contained. See
 * lib/voice-live.js for the server and the README ("Live conversation") for
 * the integration contract any page can use:
 *
 *   VoiceLive.supported()            the browser can do it (getUserMedia + AudioWorklet + WebSocket)
 *   VoiceLive.start({ csrf, worklet, url?, duplex?, onState, onCaption, onLevel, onEvent }) -> Promise
 *   VoiceLive.stop(why?)             hang up; why (logged by the server): button,
 *                                    esc, mic, navigate, unload, track-ended,
 *                                    devicechange or error:<message>
 *   VoiceLive.mute(on) / .muted()    a hard mute: the microphone sends nothing
 *   VoiceLive.interrupt()            stop the voice now (a tap, Space or Esc)
 *   VoiceLive.duplex(mode?)          "speakers" (half-duplex: the microphone is
 *                                    not heard while the voice speaks) | "full"
 *                                    (headphones: talk over it)
 *   VoiceLive.active() / .state() / .speaking() / .route()
 *   VoiceLive.ack(nonce, ok, why)    answer a "ui" message (a screen action the voice asked for)
 *
 *   onState(state)     "connecting" | "listening" | "talking" | "thinking" |
 *                      "speaking" | "interrupted" | "waiting" | "muted" |
 *                      "ended" | "error"  ("waiting": working on a request, result pending)
 *   onCaption({who, text, final})   who: "you" | "desk" | "mint"
 *   onLevel({mic, out})             0..1-ish loudness, for the core
 *   onEvent(msg)                    every server message (asked, replied, stop, ended, error,
 *                                   reconnecting / reconnected: the upstream leg dropped and
 *                                   came back; restarting: the dashboard is restarting -- the
 *                                   call ends, and the page may start it again with
 *                                   {resume: "restart"}; mic-lost / mic-back)
 *
 * start({..., resume: "restart", lang: "ar"|"en"}) tells the server the call is
 * coming back after a restart, so the voice says it is back. The microphone's
 * track ending (unplugged, taken by another app) or a device change is caught:
 * the microphone is opened again once, and if that fails the call ends with
 * that reason. Leaving the page, the end reason also goes by navigator.sendBeacon.
 *
 * The microphone is opened with echo cancellation, noise suppression and
 * automatic gain; an AudioWorklet (voice-live-worklet.js, same origin) turns it
 * into 24 kHz PCM16 and streams it to this server's /mint-ai/api/live
 * WebSocket. What comes back is played through a second worklet that can be
 * flushed the moment the server says the administrator started talking; it
 * reports how many milliseconds of each segment were played, so the server
 * can cut the conversation exactly there. Nothing here talks to OpenAI.
 *
 * Echo-cancelled playback (2026-09-29: laptop speakers leaked into the
 * microphone and the voice interrupted itself). Chromium's echo canceller
 * does not reliably cover Web Audio output, only what WebRTC plays. So the
 * player's output goes into a MediaStream, through a local RTCPeerConnection
 * pair (loopback, never leaves the page) and plays from an <audio> element:
 * the canceller then knows it and removes it from the microphone. If that
 * cannot be set up, the player plays to the speakers directly ("direct").
 * The loopback adds its jitter buffer's delay, measured and subtracted from
 * the played milliseconds the server truncates at.
 *
 * The barge-in detector (voice-live-detect.js, loaded before this file) is fed
 * the microphone and output levels; its "on"/"off" go to the server, which
 * interrupts only when it and its own VAD agree.
 */
(function () {
  "use strict";
  var AC = window.AudioContext || window.webkitAudioContext;
  var S = null; // the running call
  var diag = (window.__mintLive = { calls: 0, frames: 0, bytesIn: 0, segs: 0, flushes: [], states: [], captions: [], played: 0, errors: [], route: "", lagMs: 0, voice: [], interrupts: 0, duplex: "" });
  var DUPLEX = { speakers: 1, full: 1 };

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
    S = { o: o, serverState: "connecting", shown: "", muted: false, playing: false, ended: false, flash: 0, anyAsked: false, ws: null, ctx: null, stream: null, cap: null, player: null, src: null, mic: 0, out: 0, lastPos: null,
      duplex: DUPLEX[o.duplex] ? o.duplex : "speakers", route: "", lagMs: 0, t0: performance.now(),
      det: window.MintLiveDetect ? window.MintLiveDetect.create() : null };
    var me = S;
    diag.duplex = S.duplex;
    paint();
    return navigator.mediaDevices
      .getUserMedia(MIC_OPTS)
      .then(function (stream) {
        if (me !== S) { stream.getTracks().forEach(function (t) { t.stop(); }); throw new Error("stopped"); }
        me.stream = stream;
        watchMic(me);
        me.ctx = new AC({ latencyHint: "interactive" });
        return me.ctx.audioWorklet.addModule(o.worklet || "/static/voice-live-worklet.js");
      })
      .then(function () {
        if (me !== S) throw new Error("stopped");
        var ctx = me.ctx;
        me.src = ctx.createMediaStreamSource(me.stream);
        me.cap = new AudioWorkletNode(ctx, "mint-live-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
        me.player = new AudioWorkletNode(ctx, "mint-live-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
        me.src.connect(me.cap);
        me.player.port.onmessage = function (e) { onPlayer(me, e.data || {}); };
        me.cap.port.onmessage = function (e) { onFrame(me, e.data || {}); };
        if (ctx.state === "suspended" && ctx.resume) ctx.resume();
        return o.direct ? false : loopback(me);
      })
      .then(function (ok) {
        if (me !== S) throw new Error("stopped");
        if (!ok) me.player.connect(me.ctx.destination);
        me.route = diag.route = ok ? "loopback" : "direct";
        return openSocket(me);
      })
      .catch(function (e) {
        if (me === S) fail(e && e.message === "stopped" ? "" : (e && e.name === "NotAllowedError" ? "The microphone was refused." : String((e && e.message) || e)));
        throw e;
      });
  }

  /* ---- the microphone going away: its track ended (unplugged, taken), or the devices changed ---- */

  var MIC_OPTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } };
  function micLive(me) {
    var t = me.stream && me.stream.getAudioTracks ? me.stream.getAudioTracks()[0] : null;
    return !!(t && t.readyState === "live");
  }
  function watchMic(me) {
    (me.stream.getAudioTracks ? me.stream.getAudioTracks() : []).forEach(function (t) {
      t.onended = function () { if (me === S) micLost(me, "track-ended"); };
    });
    if (!me.onDev && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      me.onDev = function () { if (me === S && !micLive(me)) micLost(me, "devicechange"); };
      navigator.mediaDevices.addEventListener("devicechange", me.onDev);
    }
  }
  /** The microphone is opened again, once per loss; if that fails the call ends with the reason. */
  function micLost(me, why) {
    if (me.reopening) return;
    me.reopening = true;
    diag.errors.push("mic: " + why);
    emit(me.o.onEvent, { type: "mic-lost", why: why });
    navigator.mediaDevices.getUserMedia(MIC_OPTS).then(function (stream) {
      me.reopening = false;
      if (me !== S || !me.ctx || !me.cap) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      try { if (me.src) me.src.disconnect(); } catch (e) { /* gone */ }
      if (me.stream) me.stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); });
      me.stream = stream;
      me.src = me.ctx.createMediaStreamSource(stream);
      me.src.connect(me.cap);
      watchMic(me);
      emit(me.o.onEvent, { type: "mic-back", why: why });
    }).catch(function () {
      me.reopening = false;
      if (me === S) stop(why);
    });
  }

  /* ---- echo-cancelled playback: player -> MediaStream -> local WebRTC loopback -> <audio> ---- */

  function noop() {}
  // Opus at a speech-friendly high bitrate, mono, with in-band FEC.
  function opusHi(sdp) {
    var m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp || "");
    if (!m) return sdp;
    var re = new RegExp("a=fmtp:" + m[1] + " ([^\\r\\n]*)");
    return re.test(sdp) ? sdp.replace(re, function (all, p) { return "a=fmtp:" + m[1] + " " + p + ";maxaveragebitrate=96000;stereo=0;usedtx=0"; }) : sdp;
  }
  function loopback(me) {
    if (!window.RTCPeerConnection || !me.ctx.createMediaStreamDestination) return Promise.resolve(false);
    var a, b, el, dest;
    function undo() {
      try { if (a) a.close(); } catch (e) { /* closed */ }
      try { if (b) b.close(); } catch (e) { /* closed */ }
      if (el) { el.srcObject = null; el.remove(); }
      try { if (dest) me.player.disconnect(dest); } catch (e) { /* not connected */ }
      return false;
    }
    try {
      dest = me.ctx.createMediaStreamDestination();
      a = new RTCPeerConnection();
      b = new RTCPeerConnection();
      el = document.createElement("audio");
      el.autoplay = true;
      el.setAttribute("playsinline", "");
      el.setAttribute("data-mint-live", "loopback");
      el.hidden = true;
      document.body.appendChild(el);
    } catch (e) {
      return Promise.resolve(undo());
    }
    a.onicecandidate = function (e) { if (e.candidate) b.addIceCandidate(e.candidate).catch(noop); };
    b.onicecandidate = function (e) { if (e.candidate) a.addIceCandidate(e.candidate).catch(noop); };
    b.ontrack = function (e) { el.srcObject = (e.streams && e.streams[0]) || new MediaStream([e.track]); };
    me.player.connect(dest);
    dest.stream.getAudioTracks().forEach(function (t) { a.addTrack(t, dest.stream); });
    var connected = new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error("loopback timeout")); }, 3000);
      b.oniceconnectionstatechange = function () {
        var st = b.iceConnectionState;
        if (st === "connected" || st === "completed") { clearTimeout(t); res(); }
        else if (st === "failed") { clearTimeout(t); rej(new Error("loopback failed")); }
      };
    });
    return a.createOffer()
      .then(function (off) { return a.setLocalDescription({ type: "offer", sdp: opusHi(off.sdp) }); })
      .then(function () { return b.setRemoteDescription(a.localDescription); })
      .then(function () { return b.createAnswer(); })
      .then(function (ans) { return b.setLocalDescription({ type: "answer", sdp: opusHi(ans.sdp) }); })
      .then(function () { return a.setRemoteDescription(b.localDescription); })
      .then(function () { return connected; })
      .then(function () {
        me.pcA = a;
        me.pcB = b;
        me.el = el;
        me.dest = dest;
        var p = el.play && el.play();
        if (p && p.catch) p.catch(function (e) { diag.errors.push("loopback play: " + (e && e.name)); });
        me.lagT = setInterval(function () { measureLag(me); }, 1000);
        return true;
      })
      .catch(function (e) {
        diag.errors.push("loopback: " + ((e && e.message) || e));
        return undo();
      });
  }
  /** The loopback's own delay (its jitter buffer), so the played milliseconds stay honest. */
  function measureLag(me) {
    if (!me.pcB || !me.pcB.getStats) return;
    me.pcB.getStats().then(function (rep) {
      rep.forEach(function (r) {
        if (r.type === "inbound-rtp" && r.kind === "audio" && r.jitterBufferEmittedCount) {
          me.lagMs = diag.lagMs = Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) + 20;
        }
      });
    }).catch(noop);
  }
  function heardMs(me, ms) {
    return me.route === "loopback" ? Math.max(0, (ms || 0) - (me.lagMs || 0)) : ms || 0;
  }

  function openSocket(me) {
    var o = me.o;
    var url = o.url || (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/mint-ai/api/live?csrf=" + encodeURIComponent(o.csrf || "") + "&duplex=" + me.duplex + "&route=" + me.route + (o.tab ? "&tab=" + encodeURIComponent(o.tab) : "") +
      (o.resume === "restart" ? "&resume=restart&lang=" + (o.lang === "ar" ? "ar" : "en") : "");
    return new Promise(function (resolve, reject) {
      var ws = (me.ws = new WebSocket(url));
      ws.binaryType = "arraybuffer";
      var opened = false, ready = false;
      var settle = function (err) { if (ready) return; ready = true; if (err) reject(err); else resolve(); };
      ws.onopen = function () { opened = true; };
      ws.onmessage = function (e) {
        if (me !== S) return;
        if (typeof e.data !== "string") return onAudio(me, e.data);
        var m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.type === "ready") me.callId = m.call || null;
        onMessage(me, m);
        if (m.type === "ready") settle();
        // Refused, or the server could not open its upstream, before the call was ready: start() fails, with the reason.
        if ((m.type === "error" || m.type === "ended") && !ready) settle(new Error(m.error || m.text || "The live conversation could not start (" + (m.code || m.why || "refused") + ")."));
      };
      ws.onerror = function () { if (!opened) settle(new Error("The live conversation could not connect.")); };
      ws.onclose = function (e) {
        if (me !== S) return;
        if (!ready) settle(new Error(opened ? "The live conversation closed before it was ready (" + (e.code || "closed") + ")." : "The live conversation was refused (" + (e.code || "closed") + ")."));
        end(me.endWhy || "closed", me.endText);
      };
    });
  }

  function onFrame(me, m) {
    if (m.type !== "frame") return;
    me.mic = m.level || 0;
    emit(me.o.onLevel, { mic: me.mic, out: me.out });
    if (me.det && !me.muted) {
      var t = performance.now() - me.t0;
      var v = me.det.mic(me.mic, t);
      if (v) {
        diag.voice.push({ v: v, t: Math.round(t) });
        if (me.ws && me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: "voice", on: v === "on" }));
      }
    }
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
      if (me.det) me.det.out(me.out, me.playing, performance.now() - me.t0);
      if (m.seg && me.ws && me.ws.readyState === 1 && (m.playing || was)) me.ws.send(JSON.stringify({ type: "played", seg: m.seg, ms: heardMs(me, m.ms) }));
      if (me.playing !== was) paint();
      diag.played = m.ms;
    } else if (m.type === "flushed") {
      var f = diag.flushes[diag.flushes.length - 1];
      if (f) { f.flushedAt = performance.now(); f.ms = m.ms; f.seg = m.seg; }
      if (me.ws && me.ws.readyState === 1) me.ws.send(JSON.stringify({ type: "flushed", seg: m.seg, ms: heardMs(me, m.ms) }));
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
        silenceTail(me);
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
        if (me.endWhy !== "restarting") me.endWhy = m.why || "ended";
        me.endText = m.text || me.endText || "";
        return;
      case "restarting":
        me.endWhy = "restarting";
        return;
      case "error":
        diag.errors.push(m.code || "error");
        return;
      case "duplex":
        if (DUPLEX[m.mode]) me.duplex = diag.duplex = m.mode;
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

  function end(why, text) {
    if (!S) return;
    var o = S.o;
    S.ended = true;
    paint();
    teardown();
    emit(o.onEvent, { type: "ended", why: why, text: text || undefined, local: true });
  }

  function teardown() {
    var me = S;
    S = null;
    if (!me) return;
    clearTimeout(me.flashT);
    clearTimeout(me.muteT);
    clearInterval(me.lagT);
    try { if (me.ws && me.ws.readyState <= 1) me.ws.close(1000, "hung up"); } catch (e) { /* closed */ }
    try { if (me.pcA) me.pcA.close(); } catch (e) { /* closed */ }
    try { if (me.pcB) me.pcB.close(); } catch (e) { /* closed */ }
    if (me.el) { try { me.el.pause(); } catch (e) { /* gone */ } me.el.srcObject = null; me.el.remove(); }
    if (me.dest) me.dest.stream.getTracks().forEach(function (t) { t.stop(); });
    try { if (me.src) me.src.disconnect(); } catch (e) { /* gone */ }
    try { if (me.cap) me.cap.disconnect(); } catch (e) { /* gone */ }
    try { if (me.player) me.player.disconnect(); } catch (e) { /* gone */ }
    if (me.stream) me.stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); });
    if (me.onDev && navigator.mediaDevices && navigator.mediaDevices.removeEventListener) navigator.mediaDevices.removeEventListener("devicechange", me.onDev);
    if (me.ctx && me.ctx.close) me.ctx.close().catch(function () {});
  }

  var END_WHY = /^(?:button|esc|mic|navigate|unload|track-ended|devicechange|voice-changed|error:.{0,80})$/;
  function stop(why) {
    if (!S) return;
    var w = END_WHY.test(String(why || "")) ? String(why) : "button";
    try { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "end", why: w })); } catch (e) { /* closed */ }
    // Leaving the page: the socket may not get its message out, the beacon does (the server logs it).
    if ((w === "unload" || w === "navigate") && S.callId && navigator.sendBeacon && S.o.csrf) {
      try { navigator.sendBeacon("/mint-ai/api/live/end", new Blob([JSON.stringify({ _csrf: S.o.csrf, call: S.callId, why: w })], { type: "application/json" })); } catch (e) { /* best effort */ }
    }
    end("hung-up");
  }

  function mute(on) {
    if (!S) return;
    S.muted = !!on;
    if (S.cap) S.cap.port.postMessage({ type: "mute", on: S.muted });
    try { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "mute", on: S.muted })); } catch (e) { /* closed */ }
    paint();
  }

  /** What the loopback still holds (its jitter buffer) is silenced at once, then it plays again. */
  function silenceTail(me) {
    if (!me.el) return;
    me.el.muted = true;
    clearTimeout(me.muteT);
    me.muteT = setTimeout(function () { if (me.el) me.el.muted = false; }, Math.max(150, (me.lagMs || 100) + 120));
  }

  /** Stop the voice now: a tap, Space or Esc (the only way in speakers mode). */
  function interrupt() {
    if (!S || !S.playing) return false;
    diag.interrupts++;
    silenceTail(S);
    S.player.port.postMessage({ type: "flush", at: Date.now() });
    try { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "interrupt" })); } catch (e) { /* closed */ }
    diag.flushes.push({ at: performance.now(), serverAt: 0, by: "tap" });
    return true;
  }

  function duplex(mode) {
    if (!S) return DUPLEX[mode] ? mode : "";
    if (DUPLEX[mode] && mode !== S.duplex) {
      S.duplex = diag.duplex = mode;
      try { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "duplex", mode: mode })); } catch (e) { /* closed */ }
    }
    return S.duplex;
  }

  window.VoiceLive = {
    supported: supported,
    start: start,
    stop: stop,
    mute: mute,
    interrupt: interrupt,
    duplex: duplex,
    ack: function (nonce, ok, why) {
      if (!S || !S.ws || S.ws.readyState !== 1 || !nonce) return;
      try { S.ws.send(JSON.stringify({ type: "ui-ack", nonce: String(nonce), ok: !!ok, why: why ? String(why).slice(0, 200) : undefined })); } catch (e) { /* closed */ }
    },
    /* The last screen action can still be undone for `ms` (0: no longer), so a spoken "undo" is caught. */
    undoable: function (ms) {
      if (!S || !S.ws || S.ws.readyState !== 1) return;
      try { S.ws.send(JSON.stringify({ type: "ui-undoable", ms: Math.max(0, Math.min(60000, Number(ms) || 0)) })); } catch (e) { /* closed */ }
    },
    speaking: function () { return !!(S && S.playing); },
    route: function () { return S ? S.route : ""; },
    muted: function () { return !!(S && S.muted); },
    active: function () { return !!S; },
    callId: function () { return S ? S.callId || null : null; },
    state: function () { return S ? S.shown : "idle"; },
  };
})();
