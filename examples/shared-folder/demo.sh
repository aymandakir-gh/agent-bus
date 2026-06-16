#!/usr/bin/env bash
# Automated end-to-end demo: a lead posts tasks, several workers race to drain
# them over one shared folder, then we verify the invariants from the raw log.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ ! -f "$ROOT/dist/cli.js" ]; then
  echo "Build first:  pnpm install && pnpm build" >&2
  exit 1
fi
ab() { node "$ROOT/dist/cli.js" "$@"; }

DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
echo "shared bus folder: $DIR"
echo

# The lead posts a batch of tasks.
ab --dir "$DIR" init >/dev/null
N="${1:-8}"
for i in $(seq 1 "$N"); do
  ab --dir "$DIR" create-task --title "Task #$i" --agent lead >/dev/null
done
echo "lead posted $N tasks"
echo

# Three workers, each a plain shell loop, race to drain the board.
for w in 1 2 3; do
  bash "$ROOT/examples/shared-folder/worker.sh" "$DIR" "worker-$w" &
done
wait
echo

echo "final board:"
ab --dir "$DIR" tasks
echo

# Prove the guarantees straight from the append-only log.
node -e '
const fs = require("fs");
const dir = process.argv[1];
const msgs = fs.readFileSync(dir + "/log.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const seqs = msgs.map((m) => m.seq);
const gapless = seqs.every((s, i) => s === i + 1);
const claims = msgs.filter((m) => m.type === "task.claimed");
const counts = {};
for (const c of claims) counts[c.taskId] = (counts[c.taskId] || 0) + 1;
const doubles = Object.entries(counts).filter(([, n]) => n > 1);
const completed = msgs.filter((m) => m.type === "task.completed").length;
const claimers = new Set(claims.map((c) => c.agent));
console.log("messages:            " + msgs.length);
console.log("seq gapless+ordered: " + gapless);
console.log("double-claims:       " + (doubles.length === 0 ? "none ✓" : JSON.stringify(doubles)));
console.log("tasks completed:     " + completed + "/" + claims.length + " claimed");
console.log("workers that helped: " + [...claimers].sort().join(", "));
' "$DIR"
