import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { startServer } from '../src/http/server';
import { FileBus } from '../src/core/file-bus';

let dir: string;
let app: FastifyInstance;
let url: string;
let bus: FileBus;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-bus-http-'));
  ({ app, url, bus } = await startServer({ dir, port: 0 }));
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('http: health & meta', () => {
  it('reports protocol identity', async () => {
    const res = await fetch(url + '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, protocol: 'agent-bus/0' });

    const meta = (await (await fetch(url + '/meta')).json()) as { protocol: string };
    expect(meta.protocol).toBe('agent-bus/0');
  });
});

describe('http: messages & tasks mirror the core', () => {
  it('creates, lists, claims, completes', async () => {
    const created = await post('/tasks', { title: 'Build', agent: 'lead', taskId: 't1' });
    expect(created.status).toBe(201);

    const tasks = (await (await fetch(url + '/tasks')).json()) as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 't1', state: 'open' });

    const claim = await post('/tasks/t1/claim', { agent: 'w1' });
    expect(claim.status).toBe(201);
    expect(await claim.json()).toMatchObject({ ok: true });

    const complete = await post('/tasks/t1/complete', { agent: 'w1', result: { ok: true } });
    expect(complete.status).toBe(201);

    const one = await (await fetch(url + '/tasks/t1')).json();
    expect(one).toMatchObject({ state: 'done', result: { ok: true } });
  });

  it('posts arbitrary messages and filters them', async () => {
    await post('/messages', { type: 'task.created', agent: 'lead', taskId: 't1', title: 'X' });
    await post('/messages', { type: 'status.update', agent: 'w1', text: 'hi', taskId: 't1' });
    const msgs = (await (await fetch(url + '/messages?type=status.update')).json()) as Array<{ text: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('hi');
  });
});

describe('http: error mapping', () => {
  it('400 on validation error', async () => {
    const res = await post('/messages', { type: 'task.created', agent: 'a' }); // missing title
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'validation' });
  });

  it('409 on illegal transition (claim of already-claimed via /messages)', async () => {
    await post('/tasks', { title: 'X', agent: 'lead', taskId: 't1' });
    await post('/messages', { type: 'task.claimed', agent: 'w1', taskId: 't1' });
    const res = await post('/messages', { type: 'task.claimed', agent: 'w2', taskId: 't1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'transition', reason: 'not_open' });
  });

  it('claim endpoint returns 409 on a lost race', async () => {
    await post('/tasks', { title: 'X', agent: 'lead', taskId: 't1' });
    await post('/tasks/t1/claim', { agent: 'w1' });
    const second = await post('/tasks/t1/claim', { agent: 'w2' });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ ok: false, reason: 'not_open' });
  });

  it('404 for a missing task', async () => {
    const res = await fetch(url + '/tasks/nope');
    expect(res.status).toBe(404);
  });

  it('400 on a non-integer numeric query param', async () => {
    expect((await fetch(url + '/messages?fromSeq=abc')).status).toBe(400);
    expect((await fetch(url + '/messages?limit=-3')).status).toBe(400);
    expect((await fetch(url + '/subscribe?fromSeq=NaN')).status).toBe(400);
    // Number() coercions that must NOT be silently accepted as integers.
    expect((await fetch(url + '/messages?limit=0x10')).status).toBe(400); // hex
    expect((await fetch(url + '/messages?fromSeq=1e3')).status).toBe(400); // exponent
    expect((await fetch(url + '/messages?limit=')).status).toBe(400); // empty → was 0
  });

  it('400 (not 500) on a body-less task POST', async () => {
    // A client that omits the body (or content-type) must get a clean 4xx, not a
    // 5xx from a TypeError reading `undefined.agent`. Every body-reading task
    // handler tolerates a missing body and falls through to schema validation.
    for (const path of [
      '/tasks',
      '/tasks/x/complete',
      '/tasks/x/block',
      '/tasks/x/release',
      '/tasks/x/cancel',
    ]) {
      const res = await fetch(url + path, { method: 'POST' });
      expect(res.status, `${path} should be 400`).toBe(400);
      expect(await res.json(), `${path} body`).toMatchObject({ error: 'validation' });
    }
  });
});

describe('http: single-claimer over the network path', () => {
  it('exactly one of N concurrent claim requests wins', async () => {
    await post('/tasks', { title: 'one', agent: 'lead', taskId: 't1' });
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => post('/tasks/t1/claim', { agent: `w${i}` })),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(N - 1);
    expect((await bus.getTask('t1'))?.state).toBe('claimed');
  });
});

describe('http: graceful shutdown', () => {
  it('close() resolves promptly even with an open SSE subscription', async () => {
    // SSE streams never end on their own; a naive close() would hang on them.
    const controller = new AbortController();
    const res = await fetch(url + '/subscribe?fromSeq=0', { signal: controller.signal });
    expect(res.status).toBe(200);
    // Read the ready frame so the stream is genuinely established server-side.
    await res.body!.getReader().read();

    const start = Date.now();
    await app.close();
    expect(Date.now() - start).toBeLessThan(5000);
    controller.abort();
    // Re-open for the afterEach close() (idempotent) — nothing else to assert.
    ({ app, url, bus } = await startServer({ dir, port: 0 }));
  });
});

describe('http: subscriptions (SSE)', () => {
  it('streams messages as Server-Sent Events', async () => {
    await post('/messages', { type: 'status.update', agent: 'a', text: 'one' });
    await post('/messages', { type: 'status.update', agent: 'a', text: 'two' });
    await post('/messages', { type: 'status.update', agent: 'a', text: 'three' });

    const controller = new AbortController();
    const res = await fetch(url + '/subscribe?fromSeq=0', { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const got: number[] = [];

    while (got.length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        try {
          const obj = JSON.parse(dataLine.slice(5).trim());
          if (typeof obj.seq === 'number') got.push(obj.seq);
        } catch {
          // ready frame etc.
        }
      }
    }
    controller.abort();
    expect(got).toEqual([1, 2, 3]);
  });

  it('sends heartbeat comment frames to keep an idle stream alive', async () => {
    // A separate server with a fast heartbeat; no messages are posted, so only
    // the ready frame and keepalive comments should arrive.
    const d = await mkdtemp(join(tmpdir(), 'agent-bus-hb-'));
    const server = await startServer({ dir: d, port: 0, sseHeartbeatMs: 30 });
    try {
      const controller = new AbortController();
      const res = await fetch(server.url + '/subscribe?fromSeq=0', { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + 2000;
      while (!buffer.includes(': keepalive') && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      controller.abort();
      expect(buffer).toContain(': keepalive');
    } finally {
      await server.app.close();
      await rm(d, { recursive: true, force: true });
    }
  });
});
