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
  type BusMeta,
  type ClaimResult,
  type MessageFilter,
  type TaskFilter,
  type SubscribeOptions,
  type Subscription,
} from './core/file-bus';
