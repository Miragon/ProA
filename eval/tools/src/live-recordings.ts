// eval:live's source (CONCEPT §7): the submissions a live project stored,
// read over REST, and their mapping to proa-recording/1 lines.
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
  RECORDING_FORMAT,
  RecordingLine,
  RevisionPage,
  SubmitAnalysisBody,
  recordingPath,
} from '@proa/contracts';
import type { z } from 'zod';

/** `PROA_URL` default, as the `proa` CLI has it. */
export const DEFAULT_PROA_URL = 'http://127.0.0.1:7400';

/** A stored payload: the submission body without the lease token. */
const StoredPayload = SubmitAnalysisBody.omit({ leaseToken: true });

/** A failure reading or mapping a live project; the message names the request or task. */
export class LiveSourceError extends Error {
  override readonly name = 'LiveSourceError';
}

/** One done analysis task: its model, the analysed revision number and the stored submission. */
export interface StoredAnalysis {
  modelKey: string;
  rev: number;
  submission: AnalysisSubmission;
}

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
 * Reads every `done` analysis task of the project with its stored
 * submission (`GET …/analyses?state=done`, `GET …/analyses/{a}/submission`)
 * and the revision number of the analysed revision (`GET
 * …/models/{m}/revisions`, once per model).
 *
 * @throws {LiveSourceError} if the server cannot be reached or answers with an error
 */
export async function fetchStoredAnalyses(source: LiveSource): Promise<StoredAnalysis[]> {
  const project = `/projects/${encodeURIComponent(source.project)}`;
  const tasks = await allPages(source, `${project}/analyses`, { state: 'done' }, AnalysisTaskPage);
  const revs = new Map<string, Map<string, number>>();
  const out: StoredAnalysis[] = [];
  for (const task of tasks) {
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
    out.push({ modelKey: task.modelKey, rev, submission });
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
 * One recording line from a stored submission (pure): the declared
 * procedure and model, the payload normalized like the recorder writes it
 * (defaults applied, stable key order), the result per item without ids.
 *
 * @throws {LiveSourceError} if the payload is no submission or the line no `proa-recording/1` line
 */
export function recordingLineOf(stored: StoredAnalysis, options: LineOptions): RecordingLine {
  const s = stored.submission;
  const payload = StoredPayload.safeParse(s.payload);
  if (!payload.success) {
    const issue = payload.error.issues[0];
    throw new LiveSourceError(
      `task ${s.taskId}: the stored payload is no submission (${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''})`,
    );
  }
  const body = payload.data;
  const { counts, noLinks, uncovered } = s.result;
  const line: RecordingLine = {
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
      replayed: s.result.replayed,
      counts: {
        applied: counts.applied,
        duplicate: counts.duplicate,
        suppressed: counts.suppressed,
        reopened: counts.reopened,
        invalid: counts.invalid,
      },
      withdrawn: s.result.withdrawn,
      items: s.result.items.map((i) => ({ index: i.index, result: i.result, status: i.status })),
      // Results since no-links are validated (proa-relations@0.2.0); older stored results have none.
      ...(noLinks
        ? {
            noLinks: {
              items: noLinks.items.map((i) => ({ index: i.index, result: i.result })),
              counts: { stored: noLinks.counts.stored, duplicate: noLinks.counts.duplicate, invalid: noLinks.counts.invalid },
            },
          }
        : {}),
      ...(s.result.withdrawnNoLinks !== undefined ? { withdrawnNoLinks: s.result.withdrawnNoLinks } : {}),
      ...(uncovered ? { uncovered: { count: uncovered.count } } : {}),
    },
  };
  const valid = RecordingLine.safeParse(line);
  if (!valid.success) {
    const issue = valid.error.issues[0];
    throw new LiveSourceError(
      `task ${s.taskId}: no proa-recording/1 line (${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''})`,
    );
  }
  return line;
}

export interface BuiltRecording {
  /** `<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl` below the recordings directory. */
  path: string;
  lines: RecordingLine[];
  /** The JSONL file: one line each, newline-terminated. */
  text: string;
}

/**
 * The recordings of a live project (pure): one line per stored submission,
 * sorted by model key, then submission time, grouped into files by
 * `recordingPath` (procedure, agent, declared model, landscape), sorted by
 * path.
 */
export function buildRecordings(stored: readonly StoredAnalysis[], options: LineOptions): BuiltRecording[] {
  const sorted = [...stored].sort(
    (a, b) =>
      cmp(a.modelKey, b.modelKey) ||
      cmp(a.submission.createdAt, b.submission.createdAt) ||
      cmp(a.submission.taskId, b.submission.taskId),
  );
  const files = new Map<string, RecordingLine[]>();
  for (const s of sorted) {
    const line = recordingLineOf(s, options);
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
