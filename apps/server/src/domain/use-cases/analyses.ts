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
  newId,
  type AnalysisQuery,
  type AnalysisSubmission,
  type AnalysisTaskId,
  type AnalysisTaskPage,
  type ClaimAnalysisBody,
  type ClaimResult,
  type PendingAnalyses,
  type PendingQuery,
  type ProjectId,
  type ReleaseAnalysisBody,
  type ReleaseResult,
  type RequeueBody,
  type RequeueResult,
  type SubmissionItemResult,
  type SubmissionResult,
  type SubmitAnalysisBody,
} from '@proa/contracts';

import type { Actor } from '../actor.ts';
import { renderClaimInput, type ClaimModel } from '../claim-input.ts';
import { decodeCursor, toPage } from '../cursor.ts';
import { DomainError } from '../errors.ts';
import { visibleFindings } from '../findings.ts';
import { headFingerprints } from '../fingerprints.ts';
import { cancelTask, queueTask } from '../ingest.ts';
import { leaseTokenHash, newLeaseToken, sameLeaseHash } from '../lease.ts';
import { jsonBytes, storablePayload } from '../payload.ts';
import { effectiveScopes, evaluate, policy } from '../policy.ts';
import type {
  AssertionRecord,
  ProjectRecord,
  RelationRecord,
  StoredAssertion,
  TaskDetail,
  Tx,
} from '../ports.ts';
import {
  applyProposal,
  livePipelineProposals,
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
     * `claim_analysis` (CONCEPT §3): one short transaction locks the
     * projects, fails tasks whose lease expired at the last attempt, claims
     * up to `max` tasks with `FOR UPDATE SKIP LOCKED` and sets a hashed lease
     * token per task. The inputs are rendered afterwards from one snapshot.
     *
     * @throws {DomainError} `insufficient-scope`, `forbidden`, `not-found`
     */
    async claimAnalyses(actor: Actor, body: ClaimAnalysisBody): Promise<ClaimResult> {
      const now = deps.clock.now();
      const leaseUntil = new Date(now.getTime() + LEASE_MINUTES * MINUTE);
      const claimed = await deps.store.write(async (tx) => {
        const projects = await eligibleProjects(tx, actor, body.projectId);
        if (projects.length === 0) return [];
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
        const out: { task: TaskDetail; token: string; project: ProjectRecord }[] = [];
        for (const task of tasks) {
          const token = newLeaseToken();
          await tx.tasks.setLeaseHash(
            task.projectId,
            task.id,
            leaseTokenHash(task.id, actor.principalId, token),
          );
          await tx.events.append(task.projectId, {
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
          const project = projects.find((p) => p.id === task.projectId);
          if (!project)
            throw new Error(`claimed a task of an unexpected project ${task.projectId}`);
          out.push({ task, token, project });
        }
        return out;
      });
      if (claimed.length === 0) return { items: [] };

      const procedure = deps.expectedProcedure();
      let items: ClaimResult['items'];
      try {
        items = await deps.store.read(async (tx) => {
          const result: ClaimResult['items'] = [];
          const byProject = new Map<ProjectId, typeof claimed>();
          for (const c of claimed)
            byProject.set(c.project.id, [...(byProject.get(c.project.id) ?? []), c]);
          for (const [projectId, group] of byProject) {
            const projectFacts = await tx.facts.headProjectFacts(projectId);
            const relations = (await tx.relations.all(projectId)).filter(
              (r) => r.status !== 'obsolete',
            );
            const histories = byRelation<StoredAssertion>(
              await tx.assertions.listForProject(projectId),
            );
            // As `GET …/findings` lists them; the input keeps those touching the model.
            const findings = visibleFindings(await tx.findings.list(projectId), relations);
            for (const { task, token, project } of group) {
              const model = await claimModel(tx, task);
              const input = renderClaimInput({
                model,
                projectFacts,
                candidates: deps.analysis.candidates(projectFacts, task.modelKey),
                relations: relations.filter((r) => touches(r, task.modelKey)),
                histories,
                findings,
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
          return result;
        });
      } catch (err) {
        // The caller never saw the lease tokens: hand the tasks back at once.
        await deps.store.write(async (tx) => {
          for (const { task } of claimed) {
            await tx.projects.lockForWrite(task.projectId);
            const current = await tx.tasks.findInProject(task.projectId, task.id, {
              forUpdate: true,
            });
            // Only while it is still this claim (not cancelled or claimed again meanwhile).
            if (current?.state !== 'claimed' || current.claimedBy !== actor.principalId) continue;
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
        });
        throw err;
      }
      return {
        items: claimed
          .map((c) => items.find((i) => i.taskId === c.task.id))
          .filter((i) => i !== undefined),
      };
    },

    /**
     * `submit_analysis` (CONCEPT §3): validates every item, records the
     * proposals, withdraws earlier pipeline proposals touching the model
     * that the submission does not repeat, marks the task done and stores
     * the submission with its result, in one transaction.
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

        const submissionId = newId('submission');
        const projectFacts = await tx.facts.headProjectFacts(project.id);
        const assess = deps.analysis.pairAssessor(projectFacts);
        const relations = new Map<string, RelationRecord>();
        for (const r of await tx.relations.all(project.id)) {
          relations.set(naturalKey(r.type, r.fromRef, r.toRef), r);
        }
        const ctx: ProposalContext = {
          tx,
          projectId: project.id,
          actor,
          fps: headFingerprints(projectFacts),
          relations,
          histories: byRelation<AssertionRecord>(await tx.assertions.listForProject(project.id)),
          declared: { procedure: body.procedure, llmModel: body.llmModel },
          submissionId,
        };

        const items: SubmissionItemResult[] = [];
        const seen = new Set<string>();
        const repeated = new Set<string>();
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
          repeated.add(relation.id);
          items.push({ index, result: effect, relationId: relation.id, status: null });
        }

        // Supersession: earlier pipeline proposals touching the model that this one does not repeat.
        let withdrawn = 0;
        for (const relation of [...relations.values()]) {
          if (repeated.has(relation.id) || !touches(relation, task.modelKey)) continue;
          let current = relation;
          for (const stance of livePipelineProposals(ctx.histories.get(relation.id) ?? [])) {
            current = await withdrawStance(
              ctx,
              current,
              stance,
              `superseded by submission ${body.submissionId}`,
              { principalId: actor.principalId, clientId: actor.clientId },
            );
            withdrawn++;
          }
        }

        const byId = new Map([...relations.values()].map((r) => [r.id, r]));
        for (const item of items) {
          if (item.relationId) item.status = byId.get(item.relationId)?.status ?? null;
        }
        const count = (r: string) => items.filter((i) => i.result === r).length;
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
          },
        });
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
