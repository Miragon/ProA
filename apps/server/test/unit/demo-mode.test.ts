/**
 * The read-only demo's HTTP layer without a database (issue #3): the public
 * Host/Origin guard, the read-only guard before authentication, MCP off,
 * credentials refused, the health flag, HSTS and the secure session cookie.
 * The real-PostgreSQL walk of every route is `test/integration/demo-mode.test.ts`.
 */
import { ApiProblem, Health, MAX_SESSION_BODY_BYTES, apiRoutes } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { createApp, createProaApp } from '../../src/app.ts';
import { DEMO_HSTS } from '../../src/http/security-headers.ts';
import { fakeDatabase } from '../support/fakes.ts';

const ORIGIN = 'https://proa-demo.fly.dev';
const demoApp = createApp({
  config: { authMode: 'local', webDist: null, demo: { publicOrigins: [ORIGIN] } },
  database: fakeDatabase(),
  version: '9.9.9',
});
const localApp = createApp({
  config: { authMode: 'local', webDist: null },
  database: fakeDatabase(),
  version: '9.9.9',
});

const sample = (path: string) =>
  path
    .replace('{project}', 'demo')
    .replace(
      /\{(model|revision|relation|token|analysis|placement|rule)\}/g,
      'x_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
    )
    .replace('{key}', 'main')
    .replace('{rev}', '1')
    .replace('{elementId}', 'step');

function request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return demoApp.request(`${ORIGIN}${path}`, {
    ...init,
    headers: { host: 'proa-demo.fly.dev', ...init.headers },
  });
}

describe('read-only demo: health', () => {
  it('says it is a demo; local mode stays byte for byte as before', async () => {
    const res = await request('/health');
    expect(res.status).toBe(200);
    expect(Health.parse(await res.json())).toEqual({
      status: 'ok',
      version: '9.9.9',
      db: 'ok',
      demo: 'readonly',
    });
    const local = await localApp.request('http://127.0.0.1:7400/health');
    expect(await local.text()).toBe('{"status":"ok","version":"9.9.9","db":"ok"}');
  });

  it('answers the platform health checker under any Host, GET and HEAD only', async () => {
    for (const method of ['GET', 'HEAD']) {
      const res = await demoApp.request('http://172.19.0.2:8080/health', {
        method,
        headers: { host: '172.19.0.2:8080' },
      });
      expect(res.status, method).toBe(200);
    }
    const other = await demoApp.request('http://172.19.0.2:8080/api/v1/openapi.json', {
      headers: { host: '172.19.0.2:8080' },
    });
    expect(other.status).toBe(403);
  });
});

describe('read-only demo: Host and Origin', () => {
  it.each<Record<string, string>>([
    { host: 'proa-demo.fly.dev' },
    { host: 'PROA-DEMO.fly.dev:443' },
    { host: 'proa-demo.fly.dev', origin: ORIGIN },
    { host: '127.0.0.1:8080' },
    { host: 'localhost:8080' },
  ])('lets %o through', async (headers) => {
    expect((await demoApp.request('/api/v1/openapi.json', { headers })).status).toBe(200);
  });

  it.each<Record<string, string>>([
    { host: 'evil.example' },
    { host: 'proa-demo.fly.dev.evil.example' },
    { host: 'proa-demo.fly.dev', origin: 'https://evil.example' },
    { host: 'proa-demo.fly.dev', origin: 'http://proa-demo.fly.dev' },
    { host: 'proa-demo.fly.dev', origin: `${ORIGIN}:8443` },
    { host: 'proa-demo.fly.dev', origin: 'null' },
    { host: 'localhost:8080', origin: 'http://localhost:8080' },
  ])('refuses %o with 403 forbidden', async (headers) => {
    const res = await demoApp.request('/api/v1/openapi.json', { headers });
    expect(res.status).toBe(403);
    expect(ApiProblem.parse(await res.json()).code).toBe('forbidden');
  });
});

describe('read-only demo: writes', () => {
  const writes = Object.entries(apiRoutes).filter(
    ([name, r]) => r.method !== 'get' && name !== 'createSession' && name !== 'deleteSession',
  );

  it.each(writes)(
    '%s answers 403 demo-readonly, also with a bearer token',
    async (_name, route) => {
      const variants: Record<string, string>[] = [
        {},
        { authorization: 'Bearer proa_at_x' },
        { authorization: 'Bearer proa_ok_x' },
      ];
      for (const headers of variants) {
        const res = await request(sample(route.path), {
          method: route.method.toUpperCase(),
          headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
          body: '{}',
        });
        expect(res.status).toBe(403);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        expect(ApiProblem.parse(await res.json()).code).toBe('demo-readonly');
      }
    },
  );

  it('refuses every unsafe method on every path, whatever the case or encoding', async () => {
    for (const [method, path] of [
      ['PATCH', '/api/v1/projects/demo'],
      ['POST', '/'],
      ['PUT', '/assets/x.js'],
      ['DELETE', '/api/v1/nope'],
      ['POST', '/api/v1/session/'],
      ['POST', '/API/v1/session'],
      ['POST', '/api/v1/sessio%6E/x'],
      ['PROPFIND', '/api/v1/projects'],
      ['post', '/api/v1/projects'],
    ] as const) {
      const res = await request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(ApiProblem.parse(await res.json()).code).toBe('demo-readonly');
    }
  });

  it('keeps the session routes and safe methods open', async () => {
    const options = await request('/api/v1/projects', { method: 'OPTIONS' });
    expect(options.status).not.toBe(403);
    const ended = await request('/api/v1/session', { method: 'DELETE' });
    expect(ended.status).toBe(204);
    expect(ended.headers.get('set-cookie')).toContain('Secure');
  });
});

describe('the session route caps its body (the demo’s only public write)', () => {
  /** A JSON body of spaces that never ends unless read to its end; counts what was read. */
  function endless(): { body: ReadableStream<Uint8Array>; pulled: () => number } {
    const chunk = new TextEncoder().encode(' '.repeat(1024));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.length;
        if (pulled > 64 * 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    return { body, pulled: () => pulled };
  }

  it.each([
    ['demo', demoApp, ORIGIN, 'proa-demo.fly.dev'],
    ['local mode', localApp, 'http://127.0.0.1:7400', '127.0.0.1:7400'],
  ] as const)(
    'answers 413 on %s before reading a body over the cap',
    async (_mode, app, origin, host) => {
      const headers = { host, origin, 'content-type': 'application/json' };
      const declared = await app.request(`${origin}/api/v1/session`, {
        method: 'POST',
        headers: { ...headers, 'content-length': String(MAX_SESSION_BODY_BYTES + 1) },
        body: ' '.repeat(MAX_SESSION_BODY_BYTES + 1),
      });
      expect(declared.status).toBe(413);
      expect(ApiProblem.parse(await declared.json()).code).toBe('payload-too-large');

      // Chunked, without a length: cut off at the cap, never read to its end.
      const stream = endless();
      const chunked = await app.request(
        new Request(`${origin}/api/v1/session`, {
          method: 'POST',
          headers,
          body: stream.body,
          duplex: 'half',
        }),
      );
      expect(chunked.status).toBe(413);
      expect(ApiProblem.parse(await chunked.json()).code).toBe('payload-too-large');
      expect(stream.pulled()).toBeLessThan(MAX_SESSION_BODY_BYTES + 16 * 1024);
    },
  );
});

describe('read-only demo: credentials and MCP', () => {
  it('refuses every credential with 401 before any lookup', async () => {
    for (const authorization of ['Bearer proa_at_x', 'Bearer proa_ok_x', 'Basic dTpw']) {
      const res = await request('/api/v1/projects', { headers: { authorization } });
      expect(res.status).toBe(401);
      expect(ApiProblem.parse(await res.json()).detail).toMatch(/accepts no credentials/);
    }
  });

  it('answers 404 on /mcp for every method; local mode still mounts it', async () => {
    for (const method of ['GET', 'POST', 'DELETE', 'HEAD']) {
      for (const path of ['/mcp', '/mcp/bearer']) {
        const res = await request(path, {
          method,
          headers: { authorization: 'Bearer proa_at_x', 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    const local = await localApp.request('http://127.0.0.1:7400/mcp', { method: 'POST' });
    expect(local.status).toBe(401);
  });

  it('has no MCP route registered at all', () => {
    const { app } = createProaApp({
      config: { authMode: 'local', webDist: null, demo: { publicOrigins: [ORIGIN] } },
      database: fakeDatabase(),
    });
    const mcp = app.routes.filter((r) => r.path.startsWith('/mcp'));
    // Only the two 404 handlers of the demo.
    expect(mcp.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['ALL /mcp', 'ALL /mcp/*']);
  });
});

describe('read-only demo: transport security', () => {
  it('sends HSTS on https origins only, and never in local mode', async () => {
    expect((await request('/health')).headers.get('strict-transport-security')).toBe(DEMO_HSTS);
    const plain = createApp({
      config: {
        authMode: 'local',
        webDist: null,
        demo: { publicOrigins: ['http://127.0.0.1:7480'] },
      },
      database: fakeDatabase(),
    });
    const res = await plain.request('http://127.0.0.1:7480/health');
    expect(res.headers.get('strict-transport-security')).toBeNull();
    const local = await localApp.request('http://127.0.0.1:7400/health');
    expect(local.headers.get('strict-transport-security')).toBeNull();
  });
});
