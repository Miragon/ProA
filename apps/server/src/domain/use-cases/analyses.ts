/**
 * The analysis pipeline (CONCEPT §3 "Claim and lease", M2 items 1–3):
 * claim, submit, release, the pending long-poll, requeue and the task list.
 * Claims and submissions need `proa:propose` and the editor role in the
 * task's project; the lease token binds a claim to its task and principal.
 */
import {
  LEASE_MINUTES,
  MAX_ATTEMPTS,
  MAX_SUBMISSION_BYTES,
  MAX_UNCOVERED_PAIRS,
  isRef,
  newId,
  parseRef,
  type AnalysisQuery,
  type AnalysisSubmission,
  type AnalysisTaskId,
  type AnalysisTaskPage,
  type ClaimAnalysisBody,
  type ClaimResult,
  type NoLinkOutcome,
  type PendingAnalyses,
  type PendingQuery,
  type ProjectId,
  type Ref,
  type ReleaseAnalysisBody,
  type ReleaseResult,
  type RequeueBody,
  type RequeueResult,
  type SubmissionItemResult,
  type SubmissionResult,
  type SubmitAnalysisBody,
} from '@proa/contracts';

import { sourceKindOf, type Actor } from '../actor.ts';
import { renderClaimInput, type ClaimModel } from '../claim-input.ts';
import { decodeCursor, toPage } from '../cursor.ts';
import { DomainError } from '../errors.ts';
import { visibleFindings } from '../findings.ts';
import { headFingerprints } from '../fingerprints.ts';
import { cancelTask, queueTask } from '../ingest.ts';
import {
  isAssigned,
  isAssignedRelation,
  isCurrent,
  linkJudgements,
  livePipelineProposals,
  modelOf,
  noLinkJudgement,
  pairKey,
  planClaim,
  relationPair,
  settles,
  staleFor,
  type PartnerTask,
} from '../judgements.ts';
import { leaseTokenHash, newLeaseToken, sameLeaseHash } from '../lease.ts';
import { touchRelations, validateNoLink } from '../no-links.ts';
import { jsonBytes, storablePayload } from '../payload.ts';
import { effectiveScopes, evaluate, policy } from '../policy.ts';
import type {
  AssertionRecord,
  NoLinkRecord,
  ProjectRecord,
  RelationRecord,
  StoredAssertion,
  StoredNoLink,
  TaskDetail,
  Tx,
} from '../ports.ts';
import {
  applyProposal,
  validateProposal,
  withdrawStance,
  type ProposalContext,
} from '../proposals.ts';
import { byRelation, naturalKey } from '../relation-state.ts';
import { toAnalysisTask } from '../views.ts';
import { ALL, type UseCaseDeps } from './deps.ts';

const MINUTE = 60_000;

/**
 * The projects a claim or the pending count covers: the given one (policy
 * `propose`), else every project where the caller may propose (editor or
 * better, CONCEPT §3). A credential without `proa:propose` is refused even
 * without a project.
 */
async function eligibleProjects(
  tx: Tx,
  actor: Actor,
  projectRef: string | undefined,
): Promise<ProjectRecord[]> {
  if (projectRef !== undefined) {
    return [(await policy.require(tx, actor, 'propose', projectRef)).project];
  }
  if (!effectiveScopes(actor.scopes).has('proa:propose')) {
    throw new DomainError('insufficient-scope', 'requires scope proa:propose');
  }
  if (actor.binding) {
    const denial = evaluate(actor, 'propose', actor.binding.role);
    if (denial) throw new DomainError(denial.code, denial.detail);
    const project = await tx.projects.findByRef(actor.binding.projectId);
    return project ? [project] : [];
  }
  const rows = await tx.projects.listForPrincipal(actor.principalId, { limit: ALL });
  return rows.filter((p) => evaluate(actor, 'propose', p.role) === null);
}

/** Resolves a task id to its project (404 for unknown and foreign tasks) and checks `permission`. */
async function taskProject(
  tx: Tx,
  actor: Actor,
  taskId: AnalysisTaskId,
  permission: 'propose' | 'read',
): Promise<ProjectRecord> {
  const projectId = await tx.tasks.projectOf(taskId);
  if (!projectId) throw new DomainError('not-found', 'analysis task not found');
  return (await policy.require(tx, actor, permission, projectId)).project;
}

function leaseLost(): DomainError {
  return new DomainError(
    'lease-lost',
    'the lease is not yours any more (expired and claimed again, released, or a wrong token)',
  );
}

const touches = (r: RelationRecord, modelKey: string) =>
  r.fromRef.startsWith(`${modelKey}#`) || r.toRef.startsWith(`${modelKey}#`);

const touchesPair = (p: { from: string; to: string }, modelKey: string) =>
  p.from.startsWith(`${modelKey}#`) || p.to.startsWith(`${modelKey}#`);

const noLinkKey = (n: Pick<StoredNoLink, 'type' | 'fromRef' | 'toRef'>) =>
  pairKey({ type: n.type, from: n.fromRef, to: n.toRef });

/** A claimed task of this call, with its lease token. */
interface Claimed {
  task: TaskDetail;
  token: string;
  project: ProjectRecord;
}

/**
 * Renders the inputs of freshly claimed tasks inside the claim transaction,
 * under the project lock (judge each pair once): the state at the claim's
 * `claimed_seq` is exactly what the input shows. Per task it lists the
 * current judgements and the skipped pairs, and stores the assignment, so a
 * later claim of a partner reads what this claim was told. Tasks of one
 * call are planned in order: a later one sees the earlier ones' assignments.
 */
async function renderClaims(
  tx: Tx,
  deps: UseCaseDeps,
  actor: Actor,
  claimed: readonly Claimed[],
  now: Date,
  leaseUntil: Date,
): Promise<ClaimResult['items']> {
  const procedure = deps.expectedProcedure();
  const result: ClaimResult['items'] = [];
  const byProject = new Map<ProjectId, Claimed[]>();
  for (const c of claimed) byProject.set(c.project.id, [...(byProject.get(c.project.id) ?? []), c]);
  for (const [projectId, group] of byProject) {
    const projectFacts = await tx.facts.headProjectFacts(projectId);
    const relations = (await tx.relations.all(projectId)).filter((r) => r.status !== 'obsolete');
    const histories = byRelation<StoredAssertion>(await tx.assertions.listForProject(projectId));
    // As `GET …/findings` lists them; the input keeps those touching the model.
    const findings = visibleFindings(await tx.findings.list(projectId), relations);
    const heads = await tx.revisions.headHashes(projectId);
    const links = linkJudgements(
      relations,
      histories,
      await tx.submissions.originModels(projectId),
      heads,
      procedure,
    );
    const settled = new Set(
      relations.filter(settles).map((r) => naturalKey(r.type, r.fromRef, r.toRef)),
    );
    // Relations are assigned like systematic candidates, whatever their pair's basis.
    const assignedRelations = relations.filter(isAssignedRelation);
    const relationPairsOf = (modelKey: string) =>
      assignedRelations.filter((r) => touches(r, modelKey)).map(relationPair);
    // Open tasks by model key; this call's tasks are claimed already, without assignment.
    const open = new Map<string, TaskDetail>();
    for (const state of ['queued', 'claimed'] as const) {
      for (const t of await tx.tasks.list(projectId, { state }, { limit: ALL })) {
        open.set(t.modelKey, t);
      }
    }
    // What a partner's claim would assign (rule 2 stays symmetric).
    const partnerCandidates = new Map<string, ReadonlySet<string>>();
    const candidatesOf = (modelKey: string) => {
      let keys = partnerCandidates.get(modelKey);
      if (!keys) {
        keys = new Set([
          ...deps.analysis.candidates(projectFacts, modelKey).filter(isAssigned).map(pairKey),
          ...relationPairsOf(modelKey).map(pairKey),
        ]);
        partnerCandidates.set(modelKey, keys);
      }
      return keys;
    };

    for (const { task, token, project } of group) {
      const model = await claimModel(tx, task);
      const head = await tx.revisions.findInProject(projectId, task.modelId, model.revisionId);
      const partners = new Map<string, PartnerTask>();
      for (const t of open.values()) {
        if (t.modelKey === task.modelKey) continue;
        if (t.state === 'queued') {
          partners.set(t.modelKey, {
            state: 'queued',
            live: false,
            assignment: new Set(),
            sawClaimant: false,
          });
          continue;
        }
        const assignment = new Set((t.assignment ?? []).map(pairKey));
        const live = t.leaseUntil !== null && t.leaseUntil > now;
        partners.set(t.modelKey, {
          state: 'claimed',
          live,
          assignment,
          sawClaimant:
            live && assignment.size > 0 && (await sawModel(tx, projectId, t, task, head?.seq)),
        });
      }
      const candidates = deps.analysis.candidates(projectFacts, task.modelKey);
      const noLinks = await tx.noLinks.listLive(
        projectId,
        { touchingModelKey: task.modelKey },
        procedure,
      );
      const plan = planClaim({
        modelKey: task.modelKey,
        candidates,
        relations: relationPairsOf(task.modelKey),
        judgements: [
          ...links.filter((j) => touchesPair(j, task.modelKey)),
          ...noLinks.map(noLinkJudgement),
        ],
        settled,
        partners,
        partnerCandidates: candidatesOf,
      });
      await tx.tasks.setAssignment(projectId, task.id, plan.assignment);
      open.set(task.modelKey, { ...task, assignment: plan.assignment });
      // Each pair is listed once: a judged or skipped pair only in `judged` or `skip`,
      // so `candidates` holds what is left to judge (the assignment, the `compatible`
      // search space and settled pairs) and a late claim stays small.
      const listed = new Set([...plan.judged, ...plan.skip].map(pairKey));
      const input = renderClaimInput({
        model,
        projectFacts,
        candidates: candidates.filter((c) => !listed.has(pairKey(c))),
        relations: relations.filter((r) => touches(r, task.modelKey)),
        histories,
        findings,
        judged: plan.judged,
        skip: plan.skip,
        claimant: actor.principalId,
      });
      result.push({
        taskId: task.id,
        projectId: project.id,
        projectKey: project.key,
        modelId: task.modelId,
        modelKey: task.modelKey,
        revisionId: task.revisionId,
        attempt: task.attempts,
        leaseToken: token,
        leaseUntil: leaseUntil.toISOString(),
        procedure,
        input,
      });
    }
  }
  // In claim order.
  return claimed
    .map((c) => result.find((i) => i.taskId === c.task.id))
    .filter((i) => i !== undefined);
}

/**
 * Whether the claim of `partner` saw the model of `task` as it is now: the
 * model's revision at the partner's `claimed_seq` has the task's facts (no
 * newer revision, or only layout changes since).
 *
 * @param headSeq seq of the model's head revision
 */
async function sawModel(
  tx: Tx,
  projectId: ProjectId,
  partner: TaskDetail,
  task: TaskDetail,
  headSeq: number | undefined,
): Promise<boolean> {
  if (partner.claimedSeq === null) return false;
  if (headSeq !== undefined && headSeq <= partner.claimedSeq) return true;
  const at = await tx.revisions.hashesAt(projectId, [task.modelKey], partner.claimedSeq);
  return at.get(task.modelKey) === task.factsHash;
}

const TASK_STATES = ['queued', 'claimed', 'done', 'failed', 'cancelled'] as const;

/**
 * Turns claimed tasks whose lease expired at the last attempt into `failed`
 * (with `analysis.failed`, noticed by `actor`). Nothing runs on a timer
 * (CONCEPT §3): the claim, the pending count and a requeue call this inside
 * their writing transaction, after locking the projects.
 */
async function failExpiredTasks(
  tx: Tx,
  actor: Actor,
  projectIds: readonly ProjectId[],
  now: Date,
): Promise<void> {
  const failed = await tx.tasks.failExpired(
    projectIds,
    now,
    MAX_ATTEMPTS,
    `lease expired ${MAX_ATTEMPTS} times`,
  );
  for (const t of failed) {
    await tx.events.append(t.projectId, {
      type: 'analysis.failed',
      principalId: actor.principalId,
      clientId: actor.clientId,
      subjectRef: t.modelKey,
      payload: {
        taskId: t.id,
        kind: t.kind,
        modelId: t.modelId,
        modelKey: t.modelKey,
        attempts: t.attempts,
        reason: t.lastError,
      },
    });
  }
}

/**
 * Why a failed task may no longer take its holder's late submit: a newer
 * task of the model exists (requeue, new facts), or the model changed or was
 * deleted after the task failed. A late submit would otherwise supersede the
 * newer analysis with proposals from an older input. `null`: still current.
 */
async function supersededFailure(tx: Tx, task: TaskDetail): Promise<string | null> {
  const latest = await tx.tasks.latest(task.projectId, task.modelId, TASK_STATES);
  if (latest && latest.seq > task.seq) return 'superseded by a newer analysis task of the model';
  const model = await tx.models.findInProject(task.projectId, task.modelId);
  const head =
    model && model.deletedSeq === null && model.headRevisionId
      ? await tx.revisions.findInProject(task.projectId, model.id, model.headRevisionId)
      : null;
  if (!head) return 'the model was deleted after the task failed';
  if (head.factsHash !== task.factsHash) return 'the model changed after the task failed';
  return null;
}

export function analysisUseCases(deps: UseCaseDeps) {
  /** Claimable counts per project, now. */
  async function claimable(projects: readonly ProjectRecord[]): Promise<PendingAnalyses> {
    const counts = await deps.store.read((tx) =>
      tx.tasks.countClaimable(
        projects.map((p) => p.id),
        deps.clock.now(),
        MAX_ATTEMPTS,
      ),
    );
    const items = projects.map((p) => ({
      projectId: p.id,
      projectKey: p.key,
      pending: counts.get(p.id) ?? 0,
    }));
    return { total: items.reduce((n, i) => n + i.pending, 0), items };
  }

  /**
   * Fails tasks whose last lease expired, so their models show
   * `agent_failed` (and can be requeued) even when nobody claims in the
   * project: a cheap read first, a short write only when there is one.
   */
  async function failExpiredIn(actor: Actor, projects: readonly ProjectRecord[]): Promise<void> {
    const now = deps.clock.now();
    const ids = projects.map((p) => p.id);
    const any = await deps.store.read((tx) => tx.tasks.hasExpired(ids, now, MAX_ATTEMPTS));
    if (!any) return;
    await deps.store.write(async (tx) => {
      const ordered = [...ids].sort();
      for (const id of ordered) await tx.projects.lockForWrite(id);
      await failExpiredTasks(tx, actor, ordered, now);
    });
  }

  return {
    /**
     * `claim_analysis` (CONCEPT §3): one transaction locks the projects,
     * fails tasks whose lease expired at the last attempt, claims up to
     * `max` tasks with `FOR UPDATE SKIP LOCKED`, sets a hashed lease token
     * and `claimed_seq` per task, and renders the inputs with their
     * assignments ({@link renderClaims}). If an input cannot be built, the
     * tasks are handed back at once (the caller never sees their tokens).
     *
     * @throws {DomainError} `insufficient-scope`, `forbidden`, `not-found`
     */
    async claimAnalyses(actor: Actor, body: ClaimAnalysisBody): Promise<ClaimResult> {
      const now = deps.clock.now();
      const leaseUntil = new Date(now.getTime() + LEASE_MINUTES * MINUTE);
      const outcome = await deps.store.write(async (tx) => {
        const projects = await eligibleProjects(tx, actor, body.projectId);
        if (projects.length === 0) return { items: [] };
        // Writers lock the project first (ingest does too): no lock-order deadlocks.
        const ordered = [...projects].sort((a, b) => (a.id < b.id ? -1 : 1));
        for (const p of ordered) await tx.projects.lockForWrite(p.id);
        const ids = ordered.map((p) => p.id);

        await failExpiredTasks(tx, actor, ids, now);

        const tasks = await tx.tasks.claim({
          projectIds: ids,
          modelKey: body.modelKey,
          principalId: actor.principalId,
          now,
          leaseUntil,
          maxAttempts: MAX_ATTEMPTS,
          limit: body.max,
        });
        const out: Claimed[] = [];
        for (const task of tasks) {
          const token = newLeaseToken();
          await tx.tasks.setLeaseHash(
            task.projectId,
            task.id,
            leaseTokenHash(task.id, actor.principalId, token),
          );
          const claimedSeq = await tx.events.append(task.projectId, {
            type: 'analysis.claimed',
            principalId: actor.principalId,
            clientId: actor.clientId,
            subjectRef: task.modelKey,
            payload: {
              taskId: task.id,
              kind: task.kind,
              modelId: task.modelId,
              modelKey: task.modelKey,
              revisionId: task.revisionId,
              attempt: task.attempts,
              leaseUntil: leaseUntil.toISOString(),
            },
          });
          await tx.tasks.setClaimedSeq(task.projectId, task.id, claimedSeq);
          const project = projects.find((p) => p.id === task.projectId);
          if (!project)
            throw new Error(`claimed a task of an unexpected project ${task.projectId}`);
          out.push({ task: { ...task, claimedSeq }, token, project });
        }
        if (out.length === 0) return { items: [] };
        try {
          return { items: await renderClaims(tx, deps, actor, out, now, leaseUntil) };
        } catch (failure) {
          // The caller never sees the lease tokens: hand the tasks back at once.
          for (const { task } of out) {
            await tx.tasks.release(task.projectId, task.id, 'the claim input could not be built');
            await tx.events.append(task.projectId, {
              type: 'analysis.released',
              principalId: actor.principalId,
              clientId: actor.clientId,
              subjectRef: task.modelKey,
              payload: {
                taskId: task.id,
                kind: task.kind,
                modelId: task.modelId,
                modelKey: task.modelKey,
                reason: 'the claim input could not be built',
              },
            });
          }
          return { failure };
        }
      });
      if ('failure' in outcome) throw outcome.failure;
      return outcome;
    },

    /**
     * `submit_analysis` (CONCEPT §3, judge each pair once), in one
     * transaction: validates and records the proposals with their basis
     * (the task's facts for this model, a partner as the claim showed it),
     * validates the no-links, withdraws the live judgements on pairs touching
     * the model that are stale on its side (another version of the model or
     * another procedure) and the caller's own judgements of this model's
     * analyses that a new one replaces, reports the assigned pairs left
     * unjudged, marks the task done, stores the submission and the new
     * no-links, and queues a follow-up task when a judgement the claim relied
     * on was withdrawn meanwhile (`requeue_after`).
     *
     * A late submit passes while the token and principal match and the task
     * was neither claimed again nor cancelled (also after the task failed).
     * Replaying the `submissionId` returns the stored result.
     *
     * @param raw the request as received (stored verbatim minus the lease token, U+0000 as U+FFFD); defaults to `body`
     * @throws {DomainError} `payload-too-large` (stored payload over 1 MB), `lease-lost`, `task-cancelled`, `already-submitted`, `not-found`, policy errors
     */
    async submitAnalysis(
      actor: Actor,
      taskId: AnalysisTaskId,
      body: SubmitAnalysisBody,
      raw?: unknown,
    ): Promise<SubmissionResult> {
      // Stored as received minus the lease token; one limit for REST and MCP.
      const { leaseToken: _secret, ...verbatim } = (
        raw !== null && typeof raw === 'object' ? raw : body
      ) as Record<string, unknown>;
      const payload = storablePayload(verbatim);
      if (jsonBytes(payload) > MAX_SUBMISSION_BYTES) {
        throw new DomainError(
          'payload-too-large',
          `a submission may have at most ${MAX_SUBMISSION_BYTES} bytes`,
        );
      }
      return deps.store.write(async (tx) => {
        const project = await taskProject(tx, actor, taskId, 'propose');
        await tx.projects.lockForWrite(project.id);
        const task = await tx.tasks.findInProject(project.id, taskId, { forUpdate: true });
        if (!task) throw new DomainError('not-found', 'analysis task not found');
        const holder =
          task.claimedBy === actor.principalId &&
          sameLeaseHash(
            task.leaseTokenHash,
            leaseTokenHash(task.id, actor.principalId, body.leaseToken),
          );

        if (task.state === 'done' && holder) {
          const stored = await tx.submissions.findByTask(project.id, task.id);
          if (stored?.clientSubmissionId === body.submissionId) {
            return { ...stored.result, replayed: true };
          }
          throw new DomainError('already-submitted', 'this task already has another submission', {
            submissionId: stored?.clientSubmissionId,
          });
        }
        if (task.state === 'cancelled') {
          throw new DomainError('task-cancelled', task.lastError ?? 'the task was cancelled');
        }
        if (!holder || (task.state !== 'claimed' && task.state !== 'failed')) throw leaseLost();
        if (task.state === 'failed') {
          const superseded = await supersededFailure(tx, task);
          if (superseded) throw new DomainError('task-cancelled', superseded);
        }

        const procedure = deps.expectedProcedure();
        const submissionId = newId('submission');
        const projectFacts = await tx.facts.headProjectFacts(project.id);
        const assess = deps.analysis.pairAssessor(projectFacts);
        const relations = new Map<string, RelationRecord>();
        for (const r of await tx.relations.all(project.id)) {
          relations.set(naturalKey(r.type, r.fromRef, r.toRef), r);
        }
        const heads = await tx.revisions.headHashes(project.id);
        // The basis the agent saw: this model as the task analyses it, a partner as
        // it was at the claim, or as it is now if it had no head then (created or
        // revived after the claim and found through a tool).
        const partnerKeys = new Set<string>();
        for (const i of [...body.relations, ...body.noLinks]) {
          for (const ref of [i.from, i.to]) {
            if (isRef(ref) && parseRef(ref).modelKey !== task.modelKey) {
              partnerKeys.add(parseRef(ref).modelKey);
            }
          }
        }
        const atClaim =
          task.claimedSeq === null
            ? new Map<string, string>()
            : await tx.revisions.hashesAt(project.id, [...partnerKeys], task.claimedSeq);
        const hashOf = (ref: Ref): string => {
          const key = modelOf(ref);
          const hash =
            key === task.modelKey ? task.factsHash : (atClaim.get(key) ?? heads.get(key));
          if (hash === undefined) throw new Error(`no head of ${key} for a validated ref`);
          return hash;
        };
        const ctx: ProposalContext = {
          tx,
          projectId: project.id,
          actor,
          fps: headFingerprints(projectFacts),
          relations,
          histories: byRelation<AssertionRecord>(await tx.assertions.listForProject(project.id)),
          declared: { procedure: body.procedure, llmModel: body.llmModel },
          submissionId,
          basisOf: (from, to) => ({ fromHash: hashOf(from), toHash: hashOf(to) }),
        };
        const by = { principalId: actor.principalId, clientId: actor.clientId };

        // 1. Relation items.
        const items: SubmissionItemResult[] = [];
        const seen = new Set<string>();
        for (const [index, item] of body.relations.entries()) {
          const valid = validateProposal(
            {
              type: item.type,
              from: item.from,
              to: item.to,
              confidence: item.confidence,
              rationale: item.rationale,
              evidence: item.evidence,
              question: item.question,
            },
            assess,
            task.modelKey,
          );
          if (!valid.ok) {
            items.push({
              index,
              result: `invalid:${valid.reason}`,
              relationId: null,
              status: null,
            });
            continue;
          }
          const key = naturalKey(valid.value.type, valid.value.from, valid.value.to);
          if (seen.has(key)) {
            items.push({
              index,
              result: 'duplicate',
              relationId: relations.get(key)?.id ?? null,
              status: null,
            });
            continue;
          }
          seen.add(key);
          const { effect, relation } = await applyProposal(ctx, valid.value);
          items.push({ index, result: effect, relationId: relation.id, status: null });
        }

        // 2. No-links: `duplicate` against the caller's live, current no-link on the typed pair.
        const ownCurrent = new Set(
          (await tx.noLinks.listLive(project.id, { principalId: actor.principalId }, procedure))
            .filter((n) => n.current)
            .map(noLinkKey),
        );
        const noLinkItems: { index: number; result: NoLinkOutcome }[] = [];
        const judgedNoLinks = new Set<string>();
        const fresh: Omit<NoLinkRecord, 'seq'>[] = [];
        const sourceKind = sourceKindOf(actor);
        for (const [index, item] of body.noLinks.entries()) {
          const valid = validateNoLink(item, assess, task.modelKey);
          if (!valid.ok) {
            noLinkItems.push({ index, result: `invalid:${valid.reason}` });
            continue;
          }
          const key = pairKey(valid.value);
          if (seen.has(key)) {
            noLinkItems.push({ index, result: 'invalid:also-proposed' });
            continue;
          }
          if (judgedNoLinks.has(key) || ownCurrent.has(key)) {
            judgedNoLinks.add(key);
            noLinkItems.push({ index, result: 'duplicate' });
            continue;
          }
          judgedNoLinks.add(key);
          fresh.push({
            id: newId('noLink'),
            projectId: project.id,
            type: valid.value.type,
            fromRef: valid.value.from,
            toRef: valid.value.to,
            fromModel: modelOf(valid.value.from),
            toModel: modelOf(valid.value.to),
            fromHash: hashOf(valid.value.from),
            toHash: hashOf(valid.value.to),
            reason: valid.value.reason,
            sourceKind,
            principalId: actor.principalId,
            clientId: actor.clientId,
            declared: { procedure: body.procedure, llmModel: body.llmModel },
            submissionId,
            modelId: task.modelId,
          });
          noLinkItems.push({ index, result: 'stored' });
        }
        const freshKeys = new Set(fresh.map(noLinkKey));

        // 3. Supersession: live judgements on pairs touching the model that are stale on
        //    its side, any origin and principal; current ones stay. Replacement: the
        //    caller's own judgement from an analysis of this model that a judgement of
        //    this submission replaces: its proposal by a valid no-link item (stored or
        //    duplicate), its no-link by a valid proposal item or a stored no-link.
        const origins = await tx.submissions.originModels(project.id);
        const stale = (j: Parameters<typeof staleFor>[3]) =>
          staleFor(task.modelKey, task.factsHash, procedure, j);
        let withdrawn = 0;
        for (const relation of [...relations.values()]) {
          if (relation.type === 'manual' || !touches(relation, task.modelKey)) continue;
          const key = naturalKey(relation.type, relation.fromRef, relation.toRef);
          let current = relation;
          for (const stance of livePipelineProposals(ctx.histories.get(relation.id) ?? [])) {
            if (stance.submissionId === submissionId) continue;
            const superseded = stale({
              from: relation.fromRef,
              to: relation.toRef,
              fromHash: stance.fromHash,
              toHash: stance.toHash,
              procedure: stance.declared?.procedure ?? null,
            });
            const replaced =
              stance.principalId === actor.principalId &&
              stance.submissionId !== null &&
              origins.get(stance.submissionId) === task.modelKey &&
              judgedNoLinks.has(key);
            if (!superseded && !replaced) continue;
            current = await withdrawStance(
              ctx,
              current,
              stance,
              superseded
                ? `superseded by submission ${body.submissionId}`
                : `replaced by a no-link of submission ${body.submissionId}`,
              by,
            );
            withdrawn++;
          }
        }
        const touching = await tx.noLinks.listLive(
          project.id,
          { touchingModelKey: task.modelKey },
          procedure,
        );
        const supersededNoLinks: StoredNoLink[] = [];
        const replacedNoLinks: StoredNoLink[] = [];
        for (const n of touching) {
          const key = noLinkKey(n);
          if (
            stale({
              from: n.fromRef,
              to: n.toRef,
              fromHash: n.fromHash,
              toHash: n.toHash,
              procedure: n.declared.procedure,
            })
          ) {
            supersededNoLinks.push(n);
          } else if (
            n.principalId === actor.principalId &&
            n.origin === task.modelKey &&
            (seen.has(key) || freshKeys.has(key))
          ) {
            replacedNoLinks.push(n);
          }
        }

        // 4. The assigned pairs this submission left without a judgement.
        const covered = new Set([...seen, ...judgedNoLinks]);
        for (const n of touching) {
          if (n.current) covered.add(noLinkKey(n));
        }
        for (const r of relations.values()) {
          if (r.type === 'manual' || !touches(r, task.modelKey)) continue;
          for (const a of livePipelineProposals(ctx.histories.get(r.id) ?? [])) {
            const pair = { from: r.fromRef, to: r.toRef, fromHash: a.fromHash, toHash: a.toHash };
            if (isCurrent(pair, a.declared?.procedure ?? null, heads, procedure)) {
              covered.add(naturalKey(r.type, r.fromRef, r.toRef));
            }
          }
        }
        const unjudged = (task.assignment ?? []).filter((p) => !covered.has(pairKey(p)));

        const byId = new Map([...relations.values()].map((r) => [r.id, r]));
        for (const item of items) {
          if (item.relationId) item.status = byId.get(item.relationId)?.status ?? null;
        }
        const count = (r: string) => items.filter((i) => i.result === r).length;
        const noLinkCount = (r: string) => noLinkItems.filter((i) => i.result === r).length;
        const withdrawnNoLinks = supersededNoLinks.length + replacedNoLinks.length;
        const result: SubmissionResult = {
          taskId: task.id,
          submissionId: body.submissionId,
          replayed: false,
          items,
          counts: {
            applied: count('applied'),
            duplicate: count('duplicate'),
            suppressed: count('suppressed'),
            reopened: count('reopened'),
            invalid: items.filter((i) => i.result.startsWith('invalid:')).length,
          },
          withdrawn,
          noLinks: {
            items: noLinkItems,
            counts: {
              stored: noLinkCount('stored'),
              duplicate: noLinkCount('duplicate'),
              invalid: noLinkItems.filter((i) => i.result.startsWith('invalid:')).length,
            },
          },
          withdrawnNoLinks,
          uncovered: {
            count: unjudged.length,
            pairs: unjudged.slice(0, MAX_UNCOVERED_PAIRS),
          },
        };

        await tx.tasks.setState(project.id, task.id, 'done');
        const seq = await tx.events.append(project.id, {
          type: 'analysis.done',
          principalId: actor.principalId,
          clientId: actor.clientId,
          subjectRef: task.modelKey,
          payload: {
            taskId: task.id,
            kind: task.kind,
            modelId: task.modelId,
            modelKey: task.modelKey,
            submissionId: body.submissionId,
            storedSubmissionId: submissionId,
            procedure: body.procedure,
            llmModel: body.llmModel,
            late:
              task.state === 'failed' ||
              (task.leaseUntil !== null && task.leaseUntil < deps.clock.now()),
            counts: result.counts,
            withdrawn,
            noLinks: result.noLinks?.counts,
            withdrawnNoLinks,
            uncovered: unjudged.length,
          },
        });
        for (const [list, reason] of [
          [supersededNoLinks, `superseded by submission ${body.submissionId}`],
          [replacedNoLinks, `replaced by submission ${body.submissionId}`],
        ] as const) {
          if (list.length === 0) continue;
          await tx.noLinks.withdraw(
            project.id,
            list.map((n) => n.id),
            { seq, principalId: actor.principalId, reason },
          );
        }
        await tx.submissions.insert({
          id: submissionId,
          projectId: project.id,
          taskId: task.id,
          clientSubmissionId: body.submissionId,
          principalId: actor.principalId,
          clientId: actor.clientId,
          declared: { procedure: body.procedure, llmModel: body.llmModel },
          payload,
          result,
          seq,
        });
        await tx.noLinks.insertMany(fresh.map((n) => ({ ...n, seq })));
        // A relation's no-links are part of what a reviewer decides on: move its version.
        await touchRelations(
          tx,
          project.id,
          [...freshKeys, ...[...supersededNoLinks, ...replacedNoLinks].map(noLinkKey)],
          relations,
        );
        if (task.requeueAfter) await queueFollowUp(tx, actor, project.id, task);
        return result;
      });
    },

    /**
     * `release_analysis`: hands a claimed task back; it is queued again and
     * the attempt is given back.
     *
     * @throws {DomainError} `lease-lost`, `task-cancelled`, `not-found`, policy errors
     */
    async releaseAnalysis(
      actor: Actor,
      taskId: AnalysisTaskId,
      body: ReleaseAnalysisBody,
    ): Promise<ReleaseResult> {
      return deps.store.write(async (tx) => {
        const project = await taskProject(tx, actor, taskId, 'propose');
        await tx.projects.lockForWrite(project.id);
        const task = await tx.tasks.findInProject(project.id, taskId, { forUpdate: true });
        if (!task) throw new DomainError('not-found', 'analysis task not found');
        if (task.state === 'cancelled') {
          throw new DomainError('task-cancelled', task.lastError ?? 'the task was cancelled');
        }
        const holder =
          task.claimedBy === actor.principalId &&
          sameLeaseHash(
            task.leaseTokenHash,
            leaseTokenHash(task.id, actor.principalId, body.leaseToken),
          );
        if (!holder || task.state !== 'claimed') throw leaseLost();
        await tx.tasks.release(project.id, task.id, body.reason);
        await tx.events.append(project.id, {
          type: 'analysis.released',
          principalId: actor.principalId,
          clientId: actor.clientId,
          subjectRef: task.modelKey,
          payload: {
            taskId: task.id,
            kind: task.kind,
            modelId: task.modelId,
            modelKey: task.modelKey,
            reason: body.reason,
          },
        });
        return { taskId: task.id, state: 'queued' };
      });
    },

    /**
     * `GET /analyses/pending`: claimable tasks per project. With `wait`, a
     * long-poll: when nothing is claimable it waits (at most `wait` seconds)
     * for a task to be queued in one of the projects (Postgres LISTEN), then
     * counts again. Lease expiries are not announced; the bounded wait and
     * the recount cover them.
     */
    async pendingAnalyses(
      actor: Actor,
      query: PendingQuery,
      signal?: AbortSignal,
    ): Promise<PendingAnalyses> {
      const projects = await deps.store.read((tx) => eligibleProjects(tx, actor, query.projectId));
      if (projects.length === 0) return { total: 0, items: [] };
      await failExpiredIn(actor, projects);
      if (query.wait === 0) return claimable(projects);
      // Subscribe before counting, so a task queued in between still wakes us.
      const subscription = await deps.notifier.subscribe(
        projects.map((p) => p.id),
        actor.principalId,
      );
      try {
        const first = await claimable(projects);
        if (first.total > 0 || signal?.aborted) return first;
        await subscription.wait(query.wait * 1000, signal);
        return await claimable(projects);
      } finally {
        subscription.close();
      }
    },

    async listAnalyses(
      actor: Actor,
      projectRef: string,
      query: AnalysisQuery,
    ): Promise<AnalysisTaskPage> {
      const beforeSeq = query.cursor ? decodeCursor(query.cursor, ['number'])[0] : undefined;
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const rows = await tx.tasks.list(
          project.id,
          { state: query.state, modelKey: query.modelKey },
          { beforeSeq, limit: query.limit + 1 },
        );
        const page = toPage(rows, query.limit, (t) => [t.seq]);
        return { items: page.items.map(toAnalysisTask), nextCursor: page.nextCursor };
      });
    },

    /**
     * `POST …/analyses/requeue` (CONCEPT §3, e.g. after a procedure
     * upgrade): a new queued task per live model without an open one, even
     * if its facts were analysed already. A task whose lease expired is not
     * open: at the last attempt it fails first, otherwise it is cancelled;
     * either way a new task is queued.
     */
    async requeueAnalyses(
      actor: Actor,
      projectRef: string,
      body: RequeueBody,
    ): Promise<RequeueResult> {
      const now = deps.clock.now();
      return deps.store.write(async (tx) => {
        const { project } = await policy.require(tx, actor, 'write', projectRef);
        await tx.projects.lockForWrite(project.id);
        await failExpiredTasks(tx, actor, [project.id], now);
        const keys =
          body.modelKeys ?? (await tx.models.list(project.id, { limit: ALL })).map((m) => m.key);
        const items: RequeueResult['items'] = [];
        for (const key of [...new Set(keys)]) {
          const model = await tx.models.findByKey(project.id, key);
          const head =
            model && model.deletedSeq === null && model.headRevisionId
              ? await tx.revisions.findInProject(project.id, model.id, model.headRevisionId)
              : null;
          if (!model || !head) {
            items.push({ modelKey: key, outcome: 'not-found', taskId: null });
            continue;
          }
          const open = await tx.tasks.latest(project.id, model.id, ['queued', 'claimed']);
          if (open) {
            const lease = await tx.tasks.findInProject(project.id, open.id);
            const expired =
              open.state === 'claimed' && lease?.leaseUntil != null && lease.leaseUntil < now;
            if (!expired) {
              items.push({ modelKey: key, outcome: 'open', taskId: open.id });
              continue;
            }
            await cancelTask(tx, actor, project.id, model, open, 'lease expired; requeued');
          }
          const task = await queueTask(tx, actor, project.id, model, head, 'requeue');
          items.push({ modelKey: key, outcome: 'queued', taskId: task.id });
        }
        return { items };
      });
    },

    /** The stored submission of a task: verbatim payload and result. */
    async getAnalysisSubmission(
      actor: Actor,
      projectRef: string,
      taskId: AnalysisTaskId,
    ): Promise<AnalysisSubmission> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const task = await tx.tasks.findInProject(project.id, taskId);
        if (!task) throw new DomainError('not-found', 'analysis task not found');
        const s = await tx.submissions.findByTask(project.id, task.id);
        if (!s) throw new DomainError('not-found', 'the task has no submission');
        return {
          id: s.id,
          taskId: s.taskId,
          submissionId: s.clientSubmissionId,
          principalId: s.principalId,
          handle: s.handle,
          clientId: s.clientId,
          procedure: s.declared.procedure,
          llmModel: s.declared.llmModel,
          payload: s.payload,
          result: s.result,
          createdAt: s.createdAt.toISOString(),
        };
      });
    },
  };
}

/**
 * The follow-up of a task whose claim relied on a judgement that was
 * withdrawn meanwhile (`requeue_after`): a new queued task for the model's
 * head, whose claim judges the lost pairs.
 */
async function queueFollowUp(
  tx: Tx,
  actor: Actor,
  projectId: ProjectId,
  task: TaskDetail,
): Promise<void> {
  const model = await tx.models.findInProject(projectId, task.modelId);
  if (!model?.headRevisionId) return;
  const head = await tx.revisions.findInProject(projectId, model.id, model.headRevisionId);
  if (head) await queueTask(tx, actor, projectId, model, head, 'judgement withdrawn');
}

/** The model of a claimed task: its head, or (deleted meanwhile) the task's revision. */
async function claimModel(tx: Tx, task: TaskDetail): Promise<ClaimModel> {
  const view = await tx.models.view(task.projectId, task.modelId);
  if (view) {
    return {
      key: view.key,
      name: view.name,
      revisionId: view.headRevisionId,
      rev: view.headRev,
      engine: view.engine,
      processes: view.processes,
    };
  }
  const revision = await tx.revisions.findInProject(task.projectId, task.modelId, task.revisionId);
  const facts = await tx.revisions.facts(task.projectId, task.modelId, task.revisionId);
  return {
    key: task.modelKey,
    name: null,
    revisionId: task.revisionId,
    rev: revision?.rev ?? 1,
    engine: revision?.engine ?? null,
    processes: facts?.processes ?? [],
  };
}
