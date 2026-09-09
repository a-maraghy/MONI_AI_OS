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

# The account the panel's console runs as. Separate from moniagent so the two
# entitlements can never be confused for one another: this one holds full sudo,
# and an agent must never inherit it.
if ! id -u moniconsole >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/moni-console/home \
          --shell /bin/bash moniconsole
fi
# A real shell, not nologin: the console's Bash tool runs commands through one,
# and nologin made every command trip over a profile it could not read.
usermod --shell /bin/bash moniconsole
# Reading the journal is most of what "check why this is unhappy" means. These
# groups grant it directly, so ordinary log reading does not need sudo and does
# not fill the sudo log with noise that hides the escalations worth seeing.
usermod -aG adm,systemd-journal moniconsole
# 0711: the console account must walk through this to reach its own config and
# attachments. Everything below it keeps 0700, so this opens the door without
# opening the cupboards.
install -d -m 0711 -o root -g root /var/lib/moni-console
install -d -m 0700 -o moniconsole -g moniconsole /var/lib/moni-console/home
install -m 0644 "$SRC/deploy/moni-agent@.service" /etc/systemd/system/moni-agent@.service
# The dashboard's own unit was installed by hand once and then never again, so
# edits to it in the repo silently did nothing. Installing it here makes the
# repo the source of truth for it, like every other unit.
install -m 0644 "$SRC/deploy/moni-dashboard.service" /etc/systemd/system/moni-dashboard.service
install -m 0644 "$SRC/deploy/moni-whatsapp@.service" /etc/systemd/system/moni-whatsapp@.service
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
