/**
 * Auto-accept rules (owner decision 19): recording an acceptance and its
 * revocation, inside the caller's transaction (which holds the project lock).
 *
 * An acceptance is a human decision (`source_kind = 'human'`, verdict
 * `accept`) under the author of the rule revision in force, marked with the
 * rule, the revision and the triggering agent proposal; the database pins the
 * decider to that author (composite foreign key) and keeps "agents never
 * decide". It carries no tier, confidence or rationale, so what agents see of
 * it (a relation's provenance, a claim's `decision`) is a plain human
 * acceptance. The event names the causer (the agent whose proposal triggered
 * it, or the owner who applied the rule) and, in its payload, the decider and
 * the marker ids, never the rule's criteria.
 *
 * A revocation is a human withdrawal under the decision's principal with the
 * same marker (no trigger), caused by the revoking owner; `decisionsInForce`
 * ends the acceptance with it.
 */
import type { AssertionId, PlacementAssertionId, PrincipalId } from '@proa/contracts';

import type {
  AssertionRecord,
  PlacementAssertionRecord,
  PlacementRecord,
  RelationRecord,
} from '../ports.ts';
import { endpointFingerprints, type ProposalContext } from '../proposals.ts';
import { naturalKey, prepareAssertion, refreshRelation } from '../relation-state.ts';
import {
  endpointsOf,
  placementKey,
  preparePlacementAssertion,
  refreshPlacement,
} from '../value-chain/placement-state.ts';
import type { PlacementContext } from '../value-chain/placements.ts';
import type { AutoAcceptRuleRev } from './evaluate.ts';

/** Who caused a write (the event's principal), if not the context's actor. */
export interface Cause {
  principalId: PrincipalId;
  clientId: string | null;
}

/** The rationale of a revocation (German, like the review UI); never names the rule. */
export const REVOCATION_RATIONALE = 'Automatische Annahme widerrufen';

/** {@link REVOCATION_RATIONALE} with the owner's reason, if any. */
export function revocationRationale(reason: string | null): string {
  return reason ? `${REVOCATION_RATIONALE}: ${reason}` : REVOCATION_RATIONALE;
}

/** The acceptance a revocation ends. */
export interface MarkedDecision {
  principalId: PrincipalId;
  autoAcceptRuleId?: string | null;
  autoAcceptRuleRevision?: number | null;
}

function markerOf(d: MarkedDecision): { ruleId: string; revision: number } {
  if (!d.autoAcceptRuleId || d.autoAcceptRuleRevision == null) {
    throw new Error('not an auto-accept decision');
  }
  return { ruleId: d.autoAcceptRuleId, revision: d.autoAcceptRuleRevision };
}

/**
 * Records a rule's acceptance of a relation and refreshes its derived state.
 *
 * @param by the causer; defaults to the context's actor (the proposing agent)
 */
export async function recordRelationAutoAccept(
  ctx: ProposalContext,
  relation: RelationRecord,
  triggerId: AssertionId,
  rule: AutoAcceptRuleRev,
  by?: Cause,
): Promise<RelationRecord> {
  const cause = by ?? { principalId: ctx.actor.principalId, clientId: ctx.actor.clientId };
  const current = endpointFingerprints(ctx.fps, relation);
  const history = ctx.histories.get(relation.id) ?? [];
  const decision = await prepareAssertion(
    ctx.tx,
    ctx.projectId,
    relation,
    {
      kind: 'decision',
      verdict: 'accept',
      sourceKind: 'human',
      principalId: rule.authorId,
      clientId: rule.authorClientId,
      declared: null,
      submissionId: null,
      tier: null,
      confidence: null,
      rationale: null,
      evidence: null,
      question: null,
      label: null,
      linkedRelationId: null,
      fromFp: current.from ?? null,
      toFp: current.to ?? null,
      fromHash: null,
      toHash: null,
      autoAcceptRuleId: rule.ruleId,
      autoAcceptRuleRevision: rule.revision,
      autoAcceptTriggerId: triggerId,
    },
    cause,
  );
  return insertAndRefresh(ctx, relation, history, decision, cause);
}

/** Revokes a rule's acceptance of a relation and refreshes its derived state. */
export async function revokeRelationAutoAccept(
  ctx: ProposalContext,
  relation: RelationRecord,
  decision: MarkedDecision,
  reason: string | null,
  by: Cause,
): Promise<RelationRecord> {
  const marker = markerOf(decision);
  const current = endpointFingerprints(ctx.fps, relation);
  const history = ctx.histories.get(relation.id) ?? [];
  const withdrawal = await prepareAssertion(
    ctx.tx,
    ctx.projectId,
    relation,
    {
      kind: 'withdrawal',
      verdict: null,
      sourceKind: 'human',
      principalId: decision.principalId,
      clientId: by.clientId,
      declared: null,
      submissionId: null,
      tier: null,
      confidence: null,
      rationale: revocationRationale(reason),
      evidence: null,
      question: null,
      label: null,
      linkedRelationId: null,
      fromFp: current.from ?? null,
      toFp: current.to ?? null,
      fromHash: null,
      toHash: null,
      autoAcceptRuleId: marker.ruleId as AssertionRecord['autoAcceptRuleId'],
      autoAcceptRuleRevision: marker.revision,
      autoAcceptTriggerId: null,
    },
    by,
  );
  return insertAndRefresh(ctx, relation, history, withdrawal, by);
}

async function insertAndRefresh(
  ctx: ProposalContext,
  relation: RelationRecord,
  history: readonly AssertionRecord[],
  assertion: AssertionRecord,
  cause: Cause,
): Promise<RelationRecord> {
  await ctx.tx.assertions.insert(assertion);
  const next = [...history, assertion];
  ctx.histories.set(relation.id, next);
  const { relation: stored } = await refreshRelation(
    ctx.tx,
    ctx.projectId,
    relation,
    next,
    endpointFingerprints(ctx.fps, relation),
    { touched: true, principalId: cause.principalId, clientId: cause.clientId },
  );
  ctx.relations.set(naturalKey(stored.type, stored.fromRef, stored.toRef), stored);
  return stored;
}

/**
 * Records a rule's acceptance of a placement and refreshes its derived
 * state. Humanity comes from the rule revision (and the database's foreign
 * key), not from the causer, which is the proposing agent in the pipeline.
 *
 * @param by the causer; defaults to the context's actor
 */
export async function recordPlacementAutoAccept(
  ctx: PlacementContext,
  placement: PlacementRecord,
  triggerId: PlacementAssertionId,
  rule: AutoAcceptRuleRev,
  by?: Cause,
): Promise<PlacementRecord> {
  const cause = by ?? { principalId: ctx.actor.principalId, clientId: ctx.actor.clientId };
  const current = endpointsOf(ctx.endpoints, placement);
  const history = ctx.histories.get(placement.id) ?? [];
  const decision = await preparePlacementAssertion(
    ctx.tx,
    ctx.projectId,
    placement,
    {
      kind: 'decision',
      verdict: 'accept',
      sourceKind: 'human',
      principalId: rule.authorId,
      clientId: rule.authorClientId,
      declared: null,
      submissionId: null,
      tier: null,
      confidence: null,
      rationale: null,
      evidence: null,
      question: null,
      label: null,
      linkedPlacementId: null,
      stepFp: current.step ?? null,
      processFp: current.process ?? null,
      stepHash: null,
      processHash: null,
      autoAcceptRuleId: rule.ruleId,
      autoAcceptRuleRevision: rule.revision,
      autoAcceptTriggerId: triggerId,
    },
    cause,
  );
  return insertAndRefreshPlacement(ctx, placement, history, decision, cause);
}

/** Revokes a rule's acceptance of a placement and refreshes its derived state. */
export async function revokePlacementAutoAccept(
  ctx: PlacementContext,
  placement: PlacementRecord,
  decision: MarkedDecision,
  reason: string | null,
  by: Cause,
): Promise<PlacementRecord> {
  const marker = markerOf(decision);
  const current = endpointsOf(ctx.endpoints, placement);
  const history = ctx.histories.get(placement.id) ?? [];
  const withdrawal = await preparePlacementAssertion(
    ctx.tx,
    ctx.projectId,
    placement,
    {
      kind: 'withdrawal',
      verdict: null,
      sourceKind: 'human',
      principalId: decision.principalId,
      clientId: by.clientId,
      declared: null,
      submissionId: null,
      tier: null,
      confidence: null,
      rationale: revocationRationale(reason),
      evidence: null,
      question: null,
      label: null,
      linkedPlacementId: null,
      stepFp: current.step ?? null,
      processFp: current.process ?? null,
      stepHash: null,
      processHash: null,
      autoAcceptRuleId: marker.ruleId as PlacementAssertionRecord['autoAcceptRuleId'],
      autoAcceptRuleRevision: marker.revision,
      autoAcceptTriggerId: null,
    },
    by,
  );
  return insertAndRefreshPlacement(ctx, placement, history, withdrawal, by);
}

async function insertAndRefreshPlacement(
  ctx: PlacementContext,
  placement: PlacementRecord,
  history: readonly PlacementAssertionRecord[],
  assertion: PlacementAssertionRecord,
  cause: Cause,
): Promise<PlacementRecord> {
  await ctx.tx.placementAssertions.insert(assertion);
  const next = [...history, assertion];
  ctx.histories.set(placement.id, next);
  const { placement: stored } = await refreshPlacement(
    ctx.tx,
    ctx.projectId,
    placement,
    next,
    endpointsOf(ctx.endpoints, placement),
    { touched: true, principalId: cause.principalId, clientId: cause.clientId },
  );
  ctx.placements.set(
    placementKey(stored.valueChainId, stored.elementId, stored.generation, stored.processRef),
    stored,
  );
  return stored;
}
