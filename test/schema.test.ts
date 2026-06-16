import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { messageSchema, taskSchema, SCHEMA_FILES } from '../src/core/schemas';
import {
  isValidMessage,
  isValidInput,
  validateMessage,
} from '../src/core/validate';

const root = process.cwd();

function compile(schema: object) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Validate against a fresh compile of the PUBLISHED json file, proving the
 *  artifact other languages consume is itself correct. */
const publishedMessage = compile(
  JSON.parse(readFileSync(join(root, 'schemas', 'message.schema.json'), 'utf8')),
);
const publishedInput = compile(
  JSON.parse(
    readFileSync(join(root, 'schemas', 'message.input.schema.json'), 'utf8'),
  ),
);

const TS = '2026-06-16T10:00:00.000Z';
function stored(extra: Record<string, unknown>): Record<string, unknown> {
  return { id: 'msg_1', seq: 1, ts: TS, agent: 'agent-a', ...extra };
}

const validStored: Array<[string, Record<string, unknown>]> = [
  ['task.created', stored({ type: 'task.created', taskId: 't1', title: 'Do it' })],
  [
    'task.created full',
    stored({
      type: 'task.created',
      taskId: 't1',
      title: 'Do it',
      description: 'details',
      priority: 'high',
      tags: ['a', 'b'],
      meta: { source: 'cli' },
    }),
  ],
  ['task.claimed', stored({ type: 'task.claimed', taskId: 't1', note: 'mine' })],
  [
    'task.completed any result',
    stored({ type: 'task.completed', taskId: 't1', result: { ok: true, n: 3 } }),
  ],
  ['task.completed no result', stored({ type: 'task.completed', taskId: 't1' })],
  ['task.blocked', stored({ type: 'task.blocked', taskId: 't1', reason: 'stuck' })],
  ['task.released', stored({ type: 'task.released', taskId: 't1' })],
  ['task.cancelled', stored({ type: 'task.cancelled', taskId: 't1', reason: 'nvm' })],
  ['status.update', stored({ type: 'status.update', text: 'progress' })],
  [
    'request.help',
    stored({ type: 'request.help', text: 'help', severity: 'urgent', taskId: 't1' }),
  ],
];

const invalidStored: Array<[string, Record<string, unknown>]> = [
  ['missing title', stored({ type: 'task.created', taskId: 't1' })],
  ['bad priority', stored({ type: 'task.created', taskId: 't1', title: 'x', priority: 'urgent' })],
  ['blocked missing reason', stored({ type: 'task.blocked', taskId: 't1' })],
  ['status missing text', stored({ type: 'status.update' })],
  ['unknown type', stored({ type: 'task.exploded', taskId: 't1' })],
  ['unknown top-level field', stored({ type: 'task.claimed', taskId: 't1', foo: 'bar' })],
  ['seq must be >= 1', { id: 'm', seq: 0, ts: TS, agent: 'a', type: 'status.update', text: 'x' }],
  ['missing seq', { id: 'm', ts: TS, agent: 'a', type: 'status.update', text: 'x' }],
  ['missing agent', { id: 'm', seq: 1, ts: TS, type: 'status.update', text: 'x' }],
  ['bad ts format', stored({ ts: 'not-a-date', type: 'status.update', text: 'x' })],
  ['title too long', stored({ type: 'task.created', taskId: 't1', title: 'x'.repeat(201) })],
  ['empty agent', { id: 'm', seq: 1, ts: TS, agent: '', type: 'status.update', text: 'x' }],
  ['severity bad enum', stored({ type: 'request.help', text: 'x', severity: 'meh' })],
];

describe('schema: drift between source, schemas/, and PROTOCOL.md', () => {
  it('schemas/*.json match the in-code source of truth', () => {
    for (const { file, schema } of SCHEMA_FILES) {
      const onDisk = JSON.parse(readFileSync(join(root, 'schemas', file), 'utf8'));
      expect(onDisk, `schemas/${file} is stale — run pnpm gen:schemas`).toEqual(schema);
    }
  });

  it('PROTOCOL.md embeds the current message schema', () => {
    const doc = readFileSync(join(root, 'PROTOCOL.md'), 'utf8');
    const begin = '<!-- BEGIN schema:message -->';
    const end = '<!-- END schema:message -->';
    const bi = doc.indexOf(begin);
    const ei = doc.indexOf(end);
    expect(bi).toBeGreaterThan(-1);
    expect(ei).toBeGreaterThan(bi);
    const inner = doc.slice(bi + begin.length, ei).replace(/```json/g, '').replace(/```/g, '').trim();
    expect(JSON.parse(inner), 'PROTOCOL.md is stale — run pnpm gen:schemas').toEqual(messageSchema);
  });

  it('three schema artifacts are exported', () => {
    expect(SCHEMA_FILES.map((s) => s.file)).toEqual([
      'message.schema.json',
      'message.input.schema.json',
      'task.schema.json',
    ]);
    expect(taskSchema['title']).toBe('AgentBusTask');
  });
});

describe('schema: stored messages', () => {
  it.each(validStored)('accepts valid %s', (_name, fixture) => {
    expect(publishedMessage(fixture), JSON.stringify(publishedMessage.errors)).toBe(true);
    expect(isValidMessage(fixture)).toBe(true); // reference validator agrees
  });

  it.each(invalidStored)('rejects invalid: %s', (_name, fixture) => {
    expect(publishedMessage(fixture)).toBe(false);
    expect(isValidMessage(fixture)).toBe(false); // reference validator agrees
  });

  it('validateMessage returns typed value or errors', () => {
    const ok = validateMessage(validStored[0]![1]);
    expect(ok.ok).toBe(true);
    const bad = validateMessage(invalidStored[0]![1]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBeGreaterThan(0);
  });
});

describe('schema: input payloads', () => {
  const validInput: Array<[string, Record<string, unknown>]> = [
    ['minimal created', { type: 'task.created', agent: 'a', taskId: 't1', title: 'x' }],
    ['with id', { type: 'task.claimed', agent: 'a', taskId: 't1', id: 'my-stable-id' }],
    ['status', { type: 'status.update', agent: 'a', text: 'hi', data: { k: 1 } }],
  ];
  const invalidInput: Array<[string, Record<string, unknown>]> = [
    ['client cannot set seq', { type: 'status.update', agent: 'a', text: 'x', seq: 5 }],
    ['client cannot set ts', { type: 'status.update', agent: 'a', text: 'x', ts: TS }],
    ['missing agent', { type: 'status.update', text: 'x' }],
    ['unknown field', { type: 'status.update', agent: 'a', text: 'x', foo: 1 }],
  ];

  it.each(validInput)('accepts valid input: %s', (_name, fixture) => {
    expect(publishedInput(fixture), JSON.stringify(publishedInput.errors)).toBe(true);
    expect(isValidInput(fixture)).toBe(true);
  });

  it.each(invalidInput)('rejects invalid input: %s', (_name, fixture) => {
    expect(publishedInput(fixture)).toBe(false);
    expect(isValidInput(fixture)).toBe(false);
  });
});
