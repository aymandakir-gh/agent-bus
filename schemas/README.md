# agent-bus JSON Schemas

The canonical, language-agnostic contract for protocol **`agent-bus/0`**
(JSON Schema **draft 2020-12**). These files are generated from the single source
of truth (`src/core/schemas.ts`) by `pnpm gen:schemas` and are validated in CI;
the same schema is what the reference implementation validates against at
runtime, so it can't drift from the spec.

| File | What it describes |
| --- | --- |
| [`index.json`](./index.json) | **Versioned manifest** — `{ protocol, version, schemas[] }`. Start here: it lists the schemas and pins the protocol **spec version**. |
| [`message.schema.json`](./message.schema.json) | A **stored** message — one line of `log.jsonl` (includes the bus-assigned `id`, `seq`, `ts`). The headline contract. |
| [`message.input.schema.json`](./message.input.schema.json) | A **post payload** — what a client sends; `id` optional, no `seq`/`ts`. |
| [`task.schema.json`](./task.schema.json) | The **derived task view** (informative; always recomputable by folding the log). |

`version` in `index.json` is the protocol **spec version**, not the npm package
version — pin to the protocol, not the reference implementation. Each GitHub
release also attaches a single self-contained bundle
`agent-bus-schemas-<version>.json` (manifest + all schemas inlined;
`pnpm schemas:bundle`) for one-download consumption.

See [`../PROTOCOL.md`](../PROTOCOL.md) for the full prose: message types, the task
FSM, ordering and single-claimer guarantees, and versioning (§8).

## Validate in any language

Use any draft 2020-12 validator. Examples:

**Python** (`jsonschema`):
```python
import json
from jsonschema import Draft202012Validator

schema = json.load(open("message.schema.json"))
validator = Draft202012Validator(schema)
for line in open("shared/log.jsonl"):
    validator.validate(json.loads(line))
```

**Node** (`ajv`):
```js
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "./message.schema.json" assert { type: "json" };

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
```

## Notes

- The schema uses `unevaluatedProperties: false`, so unknown top-level keys are
  rejected. Put custom data under the open `meta` object.
- `agent-bus/0` evolves additively; within it, new optional fields and message
  types may appear. Lenient consumers should ignore unknown message types and
  fields for forward compatibility.
