/**
 * The wrappers around a pipeline procedure (CONCEPT §7): the MCP prompt
 * `work_pipeline` and the Claude Code skill `/proa:relations` add only the
 * scope (project, number of tasks), the model declaration and the rules to
 * re-load the procedure, then embed its text verbatim. Both render through
 * {@link renderPipelineWrapper}, so they cannot drift apart; a test compares
 * the committed skill with {@link renderSkill}.
 */
import { ProcedureFormatError } from './errors.ts';
import type { Procedure } from './index.ts';

/** Upper bound of the MCP prompt's `maxTasks` and the skill's `max-tasks`. */
export const MAX_PIPELINE_TASKS = 100;

/** The skill's `argument-hint`; Claude Code substitutes the arguments as typed for `$ARGUMENTS`. */
export const SKILL_ARGUMENT_HINT = '[project] [max-tasks]';

/**
 * The scope of one pipeline run: fixed values (the MCP prompt; the server
 * validated them), or the skill's arguments, which Claude Code fills in when
 * the skill runs.
 */
export type PipelineScope =
  | { kind: 'fixed'; projectId?: string | undefined; maxTasks?: number | undefined }
  | { kind: 'arguments' };

/** The pipeline instructions for one scope, followed by the procedure text verbatim. */
export function renderPipelineWrapper(procedure: Procedure, scope: PipelineScope): string {
  return [
    ...(scope.kind === 'fixed' ? fixedScope(scope.projectId, scope.maxTasks) : argumentScope()),
    '- Declare your exact model id as llmModel in every submit_analysis call: the API model id you run as (as your system prompt or the user names it), never a product name, an alias or a guess. Declare the procedure id and version the claim names.',
    // An installed skill is a copy of one release; the claim names the release the server expects.
    `- The procedure below is ${procedure.id}@${procedure.version}. If a claim names another procedure or version, call get_procedure({id: "<the claim's procedure id>"}) before working that task and follow the returned text instead (the server expects that one); still declare what the claim names.`,
    '- If you cannot finish a task, hand it back with release_analysis instead of letting the lease expire.',
    `- After your context was summarized or compacted, call get_procedure({id: "${procedure.id}"}) again before the next task and follow the reloaded text: a summary is not the procedure.`,
    '',
    `Procedure ${procedure.id}@${procedure.version}:`,
    '',
    procedure.text,
  ].join('\n');
}

function fixedScope(projectId: string | undefined, maxTasks: number | undefined): string[] {
  const tasks = maxTasks === undefined ? '' : `${maxTasks} task${maxTasks === 1 ? '' : 's'}`;
  const claim = `claim_analysis({${projectId ? `projectId: "${projectId}", ` : ''}max: 1})`;
  return [
    `Work the ProA analysis pipeline${projectId ? ` in project ${projectId}` : ''}${tasks ? `, at most ${tasks}` : ''}, following the procedure below.`,
    '',
    `- Claim one task at a time with ${claim}. Stop when it returns no items${tasks ? ` or after ${tasks} (submitted or released)` : ''}, then report what you did.`,
  ];
}

function argumentScope(): string[] {
  return [
    'Work the ProA analysis pipeline, following the procedure below.',
    '',
    `Arguments (\`${SKILL_ARGUMENT_HINT}\`, both optional): $ARGUMENTS`,
    '- project: the first argument, a project id (prj_…) or key. Claim one task at a time with claim_analysis({projectId: "<project>", max: 1}); without a project, with claim_analysis({max: 1}) (an agent token is valid for one project).',
    `- max-tasks: the second argument, a whole number from 1 to ${MAX_PIPELINE_TASKS}. Stop after that many tasks (submitted or released) or when claim_analysis returns no items, whichever comes first; without it, stop when it returns no items. Then report what you did.`,
    '- If an argument is not valid, stop before claiming and say why.',
  ];
}

/** Path of a procedure's skill, relative to the repository root. */
export function skillPath(procedure: Procedure): string {
  return `plugins/proa/skills/${procedure.name}/SKILL.md`;
}

/** Syntax Claude Code expands in skill content (it would change the text or run a command). */
const SKILL_EXPANSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\$(?:ARGUMENTS|\d)/, '$ARGUMENTS or $<digit>'],
  [/\$\{CLAUDE_/, '${CLAUDE_…}'],
  [/(?:^|\s)!`|```!/, '!`command`'],
];

/**
 * The Claude Code skill of a pipeline procedure (`plugins/proa/skills/<name>/SKILL.md`,
 * invoked as `/proa:<name> [project] [max-tasks]`): frontmatter, then the
 * pipeline wrapper with the skill's arguments as scope.
 *
 * @throws {ProcedureFormatError} if the procedure text holds syntax that Claude
 *   Code expands in skills
 */
export function renderSkill(procedure: Procedure): string {
  const expanded = SKILL_EXPANSIONS.find(([pattern]) => pattern.test(procedure.text));
  if (expanded) {
    throw new ProcedureFormatError(
      `${procedure.name}: the text contains ${expanded[1]}, which Claude Code expands in skills`,
    );
  }
  return [
    '---',
    `# Generated from packages/procedures/${procedure.name}.md by \`pnpm --filter @proa/procedures generate\`.`,
    '# Do not edit: change the procedure and generate again (a test compares this file).',
    `name: ${procedure.name}`,
    // JSON strings are valid YAML double-quoted scalars.
    `description: ${JSON.stringify(procedure.description ?? procedure.title)}`,
    `argument-hint: ${JSON.stringify(SKILL_ARGUMENT_HINT)}`,
    // The model cannot start the claim/submit loop on its own (CONCEPT §7: users start agents),
    // like the MCP prompt work_pipeline; a typed `/proa:<name>` (also `claude -p`) still runs it.
    'disable-model-invocation: true',
    '---',
    '',
    renderPipelineWrapper(procedure, { kind: 'arguments' }),
    '',
  ].join('\n');
}
