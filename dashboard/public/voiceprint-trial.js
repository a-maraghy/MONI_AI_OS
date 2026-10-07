/*
 * The voiceprint trial's recording page (/mint-ai/voiceprint-trial; see
 * lib/voiceprint-trial.js). Records each phrase with the live conversation's
 * own capture worklet and microphone settings (24 kHz PCM16, echo
 * cancellation, noise suppression and auto gain on), on the microphone picked
 * here, and uploads it as a WAV; the server resamples it to 16 kHz.
 */
(function () {
  "use strict";
  var root = document.getElementById("vp");
  if (!root) return;
  var CSRF = root.getAttribute("data-csrf") || "";
  var WORKLET = root.getAttribute("data-worklet") || "/static/voice-live-worklet.js";
  var TOTAL = Number(root.getAttribute("data-total")) || 0;
  var AC = window.AudioContext || window.webkitAudioContext;
  var rec = null; // {id, ctx, stream, node, frames, timer, max}
  var status = null;

  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function slot() { return $("#vp-slot").value; }
  function deviceSel() { return $("#vp-device"); }
  function state(id, text, cls) {
    var s = $('[data-state="' + id + '"]');
    if (s) { s.textContent = text; s.className = "vp-state small " + (cls || "muted"); }
  }
  function api(path, opts) {
    var o = Object.assign({ credentials: "same-origin", headers: {} }, opts || {});
    o.headers.Accept = "application/json";
    if (o.method && o.method !== "GET") o.headers["X-CSRF-Token"] = CSRF;
    return fetch("/mint-ai/api/voiceprint-trial/" + path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; });
    });
  }

  function wav(int16) {
    var b = new ArrayBuffer(44 + int16.length * 2), v = new DataView(b);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, "RIFF"); v.setUint32(4, 36 + int16.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 24000, true);
    v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, int16.length * 2, true);
    new Int16Array(b, 44).set(int16);
    return b;
  }

  /* --- the microphone list ------------------------------------------- */
  function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve();
    return navigator.mediaDevices.enumerateDevices().then(function (ds) {
      var sel = deviceSel(), cur = sel.value, named = 0;
      var keep = sel.options[0];
      sel.innerHTML = "";
      sel.appendChild(keep);
      ds.filter(function (d) { return d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications"; }).forEach(function (d, i) {
        var o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = d.label || "Microphone " + (i + 1);
        if (d.label) named++;
        sel.appendChild(o);
      });
      if (cur && $$("option", sel).some(function (o) { return o.value === cur; })) sel.value = cur;
      $("#vp-mic-note").textContent = named ? "Pick the microphone this session is for. The laptop microphone and the headset are two separate sessions." : "The microphone names appear once the browser has been allowed to use the microphone.";
      $("#vp-allow").hidden = named > 0;
    }).catch(function () {});
  }
  function deviceLabel() {
    var sel = deviceSel(), o = sel.options[sel.selectedIndex];
    return o && sel.value ? o.textContent : "default microphone";
  }
  $("#vp-allow").addEventListener("click", function () {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      s.getTracks().forEach(function (t) { t.stop(); });
      return listDevices();
    }).catch(function () { $("#vp-mic-note").textContent = "The microphone was refused. Allow it for this site in the browser, then reload."; });
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", listDevices);

  /* --- recording ------------------------------------------------------- */
  function constraints() {
    var a = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (deviceSel().value) a.deviceId = { exact: deviceSel().value };
    return { audio: a };
  }
  function meter(level) {
    var el = $("#vp-level");
    if (el) el.style.width = Math.min(100, Math.round(Math.sqrt(level) * 260)) + "%";
  }
  function start(id) {
    if (!AC || !window.AudioWorkletNode || !navigator.mediaDevices) { state(id, "this browser cannot record here", "bad"); return; }
    var row = $('.vp-row[data-id="' + id + '"]');
    var max = Number(row && row.getAttribute("data-max")) || 12;
    var btn = $('[data-rec="' + id + '"]');
    btn.disabled = true;
    navigator.mediaDevices.getUserMedia(constraints())
      .then(function (stream) {
        var ctx = new AC();
        return ctx.audioWorklet.addModule(WORKLET).then(function () {
          var node = new AudioWorkletNode(ctx, "mint-live-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
          rec = { id: id, ctx: ctx, stream: stream, node: node, frames: [], peak: 0 };
          node.port.onmessage = function (e) {
            if (!rec || !e.data || e.data.type !== "frame") return;
            rec.frames.push(new Int16Array(e.data.pcm));
            if (e.data.level > rec.peak) rec.peak = e.data.level;
            meter(e.data.level);
          };
          ctx.createMediaStreamSource(stream).connect(node);
          rec.timer = setTimeout(function () { if (rec && rec.id === id) stop(); }, max * 1000);
          btn.disabled = false;
          btn.textContent = "Stop";
          btn.classList.add("primary");
          row.classList.add("on");
          state(id, "recording… then Stop", "ok");
          listDevices();
        });
      })
      .catch(function (e) {
        btn.disabled = false;
        state(id, e && e.name === "OverconstrainedError" ? "that microphone is not available" : "the microphone was refused", "bad");
      });
  }
  function stop() {
    var r = rec;
    rec = null;
    if (!r) return;
    clearTimeout(r.timer);
    r.stream.getTracks().forEach(function (t) { t.stop(); });
    r.ctx.close();
    meter(0);
    var btn = $('[data-rec="' + r.id + '"]'), row = $('.vp-row[data-id="' + r.id + '"]');
    btn.textContent = "Record again";
    btn.classList.remove("primary");
    row.classList.remove("on");
    var n = r.frames.reduce(function (a, f) { return a + f.length; }, 0), all = new Int16Array(n), at = 0;
    r.frames.forEach(function (f) { all.set(f, at); at += f.length; });
    state(r.id, "saving…");
    var mic = slot();
    return fetch("/mint-ai/api/voiceprint-trial/clip?slot=" + encodeURIComponent(mic) + "&id=" + encodeURIComponent(r.id), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "audio/wav", Accept: "application/json", "X-CSRF-Token": CSRF, "X-Mic-Label": encodeURIComponent(deviceLabel()) },
      body: wav(all),
    })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (j) { if (!res.ok) throw new Error(j.error || "HTTP " + res.status); return j; }); })
      .then(function (j) {
        state(r.id, "recorded · " + j.seconds + " s", "ok");
        $('[data-play="' + r.id + '"]').hidden = false;
        if (status && status.slots[mic]) status.slots[mic].clips[r.id] = j.seconds;
        $("#vp-count").textContent = j.count;
        var next = row.nextElementSibling || (row.closest("section") && nextSection(row));
        var nb = next && $("[data-rec]", next);
        if (nb) nb.focus();
      })
      .catch(function (e) { state(r.id, e.message, "bad"); });
  }
  function nextSection(row) {
    var lists = $$(".vp-list"), i = lists.indexOf(row.parentNode);
    return lists[i + 1] ? $(".vp-row", lists[i + 1]) : null;
  }

  root.addEventListener("click", function (e) {
    var b = e.target.closest("[data-rec]");
    if (b) {
      var id = b.getAttribute("data-rec");
      if (rec && rec.id === id) { stop(); return; }
      if (rec) stop();
      start(id);
      return;
    }
    var p = e.target.closest("[data-play]");
    if (p) {
      fetch("/mint-ai/api/voiceprint-trial/clip/" + encodeURIComponent(slot()) + "/" + encodeURIComponent(p.getAttribute("data-play")), { credentials: "same-origin" })
        .then(function (r) { if (!r.ok) throw new Error(); return r.blob(); })
        .then(function (bl) { var u = URL.createObjectURL(bl), a = new Audio(u); a.onended = function () { URL.revokeObjectURL(u); }; a.play(); })
        .catch(function () { state(p.getAttribute("data-play"), "could not play it", "bad"); });
    }
  });

  /* --- per-slot status --------------------------------------------------- */
  function paint() {
    if (!status) return;
    var s = status.slots[slot()] || { clips: {} };
    var n = 0;
    $$(".vp-row").forEach(function (row) {
      var id = row.getAttribute("data-id"), sec = s.clips[id];
      var btn = $("[data-rec]", row);
      if (rec && rec.id === id) return;
      if (sec != null) { n++; state(id, "recorded · " + sec + " s", "ok"); btn.textContent = "Record again"; $("[data-play]", row).hidden = false; }
      else { state(id, "not recorded"); btn.textContent = "Record"; $("[data-play]", row).hidden = true; }
    });
    $("#vp-count").textContent = n;
  }
  function refresh() {
    return api("status").then(function (j) { status = j; paint(); }).catch(function (e) { $("#vp-mic-note").textContent = e.message; });
  }
  $("#vp-slot").addEventListener("change", function () { if (rec) stop(); paint(); });

  $("#vp-delete").addEventListener("click", function () {
    var ask = window.MintUI && window.MintUI.confirm
      ? window.MintUI.confirm({ title: "Delete all your trial recordings?", body: "Every recording on every microphone is removed from the server. This cannot be undone.", yes: "Delete all", danger: true })
      : Promise.resolve(window.confirm("Delete all your trial recordings?"));
    ask.then(function (yes) {
      if (!yes) return;
      if (rec) { var r = rec; rec = null; clearTimeout(r.timer); r.stream.getTracks().forEach(function (t) { t.stop(); }); r.ctx.close(); }
      api("delete", { method: "POST" })
        .then(function (j) { $("#vp-del-state").textContent = "Deleted " + j.deleted + " recording" + (j.deleted === 1 ? "" : "s") + "."; return refresh(); })
        .catch(function (e) { $("#vp-del-state").textContent = e.message; });
    });
  });

  window.addEventListener("pagehide", function () { if (rec) { rec.stream.getTracks().forEach(function (t) { t.stop(); }); } });
  void TOTAL;
  listDevices();
  refresh();
})();
