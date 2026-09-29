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
| `send` | `text`, `target?` (a live session's name, or `auto`), `via?` (`voice-desk`: recorded as the turn's source) | audited |
| `snapshot` | `turns?` (the voice front desk's own earlier turns) | read: counts, titles and human-unit figures for the voice front desk, never a command (`lib/snapshot.js`) |
| `interrupt` | – | audited |
| `approve`, `deny` | `approval_id`, `note?` | audited |
| `rc` | `enabled` | audited |
| `restart` | – | audited |

Events: `proc`, `init`, `rc`, `turn` (queued / start / source / end), `text`
(streamed deltas, not buffered), `assistant`, `tool`, `tool_result`, `steps`,
`result`, `approval`, `delegation`, `inbound`, `sessions`, `vitals`, `notice`.

Command Center v3, phase 1 (all re-validated in `lib/protocol.js`, writes audited):

| op | params | |
|---|---|---|
| `machine`, `watchers`, `orders`, `rules`, `cost` | – | read |
| `missions` / `mission` | `status?` / `mission_id` (`M-12`) | read |
| `decisions` | `status?` (open, all) | read |
| `order-runs` | `order_id` | read |
| `rule-test`, `rule-suggest` | `command, tool?` / `approval_id` | read |
| `session-mirror` | `session_id` (uuid) | read: the transcript's last turns, tools today, delegations, cost |
| `mission-create`, `mission-step-add`, `mission-step-update`, `mission-update` | see the protocol | MONI AI's MCP tools call these as actor `moni-ai` |
| `mission-request` | `goal` | "New mission": a queued turn asking MONI AI to plan it |
| `decision-propose`, `decision-update` | `decision_id, summary, evidence?, fix_command?` / `status, result?` | MONI AI |
| `decision-approve`, `decision-dismiss`, `decision-ask` | `decision_id, note?` / `text` | administrator |
| `watcher-set` | `key, enabled` | persisted |
| `watcher-inject` | `watcher, subject, detail?, evidence?` | fault injection; refused unless `watcher_inject` is true in the config (tests only) |
| `order-create`, `order-update`, `order-delete`, `order-run`, `order-pause` | name, schedule, target, prompt, delivery, paused | standing orders |
| `rule-create`, `rule-update`, `rule-delete` | effect, tool, pattern, note | built-ins refused |
| `approve` | + `rule_pattern, rule_tool` | "Always allow this": saves the rule, then approves |
| `cost-budget` | `daily_usd` (or null), `warn_pct` | |

New events: `mission`, `decision`, `watcher`, `order`, `order_run`, `rule`, `machine`.

## Command Center v3, phase 1

`lib/features.js` holds everything below and is wired into the supervisor at
a few points (a turn's result and end, a delegation, an approval, a hook
event). All of its state is in the ledger, so a restart loses nothing.

- **Missions** (`lib/missions.js`, tables `missions`, `steps`, `mission_turns`).
  MONI AI plans a multi-step goal with its own MCP tools (`bin/moni-ai-mcp`,
  passed with `--mcp-config` and allowed with `--allowedTools mcp__moni-ai`):
  `mission_create`, `mission_step_add`, `mission_step_update`,
  `mission_update`, `mission_list`, `mission_get`. A delegation whose first line
  carries `M-<id> step <n>` is linked to that step (or, untagged, to the one
  step marked delegated to that target), and its lifecycle then drives the
  step: sent → delegated, working/ack → working, held or a pending card →
  waiting approval, done → done, failed/denied → failed. A mission is done when
  every step is done or skipped. Chosen over a CLI because typed tools need no
  shell quoting and do not go through the Bash gate; `moni-ai-ctl` speaks the
  same ops for a human.
- **Status snapshot for MONI AI.** The same server has `status_snapshot`: the
  supervisor's read-only `snapshot` op (the voice desk's view, `lib/snapshot.js`)
  asked for as actor `moni-ai`, with no arguments. It answers from the caches the
  supervisor keeps anyway -- no helper call, no subprocess, no model round spent on
  Bash -- and holds counts, titles and figures, never a command, fix or evidence;
  the server drops the forbidden keys again and the desk's own request list. The
  charter tells MONI AI to use it first for status questions.
- **Decisions and watchers** (`lib/watchers.js`, tables `decisions`,
  `watchers`). Every 30 s: the helper's `service-list` (a unit failed) and
  `pulse-feed` (fail2ban bans > 20 in 10 min; an agent started 3 times in 10
  min), statfs (root filesystem ≥ 85 %), and a read-only tail of the TRIAL
  box's `/var/log/odoo/odoo.log` (≥ 5 ERROR lines in 5 min). Live Odoo is not
  watched. A firing raises a decision card and queues (never interrupts) a
  MONI AI turn to investigate read-only and call `decision_propose`. Approve
  queues a turn to run exactly the proposed fix, which still goes through the
  gate (a destructive fix raises its own card; that is deliberate, not a
  bypass); Ask more queues a follow-up; Dismiss closes it. One open card per
  (watcher, subject) — repeats bump its count; a closed subject is quiet for
  `watcher_cooldown_s` (1800); at most `watcher_max_investigations_per_hour`
  (4) investigations, past that the card is raised "rate-limited" with an
  Investigate button. Switches persist in `watchers`.
- **Standing orders** (`lib/schedule.js`, tables `orders`, `order_runs`).
  Five-field cron in `Africa/Cairo` (DST-aware: a doubled time runs once, a
  skipped one just after the jump). The editor's kinds compile to cron: daily,
  Sunday–Thursday (Egypt's working week), weekly, every N hours, cron. A 15 s
  tick moves `next_run_at` on BEFORE starting a run, so a crash or a supervisor
  that was down across several runs runs a missed order once, never a burst; a
  run still going is not stacked. Seeded: **Morning briefing, 07:30 daily**,
  THIS VPS only (services, disk, sign-ins and bans, MONI AI's activity,
  missions), no live Odoo, no live credential. The result is the turn's reply,
  shown as a card in the Conversation. **Delivery is the Command Center only**:
  the Telegram agents keep their bot tokens to themselves and offer no
  supported way to post on MONI AI's behalf.
- **Approval rules** (`lib/rules.js`, table `rules`). allow / ask / deny, a glob
  pattern over the whole Bash command (deny and ask also match one command of a
  compound) or `"<target>: <message>"` for SendMessage, scope MONI AI on this
  VPS. Order: built-in deny (force push; pushing `a-maraghy/gizaseeds-Odoo19` or
  from `/opt/odoo/custom`) > config deny (the delegation allow-list) > a deny
  rule > built-in ask (anything touching live Odoo — no allow overrides it) >
  the most specific allow/ask rule (ask on a tie) > the classifier. `hooks/gate.js`
  reads the rules read-only from the ledger (built-ins are in code, so they hold
  without it; an unreadable store asks) and reports a matched rule's use to the
  hook socket. The supervisor applies the same rules to `can_use_tool`, so a
  rule answers there too (recorded as an approval `decided_by rule:<id>`).
  "Always allow this" saves an exact-command rule that must match the card's
  own call. Built-ins cannot be edited or deleted. Rules for other sessions
  (their settings) are a phase 2 question; phase 1 never writes other sessions'
  settings.
- **Cost** (`lib/cost.js`, tables `cost_daily`, `cost_files`, `cost_names`,
  `settings`). **Trap:** `turns.cost_usd` is the CLI's running total for the
  process. Each result now stores `proc_start` and `cost_delta_usd` (difference
  from the previous turn of the same process; a new process — by stamp, or the
  total going down — starts from its own total); old rows are backfilled at
  start. Other sessions: token usage from their transcripts (sub-agents
  included, once per message id) × list prices, scanned incrementally with
  offsets in the ledger — "estimated API-equivalent". Optional daily budget with
  a warn percentage.
- **Machine**: this VPS only — vitals and the tracked units from `service-list`.
- **Session mirror**: a read-only view of any session's transcript tail.


## Tests

```bash
node moni-ai/tools/test-classifier.cjs        # the gate's classifier
node moni-ai/tools/test-rules.cjs             # approval rules + the real gate hook
node moni-ai/tools/test-schedule.cjs          # cron, Cairo DST, missed runs
node moni-ai/tools/test-watchers.cjs          # thresholds, dedup, cooldown, rate limit
node moni-ai/tools/test-missions-cost.cjs     # missions store, cost deltas, transcript scan
sudo node moni-ai/tools/test-features.cjs     # all of phase 1 through a real supervisor
node moni-ai/tools/test-protocol.cjs          # socket validation, peer-text parsing
node moni-ai/tools/test-mcp.cjs               # the MCP server's status_snapshot tool
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
