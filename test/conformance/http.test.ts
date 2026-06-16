/**
 * Runs the shared transport-conformance suite against the **HTTP transport** —
 * a real Fastify server over a temp directory, driven by `HttpBusClient` over
 * the loopback network. Same suite as `file.test.ts`: the two cannot drift.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../../src/http/server';
import { HttpBusClient } from '../../src/http/client';
import { defineConformanceSuite } from './suite';

defineConformanceSuite('http', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bus-conf-http-'));
  const { app, url } = await startServer({ dir, port: 0 });
  const client = new HttpBusClient({ baseUrl: url });
  return {
    transport: client,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});
