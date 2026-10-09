/**
 * Step generations of a value chain (M4 §2 "Identity"). The element id is a
 * step's identity, but the modeler can hand a deleted step's id to a new
 * step, so ProA keeps a generation per id: an id that leaves the head is
 * tombstoned, and if it comes back it is a new generation whose old
 * placements stay `missing`. Deleting the chain tombstones every generation,
 * so a re-created chain starts with new ones and revives no placements.
 * Generations track elements of type `step` only (org units are never
 * placement targets), plus the pseudo-step {@link OUTSIDE}.
 */
import type { ValueChainDocument } from '@miragon/value-chain-schema-model';

import { DomainError } from '../errors.ts';
import type { StepKey, ValueChainStepRecord } from '../ports.ts';

export type { StepKey };

/** The pseudo-step "deliberately outside this chain" (M4 §2). */
export const OUTSIDE = '@outside';

/** The step fingerprint of {@link OUTSIDE}: constant, never equal to a 12-hex fingerprint. */
export const OUTSIDE_FINGERPRINT = '@outside';

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The ids of the document's elements of type `step`, in code point order. */
export function stepIdsOf(document: Pick<ValueChainDocument, 'elements'>): string[] {
  return document.elements
    .filter((e) => e.elementType === 'step')
    .map((e) => e.id)
    .sort(byCodePoint);
}

/** The live generation of each element id (rows without a tombstone). */
export function liveGenerations(
  steps: readonly Pick<ValueChainStepRecord, 'elementId' | 'generation' | 'deletedSeq'>[],
): Map<string, number> {
  const live = new Map<string, number>();
  for (const s of steps) if (s.deletedSeq === null) live.set(s.elementId, s.generation);
  return live;
}

export type GenerationMode = 'create' | 'revise' | 'delete';

export interface GenerationPlan {
  /** New generations (one more than the id's highest, tombstones included). */
  added: StepKey[];
  /** Live generations to tombstone. */
  removed: StepKey[];
  /** The live generation of each element id afterwards. */
  live: Map<string, number>;
}

/**
 * The generations a revision adds and tombstones. `create` and `revise`: the
 * head's steps plus {@link OUTSIDE} are live afterwards; an id that is live
 * keeps its generation, a new or returning id gets the next one. `delete`:
 * every live generation is tombstoned. Both lists are in code point order.
 *
 * @param existing every generation of the chain, tombstones included
 * @param headStepIds the ids of the head's `step` elements
 * @throws {DomainError} `validation-failed` (`reserved-element-id`) for a
 *   step id starting with `@` (ProA's pseudo-steps; the ProA rules reject it
 *   first, M4 §2)
 */
export function planStepGenerations(
  existing: readonly Pick<ValueChainStepRecord, 'elementId' | 'generation' | 'deletedSeq'>[],
  headStepIds: Iterable<string>,
  mode: GenerationMode,
): GenerationPlan {
  const current = liveGenerations(existing);
  const highest = new Map<string, number>();
  for (const s of existing) {
    highest.set(s.elementId, Math.max(highest.get(s.elementId) ?? 0, s.generation));
  }
  const desired = new Set<string>();
  if (mode !== 'delete') {
    for (const id of headStepIds) {
      if (id.startsWith('@')) {
        throw new DomainError('validation-failed', `the element id ${id} is reserved`, {
          reason: 'reserved-element-id',
          elementId: id,
        });
      }
      desired.add(id);
    }
    desired.add(OUTSIDE);
  }
  const removed = [...current]
    .filter(([id]) => !desired.has(id))
    .map(([elementId, generation]) => ({ elementId, generation }))
    .sort((a, b) => byCodePoint(a.elementId, b.elementId));
  const added = [...desired]
    .filter((id) => !current.has(id))
    .map((elementId) => ({ elementId, generation: (highest.get(elementId) ?? 0) + 1 }))
    .sort((a, b) => byCodePoint(a.elementId, b.elementId));
  const next = new Map(added.map((a) => [a.elementId, a.generation]));
  const live = new Map<string, number>();
  for (const id of [...desired].sort(byCodePoint)) {
    const generation = current.get(id) ?? next.get(id);
    if (generation !== undefined) live.set(id, generation);
  }
  return { added, removed, live };
}
