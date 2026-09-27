# Dashboard

The web panel. Node, server-rendered HTML, no client framework, no external
assets — the CSP blocks them, and a panel that can grant SSH access is the last
place to be pulling scripts off a CDN.

Architecture, security model and deployment: see the [repository README](../README.md)
and [docs/agents.md](../docs/agents.md).

## Layout

    server.js              routes, auth, sessions, CSRF
    lib/db.js              SQLite: admin account, pairing codes, devices, login log
    lib/priv.js            wrapper that shells out to the privileged helper
    lib/ui.js              shared page chrome and formatting
    lib/views.js           system pages (overview, keys, devices, audit)
    lib/views-agents.js    agent management pages
    lib/views-guide.js     the operator's manual, served from the panel
    lib/views-claude.js    Claude Code: memory, sessions, running processes
    lib/moniai.js          client for the MONI AI supervisor's unix socket
    lib/telegram.js        Bot API client, used only to validate configuration
    public/style.css       styles
    public/app.js          confirmations + live stat refresh + Running refresh
    tools/test-*.cjs       standalone tests (node tools/test-claude.cjs)

    deploy/moni-helper             privileged helper -> /usr/local/sbin/
    deploy/moni-agent@.service     systemd template, one instance per agent
    deploy/moni-dashboard.service  systemd unit for this panel
    deploy/nginx-moni.conf         nginx site
    deploy/moni-proxy-params       shared proxy headers
    deploy/moni-sudoers            the single-command sudo rule
    deploy/fail2ban-*.conf         filter and jail

## Deploying a change

    sudo bash /opt/moni-ai-os/deploy/deploy-dashboard.sh

It syntax-checks every file before restarting. Doing it by hand instead, always
`node --check` first — a syntax error otherwise leaves the service in a restart
loop with the panel down.

## Claude Code pages

OS Dashboard > Claude Code: **Memory** (`/claude/memory`), **Sessions**
(`/claude/sessions`), **Running** (`/claude/running`). Permissions
`claude.memory.read|write`, `claude.sessions.view|manage`,
`claude.running.view|stop` -- in no stock role, so administrator-only until a
role is given them: transcripts hold client data and the panel faces the
internet.

All data comes from the helper's `cc-*` subcommands. Memory reads and writes go
through memlib, run by the claude-memory venv inside the helper, so the database
credentials in `/root/.claude-memory/db.env` never reach this process. Output is
redacted by the helper (its own rules plus memlib's) and again by
`priv.redactDeep`. Nothing is deleted: editing a fact supersedes it, forgetting
is memlib's soft delete, archiving a session moves it to
`<home>/.claude/archive/dashboard-archived/`. Rename and archive are refused
while a session runs; Stop sends SIGINT only to a pid registered in a
`sessions/<pid>.json` whose process is the claude binary, and SIGTERM only 10 s
after that. Every write is in the audit log with the panel user.

Known follow-up: the memory search service on 127.0.0.1:8765 takes no token, so
any local process can query it. Adding one is deliberately left for later.

## MONI AI API

MONI AI (the renamed MONI Bot) is one root Claude Code session that delegates
commands to every other session on the machine. It is run by its own
supervisor, `moni-ai.service`; the design, the approval gate and the traps are
in [`moni-ai/README.md`](../moni-ai/README.md). The panel's part is a JSON and
SSE API for the Command Center page, which is built separately. The old
console (`/console`) keeps working until that page ships; only its label
changed.

Permission `moniai.use`, in no stock role: it reaches a root session that can
message every session on the box. API routes answer in JSON, refusals too
(401 not signed in, 403 no permission or bad CSRF, 400 invalid, 409 refused
by the supervisor, 503 supervisor down, 504 no answer).

    GET  /moni-ai/api/overview             status + sessions + recent delegations + memory counts + csrf
    GET  /moni-ai/api/status               process, current turn and its steps, pending approvals, vitals, counts
    GET  /moni-ai/api/sessions             claude agents --json merged with the ledger
    GET  /moni-ai/api/memory               fact / chunk / session counts (cached 60 s)
    GET  /moni-ai/api/rc                   Remote Control state and session URL
    GET  /moni-ai/api/ledger/:table        delegations | inbound | approvals | turns | audit
                                           ?limit=&before_id=&status=
    GET  /moni-ai/api/events               Server-Sent Events; Last-Event-ID or ?since= resumes
    POST /moni-ai/api/send                 {text, target?}
    POST /moni-ai/api/interrupt
    POST /moni-ai/api/approvals/:id/approve   {note?}
    POST /moni-ai/api/approvals/:id/deny      {note?}
    POST /moni-ai/api/rc                   {enabled}
    POST /moni-ai/api/restart

Writes carry the CSRF token as `_csrf` in the JSON body or an `X-CSRF-Token`
header (`/overview` returns it). SSE event names are the supervisor's event
types (`turn`, `text`, `assistant`, `tool`, `steps`, `approval`,
`delegation`, `inbound`, `sessions`, `vitals`, `rc`, `proc`, …); `text` deltas
carry no id and are not replayed after a reconnect.

The panel reaches the supervisor over `/run/moni-ai/moni-ai.sock`
(`root:moniai 0660`). `moniadmin` is in the `moniai` group -- the deploy script
adds it, and it takes effect at the restart that follows. No sudo is involved;
the supervisor re-validates every request and audits every write with the
panel user (`/var/log/moni-ai/audit.log` and its ledger). The panel also logs
sends, approvals and restarts in its own login log.

`deploy-dashboard.sh` now tars the tree it replaces to
`/root/backups/moni-dashboard_<timestamp>.tgz` before syncing.

Tests: `node dashboard/tools/test-moniai.cjs` (client and permission).
