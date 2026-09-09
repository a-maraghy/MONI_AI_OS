"use strict";
/**
 * Credential management.
 *
 * The panel shows whether a credential is set, and lets it be replaced. It
 * deliberately never displays one: a token rendered into a page is a token in a
 * screenshot, a proxy log, and a browser scrollback. What you get instead is
 * enough to answer "is this configured, and is it the one I think it is" — a
 * length and the first and last few characters.
 */

const { esc, shell, card, flashes, icon, stamp } = require("./ui");

exports.index = ({ csrf, user, credentials, probe, flash, err }) =>
  shell(
    "Credentials",
    `${flashes({ msg: flash, err })}
    ${
      probe && !probe.claude_credential
        ? `<div class="alert warn">${icon("alert")}<div>No Claude credential is set.
           Agents will start, receive messages, and then fail to answer — the logs say
           <em>authentication</em> when this is the cause.</div></div>`
        : ""
    }

    ${credentials
      .map((c) =>
        card(
          c.label,
          `<table class="kv">
            <tr><td>Status</td><td>${
              c.configured
                ? `<span class="pill ok">configured</span>`
                : `<span class="pill bad">not set</span>`
            }</td></tr>
            <tr><td>File</td><td class="mono small">${esc(c.path)}</td></tr>
            <tr><td>Accepted keys</td><td class="mono small">${c.keys.map(esc).join("<br>")}</td></tr>
          </table>
          <div class="btn-row">
            <a class="btn primary small" href="/credentials/${esc(c.name)}">
              ${icon("edit")} ${c.configured ? "Replace" : "Set"}</a>
          </div>`,
          { icon: "credentials" }
        )
      )
      .join("")}`,
    {
      user,
      csrf,
      active: "credentials",
      heading: "Credentials",
      subtitle:
        "Secrets the agents need. Stored on disk readable only by the agent account, never displayed back.",
    }
  );

exports.detail = ({ csrf, user, credential, flash, err }) => {
  const c = credential;
  const present = c.present || {};

  return shell(
    c.label,
    `${flashes({ msg: flash, err })}

    ${card(
      "Current state",
      `<table class="kv">
        <tr><td>File</td><td class="mono small">${esc(c.path)}</td></tr>
        <tr><td>Exists</td><td>${c.exists ? "yes" : "no"}</td></tr>
        <tr><td>Permissions</td><td class="mono small">${esc(c.mode || "—")}</td></tr>
        <tr><td>Last changed</td><td class="mono small">${esc(stamp(c.modified))}</td></tr>
        ${c.keys
          .map(
            (k) =>
              `<tr><td>${esc(k)}</td><td>${
                present[k]
                  ? `<span class="pill ok">set</span>
                     <span class="mono small muted"> ${esc(present[k].preview)} · ${
                      present[k].length
                    } chars</span>`
                  : `<span class="pill neutral">empty</span>`
              }</td></tr>`
          )
          .join("")}
      </table>`,
      { icon: "info" }
    )}

    ${card(
      "File contents",
      `<p class="muted small">Secret values are masked. Comments and other lines are shown as they are.</p>
       <pre>${esc(c.masked || "(file does not exist yet)")}</pre>`,
      { icon: "file" }
    )}

    ${card(
      "Set a value",
      `<form method="post" action="/credentials/${esc(c.name)}" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Key
          <select name="key">
            ${c.keys
              .map((k) => `<option value="${esc(k)}">${esc(k)}</option>`)
              .join("")}
          </select></label>
        <label>Value <span class="hint">written straight to the file and never shown again</span>
          <input name="value" type="password" placeholder="sk-ant-..." required></label>
        <button class="btn primary" type="submit">${icon("save")} Save credential</button>
      </form>
      <p class="muted small mt-12">Setting one key clears the other —
        the runtime uses whichever it finds, and having both set makes it ambiguous which
        one is actually in use.</p>`,
      { icon: "credentials" }
    )}

    ${
      c.name === "claude"
        ? card(
            "Where to get this",
            `<p>A subscription token is the usual choice — it bills against your Claude plan
              rather than per token.</p>
            <ol class="steps">
              <li>On a machine with a browser, run <code>claude setup-token</code></li>
              <li>Log in and approve when the browser opens</li>
              <li>Copy the <code>sk-ant-oat01-…</code> value it prints and paste it above,
                  with the key set to <code>CLAUDE_CODE_OAUTH_TOKEN</code></li>
            </ol>
            <p class="muted small">Prefer pay-as-you-go API billing instead? Use
              <code>ANTHROPIC_API_KEY</code> with a key from the Anthropic console.</p>
            <div class="alert info">${icon("info")}<div>Changing this affects every agent —
              they all authenticate with the same credential. Running agents pick it up on
              their next restart.</div></div>`,
            { icon: "guide" }
          )
        : ""
    }

    ${
      Object.keys(present).length
        ? card(
            "Remove",
            `<p class="muted small">Clearing the credential stops every agent from being
              able to answer. They keep running and keep receiving messages.</p>
            ${c.keys
              .filter((k) => present[k])
              .map(
                (k) => `<form method="post" action="/credentials/${esc(c.name)}/clear" class="inline"
                       data-confirm="Clear ${esc(k)}? Every agent stops being able to answer.">
                  <input type="hidden" name="_csrf" value="${esc(csrf)}">
                  <input type="hidden" name="key" value="${esc(k)}">
                  <button class="btn danger small" type="submit">${icon("trash")} Clear ${esc(k)}</button>
                </form>`
              )
              .join(" ")}`,
            { icon: "trash", className: "danger-zone" }
          )
        : ""
    }`,
    {
      user,
      csrf,
      active: "credentials",
      heading: c.label,
      subtitle: "Shared by every agent on this machine.",
      actions: `<a class="btn" href="/credentials">${icon("chevron")} All credentials</a>`,
    }
  );
};
