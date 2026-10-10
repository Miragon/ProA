// eval:replay for placement recordings (M4-VALUE-CHAIN.md §6, M4b S5): scores
// the recorded submissions of `placement` tasks with the scorer of
// eval:placements (placements-score.ts) against the golden placements.
//
// Per recording: every line must have worked on the golden chain (its
// `valueChain.contentHash` equals the golden file's sha256), else the run is
// not comparable (an edited chain) and eval:replay exits 1. The run's
// placement set is the union of its valid items over all lines (outcomes
// applied, duplicate, suppressed, reopened; `@outside` included), one per
// (process, step) with its highest confidence, ranked per process by
// confidence (ties by step id), so recall@1 is each process's most confident
// step. Numbers: precision, recall, recall@1 and @3, area recall@1, F1, trap
// rate, traps at confidence ≥ 0.8 (the live gate's), unsure, skipped and
// invalid items, next to `baseline-prefix/1` with and without votes on the
// same landscape.
//
// Holdout hygiene: for a landscape of split `holdout` only aggregate numbers
// leave this module (redactSystemScore: no items, per-tag numbers only for
// tags with at least HOLDOUT_MIN_GROUP processes, no per-item lists).
import path from 'node:path';

import { isPlacementLine, type PlacementRecordingLine } from '@proa/contracts';

import { CORPUS_DIR } from './corpus.ts';
import { VALUE_CHAINS_DIR, loadPlacementRun } from './placements-load.ts';
import {
  HOLDOUT_MIN_GROUP,
  OUTSIDE,
  redactSystemScore,
  scorePlacementProposals,
  scorePlacementRun,
  type PlacementClass,
  type PlacementProposal,
  type PlacementRun,
  type ScoredItem,
  type SystemScore,
} from './placements-score.ts';
import { landscapeDir, type RecordingFile } from './recordings.ts';

/** A recording of a chain other than the golden one: exit 1, the numbers would mean nothing. */
export class NotComparableError extends Error {
  override readonly name = 'NotComparableError';
}

/** What the report says instead of the per-item lists of a holdout recording. */
export const PLACEMENT_HOLDOUT_NOTE =
  'holdout: aggregate numbers only, no per-item lists, per-tag numbers only for tags with at least ' +
  `${HOLDOUT_MIN_GROUP} processes (eval/README.md, holdout hygiene)`;

/** The numbers of a placement run or a baseline row. */
export interface PlacementNumbers {
  /** Distinct (process, step) placements scored. */
  proposals: number;
  /** hit / (hit + trap + wrong) over every placement; may and coarse are neutral. */
  precision: number | null;
  /** Processes whose must is among the placements / processes. */
  recall: number | null;
  /** The same over each process's top-ranked placement. */
  recallAt1: number | null;
  recallAt3: number | null;
  precisionAt1: number | null;
  /** Recall@1 by top-level area (M4 §6, level 0). */
  areaRecallAt1: number | null;
  f1: number | null;
  /** Processes with a trap placement / processes with must_not. */
  trapRate: number | null;
  /** Trap placements with confidence ≥ 0.8 (the live gate allows none). */
  trapsHighConfidence: number;
}

function numbersOf(s: SystemScore): PlacementNumbers {
  return {
    proposals: s.proposals,
    precision: s.leaf.all.precision,
    recall: s.leaf.all.recall,
    recallAt1: s.leaf.at1?.recall ?? null,
    recallAt3: s.leaf.at3?.recall ?? null,
    precisionAt1: s.leaf.at1?.precision ?? null,
    areaRecallAt1: s.area.at1?.recall ?? null,
    f1: s.leaf.all.f1,
    trapRate: s.leaf.all.trapRate,
    trapsHighConfidence: s.trapsHighConfidence,
  };
}

/** `baseline-prefix/1` on a landscape, top-1 and top-3 (the baseline has no confidences). */
export interface PlacementBaselines {
  landscape: string;
  split: 'dev' | 'holdout';
  /** sha256 of the golden chain file: recordings must name it. */
  contentHash: string;
  processes: number;
  withVotes: PlacementNumbers;
  withoutVotes: PlacementNumbers;
}

/** The baselines of a loaded landscape (the rows of eval:placements). */
export function placementBaselines(landscape: string, run: PlacementRun): PlacementBaselines {
  const { systems } = scorePlacementRun(run);
  return {
    landscape,
    split: run.split,
    contentHash: run.golden.contentHash,
    processes: run.golden.placements.length,
    withVotes: numbersOf(systems.baseline),
    withoutVotes: numbersOf(systems.baselineNoVotes),
  };
}

/** A process the run did not place on its must (dev lists only). */
export interface MissedProcess {
  process: string;
  /** The run's top-ranked step, `null` without a placement. */
  top: string | null;
  /** The class of that step, `unsure` (an unsure verdict, no placement) or `none`. */
  class: PlacementClass | 'unsure' | 'none';
}

export interface PlacementReplayScore {
  /** Path below `eval/recordings`. */
  file: string;
  procedure: string;
  agent: string;
  llmModel: string;
  landscape: string;
  split: 'dev' | 'holdout';
  /** The chain revisions the lines worked on (all with the golden content hash). */
  valueChain: { revs: number[]; contentHash: string };
  tasks: { lines: number; submitted: number; dryRun: number; failed: number; followUps: number };
  /** Golden processes of the landscape. */
  processes: number;
  /** Every placement item of the submissions, by outcome; `invalid` by reason. */
  items: { total: number; outcomes: Record<string, number>; invalid: Record<string, number> };
  /** Valid items with a question, and on `@outside`. */
  questions: number;
  outside: number;
  /** Stored unsure verdicts. */
  unsure: number;
  /** Input processes the server counted as skipped (no verdict). */
  skipped: number;
  /** Invalid placement and unsure items. */
  invalid: number;
  numbers: PlacementNumbers;
  /** The scorer's view of the run; for the holdout without items and small tags. */
  system: SystemScore;
  /** Dev only: per-item lists. */
  lists?: { traps: ScoredItem[]; wrongAt1: ScoredItem[]; missed: MissedProcess[]; unsure: string[] };
  /** Set for the holdout: what the score leaves out. */
  note?: string;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function bump(r: Record<string, number>, key: string): void {
  r[key] = (r[key] ?? 0) + 1;
}

const sorted = (r: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(r).sort(([a], [b]) => byCodePoint(a, b)));

/**
 * The placement lines of a recording file.
 *
 * @throws {NotComparableError} if a line worked on another chain than the golden one
 */
function placementLines(file: RecordingFile, contentHash: string): PlacementRecordingLine[] {
  const lines = file.lines.filter(isPlacementLine);
  for (const [i, line] of lines.entries()) {
    if (line.valueChain.contentHash !== contentHash) {
      throw new NotComparableError(
        `${file.path}: not comparable (edited chain): line ${i + 1} worked on r${line.valueChain.rev} with content ` +
          `hash ${line.valueChain.contentHash.slice(0, 12)}…, the golden chain has ${contentHash.slice(0, 12)}…`,
      );
    }
  }
  return lines;
}

/**
 * The union of a run's valid placement items, one per (process, step) with
 * its highest confidence, ranked per process by confidence (ties by step id).
 */
export function rankedPlacements(lines: readonly PlacementRecordingLine[]): PlacementProposal[] {
  const best = new Map<string, { process: string; step: string; confidence: number }>();
  for (const line of lines) {
    if (line.outcome !== 'submitted' || !line.result) continue;
    for (const [i, item] of line.submission.placements.entries()) {
      const answered = line.result.items.find((x) => x.index === i)?.result;
      if (answered === undefined || answered.startsWith('invalid:')) continue;
      const key = `${item.process}\n${item.step}`;
      const prev = best.get(key);
      if (!prev || item.confidence > prev.confidence) {
        best.set(key, { process: item.process, step: item.step, confidence: item.confidence });
      }
    }
  }
  const byProcess = new Map<string, Array<{ process: string; step: string; confidence: number }>>();
  for (const p of best.values()) byProcess.set(p.process, [...(byProcess.get(p.process) ?? []), p]);
  const out: PlacementProposal[] = [];
  for (const process of [...byProcess.keys()].sort(byCodePoint)) {
    const ranked = (byProcess.get(process) ?? []).sort(
      (a, b) => b.confidence - a.confidence || byCodePoint(a.step, b.step),
    );
    ranked.forEach((p, i) => out.push({ ...p, rank: i + 1 }));
  }
  return out;
}

/**
 * Scores one recording of placement lines against a loaded landscape (pure).
 *
 * @throws {NotComparableError} if a line worked on another chain than the golden one
 */
export function scorePlacementRecording(file: RecordingFile, run: PlacementRun): PlacementReplayScore {
  const lines = placementLines(file, run.golden.contentHash);
  const outcomes: Record<string, number> = {};
  const invalid: Record<string, number> = {};
  let total = 0;
  let questions = 0;
  let outside = 0;
  let unsure = 0;
  let skipped = 0;
  let invalidUnsure = 0;
  const unsureProcesses = new Set<string>();
  for (const line of lines) {
    skipped += line.result?.skipped.count ?? 0;
    for (const [i, item] of line.submission.placements.entries()) {
      total++;
      const answered = line.result?.items.find((x) => x.index === i)?.result ?? 'unanswered';
      bump(outcomes, answered.startsWith('invalid:') ? 'invalid' : answered);
      if (answered.startsWith('invalid:')) {
        bump(invalid, answered.slice('invalid:'.length));
        continue;
      }
      if (answered === 'unanswered') continue;
      if (item.question !== null && item.question !== '') questions++;
      if (item.step === OUTSIDE) outside++;
    }
    for (const [i, item] of line.submission.unsure.entries()) {
      const answered = line.result?.unsure.items.find((x) => x.index === i)?.result;
      if (answered === 'stored') {
        unsure++;
        unsureProcesses.add(item.process);
      } else if (answered?.startsWith('invalid:')) invalidUnsure++;
    }
  }
  const proposals = rankedPlacements(lines);
  const system = scorePlacementProposals(run.golden, proposals);
  const revs = [...new Set(lines.map((l) => l.valueChain.rev))].sort((a, b) => a - b);
  const score: PlacementReplayScore = {
    file: file.path,
    procedure: file.procedure,
    agent: file.agent,
    llmModel: file.llmModel,
    landscape: file.landscape,
    split: run.split,
    valueChain: { revs, contentHash: run.golden.contentHash },
    tasks: {
      lines: lines.length,
      submitted: lines.filter((l) => l.outcome === 'submitted').length,
      dryRun: lines.filter((l) => l.outcome === 'dry-run').length,
      failed: lines.filter((l) => l.outcome === 'failed').length,
      followUps: lines.filter((l) => l.result?.followUp === true).length,
    },
    processes: run.golden.placements.length,
    items: { total, outcomes: sorted(outcomes), invalid: sorted(invalid) },
    questions,
    outside,
    unsure,
    skipped,
    invalid: Object.values(invalid).reduce((a, b) => a + b, 0) + invalidUnsure,
    numbers: numbersOf(system),
    system,
  };
  if (run.split === 'holdout') {
    return { ...score, system: redactSystemScore(system), note: PLACEMENT_HOLDOUT_NOTE };
  }
  const items = system.items ?? [];
  const found = new Set(items.filter((i) => i.class === 'hit').map((i) => i.process));
  const top = new Map(items.filter((i) => i.rank === 1).map((i) => [i.process, i]));
  return {
    ...score,
    lists: {
      traps: items.filter((i) => i.class === 'trap'),
      wrongAt1: items.filter((i) => i.rank === 1 && i.class === 'wrong'),
      missed: run.golden.placements
        .filter((p) => !found.has(p.process))
        .map((p) => {
          const t = top.get(p.process);
          return {
            process: p.process,
            top: t?.step ?? null,
            class: t ? t.class : unsureProcesses.has(p.process) ? ('unsure' as const) : ('none' as const),
          };
        })
        .sort((a, b) => byCodePoint(a.process, b.process)),
      unsure: [...unsureProcesses].sort(byCodePoint),
    },
  };
}

/** Whether a recording holds placement lines (a file holds one kind; mixed files are refused). */
export function isPlacementRecording(file: RecordingFile): boolean {
  return file.lines.length > 0 && file.lines.every(isPlacementLine);
}

export interface PlacementReplay {
  recordings: PlacementReplayScore[];
  /** Per landscape with placement recordings, sorted by landscape. */
  baselines: PlacementBaselines[];
}

export interface PlacementReplayDirs {
  corpusDir?: string;
  valueChainsDir?: string;
}

/**
 * Loads the golden data of every landscape the placement recordings name
 * (once each) and scores them, sorted by path.
 *
 * @throws {NotComparableError} for a recording on an edited chain
 * @throws {PlacementDataError} for missing or unreadable golden data (e.g. `_sample`)
 */
export async function replayPlacements(
  files: readonly RecordingFile[],
  dirs: PlacementReplayDirs = {},
): Promise<PlacementReplay> {
  const corpusDir = dirs.corpusDir ?? CORPUS_DIR;
  const valueChainsDir = dirs.valueChainsDir ?? VALUE_CHAINS_DIR;
  const runs = new Map<string, PlacementRun>();
  const recordings: PlacementReplayScore[] = [];
  for (const f of [...files].sort((a, b) => byCodePoint(a.path, b.path))) {
    let run = runs.get(f.landscape);
    if (!run) {
      const name = path.basename(await landscapeDir(corpusDir, f.landscape));
      run = await loadPlacementRun(name, { corpusDir, valueChainsDir });
      runs.set(f.landscape, run);
    }
    recordings.push(scorePlacementRecording(f, run));
  }
  const baselines = [...runs.entries()]
    .sort(([a], [b]) => byCodePoint(a, b))
    .map(([landscape, run]) => placementBaselines(landscape, run));
  return { recordings, baselines };
}
