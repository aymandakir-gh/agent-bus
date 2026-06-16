<!-- Thanks for contributing to agent-bus! Keep PRs focused. -->

## What & why

<!-- What does this change and why? Link any issue. -->

## Type

- [ ] Protocol/schema change (`PROTOCOL.md` + `schemas/` — run `pnpm gen:schemas`)
- [ ] Reference implementation (core / HTTP / CLI / clients)
- [ ] Docs / tooling / tests only

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass (incl. the conformance
      suite and the concurrency simulation)
- [ ] New behaviour has a test that asserts it (every feature = a test)
- [ ] If a transport gained/changed behaviour, it still passes the **shared
      conformance suite** (`test/conformance/`)
- [ ] Schemas regenerated if changed (`pnpm gen:schemas`; the drift test is green)
- [ ] Protocol changes respect the §8 compatibility rules (additive within
      `agent-bus/0`)
- [ ] `CHANGELOG.md` updated for user-facing changes
- [ ] No telemetry / no network in the file transport; the bus only touches its
      own data directory
