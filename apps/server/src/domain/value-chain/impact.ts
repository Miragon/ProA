/**
 * The impact of a value chain save (M4 §3.5 `dryRun`, §4 "Save"): which step
 * generations a revision adds, tombstones and changes, and what that does to
 * their placements. The dry run shows it before the save, the save returns
 * the impact it computed under the project lock. Pure.
 */
import type { ImpactPlacementCounts, ValueChainImpact } from '@proa/contracts';

import type { PlacementRecord } from '../ports.ts';
import { currentStances, type StanceView } from '../status.ts';
import type { GenerationPlan } from './steps.ts';
import { OUTSIDE } from './steps.ts';
import type { ChainStructure } from './structure.ts';

const generationKey = (elementId: string, generation: number) => `${elementId}\u0000${generation}`;

function countsOf(placements: readonly Pick<PlacementRecord, 'status'>[]): ImpactPlacementCounts {
  const counts = { accepted: 0, held: 0, proposed: 0 };
  for (const p of placements) {
    if (p.status === 'accepted') counts.accepted++;
    else if (p.status === 'held') counts.held++;
    else if (p.status === 'proposed') counts.proposed++;
  }
  return counts;
}

/**
 * @param head the structure of the current head (`null`: the chain is
 *   created or revived, so no placement is on a live generation)
 * @param next the structure of the new revision
 * @param plan the generation plan of the save (`planStepGenerations`)
 * @param before the live generation of each element id before the save
 * @param placements every placement of the chain
 * @param histories the assertions of each placement, by placement id
 */
export function revisionImpact(
  head: ChainStructure | null,
  next: ChainStructure,
  plan: GenerationPlan,
  before: ReadonlyMap<string, number>,
  placements: readonly PlacementRecord[],
  histories: ReadonlyMap<string, readonly StanceView[]>,
): ValueChainImpact {
  const onGeneration = new Map<string, PlacementRecord[]>();
  for (const p of placements) {
    if (p.status === 'obsolete') continue;
    const key = generationKey(p.elementId, p.generation);
    onGeneration.set(key, [...(onGeneration.get(key) ?? []), p]);
  }
  const removedKeys = new Set(plan.removed.map((k) => generationKey(k.elementId, k.generation)));

  const added = plan.added
    .filter((k) => k.elementId !== OUTSIDE)
    .map((k) => ({ elementId: k.elementId, name: next.byId.get(k.elementId)?.name ?? '' }));

  let stranded = 0;
  let proposalsWithdrawn = 0;
  const removed = plan.removed
    .filter((k) => k.elementId !== OUTSIDE)
    .map((k) => {
      const on = onGeneration.get(generationKey(k.elementId, k.generation)) ?? [];
      return {
        elementId: k.elementId,
        generation: k.generation,
        name: head?.byId.get(k.elementId)?.name ?? '',
        placements: countsOf(on),
      };
    });
  for (const p of placements) {
    if (!removedKeys.has(generationKey(p.elementId, p.generation))) continue;
    if (p.status === 'accepted' || p.status === 'held') stranded++;
    proposalsWithdrawn += currentStances(histories.get(p.id) ?? []).filter(
      (a) => a.kind === 'proposal',
    ).length;
  }

  const changed: ValueChainImpact['steps']['changed'] = [];
  if (head) {
    for (const step of next.steps) {
      const generation = before.get(step.elementId);
      if (generation === undefined || plan.live.get(step.elementId) !== generation) continue;
      const old = head.byId.get(step.elementId);
      if (!old) continue;
      if (old.name === step.name && old.parentId === step.parentId && old.kind === step.kind)
        continue;
      changed.push({
        elementId: step.elementId,
        generation,
        before: { name: old.name, parentId: old.parentId, kind: old.kind },
        after: { name: step.name, parentId: step.parentId, kind: step.kind },
        fingerprintChanged: old.fingerprint !== step.fingerprint,
        placements: countsOf(onGeneration.get(generationKey(step.elementId, generation)) ?? []),
      });
    }
  }

  let toReconfirm = 0;
  for (const p of placements) {
    if (p.status !== 'accepted' || p.endpointState !== 'ok' || p.elementId === OUTSIDE) continue;
    // Without an anchor the endpoint state cannot turn `changed`.
    if (p.stepFp === null) continue;
    if (plan.live.get(p.elementId) !== p.generation) continue;
    const fingerprint = next.byId.get(p.elementId)?.fingerprint;
    if (fingerprint !== undefined && fingerprint !== p.stepFp) toReconfirm++;
  }

  return {
    structureChanged: head === null || head.structureHash !== next.structureHash,
    steps: { added, removed, changed },
    placements: { stranded, toReconfirm, proposalsWithdrawn },
  };
}

/** The impact of a save that writes nothing (`unchanged`). */
export function noImpact(): ValueChainImpact {
  return {
    structureChanged: false,
    steps: { added: [], removed: [], changed: [] },
    placements: { stranded: 0, toReconfirm: 0, proposalsWithdrawn: 0 },
  };
}
