# Demo: two agents coordinating through one shared folder

This is the whole pitch in one example: a **lead** posts tasks and several
**workers** race to claim and complete them — talking to nothing but a directory.
The workers are plain `bash` loops calling the `agent-bus` CLI, which is the
point: *any* agent (a shell script, a Python process, a Claude Code session) can
join a bus.

## One-command run

From the repo root:

```bash
pnpm install && pnpm build
./examples/shared-folder/demo.sh
```

You'll see the lead post 8 tasks, three workers drain them concurrently, the
final board with every task `done`, and a check of the invariants straight from
`log.jsonl`:

```
messages: 32
seq gapless+ordered: true
double-claims: none ✓
tasks completed: 8
```

## Run it live in two (or more) terminals

This is the version worth recording. Pick a shared folder and point every
terminal at it.

**Terminal 1 — the lead.** Posts tasks, then tails the bus:

```bash
SHARED=./shared
node dist/cli.js --dir "$SHARED" init
node dist/cli.js --dir "$SHARED" create-task --title "Write the tests" --agent lead
node dist/cli.js --dir "$SHARED" create-task --title "Write the docs"  --agent lead
node dist/cli.js --dir "$SHARED" create-task --title "Cut the release" --agent lead
node dist/cli.js --dir "$SHARED" watch
```

**Terminal 2 — a worker loop.** Claims open tasks and completes them:

```bash
./examples/shared-folder/worker.sh ./shared worker-1
```

**Terminal 3 — another worker.** Start it at the same time to see the race
resolve — each task is claimed by exactly one worker, never both:

```bash
./examples/shared-folder/worker.sh ./shared worker-2
```

Back in Terminal 1, `watch` streams every `task.claimed` / `task.completed` as it
happens. Run `node dist/cli.js --dir ./shared tasks` anywhere to see the board.

> Already installed `agent-bus` globally or via `npx`? Replace `node dist/cli.js`
> with `agent-bus` (or `npx agent-bus`) everywhere above.

## Recording notes

A ready-made [VHS](https://github.com/charmbracelet/vhs) tape of the headline
flow lives in [`demo/agent-bus.tape`](../../demo/agent-bus.tape) — render it with
`vhs demo/agent-bus.tape`. To capture this live multi-worker version instead:

```bash
# install: https://asciinema.org
asciinema rec agent-bus-demo.cast -c './examples/shared-folder/demo.sh'
# or capture the live two-terminal version with a tiled terminal + screen recorder
```

Keep it under ~30s: post tasks on the left, start two workers on the right, let
the board go all-green. The key beat is two workers hitting the same task and
only one winning.

## Files

- `lead.sh <dir> [count]` — initialize the bus, post N tasks, then `watch`.
- `worker.sh <dir> <agent-id>` — claim/complete open tasks until the board is empty.
- `demo.sh` — automated end-to-end run with invariant checks (used above).
