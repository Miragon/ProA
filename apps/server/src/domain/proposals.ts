/**
 * Proposals (CONCEPT §3 "Validation"): the per-item checks of a submission
 * or an ad-hoc proposal, and the one write path both use. Agents never send
 * a tier or a source; the server computes the tier and derives the source
 * from the credential.
 */
import {
  MAX_EVIDENCE_ITEMS,
  MAX_QUESTION_CHARS,
  MAX_RATIONALE_CHARS,
  hasControlCharacters,
  isRef,
  newId,
  parseRef,
  type InvalidReason,
  type ProjectId,
  type Ref,
  type RelationType,
  type SubmissionId,
} from '@proa/contracts';
import type { LinkType, ProposalTier } from '@proa/relations';

import { sourceKindOf, type Actor } from './actor.ts';
import type { HeadFingerprints } from './fingerprints.ts';
import type {
  AssertionRecord,
  Declared,
  PairAssessment,
  PairQuery,
  RelationRecord,
  Tx,
} from './ports.ts';
import { derivedState, naturalKey, prepareAssertion, refreshRelation } from './relation-state.ts';
import { classifyProposal, type ProposalEffect } from './status.ts';

const LINK_TYPES: readonly string[] = ['call', 'message', 'signal', 'trigger'];

/** A proposal that passed every check, with its server-computed tier. */
export interface ValidProposal {
  type: LinkType;
  from: Ref;
  to: Ref;
  tier: ProposalTier;
  confidence: number;
  rationale: string;
  evidence: string[];
  question: string | null;
}

export type Validation = { ok: true; value: ValidProposal } | { ok: false; reason: InvalidReason };

/** An item as parsed from a submission or an ad-hoc proposal (shape checked, limits not yet). */
export interface ProposalDraft {
  type: string;
  from: string;
  to: string;
  confidence: number;
  rationale: string;
  evidence: string[];
  question: string | null;
}

/**
 * The per-item checks, in this order: type (`manual` is for humans),
 * well-formed refs, confidence in [0, 1], rationale ≤ 1,000 and question ≤
 * 500 characters, ≤ 20 evidence entries, no control characters other than
 * tab and line breaks in rationale, question and evidence (PostgreSQL
 * cannot store U+0000), one end in the task's model, then the head facts
 * (`unknown-ref`, `type-mismatch`, `same-process`, `message-flow`).
 *
 * @param taskModelKey the model of the task (submissions); omitted for ad-hoc proposals
 */
export function validateProposal(
  item: ProposalDraft,
  assess: (pair: PairQuery) => PairAssessment,
  taskModelKey?: string,
): Validation {
  if (!LINK_TYPES.includes(item.type)) return { ok: false, reason: 'type-not-allowed' };
  if (!isRef(item.from) || !isRef(item.to)) return { ok: false, reason: 'malformed-ref' };
  if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
    return { ok: false, reason: 'confidence-out-of-range' };
  }
  if (item.rationale.length > MAX_RATIONALE_CHARS)
    return { ok: false, reason: 'rationale-too-long' };
  if (item.question !== null && item.question.length > MAX_QUESTION_CHARS) {
    return { ok: false, reason: 'question-too-long' };
  }
  if (item.evidence.length > MAX_EVIDENCE_ITEMS) return { ok: false, reason: 'too-much-evidence' };
  if (
    hasControlCharacters(item.rationale) ||
    (item.question !== null && hasControlCharacters(item.question)) ||
    item.evidence.some(hasControlCharacters)
  ) {
    return { ok: false, reason: 'control-characters' };
  }
  if (
    taskModelKey !== undefined &&
    parseRef(item.from).modelKey !== taskModelKey &&
    parseRef(item.to).modelKey !== taskModelKey
  ) {
    return { ok: false, reason: 'outside-task-model' };
  }
  const type = item.type as LinkType;
  const assessment = assess({ type, from: item.from, to: item.to });
  if (!assessment.ok) return { ok: false, reason: assessment.reason };
  return {
    ok: true,
    value: {
      type,
      from: item.from,
      to: item.to,
      tier: assessment.tier,
      confidence: item.confidence,
      rationale: item.rationale,
      evidence: item.evidence,
      question: item.question === '' ? null : item.question,
    },
  };
}

/** The project state a batch of proposals works on, kept current as it writes. */
export interface ProposalContext {
  tx: Tx;
  projectId: ProjectId;
  actor: Actor;
  fps: HeadFingerprints;
  /** Relations by natural key. */
  relations: Map<string, RelationRecord>;
  /** Assertions per relation id, in seq order. */
  histories: Map<string, AssertionRecord[]>;
  declared: Declared | null;
  /** The stored submission (pipeline), `null` for ad-hoc proposals. */
  submissionId: SubmissionId | null;
  /**
   * Pipeline proposals: the basis of a pair, the `facts_hash` of both
   * endpoint models as the claim showed them (judge each pair once).
   */
  basisOf?: (from: Ref, to: Ref) => { fromHash: string; toHash: string };
}

export function endpointFingerprints(
  fps: HeadFingerprints,
  r: { type: RelationType; fromRef: string; toRef: string },
) {
  return { from: fps.get(r.type, 'from', r.fromRef), to: fps.get(r.type, 'to', r.toRef) };
}

/**
 * Classifies a valid proposal and records it if it adds something
 * (`classifyProposal`): creates the relation when new, appends the proposal
 * assertion with its event, and refreshes the relation's derived state.
 */
export async function applyProposal(
  ctx: ProposalContext,
  p: ValidProposal,
): Promise<{ effect: ProposalEffect; relation: RelationRecord }> {
  const key = naturalKey(p.type, p.from, p.to);
  const existing = ctx.relations.get(key);
  const target = existing ?? { id: newId('relation'), type: p.type, fromRef: p.from, toRef: p.to };
  const current = endpointFingerprints(ctx.fps, target);
  const fromFp = current.from ?? null;
  const toFp = current.to ?? null;
  const history = existing ? (ctx.histories.get(existing.id) ?? []) : [];
  const basis = ctx.basisOf?.(p.from, p.to) ?? null;
  const procedure = ctx.declared?.procedure ?? null;

  const { effect, record } = classifyProposal(history, {
    principalId: ctx.actor.principalId,
    tier: p.tier,
    confidence: p.confidence,
    rationale: p.rationale,
    question: p.question,
    fromFp,
    toFp,
    ...(basis && procedure ? { basis: { ...basis, procedure } } : {}),
  });
  if (!record && existing) return { effect, relation: existing };

  const assertion = await prepareAssertion(ctx.tx, ctx.projectId, target, {
    kind: 'proposal',
    verdict: null,
    sourceKind: sourceKindOf(ctx.actor),
    principalId: ctx.actor.principalId,
    clientId: ctx.actor.clientId,
    declared: ctx.declared,
    submissionId: ctx.submissionId,
    tier: p.tier,
    confidence: p.confidence,
    rationale: p.rationale,
    evidence: p.evidence,
    question: p.question,
    label: null,
    linkedRelationId: null,
    fromFp,
    toFp,
    fromHash: basis?.fromHash ?? null,
    toHash: basis?.toHash ?? null,
  });
  const next = [...history, assertion];
  ctx.histories.set(target.id, next);

  let relation: RelationRecord;
  if (existing) {
    await ctx.tx.assertions.insert(assertion);
    ({ relation } = await refreshRelation(ctx.tx, ctx.projectId, existing, next, current, {
      touched: true,
      principalId: ctx.actor.principalId,
      clientId: ctx.actor.clientId,
    }));
  } else {
    relation = await ctx.tx.relations.insert({
      ...target,
      projectId: ctx.projectId,
      ...derivedState({ tier: p.tier }, next, current),
      version: 1,
      attrs: {},
    });
    await ctx.tx.assertions.insert(assertion);
  }
  ctx.relations.set(key, relation);
  return { effect, relation };
}

/**
 * Ends a principal's live proposal with a withdrawal recorded under that
 * principal (stances are per principal, CONCEPT §2).
 *
 * @param by who caused it (a superseding submission), if not the proposer
 */
export async function withdrawStance(
  ctx: ProposalContext,
  relation: RelationRecord,
  stance: Pick<AssertionRecord, 'principalId' | 'sourceKind' | 'clientId'>,
  rationale: string | null,
  by?: { principalId: Actor['principalId']; clientId: string | null },
): Promise<RelationRecord> {
  const current = endpointFingerprints(ctx.fps, relation);
  const history = ctx.histories.get(relation.id) ?? [];
  const withdrawal = await prepareAssertion(
    ctx.tx,
    ctx.projectId,
    relation,
    {
      kind: 'withdrawal',
      verdict: null,
      sourceKind: stance.sourceKind,
      principalId: stance.principalId,
      clientId: by ? by.clientId : stance.clientId,
      declared: null,
      submissionId: ctx.submissionId,
      tier: null,
      confidence: null,
      rationale,
      evidence: null,
      question: null,
      label: null,
      linkedRelationId: null,
      fromFp: current.from ?? null,
      toFp: current.to ?? null,
      fromHash: null,
      toHash: null,
    },
    by,
  );
  await ctx.tx.assertions.insert(withdrawal);
  const next = [...history, withdrawal];
  ctx.histories.set(relation.id, next);
  const { relation: stored } = await refreshRelation(
    ctx.tx,
    ctx.projectId,
    relation,
    next,
    current,
    {
      touched: true,
      principalId: by?.principalId ?? stance.principalId,
      clientId: by ? by.clientId : stance.clientId,
    },
  );
  ctx.relations.set(naturalKey(stored.type, stored.fromRef, stored.toRef), stored);
  return stored;
}
