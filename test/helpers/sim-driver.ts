/**
 * Orchestrates a multi-process concurrency simulation: create N tasks, spawn K
 * worker OS processes that drain them over one shared folder, wait, then read
 * the resulting log back. Parameterized by seed and lock mode so the same
 * harness can be run reproducibly across seeds and against a broken lock.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { FileBus } from '../../src/core/file-bus';
import type { Message } from '../../src/core/types';
import type { LockMode } from './sim-support';

const WORKER = join(process.cwd(), 'test', 'helpers', 'sim-worker.ts');

export interface SimOptions {
  dir: string;
  tasks: number;
  workers: number;
  seed: number;
  chaosMs?: number;
  lockMode?: LockMode;
  retryMs?: number;
  lockTimeoutMs?: number;
  /** Hard kill a worker that hasn't exited in this long (default 120s). */
  spawnTimeoutMs?: number;
}

export interface SimResult {
  messages: Message[];
  taskIds: string[];
}

function spawnWorker(opts: SimOptions, agent: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, opts.dir, agent], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_BUS_CHAOS: String(opts.chaosMs ?? 0),
        AGENT_BUS_SEED: String(opts.seed),
        AGENT_BUS_LOCK_MODE: opts.lockMode ?? 'safe',
        AGENT_BUS_RETRY_MS: String(opts.retryMs ?? 25),
        AGENT_BUS_LOCK_TIMEOUT_MS: String(opts.lockTimeoutMs ?? 60_000),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += String(d)));
    const killTimer = setTimeout(() => child.kill('SIGKILL'), opts.spawnTimeoutMs ?? 120_000);
    killTimer.unref?.();
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      // A broken-lock run may exit non-zero (crashed on corrupted state) or be
      // killed; we still want to inspect the log it left behind, so resolve.
      if (code === 0 || opts.lockMode === 'broken') resolve();
      else reject(new Error(`worker ${agent} exited ${code}: ${err}`));
    });
  });
}

/** Run the simulation and return the full message log plus the task ids posted. */
export async function runMultiProcessSim(opts: SimOptions): Promise<SimResult> {
  const lead = await FileBus.init(opts.dir);
  const taskIds = Array.from({ length: opts.tasks }, (_, i) => `t${i}`);
  for (const id of taskIds) {
    await lead.createTask({ title: `task ${id}`, agent: 'lead', taskId: id });
  }

  const agents = Array.from({ length: opts.workers }, (_, i) => `agent-${i}`);
  await Promise.all(agents.map((a) => spawnWorker(opts, a)));

  // Read with a fresh instance so we see the on-disk truth, not a warm cache.
  const reader = new FileBus({ dir: opts.dir });
  const messages = await reader.getMessages();
  return { messages, taskIds };
}

/**
 * Check the core invariants on a finished simulation log. Returns a list of
 * violation descriptions — empty means the run upheld G1 (total order) and G2
 * (single claimer). The safe simulation asserts this is empty; the broken-lock
 * variant asserts it is NOT (proving the simulation is a real falsifier).
 */
export function findInvariantViolations(messages: Message[], taskIds: string[]): string[] {
  const v: string[] = [];
  const seqs = messages.map((m) => m.seq).sort((a, b) => a - b);

  // G1: seq is exactly 1..N, gapless, unique.
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i + 1) {
      v.push(`seq not gapless: expected ${i + 1} at position ${i}, got ${seqs[i]}`);
      break;
    }
  }
  if (new Set(seqs).size !== seqs.length) v.push('duplicate seq values present');
  if (new Set(messages.map((m) => m.id)).size !== messages.length) v.push('duplicate message ids');

  // G2: each task claimed at most once.
  const claimsByTask = new Map<string, number>();
  for (const m of messages) {
    if (m.type !== 'task.claimed') continue;
    const id = (m as { taskId: string }).taskId;
    claimsByTask.set(id, (claimsByTask.get(id) ?? 0) + 1);
  }
  for (const [id, n] of claimsByTask) {
    if (n > 1) v.push(`task ${id} claimed ${n} times (double-claim)`);
  }
  // Total number of claims must not exceed the number of tasks.
  const totalClaims = [...claimsByTask.values()].reduce((a, b) => a + b, 0);
  if (totalClaims > taskIds.length) v.push(`${totalClaims} claims for ${taskIds.length} tasks`);

  return v;
}
