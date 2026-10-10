/**
 * Seeded random relation histories for the status properties (M4 S1): the
 * golden digest that pins relation behaviour across the generalisation of
 * `status.ts` over a subject, and the relation ↔ placement equivalence. The
 * generator covers what `status.ts` distinguishes: rule, human and agent
 * principals (two humans, two agents), every assertion kind, verdicts,
 * tiers, confidences, null fingerprints, and pipeline proposals with a
 * basis (submission, endpoint hashes, declared procedure). Changing it
 * changes the digest: only do so together with a new digest computed on
 * code whose relation behaviour is known to be unchanged.
 */
import type { DeclaredProcedure, PrincipalId, Tier } from '@proa/contracts';

import type { ClassifiedAssertion, NewProposal } from '../../src/domain/status.ts';

export const RULE = 'prn_0000000000000000000000RULE' as PrincipalId;
export const HUMAN = 'prn_000000000000000000000HUMAN' as PrincipalId;
export const HUMAN2 = 'prn_00000000000000000000HUMAN2' as PrincipalId;
export const AGENT = 'prn_000000000000000000000AGENT' as PrincipalId;
export const OTHER = 'prn_000000000000000000000OTHER' as PrincipalId;

const V1: DeclaredProcedure = { id: 'proa-relations', version: '0.2.0' };
const V2: DeclaredProcedure = { id: 'proa-relations', version: '0.3.0' };

/** Mulberry32: a small seeded PRNG, so failures reproduce. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: () => number, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)] as T;

const FROM_FPS = ['f1', 'f2', 'f1', 'f2', null] as const;
const TO_FPS = ['t1', 't2', 't1', 't2', null] as const;
const HASHES = ['h1', 'h2'] as const;
const PROPOSAL_TIERS = ['key', 'lexical', 'semantic'] as const satisfies readonly Tier[];
const CONFIDENCES = [0.2, 0.5, 1] as const;

/** A relation assertion as `classifyProposal` reads it, all optional basis fields set. */
export type RelationCaseAssertion = ClassifiedAssertion & {
  submissionId: string | null;
  fromHash: string | null;
  toHash: string | null;
  declared: { procedure: DeclaredProcedure | null } | null;
};

export interface RelationCase {
  history: RelationCaseAssertion[];
  /** Proposals to classify against the history (some repeat a live proposal exactly). */
  proposals: NewProposal[];
  /** Head fingerprints of both endpoints (`undefined`: not in the head). */
  currents: { from: string | undefined; to: string | undefined }[];
  /** A human hold appended to the history, to classify the proposals against as well. */
  hold: RelationCaseAssertion;
}

function randomAssertion(r: () => number, seq: number): RelationCaseAssertion {
  const principalId = pick(r, [RULE, HUMAN, HUMAN2, AGENT, OTHER] as const);
  const human = principalId === HUMAN || principalId === HUMAN2;
  const kinds = human
    ? (['decision', 'note', 'proposal', 'withdrawal'] as const)
    : principalId === RULE
      ? (['decision', 'proposal', 'withdrawal'] as const)
      : (['proposal', 'withdrawal'] as const);
  const kind = pick(r, kinds);
  const sourceKind = principalId === RULE ? 'rule' : human ? 'human' : 'agent';
  let tier: Tier | null = null;
  let confidence: number | null = null;
  if (kind === 'proposal') {
    tier = pick(r, PROPOSAL_TIERS);
    confidence = pick(r, CONFIDENCES);
  } else if (kind === 'decision' && principalId === RULE && r() < 0.7) {
    tier = 'rule';
    confidence = 1;
  } else if (kind === 'decision' && human && r() < 0.3) {
    tier = 'manual';
    confidence = pick(r, [null, 0.9]);
  }
  const pipeline = kind === 'proposal' && sourceKind === 'agent' && r() < 0.5;
  return {
    seq,
    kind,
    verdict: kind === 'decision' ? pick(r, ['accept', 'reject', 'hold'] as const) : null,
    sourceKind,
    principalId,
    tier,
    confidence,
    fromFp: pick(r, FROM_FPS),
    toFp: pick(r, TO_FPS),
    rationale: pick(r, ['r', 'q', null]),
    question: pick(r, [null, null, 'q?']),
    submissionId: pipeline ? pick(r, ['sbm_1', 'sbm_2']) : null,
    fromHash: pipeline ? pick(r, HASHES) : null,
    toHash: pipeline ? pick(r, HASHES) : null,
    declared: pipeline
      ? { procedure: pick(r, [V1, V2, V1]) }
      : kind === 'proposal'
        ? pick(r, [null, { procedure: null }, { procedure: V1 }])
        : null,
  };
}

function randomProposal(r: () => number, history: readonly RelationCaseAssertion[]): NewProposal {
  const live = history.filter((a) => a.kind === 'proposal');
  const copy = live.length > 0 && r() < 0.35 ? pick(r, live) : undefined;
  if (copy && copy.tier !== null && copy.confidence !== null) {
    // The proposer's exact repeat: the duplicate paths.
    const procedure = copy.declared?.procedure ?? null;
    return {
      principalId: copy.principalId,
      tier: copy.tier,
      confidence: copy.confidence,
      rationale: copy.rationale ?? '',
      question: copy.question,
      fromFp: copy.fromFp,
      toFp: copy.toFp,
      ...(copy.fromHash !== null && copy.toHash !== null && procedure && r() < 0.8
        ? { basis: { fromHash: copy.fromHash, toHash: copy.toHash, procedure } }
        : {}),
    };
  }
  return {
    principalId: pick(r, [AGENT, OTHER, AGENT, HUMAN] as const),
    tier: pick(r, PROPOSAL_TIERS),
    confidence: pick(r, CONFIDENCES),
    rationale: pick(r, ['r', 'q']),
    question: pick(r, [null, 'q?']),
    fromFp: pick(r, FROM_FPS),
    toFp: pick(r, TO_FPS),
    ...(r() < 0.5
      ? {
          basis: {
            fromHash: pick(r, HASHES),
            toHash: pick(r, HASHES),
            procedure: pick(r, [V1, V2]),
          },
        }
      : {}),
  };
}

/** The `i`-th random relation case (deterministic: seed `i + 1`). */
export function relationCase(i: number): RelationCase {
  const r = rng(i + 1);
  const n = Math.floor(r() * 9);
  const history: RelationCaseAssertion[] = [];
  let seq = 0;
  for (let k = 0; k < n; k++) {
    seq += 1 + Math.floor(r() * 3);
    history.push(randomAssertion(r, seq));
  }
  // Any input order (the functions must not depend on it).
  const shuffled = history
    .map((a) => ({ a, key: r() }))
    .sort((x, y) => x.key - y.key)
    .map((x) => x.a);
  const proposals = Array.from({ length: 3 }, () => randomProposal(r, history));
  const currents = Array.from({ length: 2 }, () => ({
    from: pick(r, ['f1', 'f2', undefined]),
    to: pick(r, ['t1', 't2', undefined]),
  }));
  const hold: RelationCaseAssertion = {
    seq: seq + 1,
    kind: 'decision',
    verdict: 'hold',
    sourceKind: 'human',
    principalId: pick(r, [HUMAN, HUMAN2] as const),
    tier: null,
    confidence: null,
    fromFp: pick(r, FROM_FPS),
    toFp: pick(r, TO_FPS),
    rationale: 'n',
    question: null,
    submissionId: null,
    fromHash: null,
    toHash: null,
    declared: null,
  };
  return { history: shuffled, proposals, currents, hold };
}

/** Number of random cases the digest and the equivalence run over. */
export const CASES = 2000;
