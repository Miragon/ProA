import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';

import type { Actor } from '../domain/actor.ts';
import { DomainError } from '../domain/errors.ts';

/** Hono environment of the ProA app: the authenticated caller, if any. */
export interface AppEnv {
  Variables: {
    /** Set by the `authenticate` middleware; `null` for anonymous requests. */
    actor: Actor | null;
  };
}

export type App = OpenAPIHono<AppEnv>;

/**
 * The caller of a request that needs one.
 * @throws {DomainError} `unauthorized` (401) for anonymous requests
 */
export function requireActor(c: Context<AppEnv>): Actor {
  const actor = c.get('actor');
  if (!actor) {
    throw new DomainError(
      'unauthorized',
      'send an agent token (Authorization: Bearer proa_at_…) or open a session',
    );
  }
  return actor;
}
