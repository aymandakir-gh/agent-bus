# STATUS

Living build log for `agent-bus`. Newest first. Kept current as milestones land.

## 2026-06-16 — Road to v1.0.0

Picking up the shipped v0.1.0 to drive it to a stable **v1.0.0**. Plan (one
release tag per milestone; full plan in `PRD.md` → "The road to v1.0.0"):

- **v0.2.0 (M5)** — `BusTransport` interface + a transport-neutral conformance
  suite (≥40 cases); file **and** HTTP transports pass the *same* suite.
- **v0.3.0 (M6)** — incremental tail reads; concurrency sim scaled to ≥8
  processes / ≥1000 tasks / ≥3 seeds in CI; a falsifiable broken-lock variant.
- **v0.4.0 (M7)** — a Python reference client validated against the published
  schemas, proven against the HTTP transport in CI.
- **v0.5.0 (M8)** — versioned bundled schema artifact + `PROTOCOL.md` version
  field & compatibility section.
- **v0.6.0 (M9)** — CLI complete + two-terminal quickstart + vhs demo tape.
- **v1.0.0 (M10)** — coverage gates (core line ≥90% / branch ≥80%), ≥130 tests,
  multi-agent adversarial review, every finding fixed + regression-tested.

Baseline at kickoff: 86 tests green; `src/core` coverage 94.45% line / 82.87%
branch (already over the v1.0.0 gate — added `@vitest/coverage-v8`). CI green on
Node 20 & 22. gh authed; npm pack clean (52.8 kB, 24 files). `vhs` not installed
locally (the deliverable is the `.tape` script; CI does not render it).

### M5 — transport conformance → v0.2.0 (done ✅)

- **`BusTransport`** (`src/core/transport.ts`) is now the contract; the shared
  option/result types (`ClaimResult`, `MessageFilter`, …) moved here so the
  contract owns its vocabulary. `FileBus implements BusTransport`.
- **`HttpBusClient`** (`src/http/client.ts`) — a fetch-only client that
  reconstructs the core's typed errors from HTTP error bodies, so the suite
  behaves identically on both transports. Exported from the package root; the
  server moved behind the `agent-bus/server` subpath (no Fastify in core entry).
- **Conformance suite** (`test/conformance/suite.ts`, 46 cases) runs against the
  file transport (direct) and the HTTP transport (`HttpBusClient` over a live
  Fastify server) from the *same* source — 92 cases, both green. Exceeds the
  ≥40 requirement.
- **Real bug caught by the suite:** HTTP `close()` hung on open SSE streams
  (graceful shutdown waits for never-ending event streams). Fixed by tracking
  SSE responses + destroying them on `onClose` and `forceCloseConnections`;
  added a focused regression test. Cut the HTTP suite from ~35s (hanging) to
  ~1.2s.
- **178 tests green** (86 → 178). Decision: package version (0.2.0…1.0.0) tracks
  releases; protocol spec version stays `0.1.0` until the protocol doc changes
  (M8) and is declared stable `1.0.0` at M10 — the two are deliberately distinct.

### M6 — concurrency at scale + falsifiable lock → v0.3.0 (done ✅)

- **Incremental tail reads.** `FileBus` now keeps a byte cursor and folds only
  newly-appended bytes into cached state (`refreshState`/`applyLines`), with
  refreshes serialized so concurrent reads on one instance never double-apply a
  delta. O(n)-per-op → O(new bytes). This was the enabler for scale: an
  8-process / 1000-task run went from a crawl to **~1.7s**. The behaviour matches
  what PROTOCOL.md §7/§9 already described as normative.
- **Scaled sim** (`test/concurrency.scale.sim.test.ts`): 8 OS processes / 1000
  tasks / 3 seeds (101/202/303), each asserting zero double-claims, gapless
  unique `seq`, and all tasks `done` by their claimer. ~4s/seed locally.
- **Falsifiable lock.** Added a `lockAcquirer` DI seam (advanced/test only;
  prod default unchanged) + a test-only no-op `brokenLockAcquirer`. The same sim
  on the broken lock reliably violates G1/G2 (10–15 violations/run) — proven
  in-process (deterministic double-claim) and multi-process. `findInvariantViolations`
  is the shared checker both directions use.
- **Coverage gate** wired into CI (`pnpm test:coverage`): `src/core` 97.7% line /
  86.5% branch — over the 90/80 v1.0.0 gate. **189 tests green.**

### M7 — Python reference client → v0.4.0 (done ✅)

- **`clients/python/agentbus/`** — a stdlib-only Python client (urllib + json) for
  the HTTP transport: full lifecycle + filters + SSE `subscribe`, reason codes via
  a typed `AgentBusError`. No third-party runtime deps.
- **`clients/python/tests/test_conformance.py`** (12 tests, pytest) spawns the
  *built* TS server (`node dist/cli.js serve --port 0`), drives it through the
  Python client, and validates every returned message + task view against the
  **published** `schemas/*.json` via `jsonschema` (Draft 2020-12). Proves no
  TS↔schema drift across languages; includes a 10-thread single-claimer race.
- **New CI job `python-client`** builds the package and runs the pytest suite on
  every push (Node 22 + Python 3.12). 12 Python tests green locally against the
  built server.

### M8 — versioned contract artifact → v0.5.0 (done ✅)

- **`schemas/index.json`** — a versioned manifest (`protocol`, `version`,
  `schemas[]`) generated by `gen:schemas` and drift-tested. `version` is the
  protocol **spec version** (0.1.0), deliberately distinct from the package
  version — cross-language consumers pin to the protocol.
- **`pnpm schemas:bundle`** → `dist/agent-bus-schemas-<version>.json` (manifest +
  all schemas inlined) — the single-download release artifact. In code:
  `schemaManifest`, `buildSchemaBundle()`.
- **PROTOCOL.md §8** rewritten: a 3-identifier version table (protocol id / spec
  version / package version), the versioned-artifact section, and explicit
  forward/backward compatibility rules. **192 tests green.**
- Release step: attach `dist/agent-bus-schemas-<version>.json` to each GitHub
  release alongside the npm tarball and the individual schema files.

### M9 — CLI, docs, demo → v0.6.0 (done ✅)

- **CLI completeness** confirmed: `serve | post | tasks | watch` (+ init,
  create-task, claim/complete/block/release/cancel, messages) all present and
  exercised by `test/cli.test.ts`.
- **vhs demo tape** `demo/agent-bus.tape` (+ `demo/README.md`): a single-pane
  screencast of the headline flow (init → post → race → board green → log). Every
  command in the tape was run and verified; the render needs `vhs` (not in CI).
- **Two-terminal quickstart** lives in `examples/shared-folder/` (verified
  end-to-end via `demo.sh`: 8 tasks / 3 workers / zero double-claims).
- **GitHub templates** added (issue: bug + feature/protocol; PR checklist).
- **README + CONTRIBUTING** refreshed to reflect `HttpBusClient`, the Python
  client, the conformance suite, the scaled/falsifiable sim, and the schema
  manifest. **192 tests green; docs-only changes.**

### M10 — adversarial review + v1.0.0 (done ✅)

- **Protocol declared stable:** `SPEC_VERSION` 0.1.0 → **1.0.0**; PROTOCOL.md
  status draft → **stable**; manifest/bundle/`/health` follow. Wire format
  unchanged (`agent-bus/0`); the §8 additive-only contract now formally holds.
- **Multi-agent adversarial review** (workflow, 17 agents: 8 finder dimensions →
  adversarial verify each). 9 candidates → **6 confirmed real**, all fixed with
  regression tests:
  1. *(high)* `classifyTransition` had no default → a corrupt/unknown-type log
     line crashed every read. Now ignored (forward-compatible) + skipped on read.
  2–3. *(high)* HTTP SSE wasn't at-least-once: a throwing handler / dropped
     stream silently lost messages. Client now **reconnects from the cursor**
     (redelivery), with a give-up cap on persistent failures. New **conformance**
     case asserts redelivery-on-throw for both transports.
  4. *(med)* CLI `--state` / `--type` filters silently accepted garbage → now
     rejected with a clear error.
  5. *(med)* Python fixture proceeded with a dead server → now fails loudly.
  - 1 *uncertain* (unbounded read buffer) scoped out: bus owns its dir (trust
    boundary), HTTP bodies are capped, `result` is intentionally unbounded.
- **Final gate:** 197 TS tests + 12 Python tests green; `src/core` 97.6% line /
  86.7% branch (gate 90/80); CI green (Node 20 & 22 + python-client). `npm pack`
  clean. **Total ≥130-test requirement met with margin (197).**

### ⚠️ npm publish — one manual step (account 2FA), for v1.0.0

The package is publish-ready (`npm publish --dry-run` clean). Publishing needs a
2FA OTP and cannot run unattended. From the repo root, after `pnpm build`:

```bash
npm publish --access public --otp=<6-digit-code>
```

(or use a granular automation token with "bypass 2FA"). The GitHub release carries
the npm tarball + the versioned schema bundle as a fallback distribution.

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
- **M4** Launch (README, demo, CONTRIBUTING, release) — **done** ✅ except npm
  publish, which is blocked by account 2FA and needs one manual command (below).

### Release (2026-06-16)

- Tagged `v0.1.0` (+ milestone tags `m1`/`m2`/`m3`) and pushed.
- **GitHub release v0.1.0 is live**: https://github.com/aymandakir-gh/agent-bus/releases/tag/v0.1.0
  with the npm tarball and all three JSON Schemas attached.
- CI green on Node 20 & 22 for the release commit.

### ⚠️ npm publish — pending one manual step (account 2FA)

`npm publish` returned `E403`: the npm account `aymandakirgh` requires
two-factor authentication (an OTP) or a granular token with "bypass 2FA" to
publish. That cannot be done unattended. The package is fully publish-ready
(`npm publish --dry-run` is clean; 52.8 kB, 24 files, no secrets, maps excluded).

To finish so `npx agent-bus` works, run **one** of:

```bash
# from the repo root, with your authenticator handy:
npm publish --access public --otp=<6-digit-code>
```

or create a granular automation token (npmjs.com → Access Tokens → Granular,
with "bypass 2FA") and publish with it. Nothing else is required — the GitHub
release already carries the tarball + schemas as a fallback distribution.

### Pre-release adversarial review (2026-06-16)

Ran a multi-agent review (28 agents: 4 dimensions × find → adversarial verify):
concurrency, protocol/contract consistency, impl correctness, release readiness.
17 findings confirmed; all addressed:

- **Concurrency (root cause, high):** the lock could be stolen from a *live but
  slow* same-host holder on wall-clock age, and `post()` never re-checked
  ownership before appending → a theoretical duplicate-`seq`/double-claim window
  (also the source of the idempotency-across-steal and release-TOCTOU findings).
  **Fix:** same-host stealing now gates on process liveness only (`kill(pid,0)`)
  — a live holder is never stolen; age is used only cross-host (unknowable
  liveness) or for a garbage lock file. Added `LockHandle.isOwned()` and a
  `post()` retry loop that re-verifies continuous ownership immediately before
  the append, discarding+retrying a stolen critical section. (Closes #1–#5.)
- **Subscriptions (high):** the cursor advanced *before* the handler ran, so a
  throwing handler dropped a message. **Fix:** advance after success → true
  at-least-once. SSE writer now handles backpressure + write errors and closes
  cleanly. (#9, #10)
- **Input validation:** NaN from bad numeric query params / CLI flags silently
  misbehaved. **Fix:** HTTP returns 400; CLI fails with a clear message. (#11,#12)
- **Ergonomics/docs/packaging:** `--id` idempotency flag on the CLI; clean JSON
  errors; §3 table + reason-code subsection in PROTOCOL.md; task-schema tags
  constraints; source maps excluded from the npm tarball (109→53 kB) and
  docs/examples included so README links resolve in-package. (#6–#8, #13–#17)

86 tests green (added 7). Concurrency re-stress after the lock change: 12 procs /
80 tasks / chaos=6ms → gapless, unique ids, zero double-claims, all done.

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
