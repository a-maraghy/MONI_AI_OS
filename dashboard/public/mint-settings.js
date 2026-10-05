"use strict";
/*
 * Account > Appearance: the MINT AI core, chosen with a live preview of each.
 *
 * Each option draws its core in a small canvas (mint-core.js; D, the mesh, is
 * mint-core-d.js), cycling through
 * the states so the difference shows. Choosing one saves it at once through
 * the Command Center's own route (POST /mint-ai/api/prefs/core, CSRF in a
 * header), no reload; the form still posts without JavaScript. The previews
 * run only while on screen and stop when the tab is hidden (mint-core.js).
 */
(function () {
  var form = document.getElementById("mint-appearance");
  if (!form || !window.MintCore) return;
  var CSRF = form.getAttribute("data-csrf") || "";
  var note = document.getElementById("mint-appearance-note");
  var CYCLE = ["idle", "listening", "thinking", "speaking", "needs", "idle"];
  var previews = [];
  form.classList.add("js");

  function isLight() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t === "light";
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  }

  var canvases = form.querySelectorAll("canvas[data-prev-core]");
  for (var i = 0; i < canvases.length; i++) {
    (function (cv, k) {
      var k0 = cv.getAttribute("data-prev-core");
      var core = k0 === "D" && window.MintCoreD
        ? window.MintCoreD(cv, { autoAmp: true })
        : window.MintCore(cv, { concept: k0, points: 1500, points2d: 500, autoAmp: true });
      cv = core.canvas || cv; // a core without its GPU context draws on a fresh copy of the canvas
      var p = { cv: cv, core: core, n: k, on: false };
      p.fit = function () {
        var w = cv.clientWidth || 180, h = cv.clientHeight || 120;
        core.resize(w / 2, h / 2, Math.min(w, h) * 0.34, w, h);
      };
      core.setLight(isLight());
      p.fit();
      previews.push(p);
    })(canvases[i], i);
  }
  // Each preview walks through the states, a beat apart from the others.
  var step = 0;
  setInterval(function () {
    if (document.hidden) return;
    step++;
    previews.forEach(function (p) { p.core.setState(CYCLE[(step + p.n) % CYCLE.length]); });
  }, 2600);
  function visible(p, on) {
    if (on === p.on) return;
    p.on = on;
    if (on) p.core.start(); else p.core.stop();
  }
  if (window.IntersectionObserver) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        previews.forEach(function (p) { if (p.cv === e.target) visible(p, e.isIntersecting); });
      });
    });
    previews.forEach(function (p) { io.observe(p.cv); });
  } else previews.forEach(function (p) { visible(p, true); });
  window.addEventListener("resize", function () { previews.forEach(function (p) { p.fit(); }); });
  function repaint() { previews.forEach(function (p) { p.core.setLight(isLight()); }); }
  document.addEventListener("moni-theme", repaint);
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    if (mq.addEventListener) mq.addEventListener("change", repaint);
  }

  function say(text, bad) {
    if (!note) return;
    note.textContent = text;
    note.classList.toggle("err", !!bad);
  }
  form.addEventListener("change", function (e) {
    if (e.target.name === "sessions_view") return saveSessView(e.target.value);
    if (e.target.name !== "core") return;
    var core = e.target.value;
    say("Saving…");
    fetch("/mint-ai/api/prefs/core", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": CSRF },
      body: JSON.stringify({ core: core }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        try { window.localStorage.setItem("mint-core", j.core); } catch (x) { /* the server keeps it */ }
        say("Saved. The Command Center uses " + j.core + " · " + j.name + ".");
      });
    }).catch(function (x) { say("Not saved: " + x.message, true); });
  });
  /* The sessions view: saved at once through the Command Center's own route, like the core. */
  function saveSessView(view) {
    say("Saving…");
    fetch("/mint-ai/api/prefs/sessions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": CSRF },
      body: JSON.stringify({ view: view }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        say("Saved. The Command Center shows the sessions as " + j.name + ".");
      });
    }).catch(function (x) { say("Not saved: " + x.message, true); });
  }
  form.addEventListener("submit", function (e) {
    // With JavaScript the choice is saved as it is made.
    e.preventDefault();
  });
})();
