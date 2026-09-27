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

# The tree being replaced, kept so a bad deploy is one tar command from undone.
if [[ -d "$TARGET" ]]; then
  BACKUP_DIR=/root/backups
  install -d -m 0700 "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/moni-dashboard_$(date +%Y%m%d_%H%M%S).tgz"
  say "Backing up the current tree to $BACKUP"
  tar -czf "$BACKUP" -C "$(dirname "$TARGET")" --exclude "$(basename "$TARGET")/node_modules" "$(basename "$TARGET")"
fi

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

# Speech to text, with the model resident. Loading a 142MB model per recording
# cost 2.26s where this costs 0.12s, which is the difference between talking to
# the panel and waiting for it. Its own account, no shell and no sudo: parsing a
# stranger's audio is not work for a privileged process.
if [[ -x /opt/moni-agents/shared/whisper.cpp/build/bin/whisper-server ]]; then
  id -u monispeech >/dev/null 2>&1 || \
    useradd --system --no-create-home --shell /usr/sbin/nologin monispeech
  install -m 0644 "$SRC/deploy/moni-whisper.service" /etc/systemd/system/moni-whisper.service
  systemctl daemon-reload
  systemctl enable --now moni-whisper >/dev/null 2>&1 || true
else
  say "  (whisper-server not built; transcription stays on the slow path)"
fi

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
# MONI AI's supervisor listens on a socket only root and the moniai group can
# open; the panel reaches it by being in that group. Takes effect at the
# restart below.
getent group moniai >/dev/null || groupadd --system moniai
usermod -aG moniai moniadmin
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
