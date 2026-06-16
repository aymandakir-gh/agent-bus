# agent-bus — Product Requirements

> Status: living document · Last updated: 2026-06-16 · Owner: maintainers

## 1. Problem

Everyone building with more than one agent is hand-rolling the same thing:
some way for agents to hand work to each other, claim it without stepping on each
other, report progress, and ask for help. Today that means bespoke queues, ad-hoc
JSON files, a Postgres table, or a Slack channel scraped by a bot. Each is
reinvented per project and none interoperate.

The missing piece is not infrastructure — it's an **open, dead-simple
protocol**. If coordinating a team of agents required nothing but a shared
folder, multi-agent "orgs" would be as easy to stand up as a git repo.

## 2. Vision

> A message bus + task board that any agent — Claude Code, a shell script, an
> n8n flow — can talk to with nothing but a shared folder.

`agent-bus` is a **protocol first**, with a TypeScript **reference
implementation** second. The protocol ([`PROTOCOL.md`](./PROTOCOL.md)) and its
JSON Schemas ([`schemas/`](./schemas)) are the product. The library proves the
protocol works and gives people something to `npx` today.

We are building for the near future where you run *teams* of agents, not one.

## 3. Principles

1. **Protocol is the product.** The JSON Schemas are the contract. The TS
   library is one conformant implementation; other languages can implement the
   same wire format and interoperate.
2. **Zero-infra default.** The file transport needs nothing but a directory. No
   server, no daemon, no database. `git`-like simplicity.
3. **Local-first & private.** No telemetry. No outbound network in the file
   transport. Your bus is your folder.
4. **Correctness is a feature.** Single-claimer and total ordering are
   guaranteed and *proven by a simulation under contention*, not asserted.
5. **Minimal surface.** Eight message types. Five task states. Two transports.
   Small enough to hold in your head.
6. **Spec-driven.** Every feature ships with an acceptance criterion and a test.
   Every message must satisfy the schema suite.

## 4. Users & scenarios

- **The orchestrator.** Splits a job into tasks, posts them, watches them get
  claimed and completed by a fleet of workers.
- **The worker agent.** Polls for `open` tasks, atomically claims one, does the
  work, reports `completed` or `blocked`, asks for help.
- **The human-in-the-loop.** Tails the bus in a terminal (`agent-bus watch`) to
  see what the agents are doing, and posts tasks by hand.
- **The integrator.** Wires a non-TS tool (n8n, a Python script) to the bus via
  the file format or the HTTP endpoint, using the published schemas.

Headline demo: **two terminals coordinating through one shared folder** — no
server in between.

## 5. Scope

### In scope (v0)
- Append-only, totally-ordered message log.
- Eight message types; five-state task FSM (`PROTOCOL.md` §3, §5).
- Single-claimer & total-order guarantees, atomic under concurrent processes.
- File transport (directory + JSONL) and a thin local HTTP transport.
- Published JSON Schemas + a schema-conformance test suite.
- A small CLI: `init`, `post`, `tasks`, `claim`, `complete`, `watch`, `serve`.
- Subscriptions (tail / SSE).

### Out of scope (v0, see roadmap)
- Authentication / authorization, multi-tenant servers.
- Networked/distributed buses across machines (file transport targets a local
  shared dir; correctness over NFS/SMB is best-effort, documented).
- Log compaction / retention policies, archival.
- Rich querying, indexes beyond derived task views.
- Web UI.

## 6. Architecture

- **`src/core`** — pure, server-free, unit-testable: message model, zod schemas,
  FSM reducer + transition validator, id generation, the atomic file lock, and
  the `FileBus` (atomic operations over a directory).
- **`src/http`** — a thin Fastify app exposing the same core over HTTP/SSE.
- **`src/cli`** — a zero-dependency CLI (`node:util.parseArgs`) over the core and
  an HTTP client.
- **`schemas/`** — canonical JSON Schemas, generated from the zod source of
  truth, mirrored into `PROTOCOL.md`, validated with `ajv` in tests.

Stack: TypeScript, Node ≥ 20 (developed on 24), pnpm, Vitest, tsup, ESLint.
Runtime deps kept minimal: `zod` (validation), `fastify` (HTTP).

## 7. Milestones & acceptance criteria

Each criterion maps to at least one test.

### M1 — Spec + core model + file transport + CI green
- [x] `PRD.md` + `PROTOCOL.md` committed first (the spec).
- [ ] zod schemas for all 8 message types; JSON Schemas generated to `schemas/`.
- [ ] **AC-M1.1** Every valid fixture passes both zod and the JSON Schema; every
  invalid fixture fails both. (`test/schema.test.ts`)
- [ ] **AC-M1.2** `schemas/*.json` and the blocks embedded in `PROTOCOL.md` are
  byte-identical (drift guard).
- [ ] **AC-M1.3** FSM reducer folds a log into correct task states; every legal
  transition accepted, every illegal one rejected. (`test/fsm.test.ts`)
- [ ] **AC-M1.4** `FileBus` round-trips: post → read back; `seq` gapless,
  strictly increasing; idempotent re-post. (`test/file-bus.test.ts`)
- [ ] CI (install, typecheck, lint, test) green on `main`.

### M2 — Concurrency-safe claim + multi-agent simulation
- [ ] **AC-M2.1** The file lock provides mutual exclusion; stale locks are
  recovered. (`test/lock.test.ts`)
- [ ] **AC-M2.2** Under a burst of concurrent claims on one task, exactly one
  succeeds. (`test/concurrency.sim.test.ts`)
- [ ] **AC-M2.3** Simulation: N agents in separate OS processes race over M tasks
  on one file bus; assert **no double-claims**, **gapless/ordered `seq`**, and
  **all tasks eventually `done`**. (`test/concurrency.sim.test.ts`)

### M3 — HTTP transport + CLI
- [ ] **AC-M3.1** HTTP endpoints mirror the core; posting/claiming/listing/
  subscribing behave identically; lost claim → `409`. (`test/http.test.ts`)
- [ ] **AC-M3.2** Concurrency guarantees hold over the HTTP path.
- [ ] **AC-M3.3** CLI commands (`init`/`post`/`tasks`/`claim`/`complete`/
  `watch`/`serve`) work end-to-end. (`test/cli.test.ts`)
- [ ] **AC-M3.4** `npx agent-bus` runs.

### M4 — Launch
- [x] README: one-liner, why, the shared-folder demo (with recording notes),
  quickstart, roadmap.
- [x] Two-terminal quickstart that coordinates via one folder (`examples/`).
- [x] `CONTRIBUTING.md`, schema docs, `CHANGELOG.md`.
- [x] Tagged release; schemas published as release artifacts; `npx agent-bus`
  works from the published package. *(npm publish pending account 2FA.)*

---

## The road to v1.0.0

v0.1.0 proved the protocol and the reference implementation. v1.0.0 makes the
**contract** load-bearing across transports and languages, and proves the
correctness claims at scale. Each milestone is its own release tag and must keep
CI green. Decisions are recorded in `STATUS.md`.

### M5 — Transport conformance suite → `v0.2.0`
- The contract is expressed once as a **`BusTransport`** interface (`src/core/transport.ts`).
- A single, transport-neutral **conformance suite** of **≥ 40 cases** any
  transport must pass: envelope/`seq`/`ts`/`id` assignment, idempotency, schema
  conformance of every emitted message, the full task FSM and every rejection
  reason, single-claimer, total order, filters, derived task views, and
  subscriptions.
- **Both** the file transport (direct) and the HTTP transport (over the network,
  via a new `HttpBusClient`) pass the **same** suite. (`test/conformance/`)

### M6 — Concurrency at scale + a falsifiable lock → `v0.3.0`
- **Incremental tail reads** (byte-offset cursor) so the bus is not O(n²) under a
  large log — the enabler for the scaled simulation.
- Simulation scaled to **≥ 8 OS processes over ≥ 1000 tasks**, asserting **zero
  double-claims**, **gapless ordering**, **eventual completion**; run in CI,
  **repeated ≥ 3× with different seeds** (seedable workers).
- A deliberately **broken lock variant** (test-only, never reachable in prod) and
  a test proving the *same* simulation **fails** on it — the invariants are
  falsifiable, not vacuous. Production keeps the lock-steals-only-on-process-death
  invariant.

### M7 — A second-language client → `v0.4.0`
- A minimal **Python reference client** (`clients/python/`) for the HTTP
  transport, **validating against the published JSON Schemas** (no spec/impl
  drift), proven against a live server **in CI**.

### M8 — Versioned contract artifact → `v0.5.0`
- JSON Schemas exported as a **versioned, bundled release artifact** for
  cross-language consumers (`schemas/index.json` manifest + a single bundled
  schema), with a test asserting the manifest version tracks `SPEC_VERSION`.
- `PROTOCOL.md` carries an explicit **version field** and a **compatibility**
  section (what is additive within `agent-bus/0`, what bumps the protocol id).

### M9 — CLI, docs, demo → `v0.6.0`
- CLI complete (`serve | post | tasks | watch`, plus the lifecycle verbs) with a
  documented **two-terminals-one-folder quickstart** and a **vhs demo tape**.
- Launch-grade README / CONTRIBUTING / CHANGELOG / issue & PR templates refreshed.

### M10 — Adversarial review + v1.0.0 → `v1.0.0`
- `src/core` line coverage **≥ 90%** and branch **≥ 80%**, enforced in CI;
  **≥ 130** passing tests, no padding (reviewer-confirmed).
- A **multi-agent adversarial review**; every real finding fixed with a
  regression test. Publish-ready (`npm pack` clean). `npm publish` documented as
  one manual `--otp` command (account 2FA; not run unattended).

## 8. Non-negotiable workflow (how we build this)

1. Spec first — `PRD.md` + `PROTOCOL.md` are the first commit.
2. Spec-driven — the JSON Schemas are the contract; a schema suite validates
   every message; every feature = criterion + test.
3. Self-verify every slice — build → tests → run the multi-agent simulation.
   Never claim correctness without running the sim.
4. Safety — the bus owns its own data directory; never touch paths outside it.
   Concurrency safety (atomic claim) is a first-class, tested requirement.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| File locking is subtly wrong under races | Atomic `O_EXCL` create; stale recovery; in-process **and** multi-process simulations with chaos delays widening the race window. |
| Network filesystems (NFS/SMB) weaken `O_EXCL` atomicity | Documented as best-effort; HTTP transport recommended for shared-host setups. |
| Schema ↔ doc drift | Generated schemas + drift test; single zod source of truth. |
| Reading the whole log per op is O(n) | **Done (v0.3.0):** incremental tail reads keyed by a byte offset — each op parses only newly-appended bytes. Snapshotting/indexing for very large logs remains roadmap. |

## 10. Roadmap (post-v0)

Auth & namespaces · log compaction/retention · richer queries & indexes ·
client libraries in other languages · optional networked transport with the
same guarantees · a minimal web dashboard.
