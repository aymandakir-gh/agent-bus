/**
 * Runs the shared transport-conformance suite against the **file transport**
 * (`FileBus`) talking directly to a temp directory.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileBus } from '../../src/core/file-bus';
import { defineConformanceSuite } from './suite';

defineConformanceSuite('file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bus-conf-file-'));
  const bus = await FileBus.init(dir, { pollIntervalMs: 20 });
  return {
    transport: bus,
    close: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});
