/**
 * Drizzle implementation of the domain's {@link Store} port. Every query that
 * reads project data filters by `project_id` (repositories only "find in
 * project"); composite foreign keys in the schema back that up.
 */
import {
  formatRef,
  isTypedId,
  newId,
  type AgentTokenId,
  type AnalysisTaskId,
  type AssertionId,
  type Fact,
  type Finding,
  type ModelFacts,
  type ModelId,
  type ModelStage,
  type NoLinkId,
  type PlacementAssertionId,
  type PlacementId,
  type PrincipalId,
  type ProjectId,
  type Ref,
  type RelationId,
  type RevisionId,
  type SubmissionId,
  type ValueChainId,
  type ValueChainRevisionId,
} from '@proa/contracts';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type {
  AgentTokenRecord,
  ChainTaskRecord,
  EventRecord,
  HeadFact,
  HeadFactFilter,
  ModelRecord,
  ModelTaskRecord,
  ModelView,
  PlacementInputRecord,
  PlacementRecord,
  PrincipalRecord,
  ProjectRecord,
  RelationRecord,
  RevisionRecord,
  StoredAssertion,
  StoredNoLink,
  StoredPlacementAssertion,
  StoredPlacementInput,
  StoredSubmission,
  Store,
  TaskDetail,
  TaskRecord,
  Tx,
  ValueChainPipelineRecord,
  ValueChainRecord,
  ValueChainRevisionRecord,
  ValueChainStepRecord,
} from '../domain/ports.ts';
import type { Db } from './client.ts';
import * as s from './schema.ts';

type Conn = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Rows per INSERT statement (PostgreSQL allows 65,535 bind parameters). */
const INSERT_CHUNK = 1000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ mappers

type ProjectRow = typeof s.project.$inferSelect;
type ModelRow = typeof s.model.$inferSelect;
type TokenRow = typeof s.agentToken.$inferSelect;
type RelationRow = typeof s.relation.$inferSelect;
type FactRow = typeof s.fact.$inferSelect;
type AssertionRow = typeof s.relationAssertion.$inferSelect;
type TaskRow = typeof s.analysisTask.$inferSelect;

const toProject = (r: ProjectRow): ProjectRecord => ({
  id: r.id as ProjectId,
  key: r.key,
  name: r.name,
  lastSeq: r.lastSeq,
  createdAt: r.createdAt,
});

const toModel = (r: ModelRow): ModelRecord => ({
  id: r.id as ModelId,
  projectId: r.projectId as ProjectId,
  key: r.key,
  name: r.name,
  headRevisionId: r.headRevisionId as RevisionId | null,
  deletedSeq: r.deletedSeq,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toToken = (r: TokenRow): AgentTokenRecord => ({
  id: r.id as AgentTokenId,
  projectId: r.projectId as ProjectId,
  principalId: r.principalId as PrincipalId,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  expiresAt: r.expiresAt,
  revokedAt: r.revokedAt,
  lastUsedAt: r.lastUsedAt,
  createdBy: r.createdBy as PrincipalId,
  createdAt: r.createdAt,
});

const toRelation = (r: RelationRow): RelationRecord => ({
  id: r.id as RelationId,
  projectId: r.projectId as ProjectId,
  type: r.type,
  fromRef: r.fromRef as Ref,
  toRef: r.toRef as Ref,
  status: r.status,
  endpointState: r.endpointState,
  tier: r.tier,
  confidence: r.confidence,
  version: r.version,
  attrs: r.attrs,
  fromFp: r.fromFp,
  toFp: r.toFp,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toAssertion = (r: AssertionRow, handle: string): StoredAssertion => ({
  id: r.id as AssertionId,
  projectId: r.projectId as ProjectId,
  relationId: r.relationId as RelationId,
  seq: r.seq,
  kind: r.kind,
  verdict: r.verdict,
  sourceKind: r.sourceKind,
  principalId: r.principalId as PrincipalId,
  clientId: r.clientId,
  declared: r.declared ?? null,
  submissionId: r.submissionId as SubmissionId | null,
  tier: r.tier,
  confidence: r.confidence,
  rationale: r.rationale,
  evidence: r.evidence ?? null,
  question: r.question,
  label: r.label,
  linkedRelationId: r.linkedRelationId as RelationId | null,
  fromFp: r.fromFp,
  toFp: r.toFp,
  fromHash: r.fromHash,
  toHash: r.toHash,
  handle,
  createdAt: r.createdAt,
});

/** A `relations` task row (the subject check guarantees its model columns). */
function toModelTaskRecord(r: TaskRow): ModelTaskRecord {
  if (
    r.subjectKind !== 'model' ||
    r.modelId === null ||
    r.revisionId === null ||
    r.factsHash === null
  ) {
    throw new Error(`analysis task ${r.id} is not a model task`);
  }
  return {
    id: r.id as AnalysisTaskId,
    projectId: r.projectId as ProjectId,
    subjectKind: 'model',
    kind: 'relations',
    modelId: r.modelId as ModelId,
    revisionId: r.revisionId as RevisionId,
    factsHash: r.factsHash,
    state: r.state,
    seq: r.seq,
  };
}

/** A `placement` task row (the subject check guarantees its chain columns). */
function toChainTaskRecord(r: TaskRow): ChainTaskRecord {
  if (
    r.subjectKind !== 'value_chain' ||
    r.valueChainId === null ||
    r.valueChainRevisionId === null ||
    r.inputHash === null
  ) {
    throw new Error(`analysis task ${r.id} is not a value chain task`);
  }
  return {
    id: r.id as AnalysisTaskId,
    projectId: r.projectId as ProjectId,
    subjectKind: 'value_chain',
    kind: 'placement',
    valueChainId: r.valueChainId as ValueChainId,
    valueChainRevisionId: r.valueChainRevisionId as ValueChainRevisionId,
    inputHash: r.inputHash,
    state: r.state,
    seq: r.seq,
  };
}

type PlacementInputRow = typeof s.placementInput.$inferSelect;

const toPlacementInput = (r: PlacementInputRow): PlacementInputRecord => ({
  projectId: r.projectId as ProjectId,
  valueChainId: r.valueChainId as ValueChainId,
  processRef: r.processRef,
  inputHash: r.inputHash,
  taskId: r.taskId as AnalysisTaskId | null,
  principalId: r.principalId as PrincipalId,
  outcome: r.outcome,
  reason: r.reason,
  seq: r.seq,
});

/** The columns a task row is inserted with, from either subject. */
function taskRow(t: TaskRecord): typeof s.analysisTask.$inferInsert {
  const base = { id: t.id, projectId: t.projectId, state: t.state, seq: t.seq };
  return t.subjectKind === 'model'
    ? {
        ...base,
        subjectKind: 'model',
        kind: 'relations',
        modelId: t.modelId,
        revisionId: t.revisionId,
        factsHash: t.factsHash,
      }
    : {
        ...base,
        subjectKind: 'value_chain',
        kind: 'placement',
        valueChainId: t.valueChainId,
        valueChainRevisionId: t.valueChainRevisionId,
        inputHash: t.inputHash,
      };
}

const toFact = (r: FactRow, modelKey: string): Fact => ({
  modelKey,
  ref: formatRef(modelKey, r.elementId),
  kind: r.kind,
  elementId: r.elementId,
  processId: r.processId,
  scope: r.scope,
  eventDef: r.eventDef,
  label: r.label,
  keyRaw: r.keyRaw,
  keyNorm: r.keyNorm,
  fingerprint: r.fingerprint,
  attrs: r.attrs,
});

const compareFacts = (a: Fact, b: Fact): number =>
  byCodePoint(a.kind, b.kind) || byCodePoint(a.elementId, b.elementId);

const revisionColumns = {
  id: s.modelRevision.id,
  projectId: s.modelRevision.projectId,
  modelId: s.modelRevision.modelId,
  rev: s.modelRevision.rev,
  contentHash: s.modelRevision.contentHash,
  factsHash: s.modelRevision.factsHash,
  factsVersion: s.modelRevision.factsVersion,
  engine: s.modelRevision.engine,
  source: s.modelRevision.source,
  principalId: s.modelRevision.principalId,
  seq: s.modelRevision.seq,
  createdAt: s.modelRevision.createdAt,
};

type RevisionRow = Pick<typeof s.modelRevision.$inferSelect, keyof typeof revisionColumns>;

const toRevision = (r: RevisionRow): RevisionRecord => ({
  ...r,
  id: r.id as RevisionId,
  projectId: r.projectId as ProjectId,
  modelId: r.modelId as ModelId,
  principalId: r.principalId as PrincipalId,
});

type ValueChainRow = typeof s.valueChain.$inferSelect;
type ValueChainStepRow = typeof s.valueChainStep.$inferSelect;
type PlacementRow = typeof s.placement.$inferSelect;
type PlacementAssertionRow = typeof s.placementAssertion.$inferSelect;

const toValueChain = (r: ValueChainRow): ValueChainRecord => ({
  id: r.id as ValueChainId,
  projectId: r.projectId as ProjectId,
  key: r.key,
  name: r.name,
  headRevisionId: r.headRevisionId as ValueChainRevisionId | null,
  deletedSeq: r.deletedSeq,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const chainRevisionColumns = {
  id: s.valueChainRevision.id,
  projectId: s.valueChainRevision.projectId,
  valueChainId: s.valueChainRevision.valueChainId,
  rev: s.valueChainRevision.rev,
  contentHash: s.valueChainRevision.contentHash,
  structureHash: s.valueChainRevision.structureHash,
  schemaVersion: s.valueChainRevision.schemaVersion,
  baseRevisionId: s.valueChainRevision.baseRevisionId,
  principalId: s.valueChainRevision.principalId,
  sourceKind: s.valueChainRevision.sourceKind,
  seq: s.valueChainRevision.seq,
  createdAt: s.valueChainRevision.createdAt,
};

type ChainRevisionRow = Pick<
  typeof s.valueChainRevision.$inferSelect,
  keyof typeof chainRevisionColumns
>;

function toChainRevision(r: ChainRevisionRow): ValueChainRevisionRecord {
  if (r.sourceKind !== 'human') throw new Error(`revision ${r.id} not saved by a human`);
  return {
    ...r,
    id: r.id as ValueChainRevisionId,
    projectId: r.projectId as ProjectId,
    valueChainId: r.valueChainId as ValueChainId,
    baseRevisionId: r.baseRevisionId as ValueChainRevisionId | null,
    principalId: r.principalId as PrincipalId,
    sourceKind: 'human',
  };
}

const toStep = (r: ValueChainStepRow): ValueChainStepRecord => ({
  projectId: r.projectId as ProjectId,
  valueChainId: r.valueChainId as ValueChainId,
  elementId: r.elementId,
  generation: r.generation,
  createdRev: r.createdRev,
  deletedRev: r.deletedRev,
  deletedSeq: r.deletedSeq,
});

const toPlacement = (r: PlacementRow): PlacementRecord => ({
  id: r.id as PlacementId,
  projectId: r.projectId as ProjectId,
  valueChainId: r.valueChainId as ValueChainId,
  elementId: r.elementId,
  generation: r.generation,
  processRef: r.processRef as Ref,
  status: r.status,
  endpointState: r.endpointState,
  tier: r.tier,
  confidence: r.confidence,
  version: r.version,
  stepFp: r.stepFp,
  processFp: r.processFp,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toPlacementAssertion = (
  r: PlacementAssertionRow,
  handle: string,
): StoredPlacementAssertion => ({
  id: r.id as PlacementAssertionId,
  projectId: r.projectId as ProjectId,
  placementId: r.placementId as PlacementId,
  seq: r.seq,
  kind: r.kind,
  verdict: r.verdict,
  sourceKind: r.sourceKind,
  principalId: r.principalId as PrincipalId,
  clientId: r.clientId,
  declared: r.declared ?? null,
  submissionId: r.submissionId as SubmissionId | null,
  tier: r.tier,
  confidence: r.confidence,
  rationale: r.rationale,
  evidence: r.evidence ?? null,
  question: r.question,
  label: r.label,
  linkedPlacementId: r.linkedPlacementId as PlacementId | null,
  stepFp: r.stepFp,
  processFp: r.processFp,
  stepHash: r.stepHash,
  processHash: r.processHash,
  handle,
  createdAt: r.createdAt,
});

// ------------------------------------------------------------- repositories

function repos(db: Conn): Tx {
  const liveHead = and(
    eq(s.model.projectId, s.modelRevision.projectId),
    eq(s.model.headRevisionId, s.modelRevision.id),
  );

  function modelViews(projectId: ProjectId, ...where: (SQL | undefined)[]) {
    return db
      .select({
        model: s.model,
        rev: s.modelRevision.rev,
        engine: s.modelRevision.engine,
        processes: s.modelRevision.processes,
        stage: s.modelPipeline.stage,
        openItems: s.modelPipeline.openItems,
      })
      .from(s.model)
      .innerJoin(s.modelRevision, liveHead)
      .innerJoin(s.modelPipeline, eq(s.modelPipeline.modelId, s.model.id))
      .where(and(eq(s.model.projectId, projectId), isNull(s.model.deletedSeq), ...where));
  }

  const toView = (r: {
    model: ModelRow;
    rev: number;
    engine: ModelView['engine'];
    processes: ModelView['processes'];
    stage: string;
    openItems: number;
  }): ModelView => ({
    ...toModel(r.model),
    headRevisionId: r.model.headRevisionId as RevisionId,
    headRev: r.rev,
    engine: r.engine,
    stage: r.stage as ModelStage,
    openItems: r.openItems,
    processes: r.processes,
  });

  const processFact = alias(s.fact, 'process_fact');

  async function headFacts(projectId: ProjectId, filter: HeadFactFilter = {}): Promise<HeadFact[]> {
    const rows = await db
      .select({ fact: s.fact, modelKey: s.model.key, processName: processFact.label })
      .from(s.fact)
      .innerJoin(
        s.model,
        and(
          eq(s.model.projectId, s.fact.projectId),
          eq(s.model.headRevisionId, s.fact.revisionId),
          isNull(s.model.deletedSeq),
        ),
      )
      .leftJoin(
        processFact,
        and(
          eq(processFact.revisionId, s.fact.revisionId),
          eq(processFact.kind, 'process'),
          eq(processFact.elementId, s.fact.processId),
        ),
      )
      .where(
        and(
          eq(s.fact.projectId, projectId),
          filter.kinds ? inArray(s.fact.kind, [...filter.kinds]) : undefined,
          filter.keyNorm === undefined ? undefined : eq(s.fact.keyNorm, filter.keyNorm),
          filter.nameKey === undefined
            ? undefined
            : sql`replace(${s.fact.keyNorm}, ' ', '') = ${filter.nameKey}`,
          filter.keyRaw === undefined ? undefined : eq(s.fact.keyRaw, filter.keyRaw),
          filter.modelKey === undefined ? undefined : eq(s.model.key, filter.modelKey),
          filter.processId === undefined ? undefined : eq(s.fact.processId, filter.processId),
        ),
      );
    return rows
      .map((r) => ({ ...toFact(r.fact, r.modelKey), processName: r.processName || null }))
      .sort((a, b) => byCodePoint(a.modelKey, b.modelKey) || compareFacts(a, b));
  }

  const claimer = alias(s.principal, 'claimer');

  /** Tasks with model or chain key, lease holder handle and client submission id. */
  async function taskDetails(
    where: SQL | undefined,
    options: { order?: 'seq-desc' | 'created'; limit?: number } = {},
  ): Promise<TaskDetail[]> {
    const t = s.analysisTask;
    let query = db
      .select({
        task: t,
        modelKey: s.model.key,
        valueChainKey: s.valueChain.key,
        handle: claimer.handle,
        submissionId: s.analysisSubmission.clientSubmissionId,
      })
      .from(t)
      .leftJoin(s.model, and(eq(s.model.projectId, t.projectId), eq(s.model.id, t.modelId)))
      .leftJoin(
        s.valueChain,
        and(eq(s.valueChain.projectId, t.projectId), eq(s.valueChain.id, t.valueChainId)),
      )
      .leftJoin(claimer, eq(claimer.id, t.claimedBy))
      .leftJoin(
        s.analysisSubmission,
        and(eq(s.analysisSubmission.projectId, t.projectId), eq(s.analysisSubmission.taskId, t.id)),
      )
      .where(where)
      .orderBy(...(options.order === 'seq-desc' ? [desc(t.seq)] : [asc(t.createdAt), asc(t.seq)]))
      .$dynamic();
    if (options.limit !== undefined) query = query.limit(options.limit);
    const rows = await query;
    return rows.map((r): TaskDetail => {
      const lease = {
        attempts: r.task.attempts,
        leaseTokenHash: r.task.leaseTokenHash,
        claimedBy: r.task.claimedBy as PrincipalId | null,
        claimedByHandle: r.handle,
        leaseUntil: r.task.leaseUntil,
        lastError: r.task.lastError,
        submissionId: r.submissionId,
        claimedSeq: r.task.claimedSeq,
        requeueAfter: r.task.requeueAfter,
        createdAt: r.task.createdAt,
        updatedAt: r.task.updatedAt,
      };
      if (r.task.subjectKind === 'model') {
        if (r.modelKey === null) throw new Error(`model of task ${r.task.id} not found`);
        return {
          ...toModelTaskRecord(r.task),
          ...lease,
          modelKey: r.modelKey,
          assignment: r.task.assignment,
        };
      }
      if (r.valueChainKey === null) throw new Error(`value chain of task ${r.task.id} not found`);
      return {
        ...toChainTaskRecord(r.task),
        ...lease,
        valueChainKey: r.valueChainKey,
        placementClaim: r.task.placementClaim,
      };
    });
  }

  /** `placement_input` rows with the agent's handle, by process ref (code points). */
  async function placementInputRows(where: SQL | undefined): Promise<StoredPlacementInput[]> {
    const rows = await db
      .select({ row: s.placementInput, handle: s.principal.handle })
      .from(s.placementInput)
      .innerJoin(s.principal, eq(s.principal.id, s.placementInput.principalId))
      .where(where);
    return rows
      .map((r) => ({
        ...toPlacementInput(r.row),
        handle: r.handle,
        createdAt: r.row.createdAt,
        updatedAt: r.row.updatedAt,
      }))
      .sort((a, b) => byCodePoint(a.processRef, b.processRef));
  }

  const noLinkFrom = alias(s.model, 'no_link_from_model');
  const noLinkFromHead = alias(s.modelRevision, 'no_link_from_head');
  const noLinkTo = alias(s.model, 'no_link_to_model');
  const noLinkToHead = alias(s.modelRevision, 'no_link_to_head');
  const noLinkOrigin = alias(s.model, 'no_link_origin');

  return {
    projects: {
      async insert(p) {
        const rows = await db
          .insert(s.project)
          .values(p)
          .onConflictDoNothing({ target: s.project.key })
          .returning();
        return rows[0] ? toProject(rows[0]) : null;
      },
      async findByRef(idOrKey) {
        const column = isTypedId('prj', idOrKey) ? s.project.id : s.project.key;
        const rows = await db.select().from(s.project).where(eq(column, idOrKey));
        return rows[0] ? toProject(rows[0]) : null;
      },
      async listForPrincipal(principalId, page) {
        const rows = await db
          .select({ project: s.project, role: s.membership.role })
          .from(s.project)
          .innerJoin(s.membership, eq(s.membership.projectId, s.project.id))
          .where(
            and(
              eq(s.membership.principalId, principalId),
              page.afterKey === undefined ? undefined : gt(s.project.key, page.afterKey),
            ),
          )
          .orderBy(asc(s.project.key))
          .limit(page.limit);
        return rows.map((r) => ({ ...toProject(r.project), role: r.role }));
      },
      async lockForWrite(projectId) {
        const rows = await db
          .select()
          .from(s.project)
          .where(eq(s.project.id, projectId))
          .for('update');
        if (!rows[0]) throw new Error(`project ${projectId} not found`);
        return toProject(rows[0]);
      },
    },

    principals: {
      async ensure(identity) {
        const match = and(
          eq(s.principal.iss, identity.iss),
          eq(s.principal.kind, identity.kind),
          eq(s.principal.subject, identity.subject),
        );
        const existing = await db.select().from(s.principal).where(match);
        if (!existing[0]) {
          await db
            .insert(s.principal)
            .values({ id: newId('principal'), ...identity })
            .onConflictDoNothing();
        }
        const rows = existing[0] ? existing : await db.select().from(s.principal).where(match);
        const row = rows[0];
        if (!row) throw new Error(`principal ${identity.iss} ${identity.subject} not found`);
        return { ...row, id: row.id as PrincipalId } satisfies PrincipalRecord;
      },
      async insert(p) {
        await db.insert(s.principal).values(p);
      },
    },

    memberships: {
      async roleOf(projectId, principalId) {
        const rows = await db
          .select({ role: s.membership.role })
          .from(s.membership)
          .where(
            and(eq(s.membership.projectId, projectId), eq(s.membership.principalId, principalId)),
          );
        return rows[0]?.role ?? null;
      },
      async insert(projectId, principalId, role) {
        await db.insert(s.membership).values({ projectId, principalId, role });
      },
    },

    agentTokens: {
      async insert(token) {
        await db.insert(s.agentToken).values(token);
      },
      async listInProject(projectId) {
        const rows = await db
          .select()
          .from(s.agentToken)
          .where(eq(s.agentToken.projectId, projectId))
          .orderBy(desc(s.agentToken.createdAt), desc(s.agentToken.id));
        return rows.map(toToken);
      },
      async findInProject(projectId, id) {
        const rows = await db
          .select()
          .from(s.agentToken)
          .where(and(eq(s.agentToken.projectId, projectId), eq(s.agentToken.id, id)));
        return rows[0] ? toToken(rows[0]) : null;
      },
      async revoke(projectId, id, at) {
        await db
          .update(s.agentToken)
          .set({ revokedAt: at })
          .where(and(eq(s.agentToken.projectId, projectId), eq(s.agentToken.id, id)));
      },
      async findBySecretHash(hash) {
        const rows = await db
          .select({ token: s.agentToken, handle: s.principal.handle })
          .from(s.agentToken)
          .innerJoin(s.principal, eq(s.principal.id, s.agentToken.principalId))
          .where(eq(s.agentToken.secretHash, hash));
        return rows[0] ? { ...toToken(rows[0].token), handle: rows[0].handle } : null;
      },
      async touch(id, at, minIntervalMs) {
        await db
          .update(s.agentToken)
          .set({ lastUsedAt: at })
          .where(
            and(
              eq(s.agentToken.id, id),
              or(
                isNull(s.agentToken.lastUsedAt),
                lt(s.agentToken.lastUsedAt, new Date(at.getTime() - minIntervalMs)),
              ),
            ),
          );
      },
    },

    models: {
      async findInProject(projectId, id) {
        const rows = await db
          .select()
          .from(s.model)
          .where(
            and(eq(s.model.projectId, projectId), eq(s.model.id, id), isNull(s.model.deletedSeq)),
          );
        return rows[0] ? toModel(rows[0]) : null;
      },
      async findByKey(projectId, key) {
        const rows = await db
          .select()
          .from(s.model)
          .where(and(eq(s.model.projectId, projectId), eq(s.model.key, key)));
        return rows[0] ? toModel(rows[0]) : null;
      },
      async insert(m) {
        await db.insert(s.model).values(m);
      },
      async update(projectId, id, patch) {
        await db
          .update(s.model)
          .set({ ...patch, updatedAt: sql`now()` })
          .where(and(eq(s.model.projectId, projectId), eq(s.model.id, id)));
      },
      async list(projectId, page) {
        const rows = await modelViews(
          projectId,
          page.stage === undefined ? undefined : eq(s.modelPipeline.stage, page.stage),
          page.afterKey === undefined ? undefined : gt(s.model.key, page.afterKey),
        )
          .orderBy(asc(s.model.key))
          .limit(page.limit);
        return rows.map(toView);
      },
      async view(projectId, id) {
        const rows = await modelViews(projectId, eq(s.model.id, id));
        return rows[0] ? toView(rows[0]) : null;
      },
      async viewByKey(projectId, key) {
        const rows = await modelViews(projectId, eq(s.model.key, key));
        return rows[0] ? toView(rows[0]) : null;
      },
    },

    revisions: {
      async insert(r) {
        await db.insert(s.modelRevision).values(r);
      },
      async findInProject(projectId, modelId, id) {
        const rows = await db
          .select(revisionColumns)
          .from(s.modelRevision)
          .where(
            and(
              eq(s.modelRevision.projectId, projectId),
              eq(s.modelRevision.modelId, modelId),
              eq(s.modelRevision.id, id),
            ),
          );
        return rows[0] ? toRevision(rows[0]) : null;
      },
      async listForModel(projectId, modelId, page) {
        const rows = await db
          .select(revisionColumns)
          .from(s.modelRevision)
          .where(
            and(
              eq(s.modelRevision.projectId, projectId),
              eq(s.modelRevision.modelId, modelId),
              page.beforeRev === undefined ? undefined : lt(s.modelRevision.rev, page.beforeRev),
            ),
          )
          .orderBy(desc(s.modelRevision.rev))
          .limit(page.limit);
        return rows.map(toRevision);
      },
      async content(projectId, modelId, id) {
        const rows = await db
          .select({ xml: s.modelRevision.xml })
          .from(s.modelRevision)
          .where(
            and(
              eq(s.modelRevision.projectId, projectId),
              eq(s.modelRevision.modelId, modelId),
              eq(s.modelRevision.id, id),
            ),
          );
        return rows[0]?.xml ?? null;
      },
      async facts(projectId, modelId, id) {
        const rows = await db
          .select({
            modelKey: s.model.key,
            factsVersion: s.modelRevision.factsVersion,
            processes: s.modelRevision.processes,
            messageFlows: s.modelRevision.messageFlows,
          })
          .from(s.modelRevision)
          .innerJoin(
            s.model,
            and(
              eq(s.model.projectId, s.modelRevision.projectId),
              eq(s.model.id, s.modelRevision.modelId),
            ),
          )
          .where(
            and(
              eq(s.modelRevision.projectId, projectId),
              eq(s.modelRevision.modelId, modelId),
              eq(s.modelRevision.id, id),
            ),
          );
        const head = rows[0];
        if (!head) return null;
        const facts = await db
          .select()
          .from(s.fact)
          .where(and(eq(s.fact.projectId, projectId), eq(s.fact.revisionId, id)));
        return { ...head, facts: facts.map((f) => toFact(f, head.modelKey)).sort(compareFacts) };
      },
      async maxRev(projectId, modelId) {
        const rows = await db
          .select({ rev: max(s.modelRevision.rev) })
          .from(s.modelRevision)
          .where(
            and(eq(s.modelRevision.projectId, projectId), eq(s.modelRevision.modelId, modelId)),
          );
        return rows[0]?.rev ?? 0;
      },
      async headHashes(projectId) {
        const rows = await db
          .select({ key: s.model.key, factsHash: s.modelRevision.factsHash })
          .from(s.model)
          .innerJoin(s.modelRevision, liveHead)
          .where(and(eq(s.model.projectId, projectId), isNull(s.model.deletedSeq)));
        return new Map(rows.map((r) => [r.key, r.factsHash]));
      },
      async hashesAt(projectId, modelKeys, seq) {
        if (modelKeys.length === 0) return new Map();
        // The latest revision up to `seq`, unless a deletion followed it by
        // `seq` (a revival always adds a revision, so none came between).
        const result = await db.execute<{ key: string; facts_hash: string }>(sql`
          select m.key, r.facts_hash
          from ${s.model} m
          join lateral (
            select x.facts_hash, x.seq from ${s.modelRevision} x
            where x.project_id = m.project_id and x.model_id = m.id and x.seq <= ${seq}
            order by x.seq desc limit 1
          ) r on true
          where m.project_id = ${projectId} and m.key in ${[...new Set(modelKeys)]}
            and not exists (
              select 1 from ${s.event} e
              where e.project_id = m.project_id and e.type = 'model.deleted'
                and e.seq > r.seq and e.seq <= ${seq} and e.payload->>'modelId' = m.id
            )`);
        return new Map(result.rows.map((r) => [r.key, r.facts_hash]));
      },
    },

    facts: {
      async insertMany(projectId, revisionId, facts) {
        for (const chunk of chunks(facts, INSERT_CHUNK)) {
          await db.insert(s.fact).values(
            chunk.map((f) => ({
              revisionId,
              projectId,
              kind: f.kind,
              elementId: f.elementId,
              processId: f.processId,
              scope: f.scope,
              eventDef: f.eventDef,
              label: f.label,
              keyRaw: f.keyRaw,
              keyNorm: f.keyNorm,
              fingerprint: f.fingerprint,
              attrs: f.attrs,
            })),
          );
        }
      },
      head: headFacts,
      async headProjectFacts(projectId) {
        const heads = await db
          .select({
            modelKey: s.model.key,
            factsVersion: s.modelRevision.factsVersion,
            processes: s.modelRevision.processes,
            messageFlows: s.modelRevision.messageFlows,
          })
          .from(s.model)
          .innerJoin(s.modelRevision, liveHead)
          .where(and(eq(s.model.projectId, projectId), isNull(s.model.deletedSeq)));
        const facts = await headFacts(projectId);
        const byModel = new Map<string, Fact[]>();
        for (const { processName: _processName, ...f } of facts) {
          const list = byModel.get(f.modelKey) ?? [];
          list.push(f);
          byModel.set(f.modelKey, list);
        }
        const models: ModelFacts[] = heads
          .map((h) => ({ ...h, facts: byModel.get(h.modelKey) ?? [] }))
          .sort((a, b) => byCodePoint(a.modelKey, b.modelKey));
        return { models };
      },
    },

    relations: {
      async all(projectId) {
        const rows = await db.select().from(s.relation).where(eq(s.relation.projectId, projectId));
        return rows.map(toRelation);
      },
      async findInProject(projectId, id) {
        const rows = await db
          .select()
          .from(s.relation)
          .where(and(eq(s.relation.projectId, projectId), eq(s.relation.id, id)));
        return rows[0] ? toRelation(rows[0]) : null;
      },
      async insert(r) {
        const rows = await db.insert(s.relation).values(r).returning();
        if (!rows[0]) throw new Error(`relation ${r.id} not inserted`);
        return toRelation(rows[0]);
      },
      async update(projectId, id, patch) {
        const rows = await db
          .update(s.relation)
          .set({ ...patch, version: sql`${s.relation.version} + 1`, updatedAt: sql`now()` })
          .where(and(eq(s.relation.projectId, projectId), eq(s.relation.id, id)))
          .returning();
        if (!rows[0]) throw new Error(`relation ${id} not found`);
        return toRelation(rows[0]);
      },
      async lock(projectId, id) {
        const rows = await db
          .select()
          .from(s.relation)
          .where(and(eq(s.relation.projectId, projectId), eq(s.relation.id, id)))
          .for('update');
        return rows[0] ? toRelation(rows[0]) : null;
      },
      async findByNaturalKey(projectId, type, from, to) {
        const rows = await db
          .select()
          .from(s.relation)
          .where(
            and(
              eq(s.relation.projectId, projectId),
              eq(s.relation.type, type),
              eq(s.relation.fromRef, from),
              eq(s.relation.toRef, to),
            ),
          );
        return rows[0] ? toRelation(rows[0]) : null;
      },
      async list(projectId, filter, page) {
        const statusFilter =
          filter.status !== undefined
            ? eq(s.relation.status, filter.status)
            : filter.includeObsolete
              ? undefined
              : sql`${s.relation.status} <> 'obsolete'`;
        const after = page.after;
        const rows = await db
          .select()
          .from(s.relation)
          .where(
            and(
              eq(s.relation.projectId, projectId),
              statusFilter,
              filter.type === undefined ? undefined : eq(s.relation.type, filter.type),
              filter.tier === undefined ? undefined : eq(s.relation.tier, filter.tier),
              filter.modelKey === undefined
                ? undefined
                : or(
                    eq(s.relation.fromModel, filter.modelKey),
                    eq(s.relation.toModel, filter.modelKey),
                  ),
              after === undefined
                ? undefined
                : sql`(${s.relation.type}, ${s.relation.fromRef}, ${s.relation.toRef}) > (${after[0]}, ${after[1]}, ${after[2]})`,
            ),
          )
          .orderBy(asc(s.relation.type), asc(s.relation.fromRef), asc(s.relation.toRef))
          .limit(page.limit);
        return rows.map(toRelation);
      },
    },

    assertions: {
      async insert(a) {
        await db.insert(s.relationAssertion).values(a);
      },
      async listForProject(projectId) {
        const rows = await db
          .select({ a: s.relationAssertion, handle: s.principal.handle })
          .from(s.relationAssertion)
          .innerJoin(s.principal, eq(s.principal.id, s.relationAssertion.principalId))
          .where(eq(s.relationAssertion.projectId, projectId))
          .orderBy(asc(s.relationAssertion.seq));
        return rows.map((r) => toAssertion(r.a, r.handle));
      },
      async listForRelations(projectId, ids) {
        if (ids.length === 0) return [];
        const rows = await db
          .select({ a: s.relationAssertion, handle: s.principal.handle })
          .from(s.relationAssertion)
          .innerJoin(s.principal, eq(s.principal.id, s.relationAssertion.principalId))
          .where(
            and(
              eq(s.relationAssertion.projectId, projectId),
              inArray(s.relationAssertion.relationId, [...ids]),
            ),
          )
          .orderBy(asc(s.relationAssertion.seq));
        return rows.map((r) => toAssertion(r.a, r.handle));
      },
    },

    tasks: {
      async latest(projectId, modelId, states) {
        const rows = await db
          .select()
          .from(s.analysisTask)
          .where(
            and(
              eq(s.analysisTask.projectId, projectId),
              eq(s.analysisTask.modelId, modelId),
              eq(s.analysisTask.kind, 'relations'),
              inArray(s.analysisTask.state, [...states]),
            ),
          )
          .orderBy(desc(s.analysisTask.seq))
          .limit(1);
        return rows[0] ? toModelTaskRecord(rows[0]) : null;
      },
      async latestForChain(projectId, valueChainId, states) {
        const rows = await db
          .select()
          .from(s.analysisTask)
          .where(
            and(
              eq(s.analysisTask.projectId, projectId),
              eq(s.analysisTask.valueChainId, valueChainId),
              eq(s.analysisTask.kind, 'placement'),
              inArray(s.analysisTask.state, [...states]),
            ),
          )
          .orderBy(desc(s.analysisTask.seq))
          .limit(1);
        return rows[0] ? toChainTaskRecord(rows[0]) : null;
      },
      async insert(t) {
        await db.insert(s.analysisTask).values(taskRow(t));
      },
      async setState(projectId, id, state, lastError) {
        await db
          .update(s.analysisTask)
          .set({
            state,
            updatedAt: sql`now()`,
            ...(lastError === undefined ? {} : { lastError }),
            // A cancelled claim judges nothing any more.
            ...(state === 'cancelled' ? { assignment: null, placementClaim: null } : {}),
          })
          .where(and(eq(s.analysisTask.projectId, projectId), eq(s.analysisTask.id, id)));
      },
      async projectOf(id) {
        const rows = await db
          .select({ projectId: s.analysisTask.projectId })
          .from(s.analysisTask)
          .where(eq(s.analysisTask.id, id));
        return (rows[0]?.projectId as ProjectId | undefined) ?? null;
      },
      async findInProject(projectId, id, options = {}) {
        if (options.forUpdate) {
          await db
            .select({ id: s.analysisTask.id })
            .from(s.analysisTask)
            .where(and(eq(s.analysisTask.projectId, projectId), eq(s.analysisTask.id, id)))
            .for('update');
        }
        const rows = await taskDetails(
          and(eq(s.analysisTask.projectId, projectId), eq(s.analysisTask.id, id)),
        );
        return rows[0] ?? null;
      },
      async list(projectId, filter, page) {
        return taskDetails(
          and(
            eq(s.analysisTask.projectId, projectId),
            filter.state === undefined ? undefined : eq(s.analysisTask.state, filter.state),
            filter.kind === undefined ? undefined : eq(s.analysisTask.kind, filter.kind),
            filter.modelKey === undefined ? undefined : eq(s.model.key, filter.modelKey),
            page.beforeSeq === undefined ? undefined : lt(s.analysisTask.seq, page.beforeSeq),
          ),
          { order: 'seq-desc', limit: page.limit },
        );
      },
      async hasExpired(projectIds, now, maxAttempts) {
        if (projectIds.length === 0) return false;
        const rows = await db
          .select({ id: s.analysisTask.id })
          .from(s.analysisTask)
          .where(
            and(
              inArray(s.analysisTask.projectId, [...projectIds]),
              eq(s.analysisTask.state, 'claimed'),
              lt(s.analysisTask.leaseUntil, now),
              gte(s.analysisTask.attempts, maxAttempts),
            ),
          )
          .limit(1);
        return rows.length > 0;
      },
      async failExpired(projectIds, now, maxAttempts, reason) {
        if (projectIds.length === 0) return [];
        const rows = await db
          .update(s.analysisTask)
          // The assignment stays: a late submit of the holder reports `uncovered` from it
          // (claims read only queued and claimed tasks).
          .set({ state: 'failed', lastError: reason, updatedAt: sql`now()` })
          .where(
            and(
              inArray(s.analysisTask.projectId, [...projectIds]),
              eq(s.analysisTask.state, 'claimed'),
              lt(s.analysisTask.leaseUntil, now),
              gte(s.analysisTask.attempts, maxAttempts),
            ),
          )
          .returning({ id: s.analysisTask.id });
        if (rows.length === 0) return [];
        return taskDetails(
          inArray(
            s.analysisTask.id,
            rows.map((r) => r.id),
          ),
        );
      },
      async claim(q) {
        if (q.projectIds.length === 0 || q.limit < 1) return [];
        const projectIds = [...q.projectIds];
        const t = s.analysisTask;
        const claimable = db
          .select({ id: t.id })
          .from(t)
          .where(
            and(
              inArray(t.projectId, projectIds),
              inArray(t.kind, [...q.kinds]),
              or(
                eq(t.state, 'queued'),
                and(eq(t.state, 'claimed'), lt(t.leaseUntil, q.now), lt(t.attempts, q.maxAttempts)),
              ),
              // A model narrows to that model's tasks; a chain task has no model.
              q.modelKey === undefined
                ? undefined
                : inArray(
                    t.modelId,
                    db
                      .select({ id: s.model.id })
                      .from(s.model)
                      .where(
                        and(
                          inArray(s.model.projectId, projectIds),
                          eq(s.model.key, q.modelKey),
                          isNull(s.model.deletedSeq),
                        ),
                      ),
                  ),
            ),
          )
          .orderBy(asc(t.createdAt), asc(t.seq))
          .limit(q.limit)
          .for('update', { skipLocked: true });
        const rows = await db
          .update(t)
          .set({
            state: 'claimed',
            claimedBy: q.principalId,
            leaseUntil: q.leaseUntil,
            leaseTokenHash: null,
            attempts: sql`${t.attempts} + 1`,
            // The claim renders its input and assignment next; it sees every loss so far.
            assignment: null,
            placementClaim: null,
            requeueAfter: false,
            updatedAt: sql`now()`,
          })
          .where(inArray(t.id, claimable))
          .returning({ id: t.id });
        if (rows.length === 0) return [];
        return taskDetails(
          inArray(
            t.id,
            rows.map((r) => r.id),
          ),
          { order: 'created' },
        );
      },
      async setLeaseHash(projectId, id, hash) {
        await db
          .update(s.analysisTask)
          .set({ leaseTokenHash: hash })
          .where(and(eq(s.analysisTask.projectId, projectId), eq(s.analysisTask.id, id)));
      },
      async setClaimedSeq(projectId, id, seq) {
        await db
          .update(s.analysisTask)
          .set({ claimedSeq: seq })
          .where(and(eq(s.analysisTask.projectId, projectId), eq(s.analysisTask.id, id)));
      },
      async setAssignment(projectId, id, pairs) {
        await db
          .update(s.analysisTask)
          .set({ assignment: [...pairs] })
          .where(and(eq(s.analysisTask.projectId, projectId), eq(s.analysisTask.id, id)));
      },
      async setPlacementClaim(projectId, id, claim, valueChainRevisionId) {
        await db
          .update(s.analysisTask)
          .set({ placementClaim: claim, valueChainRevisionId })
          .where(and(eq(s.analysisTask.projectId, projectId), eq(s.analysisTask.id, id)));
      },
      async setRequeueAfter(projectId, id) {
        await db
          .update(s.analysisTask)
          .set({ requeueAfter: true })
          .where(and(eq(s.analysisTask.projectId, projectId), eq(s.analysisTask.id, id)));
      },
      async release(projectId, id, reason) {
        await db
          .update(s.analysisTask)
          .set({
            state: 'queued',
            leaseTokenHash: null,
            leaseUntil: null,
            attempts: sql`greatest(${s.analysisTask.attempts} - 1, 0)`,
            lastError: reason,
            assignment: null,
            placementClaim: null,
            requeueAfter: false,
            updatedAt: sql`now()`,
          })
          .where(and(eq(s.analysisTask.projectId, projectId), eq(s.analysisTask.id, id)));
      },
      async countClaimable(projectIds, now, maxAttempts, kinds) {
        const out = new Map<ProjectId, number>();
        if (projectIds.length === 0 || kinds.length === 0) return out;
        const t = s.analysisTask;
        const rows = await db
          .select({ projectId: t.projectId, n: count() })
          .from(t)
          .where(
            and(
              inArray(t.projectId, [...projectIds]),
              inArray(t.kind, [...kinds]),
              or(
                eq(t.state, 'queued'),
                and(eq(t.state, 'claimed'), lt(t.leaseUntil, now), lt(t.attempts, maxAttempts)),
              ),
            ),
          )
          .groupBy(t.projectId);
        for (const r of rows) out.set(r.projectId as ProjectId, r.n);
        return out;
      },
    },

    submissions: {
      async insert(r) {
        await db.insert(s.analysisSubmission).values(r);
      },
      async findByTask(projectId, taskId) {
        const rows = await db
          .select({ sub: s.analysisSubmission, handle: s.principal.handle })
          .from(s.analysisSubmission)
          .innerJoin(s.principal, eq(s.principal.id, s.analysisSubmission.principalId))
          .where(
            and(
              eq(s.analysisSubmission.projectId, projectId),
              eq(s.analysisSubmission.taskId, taskId),
            ),
          );
        const r = rows[0];
        if (!r) return null;
        return {
          id: r.sub.id as SubmissionId,
          projectId: r.sub.projectId as ProjectId,
          taskId: r.sub.taskId as AnalysisTaskId,
          clientSubmissionId: r.sub.clientSubmissionId,
          principalId: r.sub.principalId as PrincipalId,
          clientId: r.sub.clientId,
          declared: r.sub.declared,
          payload: r.sub.payload,
          result: r.sub.result,
          seq: r.sub.seq,
          handle: r.handle,
          createdAt: r.sub.createdAt,
        } satisfies StoredSubmission;
      },
      async originModels(projectId) {
        const rows = await db
          .select({ id: s.analysisSubmission.id, key: s.model.key })
          .from(s.analysisSubmission)
          .innerJoin(
            s.analysisTask,
            and(
              eq(s.analysisTask.projectId, s.analysisSubmission.projectId),
              eq(s.analysisTask.id, s.analysisSubmission.taskId),
            ),
          )
          .innerJoin(
            s.model,
            and(
              eq(s.model.projectId, s.analysisTask.projectId),
              eq(s.model.id, s.analysisTask.modelId),
            ),
          )
          .where(
            and(
              eq(s.analysisSubmission.projectId, projectId),
              eq(s.analysisTask.subjectKind, 'model'),
            ),
          );
        return new Map(rows.map((r) => [r.id as SubmissionId, r.key]));
      },
    },

    noLinks: {
      async insertMany(rows) {
        for (const chunk of chunks(rows, INSERT_CHUNK)) await db.insert(s.noLink).values(chunk);
      },
      async listLive(projectId, filter, procedure) {
        const nl = s.noLink;
        const froms = filter.pairs ? [...new Set(filter.pairs.map((p) => p.from))] : undefined;
        if (froms?.length === 0) return [];
        const rows = await db
          .select({
            nl,
            handle: s.principal.handle,
            origin: noLinkOrigin.key,
            // Current: both bases are the heads, and the procedure is the one asked for.
            current: sql<boolean>`coalesce(
              ${noLinkFromHead.factsHash} = ${nl.fromHash}
              and ${noLinkToHead.factsHash} = ${nl.toHash}
              and ${nl.declared}->'procedure'->>'id' = ${procedure.id}
              and ${nl.declared}->'procedure'->>'version' = ${procedure.version}, false)`,
          })
          .from(nl)
          .innerJoin(s.principal, eq(s.principal.id, nl.principalId))
          .innerJoin(
            noLinkOrigin,
            and(eq(noLinkOrigin.projectId, nl.projectId), eq(noLinkOrigin.id, nl.modelId)),
          )
          .leftJoin(
            noLinkFrom,
            and(
              eq(noLinkFrom.projectId, nl.projectId),
              eq(noLinkFrom.key, nl.fromModel),
              isNull(noLinkFrom.deletedSeq),
            ),
          )
          .leftJoin(
            noLinkFromHead,
            and(
              eq(noLinkFromHead.projectId, noLinkFrom.projectId),
              eq(noLinkFromHead.id, noLinkFrom.headRevisionId),
            ),
          )
          .leftJoin(
            noLinkTo,
            and(
              eq(noLinkTo.projectId, nl.projectId),
              eq(noLinkTo.key, nl.toModel),
              isNull(noLinkTo.deletedSeq),
            ),
          )
          .leftJoin(
            noLinkToHead,
            and(
              eq(noLinkToHead.projectId, noLinkTo.projectId),
              eq(noLinkToHead.id, noLinkTo.headRevisionId),
            ),
          )
          .leftJoin(s.noLinkWithdrawal, eq(s.noLinkWithdrawal.noLinkId, nl.id))
          .where(
            and(
              eq(nl.projectId, projectId),
              isNull(s.noLinkWithdrawal.noLinkId),
              filter.touchingModelKey === undefined
                ? undefined
                : or(
                    eq(nl.fromModel, filter.touchingModelKey),
                    eq(nl.toModel, filter.touchingModelKey),
                  ),
              filter.principalId === undefined ? undefined : eq(nl.principalId, filter.principalId),
              froms === undefined ? undefined : inArray(nl.fromRef, froms),
            ),
          )
          .orderBy(asc(nl.seq), asc(nl.id));
        const wanted = filter.pairs
          ? new Set(filter.pairs.map((p) => `${p.type}\u0000${p.from}\u0000${p.to}`))
          : undefined;
        return rows
          .filter(
            (r) => !wanted || wanted.has(`${r.nl.type}\u0000${r.nl.fromRef}\u0000${r.nl.toRef}`),
          )
          .map((r): StoredNoLink => ({
            id: r.nl.id as NoLinkId,
            projectId: r.nl.projectId as ProjectId,
            type: r.nl.type,
            fromRef: r.nl.fromRef as Ref,
            toRef: r.nl.toRef as Ref,
            fromModel: r.nl.fromModel,
            toModel: r.nl.toModel,
            fromHash: r.nl.fromHash,
            toHash: r.nl.toHash,
            reason: r.nl.reason,
            sourceKind: r.nl.sourceKind,
            principalId: r.nl.principalId as PrincipalId,
            clientId: r.nl.clientId,
            declared: r.nl.declared,
            submissionId: r.nl.submissionId as SubmissionId,
            modelId: r.nl.modelId as ModelId,
            seq: r.nl.seq,
            handle: r.handle,
            origin: r.origin,
            current: r.current,
            createdAt: r.nl.createdAt,
          }));
      },
      async withdraw(projectId, ids, by) {
        for (const chunk of chunks(ids, INSERT_CHUNK)) {
          await db.insert(s.noLinkWithdrawal).values(
            chunk.map((id) => ({
              noLinkId: id,
              projectId,
              seq: by.seq,
              principalId: by.principalId,
              reason: by.reason,
            })),
          );
        }
      },
    },

    valueChains: {
      async findByKey(projectId, key) {
        const rows = await db
          .select()
          .from(s.valueChain)
          .where(and(eq(s.valueChain.projectId, projectId), eq(s.valueChain.key, key)));
        return rows[0] ? toValueChain(rows[0]) : null;
      },
      async findInProject(projectId, id) {
        const rows = await db
          .select()
          .from(s.valueChain)
          .where(
            and(
              eq(s.valueChain.projectId, projectId),
              eq(s.valueChain.id, id),
              isNull(s.valueChain.deletedSeq),
            ),
          );
        return rows[0] ? toValueChain(rows[0]) : null;
      },
      async list(projectId) {
        const rows = await db
          .select()
          .from(s.valueChain)
          .where(and(eq(s.valueChain.projectId, projectId), isNull(s.valueChain.deletedSeq)));
        return rows.map(toValueChain).sort((a, b) => byCodePoint(a.key, b.key));
      },
      async insert(c) {
        const rows = await db.insert(s.valueChain).values(c).returning();
        if (!rows[0]) throw new Error(`value chain ${c.id} not inserted`);
        return toValueChain(rows[0]);
      },
      async update(projectId, id, patch) {
        const rows = await db
          .update(s.valueChain)
          .set({ ...patch, updatedAt: sql`now()` })
          .where(and(eq(s.valueChain.projectId, projectId), eq(s.valueChain.id, id)))
          .returning();
        if (!rows[0]) throw new Error(`value chain ${id} not found`);
        return toValueChain(rows[0]);
      },
      async pipeline(projectId, id) {
        const v = s.valueChainPipeline;
        const rows = await db
          .select()
          .from(v)
          .where(and(eq(v.projectId, projectId), eq(v.valueChainId, id)));
        const r = rows[0];
        if (!r) return null;
        return {
          taskId: r.taskId as AnalysisTaskId | null,
          taskState: r.taskState,
          reviewItems: r.reviewItems,
          heldItems: r.heldItems,
          stage: r.stage as ModelStage,
        } satisfies ValueChainPipelineRecord;
      },
      async listWithoutPlacementTask() {
        const t = s.analysisTask;
        const rows = await db
          .select()
          .from(s.valueChain)
          .where(
            and(
              isNull(s.valueChain.deletedSeq),
              isNotNull(s.valueChain.headRevisionId),
              notExists(
                db
                  .select({ id: t.id })
                  .from(t)
                  .where(
                    and(
                      eq(t.projectId, s.valueChain.projectId),
                      eq(t.valueChainId, s.valueChain.id),
                      eq(t.kind, 'placement'),
                    ),
                  ),
              ),
            ),
          );
        return rows
          .map(toValueChain)
          .sort((a, b) => byCodePoint(a.projectId, b.projectId) || byCodePoint(a.key, b.key));
      },
    },

    valueChainRevisions: {
      async insert(r) {
        await db.insert(s.valueChainRevision).values(r);
      },
      async findInProject(projectId, valueChainId, id) {
        const rows = await db
          .select(chainRevisionColumns)
          .from(s.valueChainRevision)
          .where(
            and(
              eq(s.valueChainRevision.projectId, projectId),
              eq(s.valueChainRevision.valueChainId, valueChainId),
              eq(s.valueChainRevision.id, id),
            ),
          );
        return rows[0] ? toChainRevision(rows[0]) : null;
      },
      async findByRev(projectId, valueChainId, rev) {
        const rows = await db
          .select({ ...chainRevisionColumns, handle: s.principal.handle })
          .from(s.valueChainRevision)
          .innerJoin(s.principal, eq(s.principal.id, s.valueChainRevision.principalId))
          .where(
            and(
              eq(s.valueChainRevision.projectId, projectId),
              eq(s.valueChainRevision.valueChainId, valueChainId),
              eq(s.valueChainRevision.rev, rev),
            ),
          );
        return rows[0] ? { ...toChainRevision(rows[0]), handle: rows[0].handle } : null;
      },
      async listForChain(projectId, valueChainId, page) {
        const rows = await db
          .select({ ...chainRevisionColumns, handle: s.principal.handle })
          .from(s.valueChainRevision)
          .innerJoin(s.principal, eq(s.principal.id, s.valueChainRevision.principalId))
          .where(
            and(
              eq(s.valueChainRevision.projectId, projectId),
              eq(s.valueChainRevision.valueChainId, valueChainId),
              page.beforeRev === undefined
                ? undefined
                : lt(s.valueChainRevision.rev, page.beforeRev),
            ),
          )
          .orderBy(desc(s.valueChainRevision.rev))
          .limit(page.limit);
        return rows.map((r) => ({ ...toChainRevision(r), handle: r.handle }));
      },
      async content(projectId, valueChainId, id) {
        const rows = await db
          .select({ content: s.valueChainRevision.content })
          .from(s.valueChainRevision)
          .where(
            and(
              eq(s.valueChainRevision.projectId, projectId),
              eq(s.valueChainRevision.valueChainId, valueChainId),
              eq(s.valueChainRevision.id, id),
            ),
          );
        return rows[0]?.content ?? null;
      },
      async maxRev(projectId, valueChainId) {
        const rows = await db
          .select({ rev: max(s.valueChainRevision.rev) })
          .from(s.valueChainRevision)
          .where(
            and(
              eq(s.valueChainRevision.projectId, projectId),
              eq(s.valueChainRevision.valueChainId, valueChainId),
            ),
          );
        return rows[0]?.rev ?? 0;
      },
    },

    valueChainSteps: {
      async list(projectId, valueChainId) {
        const rows = await db
          .select()
          .from(s.valueChainStep)
          .where(
            and(
              eq(s.valueChainStep.projectId, projectId),
              eq(s.valueChainStep.valueChainId, valueChainId),
            ),
          );
        return rows
          .map(toStep)
          .sort((a, b) => byCodePoint(a.elementId, b.elementId) || a.generation - b.generation);
      },
      async insertMany(rows) {
        for (const chunk of chunks(rows, INSERT_CHUNK)) {
          await db.insert(s.valueChainStep).values(chunk);
        }
      },
      async tombstone(projectId, valueChainId, keys, by) {
        let n = 0;
        for (const chunk of chunks(keys, INSERT_CHUNK)) {
          const rows = await db
            .update(s.valueChainStep)
            .set({ deletedRev: by.rev, deletedSeq: by.seq })
            .where(
              and(
                eq(s.valueChainStep.projectId, projectId),
                eq(s.valueChainStep.valueChainId, valueChainId),
                isNull(s.valueChainStep.deletedSeq),
                sql`(${s.valueChainStep.elementId}, ${s.valueChainStep.generation}) in (${sql.join(
                  chunk.map((k) => sql`(${k.elementId}::text, ${k.generation}::integer)`),
                  sql`, `,
                )})`,
              ),
            )
            .returning({ elementId: s.valueChainStep.elementId });
          n += rows.length;
        }
        return n;
      },
    },

    placements: {
      async forChain(projectId, valueChainId) {
        const rows = await db
          .select()
          .from(s.placement)
          .where(
            and(eq(s.placement.projectId, projectId), eq(s.placement.valueChainId, valueChainId)),
          );
        return rows.map(toPlacement);
      },
      async findInProject(projectId, id) {
        const rows = await db
          .select()
          .from(s.placement)
          .where(and(eq(s.placement.projectId, projectId), eq(s.placement.id, id)));
        return rows[0] ? toPlacement(rows[0]) : null;
      },
      async findByNaturalKey(projectId, valueChainId, elementId, generation, processRef) {
        const rows = await db
          .select()
          .from(s.placement)
          .where(
            and(
              eq(s.placement.projectId, projectId),
              eq(s.placement.valueChainId, valueChainId),
              eq(s.placement.elementId, elementId),
              eq(s.placement.generation, generation),
              eq(s.placement.processRef, processRef),
            ),
          );
        return rows[0] ? toPlacement(rows[0]) : null;
      },
      async insert(p) {
        const rows = await db.insert(s.placement).values(p).returning();
        if (!rows[0]) throw new Error(`placement ${p.id} not inserted`);
        return toPlacement(rows[0]);
      },
      async update(projectId, id, patch) {
        const rows = await db
          .update(s.placement)
          .set({ ...patch, version: sql`${s.placement.version} + 1`, updatedAt: sql`now()` })
          .where(and(eq(s.placement.projectId, projectId), eq(s.placement.id, id)))
          .returning();
        if (!rows[0]) throw new Error(`placement ${id} not found`);
        return toPlacement(rows[0]);
      },
      async list(projectId, filter, page) {
        const statusFilter =
          filter.status !== undefined
            ? eq(s.placement.status, filter.status)
            : filter.includeObsolete
              ? undefined
              : sql`${s.placement.status} <> 'obsolete'`;
        const after = page.after;
        const rows = await db
          .select()
          .from(s.placement)
          .where(
            and(
              eq(s.placement.projectId, projectId),
              eq(s.placement.valueChainId, filter.valueChainId),
              statusFilter,
              filter.elementId === undefined
                ? undefined
                : eq(s.placement.elementId, filter.elementId),
              filter.processRef === undefined
                ? undefined
                : eq(s.placement.processRef, filter.processRef),
              filter.touchingModelKey === undefined
                ? undefined
                : eq(s.placement.processModel, filter.touchingModelKey),
              filter.tier === undefined ? undefined : eq(s.placement.tier, filter.tier),
              filter.endpointState === undefined
                ? undefined
                : eq(s.placement.endpointState, filter.endpointState),
              after === undefined
                ? undefined
                : sql`(${s.placement.elementId} collate "C", ${s.placement.generation}, ${s.placement.processRef} collate "C") > (${after[0]} collate "C", ${after[1]}::integer, ${after[2]} collate "C")`,
            ),
          )
          .orderBy(
            sql`${s.placement.elementId} collate "C"`,
            asc(s.placement.generation),
            sql`${s.placement.processRef} collate "C"`,
          )
          .limit(page.limit);
        return rows.map(toPlacement);
      },
    },

    placementAssertions: {
      async insert(a) {
        await db.insert(s.placementAssertion).values(a);
      },
      async listForChain(projectId, valueChainId) {
        const rows = await db
          .select({ a: s.placementAssertion, handle: s.principal.handle })
          .from(s.placementAssertion)
          .innerJoin(
            s.placement,
            and(
              eq(s.placement.projectId, s.placementAssertion.projectId),
              eq(s.placement.id, s.placementAssertion.placementId),
            ),
          )
          .innerJoin(s.principal, eq(s.principal.id, s.placementAssertion.principalId))
          .where(
            and(
              eq(s.placementAssertion.projectId, projectId),
              eq(s.placement.valueChainId, valueChainId),
            ),
          )
          .orderBy(asc(s.placementAssertion.seq));
        return rows.map((r) => toPlacementAssertion(r.a, r.handle));
      },
      async listForPlacements(projectId, ids) {
        if (ids.length === 0) return [];
        const rows = await db
          .select({ a: s.placementAssertion, handle: s.principal.handle })
          .from(s.placementAssertion)
          .innerJoin(s.principal, eq(s.principal.id, s.placementAssertion.principalId))
          .where(
            and(
              eq(s.placementAssertion.projectId, projectId),
              inArray(s.placementAssertion.placementId, [...ids]),
            ),
          )
          .orderBy(asc(s.placementAssertion.seq));
        return rows.map((r) => toPlacementAssertion(r.a, r.handle));
      },
    },

    placementInputs: {
      async forChain(projectId, valueChainId) {
        return placementInputRows(
          and(
            eq(s.placementInput.projectId, projectId),
            eq(s.placementInput.valueChainId, valueChainId),
          ),
        );
      },
      async upsertMany(rows) {
        for (const chunk of chunks(rows, INSERT_CHUNK)) {
          await db
            .insert(s.placementInput)
            .values(chunk.map((r) => ({ ...r })))
            .onConflictDoUpdate({
              target: [s.placementInput.valueChainId, s.placementInput.processRef],
              set: {
                inputHash: sql`excluded.input_hash`,
                taskId: sql`excluded.task_id`,
                principalId: sql`excluded.principal_id`,
                outcome: sql`excluded.outcome`,
                reason: sql`excluded.reason`,
                seq: sql`excluded.seq`,
                updatedAt: sql`now()`,
              },
            });
        }
      },
      async deleteProcesses(projectId, valueChainId, processRefs) {
        if (processRefs.length === 0) return 0;
        const rows = await db
          .delete(s.placementInput)
          .where(
            and(
              eq(s.placementInput.projectId, projectId),
              eq(s.placementInput.valueChainId, valueChainId),
              inArray(s.placementInput.processRef, [...processRefs]),
            ),
          )
          .returning({ processRef: s.placementInput.processRef });
        return rows.length;
      },
      async deleteByPrincipal(projectId, principalId) {
        const rows = await db
          .delete(s.placementInput)
          .where(
            and(
              eq(s.placementInput.projectId, projectId),
              eq(s.placementInput.principalId, principalId),
            ),
          )
          .returning();
        return rows
          .map(toPlacementInput)
          .sort(
            (a, b) =>
              byCodePoint(a.valueChainId, b.valueChainId) ||
              byCodePoint(a.processRef, b.processRef),
          );
      },
      async unsure(projectId, valueChainId) {
        return placementInputRows(
          and(
            eq(s.placementInput.projectId, projectId),
            eq(s.placementInput.valueChainId, valueChainId),
            eq(s.placementInput.outcome, 'unsure'),
          ),
        );
      },
    },

    findings: {
      async replace(projectId, findings) {
        await db.delete(s.finding).where(eq(s.finding.projectId, projectId));
        for (const chunk of chunks(
          findings.map((f, ord) => ({
            projectId,
            ord,
            kind: f.kind,
            refs: f.refs,
            detail: f.detail,
          })),
          INSERT_CHUNK,
        )) {
          await db.insert(s.finding).values(chunk);
        }
      },
      async list(projectId) {
        const rows = await db
          .select()
          .from(s.finding)
          .where(eq(s.finding.projectId, projectId))
          .orderBy(asc(s.finding.ord));
        return rows.map((r): Finding => ({
          kind: r.kind,
          refs: r.refs as Ref[],
          detail: r.detail,
        }));
      },
    },

    events: {
      async append(projectId, event) {
        const rows = await db
          .update(s.project)
          .set({ lastSeq: sql`${s.project.lastSeq} + 1` })
          .where(eq(s.project.id, projectId))
          .returning({ seq: s.project.lastSeq });
        const seq = rows[0]?.seq;
        if (seq === undefined) throw new Error(`project ${projectId} not found`);
        await db.insert(s.event).values({ projectId, seq, ...event });
        return seq;
      },
      async list(projectId, page) {
        const rows = await db
          .select()
          .from(s.event)
          .where(and(eq(s.event.projectId, projectId), gt(s.event.seq, page.afterSeq)))
          .orderBy(asc(s.event.seq))
          .limit(page.limit);
        return rows.map((r): EventRecord => ({
          ...r,
          projectId: r.projectId as ProjectId,
          principalId: r.principalId as PrincipalId,
        }));
      },
    },
  };
}

/** Creates the Drizzle-backed store. */
export function createStore(db: Db): Store {
  return {
    read: (fn) =>
      db.transaction((tx) => fn(repos(tx)), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      }),
    write: (fn) => db.transaction((tx) => fn(repos(tx))),
  };
}
