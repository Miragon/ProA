import { defineConfig } from 'vitest/config';

// Unit tests only, with a fake process spawner and a fake fetch: the seed and
// serve orchestration, origins and the check. The real run is the demo image
// (docker/Dockerfile.demo, CI job "demo"); the server's read-only mode itself
// is tested in apps/server (test/unit/demo-mode.test.ts, test/integration/demo-mode.test.ts).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
