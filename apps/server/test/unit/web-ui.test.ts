import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { API_CSP, WEB_UI_CSP } from '../../src/http/security-headers.ts';
import { isReservedPath } from '../../src/http/web-ui.ts';
import { fakeDatabase } from '../support/fakes.ts';

let dir: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'proa-web-'));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>ProA</title>');
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
  app = createApp({
    config: { authMode: 'local', webDist: dir },
    database: fakeDatabase(),
    version: '0',
  });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('web UI serving', () => {
  it('serves static assets', async () => {
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
  });

  it('falls back to index.html for client-side routes', async () => {
    for (const p of ['/', '/projects/demo/relations']) {
      const res = await app.request(p);
      expect(res.status, p).toBe(200);
      expect(await res.text()).toContain('<title>ProA</title>');
    }
  });

  it('never falls back for API, MCP and well-known paths', async () => {
    for (const p of [
      '/api/v1/nope',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]) {
      const res = await app.request(p);
      expect(res.status, p).toBe(404);
      expect(res.headers.get('content-type'), p).toBe('application/problem+json');
    }
    expect(isReservedPath('/mcp')).toBe(true);
    expect(isReservedPath('/mcpx')).toBe(false);
  });

  it('does not serve files outside the web root', async () => {
    const res = await app.request('/../../package.json');
    expect(await res.text()).not.toContain('"name"');
  });
});

describe('security headers', () => {
  const common = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
  };

  it('gives the web UI a CSP that allows only its own scripts and no framing', async () => {
    for (const p of ['/', '/projects/demo/relations', '/assets/app.js']) {
      const res = await app.request(p);
      expect(Object.fromEntries(res.headers), p).toMatchObject({
        ...common,
        'content-security-policy': WEB_UI_CSP,
      });
    }
    expect(WEB_UI_CSP).toContain("script-src 'self'");
    expect(WEB_UI_CSP).toContain("frame-ancestors 'none'");
    expect(WEB_UI_CSP).not.toMatch(/script-src[^;]*unsafe/);
  });

  it('sandboxes API, MCP, health and error responses', async () => {
    const cases: Array<[string, RequestInit?]> = [
      ['/health'],
      ['/api/v1/openapi.json'],
      ['/api/v1/projects'], // 401
      ['/api/v1/nope'], // 404
      ['/mcp', { method: 'POST' }], // 401
      ['http://evil.example/api/v1/projects'], // 403 from the local guard
    ];
    for (const [p, init] of cases) {
      const res = await app.request(p, init);
      expect(Object.fromEntries(res.headers), p).toMatchObject({
        ...common,
        'content-security-policy': API_CSP,
      });
    }
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
  });
});
