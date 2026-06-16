import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileBus } from '../src/core/file-bus';
import { ValidationError } from '../src/core/errors';

let dir: string;
let bus: FileBus;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-bus-fb-'));
  bus = await FileBus.init(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileBus: init & meta', () => {
  it('creates log + meta and is idempotent', async () => {
    const meta = await bus.readMeta();
    expect(meta?.protocol).toBe('agent-bus/0');
    const files = await readdir(dir);
    expect(files).toContain('log.jsonl');
    expect(files).toContain('meta.json');

    // Re-init must not clobber existing data.
    await bus.createTask({ title: 'keep me', agent: 'a', taskId: 't1' });
    await FileBus.init(dir);
    expect(await bus.getTask('t1')).toBeDefined();
  });
});

describe('FileBus: post & read', () => {
  it('assigns gapless, strictly-increasing seq starting at 1', async () => {
    for (let i = 0; i < 5; i++) {
      await bus.post({ type: 'status.update', agent: 'a', text: `m${i}` });
    }
    const msgs = await bus.getMessages();
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(msgs.every((m, i) => (i === 0 ? true : m.seq === msgs[i - 1]!.seq + 1))).toBe(true);
  });

  it('round-trips a task lifecycle and derives the task view', async () => {
    await bus.createTask({ title: 'Build it', agent: 'lead', taskId: 't1', priority: 'high' });
    expect((await bus.getTask('t1'))?.state).toBe('open');

    const claim = await bus.claim('t1', 'w1');
    expect(claim.ok).toBe(true);
    expect((await bus.getTask('t1'))?.state).toBe('claimed');

    await bus.complete('t1', 'w1', { artifact: 'x' });
    const t = await bus.getTask('t1');
    expect(t?.state).toBe('done');
    expect(t?.result).toEqual({ artifact: 'x' });
    expect(t?.priority).toBe('high');
  });

  it('rejects invalid input before writing anything', async () => {
    await expect(
      // missing required title
      bus.post({ type: 'task.created', agent: 'a', taskId: 't1' } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await bus.getMessages()).toHaveLength(0);
  });

  it('filters messages by type, task, agent, fromSeq, limit', async () => {
    await bus.createTask({ title: 'A', agent: 'lead', taskId: 't1' });
    await bus.createTask({ title: 'B', agent: 'lead', taskId: 't2' });
    await bus.post({ type: 'status.update', agent: 'w1', text: 'hi', taskId: 't1' });

    expect((await bus.getMessages({ type: 'task.created' })).length).toBe(2);
    expect((await bus.getMessages({ taskId: 't1' })).length).toBe(2);
    expect((await bus.getMessages({ agent: 'w1' })).length).toBe(1);
    expect((await bus.getMessages({ fromSeq: 2 })).map((m) => m.seq)).toEqual([3]);
    expect((await bus.getMessages({ limit: 1 })).map((m) => m.seq)).toEqual([3]);
  });
});

describe('FileBus: single-claimer', () => {
  it('a second claim on a claimed task fails with not_open', async () => {
    await bus.createTask({ title: 'T', agent: 'lead', taskId: 't1' });
    const first = await bus.claim('t1', 'w1');
    const second = await bus.claim('t1', 'w2');
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: 'not_open' });
    expect((await bus.getTask('t1'))?.claimer).toBe('w1');
  });
});

describe('FileBus: idempotency', () => {
  it('re-posting the same id is a no-op returning the existing record', async () => {
    const a = await bus.post({ type: 'status.update', agent: 'a', text: 'once', id: 'fixed-id' });
    const b = await bus.post({ type: 'status.update', agent: 'a', text: 'twice', id: 'fixed-id' });
    expect(b.seq).toBe(a.seq);
    expect((b as { text: string }).text).toBe('once');
    const msgs = await bus.getMessages();
    expect(msgs).toHaveLength(1);
  });
});

describe('FileBus: durability', () => {
  it('skips a corrupt/partial trailing line and repairs on next append', async () => {
    await bus.post({ type: 'status.update', agent: 'a', text: 'good' });
    // Simulate a writer that crashed mid-append (partial line, no newline).
    await appendFile(bus.logPath, '{"id":"partial","seq":99', 'utf8');

    // Reads skip the partial line.
    expect(await bus.getMessages()).toHaveLength(1);

    // Next post repairs and appends cleanly with the correct next seq.
    const next = await bus.post({ type: 'status.update', agent: 'a', text: 'after' });
    expect(next.seq).toBe(2);
    const msgs = await bus.getMessages();
    expect(msgs.map((m) => m.seq)).toEqual([1, 2]);

    const raw = await readFile(bus.logPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });
});

describe('FileBus: incremental reads', () => {
  it('a separate instance sees appends incrementally (byte-cursor delta reads)', async () => {
    const reader = new FileBus({ dir });
    await bus.post({ type: 'status.update', agent: 'a', text: '1' });
    expect((await reader.getMessages()).map((m) => m.seq)).toEqual([1]);

    await bus.post({ type: 'status.update', agent: 'a', text: '2' });
    await bus.post({ type: 'status.update', agent: 'a', text: '3' });
    // The reader only parses the newly-appended bytes, not the whole log.
    expect((await reader.getMessages()).map((m) => m.seq)).toEqual([1, 2, 3]);

    await bus.createTask({ title: 'X', agent: 'lead', taskId: 't1' });
    await bus.claim('t1', 'w1');
    expect((await reader.getTask('t1'))?.state).toBe('claimed'); // folded state advances too
  });

  it('returns a stable view when nothing new has been appended', async () => {
    await bus.post({ type: 'status.update', agent: 'a', text: '1' });
    const first = await bus.getMessages();
    const second = await bus.getMessages(); // no new bytes ⇒ same content
    expect(second.map((m) => m.seq)).toEqual(first.map((m) => m.seq));
  });

  it('skips a structurally-valid line with an unknown message type (no crash)', async () => {
    await bus.post({ type: 'status.update', agent: 'a', text: 'ok' }); // seq 1
    // A corrupt or forward-compatible line: valid envelope shape, unknown type.
    const bad =
      JSON.stringify({
        id: 'x',
        seq: 2,
        ts: new Date().toISOString(),
        type: 'totally.unknown',
        agent: 'z',
        taskId: 't',
      }) + '\n';
    await appendFile(bus.logPath, bad, 'utf8');

    // Reads must not throw; the unknown-type line is skipped like corrupt JSON.
    const msgs = await bus.getMessages();
    expect(msgs.map((m) => m.type)).toEqual(['status.update']);
    expect(await bus.getTasks()).toEqual([]);

    // The bus keeps working afterward.
    const next = await bus.post({ type: 'status.update', agent: 'a', text: 'after' });
    expect(next.seq).toBe(2);
  });

  it('defensively rebuilds if the log is truncated/replaced underneath it', async () => {
    await bus.post({ type: 'status.update', agent: 'a', text: '1' });
    await bus.post({ type: 'status.update', agent: 'a', text: '2' });
    expect(await bus.getMessages()).toHaveLength(2); // advances the byte cursor

    // Replace the log with a strictly shorter one (size < cached offset).
    const line =
      JSON.stringify({
        id: 'x',
        seq: 1,
        ts: new Date().toISOString(),
        type: 'status.update',
        agent: 'z',
        text: 'only',
      }) + '\n';
    await writeFile(bus.logPath, line);

    const msgs = await bus.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.agent).toBe('z');
  });
});

describe('FileBus: subscriptions', () => {
  it('delivers messages with seq above the cursor, in order', async () => {
    await bus.post({ type: 'status.update', agent: 'a', text: 'pre' }); // seq 1
    const received: number[] = [];
    const done = new Promise<void>((resolve) => {
      const sub = bus.subscribe(
        (m) => {
          received.push(m.seq);
          if (received.length >= 3) {
            sub.close();
            resolve();
          }
        },
        { fromSeq: 1, intervalMs: 20 },
      );
    });

    await bus.post({ type: 'status.update', agent: 'a', text: 'a' }); // 2
    await bus.post({ type: 'status.update', agent: 'a', text: 'b' }); // 3
    await bus.post({ type: 'status.update', agent: 'a', text: 'c' }); // 4

    await done;
    expect(received).toEqual([2, 3, 4]);
  });

  it('retries delivery when the handler throws (at-least-once)', async () => {
    await bus.post({ type: 'status.update', agent: 'a', text: 'm1' }); // seq 1
    const seen: number[] = [];
    let failedOnce = false;
    await new Promise<void>((resolve) => {
      const sub = bus.subscribe(
        (m) => {
          if (m.seq === 1 && !failedOnce) {
            failedOnce = true;
            throw new Error('transient handler failure');
          }
          seen.push(m.seq);
          sub.close();
          resolve();
        },
        { fromSeq: 0, intervalMs: 20 },
      );
    });
    // The message that threw is redelivered rather than skipped.
    expect(seen).toEqual([1]);
    expect(failedOnce).toBe(true);
  });
});
