"use strict";
/**
 * Users, roles, and your own account.
 *
 * Two rules run through all of it. Passwords and TOTP secrets are shown exactly
 * once, at the moment they are created, and never again -- there is no "reveal"
 * anywhere on these pages, because a panel that can show you a secret is a
 * panel an attacker can ask to show them one. And every screen that removes
 * access says plainly what breaks, since "disable user" reads harmless right up
 * until it locks the last administrator out of their own machine.
 */

const { esc, shell, card, flashes, icon, stamp, ago, empty, enrolSteps } = require("./ui");
const rbac = require("./rbac");

const roleBadge = (role) =>
  role
    ? `<span class="pill ${role.builtin ? "brand" : "neutral"}">${esc(role.label)}</span>`
    : `<span class="pill bad">no role</span>`;

/** A permission count that reads honestly for the wildcard administrator. */
function permCount(role) {
  if (!role) return "0";
  if (role.permissions.includes("*")) return "all";
  return String(role.permissions.length);
}

/* ---------------------------------------------------------------- users --- */

exports.users = ({ csrf, user, users, roles, missingEmail = 0, flash, err }) =>
  shell(
    "Users",
    `${flashes({ msg: flash, err })}
    ${
      missingEmail
        ? `<div class="alert warn">${icon("alert")}<div>${missingEmail} account${
            missingEmail === 1 ? " has" : "s have"
          } no email address yet. It is what the authenticator app shows beside the
           code, so add it from ${missingEmail === 1 ? "that account" : "each account"} below.
           Sign-in is unaffected either way.</div></div>`
        : ""
    }

    ${card(
      "People with access",
      users.length
        ? `<table class="rows">
            <thead><tr>
              <th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th>
            </tr></thead>
            <tbody>${users
              .map(
                (u) => `<tr>
                  <td>
                    <div class="row-title">${esc(u.display_name || u.username)}</div>
                    <div class="muted small mono">${esc(u.username)}</div>
                    <div class="muted small">${
                      u.email
                        ? esc(u.email)
                        : `<span class="pill warn">no email</span>`
                    }</div>
                  </td>
                  <td>${roleBadge(u.role)}
                    <div class="muted small">${permCount(u.role)} permission${
                      permCount(u.role) === "1" ? "" : "s"
                    }</div></td>
                  <td>${
                    u.disabled
                      ? `<span class="pill bad">disabled</span>`
                      : u.totp_confirmed
                        ? `<span class="pill ok">active</span>`
                        : `<span class="pill warn">enrolment pending</span>`
                  }</td>
                  <td class="mono small">${u.last_login_at ? esc(ago(u.last_login_at)) : "never"}</td>
                  <td class="right"><a class="btn small" href="/users/${u.id}">${icon(
                    "edit"
                  )} Manage</a></td>
                </tr>`
              )
              .join("")}</tbody></table>`
        : empty("users", "No users yet", "Add someone to give them access to this panel."),
      {
        icon: "users",
        actions: `<a class="btn primary small" href="/users/new">${icon("plus")} Add user</a>`,
      }
    )}

    ${card(
      "How access works",
      `<p class="muted">A user has exactly one role, and the role carries the permissions and
        the scope. To give someone access to only one agent, make a role whose agent scope
        names that agent rather than making a per-person exception — scopes are visible on
        the roles page, one-off exceptions are visible nowhere.</p>
      <div class="chips">${roles
        .map(
          (r) =>
            `<a class="chip-link" href="/roles/${r.id}">${esc(r.label)}
               <span class="muted">${r.user_count} user${r.user_count === 1 ? "" : "s"}</span></a>`
        )
        .join("")}</div>`,
      { icon: "info" }
    )}`,
    {
      user,
      csrf,
      active: "users",
      heading: "Users",
      subtitle: "Who can sign in to MONI AI OS, and what they are allowed to do once they are in.",
    }
  );

exports.userNew = ({ csrf, user, roles, form = {}, errors = [] }) =>
  shell(
    "Add user",
    `${errors.length ? `<div class="alert bad">${icon("alert")}<div>${errors.map(esc).join("<br>")}</div></div>` : ""}

    ${card(
      "New user",
      `<form method="post" action="/users/new">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <div class="grid cols-2">
          <label>Username <span class="hint">what they type to sign in</span>
            <input name="username" value="${esc(form.username || "")}" required
              pattern="[a-zA-Z0-9._\\-]{3,32}" autocomplete="off"></label>
          <label>Display name <span class="hint">optional</span>
            <input name="display_name" value="${esc(form.display_name || "")}"></label>
        </div>
        <label>Email
          <span class="hint">what their authenticator app shows beside the code</span>
          <input name="email" type="email" value="${esc(form.email || "")}" required
            autocomplete="off" spellcheck="false" placeholder="name@company.com"></label>
        <label>Role
          <select name="role_id">
            ${roles
              .map(
                (r) =>
                  `<option value="${r.id}"${
                    String(form.role_id) === String(r.id) ? " selected" : ""
                  }>${esc(r.label)} — ${esc(r.description || permCount(r) + " permissions")}</option>`
              )
              .join("")}
          </select></label>
        <label>Temporary password <span class="hint">shown once, on the next screen — send it over a channel they already trust</span>
          <input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
        <button class="btn primary" type="submit">${icon("save")} Create user</button>
      </form>`,
      { icon: "user" }
    )}

    ${card(
      "What happens next",
      `<ol class="steps">
        <li>You get a one-time enrolment link and QR code for their authenticator app.</li>
        <li>They scan it and confirm a code — until then the account cannot sign in.</li>
        <li>They sign in with the temporary password and change it from their account page.</li>
      </ol>
      <p class="muted small">Two-factor is not optional here. Every account on this panel can
        reach something worth protecting, so there is no path that skips enrolment.</p>`,
      { icon: "guide" }
    )}`,
    {
      user,
      csrf,
      active: "users",
      heading: "Add user",
      subtitle: "Creates the account and starts authenticator enrolment.",
      actions: `<a class="btn" href="/users">${icon("chevron")} All users</a>`,
    }
  );

exports.userEnrol = ({ csrf, user, target, qr, secret, password }) =>
  shell(
    "Enrol " + target.username,
    `<div class="alert good">${icon("check")}<div>
      <strong>${esc(target.username)}</strong> has been created. Everything on this page is
      shown once — leave it before handing it over and you will have to reset both.</div></div>

    ${card(
      "Hand these over",
      `<div class="grid cols-2">
        <div>
          <p class="muted small">Temporary password</p>
          <pre class="secret">${esc(password)}</pre>
          <p class="muted small">Authenticator secret, if they cannot scan</p>
          <pre class="secret">${esc(secret)}</pre>
        </div>
        <div class="qr-wrap">
          <img class="qr" src="${esc(qr)}" alt="Authenticator enrolment QR code" width="200" height="200">
        </div>
      </div>
      ${enrolSteps(target.email)}`,
      { icon: "lock" }
    )}

    ${card(
      "Then",
      `<p>They sign in at this panel's address with the username and temporary password, and the
        first code from their authenticator. The account is marked <em>enrolment pending</em>
        until that first successful sign-in.</p>
      <div class="btn-row">
        <a class="btn primary" href="/users">${icon("check")} Done</a>
        <a class="btn" href="/users/${target.id}">Manage this user</a>
      </div>`,
      { icon: "guide" }
    )}`,
    {
      user,
      csrf,
      active: "users",
      heading: "Enrolment for " + target.username,
      subtitle: "Shown once. There is no way to display these again.",
    }
  );

exports.userDetail = ({ csrf, user, target, roles, isSelf, lastAdmin, flash, err }) =>
  shell(
    target.username,
    `${flashes({ msg: flash, err })}
    ${
      lastAdmin
        ? `<div class="alert warn">${icon("alert")}<div>This is the last active administrator.
           The role cannot be changed and the account cannot be disabled or deleted until
           another administrator exists — otherwise nobody can administer the machine.</div></div>`
        : ""
    }

    ${card(
      "Account",
      `<table class="kv">
        <tr><td>Username</td><td class="mono">${esc(target.username)}</td></tr>
        <tr><td>Email</td><td class="mono small">${
          target.email
            ? esc(target.email)
            : `<span class="pill warn">not set</span>`
        }</td></tr>
        <tr><td>Role</td><td>${roleBadge(target.role)}</td></tr>
        <tr><td>Status</td><td>${
          target.disabled
            ? `<span class="pill bad">disabled</span>`
            : `<span class="pill ok">enabled</span>`
        }</td></tr>
        <tr><td>Two-factor</td><td>${
          target.totp_confirmed
            ? `<span class="pill ok">enrolled</span>`
            : `<span class="pill warn">not yet enrolled</span>`
        }</td></tr>
        <tr><td>Created</td><td class="mono small">${esc(stamp(target.created_at))}${
          target.created_by ? ` by ${esc(target.created_by)}` : ""
        }</td></tr>
        <tr><td>Last sign-in</td><td class="mono small">${
          target.last_login_at ? esc(stamp(target.last_login_at)) : "never"
        }</td></tr>
      </table>`,
      { icon: "user" }
    )}

    ${card(
      "Role and status",
      `<form method="post" action="/users/${target.id}">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Display name
          <input name="display_name" value="${esc(target.display_name || "")}"></label>
        <label>Email
          <span class="hint">what their authenticator app shows beside the code${
            target.totp_confirmed
              ? " — changing it does not disturb an enrolled phone"
              : ""
          }</span>
          <input name="email" type="email" value="${esc(target.email || "")}" required
            autocomplete="off" spellcheck="false" placeholder="name@company.com"></label>
        <label>Role
          <select name="role_id"${lastAdmin ? " disabled" : ""}>
            ${roles
              .map(
                (r) =>
                  `<option value="${r.id}"${r.id === target.role_id ? " selected" : ""}>${esc(
                    r.label
                  )}</option>`
              )
              .join("")}
          </select>${lastAdmin ? `<input type="hidden" name="role_id" value="${target.role_id}">` : ""}
        </label>
        <label class="check">
          <input type="checkbox" name="disabled" value="1"${target.disabled ? " checked" : ""}${
            lastAdmin || isSelf ? " disabled" : ""
          }>
          <span>Disabled — keeps the account and its history, blocks sign-in${
            isSelf ? " (you cannot disable yourself)" : ""
          }</span></label>
        <button class="btn primary" type="submit">${icon("save")} Save</button>
      </form>`,
      { icon: "shield" }
    )}

    ${card(
      "Recovery",
      `<p class="muted small">Both of these invalidate what the user currently has. Use them when
        someone has lost a device or a password, not as routine maintenance.</p>
      <div class="grid cols-2">
        <form method="post" action="/users/${target.id}/password">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <label>New temporary password
            <input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
          <button class="btn" type="submit">${icon("lock")} Reset password</button>
        </form>
        <form method="post" action="/users/${target.id}/totp"
              data-confirm="Reset two-factor for ${esc(target.username)}? Their current authenticator stops working immediately.">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <p class="muted small">Resetting two-factor issues a new secret and blocks sign-in until
            they enrol again.</p>
          <button class="btn" type="submit">${icon("reindex")} Reset two-factor</button>
        </form>
      </div>`,
      { icon: "lock" }
    )}

    ${
      isSelf || lastAdmin
        ? ""
        : card(
            "Delete",
            `<p class="muted small">Removes the account outright. Their entries in the sign-in log
              stay, because an audit trail you can delete is not one.</p>
            <form method="post" action="/users/${target.id}/delete"
                  data-confirm="Delete ${esc(target.username)}? This cannot be undone.">
              <input type="hidden" name="_csrf" value="${esc(csrf)}">
              <button class="btn danger" type="submit">${icon("trash")} Delete user</button>
            </form>`,
            { icon: "trash", className: "danger-zone" }
          )
    }`,
    {
      user,
      csrf,
      active: "users",
      heading: target.display_name || target.username,
      subtitle: "Account, role, and recovery.",
      actions: `<a class="btn" href="/users">${icon("chevron")} All users</a>`,
    }
  );

/* ---------------------------------------------------------------- roles --- */

exports.roles = ({ csrf, user, roles, flash, err }) =>
  shell(
    "Roles",
    `${flashes({ msg: flash, err })}

    ${card(
      "Roles",
      `<table class="rows">
        <thead><tr><th>Role</th><th>Permissions</th><th>Scope</th><th>Users</th><th></th></tr></thead>
        <tbody>${roles
          .map(
            (r) => `<tr>
              <td>
                <div class="row-title">${esc(r.label)} ${
                  r.builtin ? `<span class="pill brand">built-in</span>` : ""
                }</div>
                <div class="muted small">${esc(r.description || "—")}</div>
              </td>
              <td>${esc(permCount(r))}</td>
              <td class="mono small">
                agents: ${esc(rbac.scopeLabel(rbac.parseScope(r.agent_scope)))}<br>
                channels: ${esc(rbac.scopeLabel(rbac.parseScope(r.channel_scope)))}
              </td>
              <td>${r.user_count}</td>
              <td class="right"><a class="btn small" href="/roles/${r.id}">${icon("edit")} ${
                r.builtin ? "View" : "Edit"
              }</a></td>
            </tr>`
          )
          .join("")}</tbody></table>`,
      {
        icon: "shield",
        actions: `<a class="btn primary small" href="/roles/new">${icon("plus")} New role</a>`,
      }
    )}

    ${card(
      "Scopes",
      `<p class="muted">A permission says what someone may do; a scope says which agents and
        channels they may do it to. <code>*</code> means everything, including agents created
        later. A named list means exactly those — an agent added tomorrow will not appear for
        that role until you add it here, which is the point.</p>`,
      { icon: "info" }
    )}`,
    {
      user,
      csrf,
      active: "roles",
      heading: "Roles",
      subtitle: "Permission sets you assign to users. Change a role and everyone holding it changes with it.",
    }
  );

/**
 * The role editor. Built-in administrator renders read-only: it is the account
 * of last resort, and a UI that lets you take permissions away from it is a UI
 * that lets you lock yourself out of your own machine at 2am.
 */
exports.roleEdit = ({ csrf, user, role, agents, channels, isNew, readOnly, errors = [], flash }) => {
  const held = new Set(role.permissions || []);
  const wildcard = held.has("*");
  const agentScope = rbac.parseScope(role.agent_scope);
  const channelScope = rbac.parseScope(role.channel_scope);

  const scopePicker = (name, scope, options, label, emptyNote) => {
    const all = scope === "*";
    return `<fieldset class="scope">
      <legend>${esc(label)}</legend>
      <label class="check">
        <input type="radio" name="${name}_mode" value="all"${all ? " checked" : ""}${
          readOnly ? " disabled" : ""
        }>
        <span>All — including any created later</span></label>
      <label class="check">
        <input type="radio" name="${name}_mode" value="list"${!all ? " checked" : ""}${
          readOnly ? " disabled" : ""
        }>
        <span>Only the ones ticked below</span></label>
      <div class="scope-list">
        ${
          options.length
            ? options
                .map(
                  (o) => `<label class="check">
                    <input type="checkbox" name="${name}" value="${esc(o.slug)}"${
                      !all && scope.includes(o.slug) ? " checked" : ""
                    }${readOnly ? " disabled" : ""}>
                    <span>${esc(o.name || o.slug)} <span class="muted mono small">${esc(
                      o.slug
                    )}</span></span></label>`
                )
                .join("")
            : `<p class="muted small">${esc(emptyNote)}</p>`
        }
      </div>
    </fieldset>`;
  };

  return shell(
    isNew ? "New role" : role.label,
    `${flashes({ msg: flash, err: null })}
    ${errors.length ? `<div class="alert bad">${icon("alert")}<div>${errors.map(esc).join("<br>")}</div></div>` : ""}
    ${
      readOnly
        ? `<div class="alert info">${icon("info")}<div>The administrator role is fixed. It holds
           every permission — including ones added by future updates — and is shown here so you
           can see what that means, not so you can pare it down.</div></div>`
        : ""
    }

    <form method="post" action="${isNew ? "/roles/new" : "/roles/" + role.id}">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">

      ${card(
        "Identity",
        `<div class="grid cols-2">
          <label>Name <span class="hint">${
            isNew ? "lowercase, used internally" : "cannot be changed"
          }</span>
            <input name="name" value="${esc(role.name || "")}"${
              // The hyphen is escaped because browsers compile `pattern` with
              // the `v` flag, where a trailing `-` in a character class is a
              // syntax error rather than a literal. An uncompilable pattern is
              // silently ignored, so the field would have accepted anything.
              isNew ? " required pattern=\"[a-z0-9_\\-]{2,32}\"" : " disabled"
            }></label>
          <label>Label <span class="hint">what people see</span>
            <input name="label" value="${esc(role.label || "")}" required${
              readOnly ? " disabled" : ""
            }></label>
        </div>
        <label>Description
          <input name="description" value="${esc(role.description || "")}"${
            readOnly ? " disabled" : ""
          }></label>`,
        { icon: "shield" }
      )}

      ${card(
        "Permissions",
        wildcard
          ? `<p class="muted">This role holds every permission on the system.</p>`
          : rbac.PERMISSION_GROUPS.map(
              (g) => `<div class="perm-group">
                <div class="perm-head">
                  <h3>${esc(g.label)}</h3>
                  ${g.blurb ? `<p class="muted small">${esc(g.blurb)}</p>` : ""}
                </div>
                ${g.perms
                  .map(
                    (p) => `<label class="check perm">
                      <input type="checkbox" name="permissions" value="${esc(p.key)}"${
                        held.has(p.key) ? " checked" : ""
                      }${readOnly ? " disabled" : ""}>
                      <span>
                        <span class="perm-label">${esc(p.label)}</span>
                        ${p.hint ? `<span class="muted small">${esc(p.hint)}</span>` : ""}
                      </span>
                    </label>`
                  )
                  .join("")}
              </div>`
            ).join(""),
        {
          icon: "lock",
          actions: wildcard
            ? ""
            : `<span class="muted small">Ticking a permission also grants what it needs to work.</span>`,
        }
      )}

      ${card(
        "Scope",
        wildcard
          ? `<p class="muted">All agents and all channels.</p>`
          : `<div class="grid cols-2">
              ${scopePicker("agent_scope", agentScope, agents, "Agents", "No agents exist yet.")}
              ${scopePicker("channel_scope", channelScope, channels, "Channels", "No channels exist yet.")}
            </div>`,
        { icon: "eye" }
      )}

      ${
        readOnly
          ? ""
          : `<div class="btn-row">
              <button class="btn primary" type="submit">${icon("save")} ${
                isNew ? "Create role" : "Save role"
              }</button>
              <a class="btn" href="/roles">Cancel</a>
            </div>`
      }
    </form>

    ${
      !isNew && !readOnly
        ? card(
            "Delete",
            role.user_count
              ? `<p class="muted small">${role.user_count} user${
                  role.user_count === 1 ? " holds" : "s hold"
                } this role. Move them to another role first.</p>`
              : `<form method="post" action="/roles/${role.id}/delete"
                       data-confirm="Delete the ${esc(role.label)} role?">
                  <input type="hidden" name="_csrf" value="${esc(csrf)}">
                  <button class="btn danger" type="submit">${icon("trash")} Delete role</button>
                </form>`,
            { icon: "trash", className: "danger-zone" }
          )
        : ""
    }`,
    {
      user,
      csrf,
      active: "roles",
      heading: isNew ? "New role" : role.label,
      subtitle: isNew
        ? "Start from nothing and grant only what the job needs."
        : "Changes take effect on the holder's next request.",
      actions: `<a class="btn" href="/roles">${icon("chevron")} All roles</a>`,
    }
  );
};

/* -------------------------------------------------------------- account --- */

exports.account = ({ csrf, user, me, flash, err }) =>
  shell(
    "Your account",
    `${flashes({ msg: flash, err })}

    ${card(
      "Signed in as",
      `<table class="kv">
        <tr><td>Username</td><td class="mono">${esc(me.username)}</td></tr>
        <tr><td>Email</td><td class="mono small">${
          me.email ? esc(me.email) : `<span class="pill warn">not set</span>`
        }</td></tr>
        <tr><td>Role</td><td>${roleBadge(me.role)}</td></tr>
        <tr><td>Agent scope</td><td class="mono small">${esc(
          rbac.scopeLabel(rbac.parseScope(me.agent_scope))
        )}</td></tr>
        <tr><td>Channel scope</td><td class="mono small">${esc(
          rbac.scopeLabel(rbac.parseScope(me.channel_scope))
        )}</td></tr>
        <tr><td>Last sign-in</td><td class="mono small">${
          me.last_login_at ? esc(stamp(me.last_login_at)) : "—"
        }</td></tr>
      </table>`,
      { icon: "user" }
    )}

    ${card(
      "Change password",
      `<form method="post" action="/account/password" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Current password
          <input name="current" type="password" required autocomplete="current-password"></label>
        <div class="grid cols-2">
          <label>New password <span class="hint">at least 12 characters</span>
            <input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
          <label>Repeat new password
            <input name="password2" type="password" minlength="12" required autocomplete="new-password"></label>
        </div>
        <button class="btn primary" type="submit">${icon("save")} Change password</button>
      </form>`,
      { icon: "lock" }
    )}

    ${card(
      "Authenticator",
      `<p class="muted">Your codes come from an authenticator app on your phone —
        Microsoft Authenticator, or any other. They gate sign-in, and they are also
        what unlocks root in a console chat, so moving them is worth doing carefully.</p>
      <p class="muted small">Moving does not take effect until a code from the new app
        is accepted, so if something goes wrong halfway your current app keeps working.</p>
      <div class="btn-row">
        <a class="btn" href="/account/authenticator">${icon("reindex")} Move to another app or phone</a>
      </div>`,
      { icon: "devices" }
    )}

    ${card(
      "What you can do",
      me.role && me.role.permissions.includes("*")
        ? `<p class="muted">Everything. You hold the administrator role.</p>`
        : `<div class="chips">${(me.role ? me.role.permissions : [])
            .map(
              (p) =>
                `<span class="chip-static">${esc(rbac.PERMISSION_LABEL[p] || p)}</span>`
            )
            .join("")}</div>`,
      { icon: "eye" }
    )}`,
    {
      user,
      csrf,
      active: null,
      heading: me.display_name || me.username,
      subtitle: "Your own credentials and what your role permits.",
    }
  );

/* ------------------------------------------- moving your authenticator --- */

/**
 * Step one: prove it is you, with both factors.
 *
 * The password alone would let a session left open on an unlocked desk move the
 * second factor to somebody else's phone, which is precisely what the second
 * factor is for. So this asks for a current code as well.
 */
exports.reenrolStart = ({ csrf, user, me, err }) =>
  shell(
    "Move your authenticator",
    `${flashes({ err })}
    ${card(
      "Confirm it is you",
      `<p class="muted">This moves your codes to a different app or phone. Nothing changes
        until the new app produces a code this panel accepts — your current one keeps
        working until then.</p>
      <form method="post" action="/account/authenticator" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Your password
          <input name="password" type="password" required autocomplete="current-password" autofocus></label>
        <label>A code from the authenticator you have now
          <span class="hint">proves the old device is still in your hands</span>
          <input name="code" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000"
            required autocomplete="one-time-code"></label>
        <button class="btn primary" type="submit">${icon("chevron")} Continue</button>
      </form>`,
      { icon: "lock" }
    )}`,
    {
      user,
      csrf,
      active: null,
      heading: "Move your authenticator",
      subtitle: "For a new phone, or to switch to Microsoft Authenticator.",
      actions: `<a class="btn" href="/account">${icon("chevron")} Your account</a>`,
    }
  );

/** Step two: scan, then prove the new app works before anything is replaced. */
exports.reenrolScan = ({ csrf, user, me, qr, secret, err }) =>
  shell(
    "Scan the new code",
    `${flashes({ err })}
    <div class="alert warn">${icon("alert")}<div>Your current authenticator is still the
      live one. It is replaced the moment a code from the new app is accepted below, and
      not before — so do not delete the old entry until this page says it is done.</div></div>

    ${card(
      "Add it to your authenticator",
      `<div class="grid cols-2">
        <div>
          ${enrolSteps(me.email)}
          <p class="muted small">Can't scan? Enter this secret by hand:</p>
          <pre class="secret">${esc(secret)}</pre>
        </div>
        <div class="qr-wrap">
          <img class="qr" src="${esc(qr)}" alt="Authenticator enrolment QR code" width="200" height="200">
        </div>
      </div>
      <form method="post" action="/account/authenticator/confirm" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Code from the new app
          <input name="code" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000"
            required autofocus autocomplete="one-time-code"></label>
        <button class="btn primary" type="submit">${icon("check")} Finish the move</button>
      </form>`,
      { icon: "devices" }
    )}`,
    {
      user,
      csrf,
      active: null,
      heading: "Scan the new code",
      subtitle: "This page expires in 15 minutes. Leaving it changes nothing.",
      actions: `<a class="btn" href="/account">${icon("chevron")} Cancel</a>`,
    }
  );

/** Shown when a route is reachable but the actor's role does not permit it. */
exports.denied = ({ csrf, user, perm }) =>
  shell(
    "Not permitted",
    card(
      "Not permitted",
      `<p>Your role does not include <code>${esc(perm)}</code>, so this page is not available
        to you.</p>
      <p class="muted small">If that is wrong, an administrator can change it on the
        roles page — permissions belong to roles here, not to people, so the fix is a role
        change rather than an exception.</p>
      <div class="btn-row"><a class="btn primary" href="/">${icon("chevron")} Back</a></div>`,
      { icon: "ban" }
    ),
    { user, csrf, active: null, heading: "Not permitted", subtitle: "Access is decided by your role." }
  );
