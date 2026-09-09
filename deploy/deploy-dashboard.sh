#!/usr/bin/env bash
#
# Push dashboard code from this repo checkout to the running service.
#
#   sudo bash /opt/moni-ai-os/deploy/deploy-dashboard.sh
#
# Syntax-checks before restarting: a broken server.js otherwise leaves systemd
# in a restart loop with the panel down and no obvious way back in.

set -euo pipefail

TARGET=/opt/moni-dashboard
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/dashboard"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }
[[ -d "$SRC" ]] || { echo "no dashboard/ in $REPO_DIR" >&2; exit 1; }

say "Syncing application code"
mkdir -p "$TARGET"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude 'deploy' \
  "$SRC/" "$TARGET/"

say "Installing dependencies if package.json changed"
if [[ ! -d "$TARGET/node_modules" ]] || \
   [[ "$SRC/package.json" -nt "$TARGET/node_modules" ]]; then
  (cd "$TARGET" && npm install --omit=dev --no-audit --no-fund)
fi

say "Checking syntax before restarting"
for f in "$TARGET"/server.js "$TARGET"/lib/*.js; do
  node --check "$f"
done

say "Installing the privileged helper and unit files"
install -m 0755 "$SRC/deploy/moni-helper" /usr/local/sbin/moni-helper
python3 -m py_compile /usr/local/sbin/moni-helper
install -m 0644 "$SRC/deploy/moni-agent@.service" /etc/systemd/system/moni-agent@.service
install -m 0440 "$SRC/deploy/moni-sudoers" /etc/sudoers.d/moni-dashboard
visudo -cf /etc/sudoers.d/moni-dashboard >/dev/null
systemctl daemon-reload

say "Restarting the dashboard"
systemctl restart moni-dashboard
sleep 2
systemctl is-active --quiet moni-dashboard && say "Dashboard is up" || {
  echo "Dashboard failed to start:" >&2
  journalctl -u moni-dashboard -n 30 --no-pager >&2
  exit 1
}
