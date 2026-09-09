#!/usr/bin/env bash
#
# Provision the MONI agent stack on a fresh VPS. Idempotent: safe to re-run
# after a change, and re-running is how you upgrade the runtime.
#
#   sudo bash /opt/moni-ai-os/deploy/bootstrap.sh
#
# What it does NOT do: give the agents a Claude credential. That is a secret and
# only you should handle it -- the script creates the file and tells you what to
# put in it.

set -euo pipefail

# The runtime repo is private, so this is the SSH remote: the server
# authenticates with a deploy key rather than a password it cannot be given.
# Generate one with
#   ssh-keygen -t ed25519 -f /root/.ssh/github_deploy -N ''
# and add the public half to the repo under Settings -> Deploy keys (read-only).
RUNTIME_REPO="${RUNTIME_REPO:-git@github.com:a-maraghy/Claude_Agents.git}"
RUNTIME_REF="${RUNTIME_REF:-main}"

ROOT=/opt/moni-agents
RUNTIME="$ROOT/runtime"
SHARED="$ROOT/shared"
AGENT_USER=moniagent

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }

# ---------------------------------------------------------------- packages --

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  python3 python3-venv python3-pip git curl ca-certificates rsync sqlite3 \
  >/dev/null

if ! command -v node >/dev/null; then
  say "Installing Node.js 22 (needed by the Claude CLI)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v claude >/dev/null; then
  say "Installing the Claude Code CLI globally"
  npm install -g @anthropic-ai/claude-code >/dev/null
fi
say "Claude CLI: $(command -v claude) $(claude --version 2>/dev/null || echo '(version unknown)')"

# ------------------------------------------------------------------ account --

if ! id "$AGENT_USER" >/dev/null 2>&1; then
  say "Creating the $AGENT_USER service account"
  useradd --system --home-dir "$SHARED/home" --create-home \
          --shell /usr/sbin/nologin "$AGENT_USER"
else
  say "Service account $AGENT_USER already exists"
fi

# ------------------------------------------------------------------ layout --

say "Creating $ROOT"
mkdir -p "$ROOT" "$RUNTIME" "$SHARED/home" "$SHARED/models" \
         "$ROOT/agents" "$ROOT/archived" "$ROOT/workspaces" /opt/projects
chown root:root "$ROOT"
chmod 0755 "$ROOT"
chown -R "$AGENT_USER:$AGENT_USER" "$SHARED" "$ROOT/agents" "$ROOT/workspaces"
chmod 0750 "$ROOT/agents" "$ROOT/archived"

# ----------------------------------------------------------------- runtime --

git config --global --add safe.directory "$RUNTIME" 2>/dev/null || true

if [[ -d "$RUNTIME/.git" ]]; then
  say "Updating the agent runtime"
  # A failed fetch must not abort the run: the checkout on disk is still
  # perfectly serviceable, and the usual cause is a deploy key that has not been
  # added to GitHub yet. Report it and carry on with what is there.
  if git -C "$RUNTIME" fetch --quiet origin 2>/dev/null; then
    git -C "$RUNTIME" checkout --quiet "$RUNTIME_REF" || true
    git -C "$RUNTIME" pull --quiet --ff-only origin "$RUNTIME_REF" || \
      warn "could not fast-forward; leaving the checkout as it is"
  else
    warn "could not reach $RUNTIME_REPO -- using the existing checkout."
    warn "Add /root/.ssh/github_deploy.pub to the repo's Deploy keys to fix this."
  fi
else
  say "Cloning the agent runtime from $RUNTIME_REPO"
  rm -rf "$RUNTIME"
  git clone --quiet --branch "$RUNTIME_REF" "$RUNTIME_REPO" "$RUNTIME"
fi

if [[ ! -x "$RUNTIME/venv/bin/python" ]]; then
  say "Creating the runtime virtualenv"
  python3 -m venv "$RUNTIME/venv"
fi

say "Installing the runtime and the memory package"
"$RUNTIME/venv/bin/pip" install --quiet --upgrade pip wheel
"$RUNTIME/venv/bin/pip" install --quiet "$RUNTIME"
"$RUNTIME/venv/bin/pip" install --quiet "$REPO_DIR/memory"

# ------------------------------------------------------------ vault template --

say "Installing the vault template"
rsync -a --delete "$REPO_DIR/deploy/vault-template/" "$ROOT/vault-template/"
chown -R "$AGENT_USER:$AGENT_USER" "$ROOT/vault-template"

# -------------------------------------------------------------- embeddings --

say "Downloading the embedding model (once, ~130MB)"
# Done as the agent account so the cache is owned by the account that will read
# it; done now so the first memory search does not pay for a download.
runuser -u "$AGENT_USER" -- env \
  MONI_MODEL_CACHE="$SHARED/models" HOME="$SHARED/home" \
  "$RUNTIME/venv/bin/python" -m moni_memory.cli warm || \
  warn "model warm-up failed -- the first search will download it instead"

# ------------------------------------------------------------ claude auth ---

AUTH="$SHARED/claude-auth.env"
if [[ ! -f "$AUTH" ]]; then
  say "Creating $AUTH (empty -- you must fill it in)"
  cat > "$AUTH" <<'EOF'
# Claude credential shared by every agent. Exactly one of these two lines.
#
# Subscription (recommended -- no per-token billing):
#   run `claude setup-token` as a user with a browser, then paste the result:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
#
# Or pay-as-you-go API billing:
# ANTHROPIC_API_KEY=sk-ant-api03-...
EOF
else
  say "Claude credential file already present"
fi
chown "root:$AGENT_USER" "$AUTH"
chmod 0640 "$AUTH"

if ! grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+' "$AUTH"; then
  warn "No Claude credential set yet. Agents will start and then fail to answer."
  warn "Fix: put CLAUDE_CODE_OAUTH_TOKEN=... into $AUTH (see the comments in it)."
fi

# ------------------------------------------------------------ systemd unit --

say "Installing the agent systemd template"
install -m 0644 "$REPO_DIR/dashboard/deploy/moni-agent@.service" \
        /etc/systemd/system/moni-agent@.service
systemctl daemon-reload

# ---------------------------------------------------------------- helper ----

say "Installing the privileged helpers"
install -m 0755 "$REPO_DIR/dashboard/deploy/moni-helper" /usr/local/sbin/moni-helper
python3 -m py_compile /usr/local/sbin/moni-helper
install -m 0755 "$REPO_DIR/dashboard/deploy/moni-root" /usr/local/sbin/moni-root
python3 -m py_compile /usr/local/sbin/moni-root
install -d -m 0700 -o root -g root /var/lib/moni-root
install -m 0440 "$REPO_DIR/dashboard/deploy/moni-sudoers" /etc/sudoers.d/moni-dashboard
visudo -cf /etc/sudoers.d/moni-dashboard >/dev/null

say "Done."
echo
echo "  Agent root:      $ROOT"
echo "  Runtime:         $RUNTIME  ($(git -C "$RUNTIME" rev-parse --short HEAD))"
echo "  Service account: $AGENT_USER"
echo
if ! grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+' "$AUTH"; then
  echo "  NEXT: add a Claude credential to $AUTH, then create an agent in the dashboard."
else
  echo "  NEXT: create an agent in the dashboard."
fi
