"use strict";
/* The control pill: the time left (from the app, every second), +15 min and Stop. Stop works
   whatever the server says: the app ends the lease and kills the session at once. */
(function () {
  var T = window.__TAURI__;
  var invoke = function (c) { return T.core.invoke(c, {}); };
  var $ = function (id) { return document.getElementById(id); };
  function paint(v) {
    if (!v) return;
    $("left").textContent = v.active ? v.left : "00:00";
    if (v.stop_key) $("key").textContent = v.stop_key;
    document.body.classList.toggle("ended", !v.active);
  }
  function poll() { invoke("machine_pill").then(paint).catch(function () {}); }
  $("more").addEventListener("click", function () { invoke("machine_pill_extend").then(paint).catch(function () {}); });
  $("stop").addEventListener("click", function () { document.body.classList.add("ended"); invoke("machine_pill_stop").catch(function () {}); });
  poll();
  setInterval(poll, 1000);
})();
