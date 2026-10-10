import { z } from 'zod';

import { Ref } from './refs.ts';
import { RelationType } from './relations.ts';

/**
 * Why a pair is a candidate (CONCEPT §3, claim input): `rule` (unambiguous
 * call), `key` (identical message/signal name or call target), `lexical`
 * (top matches by label similarity), `compatible` (type-compatible endpoint
 * without lexical evidence, offered so agents can find semantic links).
 */
export const CandidateBasis = z
  .enum(['rule', 'key', 'lexical', 'compatible'])
  .meta({ id: 'CandidateBasis', description: 'Why a pair of endpoints is a candidate.' });
export type CandidateBasis = z.infer<typeof CandidateBasis>;

/** Similarity signals behind a candidate's score; absent signals were not computed. */
export const CandidateSignals = z
  .object({
    /** `keyNorm` of both endpoints is identical, ignoring word separators. */
    keyEqual: z.boolean(),
    /** Token Jaccard similarity of the normalized labels, stopwords removed (0–1). */
    jaccard: z.number().min(0).max(1),
    /** 1 − Levenshtein distance / length of the longer normalized label (0–1). */
    levenshtein: z.number().min(0).max(1),
    /** The event definitions of both endpoints are compatible for the relation type. */
    eventDefCompatible: z.boolean(),
  })
  .partial()
  .meta({ id: 'CandidateSignals', description: 'Similarity signals behind a candidate score.' });
export type CandidateSignals = z.infer<typeof CandidateSignals>;

/**
 * A candidate endpoint pair offered to agents (no LLM involved). Computed in
 * both directions around the focus model, so a change to one model never
 * re-queues the others.
 */
export const Candidate = z
  .object({
    type: RelationType.exclude(['manual']),
    from: Ref,
    to: Ref,
    basis: CandidateBasis,
    /** Ranking score in [0, 1]; 1.0 for `rule` and `key`. */
    score: z.number().min(0).max(1),
    signals: CandidateSignals,
  })
  .meta({ id: 'Candidate', description: 'A candidate relation for agents to judge.' });
export type Candidate = z.infer<typeof Candidate>;
