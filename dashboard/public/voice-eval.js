/*
 * The live voice evaluation page (/mint-ai/voice-eval): record each phrase as
 * PCM16 mono 24 kHz (the live conversation's own capture worklet), upload it,
 * run the comparison and show the table. See lib/voice-live-eval.js.
 */
(function () {
  "use strict";
  var root = document.getElementById("ve");
  if (!root) return;
  var CSRF = root.getAttribute("data-csrf") || "";
  var WORKLET = root.getAttribute("data-worklet") || "/static/voice-live-worklet.js";
  var AC = window.AudioContext || window.webkitAudioContext;
  var rec = null; // {id, ctx, stream, node, frames}

  function $(s, el) { return (el || document).querySelector(s); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function api(path, body) {
    var o = { method: body ? "POST" : "GET", headers: { Accept: "application/json" }, credentials: "same-origin" };
    if (body) { o.headers["Content-Type"] = "application/json"; o.headers["X-CSRF-Token"] = CSRF; o.body = JSON.stringify(body); }
    return fetch("/mint-ai/api/voice-eval/" + path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; });
    });
  }
  function state(id, text) { var s = $('[data-state="' + id + '"]'); if (s) s.textContent = text; }

  function wav(int16) {
    var b = new ArrayBuffer(44 + int16.length * 2), v = new DataView(b);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, "RIFF"); v.setUint32(4, 36 + int16.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 24000, true);
    v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, int16.length * 2, true);
    new Int16Array(b, 44).set(int16);
    return b;
  }
  function b64(buf) {
    var u = new Uint8Array(buf), s = "", i;
    for (i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function start(id) {
    if (!AC || !window.AudioWorkletNode) { state(id, "this browser cannot record here"); return; }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
      .then(function (stream) {
        var ctx = new AC();
        return ctx.audioWorklet.addModule(WORKLET).then(function () {
          var node = new AudioWorkletNode(ctx, "mint-live-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
          rec = { id: id, ctx: ctx, stream: stream, node: node, frames: [] };
          node.port.onmessage = function (e) { if (e.data && e.data.type === "frame" && rec) rec.frames.push(new Int16Array(e.data.pcm)); };
          ctx.createMediaStreamSource(stream).connect(node);
          $('[data-rec="' + id + '"]').textContent = "Stop";
          state(id, "recording… say the phrase, then Stop");
        });
      })
      .catch(function () { state(id, "the microphone was refused"); });
  }
  function stop() {
    var r = rec;
    rec = null;
    if (!r) return;
    r.stream.getTracks().forEach(function (t) { t.stop(); });
    r.ctx.close();
    $('[data-rec="' + r.id + '"]').textContent = "Record again";
    var n = r.frames.reduce(function (a, f) { return a + f.length; }, 0), all = new Int16Array(n), at = 0;
    r.frames.forEach(function (f) { all.set(f, at); at += f.length; });
    state(r.id, "saving…");
    api("clip", { id: r.id, data: b64(wav(all)) })
      .then(function (j) { state(r.id, "recorded · " + j.seconds + " s"); $('[data-play="' + r.id + '"]').hidden = false; })
      .catch(function (e) { state(r.id, e.message); });
  }
  root.addEventListener("click", function (e) {
    var b = e.target.closest("[data-rec]");
    if (b) {
      var id = Number(b.getAttribute("data-rec"));
      if (rec && rec.id === id) return stop();
      if (rec) stop();
      return start(id);
    }
    var p = e.target.closest("[data-play]");
    if (p) {
      fetch("/mint-ai/api/voice-eval/clip/" + p.getAttribute("data-play"), { credentials: "same-origin" }).then(function (r) { return r.blob(); }).then(function (bl) {
        var a = new Audio(URL.createObjectURL(bl));
        a.play();
      });
    }
  });

  function f(n, d) { return n == null ? "—" : Number(n).toFixed(d || 0); }
  function render(last) {
    var el = $("#ve-results");
    if (!last || !last.summary) return;
    var h = '<p class="muted small">Run of ' + esc(last.at) + " · " + esc(last.models.join(", ")) + " · " + esc(last.voices.join(", ")) + "</p>";
    h += '<div class="ve-table-wrap"><table class="ve-table"><thead><tr><th>Model · voice</th><th>Clips</th><th>First audio (median ms)</th><th>Hold (ms)</th><th>CER session</th><th>CER full turn</th><th>Guard cuts</th><th>Hand-offs right</th><th>Stops right</th><th>Dialect right</th><th>$ / clip</th><th>$ total</th></tr></thead><tbody>';
    last.summary.forEach(function (r) {
      h += "<tr><td>" + esc(r.config) + "</td><td>" + r.clips + (r.errors ? " (" + r.errors + " failed)" : "") + "</td><td>" + f(r.first_audio_ms_median) + "</td><td>" + f(r.hold_ms_median) + "</td><td>" + f(r.cer_session, 3) + "</td><td>" + f(r.cer_turn, 3) + "</td><td>" + r.guard_cuts + "</td><td>" + (r.handoffs_right == null ? "—" : r.handoffs_right + "%") + "</td><td>" + (r.stops_right == null ? "—" : r.stops_right + "%") + "</td><td>" + (r.dialect_ok == null ? "—" : r.dialect_ok + "%") + "</td><td>$" + f(r.usd_per_clip, 4) + "</td><td>$" + f(r.usd_total, 4) + "</td></tr>";
    });
    h += "</tbody></table></div><details class=\"ve-detail\"><summary>Per phrase</summary><ul>";
    (last.results || []).forEach(function (r) {
      h += "<li><b>#" + r.id + "</b> " + esc(r.model) + " · " + esc(r.voice) + " — " + esc(r.dialect_note) + (r.trips && r.trips.length ? " · cut: " + esc(r.trips.join(", ")) : "") + (r.handoff ? " · handed off" : "") + (r.stopped ? " · stopped" : "") + '<br><span class="muted small" dir="auto">heard: ' + esc(r.turn_text || r.session_text) + '</span><br><span class="small" dir="auto">said: ' + esc(r.reply || "—") + "</span></li>";
    });
    el.innerHTML = h + "</ul></details>";
  }
  var poll = 0;
  function refresh() {
    return api("status").then(function (s) {
      (s.clips || []).forEach(function (id) { state(id, "recorded"); var p = $('[data-play="' + id + '"]'); if (p) p.hidden = false; var b = $('[data-rec="' + id + '"]'); if (b) b.textContent = "Record again"; });
      var j = s.job;
      $("#ve-progress").textContent = j && j.running ? "running " + j.done + " of " + j.total + "…" : j && j.error ? "failed: " + j.error : "";
      $("#ve-run").disabled = !!(j && j.running);
      if (j && j.running && !poll) poll = setInterval(refresh, 2000);
      if (!(j && j.running) && poll) { clearInterval(poll); poll = 0; }
      render(s.last);
    }).catch(function (e) { $("#ve-progress").textContent = e.message; });
  }
  $("#ve-run").addEventListener("click", function () {
    var pick = function (n) { return Array.prototype.map.call(root.querySelectorAll('input[name="' + n + '"]:checked'), function (i) { return i.value; }); };
    api("run", { models: pick("model"), voices: pick("voice") }).then(refresh).catch(function (e) { $("#ve-progress").textContent = e.message; });
  });
  refresh();
})();
