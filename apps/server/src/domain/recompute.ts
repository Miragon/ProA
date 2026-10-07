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
import { currentStances, endpointState, recomputeStatus, type AssertionView } from './status.ts';

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

function naturalKey(type: RelationType, from: string, to: string): string {
  return `${type}\u0000${from}\u0000${to}`;
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
  const history = new Map<string, AssertionView[]>();
  for (const a of await tx.assertions.listForProject(projectId)) {
    const list = history.get(a.relationId) ?? [];
    list.push(a);
    history.set(a.relationId, list);
  }
  const fresh = new Set<string>();

  async function assert(
    relation: Pick<RelationRecord, 'id' | 'type' | 'fromRef' | 'toRef'>,
    a: Omit<
      AssertionRecord,
      | 'id'
      | 'projectId'
      | 'relationId'
      | 'seq'
      | 'principalId'
      | 'sourceKind'
      | 'clientId'
      | 'rationale'
    >,
  ): Promise<AssertionRecord> {
    const type =
      a.kind === 'decision'
        ? 'relation.decided'
        : a.kind === 'withdrawal'
          ? 'relation.withdrawn'
          : 'relation.proposed';
    const seq = await tx.events.append(projectId, {
      type,
      principalId: rulesPrincipalId,
      clientId: null,
      subjectRef: relation.id,
      payload: {
        relationId: relation.id,
        type: relation.type,
        from: relation.fromRef,
        to: relation.toRef,
        sourceKind: 'rule',
        ...(a.verdict ? { verdict: a.verdict } : {}),
        ...(a.tier ? { tier: a.tier, confidence: a.confidence } : {}),
      },
    });
    return {
      ...a,
      id: newId('assertion'),
      projectId,
      relationId: relation.id,
      seq,
      sourceKind: 'rule',
      principalId: rulesPrincipalId,
      clientId: null,
      rationale: null,
    };
  }

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
    const humanDecided = stances.some(
      (s) => s.kind === 'decision' && s.principalId !== rulesPrincipalId,
    );
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
      ruleStance && matches(ruleStance, desired) ? null : await assert(target, desired);
    if (assertion) {
      hist.push(assertion);
      history.set(id, hist);
      summary.asserted++;
    }

    if (!existing) {
      const state = recomputeStatus(hist);
      // The database sets created_at/updated_at (DEFAULT now()); passing the
      // in-memory placeholders below would store 1970-01-01.
      const row: Omit<RelationRecord, 'createdAt' | 'updatedAt'> = {
        ...target,
        projectId,
        status: state.status,
        endpointState: endpointState(state.anchor, current),
        tier: state.tier ?? d.tier,
        confidence: state.confidence,
        version: 1,
        attrs: d.attrs,
        fromFp: state.anchor?.fromFp ?? null,
        toFp: state.anchor?.toFp ?? null,
      };
      await tx.relations.insert(row);
      // Only this run reads the in-memory copy, and never its timestamps.
      relations.set(key, { ...row, createdAt: new Date(0), updatedAt: new Date(0) });
      fresh.add(id);
    } else if (!isDeepStrictEqual(existing.attrs, d.attrs)) {
      await tx.relations.update(projectId, existing.id, { attrs: d.attrs });
      existing.attrs = d.attrs;
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
    const withdrawal = await assert(relation, {
      kind: 'withdrawal',
      verdict: null,
      tier: null,
      confidence: null,
      fromFp: current.from ?? null,
      toFp: current.to ?? null,
    });
    await tx.assertions.insert(withdrawal);
    hist.push(withdrawal);
    history.set(relation.id, hist);
    summary.withdrawn++;
  }

  // 3. Status, tier and endpoint state of every relation.
  for (const relation of relations.values()) {
    if (fresh.has(relation.id)) continue;
    const state = recomputeStatus(history.get(relation.id) ?? []);
    const ep = endpointState(state.anchor, endpointsOf(relation));
    const patch = {
      status: state.status,
      endpointState: ep,
      tier: state.tier ?? relation.tier,
      confidence: state.confidence,
      fromFp: state.anchor?.fromFp ?? null,
      toFp: state.anchor?.toFp ?? null,
    };
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
      (k) => patch[k] !== relation[k],
    );
    if (!changed) continue;
    await tx.relations.update(projectId, relation.id, patch);
    if (ep !== relation.endpointState && state.status !== 'obsolete') {
      summary.endpointChanges++;
      await tx.events.append(projectId, {
        type: 'relation.endpoint_changed',
        principalId: rulesPrincipalId,
        clientId: null,
        subjectRef: relation.id,
        payload: {
          relationId: relation.id,
          type: relation.type,
          from: relation.fromRef,
          to: relation.toRef,
          previous: relation.endpointState,
          endpointState: ep,
        },
      });
    }
  }

  await tx.findings.replace(projectId, rules.findings);
  summary.findings = rules.findings.length;
  return summary;
}
