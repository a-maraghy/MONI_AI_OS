"use strict";
/**
 * Microsoft sign-in settings.
 *
 * The page has to carry its own setup instructions, because everything it asks
 * for comes from somewhere else: three values copied out of an app registration
 * in the Azure portal. Sending somebody to "configure Entra" and giving them
 * four empty boxes is how a feature ends up switched off forever.
 */

const { esc, shell, card, flashes, icon, stamp } = require("./ui");

const yes = (on, good = "yes", bad = "no") =>
  on ? `<span class="pill ok">${good}</span>` : `<span class="pill warn">${bad}</span>`;

exports.index = ({ csrf, user, cfg, canManage, users, flash, err }) => {
  const withoutEmail = users.filter((u) => !u.email && !u.disabled);

  return shell(
    "Microsoft sign-in",
    `${flashes({ msg: flash, err })}

    ${
      cfg.active
        ? `<div class="alert good">${icon("check")}<div>Microsoft sign-in is on. The sign-in
           page shows a <strong>Sign in with Microsoft</strong> button, and the username,
           password and code form stays underneath it as the fallback.</div></div>`
        : cfg.configured
          ? `<div class="alert warn">${icon("alert")}<div>Configured but switched off. Nothing
             about the sign-in page has changed yet.</div></div>`
          : `<div class="alert info">${icon("info")}<div>Not configured. Fill in the three
             values below — they come from an app registration in the Azure portal, and the
             steps are at the bottom of this page.</div></div>`
    }

    ${
      withoutEmail.length
        ? `<div class="alert warn">${icon("alert")}<div>${withoutEmail.length} enabled
           account${withoutEmail.length === 1 ? " has" : "s have"} no email address, so
           ${withoutEmail.length === 1 ? "it" : "they"} cannot be matched to a Microsoft
           identity and will only ever sign in with a code.
           <a href="/users">Add addresses</a>.</div></div>`
        : ""
    }

    ${card(
      "Current state",
      `<table class="kv">
        <tr><td>Status</td><td>${
          cfg.active
            ? `<span class="pill ok">on</span>`
            : `<span class="pill neutral">off</span>`
        }</td></tr>
        <tr><td>Directory (tenant) ID</td><td class="mono small">${
          esc(cfg.tenant_id) || `<span class="muted">not set</span>`
        }</td></tr>
        <tr><td>Application (client) ID</td><td class="mono small">${
          esc(cfg.client_id) || `<span class="muted">not set</span>`
        }</td></tr>
        <tr><td>Client secret</td><td>${
          cfg.secret_set
            ? `<span class="pill ok">set</span>
               <span class="muted mono small"> ${esc(cfg.secret_hint)} · ${cfg.secret_length} characters</span>`
            : `<span class="pill bad">not set</span>`
        }</td></tr>
        <tr><td>Require a second factor</td><td>${yes(cfg.require_mfa, "yes", "no — accepts single factor")}</td></tr>
        <tr><td>Force a fresh prompt</td><td>${yes(cfg.force_prompt, "yes", "no — may reuse an existing session")}</td></tr>
      </table>`,
      { icon: "lock" }
    )}

    ${card(
      "Redirect URI",
      `<p class="muted">Paste this into the app registration exactly as it appears. Entra
        matches it character for character and refuses the sign-in if it differs by so much
        as a trailing slash.</p>
      <pre class="secret">${esc(cfg.redirect_uri)}</pre>
      ${
        cfg.redirect_uri !== cfg.default_redirect_uri
          ? `<p class="muted small">Overridden. The address this panel would derive from its
             own configuration is <span class="mono">${esc(cfg.default_redirect_uri)}</span>.</p>`
          : ""
      }`,
      { icon: "link" }
    )}

    ${
      canManage
        ? card(
            "Settings",
            `<form method="post" action="/sso">
              <input type="hidden" name="_csrf" value="${esc(csrf)}">
              <div class="grid cols-2">
                <label>Directory (tenant) ID
                  <span class="hint">Overview → Directory (tenant) ID</span>
                  <input name="tenant_id" value="${esc(cfg.tenant_id)}" autocomplete="off"
                    spellcheck="false" placeholder="00000000-0000-0000-0000-000000000000"></label>
                <label>Application (client) ID
                  <span class="hint">Overview → Application (client) ID</span>
                  <input name="client_id" value="${esc(cfg.client_id)}" autocomplete="off"
                    spellcheck="false" placeholder="00000000-0000-0000-0000-000000000000"></label>
              </div>
              <label>Client secret
                <span class="hint">${
                  cfg.secret_set
                    ? "one is stored — leave this blank to keep it"
                    : "Certificates &amp; secrets → New client secret → copy the Value, not the Secret ID"
                }</span>
                <input name="client_secret" type="password" autocomplete="new-password"
                  placeholder="${cfg.secret_set ? "unchanged" : ""}"></label>
              <label>Redirect URI <span class="hint">leave blank to use the derived one above</span>
                <input name="redirect_uri" value="${
                  cfg.redirect_uri === cfg.default_redirect_uri ? "" : esc(cfg.redirect_uri)
                }" autocomplete="off" spellcheck="false"
                  placeholder="${esc(cfg.default_redirect_uri)}"></label>

              <label class="check">
                <input type="checkbox" name="require_mfa" value="1"${cfg.require_mfa ? " checked" : ""}>
                <span>Only accept a sign-in where Microsoft used a second factor — without
                  this, a tenant with no MFA policy turns the button into single-factor
                  access to a root console</span></label>
              <label class="check">
                <input type="checkbox" name="force_prompt" value="1"${cfg.force_prompt ? " checked" : ""}>
                <span>Ask Microsoft for a fresh sign-in every time — off, an existing browser
                  session answers instantly and no prompt reaches your phone</span></label>
              <label class="check">
                <input type="checkbox" name="enabled" value="1"${cfg.enabled ? " checked" : ""}>
                <span>Show the Microsoft button on the sign-in page</span></label>

              <button class="btn primary" type="submit">${icon("save")} Save</button>
            </form>`,
            { icon: "settings" }
          )
        : ""
    }

    ${card(
      "How to register the app",
      `<ol class="steps">
        <li>In the <strong>Azure portal</strong> → <strong>Microsoft Entra ID</strong> →
          <strong>App registrations</strong> → <strong>New registration</strong>.</li>
        <li>Name it anything (<span class="mono">MONI AI OS</span>), and under supported account
          types choose <strong>Accounts in this organizational directory only</strong>.</li>
        <li>Platform <strong>Web</strong>, redirect URI exactly the value shown above.</li>
        <li>Register. Copy the <strong>Directory (tenant) ID</strong> and the
          <strong>Application (client) ID</strong> from the Overview page.</li>
        <li><strong>Certificates &amp; secrets</strong> → <strong>New client secret</strong>.
          Copy the <strong>Value</strong> — it is shown once and never again, and the
          <em>Secret ID</em> beside it is not the thing you want.</li>
        <li>Paste all three above and tick the last box.</li>
      </ol>
      <p class="muted small">No API permissions to grant: <span class="mono">openid</span>,
        <span class="mono">profile</span> and <span class="mono">email</span> need no admin
        consent. Registering an app needs the Application Developer or Global Administrator
        role in the tenant.</p>`,
      { icon: "guide" }
    )}

    ${card(
      "What this changes, and what it does not",
      `<ul>
        <li>Signing in with Microsoft <strong>never creates an account</strong>. The address
          in the token has to already belong to an enabled user here, or the sign-in is
          refused — otherwise everybody in the tenant becomes an administrator of this
          machine the moment it is switched on.</li>
        <li>The push itself comes from your tenant's policy, not from this panel. If nobody
          is prompted on their phone, the fix is a Conditional Access rule or per-user MFA in
          Entra requiring multi-factor for this application.</li>
        <li>Codes keep working. The username, password and code form stays on the sign-in
          page for when the phone is flat, offline, or Entra is having a bad day.</li>
        <li><strong>Root in a console chat stays on the code.</strong> Unlocking it means
          typing something this panel can verify by itself, and a Microsoft approval produces
          no such thing — so your authenticator entry still matters even if you never use the
          form again.</li>
      </ul>`,
      { icon: "info" }
    )}`,
    {
      user,
      csrf,
      active: "sso",
      heading: "Microsoft sign-in",
      subtitle:
        "Hand sign-in to your Entra tenant so the second factor can be an Authenticator push.",
    }
  );
};
