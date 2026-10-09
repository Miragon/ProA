/** Value chain and placement records → API resources of `@proa/contracts` (REST and MCP). */
import type {
  EndpointState,
  Placement,
  PlacementAssertion,
  PlacementProvenance,
  PlacementSummary,
  StepPlacementCounts,
  ValueChain,
  ValueChainOrgUnit,
  ValueChainRevision,
  ValueChainStep,
} from '@proa/contracts';

import type {
  PlacementRecord,
  PlacementTier,
  StoredPlacementAssertion,
  StoredValueChainRevision,
  ValueChainRecord,
  ValueChainRevisionRecord,
} from '../ports.ts';
import { byPlacement, placementBasisOf, type PlacementEndpoints } from './placement-state.ts';
import { OUTSIDE } from './steps.ts';
import { linkTarget, type ChainStep, type ChainStructure } from './structure.ts';

const iso = (d: Date): string => d.toISOString();

export function toValueChain(chain: ValueChainRecord, head: ValueChainRevisionRecord): ValueChain {
  return {
    id: chain.id,
    key: chain.key,
    name: chain.name,
    headRevisionId: head.id,
    headRev: head.rev,
    contentHash: head.contentHash,
    structureHash: head.structureHash,
    schemaVersion: head.schemaVersion,
    updatedAt: iso(chain.updatedAt),
  };
}

export function toValueChainRevision(r: StoredValueChainRevision): ValueChainRevision {
  return {
    id: r.id,
    rev: r.rev,
    contentHash: r.contentHash,
    structureHash: r.structureHash,
    schemaVersion: r.schemaVersion,
    baseRevisionId: r.baseRevisionId,
    principalId: r.principalId,
    handle: r.handle,
    seq: r.seq,
    createdAt: iso(r.createdAt),
  };
}

/** Placements per step generation by status (non-obsolete ones). */
export function stepCounts(
  placements: readonly Pick<PlacementRecord, 'elementId' | 'generation' | 'status'>[],
): (elementId: string, generation: number) => StepPlacementCounts {
  const counts = new Map<string, StepPlacementCounts>();
  for (const p of placements) {
    const key = `${p.elementId}\u0000${p.generation}`;
    const c = counts.get(key) ?? { accepted: 0, proposed: 0, held: 0 };
    if (p.status === 'accepted') c.accepted++;
    else if (p.status === 'proposed') c.proposed++;
    else if (p.status === 'held') c.held++;
    counts.set(key, c);
  }
  return (elementId, generation) =>
    counts.get(`${elementId}\u0000${generation}`) ?? { accepted: 0, proposed: 0, held: 0 };
}

/** Everything {@link toStep} needs besides the step. */
export interface StepViewContext {
  structure: ChainStructure;
  live: ReadonlyMap<string, number>;
  /** Refs of the head's `process` facts (link resolution). */
  headProcesses: ReadonlySet<string>;
  counts: (elementId: string, generation: number) => StepPlacementCounts;
}

export function toStep(step: ChainStep, ctx: StepViewContext): ValueChainStep {
  const generation = ctx.live.get(step.elementId) ?? 1;
  const link = linkTarget(step.link, ctx.headProcesses);
  const orgNames = new Map(ctx.structure.orgUnits.map((o) => [o.elementId, o.name]));
  return {
    elementId: step.elementId,
    generation,
    name: step.name,
    kind: step.kind,
    depth: step.depth,
    rank: step.rank,
    parentId: step.parentId,
    path: step.path,
    childIds: step.childIds,
    link: step.link,
    linkKind: link.kind,
    linkProcess: link.process,
    linkResolved: link.resolved,
    owners: step.ownerIds.map((id) => ({ elementId: id, name: orgNames.get(id) ?? '' })),
    fingerprint: step.fingerprint,
    counts: ctx.counts(step.elementId, generation),
  };
}

export function toOrgUnits(structure: ChainStructure): ValueChainOrgUnit[] {
  return structure.orgUnits.map((o) => ({
    elementId: o.elementId,
    name: o.name,
    stepIds: o.stepIds,
  }));
}

function toProvenance(a: StoredPlacementAssertion): PlacementProvenance {
  return {
    assertionId: a.id,
    kind: a.kind,
    verdict: a.verdict,
    sourceKind: a.sourceKind,
    principalId: a.principalId,
    handle: a.handle,
    clientId: a.clientId,
    procedure: a.declared?.procedure ?? null,
    llmModel: a.declared?.llmModel ?? null,
    tier: a.tier,
    confidence: a.confidence,
    rationale: a.rationale,
    question: a.question,
    label: a.label,
    at: iso(a.createdAt),
  };
}

/** Endpoint state of one side: `missing` if not in the head, `changed` if not the anchor's. */
function sideState(anchor: string | null, current: string | undefined): EndpointState {
  if (current === undefined) return 'missing';
  return anchor === null || anchor === current ? 'ok' : 'changed';
}

/** Everything {@link toPlacement} needs besides the placement. */
export interface PlacementViewContext {
  structure: ChainStructure | null;
  live: ReadonlyMap<string, number>;
  endpoints: PlacementEndpoints;
  /** Process names (process name, else pool name) of the head processes, by ref. */
  processNames: ReadonlyMap<string, string | null>;
}

/**
 * @param history the placement's assertions (provenance and `source` come
 *   from the one its status rests on)
 */
export function toPlacement(
  p: PlacementRecord,
  history: readonly StoredPlacementAssertion[],
  ctx: PlacementViewContext,
): Placement {
  const basis = placementBasisOf(history);
  const stepLive = ctx.live.get(p.elementId) === p.generation;
  const currentStep = ctx.endpoints.step(p.elementId, p.generation);
  const currentProcess = ctx.endpoints.process(p.processRef);
  return {
    id: p.id,
    valueChainId: p.valueChainId,
    elementId: p.elementId,
    generation: p.generation,
    stepName:
      stepLive && p.elementId !== OUTSIDE
        ? (ctx.structure?.byId.get(p.elementId)?.name ?? null)
        : null,
    stepLive,
    process: p.processRef,
    processName: ctx.processNames.get(p.processRef) ?? null,
    status: p.status,
    endpointState: p.endpointState,
    endpoints: {
      step: sideState(p.stepFp, currentStep),
      process: sideState(p.processFp, currentProcess),
    },
    tier: p.tier,
    confidence: p.confidence,
    version: p.version,
    source: basis?.sourceKind ?? null,
    provenance: basis ? toProvenance(basis) : null,
    updatedAt: iso(p.updatedAt),
  };
}

/** Placement views with one query for their histories (handles included). */
export async function placementViews(
  listHistories: (ids: readonly PlacementRecord['id'][]) => Promise<StoredPlacementAssertion[]>,
  records: readonly PlacementRecord[],
  ctx: PlacementViewContext,
): Promise<Placement[]> {
  if (records.length === 0) return [];
  const histories = byPlacement(await listHistories(records.map((r) => r.id)));
  return records.map((r) => toPlacement(r, histories.get(r.id) ?? [], ctx));
}

/** A compact placement for the chain overview. */
export function toPlacementSummary(
  p: PlacementRecord,
  live: ReadonlyMap<string, number>,
  source: PlacementSummary['source'],
): PlacementSummary {
  return {
    id: p.id,
    elementId: p.elementId,
    generation: p.generation,
    stepLive: live.get(p.elementId) === p.generation,
    process: p.processRef,
    status: p.status,
    endpointState: p.endpointState,
    tier: p.tier,
    confidence: p.confidence,
    version: p.version,
    source,
  };
}

export function toPlacementAssertion(a: StoredPlacementAssertion): PlacementAssertion {
  return {
    id: a.id,
    seq: a.seq,
    kind: a.kind,
    verdict: a.verdict,
    sourceKind: a.sourceKind,
    principalId: a.principalId,
    handle: a.handle,
    clientId: a.clientId,
    procedure: a.declared?.procedure ?? null,
    llmModel: a.declared?.llmModel ?? null,
    submissionId: a.submissionId,
    tier: a.tier satisfies PlacementTier | null,
    confidence: a.confidence,
    rationale: a.rationale,
    evidence: a.evidence ?? [],
    question: a.question,
    label: a.label,
    linkedPlacementId: a.linkedPlacementId,
    stepFp: a.stepFp,
    processFp: a.processFp,
    at: iso(a.createdAt),
  };
}
