# agent-bus

**A message bus + task board for teams of agents — over nothing but a shared folder.**

[![CI](https://github.com/aymandakir-gh/agent-bus/actions/workflows/ci.yml/badge.svg)](https://github.com/aymandakir-gh/agent-bus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![protocol: agent-bus/0](https://img.shields.io/badge/protocol-agent--bus%2F0-6f42c1.svg)](./PROTOCOL.md)

Everyone building with more than one agent re-invents the same plumbing: how do
agents hand work to each other, **claim it without stepping on each other**,
report progress, and ask for help? People reach for a queue, a Postgres table, a
Redis list, or a Slack channel scraped by a bot — bespoke every time, and none of
it interoperates.

`agent-bus` is a small, open **protocol** for that, plus a TypeScript reference
implementation. The default transport is a **directory**. No server, no database,
no daemon. Two agents — or twenty — coordinate by reading and appending one
folder. There's also a thin local HTTP server that speaks the same protocol.

The protocol is the product: the [JSON Schemas](./schemas) are the contract, so a
Python script, an [n8n](https://n8n.io) flow, or a Claude Code session can all
talk to the same bus.

```
shared/                      a bus is just a folder
├─ log.jsonl                 append-only, totally-ordered message log
├─ meta.json                 { protocol, version, created }
└─ lock                      held only during an append (atomic claim)
```

---

## Quickstart

```bash
# Terminal 1 — the lead: create work, then watch it happen
npx agent-bus --dir ./shared init
npx agent-bus --dir ./shared create-task --title "Write the tests" --agent lead
npx agent-bus --dir ./shared create-task --title "Write the docs"  --agent lead
npx agent-bus --dir ./shared watch
```

```bash
# Terminal 2 — a worker: claim an open task and complete it
npx agent-bus --dir ./shared tasks                 # see what's open
npx agent-bus --dir ./shared claim <taskId> --agent worker-1   # exit 0 = you won the race
npx agent-bus --dir ./shared complete <taskId> --agent worker-1
```

Point both terminals at the **same `--dir`** (or set `AGENT_BUS_DIR`) and they're
coordinating — through nothing but that folder. If two workers claim the same task
at the same instant, exactly one wins; the other gets a clean "not_open" and moves
on. That's the [single-claimer guarantee](#guarantees), and it holds across
separate OS processes.

> No global install needed — `npx agent-bus` runs it. Or `pnpm add agent-bus` to
> use the library.

---

## The shared-folder demo

The hook is two agents coordinating through one folder, with no server in
between. A runnable, scripted version lives in
[`examples/shared-folder/`](./examples/shared-folder):

```bash
git clone https://github.com/aymandakir-gh/agent-bus
cd agent-bus && pnpm install && pnpm build
./examples/shared-folder/demo.sh
```

It spins up a shared folder, a **lead** that posts tasks, and several **workers**
(plain bash loops calling the CLI) that race to claim and complete them — then
prints the board with every task `done` and no double-claims. The folder's
`log.jsonl` is the entire audit trail. See the example's
[README](./examples/shared-folder/README.md) for how to run it live in two real
terminals and how to record it.

---

## Concepts

A **bus** is an append-only, totally-ordered log of **messages**. **Tasks** have
no row of their own — a task's state is *derived* by folding the log. Eight
message types, two groups:

| Lifecycle | drives the task FSM | Communication | informational |
| --- | --- | --- | --- |
| `task.created` | ∅ → `open` | `status.update` | progress / heartbeat |
| `task.claimed` | `open` → `claimed` | `request.help` | ask other agents |
| `task.completed` | → `done` | | |
| `task.blocked` | `claimed` → `blocked` | | |
| `task.released` | → `open` | | |
| `task.cancelled` | → `cancelled` | | |

```
task.created → open ⇄ claimed → done
                 ↑       ↓
              released  blocked        (any non-terminal → cancelled by creator)
```

A claim is legal **only from `open`**, which is what makes single-claimer crisp:
a claimed task is owned until its owner releases it. Full spec, FSM, ordering and
versioning rules: **[PROTOCOL.md](./PROTOCOL.md)**.

---

## Use it as a library

```ts
import { FileBus } from 'agent-bus';

const bus = await FileBus.init('./shared');

await bus.createTask({ title: 'Render the report', agent: 'lead', taskId: 'report' });

const claim = await bus.claim('report', 'worker-1');
if (claim.ok) {
  await bus.complete('report', 'worker-1', { url: 's3://…' });
}

// React to everything happening on the bus, in order, at least once.
const sub = bus.subscribe((msg) => console.log(msg.seq, msg.type, msg.agent), { fromSeq: 0 });
// …later: sub.close();

const open = await bus.getTasks({ state: 'open' });
```

`post()` is the primitive; `claim/complete/block/release/cancel/createTask` are
sugar over it. Reads are lock-free; every write goes through the atomic lock.

## Use it over HTTP

```bash
npx agent-bus --dir ./shared serve --port 7777
```

```bash
curl -s localhost:7777/tasks
curl -s -X POST localhost:7777/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Ship it","agent":"lead","taskId":"ship"}'

# Claiming is the single-claimer point: 201 if you won, 409 if you lost.
curl -s -X POST localhost:7777/tasks/ship/claim -d '{"agent":"worker-1"}' -H 'content-type: application/json'

# Live stream (Server-Sent Events)
curl -N localhost:7777/subscribe
```

The HTTP layer is a thin wrapper over the same core, so it inherits every
guarantee. It binds to `127.0.0.1` by default. From TypeScript, talk to it with
the bundled fetch-only client — same API surface as `FileBus`:

```ts
import { HttpBusClient } from 'agent-bus';

const bus = new HttpBusClient({ baseUrl: 'http://127.0.0.1:7777' });
await bus.createTask({ title: 'Ship it', agent: 'lead', taskId: 'ship' });
const claim = await bus.claim('ship', 'worker-1');   // { ok: true } | { ok: false, reason: 'not_open' }
```

`FileBus` and `HttpBusClient` both implement the same `BusTransport` interface
and are held to the **same conformance suite** ([`test/conformance/`](./test/conformance)),
so they behave identically.

## Use it from another language

The wire format is JSON Lines and the contract is published as JSON Schema
(draft 2020-12) in [`schemas/`](./schemas), discoverable via the versioned
manifest [`schemas/index.json`](./schemas/index.json). A worker in any language
can read `log.jsonl`, fold it into task states ([PROTOCOL.md §5](./PROTOCOL.md)),
validate against the schemas, and append under the directory lock — or just talk
to the HTTP endpoint.

A **Python reference client** ships in [`clients/python/`](./clients/python),
standard-library-only:

```python
from agentbus import AgentBusClient

bus = AgentBusClient("http://127.0.0.1:7777")
bus.create_task(title="Ship it", agent="lead", task_id="ship")
res = bus.claim("ship", "worker-1")          # {"ok": True} | {"ok": False, "reason": "not_open"}
for msg in bus.subscribe(from_seq=0):
    print(msg["seq"], msg["type"]); break
```

Its tests validate the TypeScript server's output against the **published**
schemas in CI — proof the contract is language-agnostic, not TS-only.

---

## Guarantees

- **Total order.** Every message gets a unique, gapless `seq` assigned under an
  exclusive lock. The log reads back identically for everyone.
- **Single claimer.** For any task, at most one `task.claimed` ever moves it out
  of `open`. Concurrent claimers race; exactly one wins.
- **Idempotency.** Re-posting a message `id` is a no-op returning the existing
  record — safe to retry.
- **Append-only.** Nothing is mutated or deleted; the log is an audit trail.

These aren't just asserted — they're **proven by a simulation** that spawns **8
agents in separate OS processes** racing to claim/complete **1000 tasks** over one
file bus, repeated across multiple seeds, checking for zero double-claims, gapless
ordering, and eventual completion (`test/concurrency.scale.sim.test.ts`). And the
proof is **falsifiable**: the same simulation, run against a deliberately broken
lock, fails — so the test isn't vacuous. Both transports additionally pass one
shared [conformance suite](./test/conformance) (46 cases each).

## Privacy

Local-first. The file transport does **no network I/O** and emits **no
telemetry** — your bus is a folder you own. The HTTP transport is `127.0.0.1` by
default.

---

## Project status & layout

Stable: protocol `agent-bus/0`, spec `1.0.0`. Two transports held to one
conformance suite, a second-language client, and the concurrency guarantees
proven at scale.

```
PROTOCOL.md        the contract (message types, FSM, guarantees, versioning §8)
schemas/           canonical JSON Schemas + index.json manifest (the contract)
src/core/          message model, FSM, validation, atomic lock, FileBus, transport
src/http/          Fastify server + fetch-only HttpBusClient over the core
src/cli/           the agent-bus CLI
clients/python/    standard-library Python reference client + conformance tests
test/conformance/  one suite both transports must pass
test/              FSM, file-bus, lock, HTTP, CLI, scaled concurrency simulation
examples/          the shared-folder demo (two terminals, one folder)
demo/              a VHS tape of the headline flow
```

See [STATUS.md](https://github.com/aymandakir-gh/agent-bus/blob/main/STATUS.md)
for the build log and design decisions, and [demo/](./demo) for a recordable
screencast tape.

## Roadmap

Auth & namespaces · log compaction/retention · richer queries & indexes · more
client libraries (a Python client ships today) · an optional networked transport
with the same guarantees · a minimal web dashboard. Ideas and PRs welcome — see
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE).
