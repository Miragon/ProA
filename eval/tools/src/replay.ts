// eval:replay (CONCEPT §7, M2 item 8): scores recorded agent submissions,
// no LLM, deterministic.
//
//   pnpm eval:replay            (from the repository root)
//   node src/replay.ts [--recordings <dir>] [--corpus <dir>] [--out <dir>] [--no-write]
//
// Reads eval/recordings/<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl,
// scores each file against eval/corpus/<landscape>/expected.yaml (precision,
// recall and F1 overall, per relation type and tag; must_not_link hits;
// questions; no-links), evaluates the live gate (live-gate.ts) and writes
// eval/reports/replay.{md,json}. It only reports (eval:live enforces the
// live gate): exit 1 only if a recording cannot be read or names a
// landscape the corpus does not have.
import { mkdir, writeFile } from 'node:fs/promises';
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

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      recordings: { type: 'string', default: RECORDINGS_DIR },
      corpus: { type: 'string', default: CORPUS_DIR },
      out: { type: 'string', default: REPORTS_DIR },
      'no-write': { type: 'boolean', default: false },
    },
  });
  let report: ReplayReport;
  try {
    report = await replay(path.resolve(values.recordings), path.resolve(values.corpus));
  } catch (err) {
    console.error(`eval:replay: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  for (const s of report.recordings) console.log(scoreLine(s));
  if (report.recordings.length === 0) console.log('no recordings');
  for (const g of report.liveGate) console.log(formatLiveGate(g));
  if (report.liveGate.length === 0) console.log('live gate: no live runs yet');
  if (!values['no-write']) {
    await mkdir(values.out, { recursive: true });
    await writeFile(path.join(values.out, 'replay.md'), renderReplayMarkdown(report));
    await writeFile(path.join(values.out, 'replay.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report: ${path.relative(process.cwd(), path.join(values.out, 'replay.md'))}`);
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
