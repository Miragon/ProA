import type { MiddlewareHandler } from 'hono';

import { problemResponse } from '../http/problem.ts';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for `localhost`, `127.0.0.1` and `[::1]` (case-insensitive, port ignored). */
export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin: string, ports: ReadonlySet<number> | null): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    isLocalHostname(url.hostname) &&
    (ports === null || ports.has(port))
  );
}

export interface LocalGuardOptions {
  /**
   * Ports a localhost `Origin` may have (the server's own port and the Vite
   * dev server by default, see `PROA_ORIGIN_PORTS`). `undefined` accepts any
   * port.
   */
  originPorts?: readonly number[];
}

/**
 * Local mode (CONCEPT §6): rejects requests whose `Host` or `Origin` is not
 * localhost, against DNS rebinding and cross-site requests.
 * - `Host` must name localhost, 127.0.0.1 or [::1] (any port: Docker may
 *   publish ProA on another host port).
 * - `Origin`, when present, must be an http(s) origin on one of those hosts
 *   and on an allowed port, so a page served by another local program cannot
 *   call ProA. `Origin: null` is rejected. Requests without an `Origin` (curl,
 *   MCP clients, same-origin GETs) pass on `Host` alone.
 */
export function localRequestGuard(options: LocalGuardOptions = {}): MiddlewareHandler {
  const ports = options.originPorts ? new Set(options.originPorts) : null;
  return async (c, next) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    const hostname = hostnameOf(host);
    if (!hostname || !isLocalHostname(hostname)) {
      return problemResponse('forbidden', 'local mode accepts only localhost Host headers');
    }
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      if (!isAllowedOrigin(origin, ports)) {
        return problemResponse(
          'forbidden',
          'local mode accepts only localhost origins on the ProA ports (PROA_ORIGIN_PORTS)',
        );
      }
    }
    return next();
  };
}
