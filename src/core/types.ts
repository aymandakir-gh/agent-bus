/**
 * Hand-written TypeScript mirror of the wire contract in `PROTOCOL.md`.
 *
 * The canonical machine-readable contract is the JSON Schema in
 * `src/core/schemas.ts` (published to `schemas/`). These types are kept in
 * lockstep with it by the conformance test in `test/schema.test.ts`, which
 * checks that the same fixtures pass/fail under both the schema and the types.
 */

/** The eight message types, in spec order. */
export const MESSAGE_TYPES = [
  'task.created',
  'task.claimed',
  'task.completed',
  'task.blocked',
  'task.released',
  'task.cancelled',
  'status.update',
  'request.help',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Task message types that drive the FSM. */
export const TASK_MESSAGE_TYPES = [
  'task.created',
  'task.claimed',
  'task.completed',
  'task.blocked',
  'task.released',
  'task.cancelled',
] as const;

export type TaskMessageType = (typeof TASK_MESSAGE_TYPES)[number];

export type Priority = 'low' | 'normal' | 'high';
export type Severity = 'low' | 'normal' | 'high' | 'urgent';

/** Task lifecycle states. `done` and `cancelled` are terminal. */
export type TaskState = 'open' | 'claimed' | 'blocked' | 'done' | 'cancelled';

export const TASK_STATES = [
  'open',
  'claimed',
  'blocked',
  'done',
  'cancelled',
] as const;

/** Fields the bus assigns to every stored message. */
export interface Envelope {
  /** Unique message id; idempotency key. Client-supplied or bus-assigned. */
  id: string;
  /** Total-order sequence assigned by the bus under lock (≥ 1, gapless). */
  seq: number;
  /** RFC 3339 / ISO 8601 UTC append time. Informational, not used for order. */
  ts: string;
  /** Sending agent id. */
  agent: string;
  /** Optional free-form extension data (forward-compatibility escape hatch). */
  meta?: Record<string, unknown>;
}

export interface TaskCreatedMessage extends Envelope {
  type: 'task.created';
  taskId: string;
  title: string;
  description?: string;
  priority?: Priority;
  tags?: string[];
}

export interface TaskClaimedMessage extends Envelope {
  type: 'task.claimed';
  taskId: string;
  note?: string;
}

export interface TaskCompletedMessage extends Envelope {
  type: 'task.completed';
  taskId: string;
  result?: unknown;
  note?: string;
}

export interface TaskBlockedMessage extends Envelope {
  type: 'task.blocked';
  taskId: string;
  reason: string;
  note?: string;
}

export interface TaskReleasedMessage extends Envelope {
  type: 'task.released';
  taskId: string;
  reason?: string;
}

export interface TaskCancelledMessage extends Envelope {
  type: 'task.cancelled';
  taskId: string;
  reason?: string;
}

export interface StatusUpdateMessage extends Envelope {
  type: 'status.update';
  text: string;
  taskId?: string;
  data?: Record<string, unknown>;
}

export interface RequestHelpMessage extends Envelope {
  type: 'request.help';
  text: string;
  taskId?: string;
  severity?: Severity;
  data?: Record<string, unknown>;
}

/** A stored message: one record in the log. Discriminated on `type`. */
export type Message =
  | TaskCreatedMessage
  | TaskClaimedMessage
  | TaskCompletedMessage
  | TaskBlockedMessage
  | TaskReleasedMessage
  | TaskCancelledMessage
  | StatusUpdateMessage
  | RequestHelpMessage;

/**
 * The payload a client posts: a message minus the bus-assigned `seq`/`ts`,
 * with an optional `id` (the bus assigns one if omitted).
 */
type ToInput<T> = T extends Message
  ? Omit<T, 'seq' | 'ts' | 'id'> & { id?: string }
  : never;

export type MessageInput = ToInput<Message>;

/** A task derived by folding the log. Recomputable; not part of the wire. */
export interface TaskView {
  id: string;
  title: string;
  description?: string;
  priority: Priority;
  tags: string[];
  state: TaskState;
  /** Agent that created the task. */
  creator: string;
  /** Current owner (set while claimed/blocked; cleared on release). */
  claimer?: string;
  /** Result attached by `task.completed`, if any. */
  result?: unknown;
  /** Reason attached by `task.blocked`, if currently blocked. */
  blockedReason?: string;
  createdSeq: number;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
}
