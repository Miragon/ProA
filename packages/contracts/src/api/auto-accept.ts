/**
 * Auto-accept rules (owner decision 19): project-scoped rules an owner
 * maintains so that agent proposals above a confidence are accepted without a
 * click. An acceptance is recorded as a human decision under the owner who
 * wrote the rule revision in force, marked with the rule, its immutable
 * revision and the triggering agent proposal; agents still only propose and
 * never see rules (no MCP tool, no rule data in agent-visible resources). Every
 * route is owner-only (permission `admin`) except the ledger of acceptances
 * (`GET …/auto-accepted`), which every human reviewer reads (permission
 * `review`: editors and owners on an interactive client) so that the review
 * views mark machine acceptances for everyone who decides.
 *
 * Named "auto-accept rule" everywhere, never just "rule": the rule tier
 * (`proa-rules`, decision 9) keeps that word. Decision 9 stays a built-in,
 * read-only system rule ({@link AutoAcceptSystemRule}).
 */
import { z } from 'zod';

import {
  AgentTokenId,
  AssertionId,
  AutoAcceptRuleId,
  PlacementAssertionId,
  PlacementId,
  PrincipalId,
  RelationId,
} from '../ids.ts';
import { Ref } from '../refs.ts';
import { EndpointState, RULES_PROCEDURE, RelationStatus, Tier } from '../relations.ts';
import { orNull, plainName, plainText } from '../zod-utils.ts';
import { Timestamp } from './common.ts';

/** What an auto-accept rule accepts: agent proposals of relations or of placements. */
export const AutoAcceptKind = z.enum(['relation', 'placement']).meta({
  id: 'AutoAcceptKind',
  description: 'What an auto-accept rule accepts: agent relation or placement proposals.',
});
export type AutoAcceptKind = z.infer<typeof AutoAcceptKind>;

/**
 * The server-computed proposal tier a rule names. Relations: `key`,
 * `lexical`, `semantic` (agent proposals never get `rule` or `manual`);
 * placements: `lexical`, `semantic` (`key` is the rule tier's only).
 */
export const AutoAcceptTier = z.enum(['key', 'lexical', 'semantic']).meta({
  id: 'AutoAcceptTier',
  description: 'Server-computed tier of the agent proposals a rule accepts.',
});
export type AutoAcceptTier = z.infer<typeof AutoAcceptTier>;

/** The tiers each kind of rule may name. */
export const AUTO_ACCEPT_TIERS = {
  relation: ['key', 'lexical', 'semantic'],
  placement: ['lexical', 'semantic'],
} as const satisfies Record<AutoAcceptKind, readonly AutoAcceptTier[]>;

/** Relation types a relation rule may be narrowed to (agents never propose `manual`). */
export const AutoAcceptRelationType = z.enum(['call', 'message', 'signal', 'trigger']).meta({
  id: 'AutoAcceptRelationType',
  description: 'Relation type a relation rule is narrowed to.',
});
export type AutoAcceptRelationType = z.infer<typeof AutoAcceptRelationType>;

/** The lowest minimum confidence a rule may name (also a database check). */
export const MIN_AUTO_ACCEPT_CONFIDENCE = 0.5;
export const MAX_AUTO_ACCEPT_NAME_CHARS = 100;
export const MAX_AUTO_ACCEPT_NOTE_CHARS = 500;
export const MAX_AUTO_ACCEPT_MODEL_CHARS = 100;
/** Ids per revocation request. */
export const MAX_AUTO_ACCEPT_IDS = 1000;
export const MAX_AUTO_ACCEPT_REASON_CHARS = 500;
/** Items a dry run, an apply or a revocation lists at most (`truncated` beyond). */
export const MAX_AUTO_ACCEPT_ITEMS = 1000;
/** Open items a preview lists at most. */
export const AUTO_ACCEPT_PREVIEW_ITEMS = 50;
/** The minimum confidences of the preview's curve. */
export const AUTO_ACCEPT_CURVE = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1] as const;

/**
 * Why a rule did not accept a proposal, in the order the server checks
 * (the first failing check is the reason):
 * - `not-agent`: humans and the rule tier never trigger a rule;
 * - `no-matching-rule`: no enabled rule (whose author is still an owner)
 *   matches kind, tier, minimum confidence, type, agent, model and ad hoc;
 * - `stale-proposal`: a pipeline proposal whose basis is no longer current;
 * - `not-open`: the item is not `proposed` (held, accepted, rejected, obsolete);
 * - `endpoint-not-ok`: an end changed or is missing;
 * - `outside`: a placement on `@outside` (never auto-accepted);
 * - `step-removed`: a placement on a removed step generation;
 * - `has-home-step`: the process already has an accepted or held placement
 *   (owner decision 18: a second home step only by a reviewer's decision);
 * - `competing-step`: another live proposal places the process on another step;
 * - `competing-call`: another proposed, held or accepted call leaves the same call element;
 * - `human-involved`: a human assertion on the pair (relations) or on any
 *   placement of the process: a decision, correction, hold, note, human
 *   proposal, an earlier auto-acceptance or its revocation;
 * - `agent-question`: a live agent proposal asks the reviewer a question;
 * - `no-link`: a live no-link of any agent on the typed pair;
 * - `agent-unsure`: another agent's current `unsure` verdict on the process.
 */
export const AUTO_ACCEPT_BLOCK_REASONS = [
  'not-agent',
  'no-matching-rule',
  'stale-proposal',
  'not-open',
  'endpoint-not-ok',
  'outside',
  'step-removed',
  'has-home-step',
  'competing-step',
  'competing-call',
  'human-involved',
  'agent-question',
  'no-link',
  'agent-unsure',
] as const;

export const AutoAcceptBlockReason = z
  .enum(AUTO_ACCEPT_BLOCK_REASONS)
  .meta({ id: 'AutoAcceptBlockReason', description: 'Why a rule did not accept a proposal.' });
export type AutoAcceptBlockReason = z.infer<typeof AutoAcceptBlockReason>;

/** How many open proposals one reason blocked. */
export const AutoAcceptBlockedCount = z
  .object({ reason: AutoAcceptBlockReason, count: z.number().int().min(1) })
  .meta({ id: 'AutoAcceptBlockedCount', description: 'Open proposals one reason blocked.' });
export type AutoAcceptBlockedCount = z.infer<typeof AutoAcceptBlockedCount>;

const ruleName = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(MAX_AUTO_ACCEPT_NAME_CHARS)
    .refine((value) => !/\p{Cc}/u.test(value), 'must not contain control characters');

const criteriaShape = {
  kind: AutoAcceptKind,
  /** One of `AUTO_ACCEPT_TIERS[kind]`. */
  tier: AutoAcceptTier,
  /** Inclusive: a proposal with exactly this confidence is accepted. */
  minConfidence: z.number().min(MIN_AUTO_ACCEPT_CONFIDENCE).max(1),
  /** Relations only: accept only this type. */
  relationType: orNull(AutoAcceptRelationType).default(null),
  /** Only proposals of this principal (an agent token's `principalId`). */
  agentPrincipalId: orNull(PrincipalId).default(null),
  /** Only proposals declaring exactly this LLM model. */
  llmModel: plainName(MAX_AUTO_ACCEPT_MODEL_CHARS).nullable().default(null),
  /** Also ad-hoc proposals (default: pipeline proposals with a claim basis only). */
  includeAdHoc: z.boolean().default(false),
};

function checkCriteria(
  c: { kind: AutoAcceptKind; tier: AutoAcceptTier; relationType: AutoAcceptRelationType | null },
  ctx: z.RefinementCtx,
): void {
  if (!(AUTO_ACCEPT_TIERS[c.kind] as readonly string[]).includes(c.tier)) {
    ctx.addIssue({
      code: 'custom',
      path: ['tier'],
      message: `a ${c.kind} rule names one of the tiers ${AUTO_ACCEPT_TIERS[c.kind].join(', ')}`,
    });
  }
  if (c.kind === 'placement' && c.relationType !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['relationType'],
      message: 'only a relation rule has a relation type',
    });
  }
}

/** What a rule matches; also the body of a preview of an unsaved rule. */
export const AutoAcceptCriteria = z.object(criteriaShape).superRefine(checkCriteria).meta({
  id: 'AutoAcceptCriteria',
  description: 'What an auto-accept rule matches: kind, tier, minimum confidence, narrowing.',
});
export type AutoAcceptCriteria = z.infer<typeof AutoAcceptCriteria>;
export type AutoAcceptCriteriaInput = z.input<typeof AutoAcceptCriteria>;

/**
 * A rule as the owner writes it (create, and edit as a whole: every edit,
 * enable and disable is a new immutable revision). Names are unique per
 * project, ignoring case.
 */
export const AutoAcceptRuleDraft = z
  .object({
    name: ruleName(),
    /** Off by default: a new rule accepts nothing until it is enabled. */
    enabled: z.boolean().default(false),
    note: plainText(z.string().trim().max(MAX_AUTO_ACCEPT_NOTE_CHARS)).nullable().default(null),
    ...criteriaShape,
  })
  .superRefine(checkCriteria)
  .meta({ id: 'AutoAcceptRuleDraft', description: 'An auto-accept rule as the owner writes it.' });
export type AutoAcceptRuleDraft = z.infer<typeof AutoAcceptRuleDraft>;
export type AutoAcceptRuleDraftInput = z.input<typeof AutoAcceptRuleDraft>;

/** A principal with its pseudonymous handle. */
export const AutoAcceptPrincipal = z
  .object({ principalId: PrincipalId, handle: z.string() })
  .meta({ id: 'AutoAcceptPrincipal', description: 'A principal and its handle.' });
export type AutoAcceptPrincipal = z.infer<typeof AutoAcceptPrincipal>;

/** An agent a rule can be narrowed to: an agent token's principal (or an R1 service). */
export const AutoAcceptAgent = z
  .object({
    principalId: PrincipalId,
    handle: z.string(),
    /** The agent token of the principal; `null` for other principals. */
    tokenId: orNull(AgentTokenId),
    revoked: z.boolean(),
  })
  .meta({ id: 'AutoAcceptAgent', description: 'An agent a rule can be narrowed to.' });
export type AutoAcceptAgent = z.infer<typeof AutoAcceptAgent>;

/** One immutable revision of a rule. */
export const AutoAcceptRuleRevision = z
  .object({
    revision: z.number().int().min(1),
    name: z.string(),
    enabled: z.boolean(),
    note: z.string().nullable(),
    kind: AutoAcceptKind,
    tier: AutoAcceptTier,
    minConfidence: z.number().min(MIN_AUTO_ACCEPT_CONFIDENCE).max(1),
    relationType: orNull(AutoAcceptRelationType),
    agentPrincipalId: orNull(PrincipalId),
    llmModel: z.string().nullable(),
    includeAdHoc: z.boolean(),
    /** The author: the owner the decisions of this revision are recorded under. */
    author: AutoAcceptPrincipal,
    /** Client the author wrote it on (`proa-web`, `proa-cli`). */
    clientId: z.string().nullable(),
    at: Timestamp,
  })
  .meta({ id: 'AutoAcceptRuleRevision', description: 'One immutable revision of a rule.' });
export type AutoAcceptRuleRevision = z.infer<typeof AutoAcceptRuleRevision>;

/** What a rule has accepted so far (from the auto-accept ledger). */
export const AutoAcceptRuleStats = z
  .object({
    /** Accepted by the rule and still in force. */
    inForce: z.number().int().min(0),
    /** Revoked by an owner. */
    revoked: z.number().int().min(0),
    /** A human accepted (re-confirmed) the item since. */
    confirmed: z.number().int().min(0),
    /** A human rejected, corrected or held the item since. */
    overruled: z.number().int().min(0),
    lastAcceptedAt: orNull(Timestamp),
  })
  .meta({ id: 'AutoAcceptRuleStats', description: 'What a rule has accepted so far.' });
export type AutoAcceptRuleStats = z.infer<typeof AutoAcceptRuleStats>;

/** A rule at its head revision (ETag `"r<revision>"`). */
export const AutoAcceptRule = z
  .object({
    id: AutoAcceptRuleId,
    kind: AutoAcceptKind,
    /** The head revision. */
    revision: z.number().int().min(1),
    name: z.string(),
    enabled: z.boolean(),
    note: z.string().nullable(),
    tier: AutoAcceptTier,
    minConfidence: z.number().min(MIN_AUTO_ACCEPT_CONFIDENCE).max(1),
    relationType: orNull(AutoAcceptRelationType),
    agentPrincipalId: orNull(PrincipalId),
    /** The agent of `agentPrincipalId`. */
    agent: orNull(AutoAcceptAgent),
    llmModel: z.string().nullable(),
    includeAdHoc: z.boolean(),
    /** Author of the head revision: decisions are recorded under this owner. */
    author: AutoAcceptPrincipal,
    /** The author still has the owner role; otherwise the rule matches nothing. */
    authorIsOwner: z.boolean(),
    createdBy: AutoAcceptPrincipal,
    createdAt: Timestamp,
    /** When the head revision was written. */
    updatedAt: Timestamp,
    stats: AutoAcceptRuleStats,
  })
  .meta({ id: 'AutoAcceptRule', description: 'An auto-accept rule at its head revision.' });
export type AutoAcceptRule = z.infer<typeof AutoAcceptRule>;

/** A rule with every revision, oldest first. */
export const AutoAcceptRuleDetail = AutoAcceptRule.extend({
  revisions: z.array(AutoAcceptRuleRevision),
}).meta({ id: 'AutoAcceptRuleDetail', description: 'An auto-accept rule with its revisions.' });
export type AutoAcceptRuleDetail = z.infer<typeof AutoAcceptRuleDetail>;

/**
 * Decision 9 as a fixed system rule: the rule tier (`proa-rules`) accepts an
 * unambiguous call (a static `calledElement` naming exactly one other
 * process) at ingest. Always on, never stored as an auto-accept rule, not
 * editable.
 */
export const AutoAcceptSystemRule = z
  .object({
    id: z.literal(RULES_PROCEDURE),
    name: z.string(),
    description: z.string(),
    kind: z.literal('relation'),
    relationType: z.literal('call'),
    readOnly: z.literal(true),
    /** Relations whose acceptance rests on the rule tier's decision now. */
    accepted: z.number().int().min(0),
  })
  .meta({ id: 'AutoAcceptSystemRule', description: 'The built-in rule of decision 9.' });
export type AutoAcceptSystemRule = z.infer<typeof AutoAcceptSystemRule>;

export const AutoAcceptRuleList = z
  .object({
    /** In creation order (the first matching rule is recorded). */
    items: z.array(AutoAcceptRule),
    system: AutoAcceptSystemRule,
  })
  .meta({ id: 'AutoAcceptRuleList', description: "A project's auto-accept rules." });
export type AutoAcceptRuleList = z.infer<typeof AutoAcceptRuleList>;

export const SaveAutoAcceptRuleResult = z
  .object({
    /** `unchanged`: the draft equals the head; no revision was written. */
    outcome: z.enum(['created', 'revised', 'unchanged']),
    rule: AutoAcceptRuleDetail,
  })
  .meta({ id: 'SaveAutoAcceptRuleResult', description: 'The rule after a create or an edit.' });
export type SaveAutoAcceptRuleResult = z.infer<typeof SaveAutoAcceptRuleResult>;

const SubjectId = z.union([RelationId, PlacementId]);
const AssertionRef = z.union([AssertionId, PlacementAssertionId]);

/**
 * The subject of an auto-acceptance: a relation (`type`, `from`, `to`) or a
 * placement (`valueChainKey`, `step`, `process`); the other kind's fields are `null`.
 */
const subjectShape = {
  kind: AutoAcceptKind,
  /** The relation or placement. */
  id: SubjectId,
  status: RelationStatus,
  endpointState: EndpointState,
  type: orNull(AutoAcceptRelationType),
  from: orNull(Ref),
  to: orNull(Ref),
  valueChainKey: z.string().nullable(),
  /** The step's element id (or `@outside`). */
  step: z.string().nullable(),
  process: orNull(Ref),
};

/** An open proposal a rule accepts (preview, dry run) or accepted (apply). */
export const AutoAcceptItem = z
  .object({
    ...subjectShape,
    /** The agent proposal that meets the rule (highest confidence, then the earliest). */
    triggerId: AssertionRef,
    agent: AutoAcceptPrincipal,
    llmModel: z.string().nullable(),
    tier: Tier,
    confidence: z.number().min(0).max(1),
  })
  .meta({ id: 'AutoAcceptItem', description: 'An open proposal a rule accepts.' });
export type AutoAcceptItem = z.infer<typeof AutoAcceptItem>;

/** What a rule would have done in the project's history so far. */
export const AutoAcceptPreviewHistory = z
  .object({
    /** Agent-proposed items a human decided (the rule's kind and type): the denominator. */
    decided: z.number().int().min(0),
    /** Of those, the items the rule would have accepted. */
    wouldAccept: z.number().int().min(0),
    /** … and the human's first decision after the rule would have fired. */
    accepted: z.number().int().min(0),
    rejected: z.number().int().min(0),
    corrected: z.number().int().min(0),
    held: z.number().int().min(0),
    /** Would have accepted; accepted by an auto-accept rule and never reviewed (no ground truth). */
    autoUnreviewed: z.number().int().min(0),
    /** Would have accepted; still undecided. */
    undecided: z.number().int().min(0),
    /** accepted / (accepted + rejected + corrected); `null` without such decisions. */
    precision: z.number().min(0).max(1).nullable(),
  })
  .meta({ id: 'AutoAcceptPreviewHistory', description: 'What a rule would have accepted so far.' });
export type AutoAcceptPreviewHistory = z.infer<typeof AutoAcceptPreviewHistory>;

/** One minimum confidence of the preview's curve, the other criteria unchanged. */
export const AutoAcceptCurvePoint = z
  .object({
    minConfidence: z.number().min(MIN_AUTO_ACCEPT_CONFIDENCE).max(1),
    wouldAccept: z.number().int().min(0),
    accepted: z.number().int().min(0),
    rejected: z.number().int().min(0),
    corrected: z.number().int().min(0),
    held: z.number().int().min(0),
    precision: z.number().min(0).max(1).nullable(),
    /** Open proposals it would accept now. */
    open: z.number().int().min(0),
  })
  .meta({ id: 'AutoAcceptCurvePoint', description: 'The preview at one minimum confidence.' });
export type AutoAcceptCurvePoint = z.infer<typeof AutoAcceptCurvePoint>;

export const AutoAcceptPreview = z
  .object({
    kind: AutoAcceptKind,
    history: AutoAcceptPreviewHistory,
    open: z.object({
      /** Open proposals the rule would accept now (what "apply" would do). */
      count: z.number().int().min(0),
      /** The first of them. */
      items: z.array(AutoAcceptItem),
      /** Open proposals that meet the criteria but a safeguard blocks, per reason. */
      blocked: z.array(AutoAcceptBlockedCount),
    }),
    curve: z.array(AutoAcceptCurvePoint),
    /** Agents with proposals of this kind in the project, and their tokens. */
    agents: z.array(AutoAcceptAgent),
    /** LLM models declared by those proposals. */
    llmModels: z.array(z.string()),
  })
  .meta({ id: 'AutoAcceptPreview', description: 'What a rule would accept, so far and now.' });
export type AutoAcceptPreview = z.infer<typeof AutoAcceptPreview>;

/** `?dryRun=true` of the apply and revocation actions. */
export const AutoAcceptDryRunQuery = z.object({
  dryRun: z.enum(['true', 'false']).optional(),
});
export type AutoAcceptDryRunQuery = z.infer<typeof AutoAcceptDryRunQuery>;

/**
 * Apply a rule to the open proposals (rules are never retroactive otherwise):
 * a dry run first, then the real call with the head `revision` and the dry
 * run's count as `expectedCount` (409 `conflict` with the fresh numbers if
 * either changed).
 */
export const ApplyAutoAcceptBody = z
  .object({
    /** The head revision the owner previewed (required for the real call). */
    revision: z.number().int().min(1).optional(),
    /** The dry run's `count` (required for the real call). */
    expectedCount: z.number().int().min(0).optional(),
  })
  .meta({ id: 'ApplyAutoAcceptBody', description: 'Apply a rule to the open proposals.' });
export type ApplyAutoAcceptBody = z.infer<typeof ApplyAutoAcceptBody>;

export const ApplyAutoAcceptResult = z
  .object({
    dryRun: z.boolean(),
    ruleId: AutoAcceptRuleId,
    revision: z.number().int().min(1),
    /**
     * The head revision is enabled. A dry run evaluates the head also while it
     * is off; the real call needs it on (409 `conflict` with `reason`
     * `rule-disabled` otherwise).
     */
    enabled: z.boolean(),
    /**
     * The head's author is still an owner. Otherwise the rule matches nothing
     * until an owner saves it again (taking it over); the real call answers
     * 409 `conflict` with `reason` `author-not-owner`.
     */
    authorIsOwner: z.boolean(),
    /** Proposals accepted (or, in a dry run, that would be). */
    count: z.number().int().min(0),
    items: z.array(AutoAcceptItem),
    truncated: z.boolean(),
    blocked: z.array(AutoAcceptBlockedCount),
  })
  .meta({ id: 'ApplyAutoAcceptResult', description: 'What applying a rule did or would do.' });
export type ApplyAutoAcceptResult = z.infer<typeof ApplyAutoAcceptResult>;

/** The state of an auto-acceptance. */
export const AutoAcceptLedgerState = z.enum(['in-force', 'revoked', 'human-decided']).meta({
  id: 'AutoAcceptLedgerState',
  description:
    'In force, revoked by an owner, or decided by a human since (a human decision always wins).',
});
export type AutoAcceptLedgerState = z.infer<typeof AutoAcceptLedgerState>;

/** One auto-acceptance: what the review UI marks ("Automatisch angenommen – Regel „…“"). */
export const AutoAcceptLedgerEntry = z
  .object({
    ...subjectShape,
    /** The decision recorded by the rule. */
    decisionId: AssertionRef,
    /** The agent proposal that triggered it. */
    triggerId: AssertionRef,
    ruleId: AutoAcceptRuleId,
    revision: z.number().int().min(1),
    /** The rule's name in the deciding revision. */
    ruleName: z.string(),
    /** The owner the decision is recorded under (the revision's author). */
    decidedBy: AutoAcceptPrincipal,
    /** The agent of the triggering proposal. */
    agent: AutoAcceptPrincipal,
    llmModel: z.string().nullable(),
    tier: orNull(Tier),
    confidence: z.number().min(0).max(1).nullable(),
    at: Timestamp,
    state: AutoAcceptLedgerState,
    /** `human-decided`: the human's first decision since (`correct`: a rejection with a correction). */
    laterVerdict: z.enum(['accept', 'reject', 'hold', 'correct']).nullable(),
    laterAt: orNull(Timestamp),
    /** `revoked`: the revocation (a human withdrawal under the decision's principal). */
    revocationId: orNull(AssertionRef),
    revokedAt: orNull(Timestamp),
  })
  .meta({ id: 'AutoAcceptLedgerEntry', description: 'One auto-acceptance and its state.' });
export type AutoAcceptLedgerEntry = z.infer<typeof AutoAcceptLedgerEntry>;

export const AutoAcceptLedgerQuery = z.object({
  kind: AutoAcceptKind.optional(),
  ruleId: AutoAcceptRuleId.optional(),
  state: AutoAcceptLedgerState.optional(),
  /** The agent of the triggering proposal. */
  agentPrincipalId: PrincipalId.optional(),
});
export type AutoAcceptLedgerQuery = z.infer<typeof AutoAcceptLedgerQuery>;

export const AutoAcceptLedger = z
  .object({
    /** Oldest first. */
    items: z.array(AutoAcceptLedgerEntry),
  })
  .meta({ id: 'AutoAcceptLedger', description: "A project's auto-acceptances." });
export type AutoAcceptLedger = z.infer<typeof AutoAcceptLedger>;

/**
 * Revoke auto-acceptances in bulk: by rule (optionally one revision), by the
 * agent whose proposals triggered them, by kind, or by ids (relations and
 * placements, e.g. one item from the review screen). Only acceptances still
 * in force are revoked; an item a human decided since is never touched. A
 * dry run first, then the real call with its `count` as `expectedCount`.
 */
export const AutoAcceptRevocationBody = z
  .object({
    ruleId: AutoAcceptRuleId.optional(),
    /** Only acceptances of this revision of `ruleId`. */
    revision: z.number().int().min(1).optional(),
    /** Only acceptances triggered by this agent's proposals. */
    agentPrincipalId: PrincipalId.optional(),
    kind: AutoAcceptKind.optional(),
    ids: z.array(SubjectId).min(1).max(MAX_AUTO_ACCEPT_IDS).optional(),
    /** Added to the revocation's rationale. */
    reason: plainText(z.string().trim().min(1).max(MAX_AUTO_ACCEPT_REASON_CHARS)).optional(),
    /** The dry run's `count` (required for the real call). */
    expectedCount: z.number().int().min(0).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.ruleId === undefined && b.agentPrincipalId === undefined && b.ids === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ruleId'],
        message: 'name a rule, an agent or ids',
      });
    }
    if (b.revision !== undefined && b.ruleId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['revision'], message: 'a revision needs a ruleId' });
    }
  })
  .meta({ id: 'AutoAcceptRevocationBody', description: 'Revoke auto-acceptances in bulk.' });
export type AutoAcceptRevocationBody = z.infer<typeof AutoAcceptRevocationBody>;

/** One revoked auto-acceptance and the status its item returns to. */
export const AutoAcceptRevocationItem = AutoAcceptLedgerEntry.extend({
  /**
   * `proposed`: a live proposal remains, back in review; `obsolete`: none
   * remains (its judgement was lost, the agents judge it again).
   */
  outcome: z.enum(['proposed', 'obsolete']),
}).meta({ id: 'AutoAcceptRevocationItem', description: 'One revoked auto-acceptance.' });
export type AutoAcceptRevocationItem = z.infer<typeof AutoAcceptRevocationItem>;

export const AutoAcceptRevocationResult = z
  .object({
    dryRun: z.boolean(),
    /** Acceptances in force revoked (or, in a dry run, that would be). */
    count: z.number().int().min(0),
    toProposed: z.number().int().min(0),
    toObsolete: z.number().int().min(0),
    /** Selected acceptances a human decided since: left unchanged. */
    humanDecidedSince: z.number().int().min(0),
    /** Selected acceptances revoked before. */
    alreadyRevoked: z.number().int().min(0),
    items: z.array(AutoAcceptRevocationItem),
    truncated: z.boolean(),
  })
  .meta({
    id: 'AutoAcceptRevocationResult',
    description: 'What a revocation did or would do.',
  });
export type AutoAcceptRevocationResult = z.infer<typeof AutoAcceptRevocationResult>;
