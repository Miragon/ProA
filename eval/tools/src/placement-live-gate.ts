// The placement live gate (M4-VALUE-CHAIN.md §6, M4b S5): may a placement
// procedure version be released, judged by the recordings of live runs? A
// pure function over placement replay scores, shared by eval:live (exit 1 on
// `fail`) and the "Placement live gate" section of eval:replay.
//
// The live runs are the placement recordings of every agent but `agent-sim`
// (one file per run: a fresh project under its own agent token). They are
// grouped by procedure `<id>@<version>`, landscape and declared `llmModel`. A
// group
// - fails if any run places a process on a must_not step (or below one) with
//   confidence ≥ 0.8, or if the mean recall@1 of its runs is below the bar:
//   the higher recall@1 of the two `baseline-prefix/1` rows (with and without
//   votes) plus 20 points;
// - else is incomplete with fewer than 3 runs or without a baseline;
// - else passes.
// Recall@1 ranks each run's placements per process by confidence (eval:replay).
import { MIN_LIVE_RUNS, SIM_AGENT, gateLabel } from './live-gate.ts';
import type { PlacementBaselines, PlacementReplayScore } from './placements-replay.ts';
import { HIGH_CONFIDENCE } from './replay-score.ts';
import { formatRatio } from './score.ts';

/** The mean recall@1 must beat the better baseline row by this much (20 points). */
export const PLACEMENT_RECALL_MARGIN = 0.2;
/** Tolerance of the comparison: exactly on the bar passes despite rounding. */
const EPSILON = 1e-9;

/** What the gate reads of a placement replay score. */
export type PlacementGateInput = Pick<
  PlacementReplayScore,
  'file' | 'procedure' | 'agent' | 'llmModel' | 'landscape' | 'split' | 'numbers'
>;

/** The baseline rows the gate needs per landscape. */
export type PlacementGateBaselines = Pick<PlacementBaselines, 'landscape' | 'withVotes' | 'withoutVotes'>;

export interface PlacementLiveRun {
  /** Path below `eval/recordings`. */
  file: string;
  agent: string;
  precision: number | null;
  recall: number | null;
  recallAt1: number | null;
  /** Trap placements with confidence ≥ {@link HIGH_CONFIDENCE}. */
  trapsHighConfidence: number;
}

export interface PlacementLiveGate {
  /** `<id>@<version>`. */
  procedure: string;
  landscape: string;
  llmModel: string;
  split: 'dev' | 'holdout';
  status: 'pass' | 'fail' | 'incomplete';
  runs: number;
  /** Means over the runs; null when no run has a value. */
  precision: number | null;
  recall: number | null;
  recallAt1: number | null;
  areaRecallAt1: number | null;
  f1: number | null;
  /** Trap placements with confidence ≥ 0.8, summed over the runs. */
  trapsHighConfidence: number;
  /** `baseline-prefix/1` recall@1 with and without votes, and the bar (the higher + 20 points). */
  baseline: { withVotes: number | null; withoutVotes: number | null; bar: number | null };
  /** Why the gate fails or is incomplete (every reason that applies); empty when it passes. */
  reasons: string[];
  liveRuns: PlacementLiveRun[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function mean(values: ReadonlyArray<number | null>): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** The bar: the higher recall@1 of the two baseline rows plus the margin; null without either. */
export function placementBar(b: PlacementGateBaselines | undefined): number | null {
  const rows = [b?.withVotes.recallAt1 ?? null, b?.withoutVotes.recallAt1 ?? null].filter(
    (v): v is number => v !== null,
  );
  return rows.length === 0 ? null : Math.max(...rows) + PLACEMENT_RECALL_MARGIN;
}

/**
 * The placement live gate of every procedure version, landscape and declared
 * model with at least one live run, sorted by procedure, landscape and model.
 */
export function placementLiveGates(
  scores: readonly PlacementGateInput[],
  baselines: readonly PlacementGateBaselines[],
): PlacementLiveGate[] {
  const groups = new Map<string, PlacementGateInput[]>();
  for (const s of scores) {
    if (s.agent === SIM_AGENT) continue;
    const key = `${s.procedure}\n${s.landscape}\n${s.llmModel}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const gates: PlacementLiveGate[] = [];
  for (const runs of groups.values()) {
    const first = runs[0];
    if (!first) continue;
    const live: PlacementLiveRun[] = runs
      .map((s) => ({
        file: s.file,
        agent: s.agent,
        precision: s.numbers.precision,
        recall: s.numbers.recall,
        recallAt1: s.numbers.recallAt1,
        trapsHighConfidence: s.numbers.trapsHighConfidence,
      }))
      .sort((a, b) => byString(a.file, b.file));
    const b = baselines.find((x) => x.landscape === first.landscape);
    const bar = placementBar(b);
    const recallAt1 = mean(live.map((r) => r.recallAt1));
    const traps = live.reduce((n, r) => n + r.trapsHighConfidence, 0);

    const failures: string[] = [];
    if (traps > 0) {
      const inRuns = live.filter((r) => r.trapsHighConfidence > 0).length;
      failures.push(
        `${traps} must_not ${traps === 1 ? 'placement' : 'placements'} with confidence ≥ ${HIGH_CONFIDENCE} ` +
          `(in ${inRuns} of ${live.length} ${live.length === 1 ? 'run' : 'runs'})`,
      );
    }
    if (bar !== null && recallAt1 !== null && recallAt1 + EPSILON < bar) {
      failures.push(
        `mean recall@1 ${formatRatio(recallAt1)} is below ${formatRatio(bar)} (the better baseline-prefix/1 row ` +
          `plus ${PLACEMENT_RECALL_MARGIN * 100} points)`,
      );
    }
    const gaps: string[] = [];
    if (live.length < MIN_LIVE_RUNS) gaps.push(`${live.length} of ${MIN_LIVE_RUNS} runs`);
    if (bar === null) gaps.push('no baseline-prefix/1 numbers for this landscape');

    gates.push({
      procedure: first.procedure,
      landscape: first.landscape,
      llmModel: first.llmModel,
      split: first.split,
      status: failures.length > 0 ? 'fail' : gaps.length > 0 ? 'incomplete' : 'pass',
      runs: live.length,
      precision: mean(live.map((r) => r.precision)),
      recall: mean(live.map((r) => r.recall)),
      recallAt1,
      areaRecallAt1: mean(runs.map((s) => s.numbers.areaRecallAt1)),
      f1: mean(runs.map((s) => s.numbers.f1)),
      trapsHighConfidence: traps,
      baseline: { withVotes: b?.withVotes.recallAt1 ?? null, withoutVotes: b?.withoutVotes.recallAt1 ?? null, bar },
      reasons: [...failures, ...gaps],
      liveRuns: live,
    });
  }
  return gates.sort(
    (a, b) => byString(a.procedure, b.procedure) || byString(a.landscape, b.landscape) || byString(a.llmModel, b.llmModel),
  );
}

/** One console line per gate, plus its reasons. */
export function formatPlacementLiveGate(g: PlacementLiveGate): string {
  const head =
    `placement live gate ${gateLabel(g)} (${g.split}): ${g.status === 'pass' ? 'pass' : g.status.toUpperCase()}; ` +
    `${g.runs} ${g.runs === 1 ? 'run' : 'runs'}, recall@1 ${formatRatio(g.recallAt1)} (bar ${formatRatio(g.baseline.bar)}: ` +
    `baseline-prefix/1 ${formatRatio(g.baseline.withVotes)} with votes, ${formatRatio(g.baseline.withoutVotes)} ` +
    `without), precision ${formatRatio(g.precision)}, recall ${formatRatio(g.recall)}; must_not at ≥ ` +
    `${HIGH_CONFIDENCE}: ${g.trapsHighConfidence}`;
  return [head, ...g.reasons.map((r) => `  - ${r}`)].join('\n');
}
