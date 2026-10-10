import { describe, expect, it } from 'vitest';

import {
  MAX_PIPELINE_TASKS,
  ProcedureFormatError,
  claimKinds,
  getProcedure,
  parseProcedure,
  renderAdHocWrapper,
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
    expect(text).toContain(
      '- The procedure below is proa-sample@1.2.3. If a claim names another procedure or version, call get_procedure({id: "<the claim\'s procedure id>"}) before working that task and follow the returned text instead',
    );
    expect(text).toContain('still declare what the claim names.');
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
    // The common rules are the same lines as in the MCP prompt, the version rule among them.
    const common = renderPipelineWrapper(procedure, { kind: 'fixed' }).split('\n').slice(3);
    expect(
      common.some((line) => line.startsWith('- The procedure below is proa-sample@1.2.3.')),
    ).toBe(true);
    expect(text.endsWith(common.join('\n'))).toBe(true);
  });
});

describe('the task kind in the claims', () => {
  const placement = { ...procedure, kind: 'placement' };

  it('names kinds only for a procedure with a kind', () => {
    expect(claimKinds(procedure)).toBeUndefined();
    expect(claimKinds(placement)).toEqual(['placement']);
    expect(renderPipelineWrapper(placement, { kind: 'fixed', projectId: 'x' })).toContain(
      'claim_analysis({projectId: "x", kinds: ["placement"], max: 1})',
    );
    expect(renderPipelineWrapper(placement, { kind: 'fixed' })).toContain(
      'claim_analysis({kinds: ["placement"], max: 1}). Stop when',
    );
    const args = renderPipelineWrapper(placement, { kind: 'arguments' });
    expect(args).toContain(
      'claim_analysis({projectId: "<project>", kinds: ["placement"], max: 1})',
    );
    expect(args).toContain('claim_analysis({kinds: ["placement"], max: 1})');
    expect(renderSkill(placement)).toContain('kinds: ["placement"]');
  });

  it('keeps the text of a procedure without a kind as it was', () => {
    // Only the claim calls differ.
    const plain = renderPipelineWrapper(procedure, { kind: 'arguments' });
    expect(plain).not.toContain('kinds');
    expect(
      renderPipelineWrapper(placement, { kind: 'arguments' }).replaceAll(
        'kinds: ["placement"], ',
        '',
      ),
    ).toBe(plain);
  });

  it('claims placement tasks in the placements skill and relations tasks in the relations skill', () => {
    const placements = getProcedure('proa-placements');
    const relations = getProcedure('proa-relations');
    if (!placements || !relations) throw new Error('missing');
    expect(renderSkill(placements)).toContain(
      'claim_analysis({projectId: "<project>", kinds: ["placement"], max: 1})',
    );
    expect(renderSkill(relations)).toContain('claim_analysis({projectId: "<project>", max: 1})');
    expect(renderSkill(relations)).not.toContain('kinds:');
  });
});

describe('renderAdHocWrapper', () => {
  it('scopes ad-hoc work to one project, declares procedure and model, then embeds the procedure', () => {
    const text = renderAdHocWrapper(procedure, { projectId: 'demo' });
    expect(text).toMatch(/^Place the processes of ProA project demo on its value chain/);
    expect(text).toContain('Use projectId "demo" in every tool call.');
    expect(text).toContain(
      'Declare procedure {id: "proa-sample", version: "1.2.3"} and your exact model id as llmModel in every propose_placement call',
    );
    expect(text).toContain('never decide a placement and never edit or save the value chain');
    expect(text).toContain('call get_procedure({id: "proa-sample"}) again');
    expect(text).not.toContain('claim_analysis');
    expect(text).toContain('Procedure proa-sample@1.2.3:\n\n# Sample');
    expect(text.endsWith(`\n${procedure.text}`)).toBe(true);
  });
});

describe('renderSkill', () => {
  it('writes the frontmatter and the wrapper with the skill arguments', () => {
    const skill = renderSkill(procedure);
    expect(skill.startsWith('---\n# Generated from packages/procedures/sample.md by')).toBe(true);
    const fields = frontmatter(skill);
    expect([...fields.keys()]).toEqual([
      'name',
      'description',
      'argument-hint',
      'disable-model-invocation',
    ]);
    expect(fields.get('name')).toBe('sample');
    expect(JSON.parse(fields.get('description') ?? '')).toBe('Says "hi": twice');
    expect(JSON.parse(fields.get('argument-hint') ?? '')).toBe('[project] [max-tasks]');
    // Only users start the claim/submit loop; the model cannot invoke the skill.
    expect(fields.get('disable-model-invocation')).toBe('true');
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
