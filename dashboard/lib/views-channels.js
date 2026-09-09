"use strict";
/**
 * Channels — how messages reach an agent.
 *
 * Kept separate from agents because the credential belongs to the transport,
 * not to the mind behind it: you should be able to swap the bot an agent
 * answers on, or move it from Telegram to WhatsApp, without rebuilding the
 * agent or losing its memory.
 */

const { esc, shell, card, flashes, empty, icon, agentPill, stamp } = require("./ui");
const { byScope } = require("./catalog");
const { renderAddons } = require("./views-addons");

const TYPES = {
  telegram: { label: "Telegram", icon: "telegram" },
  whatsapp: { label: "WhatsApp", icon: "whatsapp" },
};

function typeBadge(type) {
  const t = TYPES[type] || { label: type, icon: "channels" };
  return `<span class="strong" style="display:inline-flex;align-items:center;gap:6px">
    ${icon(t.icon)} ${esc(t.label)}</span>`;
}

/* ----------------------------------------------------------------- list --- */

exports.list = ({ csrf, user, channels, agents, flash, err }) => {
  const unconnected = agents.filter((a) => !a.channel);

  return shell(
    "Channels",
    `${flashes({ msg: flash, err })}
    ${
      unconnected.length
        ? `<div class="alert warn">${icon("alert")}<div>
             ${unconnected.length} agent${unconnected.length === 1 ? "" : "s"} with no channel:
             ${unconnected.map((a) => `<strong>${esc(a.name || a.slug)}</strong>`).join(", ")}.
             They cannot receive messages until one is connected.</div></div>`
        : ""
    }

    ${
      channels.length
        ? card(
            "Connected channels",
            `<table class="rows">
              <thead><tr><th>Channel</th><th>Type</th><th>Agent</th><th>Reachable by</th><th>State</th><th></th></tr></thead>
              <tbody>${channels
                .map(
                  (c) => `<tr>
                  <td>
                    <a class="strong" href="/channels/${esc(c.slug)}">${esc(c.name || c.slug)}</a>
                    <div class="muted small mono">${esc(c.slug)}</div>
                  </td>
                  <td>${typeBadge(c.type)}
                    ${
                      c.type === "telegram" && c.telegram_bot_username
                        ? `<div class="muted small mono">@${esc(c.telegram_bot_username)}</div>`
                        : ""
                    }</td>
                  <td>${
                    c.agent
                      ? `<a href="/agents/${esc(c.agent)}">${esc(c.agent_name || c.agent)}</a>`
                      : `<span class="muted">not connected</span>`
                  }</td>
                  <td class="mono small">${esc(
                    c.type === "telegram"
                      ? c.allowed_users || "nobody"
                      : c.allowed_numbers || "nobody"
                  )}</td>
                  <td>${
                    c.agent_state
                      ? agentPill(c.agent_state.active)
                      : `<span class="pill neutral">idle</span>`
                  }${
                    c.token_set === false && c.type === "telegram"
                      ? `<div class="tag warn-tag">no token</div>`
                      : ""
                  }</td>
                  <td class="right"><a class="btn small" href="/channels/${esc(c.slug)}">Manage</a></td>
                </tr>`
                )
                .join("")}</tbody></table>`,
            { icon: "channels" }
          )
        : card(
            "",
            empty(
              "channels",
              "No channels yet",
              "A channel is the bot or number people message. Connect one to give an agent a way to hear you."
            )
          )
    }

    ${card(
      "How channels work",
      `<table class="kv">
        <tr><td>${typeBadge("telegram")}</td><td class="muted">A bot from @BotFather. Private
          chat by default, or a forum group where each project gets its own topic.</td></tr>
        <tr><td>${typeBadge("whatsapp")}</td><td class="muted">A WhatsApp number linked by
          scanning a QR code from your phone, the same way WhatsApp Web works.</td></tr>
      </table>
      <p class="muted small">One channel per agent. Telegram allows a single poller per bot
        token, so two agents sharing a channel would make both drop messages at random —
        the panel refuses the second connection rather than letting you find out in
        production.</p>`,
      { icon: "info" }
    )}`,
    {
      user,
      csrf,
      active: "channels",
      heading: "Channels",
      subtitle: "How people reach your agents.",
      actions: `<a class="btn primary" href="/channels/new">${icon("plus")} Add channel</a>`,
    }
  );
};

/* ------------------------------------------------------------------ new --- */

exports.create = ({ csrf, user, agents, form = {}, errors = [], botInfo = null }) => {
  const v = (k, d) => esc(form[k] != null && form[k] !== "" ? form[k] : d == null ? "" : d);
  const type = form.type === "whatsapp" ? "whatsapp" : "telegram";
  const free = agents.filter((a) => !a.channel || a.channel.slug === form.slug);

  return shell(
    "Add channel",
    `${errors.length ? `<div class="alert bad">${icon("alert")}<div>${errors.map(esc).join("<br>")}</div></div>` : ""}
    ${
      botInfo
        ? `<div class="alert good">${icon("check")}<div>Token verified — this is
           <strong>@${esc(botInfo.username)}</strong> (${esc(botInfo.name)}).</div></div>`
        : ""
    }

    <form method="post" action="/channels/new" autocomplete="off">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">

      ${card(
        "Type",
        `<div class="addon-grid">
          <label class="addon${type === "telegram" ? " on" : ""}" style="cursor:pointer">
            <span class="addon-top">
              <input type="radio" name="type" value="telegram" ${type === "telegram" ? "checked" : ""}
                     style="width:auto;margin:0">
              <span class="addon-ico">${icon("telegram")}</span>
              <span><span class="addon-name">Telegram</span>
                <span class="addon-cat">bot token</span></span>
            </span>
            <p class="addon-desc">A bot from @BotFather. Works immediately, no phone needed.</p>
          </label>
          <label class="addon${type === "whatsapp" ? " on" : ""}" style="cursor:pointer">
            <span class="addon-top">
              <input type="radio" name="type" value="whatsapp" ${type === "whatsapp" ? "checked" : ""}
                     style="width:auto;margin:0">
              <span class="addon-ico">${icon("whatsapp")}</span>
              <span><span class="addon-name">WhatsApp</span>
                <span class="addon-cat">linked device</span></span>
            </span>
            <p class="addon-desc">Links a number by QR, like WhatsApp Web. Set up after creating.</p>
          </label>
        </div>`,
        { icon: "channels" }
      )}

      ${card(
        "Identity",
        `<label>Channel name <span class="hint">what you call it in this panel</span>
          <input name="name" value="${v("name")}" placeholder="e.g. Support line" maxlength="64" required autofocus></label>
        <label>Short name <span class="hint">lowercase; cannot be changed later</span>
          <input name="slug" value="${v("slug")}" placeholder="support-line"
                 pattern="[a-z][a-z0-9-]{1,30}" maxlength="31" required></label>
        <label>Connect to agent
          <select name="agent">
            <option value="">— not connected yet —</option>
            ${free
              .map(
                (a) =>
                  `<option value="${esc(a.slug)}" ${form.agent === a.slug ? "selected" : ""}>${esc(
                    a.name || a.slug
                  )}</option>`
              )
              .join("")}
          </select></label>
        ${
          free.length
            ? ""
            : `<p class="muted small">Every agent already has a channel. Create another
               agent first, or disconnect one.</p>`
        }`,
        { icon: "link" }
      )}

      ${card(
        "Telegram",
        `<label>Bot token <span class="hint">from @BotFather; stored 0600 and never shown again</span>
          <input name="token" type="password" placeholder="8123456789:AAH..."></label>
        <label>Allowed Telegram user IDs <span class="hint">comma separated. Empty means nobody can talk to it.</span>
          <input name="allowed_users" value="${v("allowed_users")}" placeholder="123456789" pattern="[0-9, ]*"></label>
        <label class="check"><input type="checkbox" name="topics_enabled" value="1"
          ${form.topics_enabled ? "checked" : ""}> Route conversations into group topics</label>
        <label>Group chat ID <span class="hint">starts with -100; only for topic mode</span>
          <input name="topics_chat_id" value="${v("topics_chat_id")}" placeholder="-1001234567890" pattern="-?[0-9]*"></label>
        <p class="muted small">Don't know your user ID? Message <code>@userinfobot</code>.
          Full walkthrough in the <a href="/guide#bot">Guide</a>.</p>`,
        { icon: "telegram" , className: "only-telegram" }
      )}

      ${card(
        "WhatsApp",
        `<label>Allowed numbers <span class="hint">comma separated, international format</span>
          <input name="allowed_numbers" value="${v("allowed_numbers")}" placeholder="+201234567890"></label>
        <div class="alert warn">${icon("alert")}<div>WhatsApp is linked by scanning a QR code
          with your phone, using an unofficial library. It works, but it is against
          WhatsApp's terms of service and the number can be banned without warning. Use a
          number you can afford to lose, not your main business line.</div></div>`,
        { icon: "whatsapp" , className: "only-whatsapp" }
      )}

      ${card(
        "Add-ons",
        `<p class="muted small">What this channel can receive and how it behaves. You can
          change these at any time.</p>
        ${renderAddons(byScope("channel"), form.addons || defaultChannelAddons())}`,
        { icon: "addons" }
      )}

      ${card(
        "",
        `<button class="btn primary" type="submit">${icon("plus")} Create channel</button>
         <a class="btn" href="/channels">Cancel</a>`
      )}
    </form>`,
    {
      user,
      csrf,
      active: "channels",
      heading: "Add a channel",
      subtitle: "Give an agent a way to hear you.",
    }
  );
};

function defaultChannelAddons() {
  return byScope("channel")
    .filter((a) => a.default)
    .map((a) => a.id);
}

/* --------------------------------------------------------------- detail --- */

/**
 * The WhatsApp linking panel.
 *
 * Four states, and it matters that they are distinguishable: not installed,
 * nothing running, waiting for a scan, and linked. "It isn't working" is a
 * different problem in each.
 */
function whatsappCard(csrf, c, wa) {
  const slug = esc(c.slug);
  const warning = `<div class="alert warn">${icon("alert")}<div>This uses an unofficial
    library. Linking a number is against WhatsApp's terms of service and it can be banned
    without warning — use a number you can afford to lose, not your main business
    line.</div></div>`;

  if (!wa) {
    return card(
      "WhatsApp",
      `${warning}
      <p class="muted">The WhatsApp bridge is not installed on this server.</p>
      <pre>sudo bash /opt/moni-ai-os/deploy/install-whatsapp.sh</pre>`,
      { icon: "whatsapp" }
    );
  }

  if (!c.agent) {
    return card(
      "WhatsApp",
      `${warning}
      <p class="muted">Connect this channel to an agent first — the bridge does not run
        without something to answer with, so that messages are never collected and
        dropped.</p>`,
      { icon: "whatsapp" }
    );
  }

  const controls = `<div class="btn-row">
    <a class="btn small" href="/channels/${slug}">${icon("restart")} Refresh</a>
    <a class="btn small" href="/channels/${slug}/logs">${icon("logs")} Bridge logs</a>
  </div>`;

  if (wa.linked) {
    return card(
      "WhatsApp",
      `<div class="alert good">${icon("check")}<div>Linked${
        wa.me && wa.me.number ? " as <strong>+" + esc(wa.me.number) + "</strong>" : ""
      }. The device session is stored on the server, so it survives restarts.</div></div>
      <table class="kv">
        <tr><td>Bridge</td><td>${esc((wa.unit && wa.unit.active) || "unknown")}</td></tr>
        <tr><td>Last update</td><td class="mono small">${esc(stamp(wa.updated_at))}</td></tr>
      </table>
      ${controls}
      <form method="post" action="/channels/${slug}/whatsapp/unlink" class="inline"
            data-confirm="Unlink this number? You will need to scan a new QR code to reconnect."
            style="margin-top:10px">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <button class="btn danger small">${icon("trash")} Unlink this number</button>
      </form>`,
      { icon: "whatsapp" }
    );
  }

  if (wa.qr) {
    return card(
      "Link this number",
      `${warning}
      <p class="muted">On your phone: <strong>WhatsApp → Settings → Linked devices →
        Link a device</strong>, then scan this code. It expires after about a minute —
        reload the page for a fresh one.</p>
      <p style="text-align:center"><img src="${esc(wa.qr)}" alt="WhatsApp pairing QR code"
        width="300" height="300"></p>
      ${controls}`,
      { icon: "whatsapp" }
    );
  }

  return card(
    "WhatsApp",
    `${warning}
    <table class="kv">
      <tr><td>Bridge</td><td>${esc((wa.unit && wa.unit.active) || "inactive")}</td></tr>
      <tr><td>Status</td><td>${esc(wa.status || "stopped")}</td></tr>
      ${
        wa.last_error
          ? `<tr><td>Last error</td><td class="small">${esc(wa.last_error)}</td></tr>`
          : ""
      }
    </table>
    ${
      wa.status === "logged_out"
        ? `<div class="alert bad">${icon("alert")}<div>The phone unlinked this device.
           Unlink here and start again to scan a fresh code.</div></div>`
        : ""
    }
    <form method="post" action="/channels/${slug}/whatsapp/link" class="inline">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <button class="btn primary small">${icon("link")} Start linking</button>
    </form>
    <a class="btn small" href="/channels/${slug}/logs">${icon("logs")} Bridge logs</a>`,
    { icon: "whatsapp" }
  );
}

exports.detail = ({ csrf, user, channel, agents, wa, flash, err }) => {
  const c = channel;
  const free = agents.filter((a) => !a.channel || a.channel.slug === c.slug);
  const isTelegram = c.type === "telegram";

  return shell(
    c.name || c.slug,
    `${flashes({ msg: flash, err })}
    ${
      isTelegram && !c.token_set
        ? `<div class="alert bad">${icon("alert")}<div>No bot token stored — this channel
           cannot connect to Telegram.</div></div>`
        : ""
    }
    ${
      !c.agent
        ? `<div class="alert warn">${icon("alert")}<div>This channel is not connected to an
           agent, so messages sent to it go nowhere.</div></div>`
        : ""
    }

    <div class="grid">
      ${card(
        "Channel",
        `<table class="kv">
          <tr><td>Type</td><td>${typeBadge(c.type)}</td></tr>
          ${
            isTelegram
              ? `<tr><td>Bot</td><td class="mono small">${
                  c.telegram_bot_username ? "@" + esc(c.telegram_bot_username) : "—"
                }</td></tr>
                 <tr><td>Token</td><td>${
                   c.token_set
                     ? `<span class="pill ok">stored</span>`
                     : `<span class="pill bad">missing</span>`
                 }</td></tr>
                 <tr><td>Topics</td><td>${
                   c.topics_enabled
                     ? `on · <span class="mono small">${esc(c.topics_chat_id)}</span>`
                     : "off (private chat)"
                 }</td></tr>`
              : `<tr><td>Linked</td><td>${
                  c.linked
                    ? `<span class="pill ok">linked</span>`
                    : `<span class="pill neutral">not linked</span>`
                }</td></tr>`
          }
          <tr><td>Updated</td><td class="mono small">${esc(stamp(c.updated_at))}</td></tr>
        </table>
        ${
          isTelegram && c.telegram_bot_username
            ? `<p class="muted small" style="margin-top:12px">Open the chat:
               <code>https://t.me/${esc(c.telegram_bot_username)}</code></p>`
            : ""
        }`,
        { icon: TYPES[c.type] ? TYPES[c.type].icon : "channels" }
      )}

      ${card(
        "Connected agent",
        c.agent
          ? `<table class="kv">
              <tr><td>Agent</td><td><a href="/agents/${esc(c.agent)}">${esc(
              c.agent_name || c.agent
            )}</a></td></tr>
              <tr><td>State</td><td>${
                c.agent_state ? agentPill(c.agent_state.active) : "—"
              }</td></tr>
            </table>`
          : `<p class="muted">Nothing is listening on this channel.</p>`,
        { icon: "link" }
      )}
    </div>

    ${c.type === "whatsapp" ? whatsappCard(csrf, c, wa) : ""}

    <form method="post" action="/channels/${esc(c.slug)}" autocomplete="off">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">

      ${card(
        "Settings",
        `<label>Channel name<input name="name" value="${esc(c.name || "")}" maxlength="64" required></label>
        <label>Connect to agent
          <select name="agent">
            <option value="">— not connected —</option>
            ${free
              .map(
                (a) =>
                  `<option value="${esc(a.slug)}" ${c.agent === a.slug ? "selected" : ""}>${esc(
                    a.name || a.slug
                  )}</option>`
              )
              .join("")}
          </select></label>
        ${
          isTelegram
            ? `<label>Replace bot token <span class="hint">leave empty to keep the stored one</span>
                <input name="token" type="password" placeholder="${
                  c.token_set ? "•••••••• stored" : "no token stored"
                }"></label>
               <label>Allowed Telegram user IDs
                 <input name="allowed_users" value="${esc(c.allowed_users || "")}" pattern="[0-9, ]*"></label>
               <label class="check"><input type="checkbox" name="topics_enabled" value="1"
                 ${c.topics_enabled ? "checked" : ""}> Route conversations into group topics</label>
               <label>Group chat ID
                 <input name="topics_chat_id" value="${esc(c.topics_chat_id || "")}" pattern="-?[0-9]*"></label>`
            : `<label>Allowed numbers
                 <input name="allowed_numbers" value="${esc(c.allowed_numbers || "")}"
                        placeholder="+201234567890"></label>`
        }`,
        { icon: "settings" }
      )}

      ${card(
        "Add-ons",
        renderAddons(byScope("channel"), c.addons || []),
        { icon: "addons" }
      )}

      ${card(
        "",
        `<p class="muted small">Saving rewrites the connected agent's environment and
          restarts it. Conversations resume — sessions are on disk, not in memory.</p>
        <button class="btn primary" type="submit">${icon("save")} Save channel</button>`
      )}
    </form>

    ${card(
      "Delete this channel",
      `<p class="muted small">The channel is archived, and the agent it fed stops running
        because it no longer has anything to listen to. The agent, its workspace and its
        memory are untouched. The bot itself still exists — delete it in @BotFather if you
        are done with it.</p>
      <form method="post" action="/channels/${esc(c.slug)}/delete"
            data-confirm="Delete ${esc(c.slug)}? The connected agent stops receiving messages.">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Type the channel's short name to confirm
          <input name="confirm" placeholder="${esc(c.slug)}" autocomplete="off"></label>
        <button class="btn danger" type="submit">${icon("trash")} Delete channel</button>
      </form>`,
      { icon: "trash", className: "danger-zone" }
    )}`,
    {
      user,
      csrf,
      active: "channels",
      heading: c.name || c.slug,
      subtitle: (TYPES[c.type] || {}).label + " channel",
      actions: `<a class="btn" href="/channels">${icon("chevron")} All channels</a>`,
    }
  );
};
