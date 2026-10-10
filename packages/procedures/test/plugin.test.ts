/**
 * The Claude Code plugin `plugins/proa` carries a generated skill per
 * released pipeline procedure (`/proa:relations`, `/proa:placements`). These
 * tests fail when the committed files lag behind the procedures;
 * `pnpm --filter @proa/procedures generate` rewrites them. They also fail when
 * the skill of a released procedure version changes, or a skill changes
 * without a new plugin version.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  PLUGIN_VERSION,
  getProcedure,
  pipelineProcedures,
  renderSkill,
  skillPath,
  type Procedure,
} from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url);
const GENERATE = 'stale: run `pnpm --filter @proa/procedures generate` and commit the result';

/**
 * sha256 of the skill of every released procedure version, per procedure id.
 * A release never changes: runs are recorded under `<id>@<version>`. So a
 * change to a procedure text or to the wrapper (wrappers.ts) needs a new
 * procedure version, and that version's hash is added here.
 */
const RELEASED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'proa-relations': {
    '0.1.0': '870fd4add4ab13c3db0002b13df9d53ff3db008e3f60af490821e8864a72c32d',
    '0.2.0': '25266bae843315a5f109117c4479b0d99916e2d8631f01eddb5b68408d418406',
  },
  'proa-placements': {
    '0.1.0': '2cce70d5100ebbccf380d3ac045346276ea6dcb35bed48de1d595b582a35104f',
  },
};

/**
 * Per plugin release, the sha256 of every skill it ships, by skill name.
 * Claude Code keeps an installed plugin until its version changes, so every
 * change to a shipped skill needs a new plugin version (`PLUGIN_VERSION`,
 * src/plugin.ts) with its row here. 0.1.0 and 0.2.0 shipped the relations
 * skill alone, with the plugin version equal to the procedure version.
 */
const PLUGIN_RELEASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '0.1.0': { relations: RELEASED['proa-relations']?.['0.1.0'] ?? '' },
  '0.2.0': { relations: RELEASED['proa-relations']?.['0.2.0'] ?? '' },
  '0.3.0': {
    relations: RELEASED['proa-relations']?.['0.2.0'] ?? '',
    placements: RELEASED['proa-placements']?.['0.1.0'] ?? '',
  },
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function procedure(id: string): Procedure {
  const p = getProcedure(id);
  if (!p) throw new Error(`the ${id} procedure is missing`);
  return p;
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
}

describe('Claude Code plugin (plugins/proa)', () => {
  it('ships one skill per released pipeline procedure', () => {
    expect(pipelineProcedures().map((p) => p.id)).toEqual(['proa-placements', 'proa-relations']);
    expect(skillPath(procedure('proa-relations'))).toBe('plugins/proa/skills/relations/SKILL.md');
    expect(skillPath(procedure('proa-placements'))).toBe('plugins/proa/skills/placements/SKILL.md');
    expect(readdirSync(new URL('plugins/proa/skills/', ROOT)).sort()).toEqual([
      'placements',
      'relations',
    ]);
  });

  it.each(['proa-relations', 'proa-placements'])('ships the skill generated from %s', (id) => {
    const p = procedure(id);
    expect(readFileSync(new URL(skillPath(p), ROOT), 'utf8'), GENERATE).toBe(renderSkill(p));
  });

  it('gives the placements skill its arguments and keeps it out of model invocation', () => {
    const skill = renderSkill(procedure('proa-placements'));
    expect(skill).toContain('\nname: placements\n');
    expect(skill).toContain('\nargument-hint: "[project] [max-tasks]"\n');
    expect(skill).toContain('\ndisable-model-invocation: true\n');
    expect(skill).toContain(
      'claim_analysis({projectId: "<project>", kinds: ["placement"], max: 1})',
    );
  });

  it.each(['proa-relations', 'proa-placements'])(
    'never changes the skill of a released version of %s',
    (id) => {
      const p = procedure(id);
      const hash = sha256(renderSkill(p));
      expect(
        hash,
        `the skill of ${p.id}@${p.version} is not the released one: bump the procedure version (${p.name}.md frontmatter), run \`pnpm --filter @proa/procedures generate\` and add the new version's hash ${hash} to RELEASED`,
      ).toBe(RELEASED[p.id]?.[p.version]);
    },
  );

  it('ships exactly the skills its plugin release pins', () => {
    const shipped = Object.fromEntries(
      pipelineProcedures().map((p) => [p.name, sha256(renderSkill(p))]),
    );
    expect(
      shipped,
      `the skills differ from plugin release ${PLUGIN_VERSION}: bump PLUGIN_VERSION (src/plugin.ts), add its row to PLUGIN_RELEASES and run \`pnpm --filter @proa/procedures generate\``,
    ).toEqual(PLUGIN_RELEASES[PLUGIN_VERSION]);
  });

  it('has the plugin version', () => {
    expect(json('plugins/proa/.claude-plugin/plugin.json'), GENERATE).toMatchObject({
      name: 'proa',
      version: PLUGIN_VERSION,
    });
  });

  it('is listed in the repository marketplace and declares no MCP server', () => {
    expect(json('.claude-plugin/marketplace.json')).toEqual({
      name: 'proa',
      owner: { name: 'Miragon' },
      metadata: {
        description:
          'Claude Code plugins for ProA, the headless store for BPMN process landscapes.',
      },
      plugins: [
        {
          name: 'proa',
          source: './plugins/proa',
          description:
            'The ProA pipeline procedures as skills: /proa:relations judges candidate relations between BPMN processes, /proa:placements places processes on the value chain. Connect the proa MCP server separately.',
        },
      ],
    });
    // The connection is configured separately, so tool names stay mcp__proa__*.
    expect(json('plugins/proa/.claude-plugin/plugin.json')).not.toHaveProperty('mcpServers');
    expect(() => readFileSync(new URL('plugins/proa/.mcp.json', ROOT))).toThrow(/ENOENT/);
  });
});
