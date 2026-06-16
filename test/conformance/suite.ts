/**
 * The transport-conformance suite: one set of behavioural cases that ANY
 * `agent-bus/0` transport must pass. It is run against the file transport
 * (`file.test.ts`) and the HTTP transport (`http.test.ts`) from the *same*
 * source, so the two cannot drift. Adding a transport = passing this suite.
 *
 * Every assertion here exercises observable protocol behaviour (envelope
 * assignment, the task FSM, single-claimer, ordering, filters, subscriptions) —
 * not implementation details — so it is a fair bar for a client in any language.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import type { BusTransport, ClaimResult } from '../../src/core/transport';
import type { MessageType, TaskView } from '../../src/core/types';
import { MESSAGE_TYPES } from '../../src/core/types';
import { isValidMessage } from '../../src/core/validate';
import { taskSchema } from '../../src/core/schemas';
import {
  TransitionError,
  ValidationError,
  type TransitionReason,
} from '../../src/core/errors';

/** A fresh, empty transport plus the means to tear it down. */
export interface TransportHarness {
  transport: BusTransport;
  close(): Promise<void>;
}

export type MakeTransport = () => Promise<TransportHarness>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateTask = ajv.compile(taskSchema);

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Assert a promise rejects with a given error class (and optional props). */
async function rejects(
  p: Promise<unknown>,
  ErrClass: new (...a: never[]) => Error,
  props?: Record<string, unknown>,
): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e, `expected ${ErrClass.name}, got ${(e as Error)?.constructor?.name}`).toBeInstanceOf(
      ErrClass,
    );
    if (props) expect(e).toMatchObject(props);
    return;
  }
  throw new Error(`expected a rejection (${ErrClass.name}) but the call resolved`);
}

/** Subscribe, optionally trigger work, and resolve once `count` seqs arrive.
 *  Single-settle and a real (non-unref'd) deadline so a stuck stream fails fast
 *  rather than hanging to the test timeout. `after()` runs once the subscription
 *  has had a moment to establish (the SSE connect), so the case mirrors a
 *  real subscriber reacting to live traffic. */
function collectSeqs(
  t: BusTransport,
  opts: { fromSeq?: number; count: number; after?: () => Promise<void> },
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const got: number[] = [];
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.close();
      fn();
    };
    const sub = t.subscribe(
      (m) => {
        got.push(m.seq);
        if (got.length >= opts.count) finish(() => resolve(got.slice()));
      },
      { fromSeq: opts.fromSeq ?? 0, intervalMs: 20 },
    );
    const timer = setTimeout(
      () => finish(() => reject(new Error(`timed out: got ${got.length}/${opts.count} (${got.join(',')})`))),
      8_000,
    );
    if (opts.after) {
      setTimeout(() => {
        void opts.after!().catch((e: unknown) => finish(() => reject(e as Error)));
      }, 100);
    }
  });
}

/** Drive a task to `claimed` and return the claimer. */
async function claimed(t: BusTransport, taskId: string, creator = 'lead', claimer = 'w1'): Promise<void> {
  await t.createTask({ title: taskId, agent: creator, taskId });
  const r = await t.claim(taskId, claimer);
  expect(r.ok, `claim of ${taskId} should win`).toBe(true);
}

export function defineConformanceSuite(name: string, make: MakeTransport): void {
  describe(`transport conformance: ${name}`, () => {
    let t: BusTransport;
    let close: () => Promise<void>;

    beforeEach(async () => {
      ({ transport: t, close } = await make());
    });
    afterEach(async () => {
      await close();
    });

    // ---- identity ----------------------------------------------------------
    describe('identity', () => {
      it('reports protocol agent-bus/0 and a semver spec version', async () => {
        const meta = await t.readMeta();
        expect(meta?.protocol).toBe('agent-bus/0');
        expect(meta?.version).toMatch(/^\d+\.\d+\.\d+$/);
      });
    });

    // ---- envelope assignment ----------------------------------------------
    describe('envelope assignment', () => {
      it('assigns a non-empty id when the client omits one', async () => {
        const m = await t.post({ type: 'status.update', agent: 'a', text: 'hi' });
        expect(typeof m.id).toBe('string');
        expect(m.id.length).toBeGreaterThan(0);
      });

      it('preserves a client-supplied id', async () => {
        const m = await t.post({ type: 'status.update', agent: 'a', text: 'hi', id: 'my-id' });
        expect(m.id).toBe('my-id');
      });

      it('assigns gapless seq starting at 1', async () => {
        const seqs: number[] = [];
        for (let i = 0; i < 5; i++) {
          seqs.push((await t.post({ type: 'status.update', agent: 'a', text: `m${i}` })).seq);
        }
        expect(seqs).toEqual([1, 2, 3, 4, 5]);
      });

      it('assigns ts as an RFC3339 UTC instant', async () => {
        const m = await t.post({ type: 'status.update', agent: 'a', text: 'hi' });
        expect(m.ts).toMatch(RFC3339);
        expect(Number.isNaN(Date.parse(m.ts))).toBe(false);
      });

      it('never lets a client set seq or ts (input schema rejects them)', async () => {
        await rejects(
          t.post({ type: 'status.update', agent: 'a', text: 'x', seq: 9 } as never),
          ValidationError,
        );
        await rejects(
          t.post({ type: 'status.update', agent: 'a', text: 'x', ts: '2020-01-01T00:00:00Z' } as never),
          ValidationError,
        );
      });
    });

    // ---- schema conformance of emitted messages ----------------------------
    describe('schema conformance', () => {
      it('every emitted message validates against the published message schema', async () => {
        await t.createTask({ title: 'A', agent: 'lead', taskId: 'a' });
        await t.claim('a', 'w1');
        await t.complete('a', 'w1', { ok: true });

        await t.createTask({ title: 'B', agent: 'lead', taskId: 'b' });
        await t.claim('b', 'w1');
        await t.block('b', 'w1', 'stuck');
        await t.release('b', 'w1');

        await t.createTask({ title: 'C', agent: 'lead', taskId: 'c' });
        await t.cancel('c', 'lead');

        await t.post({ type: 'status.update', agent: 'a', text: 'note' });
        await t.post({ type: 'request.help', agent: 'a', text: 'help', severity: 'high' });

        const msgs = await t.getMessages();
        for (const m of msgs) {
          expect(isValidMessage(m), `invalid emitted message: ${JSON.stringify(m)}`).toBe(true);
        }
        // All eight message types are exercised by this lifecycle.
        const types = new Set(msgs.map((m) => m.type));
        for (const ty of MESSAGE_TYPES as readonly MessageType[]) {
          expect(types.has(ty), `type ${ty} not exercised`).toBe(true);
        }
      });
    });

    // ---- idempotency -------------------------------------------------------
    describe('idempotency', () => {
      it('re-posting the same id returns the existing record and adds nothing', async () => {
        const a = await t.post({ type: 'status.update', agent: 'a', text: 'once', id: 'fixed' });
        const b = await t.post({ type: 'status.update', agent: 'a', text: 'twice', id: 'fixed' });
        expect(b.seq).toBe(a.seq);
        expect((b as { text: string }).text).toBe('once');
        expect(await t.getMessages()).toHaveLength(1);
      });

      it('a claim retried with a stable id is a no-op success, not a lost race', async () => {
        await t.createTask({ title: 'X', agent: 'lead', taskId: 't1' });
        const first = await t.claim('t1', 'w1', { id: 'claim-key' });
        const retry = await t.claim('t1', 'w1', { id: 'claim-key' });
        expect(first.ok).toBe(true);
        expect(retry.ok).toBe(true);
      });
    });

    // ---- input validation --------------------------------------------------
    describe('input validation', () => {
      it('rejects a message missing a required field', async () => {
        await rejects(
          t.post({ type: 'task.created', agent: 'a', taskId: 't1' } as never),
          ValidationError,
        );
        expect(await t.getMessages()).toHaveLength(0);
      });

      it('rejects an unknown top-level field', async () => {
        await rejects(
          t.post({ type: 'status.update', agent: 'a', text: 'x', foo: 1 } as never),
          ValidationError,
        );
      });

      it('rejects a bad enum value', async () => {
        await rejects(
          t.post({ type: 'task.created', agent: 'a', taskId: 't1', title: 'x', priority: 'urgent' } as never),
          ValidationError,
        );
      });

      it('rejects an empty agent id', async () => {
        await rejects(t.post({ type: 'status.update', agent: '', text: 'x' } as never), ValidationError);
      });
    });

    // ---- task FSM: legal transitions --------------------------------------
    describe('task FSM — legal transitions', () => {
      it('createTask yields an open task owned by its creator', async () => {
        const msg = await t.createTask({ title: 'Build', agent: 'lead', taskId: 't1', priority: 'high' });
        expect(msg.type).toBe('task.created');
        const task = await t.getTask('t1');
        expect(task).toMatchObject({ id: 't1', state: 'open', creator: 'lead', priority: 'high' });
      });

      it('claim moves open → claimed and records the claimer', async () => {
        await t.createTask({ title: 'X', agent: 'lead', taskId: 't1' });
        const r = await t.claim('t1', 'w1');
        expect(r.ok).toBe(true);
        expect(await t.getTask('t1')).toMatchObject({ state: 'claimed', claimer: 'w1' });
      });

      it('complete moves claimed → done and stores the result', async () => {
        await claimed(t, 't1');
        await t.complete('t1', 'w1', { artifact: 42 });
        expect(await t.getTask('t1')).toMatchObject({ state: 'done', result: { artifact: 42 } });
      });

      it('block moves claimed → blocked and records the reason', async () => {
        await claimed(t, 't1');
        await t.block('t1', 'w1', 'waiting on dep');
        expect(await t.getTask('t1')).toMatchObject({ state: 'blocked', blockedReason: 'waiting on dep' });
      });

      it('release moves claimed → open and clears the claimer', async () => {
        await claimed(t, 't1');
        await t.release('t1', 'w1');
        const task = await t.getTask('t1');
        expect(task?.state).toBe('open');
        expect(task?.claimer).toBeUndefined();
      });

      it('cancel moves open → cancelled', async () => {
        await t.createTask({ title: 'X', agent: 'lead', taskId: 't1' });
        await t.cancel('t1', 'lead');
        expect(await t.getTask('t1')).toMatchObject({ state: 'cancelled' });
      });

      it('a blocked task can be completed by its owner', async () => {
        await claimed(t, 't1');
        await t.block('t1', 'w1', 'stuck');
        await t.complete('t1', 'w1', 'done anyway');
        expect(await t.getTask('t1')).toMatchObject({ state: 'done' });
      });

      it('a blocked task can be released back to open', async () => {
        await claimed(t, 't1');
        await t.block('t1', 'w1', 'stuck');
        await t.release('t1', 'w1');
        expect(await t.getTask('t1')).toMatchObject({ state: 'open' });
      });

      it('a released task can be re-claimed by a different agent', async () => {
        await claimed(t, 't1');
        await t.release('t1', 'w1');
        const r = await t.claim('t1', 'w2');
        expect(r.ok).toBe(true);
        expect(await t.getTask('t1')).toMatchObject({ state: 'claimed', claimer: 'w2' });
      });
    });

    // ---- task FSM: rejections & reason codes ------------------------------
    describe('task FSM — rejections', () => {
      it('creating a duplicate taskId is rejected with task_exists', async () => {
        await t.createTask({ title: 'X', agent: 'lead', taskId: 't1' });
        await rejects(t.createTask({ title: 'Y', agent: 'lead', taskId: 't1' }), TransitionError, {
          reason: 'task_exists',
        });
      });

      it('claiming a missing task reports task_not_found', async () => {
        const r = await t.claim('nope', 'w1');
        expect(r.ok).toBe(false);
        expect((r as Extract<ClaimResult, { ok: false }>).reason).toBe('task_not_found');
      });

      it('claiming an already-claimed task reports not_open', async () => {
        await claimed(t, 't1');
        const r = await t.claim('t1', 'w2');
        expect(r.ok).toBe(false);
        expect((r as Extract<ClaimResult, { ok: false }>).reason).toBe('not_open');
      });

      it('completing as a non-owner is rejected with not_owner', async () => {
        await claimed(t, 't1');
        await rejects(t.complete('t1', 'someone-else'), TransitionError, { reason: 'not_owner' });
      });

      it('completing an open (unclaimed) task is rejected with invalid_state', async () => {
        await t.createTask({ title: 'X', agent: 'lead', taskId: 't1' });
        await rejects(t.complete('t1', 'w1'), TransitionError, { reason: 'invalid_state' });
      });

      it('blocking as a non-owner is rejected with not_owner', async () => {
        await claimed(t, 't1');
        await rejects(t.block('t1', 'intruder', 'because'), TransitionError, { reason: 'not_owner' });
      });

      it('releasing as a non-owner is rejected with not_owner', async () => {
        await claimed(t, 't1');
        await rejects(t.release('t1', 'intruder'), TransitionError, { reason: 'not_owner' });
      });

      it('cancelling as a non-creator is rejected with not_creator', async () => {
        await t.createTask({ title: 'X', agent: 'lead', taskId: 't1' });
        await rejects(t.cancel('t1', 'not-lead'), TransitionError, { reason: 'not_creator' });
      });

      it('cancelling a terminal (done) task is rejected with invalid_state', async () => {
        await claimed(t, 't1');
        await t.complete('t1', 'w1');
        await rejects(t.cancel('t1', 'lead'), TransitionError, { reason: 'invalid_state' });
      });

      it('completing a missing task reports task_not_found', async () => {
        await rejects(t.complete('ghost', 'w1'), TransitionError, { reason: 'task_not_found' });
      });
    });

    // ---- single claimer & total order -------------------------------------
    describe('concurrency guarantees', () => {
      it('exactly one of N concurrent claims on one task wins', async () => {
        await t.createTask({ title: 'one', agent: 'lead', taskId: 't1' });
        const N = 12;
        const results = await Promise.all(
          Array.from({ length: N }, (_, i) => t.claim('t1', `w${i}`)),
        );
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(
          results.filter((r) => !r.ok).every((r) => (r as Extract<ClaimResult, { ok: false }>).reason === 'not_open'),
        ).toBe(true);
        expect(await t.getTask('t1')).toMatchObject({ state: 'claimed' });
      });

      it('concurrent posts receive unique, gapless seq', async () => {
        const N = 15;
        await Promise.all(
          Array.from({ length: N }, (_, i) => t.post({ type: 'status.update', agent: 'a', text: `m${i}` })),
        );
        const msgs = await t.getMessages();
        expect(msgs.map((m) => m.seq).sort((a, b) => a - b)).toEqual(
          Array.from({ length: N }, (_, i) => i + 1),
        );
        expect(new Set(msgs.map((m) => m.id)).size).toBe(N);
      });
    });

    // ---- reads & filters ---------------------------------------------------
    describe('reads & filters', () => {
      async function seed(): Promise<void> {
        await t.createTask({ title: 'A', agent: 'lead', taskId: 't1' });
        await t.createTask({ title: 'B', agent: 'lead', taskId: 't2' });
        await t.post({ type: 'status.update', agent: 'w1', text: 'on it', taskId: 't1' });
      }

      it('filters messages by type', async () => {
        await seed();
        expect((await t.getMessages({ type: 'task.created' })).length).toBe(2);
        expect((await t.getMessages({ type: 'status.update' })).length).toBe(1);
      });

      it('filters messages by taskId (including references)', async () => {
        await seed();
        const m = await t.getMessages({ taskId: 't1' });
        expect(m.length).toBe(2); // task.created t1 + the status.update referencing t1
      });

      it('filters messages by agent', async () => {
        await seed();
        expect((await t.getMessages({ agent: 'w1' })).length).toBe(1);
        expect((await t.getMessages({ agent: 'lead' })).length).toBe(2);
      });

      it('filters messages by fromSeq', async () => {
        await seed();
        expect((await t.getMessages({ fromSeq: 2 })).map((m) => m.seq)).toEqual([3]);
      });

      it('limits to the latest N messages', async () => {
        await seed();
        expect((await t.getMessages({ limit: 1 })).map((m) => m.seq)).toEqual([3]);
      });

      it('filters tasks by state', async () => {
        await seed();
        await t.claim('t1', 'w1');
        expect((await t.getTasks({ state: 'open' })).map((x) => x.id)).toEqual(['t2']);
        expect((await t.getTasks({ state: 'claimed' })).map((x) => x.id)).toEqual(['t1']);
      });

      it('getTask returns undefined for a missing task', async () => {
        expect(await t.getTask('missing')).toBeUndefined();
      });
    });

    // ---- derived task view -------------------------------------------------
    describe('derived task view', () => {
      it('advances updatedSeq/updatedAt as the task changes', async () => {
        await t.createTask({ title: 'X', agent: 'lead', taskId: 't1' });
        const open = (await t.getTask('t1')) as TaskView;
        expect(open.createdSeq).toBe(open.updatedSeq);
        await t.claim('t1', 'w1');
        const claimedView = (await t.getTask('t1')) as TaskView;
        expect(claimedView.updatedSeq).toBeGreaterThan(open.updatedSeq);
        expect(claimedView.createdSeq).toBe(open.createdSeq);
      });

      it('a task view conforms to the published task schema', async () => {
        await t.createTask({
          title: 'Full',
          agent: 'lead',
          taskId: 't1',
          description: 'desc',
          priority: 'high',
          tags: ['x', 'y'],
        });
        await t.claim('t1', 'w1');
        const task = await t.getTask('t1');
        // Validate the JSON wire shape (undefined optional fields are absent).
        const wire = JSON.parse(JSON.stringify(task));
        expect(validateTask(wire), JSON.stringify(validateTask.errors)).toBe(true);
      });
    });

    // ---- subscriptions -----------------------------------------------------
    describe('subscriptions', () => {
      it('replays history in seq order from the beginning', async () => {
        await t.post({ type: 'status.update', agent: 'a', text: '1' });
        await t.post({ type: 'status.update', agent: 'a', text: '2' });
        await t.post({ type: 'status.update', agent: 'a', text: '3' });
        const got = await collectSeqs(t, { fromSeq: 0, count: 3 });
        expect(got).toEqual([1, 2, 3]);
      });

      it('delivers only messages after the cursor, in order', async () => {
        await t.post({ type: 'status.update', agent: 'a', text: 'old1' });
        await t.post({ type: 'status.update', agent: 'a', text: 'old2' });
        const got = await collectSeqs(t, {
          fromSeq: 2,
          count: 2,
          after: async () => {
            await t.post({ type: 'status.update', agent: 'a', text: 'new1' });
            await t.post({ type: 'status.update', agent: 'a', text: 'new2' });
          },
        });
        expect(got).toEqual([3, 4]);
      });

      it('stops delivering after the subscription is closed', async () => {
        const seen: number[] = [];
        const sub = t.subscribe((m) => void seen.push(m.seq), { fromSeq: 0, intervalMs: 20 });
        await t.post({ type: 'status.update', agent: 'a', text: 'one' });
        // Give the subscription time to deliver the first message.
        await new Promise((r) => setTimeout(r, 150));
        sub.close();
        const afterClose = seen.length;
        await t.post({ type: 'status.update', agent: 'a', text: 'two' });
        await new Promise((r) => setTimeout(r, 150));
        expect(seen.length).toBe(afterClose); // nothing delivered post-close
      });
    });
  });
}

export type { TransitionReason };
