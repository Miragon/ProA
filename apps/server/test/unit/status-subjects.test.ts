/**
 * `status.ts` generalised over a subject (M4 S1): relations behave exactly as
 * before (a golden digest computed on the code before the generalisation),
 * and placements follow the same lifecycle (relation histories mapped to
 * placement form give the same results).
 */
import { createHash } from 'node:crypto';

import type { Tier } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import type { PlacementTier } from '../../src/domain/ports.ts';
import {
  classifyProposal,
  currentStances,
  decisionsInForce,
  endpointState,
  recomputeStatus,
  type NewProposal,
} from '../../src/domain/status.ts';
import {
  classifyPlacementProposal,
  placementEndpointState,
  placementEndpoints,
  recomputePlacementStatus,
  type ClassifiedPlacementAssertion,
  type NewPlacementProposal,
} from '../../src/domain/value-chain/placement-state.ts';
import {
  OUTSIDE,
  OUTSIDE_FINGERPRINT,
  liveGenerations,
} from '../../src/domain/value-chain/steps.ts';
import { CASES, relationCase, type RelationCaseAssertion } from '../support/status-histories.ts';

/**
 * sha256 of the relation results over {@link CASES} random cases, computed on
 * `status.ts` before M4 S1 (commit be4308f). A change means relation
 * behaviour changed: find out why before touching this constant.
 */
const GOLDEN_RELATION_DIGEST = 'c27767daf1908f3016364b65e015a6c6543b1d792b8fc6c439c5541f50d2e5b4';

function relationResults() {
  const out: unknown[] = [];
  for (let i = 0; i < CASES; i++) {
    const c = relationCase(i);
    const state = recomputeStatus(c.history);
    const held = [...c.history, c.hold];
    out.push({
      state,
      stances: currentStances(c.history).map((a) => a.seq),
      decisions: decisionsInForce(c.history).map((a) => a.seq),
      heldState: recomputeStatus(held),
      classify: c.proposals.map((p) => classifyProposal(c.history, p)),
      classifyHeld: c.proposals.map((p) => classifyProposal(held, p)),
      endpoint: c.currents.map((current) => endpointState(state.anchor, current)),
      endpointNoAnchor: c.currents.map((current) => endpointState(null, current)),
    });
  }
  return out;
}

describe('relations keep their behaviour (golden digest)', () => {
  it('reproduces the digest computed before the generalisation', () => {
    const json = JSON.stringify(relationResults());
    const digest = createHash('sha256').update(json).digest('hex');
    expect(digest).toBe(GOLDEN_RELATION_DIGEST);
  });

  it('covers every status and every classify effect', () => {
    const results = relationResults() as {
      state: { status: string };
      classify: { effect: string }[];
      classifyHeld: { effect: string }[];
    }[];
    const statuses = new Set(results.map((r) => r.state.status));
    const effects = new Set(
      results.flatMap((r) => [...r.classify, ...r.classifyHeld].map((x) => x.effect)),
    );
    expect([...statuses].sort()).toEqual(['accepted', 'held', 'obsolete', 'proposed', 'rejected']);
    expect([...effects].sort()).toEqual(['applied', 'duplicate', 'reopened', 'suppressed']);
  });
});

/** The relation's from-end becomes the step, its to-end the process. */
function asPlacement(a: RelationCaseAssertion): ClassifiedPlacementAssertion {
  return {
    seq: a.seq,
    kind: a.kind,
    verdict: a.verdict,
    sourceKind: a.sourceKind,
    principalId: a.principalId,
    tier: a.tier,
    confidence: a.confidence,
    stepFp: a.fromFp,
    processFp: a.toFp,
    rationale: a.rationale,
    question: a.question,
    submissionId: a.submissionId,
    stepHash: a.fromHash,
    processHash: a.toHash,
    declared: a.declared,
  };
}

function placementTier(tier: Tier): PlacementTier {
  if (tier === 'rule') throw new Error('proposals never carry the rule tier');
  return tier;
}

function asPlacementProposal(p: NewProposal): NewPlacementProposal {
  return {
    principalId: p.principalId,
    tier: placementTier(p.tier),
    confidence: p.confidence,
    rationale: p.rationale,
    question: p.question,
    stepFp: p.fromFp,
    processFp: p.toFp,
    ...(p.basis
      ? {
          basis: {
            stepHash: p.basis.fromHash,
            processHash: p.basis.toHash,
            procedure: p.basis.procedure,
          },
        }
      : {}),
  };
}

describe('placements follow the relation lifecycle (equivalence)', () => {
  it('gives the same status, tier, confidence and basis with the anchor mapped', () => {
    for (let i = 0; i < CASES; i++) {
      const c = relationCase(i);
      for (const history of [c.history, [...c.history, c.hold]]) {
        const relation = recomputeStatus(history);
        const placement = recomputePlacementStatus(history.map(asPlacement));
        expect(placement, `case ${i}`).toEqual({
          ...relation,
          anchor: relation.anchor
            ? { stepFp: relation.anchor.fromFp, processFp: relation.anchor.toFp }
            : null,
        });
      }
    }
  });

  it('classifies proposals the same way (effect and record)', () => {
    for (let i = 0; i < CASES; i++) {
      const c = relationCase(i);
      for (const history of [c.history, [...c.history, c.hold]]) {
        const mapped = history.map(asPlacement);
        for (const p of c.proposals) {
          expect(classifyPlacementProposal(mapped, asPlacementProposal(p)), `case ${i}`).toEqual(
            classifyProposal(history, p),
          );
        }
      }
    }
  });

  it('keeps returning the input objects (decisionsInForce relies on identity)', () => {
    for (let i = 0; i < 200; i++) {
      const mapped = relationCase(i).history.map(asPlacement);
      for (const a of [...currentStances(mapped), ...decisionsInForce(mapped)]) {
        expect(mapped).toContain(a);
      }
    }
  });
});

describe('placementEndpointState', () => {
  const anchor = { stepFp: 's1', processFp: 'p1' };

  it.each([
    [{ step: 's1', process: 'p1' }, 'ok'],
    [{ step: 's2', process: 'p1' }, 'changed'],
    [{ step: 's1', process: 'p2' }, 'changed'],
    [{ step: undefined, process: 'p1' }, 'missing'],
    [{ step: 's1', process: undefined }, 'missing'],
  ] as const)('%o → %s', (current, state) => {
    expect(placementEndpointState(anchor, current)).toBe(state);
  });

  it('is ok without an anchor while both ends exist', () => {
    expect(placementEndpointState(null, { step: 's1', process: 'p1' })).toBe('ok');
    expect(placementEndpointState(null, { step: undefined, process: 'p1' })).toBe('missing');
  });

  const steps = [
    { elementId: OUTSIDE, generation: 1, deletedSeq: 9 },
    { elementId: OUTSIDE, generation: 2, deletedSeq: null },
    { elementId: 'step-a', generation: 1, deletedSeq: 7 },
    { elementId: 'step-a', generation: 2, deletedSeq: null },
    { elementId: 'step-b', generation: 1, deletedSeq: 7 },
  ];
  const endpoints = placementEndpoints(
    liveGenerations(steps),
    new Map([
      ['step-a', 'fa'],
      ['step-b', 'fb'],
    ]),
    new Map([['m/x#P', 'px']]),
  );

  it('gives @outside its constant fingerprint in its live generation', () => {
    expect(endpoints.step(OUTSIDE, 2)).toBe(OUTSIDE_FINGERPRINT);
    expect(endpoints.step(OUTSIDE, 1)).toBeUndefined();
    expect(OUTSIDE_FINGERPRINT).not.toMatch(/^[0-9a-f]{12}$/);
  });

  it('treats a tombstoned generation as missing, even when its id is live again', () => {
    expect(endpoints.step('step-a', 2)).toBe('fa');
    expect(endpoints.step('step-a', 1)).toBeUndefined();
    expect(endpoints.step('step-b', 1)).toBeUndefined();
    expect(
      placementEndpointState(
        { stepFp: 'fa', processFp: 'px' },
        { step: endpoints.step('step-a', 1), process: endpoints.process('m/x#P') },
      ),
    ).toBe('missing');
    expect(endpoints.process('m/y#Q')).toBeUndefined();
  });
});

describe('endpointState stays the pair function for relations', () => {
  it('agrees with placementEndpointState on every combination', () => {
    const values = ['a', 'b', undefined] as const;
    const anchors = [null, { fromFp: 'a', toFp: 'b' }, { fromFp: null, toFp: 'a' }];
    for (const anchor of anchors) {
      for (const from of values) {
        for (const to of values) {
          expect(endpointState(anchor, { from, to })).toBe(
            placementEndpointState(
              anchor ? { stepFp: anchor.fromFp, processFp: anchor.toFp } : null,
              { step: from, process: to },
            ),
          );
        }
      }
    }
  });
});
