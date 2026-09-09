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
