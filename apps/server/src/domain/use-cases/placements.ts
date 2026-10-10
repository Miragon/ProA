/**
 * Placements (M4 §2, §3.1, §7): list and read them with their history;
 * propose them ad hoc (`proa:propose`) and withdraw one's own proposal;
 * decide them (accept, reject, hold, correct; also in bulk), add manual
 * placements and notes (`review`: a human on an interactive client; agents
 * get `human-decision-required` with the value chain `reviewUrl`). Every
 * write runs under the project lock on S1's placement lifecycle. An agent's
 * ad-hoc proposals count as its verdict on the process (M4b, judge each
 * process once: `placement_input`), so a placement task does not judge the
 * same input again; withdrawing a pipeline proposal forgets its verdict.
 */
import type {
  BulkPlacementDecisionBody,
  BulkPlacementDecisionResult,
  ManualPlacementBody,
  ManualPlacementResult,
  NoteBody,
  Placement,
  PlacementAssertion,
  PlacementAssertionList,
  PlacementDecisionBody,
  PlacementDecisionResult,
  PlacementId,
  PlacementItemResult,
  PlacementPage,
  PlacementQuery,
  PostPlacementsBody,
  PostPlacementsResult,
  ProjectId,
  ProposePlacementsBody,
  ProposePlacementsResult,
} from '@proa/contracts';

import { sourceKindOf, type Actor } from '../actor.ts';
import { decodeCursor, toPage } from '../cursor.ts';
import { DomainError } from '../errors.ts';
import { policy } from '../policy.ts';
import type {
  PlacementAssertionRecord,
  PlacementInputRecord,
  PlacementRecord,
  Tx,
  ValueChainRecord,
} from '../ports.ts';
import { currentStances } from '../status.ts';
import { liveChain, loadChainState, type ChainState } from '../value-chain/chain-state.ts';
import { stepGenerationKey, validatePlacementItem } from '../value-chain/items.ts';
import { byPlacement, placementKey } from '../value-chain/placement-state.ts';
import {
  acceptManualPlacement,
  addPlacementNote,
  applyPlacementProposal,
  correctPlacement,
  recordPlacementDecision,
  withdrawPlacementStance,
  type PlacementContext,
  type PlacementDecision,
} from '../value-chain/placements.ts';
import { loadPipelineInputs, queuePlacementTask } from '../value-chain/queue.ts';
import { OUTSIDE } from '../value-chain/steps.ts';
import { lexicalMatcher } from '../value-chain/tiers.ts';
import { placementViews, toPlacementAssertion } from '../value-chain/views.ts';
import { requireChainReview, type ValueChainDeps } from './chain-access.ts';
import { placementViewContext } from './value-chains.ts';

/** A placement of this chain, or 404 (also for a placement of another chain or project). */
async function findPlacement(
  tx: Tx,
  projectId: ProjectId,
  chain: ValueChainRecord,
  id: PlacementId,
): Promise<PlacementRecord> {
  const placement = await tx.placements.findInProject(projectId, id);
  if (!placement || placement.valueChainId !== chain.id) {
    throw new DomainError('not-found', 'placement not found');
  }
  return placement;
}

/** The live generation of a head step (or `@outside`), or 422 `unknown-step`. */
function liveStep(state: ChainState, step: string): { elementId: string; generation: number } {
  const generation = state.live.get(step);
  if (generation === undefined || (step !== OUTSIDE && !state.structure.byId.has(step))) {
    throw new DomainError('validation-failed', `${step} is not a step of the value chain`, {
      reason: 'unknown-step',
    });
  }
  return { elementId: step, generation };
}

/** A context for writes on a few placements (decisions, withdrawals). */
function contextFor(
  tx: Tx,
  actor: Actor,
  state: ChainState,
  placements: readonly PlacementRecord[],
  histories: Map<PlacementId, PlacementAssertionRecord[]>,
): PlacementContext {
  return {
    tx,
    projectId: state.chain.projectId,
    actor,
    valueChainId: state.chain.id,
    endpoints: state.endpoints,
    placements: new Map(
      placements.map((p) => [
        placementKey(state.chain.id, p.elementId, p.generation, p.processRef),
        p,
      ]),
    ),
    histories,
    declared: null,
    submissionId: null,
  };
}

function decisionFields(
  body: Exclude<PlacementDecisionBody, { verdict: 'correct' }>,
): PlacementDecision {
  const base = { linkedPlacementId: null, tier: null, confidence: null } as const;
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

export function placementUseCases(deps: ValueChainDeps) {
  async function views(
    tx: Tx,
    state: ChainState,
    records: readonly PlacementRecord[],
  ): Promise<Placement[]> {
    return placementViews(
      (ids) => tx.placementAssertions.listForPlacements(state.chain.projectId, ids),
      records,
      placementViewContext(state),
    );
  }

  async function view(tx: Tx, state: ChainState, record: PlacementRecord): Promise<Placement> {
    const [v] = await views(tx, state, [record]);
    if (!v) throw new Error('placement view missing');
    return v;
  }

  /** Ad-hoc proposals (`proa:propose`): each item validated, then recorded through S1. */
  async function propose(
    actor: Actor,
    projectRef: string,
    key: string,
    body: ProposePlacementsBody,
  ): Promise<ProposePlacementsResult> {
    return deps.store.write(async (tx) => {
      const { project } = await policy.require(tx, actor, 'propose', projectRef);
      await tx.projects.lockForWrite(project.id);
      const state = await loadChainState(tx, await liveChain(tx, project.id, key));
      const inputs = await loadPipelineInputs(tx, state, deps.expectedPlacementProcedure());
      const { placements, facts, relations } = inputs;
      const histories = new Map<PlacementId, PlacementAssertionRecord[]>(inputs.histories);
      const matcher = lexicalMatcher({
        structure: state.structure,
        processes: new Map(
          state.processFacts.map((f) => [
            f.ref,
            { name: f.label === '' ? null : f.label, modelKey: f.modelKey },
          ]),
        ),
        neighbours: inputs.hashContext.neighbours,
        known: inputs.hashContext.acceptedSteps,
      });
      const ctx = contextFor(tx, actor, state, placements, histories);
      ctx.declared =
        body.procedure === null && body.llmModel === null
          ? null
          : { procedure: body.procedure, llmModel: body.llmModel };
      const sourceKind = sourceKindOf(actor);
      // The chain's placements by process (natural keys), kept current as items apply.
      const byProcess = new Map<string, Set<string>>();
      const indexPlacement = (p: PlacementRecord) => {
        const key = placementKey(state.chain.id, p.elementId, p.generation, p.processRef);
        byProcess.set(p.processRef, (byProcess.get(p.processRef) ?? new Set()).add(key));
      };
      placements.forEach(indexPlacement);
      const itemCtx = {
        structure: state.structure,
        live: state.live,
        processes: new Set(state.processFacts.map((f) => f.ref)),
        factRefs: new Set(facts.map((f) => f.ref)),
        relationIds: new Set<string>(relations.map((r) => r.id)),
        sourceKind,
        lexical: matcher,
        liveProposalSteps(processRef: string) {
          const out = new Set<string>();
          for (const key of byProcess.get(processRef) ?? []) {
            const p = ctx.placements.get(key);
            if (!p || state.live.get(p.elementId) !== p.generation) continue;
            const mine = currentStances(ctx.histories.get(p.id) ?? []).some(
              (a) => a.principalId === actor.principalId && a.kind === 'proposal',
            );
            if (mine) out.add(stepGenerationKey(p.elementId, p.generation));
          }
          return out;
        },
      };
      const items: PlacementItemResult[] = [];
      const counts = { applied: 0, duplicate: 0, suppressed: 0, reopened: 0, invalid: 0 };
      const seen = new Map<string, PlacementRecord>();
      for (const [index, item] of body.placements.entries()) {
        const valid = validatePlacementItem(
          {
            step: item.step,
            process: item.process,
            confidence: item.confidence,
            rationale: item.rationale,
            evidence: item.evidence,
            question: item.question,
          },
          itemCtx,
        );
        if (!valid.ok) {
          items.push({ index, result: `invalid:${valid.reason}`, placementId: null, status: null });
          counts.invalid++;
          continue;
        }
        const k = placementKey(
          state.chain.id,
          valid.value.elementId,
          valid.value.generation,
          valid.value.processRef,
        );
        const earlier = seen.get(k);
        if (earlier) {
          const current = ctx.placements.get(k) ?? earlier;
          items.push({
            index,
            result: 'duplicate',
            placementId: current.id,
            status: current.status,
          });
          counts.duplicate++;
          continue;
        }
        const { effect, placement } = await applyPlacementProposal(ctx, valid.value);
        indexPlacement(placement);
        seen.set(k, placement);
        items.push({ index, result: effect, placementId: placement.id, status: placement.status });
        counts[effect]++;
      }
      // An earlier item's placement may have changed with a later one: report final states.
      for (const item of items) {
        if (item.placementId === null) continue;
        const current = [...ctx.placements.values()].find((p) => p.id === item.placementId);
        if (current) item.status = current.status;
      }
      // An agent's valid proposal is its verdict on the process's current input (agent
      // assertions never change an input hash): a placement task does not judge it again.
      if (sourceKind === 'agent') {
        const judged = new Set<string>();
        for (const [index, item] of items.entries()) {
          if (item.placementId === null) continue;
          const process = body.placements[index]?.process;
          if (process !== undefined) judged.add(process);
        }
        if (judged.size > 0) {
          const { lastSeq } = await tx.projects.lockForWrite(project.id);
          await tx.placementInputs.upsertMany(
            [...judged].sort().map((processRef): PlacementInputRecord => ({
              projectId: project.id,
              valueChainId: state.chain.id,
              processRef,
              inputHash: inputs.hashOf(processRef),
              taskId: null,
              principalId: actor.principalId,
              outcome: 'proposed',
              reason: null,
              seq: lastSeq,
            })),
          );
        }
      }
      return { kind: 'propose', items, counts };
    });
  }

  /** A manual placement: a human accepts the process on a step at once. */
  async function manual(
    actor: Actor,
    projectRef: string,
    key: string,
    body: ManualPlacementBody,
  ): Promise<ManualPlacementResult> {
    return deps.store.write(async (tx) => {
      const { project } = await requireChainReview(tx, actor, projectRef);
      await tx.projects.lockForWrite(project.id);
      const state = await loadChainState(tx, await liveChain(tx, project.id, key));
      const target = liveStep(state, body.step);
      const { placement, recorded } = await acceptManualPlacement(
        tx,
        project.id,
        actor,
        state.chain.id,
        state.endpoints,
        {
          ...target,
          processRef: body.process,
          rationale: body.rationale,
          confidence: body.confidence ?? null,
        },
        null,
      );
      return {
        kind: 'manual',
        result: recorded ? 'applied' : 'duplicate',
        placement: await view(tx, state, placement),
      };
    });
  }

  return {
    /** Placements by filter, ordered by step, generation and process; obsolete ones only with `status=obsolete`. */
    async listPlacements(
      actor: Actor,
      projectRef: string,
      key: string,
      query: PlacementQuery,
    ): Promise<PlacementPage> {
      const after = query.cursor
        ? decodeCursor(query.cursor, ['string', 'int', 'string'])
        : undefined;
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const state = await loadChainState(tx, await liveChain(tx, project.id, key));
        const rows = await tx.placements.list(
          project.id,
          {
            valueChainId: state.chain.id,
            elementId: query.elementId,
            processRef: query.process,
            touchingModelKey: query.modelKey,
            status: query.status,
            tier: query.tier,
            endpointState: query.endpointState,
          },
          { after, limit: query.limit + 1 },
        );
        const page = toPage(rows, query.limit, (p) => [p.elementId, p.generation, p.processRef]);
        return { items: await views(tx, state, page.items), nextCursor: page.nextCursor };
      });
    },

    async getPlacement(
      actor: Actor,
      projectRef: string,
      key: string,
      id: PlacementId,
    ): Promise<Placement> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const state = await loadChainState(tx, await liveChain(tx, project.id, key));
        return view(tx, state, await findPlacement(tx, project.id, state.chain, id));
      });
    },

    /** The placement's history, oldest first. */
    async getPlacementAssertions(
      actor: Actor,
      projectRef: string,
      key: string,
      id: PlacementId,
    ): Promise<PlacementAssertionList> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const chain = await liveChain(tx, project.id, key);
        const placement = await findPlacement(tx, project.id, chain, id);
        const history = await tx.placementAssertions.listForPlacements(project.id, [placement.id]);
        return { items: history.map(toPlacementAssertion) };
      });
    },

    /**
     * `POST …/placements`: `propose` (ad hoc, `proa:propose`; each item
     * answered on its own, humans' proposals get the `manual` tier) or
     * `manual` (`review`: accepted at once).
     */
    async postPlacements(
      actor: Actor,
      projectRef: string,
      key: string,
      body: PostPlacementsBody,
    ): Promise<PostPlacementsResult> {
      return body.kind === 'propose'
        ? propose(actor, projectRef, key, body)
        : manual(actor, projectRef, key, body);
    },

    /** `propose_placement`: ad-hoc proposals (the `propose` kind of `postPlacements`). */
    proposePlacements: propose,

    /**
     * `withdraw_placement_proposal`: ends the caller's own live proposal;
     * other principals' proposals and decisions stay.
     *
     * @throws {DomainError} `conflict` without a live proposal of the caller
     */
    async withdrawPlacementProposal(
      actor: Actor,
      projectRef: string,
      key: string,
      id: PlacementId,
    ): Promise<Placement> {
      return deps.store.write(async (tx) => {
        const { project } = await policy.require(tx, actor, 'propose', projectRef);
        await tx.projects.lockForWrite(project.id);
        const state = await loadChainState(tx, await liveChain(tx, project.id, key));
        const placement = await findPlacement(tx, project.id, state.chain, id);
        const history = await tx.placementAssertions.listForPlacements(project.id, [placement.id]);
        const own = currentStances(history).find(
          (a) => a.principalId === actor.principalId && a.kind === 'proposal',
        );
        if (!own) throw new DomainError('conflict', 'you have no live proposal on this placement');
        const ctx = contextFor(tx, actor, state, [placement], new Map([[placement.id, history]]));
        const withdrawn = await withdrawPlacementStance(ctx, placement, own, null);
        // A pipeline proposal was the verdict of a placement task, an agent's ad-hoc proposal its
        // own verdict (an ad-hoc row of the same principal): forget it, so the process is judged
        // again (M4b).
        const row = (await tx.placementInputs.forChain(project.id, state.chain.id)).find(
          (r) => r.processRef === placement.processRef,
        );
        const adHocVerdict = row?.taskId === null && row.principalId === actor.principalId;
        if (own.submissionId !== null || adHocVerdict) {
          await tx.placementInputs.deleteProcesses(project.id, state.chain.id, [
            placement.processRef,
          ]);
          await queuePlacementTask(
            tx,
            actor,
            state.chain,
            'judgement withdrawn',
            deps.expectedPlacementProcedure(),
          );
        }
        return view(tx, state, withdrawn);
      });
    },

    /**
     * One human decision: accept, reject (reason), hold (note, optional
     * question and label) or correct (accept the process on another step as
     * a manual placement linked to this one, which is rejected).
     *
     * @param ifMatch the version from `If-Match` (412 on mismatch)
     * @throws {DomainError} `human-decision-required`, `precondition-failed`,
     *   `conflict` (version, obsolete), `not-found`, `validation-failed`
     *   (`unknown-step`, `same-step`, `rationale-required`)
     */
    async decidePlacement(
      actor: Actor,
      projectRef: string,
      key: string,
      id: PlacementId,
      body: PlacementDecisionBody,
      ifMatch?: number,
    ): Promise<PlacementDecisionResult> {
      return deps.store.write(async (tx) => {
        const { project } = await requireChainReview(tx, actor, projectRef, { placementId: id });
        await tx.projects.lockForWrite(project.id);
        const state = await loadChainState(tx, await liveChain(tx, project.id, key));
        const placement = await findPlacement(tx, project.id, state.chain, id);
        if (ifMatch !== undefined && ifMatch !== placement.version) {
          throw new DomainError(
            'precondition-failed',
            `the placement is at version ${placement.version}`,
            {
              version: placement.version,
            },
          );
        }
        if (body.version !== undefined && body.version !== placement.version) {
          throw new DomainError('conflict', `the placement is at version ${placement.version}`, {
            version: placement.version,
          });
        }
        const history = await tx.placementAssertions.listForPlacements(project.id, [placement.id]);
        if (body.verdict !== 'correct') {
          const stored = await recordPlacementDecision(
            tx,
            project.id,
            actor,
            placement,
            history,
            state.endpoints,
            decisionFields(body),
          );
          return { placement: await view(tx, state, stored), corrected: null };
        }
        if (placement.status === 'obsolete') {
          throw new DomainError('conflict', 'an obsolete placement cannot be decided');
        }
        const target = liveStep(state, body.step);
        const { placement: rejected, corrected } = await correctPlacement(
          tx,
          project.id,
          actor,
          placement,
          history,
          state.endpoints,
          target,
          body.note,
        );
        return {
          placement: await view(tx, state, rejected),
          corrected: await view(tx, state, corrected),
        };
      });
    },

    /**
     * One verdict for many placements, all or nothing: the number of items
     * must equal `expectedCount`, and every placement must belong to the
     * chain, have the sent version, not be obsolete, have `tier` if given,
     * and (accept, hold) lie on a live step generation; otherwise 409
     * `conflict` with the mismatches (`duplicate`, `not-found`, `version`,
     * `obsolete`, `tier`, `step-removed`) and nothing changes.
     */
    async decidePlacements(
      actor: Actor,
      projectRef: string,
      key: string,
      body: BulkPlacementDecisionBody,
    ): Promise<BulkPlacementDecisionResult> {
      return deps.store.write(async (tx) => {
        const { project } = await requireChainReview(tx, actor, projectRef);
        await tx.projects.lockForWrite(project.id);
        const state = await loadChainState(tx, await liveChain(tx, project.id, key));
        if (body.items.length !== body.expectedCount) {
          throw new DomainError(
            'conflict',
            `expected ${body.expectedCount} placements, got ${body.items.length}`,
            { expectedCount: body.expectedCount, received: body.items.length },
          );
        }
        const mismatches: { id: string; reason: string; version?: number }[] = [];
        const chosen: PlacementRecord[] = [];
        const seen = new Set<string>();
        for (const item of body.items) {
          if (seen.has(item.id)) {
            mismatches.push({ id: item.id, reason: 'duplicate' });
            continue;
          }
          seen.add(item.id);
          const p = await tx.placements.findInProject(project.id, item.id);
          if (!p || p.valueChainId !== state.chain.id)
            mismatches.push({ id: item.id, reason: 'not-found' });
          else if (p.version !== item.version) {
            mismatches.push({ id: item.id, reason: 'version', version: p.version });
          } else if (p.status === 'obsolete') mismatches.push({ id: item.id, reason: 'obsolete' });
          else if (body.tier !== undefined && p.tier !== body.tier) {
            mismatches.push({ id: item.id, reason: 'tier' });
          } else if (body.verdict !== 'reject' && state.live.get(p.elementId) !== p.generation) {
            mismatches.push({ id: item.id, reason: 'step-removed' });
          } else chosen.push(p);
        }
        if (mismatches.length > 0) {
          throw new DomainError('conflict', 'the placements changed; reload and decide again', {
            mismatches,
          });
        }
        const histories = byPlacement<PlacementAssertionRecord>(
          await tx.placementAssertions.listForPlacements(
            project.id,
            chosen.map((p) => p.id),
          ),
        );
        const fields: PlacementDecision = {
          verdict: body.verdict,
          rationale: body.verdict === 'reject' ? (body.reason ?? null) : (body.note ?? null),
          question: body.question ?? null,
          label: body.label ?? null,
          linkedPlacementId: null,
          tier: null,
          confidence: null,
        };
        const decided: PlacementRecord[] = [];
        for (const p of chosen) {
          decided.push(
            await recordPlacementDecision(
              tx,
              project.id,
              actor,
              p,
              histories.get(p.id) ?? [],
              state.endpoints,
              fields,
            ),
          );
        }
        return { items: await views(tx, state, decided) };
      });
    },

    /** A human note, e.g. the answer to a held question; it never changes the status or the version. */
    async addPlacementNote(
      actor: Actor,
      projectRef: string,
      key: string,
      id: PlacementId,
      body: NoteBody,
    ): Promise<PlacementAssertion> {
      return deps.store.write(async (tx) => {
        const { project } = await requireChainReview(tx, actor, projectRef, { placementId: id });
        await tx.projects.lockForWrite(project.id);
        const chain = await liveChain(tx, project.id, key);
        const placement = await findPlacement(tx, project.id, chain, id);
        const note = await addPlacementNote(tx, project.id, actor, placement, body.text);
        const stored = (
          await tx.placementAssertions.listForPlacements(project.id, [placement.id])
        ).find((a) => a.id === note.id);
        if (!stored) throw new Error('note vanished inside its transaction');
        return toPlacementAssertion(stored);
      });
    },
  };
}
