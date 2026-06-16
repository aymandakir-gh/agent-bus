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
- **Decision — two cross-checked validators.** zod is the runtime source of
  truth in the reference impl; canonical JSON Schemas in `schemas/` are validated
  with `ajv`; a conformance test asserts both accept/reject the same fixtures, and
  a drift test asserts `schemas/` matches the blocks embedded in `PROTOCOL.md`.
- **Decision — zero-dep CLI** via `node:util.parseArgs`; runtime deps limited to
  `zod` + `fastify`.

### Milestone status

- **M1** Spec + core model + file transport + schema tests + CI green — _in progress_
- **M2** Concurrency-safe claim + multi-agent simulation — _not started_
- **M3** HTTP transport + CLI — _not started_
- **M4** Launch (README, demo, CONTRIBUTING, release) — _not started_

### Next

1. First commit: `PRD.md` + `PROTOCOL.md` (+ LICENSE, .gitignore, README stub).
2. Scaffold TS toolchain + CI; get a trivial green build.
3. Create GitHub repo, push, confirm CI green before features.
4. Implement M1: schemas → FSM → FileBus, each with tests.
