import { OpenAPIHono } from '@hono/zod-openapi';
import { OPENAPI_PATH, apiRoutes } from '@proa/contracts';

import { libraryAnalysis } from './analysis.ts';
import { authenticate, requireAuthentication } from './auth/authenticate.ts';
import { localRequestGuard } from './auth/local-guard.ts';
import { ownerKeyVerifier } from './auth/owner-key.ts';
import { createSessionCodec, type SessionCodec } from './auth/session.ts';
import type { Config } from './config.ts';
import type { Database } from './db/client.ts';
import { createStore } from './db/store.ts';
import type { AnalysisPort, Clock } from './domain/ports.ts';
import { createUseCases, type UseCases } from './domain/use-cases/index.ts';
import type { AppEnv } from './http/context.ts';
import { problemFromError, problemResponse, validationHook } from './http/problem.ts';
import { registerAgentTokenRoutes } from './http/routes/agent-tokens.ts';
import { registerModelRoutes } from './http/routes/models.ts';
import { mountNotImplementedRoutes } from './http/routes/not-implemented.ts';
import { registerProjectRoutes } from './http/routes/projects.ts';
import { registerRelationRoutes } from './http/routes/relations.ts';
import { registerSessionRoutes } from './http/routes/session.ts';
import { registerSystemRoutes } from './http/routes/system.ts';
import { securityHeaders } from './http/security-headers.ts';
import { mountWebUi } from './http/web-ui.ts';
import { mountMcp } from './mcp/http.ts';
import { PROA_VERSION } from './version.ts';

export interface AppDeps {
  config: Pick<Config, 'authMode' | 'webDist'> &
    Partial<Pick<Config, 'originPorts' | 'sessionSecret'>>;
  database: Database;
  /** Defaults to {@link PROA_VERSION}. */
  version?: string;
  /** Fact extraction and rules; defaults to the libraries. Tests inject doubles. */
  analysis?: AnalysisPort;
  clock?: Clock;
  /** Session cookie codec; defaults to one keyed by `config.sessionSecret` or a random key. */
  sessions?: SessionCodec;
  /**
   * The local owner key (`proa_ok_…`, see `auth/owner-key.ts`) the CLI
   * presents as bearer on REST; `null`/absent: owner only via the session.
   */
  ownerKey?: string | null;
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

/**
 * Builds the ProA HTTP application: `/health`, REST `/api/v1` (routes from
 * `@proa/contracts`), MCP `/mcp`, and the web UI. Pure wiring, no I/O;
 * `main.ts` serves it. {@link createApp} returns just the Hono app.
 */
export function createProaApp(deps: AppDeps): ProaApp {
  const version = deps.version ?? PROA_VERSION;
  const useCases = createUseCases({
    store: createStore(deps.database.db),
    analysis: deps.analysis ?? libraryAnalysis,
    clock: deps.clock ?? { now: () => new Date() },
  });
  const sessions = deps.sessions ?? createSessionCodec(deps.config.sessionSecret ?? undefined);
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  app.use('*', securityHeaders());
  if (deps.config.authMode === 'local') {
    app.use(
      '*',
      localRequestGuard(deps.config.originPorts ? { originPorts: deps.config.originPorts } : {}),
    );
  }
  const ownerKey = deps.ownerKey ? ownerKeyVerifier(deps.ownerKey) : null;
  app.use('/api/*', authenticate({ useCases, sessions, allowOwner: true, ownerKey }));
  app.use(
    '/api/*',
    requireAuthentication(
      Object.values(apiRoutes).map((r) => r.path),
      [OPENAPI_PATH, apiRoutes.createSession.path, apiRoutes.deleteSession.path],
    ),
  );

  registerSystemRoutes(app, { database: deps.database, version });
  registerSessionRoutes(app, { useCases, sessions });
  registerProjectRoutes(app, useCases);
  registerModelRoutes(app, useCases);
  registerRelationRoutes(app, useCases);
  registerAgentTokenRoutes(app, useCases);

  mountMcp(app, { version, useCases, auth: { sessions } });
  const placeholders = mountNotImplementedRoutes(app);
  if (deps.config.webDist) mountWebUi(app, deps.config.webDist);

  app.notFound((c) => problemResponse('not-found', `no route for ${c.req.method} ${c.req.path}`));
  app.onError((err) => problemFromError(err));
  return { app, useCases, sessions, placeholders };
}

/** The Hono app of {@link createProaApp}. */
export function createApp(deps: AppDeps): OpenAPIHono<AppEnv> {
  return createProaApp(deps).app;
}
