"use strict";
/**
 * The operator's manual, served from the panel itself.
 *
 * It lives here rather than in a README because the moment you need it is the
 * moment you are looking at the panel wondering why the bot is silent.
 */

const { esc, shell, icon, docLayout } = require("./ui");

/** The sticky contents beside the guide. Labels are trusted markup (entities). */
const GUIDE_TOC = [
  ["how", "How it works"],
  ["bot", "1 · Create a Telegram bot"],
  ["userid", "2 · Find your user ID"],
  ["create", "3 · Create the agent and its channel"],
  ["talk", "4 · Talk to it"],
  ["addons", "Add-ons"],
  ["topics", "Groups &amp; topics"],
  ["whatsapp", "WhatsApp"],
  ["channels", "Telegram broadcast"],
  ["memory", "Memory"],
  ["obsidian", "Obsidian"],
  ["trouble", "Troubleshooting"],
  ["layout", "Where things live"],
];

exports.guide = ({ csrf, user, publicHost, publicPort, sshHost }) => {
  const host = esc(publicHost);
  const ssh = esc(sshHost || publicHost);

  return shell(
    "Guide",
    `${docLayout(`
    <div class="card" id="how">
      <h2>How it works</h2>
      <p>Two things, kept separate. An <strong>agent</strong> is a Claude session with its
        own workspace and its own memory. A <strong>channel</strong> is how people reach
        it — a Telegram bot, or a linked WhatsApp number. Nothing is shared between
        agents.</p>
      <pre class="diagram">You, on Telegram or WhatsApp
      │
      ▼
  channel                   the credential and the allow-list live here
      │
      ▼
  moni-agent@&lt;name&gt;         systemd unit, runs as the moniagent account
  or moni-whatsapp@&lt;chan&gt;
      │
      ├─ Claude Agent SDK ──▶ claude CLI ──▶ Anthropic
      │
      ├─ vault/             the only directory it may read or write
      │
      └─ memory MCP server ─▶ vault (Markdown) + vectors (local embeddings)</pre>
      <p class="muted">Four things follow from this shape, and they are the ones worth
        remembering:</p>
      <ul>
        <li><strong>No inbound port.</strong> Both transports connect outbound, so the
          firewall stays shut. Nothing about an agent is reachable from the internet.</li>
        <li><strong>Only files survive.</strong> A chat session ends on timeout or
          <code>/new</code>. Whatever the agent did not write to its vault is gone.</li>
        <li><strong>One channel per agent.</strong> Telegram allows exactly one poller per
          token; two agents sharing a channel would make both drop messages at random, so
          the panel refuses it.</li>
        <li><strong>The channel is not the agent.</strong> Swap the bot, or move it to
          WhatsApp, and the agent keeps every word of its memory.</li>
      </ul>
    </div>

    <div class="card" id="bot">
      <h2>1 · Create a Telegram bot</h2>
      <p>Every agent needs its own bot. This takes about a minute.</p>
      <ol class="steps">
        <li>Open Telegram and message <a href="https://t.me/botfather"><code>@BotFather</code></a>.</li>
        <li>Send <code>/newbot</code>.</li>
        <li>Give it a display name (anything, e.g. <em>Odoo Dev</em>).</li>
        <li>Give it a username. It must be unique and end in <code>bot</code> —
          e.g. <code>moni_odoo_dev_bot</code>.</li>
        <li>BotFather replies with a token that looks like
          <code class="mono">8123456789:AAHk9x…</code>. That line is the bot. Copy it.</li>
      </ol>
      <div class="alert warn">The token is a password. Anyone holding it controls the bot
        and can read everything sent to it. Paste it into the create-agent form and nowhere
        else — not into a chat, not into a file. The panel stores it <code>0600</code> and
        never displays it again. If you ever leak one, <code>/revoke</code> in BotFather
        invalidates it immediately.</div>
      <h3>Worth setting while you are there</h3>
      <ul>
        <li><code>/setdescription</code> — shown on the bot's empty chat screen.</li>
        <li><code>/setuserpic</code> — makes agents distinguishable at a glance when you
          run several.</li>
        <li><code>/setprivacy</code> → <em>Disable</em> — only if you plan to use the bot in
          a group and want it to see all messages rather than only replies and mentions.</li>
      </ul>
    </div>

    <div class="card" id="userid">
      <h2>2 · Find your Telegram user ID</h2>
      <p>The agent answers a whitelist of numeric user IDs and ignores everyone else. An
        agent with an empty whitelist talks to nobody — that is the safe default, not a bug.</p>
      <ol class="steps">
        <li>Message <a href="https://t.me/userinfobot"><code>@userinfobot</code></a> on Telegram.</li>
        <li>It replies with your ID — a number like <code class="mono">123456789</code>.</li>
      </ol>
      <p class="muted">Adding a colleague later is the same trick: they message that bot,
        send you the number, you add it to the agent's allowed list in Settings.</p>
    </div>

    <div class="card" id="create">
      <h2>3 · Create the agent and its channel</h2>
      <p>These are two separate things, on purpose. The <strong>agent</strong> is the mind:
        its brief, its workspace, its memory. The <strong>channel</strong> is how people
        reach it: a bot token, a list of who may talk to it. Keeping them apart means you
        can swap the bot an agent answers on, or move it to WhatsApp, without rebuilding
        the agent or losing a word of its memory.</p>

      <h3>First the agent</h3>
      <p><a href="/agents/new">Agents → New agent</a>:</p>
      <table class="kv">
        <tr><td>Display name</td><td class="muted">What you call it. Cosmetic.</td></tr>
        <tr><td>Short name</td><td class="muted">Lowercase, becomes the folder and the
          systemd unit. Permanent — choose one you can live with.</td></tr>
        <tr><td>Role</td><td class="muted">The standing brief, written into CLAUDE.md and
          loaded on every request. This is the field that decides whether the agent is
          useful. Be specific about what it owns, what it may do unattended, and what it
          must ask about first.</td></tr>
        <tr><td>Project directory</td><td class="muted">Optional. An existing folder under
          <code>/opt/projects</code>, <code>/srv</code> or
          <code>/opt/moni-agents/workspaces</code>. It appears inside the vault as
          <code>project/</code>.</td></tr>
        <tr><td>Add-ons</td><td class="muted">What the agent can do — git, scheduled jobs,
          webhooks. Memory is always on.</td></tr>
      </table>

      <h3>Then the channel</h3>
      <p><a href="/channels/new">Channels → Add channel</a>:</p>
      <table class="kv">
        <tr><td>Type</td><td class="muted">Telegram or WhatsApp.</td></tr>
        <tr><td>Bot token</td><td class="muted">From step 1. Verified with Telegram before
          anything is written, so a mistyped token fails here rather than in the logs.</td></tr>
        <tr><td>Allowed user IDs</td><td class="muted">From step 2. Empty means nobody.</td></tr>
        <tr><td>Connect to agent</td><td class="muted">The agent you just made.</td></tr>
        <tr><td>Add-ons</td><td class="muted">What it can receive — voice notes, files,
          images — and how replies feel.</td></tr>
      </table>
      <p>On save the panel writes the agent's environment, enables a systemd unit and
        starts it. An agent with no channel stays stopped rather than crash-looping.</p>

      <div class="alert info">A good role brief beats every other setting on this page.
        "You maintain the Odoo 17 instance at /opt/projects/odoo; you may edit modules and
        run tests unattended; ask before restarting the service during working hours"
        produces a far better agent than "You are a helpful assistant".</div>
    </div>

    <div class="card" id="addons">
      <h2>Add-ons</h2>
      <p>An add-on is a capability with a switch, not a plugin you install. Turning one on
        writes configuration the runtime already understands and restarts the affected
        process. Browse them all under <a href="/addons">Add-ons</a>.</p>
      <table class="kv">
        <tr><td><strong>Channel</strong></td><td class="muted">What arrives and how it
          feels: voice notes, file capture, image capture, live typing, quick actions.</td></tr>
        <tr><td><strong>Agent</strong></td><td class="muted">What the agent does with it:
          memory (always on), git, scheduled jobs, webhooks, telemetry.</td></tr>
      </table>
      <h3>Voice notes</h3>
      <p>Send a voice message and the agent hears it. Transcription runs on this server
        with whisper.cpp — no API key, no per-minute cost, and the recording never leaves
        the box.</p>
      <h3>Files</h3>
      <p>Send a spreadsheet, a PDF, a Word document, a photo, a CSV. The file is saved into
        the agent's workspace under <code>attachments/inbox/</code> and the agent gets the
        path, so it can open a spreadsheet with pandas or pull the text out of a PDF —
        and it is still there tomorrow if you want to ask a follow-up question.</p>
      <p class="muted small">Executables, libraries, installers and key material are
        refused regardless of what is switched on.</p>
    </div>

    <div class="card" id="talk">
      <h2>4 · Talk to it</h2>
      <p>Open <code class="mono">https://t.me/&lt;your_bot_username&gt;</code>, press Start,
        and type normally. No commands needed — it is a conversation.</p>
      <table class="kv">
        <tr><td><code>/start</code></td><td class="muted">Wake it up, confirm it can hear you.</td></tr>
        <tr><td><code>/new</code></td><td class="muted">Start a fresh session. Clears the
          conversation, <em>not</em> the memory vault.</td></tr>
        <tr><td><code>/status</code></td><td class="muted">Session, model, usage.</td></tr>
        <tr><td><code>/verbose 0|1|2</code></td><td class="muted">How much of its own work it
          narrates while thinking.</td></tr>
        <tr><td><code>/repo</code></td><td class="muted">Git status of the working directory.</td></tr>
      </table>
      <p class="muted">Voice notes, photos and documents work too — it transcribes and reads
        them.</p>
    </div>

    <div class="card" id="topics">
      <h2>Groups &amp; topics</h2>
      <p>Default is a private chat: you and one agent. Group topic mode instead puts the
        agent in a group where each project gets its own topic thread — useful when several
        people work with the same agent, or one agent covers several projects.</p>
      <ol class="steps">
        <li>In Telegram, create a <strong>group</strong> (not a channel).</li>
        <li>Group Settings → <strong>Topics</strong> → turn on. This converts it to a forum;
          without it there are no threads to route into.</li>
        <li>Add your bot to the group.</li>
        <li>Promote the bot to <strong>administrator</strong>, and grant it
          <strong>Manage Topics</strong>. It creates and renames threads itself.</li>
        <li>Get the group's chat ID: forward any message from the group to
          <a href="https://t.me/userinfobot"><code>@userinfobot</code></a>, or temporarily add
          <code>@RawDataBot</code>. Supergroup IDs start with <code class="mono">-100</code>.</li>
        <li>In the agent's Settings, tick <em>Route conversations into group topics</em> and
          paste that ID. The panel checks the group is a forum and the bot is an admin
          before saving, and tells you exactly what is missing if not.</li>
      </ol>
      <div class="alert warn">Group privacy mode is on by default, so the bot only sees
        messages that mention it or reply to it. That is usually what you want in a busy
        group. To let it read everything: BotFather → <code>/mybots</code> → your bot → Bot
        Settings → Group Privacy → Turn off, then remove and re-add the bot for the change
        to take effect.</div>
    </div>

    <div class="card" id="whatsapp">
      <h2>WhatsApp</h2>
      <p>A WhatsApp channel links a real number the way WhatsApp Web does: you scan a QR
        code from your phone, and the server holds the linked-device session. The agent
        behind it is the same agent — same workspace, same memory, same voice and file
        handling — reached over a different transport.</p>
      <ol class="steps">
        <li>Install the bridge once:
          <code>sudo bash /opt/moni-ai-os/deploy/install-whatsapp.sh</code></li>
        <li><a href="/channels/new">Channels → Add channel</a>, pick WhatsApp, name it, and
          connect it to an agent.</li>
        <li>Add the numbers allowed to talk to it, in international format.</li>
        <li>Press <strong>Start linking</strong>, then on your phone:
          <strong>WhatsApp → Settings → Linked devices → Link a device</strong> and scan
          the code. It expires after about a minute; reload for a fresh one.</li>
      </ol>
      <div class="alert warn">WhatsApp has no official API for this. The bridge uses an
        unofficial library, which is against WhatsApp's terms of service, and the number
        <strong>can be banned without warning</strong>. Use a number you can afford to
        lose, not your main business line.</div>
      <p class="muted small">A WhatsApp channel with no agent connected does not run at
        all — collecting messages with nothing to answer them is worse than being visibly
        off. Group chats are ignored by design.</p>
    </div>

    <div class="card" id="channels">
      <h2>Telegram broadcast channels</h2>
      <p class="muted">Not to be confused with a Mint OS <em>channel</em>, which is any way of
        reaching an agent. This is Telegram's own broadcast feature.</p>
      <p>Telegram channels are broadcast, not conversation, and that difference matters
        here:</p>
      <ul>
        <li>A bot added to a channel as admin <strong>can post</strong> to it.</li>
        <li>Channel subscribers cannot reply in a way the bot receives, so there is no
          conversation to have. An agent in a channel can only talk, never listen.</li>
      </ul>
      <p>So: use a <strong>private chat</strong> for a personal agent, a <strong>group with
        topics</strong> for a shared one, and a <strong>channel</strong> only as a
        notification feed. If you want an agent to broadcast — deploy notices, nightly
        summaries, CI results — add its bot to the channel as an admin with post rights and
        give it the channel ID in its role brief; it will post there when asked, while
        continuing to take instructions from you in private.</p>
    </div>

    <div class="card" id="memory">
      <h2>Memory</h2>
      <p>A Telegram session dies on timeout, restart, or <code>/new</code>. Nothing in the
        conversation survives it. Files do. Every agent therefore gets a vault:</p>
      <table class="kv">
        <tr><td><code>CLAUDE.md</code></td><td class="muted">Identity and standing rules.
          Injected into the system prompt every request. Edit it in the panel under
          <em>Instructions</em>.</td></tr>
        <tr><td><code>MEMORY.md</code></td><td class="muted">Current state plus an index of
          every note. Also injected every request — so it is the map, not the territory.</td></tr>
        <tr><td><code>memory/*.md</code></td><td class="muted">One durable fact per file,
          linked with <code>[[wikilinks]]</code>. The substance.</td></tr>
        <tr><td><code>WORKLOG.md</code></td><td class="muted">Dated narrative of what was
          done.</td></tr>
      </table>
      <h3>The vector index</h3>
      <p>MEMORY.md cannot hold everything — it is in the prompt, so it has a budget. The
        notes it points at are indexed instead: each is chunked by heading, embedded with a
        small model running <strong>on this machine</strong>, and stored in a per-agent
        SQLite database. The agent searches it with a <code>memory_search</code> tool before
        answering anything that depends on prior work.</p>
      <p class="muted">Search is hybrid — vector similarity for paraphrase ("how do we
        deploy" finding "release procedure"), keyword matching for the exact tokens
        embeddings lose (error codes, flag names, IDs) — and the two rankings are merged.
        The files are the source of truth; the index is a cache you can delete and rebuild
        with the Reindex button at any time.</p>
      <p class="muted">Nothing is sent anywhere to be embedded. The model is local.</p>
      <h3>Curating it</h3>
      <p>Memory rots if nobody prunes it. The single highest-value maintenance action is
        correcting a wrong note — an agent that keeps repeating a mistake is usually reading
        a stale memory, and fixing that one file fixes the behaviour permanently. Do it in
        the panel under <em>Memory</em>, or in Obsidian.</p>
    </div>

    <div class="card" id="obsidian">
      <h2>Obsidian</h2>
      <p>Every vault is a real Obsidian vault — backlinks, graph view, search, the lot.
        Obsidian is installed on this server's desktop, so the quickest way in is over RDP.</p>
      <p>RDP is not exposed to the internet. Tunnel it over SSH first:</p>
      <pre>ssh -N -L 13389:127.0.0.1:3389 ubuntu@${ssh}</pre>
      <p>Then point Remote Desktop at <code class="mono">127.0.0.1:13389</code>, log in, and
        open Obsidian. Each agent's vault is at:</p>
      <pre>/opt/moni-agents/agents/&lt;agent&gt;/vault</pre>
      <p class="muted">Open several as separate vaults and switch between them, or open
        <code>/opt/moni-agents/agents</code> as one vault to see every agent's memory in a
        single graph.</p>
      <p class="muted small">Editing notes by hand is expected and safe. The agent re-reads
        files on its next search; you never need to tell it you changed something.</p>
    </div>

    <div class="card" id="trouble">
      <h2>Troubleshooting</h2>
      <table class="kv">
        <tr><td><strong>Bot never answers</strong></td><td class="muted">Check the agent is
          <em>active</em> on its page, then check your Telegram user ID is in its allowed
          list. An unlisted user is silently ignored — by design, but it looks like a dead
          bot.</td></tr>
        <tr><td><strong>Unit is <em>failed</em></strong></td><td class="muted">Open the Logs
          tab. A rejected token and a missing Claude credential are the two usual causes and
          both say so plainly.</td></tr>
        <tr><td><strong>Answers, then goes quiet</strong></td><td class="muted">Two pollers
          on one bot token. Make sure no other agent — and no bot running elsewhere — uses
          the same token.</td></tr>
        <tr><td><strong>Forgets things</strong></td><td class="muted">Look at MEMORY.md. If
          it is empty, the agent is not writing memories: tighten the instruction in
          CLAUDE.md that tells it to write before reporting work done.</td></tr>
        <tr><td><strong>Search finds nothing</strong></td><td class="muted">Press Reindex on
          the Memory tab and watch the chunk count.</td></tr>
        <tr><td><strong>Cannot reach a file</strong></td><td class="muted">The agent is
          confined to its workspace. To give it a project, set the project directory in
          Settings rather than loosening anything.</td></tr>
      </table>
    </div>

    <div class="card" id="layout">
      <h2>Where things live</h2>
      <pre>/opt/moni-agents/
├── runtime/              shared Python runtime (the Telegram↔Claude bridge)
├── shared/
│   ├── claude-auth.env   Claude credential, readable only by the agent account
│   ├── models/           the embedding model, downloaded once
│   └── home/             HOME for the agent account
├── vault-template/       what a new agent's vault is copied from
├── agents/&lt;name&gt;/
│   ├── agent.env         generated config, 0600 — holds the bot token
│   ├── agent.json        metadata, no secrets
│   ├── mcp.json          wires the memory server to this agent's vault
│   ├── data/bot.db       conversation sessions
│   ├── vectors/memory.db the vector index
│   └── vault/            CLAUDE.md · MEMORY.md · WORKLOG.md · memory/
└── archived/&lt;name&gt;-&lt;ts&gt;/  deleted agents, kept whole</pre>
      <h3>Privilege</h3>
      <p class="muted">This panel runs as an unprivileged account that can execute exactly
        one command as root: <code class="mono">moni-helper</code>, which validates every
        argument against a whitelist and never invokes a shell. Agents run as a separate
        account under a systemd sandbox with a read-only filesystem apart from their own
        directory. Bot tokens go to the helper over stdin, never on a command line where
        another local user could read them from <code>/proc</code>.</p>
      <p class="muted small">Full architecture and threat model: the repository README.</p>
    </div>`, `<section class="card hud"><div class="card-head"><h2>${icon("guide")}Contents</h2></div>
      <nav class="toc" aria-label="Guide contents"><ul class="toc-list" data-toc>
      ${GUIDE_TOC.map(([id, label], i) => `<li><a href="#${id}"${i === 0 ? ' class="on"' : ""}>${label}</a></li>`).join("")}
      </ul></nav></section>`)}`,
    {
      user,
      csrf,
      active: "guide",
      pattern: "c",
      heading: "Guide",
      subtitle:
        "How this system is put together, and how to get an agent talking to you.",
    }
  );
};
