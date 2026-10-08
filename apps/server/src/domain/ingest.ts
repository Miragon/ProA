/**
 * Ingest (CONCEPT §3, §4): every adapter (PUT, import, seed) yields files
 * `{path, bytes, source}` for `ingest(project, files, actor)`. Facts are
 * extracted before the transaction (CPU only); everything else is ONE
 * transaction: store revisions and facts → run the rule tier over the head
 * facts → record relation assertions → recompute endpoint state → queue
 * analysis tasks → append events.
 */
import { createHash } from 'node:crypto';

import {
  newId,
  type ModelId,
  type PrincipalId,
  type ProjectId,
  type RevisionSource,
} from '@proa/contracts';

import type { Actor } from './actor.ts';
import { DomainError } from './errors.ts';
import { policy } from './policy.ts';
import type {
  AnalysisPort,
  ExtractOutcome,
  ModelRecord,
  ProjectRecord,
  RevisionRecord,
  Store,
  TaskRecord,
  Tx,
} from './ports.ts';
import { recomputeProject } from './recompute.ts';

export interface IngestFile {
  /** Model key, already validated. */
  key: string;
  bytes: Uint8Array;
  source: RevisionSource;
}

export type IngestResult =
  | {
      outcome: 'created' | 'revised' | 'unchanged';
      model: ModelRecord;
      revision: RevisionRecord;
    }
  | { outcome: 'failed'; error: DomainError };

export interface IngestDeps {
  store: Store;
  analysis: AnalysisPort;
  /** Id of the system principal `proa-rules` (created on first use). */
  rulesPrincipal(): Promise<PrincipalId>;
}

/** sha256 (hex) of the raw bytes: identical uploads are no-ops. */
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Problem for a rejected file: 413 for oversize input, 422 `bpmn-invalid` otherwise. */
export function extractError(code: string, message: string): DomainError {
  return code === 'too-large'
    ? new DomainError('payload-too-large', message)
    : new DomainError('bpmn-invalid', message, { reason: code });
}

/** Model name: the first process's participant (pool) name, else its name. */
function modelName(outcome: ExtractOutcome): string | null {
  if (!outcome.ok) return null;
  const first = outcome.value.processes[0];
  return first?.participantName ?? first?.name ?? null;
}

interface Prepared extends IngestFile {
  contentHash: string;
  extract(): Promise<ExtractOutcome>;
}

/**
 * Ingests `files` into the project. Files are processed in order; a file
 * whose bytes equal its model's head is `unchanged` (no revision, no event);
 * a file the extractor rejects is `failed` and does not affect the others.
 * The rule tier runs once for all changes.
 *
 * @throws {DomainError} from the policy (`write` on the project)
 */
export async function ingest(
  deps: IngestDeps,
  actor: Actor,
  projectRef: string,
  files: readonly IngestFile[],
): Promise<{ project: ProjectRecord; results: IngestResult[] }> {
  const prepared: Prepared[] = files.map((f) => {
    let memo: Promise<ExtractOutcome> | undefined;
    return {
      ...f,
      contentHash: contentHash(f.bytes),
      extract: () => (memo ??= deps.analysis.extract(f.bytes, f.key)),
    };
  });

  // Outside the transaction: authorize, then extract every file that differs
  // from its head (CPU-bound; keeps the write transaction short).
  const heads = await deps.store.read(async (tx) => {
    const { project } = await policy.require(tx, actor, 'write', projectRef);
    // Sequential: one transaction is one connection (no concurrent queries).
    const hashes: (string | null)[] = [];
    for (const f of prepared) hashes.push(await liveHeadHash(tx, project.id, f.key));
    return hashes;
  });
  for (const [i, f] of prepared.entries()) {
    if (heads[i] !== f.contentHash) await f.extract();
  }

  const rulesPrincipalId = await deps.rulesPrincipal();
  return deps.store.write(async (tx) => {
    const { project } = await policy.require(tx, actor, 'write', projectRef);
    await tx.projects.lockForWrite(project.id);

    const results: IngestResult[] = [];
    const changed: {
      model: ModelRecord;
      revision: RevisionRecord;
      previousFactsHash: string | null;
    }[] = [];
    for (const f of prepared) {
      const { result, previousFactsHash } = await storeFile(tx, deps, actor, project.id, f);
      results.push(result);
      if (result.outcome === 'created' || result.outcome === 'revised') {
        changed.push({ ...result, previousFactsHash });
      }
    }
    if (changed.length > 0) {
      await recomputeProject({
        tx,
        projectId: project.id,
        rulesPrincipalId,
        analysis: deps.analysis,
      });
      for (const c of changed) {
        await queueAnalysis(tx, actor, project.id, c.model, c.revision, c.previousFactsHash);
      }
    }
    return { project, results };
  });
}

async function liveHeadHash(tx: Tx, projectId: ProjectId, key: string): Promise<string | null> {
  const model = await tx.models.findByKey(projectId, key);
  if (!model?.headRevisionId || model.deletedSeq !== null) return null;
  const head = await tx.revisions.findInProject(projectId, model.id, model.headRevisionId);
  return head?.contentHash ?? null;
}

/**
 * Stores one file as the model's new head unless its bytes equal the head.
 *
 * @returns the outcome and the `facts_hash` of the previous live head (`null`
 *   for a new or revived model)
 */
async function storeFile(
  tx: Tx,
  deps: IngestDeps,
  actor: Actor,
  projectId: ProjectId,
  f: Prepared,
): Promise<{ result: IngestResult; previousFactsHash: string | null }> {
  const existing = await tx.models.findByKey(projectId, f.key);
  const live = existing !== null && existing.deletedSeq === null;
  const previous =
    live && existing.headRevisionId
      ? await tx.revisions.findInProject(projectId, existing.id, existing.headRevisionId)
      : null;
  const previousFactsHash = previous?.factsHash ?? null;
  if (live && previous && previous.contentHash === f.contentHash) {
    return {
      result: { outcome: 'unchanged', model: existing, revision: previous },
      previousFactsHash,
    };
  }

  const extracted = await f.extract();
  if (!extracted.ok) {
    return {
      result: {
        outcome: 'failed',
        error: extractError(extracted.error.code, extracted.error.message),
      },
      previousFactsHash,
    };
  }
  const { facts, processes, messageFlows, factsVersion, engine } = extracted.value;
  const outcome = live ? 'revised' : 'created';
  const name = modelName(extracted);

  const modelId: ModelId = existing?.id ?? newId('model');
  if (!existing) await tx.models.insert({ id: modelId, projectId, key: f.key, name });
  const rev = existing ? (await tx.revisions.maxRev(projectId, modelId)) + 1 : 1;
  const revisionId = newId('revision');
  const factsHash = deps.analysis.factsHash(facts);

  const seq = await tx.events.append(projectId, {
    type: 'model.revised',
    principalId: actor.principalId,
    clientId: actor.clientId,
    subjectRef: f.key,
    payload: {
      outcome,
      modelId,
      modelKey: f.key,
      revisionId,
      rev,
      contentHash: f.contentHash,
      factsHash,
      source: f.source,
    },
  });
  await tx.revisions.insert({
    id: revisionId,
    projectId,
    modelId,
    rev,
    xml: f.bytes,
    contentHash: f.contentHash,
    factsHash,
    factsVersion,
    engine,
    processes,
    messageFlows,
    source: f.source,
    principalId: actor.principalId,
    seq,
  });
  await tx.facts.insertMany(projectId, revisionId, facts);
  await tx.models.update(projectId, modelId, {
    name,
    headRevisionId: revisionId,
    deletedSeq: null,
  });

  const model = await tx.models.findByKey(projectId, f.key);
  const revision = await tx.revisions.findInProject(projectId, modelId, revisionId);
  if (!model || !revision) throw new Error(`ingest: ${f.key} vanished inside its transaction`);
  return { result: { outcome, model, revision }, previousFactsHash };
}

/**
 * Queues a `relations` task for a new head (CONCEPT §3, judge each pair
 * once): always for a new or revived model (`previousFactsHash` null), and
 * when the head's `facts_hash` differs from the previous head's, so a
 * revert is judged again although an earlier task analysed the same facts;
 * judge-once keeps that cheap. A layout-only change queues nothing, unless
 * no task is open and none analysed these facts (a failed task). An open
 * task for different facts is cancelled first; one for the same facts
 * stays.
 */
export async function queueAnalysis(
  tx: Tx,
  actor: Actor,
  projectId: ProjectId,
  model: ModelRecord,
  revision: RevisionRecord,
  previousFactsHash: string | null,
): Promise<TaskRecord | null> {
  const open = await tx.tasks.latest(projectId, model.id, ['queued', 'claimed']);
  if (open?.factsHash === revision.factsHash) return null;
  if (open) await cancelTask(tx, actor, projectId, model, open, 'new head with different facts');
  if (!open && previousFactsHash === revision.factsHash) {
    const done = await tx.tasks.latest(projectId, model.id, ['done']);
    if (done?.factsHash === revision.factsHash) return null;
  }
  return queueTask(tx, actor, projectId, model, revision, 'new head');
}

/**
 * After pipeline judgements were withdrawn outside an analysis (a revoked
 * token, `withdraw_proposal`), the live models among `modelKeys` judge
 * their pairs again: a model without an open task gets a queued one, a
 * claimed task gets `requeue_after` (its submit queues a follow-up, since
 * its claim may have skipped the lost pairs); a queued task's claim sees the
 * loss anyway.
 */
export async function requeueAfterLoss(
  tx: Tx,
  actor: Actor,
  projectId: ProjectId,
  modelKeys: Iterable<string>,
): Promise<void> {
  for (const key of [...new Set(modelKeys)].sort()) {
    const model = await tx.models.findByKey(projectId, key);
    if (!model?.headRevisionId || model.deletedSeq !== null) continue;
    const open = await tx.tasks.latest(projectId, model.id, ['queued', 'claimed']);
    if (open?.state === 'claimed') await tx.tasks.setRequeueAfter(projectId, open.id);
    if (open) continue;
    const head = await tx.revisions.findInProject(projectId, model.id, model.headRevisionId);
    if (head) await queueTask(tx, actor, projectId, model, head, 'judgement withdrawn');
  }
}

/** Inserts a queued `relations` task for `revision` and records `analysis.queued`. */
export async function queueTask(
  tx: Tx,
  actor: Actor,
  projectId: ProjectId,
  model: Pick<ModelRecord, 'id' | 'key'>,
  revision: Pick<RevisionRecord, 'id' | 'factsHash'>,
  reason: 'new head' | 'requeue' | 'judgement withdrawn',
): Promise<TaskRecord> {
  const id = newId('analysisTask');
  const seq = await tx.events.append(projectId, {
    type: 'analysis.queued',
    principalId: actor.principalId,
    clientId: actor.clientId,
    subjectRef: model.key,
    payload: {
      taskId: id,
      kind: 'relations',
      modelId: model.id,
      modelKey: model.key,
      revisionId: revision.id,
      factsHash: revision.factsHash,
      reason,
    },
  });
  const task: TaskRecord = {
    id,
    projectId,
    modelId: model.id,
    revisionId: revision.id,
    kind: 'relations',
    factsHash: revision.factsHash,
    state: 'queued',
    seq,
  };
  await tx.tasks.insert(task);
  return task;
}

/** Cancels an open task and records `analysis.cancelled`. */
export async function cancelTask(
  tx: Tx,
  actor: Actor,
  projectId: ProjectId,
  model: ModelRecord,
  task: TaskRecord,
  reason: string,
): Promise<void> {
  await tx.tasks.setState(projectId, task.id, 'cancelled', reason);
  await tx.events.append(projectId, {
    type: 'analysis.cancelled',
    principalId: actor.principalId,
    clientId: actor.clientId,
    subjectRef: model.key,
    payload: { taskId: task.id, kind: task.kind, modelId: model.id, modelKey: model.key, reason },
  });
}

/**
 * Deletes a model (CONCEPT §3): marks it deleted, cancels its open task,
 * and recomputes rules and endpoint states, so partner relations turn
 * `missing`. Revisions and facts stay (append-only history); uploading the
 * key again revives the model with a new revision.
 *
 * @throws {DomainError} `not-found` for unknown, deleted or foreign models
 */
export async function deleteModel(
  deps: IngestDeps,
  actor: Actor,
  projectRef: string,
  modelId: ModelId,
): Promise<void> {
  const rulesPrincipalId = await deps.rulesPrincipal();
  await deps.store.write(async (tx) => {
    const { project } = await policy.require(tx, actor, 'write', projectRef);
    await tx.projects.lockForWrite(project.id);
    const model = await tx.models.findInProject(project.id, modelId);
    if (!model) throw new DomainError('not-found', 'model not found');

    const seq = await tx.events.append(project.id, {
      type: 'model.deleted',
      principalId: actor.principalId,
      clientId: actor.clientId,
      subjectRef: model.key,
      payload: { modelId: model.id, modelKey: model.key },
    });
    await tx.models.update(project.id, model.id, { deletedSeq: seq });
    const open = await tx.tasks.latest(project.id, model.id, ['queued', 'claimed']);
    if (open) await cancelTask(tx, actor, project.id, model, open, 'model deleted');
    await recomputeProject({
      tx,
      projectId: project.id,
      rulesPrincipalId,
      analysis: deps.analysis,
    });
  });
}
