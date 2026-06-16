import { describe, it, expect } from 'vitest';
import { classifyTransition, reduce } from '../src/core/fsm';
import type { Message, TaskView } from '../src/core/types';

let counter = 0;
function m(partial: Partial<Message> & Pick<Message, 'type' | 'agent'>): Message {
  counter += 1;
  return {
    id: `msg_${counter}`,
    seq: counter,
    ts: new Date(counter * 1000).toISOString(),
    ...partial,
  } as Message;
}

function created(taskId: string, agent: string): Message {
  return m({ type: 'task.created', agent, taskId, title: `Task ${taskId}` } as Partial<Message> & Pick<Message, 'type' | 'agent'>);
}

function taskOf(log: Message[], taskId: string): TaskView | undefined {
  return reduce(log).get(taskId);
}

describe('fsm: classifyTransition guards', () => {
  it('created on a fresh task is legal; re-create is task_exists', () => {
    const c = created('t1', 'a');
    expect(classifyTransition(undefined, c)).toEqual({ ok: true, changed: true });
    const view = taskOf([c], 't1')!;
    const r = classifyTransition(view, created('t1', 'b'));
    expect(r).toEqual({ ok: false, reason: 'task_exists', from: 'open' });
  });

  it('claim is legal only from open', () => {
    const log = [created('t1', 'a')];
    const open = taskOf(log, 't1');
    expect(classifyTransition(open, m({ type: 'task.claimed', agent: 'w1', taskId: 't1' }))).toEqual({
      ok: true,
      changed: true,
    });
    // After claimed, another claim is not_open.
    const claim = m({ type: 'task.claimed', agent: 'w1', taskId: 't1' });
    const claimed = taskOf([...log, claim], 't1');
    expect(classifyTransition(claimed, m({ type: 'task.claimed', agent: 'w2', taskId: 't1' }))).toEqual({
      ok: false,
      reason: 'not_open',
      from: 'claimed',
    });
  });

  it('claim of a missing task is task_not_found', () => {
    expect(classifyTransition(undefined, m({ type: 'task.claimed', agent: 'w1', taskId: 'nope' }))).toEqual({
      ok: false,
      reason: 'task_not_found',
      from: undefined,
    });
  });

  it('only the claimer may complete/block/release', () => {
    const log = [created('t1', 'a'), m({ type: 'task.claimed', agent: 'w1', taskId: 't1' })];
    const claimed = taskOf(log, 't1');
    for (const type of ['task.completed', 'task.blocked', 'task.released'] as const) {
      const extra = type === 'task.blocked' ? { reason: 'x' } : {};
      const wrong = classifyTransition(claimed, m({ type, agent: 'w2', taskId: 't1', ...extra }));
      expect(wrong).toEqual({ ok: false, reason: 'not_owner', from: 'claimed' });
      const right = classifyTransition(claimed, m({ type, agent: 'w1', taskId: 't1', ...extra }));
      expect(right).toEqual({ ok: true, changed: true });
    }
  });

  it('blocked task can be completed or released by owner, but not claimed by others', () => {
    const log = [
      created('t1', 'a'),
      m({ type: 'task.claimed', agent: 'w1', taskId: 't1' }),
      m({ type: 'task.blocked', agent: 'w1', taskId: 't1', reason: 'waiting' }),
    ];
    const blocked = taskOf(log, 't1')!;
    expect(blocked.state).toBe('blocked');
    expect(blocked.blockedReason).toBe('waiting');
    expect(classifyTransition(blocked, m({ type: 'task.claimed', agent: 'w2', taskId: 't1' }))).toMatchObject({
      ok: false,
      reason: 'not_open',
    });
    expect(classifyTransition(blocked, m({ type: 'task.completed', agent: 'w1', taskId: 't1' }))).toEqual({
      ok: true,
      changed: true,
    });
    expect(classifyTransition(blocked, m({ type: 'task.released', agent: 'w1', taskId: 't1' }))).toEqual({
      ok: true,
      changed: true,
    });
  });

  it('cancel only by creator, and not from terminal states', () => {
    const log = [created('t1', 'a')];
    const open = taskOf(log, 't1')!;
    expect(classifyTransition(open, m({ type: 'task.cancelled', agent: 'b', taskId: 't1' }))).toEqual({
      ok: false,
      reason: 'not_creator',
      from: 'open',
    });
    expect(classifyTransition(open, m({ type: 'task.cancelled', agent: 'a', taskId: 't1' }))).toEqual({
      ok: true,
      changed: true,
    });
    const done = taskOf(
      [created('t2', 'a'), m({ type: 'task.claimed', agent: 'a', taskId: 't2' }), m({ type: 'task.completed', agent: 'a', taskId: 't2' })],
      't2',
    )!;
    expect(classifyTransition(done, m({ type: 'task.cancelled', agent: 'a', taskId: 't2' }))).toEqual({
      ok: false,
      reason: 'invalid_state',
      from: 'done',
    });
  });

  it('communication messages never change state', () => {
    const log = [created('t1', 'a')];
    const open = taskOf(log, 't1');
    expect(classifyTransition(open, m({ type: 'status.update', agent: 'a', text: 'x', taskId: 't1' }))).toEqual({
      ok: true,
      changed: false,
    });
    expect(classifyTransition(open, m({ type: 'request.help', agent: 'a', text: 'x' }))).toEqual({
      ok: true,
      changed: false,
    });
  });
});

describe('fsm: reduce', () => {
  it('folds a scripted log into correct task states', () => {
    const log: Message[] = [
      created('t1', 'lead'),
      created('t2', 'lead'),
      created('t3', 'lead'),
      m({ type: 'task.claimed', agent: 'w1', taskId: 't1' }),
      m({ type: 'task.claimed', agent: 'w2', taskId: 't2' }),
      m({ type: 'task.completed', agent: 'w1', taskId: 't1', result: { ok: true } }),
      m({ type: 'task.blocked', agent: 'w2', taskId: 't2', reason: 'dep' }),
      m({ type: 'task.cancelled', agent: 'lead', taskId: 't3' }),
      m({ type: 'status.update', agent: 'w1', text: 'fyi' }),
    ];
    const tasks = reduce(log);
    expect(tasks.get('t1')).toMatchObject({ state: 'done', claimer: 'w1', result: { ok: true } });
    expect(tasks.get('t2')).toMatchObject({ state: 'blocked', claimer: 'w2', blockedReason: 'dep' });
    expect(tasks.get('t3')).toMatchObject({ state: 'cancelled', creator: 'lead' });
  });

  it('is order-independent of input array (sorts by seq) and skips illegal transitions', () => {
    const c = created('t1', 'a');
    const claim = m({ type: 'task.claimed', agent: 'w1', taskId: 't1' });
    const illegalClaim = m({ type: 'task.claimed', agent: 'w2', taskId: 't1' }); // not_open, skipped
    const done = m({ type: 'task.completed', agent: 'w1', taskId: 't1' });
    // shuffle input order; reduce must sort by seq
    const shuffled = [done, c, illegalClaim, claim];
    const t = reduce(shuffled).get('t1')!;
    expect(t.state).toBe('done');
    expect(t.claimer).toBe('w1');
  });

  it('release returns a task to open and clears the claimer', () => {
    const log = [
      created('t1', 'a'),
      m({ type: 'task.claimed', agent: 'w1', taskId: 't1' }),
      m({ type: 'task.released', agent: 'w1', taskId: 't1' }),
    ];
    const t = reduce(log).get('t1')!;
    expect(t.state).toBe('open');
    expect(t.claimer).toBeUndefined();
  });
});
