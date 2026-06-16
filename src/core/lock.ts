/**
 * A bus-wide advisory lock for multiple uncoordinated OS processes, built on the
 * one filesystem primitive the OS makes atomic: exclusive file creation
 * (`open(..., "wx")` === `O_CREAT | O_EXCL`). Exactly one creator wins; everyone
 * else gets `EEXIST` and waits. Crashed holders are recovered (PROTOCOL.md §7).
 */
import { open, readFile, unlink, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

import { LockTimeoutError } from './errors';

export interface LockOptions {
  /** Give up acquiring after this long. */
  timeoutMs?: number;
  /** A lock older than this (and whose holder looks dead) may be stolen. */
  staleMs?: number;
  /** Base poll interval between acquire attempts. */
  retryMs?: number;
}

export interface LockHandle {
  release(): Promise<void>;
  /** True iff this handle still owns the lock (token still present on disk).
   *  Once a lock is stolen the token is gone forever, so `true` here means the
   *  lock has been held continuously since acquisition. */
  isOwned(): Promise<boolean>;
}

/** Signature of {@link acquireLock}. The `FileBus` accepts an injectable
 *  acquirer (advanced/testing seam) so the default — which upholds the
 *  single-writer, steal-only-on-process-death invariant — can be swapped, e.g.
 *  to prove with a deliberately-broken lock that the guarantee is load-bearing.
 *  Production always uses the default. */
export type AcquireLockFn = (lockPath: string, options?: LockOptions) => Promise<LockHandle>;

interface LockRecord {
  pid: number;
  host: string;
  ts: number;
  token: string;
}

const HOST = hostname();

const DEFAULTS = {
  timeoutMs: 10_000,
  staleMs: 30_000,
  retryMs: 25,
} satisfies Required<LockOptions>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH => no such process (dead). EPERM => exists but not ours (alive).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readRecord(lockPath: string): Promise<LockRecord | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const rec = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof rec.token === 'string' && typeof rec.pid === 'number') {
      return rec as LockRecord;
    }
  } catch {
    // Missing, unreadable, or malformed — treat as no usable record.
  }
  return undefined;
}

/** Returns true if a stale/dead lock was removed (so the caller should retry).
 *
 *  A **live, same-host holder is never stolen** — only liveness (`kill(pid, 0)`)
 *  decides, not wall-clock age. This is the crucial safety property: stealing a
 *  lock from a holder that is merely slow (a GC pause, swap, CPU starvation)
 *  would let two writers into the critical section and corrupt `seq`/claims.
 *  Age is used only where liveness is unknowable: a different host (best-effort,
 *  see PROTOCOL.md §7 on network filesystems) or an unreadable lock file. */
async function tryStealStale(lockPath: string, staleMs: number): Promise<boolean> {
  const rec = await readRecord(lockPath);
  let stale = false;
  if (!rec) {
    // Unreadable/garbage lock file: fall back to mtime age.
    try {
      const s = await stat(lockPath);
      stale = Date.now() - s.mtimeMs > staleMs;
    } catch {
      // Vanished between EEXIST and now — caller's retry will recreate it.
      return true;
    }
  } else if (rec.host === HOST) {
    // Same host: trust the process table. Steal only a provably dead holder,
    // regardless of age. A live holder is left alone.
    stale = !isAlive(rec.pid);
  } else {
    // Different host: liveness is unknowable here, so age is the only signal.
    stale = Date.now() - rec.ts > staleMs;
  }
  if (!stale) return false;
  try {
    await unlink(lockPath);
  } catch {
    // Someone else stole it first; that's fine.
  }
  return true;
}

/** Acquire the lock at `lockPath`, creating it atomically. Throws
 *  {@link LockTimeoutError} if it cannot be acquired within `timeoutMs`. */
export async function acquireLock(
  lockPath: string,
  options: LockOptions = {},
): Promise<LockHandle> {
  const { timeoutMs, staleMs, retryMs } = { ...DEFAULTS, ...options };
  const token = randomBytes(12).toString('hex');
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      const rec: LockRecord = { pid: process.pid, host: HOST, ts: Date.now(), token };
      await fh.writeFile(JSON.stringify(rec));
      await fh.close();
      return {
        release: () => releaseLock(lockPath, token),
        isOwned: () => isLockOwned(lockPath, token),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const stolen = await tryStealStale(lockPath, staleMs);
      if (!stolen) {
        if (Date.now() >= deadline) {
          throw new LockTimeoutError(
            `could not acquire lock ${lockPath} within ${timeoutMs}ms`,
          );
        }
        // Jittered backoff to avoid lockstep thundering herds.
        await sleep(retryMs + Math.floor(Math.random() * retryMs));
      }
      // else: retry create immediately after stealing a stale lock.
    }
  }
}

/** Whether the lock file still carries our token (i.e. we were not stolen). */
async function isLockOwned(lockPath: string, token: string): Promise<boolean> {
  const rec = await readRecord(lockPath);
  return rec?.token === token;
}

/** Release the lock only if we still own it (token match). Idempotent. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  const rec = await readRecord(lockPath);
  if (rec && rec.token !== token) {
    // We were stolen from (e.g. judged stale). Don't remove someone else's lock.
    return;
  }
  try {
    await unlink(lockPath);
  } catch {
    // Already gone.
  }
}

/** Run `fn` while holding the lock; always release, even on throw. */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  const handle = await acquireLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
