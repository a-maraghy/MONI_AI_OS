"use strict";
/** Server-rendered HTML for the system pages. Shared chrome lives in ui.js. */

const { esc, bytes, duration, shell, statusPill, meter } = require("./ui");

exports.error = (title, msg) =>
  shell(title, `<div class="card"><h1>${esc(title)}</h1><p class="muted">${esc(msg)}</p>
    <p><a class="btn" href="/">Back to dashboard</a></p></div>`);

exports.login = ({ csrf, error }) =>
  shell(
    "Sign in",
    `<div class="card narrow">
      <h1>Sign in</h1>
      ${error ? `<div class="alert bad">${esc(error)}</div>` : ""}
      <form method="post" action="/login" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Username<input name="username" autocomplete="username" required autofocus></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <label>Authenticator code<input name="token" inputmode="numeric" pattern="[0-9 ]*"
          placeholder="000000" autocomplete="one-time-code" required></label>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </div>`
  );

exports.setup = ({ csrf, token, errors = [] }) =>
  shell(
    "First-run setup",
    `<div class="card narrow">
      <h1>Create the admin account</h1>
      <p class="muted">This runs once. Afterwards <code>/setup</code> stops working.</p>
      ${errors.length ? `<div class="alert bad">${errors.map(esc).join("<br>")}</div>` : ""}
      <form method="post" action="/setup" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <input type="hidden" name="token" value="${esc(token)}">
        <label>Username<input name="username" required autofocus></label>
        <label>Password <span class="hint">minimum 12 characters</span>
          <input name="password" type="password" required></label>
        <label>Repeat password<input name="password2" type="password" required></label>
        <button class="btn primary" type="submit">Create account</button>
      </form>
    </div>`
  );

exports.totpEnroll = ({ csrf, qr, secret, error }) =>
  shell(
    "Set up two-factor",
    `<div class="card narrow">
      <h1>Set up two-factor authentication</h1>
      <p class="muted">Scan this with Google Authenticator, Authy, 1Password, or any TOTP app.</p>
      ${error ? `<div class="alert bad">${esc(error)}</div>` : ""}
      <div class="qr"><img src="${esc(qr)}" alt="TOTP QR code" width="240" height="240"></div>
      <p class="muted">Can't scan? Enter this secret manually:</p>
      <p><code class="secret">${esc(secret)}</code></p>
      <div class="alert warn">Save this secret somewhere safe. If you lose your
        authenticator and have no copy, you will need SSH access to reset it.</div>
      <form method="post" action="/setup/confirm" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Enter the current 6-digit code to confirm
          <input name="token" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000" required autofocus></label>
        <button class="btn primary" type="submit">Confirm and finish</button>
      </form>
    </div>`
  );

exports.setupDone = () =>
  shell(
    "Setup complete",
    `<div class="card narrow">
      <h1>Setup complete</h1>
      <p>Two-factor authentication is active. You can now sign in.</p>
      <p><a class="btn primary" href="/login">Go to sign in</a></p>
    </div>`
  );

/* ------------------------------------------------------------------------- */

exports.dashboard = ({ csrf, user, stats, status, statusError, logins }) => {
  const svc = status.services || {};
  const jails = status.jails || {};
  const sshd = jails.sshd || { banned: 0, total_failed: 0 };
  const dash = jails["moni-dashboard"];

  return shell(
    "Overview",
    `<h1>Overview</h1>
    <p class="muted">${esc(stats.hostname)} · up ${esc(duration(stats.uptimeSec))} ·
      ${stats.cpus} vCPU · load ${stats.loadavg.map((n) => n.toFixed(2)).join("  ")}</p>

    ${statusError ? `<div class="alert bad">Could not query privileged status: ${esc(statusError)}</div>` : ""}

    <div class="grid" data-live-stats>
      <div class="card">
        <h2>Resources</h2>
        ${meter("memory", "Memory", stats.memUsed, stats.memTotal)}
        ${stats.diskTotal != null ? meter("disk", "Disk /", stats.diskUsed, stats.diskTotal) : ""}
      </div>

      <div class="card">
        <h2>Services</h2>
        <table class="kv">
          ${Object.entries(svc)
            .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${statusPill(v)}</td></tr>`)
            .join("")}
        </table>
      </div>

      <div class="card">
        <h2>Agents</h2>
        <div class="stat"><span class="big">${(status.agents || {}).running || 0}</span><span class="muted">running</span></div>
        <div class="stat"><span class="big">${(status.agents || {}).total || 0}</span><span class="muted">configured</span></div>
        <p><a class="btn small" href="/agents">Manage agents</a></p>
      </div>

      <div class="card">
        <h2>Intrusion attempts</h2>
        <div class="stat"><span class="big" data-stat="banned">${sshd.banned}</span><span class="muted">IPs banned (SSH)</span></div>
        <div class="stat"><span class="big" data-stat="failed">${sshd.total_failed}</span><span class="muted">failed SSH auths</span></div>
        ${dash ? `<div class="stat"><span class="big">${dash.banned}</span><span class="muted">IPs banned (dashboard)</span></div>` : ""}
      </div>
    </div>

    <div class="card">
      <h2>Recent dashboard sign-ins</h2>
      ${
        logins.length
          ? `<table class="rows">
              <thead><tr><th>When</th><th>IP</th><th>User</th><th>Result</th></tr></thead>
              <tbody>${logins
                .map(
                  (l) => `<tr>
                    <td class="mono">${esc(l.ts.replace("T", " ").slice(0, 19))}</td>
                    <td class="mono">${esc(l.ip || "—")}</td>
                    <td>${esc(l.username || "—")}</td>
                    <td><span class="pill ${l.outcome === "success" ? "ok" : "bad"}">${esc(l.outcome)}</span>
                      ${l.detail ? `<span class="muted"> ${esc(l.detail)}</span>` : ""}</td>
                  </tr>`
                )
                .join("")}</tbody></table>`
          : `<p class="muted">No sign-ins recorded yet.</p>`
      }
    </div>`,
    { user, csrf, active: "home" }
  );
};

/* ------------------------------------------------------------------------- */

exports.keys = ({ csrf, user, keys, devices, flash, flashError }) => {
  const deviceByFp = new Map(devices.map((d) => [d.fingerprint, d]));

  const section = (account, list) => `
    <div class="card">
      <h2>${esc(account)} <span class="muted">(${list.length} key${list.length === 1 ? "" : "s"})</span></h2>
      ${
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
                      <form method="post" action="/keys/remove" data-confirm="Revoke this key from ${esc(account)}? Any device using it loses access immediately.">
                        <input type="hidden" name="_csrf" value="${esc(csrf)}">
                        <input type="hidden" name="target_user" value="${esc(account)}">
                        <input type="hidden" name="fingerprint" value="${esc(k.fingerprint)}">
                        <button class="btn danger small" type="submit">Revoke</button>
                      </form>
                    </td>
                  </tr>`;
                })
                .join("")}</tbody></table>`
          : `<p class="muted">No keys.</p>`
      }
    </div>`;

  return shell(
    "SSH Keys",
    `<h1>SSH Keys</h1>
    <p class="muted">Keys authorised to log in. Revoking one takes effect immediately.</p>
    ${flash ? `<div class="alert good">${esc(flash)}</div>` : ""}
    ${flashError ? `<div class="alert bad">${esc(flashError)}</div>` : ""}

    ${Object.entries(keys).map(([acct, list]) => section(acct, list)).join("")}

    <div class="card">
      <h2>Add a key manually</h2>
      <p class="muted">For pairing a device that can't reach this panel, prefer
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
      </form>
    </div>`,
    { user, csrf, active: "keys" }
  );
};

/* ------------------------------------------------------------------------- */

exports.devices = ({ csrf, user, codes, devices, publicHost, publicPort, flash }) => {
  const active = codes.filter((c) => !c.used_at && new Date(c.expires_at) > new Date());
  return shell(
    "Devices",
    `<h1>Devices</h1>
    <p class="muted">Pair a new machine without copying private keys around. Generate a
      code here, then enter it on the new device together with its own public key.</p>

    ${
      flash
        ? `<div class="alert good"><strong>Pairing code:</strong>
             <code class="secret">${esc(flash)}</code><br>
             Valid for 15 minutes, single use. On the new device open
             <code>https://${esc(publicHost)}:${esc(publicPort)}/pair</code></div>`
        : ""
    }

    <div class="card">
      <h2>Generate a pairing code</h2>
      <form method="post" action="/devices/code">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Device label<input name="label" placeholder="e.g. new-laptop" maxlength="64" required></label>
        <label>Grant access to
          <select name="target_user">
            <option value="ubuntu">ubuntu (normal use — recommended)</option>
            <option value="root">root (full privilege)</option>
          </select></label>
        <button class="btn primary" type="submit">Generate code</button>
      </form>
    </div>

    <div class="card">
      <h2>Active codes</h2>
      ${
        active.length
          ? `<table class="rows">
              <thead><tr><th>Code</th><th>Label</th><th>Account</th><th>Expires</th><th></th></tr></thead>
              <tbody>${active
                .map(
                  (c) => `<tr>
                    <td class="mono">${esc(c.code)}</td>
                    <td>${esc(c.label)}</td>
                    <td>${esc(c.target_user)}</td>
                    <td class="mono small">${esc(c.expires_at.replace("T", " ").slice(0, 19))}</td>
                    <td class="right"><form method="post" action="/devices/code/revoke">
                      <input type="hidden" name="_csrf" value="${esc(csrf)}">
                      <input type="hidden" name="code" value="${esc(c.code)}">
                      <button class="btn danger small">Cancel</button></form></td>
                  </tr>`
                )
                .join("")}</tbody></table>`
          : `<p class="muted">No active pairing codes.</p>`
      }
    </div>

    <div class="card">
      <h2>Paired devices</h2>
      ${
        devices.length
          ? `<table class="rows">
              <thead><tr><th>Label</th><th>Account</th><th>Paired</th><th>From IP</th><th>Fingerprint</th></tr></thead>
              <tbody>${devices
                .map(
                  (d) => `<tr>
                    <td>${esc(d.label)}</td>
                    <td>${esc(d.target_user)}</td>
                    <td class="mono small">${esc(d.paired_at.replace("T", " ").slice(0, 19))}</td>
                    <td class="mono small">${esc(d.paired_ip || "—")}</td>
                    <td class="mono small">${esc(d.fingerprint)}</td>
                  </tr>`
                )
                .join("")}</tbody></table>
             <p class="muted">Revoke a device from the <a href="/keys">SSH Keys</a> page.</p>`
          : `<p class="muted">No devices paired through this panel yet.</p>`
      }
    </div>`,
    { user, csrf, active: "devices" }
  );
};

exports.pair = ({ csrf, error }) =>
  shell(
    "Pair this device",
    `<div class="card narrow">
      <h1>Pair this device</h1>
      <p class="muted">Enter the pairing code from the dashboard, and this device's
        <strong>public</strong> key. Never paste a private key here — or anywhere.</p>
      ${error ? `<div class="alert bad">${esc(error)}</div>` : ""}
      <details class="help">
        <summary>How do I get my public key?</summary>
        <p>On Windows PowerShell:</p>
        <pre>ssh-keygen -t ed25519 -f $env:USERPROFILE\\.ssh\\contabo_vps
type $env:USERPROFILE\\.ssh\\contabo_vps.pub</pre>
        <p>On macOS or Linux:</p>
        <pre>ssh-keygen -t ed25519 -f ~/.ssh/contabo_vps
cat ~/.ssh/contabo_vps.pub</pre>
        <p>Copy the whole line that starts with <code>ssh-ed25519</code>.</p>
      </details>
      <form method="post" action="/pair" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Pairing code<input name="code" placeholder="XXXX-XXXX-XXXX" required autofocus></label>
        <label>Public key<textarea name="pubkey" rows="3" placeholder="ssh-ed25519 AAAAC3..." required></textarea></label>
        <button class="btn primary" type="submit">Pair device</button>
      </form>
    </div>`
  );

exports.paired = ({ label, targetUser, fingerprint, publicHost }) =>
  shell(
    "Device paired",
    `<div class="card narrow">
      <h1>Device paired</h1>
      <div class="alert good">${esc(label)} can now sign in as <strong>${esc(targetUser)}</strong>.</div>
      <p class="muted">Fingerprint</p>
      <p><code class="secret">${esc(fingerprint)}</code></p>
      <h2>Connect over SSH</h2>
      <pre>ssh -i ~/.ssh/contabo_vps ${esc(targetUser)}@${esc(publicHost)}</pre>
      <h2>Connect over Remote Desktop</h2>
      <p class="muted">RDP is not exposed to the internet. Open a tunnel first, then
        point Remote Desktop at <code>127.0.0.1:13389</code>.</p>
      <pre>ssh -N -L 13389:127.0.0.1:3389 ${esc(targetUser)}@${esc(publicHost)}</pre>
    </div>`
  );

/* ------------------------------------------------------------------------- */

exports.audit = ({ csrf, user, entries, err, logins }) =>
  shell(
    "Audit",
    `<h1>Audit log</h1>
    <p class="muted">Every privileged action taken through this panel.</p>
    ${err ? `<div class="alert bad">${esc(err)}</div>` : ""}
    <div class="card">
      <h2>Privileged actions</h2>
      ${
        entries.length
          ? `<table class="rows">
              <thead><tr><th>When</th><th>Action</th><th>Detail</th></tr></thead>
              <tbody>${entries
                .map(
                  (e) => `<tr>
                    <td class="mono small">${esc(String(e.ts).replace("T", " ").slice(0, 19))}</td>
                    <td><span class="pill ${String(e.action).startsWith("remove") ? "bad" : "ok"}">${esc(e.action)}</span></td>
                    <td class="mono small">${esc(JSON.stringify(e.detail))}</td>
                  </tr>`
                )
                .join("")}</tbody></table>`
          : `<p class="muted">Nothing recorded yet.</p>`
      }
    </div>
    <div class="card">
      <h2>Sign-in history</h2>
      ${
        logins.length
          ? `<table class="rows">
              <thead><tr><th>When</th><th>IP</th><th>User</th><th>Result</th></tr></thead>
              <tbody>${logins
                .map(
                  (l) => `<tr>
                    <td class="mono small">${esc(l.ts.replace("T", " ").slice(0, 19))}</td>
                    <td class="mono small">${esc(l.ip || "—")}</td>
                    <td>${esc(l.username || "—")}</td>
                    <td><span class="pill ${l.outcome === "success" ? "ok" : "bad"}">${esc(l.outcome)}</span>
                      ${l.detail ? `<span class="muted"> ${esc(l.detail)}</span>` : ""}</td>
                  </tr>`
                )
                .join("")}</tbody></table>`
          : `<p class="muted">No sign-ins recorded.</p>`
      }
    </div>`,
    { user, csrf, active: "audit" }
  );

