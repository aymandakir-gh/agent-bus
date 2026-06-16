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
  },
});
