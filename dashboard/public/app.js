"use strict";
/*
 * Small progressive-enhancement layer.
 *
 * Inline event handlers (onclick=, onsubmit=) are deliberately impossible here:
 * the Content-Security-Policy sets script-src-attr 'none'. So confirmations are
 * wired up from this external file via a delegated listener instead.
 */

document.addEventListener("submit", function (ev) {
  var form = ev.target;
  if (!(form instanceof HTMLFormElement)) return;
  var message = form.getAttribute("data-confirm");
  if (message && !window.confirm(message)) {
    ev.preventDefault();
  }
});

/* Live-refresh the overview tiles without a full page reload. */
(function () {
  var grid = document.querySelector("[data-live-stats]");
  if (!grid) return;

  function fmtBytes(n) {
    if (n == null) return "—";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + " " + units[i];
  }

  function setMeter(name, used, total) {
    var el = document.querySelector('[data-meter="' + name + '"]');
    if (!el || !total) return;
    var pct = Math.round((used / total) * 100);
    var fill = el.querySelector(".fill");
    var label = el.querySelector(".meter-head span:last-child");
    fill.style.width = pct + "%";
    fill.className = "fill " + (pct > 90 ? "bad" : pct > 75 ? "warn" : "ok");
    if (label) label.textContent = fmtBytes(used) + " / " + fmtBytes(total);
  }

  function refresh() {
    fetch("/api/stats", { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("stats unavailable");
        return r.json();
      })
      .then(function (d) {
        setMeter("memory", d.stats.memUsed, d.stats.memTotal);
        setMeter("disk", d.stats.diskUsed, d.stats.diskTotal);
        var sshd = (d.status.jails && d.status.jails.sshd) || null;
        if (sshd) {
          var banned = document.querySelector('[data-stat="banned"]');
          var failed = document.querySelector('[data-stat="failed"]');
          if (banned) banned.textContent = sshd.banned;
          if (failed) failed.textContent = sshd.total_failed;
        }
      })
      .catch(function () {
        /* transient failure: leave the last-known values on screen */
      });
  }

  setInterval(refresh, 15000);
})();

/*
 * Claude Code > Running: swap the live tables in place every ten seconds.
 *
 * The server renders the fragments with the same view code as the page, so
 * nothing is templated here and every value arrives already escaped. Skipped
 * while the tab is hidden, and while a confirm dialog or a focused control is
 * in play, so a table never changes under a click. Without JavaScript the page
 * is complete as served and a reload is the refresh.
 */
(function () {
  var root = document.querySelector("[data-cc-running]");
  if (!root) return;
  var busy = false;

  function refresh() {
    if (busy || document.hidden) return;
    var focused = document.activeElement;
    if (focused && focused !== document.body && root.contains(focused)) return;
    busy = true;
    fetch("/api/claude/running", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("running view unavailable");
        return r.json();
      })
      .then(function (d) {
        var html = d.html || {};
        Object.keys(html).forEach(function (key) {
          var el = root.querySelector('[data-cc-section="' + key + '"]');
          if (el) el.innerHTML = html[key];
        });
        var stamp = root.querySelector("[data-cc-updated]");
        if (stamp && d.updated) stamp.textContent = d.updated;
      })
      .catch(function () {
        /* signed out or a transient failure: keep what is on screen */
      })
      .then(function () {
        busy = false;
      });
  }

  setInterval(refresh, 10000);
})();

/*
 * The two drawers.
 *
 * Below 900px the sidebar and the console's chat list stop being columns and
 * become panels that slide in over the page. Both are the same mechanism: a
 * class on <html>, a button that toggles it, and a scrim that closes it. The
 * markup is identical at every width -- only the stylesheet decides whether a
 * drawer is a drawer -- so nothing here has to know the viewport, and a desktop
 * that happens to run this code toggles a class no rule reads.
 *
 * Delegated from the document because the console replaces its own topline as
 * chats come and go, and a listener bound to a button would go with it.
 */
(function () {
  var root = document.documentElement;

  var DRAWERS = [
    { open: "nav-open", toggle: "data-nav-toggle", close: "data-nav-close", scrim: ".nav-scrim" },
    { open: "chats-open", toggle: "data-chats-toggle", close: "data-chats-close", scrim: ".chat-scrim" },
  ];

  function setOpen(d, on) {
    root.classList.toggle(d.open, on);
    var buttons = document.querySelectorAll("[" + d.toggle + "]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-expanded", on ? "true" : "false");
    }
    // hidden rather than opacity alone: a scrim left in the layer soaks up taps
    // meant for the page behind it, which reads as the whole app going dead.
    var scrim = document.querySelector(d.scrim);
    if (scrim) scrim.hidden = !on;
  }

  function closeAll() {
    for (var i = 0; i < DRAWERS.length; i++) setOpen(DRAWERS[i], false);
  }

  document.addEventListener("click", function (ev) {
    for (var i = 0; i < DRAWERS.length; i++) {
      var d = DRAWERS[i];
      if (ev.target.closest("[" + d.toggle + "]")) {
        ev.preventDefault();
        var on = !root.classList.contains(d.open);
        closeAll();
        setOpen(d, on);
        return;
      }
      if (ev.target.closest("[" + d.close + "]")) {
        setOpen(d, false);
        return;
      }
    }
    // Following a link inside a drawer navigates; leaving it open would mean
    // the new page arrives with a panel over it.
    if (ev.target.closest(".sidebar a, .chat-list a")) closeAll();
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") closeAll();
  });

  // A drawer is a small-screen state. Coming back to a wide window with one
  // still "open" would leave the class on and, with it, a scrim nobody can see.
  var wide = window.matchMedia("(min-width: 901px)");
  (wide.addEventListener ? wide.addEventListener.bind(wide, "change") : wide.addListener.bind(wide))(
    function (e) {
      if (e.matches) closeAll();
    }
  );
})();
