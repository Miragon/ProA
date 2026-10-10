import { z } from 'zod';

import { Ref } from './refs.ts';

/**
 * Deterministic findings (CONCEPT §2, eval/README.md):
 * - `unresolved-call`: static `calledElement` matching no process id;
 * - `dynamic-call`: `calledElement` is an expression;
 * - `duplicate-process-id`: the same process id in two or more models (all refs in one finding);
 * - `dangling-throw`: a message or signal throw nobody catches;
 * - `unmatched-catch`: a message or signal catch nobody throws.
 */
export const FindingKind = z
  .enum([
    'unresolved-call',
    'dynamic-call',
    'duplicate-process-id',
    'dangling-throw',
    'unmatched-catch',
  ])
  .meta({ id: 'FindingKind', description: 'Kind of a deterministic finding.' });
export type FindingKind = z.infer<typeof FindingKind>;

export const Finding = z
  .object({
    kind: FindingKind,
    /** Affected elements, sorted; one finding per call, per duplicated process id, per throw or catch. */
    refs: z.array(Ref).min(1),
    /** Human-readable explanation. */
    detail: z.string(),
  })
  .meta({ id: 'Finding', description: 'A deterministic finding about the landscape.' });
export type Finding = z.infer<typeof Finding>;
