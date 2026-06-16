/**
 * Emit the single, versioned schema bundle — manifest + all JSON Schemas inlined
 * in one file — for cross-language consumers who want one download. Written to
 * `dist/agent-bus-schemas-<version>.json`; attached to each GitHub release.
 *
 * Run via `pnpm schemas:bundle`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildSchemaBundle } from '../core/schemas';

async function main(): Promise<void> {
  const bundle = buildSchemaBundle();
  const outDir = join(process.cwd(), 'dist');
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `agent-bus-schemas-${bundle.version}.json`);
  await writeFile(file, JSON.stringify(bundle, null, 2) + '\n');
  console.log(`wrote ${file} (protocol ${bundle.protocol}, version ${bundle.version})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
