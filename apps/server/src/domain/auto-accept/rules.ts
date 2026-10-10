/**
 * Auto-accept rules (owner decision 19), pure part: the checks of a rule as
 * the owner writes it, whether an edit changes anything, and decision 9 as
 * the read-only system rule. The few defaults the owner may want to change
 * later (the 0.5 floor, unique names, ad hoc off) live here and in the
 * contracts as single constants.
 */
import {
  AUTO_ACCEPT_TIERS,
  MIN_AUTO_ACCEPT_CONFIDENCE,
  RULES_PROCEDURE,
  hasControlCharacters,
  type AutoAcceptRuleDraft,
  type AutoAcceptSystemRule,
  type PrincipalId,
} from '@proa/contracts';

import type { AutoAcceptRuleRevisionRecord } from '../ports.ts';

/**
 * Why a draft is refused (`validation-failed` with this `reason`). Over REST
 * only `unknown-agent` and `name-taken` reach a client: the contract's schema
 * refuses the others first (422 with `errors`); the domain checks them again
 * for every other caller.
 */
export type RuleDraftProblem =
  | 'kind-tier-mismatch'
  | 'type-not-for-placements'
  | 'unknown-agent'
  | 'name-taken'
  | 'confidence-out-of-range'
  | 'control-characters';

/** A rule name as compared for uniqueness: trimmed, lower case. */
export const nameKey = (name: string): string => name.trim().toLocaleLowerCase('de');

/**
 * The checks of a draft beyond its schema, in this order: tier of the kind,
 * no type on a placement rule, the confidence floor, control characters in
 * name, note and model, an unknown agent, a name another rule of the project
 * already has (ignoring case).
 *
 * @param names the head names of the project's other rules
 * @param agents the principals a rule may be narrowed to (the project's
 *   agent-token principals and service members)
 */
export function ruleDraftProblem(
  draft: AutoAcceptRuleDraft,
  names: readonly string[],
  agents: ReadonlySet<PrincipalId>,
): RuleDraftProblem | null {
  if (!(AUTO_ACCEPT_TIERS[draft.kind] as readonly string[]).includes(draft.tier)) {
    return 'kind-tier-mismatch';
  }
  if (draft.kind === 'placement' && draft.relationType !== null) return 'type-not-for-placements';
  if (
    !Number.isFinite(draft.minConfidence) ||
    draft.minConfidence < MIN_AUTO_ACCEPT_CONFIDENCE ||
    draft.minConfidence > 1
  ) {
    return 'confidence-out-of-range';
  }
  if (
    /\p{Cc}/u.test(draft.name) ||
    (draft.note !== null && hasControlCharacters(draft.note)) ||
    (draft.llmModel !== null && /\p{Cc}/u.test(draft.llmModel))
  ) {
    return 'control-characters';
  }
  if (draft.agentPrincipalId !== null && !agents.has(draft.agentPrincipalId)) {
    return 'unknown-agent';
  }
  const key = nameKey(draft.name);
  if (names.some((n) => nameKey(n) === key)) return 'name-taken';
  return null;
}

/** The fields of a revision a draft sets. */
export type DraftFields = Pick<
  AutoAcceptRuleRevisionRecord,
  | 'name'
  | 'enabled'
  | 'note'
  | 'tier'
  | 'minConfidence'
  | 'relationType'
  | 'agentPrincipalId'
  | 'llmModel'
  | 'includeAdHoc'
>;

/** The revision fields of a draft (name and note trimmed, an empty note as `null`). */
export function draftFields(draft: AutoAcceptRuleDraft): DraftFields {
  const note = draft.note?.trim() ?? null;
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    note: note === '' ? null : note,
    tier: draft.tier,
    minConfidence: draft.minConfidence,
    relationType: draft.kind === 'relation' ? draft.relationType : null,
    agentPrincipalId: draft.agentPrincipalId,
    llmModel: draft.llmModel,
    includeAdHoc: draft.includeAdHoc,
  };
}

/** Whether a draft's fields equal a revision's (an edit that changes nothing writes nothing). */
export function sameFields(head: DraftFields, next: DraftFields): boolean {
  return (
    head.name === next.name &&
    head.enabled === next.enabled &&
    head.note === next.note &&
    head.tier === next.tier &&
    head.minConfidence === next.minConfidence &&
    head.relationType === next.relationType &&
    head.agentPrincipalId === next.agentPrincipalId &&
    head.llmModel === next.llmModel &&
    head.includeAdHoc === next.includeAdHoc
  );
}

/**
 * Decision 9 as a system rule (German, as the review UI shows it): the rule
 * tier accepts an unambiguous call at ingest. Unchanged in behaviour and
 * recording (`proa-rules`, `source_kind = 'rule'`), never stored as an
 * auto-accept rule, never editable.
 */
export function systemRule(accepted: number): AutoAcceptSystemRule {
  return {
    id: RULES_PROCEDURE,
    name: 'Eindeutige Aufrufe',
    description:
      'Ein statischer Aufruf (calledElement), der genau einen anderen Prozess nennt, wird beim Import angenommen.',
    kind: 'relation',
    relationType: 'call',
    readOnly: true,
    accepted,
  };
}
