#!/usr/bin/env bash
#
# Install or update MONI AI: the supervisor, its hooks, the pinned Claude Code
# CLI, MONI AI's home (charter + hook settings) and the systemd unit.
#
#   sudo bash deploy/deploy-moni-ai.sh               # install / update and restart
#   sudo bash deploy/deploy-moni-ai.sh --no-restart  # install, leave it running as is
#
# Restarting ends MONI AI's current turn (the conversation is kept and resumed).
# Tests first, always:  node moni-ai/tools/test-classifier.cjs,
# test-protocol.cjs and (as root) test-supervisor.cjs.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/moni-ai"
TARGET=/opt/moni-ai
HOME_DIR=/root/moni-ai
CONF_DIR=/etc/moni-ai
RESTART=1
[[ "${1:-}" == "--no-restart" ]] && RESTART=0

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }
[[ -f "$SRC/supervisor.js" ]] || { echo "no moni-ai/ in $REPO_DIR" >&2; exit 1; }

say "Checking syntax"
for f in "$SRC"/supervisor.js "$SRC"/lib/*.js "$SRC"/hooks/*.js "$SRC"/bin/moni-ai-ctl "$SRC"/bin/moni-ai-mcp; do
  node --check "$f"
done

say "The moniai group (who may open the control socket)"
getent group moniai >/dev/null || groupadd --system moniai
# The panel is the one client. Group membership takes effect when the panel
# restarts, which deploy-dashboard.sh does.
id -u moniadmin >/dev/null 2>&1 && usermod -aG moniai moniadmin

say "Installing the supervisor to $TARGET"
install -d -m 0755 "$TARGET" "$TARGET/cli"
rsync -a --delete --exclude cli --exclude home --exclude deploy "$SRC/" "$TARGET/"
chmod 0755 "$TARGET/hooks/"*.js "$TARGET/bin/moni-ai-ctl" "$TARGET/bin/moni-ai-mcp"
ln -sf "$TARGET/bin/moni-ai-ctl" /usr/local/bin/moni-ai-ctl

say "Configuration"
install -d -m 0755 "$CONF_DIR"
if [[ ! -f "$CONF_DIR/config.json" ]]; then
  install -m 0644 "$SRC/deploy/config.json" "$CONF_DIR/config.json"
else
  echo "  keeping the existing $CONF_DIR/config.json"
fi
PIN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).cli_version)' "$CONF_DIR/config.json")

say "Pinning Claude Code $PIN"
# A copy, not a link to /usr/bin/claude: `claude update` or a desktop-app update
# would otherwise change the CLI under a running MONI AI. Peer messaging,
# Remote Control in headless mode and can_use_tool are undocumented enough to
# re-verify on every new version before moving the pin (see the README).
PINNED="$TARGET/cli/claude-$PIN"
if [[ ! -x "$PINNED" ]]; then
  SOURCE="${CLAUDE_PIN_SOURCE:-$(readlink -f /usr/bin/claude)}"
  GOT=$("$SOURCE" --version | awk '{print $1}')
  [[ "$GOT" == "$PIN" ]] || { echo "$SOURCE is $GOT, config pins $PIN. Set CLAUDE_PIN_SOURCE to a $PIN binary." >&2; exit 1; }
  install -m 0755 "$SOURCE" "$PINNED"
fi
ln -sfn "claude-$PIN" "$TARGET/cli/claude"
"$TARGET/cli/claude" --version

say "MONI AI's home, $HOME_DIR"
install -d -m 0700 "$HOME_DIR" "$HOME_DIR/.claude"
install -m 0644 "$SRC/home/CLAUDE.md" "$HOME_DIR/CLAUDE.md"
install -m 0644 "$SRC/README.md" "$HOME_DIR/README.md"
install -m 0644 "$SRC/home/.claude/settings.json" "$HOME_DIR/.claude/settings.json"

say "systemd unit"
install -m 0644 "$SRC/deploy/moni-ai.service" /etc/systemd/system/moni-ai.service
systemctl daemon-reload
systemctl enable moni-ai >/dev/null 2>&1

if [[ $RESTART -eq 1 ]]; then
  say "Restarting moni-ai"
  systemctl restart moni-ai
else
  systemctl is-active --quiet moni-ai || systemctl start moni-ai
fi
sleep 3
systemctl is-active --quiet moni-ai && say "moni-ai is up" || {
  echo "moni-ai failed to start:" >&2
  journalctl -u moni-ai -n 40 --no-pager >&2
  exit 1
}
