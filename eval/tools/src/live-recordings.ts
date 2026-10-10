// eval:live's source (CONCEPT §7): the submissions a live project stored,
// read over REST, and their mapping to proa-recording/1 lines, for both task
// kinds: a relations line per model task, a placement line (M4 §8) per value
// chain task, with the chain revision's number and content hash from the
// chain's revision listing.
//
// The server stores each submission as received minus the lease token (with
// U+0000 as U+FFFD): over REST the raw body, without defaults; over MCP the
// tool arguments as parsed, with defaults. It keeps no claim input, so a
// line built here has none. Per line: outcome `submitted`, the server's
// result without task and submission id (the no-link outcomes, withdrawn
// no-links and the uncovered count where the server answered them), no relation
// ids and no task ids (like `--no-record-ids`), so building again from the
// same project gives the same bytes. The mapping matches the simulation
// agent's recorder (apps/agent-sim/src/recorder.ts) key for key.
import {
  API_PREFIX,
  AnalysisSubmission,
  AnalysisTaskPage,
  MAX_PAGE_LIMIT,
  PlacementRecordingLine,
  RECORDING_FORMAT,
  RelationRecordingLine,
  RevisionPage,
  SubmitAnalysisBody,
  ValueChainRevisionPage,
  recordingPath,
  type RecordingLine,
} from '@proa/contracts';
import type { z } from 'zod';

/** `PROA_URL` default, as the `proa` CLI has it. */
export const DEFAULT_PROA_URL = 'http://127.0.0.1:7400';

/**
 * A stored payload of a relations task: the submission body without the lease
 * token. Over REST the server stores the raw body, so a submission that only
 * sends `noLinks` has no `relations`: the contract's default (`[]`, M4b) fills
 * it in, as the server's own parse did.
 */
const StoredPayload = SubmitAnalysisBody.omit({ leaseToken: true });

/** A failure reading or mapping a live project; the message names the request or task. */
export class LiveSourceError extends Error {
  override readonly name = 'LiveSourceError';
}

/** A done relations task: its model, the analysed revision number and the stored submission. */
export interface StoredAnalysis {
  kind?: 'relations';
  modelKey: string;
  rev: number;
  submission: AnalysisSubmission;
}

/** A done placement task (M4b): the chain revision its claim showed and the stored submission. */
export interface StoredPlacementAnalysis {
  kind: 'placement';
  valueChain: { key: string; rev: number; contentHash: string };
  submission: AnalysisSubmission;
}

/** One done analysis task of either kind. */
export type StoredTask = StoredAnalysis | StoredPlacementAnalysis;

/** Whether a stored task is a placement task. */
export const isStoredPlacement = (s: StoredTask): s is StoredPlacementAnalysis => s.kind === 'placement';

/** The recording line a stored task gives. */
export type LineOf<T extends StoredTask> = T extends StoredPlacementAnalysis ? PlacementRecordingLine : RelationRecordingLine;

export interface LiveSource {
  /** Server base URL, e.g. {@link DEFAULT_PROA_URL}. */
  url: string;
  /** Bearer token: an agent token of the project (`proa:read`) or the owner key (`proa_ok_…`). */
  token: string;
  /** Project key or id. */
  project: string;
  /** Default: the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

async function getJson<T extends z.ZodType>(source: LiveSource, path: string, schema: T): Promise<z.infer<T>> {
  const url = `${source.url.replace(/\/+$/, '')}${API_PREFIX}${path}`;
  let res: Response;
  try {
    res = await (source.fetch ?? globalThis.fetch)(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${source.token}` },
    });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    throw new LiveSourceError(`cannot reach ProA at ${source.url} (${err instanceof Error ? err.message : String(err)}${cause})`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new LiveSourceError(`GET ${path}: ${res.status}, not JSON`);
  }
  if (!res.ok) {
    const problem = body as { code?: unknown; detail?: unknown; title?: unknown };
    const what = typeof problem.code === 'string' ? problem.code : typeof problem.title === 'string' ? problem.title : '';
    const detail = typeof problem.detail === 'string' ? `: ${problem.detail}` : '';
    throw new LiveSourceError(`GET ${path}: ${res.status} ${what}${detail}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new LiveSourceError(`GET ${path}: unexpected answer (${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''})`);
  }
  return parsed.data;
}

/** Every page of a paginated list. */
async function allPages<I>(
  source: LiveSource,
  path: string,
  query: Record<string, string>,
  schema: z.ZodType<{ items: I[]; nextCursor: string | null }>,
): Promise<I[]> {
  const items: I[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ ...query, limit: String(MAX_PAGE_LIMIT) });
    if (cursor !== null) q.set('cursor', cursor);
    const page: { items: I[]; nextCursor: string | null } = await getJson(source, `${path}?${q.toString()}`, schema);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/**
 * Reads every `done` analysis task of the project, both kinds, with its
 * stored submission (`GET …/analyses?state=done`, `GET
 * …/analyses/{a}/submission`): for a relations task the revision number of
 * the analysed revision (`GET …/models/{m}/revisions`, once per model), for a
 * placement task the number and content hash of the chain revision its claim
 * showed (`valueChainRevisionId` in `GET …/value-chains/{key}/revisions`, once
 * per chain).
 *
 * @throws {LiveSourceError} if the server cannot be reached or answers with an error
 */
export async function fetchStoredAnalyses(source: LiveSource): Promise<StoredTask[]> {
  const project = `/projects/${encodeURIComponent(source.project)}`;
  const tasks = await allPages(source, `${project}/analyses`, { state: 'done' }, AnalysisTaskPage);
  const revs = new Map<string, Map<string, number>>();
  const chainRevs = new Map<string, Map<string, { rev: number; contentHash: string }>>();
  const out: StoredTask[] = [];
  for (const task of tasks) {
    if (task.kind === 'placement') {
      if (task.valueChainKey === null || task.valueChainRevisionId === null) {
        throw new LiveSourceError(`task ${task.id}: a placement task without its value chain revision`);
      }
      const submission = await getJson(source, `${project}/analyses/${encodeURIComponent(task.id)}/submission`, AnalysisSubmission);
      let byId = chainRevs.get(task.valueChainKey);
      if (!byId) {
        const revisions = await allPages(
          source,
          `${project}/value-chains/${encodeURIComponent(task.valueChainKey)}/revisions`,
          {},
          ValueChainRevisionPage,
        );
        byId = new Map(revisions.map((r) => [r.id, { rev: r.rev, contentHash: r.contentHash }]));
        chainRevs.set(task.valueChainKey, byId);
      }
      const revision = byId.get(task.valueChainRevisionId);
      if (revision === undefined) {
        throw new LiveSourceError(
          `task ${task.id}: revision ${task.valueChainRevisionId} of value chain ${task.valueChainKey} not found`,
        );
      }
      out.push({ kind: 'placement', valueChain: { key: task.valueChainKey, ...revision }, submission });
      continue;
    }
    if (task.modelId === null || task.modelKey === null || task.revisionId === null) continue;
    const submission = await getJson(source, `${project}/analyses/${encodeURIComponent(task.id)}/submission`, AnalysisSubmission);
    let byId = revs.get(task.modelId);
    if (!byId) {
      const revisions = await allPages(source, `${project}/models/${encodeURIComponent(task.modelId)}/revisions`, {}, RevisionPage);
      byId = new Map(revisions.map((r) => [r.id, r.rev]));
      revs.set(task.modelId, byId);
    }
    const rev = byId.get(task.revisionId);
    if (rev === undefined) {
      throw new LiveSourceError(`task ${task.id}: revision ${task.revisionId} of ${task.modelKey} not found`);
    }
    out.push({ kind: 'relations', modelKey: task.modelKey, rev, submission });
  }
  return out;
}

/** The agent of a stored submission: the token name of the handle `agent:<name>`, else the handle. */
export function agentOf(handle: string): string {
  return handle.startsWith('agent:') ? handle.slice('agent:'.length) : handle;
}

export interface LineOptions {
  /** The corpus landscape the project was seeded from (`sample` for `_sample`). */
  landscape: string;
  /** Agent name for every line instead of the one from the handle. */
  agent?: string;
}

/**
 * A stored payload of a placement task: the submission body without the
 * lease token (`placements` and `unsure` as sent; absent ones are empty).
 */
const StoredPlacementPayload = SubmitAnalysisBody.omit({ leaseToken: true });

/** The first issue of a failed parse, as `path: message`. */
function issueOf(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  return `${issue?.path.map(String).join('.') ?? ''}: ${issue?.message ?? ''}`;
}

/**
 * One placement recording line from a stored submission (pure), as the
 * simulation agent's recorder writes it with `--no-record-ids`: the chain
 * revision, the declared procedure and model, the payload normalized
 * (defaults applied, stable key order), the result per item without ids,
 * `skipped` as its count.
 *
 * @throws {LiveSourceError} if the payload or result is no placement submission, or the line no `proa-recording/1` line
 */
export function placementLineOf(stored: StoredPlacementAnalysis, options: LineOptions): PlacementRecordingLine {
  const s = stored.submission;
  const result = s.result;
  if (!('kind' in result)) throw new LiveSourceError(`task ${s.taskId}: a relations submission is no placement line`);
  const payload = StoredPlacementPayload.safeParse(s.payload);
  if (!payload.success) {
    throw new LiveSourceError(`task ${s.taskId}: the stored payload is no submission (${issueOf(payload.error)})`);
  }
  const body = payload.data;
  const { placements, unsure } = result;
  const line: PlacementRecordingLine = {
    format: RECORDING_FORMAT,
    kind: 'placement',
    landscape: options.landscape,
    valueChain: { key: stored.valueChain.key, rev: stored.valueChain.rev, contentHash: stored.valueChain.contentHash },
    agent: options.agent ?? agentOf(s.handle),
    procedure: { id: s.procedure.id, version: s.procedure.version },
    llmModel: s.llmModel,
    submission: {
      placements: (body.placements ?? []).map((p) => ({
        step: p.step,
        process: p.process,
        confidence: p.confidence,
        rationale: p.rationale,
        evidence: p.evidence,
        question: p.question,
      })),
      unsure: (body.unsure ?? []).map((u) => ({ process: u.process, reason: u.reason })),
      summary: body.summary,
      costUsd: body.costUsd,
    },
    outcome: 'submitted',
    result: {
      replayed: result.replayed,
      counts: {
        applied: placements.counts.applied,
        duplicate: placements.counts.duplicate,
        suppressed: placements.counts.suppressed,
        reopened: placements.counts.reopened,
        invalid: placements.counts.invalid,
      },
      withdrawn: result.withdrawn,
      items: placements.items.map((i) => ({ index: i.index, result: i.result, status: i.status })),
      unsure: {
        items: unsure.items.map((i) => ({ index: i.index, result: i.result })),
        counts: { stored: unsure.counts.stored, duplicate: unsure.counts.duplicate, invalid: unsure.counts.invalid },
      },
      skipped: { count: result.skipped.count },
      followUp: result.followUp,
    },
  };
  const valid = PlacementRecordingLine.safeParse(line);
  if (!valid.success) {
    throw new LiveSourceError(`task ${s.taskId}: no proa-recording/1 line (${issueOf(valid.error)})`);
  }
  return line;
}

/** The recording line of a stored task of either kind. */
export function lineOf<T extends StoredTask>(stored: T, options: LineOptions): LineOf<T> {
  return (isStoredPlacement(stored) ? placementLineOf(stored, options) : recordingLineOf(stored, options)) as LineOf<T>;
}

/**
 * One relations recording line from a stored submission (pure): the declared
 * procedure and model, the payload normalized like the recorder writes it
 * (defaults applied, stable key order), the result per item without ids.
 * A placement task gives its line through {@link placementLineOf}.
 *
 * @throws {LiveSourceError} if the payload is no submission or the line no `proa-recording/1` line
 */
export function recordingLineOf(stored: StoredAnalysis, options: LineOptions): RelationRecordingLine {
  const s = stored.submission;
  const result = s.result;
  if ('kind' in result) throw new LiveSourceError(`task ${s.taskId}: a ${result.kind} submission is no relations line`);
  const payload = StoredPayload.safeParse(s.payload);
  if (!payload.success) {
    const issue = payload.error.issues[0];
    throw new LiveSourceError(
      `task ${s.taskId}: the stored payload is no submission (${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''})`,
    );
  }
  const body = payload.data;
  const { counts, noLinks, uncovered } = result;
  const line: RelationRecordingLine = {
    format: RECORDING_FORMAT,
    landscape: options.landscape,
    modelKey: stored.modelKey,
    rev: stored.rev,
    agent: options.agent ?? agentOf(s.handle),
    procedure: { id: s.procedure.id, version: s.procedure.version },
    llmModel: s.llmModel,
    submission: {
      relations: body.relations.map((r) => ({
        type: r.type,
        from: r.from,
        to: r.to,
        confidence: r.confidence,
        rationale: r.rationale,
        evidence: r.evidence,
        question: r.question,
      })),
      noLinks: body.noLinks.map((n) => ({ ...(n.type !== undefined ? { type: n.type } : {}), from: n.from, to: n.to, reason: n.reason })),
      summary: body.summary,
      costUsd: body.costUsd,
    },
    outcome: 'submitted',
    result: {
      replayed: result.replayed,
      counts: {
        applied: counts.applied,
        duplicate: counts.duplicate,
        suppressed: counts.suppressed,
        reopened: counts.reopened,
        invalid: counts.invalid,
      },
      withdrawn: result.withdrawn,
      items: result.items.map((i) => ({ index: i.index, result: i.result, status: i.status })),
      // Results since no-links are validated (proa-relations@0.2.0); older stored results have none.
      ...(noLinks
        ? {
            noLinks: {
              items: noLinks.items.map((i) => ({ index: i.index, result: i.result })),
              counts: { stored: noLinks.counts.stored, duplicate: noLinks.counts.duplicate, invalid: noLinks.counts.invalid },
            },
          }
        : {}),
      ...(result.withdrawnNoLinks !== undefined ? { withdrawnNoLinks: result.withdrawnNoLinks } : {}),
      ...(uncovered ? { uncovered: { count: uncovered.count } } : {}),
    },
  };
  const valid = RelationRecordingLine.safeParse(line);
  if (!valid.success) {
    const issue = valid.error.issues[0];
    throw new LiveSourceError(
      `task ${s.taskId}: no proa-recording/1 line (${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''})`,
    );
  }
  return line;
}

export interface BuiltRecording<L extends RecordingLine = RecordingLine> {
  /** `<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl` below the recordings directory. */
  path: string;
  lines: L[];
  /** The JSONL file: one line each, newline-terminated. */
  text: string;
}

/** Relations tasks by model key, placement tasks (after them) by chain key. */
const subjectOf = (s: StoredTask): string => (isStoredPlacement(s) ? `\uffff${s.valueChain.key}` : s.modelKey);

/**
 * The recordings of a live project (pure): one line per stored submission,
 * sorted by model key (placement tasks by chain key), then submission time,
 * grouped into files by `recordingPath` (procedure, agent, declared model,
 * landscape), sorted by path.
 */
export function buildRecordings<T extends StoredTask>(
  stored: readonly T[],
  options: LineOptions,
): BuiltRecording<LineOf<T>>[] {
  const sorted = [...stored].sort(
    (a, b) =>
      cmp(subjectOf(a), subjectOf(b)) ||
      cmp(a.submission.createdAt, b.submission.createdAt) ||
      cmp(a.submission.taskId, b.submission.taskId),
  );
  const files = new Map<string, LineOf<T>[]>();
  for (const s of sorted) {
    const line = lineOf(s, options);
    const file = recordingPath(line);
    const lines = files.get(file);
    if (lines) lines.push(line);
    else files.set(file, [line]);
  }
  return [...files.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([file, lines]) => ({ path: file, lines, text: lines.map((l) => `${JSON.stringify(l)}\n`).join('') }));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
