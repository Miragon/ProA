/**
 * The Claude Code plugin `plugins/proa` carries a generated copy of the
 * relations procedure. These tests fail when the committed files lag behind
 * `relations.md`; `pnpm --filter @proa/procedures generate` rewrites them.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { getProcedure, renderSkill, skillPath, type Procedure } from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url);
const GENERATE = 'stale: run `pnpm --filter @proa/procedures generate` and commit the result';

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
