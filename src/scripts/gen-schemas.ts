/**
 * Generate the published artifacts from the single source of truth
 * (`core/schemas.ts`): write `schemas/*.json` and inject the schema blocks into
 * `PROTOCOL.md` between `<!-- BEGIN schema:X -->` / `<!-- END schema:X -->`
 * markers. Run via `pnpm gen:schemas`. `test/schema.test.ts` fails on drift.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SCHEMA_FILES, schemaManifest } from '../core/schemas';

const root = process.cwd();

function block(marker: string, schema: unknown): string {
  const begin = `<!-- BEGIN schema:${marker} -->`;
  const end = `<!-- END schema:${marker} -->`;
  return `${begin}\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\n${end}`;
}

async function main(): Promise<void> {
  const schemasDir = join(root, 'schemas');
  await mkdir(schemasDir, { recursive: true });

  for (const { file, schema } of SCHEMA_FILES) {
    await writeFile(join(schemasDir, file), JSON.stringify(schema, null, 2) + '\n');
    console.log(`wrote schemas/${file}`);
  }

  // Versioned manifest for cross-language consumers (protocol + spec version +
  // schema file list). Drift-tested in test/schema.test.ts.
  await writeFile(join(schemasDir, 'index.json'), JSON.stringify(schemaManifest, null, 2) + '\n');
  console.log('wrote schemas/index.json');

  const protoPath = join(root, 'PROTOCOL.md');
  let doc = await readFile(protoPath, 'utf8');
  let injected = 0;
  for (const { marker, schema } of SCHEMA_FILES) {
    const begin = `<!-- BEGIN schema:${marker} -->`;
    const end = `<!-- END schema:${marker} -->`;
    const bi = doc.indexOf(begin);
    const ei = doc.indexOf(end);
    if (bi === -1 || ei === -1) continue;
    doc = doc.slice(0, bi) + block(marker, schema) + doc.slice(ei + end.length);
    injected++;
  }
  await writeFile(protoPath, doc);
  console.log(`injected ${injected} schema block(s) into PROTOCOL.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
