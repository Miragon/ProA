import { createProaClient } from '@proa/client';
import type { ApiProblem } from '@proa/client';

import { PROBLEM_TYPE_BASE } from './limits';

/**
 * REST client of the web UI (CONCEPT §6, local mode).
 *
 * Same origin: in dev Vite proxies `/api`, `/mcp` and `/health` to the
 * server; in production the server serves the UI. The UI never holds a
 * token: it acts as the owner through the HttpOnly session cookie that
 * `POST /api/v1/session` sets. {@link sessionFetch} opens that session
 * before the first API request and renews it once when a request comes back
 * 401 (expired cookie, restarted server without `PROA_SESSION_SECRET`).
 */

const SESSION_PATH = '/api/v1/session';

/** The current (or last) `POST /session`; `null` before the first or after a failure. */
let session: Promise<void> | null = null;
/** Bumped with every `POST /session`, so parallel 401s renew only once. */
let generation = 0;

async function postSession(base: string): Promise<void> {
  const response = await globalThis.fetch(`${base}${SESSION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'proa-web' }),
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new ApiError(await problemOf(response), response.status);
  }
}

function openSession(base: string): Promise<void> {
  generation += 1;
  const current = postSession(base).catch((error: unknown) => {
    if (session === current) session = null;
    throw error;
  });
  session = current;
  return current;
}

/** `fetch` for the generated client: owner session first, one renewal on 401. */
export async function sessionFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === SESSION_PATH || !url.pathname.startsWith('/api/')) {
    return globalThis.fetch(request);
  }
  // A failed session request is not fatal here: the request itself reports the problem.
  await (session ?? openSession(url.origin)).catch(() => undefined);
  const seen = generation;
  const retry = request.clone();
  const response = await globalThis.fetch(request);
  if (response.status !== 401) return response;
  await (generation === seen ? openSession(url.origin) : (session ?? Promise.resolve())).catch(
    () => undefined,
  );
  return globalThis.fetch(retry);
}

/** For tests: forget the cached session state. */
export function resetSessionState(): void {
  session = null;
  generation = 0;
}

function origin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export const api = createProaClient({
  baseUrl: origin(),
  fetch: sessionFetch as typeof globalThis.fetch,
});

/** An RFC 9457 problem from the API, thrown by {@link unwrap}. */
export class ApiError extends Error {
  readonly problem: ApiProblem;
  readonly status: number;
  constructor(problem: ApiProblem, status: number) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.problem = problem;
    this.status = status;
  }
}

async function problemOf(response: Response): Promise<ApiProblem> {
  try {
    const body: unknown = await response.json();
    if (isProblem(body)) return body;
  } catch {
    // not JSON; fall through
  }
  return {
    type: `${PROBLEM_TYPE_BASE}internal`,
    title: response.statusText || 'Request failed',
    status: response.status,
    code: 'internal',
  };
}

function isProblem(value: unknown): value is ApiProblem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'title' in value &&
    'status' in value &&
    'code' in value
  );
}

interface SdkResult<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

/**
 * Turns a generated SDK call into a promise of its data; problems become
 * {@link ApiError}, network failures a plain error with a German message.
 */
export async function unwrap<T>(call: Promise<SdkResult<T>>): Promise<T> {
  const unreachable = (cause: unknown) =>
    new Error('Der ProA-Server ist nicht erreichbar. Läuft er (pnpm dev)?', { cause });
  let result: SdkResult<T>;
  try {
    result = await call;
  } catch (error) {
    throw error instanceof ApiError ? error : unreachable(error);
  }
  // The generated client reports network failures as an error without a response.
  if (result.response === undefined) throw unreachable(result.error);
  const status = result.response.status;
  if (result.error !== undefined || !result.response.ok) {
    if (isProblem(result.error)) throw new ApiError(result.error, status);
    throw new ApiError(
      {
        type: `${PROBLEM_TYPE_BASE}internal`,
        title: result.response.statusText || `HTTP ${status}`,
        status,
        code: 'internal',
      },
      status,
    );
  }
  return result.data as T;
}

/** A short German message for any error thrown by {@link unwrap}. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.problem.detail ? `: ${error.problem.detail}` : '';
    return `${error.problem.title}${detail}`;
  }
  if (error instanceof Error) return error.message;
  return 'Unbekannter Fehler';
}
