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
  AssertionId,
  AssertionKind,
  Candidate,
  DeclaredProcedure,
  DerivedRelation,
  Engine,
  EndpointState,
  Fact,
  FactKind,
  Finding,
  MessageFlowInfo,
  ModelId,
  ModelStage,
  NoLinkId,
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
  SubmissionId,
  SubmissionResult,
  Tier,
  TypedPair,
  Verdict,
} from '@proa/contracts';
import type { PairAssessment, PairQuery } from '@proa/relations';

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
  engine: Engine | null;
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
  engine: Engine | null;
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

export type { AssertionKind, Verdict };

/** Procedure and LLM model an agent declares (CONCEPT §6: declared, never verified). */
export interface Declared {
  procedure: DeclaredProcedure | null;
  llmModel: string | null;
}

export interface AssertionRecord {
  id: AssertionId;
  projectId: ProjectId;
  relationId: RelationId;
  seq: number;
  kind: AssertionKind;
  verdict: Verdict | null;
  sourceKind: SourceKind;
  principalId: PrincipalId;
  clientId: string | null;
  declared: Declared | null;
  /** The stored submission (pipeline proposals, their supersession). */
  submissionId: SubmissionId | null;
  tier: Tier | null;
  confidence: number | null;
  rationale: string | null;
  evidence: string[] | null;
  question: string | null;
  label: string | null;
  linkedRelationId: RelationId | null;
  fromFp: string | null;
  toFp: string | null;
  /**
   * Basis of a pipeline proposal (judge each pair once): the `facts_hash` of
   * each endpoint's model as the judging agent saw it; `null` otherwise.
   */
  fromHash: string | null;
  toHash: string | null;
}

/** An assertion as read back: with the principal's handle and the time it was recorded. */
export interface StoredAssertion extends AssertionRecord {
  handle: string;
  createdAt: Date;
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

/** A task with its lease (CONCEPT §3 "Claim and lease"). */
export interface TaskDetail extends TaskRecord {
  modelKey: string;
  attempts: number;
  /** sha256 of `taskId|principalId|token`; null while queued. */
  leaseTokenHash: string | null;
  claimedBy: PrincipalId | null;
  claimedByHandle: string | null;
  leaseUntil: Date | null;
  lastError: string | null;
  /** Client-chosen id of the stored submission. */
  submissionId: string | null;
  /** Seq of the latest `analysis.claimed` event: the state the claim input shows. */
  claimedSeq: number | null;
  /**
   * The typed pairs the latest claim must judge; `null` before the first
   * claim and after a release or cancel; kept when the task fails, so a late
   * submit reports `uncovered`.
   */
  assignment: TypedPair[] | null;
  /** A judgement the claim relied on was withdrawn: the submit queues a follow-up. */
  requeueAfter: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskFilter {
  state?: TaskState | undefined;
  modelKey?: string | undefined;
}

export interface ClaimQuery {
  projectIds: readonly ProjectId[];
  modelKey?: string | undefined;
  principalId: PrincipalId;
  now: Date;
  leaseUntil: Date;
  maxAttempts: number;
  limit: number;
}

export interface SubmissionRecord {
  id: SubmissionId;
  projectId: ProjectId;
  taskId: AnalysisTaskId;
  clientSubmissionId: string;
  principalId: PrincipalId;
  clientId: string | null;
  declared: { procedure: DeclaredProcedure; llmModel: string | null };
  /** The request body as received, minus the lease token. */
  payload: Record<string, unknown>;
  result: SubmissionResult;
  seq: number;
}

export interface StoredSubmission extends SubmissionRecord {
  handle: string;
  createdAt: Date;
}

/** A no-link as stored (judge each pair once): an agent's judgement that a typed pair is unrelated. */
export interface NoLinkRecord {
  id: NoLinkId;
  projectId: ProjectId;
  type: TypedPair['type'];
  fromRef: Ref;
  toRef: Ref;
  fromModel: string;
  toModel: string;
  /** Basis: the `facts_hash` of each endpoint's model as the judging agent saw it. */
  fromHash: string;
  toHash: string;
  reason: string;
  sourceKind: Exclude<SourceKind, 'rule'>;
  principalId: PrincipalId;
  clientId: string | null;
  declared: { procedure: DeclaredProcedure; llmModel: string | null };
  submissionId: SubmissionId;
  /** The analysed model (origin). */
  modelId: ModelId;
  /** Seq of the submission's `analysis.done` event. */
  seq: number;
}

/** A live no-link as read back. */
export interface StoredNoLink extends NoLinkRecord {
  handle: string;
  /** Key of the origin model. */
  origin: string;
  /**
   * Both basis hashes equal the head `facts_hash` of the endpoint models (a
   * deleted model has none) and the declared procedure is the one asked for.
   */
  current: boolean;
  createdAt: Date;
}

export interface NoLinkFilter {
  /** No-links with an endpoint in this model. */
  touchingModelKey?: string;
  principalId?: PrincipalId;
  /** No-links on these typed pairs. */
  pairs?: readonly TypedPair[];
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
  /** `facts_hash` of the head revision of every live model, by model key. */
  headHashes(projectId: ProjectId): Promise<Map<string, string>>;
  /**
   * `facts_hash` of the revision of each model that was its head at event
   * `seq` (the latest revision with a seq ≤ `seq`, unless the model was
   * deleted after it and not revived by `seq`), by model key; models without
   * one are missing.
   */
  hashesAt(
    projectId: ProjectId,
    modelKeys: readonly string[],
    seq: number,
  ): Promise<Map<string, string>>;
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
  /** Inserts and returns the stored row (timestamps from the database). */
  insert(r: Omit<RelationRecord, 'createdAt' | 'updatedAt'>): Promise<RelationRecord>;
  /** Applies the patch, increments `version`, sets `updated_at`; returns the stored row. */
  update(
    projectId: ProjectId,
    id: RelationId,
    patch: Partial<
      Pick<
        RelationRecord,
        'status' | 'endpointState' | 'tier' | 'confidence' | 'attrs' | 'fromFp' | 'toFp'
      >
    >,
  ): Promise<RelationRecord>;
  /** `SELECT … FOR UPDATE` of one relation in the project. */
  lock(projectId: ProjectId, id: RelationId): Promise<RelationRecord | null>;
  findByNaturalKey(
    projectId: ProjectId,
    type: RelationType,
    from: string,
    to: string,
  ): Promise<RelationRecord | null>;
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
  listForProject(projectId: ProjectId): Promise<StoredAssertion[]>;
  /** The assertions of these relations, ordered by seq. */
  listForRelations(projectId: ProjectId, ids: readonly RelationId[]): Promise<StoredAssertion[]>;
}

export interface TaskRepo {
  /** The model's latest task (by seq) among `states`. */
  latest(
    projectId: ProjectId,
    modelId: ModelId,
    states: readonly TaskState[],
  ): Promise<TaskRecord | null>;
  insert(t: TaskRecord): Promise<void>;
  /** `cancelled` also clears the assignment. */
  setState(
    projectId: ProjectId,
    id: AnalysisTaskId,
    state: TaskState,
    lastError?: string,
  ): Promise<void>;
  /** The project of a task id; not scoped: callers go through `policy.require` next. */
  projectOf(id: AnalysisTaskId): Promise<ProjectId | null>;
  /** One task with its lease; `forUpdate` locks the row. */
  findInProject(
    projectId: ProjectId,
    id: AnalysisTaskId,
    options?: { forUpdate?: boolean },
  ): Promise<TaskDetail | null>;
  /** Newest first (by seq). */
  list(
    projectId: ProjectId,
    filter: TaskFilter,
    page: { beforeSeq?: number | undefined; limit: number },
  ): Promise<TaskDetail[]>;
  /** Whether a claimed task's lease expired at the last attempt (see {@link failExpired}). */
  hasExpired(projectIds: readonly ProjectId[], now: Date, maxAttempts: number): Promise<boolean>;
  /**
   * Claimed tasks whose lease expired at the last attempt become `failed`.
   * The assignment stays: a late submit of the holder reports `uncovered`
   * from it.
   */
  failExpired(
    projectIds: readonly ProjectId[],
    now: Date,
    maxAttempts: number,
    reason: string,
  ): Promise<TaskDetail[]>;
  /**
   * One `UPDATE … WHERE id IN (SELECT … ORDER BY created_at FOR UPDATE SKIP
   * LOCKED LIMIT n)` over queued tasks and expired leases with attempts
   * left: sets the lease and `attempts + 1`. The lease token hash is set
   * per task afterwards ({@link setLeaseHash}).
   */
  claim(q: ClaimQuery): Promise<TaskDetail[]>;
  setLeaseHash(projectId: ProjectId, id: AnalysisTaskId, hash: string): Promise<void>;
  /** Stores the seq of the claim's `analysis.claimed` event. */
  setClaimedSeq(projectId: ProjectId, id: AnalysisTaskId, seq: number): Promise<void>;
  /** Stores the pairs the claim must judge. */
  setAssignment(
    projectId: ProjectId,
    id: AnalysisTaskId,
    pairs: readonly TypedPair[],
  ): Promise<void>;
  setRequeueAfter(projectId: ProjectId, id: AnalysisTaskId): Promise<void>;
  /** Back to `queued`; the attempt is given back, assignment and `requeueAfter` are cleared. */
  release(projectId: ProjectId, id: AnalysisTaskId, reason: string | null): Promise<void>;
  /** Claimable tasks per project: queued, or claimed with an expired lease and attempts left. */
  countClaimable(
    projectIds: readonly ProjectId[],
    now: Date,
    maxAttempts: number,
  ): Promise<Map<ProjectId, number>>;
}

export interface SubmissionRepo {
  insert(s: SubmissionRecord): Promise<void>;
  findByTask(projectId: ProjectId, taskId: AnalysisTaskId): Promise<StoredSubmission | null>;
  /** The analysed model (key) of every stored submission: the origin of its proposals. */
  originModels(projectId: ProjectId): Promise<Map<SubmissionId, string>>;
}

export interface NoLinkRepo {
  insertMany(rows: readonly NoLinkRecord[]): Promise<void>;
  /**
   * Live no-links (without a withdrawal), oldest first, with `current`
   * computed in SQL against the head revisions and `procedure`.
   */
  listLive(
    projectId: ProjectId,
    filter: NoLinkFilter,
    procedure: DeclaredProcedure,
  ): Promise<StoredNoLink[]>;
  /** Ends live no-links (one withdrawal row each). */
  withdraw(
    projectId: ProjectId,
    ids: readonly NoLinkId[],
    by: { seq: number; principalId: PrincipalId; reason: string },
  ): Promise<void>;
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
  submissions: SubmissionRepo;
  noLinks: NoLinkRepo;
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
  engine: Engine | null;
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
  /** Candidate pairs around one model, both directions (claim input, CONCEPT §3). */
  candidates(projectFacts: ProjectFacts, focusModelKey: string): Candidate[];
  /** Validates proposed pairs against the head facts and computes their tier. */
  pairAssessor(projectFacts: ProjectFacts): (pair: PairQuery) => PairAssessment;
}

export type { PairAssessment, PairQuery };

/** A subscription to "work was queued" in some projects (LISTEN/NOTIFY). */
export interface WorkSubscription {
  /**
   * Resolves `true` when a task is queued in one of the projects, `false`
   * after `timeoutMs` or when `signal` aborts. Call {@link close} afterwards.
   */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  close(): void;
}

export interface Notifier {
  /**
   * Subscribes before the caller counts, so no wake-up is lost in between.
   * `owner` (the caller's principal) bounds the concurrent waits of one
   * caller, so one credential cannot take every waiting slot.
   */
  subscribe(projectIds: readonly ProjectId[], owner: string): Promise<WorkSubscription>;
}

export interface Clock {
  now(): Date;
}
