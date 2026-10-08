// eval:replay (CONCEPT §7, M2 item 8): scores recorded agent submissions,
// no LLM, deterministic.
//
//   pnpm eval:replay            (from the repository root)
//   node src/replay.ts [--recordings <dir>] [--corpus <dir>] [--out <dir>] [--no-write]
//
// Reads eval/recordings/<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl,
// scores each file against eval/corpus/<landscape>/expected.yaml (precision,
// recall and F1 overall, per relation type and tag; must_not_link hits;
// questions; no-links) and writes eval/reports/replay.{md,json}. It reports
// and gates nothing: exit 1 only if a recording cannot be read or names a
// landscape the corpus does not have.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { REPORTS_DIR } from './candidates.ts';
import { CORPUS_DIR } from './corpus.ts';
import { runLandscape, type LandscapeRun } from './landscape.ts';
import { RECORDINGS_DIR, landscapeDir, loadRecordings } from './recordings.ts';
import { renderReplayMarkdown, type ReplayReport } from './replay-report.ts';
import { scoreRecording } from './replay-score.ts';
import { formatRatio } from './score.ts';

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
  return { recordings };
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
  for (const s of report.recordings) {
    console.log(
      `${s.file}: ${s.tasks.lines} tasks, ${s.pairs} pairs; precision ${formatRatio(s.overall.precision)}, ` +
        `recall ${formatRatio(s.overall.recall)} (∪ rules ${formatRatio(s.withRules.recall)}), ` +
        `F1 ${formatRatio(s.overall.f1)}; must_not_link ${s.mustNotLinkHits.length} ` +
        `(${s.mustNotLinkHighConfidence} at ≥ 0.8); ${s.questions.pairs} questions`,
    );
  }
  if (report.recordings.length === 0) console.log('no recordings');
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
