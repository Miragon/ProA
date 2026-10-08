import {
  MAX_QUESTION_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_SUBMISSION_NO_LINKS,
  MAX_SUBMISSION_RELATIONS,
  MAX_SUMMARY_CHARS,
  SubmitAnalysisBody,
  type ClaimCandidate,
  type ClaimInput,
} from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, SIM_POLICY, decide, normalizeLabel } from '../../src/policy.ts';
import {
  BILLING,
  CANCEL,
  ORDERS,
  PAYMENT,
  RETURN,
  STOCK_COUNT,
  STOCK_LOW,
  claimInput,
} from '../support/fixtures.ts';

const key = (r: { from: string; to: string }) => `${r.from} -> ${r.to}`;

describe('decide (sim-policy-1)', () => {
  const d = decide(claimInput());

  it('gives every distinct candidate one verdict', () => {
    expect(d.judgements.map((j) => [key(j), j.verdict])).toEqual([
      [`${ORDERS.callBilling} -> ${BILLING.process}`, 'skip-accepted'],
      [`${ORDERS.shipped} -> ${BILLING.shipped}`, 'propose'],
      [`${ORDERS.done} -> ${BILLING.done}`, 'propose'],
      [`${PAYMENT} -> ${ORDERS.paid}`, 'skip-rejected'],
      [`${CANCEL} -> ${ORDERS.cancelled}`, 'propose'],
      [`${RETURN} -> ${ORDERS.returned}`, 'skip-held'],
      [`${ORDERS.shipped} -> ${BILLING.shipment}`, 'ask'],
      [`${ORDERS.shipped} -> ${STOCK_LOW}`, 'no-link'],
      [`${ORDERS.shipped} -> ${STOCK_COUNT}`, 'not-judged'],
    ]);
    expect(d.counts).toEqual({
      propose: 3,
      ask: 1,
      'no-link': 1,
      'not-judged': 1,
      'skip-accepted': 1,
      'skip-rejected': 1,
      'skip-held': 1,
    });
  });

  it('proposes by score with rounded confidence, both refs as evidence, highest first', () => {
    expect(d.relations.map((r) => [r.type, key(r), r.confidence])).toEqual([
      ['message', `${ORDERS.shipped} -> ${BILLING.shipped}`, 1],
      ['trigger', `${ORDERS.done} -> ${BILLING.done}`, 1],
      ['message', `${CANCEL} -> ${ORDERS.cancelled}`, 0.8],
      ['message', `${ORDERS.shipped} -> ${BILLING.shipment}`, 0.58],
    ]);
    for (const r of d.relations) expect(r.evidence).toEqual([r.from, r.to]);
  });

  it('builds the rationale from basis, score and both endpoints', () => {
    const [key1, trigger, reopened, borderline] = d.relations;
    expect(key1?.rationale).toBe(
      'Same message name "OrderShipped" on both ends (key tier, score 1.00): "Order shipped" ' +
        '(message throw, process "Order handling" in vertrieb/orders) → "Order shipped" ' +
        '(message catch, process "Billing" in finanzen/billing).',
    );
    expect(trigger?.rationale).toMatch(
      /^Identical labels \(lexical score 1\.00\): "Order done" \(end event, /,
    );
    expect(reopened?.rationale).toMatch(/An endpoint changed since a reviewer rejected this pair/);
    expect(borderline?.rationale).toMatch(
      /^Similar labels \(lexical score 0\.58\): .* Borderline: below the proposal threshold 0\.65\.$/,
    );
  });

  it('asks a question only for borderline scores', () => {
    expect(d.relations.filter((r) => r.question !== null).map(key)).toEqual([
      `${ORDERS.shipped} -> ${BILLING.shipment}`,
    ]);
    expect(d.relations[3]?.question).toBe(
      '"Order shipped" (vertrieb/orders) and "Shipment sent" (finanzen/billing) are similar (score 0.58) ' +
        'but not the same wording. Do both mean the same business event?',
    );
  });

  it('records judged pairs below askAt as no-links, never compatible ones', () => {
    expect(d.noLinks).toEqual([
      {
        from: ORDERS.shipped,
        to: STOCK_LOW,
        reason: 'Score 0.31 below 0.50: "Order shipped" and "Stock low" share too little.',
      },
    ]);
  });

  it('summarizes what it did', () => {
    expect(d.summary).toBe(
      `${SIM_POLICY} (propose at ≥ 0.65, ask at ≥ 0.50): 4 proposed, 1 of them with a question; ` +
        '1 no-links; 3 skipped (accepted, rejected or held); 1 compatible candidates not judged.',
    );
  });

  it('builds a valid submission body', () => {
    const body = SubmitAnalysisBody.parse({
      leaseToken: 'proa_lt_x',
      submissionId: '00000000-0000-4000-8000-000000000000',
      procedure: { id: 'proa-relations', version: '0.0.1' },
      llmModel: SIM_POLICY,
      relations: d.relations,
      noLinks: d.noLinks,
      summary: d.summary,
      costUsd: 0,
    });
    expect(body.relations).toHaveLength(4);
  });

  it('is deterministic', () => {
    expect(decide(claimInput())).toEqual(decide(claimInput()));
  });

  it('asks about a call target that is not unique', () => {
    const input = claimInput({
      candidates: [['call', ORDERS.callBilling, BILLING.process, 'key', 0.5]],
      relations: [],
    });
    const [r] = decide(input).relations;
    expect(r?.confidence).toBe(0.5);
    expect(r?.rationale).toMatch(
      /^The call target "Process_Billing" is the id of 2 processes, this one among them/,
    );
    expect(r?.question).toBe(
      `Is "Billing" (${BILLING.process}) the process that the call "Bill the order" in vertrieb/orders starts? The target is not unique (score 0.50).`,
    );
  });

  it('follows the thresholds, which must be ordered', () => {
    const strict = decide(claimInput(), { proposeAt: 0.95, askAt: 0.75 });
    expect(strict.relations.map((r) => [r.confidence, r.question !== null])).toEqual([
      [1, false],
      [1, false],
      [0.8, true],
    ]);
    expect(() => decide(claimInput(), { proposeAt: 0.4, askAt: 0.6 })).toThrow(RangeError);
    expect(() => decide(claimInput(), { proposeAt: 1.2, askAt: 0.6 })).toThrow(RangeError);
  });

  it('judges a pair by its score alone, whatever the basis', () => {
    // The same pair can be `lexical` in one model's input and `compatible` in its partner's.
    for (const basis of ['lexical', 'compatible', 'key'] as const) {
      for (const score of [0.2, 0.55, 0.7]) {
        const input = claimInput({
          candidates: [['message', ORDERS.shipped, BILLING.shipment, basis, score]],
          relations: [],
        });
        const verdict = decide(input).judgements[0]?.verdict;
        const expected =
          score >= 0.65
            ? 'propose'
            : score >= 0.5
              ? 'ask'
              : basis === 'compatible'
                ? 'not-judged'
                : 'no-link';
        expect(verdict, `${basis} ${score}`).toBe(expected);
      }
    }
  });

  it('keeps within the submission limits on large inputs', () => {
    // A seeded pseudo-random input with far more candidates than a submission may hold.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const partners: ClaimInput['partners'] = {};
    const candidates: ClaimCandidate[] = [];
    for (let i = 0; i < 900; i++) {
      const ref = `lager/p${i % 30}#Catch_${i}`;
      partners[ref] = {
        kind: 'msg_catch',
        eventDef: 'message',
        label: `Ereignis ${'x'.repeat(i % 400)} ${i}`,
        process: `lager/p${i % 30}#Process_P`,
      };
      const basis = (['key', 'lexical', 'compatible'] as const)[i % 3] ?? 'lexical';
      candidates.push([
        'message',
        ORDERS.shipped,
        ref as ClaimCandidate[2],
        basis,
        Math.round(rand() * 10_000) / 10_000,
      ]);
    }
    candidates.sort((a, b) => b[4] - a[4]);
    const big = decide(claimInput({ candidates, partners, relations: [] }));
    expect(big.relations).toHaveLength(MAX_SUBMISSION_RELATIONS);
    expect(big.noLinks.length).toBeLessThanOrEqual(MAX_SUBMISSION_NO_LINKS);
    expect(big.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    for (const r of big.relations) {
      expect(r.confidence).toBeGreaterThanOrEqual(DEFAULT_POLICY.askAt);
      expect(r.rationale.length).toBeLessThanOrEqual(MAX_RATIONALE_CHARS);
      expect((r.question ?? '').length).toBeLessThanOrEqual(MAX_QUESTION_CHARS);
    }
    // The cut keeps the strongest proposals.
    const confidences = big.relations.map((r) => r.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
  });
});

describe('normalizeLabel', () => {
  it('ignores case, umlaut spelling and punctuation', () => {
    expect(normalizeLabel('Antrag prüfen')).toBe(normalizeLabel('ANTRAG-pruefen'));
    expect(normalizeLabel('Straße  gesperrt!')).toBe('strasse gesperrt');
  });
});
