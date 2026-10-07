import { defineConfig } from 'vitest/config';

// Two projects: `unit` needs nothing; `integration` gets a real PostgreSQL 17
// from test/global-setup.ts (Testcontainers, or PROA_TEST_DATABASE_URL).
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
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
