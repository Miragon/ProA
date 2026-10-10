import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { apiRoutes } from './api/routes.ts';
import { ValueChainViolation } from './api/value-chains.ts';
import { Candidate } from './candidates.ts';
import { ProjectFacts } from './facts.ts';
import { DerivedRelation } from './relations.ts';

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

export interface OpenApiOptions {
  /** `info.version`; defaults to `0.0.0`. The server passes its own version. */
  version?: string;
  /** Adds a `servers` entry, e.g. `http://127.0.0.1:7400`. */
  serverUrl?: string;
}

/** Name of the bearer security scheme for agent tokens (`Authorization: Bearer proa_at_…`). */
export const AGENT_TOKEN_SECURITY_SCHEME = 'agentToken';

/**
 * Builds the OpenAPI 3.1 document of the ProA REST API from {@link apiRoutes}
 * and the shared schemas. Deterministic: the same input gives the same
 * document, so the generated client can be checked for drift.
 */
export function buildOpenApiDocument(options: OpenApiOptions = {}): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', AGENT_TOKEN_SECURITY_SCHEME, {
    type: 'http',
    scheme: 'bearer',
    description:
      'Agent token (`proa_at_…`). In local mode the web UI and the CLI act as the owner through the session cookie from `POST /api/v1/session` instead.',
  });
  for (const route of Object.values(apiRoutes)) registry.registerPath(route);
  // Library-level schemas that no route returns yet, so the client has their
  // types (a value chain violation is a member of the `value-chain-invalid`
  // problem). They are named by their `.meta({ id })`; `registry.register()` would
  // need zod's prototype extended with `.openapi()`, which contracts avoids.
  const extraSchemas = [Candidate, DerivedRelation, ProjectFacts, ValueChainViolation].map(
    (schema) => ({
      type: 'schema' as const,
      schema,
    }),
  );

  return new OpenApiGeneratorV31([...registry.definitions, ...extraSchemas]).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'ProA API',
      version: options.version ?? '0.0.0',
      description:
        'ProA 2.0: a headless store for process landscapes. Problems are RFC 9457 `application/problem+json`.',
    },
    ...(options.serverUrl ? { servers: [{ url: options.serverUrl }] } : {}),
    security: [{ [AGENT_TOKEN_SECURITY_SCHEME]: [] }, {}],
  });
}
