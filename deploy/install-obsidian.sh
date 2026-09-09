#!/usr/bin/env bash
#
# Install Obsidian on the VPS desktop and register every agent vault in it.
#
#   sudo bash /opt/moni-ai-os/deploy/install-obsidian.sh          # install + register
#   sudo bash /opt/moni-ai-os/deploy/install-obsidian.sh --refresh # register only
#
# Re-run the refresh after creating agents so the new vaults appear in
# Obsidian's vault switcher. Reach the desktop over an SSH tunnel to RDP:
#
#   ssh -N -L 13389:127.0.0.1:3389 ubuntu@<host>
#   then point Remote Desktop at 127.0.0.1:13389

set -euo pipefail

DESKTOP_USER="${DESKTOP_USER:-ubuntu}"
AGENT_USER=moniagent
AGENTS_DIR=/opt/moni-agents/agents
REFRESH_ONLY=0
[[ "${1:-}" == "--refresh" ]] && REFRESH_ONLY=1

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }
id "$DESKTOP_USER" >/dev/null 2>&1 || { echo "no such user: $DESKTOP_USER" >&2; exit 1; }

# ---------------------------------------------------------------- install ---

if [[ $REFRESH_ONLY -eq 0 ]]; then
  if command -v obsidian >/dev/null; then
    say "Obsidian is already installed ($(obsidian --version 2>/dev/null || echo 'version unknown'))"
  else
    say "Finding the latest Obsidian release"
    URL=$(curl -fsSL https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest \
      | grep -o 'https://[^"]*amd64\.deb' | head -1)
    [[ -n "$URL" ]] || { echo "could not find a .deb asset" >&2; exit 1; }

    say "Downloading $(basename "$URL")"
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    curl -fsSL "$URL" -o "$TMP/obsidian.deb"

    say "Installing"
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq "$TMP/obsidian.deb" >/dev/null
  fi
fi

# ------------------------------------------------------------- permissions --

# The desktop user has to be able to open and edit the vaults, which are owned
# by the agent account. Group membership plus the group-writable mode the
# helper sets is what makes that work.
if ! id -nG "$DESKTOP_USER" | tr ' ' '\n' | grep -qx "$AGENT_USER"; then
  say "Adding $DESKTOP_USER to the $AGENT_USER group"
  usermod -aG "$AGENT_USER" "$DESKTOP_USER"
  warn "$DESKTOP_USER must log out and back in (or reboot) for this to take effect."
fi
# Traverse permission on the agents directory for group members.
chmod 0750 "$AGENTS_DIR" 2>/dev/null || true

# ---------------------------------------------------------------- register --

say "Registering agent vaults with Obsidian"
HOME_DIR=$(getent passwd "$DESKTOP_USER" | cut -d: -f6)
CONF_DIR="$HOME_DIR/.config/obsidian"
mkdir -p "$CONF_DIR"

# Obsidian keeps its vault list in obsidian.json, keyed by an arbitrary id. We
# derive the id from the path so re-running does not create duplicate entries.
python3 - "$CONF_DIR/obsidian.json" "$AGENTS_DIR" <<'PY'
import hashlib, json, os, sys, time

conf_path, agents_dir = sys.argv[1], sys.argv[2]

try:
    with open(conf_path) as fh:
        conf = json.load(fh)
except Exception:
    conf = {}
vaults = conf.get("vaults", {})

found = 0
for slug in sorted(os.listdir(agents_dir)) if os.path.isdir(agents_dir) else []:
    vault = os.path.join(agents_dir, slug, "vault")
    if not os.path.isdir(vault):
        continue
    vid = hashlib.sha1(vault.encode()).hexdigest()[:16]
    entry = vaults.get(vid, {})
    entry.update({"path": vault, "ts": int(time.time() * 1000)})
    vaults[vid] = entry
    found += 1

conf["vaults"] = vaults
with open(conf_path, "w") as fh:
    json.dump(conf, fh, indent=2)
print("registered %d vault(s)" % found)
PY

chown -R "$DESKTOP_USER:$DESKTOP_USER" "$CONF_DIR"

say "Done."
echo
echo "  Open Obsidian on the desktop; every agent vault is in the vault switcher."
echo "  To see all agents' memory in one graph, open $AGENTS_DIR as a vault instead."
echo "  Re-run with --refresh after creating new agents."
