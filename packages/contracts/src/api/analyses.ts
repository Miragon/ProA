import { z } from 'zod';

import { CandidateBasis } from '../candidates.ts';
import { EventDef, FactKind, FactScope } from '../facts.ts';
import { Finding } from '../findings.ts';
import {
  AnalysisTaskId,
  ModelId,
  PrincipalId,
  ProjectId,
  RelationId,
  RevisionId,
  SubmissionId,
} from '../ids.ts';
import { ElementId, ModelKey, Ref } from '../refs.ts';
import {
  DeclaredProcedure,
  EndpointState,
  RelationStatus,
  RelationType,
  SourceKind,
  Tier,
  Verdict,
} from '../relations.ts';
import { orNull, plainName, plainText } from '../zod-utils.ts';
import {
  Cursor,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  ProjectRef,
  Sha256Hex,
  Timestamp,
  pageOf,
} from './common.ts';
import { Engine } from './models.ts';
import { ProjectKey } from './projects.ts';

// ------------------------------------------------------------------ limits

/** Lease of a claimed task (CONCEPT §3): 15 minutes, no renewal. */
export const LEASE_MINUTES = 15;
/** At most this many tasks per claim. */
export const MAX_CLAIM = 5;
/**
 * A task whose lease expired this many times becomes `failed` (in the claim
 * transaction that notices it). A release gives its attempt back.
 */
export const MAX_ATTEMPTS = 3;
/** Every lease token starts with this prefix (secret scanners), then 43 base64url characters (256 bits). */
export const LEASE_TOKEN_PREFIX = 'proa_lt_';
/**
 * A lease token as the server issues it. A plain `pattern`: zod's
 * `startsWith` becomes the non-standard JSON Schema `format: "starts_with"`,
 * which every MCP SDK client warns about when it compiles the output schema.
 */
export const LEASE_TOKEN_PATTERN = new RegExp(`^${LEASE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);
/** Relations per submission (whole submission rejected with 422 above it). */
export const MAX_SUBMISSION_RELATIONS = 200;
/** `noLinks` entries per submission. */
export const MAX_SUBMISSION_NO_LINKS = 500;
/** Per-item limits; an item above them comes back as `invalid:<reason>`. */
export const MAX_RATIONALE_CHARS = 1000;
export const MAX_QUESTION_CHARS = 500;
export const MAX_EVIDENCE_ITEMS = 20;
export const MAX_SUMMARY_CHARS = 500;
/** Characters of a no-link `reason` (whole submission rejected with 422 above it). */
export const MAX_NO_LINK_REASON_CHARS = 2000;
/** Body limit of a submission (REST and MCP). */
export const MAX_SUBMISSION_BYTES = 1024 * 1024;
/** `GET /analyses/pending?wait=` upper bound in seconds. */
export const MAX_WAIT_SECONDS = 30;
/**
 * Documentation in the claim input (facts, partner endpoints, partner
 * processes) is cut to this many characters.
 */
export const CLAIM_DOC_CHARS = 300;
/** Format id of {@link ClaimInput}. */
export const CLAIM_INPUT_FORMAT = 'proa-claim/1';
/** No-link reasons in the claim input's `judged` are cut to this many characters. */
export const CLAIM_REASON_CHARS = 120;
/** `uncovered.pairs` of a submission result lists at most this many pairs. */
export const MAX_UNCOVERED_PAIRS = 50;

/** Structural caps of submission items; the documented limits above are checked per item. */
const LOOSE_TEXT = 20_000;
const LOOSE_REF = 1000;

// ------------------------------------------------------------------- tasks

/** State of an analysis task (CONCEPT §3). */
export const AnalysisTaskState = z
  .enum(['queued', 'claimed', 'done', 'failed', 'cancelled'])
  .meta({ id: 'AnalysisTaskState', description: 'State of an analysis task.' });
export type AnalysisTaskState = z.infer<typeof AnalysisTaskState>;

export const AnalysisTask = z
  .object({
    id: AnalysisTaskId,
    projectId: ProjectId,
    modelId: ModelId,
    modelKey: ModelKey,
    /** The revision whose facts the task analyses. */
    revisionId: RevisionId,
    kind: z.literal('relations'),
    state: AnalysisTaskState,
    /** Claims that did not end in a release (lost leases plus the current one). */
    attempts: z.number().int().min(0),
    factsHash: Sha256Hex,
    /** End of the current or last lease. */
    leaseUntil: orNull(Timestamp),
    /** Handle of the principal holding (or last holding) the lease. */
    claimedBy: z.string().nullable(),
    /** Why the task failed, was cancelled or released. */
    lastError: z.string().nullable(),
    /** Client-chosen id of the stored submission, once done. */
    submissionId: z.string().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'AnalysisTask', description: 'An analysis task of one model revision.' });
export type AnalysisTask = z.infer<typeof AnalysisTask>;

export const AnalysisTaskPage = pageOf(AnalysisTask, 'AnalysisTaskPage');
export type AnalysisTaskPage = z.infer<typeof AnalysisTaskPage>;

/** Query of `GET …/analyses`: newest first. */
export const AnalysisQuery = z.object({
  state: AnalysisTaskState.optional(),
  modelKey: ModelKey.optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type AnalysisQuery = z.infer<typeof AnalysisQuery>;

// ------------------------------------------------------------------- claim

export const ClaimAnalysisBody = z
  .object({
    /** Only this project (id or key); default: every project where the caller may propose. */
    projectId: ProjectRef.optional(),
    /** Only this model. */
    modelKey: ModelKey.optional(),
    max: z.number().int().min(1).max(MAX_CLAIM).default(1),
  })
  .meta({ id: 'ClaimAnalysisBody', description: 'Request body to claim analysis tasks.' });
export type ClaimAnalysisBody = z.infer<typeof ClaimAnalysisBody>;

/**
 * A fact of the claimed model in the claim input. Empty or default fields
 * are left out to keep the input small: `eventDef` for non-events, `key`
 * when it equals the label, `scope` when it is `process`, `process` for
 * collaboration-level facts, `from` and `to` on anything but message flows,
 * `doc` without documentation.
 */
export const ClaimFact = z
  .object({
    ref: Ref,
    kind: FactKind,
    eventDef: EventDef.optional(),
    label: z.string(),
    /** Matching key as found in the model: message or signal name, `calledElement`, process id. */
    key: z.string().optional(),
    scope: FactScope.optional(),
    /** Id of the owning process. */
    process: ElementId.optional(),
    /**
     * `message_flow`: ref of the source, an element or a participant (pool)
     * of the same file. A message flow already connects the two ends inside
     * the collaboration; it is never a relation.
     */
    from: Ref.optional(),
    /** `message_flow`: ref of the target, an element or a participant (pool). */
    to: Ref.optional(),
    /** `bpmn:documentation`, at most {@link CLAIM_DOC_CHARS} characters. */
    doc: z.string().optional(),
  })
  .meta({ id: 'ClaimFact', description: 'A fact of the claimed model (compact).' });
export type ClaimFact = z.infer<typeof ClaimFact>;

/** An endpoint in another model that a candidate or relation names (compact, like {@link ClaimFact}). */
export const ClaimEndpoint = z
  .object({
    kind: FactKind,
    eventDef: EventDef.optional(),
    label: z.string(),
    key: z.string().optional(),
    scope: FactScope.optional(),
    /** Ref of the owning process, `<modelKey>#<processId>` (described in `partnerProcesses`). */
    process: Ref,
    /** Process name, else the participant (pool) name. */
    processName: z.string().optional(),
    /** `bpmn:documentation` of the element, at most {@link CLAIM_DOC_CHARS} characters. */
    doc: z.string().optional(),
  })
  .meta({ id: 'ClaimEndpoint', description: 'An endpoint in another model (compact).' });
export type ClaimEndpoint = z.infer<typeof ClaimEndpoint>;

/** A process of another model that a partner endpoint belongs to; empty fields are left out. */
export const ClaimPartnerProcess = z
  .object({
    /** Process name, else the participant (pool) name. */
    name: z.string().optional(),
    /** `bpmn:documentation` of the process, at most {@link CLAIM_DOC_CHARS} characters. */
    doc: z.string().optional(),
  })
  .meta({ id: 'ClaimPartnerProcess', description: 'A process of another model (compact).' });
export type ClaimPartnerProcess = z.infer<typeof ClaimPartnerProcess>;

/**
 * A candidate pair as a tuple `[type, from, to, basis, score]` (the most
 * numerous entry of the input, hence no field names): `basis` `rule` or
 * `key` (identical call target, message or signal name; score = rule
 * confidence), `lexical` (top label matches) or `compatible` (further
 * type-compatible endpoints, for semantic links lexical similarity misses);
 * `score` in [0, 1], 4 decimals.
 */
export const ClaimCandidate = z
  .tuple([RelationType.exclude(['manual']), Ref, Ref, CandidateBasis, z.number().min(0).max(1)])
  .meta({ id: 'ClaimCandidate', description: '[type, from, to, basis, score]' });
export type ClaimCandidate = z.infer<typeof ClaimCandidate>;

/** The current human decision of a relation in the claim input. */
export const ClaimDecision = z
  .object({
    verdict: Verdict,
    /** Rejection reason, hold or accept note. */
    note: z.string().optional(),
    question: z.string().optional(),
    label: z.string().optional(),
    at: Timestamp,
  })
  .meta({ id: 'ClaimDecision', description: 'A human decision (compact).' });
export type ClaimDecision = z.infer<typeof ClaimDecision>;

/**
 * An existing relation touching the model, rejections and held items
 * included, so agents do not propose them again and can see what reviewers
 * asked and answered.
 */
export const ClaimRelation = z
  .object({
    id: RelationId,
    type: RelationType,
    from: Ref,
    to: Ref,
    status: RelationStatus,
    tier: Tier,
    confidence: z.number().min(0).max(1).nullable(),
    source: orNull(SourceKind),
    endpointState: EndpointState,
    /** The latest human decision (rejection reason, hold note and question). */
    decision: ClaimDecision.optional(),
    /** An agent's open question to the reviewer. */
    question: z.string().optional(),
    /** Human notes, e.g. answers to held questions, oldest first. */
    notes: z.array(z.object({ text: z.string(), at: Timestamp })).optional(),
  })
  .meta({ id: 'ClaimRelation', description: 'An existing relation touching the model (compact).' });
export type ClaimRelation = z.infer<typeof ClaimRelation>;

/** The relation types agents judge (`manual` is for humans only). */
const JudgedType = RelationType.exclude(['manual']);

/**
 * A current link verdict in `judged`: the live pipeline proposal of `by`
 * (a principal handle) on relation `relation`, whose type, refs, confidence
 * and question are in `relations`, from the analysis of model `origin`;
 * `mine` when `by` is the claimant.
 */
export const ClaimJudgedLink = z
  .object({
    relation: RelationId,
    origin: ModelKey,
    by: z.string(),
    mine: z.literal(true).optional(),
  })
  .meta({ id: 'ClaimJudgedLink', description: 'A current link verdict on a pair (compact).' });
export type ClaimJudgedLink = z.infer<typeof ClaimJudgedLink>;

/**
 * A current no-link in `judged`: `by` found the typed pair unrelated in the
 * analysis of model `origin`; `reason` cut to {@link CLAIM_REASON_CHARS}
 * characters; `mine` when `by` is the claimant.
 */
export const ClaimJudgedNoLink = z
  .object({
    type: JudgedType,
    from: Ref,
    to: Ref,
    origin: ModelKey,
    by: z.string(),
    mine: z.literal(true).optional(),
    reason: z.string(),
  })
  .meta({ id: 'ClaimJudgedNoLink', description: 'A current no-link verdict on a pair (compact).' });
export type ClaimJudgedNoLink = z.infer<typeof ClaimJudgedNoLink>;

export const ClaimJudged = z
  .union([ClaimJudgedLink, ClaimJudgedNoLink])
  .meta({ id: 'ClaimJudged', description: 'A current agent judgement on a pair.' });
export type ClaimJudged = z.infer<typeof ClaimJudged>;

/**
 * A candidate or relation pair another model's analysis judges: `claimed`
 * (its claimed task was assigned the pair) or `queued` (its queued task
 * judges it when claimed).
 */
export const ClaimSkip = z
  .object({
    type: JudgedType,
    from: Ref,
    to: Ref,
    /** The partner model whose analysis judges the pair. */
    model: ModelKey,
    reason: z.enum(['claimed', 'queued']),
  })
  .meta({ id: 'ClaimSkip', description: 'A candidate pair a partner analysis judges.' });
export type ClaimSkip = z.infer<typeof ClaimSkip>;

/**
 * The input of a claimed `relations` task (CONCEPT §3), rendered compactly
 * (`proa-claim/1`; on the eval corpus at most 82 KB, mean 41–49 KB, measured
 * for every model of both scored landscapes by the server's
 * `claim-input-size` test, which requires < 100 KB):
 *
 * - `model`: key, name, head revision, engine and processes;
 * - `facts`: every head fact of the model ({@link ClaimFact}), message
 *   flows with their `from` and `to`;
 * - `candidates`: pairs in both directions from `@proa/relations`
 *   (`generateCandidates` with the model as focus: rule and key pairs, top 5
 *   lexical matches and up to 30 further compatible endpoints per endpoint)
 *   as `[type, from, to, basis, score]` tuples ({@link ClaimCandidate}),
 *   sorted by score; a pair in `judged` or `skip` is listed there instead,
 *   so the candidates are the pairs left to judge, the `compatible` search
 *   space and the pairs a decision settles;
 * - `partners`: every endpoint of another model that a candidate or
 *   relation names, keyed by ref ({@link ClaimEndpoint});
 * - `partnerProcesses`: the process of every partner endpoint, keyed by
 *   process ref ({@link ClaimPartnerProcess}); left out without partners;
 * - `relations`: the non-obsolete relations touching the model, with their
 *   human decision (reasons, hold notes, questions) and notes
 *   ({@link ClaimRelation});
 * - `judged`: every current agent judgement (live pipeline proposal or
 *   no-link whose basis equals both models' heads and the procedure claims
 *   name) on a pair touching the model, any origin and principal, the
 *   claimant's own included ({@link ClaimJudged}); sorted by pair, then
 *   link before no-link, then origin, handle and id; left out when there is
 *   none;
 * - `skip`: the candidate and relation pairs without a current judgement
 *   that a partner model's analysis judges ({@link ClaimSkip}); left out
 *   when there is none. The remaining `rule`, `key` and `lexical`
 *   candidates and the relations in neither list are this task's
 *   assignment (judge each pair once), except accepted pairs, rejected ones
 *   with unchanged endpoints and relations with a missing end; the other
 *   `compatible` candidates are nobody's assignment but the search space
 *   for missing partners;
 * - `findings`: the project's deterministic findings (as `GET …/findings`
 *   lists them) with at least one ref in the model, sorted by kind and
 *   refs; left out when there are none.
 *
 * `partnerProcesses`, `judged`, `skip` and `findings` came later in
 * `proa-claim/1`, so they are optional. The XML comes only through
 * `get_model_xml`.
 */
export const ClaimInput = z
  .object({
    format: z.literal(CLAIM_INPUT_FORMAT),
    model: z.object({
      key: ModelKey,
      name: z.string().nullable(),
      revisionId: RevisionId,
      rev: z.number().int().min(1),
      engine: orNull(Engine),
      processes: z.array(
        z.object({
          processId: ElementId,
          name: z.string().nullable(),
          participantName: z.string().nullable(),
        }),
      ),
    }),
    facts: z.array(ClaimFact),
    candidates: z.array(ClaimCandidate),
    partners: z.record(z.string(), ClaimEndpoint),
    /** The process of every partner endpoint, keyed by process ref `<modelKey>#<processId>`. */
    partnerProcesses: z.record(z.string(), ClaimPartnerProcess).optional(),
    relations: z.array(ClaimRelation),
    /** Current agent judgements on pairs touching the model (judge each pair once). */
    judged: z.array(ClaimJudged).optional(),
    /** Candidate pairs a partner model's analysis judges. */
    skip: z.array(ClaimSkip).optional(),
    /** Findings of the project with a ref in the model (unresolved or dynamic calls, dangling throws, …). */
    findings: z.array(Finding).optional(),
  })
  .meta({ id: 'ClaimInput', description: 'Input of a claimed relations task (compact).' });
export type ClaimInput = z.infer<typeof ClaimInput>;

export const ClaimedAnalysis = z
  .object({
    taskId: AnalysisTaskId,
    projectId: ProjectId,
    projectKey: ProjectKey,
    modelId: ModelId,
    modelKey: ModelKey,
    revisionId: RevisionId,
    /** 1 for the first claim; a task fails when its lease expires at attempt {@link MAX_ATTEMPTS}. */
    attempt: z.number().int().min(1),
    /** Secret, shown once; bound to this task and the caller. Submit or release with it. */
    leaseToken: z.string().regex(LEASE_TOKEN_PATTERN),
    leaseUntil: Timestamp,
    /** The procedure the server expects the agent to follow and declare. */
    procedure: DeclaredProcedure,
    input: ClaimInput,
  })
  .meta({
    id: 'ClaimedAnalysis',
    description: 'A claimed analysis task with its lease and input.',
  });
export type ClaimedAnalysis = z.infer<typeof ClaimedAnalysis>;

export const ClaimResult = z
  .object({ items: z.array(ClaimedAnalysis) })
  .meta({ id: 'ClaimResult', description: 'Claimed tasks; empty when nothing is queued.' });
export type ClaimResult = z.infer<typeof ClaimResult>;

// ------------------------------------------------------------------ submit

/**
 * One proposed relation. Only the shape is checked up front; the limits
 * (confidence in [0, 1], rationale ≤ 1,000 and question ≤ 500 characters,
 * ≤ 20 evidence entries, no control characters other than tab and line
 * breaks in rationale, question and evidence) and the refs are checked per
 * item, and a failing item comes back as `invalid:<reason>` while the
 * others apply.
 */
export const ProposalItem = z
  .object({
    /** `call`, `message`, `signal` or `trigger`; `manual` is for humans only. */
    type: z.string().max(30),
    from: z.string().max(LOOSE_REF),
    to: z.string().max(LOOSE_REF),
    confidence: z.number(),
    rationale: z.string().max(LOOSE_TEXT).default(''),
    /** Refs or short texts the judgement rests on. */
    evidence: z.array(z.string().max(LOOSE_REF)).max(200).default([]),
    /** A question for the reviewer, e.g. when the link depends on knowledge outside the models. */
    question: z.string().max(LOOSE_TEXT).nullable().default(null),
  })
  .meta({ id: 'ProposalItem', description: 'A relation an agent proposes.' });
export type ProposalItem = z.input<typeof ProposalItem>;

/**
 * A pair the agent judged and found unrelated. `type` is the relation type
 * the pair was judged for (`call`, `message`, `signal`, `trigger`); without
 * it the server takes the one type the endpoints fit. Only the shape is
 * checked up front; type, refs and the reason's characters are checked per
 * item ({@link NO_LINK_INVALID_REASONS}). A stored no-link is an agent
 * judgement (reviewers see it on the relation, partner analyses skip the
 * pair); the whole submission is also kept verbatim for the eval (with
 * U+0000, which PostgreSQL cannot store, as U+FFFD).
 */
export const NoLinkItem = z
  .object({
    type: z.string().max(30).optional(),
    from: z.string().max(LOOSE_REF),
    to: z.string().max(LOOSE_REF),
    reason: z.string().max(MAX_NO_LINK_REASON_CHARS).default(''),
  })
  .meta({ id: 'NoLinkItem', description: 'A pair judged unrelated.' });

export const SubmitAnalysisBody = z
  .object({
    leaseToken: z.string().min(1).max(200),
    /** Client-chosen UUID; replaying it returns the stored result. */
    submissionId: z.uuid(),
    procedure: DeclaredProcedure,
    /** Declared LLM model, e.g. `claude-sonnet-5-5`. */
    llmModel: plainName(100).nullable().default(null),
    relations: z.array(ProposalItem).max(MAX_SUBMISSION_RELATIONS),
    noLinks: z.array(NoLinkItem).max(MAX_SUBMISSION_NO_LINKS).default([]),
    summary: z.string().max(MAX_SUMMARY_CHARS).nullable().default(null),
    costUsd: z.number().min(0).max(1_000_000).nullable().default(null),
  })
  .meta({ id: 'SubmitAnalysisBody', description: 'The result of an analysis task.' });
export type SubmitAnalysisBody = z.infer<typeof SubmitAnalysisBody>;
export type SubmitAnalysisInput = z.input<typeof SubmitAnalysisBody>;

/** Why an item is invalid (`invalid:<reason>`). */
export const INVALID_REASONS = [
  'malformed-ref',
  'type-not-allowed',
  'unknown-ref',
  'outside-task-model',
  'type-mismatch',
  'same-process',
  'message-flow',
  'confidence-out-of-range',
  'rationale-too-long',
  'question-too-long',
  'too-much-evidence',
  'control-characters',
] as const;
export type InvalidReason = (typeof INVALID_REASONS)[number];

/**
 * Outcome of one proposal (CONCEPT §3):
 * - `applied`: recorded;
 * - `duplicate`: nothing new (the caller's identical live pipeline
 *   proposal on the same model versions under the same procedure, an
 *   accepted relation with the same endpoints, or an earlier item of the
 *   same submission);
 * - `suppressed`: a human already decided and the endpoint fingerprints are
 *   unchanged, so nothing is recorded (a submission's proposal on a held
 *   pair is recorded as the agent's judgement instead: `applied` or
 *   `duplicate`, and the hold stays);
 * - `reopened`: recorded, and it reopens a rejection because an endpoint
 *   changed since;
 * - `invalid:<reason>`: not recorded ({@link INVALID_REASONS}).
 */
export const ProposalOutcome = z
  .enum([
    'applied',
    'duplicate',
    'suppressed',
    'reopened',
    ...INVALID_REASONS.map((r) => `invalid:${r}` as const),
  ])
  .meta({ id: 'ProposalOutcome', description: 'Outcome of one proposed relation.' });
export type ProposalOutcome = z.infer<typeof ProposalOutcome>;

/** Why a no-link is invalid (`invalid:<reason>`), in the order they are checked. */
export const NO_LINK_INVALID_REASONS = [
  'type-not-allowed',
  'malformed-ref',
  'control-characters',
  'outside-task-model',
  'unknown-ref',
  'type-mismatch',
  'same-process',
  'message-flow',
  'type-required',
  'also-proposed',
] as const;
export type NoLinkInvalidReason = (typeof NO_LINK_INVALID_REASONS)[number];

/**
 * Outcome of one no-link:
 * - `stored`: recorded as the caller's judgement of the typed pair;
 * - `duplicate`: nothing new (an earlier no-link of the same submission on
 *   the typed pair, or the caller's live, current no-link on it);
 * - `invalid:<reason>`: not recorded ({@link NO_LINK_INVALID_REASONS};
 *   `type-required`: the endpoints fit several types, `also-proposed`: the
 *   submission also proposes the typed pair).
 */
export const NoLinkOutcome = z
  .enum(['stored', 'duplicate', ...NO_LINK_INVALID_REASONS.map((r) => `invalid:${r}` as const)])
  .meta({ id: 'NoLinkOutcome', description: 'Outcome of one no-link.' });
export type NoLinkOutcome = z.infer<typeof NoLinkOutcome>;

export const SubmissionNoLinks = z
  .object({
    /** Per item of `noLinks`, in order. */
    items: z.array(
      z.object({
        /** Position in `noLinks`. */
        index: z.number().int().min(0),
        result: NoLinkOutcome,
      }),
    ),
    counts: z.object({
      stored: z.number().int().min(0),
      duplicate: z.number().int().min(0),
      invalid: z.number().int().min(0),
    }),
  })
  .meta({ id: 'SubmissionNoLinks', description: 'Outcome of the no-links of a submission.' });
export type SubmissionNoLinks = z.infer<typeof SubmissionNoLinks>;

/** A typed pair (`uncovered`). */
export const TypedPair = z
  .object({ type: JudgedType, from: Ref, to: Ref })
  .meta({ id: 'TypedPair', description: 'A typed pair of endpoints.' });
export type TypedPair = z.infer<typeof TypedPair>;

/**
 * The pairs the claim assigned to the task (its `rule`, `key` and `lexical`
 * candidates and the relations touching the model, minus `judged`, `skip`,
 * accepted pairs, rejections with unchanged endpoints and relations with a
 * missing end; never a `compatible` candidate that is no relation) that the
 * submission neither proposed nor no-linked and that have no current
 * judgement: the count and the first {@link MAX_UNCOVERED_PAIRS}. Nothing is
 * queued for them.
 */
export const UncoveredPairs = z
  .object({
    count: z.number().int().min(0),
    pairs: z.array(TypedPair).max(MAX_UNCOVERED_PAIRS),
  })
  .meta({ id: 'UncoveredPairs', description: 'Assigned pairs a submission left unjudged.' });
export type UncoveredPairs = z.infer<typeof UncoveredPairs>;

export const SubmissionItemResult = z
  .object({
    /** Position in `relations`. */
    index: z.number().int().min(0),
    result: ProposalOutcome,
    /** The relation, unless the item is invalid. */
    relationId: orNull(RelationId),
    /** Status after the submission, unless the item is invalid. */
    status: orNull(RelationStatus),
  })
  .meta({ id: 'SubmissionItemResult', description: 'Outcome of one item of a submission.' });
export type SubmissionItemResult = z.infer<typeof SubmissionItemResult>;

export const SubmissionResult = z
  .object({
    taskId: AnalysisTaskId,
    submissionId: z.string(),
    /** True when this answers a replay of a stored submission. */
    replayed: z.boolean(),
    items: z.array(SubmissionItemResult),
    counts: z.object({
      applied: z.number().int().min(0),
      duplicate: z.number().int().min(0),
      suppressed: z.number().int().min(0),
      reopened: z.number().int().min(0),
      invalid: z.number().int().min(0),
    }),
    /**
     * Earlier pipeline proposals this submission withdrew: judged on another
     * version of the model or under another procedure, or the caller's own
     * proposal from an analysis of the model that a no-link replaces.
     */
    withdrawn: z.number().int().min(0),
    /** Per no-link outcome (results stored before no-links were validated have none). */
    noLinks: SubmissionNoLinks.optional(),
    /** Earlier no-links this submission withdrew, like `withdrawn`. */
    withdrawnNoLinks: z.number().int().min(0).optional(),
    /** Assigned pairs left without a judgement. */
    uncovered: UncoveredPairs.optional(),
  })
  .meta({ id: 'SubmissionResult', description: 'Outcome of a submission, per item.' });
export type SubmissionResult = z.infer<typeof SubmissionResult>;

/** A stored submission: the verbatim payload and its result (for the eval and reviewers). */
export const AnalysisSubmission = z
  .object({
    id: SubmissionId,
    taskId: AnalysisTaskId,
    submissionId: z.string(),
    principalId: PrincipalId,
    handle: z.string(),
    clientId: z.string().nullable(),
    procedure: DeclaredProcedure,
    llmModel: z.string().nullable(),
    /** The request body as received, minus the lease token. */
    payload: z.record(z.string(), z.unknown()),
    result: SubmissionResult,
    createdAt: Timestamp,
  })
  .meta({ id: 'AnalysisSubmission', description: 'A stored analysis submission.' });
export type AnalysisSubmission = z.infer<typeof AnalysisSubmission>;

// ----------------------------------------------------------------- release

export const ReleaseAnalysisBody = z
  .object({
    leaseToken: z.string().min(1).max(200),
    /** Why the agent hands the task back (kept as `lastError`). */
    reason: plainText(z.string().max(500)).nullable().default(null),
  })
  .meta({ id: 'ReleaseAnalysisBody', description: 'Request body to release a claimed task.' });
export type ReleaseAnalysisBody = z.infer<typeof ReleaseAnalysisBody>;

export const ReleaseResult = z
  .object({ taskId: AnalysisTaskId, state: z.literal('queued') })
  .meta({ id: 'ReleaseResult', description: 'The released task is queued again.' });
export type ReleaseResult = z.infer<typeof ReleaseResult>;

// ----------------------------------------------------------------- pending

export const PendingQuery = z.object({
  /** Only this project (id or key). */
  projectId: ProjectRef.optional(),
  /** Seconds to wait for work when nothing is claimable (long-poll), 0–30. */
  wait: z.coerce.number().int().min(0).max(MAX_WAIT_SECONDS).default(0),
});
export type PendingQuery = z.infer<typeof PendingQuery>;

export const PendingAnalyses = z
  .object({
    /** Claimable tasks: queued, or claimed with an expired lease and attempts left. */
    total: z.number().int().min(0),
    items: z.array(
      z.object({
        projectId: ProjectId,
        projectKey: ProjectKey,
        pending: z.number().int().min(0),
      }),
    ),
  })
  .meta({ id: 'PendingAnalyses', description: 'Claimable tasks per project.' });
export type PendingAnalyses = z.infer<typeof PendingAnalyses>;

// ----------------------------------------------------------------- requeue

export const RequeueBody = z
  .object({
    modelKeys: z.array(ModelKey).min(1).max(1000).optional(),
    all: z.literal(true).optional(),
  })
  .refine((b) => (b.modelKeys === undefined) !== (b.all === undefined), {
    message: 'send either modelKeys or all: true',
  })
  .meta({
    id: 'RequeueBody',
    description: 'Models to analyse again (e.g. after a procedure upgrade).',
  });
export type RequeueBody = z.infer<typeof RequeueBody>;

export const RequeueResult = z
  .object({
    items: z.array(
      z.object({
        modelKey: ModelKey,
        /** `queued`: a new task; `open`: a task is already queued or claimed; `not-found`: no live model. */
        outcome: z.enum(['queued', 'open', 'not-found']),
        taskId: orNull(AnalysisTaskId),
      }),
    ),
  })
  .meta({ id: 'RequeueResult', description: 'Outcome per model of a requeue.' });
export type RequeueResult = z.infer<typeof RequeueResult>;
