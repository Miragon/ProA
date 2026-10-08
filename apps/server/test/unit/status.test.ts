import type { PrincipalId } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import {
  classifyProposal,
  currentStances,
  decisionsInForce,
  endpointState,
  recomputeStatus,
  type AssertionView,
} from '../../src/domain/status.ts';

const RULE = 'prn_0000000000000000000000RULE' as PrincipalId;
const HUMAN = 'prn_000000000000000000000HUMAN' as PrincipalId;
const AGENT = 'prn_000000000000000000000AGENT' as PrincipalId;
const OTHER = 'prn_000000000000000000000OTHER' as PrincipalId;

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
    sourceKind: principalId === RULE ? 'rule' : principalId === HUMAN ? 'human' : 'agent',
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
    expect(s).toMatchObject({
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

  it('keeps a human decision in force when the same human proposes or withdraws later', () => {
    const accept = a(HUMAN, 'decision', { verdict: 'accept' });
    const ownProposal = a(HUMAN, 'proposal', { toFp: 't2' });
    expect(recomputeStatus([a(AGENT, 'proposal'), accept, ownProposal])).toMatchObject({
      status: 'accepted',
      basisSeq: accept.seq,
    });
    const withdrawn = [accept, ownProposal, a(HUMAN, 'withdrawal'), a(AGENT, 'withdrawal')];
    expect(recomputeStatus(withdrawn).status).toBe('accepted');
    expect(decisionsInForce(withdrawn)).toEqual([accept]);
    // A later decision of the same human replaces the earlier one.
    const reject = a(HUMAN, 'decision', { verdict: 'reject' });
    expect(decisionsInForce([accept, ownProposal, reject])).toEqual([reject]);
    // The human's own proposal with other fingerprints reopens the human's rejection.
    expect(recomputeStatus([reject, a(HUMAN, 'proposal', { toFp: 't2' })]).status).toBe('proposed');
    expect(recomputeStatus([reject, a(HUMAN, 'proposal')]).status).toBe('rejected');
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

describe('notes and the basis assertion', () => {
  it('never lets a note change the status, tier or anchor', () => {
    const history = [a(AGENT, 'proposal'), a(HUMAN, 'decision', { verdict: 'hold' })];
    const before = recomputeStatus(history);
    const withNote = recomputeStatus([...history, a(HUMAN, 'note', { fromFp: 'x', toFp: 'y' })]);
    expect(withNote).toEqual(before);
    expect(before.status).toBe('held');
  });

  it('names the assertion the status rests on', () => {
    const p = a(AGENT, 'proposal');
    const d = a(HUMAN, 'decision', { verdict: 'reject' });
    expect(recomputeStatus([p]).basisSeq).toBe(p.seq);
    expect(recomputeStatus([p, d]).basisSeq).toBe(d.seq);
    const reopen = a(AGENT, 'proposal', { toFp: 't9' });
    expect(recomputeStatus([p, d, reopen]).basisSeq).toBe(reopen.seq);
    const w = a(AGENT, 'withdrawal');
    expect(recomputeStatus([p, w]).basisSeq).toBe(w.seq);
    expect(recomputeStatus([]).basisSeq).toBeNull();
  });
});

describe('classifyProposal', () => {
  const proposal = (extra: Partial<Parameters<typeof classifyProposal>[1]> = {}) => ({
    principalId: AGENT,
    tier: 'semantic' as const,
    confidence: 0.8,
    rationale: 'r',
    question: null,
    fromFp: 'f1',
    toFp: 't1',
    ...extra,
  });
  const h = (...xs: AssertionView[]) => xs.map((x) => ({ ...x, rationale: 'r', question: null }));

  it('applies a proposal on a new relation', () => {
    expect(classifyProposal([], proposal())).toEqual({ effect: 'applied', record: true });
  });

  it('suppresses it while a human decision with the same fingerprints stands', () => {
    for (const verdict of ['accept', 'reject', 'hold'] as const) {
      const history = h(a(OTHER, 'proposal'), a(HUMAN, 'decision', { verdict }));
      expect(classifyProposal(history, proposal()), verdict).toEqual({
        effect: 'suppressed',
        record: false,
      });
    }
  });

  it('reopens a rejection when an endpoint changed', () => {
    const history = h(a(OTHER, 'proposal'), a(HUMAN, 'decision', { verdict: 'reject' }));
    expect(classifyProposal(history, proposal({ toFp: 't2' }))).toEqual({
      effect: 'reopened',
      record: true,
    });
  });

  it('records a changed proposal under a hold or an acceptance without reopening', () => {
    for (const verdict of ['accept', 'hold'] as const) {
      const history = h(a(OTHER, 'proposal'), a(HUMAN, 'decision', { verdict }));
      expect(classifyProposal(history, proposal({ toFp: 't2' }))).toEqual({
        effect: 'applied',
        record: true,
      });
    }
  });

  it('is a duplicate of the caller’s identical live proposal or of a rule acceptance', () => {
    const own = h(a(AGENT, 'proposal', { tier: 'semantic', confidence: 0.8 }));
    expect(classifyProposal(own, proposal())).toEqual({ effect: 'duplicate', record: false });
    expect(classifyProposal(own, proposal({ confidence: 0.9 })).effect).toBe('applied');
    const rule = h(a(RULE, 'decision', { tier: 'rule', confidence: 1 }));
    expect(classifyProposal(rule, proposal())).toEqual({ effect: 'duplicate', record: false });
  });

  it('is a duplicate of a pipeline proposal only with the same basis and procedure', () => {
    const v1 = { id: 'proa-relations', version: '0.2.0' };
    const own = h(a(AGENT, 'proposal', { tier: 'semantic', confidence: 0.8 })).map((x) => ({
      ...x,
      submissionId: 'sbm_1',
      fromHash: 'hx1',
      toHash: 'hy1',
      declared: { procedure: v1 },
    }));
    const basis = (fromHash: string, procedure = v1) => ({
      basis: { fromHash, toHash: 'hy1', procedure },
    });
    expect(classifyProposal(own, proposal(basis('hx1')))).toEqual({
      effect: 'duplicate',
      record: false,
    });
    // A re-judgement on a newer version of a model (a doc-only change keeps the fingerprints)
    // or under another procedure is recorded: it carries the new basis.
    expect(classifyProposal(own, proposal(basis('hx2')))).toEqual({
      effect: 'applied',
      record: true,
    });
    expect(classifyProposal(own, proposal(basis('hx1', { ...v1, version: '0.3.0' }))).effect).toBe(
      'applied',
    );
    // An ad-hoc stance is no pipeline judgement: a pipeline repeat is recorded.
    const adHoc = h(a(AGENT, 'proposal', { tier: 'semantic', confidence: 0.8 }));
    expect(classifyProposal(adHoc, proposal(basis('hx1'))).effect).toBe('applied');
  });
});

describe('recomputeStatus properties (random histories)', () => {
  /** Mulberry32: a small seeded PRNG, so failures reproduce. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let x = Math.imul(s ^ (s >>> 15), 1 | s);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const FPS = ['f1', 'f2'] as const;

  function randomHistory(r: () => number): AssertionView[] {
    const n = Math.floor(r() * 8);
    const out: AssertionView[] = [];
    for (let i = 0; i < n; i++) {
      const principal = pick(r, [RULE, HUMAN, AGENT, OTHER] as const);
      const kinds =
        principal === HUMAN
          ? (['decision', 'note', 'proposal', 'withdrawal'] as const)
          : principal === RULE
            ? (['decision', 'proposal', 'withdrawal'] as const)
            : (['proposal', 'withdrawal'] as const);
      const kind = pick(r, kinds);
      out.push(
        a(principal, kind, {
          verdict: kind === 'decision' ? pick(r, ['accept', 'reject', 'hold'] as const) : null,
          tier: kind === 'proposal' ? pick(r, ['key', 'lexical', 'semantic'] as const) : null,
          confidence: kind === 'proposal' ? pick(r, [0.2, 0.5, 1]) : null,
          fromFp: pick(r, FPS),
          toFp: pick(r, FPS),
        }),
      );
    }
    return out;
  }

  const RUNS = 2000;
  const histories = Array.from({ length: RUNS }, (_, i) => {
    const r = rng(i + 1);
    return { r, history: randomHistory(r) };
  });

  it('does not depend on the order of the input', () => {
    for (const { r, history } of histories) {
      const shuffled = [...history].sort(() => r() - 0.5);
      expect(recomputeStatus(shuffled)).toEqual(recomputeStatus(history));
    }
  });

  it('ignores notes', () => {
    for (const { history } of histories) {
      const withoutNotes = history.filter((x) => x.kind !== 'note');
      const s = recomputeStatus(history);
      const t = recomputeStatus(withoutNotes);
      expect({ ...s, basisSeq: null }).toEqual({ ...t, basisSeq: null });
      expect(s.basisSeq).toBe(t.basisSeq);
    }
  });

  it('is obsolete exactly when no principal holds a live proposal or decision', () => {
    for (const { history } of histories) {
      const live = [...currentStances(history), ...decisionsInForce(history)];
      expect(recomputeStatus(history).status === 'obsolete', JSON.stringify(history)).toBe(
        live.length === 0,
      );
    }
  });

  it('follows the latest decision, unless a newer proposal with other fingerprints reopens a rejection', () => {
    for (const { history } of histories) {
      const stances = currentStances(history);
      // A human's latest decision stays in force; the rule's ends with its next stance.
      const humans = history.filter((x) => x.kind === 'decision' && x.sourceKind === 'human');
      const decision = [...stances.filter((x) => x.kind === 'decision'), ...humans.slice(-1)]
        .sort((x, y) => x.seq - y.seq)
        .at(-1);
      const { status } = recomputeStatus(history);
      if (!decision) {
        expect(['proposed', 'obsolete']).toContain(status);
        continue;
      }
      const reopened =
        decision.verdict === 'reject' &&
        stances.some(
          (p) =>
            p.kind === 'proposal' &&
            p.seq > decision.seq &&
            (p.fromFp !== decision.fromFp || p.toFp !== decision.toFp),
        );
      const expected = reopened
        ? 'proposed'
        : { accept: 'accepted', reject: 'rejected', hold: 'held' }[decision.verdict ?? 'accept'];
      expect(status, JSON.stringify(history)).toBe(expected);
    }
  });

  it('rests on an assertion of the history', () => {
    for (const { history } of histories) {
      const { basisSeq } = recomputeStatus(history);
      const stancesOnly = history.filter((x) => x.kind !== 'note');
      if (stancesOnly.length === 0) expect(basisSeq).toBeNull();
      else expect(stancesOnly.map((x) => x.seq)).toContain(basisSeq);
    }
  });

  it('classifyProposal: a proposal it does not record would not change the status', () => {
    for (const { r, history } of histories) {
      const withText = history.map((x) => ({ ...x, rationale: 'r', question: null }));
      const p = {
        principalId: pick(r, [AGENT, OTHER] as const),
        tier: pick(r, ['key', 'lexical', 'semantic'] as const),
        confidence: pick(r, [0.2, 0.5, 1]),
        rationale: 'r',
        question: null,
        fromFp: pick(r, FPS),
        toFp: pick(r, FPS),
      };
      const { effect, record } = classifyProposal(withText, p);
      const before = recomputeStatus(history).status;
      const after = recomputeStatus([
        ...history,
        a(p.principalId, 'proposal', {
          tier: p.tier,
          confidence: p.confidence,
          fromFp: p.fromFp,
          toFp: p.toFp,
        }),
      ]).status;
      if (!record) expect(after, `${effect} ${JSON.stringify(history)}`).toBe(before);
      if (effect === 'reopened') expect([before, after]).toEqual(['rejected', 'proposed']);
      if (effect === 'applied' && before === 'rejected') expect(after).toBe('rejected');
    }
  });
});
