// eval:replay (CONCEPT §7, M2 item 8): scores recorded agent submissions,
// no LLM, deterministic.
//
//   pnpm eval:replay            (from the repository root)
//   node src/replay.ts [--recordings <dir>] [--corpus <dir>] [--out <dir>] [--no-write]
//
// Reads eval/recordings/<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl,
// scores each file against eval/corpus/<landscape>/expected.yaml (precision,
// recall and F1 overall, per relation type and tag; must_not_link hits;
// questions; no-links), evaluates the live gate (live-gate.ts; one gate per
// procedure version, landscape and declared llmModel) and writes
// eval/reports/replay.{md,json}. Relative paths resolve against INIT_CWD,
// the repository root for `pnpm eval:replay`, as eval:live's do. It only
// reports (eval:live enforces the live gate): exit 1 only if a recording
// cannot be read or names a landscape the corpus does not have; 2 on a usage
// error (an unknown option, a named --recordings directory that does not
// exist: only the default may be absent).
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { REPORTS_DIR } from './candidates.ts';
import { CORPUS_DIR } from './corpus.ts';
import { runLandscape, type LandscapeRun } from './landscape.ts';
import { formatLiveGate, liveGates } from './live-gate.ts';
import { RECORDINGS_DIR, landscapeDir, loadRecordings } from './recordings.ts';
import { renderReplayMarkdown, scoreLine, type ReplayReport } from './replay-report.ts';
import { scoreRecording } from './replay-score.ts';

/** Scores every recording below `recordingsDir`, sorted by path. */
export async function replay(
  recordingsDir: string = RECORDINGS_DIR,
  corpusDir: string = CORPUS_DIR,
): Promise<ReplayReport> {
  const files = await loadRecordings(recordingsDir);
  const runs = new Map<string, LandscapeRun>();
  const recordings = [];
  for (const f of files) {
    let run = runs.get(f.landscape);
    if (!run) {
      run = await runLandscape(await landscapeDir(corpusDir, f.landscape));
      runs.set(f.landscape, run);
    }
    recordings.push(scoreRecording(f, run));
  }
  return { recordings, liveGate: liveGates(recordings) };
}

export const USAGE = 'usage: pnpm eval:replay [--recordings <dir>] [--corpus <dir>] [--out <dir>] [--no-write]\n';

export interface ReplayIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /**
   * Base of relative paths: pnpm's INIT_CWD, which is the repository root for
   * `pnpm eval:replay` wherever in the checkout it is started; not eval/tools.
   */
  cwd: string;
}

export const processIo: ReplayIo = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  cwd: process.env['INIT_CWD'] ?? process.cwd(),
};

/** A wrong call: exit code 2, with the usage text. */
class UsageError extends Error {}

/** Exit code of a usage error, as eval:live has it. */
const USAGE_EXIT = 2;

/**
 * Runs eval:replay; returns the exit code (0: reported, whatever the live
 * gate says; 1: a recording cannot be scored or the report not written;
 * 2: usage) and never throws.
 */
export async function runReplay(argv: readonly string[], io: ReplayIo = processIo): Promise<number> {
  try {
    return await replayCommand(argv, io);
  } catch (err) {
    io.stderr(`eval:replay: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!(err instanceof UsageError)) return 1;
    io.stderr(`\n${USAGE}`);
    return USAGE_EXIT;
  }
}

function parseOptions(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        recordings: { type: 'string' },
        corpus: { type: 'string' },
        out: { type: 'string' },
        'no-write': { type: 'boolean', default: false },
      },
    }).values;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function replayCommand(argv: readonly string[], io: ReplayIo): Promise<number> {
  const values = parseOptions(argv);
  const recordingsDir = path.resolve(io.cwd, values.recordings ?? RECORDINGS_DIR);
  const corpusDir = path.resolve(io.cwd, values.corpus ?? CORPUS_DIR);
  const out = path.resolve(io.cwd, values.out ?? REPORTS_DIR);
  // eval/recordings may be absent (no recordings yet); a directory named on purpose must exist.
  if (values.recordings !== undefined && !(await isDirectory(recordingsDir))) {
    throw new UsageError(`no recordings directory ${recordingsDir}`);
  }
  const report = await replay(recordingsDir, corpusDir);
  for (const s of report.recordings) io.stdout(`${scoreLine(s)}\n`);
  if (report.recordings.length === 0) io.stdout('no recordings\n');
  for (const g of report.liveGate) io.stdout(`${formatLiveGate(g)}\n`);
  if (report.liveGate.length === 0) io.stdout('live gate: no live runs yet\n');
  if (!values['no-write']) {
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'replay.md'), renderReplayMarkdown(report));
    await writeFile(path.join(out, 'replay.json'), `${JSON.stringify(report, null, 2)}\n`);
    io.stdout(`report: ${path.relative(io.cwd, path.join(out, 'replay.md'))}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runReplay(process.argv.slice(2));
}
