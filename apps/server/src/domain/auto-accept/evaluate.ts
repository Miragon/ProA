/**
 * Auto-accept rules (owner decision 19), pure part: whether an owner's rule
 * accepts an agent proposal, and the safeguards that keep it from doing so.
 * The write paths (`apply.ts`), "apply to open proposals", the preview and
 * its history replay all go through these functions.
 *
 * A rule matches a proposal when it is enabled, its author still is an
 * owner, kind and tier are equal, the confidence reaches the minimum
 * (inclusive), and type, agent, model and the ad-hoc switch fit. The first
 * matching rule in creation order is the one recorded. The safeguards are
 * conservative and checked in the order of `AUTO_ACCEPT_BLOCK_REASONS`; the
 * first that fails is the reason.
 */
import type {
  AssertionKind,
  AutoAcceptBlockReason,
  AutoAcceptKind,
  AutoAcceptRelationType,
  AutoAcceptRuleId,
  AutoAcceptTier,
  EndpointState,
  PrincipalId,
  RelationStatus,
  SourceKind,
  Tier,
} from '@proa/contracts';

import { currentStances, type StanceView } from '../status.ts';
import { OUTSIDE } from '../value-chain/steps.ts';

/** A rule (its head revision) as the evaluator applies it. */
export interface AutoAcceptRuleRev {
  ruleId: AutoAcceptRuleId;
  revision: number;
  kind: AutoAcceptKind;
  name: string;
  enabled: boolean;
  tier: AutoAcceptTier;
  minConfidence: number;
  relationType: AutoAcceptRelationType | null;
  agentPrincipalId: PrincipalId | null;
  llmModel: string | null;
  includeAdHoc: boolean;
  /** The revision's author: the acceptance is recorded under this owner. */
  authorId: PrincipalId;
  /** The client the author wrote the revision on; the acceptance carries it. */
  authorClientId: string | null;
  /** The author still has the owner role (else the rule matches nothing). */
  authorIsOwner: boolean;
  /** The rule's creation order (the seq of its creation). */
  order: number;
}

/** The proposal a rule is evaluated against. */
export interface TriggerView {
  id: string;
  principalId: PrincipalId;
  sourceKind: SourceKind;
  kind: AssertionKind;
  tier: Tier | null;
  confidence: number | null;
  question: string | null;
  llmModel: string | null;
  /** A pipeline proposal (from a submission, with a claim basis); else ad hoc. */
  pipeline: boolean;
  /** Its basis is current (an ad-hoc proposal, recorded under the lock, always is). */
  current: boolean;
}

export type AutoAcceptVerdict =
  { accept: true; rule: AutoAcceptRuleRev } | { accept: false; reason: AutoAcceptBlockReason };

/** What the safeguards read of an assertion of a history. */
export interface HistoryView extends StanceView {
  question: string | null;
}

/** The subject of a proposal, for the rule match. */
export interface RuleSubject {
  kind: AutoAcceptKind;
  /** Relations: the relation's type. */
  relationType?: string;
}

/** Whether the rule's criteria accept the proposal (the safeguards aside). */
export function ruleMatches(
  rule: AutoAcceptRuleRev,
  trigger: TriggerView,
  subject: RuleSubject,
): boolean {
  return (
    rule.enabled &&
    rule.authorIsOwner &&
    rule.kind === subject.kind &&
    trigger.tier === rule.tier &&
    trigger.confidence !== null &&
    trigger.confidence >= rule.minConfidence &&
    (rule.relationType === null || rule.relationType === subject.relationType) &&
    (rule.agentPrincipalId === null || rule.agentPrincipalId === trigger.principalId) &&
    (rule.llmModel === null || rule.llmModel === trigger.llmModel) &&
    (trigger.pipeline || rule.includeAdHoc)
  );
}

/** The first rule in creation order whose criteria accept the proposal. */
export function matchRule(
  rules: readonly AutoAcceptRuleRev[],
  trigger: TriggerView,
  subject: RuleSubject,
): AutoAcceptRuleRev | null {
  return (
    [...rules]
      .sort((a, b) => a.order - b.order)
      .find((rule) => ruleMatches(rule, trigger, subject)) ?? null
  );
}

const blocked = (reason: AutoAcceptBlockReason): AutoAcceptVerdict => ({ accept: false, reason });

/** The checks every kind shares, up to the subject's own state. */
function commonChecks(
  trigger: TriggerView,
  rules: readonly AutoAcceptRuleRev[],
  subject: RuleSubject,
  state: { status: RelationStatus; endpointState: EndpointState },
): AutoAcceptVerdict {
  if (trigger.sourceKind !== 'agent' || trigger.kind !== 'proposal') return blocked('not-agent');
  const rule = matchRule(rules, trigger, subject);
  if (!rule) return blocked('no-matching-rule');
  if (!trigger.current) return blocked('stale-proposal');
  if (state.status !== 'proposed') return blocked('not-open');
  if (state.endpointState !== 'ok') return blocked('endpoint-not-ok');
  return { accept: true, rule };
}

const asks = (a: HistoryView): boolean => a.question !== null && a.question.trim() !== '';

/** Live agent proposals of a history. */
function liveAgentProposals<T extends HistoryView>(history: readonly T[]): T[] {
  return currentStances(history).filter((a) => a.kind === 'proposal' && a.sourceKind === 'agent');
}

/**
 * Whether a rule accepts an agent's relation proposal. Safeguards after the
 * common ones: `competing-call` (another proposed, held or accepted call
 * leaves the same call element: a call has one target), `human-involved`
 * (any human assertion on the relation), `agent-question` (a live agent
 * proposal asks a question, the trigger's included) and `no-link` (a live
 * no-link of any agent on the typed pair, current or stale).
 */
export function evaluateRelationAutoAccept(src: {
  relation: { status: RelationStatus; endpointState: EndpointState; type: string };
  history: readonly HistoryView[];
  trigger: TriggerView;
  /** Live no-links on the typed pair (any principal, current or stale). */
  liveNoLinks: number;
  /** Another proposed, held or accepted call relation leaves the same call element. */
  competingCall: boolean;
  rules: readonly AutoAcceptRuleRev[];
}): AutoAcceptVerdict {
  const verdict = commonChecks(
    src.trigger,
    src.rules,
    { kind: 'relation', relationType: src.relation.type },
    src.relation,
  );
  if (!verdict.accept) return verdict;
  if (src.relation.type === 'call' && src.competingCall) return blocked('competing-call');
  if (src.history.some((a) => a.sourceKind === 'human')) return blocked('human-involved');
  if (liveAgentProposals(src.history).some(asks)) return blocked('agent-question');
  if (src.liveNoLinks > 0) return blocked('no-link');
  return verdict;
}

/** A placement as the placement safeguards see it. */
export interface PlacementSubjectView {
  id: string;
  status: RelationStatus;
  endpointState: EndpointState;
  elementId: string;
  generation: number;
}

/**
 * Whether a rule accepts an agent's placement proposal. Safeguards after the
 * common ones, at the level of the process (all its placements on the
 * chain): `outside` (never `@outside`), `step-removed`, `has-home-step` (any
 * placement of the process is accepted or held, on any generation: owner
 * decision 18), `competing-step` (a live proposal of any principal, the rule
 * tier included, on another step generation; this also covers an agent's
 * own second step and "more than one step meets the rule"),
 * `human-involved`, `agent-question` and `agent-unsure` (another agent's
 * `unsure` verdict on the process's current input, before this write).
 */
export function evaluatePlacementAutoAccept(src: {
  placement: PlacementSubjectView;
  /** The placement's step generation is live. */
  stepLive: boolean;
  /** Every placement of the process on the chain (this one included) with its history. */
  processPlacements: readonly {
    placement: PlacementSubjectView;
    history: readonly HistoryView[];
  }[];
  trigger: TriggerView;
  /** The process's `placement_input` row before this write; `current`: its hash is the current one. */
  priorVerdict: { principalId: PrincipalId; outcome: string; current: boolean } | null;
  rules: readonly AutoAcceptRuleRev[];
}): AutoAcceptVerdict {
  const verdict = commonChecks(src.trigger, src.rules, { kind: 'placement' }, src.placement);
  if (!verdict.accept) return verdict;
  const { placement } = src;
  if (placement.elementId === OUTSIDE) return blocked('outside');
  if (!src.stepLive) return blocked('step-removed');
  const others = src.processPlacements.filter((p) => p.placement.id !== placement.id);
  if (others.some((p) => p.placement.status === 'accepted' || p.placement.status === 'held')) {
    return blocked('has-home-step');
  }
  const elsewhere = others.filter(
    (p) =>
      p.placement.elementId !== placement.elementId ||
      p.placement.generation !== placement.generation,
  );
  if (elsewhere.some((p) => currentStances(p.history).some((a) => a.kind === 'proposal'))) {
    return blocked('competing-step');
  }
  const histories = src.processPlacements.map((p) => p.history);
  if (histories.some((h) => h.some((a) => a.sourceKind === 'human'))) {
    return blocked('human-involved');
  }
  if (histories.some((h) => liveAgentProposals(h).some(asks))) return blocked('agent-question');
  const prior = src.priorVerdict;
  if (
    prior?.outcome === 'unsure' &&
    prior.current &&
    prior.principalId !== src.trigger.principalId
  ) {
    return blocked('agent-unsure');
  }
  return verdict;
}

/** The trigger view of a stored proposal. */
export function triggerOf(
  a: {
    id: string;
    principalId: PrincipalId;
    sourceKind: SourceKind;
    kind: AssertionKind;
    tier: Tier | null;
    confidence: number | null;
    question: string | null;
    submissionId: string | null;
    declared: { llmModel: string | null } | null;
  },
  current: boolean,
): TriggerView {
  return {
    id: a.id,
    principalId: a.principalId,
    sourceKind: a.sourceKind,
    kind: a.kind,
    tier: a.tier,
    confidence: a.confidence,
    question: a.question,
    llmModel: a.declared?.llmModel ?? null,
    pipeline: a.submissionId !== null,
    current,
  };
}
