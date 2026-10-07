import { createProaClient, type Client } from '@proa/client';
import type { ApiProblem } from '@proa/contracts';

import type { Credential } from './credentials.ts';
import { ApiError, CliError } from './errors.ts';
import type { CliIo } from './io.ts';

/** A REST client for one server and credential. */
export interface Api {
  client: Client;
  url: string;
}

export function createApi(io: CliIo, url: string, credential?: Credential): Api {
  return {
    url,
    client: createProaClient({
      baseUrl: url,
      fetch: io.fetch,
      ...(credential ? { token: credential.secret } : {}),
    }),
  };
}

interface SdkResult<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

function reason(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.message}${cause}`;
  }
  return String(err);
}

function asProblem(error: unknown): Partial<ApiProblem> | null {
  return typeof error === 'object' && error !== null ? error : null;
}

/**
 * Awaits an SDK call and returns its data.
 *
 * @param what the action, for messages ("create project x")
 * @throws {CliError} if the server is unreachable
 * @throws {ApiError} for a non-2xx answer, carrying the problem
 */
export async function call<T>(api: Api, what: string, request: Promise<SdkResult<T>>): Promise<T> {
  let result: SdkResult<T>;
  try {
    result = await request;
  } catch (err) {
    throw new CliError(`cannot reach ProA at ${api.url}: ${reason(err)}`);
  }
  const { response } = result;
  if (!response) throw new CliError(`cannot reach ProA at ${api.url}: ${reason(result.error)}`);
  if (!response.ok) throw new ApiError(what, response.status, asProblem(result.error));
  return result.data as T;
}

/** `call`, but a 404 becomes `null` (e.g. "does the project exist?"). */
export async function callOrNull<T>(
  api: Api,
  what: string,
  request: Promise<SdkResult<T>>,
): Promise<T | null> {
  try {
    return await call(api, what, request);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
