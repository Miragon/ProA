/**
 * Key-tier rule proposals of placements (M4 §2 "Tiers", S2): a step whose
 * `link` is `proa:process/<ref>` of a head process, or whose non-empty
 * normalized name equals the normalized name of a head process (the process
 * fact's label: process name, else pool name), yields a proposal of that
 * process on the step, recorded under the rule tier's system principal
 * `proa-rules` (`source_kind = 'rule'`, no client, tier `key`, confidence
 * 1.0). Rule proposals follow the rules: they are derived again after every
 * chain save (create, revive, revise) and every model ingest or deletion, and
 * a rule proposal that is no longer derived is withdrawn. A pasted step keeps
 * its link, so a duplicated link yields one proposal per step. Nothing is
 * auto-accepted; a human decision on the same fingerprints suppresses the
 * proposal (`classifyPlacementProposal`), and supersession and token
 * revocation, which end agent proposals, never touch rule proposals.
 */
import { PROA_PROCESS_LINK_PREFIX, type PrincipalId, type Ref } from '@proa/contracts';
import { derivePlacementRules, quoteDe } from '@proa/relations';

import type { Actor } from '../actor.ts';
import type { HeadFact, PlacementAssertionRecord, PlacementRecord, Tx } from '../ports.ts';
import { currentStances } from '../status.ts';
import type { ChainState } from './chain-state.ts';
import { byPlacement, placementKey } from './placement-state.ts';
import {
  applyPlacementProposal,
  withdrawPlacementStance,
  type PlacementContext,
} from './placements.ts';
import type { ChainStep } from './structure.ts';

/** Confidence of a rule proposal. */
export const RULE_CONFIDENCE = 1;

/** The rationale of a withdrawn rule proposal (German, like the review UI). */
export const RULE_WITHDRAWAL =
  'Nicht mehr abgeleitet: Weder der Link noch der Name des Schritts nennt den Prozess.';

/** A placement the rule tier proposes. */
export interface DerivedRulePlacement {
  elementId: string;
  processRef: Ref;
  /** The step's `link` is `proa:process/<processRef>`. */
  byLink: boolean;
  /** The step's normalized name equals the process's. */
  byName: boolean;
  /** Names the link or the equal (normalized) name; stable while the fingerprints are. */
  rationale: string;
  /** `[processRef, step:<elementId>]`. */
  evidence: string[];
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The German rationale of a rule proposal: the link (ref verbatim) and/or the
 * normalized name in „…“. Stable while the fingerprints are, so a case-only
 * rename records nothing.
 */
function ruleRationale(processRef: Ref, nameNorm: string, byLink: boolean, byName: boolean) {
  const parts: string[] = [];
  if (byLink) {
    parts.push(
      `der Link des Schritts nennt diesen Prozess (${PROA_PROCESS_LINK_PREFIX}${processRef})`,
    );
  }
  if (byName) {
    parts.push(
      `der Name des Schritts entspricht dem Prozessnamen (normalisiert: ${quoteDe(nameNorm)})`,
    );
  }
  return `Schlüsselregel: ${parts.join('; ')}.`;
}

/**
 * The rule tier's placements of a chain revision, in code point order of
 * step id, then process ref: `derivePlacementRules` of `@proa/relations`
 * (the derivation `eval:placements` gates on the golden chains), plus the
 * rationale and the evidence. Pure.
 *
 * @param steps the head's steps (`ChainStructure.steps`)
 * @param processFacts the head's `process` facts
 */
export function derivedRulePlacements(
  steps: readonly Pick<ChainStep, 'elementId' | 'nameNorm' | 'link'>[],
  processFacts: readonly Pick<HeadFact, 'kind' | 'ref' | 'label'>[],
): DerivedRulePlacement[] {
  const matches = derivePlacementRules(
    steps.map((s) => ({ id: s.elementId, nameNorm: s.nameNorm, link: s.link })),
    processFacts.filter((f) => f.kind === 'process').map((f) => ({ ref: f.ref, label: f.label })),
  );
  return matches.map((m) => ({
    elementId: m.stepId,
    processRef: m.processRef as Ref,
    byLink: m.byLink,
    byName: m.byName,
    rationale: ruleRationale(m.processRef as Ref, m.nameNorm, m.byLink, m.byName),
    evidence: [m.processRef, `step:${m.stepId}`],
  }));
}

/** The rule tier as an actor (rule proposals are recorded under its principal, no client). */
export function rulesActor(principalId: PrincipalId): Actor {
  return {
    principalId,
    kind: 'service',
    handle: 'proa-rules',
    clientId: null,
    interactive: false,
    scopes: [],
    binding: null,
  };
}

/** Natural key order (element id, generation, process ref), so events come in a stable order. */
function byNaturalKey(a: PlacementRecord, b: PlacementRecord): number {
  return (
    byCodePoint(a.elementId, b.elementId) ||
    a.generation - b.generation ||
    byCodePoint(a.processRef, b.processRef)
  );
}

export interface RuleRecompute {
  /** Rule proposals recorded (`applied` or `reopened`). */
  proposed: number;
  /** Rule proposals withdrawn because the rules no longer derive them. */
  withdrawn: number;
}

/**
 * Derives the rule tier's placements for the chain's head and records them
 * with `applyPlacementProposal` (`proposer` = the rule tier, tier `key`,
 * confidence 1.0, evidence `[process ref, step:<id>]`): a proposal the rule
 * principal already holds on the same fingerprints is a `duplicate` and a
 * human decision on them suppresses it, so a run without changes writes
 * nothing. Then it withdraws every live rule proposal the rules no longer
 * derive (a renamed or re-linked step, a deleted process). Proposals and
 * withdrawals are recorded under `proa-rules` without a client. Callers run
 * it before `refreshPlacements` (after a model change in `sync.ts`, inside a
 * chain save before S1's refresh), so a re-asserted proposal keeps `ok` and a
 * withdrawn one turns obsolete without an `endpoint_changed`. The caller holds
 * the project lock.
 *
 * @param state the chain's state after the change (head, generations, head processes)
 * @param options.endpointCause whom an `endpoint_changed` of these writes
 *   names (a chain save: the saving human); default `proa-rules`
 */
export async function recomputeRulePlacements(
  tx: Tx,
  state: ChainState,
  rulesPrincipalId: PrincipalId,
  options: { endpointCause?: { principalId: PrincipalId; clientId: string | null } } = {},
): Promise<RuleRecompute> {
  const { chain } = state;
  const projectId = chain.projectId;
  const placements = await tx.placements.forChain(projectId, chain.id);
  const ctx: PlacementContext = {
    tx,
    projectId,
    actor: rulesActor(rulesPrincipalId),
    valueChainId: chain.id,
    endpoints: state.endpoints,
    placements: new Map(
      placements.map((p) => [placementKey(chain.id, p.elementId, p.generation, p.processRef), p]),
    ),
    histories: byPlacement<PlacementAssertionRecord>(
      await tx.placementAssertions.listForChain(projectId, chain.id),
    ),
    declared: null,
    submissionId: null,
    proposer: { sourceKind: 'rule', principalId: rulesPrincipalId },
    ...(options.endpointCause ? { endpointCause: options.endpointCause } : {}),
  };

  const result: RuleRecompute = { proposed: 0, withdrawn: 0 };
  const wanted = new Set<string>();
  for (const d of derivedRulePlacements(state.structure.steps, state.processFacts)) {
    const generation = state.live.get(d.elementId);
    if (generation === undefined) continue;
    wanted.add(placementKey(chain.id, d.elementId, generation, d.processRef));
    const { effect } = await applyPlacementProposal(ctx, {
      elementId: d.elementId,
      generation,
      processRef: d.processRef,
      tier: 'key',
      confidence: RULE_CONFIDENCE,
      rationale: d.rationale,
      evidence: d.evidence,
      question: null,
    });
    if (effect === 'applied' || effect === 'reopened') result.proposed++;
  }

  const stale = [...ctx.placements.entries()]
    .filter(([key]) => !wanted.has(key))
    .map(([, p]) => p)
    .sort(byNaturalKey);
  for (const placement of stale) {
    const stance = currentStances(ctx.histories.get(placement.id) ?? []).find(
      (a) => a.principalId === rulesPrincipalId && a.kind === 'proposal',
    );
    if (!stance) continue;
    await withdrawPlacementStance(ctx, placement, stance, RULE_WITHDRAWAL);
    result.withdrawn++;
  }
  return result;
}
