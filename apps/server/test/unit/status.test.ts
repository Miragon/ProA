import type { PrincipalId } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import {
  currentStances,
  endpointState,
  recomputeStatus,
  type AssertionView,
} from '../../src/domain/status.ts';

const RULE = 'prn_0000000000000000000000RULE' as PrincipalId;
const HUMAN = 'prn_000000000000000000000HUMAN' as PrincipalId;
const AGENT = 'prn_000000000000000000000AGENT' as PrincipalId;

let seq = 0;
function a(
  principalId: PrincipalId,
  kind: AssertionView['kind'],
  extra: Partial<AssertionView> = {},
): AssertionView {
  return {
    seq: ++seq,
    kind,
    verdict: kind === 'decision' ? 'accept' : null,
    principalId,
    tier: kind === 'proposal' ? 'key' : null,
    confidence: kind === 'proposal' ? 1 : null,
    fromFp: 'f1',
    toFp: 't1',
    ...extra,
  };
}

describe('recomputeStatus (CONCEPT §2)', () => {
  it('is obsolete without assertions or live proposals', () => {
    expect(recomputeStatus([]).status).toBe('obsolete');
    expect(recomputeStatus([a(AGENT, 'proposal'), a(AGENT, 'withdrawal')]).status).toBe('obsolete');
  });

  it('is proposed with a live proposal', () => {
    const s = recomputeStatus([a(AGENT, 'proposal', { tier: 'semantic', confidence: 0.8 })]);
    expect(s).toEqual({
      status: 'proposed',
      tier: 'semantic',
      confidence: 0.8,
      anchor: { fromFp: 'f1', toFp: 't1' },
    });
  });

  it('lets the latest decision win', () => {
    const history = [a(AGENT, 'proposal'), a(HUMAN, 'decision', { verdict: 'hold' })];
    expect(recomputeStatus(history).status).toBe('held');
    history.push(a(HUMAN, 'decision', { verdict: 'accept' }));
    expect(recomputeStatus(history).status).toBe('accepted');
    history.push(a(HUMAN, 'decision', { verdict: 'reject' }));
    expect(recomputeStatus(history).status).toBe('rejected');
  });

  it('keeps a rejection against a newer proposal with the same fingerprints', () => {
    const history = [
      a(AGENT, 'proposal'),
      a(HUMAN, 'decision', { verdict: 'reject' }),
      a(RULE, 'proposal'),
    ];
    expect(recomputeStatus(history).status).toBe('rejected');
  });

  it('reopens a rejection when a newer proposal has different fingerprints', () => {
    const history = [
      a(AGENT, 'proposal'),
      a(HUMAN, 'decision', { verdict: 'reject' }),
      a(AGENT, 'proposal', { toFp: 't2' }),
    ];
    const s = recomputeStatus(history);
    expect(s.status).toBe('proposed');
    expect(s.anchor).toEqual({ fromFp: 'f1', toFp: 't2' });
  });

  it('does not reopen an acceptance', () => {
    const history = [a(HUMAN, 'decision'), a(AGENT, 'proposal', { toFp: 't2' })];
    expect(recomputeStatus(history).status).toBe('accepted');
  });

  it('replaces a principal’s stance by its newer assertion (rule: decision → proposal)', () => {
    const history = [a(RULE, 'decision', { tier: 'rule', confidence: 1 }), a(RULE, 'proposal')];
    expect(currentStances(history).map((s) => s.kind)).toEqual(['proposal']);
    expect(recomputeStatus(history).status).toBe('proposed');
  });

  it('a withdrawal ends a rule acceptance', () => {
    const history = [a(RULE, 'decision', { tier: 'rule', confidence: 1 }), a(RULE, 'withdrawal')];
    const s = recomputeStatus(history);
    expect(s.status).toBe('obsolete');
    expect(s.tier).toBe('rule');
  });

  it('reports the strongest live tier', () => {
    const history = [
      a(AGENT, 'proposal', { tier: 'lexical', confidence: 0.9 }),
      a(RULE, 'decision', { tier: 'rule', confidence: 1 }),
    ];
    expect(recomputeStatus(history)).toMatchObject({
      status: 'accepted',
      tier: 'rule',
      confidence: 1,
    });
  });
});

describe('endpointState', () => {
  const anchor = { fromFp: 'f1', toFp: 't1' };
  it.each([
    [{ from: 'f1', to: 't1' }, 'ok'],
    [{ from: 'f1', to: 't9' }, 'changed'],
    [{ from: undefined, to: 't1' }, 'missing'],
    [{ from: 'f1', to: undefined }, 'missing'],
  ] as const)('%o → %s', (current, state) => {
    expect(endpointState(anchor, current)).toBe(state);
  });
});
