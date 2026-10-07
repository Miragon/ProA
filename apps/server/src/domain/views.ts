/** Records → API resources of `@proa/contracts` (shared by REST and MCP). */
import type { AgentToken, Model, Project, Relation, Revision, Role } from '@proa/contracts';

import type {
  AgentTokenRecord,
  ModelView,
  ProjectRecord,
  RelationRecord,
  RevisionRecord,
} from './ports.ts';

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
    source: r.source,
    seq: r.seq,
    createdAt: iso(r.createdAt),
  };
}

export function toRelation(r: RelationRecord): Relation {
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
    updatedAt: iso(r.updatedAt),
  };
}

export function toAgentToken(t: AgentTokenRecord): AgentToken {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes,
    expiresAt: iso(t.expiresAt),
    revokedAt: t.revokedAt ? iso(t.revokedAt) : null,
    lastUsedAt: t.lastUsedAt ? iso(t.lastUsedAt) : null,
    createdAt: iso(t.createdAt),
  };
}
