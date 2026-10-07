/**
 * Ports of the domain: what use cases need from persistence and from the
 * deterministic libraries. `src/db/store.ts` implements {@link Store} with
 * Drizzle; `src/analysis.ts` binds {@link AnalysisPort} to `@proa/bpmn-facts`
 * and `@proa/relations`; tests inject doubles.
 *
 * Every repository method that reads project data takes the `projectId` and
 * filters by it ("findInProject"): an id from another project is simply not
 * found, and the use case answers 404.
 */
import type {
  AgentScope,
  AgentTokenId,
  AnalysisTaskId,
  DerivedRelation,
  EndpointState,
  Fact,
  FactKind,
  Finding,
  MessageFlowInfo,
  ModelId,
  ModelStage,
  PrincipalId,
  ProcessInfo,
  ProjectFacts,
  ProjectId,
  Ref,
  RelationId,
  RelationStatus,
  RelationType,
  RevisionId,
  RevisionSource,
  Role,
  SourceKind,
  Tier,
} from '@proa/contracts';

// ---------------------------------------------------------------- records

export interface ProjectRecord {
  id: ProjectId;
  key: string;
  name: string;
  lastSeq: number;
  createdAt: Date;
}

export type PrincipalKind = 'user' | 'service' | 'system';

export interface PrincipalRecord {
  id: PrincipalId;
  kind: PrincipalKind;
  iss: string;
  subject: string;
  handle: string;
}

export interface AgentTokenRecord {
  id: AgentTokenId;
  projectId: ProjectId;
  principalId: PrincipalId;
  name: string;
  prefix: string;
  scopes: AgentScope[];
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdBy: PrincipalId;
  createdAt: Date;
}

export interface ModelRecord {
  id: ModelId;
  projectId: ProjectId;
  key: string;
  name: string | null;
  headRevisionId: RevisionId | null;
  /** Set while the model is deleted. */
  deletedSeq: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A live model with its head and pipeline state (view `model_pipeline`). */
export interface ModelView extends ModelRecord {
  headRevisionId: RevisionId;
  headRev: number;
  stage: ModelStage;
  openItems: number;
  processes: ProcessInfo[];
}

export interface RevisionRecord {
  id: RevisionId;
  projectId: ProjectId;
  modelId: ModelId;
  rev: number;
  contentHash: string;
  factsHash: string;
  factsVersion: string;
  source: RevisionSource;
  principalId: PrincipalId;
  seq: number;
  createdAt: Date;
}

export interface NewRevision extends Omit<RevisionRecord, 'createdAt'> {
  xml: Uint8Array;
  processes: ProcessInfo[];
  messageFlows: MessageFlowInfo[];
}

/** Facts of one revision, as stored. */
export interface RevisionFactsRecord {
  modelKey: string;
  factsVersion: string;
  processes: ProcessInfo[];
  facts: Fact[];
  messageFlows: MessageFlowInfo[];
}

export interface RelationRecord {
  id: RelationId;
  projectId: ProjectId;
  type: RelationType;
  fromRef: Ref;
  toRef: Ref;
  status: RelationStatus;
  endpointState: EndpointState;
  tier: Tier;
  confidence: number | null;
  version: number;
  attrs: Record<string, unknown>;
  /** Endpoint fingerprints of the assertion the status rests on. */
  fromFp: string | null;
  toFp: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AssertionKind = 'proposal' | 'withdrawal' | 'decision';
export type Verdict = 'accept' | 'reject' | 'hold';

export interface AssertionRecord {
  id: string;
  projectId: ProjectId;
  relationId: RelationId;
  seq: number;
  kind: AssertionKind;
  verdict: Verdict | null;
  sourceKind: SourceKind;
  principalId: PrincipalId;
  clientId: string | null;
  tier: Tier | null;
  confidence: number | null;
  rationale: string | null;
  fromFp: string | null;
  toFp: string | null;
}

export type TaskState = 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';

export interface TaskRecord {
  id: AnalysisTaskId;
  projectId: ProjectId;
  modelId: ModelId;
  revisionId: RevisionId;
  kind: 'relations';
  factsHash: string;
  state: TaskState;
  /** Seq of the `analysis.queued` event; orders a model's tasks. */
  seq: number;
}

export interface EventInput {
  type: string;
  principalId: PrincipalId;
  clientId: string | null;
  subjectRef: string | null;
  payload: Record<string, unknown>;
}

export interface EventRecord extends EventInput {
  projectId: ProjectId;
  seq: number;
  at: Date;
}

export interface RelationFilter {
  type?: RelationType | undefined;
  status?: RelationStatus | undefined;
  tier?: Tier | undefined;
  /** Relations with an endpoint in this model. */
  modelKey?: string | undefined;
  /** Without a `status` filter, obsolete relations are left out unless this is set. */
  includeObsolete?: boolean;
}

export interface HeadFactFilter {
  kinds?: readonly FactKind[];
  keyNorm?: string;
  /** `key_norm` without word separators equals this (the rule tier's `nameKey`). */
  nameKey?: string;
  keyRaw?: string;
  modelKey?: string;
  processId?: string;
}

/** A head fact plus the name of the process it belongs to. */
export interface HeadFact extends Fact {
  processName: string | null;
}

// ------------------------------------------------------------ repositories

export interface ProjectRepo {
  /** `null` if the key is taken. */
  insert(p: { id: ProjectId; key: string; name: string }): Promise<ProjectRecord | null>;
  /** By id (`prj_…`) or key. Not scoped: callers go through `policy.require`. */
  findByRef(idOrKey: string): Promise<ProjectRecord | null>;
  /** Projects the principal is a member of, ordered by key. */
  listForPrincipal(
    principalId: PrincipalId,
    page: { afterKey?: string | undefined; limit: number },
  ): Promise<(ProjectRecord & { role: Role })[]>;
  /** `SELECT … FOR UPDATE`: serializes writers of one project. */
  lockForWrite(projectId: ProjectId): Promise<ProjectRecord>;
}

export interface PrincipalRepo {
  /** Finds or creates the principal with this `(iss, kind, subject)`. */
  ensure(identity: Omit<PrincipalRecord, 'id'>): Promise<PrincipalRecord>;
  insert(p: PrincipalRecord): Promise<void>;
}

export interface MembershipRepo {
  roleOf(projectId: ProjectId, principalId: PrincipalId): Promise<Role | null>;
  insert(projectId: ProjectId, principalId: PrincipalId, role: Role): Promise<void>;
}

export interface AgentTokenRepo {
  insert(token: AgentTokenRecord & { secretHash: string }): Promise<void>;
  listInProject(projectId: ProjectId): Promise<AgentTokenRecord[]>;
  findInProject(projectId: ProjectId, id: AgentTokenId): Promise<AgentTokenRecord | null>;
  revoke(projectId: ProjectId, id: AgentTokenId, at: Date): Promise<void>;
  /** The token with this secret hash and the handle of its principal. */
  findBySecretHash(hash: string): Promise<(AgentTokenRecord & { handle: string }) | null>;
  /** Sets `last_used_at = at` unless it was set less than `minIntervalMs` before. */
  touch(id: AgentTokenId, at: Date, minIntervalMs: number): Promise<void>;
}

export interface ModelRepo {
  /** A live (not deleted) model. */
  findInProject(projectId: ProjectId, id: ModelId): Promise<ModelRecord | null>;
  /** By key, deleted models included (an upload revives them). */
  findByKey(projectId: ProjectId, key: string): Promise<ModelRecord | null>;
  insert(m: { id: ModelId; projectId: ProjectId; key: string; name: string | null }): Promise<void>;
  update(
    projectId: ProjectId,
    id: ModelId,
    patch: { name?: string | null; headRevisionId?: RevisionId; deletedSeq?: number | null },
  ): Promise<void>;
  /** Live models with head and stage, ordered by key. */
  list(
    projectId: ProjectId,
    page: { stage?: ModelStage | undefined; afterKey?: string | undefined; limit: number },
  ): Promise<ModelView[]>;
  view(projectId: ProjectId, id: ModelId): Promise<ModelView | null>;
  viewByKey(projectId: ProjectId, key: string): Promise<ModelView | null>;
}

export interface RevisionRepo {
  insert(r: NewRevision): Promise<void>;
  findInProject(
    projectId: ProjectId,
    modelId: ModelId,
    id: RevisionId,
  ): Promise<RevisionRecord | null>;
  /** Newest first. */
  listForModel(
    projectId: ProjectId,
    modelId: ModelId,
    page: { beforeRev?: number | undefined; limit: number },
  ): Promise<RevisionRecord[]>;
  content(projectId: ProjectId, modelId: ModelId, id: RevisionId): Promise<Uint8Array | null>;
  facts(
    projectId: ProjectId,
    modelId: ModelId,
    id: RevisionId,
  ): Promise<RevisionFactsRecord | null>;
  maxRev(projectId: ProjectId, modelId: ModelId): Promise<number>;
}

export interface FactRepo {
  insertMany(projectId: ProjectId, revisionId: RevisionId, facts: readonly Fact[]): Promise<void>;
  /** Facts of the head revisions of live models. */
  head(projectId: ProjectId, filter?: HeadFactFilter): Promise<HeadFact[]>;
  /** Input of `runRules`: head facts per live model, ordered by model key. */
  headProjectFacts(projectId: ProjectId): Promise<ProjectFacts>;
}

export interface RelationRepo {
  all(projectId: ProjectId): Promise<RelationRecord[]>;
  findInProject(projectId: ProjectId, id: RelationId): Promise<RelationRecord | null>;
  insert(r: Omit<RelationRecord, 'createdAt' | 'updatedAt'>): Promise<void>;
  update(
    projectId: ProjectId,
    id: RelationId,
    patch: Partial<
      Pick<
        RelationRecord,
        'status' | 'endpointState' | 'tier' | 'confidence' | 'attrs' | 'fromFp' | 'toFp'
      >
    >,
  ): Promise<void>;
  /** Ordered by `(type, from, to)`. */
  list(
    projectId: ProjectId,
    filter: RelationFilter,
    page: { after?: readonly [string, string, string] | undefined; limit: number },
  ): Promise<RelationRecord[]>;
}

export interface AssertionRepo {
  insert(a: AssertionRecord): Promise<void>;
  /** All assertions of the project, ordered by seq. */
  listForProject(projectId: ProjectId): Promise<AssertionRecord[]>;
}

export interface TaskRepo {
  /** The model's latest task (by seq) among `states`. */
  latest(
    projectId: ProjectId,
    modelId: ModelId,
    states: readonly TaskState[],
  ): Promise<TaskRecord | null>;
  insert(t: TaskRecord): Promise<void>;
  setState(projectId: ProjectId, id: AnalysisTaskId, state: TaskState): Promise<void>;
}

export interface FindingRepo {
  replace(projectId: ProjectId, findings: readonly Finding[]): Promise<void>;
  list(projectId: ProjectId): Promise<Finding[]>;
}

export interface EventRepo {
  /** Allocates the next seq (`UPDATE project SET last_seq = last_seq + 1 RETURNING`) and appends. */
  append(projectId: ProjectId, event: EventInput): Promise<number>;
  list(projectId: ProjectId, page: { afterSeq: number; limit: number }): Promise<EventRecord[]>;
}

/** Repositories bound to one transaction. */
export interface Tx {
  projects: ProjectRepo;
  principals: PrincipalRepo;
  memberships: MembershipRepo;
  agentTokens: AgentTokenRepo;
  models: ModelRepo;
  revisions: RevisionRepo;
  facts: FactRepo;
  relations: RelationRepo;
  assertions: AssertionRepo;
  tasks: TaskRepo;
  findings: FindingRepo;
  events: EventRepo;
}

export interface Store {
  /** A read-only snapshot (REPEATABLE READ): every read sees one state. */
  read<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** One read-write transaction; rolled back if `fn` throws. */
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

// ------------------------------------------------------- analysis (libraries)

/** Facts of one file, as the extractor returns them. */
export interface Extracted {
  factsVersion: string;
  processes: ProcessInfo[];
  facts: Fact[];
  messageFlows: MessageFlowInfo[];
}

/** Why a file was rejected (BpmnInputError codes of `@proa/bpmn-facts`). */
export type ExtractFailure = { code: string; message: string };

export type ExtractOutcome = { ok: true; value: Extracted } | { ok: false; error: ExtractFailure };

/** Output of the rule tier. */
export interface RuleOutput {
  relations: DerivedRelation[];
  findings: Finding[];
}

/**
 * The deterministic libraries (CONCEPT §7): fact extraction and the rule
 * tier. Rejections of hostile or malformed input come back as values; any
 * other error is a bug and propagates.
 */
export interface AnalysisPort {
  extract(xml: Uint8Array, modelKey: string): Promise<ExtractOutcome>;
  factsHash(facts: readonly Fact[]): string;
  runRules(projectFacts: ProjectFacts): RuleOutput;
}

export interface Clock {
  now(): Date;
}
