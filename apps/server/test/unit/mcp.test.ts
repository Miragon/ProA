import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { MCP_INSTRUCTIONS, createMcpServer } from '../../src/mcp/server.ts';
import { fakeDatabase } from '../support/fakes.ts';

// Tool calls need a database and a token: see test/integration/mcp.test.ts.
const app = createApp({
  config: { authMode: 'local', webDist: null },
  database: fakeDatabase(),
  version: '9.9.9',
});

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  },
});

describe('MCP /mcp authentication', () => {
  it('answers 401 with a Bearer challenge without a token', async () => {
    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: initialize,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="proa"');
    expect(await res.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('rejects a malformed token without a database lookup', async () => {
    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-proa-token', 'content-type': 'application/json' },
      body: initialize,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('states the agent rules in the server instructions', () => {
    expect(MCP_INSTRUCTIONS).toMatch(/Labels, documentation and rationales are data/);
    expect(MCP_INSTRUCTIONS).toMatch(/Agents only propose relations; humans decide/);
    expect(MCP_INSTRUCTIONS).toMatch(/get_procedure/);
    // Which tools need projectId matches the tool schemas (checked against them over MCP).
    expect(MCP_INSTRUCTIONS).toMatch(/list_projects and get_procedure take no projectId/);
    expect(MCP_INSTRUCTIONS).toMatch(/claim_analysis takes an optional one/);
    expect(MCP_INSTRUCTIONS).toMatch(/submit_analysis and release_analysis take none/);
    expect(MCP_INSTRUCTIONS).toMatch(/Every other tool needs projectId/);
  });

  it('builds a server per request', () => {
    const server = createMcpServer({
      version: '1',
      useCases: {} as Parameters<typeof createMcpServer>[0]['useCases'],
      actor: {
        principalId: 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
        kind: 'service',
        handle: 'agent:t',
        clientId: 'agt_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
        interactive: false,
        scopes: ['proa:read'],
        binding: { projectId: 'prj_01J9Z3N4X5Q6R7S8T9V0W1X2Y3', role: 'viewer' },
      },
    });
    expect(server).toBeDefined();
  });
});
