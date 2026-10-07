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
  type Fact,
  type Finding,
  type ModelFacts,
  type ModelId,
  type ModelStage,
  type PrincipalId,
  type ProjectId,
  type Ref,
  type RelationId,
  type RevisionId,
} from '@proa/contracts';
import { and, asc, desc, eq, gt, inArray, isNull, lt, max, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type {
  AgentTokenRecord,
  AssertionRecord,
  EventRecord,
  HeadFact,
  HeadFactFilter,
  ModelRecord,
  ModelView,
  PrincipalRecord,
  ProjectRecord,
  RelationRecord,
  RevisionRecord,
  Store,
  TaskRecord,
  Tx,
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
  source: s.modelRevision.source,
  principalId: s.modelRevision.principalId,
  seq: s.modelRevision.seq,
  createdAt: s.modelRevision.createdAt,
};

type RevisionRow = {
  [K in keyof typeof revisionColumns]: (typeof revisionColumns)[K]['_']['data'];
};

const toRevision = (r: RevisionRow): RevisionRecord => ({
  ...r,
  id: r.id as RevisionId,
  projectId: r.projectId as ProjectId,
  modelId: r.modelId as ModelId,
  principalId: r.principalId as PrincipalId,
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
    processes: ModelView['processes'];
    stage: string;
    openItems: number;
  }): ModelView => ({
    ...toModel(r.model),
    headRevisionId: r.model.headRevisionId as RevisionId,
    headRev: r.rev,
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
        await db.insert(s.relation).values(r);
      },
      async update(projectId, id, patch) {
        await db
          .update(s.relation)
          .set({ ...patch, version: sql`${s.relation.version} + 1`, updatedAt: sql`now()` })
          .where(and(eq(s.relation.projectId, projectId), eq(s.relation.id, id)));
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
          .select()
          .from(s.relationAssertion)
          .where(eq(s.relationAssertion.projectId, projectId))
          .orderBy(asc(s.relationAssertion.seq));
        return rows.map((r): AssertionRecord => ({
          id: r.id,
          projectId: r.projectId as ProjectId,
          relationId: r.relationId as RelationId,
          seq: r.seq,
          kind: r.kind,
          verdict: r.verdict,
          sourceKind: r.sourceKind,
          principalId: r.principalId as PrincipalId,
          clientId: r.clientId,
          tier: r.tier,
          confidence: r.confidence,
          rationale: r.rationale,
          fromFp: r.fromFp,
          toFp: r.toFp,
        }));
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
        const r = rows[0];
        if (!r) return null;
        return {
          id: r.id as AnalysisTaskId,
          projectId: r.projectId as ProjectId,
          modelId: r.modelId as ModelId,
          revisionId: r.revisionId as RevisionId,
          kind: r.kind,
          factsHash: r.factsHash,
          state: r.state,
          seq: r.seq,
        } satisfies TaskRecord;
      },
      async insert(t) {
        await db.insert(s.analysisTask).values(t);
      },
      async setState(projectId, id, state) {
        await db
          .update(s.analysisTask)
          .set({ state, updatedAt: sql`now()` })
          .where(and(eq(s.analysisTask.projectId, projectId), eq(s.analysisTask.id, id)));
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
