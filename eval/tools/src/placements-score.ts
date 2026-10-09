// eval:placements scoring (M4-VALUE-CHAIN.md §6, eval/value-chains/README.md):
// classifies placement proposals (process → step) against the golden
// placements and computes precision, recall@1/@3, the trap rate, level-0
// (top-level area) numbers and per-tag numbers. Pure and deterministic; no
// file access. This is the API M4b (S5) plugs recorded agent submissions into:
// `scorePlacementProposals(run.golden, items)` with the union of a run's valid
// items, unranked, each with its confidence.
//
// Systems scored here (no LLM): the rule tier's key proposals
// (`derivePlacementRules`, the derivation the server runs) and
// `baseline-prefix/1` (`baselinePrefix`), with and without votes.
import { PREFIX_TOP, baselinePrefix, derivePlacementRules, normalizeLabel } from '@proa/relations';

import { HIGH_CONFIDENCE } from './replay-score.ts';

/** The pseudo-step "deliberately outside this chain" (never an element id). */
export const OUTSIDE = '@outside';

/** A step of expected-placements.yaml (`parent` from the yaml; the validator checks it against the chain). */
export interface GoldenStep {
  id: string;
  name: string;
  kind: string;
  level: number;
  parent: string | null;
}

/** One process of expected-placements.yaml. */
export interface GoldenPlacement {
  /** `<model_key>#<process_id>`. */
  process: string;
  name: string;
  /** A leaf step or `@outside`. */
  must: string;
  may: string[];
  /** Named traps; a trap covers its subtree. */
  mustNot: string[];
  tags: string[];
  supersededBy: string | null;
}

/** The golden placements of one landscape and the chain they belong to. */
export interface Golden {
  landscape: string;
  /**
   * sha256 (hex) of `value-chain.vc.json`: the server's `content_hash` of
   * that document, because the file is canonical. A recording (S5) names the
   * chain revision it worked on; its hash must equal this one.
   */
  contentHash: string;
  steps: GoldenStep[];
  placements: GoldenPlacement[];
}

/** A step of the golden chain document (`loadDocument`; `hierarchy` source = parent). */
export interface ChainStep {
  id: string;
  name: string;
  parentId: string | null;
  link: string | null;
}

/** A `process` fact, as the server sees it. */
export interface PlacementProcess {
  ref: string;
  /** The fact label: process name, else pool name, else empty. */
  label: string;
  /** The label, or `null` when it is empty (the baseline's input). */
  name: string | null;
  modelKey: string;
}

/** The validator's outcome: exit code and its summary lines (no findings: they would quote the holdout). */
export interface ValidatorResult {
  exitCode: number;
  summary: string[];
}

/** Everything eval:placements scores for one landscape. */
export interface PlacementRun {
  name: string;
  split: 'dev' | 'holdout';
  golden: Golden;
  chainSteps: ChainStep[];
  /** The landscape's `process` facts, sorted by ref. */
  processes: PlacementProcess[];
  /**
   * Processes joined by a must_link relation of expected.yaml, both
   * directions, never the process itself: the accepted relations of a
   * reviewed project (the baseline's votes).
   */
  neighbours: ReadonlyMap<string, readonly string[]>;
  validator: ValidatorResult;
}

/** How a proposal relates to the golden placement, checked in this order. */
export type PlacementClass = 'hit' | 'may' | 'coarse' | 'trap' | 'wrong';
export const PLACEMENT_CLASSES: readonly PlacementClass[] = ['hit', 'may', 'coarse', 'trap', 'wrong'];

/** A proposed placement. Ranks are 1-based per process (the baseline); recorded agent items have none. */
export interface PlacementProposal {
  process: string;
  step: string;
  rank?: number;
  confidence?: number;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface GoldenIndex {
  byProcess: Map<string, GoldenPlacement>;
  parentOf: Map<string, string | null>;
  ancestors: Map<string, string[]>;
}

const indexes = new WeakMap<Golden, GoldenIndex>();

function indexOf(golden: Golden): GoldenIndex {
  const cached = indexes.get(golden);
  if (cached) return cached;
  const parentOf = new Map(golden.steps.map((s) => [s.id, s.parent]));
  const ancestors = new Map<string, string[]>();
  for (const s of golden.steps) {
    const chain: string[] = [];
    const seen = new Set([s.id]);
    let p = s.parent;
    while (p !== null && !seen.has(p)) {
      chain.push(p);
      seen.add(p);
      p = parentOf.get(p) ?? null;
    }
    ancestors.set(s.id, chain);
  }
  const index = { byProcess: new Map(golden.placements.map((p) => [p.process, p])), parentOf, ancestors };
  indexes.set(golden, index);
  return index;
}

/** The top-level area of a step: its topmost ancestor, or the step itself (`@outside` is its own area). */
export function areaOf(golden: Golden, step: string): string {
  return indexOf(golden).ancestors.get(step)?.at(-1) ?? step;
}

interface Expectation {
  must: string;
  may: readonly string[];
  mustNot: readonly string[];
}

function classify(index: GoldenIndex, e: Expectation, step: string): PlacementClass {
  if (step === e.must) return 'hit';
  if (e.may.includes(step)) return 'may';
  if ((index.ancestors.get(e.must) ?? []).includes(step)) return 'coarse';
  const up = index.ancestors.get(step) ?? [];
  if (e.mustNot.some((t) => t === step || up.includes(t))) return 'trap';
  return 'wrong';
}

/**
 * Classifies a proposal, in this order: the must → `hit` (also `@outside`);
 * a may → `may` (neutral); an ancestor of the must → `coarse` (neutral,
 * reported); inside the subtree of a must_not → `trap`; anything else, also
 * an unknown process or step → `wrong` (closed world).
 */
export function classifyPlacement(golden: Golden, process: string, step: string): PlacementClass {
  const index = indexOf(golden);
  const p = index.byProcess.get(process);
  return p ? classify(index, p, step) : 'wrong';
}

/** The must_not steps of a process that are top-level steps: the only traps that cover a whole area. */
function topLevelTraps(index: GoldenIndex, p: GoldenPlacement): string[] {
  return p.mustNot.filter((t) => (index.parentOf.get(t) ?? null) === null);
}

/**
 * The same classification at level 0: the proposal's top-level area against
 * the must's area, the may steps' areas and the top-level must_not steps (only
 * a trap on a top-level step covers a whole area). `coarse` cannot occur.
 */
export function classifyArea(golden: Golden, process: string, step: string): PlacementClass {
  const index = indexOf(golden);
  const p = index.byProcess.get(process);
  if (!p) return 'wrong';
  const must = areaOf(golden, p.must);
  const lifted: Expectation = {
    must,
    may: [...new Set(p.may.map((s) => areaOf(golden, s)))].filter((a) => a !== must),
    mustNot: topLevelTraps(index, p),
  };
  return classify(index, lifted, areaOf(golden, step));
}

/** One scored proposal. */
export interface ScoredItem {
  process: string;
  step: string;
  rank: number | null;
  confidence: number | null;
  class: PlacementClass;
  /** The class at level 0 ({@link classifyArea}). */
  areaClass: PlacementClass;
  /** The process's golden tags. */
  tags: string[];
}

/** The numbers of one cut of the proposals (all, rank 1, ranks ≤ 3) at the leaf or at level 0. */
export interface Cut {
  proposals: number;
  hit: number;
  may: number;
  coarse: number;
  trap: number;
  wrong: number;
  /** Processes without a proposal in the cut. */
  none: number;
  /** hit / (hit + trap + wrong); may and coarse are neutral. */
  precision: number | null;
  /** Processes whose must is proposed / processes (one must per process, `@outside` included). */
  recall: number | null;
  f1: number | null;
  /** Processes with a trap proposal in the cut. */
  trapProcesses: number;
  /** trapProcesses / {@link Metrics.withTraps}. */
  trapRate: number | null;
}

export interface Metrics {
  processes: number;
  /**
   * Processes that can be trapped at this level: at the leaf those with a
   * must_not, at level 0 those with a top-level must_not (a trap on a
   * sub-step does not cover its area, {@link classifyArea}).
   */
  withTraps: number;
  /** Every proposal. */
  all: Cut;
  /** Rank 1 per process; ranked systems only. */
  at1: Cut | null;
  /** Ranks ≤ 3; ranked systems only. */
  at3: Cut | null;
}

export interface SystemScore {
  /** Every proposal carries a rank (recall@1/@3 apply). */
  ranked: boolean;
  proposals: number;
  /** Leaf numbers: the step itself. */
  leaf: Metrics;
  /** Level 0: the top-level area ({@link classifyArea}). */
  area: Metrics;
  /** Leaf numbers per golden tag, sorted by tag. */
  byTag: Record<string, Metrics>;
  /** Trap proposals with confidence ≥ 0.8 (the live gate's "no must_not at ≥ 0.8", M4 §6). */
  trapsHighConfidence: number;
  /** Per proposal, sorted by process, rank, step; left out for the holdout (eval/README.md). */
  items?: ScoredItem[];
}

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

function f1Of(p: number | null, r: number | null): number | null {
  if (p === null || r === null) return null;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** How one level classifies a proposal and which processes it can trap. */
interface Level {
  classOf: (i: ScoredItem) => PlacementClass;
  hasTrap: (p: GoldenPlacement) => boolean;
}

function cut(golden: GoldenPlacement[], items: readonly ScoredItem[], level: Level, withTraps: number): Cut {
  const { classOf } = level;
  const counts: Record<PlacementClass, number> = { hit: 0, may: 0, coarse: 0, trap: 0, wrong: 0 };
  const proposed = new Set<string>();
  const found = new Set<string>();
  const trapped = new Set<string>();
  for (const i of items) {
    const c = classOf(i);
    counts[c]++;
    proposed.add(i.process);
    if (c === 'hit') found.add(i.process);
    if (c === 'trap') trapped.add(i.process);
  }
  const processes = new Set(golden.map((p) => p.process));
  const precision = ratio(counts.hit, counts.hit + counts.trap + counts.wrong);
  const recall = ratio([...found].filter((p) => processes.has(p)).length, processes.size);
  const trapProcesses = [...trapped].filter((p) => processes.has(p)).length;
  return {
    proposals: items.length,
    ...counts,
    none: [...processes].filter((p) => !proposed.has(p)).length,
    precision,
    recall,
    f1: f1Of(precision, recall),
    trapProcesses,
    trapRate: ratio(trapProcesses, withTraps),
  };
}

function metrics(golden: GoldenPlacement[], items: readonly ScoredItem[], ranked: boolean, level: Level): Metrics {
  const upTo = (k: number) => items.filter((i) => i.rank !== null && i.rank <= k);
  const withTraps = golden.filter(level.hasTrap).length;
  return {
    processes: golden.length,
    withTraps,
    all: cut(golden, items, level, withTraps),
    at1: ranked ? cut(golden, upTo(1), level, withTraps) : null,
    at3: ranked ? cut(golden, upTo(3), level, withTraps) : null,
  };
}

/**
 * Scores a set of proposals against the golden placements (M4 §6). A
 * proposal named twice (same process and step) counts once, with its best
 * rank and highest confidence. Precision = hit / (hit + trap + wrong); recall
 * over all (process, must) pairs, `@outside` musts included; recall@1/@3 when
 * every proposal has a rank; level 0 by top-level area; trap rate = processes
 * with a trap proposal / processes with must_not (at level 0: with a
 * top-level must_not); per tag. Proposals of a process the golden file does
 * not list count as `wrong`.
 */
export function scorePlacementProposals(golden: Golden, proposals: readonly PlacementProposal[]): SystemScore {
  const index = indexOf(golden);
  const merged = new Map<string, PlacementProposal>();
  for (const p of proposals) {
    const key = `${p.process}\n${p.step}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...p });
      continue;
    }
    const rank = [prev.rank, p.rank].filter((r) => r !== undefined);
    const confidence = [prev.confidence, p.confidence].filter((c) => c !== undefined);
    merged.set(key, {
      process: p.process,
      step: p.step,
      ...(rank.length > 0 ? { rank: Math.min(...rank) } : {}),
      ...(confidence.length > 0 ? { confidence: Math.max(...confidence) } : {}),
    });
  }
  const ranked = merged.size > 0 && [...merged.values()].every((p) => p.rank !== undefined);
  const items: ScoredItem[] = [...merged.values()]
    .map((p) => ({
      process: p.process,
      step: p.step,
      rank: p.rank ?? null,
      confidence: p.confidence ?? null,
      class: classifyPlacement(golden, p.process, p.step),
      areaClass: classifyArea(golden, p.process, p.step),
      tags: index.byProcess.get(p.process)?.tags ?? [],
    }))
    .sort(
      (a, b) =>
        byCodePoint(a.process, b.process) ||
        (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
        byCodePoint(a.step, b.step),
    );
  const leaf: Level = { classOf: (i) => i.class, hasTrap: (p) => p.mustNot.length > 0 };
  const area: Level = { classOf: (i) => i.areaClass, hasTrap: (p) => topLevelTraps(index, p).length > 0 };
  const tags = [...new Set(golden.placements.flatMap((p) => p.tags))].sort(byCodePoint);
  const byTag: Record<string, Metrics> = {};
  for (const tag of tags) {
    const tagged = golden.placements.filter((p) => p.tags.includes(tag));
    const refs = new Set(tagged.map((p) => p.process));
    byTag[tag] = metrics(
      tagged,
      items.filter((i) => refs.has(i.process)),
      ranked,
      leaf,
    );
  }
  return {
    ranked,
    proposals: items.length,
    leaf: metrics(golden.placements, items, ranked, leaf),
    area: metrics(golden.placements, items, ranked, area),
    byTag,
    trapsHighConfidence: items.filter((i) => i.class === 'trap' && (i.confidence ?? 0) >= HIGH_CONFIDENCE).length,
    items,
  };
}

/**
 * `baseline-prefix/1` (frozen, `@proa/relations`) on the golden chain: the top
 * {@link PREFIX_TOP} steps per process, ranked. With votes, neighbours are the
 * must_link neighbours and `known` is the golden must of every other process
 * (`@outside` left out; a process's own must is never read: leave-one-out by
 * construction); without votes neither, as a fresh project's hints.
 */
export function baselineProposals(run: PlacementRun, options: { votes: boolean }): PlacementProposal[] {
  const known = new Map(
    run.golden.placements.filter((p) => p.must !== OUTSIDE).map((p) => [p.process, [p.must]] as const),
  );
  const hints = baselinePrefix(
    {
      steps: run.chainSteps.map((s) => ({ id: s.id, name: s.name, parentId: s.parentId })),
      processes: run.processes.map((p) => ({ ref: p.ref, name: p.name, modelKey: p.modelKey })),
      ...(options.votes ? { neighbours: run.neighbours, known } : {}),
    },
    { top: PREFIX_TOP },
  );
  return run.processes.flatMap((p) =>
    (hints.get(p.ref) ?? []).map((h, i) => ({ process: p.ref, step: h.stepId, rank: i + 1 })),
  );
}

/** One rule-tier proposal with its reasons (the server's rationale names them). */
export interface RuleProposal extends PlacementProposal {
  byLink: boolean;
  byName: boolean;
}

/**
 * The rule tier's key proposals on the golden chain: `derivePlacementRules`,
 * the derivation the server runs on every save (names normalized with
 * `normalizeLabel`, the server's `name_norm`). Confidence 1, unranked.
 */
export function rulePlacements(run: PlacementRun): RuleProposal[] {
  return derivePlacementRules(
    run.chainSteps.map((s) => ({ id: s.id, nameNorm: normalizeLabel(s.name), link: s.link })),
    run.processes.map((p) => ({ ref: p.ref, label: p.label })),
  ).map((m) => ({ process: m.processRef, step: m.stepId, confidence: 1, byLink: m.byLink, byName: m.byName }));
}

export interface PlacementGate {
  id: 'validator' | 'coverage' | 'rule-proposals';
  title: string;
  value: string;
  target: string;
  pass: boolean;
}

export interface PlacementScore {
  name: string;
  split: 'dev' | 'holdout';
  pass: boolean;
  /** The validator's exit code; 2 (the check could not run) makes eval:placements exit 2. */
  validatorExit: number;
  counts: {
    steps: number;
    topLevel: number;
    processes: number;
    placements: number;
    outside: number;
    may: number;
    mustNot: number;
    /** The rule tier's key proposals on the golden chain (also for the holdout). */
    ruleProposals: number;
    /** Processes per golden tag. */
    tags: Record<string, number>;
  };
  gates: PlacementGate[];
  systems: {
    /**
     * The rule tier's key proposals (gate: each a must or may). Left out for
     * the holdout ({@link redactHoldout}): they follow from public inputs, so
     * any class split of them names items.
     */
    rules?: SystemScore;
    /** `baseline-prefix/1` with votes (neighbours, leave-one-out). */
    baseline: SystemScore;
    /** `baseline-prefix/1` without votes (a fresh project's hints). */
    baselineNoVotes: SystemScore;
  };
  /** Set for the holdout: what the report leaves out. */
  note?: string;
}

/**
 * Scores one landscape: the gates (validator exit 0; the golden placements
 * name exactly the process facts; every rule proposal is a must or a may) and
 * the systems. No numeric baseline gate: the baselines are a floor (M4 §6);
 * the committed report and CI's drift check pin their numbers.
 */
export function scorePlacementRun(run: PlacementRun): PlacementScore {
  const { golden } = run;
  const listed = new Set(golden.placements.map((p) => p.process));
  const facts = new Set(run.processes.map((p) => p.ref));
  const missing = [...facts].filter((r) => !listed.has(r)).length;
  const extra = [...listed].filter((r) => !facts.has(r)).length;
  const duplicates = golden.placements.length - listed.size;
  const rules = scorePlacementProposals(golden, rulePlacements(run));
  const ruleOk = rules.leaf.all.hit + rules.leaf.all.may;
  const gates: PlacementGate[] = [
    {
      id: 'validator',
      title: 'validate-value-chains.mjs',
      value: `exit ${run.validator.exitCode}`,
      target: 'exit 0',
      pass: run.validator.exitCode === 0,
    },
    {
      id: 'coverage',
      title: 'golden placements = process facts',
      value:
        `${golden.placements.length} listed, ${facts.size} process facts, ${missing} missing, ${extra} extra` +
        (duplicates > 0 ? `, ${duplicates} listed twice` : ''),
      target: 'equal',
      pass: missing === 0 && extra === 0 && duplicates === 0,
    },
    {
      id: 'rule-proposals',
      title: 'rule proposals hit must or may',
      value: `${ruleOk}/${rules.proposals}`,
      target: 'all',
      pass: ruleOk === rules.proposals,
    },
  ];
  const tags: Record<string, number> = {};
  for (const tag of [...new Set(golden.placements.flatMap((p) => p.tags))].sort(byCodePoint)) {
    tags[tag] = golden.placements.filter((p) => p.tags.includes(tag)).length;
  }
  return {
    name: run.name,
    split: run.split,
    pass: gates.every((g) => g.pass),
    validatorExit: run.validator.exitCode,
    counts: {
      steps: run.chainSteps.length,
      topLevel: run.chainSteps.filter((s) => s.parentId === null).length,
      processes: facts.size,
      placements: golden.placements.length,
      outside: golden.placements.filter((p) => p.must === OUTSIDE).length,
      may: golden.placements.reduce((n, p) => n + p.may.length, 0),
      mustNot: golden.placements.reduce((n, p) => n + p.mustNot.length, 0),
      ruleProposals: rules.proposals,
      tags,
    },
    gates,
    systems: {
      rules,
      baseline: scorePlacementProposals(golden, baselineProposals(run, { votes: true })),
      baselineNoVotes: scorePlacementProposals(golden, baselineProposals(run, { votes: false })),
    },
  };
}

/**
 * The smallest group a holdout number may cover: per-tag numbers only for
 * tags with at least this many processes (a number over one process is that
 * process's result).
 */
export const HOLDOUT_MIN_GROUP = 5;

/** What the report says instead of what it leaves out of a holdout landscape. */
export const HOLDOUT_NOTE =
  'holdout: no per-item lists, the rule tier as its gate and count only, per-tag numbers only for tags with at ' +
  `least ${HOLDOUT_MIN_GROUP} processes (eval/README.md, holdout hygiene)`;

function redactSystem(s: SystemScore): SystemScore {
  const { items: _items, ...rest } = s;
  const byTag = Object.fromEntries(Object.entries(s.byTag).filter(([, m]) => m.processes >= HOLDOUT_MIN_GROUP));
  return { ...rest, byTag };
}

/**
 * The score as the report and the console show it. For split `holdout`
 * aggregate numbers only, none over fewer than {@link HOLDOUT_MIN_GROUP}
 * processes: no per-item lists (`items` left out), no rule tier beyond its
 * gate and `counts.ruleProposals` (its proposals follow from the public chain
 * file and model names, so a class split of a few of them names their
 * classes), and no `byTag` entry for a tag with fewer processes; a note
 * instead. So whoever works on a procedure can open the report safely.
 */
export function redactHoldout(score: PlacementScore): PlacementScore {
  if (score.split !== 'holdout') return score;
  return {
    ...score,
    systems: {
      baseline: redactSystem(score.systems.baseline),
      baselineNoVotes: redactSystem(score.systems.baselineNoVotes),
    },
    note: HOLDOUT_NOTE,
  };
}
