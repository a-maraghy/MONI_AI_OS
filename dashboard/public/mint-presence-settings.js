"use strict";
/*
 * Settings > Appearance > Eye contact (2026-10-20): camera presence's switches (lib/routes-settings.js
 * presenceSettings). In a browser they are this browser's own (localStorage "mint-presence", never sent; an
 * open Command Center follows through the storage event). In the MINT AI app they show the app's setting:
 * ON is only possible from the app's Settings window or its tray (the app refuses the page), OFF works here
 * (presence_off). This page never opens the camera.
 */
(function () {
  var box = document.getElementById("mp-set");
  var L = window.MintPresenceLogic;
  if (!box || !L) return;
  var KEY = "mint-presence";
  var T = window.__TAURI__ || null;
  var APP = !!(T && T.core && T.core.invoke);
  var note = document.getElementById("mp-note");
  function el(k) { return box.querySelector('[data-mp="' + k + '"]'); }
  function say(t) { if (note) note.textContent = t; }
  var stateEl = box.querySelector("[data-mp-state]"), offBtn = box.querySelector("[data-mp-off]");
  box.classList.toggle("mp-app", APP);
  box.querySelectorAll(".scope").forEach(function (s) { if (APP) s.textContent = "this computer"; });

  function read() { var v = null; try { v = window.localStorage.getItem(KEY); } catch (e) { v = null; } return L.normPrefs(v); }
  function paint(p, inUse) {
    el("cam").checked = p.cam; el("speak").checked = p.speak; el("saver").checked = p.saver;
    box.classList.toggle("mp-nocam", !p.cam);
    [el("speak"), el("saver")].forEach(function (i) { i.disabled = !p.cam || APP; i.closest(".row").classList.add("mp-needcam"); });
    if (stateEl) {
      stateEl.textContent = !p.cam ? "Off" : inUse ? "On — the camera is in use now" : "On — the camera opens while the Command Center is up";
      stateEl.classList.toggle("on", !!p.cam);
    }
  }

  if (!APP) {
    paint(read(), false);
    box.addEventListener("change", function (e) {
      var k = e.target.getAttribute("data-mp");
      if (!k) return;
      var p = read();
      p[k] = e.target.checked;
      if (k === "cam" && !p.cam) p.speak = false;
      p = L.normPrefs(p);
      try { window.localStorage.setItem(KEY, JSON.stringify(p)); } catch (x) { say("This browser does not let the page remember it (storage blocked)."); }
      paint(p, false);
      say(p.cam ? "On for this browser. Open the Command Center: the browser asks you once for the camera." : k === "cam" ? "Off. The camera is let go of at once." : "Saved for this browser.");
    });
    window.addEventListener("storage", function (e) { if (e.key === KEY) paint(read(), false); });
    return;
  }

  // The app: shown, not switched on from here.
  function fromApp(v) {
    if (!v) return;
    var p = L.normPrefs({ cam: !!v.camera, speak: !!v.speak, saver: v.releaseOnSaver !== false });
    paint(p, !!v.inUse);
    el("cam").disabled = !p.cam; // only OFF from here
    if (offBtn) offBtn.hidden = !p.cam;
  }
  function load() { T.core.invoke("get_state").then(function (s) { fromApp(s && s.presence); }, function () { say("The app's setting could not be read."); }); }
  load();
  if (T.event && T.event.listen) T.event.listen("mint://state", function (e) { fromApp(e.payload && e.payload.presence); });
  function off() { T.core.invoke("presence_off").then(function () { say("Off. The app let go of the camera."); load(); }, function () { say("Not switched off — use the tray's “Camera presence”."); }); }
  box.addEventListener("change", function (e) { if (e.target.getAttribute("data-mp") === "cam" && !e.target.checked) off(); });
  if (offBtn) offBtn.addEventListener("click", off);
})();
