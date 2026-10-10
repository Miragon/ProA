/**
 * Auto-accept rules (owner decision 19): the owner maintains project rules
 * that accept agent proposals without a click. Every function needs the
 * `admin` permission (an owner on an interactive client with `proa:write`):
 * agent tokens get 403 `forbidden`, foreign projects 404, and nothing here is
 * reachable over MCP. The one exception is the ledger of acceptances, which
 * every human reviewer reads (`review`: editors too; agent tokens get 403
 * `human-decision-required`), so the review views mark machine acceptances
 * for whoever decides. Writes take the project lock, so rule edits serialize
 * with submissions; previews and dry runs read a snapshot.
 *
 * Rules are never retroactive: enabling one changes nothing until the owner
 * applies it to the open proposals (dry run first, then `expectedCount` and
 * the head revision). Acceptances are revocable in bulk; a human decision
 * taken since always wins and is never touched.
 */
import {
  AUTO_ACCEPT_CURVE,
  AUTO_ACCEPT_PREVIEW_ITEMS,
  MAX_AUTO_ACCEPT_ITEMS,
  newId,
  type ApplyAutoAcceptBody,
  type ApplyAutoAcceptResult,
  type AutoAcceptAgent,
  type AutoAcceptBlockReason,
  type AutoAcceptCriteria,
  type AutoAcceptItem,
  type AutoAcceptKind,
  type AutoAcceptLedger,
  type AutoAcceptLedgerQuery,
  type AutoAcceptPreview,
  type AutoAcceptRevocationBody,
  type AutoAcceptRevocationItem,
  type AutoAcceptRevocationResult,
  type AutoAcceptRule,
  type AutoAcceptRuleDetail,
  type AutoAcceptRuleDraft,
  type AutoAcceptRuleId,
  type AutoAcceptRuleList,
  type AutoAcceptRuleRevision,
  type DeclaredProcedure,
  type PrincipalId,
  type ProjectId,
  type SaveAutoAcceptRuleResult,
} from '@proa/contracts';

import type { Actor } from '../actor.ts';
import { ownersAmong, toRuleRev } from '../auto-accept/apply.ts';
import type { AutoAcceptRuleRev } from '../auto-accept/evaluate.ts';
import {
  NO_STATS,
  filterLedger,
  ledgerItems,
  ruleStats,
  type LedgerItem,
  type LedgerSubject,
} from '../auto-accept/ledger.ts';
import {
  blockedCounts,
  openPlacementCandidates,
  openRelationCandidates,
  placementItem,
  relationItem,
  replayHistory,
  type OpenPlacement,
  type PlacementSide,
  type RelationSide,
} from '../auto-accept/preview.ts';
import {
  recordPlacementAutoAccept,
  recordRelationAutoAccept,
  revokePlacementAutoAccept,
  revokeRelationAutoAccept,
  type Cause,
} from '../auto-accept/record.ts';
import {
  draftFields,
  ruleDraftProblem,
  sameFields,
  systemRule,
  type RuleDraftProblem,
} from '../auto-accept/rules.ts';
import { DomainError } from '../errors.ts';
import { headFingerprints } from '../fingerprints.ts';
import { requeueAfterLoss } from '../ingest.ts';
import { modelOf } from '../judgements.ts';
import { policy } from '../policy.ts';
import type {
  AutoAcceptRuleHead,
  PlacementAssertionRecord,
  PlacementRecord,
  RelationRecord,
  StoredAssertion,
  StoredAutoAcceptRuleRevision,
  StoredPlacementAssertion,
  Tx,
  ValueChainRecord,
} from '../ports.ts';
import type { ProposalContext } from '../proposals.ts';
import { byRelation, naturalKey } from '../relation-state.ts';
import { currentStances, recomputeStatus, type StanceView } from '../status.ts';
import { loadChainState, type ChainState } from '../value-chain/chain-state.ts';
import {
  byPlacement,
  placementKey,
  recomputePlacementStatus,
} from '../value-chain/placement-state.ts';
import type { PlacementContext } from '../value-chain/placements.ts';
import { loadPipelineInputs, queuePlacementTasks } from '../value-chain/queue.ts';
import { basisOf } from '../views.ts';
import type { UseCaseDeps } from './deps.ts';

/** The precondition of an edit: `If-Match: "r<revision>"`, or none (428 once authorized). */
export type RulePrecondition = { kind: 'if-match'; rev: number } | { kind: 'none' };

/** Why a real "apply" is refused (409 `conflict` with this `reason`). */
type ApplyConflictReason =
  'rule-disabled' | 'author-not-owner' | 'revision-changed' | 'count-changed';

/** Id of an unsaved rule in a preview (never stored or shown). */
const DRAFT_RULE_ID = 'aar_00000000000000000000000000' as AutoAcceptRuleId;

const iso = (d: Date): string => d.toISOString();
const isAgentProposal = (a: StanceView) => a.sourceKind === 'agent' && a.kind === 'proposal';
const marked = (a: StanceView) => (a.autoAcceptRuleId ?? null) !== null;

const PROBLEM_TEXT: Readonly<Record<RuleDraftProblem | 'kind-changed', string>> = {
  'kind-tier-mismatch': 'the tier does not fit the kind of rule',
  'type-not-for-placements': 'only a relation rule has a relation type',
  'unknown-agent': 'the agent is not an agent of this project',
  'name-taken': 'another auto-accept rule of the project has this name',
  'confidence-out-of-range': 'the minimum confidence must lie between 0.5 and 1',
  'control-characters': 'name, note and model must not contain control characters',
  'kind-changed': 'the kind of a rule never changes; create a new rule',
};

function invalid(reason: RuleDraftProblem | 'kind-changed'): DomainError {
  return new DomainError('validation-failed', PROBLEM_TEXT[reason], { reason });
}

function notFound(): DomainError {
  return new DomainError('not-found', 'auto-accept rule not found');
}

function revisionConflict(headRev: number): DomainError {
  return new DomainError(
    'revision-conflict',
    `the auto-accept rule is at r${headRev}; load it again and edit that revision`,
    { headRev, etag: `"r${headRev}"` },
  );
}

// ------------------------------------------------------------------ loading

/** The project's agents a rule may name, by principal (agent tokens, revoked ones included). */
async function agentDirectory(
  tx: Tx,
  projectId: ProjectId,
): Promise<Map<PrincipalId, AutoAcceptAgent>> {
  const out = new Map<PrincipalId, AutoAcceptAgent>();
  for (const t of await tx.agentTokens.listInProject(projectId)) {
    out.set(t.principalId, {
      principalId: t.principalId,
      // The handle every token principal gets at creation (agent-tokens.ts).
      handle: `agent:${t.name}`,
      tokenId: t.id,
      revoked: t.revokedAt !== null,
    });
  }
  return out;
}

function agentOf(
  agents: ReadonlyMap<PrincipalId, AutoAcceptAgent>,
  principalId: PrincipalId,
  handle?: string,
): AutoAcceptAgent {
  return (
    agents.get(principalId) ?? {
      principalId,
      handle: handle ?? principalId,
      tokenId: null,
      revoked: false,
    }
  );
}

/** The relation side of the project, as the preview, "apply" and revocations read it. */
interface LoadedRelations {
  side: RelationSide;
  records: RelationRecord[];
  histories: Map<string, StoredAssertion[]>;
}

async function loadRelations(
  tx: Tx,
  projectId: ProjectId,
  procedure: DeclaredProcedure,
): Promise<LoadedRelations> {
  const records = await tx.relations.all(projectId);
  const histories = byRelation<StoredAssertion>(await tx.assertions.listForProject(projectId));
  return {
    records,
    histories,
    side: {
      relations: records,
      histories,
      noLinks: await tx.noLinks.listHistory(projectId),
      heads: await tx.revisions.headHashes(projectId),
      procedure,
    },
  };
}

/** One live chain with what the placement safeguards need. */
interface LoadedChain {
  chain: ValueChainRecord;
  state: ChainState;
  side: PlacementSide;
}

async function loadChains(
  tx: Tx,
  projectId: ProjectId,
  procedure: DeclaredProcedure,
): Promise<LoadedChain[]> {
  const out: LoadedChain[] = [];
  for (const chain of await tx.valueChains.list(projectId)) {
    if (chain.headRevisionId === null) continue;
    const state = await loadChainState(tx, chain);
    const inputs = await loadPipelineInputs(tx, state, procedure);
    out.push({
      chain,
      state,
      side: {
        valueChainKey: chain.key,
        placements: inputs.placements,
        histories: inputs.histories,
        steps: state.steps,
        live: state.live,
        rows: inputs.rows,
        hashOf: (ref) => inputs.hashOf(ref),
        chainDigest: inputs.hashContext.chainDigest,
        processDigests: inputs.hashContext.processDigests,
        procedure,
      },
    });
  }
  return out;
}

function relationSubject(r: RelationRecord, history: readonly StoredAssertion[]): LedgerSubject {
  return {
    kind: 'relation',
    id: r.id,
    status: r.status,
    endpointState: r.endpointState,
    type: r.type === 'manual' ? null : r.type,
    from: r.fromRef,
    to: r.toRef,
    valueChainKey: null,
    step: null,
    process: null,
    history: history.map((a) => ({
      ...a,
      linked: a.linkedRelationId,
      llmModel: a.declared?.llmModel ?? null,
    })),
  };
}

function placementSubject(
  chainKey: string,
  p: PlacementRecord,
  history: readonly StoredPlacementAssertion[],
): LedgerSubject {
  return {
    kind: 'placement',
    id: p.id,
    status: p.status,
    endpointState: p.endpointState,
    type: null,
    from: null,
    to: null,
    valueChainKey: chainKey,
    step: p.elementId,
    process: p.processRef,
    history: history.map((a) => ({
      ...a,
      linked: a.linkedPlacementId,
      llmModel: a.declared?.llmModel ?? null,
    })),
  };
}

/** The ledger of the project and the relation data it was built from. */
interface LoadedLedger {
  items: LedgerItem[];
  relations: RelationRecord[];
  relationHistories: Map<string, StoredAssertion[]>;
}

async function loadLedger(tx: Tx, projectId: ProjectId): Promise<LoadedLedger> {
  const relations = await tx.relations.all(projectId);
  const relationHistories = byRelation<StoredAssertion>(
    await tx.assertions.listForProject(projectId),
  );
  const subjects: LedgerSubject[] = [];
  for (const r of relations) {
    const history = relationHistories.get(r.id) ?? [];
    if (history.some(marked)) subjects.push(relationSubject(r, history));
  }
  for (const chain of await tx.valueChains.list(projectId)) {
    const placements = await tx.placements.forChain(projectId, chain.id);
    const histories = byPlacement(await tx.placementAssertions.listForChain(projectId, chain.id));
    for (const p of placements) {
      const history = histories.get(p.id) ?? [];
      if (history.some(marked)) subjects.push(placementSubject(chain.key, p, history));
    }
  }
  const ruleIds = new Set<AutoAcceptRuleId>();
  for (const s of subjects) {
    for (const a of s.history)
      if (a.autoAcceptRuleId) ruleIds.add(a.autoAcceptRuleId as AutoAcceptRuleId);
  }
  const names = new Map<string, string>();
  for (const r of await tx.autoAcceptRules.revisions(projectId, [...ruleIds])) {
    names.set(`${r.ruleId}\u0000${r.revision}`, r.name);
  }
  return {
    items: ledgerItems(
      subjects,
      (ruleId, revision) => names.get(`${ruleId}\u0000${revision}`) ?? ruleId,
    ),
    relations,
    relationHistories,
  };
}

// ------------------------------------------------------------------- views

function revisionView(r: StoredAutoAcceptRuleRevision): AutoAcceptRuleRevision {
  return {
    revision: r.revision,
    name: r.name,
    enabled: r.enabled,
    note: r.note,
    kind: r.kind,
    tier: r.tier,
    minConfidence: r.minConfidence,
    relationType: r.relationType,
    agentPrincipalId: r.agentPrincipalId,
    llmModel: r.llmModel,
    includeAdHoc: r.includeAdHoc,
    author: { principalId: r.principalId, handle: r.handle },
    clientId: r.clientId,
    at: iso(r.createdAt),
  };
}

function ruleView(
  head: AutoAcceptRuleHead,
  ctx: {
    owners: ReadonlyMap<PrincipalId, boolean>;
    stats: ReturnType<typeof ruleStats>;
    agents: ReadonlyMap<PrincipalId, AutoAcceptAgent>;
  },
): AutoAcceptRule {
  return {
    id: head.ruleId,
    kind: head.kind,
    revision: head.revision,
    name: head.name,
    enabled: head.enabled,
    note: head.note,
    tier: head.tier,
    minConfidence: head.minConfidence,
    relationType: head.relationType,
    agentPrincipalId: head.agentPrincipalId,
    agent: head.agentPrincipalId === null ? null : agentOf(ctx.agents, head.agentPrincipalId),
    llmModel: head.llmModel,
    includeAdHoc: head.includeAdHoc,
    author: { principalId: head.principalId, handle: head.handle },
    authorIsOwner: ctx.owners.get(head.principalId) ?? false,
    createdBy: { principalId: head.createdBy, handle: head.createdByHandle },
    createdAt: iso(head.ruleCreatedAt),
    updatedAt: iso(head.createdAt),
    stats: { ...(ctx.stats.get(head.ruleId) ?? NO_STATS) },
  };
}

async function ruleDetail(
  tx: Tx,
  projectId: ProjectId,
  ruleId: AutoAcceptRuleId,
): Promise<AutoAcceptRuleDetail> {
  const found = await tx.autoAcceptRules.find(projectId, ruleId);
  if (!found) throw notFound();
  const owners = await ownersAmong(tx, projectId, [found.head.principalId]);
  const { items } = await loadLedger(tx, projectId);
  return {
    ...ruleView(found.head, {
      owners,
      stats: ruleStats(filterLedger(items, { ruleId })),
      agents: await agentDirectory(tx, projectId),
    }),
    revisions: found.revisions.map(revisionView),
  };
}

/** Checks a draft against the project's other rules and agents. */
async function checkDraft(
  tx: Tx,
  projectId: ProjectId,
  draft: AutoAcceptRuleDraft,
  self: AutoAcceptRuleId | null,
): Promise<void> {
  const names = (await tx.autoAcceptRules.heads(projectId))
    .filter((h) => h.ruleId !== self)
    .map((h) => h.name);
  const agents = new Set((await agentDirectory(tx, projectId)).keys());
  const agent = draft.agentPrincipalId;
  // An R1 service member counts too.
  if (agent !== null && !agents.has(agent) && (await tx.memberships.roleOf(projectId, agent))) {
    agents.add(agent);
  }
  const problem = ruleDraftProblem(draft, names, agents);
  if (problem) throw invalid(problem);
}

/** The rule a preview evaluates: the criteria as an enabled rule of the caller. */
function draftRule(actor: Actor, criteria: AutoAcceptCriteria): AutoAcceptRuleRev {
  return {
    ruleId: DRAFT_RULE_ID,
    revision: 1,
    kind: criteria.kind,
    name: '',
    enabled: true,
    tier: criteria.tier,
    minConfidence: criteria.minConfidence,
    relationType: criteria.kind === 'relation' ? criteria.relationType : null,
    agentPrincipalId: criteria.agentPrincipalId,
    llmModel: criteria.llmModel,
    includeAdHoc: criteria.includeAdHoc,
    authorId: actor.principalId,
    authorClientId: actor.clientId,
    authorIsOwner: true,
    order: 0,
  };
}

/** What a rule would accept among the open proposals of every live chain. */
function openPlacements(
  chains: readonly LoadedChain[],
  rule: AutoAcceptRuleRev,
): {
  accept: { chain: LoadedChain; open: OpenPlacement }[];
  blocked: Map<AutoAcceptBlockReason, number>;
} {
  const accept: { chain: LoadedChain; open: OpenPlacement }[] = [];
  const blocked = new Map<AutoAcceptBlockReason, number>();
  for (const chain of chains) {
    const outcome = openPlacementCandidates(chain.side, rule);
    for (const o of outcome.accept) accept.push({ chain, open: o });
    for (const [reason, n] of outcome.blocked) blocked.set(reason, (blocked.get(reason) ?? 0) + n);
  }
  return { accept, blocked };
}

// --------------------------------------------------------------- use cases

export function autoAcceptUseCases(deps: UseCaseDeps) {
  const procedureOf = (kind: AutoAcceptKind): DeclaredProcedure =>
    kind === 'relation' ? deps.expectedProcedure() : deps.expectedPlacementProcedure();

  /** The open items a rule accepts, as listed, with the records to write. */
  async function evaluateOpen(tx: Tx, projectId: ProjectId, rule: AutoAcceptRuleRev) {
    if (rule.kind === 'relation') {
      const loaded = await loadRelations(tx, projectId, procedureOf('relation'));
      const outcome = openRelationCandidates(loaded.side, rule);
      return {
        kind: 'relation' as const,
        loaded,
        relations: outcome.accept,
        placements: [] as { chain: LoadedChain; open: OpenPlacement }[],
        items: outcome.accept.map(relationItem),
        blocked: outcome.blocked,
      };
    }
    const chains = await loadChains(tx, projectId, procedureOf('placement'));
    const outcome = openPlacements(chains, rule);
    return {
      kind: 'placement' as const,
      loaded: null,
      relations: [] as ReturnType<typeof openRelationCandidates>['accept'],
      placements: outcome.accept,
      items: outcome.accept.map((a) => placementItem(a.chain.chain.key, a.open)),
      blocked: outcome.blocked,
    };
  }

  /** A write context for the relation side (decisions and revocations). */
  async function relationContext(
    tx: Tx,
    projectId: ProjectId,
    actor: Actor,
    loaded: Pick<LoadedRelations, 'records' | 'histories'>,
  ): Promise<ProposalContext> {
    return {
      tx,
      projectId,
      actor,
      fps: headFingerprints(await tx.facts.headProjectFacts(projectId)),
      relations: new Map(loaded.records.map((r) => [naturalKey(r.type, r.fromRef, r.toRef), r])),
      histories: new Map(loaded.histories),
      declared: null,
      submissionId: null,
    };
  }

  /** A write context for one chain's placements. */
  async function chainContext(
    tx: Tx,
    projectId: ProjectId,
    actor: Actor,
    chain: ValueChainRecord,
  ): Promise<PlacementContext> {
    const state = await loadChainState(tx, chain);
    const placements = await tx.placements.forChain(projectId, chain.id);
    return {
      tx,
      projectId,
      actor,
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
    };
  }

  return {
    /** The rules in creation order with statistics and agents, and the system rule (decision 9). */
    async listAutoAcceptRules(actor: Actor, projectRef: string): Promise<AutoAcceptRuleList> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'admin', projectRef);
        const heads = await tx.autoAcceptRules.heads(project.id);
        const owners = await ownersAmong(
          tx,
          project.id,
          heads.map((h) => h.principalId),
        );
        const { items, relations, relationHistories } = await loadLedger(tx, project.id);
        const stats = ruleStats(items);
        const agents = await agentDirectory(tx, project.id);
        const systemAccepted = relations.filter(
          (r) =>
            r.status === 'accepted' &&
            basisOf(relationHistories.get(r.id) ?? [])?.sourceKind === 'rule',
        ).length;
        return {
          items: heads.map((h) => ruleView(h, { owners, stats, agents })),
          system: systemRule(systemAccepted),
        };
      });
    },

    /** One rule with every revision. */
    async getAutoAcceptRule(
      actor: Actor,
      projectRef: string,
      ruleId: AutoAcceptRuleId,
    ): Promise<AutoAcceptRuleDetail> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'admin', projectRef);
        return ruleDetail(tx, project.id, ruleId);
      });
    },

    /**
     * Revision 1 of a new rule, authored by the caller (off unless `enabled`).
     *
     * @throws {DomainError} policy errors; `validation-failed` with `reason`
     */
    async createAutoAcceptRule(
      actor: Actor,
      projectRef: string,
      draft: AutoAcceptRuleDraft,
    ): Promise<SaveAutoAcceptRuleResult> {
      return deps.store.write(async (tx) => {
        const { project } = await policy.require(tx, actor, 'admin', projectRef);
        await tx.projects.lockForWrite(project.id);
        await checkDraft(tx, project.id, draft, null);
        const id = newId('autoAcceptRule');
        const fields = draftFields(draft);
        const seq = await tx.events.append(project.id, {
          type: 'auto_accept_rule.created',
          principalId: actor.principalId,
          clientId: actor.clientId,
          subjectRef: id,
          payload: { ruleId: id, kind: draft.kind, revision: 1, enabled: fields.enabled },
        });
        await tx.autoAcceptRules.insertRule({
          id,
          projectId: project.id,
          kind: draft.kind,
          createdBy: actor.principalId,
          seq,
        });
        await tx.autoAcceptRules.insertRevision({
          projectId: project.id,
          ruleId: id,
          kind: draft.kind,
          revision: 1,
          ...fields,
          principalId: actor.principalId,
          clientId: actor.clientId,
          sourceKind: 'human',
          seq,
        });
        return { outcome: 'created', rule: await ruleDetail(tx, project.id, id) };
      });
    },

    /**
     * Edits, enables or disables a rule: the draft becomes the next revision,
     * authored by the caller (the owner its later decisions are recorded
     * under). A draft equal to the head is `unchanged` whatever `If-Match`
     * names, unless the head's author is no longer an owner: then saving it
     * unchanged takes the rule over (a new revision authored by the caller,
     * after the same `If-Match` check), since such a rule matches nothing.
     *
     * @throws {DomainError} policy errors; `not-found`; `precondition-required`;
     *   `revision-conflict` (with `headRev`); `validation-failed` with `reason`
     */
    async reviseAutoAcceptRule(
      actor: Actor,
      projectRef: string,
      ruleId: AutoAcceptRuleId,
      draft: AutoAcceptRuleDraft,
      pre: RulePrecondition,
    ): Promise<SaveAutoAcceptRuleResult> {
      return deps.store.write(async (tx) => {
        const { project } = await policy.require(tx, actor, 'admin', projectRef);
        await tx.projects.lockForWrite(project.id);
        const found = await tx.autoAcceptRules.find(project.id, ruleId);
        if (!found) throw notFound();
        if (pre.kind === 'none') {
          throw new DomainError(
            'precondition-required',
            'send If-Match: "r<revision>" with the revision you edited',
          );
        }
        const { head } = found;
        if (draft.kind !== head.kind) throw invalid('kind-changed');
        const fields = draftFields(draft);
        // A rule whose author lost the owner role matches nothing: saving it takes it over.
        const takeOver =
          head.principalId !== actor.principalId &&
          !(await ownersAmong(tx, project.id, [head.principalId])).get(head.principalId);
        if (sameFields(head, fields) && !takeOver) {
          return { outcome: 'unchanged', rule: await ruleDetail(tx, project.id, ruleId) };
        }
        if (pre.rev !== head.revision) throw revisionConflict(head.revision);
        await checkDraft(tx, project.id, draft, ruleId);
        const revision = head.revision + 1;
        const seq = await tx.events.append(project.id, {
          type: 'auto_accept_rule.revised',
          principalId: actor.principalId,
          clientId: actor.clientId,
          subjectRef: ruleId,
          payload: {
            ruleId,
            revision,
            enabled: fields.enabled,
            ...(takeOver ? { takenOverFrom: head.principalId } : {}),
          },
        });
        await tx.autoAcceptRules.insertRevision({
          projectId: project.id,
          ruleId,
          kind: head.kind,
          revision,
          ...fields,
          principalId: actor.principalId,
          clientId: actor.clientId,
          sourceKind: 'human',
          seq,
        });
        return { outcome: 'revised', rule: await ruleDetail(tx, project.id, ruleId) };
      });
    },

    /**
     * What a rule (saved or not) would have accepted so far, what it would
     * accept now, and the curve over minimum confidences. Read-only.
     */
    async previewAutoAcceptRule(
      actor: Actor,
      projectRef: string,
      criteria: AutoAcceptCriteria,
    ): Promise<AutoAcceptPreview> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'admin', projectRef);
        const rule = draftRule(actor, criteria);
        const agents = await agentDirectory(tx, project.id);
        const seen = new Map<PrincipalId, string>();
        const models = new Set<string>();
        const collect = (
          histories: Iterable<
            readonly (StanceView & {
              handle: string;
              declared: { llmModel: string | null } | null;
            })[]
          >,
        ) => {
          for (const history of histories) {
            for (const a of history) {
              if (!isAgentProposal(a)) continue;
              seen.set(a.principalId, a.handle);
              if (a.declared?.llmModel) models.add(a.declared.llmModel);
            }
          }
        };
        let history: ReturnType<typeof replayHistory>;
        let openItems: AutoAcceptItem[];
        let openBlocked: ReadonlyMap<AutoAcceptBlockReason, number>;
        let openAt: (minConfidence: number) => number;
        if (rule.kind === 'relation') {
          const { side } = await loadRelations(tx, project.id, procedureOf('relation'));
          collect(side.histories.values());
          history = replayHistory({ kind: 'relation', relations: side }, rule);
          const open = openRelationCandidates(side, rule);
          openItems = open.accept.map(relationItem);
          openBlocked = open.blocked;
          openAt = (minConfidence) =>
            openRelationCandidates(side, { ...rule, minConfidence }).accept.length;
        } else {
          const chains = await loadChains(tx, project.id, procedureOf('placement'));
          for (const c of chains) collect(c.side.histories.values());
          history = replayHistory(
            { kind: 'placement', placements: chains.map((c) => c.side) },
            rule,
          );
          const open = openPlacements(chains, rule);
          openItems = open.accept.map((a) => placementItem(a.chain.chain.key, a.open));
          openBlocked = open.blocked;
          openAt = (minConfidence) =>
            openPlacements(chains, { ...rule, minConfidence }).accept.length;
        }
        return {
          kind: rule.kind,
          history: history.history,
          open: {
            count: openItems.length,
            items: openItems.slice(0, AUTO_ACCEPT_PREVIEW_ITEMS),
            blocked: blockedCounts(openBlocked),
          },
          curve: history.curve.map((point, i) => ({
            ...point,
            open: openAt(AUTO_ACCEPT_CURVE[i] ?? point.minConfidence),
          })),
          agents: [...seen]
            .map(([principalId, handle]) => agentOf(agents, principalId, handle))
            .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0)),
          llmModels: [...models].sort(),
        };
      });
    },

    /**
     * Applies a rule's head revision to the open proposals of its kind. A dry
     * run (a snapshot) lists them; the real call (under the project lock)
     * needs the head `revision`, an enabled rule whose author is still an
     * owner, and `expectedCount` equal to the fresh count, and records the
     * acceptances caused by the caller.
     *
     * @throws {DomainError} policy errors; `not-found`; `validation-failed`
     *   (`revision` or `expectedCount` missing); `conflict` with `count` and `revision`
     */
    async applyAutoAcceptRule(
      actor: Actor,
      projectRef: string,
      ruleId: AutoAcceptRuleId,
      body: ApplyAutoAcceptBody,
      options: { dryRun: boolean },
    ): Promise<ApplyAutoAcceptResult> {
      const run = async (tx: Tx): Promise<ApplyAutoAcceptResult> => {
        const { project } = await policy.require(tx, actor, 'admin', projectRef);
        if (!options.dryRun) await tx.projects.lockForWrite(project.id);
        const found = await tx.autoAcceptRules.find(project.id, ruleId);
        if (!found) throw notFound();
        const { head } = found;
        const owner = (await ownersAmong(tx, project.id, [head.principalId])).get(head.principalId);
        const rule = toRuleRev(head, head.ruleSeq, owner ?? false);
        // A dry run shows what the head would accept even while it is off.
        const evaluated = await evaluateOpen(tx, project.id, {
          ...rule,
          enabled: true,
          authorIsOwner: true,
        });
        const count = evaluated.items.length;
        const result = (items: AutoAcceptItem[]): ApplyAutoAcceptResult => ({
          dryRun: options.dryRun,
          ruleId,
          revision: head.revision,
          enabled: head.enabled,
          authorIsOwner: owner ?? false,
          count,
          items: items.slice(0, MAX_AUTO_ACCEPT_ITEMS),
          truncated: items.length > MAX_AUTO_ACCEPT_ITEMS,
          blocked: blockedCounts(evaluated.blocked),
        });
        if (options.dryRun) return result(evaluated.items);

        if (body.revision === undefined || body.expectedCount === undefined) {
          throw new DomainError(
            'validation-failed',
            'applying needs the head revision and the count of the dry run',
            { reason: 'expected-count-required' },
          );
        }
        const conflict = (reason: ApplyConflictReason, detail: string) =>
          new DomainError('conflict', detail, { count, revision: head.revision, reason });
        if (!head.enabled) throw conflict('rule-disabled', 'the rule is disabled; enable it first');
        if (!owner) {
          throw conflict(
            'author-not-owner',
            'the rule’s author is no longer an owner; save the rule again to take it over',
          );
        }
        if (body.revision !== head.revision) {
          throw conflict('revision-changed', `the rule is at r${head.revision}; preview it again`);
        }
        if (body.expectedCount !== count) {
          throw conflict(
            'count-changed',
            `the rule would accept ${count} proposals now; preview it again`,
          );
        }
        const by: Cause = { principalId: actor.principalId, clientId: actor.clientId };
        const items: AutoAcceptItem[] = [];
        if (evaluated.kind === 'relation' && evaluated.loaded) {
          const ctx = await relationContext(tx, project.id, actor, evaluated.loaded);
          for (const o of evaluated.relations) {
            const relation =
              ctx.relations.get(
                naturalKey(o.relation.type, o.relation.fromRef, o.relation.toRef),
              ) ?? (o.relation as RelationRecord);
            const stored = await recordRelationAutoAccept(ctx, relation, o.trigger.id, rule, by);
            items.push(relationItem({ ...o, relation: stored }));
          }
        } else {
          const contexts = new Map<string, PlacementContext>();
          for (const { chain, open } of evaluated.placements) {
            let ctx = contexts.get(chain.chain.id);
            if (!ctx) {
              ctx = await chainContext(tx, project.id, actor, chain.chain);
              contexts.set(chain.chain.id, ctx);
            }
            const key = placementKey(
              chain.chain.id,
              open.placement.elementId,
              open.placement.generation,
              open.placement.processRef,
            );
            const placement = ctx.placements.get(key) ?? open.placement;
            const stored = await recordPlacementAutoAccept(
              ctx,
              placement,
              open.trigger.id,
              rule,
              by,
            );
            items.push(placementItem(chain.chain.key, { ...open, placement: stored }));
          }
        }
        await tx.events.append(project.id, {
          type: 'auto_accept_rule.applied',
          principalId: actor.principalId,
          clientId: actor.clientId,
          subjectRef: ruleId,
          payload: { ruleId, revision: head.revision, count },
        });
        return result(items);
      };
      return options.dryRun ? deps.store.read(run) : deps.store.write(run);
    },

    /**
     * Revokes the auto-acceptances a filter selects that are still in force:
     * each is withdrawn (a human withdrawal under the decision's principal,
     * caused by the caller); its item returns to `proposed` while a live
     * proposal remains, else it turns `obsolete` and is judged again (the
     * endpoint models are queued, or the chain's placement task when a
     * process is due). Acceptances a human decided since stay untouched.
     *
     * @throws {DomainError} policy errors; `not-found` (an unknown `ruleId`);
     *   `validation-failed` (`expectedCount` missing); `conflict` with `count`
     */
    async revokeAutoAccepted(
      actor: Actor,
      projectRef: string,
      body: AutoAcceptRevocationBody,
      options: { dryRun: boolean },
    ): Promise<AutoAcceptRevocationResult> {
      const run = async (tx: Tx): Promise<AutoAcceptRevocationResult> => {
        const { project } = await policy.require(tx, actor, 'admin', projectRef);
        if (!options.dryRun) await tx.projects.lockForWrite(project.id);
        if (
          body.ruleId !== undefined &&
          !(await tx.autoAcceptRules.find(project.id, body.ruleId))
        ) {
          throw notFound();
        }
        const { items, relations, relationHistories } = await loadLedger(tx, project.id);
        const selected = filterLedger(items, {
          kind: body.kind,
          ruleId: body.ruleId,
          revision: body.revision,
          agentPrincipalId: body.agentPrincipalId,
          ids: body.ids ? new Set<string>(body.ids) : undefined,
        });
        const inForce = selected.filter((i) => i.entry.state === 'in-force');
        const outcomes = inForce.map((i) => ({ item: i, outcome: outcomeAfterRevocation(i) }));
        const count = inForce.length;
        const result = (list: AutoAcceptRevocationItem[]): AutoAcceptRevocationResult => ({
          dryRun: options.dryRun,
          count,
          toProposed: outcomes.filter((o) => o.outcome === 'proposed').length,
          toObsolete: outcomes.filter((o) => o.outcome === 'obsolete').length,
          humanDecidedSince: selected.filter((i) => i.entry.state === 'human-decided').length,
          alreadyRevoked: selected.filter((i) => i.entry.state === 'revoked').length,
          items: list.slice(0, MAX_AUTO_ACCEPT_ITEMS),
          truncated: list.length > MAX_AUTO_ACCEPT_ITEMS,
        });
        if (options.dryRun) {
          return result(outcomes.map((o) => ({ ...o.item.entry, outcome: o.outcome })));
        }
        if (body.expectedCount === undefined) {
          throw new DomainError('validation-failed', 'revoking needs the count of the dry run', {
            reason: 'expected-count-required',
          });
        }
        if (body.expectedCount !== count) {
          throw new DomainError(
            'conflict',
            `${count} auto-acceptances would be revoked now; run the dry run again`,
            { count },
          );
        }
        const by: Cause = { principalId: actor.principalId, clientId: actor.clientId };
        const reason = body.reason ?? null;
        const done: AutoAcceptRevocationItem[] = [];
        const lostModels = new Set<string>();
        let placementsRevoked = false;
        const relationItems = outcomes.filter((o) => o.item.entry.kind === 'relation');
        if (relationItems.length > 0) {
          const ctx = await relationContext(tx, project.id, actor, {
            records: relations,
            histories: relationHistories,
          });
          const byId = new Map(relations.map((r) => [r.id as string, r]));
          for (const { item } of relationItems) {
            const record = byId.get(item.entry.id);
            if (!record) continue;
            const relation =
              ctx.relations.get(naturalKey(record.type, record.fromRef, record.toRef)) ?? record;
            const stored = await revokeRelationAutoAccept(ctx, relation, item.decision, reason, by);
            const liveAgent = currentStances(ctx.histories.get(stored.id) ?? []).some(
              isAgentProposal,
            );
            if (!liveAgent) lostModels.add(modelOf(stored.fromRef)).add(modelOf(stored.toRef));
            done.push({
              ...item.entry,
              status: stored.status,
              endpointState: stored.endpointState,
              outcome: stored.status === 'obsolete' ? 'obsolete' : 'proposed',
            });
          }
        }
        const placementItems = outcomes.filter((o) => o.item.entry.kind === 'placement');
        if (placementItems.length > 0) {
          for (const chain of await tx.valueChains.list(project.id)) {
            const mine = placementItems.filter((o) => o.item.entry.valueChainKey === chain.key);
            if (mine.length === 0 || chain.headRevisionId === null) continue;
            const ctx = await chainContext(tx, project.id, actor, chain);
            const byId = new Map([...ctx.placements.values()].map((p) => [p.id as string, p]));
            for (const { item } of mine) {
              const placement = byId.get(item.entry.id);
              if (!placement) continue;
              const current =
                ctx.placements.get(
                  placementKey(
                    chain.id,
                    placement.elementId,
                    placement.generation,
                    placement.processRef,
                  ),
                ) ?? placement;
              const stored = await revokePlacementAutoAccept(
                ctx,
                current,
                item.decision,
                reason,
                by,
              );
              placementsRevoked = true;
              done.push({
                ...item.entry,
                status: stored.status,
                endpointState: stored.endpointState,
                outcome: stored.status === 'obsolete' ? 'obsolete' : 'proposed',
              });
            }
          }
        }
        // A lost judgement is judged again (as a withdrawn pipeline proposal is).
        if (lostModels.size > 0) await requeueAfterLoss(tx, actor, project.id, lostModels);
        if (placementsRevoked) {
          await queuePlacementTasks(
            tx,
            actor,
            project.id,
            'judgement withdrawn',
            procedureOf('placement'),
          );
        }
        await tx.events.append(project.id, {
          type: 'auto_accept.revoked',
          principalId: actor.principalId,
          clientId: actor.clientId,
          subjectRef: body.ruleId ?? null,
          payload: {
            ...(body.ruleId === undefined ? {} : { ruleId: body.ruleId }),
            ...(body.revision === undefined ? {} : { revision: body.revision }),
            ...(body.agentPrincipalId === undefined
              ? {}
              : { agentPrincipalId: body.agentPrincipalId }),
            ...(body.kind === undefined ? {} : { kind: body.kind }),
            ...(body.ids === undefined ? {} : { ids: body.ids.length }),
            count: done.length,
          },
        });
        return result(done);
      };
      return options.dryRun ? deps.store.read(run) : deps.store.write(run);
    },

    /**
     * The project's auto-acceptances and their state, oldest first: what the
     * review views mark. Every human reviewer reads it (`review`), not only
     * owners; it names rules and revisions, never their criteria.
     */
    async listAutoAccepted(
      actor: Actor,
      projectRef: string,
      query: AutoAcceptLedgerQuery,
    ): Promise<AutoAcceptLedger> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'review', projectRef);
        const { items } = await loadLedger(tx, project.id);
        return {
          items: filterLedger(items, {
            kind: query.kind,
            ruleId: query.ruleId,
            state: query.state,
            agentPrincipalId: query.agentPrincipalId,
          }).map((i) => i.entry),
        };
      });
    },
  };
}

/** The status an item returns to when its acceptance is revoked (as the revocation computes it). */
function outcomeAfterRevocation(item: LedgerItem): 'proposed' | 'obsolete' {
  const history = item.subject.history;
  const maxSeq = history.reduce((m, a) => Math.max(m, a.seq), 0);
  const withdrawal = {
    seq: maxSeq + 1,
    kind: 'withdrawal' as const,
    verdict: null,
    sourceKind: 'human' as const,
    principalId: item.decision.principalId,
    tier: null,
    confidence: null,
    autoAcceptRuleId: item.decision.autoAcceptRuleId ?? null,
  };
  const status =
    item.subject.kind === 'relation'
      ? recomputeStatus([...history, withdrawal].map((a) => ({ ...a, fromFp: null, toFp: null })))
          .status
      : recomputePlacementStatus(
          [...history, withdrawal].map((a) => ({ ...a, stepFp: null, processFp: null })),
        ).status;
  return status === 'obsolete' ? 'obsolete' : 'proposed';
}
