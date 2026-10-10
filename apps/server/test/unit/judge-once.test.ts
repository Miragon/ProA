/**
 * Judge each pair once, the pure parts (CONCEPT §3): currency and staleness
 * of a judgement's basis, who judges a candidate or relation pair at a claim, the
 * no-link item checks, and how `judged` and `skip` render in the claim input.
 */
import {
  ClaimInput,
  NO_LINK_INVALID_REASONS,
  type Candidate,
  type DeclaredProcedure,
  type PrincipalId,
  type ProjectFacts,
  type Ref,
} from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { renderClaimInput } from '../../src/domain/claim-input.ts';
import {
  isAssignedRelation,
  isCurrent,
  pairKey,
  planClaim,
  staleFor,
  type Judgement,
  type PartnerTask,
} from '../../src/domain/judgements.ts';
import { validateNoLink } from '../../src/domain/no-links.ts';
import type { PairAssessment, PairQuery, RelationRecord } from '../../src/domain/ports.ts';

const V1: DeclaredProcedure = { id: 'proa-relations', version: '0.2.0' };
const V2: DeclaredProcedure = { id: 'proa-relations', version: '0.3.0' };
const HEADS = new Map([
  ['a/x', 'hx2'],
  ['b/y', 'hy1'],
]);
const ME = 'prn_00000000000000000000000ME' as PrincipalId;
const YOU = 'prn_0000000000000000000000YOU' as PrincipalId;

const pair = { from: 'a/x#E', to: 'b/y#C' };

describe('the basis of a judgement', () => {
  it('is current while both hashes are the heads and the procedure is the one claims name', () => {
    expect(isCurrent({ ...pair, fromHash: 'hx2', toHash: 'hy1' }, V1, HEADS, V1)).toBe(true);
    expect(isCurrent({ ...pair, fromHash: 'hx1', toHash: 'hy1' }, V1, HEADS, V1)).toBe(false);
    expect(isCurrent({ ...pair, fromHash: 'hx2', toHash: 'hy1' }, V2, HEADS, V1)).toBe(false);
    // Before 0.2.0 no basis was recorded; a deleted model has no head.
    expect(isCurrent({ ...pair, fromHash: null, toHash: 'hy1' }, V1, HEADS, V1)).toBe(false);
    expect(
      isCurrent({ from: 'a/x#E', to: 'z/gone#C', fromHash: 'hx2', toHash: 'hz' }, V1, HEADS, V1),
    ).toBe(false);
  });

  it('is stale on a model’s side when that side’s hash or the procedure differs', () => {
    const j = { ...pair, fromHash: 'hx1', toHash: 'hy1', procedure: V1 };
    expect(staleFor('a/x', 'hx2', V1, j)).toBe(true);
    // Stale only on the partner side: left to the partner's analysis.
    expect(staleFor('b/y', 'hy1', V1, j)).toBe(false);
    expect(staleFor('b/y', 'hy1', V2, j)).toBe(true);
    expect(staleFor('b/y', 'hy1', V1, { ...j, toHash: null })).toBe(true);
    // Untouched models never supersede it; intra-model pairs check both sides.
    expect(staleFor('c/z', 'hz', V2, j)).toBe(false);
    const intra = { from: 'a/x#E', to: 'a/x#C', fromHash: 'hx2', toHash: 'hx1', procedure: V1 };
    expect(staleFor('a/x', 'hx2', V1, intra)).toBe(true);
  });
});

describe('planClaim: who judges a candidate pair', () => {
  const candidate = (
    from: string,
    to: string,
    type: Candidate['type'] = 'message',
    basis: Candidate['basis'] = 'lexical',
  ): Candidate => ({
    type,
    from: from as Ref,
    to: to as Ref,
    basis,
    score: 0.5,
    signals: {},
  });
  const judgement = (j: Partial<Judgement>): Judgement => ({
    kind: 'no-link',
    id: 'nlk_1',
    relationId: null,
    type: 'message',
    from: 'b/y#E',
    to: 'c/z#C',
    origin: 'b/y',
    principalId: YOU,
    handle: 'agent:you',
    reason: 'no-evidence: nein',
    fromHash: 'h',
    toHash: 'h',
    procedure: V1,
    current: true,
    ...j,
  });
  const queued: PartnerTask = {
    state: 'queued',
    live: false,
    assignment: new Set(),
    sawClaimant: false,
  };
  const claimed = (keys: string[], extra: Partial<PartnerTask> = {}): PartnerTask => ({
    state: 'claimed',
    live: true,
    assignment: new Set(keys),
    sawClaimant: true,
    ...extra,
  });
  const P = candidate('b/y#E', 'c/z#C');
  const Q = candidate('b/y#E', 'a/x#C');
  const plan = (
    partners: [string, PartnerTask][],
    extra: { judgements?: Judgement[]; settled?: string[]; inPartner?: boolean } = {},
  ) =>
    planClaim({
      modelKey: 'b/y',
      candidates: [P, Q, P],
      relations: [],
      judgements: extra.judgements ?? [],
      settled: new Set(extra.settled ?? []),
      partners: new Map(partners),
      partnerCandidates: () => new Set(extra.inPartner === false ? [] : [pairKey(P), pairKey(Q)]),
    });

  it('assigns every pair without judgement, decision or partner task to the claim, once', () => {
    expect(plan([])).toEqual({ judged: [], skip: [], assignment: [P, Q].map(typed) });
  });

  it('assigns rule, key and lexical pairs only; compatible ones are the search space', () => {
    const K = candidate('b/y#E', 'c/z#K', 'message', 'key');
    const U = candidate('a/x#Call', 'b/y#Process', 'call', 'rule');
    const C = candidate('b/y#E', 'c/z#C2', 'message', 'compatible');
    const D = candidate('b/y#E', 'a/x#C2', 'message', 'compatible');
    const run = (partners: [string, PartnerTask][], judgements: Judgement[] = []) =>
      planClaim({
        modelKey: 'b/y',
        candidates: [K, U, C, P, D],
        relations: [],
        judgements,
        settled: new Set(),
        partners: new Map(partners),
        partnerCandidates: () => new Set([K, U, C, P, D].map(pairKey)),
      });
    // Neither assigned nor skipped nor uncovered: `candidates` keeps C and D.
    expect(run([])).toEqual({ judged: [], skip: [], assignment: [K, U, P].map(typed) });
    // A queued partner that sorts first never takes a compatible pair from here.
    expect(run([['a/x', queued]]).skip).toEqual([{ ...typed(U), model: 'a/x', reason: 'queued' }]);
    // A live claimed partner whose assignment holds the pair (its basis there is
    // systematic) is judging it now: skipped, so it is not examined twice.
    expect(run([['c/z', claimed([pairKey(C)])]])).toEqual({
      judged: [],
      skip: [{ ...typed(C), model: 'c/z', reason: 'claimed' }],
      assignment: [K, U, P].map(typed),
    });
    // A judged compatible pair is listed in `judged`, like any other.
    const verdict = judgement({ from: C.from, to: C.to });
    expect(run([], [verdict])).toEqual({
      judged: [verdict],
      skip: [],
      assignment: [K, U, P].map(typed),
    });
  });

  it('skips a pair a live claimed partner holds, if its claim saw this model as it is', () => {
    expect(plan([['c/z', claimed([pairKey(P)])]]).skip).toEqual([
      { ...typed(P), model: 'c/z', reason: 'claimed' },
    ]);
    for (const other of [
      claimed([pairKey(P)], { live: false }),
      claimed([pairKey(P)], { sawClaimant: false }),
      claimed([]),
    ]) {
      expect(plan([['c/z', other]]).assignment).toEqual([P, Q].map(typed));
    }
  });

  it('skips a pair of a queued partner whose key sorts first and that has it as a candidate', () => {
    // a/x sorts before b/y: Q goes to a/x; c/z sorts after: P stays here.
    const out = plan([
      ['a/x', queued],
      ['c/z', queued],
    ]);
    expect(out.skip).toEqual([{ ...typed(Q), model: 'a/x', reason: 'queued' }]);
    expect(out.assignment).toEqual([typed(P)]);
    expect(plan([['a/x', queued]], { inPartner: false }).assignment).toEqual([P, Q].map(typed));
  });

  it('lists current judgements and assigns no judged or settled pair; stale ones count as none', () => {
    const current = judgement({});
    const stale = judgement({ id: 'nlk_2', from: Q.from, to: Q.to, current: false });
    const out = plan([], { judgements: [stale, current] });
    expect(out.judged).toEqual([current]);
    expect(out.assignment).toEqual([typed(Q)]);
    expect(plan([], { settled: [pairKey(Q)] }).assignment).toEqual([typed(P)]);
  });

  it('keeps intra-model pairs for the claim', () => {
    const intra = candidate('b/y#E', 'b/y#C2');
    const out = planClaim({
      modelKey: 'b/y',
      candidates: [intra],
      relations: [],
      judgements: [],
      settled: new Set(),
      partners: new Map([['b/y', claimed([pairKey(intra)])]]),
      partnerCandidates: () => new Set([pairKey(intra)]),
    });
    expect(out.assignment).toEqual([typed(intra)]);
  });

  it('assigns relations in neither list like systematic candidates, whatever their basis', () => {
    // C: a relation on a compatible pair; R: a relation that is no candidate (beyond the caps).
    const C = candidate('b/y#E', 'c/z#C2', 'message', 'compatible');
    const D = candidate('b/y#E', 'a/x#C2', 'message', 'compatible');
    const R = { type: 'message' as const, from: 'a/x#R' as Ref, to: 'b/y#R' as Ref };
    const run = (
      partners: [string, PartnerTask][],
      extra: { judgements?: Judgement[]; settled?: string[] } = {},
    ) =>
      planClaim({
        modelKey: 'b/y',
        candidates: [C, D, P],
        relations: [R, typed(C)],
        judgements: extra.judgements ?? [],
        settled: new Set(extra.settled ?? []),
        partners: new Map(partners),
        partnerCandidates: () => new Set([P, C].map(pairKey).concat(pairKey(R))),
      });
    // Candidates first (C counts as assigned, D stays the search space), then the other relations.
    expect(run([])).toEqual({ judged: [], skip: [], assignment: [typed(C), typed(P), R] });
    // Rule 1: a live claimed partner holds the relation pair.
    expect(run([['a/x', claimed([pairKey(R)])]])).toEqual({
      judged: [],
      skip: [{ ...R, model: 'a/x', reason: 'claimed' }],
      assignment: [typed(C), typed(P)],
    });
    // Rule 2: a queued partner that sorts first judges it at its own claim.
    expect(run([['a/x', queued]]).skip).toEqual([{ ...R, model: 'a/x', reason: 'queued' }]);
    // A current judgement or a settling decision: nobody's pair.
    const verdict = judgement({ from: R.from, to: R.to });
    expect(run([], { judgements: [verdict] }).assignment).toEqual([typed(C), typed(P)]);
    expect(run([], { settled: [pairKey(C)] }).assignment).toEqual([typed(P), R]);
  });

  it('assigns a relation unless it is manual, obsolete, settled or has a missing end', () => {
    const relation = (extra: Partial<RelationRecord>) =>
      ({
        type: 'message',
        status: 'proposed',
        endpointState: 'ok',
        ...extra,
      }) as RelationRecord;
    for (const r of [
      relation({}),
      relation({ status: 'held' }),
      relation({ status: 'rejected', endpointState: 'changed' }),
      relation({ status: 'proposed', endpointState: 'changed' }),
    ]) {
      expect(isAssignedRelation(r), JSON.stringify(r)).toBe(true);
    }
    for (const r of [
      relation({ type: 'manual' }),
      relation({ status: 'obsolete' }),
      relation({ status: 'accepted' }),
      relation({ status: 'rejected' }),
      relation({ endpointState: 'missing' }),
    ]) {
      expect(isAssignedRelation(r), JSON.stringify(r)).toBe(false);
    }
  });

  function typed(c: Candidate) {
    return { type: c.type, from: c.from, to: c.to };
  }
});

describe('validateNoLink', () => {
  /** An assessor for a/x#E → b/y#C: message and (for a/x#M → b/y#M) message and signal. */
  const assess = ({ type, from, to }: PairQuery): PairAssessment => {
    const known = ['a/x#E', 'a/x#M', 'a/x#S', 'b/y#C', 'b/y#M', 'b/y#T'];
    if (!known.includes(from) || !known.includes(to)) return { ok: false, reason: 'unknown-ref' };
    if (from === 'a/x#E' && to === 'b/y#C' && type === 'message') {
      return { ok: true, tier: 'lexical', score: 0.5, signals: {} };
    }
    if (from === 'a/x#M' && to === 'b/y#M' && (type === 'message' || type === 'signal')) {
      return { ok: true, tier: 'key', score: 1, signals: {} };
    }
    if (from === 'a/x#S' && to === 'b/y#T' && type === 'trigger') {
      return { ok: false, reason: 'same-process' };
    }
    return { ok: false, reason: 'type-mismatch' };
  };
  const check = (item: { type?: string; from: string; to: string; reason?: string }) => {
    const v = validateNoLink({ reason: 'x', ...item }, assess, 'a/x');
    return v.ok ? v.value.type : v.reason;
  };

  it('checks in order and takes the one type the endpoints fit', () => {
    expect(check({ type: 'manual', from: 'nope', to: 'b/y#C' })).toBe('type-not-allowed');
    expect(check({ from: 'nope', to: 'b/y#C', reason: '\u0000' })).toBe('malformed-ref');
    expect(check({ from: 'c/z#E', to: 'b/y#C', reason: '\u0000' })).toBe('control-characters');
    expect(check({ from: 'c/z#E', to: 'b/y#C' })).toBe('outside-task-model');
    expect(check({ from: 'a/x#Nope', to: 'b/y#C' })).toBe('unknown-ref');
    expect(check({ type: 'signal', from: 'a/x#E', to: 'b/y#C' })).toBe('type-mismatch');
    expect(check({ type: 'message', from: 'a/x#E', to: 'b/y#C' })).toBe('message');
    expect(check({ from: 'a/x#E', to: 'b/y#C' })).toBe('message');
    expect(check({ from: 'a/x#M', to: 'b/y#M' })).toBe('type-required');
    expect(check({ type: 'signal', from: 'a/x#M', to: 'b/y#M' })).toBe('signal');
    // No type fits: a type whose endpoint roles fit names the reason.
    expect(check({ from: 'a/x#S', to: 'b/y#T' })).toBe('same-process');
    expect(check({ from: 'a/x#E', to: 'b/y#T' })).toBe('type-mismatch');
  });

  it('knows every reason it answers', () => {
    expect(NO_LINK_INVALID_REASONS).toContain('also-proposed');
    expect(NO_LINK_INVALID_REASONS.indexOf('type-not-allowed')).toBe(0);
  });
});

describe('judged and skip in the claim input', () => {
  const projectFacts: ProjectFacts = { models: [] };
  const base = {
    model: {
      key: 'b/y',
      name: null,
      revisionId: 'rev_01J9Z3N4X5Q6R7S8T9V0W1X2Y3' as const,
      rev: 1,
      engine: null,
      processes: [],
    },
    projectFacts,
    candidates: [],
    relations: [],
    histories: new Map(),
    findings: [],
  };
  const j = (x: Partial<Judgement>): Judgement => ({
    kind: 'no-link',
    id: 'nlk_1',
    relationId: null,
    type: 'message',
    from: 'b/y#E',
    to: 'c/z#C',
    origin: 'c/z',
    principalId: YOU,
    handle: 'agent:you',
    reason: null,
    fromHash: null,
    toHash: null,
    procedure: V1,
    current: true,
    ...x,
  });

  it('renders link verdicts by relation, no-links with their pair and a cut reason, sorted', () => {
    const input = renderClaimInput({
      ...base,
      claimant: ME,
      judged: [
        j({ id: 'nlk_2', from: 'b/y#F', reason: `no-evidence: ${'x'.repeat(200)}` }),
        j({
          kind: 'link',
          id: 'asr_1',
          relationId: 'rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
          origin: 'b/y',
          principalId: ME,
          handle: 'agent:me',
        }),
      ],
      skip: [{ type: 'trigger', from: 'b/y#End', to: 'c/z#Start', model: 'c/z', reason: 'queued' }],
    });
    const reason = input.judged?.[1] && 'reason' in input.judged[1] ? input.judged[1].reason : '';
    expect(reason).toHaveLength(120);
    expect(reason.endsWith('…')).toBe(true);
    expect(input.judged).toEqual([
      { relation: 'rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3', origin: 'b/y', by: 'agent:me', mine: true },
      { type: 'message', from: 'b/y#F', to: 'c/z#C', origin: 'c/z', by: 'agent:you', reason },
    ]);
    expect(input.skip).toEqual([
      { type: 'trigger', from: 'b/y#End', to: 'c/z#Start', model: 'c/z', reason: 'queued' },
    ]);
    expect(ClaimInput.parse(input)).toEqual(input);
    // Both lists sit between relations and findings and are left out when empty.
    expect(Object.keys(input)).toEqual([
      'format',
      'model',
      'facts',
      'candidates',
      'partners',
      'relations',
      'judged',
      'skip',
    ]);
    const bare = renderClaimInput(base);
    expect(bare).not.toHaveProperty('judged');
    expect(bare).not.toHaveProperty('skip');
  });
});
