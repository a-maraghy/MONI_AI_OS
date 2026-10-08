"use strict";
/**
 * Mint OS > Computers (lib/machines.js): the user's own computers linked
 * through the MINT AI desktop app -- pair, rename, revoke, online state, let
 * MINT AI take over (a lease), extend or stop it, and the action log with a
 * screenshot per action. Everything escaped; no inline script or style
 * (public/machines.js, public/machines.css).
 */

const { esc, shell, card, icon, ago, empty } = require("./ui");

const when = (s) => (s ? esc(String(s).slice(0, 16).replace("T", " ")) + " UTC" : "");

function onlinePill(m) {
  return `<span class="pill ${m.online ? "ok" : "neutral"}" data-online="${m.id}">${m.online ? "online" : "offline"}</span>`;
}

function leaseBlock(m, csrf) {
  const l = m.lease;
  if (!l) return "";
  return `<div class="mc-lease" data-lease="${l.id}" data-expires="${esc(l.expires_at)}">
      <div class="mc-lease-head">${icon("core", 16)}<b>MINT AI is in control</b> <span class="muted small">since ${when(l.started_at)}, by ${esc(l.started_by === "moni-ai" ? "MINT AI" : l.started_by || "?")}</span></div>
      <p class="small">${esc(l.purpose || "")}</p>
      <p class="small">Ends <span class="mono" data-left="${l.id}">${when(l.expires_at)}</span>. On the computer: Ctrl+Alt+Esc stops it at once.</p>
      <div class="btn-row">
        <form method="post" action="/machines/${m.id}/extend"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn" type="submit">${icon("plus", 14)} 15 minutes</button></form>
        <form method="post" action="/machines/${m.id}/stop"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn danger" type="submit">${icon("stop", 14)} Stop now</button></form>
        <a class="btn ghost" href="/machines/${m.id}/lease/${l.id}">Live log</a>
      </div>
    </div>`;
}

function takeOverForm(m, csrf) {
  if (!m.online || m.lease) return "";
  return `<details class="mc-take"><summary>Let MINT AI take over</summary>
      <form method="post" action="/machines/${m.id}/take-over" class="stack">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>What should it do?<textarea name="purpose" rows="3" minlength="10" maxlength="4000" required placeholder="e.g. Make an Excel sheet of this month's orders and open it."></textarea></label>
        <label>For <select name="minutes"><option value="15" selected>15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option></select></label>
        <button class="btn primary" type="submit">${icon("core", 14)} Take over</button>
        <p class="muted small">You will see a glowing frame on that computer; Ctrl+Alt+Esc there stops it. Sending, deleting, buying, posting or installing waits for your approval.</p>
      </form></details>`;
}

function machineRow(m, csrf) {
  const c = m.claude;
  const claude = c && c.path ? `Claude Code ${esc(c.version || "")}` : m.host ? `<span class="warn-text">Claude Code not found</span>` : "";
  return `<li class="mc-row" data-mid="${m.id}" id="machine-${m.id}">
      <div class="mc-main">
        <div class="mc-title">${icon("monitor", 18)}<b>${esc(m.name)}</b> ${onlinePill(m)}</div>
        <div class="muted small">${m.host ? esc(m.host) + " · " : ""}app ${esc(m.app_version || "?")}${claude ? " · " + claude : ""} · ${m.online ? "linked now" : m.last_seen_at ? "last seen " + esc(ago(m.last_seen_at)) : "never linked"}</div>
        ${leaseBlock(m, csrf)}
        ${takeOverForm(m, csrf)}
      </div>
      <div class="mc-side">
        <a class="btn ghost" href="/machines/${m.id}">Activity</a>
        <details class="mc-more"><summary class="btn ghost">More</summary>
          <form method="post" action="/machines/${m.id}/rename" class="stack"><input type="hidden" name="_csrf" value="${esc(csrf)}">
            <label>Name<input name="name" value="${esc(m.name)}" maxlength="48" required></label><button class="btn" type="submit">Rename</button></form>
          <form method="post" action="/machines/${m.id}/revoke" class="stack"><input type="hidden" name="_csrf" value="${esc(csrf)}">
            <p class="muted small">Revoking unlinks this computer at once (and ends any control). It must be paired again to be used.</p>
            <button class="btn danger" type="submit">${icon("stop", 14)} Revoke</button></form>
        </details>
      </div>
    </li>`;
}

/** /machines */
function list(o) {
  const ms = o.machines || [];
  const pair = o.code
    ? `<div class="mc-code" id="pair-code"><div class="muted small">Pairing code, valid until ${when(o.code.expires_at)}</div><div class="mc-code-value mono">${esc(o.code.code)}</div>
        <ol class="steps"><li>On the computer, open MINT AI (the desktop app) > tray > Settings > This computer.</li><li>Type this code and press Link.</li><li>It appears here as online.</li></ol>
        <p class="muted small">The code works once, for ${esc(String(o.code.minutes))} minutes. Never read it to anyone.</p></div>`
    : `<form method="post" action="/machines/pair"><input type="hidden" name="_csrf" value="${esc(o.csrf)}"><button class="btn primary" type="submit">${icon("plus", 14)} Pair a computer</button></form>`;
  const body =
    (o.msg ? `<div class="alert ok">${icon("check")}<div>${esc(o.msg)}</div></div>` : "") +
    (o.err ? `<div class="alert bad">${icon("alert")}<div>${esc(o.err)}</div></div>` : "") +
    card("Your computers", ms.length ? `<ul class="mc-list" id="mc-list">${ms.map((m) => machineRow(m, o.csrf)).join("")}</ul>` : empty("monitor", "No computer is linked yet", "Pair one below: MINT AI can then work on it when you ask."), { icon: "monitor", id: "computers" }) +
    card("Pair a computer", `<p>Link a Windows computer that runs the MINT AI desktop app. MINT AI can then open files and apps, make Word, Excel, PowerPoint and PDF files and use the browser there <b>when you ask</b>.</p>${pair}`, { icon: "plus", id: "pair" }) +
    card(
      "How control works",
      `<ul class="bullets">
        <li><b>Only when you ask.</b> MINT AI takes over for your own request (typed, or said aloud when the voiceprint recognises you), never on its own.</li>
        <li><b>A lease.</b> 15 minutes by default; extend it here or on the computer. It ends on stop, timeout, lock or sign-out.</li>
        <li><b>Always visible.</b> A glowing frame and a pill on the computer; <span class="mono">Ctrl+Alt+Esc</span> stops it instantly, on the computer itself.</li>
        <li><b>Your approval</b> before sending, deleting, buying, posting, installing or touching files outside yours: the usual approval cards.</li>
        <li><b>Never</b> passwords, card numbers or ids typed; never CAPTCHAs; Windows security prompts are yours.</li>
        <li><b>A log</b> of every action with a screenshot, kept ${esc(String(o.retention))} days.</li>
      </ul>`,
      { icon: "shield", id: "safety" }
    );
  return shell("Computers", body, { user: o.user, csrf: o.csrf, active: "machines", heading: "Computers", subtitle: "Your own computers, linked through the MINT AI desktop app", assets: ["machines.css", "machines.js"] });
}

/** /machines/:id: a computer's control sessions. */
function detail(o) {
  const m = o.machine;
  const rows = (o.leases || [])
    .map(
      (l) => `<tr><td><a href="/machines/${m.id}/lease/${l.id}">${when(l.started_at)}</a></td><td>${esc(l.started_by === "moni-ai" ? "MINT AI" : l.started_by || "")}</td><td>${esc(l.purpose || "")}</td><td>${l.ended_at ? esc(l.end_reason || "ended") : `<span class="pill ok">active</span>`}</td><td class="num">${esc(String(l.actions || 0))}</td></tr>`
    )
    .join("");
  const body =
    card(m.name, `<p class="muted small">${m.online ? "Online now" : "Offline"} · app ${esc(m.app_version || "?")} · paired ${when(m.created_at)} by ${esc(m.created_by || "?")}</p>`, { icon: "monitor" }) +
    card("Control sessions", rows ? `<div class="table-wrap"><table class="table"><thead><tr><th>Started</th><th>By</th><th>What for</th><th>End</th><th class="num">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty("activity", "Nothing yet", "MINT AI has not controlled this computer."), { icon: "activity" });
  return shell(m.name, body, { user: o.user, csrf: o.csrf, active: "machines", heading: m.name, crumbs: [["Computers", "/machines"], [m.name, null]], assets: ["machines.css"] });
}

/** /machines/:id/lease/:lid: the action log with screenshots. */
function leaseLog(o) {
  const m = o.machine;
  const l = o.lease;
  const items = (o.actions || [])
    .map(
      (a) => `<li class="mc-act" data-aid="${a.id}">
        ${a.shot ? `<a href="/machines/shot/${a.id}" target="_blank" rel="noopener" class="mc-shot"><img src="/machines/shot/${a.id}" alt="Screen after: ${esc(a.summary || a.tool)}" loading="lazy"></a>` : `<div class="mc-shot none">no screenshot</div>`}
        <div><div class="mono small">${when(a.at)} · ${esc(a.tool)} · <span class="pill ${a.decision === "approved" || a.decision === "auto" ? "ok" : a.decision === "error" ? "warn" : "bad"} nodot">${esc(a.decision || "")}</span></div><div>${esc(a.summary || "")}</div></div>
      </li>`
    )
    .join("");
  const body =
    card(
      "Control session",
      `<p>${esc(l.purpose || "")}</p><p class="muted small">Started ${when(l.started_at)} by ${esc(l.started_by === "moni-ai" ? "MINT AI" : l.started_by || "?")} · ${l.ended_at ? "ended " + when(l.ended_at) + " (" + esc(l.end_reason || "") + ")" : "active until " + when(l.expires_at)}</p>`,
      { icon: "core" }
    ) + card("What it did", items ? `<ol class="mc-acts" id="mc-acts" data-lease="${l.id}" data-active="${l.ended_at ? "0" : "1"}">${items}</ol>` : empty("activity", "No actions yet", "Each action shows here with a screenshot."), { icon: "activity" });
  return shell("Control log", body, { user: o.user, csrf: o.csrf, active: "machines", heading: "Control log", crumbs: [["Computers", "/machines"], [m.name, `/machines/${m.id}`], ["Log", null]], assets: ["machines.css", "machines.js"] });
}

module.exports = { list, detail, leaseLog };
