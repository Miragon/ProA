// The "auto-accept what-if" of eval:replay (owner decision 19): what an
// owner's auto-accept rule at a minimum confidence would have accepted in a
// recorded run, and how much of that was right, so the owner can choose the
// threshold x from data. Pure and deterministic; report only, no gate.
//
// The run is replayed in recording order, as the server evaluates rules: at
// the end of each submission (after its own replacements and withdrawals),
// for the proposals it newly recorded (`applied` or `reopened`), with the
// safeguards checked against what is live at that moment. What the rule
// accepted stays accepted (a human decision for every purpose): it blocks a
// later competing call or step, and the agent's later no-link or re-judgement
// of it no longer matters. The agent's later submissions are taken as
// recorded (the run cannot show how a rule would have changed its claims).
//
// Relations, per recording, threshold and tier (`all` = one rule per tier at
// the same threshold): a pair counts at the first new proposal with
// confidence ≥ the threshold and the tier of the rule that passes the
// safeguards: no competing call from the same element (a live call proposal
// of the run to another target, an accepted one, or a rule-tier call), no
// question, no live no-link on the typed pair. The tier is the server's,
// recomputed offline with the pair assessor of @proa/relations
// (`createPairAssessor`, the function the server binds) on the landscape's
// facts. What is live follows the server's submission rules: a newer
// proposal on a pair replaces the older; a no-link replaces the agent's
// proposal on the pair from an analysis of the same model, and a proposal or
// a no-link replaces its no-link from the same model; a submission for a new
// revision of a model withdraws the judgements on pairs touching it that
// rest on an older one. Classes: correct = must_link, acceptable = may_link,
// wrong = unlisted (closed world) and same-process, trap = must_not_link;
// precision = correct / (correct + wrong + traps).
//
// Placements, per recording and threshold (no tier split: a placement's
// tier depends on the neighbour votes of the project at proposal time): a
// process counts at the first new item with confidence ≥ the threshold that
// passes the safeguards: never `@outside`, no other step of the process
// accepted, no live proposal on another step (the run's or the rule tier's
// key proposal, decision 18), no question on a live proposal of the process.
// A submission that gives a process a verdict (a placement or unsure)
// withdraws the agent's proposals of it that it does not repeat. Classes:
// correct = the must, acceptable = may or coarse, wrong, trap; precision =
// correct / (correct + wrong + traps).
//
// Exclusions count, at the lowest threshold, the items that had a
// qualifying proposal but were never accepted, by the safeguard that held the
// first one back.
//
// Holdout hygiene: a holdout recording gets aggregate rows only (relations:
// the `all` tier only, no tier split), no item lists, and no number over
// fewer than HOLDOUT_MIN_GROUP items: a row under it is redacted („< 5“), and
// so is a row whose difference to the row of the next lower threshold shown
// would reveal a group of 1 to 4 items („hidden“); exclusion counts under it
// likewise („< 5“). Dev recordings also list their wrong and trap items at
// the lowest threshold.
import {
  isPlacementLine,
  type PlacementRecordingLine,
  type Ref,
  type RelationRecordingLine,
} from '@proa/contracts';
import { createPairAssessor, type LinkType, type ProposalTier } from '@proa/relations';

import type { LandscapeRun } from './landscape.ts';
import {
  HOLDOUT_MIN_GROUP,
  OUTSIDE,
  classifyPlacement,
  rulePlacements,
  type PlacementClass,
  type PlacementRun,
} from './placements-score.ts';
import type { RecordingFile } from './recordings.ts';

/** The minimum confidences the what-if evaluates. */
export const WHAT_IF_THRESHOLDS = [0.8, 0.9, 0.95] as const;
/** `all`: one rule per tier at the same threshold. */
export const WHAT_IF_TIERS = ['all', 'key', 'lexical', 'semantic'] as const;
export type WhatIfTier = (typeof WHAT_IF_TIERS)[number];

/** Server outcomes that record a new agent proposal (the only ones a rule evaluates). */
const NEW_PROPOSAL = new Set(['applied', 'reopened']);
const LINK_TYPES = new Set(['call', 'message', 'signal', 'trigger']);

export interface WhatIfCounts {
  wouldAccept: number;
  correct: number;
  acceptable: number;
  wrong: number;
  traps: number;
  /** Unlisted pairs of an open-world landscape: neither right nor wrong. */
  unknown: number;
  /** correct / (correct + wrong + traps); null without such items. */
  precision: number | null;
}

export interface WhatIfRow {
  threshold: number;
  tier: WhatIfTier;
  /** `null`: redacted on a holdout recording (see `redacted`). */
  counts: WhatIfCounts | null;
  /**
   * Why a holdout row is redacted: fewer than HOLDOUT_MIN_GROUP would-accept
   * items (`small`), or its difference to the row of the next lower threshold
   * shown would reveal such a group (`difference`). Absent on shown rows.
   */
  redacted?: 'small' | 'difference';
}

/** Items a safeguard kept from being accepted, at the lowest threshold (`null`: redacted). */
export interface RelationExclusions {
  competingCall: number | null;
  question: number | null;
  noLink: number | null;
}

export interface PlacementExclusions {
  outside: number | null;
  competingStep: number | null;
  question: number | null;
}

export type WhatIfClass = 'correct' | 'acceptable' | 'wrong' | 'trap' | 'unknown';

export interface RelationWhatIfItem {
  type: string;
  from: string;
  to: string;
  tier: ProposalTier;
  confidence: number;
  class: WhatIfClass;
  /** expected.yaml class, `unlisted` or `same_process`. */
  expect: string;
}

export interface PlacementWhatIfItem {
  process: string;
  step: string;
  confidence: number;
  class: WhatIfClass;
  /** The scorer's class (hit, may, coarse, trap, wrong). */
  placement: PlacementClass;
}

interface WhatIfBase {
  /** Path below `eval/recordings`. */
  file: string;
  procedure: string;
  agent: string;
  llmModel: string;
  landscape: string;
  split: 'dev' | 'holdout';
  rows: WhatIfRow[];
  /** Set for the holdout: what the section leaves out. */
  note?: string;
}

export interface RelationWhatIf extends WhatIfBase {
  excluded: RelationExclusions;
  /** Dev only: the wrong and trap pairs at the lowest threshold, every tier. */
  items?: RelationWhatIfItem[];
}

export interface PlacementWhatIf extends WhatIfBase {
  excluded: PlacementExclusions;
  /** Dev only: the wrong and trap placements at the lowest threshold. */
  items?: PlacementWhatIfItem[];
}

/** What the report says instead of the item lists of a holdout recording. */
export const WHAT_IF_HOLDOUT_NOTE =
  'holdout: aggregate rows only (relations without the tier split), no item lists; a row with fewer than ' +
  `${HOLDOUT_MIN_GROUP} would-accept items is shown as „< ${HOLDOUT_MIN_GROUP}“, a row whose difference to ` +
  `the next lower threshold shown would reveal fewer than ${HOLDOUT_MIN_GROUP} items as „hidden“ ` +
  '(eval/README.md, holdout hygiene)';

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const LOWEST = WHAT_IF_THRESHOLDS[0];

function countsOf(classes: readonly WhatIfClass[]): WhatIfCounts {
  const c = {
    wouldAccept: classes.length,
    correct: 0,
    acceptable: 0,
    wrong: 0,
    traps: 0,
    unknown: 0,
  };
  for (const k of classes) {
    if (k === 'correct') c.correct++;
    else if (k === 'acceptable') c.acceptable++;
    else if (k === 'wrong') c.wrong++;
    else if (k === 'trap') c.traps++;
    else c.unknown++;
  }
  const d = c.correct + c.wrong + c.traps;
  return { ...c, precision: d === 0 ? null : c.correct / d };
}

/**
 * The holdout rows of one tier, thresholds ascending (counts never grow with
 * the threshold): a row under HOLDOUT_MIN_GROUP would-accept items is
 * redacted (`small`), and so is a row whose difference to the row of the next
 * lower threshold shown is 1 to HOLDOUT_MIN_GROUP − 1 items (`difference`),
 * so that no two shown rows differ by a small group (the differences between
 * any two shown rows are sums of such steps: 0 or at least HOLDOUT_MIN_GROUP).
 */
export function redactSeries(rows: readonly WhatIfRow[]): WhatIfRow[] {
  let shown: number | null = null;
  return [...rows]
    .sort((a, b) => a.threshold - b.threshold)
    .map((row): WhatIfRow => {
      const n = row.counts?.wouldAccept ?? 0;
      if (row.counts === null || n < HOLDOUT_MIN_GROUP) {
        return { threshold: row.threshold, tier: row.tier, counts: null, redacted: 'small' };
      }
      if (shown !== null && shown - n > 0 && shown - n < HOLDOUT_MIN_GROUP) {
        return { threshold: row.threshold, tier: row.tier, counts: null, redacted: 'difference' };
      }
      shown = n;
      return row;
    });
}

const redactCount = (n: number, holdout: boolean): number | null =>
  holdout && n < HOLDOUT_MIN_GROUP ? null : n;

// ---------------------------------------------------------------- relations

type RelationBlock = 'competing-call' | 'agent-question' | 'no-link';

/** A valid relation item of the run, as recorded. */
interface RelationEvent {
  key: string;
  type: string;
  from: string;
  to: string;
  tier: ProposalTier;
  confidence: number;
  question: boolean;
  /** The server recorded it as a new proposal (`applied`, `reopened`). */
  isNew: boolean;
  /** The server recorded nothing (`duplicate`, `suppressed`): what was live stays. */
  repeated: boolean;
}

/** One recorded submission, reduced to what the replay needs. */
interface RelationStep {
  modelKey: string;
  rev: number;
  items: RelationEvent[];
  /** Valid no-link items: `stored` (a new live no-link) or `duplicate` (the live one stays). */
  noLinks: { key: string; from: string; to: string; stored: boolean }[];
}

/** A live judgement of the agent: the model its analysis was of, the revisions it rests on. */
interface Judgement {
  origin: string;
  revs: Map<string, number>;
}

interface LiveProposal extends Judgement {
  event: RelationEvent;
}

const modelOfRef = (ref: string): string => ref.slice(0, ref.indexOf('#'));

/**
 * Replays the relation steps for one rule (threshold and tier): the pairs
 * accepted (with the proposal that triggered each) and, per pair that had a
 * qualifying proposal but was never accepted, the safeguard that held the
 * first one back.
 */
function replayRelationRun(
  steps: readonly RelationStep[],
  ruleCalls: ReadonlyMap<string, ReadonlySet<string>>,
  t: number,
  tier: WhatIfTier,
): { accepted: Map<string, RelationEvent>; blocked: Map<string, RelationBlock> } {
  const proposals = new Map<string, LiveProposal>();
  const noLinks = new Map<string, Judgement[]>();
  const revOf = new Map<string, number>();
  const accepted = new Map<string, RelationEvent>();
  const acceptedCalls = new Map<string, Set<string>>();
  const blocked = new Map<string, RelationBlock>();
  const revsOf = (from: string, to: string, modelKey: string, rev: number) => {
    const revs = new Map<string, number>();
    for (const m of [modelOfRef(from), modelOfRef(to)]) {
      const r = m === modelKey ? rev : revOf.get(m);
      if (r !== undefined) revs.set(m, r);
    }
    return revs;
  };
  const staleFor = (j: Judgement, modelKey: string, rev: number) => {
    const r = j.revs.get(modelKey);
    return r !== undefined && r !== rev;
  };

  for (const step of steps) {
    const { modelKey, rev } = step;
    const proposed = new Set<string>();
    const fresh: RelationEvent[] = [];
    // 1. The submission's proposals (a newer one on a pair replaces the older).
    for (const e of step.items) {
      proposed.add(e.key);
      if (e.repeated) continue;
      proposals.set(e.key, { event: e, origin: modelKey, revs: revsOf(e.from, e.to, modelKey, rev) });
      if (e.isNew) fresh.push(e);
    }
    const noLinked = new Set(step.noLinks.map((n) => n.key));
    // 2. Supersession and replacement of earlier judgements (this submission's stay).
    const mine = new Set(fresh);
    for (const [key, p] of proposals) {
      if (mine.has(p.event) || proposed.has(key)) continue;
      const touches = modelOfRef(p.event.from) === modelKey || modelOfRef(p.event.to) === modelKey;
      if (
        (touches && staleFor(p, modelKey, rev)) ||
        (p.origin === modelKey && noLinked.has(key))
      ) {
        proposals.delete(key);
      }
    }
    for (const [key, list] of noLinks) {
      const [from, to] = key.split('|').slice(1);
      const touches =
        modelOfRef(from ?? '') === modelKey || modelOfRef(to ?? '') === modelKey;
      const kept = list.filter(
        (n) =>
          !(touches && staleFor(n, modelKey, rev)) &&
          !(n.origin === modelKey && (proposed.has(key) || step.noLinks.some((x) => x.key === key && x.stored))),
      );
      if (kept.length === 0) noLinks.delete(key);
      else noLinks.set(key, kept);
    }
    // 3. The submission's new no-links.
    for (const n of step.noLinks) {
      if (!n.stored) continue;
      noLinks.set(n.key, [
        ...(noLinks.get(n.key) ?? []),
        { origin: modelKey, revs: revsOf(n.from, n.to, modelKey, rev) },
      ]);
    }
    revOf.set(modelKey, rev);

    // 4. The rule on the proposals this submission recorded, in natural key order.
    const ordered = [...fresh].sort(
      (a, b) => byCodePoint(a.type, b.type) || byCodePoint(a.from, b.from) || byCodePoint(a.to, b.to),
    );
    for (const e of ordered) {
      if (accepted.has(e.key) || proposals.get(e.key)?.event !== e) continue;
      if ((tier !== 'all' && e.tier !== tier) || e.confidence < t) continue;
      const others = (map: ReadonlyMap<string, ReadonlySet<string>>) =>
        [...(map.get(e.from) ?? [])].some((to) => to !== e.to);
      const competing =
        e.type === 'call' &&
        (others(ruleCalls) ||
          others(acceptedCalls) ||
          [...proposals.values()].some(
            (p) => p.event.type === 'call' && p.event.from === e.from && p.event.to !== e.to,
          ));
      const block: RelationBlock | null = competing
        ? 'competing-call'
        : e.question
          ? 'agent-question'
          : (noLinks.get(e.key)?.length ?? 0) > 0
            ? 'no-link'
            : null;
      if (block) {
        if (!blocked.has(e.key)) blocked.set(e.key, block);
        continue;
      }
      accepted.set(e.key, e);
      blocked.delete(e.key);
      if (e.type === 'call') acceptedCalls.set(e.from, (acceptedCalls.get(e.from) ?? new Set()).add(e.to));
    }
  }
  return { accepted, blocked };
}

/**
 * The relation what-if of one recording (pure): rows per threshold and tier,
 * the exclusions at the lowest threshold, and (dev) the wrong and trap pairs.
 */
export function relationWhatIf(rec: RecordingFile, run: LandscapeRun): RelationWhatIf {
  const lines = rec.lines.filter((l): l is RelationRecordingLine => !isPlacementLine(l));
  const holdout = run.meta.split === 'holdout';
  const assess = createPairAssessor(run.facts);
  const processOf = new Map<string, string>();
  for (const m of run.facts.models) {
    for (const f of m.facts)
      if (f.processId !== null) processOf.set(f.ref, `${m.modelKey}#${f.processId}`);
  }
  const expected = new Map<string, string>();
  for (const r of run.expected.relations) {
    const k = `${r.from} -> ${r.to}`;
    if (!expected.has(k)) expected.set(k, r.expect);
  }
  const expectOf = (from: string, to: string): string => {
    const e = expected.get(`${from} -> ${to}`);
    if (e !== undefined) return e;
    const a = processOf.get(from);
    return a !== undefined && a === processOf.get(to) ? 'same_process' : 'unlisted';
  };
  const classOf = (expect: string): WhatIfClass =>
    expect === 'must_link'
      ? 'correct'
      : expect === 'may_link'
        ? 'acceptable'
        : expect === 'must_not_link'
          ? 'trap'
          : expect === 'same_process' || run.meta.closed_world
            ? 'wrong'
            : 'unknown';

  // The run as submissions of valid items, in recording order.
  const steps: RelationStep[] = [];
  for (const line of lines) {
    if (line.result === null || line.result === undefined) continue;
    const items: RelationEvent[] = [];
    for (const [i, item] of line.submission.relations.entries()) {
      const answered = line.result.items.find((x) => x.index === i)?.result;
      if (answered === undefined || answered.startsWith('invalid:') || !LINK_TYPES.has(item.type))
        continue;
      const a = assess({ type: item.type as LinkType, from: item.from as Ref, to: item.to as Ref });
      if (!a.ok) continue;
      items.push({
        key: `${item.type}|${item.from}|${item.to}`,
        type: item.type,
        from: item.from,
        to: item.to,
        tier: a.tier,
        confidence: item.confidence,
        question: item.question !== null && item.question.trim() !== '',
        isNew: NEW_PROPOSAL.has(answered),
        repeated: !NEW_PROPOSAL.has(answered),
      });
    }
    const answers = line.result.noLinks?.items;
    const noLinks: RelationStep['noLinks'] = [];
    for (const [i, n] of line.submission.noLinks.entries()) {
      const answer = answers?.find((x) => x.index === i)?.result ?? 'stored';
      if (answer.startsWith('invalid:')) continue;
      noLinks.push({
        key: `${n.type}|${n.from}|${n.to}`,
        from: n.from,
        to: n.to,
        stored: answer === 'stored',
      });
    }
    steps.push({ modelKey: line.modelKey, rev: line.rev, items, noLinks });
  }
  // The rule tier's calls (accepted or proposed at ingest) compete from the start.
  const ruleCalls = new Map<string, Set<string>>();
  for (const r of run.rules.relations) {
    if (r.type === 'call') ruleCalls.set(r.from, (ruleCalls.get(r.from) ?? new Set()).add(r.to));
  }

  const rows: WhatIfRow[] = [];
  for (const t of WHAT_IF_THRESHOLDS) {
    for (const tier of holdout ? (['all'] as const) : WHAT_IF_TIERS) {
      const { accepted } = replayRelationRun(steps, ruleCalls, t, tier);
      const classes = [...accepted.values()].map((e) => classOf(expectOf(e.from, e.to)));
      rows.push({ threshold: t, tier, counts: countsOf(classes) });
    }
  }

  const lowest = replayRelationRun(steps, ruleCalls, LOWEST, 'all');
  const excluded = { competingCall: 0, question: 0, noLink: 0 };
  for (const [key, block] of lowest.blocked) {
    if (lowest.accepted.has(key)) continue;
    if (block === 'competing-call') excluded.competingCall++;
    else if (block === 'agent-question') excluded.question++;
    else excluded.noLink++;
  }
  const items: RelationWhatIfItem[] = [];
  for (const key of [...lowest.accepted.keys()].sort(byCodePoint)) {
    const e = lowest.accepted.get(key);
    if (!e) continue;
    const expect = expectOf(e.from, e.to);
    const cls = classOf(expect);
    if (cls === 'wrong' || cls === 'trap') {
      items.push({
        type: e.type,
        from: e.from,
        to: e.to,
        tier: e.tier,
        confidence: e.confidence,
        class: cls,
        expect,
      });
    }
  }

  const base = {
    file: rec.path,
    procedure: rec.procedure,
    agent: rec.agent,
    llmModel: rec.llmModel,
    landscape: rec.landscape,
    split: run.meta.split,
  };
  if (holdout) {
    return {
      ...base,
      rows: redactSeries(rows),
      excluded: {
        competingCall: redactCount(excluded.competingCall, true),
        question: redactCount(excluded.question, true),
        noLink: redactCount(excluded.noLink, true),
      },
      note: WHAT_IF_HOLDOUT_NOTE,
    };
  }
  return { ...base, rows, excluded, items };
}

// --------------------------------------------------------------- placements

type PlacementBlock = 'outside' | 'competing-step' | 'agent-question';

/** A valid placement item of the run, as recorded. */
interface PlacementEvent {
  process: string;
  step: string;
  confidence: number;
  question: boolean;
  isNew: boolean;
}

/**
 * Replays the placement submissions for one threshold: the step accepted per
 * process (with its trigger) and, per process that had a qualifying item but
 * was never accepted, the safeguard that held the first one back.
 */
function replayPlacementRun(
  steps: readonly { items: PlacementEvent[]; verdicts: ReadonlySet<string> }[],
  ruleSteps: ReadonlyMap<string, ReadonlySet<string>>,
  t: number,
): { accepted: Map<string, PlacementEvent>; blocked: Map<string, PlacementBlock> } {
  /** The agent's live proposals per process and step. */
  const live = new Map<string, Map<string, PlacementEvent>>();
  const accepted = new Map<string, PlacementEvent>();
  const blocked = new Map<string, PlacementBlock>();
  for (const step of steps) {
    const repeated = new Map<string, Set<string>>();
    const fresh: PlacementEvent[] = [];
    for (const e of step.items) {
      repeated.set(e.process, (repeated.get(e.process) ?? new Set()).add(e.step));
      const own = live.get(e.process) ?? new Map<string, PlacementEvent>();
      if (e.isNew || !own.has(e.step)) own.set(e.step, e);
      live.set(e.process, own);
      if (e.isNew) fresh.push(e);
    }
    // A verdict on a process withdraws the agent's proposals of it it did not repeat.
    for (const process of step.verdicts) {
      const own = live.get(process);
      if (!own) continue;
      for (const s of [...own.keys()]) if (!repeated.get(process)?.has(s)) own.delete(s);
    }
    const ordered = [...fresh].sort(
      (a, b) => byCodePoint(a.step, b.step) || byCodePoint(a.process, b.process),
    );
    for (const e of ordered) {
      if (e.confidence < t || live.get(e.process)?.get(e.step) !== e) continue;
      const home = accepted.get(e.process);
      if (home?.step === e.step) continue;
      const own = live.get(e.process) ?? new Map<string, PlacementEvent>();
      const block: PlacementBlock | null =
        e.step === OUTSIDE
          ? 'outside'
          : home !== undefined ||
              [...own.keys()].some((s) => s !== e.step) ||
              [...(ruleSteps.get(e.process) ?? [])].some((s) => s !== e.step)
            ? 'competing-step'
            : [...own.values()].some((p) => p.question)
              ? 'agent-question'
              : null;
      if (block) {
        if (!blocked.has(e.process)) blocked.set(e.process, block);
        continue;
      }
      accepted.set(e.process, e);
    }
  }
  for (const process of accepted.keys()) blocked.delete(process);
  return { accepted, blocked };
}

/** The placement what-if of one recording (pure): rows per threshold, exclusions, (dev) wrong and trap items. */
export function placementWhatIf(rec: RecordingFile, run: PlacementRun): PlacementWhatIf {
  const lines = rec.lines.filter((l): l is PlacementRecordingLine => isPlacementLine(l));
  const holdout = run.split === 'holdout';
  const steps: { items: PlacementEvent[]; verdicts: Set<string> }[] = [];
  for (const line of lines) {
    if (line.outcome !== 'submitted' || !line.result) continue;
    const items: PlacementEvent[] = [];
    const verdicts = new Set<string>();
    for (const [i, item] of line.submission.placements.entries()) {
      const answered = line.result.items.find((x) => x.index === i)?.result;
      if (answered === undefined || answered.startsWith('invalid:')) continue;
      verdicts.add(item.process);
      items.push({
        process: item.process,
        step: item.step,
        confidence: item.confidence,
        question: item.question !== null && item.question.trim() !== '',
        isNew: NEW_PROPOSAL.has(answered),
      });
    }
    for (const [i, u] of line.submission.unsure.entries()) {
      const answered = line.result.unsure.items.find((x) => x.index === i)?.result ?? 'stored';
      if (!answered.startsWith('invalid:')) verdicts.add(u.process);
    }
    steps.push({ items, verdicts });
  }
  const ruleSteps = new Map<string, Set<string>>();
  for (const r of rulePlacements(run))
    ruleSteps.set(r.process, (ruleSteps.get(r.process) ?? new Set()).add(r.step));
  const classOf = (c: PlacementClass): WhatIfClass =>
    c === 'hit'
      ? 'correct'
      : c === 'may' || c === 'coarse'
        ? 'acceptable'
        : c === 'trap'
          ? 'trap'
          : 'wrong';

  const rows: WhatIfRow[] = WHAT_IF_THRESHOLDS.map((t) => {
    const { accepted } = replayPlacementRun(steps, ruleSteps, t);
    const classes = [...accepted.values()].map((e) =>
      classOf(classifyPlacement(run.golden, e.process, e.step)),
    );
    return { threshold: t, tier: 'all', counts: countsOf(classes) };
  });

  const lowest = replayPlacementRun(steps, ruleSteps, LOWEST);
  const excluded = { outside: 0, competingStep: 0, question: 0 };
  for (const block of lowest.blocked.values()) {
    if (block === 'outside') excluded.outside++;
    else if (block === 'competing-step') excluded.competingStep++;
    else excluded.question++;
  }
  const items: PlacementWhatIfItem[] = [];
  for (const process of [...lowest.accepted.keys()].sort(byCodePoint)) {
    const e = lowest.accepted.get(process);
    if (!e) continue;
    const placement = classifyPlacement(run.golden, process, e.step);
    const cls = classOf(placement);
    if (cls === 'wrong' || cls === 'trap') {
      items.push({ process, step: e.step, confidence: e.confidence, class: cls, placement });
    }
  }

  const base = {
    file: rec.path,
    procedure: rec.procedure,
    agent: rec.agent,
    llmModel: rec.llmModel,
    landscape: rec.landscape,
    split: run.split,
  };
  if (holdout) {
    return {
      ...base,
      rows: redactSeries(rows),
      excluded: {
        outside: redactCount(excluded.outside, true),
        competingStep: redactCount(excluded.competingStep, true),
        question: redactCount(excluded.question, true),
      },
      note: WHAT_IF_HOLDOUT_NOTE,
    };
  }
  return { ...base, rows, excluded, items };
}

/** The `autoAcceptWhatIf` key of replay.json. */
export interface AutoAcceptWhatIf {
  thresholds: readonly number[];
  relations: RelationWhatIf[];
  placements: PlacementWhatIf[];
}

// ------------------------------------------------------------------ report

const cell = (s: string | number): string => String(s).replaceAll('|', '\\|');

function table(header: string[], rows: Array<Array<string | number>>): string {
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `|${header.map((_, i) => (i <= 1 ? '---' : '--:')).join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

const percent = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)} %`);
const SMALL = `< ${HOLDOUT_MIN_GROUP}`;
const HIDDEN = 'hidden';
const countCell = (n: number | null): string | number => (n === null ? SMALL : n);

function rowCells(row: WhatIfRow): Array<string | number> {
  const c = row.counts;
  if (c === null) return [row.redacted === 'difference' ? HIDDEN : SMALL, '–', '–', '–', '–', '–'];
  return [c.wouldAccept, c.correct, c.acceptable, c.wrong, c.traps, percent(c.precision)];
}

const ROW_HEADER = ['would accept', 'correct', 'acceptable', 'wrong', 'traps', 'precision'];

const title = (w: WhatIfBase): string =>
  `${w.procedure} / ${w.agent} / ${w.llmModel} / ${w.landscape}`;

/** The relations section of replay.md (after the relation recordings). */
export function renderRelationWhatIf(list: readonly RelationWhatIf[]): string {
  const parts: string[] = [];
  parts.push('## Auto-accept what-if (relations)');
  parts.push(
    "What an owner's auto-accept rule (owner decision 19) at a minimum confidence would have accepted in each run, " +
      'to choose the threshold from data (report only, no gate). The run is replayed in recording order, as the ' +
      'server evaluates rules at the end of each submission: a pair counts at the first proposal the server ' +
      "answered `applied` or `reopened` with confidence ≥ the threshold and the rule's tier that passes the " +
      'safeguards as of that moment: no competing call from the same element (a live call proposal of the run to ' +
      "another target, one the rule already accepted, or a rule-tier call), no question, no live no-link on the pair. " +
      'What the rule accepted stays accepted: it blocks later competing calls, and the agent changing its mind ' +
      "later does not undo it. The tier is the server's, recomputed with the pair assessor of @proa/relations; " +
      '`all` is one rule per tier. correct = must_link, acceptable = may_link, wrong = unlisted (closed world) or ' +
      'same-process, traps = must_not_link; precision = correct / (correct + wrong + traps). Excluded: pairs with a ' +
      'qualifying proposal never accepted, by the safeguard that held the first one back. Rules see no humans ' +
      'here: the live safeguards against human involvement, holds and a second agent cannot fire in a ' +
      "single-agent recording, and the agent's later claims are taken as recorded.",
  );
  if (list.length === 0) {
    parts.push('_No relation recordings._');
    return parts.join('\n\n');
  }
  for (const w of list) {
    parts.push(`### ${title(w)}`);
    const e = w.excluded;
    parts.push(
      `\`${w.file}\` · ${w.split} · excluded at ≥ ${LOWEST}: ${countCell(e.competingCall)} competing calls, ` +
        `${countCell(e.question)} with a question, ${countCell(e.noLink)} with a no-link.`,
    );
    parts.push(
      table(
        ['min confidence', 'tier', ...ROW_HEADER],
        w.rows.map((r) => [r.threshold, r.tier, ...rowCells(r)]),
      ),
    );
    if (w.note !== undefined) {
      parts.push(`_${w.note}._`);
      continue;
    }
    parts.push(`Wrong and trap pairs at ≥ ${LOWEST}:`);
    parts.push(
      (w.items ?? []).length === 0
        ? '_none_'
        : (w.items ?? [])
            .map(
              (i) =>
                `- \`${i.type}\` ${i.from} → ${i.to} (${i.class}: ${i.expect}; ${i.tier}, confidence ${i.confidence.toFixed(2)})`,
            )
            .join('\n'),
    );
  }
  return parts.join('\n\n');
}

/** The placements section of replay.md (after the placement recordings). */
export function renderPlacementWhatIf(list: readonly PlacementWhatIf[]): string {
  const parts: string[] = [];
  parts.push('## Auto-accept what-if (placements)');
  parts.push(
    "What an owner's placement auto-accept rule would have accepted in each run (report only, no gate), overall: a " +
      "placement's tier depends on the project's neighbour votes at proposal time, so there is no offline tier split " +
      '(the in-product preview is per tier). The run is replayed in recording order: a process counts at the first ' +
      'item the server answered `applied` or `reopened` with confidence ≥ the threshold that passes the safeguards ' +
      'as of that submission: never `@outside`, no other step accepted, no live proposal on another step (the ' +
      "run's, after the submission withdrew the agent's unrepeated ones, or the rule tier's key proposal, decision " +
      '18), no question. What the rule accepted stays the home step. correct = the must, acceptable = a may or ' +
      'coarse step, wrong = another step, traps = a must_not step; precision = correct / (correct + wrong + traps).',
  );
  if (list.length === 0) {
    parts.push('_No placement recordings._');
    return parts.join('\n\n');
  }
  for (const w of list) {
    parts.push(`### ${title(w)}`);
    const e = w.excluded;
    parts.push(
      `\`${w.file}\` · ${w.split} · excluded at ≥ ${LOWEST}: ${countCell(e.outside)} on \`@outside\`, ` +
        `${countCell(e.competingStep)} with a competing step, ${countCell(e.question)} with a question.`,
    );
    parts.push(
      table(
        ['min confidence', 'tier', ...ROW_HEADER],
        w.rows.map((r) => [r.threshold, r.tier, ...rowCells(r)]),
      ),
    );
    if (w.note !== undefined) {
      parts.push(`_${w.note}._`);
      continue;
    }
    parts.push(`Wrong and trap placements at ≥ ${LOWEST}:`);
    parts.push(
      (w.items ?? []).length === 0
        ? '_none_'
        : (w.items ?? [])
            .map(
              (i) =>
                `- ${i.process} → \`${i.step}\` (${i.class}: ${i.placement}; confidence ${i.confidence.toFixed(2)})`,
            )
            .join('\n'),
    );
  }
  return parts.join('\n\n');
}
