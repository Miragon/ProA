/**
 * Relation status as a pure function of the assertion history (CONCEPT §2,
 * "Status"), and endpoint state from fingerprints.
 */
import type {
  DeclaredProcedure,
  EndpointState,
  PrincipalId,
  RelationStatus,
  SourceKind,
  Tier,
} from '@proa/contracts';

import type { AssertionKind, Verdict } from './ports.ts';

/** The fields of an assertion that status computation looks at. */
export interface AssertionView {
  seq: number;
  kind: AssertionKind;
  verdict: Verdict | null;
  sourceKind: SourceKind;
  principalId: PrincipalId;
  tier: Tier | null;
  confidence: number | null;
  fromFp: string | null;
  toFp: string | null;
}

export interface Fingerprints {
  fromFp: string | null;
  toFp: string | null;
}

export interface RelationState {
  status: RelationStatus;
  /** Tier of the strongest live assertion (falls back to the latest assertion with a tier). */
  tier: Tier | null;
  confidence: number | null;
  /** Fingerprints the status rests on; endpoint state compares the head against them. */
  anchor: Fingerprints | null;
  /**
   * Seq of the assertion the status rests on (its provenance): the deciding
   * decision, the reopening or latest live proposal, or for an obsolete
   * relation its latest assertion. `null` without assertions.
   */
  basisSeq: number | null;
}

/** Notes (answers, comments) are part of the history but never a stance. */
function stancesOnly<T extends AssertionView>(history: readonly T[]): T[] {
  return history.filter((a) => a.kind !== 'note');
}

/**
 * Each principal's current stance: its latest assertion, unless that is a
 * withdrawal. A newer assertion of the same principal replaces its older
 * ones (a new proposal replaces its previous proposal or decision). Notes
 * are ignored.
 */
export function currentStances<T extends AssertionView>(history: readonly T[]): T[] {
  const latest = new Map<PrincipalId, T>();
  for (const a of stancesOnly(history)) {
    const prev = latest.get(a.principalId);
    if (!prev || a.seq > prev.seq) latest.set(a.principalId, a);
  }
  return [...latest.values()].filter((a) => a.kind !== 'withdrawal').sort((a, b) => a.seq - b.seq);
}

/**
 * The decisions in force, oldest first: each principal's current stance if
 * it is a decision, and a human's latest decision even after that human
 * proposed or withdrew a proposal since (a human working the pipeline, or
 * the supersession of that proposal). Humans change a decision only by
 * deciding again (CONCEPT §2: "the latest decision wins"). The rule
 * principal's later proposal or withdrawal does end its decision, since rule
 * assertions follow the rules.
 */
export function decisionsInForce<T extends AssertionView>(history: readonly T[]): T[] {
  const out = currentStances(history).filter((a) => a.kind === 'decision');
  const latestHuman = new Map<PrincipalId, T>();
  for (const a of history) {
    if (a.kind !== 'decision' || a.sourceKind !== 'human') continue;
    const prev = latestHuman.get(a.principalId);
    if (!prev || a.seq > prev.seq) latestHuman.set(a.principalId, a);
  }
  for (const d of latestHuman.values()) if (!out.includes(d)) out.push(d);
  return out.sort((a, b) => a.seq - b.seq);
}

const TIER_RANK: Readonly<Record<Tier, number>> = {
  rule: 4,
  manual: 3,
  key: 2,
  semantic: 1,
  lexical: 0,
};

const VERDICT_STATUS: Readonly<Record<Verdict, RelationStatus>> = {
  accept: 'accepted',
  reject: 'rejected',
  hold: 'held',
};

export function sameFingerprints(a: Fingerprints, b: Fingerprints): boolean {
  return a.fromFp === b.fromFp && a.toFp === b.toFp;
}

/** Same procedure id and version (`null`: none declared). */
export function sameProcedure(
  a: DeclaredProcedure | null | undefined,
  b: DeclaredProcedure | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return a.id === b.id && a.version === b.version;
}

/**
 * `recomputeStatus` (CONCEPT §2): the latest decision in force wins
 * ({@link decisionsInForce}), except that a newer proposal whose
 * fingerprints differ from those stored with a rejection reopens the
 * relation as `proposed`. Without a decision, a live proposal means
 * `proposed`; otherwise the relation is `obsolete`. Notes never change the
 * status.
 *
 * @param history every assertion of one relation, in any order
 */
export function recomputeStatus(history: readonly AssertionView[]): RelationState {
  const stances = currentStances(history);
  const decisions = decisionsInForce(history);
  const proposals = stances.filter((a) => a.kind === 'proposal');
  const decision = decisions.at(-1);

  let status: RelationStatus;
  let basis: AssertionView | undefined;
  if (decision?.verdict) {
    const reopening =
      decision.verdict === 'reject'
        ? proposals.filter((p) => p.seq > decision.seq && !sameFingerprints(p, decision)).at(-1)
        : undefined;
    status = reopening ? 'proposed' : VERDICT_STATUS[decision.verdict];
    basis = reopening ?? decision;
  } else if (proposals.length > 0) {
    status = 'proposed';
    basis = proposals.at(-1);
  } else {
    status = 'obsolete';
    basis = [...stancesOnly(history)].sort((a, b) => a.seq - b.seq).at(-1);
  }

  const strongest = [...stances, ...decisions.filter((d) => !stances.includes(d))]
    .filter((a) => a.tier !== null)
    .sort(
      (a, b) =>
        TIER_RANK[b.tier ?? 'lexical'] - TIER_RANK[a.tier ?? 'lexical'] ||
        (b.confidence ?? 0) - (a.confidence ?? 0) ||
        b.seq - a.seq,
    )[0];
  const fallback = stancesOnly(history)
    .filter((a) => a.tier !== null)
    .sort((a, b) => b.seq - a.seq)[0];
  const tierSource = strongest ?? fallback;

  return {
    status,
    tier: tierSource?.tier ?? null,
    confidence: tierSource?.confidence ?? null,
    anchor: basis ? { fromFp: basis.fromFp, toFp: basis.toFp } : null,
    basisSeq: basis?.seq ?? null,
  };
}

/**
 * Endpoint state (CONCEPT §2): `missing` if an endpoint is not in the head
 * facts, `changed` if its fingerprint differs from the anchor, else `ok`.
 *
 * @param current fingerprints of the endpoints in the head (`undefined`: not in the head)
 */
export function endpointState(
  anchor: Fingerprints | null,
  current: { from: string | undefined; to: string | undefined },
): EndpointState {
  if (current.from === undefined || current.to === undefined) return 'missing';
  if (!anchor) return 'ok';
  return anchor.fromFp === current.from && anchor.toFp === current.to ? 'ok' : 'changed';
}

/** What a new proposal does to a relation (CONCEPT §3 "Validation"). */
export type ProposalEffect = 'applied' | 'duplicate' | 'suppressed' | 'reopened';

export interface NewProposal extends Fingerprints {
  principalId: PrincipalId;
  tier: Tier;
  confidence: number;
  rationale: string;
  question: string | null;
  /**
   * A pipeline proposal's basis (judge each pair once): the endpoint models'
   * `facts_hash` as the agent saw them and the declared procedure. Absent
   * for ad-hoc proposals.
   */
  basis?: { fromHash: string; toHash: string; procedure: DeclaredProcedure };
}

/** What `classifyProposal` reads of an assertion besides {@link AssertionView}. */
export interface ClassifiedAssertion extends AssertionView {
  rationale: string | null;
  question: string | null;
  submissionId?: string | null;
  fromHash?: string | null;
  toHash?: string | null;
  declared?: { procedure: DeclaredProcedure | null } | null;
}

/**
 * Classifies a proposal against a relation's history, as a pure function:
 * - `suppressed`: the current status rests on a human decision whose
 *   fingerprints equal the proposal's (a human already decided and nothing
 *   changed) — not recorded;
 * - `duplicate`: the proposer's own live proposal says the same (for a
 *   pipeline proposal: its own live pipeline proposal with the same basis
 *   and procedure too, so a re-judgement on a newer version is recorded and
 *   carries the new basis), or the relation is accepted by the rule tier
 *   with these fingerprints — not recorded;
 * - `reopened`: recorded, and the rejected relation becomes `proposed`
 *   because an endpoint changed since the rejection;
 * - `applied`: recorded.
 *
 * @param history the relation's assertions with their rationale and question (`[]` for a new relation)
 */
export function classifyProposal(
  history: readonly ClassifiedAssertion[],
  proposal: NewProposal,
): { effect: ProposalEffect; record: boolean } {
  const before = recomputeStatus(history);
  const basis = history.find((a) => a.seq === before.basisSeq);
  if (
    basis?.kind === 'decision' &&
    basis.sourceKind === 'human' &&
    sameFingerprints(basis, proposal)
  ) {
    return { effect: 'suppressed', record: false };
  }
  if (
    basis?.kind === 'decision' &&
    basis.sourceKind === 'rule' &&
    before.status === 'accepted' &&
    sameFingerprints(basis, proposal)
  ) {
    return { effect: 'duplicate', record: false };
  }
  const own = currentStances(history).find((a) => a.principalId === proposal.principalId);
  if (
    own?.kind === 'proposal' &&
    own.tier === proposal.tier &&
    own.confidence === proposal.confidence &&
    (own.rationale ?? '') === proposal.rationale &&
    own.question === proposal.question &&
    sameFingerprints(own, proposal) &&
    (proposal.basis === undefined ||
      ((own.submissionId ?? null) !== null &&
        own.fromHash === proposal.basis.fromHash &&
        own.toHash === proposal.basis.toHash &&
        sameProcedure(own.declared?.procedure, proposal.basis.procedure)))
  ) {
    return { effect: 'duplicate', record: false };
  }
  const maxSeq = history.reduce((m, a) => Math.max(m, a.seq), 0);
  const after = recomputeStatus([
    ...history,
    {
      seq: maxSeq + 1,
      kind: 'proposal',
      verdict: null,
      sourceKind: 'agent',
      principalId: proposal.principalId,
      tier: proposal.tier,
      confidence: proposal.confidence,
      fromFp: proposal.fromFp,
      toFp: proposal.toFp,
    },
  ]);
  const reopened = before.status === 'rejected' && after.status === 'proposed';
  return { effect: reopened ? 'reopened' : 'applied', record: true };
}
