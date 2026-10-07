// The runtime is pinned exactly and in one version everywhere: CI reads
// .node-version, the image uses NODE_IMAGE, and pnpm comes from packageManager.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const root = new URL('../../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');

describe('runtime pins', () => {
  const nodeVersion = read('.node-version').trim();
  const dockerfile = read('docker/Dockerfile');
  const pkg = JSON.parse(read('package.json')) as {
    packageManager: string;
    engines: { node: string };
  };

  it('pins Node exactly, the same in .node-version (CI) and the Docker image', () => {
    expect(nodeVersion).toMatch(/^24\.\d+\.\d+$/);
    expect(dockerfile).toContain(`ARG NODE_IMAGE=node:${nodeVersion}-`);
    expect(pkg.engines.node).toBe('>=24');
  });

  it('pins pnpm and the Dockerfile frontend exactly', () => {
    const pnpm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager)?.[1];
    expect(pnpm).toBeDefined();
    expect(dockerfile).toContain(`ARG PNPM_VERSION=${pnpm}`);
    expect(dockerfile.split('\n')[0]).toMatch(/^# syntax=docker\/dockerfile:\d+\.\d+\.\d+$/);
  });
});
