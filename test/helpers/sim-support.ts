/**
 * Shared support for the concurrency simulations: a seedable PRNG (so runs are
 * reproducible across seeds) and a deliberately-broken lock acquirer used ONLY
 * to prove the real lock is load-bearing. The broken acquirer lives in test code
 * and is never referenced by `src/` — production always uses the real lock.
 */
import type { AcquireLockFn, LockHandle } from '../../src/core/lock';

/** mulberry32 — a tiny, fast, deterministic PRNG. Same seed ⇒ same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A NO-OP lock: every caller "acquires" instantly and believes it owns the lock,
 * so there is no mutual exclusion at all. Dropping the real `O_EXCL` lock lets
 * multiple writers into the critical section simultaneously — they read the same
 * tail, assign the same `seq`, and both pass FSM checks — producing duplicate
 * `seq`, gaps, and double-claims. The simulation MUST detect these; that is the
 * proof the simulation is a real falsifier, not a vacuous one.
 */
export const brokenLockAcquirer: AcquireLockFn = async (): Promise<LockHandle> => ({
  release: async () => {},
  isOwned: async () => true, // always "owned" so post()'s steal re-check can't save it
});

export type LockMode = 'safe' | 'broken';
