import { apiRoutes } from '@proa/contracts';
import type { MiddlewareHandler } from 'hono';

import { problemResponse } from '../http/problem.ts';
import { isLocalHostname } from './local-guard.ts';

function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Host and Origin checks of the read-only demo (`PROA_DEMO=readonly`, issue
 * #3), in place of local mode's {@link localRequestGuard}: the demo is served
 * from its public origins (`PROA_PUBLIC_ORIGIN`) instead of localhost.
 * - `GET`/`HEAD /health` pass without checks: a platform's health checker
 *   (Fly.io) calls it under an address of its own.
 * - `Host` must name the host of a public origin (any port: a proxy may
 *   forward another one) or a loopback name (checks inside the container).
 * - `Origin`, when present, must equal a public origin exactly; `Origin: null`
 *   and every other origin are refused, so no other site's page can call the
 *   demo in a visitor's browser. Requests without an `Origin` pass on `Host`.
 *
 * Only reads get through anyway (`demoReadOnlyGuard`); these checks keep
 * DNS rebinding and cross-site use out as in local mode.
 */
export function publicRequestGuard(publicOrigins: readonly string[]): MiddlewareHandler {
  const origins = new Set(publicOrigins);
  const hostnames = new Set(publicOrigins.map((o) => new URL(o).hostname.toLowerCase()));
  return async (c, next) => {
    if (
      (c.req.method === 'GET' || c.req.method === 'HEAD') &&
      c.req.path === apiRoutes.getHealth.path
    ) {
      return next();
    }
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    const hostname = hostnameOf(host);
    if (!hostname || !(hostnames.has(hostname) || isLocalHostname(hostname))) {
      return problemResponse(
        'forbidden',
        'this ProA demo answers only under its public address (PROA_PUBLIC_ORIGIN)',
      );
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && !origins.has(origin)) {
      return problemResponse(
        'forbidden',
        'this ProA demo accepts requests only from its own pages (PROA_PUBLIC_ORIGIN)',
      );
    }
    return next();
  };
}
