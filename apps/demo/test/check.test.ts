import { DEMO_WRITE_EXEMPT_OPERATIONS, apiRoutes } from '@proa/contracts';
import { describe, expect, it, vi } from 'vitest';

import { NOT_A_DEMO, NO_PROJECT, checkDemo, waitForDemo } from '../src/check.ts';
import { runDemo } from '../src/program.ts';
import { fakeFetch, type FakeRoute } from './fakes.ts';

const URL_ = 'https://proa-demo.fly.dev';
const LINKS = {
  imprintUrl: 'https://example.org/impressum',
  privacyUrl: 'https://example.org/datenschutz/',
};
const writeRoutes = Object.entries(apiRoutes).filter(
  ([name, r]) =>
    r.method !== 'get' && !(DEMO_WRITE_EXEMPT_OPERATIONS as readonly string[]).includes(name),
);

/** A demo that behaves as issue #3 asks, with `broken` routes misbehaving. */
function demo(
  broken: {
    writable?: string;
    mcp?: boolean;
    noQuestions?: boolean;
    noNoLinks?: boolean;
    /** The session `POST /api/v1/session` opens (default: the visitor). */
    handle?: string;
    /** The role the projects are listed with (default: viewer). */
    role?: string;
    /** The legal links `/health` reports (default: {@link LINKS}). */
    links?: Record<string, unknown>;
  } = {},
) {
  return (method: string, url: string, init: RequestInit): FakeRoute | undefined => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const path = url.split('?')[0] ?? url;
    if (path === '/health') {
      return {
        body: {
          status: 'ok',
          version: '1',
          db: 'ok',
          demo: 'readonly',
          ...(broken.links ?? LINKS),
        },
      };
    }
    if (path === '/api/v1/session' && method === 'POST') {
      return {
        body: { handle: broken.handle ?? 'visitor' },
        headers: { 'set-cookie': 'proa_session=v1.x; Path=/' },
      };
    }
    if (path.startsWith('/mcp')) return broken.mcp ? { status: 401 } : { status: 404 };
    if (method !== 'GET') {
      if (broken.writable && path.endsWith(broken.writable)) return { status: 201, body: {} };
      return { status: 403, body: { code: 'demo-readonly' } };
    }
    if (headers['authorization']) return { status: 401, body: { code: 'unauthorized' } };
    if (headers['origin'] === 'https://evil.example')
      return { status: 403, body: { code: 'forbidden' } };
    if (path === '/api/v1/projects') {
      return {
        body: {
          items: [
            { key: 'nordwind-handel', role: broken.role ?? 'viewer' },
            { key: 'stadtwerke-auental', role: 'viewer' },
          ],
        },
      };
    }
    if (/\/(agent-tokens|auto-accept-rules|auto-accepted)$/.test(path)) return { status: 403 };
    if (path.endsWith('/landscape')) {
      return {
        body: {
          models: [{}],
          relations: [
            {
              status: 'proposed',
              source: 'agent',
              provenance: { question: broken.noQuestions ? null : 'Gleiches Ereignis?' },
            },
          ],
        },
      };
    }
    if (path.endsWith('/placements'))
      return { body: { items: [{ status: 'proposed', source: 'agent' }] } };
    if (path.endsWith('/analyses')) return { body: { items: [] } };
    if (path.endsWith('/no-links')) {
      return { body: { items: broken.noNoLinks ? [] : [{ handle: 'agent:proa-agent-sim' }] } };
    }
    return undefined;
  };
}

describe('proa-demo check', () => {
  it('passes a demo that refuses every write', async () => {
    const { fetch, calls } = fakeFetch(demo());
    const result = await checkDemo({ url: `${URL_}/`, fetch });
    expect(result.failures).toEqual([]);
    expect(result.url).toBe(URL_);
    expect(result.links).toEqual(LINKS);
    // Every write route, three ways each.
    const writes = calls.filter(
      (c) => c.method !== 'GET' && c.path !== '/api/v1/session' && !c.path.startsWith('/mcp'),
    );
    expect(writes).toHaveLength(writeRoutes.length * 3);
    expect(result.passed).toBeGreaterThan(writeRoutes.length * 3);
    // The session is opened from the demo's own origin.
    const session = calls.find((c) => c.path === '/api/v1/session');
    expect((session?.init.headers as Record<string, string>)['origin']).toBe(URL_);
    // The walk names a project that exists nowhere, never a seeded one.
    const projects = writes.flatMap((c) => /\/projects\/([^/]+)/.exec(c.path)?.[1] ?? []);
    expect(new Set(projects)).toEqual(new Set([NO_PROJECT]));
    expect(writes.some((c) => c.path.endsWith('/value-chains/main'))).toBe(false);
  });

  it('names every gap: a write that went through, MCP answering, no agent question', async () => {
    const { fetch } = fakeFetch(
      demo({ writable: '/projects', mcp: true, noQuestions: true, noNoLinks: true }),
    );
    const result = await checkDemo({ url: URL_, fetch });
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'POST /api/v1/projects (visitor): 201 null',
        'POST /api/v1/projects (anonymous): 201 null',
        'GET /mcp: 401, expected 404',
        'nordwind-handel: no agent question',
        'stadtwerke-auental: no agent no-link',
      ]),
    );
  });

  it('names a missing or malformed legal link, and still walks the rest', async () => {
    const { fetch, calls } = fakeFetch(demo({ links: { privacyUrl: 'http://example.org/p' } }));
    const result = await checkDemo({ url: URL_, fetch });
    expect(result.failures).toEqual([
      'GET /health: no legal notice (Impressum) link (imprintUrl=absent)',
      'GET /health: no privacy policy (Datenschutz) link (privacyUrl="http://example.org/p")',
    ]);
    expect(result.links).toEqual({ imprintUrl: null, privacyUrl: null });
    expect(calls.filter((c) => c.method !== 'GET').length).toBeGreaterThan(writeRoutes.length);
    const one = await checkDemo({
      url: URL_,
      fetch: fakeFetch(demo({ links: { imprintUrl: LINKS.imprintUrl, privacyUrl: 'datenschutz' } }))
        .fetch,
    });
    expect(one.failures).toEqual([
      'GET /health: no privacy policy (Datenschutz) link (privacyUrl="datenschutz")',
    ]);
    expect(one.links).toEqual({ imprintUrl: LINKS.imprintUrl, privacyUrl: null });
  });

  it('sends nothing but GET /health to a server that is no demo (local mode: the owner)', async () => {
    const { fetch, calls } = fakeFetch((_method, url) =>
      url === '/health'
        ? { body: { status: 'ok', version: '1', db: 'ok' } }
        : { status: 201, body: { handle: 'owner' } },
    );
    const result = await checkDemo({ url: 'http://127.0.0.1:7400', fetch });
    expect(result.failures).toEqual(['GET /health: 200, demo=undefined', NOT_A_DEMO]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /health']);
  });

  it('sends no write when health claims a demo but the session is not the visitor', async () => {
    const { fetch, calls } = fakeFetch(demo({ handle: 'owner' }));
    const result = await checkDemo({ url: URL_, fetch });
    expect(result.failures).toEqual(['the session is owner, not the visitor', NOT_A_DEMO]);
    expect(calls.filter((c) => c.method !== 'GET').map((c) => c.path)).toEqual(['/api/v1/session']);
  });

  it('sends no write when a project is listed with more than reading', async () => {
    const { fetch, calls } = fakeFetch(demo({ role: 'owner' }));
    const result = await checkDemo({ url: URL_, fetch });
    expect(result.failures).toEqual(['project nordwind-handel: role owner', NOT_A_DEMO]);
    expect(calls.filter((c) => c.method !== 'GET').map((c) => c.path)).toEqual(['/api/v1/session']);
  });

  it('waits for the demo to report itself', async () => {
    let up = false;
    const { fetch } = fakeFetch((_m, url) =>
      url === '/health' && up ? { body: { demo: 'readonly' } } : { status: 503 },
    );
    const sleep = vi.fn(() => {
      up = true;
      return Promise.resolve();
    });
    expect(await waitForDemo({ url: URL_, fetch, waitSeconds: 60, sleep })).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe('proa-demo command line', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), env: {} },
    };
  }

  it('answers usage errors with exit 2', async () => {
    for (const argv of [
      [],
      ['nope'],
      ['seed'],
      ['check'],
      ['check', '--url', URL_, '--wait', 'x'],
      ['serve', '--bogus'],
    ]) {
      const t = io();
      expect(await runDemo(argv, t.io), argv.join(' ')).toBe(2);
      expect(t.err.join('')).toContain('usage:');
    }
  });

  it('prints the check result and exits 1 on a failure', async () => {
    vi.stubGlobal('fetch', fakeFetch(demo({ writable: '/imports' })).fetch);
    const t = io();
    expect(await runDemo(['check', '--url', URL_], t.io)).toBe(1);
    expect(t.out.join('')).toMatch(/checks passed, 3 failed/);
    expect(t.out.join('')).toContain(
      'FAIL POST /api/v1/projects/{project}/imports (visitor): 201 null',
    );
    vi.stubGlobal('fetch', fakeFetch(demo()).fetch);
    const ok = io();
    expect(await runDemo(['check', '--url', URL_, '--json'], ok.io)).toBe(0);
    expect(JSON.parse(ok.out.join('')) as { failures: string[] }).toMatchObject({
      failures: [],
      links: LINKS,
    });
    const text = io();
    expect(await runDemo(['check', '--url', URL_], text.io)).toBe(0);
    expect(text.out.join('')).toContain(
      `legal links: imprint ${LINKS.imprintUrl}, privacy ${LINKS.privacyUrl}`,
    );
    vi.unstubAllGlobals();
  });
});
