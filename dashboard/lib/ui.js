"use strict";
/**
 * Shared page chrome and formatting helpers.
 *
 * Server-rendered HTML, no client framework, no external assets -- the CSP
 * blocks them, and a control panel that can grant SSH access is the last place
 * to be pulling scripts off a CDN.
 */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bytes(n) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + " " + units[i];
}

function duration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function ago(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}

function stamp(iso) {
  return String(iso || "").replace("T", " ").slice(0, 19) || "—";
}

const NAV = [
  ["/", "home", "Overview"],
  ["/agents", "agents", "Agents"],
  ["/keys", "keys", "SSH Keys"],
  ["/devices", "devices", "Devices"],
  ["/audit", "audit", "Audit"],
  ["/guide", "guide", "Guide"],
];

function shell(title, body, opts = {}) {
  const nav = opts.user
    ? `<nav class="nav">
         <a class="brand" href="/">MONI<span>AI OS</span></a>
         ${NAV.map(
           ([href, key, label]) =>
             `<a href="${href}" class="${opts.active === key ? "on" : ""}">${label}</a>`
         ).join("")}
         <form method="post" action="/logout" class="logout">
           <input type="hidden" name="_csrf" value="${esc(opts.csrf)}">
           <button type="submit">Sign out</button>
         </form>
       </nav>`
    : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — MONI AI OS</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head><body>
${nav}
<main class="wrap">${body}</main>
</body></html>`;
}

function statusPill(state) {
  const good = state === "active";
  return `<span class="pill ${good ? "ok" : "bad"}">${esc(state)}</span>`;
}

function agentPill(state) {
  const map = { active: "ok", activating: "warn", failed: "bad", inactive: "muted-pill" };
  return `<span class="pill ${map[state] || "muted-pill"}">${esc(state || "unknown")}</span>`;
}

function meter(name, label, used, total) {
  const pct = total ? Math.round((used / total) * 100) : 0;
  const level = pct > 90 ? "bad" : pct > 75 ? "warn" : "ok";
  return `<div class="meter" data-meter="${esc(name)}">
    <div class="meter-head"><span>${esc(label)}</span><span class="muted">${bytes(used)} / ${bytes(total)}</span></div>
    <div class="bar"><div class="fill ${level}" style="width:${pct}%"></div></div>
  </div>`;
}

function flashes({ msg, err }) {
  let out = "";
  if (msg) out += `<div class="alert good">${esc(msg)}</div>`;
  if (err) out += `<div class="alert bad">${esc(err)}</div>`;
  return out;
}

module.exports = {
  esc,
  bytes,
  duration,
  ago,
  stamp,
  shell,
  statusPill,
  agentPill,
  meter,
  flashes,
};
