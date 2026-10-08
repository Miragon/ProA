import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ApiProblem, Health, apiRoutes, buildOpenApiDocument } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { createApp, createProaApp } from '../../src/app.ts';
import type { AppEnv } from '../../src/http/context.ts';
import { validationHook } from '../../src/http/problem.ts';
import { mountNotImplementedRoutes, toHonoPath } from '../../src/http/routes/not-implemented.ts';
import { fakeDatabase } from '../support/fakes.ts';

const config = { authMode: 'local' as const, webDist: null };
const app = createApp({ config, database: fakeDatabase(), version: '9.9.9' });

describe('GET /health', () => {
  it('reports ok with the database up', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(Health.parse(await res.json())).toEqual({ status: 'ok', version: '9.9.9', db: 'ok' });
  });

  it('answers 503 with the database down', async () => {
    const down = createApp({ config, database: fakeDatabase(false), version: '9.9.9' });
    const res = await down.request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'degraded', version: '9.9.9', db: 'down' });
  });
});

describe('GET /api/v1/openapi.json', () => {
  it('serves the contracts document with the server version', async () => {
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; info: { version: string } };
    expect(doc).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument({ version: '9.9.9' }))));
  });

  it('documents only routes from @proa/contracts', () => {
    // Routes registered through app.openapi() must be contract routes.
    const served = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 't', version: '0' },
    });
    const contract = buildOpenApiDocument();
    for (const [path, item] of Object.entries(served.paths ?? {})) {
      for (const method of Object.keys(item)) {
        expect(contract.paths?.[path]?.[method as 'get'], `${method} ${path}`).toBeDefined();
      }
    }
  });
});

describe('contract routes', () => {
  const sample = (path: string) =>
    path
      .replace('{project}', 'demo')
      .replace('{model}', 'mdl_01J9Z3N4X5Q6R7S8T9V0W1X2Y3')
      .replace('{revision}', 'rev_01J9Z3N4X5Q6R7S8T9V0W1X2Y3')
      .replace('{relation}', 'rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3')
      .replace('{token}', 'agt_01J9Z3N4X5Q6R7S8T9V0W1X2Y3')
      .replace('{analysis}', 'ana_01J9Z3N4X5Q6R7S8T9V0W1X2Y3')
      .replace('{key}', 'billing%2Fdunning');

  it('has a handler for every contract route (no 501 placeholders left)', () => {
    // The placeholders createProaApp itself mounted: calling
    // mountNotImplementedRoutes again would find them and always return [].
    const { placeholders } = createProaApp({ config, database: fakeDatabase(), version: '1' });
    expect(placeholders).toEqual([]);
  });

  it('serves every contract operation from a real handler (app.openapi)', () => {
    // The reverse of "documents only routes from @proa/contracts": every
    // contract operation was registered through app.openapi(), so a missing
    // register*Routes call fails here, not only in the integration suite.
    const served = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 't', version: '0' },
    });
    const contract = buildOpenApiDocument();
    for (const [path, item] of Object.entries(contract.paths ?? {})) {
      for (const method of Object.keys(item)) {
        expect(served.paths?.[path]?.[method as 'get'], `${method} ${path}`).toBeDefined();
      }
    }
  });

  const open = new Set(['getHealth', 'createSession', 'deleteSession']);
  it.each(Object.entries(apiRoutes).filter(([name]) => !open.has(name)))(
    '%s answers 401 without credentials',
    async (_name, route) => {
      const res = await app.request(sample(route.path), {
        method: route.method.toUpperCase(),
        ...(route.method === 'post'
          ? { headers: { 'content-type': 'application/json' }, body: '{}' }
          : {}),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
      expect(ApiProblem.parse(await res.json()).code).toBe('unauthorized');
    },
  );

  it('rejects a malformed bearer token before touching the database', async () => {
    const res = await app.request('/api/v1/projects', {
      headers: { authorization: 'Bearer proa_at_x' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('answers placeholders with 501 for routes without a handler', () => {
    const local = new OpenAPIHono();
    local.openapi(createRoute(apiRoutes.getHealth), (c) =>
      c.json({ status: 'ok' as const, version: '1', db: 'ok' as const }, 200),
    );
    const placeholders = mountNotImplementedRoutes(
      local as unknown as Parameters<typeof mountNotImplementedRoutes>[0],
    );
    expect(placeholders).not.toContain('getHealth');
    expect(placeholders).toContain('listProjects');
  });

  it('converts OpenAPI paths to Hono paths', () => {
    expect(toHonoPath('/api/v1/projects/{project}/models/{model}')).toBe(
      '/api/v1/projects/:project/models/:model',
    );
  });
});

describe('problems', () => {
  it('answers unknown API paths with a 404 problem', async () => {
    const res = await app.request('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(ApiProblem.parse(await res.json())).toMatchObject({ code: 'not-found', status: 404 });
  });

  it('answers failed request validation with 422 validation-failed', async () => {
    const local = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
    local.openapi(
      createRoute({
        method: 'get',
        path: '/x',
        request: { query: z.object({ n: z.coerce.number().int() }) },
        responses: { 200: { description: 'ok' } },
      }),
      (c) => c.body(null, 200),
    );
    const res = await local.request('/x?n=abc');
    expect(res.status).toBe(422);
    const body = ApiProblem.parse(await res.json());
    expect(body.code).toBe('validation-failed');
    expect(body.errors?.[0]?.path).toBe('query.n');
  });
});
