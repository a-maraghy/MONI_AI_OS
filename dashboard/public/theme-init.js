/*
 * Applies the saved theme before the first paint, so a page that offers the
 * System / Dark / Light switch never flashes the wrong one. Loaded as a
 * blocking script in <head> -- the CSP forbids inline scripts, and a deferred
 * one would run after the page had already been painted once.
 *
 * "system" (or nothing saved) leaves the attribute off, and the stylesheet's
 * prefers-color-scheme rules decide -- live, as the system setting changes.
 */
(function () {
  try {
    var t = window.localStorage.getItem("moni-theme");
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    /* storage blocked: System it is */
  }
})();
