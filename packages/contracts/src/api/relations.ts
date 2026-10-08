import { z } from 'zod';

import { Finding } from '../findings.ts';
import { AssertionId, NoLinkId, PrincipalId, RelationId, SubmissionId } from '../ids.ts';
import { ModelKey, Ref } from '../refs.ts';
import {
  AssertionKind,
  DeclaredProcedure,
  EndpointState,
  RelationStatus,
  RelationType,
  SourceKind,
  Tier,
  Verdict,
} from '../relations.ts';
import { orNull } from '../zod-utils.ts';
import { Cursor, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, Timestamp, pageOf } from './common.ts';

/**
 * Where a relation's current status comes from: the assertion it rests on
 * (the deciding decision, the reopening or latest live proposal, or for an
 * obsolete relation its latest assertion). `sourceKind` and the principal
 * come from the credential; procedure and LLM model are only declared by
 * the agent (CONCEPT §6).
 */
export const RelationProvenance = z
  .object({
    assertionId: AssertionId,
    kind: AssertionKind,
    verdict: orNull(Verdict),
    sourceKind: SourceKind,
    principalId: PrincipalId,
    /** Pseudonymous handle, e.g. `owner`, `agent:claude code`, `proa-rules`. */
    handle: z.string(),
    /** Client of the credential: `proa-web`, `proa-cli`, `agt_…`; `null` for the rule tier. */
    clientId: z.string().nullable(),
    /** Declared procedure; the rule tier records `proa-rules` `1.0.0`. */
    procedure: orNull(DeclaredProcedure),
    /** Declared LLM model, e.g. `claude-sonnet-5-5`. */
    llmModel: z.string().nullable(),
    tier: orNull(Tier),
    confidence: z.number().min(0).max(1).nullable(),
    /** Agent rationale, rejection reason or hold note. */
    rationale: z.string().nullable(),
    /** An agent's question for the reviewer, or the question of a hold. */
    question: z.string().nullable(),
    /** Label of a hold, e.g. "mit Fachbereich Finanzen klären". */
    label: z.string().nullable(),
    at: Timestamp,
  })
  .meta({ id: 'RelationProvenance', description: 'The assertion a relation status rests on.' });
export type RelationProvenance = z.infer<typeof RelationProvenance>;

/**
 * A live, current no-link of an agent on a relation's typed pair (CONCEPT §3
 * "judge each pair once"): an objection the reviewer sees next to the
 * proposals. Current: judged on the head versions of both models under the
 * procedure claims name now.
 */
export const RelationNoLink = z
  .object({
    id: NoLinkId,
    /** Pseudonymous handle of the judging principal, e.g. `agent:claude code`. */
    handle: z.string(),
    /** The model whose analysis stored it. */
    origin: ModelKey,
    /** As the agent wrote it, `<code>: <sentence>`. */
    reason: z.string(),
    at: Timestamp,
  })
  .meta({ id: 'RelationNoLink', description: 'An agent judgement that the pair is unrelated.' });
export type RelationNoLink = z.infer<typeof RelationNoLink>;

/** A relation between two processes with its review state (CONCEPT §2). */
export const Relation = z
  .object({
    id: RelationId,
    type: RelationType,
    from: Ref,
    to: Ref,
    status: RelationStatus,
    endpointState: EndpointState,
    /** Tier of the strongest live assertion. */
    tier: Tier,
    /** Confidence of the strongest live assertion, 0–1. */
    confidence: z.number().min(0).max(1).nullable(),
    /** Optimistic-concurrency version; bulk decisions send it back. */
    version: z.number().int().min(1),
    /** E.g. call binding attributes. */
    attrs: z.record(z.string(), z.unknown()),
    /** Who the current status rests on: `rule`, `agent` or `human` (= `provenance.sourceKind`). */
    source: orNull(SourceKind),
    provenance: orNull(RelationProvenance),
    /** Live, current agent no-links on the same `(type, from, to)`, oldest first. */
    noLinks: z.array(RelationNoLink),
    updatedAt: Timestamp,
  })
  .meta({ id: 'Relation', description: 'A relation between two processes.' });
export type Relation = z.infer<typeof Relation>;

export const RelationPage = pageOf(Relation, 'RelationPage');
export type RelationPage = z.infer<typeof RelationPage>;

/** Query parameters of `GET …/relations`. Obsolete relations are only returned when asked for. */
export const RelationQuery = z.object({
  type: RelationType.optional(),
  status: RelationStatus.optional(),
  tier: Tier.optional(),
  /** Only relations with an endpoint in this model. */
  modelKey: ModelKey.optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type RelationQuery = z.infer<typeof RelationQuery>;

export const FindingList = z
  .object({ items: z.array(Finding) })
  .meta({ id: 'FindingList', description: 'Deterministic findings of the project head.' });
export type FindingList = z.infer<typeof FindingList>;

/**
 * One entry of a relation's history (timeline), oldest first. Assertions
 * are append-only; the status is a pure function of them (CONCEPT §2).
 */
export const RelationAssertion = z
  .object({
    id: AssertionId,
    /** Event sequence number that recorded the assertion. */
    seq: z.number().int().min(1),
    kind: AssertionKind,
    verdict: orNull(Verdict),
    sourceKind: SourceKind,
    principalId: PrincipalId,
    handle: z.string(),
    clientId: z.string().nullable(),
    procedure: orNull(DeclaredProcedure),
    llmModel: z.string().nullable(),
    /** Stored submission the assertion came from (pipeline proposals and their supersession). */
    submissionId: orNull(SubmissionId),
    tier: orNull(Tier),
    confidence: z.number().min(0).max(1).nullable(),
    /** Agent rationale, rejection reason, hold or accept note, or the text of a note. */
    rationale: z.string().nullable(),
    /** Refs or short texts the agent cites. */
    evidence: z.array(z.string()),
    question: z.string().nullable(),
    label: z.string().nullable(),
    /** `correct`: the manual relation accepted instead (on the rejection) or the corrected proposal (on the acceptance). */
    linkedRelationId: orNull(RelationId),
    /** Endpoint fingerprints when the assertion was made. */
    fromFp: z.string().nullable(),
    toFp: z.string().nullable(),
    at: Timestamp,
  })
  .meta({ id: 'RelationAssertion', description: 'One assertion of a relation history.' });
export type RelationAssertion = z.infer<typeof RelationAssertion>;

export const RelationAssertionList = z
  .object({ items: z.array(RelationAssertion) })
  .meta({ id: 'RelationAssertionList', description: 'The history of a relation, oldest first.' });
export type RelationAssertionList = z.infer<typeof RelationAssertionList>;
