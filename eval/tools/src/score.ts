// Scores one landscape run against expected.yaml (CONCEPT §7, eval/README.md):
// the eval:candidates gates plus per-type and per-tag metrics for the rule
// tier, the candidate pool and baseline-proa1.
import type { Candidate, CandidateBasis, DerivedRelation, Finding, FindingKind, Ref } from '@proa/contracts';

import type { Expect, ExpectedRelation, LandscapeRun } from './landscape.ts';

/** Gate: share of must_link pairs among rules ∪ candidates. */
export const MUST_LINK_RECALL_TARGET = 0.98;

/** Findings recomputed from facts alone; they must match expected.yaml exactly. */
export const EXACT_FINDING_KINDS = ['unresolved-call', 'dynamic-call', 'duplicate-process-id'] as const;
/**
 * Findings whose ground truth also reflects semantic links: every expected
 * one must be computed, and a computed extra must be explained by a
 * must_link/may_link of that endpoint (the rule tier sees names only).
 */
export const JUDGED_FINDING_KINDS = ['dangling-throw', 'unmatched-catch'] as const;

/** How a pair relates to the ground truth. */
export type PairClass = Expect | 'unlisted' | 'same_process';

export interface ScoredPair {
  type: string;
  from: Ref;
  to: Ref;
  class: PairClass;
  tags: string[];
}

/** Metrics of one group of expected entries (a relation type or a tag). */
export interface GroupMetrics {
  mustLink: number;
  /** In the rule tier (accepted or proposed). */
  mustLinkRules: number;
  /** In rules ∪ candidates of basis rule, key or lexical. */
  mustLinkKeyLexical: number;
  /** In rules ∪ all candidates (the gate). */
  mustLinkCandidates: number;
  mustLinkBaseline: number;
  mustNotLink: number;
  mustNotLinkAccepted: number;
  mustNotLinkRules: number;
  mustNotLinkKeyLexical: number;
  mustNotLinkCandidates: number;
  mustNotLinkBaseline: number;
  mayLink: number;
  mayLinkCandidates: number;
  mayLinkBaseline: number;
  /** Rule-accepted pairs that match entries of the group, and how many are must_link or may_link. */
  ruleAccepted: number;
  ruleAcceptedCorrect: number;
}

/** A set of pairs judged against the ground truth. */
export interface SystemMetrics {
  pairs: number;
  mustLink: number;
  mayLink: number;
  mustNotLink: number;
  /** Cross-process pairs not in expected.yaml; false positives in a closed world. */
  unlisted: number;
  /** Pairs within one process; never a relation (CONCEPT §2). */
  sameProcess: number;
  /** must_link / (must_link + must_not_link + unlisted + same-process); null without such pairs. */
  precision: number | null;
  /** Found must_link / all must_link; null without must_link entries. */
  recall: number | null;
}

export interface Gate {
  id: string;
  title: string;
  value: string;
  target: string;
  pass: boolean;
}

export interface FindingCheck {
  kind: FindingKind;
  mode: 'exact' | 'judged';
  expected: string[];
  computed: string[];
  /** Expected but not computed. */
  missing: string[];
  /** Computed, not expected and (judged kinds) not explained by a link. */
  unexpected: string[];
  /** Judged kinds: computed extras whose endpoint the ground truth links (semantic tier). */
  explained: Array<{ finding: string; links: string[] }>;
}

export interface LandscapeScore {
  name: string;
  split: 'dev' | 'holdout';
  lang: string;
  closedWorld: boolean;
  pass: boolean;
  gates: Gate[];
  counts: {
    models: number;
    processes: number;
    facts: number;
    expected: Record<Expect, number>;
    findings: number;
    rules: { accepted: number; proposed: number };
    candidates: Record<CandidateBasis, number> & { total: number };
    baseline: number;
  };
  /** The rule tier's accepted relations (gate: precision 1.0, no must_not_link). */
  ruleTier: { accepted: number; correct: number; precision: number | null; wrong: ScoredPair[] };
  systems: {
    /** Rule tier: accepted calls and key-tier proposals. */
    rules: SystemMetrics;
    /** Rules ∪ candidates of basis rule, key, lexical. */
    keyLexical: SystemMetrics;
    /** Rules ∪ all candidates: what agents get to judge. */
    candidates: SystemMetrics;
    baseline: SystemMetrics;
  };
  byType: Record<string, GroupMetrics>;
  byTag: Record<string, GroupMetrics>;
  /** must_link pairs outside rules ∪ candidates (gate misses). */
  mustLinkMissed: ExpectedRelation[];
  /** must_link pairs only the `compatible` basis reaches. */
  mustLinkOnlyCompatible: ExpectedRelation[];
  /** must_not_link pairs the rule tier proposes (reviewers must reject them). */
  mustNotLinkProposed: ExpectedRelation[];
  /** baseline-proa1 hits on must_not_link entries. */
  baselineMustNotLink: ExpectedRelation[];
  /** must_link pairs baseline-proa1 misses. */
  baselineMissed: ExpectedRelation[];
  findings: FindingCheck[];
}

const pairKey = (from: string, to: string): string => `${from} -> ${to}`;

function emptyGroup(): GroupMetrics {
  return {
    mustLink: 0,
    mustLinkRules: 0,
    mustLinkKeyLexical: 0,
    mustLinkCandidates: 0,
    mustLinkBaseline: 0,
    mustNotLink: 0,
    mustNotLinkAccepted: 0,
    mustNotLinkRules: 0,
    mustNotLinkKeyLexical: 0,
    mustNotLinkCandidates: 0,
    mustNotLinkBaseline: 0,
    mayLink: 0,
    mayLinkCandidates: 0,
    mayLinkBaseline: 0,
    ruleAccepted: 0,
    ruleAcceptedCorrect: 0,
  };
}

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

export function formatRatio(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)} %`;
}

/**
 * Units findings are compared in, as the validator does: one per ref, except
 * `duplicate-process-id`, whose refs form one group (expected.yaml may list
 * several throws or catches in one entry; the rule tier reports one each).
 */
function findingUnits(kind: FindingKind, findings: ReadonlyArray<{ refs: readonly string[] }>): string[] {
  const units =
    kind === 'duplicate-process-id'
      ? findings.map((f) => [...f.refs].sort().join(' '))
      : findings.flatMap((f) => f.refs);
  return [...new Set(units)].sort();
}

export function scoreLandscape(run: LandscapeRun): LandscapeScore {
  const { meta, expected, facts } = run;

  // Which process each ref belongs to (facts, plus events only the baseline saw).
  const processOf = new Map<string, string>();
  for (const m of facts.models) {
    for (const f of m.facts) {
      if (f.processId !== null) processOf.set(f.ref, `${f.modelKey}#${f.processId}`);
    }
  }
  for (const e of run.extraEvents) if (!processOf.has(e.ref)) processOf.set(e.ref, e.process);

  const expectedByPair = new Map<string, ExpectedRelation>();
  for (const r of expected.relations) {
    const key = pairKey(r.from, r.to);
    if (!expectedByPair.has(key)) expectedByPair.set(key, r);
  }
  const classify = (p: { type: string; from: Ref; to: Ref }): ScoredPair => {
    const e = expectedByPair.get(pairKey(p.from, p.to));
    if (e !== undefined) return { type: p.type, from: p.from, to: p.to, class: e.expect, tags: e.tags };
    const a = processOf.get(p.from);
    const same = a !== undefined && a === processOf.get(p.to);
    return { type: p.type, from: p.from, to: p.to, class: same ? 'same_process' : 'unlisted', tags: [] };
  };

  const accepted = run.rules.relations.filter((r) => r.status === 'accepted');
  const rulePairs = new Map<string, DerivedRelation>(run.rules.relations.map((r) => [pairKey(r.from, r.to), r]));
  const acceptedPairs = new Set(accepted.map((r) => pairKey(r.from, r.to)));
  const candidatePairs = new Map<string, Candidate>(run.candidates.map((c) => [pairKey(c.from, c.to), c]));
  const keyLexicalPairs = new Set<string>([
    ...rulePairs.keys(),
    ...run.candidates.filter((c) => c.basis !== 'compatible').map((c) => pairKey(c.from, c.to)),
  ]);
  const allPairs = new Set<string>([...rulePairs.keys(), ...candidatePairs.keys()]);
  const baselinePairs = new Set(run.baseline.map((r) => pairKey(r.from, r.to)));

  const pairsOf = (keys: Iterable<string>): Array<{ type: string; from: Ref; to: Ref }> =>
    [...keys].map((k) => {
      const [from, to] = k.split(' -> ') as [Ref, Ref];
      const type = rulePairs.get(k)?.type ?? candidatePairs.get(k)?.type ?? '';
      return { type, from, to };
    });
  const system = (pairs: Array<{ type: string; from: Ref; to: Ref }>): SystemMetrics => {
    const m = { mustLink: 0, mayLink: 0, mustNotLink: 0, unlisted: 0, sameProcess: 0 };
    for (const p of pairs) {
      const c = classify(p).class;
      if (c === 'must_link') m.mustLink++;
      else if (c === 'may_link') m.mayLink++;
      else if (c === 'must_not_link') m.mustNotLink++;
      else if (c === 'unlisted') m.unlisted++;
      else m.sameProcess++;
    }
    const totalMust = expected.relations.filter((r) => r.expect === 'must_link').length;
    return {
      pairs: pairs.length,
      ...m,
      precision: ratio(m.mustLink, m.mustLink + m.mustNotLink + m.unlisted + m.sameProcess),
      recall: ratio(m.mustLink, totalMust),
    };
  };

  // Groups by type and by tag.
  const byType: Record<string, GroupMetrics> = {};
  const byTag: Record<string, GroupMetrics> = {};
  const mustLinkMissed: ExpectedRelation[] = [];
  const mustLinkOnlyCompatible: ExpectedRelation[] = [];
  const mustNotLinkProposed: ExpectedRelation[] = [];
  const baselineMustNotLink: ExpectedRelation[] = [];
  const baselineMissed: ExpectedRelation[] = [];
  for (const e of expected.relations) {
    const key = pairKey(e.from, e.to);
    const inRules = rulePairs.has(key);
    const isAccepted = acceptedPairs.has(key);
    const inKeyLexical = keyLexicalPairs.has(key);
    const inAll = allPairs.has(key);
    const inBaseline = baselinePairs.has(key);
    const groups = [(byType[e.type] ??= emptyGroup()), ...e.tags.map((t) => (byTag[t] ??= emptyGroup()))];
    for (const g of groups) {
      if (isAccepted) {
        g.ruleAccepted++;
        if (e.expect !== 'must_not_link') g.ruleAcceptedCorrect++;
      }
      if (e.expect === 'must_link') {
        g.mustLink++;
        if (inRules) g.mustLinkRules++;
        if (inKeyLexical) g.mustLinkKeyLexical++;
        if (inAll) g.mustLinkCandidates++;
        if (inBaseline) g.mustLinkBaseline++;
      } else if (e.expect === 'must_not_link') {
        g.mustNotLink++;
        if (isAccepted) g.mustNotLinkAccepted++;
        if (inRules) g.mustNotLinkRules++;
        if (inKeyLexical) g.mustNotLinkKeyLexical++;
        if (inAll) g.mustNotLinkCandidates++;
        if (inBaseline) g.mustNotLinkBaseline++;
      } else {
        g.mayLink++;
        if (inAll) g.mayLinkCandidates++;
        if (inBaseline) g.mayLinkBaseline++;
      }
    }
    if (e.expect === 'must_link') {
      if (!inAll) mustLinkMissed.push(e);
      else if (!inKeyLexical) mustLinkOnlyCompatible.push(e);
      if (!inBaseline) baselineMissed.push(e);
    } else if (e.expect === 'must_not_link') {
      if (inRules) mustNotLinkProposed.push(e);
      if (inBaseline) baselineMustNotLink.push(e);
    }
  }

  // Rule tier precision over accepted relations (unlisted pairs count as wrong).
  const acceptedScored = accepted.map(classify);
  const wrong = acceptedScored.filter((p) => p.class !== 'must_link' && p.class !== 'may_link');
  const ruleTier = {
    accepted: accepted.length,
    correct: accepted.length - wrong.length,
    precision: ratio(accepted.length - wrong.length, accepted.length),
    wrong,
  };

  // Findings.
  const computedBy = (kind: FindingKind): string[] =>
    findingUnits(kind, run.rules.findings.filter((f: Finding) => f.kind === kind));
  const expectedBy = (kind: FindingKind): string[] =>
    findingUnits(kind, expected.expected_findings.filter((f) => f.kind === kind));
  const findings: FindingCheck[] = [];
  for (const kind of EXACT_FINDING_KINDS) {
    const exp = expectedBy(kind);
    const comp = computedBy(kind);
    findings.push({
      kind,
      mode: 'exact',
      expected: exp,
      computed: comp,
      missing: exp.filter((f) => !comp.includes(f)),
      unexpected: comp.filter((f) => !exp.includes(f)),
      explained: [],
    });
  }
  for (const kind of JUDGED_FINDING_KINDS) {
    const exp = expectedBy(kind);
    const comp = computedBy(kind);
    const explained: FindingCheck['explained'] = [];
    const unexpected: string[] = [];
    for (const f of comp.filter((x) => !exp.includes(x))) {
      const links = expected.relations
        .filter(
          (r) =>
            r.expect !== 'must_not_link' &&
            (kind === 'dangling-throw' ? r.from === f : r.to === f),
        )
        .map((r) => `${r.type} ${pairKey(r.from, r.to)} (${r.expect}; ${r.tags.join(', ')})`);
      if (links.length > 0) explained.push({ finding: f, links });
      else unexpected.push(f);
    }
    findings.push({
      kind,
      mode: 'judged',
      expected: exp,
      computed: comp,
      missing: exp.filter((f) => !comp.includes(f)),
      unexpected,
      explained,
    });
  }

  const systems = {
    rules: system(pairsOf(rulePairs.keys())),
    keyLexical: system(pairsOf(keyLexicalPairs)),
    candidates: system(pairsOf(allPairs)),
    baseline: system(run.baseline.map((r) => ({ type: r.type, from: r.from, to: r.to }))),
  };

  const mustLinkTotal = expected.relations.filter((r) => r.expect === 'must_link').length;
  const recall = ratio(mustLinkTotal - mustLinkMissed.length, mustLinkTotal);
  const exactOk = findings.filter((f) => f.mode === 'exact').every((f) => f.missing.length === 0 && f.unexpected.length === 0);
  const judgedOk = findings.filter((f) => f.mode === 'judged').every((f) => f.missing.length === 0 && f.unexpected.length === 0);
  const mustNotAccepted = acceptedScored.filter((p) => p.class === 'must_not_link').length;
  const gates: Gate[] = [
    {
      id: 'rule-precision',
      title: 'Rule-tier precision (accepted relations)',
      value: `${formatRatio(ruleTier.precision)} (${ruleTier.correct}/${ruleTier.accepted})`,
      target: '100 %',
      pass: wrong.length === 0,
    },
    {
      id: 'rule-must-not-link',
      title: 'must_not_link accepted by the rule tier',
      value: String(mustNotAccepted),
      target: '0',
      pass: mustNotAccepted === 0,
    },
    {
      id: 'must-link-recall',
      title: 'must_link among rules ∪ candidates',
      value: `${formatRatio(recall)} (${mustLinkTotal - mustLinkMissed.length}/${mustLinkTotal})`,
      target: `≥ ${(MUST_LINK_RECALL_TARGET * 100).toFixed(0)} %`,
      pass: recall === null || recall >= MUST_LINK_RECALL_TARGET,
    },
    {
      id: 'findings-exact',
      title: 'Findings unresolved-call, dynamic-call, duplicate-process-id equal expected',
      value: exactOk ? 'equal' : 'differ',
      target: 'equal',
      pass: exactOk,
    },
    {
      id: 'findings-judged',
      title: 'Findings dangling-throw, unmatched-catch: all expected found, extras explained',
      value: judgedOk ? 'ok' : 'differ',
      target: 'ok',
      pass: judgedOk,
    },
  ];

  const candidateCounts = { rule: 0, key: 0, lexical: 0, compatible: 0, total: run.candidates.length };
  for (const c of run.candidates) candidateCounts[c.basis]++;
  return {
    name: meta.name,
    split: meta.split,
    lang: meta.lang,
    closedWorld: meta.closed_world,
    pass: gates.every((g) => g.pass),
    gates,
    counts: {
      models: facts.models.length,
      processes: facts.models.reduce((n, m) => n + m.processes.length, 0),
      facts: facts.models.reduce((n, m) => n + m.facts.length, 0),
      expected: {
        must_link: mustLinkTotal,
        must_not_link: expected.relations.filter((r) => r.expect === 'must_not_link').length,
        may_link: expected.relations.filter((r) => r.expect === 'may_link').length,
      },
      findings: expected.expected_findings.length,
      rules: { accepted: accepted.length, proposed: run.rules.relations.length - accepted.length },
      candidates: candidateCounts,
      baseline: run.baseline.length,
    },
    ruleTier,
    systems,
    byType: sortRecord(byType),
    byTag: sortRecord(byTag),
    mustLinkMissed,
    mustLinkOnlyCompatible,
    mustNotLinkProposed,
    baselineMustNotLink,
    baselineMissed,
    findings,
  };
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
