/**
 * The canonical wire contract, as JSON Schema (draft 2020-12).
 *
 * This module is the SINGLE SOURCE OF TRUTH. From it we:
 *   - validate every message in the reference bus (via ajv),
 *   - generate the published `schemas/*.json` files,
 *   - inject the schema blocks into `PROTOCOL.md`.
 *
 * `pnpm gen:schemas` regenerates the artifacts; `test/schema.test.ts` fails on
 * any drift between this module, `schemas/`, and `PROTOCOL.md`.
 */
import { MESSAGE_TYPES, type MessageType } from './types';
import { PROTOCOL_ID, SPEC_VERSION } from '../version';

const REPO = 'https://github.com/aymandakir-gh/agent-bus/blob/main/schemas';

/** `task.created` -> `task_created` ($defs keys can't contain dots cleanly). */
export function defKey(type: MessageType): string {
  return type.replace('.', '_');
}

type Json = Record<string, unknown>;

const taskIdDef: Json = { type: 'string', minLength: 1, maxLength: 128 };
const priorityDef: Json = { type: 'string', enum: ['low', 'normal', 'high'] };
const severityDef: Json = {
  type: 'string',
  enum: ['low', 'normal', 'high', 'urgent'],
};

/** Per-type subschemas. Each pins `type` (drives the oneOf) and its own fields.
 *  Shared envelope fields come from `#/$defs/envelope` via the top-level allOf;
 *  `unevaluatedProperties: false` then rejects anything unknown. */
const perType: Record<string, Json> = {
  task_created: {
    type: 'object',
    required: ['type', 'taskId', 'title'],
    properties: {
      type: { const: 'task.created' },
      taskId: { $ref: '#/$defs/taskId' },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string', maxLength: 4000 },
      priority: { $ref: '#/$defs/priority' },
      tags: {
        type: 'array',
        maxItems: 16,
        items: { type: 'string', minLength: 1, maxLength: 64 },
      },
    },
  },
  task_claimed: {
    type: 'object',
    required: ['type', 'taskId'],
    properties: {
      type: { const: 'task.claimed' },
      taskId: { $ref: '#/$defs/taskId' },
      note: { type: 'string', maxLength: 2000 },
    },
  },
  task_completed: {
    type: 'object',
    required: ['type', 'taskId'],
    properties: {
      type: { const: 'task.completed' },
      taskId: { $ref: '#/$defs/taskId' },
      result: {},
      note: { type: 'string', maxLength: 2000 },
    },
  },
  task_blocked: {
    type: 'object',
    required: ['type', 'taskId', 'reason'],
    properties: {
      type: { const: 'task.blocked' },
      taskId: { $ref: '#/$defs/taskId' },
      reason: { type: 'string', minLength: 1, maxLength: 2000 },
      note: { type: 'string', maxLength: 2000 },
    },
  },
  task_released: {
    type: 'object',
    required: ['type', 'taskId'],
    properties: {
      type: { const: 'task.released' },
      taskId: { $ref: '#/$defs/taskId' },
      reason: { type: 'string', maxLength: 2000 },
    },
  },
  task_cancelled: {
    type: 'object',
    required: ['type', 'taskId'],
    properties: {
      type: { const: 'task.cancelled' },
      taskId: { $ref: '#/$defs/taskId' },
      reason: { type: 'string', maxLength: 2000 },
    },
  },
  status_update: {
    type: 'object',
    required: ['type', 'text'],
    properties: {
      type: { const: 'status.update' },
      text: { type: 'string', minLength: 1, maxLength: 2000 },
      taskId: { $ref: '#/$defs/taskId' },
      data: { type: 'object' },
    },
  },
  request_help: {
    type: 'object',
    required: ['type', 'text'],
    properties: {
      type: { const: 'request.help' },
      text: { type: 'string', minLength: 1, maxLength: 2000 },
      taskId: { $ref: '#/$defs/taskId' },
      severity: { $ref: '#/$defs/severity' },
      data: { type: 'object' },
    },
  },
};

function envelope(forInput: boolean): Json {
  const idProp = { type: 'string', minLength: 1, maxLength: 128 };
  const agentProp = { type: 'string', minLength: 1, maxLength: 128 };
  const typeProp = { type: 'string', enum: [...MESSAGE_TYPES] };
  const metaProp = { type: 'object' };
  if (forInput) {
    // Clients post type + agent + fields; the bus assigns id/seq/ts.
    return {
      type: 'object',
      required: ['type', 'agent'],
      properties: {
        id: idProp,
        agent: agentProp,
        type: typeProp,
        meta: metaProp,
      },
    };
  }
  return {
    type: 'object',
    required: ['id', 'seq', 'ts', 'type', 'agent'],
    properties: {
      id: idProp,
      seq: { type: 'integer', minimum: 1 },
      ts: { type: 'string', format: 'date-time' },
      agent: agentProp,
      type: typeProp,
      meta: metaProp,
    },
  };
}

function buildMessageSchema(forInput: boolean): Json {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: forInput
      ? `${REPO}/message.input.schema.json`
      : `${REPO}/message.schema.json`,
    title: forInput ? 'AgentBusMessageInput' : 'AgentBusMessage',
    description: forInput
      ? 'A message as posted by a client (protocol agent-bus/0); the bus assigns id, seq, ts.'
      : 'A single stored message in an agent-bus log (protocol agent-bus/0).',
    type: 'object',
    allOf: [{ $ref: '#/$defs/envelope' }],
    oneOf: MESSAGE_TYPES.map((t) => ({ $ref: `#/$defs/${defKey(t)}` })),
    unevaluatedProperties: false,
    $defs: {
      envelope: envelope(forInput),
      taskId: taskIdDef,
      priority: priorityDef,
      severity: severityDef,
      ...perType,
    },
  };
}

/** Canonical schema for a stored message (the published contract). */
export const messageSchema: Json = buildMessageSchema(false);

/** Schema for a client post payload (id optional; no seq/ts). */
export const messageInputSchema: Json = buildMessageSchema(true);

/** Shape of a derived task view (informative; always recomputable). */
export const taskSchema: Json = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${REPO}/task.schema.json`,
  title: 'AgentBusTask',
  description: 'A task view derived by folding the message log. Not part of the wire contract.',
  type: 'object',
  required: [
    'id',
    'title',
    'priority',
    'tags',
    'state',
    'creator',
    'createdSeq',
    'updatedSeq',
    'createdAt',
    'updatedAt',
  ],
  additionalProperties: false,
  properties: {
    id: { $ref: '#/$defs/taskId' },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 4000 },
    priority: priorityDef,
    tags: {
      type: 'array',
      maxItems: 16,
      items: { type: 'string', minLength: 1, maxLength: 64 },
    },
    state: {
      type: 'string',
      enum: ['open', 'claimed', 'blocked', 'done', 'cancelled'],
    },
    creator: { type: 'string', minLength: 1, maxLength: 128 },
    claimer: { type: 'string', minLength: 1, maxLength: 128 },
    result: {},
    blockedReason: { type: 'string' },
    createdSeq: { type: 'integer', minimum: 1 },
    updatedSeq: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  $defs: { taskId: taskIdDef },
};

/** Named artifacts emitted to `schemas/` and mirrored into `PROTOCOL.md`. */
export const SCHEMA_FILES: ReadonlyArray<{
  name: string;
  file: string;
  marker: string;
  schema: Json;
}> = [
  { name: 'message', file: 'message.schema.json', marker: 'message', schema: messageSchema },
  { name: 'messageInput', file: 'message.input.schema.json', marker: 'message-input', schema: messageInputSchema },
  { name: 'task', file: 'task.schema.json', marker: 'task', schema: taskSchema },
];

export interface SchemaManifestEntry {
  name: string;
  file: string;
  $id: string;
  title: string;
}

/**
 * A versioned manifest of the published contract, written to `schemas/index.json`.
 * `version` is the **protocol spec version** (`SPEC_VERSION`), not the npm package
 * version — cross-language consumers pin to the protocol, not the reference impl.
 * A test asserts the on-disk manifest tracks this object (no drift).
 */
export const schemaManifest: {
  protocol: string;
  version: string;
  schemas: SchemaManifestEntry[];
} = {
  protocol: PROTOCOL_ID,
  version: SPEC_VERSION,
  schemas: SCHEMA_FILES.map(({ name, file, schema }) => ({
    name,
    file,
    $id: schema['$id'] as string,
    title: schema['title'] as string,
  })),
};

export interface SchemaBundle {
  protocol: string;
  version: string;
  schemas: Record<string, Json>;
}

/** A single self-contained, versioned artifact (manifest + all schemas inlined)
 *  for cross-language consumers who want one download. Emitted by
 *  `pnpm schemas:bundle` and attached to each GitHub release. */
export function buildSchemaBundle(): SchemaBundle {
  return {
    protocol: PROTOCOL_ID,
    version: SPEC_VERSION,
    schemas: Object.fromEntries(SCHEMA_FILES.map(({ name, schema }) => [name, schema])),
  };
}
