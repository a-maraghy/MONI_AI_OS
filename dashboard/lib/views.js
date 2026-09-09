"use strict";
/** Authentication screens, the OS dashboard, and the system pages. */

const {
  esc,
  bytes,
  duration,
  ago,
  stamp,
  shell,
  statusPill,
  agentPill,
  meter,
  stat,
  card,
  flashes,
  empty,
  icon,
} = require("./ui");

exports.error = (title, msg) =>
  shell(
    title,
    `<div class="card">
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(msg)}</p>
      <p><a class="btn" href="/">${icon("chevron")} Back to the dashboard</a></p>
    </div>`
  );

/* ----------------------------------------------------------------- auth --- */

exports.login = ({ csrf, error }) =>
  shell(
    "Sign in",
    `<div class="card">
      <h2 class="mb-14">Sign in to MONI AI OS</h2>
      ${error ? `<div class="alert bad">${icon("alert")}<div>${esc(error)}</div></div>` : ""}
      <form method="post" action="/login" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Username<input name="username" autocomplete="username" required autofocus></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <label>Authenticator code
          <input name="token" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000"
                 autocomplete="one-time-code" required></label>
        <button class="btn primary" type="submit" class="w-full">Sign in</button>
      </form>
    </div>`
  );

exports.setup = ({ csrf, token, errors = [] }) =>
  shell(
    "First-run setup",
    `<div class="card">
      <h2>Create the admin account</h2>
      <p class="muted small">This runs once. Afterwards <code>/setup</code> stops working.</p>
      ${errors.length ? `<div class="alert bad">${icon("alert")}<div>${errors.map(esc).join("<br>")}</div></div>` : ""}
      <form method="post" action="/setup" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <input type="hidden" name="token" value="${esc(token)}">
        <label>Username<input name="username" required autofocus></label>
        <label>Password <span class="hint">minimum 12 characters</span>
          <input name="password" type="password" required></label>
        <label>Repeat password<input name="password2" type="password" required></label>
        <button class="btn primary" type="submit" class="w-full">Create account</button>
      </form>
    </div>`
  );

exports.totpEnroll = ({ csrf, qr, secret, error }) =>
  shell(
    "Set up two-factor",
    `<div class="card">
      <h2>Set up two-factor authentication</h2>
      <p class="muted small">Scan with Google Authenticator, Authy, 1Password, or any TOTP app.</p>
      ${error ? `<div class="alert bad">${icon("alert")}<div>${esc(error)}</div></div>` : ""}
      <p class="center"><img src="${esc(qr)}" alt="TOTP QR code" width="240" height="240"></p>
      <p class="muted small">Can't scan? Enter this secret manually:</p>
      <p><code class="secret">${esc(secret)}</code></p>
      <div class="alert warn">${icon("alert")}<div>Save this secret somewhere safe. If you
        lose your authenticator and have no copy, you will need SSH access to reset it.</div></div>
      <form method="post" action="/setup/confirm" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Enter the current 6-digit code to confirm
          <input name="token" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000" required autofocus></label>
        <button class="btn primary" type="submit" class="w-full">Confirm and finish</button>
      </form>
    </div>`
  );

exports.setupDone = () =>
  shell(
    "Setup complete",
    `<div class="card">
      <h2>Setup complete</h2>
      <p>Two-factor authentication is active. You can now sign in.</p>
      <p><a class="btn primary" href="/login">Go to sign in</a></p>
    </div>`
  );

/* -------------------------------------------------------- OS dashboard --- */

exports.osDashboard = ({
  csrf,
  user,
  stats,
  status,
  statusError,
  services,
  agents,
  channels,
  probe,
  logins,
}) => {
  const svcDown = services.filter((s) => s.active !== "active");
  const running = agents.filter((a) => a.state && a.state.active === "active").length;
  const jails = (status && status.jails) || {};
  const sshd = jails.sshd || { banned: 0, total_failed: 0 };

  const warnings = [];
  if (probe && !probe.claude_credential) {
    warnings.push(
      `No Claude credential is set, so agents can receive messages but cannot answer.
       <a href="/credentials">Add one</a>.`
    );
  }
  if (svcDown.length) {
    warnings.push(
      `${svcDown.length} system service${svcDown.length === 1 ? " is" : "s are"} not running:
       ${svcDown.map((s) => "<strong>" + esc(s.unit) + "</strong>").join(", ")}.
       <a href="/services">Check services</a>.`
    );
  }

  return shell(
    "OS Dashboard",
    `${warnings
      .map((w) => `<div class="alert warn">${icon("alert")}<div>${w}</div></div>`)
      .join("")}
    ${statusError ? `<div class="alert bad">${icon("alert")}<div>Could not query privileged status: ${esc(statusError)}</div></div>` : ""}

    <div class="statrow mb-18">
      ${stat(running + " / " + agents.length, "agents running", "agents")}
      ${stat(channels.length, "channels connected", "channels")}
      ${stat(services.length - svcDown.length + " / " + services.length, "services healthy", "services")}
      ${stat(sshd.banned, "IPs banned right now", "shield")}
    </div>

    <div class="grid cols-2">
      ${card(
        "Machine",
        `<table class="kv">
          <tr><td>Host</td><td class="mono">${esc(stats.hostname)}</td></tr>
          <tr><td>Uptime</td><td>${esc(duration(stats.uptimeSec))}</td></tr>
          <tr><td>CPU</td><td>${stats.cpus} vCPU · load ${stats.loadavg.map((n) => n.toFixed(2)).join("  ")}</td></tr>
          <tr><td>Runtime</td><td class="mono small">${esc((probe && probe.runtime_revision) || "—")}</td></tr>
        </table>
        <div class="mt-16">
          ${meter("memory", "Memory", stats.memUsed, stats.memTotal)}
          ${stats.diskTotal != null ? meter("disk", "Disk /", stats.diskUsed, stats.diskTotal) : ""}
        </div>`,
        { icon: "cpu" }
      )}

      ${card(
        "System services",
        services.length
          ? `<table class="kv">
              ${services
                .map(
                  (s) =>
                    `<tr><td>${esc(s.unit)}</td><td>${statusPill(s.active)}</td></tr>`
                )
                .join("")}
            </table>`
          : `<p class="muted">No services reported.</p>`,
        {
          icon: "services",
          actions: `<a class="btn small" href="/services">Manage</a>`,
        }
      )}

    </div>

    <div class="grid cols-2">
      ${card(
        "Capabilities",
        `<table class="kv">
          ${capRow("Claude credential", probe && probe.claude_credential)}
          ${capRow("Voice transcription", probe && probe.files && probe.files.whisper_binary && probe.files.whisper_model && probe.binaries.ffmpeg)}
          ${capRow("Vector memory model", probe && probe.files && probe.files.embedding_model)}
          ${capRow("Agent runtime", probe && probe.files && probe.files.runtime_venv)}
          ${capRow("Obsidian", probe && probe.binaries && probe.binaries.obsidian)}
        </table>`,
        { icon: "check" }
      )}
      ${card(
        "Security",
        `<table class="kv">
          <tr><td>IPs banned (SSH)</td><td>${sshd.banned}</td></tr>
          <tr><td>Failed SSH auths</td><td>${sshd.total_failed}</td></tr>
          <tr><td>Panel bans</td><td>${(jails["moni-dashboard"] || {}).banned || 0}</td></tr>
        </table>`,
        {
          icon: "shield",
          actions: `<a class="btn small" href="/audit">Audit log</a>`,
        }
      )}
    </div>

    ${card(
      "Recent sign-ins",
      logins.length
        ? `<table class="rows">
            <thead><tr><th>When</th><th>IP</th><th>User</th><th>Result</th></tr></thead>
            <tbody>${logins
              .map(
                (l) => `<tr>
                  <td class="mono small">${esc(stamp(l.ts))}</td>
                  <td class="mono small">${esc(l.ip || "—")}</td>
                  <td>${esc(l.username || "—")}</td>
                  <td><span class="pill ${l.outcome === "success" ? "ok" : "bad"}">${esc(l.outcome)}</span>
                    ${l.detail ? `<span class="muted small"> ${esc(l.detail)}</span>` : ""}</td>
                </tr>`
              )
              .join("")}</tbody></table>`
        : `<p class="muted">No sign-ins recorded yet.</p>`,
      { icon: "audit" }
    )}`,
    {
      user,
      csrf,
      active: "os",
      heading: "OS Dashboard",
      subtitle: "The machine everything runs on.",
      statusChip: running + " agent" + (running === 1 ? "" : "s") + " running",
    }
  );
};

function capRow(label, present) {
  return `<tr><td>${esc(label)}</td><td>${
    present
      ? `<span class="pill ok">installed</span>`
      : `<span class="pill neutral">missing</span>`
  }</td></tr>`;
}

/* ----------------------------------------------------------------- keys --- */

exports.keys = ({ csrf, user, keys, devices, flash, flashError }) => {
  const deviceByFp = new Map(devices.map((d) => [d.fingerprint, d]));

  const section = (account, list) =>
    card(
      account + " — " + list.length + " key" + (list.length === 1 ? "" : "s"),
      list.length
        ? `<table class="rows">
            <thead><tr><th>Comment</th><th>Type</th><th>Fingerprint</th><th></th></tr></thead>
            <tbody>${list
              .map((k) => {
                const dev = deviceByFp.get(k.fingerprint);
                return `<tr>
                  <td>${esc(k.comment || "—")}
                    ${dev ? `<span class="tag">paired ${esc(dev.paired_at.slice(0, 10))}</span>` : ""}</td>
                  <td class="mono small">${esc(k.type)}</td>
                  <td class="mono small">${esc(k.fingerprint)}</td>
                  <td class="right">
                    <form method="post" action="/keys/remove" class="inline"
                          data-confirm="Revoke this key from ${esc(account)}? Any device using it loses access immediately.">
                      <input type="hidden" name="_csrf" value="${esc(csrf)}">
                      <input type="hidden" name="target_user" value="${esc(account)}">
                      <input type="hidden" name="fingerprint" value="${esc(k.fingerprint)}">
                      <button class="btn danger small" type="submit">Revoke</button>
                    </form>
                  </td>
                </tr>`;
              })
              .join("")}</tbody></table>`
        : `<p class="muted">No keys.</p>`,
      { icon: "keys" }
    );

  return shell(
    "SSH keys",
    `${flashes({ msg: flash, err: flashError })}
    ${Object.entries(keys).map(([acct, list]) => section(acct, list)).join("")}
    ${card(
      "Add a key manually",
      `<p class="muted small">For pairing a device that can't reach this panel, prefer
        <a href="/devices">Devices → pairing code</a>.</p>
      <form method="post" action="/keys/add">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Account
          <select name="target_user">
            <option value="ubuntu">ubuntu (normal use)</option>
            <option value="root">root (full privilege)</option>
          </select></label>
        <label>Label<input name="label" placeholder="e.g. work-laptop" maxlength="64"></label>
        <label>Public key <span class="hint">contents of a .pub file</span>
          <textarea name="pubkey" rows="3" placeholder="ssh-ed25519 AAAAC3... user@host" required></textarea></label>
        <button class="btn primary" type="submit">Authorise key</button>
      </form>`,
      { icon: "plus" }
    )}`,
    {
      user,
      csrf,
      active: "keys",
      heading: "SSH keys",
      subtitle: "Keys authorised to log in. Revoking one takes effect immediately.",
    }
  );
};

/* -------------------------------------------------------------- devices --- */

exports.devices = ({ csrf, user, codes, devices, publicHost, publicPort, flash }) => {
  const active = codes.filter((c) => !c.used_at && new Date(c.expires_at) > new Date());
  return shell(
    "Devices",
    `${
      flash
        ? `<div class="alert good">${icon("check")}<div><strong>Pairing code:</strong>
             <code class="secret">${esc(flash)}</code><br>
             Valid for 15 minutes, single use. On the new device open
             <code>https://${esc(publicHost)}:${esc(publicPort)}/pair</code></div></div>`
        : ""
    }

    ${card(
      "Generate a pairing code",
      `<form method="post" action="/devices/code">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Device label<input name="label" placeholder="e.g. new-laptop" maxlength="64" required></label>
        <label>Grant access to
          <select name="target_user">
            <option value="ubuntu">ubuntu (normal use — recommended)</option>
            <option value="root">root (full privilege)</option>
          </select></label>
        <button class="btn primary" type="submit">Generate code</button>
      </form>`,
      { icon: "plus" }
    )}

    ${card(
      "Active codes",
      active.length
        ? `<table class="rows">
            <thead><tr><th>Code</th><th>Label</th><th>Account</th><th>Expires</th><th></th></tr></thead>
            <tbody>${active
              .map(
                (c) => `<tr>
                  <td class="mono">${esc(c.code)}</td>
                  <td>${esc(c.label)}</td>
                  <td>${esc(c.target_user)}</td>
                  <td class="mono small">${esc(stamp(c.expires_at))}</td>
                  <td class="right"><form method="post" action="/devices/code/revoke" class="inline">
                    <input type="hidden" name="_csrf" value="${esc(csrf)}">
                    <input type="hidden" name="code" value="${esc(c.code)}">
                    <button class="btn danger small">Cancel</button></form></td>
                </tr>`
              )
              .join("")}</tbody></table>`
        : `<p class="muted">No active pairing codes.</p>`,
      { icon: "clock" }
    )}

    ${card(
      "Paired devices",
      devices.length
        ? `<table class="rows">
            <thead><tr><th>Label</th><th>Account</th><th>Paired</th><th>From IP</th><th>Fingerprint</th></tr></thead>
            <tbody>${devices
              .map(
                (d) => `<tr>
                  <td>${esc(d.label)}</td>
                  <td>${esc(d.target_user)}</td>
                  <td class="mono small">${esc(stamp(d.paired_at))}</td>
                  <td class="mono small">${esc(d.paired_ip || "—")}</td>
                  <td class="mono small">${esc(d.fingerprint)}</td>
                </tr>`
              )
              .join("")}</tbody></table>
           <p class="muted small">Revoke a device from the <a href="/keys">SSH keys</a> page.</p>`
        : `<p class="muted">No devices paired through this panel yet.</p>`,
      { icon: "devices" }
    )}`,
    {
      user,
      csrf,
      active: "devices",
      heading: "Devices",
      subtitle:
        "Pair a new machine without copying private keys around. Generate a code here, then enter it on the new device with its own public key.",
    }
  );
};

exports.pair = ({ csrf, error }) =>
  shell(
    "Pair this device",
    `<div class="card">
      <h2>Pair this device</h2>
      <p class="muted small">Enter the pairing code from the dashboard, and this device's
        <strong>public</strong> key. Never paste a private key here — or anywhere.</p>
      ${error ? `<div class="alert bad">${icon("alert")}<div>${esc(error)}</div></div>` : ""}
      <details class="mb-14">
        <summary class="muted small">How do I get my public key?</summary>
        <p class="small">Windows PowerShell:</p>
        <pre>ssh-keygen -t ed25519 -f $env:USERPROFILE\\.ssh\\contabo_vps
type $env:USERPROFILE\\.ssh\\contabo_vps.pub</pre>
        <p class="small">macOS or Linux:</p>
        <pre>ssh-keygen -t ed25519 -f ~/.ssh/contabo_vps
cat ~/.ssh/contabo_vps.pub</pre>
      </details>
      <form method="post" action="/pair" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Pairing code<input name="code" placeholder="XXXX-XXXX-XXXX" required autofocus></label>
        <label>Public key<textarea name="pubkey" rows="3" placeholder="ssh-ed25519 AAAAC3..." required></textarea></label>
        <button class="btn primary" type="submit" class="w-full">Pair device</button>
      </form>
    </div>`
  );

exports.paired = ({ label, targetUser, fingerprint, publicHost }) =>
  shell(
    "Device paired",
    `<div class="card">
      <h2>Device paired</h2>
      <div class="alert good">${icon("check")}<div>${esc(label)} can now sign in as
        <strong>${esc(targetUser)}</strong>.</div></div>
      <p class="muted small">Fingerprint</p>
      <p><code class="secret">${esc(fingerprint)}</code></p>
      <h3>Connect over SSH</h3>
      <pre>ssh -i ~/.ssh/contabo_vps ${esc(targetUser)}@${esc(publicHost)}</pre>
      <h3>Connect over Remote Desktop</h3>
      <p class="muted small">RDP is not exposed to the internet. Open a tunnel first, then
        point Remote Desktop at <code>127.0.0.1:13389</code>.</p>
      <pre>ssh -N -L 13389:127.0.0.1:3389 ${esc(targetUser)}@${esc(publicHost)}</pre>
    </div>`
  );

/* ---------------------------------------------------------------- audit --- */

exports.audit = ({ csrf, user, entries, err, logins }) =>
  shell(
    "Audit log",
    `${err ? `<div class="alert bad">${icon("alert")}<div>${esc(err)}</div></div>` : ""}
    ${card(
      "Privileged actions",
      entries.length
        ? `<table class="rows">
            <thead><tr><th>When</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>${entries
              .map(
                (e) => `<tr>
                  <td class="mono small">${esc(stamp(e.ts))}</td>
                  <td><span class="pill ${
                    String(e.action).includes("remove") || String(e.action).includes("delete")
                      ? "bad"
                      : "ok"
                  }">${esc(e.action)}</span></td>
                  <td class="mono small">${esc(JSON.stringify(e.detail))}</td>
                </tr>`
              )
              .join("")}</tbody></table>`
        : `<p class="muted">Nothing recorded yet.</p>`,
      { icon: "audit" }
    )}
    ${card(
      "Sign-in history",
      logins.length
        ? `<table class="rows">
            <thead><tr><th>When</th><th>IP</th><th>User</th><th>Result</th></tr></thead>
            <tbody>${logins
              .map(
                (l) => `<tr>
                  <td class="mono small">${esc(stamp(l.ts))}</td>
                  <td class="mono small">${esc(l.ip || "—")}</td>
                  <td>${esc(l.username || "—")}</td>
                  <td><span class="pill ${l.outcome === "success" ? "ok" : "bad"}">${esc(l.outcome)}</span>
                    ${l.detail ? `<span class="muted small"> ${esc(l.detail)}</span>` : ""}</td>
                </tr>`
              )
              .join("")}</tbody></table>`
        : `<p class="muted">No sign-ins recorded.</p>`,
      { icon: "keys" }
    )}`,
    {
      user,
      csrf,
      active: "audit",
      heading: "Audit log",
      subtitle: "Every privileged action taken through this panel.",
    }
  );
