# agent-bus

**A message bus + task board for teams of agents — over nothing but a shared folder.**

Everyone building with more than one agent re-invents the same plumbing: how do
agents hand work to each other, claim it without stepping on each other, report
progress, and ask for help? `agent-bus` is a tiny, open **protocol** for exactly
that — plus a TypeScript reference implementation you can `npx` today.

The default transport is a **directory**. No server, no database, no daemon. Two
agents (or twenty) coordinate by reading and writing one folder.

> Status: pre-1.0, under active construction. The contract lives in
> [`PROTOCOL.md`](./PROTOCOL.md); the plan in [`PRD.md`](./PRD.md); the build log
> in [`STATUS.md`](./STATUS.md). A full README with the two-terminal demo lands
> in milestone M4.

## What it is

- **Append-only, totally-ordered message log.** Eight typed messages
  (`task.created`, `task.claimed`, `task.completed`, `task.blocked`,
  `task.released`, `task.cancelled`, `status.update`, `request.help`).
- **A task board with a five-state lifecycle** (`open → claimed →
  done/blocked`), with a **single-claimer guarantee** that holds under
  concurrent processes.
- **The JSON Schemas are the product** — any language can speak the protocol.
- **Two transports:** a zero-infra file bus, and a thin local HTTP server
  exposing the same protocol.

## Why

Lowering the bar for real multi-agent orgs to "you have a shared folder" is the
point. See [`PRD.md`](./PRD.md) for the full rationale.

## License

[MIT](./LICENSE).
