import { defineConfig } from 'vitest/config';

// Two projects: `unit` needs nothing; `e2e` starts a real ProA server (from
// source) against PostgreSQL 17 from test/e2e/global-setup.ts (Testcontainers,
// or PROA_TEST_DATABASE_URL) and drives it with the CLI, including `proa mcp`
// as a child process. `live` checks an already running ProA (PROA_LIVE_URL,
// see test/live/stack.live.test.ts) and is skipped without it.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          globalSetup: ['test/e2e/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
