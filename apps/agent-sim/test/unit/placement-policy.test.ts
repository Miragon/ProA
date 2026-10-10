import { MAX_SUMMARY_CHARS, OUTSIDE_STEP, SubmitAnalysisBody } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import {
  NO_EVIDENCE,
  RULE_CONFIDENCE,
  WEAK_HINT_CONFIDENCE,
  decidePlacements,
  hintConfidence,
} from '../../src/placement-policy.ts';
import { P, placementInput, placementProcesses } from '../support/placement-fixtures.ts';

describe('decidePlacements (sim-policy-1, placements)', () => {
  const input = placementInput();
  const d = decidePlacements(input);
  const of = (ref: string) => d.placements.find((p) => p.process === ref);

  it('gives every process of the input exactly one verdict, in input order', () => {
    expect(d.judgements.map((j) => j.process)).toEqual(input.processes.map((p) => p.process));
    const said = [...d.placements.map((p) => p.process), ...d.unsure.map((u) => u.process)];
    expect([...said].sort()).toEqual(input.processes.map((p) => p.process).sort());
    expect(new Set(said).size).toBe(said.length);
    expect(d.counts).toEqual({ rule: 1, hint: 3, 'hint-tie': 1, 'weak-hint': 1, unsure: 2 });
  });

  it('confirms a live rule-tier proposal at 0.95', () => {
    const rule = of(P.rule);
    expect(rule).toMatchObject({
      step: 'step-zulassung',
      process: P.rule,
      confidence: RULE_CONFIDENCE,
      evidence: [P.rule, 'step:step-zulassung'],
      question: null,
    });
    expect(rule?.rationale).toMatch(
      /^The rule tier proposes "Zulassung" \(Bewerbung & Zulassung > Zulassung\)/,
    );
  });

  it('follows the top hint, skipping steps a reviewer rejected (also a rejected rule proposal)', () => {
    // Score 4 → 0.9; the rejected rule step (score 6) is skipped.
    expect(of(P.ruleRejected)).toMatchObject({ step: 'step-bewerbung-zulassung', confidence: 0.9 });
    expect(of(P.strong)).toMatchObject({ step: 'step-lehre', confidence: 0.9, question: null });
    // The rejected top hint gives way to the next: 3.5 → 0.85, no tie behind it.
    expect(of(P.rejectedTop)).toMatchObject({
      step: 'step-pruefungen',
      confidence: 0.85,
      question: null,
    });
  });

  it('bands a hint by its score alone and claims no name match it cannot see', () => {
    // No word of "Studienberatung" is on "Lehre": three neighbours accepted there score 3.
    const [, strong] = placementProcesses();
    if (!strong) throw new Error('no fixture process');
    const votes = placementInput({
      processes: [
        {
          ...strong,
          process: 'beratung/sprechstunde#Process_Sprechstunde',
          name: 'Studienberatung',
          modelKey: 'beratung/sprechstunde',
          hints: [
            { step: 'step-lehre', name: 'Lehre', score: 3 },
            { step: 'step-studium', name: 'Studium', score: 1.5 },
          ],
        },
      ],
    });
    const [placed] = decidePlacements(votes).placements;
    expect(placed).toMatchObject({ step: 'step-lehre', confidence: 0.8, question: null });
    expect(placed?.rationale).toContain('scores 3 in the lexical baseline');
    expect(placed?.rationale).not.toMatch(/matches the step name/);
    expect(placed?.rationale).toMatch(
      /at least 3 from name, folder, parent-step or neighbour evidence/,
    );
  });

  it('asks on a tie of the two top hints', () => {
    const tie = of(P.tie);
    expect(tie).toMatchObject({ step: 'step-pruefungen', confidence: 0.8 });
    expect(tie?.question).toMatch(/"Prüfungen" \(Studium > Prüfungen\) or on "Zulassung"/);
    expect(tie?.rationale).toMatch(/scores the same/);
  });

  it('proposes a weak hint at 0.5 with a question, naming the process by its ref without a name', () => {
    const weak = of(P.weak);
    expect(weak).toMatchObject({ step: 'step-studium', confidence: WEAK_HINT_CONFIDENCE });
    expect(weak?.question).toMatch(/^Does "Process_Beurlaubung" belong on "Studium"\?/);
  });

  it('is unsure without a hint left', () => {
    expect(d.unsure).toEqual([
      { process: P.none, reason: NO_EVIDENCE },
      { process: P.allRejected, reason: `${NO_EVIDENCE} (a reviewer rejected the hinted steps)` },
    ]);
  });

  it('places one home step per process, never @outside, with the process and step as evidence', () => {
    expect(new Set(d.placements.map((p) => p.process)).size).toBe(d.placements.length);
    expect(d.placements.some((p) => p.step === OUTSIDE_STEP)).toBe(false);
    for (const p of d.placements) {
      expect(p.evidence).toEqual([p.process, `step:${p.step}`]);
      expect(p.rationale).not.toMatch(/\p{Cc}/u);
    }
  });

  it('bounds the hint confidence', () => {
    expect([2.5, 3, 3.5, 4, 9].map(hintConfidence)).toEqual([0.75, 0.8, 0.85, 0.9, 0.9]);
  });

  it('writes a summary within the limit and names a truncated input', () => {
    expect(d.summary).toBe(
      'sim-policy-1 (placements): 6 placed (1 confirming the rule tier, 2 with a question); 2 unsure.',
    );
    const truncated = decidePlacements({ ...input, truncated: true, remaining: 12 });
    expect(truncated.summary).toMatch(/; 12 processes left for a follow-up task\.$/);
    expect(truncated.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
  });

  it('is deterministic and a valid submission body', () => {
    expect(decidePlacements(placementInput())).toEqual(decidePlacements(placementInput()));
    const body = SubmitAnalysisBody.parse({
      leaseToken: 'x',
      submissionId: '00000000-0000-4000-8000-000000000000',
      procedure: { id: 'proa-placements', version: '0.0.1' },
      placements: d.placements,
      unsure: d.unsure,
      summary: d.summary,
    });
    expect(body.placements).toHaveLength(6);
  });

  it('keeps control characters out of the texts', () => {
    const [first] = placementProcesses();
    if (!first) throw new Error('fixture');
    const odd = decidePlacements(
      placementInput({ processes: [{ ...first, name: 'Bewerbung\nAnhang\u0007' }] }),
    );
    expect(odd.placements[0]?.rationale).toContain('"Bewerbung Anhang "');
  });
});
