import { z } from 'zod';

/** Media type of RFC 9457 problem responses. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Base of ProA problem type URIs: `urn:proa:problem:<code>`. */
export const PROBLEM_TYPE_BASE = 'urn:proa:problem:';

/**
 * Problem codes (CONCEPT §5) plus generic HTTP ones. The code is the last
 * segment of the problem `type` and is repeated as the `code` extension member.
 * M4 (value chain): `value-chain-invalid` (422, with `violations` and
 * `truncated`), `value-chain-unsupported-version` (422, with `schemaVersion`
 * and `supported`), `revision-conflict` (412, with `headRev` and `etag`) and
 * `precondition-required` (428, a content save without `If-Match`).
 */
export const ProblemCode = z
  .enum([
    'validation-failed',
    'bpmn-invalid',
    'unauthorized',
    'insufficient-scope',
    'forbidden',
    'human-decision-required',
    'not-found',
    'method-not-allowed',
    'conflict',
    'precondition-failed',
    'precondition-required',
    'revision-conflict',
    'value-chain-invalid',
    'value-chain-unsupported-version',
    'lease-lost',
    'task-cancelled',
    'already-submitted',
    'payload-too-large',
    'unsupported-media-type',
    'internal',
    'not-implemented',
  ])
  .meta({ id: 'ProblemCode', description: 'Machine-readable problem code.' });
export type ProblemCode = z.infer<typeof ProblemCode>;

/** HTTP status and title per problem code. */
export const PROBLEMS = {
  'validation-failed': { status: 422, title: 'Validation failed' },
  'bpmn-invalid': { status: 422, title: 'BPMN invalid' },
  unauthorized: { status: 401, title: 'Unauthorized' },
  'insufficient-scope': { status: 403, title: 'Insufficient scope' },
  forbidden: { status: 403, title: 'Forbidden' },
  'human-decision-required': { status: 403, title: 'Human decision required' },
  'not-found': { status: 404, title: 'Not found' },
  'method-not-allowed': { status: 405, title: 'Method not allowed' },
  conflict: { status: 409, title: 'Conflict' },
  'precondition-failed': { status: 412, title: 'Precondition failed' },
  'precondition-required': { status: 428, title: 'Precondition required' },
  'revision-conflict': { status: 412, title: 'Revision conflict' },
  'value-chain-invalid': { status: 422, title: 'Value chain invalid' },
  'value-chain-unsupported-version': {
    status: 422,
    title: 'Value chain schema version unsupported',
  },
  'lease-lost': { status: 409, title: 'Lease lost' },
  'task-cancelled': { status: 409, title: 'Task cancelled' },
  'already-submitted': { status: 409, title: 'Already submitted' },
  'payload-too-large': { status: 413, title: 'Payload too large' },
  'unsupported-media-type': { status: 415, title: 'Unsupported media type' },
  internal: { status: 500, title: 'Internal server error' },
  'not-implemented': { status: 501, title: 'Not implemented' },
} as const satisfies Record<ProblemCode, { status: number; title: string }>;

/** `urn:proa:problem:<code>`. */
export function problemType(code: ProblemCode): string {
  return `${PROBLEM_TYPE_BASE}${code}`;
}

export const ProblemFieldError = z
  .object({
    /** JSON path of the offending value, e.g. `body.scopes[0]`. */
    path: z.string(),
    message: z.string(),
  })
  .meta({ id: 'ProblemFieldError', description: 'One validation error.' });
export type ProblemFieldError = z.infer<typeof ProblemFieldError>;

/** RFC 9457 problem details; extension members are allowed. */
export const ApiProblem = z
  .looseObject({
    type: z.string(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: ProblemCode,
    errors: z.array(ProblemFieldError).optional(),
  })
  .meta({ id: 'ApiProblem', description: 'RFC 9457 problem details.' });
export type ApiProblem = z.infer<typeof ApiProblem>;

/**
 * Builds a problem object for `code`.
 * @param extras extension members (e.g. `errors`, `reviewUrl`), merged last but never overriding `type`, `status` or `code`
 */
export function createProblem(
  code: ProblemCode,
  detail?: string,
  extras: Record<string, unknown> = {},
): ApiProblem {
  const { status, title } = PROBLEMS[code];
  return {
    title,
    ...extras,
    type: problemType(code),
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
  };
}
