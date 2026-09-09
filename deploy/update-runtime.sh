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

set -euo pipefail

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

say "Restarting agents"
mapfile -t units < <(systemctl list-units --plain --no-legend 'moni-agent@*' | awk '{print $1}')
if [[ ${#units[@]} -eq 0 ]]; then
  echo "  none running"
else
  for unit in "${units[@]}"; do
    systemctl restart "$unit"
    printf '  %-32s %s\n' "$unit" "$(systemctl is-active "$unit")"
  done
fi

say "Done."
