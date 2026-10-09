/**
 * The impact of a value chain save (M4 S2): added, removed and changed
 * steps, and what happens to their placements (stranded, to re-confirm,
 * proposals withdrawn). Synthetic chains and placement records.
 */
import { STEP_KIND_COLORS, type PlacementId, type Ref } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import type { PlacementRecord } from '../../src/domain/ports.ts';
import type { StanceView } from '../../src/domain/status.ts';
import { prepareRevision } from '../../src/domain/value-chain/document.ts';
import { noImpact, revisionImpact } from '../../src/domain/value-chain/impact.ts';
import { OUTSIDE, planStepGenerations } from '../../src/domain/value-chain/steps.ts';
import { chain, type StepSpec } from '../support/value-chain.ts';

const P = 'prj_01J9Z3N4X5Q6R7S8T9V0W1X2Y3' as const;
const CHAIN = 'vch_01J9Z3N4X5Q6R7S8T9V0W1X2Y3' as const;
const AGENT = 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2YA' as const;
const RULES = 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2YB' as const;
const HUMAN = 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2YC' as const;

const structureOf = (steps: StepSpec[]) => prepareRevision(chain({ steps })).structure;

let n = 0;
function placement(
  elementId: string,
  status: PlacementRecord['status'],
  extra: Partial<PlacementRecord> = {},
): PlacementRecord {
  n++;
  return {
    id: `plc_01J9Z3N4X5Q6R7S8T9V0W1X${String(n).padStart(3, '0')}` as PlacementId,
    projectId: P,
    valueChainId: CHAIN,
    elementId,
    generation: 1,
    processRef: `m/p${n}#P${n}` as Ref,
    status,
    endpointState: 'ok',
    tier: 'semantic',
    confidence: 0.8,
    version: 1,
    stepFp: null,
    processFp: 'fp',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  };
}

const stance = (
  seq: number,
  kind: StanceView['kind'],
  principalId: StanceView['principalId'],
  sourceKind: StanceView['sourceKind'] = 'agent',
): StanceView => ({
  seq,
  kind,
  verdict: kind === 'decision' ? 'accept' : null,
  sourceKind,
  principalId,
  tier: kind === 'proposal' ? 'semantic' : null,
  confidence: null,
});

describe('revisionImpact', () => {
  const head = structureOf([
    { id: 'a', name: 'Auftrag' },
    { id: 'b', name: 'Versand' },
    { id: 'c', name: 'Rechnungswesen', color: STEP_KIND_COLORS.support, y: 300 },
  ]);
  const next = structureOf([
    { id: 'a', name: 'Auftragseingang' },
    { id: 'c', name: 'Rechnungswesen', color: STEP_KIND_COLORS.management, y: 300 },
    { id: 'd', name: 'Kundenservice' },
  ]);
  const existing = [OUTSIDE, 'a', 'b', 'c'].map((elementId) => ({
    elementId,
    generation: 1,
    deletedSeq: null,
  }));
  const before = new Map(existing.map((s) => [s.elementId, 1]));
  const plan = planStepGenerations(existing, next.stepFingerprints.keys(), 'revise');
  const fpA = head.byId.get('a')?.fingerprint ?? null;
  const fpC = head.byId.get('c')?.fingerprint ?? null;

  const accepted = placement('b', 'accepted');
  const held = placement('b', 'held');
  const proposed = placement('b', 'proposed');
  const obsolete = placement('b', 'obsolete');
  const renamed = placement('a', 'accepted', { stepFp: fpA });
  const alreadyChanged = placement('a', 'accepted', { stepFp: 'older', endpointState: 'changed' });
  const recoloured = placement('c', 'accepted', { stepFp: fpC });
  const outside = placement(OUTSIDE, 'accepted', { stepFp: '@outside' });
  const placements = [
    accepted,
    held,
    proposed,
    obsolete,
    renamed,
    alreadyChanged,
    recoloured,
    outside,
  ];
  const histories = new Map<string, StanceView[]>([
    [accepted.id, [stance(1, 'decision', HUMAN, 'human')]],
    [held.id, [stance(2, 'proposal', AGENT), stance(3, 'decision', HUMAN, 'human')]],
    [proposed.id, [stance(4, 'proposal', AGENT), stance(5, 'proposal', RULES, 'rule')]],
    [obsolete.id, [stance(6, 'proposal', AGENT), stance(7, 'withdrawal', AGENT)]],
  ]);

  const impact = revisionImpact(head, next, plan, before, placements, histories);

  it('lists added and removed steps with the placements on them', () => {
    expect(impact.structureChanged).toBe(true);
    expect(impact.steps.added).toEqual([{ elementId: 'd', name: 'Kundenservice' }]);
    expect(impact.steps.removed).toEqual([
      {
        elementId: 'b',
        generation: 1,
        name: 'Versand',
        placements: { accepted: 1, held: 1, proposed: 1 },
      },
    ]);
  });

  it('strands accepted and held placements of removed steps and counts the proposals withdrawn there', () => {
    expect(impact.placements).toEqual({ stranded: 2, toReconfirm: 1, proposalsWithdrawn: 3 });
  });

  it('lists renames (fingerprint changed) and kind-only changes (fingerprint kept)', () => {
    expect(impact.steps.changed).toEqual([
      {
        elementId: 'a',
        generation: 1,
        before: { name: 'Auftrag', parentId: null, kind: 'other' },
        after: { name: 'Auftragseingang', parentId: null, kind: 'other' },
        fingerprintChanged: true,
        placements: { accepted: 2, held: 0, proposed: 0 },
      },
      {
        elementId: 'c',
        generation: 1,
        before: { name: 'Rechnungswesen', parentId: null, kind: 'support' },
        after: { name: 'Rechnungswesen', parentId: null, kind: 'management' },
        fingerprintChanged: false,
        placements: { accepted: 1, held: 0, proposed: 0 },
      },
    ]);
  });

  it('sees only additions on create and revival, and nothing for an unchanged save', () => {
    const create = revisionImpact(
      null,
      next,
      planStepGenerations([], next.stepFingerprints.keys(), 'create'),
      new Map(),
      [],
      new Map(),
    );
    expect(create).toEqual({
      structureChanged: true,
      steps: {
        added: [
          { elementId: 'a', name: 'Auftragseingang' },
          { elementId: 'c', name: 'Rechnungswesen' },
          { elementId: 'd', name: 'Kundenservice' },
        ],
        removed: [],
        changed: [],
      },
      placements: { stranded: 0, toReconfirm: 0, proposalsWithdrawn: 0 },
    });
    expect(noImpact()).toEqual({
      structureChanged: false,
      steps: { added: [], removed: [], changed: [] },
      placements: { stranded: 0, toReconfirm: 0, proposalsWithdrawn: 0 },
    });
  });

  it('reports a layout-only save as no structure change', () => {
    const moved = structureOf([
      { id: 'a', name: 'Auftrag', x: 50 },
      { id: 'b', name: 'Versand', x: 500 },
      { id: 'c', name: 'Rechnungswesen', color: STEP_KIND_COLORS.support, y: 900 },
    ]);
    const same = planStepGenerations(existing, moved.stepFingerprints.keys(), 'revise');
    const layout = revisionImpact(head, moved, same, before, placements, histories);
    expect(layout).toEqual(noImpact());
  });
});
