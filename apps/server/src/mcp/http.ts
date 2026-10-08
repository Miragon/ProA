import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { MAX_SUBMISSION_BYTES } from '@proa/contracts';

import { authenticate, type AuthenticateOptions } from '../auth/authenticate.ts';
import type { Actor } from '../domain/actor.ts';
import { effectiveScopes } from '../domain/policy.ts';
import type { UseCases } from '../domain/use-cases/index.ts';
import type { App } from '../http/context.ts';
import { problemResponse } from '../http/problem.ts';
import { createMcpServer } from './server.ts';

/** Path of the Streamable HTTP endpoint (CONCEPT §5). */
export const MCP_PATH = '/mcp';

/**
 * Largest MCP request body: a submission (the largest tool call,
 * {@link MAX_SUBMISSION_BYTES} as on REST) plus room for the JSON-RPC
 * envelope. The SDK's default would be 4 MiB; `submit_analysis` checks the
 * submission itself against the same limit as REST.
 */
export const MAX_MCP_REQUEST_BYTES = MAX_SUBMISSION_BYTES + 16 * 1024;

/** `WWW-Authenticate` of a token without the scope MCP needs (RFC 6750 §3.1). */
export const INSUFFICIENT_SCOPE_CHALLENGE =
  'Bearer realm="proa", error="insufficient_scope", scope="proa:read"';

export interface McpMountOptions {
  version: string;
  useCases: UseCases;
  auth: Omit<AuthenticateOptions, 'allowOwner' | 'ownerKey' | 'useCases'>;
}

function isActor(value: unknown): value is Actor {
  return typeof value === 'object' && value !== null && 'principalId' in value;
}

/**
 * Mounts MCP at `/mcp`: stateless Streamable HTTP via the v2 SDK's
 * `createMcpHandler`, which serves the 2026-07-28 revision and falls back to
 * stateless 2025-era serving (2025-11-25 and older) from the same factory.
 * Host/Origin checks run before it (local guard). Every request needs an
 * agent token (`Authorization: Bearer proa_at_…`, CONCEPT §6); the token's
 * actor reaches the per-request server through `authInfo`.
 */
export function mountMcp(app: App, options: McpMountOptions): McpHttpHandler {
  const handler = createMcpHandler(
    (ctx) => {
      const actor = ctx.authInfo?.extra?.['actor'];
      if (!isActor(actor)) throw new Error('MCP request without an authenticated actor');
      const origin = ctx.authInfo?.extra?.['origin'];
      return createMcpServer({
        version: options.version,
        useCases: options.useCases,
        actor,
        ...(typeof origin === 'string' ? { origin } : {}),
      });
    },
    {
      onerror: (err) => console.error('mcp:', err.message),
      maxRequestBodySize: MAX_MCP_REQUEST_BYTES,
    },
  );
  app.use(
    MCP_PATH,
    authenticate({ ...options.auth, useCases: options.useCases, allowOwner: false }),
  );
  app.all(MCP_PATH, (c) => {
    const actor = c.get('actor');
    if (!actor) {
      return problemResponse(
        'unauthorized',
        'MCP needs an agent token: Authorization: Bearer proa_at_… (create one on the "connect an agent" page)',
      );
    }
    // Every tool needs at least proa:read. Valid tokens always carry it (scopes
    // nest and the database forbids empty scopes); this is defence in depth.
    // Pipeline and proposal tools check proa:propose in the domain policy.
    if (!effectiveScopes(actor.scopes).has('proa:read')) {
      return problemResponse(
        'insufficient-scope',
        'MCP needs an agent token with scope proa:read',
        {},
        { 'www-authenticate': INSUFFICIENT_SCOPE_CHALLENGE },
      );
    }
    return handler.fetch(c.req.raw, {
      authInfo: {
        token: actor.clientId ?? '',
        clientId: actor.clientId ?? actor.principalId,
        scopes: [...actor.scopes],
        extra: { actor, origin: new URL(c.req.url).origin },
      },
    });
  });
  return handler;
}
