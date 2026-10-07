"use strict";
/* The Settings window: reads the app's settings, lets you change them, saves through settings_set
   (which checks the hotkeys again and applies everything at once). */
(function () {
  var T = window.__TAURI__;
  var invoke = function (c, a) { return T.core.invoke(c, a || {}); };
  var $ = function (id) { return document.getElementById(id); };
  var S = null, monKey = null, saved = "", discard = false;

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
  ["talk", "live", "show", "focus"].forEach(function (n) {
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
    discard = false;
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
    $("hk-talk").value = S.hotkeys.talk; $("hk-show").value = S.hotkeys.show; $("hk-focus").value = S.hotkeys.focus; $("hk-live").value = S.hotkeys.live || "";
    $("live-note").textContent = v.liveFallback ? "Ctrl+Alt+L is taken by another app: using " + v.liveKey + " for now." : v.liveKey ? "Now: press " + v.liveKey + " once to start, again to end." : "Not set: the key is taken by another app.";
    $("talk-note").textContent = v.talkFallback ? "Ctrl+Space is taken by another app: listening on " + v.talkKey + " for now." : v.talkKey ? "Now: hold " + v.talkKey + "." : "Not set: the key is taken by another app.";
    $("opacity").value = pm().opacity; $("opv").textContent = pm().opacity + "%";
    segs();
    // What is saved, as the form reads it (the per-monitor entry above may have just been made).
    collect();
    saved = JSON.stringify(S);
  }
  $("opacity").addEventListener("input", function () { pm().opacity = Number(this.value); $("opv").textContent = this.value + "%"; });
  /** The form's values into S (segments, hotkeys and opacity are written as they change). */
  function collect() {
    S.monitor = $("monitor").value;
    S.focus = $("focus").checked; S.do_not_disturb = $("dnd").checked; S.battery_saver = $("batt").checked;
    S.autostart = $("autostart").checked; S.check_updates = $("updates").checked; S.experimental_behind_icons = $("icons").checked;
  }
  function save() {
    collect();
    $("err").textContent = "";
    return invoke("settings_set", { value: S }).then(function () { return invoke("settings_get"); }).then(function (v) { paint(v); $("err").textContent = "Saved."; return true; })
      .catch(function (e) { $("err").textContent = String(e); return false; });
  }
  $("save").addEventListener("click", function () { save(); });
  /*
   * Close: the app closes this window (settings_close). The page closing itself is not it: WebView2 empties the
   * page and leaves the window up, white. Unsaved changes: the first Close says so; Save, or Close
   * again to discard them. Esc is Close (not while a hotkey box is recording).
   */
  function close() {
    if (S) collect();
    if (S && JSON.stringify(S) !== saved && !discard) {
      discard = true;
      $("err").textContent = "You have unsaved changes: Save them, or press Close again to discard them.";
      return false;
    }
    invoke("settings_close").catch(function (e) { $("err").textContent = String(e); });
    return true;
  }
  $("cancel").addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (document.activeElement && document.activeElement.classList.contains("key")) { document.activeElement.blur(); return; }
    close();
  });
  window.MintSettings = { close: close, save: save, dirty: function () { if (S) collect(); return !!S && JSON.stringify(S) !== saved; } };
  $("upd").addEventListener("click", function () { invoke("settings_check_update"); $("err").textContent = "Checking… a notification says what was found."; });
  invoke("settings_get").then(paint);
})();
