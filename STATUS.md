# STATUS

Living build log for `agent-bus`. Newest first. Kept current as milestones land.

## 2026-06-16

- **Bootstrap.** Repo initialized. Environment: Node 24, pnpm 9.15, gh authed as
  `aymandakir-gh`.
- **Decision — project lives in `agent-bus/` subfolder.** The invocation CWD was
  `$HOME` (not empty). To avoid polluting the home directory, the project is a
  dedicated folder with its own git repo. The bus only ever writes inside its own
  data directory.
- **Decision — protocol id `agent-bus/0`, spec `0.1.0`.** Eight message types,
  five-state task FSM. See `PROTOCOL.md`.
- **Decision — claims are valid only from `open`.** Claimed/blocked tasks are
  owned; the owner must `task.released` before anyone else can claim. Keeps the
  single-claimer guarantee crisp.
- **Decision — global exclusive write lock via `O_EXCL` file create.** All
  appends read-the-tail + validate + append under one bus-wide lock, giving
  gapless `seq` (total order) and single-winner claims. Stale-lock recovery via
  pid liveness + staleness deadline.
- **Decision (refined) — JSON Schema is the single source of truth.** Rather
  than zod + a generated/mirrored JSON Schema (two artifacts that can drift), the
  contract is authored once as JSON Schema objects in `src/core/schemas.ts`. The
  reference bus validates with `ajv` against those exact objects — it *dogfoods
  the published contract*. `gen:schemas` emits `schemas/*.json` and injects the
  blocks into `PROTOCOL.md`; the schema test asserts no drift. **zod dropped**;
  runtime deps are `ajv` + `ajv-formats` + `fastify`.
- **Decision — zero-dep CLI** via `node:util.parseArgs` (M3).

### Milestone status

- **M1** Spec + core model + file transport + schema tests + CI green — **done** ✅
- **M2** Concurrency-safe claim + multi-agent simulation — _next_
- **M3** HTTP transport + CLI — _not started_
- **M4** Launch (README, demo, CONTRIBUTING, release) — _not started_

### M1 results (2026-06-16)

- 8 message types + input variant + task view as JSON Schema (draft 2020-12),
  published to `schemas/` and embedded in `PROTOCOL.md`.
- Task FSM (`classifyTransition` oracle + pure `reduce`).
- Atomic file lock (`O_EXCL` create + stale recovery).
- `FileBus`: post/claim/complete/block/release/cancel, derived task views,
  filtered reads, polling subscriptions, idempotency, partial-line repair.
- 54 tests green (schema conformance + drift, FSM, file-bus). Typecheck, lint,
  build all green locally; scaffold CI run passed on Node 20 & 22.

### Open decision — npm publish

`npx agent-bus` is a launch goal. GitHub repo/releases are clearly in scope and
will be executed. npm publish is the one irreversible public action; it will be
done as the final, fully-verified M4 step (name permitting), with `npm pack`
inspected first. Recorded here for review.

### Next

1. M2: lock tests, in-process burst-claim race, multi-process simulation.
2. M3: HTTP transport + full CLI.
3. M4: README + two-terminal demo + CONTRIBUTING + release.
