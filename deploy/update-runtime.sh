#!/usr/bin/env bash
#
# Pull the agent runtime and put the new code into the venv the agents actually
# run from.
#
#   sudo bash /opt/moni-ai-os/deploy/update-runtime.sh
#
# The step that is easy to miss: the runtime is pip-installed into the venv as a
# *copy*, not as an editable install, so `git pull` alone changes nothing that
# is running. The agents keep executing the old code out of site-packages, the
# unit restarts cleanly, the logs look healthy, and the change simply is not
# there. Reinstalling is what makes a pull take effect.
#
# Restarting every agent is part of this rather than left to the operator, for
# the same reason: an agent that is still up is still running the old code.
#
# Options:
#   --only <agent-slug>   restart only moni-agent@<agent-slug> (if it is running);
#                         the others keep the old code until their next restart
#   --no-restart          restart nothing; every agent picks the new code up at
#                         its next restart (e.g. a channel save in the panel)
# Without either, every running agent is restarted, as before.

set -euo pipefail

ONLY=""
RESTART=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      [[ $# -ge 2 ]] || { echo "--only needs an agent's short name" >&2; exit 2; }
      ONLY="$2"; shift 2 ;;
    --only=*) ONLY="${1#--only=}"; shift ;;
    --no-restart) RESTART=0; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//;/^set -euo/d'; exit 0 ;;
    *) echo "unknown option: $1 (use --only <agent-slug> or --no-restart)" >&2; exit 2 ;;
  esac
done
if [[ -n "$ONLY" && ! "$ONLY" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then
  echo "not an agent's short name: $ONLY" >&2; exit 2
fi
if [[ -n "$ONLY" && $RESTART -eq 0 ]]; then
  echo "--only and --no-restart do not go together" >&2; exit 2
fi

RUNTIME=${MONI_RUNTIME:-/opt/moni-agents/runtime}
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }
[[ -x "$RUNTIME/venv/bin/pip" ]] || { echo "no runtime venv at $RUNTIME" >&2; exit 1; }

say "Fetching the runtime"
before="$(git -C "$RUNTIME" rev-parse --short HEAD)"
# Local edits made while debugging would block the pull. Say so rather than
# discarding them: the working tree of a deployed runtime is not scratch space.
if ! git -C "$RUNTIME" diff --quiet; then
  echo "The runtime checkout has uncommitted changes. Commit or discard them first:" >&2
  git -C "$RUNTIME" status --short >&2
  exit 1
fi
git -C "$RUNTIME" pull --ff-only
after="$(git -C "$RUNTIME" rev-parse --short HEAD)"
echo "  $before -> $after"

say "Installing it into the venv the agents run from"
"$RUNTIME/venv/bin/pip" install --quiet --no-deps "$RUNTIME"
if [[ -d "$REPO_DIR/memory" ]]; then
  "$RUNTIME/venv/bin/pip" install --quiet --no-deps "$REPO_DIR/memory"
fi

say "Checking it imports"
(cd /tmp && "$RUNTIME/venv/bin/python" -c "import src.main")

if [[ $RESTART -eq 0 ]]; then
  say "Not restarting any agent (--no-restart): each runs the new code from its next restart."
  say "Done."
  exit 0
fi

if [[ -n "$ONLY" ]]; then
  unit="moni-agent@$ONLY.service"
  say "Restarting $unit only"
  if [[ "$(systemctl is-active "$unit" || true)" == "active" ]]; then
    systemctl restart "$unit"
    printf '  %-32s %s\n' "$unit" "$(systemctl is-active "$unit" || true)"
  else
    echo "  $unit is not running; nothing restarted"
  fi
  say "Done."
  exit 0
fi

say "Restarting agents"
# Only the ones that were running. list-units also reports units that are
# loaded but deliberately stopped -- a WhatsApp agent has no Telegram token, so
# its moni-agent@ unit is disabled on purpose, and restarting it every deploy
# started something that could only fail and then left it in a failed state.
mapfile -t units < <(
  systemctl list-units --plain --no-legend --state=active 'moni-agent@*' | awk '{print $1}'
)
if [[ ${#units[@]} -eq 0 ]]; then
  echo "  none running"
else
  for unit in "${units[@]}"; do
    systemctl restart "$unit"
    printf '  %-32s %s\n' "$unit" "$(systemctl is-active "$unit")"
  done
fi

say "Done."
