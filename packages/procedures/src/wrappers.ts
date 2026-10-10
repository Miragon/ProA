/**
 * The wrappers around a pipeline procedure (CONCEPT §7): the MCP prompt
 * `work_pipeline` and the Claude Code skills `/proa:relations` and
 * `/proa:placements` add only the scope (project, number of tasks, the task
 * kind the claims name), the model declaration and the rules to re-load the
 * procedure, then embed its text verbatim. Both render through
 * {@link renderPipelineWrapper}, so they cannot drift apart; a test compares
 * the committed skills with {@link renderSkill}. {@link renderAdHocWrapper}
 * wraps a procedure for work without a task (the MCP prompt `place_processes`).
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

/**
 * The task kinds a procedure's claims name: `[kind]` for a procedure with a
 * `kind` in its frontmatter (`placement`), else none, so the claim takes the
 * server's default (`relations`) and the released relations text stays as it was.
 */
export function claimKinds(procedure: Pick<Procedure, 'kind'>): readonly string[] | undefined {
  return procedure.kind === undefined ? undefined : [procedure.kind];
}

/** `kinds: ["placement"], ` for a claim call, or nothing (the server's default). */
function kindsArgument(kinds: readonly string[] | undefined): string {
  return kinds === undefined ? '' : `kinds: [${kinds.map((k) => `"${k}"`).join(', ')}], `;
}

/** The pipeline instructions for one scope, followed by the procedure text verbatim. */
export function renderPipelineWrapper(procedure: Procedure, scope: PipelineScope): string {
  const kinds = claimKinds(procedure);
  return [
    ...(scope.kind === 'fixed'
      ? fixedScope(scope.projectId, scope.maxTasks, kinds)
      : argumentScope(kinds)),
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

function fixedScope(
  projectId: string | undefined,
  maxTasks: number | undefined,
  kinds: readonly string[] | undefined,
): string[] {
  const tasks = maxTasks === undefined ? '' : `${maxTasks} task${maxTasks === 1 ? '' : 's'}`;
  const claim = `claim_analysis({${projectId ? `projectId: "${projectId}", ` : ''}${kindsArgument(kinds)}max: 1})`;
  return [
    `Work the ProA analysis pipeline${projectId ? ` in project ${projectId}` : ''}${tasks ? `, at most ${tasks}` : ''}, following the procedure below.`,
    '',
    `- Claim one task at a time with ${claim}. Stop when it returns no items${tasks ? ` or after ${tasks} (submitted or released)` : ''}, then report what you did.`,
  ];
}

function argumentScope(kinds: readonly string[] | undefined): string[] {
  const k = kindsArgument(kinds);
  return [
    'Work the ProA analysis pipeline, following the procedure below.',
    '',
    `Arguments (\`${SKILL_ARGUMENT_HINT}\`, both optional): $ARGUMENTS`,
    `- project: the first argument, a project id (prj_…) or key. Claim one task at a time with claim_analysis({projectId: "<project>", ${k}max: 1}); without a project, with claim_analysis({${k}max: 1}) (an agent token is valid for one project).`,
    `- max-tasks: the second argument, a whole number from 1 to ${MAX_PIPELINE_TASKS}. Stop after that many tasks (submitted or released) or when claim_analysis returns no items, whichever comes first; without it, stop when it returns no items. Then report what you did.`,
    '- If an argument is not valid, stop before claiming and say why.',
  ];
}

/**
 * The MCP prompt `place_processes` (M4 §3.1, §3.5): a procedure wrapped for
 * interactive work without a task in one project (the procedure's section
 * "Without a task"), with the declaration of procedure and model for
 * `propose_placement`, then the procedure text verbatim.
 */
export function renderAdHocWrapper(procedure: Procedure, scope: { projectId: string }): string {
  return [
    `Place the processes of ProA project ${scope.projectId} on its value chain (Wertschöpfungskette) without a task, following section 13 "Without a task" of the procedure below and its judgement rules. Use projectId "${scope.projectId}" in every tool call.`,
    '',
    `- Declare procedure {id: "${procedure.id}", version: "${procedure.version}"} and your exact model id as llmModel in every propose_placement call: the API model id you run as (as your system prompt or the user names it), never a product name, an alias or a guess.`,
    '- You only propose: never decide a placement and never edit or save the value chain. A human reviews your proposals on the value chain page.',
    `- After your context was summarized or compacted, call get_procedure({id: "${procedure.id}"}) again before you go on and follow the reloaded text: a summary is not the procedure.`,
    '- When you are done, report in German what you proposed (with the outcomes of each batch), how many processes you skipped as judged or in a task, and the processes you could not place, each with a reason.',
    '',
    `Procedure ${procedure.id}@${procedure.version}:`,
    '',
    procedure.text,
  ].join('\n');
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
 * pipeline wrapper with the skill's arguments as scope (and the procedure's
 * task kind in the claims, {@link claimKinds}).
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
