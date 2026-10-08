/**
 * The Claude Code plugin `plugins/proa` carries a generated copy of the
 * relations procedure. These tests fail when the committed files lag behind
 * `relations.md`; `pnpm --filter @proa/procedures generate` rewrites them. They
 * also fail when the skill of a released version changes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { getProcedure, renderSkill, skillPath, type Procedure } from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url);
const GENERATE = 'stale: run `pnpm --filter @proa/procedures generate` and commit the result';

/**
 * sha256 of the skill of every released version. A release never changes: Claude Code keeps an
 * installed plugin until its version changes, and runs are recorded under `<id>@<version>`. So a
 * change to relations.md or to the wrapper (wrappers.ts) needs a new procedure version, and that
 * version's hash is added here.
 */
const RELEASED: Readonly<Record<string, string>> = {
  '0.1.0': '870fd4add4ab13c3db0002b13df9d53ff3db008e3f60af490821e8864a72c32d',
  '0.2.0': '25266bae843315a5f109117c4479b0d99916e2d8631f01eddb5b68408d418406',
};

function relations(): Procedure {
  const p = getProcedure('proa-relations');
  if (!p) throw new Error('the proa-relations procedure is missing');
  return p;
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
}

describe('Claude Code plugin (plugins/proa)', () => {
  it('ships the skill generated from relations.md', () => {
    const p = relations();
    expect(skillPath(p)).toBe('plugins/proa/skills/relations/SKILL.md');
    expect(readFileSync(new URL(skillPath(p), ROOT), 'utf8'), GENERATE).toBe(renderSkill(p));
  });

  it('never changes the skill of a released version', () => {
    const p = relations();
    const hash = createHash('sha256').update(renderSkill(p)).digest('hex');
    expect(
      hash,
      `the skill of ${p.id}@${p.version} is not the released one: bump the procedure version (relations.md frontmatter), run \`pnpm --filter @proa/procedures generate\` and add the new version's hash ${hash} to RELEASED`,
    ).toBe(RELEASED[p.version]);
  });

  it('has the version of the relations procedure', () => {
    expect(json('plugins/proa/.claude-plugin/plugin.json'), GENERATE).toMatchObject({
      name: 'proa',
      version: relations().version,
    });
  });

  it('is listed in the repository marketplace and declares no MCP server', () => {
    expect(json('.claude-plugin/marketplace.json')).toMatchObject({
      name: 'proa',
      plugins: [{ name: 'proa', source: './plugins/proa' }],
    });
    // The connection is configured separately, so tool names stay mcp__proa__*.
    expect(json('plugins/proa/.claude-plugin/plugin.json')).not.toHaveProperty('mcpServers');
    expect(() => readFileSync(new URL('plugins/proa/.mcp.json', ROOT))).toThrow(/ENOENT/);
  });
});
