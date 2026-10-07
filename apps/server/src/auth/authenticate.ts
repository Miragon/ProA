import { OWNER_KEY_PREFIX } from '@proa/contracts';
import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';

import type { Actor } from '../domain/actor.ts';
import type { UseCases } from '../domain/use-cases/index.ts';
import type { AppEnv } from '../http/context.ts';
import { problemResponse } from '../http/problem.ts';
import type { OwnerKeyVerifier } from './owner-key.ts';
import { SESSION_COOKIE, type SessionCodec } from './session.ts';

export interface AuthenticateOptions {
  useCases: Pick<UseCases, 'authenticateAgentToken' | 'localOwnerActor'>;
  sessions: SessionCodec;
  /**
   * Accept the owner's credentials, the session cookie and the owner key
   * (REST). MCP accepts agent tokens only.
   */
  allowOwner: boolean;
  /** Checks a presented local owner key (`proa_ok_…`); `null`/absent: no owner key configured. */
  ownerKey?: OwnerKeyVerifier | null;
}

/** `WWW-Authenticate` of a rejected bearer token (RFC 6750). */
export const INVALID_TOKEN_CHALLENGE = 'Bearer realm="proa", error="invalid_token"';

function rejectionDetail(secret: string | undefined, ownerAllowed: boolean): string {
  if (!secret?.startsWith(OWNER_KEY_PREFIX)) return 'invalid, expired or revoked agent token';
  return ownerAllowed
    ? 'invalid owner key'
    : 'the owner key is not accepted here; use an agent token (proa_at_…)';
}

/**
 * Resolves the caller from the request, reading headers only (CONCEPT §6):
 * - `Authorization: Bearer proa_ok_…` (owner key, if allowed and configured)
 *   → the local owner on `proa-cli`;
 * - `Authorization: Bearer proa_at_…` → the agent token's actor; an unknown,
 *   revoked, expired or malformed token, and an owner key where none is
 *   accepted, is answered 401 right away;
 * - else, if allowed, a valid `proa_session` cookie → the local owner on the
 *   cookie's interactive client;
 * - else anonymous (`actor = null`); handlers that need a caller answer 401.
 */
export function authenticate(options: AuthenticateOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let actor: Actor | null = null;
    const authorization = c.req.header('authorization');
    if (authorization !== undefined) {
      const secret = /^Bearer[ ]+(\S+)[ ]*$/i.exec(authorization)?.[1];
      if (secret?.startsWith(OWNER_KEY_PREFIX)) {
        const verify = options.allowOwner ? options.ownerKey : null;
        actor = verify?.(secret) ? await options.useCases.localOwnerActor('proa-cli') : null;
      } else if (secret) {
        actor = await options.useCases.authenticateAgentToken(secret);
      }
      if (!actor) {
        return problemResponse(
          'unauthorized',
          rejectionDetail(secret, options.allowOwner),
          {},
          { 'www-authenticate': INVALID_TOKEN_CHALLENGE },
        );
      }
    } else if (options.allowOwner) {
      const cookie = getCookie(c, SESSION_COOKIE);
      const claims = cookie ? options.sessions.verify(cookie) : null;
      if (claims) actor = await options.useCases.localOwnerActor(claims.client);
    }
    c.set('actor', actor);
    return next();
  };
}

/**
 * Answers 401 for anonymous requests to contract routes before any
 * validation runs, except on `openPaths` (the OpenAPI document, the session
 * endpoint). Unknown paths fall through to the 404 problem.
 */
export function requireAuthentication(
  routePaths: readonly string[],
  openPaths: readonly string[],
): MiddlewareHandler<AppEnv> {
  const open = new Set(openPaths);
  const gated = routePaths
    .filter((p) => !open.has(p))
    .map((p) => new RegExp(`^${p.replace(/\{\w+\}/g, '[^/]+')}$`));
  return async (c, next) => {
    if (!c.get('actor') && gated.some((re) => re.test(c.req.path))) {
      return problemResponse(
        'unauthorized',
        'send an agent token (Authorization: Bearer proa_at_…) or open a session',
      );
    }
    return next();
  };
}
