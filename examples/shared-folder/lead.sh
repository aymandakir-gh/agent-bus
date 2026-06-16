#!/usr/bin/env bash
# The lead agent: initialize the bus, post some tasks, then tail the bus.
#
# Usage: lead.sh <bus-dir> [count]
set -euo pipefail

DIR="${1:?usage: lead.sh <bus-dir> [count]}"
COUNT="${2:-6}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -f "$ROOT/dist/cli.js" ]; then
  ab() { node "$ROOT/dist/cli.js" "$@"; }
else
  ab() { npx --yes agent-bus "$@"; }
fi

ab --dir "$DIR" init >/dev/null
for i in $(seq 1 "$COUNT"); do
  ab --dir "$DIR" create-task --title "Task #$i" --agent lead >/dev/null
  echo "[lead] posted Task #$i"
done

echo "[lead] posted $COUNT tasks; watching the bus (Ctrl-C to stop)…"
ab --dir "$DIR" watch
