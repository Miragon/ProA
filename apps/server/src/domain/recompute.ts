/**
 * Project-wide recomputation after an ingest or a delete (CONCEPT §2, §3):
 * run the rule tier over the head facts, record the rule's assertions,
 * recompute every relation's status and endpoint state, and replace the
 * findings. Runs inside the writing transaction.
 */
import { isDeepStrictEqual } from 'node:util';

import { newId, type PrincipalId, type ProjectId, type RelationType } from '@proa/contracts';

import { headFingerprints } from './fingerprints.ts';
import type { AnalysisPort, AssertionRecord, RelationRecord, Tx } from './ports.ts';
import {
  byRelation,
  derivedState,
  naturalKey,
  prepareAssertion,
  refreshRelation,
} from './relation-state.ts';
import { currentStances, decisionsInForce, type AssertionView } from './status.ts';

export interface RecomputeContext {
  tx: Tx;
  projectId: ProjectId;
  /** The system principal `proa-rules` that rule assertions are recorded under. */
  rulesPrincipalId: PrincipalId;
  analysis: Pick<AnalysisPort, 'runRules'>;
}

export interface RecomputeSummary {
  /** New rule assertions (proposals and decisions). */
  asserted: number;
  withdrawn: number;
  endpointChanges: number;
  findings: number;
}

interface DesiredAssertion {
  kind: 'proposal' | 'decision';
  verdict: 'accept' | null;
  tier: AssertionView['tier'];
  confidence: number | null;
  fromFp: string | null;
  toFp: string | null;
}

function matches(stance: AssertionView, desired: DesiredAssertion): boolean {
  return (
    stance.kind === desired.kind &&
    stance.verdict === desired.verdict &&
    stance.tier === desired.tier &&
    stance.confidence === desired.confidence &&
    stance.fromFp === desired.fromFp &&
    stance.toFp === desired.toFp
  );
}

/**
 * Rule assertions follow the rules: on every run the rule tier re-derives its
 * relations. For each derived relation the rule principal holds exactly one
 * live stance, re-asserted when tier, confidence or endpoint fingerprints
 * change:
 * - an unambiguous `call` is a rule decision `accept` (the only decision the
 *   rule tier may make), unless a human has decided the relation; then the
 *   rule only proposes, so a human rejection stays until the endpoints change;
 * - everything else (key-tier messages and signals, ambiguous calls) is a
 *   rule proposal.
 * A rule stance the rules no longer derive is withdrawn, except an
 * acceptance whose endpoint is missing (deleted model or element): it stays
 * accepted with `endpoint_state = missing`, an open item.
 */
export async function recomputeProject(ctx: RecomputeContext): Promise<RecomputeSummary> {
  const { tx, projectId, rulesPrincipalId } = ctx;
  const summary: RecomputeSummary = { asserted: 0, withdrawn: 0, endpointChanges: 0, findings: 0 };

  const projectFacts = await tx.facts.headProjectFacts(projectId);
  const fps = headFingerprints(projectFacts);
  /** Head fingerprints of both endpoints, by the fact kinds of the relation type. */
  const endpointsOf = (r: { type: RelationType; fromRef: string; toRef: string }) => ({
    from: fps.get(r.type, 'from', r.fromRef),
    to: fps.get(r.type, 'to', r.toRef),
  });
  const rules = ctx.analysis.runRules(projectFacts);

  const relations = new Map<string, RelationRecord>();
  for (const r of await tx.relations.all(projectId)) {
    relations.set(naturalKey(r.type, r.fromRef, r.toRef), r);
  }
  const history = byRelation<AssertionView & { relationId: RelationRecord['id'] }>(
    await tx.assertions.listForProject(projectId),
  );
  /** Relations created by this run (their row already holds the final state). */
  const fresh = new Set<string>();
  /** Relations with a new assertion in this run (their version moves). */
  const touched = new Set<string>();

  const ruleInput = (
    a: Pick<AssertionRecord, 'kind' | 'verdict' | 'tier' | 'confidence' | 'fromFp' | 'toFp'>,
  ) => ({
    ...a,
    sourceKind: 'rule' as const,
    principalId: rulesPrincipalId,
    clientId: null,
    declared: null,
    submissionId: null,
    rationale: null,
    evidence: null,
    question: null,
    label: null,
    linkedRelationId: null,
  });

  // 1. Derived relations: create, re-assert or leave as they are.
  const derived = new Set<string>();
  for (const d of rules.relations) {
    const key = naturalKey(d.type, d.from, d.to);
    if (derived.has(key)) continue;
    derived.add(key);

    const existing = relations.get(key);
    const id = existing?.id ?? newId('relation');
    const hist = history.get(id) ?? [];
    const stances = currentStances(hist);
    const ruleStance = stances.find((s) => s.principalId === rulesPrincipalId);
    const humanDecided = decisionsInForce(hist).some((s) => s.principalId !== rulesPrincipalId);
    // The policy limits rule decisions to `call` relations (CONCEPT §2).
    const decide = d.status === 'accepted' && d.type === 'call' && !humanDecided;
    const target = { id, type: d.type, fromRef: d.from, toRef: d.to };
    const current = endpointsOf(target);
    const desired: DesiredAssertion = {
      kind: decide ? 'decision' : 'proposal',
      verdict: decide ? 'accept' : null,
      tier: d.tier,
      confidence: d.confidence,
      fromFp: current.from ?? null,
      toFp: current.to ?? null,
    };

    const assertion =
      ruleStance && matches(ruleStance, desired)
        ? null
        : await prepareAssertion(tx, projectId, target, ruleInput(desired));
    if (assertion) {
      hist.push(assertion);
      history.set(id, hist);
      touched.add(id);
      summary.asserted++;
    }

    if (!existing) {
      const state = derivedState({ tier: d.tier }, hist, current);
      const stored = await tx.relations.insert({
        ...target,
        projectId,
        ...state,
        version: 1,
        attrs: d.attrs,
      });
      relations.set(key, stored);
      fresh.add(id);
    } else if (!isDeepStrictEqual(existing.attrs, d.attrs)) {
      const stored = await tx.relations.update(projectId, existing.id, { attrs: d.attrs });
      relations.set(key, stored);
    }
    if (assertion) await tx.assertions.insert(assertion);
  }

  // 2. Rule stances the rules no longer derive.
  for (const [key, relation] of relations) {
    if (derived.has(key)) continue;
    const hist = history.get(relation.id) ?? [];
    const ruleStance = currentStances(hist).find((s) => s.principalId === rulesPrincipalId);
    if (!ruleStance) continue;
    const current = endpointsOf(relation);
    const missing = current.from === undefined || current.to === undefined;
    if (ruleStance.kind === 'decision' && missing) continue;
    const withdrawal = await prepareAssertion(
      tx,
      projectId,
      relation,
      ruleInput({
        kind: 'withdrawal',
        verdict: null,
        tier: null,
        confidence: null,
        fromFp: current.from ?? null,
        toFp: current.to ?? null,
      }),
    );
    await tx.assertions.insert(withdrawal);
    hist.push(withdrawal);
    history.set(relation.id, hist);
    touched.add(relation.id);
    summary.withdrawn++;
  }

  // 3. Status, tier and endpoint state of every relation.
  for (const relation of relations.values()) {
    if (fresh.has(relation.id)) continue;
    const { endpointChanged } = await refreshRelation(
      tx,
      projectId,
      relation,
      history.get(relation.id) ?? [],
      endpointsOf(relation),
      { touched: touched.has(relation.id), principalId: rulesPrincipalId, clientId: null },
    );
    if (endpointChanged) summary.endpointChanges++;
  }

  await tx.findings.replace(projectId, rules.findings);
  summary.findings = rules.findings.length;
  return summary;
}
