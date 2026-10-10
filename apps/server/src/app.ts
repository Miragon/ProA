import { OpenAPIHono } from '@hono/zod-openapi';
import {
  OPENAPI_PATH,
  apiRoutes,
  type DeclaredProcedure,
  type InteractiveClient,
} from '@proa/contracts';
import { getProcedure } from '@proa/procedures';

import { libraryAnalysis } from './analysis.ts';
import { authenticate, requireAuthentication } from './auth/authenticate.ts';
import { localRequestGuard } from './auth/local-guard.ts';
import { publicRequestGuard } from './auth/public-guard.ts';
import { ownerKeyVerifier } from './auth/owner-key.ts';
import { createSessionCodec, type SessionCodec } from './auth/session.ts';
import type { Config } from './config.ts';
import type { Database } from './db/client.ts';
import { createStore } from './db/store.ts';
import type { AnalysisPort, Clock, Notifier } from './domain/ports.ts';
import { createUseCases, type UseCases } from './domain/use-cases/index.ts';
import type { AppEnv } from './http/context.ts';
import { demoReadOnlyGuard } from './http/demo-guard.ts';
import { problemFromError, problemResponse, validationHook } from './http/problem.ts';
import { registerAgentTokenRoutes } from './http/routes/agent-tokens.ts';
import { registerAnalysisRoutes } from './http/routes/analyses.ts';
import { registerAutoAcceptRoutes } from './http/routes/auto-accept.ts';
import { registerModelRoutes } from './http/routes/models.ts';
import { registerPlacementRoutes } from './http/routes/placements.ts';
import { mountNotImplementedRoutes } from './http/routes/not-implemented.ts';
import { registerProjectRoutes } from './http/routes/projects.ts';
import { registerRelationRoutes } from './http/routes/relations.ts';
import { registerReviewRoutes } from './http/routes/review.ts';
import { registerSessionRoutes } from './http/routes/session.ts';
import { registerSystemRoutes } from './http/routes/system.ts';
import { registerValueChainRoutes } from './http/routes/value-chains.ts';
import { securityHeaders } from './http/security-headers.ts';
import { mountWebUi } from './http/web-ui.ts';
import { MCP_PATH, mountMcp } from './mcp/http.ts';
import { PROA_VERSION } from './version.ts';

export interface AppDeps {
  config: Pick<Config, 'authMode' | 'webDist'> &
    Partial<Pick<Config, 'originPorts' | 'sessionSecret' | 'demo'>>;
  database: Database;
  /** Defaults to {@link PROA_VERSION}. */
  version?: string;
  /** Fact extraction and rules; defaults to the libraries. Tests inject doubles. */
  analysis?: AnalysisPort;
  clock?: Clock;
  /** Wake-ups of the pending long-poll; defaults to the database's LISTEN connection. */
  notifier?: Notifier;
  /** Session cookie codec; defaults to one keyed by `config.sessionSecret` or a random key. */
  sessions?: SessionCodec;
  /**
   * The local owner key (`proa_ok_…`, see `auth/owner-key.ts`) the CLI
   * presents as bearer on REST; `null`/absent: owner only via the session.
   */
  ownerKey?: string | null;
  /**
   * The procedure relations claims name; defaults to {@link relationsProcedure}.
   * Tests inject another version to play a procedure release.
   */
  expectedProcedure?: () => DeclaredProcedure;
  /**
   * The procedure placement claims name (M4b); defaults to
   * {@link placementsProcedure}. Tests inject another version to play a release.
   */
  expectedPlacementProcedure?: () => DeclaredProcedure;
}

export interface ProaApp {
  app: OpenAPIHono<AppEnv>;
  useCases: UseCases;
  sessions: SessionCodec;
  /**
   * Operation ids of contract routes without a handler, which answer 501
   * (`mountNotImplementedRoutes`, a safety net); empty when every route of
   * `@proa/contracts` is implemented.
   */
  placeholders: string[];
}

/** Detail of the 401 for any credential the read-only demo is sent. */
export const DEMO_NO_CREDENTIALS =
  'the read-only demo accepts no credentials (no agent tokens, no owner key); open the web UI';

/**
 * Builds the ProA HTTP application: `/health`, REST `/api/v1` (routes from
 * `@proa/contracts`), MCP `/mcp`, and the web UI. Pure wiring, no I/O;
 * `main.ts` serves it. {@link createApp} returns just the Hono app.
 *
 * With `config.demo` (the read-only demo, `PROA_DEMO=readonly`, issue #3):
 * the public Host/Origin guard instead of the local one, `/mcp` answers 404,
 * every write answers 403 `demo-readonly` before authentication
 * ({@link demoReadOnlyGuard}), sessions are the viewer
 * (`demoVisitorActor`), credentials are refused with 401 and the owner key
 * is ignored. The routes stay the same: the guard alone refuses writes.
 */
export function createProaApp(deps: AppDeps): ProaApp {
  const version = deps.version ?? PROA_VERSION;
  const useCases = createUseCases({
    store: createStore(deps.database.db),
    analysis: deps.analysis ?? libraryAnalysis,
    clock: deps.clock ?? { now: () => new Date() },
    notifier: deps.notifier ?? deps.database.notifier,
    expectedProcedure: deps.expectedProcedure ?? relationsProcedure,
    expectedPlacementProcedure: deps.expectedPlacementProcedure ?? placementsProcedure,
  });
  const sessions = deps.sessions ?? createSessionCodec(deps.config.sessionSecret ?? undefined);
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  const demo = deps.config.demo ?? null;
  app.use('*', securityHeaders(demo ? { hsts: demo.publicOrigins.every(isHttps) } : {}));
  if (demo) {
    app.use('*', publicRequestGuard(demo.publicOrigins));
    app.all(MCP_PATH, demoMcpOff);
    app.all(`${MCP_PATH}/*`, demoMcpOff);
    app.use('*', demoReadOnlyGuard());
  } else if (deps.config.authMode === 'local') {
    app.use(
      '*',
      localRequestGuard(deps.config.originPorts ? { originPorts: deps.config.originPorts } : {}),
    );
  }
  const ownerKey = !demo && deps.ownerKey ? ownerKeyVerifier(deps.ownerKey) : null;
  const sessionActor = (client: InteractiveClient) =>
    demo ? useCases.demoVisitorActor(client) : useCases.localOwnerActor(client);
  app.use(
    '/api/*',
    authenticate({
      useCases,
      sessions,
      allowOwner: true,
      ownerKey,
      sessionActor,
      rejectCredentials: demo ? DEMO_NO_CREDENTIALS : null,
    }),
  );
  app.use(
    '/api/*',
    requireAuthentication(
      Object.values(apiRoutes).map((r) => r.path),
      [OPENAPI_PATH, apiRoutes.createSession.path, apiRoutes.deleteSession.path],
    ),
  );

  registerSystemRoutes(app, { database: deps.database, version, demo });
  registerSessionRoutes(app, {
    useCases,
    sessions,
    sessionActor,
    secureCookie: demo !== null && demo.publicOrigins.every(isHttps),
  });
  registerProjectRoutes(app, useCases);
  registerModelRoutes(app, useCases);
  registerRelationRoutes(app, useCases);
  registerReviewRoutes(app, useCases);
  registerAnalysisRoutes(app, useCases);
  registerAgentTokenRoutes(app, useCases);
  registerValueChainRoutes(app, useCases);
  registerPlacementRoutes(app, useCases);
  registerAutoAcceptRoutes(app, useCases);

  if (!demo) mountMcp(app, { version, useCases, auth: { sessions } });
  const placeholders = mountNotImplementedRoutes(app);
  if (deps.config.webDist) mountWebUi(app, deps.config.webDist);

  app.notFound((c) => problemResponse('not-found', `no route for ${c.req.method} ${c.req.path}`));
  app.onError((err, c) => problemFromError(err, new URL(c.req.url).origin));
  return { app, useCases, sessions, placeholders };
}

function isHttps(origin: string): boolean {
  return origin.startsWith('https://');
}

/** `/mcp` on the read-only demo: not mounted; agents have nothing to do there. */
function demoMcpOff(): Response {
  return problemResponse(
    'not-found',
    'MCP is off in the read-only demo: agents cannot connect here (run ProA locally to connect one)',
  );
}

/** The procedure a claim names: `proa-relations` at its current version (`@proa/procedures`). */
export function relationsProcedure(): DeclaredProcedure {
  const p = getProcedure('proa-relations');
  if (!p) throw new Error('the proa-relations procedure is missing');
  return { id: p.id, version: p.version };
}

/** The procedure a placement claim names: `proa-placements` at its current version (`@proa/procedures`). */
export function placementsProcedure(): DeclaredProcedure {
  const p = getProcedure('proa-placements');
  if (!p) throw new Error('the proa-placements procedure is missing');
  return { id: p.id, version: p.version };
}

/** The Hono app of {@link createProaApp}. */
export function createApp(deps: AppDeps): OpenAPIHono<AppEnv> {
  return createProaApp(deps).app;
}
