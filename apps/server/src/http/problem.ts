import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  PROBLEM_CONTENT_TYPE,
  createProblem,
  type ProblemCode,
  type ProblemFieldError,
} from '@proa/contracts';
import { HTTPException } from 'hono/http-exception';

import { DomainError } from '../domain/errors.ts';
import type { AppEnv } from './context.ts';

/** `WWW-Authenticate` challenge of 401 answers (RFC 6750; local mode has no resource metadata). */
export const BEARER_CHALLENGE = 'Bearer realm="proa"';

/** An RFC 9457 `application/problem+json` response for `code`. */
export function problemResponse(
  code: ProblemCode,
  detail?: string,
  extras: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  const body = createProblem(code, detail, extras);
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: {
      'content-type': PROBLEM_CONTENT_TYPE,
      ...(code === 'unauthorized' ? { 'www-authenticate': BEARER_CHALLENGE } : {}),
      ...headers,
    },
  });
}

const STATUS_CODES: Readonly<Record<number, ProblemCode>> = {
  400: 'validation-failed',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  405: 'method-not-allowed',
  409: 'conflict',
  412: 'precondition-failed',
  413: 'payload-too-large',
  415: 'unsupported-media-type',
  428: 'precondition-required',
  501: 'not-implemented',
};

/**
 * Extension members of a domain error as clients get them: a `reviewUrl`
 * path (`human-decision-required`) becomes absolute on the request's origin.
 */
export function problemExtras(err: DomainError, origin?: string): Record<string, unknown> {
  const extras: Record<string, unknown> = { ...err.extras };
  const reviewUrl = extras['reviewUrl'];
  if (origin && typeof reviewUrl === 'string' && reviewUrl.startsWith('/')) {
    extras['reviewUrl'] = new URL(reviewUrl, origin).toString();
  }
  return extras;
}

/**
 * Maps any thrown value to a problem response; unexpected errors become 500 and are logged.
 * @param origin the request's origin, for absolute links in problems
 */
export function problemFromError(err: unknown, origin?: string): Response {
  if (err instanceof DomainError) {
    return problemResponse(err.code, err.message, problemExtras(err, origin));
  }
  if (err instanceof HTTPException) {
    const code = STATUS_CODES[err.status];
    if (code) return problemResponse(code, err.message || undefined);
  }
  console.error('unhandled error:', err);
  return problemResponse('internal');
}

type DefaultHook = NonNullable<
  NonNullable<ConstructorParameters<typeof OpenAPIHono<AppEnv>>[0]>['defaultHook']
>;

/**
 * `defaultHook` of `OpenAPIHono`: a failed zod validation of params, query,
 * headers or body answers 422 `validation-failed` with one entry per issue.
 */
export const validationHook: DefaultHook = (result) => {
  if (result.success) return undefined;
  const errors: ProblemFieldError[] = result.error.issues.map((issue) => ({
    path: [result.target, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
  return problemResponse('validation-failed', 'request validation failed', { errors });
};
