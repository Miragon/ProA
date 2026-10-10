import { createRoute } from '@hono/zod-openapi';
import {
  CreateSessionBody,
  MAX_SESSION_BODY_BYTES,
  apiRoutes,
  type InteractiveClient,
} from '@proa/contracts';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, setCookie } from 'hono/cookie';

import { SESSION_COOKIE, sessionCookieOptions, type SessionCodec } from '../../auth/session.ts';
import type { Actor } from '../../domain/actor.ts';
import { DomainError } from '../../domain/errors.ts';
import type { UseCases } from '../../domain/use-cases/index.ts';
import { requireActor, type App } from '../context.ts';
import { problemResponse } from '../problem.ts';

export interface SessionRouteDeps {
  useCases: Pick<UseCases, 'localOwnerActor' | 'me'>;
  sessions: SessionCodec;
  /** The actor a new session stands for; default: the local owner. The demo passes its viewer. */
  sessionActor?: (client: InteractiveClient) => Promise<Actor>;
  /** Set the cookie `Secure` (the demo on https origins). */
  secureCookie?: boolean;
}

/** Without the body: it is optional and parsed here, so a bodyless POST works. */
const createSessionRoute = createRoute({
  ...apiRoutes.createSession,
  request: {},
});

/**
 * `POST /api/v1/session` (local mode): issues the owner session cookie;
 * `DELETE` clears it; `GET /api/v1/me` reports the caller. The local guard
 * (Host/Origin) has already run, so only localhost clients get here. On the
 * read-only demo the session is the viewer's (`sessionActor`) and the public
 * guard has run instead.
 *
 * The body is capped at {@link MAX_SESSION_BODY_BYTES} before the handler
 * reads it (413 `payload-too-large`, a chunked body is cut off there): the
 * route needs no session, and on the demo it is the only write anyone can
 * reach, so one large body must not fill the server's memory.
 */
export function registerSessionRoutes(app: App, deps: SessionRouteDeps): void {
  const sessionActor =
    deps.sessionActor ?? ((client: InteractiveClient) => deps.useCases.localOwnerActor(client));
  const cookieOptions = sessionCookieOptions(deps.sessions.maxAgeSeconds, deps.secureCookie);
  app.use(
    apiRoutes.createSession.path,
    bodyLimit({
      maxSize: MAX_SESSION_BODY_BYTES,
      onError: () =>
        problemResponse(
          'payload-too-large',
          `a session request may have at most ${MAX_SESSION_BODY_BYTES} bytes`,
        ),
    }),
  );
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
    const actor = await sessionActor(body.data.client);
    setCookie(c, SESSION_COOKIE, deps.sessions.issue(body.data.client), cookieOptions);
    c.header('cache-control', 'no-store');
    return c.json(deps.useCases.me(actor), 200);
  });

  app.openapi(createRoute(apiRoutes.deleteSession), (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', ...(deps.secureCookie ? { secure: true } : {}) });
    return c.body(null, 204);
  });

  app.openapi(createRoute(apiRoutes.getMe), (c) => c.json(deps.useCases.me(requireActor(c)), 200));
}
