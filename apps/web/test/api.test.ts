import { getMe, listProjects } from '@proa/client';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, api, errorMessage, unwrap } from '../src/lib/api';
import { json, stubApi } from './support/render';

const ME = {
  principalId: 'prn_1',
  kind: 'user',
  handle: 'owner',
  authMode: 'local',
  clientId: 'proa-web',
};
const UNAUTHORIZED = { title: 'Unauthorized', status: 401, code: 'unauthorized' };

describe('owner session (local mode)', () => {
  it('opens the session once, before the first API request', async () => {
    const calls = stubApi({
      'POST /api/v1/session': () => json(ME),
      'GET /api/v1/projects': () => json({ items: [], nextCursor: null }),
      'GET /api/v1/me': () => json(ME),
    });
    await Promise.all([unwrap(listProjects({ client: api })), unwrap(getMe({ client: api }))]);
    await unwrap(listProjects({ client: api }));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/session',
      'GET /api/v1/projects',
      'GET /api/v1/me',
      'GET /api/v1/projects',
    ]);
    expect(calls[0]!.body).toEqual({ client: 'proa-web' });
  });

  it('renews the session after a 401 and repeats the request once', async () => {
    let valid = 0;
    const calls = stubApi({
      'POST /api/v1/session': async () => {
        await new Promise((r) => setTimeout(r, 5));
        valid += 1;
        return json(ME);
      },
      // the first session "expires" right away, like after a server restart
      'GET /api/v1/projects': () =>
        valid >= 2 ? json({ items: [], nextCursor: null }) : json(UNAUTHORIZED, 401),
      'GET /api/v1/me': () => (valid >= 2 ? json(ME) : json(UNAUTHORIZED, 401)),
    });
    await Promise.all([unwrap(listProjects({ client: api })), unwrap(getMe({ client: api }))]);
    expect(calls.filter((c) => c.path === '/api/v1/session')).toHaveLength(2);
    expect(calls.filter((c) => c.path === '/api/v1/projects')).toHaveLength(2);
  });

  it('turns problems into ApiError with a readable message', async () => {
    stubApi({
      'GET /api/v1/projects': () =>
        json(
          {
            type: 'urn:proa:problem:forbidden',
            title: 'Forbidden',
            status: 403,
            code: 'forbidden',
            detail: 'foreign Origin',
          },
          403,
        ),
    });
    const error = await unwrap(listProjects({ client: api })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(errorMessage(error)).toBe('Forbidden: foreign Origin');
  });

  it('reports an unreachable server in German', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const error = await unwrap(listProjects({ client: api })).catch((e: unknown) => e);
    expect(errorMessage(error)).toMatch(/nicht erreichbar/);
  });
});
