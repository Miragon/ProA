/**
 * Placement state (M4 §2): the relation lifecycle applied to "process P
 * belongs to step S". Status, tier and basis come from the generic functions
 * of `status.ts` with the step and process fingerprints as the anchor;
 * endpoint state compares that anchor with the head (the step's live
 * generation in the chain, the process in the head facts). Shared writes:
 * recording an assertion with its event, refreshing a placement's derived
 * state from its history.
 */
import {
  newId,
  type DeclaredProcedure,
  type EndpointState,
  type Fact,
  type PlacementId,
  type PrincipalId,
  type ProjectId,
  type Tier,
  type ValueChainId,
} from '@proa/contracts';

import type {
  AssertionKind,
  PlacementAssertionRecord,
  PlacementRecord,
  PlacementTier,
  Tx,
} from '../ports.ts';
import {
  classifyProposalOf,
  pairEndpointState,
  recomputeStatusOf,
  sameProcedure,
  type ProposalEffect,
  type StanceView,
  type Subject,
  type SubjectState,
} from '../status.ts';
import { OUTSIDE, OUTSIDE_FINGERPRINT } from './steps.ts';

/** The anchor of a placement: the fingerprints of its step and its process. */
export interface PlacementFingerprints {
  stepFp: string | null;
  processFp: string | null;
}

/** The fields of a placement assertion that status computation looks at. */
export type PlacementAssertionView = StanceView & PlacementFingerprints;

export type PlacementState = SubjectState<PlacementFingerprints>;

/** The placement subject: the step is side A, the process side B. */
export const PLACEMENT: Subject<PlacementAssertionView, PlacementFingerprints> = {
  anchor: (a) => ({ stepFp: a.stepFp, processFp: a.processFp }),
  sameAnchor: (x, y) => x.stepFp === y.stepFp && x.processFp === y.processFp,
  proposalView: (p) => ({
    seq: p.seq,
    kind: 'proposal',
    verdict: null,
    sourceKind: 'agent',
    principalId: p.principalId,
    tier: p.tier,
    confidence: p.confidence,
    stepFp: p.anchor.stepFp,
    processFp: p.anchor.processFp,
  }),
};

/** `recomputeStatus` (CONCEPT §2) of a placement. */
export function recomputePlacementStatus(
  history: readonly PlacementAssertionView[],
): PlacementState {
  return recomputeStatusOf(PLACEMENT, history);
}

/**
 * The basis of a pipeline placement proposal (M4b): the chain's
 * `structure_hash` and the `facts_hash` of the process's model as the agent
 * saw them, and the declared procedure.
 */
export interface PlacementBasis {
  stepHash: string;
  processHash: string;
  procedure: DeclaredProcedure;
}

export interface NewPlacementProposal extends PlacementFingerprints {
  principalId: PrincipalId;
  tier: PlacementTier;
  confidence: number;
  rationale: string;
  question: string | null;
  /** Absent for ad-hoc proposals. */
  basis?: PlacementBasis;
}

/** What `classifyPlacementProposal` reads of an assertion. */
export interface ClassifiedPlacementAssertion extends StanceView, PlacementFingerprints {
  rationale: string | null;
  question: string | null;
  submissionId?: string | null;
  stepHash?: string | null;
  processHash?: string | null;
  declared?: { procedure: DeclaredProcedure | null } | null;
}

function samePlacementBasis(own: ClassifiedPlacementAssertion, basis: PlacementBasis): boolean {
  return (
    (own.submissionId ?? null) !== null &&
    own.stepHash === basis.stepHash &&
    own.processHash === basis.processHash &&
    sameProcedure(own.declared?.procedure, basis.procedure)
  );
}

/**
 * What a new proposal does to a placement (`classifyProposalOf`):
 * `suppressed` under a human decision with the same fingerprints (except a
 * pipeline proposal under a hold), `duplicate` of the proposer's own live
 * proposal, `reopened` when the step or process changed since a rejection,
 * else `applied`.
 */
export function classifyPlacementProposal(
  history: readonly ClassifiedPlacementAssertion[],
  proposal: NewPlacementProposal,
): { effect: ProposalEffect; record: boolean } {
  return classifyProposalOf(PLACEMENT, samePlacementBasis, history, {
    principalId: proposal.principalId,
    tier: proposal.tier,
    confidence: proposal.confidence,
    rationale: proposal.rationale,
    question: proposal.question,
    anchor: { stepFp: proposal.stepFp, processFp: proposal.processFp },
    ...(proposal.basis === undefined ? {} : { basis: proposal.basis }),
  });
}

/**
 * Endpoint state of a placement: `missing` if its step generation is not
 * live in the chain or its process is not in the head facts, `changed` if a
 * fingerprint differs from the anchor, else `ok`.
 *
 * @param current head fingerprints (`undefined`: not in the head)
 */
export function placementEndpointState(
  anchor: PlacementFingerprints | null,
  current: { step: string | undefined; process: string | undefined },
): EndpointState {
  return pairEndpointState(anchor ? [anchor.stepFp, anchor.processFp] : null, [
    current.step,
    current.process,
  ]);
}

/** `chain\0element\0generation\0process`: the natural key of a placement within a project. */
export function placementKey(
  valueChainId: ValueChainId,
  elementId: string,
  generation: number,
  processRef: string,
): string {
  return `${valueChainId}\u0000${elementId}\u0000${generation}\u0000${processRef}`;
}

/** Groups placement assertions by placement, keeping their order. */
export function byPlacement<T extends { placementId: PlacementId }>(
  rows: readonly T[],
): Map<PlacementId, T[]> {
  const out = new Map<PlacementId, T[]>();
  for (const a of rows) {
    const list = out.get(a.placementId) ?? [];
    list.push(a);
    out.set(a.placementId, list);
  }
  return out;
}

/** Head fingerprints of both ends of placements. */
export interface PlacementEndpoints {
  /** Fingerprint of the step generation if it is live in the chain, else `undefined`. */
  step(elementId: string, generation: number): string | undefined;
  /** Fingerprint of the process (`<model_key>#<process_id>`) in the head facts, else `undefined`. */
  process(ref: string): string | undefined;
}

/** Fingerprints of the head's `process` facts by ref (`tx.facts.head(…, {kinds: ['process']})`). */
export function processFingerprints(
  headFacts: readonly Pick<Fact, 'kind' | 'ref' | 'fingerprint'>[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of headFacts) if (f.kind === 'process') out.set(f.ref, f.fingerprint);
  return out;
}

/**
 * The step side of {@link PlacementEndpoints}: a step is present only in its
 * live generation; {@link OUTSIDE} has the constant fingerprint.
 *
 * @param live the live generation of each element id
 * @param fingerprints step fingerprints of the head, by element id
 */
export function stepEndpoints(
  live: ReadonlyMap<string, number>,
  fingerprints: ReadonlyMap<string, string>,
): PlacementEndpoints['step'] {
  return (elementId, generation) => {
    if (live.get(elementId) !== generation) return undefined;
    return elementId === OUTSIDE ? OUTSIDE_FINGERPRINT : fingerprints.get(elementId);
  };
}

/** Endpoints from the live generations, the head's step fingerprints and the process fingerprints. */
export function placementEndpoints(
  live: ReadonlyMap<string, number>,
  stepFingerprints: ReadonlyMap<string, string>,
  processFps: ReadonlyMap<string, string>,
): PlacementEndpoints {
  return { step: stepEndpoints(live, stepFingerprints), process: (ref) => processFps.get(ref) };
}

/** Head fingerprints of one placement's step and process. */
export function endpointsOf(
  endpoints: PlacementEndpoints,
  p: Pick<PlacementRecord, 'elementId' | 'generation' | 'processRef'>,
): { step: string | undefined; process: string | undefined } {
  return {
    step: endpoints.step(p.elementId, p.generation),
    process: endpoints.process(p.processRef),
  };
}

export type PlacementAssertionInput = Omit<
  PlacementAssertionRecord,
  'id' | 'projectId' | 'placementId' | 'seq'
>;

const EVENT_TYPE: Readonly<Record<AssertionKind, string>> = {
  proposal: 'placement.proposed',
  withdrawal: 'placement.withdrawn',
  decision: 'placement.decided',
  note: 'placement.noted',
};

type PlacementSubjectRef = Pick<
  PlacementRecord,
  'id' | 'valueChainId' | 'elementId' | 'generation' | 'processRef'
>;

/**
 * Appends the event of a new placement assertion (which allocates its `seq`)
 * and returns the record; the caller inserts it once the placement row exists.
 *
 * @param by who caused it, if not the assertion's principal
 */
export async function preparePlacementAssertion(
  tx: Tx,
  projectId: ProjectId,
  placement: PlacementSubjectRef,
  input: PlacementAssertionInput,
  by?: { principalId: PrincipalId; clientId: string | null },
): Promise<PlacementAssertionRecord> {
  const seq = await tx.events.append(projectId, {
    type: EVENT_TYPE[input.kind],
    principalId: by?.principalId ?? input.principalId,
    clientId: by ? by.clientId : input.clientId,
    subjectRef: placement.id,
    payload: {
      placementId: placement.id,
      valueChainId: placement.valueChainId,
      elementId: placement.elementId,
      generation: placement.generation,
      process: placement.processRef,
      sourceKind: input.sourceKind,
      ...(by ? { principalId: input.principalId } : {}),
      ...(input.verdict ? { verdict: input.verdict } : {}),
      ...(input.tier ? { tier: input.tier, confidence: input.confidence } : {}),
      ...(input.submissionId ? { submissionId: input.submissionId } : {}),
      ...(input.linkedPlacementId ? { linkedPlacementId: input.linkedPlacementId } : {}),
    },
  });
  return {
    ...input,
    id: newId('placementAssertion'),
    projectId,
    placementId: placement.id,
    seq,
  };
}

/** Placements never carry the `rule` tier; the stored one stays if the history has none. */
function placementTierOf(tier: Tier | null, fallback: PlacementTier): PlacementTier {
  return tier === null || tier === 'rule' ? fallback : tier;
}

/** The derived columns of a placement, from its history and the head fingerprints of its ends. */
export function derivedPlacementState(
  placement: Pick<PlacementRecord, 'tier'>,
  history: readonly PlacementAssertionView[],
  current: { step: string | undefined; process: string | undefined },
) {
  const state = recomputePlacementStatus(history);
  return {
    status: state.status,
    endpointState: placementEndpointState(state.anchor, current),
    tier: placementTierOf(state.tier, placement.tier),
    confidence: state.confidence,
    stepFp: state.anchor?.stepFp ?? null,
    processFp: state.anchor?.processFp ?? null,
  };
}

/**
 * Writes a placement's derived state if it changed, or always with `touched`
 * (a new assertion: the version moves, so a bulk decision based on the old
 * state fails). Records `placement.endpoint_changed` when the endpoint state
 * of a non-obsolete placement changes.
 *
 * @returns the stored placement (the unchanged record if nothing was written)
 */
export async function refreshPlacement(
  tx: Tx,
  projectId: ProjectId,
  placement: PlacementRecord,
  history: readonly PlacementAssertionView[],
  current: { step: string | undefined; process: string | undefined },
  options: { touched: boolean; principalId: PrincipalId; clientId: string | null },
): Promise<{ placement: PlacementRecord; endpointChanged: boolean }> {
  const patch = derivedPlacementState(placement, history, current);
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
    (k) => patch[k] !== placement[k],
  );
  if (!changed && !options.touched) return { placement, endpointChanged: false };
  const stored = await tx.placements.update(projectId, placement.id, patch);
  const endpointChanged =
    patch.endpointState !== placement.endpointState && patch.status !== 'obsolete';
  if (endpointChanged) {
    await tx.events.append(projectId, {
      type: 'placement.endpoint_changed',
      principalId: options.principalId,
      clientId: options.clientId,
      subjectRef: placement.id,
      payload: {
        placementId: placement.id,
        valueChainId: placement.valueChainId,
        elementId: placement.elementId,
        generation: placement.generation,
        process: placement.processRef,
        previous: placement.endpointState,
        endpointState: patch.endpointState,
      },
    });
  }
  return { placement: stored, endpointChanged };
}

/**
 * Recomputes the derived state of every placement of a chain against the
 * given endpoints (after a revision, a chain deletion, and in S2 after model
 * ingest and deletion). Writes only placements whose state changed.
 */
export async function refreshPlacements(
  tx: Tx,
  projectId: ProjectId,
  valueChainId: ValueChainId,
  endpoints: PlacementEndpoints,
  by: { principalId: PrincipalId; clientId: string | null },
): Promise<{ written: number; endpointChanges: number }> {
  const placements = await tx.placements.forChain(projectId, valueChainId);
  if (placements.length === 0) return { written: 0, endpointChanges: 0 };
  const histories = byPlacement(await tx.placementAssertions.listForChain(projectId, valueChainId));
  let written = 0;
  let endpointChanges = 0;
  for (const p of placements) {
    const { placement, endpointChanged } = await refreshPlacement(
      tx,
      projectId,
      p,
      histories.get(p.id) ?? [],
      endpointsOf(endpoints, p),
      { touched: false, ...by },
    );
    if (placement !== p) written++;
    if (endpointChanged) endpointChanges++;
  }
  return { written, endpointChanges };
}

/** The assertion a placement's status rests on (see `recomputeStatusOf`). */
export function placementBasisOf<T extends PlacementAssertionView>(
  history: readonly T[],
): T | null {
  const { basisSeq } = recomputePlacementStatus(history);
  return history.find((a) => a.seq === basisSeq) ?? null;
}
