/**
 * HTTP transport: a thin Fastify layer over the same {@link FileBus} core, so it
 * inherits every guarantee (total order, single-claimer, idempotency). A lost
 * claim race surfaces as HTTP `409 Conflict`. Binds to 127.0.0.1 by default
 * (local-first); no telemetry.
 */
import Fastify, { type FastifyInstance } from 'fastify';

import { FileBus } from '../core/file-bus';
import { PROTOCOL_ID, SPEC_VERSION } from '../version';
import {
  BusError,
  NotFoundError,
  LockTimeoutError,
  TransitionError,
  ValidationError,
} from '../core/errors';
import type { MessageInput, MessageType, TaskState } from '../core/types';

export interface CreateServerOptions {
  bus: FileBus;
  logger?: boolean;
}

function asArray<T>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

export function createServer(options: CreateServerOptions): FastifyInstance {
  const { bus } = options;
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/health', async () => ({ ok: true, protocol: PROTOCOL_ID, version: SPEC_VERSION }));

  app.get('/meta', async () => (await bus.readMeta()) ?? { protocol: PROTOCOL_ID, version: SPEC_VERSION });

  // ---- messages ----
  app.post('/messages', async (req, reply) => {
    const msg = await bus.post(req.body as MessageInput);
    reply.code(201);
    return msg;
  });

  app.get('/messages', async (req) => {
    const q = req.query as Record<string, string | string[] | undefined>;
    return bus.getMessages({
      fromSeq: q.fromSeq !== undefined ? Number(q.fromSeq) : undefined,
      type: asArray(q.type) as MessageType[] | undefined,
      taskId: typeof q.taskId === 'string' ? q.taskId : undefined,
      agent: typeof q.agent === 'string' ? q.agent : undefined,
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
    });
  });

  // ---- tasks ----
  app.get('/tasks', async (req) => {
    const q = req.query as Record<string, string | string[] | undefined>;
    return bus.getTasks({ state: asArray(q.state) as TaskState[] | undefined });
  });

  app.get('/tasks/:id', async (req) => {
    const { id } = req.params as { id: string };
    const task = await bus.getTask(id);
    if (!task) throw new NotFoundError(`task ${id} not found`);
    return task;
  });

  app.post('/tasks', async (req, reply) => {
    const b = req.body as {
      title: string;
      agent: string;
      taskId?: string;
      description?: string;
      priority?: 'low' | 'normal' | 'high';
      tags?: string[];
      id?: string;
    };
    const msg = await bus.createTask(b);
    reply.code(201);
    return msg;
  });

  app.post('/tasks/:id/claim', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { agent: string; note?: string; id?: string };
    const res = await bus.claim(id, b.agent, { note: b.note, id: b.id });
    reply.code(res.ok ? 201 : 409);
    return res;
  });

  app.post('/tasks/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { agent: string; result?: unknown; note?: string };
    const msg = await bus.complete(id, b.agent, b.result, b.note);
    reply.code(201);
    return msg;
  });

  app.post('/tasks/:id/block', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { agent: string; reason: string; note?: string };
    const msg = await bus.block(id, b.agent, b.reason, b.note);
    reply.code(201);
    return msg;
  });

  app.post('/tasks/:id/release', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { agent: string; reason?: string };
    const msg = await bus.release(id, b.agent, b.reason);
    reply.code(201);
    return msg;
  });

  app.post('/tasks/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { agent: string; reason?: string };
    const msg = await bus.cancel(id, b.agent, b.reason);
    reply.code(201);
    return msg;
  });

  // ---- subscriptions (Server-Sent Events) ----
  app.get('/subscribe', (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const fromSeq = q.fromSeq !== undefined ? Number(q.fromSeq) : 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('event: ready\ndata: {"ok":true}\n\n');

    const sub = bus.subscribe(
      (m) => {
        res.write(`data: ${JSON.stringify(m)}\n\n`);
      },
      { fromSeq },
    );
    const close = (): void => {
      sub.close();
      try {
        res.end();
      } catch {
        // already closed
      }
    };
    req.raw.on('close', close);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ValidationError) {
      return reply.code(400).send({ error: 'validation', message: err.message, errors: err.errors });
    }
    if (err instanceof TransitionError) {
      return reply.code(409).send({
        error: 'transition',
        reason: err.reason,
        taskId: err.taskId,
        from: err.from,
        message: err.message,
      });
    }
    if (err instanceof NotFoundError) {
      return reply.code(404).send({ error: 'not_found', message: err.message });
    }
    if (err instanceof LockTimeoutError) {
      return reply.code(503).send({ error: 'lock_timeout', message: err.message });
    }
    if (err instanceof BusError) {
      return reply.code(400).send({ error: err.code, message: err.message });
    }
    // Fastify's own (e.g. malformed JSON) or unexpected errors.
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: 'error', message: (err as Error).message });
  });

  return app;
}

export interface StartServerOptions {
  dir: string;
  port?: number;
  host?: string;
  logger?: boolean;
}

/** Initialize the bus directory and start listening. */
export async function startServer(
  options: StartServerOptions,
): Promise<{ app: FastifyInstance; url: string; bus: FileBus }> {
  const bus = await FileBus.init(options.dir);
  const app = createServer({ bus, logger: options.logger });
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 7777;
  await app.listen({ host, port });
  const address = app.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { app, url: `http://${host}:${actualPort}`, bus };
}
