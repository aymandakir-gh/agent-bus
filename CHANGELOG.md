# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to
[Semantic Versioning](https://semver.org/). The wire protocol is versioned
separately as `agent-bus/N` (see [PROTOCOL.md](./PROTOCOL.md)).

## [0.3.0] — 2026-06-16

Concurrency at scale, and a falsifiable lock. Wire format unchanged
(`agent-bus/0`, spec `0.1.0`).

### Added
- **Incremental tail reads.** `FileBus` keeps a byte cursor and parses only the
  bytes appended since its last read (folding them into cached state), instead of
  re-reading the whole log every op. Turns an O(n)-per-op read into O(new bytes)
  and makes large logs practical — an 8-process / 1000-task run drops from a
  crawl to ~2s. Matches the normative behaviour already described in PROTOCOL.md
  §7/§9. Concurrent refreshes on one instance are serialized so a delta is never
  applied twice.
- **Scaled concurrency simulation** (`test/concurrency.scale.sim.test.ts`): ≥8 OS
  processes draining ≥1000 tasks over one folder, repeated across 3 seeds,
  asserting zero double-claims, gapless/unique `seq`, and eventual completion.
- **Falsifiable lock.** A test-only injected lock acquirer (`lockAcquirer`
  option) lets the *same* simulation run against a deliberately broken (no-op)
  lock; tests prove it then fails (double-claims, duplicate `seq`) — in-process
  (deterministic) and multi-process. Production always uses the real lock and its
  steal-only-on-process-death invariant.
- **Coverage gate** (`pnpm test:coverage`, enforced in CI): `src/core` line ≥ 90%
  and branch ≥ 80%.

## [0.2.0] — 2026-06-16

Transport conformance. The protocol wire format is unchanged (`agent-bus/0`,
spec `0.1.0`); this release makes the *contract* portable across transports.

### Added
- **`BusTransport` interface** (`src/core/transport.ts`) — the single contract
  any transport implements. `FileBus` now formally `implements BusTransport`.
- **`HttpBusClient`** (`agent-bus` main export) — a fetch-only reference client
  for the HTTP transport that maps HTTP error bodies back into the same typed
  errors the core throws, so callers can't tell which transport raised them.
- **Transport-conformance suite** (`test/conformance/`) — 46 behavioural cases
  any transport must pass (envelope/`seq`/`ts`/`id` assignment, idempotency,
  schema conformance of emitted messages, the full task FSM and every rejection
  reason, single-claimer, total order, filters, derived task views, and
  subscriptions). The **file and HTTP transports run the same suite** (92 cases),
  so they cannot drift.
- **`agent-bus/server` subpath export** so the server can be embedded without
  pulling Fastify into the core entry.

### Fixed
- **HTTP graceful shutdown no longer hangs on open SSE subscriptions.** Found by
  the conformance suite: `close()` waited indefinitely for never-ending event
  streams. The server now tracks open SSE responses and destroys them on
  shutdown (plus `forceCloseConnections`). Regression test in `test/http.test.ts`.

## [0.1.0] — 2026-06-16

First release. Protocol `agent-bus/0`.

### Added
- **Protocol spec** ([PROTOCOL.md](./PROTOCOL.md)): 8 message types, a 5-state
  task FSM, total-order and single-claimer guarantees, the atomic file-lock
  concurrency model, and versioning rules.
- **Canonical JSON Schemas** ([schemas/](./schemas), draft 2020-12) for stored
  messages, post payloads, and the derived task view — the published contract.
- **Core** (`src/core`): message model and types, ajv validation against the
  published schema, the task FSM (`classifyTransition` + `reduce`), an atomic
  file lock (`O_EXCL` create + stale recovery), and `FileBus` — an append-only
  JSONL transport with single-claimer semantics, idempotency, derived task
  views, filtered reads, and polling subscriptions.
- **HTTP transport** (`src/http`): a thin Fastify layer over the core, with REST
  routes, lifecycle endpoints, SSE subscriptions, and a `409` on lost claims.
- **CLI** (`agent-bus`): `init`, `create-task`, `tasks`, `claim`, `complete`,
  `block`, `release`, `cancel`, `post`, `messages`, `watch`, `serve`.
- **Tests**: schema conformance + drift, FSM, file-bus, lock, HTTP, CLI, and a
  multi-process concurrency simulation proving single-claimer & ordering.
- **Example**: the two-terminal shared-folder demo (`examples/shared-folder`).

[0.3.0]: https://github.com/aymandakir-gh/agent-bus/releases/tag/v0.3.0
[0.2.0]: https://github.com/aymandakir-gh/agent-bus/releases/tag/v0.2.0
[0.1.0]: https://github.com/aymandakir-gh/agent-bus/releases/tag/v0.1.0
