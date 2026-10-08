import { z } from 'zod';

import { RelationId } from '../ids.ts';
import { Ref } from '../refs.ts';
import { DeclaredProcedure, RelationType, Tier } from '../relations.ts';
import {
  MAX_EVIDENCE_ITEMS,
  MAX_QUESTION_CHARS,
  MAX_RATIONALE_CHARS,
  ProposalOutcome,
} from './analyses.ts';
import { orNull, plainName, plainText } from '../zod-utils.ts';
import { Relation } from './relations.ts';

/** Reasons and notes of decisions, and notes (answers), in characters. */
export const MAX_NOTE_CHARS = 2000;
/** Label of a hold, e.g. "mit Fachbereich Finanzen klären". */
export const MAX_LABEL_CHARS = 100;
/** Relations per bulk decision. */
export const MAX_BULK_DECISIONS = 500;

/**
 * Path of the review screen of a project, or of one relation in it, in the
 * web UI. `human-decision-required` problems carry it as `reviewUrl`
 * (absolute, on the server's origin).
 */
export function reviewPath(projectKey: string, relationId?: string): string {
  const base = `/projects/${encodeURIComponent(projectKey)}/review`;
  return relationId === undefined ? base : `${base}/${encodeURIComponent(relationId)}`;
}

const note = (required: boolean) =>
  plainText(
    required ? z.string().trim().min(1).max(MAX_NOTE_CHARS) : z.string().max(MAX_NOTE_CHARS),
  );
const question = () => plainText(z.string().trim().min(1).max(MAX_QUESTION_CHARS));
const label = () => plainText(z.string().trim().min(1).max(MAX_LABEL_CHARS));
/** Optimistic concurrency: the decision fails with 409 `conflict` if the relation has another version. */
const version = z.number().int().min(1).optional();

/**
 * A human decision (CONCEPT §3 "Review workflow"), owner on an interactive
 * client only; agents get 403 `human-decision-required`:
 * - `accept` (optional note);
 * - `reject` with a reason, which agents see in their next claim;
 * - `hold` ("vormerken") with a note and an optional question and label;
 *   the relation becomes `held`, an open item outside the review inbox;
 * - `correct`: accept a different pair as a `manual` relation linked to
 *   this one, which is rejected with the note as reason.
 */
export const DecisionBody = z
  .discriminatedUnion('verdict', [
    z.object({ verdict: z.literal('accept'), note: note(false).optional(), version }),
    z.object({ verdict: z.literal('reject'), reason: note(true), version }),
    z.object({
      verdict: z.literal('hold'),
      note: note(true),
      question: question().optional(),
      label: label().optional(),
      version,
    }),
    z.object({
      verdict: z.literal('correct'),
      /** The pair to accept instead (at least one end differs). */
      from: Ref,
      to: Ref,
      /** Why: the rationale of the manual relation and the reason of the rejection. */
      note: note(true),
      version,
    }),
  ])
  .meta({ id: 'DecisionBody', description: 'A human decision on one relation.' });
export type DecisionBody = z.infer<typeof DecisionBody>;

export const DecisionResult = z
  .object({
    relation: Relation,
    /** `correct`: the accepted manual relation. */
    corrected: z.union([Relation, z.null()]),
  })
  .meta({ id: 'DecisionResult', description: 'The decided relation (and its correction).' });
export type DecisionResult = z.infer<typeof DecisionResult>;

/**
 * A bulk decision, e.g. accepting the key tier after a brief check
 * (CONCEPT §3): the ids and versions the reviewer saw and how many they
 * were. Any mismatch (count, version, tier, an unknown or obsolete
 * relation) fails the whole request with 409 `conflict` and changes nothing.
 */
export const BulkDecisionBody = z
  .object({
    verdict: z.enum(['accept', 'reject', 'hold']),
    /** Rejection reason (required for `reject`). */
    reason: note(true).optional(),
    /** Hold note (required for `hold`) or accept note. */
    note: note(true).optional(),
    question: question().optional(),
    label: label().optional(),
    /** Every relation must have this tier. */
    tier: Tier.optional(),
    items: z
      .array(z.object({ id: RelationId, version: z.number().int().min(1) }))
      .min(1)
      .max(MAX_BULK_DECISIONS),
    expectedCount: z.number().int().min(1).max(MAX_BULK_DECISIONS),
  })
  .superRefine((b, ctx) => {
    if (b.verdict === 'reject' && b.reason === undefined) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'reject needs a reason' });
    }
    if (b.verdict === 'hold' && b.note === undefined) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'hold needs a note' });
    }
    if (b.verdict !== 'hold' && (b.question !== undefined || b.label !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['question'],
        message: 'only a hold has a question or label',
      });
    }
  })
  .meta({ id: 'BulkDecisionBody', description: 'One verdict for many relations.' });
export type BulkDecisionBody = z.infer<typeof BulkDecisionBody>;

export const BulkDecisionResult = z
  .object({ items: z.array(Relation) })
  .meta({ id: 'BulkDecisionResult', description: 'The decided relations.' });
export type BulkDecisionResult = z.infer<typeof BulkDecisionResult>;

/** A note on a relation, e.g. the answer to a held question; it reaches the next agent run. */
export const NoteBody = z
  .object({ text: note(true) })
  .meta({ id: 'NoteBody', description: 'A note on a relation.' });
export type NoteBody = z.infer<typeof NoteBody>;

/**
 * An ad-hoc proposal (`propose_relation`), outside the pipeline: it is never
 * superseded by a submission. Agents propose `call`, `message`, `signal` and
 * `trigger`; `manual` relations (any → any) are for humans only, need a
 * rationale and are accepted at once.
 */
export const ProposeRelationBody = z
  .object({
    type: RelationType,
    from: Ref,
    to: Ref,
    confidence: z.number().min(0).max(1),
    rationale: plainText(z.string().max(MAX_RATIONALE_CHARS)),
    evidence: z
      .array(plainText(z.string().max(1000)))
      .max(MAX_EVIDENCE_ITEMS)
      .default([]),
    question: plainText(z.string().max(MAX_QUESTION_CHARS)).nullable().default(null),
    procedure: orNull(DeclaredProcedure).default(null),
    llmModel: plainName(100).nullable().default(null),
  })
  .meta({ id: 'ProposeRelationBody', description: 'An ad-hoc relation proposal.' });
export type ProposeRelationBody = z.infer<typeof ProposeRelationBody>;
export type ProposeRelationInput = z.input<typeof ProposeRelationBody>;

export const ProposeRelationResult = z
  .object({
    /** `applied`, `duplicate`, `suppressed` or `reopened` (invalid proposals are 422). */
    result: ProposalOutcome,
    relation: Relation,
  })
  .meta({ id: 'ProposeRelationResult', description: 'Outcome of an ad-hoc proposal.' });
export type ProposeRelationResult = z.infer<typeof ProposeRelationResult>;
