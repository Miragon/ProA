import { DEMO_SAFE_METHODS, DEMO_WRITE_EXEMPT_OPERATIONS, apiRoutes } from '@proa/contracts';
import type { MiddlewareHandler } from 'hono';

import { problemResponse } from './problem.ts';

const SAFE: ReadonlySet<string> = new Set(DEMO_SAFE_METHODS.map((m) => m.toUpperCase()));

/** `METHOD path` of the write routes the demo serves: opening and ending the viewer session. */
const EXEMPT: ReadonlySet<string> = new Set(
  DEMO_WRITE_EXEMPT_OPERATIONS.map((name) => {
    const route = apiRoutes[name];
    return `${route.method.toUpperCase()} ${route.path}`;
  }),
);

/** Detail of the 403 `demo-readonly` answer. */
export const DEMO_READONLY_DETAIL =
  'this ProA is a read-only demo: nothing can be changed (no uploads, decisions, rules or agent tokens)';

/**
 * The read-only demo's first write barrier (`PROA_DEMO=readonly`, issue #3):
 * every request whose method is not GET, HEAD or OPTIONS answers 403
 * `demo-readonly`, on every path, except `POST` and `DELETE` on exactly
 * `/api/v1/session` (the viewer session of the web UI). Register it before
 * authentication: no route can be forgotten, and a bearer token on a write
 * never reaches the token lookup (which would record its use).
 */
export function demoReadOnlyGuard(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (SAFE.has(method) || EXEMPT.has(`${method} ${c.req.path}`)) return next();
    return problemResponse('demo-readonly', DEMO_READONLY_DETAIL);
  };
}
