/**
 * Typed errors. Each carries a stable `code` so transports (e.g. HTTP) can map
 * failures without string matching.
 */

import type { TaskState } from './types';

export type BusErrorCode =
  | 'validation'
  | 'transition'
  | 'lock_timeout'
  | 'not_found'
  | 'bus';

export class BusError extends Error {
  readonly code: BusErrorCode;
  constructor(message: string, code: BusErrorCode = 'bus') {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A message failed JSON Schema validation. */
export class ValidationError extends BusError {
  readonly errors: string[];
  constructor(message: string, errors: string[]) {
    super(message, 'validation');
    this.errors = errors;
  }
}

/** Reasons a task FSM transition can be rejected. */
export type TransitionReason =
  | 'task_exists'
  | 'task_not_found'
  | 'not_open'
  | 'invalid_state'
  | 'not_owner'
  | 'not_creator';

/** A lifecycle message was not a legal transition for the task's state. */
export class TransitionError extends BusError {
  readonly reason: TransitionReason;
  readonly taskId: string;
  readonly from: TaskState | undefined;
  constructor(
    reason: TransitionReason,
    taskId: string,
    from: TaskState | undefined,
    message?: string,
  ) {
    super(message ?? `transition rejected (${reason}) for task ${taskId}`, 'transition');
    this.reason = reason;
    this.taskId = taskId;
    this.from = from;
  }
}

/** Could not acquire the bus write lock within the timeout. */
export class LockTimeoutError extends BusError {
  constructor(message: string) {
    super(message, 'lock_timeout');
  }
}

export class NotFoundError extends BusError {
  constructor(message: string) {
    super(message, 'not_found');
  }
}
