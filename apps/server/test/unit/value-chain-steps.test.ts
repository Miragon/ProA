/**
 * Step generations (M4 §2 "Identity", M4 S1): ids are identity, a returning
 * id is a new generation, `@outside` lives with the chain, and only elements
 * of type `step` count. Synthetic documents only.
 */
import { createEmptyDocument, loadDocument } from '@miragon/value-chain-schema-model';
import { describe, expect, it } from 'vitest';

import { DomainError } from '../../src/domain/errors.ts';
import type { StepKey } from '../../src/domain/ports.ts';
import {
  OUTSIDE,
  liveGenerations,
  planStepGenerations,
  stepIdsOf,
} from '../../src/domain/value-chain/steps.ts';

interface Row extends StepKey {
  createdRev: number;
  deletedRev: number | null;
  deletedSeq: number | null;
}

/** Applies a plan like the store does: tombstone the removed rows, insert the added ones. */
function apply(rows: Row[], plan: { added: StepKey[]; removed: StepKey[] }, rev: number | null) {
  const removed = new Set(plan.removed.map((k) => `${k.elementId}#${k.generation}`));
  const next = rows.map((r) =>
    removed.has(`${r.elementId}#${r.generation}`) && r.deletedSeq === null
      ? { ...r, deletedRev: rev, deletedSeq: 100 + (rev ?? 99) }
      : r,
  );
  for (const k of plan.added) {
    next.push({ ...k, createdRev: rev ?? 0, deletedRev: null, deletedSeq: null });
  }
  return next;
}

const doc = (steps: string[], orgUnits: string[] = []) =>
  loadDocument({
    schemaVersion: 1,
    meta: { name: 'Synthetic chain' },
    elements: [
      ...steps.map((id, i) => ({
        id,
        elementType: 'step',
        name: `Step ${id}`,
        bounds: { x: i * 200, y: 0, width: 160, height: 60 },
      })),
      ...orgUnits.map((id, i) => ({
        id,
        elementType: 'orgUnit',
        name: `Unit ${id}`,
        bounds: { x: i * 200, y: 200, width: 130, height: 60 },
      })),
    ],
    connections: [],
  });

describe('stepIdsOf', () => {
  it('takes the step elements only, in code point order', () => {
    expect(stepIdsOf(doc(['b', 'a', 'Z'], ['unit-1']))).toEqual(['Z', 'a', 'b']);
    expect(stepIdsOf(createEmptyDocument('Leer'))).toEqual([]);
  });
});

describe('planStepGenerations', () => {
  it('gives the first revision generation 1 for every step plus @outside', () => {
    const plan = planStepGenerations([], ['b', 'a'], 'create');
    expect(plan.added).toEqual([
      { elementId: OUTSIDE, generation: 1 },
      { elementId: 'a', generation: 1 },
      { elementId: 'b', generation: 1 },
    ]);
    expect(plan.removed).toEqual([]);
    expect([...plan.live]).toEqual([
      [OUTSIDE, 1],
      ['a', 1],
      ['b', 1],
    ]);
  });

  it('tombstones a removed step and gives a returning id the next generation', () => {
    let rows = apply([], planStepGenerations([], ['a', 'b'], 'create'), 1);
    const rev2 = planStepGenerations(rows, ['a', 'c'], 'revise');
    expect(rev2.removed).toEqual([{ elementId: 'b', generation: 1 }]);
    expect(rev2.added).toEqual([{ elementId: 'c', generation: 1 }]);
    rows = apply(rows, rev2, 2);
    const rev3 = planStepGenerations(rows, ['a', 'b', 'c'], 'revise');
    expect(rev3.added).toEqual([{ elementId: 'b', generation: 2 }]);
    expect(rev3.removed).toEqual([]);
    expect(rev3.live.get('b')).toBe(2);
    expect(rev3.live.get('a')).toBe(1);
    rows = apply(rows, rev3, 3);
    expect(liveGenerations(rows)).toEqual(rev3.live);
  });

  it('keeps every live generation when nothing changes', () => {
    const rows = apply([], planStepGenerations([], ['a'], 'create'), 1);
    expect(planStepGenerations(rows, ['a'], 'revise')).toEqual({
      added: [],
      removed: [],
      live: new Map([
        [OUTSIDE, 1],
        ['a', 1],
      ]),
    });
  });

  it('ignores org units: their ids never get a generation', () => {
    const plan = planStepGenerations([], stepIdsOf(doc(['a'], ['unit-1'])), 'create');
    expect(plan.added.map((k) => k.elementId)).toEqual([OUTSIDE, 'a']);
  });

  it('tombstones everything on delete, @outside included', () => {
    const rows = apply([], planStepGenerations([], ['a', 'b'], 'create'), 1);
    const plan = planStepGenerations(rows, ['a', 'b'], 'delete');
    expect(plan.removed).toEqual([
      { elementId: OUTSIDE, generation: 1 },
      { elementId: 'a', generation: 1 },
      { elementId: 'b', generation: 1 },
    ]);
    expect(plan.added).toEqual([]);
    expect(plan.live.size).toBe(0);
  });

  it('gives a revived chain new generations, @outside included', () => {
    let rows = apply([], planStepGenerations([], ['a'], 'create'), 1);
    rows = apply(rows, planStepGenerations(rows, [], 'delete'), null);
    const revived = planStepGenerations(rows, ['a', 'b'], 'create');
    expect(revived.added).toEqual([
      { elementId: OUTSIDE, generation: 2 },
      { elementId: 'a', generation: 2 },
      { elementId: 'b', generation: 1 },
    ]);
    expect(revived.removed).toEqual([]);
  });

  it('rejects element ids starting with @ (reserved for pseudo-steps)', () => {
    for (const id of ['@outside', '@x']) {
      let error: unknown;
      try {
        planStepGenerations([], ['a', id], 'revise');
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({
        code: 'validation-failed',
        extras: { reason: 'reserved-element-id', elementId: id },
      });
    }
    // On delete the head is not read.
    expect(() => planStepGenerations([], ['@x'], 'delete')).not.toThrow();
  });

  it('is deterministic: the order of the input does not matter', () => {
    const rows = apply([], planStepGenerations([], ['c', 'a', 'b', 'ä', 'B'], 'create'), 1);
    const a = planStepGenerations(rows, ['d', 'B', 'a'], 'revise');
    const b = planStepGenerations([...rows].reverse(), ['a', 'B', 'd', 'a'], 'revise');
    expect(a).toEqual(b);
    expect(a.removed.map((k) => k.elementId)).toEqual(['b', 'c', 'ä']);
    expect([...a.live.keys()]).toEqual([OUTSIDE, 'B', 'a', 'd']);
  });
});
