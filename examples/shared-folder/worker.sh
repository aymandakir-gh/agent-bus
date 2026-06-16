#!/usr/bin/env bash
# A worker agent as a plain shell loop: claim an open task, complete it, repeat.
# Demonstrates that any process — not just the TS library — can join a bus.
#
# Usage: worker.sh <bus-dir> <agent-id>
set -euo pipefail

DIR="${1:?usage: worker.sh <bus-dir> <agent-id>}"
AGENT="${2:?usage: worker.sh <bus-dir> <agent-id>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Resolve the CLI: prefer the local build, fall back to an installed binary.
if [ -f "$ROOT/dist/cli.js" ]; then
  ab() { node "$ROOT/dist/cli.js" "$@"; }
else
  ab() { npx --yes agent-bus "$@"; }
fi

while true; do
  # Id of the first open task (JSON parsed by node, so no jq dependency).
  TASK="$(ab --dir "$DIR" tasks --state open --json \
    | node -e 'const fs=require("fs");const t=JSON.parse(fs.readFileSync(0,"utf8")||"[]");process.stdout.write((t[0]&&t[0].id)||"")')"

  if [ -z "$TASK" ]; then
    echo "[$AGENT] no open tasks — exiting"
    break
  fi

  # claim exits 0 if we won the race, 1 if another worker beat us to it.
  if ab --dir "$DIR" claim "$TASK" --agent "$AGENT" >/dev/null 2>&1; then
    echo "[$AGENT] claimed   $TASK"
    sleep 0.2 # pretend to do the work
    ab --dir "$DIR" complete "$TASK" --agent "$AGENT" >/dev/null
    echo "[$AGENT] completed $TASK"
  fi
done
