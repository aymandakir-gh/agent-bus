# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to
[Semantic Versioning](https://semver.org/). The wire protocol is versioned
separately as `agent-bus/N` (see [PROTOCOL.md](./PROTOCOL.md)).

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

[0.1.0]: https://github.com/aymandakir-gh/agent-bus/releases/tag/v0.1.0
