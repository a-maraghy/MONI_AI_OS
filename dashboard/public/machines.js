"use strict";
/*
 * Mint OS > Computers (lib/views-machines.js): keeps the online pills and the
 * lease's time left current, and a live control log growing while it runs.
 * Read-only: every change is one of the page's forms.
 */
(function () {
  const list = document.getElementById("mc-list");
  const acts = document.getElementById("mc-acts");

  function left(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return "now";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return "in " + m + ":" + String(s).padStart(2, "0");
  }
  function tick() {
    document.querySelectorAll("[data-lease][data-expires]").forEach((el) => {
      const out = el.querySelector("[data-left]");
      if (out) out.textContent = left(el.getAttribute("data-expires"));
    });
  }

  async function refreshList() {
    try {
      const r = await fetch("/machines/api/list", { headers: { accept: "application/json" }, credentials: "same-origin" });
      if (!r.ok) return;
      const j = await r.json();
      let changed = false;
      for (const m of j.machines || []) {
        const pill = document.querySelector('[data-online="' + m.id + '"]');
        if (pill) {
          const want = m.online ? "online" : "offline";
          if (pill.textContent !== want) {
            pill.textContent = want;
            pill.classList.toggle("ok", !!m.online);
            pill.classList.toggle("neutral", !m.online);
            changed = true;
          }
        }
        const row = document.querySelector('[data-mid="' + m.id + '"]');
        const shown = row && row.querySelector("[data-lease]");
        const had = shown ? Number(shown.getAttribute("data-lease")) : null;
        const now = m.lease ? m.lease.id : null;
        if (had !== now) changed = true;
        if (shown && m.lease) shown.setAttribute("data-expires", m.lease.expires_at);
      }
      // A lease started or ended elsewhere: the forms change too, so the page is reloaded (not while typing).
      if (changed && !document.activeElement.matches("textarea, input")) location.reload();
    } catch (_) {
      /* offline for a moment */
    }
  }

  async function refreshLog() {
    if (!acts || acts.getAttribute("data-active") !== "1") return;
    const id = acts.getAttribute("data-lease");
    try {
      const r = await fetch("/machines/api/lease/" + encodeURIComponent(id), { headers: { accept: "application/json" }, credentials: "same-origin" });
      if (!r.ok) return;
      const j = await r.json();
      const shown = acts.querySelectorAll("[data-aid]").length;
      if ((j.actions || []).length !== shown || j.lease.ended_at) location.reload();
    } catch (_) {
      /* offline for a moment */
    }
  }

  tick();
  setInterval(tick, 1000);
  if (list) setInterval(refreshList, 5000);
  if (acts) setInterval(refreshLog, 4000);
})();
