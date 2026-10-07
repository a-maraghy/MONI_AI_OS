"use strict";
/* The Settings window: reads the app's settings, lets you change them, saves through settings_set
   (which checks the hotkeys again and applies everything at once). */
(function () {
  var T = window.__TAURI__;
  var invoke = function (c, a) { return T.core.invoke(c, a || {}); };
  var $ = function (id) { return document.getElementById(id); };
  var S = null, monKey = null;

  function segs() {
    document.querySelectorAll(".seg[data-k]").forEach(function (s) {
      var k = s.getAttribute("data-k"), v = val(k);
      s.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-v") === v); });
    });
  }
  function pm() {
    S.per_monitor = S.per_monitor || {};
    if (!monKey) monKey = "default";
    S.per_monitor[monKey] = S.per_monitor[monKey] || { corner: "br", across: "right", size: "M", opacity: 100 };
    return S.per_monitor[monKey];
  }
  function val(k) { return k === "mode" ? S.mode : pm()[k]; }
  function setVal(k, v) { if (k === "mode") S.mode = v; else pm()[k] = v; segs(); }
  document.querySelectorAll(".seg[data-k]").forEach(function (s) {
    s.addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) setVal(s.getAttribute("data-k"), b.getAttribute("data-v")); });
  });

  // Recording a hotkey: the next key press with Ctrl or Alt.
  function keyName(e) {
    var k = e.code;
    if (/^Key[A-Z]$/.test(k)) return k.slice(3);
    if (/^Digit\d$/.test(k)) return k.slice(5);
    if (/^F\d{1,2}$/.test(k)) return k;
    return { Space: "Space", Enter: "Enter", Tab: "Tab", Backquote: "Backquote" }[k] || null;
  }
  ["talk", "show", "focus"].forEach(function (n) {
    var el = $("hk-" + n);
    el.addEventListener("focus", function () { el.classList.add("rec"); el.value = "press the keys…"; });
    el.addEventListener("blur", function () { el.classList.remove("rec"); el.value = S.hotkeys[n]; });
    el.addEventListener("keydown", function (e) {
      e.preventDefault();
      var k = keyName(e);
      if (!k || !(e.ctrlKey || e.altKey)) return;
      S.hotkeys[n] = [e.ctrlKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", k].filter(Boolean).join("+");
      el.blur();
    });
  });

  function paint(v) {
    S = v.settings;
    monKey = v.monitorKey || monKey;
    $("ver").textContent = "version " + v.version + (v.update ? " · " + v.update + " is ready (tray ▸ Update)" : "");
    var sel = $("monitor");
    sel.innerHTML = "";
    var o0 = document.createElement("option"); o0.value = ""; o0.textContent = "The primary monitor"; sel.appendChild(o0);
    (v.monitors || []).forEach(function (m) { var o = document.createElement("option"); o.value = m; o.textContent = m.replace(/^\\\\\.\\/, ""); sel.appendChild(o); });
    sel.value = S.monitor || "";
    $("focus").checked = !!S.focus;
    $("dnd").checked = !!S.do_not_disturb;
    $("batt").checked = !!S.battery_saver;
    $("autostart").checked = !!S.autostart;
    $("updates").checked = !!S.check_updates;
    $("icons").checked = !!S.experimental_behind_icons;
    $("hk-talk").value = S.hotkeys.talk; $("hk-show").value = S.hotkeys.show; $("hk-focus").value = S.hotkeys.focus;
    $("talk-note").textContent = v.talkFallback ? "Ctrl+Space is taken by another app: listening on " + v.talkKey + " for now." : v.talkKey ? "Now: hold " + v.talkKey + "." : "Not set: the key is taken by another app.";
    $("opacity").value = pm().opacity; $("opv").textContent = pm().opacity + "%";
    segs();
  }
  $("opacity").addEventListener("input", function () { pm().opacity = Number(this.value); $("opv").textContent = this.value + "%"; });
  $("save").addEventListener("click", function () {
    S.monitor = $("monitor").value;
    S.focus = $("focus").checked; S.do_not_disturb = $("dnd").checked; S.battery_saver = $("batt").checked;
    S.autostart = $("autostart").checked; S.check_updates = $("updates").checked; S.experimental_behind_icons = $("icons").checked;
    $("err").textContent = "";
    invoke("settings_set", { value: S }).then(function () { return invoke("settings_get"); }).then(function (v) { paint(v); $("err").textContent = "Saved."; })
      .catch(function (e) { $("err").textContent = String(e); });
  });
  $("cancel").addEventListener("click", function () { window.close(); });
  $("upd").addEventListener("click", function () { invoke("settings_check_update"); $("err").textContent = "Checking… a notification says what was found."; });
  invoke("settings_get").then(paint);
})();
