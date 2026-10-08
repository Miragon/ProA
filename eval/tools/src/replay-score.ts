// Scores one recording (an agent's submissions on one landscape) against
// expected.yaml (CONCEPT §7 eval:replay): precision, recall and F1 overall,
// per relation type and per tag; must_not_link hits; questions; no-links;
// double work (pairs judged in the tasks of more than one model) and the
// assigned pairs the submissions left uncovered (judge each pair once).
//
// The agent's link set is the union of the valid proposals of all its
// submissions (deduplicated by (from, to); an item the server answered
// `invalid:<reason>` is not a proposal). Unlisted cross-process pairs count
// as false positives in a closed-world landscape; same-process pairs always.
// may_link pairs are neutral (neither true nor false positives). The rule
// tier's acceptances (unambiguous calls, never proposed by agents) are
// added in "incl. rule tier". A no-link the server answered
// `invalid:<reason>` (results since proa-relations@0.2.0 carry the no-link
// outcomes) is no judgement; older results have none, so all their no-links
// count.
import type { DerivedRelation } from '@proa/contracts';

import type { Expect, ExpectedRelation, LandscapeRun } from './landscape.ts';
import type { RecordingFile } from './recordings.ts';

const LINK_TYPES = new Set(['call', 'message', 'signal', 'trigger']);

/** Confidence from which a must_not_link proposal fails the live gate (CONCEPT §7). */
export const HIGH_CONFIDENCE = 0.8;

export type PairClass = Expect | 'unlisted' | 'same_process';

export interface Metrics {
  /** Expected must_link pairs. */
  mustLink: number;
  /** must_link pairs proposed. */
  found: number;
  mayLink: number;
  mustNotLink: number;
  /** Unlisted cross-process pairs (false positives only in a closed world). */
  unlisted: number;
  sameProcess: number;
  /** found / (found + must_not_link + same-process + unlisted in a closed world); null without such pairs. */
  precision: number | null;
  /** found / must_link; null without must_link pairs. */
  recall: number | null;
  f1: number | null;
}

export interface ProposedPair {
  type: string;
  from: string;
  to: string;
  class: PairClass;
  tags: string[];
  /** Highest confidence the pair was proposed with. */
  confidence: number;
  /** Some proposal of the pair asked the reviewer a question. */
  question: boolean;
}

export interface ReplayScore {
  /** Path below `eval/recordings`. */
  file: string;
  procedure: string;
  agent: string;
  llmModel: string;
  landscape: string;
  split: 'dev' | 'holdout';
  closedWorld: boolean;
  tasks: {
    lines: number;
    /** Distinct models with a recorded task, and the landscape's model count. */
    models: number;
    landscapeModels: number;
    submitted: number;
    dryRun: number;
    failed: number;
  };
  items: {
    /** Relations in all recorded submissions. */
    total: number;
    /** Answered or judged invalid (not a proposal), by reason. */
    invalid: Record<string, number>;
    /** Server outcomes of the valid items (`applied`, `duplicate`, …; `unsubmitted` for dry runs). */
    outcomes: Record<string, number>;
  };
  /** Distinct proposed pairs. */
  pairs: number;
  overall: Metrics;
  /** Proposals ∪ the rule tier's acceptances. */
  withRules: Metrics;
  byType: Record<string, Metrics>;
  byTag: Record<string, Metrics>;
  mustNotLinkHits: ProposedPair[];
  /** must_not_link proposed with confidence ≥ {@link HIGH_CONFIDENCE}. */
  mustNotLinkHighConfidence: number;
  unlistedPairs: ProposedPair[];
  /** must_link pairs neither proposed nor accepted by the rule tier. */
  missed: ExpectedRelation[];
  questions: { pairs: number; byClass: Record<PairClass, number> };
  noLinks: {
    /** Distinct pairs judged unrelated (valid no-links only, where the result says). */
    pairs: number;
    byClass: Record<PairClass, number>;
    /** must_link pairs the agent called unrelated (and did not propose elsewhere). */
    onMustLink: ExpectedRelation[];
  };
  /**
   * Double work: distinct pairs `(from, to)` judged (a valid proposal or
   * no-link, whatever the server answered otherwise) in the lines of more
   * than one model. 0 when every pair is judged once.
   */
  pairsJudgedTwice: number;
  /**
   * Assigned pairs the submissions left without a judgement: the sum of
   * `result.uncovered.count`; null when no line's result has it (results
   * before proa-relations@0.2.0, unsubmitted lines).
   */
  uncovered: number | null;
}

const pairKey = (from: string, to: string): string => `${from} -> ${to}`;

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

function f1Of(p: number | null, r: number | null): number | null {
  if (p === null || r === null) return null;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

function emptyClasses(): Record<PairClass, number> {
  return { must_link: 0, may_link: 0, must_not_link: 0, unlisted: 0, same_process: 0 };
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function metrics(c: Omit<Metrics, 'precision' | 'recall' | 'f1'>, closedWorld: boolean): Metrics {
  const fp = c.mustNotLink + c.sameProcess + (closedWorld ? c.unlisted : 0);
  const precision = ratio(c.found, c.found + fp);
  const recall = ratio(c.found, c.mustLink);
  return { ...c, precision, recall, f1: f1Of(precision, recall) };
}

/** Scores one recording file against the landscape's ground truth. */
export function scoreRecording(rec: RecordingFile, run: LandscapeRun): ReplayScore {
  const { expected, facts, meta } = run;
  const closedWorld = meta.closed_world;

  const processOf = new Map<string, string>();
  const known = new Set<string>();
  for (const m of facts.models) {
    for (const f of m.facts) {
      known.add(f.ref);
      if (f.processId !== null) processOf.set(f.ref, `${f.modelKey}#${f.processId}`);
    }
  }
  const expectedByPair = new Map<string, ExpectedRelation>();
  for (const r of expected.relations) {
    const k = pairKey(r.from, r.to);
    if (!expectedByPair.has(k)) expectedByPair.set(k, r);
  }
  const classify = (from: string, to: string): { class: PairClass; tags: string[]; entry?: ExpectedRelation } => {
    const e = expectedByPair.get(pairKey(from, to));
    if (e) return { class: e.expect, tags: e.tags, entry: e };
    const a = processOf.get(from);
    return { class: a !== undefined && a === processOf.get(to) ? 'same_process' : 'unlisted', tags: [] };
  };

  // The models whose lines judged a pair (a valid proposal or no-link): double work if more than one.
  const judgedBy = new Map<string, Set<string>>();
  const judged = (from: string, to: string, modelKey: string): void => {
    const k = pairKey(from, to);
    const models = judgedBy.get(k);
    if (models) models.add(modelKey);
    else judgedBy.set(k, new Set([modelKey]));
  };

  // The proposals: every recorded item that is a valid proposal, deduplicated by pair.
  const invalid: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  const proposed = new Map<string, ProposedPair>();
  let total = 0;
  for (const line of rec.lines) {
    for (const [i, item] of line.submission.relations.entries()) {
      total++;
      const answered = line.result?.items.find((x) => x.index === i)?.result;
      let reason: string | null = null;
      if (answered?.startsWith('invalid:')) reason = answered.slice('invalid:'.length);
      else if (answered === undefined) {
        // Not submitted (dry run, failed): the checks a replay can make without the server.
        if (!LINK_TYPES.has(item.type)) reason = 'type-not-allowed';
        else if (!known.has(item.from) || !known.has(item.to)) reason = 'unknown-ref';
        else if (!(item.confidence >= 0 && item.confidence <= 1)) reason = 'confidence-out-of-range';
      }
      if (reason !== null) {
        invalid[reason] = (invalid[reason] ?? 0) + 1;
        continue;
      }
      const outcome = answered ?? 'unsubmitted';
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      judged(item.from, item.to, line.modelKey);
      const k = pairKey(item.from, item.to);
      const prev = proposed.get(k);
      const asked = item.question !== null && item.question.trim() !== '';
      if (prev) {
        prev.confidence = Math.max(prev.confidence, item.confidence);
        prev.question ||= asked;
      } else {
        const c = classify(item.from, item.to);
        proposed.set(k, {
          type: item.type,
          from: item.from,
          to: item.to,
          class: c.class,
          tags: c.tags,
          confidence: item.confidence,
          question: asked,
        });
      }
    }
  }

  const accepted = new Map<string, DerivedRelation>(
    run.rules.relations.filter((r) => r.status === 'accepted').map((r) => [pairKey(r.from, r.to), r]),
  );

  // Overall and per type: expected entries by their type, proposals outside the ground truth by theirs.
  const count = (
    include: (type: string) => boolean,
    withRules: boolean,
  ): Omit<Metrics, 'precision' | 'recall' | 'f1'> => {
    const c = { mustLink: 0, found: 0, mayLink: 0, mustNotLink: 0, unlisted: 0, sameProcess: 0 };
    const seen = new Set<string>();
    for (const e of expected.relations) {
      const k = pairKey(e.from, e.to);
      if (!include(e.type) || seen.has(k)) continue;
      seen.add(k);
      const hit = proposed.has(k) || (withRules && accepted.has(k));
      if (e.expect === 'must_link') {
        c.mustLink++;
        if (hit) c.found++;
      } else if (hit && e.expect === 'may_link') c.mayLink++;
      else if (hit) c.mustNotLink++;
    }
    const extra: Array<{ type: string; class: PairClass }> = [...proposed.values()];
    if (withRules) {
      for (const [k, r] of accepted) {
        if (!proposed.has(k)) extra.push({ type: r.type, class: classify(r.from, r.to).class });
      }
    }
    for (const p of extra) {
      if (!include(p.type)) continue;
      if (p.class === 'unlisted') c.unlisted++;
      else if (p.class === 'same_process') c.sameProcess++;
    }
    return c;
  };
  const types = [...new Set([...expected.relations.map((e) => e.type), ...[...proposed.values()].map((p) => p.type)])];
  const byType: Record<string, Metrics> = {};
  for (const type of types) byType[type] = metrics(count((t) => t === type, false), closedWorld);

  // Per tag: only expected entries carry tags, so precision within a tag ignores unlisted pairs.
  const byTag: Record<string, Metrics> = {};
  const tagCounts = new Map<string, Omit<Metrics, 'precision' | 'recall' | 'f1'>>();
  for (const e of expected.relations) {
    const hit = proposed.has(pairKey(e.from, e.to));
    for (const tag of e.tags) {
      const c = tagCounts.get(tag) ?? { mustLink: 0, found: 0, mayLink: 0, mustNotLink: 0, unlisted: 0, sameProcess: 0 };
      if (e.expect === 'must_link') {
        c.mustLink++;
        if (hit) c.found++;
      } else if (hit && e.expect === 'may_link') c.mayLink++;
      else if (hit) c.mustNotLink++;
      tagCounts.set(tag, c);
    }
  }
  for (const [tag, c] of tagCounts) byTag[tag] = metrics(c, closedWorld);

  const pairs = [...proposed.values()].sort((a, b) => (pairKey(a.from, a.to) < pairKey(b.from, b.to) ? -1 : 1));
  const mustNotLinkHits = pairs.filter((p) => p.class === 'must_not_link');
  const questionsByClass = emptyClasses();
  for (const p of pairs) if (p.question) questionsByClass[p.class]++;

  // No-links: distinct pairs judged unrelated and never proposed in the same recording; a no-link the
  // server answered invalid is none (results without no-link outcomes: every no-link counts).
  const noLinkPairs = new Map<string, { from: string; to: string }>();
  let uncovered: number | null = null;
  for (const line of rec.lines) {
    const answers = line.result?.noLinks?.items;
    for (const [i, n] of line.submission.noLinks.entries()) {
      if (answers?.find((x) => x.index === i)?.result.startsWith('invalid:')) continue;
      judged(n.from, n.to, line.modelKey);
      const k = pairKey(n.from, n.to);
      if (!proposed.has(k)) noLinkPairs.set(k, { from: n.from, to: n.to });
    }
    if (line.result?.uncovered) uncovered = (uncovered ?? 0) + line.result.uncovered.count;
  }
  const noLinksByClass = emptyClasses();
  const noLinkOnMustLink: ExpectedRelation[] = [];
  for (const n of [...noLinkPairs.values()].sort((a, b) => (pairKey(a.from, a.to) < pairKey(b.from, b.to) ? -1 : 1))) {
    const c = classify(n.from, n.to);
    noLinksByClass[c.class]++;
    if (c.class === 'must_link' && c.entry) noLinkOnMustLink.push(c.entry);
  }

  const models = new Set(rec.lines.map((l) => l.modelKey));
  return {
    file: rec.path,
    procedure: rec.procedure,
    agent: rec.agent,
    llmModel: rec.llmModel,
    landscape: rec.landscape,
    split: meta.split,
    closedWorld,
    tasks: {
      lines: rec.lines.length,
      models: models.size,
      landscapeModels: facts.models.length,
      submitted: rec.lines.filter((l) => l.outcome === 'submitted').length,
      dryRun: rec.lines.filter((l) => l.outcome === 'dry-run').length,
      failed: rec.lines.filter((l) => l.outcome === 'failed').length,
    },
    items: { total, invalid: sortRecord(invalid), outcomes: sortRecord(outcomes) },
    pairs: pairs.length,
    overall: metrics(count(() => true, false), closedWorld),
    withRules: metrics(count(() => true, true), closedWorld),
    byType: sortRecord(byType),
    byTag: sortRecord(byTag),
    mustNotLinkHits,
    mustNotLinkHighConfidence: mustNotLinkHits.filter((p) => p.confidence >= HIGH_CONFIDENCE).length,
    unlistedPairs: pairs.filter((p) => p.class === 'unlisted' || p.class === 'same_process'),
    missed: expected.relations.filter(
      (e) => e.expect === 'must_link' && !proposed.has(pairKey(e.from, e.to)) && !accepted.has(pairKey(e.from, e.to)),
    ),
    questions: { pairs: pairs.filter((p) => p.question).length, byClass: questionsByClass },
    noLinks: { pairs: noLinkPairs.size, byClass: noLinksByClass, onMustLink: noLinkOnMustLink },
    pairsJudgedTwice: [...judgedBy.values()].filter((models) => models.size > 1).length,
    uncovered,
  };
}

