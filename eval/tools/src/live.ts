// eval:live (CONCEPT §7): records a live run from what its project stored and
// judges it with the live gate.
//
//   pnpm eval:live --project <key> [--landscape <name>] [--url <url>] [--token <token>]
//                  [--agent <name>] [--out <dir>] [--corpus <dir>] [--no-write] [--json]
//
// A live run is one agent (Claude Desktop, Claude Code, …) working a fresh
// project seeded from eval/corpus (`proa seed <landscape> --project <key>
// --issue-tokens --token-name <run>`). eval:live reads the project's done
// analyses and their stored submissions over REST (live-recordings.ts),
// writes them as proa-recording/1 lines to
// <out>/<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl (each file
// afresh; the agent is the token name, the declared procedure and model come
// from the submissions), scores them with the eval:replay scorer and prints
// the live gate (live-gate.ts) of the procedure versions on that landscape,
// counting the other recordings in <out>. Exit codes: 0 when every gate
// passes or is incomplete, 1 when a gate fails or on any error.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ProjectKey } from '@proa/contracts';
import { getProcedure } from '@proa/procedures';

import { CORPUS_DIR } from './corpus.ts';
import { runLandscape } from './landscape.ts';
import { formatLiveGate, liveGates, splitProcedure, type LiveGate } from './live-gate.ts';
import { DEFAULT_PROA_URL, buildRecordings, fetchStoredAnalyses } from './live-recordings.ts';
import { RECORDINGS_DIR, landscapeDir, loadRecordings, parseRecording, type RecordingFile } from './recordings.ts';
import { scoreLine } from './replay-report.ts';
import { scoreRecording, type ReplayScore } from './replay-score.ts';

export const USAGE = `usage: pnpm eval:live --project <key> [options]

Records the live run of a project (its done analyses and stored submissions)
in eval/recordings and checks the live gate.

  --project <key>       project the run worked on (required)
  --landscape <name>    corpus landscape the project was seeded from
                        (default: the project key, if it is one)
  --url <url>           ProA server (env PROA_URL, default ${DEFAULT_PROA_URL})
  --token <token>       the run's agent token or the owner key proa_ok_… (env PROA_TOKEN)
  --agent <name>        agent segment of the recording (default: the token name)
  --out <dir>           recordings directory (default: eval/recordings)
  --corpus <dir>        corpus directory (default: eval/corpus)
  --no-write            score and check without writing
  --json                print JSON
`;

export interface LiveIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  /** Base of relative paths: where `pnpm eval:live` was started (`INIT_CWD`), not eval/tools. */
  cwd: string;
  fetch: typeof globalThis.fetch;
}

export const processIo: LiveIo = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  env: process.env,
  cwd: process.env['INIT_CWD'] ?? process.cwd(),
  fetch: (input, init) => globalThis.fetch(input, init),
};

class UsageError extends Error {}

/** What `--json` prints per recording: the numbers, not the pairs (no ground truth on the console). */
function runSummary(s: ReplayScore) {
  return {
    file: s.file,
    procedure: s.procedure,
    agent: s.agent,
    llmModel: s.llmModel,
    landscape: s.landscape,
    split: s.split,
    tasks: s.tasks,
    pairs: s.pairs,
    overall: s.overall,
    withRules: s.withRules,
    mustNotLink: s.mustNotLinkHits.length,
    mustNotLinkHighConfidence: s.mustNotLinkHighConfidence,
    questions: s.questions.pairs,
    noLinks: s.noLinks.pairs,
    invalid: s.items.invalid,
  };
}

/** Runs eval:live; returns the exit code and never throws. */
export async function runLive(argv: readonly string[], io: LiveIo = processIo): Promise<number> {
  try {
    return await live(argv, io);
  } catch (err) {
    io.stderr(`eval:live: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof UsageError) io.stderr(`\n${USAGE}`);
    return 1;
  }
}

function parseOptions(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        project: { type: 'string' },
        landscape: { type: 'string' },
        url: { type: 'string' },
        token: { type: 'string' },
        agent: { type: 'string' },
        out: { type: 'string' },
        corpus: { type: 'string' },
        'no-write': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

async function live(argv: readonly string[], io: LiveIo): Promise<number> {
  const values = parseOptions(argv);
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  const project = values.project;
  if (!project) throw new UsageError('--project is required');
  const token = values.token ?? io.env['PROA_TOKEN'];
  if (!token) throw new UsageError("give the run's agent token or the owner key with --token or PROA_TOKEN");
  const url = values.url ?? io.env['PROA_URL'] ?? DEFAULT_PROA_URL;
  const out = path.resolve(io.cwd, values.out ?? RECORDINGS_DIR);
  const corpus = path.resolve(io.cwd, values.corpus ?? CORPUS_DIR);

  // The landscape: named, or the project key (`proa seed` names projects after landscapes).
  const landscape = (values.landscape ?? project).replace(/^_+/, '');
  let dir: string | null = null;
  if (ProjectKey.safeParse(landscape).success) dir = await landscapeDir(corpus, landscape).catch(() => null);
  if (dir === null) {
    throw new UsageError(
      values.landscape !== undefined
        ? `no landscape ${values.landscape} in ${corpus}`
        : `project ${project} is not named after a corpus landscape; name the landscape it was seeded from with --landscape`,
    );
  }

  const stored = await fetchStoredAnalyses({ url, token, project, fetch: io.fetch });
  if (stored.length === 0) throw new Error(`project ${project} has no done analyses yet`);
  const built = buildRecordings(stored, { landscape, ...(values.agent !== undefined ? { agent: values.agent } : {}) });

  // The declared procedure should be the one this checkout serves.
  const declared = new Map(built.flatMap((b) => b.lines.map((l) => [`${l.procedure.id}@${l.procedure.version}`, l.procedure])));
  for (const [name, { id, version }] of declared) {
    const current = getProcedure(id);
    if (!current) io.stderr(`eval:live: warning: the declared procedure ${name} is unknown to this checkout\n`);
    else if (current.version !== version) {
      io.stderr(`eval:live: warning: the run declared ${name}; the current procedure is ${current.id}@${current.version}\n`);
    }
  }

  const files: RecordingFile[] = built.map((b) => parseRecording(b.path, b.text));
  if (!values['no-write']) {
    for (const b of built) {
      const file = path.join(out, b.path);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, b.text);
    }
  }

  // Score the built files with every other recording of the same procedures on this landscape (baselines, runs).
  const ids = new Set(files.map((f) => splitProcedure(f.procedure).id));
  const byPath = new Map<string, RecordingFile>();
  for (const f of await loadRecordings(out)) byPath.set(f.path, f);
  for (const f of files) byPath.set(f.path, f);
  const run = await runLandscape(dir);
  const scores = [...byPath.values()]
    .filter((f) => f.landscape === landscape && ids.has(splitProcedure(f.procedure).id))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => scoreRecording(f, run));
  const builtPaths = new Set(files.map((f) => f.path));
  const runs = scores.filter((s) => builtPaths.has(s.file));
  const procedures = new Set(files.map((f) => f.procedure));
  const gates: LiveGate[] = liveGates(scores).filter((g) => procedures.has(g.procedure));

  if (values.json) {
    io.stdout(
      `${JSON.stringify(
        {
          project,
          landscape,
          written: !values['no-write'],
          recordings: built.map((b) => ({ path: b.path, lines: b.lines.length })),
          runs: runs.map(runSummary),
          gates,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const b of built) {
      const where = values['no-write'] ? `${b.path} (not written)` : path.relative(io.cwd, path.join(out, b.path));
      io.stdout(`${where}: ${b.lines.length} ${b.lines.length === 1 ? 'task' : 'tasks'} from project ${project}\n`);
    }
    for (const s of runs) io.stdout(`${scoreLine(s)}\n`);
    for (const g of gates) io.stdout(`${formatLiveGate(g)}\n`);
    if (gates.length === 0) io.stdout('live gate: no live runs (only agent-sim recordings)\n');
  }
  return gates.some((g) => g.status === 'fail') ? 1 : 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runLive(process.argv.slice(2));
}
