# Contributing to agent-bus

Thanks for your interest. agent-bus is **spec-driven**: the protocol is the
product, so changes start from the contract and are backed by tests.

## Setup

```bash
pnpm install
pnpm build           # bundle (dual ESM/CJS) + types + CLI bin + server subpath
pnpm test            # vitest: conformance (both transports) + scaled simulation
pnpm test:coverage   # the same, with the src/core coverage gate (line ≥90 / branch ≥80)
pnpm typecheck       # tsc --noEmit
pnpm lint            # eslint
```

Node ≥ 20, pnpm 9. The simulations spawn real child processes via `tsx`. The
Python client has its own suite:

```bash
pnpm build && pip install -r clients/python/requirements-dev.txt
python -m pytest clients/python   # validates the TS server against the schemas
```

## The rules of the road

1. **The JSON Schema is the contract.** It is authored once in
   `src/core/schemas.ts`. After changing it, run `pnpm gen:schemas` to update
   `schemas/*.json` and the embedded blocks in `PROTOCOL.md`. The schema test
   fails on any drift between source, `schemas/`, and the doc.
2. **Every feature = an acceptance criterion + a test.** Add the criterion to
   `PRD.md` (M-numbered) and a test that covers it. See `test/` for the shape.
3. **A transport is defined by the conformance suite.** Any transport (file,
   HTTP, a future one) must pass `test/conformance/` — the one shared suite. New
   transport behaviour goes there so the transports can't drift.
4. **Never claim correctness without running the simulation.** Concurrency is a
   first-class requirement — if you touch the lock, the FSM, or the write path,
   `pnpm test test/concurrency.scale.sim.test.ts test/lock.test.ts` must stay
   green. The simulation is *falsifiable* — it fails on a broken lock — so keep
   that test honest.
5. **The bus owns its data directory.** Never read or write outside the bus dir.
   Keep the lock invariant: a lock is stolen only on provable holder death.
6. **Validate the built artifact**, not just the test bundle — `node dist/cli.js`
   behaves differently from the vitest/esbuild path (e.g. ESM deep imports).

## Layout

```
src/core/        types, schemas, validation (ajv), FSM, lock, FileBus, BusTransport
src/http/        Fastify server + fetch-only HttpBusClient over the core
src/cli/         the CLI (node:util.parseArgs)
src/scripts/     gen-schemas (artifacts) + bundle-schemas (release bundle)
test/conformance/ the shared transport suite (file + HTTP)
test/            FSM, file-bus, lock, HTTP, CLI, scaled concurrency simulation
clients/python/  Python reference client + cross-language conformance tests
schemas/         generated JSON Schemas + index.json manifest (the contract)
demo/            a VHS tape of the headline flow
```

The reference implementation validates with the *same* JSON Schema it publishes,
so the implementation can't drift from the spec.

## Proposing a protocol change

`agent-bus/0` evolves **additively only** (new optional fields, new message
types). Anything that would reject a currently-valid message is breaking and
belongs in a future `agent-bus/1`.

For a change:
1. Open an issue describing the message type / field and the use case.
2. Update `src/core/schemas.ts` and the TS types in `src/core/types.ts`.
3. Update the FSM in `src/core/fsm.ts` if it's a lifecycle message.
4. `pnpm gen:schemas`, add fixtures/tests, update `PROTOCOL.md` prose.
5. Note the change in `CHANGELOG.md`.

## Commits & PRs

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`,
  `docs:`, `test:`, `chore:`, `refactor:`.
- Keep PRs focused; green CI (typecheck, lint, test, build) is required.

## License

By contributing you agree your contributions are licensed under the
[MIT License](./LICENSE).
