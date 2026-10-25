# ChatGPT for every agent (`ask_chatgpt`)

Any agent on this server can hand a task to ChatGPT when the user asks for it
("ask ChatGPT…", "delegate this to GPT"). Never on its own initiative: the tool
description and each agent's prompt say so.

```
agent (Claude Code) --stdio--> chatgpt_mcp.py --unix socket--> broker.py --> codex exec
  runs as the agent's account     /run/mint-chatgpt/sock       mint-chatgpt.service (root, fenced)
```

- **One sign-in, one broker.** The user's ChatGPT login is `/root/.codex/auth.json`
  (Codex CLI, `codex login --device-auth`). Only the broker runs Codex with it; no
  copies (Codex rotates the refresh token, so copies would invalidate each other).
  Re-login: `mint-chatgpt login` as root. Check: `mint-chatgpt status`.
- **What ChatGPT can touch.** `codex exec --sandbox workspace-write` in a fresh
  `/var/lib/mint-chatgpt/tasks/<id>/work` (no network for its commands), inside the
  unit's systemd sandbox: system read-only, `/root` empty except `.codex`, `/opt`,
  logs, Odoo/MINT AI/dashboard data and `/etc` secrets inaccessible. Root rather than
  a dedicated account because Codex's bubblewrap needs a user namespace, which this
  Ubuntu's AppArmor only grants unprivileged accounts with an extra profile.
  Answers and files are checked for the sign-in's tokens before they leave.
- **Limits** (`/etc/mint-chatgpt/config.json`): 2 tasks at a time, 8 queued, 10 min
  per task, answer cut at 60,000 characters, 20 files / 10 MB in, 20 files / 25 MB
  out, task folders kept 7 days, callers limited to root / moniagent / moniconsole
  (SO_PEERCRED). One log line per call: journal (`journalctl -u mint-chatgpt`) and
  `/var/lib/mint-chatgpt/calls.jsonl` (who, when, how long, outcome; never the task
  text). `mint-chatgpt log`.
- **Errors** come back as the tool's text: sign-in expired (run `mint-chatgpt login`),
  usage limit reached, timeout, busy, service not running.

## Who gets the tool

| Agent | Where it is wired | Context files from | Files ChatGPT made go to |
|---|---|---|---|
| Telegram agents (every slug, new ones too) | runtime `src/claude/chatgpt_tool.py` (Claude_Agents), `ALLOW_CHATGPT` | its vault only | `<vault>/chatgpt/<id>/` (send_file can post them) |
| MINT AI | `moni-ai/supervisor.js` `mcpArgs()` + `lib/chatgpt.js` | anywhere (root) | `/root/moni-ai/chatgpt/<id>/` |
| Hired sessions | `moni-ai/bin/mint-session` | anywhere (root) | `/var/lib/moni-ai/chatgpt/<slug>/<id>/` |
| Console chats | `dashboard/deploy/moni-helper` `console_chatgpt_args` | full: anywhere; workspace: `/opt/moni-agents/agents` | the console account's `~/chatgpt/<id>/` |

Each loads `/usr/local/lib/mint-chatgpt/chatgpt_mcp.py` only if it exists, and
allows `mcp__chatgpt__ask_chatgpt` outright. Each reads its MCP config at start,
so a change here reaches a running agent at its next restart.

## Install / update

`sudo bash deploy/install-chatgpt.sh` (idempotent; restarts the broker only when
its code changed and nothing is running). Tests: `python3 chatgpt/test_chatgpt.py`
(fake Codex, no ChatGPT usage) and `node moni-ai/tools/test-chatgpt.cjs`.
