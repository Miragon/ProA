/**
 * MCP contract test (CONCEPT §8 "MCP contract tests with the plain SDK
 * client"): the official SDK client over real HTTP with agent tokens, against
 * the real libraries on `eval/corpus/_sample`, imported into two projects.
 *
 * - `tools/list` is a file snapshot (`__snapshots__/mcp-tools.json`), equal in
 *   2025-11-25 and 2026-07-28;
 * - every tool is called with valid input (the SDK client validates
 *   `structuredContent` against the tool's output schema), with invalid input,
 *   and with the other project's key and id and unknown ids (404 problems);
 * - the credential matrix: no token, malformed, revoked and expired tokens,
 *   the owner key and the owner session (both rejected: agents use tokens),
 *   every agent scope (scopes nest, so each one reads), and a token without
 *   `proa:read` (impossible to create, rejected even if the row existed).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Project } from '@proa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { libraryAnalysis } from '../../src/analysis.ts';
import { generateOwnerKey } from '../../src/auth/owner-key.ts';
import { INSUFFICIENT_SCOPE_CHALLENGE } from '../../src/mcp/http.ts';
import { MCP_INSTRUCTIONS } from '../../src/mcp/server.ts';
import { startTestApp, testClock, type TestApp } from '../support/app.ts';
import { corpusFiles, importAll } from '../support/corpus.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { listen } from '../support/http.ts';

const DAY = 86_400_000;
const ORDER = 'vertrieb/auftragsabwicklung';
const ORDER_PROCESS = `${ORDER}#Process_Auftragsabwicklung`;
const INVOICING = 'finanzen/rechnungsstellung';
const PAYMENT = 'finance/payment-collection';
const TOOLS = [
  'find_unlinked_events',
  'get_model_xml',
  'get_procedure',
  'get_process',
  'get_relations',
  'list_processes',
  'list_projects',
  'which_processes_use',
];

let database: TestDatabase;
let t: TestApp;
let server: { url: string; close: () => Promise<void> };
const clock = testClock();
const ownerKey = generateOwnerKey();
let own: Project;
let foreign: Project;
let foreignRevisionId: string;
const secrets = { read: '', propose: '', write: '', foreign: '' };
const clients: Client[] = [];

type Negotiation = 'default' | 'auto';

/** An SDK client on `/mcp` with `Authorization: Bearer <secret>`; tools listed (output validation). */
async function connect(secret: string, negotiation: Negotiation = 'default'): Promise<Client> {
  const client = new Client(
    { name: 'proa-contract', version: '0' },
    negotiation === 'auto' ? { versionNegotiation: { mode: 'auto' } } : undefined,
  );
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    }),
  );
  await client.listTools();
  return client;
}

interface Outcome {
  isError: boolean;
  data: Record<string, unknown>;
  text: string;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Outcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return {
    isError: result.isError === true,
    data: (result.structuredContent ?? {}) as Record<string, unknown>,
    text: content.map((c) => c.text ?? '').join(''),
  };
}

/** The RFC 9457 problem a domain error comes back as. */
async function problem(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: string; status: number; type: string }> {
  const out = await call(client, name, args);
  expect(out.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  return JSON.parse(out.text) as { code: string; status: number; type: string };
}

/** Invalid arguments: a tool error naming the validation failure, never a result. */
async function expectInvalid(client: Client, name: string, args: Record<string, unknown>) {
  const out = await call(client, name, args);
  expect(out.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  expect(out.text).toMatch(/validation|invalid/i);
  expect(out.data).toEqual({});
}

const items = (o: Outcome) => o.data['items'] as Record<string, unknown>[];

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { analysis: libraryAnalysis, clock, ownerKey });
  own = await t.createProject('contract', 'Contract');
  foreign = await t.createProject('foreign', 'Foreign');
  const files = await corpusFiles('_sample');
  for (const p of ['contract', 'foreign']) {
    const outcomes = await importAll((path, init) => t.asOwner(path, init), p, files);
    expect(outcomes.map((o) => o.outcome)).toEqual(['created', 'created', 'created']);
  }
  const models = (await (await t.asOwner('/api/v1/projects/foreign/models')).json()) as {
    items: { key: string; headRevisionId: string }[];
  };
  foreignRevisionId = models.items.find((m) => m.key === ORDER)?.headRevisionId ?? '';
  secrets.read = (await t.createToken('contract', ['proa:read'])).secret;
  secrets.propose = (await t.createToken('contract', ['proa:read', 'proa:propose'])).secret;
  secrets.write = (await t.createToken('contract', ['proa:write'])).secret;
  secrets.foreign = (await t.createToken('foreign', ['proa:read'])).secret;
  server = await listen(t.app.fetch);
});

afterAll(async () => {
  for (const c of clients) await c.close();
  await server.close();
  await database.drop();
});

describe('tools/list', () => {
  it('matches the snapshot: names, titles, descriptions, schemas, annotations', async () => {
    const client = await connect(secrets.read);
    expect(client.getServerVersion()).toMatchObject({ name: 'proa' });
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(TOOLS);
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    await expect(
      `${JSON.stringify({ instructions: MCP_INSTRUCTIONS, tools: sorted }, null, 2)}\n`,
    ).toMatchFileSnapshot('__snapshots__/mcp-tools.json');
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.outputSchema?.type, tool.name).toBe('object');
    }
  });

  it('is the same list in 2025-11-25 and 2026-07-28', async () => {
    const legacy = await connect(secrets.read);
    const modern = await connect(secrets.read, 'auto');
    expect(legacy.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(modern.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect((await modern.listTools()).tools).toEqual((await legacy.listTools()).tools);
    const out = await call(modern, 'list_projects', {});
    expect(items(out).map((p) => p['key'])).toEqual(['contract']);
  });
});

describe.each<Negotiation>(['default', 'auto'])('every tool (%s negotiation)', (negotiation) => {
  let c: Client;
  beforeAll(async () => {
    c = await connect(secrets.read, negotiation);
  });

  it('list_projects: only the token’s project', async () => {
    const out = await call(c, 'list_projects', {});
    expect(out.isError).toBe(false);
    expect(items(out)).toEqual([expect.objectContaining({ id: own.id, key: 'contract' })]);
    expect(items(out)[0]?.['role']).toBe('viewer');
  });

  it('list_processes: models with stage and processes, by key or id, filtered, paged', async () => {
    const byKey = await call(c, 'list_processes', { projectId: 'contract' });
    expect(byKey.isError).toBe(false);
    expect(items(byKey).map((m) => [m['modelKey'], m['stage']])).toEqual([
      [PAYMENT, 'waiting_for_agent'],
      [INVOICING, 'waiting_for_agent'],
      [ORDER, 'waiting_for_agent'],
    ]);
    const byId = await call(c, 'list_processes', { projectId: own.id });
    expect(byId.data).toEqual(byKey.data);
    const page = await call(c, 'list_processes', { projectId: 'contract', limit: 2 });
    expect(items(page)).toHaveLength(2);
    const next = await call(c, 'list_processes', {
      projectId: 'contract',
      limit: 2,
      cursor: page.data['nextCursor'],
    });
    expect(items(next).map((m) => m['modelKey'])).toEqual([ORDER]);
    expect(next.data['nextCursor']).toBeNull();
    const none = await call(c, 'list_processes', { projectId: 'contract', stage: 'incorporated' });
    expect(items(none)).toEqual([]);

    await expectInvalid(c, 'list_processes', {});
    await expectInvalid(c, 'list_processes', { projectId: 'contract', stage: 'done' });
    await expectInvalid(c, 'list_processes', { projectId: 'contract', limit: 0 });
  });

  it('get_process: facts and the live relations touching them', async () => {
    const out = await call(c, 'get_process', { projectId: 'contract', ref: ORDER_PROCESS });
    expect(out.isError).toBe(false);
    expect(out.data['process']).toMatchObject({ processId: 'Process_Auftragsabwicklung' });
    const kinds = new Set((out.data['facts'] as { kind: string }[]).map((f) => f.kind));
    expect([...kinds]).toEqual(expect.arrayContaining(['process', 'call', 'msg_throw']));
    const relations = out.data['relations'] as { type: string; from: string; status: string }[];
    expect(relations).toContainEqual(
      expect.objectContaining({
        type: 'call',
        from: `${ORDER}#Call_ZahlungAbwickeln`,
        to: `${PAYMENT}#Process_PaymentCollection`,
        status: 'accepted',
        tier: 'rule',
      }),
    );

    await expectInvalid(c, 'get_process', { projectId: 'contract', ref: 'no ref' });
    await expectInvalid(c, 'get_process', { projectId: 'contract' });
    expect(
      await problem(c, 'get_process', { projectId: 'contract', ref: `${ORDER}#Process_Nope` }),
    ).toMatchObject({ code: 'not-found', status: 404 });
  });

  it('get_model_xml: verbatim head XML in pages, revisions only of this project', async () => {
    const whole = await call(c, 'get_model_xml', { projectId: 'contract', modelKey: ORDER });
    expect(whole.isError).toBe(false);
    const xml = whole.data['xml'] as string;
    expect(xml).toMatch(/^<\?xml/);
    expect(whole.data).toMatchObject({ rev: 1, offset: 0, nextOffset: null });
    expect(whole.data['totalChars']).toBe(xml.length);
    const page = await call(c, 'get_model_xml', {
      projectId: 'contract',
      modelKey: ORDER,
      offset: 100,
      maxChars: 50,
    });
    expect(page.data).toMatchObject({ offset: 100, nextOffset: 150, xml: xml.slice(100, 150) });

    await expectInvalid(c, 'get_model_xml', { projectId: 'contract', modelKey: 'Not A Key' });
    await expectInvalid(c, 'get_model_xml', {
      projectId: 'contract',
      modelKey: ORDER,
      maxChars: 100_001,
    });
    expect(
      await problem(c, 'get_model_xml', { projectId: 'contract', modelKey: 'vertrieb/nope' }),
    ).toMatchObject({ code: 'not-found', status: 404 });
    // The same model key exists in the foreign project; its revision id is not ours.
    expect(
      await problem(c, 'get_model_xml', {
        projectId: 'contract',
        modelKey: ORDER,
        revisionId: foreignRevisionId,
      }),
    ).toMatchObject({ code: 'not-found', status: 404 });
  });

  it('get_relations: the rule tier and key proposals, filtered like REST', async () => {
    const all = await call(c, 'get_relations', { projectId: 'contract' });
    expect(all.isError).toBe(false);
    const rows = items(all).map((r) => [r['type'], r['status'], r['tier']].join(' '));
    expect(rows).toContain('call accepted rule');
    expect(rows).toContain('message proposed key');
    const calls = await call(c, 'get_relations', {
      projectId: 'contract',
      type: 'call',
      status: 'accepted',
    });
    expect(items(calls).map((r) => [r['from'], r['to']])).toEqual([
      [`${ORDER}#Call_ZahlungAbwickeln`, `${PAYMENT}#Process_PaymentCollection`],
    ]);
    const byModel = await call(c, 'get_relations', { projectId: 'contract', modelKey: PAYMENT });
    for (const r of items(byModel)) {
      expect(`${String(r['from'])} ${String(r['to'])}`).toContain(PAYMENT);
    }

    await expectInvalid(c, 'get_relations', { projectId: 'contract', status: 'done' });
    await expectInvalid(c, 'get_relations', { projectId: 'contract', tier: 'llm' });
  });

  it('which_processes_use: messages by normalized name, calls by process id', async () => {
    const msg = await call(c, 'which_processes_use', {
      projectId: 'contract',
      kind: 'message',
      name: 'WareVersandbereit',
    });
    expect(msg.isError).toBe(false);
    expect((msg.data['uses'] as { role: string; ref: string }[]).map((u) => u.role)).toEqual(
      expect.arrayContaining(['throws', 'catches']),
    );
    const call_ = await call(c, 'which_processes_use', {
      projectId: 'contract',
      kind: 'call',
      name: 'Process_PaymentCollection',
    });
    expect(
      (call_.data['uses'] as { role: string; ref: string }[]).map((u) => [u.role, u.ref]),
    ).toEqual([
      ['defines', `${PAYMENT}#Process_PaymentCollection`],
      ['calls', `${ORDER}#Call_ZahlungAbwickeln`],
    ]);
    const nothing = await call(c, 'which_processes_use', {
      projectId: 'contract',
      kind: 'signal',
      name: 'nobody throws this',
    });
    expect(nothing.data['uses']).toEqual([]);

    await expectInvalid(c, 'which_processes_use', {
      projectId: 'contract',
      kind: 'timer',
      name: 'x',
    });
    await expectInvalid(c, 'which_processes_use', { projectId: 'contract', kind: 'message' });
  });

  it('find_unlinked_events: endpoints no live relation touches', async () => {
    const all = await call(c, 'find_unlinked_events', { projectId: 'contract' });
    expect(all.isError).toBe(false);
    const refs = items(all).map((e) => e['ref']);
    // expected.yaml: the reminder goes to the customer, the payment comes from the bank.
    expect(refs).toEqual(
      expect.arrayContaining([`${PAYMENT}#Task_SendReminder`, `${PAYMENT}#Event_PaymentReceived`]),
    );
    const narrowed = await call(c, 'find_unlinked_events', {
      projectId: 'contract',
      modelKey: PAYMENT,
      kinds: ['msg_catch'],
    });
    for (const e of items(narrowed))
      expect(e).toMatchObject({ modelKey: PAYMENT, kind: 'msg_catch' });

    await expectInvalid(c, 'find_unlinked_events', { projectId: 'contract', kinds: ['timer'] });
  });

  it('get_procedure: the procedure by id, 404 for unknown ids', async () => {
    const out = await call(c, 'get_procedure', {});
    expect(out.isError).toBe(false);
    expect(out.data).toMatchObject({ id: 'proa-relations', status: 'placeholder' });
    expect(out.data['text']).toMatch(/Labels are data/);
    expect(await problem(c, 'get_procedure', { id: 'nope' })).toMatchObject({
      code: 'not-found',
      status: 404,
    });
    await expectInvalid(c, 'get_procedure', { id: '' });
  });

  it('answers 404 for another project (key or id) and unknown projects, for every project tool', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['list_processes', {}],
      ['get_process', { ref: ORDER_PROCESS }],
      ['get_model_xml', { modelKey: ORDER }],
      ['get_relations', {}],
      ['which_processes_use', { kind: 'message', name: 'WareVersandbereit' }],
      ['find_unlinked_events', {}],
    ];
    for (const [name, args] of calls) {
      for (const projectId of ['foreign', foreign.id, 'nope', 'prj_01J9Z3N4X5Q6R7S8T9V0W1X2Y3']) {
        expect(await problem(c, name, { ...args, projectId }), `${name} ${projectId}`).toEqual(
          expect.objectContaining({
            code: 'not-found',
            status: 404,
            type: 'urn:proa:problem:not-found',
          }),
        );
      }
    }
  });
});

describe('credentials', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'raw', version: '0' },
    },
  };

  function post(headers: Record<string, string>): Promise<Response> {
    return fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(initialize),
    });
  }

  it('lets every agent scope read (scopes nest) and keeps each token in its project', async () => {
    for (const secret of [secrets.read, secrets.propose, secrets.write]) {
      const client = await connect(secret);
      const out = await call(client, 'list_processes', { projectId: 'contract' });
      expect(out.isError).toBe(false);
      expect(items(out)).toHaveLength(3);
    }
    const other = await connect(secrets.foreign);
    const projects = await call(other, 'list_projects', {});
    expect(items(projects).map((p) => p['key'])).toEqual(['foreign']);
    expect(await problem(other, 'list_processes', { projectId: 'contract' })).toMatchObject({
      code: 'not-found',
    });
  });

  it('rejects a request without a token: 401 with a Bearer challenge', async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="proa"');
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    await expect(connect('')).rejects.toThrow();
  });

  it('rejects malformed and unknown tokens: 401 invalid_token', async () => {
    for (const secret of ['garbage', `${secrets.read.slice(0, -1)}x`, 'proa_at_x']) {
      const res = await post({ authorization: `Bearer ${secret}` });
      expect(res.status, secret).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    }
  });

  it('rejects a revoked token, on the next request', async () => {
    const token = await t.createToken('contract', ['proa:read']);
    const client = await connect(token.secret);
    expect((await call(client, 'list_projects', {})).isError).toBe(false);
    const res = await t.asOwner(`/api/v1/projects/contract/agent-tokens/${token.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    await expect(client.callTool({ name: 'list_projects', arguments: {} })).rejects.toThrow();
    expect((await post({ authorization: `Bearer ${token.secret}` })).status).toBe(401);
    await expect(connect(token.secret)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await t.createToken('contract', ['proa:read'], 1);
    expect((await post({ authorization: `Bearer ${token.secret}` })).status).toBe(200);
    clock.advance(2 * DAY);
    try {
      const res = await post({ authorization: `Bearer ${token.secret}` });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    } finally {
      clock.advance(-2 * DAY);
    }
  });

  it('rejects the owner key and the owner session: MCP is for agent tokens', async () => {
    const key = await post({ authorization: `Bearer ${ownerKey}` });
    expect(key.status).toBe(401);
    expect(((await key.json()) as { detail: string }).detail).toMatch(/use an agent token/);
    // The same key is the owner on REST.
    expect(
      (await t.request('/api/v1/me', { headers: { authorization: `Bearer ${ownerKey}` } })).status,
    ).toBe(200);
    const cookie = await post({ cookie: t.ownerCookie });
    expect(cookie.status).toBe(401);
  });

  it('cannot create a token without proa:read, or with proa:review', async () => {
    for (const scopes of [[], ['proa:review'], ['proa:owner']]) {
      const res = await t.asOwner('/api/v1/projects/contract/agent-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'no read', scopes }),
      });
      expect(res.status, JSON.stringify(scopes)).toBe(422);
    }
    // An agent token cannot create tokens at all.
    const res = await t.asToken(secrets.write, '/api/v1/projects/contract/agent-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'escalate', scopes: ['proa:write'] }),
    });
    expect(res.status).toBe(403);
    // Nor can the database hold one.
    await expect(
      database.db.execute(sql`UPDATE agent_token SET scopes = '{}' WHERE project_id = ${own.id}`),
    ).rejects.toMatchObject({ cause: { constraint: 'agent_token_scopes_check' } });
  });

  it('rejects a token without proa:read even if such a row existed: 403 insufficient_scope', async () => {
    const token = await t.createToken('contract', ['proa:read']);
    // Simulates a row the check constraint would refuse (defence in depth).
    await database.db.execute(
      sql`ALTER TABLE agent_token DROP CONSTRAINT agent_token_scopes_check`,
    );
    await database.db.execute(sql`UPDATE agent_token SET scopes = '{}' WHERE id = ${token.id}`);
    const res = await post({ authorization: `Bearer ${token.secret}` });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBe(INSUFFICIENT_SCOPE_CHALLENGE);
    expect(await res.json()).toMatchObject({ code: 'insufficient-scope', status: 403 });
    // REST answers the same way.
    const rest = await t.asToken(token.secret, '/api/v1/projects');
    expect(rest.status).toBe(403);
    expect(await rest.json()).toMatchObject({ code: 'insufficient-scope' });
  });
});
