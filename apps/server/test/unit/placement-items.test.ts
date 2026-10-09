/**
 * Placement items (M4 S2, reused by S5's submissions): every invalid reason
 * in check order, `@outside`, the evidence forms, the live-step limit and
 * the server-computed tier. Synthetic chains only.
 */
import type { PLACEMENT_INVALID_REASONS } from '@proa/contracts';
import { MAX_EVIDENCE_ITEMS, type SourceKind } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { prepareRevision } from '../../src/domain/value-chain/document.ts';
import {
  stepGenerationKey,
  validatePlacementItem,
  type PlacementItemContext,
  type PlacementItemDraft,
} from '../../src/domain/value-chain/items.ts';
import { OUTSIDE } from '../../src/domain/value-chain/steps.ts';
import { chain } from '../support/value-chain.ts';

const PROCESS = 'vertrieb/auftrag#P_Auftrag';
const structure = prepareRevision(
  chain({
    steps: [
      { id: 'step-a', name: 'Auftrag' },
      { id: 'step-b', name: 'Versand' },
      { id: 'step-c', name: 'Rechnung' },
      { id: 'step-d', name: 'Mahnung' },
      { id: 'step-e', name: 'Service' },
    ],
  }),
).structure;

function context(extra: Partial<PlacementItemContext> = {}): PlacementItemContext {
  return {
    structure,
    live: new Map([
      [OUTSIDE, 1],
      ['step-a', 1],
      ['step-b', 2],
      ['step-c', 1],
      ['step-d', 1],
      ['step-e', 1],
    ]),
    processes: new Set([PROCESS, 'lager/versand#P_Versand']),
    factRefs: new Set([PROCESS, 'vertrieb/auftrag#Start_Auftrag']),
    relationIds: new Set(['rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3']),
    sourceKind: 'agent',
    liveProposalSteps: () => new Set(),
    lexical: (_process, step) => step === 'step-a',
    ...extra,
  };
}

const item = (extra: Partial<PlacementItemDraft> = {}): PlacementItemDraft => ({
  step: 'step-a',
  process: PROCESS,
  confidence: 0.8,
  rationale: 'Nimmt Aufträge an.',
  evidence: [PROCESS],
  question: null,
  ...extra,
});

const reason = (draft: PlacementItemDraft, ctx = context()) => {
  const v = validatePlacementItem(draft, ctx);
  return v.ok ? 'ok' : v.reason;
};

describe('validatePlacementItem', () => {
  it('accepts a valid item with the live generation and the server-computed tier', () => {
    expect(validatePlacementItem(item({ step: 'step-b', question: '' }), context())).toEqual({
      ok: true,
      value: {
        elementId: 'step-b',
        generation: 2,
        processRef: PROCESS,
        tier: 'semantic',
        confidence: 0.8,
        rationale: 'Nimmt Aufträge an.',
        evidence: [PROCESS],
        question: null,
      },
    });
  });

  it.each<[string, Partial<PlacementItemDraft>, (typeof PLACEMENT_INVALID_REASONS)[number]]>([
    ['an empty step', { step: '' }, 'malformed-step'],
    ['a step id over 128 characters', { step: 's'.repeat(129) }, 'malformed-step'],
    ['a control character in the step', { step: 'step\u0000a' }, 'malformed-step'],
    ['a process that is no ref', { process: 'Auftrag' }, 'malformed-ref'],
    ['confidence above 1', { confidence: 1.01 }, 'confidence-out-of-range'],
    ['confidence NaN', { confidence: Number.NaN }, 'confidence-out-of-range'],
    ['a long rationale', { rationale: 'x'.repeat(1001) }, 'rationale-too-long'],
    ['a long question', { question: 'x'.repeat(501) }, 'question-too-long'],
    [
      'too much evidence',
      { evidence: Array.from({ length: MAX_EVIDENCE_ITEMS + 1 }, () => PROCESS) },
      'too-much-evidence',
    ],
    ['a control character in the rationale', { rationale: 'a\u0007b' }, 'control-characters'],
    ['a control character in the evidence', { evidence: ['a\u0000'] }, 'control-characters'],
    ['@outside without a reason', { step: OUTSIDE, rationale: '  ' }, 'rationale-required'],
    ['a step of no live generation', { step: 'step-x' }, 'unknown-step'],
    [
      'a process that is no head process',
      { process: 'vertrieb/auftrag#Start_Auftrag' },
      'unknown-process',
    ],
    ['an unknown fact ref as evidence', { evidence: ['vertrieb/weg#X'] }, 'unknown-evidence'],
    [
      'an unknown relation as evidence',
      { evidence: ['rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y4'] },
      'unknown-evidence',
    ],
    ['an unknown step as evidence', { evidence: ['step:step-x'] }, 'unknown-evidence'],
    ['@outside as step evidence', { evidence: [`step:${OUTSIDE}`] }, 'unknown-evidence'],
  ])('%s', (_what, draft, expected) => {
    expect(reason(item(draft))).toBe(expected);
  });

  it('checks in the order of PLACEMENT_INVALID_REASONS: the first failing check wins', () => {
    expect(reason(item({ step: '', process: 'x', confidence: 2 }))).toBe('malformed-step');
    expect(reason(item({ process: 'x', confidence: 2 }))).toBe('malformed-ref');
    expect(reason(item({ step: OUTSIDE, rationale: '', process: 'vertrieb/weg#P' }))).toBe(
      'rationale-required',
    );
    expect(reason(item({ step: 'step-x', process: 'vertrieb/weg#P' }))).toBe('unknown-step');
    expect(reason(item({ process: 'vertrieb/weg#P', evidence: ['nope'] }))).toBe('unknown-process');
  });

  it('accepts the evidence forms: fact refs, relation ids of the project, step:<live step>', () => {
    expect(
      reason(
        item({
          evidence: [
            'vertrieb/auftrag#Start_Auftrag',
            'rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
            'step:step-b',
          ],
        }),
      ),
    ).toBe('ok');
  });

  it('allows tab and line breaks in free text', () => {
    expect(reason(item({ rationale: 'Zeile 1\nZeile 2\tEnde', question: 'Warum?\r\n' }))).toBe(
      'ok',
    );
  });

  it('limits live steps per process and proposer to 3 other generations, except for the rule tier', () => {
    const three = new Set(
      ['step-b', 'step-c', 'step-d'].map((s) => stepGenerationKey(s, s === 'step-b' ? 2 : 1)),
    );
    const crowded = context({ liveProposalSteps: () => three });
    expect(reason(item({ step: 'step-e' }), crowded)).toBe('too-many-steps');
    // The target itself does not count: a repeat on one of the three is fine.
    expect(reason(item({ step: 'step-c' }), crowded)).toBe('ok');
    expect(reason(item({ step: OUTSIDE, rationale: 'Archiv' }), crowded)).toBe('too-many-steps');
    const rules = context({ liveProposalSteps: () => three, sourceKind: 'rule' });
    expect(reason(item({ step: 'step-e' }), rules)).toBe('ok');
  });

  it.each<[SourceKind, string, string]>([
    ['agent', 'step-a', 'lexical'],
    ['agent', 'step-c', 'semantic'],
    ['agent', OUTSIDE, 'semantic'],
    ['human', 'step-a', 'manual'],
    ['rule', 'step-a', 'key'],
  ])('tier for %s on %s: %s', (sourceKind, step, tier) => {
    const v = validatePlacementItem(
      item({ step, rationale: 'Grund' }),
      context({ sourceKind, lexical: () => step === 'step-a' }),
    );
    expect(v.ok && v.value.tier).toBe(tier);
  });

  it('never asks the lexical matcher about @outside', () => {
    const v = validatePlacementItem(
      item({ step: OUTSIDE, rationale: 'Archiv' }),
      context({ lexical: () => true }),
    );
    expect(v.ok && v.value.tier).toBe('semantic');
  });
});
