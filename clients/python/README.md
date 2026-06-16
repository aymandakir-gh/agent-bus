# agent-bus — Python reference client

A minimal, **standard-library-only** Python client for the `agent-bus/0` HTTP
transport. It exists to prove the protocol is genuinely language-agnostic: it
talks to the TypeScript reference server and its messages validate against the
*same* [published JSON Schemas](../../schemas) — so the spec is a real contract,
not TypeScript-only documentation.

> This is a reference client (correctness over features). The server upholds the
> ordering and single-claimer guarantees; the client is a thin, faithful caller.

## Use

```python
from agentbus import AgentBusClient

bus = AgentBusClient("http://127.0.0.1:7777")

task = bus.create_task(title="Write the report", agent="lead", task_id="t1")
res = bus.claim("t1", "worker-1")          # {"ok": True, ...} | {"ok": False, "reason": "not_open"}
if res["ok"]:
    bus.complete("t1", "worker-1", result={"pages": 12})

for msg in bus.subscribe(from_seq=0):       # Server-Sent Events, in seq order
    print(msg["seq"], msg["type"], msg["agent"])
    break
```

Start a server with the reference CLI (from the repo root):

```bash
npx agent-bus serve --dir ./shared --port 7777
```

## Tests (cross-language conformance)

The test suite starts the built TypeScript server, drives it through the client,
and validates every returned message against `schemas/*.json` with `jsonschema`.
A drift between the TS implementation and the published schemas fails the suite.

```bash
# from the repo root, after `pnpm build`:
python -m venv .venv && . .venv/bin/activate
pip install -r clients/python/requirements-dev.txt
python -m pytest clients/python
```

This runs in CI on every push (the `python-client` job).
