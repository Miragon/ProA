// The live gate (CONCEPT §7): may a procedure version be released, judged by
// the recordings of live runs? A pure function over replay scores, shared by
// eval:live (exit 1 on `fail`) and the "Live gate" section of eval:replay.
//
// Recordings are grouped by procedure `<id>@<version>` and landscape. The
// live runs of a group are its recordings of every agent but `agent-sim`:
// one file per run, since every run works a fresh project under its own
// agent token, whose name is the agent segment. A group
// - fails if any run proposes a must_not_link pair with confidence ≥ 0.8, or
//   if the mean recall of its runs is more than 5 points below the baseline;
// - else is incomplete with fewer than 3 runs or without a baseline;
// - else passes.
// The baseline is the mean recall of the live runs of the highest earlier
// version (x.y.z) of the same procedure on that landscape, else the
// `agent-sim` recording of the same version. Recall is `overall.recall`:
// the agent's proposals, without the rule tier's acceptances.
import { HIGH_CONFIDENCE, type ReplayScore } from './replay-score.ts';
import { formatRatio } from './score.ts';

/** Agent name of the simulation agent (`apps/agent-sim`): its recordings are no live runs. */
export const SIM_AGENT = 'agent-sim';
/** Live runs a group needs to pass. */
export const MIN_LIVE_RUNS = 3;
/** The mean recall may be at most this far below the baseline (5 points). */
export const MAX_RECALL_DROP = 0.05;
/** Tolerance of the recall comparison: exactly 5 points below still passes despite rounding. */
const EPSILON = 1e-9;

export type LiveGateStatus = 'pass' | 'fail' | 'incomplete';

/** What the gate reads of a replay score. */
export type LiveGateInput = Pick<
  ReplayScore,
  'file' | 'procedure' | 'agent' | 'llmModel' | 'landscape' | 'split' | 'overall' | 'mustNotLinkHits'
>;

export interface LiveRun {
  /** Path below `eval/recordings`. */
  file: string;
  agent: string;
  llmModel: string;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** must_not_link pairs proposed with confidence ≥ {@link HIGH_CONFIDENCE}. */
  mustNotLinkHighConfidence: number;
}

export interface LiveBaseline {
  /**
   * `previous-version`: the live runs of the highest earlier version;
   * `agent-sim`: the simulation agent's recording of the same version;
   * `none`: neither exists.
   */
  source: 'previous-version' | 'agent-sim' | 'none';
  /** `<id>@<version>` of the baseline recordings. */
  procedure: string | null;
  /** Recordings the baseline averages. */
  runs: number;
  /** Mean `overall.recall`; null without recordings or must_link pairs. */
  recall: number | null;
  files: string[];
}

export interface LiveGate {
  /** `<id>@<version>`. */
  procedure: string;
  landscape: string;
  split: 'dev' | 'holdout';
  status: LiveGateStatus;
  /** Live runs (recordings of agents other than `agent-sim`). */
  runs: number;
  /** Means over the runs (`overall`); null when no run has a value. */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** must_not_link pairs with confidence ≥ {@link HIGH_CONFIDENCE}, summed over the runs. */
  mustNotLinkHighConfidence: number;
  baseline: LiveBaseline;
  /** Mean recall minus the baseline's; null if either is null. */
  recallDelta: number | null;
  /** Why the gate fails or is incomplete (every reason that applies); empty when it passes. */
  reasons: string[];
  liveRuns: LiveRun[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Mean of the non-null values; null if there are none. */
function mean(values: ReadonlyArray<number | null>): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** `<id>@<version>` split at the last `@`. */
export function splitProcedure(procedure: string): { id: string; version: string } {
  const at = procedure.lastIndexOf('@');
  return at < 0 ? { id: procedure, version: '' } : { id: procedure.slice(0, at), version: procedure.slice(at + 1) };
}

/** Compares two `x.y.z` versions; null if either is not of that form. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const isLiveRun = (s: Pick<LiveGateInput, 'agent'>): boolean => s.agent !== SIM_AGENT;

function liveRun(s: LiveGateInput): LiveRun {
  return {
    file: s.file,
    agent: s.agent,
    llmModel: s.llmModel,
    precision: s.overall.precision,
    recall: s.overall.recall,
    f1: s.overall.f1,
    mustNotLinkHighConfidence: s.mustNotLinkHits.filter((p) => p.confidence >= HIGH_CONFIDENCE).length,
  };
}

function baselineOf(procedure: string, landscape: string, scores: readonly LiveGateInput[]): LiveBaseline {
  const { id, version } = splitProcedure(procedure);
  // Live runs of the highest earlier version of the same procedure on this landscape.
  let previous: string | null = null;
  for (const s of scores) {
    if (s.landscape !== landscape || !isLiveRun(s)) continue;
    const other = splitProcedure(s.procedure);
    if (other.id !== id) continue;
    const older = compareVersions(other.version, version);
    if (older === null || older >= 0) continue;
    if (previous === null || (compareVersions(other.version, splitProcedure(previous).version) ?? 0) > 0) {
      previous = s.procedure;
    }
  }
  const pick = (source: LiveBaseline['source'], of: string, xs: LiveGateInput[]): LiveBaseline => ({
    source,
    procedure: of,
    runs: xs.length,
    recall: mean(xs.map((s) => s.overall.recall)),
    files: xs.map((s) => s.file).sort(byString),
  });
  if (previous !== null) {
    const p = previous;
    return pick('previous-version', p, scores.filter((s) => s.procedure === p && s.landscape === landscape && isLiveRun(s)));
  }
  const sims = scores.filter((s) => s.procedure === procedure && s.landscape === landscape && !isLiveRun(s));
  if (sims.length > 0) return pick('agent-sim', procedure, sims);
  return { source: 'none', procedure: null, runs: 0, recall: null, files: [] };
}

/**
 * The live gate of every procedure version and landscape with at least one
 * live run, sorted by procedure and landscape. `scores` are all recordings
 * known (live runs, the simulation agent's, earlier versions'); the
 * baseline comes from them.
 */
export function liveGates(scores: readonly LiveGateInput[]): LiveGate[] {
  const groups = new Map<string, LiveGateInput[]>();
  for (const s of scores) {
    if (!isLiveRun(s)) continue;
    const key = `${s.procedure}\n${s.landscape}`;
    const group = groups.get(key);
    if (group) group.push(s);
    else groups.set(key, [s]);
  }
  const gates: LiveGate[] = [];
  for (const runs of groups.values()) {
    const first = runs[0];
    if (!first) continue;
    const live = runs.map(liveRun).sort((a, b) => byString(a.file, b.file));
    const recall = mean(live.map((r) => r.recall));
    const baseline = baselineOf(first.procedure, first.landscape, scores);
    const recallDelta = recall !== null && baseline.recall !== null ? recall - baseline.recall : null;
    const highConfidence = live.reduce((n, r) => n + r.mustNotLinkHighConfidence, 0);

    const failures: string[] = [];
    if (highConfidence > 0) {
      const inRuns = live.filter((r) => r.mustNotLinkHighConfidence > 0).length;
      failures.push(
        `${highConfidence} must_not_link ${highConfidence === 1 ? 'pair' : 'pairs'} proposed with confidence ≥ ${HIGH_CONFIDENCE} ` +
          `(in ${inRuns} of ${live.length} ${live.length === 1 ? 'run' : 'runs'})`,
      );
    }
    if (recallDelta !== null && -recallDelta > MAX_RECALL_DROP + EPSILON) {
      failures.push(
        `mean recall ${formatRatio(recall)} is more than ${MAX_RECALL_DROP * 100} points below the baseline ` +
          `${formatRatio(baseline.recall)}`,
      );
    }
    const gaps: string[] = [];
    if (live.length < MIN_LIVE_RUNS) gaps.push(`${live.length} of ${MIN_LIVE_RUNS} runs`);
    if (baseline.source === 'none') {
      gaps.push('no baseline: no live runs of an earlier version and no agent-sim recording of this version');
    }

    gates.push({
      procedure: first.procedure,
      landscape: first.landscape,
      split: first.split,
      status: failures.length > 0 ? 'fail' : gaps.length > 0 ? 'incomplete' : 'pass',
      runs: live.length,
      precision: mean(live.map((r) => r.precision)),
      recall,
      f1: mean(live.map((r) => r.f1)),
      mustNotLinkHighConfidence: highConfidence,
      baseline,
      recallDelta,
      reasons: [...failures, ...gaps],
      liveRuns: live,
    });
  }
  return gates.sort((a, b) => byString(a.procedure, b.procedure) || byString(a.landscape, b.landscape));
}

/** Where the baseline comes from, e.g. `agent-sim proa-relations@0.1.0`, or `none`. */
export function baselineLabel(b: LiveBaseline): string {
  if (b.source === 'none' || b.procedure === null) return 'none';
  return b.source === 'agent-sim'
    ? `${SIM_AGENT} ${b.procedure}`
    : `${b.runs} live ${b.runs === 1 ? 'run' : 'runs'} of ${b.procedure}`;
}

/** One console line per gate, plus its reasons. */
export function formatLiveGate(g: LiveGate): string {
  const baseline =
    g.baseline.source === 'none'
      ? 'no baseline'
      : `baseline ${formatRatio(g.baseline.recall)} from ${baselineLabel(g.baseline)}`;
  const head =
    `live gate ${g.procedure} / ${g.landscape} (${g.split}): ${g.status === 'pass' ? 'pass' : g.status.toUpperCase()}; ` +
    `${g.runs} ${g.runs === 1 ? 'run' : 'runs'}, precision ${formatRatio(g.precision)}, recall ${formatRatio(g.recall)} ` +
    `(${baseline}), F1 ${formatRatio(g.f1)}; must_not_link at ≥ ${HIGH_CONFIDENCE}: ${g.mustNotLinkHighConfidence}`;
  return [head, ...g.reasons.map((r) => `  - ${r}`)].join('\n');
}
