import { describe, expect, it } from 'vitest';

import {
  MAX_PIPELINE_TASKS,
  ProcedureFormatError,
  parseProcedure,
  renderPipelineWrapper,
  renderSkill,
  skillPath,
} from '../src/index.ts';

const procedure = parseProcedure(
  'sample',
  '---\nid: proa-sample\nversion: 1.2.3\ntitle: Sample\ndescription: Says "hi": twice\nstatus: released\n---\n\n# Sample\n\nClaim, judge, submit.\n',
);

function frontmatter(skill: string): Map<string, string> {
  const body = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
  return new Map(
    body
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
  );
}

describe('renderPipelineWrapper', () => {
  it('scopes the loop to a project and a number of tasks, then embeds the procedure', () => {
    const text = renderPipelineWrapper(procedure, {
      kind: 'fixed',
      projectId: 'nordwind-handel',
      maxTasks: 3,
    });
    expect(text).toMatch(
      /^Work the ProA analysis pipeline in project nordwind-handel, at most 3 tasks,/,
    );
    expect(text).toContain('claim_analysis({projectId: "nordwind-handel", max: 1})');
    expect(text).toContain('or after 3 tasks (submitted or released)');
    expect(text).toContain('exact model id as llmModel in every submit_analysis call');
    expect(text).toContain('release_analysis');
    expect(text).toContain('call get_procedure({id: "proa-sample"}) again');
    expect(text).toContain('Procedure proa-sample@1.2.3:\n\n# Sample');
    expect(text.endsWith(`\n${procedure.text}`)).toBe(true);
  });

  it('without scope: every project of the token, until no task is left', () => {
    const text = renderPipelineWrapper(procedure, { kind: 'fixed' });
    expect(text).toMatch(/^Work the ProA analysis pipeline, following the procedure below\./);
    expect(text).toContain('claim_analysis({max: 1}). Stop when it returns no items, then');
    expect(text).not.toContain('at most');
    expect(renderPipelineWrapper(procedure, { kind: 'fixed', maxTasks: 1 })).toContain(
      'at most 1 task,',
    );
  });

  it('takes the scope from the skill arguments', () => {
    const text = renderPipelineWrapper(procedure, { kind: 'arguments' });
    expect(text).toContain('Arguments (`[project] [max-tasks]`, both optional): $ARGUMENTS\n');
    expect(text).toContain('claim_analysis({projectId: "<project>", max: 1})');
    expect(text).toContain('claim_analysis({max: 1})');
    expect(text).toContain(`a whole number from 1 to ${MAX_PIPELINE_TASKS}`);
    // The common rules are the same lines as in the MCP prompt.
    const common = renderPipelineWrapper(procedure, { kind: 'fixed' }).split('\n').slice(3);
    expect(text.endsWith(common.join('\n'))).toBe(true);
  });
});

describe('renderSkill', () => {
  it('writes the frontmatter and the wrapper with the skill arguments', () => {
    const skill = renderSkill(procedure);
    expect(skill.startsWith('---\n# Generated from packages/procedures/sample.md by')).toBe(true);
    const fields = frontmatter(skill);
    expect([...fields.keys()]).toEqual(['name', 'description', 'argument-hint']);
    expect(fields.get('name')).toBe('sample');
    expect(JSON.parse(fields.get('description') ?? '')).toBe('Says "hi": twice');
    expect(JSON.parse(fields.get('argument-hint') ?? '')).toBe('[project] [max-tasks]');
    expect(skill).toContain(`---\n\n${renderPipelineWrapper(procedure, { kind: 'arguments' })}\n`);
    expect(skill.endsWith('\n')).toBe(true);
    expect(skillPath(procedure)).toBe('plugins/proa/skills/sample/SKILL.md');
  });

  it('falls back to the title without a description', () => {
    const { description: _, ...plain } = procedure;
    expect(frontmatter(renderSkill(plain)).get('description')).toBe('"Sample"');
  });

  it.each([
    ['$ARGUMENTS', 'Use $ARGUMENTS here.'],
    ['an indexed argument', 'It costs $1.00.'],
    ['a skill variable', 'See ${CLAUDE_SKILL_DIR}/x.'],
    ['an inline command', 'Run !`date` first.'],
    ['an inline command at a line start', 'Text\n!`date`'],
    ['a command block', '```!\ndate\n```'],
  ])('refuses procedure text with %s', (_case, text) => {
    expect(() => renderSkill({ ...procedure, text })).toThrow(ProcedureFormatError);
  });

  it('keeps a dollar sign that Claude Code does not expand', () => {
    expect(renderSkill({ ...procedure, text: 'Costs in US$ or $x; say "yes!" `now`.' })).toContain(
      'Costs in US$ or $x; say "yes!" `now`.',
    );
  });
});
