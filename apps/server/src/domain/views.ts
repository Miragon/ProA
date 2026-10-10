/** Records → API resources of `@proa/contracts` (shared by REST and MCP). */
import type {
  AgentToken,
  AnalysisTask,
  Model,
  NoLink,
  Project,
  Relation,
  RelationAssertion,
  RelationNoLink,
  RelationProvenance,
  Revision,
  Role,
} from '@proa/contracts';

import type {
  AgentTokenRecord,
  ModelView,
  ProjectRecord,
  RelationRecord,
  RevisionRecord,
  StoredAssertion,
  StoredNoLink,
  TaskDetail,
} from './ports.ts';
import { recomputeStatus } from './status.ts';

const iso = (d: Date): string => d.toISOString();

export function toProject(p: ProjectRecord, role: Role): Project {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    role,
    lastSeq: p.lastSeq,
    createdAt: iso(p.createdAt),
  };
}

export function toModel(m: ModelView): Model {
  return {
    id: m.id,
    projectId: m.projectId,
    key: m.key,
    name: m.name,
    headRevisionId: m.headRevisionId,
    headRev: m.headRev,
    engine: m.engine,
    stage: m.stage,
    openItems: m.openItems,
    updatedAt: iso(m.updatedAt),
  };
}

export function toRevision(r: RevisionRecord): Revision {
  return {
    id: r.id,
    modelId: r.modelId,
    rev: r.rev,
    contentHash: r.contentHash,
    factsHash: r.factsHash,
    factsVersion: r.factsVersion,
    engine: r.engine,
    source: r.source,
    seq: r.seq,
    createdAt: iso(r.createdAt),
  };
}

function toProvenance(a: StoredAssertion): RelationProvenance {
  return {
    assertionId: a.id,
    kind: a.kind,
    verdict: a.verdict,
    sourceKind: a.sourceKind,
    principalId: a.principalId,
    handle: a.handle,
    clientId: a.clientId,
    procedure: a.declared?.procedure ?? null,
    llmModel: a.declared?.llmModel ?? null,
    tier: a.tier,
    confidence: a.confidence,
    rationale: a.rationale,
    question: a.question,
    label: a.label,
    at: iso(a.createdAt),
  };
}

/** The assertion a relation's status rests on (see `recomputeStatus`). */
export function basisOf(history: readonly StoredAssertion[]): StoredAssertion | null {
  const { basisSeq } = recomputeStatus(history);
  return history.find((a) => a.seq === basisSeq) ?? null;
}

function toRelationNoLink(n: StoredNoLink): RelationNoLink {
  return {
    id: n.id,
    handle: n.handle,
    origin: n.origin,
    reason: n.reason,
    at: iso(n.createdAt),
  };
}

/** A live no-link of the project as the no-link list shows it (`GET …/no-links`). */
export function toNoLink(n: StoredNoLink): NoLink {
  return {
    id: n.id,
    type: n.type,
    from: n.fromRef,
    to: n.toRef,
    handle: n.handle,
    origin: n.origin,
    reason: n.reason,
    at: iso(n.createdAt),
  };
}

/**
 * @param history the relation's assertions (provenance and `source` come
 *   from the one its status rests on)
 * @param noLinks the live, current no-links on its typed pair, oldest first
 */
export function toRelation(
  r: RelationRecord,
  history: readonly StoredAssertion[],
  noLinks: readonly StoredNoLink[] = [],
): Relation {
  const basis = basisOf(history);
  return {
    id: r.id,
    type: r.type,
    from: r.fromRef,
    to: r.toRef,
    status: r.status,
    endpointState: r.endpointState,
    tier: r.tier,
    confidence: r.confidence,
    version: r.version,
    attrs: r.attrs,
    source: basis?.sourceKind ?? null,
    provenance: basis ? toProvenance(basis) : null,
    noLinks: noLinks.map(toRelationNoLink),
    updatedAt: iso(r.updatedAt),
  };
}

export function toRelationAssertion(a: StoredAssertion): RelationAssertion {
  return {
    id: a.id,
    seq: a.seq,
    kind: a.kind,
    verdict: a.verdict,
    sourceKind: a.sourceKind,
    principalId: a.principalId,
    handle: a.handle,
    clientId: a.clientId,
    procedure: a.declared?.procedure ?? null,
    llmModel: a.declared?.llmModel ?? null,
    submissionId: a.submissionId,
    tier: a.tier,
    confidence: a.confidence,
    rationale: a.rationale,
    evidence: a.evidence ?? [],
    question: a.question,
    label: a.label,
    linkedRelationId: a.linkedRelationId,
    fromFp: a.fromFp,
    toFp: a.toFp,
    at: iso(a.createdAt),
  };
}

export function toAnalysisTask(t: TaskDetail): AnalysisTask {
  const lease = {
    state: t.state,
    attempts: t.attempts,
    leaseUntil: t.leaseUntil ? iso(t.leaseUntil) : null,
    claimedBy: t.claimedByHandle,
    lastError: t.lastError,
    submissionId: t.submissionId,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
  return t.subjectKind === 'model'
    ? {
        id: t.id,
        projectId: t.projectId,
        kind: t.kind,
        subjectKind: t.subjectKind,
        modelId: t.modelId,
        modelKey: t.modelKey,
        revisionId: t.revisionId,
        valueChainId: null,
        valueChainKey: null,
        valueChainRevisionId: null,
        factsHash: t.factsHash,
        inputHash: null,
        ...lease,
      }
    : {
        id: t.id,
        projectId: t.projectId,
        kind: t.kind,
        subjectKind: t.subjectKind,
        modelId: null,
        modelKey: null,
        revisionId: null,
        valueChainId: t.valueChainId,
        valueChainKey: t.valueChainKey,
        valueChainRevisionId: t.valueChainRevisionId,
        factsHash: null,
        inputHash: t.inputHash,
        ...lease,
      };
}

export function toAgentToken(t: AgentTokenRecord): AgentToken {
  return {
    id: t.id,
    principalId: t.principalId,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes,
    expiresAt: iso(t.expiresAt),
    revokedAt: t.revokedAt ? iso(t.revokedAt) : null,
    lastUsedAt: t.lastUsedAt ? iso(t.lastUsedAt) : null,
    createdAt: iso(t.createdAt),
  };
}
