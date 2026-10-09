/**
 * The value chain (M4 §2, §3.5, §7): create, save (with `If-Match` and a
 * dry run), delete and read the chain, its revisions, the drill-down of a
 * step and the processes without a home step. Writes need `review` (a human
 * on an interactive client; agents get `human-decision-required` with the
 * value chain page as `reviewUrl`), reads `read`. The documents are prepared
 * outside the write transaction, as ingest prepares facts; the write path is
 * S1's (`createValueChain`, `saveValueChainRevision`, `deleteValueChain`).
 */
import { createEmptyDocument } from '@miragon/value-chain-schema-model';
import {
  UNPLACED_DOC_CHARS,
  UNPLACED_EVENT_LABELS,
  type CreateValueChainBody,
  type PageQuery,
  type PrincipalId,
  type ProjectId,
  type Ref,
  type RelationId,
  type SaveValueChainResult,
  type UnplacedProcess,
  type UnplacedProcessPage,
  type ValueChainDetail,
  type ValueChainFindingList,
  type ValueChainList,
  type ValueChainRevisionPage,
  type ValueChainStepDetail,
} from '@proa/contracts';

import type { Actor } from '../actor.ts';
import { decodeCursor, toPage } from '../cursor.ts';
import { DomainError } from '../errors.ts';
import { policy } from '../policy.ts';
import type {
  HeadFact,
  PlacementAssertionRecord,
  PlacementRecord,
  RelationRecord,
  Tx,
  ValueChainRecord,
} from '../ports.ts';
import {
  headRevision,
  liveChain,
  loadChainState,
  revisionStructure,
  type ChainState,
} from '../value-chain/chain-state.ts';
import { prepareRevision, type PreparedChain } from '../value-chain/document.ts';
import { processHomes, valueChainFindings } from '../value-chain/findings.ts';
import { noImpact, revisionImpact } from '../value-chain/impact.ts';
import { byPlacement, placementBasisOf } from '../value-chain/placement-state.ts';
import {
  MAIN_VALUE_CHAIN_KEY,
  createValueChain,
  deleteValueChain,
  saveValueChainRevision,
  type BeforeRefresh,
} from '../value-chain/revisions.ts';
import { recomputeRulePlacements } from '../value-chain/rules.ts';
import { OUTSIDE, liveGenerations, planStepGenerations } from '../value-chain/steps.ts';
import { descendantsOf, rememberStructure } from '../value-chain/structure.ts';
import {
  acceptedNeighbours,
  acceptedSteps,
  lexicalMatcher,
  processOfRefs,
} from '../value-chain/tiers.ts';
import {
  placementViews,
  stepCounts,
  toOrgUnits,
  toPlacementSummary,
  toStep,
  toValueChain,
  toValueChainRevision,
  type PlacementViewContext,
  type StepViewContext,
} from '../value-chain/views.ts';
import { requireChainReview, type ValueChainDeps } from './chain-access.ts';
import { ALL } from './deps.ts';

/**
 * The precondition of a content save (M4 §3.5): `If-Match: "r<rev>"` names
 * the head the editor started from; `If-None-Match: *` creates the chain;
 * `none` (no header, `*`, or an `If-Match` naming no revision) is refused
 * with 428 `precondition-required` once the caller is authorized.
 */
export type ContentPrecondition =
  { kind: 'if-match'; rev: number } | { kind: 'if-none-match' } | { kind: 'none' };

/** The canonical bytes of a revision, as `GET …/content` serves them. */
export interface ChainContent {
  key: string;
  revisionId: string;
  rev: number;
  contentHash: string;
  bytes: Uint8Array;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function revisionConflict(headRev: number): DomainError {
  return new DomainError(
    'revision-conflict',
    `the value chain is at r${headRev}; load it again and save on top of it`,
    { headRev, etag: `"r${headRev}"` },
  );
}

function existsConflict(chain: ValueChainRecord, headRev: number): DomainError {
  return new DomainError('revision-conflict', `the value chain ${chain.key} exists (r${headRev})`, {
    headRev,
    etag: `"r${headRev}"`,
  });
}

function requireMainKey(key: string): void {
  if (key !== MAIN_VALUE_CHAIN_KEY) {
    throw new DomainError('validation-failed', 'a project has one value chain, key main', {
      reason: 'value-chain-key',
    });
  }
}

/** The non-obsolete placements of a chain, in natural key order. */
function liveRecords(placements: readonly PlacementRecord[]): PlacementRecord[] {
  return placements
    .filter((p) => p.status !== 'obsolete')
    .sort(
      (a, b) =>
        byCodePoint(a.elementId, b.elementId) ||
        a.generation - b.generation ||
        byCodePoint(a.processRef, b.processRef),
    );
}

/** Process names of the head processes (process name, else pool name), by ref. */
export function processNamesOf(processFacts: readonly HeadFact[]): Map<string, string | null> {
  return new Map(processFacts.map((f) => [f.ref, f.label === '' ? null : f.label]));
}

/** The view context of placements from a chain's state. */
export function placementViewContext(state: ChainState): PlacementViewContext {
  return {
    structure: state.structure,
    live: state.live,
    endpoints: state.endpoints,
    processNames: processNamesOf(state.processFacts),
  };
}

/**
 * The findings of a chain's head (M4 §3.4), recomputed on read: the
 * placements against the head's steps and processes, plus the accepted
 * `call` relations for the "called from" hints.
 */
async function chainFindings(
  tx: Tx,
  state: ChainState,
  placements: readonly PlacementRecord[],
): Promise<ValueChainDetail['findings']> {
  const projectId = state.chain.projectId;
  const processOf = processOfRefs(await tx.facts.head(projectId, { kinds: ['call'] }));
  const calls = await tx.relations.list(
    projectId,
    { type: 'call', status: 'accepted' },
    { limit: ALL },
  );
  return valueChainFindings({
    structure: state.structure,
    live: state.live,
    processes: state.processFacts.map((f) => f.ref),
    placements,
    calls: calls.flatMap((r) => {
      const caller = processOf.get(r.fromRef);
      return caller === undefined ? [] : [{ caller, callee: r.toRef }];
    }),
  });
}

export function valueChainUseCases(deps: ValueChainDeps) {
  /** The save result's revision view (with the saver's handle). */
  async function revisionView(tx: Tx, chain: ValueChainRecord, rev: number) {
    const stored = await tx.valueChainRevisions.findByRev(chain.projectId, chain.id, rev);
    if (!stored) throw new Error(`revision ${rev} of ${chain.id} vanished`);
    return toValueChainRevision(stored);
  }

  /**
   * The rule tier's key proposals for the new head (M4 §2 "Tiers"), as the
   * write path's `beforeRefresh` hook: derived again inside every create,
   * revival and revision, before S1 refreshes the endpoint state (as after a
   * model change), recorded under `proa-rules`; an `endpoint_changed` they
   * cause names the saving human, whose save moved the endpoint.
   */
  function ruleProposals(tx: Tx, actor: Actor, rulesPrincipalId: PrincipalId): BeforeRefresh {
    return async (chain) => {
      await recomputeRulePlacements(tx, await loadChainState(tx, chain), rulesPrincipalId, {
        endpointCause: { principalId: actor.principalId, clientId: actor.clientId },
      });
    };
  }

  /** Creates or revives the chain (`POST`, `PUT` with `If-None-Match: *`), under the lock. */
  async function createOrRevive(
    tx: Tx,
    actor: Actor,
    projectId: ProjectId,
    key: string,
    { prepared, structure }: PreparedChain,
    rulesPrincipalId: PrincipalId,
  ): Promise<SaveValueChainResult> {
    const existing = await tx.valueChains.findByKey(projectId, key);
    const plan = planStepGenerations(
      existing ? await tx.valueChainSteps.list(projectId, existing.id) : [],
      structure.stepFingerprints.keys(),
      'create',
    );
    const impact = revisionImpact(null, structure, plan, new Map(), [], new Map());
    // Before the write: the rule tier's hook loads the new head's structure from the cache.
    rememberStructure(structure);
    const written = await createValueChain(tx, actor, projectId, { key }, prepared, {
      beforeRefresh: ruleProposals(tx, actor, rulesPrincipalId),
    });
    return {
      dryRun: false,
      outcome: written.outcome,
      valueChain: toValueChain(written.chain, written.revision),
      revision: await revisionView(tx, written.chain, written.revision.rev),
      impact,
    };
  }

  return {
    /** The live value chains of a project (M4: at most `main`). */
    async listValueChains(actor: Actor, projectRef: string): Promise<ValueChainList> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const items = [];
        for (const chain of await tx.valueChains.list(project.id)) {
          if (chain.headRevisionId === null) continue;
          items.push(toValueChain(chain, await headRevision(tx, chain)));
        }
        return { items };
      });
    },

    /** The chain with its head structure and every non-obsolete placement (`get_value_chain`). */
    async getValueChain(actor: Actor, projectRef: string, key: string): Promise<ValueChainDetail> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const state = await loadChainState(tx, await liveChain(tx, project.id, key));
        const placements = liveRecords(await tx.placements.forChain(project.id, state.chain.id));
        const histories = byPlacement<PlacementAssertionRecord>(
          await tx.placementAssertions.listForChain(project.id, state.chain.id),
        );
        const stepCtx: StepViewContext = {
          structure: state.structure,
          live: state.live,
          headProcesses: new Set(state.processFacts.map((f) => f.ref)),
          counts: stepCounts(placements),
        };
        return {
          valueChain: toValueChain(state.chain, state.head),
          steps: state.structure.steps.map((s) => toStep(s, stepCtx)),
          orgUnits: toOrgUnits(state.structure),
          placements: placements.map((p) =>
            toPlacementSummary(
              p,
              state.live,
              placementBasisOf(histories.get(p.id) ?? [])?.sourceKind ?? null,
            ),
          ),
          findings: await chainFindings(tx, state, placements),
        };
      });
    },

    /** The chain's findings (M4 §3.4), recomputed on read. */
    async getValueChainFindings(
      actor: Actor,
      projectRef: string,
      key: string,
    ): Promise<ValueChainFindingList> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const state = await loadChainState(tx, await liveChain(tx, project.id, key));
        const placements = await tx.placements.forChain(project.id, state.chain.id);
        return { items: await chainFindings(tx, state, placements) };
      });
    },

    /**
     * `POST …/value-chains`: the first revision from `content`, or an empty
     * document named `name`; a deleted chain is revived (`revived`).
     *
     * @throws {DomainError} policy errors; `value-chain-invalid`,
     *   `value-chain-unsupported-version`; `validation-failed`
     *   (`value-chain-key`) for a key other than `main`; `conflict` if the
     *   chain exists
     */
    async createValueChain(
      actor: Actor,
      projectRef: string,
      body: CreateValueChainBody,
    ): Promise<SaveValueChainResult> {
      await deps.store.read((tx) => requireChainReview(tx, actor, projectRef));
      const prepared = prepareRevision(body.content ?? createEmptyDocument(body.name));
      const rulesPrincipalId = await deps.rulesPrincipal();
      return deps.store.write(async (tx) => {
        const { project } = await requireChainReview(tx, actor, projectRef);
        await tx.projects.lockForWrite(project.id);
        return createOrRevive(tx, actor, project.id, body.key, prepared, rulesPrincipalId);
      });
    },

    /**
     * `PUT …/content`: saves the document as the next revision. `If-Match`
     * must name the head (412 `revision-conflict` otherwise), unless the
     * content equals the head's, which is `unchanged` whatever it names
     * (RFC 9110 §13.1.1: the change is already in place). `If-None-Match: *`
     * creates or revives the chain (412 if it exists). A dry run checks the
     * same in a snapshot and returns the impact without writing anything; the
     * save computes its own impact under the project lock.
     *
     * @throws {DomainError} policy errors; `precondition-required`;
     *   `revision-conflict`; `not-found`; `value-chain-invalid`;
     *   `value-chain-unsupported-version`; `validation-failed` (`value-chain-key`)
     */
    async saveValueChainContent(
      actor: Actor,
      projectRef: string,
      key: string,
      input: unknown,
      pre: ContentPrecondition,
      options: { dryRun: boolean } = { dryRun: false },
    ): Promise<SaveValueChainResult> {
      await deps.store.read((tx) => requireChainReview(tx, actor, projectRef));
      if (pre.kind === 'none') {
        throw new DomainError(
          'precondition-required',
          'send If-Match: "r<rev>" with the revision you edited, or If-None-Match: * to create the chain',
        );
      }
      const chainInput = prepareRevision(input);
      const { prepared, structure } = chainInput;

      if (options.dryRun) {
        return deps.store.read(async (tx) => {
          const { project } = await requireChainReview(tx, actor, projectRef);
          const existing = await tx.valueChains.findByKey(project.id, key);
          const live = existing && existing.deletedSeq === null ? existing : null;
          if (pre.kind === 'if-none-match') {
            if (live) throw existsConflict(live, (await headRevision(tx, live)).rev);
            requireMainKey(key);
            const plan = planStepGenerations(
              existing ? await tx.valueChainSteps.list(project.id, existing.id) : [],
              structure.stepFingerprints.keys(),
              'create',
            );
            return {
              dryRun: true,
              outcome: existing ? 'revived' : 'created',
              valueChain: null,
              revision: null,
              impact: revisionImpact(null, structure, plan, new Map(), [], new Map()),
            };
          }
          const chain = await liveChain(tx, project.id, key);
          const head = await headRevision(tx, chain);
          if (head.contentHash === prepared.contentHash) {
            return {
              dryRun: true,
              outcome: 'unchanged',
              valueChain: toValueChain(chain, head),
              revision: await revisionView(tx, chain, head.rev),
              impact: noImpact(),
            };
          }
          if (pre.rev !== head.rev) throw revisionConflict(head.rev);
          const steps = await tx.valueChainSteps.list(project.id, chain.id);
          const plan = planStepGenerations(steps, structure.stepFingerprints.keys(), 'revise');
          return {
            dryRun: true,
            outcome: 'revised',
            valueChain: toValueChain(chain, head),
            revision: null,
            impact: revisionImpact(
              await revisionStructure(tx, head),
              structure,
              plan,
              liveGenerations(steps),
              await tx.placements.forChain(project.id, chain.id),
              byPlacement(await tx.placementAssertions.listForChain(project.id, chain.id)),
            ),
          };
        });
      }

      const rulesPrincipalId = await deps.rulesPrincipal();
      return deps.store.write(async (tx) => {
        const { project } = await requireChainReview(tx, actor, projectRef);
        await tx.projects.lockForWrite(project.id);
        const existing = await tx.valueChains.findByKey(project.id, key);
        if (pre.kind === 'if-none-match') {
          if (existing && existing.deletedSeq === null) {
            throw existsConflict(existing, (await headRevision(tx, existing)).rev);
          }
          return createOrRevive(tx, actor, project.id, key, chainInput, rulesPrincipalId);
        }
        const chain = await liveChain(tx, project.id, key);
        const head = await headRevision(tx, chain);
        if (head.contentHash === prepared.contentHash) {
          return {
            dryRun: false,
            outcome: 'unchanged',
            valueChain: toValueChain(chain, head),
            revision: await revisionView(tx, chain, head.rev),
            impact: noImpact(),
          };
        }
        if (pre.rev !== head.rev) throw revisionConflict(head.rev);
        const steps = await tx.valueChainSteps.list(project.id, chain.id);
        const impact = revisionImpact(
          await revisionStructure(tx, head),
          structure,
          planStepGenerations(steps, structure.stepFingerprints.keys(), 'revise'),
          liveGenerations(steps),
          await tx.placements.forChain(project.id, chain.id),
          byPlacement(await tx.placementAssertions.listForChain(project.id, chain.id)),
        );
        rememberStructure(structure);
        const saved = await saveValueChainRevision(tx, actor, project.id, chain.id, prepared, {
          baseRevisionId: head.id,
          beforeRefresh: ruleProposals(tx, actor, rulesPrincipalId),
        });
        return {
          dryRun: false,
          outcome: saved.outcome,
          valueChain: toValueChain(saved.chain, saved.revision),
          revision: await revisionView(tx, saved.chain, saved.revision.rev),
          impact: saved.outcome === 'unchanged' ? noImpact() : impact,
        };
      });
    },

    /** Deletes the chain: every placement turns `missing`, live proposals are withdrawn (S1). */
    async deleteValueChain(actor: Actor, projectRef: string, key: string): Promise<void> {
      await deps.store.write(async (tx) => {
        const { project } = await requireChainReview(tx, actor, projectRef);
        await tx.projects.lockForWrite(project.id);
        const chain = await liveChain(tx, project.id, key);
        await deleteValueChain(tx, actor, project.id, chain.id);
      });
    },

    /** The canonical bytes of the head (or of revision `rev`). */
    async getValueChainContent(
      actor: Actor,
      projectRef: string,
      key: string,
      rev?: number,
    ): Promise<ChainContent> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const chain = await liveChain(tx, project.id, key);
        const revision =
          rev === undefined
            ? await headRevision(tx, chain)
            : await tx.valueChainRevisions.findByRev(project.id, chain.id, rev);
        if (!revision) throw new DomainError('not-found', `revision r${rev ?? ''} not found`);
        const bytes = await tx.valueChainRevisions.content(project.id, chain.id, revision.id);
        if (!bytes) throw new Error(`content of ${revision.id} vanished`);
        return {
          key: chain.key,
          revisionId: revision.id,
          rev: revision.rev,
          contentHash: revision.contentHash,
          bytes,
        };
      });
    },

    /** Revisions, newest first. */
    async listValueChainRevisions(
      actor: Actor,
      projectRef: string,
      key: string,
      query: PageQuery,
    ): Promise<ValueChainRevisionPage> {
      const beforeRev = query.cursor ? decodeCursor(query.cursor, ['int'])[0] : undefined;
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const chain = await liveChain(tx, project.id, key);
        const rows = await tx.valueChainRevisions.listForChain(project.id, chain.id, {
          beforeRev,
          limit: query.limit + 1,
        });
        const page = toPage(rows, query.limit, (r) => [r.rev]);
        return { items: page.items.map(toValueChainRevision), nextCursor: page.nextCursor };
      });
    },

    /**
     * The drill-down of a head step (M4 §4): breadcrumb, sub-steps, the
     * non-obsolete placements on it and below it, and the processes reached
     * by accepted calls from processes accepted there. `@outside` is no step
     * (404): list its placements with the placement filter.
     */
    async getValueChainStep(
      actor: Actor,
      projectRef: string,
      key: string,
      elementId: string,
    ): Promise<ValueChainStepDetail> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const state = await loadChainState(tx, await liveChain(tx, project.id, key));
        const step = elementId === OUTSIDE ? undefined : state.structure.byId.get(elementId);
        const generation = state.live.get(elementId);
        if (!step || generation === undefined) {
          throw new DomainError('not-found', `${elementId} is not a step of the value chain`);
        }
        const placements = liveRecords(await tx.placements.forChain(project.id, state.chain.id));
        const below = new Set(descendantsOf(state.structure, elementId));
        const isLive = (p: PlacementRecord) => state.live.get(p.elementId) === p.generation;
        const own = placements.filter(
          (p) => p.elementId === elementId && p.generation === generation,
        );
        const subtree = placements.filter((p) => below.has(p.elementId) && isLive(p));
        const acceptedHere = new Set<string>(
          [...own, ...subtree].filter((p) => p.status === 'accepted').map((p) => p.processRef),
        );
        const callFacts = await tx.facts.head(project.id, { kinds: ['call'] });
        const processOf = processOfRefs(callFacts);
        const calls = await tx.relations.list(
          project.id,
          { type: 'call', status: 'accepted' },
          { limit: ALL },
        );
        const reached = new Map<string, { relationId: RelationId; caller: Ref }[]>();
        for (const r of calls) {
          const caller = processOf.get(r.fromRef);
          if (caller === undefined || !acceptedHere.has(caller) || acceptedHere.has(r.toRef))
            continue;
          reached.set(r.toRef, [
            ...(reached.get(r.toRef) ?? []),
            { relationId: r.id, caller: caller as Ref },
          ]);
        }
        const names = processNamesOf(state.processFacts);
        const viewCtx = placementViewContext(state);
        const listHistories = (ids: readonly PlacementRecord['id'][]) =>
          tx.placementAssertions.listForPlacements(project.id, ids);
        const stepCtx: StepViewContext = {
          structure: state.structure,
          live: state.live,
          headProcesses: new Set(state.processFacts.map((f) => f.ref)),
          counts: stepCounts(placements),
        };
        return {
          step: toStep(step, stepCtx),
          breadcrumb: step.pathIds.slice(0, -1).map((id) => ({
            elementId: id,
            name: state.structure.byId.get(id)?.name ?? '',
          })),
          children: step.childIds.flatMap((id) => {
            const child = state.structure.byId.get(id);
            return child ? [toStep(child, stepCtx)] : [];
          }),
          placements: {
            own: await placementViews(listHistories, own, viewCtx),
            subtree: await placementViews(listHistories, subtree, viewCtx),
            reachedByCall: [...reached]
              .sort(([a], [b]) => byCodePoint(a, b))
              .map(([process, via]) => ({
                process: process as Ref,
                name: names.get(process) ?? null,
                via: via.sort((a, b) => byCodePoint(a.relationId, b.relationId)),
              })),
          },
        };
      });
    },

    /**
     * Processes without a home step (M4 §3.1): no accepted or held placement
     * and none waiting for review (`proposed`) on a live step generation. An
     * accepted placement on a removed step and a rejected one count as
     * unplaced. Ordered by ref.
     */
    async listUnplacedProcesses(
      actor: Actor,
      projectRef: string,
      key: string,
      query: PageQuery,
    ): Promise<UnplacedProcessPage> {
      const after = query.cursor ? decodeCursor(query.cursor, ['string'])[0] : undefined;
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const state = await loadChainState(tx, await liveChain(tx, project.id, key));
        const placements = await tx.placements.forChain(project.id, state.chain.id);
        // Accepted, held or waiting for review on a live step: a rejected placement homes nothing,
        // although the agent's proposal on it is still that agent's current stance.
        const homes = processHomes(placements, state.live);
        const homed = (ref: string) =>
          homes.accepted.has(ref) || homes.held.has(ref) || homes.proposed.has(ref);
        const open = state.processFacts
          .filter((f) => !homed(f.ref) && (after === undefined || f.ref > after))
          .sort((a, b) => byCodePoint(a.ref, b.ref));
        const page = toPage(open.slice(0, query.limit + 1), query.limit, (f) => [f.ref]);
        if (page.items.length === 0) return { items: [], nextCursor: page.nextCursor };

        const facts = await tx.facts.head(project.id);
        const processOf = processOfRefs(facts);
        const relations = (await tx.relations.list(project.id, {}, { limit: ALL })).filter(
          (r) => r.status !== 'rejected',
        );
        const known = acceptedSteps(placements, state.live);
        const matcher = lexicalMatcher({
          structure: state.structure,
          processes: new Map(
            state.processFacts.map((f) => [
              f.ref,
              { name: f.label === '' ? null : f.label, modelKey: f.modelKey },
            ]),
          ),
          neighbours: acceptedNeighbours(relations, processOf),
          known,
        });
        return {
          items: page.items.map((f) =>
            unplacedProcess(f, { facts, processOf, relations, known, matcher, state }),
          ),
          nextCursor: page.nextCursor,
        };
      });
    },
  };
}

/** One unplaced process with what an agent needs to place it. */
function unplacedProcess(
  process: HeadFact,
  ctx: {
    facts: readonly HeadFact[];
    processOf: ReadonlyMap<string, string>;
    relations: readonly RelationRecord[];
    known: ReadonlyMap<string, readonly string[]>;
    matcher: ReturnType<typeof lexicalMatcher>;
    state: ChainState;
  },
): UnplacedProcess {
  const ref = process.ref;
  const own = ctx.facts.filter(
    (f) => f.modelKey === process.modelKey && f.processId === process.elementId,
  );
  const labels = (elementType: string) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of own) {
      if (f.scope !== 'process' || f.attrs.elementType !== elementType) continue;
      if (seen.has(f.elementId) || f.label.trim() === '') continue;
      seen.add(f.elementId);
      out.push(f.label);
    }
    return out.slice(0, UNPLACED_EVENT_LABELS);
  };
  const lanes = [
    ...new Set(own.filter((f) => f.kind === 'lane' && f.label.trim() !== '').map((f) => f.label)),
  ];
  const neighbours = new Map<
    string,
    { relationId: RelationId; type: RelationRecord['type']; direction: 'out' | 'in' }[]
  >();
  const out: UnplacedProcess['calls']['out'] = [];
  const into: UnplacedProcess['calls']['in'] = [];
  for (const r of ctx.relations) {
    const from = ctx.processOf.get(r.fromRef);
    const to = ctx.processOf.get(r.toRef);
    if (from === undefined || to === undefined || from === to) continue;
    if (from === ref) {
      neighbours.set(to, [
        ...(neighbours.get(to) ?? []),
        { relationId: r.id, type: r.type, direction: 'out' },
      ]);
      if (r.type === 'call') out.push({ process: to as Ref, relationId: r.id, status: r.status });
    } else if (to === ref) {
      neighbours.set(from, [
        ...(neighbours.get(from) ?? []),
        { relationId: r.id, type: r.type, direction: 'in' },
      ]);
      if (r.type === 'call')
        into.push({ process: from as Ref, relationId: r.id, status: r.status });
    }
  }
  const doc = process.attrs.documentation?.slice(0, UNPLACED_DOC_CHARS);
  const byRelation = <T extends { relationId: string }>(a: T, b: T) =>
    byCodePoint(a.relationId, b.relationId);
  return {
    process: ref,
    name: process.label === '' ? null : process.label,
    modelKey: process.modelKey,
    lanes,
    starts: labels('bpmn:StartEvent'),
    ends: labels('bpmn:EndEvent'),
    ...(doc ? { doc } : {}),
    neighbours: [...neighbours]
      .sort(([a], [b]) => byCodePoint(a, b))
      .map(([q, via]) => ({
        process: q as Ref,
        via: via.sort(byRelation),
        steps: [...(ctx.known.get(q) ?? [])],
      })),
    calls: { out: out.sort(byRelation), in: into.sort(byRelation) },
    hints: ctx.matcher.hints(ref).map((h) => ({
      step: h.stepId,
      name: ctx.state.structure.byId.get(h.stepId)?.name ?? '',
      score: h.score,
    })),
  };
}
