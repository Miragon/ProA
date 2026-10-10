import { readFile } from 'node:fs/promises';

import { buildOpenApiDocument } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { createProaClient, getHealth, listProjects } from '../src/index.ts';

function recordingFetch(body: unknown, status = 200) {
  const calls: Request[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch };
}

describe('createProaClient', () => {
  it('calls /health without a token', async () => {
    const { calls, fetch } = recordingFetch({ status: 'ok', version: '1', db: 'ok' });
    const client = createProaClient({ baseUrl: 'http://127.0.0.1:7400/', fetch });
    const { data } = await getHealth({ client });
    expect(data).toEqual({ status: 'ok', version: '1', db: 'ok' });
    expect(calls[0]?.url).toBe('http://127.0.0.1:7400/health');
    expect(calls[0]?.headers.get('authorization')).toBeNull();
  });

  it('sends the agent token as bearer and query parameters', async () => {
    const { calls, fetch } = recordingFetch({ items: [], nextCursor: null });
    const client = createProaClient({ token: 'proa_at_secret', fetch });
    const { data } = await listProjects({ client, query: { limit: 10 } });
    expect(data).toEqual({ items: [], nextCursor: null });
    expect(calls[0]?.url).toBe('http://127.0.0.1:7400/api/v1/projects?limit=10');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer proa_at_secret');
  });

  it('returns problems as errors', async () => {
    const problem = {
      type: 'urn:proa:problem:not-implemented',
      title: 'Not implemented',
      status: 501,
      code: 'not-implemented',
    };
    const { fetch } = recordingFetch(problem, 501);
    const client = createProaClient({ fetch });
    const { data, error, response } = await listProjects({ client });
    expect(data).toBeUndefined();
    expect(response?.status).toBe(501);
    expect(error).toEqual(problem);
  });
});

describe('generated client', () => {
  it('was generated from the current contracts (run `pnpm --filter @proa/client generate`)', async () => {
    const committed = await readFile(new URL('../openapi.json', import.meta.url), 'utf8');
    expect(committed).toBe(`${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
  });
});
