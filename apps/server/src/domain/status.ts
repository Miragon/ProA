/**
 * Status as a pure function of an assertion history (CONCEPT §2, "Status"),
 * and endpoint state from fingerprints. Generalised over the subject (M4 §8
 * item 5): a relation is anchored to the fingerprints of its two endpoints, a
 * placement (`value-chain/placement-state.ts`) to those of its step and its
 * process. The relation functions keep their names and signatures; they are
 * the {@link RELATION} instances of the generic ones.
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

/** The fields of an assertion of any subject that status computation looks at. */
export interface StanceView {
  seq: number;
  kind: AssertionKind;
  verdict: Verdict | null;
  sourceKind: SourceKind;
  principalId: PrincipalId;
  tier: Tier | null;
  confidence: number | null;
  /**
   * The auto-accept rule of a marked assertion (owner decision 19): a human
   * acceptance an owner's rule recorded, or its revocation (a withdrawal).
   * Absent or `null` on every other assertion.
   */
  autoAcceptRuleId?: string | null;
}

export interface Fingerprints {
  fromFp: string | null;
  toFp: string | null;
}

/** The fields of a relation assertion that status computation looks at. */
export type AssertionView = StanceView & Fingerprints;

/** The derived state of a subject; `F` is its anchor (the fingerprints of both ends). */
export interface SubjectState<F> {
  status: RelationStatus;
  /** Tier of the strongest live assertion (falls back to the latest assertion with a tier). */
  tier: Tier | null;
  confidence: number | null;
  /** Fingerprints the status rests on; endpoint state compares the head against them. */
  anchor: F | null;
  /**
   * Seq of the assertion the status rests on (its provenance): the deciding
   * decision, the reopening or latest live proposal, or for an obsolete
   * subject its latest assertion. `null` without assertions.
   */
  basisSeq: number | null;
}

export type RelationState = SubjectState<Fingerprints>;

/**
 * What status computation needs to know about a subject: how an assertion is
 * anchored, when two anchors are the same, and the view of a proposal that
 * `classifyProposalOf` adds to a history to see its effect.
 */
export interface Subject<V extends StanceView, F> {
  anchor(a: V): F;
  sameAnchor(x: F, y: F): boolean;
  proposalView(p: {
    seq: number;
    principalId: PrincipalId;
    tier: Tier;
    confidence: number;
    anchor: F;
  }): V;
}

/** Notes (answers, comments) are part of the history but never a stance. */
function stancesOnly<T extends StanceView>(history: readonly T[]): T[] {
  return history.filter((a) => a.kind !== 'note');
}

/** A revocation of an auto-acceptance: a withdrawal marked with the rule (owner decision 19). */
function isRevocation(a: StanceView): boolean {
  return a.kind === 'withdrawal' && (a.autoAcceptRuleId ?? null) !== null;
}

/**
 * Each principal's current stance: its latest assertion, unless that is a
 * withdrawal. A newer assertion of the same principal replaces its older
 * ones (a new proposal replaces its previous proposal or decision). Notes
 * are ignored. Returns the input objects.
 *
 * A revocation of an auto-acceptance (owner decision 19) ends exactly that
 * acceptance: it replaces the principal's stance only while that stance is
 * the marked decision itself. When the principal (the rule's author) has
 * proposed or withdrawn since, the revocation leaves that later stance
 * alone; {@link decisionsInForce} still ends the acceptance.
 */
export function currentStances<T extends StanceView>(history: readonly T[]): T[] {
  const latest = new Map<PrincipalId, T>();
  const stances = stancesOnly(history);
  if (stances.some(isRevocation)) stances.sort((a, b) => a.seq - b.seq);
  for (const a of stances) {
    const prev = latest.get(a.principalId);
    if (prev && a.seq <= prev.seq) continue;
    if (
      isRevocation(a) &&
      !(
        prev?.kind === 'decision' &&
        (prev.autoAcceptRuleId ?? null) === (a.autoAcceptRuleId ?? null)
      )
    ) {
      continue;
    }
    latest.set(a.principalId, a);
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
 *
 * The one exception to "only by deciding again" (owner decision 19): an
 * acceptance an auto-accept rule recorded ends with its revocation, a later
 * withdrawal of the same principal marked with the same rule. Nothing takes
 * its place: no older decision of that principal comes back (the rule only
 * ever accepts items without any human assertion). Returns the input objects.
 */
export function decisionsInForce<T extends StanceView>(history: readonly T[]): T[] {
  const out = currentStances(history).filter((a) => a.kind === 'decision');
  const latestHuman = new Map<PrincipalId, T>();
  for (const a of history) {
    if (a.kind !== 'decision' || a.sourceKind !== 'human') continue;
    const prev = latestHuman.get(a.principalId);
    if (!prev || a.seq > prev.seq) latestHuman.set(a.principalId, a);
  }
  for (const d of latestHuman.values()) {
    if (!out.includes(d) && !isRevokedAutoAccept(history, d)) out.push(d);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * An auto-accept rule's acceptance that an owner revoked: a later withdrawal
 * of its principal carries the same rule (owner decision 19).
 */
export function isRevokedAutoAccept<T extends StanceView>(history: readonly T[], d: T): boolean {
  const ruleId = d.autoAcceptRuleId ?? null;
  if (ruleId === null || d.kind !== 'decision') return false;
  return history.some(
    (w) =>
      w.kind === 'withdrawal' &&
      w.principalId === d.principalId &&
      (w.autoAcceptRuleId ?? null) === ruleId &&
      w.seq > d.seq,
  );
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

/** The relation subject: anchored to the fingerprints of both endpoints. */
export const RELATION: Subject<AssertionView, Fingerprints> = {
  anchor: (a) => ({ fromFp: a.fromFp, toFp: a.toFp }),
  sameAnchor: sameFingerprints,
  proposalView: (p) => ({
    seq: p.seq,
    kind: 'proposal',
    verdict: null,
    sourceKind: 'agent',
    principalId: p.principalId,
    tier: p.tier,
    confidence: p.confidence,
    fromFp: p.anchor.fromFp,
    toFp: p.anchor.toFp,
  }),
};

/**
 * `recomputeStatus` (CONCEPT §2) of any subject: the latest decision in force
 * wins ({@link decisionsInForce}), except that a newer proposal whose anchor
 * differs from the one stored with a rejection reopens the subject as
 * `proposed`. Without a decision, a live proposal means `proposed`;
 * otherwise the subject is `obsolete`. Notes never change the status.
 *
 * @param history every assertion of one subject, in any order
 */
export function recomputeStatusOf<V extends StanceView, F>(
  subject: Subject<V, F>,
  history: readonly V[],
): SubjectState<F> {
  const stances = currentStances(history);
  const decisions = decisionsInForce(history);
  const proposals = stances.filter((a) => a.kind === 'proposal');
  const decision = decisions.at(-1);

  let status: RelationStatus;
  let basis: V | undefined;
  if (decision?.verdict) {
    const reopening =
      decision.verdict === 'reject'
        ? proposals
            .filter(
              (p) =>
                p.seq > decision.seq &&
                !subject.sameAnchor(subject.anchor(p), subject.anchor(decision)),
            )
            .at(-1)
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
    anchor: basis ? subject.anchor(basis) : null,
    basisSeq: basis?.seq ?? null,
  };
}

/**
 * `recomputeStatus` (CONCEPT §2) of a relation: {@link recomputeStatusOf}
 * with the endpoint fingerprints as the anchor.
 *
 * @param history every assertion of one relation, in any order
 */
export function recomputeStatus(history: readonly AssertionView[]): RelationState {
  return recomputeStatusOf(RELATION, history);
}

/**
 * Endpoint state of a subject with two ends (CONCEPT §2): `missing` if an end
 * is not in the head, `changed` if its fingerprint differs from the anchor,
 * else `ok`.
 *
 * @param anchor the anchor's fingerprints of both ends (`null`: none yet)
 * @param current head fingerprints of both ends (`undefined`: not in the head)
 */
export function pairEndpointState(
  anchor: readonly [string | null, string | null] | null,
  current: readonly [string | undefined, string | undefined],
): EndpointState {
  if (current[0] === undefined || current[1] === undefined) return 'missing';
  if (!anchor) return 'ok';
  return anchor[0] === current[0] && anchor[1] === current[1] ? 'ok' : 'changed';
}

/**
 * Endpoint state of a relation (CONCEPT §2): `missing` if an endpoint is not
 * in the head facts, `changed` if its fingerprint differs from the anchor,
 * else `ok`.
 *
 * @param current fingerprints of the endpoints in the head (`undefined`: not in the head)
 */
export function endpointState(
  anchor: Fingerprints | null,
  current: { from: string | undefined; to: string | undefined },
): EndpointState {
  return pairEndpointState(anchor ? [anchor.fromFp, anchor.toFp] : null, [
    current.from,
    current.to,
  ]);
}

/** What a new proposal does to a subject (CONCEPT §3 "Validation"). */
export type ProposalEffect = 'applied' | 'duplicate' | 'suppressed' | 'reopened';

/** A new proposal on a subject with anchor `F` and pipeline basis `B`. */
export interface NewProposalOf<F, B> {
  principalId: PrincipalId;
  tier: Tier;
  confidence: number;
  rationale: string;
  question: string | null;
  anchor: F;
  /** A pipeline proposal's basis (judge each pair once); absent for ad-hoc proposals. */
  basis?: B;
}

/** The basis of a pipeline proposal on a relation. */
export interface RelationBasis {
  fromHash: string;
  toHash: string;
  procedure: DeclaredProcedure;
}

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
  basis?: RelationBasis;
}

/** What `classifyProposal` reads of an assertion besides {@link AssertionView}. */
export interface ClassifiedAssertion extends StanceView, Fingerprints {
  rationale: string | null;
  question: string | null;
  submissionId?: string | null;
  fromHash?: string | null;
  toHash?: string | null;
  declared?: { procedure: DeclaredProcedure | null } | null;
}

/**
 * Classifies a proposal against a subject's history, as a pure function:
 * - `suppressed`: the current status rests on a human decision whose anchor
 *   equals the proposal's (a human already decided and nothing changed) —
 *   not recorded. A pipeline proposal (with a basis) under a human hold is
 *   the exception: it is the agent's judgement on the held subject
 *   (procedure §10, judge each pair once), so it goes on to the checks below
 *   and is recorded unless it is a `duplicate`; the hold stays the decision
 *   in force ({@link decisionsInForce}), so the status stays `held`;
 * - `duplicate`: the proposer's own live proposal says the same (for a
 *   pipeline proposal: its own live pipeline proposal with the same basis
 *   too, as `sameBasis` decides, so a re-judgement on a newer version is
 *   recorded and carries the new basis), or the subject is accepted by the
 *   rule tier with this anchor — not recorded;
 * - `reopened`: recorded, and the rejected subject becomes `proposed`
 *   because an end changed since the rejection;
 * - `applied`: recorded.
 *
 * @param sameBasis whether the proposer's own live proposal is a pipeline
 *   judgement on this basis
 * @param history the subject's assertions with their rationale and question (`[]` for a new subject)
 */
export function classifyProposalOf<
  V extends StanceView,
  C extends V & { rationale: string | null; question: string | null },
  F,
  B,
>(
  subject: Subject<V, F>,
  sameBasis: (own: C, basis: B) => boolean,
  history: readonly C[],
  proposal: NewProposalOf<F, B>,
): { effect: ProposalEffect; record: boolean } {
  const before = recomputeStatusOf(subject, history);
  const basis = history.find((a) => a.seq === before.basisSeq);
  if (
    basis?.kind === 'decision' &&
    basis.sourceKind === 'human' &&
    !(basis.verdict === 'hold' && proposal.basis !== undefined) &&
    subject.sameAnchor(subject.anchor(basis), proposal.anchor)
  ) {
    return { effect: 'suppressed', record: false };
  }
  if (
    basis?.kind === 'decision' &&
    basis.sourceKind === 'rule' &&
    before.status === 'accepted' &&
    subject.sameAnchor(subject.anchor(basis), proposal.anchor)
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
    subject.sameAnchor(subject.anchor(own), proposal.anchor) &&
    (proposal.basis === undefined || sameBasis(own, proposal.basis))
  ) {
    return { effect: 'duplicate', record: false };
  }
  const maxSeq = history.reduce((m, a) => Math.max(m, a.seq), 0);
  const after = recomputeStatusOf(subject, [
    ...history,
    subject.proposalView({
      seq: maxSeq + 1,
      principalId: proposal.principalId,
      tier: proposal.tier,
      confidence: proposal.confidence,
      anchor: proposal.anchor,
    }),
  ]);
  const reopened = before.status === 'rejected' && after.status === 'proposed';
  return { effect: reopened ? 'reopened' : 'applied', record: true };
}

/** The own-basis clause for relations: a pipeline proposal on the same hashes and procedure. */
function sameRelationBasis(own: ClassifiedAssertion, basis: RelationBasis): boolean {
  return (
    (own.submissionId ?? null) !== null &&
    own.fromHash === basis.fromHash &&
    own.toHash === basis.toHash &&
    sameProcedure(own.declared?.procedure, basis.procedure)
  );
}

/**
 * Classifies a proposal against a relation's history
 * ({@link classifyProposalOf} with the endpoint fingerprints as the anchor
 * and the endpoint models' `facts_hash` plus the procedure as the basis).
 *
 * @param history the relation's assertions with their rationale and question (`[]` for a new relation)
 */
export function classifyProposal(
  history: readonly ClassifiedAssertion[],
  proposal: NewProposal,
): { effect: ProposalEffect; record: boolean } {
  return classifyProposalOf(RELATION, sameRelationBasis, history, {
    principalId: proposal.principalId,
    tier: proposal.tier,
    confidence: proposal.confidence,
    rationale: proposal.rationale,
    question: proposal.question,
    anchor: { fromFp: proposal.fromFp, toFp: proposal.toFp },
    ...(proposal.basis === undefined ? {} : { basis: proposal.basis }),
  });
}
