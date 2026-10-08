/**
 * Review (CONCEPT §3 "Review workflow", M2 items 4–5): human decisions
 * (accept, reject, hold, correct), bulk decisions, notes and the relation
 * timeline; ad-hoc proposals and their withdrawal. Deciding needs the
 * `review` permission: a user on an interactive client; agents get
 * `human-decision-required` with the review URL.
 */
import {
  newId,
  parseRef,
  reviewPath,
  type BulkDecisionBody,
  type BulkDecisionResult,
  type DecisionBody,
  type DecisionResult,
  type NoteBody,
  type ProjectId,
  type ProposeRelationBody,
  type ProposeRelationResult,
  type Ref,
  type Relation,
  type RelationAssertion,
  type RelationAssertionList,
  type RelationId,
  type Verdict,
} from '@proa/contracts';

import { sourceKindOf, type Actor } from '../actor.ts';
import { DomainError } from '../errors.ts';
import { headFingerprints, type HeadFingerprints } from '../fingerprints.ts';
import { policy, type ProjectAccess } from '../policy.ts';
import type { AssertionRecord, RelationRecord, StoredAssertion, Tx } from '../ports.ts';
import {
  applyProposal,
  endpointFingerprints,
  validateProposal,
  withdrawStance,
  type ProposalContext,
} from '../proposals.ts';
import {
  byRelation,
  derivedState,
  naturalKey,
  prepareAssertion,
  refreshRelation,
  relationViews,
} from '../relation-state.ts';
import { currentStances, sameFingerprints } from '../status.ts';
import { basisOf, toRelationAssertion } from '../views.ts';
import type { UseCaseDeps } from './deps.ts';

/**
 * `policy.require(…, 'review', …)`; an agent's attempt fails with
 * `human-decision-required` carrying `reviewUrl` (a path the HTTP and MCP
 * layers make absolute).
 */
async function requireReview(
  tx: Tx,
  actor: Actor,
  projectRef: string,
  relationId?: string,
): Promise<ProjectAccess> {
  try {
    return await policy.require(tx, actor, 'review', projectRef);
  } catch (err) {
    if (err instanceof DomainError && err.code === 'human-decision-required') {
      const project = await tx.projects.findByRef(projectRef);
      throw new DomainError(err.code, err.message, {
        reviewUrl: reviewPath(project?.key ?? projectRef, relationId),
      });
    }
    throw err;
  }
}

interface DecisionFields {
  verdict: Verdict;
  rationale: string | null;
  question: string | null;
  label: string | null;
  linkedRelationId: RelationId | null;
  /** `manual` for the acceptance of a manual relation; decisions carry no tier otherwise. */
  tier: 'manual' | null;
  confidence: number | null;
}

/** Records a human decision on a relation and refreshes its derived state. */
async function recordDecision(
  tx: Tx,
  projectId: ProjectId,
  actor: Actor,
  relation: RelationRecord,
  history: readonly AssertionRecord[],
  fps: HeadFingerprints,
  d: DecisionFields,
): Promise<RelationRecord> {
  const current = endpointFingerprints(fps, relation);
  const assertion = await prepareAssertion(tx, projectId, relation, {
    kind: 'decision',
    verdict: d.verdict,
    sourceKind: sourceKindOf(actor),
    principalId: actor.principalId,
    clientId: actor.clientId,
    declared: null,
    submissionId: null,
    tier: d.tier,
    confidence: d.confidence,
    rationale: d.rationale,
    evidence: null,
    question: d.question,
    label: d.label,
    linkedRelationId: d.linkedRelationId,
    fromFp: current.from ?? null,
    toFp: current.to ?? null,
  });
  await tx.assertions.insert(assertion);
  const { relation: stored } = await refreshRelation(
    tx,
    projectId,
    relation,
    [...history, assertion],
    current,
    { touched: true, principalId: actor.principalId, clientId: actor.clientId },
  );
  return stored;
}

/**
 * The accepted manual relation for `from → to` (created if new), linked to
 * `linked`. Both refs must be head facts in different processes.
 */
async function acceptManual(
  tx: Tx,
  projectId: ProjectId,
  actor: Actor,
  fps: HeadFingerprints,
  pair: { from: Ref; to: Ref; rationale: string; confidence: number | null },
  linked: RelationId | null,
): Promise<{ relation: RelationRecord; recorded: boolean }> {
  for (const ref of [pair.from, pair.to]) {
    if (fps.get('manual', 'from', ref) === undefined) {
      throw new DomainError('validation-failed', `${ref} is not an element of the head revisions`, {
        reason: 'unknown-ref',
      });
    }
  }
  const processOf = async (ref: Ref) => {
    const { modelKey, elementId } = parseRef(ref);
    const facts = await tx.facts.head(projectId, { modelKey });
    const fact = facts.find((f) => f.elementId === elementId);
    return fact?.processId ? `${modelKey}#${fact.processId}` : `${modelKey}#`;
  };
  if ((await processOf(pair.from)) === (await processOf(pair.to))) {
    throw new DomainError('validation-failed', 'both ends lie in the same process', {
      reason: 'same-process',
    });
  }
  const existing = await tx.relations.findByNaturalKey(projectId, 'manual', pair.from, pair.to);
  const history = existing ? await tx.assertions.listForRelations(projectId, [existing.id]) : [];
  const current = endpointFingerprints(fps, { type: 'manual', fromRef: pair.from, toRef: pair.to });
  const basis = basisOf(history);
  if (
    existing &&
    existing.status === 'accepted' &&
    basis?.sourceKind === 'human' &&
    sameFingerprints(basis, { fromFp: current.from ?? null, toFp: current.to ?? null })
  ) {
    return { relation: existing, recorded: false };
  }
  const fields: DecisionFields = {
    verdict: 'accept',
    rationale: pair.rationale,
    question: null,
    label: null,
    linkedRelationId: linked,
    tier: 'manual',
    confidence: pair.confidence,
  };
  if (existing) {
    return {
      relation: await recordDecision(tx, projectId, actor, existing, history, fps, fields),
      recorded: true,
    };
  }
  const target = {
    id: newId('relation'),
    type: 'manual' as const,
    fromRef: pair.from,
    toRef: pair.to,
  };
  const assertion = await prepareAssertion(tx, projectId, target, {
    kind: 'decision',
    verdict: 'accept',
    sourceKind: sourceKindOf(actor),
    principalId: actor.principalId,
    clientId: actor.clientId,
    declared: null,
    submissionId: null,
    tier: 'manual',
    confidence: pair.confidence,
    rationale: pair.rationale,
    evidence: null,
    question: null,
    label: null,
    linkedRelationId: linked,
    fromFp: current.from ?? null,
    toFp: current.to ?? null,
  });
  const relation = await tx.relations.insert({
    ...target,
    projectId,
    ...derivedState({ tier: 'manual' }, [assertion], current),
    version: 1,
    attrs: {},
  });
  await tx.assertions.insert(assertion);
  return { relation, recorded: true };
}

function decisionFields(body: Exclude<DecisionBody, { verdict: 'correct' }>): DecisionFields {
  const base = { linkedRelationId: null, tier: null, confidence: null } as const;
  switch (body.verdict) {
    case 'accept':
      return {
        ...base,
        verdict: 'accept',
        rationale: body.note || null,
        question: null,
        label: null,
      };
    case 'reject':
      return { ...base, verdict: 'reject', rationale: body.reason, question: null, label: null };
    case 'hold':
      return {
        ...base,
        verdict: 'hold',
        rationale: body.note,
        question: body.question ?? null,
        label: body.label ?? null,
      };
  }
}

export function reviewUseCases(deps: UseCaseDeps) {
  async function view(tx: Tx, projectId: ProjectId, r: RelationRecord): Promise<Relation> {
    const [v] = await relationViews(tx, projectId, [r]);
    if (!v) throw new Error('relation view missing');
    return v;
  }

  return {
    /**
     * One human decision: accept, reject (reason), hold (note, optional
     * question and label) or correct (accept another pair as a `manual`
     * relation linked to this one, which is rejected).
     *
     * @param ifMatch the version from `If-Match` (412 on mismatch)
     * @throws {DomainError} `human-decision-required`, `conflict`, `precondition-failed`, `not-found`, `validation-failed`
     */
    async decideRelation(
      actor: Actor,
      projectRef: string,
      relationId: RelationId,
      body: DecisionBody,
      ifMatch?: number,
    ): Promise<DecisionResult> {
      return deps.store.write(async (tx) => {
        const { project } = await requireReview(tx, actor, projectRef, relationId);
        await tx.projects.lockForWrite(project.id);
        const relation = await tx.relations.findInProject(project.id, relationId);
        if (!relation) throw new DomainError('not-found', 'relation not found');
        if (ifMatch !== undefined && ifMatch !== relation.version) {
          throw new DomainError(
            'precondition-failed',
            `the relation is at version ${relation.version}`,
            {
              version: relation.version,
            },
          );
        }
        if (body.version !== undefined && body.version !== relation.version) {
          throw new DomainError('conflict', `the relation is at version ${relation.version}`, {
            version: relation.version,
          });
        }
        if (relation.status === 'obsolete') {
          throw new DomainError('conflict', 'an obsolete relation cannot be decided');
        }
        const fps = headFingerprints(await tx.facts.headProjectFacts(project.id));
        const history = await tx.assertions.listForRelations(project.id, [relation.id]);

        if (body.verdict !== 'correct') {
          const stored = await recordDecision(
            tx,
            project.id,
            actor,
            relation,
            history,
            fps,
            decisionFields(body),
          );
          return { relation: await view(tx, project.id, stored), corrected: null };
        }

        if (body.from === relation.fromRef && body.to === relation.toRef) {
          throw new DomainError('validation-failed', 'a correction names another pair');
        }
        const manual = await acceptManual(
          tx,
          project.id,
          actor,
          fps,
          { from: body.from, to: body.to, rationale: body.note, confidence: null },
          relation.id,
        );
        const rejected = await recordDecision(tx, project.id, actor, relation, history, fps, {
          verdict: 'reject',
          rationale: body.note,
          question: null,
          label: null,
          linkedRelationId: manual.relation.id,
          tier: null,
          confidence: null,
        });
        return {
          relation: await view(tx, project.id, rejected),
          corrected: await view(tx, project.id, manual.relation),
        };
      });
    },

    /**
     * One verdict for many relations, all or nothing: the number of items
     * must equal `expectedCount`, and every relation must exist, have the
     * sent version, not be obsolete and have `tier` if given; otherwise 409
     * `conflict` with the mismatches and nothing changes.
     */
    async decideRelations(
      actor: Actor,
      projectRef: string,
      body: BulkDecisionBody,
    ): Promise<BulkDecisionResult> {
      return deps.store.write(async (tx) => {
        const { project } = await requireReview(tx, actor, projectRef);
        await tx.projects.lockForWrite(project.id);
        if (body.items.length !== body.expectedCount) {
          throw new DomainError(
            'conflict',
            `expected ${body.expectedCount} relations, got ${body.items.length}`,
            { expectedCount: body.expectedCount, received: body.items.length },
          );
        }
        const mismatches: { id: string; reason: string; version?: number }[] = [];
        const relations: RelationRecord[] = [];
        const seen = new Set<string>();
        for (const item of body.items) {
          if (seen.has(item.id)) {
            mismatches.push({ id: item.id, reason: 'duplicate' });
            continue;
          }
          seen.add(item.id);
          const r = await tx.relations.findInProject(project.id, item.id);
          if (!r) mismatches.push({ id: item.id, reason: 'not-found' });
          else if (r.version !== item.version)
            mismatches.push({ id: item.id, reason: 'version', version: r.version });
          else if (r.status === 'obsolete') mismatches.push({ id: item.id, reason: 'obsolete' });
          else if (body.tier !== undefined && r.tier !== body.tier)
            mismatches.push({ id: item.id, reason: 'tier' });
          else relations.push(r);
        }
        if (mismatches.length > 0) {
          throw new DomainError('conflict', 'the relations changed; reload and decide again', {
            mismatches,
          });
        }
        const fps = headFingerprints(await tx.facts.headProjectFacts(project.id));
        const histories = byRelation<StoredAssertion>(
          await tx.assertions.listForRelations(
            project.id,
            relations.map((r) => r.id),
          ),
        );
        const fields: DecisionFields = {
          verdict: body.verdict,
          rationale: body.verdict === 'reject' ? (body.reason ?? null) : (body.note ?? null),
          question: body.question ?? null,
          label: body.label ?? null,
          linkedRelationId: null,
          tier: null,
          confidence: null,
        };
        const decided: RelationRecord[] = [];
        for (const r of relations) {
          decided.push(
            await recordDecision(tx, project.id, actor, r, histories.get(r.id) ?? [], fps, fields),
          );
        }
        return { items: await relationViews(tx, project.id, decided) };
      });
    },

    /** A human note, e.g. the answer to a held question; it never changes the status. */
    async addRelationNote(
      actor: Actor,
      projectRef: string,
      relationId: RelationId,
      body: NoteBody,
    ): Promise<RelationAssertion> {
      return deps.store.write(async (tx) => {
        const { project } = await requireReview(tx, actor, projectRef, relationId);
        await tx.projects.lockForWrite(project.id);
        const relation = await tx.relations.findInProject(project.id, relationId);
        if (!relation) throw new DomainError('not-found', 'relation not found');
        const note = await prepareAssertion(tx, project.id, relation, {
          kind: 'note',
          verdict: null,
          sourceKind: sourceKindOf(actor),
          principalId: actor.principalId,
          clientId: actor.clientId,
          declared: null,
          submissionId: null,
          tier: null,
          confidence: null,
          rationale: body.text,
          evidence: null,
          question: null,
          label: null,
          linkedRelationId: null,
          fromFp: relation.fromFp,
          toFp: relation.toFp,
        });
        await tx.assertions.insert(note);
        const stored = (await tx.assertions.listForRelations(project.id, [relation.id])).find(
          (a) => a.id === note.id,
        );
        if (!stored) throw new Error('note vanished inside its transaction');
        return toRelationAssertion(stored);
      });
    },

    /** The relation's history, oldest first. */
    async getRelationAssertions(
      actor: Actor,
      projectRef: string,
      relationId: RelationId,
    ): Promise<RelationAssertionList> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const relation = await tx.relations.findInProject(project.id, relationId);
        if (!relation) throw new DomainError('not-found', 'relation not found');
        const history = await tx.assertions.listForRelations(project.id, [relation.id]);
        return { items: history.map(toRelationAssertion) };
      });
    },

    /**
     * `propose_relation` / `POST …/relations`: an ad-hoc proposal outside the
     * pipeline (never superseded by a submission), or, for humans, an
     * accepted `manual` relation.
     *
     * @throws {DomainError} `validation-failed` with `reason` for an invalid proposal; policy errors
     */
    async proposeRelation(
      actor: Actor,
      projectRef: string,
      body: ProposeRelationBody,
    ): Promise<ProposeRelationResult> {
      return deps.store.write(async (tx) => {
        if (body.type === 'manual') {
          const { project } = await requireReview(tx, actor, projectRef);
          await tx.projects.lockForWrite(project.id);
          if (body.rationale.trim() === '') {
            throw new DomainError('validation-failed', 'a manual relation needs a rationale', {
              reason: 'rationale-required',
            });
          }
          const fps = headFingerprints(await tx.facts.headProjectFacts(project.id));
          const { relation, recorded } = await acceptManual(
            tx,
            project.id,
            actor,
            fps,
            {
              from: body.from,
              to: body.to,
              rationale: body.rationale,
              confidence: body.confidence,
            },
            null,
          );
          return {
            result: recorded ? 'applied' : 'duplicate',
            relation: await view(tx, project.id, relation),
          };
        }

        const { project } = await policy.require(tx, actor, 'propose', projectRef);
        await tx.projects.lockForWrite(project.id);
        const projectFacts = await tx.facts.headProjectFacts(project.id);
        const valid = validateProposal(
          {
            type: body.type,
            from: body.from,
            to: body.to,
            confidence: body.confidence,
            rationale: body.rationale,
            evidence: body.evidence,
            question: body.question,
          },
          deps.analysis.pairAssessor(projectFacts),
        );
        if (!valid.ok) {
          throw new DomainError('validation-failed', `invalid proposal: ${valid.reason}`, {
            reason: valid.reason,
          });
        }
        const existing = await tx.relations.findByNaturalKey(
          project.id,
          valid.value.type,
          valid.value.from,
          valid.value.to,
        );
        const ctx: ProposalContext = {
          tx,
          projectId: project.id,
          actor,
          fps: headFingerprints(projectFacts),
          relations: new Map(
            existing
              ? [[naturalKey(existing.type, existing.fromRef, existing.toRef), existing]]
              : [],
          ),
          histories: new Map(
            existing
              ? [[existing.id, await tx.assertions.listForRelations(project.id, [existing.id])]]
              : [],
          ),
          declared:
            body.procedure === null && body.llmModel === null
              ? null
              : { procedure: body.procedure, llmModel: body.llmModel },
          submissionId: null,
        };
        const { effect, relation } = await applyProposal(ctx, valid.value);
        return { result: effect, relation: await view(tx, project.id, relation) };
      });
    },

    /**
     * `withdraw_proposal`: ends the caller's own live proposal; other
     * principals' proposals and decisions stay.
     *
     * @throws {DomainError} `conflict` without a live proposal of the caller
     */
    async withdrawProposal(
      actor: Actor,
      projectRef: string,
      relationId: RelationId,
    ): Promise<Relation> {
      return deps.store.write(async (tx) => {
        const { project } = await policy.require(tx, actor, 'propose', projectRef);
        await tx.projects.lockForWrite(project.id);
        const relation = await tx.relations.findInProject(project.id, relationId);
        if (!relation) throw new DomainError('not-found', 'relation not found');
        const history = await tx.assertions.listForRelations(project.id, [relation.id]);
        const own = currentStances(history).find(
          (a) => a.principalId === actor.principalId && a.kind === 'proposal',
        );
        if (!own) {
          throw new DomainError('conflict', 'you have no live proposal on this relation');
        }
        const projectFacts = await tx.facts.headProjectFacts(project.id);
        const ctx: ProposalContext = {
          tx,
          projectId: project.id,
          actor,
          fps: headFingerprints(projectFacts),
          relations: new Map([
            [naturalKey(relation.type, relation.fromRef, relation.toRef), relation],
          ]),
          histories: new Map([[relation.id, history]]),
          declared: null,
          submissionId: null,
        };
        const stored = await withdrawStance(ctx, relation, own, null);
        return view(tx, project.id, stored);
      });
    },
  };
}
