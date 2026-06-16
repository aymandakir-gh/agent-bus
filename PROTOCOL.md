# Agent Bus Protocol — `agent-bus/0`

> Status: **draft / pre-1.0** · Protocol id: `agent-bus/0` · Spec version: `0.1.0` · Last updated: 2026-06-16

A minimal, language-agnostic protocol for **multi-agent coordination**. It is a
**message bus + task board** that any agent — a Claude Code session, a shell
script, an [n8n](https://n8n.io) flow, a cron job — can talk to with nothing
more than a **shared folder**.

This document is the contract. The TypeScript package in this repo is the
**reference implementation**; the JSON Schemas below are the source of truth.
The canonical schema files live in [`schemas/`](./schemas) and are mirrored,
verbatim, into this document. A test (`test/schema.test.ts`) asserts the two
never drift.

---

## 1. Concepts

| Concept | Definition |
| --- | --- |
| **Bus** | An append-only, totally-ordered log of messages. One bus = one shared location (a directory, or an HTTP endpoint backed by one). |
| **Message** | An immutable, typed record appended to the log. The unit of communication. |
| **Task** | A unit of work tracked by the bus. A task has no row of its own — its state is *derived* by folding the message log (see §5). |
| **Agent** | Any participant that reads from or writes to the bus, identified by a free-form string `agent` id. |
| **Sequence (`seq`)** | A total order over all messages on a bus, assigned by the bus at append time. Strictly increasing, gapless, unique. **`seq` defines ordering — not wall-clock `ts`.** |

The log is the single source of truth. Tasks, subscriptions, and every view are
derived from it by replay. There is no hidden state.

---

## 2. The message envelope

Every message — regardless of type — is a JSON object sharing this envelope:

| Field | Type | Set by | Notes |
| --- | --- | --- | --- |
| `id` | string (1–128) | client *(or bus)* | Unique message id. **Idempotency key**: re-posting an `id` that already exists is a no-op that returns the existing record. If the client omits it, the bus assigns one. |
| `seq` | integer ≥ 1 | **bus** | Total-order position. Assigned under the write lock. Never supplied by clients. |
| `ts` | string (date-time) | **bus** | RFC 3339 / ISO 8601 UTC instant the message was appended. Informational; **not** used for ordering. |
| `type` | enum | client | One of the eight message types in §3. |
| `agent` | string (1–128) | client | Id of the sending agent. |
| `meta` | object | client | Optional free-form extension data. Reserved escape hatch for forward-compatible additions (see §8). |

Plus type-specific fields (§3). The reference bus stores each message as one
line of [JSON Lines](https://jsonlines.org/) (`log.jsonl`), in `seq` order.

### Posting vs. stored records

Clients **post** a partial message: `type`, `agent`, the type-specific fields,
and optionally `id` / `meta`. The bus **assigns** `seq`, `ts`, and `id` (if
absent), then appends the complete **stored record**. The contract in §3
describes the stored record; the post payload is the same object minus the
bus-assigned fields (`message.input.schema.json`).

---

## 3. Message types

Eight types, in two groups: **task lifecycle** (drive the task FSM in §5) and
**communication** (carry information without changing task state).

### Task lifecycle

| Type | Purpose | Required type-specific fields | FSM effect |
| --- | --- | --- | --- |
| `task.created` | Post a new task to the board. | `taskId`, `title` | ∅ → `open` |
| `task.claimed` | Claim an open task. **Single-claimer point** (§6). | `taskId` | `open` → `claimed` |
| `task.completed` | Mark a claimed task done. | `taskId` | `claimed` → `done` |
| `task.blocked` | Signal a claimed task is stuck. | `taskId`, `reason` | `claimed` → `blocked` |
| `task.released` | Give up ownership; return task to the pool. | `taskId` | `claimed`\|`blocked` → `open` |
| `task.cancelled` | Creator withdraws a task. | `taskId` | `open`\|`claimed`\|`blocked` → `cancelled` |

### Communication

| Type | Purpose | Required type-specific fields | FSM effect |
| --- | --- | --- | --- |
| `status.update` | Heartbeat / progress note, optionally about a task. | `text` | none |
| `request.help` | Ask other agents for help, optionally about a task. | `text` | none |

### Per-type fields

- **`task.created`** — `taskId` (string 1–128), `title` (string 1–200),
  `description?` (string ≤ 4000), `priority?` (`low`\|`normal`\|`high`, default
  `normal`), `tags?` (string[] ≤ 16, each ≤ 64).
- **`task.claimed`** — `taskId`, `note?` (string ≤ 2000). The `agent` is the
  claimer.
- **`task.completed`** — `taskId`, `result?` (any JSON value), `note?`.
- **`task.blocked`** — `taskId`, `reason` (string 1–2000), `note?`.
- **`task.released`** — `taskId`, `reason?` (string ≤ 2000).
- **`task.cancelled`** — `taskId`, `reason?` (string ≤ 2000).
- **`status.update`** — `text` (string 1–2000), `taskId?`, `data?` (object).
- **`request.help`** — `text` (string 1–2000), `taskId?`,
  `severity?` (`low`\|`normal`\|`high`\|`urgent`, default `normal`), `data?` (object).

---

## 4. Canonical JSON Schema

Draft 2020-12. This block is generated from [`schemas/message.schema.json`](./schemas/message.schema.json);
do not edit by hand. (`pnpm gen:schemas` regenerates it; the schema test fails on drift.)

<!-- BEGIN schema:message -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/aymandakir-gh/agent-bus/blob/main/schemas/message.schema.json",
  "title": "AgentBusMessage",
  "description": "A single stored message in an agent-bus log (protocol agent-bus/0).",
  "type": "object",
  "allOf": [
    {
      "$ref": "#/$defs/envelope"
    }
  ],
  "oneOf": [
    {
      "$ref": "#/$defs/task_created"
    },
    {
      "$ref": "#/$defs/task_claimed"
    },
    {
      "$ref": "#/$defs/task_completed"
    },
    {
      "$ref": "#/$defs/task_blocked"
    },
    {
      "$ref": "#/$defs/task_released"
    },
    {
      "$ref": "#/$defs/task_cancelled"
    },
    {
      "$ref": "#/$defs/status_update"
    },
    {
      "$ref": "#/$defs/request_help"
    }
  ],
  "unevaluatedProperties": false,
  "$defs": {
    "envelope": {
      "type": "object",
      "required": [
        "id",
        "seq",
        "ts",
        "type",
        "agent"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "seq": {
          "type": "integer",
          "minimum": 1
        },
        "ts": {
          "type": "string",
          "format": "date-time"
        },
        "agent": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "type": {
          "type": "string",
          "enum": [
            "task.created",
            "task.claimed",
            "task.completed",
            "task.blocked",
            "task.released",
            "task.cancelled",
            "status.update",
            "request.help"
          ]
        },
        "meta": {
          "type": "object"
        }
      }
    },
    "taskId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "priority": {
      "type": "string",
      "enum": [
        "low",
        "normal",
        "high"
      ]
    },
    "severity": {
      "type": "string",
      "enum": [
        "low",
        "normal",
        "high",
        "urgent"
      ]
    },
    "task_created": {
      "type": "object",
      "required": [
        "type",
        "taskId",
        "title"
      ],
      "properties": {
        "type": {
          "const": "task.created"
        },
        "taskId": {
          "$ref": "#/$defs/taskId"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "description": {
          "type": "string",
          "maxLength": 4000
        },
        "priority": {
          "$ref": "#/$defs/priority"
        },
        "tags": {
          "type": "array",
          "maxItems": 16,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          }
        }
      }
    },
    "task_claimed": {
      "type": "object",
      "required": [
        "type",
        "taskId"
      ],
      "properties": {
        "type": {
          "const": "task.claimed"
        },
        "taskId": {
          "$ref": "#/$defs/taskId"
        },
        "note": {
          "type": "string",
          "maxLength": 2000
        }
      }
    },
    "task_completed": {
      "type": "object",
      "required": [
        "type",
        "taskId"
      ],
      "properties": {
        "type": {
          "const": "task.completed"
        },
        "taskId": {
          "$ref": "#/$defs/taskId"
        },
        "result": {},
        "note": {
          "type": "string",
          "maxLength": 2000
        }
      }
    },
    "task_blocked": {
      "type": "object",
      "required": [
        "type",
        "taskId",
        "reason"
      ],
      "properties": {
        "type": {
          "const": "task.blocked"
        },
        "taskId": {
          "$ref": "#/$defs/taskId"
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000
        },
        "note": {
          "type": "string",
          "maxLength": 2000
        }
      }
    },
    "task_released": {
      "type": "object",
      "required": [
        "type",
        "taskId"
      ],
      "properties": {
        "type": {
          "const": "task.released"
        },
        "taskId": {
          "$ref": "#/$defs/taskId"
        },
        "reason": {
          "type": "string",
          "maxLength": 2000
        }
      }
    },
    "task_cancelled": {
      "type": "object",
      "required": [
        "type",
        "taskId"
      ],
      "properties": {
        "type": {
          "const": "task.cancelled"
        },
        "taskId": {
          "$ref": "#/$defs/taskId"
        },
        "reason": {
          "type": "string",
          "maxLength": 2000
        }
      }
    },
    "status_update": {
      "type": "object",
      "required": [
        "type",
        "text"
      ],
      "properties": {
        "type": {
          "const": "status.update"
        },
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000
        },
        "taskId": {
          "$ref": "#/$defs/taskId"
        },
        "data": {
          "type": "object"
        }
      }
    },
    "request_help": {
      "type": "object",
      "required": [
        "type",
        "text"
      ],
      "properties": {
        "type": {
          "const": "request.help"
        },
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000
        },
        "taskId": {
          "$ref": "#/$defs/taskId"
        },
        "severity": {
          "$ref": "#/$defs/severity"
        },
        "data": {
          "type": "object"
        }
      }
    }
  }
}
```
<!-- END schema:message -->

`unevaluatedProperties: false` (rather than `additionalProperties: false`) lets
each `oneOf` branch contribute its fields on top of the shared `envelope` while
still rejecting unknown keys — strict enough to catch typos, with `meta` as the
sanctioned extension point.

---

## 5. Task finite-state machine

A task's state is derived by folding lifecycle messages for its `taskId` in
`seq` order. There is no stored task record — replay is the definition.

```
                        task.created
                            │
                            ▼
        ┌──────────────► open ◄───────────────┐
        │                  │                   │
 task.released        task.claimed        task.released
        │                  │                   │
        │                  ▼                   │
        └────────────── claimed ──────────────┘
                       │   │   │
       task.completed  │   │   │  task.blocked
                       │   │   └──────────────► blocked
                       ▼   │                      │  │
                     done  │   task.completed ◄───┘  │ task.released → open
                  (terminal)                          │
                                                       ▼ (also: task.cancelled
            task.cancelled from open|claimed|blocked → cancelled, terminal)
```

### States

`open` · `claimed` · `blocked` · `done` (terminal) · `cancelled` (terminal).

### Transition table

| Current | Message | Next | Guard |
| --- | --- | --- | --- |
| ∅ | `task.created` | `open` | `taskId` must not already exist on the bus |
| `open` | `task.claimed` | `claimed` | — (this is the single-claimer point, §6) |
| `claimed` | `task.completed` | `done` | sender is the current claimer |
| `claimed` | `task.blocked` | `blocked` | sender is the current claimer |
| `claimed` | `task.released` | `open` | sender is the current claimer |
| `blocked` | `task.completed` | `done` | sender is the current claimer |
| `blocked` | `task.released` | `open` | sender is the current claimer |
| `open`\|`claimed`\|`blocked` | `task.cancelled` | `cancelled` | sender is the task creator |

Any message that does not match a row above is an **invalid transition** and is
rejected (the reference bus refuses to append it). Notably: a `claimed` or
`blocked` task **cannot be claimed by another agent** — the owner must
`task.released` it back to `open` first. This keeps ownership unambiguous and
the single-claimer guarantee crisp: **a claim is valid only from `open`.**

Communication messages (`status.update`, `request.help`) never change task
state and are always accepted (subject to schema validation).

---

## 6. Guarantees

**G1 — Total order.** Every appended message receives a unique `seq`, assigned
under an exclusive write lock. The sequence is strictly increasing and gapless
(`1, 2, 3, …`). The log read back in `seq` order is identical for all readers.

**G2 — Single claimer.** For any task, **at most one** `task.claimed` ever
transitions it out of `open`. Because a claim is valid only from `open`, and the
read-validate-append cycle runs under the exclusive lock (§7), no two claims can
both observe `open`. Concurrent claimers race; exactly one wins and the rest are
rejected with a "not open" outcome. Proven by the simulation in
`test/concurrency.sim.test.ts`.

**G3 — Idempotency.** Re-posting a message whose `id` already exists is a no-op
that returns the existing stored record. Safe to retry on timeout.

**G4 — Append-only / immutability.** Messages are never mutated or deleted by
the protocol. State changes only by appending new messages. The log is an audit
trail.

**G5 — Eventual visibility.** A message with sequence `seq` is visible to every
reader once observed; subscriptions (§9) deliver every message with `seq` above
the subscriber's cursor, in order, at least once.

---

## 7. Concurrency & atomicity (normative for the file transport)

The file transport is designed for **multiple uncoordinated OS processes**
sharing one directory. It MUST uphold G1 and G2 using only the filesystem.

- **Exclusive write lock.** All state-mutating operations (any append) acquire a
  bus-wide lock before reading the log tail and appending. The lock is acquired
  by **atomic exclusive file creation** (`open(…, "wx")`, i.e. `O_CREAT|O_EXCL`)
  of a lock file inside the bus directory — the operation the OS guarantees only
  one creator can win. Equivalent atomic primitives (e.g. `rename` onto a
  unique temp) are permitted.
- **Critical section.** Under the lock: (1) read any log bytes appended since the
  holder's last offset, (2) compute current task state, (3) validate the FSM
  transition and idempotency, (4) assign `seq`/`ts`/`id`, (5) append one
  complete `\n`-terminated JSON line, (6) release the lock. Reading the tail and
  appending under the same lock is what makes `seq` gapless and claims
  single-winner.
- **Stale lock recovery.** A crashed holder must not wedge the bus. The lock
  file records `{ pid, host, ts, token }`. A waiter may steal the lock if the
  holder is provably dead (same host + `process.kill(pid, 0)` fails) or the lock
  is older than a staleness deadline. A holder releases only a lock whose
  `token` it still owns.
- **Append atomicity.** Each message is one `write` of a single line; the bus
  never performs partial-line writes. Readers tolerate (skip) a trailing partial
  line, which can only be an in-flight append by a misbehaving writer.

The HTTP transport (§ below) is a thin layer over the same core and inherits
these guarantees; a lost claim race surfaces as HTTP `409 Conflict`.

---

## 8. Versioning & compatibility

- **Protocol id** `agent-bus/0` identifies this wire format. Spec version
  `0.1.0` follows semver *for the spec document*.
- A bus directory carries a `meta.json`: `{ "protocol": "agent-bus/0",
  "version": "<spec>", "created": "<ts>" }`.
- **Within `agent-bus/0`**, changes are **additive only**: new optional fields,
  new message types. Consumers SHOULD ignore unknown top-level fields and
  unknown message types they don't handle (forward compatibility). The strict
  reference validator rejects unknown fields to catch bugs — use the `meta`
  object for custom data instead of inventing top-level keys.
- A breaking change bumps the protocol id to `agent-bus/1`.

---

## 9. Subscriptions

A subscription delivers every message with `seq` strictly greater than a cursor,
in `seq` order, at least once (G5). Cursors are just integers, so a subscriber
that records its last-seen `seq` can resume after a crash with no missed or
duplicated *state* (idempotent replay).

- **File transport:** tail `log.jsonl` — read appended bytes since the last
  offset, parse complete lines, emit. The reference implementation polls on a
  short interval (and may additionally use `fs.watch` to reduce latency).
- **HTTP transport:** `GET /subscribe?fromSeq=<n>` as Server-Sent Events; each
  `data:` frame is one message JSON.

---

## 10. Derived task view (informative)

For convenience the reference bus exposes a folded `Task` view. It is not part
of the wire contract (it is always recomputable from the log), but its shape is
documented in [`schemas/task.schema.json`](./schemas/task.schema.json):

`{ id, title, description?, priority, tags, state, creator, claimer?, result?,
blockedReason?, createdSeq, updatedSeq, createdAt, updatedAt }`.

---

## 11. Privacy

The file transport performs **no network I/O** and emits **no telemetry**. A bus
is just a folder you own. The HTTP transport binds to `127.0.0.1` by default.
