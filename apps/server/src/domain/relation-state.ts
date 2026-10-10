/**
 * Shared relation writes: recording an assertion together with its event,
 * refreshing a relation's derived state (status, tier, confidence, anchor,
 * endpoint state) from its history, and turning records into API resources.
 * Used by ingest (`recompute.ts`), the pipeline and the review use cases.
 */
import {
  newId,
  type DeclaredProcedure,
  type PrincipalId,
  type ProjectId,
  type Relation,
  type RelationId,
  type RelationType,
} from '@proa/contracts';

import type {
  AssertionKind,
  AssertionRecord,
  RelationRecord,
  StoredAssertion,
  StoredNoLink,
  Tx,
} from './ports.ts';
import { endpointState, recomputeStatus, type AssertionView } from './status.ts';
import { toRelation } from './views.ts';

/** `type\0from\0to`: the natural key of a relation within a project. */
export function naturalKey(type: RelationType, from: string, to: string): string {
  return `${type}\u0000${from}\u0000${to}`;
}

/** Groups assertions by relation, keeping their order. */
export function byRelation<T extends { relationId: RelationId }>(
  rows: readonly T[],
): Map<RelationId, T[]> {
  const out = new Map<RelationId, T[]>();
  for (const a of rows) {
    const list = out.get(a.relationId) ?? [];
    list.push(a);
    out.set(a.relationId, list);
  }
  return out;
}

export type AssertionInput = Omit<AssertionRecord, 'id' | 'projectId' | 'relationId' | 'seq'>;

const EVENT_TYPE: Readonly<Record<AssertionKind, string>> = {
  proposal: 'relation.proposed',
  withdrawal: 'relation.withdrawn',
  decision: 'relation.decided',
  note: 'relation.noted',
};

/**
 * Appends the event of a new assertion (which allocates its `seq`) and
 * returns the record; the caller inserts it once the relation row exists.
 *
 * @param by who caused it, if not the assertion's principal (a submission
 *   that supersedes another principal's proposal)
 */
export async function prepareAssertion(
  tx: Tx,
  projectId: ProjectId,
  relation: Pick<RelationRecord, 'id' | 'type' | 'fromRef' | 'toRef'>,
  input: AssertionInput,
  by?: { principalId: PrincipalId; clientId: string | null },
): Promise<AssertionRecord> {
  const seq = await tx.events.append(projectId, {
    type: EVENT_TYPE[input.kind],
    principalId: by?.principalId ?? input.principalId,
    clientId: by ? by.clientId : input.clientId,
    subjectRef: relation.id,
    payload: {
      relationId: relation.id,
      type: relation.type,
      from: relation.fromRef,
      to: relation.toRef,
      sourceKind: input.sourceKind,
      ...(by ? { principalId: input.principalId } : {}),
      ...(input.verdict ? { verdict: input.verdict } : {}),
      ...(input.tier ? { tier: input.tier, confidence: input.confidence } : {}),
      ...(input.submissionId ? { submissionId: input.submissionId } : {}),
      ...(input.linkedRelationId ? { linkedRelationId: input.linkedRelationId } : {}),
      ...autoAcceptPayload(input),
    },
  });
  return { ...input, id: newId('assertion'), projectId, relationId: relation.id, seq };
}

/**
 * The `autoAccept` member of an assertion event (owner decision 19): the
 * rule, its revision and the trigger of a marked assertion (ids only, never
 * the rule's criteria); nothing for an unmarked one, so its event stays as
 * before.
 */
export function autoAcceptPayload(input: {
  autoAcceptRuleId?: string | null;
  autoAcceptRuleRevision?: number | null;
  autoAcceptTriggerId?: string | null;
}): { autoAccept?: { ruleId: string; revision: number; triggerId: string | null } } {
  if (!input.autoAcceptRuleId || input.autoAcceptRuleRevision == null) return {};
  return {
    autoAccept: {
      ruleId: input.autoAcceptRuleId,
      revision: input.autoAcceptRuleRevision,
      triggerId: input.autoAcceptTriggerId ?? null,
    },
  };
}

/** The derived columns of a relation, from its history and the head fingerprints of its endpoints. */
export function derivedState(
  relation: Pick<RelationRecord, 'tier'>,
  history: readonly AssertionView[],
  current: { from: string | undefined; to: string | undefined },
) {
  const state = recomputeStatus(history);
  return {
    status: state.status,
    endpointState: endpointState(state.anchor, current),
    tier: state.tier ?? relation.tier,
    confidence: state.confidence,
    fromFp: state.anchor?.fromFp ?? null,
    toFp: state.anchor?.toFp ?? null,
  };
}

/**
 * Writes a relation's derived state if it changed, or always with `touched`
 * (a new assertion: the version moves, so a bulk decision based on the old
 * state fails). Records `relation.endpoint_changed` when the endpoint state
 * of a live relation changes.
 *
 * @returns the stored relation (unchanged record if nothing was written)
 */
export async function refreshRelation(
  tx: Tx,
  projectId: ProjectId,
  relation: RelationRecord,
  history: readonly AssertionView[],
  current: { from: string | undefined; to: string | undefined },
  options: { touched: boolean; principalId: PrincipalId; clientId: string | null },
): Promise<{ relation: RelationRecord; endpointChanged: boolean }> {
  const patch = derivedState(relation, history, current);
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
    (k) => patch[k] !== relation[k],
  );
  if (!changed && !options.touched) return { relation, endpointChanged: false };
  const stored = await tx.relations.update(projectId, relation.id, patch);
  const endpointChanged =
    patch.endpointState !== relation.endpointState && patch.status !== 'obsolete';
  if (endpointChanged) {
    await tx.events.append(projectId, {
      type: 'relation.endpoint_changed',
      principalId: options.principalId,
      clientId: options.clientId,
      subjectRef: relation.id,
      payload: {
        relationId: relation.id,
        type: relation.type,
        from: relation.fromRef,
        to: relation.toRef,
        previous: relation.endpointState,
        endpointState: patch.endpointState,
      },
    });
  }
  return { relation: stored, endpointChanged };
}

/**
 * Relations as API resources: provenance from their histories (one query)
 * and the live, current no-links on their typed pairs (one query, currency
 * in SQL against the heads and `procedure`).
 *
 * @param procedure the procedure claims name now
 */
export async function relationViews(
  tx: Tx,
  projectId: ProjectId,
  records: readonly RelationRecord[],
  procedure: DeclaredProcedure,
): Promise<Relation[]> {
  if (records.length === 0) return [];
  const histories = byRelation<StoredAssertion>(
    await tx.assertions.listForRelations(
      projectId,
      records.map((r) => r.id),
    ),
  );
  const pairs = records.flatMap((r) =>
    r.type === 'manual' ? [] : [{ type: r.type, from: r.fromRef, to: r.toRef }],
  );
  const noLinks = new Map<string, StoredNoLink[]>();
  if (pairs.length > 0) {
    for (const n of await tx.noLinks.listLive(projectId, { pairs }, procedure)) {
      if (!n.current) continue;
      const key = naturalKey(n.type, n.fromRef, n.toRef);
      noLinks.set(key, [...(noLinks.get(key) ?? []), n]);
    }
  }
  return records.map((r) =>
    toRelation(
      r,
      histories.get(r.id) ?? [],
      noLinks.get(naturalKey(r.type, r.fromRef, r.toRef)) ?? [],
    ),
  );
}
