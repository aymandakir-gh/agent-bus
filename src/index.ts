/**
 * agent-bus — a message bus + task board for teams of agents.
 *
 * Public entry point. The wire contract lives in `PROTOCOL.md`; the canonical
 * JSON Schemas in `schemas/` (generated from `core/schemas.ts`). This module
 * re-exports the reference implementation: message model, task FSM, validation,
 * and the file transport.
 */

export { PROTOCOL_ID, SPEC_VERSION } from './version';

export * from './core/types';
export * from './core/errors';
export { newId, ulid } from './core/ids';
export { classifyTransition, applyTransition, reduce, type TransitionResult } from './core/fsm';
export {
  messageSchema,
  messageInputSchema,
  taskSchema,
  defKey,
  SCHEMA_FILES,
} from './core/schemas';
export {
  validateMessage,
  isValidMessage,
  isValidInput,
  assertValidInput,
  assertValidMessage,
} from './core/validate';
export {
  acquireLock,
  withLock,
  type LockHandle,
  type LockOptions,
} from './core/lock';
export {
  FileBus,
  type FileBusOptions,
} from './core/file-bus';
export type {
  BusTransport,
  BusMeta,
  ClaimResult,
  ClaimOptions,
  CreateTaskInput,
  MessageFilter,
  TaskFilter,
  SubscribeOptions,
  Subscription,
} from './core/transport';
// The HTTP *client* is fetch-only (no server dependency), so it is safe to
// export from the main entry. The *server* lives behind the `agent-bus/server`
// subpath so importing the library never eagerly loads Fastify.
export { HttpBusClient, type HttpBusClientOptions } from './http/client';
