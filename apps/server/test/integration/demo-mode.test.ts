/**
 * The read-only demo end to end (issue #3, CONCEPT §6), on real PostgreSQL
 * with the real libraries: `nordwind-handel` seeded as the demo image seeds
 * it (import, golden value chain, an agent token, the simulation agent over
 * MCP for both task kinds), then `grantDemoVisitor` and the read-only role of
 * `demo-bootstrap.ts`, and the demo app on a connection of that role.
 *
 * Requires: every registered write route answers 403 `demo-readonly` with the
 * visitor's cookie, anonymously and with the valid seed token, and that set
 * equals the contracts' write routes (no route forgotten); the session is the
 * visitor, a viewer; every GET contract route answers 2xx over the read-only
 * role, or 403 where it needs more than reading, never 500; a direct write
 * as that role fails in PostgreSQL; `/mcp` is 404; credentials are 401; the
 * walk changes nothing in the database; local mode is unchanged.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { connect, runAgent, type AgentReport } from '@proa/agent-sim';
import {
  DEMO_SAFE_METHODS,
  DEMO_WRITE_EXEMPT_OPERATIONS,
  MAX_SESSION_BODY_BYTES,
  Me,
  SESSION_COOKIE,
  apiRoutes,
  type AnalysisTaskPage,
  type CreatedAgentToken,
  type Health,
  type ModelPage,
  type NoLinkList,
  type PlacementPage,
  type ProjectPage,
  type RelationPage,
  type ValueChainDetail,
} from '@proa/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { libraryAnalysis } from '../../src/analysis.ts';
import { createProaApp, type ProaApp } from '../../src/app.ts';
import { createDatabase, type Database } from '../../src/db/client.ts';
import { createReadOnlyRole } from '../../src/db/demo-role.ts';
import { toHonoPath } from '../../src/http/routes/not-implemented.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { corpusFiles, importAll } from '../support/corpus.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { listen } from '../support/http.ts';
import { chainPath } from '../support/value-chain.ts';

const PROJECT = 'nordwind-handel';
const ORIGIN = 'https://proa-demo.example';
const HOST = 'proa-demo.example';
const VALUE_CHAINS = new URL('../../../../eval/value-chains/', import.meta.url);

let database: TestDatabase;
let t: TestApp;
let token: CreatedAgentToken;
let run: AgentReport;
let role: string;
let demoDatabase: Database;
let demo: ProaApp;
let visitorCookie: string;
/** Real ids of the seeded project, for the route walk. */
const ids: Record<string, string> = {};

async function demoRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return demo.app.request(`${ORIGIN}${path}`, {
    ...init,
    headers: { host: HOST, origin: ORIGIN, ...(init.headers as Record<string, string>) },
  });
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function fill(path: string): string {
  return path
    .replace('{project}', PROJECT)
    .replace('{model}', ids['model'] ?? '')
    .replace('{revision}', ids['revision'] ?? '')
    .replace('{relation}', ids['relation'] ?? '')
    .replace('{analysis}', ids['analysis'] ?? '')
    .replace('{token}', token.id)
    .replace('{key}', 'main')
    .replace('{rev}', '1')
    .replace('{elementId}', ids['step'] ?? '')
    .replace('{placement}', ids['placement'] ?? '')
    .replace('{rule}', 'aar_01J9Z3N4X5Q6R7S8T9V0W1X2Y3');
}

/** Rows that a write of any kind would change (events, assertions, tokens' last use). */
async function fingerprint(): Promise<string> {
  const { rows } = await database.pool.query<Record<string, string>>(`
    SELECT (SELECT count(*) FROM event)::text AS events,
           (SELECT max(last_seq) FROM project)::text AS seq,
           (SELECT count(*) FROM relation_assertion)::text AS assertions,
           (SELECT count(*) FROM placement_assertion)::text AS placement_assertions,
           (SELECT count(*) FROM membership)::text AS memberships,
           (SELECT count(*) FROM principal)::text AS principals,
           (SELECT string_agg(coalesce(last_used_at::text, '-'), ',') FROM agent_token) AS used`);
  return JSON.stringify(rows[0]);
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { analysis: libraryAnalysis });
  await t.createProject(PROJECT, 'Nordwind Handel');
  const outcomes = await importAll(
    (p, init) => t.asOwner(p, init),
    PROJECT,
    await corpusFiles(PROJECT),
  );
  expect(outcomes.every((o) => o.outcome === 'created')).toBe(true);
  const saved = await t.asOwner(chainPath(PROJECT, '/content'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-none-match': '*' },
    body: await readFile(new URL(`${PROJECT}/value-chain.vc.json`, VALUE_CHAINS)),
  });
  expect(saved.status).toBe(201);
  token = await t.createToken(PROJECT, ['proa:read', 'proa:propose']);
  const server = await listen(t.app.fetch);
  try {
    const session = await connect(
      { kind: 'http', url: server.url, token: token.secret },
      { name: 'proa-agent-sim', version: '0.0.0' },
    );
    try {
      run = await runAgent(session, {});
    } finally {
      await session.close();
    }
  } finally {
    await server.close();
  }

  // As demo-bootstrap.ts: the visitor's memberships, then the read-only role.
  const grant = await t.useCases.grantDemoVisitor();
  expect(grant.granted).toEqual([PROJECT]);
  expect((await t.useCases.grantDemoVisitor()).existing).toEqual([PROJECT]);
  role = `proa_demo_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(16).toString('hex');
  const client = await database.pool.connect();
  try {
    await createReadOnlyRole(client, { name: role, password });
    // Idempotent.
    await createReadOnlyRole(client, { name: role, password });
  } finally {
    client.release();
  }
  const url = new URL(database.url);
  url.username = role;
  url.password = password;
  demoDatabase = createDatabase(url.toString(), { max: 4 });
  demo = createProaApp({
    config: { authMode: 'local', webDist: null, demo: { publicOrigins: [ORIGIN] } },
    database: demoDatabase,
    version: '0.0.0-test',
    analysis: libraryAnalysis,
  });

  const opened = await demoRequest('/api/v1/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'proa-web' }),
  });
  expect(opened.status).toBe(200);
  const cookie = /proa_session=([^;]+)/.exec(opened.headers.get('set-cookie') ?? '')?.[1];
  expect(cookie).toBeDefined();
  visitorCookie = `${SESSION_COOKIE}=${cookie}`;

  const models = await json<ModelPage>(await t.asOwner(`/api/v1/projects/${PROJECT}/models`));
  const model = models.items.find((m) => m.headRevisionId !== null);
  ids['model'] = model?.id ?? '';
  ids['revision'] = model?.headRevisionId ?? '';
  const relations = await json<RelationPage>(
    await t.asOwner(`/api/v1/projects/${PROJECT}/relations?limit=1`),
  );
  ids['relation'] = relations.items[0]?.id ?? '';
  const tasks = await json<AnalysisTaskPage>(
    await t.asOwner(`/api/v1/projects/${PROJECT}/analyses?state=done&limit=1`),
  );
  ids['analysis'] = tasks.items[0]?.id ?? '';
  const chain = await json<ValueChainDetail>(await t.asOwner(chainPath(PROJECT)));
  ids['step'] = chain.steps.find((s) => s.elementId !== '@outside')?.elementId ?? '';
  const placements = await json<PlacementPage>(await t.asOwner(chainPath(PROJECT, '/placements')));
  ids['placement'] = placements.items[0]?.id ?? '';
  for (const [name, value] of Object.entries(ids)) expect(value, name).not.toBe('');
}, 180_000);

afterAll(async () => {
  await demoDatabase?.close();
  if (role) await database.pool.query(`DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`);
  await database?.drop();
});

describe('the seed the demo shows', () => {
  it('holds agent proposals, questions, no-links and placement proposals', () => {
    expect(run.stop).toBe('no-work');
    expect(run.totals.failed).toBe(0);
    expect(run.byKind.relations.proposed).toBeGreaterThan(0);
    expect(run.byKind.relations.questions).toBeGreaterThan(0);
    expect(run.byKind.relations.noLinks).toBeGreaterThan(0);
    expect(run.byKind.placement.proposed).toBeGreaterThan(0);
  });
});

describe('read-only demo over a read-only database role', () => {
  it('opens the visitor’s session: a viewer of every project, on an interactive client', async () => {
    const me = Me.parse(
      await json(await demoRequest('/api/v1/me', { headers: { cookie: visitorCookie } })),
    );
    expect(me).toMatchObject({
      kind: 'user',
      handle: 'visitor',
      authMode: 'local',
      clientId: 'proa-web',
    });
    const projects = await json<ProjectPage>(
      await demoRequest('/api/v1/projects', { headers: { cookie: visitorCookie } }),
    );
    expect(projects.items.map((p) => [p.key, p.role])).toEqual([[PROJECT, 'viewer']]);
    const health = await json<Health>(await demoRequest('/health'));
    expect(health).toEqual({ status: 'ok', version: '0.0.0-test', db: 'ok', demo: 'readonly' });
  });

  it('lists the agent’s no-links for the visitor, which no relation shows', async () => {
    const list = await json<NoLinkList>(
      await demoRequest(`/api/v1/projects/${PROJECT}/no-links`, {
        headers: { cookie: visitorCookie },
      }),
    );
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((n) => n.handle.startsWith('agent:'))).toBe(true);
    const relations = await json<RelationPage>(
      await demoRequest(`/api/v1/projects/${PROJECT}/relations?limit=200`, {
        headers: { cookie: visitorCookie },
      }),
    );
    // The simulation agent no-links only pairs without a relation (HANDOFF §8): the list is
    // the only place the review shows them.
    expect(relations.items.flatMap((r) => r.noLinks)).toEqual([]);
  });

  it('refuses every registered write route with 403 demo-readonly, and forgets none', async () => {
    const before = await fingerprint();
    const safe: readonly string[] = DEMO_SAFE_METHODS.map((m) => m.toUpperCase());
    const registered = demo.app.routes.filter(
      (r) => !safe.includes(r.method) && r.method !== 'ALL',
    );
    const exempt: readonly string[] = DEMO_WRITE_EXEMPT_OPERATIONS;
    const contract = Object.entries(apiRoutes).filter(([, r]) => r.method !== 'get');
    expect(new Set(registered.map((r) => `${r.method} ${r.path}`))).toEqual(
      new Set(contract.map(([, r]) => `${r.method.toUpperCase()} ${toHonoPath(r.path)}`)),
    );
    let walked = 0;
    for (const [name, route] of contract) {
      if (exempt.includes(name)) continue;
      for (const headers of [
        { cookie: visitorCookie },
        {},
        { authorization: `Bearer ${token.secret}` },
      ]) {
        const res = await demoRequest(fill(route.path), {
          method: route.method.toUpperCase(),
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({}),
        });
        expect(res.status, `${route.method} ${route.path}`).toBe(403);
        expect(((await res.json()) as { code: string }).code).toBe('demo-readonly');
        walked++;
      }
    }
    expect(walked).toBe((contract.length - exempt.length) * 3);
    // Methods and paths no route has.
    for (const [method, path] of [
      ['PATCH', `/api/v1/projects/${PROJECT}`],
      ['POST', '/api/v1/unknown'],
      ['PUT', '/'],
    ] as const) {
      expect((await demoRequest(path, { method, headers: { cookie: visitorCookie } })).status).toBe(
        403,
      );
    }
    // Nothing changed: no event, no assertion, no membership, no token use recorded.
    expect(await fingerprint()).toBe(before);
  });

  it('answers every GET contract route over the read-only role: 2xx, or 403 beyond reading', async () => {
    const before = await fingerprint();
    const beyondReading = new Set([
      'getPendingAnalyses', // propose
      'listAgentTokens', // admin
      'listAutoAcceptRules', // admin
      'getAutoAcceptRule', // admin
      'listAutoAccepted', // review
    ]);
    const answers: Record<string, number> = {};
    for (const [name, route] of Object.entries(apiRoutes)) {
      if (route.method !== 'get') continue;
      const res = await demoRequest(fill(route.path), { headers: { cookie: visitorCookie } });
      answers[name] = res.status;
      if (beyondReading.has(name)) {
        expect(res.status, name).toBe(403);
        expect(((await res.json()) as { code: string }).code, name).toBe('insufficient-scope');
      } else {
        expect(res.status, `${name}: ${res.status} ${res.ok ? '' : await res.text()}`).toBeLessThan(
          300,
        );
      }
    }
    expect(Object.keys(answers).length).toBeGreaterThan(25);
    const openapi = await demoRequest('/api/v1/openapi.json');
    expect(openapi.status).toBe(200);
    expect(await fingerprint()).toBe(before);
  });

  it('cannot write through the role either (SQLSTATE 25006)', async () => {
    const client = new pg.Client({
      connectionString: (demoDatabase.pool.options as { connectionString: string })
        .connectionString,
    });
    await client.connect();
    try {
      await expect(
        client.query("UPDATE project SET name = 'x' WHERE key = $1", [PROJECT]),
      ).rejects.toMatchObject({ code: '25006' });
      await expect(client.query('DELETE FROM event')).rejects.toMatchObject({ code: '25006' });
      const { rows } = await client.query<{ statement_timeout: string }>('SHOW statement_timeout');
      expect(rows[0]?.statement_timeout).toBe('30s');
    } finally {
      await client.end();
    }
  });

  it('cuts off a large session body unread (413), and the next session still opens', async () => {
    const before = await fingerprint();
    const chunk = new TextEncoder().encode(' '.repeat(16 * 1024));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.length;
        // 700 MB if read to the end, as the attack that crashed the 1 GB machine.
        if (pulled > 700 * 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await demo.app.request(
      new Request(`${ORIGIN}/api/v1/session`, {
        method: 'POST',
        headers: { host: HOST, 'content-type': 'application/json' },
        body,
        duplex: 'half',
      }),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe('payload-too-large');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(pulled).toBeLessThan(MAX_SESSION_BODY_BYTES + 64 * 1024);
    const next = await demoRequest('/api/v1/session', { method: 'POST' });
    expect(next.status).toBe(200);
    expect(Me.parse(await next.json()).handle).toBe('visitor');
    expect(await fingerprint()).toBe(before);
  });

  it('turns MCP off and refuses every credential', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await demoRequest('/mcp', {
        method,
        headers: { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.status, method).toBe(404);
    }
    for (const secret of [token.secret, 'proa_ok_' + 'a'.repeat(43)]) {
      const res = await demoRequest(`/api/v1/projects/${PROJECT}`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(res.status).toBe(401);
    }
  });
});

describe('local mode next to it', () => {
  it('is unchanged: the owner writes, health has no demo flag, MCP answers', async () => {
    const created = await t.asOwner('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'local-write', name: 'Local write' }),
    });
    expect(created.status).toBe(201);
    expect(await (await t.request('/health')).json()).toEqual({
      status: 'ok',
      version: '0.0.0-test',
      db: 'ok',
    });
    const mcp = await t.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(mcp.status).toBe(401);
    // The visitor is no member of a project created after the bootstrap.
    const projects = await json<ProjectPage>(
      await demoRequest('/api/v1/projects', { headers: { cookie: visitorCookie } }),
    );
    expect(projects.items.map((p) => p.key)).toEqual([PROJECT]);
  });
});
