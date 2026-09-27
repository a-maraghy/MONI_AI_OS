# MONI AI

MONI AI is the CEO of every Claude Code session on this machine. It takes a
command from the administrator, finds the session that owns the work and hands
the command over through Claude Code's own peer messaging (`ListAgents` /
`SendMessage`), so the command shows up in that session's chat. Replies and
"finished" notices come back to MONI AI, which relays them.

It is one long-lived headless Claude Code session, run by a supervisor:

```
 dashboard (moniadmin)            Claude Desktop / claude.ai
   /moni-ai/api/*  JSON + SSE            │  Remote Control
        │                                │
        │ unix socket, group moniai      │
        ▼                                ▼
  moni-ai.service  (root)  ──stdin/stdout stream-json──▶  claude -p … -n "MONI AI"
   supervisor.js                                          cwd /root/moni-ai, HOME=/root
   ├─ ledger.db  (turns, delegations, inbound,             │ ListAgents / SendMessage
   │              approvals, audit)                        ▼
   ├─ ring buffer → event stream                   every other Claude Code session
   └─ hook.sock (root only) ◀── hooks/ledger.js    on the box (Desktop over SSH,
                              ◀── hooks/gate.js     terminals, headless)
```

| Path | What |
|---|---|
| `/opt/moni-ai/` | supervisor, `lib/`, `hooks/`, `bin/moni-ai-ctl`, pinned CLI in `cli/` |
| `/etc/moni-ai/config.json` | model, effort, CLI pin, approval timeout, delegation allow-list |
| `/root/moni-ai/CLAUDE.md` | the CEO charter MONI AI reads |
| `/root/moni-ai/.claude/settings.json` | the gate and ledger hooks |
| `/var/lib/moni-ai/ledger.db` | the ledger (SQLite, 0600) |
| `/var/lib/moni-ai/state.json` | fixed session id, Remote Control session (0600) |
| `/run/moni-ai/moni-ai.sock` | control socket, `root:moniai 0660` |
| `/run/moni-ai/hook.sock` | hook socket, root only |
| `/var/log/moni-ai/audit.log` | every action through the socket, with the panel user |

Source of truth is `MONI_AI_OS/moni-ai/`; `deploy/deploy-moni-ai.sh` installs
all of the above. Do not edit the installed copies.

## How a command travels

1. The administrator types in the Command Center (`POST /moni-ai/api/send`).
   The panel checks it, then the supervisor checks it again and writes it to
   MONI AI's stdin as a stream-json user message with its own uuid.
2. MONI AI calls `ListAgents`, picks the session by name and working
   directory, and calls `SendMessage` with `notify_when_idle: true`.
3. The PreToolUse hook (`hooks/gate.js`) reads the message. Harmless: it goes.
   Destructive: see *the approval gate* below.
4. The PostToolUse hook posts the `msg_id` to the supervisor: the delegation is
   **sent**.
5. The supervisor polls `claude agents --json` every 5 s. The target busy:
   **working**. A `<cross-session-message>` back from it (seen by the
   UserPromptSubmit hook, sender pid from its socket path): **ack**, with the
   reply stored. The `[Cross-session idle notice]`, or the target idle again:
   **done**. The target gone: **failed**. A delivery notice saying the target
   holds messages for its user: **held**. Denied at the gate: **denied**.
6. The reply also wakes MONI AI (a peer message starts a turn on its own), and
   it relays the answer. Every event goes out on the stream.

## The approval gate

The administrator's rule: **ask before anything destructive** — deleting
files or records, stopping or restarting services, `git push` and force
operations, database writes and drops, killing processes, changing
permissions or credentials, and telling another session to do any of these.

It is enforced, not only asked for in the charter:

- `hooks/gate.js` runs before every `Bash`, `Monitor`, `SendMessage`,
  `memory_forget`, `CronCreate` and `RemoteTrigger` call and classifies it with
  `lib/classifier.js` (conservative: it asks when it cannot tell — SQL on stdin,
  inline scripts, heredocs, `ssh host cmd`, `bash -c`, `claude -p`).
- Destructive → the hook answers `permissionDecision: "ask"`. MONI AI runs with
  `--permission-prompt-tool stdio`, so the CLI sends the supervisor a
  `can_use_tool` control request and waits.
- The supervisor records it and pushes an `approval` event: the dashboard shows
  an Approve / Deny card. Approve → `allow`; Deny → `deny` with a message telling
  MONI AI who denied it and not to retry or route around it.
- **Nobody answers within `approval_timeout_s` (300 s) → denied.** A restart of
  the process cancels whatever was pending.
- The `ask` rules in root's own `settings.json` (`rm -rf`, `git push`,
  `systemctl restart`, …) reach the same path, as does anything auto mode
  decides to ask about. Every `can_use_tool` becomes a card.
- `delegation_allow` in the config, when non-empty, is a list of regexes a
  `SendMessage` target must match, else it is denied outright. Empty in
  production; used by the end-to-end test so MONI AI cannot reach a real session.

It is a tripwire, not a sandbox. A model that writes a script file and then
runs `python3 script.py` gets past a classifier that never sees the script.
That is why the charter asks as well, and why the gate fails closed.

### Remote Control

Remote Control is switched on at every start (control request
`remote_control`), and its session URL is served by `rc-url` so the page can
offer *Open in Claude Desktop*. The URL is a live door into a root session:
keep it out of commits, docs and chat.

A turn typed through Remote Control runs in the same process, so the same
hooks and the same gate apply: the hook answers `ask`, the CLI sends its
`can_use_tool` request to the supervisor on stdout whatever the turn's source,
and a card appears **in the dashboard**, timing out to deny.

What the Remote Control client itself shows was **not verified** (it needs a
person signed in to claude.ai). The 2.1.283 binary carries bridge code that
relays permission requests to a remote client and a `control_cancel_request`
path, so claude.ai may show the same prompt. If it is answered there first,
the CLI withdraws the dashboard's copy and the supervisor records the card as
`cancelled` ("answered elsewhere"). Either way nothing runs unanswered: the
dashboard card still times out to deny. Check this by hand the first time the
administrator uses Remote Control, and record what happened here.

## Traps

- **Never `--resume` MONI AI's session id from a second process.** Claude Code
  does not stop it: the second process silently forks the transcript. The
  supervisor holds a lock, resumes only after the old process has exited, and
  refuses to start (state `blocked`) while any live registry entry or process
  command line holds the id. Desktop reaches MONI AI through Remote Control only.
- **It must run as root, `HOME=/root`, default config dir.** Peer discovery goes
  through `/root/.claude/sessions/<pid>.json`. The old console's account
  (`moniconsole`, `CLAUDE_CONFIG_DIR=/var/lib/moni-console`) is a separate
  registry that cannot see root's sessions. The supervisor builds the child's
  environment from nothing so no `CLAUDE_CODE_*` variable leaks in.
- **Auto mode depends on the model.** With Haiku, `--permission-mode auto`
  silently runs as `default`; with Opus 5.5 it is `auto`. The gate works in both.
- **The CLI is pinned.** `/opt/moni-ai/cli/claude-<version>` is a copy, not a
  link, because `claude update` or a desktop update would change the binary
  under a running MONI AI. The supervisor refuses to start on a version that
  does not match `cli_version`. **After any Claude Code update, re-verify before
  moving the pin:** peer registration and `SendMessage` from a headless session,
  replayed peer turns (`origin.kind = "peer"`), `remote_control` returning a
  `session_url`, and a `can_use_tool` request after a hook answers `ask`. The
  end-to-end steps below do exactly that.
- **Idle notices need `notify_when_idle: true`.** Without it the supervisor
  still closes a delegation when it sees the target go idle, from the poll.
- The ledger hooks never write the database: one writer, the supervisor. If its
  socket is down they spool to `/var/lib/moni-ai/hook-spool.jsonl`, read back at
  start.

## Operations

```bash
systemctl status moni-ai
journalctl -u moni-ai -f
moni-ai-ctl status                      # process, current turn, approvals, vitals
moni-ai-ctl sessions                    # claude agents --json + the ledger
moni-ai-ctl ledger '{"table":"delegations","limit":10}'
moni-ai-ctl events                      # live stream, Ctrl-C to stop
moni-ai-ctl send '{"text":"What is every session doing?"}'
moni-ai-ctl approve '{"approval_id":7}'
moni-ai-ctl restart                     # graceful: stdin closed, transcript kept, resumed
sudo bash /root/moni/MONI_AI_OS/deploy/deploy-moni-ai.sh
```

`systemctl stop moni-ai` closes MONI AI's stdin and waits for it to write its
transcript before killing anything. Starting again resumes the same session.

### Socket protocol

One JSON object per line, `{"id", "op", "actor", …params}` in, one
`{"id", "ok", "data" | "error"}` out. `actor` (the panel user) is required on
every call; unknown fields are refused. `lib/protocol.js` is the definition.

| op | params | |
|---|---|---|
| `ping`, `status`, `sessions`, `rc-url` | – | read |
| `events` | `since?` | reply, then `{"event": …}` lines until closed |
| `ledger` | `table` (delegations, inbound, approvals, turns, audit), `limit?`, `before_id?`, `status?` | read |
| `send` | `text`, `target?` (a live session's name, or `auto`) | audited |
| `interrupt` | – | audited |
| `approve`, `deny` | `approval_id`, `note?` | audited |
| `rc` | `enabled` | audited |
| `restart` | – | audited |

Events: `proc`, `init`, `rc`, `turn` (queued / start / source / end), `text`
(streamed deltas, not buffered), `assistant`, `tool`, `tool_result`, `steps`,
`result`, `approval`, `delegation`, `inbound`, `sessions`, `vitals`, `notice`.

## Tests

```bash
node moni-ai/tools/test-classifier.cjs        # the gate's classifier
node moni-ai/tools/test-protocol.cjs          # socket validation, peer-text parsing
sudo node moni-ai/tools/test-supervisor.cjs   # the whole supervisor against a fake CLI
node dashboard/tools/test-moniai.cjs          # the panel's client and permission
```

### End-to-end against the real CLI (2026-09-27, CLI 2.1.283)

Run with `delegation_allow` set to `^moni-e2e-target( \[[0-9a-f]+\])?$` so
MONI AI could not reach any real session, and reset to `[]` afterwards. The
target was a throwaway headless Haiku session named `moni-e2e-target` in a
scratch directory, stopped at the end.

- `claude agents --json` lists `MONI AI`, cwd `/root/moni-ai`, idle.
- A harmless turn through the socket answered ("MONI AI online, running on
  Claude Opus 5.5"); the init event reported `permissionMode: auto`.
- Delegation: MONI AI called `ListAgents`, then `SendMessage` with
  `notify_when_idle`. Ledger: **sent → working → ack** (reply `PONG-E2E`, sender
  pid from its socket path) **→ done** (idle notice). The reply started a
  `peer` turn on its own and MONI AI relayed it.
- Gate: `rm` of a scratch file raised card #1 (category *delete*); **denied** —
  the file stayed and MONI AI said it would not retry. A delegation telling the
  target to delete a file raised card #2 (*delegation*); **approved** and sent.
  A second direct `rm` raised card #3; **approved** — the file was deleted.
- Remote Control returned a `session_url` at start and after every restart.
- `systemctl restart moni-ai` resumed the same session id (one transcript
  file); asked what came before, MONI AI named the previous request.
- Through the panel (a scratch instance of the dashboard as `moniadmin`, with a
  throwaway admin): login, `/overview`, `/rc`, ledger, CSRF refusals, SSE with
  `X-Accel-Buffering: no`, and a send whose reply streamed back over SSE,
  audited under the panel user.
- The socket answered `moniadmin` and refused `moniconsole`, `moniagent` and
  `nobody` (EACCES).
