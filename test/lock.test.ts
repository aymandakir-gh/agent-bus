import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { acquireLock, withLock } from '../src/core/lock';
import { LockTimeoutError } from '../src/core/errors';

let dir: string;
let lockPath: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-bus-lock-'));
  lockPath = join(dir, 'lock');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('lock: mutual exclusion', () => {
  it('serializes concurrent read-modify-write with no lost updates', async () => {
    const counterPath = join(dir, 'counter');
    await writeFile(counterPath, '0');
    const N = 40;
    let inside = 0;
    let maxInside = 0;

    await Promise.all(
      Array.from({ length: N }, () =>
        withLock(lockPath, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          const v = Number(await readFile(counterPath, 'utf8'));
          await sleep(1); // widen the critical window
          await writeFile(counterPath, String(v + 1));
          inside -= 1;
        }),
      ),
    );

    expect(Number(await readFile(counterPath, 'utf8'))).toBe(N); // no lost updates
    expect(maxInside).toBe(1); // never two holders at once
  });
});

describe('lock: stale recovery', () => {
  it('steals a lock whose holder process is dead (same host)', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2147483600, host: hostname(), ts: Date.now(), token: 'dead' }),
    );
    const h = await acquireLock(lockPath, { timeoutMs: 2000 });
    await h.release();
  });

  it('does NOT steal a live same-host holder, even an old one', async () => {
    // Stealing a live (merely slow) holder would let two writers into the
    // critical section. process.pid is alive by definition, so this must time out.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() - 60_000, token: 'live' }),
    );
    await expect(
      acquireLock(lockPath, { staleMs: 1, timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it('steals a stale lock from a different host by age (liveness unknowable)', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: 'some-other-host', ts: Date.now() - 5000, token: 'remote' }),
    );
    const h = await acquireLock(lockPath, { staleMs: 100, timeoutMs: 2000 });
    await h.release();
  });

  it('steals a garbage lock file by mtime', async () => {
    await writeFile(lockPath, 'not json at all');
    // staleMs 0 => any age qualifies as stale
    const h = await acquireLock(lockPath, { staleMs: 0, timeoutMs: 2000 });
    await h.release();
  });
});

describe('lock: contention & cleanup', () => {
  it('times out when the lock is genuinely held', async () => {
    const h = await acquireLock(lockPath);
    await expect(
      acquireLock(lockPath, { timeoutMs: 150, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    await h.release();
  });

  it('releases the lock even when the body throws', async () => {
    await expect(
      withLock(lockPath, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // If released, this acquires immediately.
    const h = await acquireLock(lockPath, { timeoutMs: 500, staleMs: 60_000 });
    await h.release();
  });

  it('isOwned reflects whether our token is still present', async () => {
    const h = await acquireLock(lockPath);
    expect(await h.isOwned()).toBe(true);
    // Simulate being stolen: a different token now holds the lock.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now(), token: 'thief' }),
    );
    expect(await h.isOwned()).toBe(false);
    await h.release();
  });

  it('does not remove a lock it no longer owns (token check)', async () => {
    const h = await acquireLock(lockPath);
    // Simulate being stolen: overwrite with a different token.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now(), token: 'someone-else' }),
    );
    await h.release(); // should be a no-op (not our token)
    const rec = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(rec.token).toBe('someone-else'); // still present
  });
});
