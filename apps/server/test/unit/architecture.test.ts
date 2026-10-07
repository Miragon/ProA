import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cruise, type ICruiseResult, type IConfiguration } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

const serverDir = fileURLToPath(new URL('../..', import.meta.url));
const config = createRequire(import.meta.url)('../../.dependency-cruiser.cjs') as IConfiguration;

async function violations(baseDir: string): Promise<string[]> {
  const { output } = await cruise(['src'], {
    ...config.options,
    baseDir,
    ruleSet: { forbidden: config.forbidden ?? [] },
    validate: true,
    tsConfig: { fileName: path.join(serverDir, 'tsconfig.json') },
  });
  return (output as ICruiseResult).summary.violations.map(
    (v) => `${v.rule.name}: ${v.from} -> ${v.to}`,
  );
}

describe('architecture (dependency-cruiser)', () => {
  it('src/domain imports none of db, http, mcp, auth', async () => {
    expect(await violations(serverDir)).toEqual([]);
  });

  it('detects a domain → db import', async () => {
    const fixture = path.join(serverDir, 'test/fixtures/depcruise');
    expect(await violations(fixture)).toContain(
      'domain-is-pure: src/domain/bad.ts -> src/db/repo.ts',
    );
  });
});
