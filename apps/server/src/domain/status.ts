/**
 * Relation status as a pure function of the assertion history (CONCEPT §2,
 * "Status"), and endpoint state from fingerprints.
 */
import type { EndpointState, PrincipalId, RelationStatus, Tier } from '@proa/contracts';

import type { AssertionKind, Verdict } from './ports.ts';

/** The fields of an assertion that status computation looks at. */
export interface AssertionView {
  seq: number;
  kind: AssertionKind;
  verdict: Verdict | null;
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
}

/**
 * Each principal's current stance: its latest assertion, unless that is a
 * withdrawal. A newer assertion of the same principal replaces its older
 * ones (a new proposal replaces its previous proposal or decision).
 */
export function currentStances(history: readonly AssertionView[]): AssertionView[] {
  const latest = new Map<PrincipalId, AssertionView>();
  for (const a of history) {
    const prev = latest.get(a.principalId);
    if (!prev || a.seq > prev.seq) latest.set(a.principalId, a);
  }
  return [...latest.values()].filter((a) => a.kind !== 'withdrawal').sort((a, b) => a.seq - b.seq);
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

function sameFingerprints(a: Fingerprints, b: Fingerprints): boolean {
  return a.fromFp === b.fromFp && a.toFp === b.toFp;
}

/**
 * `recomputeStatus` (CONCEPT §2): the latest decision wins, except that a
 * newer proposal whose fingerprints differ from those stored with a
 * rejection reopens the relation as `proposed`. Without a decision, a live
 * proposal means `proposed`; otherwise the relation is `obsolete`.
 *
 * @param history every assertion of one relation, in any order
 */
export function recomputeStatus(history: readonly AssertionView[]): RelationState {
  const stances = currentStances(history);
  const decisions = stances.filter((a) => a.kind === 'decision');
  const proposals = stances.filter((a) => a.kind === 'proposal');
  const decision = decisions.at(-1);

  let status: RelationStatus;
  let anchorSource: AssertionView | undefined;
  if (decision?.verdict) {
    const reopening =
      decision.verdict === 'reject'
        ? proposals.filter((p) => p.seq > decision.seq && !sameFingerprints(p, decision)).at(-1)
        : undefined;
    status = reopening ? 'proposed' : VERDICT_STATUS[decision.verdict];
    anchorSource = reopening ?? decision;
  } else if (proposals.length > 0) {
    status = 'proposed';
    anchorSource = proposals.at(-1);
  } else {
    status = 'obsolete';
    anchorSource = [...history].sort((a, b) => a.seq - b.seq).at(-1);
  }

  const strongest = stances
    .filter((a) => a.tier !== null)
    .sort(
      (a, b) =>
        TIER_RANK[b.tier ?? 'lexical'] - TIER_RANK[a.tier ?? 'lexical'] ||
        (b.confidence ?? 0) - (a.confidence ?? 0) ||
        b.seq - a.seq,
    )[0];
  const fallback = [...history].filter((a) => a.tier !== null).sort((a, b) => b.seq - a.seq)[0];
  const tierSource = strongest ?? fallback;

  return {
    status,
    tier: tierSource?.tier ?? null,
    confidence: tierSource?.confidence ?? null,
    anchor: anchorSource ? { fromFp: anchorSource.fromFp, toFp: anchorSource.toFp } : null,
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
