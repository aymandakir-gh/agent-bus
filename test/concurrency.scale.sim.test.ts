/**
 * Scaled concurrency simulation (PROTOCOL.md §6, G1/G2). Proves, with real OS
 * processes coordinating through one folder, that the bus upholds:
 *   - G1 total order: `seq` is exactly 1..N, gapless and unique;
 *   - G2 single claimer: every task is claimed at most once;
 *   - eventual completion: every task ends `done`, completed by its claimer.
 *
 * Run at scale (≥8 processes over ≥1000 tasks), repeated across several seeds,
 * AND shown to be *falsifiable*: the same machinery, run against a deliberately
 * broken (no-op) lock, fails. A test that cannot fail proves nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileBus } from '../src/core/file-bus';
import { brokenLockAcquirer } from './helpers/sim-support';
import { runMultiProcessSim, findInvariantViolations } from './helpers/sim-driver';

const WORKERS = 8;
const TASKS = 1000;
const SEEDS = [101, 202, 303]; // ≥3 distinct seeds

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-bus-scale-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('concurrency: scaled multi-process simulation', () => {
  it.each(SEEDS)(
    `%i agents=${WORKERS} tasks=${TASKS}: zero double-claims, gapless order, all done`,
    async (seed) => {
      const { messages, taskIds } = await runMultiProcessSim({
        dir,
        tasks: TASKS,
        workers: WORKERS,
        seed,
        chaosMs: 1, // widen the in-critical-section window to stress the lock
        retryMs: 4,
      });

      // G1 + G2.
      expect(findInvariantViolations(messages, taskIds)).toEqual([]);

      // Eventual completion: every task done, completed by its claimer.
      const reader = new FileBus({ dir });
      const tasks = await reader.getTasks();
      expect(tasks).toHaveLength(TASKS);
      expect(tasks.every((t) => t.state === 'done')).toBe(true);

      const claimerOf = new Map(
        messages
          .filter((m) => m.type === 'task.claimed')
          .map((m) => [(m as { taskId: string }).taskId, m.agent]),
      );
      const completes = messages.filter((m) => m.type === 'task.completed');
      expect(completes).toHaveLength(TASKS);
      for (const c of completes) {
        const id = (c as { taskId: string }).taskId;
        expect(c.agent, `task ${id} completed by its claimer`).toBe(claimerOf.get(id));
      }

      // Work was genuinely spread across the worker processes.
      expect(new Set(claimerOf.values()).size).toBeGreaterThan(1);
    },
    180_000,
  );
});

describe('concurrency: the lock is load-bearing (falsifiable)', () => {
  it('in-process — the real lock admits exactly one claimer', async () => {
    const lead = await FileBus.init(dir);
    await lead.createTask({ title: 'the one', agent: 'lead', taskId: 't1' });

    const N = 12;
    const claimers = Array.from(
      { length: N },
      () => new FileBus({ dir, criticalSectionDelayMs: 10 }), // chaos widens the window
    );
    await Promise.all(claimers.map((b, i) => b.claim('t1', `w${i}`)));

    const claims = (await lead.getMessages({ type: 'task.claimed', taskId: 't1' })).length;
    expect(claims, 'real lock: exactly one claim recorded').toBe(1);
    expect(findInvariantViolations(await lead.getMessages(), ['t1'])).toEqual([]);
  });

  it('in-process — a broken (no-op) lock admits double-claims that the checker catches', async () => {
    const lead = await FileBus.init(dir);
    await lead.createTask({ title: 'the one', agent: 'lead', taskId: 't1' });

    const N = 12;
    const claimers = Array.from(
      { length: N },
      () => new FileBus({ dir, criticalSectionDelayMs: 10, lockAcquirer: brokenLockAcquirer }),
    );
    await Promise.all(claimers.map((b, i) => b.claim('t1', `w${i}`)));

    const claims = (await lead.getMessages({ type: 'task.claimed', taskId: 't1' })).length;
    expect(claims, 'broken lock: multiple claims slip through').toBeGreaterThan(1);
    // The invariant checker the scaled sim relies on MUST flag this.
    const violations = findInvariantViolations(await lead.getMessages(), ['t1']);
    expect(violations.length, 'checker detects the broken-lock corruption').toBeGreaterThan(0);
  });

  it('multi-process — the same simulation FAILS on the broken lock', async () => {
    const { messages, taskIds } = await runMultiProcessSim({
      dir,
      tasks: 200,
      workers: WORKERS,
      seed: 1,
      chaosMs: 3,
      retryMs: 4,
      lockMode: 'broken',
      spawnTimeoutMs: 30_000,
    });
    const violations = findInvariantViolations(messages, taskIds);
    expect(
      violations.length,
      `expected the broken-lock run to violate G1/G2 but it looked clean (${messages.length} msgs)`,
    ).toBeGreaterThan(0);
  }, 60_000);
});
