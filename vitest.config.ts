import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The concurrency simulation spawns child processes and is sensitive to
    // shared CPU; keep the suite stable rather than maximally parallel.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      // The contract's correctness lives in the core; that is where the gate
      // bites. (Child-process workers in the sims run in their own processes and
      // are not instrumented; the in-process tests + conformance cover the code.)
      include: ['src/core/**'],
      // transport.ts is interface/type-only — nothing to execute or cover.
      exclude: ['src/core/transport.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        // v1.0.0 gate (criterion 4): core line ≥ 90% AND branch ≥ 80%.
        lines: 90,
        branches: 80,
        functions: 85,
        statements: 90,
      },
    },
  },
});
