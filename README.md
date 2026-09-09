# MONI AI OS

Control panel for a fleet of Claude agents on a single VPS.

Each **agent** is one Telegram bot wired to one Claude Code session with its own
memory. You create it from a web panel, it comes up as a systemd unit, and it
starts with an Obsidian vault and a local vector index over that vault. Nothing
is shared between agents — separate bot, separate workspace, separate memory,
separate process.

**Live at** https://vmi3567127.contaboserver.net:8443/

```
You on Telegram
      │
      ▼
  Telegram Bot API          outbound polling — no inbound port, no webhook
      │
      ▼
  moni-agent@<name>         systemd unit, runs as the moniagent account
      │
      ├─ Claude Agent SDK ──▶ claude CLI ──▶ Anthropic
      ├─ workspace/           the only directory it may read or write
      └─ memory MCP server ─▶ vault (Markdown) + vectors (local embeddings)
```

---

## What is in here

| Path | What it is |
|---|---|
| `dashboard/` | The web panel: Node, server-rendered, no client framework |
| `dashboard/deploy/` | Privileged helper, systemd units, nginx, fail2ban, sudoers |
| `memory/` | `moni-memory` — vector + keyword memory over an Obsidian vault, exposed to Claude over MCP |
| `deploy/` | Bootstrap and deployment scripts, the vault template |
| `docs/` | Setup, Telegram, memory internals, operations |
| `ops/` | Local helper scripts (RDP launcher) |

The agent runtime itself — the Telegram↔Claude bridge — is a **separate repo**,
[`Claude_VPS`](https://github.com/mo-zaghloul96/Claude_VPS), cloned onto the
server by the bootstrap script. This repo drives it; it does not fork it.

---

## Quick start

On a fresh Ubuntu 24.04 box, as root:

```bash
git clone https://github.com/mo-zaghloul96/MONI_AI_OS.git /opt/moni-ai-os
bash /opt/moni-ai-os/deploy/bootstrap.sh
```

That installs the Claude CLI, creates the `moniagent` service account, clones and
builds the agent runtime, downloads the embedding model, and installs the
privileged helper and systemd template.

Then give the agents a Claude credential — this is the one step the script
deliberately leaves to you, because it is a secret:

```bash
claude setup-token                     # run where you have a browser
echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...' \
  | sudo tee /opt/moni-agents/shared/claude-auth.env
sudo chown root:moniagent /opt/moni-agents/shared/claude-auth.env
sudo chmod 640 /opt/moni-agents/shared/claude-auth.env
```

Deploy the panel, then create your first agent in it:

```bash
sudo bash /opt/moni-ai-os/deploy/deploy-dashboard.sh
```

Optionally put Obsidian on the desktop so you can read and edit agent memory by
hand:

```bash
sudo bash /opt/moni-ai-os/deploy/install-obsidian.sh
```

Full walkthrough — including creating the Telegram bot — is on the panel's own
**Guide** page, and in [`docs/telegram.md`](docs/telegram.md).

---

## Memory

The interesting part. A Telegram session dies on timeout, restart, or `/new`;
nothing in the conversation survives it. Files do.

```
vault/
├── CLAUDE.md      identity and standing rules   → system prompt, every request
├── MEMORY.md      current state + note index    → system prompt, every request
├── WORKLOG.md     dated narrative
└── memory/*.md    one durable fact per file, linked with [[wikilinks]]
```

`MEMORY.md` is in the prompt, so it has a budget — it is the map, not the
territory. The notes it points at are indexed instead: chunked by heading,
embedded by a small ONNX model **running on the box**, stored in a per-agent
SQLite database with `sqlite-vec`. The agent calls `memory_search` before
answering anything that depends on prior work.

Search is hybrid. Dense vectors catch paraphrase ("how do we deploy" finding
"release procedure"); FTS5 catches the exact tokens embeddings lose (error
codes, flag names, IDs); the two rankings are merged with reciprocal rank
fusion, which needs no score calibration between them.

Two properties worth stating plainly:

- **Files are the source of truth, the index is a cache.** Delete
  `vectors/memory.db` and press Reindex; nothing is lost. Edit a note by hand in
  Obsidian and the agent picks it up on its next search, with nothing to tell it.
- **Nothing leaves the machine to be embedded.** An agent's memory is the most
  sensitive thing it holds, and it is not worth sending to a third party for a
  few points of retrieval quality.

See [`docs/memory.md`](docs/memory.md).

---

## Security model

The central assumption: **this panel can grant SSH access and create processes
that run model-authored commands, so compromising it means compromising the
server.** Everything below follows from that.

| Layer | What it does |
|---|---|
| TLS | Let's Encrypt, TLS 1.2/1.3 only, HSTS. nginx terminates. |
| Authentication | Username + Argon2id password + TOTP 2FA. All three required. |
| Session | httpOnly, secure, sameSite=strict, regenerated on login. |
| CSRF | Per-session token on every state-changing POST. |
| Rate limiting | nginx `limit_req` plus an in-app limiter. |
| Brute force | fail2ban on the app's own auth log: 5 fails / 10 min = 2h ban. |
| Privilege | Panel runs as `moniadmin` (nologin). Can sudo exactly one binary. |
| Agent sandbox | Agents run as `moniagent` under a systemd sandbox: read-only filesystem apart from their own directory, `NoNewPrivileges`, `PrivateTmp`. |

### The privilege boundary

The Node process is unprivileged and **has no ability to run root commands**. It
can only do this:

```
sudo /usr/local/sbin/moni-helper <subcommand> [args]
```

`/etc/sudoers.d/moni-dashboard` permits exactly that one binary — no wildcards,
no shell. The helper then validates every argument against a whitelist, never
invokes a shell, restricts SSH targets to `root` and `ubuntu`, restricts agent
names to a strict slug pattern, restricts project directories to three
permitted roots, confines vault file access to `.md`/`.json`/`.txt` inside the
agent's own vault, and appends every change to an audit log.

So even a full remote-code-execution bug in the web app does not directly yield
root — the attacker inherits only the validated operations.

**Bot tokens go over stdin, never argv.** Command lines are world-readable in
`/proc` for the lifetime of a call; a token passed as an argument is a token any
local user can read.

**Agent deletion archives, it does not erase.** A vault is months of accumulated
memory and there is no undo for `rm -rf`, so deletion moves the whole directory
to `/opt/moni-agents/archived/<slug>-<timestamp>`.

---

## Gotchas worth remembering

- **`NoNewPrivileges` must stay `false` in the *dashboard* unit** — the panel
  escalates via sudo. It is deliberately `true` in the *agent* unit, which does
  not.
- **No inline event handlers.** The CSP sets `script-src-attr 'none'`, so
  `onclick=` is dead. Use `data-confirm` and the delegated listener in
  `public/app.js`.
- **One poller per bot token.** Telegram allows exactly one; two agents sharing
  a token makes both drop messages at random.
- **nginx 1.24** wants `listen ... ssl http2`, not the standalone `http2 on;`
  from 1.25.1+.
- **`trust proxy` is `loopback` only.** Widening it lets a remote client spoof
  `X-Forwarded-For` and defeat the fail2ban jail.
- Port 80 is reserved for ACME renewal only.

---

## Recovering from a lockout

If you lose the TOTP device, SSH in and clear the admin row — the next visit to
`/setup` with a fresh token lets you re-enrol:

```bash
systemctl stop moni-dashboard
sqlite3 /var/lib/moni-dashboard/moni.db 'DELETE FROM admin;'
rm -f /var/lib/moni-dashboard/setup.token
systemctl start moni-dashboard
cat /var/lib/moni-dashboard/setup.token
```

Moving to a new laptop: [`docs/new-laptop.md`](docs/new-laptop.md).
