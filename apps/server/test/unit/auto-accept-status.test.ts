/**
 * `decisionsInForce` with auto-accept rules (owner decision 19): a revoked
 * auto-acceptance is no longer in force and nothing older of its principal
 * comes back, while a later stance of its principal survives the revocation;
 * everything else treats it as a human decision. Unmarked
 * histories behave exactly as before (the golden digest in
 * `status-subjects.test.ts` stays, and a property test compares with the
 * previous implementation). Synthetic data only.
 */
import type { PrincipalId } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import {
  classifyProposal,
  currentStances,
  decisionsInForce,
  isRevokedAutoAccept,
  recomputeStatus,
  type AssertionView,
  type StanceView,
} from '../../src/domain/status.ts';
import { recomputePlacementStatus } from '../../src/domain/value-chain/placement-state.ts';
import { CASES, pick, relationCase, rng } from '../support/status-histories.ts';

const OWNER = 'prn_00000000000000000000OWNER' as PrincipalId;
const OWNER2 = 'prn_0000000000000000000OWNER2' as PrincipalId;
const AGENT = 'prn_000000000000000000000AGENT' as PrincipalId;
const RULE_ID = 'aar_01J9Z3N4X5Q6R7S8T9V0W1X2Y1';

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
    sourceKind: principalId === AGENT ? 'agent' : 'human',
    principalId,
    tier: kind === 'proposal' ? 'key' : null,
    confidence: kind === 'proposal' ? 0.95 : null,
    fromFp: 'f1',
    toFp: 't1',
    ...extra,
  };
}

const autoAccept = () => a(OWNER, 'decision', { autoAcceptRuleId: RULE_ID });
const revocation = () => a(OWNER, 'withdrawal', { autoAcceptRuleId: RULE_ID });

/** `decisionsInForce` before owner decision 19 (for the property test). */
function previousDecisionsInForce<T extends StanceView>(history: readonly T[]): T[] {
  const out = currentStances(history).filter((x) => x.kind === 'decision');
  const latestHuman = new Map<PrincipalId, T>();
  for (const x of history) {
    if (x.kind !== 'decision' || x.sourceKind !== 'human') continue;
    const prev = latestHuman.get(x.principalId);
    if (!prev || x.seq > prev.seq) latestHuman.set(x.principalId, x);
  }
  for (const d of latestHuman.values()) if (!out.includes(d)) out.push(d);
  return out.sort((x, y) => x.seq - y.seq);
}

describe('an auto-acceptance in force', () => {
  it('accepts like a human decision and suppresses the same proposal again', () => {
    const history = [a(AGENT, 'proposal'), autoAccept()];
    expect(recomputeStatus(history).status).toBe('accepted');
    expect(decisionsInForce(history)).toHaveLength(1);
    const again = classifyProposal(
      history.map((x) => ({ ...x, rationale: null, question: null })),
      {
        principalId: AGENT,
        tier: 'key',
        confidence: 0.95,
        rationale: 'x',
        question: null,
        fromFp: 'f1',
        toFp: 't1',
      },
    );
    expect(again.effect).toBe('suppressed');
  });

  it('stays in force after its principal proposes or a proposal is withdrawn', () => {
    const history = [a(AGENT, 'proposal'), autoAccept(), a(AGENT, 'withdrawal')];
    expect(recomputeStatus(history).status).toBe('accepted');
  });
});

describe('a revoked auto-acceptance', () => {
  it('returns the item to proposed while a live proposal remains', () => {
    const history = [a(AGENT, 'proposal'), autoAccept(), revocation()];
    expect(decisionsInForce(history)).toEqual([]);
    const s = recomputeStatus(history);
    expect(s.status).toBe('proposed');
    expect(s.basisSeq).toBe(history[0]?.seq);
  });

  it('turns the item obsolete without a live proposal', () => {
    const history = [a(AGENT, 'proposal'), autoAccept(), a(AGENT, 'withdrawal'), revocation()];
    expect(recomputeStatus(history).status).toBe('obsolete');
  });

  it('brings back no older decision of its principal', () => {
    const history = [
      a(AGENT, 'proposal'),
      a(OWNER, 'decision', { verdict: 'hold' }),
      autoAccept(),
      revocation(),
    ];
    expect(decisionsInForce(history)).toEqual([]);
    expect(recomputeStatus(history).status).toBe('proposed');
  });

  it('leaves a human decision taken since untouched', () => {
    const reject = () => a(OWNER, 'decision', { verdict: 'reject' });
    const history = [a(AGENT, 'proposal'), autoAccept(), reject(), revocation()];
    expect(recomputeStatus(history).status).toBe('rejected');
    const other = [
      a(AGENT, 'proposal'),
      autoAccept(),
      a(OWNER2, 'decision', { verdict: 'hold' }),
      revocation(),
    ];
    expect(recomputeStatus(other).status).toBe('held');
  });

  it('needs a withdrawal of the same principal with the same rule, made later', () => {
    const d = autoAccept();
    const before = a(OWNER, 'withdrawal', { autoAcceptRuleId: RULE_ID, seq: d.seq - 1 });
    expect(isRevokedAutoAccept([before, d], d)).toBe(false);
    expect(
      isRevokedAutoAccept([d, a(OWNER2, 'withdrawal', { autoAcceptRuleId: RULE_ID })], d),
    ).toBe(false);
    expect(
      isRevokedAutoAccept([d, a(OWNER, 'withdrawal', { autoAcceptRuleId: 'aar_other' })], d),
    ).toBe(false);
    expect(isRevokedAutoAccept([d, a(OWNER, 'withdrawal')], d)).toBe(false);
    const w = revocation();
    expect(isRevokedAutoAccept([d, w], d)).toBe(true);
  });

  it('ends only the acceptance: a later stance of its principal stays', () => {
    // The rule's author proposed the pair again (say, after an endpoint change) before the revocation.
    const own = () => a(OWNER, 'proposal', { fromFp: 'f2', tier: 'manual', confidence: 1 });
    const proposal = a(AGENT, 'proposal');
    const accepted = autoAccept();
    const later = own();
    const history = [proposal, accepted, later, revocation()];
    expect(currentStances(history).map((x) => x.seq)).toEqual([history[0]?.seq, later.seq]);
    expect(decisionsInForce(history)).toEqual([]);
    const s = recomputeStatus(history);
    expect(s.status).toBe('proposed');
    expect(s.basisSeq).toBe(later.seq);
    // In any order of the input.
    expect(recomputeStatus([...history].reverse())).toEqual(s);
    // A withdrawal of its own since stays a withdrawal: nothing of the principal is live.
    const withdrawn = [
      a(AGENT, 'proposal'),
      autoAccept(),
      own(),
      a(OWNER, 'withdrawal'),
      revocation(),
    ];
    expect(currentStances(withdrawn).map((x) => x.principalId)).toEqual([AGENT]);
    // Without a later stance the revocation ends the acceptance as before.
    const plain = [a(AGENT, 'proposal'), autoAccept(), revocation()];
    expect(currentStances(plain).map((x) => x.principalId)).toEqual([AGENT]);
  });

  it('works the same for placements', () => {
    const history = [a(AGENT, 'proposal'), autoAccept(), revocation()].map((x) => ({
      ...x,
      stepFp: 's1',
      processFp: 'p1',
    }));
    expect(recomputePlacementStatus(history).status).toBe('proposed');
  });
});

describe('properties', () => {
  it('unmarked histories give exactly the previous decisions in force', () => {
    for (let i = 0; i < CASES; i++) {
      const c = relationCase(i);
      expect(decisionsInForce(c.history).map((x) => x.seq)).toEqual(
        previousDecisionsInForce(c.history).map((x) => x.seq),
      );
    }
  });

  it('a revoked auto-acceptance is never in force; a later human decision always is', () => {
    for (let i = 0; i < 500; i++) {
      const r = rng(9_000 + i);
      const base = relationCase(i).history.filter((x) => x.sourceKind !== 'human');
      let next = Math.max(0, ...base.map((x) => x.seq)) + 1;
      const d = { ...autoAccept(), seq: next++ };
      const history: AssertionView[] = [...base, d];
      const tail = pick(r, ['revoke', 'decide-revoke', 'revoke-decide', 'propose-revoke'] as const);
      let later: AssertionView | null = null;
      if (tail === 'decide-revoke' || tail === 'revoke-decide') {
        later = a(pick(r, [OWNER, OWNER2]), 'decision', {
          seq: 0,
          verdict: pick(r, ['accept', 'reject', 'hold'] as const),
        });
      }
      const revoke = { ...revocation(), seq: 0 };
      const order =
        tail === 'revoke'
          ? [revoke]
          : tail === 'decide-revoke'
            ? [later, revoke]
            : tail === 'revoke-decide'
              ? [revoke, later]
              : [a(AGENT, 'proposal', { seq: 0 }), revoke];
      for (const x of order) if (x) history.push({ ...x, seq: next++ });
      const inForce = decisionsInForce(history);
      expect(inForce.some((x) => x.seq === d.seq)).toBe(false);
      if (later) {
        const stored = history.find(
          (x) => x.kind === 'decision' && x !== d && x.sourceKind === 'human',
        );
        expect(stored && inForce.includes(stored)).toBe(true);
      }
    }
  });
});
