/**
 * `proa-demo check --url <demo>`: proves a running demo is what issue #3
 * promises, from the outside (CI, the deploy workflow, local runs):
 *
 * - health says `demo: "readonly"` and reports the operator's legal links
 *   (`imprintUrl`, `privacyUrl`: absolute https URLs, which the banner shows
 *   as „Impressum“ and „Datenschutz“);
 * - the session is a viewer; both landscapes are listed with role viewer;
 *   each has models, agent proposals with questions, agent no-links (the
 *   inbox tab „Kein Zusammenhang“), a value chain with placement proposals,
 *   and no open analysis task;
 * - the routes beyond reading (agent tokens, rules, the ledger) answer 403;
 * - every write route of the contracts but the session answers 403
 *   `demo-readonly`, with the viewer's cookie, without one and with a token;
 * - `/mcp` answers 404; a foreign `Origin` 403; a bearer token 401.
 *
 * It never writes to a server that is not a read-only demo: unless `/health`
 * says `demo: "readonly"` it sends nothing else, and unless the session is
 * the visitor it sends no write. The write walk names a project and keys
 * that exist nowhere ({@link NO_PROJECT}), so even a misdirected walk could
 * not reach real data; a demo refuses it before routing anyway.
 */
import { DEMO_SAFE_METHODS, DEMO_WRITE_EXEMPT_OPERATIONS, apiRoutes } from '@proa/contracts';

import { DEMO_LANDSCAPES } from './seed.ts';

export interface CheckOptions {
  url: string;
  /** Projects that must be there (default: both demo landscapes). */
  projects?: readonly string[];
  fetch?: typeof globalThis.fetch;
}

export interface CheckResult {
  url: string;
  passed: number;
  failures: string[];
  /** The legal links `/health` reported (`null`: none, or no demo). */
  links: { imprintUrl: string | null; privacyUrl: string | null };
}

/** The legal links a demo must report in `/health`, with what they are for the failure text. */
const LEGAL_LINKS = [
  ['imprintUrl', 'legal notice (Impressum)'],
  ['privacyUrl', 'privacy policy (Datenschutz)'],
] as const;

/** An absolute https URL (what the server accepts for a legal link). */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A syntactically valid agent token that exists nowhere. */
const FAKE_TOKEN = `proa_at_${'A'.repeat(43)}`;

/** The project key of the write walk: no seed has it (the demo refuses before routing). */
export const NO_PROJECT = 'proa-demo-check-none';

/** The failure that stops the check before any write (the target is no read-only demo). */
export const NOT_A_DEMO = 'not a read-only demo: no write route was tried';

function fill(path: string): string {
  return path
    .replace('{project}', NO_PROJECT)
    .replace(/\{(model|revision|relation|token|analysis|placement|rule)\}/g, (_m, name: string) => {
      const prefix = {
        model: 'mdl',
        revision: 'rev',
        relation: 'rel',
        token: 'agt',
        analysis: 'ana',
        placement: 'plc',
        rule: 'aar',
      }[name];
      return `${prefix ?? 'x'}_01J9Z3N4X5Q6R7S8T9V0W1X2Y3`;
    })
    .replace('{key}', 'none')
    .replace('{rev}', '1')
    .replace('{elementId}', 'step');
}

/** The fields the check reads; a malformed answer fails a check, never the run. */
interface Relation {
  status?: string;
  source?: string | null;
  provenance?: { question?: string | null } | null;
}
interface Placement {
  status?: string;
  source?: string | null;
}

/** Runs every check against `options.url`; never throws for a failed check. */
export async function checkDemo(options: CheckOptions): Promise<CheckResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.url.replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const projects = options.projects ?? DEMO_LANDSCAPES;
  const failures: string[] = [];
  let passed = 0;
  const expect = (ok: boolean, what: string) => {
    if (ok) passed++;
    else failures.push(what);
  };
  const request = (path: string, init: RequestInit = {}) =>
    doFetch(`${base}${path}`, { redirect: 'manual', ...init });
  const codeOf = async (res: Response): Promise<string | null> => {
    try {
      return ((await res.json()) as { code?: string }).code ?? null;
    } catch {
      return null;
    }
  };

  const health = await request('/health');
  const body = health.ok
    ? ((await health.json().catch(() => ({}))) as Record<string, unknown> & { demo?: unknown })
    : {};
  const isDemo = health.status === 200 && body.demo === 'readonly';
  expect(isDemo, `GET /health: ${health.status}, demo=${String(body.demo)}`);
  const links = { imprintUrl: null as string | null, privacyUrl: null as string | null };
  const result = (extra: string[] = []): CheckResult => ({
    url: base,
    passed,
    failures: [...failures, ...extra],
    links,
  });
  // Never a session or a write against a server that may hold real data (local mode: the owner).
  if (!isDemo) return result([NOT_A_DEMO]);
  // The operator's Impressum and privacy policy: the banner links them on every page.
  for (const [field, what] of LEGAL_LINKS) {
    const value = body[field];
    if (isHttpsUrl(value)) links[field] = value;
    expect(
      isHttpsUrl(value),
      `GET /health: no ${what} link (${field}=${value === undefined ? 'absent' : JSON.stringify(value)})`,
    );
  }

  const session = await request('/api/v1/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ client: 'proa-web' }),
  });
  const cookie = /proa_session=([^;]+)/.exec(session.headers.get('set-cookie') ?? '')?.[1];
  const me = session.ok ? ((await session.json()) as { handle?: string }) : {};
  expect(session.status === 200 && cookie !== undefined, `POST /api/v1/session: ${session.status}`);
  const visitor = me.handle === 'visitor';
  expect(visitor, `the session is ${String(me.handle)}, not the visitor`);
  if (!visitor) return result([NOT_A_DEMO]);
  const asVisitor = { cookie: `proa_session=${cookie ?? ''}`, origin };
  const get = async <T>(path: string): Promise<T | null> => {
    const res = await request(path, { headers: asVisitor });
    expect(res.status === 200, `GET ${path}: ${res.status}`);
    return res.ok ? ((await res.json()) as T) : null;
  };

  const listed = await get<{ items?: { key: string; role: string }[] }>(
    '/api/v1/projects?limit=200',
  );
  for (const key of projects) {
    const p = (listed?.items ?? []).find((i) => i.key === key);
    expect(p?.role === 'viewer', `project ${key}: ${p ? `role ${p.role}` : 'not listed'}`);
    const k = encodeURIComponent(key);
    const landscape = await get<{ models?: unknown[]; relations?: Relation[] }>(
      `/api/v1/projects/${k}/landscape`,
    );
    if (landscape) {
      const relations = Array.isArray(landscape.relations) ? landscape.relations : [];
      const agent = relations.filter((r) => r.status === 'proposed' && r.source === 'agent');
      expect((landscape.models ?? []).length > 0, `${key}: no models`);
      expect(agent.length > 0, `${key}: no agent proposals`);
      expect(
        agent.some((r) => r.provenance?.question),
        `${key}: no agent question`,
      );
    }
    // The agent's no-links: the inbox tab „Kein Zusammenhang“ lists them.
    const noLinks = await get<{ items?: { handle?: string }[] }>(`/api/v1/projects/${k}/no-links`);
    expect(
      (noLinks?.items ?? []).some((n) => n.handle?.startsWith('agent:')),
      `${key}: no agent no-link`,
    );
    const placements = await get<{ items?: Placement[] }>(
      `/api/v1/projects/${k}/value-chains/main/placements?limit=200`,
    );
    expect(
      (placements?.items ?? []).some((p) => p.status === 'proposed' && p.source === 'agent'),
      `${key}: no agent placement proposal`,
    );
    for (const state of ['queued', 'claimed']) {
      const tasks = await get<{ items?: unknown[] }>(
        `/api/v1/projects/${k}/analyses?state=${state}&limit=1`,
      );
      expect(tasks?.items?.length === 0, `${key}: an analysis task is ${state}`);
    }
    for (const path of ['agent-tokens', 'auto-accept-rules', 'auto-accepted']) {
      const res = await request(`/api/v1/projects/${k}/${path}`, { headers: asVisitor });
      expect(res.status === 403, `GET …/${path}: ${res.status}, expected 403`);
    }
  }

  // The write walk only as a viewer of every listed project (the visitor's role on the demo).
  const roles = (listed?.items ?? []).map((i) => i.role);
  if (roles.length === 0 || roles.some((r) => r !== 'viewer')) return result([NOT_A_DEMO]);

  const safe: readonly string[] = DEMO_SAFE_METHODS;
  const exempt: readonly string[] = DEMO_WRITE_EXEMPT_OPERATIONS;
  for (const [name, route] of Object.entries(apiRoutes)) {
    if (safe.includes(route.method) || exempt.includes(name)) continue;
    for (const [as, headers] of [
      ['visitor', asVisitor],
      ['anonymous', { origin }],
      ['token', { origin, authorization: `Bearer ${FAKE_TOKEN}` }],
    ] as const) {
      const res = await request(fill(route.path), {
        method: route.method.toUpperCase(),
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      });
      const code = await codeOf(res);
      expect(
        res.status === 403 && code === 'demo-readonly',
        `${route.method.toUpperCase()} ${route.path} (${as}): ${res.status} ${String(code)}`,
      );
    }
  }

  for (const method of ['GET', 'POST']) {
    const res = await request('/mcp', {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${FAKE_TOKEN}` },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    expect(res.status === 404, `${method} /mcp: ${res.status}, expected 404`);
  }
  const foreign = await request('/api/v1/projects', {
    headers: { cookie: asVisitor.cookie, origin: 'https://evil.example' },
  });
  expect(foreign.status === 403, `a foreign Origin: ${foreign.status}, expected 403`);
  const bearer = await request('/api/v1/projects', {
    headers: { authorization: `Bearer ${FAKE_TOKEN}` },
  });
  expect(bearer.status === 401, `a bearer token on a read: ${bearer.status}, expected 401`);

  return result();
}

/**
 * Waits until `/health` reports the demo (a deploy or a cold start), then
 * runs {@link checkDemo}.
 */
export async function waitForDemo(
  options: CheckOptions & { waitSeconds: number; sleep?: (ms: number) => Promise<void> },
): Promise<boolean> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const pause = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + options.waitSeconds * 1000;
  for (;;) {
    try {
      const res = await doFetch(`${options.url.replace(/\/+$/, '')}/health`);
      if (res.ok && ((await res.json()) as { demo?: string }).demo === 'readonly') return true;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) return false;
    await pause(5000);
  }
}
