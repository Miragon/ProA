/**
 * Limits and enums shared by the pipeline (`analyses.ts`), the review
 * (`review.ts`) and the value chain (`placements.ts`) contracts. A leaf
 * module, so those three can import each other's schemas in one direction
 * only (`analyses.ts` → `placements.ts` → here); `analyses.ts` and `review.ts`
 * re-export these names, which keeps every name exported once from the
 * package entry.
 */
import { z } from 'zod';

/** Per-item limits; an item above them comes back as `invalid:<reason>`. */
export const MAX_RATIONALE_CHARS = 1000;
export const MAX_QUESTION_CHARS = 500;
export const MAX_EVIDENCE_ITEMS = 20;

/** Reasons and notes of decisions, and notes (answers), in characters. */
export const MAX_NOTE_CHARS = 2000;
/** Label of a hold, e.g. "mit Fachbereich Finanzen klären". */
export const MAX_LABEL_CHARS = 100;
/** Relations per bulk decision. */
export const MAX_BULK_DECISIONS = 500;

/** State of an analysis task (CONCEPT §3). */
export const AnalysisTaskState = z
  .enum(['queued', 'claimed', 'done', 'failed', 'cancelled'])
  .meta({ id: 'AnalysisTaskState', description: 'State of an analysis task.' });
export type AnalysisTaskState = z.infer<typeof AnalysisTaskState>;

/**
 * Kind of an analysis task (M4 §3.2): `relations` (subject: a model revision,
 * procedure `proa-relations`) or `placement` (subject: the value chain,
 * procedure `proa-placements`).
 */
export const AnalysisKind = z
  .enum(['relations', 'placement'])
  .meta({ id: 'AnalysisKind', description: 'Kind of an analysis task.' });
export type AnalysisKind = z.infer<typeof AnalysisKind>;
