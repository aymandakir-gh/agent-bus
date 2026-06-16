/**
 * Task finite-state machine (PROTOCOL.md §5).
 *
 * `classifyTransition` is the single oracle for legality — used both leniently
 * by {@link reduce} (skip illegal/no-op messages when folding any log) and
 * strictly by the bus (reject illegal transitions before appending). There is
 * exactly one definition of what is legal.
 */
import type { Message, TaskView } from './types';
import type { TransitionReason } from './errors';
import type { TaskState } from './types';

export type TransitionResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: TransitionReason; from: TaskState | undefined };

/** Decide whether `msg` legally applies to a task currently in `current`. */
export function classifyTransition(
  current: TaskView | undefined,
  msg: Message,
): TransitionResult {
  switch (msg.type) {
    case 'task.created':
      if (current) return { ok: false, reason: 'task_exists', from: current.state };
      return { ok: true, changed: true };

    case 'task.claimed':
      if (!current) return { ok: false, reason: 'task_not_found', from: undefined };
      if (current.state !== 'open')
        return { ok: false, reason: 'not_open', from: current.state };
      return { ok: true, changed: true };

    case 'task.completed':
      if (!current) return { ok: false, reason: 'task_not_found', from: undefined };
      if (current.state !== 'claimed' && current.state !== 'blocked')
        return { ok: false, reason: 'invalid_state', from: current.state };
      if (current.claimer !== msg.agent)
        return { ok: false, reason: 'not_owner', from: current.state };
      return { ok: true, changed: true };

    case 'task.blocked':
      if (!current) return { ok: false, reason: 'task_not_found', from: undefined };
      if (current.state !== 'claimed')
        return { ok: false, reason: 'invalid_state', from: current.state };
      if (current.claimer !== msg.agent)
        return { ok: false, reason: 'not_owner', from: current.state };
      return { ok: true, changed: true };

    case 'task.released':
      if (!current) return { ok: false, reason: 'task_not_found', from: undefined };
      if (current.state !== 'claimed' && current.state !== 'blocked')
        return { ok: false, reason: 'invalid_state', from: current.state };
      if (current.claimer !== msg.agent)
        return { ok: false, reason: 'not_owner', from: current.state };
      return { ok: true, changed: true };

    case 'task.cancelled':
      if (!current) return { ok: false, reason: 'task_not_found', from: undefined };
      if (current.state === 'done' || current.state === 'cancelled')
        return { ok: false, reason: 'invalid_state', from: current.state };
      if (current.creator !== msg.agent)
        return { ok: false, reason: 'not_creator', from: current.state };
      return { ok: true, changed: true };

    case 'status.update':
    case 'request.help':
      return { ok: true, changed: false };

    default:
      // An unknown message type (a corrupt line, or a forward-compatible type
      // from a newer protocol minor) is ignored for FSM purposes rather than
      // crashing — PROTOCOL.md §8: consumers ignore message types they don't
      // handle. Reachable only at runtime; the union is exhaustive at compile time.
      return { ok: true, changed: false };
  }
}

/** Apply a legal, state-changing `msg` to `current`, returning the next view.
 *  Caller must have checked {@link classifyTransition} first. */
export function applyTransition(
  current: TaskView | undefined,
  msg: Message,
): TaskView {
  if (msg.type === 'task.created') {
    return {
      id: msg.taskId,
      title: msg.title,
      description: msg.description,
      priority: msg.priority ?? 'normal',
      tags: msg.tags ?? [],
      state: 'open',
      creator: msg.agent,
      createdSeq: msg.seq,
      updatedSeq: msg.seq,
      createdAt: msg.ts,
      updatedAt: msg.ts,
    };
  }

  if (!current) {
    throw new Error(`applyTransition: no current task for ${msg.type}`);
  }
  const base: TaskView = { ...current, updatedSeq: msg.seq, updatedAt: msg.ts };

  switch (msg.type) {
    case 'task.claimed':
      return { ...base, state: 'claimed', claimer: msg.agent };
    case 'task.completed':
      return { ...base, state: 'done', result: msg.result, blockedReason: undefined };
    case 'task.blocked':
      return { ...base, state: 'blocked', blockedReason: msg.reason };
    case 'task.released':
      return { ...base, state: 'open', claimer: undefined, blockedReason: undefined };
    case 'task.cancelled':
      return { ...base, state: 'cancelled' };
    default:
      return current;
  }
}

/** Fold a set of messages into derived task views. Lenient: messages that are
 *  not legal transitions (or are communication messages) are skipped, so any
 *  log — even a hand-assembled one — yields a well-defined view. Messages are
 *  processed in `seq` order regardless of input order. */
export function reduce(messages: Iterable<Message>): Map<string, TaskView> {
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  const tasks = new Map<string, TaskView>();
  for (const msg of ordered) {
    if (msg.type === 'status.update' || msg.type === 'request.help') continue;
    const current = tasks.get(msg.taskId);
    const res = classifyTransition(current, msg);
    if (!res.ok || !res.changed) continue;
    tasks.set(msg.taskId, applyTransition(current, msg));
  }
  return tasks;
}
