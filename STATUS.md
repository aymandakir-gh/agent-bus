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
- **M2** Concurrency-safe claim + multi-agent simulation — **done** ✅
- **M3** HTTP transport + CLI — **done** ✅
- **M4** Launch (README, demo, CONTRIBUTING, release) — _next_

### M3 results (2026-06-16)

- HTTP transport: thin Fastify layer over the same `FileBus`, inheriting all
  guarantees. Routes: health/meta, POST/GET messages, GET tasks(+`:id`),
  POST tasks + `/claim` `/complete` `/block` `/release` `/cancel`, SSE
  `/subscribe`. Errors map by code: validation→400, transition→409 (lost claim),
  not_found→404, lock_timeout→503. Binds 127.0.0.1.
- CLI (`node:util.parseArgs`, zero runtime deps; `serve` lazy-imports Fastify):
  init/create-task/tasks/claim/complete/block/release/cancel/post/messages/
  watch/serve. `claim` exits 0 on win, 1 on lost race.
- Tests: http.test.ts (9) incl. **single-claimer over the network path** (one of
  20 concurrent claim requests → 201, rest 409) and SSE streaming; cli.test.ts
  (6) full lifecycle e2e via spawned processes. 79 tests total.
- **Build gotcha fixed:** ajv deep import needed `ajv/dist/2020.js` (explicit
  extension) to resolve in bundled Node ESM. Caught by smoke-testing the *built*
  `dist/cli.js` — the test bundler had masked it. Verified `node dist/cli.js`
  lifecycle + live `serve` (health 200, POST 201).

### M2 results (2026-06-16)

- Lock tests: mutual exclusion (no lost updates, never two holders), stale
  recovery (dead pid / age / garbage file), timeout, release-on-throw, token
  ownership on release.
- In-process burst: exactly one of 25 concurrent claims wins; rest `not_open`.
- In-process drain: 8 agents over 30 tasks — each claimed once, all completed.
- **Multi-process simulation**: 6 OS processes (`node --import tsx`) racing over
  40 tasks via one folder — gapless/unique `seq`, exactly one claim per task, all
  done, completed-by-claimer. Stable across repeated runs.
- Stress check (one-off): 12 processes, 80 tasks, chaos=6ms → 332 messages,
  gapless, zero double-claims, all done, work spread across all 12 agents, ~1.6s.

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
