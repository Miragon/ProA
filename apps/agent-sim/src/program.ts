/**
 * `proa-agent-sim`: the command line of the simulation agent.
 *
 *   proa-agent-sim --token proa_at_… [--url http://127.0.0.1:7400]
 *   proa-agent-sim --stdio …            (through `proa mcp`, as Claude Desktop)
 *   proa-agent-sim --record eval/recordings --record-input summary --no-record-ids
 *   proa-agent-sim --kinds placement …  (only the value chain's placement tasks)
 */
import path from 'node:path';

import { AGENT_TOKEN_PREFIX, OWNER_KEY_PREFIX, type AnalysisKind } from '@proa/contracts';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';

import { AGENT_NAME, ALL_KINDS, SimError, runAgent, type AgentReport } from './agent.ts';
import { bridgeCommand, connect, type Connection } from './connect.ts';
import { DEFAULT_POLICY, SIM_POLICY } from './policy.ts';
import { createRecorder, type InputMode } from './recorder.ts';
import simPackage from '../package.json' with { type: 'json' };

export const DEFAULT_URL = 'http://127.0.0.1:7400';

/** Process boundary, replaceable in tests. */
export interface SimIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** Directory relative paths (`--record`) are resolved against. */
  cwd: string;
  /** For tests: the fetch of the HTTP transport. */
  fetch?: typeof globalThis.fetch;
}

/** Under `pnpm …` the package manager runs scripts elsewhere and passes the user's directory as INIT_CWD. */
function invocationDir(env: NodeJS.ProcessEnv): string {
  return env['npm_lifecycle_event'] && env['INIT_CWD'] ? env['INIT_CWD'] : process.cwd();
}

export const processIo: SimIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: invocationDir(process.env),
};

export interface SimOptions {
  url?: string;
  token?: string;
  stdio?: boolean;
  stdioCommand?: string;
  project?: string;
  model?: string;
  kinds?: AnalysisKind[];
  maxTasks?: number;
  dryRun?: boolean;
  record?: string;
  recordInput: InputMode;
  recordIds: boolean;
  proposeAt: number;
  askAt: number;
  llmModel: string;
  quiet?: boolean;
  json?: boolean;
}

function score(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new InvalidArgumentError('a score in [0, 1]');
  }
  return n;
}

/** `relations`, `placement` or both, comma-separated. */
function kindList(value: string): AnalysisKind[] {
  const kinds = value.split(',').map((k) => k.trim());
  if (
    kinds.length === 0 ||
    kinds.some((k) => !(ALL_KINDS as readonly string[]).includes(k)) ||
    new Set(kinds).size !== kinds.length
  ) {
    throw new InvalidArgumentError(`a comma-separated list of ${ALL_KINDS.join(', ')}`);
  }
  return kinds as AnalysisKind[];
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('a positive integer');
  return n;
}

export function buildProgram(io: SimIo, run: (opts: SimOptions) => Promise<void>): Command {
  return new Command('proa-agent-sim')
    .description(
      'LLM-free simulation agent: works the ProA analysis pipeline over MCP with a deterministic policy (claim → decide → submit until no task is left)',
    )
    .version(simPackage.version, '-v, --version')
    .option('--url <url>', `ProA server URL (env PROA_URL, default ${DEFAULT_URL})`)
    .option('--token <token>', 'agent token proa_at_… with proa:propose (env PROA_TOKEN)')
    .option(
      '--stdio',
      'connect through the stdio bridge `proa mcp` of this checkout instead of HTTP',
    )
    .option(
      '--stdio-command <command>',
      'bridge command line instead (implies --stdio), e.g. "docker exec -i -e PROA_TOKEN proa2-proa-1 proa mcp"',
    )
    .option('-p, --project <project>', 'only this project (key or id)')
    .option('-m, --model <modelKey>', 'only this model (relations tasks only)')
    .option(
      '-k, --kinds <kinds>',
      `task kinds to claim, comma-separated (default: ${ALL_KINDS.join(',')})`,
      kindList,
    )
    .option('-n, --max-tasks <n>', 'stop after n tasks', positiveInt)
    .option(
      '--dry-run',
      'decide and record, but hand every claimed task back instead of submitting',
    )
    .option(
      '--record <dir>',
      'write each claim input and submission as JSONL in the eval/recordings layout below <dir>',
    )
    .addOption(
      new Option('--record-input <mode>', 'record the claim input in full or only its counts')
        .choices(['full', 'summary'])
        .default('full'),
    )
    .option(
      '--no-record-ids',
      'leave server ids out of recordings, so a re-run writes identical files',
    )
    .option(
      '--propose-at <score>',
      'propose at or above this score',
      score,
      DEFAULT_POLICY.proposeAt,
    )
    .option(
      '--ask-at <score>',
      'propose with a question at or above this score',
      score,
      DEFAULT_POLICY.askAt,
    )
    .option('--llm-model <name>', 'declared LLM model (the policy stands in for one)', SIM_POLICY)
    .option('-q, --quiet', 'no per-task log on stderr')
    .option('--json', 'print the report as JSON')
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showHelpAfterError()
    .exitOverride()
    .action((opts: SimOptions) => run(opts));
}

function tokenOf(opts: SimOptions, io: SimIo): string {
  const token = opts.token ?? io.env['PROA_TOKEN'];
  if (!token) {
    throw new SimError(
      'an agent token is needed: --token or PROA_TOKEN (create one with: proa token create --project <key> --scopes read,propose)',
    );
  }
  if (token.startsWith(OWNER_KEY_PREFIX)) {
    throw new SimError(
      'that is the owner key; agents use agent tokens (proa_at_…), never the owner key',
    );
  }
  if (!token.startsWith(AGENT_TOKEN_PREFIX))
    throw new SimError(`an agent token starts with ${AGENT_TOKEN_PREFIX}`);
  return token;
}

function summaryText(report: AgentReport): string {
  const t = report.totals;
  const results = (o: AgentReport['totals']['outcomes'], withdrawn: number) =>
    `results: applied ${o.applied}, duplicate ${o.duplicate}, suppressed ${o.suppressed}, reopened ${o.reopened}, invalid ${o.invalid}; withdrawn by supersession ${withdrawn}`;
  const lines = [
    `${AGENT_NAME}: ${t.tasks} tasks (${t.submitted} submitted, ${t.dryRun} dry run, ${t.failed} failed); stopped: ${report.stop}`,
  ];
  const r = report.byKind.relations;
  if (report.kinds.includes('relations')) {
    lines.push(
      `  relations: ${r.tasks} tasks, ${r.proposed} proposals (${r.questions} with a question), ${r.noLinks} no-links`,
      `    ${results(r.outcomes, r.withdrawn)}`,
    );
  }
  const p = report.byKind.placement;
  if (report.kinds.includes('placement')) {
    lines.push(
      `  placement: ${p.tasks} tasks, ${p.proposed} placements (${p.questions} with a question), ${p.unsure} unsure, ${p.skipped} skipped, ${p.followUps} follow-ups`,
      `    ${results(p.outcomes, p.withdrawn)}`,
    );
  }
  for (const f of report.recordings) lines.push(`  recorded: ${f}`);
  return `${lines.join('\n')}\n`;
}

/** Runs the agent with parsed options; returns the report. */
export async function simulate(opts: SimOptions, io: SimIo): Promise<AgentReport> {
  const url = (opts.url ?? io.env['PROA_URL'] ?? DEFAULT_URL).replace(/\/+$/, '');
  const token = tokenOf(opts, io);
  const log = opts.quiet ? () => {} : (line: string) => io.stderr(`${line}\n`);
  const connection: Connection =
    opts.stdio || opts.stdioCommand !== undefined
      ? { kind: 'stdio', url, token, ...bridgeCommand(opts.stdioCommand) }
      : { kind: 'http', url, token, ...(io.fetch ? { fetch: io.fetch } : {}) };
  const session = await connect(
    connection,
    { name: 'proa-agent-sim', version: simPackage.version },
    log,
  );
  try {
    return await runAgent(session, {
      ...(opts.project ? { projectId: opts.project } : {}),
      ...(opts.model ? { modelKey: opts.model } : {}),
      ...(opts.kinds ? { kinds: opts.kinds } : {}),
      ...(opts.maxTasks ? { maxTasks: opts.maxTasks } : {}),
      dryRun: opts.dryRun === true,
      policy: { proposeAt: opts.proposeAt, askAt: opts.askAt },
      llmModel: opts.llmModel,
      recorder: opts.record
        ? createRecorder({
            dir: path.resolve(io.cwd, opts.record),
            input: opts.recordInput,
            ids: opts.recordIds,
          })
        : null,
      log,
    });
  } finally {
    await session.close();
  }
}

/**
 * Runs the CLI; returns the exit code (0: done, 1: a task failed or the run
 * broke off, 2: usage). Never throws.
 */
export async function runSim(argv: readonly string[], io: SimIo = processIo): Promise<number> {
  let code = 0;
  const program = buildProgram(io, async (opts) => {
    const report = await simulate(opts, io);
    io.stdout(opts.json ? `${JSON.stringify(report, null, 2)}\n` : summaryText(report));
    if (report.totals.failed > 0) code = 1;
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
    return code;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 2;
    io.stderr(`proa-agent-sim: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
