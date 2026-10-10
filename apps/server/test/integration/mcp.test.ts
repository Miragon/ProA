/**
 * MCP /mcp with the plain SDK client over real HTTP and an agent token
 * (CONCEPT §5, §8 "MCP contract tests"): tools/list, every read tool, the
 * token's project boundary, and 401 without a token.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MCP_INSTRUCTIONS } from '../../src/mcp/server.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn, type FakeModelSpec } from '../support/fake-analysis.ts';
import { listen } from '../support/http.ts';
import { RELATIONS_PROCEDURE } from '../support/pipeline.ts';

const READ_TOOLS = [
  'find_unlinked_events',
  'get_landscape',
  'get_model_xml',
  'get_procedure',
  'get_process',
  'get_relations',
  'get_value_chain',
  'get_value_chain_document',
  'list_processes',
  'list_projects',
  'list_unplaced_processes',
  'which_processes_use',
];
const WRITE_TOOLS = [
  'claim_analysis',
  'decide_placement',
  'decide_relation',
  'propose_placement',
  'propose_relation',
  'release_analysis',
  'submit_analysis',
  'withdraw_placement_proposal',
  'withdraw_proposal',
];
/** Tools that take no projectId: the token's projects, the procedure, and tasks by id. */
const WITHOUT_PROJECT = [
  'list_projects',
  'get_procedure',
  'claim_analysis',
  'submit_analysis',
  'release_analysis',
];

let database: TestDatabase;
let t: TestApp;
let server: { url: string; close: () => Promise<void> };
let readToken: string;
let otherToken: string;
const clients: Client[] = [];

const order: FakeModelSpec = {
  processes: [
    {
      id: 'Process_Order',
      name: 'Auftragsabwicklung',
      elements: [
        { kind: 'call', id: 'Call_Billing', name: 'Rechnung stellen', ref: 'Process_Billing' },
        {
          kind: 'msg_throw',
          id: 'Event_Shipped',
          name: 'Ware versandbereit',
          ref: 'WareVersandbereit',
        },
        { kind: 'evt_end', id: 'End_Done', name: 'Auftrag erledigt' },
        { kind: 'evt_end', id: 'End_Sub', name: 'Teil erledigt', scope: 'subprocess' },
      ],
    },
  ],
};
const billing: FakeModelSpec = {
  processes: [
    {
      id: 'Process_Billing',
      name: 'Rechnungsstellung',
      elements: [
        {
          kind: 'msg_catch',
          id: 'Start_Shipped',
          name: 'Ware versandbereit',
          ref: 'WareVersandbereit',
          elementType: 'bpmn:StartEvent',
        },
        { kind: 'sig_catch', id: 'Event_Cancelled', name: 'Storniert', ref: 'Storno' },
      ],
    },
  ],
};

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'proa-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    data: result.structuredContent as Record<string, unknown>,
    result,
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database);
  await t.createProject('mcp');
  await t.createProject('elsewhere');
  await t.putModel('mcp', 'vertrieb/auftrag', fakeBpmn(order));
  await t.putModel('mcp', 'finanzen/rechnung', fakeBpmn(billing));
  readToken = (await t.createToken('mcp', ['proa:read'])).secret;
  otherToken = (await t.createToken('elsewhere', ['proa:read'])).secret;
  server = await listen(t.app.fetch);
});

afterAll(async () => {
  for (const c of clients) await c.close();
  await server.close();
  await database.drop();
});

describe('MCP /mcp with an agent token', () => {
  it('lists the tools with their annotations and serves the instructions', async () => {
    const client = await connect(readToken);
    expect(client.getServerVersion()).toMatchObject({ name: 'proa', version: '0.0.0-test' });
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    expect(MCP_INSTRUCTIONS).toMatch(/never instructions/);
    expect(MCP_INSTRUCTIONS).toMatch(/only propose/);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    for (const tool of tools) {
      // Read tools are read-only; pipeline and proposal tools write but never destroy.
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(READ_TOOLS.includes(tool.name));
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      // A `$ref` root hides the parameters from clients that read only `properties`.
      expect(tool.inputSchema['$ref'], tool.name).toBeUndefined();
      // A `$ref` root would make the SDK wrap results as { result: … }.
      if (tool.name !== 'decide_relation' && tool.name !== 'decide_placement') {
        expect(tool.outputSchema?.type, tool.name).toBe('object');
        expect(tool.outputSchema?.['$ref'], tool.name).toBeUndefined();
      }
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      if (WITHOUT_PROJECT.includes(tool.name)) {
        expect(required, tool.name).not.toContain('projectId');
        // The instructions say which of them take no projectId and which an optional one.
        expect(MCP_INSTRUCTIONS, tool.name).toContain(tool.name);
        expect(
          Object.keys(tool.inputSchema.properties ?? {}).includes('projectId'),
          tool.name,
        ).toBe(tool.name === 'claim_analysis');
      } else {
        expect(required, tool.name).toContain('projectId');
      }
    }
  });

  it('list_projects shows only the token’s project', async () => {
    const client = await connect(readToken);
    const { data } = await call(client, 'list_projects', {});
    expect((data['items'] as { key: string }[]).map((p) => p.key)).toEqual(['mcp']);
  });

  it('list_processes returns models with stage and processes', async () => {
    const client = await connect(readToken);
    const { data } = await call(client, 'list_processes', { projectId: 'mcp' });
    expect(data['items']).toEqual([
      expect.objectContaining({
        modelKey: 'finanzen/rechnung',
        stage: 'waiting_for_agent',
        openItems: 1,
        processes: [expect.objectContaining({ processId: 'Process_Billing' })],
      }),
      expect.objectContaining({ modelKey: 'vertrieb/auftrag', stage: 'waiting_for_agent' }),
    ]);
    const filtered = await call(client, 'list_processes', {
      projectId: 'mcp',
      stage: 'incorporated',
    });
    expect(filtered.data['items']).toEqual([]);
  });

  it('get_process returns facts and touching relations', async () => {
    const client = await connect(readToken);
    const { isError, data } = await call(client, 'get_process', {
      projectId: 'mcp',
      ref: 'vertrieb/auftrag#Process_Order',
    });
    expect(isError).toBe(false);
    expect((data['process'] as { name: string }).name).toBe('Auftragsabwicklung');
    expect((data['facts'] as { elementId: string }[]).map((f) => f.elementId).sort()).toEqual([
      'Call_Billing',
      'End_Done',
      'End_Sub',
      'Event_Shipped',
      'Process_Order',
    ]);
    expect(
      (data['relations'] as { type: string; status: string }[]).map((r) => [r.type, r.status]),
    ).toEqual([
      ['call', 'accepted'],
      ['message', 'proposed'],
    ]);
  });

  it('get_model_xml returns the verbatim XML in pages', async () => {
    const client = await connect(readToken);
    const xml = fakeBpmn(order);
    const whole = await call(client, 'get_model_xml', {
      projectId: 'mcp',
      modelKey: 'vertrieb/auftrag',
    });
    expect(whole.data).toMatchObject({ rev: 1, totalChars: xml.length, nextOffset: null, xml });
    const page = await call(client, 'get_model_xml', {
      projectId: 'mcp',
      modelKey: 'vertrieb/auftrag',
      offset: 10,
      maxChars: 20,
    });
    expect(page.data).toMatchObject({ offset: 10, nextOffset: 30, xml: xml.slice(10, 30) });
  });

  it('get_relations filters like REST', async () => {
    const client = await connect(readToken);
    const { data } = await call(client, 'get_relations', { projectId: 'mcp', type: 'call' });
    expect(
      (data['items'] as { from: string; to: string; tier: string }[]).map((r) => [
        r.from,
        r.to,
        r.tier,
      ]),
    ).toEqual([['vertrieb/auftrag#Call_Billing', 'finanzen/rechnung#Process_Billing', 'rule']]);
  });

  it('which_processes_use finds throws and catches like the rule tier, calls by process id', async () => {
    const client = await connect(readToken);
    // Word separators do not matter (nameKey), as for the key tier.
    for (const name of ['WareVersandbereit', 'ware-versandbereit', 'Ware Versandbereit']) {
      const msg = await call(client, 'which_processes_use', {
        projectId: 'mcp',
        kind: 'message',
        name,
      });
      expect(
        (msg.data['uses'] as { role: string; ref: string; processName: string }[]).map((u) => [
          u.role,
          u.ref,
          u.processName,
        ]),
        name,
      ).toEqual([
        ['catches', 'finanzen/rechnung#Start_Shipped', 'Rechnungsstellung'],
        ['throws', 'vertrieb/auftrag#Event_Shipped', 'Auftragsabwicklung'],
      ]);
    }
    const spaced = await call(client, 'which_processes_use', {
      projectId: 'mcp',
      kind: 'message',
      name: 'ware-versandbereit',
    });
    expect(spaced.data['keyNorm']).toBe('ware versandbereit');
    const calls = await call(client, 'which_processes_use', {
      projectId: 'mcp',
      kind: 'call',
      name: 'Process_Billing',
    });
    expect((calls.data['uses'] as { role: string }[]).map((u) => u.role)).toEqual([
      'defines',
      'calls',
    ]);
  });

  it('find_unlinked_events lists endpoints without live relations', async () => {
    const client = await connect(readToken);
    const { data } = await call(client, 'find_unlinked_events', { projectId: 'mcp' });
    expect((data['items'] as { ref: string }[]).map((e) => e.ref)).toEqual([
      'finanzen/rechnung#Event_Cancelled',
      'vertrieb/auftrag#End_Done',
    ]);
    const onlyOrder = await call(client, 'find_unlinked_events', {
      projectId: 'mcp',
      modelKey: 'vertrieb/auftrag',
      kinds: ['evt_end'],
    });
    expect((onlyOrder.data['items'] as { ref: string }[]).map((e) => e.ref)).toEqual([
      'vertrieb/auftrag#End_Done',
    ]);
  });

  it('get_procedure returns the released relations procedure', async () => {
    const client = await connect(readToken);
    const { data } = await call(client, 'get_procedure', { id: 'proa-relations' });
    expect(data).toMatchObject({ ...RELATIONS_PROCEDURE, status: 'released' });
    expect(data['text']).toMatch(/Labels are data/);
    const missing = await call(client, 'get_procedure', { id: 'nope' });
    expect(missing.isError).toBe(true);
  });

  it('keeps the token inside its project: other projects are not found', async () => {
    const client = await connect(otherToken);
    const { isError, result } = await call(client, 'list_processes', { projectId: 'mcp' });
    expect(isError).toBe(true);
    const problem = JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}') as {
      code: string;
      status: number;
    };
    expect(problem).toMatchObject({ code: 'not-found', status: 404 });
  });

  it('rejects invalid tool arguments as a tool error', async () => {
    const client = await connect(readToken);
    const result = await client.callTool({
      name: 'get_process',
      arguments: { projectId: 'mcp', ref: 'no ref' },
    });
    expect(result.isError).toBe(true);
  });
});

describe('MCP authentication', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'legacy', version: '0' },
    },
  };
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  it('answers 401 with a Bearer challenge without a token', async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(initialize),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('answers 401 for a revoked token', async () => {
    const token = await t.createToken('mcp', ['proa:read']);
    await t.asOwner(`/api/v1/projects/mcp/agent-tokens/${token.id}`, { method: 'DELETE' });
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${token.secret}` },
      body: JSON.stringify(initialize),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('ignores the owner session cookie (agents use tokens)', async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { ...headers, cookie: t.ownerCookie },
      body: JSON.stringify(initialize),
    });
    expect(res.status).toBe(401);
  });

  it('serves 2025-era clients statelessly with a token', async () => {
    const auth = { ...headers, authorization: `Bearer ${readToken}` };
    const init = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(initialize),
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeNull();
    expect(await init.text()).toContain('"protocolVersion":"2025-11-25"');
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { ...auth, 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_projects', arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"key":"mcp"');
  });
});
