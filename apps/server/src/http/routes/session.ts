import { createRoute } from '@hono/zod-openapi';
import { CreateSessionBody, apiRoutes } from '@proa/contracts';
import { deleteCookie, setCookie } from 'hono/cookie';

import { SESSION_COOKIE, sessionCookieOptions, type SessionCodec } from '../../auth/session.ts';
import { DomainError } from '../../domain/errors.ts';
import type { UseCases } from '../../domain/use-cases/index.ts';
import { requireActor, type App } from '../context.ts';

export interface SessionRouteDeps {
  useCases: Pick<UseCases, 'localOwnerActor' | 'me'>;
  sessions: SessionCodec;
}

/** Without the body: it is optional and parsed here, so a bodyless POST works. */
const createSessionRoute = createRoute({
  ...apiRoutes.createSession,
  request: {},
});

/**
 * `POST /api/v1/session` (local mode): issues the owner session cookie;
 * `DELETE` clears it; `GET /api/v1/me` reports the caller. The local guard
 * (Host/Origin) has already run, so only localhost clients get here.
 */
export function registerSessionRoutes(app: App, deps: SessionRouteDeps): void {
  app.openapi(createSessionRoute, async (c) => {
    let raw: unknown = {};
    const text = await c.req.text();
    if (text.trim() !== '') {
      if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        throw new DomainError('unsupported-media-type', 'send application/json or no body');
      }
      try {
        raw = JSON.parse(text);
      } catch {
        throw new DomainError('validation-failed', 'body is not valid JSON');
      }
    }
    const body = CreateSessionBody.safeParse(raw ?? {});
    if (!body.success) {
      throw new DomainError('validation-failed', 'invalid session request', {
        errors: body.error.issues.map((i) => ({
          path: ['body', ...i.path.map(String)].join('.'),
          message: i.message,
        })),
      });
    }
    const actor = await deps.useCases.localOwnerActor(body.data.client);
    setCookie(
      c,
      SESSION_COOKIE,
      deps.sessions.issue(body.data.client),
      sessionCookieOptions(deps.sessions.maxAgeSeconds),
    );
    c.header('cache-control', 'no-store');
    return c.json(deps.useCases.me(actor), 200);
  });

  app.openapi(createRoute(apiRoutes.deleteSession), (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  app.openapi(createRoute(apiRoutes.getMe), (c) => c.json(deps.useCases.me(requireActor(c)), 200));
}
