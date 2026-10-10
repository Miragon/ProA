import { z } from 'zod';

import {
  AnalysisTaskId,
  PlacementAssertionId,
  PlacementId,
  PrincipalId,
  RelationId,
  SubmissionId,
  ValueChainId,
} from '../ids.ts';
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
import { orNull, plainName, plainText } from '../zod-utils.ts';
import { Cursor, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, Timestamp, pageOf } from './common.ts';
import { ModelStage } from './models.ts';
import {
  AnalysisTaskState,
  MAX_BULK_DECISIONS,
  MAX_LABEL_CHARS,
  MAX_NOTE_CHARS,
  MAX_QUESTION_CHARS,
  MAX_RATIONALE_CHARS,
} from './shared.ts';
import {
  MAX_VALUE_CHAIN_ID_CHARS,
  ValueChain,
  ValueChainOrgUnit,
  ValueChainStep,
} from './value-chains.ts';

// ------------------------------------------------------------------ limits

/** Placement items per proposal request (`propose_placement`, `POST …/placements`). */
export const MAX_PLACEMENT_ITEMS = 200;
/**
 * Live steps per process and principal (M4 §3.1): a fourth step for the same
 * process is `invalid:too-many-steps` (the rule tier is exempt).
 */
export const MAX_LIVE_STEPS_PER_PROCESS = 3;
/** `baseline-prefix/1` hints per unplaced process. */
export const UNPLACED_HINTS = 3;
/** Start and end labels per unplaced process. */
export const UNPLACED_EVENT_LABELS = 5;
/** Documentation of an unplaced process is cut to this many characters. */
export const UNPLACED_DOC_CHARS = 200;

/** Structural caps of proposal items; the documented limits are checked per item. */
const LOOSE_TEXT = 20_000;
const LOOSE_REF = 1000;

// ------------------------------------------------------------------- reads

/** Tier of a placement: server-computed, never `rule` (nothing is auto-accepted, M4 §2). */
export const PlacementTier = Tier.exclude(['rule']).meta({
  id: 'PlacementTier',
  description:
    'Evidence tier of a placement: `key` (rule tier: a step link or an equal name), `lexical`, `semantic`, `manual`.',
});
export type PlacementTier = z.infer<typeof PlacementTier>;

/** Where a placement's status comes from: the assertion it rests on (as `RelationProvenance`). */
export const PlacementProvenance = z
  .object({
    assertionId: PlacementAssertionId,
    kind: AssertionKind,
    verdict: orNull(Verdict),
    sourceKind: SourceKind,
    principalId: PrincipalId,
    handle: z.string(),
    clientId: z.string().nullable(),
    procedure: orNull(DeclaredProcedure),
    llmModel: z.string().nullable(),
    tier: orNull(PlacementTier),
    confidence: z.number().min(0).max(1).nullable(),
    rationale: z.string().nullable(),
    question: z.string().nullable(),
    label: z.string().nullable(),
    at: Timestamp,
  })
  .meta({ id: 'PlacementProvenance', description: 'The assertion a placement status rests on.' });
export type PlacementProvenance = z.infer<typeof PlacementProvenance>;

/**
 * A placement (M4 §2): process `process` belongs to step generation
 * `(elementId, generation)` of the chain, with the relation lifecycle. The
 * endpoint state is `missing` when the step generation is not live any more
 * (a deleted step, also when its id came back as a new generation) or the
 * process left the head facts, `changed` when a fingerprint differs from
 * the one stored with the deciding assertion; `endpoints` gives it per side.
 */
export const Placement = z
  .object({
    id: PlacementId,
    valueChainId: ValueChainId,
    /** A step element id, or `@outside`. */
    elementId: z.string(),
    generation: z.number().int().min(1),
    /** The step's name in the head; `null` when the generation is not live, and for `@outside`. */
    stepName: z.string().nullable(),
    /** The step generation is live in the head. */
    stepLive: z.boolean(),
    process: Ref,
    /** Process name (else the pool name) in the head; `null` when the process is not in the head. */
    processName: z.string().nullable(),
    status: RelationStatus,
    endpointState: EndpointState,
    endpoints: z.object({ step: EndpointState, process: EndpointState }),
    tier: PlacementTier,
    confidence: z.number().min(0).max(1).nullable(),
    /** Optimistic-concurrency version; decisions and bulk decisions send it back. */
    version: z.number().int().min(1),
    source: orNull(SourceKind),
    provenance: orNull(PlacementProvenance),
    updatedAt: Timestamp,
  })
  .meta({ id: 'Placement', description: 'A process placed on a value chain step.' });
export type Placement = z.infer<typeof Placement>;

export const PlacementPage = pageOf(Placement, 'PlacementPage');
export type PlacementPage = z.infer<typeof PlacementPage>;

/** Query of `GET …/placements`, ordered by step, generation and process. Obsolete ones only with `status=obsolete`. */
export const PlacementQuery = z.object({
  /** A step element id or `@outside`. */
  elementId: z.string().min(1).max(MAX_VALUE_CHAIN_ID_CHARS).optional(),
  process: Ref.optional(),
  /** Placements of the processes of this model. */
  modelKey: ModelKey.optional(),
  status: RelationStatus.optional(),
  tier: PlacementTier.optional(),
  endpointState: EndpointState.optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type PlacementQuery = z.infer<typeof PlacementQuery>;

/** A placement in the chain overview (`ValueChainDetail`, MCP `get_value_chain`): compact. */
export const PlacementSummary = z
  .object({
    id: PlacementId,
    elementId: z.string(),
    generation: z.number().int().min(1),
    stepLive: z.boolean(),
    process: Ref,
    status: RelationStatus,
    endpointState: EndpointState,
    tier: PlacementTier,
    confidence: z.number().min(0).max(1).nullable(),
    version: z.number().int().min(1),
    source: orNull(SourceKind),
  })
  .meta({ id: 'PlacementSummary', description: 'A placement in the chain overview.' });
export type PlacementSummary = z.infer<typeof PlacementSummary>;

// ---------------------------------------------------------------- findings

/**
 * Kinds of value chain findings (M4 §3.4), separate from the relation
 * findings (`FindingKind`): deterministic, recomputed on read, never blocking.
 */
export const VALUE_CHAIN_FINDING_KINDS = [
  'process-without-step',
  'step-without-process',
  'unresolved-link',
] as const;

export const ValueChainFindingKind = z.enum(VALUE_CHAIN_FINDING_KINDS).meta({
  id: 'ValueChainFindingKind',
  description: 'Kind of a value chain finding.',
});
export type ValueChainFindingKind = z.infer<typeof ValueChainFindingKind>;

/**
 * Where an unplaced process stands (`process-without-step`): `held` (a held
 * placement on a live step), `proposed` (a placement waiting for review on a
 * live step), `none`.
 */
export const UnplacedState = z
  .enum(['none', 'proposed', 'held'])
  .meta({ id: 'UnplacedState', description: 'Review state of a process without a home step.' });
export type UnplacedState = z.infer<typeof UnplacedState>;

/**
 * A finding about the value chain (M4 §3.4), in this order:
 * - `process-without-step` (`process`): a head process with no accepted
 *   placement on a live step generation (`@outside` counts; an accepted
 *   placement on a removed step does not); `state` tells whether one is
 *   pending or held, and `calledFrom` names the steps on which processes
 *   that call it through an accepted `call` relation are accepted (a hint);
 * - `step-without-process` (`elementId`): no accepted placement of a head
 *   process on the step or below it, reported once, at the topmost such step;
 * - `unresolved-link` (`elementId`, `link`): a step `link` that is neither
 *   `proa:process/<ref>` of a head process nor an http(s) URL.
 */
export const ValueChainFinding = z
  .object({
    kind: ValueChainFindingKind,
    /** The step (`step-without-process`, `unresolved-link`); `null` otherwise. */
    elementId: z.string().nullable(),
    /** The process (`process-without-step`); `null` otherwise. */
    process: orNull(Ref),
    /** The step's link (`unresolved-link`); `null` otherwise. */
    link: z.string().nullable(),
    /** `process-without-step`: whether a placement is pending or held; `null` otherwise. */
    state: orNull(UnplacedState),
    /** `process-without-step`: steps of accepted callers (accepted `call` relations), with the caller. */
    calledFrom: z.array(z.object({ elementId: z.string(), process: Ref })),
    /** Human-readable explanation. */
    detail: z.string(),
  })
  .meta({ id: 'ValueChainFinding', description: 'A deterministic finding about the value chain.' });
export type ValueChainFinding = z.infer<typeof ValueChainFinding>;

export const ValueChainFindingList = z
  .object({ items: z.array(ValueChainFinding) })
  .meta({ id: 'ValueChainFindingList', description: 'Findings of the value chain head.' });
export type ValueChainFindingList = z.infer<typeof ValueChainFindingList>;

/**
 * What the agent's last verdict on a process was (the `placement_input`
 * memory of M4 §3.2, judge each process once): `proposed` (a pipeline
 * submission or an ad-hoc agent proposal placed it), `unsure` (with the
 * agent's reason) or `skipped` (a pipeline submission left it out).
 */
export const PlacementInputOutcome = z
  .enum(['proposed', 'unsure', 'skipped'])
  .meta({ id: 'PlacementInputOutcome', description: "The agent's last verdict on a process." });
export type PlacementInputOutcome = z.infer<typeof PlacementInputOutcome>;

/**
 * The stage of the chain's `placement` pipeline (M4 §3.5, view
 * `value_chain_pipeline`), mapped like a model's (CONCEPT §3): the latest
 * non-cancelled placement task queued → `waiting_for_agent`, claimed →
 * `agent_working`, failed → `agent_failed`; done, or no task yet, →
 * `waiting_for_review` (a proposal on a live step, or an accepted placement
 * whose endpoint is not `ok`), `waiting_for_clarification` (only held
 * placements), else `incorporated`. `due` counts the open processes whose
 * input changed since the agent's last verdict (the next task judges them);
 * `unsure` the open processes the agent was unsure about on their current
 * input. Neither changes the stage.
 */
export const ValueChainPipeline = z
  .object({
    stage: ModelStage,
    /** The latest non-cancelled placement task; `null` before the first one. */
    task: orNull(
      z.object({
        id: AnalysisTaskId,
        state: AnalysisTaskState,
        attempts: z.number().int().min(0),
        leaseUntil: orNull(Timestamp),
        /** Handle of the principal holding (or last holding) the lease. */
        claimedBy: z.string().nullable(),
      }),
    ),
    /** Placements waiting for a reviewer (the page's open items). */
    reviewItems: z.number().int().min(0),
    heldItems: z.number().int().min(0),
    /** Open processes the next placement task judges. */
    due: z.number().int().min(0),
    /** Open processes the agent was unsure about on their current input. */
    unsure: z.number().int().min(0),
  })
  .meta({ id: 'ValueChainPipeline', description: "Stage of the chain's placement pipeline." });
export type ValueChainPipeline = z.infer<typeof ValueChainPipeline>;

/**
 * An open process the agent was unsure about ("Agent unsicher"): its reason,
 * who said so and when; `current` while the process's input is unchanged
 * since (otherwise the next placement task judges it again).
 */
export const ValueChainUnsure = z
  .object({
    process: Ref,
    /** Process name, else the pool name; `null` without one. */
    name: z.string().nullable(),
    reason: z.string(),
    /** Handle of the agent. */
    by: z.string(),
    at: Timestamp,
    current: z.boolean(),
  })
  .meta({ id: 'ValueChainUnsure', description: 'A process the agent was unsure about.' });
export type ValueChainUnsure = z.infer<typeof ValueChainUnsure>;

/**
 * A value chain with its head structure: the steps (code point order of
 * their ids) with kind, rank, owners, link and placement counts, the org
 * units, every non-obsolete placement, including those on removed steps
 * (open items: only a rejection or a correction closes them), the findings,
 * the stage of its placement pipeline and the open processes the agent was
 * unsure about (by process ref).
 */
export const ValueChainDetail = z
  .object({
    valueChain: ValueChain,
    steps: z.array(ValueChainStep),
    orgUnits: z.array(ValueChainOrgUnit),
    placements: z.array(PlacementSummary),
    findings: z.array(ValueChainFinding),
    pipeline: ValueChainPipeline,
    unsure: z.array(ValueChainUnsure),
  })
  .meta({
    id: 'ValueChainDetail',
    description: 'A value chain with steps, placements and findings.',
  });
export type ValueChainDetail = z.infer<typeof ValueChainDetail>;

/** One entry of a placement's history (timeline), oldest first. */
export const PlacementAssertion = z
  .object({
    id: PlacementAssertionId,
    seq: z.number().int().min(1),
    kind: AssertionKind,
    verdict: orNull(Verdict),
    sourceKind: SourceKind,
    principalId: PrincipalId,
    handle: z.string(),
    clientId: z.string().nullable(),
    procedure: orNull(DeclaredProcedure),
    llmModel: z.string().nullable(),
    submissionId: orNull(SubmissionId),
    tier: orNull(PlacementTier),
    confidence: z.number().min(0).max(1).nullable(),
    /** Agent rationale, rejection reason, hold or accept note, or the text of a note. */
    rationale: z.string().nullable(),
    evidence: z.array(z.string()),
    question: z.string().nullable(),
    label: z.string().nullable(),
    /** `correct`: the manual placement accepted instead (on the rejection) or the corrected one (on the acceptance). */
    linkedPlacementId: orNull(PlacementId),
    /** Step and process fingerprints when the assertion was made. */
    stepFp: z.string().nullable(),
    processFp: z.string().nullable(),
    at: Timestamp,
  })
  .meta({ id: 'PlacementAssertion', description: 'One assertion of a placement history.' });
export type PlacementAssertion = z.infer<typeof PlacementAssertion>;

export const PlacementAssertionList = z
  .object({ items: z.array(PlacementAssertion) })
  .meta({ id: 'PlacementAssertionList', description: 'The history of a placement, oldest first.' });
export type PlacementAssertionList = z.infer<typeof PlacementAssertionList>;

/** The drill-down of one step (M4 §4): breadcrumb, sub-steps and processes. */
export const ValueChainStepDetail = z
  .object({
    step: ValueChainStep,
    /** The ancestors from the top level down to the parent. */
    breadcrumb: z.array(z.object({ elementId: z.string(), name: z.string() })),
    children: z.array(ValueChainStep),
    placements: z.object({
      /** Non-obsolete placements on the step. */
      own: z.array(Placement),
      /** Non-obsolete placements on its sub-steps (all levels). */
      subtree: z.array(Placement),
      /**
       * Processes called through accepted `call` relations by a process
       * accepted on the step or below it, unless accepted there themselves
       * (shown, never stored, M4 §2).
       */
      reachedByCall: z.array(
        z.object({
          process: Ref,
          name: z.string().nullable(),
          via: z.array(z.object({ relationId: RelationId, caller: Ref })),
        }),
      ),
    }),
  })
  .meta({ id: 'ValueChainStepDetail', description: 'The drill-down of one value chain step.' });
export type ValueChainStepDetail = z.infer<typeof ValueChainStepDetail>;

// ---------------------------------------------------------------- propose

/**
 * One placement an agent proposes (M4 §3.1). Only the shape is checked up
 * front; the limits (step 1–128 characters, confidence in [0, 1], rationale
 * ≤ 1,000 and question ≤ 500 characters, ≤ 20 evidence entries, no control
 * characters other than tab and line breaks) and the references are checked
 * per item ({@link PLACEMENT_INVALID_REASONS}), and a failing item comes back
 * as `invalid:<reason>` while the others apply. The same item shape serves
 * the `placement` pipeline (M4b).
 */
export const PlacementItem = z
  .object({
    /** A step element id of the head revision, or `@outside` (needs a rationale). */
    step: z.string().max(LOOSE_REF),
    /** A process of the head revisions, `<model_key>#<process_id>`. */
    process: z.string().max(LOOSE_REF),
    confidence: z.number(),
    rationale: z.string().max(LOOSE_TEXT).default(''),
    /** Fact refs, `rel_` relation ids or `step:<element id>` the judgement rests on. */
    evidence: z.array(z.string().max(LOOSE_REF)).max(200).default([]),
    /** A question for the reviewer. */
    question: z.string().max(LOOSE_TEXT).nullable().default(null),
  })
  .meta({ id: 'PlacementItem', description: 'A placement an agent proposes.' });
export type PlacementItem = z.input<typeof PlacementItem>;

/** Why a placement item is invalid (`invalid:<reason>`), in the order they are checked. */
export const PLACEMENT_INVALID_REASONS = [
  'malformed-step',
  'malformed-ref',
  'confidence-out-of-range',
  'rationale-too-long',
  'question-too-long',
  'too-much-evidence',
  'control-characters',
  'rationale-required',
  'unknown-step',
  'unknown-process',
  'unknown-evidence',
  'too-many-steps',
] as const;
export type PlacementInvalidReason = (typeof PLACEMENT_INVALID_REASONS)[number];

/**
 * Outcome of one placement item, as for relations: `applied`, `duplicate`
 * (the caller's own live proposal with the same fingerprints, an accepted
 * placement, or an earlier item of the same request), `suppressed` (a human
 * decided and nothing changed since), `reopened` (a rejection reopened
 * because the step or process changed), or `invalid:<reason>`.
 */
export const PlacementOutcome = z
  .enum([
    'applied',
    'duplicate',
    'suppressed',
    'reopened',
    ...PLACEMENT_INVALID_REASONS.map((r) => `invalid:${r}` as const),
  ])
  .meta({ id: 'PlacementOutcome', description: 'Outcome of one proposed placement.' });
export type PlacementOutcome = z.infer<typeof PlacementOutcome>;

/** Ad-hoc placement proposals (`proa:propose`); humans' proposals get the `manual` tier. */
export const ProposePlacementsBody = z
  .object({
    kind: z.literal('propose'),
    procedure: orNull(DeclaredProcedure).default(null),
    llmModel: plainName(100).nullable().default(null),
    placements: z.array(PlacementItem).min(1).max(MAX_PLACEMENT_ITEMS),
  })
  .meta({ id: 'ProposePlacementsBody', description: 'Placements proposed ad hoc.' });
export type ProposePlacementsBody = z.infer<typeof ProposePlacementsBody>;

/** A manual placement (humans only, accepted at once, M4 §4 "Add process"). */
export const ManualPlacementBody = z
  .object({
    kind: z.literal('manual'),
    /** A step element id of the head revision, or `@outside`. */
    step: z.string().min(1).max(MAX_VALUE_CHAIN_ID_CHARS),
    process: Ref,
    rationale: plainText(z.string().trim().min(1).max(MAX_RATIONALE_CHARS)),
    confidence: z.number().min(0).max(1).optional(),
  })
  .meta({ id: 'ManualPlacementBody', description: 'A manual placement, accepted at once.' });
export type ManualPlacementBody = z.infer<typeof ManualPlacementBody>;

export const PostPlacementsBody = z
  .discriminatedUnion('kind', [ProposePlacementsBody, ManualPlacementBody])
  .meta({ id: 'PostPlacementsBody', description: 'Propose placements, or add a manual one.' });
export type PostPlacementsBody = z.infer<typeof PostPlacementsBody>;
export type PostPlacementsInput = z.input<typeof PostPlacementsBody>;

export const PlacementItemResult = z
  .object({
    /** Position in `placements`. */
    index: z.number().int().min(0),
    result: PlacementOutcome,
    /** The placement, unless the item is invalid. */
    placementId: orNull(PlacementId),
    /** Status after the request, unless the item is invalid. */
    status: orNull(RelationStatus),
  })
  .meta({ id: 'PlacementItemResult', description: 'Outcome of one proposed placement.' });
export type PlacementItemResult = z.infer<typeof PlacementItemResult>;

export const ProposePlacementsResult = z
  .object({
    kind: z.literal('propose'),
    items: z.array(PlacementItemResult),
    counts: z.object({
      applied: z.number().int().min(0),
      duplicate: z.number().int().min(0),
      suppressed: z.number().int().min(0),
      reopened: z.number().int().min(0),
      invalid: z.number().int().min(0),
    }),
  })
  .meta({ id: 'ProposePlacementsResult', description: 'Outcome per proposed placement.' });
export type ProposePlacementsResult = z.infer<typeof ProposePlacementsResult>;

export const ManualPlacementResult = z
  .object({
    kind: z.literal('manual'),
    /** `duplicate`: the same human acceptance was already in force. */
    result: z.enum(['applied', 'duplicate']),
    placement: Placement,
  })
  .meta({ id: 'ManualPlacementResult', description: 'The manual placement.' });
export type ManualPlacementResult = z.infer<typeof ManualPlacementResult>;

export const PostPlacementsResult = z
  .discriminatedUnion('kind', [ProposePlacementsResult, ManualPlacementResult])
  .meta({ id: 'PostPlacementsResult', description: 'Outcome of proposed or manual placements.' });
export type PostPlacementsResult = z.infer<typeof PostPlacementsResult>;

// ---------------------------------------------------------------- decide

const note = (required: boolean) =>
  plainText(
    required ? z.string().trim().min(1).max(MAX_NOTE_CHARS) : z.string().max(MAX_NOTE_CHARS),
  );
const question = () => plainText(z.string().trim().min(1).max(MAX_QUESTION_CHARS));
const label = () => plainText(z.string().trim().min(1).max(MAX_LABEL_CHARS));
/** Optimistic concurrency: the decision fails with 409 `conflict` if the placement has another version. */
const version = z.number().int().min(1).optional();

/**
 * A human decision on a placement (humans only; agents get 403
 * `human-decision-required` with the value chain `reviewUrl`): `accept`
 * (also re-confirms a `changed` placement), `reject` with a reason, `hold`
 * with a note and an optional question and label, or `correct`: accept the
 * process on another step as a `manual` placement linked to this one, which
 * is rejected with the note as reason. A placement on a removed step can only
 * be rejected or corrected (`unknown-step`).
 */
export const PlacementDecisionBody = z
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
      /** The step (element id of the head, or `@outside`) the process belongs to instead. */
      step: z.string().min(1).max(MAX_VALUE_CHAIN_ID_CHARS),
      note: note(true),
      version,
    }),
  ])
  .meta({ id: 'PlacementDecisionBody', description: 'A human decision on one placement.' });
export type PlacementDecisionBody = z.infer<typeof PlacementDecisionBody>;

export const PlacementDecisionResult = z
  .object({
    placement: Placement,
    /** `correct`: the accepted manual placement. */
    corrected: orNull(Placement),
  })
  .meta({
    id: 'PlacementDecisionResult',
    description: 'The decided placement (and its correction).',
  });
export type PlacementDecisionResult = z.infer<typeof PlacementDecisionResult>;

/**
 * One verdict for many placements, all or nothing, like `BulkDecisionBody`:
 * a count other than `expectedCount`, or any item that is a duplicate, not
 * found, at another version, obsolete, of another `tier`, or (accept and
 * hold) on a removed step (`step-removed`: reject or correct it instead)
 * fails the request with 409 `conflict` and `mismatches`, and nothing changes.
 */
export const BulkPlacementDecisionBody = z
  .object({
    verdict: z.enum(['accept', 'reject', 'hold']),
    reason: note(true).optional(),
    note: note(true).optional(),
    question: question().optional(),
    label: label().optional(),
    tier: PlacementTier.optional(),
    items: z
      .array(z.object({ id: PlacementId, version: z.number().int().min(1) }))
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
  .meta({ id: 'BulkPlacementDecisionBody', description: 'One verdict for many placements.' });
export type BulkPlacementDecisionBody = z.infer<typeof BulkPlacementDecisionBody>;

export const BulkPlacementDecisionResult = z
  .object({ items: z.array(Placement) })
  .meta({ id: 'BulkPlacementDecisionResult', description: 'The decided placements.' });
export type BulkPlacementDecisionResult = z.infer<typeof BulkPlacementDecisionResult>;

// --------------------------------------------------------------- unplaced

/**
 * A process without a home step (M4 §3.1): no accepted or held placement on
 * a live step generation and none waiting for review (`proposed`) there; a
 * rejected placement homes nothing, although the proposal on it may still be
 * its proposer's current stance. With what an agent
 * needs to place it: name, model key, lanes, start and end labels, the
 * documentation (cut), its relation neighbours with their accepted steps,
 * calls in both directions and the top `baseline-prefix/1` steps as hints.
 */
export const UnplacedProcess = z
  .object({
    process: Ref,
    /** Process name, else the pool name. */
    name: z.string().nullable(),
    modelKey: ModelKey,
    lanes: z.array(z.string()),
    /** Up to 5 labels of the process's start events (process level). */
    starts: z.array(z.string()).max(UNPLACED_EVENT_LABELS),
    /** Up to 5 labels of its end events (process level). */
    ends: z.array(z.string()).max(UNPLACED_EVENT_LABELS),
    /** `bpmn:documentation` of the process, at most 200 characters; left out without. */
    doc: z.string().max(UNPLACED_DOC_CHARS).optional(),
    /** Processes joined to this one by a live, non-rejected relation, with their accepted steps. */
    neighbours: z.array(
      z.object({
        process: Ref,
        via: z.array(
          z.object({
            relationId: RelationId,
            type: RelationType,
            /** `out`: this process is the relation's `from` side. */
            direction: z.enum(['out', 'in']),
          }),
        ),
        /** Element ids of the steps the neighbour is accepted on. */
        steps: z.array(z.string()),
      }),
    ),
    calls: z.object({
      /** Processes this one calls. */
      out: z.array(z.object({ process: Ref, relationId: RelationId, status: RelationStatus })),
      /** Processes that call this one. */
      in: z.array(z.object({ process: Ref, relationId: RelationId, status: RelationStatus })),
    }),
    /** The top 3 steps of `baseline-prefix/1` (score > 0). */
    hints: z
      .array(z.object({ step: z.string(), name: z.string(), score: z.number().min(0) }))
      .max(UNPLACED_HINTS),
    /**
     * An agent judged the process on its current input (a pipeline task or an
     * ad-hoc proposal; judge each process once): skip it unless you have new
     * evidence. Left out otherwise.
     */
    judged: z
      .object({
        outcome: PlacementInputOutcome,
        /** The agent's reason, for `unsure`. */
        reason: z.string().optional(),
        /** Handle of the agent. */
        by: z.string(),
        at: Timestamp,
      })
      .optional(),
    /**
     * The process is in the input of the chain's placement task that an
     * agent holds right now (claimed, lease not expired): that agent judges
     * it, so skip it (judge each process once). Left out otherwise.
     */
    inTask: z
      .object({
        taskId: AnalysisTaskId,
        /** Handle of the agent holding the task. */
        claimedBy: z.string().nullable(),
        leaseUntil: Timestamp,
      })
      .optional(),
  })
  .meta({ id: 'UnplacedProcess', description: 'A process without a home step on the chain.' });
export type UnplacedProcess = z.infer<typeof UnplacedProcess>;

export const UnplacedProcessPage = pageOf(UnplacedProcess, 'UnplacedProcessPage');
export type UnplacedProcessPage = z.infer<typeof UnplacedProcessPage>;
