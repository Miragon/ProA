/**
 * The placement lifecycle (M4 §2, §3): proposals by agents (and the rule
 * tier's key proposals, S2, recorded under `proa-rules` with
 * {@link PlacementContext.proposer}), their withdrawal (also of every live
 * proposal on step generations a revision or the chain's deletion
 * tombstones), and human decisions (accept, reject, hold, correct), manual
 * placements and notes, all written inside the caller's transaction, which
 * holds `tx.projects.lockForWrite`. The validation of agent items (process in
 * the head facts, limits, evidence; `items.ts`) and the tier matchers
 * (`tiers.ts`) run before; these functions take validated input but refuse a
 * step generation that is not live and an `@outside` proposal without a reason.
 * The rule tier accepts nothing; an owner's auto-accept rule may accept an
 * agent proposal afterwards (`auto-accept/`, owner decision 19), recorded as a
 * human decision of the rule's author.
 */
import {
  newId,
  type PlacementId,
  type PrincipalId,
  type ProjectId,
  type Ref,
  type SourceKind,
  type SubmissionId,
  type ValueChainId,
} from '@proa/contracts';

import { sourceKindOf, type Actor } from '../actor.ts';
import { DomainError } from '../errors.ts';
import type {
  Declared,
  PlacementAssertionRecord,
  PlacementRecord,
  PlacementTier,
  StepKey,
  Tx,
} from '../ports.ts';
import { currentStances, type ProposalEffect } from '../status.ts';
import {
  PLACEMENT,
  byPlacement,
  classifyPlacementProposal,
  derivedPlacementState,
  endpointsOf,
  placementBasisOf,
  placementKey,
  preparePlacementAssertion,
  refreshPlacement,
  type PlacementEndpoints,
} from './placement-state.ts';
import { OUTSIDE } from './steps.ts';

/**
 * The server-computed tier of a placement assertion (M4 §2 "Tiers"), never
 * sent by clients: `key` for the rule tier, `manual` for humans; for agents
 * `lexical` when the step matches the process lexically (among the top 3 of
 * `baseline-prefix/1`, or a shared name stem, which an equal `name_norm`
 * is), else `semantic`, and always `semantic` for `@outside`. A step whose
 * `link` names the process yields the rule tier's key proposal; it does not
 * make an agent's proposal `lexical`. `tiers.ts` supplies the matcher.
 */
export function placementTier(x: {
  sourceKind: SourceKind;
  toOutside: boolean;
  lexicalMatch: boolean;
}): PlacementTier {
  if (x.sourceKind === 'rule') return 'key';
  if (x.sourceKind === 'human') return 'manual';
  if (x.toOutside) return 'semantic';
  return x.lexicalMatch ? 'lexical' : 'semantic';
}

/** The chain state a batch of placement proposals works on, kept current as it writes. */
export interface PlacementContext {
  tx: Tx;
  projectId: ProjectId;
  actor: Actor;
  valueChainId: ValueChainId;
  endpoints: PlacementEndpoints;
  /** Placements by {@link placementKey}. */
  placements: Map<string, PlacementRecord>;
  /** Assertions per placement id, in seq order. */
  histories: Map<PlacementId, PlacementAssertionRecord[]>;
  declared: Declared | null;
  /** The stored submission (M4b pipeline), `null` for ad-hoc proposals. */
  submissionId: SubmissionId | null;
  /** Pipeline proposals (M4b): the basis the claim showed for a process. */
  basisOf?: (processRef: Ref) => { stepHash: string; processHash: string };
  /**
   * Whom proposals are recorded under. Omitted: the actor, with the source
   * kind derived from it (`human` or `agent`). The rule tier's key proposals
   * (S2) name the system principal `proa-rules`: `source_kind = 'rule'`, no
   * client, so supersession and token revocation, which end agent proposals,
   * never touch them.
   */
  proposer?: { sourceKind: 'rule'; principalId: PrincipalId };
  /**
   * Whom the `placement.endpoint_changed` events of this context's writes
   * name. Omitted: the writer (the proposer, or who caused a withdrawal). The
   * rule tier's run inside a chain save names the saving human: the save moved
   * the endpoint, as in S1's refresh after a revision.
   */
  endpointCause?: { principalId: PrincipalId; clientId: string | null };
}

/** The principal, source kind and client a context's proposals are recorded with. */
function proposerOf(ctx: PlacementContext): {
  sourceKind: SourceKind;
  principalId: PrincipalId;
  clientId: string | null;
} {
  if (ctx.proposer) return { ...ctx.proposer, clientId: null };
  return {
    sourceKind: sourceKindOf(ctx.actor),
    principalId: ctx.actor.principalId,
    clientId: ctx.actor.clientId,
  };
}

/**
 * A placement proposal that passed S2's validation: the step is live in the
 * head (or `@outside`), the process is a head `process` fact, at most 3 live
 * steps per process and principal, limits and evidence checked, a rationale
 * for `@outside`; the tier is server-computed ({@link placementTier}), `key`
 * exactly for the rule tier.
 */
export interface ValidPlacementProposal {
  elementId: string;
  generation: number;
  processRef: Ref;
  tier: PlacementTier;
  confidence: number;
  rationale: string;
  evidence: string[];
  question: string | null;
}

type PlacementTarget = Pick<
  PlacementRecord,
  'id' | 'valueChainId' | 'elementId' | 'generation' | 'processRef'
>;

/**
 * Classifies a valid proposal and records it if it adds something
 * (`classifyPlacementProposal`): creates the placement when new, appends the
 * proposal assertion with its event, and refreshes the derived state. The
 * proposal is recorded under {@link PlacementContext.proposer}, else the actor.
 *
 * @throws {DomainError} `validation-failed` with `rationale-required` for
 *   `@outside` without a reason (M4 §2), `unknown-step` for a step generation
 *   that is not live (a tombstone is final, so such a proposal could never be
 *   decided)
 */
export async function applyPlacementProposal(
  ctx: PlacementContext,
  p: ValidPlacementProposal,
): Promise<{
  effect: ProposalEffect;
  placement: PlacementRecord;
  /** The recorded proposal, `null` when nothing was recorded (the auto-accept step evaluates it). */
  assertion: PlacementAssertionRecord | null;
}> {
  const source = proposerOf(ctx);
  if ((source.sourceKind === 'rule') !== (p.tier === 'key')) {
    throw new Error(
      `a ${p.tier} proposal cannot be recorded with source kind ${source.sourceKind}`,
    );
  }
  if (p.elementId === OUTSIDE) requireText(p.rationale, 'a reason for @outside');
  const key = placementKey(ctx.valueChainId, p.elementId, p.generation, p.processRef);
  const existing = ctx.placements.get(key);
  const target: PlacementTarget = existing ?? {
    id: newId('placement'),
    valueChainId: ctx.valueChainId,
    elementId: p.elementId,
    generation: p.generation,
    processRef: p.processRef,
  };
  const current = endpointsOf(ctx.endpoints, target);
  if (current.step === undefined) throw unknownStep(target);
  const stepFp = current.step;
  const processFp = current.process ?? null;
  const history = existing ? (ctx.histories.get(existing.id) ?? []) : [];
  const basis = ctx.basisOf?.(p.processRef) ?? null;
  const procedure = ctx.declared?.procedure ?? null;

  const { effect, record } = classifyPlacementProposal(history, {
    principalId: source.principalId,
    tier: p.tier,
    confidence: p.confidence,
    rationale: p.rationale,
    question: p.question,
    stepFp,
    processFp,
    ...(basis && procedure ? { basis: { ...basis, procedure } } : {}),
  });
  if (!record && existing) return { effect, placement: existing, assertion: null };

  const assertion = await preparePlacementAssertion(ctx.tx, ctx.projectId, target, {
    kind: 'proposal',
    verdict: null,
    sourceKind: source.sourceKind,
    principalId: source.principalId,
    clientId: source.clientId,
    declared: ctx.declared,
    submissionId: ctx.submissionId,
    tier: p.tier,
    confidence: p.confidence,
    rationale: p.rationale,
    evidence: p.evidence,
    question: p.question,
    label: null,
    linkedPlacementId: null,
    stepFp,
    processFp,
    stepHash: basis?.stepHash ?? null,
    processHash: basis?.processHash ?? null,
  });
  const next = [...history, assertion];
  ctx.histories.set(target.id, next);

  let placement: PlacementRecord;
  if (existing) {
    await ctx.tx.placementAssertions.insert(assertion);
    ({ placement } = await refreshPlacement(ctx.tx, ctx.projectId, existing, next, current, {
      touched: true,
      ...(ctx.endpointCause ?? { principalId: source.principalId, clientId: source.clientId }),
    }));
  } else {
    placement = await ctx.tx.placements.insert({
      ...target,
      projectId: ctx.projectId,
      ...derivedPlacementState({ tier: p.tier }, next, current),
      version: 1,
    });
    await ctx.tx.placementAssertions.insert(assertion);
  }
  ctx.placements.set(key, placement);
  return { effect, placement, assertion };
}

type Stance = Pick<PlacementAssertionRecord, 'principalId' | 'sourceKind' | 'clientId'>;
type Cause = { principalId: Actor['principalId']; clientId: string | null };

/** Records the withdrawal of a stance (assertion and event) without refreshing the placement. */
async function recordWithdrawal(
  ctx: PlacementContext,
  placement: PlacementRecord,
  stance: Stance,
  rationale: string | null,
  by: Cause | undefined,
): Promise<PlacementAssertionRecord[]> {
  const current = endpointsOf(ctx.endpoints, placement);
  const withdrawal = await preparePlacementAssertion(
    ctx.tx,
    ctx.projectId,
    placement,
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
      linkedPlacementId: null,
      stepFp: current.step ?? null,
      processFp: current.process ?? null,
      stepHash: null,
      processHash: null,
    },
    by,
  );
  await ctx.tx.placementAssertions.insert(withdrawal);
  const next = [...(ctx.histories.get(placement.id) ?? []), withdrawal];
  ctx.histories.set(placement.id, next);
  return next;
}

/** Writes a placement's derived state after new assertions (its version moves once). */
async function refreshAfterWithdrawal(
  ctx: PlacementContext,
  placement: PlacementRecord,
  history: readonly PlacementAssertionRecord[],
  cause: Cause,
): Promise<PlacementRecord> {
  const { placement: stored } = await refreshPlacement(
    ctx.tx,
    ctx.projectId,
    placement,
    history,
    endpointsOf(ctx.endpoints, placement),
    { touched: true, ...cause },
  );
  ctx.placements.set(
    placementKey(stored.valueChainId, stored.elementId, stored.generation, stored.processRef),
    stored,
  );
  return stored;
}

/**
 * Ends a principal's live proposal with a withdrawal recorded under that
 * principal (stances are per principal, CONCEPT §2).
 *
 * @param by who caused it (a superseding submission, a token revocation), if not the proposer
 */
export async function withdrawPlacementStance(
  ctx: PlacementContext,
  placement: PlacementRecord,
  stance: Stance,
  rationale: string | null,
  by?: Cause,
): Promise<PlacementRecord> {
  const history = await recordWithdrawal(ctx, placement, stance, rationale, by);
  return refreshAfterWithdrawal(
    ctx,
    placement,
    history,
    by ?? ctx.endpointCause ?? { principalId: stance.principalId, clientId: stance.clientId },
  );
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Natural key order (element id, generation, process ref), so events come in a stable order. */
function byNaturalKey(a: PlacementRecord, b: PlacementRecord): number {
  return (
    byCodePoint(a.elementId, b.elementId) ||
    a.generation - b.generation ||
    byCodePoint(a.processRef, b.processRef)
  );
}

/**
 * Withdraws every live proposal on step generations that a revision or the
 * chain's deletion has just tombstoned (M4 §2). A tombstone is final, so such
 * a proposal could never be decided usefully; left live, it would keep its
 * process out of `list_unplaced_processes`, count toward the live steps per
 * process and principal and stay in the inbox for good. Each withdrawal is
 * recorded under its proposer (agent, rule tier or human), `by` the saving
 * human, as supersession does. Decisions stay: an accepted or held placement
 * on a removed step remains an open item, a placement with proposals only
 * turns `obsolete`.
 *
 * @param endpoints the endpoints after the tombstones
 * @param removed the generations just tombstoned
 * @param reason the withdrawals' rationale
 * @returns the number of withdrawals
 */
export async function withdrawProposalsOnRemovedSteps(
  tx: Tx,
  projectId: ProjectId,
  actor: Actor,
  valueChainId: ValueChainId,
  endpoints: PlacementEndpoints,
  removed: readonly StepKey[],
  reason: string,
): Promise<number> {
  if (removed.length === 0) return 0;
  const gone = new Set(removed.map((k) => `${k.elementId}\u0000${k.generation}`));
  const affected = (await tx.placements.forChain(projectId, valueChainId))
    .filter((p) => gone.has(`${p.elementId}\u0000${p.generation}`))
    .sort(byNaturalKey);
  if (affected.length === 0) return 0;
  const ctx: PlacementContext = {
    tx,
    projectId,
    actor,
    valueChainId,
    endpoints,
    placements: new Map(
      affected.map((p) => [placementKey(valueChainId, p.elementId, p.generation, p.processRef), p]),
    ),
    histories: byPlacement(
      await tx.placementAssertions.listForPlacements(
        projectId,
        affected.map((p) => p.id),
      ),
    ),
    declared: null,
    submissionId: null,
  };
  const by: Cause = { principalId: actor.principalId, clientId: actor.clientId };
  let withdrawn = 0;
  for (const placement of affected) {
    const live = currentStances(ctx.histories.get(placement.id) ?? []).filter(
      (a) => a.kind === 'proposal',
    );
    if (live.length === 0) continue;
    let history: PlacementAssertionRecord[] = [];
    for (const stance of live) {
      history = await recordWithdrawal(ctx, placement, stance, reason, by);
    }
    // One refresh after all of them: no `endpoint_changed` for a placement that turns obsolete.
    await refreshAfterWithdrawal(ctx, placement, history, by);
    withdrawn += live.length;
  }
  return withdrawn;
}

/** A human decision on a placement. */
export interface PlacementDecision {
  verdict: 'accept' | 'reject' | 'hold';
  /** Accept note, rejection reason (required) or hold note (required). */
  rationale: string | null;
  /** The question of a hold. */
  question: string | null;
  /** The label of a hold. */
  label: string | null;
  /** `correct`: the manual placement accepted instead, or the corrected placement. */
  linkedPlacementId: PlacementId | null;
  /** `manual` for a manual placement's acceptance; decisions carry no tier otherwise. */
  tier: 'manual' | null;
  confidence: number | null;
}

/** Humans decide (M4 §7); the DB checks back this up. */
function requireHuman(actor: Actor): void {
  if (sourceKindOf(actor) !== 'human') {
    throw new DomainError('human-decision-required', 'only a human decides placements');
  }
}

function requireText(text: string | null, what: string): void {
  if (text === null || text.trim() === '') {
    throw new DomainError('validation-failed', `${what} is required`, {
      reason: 'rationale-required',
    });
  }
}

/** `validation-failed` (`unknown-step`): the step generation is not live in the chain. */
function unknownStep(p: StepKey, hint = ''): DomainError {
  return new DomainError(
    'validation-failed',
    `${p.elementId} (generation ${p.generation}) is not a step of the head${hint}`,
    { reason: 'unknown-step' },
  );
}

/** Records a human decision without the checks of {@link recordPlacementDecision}. */
async function writeDecision(
  tx: Tx,
  projectId: ProjectId,
  actor: Actor,
  placement: PlacementRecord,
  history: readonly PlacementAssertionRecord[],
  endpoints: PlacementEndpoints,
  d: PlacementDecision,
): Promise<PlacementRecord> {
  const current = endpointsOf(endpoints, placement);
  const assertion = await preparePlacementAssertion(tx, projectId, placement, {
    kind: 'decision',
    verdict: d.verdict,
    sourceKind: sourceKindOf(actor),
    principalId: actor.principalId,
    clientId: actor.clientId,
    declared: null,
    submissionId: null,
    tier: d.tier,
    confidence: d.confidence,
    rationale: d.rationale,
    evidence: null,
    question: d.question,
    label: d.label,
    linkedPlacementId: d.linkedPlacementId,
    stepFp: current.step ?? null,
    processFp: current.process ?? null,
    stepHash: null,
    processHash: null,
  });
  await tx.placementAssertions.insert(assertion);
  const { placement: stored } = await refreshPlacement(
    tx,
    projectId,
    placement,
    [...history, assertion],
    current,
    { touched: true, principalId: actor.principalId, clientId: actor.clientId },
  );
  return stored;
}

/**
 * A human decision (accept, reject with a reason, hold with a note),
 * anchored on the current step and process fingerprints: accepting a
 * `changed` placement re-confirms it. A placement whose step generation is
 * tombstoned can only be rejected or corrected ({@link correctPlacement}):
 * the tombstone is final, so an acceptance or hold there would stay
 * `missing` for good.
 *
 * @param history the placement's assertions
 * @throws {DomainError} `human-decision-required` for agents; `conflict` for
 *   an obsolete placement; `validation-failed` with `rationale-required` for a
 *   rejection or hold without text, `unknown-step` for an acceptance or hold
 *   on a step generation that is not live
 */
export async function recordPlacementDecision(
  tx: Tx,
  projectId: ProjectId,
  actor: Actor,
  placement: PlacementRecord,
  history: readonly PlacementAssertionRecord[],
  endpoints: PlacementEndpoints,
  d: PlacementDecision,
): Promise<PlacementRecord> {
  requireHuman(actor);
  if (placement.status === 'obsolete') {
    throw new DomainError('conflict', 'an obsolete placement cannot be decided');
  }
  if (d.verdict === 'reject') requireText(d.rationale, 'a rejection reason');
  if (d.verdict === 'hold') requireText(d.rationale, 'a hold note');
  if (
    d.verdict !== 'reject' &&
    endpoints.step(placement.elementId, placement.generation) === undefined
  ) {
    throw unknownStep(placement, '; correct the placement onto a live step, or reject it');
  }
  return writeDecision(tx, projectId, actor, placement, history, endpoints, d);
}

/**
 * A manual placement (M4 §4 "Add process"): the human-accepted placement of
 * `processRef` on the step generation (created if new), tier `manual`,
 * linked to `linked`. Both ends must be in the head. A placement the same
 * human-based acceptance already covers with these fingerprints is not
 * recorded again.
 *
 * @throws {DomainError} `human-decision-required` for agents;
 *   `validation-failed` with `rationale-required`, `unknown-step` or
 *   `unknown-process`
 */
export async function acceptManualPlacement(
  tx: Tx,
  projectId: ProjectId,
  actor: Actor,
  valueChainId: ValueChainId,
  endpoints: PlacementEndpoints,
  item: {
    elementId: string;
    generation: number;
    processRef: Ref;
    rationale: string;
    confidence: number | null;
  },
  linked: PlacementId | null,
): Promise<{ placement: PlacementRecord; recorded: boolean }> {
  requireHuman(actor);
  requireText(item.rationale, 'a rationale');
  const current = endpointsOf(endpoints, item);
  if (current.step === undefined) throw unknownStep(item);
  if (current.process === undefined) {
    throw new DomainError('validation-failed', `${item.processRef} is not a head process`, {
      reason: 'unknown-process',
    });
  }
  const anchor = { stepFp: current.step, processFp: current.process };
  const existing = await tx.placements.findByNaturalKey(
    projectId,
    valueChainId,
    item.elementId,
    item.generation,
    item.processRef,
  );
  const history = existing
    ? await tx.placementAssertions.listForPlacements(projectId, [existing.id])
    : [];
  const basis = placementBasisOf(history);
  // An auto-accept rule's acceptance (owner decision 19) is no human review: the
  // human's manual placement is recorded and confirms it.
  if (
    existing &&
    existing.status === 'accepted' &&
    basis?.sourceKind === 'human' &&
    (basis.autoAcceptRuleId ?? null) === null &&
    PLACEMENT.sameAnchor(PLACEMENT.anchor(basis), anchor)
  ) {
    return { placement: existing, recorded: false };
  }
  const fields: PlacementDecision = {
    verdict: 'accept',
    rationale: item.rationale,
    question: null,
    label: null,
    linkedPlacementId: linked,
    tier: 'manual',
    confidence: item.confidence,
  };
  if (existing) {
    return {
      placement: await writeDecision(tx, projectId, actor, existing, history, endpoints, fields),
      recorded: true,
    };
  }
  const target: PlacementTarget = {
    id: newId('placement'),
    valueChainId,
    elementId: item.elementId,
    generation: item.generation,
    processRef: item.processRef,
  };
  const assertion = await preparePlacementAssertion(tx, projectId, target, {
    kind: 'decision',
    verdict: 'accept',
    sourceKind: sourceKindOf(actor),
    principalId: actor.principalId,
    clientId: actor.clientId,
    declared: null,
    submissionId: null,
    tier: 'manual',
    confidence: item.confidence,
    rationale: item.rationale,
    evidence: null,
    question: null,
    label: null,
    linkedPlacementId: linked,
    stepFp: anchor.stepFp,
    processFp: anchor.processFp,
    stepHash: null,
    processHash: null,
  });
  const placement = await tx.placements.insert({
    ...target,
    projectId,
    ...derivedPlacementState({ tier: 'manual' }, [assertion], current),
    version: 1,
  });
  await tx.placementAssertions.insert(assertion);
  return { placement, recorded: true };
}

/**
 * `correct` (M4 §4): accepts the placement's process on another step as a
 * manual placement linked to this one, then rejects this one, linked to the
 * manual placement.
 *
 * @param target the step generation the process belongs to instead
 * @throws {DomainError} as {@link recordPlacementDecision} and
 *   {@link acceptManualPlacement}; `validation-failed` (`same-step`) for the
 *   placement's own step
 */
export async function correctPlacement(
  tx: Tx,
  projectId: ProjectId,
  actor: Actor,
  placement: PlacementRecord,
  history: readonly PlacementAssertionRecord[],
  endpoints: PlacementEndpoints,
  target: { elementId: string; generation: number },
  note: string,
): Promise<{ placement: PlacementRecord; corrected: PlacementRecord }> {
  requireHuman(actor);
  if (placement.status === 'obsolete') {
    throw new DomainError('conflict', 'an obsolete placement cannot be decided');
  }
  if (target.elementId === placement.elementId && target.generation === placement.generation) {
    throw new DomainError('validation-failed', 'a correction names another step', {
      reason: 'same-step',
    });
  }
  const manual = await acceptManualPlacement(
    tx,
    projectId,
    actor,
    placement.valueChainId,
    endpoints,
    { ...target, processRef: placement.processRef, rationale: note, confidence: null },
    placement.id,
  );
  const rejected = await writeDecision(tx, projectId, actor, placement, history, endpoints, {
    verdict: 'reject',
    rationale: note,
    question: null,
    label: null,
    linkedPlacementId: manual.placement.id,
    tier: null,
    confidence: null,
  });
  return { placement: rejected, corrected: manual.placement };
}

/**
 * A human note, e.g. the answer to a held question, anchored on the
 * placement's current fingerprints. It never changes the status, and, as for
 * relations, neither the version.
 *
 * @throws {DomainError} `human-decision-required` for agents; `validation-failed` without text
 */
export async function addPlacementNote(
  tx: Tx,
  projectId: ProjectId,
  actor: Actor,
  placement: PlacementRecord,
  text: string,
): Promise<PlacementAssertionRecord> {
  requireHuman(actor);
  requireText(text, 'a note');
  const note = await preparePlacementAssertion(tx, projectId, placement, {
    kind: 'note',
    verdict: null,
    sourceKind: sourceKindOf(actor),
    principalId: actor.principalId,
    clientId: actor.clientId,
    declared: null,
    submissionId: null,
    tier: null,
    confidence: null,
    rationale: text,
    evidence: null,
    question: null,
    label: null,
    linkedPlacementId: null,
    stepFp: placement.stepFp,
    processFp: placement.processFp,
    stepHash: null,
    processHash: null,
  });
  await tx.placementAssertions.insert(note);
  return note;
}
