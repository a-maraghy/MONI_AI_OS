"use strict";
/*
 * The app's connecting / offline card (dist/index.html). It asks the app for
 * the site's address, checks the site answers, and then goes there
 * (/mint-ai?shell=desktop). While it cannot, it says so and retries with a
 * growing wait (5 s up to 60 s). Only the card catches the mouse.
 */
(function () {
  var T = window.__TAURI__;
  var invoke = function (c, a) { return T && T.core ? T.core.invoke(c, a || {}) : Promise.resolve(null); };
  var $ = function (id) { return document.getElementById(id); };
  var wait = 5, left = 0, timer = 0, origin = "https://os.mint-stack.com";
  var offline = /[?&]offline=1/.test(location.search);

  function regions() {
    var r = $("gate").getBoundingClientRect();
    invoke("set_hit_regions", { regions: [{ x: r.left, y: r.top, w: r.width, h: r.height, r: 14 }], dpr: window.devicePixelRatio || 1 });
  }
  function place(st) {
    var g = $("gate"), W = innerWidth, H = innerHeight;
    var x = W / 2, y = st && st.mode === "floating" ? H - 120 : H * 0.42;
    g.style.left = Math.round(x - g.offsetWidth / 2) + "px";
    g.style.top = Math.round(Math.max(8, y - g.offsetHeight / 2)) + "px";
    document.documentElement.setAttribute("data-ink", st && st.ink === "dark" ? "dark" : "light");
    regions();
  }
  function say(title, sub, retry) {
    $("g-title").textContent = title;
    $("g-sub").textContent = sub;
    $("g-retry").hidden = !retry;
    regions();
  }
  function go() {
    clearInterval(timer);
    say("Connecting to MINT AI…", origin.replace(/^https:\/\//, ""), false);
    // The site's public manifest: answers without a session; no-cors, only "is it there" matters.
    fetch(origin + "/manifest.webmanifest", { mode: "no-cors", cache: "no-store" }).then(function () {
      location.replace(origin + "/mint-ai?shell=desktop");
    }).catch(function () {
      left = wait;
      wait = Math.min(60, wait * 2);
      tick();
      timer = setInterval(tick, 1000);
    });
  }
  function tick() {
    if (left <= 0) return go();
    say("Offline", "Can't reach " + origin.replace(/^https:\/\//, "") + ". Retrying in " + left + " s — nothing typed is sent while offline.", true);
    left--;
  }
  $("g-retry").addEventListener("click", function () { wait = 5; go(); });
  addEventListener("resize", function () { invoke("get_state").then(place); });
  invoke("settings_get").then(function (v) {
    if (v && v.settings && /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(v.settings.origin)) origin = v.settings.origin.replace(/\/$/, "");
    return invoke("get_state");
  }).then(function (st) {
    place(st);
    if (offline) { left = 5; tick(); timer = setInterval(tick, 1000); } else go();
  });
  if (T && T.event) T.event.listen("mint://state", function (e) { place(e.payload); });
})();
